// W5 控制台易用性：新增后端字段/端点的单元测试（反向端口建议、首次运行引导、离线安装向导平台门控）。
import assert from "node:assert/strict";
import test from "node:test";

import { suggestReversePort } from "./reverse-port.mjs";
import { assessSetup, buildSetupCommand, createOnboardingProbe } from "./onboarding.mjs";
import { readSshConfigUser } from "./ssh-config-user.mjs";
import { createServerRegistry } from "./server-registry.mjs";
import { createBootstrapRunner, describeBootstrapFailure } from "./bootstrap-steps.mjs";

test("suggestReversePort: 避开已配置远端/本地端口、基准 7891 与探测到的监听端口", () => {
  const merged = {
    servers: [
      { id: "server-01", remotePort: 7891, localPort: 8888 },
      { id: "a", remotePort: 7892, localPort: 8892 },
      { id: "b", remotePort: 7894, localPort: 8893 }, // 7893 的本地端口 8893 已被 b 占用
    ],
  };
  assert.deepEqual(suggestReversePort(merged), { remotePort: 7895, localPort: 8895 });
  assert.deepEqual(suggestReversePort(merged, { extraInUse: [7895, 7896] }), { remotePort: 7897, localPort: 8897 });
  // 为 a 重新分配：a 自己的旧端口不算"别人的"，但作为出问题的端口仍需避开
  assert.deepEqual(suggestReversePort(merged, { excludeServerId: "a", avoid: [7892] }), { remotePort: 7895, localPort: 8895 });
  assert.deepEqual(suggestReversePort({}), { remotePort: 7892, localPort: 8892 });
});

test("assessSetup: 个人层缺失 → needs-setup；全禁用 → no-servers；损坏不误报", () => {
  const servers = [{ id: "server-01", host: "myserver", remotePort: 7892 }];
  assert.equal(assessSetup({ localState: "missing", merged: { servers } }).state, "needs-setup");
  // 修复轮：个人层存在但主服务器拿不到 sshUser（条目/全局/~/.ssh/config 都没有）→ partial（与 launch 一致）
  assert.equal(assessSetup({ merged: { servers } }).state, "partial");
  assert.equal(assessSetup({ merged: { servers, sshUser: "kai" } }).state, "ready");
  assert.equal(assessSetup({ merged: { servers: [{ id: "x", disabled: true }] } }).state, "no-servers");
  assert.equal(assessSetup({ localState: "missing", merged: { servers, _localConfigError: true } }).state, "ready");
});

test("createOnboardingProbe: TTL 内复用结果，探测异常按已配置处理", () => {
  let calls = 0;
  let t = 0;
  const probe = createOnboardingProbe({ exists: () => { calls += 1; return false; }, getMerged: () => ({ servers: [] }), ttlMs: 1000, now: () => t });
  assert.equal(probe(), "needs-setup");
  t = 500;
  probe();
  assert.equal(calls, 1);
  t = 2000;
  probe();
  assert.equal(calls, 2);
  const broken = createOnboardingProbe({ exists: () => { throw new Error("EACCES"); }, getMerged: () => ({ servers: [{ id: "a" }] }) });
  assert.equal(broken(), "ready");
});

function makeRegistry({ execFileImpl, fixtureMode = false, personal = {} } = {}) {
  const merged = {
    servers: [
      { id: "server-01", host: "myserver", source: "team", remotePort: 7891, localPort: 8888 },
      { id: "box", host: "10.0.0.8", sshUser: "ubuntu", source: "personal", remotePort: 7892, localPort: 8892 },
    ],
  };
  return createServerRegistry({
    localConfigPath: "/local.json",
    readPersonalConfigImpl: () => ({ revision: 3, ...personal }),
    getMergedConfig: () => merged,
    execFileImpl,
    fixtureMode,
  });
}

test("server-registry.list: suggestedPorts 只是本机配置参考值，标明未核对远端占用", () => {
  const list = makeRegistry().list();
  assert.equal(list.suggestedPorts.remotePort, 7893);
  assert.equal(list.suggestedPorts.localPort, 8893);
  assert.equal(list.suggestedPorts.checked, false, "不发 SSH → 不能当可直接采用的建议");
  assert.match(list.suggestedPorts.warning, /未核对服务器上的端口占用/);
  assert.ok(Array.isArray(list.servers), "旧字段保持");
});

// 模拟远端 survey（port-registry.mjs）的回显：缺省"登记目录不存在"，走回落分配（只看 ss -ltn 监听）；
// 登记目录可用时的路径见 server-registry-claim.test.mjs。
function surveyStdout({ ss = [], registry = "absent" } = {}) {
  const lines = [`REGISTRY=${registry}`, "ME=ubuntu", "LISTEN-BEGIN", "State Recv-Q Send-Q Local Address:Port Peer Address:Port"];
  for (const p of ss) lines.push(`LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:*`);
  lines.push("LISTEN-END");
  return `${lines.join("\n")}\n`;
}

test("server-registry.suggestPort: ss 监听端口并入保留集，一次 SSH 往返且只走 BatchMode", async () => {
  const calls = [];
  const registry = makeRegistry({
    execFileImpl: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: surveyStdout({ ss: [7893, 7894] }), stderr: "" };
    },
  });
  const result = await registry.suggestPort("box");
  assert.equal(calls.length, 1);
  assert.equal(result.probed, true);
  assert.deepEqual(result.listening, [7893, 7894]);
  assert.deepEqual(result.current, { remotePort: 7892, localPort: 8892 });
  assert.deepEqual(result.suggested, { remotePort: 7895 }, "只换远端端口，本机代理端口不动");
  assert.equal(result.registered, false, "登记目录不存在 → 回落旧分配并标明未登记");
  assert.match(result.warning, /未登记/);
  assert.equal(result.revision, 3);
  assert.equal(calls[0].cmd, "ssh");
  assert.ok(calls[0].args.includes("BatchMode=yes"));
  assert.match(calls[0].args.at(-1), /ss -ltn/);
  assert.doesNotMatch(calls[0].args.at(-1), /mkdir|set -C|rm -f/, "建议端口是只读探测（survey，不领取）");
});

test("server-registry.suggestPort: 监听端口解析范围与建议区间一致（8xxx 段也避开）", async () => {
  const registry = makeRegistry({
    personal: {},
    execFileImpl: async () => ({ code: 0, stdout: surveyStdout({ ss: [7893, 8100, 8891, 9000] }), stderr: "" }),
  });
  const result = await registry.suggestPort("box");
  assert.deepEqual(result.listening, [7893, 8100, 8891], "7891..8891 都算，区间外（9000）不算");
});

test("server-registry.suggestPort: SSH 失败 / fixture → 不给自动建议并给出明确警告", async () => {
  const failed = await makeRegistry({
    execFileImpl: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.8 port 22: Connection timed out" }),
  }).suggestPort("box");
  assert.equal(failed.probed, false);
  assert.equal(failed.probeError, "timeout");
  assert.equal(failed.suggested, null, "探测失败不退化为纯配置建议");
  assert.match(failed.warning, /未核对服务器上的端口占用/);
  const registry = makeRegistry({ execFileImpl: async () => ({ code: 0, stdout: surveyStdout(), stderr: "" }) });
  await assert.rejects(() => registry.suggestPort("nope"), (err) => err.status === 404);
  const fixture = await makeRegistry({ fixtureMode: true, execFileImpl: async () => { throw new Error("不应调用"); } }).suggestPort("box");
  assert.equal(fixture.probeError, "fixture");
  assert.equal(fixture.suggested, null);
});

test("server-registry.suggestPort: SSH 占调度器槽位并在结束（含失败）后释放", async () => {
  const events = [];
  const acquireSshSlot = async ({ hostKey }) => { events.push(`acquire:${hostKey}`); return () => events.push("release"); };
  const ok = makeRegistry({ execFileImpl: async () => { events.push("ssh"); return { code: 0, stdout: surveyStdout(), stderr: "" }; } });
  await ok.suggestPort("box", { acquireSshSlot });
  assert.deepEqual(events, ["acquire:10.0.0.8", "ssh", "release"]);
  events.length = 0;
  const boom = makeRegistry({ execFileImpl: async () => { events.push("ssh"); throw new Error("spawn failed"); } });
  await boom.suggestPort("box", { acquireSshSlot });
  assert.deepEqual(events, ["acquire:10.0.0.8", "ssh", "release"]);
});

const bootstrapConfig = () => ({
  activeServerId: "server-01",
  servers: [{ id: "server-01", host: "myserver", remotePort: 7891 }],
  agents: [],
});

test("bootstrap: win32 上构建步骤禁用并说明原因，runStep 拒绝执行", async () => {
  let executed = 0;
  const runner = createBootstrapRunner({
    config: bootstrapConfig(),
    execFileImpl: async () => { executed += 1; return { stdout: "" }; },
    acquireSshSlot: async () => () => {},
    platform: "win32",
  });
  const build = runner.getState().steps.find((s) => s.id === "build-tarball");
  assert.equal(build.disabled, true);
  assert.match(build.disabledReason, /Mac\/Linux/);
  const res = await runner.runStep("build-tarball");
  assert.equal(res.started, false);
  assert.equal(executed, 0);
  const mac = createBootstrapRunner({ config: bootstrapConfig(), execFileImpl: async () => ({}), acquireSshSlot: async () => () => {}, platform: "darwin" });
  assert.equal(mac.getState().steps.find((s) => s.id === "build-tarball").disabled, false);
});

test("bootstrap: SSH 失败映射为归因 + 下一步，而不是截断的 stderr", async () => {
  const runner = createBootstrapRunner({
    config: bootstrapConfig(),
    execFileImpl: async () => { throw Object.assign(new Error("Command failed"), { stderr: "user@myserver: Permission denied (publickey)." }); },
    acquireSshSlot: async () => () => {},
    platform: "darwin",
  });
  await runner.runStep("detect-arch");
  const step = runner.getState().steps.find((s) => s.id === "detect-arch");
  assert.equal(step.status, "fail");
  assert.equal(step.failureCode, "auth");
  assert.match(step.summary, /认证失败/);
  assert.match(step.summary, /npm run setup/);
  assert.equal(describeBootstrapFailure("random crash").code, null);
});

test("修复轮 assessSetup: sshUser 可来自 ~/.ssh/config 的 Host 别名；个人层缺失但别名可解析 → ready（仅提示）", () => {
  const servers = [{ id: "server-01", host: "myserver", remotePort: 7892 }];
  const resolveSshUser = (h) => (h === "myserver" ? "kai" : "");
  assert.equal(assessSetup({ merged: { servers }, resolveSshUser }).state, "ready");
  assert.deepEqual(assessSetup({ localState: "missing", merged: { servers }, resolveSshUser }), { state: "ready", reason: "no-local-config-ssh-ok", host: "myserver", sshUser: "kai" });
  assert.equal(assessSetup({ localState: "missing", merged: { servers } }).state, "needs-setup");
  // server-01 被屏蔽（我不在这个集群）→ 不需要 sshUser
  assert.equal(assessSetup({ merged: { servers: [{ id: "server-01", disabled: true }, { id: "p1" }] } }).state, "ready");
  // 解析器抛异常按"解析不出"处理
  assert.equal(assessSetup({ merged: { servers }, resolveSshUser: () => { throw new Error("x"); } }).state, "partial");
  assert.equal(assessSetup({ localState: "invalid", merged: { servers } }).reason, "invalid-local-config");
});

test("修复轮 createOnboardingProbe: resolveSshUser 透传", () => {
  const probe = createOnboardingProbe({ exists: () => true, getMerged: () => ({ servers: [{ id: "server-01", host: "myserver", remotePort: 7892 }] }), resolveSshUser: () => "kai" });
  assert.equal(probe(), "ready");
});

test("修复轮 readSshConfigUser: 读盘失败按空，能读到则按 Host 解析", () => {
  assert.equal(readSshConfigUser("myserver", { readFile: () => { throw new Error("ENOENT"); } }), "");
  assert.equal(readSshConfigUser("myserver", { readFile: () => "Host myserver\n  User kai\n" }), "kai");
});

test("修复轮 buildSetupCommand: 个人层在仓库根 → npm run setup；否则带覆盖变量（含引号转义）", () => {
  assert.equal(buildSetupCommand({ localConfigPath: "/repo/config.local.json", appRoot: "/repo", platform: "darwin" }), "npm run setup");
  assert.equal(buildSetupCommand({ localConfigPath: "/repo/config.local.json", appRoot: "/repo/", platform: "darwin" }), "npm run setup");
  assert.equal(
    buildSetupCommand({ localConfigPath: "/Users/a/Library/Application Support/codex-tunnel-monitor/config.local.json", appRoot: "/Applications/X.app/Contents/Resources/app", platform: "darwin" }),
    "CODEX_MONITOR_LOCAL_CONFIG_PATH='/Users/a/Library/Application Support/codex-tunnel-monitor/config.local.json' npm run setup",
  );
  assert.match(buildSetupCommand({ localConfigPath: "/x/it's/c.json", appRoot: "/repo", platform: "linux" }), /'\/x\/it'\\''s\/c\.json'/);
  assert.equal(buildSetupCommand({ localConfigPath: "C:\\Repo\\config.local.json", appRoot: "c:\\repo", platform: "win32" }), "npm run setup");
  assert.match(buildSetupCommand({ localConfigPath: "D:\\data\\config.local.json", appRoot: "C:\\repo", platform: "win32" }), /^\$env:CODEX_MONITOR_LOCAL_CONFIG_PATH=/);
  assert.equal(buildSetupCommand({}), "npm run setup");
});
