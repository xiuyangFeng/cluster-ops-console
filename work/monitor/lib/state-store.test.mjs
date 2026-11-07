import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "./event-bus.mjs";
import { createStateStore } from "./state-store.mjs";
import { classifyHealth } from "../monitor-core.mjs";

// ---- 测试用配置与探针事件辅助 ----

function baseConfig() {
  return {
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [
      { id: "codex", name: "Codex", kind: "codex", command: "codex" },
      { id: "claude-codewing", name: "Claude CodeWing", kind: "reclaude", command: "reclaude" },
    ],
    servers: [
      { id: "server-01", name: "主集群服务器 (myserver)", host: "myserver", remotePort: 7891, localPort: 8888 },
      { id: "server-tengxun", name: "腾讯云服务器", host: "tengxunserver", remotePort: 7893, localPort: 8890 },
    ],
  };
}

function probeResult(level, data, reason = "") {
  const checkedAt = Date.now();
  return {
    level,
    reason,
    data,
    checkedAt,
    nextCheckAt: checkedAt + 5000,
    durationMs: 3,
    error: level === "error",
  };
}

function emit(id, layer, result) {
  bus.emit(EVENTS.PROBE_UPDATED, { id, layer, result });
}

const FULL_PROCESSES = {
  localProxy: [{ pid: "11", command: "node work/local_http_connect_proxy.mjs" }],
  reverseTunnel: [{ pid: "12", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" }],
  supervisor: [{ pid: "13", command: "node work/monitor/channel-supervisor.mjs" }],
};

// v2.18：旧 primary-remote 的两份职责拆到两枚采集探针上——
// 远端端口结论进 log-signals（fast, 10s），负载进 collect:slow:<活跃服务器>（60s）。
function feedHealthyChannel() {
  emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
  emit("log-signals", "agents", probeResult("ok", {
    signals: [],
    activeSignals: [],
    lastActivityAt: null,
    sourceIds: ["reclaude-logs", "reclaude-state"],
    ports: { 7891: true },
    remotePortOpen: true,
  }));
  emit("collect:slow:server-01", "resources", probeResult("ok", {
    load: {
      name: "myserver",
      displayName: "主集群服务器 (myserver)",
      ok: true,
      cpu: 42,
      ram: 31,
      disk: 89,
      output: "load stuff",
    },
    gpu: [],
    agents: null,
    ports: { 7891: true },
    remotePortOpen: true,
  }));
}

function feedHealthyAgents() {
  emit("doctor", "agents", probeResult("ok", {
    ok: true,
    code: 0,
    summary: { ok: 18, fail: 0, warn: 0, notes: 1, raw: "18 ok | 1 notes | 0 warn | 0 fail" },
    output: "doctor output",
  }));
  emit("endpoint", "agents", probeResult("ok", {
    ok: true,
    code: 0,
    output: "HTTP/1.1 200 Connection Established\nHTTP/2 405",
  }));
  emit("reclaude", "agents", probeResult("ok", {
    ok: true,
    health: "ready",
    installed: true,
    daemonRunning: true,
    loggedIn: true,
    claudePath: "/home/kai/.reclaude/bin/claude",
    version: "v1.4.2",
    gatewayOk: true,
    gatewayOutput: "gateway ok",
    logsOutput: "logs",
    output: "reclaude output",
  }));
}

function feedTengxunLoad() {
  emit("collect:slow:server-tengxun", "resources", probeResult("ok", {
    load: {
      name: "tengxunserver",
      displayName: "腾讯云服务器",
      ok: true,
      cpu: 12,
      ram: 20,
      disk: 55,
      output: "tengxun load",
    },
  }));
}

// ---- (a) 三层结构正确归并 ----

test("state-store: 探针事件归并为 channel/agents/resources 三层", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    feedTengxunLoad();

    const layers = store.getLayers();

    // channel 层
    assert.equal(layers.channel.level, "ok");
    assert.deepEqual(layers.channel.detail, {
      supervisorUp: true,
      localProxyUp: true,
      tunnelUp: true,
      remotePortOpen: true,
      host: "myserver",
      localPort: 8888,
      remotePort: 7891,
      downSinceMs: null,
    });
    assert.ok(typeof layers.channel.checkedAt === "number");
    assert.ok(typeof layers.channel.nextCheckAt === "number");

    // agents 层
    assert.equal(layers.agents.codex.level, "ok");
    assert.equal(layers.agents.codex.health, "ready");
    assert.ok(String(layers.agents.codex.summary).includes("18"));
    assert.ok(layers.agents.codex.output.includes("doctor output"));
    assert.equal(layers.agents["claude-codewing"].level, "ok");
    assert.equal(layers.agents["claude-codewing"].health, "ready");

    // resources 层
    assert.equal(layers.resources["server-01"].level, "ok");
    assert.equal(layers.resources["server-01"].cpu, 42);
    assert.equal(layers.resources["server-01"].ram, 31);
    assert.equal(layers.resources["server-01"].disk, 89);
    assert.equal(layers.resources["server-tengxun"].level, "ok");
    assert.equal(layers.resources["server-tengxun"].cpu, 12);
    assert.equal(layers.resources["server-tengxun"].output, "tengxun load");
  } finally {
    store.dispose();
  }
});

// ---- (b) getLegacyStatus 的 health 与旧 classifyHealth 语义一致 ----

test("state-store: getLegacyStatus 的 health 与 classifyHealth 对同输入一致", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();

    // 全部健康 → ready
    let legacy = store.getLegacyStatus();
    assert.equal(
      legacy.health,
      classifyHealth({
        shouldBeRunning: true,
        supervisorUp: legacy.supervisorUp,
        localProxyUp: legacy.localProxyUp,
        tunnelUp: legacy.tunnelUp,
        remotePortOpen: legacy.remotePortOpen,
        endpoint: legacy.endpoint,
        doctor: legacy.doctor.summary,
      }),
    );
    assert.equal(legacy.health, "ready");

    // 隧道断开 → down
    emit("processes", "channel", probeResult("warn", {
      processes: { ...FULL_PROCESSES, reverseTunnel: [] },
    }));
    legacy = store.getLegacyStatus();
    assert.equal(legacy.tunnelUp, false);
    assert.equal(
      legacy.health,
      classifyHealth({
        shouldBeRunning: true,
        supervisorUp: legacy.supervisorUp,
        localProxyUp: legacy.localProxyUp,
        tunnelUp: legacy.tunnelUp,
        remotePortOpen: legacy.remotePortOpen,
        endpoint: legacy.endpoint,
        doctor: legacy.doctor.summary,
      }),
    );
    assert.equal(legacy.health, "down");

    // 恢复隧道且 doctor 仅有 warn → ready（warn 是建议级提示，不再降级；只有 fail 降级）
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    emit("doctor", "agents", probeResult("ok", {
      ok: true,
      code: 0,
      summary: { ok: 17, fail: 0, warn: 2, notes: 0, raw: "17 ok | 0 notes | 2 warn | 0 fail" },
      output: "doctor warn output",
    }));
    legacy = store.getLegacyStatus();
    assert.equal(legacy.health, "ready");

    // doctor 出现 fail → degraded
    emit("doctor", "agents", probeResult("error", {
      ok: true,
      code: 0,
      summary: { ok: 16, fail: 1, warn: 0, notes: 0, raw: "16 ok | 0 notes | 0 warn | 1 fail" },
      output: "doctor fail output",
    }));
    legacy = store.getLegacyStatus();
    assert.equal(legacy.health, "degraded");

    // 手动停止 → stopped，且通道旗标强制拉低
    store.setShouldBeRunning(false);
    legacy = store.getLegacyStatus();
    assert.equal(legacy.health, "stopped");
    assert.equal(legacy.shouldBeRunning, false);
    assert.equal(legacy.supervisorUp, false);
    assert.equal(legacy.tunnelUp, false);
    assert.equal(legacy.localProxyUp, false);
    assert.equal(legacy.remotePortOpen, false);
    store.setShouldBeRunning(true);
  } finally {
    store.dispose();
  }
});

test("state-store: getLegacyStatus 保留 v1.5.2 全部旧字段", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    const legacy = store.getLegacyStatus();
    const requiredKeys = [
      "updatedAt", "health", "shouldBeRunning", "supervisorUp", "localProxyUp",
      "tunnelUp", "remotePortOpen", "processes", "remotePort", "doctor",
      "endpoint", "remoteLoad", "activeServerId", "activeAgentId", "activeServer",
      "agents", "agentCatalog", "modules", "hiddenPanels", "agentsStatus", "agentsOverview", "networkChannel", "serversBrief", "log",
    ];
    for (const key of requiredKeys) {
      assert.ok(key in legacy, `legacy status 缺少字段 ${key}`);
    }
    assert.deepEqual(legacy.processes, FULL_PROCESSES);
    assert.deepEqual(legacy.remotePort, { ok: true, code: 0, output: "open" });
    assert.equal(legacy.remoteLoad.ok, true);
    assert.equal(legacy.remoteLoad.output, "load stuff");
    assert.equal(legacy.activeServerId, "server-01");
    assert.equal(legacy.activeServer.host, "myserver");
    assert.equal(legacy.networkChannel.topology, "HTTP_CONNECT_REVERSE_TUNNEL");
    assert.ok(Array.isArray(legacy.log));
    assert.equal(legacy.agentsOverview.length, 2);
    assert.equal(legacy.agentsStatus.codex.health, "ready");

    const lite = store.getLiteStatus();
    for (const key of ["updatedAt", "health", "shouldBeRunning", "supervisorUp", "localProxyUp", "tunnelUp", "remotePortOpen", "remoteLoad", "activeServerId", "activeAgentId"]) {
      assert.ok(key in lite, `lite status 缺少字段 ${key}`);
    }
  } finally {
    store.dispose();
  }
});

// golden 键序：/api/status 与 status-lite 是对外兼容契约（前端/托盘/悬浮岛/旧脚本按字段取值，
// 部分消费方按 JSON 文本比对），键的集合与**顺序**都不许漂移。拆模块时靠这条守住。
test("state-store: getLegacyStatus / getLiteStatus / getLayers 的键序（golden）", () => {
  const config = baseConfig();
  config.servers[0] = { ...config.servers[0], validationProfile: { remoteProxyTest: "true" } };
  const store = createStateStore({ config });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    feedTengxunLoad();
    emit("validation:server-01", "resources", probeResult("ok", { items: [] }));
    const legacy = store.getLegacyStatus();
    assert.deepEqual(Object.keys(legacy), [
      "updatedAt", "health", "summary", "readiness", "shouldBeRunning", "supervisorUp", "localProxyUp",
      "tunnelUp", "remotePortOpen", "processes", "remotePort", "doctor", "endpoint", "claudeEndpoint",
      "remoteLoad", "activeServerId", "activeAgentId", "activeServer", "agents", "agentCatalog", "modules", "hiddenPanels", "agentsStatus",
      "agentsOverview", "networkChannel", "bridgeStages", "serversBrief", "log",
    ]);
    assert.deepEqual(Object.keys(legacy.remoteLoad), ["ok", "output"]);
    assert.deepEqual(Object.keys(legacy.networkChannel), [
      "shouldBeRunning", "localProxyUp", "tunnelUp", "remotePortOpen", "host", "localProxyUrl", "remoteProxyUrl", "topology",
    ]);
    assert.deepEqual(Object.keys(legacy.readiness), ["schemaVersion", "context", "agents"]);
    assert.deepEqual(Object.keys(legacy.summary), [
      "schemaVersion", "transport", "agentCounts", "incidentCount", "otherServersAttention", "headline", "context",
    ]);

    const lite = store.getLiteStatus();
    assert.deepEqual(Object.keys(lite), [
      "updatedAt", "health", "summary", "shouldBeRunning", "supervisorUp", "localProxyUp", "tunnelUp",
      "remotePortOpen", "remoteLoad", "activeServerId", "activeAgentId", "recentTransitions",
      "activeServerLoad", "activeSignals", "bridgeStages",
    ]);
    assert.deepEqual(Object.keys(lite.activeServerLoad), ["cpu", "ram", "disk"]);
    assert.ok(lite.recentTransitions.length > 0);
    assert.deepEqual(Object.keys(lite.recentTransitions[0]), ["ts", "layer", "key", "from", "to", "reason"]);

    const layers = store.getLayers();
    assert.deepEqual(Object.keys(layers), ["channel", "tunnels", "agents", "resources", "validation", "signals"]);
    assert.deepEqual(Object.keys(layers.channel), ["level", "reason", "checkedAt", "nextCheckAt", "detail"]);
    assert.deepEqual(Object.keys(layers.channel.detail), [
      "supervisorUp", "localProxyUp", "tunnelUp", "remotePortOpen", "host", "localPort", "remotePort", "downSinceMs",
    ]);
    assert.deepEqual(Object.keys(layers.tunnels), ["server-01", "server-tengxun"]);
    for (const entry of Object.values(layers.tunnels)) {
      assert.deepEqual(Object.keys(entry), ["level", "reason", "tunnelUp", "remotePortOpen", "checkedAt", "source", "tunnel"]);
    }
    assert.deepEqual(Object.keys(layers.agents), ["codex", "claude-codewing"]);
    assert.deepEqual(Object.keys(layers.agents.codex), ["level", "reason", "checkedAt", "health", "summary", "output", "expiry"]);
    assert.deepEqual(Object.keys(layers.resources), ["server-01", "server-tengxun"]);
    assert.deepEqual(Object.keys(layers.resources["server-01"]), [
      "level", "reason", "checkedAt", "cpu", "ram", "disk", "output", "gpu", "agentsInstalled", "usage", "slurm", "procTop", "tunnelEgress",
    ]);
    assert.deepEqual(Object.keys(layers.validation["server-01"]), ["level", "reason", "items", "checkedAt"]);
    assert.deepEqual(Object.keys(layers.signals), ["level", "reason", "checkedAt", "active", "lastActivityAt"]);
  } finally {
    store.dispose();
  }
});

// 仅监控（tunnel:false）/ 无服务器时 channel.detail 追加 transportRequired:false，位置在 remotePort 之后。
test("state-store: 仅监控视角下 channel.detail 的键序（golden）", () => {
  const config = baseConfig();
  config.servers[0] = { ...config.servers[0], tunnel: false };
  const store = createStateStore({ config });
  try {
    assert.deepEqual(Object.keys(store.getLayers().channel.detail), [
      "supervisorUp", "localProxyUp", "tunnelUp", "remotePortOpen", "host", "localPort", "remotePort",
      "transportRequired", "downSinceMs",
    ]);
  } finally {
    store.dispose();
  }
});

test("state-store: bridge snapshots append status-lite.bridgeStages without changing legacy fields", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    const before = store.getLiteStatus();
    store.ingestBridgeStage({ stage: "local-proxy", ok: false, durationMs: 21, consecutiveFailures: 2, lastSuccessAt: 100 });
    store.ingestBridgeStage({ stage: "ssh-tunnel", ok: true, durationMs: 42, consecutiveFailures: 0, lastSuccessAt: 200, reconnects: 3 });
    const after = store.getLiteStatus();
    assert.deepEqual(after.bridgeStages["local-proxy"], {
      stage: "local-proxy", ok: false, durationMs: 21, consecutiveFailures: 2, lastSuccessAt: 100,
    });
    assert.equal(after.bridgeStages["ssh-tunnel"].reconnects, 3);
    assert.deepEqual(Object.keys(after.bridgeStages), ["local-proxy", "ssh-tunnel", "remote-port", "agent-endpoint"]);
    for (const key of Object.keys(before)) assert.ok(key in after, `existing lite field changed: ${key}`);
  } finally {
    store.dispose();
  }
});

// ---- (c) 熔断跳过时故障不互相覆盖 ----

test("state-store: 通道熔断时 agents 层 skipped 而 resources 层不受影响", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    feedTengxunLoad();

    // 通道断开后调度器对 agents 探针发出 skipped（enabled=false 的调度器行为）
    emit("processes", "channel", probeResult("warn", {
      processes: { ...FULL_PROCESSES, reverseTunnel: [] },
    }));
    emit("doctor", "agents", probeResult("skipped", null, "probe disabled"));
    emit("endpoint", "agents", probeResult("skipped", null, "probe disabled"));
    emit("reclaude", "agents", probeResult("skipped", null, "probe disabled"));

    const layers = store.getLayers();
    assert.equal(layers.agents.codex.level, "skipped");
    assert.equal(layers.agents["claude-codewing"].level, "skipped");

    // resources 层不被 agents 故障覆盖
    assert.equal(layers.resources["server-tengxun"].level, "ok");
    assert.equal(layers.resources["server-tengxun"].cpu, 12);

    // 旧接口保持熔断语义
    const legacy = store.getLegacyStatus();
    assert.equal(legacy.doctor.output, "通道异常，已熔断跳过检查");
    assert.equal(legacy.endpoint.output, "通道异常，已熔断跳过检查");
    assert.equal(legacy.agentsStatus["claude-codewing"].output, "通道异常，已熔断跳过 ReClaude 检查");
    assert.equal(legacy.agentsStatus["claude-codewing"].health, "degraded");
  } finally {
    store.dispose();
  }
});

// ---- (d) 仅 level 变化才 emit STATUS_CHANGED ----

test("state-store: 仅当任一层 level 变化时发出 STATUS_CHANGED", () => {
  const store = createStateStore({ config: baseConfig() });
  const events = [];
  const onChanged = (payload) => events.push(payload);
  bus.on(EVENTS.STATUS_CHANGED, onChanged);
  try {
    // 首个 processes 结果：本地链路都在、远端端口尚无证据 → channel 仍 waiting，不发
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    assert.equal(events.length, 0);

    // fast 采集确认端口开放：channel waiting → ok
    emit("log-signals", "agents", probeResult("ok", {
      activeSignals: [],
      remotePortOpen: true,
    }));
    assert.equal(events.length, 1);

    // 重复同样的结果：level 无变化，不应再发
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    emit("log-signals", "agents", probeResult("ok", {
      activeSignals: [],
      remotePortOpen: true,
    }));
    assert.equal(events.length, 1);

    // 隧道断开：channel ok → error，再次发出
    emit("processes", "channel", probeResult("warn", {
      processes: { ...FULL_PROCESSES, reverseTunnel: [] },
    }));
    assert.equal(events.length, 2);

    // payload 契约：{ layers, lite }
    const payload = events.at(-1);
    assert.ok(payload.layers?.channel);
    assert.ok(payload.lite && "health" in payload.lite && "shouldBeRunning" in payload.lite);
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onChanged);
    store.dispose();
  }
});

// ---- (f) STATUS_CHANGED 携带逐 key transitions 并进入 ring ----

test("level 变化时 STATUS_CHANGED 携带逐 key transitions 并进入 ring", () => {
  const store = createStateStore({ config: baseConfig() });
  const events = [];
  const onChanged = (e) => events.push(e);
  bus.on(EVENTS.STATUS_CHANGED, onChanged);
  try {
    // 本地链路都在，fast 采集确认远端端口未开放 → channel waiting -> error
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    emit("log-signals", "agents", probeResult("ok", { activeSignals: [], remotePortOpen: false }));
    const last = events.at(-1);
    assert.ok(Array.isArray(last.transitions) && last.transitions.length >= 1);
    const t = last.transitions.find((x) => x.layer === "channel");
    assert.equal(t.to, "error");
    assert.equal(typeof t.ts, "number");
    assert.equal(store.getRecentTransitions(5).at(-1).to, "error");
    const lite = store.getLiteStatus();
    assert.ok(Array.isArray(lite.recentTransitions));
    assert.ok(lite.activeServerLoad && typeof lite.activeServerLoad.cpu === "number");
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onChanged);
    store.dispose();
  }
});

test("state-store: 本地链路都在、远端端口首个样本未到 → channel 与 health 保持 waiting；fast 采集超时即判 error", () => {
  const store = createStateStore({ config: baseConfig() });
  const events = [];
  const onChanged = (e) => events.push(e);
  bus.on(EVENTS.STATUS_CHANGED, onChanged);
  try {
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    const waiting = store.getLayers().channel;
    assert.deepEqual([waiting.level, waiting.reason], ["waiting", "等待远端端口探测"]);
    assert.equal(waiting.detail.downSinceMs, null, "未进入 error，不起算持续断开");
    assert.equal(waiting.detail.remotePortOpen, false, "旧字段形状不变：无证据仍回落 false");
    assert.equal(store.getLegacyStatus().health, "waiting");
    assert.equal(store.getLayers().tunnels["server-01"].level, "waiting", "活跃隧道与通道同源");
    assert.equal(events.length, 0, "没有 waiting -> error 的变迁");

    // fast 采集超时（无 data）：error 轮判端口不通——等待是有界的，真故障照常浮出。
    emit("log-signals", "agents", probeResult("error", undefined, "timeout after 15000ms"));
    const channel = store.getLayers().channel;
    assert.deepEqual([channel.level, channel.reason], ["error", "远端端口未开放"]);
    assert.equal(store.getLegacyStatus().health, "down");
    const t = events.at(-1).transitions.find((x) => x.key === "channel");
    assert.deepEqual([t.from, t.to, t.reason], ["waiting", "error", "远端端口未开放"]);
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onChanged);
    store.dispose();
  }
});

test("state-store: 活跃服务器 slow 采集的 ports 段同样算远端端口证据", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    emit("processes", "channel", probeResult("ok", { processes: FULL_PROCESSES }));
    assert.equal(store.getLayers().channel.level, "waiting");
    emit("collect:slow:server-01", "resources", probeResult("ok", { ports: { 7891: true } }));
    assert.equal(store.getLayers().channel.level, "ok");
  } finally {
    store.dispose();
  }
});

test("state-store: setShouldBeRunning 引起 level 变化时同样发出 STATUS_CHANGED", () => {
  const store = createStateStore({ config: baseConfig() });
  const events = [];
  const onChanged = (payload) => events.push(payload);
  bus.on(EVENTS.STATUS_CHANGED, onChanged);
  try {
    feedHealthyChannel();
    const before = events.length;
    store.setShouldBeRunning(false);
    assert.equal(events.length, before + 1);
    assert.equal(events.at(-1).lite.health, "stopped");
    store.setShouldBeRunning(false); // 无变化不重复发
    assert.equal(events.length, before + 1);
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onChanged);
    store.dispose();
  }
});

test("state-store: 注入 validation:server-01 探针结果后，getLayers 和 getLegacyStatus 字段检验", () => {
  const config = baseConfig();
  config.servers[0].validationProfile = {
    remoteProxyTest: "curl",
    workspaceSmokeCommand: "echo"
  };
  const store = createStateStore({ config });
  try {
    const testResult = probeResult("ok", {
      items: [
        { key: "remoteProxyTest", ok: true, durationMs: 120, output: "200" },
        { key: "workspaceSmokeCommand", ok: true, durationMs: 10, output: "ok" }
      ]
    });
    emit("validation:server-01", "resources", testResult);

    const layers = store.getLayers();
    assert.ok(layers.validation);
    assert.ok(layers.validation["server-01"]);
    assert.equal(layers.validation["server-01"].level, "ok");
    assert.equal(layers.validation["server-01"].items.length, 2);

    const legacy = store.getLegacyStatus();
    const expectedFields = [
      "updatedAt", "health", "shouldBeRunning", "supervisorUp", "localProxyUp",
      "tunnelUp", "remotePortOpen", "processes", "remotePort", "doctor", "endpoint",
      "remoteLoad", "activeServerId", "activeAgentId", "activeServer", "agents", "agentCatalog", "modules", "hiddenPanels",
      "agentsStatus", "agentsOverview", "networkChannel", "serversBrief", "log"
    ];
    for (const field of expectedFields) {
      assert.ok(field in legacy, `旧字段 ${field} 应该存在`);
    }
  } finally {
    store.dispose();
  }
});


// ---- (v2.3) claude-endpoint 探针归并与 agent 健康综合 ----

test("state-store: claude-endpoint 结果进入 claudeEndpoint 字段并综合 claude agent 健康", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    emit("reclaude", "agents", probeResult("ok", {
      ok: true, health: "ready", installed: true, loggedIn: true, gatewayOk: true, output: "st",
    }));
    emit("claude-endpoint", "agents", probeResult("error", {
      ok: false, httpCode: 0, latencyMs: null, output: "timeout",
    }, "Claude API 探测未通过"));

    const legacy = store.getLegacyStatus();
    assert.equal(legacy.claudeEndpoint.ok, false);
    assert.equal(legacy.agentsStatus["claude-codewing"].health, "degraded");

    // 端点恢复 → 回到 ready
    emit("claude-endpoint", "agents", probeResult("ok", {
      ok: true, httpCode: 401, latencyMs: 300, output: "HTTP 401",
    }));
    const after = store.getLegacyStatus();
    assert.equal(after.claudeEndpoint.ok, true);
    assert.equal(after.agentsStatus["claude-codewing"].health, "ready");
  } finally {
    store.dispose();
  }
});

test("state-store: claude-endpoint 单独失败时整体 health 只降到 degraded，不误判 down 触发全局 restart（B2）", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents(); // 含健康的 codex doctor/endpoint

    let legacy = store.getLegacyStatus();
    assert.equal(legacy.health, "ready");

    // Claude 链路死，但通道（代理/隧道/远端口）与 codex endpoint 都健康。
    emit("claude-endpoint", "agents", probeResult("error", {
      ok: false, httpCode: 0, latencyMs: null, output: "timeout",
    }, "Claude API 探测未通过"));

    legacy = store.getLegacyStatus();
    assert.equal(legacy.health, "degraded", "单链路（claude endpoint）故障不得拖累到 down");
    assert.equal(legacy.tunnelUp, true, "隧道本身仍然健康，不应被判定为需要重建");
  } finally {
    store.dispose();
  }
});

test("state-store: claude-endpoint 熔断 skipped 不降级 claude agent", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    emit("reclaude", "agents", probeResult("ok", {
      ok: true, health: "ready", installed: true, loggedIn: true, gatewayOk: true, output: "st",
    }));
    emit("claude-endpoint", "agents", probeResult("skipped", null, "probe disabled"));
    const legacy = store.getLegacyStatus();
    assert.equal(legacy.claudeEndpoint.ok, null, "熔断时端点状态未知");
    assert.equal(legacy.agentsStatus["claude-codewing"].health, "ready", "未知不得降级");
  } finally {
    store.dispose();
  }
});

// ---- v2.5：持续断开起点（downSinceMs） ----

test("state-store: channel 进入 error 记录 downSinceMs，恢复后清空", () => {
  let clock = 10000;
  const store = createStateStore({ config: baseConfig(), now: () => clock });
  try {
    // 断开：进程探针报告隧道缺失
    emit("processes", "channel", probeResult("ok", {
      processes: { ...FULL_PROCESSES, reverseTunnel: [] },
    }));
    emit("log-signals", "agents", probeResult("ok", {
      activeSignals: [],
      remotePortOpen: false,
    }));
    emit("collect:slow:server-01", "resources", probeResult("ok", {
      load: { name: "myserver", ok: false, cpu: 0, ram: 0, disk: 0, output: "" },
    }));

    let layers = store.getLayers();
    assert.equal(layers.channel.level, "error");
    assert.equal(layers.channel.detail.downSinceMs, 10000, "进入 error 应记录当前时刻");

    clock = 400000; // 6.5 分钟后仍断开：起点不变（持续断开的语义）
    layers = store.getLayers();
    assert.equal(layers.channel.detail.downSinceMs, 10000, "持续 error 期间起点不得漂移");

    // 恢复
    feedHealthyChannel();
    layers = store.getLayers();
    assert.equal(layers.channel.level, "ok");
    assert.equal(layers.channel.detail.downSinceMs, null, "恢复后应清空");
  } finally {
    store.dispose?.();
  }
});

// ---- 配置移除服务器后的 state-store 残留清理（2026-07-02 v2 终审跟进）----
// 探针注销由 monitor-server 的 refreshConfigIntoKernel 负责（已有 diff+unregister），
// 但 state-store 侧 setConfig 此前只增不删：serversBrief 原样透出在
// getLegacyStatus().serversBrief（未鉴权 /api/status），被删服务器的负载快照会永久残留。

test("state-store: setConfig 移除服务器后 serversBrief 不再残留该服务器条目", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    // server-tengxun 的 load 探针喂入一次负载数据
    emit("collect:slow:server-tengxun", "resources", probeResult("ok", {
      load: { name: "tengxunserver", displayName: "腾讯云服务器", ok: true, cpu: 10, ram: 20, disk: 30, output: "tx load" },
    }));
    assert.ok(store.getLegacyStatus().serversBrief["server-tengxun"], "前提：残留前先有条目");

    // 配置热载：移除 server-tengxun
    const next = baseConfig();
    next.servers = next.servers.filter((s) => s.id !== "server-tengxun");
    store.setConfig(next);

    const legacy = store.getLegacyStatus();
    assert.equal("server-tengxun" in legacy.serversBrief, false, "被删服务器的负载快照不得残留在 /api/status.serversBrief");
    assert.ok(legacy.serversBrief["server-01"], "保留的服务器条目不受影响");
    assert.equal("server-tengxun" in store.getLayers().resources, false);
  } finally {
    store.dispose();
  }
});

test("state-store: 移除后重新加回的服务器从 waiting 起步，不带旧探针结果残影", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    emit("collect:slow:server-tengxun", "resources", probeResult("ok", {
      load: { name: "tengxunserver", displayName: "腾讯云服务器", ok: true, cpu: 99, ram: 88, disk: 77, output: "stale" },
    }));
    // 删掉再加回：模拟运维先移除、后恢复同 id 服务器（可能已指向另一台机器）。
    const without = baseConfig();
    without.servers = without.servers.filter((s) => s.id !== "server-tengxun");
    store.setConfig(without);
    store.setConfig(baseConfig());

    const res = store.getLayers().resources["server-tengxun"];
    assert.equal(res.level, "waiting", "旧 load 探针结果应随移除一并清理，重加回后等待新探测");
    assert.equal(res.cpu, 0, "旧负载数值不得残留（同 id 可能已是另一台机器）");
  } finally {
    store.dispose();
  }
});

test("state-store: setConfig 移除服务器后 validation 残留结果一并清理", () => {
  const config = baseConfig();
  config.servers[1].validationProfile = { remoteProxyTest: "curl" };
  const store = createStateStore({ config });
  try {
    emit("validation:server-tengxun", "resources", probeResult("ok", {
      items: [{ key: "remoteProxyTest", ok: true, durationMs: 5, output: "200" }],
    }));
    assert.ok(store.getLayers().validation["server-tengxun"], "前提：清理前先有 validation 结果");

    const without = baseConfig();
    without.servers = without.servers.filter((s) => s.id !== "server-tengxun");
    store.setConfig(without);

    // 重新加回（带 profile）：不应立刻出现旧 checkedAt 的陈旧 validation 结果。
    const readd = baseConfig();
    readd.servers[1].validationProfile = { remoteProxyTest: "curl" };
    store.setConfig(readd);
    assert.equal("server-tengxun" in store.getLayers().validation, false, "旧 validation 结果不得跨移除残留");
  } finally {
    store.dispose();
  }
});

test("state-store: setConfig 清理残留后 getLegacyStatus 旧字段契约完好", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    const without = baseConfig();
    without.servers = without.servers.filter((s) => s.id !== "server-tengxun");
    store.setConfig(without);
    const legacy = store.getLegacyStatus();
    for (const key of [
      "updatedAt", "health", "shouldBeRunning", "supervisorUp", "localProxyUp",
      "tunnelUp", "remotePortOpen", "processes", "remotePort", "doctor",
      "endpoint", "remoteLoad", "activeServerId", "activeAgentId", "activeServer",
      "agents", "agentCatalog", "modules", "hiddenPanels", "agentsStatus", "agentsOverview", "networkChannel", "serversBrief", "log",
    ]) {
      assert.ok(key in legacy, `清理残留不得破坏旧字段 ${key}`);
    }
  } finally {
    store.dispose();
  }
});

// ---- v2.10 log-signals 聚合 ----

test("state-store: log-signals 探针结果透出 getLayers().signals 与 getLiteStatus().activeSignals", () => {
  const store = createStateStore({ config: baseConfig(), now: () => 5000 });
  try {
    // 未收到探针结果时：waiting 且 activeSignals 为空数组
    assert.equal(store.getLayers().signals.level, "waiting");
    assert.deepEqual(store.getLiteStatus().activeSignals, []);

    const hit = {
      id: "account-revoked", category: "account", severity: "error",
      title: "账号被解绑", advice: "重新登录", sourceId: "reclaude-logs",
      sample: "unexpected status 401 ...", firstSeenAt: 4000, lastSeenAt: 4500,
    };
    emit("log-signals", "agents", {
      level: "error", reason: "1 个活跃卡顿信号",
      data: { signals: [hit], activeSignals: [hit], lastActivityAt: 4500, sourceIds: ["reclaude-logs"] },
      checkedAt: 4600, nextCheckAt: 14600, durationMs: 900, error: false,
    });

    const layers = store.getLayers();
    assert.equal(layers.signals.level, "error");
    assert.equal(layers.signals.active.length, 1);
    assert.equal(layers.signals.active[0].id, "account-revoked");
    assert.equal(layers.signals.lastActivityAt, 4500);
    const lite = store.getLiteStatus();
    assert.equal(lite.activeSignals.length, 1);
    assert.equal(lite.activeSignals[0].title, "账号被解绑");
  } finally {
    store.dispose();
  }
});

test("state-store: log-signals 探针超时(无 data)不清空仍活跃的信号，回退到最近已知快照", () => {
  const store = createStateStore({ config: baseConfig(), now: () => 5000 });
  try {
    const hit = {
      id: "account-revoked", category: "account", severity: "error",
      title: "账号被解绑", advice: "重新登录", sourceId: "reclaude-logs",
      sample: "unexpected status 401 ...", firstSeenAt: 4000, lastSeenAt: 4500,
    };
    // 正常一轮：1 条活跃信号入账。
    emit("log-signals", "agents", {
      level: "error", reason: "1 个活跃卡顿信号",
      data: { signals: [hit], activeSignals: [hit], lastActivityAt: 4500, sourceIds: ["reclaude-logs"] },
      checkedAt: 4600, nextCheckAt: 14600, durationMs: 900, error: false,
    });
    assert.equal(store.getLayers().signals.active.length, 1);

    // 探针超时：结果形如调度器兜底 { level:"error", reason:"timeout after 15000ms", error:true }，
    // 没有 data 键——不得把仍然活跃的信号清空（网络抖动/慢查询 ≠ 故障消失）。
    emit("log-signals", "agents", {
      level: "error", reason: "timeout after 15000ms", error: true,
      checkedAt: 20000, nextCheckAt: 30000, durationMs: 15000,
    });

    const layers = store.getLayers();
    assert.equal(layers.signals.level, "error", "本次 error 结果的 level 仍如实反映");
    assert.equal(layers.signals.reason, "timeout after 15000ms");
    assert.equal(layers.signals.active.length, 1, "active 应回退到最近已知快照，而非被清空");
    assert.equal(layers.signals.active[0].id, "account-revoked");
    assert.equal(layers.signals.lastActivityAt, 4500, "lastActivityAt 也应保留");

    const lite = store.getLiteStatus();
    assert.equal(lite.activeSignals.length, 1, "lite.activeSignals 同样应回退保留");
    assert.equal(lite.activeSignals[0].id, "account-revoked");
  } finally {
    store.dispose();
  }
});

// ---------------------------------------------------------------------------
// v2.18 多隧道 / GPU / 团队看板（设计 §6.3、§6.5）
// ---------------------------------------------------------------------------

// A=活跃（myserver）、B=腾讯云（建隧道）、C=阿里云（tunnel:false 只监控）、D=被屏蔽。
function threeServerConfig() {
  return {
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [{ id: "codex", name: "Codex", kind: "codex", command: "codex" }],
    servers: [
      { id: "server-01", name: "主集群服务器", host: "myserver", remotePort: 7891, localPort: 8888, source: "team" },
      { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", remotePort: 7893, source: "personal" },
      { id: "server-aliyun", name: "阿里云", host: "vpn-aliyun", remotePort: 7894, tunnel: false, source: "personal" },
      { id: "server-blocked", name: "别人的集群", host: "other", remotePort: 7895, disabled: true, source: "team" },
    ],
  };
}

function slowResult(overrides = {}) {
  return probeResult("ok", {
    load: { name: "h", displayName: "h", ok: true, cpu: 1, ram: 2, disk: 3, output: "out" },
    gpu: [],
    agents: null,
    ports: {},
    remotePortOpen: false,
    ...overrides,
  });
}

test("state-store: 次要隧道断开只让 layers.tunnels[B] 变红，health 与主链路不受影响", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    // B 的 slow 采集：远端端口没在监听 → 该服务器隧道判红。
    emit("collect:slow:server-tengxun", "resources", slowResult({ ports: { 7893: false } }));

    const layers = store.getLayers();
    assert.equal(layers.channel.level, "ok", "主链路（活跃服务器）不受次要隧道影响");
    assert.equal(layers.tunnels["server-tengxun"].level, "error");
    assert.equal(layers.tunnels["server-tengxun"].remotePortOpen, false);
    assert.equal(layers.tunnels["server-tengxun"].source, "personal");
    assert.equal(layers.tunnels["server-tengxun"].tunnel, true);
    assert.equal(store.getLegacyStatus().health, "ready", "次要隧道断开不得参与 computeHealth");
  } finally {
    store.dispose();
  }
});

test("state-store: tunnel:false 的服务器 layers.tunnels 恒为 skipped/仅监控", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    emit("collect:slow:server-aliyun", "resources", slowResult({ ports: { 7894: false } }));
    const entry = store.getLayers().tunnels["server-aliyun"];
    assert.equal(entry.level, "skipped");
    assert.equal(entry.reason, "仅监控");
    assert.equal(entry.tunnelUp, null);
    assert.equal(entry.tunnel, false);
  } finally {
    store.dispose();
  }
});

test("state-store: 被屏蔽（disabled）的服务器不出现在 layers.tunnels", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    assert.equal("server-blocked" in store.getLayers().tunnels, false);
  } finally {
    store.dispose();
  }
});

test("state-store: 活跃服务器的 tunnels 项与 layers.channel 同源", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    let layers = store.getLayers();
    assert.equal(layers.tunnels["server-01"].level, layers.channel.level);
    assert.equal(layers.tunnels["server-01"].reason, layers.channel.reason);
    assert.equal(layers.tunnels["server-01"].tunnelUp, true);

    emit("processes", "channel", probeResult("warn", { processes: { ...FULL_PROCESSES, reverseTunnel: [] } }));
    layers = store.getLayers();
    assert.equal(layers.tunnels["server-01"].level, "error");
    assert.equal(layers.tunnels["server-01"].level, layers.channel.level);
    assert.equal(layers.tunnels["server-01"].reason, layers.channel.reason);
  } finally {
    store.dispose();
  }
});

test("state-store: 手动停止通道时所有隧道项 skipped，不刷红", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    emit("collect:slow:server-tengxun", "resources", slowResult({ ports: { 7893: false } }));
    store.setShouldBeRunning(false);
    const layers = store.getLayers();
    assert.equal(layers.tunnels["server-01"].level, "skipped");
    assert.equal(layers.tunnels["server-tengxun"].level, "skipped");
    assert.equal(layers.tunnels["server-tengxun"].reason, "通道已手动停止");
  } finally {
    store.dispose();
  }
});

test("state-store: 自动修复重启整个通道时，「已停止」那一拍的原因写成自动修复；清掉后回到手动停止", () => {
  const store = createStateStore({ config: threeServerConfig() });
  const transitions = [];
  const onStatus = (event) => transitions.push(...(event.transitions || []));
  bus.on(EVENTS.STATUS_CHANGED, onStatus);
  try {
    feedHealthyChannel();
    store.setStopNote("自动修复：重启整个通道");
    store.setShouldBeRunning(false);
    const layers = store.getLayers();
    assert.equal(layers.channel.level, "skipped", "判级不变，只换文案");
    assert.equal(layers.channel.reason, "自动修复：重启整个通道");
    assert.equal(layers.tunnels["server-tengxun"].reason, "自动修复：重启整个通道");
    const stopped = transitions.find((tr) => tr.key === "channel" && tr.to === "skipped");
    assert.equal(stopped?.reason, "自动修复：重启整个通道", "时间线记下的是自动修复，不是「通道已手动停止」");

    store.setStopNote(null);
    assert.equal(store.getLayers().channel.reason, "通道已手动停止");
    store.setStopNote("");
    assert.equal(store.getLayers().tunnels["server-tengxun"].reason, "通道已手动停止");
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, onStatus);
    store.dispose();
  }
});

// Task 2（supervisor 多隧道）落地后 parseProcessList 会带 tunnelsByServer；
// 没落地时非活跃服务器的 tunnelUp 必须是 null（未知），不得瞎猜。
test("state-store: tunnelsByServer 缺失时非活跃服务器 tunnelUp 为 null；存在时按它判定", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    emit("collect:slow:server-tengxun", "resources", slowResult({ ports: { 7893: true } }));
    assert.equal(store.getLayers().tunnels["server-tengxun"].tunnelUp, null);
    assert.equal(store.getLayers().tunnels["server-tengxun"].level, "warn", "隧道态未知时不判红也不判绿");

    emit("processes", "channel", probeResult("ok", {
      processes: {
        ...FULL_PROCESSES,
        tunnelsByServer: {
          "server-01": [{ pid: "12", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" }],
          "server-tengxun": [],
        },
      },
    }));
    let entry = store.getLayers().tunnels["server-tengxun"];
    assert.equal(entry.tunnelUp, false);
    assert.equal(entry.level, "error");

    emit("processes", "channel", probeResult("ok", {
      processes: {
        ...FULL_PROCESSES,
        tunnelsByServer: {
          "server-tengxun": [{ pid: "22", command: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver" }],
        },
      },
    }));
    entry = store.getLayers().tunnels["server-tengxun"];
    assert.equal(entry.tunnelUp, true);
    assert.equal(entry.level, "ok");
  } finally {
    store.dispose();
  }
});

test("state-store: collect:slow 的 gpu 段进 layers.resources[serverId].gpu（4 卡）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    const gpu = [0, 1, 2, 3].map((index) => ({
      index, name: "NVIDIA GeForce RTX 4090", memUsedMb: 8, memTotalMb: 24564, util: 0,
    }));
    emit("collect:slow:server-tengxun", "resources", slowResult({
      gpu,
      agents: { codex: true, reclaude: true, zcode: false, reclaudeActive: "active", user: "kai", hostname: "node05" },
    }));
    const res = store.getLayers().resources["server-tengxun"];
    assert.equal(res.gpu.length, 4);
    assert.deepEqual(res.gpu[3], { index: 3, name: "NVIDIA GeForce RTX 4090", memUsedMb: 8, memTotalMb: 24564, util: 0 });
    assert.equal(res.agentsInstalled.reclaudeActive, "active");
    assert.equal(store.getLayers().resources["server-01"].gpu.length, 0, "没采到 GPU 的服务器是空数组");
  } finally {
    store.dispose();
  }
});

test("state-store: collect:slow 的占用现场进 layers.resources[serverId].procTop；没采到为 null，失败的一轮不抹掉", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    assert.equal(store.getLayers().resources["server-tengxun"].procTop, null, "还没采过");
    const procTop = { sampled: 40, slurm: true, users: [{ user: "kai", cpuJobPct: 1449, cpuOtherPct: 0, rssJobKb: 126000000, rssOtherKb: 0, procsJob: 12, procsOther: 0 }] };
    emit("collect:slow:server-tengxun", "resources", slowResult({ procTop }));
    assert.deepEqual(store.getLayers().resources["server-tengxun"].procTop, procTop);
    assert.equal(store.getLayers().resources["server-01"].procTop, null, "别的服务器不受影响");
    emit("collect:slow:server-tengxun", "resources", {
      level: "error", reason: "timeout after 25000ms", error: true,
      checkedAt: Date.now(), nextCheckAt: Date.now() + 60000, durationMs: 25000,
    });
    assert.deepEqual(store.getLayers().resources["server-tengxun"].procTop, procTop, "这一轮没有 data：保留上次的");
    // 旧采集脚本（没有 proc-top 段）/ 远端 ps 不可用：data 里没有或为 null → 层上是 null
    emit("collect:slow:server-tengxun", "resources", slowResult({}));
    assert.equal(store.getLayers().resources["server-tengxun"].procTop, null);
  } finally {
    store.dispose();
  }
});

test("state-store: collect:slow 的经隧道出网程序进 layers.resources[serverId].tunnelEgress；失败的一轮不抹掉", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    assert.equal(store.getLayers().resources["server-tengxun"].tunnelEgress, null, "还没采过");
    const tunnelEgress = {
      state: "ok", port: 7891, detail: "full",
      total: { conns: 3, sentBytes: 1200, recvBytes: 18000 }, others: { conns: 0, sentBytes: null, recvBytes: null },
      programCount: 1, programs: [{ name: "codex", conns: 3, sentBytes: 1200, recvBytes: 18000 }],
    };
    emit("collect:slow:server-tengxun", "resources", slowResult({ tunnelEgress }));
    assert.deepEqual(store.getLayers().resources["server-tengxun"].tunnelEgress, tunnelEgress);
    assert.equal(store.getLayers().resources["server-01"].tunnelEgress, null, "别的服务器不受影响");
    emit("collect:slow:server-tengxun", "resources", {
      level: "error", reason: "timeout after 25000ms", error: true,
      checkedAt: Date.now(), nextCheckAt: Date.now() + 60000, durationMs: 25000,
    });
    assert.deepEqual(store.getLayers().resources["server-tengxun"].tunnelEgress, tunnelEgress, "这一轮没有 data：保留上次的");
    emit("collect:slow:server-tengxun", "resources", slowResult({}));
    assert.equal(store.getLayers().resources["server-tengxun"].tunnelEgress, null, "旧采集脚本：null");
  } finally {
    store.dispose();
  }
});

test("state-store: collect:slow 无 data 的一轮不抹掉已知 GPU 数据", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    emit("collect:slow:server-tengxun", "resources", slowResult({
      gpu: [{ index: 0, name: "RTX 4090", memUsedMb: 8, memTotalMb: 24564, util: 0 }],
    }));
    emit("collect:slow:server-tengxun", "resources", {
      level: "error", reason: "timeout after 25000ms", error: true,
      checkedAt: Date.now(), nextCheckAt: Date.now() + 60000, durationMs: 25000,
    });
    assert.equal(store.getLayers().resources["server-tengxun"].gpu.length, 1);
  } finally {
    store.dispose();
  }
});

test("state-store: log-signals 报 remotePortOpen:false → channel error 且旧 remotePort 字段同步", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    assert.equal(store.getLayers().channel.level, "ok");
    emit("log-signals", "agents", probeResult("ok", { activeSignals: [], remotePortOpen: false }));
    const layers = store.getLayers();
    assert.equal(layers.channel.level, "error");
    assert.match(layers.channel.reason, /远端端口未开放/);
    const legacy = store.getLegacyStatus();
    assert.equal(legacy.remotePortOpen, false);
    assert.deepEqual(legacy.remotePort, { ok: false, code: 1, output: "closed" });
  } finally {
    store.dispose();
  }
});

test("state-store: log-signals 超时（无 data）判定远端端口不通，不留假的 open", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    emit("log-signals", "agents", {
      level: "error", reason: "timeout after 15000ms", error: true,
      checkedAt: Date.now(), nextCheckAt: Date.now() + 10000, durationMs: 15000,
    });
    assert.equal(store.getLegacyStatus().remotePortOpen, false);
    assert.equal(store.getLayers().channel.level, "error");
  } finally {
    store.dispose();
  }
});

test("state-store: 远端端口的探测结果写进 bridgeStages[remote-port]（此前这一段无人上报、恒为初值）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    const initial = { stage: "remote-port", ok: false, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: null };
    assert.deepEqual(store.getLiteStatus().bridgeStages["remote-port"], initial, "没有任何探测结果时是「尚无数据」的初值");

    emit("log-signals", "agents", { ...probeResult("ok", { activeSignals: [], remotePortOpen: true }), checkedAt: 5000, durationMs: 412 });
    assert.deepEqual(store.getLiteStatus().bridgeStages["remote-port"], {
      stage: "remote-port", ok: true, durationMs: 412, consecutiveFailures: 0, lastSuccessAt: 5000, serverId: "server-01",
    });
    assert.deepEqual(store.getLegacyStatus().bridgeStages["remote-port"], store.getLiteStatus().bridgeStages["remote-port"]);

    // 端口不通：连败按探测轮数累计，最近成功时刻保留
    emit("log-signals", "agents", { ...probeResult("ok", { activeSignals: [], remotePortOpen: false }), checkedAt: 6000, durationMs: 380 });
    emit("log-signals", "agents", { level: "error", reason: "timeout after 15000ms", error: true, checkedAt: 7000, nextCheckAt: 17000, durationMs: 15000 });
    assert.deepEqual(store.getLiteStatus().bridgeStages["remote-port"], {
      stage: "remote-port", ok: false, durationMs: 0, consecutiveFailures: 2, lastSuccessAt: 5000, serverId: "server-01",
    });

    // 熔断跳过的那一轮没有结论：不动这一段
    emit("log-signals", "agents", { level: "skipped", reason: "circuit open", checkedAt: 8000, nextCheckAt: 18000, durationMs: 0 });
    assert.equal(store.getLiteStatus().bridgeStages["remote-port"].consecutiveFailures, 2);

    // 恢复：连败清零
    emit("log-signals", "agents", { ...probeResult("ok", { activeSignals: [], remotePortOpen: true }), checkedAt: 9000, durationMs: 390 });
    assert.deepEqual(store.getLiteStatus().bridgeStages["remote-port"], {
      stage: "remote-port", ok: true, durationMs: 390, consecutiveFailures: 0, lastSuccessAt: 9000, serverId: "server-01",
    });

    // 换一台查看：这一段说的是上一台，回到初值等新一轮探测
    const next = threeServerConfig();
    next.activeServerId = next.servers.find((server) => server.id !== "server-01").id;
    store.setConfig(next);
    assert.deepEqual(store.getLiteStatus().bridgeStages["remote-port"], initial);
  } finally {
    store.dispose();
  }
});

test("state-store: 多条隧道的 ssh-tunnel 快照各存各的，对外只给查看中的那台", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    const tunnel = (serverId, extra) => ({ stage: "ssh-tunnel", ok: true, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: 100, serverId, channelServerId: "server-01", ...extra });
    assert.equal(store.ingestBridgeStage(tunnel("server-01", { reconnects: 1, fastFailures: 0 })), true);
    // 另一台隧道后上报：不覆盖查看中这台的计数
    assert.equal(store.ingestBridgeStage(tunnel("server-tengxun", { reconnects: 641, fastFailures: 567, ok: false, consecutiveFailures: 3 })), true);
    const viewed = store.getLiteStatus().bridgeStages["ssh-tunnel"];
    assert.equal(viewed.serverId, "server-01");
    assert.deepEqual([viewed.ok, viewed.reconnects, viewed.fastFailures], [true, 1, 0]);

    // 合并语义不变：同一台的后续快照省略的字段沿用旧值
    store.ingestBridgeStage({ stage: "ssh-tunnel", ok: true, serverId: "server-01", durationMs: 7 });
    assert.deepEqual([store.getLiteStatus().bridgeStages["ssh-tunnel"].durationMs, store.getLiteStatus().bridgeStages["ssh-tunnel"].reconnects], [7, 1]);

    // 换到另一台查看：槽位立刻换成那台自己的快照，不必等它下一次上报
    const next = threeServerConfig();
    next.activeServerId = "server-tengxun";
    store.setConfig(next);
    const swapped = store.getLiteStatus().bridgeStages["ssh-tunnel"];
    assert.deepEqual([swapped.serverId, swapped.ok, swapped.reconnects, swapped.consecutiveFailures], ["server-tengxun", false, 641, 3]);

    // 换到一台还没上报过的：「尚无数据」的初值，不沿用上一台的
    const third = threeServerConfig();
    third.servers.push({ id: "server-new", name: "新服务器", host: "new", remotePort: 7899, source: "personal" });
    third.activeServerId = "server-new";
    store.setConfig(third);
    assert.deepEqual(store.getLiteStatus().bridgeStages["ssh-tunnel"], { stage: "ssh-tunnel", ok: false, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: null });

    // 不带 serverId 的旧格式快照照旧进槽位（单隧道时代的 supervisor）
    store.ingestBridgeStage({ stage: "ssh-tunnel", ok: true, durationMs: 42, consecutiveFailures: 0, lastSuccessAt: 200, reconnects: 3 });
    assert.equal(store.getLiteStatus().bridgeStages["ssh-tunnel"].reconnects, 3);
  } finally {
    store.dispose();
  }
});

test("state-store: 团队 hub 已移除，layers 不再含 team 层", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    emit("collect:slow:server-01", "resources", slowResult());
    assert.equal("team" in store.getLayers(), false);
  } finally {
    store.dispose();
  }
});

test("state-store: /api/status 旧字段形状不变（remotePortOpen / activeServerLoad / serversBrief / activeServer）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    const legacy = store.getLegacyStatus();
    assert.equal(legacy.remotePortOpen, true);
    assert.deepEqual(legacy.remotePort, { ok: true, code: 0, output: "open" });
    assert.equal(legacy.activeServer.id, "server-01");
    assert.deepEqual(legacy.serversBrief["server-01"], {
      name: "myserver",
      displayName: "主集群服务器 (myserver)",
      ok: true,
      cpu: 42,
      ram: 31,
      disk: 89,
      output: "load stuff",
    });
    assert.deepEqual(store.getLiteStatus().activeServerLoad, { cpu: 42, ram: 31, disk: 89 });
  } finally {
    store.dispose();
  }
});

// ---- v2.18：次要隧道的变迁进时间线与 history（levelMap 的 tunnel:<serverId> 键）----

function collectTransitions(fn) {
  const seen = [];
  const listener = ({ transitions }) => seen.push(...(transitions || []));
  bus.on(EVENTS.STATUS_CHANGED, listener);
  try {
    fn();
  } finally {
    bus.off(EVENTS.STATUS_CHANGED, listener);
  }
  return seen;
}

test("state-store: 次要隧道断开/恢复各产出一条 tunnel:<serverId> 变迁，reason 取该隧道自己的", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    // 隧道进程在、远端端口没开 → 该隧道判红。
    emit("processes", "channel", probeResult("ok", {
      processes: {
        ...FULL_PROCESSES,
        tunnelsByServer: {
          "server-01": [{ pid: "12", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" }],
          "server-tengxun": [{ pid: "22", command: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver" }],
        },
      },
    }));

    const down = collectTransitions(() => {
      emit("collect:slow:server-tengxun", "resources", slowResult({ ports: { 7893: false } }));
    });
    const downEntry = down.find((t) => t.key === "tunnel:server-tengxun");
    assert.ok(downEntry, "次要隧道断开必须进时间线，否则按天复盘里查不到");
    assert.equal(downEntry.layer, "tunnels");
    assert.equal(downEntry.to, "error");
    assert.equal(downEntry.reason, store.getLayers().tunnels["server-tengxun"].reason);
    assert.match(downEntry.reason, /远端端口未开放/);

    const up = collectTransitions(() => {
      emit("collect:slow:server-tengxun", "resources", slowResult({ ports: { 7893: true } }));
    });
    const upEntry = up.find((t) => t.key === "tunnel:server-tengxun");
    assert.ok(upEntry, "恢复也要留痕，否则只知道断没断不知道断了多久");
    assert.equal(upEntry.from, "error");
    assert.equal(upEntry.to, "ok");
    assert.equal(upEntry.reason, "隧道正常");
  } finally {
    store.dispose();
  }
});

test("state-store: 活跃服务器不产生 tunnel:<id> 变迁（已由 channel 键覆盖，不重复计数）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    feedHealthyAgents();
    const transitions = collectTransitions(() => {
      // 活跃服务器的隧道进程消失 → channel 判红。
      emit("processes", "channel", probeResult("warn", { processes: { ...FULL_PROCESSES, reverseTunnel: [] } }));
    });
    assert.ok(transitions.some((t) => t.key === "channel"), "主链路走 channel 键");
    assert.equal(
      transitions.some((t) => t.key === "tunnel:server-01"),
      false,
      "同一次断开不得在时间线里出现两条",
    );
  } finally {
    store.dispose();
  }
});

test("state-store: tunnel:false 的「仅监控」服务器不进 levelMap（无可观测变迁）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    const transitions = collectTransitions(() => {
      emit("collect:slow:server-aliyun", "resources", slowResult({ ports: { 7894: false } }));
    });
    assert.equal(transitions.some((t) => t.key === "tunnel:server-aliyun"), false);
  } finally {
    store.dispose();
  }
});

// ---- v2.18：主链路的 tunnelUp 按活跃服务器那一格判，不看并集 ----

test("state-store: 只有次要隧道活着时 layers.channel 仍判断开（并集不得伪装成主链路健康）", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    emit("processes", "channel", probeResult("ok", {
      processes: {
        ...FULL_PROCESSES, // reverseTunnel 并集里还有一条（腾讯云那条）
        tunnelsByServer: {
          "server-01": [],
          "server-tengxun": [{ pid: "22", command: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver" }],
        },
      },
    }));
    const layers = store.getLayers();
    assert.equal(layers.channel.detail.tunnelUp, false);
    assert.equal(layers.channel.level, "error");
    assert.match(layers.channel.reason, /SSH 隧道未开启/);
  } finally {
    store.dispose();
  }
});

test("state-store: 没有 tunnelsByServer（旧形状/首轮）时 channel 仍按 reverseTunnel 判定", () => {
  const store = createStateStore({ config: threeServerConfig() });
  try {
    feedHealthyChannel();
    assert.equal(store.getLayers().channel.detail.tunnelUp, true);
  } finally {
    store.dispose();
  }
});

test("活跃仅监控不判channel down，禁用后删除资源卡且丢弃迟到采集", () => {
  const config = { ...baseConfig(), activeServerId: "only", servers: [{ id: "only", host: "only.invalid", tunnel: false }] };
  const store = createStateStore({ config });
  try {
    emit("processes", "channel", probeResult("ok", { processes: { supervisor: [{ pid: "1" }], localProxy: [], reverseTunnel: [] } }));
    assert.equal(store.getLayers().channel.level, "skipped");
    assert.equal(store.getLayers().channel.detail.tunnelUp, null);
    assert.equal(store.getLayers().channel.detail.localProxyUp, null);
    assert.notEqual(store.getLegacyStatus().health, "down");
    store.setConfig({ ...config, servers: [{ ...config.servers[0], disabled: true }] });
    emit("collect:slow:only", "resources", probeResult("ok", { load: { ok: true, cpu: 50, ram: 50, disk: 50 } }));
    assert.equal("only" in store.getLegacyStatus().serversBrief, false);
    assert.equal("only" in store.getLayers().resources, false);
    assert.equal(store.getLayers().channel.reason, "未配置可用服务器");
    assert.notEqual(store.getLegacyStatus().health, "down");
  } finally { store.dispose(); }
});

// ---- 历史基线：全量级别快照与键集合变化通知 ----

test("state-store: getLevelSnapshot 给出当前视角与全量级别；查看中的那台不单列 tunnel 键", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    feedHealthyChannel();
    const snap = store.getLevelSnapshot();
    assert.equal(snap.view, "server-01");
    assert.equal(snap.levels.channel, "ok");
    assert.equal("tunnel:server-01" in snap.levels, false);
    assert.ok("tunnel:server-tengxun" in snap.levels);
    assert.ok("agent:codex" in snap.levels && "res:server-01" in snap.levels);
    snap.levels.channel = "tampered";
    assert.equal(store.getLevelSnapshot().levels.channel, "ok", "返回的是副本");
  } finally {
    store.dispose();
  }
});

test("state-store: 切换查看视角 / 删掉服务器时发 LEVELS_REBASED（键集合换了却没有变迁）；无关的配置变化不发", () => {
  const store = createStateStore({ config: baseConfig() });
  const rebased = [];
  const onRebased = (payload) => rebased.push(payload);
  bus.on(EVENTS.LEVELS_REBASED, onRebased);
  try {
    feedHealthyChannel();
    store.setConfig({ ...baseConfig(), activeAgentId: "claude-codewing" });
    assert.equal(rebased.length, 0, "视角与键集合都没变");

    store.setConfig({ ...baseConfig(), activeServerId: "server-tengxun" });
    assert.equal(rebased.length, 1);
    assert.equal(rebased[0].view, "server-tengxun");
    assert.equal("tunnel:server-tengxun" in rebased[0].levels, false, "新视角那台改由 channel 代表，不再单列");
    assert.ok("tunnel:server-01" in rebased[0].levels, "原视角那台开始单列");

    const without = baseConfig();
    without.servers = without.servers.filter((s) => s.id !== "server-tengxun");
    store.setConfig(without);
    assert.equal(rebased.length, 2);
    assert.equal(rebased[1].view, "server-01");
    assert.equal(Object.keys(rebased[1].levels).some((key) => key.includes("server-tengxun")), false);
  } finally {
    bus.off(EVENTS.LEVELS_REBASED, onRebased);
    store.dispose();
  }
});

// ---- v2.47 模块开关：被关掉的 Agent 状态清理 / 重新打开从初态起步 ----

function withoutAgent(agentId) {
  const config = baseConfig();
  config.agents = config.agents.filter((agent) => agent.id !== agentId);
  config.activeAgentId = config.agents[0]?.id || "";
  return config;
}

test("state-store: 关掉 Agent → agentsStatus / 旧字段 / layers / 探针结果全部清掉，健康聚合不再计入", () => {
  const store = createStateStore({ config: baseConfig() });
  const rebased = [];
  const onRebased = (payload) => rebased.push(payload);
  bus.on(EVENTS.LEVELS_REBASED, onRebased);
  try {
    feedHealthyChannel();
    emit("doctor", "agents", probeResult("ok", { ok: true, code: 0, summary: { ok: 18, fail: 0, warn: 0, notes: 0, raw: "18 ok" }, output: "doctor ok" }));
    emit("endpoint", "agents", probeResult("ok", { ok: true, output: "endpoint ok" }));
    emit("reclaude", "agents", probeResult("ok", { ok: true, health: "ready", installed: true, loggedIn: true, gatewayOk: true, output: "st" }));
    emit("claude-endpoint", "agents", probeResult("error", { ok: false, httpCode: 0, latencyMs: null, output: "timeout" }, "Claude API 探测未通过"));
    assert.equal(store.getLegacyStatus().agentsStatus["claude-codewing"].health, "degraded");
    assert.equal(store.getLegacyStatus().health, "degraded", "claude 端点失败拉低全局健康");

    store.setConfig(withoutAgent("claude-codewing"));
    const legacy = store.getLegacyStatus();
    assert.ok(!("claude-codewing" in legacy.agentsStatus), "agentsStatus 不残留");
    assert.ok(!("claudeEndpoint" in legacy), "适配器旧字段随之消失");
    assert.ok(!("claude-codewing" in store.getLayers().agents));
    assert.ok(!legacy.agentsOverview.some((a) => a.id === "claude-codewing"));
    assert.equal(legacy.health, "ready", "被关掉的 Agent 不再参与健康聚合");
    // 键从快照里消失不是故障恢复：不产出变迁，另记一份全量基线（与删停服务器同语义）。
    assert.equal(rebased.length, 1);
    assert.ok(!("agent:claude-codewing" in rebased[0].levels));
  } finally {
    bus.off(EVENTS.LEVELS_REBASED, onRebased);
    store.dispose();
  }
});

test("state-store: 重新打开 Agent → 私有状态按 createInitialState 重建，显示「检测中...」，不复用旧结论", () => {
  const store = createStateStore({ config: baseConfig() });
  try {
    emit("doctor", "agents", probeResult("ok", { ok: true, code: 0, summary: { ok: 18, fail: 0, warn: 0, notes: 0, raw: "18 ok" }, output: "doctor ok", expiry: { state: "ok" } }));
    emit("endpoint", "agents", probeResult("ok", { ok: true, output: "endpoint ok" }));
    assert.equal(store.getLegacyStatus().agentsStatus.codex.health, "ready");

    store.setConfig(withoutAgent("codex"));
    const off = store.getLegacyStatus();
    assert.ok(!("codex" in off.agentsStatus));
    assert.ok(!("doctor" in off) && !("endpoint" in off), "codex 旧字段消失");
    assert.ok(!("codex" in store.getLayers().agents));

    store.setConfig(baseConfig());
    const back = store.getLegacyStatus();
    assert.deepEqual(back.agentsStatus.codex, { ok: false, health: "waiting", output: "检测中..." });
    assert.equal(back.doctor.output, "检测中...", "doctor 旧字段回到初值");
    assert.equal(store.getLayers().agents.codex.level, "waiting");
    assert.equal(store.getLayers().agents.codex.expiry ?? null, null, "凭证过期信息不复用");
  } finally {
    store.dispose();
  }
});
