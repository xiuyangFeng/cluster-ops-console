// 自更新服务：用真实的 git 在临时目录里搭「远端（裸仓库）+ 发布方 + 同事的安装目录」，
// 把检查、各种不给更新的情况、自检失败、快进合并、回退、重启后的守护进程交接都走一遍。
// 全部在 os.tmpdir() 下，不联网、不碰真实配置；自检用注入的假实现（真实的在 smoke.test.mjs）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { CHANNEL_AWARE_FILE } from "./channel.mjs";
import { classifyFetchFailure, createGit, describeGitFailure, gitEnv, redactUrlCredentials, sanitizeRemoteUrl } from "./git.mjs";
import { LAUNCHER_NODE_ENV, RESPAWN_ENV } from "./restart-code.mjs";
import { CHECK_INTERVAL_MS, createSelfUpdateService, inspectInstall, lockNeedsInstall, MARKER_FILE, planUpdate, RESUME_WINDOW_MS } from "./service.mjs";

// 不读这台机器上的 git 配置（别人的 autocrlf / 默认分支 / 签名设置会让结果不一样）：全局配置指到一个空文件。
// 不能用 os.devNull——Windows 上它是 \\.\nul，git 读不了（"unable to access"，CI 的 Windows job 红过）。
const EMPTY_GIT_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "self-update-gitconfig-")), "gitconfig");
fs.writeFileSync(EMPTY_GIT_CONFIG, "");
after(() => fs.rmSync(path.dirname(EMPTY_GIT_CONFIG), { recursive: true, force: true }));
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
};
const sh = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", "-c", "protocol.file.allow=always", ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const pkgVersion = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;

const lockOf = (version, electron = "44.4.5") => `${JSON.stringify({ name: "app", version, lockfileVersion: 3, packages: { "": { name: "app", version, devDependencies: { electron } }, "node_modules/electron": { version: electron } } }, null, 2)}\n`;

// 发布方提交一个版本并推到远端。changes：{ 文件名: 内容 }。锁文件里根包的版本号跟着一起变（真实发版就是这样）。
function publish(pub, version, changes = {}) {
  writeJson(path.join(pub, "package.json"), { name: "app", version });
  fs.writeFileSync(path.join(pub, "package-lock.json"), lockOf(version));
  for (const [name, text] of Object.entries(changes)) {
    fs.mkdirSync(path.dirname(path.join(pub, name)), { recursive: true });
    fs.writeFileSync(path.join(pub, name), text);
  }
  sh(pub, "add", "-A");
  sh(pub, "commit", "-q", "-m", `v${version}`);
  sh(pub, "push", "-q", "origin", "main");
  return sh(pub, "rev-parse", "HEAD");
}

// → { base, remote, pub, install, runtimeDir, make(extra) }：安装目录停在 v1.0.0，远端也是 v1.0.0。
// files：第一版里另外带上的文件（默认没有）。
function setup(t, { files = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "self-update-test-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 }));
  const remote = path.join(base, "remote.git");
  const pub = path.join(base, "publisher");
  const install = path.join(base, "install");
  fs.mkdirSync(remote);
  sh(remote, "init", "-q", "--bare", "-b", "main");
  sh(base, "clone", "-q", remote, pub);
  sh(pub, "checkout", "-q", "-b", "main");
  publish(pub, "1.0.0", { "app.txt": "one\n", ...files });
  sh(base, "clone", "-q", remote, install);
  const runtimeDir = path.join(base, "runtime");
  const logs = [];
  const smokes = [];
  const make = (extra = {}) => createSelfUpdateService({
    rootDir: install,
    runtimeDir,
    git: createGit({ root: install, env: GIT_ENV }),
    smoke: async (tree) => {
      smokes.push({ tree, version: pkgVersion(tree) });
      return { ok: true };
    },
    log: (text) => logs.push(text),
    env: {},
    ...extra,
  });
  return { base, remote, pub, install, runtimeDir, make, logs, smokes };
}

const marker = (ctx) => JSON.parse(fs.readFileSync(path.join(ctx.runtimeDir, MARKER_FILE), "utf8"));

// 假定时器 + 假时钟：只把服务登记的回调记下来，tick() 把时钟拨过一个检查间隔、手动跑一轮定时检查。
// 用法：ctx.make({ timers, now: timers.now })。
function fakeTimers() {
  const callbacks = [];
  let clock = Date.now();
  const add = (fn) => { callbacks.push(fn); return {}; };
  return {
    setTimeout: add, setInterval: add, clearTimeout: () => {}, clearInterval: () => {},
    now: () => clock,
    tick: () => { clock += CHECK_INTERVAL_MS; callbacks.at(-1)(); },
  };
}

// 定时回调不返回 promise：等这一轮检查做完再读结论（status 自己不会重新检查，读到的就是那一轮的结果）。
async function settled(service) {
  for (;;) {
    const st = await service.status();
    if (!st.checking) return st;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// git.mjs
// ---------------------------------------------------------------------------

test("git 环境：不交互；地址里的凭证不外露；代理只接受 http(s)://主机:端口", async () => {
  const env = gitEnv({ PATH: "/bin" });
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.match(env.GIT_SSH_COMMAND, /BatchMode=yes/);
  assert.equal(gitEnv({ GIT_SSH_COMMAND: "ssh -i k" }).GIT_SSH_COMMAND, "ssh -i k", "用户自己配的不覆盖");

  assert.equal(sanitizeRemoteUrl("https://alice:ghp_secret@github.com/o/r.git\n"), "https://github.com/o/r.git");
  assert.equal(sanitizeRemoteUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(redactUrlCredentials("fatal: unable to access 'https://u:tok@github.com/o/r.git/': boom"), "fatal: unable to access 'https://github.com/o/r.git/': boom");

  const seen = [];
  const git = createGit({ root: "/r", exec: async (_cmd, args) => { seen.push(args); return { code: 0, stdout: "", stderr: "" }; } });
  await git(["fetch"], { proxy: "http://127.0.0.1:7890" });
  await git(["fetch"], { proxy: "http://127.0.0.1:7890 -c core.sshCommand=evil" });
  await git(["fetch"], { proxy: "socks5://127.0.0.1:1080" });
  const fixed = ["-C", "/r", "-c", "core.quotepath=off", "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"];
  assert.deepEqual(seen[0], [...fixed, "-c", "http.proxy=http://127.0.0.1:7890", "fetch"]);
  assert.deepEqual(seen[1], [...fixed, "fetch"], "带空格的怪值不拼进命令");
  assert.deepEqual(seen[2], [...fixed, "fetch"]);
  const failed = await createGit({ root: "/r", exec: async () => { throw new Error("spawn git ENOENT"); } })(["status"]);
  assert.equal(failed.ok, false);

  // exec 的超时杀掉了 git、却因为子进程还拿着输出管道迟迟不返回：到点照样按超时回来，不把后面的检查堵住。
  const stuck = createGit({ root: "/r", exec: () => new Promise(() => {}), graceMs: 20 });
  const started = Date.now();
  const res = await stuck(["fetch"], { timeoutMs: 30 });
  assert.deepEqual([res.ok, res.timedOut], [false, true]);
  assert.ok(Date.now() - started < 2000);
  assert.equal(classifyFetchFailure(res).code, "timeout");
});

test("fetch 失败归因：超时 / 凭证 / 没权限 / 连不上；说明里不带凭证", () => {
  assert.equal(classifyFetchFailure({ timedOut: true }).code, "timeout");
  assert.equal(classifyFetchFailure({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" }).code, "auth");
  assert.equal(classifyFetchFailure({ stderr: "git@github.com: Permission denied (publickey)." }).code, "auth");
  assert.equal(classifyFetchFailure({ stderr: "remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found" }).code, "no-access");
  assert.equal(classifyFetchFailure({ stderr: "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403" }).code, "no-access");
  assert.equal(classifyFetchFailure({ stderr: "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com" }).code, "offline");
  const other = classifyFetchFailure({ code: 128, stderr: "fatal: weird https://u:tok@h/x" });
  assert.equal(other.code, "fetch-failed");
  assert.ok(!other.message.includes("tok"), other.message);
  // 认不出的失败：说 git 的那句原因，不是它结尾的套话。
  const ssh = classifyFetchFailure({ code: 128, stderr: "kex_exchange_identification: read: Broken pipe\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n" });
  assert.deepEqual(ssh, { code: "fetch-failed", message: "检查更新失败：fatal: Could not read from remote repository." });
  assert.equal(classifyFetchFailure({ code: 3, stderr: "" }).message, "检查更新失败：git 退出码 3");
});

test("describeGitFailure：取第一条 error: / fatal:，不取结尾的套话；没入库的文件挡路时带上文件名与下一步", () => {
  // 以下几段都是 git 2.51 的原文（LC_ALL=C）。
  const blocked = describeGitFailure("error: The following untracked working tree files would be overwritten by merge:\n\tdir/new 2.txt\n\tnew1.txt\nPlease move or remove them before you merge.\nAborting\n");
  assert.equal(blocked, "这些没入库的文件会被覆盖：dir/new 2.txt、new1.txt。把它们移到别处或删掉后再试一次");
  assert.equal(
    describeGitFailure("error: Untracked working tree file 'a.txt' would be overwritten by merge.\nfatal: Could not reset index file to revision 'f41df96'.\n"),
    "这些没入库的文件会被覆盖：a.txt。把它们移到别处或删掉后再试一次",
  );
  const many = describeGitFailure(`error: The following untracked working tree files would be overwritten by merge:\n${[1, 2, 3, 4, 5, 6, 7].map((n) => `\tf${n}.txt`).join("\n")}\nPlease move or remove them before you merge.\nAborting\n`);
  assert.match(many, /f1\.txt、f2\.txt、f3\.txt、f4\.txt、f5\.txt 等 7 个。/);
  assert.doesNotMatch(many, /f6\.txt/);

  assert.equal(
    describeGitFailure("hint: Diverging branches can't be fast-forwarded, you need to either:\nhint:\nhint: \tgit merge --no-ff\nhint:\nfatal: Not possible to fast-forward, aborting.\n"),
    "fatal: Not possible to fast-forward, aborting.",
  );
  assert.equal(
    describeGitFailure("error: Entry 'new1.txt' not uptodate. Cannot merge.\nfatal: Could not reset index file to revision 'f41df96'.\n"),
    "error: Entry 'new1.txt' not uptodate. Cannot merge.",
    "两条都有时取前一条（更具体的那条）",
  );
  assert.equal(describeGitFailure("warning: something\r\nlast words\r\n\r\n"), "last words", "没有 error: / fatal: 才退到最后一个非空行");
  assert.equal(describeGitFailure("", "git merge 失败"), "git merge 失败");
  assert.equal(describeGitFailure(undefined, "git merge 失败"), "git merge 失败");
  assert.equal(describeGitFailure("fatal: unable to access 'https://u:tok@github.com/o/r.git/': boom\nAborting"), "fatal: unable to access 'https://github.com/o/r.git/': boom");
  assert.equal(describeGitFailure(`fatal: ${"x".repeat(500)}`).length, 200);
  assert.ok(describeGitFailure(`error: The following untracked working tree files would be overwritten by merge:\n\t${"长".repeat(900)}\nAborting\n`).length < 300);
});

// ---------------------------------------------------------------------------
// 纯判定
// ---------------------------------------------------------------------------

test("planUpdate：版本更高且落后才算有更新；不满足一键更新的条件逐条给原因", () => {
  const install = { version: "1.0.0", branch: "main", dirty: [] };
  const sha = "a".repeat(40);
  assert.deepEqual(planUpdate({ install, target: sha, behind: 2, ahead: 0, remoteVersion: "1.1.0", lockChanged: false }), { available: true, canApply: true, blockers: [] });
  assert.equal(planUpdate({ install, target: sha, behind: 2, ahead: 0, remoteVersion: "1.0.0", lockChanged: false }).available, false, "版本号没变不提示");
  assert.equal(planUpdate({ install, target: sha, behind: 0, ahead: 0, remoteVersion: "1.1.0", lockChanged: false }).available, false);
  assert.equal(planUpdate({ install, target: sha, behind: 1, ahead: 0, remoteVersion: "0.9.0", lockChanged: false }).available, false, "不降级");
  assert.equal(planUpdate({ install, target: sha, behind: 1, ahead: 0, remoteVersion: null, lockChanged: false }).available, false);
  const blocked = planUpdate({ install: { version: "1.0.0", branch: "dev", dirty: ["a.txt", "b.txt"] }, target: sha, behind: 1, ahead: 2, remoteVersion: "1.1.0", lockChanged: true });
  assert.equal(blocked.available, true);
  assert.equal(blocked.canApply, false);
  assert.deepEqual(blocked.blockers.map((b) => b.code), ["branch", "dirty", "diverged", "needs-install"]);
  assert.match(blocked.blockers[3].message, /npm install/);
});

test("planUpdate：目标版本要的 Node 这台电脑不满足 → 不给更新，说清要什么、现在是什么；范围读不懂 / 没写不拦", () => {
  const args = { install: { version: "1.0.0", branch: "main", dirty: [] }, target: "a".repeat(40), behind: 1, ahead: 0, remoteVersion: "1.1.0", lockChanged: false };
  const tooOld = planUpdate({ ...args, requiredNode: ">=24.0.0 <27", nodeVersion: "22.12.0" });
  assert.deepEqual([tooOld.available, tooOld.canApply, tooOld.blockers.map((b) => b.code)], [true, false, ["node-version"]]);
  assert.match(tooOld.blockers[0].message, /^v1\.1\.0 需要 Node\.js 24\.0 及以上、低于 27，这台电脑上是 22\.12\.0：.*现在的版本照常可用/);
  const tooNew = planUpdate({ ...args, requiredNode: ">=22.12.0 <27", nodeVersion: "v27.1.0" });
  assert.deepEqual(tooNew.blockers.map((b) => b.code), ["node-version"]);
  assert.match(tooNew.blockers[0].message, /这台电脑上是 27\.1\.0/);
  assert.equal(planUpdate({ ...args, requiredNode: ">=24.0.0 <27", nodeVersion: "24.4.1" }).canApply, true);
  assert.equal(planUpdate({ ...args, remoteVersion: "1.0.0", requiredNode: ">=24.0.0 <27", nodeVersion: "22.12.0" }).blockers.length, 0, "没有更新可提示时不说这个");

  for (const requiredNode of [undefined, null, "", "^24.0.0", "lts/*", ">=22 || >=24", 24]) {
    assert.equal(planUpdate({ ...args, requiredNode, nodeVersion: "18.0.0" }).canApply, true, `engines.node = ${String(requiredNode)}`);
  }
  assert.equal(planUpdate({ ...args, requiredNode: ">=24.0.0 <27", nodeVersion: null }).canApply, true, "不知道现在跑的是哪个 Node 也不拦");

  // 依赖也变了：Node 不合适时不把「在终端里 git pull && npm install」那条命令递出去，Node 换好之后才提示它。
  const both = planUpdate({ ...args, lockChanged: true, requiredNode: ">=24.0.0 <27", nodeVersion: "22.12.0" });
  assert.deepEqual(both.blockers.map((b) => b.code), ["node-version"]);
  assert.doesNotMatch(JSON.stringify(both.blockers), /git pull|npm install/);
  assert.deepEqual(planUpdate({ ...args, lockChanged: true, requiredNode: ">=24.0.0 <27", nodeVersion: "24.4.1" }).blockers.map((b) => b.code), ["needs-install"]);
});

test("planUpdate：远端停在回退时记下的那个提交 → 不给更新，排在第一条；远端换了提交就不算", () => {
  const sha = "a".repeat(40);
  const args = { install: { version: "1.0.0", branch: "main", dirty: [] }, target: sha, behind: 1, ahead: 0, remoteVersion: "1.1.0", lockChanged: false };
  const skipped = planUpdate({ ...args, skipTarget: sha });
  assert.deepEqual([skipped.available, skipped.canApply, skipped.blockers.map((b) => b.code)], [true, false, ["skipped"]]);
  assert.equal(skipped.blockers[0].command, "npm run update -- --force");
  assert.deepEqual(planUpdate({ ...args, skipTarget: "b".repeat(40) }), { available: true, canApply: true, blockers: [] });
  assert.deepEqual(planUpdate({ ...args, skipTarget: null }).blockers, []);
  const more = planUpdate({ ...args, install: { version: "1.0.0", branch: "dev", dirty: ["a.txt"] }, skipTarget: sha });
  assert.deepEqual(more.blockers.map((b) => b.code), ["skipped", "branch", "dirty"]);
  assert.deepEqual(planUpdate({ ...args, remoteVersion: "1.0.0", skipTarget: sha }).blockers, [], "没有更新可提示时不说这个");
});

test("lockNeedsInstall：发版时只有根包版本号跟着变 → 不用重装；依赖变了 / 读不懂 → 要", () => {
  assert.equal(lockNeedsInstall(lockOf("1.0.0"), lockOf("1.1.0")), false);
  assert.equal(lockNeedsInstall(lockOf("1.0.0"), lockOf("1.0.0")), false);
  assert.equal(lockNeedsInstall(lockOf("1.0.0"), lockOf("1.1.0", "45.0.0")), true);
  assert.equal(lockNeedsInstall(lockOf("1.0.0"), "{broken"), true);
  assert.equal(lockNeedsInstall("null", lockOf("1.0.0")), true);
  const withEngines = JSON.stringify({ ...JSON.parse(lockOf("1.1.0")), packages: { "": { name: "app", version: "1.1.0", engines: { node: ">=24" }, devDependencies: { electron: "44.4.5" } }, "node_modules/electron": { version: "44.4.5" } } });
  assert.equal(lockNeedsInstall(lockOf("1.0.0"), withEngines), true, "Node 版本要求变了也交给人处理");
});

// ---------------------------------------------------------------------------
// 安装形态
// ---------------------------------------------------------------------------

test("inspectInstall：git 安装 / 不是仓库 / 嵌在别人仓库里的目录 / 打包安装", async (t) => {
  const ctx = setup(t);
  const git = createGit({ root: ctx.install, env: GIT_ENV });
  const info = await inspectInstall({ rootDir: ctx.install, git });
  assert.equal(info.kind, "git");
  assert.equal(info.branch, "main");
  assert.equal(info.version, "1.0.0");
  assert.deepEqual(info.dirty, []);
  assert.match(info.head, /^[0-9a-f]{40}$/);
  // Windows 上 git 会把本地路径记成正斜杠、临时目录还可能是 8.3 短名：只认结尾，不比全路径。
  assert.match(info.remote.replaceAll("\\", "/"), /\/remote\.git$/);

  const plain = path.join(ctx.base, "plain");
  fs.mkdirSync(plain);
  writeJson(path.join(plain, "package.json"), { version: "1.0.0" });
  assert.equal((await inspectInstall({ rootDir: plain, git: createGit({ root: plain, env: GIT_ENV }) })).kind, "plain");

  // 解压在别人仓库里的一份拷贝：外层是仓库，但安装目录不是仓库根 → 不能拿外层来更新。
  const nested = path.join(ctx.install, "vendor-copy");
  fs.mkdirSync(nested);
  writeJson(path.join(nested, "package.json"), { version: "1.0.0" });
  assert.equal((await inspectInstall({ rootDir: nested, git: createGit({ root: nested, env: GIT_ENV }) })).kind, "plain");

  assert.equal((await inspectInstall({ rootDir: ctx.install, git, packaged: true })).kind, "packaged");
  const missing = await inspectInstall({ rootDir: ctx.install, git: async () => ({ ok: false, code: 1, stdout: "", stderr: "spawn git ENOENT" }) });
  assert.equal(missing.kind, "no-git");
});

test("inspectInstall：git 说不是仓库才算不是仓库；目录归属被拒单独一种、带放行命令；别的失败只是这次没读出来", async (t) => {
  const ctx = setup(t);
  // 真实的 "dubious ownership"：让 git 认为这个目录属于别人（Windows 上管理员身份 clone、exFAT / 网络盘就是这样）。
  const refused = await inspectInstall({ rootDir: ctx.install, git: createGit({ root: ctx.install, env: { ...GIT_ENV, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" } }) });
  assert.equal(refused.kind, "unsafe-owner");
  assert.equal(refused.version, "1.0.0");
  const quoted = refused.command.match(/^git config --global --add safe\.directory "(.+)"$/);
  assert.ok(quoted, refused.command);
  assert.match(quoted[1].replaceAll("\\", "/"), /\/install$/, "放行的是这个安装目录");

  const failing = (res) => async () => ({ ok: false, code: 128, stdout: "", stderr: "", timedOut: false, ...res });
  // Windows 上的原文多几行所有者信息，路径是正斜杠、可能带空格。
  const windows = await inspectInstall({ rootDir: ctx.install, git: failing({ stderr: "fatal: detected dubious ownership in repository at 'C:/Users/me/cluster workbench'\n'C:/Users/me/cluster workbench' is owned by:\n\t(inconvertible) (S-1-5-32-544)\nbut the current user is:\n\tPC/me (S-1-5-21-1)\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory 'C:/Users/me/cluster workbench'\n" }) });
  assert.deepEqual([windows.kind, windows.command], ["unsafe-owner", 'git config --global --add safe.directory "C:/Users/me/cluster workbench"']);

  const timedOut = await inspectInstall({ rootDir: ctx.install, git: failing({ code: null, timedOut: true }) });
  assert.deepEqual([timedOut.kind, timedOut.detail], ["unknown", "git 没有在限定时间内返回"]);
  const odd = await inspectInstall({ rootDir: ctx.install, git: failing({ stderr: "fatal: unable to read tree 1a2b3c4\nAborting\n" }) });
  assert.deepEqual([odd.kind, odd.detail], ["unknown", "fatal: unable to read tree 1a2b3c4"]);
  assert.equal((await inspectInstall({ rootDir: ctx.install, git: failing({ code: 1 }) })).detail, "git 退出码 1");
  assert.equal((await inspectInstall({ rootDir: ctx.install, git: failing({ stderr: "fatal: not a git repository (or any of the parent directories): .git\n" }) })).kind, "plain");
});

// ---------------------------------------------------------------------------
// 检查
// ---------------------------------------------------------------------------

test("检查：远端推了更高的版本 → 有更新、可一键更新；版本没变的提交不提示", async (t) => {
  const ctx = setup(t);
  const service = ctx.make();
  let st = await service.check({ force: true });
  assert.equal(st.supported, true);
  assert.equal(st.available, false);
  assert.equal(st.localVersion, "1.0.0");
  assert.equal(st.error, null);

  publish(ctx.pub, "1.0.0", { "docs.txt": "only docs\n" });
  st = await service.check({ force: true });
  assert.equal(st.behind, 1);
  assert.equal(st.available, false, "版本号没变：不提示");

  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  st = await service.check({ force: true });
  assert.equal(st.available, true);
  assert.equal(st.canApply, true);
  assert.equal(st.remoteVersion, "1.1.0");
  assert.equal(st.behind, 2);
  assert.deepEqual(st.blockers, []);
  assert.ok(ctx.logs.some((l) => /v1\.1\.0 available/.test(l)));
  assert.equal(pkgVersion(ctx.install), "1.0.0", "检查不改工作区");
});

test("检查：最小间隔内不重复 fetch；status 不联网；网页模式标出能否自动拉起", async (t) => {
  const ctx = setup(t);
  let fetches = 0;
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => {
    if (args[0] === "fetch") fetches += 1;
    return real(args, opts);
  };
  const service = ctx.make({ git, env: { [RESPAWN_ENV]: "1" } });
  const idle = await service.status();
  assert.equal(fetches, 0, "status 只做本地检查");
  assert.equal(idle.checkedAt, null);
  assert.equal(idle.respawn, true);
  assert.equal(idle.lastUpdate, null);
  await service.check();
  await service.check();
  assert.equal(fetches, 1, "一分钟内第二次直接用上次的结论");
  await service.check({ force: true });
  assert.equal(fetches, 2);
  assert.equal(ctx.make().respawn, false);
});

test("检查：连不上远端 → 带着原因返回，不抛错；上次取到的结论还在", async (t) => {
  const ctx = setup(t);
  const service = ctx.make();
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  assert.equal((await service.check({ force: true })).available, true);
  fs.renameSync(ctx.remote, `${ctx.remote}.gone`);
  const st = await service.check({ force: true });
  assert.ok(st.error, "带上这次的错误");
  assert.equal(st.available, true, "已经取到的那个版本照样算数");
});

test("不给更新按钮的情况：本地有改动 / 不在 main / 本地有自己的提交 / 改了依赖", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });

  fs.writeFileSync(path.join(ctx.install, "app.txt"), "local edit\n");
  let st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["dirty"]);
  assert.equal(st.canApply, false);
  assert.match(st.blockers[0].message, /app\.txt/);
  sh(ctx.install, "checkout", "-q", "--", "app.txt");

  fs.writeFileSync(path.join(ctx.install, "untracked.txt"), "x\n");
  st = await ctx.make().check({ force: true });
  assert.equal(st.canApply, true, "没入库的文件不算改动");

  // npm install 自己改写的锁文件不算：安装说明第一步就是 npm install，npm 11 会删掉锁文件里的 libc 字段。
  fs.writeFileSync(path.join(ctx.install, "package-lock.json"), lockOf("1.0.0").replace('"lockfileVersion": 3', '"lockfileVersion": 3,\n  "rewrittenByNpm": true'));
  st = await ctx.make().check({ force: true });
  assert.deepEqual([st.canApply, st.blockers], [true, []], "只有锁文件被改写：照样给更新按钮");
  fs.writeFileSync(path.join(ctx.install, "app.txt"), "local edit\n");
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => [b.code, b.files]), [["dirty", ["app.txt"]]], "别的文件有改动照旧拦，说明里不提锁文件");
  sh(ctx.install, "checkout", "-q", "--", "app.txt", "package-lock.json");

  sh(ctx.install, "checkout", "-q", "-b", "dev");
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["branch"]);
  sh(ctx.install, "checkout", "-q", "main");

  fs.writeFileSync(path.join(ctx.install, "mine.txt"), "mine\n");
  sh(ctx.install, "add", "mine.txt");
  sh(ctx.install, "commit", "-q", "-m", "local");
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["diverged"]);
  sh(ctx.install, "reset", "-q", "--hard", "HEAD~1");

  publish(ctx.pub, "1.2.0", { "package-lock.json": lockOf("1.2.0", "45.0.0") });
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["needs-install"]);
  assert.equal(st.blockers[0].command, "git checkout -- package-lock.json && git pull --ff-only && npm install");
  await assert.rejects(ctx.make().apply(), (e) => e.status === 409 && e.code === "needs-install");
  assert.equal(pkgVersion(ctx.install), "1.0.0");
});

test("目标版本抬高了 engines.node：这台电脑的 Node 不够就不更新（更新过去启动器会拒绝启动），够了照常", async (t) => {
  const ctx = setup(t);
  const pkgOf = (version, node) => `${JSON.stringify({ name: "app", version, engines: { node } }, null, 2)}\n`;
  // 发布方只改了 package.json 的 engines（锁文件没跟着重新生成）：以前这种更新能一键装上，装完就起不来。
  publish(ctx.pub, "1.1.0", { "package.json": pkgOf("1.1.0", ">=24.0.0 <27"), "app.txt": "two\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  const old = ctx.make({ nodeVersion: "22.12.0" });
  const st = await old.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.blockers.map((b) => b.code)], [true, false, ["node-version"]]);
  assert.match(st.blockers[0].message, /v1\.1\.0 需要 Node\.js 24\.0 及以上、低于 27，这台电脑上是 22\.12\.0/);
  await assert.rejects(old.apply(), (e) => e.status === 409 && e.code === "node-version" && /现在的版本照常可用/.test(e.message));
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), before);
  assert.equal(ctx.smokes.length, 0, "连自检都不用做");

  // 锁文件也跟着记了新的 engines（npm install 重新生成的样子）：同样只说 Node，不递那条手动更新的命令。
  const lock = JSON.parse(lockOf("1.2.0"));
  lock.packages[""].engines = { node: ">=24.0.0 <27" };
  publish(ctx.pub, "1.2.0", { "package.json": pkgOf("1.2.0", ">=24.0.0 <27"), "package-lock.json": `${JSON.stringify(lock, null, 2)}\n` });
  assert.deepEqual((await ctx.make({ nodeVersion: "22.12.0" }).check({ force: true })).blockers.map((b) => b.code), ["node-version"]);
  assert.deepEqual((await ctx.make({ nodeVersion: "24.4.1" }).check({ force: true })).blockers.map((b) => b.code), ["needs-install"]);

  // engines 写成读不懂的样子：不拦。
  publish(ctx.pub, "1.3.0", { "package.json": pkgOf("1.3.0", "lts/*"), "package-lock.json": lockOf("1.3.0") });
  assert.equal((await ctx.make({ nodeVersion: "18.0.0" }).check({ force: true })).blockers.some((b) => b.code === "node-version"), false);
  // 不注入时对的是真正在跑的这个 Node。
  const nextMajor = Number(process.versions.node.split(".")[0]) + 1;
  publish(ctx.pub, "1.4.0", { "package.json": pkgOf("1.4.0", `>=${nextMajor}.0.0`), "package-lock.json": lockOf("1.4.0") });
  const real = await ctx.make().check({ force: true });
  assert.deepEqual(real.blockers.map((b) => b.code), ["node-version"]);
  assert.ok(real.blockers[0].message.includes(`需要 Node.js ${nextMajor}.0 及以上，这台电脑上是 ${process.versions.node}：`), real.blockers[0].message);
});

test("预检 Node 要求时对的是启动器的 Node：桌面模式下本进程跑在 Electron 自带的 Node 上，拒绝启动的闸看的不是它", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "package.json": `${JSON.stringify({ name: "app", version: "1.1.0", engines: { node: ">=24.0.0 <27" } })}\n` });
  // 系统的 Node 是 22.12（启动器报上来的），Electron 自带 24：装过去之后下次 npm run start 会被拒绝。
  const st = await ctx.make({ env: { [LAUNCHER_NODE_ENV]: "22.12.0" }, nodeVersion: "24.4.1" }).check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["node-version"]);
  assert.match(st.blockers[0].message, /这台电脑上是 22\.12\.0：/);
  assert.equal((await ctx.make({ env: { [LAUNCHER_NODE_ENV]: "24.4.1" }, nodeVersion: "22.12.0" }).check({ force: true })).canApply, true);
  // 没报（命令行 npm run update、手工起的服务）或报的读不懂：用本进程的。
  assert.equal((await ctx.make({ env: { [LAUNCHER_NODE_ENV]: "latest" }, nodeVersion: "24.4.1" }).check({ force: true })).canApply, true);
  assert.deepEqual((await ctx.make({ env: {}, nodeVersion: "22.12.0" }).check({ force: true })).blockers.map((b) => b.code), ["node-version"]);
});

test("不支持的安装方式如实说明，不联网", async (t) => {
  const ctx = setup(t);
  let fetches = 0;
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => {
    if (args[0] === "fetch") fetches += 1;
    return real(args, opts);
  };
  const packaged = await ctx.make({ git, packaged: true }).check({ force: true });
  assert.equal(packaged.supported, false);
  assert.equal(packaged.kind, "packaged");
  assert.match(packaged.unsupportedReason, /下载新的安装包/);
  assert.equal(fetches, 0);
  await assert.rejects(ctx.make({ packaged: true }).apply(), (e) => e.status === 409 && e.code === "unsupported");

  sh(ctx.install, "remote", "remove", "origin");
  const noRemote = await ctx.make({ git }).check({ force: true });
  assert.equal(noRemote.supported, false);
  assert.match(noRemote.unsupportedReason, /origin/);
  assert.equal(fetches, 0);
});

test("目录归属被 git 拒绝：说明原因并给出放行命令；照着执行后下一轮定时检查自己接上，不用重启", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  // 这个测试自己的全局配置（放行命令要往里写）；GIT_TEST_ASSUME_DIFFERENT_OWNER 让 git 把所有目录都当成别人的。
  const globalConfig = path.join(ctx.base, "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const env = { ...GIT_ENV, GIT_CONFIG_GLOBAL: globalConfig, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
  const timers = fakeTimers();
  const service = ctx.make({ git: createGit({ root: ctx.install, env }), timers, now: timers.now });
  let st = await service.status();
  assert.deepEqual([st.supported, st.kind, st.localVersion], [false, "unsafe-owner", "1.0.0"]);
  assert.match(st.unsupportedReason, /git 不信任这个目录.*在终端执行一次 git config --global --add safe\.directory ".+" 之后再检查更新/);
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "unsupported" && /safe\.directory/.test(e.message));

  // 把说明里的那条命令原样执行。夹具里的「远端」也是本机目录，一并放行，以防 git 在 fetch 本机目录时
  // 连它的归属也查；真实的远端在 GitHub 上，没有这回事。
  const dir = st.unsupportedReason.match(/safe\.directory "(.+?)"/)[1];
  for (const allowed of [dir, ctx.remote]) execFileSync("git", ["config", "--global", "--add", "safe.directory", allowed], { env, stdio: "ignore" });
  service.start();
  timers.tick();
  st = await settled(service);
  assert.deepEqual([st.supported, st.kind, st.unsupportedReason, st.available, st.canApply], [true, "git", null, true, true]);
  service.stop();
});

test("这一次没读出安装目录的状态（git 超时等）：是一次错误，不是「不支持」；已有的结论留着，但不照着它动手", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  let stuck = true;
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => (stuck && args.join(" ") === "rev-parse --show-toplevel"
    ? { ok: false, code: null, stdout: "", stderr: "", timedOut: true }
    : real(args, opts));
  const timers = fakeTimers();
  const service = ctx.make({ git, timers, now: timers.now });
  // 一上来就没读出来：还不知道支不支持，带着原因。
  let st = await service.status();
  assert.deepEqual([st.supported, st.kind, st.unsupportedReason, st.error], [null, "unknown", null, { code: "inspect-failed", message: "读不到这个目录的 git 状态（git 没有在限定时间内返回），稍后会自动再查" }]);
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "inspect-failed");

  // 下一轮定时检查读出来了：照常给结论。
  service.start();
  stuck = false;
  timers.tick();
  st = await settled(service);
  assert.deepEqual([st.supported, st.kind, st.available, st.canApply, st.error], [true, "git", true, true, null]);

  // 有了结论之后又失败一次：那个新版本还在（横幅不闪掉），只是多了这次的错误；点更新不会照着旧结论动手。
  stuck = true;
  st = await service.check({ force: true });
  assert.deepEqual([st.supported, st.available, st.remoteVersion, st.error?.code], [true, true, "1.1.0", "inspect-failed"]);
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "inspect-failed");
  assert.equal(ctx.smokes.length, 0);
  assert.equal(pkgVersion(ctx.install), "1.0.0");

  stuck = false;
  assert.equal((await service.apply()).toVersion, "1.1.0");
  stuck = true;
  await assert.rejects(service.rollback(), (e) => e.code === "inspect-failed" && /没有回退；请再试一次/.test(e.message));
  assert.equal(pkgVersion(ctx.install), "1.1.0");
  service.stop();
});

test("定时检查每一轮都重新看安装目录：在别的分支上不联网；切回 main 后自己接上；打包安装不查", async (t) => {
  const ctx = setup(t);
  let calls = 0;
  let fetches = 0;
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => {
    calls += 1;
    if (args[0] === "fetch") fetches += 1;
    return real(args, opts);
  };
  sh(ctx.install, "checkout", "-q", "-b", "dev");
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const timers = fakeTimers();
  const service = ctx.make({ git, timers, now: timers.now });
  assert.equal((await service.status()).branch, "dev");
  service.start();
  timers.tick();
  let st = await settled(service);
  assert.deepEqual([st.branch, fetches, st.available, st.checkedAt], ["dev", 0, false, null], "没联网的那一轮不算检查过");

  sh(ctx.install, "checkout", "-q", "main");
  timers.tick();
  st = await settled(service);
  assert.deepEqual([st.branch, fetches, st.available, st.canApply], ["main", 1, true, true]);
  assert.ok(st.checkedAt);
  service.stop();

  const packagedTimers = fakeTimers();
  const packaged = ctx.make({ git, timers: packagedTimers, packaged: true });
  packaged.start();
  calls = 0;
  packagedTimers.tick();
  assert.deepEqual([(await packaged.status()).kind, calls], ["packaged", 0]);
  packaged.stop();
});

// ---------------------------------------------------------------------------
// 应用 / 回退
// ---------------------------------------------------------------------------

test("应用：先在临时工作树里自检目标版本，通过后快进合并，留下更新记录，临时工作树清干净", async (t) => {
  const ctx = setup(t);
  const target = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  const service = ctx.make({ env: { [RESPAWN_ENV]: "1" } });
  const res = await service.apply();
  assert.deepEqual(res, { ok: true, fromVersion: "1.0.0", toVersion: "1.1.0", respawn: true });
  assert.equal(ctx.smokes.length, 1);
  assert.equal(ctx.smokes[0].version, "1.1.0", "自检的是目标版本的代码");
  assert.notEqual(ctx.smokes[0].tree, ctx.install, "自检在旁边的临时目录里做");
  assert.equal(fs.existsSync(ctx.smokes[0].tree), false, "临时工作树已删除");
  assert.equal(sh(ctx.install, "worktree", "list").split("\n").length, 1, "没有残留的 worktree 登记");
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), target);
  assert.equal(pkgVersion(ctx.install), "1.1.0");
  assert.equal(fs.readFileSync(path.join(ctx.install, "app.txt"), "utf8"), "two\n");
  const m = marker(ctx);
  assert.deepEqual({ from: m.from, to: m.to, fromVersion: m.fromVersion, toVersion: m.toVersion, handoff: m.handoff }, { from: before, to: target, fromVersion: "1.0.0", toVersion: "1.1.0", handoff: "pending" });
  const st = await service.status();
  assert.equal(st.available, false);
  assert.equal(st.localVersion, "1.1.0");
  assert.equal(st.lastUpdate.toVersion, "1.1.0");
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "up-to-date");
});

test("应用：目标版本自检没过 → 422，工作区原封不动，不留记录", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  const service = ctx.make({ smoke: async () => ({ ok: false, detail: "SyntaxError: boom" }) });
  await assert.rejects(service.apply(), (e) => e.status === 422 && e.code === "smoke-failed" && /SyntaxError: boom/.test(e.message) && /现在的版本照常可用/.test(e.message));
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), before);
  assert.equal(pkgVersion(ctx.install), "1.0.0");
  assert.equal(fs.existsSync(path.join(ctx.runtimeDir, MARKER_FILE)), false);
  assert.equal(sh(ctx.install, "worktree", "list").split("\n").length, 1);
  assert.equal((await service.status()).available, true, "更新仍然在那里，等发布方修好");
});

test("应用：同时点两次只做一次；自检期间目录被改动则放弃", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = ctx.make({ smoke: async () => { await gate; return { ok: true }; } });
  const first = service.apply();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "busy");
  assert.equal((await service.status()).applying, true);
  release();
  assert.equal((await first).toVersion, "1.1.0");

  publish(ctx.pub, "1.2.0", { "app.txt": "three\n" });
  const racing = ctx.make({ smoke: async () => { fs.writeFileSync(path.join(ctx.install, "app.txt"), "edited during smoke\n"); return { ok: true }; } });
  await assert.rejects(racing.apply(), (e) => e.status === 409 && e.code === "changed");
  assert.equal(pkgVersion(ctx.install), "1.1.0");
});

test("回退：回到那次更新之前的提交；提交已经变了 / 有本地改动时不动", async (t) => {
  const ctx = setup(t);
  const service = ctx.make();
  await assert.rejects(service.rollback(), (e) => e.code === "no-marker");
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  await service.apply();

  fs.writeFileSync(path.join(ctx.install, "app.txt"), "local\n");
  await assert.rejects(service.rollback(), (e) => e.code === "dirty");
  sh(ctx.install, "checkout", "-q", "--", "app.txt");

  const res = await service.rollback();
  assert.deepEqual(res, { ok: true, fromVersion: "1.1.0", toVersion: "1.0.0", skipped: true });
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), before);
  assert.equal(pkgVersion(ctx.install), "1.0.0");
  assert.equal(marker(ctx).handoff, "rolled-back");
  await assert.rejects(service.rollback(), (e) => e.code === "moved", "已经回退过：HEAD 不再是那次更新的提交");
});

test("回退后：远端还停在被退掉的那个提交 → 不再给更新并说明；远端有了新的提交 → 照常；想装回去有 --force 的出口", async (t) => {
  const ctx = setup(t);
  const service = ctx.make();
  const bad = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  await service.apply();
  await service.rollback();
  assert.equal(marker(ctx).skipTarget, bad);

  let st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.remoteVersion, st.blockers.map((b) => b.code)], [true, false, "1.1.0", ["skipped"]]);
  assert.equal(st.blockers[0].message, "已回退到 v1.0.0，v1.1.0 这一版先跳过：发布方推送新的提交后会再提示更新。仍然想装这一版的话，在终端进安装目录执行 npm run update -- --force");
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "skipped");
  assert.equal(pkgVersion(ctx.install), "1.0.0");
  assert.equal(ctx.smokes.length, 1, "只有回退前那一次自检");
  // 回退之后重启工作台：新进程第一次读状态（不联网）就是这个结论，横幅上没有更新按钮。
  const restarted = await ctx.make().status();
  assert.deepEqual([restarted.canApply, restarted.blockers.map((b) => b.code)], [false, ["skipped"]]);

  // 出口（命令行 --force）：这一次不理会「跳过」；没装成的话「跳过」原样留着。
  st = await ctx.make().check({ force: true, ignoreSkip: true });
  assert.deepEqual([st.canApply, st.blockers], [true, []]);
  await assert.rejects(ctx.make({ smoke: async () => ({ ok: false, detail: "boom" }) }).apply({ ignoreSkip: true }), (e) => e.code === "smoke-failed");
  assert.deepEqual((await ctx.make().check({ force: true })).blockers.map((b) => b.code), ["skipped"]);

  // 发布方推了新的提交（哪怕版本号没再涨）：照常提示、照常能装；新的更新记录里不再带「跳过」。
  const fixed = publish(ctx.pub, "1.1.0", { "app.txt": "two, fixed\n" });
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.blockers], [true, true, []]);
  await service.apply();
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), fixed);
  assert.equal("skipTarget" in marker(ctx), false);

  // 另一台：回退后用 --force 把同一版装回去。
  const other = setup(t);
  const again = publish(other.pub, "1.1.0", { "app.txt": "two\n" });
  const forced = other.make();
  await forced.apply();
  await forced.rollback();
  assert.deepEqual(await forced.apply({ ignoreSkip: true }), { ok: true, fromVersion: "1.0.0", toVersion: "1.1.0", respawn: false });
  assert.equal(sh(other.install, "rev-parse", "HEAD"), again);
  assert.equal("skipTarget" in marker(other), false);
});

test("锁文件被 npm install 改写过：更新与回退前先还原它，不被这份改动挡住", async (t) => {
  const ctx = setup(t);
  const lockPath = path.join(ctx.install, "package-lock.json");
  const rewrite = () => fs.writeFileSync(lockPath, fs.readFileSync(lockPath, "utf8").replace('"lockfileVersion": 3', '"lockfileVersion": 3,\n  "rewrittenByNpm": true'));
  const target = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  rewrite();
  assert.match(sh(ctx.install, "status", "--porcelain", "--untracked-files=no"), /package-lock\.json/);
  const service = ctx.make();
  await service.apply();
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), target);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockOf("1.1.0"), "锁文件是新版本入库的那份");
  assert.equal(sh(ctx.install, "status", "--porcelain", "--untracked-files=no"), "");
  assert.ok(ctx.logs.some((line) => /restored package-lock\.json/.test(line)));

  rewrite();
  await service.rollback();
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockOf("1.0.0"));
});

test("git 没做成时说的是原因：没入库的文件挡住合并 / 回退 → 点出文件名与下一步；取不出工作树 → fatal 那一句", async (t) => {
  const ctx = setup(t);
  // 新版本删掉 app.txt、新增 notes.txt；安装目录里恰好有一个没入库的 notes.txt。
  fs.rmSync(path.join(ctx.pub, "app.txt"));
  publish(ctx.pub, "1.1.0", { "notes.txt": "from upstream\n" });
  const before = sh(ctx.install, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(ctx.install, "notes.txt"), "mine\n");
  const service = ctx.make();
  await assert.rejects(service.apply(), (e) => {
    assert.deepEqual([e.status, e.code], [409, "merge-failed"]);
    assert.equal(e.message, "快进合并没有成功，没有更新：这些没入库的文件会被覆盖：notes.txt。把它们移到别处或删掉后再试一次");
    return true;
  });
  assert.equal(sh(ctx.install, "rev-parse", "HEAD"), before);
  assert.equal(fs.readFileSync(path.join(ctx.install, "notes.txt"), "utf8"), "mine\n", "那个文件原样留着");

  // 照着做（挪走）之后更新成功；再放一个旧版本里有的 app.txt，回退同样被挡住并说清楚。
  fs.rmSync(path.join(ctx.install, "notes.txt"));
  await service.apply();
  fs.writeFileSync(path.join(ctx.install, "app.txt"), "mine\n");
  await assert.rejects(service.rollback(), (e) => {
    assert.equal(e.code, "reset-failed");
    assert.equal(e.message, "回退没有成功：这些没入库的文件会被覆盖：app.txt。把它们移到别处或删掉后再试一次");
    return true;
  });
  assert.equal(pkgVersion(ctx.install), "1.1.0");

  // git worktree add 失败：stderr 里先是进度、再是原因、最后是提示。
  fs.rmSync(path.join(ctx.install, "app.txt"));
  await service.rollback();
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => (args[0] === "worktree" && args[1] === "add"
    ? { ok: false, code: 128, stdout: "", stderr: "Preparing worktree (detached HEAD 1a2b3c4)\nfatal: could not create leading directories of '/tmp/x/.git': Permission denied\nhint: check the directory permissions\n", timedOut: false }
    : real(args, opts));
  // 上面刚回退过：这里只看 worktree 的报错，换一个不带更新记录的运行目录。
  await assert.rejects(ctx.make({ git, runtimeDir: path.join(ctx.base, "runtime-2") }).apply(), (e) => {
    assert.equal(e.message, "没能取出新版本做自检：fatal: could not create leading directories of '/tmp/x/.git': Permission denied");
    return true;
  });
});

// ---------------------------------------------------------------------------
// 更新通道（v2.62）：在哪个分支上就跟远端的哪个分支；远端仍是 os.tmpdir() 下的裸仓库
// ---------------------------------------------------------------------------

// 发布方推进稳定版：把远端的 stable 指到一个已经在 main 上的提交（第一次即创建）。一条普通的、不强制的 push。
const promote = (ctx, sha) => sh(ctx.pub, "push", "-q", "origin", `${sha}:refs/heads/stable`);
const branchOf = (dir) => sh(dir, "rev-parse", "--abbrev-ref", "HEAD");
const headOf = (dir) => sh(dir, "rev-parse", "HEAD");
const hasRef = (dir, ref) => {
  try {
    sh(dir, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

// 认识更新通道的版本里才有 channel.mjs（CHANNEL_AWARE_FILE）；换通道只往有它的提交上换。夹具里放一个同名的空壳，
// 从第一版起就带着。
const CHANNEL_AWARE = { [CHANNEL_AWARE_FILE]: "// 夹具：认识更新通道的版本\n" };
const setupAware = (t) => setup(t, { files: CHANNEL_AWARE });

// 稳定版的安装：发布方已经建了 stable（停在 v1.0.0），安装目录像安装器那样 clone 下来之后切到 stable 上。
function setupStable(t) {
  const ctx = setupAware(t);
  promote(ctx, headOf(ctx.pub));
  sh(ctx.install, "fetch", "-q", "origin");
  sh(ctx.install, "checkout", "-q", "-b", "stable", "--track", "origin/stable");
  return ctx;
}

// 记下服务发出的每条 git 命令。net()：只看联网的那几条（fetch / ls-remote）与它们取的是哪条引用。
// intercept(args) 返回结果就不再转给真 git（用来造失败）。
function recordingGit(ctx, intercept = () => null) {
  const calls = [];
  const real = createGit({ root: ctx.install, env: GIT_ENV });
  const git = async (args, opts) => {
    calls.push(args);
    return intercept(args) ?? real(args, opts);
  };
  const net = () => calls.filter((args) => args[0] === "fetch" || args[0] === "ls-remote").map((args) => [args[0], args.at(-1)]);
  return { git, calls, net };
}

// 工作区现在的样子：换通道没成的各种情况下前后必须一字不差。
const worktreeState = (dir) => ({
  branch: branchOf(dir),
  head: headOf(dir),
  status: sh(dir, "status", "--porcelain"),
  branches: sh(dir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  worktrees: sh(dir, "worktree", "list").split("\n").length,
});

test("planUpdate：stable 与 main 都是更新通道；别的分支不自动更新——远端没有稳定版时那句说明与以前一字不差", () => {
  const sha = "a".repeat(40);
  const args = { target: sha, behind: 1, ahead: 0, remoteVersion: "1.1.0", lockChanged: false };
  for (const branch of ["main", "stable"]) {
    assert.deepEqual(planUpdate({ ...args, install: { version: "1.0.0", branch, dirty: [] } }), { available: true, canApply: true, blockers: [] }, branch);
    assert.deepEqual(planUpdate({ ...args, install: { version: "1.0.0", branch, dirty: [] }, stableAvailable: true }).blockers, [], branch);
  }
  const dev = { version: "1.0.0", branch: "dev", dirty: [] };
  assert.deepEqual(planUpdate({ ...args, install: dev }).blockers, [{ code: "branch", message: "当前不在 main 分支（在 dev 上），不自动更新。切回 main 后再试" }]);
  assert.deepEqual(planUpdate({ ...args, install: { ...dev, branch: null } }).blockers, [{ code: "branch", message: "当前不在 main 分支（在 游离的提交 上），不自动更新。切回 main 后再试" }]);
  assert.deepEqual(planUpdate({ ...args, install: dev, stableAvailable: true }).blockers, [{ code: "branch", message: "当前不在 stable 或 main 分支（在 dev 上），不自动更新。切回其中一个后再试" }]);
  // 回退后跳过的那一版：稳定版等的是发布方下一次推进，开发版的说法不变。
  assert.match(planUpdate({ ...args, install: { version: "1.0.0", branch: "stable", dirty: [] }, skipTarget: sha }).blockers[0].message, /^已回退到 v1\.0\.0，v1\.1\.0 这一版先跳过：发布方发布新的稳定版后会再提示更新。/);
  assert.match(planUpdate({ ...args, install: { version: "1.0.0", branch: "main", dirty: [] }, skipTarget: sha }).blockers[0].message, /^已回退到 v1\.0\.0，v1\.1\.0 这一版先跳过：发布方推送新的提交后会再提示更新。/);
});

test("稳定版通道：只跟 origin/stable——main 上的新版本不提示；发布方推进稳定版之后才提示，更新 / 回退 / 跳过照旧", async (t) => {
  const ctx = setupStable(t);
  const rec = recordingGit(ctx);
  const service = ctx.make({ git: rec.git });
  let st = await service.check({ force: true });
  assert.deepEqual([st.supported, st.branch, st.channel, st.stableAvailable, st.available, st.error], [true, "stable", "stable", true, false, null]);

  // 发布方照常推 main（两个版本）：稳定版的安装什么都不提示。
  const v1 = headOf(ctx.install);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const v12 = publish(ctx.pub, "1.2.0", { "app.txt": "three\n" });
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.behind, st.remoteVersion, st.blockers], [false, false, 0, "1.0.0", []], "main 上的新版本不提示");
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "up-to-date");
  assert.deepEqual(rec.net().filter(([cmd]) => cmd === "fetch").every(([, refspec]) => refspec === "+refs/heads/stable:refs/remotes/origin/stable"), true, "只取自己那条通道的分支");
  assert.equal(rec.net().some(([cmd]) => cmd === "ls-remote"), false, "跟的就是稳定版，不用另问远端有没有它");
  assert.equal(sh(ctx.install, "rev-parse", "refs/remotes/origin/main"), v1, "没有顺带把 main 取下来");

  // 发布方确认 v1.2.0 没问题，推进稳定版：这时才提示，一键更新到的就是那个提交，分支仍是 stable。
  promote(ctx, v12);
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.remoteVersion, st.behind, st.channel], [true, true, "1.2.0", 2, "stable"]);
  assert.deepEqual(await service.apply(), { ok: true, fromVersion: "1.0.0", toVersion: "1.2.0", respawn: false });
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install), pkgVersion(ctx.install)], ["stable", v12, "1.2.0"]);
  assert.equal(ctx.smokes.at(-1).version, "1.2.0", "合并前自检的是稳定版的那个提交");
  assert.deepEqual({ from: marker(ctx).from, to: marker(ctx).to, handoff: marker(ctx).handoff }, { from: v1, to: v12, handoff: "pending" });

  // 回退 → 这一版被跳过：等的是发布方下一次推进，main 上再推什么都不算。
  assert.deepEqual(await service.rollback(), { ok: true, fromVersion: "1.2.0", toVersion: "1.0.0", skipped: true });
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["stable", v1]);
  const v13 = publish(ctx.pub, "1.3.0", { "app.txt": "four\n" });
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.remoteVersion, st.blockers.map((b) => b.code)], [true, false, "1.2.0", ["skipped"]]);
  assert.equal(st.blockers[0].message, "已回退到 v1.0.0，v1.2.0 这一版先跳过：发布方发布新的稳定版后会再提示更新。仍然想装这一版的话，在终端进安装目录执行 npm run update -- --force");
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "skipped");
  promote(ctx, v13);
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.remoteVersion, st.blockers], [true, true, "1.3.0", []]);
  await service.apply();
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["stable", v13]);
});

test("稳定版通道：定时检查照常联网；本地有改动 / 有自己的提交等不给按钮的情况与开发版同一套", async (t) => {
  const ctx = setupStable(t);
  const rec = recordingGit(ctx);
  const timers = fakeTimers();
  const service = ctx.make({ git: rec.git, timers, now: timers.now });
  promote(ctx, publish(ctx.pub, "1.1.0", { "app.txt": "two\n" }));
  service.start();
  timers.tick();
  let st = await settled(service);
  assert.deepEqual([st.branch, st.available, st.canApply], ["stable", true, true]);
  assert.ok(st.checkedAt);
  assert.deepEqual(rec.net(), [["fetch", "+refs/heads/stable:refs/remotes/origin/stable"]]);
  service.stop();

  fs.writeFileSync(path.join(ctx.install, "app.txt"), "local edit\n");
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["dirty"]);
  sh(ctx.install, "checkout", "-q", "--", "app.txt");

  fs.writeFileSync(path.join(ctx.install, "mine.txt"), "mine\n");
  sh(ctx.install, "add", "mine.txt");
  sh(ctx.install, "commit", "-q", "-m", "local");
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => b.code), ["diverged"]);
  sh(ctx.install, "reset", "-q", "--hard", "HEAD~1");

  promote(ctx, publish(ctx.pub, "1.2.0", { "package-lock.json": lockOf("1.2.0", "45.0.0") }));
  st = await ctx.make().check({ force: true });
  assert.deepEqual(st.blockers.map((b) => [b.code, b.command]), [["needs-install", "git checkout -- package-lock.json && git pull --ff-only && npm install"]]);
  // 那条手动命令里的 git pull 跟的是当前分支的上游：在稳定版上就是 origin/stable。
  sh(ctx.install, "pull", "-q", "--ff-only");
  assert.deepEqual([branchOf(ctx.install), pkgVersion(ctx.install)], ["stable", "1.2.0"]);
});

test("开发版通道：与只认 main 的时候一样；多出来的只有一次只读的 ls-remote——远端有了稳定版就在状态里说一声", async (t) => {
  const ctx = setup(t);
  const rec = recordingGit(ctx);
  const service = ctx.make({ git: rec.git });
  // 发布方还没建 stable。
  let st = await service.check({ force: true });
  assert.deepEqual([st.branch, st.channel, st.stableAvailable, st.available, st.error], ["main", "main", false, false, null]);
  assert.deepEqual(rec.net(), [["fetch", "+refs/heads/main:refs/remotes/origin/main"], ["ls-remote", "refs/heads/stable"]]);
  const v11 = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.canApply, st.remoteVersion, st.behind, st.blockers, st.stableAvailable], [true, true, "1.1.0", 1, [], false]);

  // 发布方建了 stable（停在 v1.0.0）：开发版的安装照旧收到 main 上的 v1.1.0，只是知道了远端有稳定版。
  promote(ctx, headOf(ctx.install));
  st = await service.check({ force: true });
  assert.deepEqual([st.channel, st.stableAvailable, st.available, st.canApply, st.remoteVersion], ["main", true, true, true, "1.1.0"]);
  assert.equal(hasRef(ctx.install, "refs/remotes/origin/stable"), false, "只是问了一句，没有把稳定版取下来");
  assert.deepEqual(await service.apply(), { ok: true, fromVersion: "1.0.0", toVersion: "1.1.0", respawn: false });
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["main", v11]);

  // 那一问没问到（网络抖了一下）：不算这次检查的错，结论沿用上一次的。
  const flaky = recordingGit(ctx, (args) => (args[0] === "ls-remote" ? { ok: false, code: 128, stdout: "", stderr: "fatal: unable to access", timedOut: false } : null));
  const again = ctx.make({ git: flaky.git });
  assert.deepEqual([(await again.check({ force: true })).error, (await again.status()).stableAvailable], [null, false], "从没问到过、本地也没有这条引用 → 当作没有");
  let fail = false;
  const sometimes = recordingGit(ctx, (args) => (fail && args[0] === "ls-remote" ? { ok: false, code: 128, stdout: "", stderr: "fatal: unable to access", timedOut: false } : null));
  const kept = ctx.make({ git: sometimes.git });
  assert.equal((await kept.check({ force: true })).stableAvailable, true);
  fail = true;
  st = await kept.check({ force: true });
  assert.deepEqual([st.stableAvailable, st.error], [true, null]);

  // main 取不下来时不再多问那一句（它多半同样失败，白等一次）。
  const offline = recordingGit(ctx, (args) => (args[0] === "fetch" ? { ok: false, code: 128, stdout: "", stderr: "fatal: unable to access 'x': Could not resolve host: github.com", timedOut: false } : null));
  st = await ctx.make({ git: offline.git }).check({ force: true });
  assert.equal(st.error.code, "offline");
  assert.deepEqual(offline.net(), [["fetch", "+refs/heads/main:refs/remotes/origin/main"]]);

  // 远端有稳定版之后才 clone 的安装：clone 已经把 origin/stable 记下来了，不联网也知道。
  const later = path.join(ctx.base, "install-later");
  sh(ctx.base, "clone", "-q", ctx.remote, later);
  const fresh = await createSelfUpdateService({ rootDir: later, runtimeDir: path.join(ctx.base, "runtime-later"), git: createGit({ root: later, env: GIT_ENV }), smoke: async () => ({ ok: true }), env: {} }).status();
  assert.deepEqual([fresh.channel, fresh.stableAvailable, fresh.checkedAt], ["main", true, null]);
});

test("不在任何通道的分支上：照旧不自动更新；远端有稳定版时说明里把两条通道都提到", async (t) => {
  const ctx = setup(t);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  sh(ctx.install, "checkout", "-q", "-b", "dev");
  let st = await ctx.make().check({ force: true });
  assert.deepEqual([st.branch, st.channel, st.available, st.canApply], ["dev", null, true, false]);
  assert.deepEqual(st.blockers, [{ code: "branch", message: "当前不在 main 分支（在 dev 上），不自动更新。切回 main 后再试" }]);

  promote(ctx, headOf(ctx.install));
  st = await ctx.make().check({ force: true });
  assert.deepEqual([st.channel, st.stableAvailable], [null, true]);
  assert.deepEqual(st.blockers, [{ code: "branch", message: "当前不在 stable 或 main 分支（在 dev 上），不自动更新。切回其中一个后再试" }]);
  await assert.rejects(ctx.make().apply(), (e) => e.status === 409 && e.code === "branch");
  // 换通道也不替人离开自己切过去的分支。
  const before = worktreeState(ctx.install);
  await assert.rejects(ctx.make().switchChannel("stable"), (e) => e.status === 409 && e.code === "branch" && /当前在 dev 上，不在 stable \/ main 任何一条更新通道里，没有切换/.test(e.message));
  sh(ctx.install, "checkout", "-q", "--detach");
  await assert.rejects(ctx.make().switchChannel("main"), (e) => e.code === "branch" && /当前在 游离的提交 上/.test(e.message));
  sh(ctx.install, "checkout", "-q", "dev");
  assert.deepEqual(worktreeState(ctx.install), before);
});

test("远端的稳定版分支没了：稳定版的安装说明原因并给出改跟开发版的命令，不拿本地留着的旧引用当更新", async (t) => {
  const ctx = setupStable(t);
  const service = ctx.make();
  promote(ctx, publish(ctx.pub, "1.1.0", { "app.txt": "two\n" }));
  assert.equal((await service.check({ force: true })).available, true);

  sh(ctx.pub, "push", "-q", "origin", ":refs/heads/stable");
  const st = await service.check({ force: true });
  assert.deepEqual([st.supported, st.channel, st.available, st.canApply, st.stableAvailable], [true, "stable", false, false, false]);
  assert.deepEqual(st.error, { code: "no-channel-branch", message: "远端没有 stable 分支（发布方还没有发布过稳定版，或撤掉了它），这份安装现在收不到更新。要改跟开发版，在终端进安装目录执行 npm run update -- --channel main" });
  await assert.rejects(service.apply(), (e) => e.status === 502 && e.code === "no-channel-branch");
  assert.equal(pkgVersion(ctx.install), "1.0.0");
  assert.equal(ctx.smokes.length, 0);

  // 照着说明换到开发版：本地留着的 main（clone 时的 v1.0.0）快进到远端的 v1.1.0。
  const res = await service.switchChannel("main");
  assert.deepEqual([res.changed, res.fromBranch, res.branch, res.toVersion], [true, "stable", "main", "1.1.0"]);
  assert.deepEqual([branchOf(ctx.install), pkgVersion(ctx.install)], ["main", "1.1.0"]);
});

test("换通道：开发版 → 稳定版（回到稳定版当前的那一版）→ 开发版；先自检目标版本，本地已有的同名分支只快进", async (t) => {
  const ctx = setupAware(t);
  const v1 = headOf(ctx.install);
  promote(ctx, v1);
  const v11 = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const rec = recordingGit(ctx);
  const service = ctx.make({ git: rec.git, env: { [RESPAWN_ENV]: "1" } });
  await service.apply();
  const applied = marker(ctx);
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["main", v11]);

  rec.calls.length = 0;
  let res = await service.switchChannel("stable");
  assert.deepEqual(res, { ok: true, changed: true, channel: "stable", branch: "stable", fromBranch: "main", fromVersion: "1.1.0", toVersion: "1.0.0", codeChanged: true, respawn: true });
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install), pkgVersion(ctx.install)], ["stable", v1, "1.0.0"]);
  assert.equal(fs.readFileSync(path.join(ctx.install, "app.txt"), "utf8"), "one\n");
  assert.equal(sh(ctx.install, "rev-parse", "--abbrev-ref", "stable@{upstream}"), "origin/stable", "新建的本地分支跟着远端那条，手动 git pull 也对");
  assert.deepEqual(rec.net(), [["fetch", "+refs/heads/stable:refs/remotes/origin/stable"]], "只取要去的那条分支");
  assert.equal(ctx.smokes.at(-1).version, "1.0.0", "切之前自检的是稳定版的那个提交");
  assert.equal(fs.existsSync(ctx.smokes.at(-1).tree), false, "自检用的临时工作树已删除");
  assert.equal(sh(ctx.install, "worktree", "list").split("\n").length, 1);
  assert.equal(sh(ctx.install, "rev-parse", "refs/heads/main"), v11, "原来的 main 分支原样留着");
  assert.deepEqual(marker(ctx), applied, "换通道不写更新记录");
  assert.ok(ctx.logs.some((line) => /switched update channel main -> stable/.test(line)));

  // 换完之后：状态里是新的通道；main 上的 v1.1.0 不再提示；--rollback 管的是上一次「更新」，这里不适用。
  let st = await service.status();
  assert.deepEqual([st.branch, st.channel, st.stableAvailable, st.localVersion], ["stable", "stable", true, "1.0.0"]);
  st = await service.check({ force: true });
  assert.deepEqual([st.available, st.remoteVersion], [false, "1.0.0"]);
  await assert.rejects(service.rollback(), (e) => e.code === "moved");

  // 已经在这条通道上：什么都不做，也不联网。
  rec.calls.length = 0;
  const smokesBefore = ctx.smokes.length;
  res = await service.switchChannel("stable");
  assert.deepEqual([res.ok, res.changed, res.codeChanged, res.fromVersion, res.toVersion], [true, false, false, "1.0.0", "1.0.0"]);
  assert.deepEqual([rec.net(), ctx.smokes.length], [[], smokesBefore]);

  // 换回开发版：本地的 main 还停在 v1.1.0，远端又推了 v1.2.0 → 快进到 v1.2.0。
  const v12 = publish(ctx.pub, "1.2.0", { "app.txt": "three\n" });
  res = await service.switchChannel("main");
  assert.deepEqual([res.changed, res.channel, res.fromBranch, res.fromVersion, res.toVersion, res.codeChanged], [true, "main", "stable", "1.0.0", "1.2.0", true]);
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install), sh(ctx.install, "rev-parse", "refs/heads/stable")], ["main", v12, v1]);
  assert.equal(ctx.smokes.at(-1).version, "1.2.0");

  // 两条通道正好在同一个提交上：只换分支，代码没变，不用自检。
  promote(ctx, v12);
  const smokesNow = ctx.smokes.length;
  res = await service.switchChannel("stable");
  assert.deepEqual([res.changed, res.codeChanged, res.fromVersion, res.toVersion, ctx.smokes.length], [true, false, "1.2.0", "1.2.0", smokesNow]);
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["stable", v12]);
});

test("工作台开着时在终端里换了通道：服务手里的状态到下一次检查才跟上（定时那一轮或手动「检查更新」），之后跟的就是新通道的分支", async (t) => {
  const ctx = setupAware(t);
  promote(ctx, headOf(ctx.install));
  const rec = recordingGit(ctx);
  const timers = fakeTimers();
  const server = ctx.make({ git: rec.git, timers, now: timers.now }); // 开着的工作台
  assert.deepEqual([(await server.check({ force: true })).channel, (await server.status()).stableAvailable], ["main", true]);
  // 另一个进程（终端里的 npm run update -- --channel stable）换了通道。
  assert.equal((await ctx.make().switchChannel("stable")).changed, true);
  assert.equal((await server.status()).channel, "main", "状态接口不重新看安装目录：还是上一次检查时的结论");

  rec.calls.length = 0;
  server.start();
  timers.tick();
  let st = await settled(server);
  assert.deepEqual([st.branch, st.channel, st.error], ["stable", "stable", null]);
  assert.deepEqual(rec.net(), [["fetch", "+refs/heads/stable:refs/remotes/origin/stable"]], "下一轮取的已经是新通道的分支");
  server.stop();

  // 手动「检查更新」同样立刻跟上（换回开发版）。
  await ctx.make().switchChannel("main");
  st = await server.check({ force: true });
  assert.deepEqual([st.branch, st.channel], ["main", "main"]);
});

test("换通道没成的各种情况：都不动工作区——没有这条通道 / 远端没有稳定版 / 取不到远端 / 有改动 / 自检没过 / Node 不够 / 依赖变了", async (t) => {
  const ctx = setupAware(t);
  const service = ctx.make();
  const before = worktreeState(ctx.install);
  const refused = async (run, check) => {
    await assert.rejects(run, check);
    assert.deepEqual(worktreeState(ctx.install), before);
  };

  await refused(service.switchChannel("beta"), (e) => e.status === 400 && e.code === "bad-channel" && /可选：stable \/ main/.test(e.message));
  await refused(service.switchChannel(undefined), (e) => e.code === "bad-channel");
  // 发布方还没建 stable。
  await refused(service.switchChannel("stable"), (e) => e.status === 409 && e.code === "no-channel-branch" && e.message === "远端还没有 stable 分支（发布方还没有发布过稳定版），没有切换");
  assert.equal(hasRef(ctx.install, "refs/heads/stable"), false);

  // 稳定版停在 v1.1.0（它的 package.json 要 Node 24+，锁文件里 electron 也换了）；这份安装还在 main 的 v1.0.0 上。
  const pkgOf = (version, node) => `${JSON.stringify({ name: "app", version, engines: { node } }, null, 2)}\n`;
  promote(ctx, publish(ctx.pub, "1.1.0", { "package.json": pkgOf("1.1.0", ">=24.0.0 <27"), "package-lock.json": lockOf("1.1.0", "45.0.0") }));
  await refused(ctx.make({ nodeVersion: "22.12.0" }).switchChannel("stable"), (e) => e.status === 409 && e.code === "node-version" && e.message === "稳定版（stable） v1.1.0 需要 Node.js 24.0 及以上、低于 27，这台电脑上是 22.12.0：切过去会启动不了，没有切换");
  // 桌面模式下对的是启动器报上来的那个 Node（与更新同一道预检）。
  await refused(ctx.make({ env: { [LAUNCHER_NODE_ENV]: "22.12.0" }, nodeVersion: "24.4.1" }).switchChannel("stable"), (e) => e.code === "node-version");
  await refused(ctx.make({ nodeVersion: "24.4.1" }).switchChannel("stable"), (e) => {
    assert.deepEqual([e.status, e.code, e.command], [409, "needs-install", "git checkout -- package-lock.json && git checkout stable && git pull --ff-only && npm install"]);
    assert.match(e.message, /^稳定版（stable） v1\.1\.0 的依赖和现在这一版不一样，需要在终端里切：/);
    return true;
  });
  assert.equal(ctx.smokes.length, 0, "核对没过的都走不到自检");

  // 稳定版推进到 v1.2.0（依赖与 v1.0.0 相同、不再限定 Node）。
  promote(ctx, publish(ctx.pub, "1.2.0", { "package.json": `${JSON.stringify({ name: "app", version: "1.2.0" }, null, 2)}\n`, "package-lock.json": lockOf("1.2.0"), "notes.txt": "from upstream\n" }));
  fs.writeFileSync(path.join(ctx.install, "app.txt"), "local edit\n");
  const dirty = { ...before, status: sh(ctx.install, "status", "--porcelain") };
  await assert.rejects(service.switchChannel("stable"), (e) => e.status === 409 && e.code === "dirty" && /app\.txt/.test(e.message) && /没有切换，免得把改动冲掉/.test(e.message));
  assert.deepEqual(worktreeState(ctx.install), dirty);
  sh(ctx.install, "checkout", "-q", "--", "app.txt");

  await refused(ctx.make({ smoke: async () => ({ ok: false, detail: "SyntaxError: boom" }) }).switchChannel("stable"), (e) => e.status === 422 && e.code === "smoke-failed" && /^稳定版（stable） v1\.2\.0 自检没有通过，没有切换，现在的版本照常可用。.*SyntaxError: boom/.test(e.message));
  // 自检期间工作区被改动：放弃。
  const racing = ctx.make({ smoke: async () => { fs.writeFileSync(path.join(ctx.install, "app.txt"), "edited during smoke\n"); return { ok: true }; } });
  await assert.rejects(racing.switchChannel("stable"), (e) => e.status === 409 && e.code === "changed");
  sh(ctx.install, "checkout", "-q", "--", "app.txt");
  assert.deepEqual(worktreeState(ctx.install), before);

  // 没入库的文件挡住切换：git 自己什么都不动，说明里点出文件名与下一步；本地也没有多出一条 stable 分支。
  fs.writeFileSync(path.join(ctx.install, "notes.txt"), "mine\n");
  await assert.rejects(service.switchChannel("stable"), (e) => {
    assert.deepEqual([e.status, e.code], [409, "checkout-failed"]);
    assert.equal(e.message, "没有切换成功：这些没入库的文件会被覆盖：notes.txt。把它们移到别处或删掉后再试一次");
    return true;
  });
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install), hasRef(ctx.install, "refs/heads/stable")], [before.branch, before.head, false]);
  assert.equal(fs.readFileSync(path.join(ctx.install, "notes.txt"), "utf8"), "mine\n", "那个文件原样留着");
  fs.rmSync(path.join(ctx.install, "notes.txt"));

  // 同时只做一件事：更新进行中不换通道，反过来也一样。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = ctx.make({ smoke: async () => { await gate; return { ok: true }; } });
  const switching = slow.switchChannel("stable");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(slow.switchChannel("main"), (e) => e.status === 409 && e.code === "busy");
  await assert.rejects(slow.apply(), (e) => e.status === 409 && e.code === "busy");
  release();
  assert.equal((await switching).toVersion, "1.2.0");
  assert.deepEqual([branchOf(ctx.install), pkgVersion(ctx.install)], ["stable", "1.2.0"]);

  // 远端连不上：取不到要去的那条分支就不切（不拿本地留着的旧引用凑合）。
  fs.renameSync(ctx.remote, `${ctx.remote}.gone`);
  const onStable = worktreeState(ctx.install);
  await assert.rejects(service.switchChannel("main"), (e) => e.status === 502 && /^没能取到远端的 main 分支，没有切换：/.test(e.message));
  assert.deepEqual(worktreeState(ctx.install), onStable);
});

test("换通道：本地同名分支上有自己的提交 → 不切；不支持的安装方式 / 这次没读出状态 → 如实说明", async (t) => {
  const ctx = setupAware(t);
  promote(ctx, headOf(ctx.install));
  // 本地有一条自己提交过东西的 stable 分支。
  sh(ctx.install, "checkout", "-q", "-b", "stable");
  fs.writeFileSync(path.join(ctx.install, "mine.txt"), "mine\n");
  sh(ctx.install, "add", "mine.txt");
  sh(ctx.install, "commit", "-q", "-m", "local on stable");
  const mine = headOf(ctx.install);
  sh(ctx.install, "checkout", "-q", "main");
  const before = worktreeState(ctx.install);
  await assert.rejects(ctx.make().switchChannel("stable"), (e) => e.status === 409 && e.code === "diverged" && e.message === "本地的 stable 分支上有远端没有的提交，没法直接快进，没有切换");
  assert.deepEqual(worktreeState(ctx.install), before);
  assert.equal(sh(ctx.install, "rev-parse", "refs/heads/stable"), mine, "那条分支上的提交还在");

  await assert.rejects(ctx.make({ packaged: true }).switchChannel("stable"), (e) => e.status === 409 && e.code === "unsupported" && /app:update/.test(e.message));
  const stuck = async (args, opts) => (args.join(" ") === "rev-parse --show-toplevel" ? { ok: false, code: null, stdout: "", stderr: "", timedOut: true } : createGit({ root: ctx.install, env: GIT_ENV })(args, opts));
  await assert.rejects(ctx.make({ git: stuck }).switchChannel("stable"), (e) => e.status === 409 && e.code === "inspect-failed" && /没有切换；请再试一次/.test(e.message));
  sh(ctx.install, "remote", "remove", "origin");
  await assert.rejects(ctx.make().switchChannel("stable"), (e) => e.status === 409 && e.code === "unsupported" && /origin/.test(e.message));
  assert.deepEqual(worktreeState(ctx.install), before);
});

test("换通道：自检期间那条远端分支被别处取到了更新的提交 → 放弃；切过去的只能是自检过的那个提交", async (t) => {
  const ctx = setupAware(t);
  promote(ctx, headOf(ctx.install)); // 稳定版在 v1.0.0
  const v11 = publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  await ctx.make().apply(); // 这份安装在 main 的 v1.1.0 上
  const before = worktreeState(ctx.install);
  // 自检 v1.0.0 的那十几秒里：发布方把稳定版推进到了 v1.1.0，又被别处的 git fetch 取了下来。
  const racing = ctx.make({
    smoke: async () => {
      promote(ctx, v11);
      sh(ctx.install, "fetch", "-q", "origin", "+refs/heads/stable:refs/remotes/origin/stable");
      return { ok: true };
    },
  });
  await assert.rejects(racing.switchChannel("stable"), (e) => e.status === 409 && e.code === "changed");
  assert.deepEqual(worktreeState(ctx.install), before);
  assert.equal(hasRef(ctx.install, "refs/heads/stable"), false);
  // 再试一次就是按最新的位置来（这回两条通道在同一个提交上）。
  const res = await ctx.make().switchChannel("stable");
  assert.deepEqual([res.changed, res.codeChanged, branchOf(ctx.install), headOf(ctx.install)], [true, false, "stable", v11]);
});

test("换通道：那条通道现在指着一个还不认识更新通道的版本（早于 v2.62）→ 不换——换过去就收不到更新、也换不回来", async (t) => {
  // CHANNEL_AWARE_FILE 指的就是 channel.mjs 自己在仓库里的位置（挪了文件这里会先红）。
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  assert.equal(fs.realpathSync(path.join(repoRoot, CHANNEL_AWARE_FILE)), fs.realpathSync(fileURLToPath(new URL("./channel.mjs", import.meta.url))));

  const ctx = setup(t); // v1.0.0 里还没有 channel.mjs
  promote(ctx, headOf(ctx.install)); // 稳定版被（手动）放到了它上面
  const v11 = publish(ctx.pub, "1.1.0", { ...CHANNEL_AWARE, "app.txt": "two\n" }); // main 上的 v1.1.0 才认识更新通道
  await ctx.make().apply();
  const before = worktreeState(ctx.install);
  const smokes = ctx.smokes.length;
  await assert.rejects(ctx.make().switchChannel("stable"), (e) => e.status === 409 && e.code === "too-old" && e.message === "稳定版（stable） v1.0.0 还不认识更新通道（早于 v2.62）：换过去之后收不到更新、也换不回来，没有切换");
  assert.deepEqual([worktreeState(ctx.install), ctx.smokes.length], [before, smokes]);

  // 稳定版推进到认识更新通道的 v1.1.0 之后就能换了（这里两条通道在同一个提交上）；之后再换回来也行。
  promote(ctx, v11);
  assert.deepEqual([(await ctx.make().switchChannel("stable")).changed, branchOf(ctx.install)], [true, "stable"]);
  assert.deepEqual([(await ctx.make().switchChannel("main")).changed, branchOf(ctx.install)], [true, "main"]);
});

test("换通道：锁文件被 npm install 改写过不算有改动，切之前先还原；依赖不一样时给的那条手动命令照着做确实能切过去", async (t) => {
  const ctx = setupAware(t);
  const v1 = headOf(ctx.install);
  promote(ctx, v1);
  publish(ctx.pub, "1.1.0", { "app.txt": "two\n" });
  const service = ctx.make();
  await service.apply();
  const lockPath = path.join(ctx.install, "package-lock.json");
  fs.writeFileSync(lockPath, fs.readFileSync(lockPath, "utf8").replace('"lockfileVersion": 3', '"lockfileVersion": 3,\n  "rewrittenByNpm": true'));
  assert.match(sh(ctx.install, "status", "--porcelain", "--untracked-files=no"), /package-lock\.json/);
  const res = await service.switchChannel("stable");
  assert.deepEqual([res.changed, res.toVersion], [true, "1.0.0"]);
  assert.deepEqual([branchOf(ctx.install), headOf(ctx.install)], ["stable", v1]);
  assert.equal(fs.readFileSync(lockPath, "utf8"), lockOf("1.0.0"), "锁文件是稳定版入库的那份");
  assert.equal(sh(ctx.install, "status", "--porcelain", "--untracked-files=no"), "");
  assert.ok(ctx.logs.some((line) => /restored package-lock\.json/.test(line)));

  // 另一台：稳定版与开发版依赖不同，工具不代劳；把说明里那条命令的 git 部分原样执行（npm install 不在这里跑）。
  const other = setupAware(t);
  promote(other, headOf(other.install));
  publish(other.pub, "1.1.0", { "package-lock.json": lockOf("1.1.0", "45.0.0") });
  sh(other.install, "pull", "-q", "--ff-only"); // 依赖变了的版本一键更新本来就不给：这台是手动拉到 v1.1.0 的
  assert.equal(pkgVersion(other.install), "1.1.0");
  let command = "";
  await assert.rejects(other.make().switchChannel("stable"), (e) => { command = e.command; return e.code === "needs-install"; });
  const steps = command.split(" && ");
  assert.deepEqual(steps, ["git checkout -- package-lock.json", "git checkout stable", "git pull --ff-only", "npm install"]);
  for (const step of steps.slice(0, 3)) sh(other.install, ...step.split(" ").slice(1));
  assert.deepEqual([branchOf(other.install), pkgVersion(other.install), sh(other.install, "rev-parse", "--abbrev-ref", "stable@{upstream}")], ["stable", "1.0.0", "origin/stable"]);
});

// ---------------------------------------------------------------------------
// 重启后的守护进程交接
// ---------------------------------------------------------------------------

function resumeFixture(t, { handoff = "pending", appliedAt = Date.now(), toVersion = "1.1.0" } = {}) {
  const ctx = setup(t);
  fs.mkdirSync(ctx.runtimeDir, { recursive: true });
  writeJson(path.join(ctx.runtimeDir, MARKER_FILE), { from: "a".repeat(40), to: "b".repeat(40), fromVersion: "1.0.0", toVersion, appliedAt, handoff });
  const upgrades = [];
  const run = (info, { upgradeResult = { status: 200, body: { ok: true } } } = {}) => ctx.make().resumeAfterRestart({
    getBuildInfo: async () => (typeof info === "function" ? info() : info),
    upgrade: async (data) => { upgrades.push(data); return upgradeResult; },
    sleep: async () => {},
  });
  return { ctx, upgrades, run };
}
const infoOf = (version, dataPlane) => ({ monitorRunning: { build: { version } }, dataPlane });

test("重启后：守护进程还是旧代码 → 自动平滑交接一次并记下结果", async (t) => {
  const f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor", "proxy"], handoffSupported: true, channelRunning: true, snapshotAvailable: true })), "done");
  assert.deepEqual(f.upgrades, [{ components: ["supervisor"] }], "只交接守护进程，代理留给人点");
  assert.equal(marker(f.ctx).handoff, "done");
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"] })), null, "做过了不再做");
  assert.equal(f.upgrades.length, 1);
});

test("重启后：不需要 / 做不了 / 没成功 各有记录，都不抛错", async (t) => {
  let f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: [], channelRunning: true, snapshotAvailable: true })), "not-needed");
  assert.equal(f.upgrades.length, 0);

  f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"], channelRunning: false })), "not-needed", "通道没在跑：下次启动就是新代码");

  f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"], handoffSupported: false, snapshotAvailable: true })), "unsupported");

  f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"], snapshotAvailable: true }), { upgradeResult: { status: 200, body: { ok: false, error: "pid changed" } } }), "failed");
  assert.match(marker(f.ctx).handoffDetail, /pid changed/);

  f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"], snapshotAvailable: true }), { upgradeResult: { status: 409, body: { error: "in flight" } } }), null, "别处正在交接：不抢");
  assert.equal(marker(f.ctx).handoff, "pending");

  f = resumeFixture(t);
  assert.equal(await f.run(async () => { throw new Error("boom"); }), null);
});

test("重启后：还没跑到新版本 → 留着下次；记录太旧 → 作废；快照迟迟不来 → 交给横幅", async (t) => {
  let f = resumeFixture(t);
  assert.equal(await f.run(infoOf("1.0.0", { pending: ["supervisor"], snapshotAvailable: true })), null);
  assert.equal(marker(f.ctx).handoff, "pending");
  assert.equal(f.upgrades.length, 0);

  f = resumeFixture(t, { appliedAt: Date.now() - RESUME_WINDOW_MS - 1000 });
  assert.equal(await f.run(infoOf("1.1.0", { pending: ["supervisor"], snapshotAvailable: true })), "expired");
  assert.equal(f.upgrades.length, 0);

  // 快照先不可用、之后才有：等到了再交接。
  f = resumeFixture(t);
  let calls = 0;
  const flaky = () => {
    calls += 1;
    return infoOf("1.1.0", calls < 4 ? { pending: ["supervisor", "proxy"], snapshotAvailable: false } : { pending: ["supervisor"], snapshotAvailable: true });
  };
  assert.equal(await f.run(flaky), "done");

  f = resumeFixture(t);
  let clock = Date.now();
  const stuck = f.ctx.make({ now: () => clock }).resumeAfterRestart({
    getBuildInfo: async () => infoOf("1.1.0", { pending: ["supervisor"], snapshotAvailable: false }),
    upgrade: async () => { throw new Error("不该调用"); },
    sleep: async () => { clock += 60_000; },
  });
  assert.equal(await stuck, "timeout");
});

test("安装包没有热更新包时保留下载入口；查不到不冲掉上一次的结论", async (t) => {
  const ctx = setup(t);
  let calls = 0;
  let latest = { version: "99.0.0", url: "https://github.com/a/b/releases/tag/v99.0.0" };
  const releaseLookup = async () => {
    calls += 1;
    if (latest instanceof Error) throw latest;
    return latest;
  };
  const service = ctx.make({ packaged: true, releaseLookup });
  const first = await service.status();
  assert.deepEqual([first.kind, first.available, calls], ["packaged", false, 0], "界面第一次取现状不联网");
  const found = await service.check({ force: true });
  assert.deepEqual([found.supported, found.available, found.canApply, found.remoteVersion, found.releaseUrl, calls], [false, true, false, "99.0.0", latest.url, 1]);
  assert.equal(found.blockers[0].code, "packaged");
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "unsupported");

  latest = new Error("fetch failed");
  const failed = await service.check({ force: true });
  assert.deepEqual([failed.available, failed.releaseUrl, failed.error.code], [true, "https://github.com/a/b/releases/tag/v99.0.0", "release-check-failed"]);

  latest = { version: "0.0.1", url: "https://github.com/a/b/releases/tag/v0.0.1" };
  const older = await service.check({ force: true });
  assert.deepEqual([older.available, older.releaseUrl, older.error], [false, null, null]);
  latest = null;
  assert.equal((await service.check({ force: true })).available, false, "没有正式版 / 私有仓库");

  const timers = fakeTimers();
  const scheduled = ctx.make({ packaged: true, releaseLookup, timers });
  latest = { version: "99.0.0", url: "https://github.com/a/b/releases/tag/v99.0.0" };
  const before = calls;
  scheduled.start();
  timers.tick();
  const st = await settled(scheduled);
  assert.deepEqual([calls - before, st.available], [1, true], "定时那一轮也问一次发布页");
  scheduled.stop();
});

test("安装包有热更新包：点击更新异步启动任务，进度可查询，重复点击被拒绝", async (t) => {
  const ctx = setup(t);
  let job = null;
  let stopped = false;
  const latest = { version: "99.0.0", url: "https://github.com/a/b/releases/tag/v99.0.0", update: { url: "asset", sha256: "a".repeat(64), size: 100 } };
  const packageUpdater = {
    supported: true,
    status: () => job,
    start: (release) => {
      assert.equal(release, latest);
      job = { running: true, phase: "download" };
      return { ok: true, pending: true, toVersion: release.version };
    },
    stop: () => { stopped = true; },
  };
  const service = ctx.make({ packaged: true, releaseLookup: async () => latest, packageUpdater });
  const found = await service.check({ force: true });
  assert.equal(found.canApply, true);
  assert.equal(found.supported, true);
  assert.equal((await service.apply()).pending, true);
  const running = await service.status();
  assert.equal(running.packageUpdate.phase, "download");
  assert.equal(running.canApply, false);
  await assert.rejects(service.apply(), (e) => e.status === 409 && e.code === "busy");
  service.stop();
  assert.equal(stopped, true);
});
