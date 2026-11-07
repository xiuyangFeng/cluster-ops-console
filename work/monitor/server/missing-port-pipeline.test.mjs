// v2.54 终审：没领反向端口是"配置未完成"，不是通道故障。
// 这组测试走真实的状态仓 → 分诊 → 自动修复策略 → 事件存储三层，锁住两件事：
//   1) 证实原问题：通道层不带结构化标记时（v2.54.0 集成的行为），缺端口账号的通道会被分诊成
//      channel、被自动修复每 10 分钟重启 2 次再"已达上限"、并在事件存储里立案；
//   2) 修复后：通道层带 setupPending，分诊归 setup，自动修复不出手、不升级人工，事件不立案；
//      summary / 托盘 / 悬浮岛的 transport 是 setup（灰色「未领取端口」）而不是 disconnected。
import assert from "node:assert/strict";
import test from "node:test";

import { trayHealthFromStatus, trayIconColor } from "../desktop/tray.mjs";
import { createAutoRepairPolicy } from "../lib/auto-repair-policy.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { createIncidentStore } from "../lib/incidents/store.mjs";
import { classifySignal } from "../lib/signal-triage.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import { buildStatusSummary } from "../lib/readiness-view.mjs";
import { createAutoRepairViewBuilder } from "./auto-repair.mjs";
import { createIncidentObservers } from "./incident-sync.mjs";
import { attachTriage } from "./signal-sink.mjs";

const T0 = 1_800_000_000_000;

// 同事刚装好：团队层没有 remotePort、个人层还没 portOverrides。
function unclaimedConfig() {
  return {
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [{ id: "codex", name: "Codex", kind: "codex", command: "codex" }],
    servers: [{ id: "server-01", name: "主集群服务器 (myserver)", host: "myserver", localPort: 8888 }],
  };
}

function probeResult(level, data, checkedAt) {
  return { level, reason: "", data, checkedAt, nextCheckAt: checkedAt + 10_000, durationMs: 3, error: level === "error" };
}

function emit(id, layer, result) {
  bus.emit(EVENTS.PROBE_UPDATED, { id, layer, result });
}

// supervisor + 本地代理都在跑，隧道没有（supervisor 不为没端口的服务器建隧道）——
// 正是 channel-down-restart 的前提（"本机进程都在、通道却断着"）。
const PROCESSES = {
  localProxy: [{ pid: "11", command: "node work/local_http_connect_proxy.mjs" }],
  reverseTunnel: [],
  supervisor: [{ pid: "13", command: "node work/monitor/channel-supervisor.mjs" }],
  tunnelsByServer: { "server-01": [] },
};

// 集群上的 codex 没有出网通路时日志里会出现的请求超时信号（error 级、要分诊）。
function timeoutSignal(firstSeenAt) {
  return { id: "request-timeout", category: "request", severity: "error", title: "请求超时", sample: "timeout", advice: "", firstSeenAt, lastSeenAt: firstSeenAt };
}

function setupHarness(t) {
  let clock = T0;
  const store = createStateStore({ config: unclaimedConfig(), now: () => clock });
  const incidentStore = createIncidentStore({ now: () => clock, openGate: {} });
  const observers = createIncidentObservers({
    store,
    incidentStore,
    getMergedConfig: unclaimedConfig,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  });
  const transitions = [];
  const onStatus = (event) => {
    transitions.push(...(event.transitions || []));
    observers.onStatusChanged(event);
  };
  bus.on(EVENTS.STATUS_CHANGED, onStatus);
  t.after(() => {
    bus.off(EVENTS.STATUS_CHANGED, onStatus);
    store.dispose();
  });

  emit("processes", "channel", probeResult("ok", { processes: PROCESSES }, clock));
  // fast 采集：没有端口可查，远端端口结论为 false（与 remotePortFromFastResult 的口径一致）。
  const signal = timeoutSignal(clock);
  const layersAtSignal = store.getLayers();
  attachTriage([signal], [], { layers: layersAtSignal, agentsStatus: {}, health: "down" });
  emit("log-signals", "agents", probeResult("ok", { signals: [signal], activeSignals: [signal], remotePortOpen: false }, clock));

  const policy = createAutoRepairPolicy({ now: () => clock });
  const buildView = createAutoRepairViewBuilder({
    store,
    channel: { getShouldBeRunning: () => true, getRepairInFlight: () => false },
    getMergedConfig: unclaimedConfig,
  });
  // 模拟 20 分钟里每 10 秒评估一次（真实接线在 PROBE_UPDATED / STATUS_CHANGED 上触发）。
  function runPolicy(viewOverride = (v) => v) {
    const actions = [];
    for (let i = 0; i < 120; i += 1) {
      clock += 10_000;
      actions.push(...policy.evaluate(viewOverride({ ...buildView(), now: clock })));
    }
    return actions;
  }
  return { store, incidentStore, transitions, signal, runPolicy, advance: (ms) => { clock += ms; }, now: () => clock };
}

test("缺端口：通道层 skipped + setupPending；分诊归 setup；自动修复 20 分钟内一次都不重启、不升级人工；事件不立案", (t) => {
  const h = setupHarness(t);
  const layers = h.store.getLayers();

  // 通道层：结构化标记
  assert.equal(layers.channel.level, "skipped");
  assert.equal(layers.channel.detail.setupPending, true);
  assert.equal(layers.channel.detail.setupReason, "missing-port");
  assert.equal(layers.channel.detail.downSinceMs, null, "不是断开，不计持续断开时长");
  assert.equal(layers.tunnels["server-01"].setupPending, true);

  // 分诊：setup（非故障，info）
  assert.equal(h.signal.rootCause, "setup");
  assert.equal(classifySignal(h.signal, { layers }).severity, "info");

  // 自动修复：没有 restart-channel，也没有 escalate
  const actions = h.runPolicy();
  assert.deepEqual(actions.filter((a) => a.kind === "restart-channel" || a.kind === "escalate"), []);

  // 事件：通道层从未进入 error，没有任何 channel 事件
  assert.ok(!h.transitions.some((tr) => tr.key === "channel" && tr.to === "error"), JSON.stringify(h.transitions));
  h.advance(10 * 60_000);
  h.incidentStore.promotePending();
  assert.equal(h.incidentStore.query({ state: "open" }).incidents.length, 0);

  // 哪怕有一条早先被分诊成 channel 的旧信号，策略也认通道层标记、不出手
  const stale = h.runPolicy((view) => ({ ...view, triage: { rootCause: "channel", since: T0 } }));
  assert.deepEqual(stale.filter((a) => a.kind === "restart-channel" || a.kind === "escalate"), []);

  // 事件观察者：即使收到一条（伪造的）channel → error 变迁，带标记也不立案
  createIncidentObservers({
    store: h.store,
    incidentStore: h.incidentStore,
    getMergedConfig: unclaimedConfig,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  }).onStatusChanged({ transitions: [{ key: "channel", from: "waiting", to: "error", reason: "x" }] });
  h.incidentStore.promotePending();
  assert.equal(h.incidentStore.query({ state: "open" }).incidents.length, 0);
});

test("缺端口：summary.transport 是 setup（灰色「未领取端口」），托盘不刷红；legacy health 仍是 down（引导卡据此出现）", (t) => {
  const h = setupHarness(t);
  const legacy = h.store.getLegacyStatus();
  assert.equal(legacy.health, "down");
  assert.equal(legacy.summary.transport.state, "setup");
  assert.equal(legacy.summary.transport.reasonCode, "MISSING_PORT");
  assert.match(legacy.summary.headline, /未领取反向端口/);
  const tray = trayHealthFromStatus(legacy);
  assert.equal(tray.health, "setup");
  assert.equal(trayIconColor(tray.health, tray.summary), "#9ca3af", "灰色 idle，不是红色 down");
});

test("证实原问题（对照组）：去掉通道层标记（v2.54.0 行为），同一现场会被分诊成 channel、自动修复重启 2 次后升级人工、事件立案", () => {
  // v2.54.0：缺端口时通道层判 error、没有 setupPending——等价于有端口但隧道断着的现场。
  const layers = {
    channel: {
      level: "error",
      reason: "未领取反向端口，隧道不会建立",
      detail: { supervisorUp: true, localProxyUp: true, tunnelUp: false, remotePortOpen: false, host: "myserver", localPort: 8888, remotePort: null },
    },
    agents: {},
  };
  const signal = timeoutSignal(T0);
  assert.equal(classifySignal(signal, { layers }).rootCause, "channel");

  let clock = T0;
  const policy = createAutoRepairPolicy({ now: () => clock });
  const actions = [];
  for (let i = 0; i < 120; i += 1) {
    clock += 10_000;
    actions.push(...policy.evaluate({
      now: clock,
      shouldBeRunning: true,
      repairInFlight: false,
      activeServerId: "server-01",
      triage: { rootCause: "channel", since: T0 },
      processes: { supervisorUp: true, localProxyUp: true },
    }));
  }
  const kinds = actions.map((a) => a.kind);
  assert.ok(kinds.filter((k) => k === "restart-channel").length >= 2, kinds.join(","));
  assert.ok(kinds.includes("escalate"), "10 分钟 2 次后'已达上限'");

  const summary = buildStatusSummary({ layers, activeServerId: "server-01", shouldBeRunning: true, nowMs: T0 });
  assert.equal(summary.transport.state, "disconnected");
  const incidentStore = createIncidentStore({ now: () => T0, openGate: {} });
  createIncidentObservers({
    store: { getLayers: () => layers, getSummary: () => summary },
    incidentStore,
    getMergedConfig: unclaimedConfig,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  }).onStatusChanged({ transitions: [{ key: "channel", from: "waiting", to: "error", reason: layers.channel.reason }] });
  assert.equal(incidentStore.query({ state: "open" }).incidents.length, 1);
});

test("领了端口、隧道真断：照旧判 error / channel / 立案（标记不吞掉真故障）", () => {
  const layers = {
    channel: {
      level: "error",
      reason: "SSH 隧道未开启",
      detail: { supervisorUp: true, localProxyUp: true, tunnelUp: false, remotePortOpen: false, remotePort: 7892 },
    },
    agents: {},
  };
  assert.equal(classifySignal(timeoutSignal(T0), { layers }).rootCause, "channel");
  // 没领端口但本地代理也挂了：本地代理是真故障，仍算通道断
  const proxyDown = { channel: { level: "skipped", setupPending: true, detail: { localProxyUp: false, tunnelUp: false, remotePortOpen: false, setupPending: true } }, agents: {} };
  assert.equal(classifySignal(timeoutSignal(T0), { layers: proxyDown }).rootCause, "channel");
});

test("缺端口但本地代理没跑：通道层判 error（标记仍在），transport 是 disconnected、事件照常立案——setup 不吞本机真故障", (t) => {
  const clock = T0;
  const store = createStateStore({ config: unclaimedConfig(), now: () => clock });
  t.after(() => store.dispose());
  emit("processes", "channel", probeResult("ok", { processes: { ...PROCESSES, localProxy: [] } }, clock));
  const layers = store.getLayers();
  assert.equal(layers.channel.level, "error");
  assert.equal(layers.channel.detail.setupPending, true);
  assert.match(layers.channel.reason, /本地代理未运行/);
  const legacy = store.getLegacyStatus();
  assert.equal(legacy.summary.transport.state, "disconnected");
  assert.match(legacy.summary.transport.reasonCode, /^LOCAL_PROXY_DOWN/);

  const incidentStore = createIncidentStore({ now: () => clock, openGate: {} });
  createIncidentObservers({
    store,
    incidentStore,
    getMergedConfig: unclaimedConfig,
    getShouldBeRunning: () => true,
    isClosing: () => false,
  }).onStatusChanged({ transitions: [{ key: "channel", from: "waiting", to: "error", reason: layers.channel.reason }] });
  assert.equal(incidentStore.query({ state: "open" }).incidents.length, 1);
});
