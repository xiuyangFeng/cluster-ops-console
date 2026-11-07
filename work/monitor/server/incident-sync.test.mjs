// 事件合并观察者：总线事实 → incidentStore 调用。用记录型替身驱动，不挂真实总线。
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createIncidentStore } from "../lib/incidents/store.mjs";
import {
  agentIdForProbe,
  agentReasonCode,
  createIncidentObservers,
  createIncidentSync,
  disabledAgentIds,
  linkOperationToIncidents,
  sanitizeIncidentText,
} from "./incident-sync.mjs";

function harness({ layers = {}, summary = {}, servers, agents, closing = false, shouldBeRunning = true, incidentStore: realStore = null } = {}) {
  const calls = [];
  const counts = { getLayers: 0, getSummary: 0 };
  const fullLayers = { channel: { detail: {} }, tunnels: {}, agents: {}, ...layers };
  const store = {
    getLayers: () => {
      counts.getLayers += 1;
      return fullLayers;
    },
    getSummary: (_now, { layers: given } = {}) => {
      counts.getSummary += 1;
      assert.equal(given, fullLayers, "getSummary 必须复用同一份 layers");
      return { context: { serverId: "server-01" }, ...summary };
    },
  };
  const record = (name) => (payload) => calls.push({ name, ...payload });
  const incidentStore = realStore || {
    observe: record("observe"),
    reportSuccess: record("reportSuccess"),
    reportUnknown: record("reportUnknown"),
    observeDiskUsage: record("observeDiskUsage"),
  };
  const merged = {
    servers: servers || [{ id: "server-01" }, { id: "server-02" }, { id: "server-off", disabled: true }],
    ...(agents ? { agents } : {}),
  };
  const observers = createIncidentObservers({
    store,
    incidentStore,
    getMergedConfig: () => merged,
    getShouldBeRunning: () => shouldBeRunning,
    isClosing: () => closing,
  });
  return { observers, calls, counts };
}

test("agentReasonCode / sanitizeIncidentText：稳定 reasonCode 与 120 字截断", () => {
  assert.equal(agentReasonCode("banned"), "ACCOUNT_BANNED");
  assert.equal(agentReasonCode("auth-required"), "AUTH_REQUIRED");
  assert.equal(agentReasonCode(undefined), "AGENT_ATTENTION");
  assert.equal(agentReasonCode("weird"), "AGENT_ATTENTION");
  assert.equal(sanitizeIncidentText("x".repeat(200)).length, 120);
  assert.equal(sanitizeIncidentText(null), "");
});

test("STATUS_CHANGED：通道 error 取 summary 的 reasonCode；隧道 / agent 变迁各归其位；禁用服务器跳过", () => {
  const { observers, calls, counts } = harness({
    summary: { transport: { reasonCode: "SSH_AUTH" } },
    layers: { agents: { codex: { health: "revoked" } } },
  });
  observers.onStatusChanged({
    transitions: [
      { key: "channel", to: "error", reason: "r".repeat(300) },
      { key: "tunnel:server-02", to: "error", reason: "down" },
      { key: "tunnel:server-off", to: "error" },
      { key: "agent:codex", to: "warn" },
      { key: "agent:codex", to: "ok" },
      { key: "channel", to: "ok" },
    ],
  });
  assert.deepEqual(calls.map((c) => [c.name, c.serverId, c.component, c.reasonCode]), [
    ["observe", "server-01", "channel", "SSH_AUTH"],
    ["observe", "server-02", "tunnel", "TUNNEL_DOWN"],
    ["observe", "server-01", "agent", "ACCOUNT_REVOKED"],
    ["reportSuccess", "server-01", "agent", undefined],
  ]);
  assert.equal(calls[0].evidence.reason.length, 120);
  assert.equal(calls[2].severity, "warn");
  assert.equal(calls[2].agentId, "codex");
  assert.equal(calls[3].agentId, "codex", "agent→ok 的成功采样只作用于该 agent");
  assert.deepEqual(counts, { getLayers: 1, getSummary: 1 }, "每个事件只算一次层级模型");
});

test("PROBE_UPDATED：agent 探针 error/ok/其它分别 observe / reportSuccess / reportUnknown；只算一次 layers", () => {
  const { observers, calls, counts } = harness({ layers: { agents: { "claude-codewing": { health: "missing" } } } });
  const ctx = { probeContext: { serverId: "server-01" } };
  observers.onProbeUpdated({ id: "reclaude", result: { level: "error", ...ctx } });
  observers.onProbeUpdated({ id: "doctor", result: { level: "ok", ...ctx } });
  observers.onProbeUpdated({ id: "endpoint", result: { level: "warn", ...ctx } });
  assert.deepEqual(calls.map((c) => [c.name, c.agentId, c.reasonCode]), [
    ["observe", "claude-codewing", "AGENT_MISSING"],
    ["reportSuccess", "codex", undefined],
    ["reportUnknown", "codex", undefined],
  ]);
  assert.deepEqual(counts, { getLayers: 3, getSummary: 3 });
});

test("PROBE_UPDATED：同一 agent 任一探针最近一次是 error 时，其它探针的 ok 不算恢复采样；别的 agent 不受影响", () => {
  const { observers, calls } = harness();
  const ctx = { probeContext: { serverId: "server-01" } };
  observers.onProbeUpdated({ id: "doctor", result: { level: "error", ...ctx } });
  observers.onProbeUpdated({ id: "endpoint", result: { level: "ok", ...ctx } });
  observers.onProbeUpdated({ id: "claude-endpoint", result: { level: "ok", ...ctx } });
  observers.onStatusChanged({ transitions: [{ key: "agent:codex", to: "ok" }] });
  assert.deepEqual(calls.map((c) => [c.name, c.agentId]), [
    ["observe", "codex"],
    ["reportSuccess", "claude-codewing"],
  ], "doctor 仍在报错：endpoint ok / agent 层 ok 都不能撤销 codex 的失败");
  calls.length = 0;
  observers.onProbeUpdated({ id: "doctor", result: { level: "ok", ...ctx } });
  observers.onProbeUpdated({ id: "endpoint", result: { level: "ok", ...ctx } });
  assert.deepEqual(calls.map((c) => [c.name, c.agentId]), [["reportSuccess", "codex"], ["reportSuccess", "codex"]]);
});

test("端到端（真实 store + 默认门槛）：codex doctor 持续报错，claude 与 codex endpoint 的 ok 都关不掉 codex 事件", () => {
  let clock = 1_000_000;
  const incidentStore = createIncidentStore({ now: () => clock });
  const { observers } = harness({ incidentStore, layers: { agents: { codex: { health: "degraded" } } } });
  const probe = (id, level) => {
    clock += 30_000;
    observers.onProbeUpdated({ id, result: { level, probeContext: { serverId: "server-01" } } });
  };
  probe("doctor", "error");
  probe("doctor", "error");
  assert.equal(incidentStore.counts().open, 0, "2 次失败仍在门槛内（待定）");
  probe("doctor", "error");
  const [opened] = incidentStore.query().incidents;
  assert.equal(opened.agentId, "codex");
  assert.equal(opened.occurrences, 3);
  for (let i = 0; i < 5; i += 1) {
    probe("reclaude", "ok");
    probe("claude-endpoint", "ok");
    probe("endpoint", "ok");
  }
  assert.equal(incidentStore.getIncident(opened.incidentId).lifecycle, "open", "doctor 最近一次仍是 error");
  probe("doctor", "ok");
  probe("endpoint", "ok");
  assert.equal(incidentStore.getIncident(opened.incidentId).lifecycle, "resolved");
});

test("PROBE_UPDATED：collect:slow 携带磁盘用量 → observeDiskUsage；未启用 / 非活跃归属一律忽略", () => {
  const { observers, calls } = harness();
  observers.onProbeUpdated({ id: "collect:slow:server-02", result: { level: "ok", data: { usage: { filesystem: { usedPct: 97 } } } } });
  observers.onProbeUpdated({ id: "collect:slow:server-off", result: { level: "ok", data: { usage: { filesystem: { usedPct: 99 } } } } });
  observers.onProbeUpdated({ id: "doctor", result: { level: "error", probeContext: { serverId: "server-02" } } });
  const disk = calls.filter((c) => c.name === "observeDiskUsage");
  assert.deepEqual(disk.map((c) => [c.serverId, c.usedPct]), [["server-02", 97]]);
  assert.equal(calls.some((c) => c.name === "observe"), false, "非活跃服务器的 agent 探针结果不产生事实");
});

test("退出途中（isClosing）两个观察者都不再摄入事实", () => {
  const { observers, calls, counts } = harness({ closing: true });
  observers.onStatusChanged({ transitions: [{ key: "channel", to: "error" }] });
  observers.onProbeUpdated({ id: "doctor", result: { level: "error", probeContext: { serverId: "server-01" } } });
  assert.deepEqual(calls, []);
  assert.deepEqual(counts, { getLayers: 0, getSummary: 0 });
});

test("观察者吞掉内部异常，不把错误抛回事件总线", () => {
  const { observers } = harness();
  assert.doesNotThrow(() => observers.onStatusChanged({ transitions: [{ key: 42, to: "error" }] }));
  assert.doesNotThrow(() => observers.onProbeUpdated({ id: "doctor", result: null }));
});

// ---- 处置操作 → 事件关联（「查看处置日志」）----

// s1 上隧道 / 通道 / 账号 / 磁盘各一条未解决事件，s2 上一条隧道事件 + 一条已恢复的通道事件。
function linkFixture() {
  const incidentStore = createIncidentStore({ openGate: {} });
  const open = (serverId, component, reasonCode) => incidentStore.observe({ serverId, component, reasonCode, severity: "error" }).incidentId;
  const ids = {
    s1Tunnel: open("s1", "tunnel", "TUNNEL_DOWN"),
    s1Channel: open("s1", "channel", "CHANNEL_ERROR"),
    s1Agent: open("s1", "agent", "ACCOUNT_REVOKED"),
    s1Disk: open("s1", "filesystem", "DISK_THRESHOLD"),
    s2Tunnel: open("s2", "tunnel", "TUNNEL_DOWN"),
    s2Resolved: open("s2", "channel", "CHANNEL_ERROR"),
  };
  incidentStore.reportSuccess({ serverId: "s2", component: "channel" });
  incidentStore.reportSuccess({ serverId: "s2", component: "channel" });
  assert.equal(incidentStore.getIncident(ids.s2Resolved).lifecycle, "resolved");
  const opsOf = (key) => incidentStore.getIncident(ids[key]).relatedOperationIds;
  return { incidentStore, ids, opsOf };
}

test("关联规则：单隧道重启只关联该服务器未解决的隧道/通道事件", () => {
  const { incidentStore, ids, opsOf } = linkFixture();
  const linked = linkOperationToIncidents({ incidentStore, operationId: "op-scoped", serverId: "s1" });
  assert.deepEqual(new Set(linked), new Set([ids.s1Tunnel, ids.s1Channel]));
  assert.deepEqual(opsOf("s1Tunnel"), ["op-scoped"]);
  assert.deepEqual(opsOf("s1Channel"), ["op-scoped"]);
  assert.deepEqual(opsOf("s2Tunnel"), [], "其它服务器的事件不关联");
  assert.deepEqual(opsOf("s1Agent"), [], "账号吊销/封禁不是重启能处置的");
  assert.deepEqual(opsOf("s1Disk"), [], "磁盘事件不关联");
});

test("关联规则：通道级重启（手动 / 自动）关联所有服务器的隧道/通道事件；账号、磁盘、已恢复事件不动", () => {
  const { incidentStore, ids, opsOf } = linkFixture();
  linkOperationToIncidents({ incidentStore, operationId: "op-scoped", serverId: "s1" });
  const linked = linkOperationToIncidents({ incidentStore, operationId: "op-channel" });
  assert.deepEqual(new Set(linked), new Set([ids.s1Tunnel, ids.s1Channel, ids.s2Tunnel]));
  assert.deepEqual(opsOf("s1Tunnel"), ["op-scoped", "op-channel"], "按受理先后追加：最后一个是最近一次处置");
  assert.deepEqual(opsOf("s2Tunnel"), ["op-channel"]);
  assert.deepEqual(opsOf("s1Agent"), []);
  assert.deepEqual(opsOf("s1Disk"), []);
  assert.deepEqual(opsOf("s2Resolved"), [], "已恢复事件不追加关联");
  assert.deepEqual(linkOperationToIncidents({ incidentStore, operationId: "" }), [], "缺 operationId 不关联");
});

test("关联规则：未解决事件超过一页（200）时逐页全部关联", () => {
  const incidentStore = createIncidentStore({ openGate: {} });
  for (let i = 0; i < 250; i += 1) incidentStore.observe({ serverId: `s-${i}`, component: "tunnel", reasonCode: "TUNNEL_DOWN", at: i + 1 });
  const linked = linkOperationToIncidents({ incidentStore, operationId: "op-many" });
  assert.equal(new Set(linked).size, 250);
});

test("createIncidentSync.linkOperation：关联落盘；失败只落 warn 日志、不抛；退出途中不再改事件", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "incident-link-"));
  const logs = [];
  const sync = await createIncidentSync({
    runtimeDir,
    appendLog: (message, fields) => logs.push({ message, ...(fields || {}) }),
    configManager: { getIncidentServerLifecycle: () => null },
    openGate: {}, // 本测关注关联而非打开门槛：首次失败立即打开
  });
  try {
    const { incidentId } = sync.incidentStore.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
    assert.deepEqual(sync.linkOperation({ operationId: "op-1", serverId: "s1" }), [incidentId]);

    const realQuery = sync.incidentStore.query;
    sync.incidentStore.query = () => {
      throw new Error("store exploded");
    };
    assert.deepEqual(sync.linkOperation({ operationId: "op-2" }), [], "关联失败不得抛回操作路径");
    assert.ok(logs.some((l) => l.level === "warn" && l.event === "incident-link" && l.operationId === "op-2"));
    sync.incidentStore.query = realQuery;

    sync.beginShutdown();
    assert.deepEqual(sync.linkOperation({ operationId: "op-3" }), []);
    await sync.close();
    const saved = JSON.parse(await readFile(path.join(runtimeDir, "incidents.json"), "utf8"));
    assert.deepEqual(saved.active.find((i) => i.incidentId === incidentId).relatedOperationIds, ["op-1"]);
  } finally {
    sync.beginShutdown();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

// ---- v2.47 模块开关：agent 归属经注册表 + 配置反查；关掉的 Agent 事件「模块已关闭」结案 ----

test("agentIdForProbe：经注册表反查适配器、按配置条目取 agentId；非 agent / 未启用 → null", () => {
  const config = { agents: [{ id: "codex-main", kind: "codex" }, { id: "zcode", kind: "zcode" }] };
  assert.equal(agentIdForProbe("doctor", config), "codex-main", "配置条目 id 优先");
  assert.equal(agentIdForProbe("zcode-status", config), "zcode", "zcode 不再被误归到 claude-codewing");
  assert.equal(agentIdForProbe("reclaude", config), null, "reclaude 被关掉（不在运行配置 agents[]）");
  assert.equal(agentIdForProbe("log-signals", config), null);
  // 无 agents 数组的替身配置按默认物化口径
  assert.equal(agentIdForProbe("claude-endpoint", {}), "claude-codewing");
  assert.deepEqual(disabledAgentIds({ agentCatalog: [{ id: "codex", enabled: true }, { id: "zcode", enabled: false }] }), ["zcode"]);
  assert.deepEqual(disabledAgentIds(null), []);
});

test("PROBE_UPDATED：被关掉的 Agent 的迟到探针结果不摄入；zcode 启用时照常归属", () => {
  const ctx = { probeContext: { serverId: "server-01" } };
  const off = harness({ agents: [{ id: "claude-codewing", kind: "reclaude" }] });
  off.observers.onProbeUpdated({ id: "doctor", result: { level: "error", ...ctx } });
  assert.equal(off.calls.filter((c) => c.component === "agent").length, 0, "codex 已关闭：不产生 agent 事实");
  off.observers.onProbeUpdated({ id: "reclaude", result: { level: "error", ...ctx } });
  assert.deepEqual(off.calls.filter((c) => c.component === "agent").map((c) => [c.name, c.agentId]), [["observe", "claude-codewing"]]);

  const on = harness({ agents: [{ id: "zcode", kind: "zcode" }], layers: { agents: { zcode: { health: "degraded" } } } });
  on.observers.onProbeUpdated({ id: "zcode-status", result: { level: "error", ...ctx } });
  assert.deepEqual(on.calls.filter((c) => c.component === "agent").map((c) => [c.name, c.agentId, c.reasonCode]), [["observe", "zcode", "DEGRADED"]]);
});

test("createIncidentSync.syncServerLifecycle：设置页关掉的 Agent 的未结事件自动关闭（「模块已关闭」），其它不动", async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "incident-agent-off-"));
  const logs = [];
  let cache = { agentCatalog: [{ id: "codex", enabled: true }, { id: "claude-codewing", enabled: true }] };
  const sync = await createIncidentSync({
    runtimeDir,
    appendLog: (message) => logs.push(message),
    configManager: {
      getIncidentServerLifecycle: () => ({ servers: [{ id: "server-01", disabled: false }], tombstones: [] }),
      getCache: () => cache,
    },
    openGate: {},
  });
  try {
    const store = sync.incidentStore;
    const claude = store.observe({ serverId: "server-01", agentId: "claude-codewing", component: "agent", reasonCode: "ACCOUNT_REVOKED" });
    const codex = store.observe({ serverId: "server-01", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
    const tunnel = store.observe({ serverId: "server-01", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
    assert.equal((await sync.syncServerLifecycle()).agentsClosed, undefined, "全开时不关任何事件");

    cache = { agentCatalog: [{ id: "codex", enabled: true }, { id: "claude-codewing", enabled: false }] };
    const result = await sync.syncServerLifecycle();
    assert.equal(result.agentsClosed, 1);
    assert.equal(result.changed, true);
    const closed = store.getIncident(claude.incidentId);
    assert.equal(closed.lifecycle, "resolved");
    assert.equal(closed.notes.at(-1).text, "模块已关闭");
    assert.equal(store.getIncident(codex.incidentId).lifecycle, "open");
    assert.equal(store.getIncident(tunnel.incidentId).lifecycle, "open");
    assert.ok(logs.some((m) => /disabled agent modules/.test(m)));
    assert.equal((await sync.syncServerLifecycle()).agentsClosed, undefined, "幂等：已结案的不重复处理");
  } finally {
    sync.beginShutdown();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("处置记录：单隧道重启记 restart-tunnel、通道级记 restart-channel；自动修复带 trigger=auto；账号 / 磁盘事件不记", () => {
  const { incidentStore, ids } = linkFixture();
  linkOperationToIncidents({ incidentStore, operationId: "op-scoped", serverId: "s1" });
  linkOperationToIncidents({ incidentStore, operationId: "op-auto", trigger: "auto" });
  const of = (key) => incidentStore.getIncident(ids[key]).dispositions.map((d) => [d.operationId, d.action, d.trigger, d.outcome]);
  assert.deepEqual(of("s1Tunnel"), [["op-scoped", "restart-tunnel", "manual", null], ["op-auto", "restart-channel", "auto", null]]);
  assert.deepEqual(of("s2Tunnel"), [["op-auto", "restart-channel", "auto", null]]);
  assert.deepEqual(of("s1Agent"), []);
  assert.deepEqual(of("s1Disk"), []);
});
