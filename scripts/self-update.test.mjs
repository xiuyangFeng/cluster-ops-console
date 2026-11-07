// npm run update（scripts/self-update.mjs）：命令行入口只负责把服务的结论说成人话、给出退出码。
import assert from "node:assert/strict";
import test from "node:test";

import { runUpdateCli } from "./self-update.mjs";

function run(argv, service) {
  const lines = [];
  return runUpdateCli(argv, { service, log: (line) => lines.push(line) }).then((code) => ({ code, text: lines.join("\n") }));
}
const upToDate = { supported: true, available: false, localVersion: "2.58.1", error: null, blockers: [] };
const available = { supported: true, available: true, canApply: true, localVersion: "2.58.1", remoteVersion: "2.59.0", behind: 3, error: null, blockers: [] };

test("已是最新 → 0；有新版本 → 自检并更新，说明怎么生效与怎么回退", async () => {
  let res = await run([], { check: async () => upToDate });
  assert.equal(res.code, 0);
  assert.match(res.text, /已经是最新版本（v2\.58\.1）/);

  let applied = 0;
  res = await run([], { check: async () => available, apply: async () => { applied += 1; return { ok: true, fromVersion: "2.58.1", toVersion: "2.59.0" }; } });
  assert.equal(res.code, 0);
  assert.equal(applied, 1);
  assert.match(res.text, /有新版本 v2\.59\.0（当前 v2\.58\.1，落后 3 个提交）/);
  assert.match(res.text, /已更新到 v2\.59\.0/);
  assert.match(res.text, /重启界面/);
  assert.match(res.text, /--rollback/);
});

test("--check 只看不动；不能自动更新时逐条说明并返回 1", async () => {
  let applied = 0;
  const apply = async () => { applied += 1; };
  let res = await run(["--check"], { check: async () => available, apply });
  assert.equal(res.code, 0);
  assert.equal(applied, 0);

  res = await run(["--", "--check"], { check: async () => available, apply });
  assert.equal(res.code, 0, "npm run update -- --check 透传进来的 -- 不算参数");

  res = await run([], { check: async () => ({ ...available, canApply: false, blockers: [{ code: "dirty", message: "有改过但没提交的文件" }, { code: "needs-install", message: "这个版本改了依赖" }] }), apply });
  assert.equal(res.code, 1);
  assert.equal(applied, 0);
  assert.match(res.text, /有改过但没提交的文件/);
  assert.match(res.text, /这个版本改了依赖/);
});

test("不支持的安装方式 / 连不上 / 更新中途失败 → 1，原因打印出来", async () => {
  let res = await run([], { check: async () => ({ supported: false, unsupportedReason: "这个目录不是 git 仓库" }) });
  assert.equal(res.code, 1);
  assert.match(res.text, /不是 git 仓库/);

  res = await run([], { check: async () => ({ ...upToDate, error: { code: "offline", message: "连不上 GitHub" } }) });
  assert.equal(res.code, 1);
  assert.match(res.text, /连不上 GitHub/);
  assert.match(res.text, /没能确认有没有新版本/);

  res = await run([], { check: async () => available, apply: async () => { throw new Error("新版本 v2.59.0 自检没有通过，没有更新"); } });
  assert.equal(res.code, 1);
  assert.match(res.text, /自检没有通过/);
});

test("--rollback 回到上一版本，并说明退掉的那一版先跳过、想装回去用 --force；用法不对 → 2", async () => {
  let res = await run(["--rollback"], { rollback: async () => ({ ok: true, fromVersion: "2.59.0", toVersion: "2.58.1", skipped: true }) });
  assert.equal(res.code, 0);
  assert.match(res.text, /已回到 v2\.58\.1（刚才是 v2\.59\.0）/);
  assert.match(res.text, /v2\.59\.0 这一版先跳过.*发布方推送新的提交后恢复提示.*npm run update -- --force/);
  // 「跳过」没记成（写不了更新记录）：不说没做到的事。
  res = await run(["--rollback"], { rollback: async () => ({ ok: true, fromVersion: "2.59.0", toVersion: "2.58.1", skipped: false }) });
  assert.equal(res.code, 0);
  assert.doesNotMatch(res.text, /跳过|--force/);
  res = await run(["--rollback"], { rollback: async () => { throw new Error("没有可回退的更新记录"); } });
  assert.equal(res.code, 1);
  assert.match(res.text, /没有可回退的更新记录/);
  for (const argv of [["--bogus"], ["--check", "--rollback"], ["--force", "--check"]]) {
    res = await run(argv, {});
    assert.equal(res.code, 2, argv.join(" "));
    assert.equal(res.text, "用法: npm run update [-- --check | -- --rollback | -- --force | -- --channel stable|main]");
  }
});

test("回退后被跳过的那一版：不带参数不装并说明原因；--force 这一次不理会「跳过」", async () => {
  const calls = [];
  const skippedState = { ...available, canApply: false, blockers: [{ code: "skipped", message: "已回退到 v2.58.1，v2.59.0 这一版先跳过" }] };
  const service = {
    check: async (options) => { calls.push(["check", options]); return options.ignoreSkip ? available : skippedState; },
    apply: async (options) => { calls.push(["apply", options]); return { ok: true, fromVersion: "2.58.1", toVersion: "2.59.0" }; },
  };
  let res = await run([], service);
  assert.equal(res.code, 1);
  assert.match(res.text, /这一版先跳过/);
  assert.deepEqual(calls, [["check", { force: true, ignoreSkip: false }]], "没有去装");

  calls.length = 0;
  res = await run(["--", "--force"], service);
  assert.equal(res.code, 0);
  assert.match(res.text, /已更新到 v2\.59\.0/);
  assert.deepEqual(calls, [["check", { force: true, ignoreSkip: true }], ["apply", { ignoreSkip: true }]]);

  // --force 只越过「跳过」：别的原因照旧拦。
  calls.length = 0;
  res = await run(["--force"], { ...service, check: async () => ({ ...available, canApply: false, blockers: [{ code: "dirty", message: "有改过但没提交的文件" }] }) });
  assert.equal(res.code, 1);
  assert.match(res.text, /有改过但没提交的文件/);
  assert.deepEqual(calls, []);
});

test("检查时说的是真正要取的那条分支：稳定版取 stable，开发版与不在任何通道上时取 main；回退后的说法跟着通道走", async () => {
  const on = (channel) => ({ status: async () => ({ channel }), check: async () => upToDate });
  assert.match((await run([], on("stable"))).text, /^→ 检查更新（git fetch origin stable）…$/m);
  assert.match((await run(["--check"], on("main"))).text, /^→ 检查更新（git fetch origin main）…$/m);
  assert.match((await run([], on(null))).text, /^→ 检查更新（git fetch origin main）…$/m);
  // 读不到现状（更旧的服务、读状态出错的返回）也不耽误检查。
  assert.match((await run([], { status: async () => null, check: async () => upToDate })).text, /git fetch origin main/);

  const rolledBack = { rollback: async () => ({ ok: true, fromVersion: "2.63.0", toVersion: "2.62.0", skipped: true }) };
  assert.match((await run(["--rollback"], { ...rolledBack, status: async () => ({ channel: "stable" }) })).text, /v2\.63\.0 这一版先跳过.*发布方发布新的稳定版后恢复提示/);
  assert.match((await run(["--rollback"], { ...rolledBack, status: async () => ({ channel: "main" }) })).text, /v2\.63\.0 这一版先跳过.*发布方推送新的提交后恢复提示/);
});

test("--channel：换到稳定版 / 开发版，说清换到了哪一版、怎么生效、怎么换回去；已经在那条通道上 → 0，不重复说", async () => {
  const calls = [];
  const switching = (result) => ({ switchChannel: async (id) => { calls.push(id); return { ok: true, changed: true, channel: id, branch: id, fromBranch: id === "stable" ? "main" : "stable", codeChanged: true, respawn: false, ...result }; } });

  let res = await run(["--", "--channel", "stable"], switching({ fromVersion: "2.63.0", toVersion: "2.62.0" }));
  assert.equal(res.code, 0);
  assert.deepEqual(calls, ["stable"]);
  assert.match(res.text, /^→ 换到稳定版（stable）：先取远端的 stable 分支、自检那个版本，再切换（十几秒）…$/m);
  assert.match(res.text, /^✓ 已换到稳定版（stable）：v2\.63\.0 → v2\.62\.0。工作台开着的话，界面顶部会出现「新版本已安装」/m);
  assert.match(res.text, /点左上角的版本号 →「检查更新」/);
  assert.match(res.text, /^ {2}想换回开发版（main）：npm run update -- --channel main$/m);

  res = await run(["--channel=main"], switching({ fromVersion: "2.62.0", toVersion: "2.63.0" }));
  assert.equal(res.code, 0);
  assert.deepEqual(calls, ["stable", "main"]);
  assert.match(res.text, /^✓ 已换到开发版（main）：v2\.62\.0 → v2\.63\.0。/m);
  assert.match(res.text, /想换回稳定版（stable）：npm run update -- --channel stable/);

  // 两条通道在同一个提交上：不用重启，不说「新版本已安装」。
  res = await run(["--channel", "stable"], switching({ fromVersion: "2.62.0", toVersion: "2.62.0", codeChanged: false }));
  assert.match(res.text, /^✓ 已换到稳定版（stable）（v2\.62\.0）。两条通道现在是同一个提交，代码没有变化，不用重启。$/m);
  assert.doesNotMatch(res.text, /新版本已安装/);
  // 版本号相同但不是同一个提交：横幅不会出现（它只看版本号），所以直说要重启。
  res = await run(["--channel", "stable"], switching({ fromVersion: "2.62.0", toVersion: "2.62.0", codeChanged: true }));
  assert.match(res.text, /^✓ 已换到稳定版（stable）（v2\.62\.0）。版本号相同、代码有差别：重启工作台后生效。$/m);
  assert.doesNotMatch(res.text, /新版本已安装/);

  res = await run(["--channel", "stable"], switching({ changed: false, codeChanged: false, fromVersion: "2.62.0", toVersion: "2.62.0" }));
  assert.equal(res.code, 0);
  assert.match(res.text, /^✓ 已经在稳定版（stable）上，不用切换。$/m);
  assert.doesNotMatch(res.text, /想换回|检查更新」/);
});

test("--channel：没换成 → 1 并说明原因；没有这条通道 / 写法不对 / 和别的参数混用 → 2，什么都不做", async () => {
  let res = await run(["--channel", "stable"], { switchChannel: async () => { throw Object.assign(new Error("远端还没有 stable 分支（发布方还没有发布过稳定版），没有切换"), { status: 409, code: "no-channel-branch" }); } });
  assert.equal(res.code, 1);
  assert.match(res.text, /^✗ 远端还没有 stable 分支（发布方还没有发布过稳定版），没有切换$/m);

  let touched = 0;
  const service = { switchChannel: async () => { touched += 1; }, check: async () => { touched += 1; }, rollback: async () => { touched += 1; }, status: async () => { touched += 1; } };
  for (const argv of [["--channel"], ["--channel="], ["--channel", "beta"], ["--channel=beta"], ["--channel", "--check"], ["--channel", "stable", "--check"], ["--check", "--channel", "stable"], ["--channel", "stable", "main"], ["--rollback", "--channel=stable"]]) {
    res = await run(argv, service);
    assert.equal(res.code, 2, argv.join(" "));
    assert.equal(res.text, "用法: npm run update [-- --check | -- --rollback | -- --force | -- --channel stable|main]", argv.join(" "));
  }
  assert.equal(touched, 0);
});
