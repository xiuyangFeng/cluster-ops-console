// /api/status、/api/status-lite 与 SSE status 帧的金样测试（键序敏感）。
//
// 用真实 createStateStore（固定时钟 + 固定配置）喂确定的探针结果，把三条状态通路的输出
// 与 status-payload.golden.json 逐字节比对（JSON.stringify 相等 = 值与键序都相同）。
// 金样由拆分前的实现生成；任何一处键序或字段变化都会在这里变红。确属有意的协议演进时，
// 用 UPDATE_GOLDEN=1 node --test <本文件> 重新生成并在提交里说明原因。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { bus, EVENTS } from "../event-bus.mjs";
import { createHttpRouter } from "../http-router.mjs";
import { createStateStore } from "../state-store.mjs";

const GOLDEN_URL = new URL("./status-payload.golden.json", import.meta.url);
const NOW = Date.UTC(2026, 8, 1, 0, 0, 0);
const TOKEN = "golden";

const CONFIG = {
  activeServerId: "server-01",
  activeAgentId: "codex",
  agents: [
    { id: "codex", name: "Codex", kind: "codex", command: "codex" },
    { id: "claude-codewing", name: "Claude CodeWing", kind: "reclaude", command: "reclaude" },
  ],
  servers: [
    { id: "server-01", name: "主集群服务器", host: "myserver", remotePort: 7891, localPort: 8888 },
    { id: "server-02", name: "备用服务器", host: "backup", remotePort: 7893, localPort: 8890 },
  ],
};

function result(level, data, reason = "") {
  return { level, reason, data, checkedAt: NOW, nextCheckAt: NOW + 5000, durationMs: 3, error: level === "error" };
}

function emitProbe(id, layer, probeResult) {
  bus.emit(EVENTS.PROBE_UPDATED, { id, layer, result: probeResult });
}

function makeRouter(store, extra = {}) {
  return createHttpRouter({
    authToken: TOKEN,
    version: "9.9.9-golden",
    publicDir: "/nonexistent-golden",
    logsDir: "/nonexistent-golden",
    ndjsonTailLines: 100,
    maxSseConnections: 4,
    sseHeartbeatMs: 60000,
    store,
    scheduler: {},
    metricsStore: {},
    bootstrapRunner: {},
    toolkit: {},
    appendLog() {},
    operationStorage: { run: (_ctx, fn) => fn() },
    getConfig: async () => ({}),
    ...extra,
  });
}

const SIDECARS = {
  storageSweeper: { getState: () => ({ usedBytes: 1024, budgetBytes: 4096, lastSweepAt: null, evicted: 0 }) },
  getRuntimeExtras: () => ({ autoRepairExhausted: false, tunnelPortForeign: [], onboarding: "ready" }),
  getConnectionTargets: () => ({ schemaVersion: 1, source: "config-only", targets: [{ serverId: "server-01", localPort: 8888 }] }),
};

async function get(router, url) {
  const listeners = {};
  const req = {
    url,
    method: "GET",
    headers: { host: "127.0.0.1:8877", "x-auth-token": TOKEN },
    on(event, handler) {
      listeners[event] = handler;
      return req;
    },
  };
  const res = {
    raw: "",
    writableLength: 0,
    setHeader() {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.raw += String(chunk);
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.raw += String(chunk);
    },
    destroy() {},
  };
  await router.handleHttpRequest(req, res);
  return { res, close: () => listeners.close?.() };
}

// "event: x\ndata: {...}\n\n" 串 → [{ event, data }]（data 解析回对象，保留键序）。
function parseFrames(raw) {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return { event: eventLine.replace(/^event: /, ""), data: JSON.parse(dataLine.replace(/^data: /, "")) };
    });
}

async function captureScenario() {
  const store = createStateStore({ config: structuredClone(CONFIG), now: () => NOW });
  try {
    // 通道三进程在、slow 采集报远端端口未开放 → channel=error，给后续的 level 变迁留出空间。
    // （只有 processes、尚无端口证据时 channel 保持 waiting，error 由下面的 slow 采集给出。）
    emitProbe("processes", "channel", result("ok", {
      processes: {
        localProxy: [{ pid: "11", command: "node work/local_http_connect_proxy.mjs" }],
        reverseTunnel: [{ pid: "12", command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" }],
        supervisor: [{ pid: "13", command: "node work/monitor/channel-supervisor.mjs" }],
      },
    }));
    emitProbe("collect:slow:server-01", "resources", result("ok", {
      load: { name: "myserver", displayName: "主集群服务器", ok: true, cpu: 42, ram: 31, disk: 89, output: "load" },
      gpu: [],
      agents: null,
      ports: { 7891: false },
      remotePortOpen: false,
    }));

    const router = makeRouter(store, SIDECARS);
    const bare = makeRouter(store);
    const status = JSON.parse((await get(router, "/api/status")).res.raw);
    const statusBare = JSON.parse((await get(bare, "/api/status")).res.raw);
    const statusLite = JSON.parse((await get(router, "/api/status-lite")).res.raw);

    const sse = await get(router, "/api/events");
    const sseInitial = parseFrames(sse.res.raw);
    sse.res.raw = "";
    // 远端端口开放 → channel 由 error 转 ok：state-store 先发 STATUS_CHANGED（status 帧），
    // 随后 SSE 自己的 PROBE_UPDATED 监听再推 probe 帧——两帧的先后由监听器注册序决定。
    emitProbe("log-signals", "agents", result("ok", {
      signals: [],
      activeSignals: [],
      lastActivityAt: null,
      sourceIds: ["reclaude-logs"],
      ports: { 7891: true },
      remotePortOpen: true,
    }));
    const sseAfterProbe = parseFrames(sse.res.raw);
    sse.close();

    return { status, statusBare, statusLite, sseInitial, sseAfterProbe };
  } finally {
    store.dispose();
  }
}

const LEGACY_KEYS = [
  "updatedAt", "health", "summary", "readiness", "shouldBeRunning", "supervisorUp", "localProxyUp", "tunnelUp",
  "remotePortOpen", "processes", "remotePort", "doctor", "endpoint", "claudeEndpoint", "remoteLoad", "activeServerId",
  "activeAgentId", "activeServer", "agents", "agentCatalog", "modules", "hiddenPanels", "agentsStatus", "agentsOverview", "networkChannel", "bridgeStages",
  "serversBrief", "log",
];
const LITE_KEYS = [
  "updatedAt", "health", "summary", "shouldBeRunning", "supervisorUp", "localProxyUp", "tunnelUp", "remotePortOpen",
  "remoteLoad", "activeServerId", "activeAgentId", "recentTransitions", "activeServerLoad", "activeSignals", "bridgeStages",
];
const SIDECAR_KEYS = ["autoRepairExhausted", "tunnelPortForeign", "onboarding", "storage"];

test("状态通路金样：/api/status、/api/status-lite、SSE status/probe 帧逐字节不变", async () => {
  // statusBare 不进金样：它必须恰好等于完整载荷去掉注入依赖带来的字段（下面单独断言）。
  const { statusBare, ...actual } = await captureScenario();
  const { connectionTargets: _targets, autoRepairExhausted: _a, tunnelPortForeign: _t, onboarding: _o, storage: _s, ...legacyAndLayers } = actual.status;
  assert.equal(JSON.stringify(statusBare), JSON.stringify(legacyAndLayers));
  if (process.env.UPDATE_GOLDEN === "1") {
    writeFileSync(GOLDEN_URL, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const golden = JSON.parse(readFileSync(GOLDEN_URL, "utf8"));
  assert.deepStrictEqual(actual, golden);
  assert.equal(JSON.stringify(actual), JSON.stringify(golden), "值相同但键序变了");
});

test("状态通路键序：legacy → layers → version → connectionTargets → 旁路字段 → storage", async () => {
  const { status, statusBare, statusLite, sseInitial, sseAfterProbe } = await captureScenario();
  assert.deepEqual(Object.keys(status), [...LEGACY_KEYS, "layers", "version", "connectionTargets", ...SIDECAR_KEYS]);
  assert.deepEqual(Object.keys(statusBare), [...LEGACY_KEYS, "layers", "version"], "旁路依赖未注入时字段整体缺席");
  assert.deepEqual(Object.keys(statusLite), LITE_KEYS, "/api/status-lite 不补挂旁路字段");

  assert.deepEqual(sseInitial.map((frame) => frame.event), ["status"]);
  assert.deepEqual(Object.keys(sseInitial[0].data), ["lite", "layers"]);
  assert.deepEqual(Object.keys(sseInitial[0].data.lite), [...LITE_KEYS, ...SIDECAR_KEYS], "SSE lite 与 /api/status 同样补挂旁路字段");

  assert.deepEqual(sseAfterProbe.map((frame) => frame.event), ["status", "probe"]);
  assert.deepEqual(Object.keys(sseAfterProbe[0].data), ["lite", "layers"]);
  assert.deepEqual(Object.keys(sseAfterProbe[0].data.lite), [...LITE_KEYS, ...SIDECAR_KEYS]);
  assert.deepEqual(Object.keys(sseAfterProbe[1].data), ["id", "layer", "level", "reason", "checkedAt"]);
});
