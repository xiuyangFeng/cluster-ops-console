// readiness-view 行为测试（T02，验收 A06–A11、A32）。纯函数，无 IO。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReadiness,
  buildStatusSummary,
  deriveAgentCapabilities,
  deriveFreshness,
  deriveTransportState,
} from "./readiness-view.mjs";
import { createStateStore } from "./state-store.mjs";
import { buildThreeServerConfig } from "./m1-fixtures.mjs";
import { bus, EVENTS } from "./event-bus.mjs";

const NOW = 1_788_576_000_000;

function channelLayers({ level = "ok", flags = {}, checkedAt = NOW - 3000, nextCheckAt = NOW + 7000, shouldBeRunning = true } = {}) {
  return {
    channel: {
      level,
      reason: "",
      checkedAt,
      nextCheckAt,
      detail: {
        supervisorUp: true,
        localProxyUp: true,
        tunnelUp: true,
        remotePortOpen: true,
        ...flags,
      },
    },
    tunnels: {},
  };
}

// ---- freshness ----

test("freshness: nextCheckAt + grace 内为 fresh，超期为 stale，无时间为 unknown", () => {
  assert.equal(deriveFreshness({ checkedAt: NOW - 3000, nextCheckAt: NOW + 7000, nowMs: NOW }), "fresh");
  assert.equal(deriveFreshness({ checkedAt: NOW - 60000, nextCheckAt: NOW - 30000, nowMs: NOW }), "stale");
  assert.equal(deriveFreshness({ checkedAt: null, nextCheckAt: null, nowMs: NOW }), "unknown");
  // 时钟回拨：checkedAt 在未来 → unknown，不得判 fresh。
  assert.equal(deriveFreshness({ checkedAt: NOW + 600000, nextCheckAt: NOW + 700000, nowMs: NOW }), "unknown");
  // grace 可传：Doctor 5 分钟级节奏不能被固定 30s 误标。nextCheckAt 已过但仍在
  // grace 内 → fresh；超出 nextCheckAt + grace → stale。
  assert.equal(deriveFreshness({ checkedAt: NOW - 120000, nextCheckAt: NOW - 80000, nowMs: NOW, graceMs: 90000 }), "fresh");
  assert.equal(deriveFreshness({ checkedAt: NOW - 120000, nextCheckAt: NOW - 80000, nowMs: NOW, graceMs: 5000 }), "stale");
});

// ---- A06: 网络可达 + Doctor 失败 → transport 与 Agent 能力分开 ----

test("A06: 通路全通 + Doctor fail → transport=connected，Agent attention 单独计数", () => {
  const summary = buildStatusSummary({
    layers: channelLayers(),
    agentsOverview: [
      { id: "codex", health: "degraded" },
      { id: "claude-codewing", health: "ready" },
    ],
    activeServerId: "fixture-a",
    shouldBeRunning: true,
    nowMs: NOW,
  });
  assert.equal(summary.transport.state, "connected");
  assert.equal(summary.transport.reasonCode, "TRANSPORT_DATA_PATH_OK");
  assert.equal(summary.agentCounts.available, 1);
  assert.equal(summary.agentCounts.attention, 1);
  assert.equal(summary.incidentCount, 1);
  assert.equal(summary.headline, "连接已建立，1 项检查需要处理");
});

test("A06: 三端同构——full 与 lite 的 summary 除生成时刻外逐字一致", () => {
  const config = buildThreeServerConfig();
  const store = createStateStore({ config });
  const legacy = store.getLegacyStatus();
  const lite = store.getLiteStatus();
  assert.equal(legacy.summary.schemaVersion, 1);
  const stripGeneratedAt = (s) => {
    const { context, ...rest } = s;
    const { generatedAt, ...contextRest } = context || {};
    return { ...rest, context: contextRest };
  };
  assert.deepEqual(stripGeneratedAt(lite.summary), stripGeneratedAt(legacy.summary), "full 与 lite 的 summary 必须同构");
  assert.ok(legacy.readiness);
  assert.equal(legacy.readiness.schemaVersion, 1);
});

// ---- transport 决策表 ----

test("transport: 手动停止 → stopped（A11），通路断 → disconnected，未探测 → unknown", () => {
  const stopped = deriveTransportState({ shouldBeRunning: false, localProxyUp: false, tunnelUp: false, remotePortOpen: false });
  assert.deepEqual([stopped.state, stopped.reasonCode], ["stopped", "MANUALLY_STOPPED"]);

  const broken = deriveTransportState({
    shouldBeRunning: true, localProxyUp: true, tunnelUp: true, remotePortOpen: false,
    checkedAt: NOW - 2000, nextCheckAt: NOW + 8000, nowMs: NOW,
  });
  assert.equal(broken.state, "disconnected");
  assert.equal(broken.reasonCode, "REMOTE_PORT_CLOSED");

  const unknown = deriveTransportState({ shouldBeRunning: true, localProxyUp: null, tunnelUp: null, remotePortOpen: null });
  assert.deepEqual([unknown.state, unknown.reasonCode], ["unknown", "WAITING_FIRST_PROBE"]);

  // supervisor 挂了但数据通路在：transport 仍 connected（组件层事实不劫持 transport）。
  const supervisorDown = deriveTransportState({
    shouldBeRunning: true, localProxyUp: true, tunnelUp: true, remotePortOpen: true,
    checkedAt: NOW - 2000, nextCheckAt: NOW + 8000, nowMs: NOW,
  });
  assert.equal(supervisorDown.state, "connected");
});

test("A06: 通路断开 reasonCode 列出全部断点，前端可据此定位组件", () => {
  const broken = deriveTransportState({
    shouldBeRunning: true, localProxyUp: false, tunnelUp: false, remotePortOpen: true,
    checkedAt: NOW - 2000, nextCheckAt: NOW + 8000, nowMs: NOW,
  });
  assert.equal(broken.reasonCode, "LOCAL_PROXY_DOWN+TUNNEL_DOWN");
});

// ---- A07: 401 / 证据不足不判 pass ----

test("A07: identity——明确未登录才 fail；ready 也只是 unknown（无身份证据）", () => {
  const authRequired = deriveAgentCapabilities({ health: "auth-required" });
  assert.equal(authRequired.identity.state, "fail");
  const ready = deriveAgentCapabilities({ health: "ready", endpointOk: true });
  assert.equal(ready.network.state, "pass", "网络可达是 endpoint 证据");
  assert.equal(ready.identity.state, "unknown", "不得从网络可达推理身份有效");
  const noEvidence = deriveAgentCapabilities({ health: "waiting" });
  assert.equal(noEvidence.identity.state, "unknown");
  assert.equal(noEvidence.network.state, "unknown");
  assert.equal(noEvidence.lastWork.state, "unknown");
});

test("A07: runtime——installed=false 是 fail；doctor fail 是 attention；doctor warn 不降级", () => {
  const missing = deriveAgentCapabilities({ health: "missing", installed: false });
  assert.equal(missing.runtime.state, "fail");
  assert.equal(missing.runtime.reasonCode, "AGENT_MISSING");
  const doctorFail = deriveAgentCapabilities({
    health: "degraded",
    endpointOk: true,
    doctorSummary: { ok: 3, fail: 1, warn: 0, notes: 0, raw: "3 ok, 1 fail" },
  });
  assert.equal(doctorFail.runtime.state, "attention");
  assert.equal(doctorFail.runtime.reasonCode, "DOCTOR_FAIL_1");
  const doctorWarn = deriveAgentCapabilities({
    health: "ready",
    endpointOk: true,
    doctorSummary: { ok: 4, fail: 0, warn: 2, notes: 0, raw: "4 ok, 2 warn" },
  });
  assert.equal(doctorWarn.runtime.state, "pass");
  assert.equal(doctorWarn.runtime.reasonCode, "DOCTOR_WARN_2");
});

// ---- A10: 休眠/长时间无采样 → stale 而不是新验证 ----

test("A10: 采样超期 → transport freshness=stale，state 保留 lastKnown 语义（不自动变绿）", () => {
  const summary = buildStatusSummary({
    layers: channelLayers({ checkedAt: NOW - 10 * 60 * 1000, nextCheckAt: NOW - 9 * 60 * 1000 }),
    agentsOverview: [],
    activeServerId: "fixture-a",
    shouldBeRunning: true,
    nowMs: NOW,
  });
  assert.equal(summary.transport.state, "connected", "state 保留最近已知结论");
  assert.equal(summary.transport.freshness, "stale", "但必须标注过期");
});

// ---- A11: 手动停止 + 切换查看服务器 → 停止意图保留 ----

test("A11: 手动停止时 summary=stopped，与查看哪台服务器无关", () => {
  for (const activeId of ["fixture-a", "fixture-b"]) {
    const summary = buildStatusSummary({
      layers: channelLayers({ shouldBeRunning: false, level: "skipped" }),
      agentsOverview: [],
      activeServerId: activeId,
      shouldBeRunning: false,
      nowMs: NOW,
    });
    assert.equal(summary.transport.state, "stopped");
    assert.equal(summary.headline, "通道已手动停止");
  }
});

// ---- 次要隧道与事件数 ----

test("其它服务器隧道断开计入 incidentCount 与 otherServersAttention，不影响 transport", () => {
  const layers = channelLayers();
  layers.tunnels = {
    "fixture-a": { level: "ok", tunnel: true },
    "fixture-b": { level: "error", tunnel: true },
    "fixture-c": { level: "skipped", tunnel: false },
  };
  const summary = buildStatusSummary({
    layers,
    agentsOverview: [{ id: "codex", health: "ready" }],
    activeServerId: "fixture-a",
    shouldBeRunning: true,
    nowMs: NOW,
  });
  assert.equal(summary.transport.state, "connected");
  assert.equal(summary.otherServersAttention, 1);
  assert.equal(summary.incidentCount, 1);
});

// ---- A08/A32: 迟到结果不污染新上下文（经真实 state-store 驱动）----

test("A08: 切服后迟到的 doctor 结果不进入新服务器的当前状态", async () => {
  const config = buildThreeServerConfig();
  const store = createStateStore({ config });
  const seen = [];
  const onStatus = () => seen.push(1);
  bus.on(EVENTS.STATUS_CHANGED, onStatus);
  try {
    // 先给 fixture-a 一个坏结论。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: "doctor",
      layer: "agents",
      result: {
        level: "error",
        reason: "doctor 失败",
        data: { ok: false, code: 1, summary: { ok: 0, fail: 2, warn: 0, notes: 0, raw: "0 ok, 2 fail" }, output: "boom" },
        checkedAt: NOW,
        probeContext: { serverId: "fixture-a", configRevision: "rev-a" },
      },
    });
    let legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.codex.health, "degraded");
    // 切换查看服务器（config 热载，generation +1）。切换不重置 agent 状态（既有语义：
    // forceRun 刷新前的缓存结论保留，由 checkedAt/new freshness 表达"旧上下文"）。
    store.setConfig({ ...config, activeServerId: "fixture-b" });
    // 迟到的 fixture-a 结果此时才回来：必须被丢弃——状态停在切换前的那份，不被覆盖。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: "doctor",
      layer: "agents",
      result: {
        level: "error",
        reason: "doctor 失败（迟到）",
        data: { ok: false, code: 1, summary: { ok: 0, fail: 9, warn: 0, notes: 0, raw: "0 ok, 9 fail" }, output: "late" },
        checkedAt: NOW + 1000,
        probeContext: { serverId: "fixture-a", configRevision: "rev-a" },
      },
    });
    legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.codex.health, "degraded", "切服前缓存结论保留");
    assert.ok(legacy.agentsStatus.codex.output.includes("boom"), "迟到结果（output=late）不得覆盖当前状态");
    assert.ok(!legacy.agentsStatus.codex.output.includes("late"));
    // 当前上下文（fixture-b）的正常结果照常生效（output 更新为 fine，证明没有一刀切）。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: "doctor",
      layer: "agents",
      result: {
        level: "ok",
        reason: "doctor 通过",
        data: { ok: true, code: 0, summary: { ok: 5, fail: 0, warn: 0, notes: 0, raw: "5 ok, 0 fail" }, output: "fine" },
        checkedAt: NOW + 2000,
        probeContext: { serverId: "fixture-b", configRevision: "rev-b" },
      },
    });
    legacy = store.getLegacyStatus();
    assert.ok(legacy.agentsStatus.codex.output.includes("fine"), "新上下文的正常结果必须生效");
    // endpoint（fixture-b）也回来 → codex 聚合为 ready。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: "endpoint",
      layer: "agents",
      result: {
        level: "ok",
        reason: "端点可达",
        data: { ok: true, code: 0, output: "HTTP/1.1 200" },
        checkedAt: NOW + 2100,
        probeContext: { serverId: "fixture-b", configRevision: "rev-b" },
      },
    });
    legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.codex.health, "ready");
    // 无 probeContext 的旧形状结果（旧调度器/测试直发）仍按旧语义生效。
    bus.emit(EVENTS.PROBE_UPDATED, {
      id: "doctor",
      layer: "agents",
      result: {
        level: "error",
        reason: "no context",
        data: { ok: false, code: 1, summary: { ok: 0, fail: 1, warn: 0, notes: 0, raw: "0 ok, 1 fail" }, output: "" },
        checkedAt: NOW + 3000,
      },
    });
    legacy = store.getLegacyStatus();
    assert.equal(legacy.agentsStatus.codex.health, "degraded", "无上下文标记保持旧兼容路径");
    // readiness 上下文绑定可追溯（查看的是 fixture-b，generation 因 setConfig +1）。
    assert.equal(legacy.readiness.context.serverId, "fixture-b");
    assert.equal(legacy.readiness.context.generation, 1, "setConfig 推进 generation");
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onStatus);
    store.dispose();
  }
});

test("A32: readiness 对畸形/缺失事实降级 unknown，不抛错", () => {
  const caps = deriveAgentCapabilities({
    health: undefined,
    installed: undefined,
    endpointOk: undefined,
    doctorSummary: { fail: "not-a-number", warn: null },
  });
  assert.equal(caps.network.state, "unknown");
  assert.equal(caps.runtime.state, "pass", "畸形 fail 计数按 0 处理（与 Number(x)||0 同口径）");
  const readiness = buildReadiness({ serverId: null, generation: NaN, configRevision: 42, agents: caps });
  assert.equal(readiness.context.serverId, "");
  assert.equal(readiness.context.generation, 0);
  assert.equal(readiness.context.configRevision, "42");
});
