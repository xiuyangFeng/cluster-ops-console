import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP_SERVER_BEGIN_MARKER,
  APP_SERVER_END_MARKER,
  APP_SERVER_READ_COMMAND,
  APP_SERVER_RECOVERY_COMMAND,
  APP_SERVER_RESTART_COMMAND,
  appServerWarning,
  isUnmanagedRestartFailure,
  parseAppServerSection,
  summarizeAppServer,
} from "./app-server.mjs";
import { createCodexAppServerService } from "./app-server-service.mjs";
import { codexAdapter } from "./codex.mjs";

const SERVER = { id: "server-01", host: "myserver", remotePort: 7893, localPort: 8888 };
const FAIL = (code) => `ssh exit ${code}`;

function serviceCtx({ replies = [], config = { agents: [{ id: "codex", kind: "codex" }] }, server = SERVER } = {}) {
  const calls = [];
  let release = 0;
  let acquire = 0;
  const queue = [...replies];
  const service = createCodexAppServerService({
    getConfig: async () => ({ servers: [server], activeServerId: server.id, ...config }),
    getMainServerConfig: () => server,
    sshArgsFor: () => ["myserver"],
    execFileCmd: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return queue.shift() || { code: 0, stdout: "", stderr: "" };
    },
    probeSshFailureReason: (code) => FAIL(code),
    now: () => 1234,
  });
  return {
    service,
    calls,
    acquireSshSlot: async () => {
      acquire += 1;
      return () => { release += 1; };
    },
    counters: () => ({ acquire, release }),
  };
}

test("标记段解析：只认 pid/proxy 行，空段与缺失标记区分开", () => {
  assert.equal(parseAppServerSection(null), null);
  assert.deepEqual(parseAppServerSection(""), []);
  assert.deepEqual(parseAppServerSection("pid=123 proxy=7891\npid=456 proxy=none\npid=789 proxy=abc\nbogus"), [
    { pid: 123, proxyPort: 7891 },
    { pid: 456, proxyPort: null },
  ]);
  assert.deepEqual(parseAppServerSection(`pid=1 proxy=7893\npid=1 proxy=7891`), [{ pid: 1, proxyPort: 7893 }], "同一 pid 只留第一条");
});

test("状态：没读到 / 没运行 / 一致 / 旧端口 / 没代理", () => {
  assert.deepEqual(summarizeAppServer(null, 7893), { running: null, expectedPort: 7893, instances: [], mismatch: false, noProxy: false });
  assert.deepEqual(summarizeAppServer([], 7893), { running: false, expectedPort: 7893, instances: [], mismatch: false, noProxy: false });
  const ok = summarizeAppServer([{ pid: 1, proxyPort: 7893 }], 7893);
  assert.deepEqual([ok.running, ok.mismatch, ok.noProxy, appServerWarning(ok)], [true, false, false, null]);
  const stale = summarizeAppServer([{ pid: 1, proxyPort: 7891 }], 7893);
  assert.deepEqual([stale.running, stale.mismatch, stale.noProxy], [true, true, false]);
  assert.match(appServerWarning(stale), /旧代理端口 7891.*当前应为 7893/);
  const noProxy = summarizeAppServer([{ pid: 1, proxyPort: null }], 7893);
  assert.deepEqual([noProxy.running, noProxy.mismatch, noProxy.noProxy], [true, false, true]);
  assert.match(appServerWarning(noProxy), /没有走隧道代理/);
  const mixed = summarizeAppServer([{ pid: 1, proxyPort: 7891 }, { pid: 2, proxyPort: null }], 7893);
  assert.deepEqual([mixed.mismatch, mixed.noProxy], [true, true]);
  assert.match(appServerWarning(mixed), /7891/);
});

test("告警不该带出代理地址（口令）与无关进程；未配置端口时不判漂移", () => {
  const stale = summarizeAppServer([{ pid: 7, proxyPort: 7891 }], 7893);
  assert.doesNotMatch(appServerWarning(stale), /http|@|password/i);
  assert.equal(appServerWarning(summarizeAppServer([{ pid: 7, proxyPort: 7891 }], null)), null);
  assert.equal(appServerWarning({ running: false }), null);
  assert.equal(isUnmanagedRestartFailure("Error: app server is running but is not managed by codex app-server daemon"), true);
  assert.equal(isUnmanagedRestartFailure("Permission denied"), false);
});

test("远端命令：只读脚本与重启命令都是常量，经 sh -c 送达；重启先进入登录 shell", () => {
  assert.match(APP_SERVER_READ_COMMAND, /^sh -c /);
  assert.match(APP_SERVER_READ_COMMAND, /app-server --listen/);
  assert.match(APP_SERVER_READ_COMMAND, /proxy=\$\{v:-none\}/);
  assert.match(APP_SERVER_RESTART_COMMAND, /^sh -c /);
  assert.match(APP_SERVER_RESTART_COMMAND, /codex app-server daemon restart/);
  assert.match(APP_SERVER_RESTART_COMMAND, /bash -lc/);
  assert.match(APP_SERVER_RECOVERY_COMMAND, /daemon start/);
  assert.match(APP_SERVER_RECOVERY_COMMAND, /app-server-control\.sock/);
  assert.ok(APP_SERVER_BEGIN_MARKER.includes("APP_SERVER"));
  assert.ok(APP_SERVER_END_MARKER.includes("APP_SERVER"));
});

test("重启：托管 daemon 一次成功；SSH 槽位只占一次", async () => {
  const h = serviceCtx({ replies: [{ code: 0, stdout: "restarted\n", stderr: "" }] });
  const res = await h.service.restart({ serverId: "server-01" }, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual({ ok: res.ok, result: res.result, serverId: res.serverId, checkedAt: res.checkedAt }, { ok: true, result: "restarted", serverId: "server-01", checkedAt: 1234 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].cmd, "ssh");
  assert.match(h.calls[0].args.at(-1), /daemon restart/);
  assert.deepEqual(h.counters(), { acquire: 1, release: 1 });
});

test("重启：非托管 daemon 走收尾（停旧进程 + daemon start），结果记 recovered", async () => {
  const h = serviceCtx({
    replies: [
      { code: 1, stdout: "", stderr: "Error: app server is running but is not managed by codex app-server daemon" },
      { code: 0, stdout: "started\n", stderr: "" },
    ],
  });
  const res = await h.service.restart({}, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual([res.ok, res.result], [true, "recovered"]);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].args.at(-1), /app-server --listen/);
  assert.match(h.calls[1].args.at(-1), /daemon start/);
  assert.deepEqual(h.counters(), { acquire: 1, release: 1 });
});

test("重启：普通失败如实返回 failed；切服瞬间 / Codex 关掉 / 请求带别的服务器都拒绝且不发 SSH", async () => {
  const h = serviceCtx({ replies: [{ code: 255, stdout: "", stderr: "Permission denied (publickey)." }] });
  const failed = await h.service.restart({}, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual([failed.ok, failed.result, failed.error], [false, "failed", FAIL(255)]);

  const other = serviceCtx();
  await assert.rejects(() => other.service.restart({ serverId: "other" }, { acquireSshSlot: other.acquireSshSlot }), (err) => err.status === 409);
  assert.equal(other.calls.length, 0);

  const off = serviceCtx({ config: { agents: [] } });
  await assert.rejects(() => off.service.restart({}, { acquireSshSlot: off.acquireSshSlot }), (err) => err.status === 409);
  assert.equal(off.calls.length, 0);

  const noSlot = serviceCtx();
  await assert.rejects(() => noSlot.service.restart({}, {}), (err) => err.status === 503);
  assert.equal(noSlot.calls.length, 0);
});

test("doctor 探针顺带读回守护进程：旧端口 → warn + degraded，根因直说桌面端没有回复", async () => {
  const stdout = [
    "17 ok | 0 notes | 0 warn | 0 fail",
    "__CODEX_AUTH_BEGIN__",
    "__CODEX_AUTH_END__",
    APP_SERVER_BEGIN_MARKER,
    "pid=668325 proxy=7891",
    APP_SERVER_END_MARKER,
  ].join("\n");
  const calls = [];
  const ctx = {
    getConfig: async () => ({ servers: [SERVER], activeServerId: SERVER.id, agents: [{ id: "codex", kind: "codex" }] }),
    getMainServerConfig: () => SERVER,
    getProxyCredential: () => null,
    sshArgsFor: () => ["myserver"],
    probeSshFailureReason: FAIL,
    execFileCmd: async (_cmd, args) => {
      calls.push(args.at(-1));
      return { code: 0, stdout, stderr: "" };
    },
  };
  const result = await codexAdapter.probeSpecs(ctx).find((spec) => spec.id === "doctor").run();
  assert.equal(result.level, "warn", "漂移让 doctor 回到快节奏，端口一换就能尽快发现");
  assert.deepEqual(result.data.appServer, {
    running: true,
    expectedPort: 7893,
    instances: [{ pid: 668325, proxyPort: 7891 }],
    mismatch: true,
    noProxy: false,
  });
  assert.match(calls[0], /__CODEX_APP_SERVER_BEGIN__/);
  assert.match(calls[0], /app-server --listen/);
  assert.doesNotMatch(calls[0], /http:\/\/[^ ]*@/, "命令文本里没有代理地址 / 口令");
  const status = codexAdapter.buildStatus({ doctor: result.data, endpoint: { ok: true } });
  assert.deepEqual([status.health, status.ok], ["degraded", false]);
  assert.match(status.degradedReason, /旧代理端口 7891.*当前应为 7893.*没有回复/);
});

test("doctor 探针：守护进程端口一致 / 没连桌面端时都不改健康", async () => {
  const build = (appServerLines) => [
    "17 ok | 0 notes | 0 warn | 0 fail",
    "__CODEX_AUTH_BEGIN__",
    "__CODEX_AUTH_END__",
    APP_SERVER_BEGIN_MARKER,
    ...appServerLines,
    APP_SERVER_END_MARKER,
  ].join("\n");
  for (const lines of [["pid=1 proxy=7893"], []]) {
    const ctx = {
      getConfig: async () => ({ servers: [SERVER], activeServerId: SERVER.id, agents: [{ id: "codex", kind: "codex" }] }),
      getMainServerConfig: () => SERVER,
      getProxyCredential: () => null,
      sshArgsFor: () => ["myserver"],
      probeSshFailureReason: FAIL,
      execFileCmd: async () => ({ code: 0, stdout: build(lines), stderr: "" }),
    };
    const result = await codexAdapter.probeSpecs(ctx).find((spec) => spec.id === "doctor").run();
    assert.equal(result.level, "ok");
    const status = codexAdapter.buildStatus({ doctor: result.data, endpoint: { ok: true } });
    assert.deepEqual([status.health, status.appServer.running], ["ready", lines.length > 0]);
  }
});

test("重启：同一时刻只允许一个；没有反向端口时拒绝", async () => {
  let releaseExec;
  let markStarted;
  const gate = new Promise((resolve) => { releaseExec = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  let calls = 0;
  const service = createCodexAppServerService({
    getConfig: async () => ({ servers: [SERVER], activeServerId: SERVER.id, agents: [{ id: "codex", kind: "codex" }] }),
    getMainServerConfig: () => SERVER,
    sshArgsFor: () => ["myserver"],
    execFileCmd: async () => {
      calls += 1;
      markStarted();
      await gate;
      return { code: 0, stdout: "", stderr: "" };
    },
    probeSshFailureReason: FAIL,
  });
  const slot = async () => () => {};
  const first = service.restart({}, { acquireSshSlot: slot });
  await started;
  await assert.rejects(() => service.restart({}, { acquireSshSlot: slot }), (err) => err.status === 409);
  releaseExec();
  await first;
  assert.equal(calls, 1);

  const noPort = serviceCtx({ server: { id: "server-01", host: "myserver" } });
  await assert.rejects(() => noPort.service.restart({}, { acquireSshSlot: noPort.acquireSshSlot }), (err) => err.status === 409);
});
