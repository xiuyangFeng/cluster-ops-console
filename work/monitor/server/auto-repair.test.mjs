// 自动修复装配层的纯件：唤醒拍检测与策略视图。执行器本身的接线测试在 monitor-server.test.mjs。
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { createAutoRepairPolicy } from "../lib/auto-repair-policy.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import {
  createAutoRepairViewBuilder,
  createPreExecuteRefresher,
  createScopedTunnelRestarter,
  createServerLabeler,
  createWakeGapDetector,
  tunnelLevelsOf,
} from "./auto-repair.mjs";
import { createAutoRepairRunner, pickTriageSignal } from "./auto-repair-runner.mjs";
import { attachTriage } from "./signal-sink.mjs";

// 保活：执行前刷新的时限定时器是 unref 的（不挡进程退出），用例等它放行的那几十毫秒里事件循环是空的。
// Node 22.12 的测试运行器见到「Promise 未决而事件循环已空」会取消整个文件，较新的 Node 不会。
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

test("createWakeGapDetector：两拍间隔超过阈值才返回间隔，否则 0；每拍都刷新基准", () => {
  let clock = 1_000;
  const tick = createWakeGapDetector({ thresholdMs: 90_000, now: () => clock });
  clock += 5_000;
  assert.equal(tick(), 0);
  clock += 90_000;
  assert.equal(tick(), 0, "恰好等于阈值不算唤醒");
  clock += 120_000;
  assert.equal(tick(), 120_000);
  clock += 5_000;
  assert.equal(tick(), 0, "基准已刷新，下一拍回到常态");
});

test("策略视图：意图/修复在飞取自通道，根因取自已分诊的活跃信号", () => {
  let repairInFlight = false;
  const buildView = createAutoRepairViewBuilder({
    store: {
      getLayers: () => ({
        channel: { level: "error", detail: { supervisorUp: true, localProxyUp: false, downSinceMs: 100 } },
        tunnels: {
          "server-02": { level: "error", tunnel: true },
          "server-03": { level: "ok", tunnel: true },
          "server-04": { level: "skipped", tunnel: false },
        },
        signals: { active: [{ severity: "error", rootCause: "channel", firstSeenAt: 123 }] },
      }),
    },
    channel: { getShouldBeRunning: () => true, getRepairInFlight: () => repairInFlight },
    getMergedConfig: () => ({ activeServerId: "server-02" }),
  });
  const view = buildView();
  assert.ok(Number.isFinite(view.now));
  assert.deepEqual({ ...view, now: 0 }, {
    now: 0,
    shouldBeRunning: true,
    repairInFlight: false,
    activeServerId: "server-02",
    setupPending: false,
    triage: { rootCause: "channel", since: 123 },
    processes: { supervisorUp: true, localProxyUp: false },
    tunnels: [{ serverId: "server-02", level: "error" }, { serverId: "server-03", level: "ok" }],
    wakeGapMs: 0,
  });
  repairInFlight = true;
  assert.equal(buildView().repairInFlight, true, "通道修复在飞时策略静默");
});

test("策略视图：单隧道操作在飞也算修复进行中（与手动单条重启互斥）", () => {
  let tunnelOp = false;
  const buildView = createAutoRepairViewBuilder({
    store: { getLayers: () => ({ channel: { detail: {} }, signals: { active: [] } }) },
    channel: { getShouldBeRunning: () => true, getRepairInFlight: () => false },
    getMergedConfig: () => ({}),
    isTunnelOperationInFlight: () => tunnelOp,
  });
  assert.equal(buildView().repairInFlight, false);
  tunnelOp = true;
  assert.equal(buildView().repairInFlight, true);
});

test("tunnelLevelsOf：仅监控 / 没领端口 / 已停止的不算隧道", () => {
  assert.deepEqual(tunnelLevelsOf({
    a: { level: "error", tunnel: true },
    b: { level: "ok", tunnel: true },
    c: { level: "skipped", tunnel: false, reason: "仅监控" },
    d: { level: "skipped", tunnel: true, setupPending: true },
    e: { level: "waiting", tunnel: true },
  }), [{ serverId: "a", level: "error" }, { serverId: "b", level: "ok" }, { serverId: "e", level: "waiting" }]);
  assert.deepEqual(tunnelLevelsOf(undefined), []);
});

test("单隧道重启走界面同一条 preview → run 通路，run 带 trigger:auto", async () => {
  const calls = [];
  const restartTunnel = createScopedTunnelRestarter({
    preview: async (input) => {
      calls.push(["preview", input]);
      return { previewId: "p-1" };
    },
    run: async (input) => {
      calls.push(["run", input]);
      return { operationId: input.operationId, state: "queued" };
    },
  });
  await restartTunnel({ serverId: "server-aliyun", operationId: "op-1", ruleId: "channel-down-restart" });
  assert.deepEqual(calls, [
    ["preview", { action: "restart-tunnel", target: { serverId: "server-aliyun" } }],
    ["run", { previewId: "p-1", operationId: "op-1", trigger: "auto", ruleId: "channel-down-restart" }],
  ]);
});

test("执行前刷新：强制跑本机进程探针，等不到就按时限放行", async () => {
  const forced = [];
  let release;
  const refresh = createPreExecuteRefresher({
    scheduler: { forceRun: (id) => { forced.push(id); return new Promise((resolve) => { release = resolve; }); } },
    budgetMs: 20,
  });
  const started = Date.now();
  await refresh();
  assert.deepEqual(forced, ["processes"]);
  assert.ok(Date.now() - started < 5_000, "探针卡住时不无限等");
  release();
  const failing = createPreExecuteRefresher({ scheduler: { forceRun: () => Promise.reject(new Error("x")) }, budgetMs: 1_000 });
  await failing(); // 探针报错不外抛
});

test("界面用名：配置 name 优先，没有回落 id", () => {
  const label = createServerLabeler(() => ({ servers: [{ id: "server-aliyun", name: " 阿里云 " }, { id: "server-x" }] }));
  assert.equal(label("server-aliyun"), "阿里云");
  assert.equal(label("server-x"), "server-x");
  assert.equal(createServerLabeler(() => null)("server-y"), "server-y");
});

// ---- 回归：2026-10-14 15:47 通道已恢复后仍重启整个通道 ----
// 走真实状态仓 → 分诊 → 视图 → 策略。时刻取生产 timeline / ops 日志（北京时间）：
//   15:45:22 唤醒，主集群隧道断开（通道 error）；15:47:05 远端日志里冒出一条 error 信号，此刻通道仍断，
//   分诊为 channel；15:47:16 通道恢复 ok；15:47:30 阿里云隧道恢复；15:47:37（恢复后 21 秒）
//   ops「已持续 32s」重启整个通道；15:48:41（首次恢复后 85 秒）「已持续 97s」又一次。
const BJ = (hms) => Date.parse(`2026-10-14T${hms}+08:00`);
const TWO_TUNNELS = {
  activeServerId: "server-01",
  activeAgentId: "codex",
  agents: [],
  servers: [
    { id: "server-01", name: "主集群服务器 (myserver)", host: "myserver", remotePort: 7891, localPort: 8888 },
    { id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", remotePort: 7894, localPort: 8888, source: "personal" },
  ],
};

function probeResult(level, data, checkedAt) {
  return { level, reason: "", data, checkedAt, nextCheckAt: checkedAt + 10_000, durationMs: 3, error: level === "error" };
}

function realStoreHarness(t, start) {
  let clock = start;
  const store = createStateStore({ config: TWO_TUNNELS, now: () => clock });
  t.after(() => store.dispose());
  const emit = (id, layer, data, level = "ok") => bus.emit(EVENTS.PROBE_UPDATED, { id, layer, result: probeResult(level, data, clock) });
  const setProcesses = ({ main, aliyun }) => emit("processes", "channel", {
    processes: {
      localProxy: [{ pid: "11", command: "node work/local_http_connect_proxy.mjs" }],
      supervisor: [{ pid: "13", command: "node work/monitor/channel-supervisor.mjs" }],
      reverseTunnel: [...(main ? [{ pid: "21" }] : []), ...(aliyun ? [{ pid: "22" }] : [])],
      tunnelsByServer: { "server-01": main ? [{ pid: "21" }] : [], "server-aliyun": aliyun ? [{ pid: "22" }] : [] },
    },
  });
  let activeSignals = [];
  const setMainPort = (open) => emit("log-signals", "agents", { signals: [], activeSignals, remotePortOpen: open });
  const setAliyunPort = (open) => emit("collect:slow:server-aliyun", "resources", { ports: { 7894: open } });
  // 一条 error 信号：与生产同一条分诊路径（signal-sink.attachTriage，按此刻的层级分诊）。
  const fireSignal = () => {
    const signal = { id: "connection-reset", category: "request", severity: "error", title: "连接被重置", sample: "ECONNRESET", advice: "", firstSeenAt: clock, lastSeenAt: clock };
    activeSignals = [signal];
    attachTriage([signal], activeSignals, { layers: store.getLayers(), agentsStatus: {}, health: "down" });
    return signal;
  };
  const policy = createAutoRepairPolicy({ now: () => clock });
  const buildView = createAutoRepairViewBuilder({
    store,
    channel: { getShouldBeRunning: () => true, getRepairInFlight: () => false },
    getMergedConfig: () => TWO_TUNNELS,
  });
  return {
    store, policy, buildView, setProcesses, setMainPort, setAliyunPort, fireSignal,
    at: (ms) => { clock = ms; },
    view: () => ({ ...buildView(), now: clock }),
  };
}

test("回归 15:47：通道恢复后 21 秒、85 秒不再判「通道断开已持续 Ns」，不重启", (t) => {
  const h = realStoreHarness(t, BJ("15:45:22"));
  h.setProcesses({ main: false, aliyun: false });
  h.setMainPort(false);
  h.setAliyunPort(false);
  assert.equal(h.store.getLayers().channel.level, "error");

  h.at(BJ("15:47:05"));
  const signal = h.fireSignal();
  h.setMainPort(false);
  assert.equal(signal.rootCause, "channel", "信号首见时通道确实断着：分诊为 channel");

  h.at(BJ("15:47:16"));
  h.setProcesses({ main: true, aliyun: false });
  h.setMainPort(true);
  assert.equal(h.store.getLayers().channel.level, "ok", "15:47:16 通道全链路正常");
  h.at(BJ("15:47:30"));
  h.setProcesses({ main: true, aliyun: true });
  h.setAliyunPort(true);

  // 证实原问题：只看信号 firstSeenAt（修复前的视图）时，恢复后 21 秒会判「已持续 32s」并重启整个通道。
  h.at(BJ("15:47:37"));
  const legacy = createAutoRepairPolicy({ now: () => BJ("15:47:37") })
    .evaluate({ ...h.view(), triage: pickTriageSignal(h.store.getLayers().signals.active) });
  assert.equal(legacy[0]?.kind, "restart-channel");
  assert.match(legacy[0].reason, /已持续 32s/);

  // 修复后：通道层不在 error → 视图里没有 channel 分诊 → 一个动作都没有。
  assert.equal(h.view().triage, null);
  assert.deepEqual(h.policy.evaluate(h.view()), [], "恢复后 21 秒不重启");
  h.at(BJ("15:48:41"));
  assert.deepEqual(h.policy.evaluate(h.view()), [], "恢复后 85 秒不重启");
  // 信号仍在活跃表里（10 分钟 TTL），根因仍写着 channel——问题正出在只看它。
  assert.equal(h.store.getLayers().signals.active[0].rootCause, "channel");
});

test("断开起点在恢复（哪怕只一拍）后清零：再断要重新攒满 30 秒", (t) => {
  const T = BJ("16:00:00");
  const h = realStoreHarness(t, T);
  h.setProcesses({ main: false, aliyun: true });
  h.setAliyunPort(true);
  h.setMainPort(false);
  h.fireSignal();
  h.at(T + 20_000);
  h.setProcesses({ main: true, aliyun: true });
  h.setMainPort(true); // 只恢复了一拍
  h.at(T + 25_000);
  h.setProcesses({ main: false, aliyun: true });
  h.setMainPort(false);

  h.at(T + 50_000);
  assert.deepEqual(h.policy.evaluate(h.view()), [], "距再次断开才 25 秒");
  h.at(T + 55_000);
  const [action] = h.policy.evaluate(h.view());
  assert.equal(action?.kind, "restart-tunnel", "满 30 秒才出手");
  assert.match(action.reason, /已持续 30s/, "按再次断开的起点计时，不是信号首见的 55 秒");
});

test("只修坏的那条：主集群隧道断、阿里云好 → 只重启主集群那一条；两条都断 → 重启整个通道", (t) => {
  const T = BJ("17:00:00");
  const h = realStoreHarness(t, T);
  h.setProcesses({ main: false, aliyun: true });
  h.setAliyunPort(true);
  h.setMainPort(false);
  h.fireSignal();
  h.at(T + 40_000);
  h.setMainPort(false);
  const [single] = h.policy.evaluate(h.view());
  assert.deepEqual({ kind: single.kind, payload: single.payload }, { kind: "restart-tunnel", payload: { serverId: "server-01" } });

  const both = realStoreHarness(t, T);
  both.setProcesses({ main: false, aliyun: false });
  both.setAliyunPort(false);
  both.setMainPort(false);
  both.fireSignal();
  both.at(T + 40_000);
  both.setMainPort(false);
  const [whole] = both.policy.evaluate(both.view());
  assert.equal(whole.kind, "restart-channel");
});

test("执行器端到端：主集群断、阿里云好时只调单隧道重启，不碰整个通道", async (t) => {
  const T = BJ("18:00:00");
  const h = realStoreHarness(t, T);
  h.setProcesses({ main: false, aliyun: true });
  h.setAliyunPort(true);
  h.setMainPort(false);
  h.fireSignal();
  const restarts = [];
  const tunnelRestarts = [];
  const runner = createAutoRepairRunner({
    policy: h.policy,
    scheduler: { forceRun: async () => ({}) },
    channel: { restartChannel: async (options) => { restarts.push(options); return { ok: true }; } },
    restartTunnel: async (input) => { tunnelRestarts.push(input); },
    buildView: h.view,
  });
  h.at(T + 40_000);
  h.setMainPort(false);
  await runner.evaluate();
  assert.deepEqual(restarts, []);
  assert.deepEqual(tunnelRestarts.map((r) => r.serverId), ["server-01"]);
});
