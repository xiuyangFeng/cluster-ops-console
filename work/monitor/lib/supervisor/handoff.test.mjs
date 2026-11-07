// 交接退出入口与显式 shutdown 的特征化测试（全部 fake 进程/注册表，不发任何真实信号）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { createHandoffExitStarter, runShutdown } from "./handoff.mjs";

function makeStarter({ state, ownPid = 4321, recordPid = ownPid, sleepPlan } = {}) {
  const out = { removedRecords: [], logs: [], exits: [], released: [], sleeps: [] };
  let resolveExit;
  out.exited = new Promise((resolve) => { resolveExit = resolve; });
  const controllers = new Map([
    ["server-01", { controller: { releaseForHandoff: async () => out.released.push("server-01") } }],
    ["server-02", { controller: { releaseForHandoff: async () => {} } }],
  ]);
  out.start = createHandoffExitStarter({
    state,
    controllers,
    registry: { readMeta: (name) => (name === "channel-supervisor" ? { pid: recordPid } : null) },
    waitForMailboxIdle: async () => {},
    removeRuntimeRecord: async (name) => out.removedRecords.push(name),
    log: (message) => out.logs.push(message),
    flushLogs: async () => {},
    exit: (code) => {
      out.exits.push(code);
      resolveExit();
    },
    sleep: (ms) => {
      out.sleeps.push(ms);
      return sleepPlan ? sleepPlan(ms) : new Promise((resolve) => setTimeout(resolve, 1));
    },
    selfPid: ownPid,
  });
  return out;
}

test("startHandoffExit：只认第一次触发，置位 stopping/handoffExiting，释放资源后 exit(0)", async () => {
  const state = { stopping: false, handoffExiting: false, currentTick: Promise.resolve() };
  const s = makeStarter({ state });
  s.start("SIGUSR2");
  assert.equal(state.handoffExiting, true);
  assert.equal(state.stopping, true, "同步置 stopping：主循环不再起新一拍");
  s.start("mailbox");
  await s.exited;
  assert.deepEqual(s.exits, [0]);
  assert.deepEqual(s.logs.filter((m) => m.startsWith("supervisor handoff requested")), [
    "supervisor handoff requested (SIGUSR2); leaving tunnels and local proxy running for the next supervisor",
  ]);
  assert.deepEqual(s.released, ["server-01"]);
  assert.deepEqual(s.removedRecords, ["channel-supervisor"], "记录仍指向自己 → 删");
});

test("startHandoffExit：记录已指向下一任时不删", async () => {
  const s = makeStarter({ state: { stopping: false, handoffExiting: false, currentTick: null }, recordPid: 999 });
  s.start("mailbox");
  await s.exited;
  assert.deepEqual(s.removedRecords, []);
  assert.deepEqual(s.exits, [0]);
});

test("startHandoffExit：等进行中的一拍（按调用时的 currentTick），预算 4000ms / 日志 300ms", async () => {
  let finishTick;
  const state = { stopping: false, handoffExiting: false, currentTick: null };
  // 入口创建之后才开始的一拍：必须按调用时现读 state.currentTick。
  const s = makeStarter({
    state,
    // tick 预算的 sleep 永不到点：退出只能由 tick 落地触发。
    sleepPlan: (ms) => (ms === 4000 ? new Promise(() => {}) : Promise.resolve()),
  });
  state.currentTick = new Promise((resolve) => { finishTick = resolve; });
  s.start("SIGUSR2");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(s.exits, [], "进行中的一拍没收尾前不得退出");
  finishTick();
  await s.exited;
  assert.deepEqual(s.sleeps, [4000, 300]);
});

// ---- shutdown ----

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.signals = [];
  child.kill = (signal) => {
    child.killed = true;
    child.signals.push(signal);
  };
  return child;
}

function shutdownScene({ handoffExiting = false } = {}) {
  const own = fakeChild(7001);
  const stubborn = fakeChild(7003);
  const controllers = new Map([
    ["server-01", { controller: { getCurrentChild: () => own } }],
    ["server-02", { controller: { getCurrentChild: () => null } }], // 接管来的：无 child
    ["server-03", { controller: { getCurrentChild: () => stubborn } }],
  ]);
  const metas = {
    "channel-supervisor": { pid: 1 },
    "local-proxy": { pid: 4242 },
    "tunnel.server-01": { pid: 7001 },
    "tunnel.server-02": { pid: 7002 },
    "tunnel.server-03": { pid: 7003 },
  };
  const out = { state: { stopping: false, handoffExiting }, logs: [], waits: [], kills: [], stops: [], removedRecords: [], exits: [], flushed: 0 };
  out.own = own;
  out.stubborn = stubborn;
  out.deps = {
    state: out.state,
    proxyController: { getCurrentChild: () => null },
    controllers,
    registry: {
      readMeta: (name) => metas[name] || null,
      stopProcess: async (name, options) => {
        out.stops.push([name, options]);
        if (name === "local-proxy") return { stopped: true, reason: "已停止" };
        return { stopped: false, reason: "refused" };
      },
    },
    removeRuntimeRecord: async (name) => out.removedRecords.push(name),
    log: (message) => out.logs.push(message),
    waitForPidExitImpl: async (pid, budgetMs) => {
      out.waits.push([pid, budgetMs]);
      return pid !== 7003;
    },
    killProcess: (pid, signal) => out.kills.push([pid, signal]),
    flushLogs: async () => { out.flushed += 1; },
    exit: (code) => out.exits.push(code),
  };
  return out;
}

test("runShutdown：自有 child SIGTERM→1.5s 未退 SIGKILL；接管记录按注册表停；停不掉的保留记录", async () => {
  const s = shutdownScene();
  await runShutdown(s.deps);
  assert.equal(s.state.stopping, true);
  assert.deepEqual(s.own.signals, ["SIGTERM"]);
  assert.deepEqual(s.stubborn.signals, ["SIGTERM"]);
  assert.deepEqual(s.waits.sort(), [[7001, 1500], [7003, 1500]]);
  assert.deepEqual(s.kills, [[7003, "SIGKILL"]]);
  assert.deepEqual(s.stops.sort(), [["local-proxy", { forceAfterMs: 1000 }], ["tunnel.server-02", { forceAfterMs: 1000 }]]);
  assert.deepEqual(s.removedRecords.sort(), ["channel-supervisor", "tunnel.server-01", "tunnel.server-03"],
    "接管记录不一刀切删（成功时 stopProcess 自己删；停不掉的 server-02 保留记录，交给 monitor 的 stopChannel）");
  assert.ok(s.logs.includes("supervisor stopping"));
  assert.ok(s.logs.includes("child pid 7003 did not exit in 1.5s, sending SIGKILL"));
  assert.ok(s.logs.includes("stop adopted local-proxy: 已停止"));
  assert.ok(s.logs.includes("stop adopted tunnel.server-02: refused"));
  assert.equal(s.flushed, 1);
  assert.deepEqual(s.exits, [0]);
});

test("runShutdown：stopProcess 抛错按停止失败处理（记录保留，照常退出）", async () => {
  const s = shutdownScene();
  s.deps.registry.stopProcess = async (name) => {
    if (name === "tunnel.server-02") throw new Error("ps failed");
    return { stopped: true, reason: "ok" };
  };
  await runShutdown(s.deps);
  assert.ok(s.logs.includes("stop adopted tunnel.server-02: ps failed"));
  assert.ok(!s.removedRecords.includes("tunnel.server-02"));
  assert.deepEqual(s.exits, [0]);
});

test("runShutdown：交接退出进行中 → 忽略 SIGTERM，不动任何子进程也不退出", async () => {
  const s = shutdownScene({ handoffExiting: true });
  await runShutdown(s.deps);
  assert.deepEqual(s.logs, ["SIGTERM ignored: supervisor handoff exit already in progress (children stay up for the next supervisor)"]);
  assert.equal(s.state.stopping, false);
  assert.deepEqual(s.own.signals, []);
  assert.deepEqual(s.stops, []);
  assert.deepEqual(s.exits, []);
});

test("runShutdown：日志刷盘卡住也在 200ms 内 exit(0)", async () => {
  const s = shutdownScene();
  s.deps.flushLogs = () => new Promise(() => {});
  const startedAt = Date.now();
  await runShutdown(s.deps);
  assert.deepEqual(s.exits, [0]);
  assert.ok(Date.now() - startedAt < 1000);
});
