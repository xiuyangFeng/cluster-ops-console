// npm run release:promote（scripts/release-promote.mjs）：把稳定版推进到一个已经在 main 上的提交。
//
// 用真实的 git 在 os.tmpdir() 里搭「远端（裸仓库）+ 发布方的仓库」，把核对、各种不推的情况、--dry-run、确认与推送
// 都走一遍。远端始终是临时目录里的本地裸仓库：这里的 fetch / push 碰不到真实的 origin。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { CHANNEL_AWARE_FILE } from "../work/monitor/lib/self-update/channel.mjs";
import { createGit } from "../work/monitor/lib/self-update/git.mjs";
import { headingsToDeliver, parseChangelogHeadings, planPromotion, runPromoteCli } from "./release-promote.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "用法: npm run release:promote [-- <提交|标签>] [--dry-run]\n  不带参数推进到 origin/main 现在的位置；没有跳过确认或强制推送的开关。";

// 不读这台机器上的 git 配置：全局配置指到一个空文件（不能用 os.devNull，Windows 上 git 读不了 \\.\nul）。
const EMPTY_GIT_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "release-promote-gitconfig-")), "gitconfig");
fs.writeFileSync(EMPTY_GIT_CONFIG, "");
after(() => fs.rmSync(path.dirname(EMPTY_GIT_CONFIG), { recursive: true, force: true }));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};
const sh = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lockOf = (version, electron = "44.4.5") => `${JSON.stringify({ name: "app", version, lockfileVersion: 3, packages: { "": { name: "app", version, devDependencies: { electron } }, "node_modules/electron": { version: electron } } }, null, 2)}\n`;

// → 远端（裸仓库，main 上已有 v1.0.0）+ 发布方的仓库。
//   publish(version, { changes, push, changelog })：提交一个版本（CHANGELOG.md 顶部加一节），默认推到远端的 main。
//   run(argv, { answer, interactive })：跑一次命令行；记下问了几次、发出了哪些 git 命令。
//   channelAware：提交里带不带 channel.mjs（认识更新通道的版本才有它，见 CHANNEL_AWARE_FILE）；setAware 中途改。
function setup(t, { channelAware = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "release-promote-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const remote = path.join(base, "remote.git");
  const pub = path.join(base, "publisher");
  fs.mkdirSync(remote);
  sh(remote, "init", "-q", "--bare", "-b", "main");
  sh(base, "clone", "-q", remote, pub);
  sh(pub, "checkout", "-q", "-b", "main");
  let day = 0;
  let aware = channelAware;
  const publish = (version, { changes = {}, push = true, changelog = true } = {}) => {
    day += 1;
    if (aware) {
      fs.mkdirSync(path.dirname(path.join(pub, CHANNEL_AWARE_FILE)), { recursive: true });
      fs.writeFileSync(path.join(pub, CHANNEL_AWARE_FILE), "// 夹具：认识更新通道的版本\n");
    }
    fs.writeFileSync(path.join(pub, "package.json"), `${JSON.stringify({ name: "app", version }, null, 2)}\n`);
    fs.writeFileSync(path.join(pub, "package-lock.json"), lockOf(version));
    const logFile = path.join(pub, "CHANGELOG.md");
    const previous = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").replace(/^# 版本更新记录\n\n/, "") : "";
    if (changelog) fs.writeFileSync(logFile, `# 版本更新记录\n\n### v${version} · 2026-10-${String(day).padStart(2, "0")}\n\n这一版做了什么。\n\n${previous}`);
    for (const [name, text] of Object.entries(changes)) fs.writeFileSync(path.join(pub, name), text);
    sh(pub, "add", "-A");
    sh(pub, "commit", "-q", "-m", `v${version}`);
    if (push) sh(pub, "push", "-q", "origin", "main");
    return sh(pub, "rev-parse", "HEAD");
  };
  const first = publish("1.0.0");
  const calls = [];
  const real = createGit({ root: pub, env: GIT_ENV });
  const ctx = { base, remote, pub, publish, first, calls, beforePush: null, setAware: (value) => { aware = value; } };
  ctx.git = async (args, opts) => {
    calls.push(args);
    if (args[0] === "push" && ctx.beforePush) ctx.beforePush();
    return real(args, opts);
  };
  ctx.run = async (argv, { answer = null, interactive = true } = {}) => {
    const lines = [];
    const asked = [];
    calls.length = 0;
    const ask = async (question) => {
      asked.push(question);
      if (answer === null) throw new Error("不该问到这里");
      return answer;
    };
    const code = await runPromoteCli(argv, { git: ctx.git, ask, interactive, log: (line) => lines.push(line) });
    return { code, text: lines.join("\n"), asked, pushes: calls.filter((args) => args[0] === "push") };
  };
  return ctx;
}

// 远端此刻的全部引用（分支与标签）：没推的各种情况下前后必须一字不差。
const remoteRefs = (ctx) => sh(ctx.remote, "for-each-ref", "--format=%(refname) %(objectname)");
const remoteStable = (ctx) => sh(ctx.remote, "rev-parse", "refs/heads/stable");
const short = (sha) => sha.slice(0, 7);
// 直接把远端的 stable 放到某个提交上（模拟以前推进过的状态）；与被测脚本无关。
const seedStable = (ctx, sha) => sh(ctx.pub, "push", "-q", "origin", `${sha}:refs/heads/stable`);

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("CHANGELOG 小节标题：两种写法都认；同事会收到的是高于稳定版、不超过目标的那些", () => {
  const text = [
    "# 版本更新记录 (Changelog)", "", "项目采用语义化版本管理。", "",
    "### v2.62.1 · 2026-10-14", "", "修了一处。", "- **界面**：### v9.9.9 不是标题", "",
    "### v2.62.0 · 2026-10-13", "",
    "### v2.61.1 · 2026-10-12", "",
    "### v2.20.0 (2026-09-01) — M3「日常使用效率」批次（T17–T22）", "",
    "### v2.19.0 (2026-08-30)", "",
    "#### v1.0.0 不是三级标题", "### 没有版本号的标题",
  ].join("\n");
  const headings = parseChangelogHeadings(text);
  assert.deepEqual(headings, [
    { version: "2.62.1", title: "v2.62.1 · 2026-10-14" },
    { version: "2.62.0", title: "v2.62.0 · 2026-10-13" },
    { version: "2.61.1", title: "v2.61.1 · 2026-10-12" },
    { version: "2.20.0", title: "v2.20.0 (2026-09-01) — M3「日常使用效率」批次（T17–T22）" },
    { version: "2.19.0", title: "v2.19.0 (2026-08-30)" },
  ]);
  assert.deepEqual(parseChangelogHeadings("### v2.62.1 · 2026-10-14\r\n\r\n### v2.62.0 · 2026-10-13\r\n").map((h) => h.version), ["2.62.1", "2.62.0"], "CRLF 的文件也认");
  assert.deepEqual(parseChangelogHeadings(undefined), []);

  assert.deepEqual(headingsToDeliver(headings, "2.61.1", "2.62.1").map((h) => h.version), ["2.62.1", "2.62.0"]);
  assert.deepEqual(headingsToDeliver(headings, "2.61.1", "2.62.0").map((h) => h.version), ["2.62.0"], "目标之后的版本不算");
  assert.deepEqual(headingsToDeliver(headings, "2.19.0", "2.61.1").map((h) => h.version), ["2.61.1", "2.20.0"]);
  assert.deepEqual(headingsToDeliver(headings, "", "2.62.0").map((h) => h.version), ["2.62.0"], "第一次创建稳定版：只有目标那一版");
  assert.deepEqual(headingsToDeliver(headings, "2.62.1", "2.63.0"), [], "CHANGELOG 里还没有这一版");
  assert.deepEqual(headingsToDeliver(null, "1.0.0", "2.0.0"), []);

  // 仓库里真的那份 CHANGELOG.md：每一节都读得出版本号，第一节就是 package.json 现在的版本。
  const real = parseChangelogHeadings(fs.readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"));
  assert.ok(real.length > 90, `只读出 ${real.length} 节`);
  assert.equal(real[0].version, JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version);
  assert.equal(new Set(real.map((h) => h.version)).size, real.length, "没有重复的版本");
});

test("用法不对 → 2，一条 git 都不发：没有强制推送、跳过确认的开关，也不收奇怪的提交名", async () => {
  const lines = [];
  let touched = 0;
  const deps = { git: async () => { touched += 1; return { ok: false, code: 1, stdout: "", stderr: "" }; }, ask: async () => { touched += 1; return "y"; }, interactive: true, log: (line) => lines.push(line) };
  for (const argv of [["--force"], ["-f"], ["--yes"], ["-y"], ["--force-with-lease"], ["v1.0.0", "v1.1.0"], ["--dry-run", "--dry-run"], ["--dry-run", "--force"], ["bad rev"], ["+main"], ["a;b"], ["x".repeat(201)], [""]]) {
    lines.length = 0;
    assert.equal(await runPromoteCli(argv, deps), 2, JSON.stringify(argv));
    assert.equal(lines.join("\n"), USAGE, JSON.stringify(argv));
  }
  assert.equal(touched, 0);
});

// ---------------------------------------------------------------------------
// 真实 git：创建、推进
// ---------------------------------------------------------------------------

test("第一次推进（远端还没有 stable）：--dry-run 不动远端；不确认不推；确认后创建，推的就是那个提交", async (t) => {
  const ctx = setup(t);
  const tip = ctx.publish("1.1.0");
  const before = remoteRefs(ctx);
  assert.doesNotMatch(before, /refs\/heads\/stable/);

  let res = await ctx.run(["--dry-run"]);
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /^→ 取远端的 main 与 stable（只读）…$/m);
  assert.match(res.text, /^创建稳定版（stable）：v1\.1\.0$/m);
  assert.ok(res.text.includes(`  提交：${short(tip)}（远端还没有 stable 分支，这一次创建它）`), res.text);
  assert.match(res.text, /^之后新装的同事默认装这一版：\n {2}v1\.1\.0 · 2026-10-02$/m);
  assert.doesNotMatch(res.text, /v1\.0\.0 · /, "第一次创建只列目标那一版");
  assert.match(res.text, /已经装好的同事仍在开发版（main）上，不会自己换过来；想换的人各自执行 npm run update -- --channel stable。/);
  assert.match(res.text, /^（--dry-run：核对通过，没有推送。去掉 --dry-run 再运行一次才会推。）$/m);
  assert.deepEqual([res.asked, res.pushes, remoteRefs(ctx)], [[], [], before], "--dry-run 不问、不推、远端一字不差");

  // 不确认（直接回车 / 答 n / 答别的）不推。
  for (const answer of ["", "n", "N", "no", "yes please", " "]) {
    res = await ctx.run([], { answer });
    assert.equal(res.code, 1, JSON.stringify(answer));
    assert.deepEqual(res.asked, ["确认推送？稳定版只往前走，推过去之后撤不回来。(y/N): "]);
    assert.match(res.text, /^没有推送。$/m);
    assert.deepEqual([res.pushes, remoteRefs(ctx)], [[], before], JSON.stringify(answer));
  }
  // 标准输入不是终端（被脚本调用、管道）：不问，也不推。
  res = await ctx.run([], { interactive: false });
  assert.equal(res.code, 1);
  assert.match(res.text, /^✗ 需要有人在终端里确认，这里的标准输入不是终端：没有推送。$/m);
  assert.deepEqual([res.asked, res.pushes, remoteRefs(ctx)], [[], [], before]);

  res = await ctx.run([], { answer: "y" });
  assert.equal(res.code, 0, res.text);
  assert.equal(remoteStable(ctx), tip);
  assert.ok(res.text.includes(`✓ 稳定版已创建：v1.1.0（${short(tip)}）。`), res.text);
  assert.doesNotMatch(res.text, /没能回读确认/);
  // 推送只有这一条，写明提交号、不强制。
  assert.deepEqual(res.pushes, [["push", "--no-follow-tags", "origin", `${tip}:refs/heads/stable`]]);
  assert.equal(sh(ctx.remote, "rev-parse", "refs/heads/main"), tip, "main 没动");
});

test("推进：只快进；列出同事会收到的版本区间；已经在那个提交上就不用推；可以指定标签 / 提交，本机没推过的标签不跟着出去", async (t) => {
  const ctx = setup(t);
  seedStable(ctx, ctx.first);
  ctx.publish("1.1.0");
  const v12 = ctx.publish("1.2.0");

  let res = await ctx.run([], { answer: "Y" });
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /^推进稳定版（stable）：v1\.0\.0 → v1\.2\.0$/m);
  assert.ok(res.text.includes(`  提交：${short(ctx.first)} → ${short(v12)}（快进 2 个提交）`), res.text);
  assert.match(res.text, /^跟稳定版的同事会收到（最迟半小时后提示，点了才更新）：\n {2}v1\.2\.0 · 2026-10-03\n {2}v1\.1\.0 · 2026-10-02$/m);
  assert.doesNotMatch(res.text, /v1\.0\.0 · |注意：/, "稳定版已有的那一版不列；没有要提醒的事就不说");
  assert.ok(res.text.includes(`✓ 稳定版已推进：v1.2.0（${short(v12)}）。`), res.text);
  assert.deepEqual(res.pushes, [["push", "--no-follow-tags", "origin", `${v12}:refs/heads/stable`]]);
  assert.equal(remoteStable(ctx), v12);

  // 再跑一次：已经在那个提交上，不问不推。
  res = await ctx.run([]);
  assert.equal(res.code, 0);
  assert.ok(res.text.includes(`✓ 稳定版已经在 ${short(v12)}（v1.2.0）上，不用推进。`), res.text);
  assert.deepEqual([res.asked, res.pushes], [[], []]);

  // 指定标签：推进到 v1.3.0，main 上更新的 v1.4.0 不带上；即使这台电脑配了 push.followTags，标签也不跟着推出去。
  const v13 = ctx.publish("1.3.0");
  const v14 = ctx.publish("1.4.0");
  sh(ctx.pub, "tag", "-a", "v1.3.0", "-m", "v1.3.0", v13);
  sh(ctx.pub, "config", "push.followTags", "true");
  res = await ctx.run(["--", "v1.3.0"], { answer: "y" });
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /^推进稳定版（stable）：v1\.2\.0 → v1\.3\.0$/m);
  assert.match(res.text, /^ {2}v1\.3\.0 · 2026-10-04$/m);
  assert.doesNotMatch(res.text, /v1\.4\.0/);
  assert.match(res.text, /^注意：origin\/main 上在这个提交之后还有 1 个提交，不在这次推进里。$/m);
  assert.equal(remoteStable(ctx), v13);
  assert.equal(sh(ctx.remote, "for-each-ref", "refs/tags"), "", "标签没有被推到远端");

  // 指定提交号（--dry-run 可以和它一起用）。
  const before = remoteRefs(ctx);
  res = await ctx.run([v14, "--dry-run"]);
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /^推进稳定版（stable）：v1\.3\.0 → v1\.4\.0$/m);
  assert.deepEqual([res.pushes, remoteRefs(ctx)], [[], before]);
  res = await ctx.run([v14.slice(0, 10)], { answer: "y" });
  assert.equal(res.code, 0, res.text);
  assert.equal(remoteStable(ctx), v14);
});

test("核对用的是远端此刻的位置，不是本机记着的旧引用；这段区间改了依赖 / CHANGELOG 里没有对应小节时如实说", async (t) => {
  const ctx = setup(t);
  seedStable(ctx, ctx.first);
  const v11 = ctx.publish("1.1.0");
  // 另一台电脑上推进过稳定版（到 v1.1.0）：这台本机记着的 origin/stable 还停在 v1.0.0。
  const elsewhere = path.join(ctx.base, "elsewhere");
  sh(ctx.base, "clone", "-q", ctx.remote, elsewhere);
  sh(elsewhere, "push", "-q", "origin", `${v11}:refs/heads/stable`);
  assert.equal(sh(ctx.pub, "rev-parse", "refs/remotes/origin/stable"), ctx.first);
  const v12 = ctx.publish("1.2.0", { changes: { "package-lock.json": lockOf("1.2.0", "45.0.0") }, changelog: false });

  const res = await ctx.run(["--dry-run"]);
  assert.equal(res.code, 0, res.text);
  assert.match(res.text, /^推进稳定版（stable）：v1\.1\.0 → v1\.2\.0$/m);
  assert.ok(res.text.includes(`  提交：${short(v11)} → ${short(v12)}（快进 1 个提交）`), res.text);
  assert.ok(res.text.includes(`  （${short(v12)} 的 CHANGELOG.md 里没有对应的小节：v1.2.0）`), res.text);
  assert.match(res.text, /^注意：这段区间改了依赖（package-lock\.json）。同事那边不会一键更新，会提示在终端里更新——提前说一声。$/m);
  assert.equal(sh(ctx.pub, "rev-parse", "refs/remotes/origin/stable"), v11, "取远端只更新了本机记着的引用");
});

// ---------------------------------------------------------------------------
// 真实 git：不推的各种情况
// ---------------------------------------------------------------------------

test("不推的情况：不在 origin/main 上 / 比稳定版旧 / 不是稳定版的后代 / 版本号没更高 / 找不到提交 / 读不到版本号——远端都一字不差", async (t) => {
  const ctx = setup(t);
  ctx.publish("1.1.0");
  const v12 = ctx.publish("1.2.0");
  seedStable(ctx, v12);
  const refused = async (argv, pattern, setupRemote = null) => {
    setupRemote?.();
    const before = remoteRefs(ctx);
    // answer 为 null：问到确认那一步就抛错——这些情况都不该走到那里。
    const res = await ctx.run(argv);
    assert.equal(res.code, 1, res.text);
    assert.match(res.text, pattern);
    assert.match(res.text, /^ {2}没有推送。$/m);
    assert.deepEqual([res.asked, res.pushes, remoteRefs(ctx)], [[], [], before], String(pattern));
    return res;
  };

  // 本机提交了、还没推到 main 的版本。
  const local = ctx.publish("1.3.0", { push: false });
  await refused(["HEAD"], new RegExp(`^✗ ${short(local)} 还不在 origin/main 上：稳定版只从已经推到 main 的提交里选。先 git push origin main$`, "m"));
  await refused([local], /还不在 origin\/main 上/);
  // 不带参数时目标是 origin/main（v1.2.0），正是稳定版现在的位置——本机没推的 v1.3.0 不会被带上。
  let res = await ctx.run([]);
  assert.equal(res.code, 0);
  assert.match(res.text, /稳定版已经在 .*（v1\.2\.0）上，不用推进/);
  sh(ctx.pub, "reset", "-q", "--hard", "origin/main");

  // 比稳定版现在的位置旧：不回退。
  await refused([ctx.first], new RegExp(`^✗ ${short(ctx.first)}（v1\\.0\\.0）比稳定版现在的位置旧：稳定版只往前推，不回退。要撤回一个稳定版，在 main 上发一个修正版再推进$`, "m"));

  // main 上多了一个没改版本号的提交：推过去同事那边不会有任何提示。
  const docs = ctx.publish("1.2.0", { changes: { "docs.txt": "docs only\n" }, changelog: false });
  await refused([], new RegExp(`^✗ 版本号没有比稳定版高（稳定版 v1\\.2\\.0，${short(docs)} 是 v1\\.2\\.0）：同事那边只看版本号，推过去不会提示任何人。先在 main 上发一个版本号更高的版本$`, "m"));

  // 版本号读不懂的提交。
  const odd = ctx.publish("1.3.0", { changes: { "package.json": `${JSON.stringify({ name: "app", version: "banana" })}\n` } });
  await refused([], new RegExp(`^✗ 读不到 ${short(odd)} 的版本号（它的 package\\.json 里没有合法的 version）$`, "m"));
  await refused(["nope"], /^✗ 找不到 nope 这个提交或标签（标签要先在这台电脑上打好）$/m);
  const v14 = ctx.publish("1.4.0");

  // 稳定版被放到了一个不在 main 这条线上的提交（有人手动推过）：推进不是快进，不推。
  sh(ctx.pub, "checkout", "-q", "-b", "side", v12);
  fs.writeFileSync(path.join(ctx.pub, "side.txt"), "side\n");
  sh(ctx.pub, "add", "-A");
  sh(ctx.pub, "commit", "-q", "-m", "side");
  const side = sh(ctx.pub, "rev-parse", "HEAD");
  sh(ctx.pub, "checkout", "-q", "main");
  res = await refused([], new RegExp(`^✗ ${short(v14)} 不是稳定版现在位置（${short(side)}）的后代，推过去不是快进：稳定版不分叉$`, "m"), () => seedStable(ctx, side));
  assert.equal(remoteStable(ctx), side);
});

test("不推的情况：目标早于更新通道（v2.62）——稳定版指过去之后，跟稳定版的安装跑着那一版就再也收不到更新", async (t) => {
  const ctx = setup(t, { channelAware: false }); // v1.0.0、v1.1.0 里还没有 channel.mjs
  const v11 = ctx.publish("1.1.0");
  ctx.setAware(true);
  const v12 = ctx.publish("1.2.0"); // 从 v1.2.0 起认识更新通道
  const before = remoteRefs(ctx);

  // 第一次创建 stable，想让它从「上一个稳妥的版本」开始：不行。
  let res = await ctx.run([v11]);
  assert.equal(res.code, 1, res.text);
  assert.match(res.text, new RegExp(`^✗ ${short(v11)}（v1\\.1\\.0）早于更新通道（v2\\.62）：那个版本的工作台只认 main 分支，稳定版指到它上面之后，跟稳定版的安装就再也收不到更新。选一个 v2\\.62\\.0 或更新的提交$`, "m"));
  assert.deepEqual([res.asked, res.pushes, remoteRefs(ctx)], [[], [], before]);
  assert.equal((await planPromotion({ git: ctx.git, rev: ctx.first })).code, "too-old");

  res = await ctx.run([], { answer: "y" });
  assert.equal(res.code, 0, res.text);
  assert.equal(remoteStable(ctx), v12);
});

test("不推的情况：取不到远端（不拿本机记着的旧位置核对）/ 没有 origin", async (t) => {
  const ctx = setup(t);
  seedStable(ctx, ctx.first);
  ctx.publish("1.1.0");
  assert.equal((await ctx.run(["--dry-run"])).code, 0, "先确认这套夹具本来是能推进的");

  fs.renameSync(ctx.remote, `${ctx.remote}.gone`);
  let res = await ctx.run([]);
  assert.equal(res.code, 1);
  assert.match(res.text, /^✗ 没能取到远端的 main：访问不到这个仓库，或没有它的权限：确认远端地址，以及登录的是发布方的 GitHub 账号$/m);
  assert.deepEqual([res.asked, res.pushes], [[], []]);
  fs.renameSync(`${ctx.remote}.gone`, ctx.remote);

  // main 取到了、stable 这一次没取到（不是「远端没有这条分支」）：同样不往下走。
  const real = ctx.git;
  ctx.git = async (args, opts) => (args[0] === "fetch" && args.at(-1).includes("refs/heads/stable")
    ? { ok: false, code: 128, stdout: "", stderr: "fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid", timedOut: false }
    : real(args, opts));
  res = await ctx.run([]);
  assert.equal(res.code, 1);
  assert.match(res.text, /^✗ 没能取到远端的 stable：连不上远端（超时或网络不通），检查网络或代理后再运行一次$/m);
  assert.deepEqual([res.asked, res.pushes], [[], []]);
  ctx.git = real;

  sh(ctx.pub, "remote", "remove", "origin");
  res = await ctx.run([]);
  assert.equal(res.code, 1);
  assert.match(res.text, /^✗ 这个目录不是带 origin 远端的 git 仓库，不知道往哪里推$/m);
  assert.deepEqual([res.asked, res.pushes], [[], []]);
});

test("永不强推：核对之后远端的 stable 被别人动过 → 这次推送不再是快进，远端拒绝，原样留着别人的位置", async (t) => {
  const ctx = setup(t);
  seedStable(ctx, ctx.first);
  const tip = ctx.publish("1.1.0");
  // 另一台电脑在我们核对完、推送之前，把稳定版放到了一个不在我们这条线上的提交。
  const elsewhere = path.join(ctx.base, "elsewhere");
  sh(ctx.base, "clone", "-q", ctx.remote, elsewhere);
  fs.writeFileSync(path.join(elsewhere, "other.txt"), "other\n");
  sh(elsewhere, "add", "-A");
  sh(elsewhere, "commit", "-q", "-m", "someone else");
  const theirs = sh(elsewhere, "rev-parse", "HEAD");
  ctx.beforePush = () => sh(elsewhere, "push", "-q", "origin", `${theirs}:refs/heads/stable`);

  const res = await ctx.run([], { answer: "y" });
  assert.equal(res.code, 1, res.text);
  assert.deepEqual(res.pushes, [["push", "--no-follow-tags", "origin", `${tip}:refs/heads/stable`]]);
  assert.match(res.text, /^✗ 没有推送成功：远端的 stable 在核对之后被动过，这次推送不再是快进，远端没有接受。重新运行一次，按最新的情况核对$/m);
  assert.doesNotMatch(res.text, /稳定版已推进/);
  assert.equal(remoteStable(ctx), theirs, "别人的位置没有被覆盖");

  // 源码里推送只有这一处，形状固定：不带 --force / -f / --force-with-lease，引用规格前面不带 +。
  const code = fs.readFileSync(path.join(rootDir, "scripts", "release-promote.mjs"), "utf8").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  assert.equal(code.match(/"push"/g)?.length, 1);
  assert.match(code, /pushed = await git\(\["push", "--no-follow-tags", UPDATE_REMOTE, `\$\{plan\.target\}:refs\/heads\/\$\{STABLE_BRANCH\}`\], \{ timeoutMs: PUSH_TIMEOUT_MS \}\)/, "推送那一行的写法变了，这里的断言要跟着核对一遍");
  assert.doesNotMatch(code, /--force|force-with-lease|"-f"|--mirror|--delete|`\+\$\{/);
});

test("planPromotion：只读——核对的结论里带着要推的提交、两边的版本与区间；不发 push", async (t) => {
  const ctx = setup(t);
  seedStable(ctx, ctx.first);
  ctx.publish("1.1.0");
  const tip = ctx.publish("1.2.0");
  const before = remoteRefs(ctx);
  ctx.calls.length = 0;
  const plan = await planPromotion({ git: ctx.git });
  assert.deepEqual(
    { ok: plan.ok, upToDate: plan.upToDate, create: plan.create, target: plan.target, targetVersion: plan.targetVersion, stable: plan.stable, stableVersion: plan.stableVersion, commits: plan.commits, aheadOnMain: plan.aheadOnMain, depsChanged: plan.depsChanged, versions: plan.headings.map((h) => h.version) },
    { ok: true, upToDate: false, create: false, target: tip, targetVersion: "1.2.0", stable: ctx.first, stableVersion: "1.0.0", commits: 2, aheadOnMain: 0, depsChanged: false, versions: ["1.2.0", "1.1.0"] },
  );
  assert.match(plan.remote.replaceAll("\\", "/"), /\/remote\.git$/);
  assert.equal(ctx.calls.some((args) => args[0] === "push"), false);
  assert.deepEqual(ctx.calls.filter((args) => args[0] === "fetch").map((args) => args.at(-1)), ["+refs/heads/main:refs/remotes/origin/main", "+refs/heads/stable:refs/remotes/origin/stable"]);
  assert.equal(remoteRefs(ctx), before);
  assert.deepEqual(await planPromotion({ git: ctx.git, rev: "nope" }), { ok: false, code: "bad-rev", message: "找不到 nope 这个提交或标签（标签要先在这台电脑上打好）" });
});
