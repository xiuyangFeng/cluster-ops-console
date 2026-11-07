import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { utf8LocaleEnv } from "../lib/process-registry.mjs";
import { createDesktopContext } from "./context.mjs";
import { createMonitorProcess } from "./monitor-process.mjs";

const silent = { log() {}, warn() {}, error() {} };

function makeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) { const t = { fn, ms }; pending.push(t); return t; },
  };
}

function makeHarness({ platform = "darwin", execResults = {}, onExec, ready = true, rootDir = "/app/集群", eventLog = null } = {}) {
  const ctx = createDesktopContext({ rootDir, env: {}, platform, homeDir: "/Users/t" });
  const calls = [];
  const spawned = [];
  const recorded = [];
  const execLog = [];
  const killed = [];
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = 5000 + spawned.length;
    spawned.push({ cmd, args, opts, child });
    return child;
  };
  const execFileAsync = async (cmd, args, opts) => {
    execLog.push({ cmd, args, opts });
    onExec?.(cmd, args);
    const key = `${cmd} ${args.join(" ")}`;
    const result = execResults[key];
    if (result instanceof Error || result === undefined) throw result || new Error(`exit 1: ${key}`);
    return { stdout: result };
  };
  const registry = {
    readMeta: () => null,
    stopProcess: async (name) => { calls.push(`stopProcess ${name}`); return { stopped: true }; },
    recordProcess: (name, pid, meta) => recorded.push({ name, pid, meta }),
  };
  Object.assign(ctx.actions, {
    startCredentialVault: async () => { calls.push("startCredentialVault"); return { url: "http://127.0.0.1:40000" }; },
    markTrayDown: (tooltip) => calls.push(`markTrayDown ${tooltip}`),
  });
  const timers = makeTimers();
  const readyCalls = [];
  const fakeFetch = () => {};
  const monitor = createMonitorProcess({
    ctx,
    registry,
    spawn,
    execFileAsync,
    waitForReady: async (opts) => { readyCalls.push(opts); return ready; },
    fetchImpl: fakeFetch,
    platform,
    env: { PATH: "/usr/bin", AUTH_TOKEN: "tok" },
    execPath: "/Applications/Console.app/Contents/MacOS/Console",
    pid: 42,
    killProcess: (pid, sig) => killed.push([pid, sig]),
    timers,
    logger: silent,
    eventLog,
  });
  return { ctx, state: ctx.state, calls, spawned, recorded, execLog, killed, timers, readyCalls, fakeFetch, monitor, registry };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("startMonitorServer：先起保管库，再以纯 node 模式 spawn monitor-server 并登记 pid", async () => {
  const h = makeHarness();
  await h.monitor.startMonitorServer();
  assert.deepEqual(h.calls, ["startCredentialVault"]);
  assert.equal(h.spawned.length, 1);
  const { cmd, args, opts, child } = h.spawned[0];
  assert.equal(cmd, "/Applications/Console.app/Contents/MacOS/Console");
  assert.deepEqual(args, ["work/monitor/monitor-server.mjs"]);
  assert.equal(opts.cwd, h.ctx.rootDir);
  assert.equal(opts.stdio, "inherit");
  const paths = h.ctx.runtimePaths;
  assert.deepEqual(opts.env, {
    PATH: "/usr/bin",
    AUTH_TOKEN: "tok",
    ELECTRON_RUN_AS_NODE: "1",
    PORT: "8877",
    CODEX_MONITOR_APP_ROOT: paths.appRoot,
    CODEX_MONITOR_DATA_DIR: paths.dataRoot,
    CODEX_MONITOR_CONFIG_PATH: paths.configPath,
    CODEX_MONITOR_LOCAL_CONFIG_PATH: paths.localConfigPath,
    CODEX_MONITOR_VAULT_URL: "http://127.0.0.1:40000",
    CODEX_MONITOR_VAULT_TOKEN: h.ctx.vaultToken,
  });
  assert.equal(h.state.serverProcess, child);
  assert.deepEqual(h.recorded, [{
    name: "monitor-server",
    pid: 5000,
    meta: { command: "node work/monitor/monitor-server.mjs", args: ["work/monitor/monitor-server.mjs"], cwd: h.ctx.rootDir, parentPid: 42 },
  }]);
});

test("startMonitorServer：端口回收期间退出清理已开始 → 绝不再 spawn", async () => {
  const h = makeHarness({
    onExec: () => { h.state.isQuitting = true; },
  });
  await h.monitor.startMonitorServer();
  assert.equal(h.spawned.length, 0);
  assert.equal(h.state.serverProcess, null);
});

test("端口被占：先按注册表校验停止旧 monitor-server，再做 rootDir 限定的模式兜底", async () => {
  const h = makeHarness({ execResults: { "lsof -i:8877": "node 123" } });
  h.registry.readMeta = (name) => (name === "monitor-server" ? { pid: 123 } : null);
  await h.monitor.reclaimMonitorPortIfNeeded();
  assert.deepEqual(h.calls, ["stopProcess monitor-server"]);
  assert.deepEqual(h.execLog.map((e) => e.cmd), ["lsof", "pgrep"]);
  assert.deepEqual(h.execLog[1].args, ["-f", "work/monitor/monitor-server.mjs"]);
});

test("pkillScopedByPattern：只杀命令行含本 rootDir 的进程，跳过自己；ps 带 UTF-8 区域", async () => {
  // createDesktopContext 会 path.resolve(rootDir)（Windows 上补盘符），命令行夹具按同一规则构造。
  const ownScript = path.join(path.resolve("/app/集群"), "work/monitor/channel-supervisor.mjs");
  const h = makeHarness({
    execResults: {
      "pgrep -f work/monitor/channel-supervisor.mjs": "42\n100\n200\n300\n",
      "ps -o command= -p 100": `node ${ownScript}\n`,
      "ps -o command= -p 200": "node /other/checkout/work/monitor/channel-supervisor.mjs\n",
      // 300：进程已消失（ps 非零退出）
    },
  });
  await h.monitor.pkillScopedByPattern("work/monitor/channel-supervisor.mjs");
  assert.deepEqual(h.killed, [[100, "SIGTERM"]]);
  const psCalls = h.execLog.filter((e) => e.cmd === "ps");
  assert.deepEqual(psCalls.map((e) => e.args.at(-1)), ["100", "200", "300"], "自己的 pid 不查也不杀");
  // ps 的区域设置跟宿主平台走（utf8LocaleEnv：darwin = en_US.UTF-8，其它 POSIX = C.UTF-8）。
  for (const call of psCalls) assert.equal(call.opts.env.LC_ALL, utf8LocaleEnv().LC_ALL);
});

test("pkillScopedByPattern：win32 没有安全的模式兜底，直接跳过", async () => {
  const h = makeHarness({ platform: "win32" });
  await h.monitor.pkillScopedByPattern("work/monitor/channel-supervisor.mjs");
  assert.deepEqual(h.execLog, []);
  assert.deepEqual(h.killed, []);
});

test("崩溃自愈：指数退避重启；连续 5 次失败停止自愈并把托盘置红", async () => {
  const h = makeHarness({ ready: false });
  await h.monitor.startMonitorServer();
  const delays = [];
  for (let i = 0; i < 4; i += 1) {
    h.state.serverProcess.emit("exit", 1, null);
    assert.equal(h.state.serverProcess, null);
    const timer = h.timers.pending.shift();
    delays.push(timer.ms);
    assert.equal(h.state.serverRestartTimer, timer);
    await timer.fn();
    assert.equal(h.state.serverRestartTimer, null);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  assert.equal(h.readyCalls.length, 4);
  assert.deepEqual(h.readyCalls[0], { url: "http://127.0.0.1:8877/api/status-lite", token: h.ctx.authToken, intervalMs: 250, timeoutMs: 15000, fetchImpl: h.fakeFetch });
  h.state.serverProcess.emit("exit", null, "SIGKILL");
  assert.deepEqual(h.timers.pending, []);
  assert.deepEqual(h.calls.at(-1), "markTrayDown 监控服务反复崩溃，已停止自愈");
});

test("崩溃自愈：重启后就绪则失败计数清零", async () => {
  const h = makeHarness({ ready: true });
  await h.monitor.startMonitorServer();
  for (let i = 0; i < 3; i += 1) {
    h.state.serverProcess.emit("exit", 1, null);
    const timer = h.timers.pending.shift();
    assert.equal(timer.ms, 1000, "每次都从基础退避开始");
    await timer.fn();
  }
});

test("崩溃自愈：显式退出 / 主动清理期间退出不重启；等待期间开始清理则放弃重启", async () => {
  const h = makeHarness();
  await h.monitor.startMonitorServer();
  h.state.serverExiting = true;
  h.state.serverProcess.emit("exit", 0, null);
  assert.deepEqual(h.timers.pending, []);

  const h2 = makeHarness();
  await h2.monitor.startMonitorServer();
  h2.state.serverProcess.emit("exit", 1, null);
  h2.state.isQuitting = true;
  await h2.timers.pending.shift().fn();
  await flush();
  assert.equal(h2.spawned.length, 1, "定时器到点时已在退出：不再 spawn");
});

function makeEventLog() {
  const rows = [];
  const push = (level) => (message, fields) => rows.push({ level, message, ...fields });
  return { rows, info: push("info"), warn: push("warn"), error: push("error") };
}

test("desktop 日志：异常退出、重启就绪、连续失败停止自动重启都写结构化事件（origin desktop-shell）", async () => {
  const eventLog = makeEventLog();
  const h = makeHarness({ ready: false, eventLog });
  await h.monitor.startMonitorServer();
  for (let i = 0; i < 4; i += 1) {
    h.state.serverProcess.emit("exit", 1, null);
    await h.timers.pending.shift().fn();
  }
  h.state.serverProcess.emit("exit", null, "SIGKILL");
  assert.deepEqual(eventLog.rows.map((r) => [r.level, r.event, r.failures, r.code, r.signal]), [
    ["warn", "monitor-exited", 1, 1, null],
    ["warn", "monitor-exited", 2, 1, null],
    ["warn", "monitor-exited", 3, 1, null],
    ["warn", "monitor-exited", 4, 1, null],
    ["error", "monitor-restart-give-up", 5, null, "SIGKILL"],
  ]);
  assert.ok(eventLog.rows.every((r) => r.origin === "desktop-shell"));
  assert.equal(eventLog.rows.at(-1).message, "监控服务连续 5 次异常退出，已停止自动重启");

  const ok = makeEventLog();
  const h2 = makeHarness({ ready: true, eventLog: ok });
  await h2.monitor.startMonitorServer();
  h2.state.serverProcess.emit("exit", 1, null);
  await h2.timers.pending.shift().fn();
  assert.deepEqual(ok.rows.map((r) => r.event), ["monitor-exited", "monitor-restarted"]);
});

test("拉起本身失败（ChildProcess error）：接住并写 desktop 日志，不变成未捕获异常", async () => {
  const eventLog = makeEventLog();
  const h = makeHarness({ eventLog });
  await h.monitor.startMonitorServer();
  const err = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  assert.doesNotThrow(() => h.spawned[0].child.emit("error", err));
  assert.deepEqual(eventLog.rows.map((r) => [r.level, r.event, r.code]), [["error", "monitor-spawn-failed", "ENOENT"]]);
});

test("没注入事件日志器（旧入口 / 测试）：照常工作", async () => {
  const h = makeHarness();
  await h.monitor.startMonitorServer();
  assert.doesNotThrow(() => h.state.serverProcess.emit("exit", 1, null));
  assert.doesNotThrow(() => h.spawned[0].child.emit("error", new Error("x")));
});
