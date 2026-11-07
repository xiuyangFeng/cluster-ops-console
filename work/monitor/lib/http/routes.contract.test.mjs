// HTTP 路由契约（表驱动特征测试）：锁死「方法 + 路径 + 哪些依赖缺席」→ 状态码 / 响应体，
// 以及每条路由调用了哪个依赖函数、传了什么参数。它先于路由拆分写成，拆分后必须原样通过——
// 任何一行变红都意味着对外协议（前端 / Electron / 灵动岛依赖的状态码与载荷形状）被改了。
//
// 约定：
//   - 所有依赖函数都经 fn(name, impl) 包一层记录调用；断言时只比对该行 calls 里出现过的
//     名字（按调用序），函数参数统一归一成 "<fn>"。
//   - POST 统一带固定 x-operation-id，operationContext 因而是确定值 CTX。
//   - 纯文本 404（"not found"、无任何响应头）= 所有路由组都没接住；JSON 404 = 路由自己回的。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { createHttpRouter } from "../http-router.mjs";
import { createLogger } from "../logger.mjs";
import { computeProbeStats } from "../metrics-store.mjs";
import { applyModulePreferences, buildModuleCatalog } from "../modules/catalog.mjs";
import { computeConfigRevision } from "../runtime-snapshot.mjs";

const TOKEN = "tok";
const OP_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CTX = { operationId: OP_ID };

// ---- 静态资源夹具：public/ 内含正常文件、非白名单后缀、目录与逃逸符号链接 ----
const ROOT = mkdtempSync(path.join(tmpdir(), "http-contract-"));
const PUBLIC_DIR = path.join(ROOT, "public");
const LOGS_DIR = path.join(ROOT, "logs");
mkdirSync(path.join(PUBLIC_DIR, "assets", "js"), { recursive: true });
mkdirSync(path.join(PUBLIC_DIR, "assets", "img"), { recursive: true });
mkdirSync(path.join(PUBLIC_DIR, "assets", "dir.js"), { recursive: true });
mkdirSync(LOGS_DIR, { recursive: true });
writeFileSync(path.join(PUBLIC_DIR, "index.html"), "<!doctype html>index");
writeFileSync(path.join(PUBLIC_DIR, "styles.css"), "body{}");
writeFileSync(path.join(PUBLIC_DIR, "app.js"), "// app");
writeFileSync(path.join(PUBLIC_DIR, "assets", "js", "a.js"), "export const a = 1;");
writeFileSync(path.join(PUBLIC_DIR, "assets", "img", "i.svg"), "<svg/>");
writeFileSync(path.join(PUBLIC_DIR, "assets", "page.html"), "<p>page</p>");
writeFileSync(path.join(PUBLIC_DIR, "assets", "notes.txt"), "text");
writeFileSync(path.join(ROOT, "secret.js"), "// outside public");
symlinkSync(path.join(ROOT, "secret.js"), path.join(PUBLIC_DIR, "assets", "js", "escape.js"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// ---- 依赖桩的固定返回值 ----
const LAYERS = { channel: { level: "ok" } };
const LEGACY = { health: "ok", running: true };
const LITE = { health: "lite" };
const CONNECTION_TARGETS = { schemaVersion: 1, targets: [] };
const EXTRAS = { autoRepairExhausted: false, tunnelPortForeign: ["s9"] };
const STORAGE = { usedBytes: 1, budgetBytes: 2, lastSweepAt: null, evicted: 0 };
const FULL_STATUS = { ...LEGACY, layers: LAYERS, version: "1.2.3", connectionTargets: CONNECTION_TARGETS, ...EXTRAS, storage: STORAGE };
const FULL_STATUS_KEYS = ["health", "running", "layers", "version", "connectionTargets", "autoRepairExhausted", "tunnelPortForeign", "storage"];
const STATUS_CALLS = [
  ["store.getLayers"],
  ["store.getLegacyStatus", { layers: LAYERS }],
  ["getConnectionTargets"],
  ["storageSweeper.getState"],
  ["getRuntimeExtras"],
];
const TRANSITIONS = [{ ts: 1, key: "a" }, { ts: 2, key: "b" }, { ts: 3, key: "c" }];
const SAMPLES = [{ ok: true, latencyMs: 5, ts: 1 }];
const PARSED_CONFIG = { activeServerId: "s2", servers: [{ id: "s2", host: "h2" }] };
// 模块目录夹具：zcode 被个人层关掉（agents 已过滤、agentCatalog 保留全部）。
const MODULE_CONFIG = applyModulePreferences({
  activeServerId: "s2",
  activeAgentId: "codex",
  servers: [{ id: "s2", host: "h2" }],
  agents: [{ id: "codex", name: "Codex", kind: "codex" }, { id: "zcode", name: "Zcode", kind: "zcode" }],
  disabledModules: ["agent:zcode"],
});
const MODULE_CONFIG_ZCODE_ON = applyModulePreferences({ ...MODULE_CONFIG, agents: MODULE_CONFIG.agentCatalog.map(({ enabled, ...agent }) => agent), disabledModules: [] });
const CONTEXT_KEY = computeConfigRevision(PARSED_CONFIG);
const BOOTSTRAP_STEPS = [
  { id: "node", status: "idle" },
  { id: "busy", status: "running" },
  { id: "win", status: "idle", disabled: true, disabledReason: "windows-only" },
  { id: "bare", status: "idle", disabled: true },
];
const incident = (id, attention) => ({ incidentId: id, lifecycle: "open", attention, internal: "not-exposed" });
const TOP_PROCESSES = Array.from({ length: 60 }, (_v, pid) => ({ pid }));

function freshSample() {
  return { observedAt: new Date().toISOString(), quality: "ok", cpu: 3, topProcesses: TOP_PROCESSES };
}

function httpError(message, fields) {
  return Object.assign(new Error(message), fields);
}

function baseDeps(fn) {
  return {
    authToken: TOKEN,
    version: "1.2.3",
    publicDir: PUBLIC_DIR,
    logsDir: LOGS_DIR,
    ndjsonTailLines: 100,
    maxSseConnections: 1,
    sseHeartbeatMs: 60000,
    store: {
      getLayers: fn("store.getLayers", () => LAYERS),
      getLegacyStatus: fn("store.getLegacyStatus", () => ({ ...LEGACY })),
      getLiteStatus: fn("store.getLiteStatus", () => ({ ...LITE })),
      getRecentTransitions: fn("store.getRecentTransitions", () => TRANSITIONS.map((t) => ({ ...t }))),
    },
    scheduler: {
      forceRun: fn("scheduler.forceRun", async (id) => {
        if (id === "nope") throw new Error("未注册的探针: nope");
        if (id === "boom") throw new Error("kaboom");
        return { level: "ok" };
      }),
      acquireSshSlot: fn("scheduler.acquireSshSlot", async () => () => {}),
    },
    metricsStore: { query: fn("metricsStore.query", () => ({ samples: SAMPLES })) },
    historyStore: {
      listDays: fn("historyStore.listDays", async () => ["2026-09-01"]),
      readDay: fn("historyStore.readDay", async () => [{ ts: 1 }]),
    },
    storageSweeper: {
      getState: fn("storageSweeper.getState", () => STORAGE),
      sweep: fn("storageSweeper.sweep", async () => ({ evicted: [{ path: "/x", bytes: 1 }], usedBytes: 5, budgetBytes: 10, overBudget: false })),
    },
    getRuntimeExtras: fn("getRuntimeExtras", () => EXTRAS),
    bootstrapRunner: {
      getState: fn("bootstrapRunner.getState", () => ({ steps: BOOTSTRAP_STEPS })),
      runStep: fn("bootstrapRunner.runStep", async () => {}),
    },
    toolkit: {
      getMainServerConfig: fn("toolkit.getMainServerConfig", (config) => (config.servers || []).find((s) => s.id === config.activeServerId) || null),
      daemons: {
        status: fn("daemons.status", async (serverId) => {
          if (serverId === "other") throw httpError("只能查看 / 操作当前查看中的服务器，请刷新页面", { status: 409 });
          return { eligible: true, serverId: "s1", daemons: [], starting: null };
        }),
        start: fn("daemons.start", async (daemon) => {
          if (daemon === "t3code") throw httpError("正在启动 Paseo，请稍候", { status: 409 });
          return { daemon, result: "alreadyRunning", ok: true };
        }),
        forward: fn("daemons.forward", async ({ port }) => {
          if (port === 9999) throw httpError("端口 9999 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」", { status: 409 });
          return { forward: { serverId: "s1", port, localPort: 51814, url: "http://127.0.0.1:51814/" }, status: null };
        }),
        closeForward: fn("daemons.closeForward", async ({ serverId, port }) => ({ closed: true, serverId, port, status: null })),
      },
    },
    getConfig: fn("getConfig", async () => ({ activeServerId: "s1" })),
    setActiveServerConfig: fn("setActiveServerConfig", async (id) => id !== "ghost"),
    setActiveAgentConfig: fn("setActiveAgentConfig", async (id) => id !== "ghost"),
    savePersonalConfig: fn("savePersonalConfig", async () => {}),
    refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => PARSED_CONFIG),
    startChannel: fn("startChannel", async () => {}),
    stopChannel: fn("stopChannel", async () => {}),
    restartChannel: fn("restartChannel", async () => ({ ok: true })),
    getConnectionTargets: fn("getConnectionTargets", () => CONNECTION_TARGETS),
    operationsRunner: {
      preview: fn("operationsRunner.preview", async (data) => {
        if (data.scope === "bad") throw httpError("非法范围", { status: 422 });
        return { previewId: "op-p1" };
      }),
      run: fn("operationsRunner.run", async ({ previewId, operationId }) => {
        if (previewId === "busy") throw httpError("互斥", { status: 409 });
        return { operationId, previewId, state: "queued" };
      }),
      getOperation: fn("operationsRunner.getOperation", async (id) => {
        if (id === "missing") return null;
        if (id === "denied") throw httpError("拒绝", { status: 403 });
        if (id === "plain") throw new Error("无状态码");
        return { operationId: id, state: "succeeded" };
      }),
    },
    incidentStore: {
      query: fn("incidentStore.query", () => ({ incidents: [], nextCursor: null })),
      summarize: fn("incidentStore.summarize", ({ days } = {}) => ({ days: [], total: 0, types: [], requestedDays: days ?? null })),
      acknowledge: fn("incidentStore.acknowledge", (id) => {
        if (id === "ghost") throw httpError("事件不存在", { status: 400 });
        return incident(id, { acknowledgedAt: 1 });
      }),
      snooze: fn("incidentStore.snooze", (id, durationMs) => incident(id, { snoozedUntil: durationMs })),
      unsnooze: fn("incidentStore.unsnooze", (id) => incident(id, {})),
    },
    getBuildInfo: fn("getBuildInfo", async ({ clientBuild }) => ({ running: "1.2.3", clientBuild })),
    dataPlaneUpgrader: {
      upgrade: fn("dataPlaneUpgrader.upgrade", async (body) => {
        if (!Array.isArray(body?.components)) return { status: 400, body: { error: "bad components" } };
        if (body.components.includes("fail")) return { status: 200, body: { ok: false, reason: "pid changed" } };
        if (body.components.includes("busy")) return { status: 409, body: { error: "in flight" } };
        return { status: 200, body: { ok: true } };
      }),
      isInFlight: fn("dataPlaneUpgrader.isInFlight", () => false),
    },
    getPersonalConfig: fn("getPersonalConfig", async () => ({ servers: [] })),
    serverRegistry: {
      list: fn("serverRegistry.list", () => ({ servers: [] })),
      add: fn("serverRegistry.add", async (data) => {
        if (data.name === "dup") throw httpError("重复", { status: 409, code: "duplicate", errors: [{ field: "name" }] });
        return { id: "new" };
      }),
      testConnection: fn("serverRegistry.testConnection", async () => ({ ok: false, code: "auth-required" })),
      suggestPort: fn("serverRegistry.suggestPort", async () => ({ port: 7900 })),
      claimPort: fn("serverRegistry.claimPort", async () => ({ remotePort: 7900, registered: true })),
      disable: fn("serverRegistry.disable", async (id) => {
        if (id === "conflict") throw httpError("配置已变化", { status: 409, code: "revision-conflict" });
        if (id === "plain") throw new Error("无状态码");
        return { ok: true };
      }),
      enable: fn("serverRegistry.enable", async () => ({ ok: true })),
      restore: fn("serverRegistry.restore", async () => ({ ok: true })),
      putCredentials: fn("serverRegistry.putCredentials", async () => ({ ok: true })),
      confirmHostKey: fn("serverRegistry.confirmHostKey", () => ({ confirmed: true })),
      previewHostKey: fn("serverRegistry.previewHostKey", async () => ({ lines: ["k"], linesHash: "h" })),
      update: fn("serverRegistry.update", async () => ({ ok: true })),
      remove: fn("serverRegistry.remove", async () => ({ ok: true })),
    },
    localResourceProbe: {
      getLast: fn("localResourceProbe.getLast", () => freshSample()),
      sample: fn("localResourceProbe.sample", async () => freshSample()),
    },
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

// 调用参数归一：函数 → "<fn>"，便于 deepEqual。
function normalize(value) {
  if (typeof value === "function") return "<fn>";
  if (Array.isArray(value)) return value.map(normalize);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  return value;
}

function makeHarness({ omit = [], deps } = {}) {
  const calls = [];
  const logs = [];
  const runs = [];
  const fn = (name, impl = () => undefined) => (...args) => {
    calls.push([name, ...normalize(args)]);
    return impl(...args);
  };
  const all = baseDeps(fn);
  const overrides = typeof deps === "function" ? deps(fn) : {};
  for (const [key, value] of Object.entries(overrides)) {
    all[key] = isPlainObject(value) && isPlainObject(all[key]) ? { ...all[key], ...value } : value;
  }
  for (const key of omit) delete all[key];
  const router = createHttpRouter({
    ...all,
    appendLog: (message, fields) => logs.push(fields === undefined ? [message] : [message, fields]),
    operationStorage: {
      run: (context, work) => {
        runs.push(context);
        return work();
      },
    },
  });

  async function request({ method = "GET", url, body, raw, token = TOKEN, headers = {} }) {
    const reqHeaders = { host: "127.0.0.1:8877", "x-operation-id": OP_ID, ...headers };
    if (token !== null) reqHeaders["x-auth-token"] = token;
    const listeners = {};
    const req = {
      method,
      url,
      headers: reqHeaders,
      on(event, handler) {
        listeners[event] = handler;
        return req;
      },
      async *[Symbol.asyncIterator]() {
        if (raw !== undefined) yield Buffer.from(raw, "utf8");
        else if (body !== undefined) yield Buffer.from(JSON.stringify(body), "utf8");
      },
    };
    const res = {
      status: null,
      headers: null,
      setHeaders: {},
      raw: "",
      writableLength: 0,
      setHeader(name, value) {
        this.setHeaders[String(name).toLowerCase()] = value;
      },
      writeHead(status, resHeaders) {
        this.status = status;
        this.headers = resHeaders ?? null;
        return this;
      },
      write(chunk) {
        this.raw += String(chunk);
        return true;
      },
      end(chunk) {
        if (chunk !== undefined) this.raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        this.ended = true;
        return this;
      },
      destroy() {
        this.destroyed = true;
      },
    };
    await router.handleHttpRequest(req, res);
    let json;
    try {
      json = JSON.parse(res.raw);
    } catch {
      json = undefined;
    }
    return { res, json, close: () => listeners.close?.() };
  }

  return { request, calls, logs, runs };
}

async function runRow(row) {
  const harness = makeHarness(row);
  const { res, json } = await harness.request(row);
  assert.equal(res.status, row.status, `状态码：${row.method || "GET"} ${row.url}`);
  if ("json" in row) assert.deepStrictEqual(json, row.json);
  if ("keys" in row) assert.deepEqual(Object.keys(json), row.keys, "顶层键序");
  if ("text" in row) {
    assert.equal(res.raw, row.text);
    if (row.text === "not found") assert.equal(res.headers, null, "路由未命中的 404 不带任何响应头");
  }
  if ("contentType" in row) assert.equal(res.headers?.["content-type"], row.contentType);
  if (row.calls) {
    const names = new Set(row.calls.map((call) => call[0]));
    assert.deepStrictEqual(harness.calls.filter((call) => names.has(call[0])), row.calls, "依赖调用序列与参数");
  }
  for (const name of row.notCalled || []) {
    assert.equal(harness.calls.some((call) => call[0] === name), false, `不应调用 ${name}`);
  }
  if (row.logs) assert.deepStrictEqual(harness.logs, row.logs, "appendLog 记录");
  return harness;
}

const NOT_FOUND = { status: 404, text: "not found" };
const INVALID_BODY = { status: 400, json: { error: "invalid request body" } };

// ---------------------------------------------------------------------------
// 表：按今天 routeRequest 的分组顺序排列
// ---------------------------------------------------------------------------

const ROWS = [
  // ---- 静态资源 ----
  { url: "/", status: 200, text: "<!doctype html>index", contentType: "text/html; charset=utf-8" },
  { url: "/styles.css", status: 200, text: "body{}", contentType: "text/css; charset=utf-8" },
  { url: "/app.js", status: 200, text: "// app", contentType: "text/javascript; charset=utf-8" },
  { url: "/assets/js/a.js", status: 200, text: "export const a = 1;", contentType: "text/javascript; charset=utf-8" },
  { url: "/assets/js/a.js?v=123", status: 200, text: "export const a = 1;", contentType: "text/javascript; charset=utf-8" },
  { url: "/assets/img/i.svg", status: 200, contentType: "image/svg+xml" },
  { url: "/assets/page.html", status: 200, contentType: "text/html; charset=utf-8" },
  { url: "/assets/notes.txt", status: 403, json: { error: "forbidden" } },
  { url: "/assets/js", status: 403, json: { error: "forbidden" } },
  { url: "/assets/dir.js", status: 404, text: "not found" },
  { url: "/assets/missing.js", status: 404, text: "not found" },
  { url: "/assets/%E0%A4%A.js", status: 400, json: { error: "bad path" } },
  { url: "/assets/..%2f..%2fsecret.js", status: 403, json: { error: "forbidden" } },
  { url: "/assets/js/escape.js", status: 403, json: { error: "forbidden" } },
  { url: "/assets/a.js", token: null, status: 404, text: "not found" },
  { method: "POST", url: "/app.js", ...NOT_FOUND },
  { url: "/other.html", ...NOT_FOUND },
  // 根文件读盘失败（打包残缺等）→ 路由层 500 兜底。拆分前这里是未 await 的 `return sendFile()`，
  // 拒绝越过 try 由 monitor-server 的同形兜底（同样 500 + "error: …" 日志）接住；拆分后
  // 统一在路由层处理，对外响应不变。
  { url: "/", deps: () => ({ publicDir: path.join(ROOT, "logs") }), status: 500 },

  // ---- session / status / build-info / status-lite / timeline ----
  { url: "/api/session", token: null, status: 200, json: { token: TOKEN } },
  { url: "/api/status", status: 200, json: FULL_STATUS, keys: FULL_STATUS_KEYS, calls: STATUS_CALLS },
  {
    url: "/api/status",
    omit: ["getConnectionTargets", "storageSweeper", "getRuntimeExtras"],
    status: 200,
    json: { ...LEGACY, layers: LAYERS, version: "1.2.3" },
    keys: ["health", "running", "layers", "version"],
  },
  {
    url: "/api/status",
    deps: (fn) => ({
      getConnectionTargets: fn("getConnectionTargets", () => {
        throw new Error("投影失败");
      }),
      getRuntimeExtras: fn("getRuntimeExtras", () => "not-an-object"),
      storageSweeper: {
        getState: fn("storageSweeper.getState", () => {
          throw new Error("sweeper 坏了");
        }),
      },
    }),
    status: 200,
    json: { ...LEGACY, layers: LAYERS, version: "1.2.3" },
  },
  { url: "/api/status", deps: () => ({ storageSweeper: null }), status: 200, keys: ["health", "running", "layers", "version", "connectionTargets", "autoRepairExhausted", "tunnelPortForeign"] },
  { url: "/api/status", deps: () => ({ getRuntimeExtras: null }), status: 200, keys: ["health", "running", "layers", "version", "connectionTargets", "storage"] },
  { url: "/api/build-info?clientBuild=abc", status: 200, json: { running: "1.2.3", clientBuild: "abc" }, calls: [["getBuildInfo", { clientBuild: "abc" }]] },
  { url: "/api/build-info", status: 200, calls: [["getBuildInfo", { clientBuild: "" }]] },
  { url: `/api/build-info?clientBuild=${"x".repeat(200)}`, status: 200, calls: [["getBuildInfo", { clientBuild: "x".repeat(128) }]] },
  { url: "/api/status-lite", status: 200, json: LITE, calls: [["store.getLiteStatus"]], notCalled: ["storageSweeper.getState", "getRuntimeExtras"] },
  { url: "/api/timeline", status: 200, json: { events: [{ ts: 3, key: "c" }, { ts: 2, key: "b" }, { ts: 1, key: "a" }] }, calls: [["store.getRecentTransitions", 200]] },
  { url: "/api/timeline?since=2", status: 200, json: { events: [{ ts: 3, key: "c" }, { ts: 2, key: "b" }] } },
  { url: "/api/timeline?since=", status: 200, json: { events: [{ ts: 3, key: "c" }, { ts: 2, key: "b" }, { ts: 1, key: "a" }] } },
  { url: "/api/timeline?limit=1", status: 200, json: { events: [{ ts: 3, key: "c" }] } },
  { url: "/api/timeline?limit=0", status: 200, json: { events: [{ ts: 3, key: "c" }, { ts: 2, key: "b" }, { ts: 1, key: "a" }] } },
  { url: "/api/timeline?limit=-3", status: 200, json: { events: [{ ts: 3, key: "c" }] } },
  { url: "/api/timeline?since=abc", status: 200, json: { events: [] } },
  { method: "POST", url: "/api/status", ...NOT_FOUND },

  // ---- metrics / history ----
  {
    url: "/api/metrics?serverId=s1&kind=load&since=5",
    status: 200,
    json: { samples: SAMPLES },
    calls: [["metricsStore.query", { serverId: "s1", kind: "load", since: 5 }]],
  },
  { url: "/api/metrics", status: 200, calls: [["metricsStore.query", { serverId: undefined, kind: undefined, since: undefined }]] },
  { url: "/api/metrics?since=", status: 200, calls: [["metricsStore.query", { serverId: undefined, kind: undefined, since: undefined }]] },
  { url: "/api/metrics", omit: ["metricsStore"], status: 500 },
  // 长范围降采样（7 天 / 30 天）：参数先校验、不读盘；通过后按本机日期逐个读历史日文件。
  { url: "/api/metrics/range?serverId=s1&range=24h", status: 400, json: { error: "invalid range" }, notCalled: ["historyStore.readDay"] },
  { url: "/api/metrics/range?serverId=s1", status: 400, json: { error: "invalid range" }, notCalled: ["historyStore.readDay"] },
  { url: "/api/metrics/range?range=7d", status: 400, json: { error: "invalid serverId" }, notCalled: ["historyStore.readDay"] },
  { url: "/api/metrics/range?serverId=..%2Fx&range=7d", status: 400, json: { error: "invalid serverId" }, notCalled: ["historyStore.readDay"] },
  { url: "/api/metrics/range?serverId=s1&range=7d", omit: ["historyStore"], status: 503, json: { error: "history unavailable" } },
  {
    url: "/api/metrics/range?serverId=s1&range=30d",
    status: 200,
    keys: ["serverId", "range", "stepMs", "since", "generatedAt", "samples", "extremes"],
  },
  { method: "POST", url: "/api/metrics/range?serverId=s1&range=7d", ...NOT_FOUND },
  { url: "/api/history/days", status: 200, json: { days: ["2026-09-01"] }, calls: [["historyStore.listDays"]] },
  { url: "/api/history?date=2026-09-01", status: 200, json: { date: "2026-09-01", entries: [{ ts: 1 }] }, calls: [["historyStore.readDay", "2026-09-01"]] },
  { url: "/api/history?date=2026-09-01&types=transition,levels", status: 200, json: { date: "2026-09-01", entries: [{ ts: 1 }] }, calls: [["historyStore.readDay", "2026-09-01"]] },
  { url: "/api/history?date=2026-09-01&types=sample", status: 200, json: { date: "2026-09-01", entries: [] } },
  { url: "/api/history?date=2026-9-1", status: 400, json: { error: "invalid date" }, notCalled: ["historyStore.readDay"] },
  { url: "/api/history", status: 400, json: { error: "invalid date" } },
  { url: "/api/probes/history?id=Doctor", status: 400, json: { error: "invalid probe id" } },
  { url: "/api/probes/history", status: 400, json: { error: "invalid probe id" } },
  {
    url: "/api/probes/history?id=doctor&since=5",
    status: 200,
    json: { samples: SAMPLES, stats: computeProbeStats(SAMPLES) },
    calls: [["metricsStore.query", { serverId: "probe:doctor", kind: "probe", since: 5 }]],
  },

  // ---- 探针手动运行 ----
  {
    method: "POST",
    url: "/api/probe/doctor/run",
    status: 200,
    json: { ok: true, result: { level: "ok" } },
    calls: [["scheduler.forceRun", "doctor", { overrideBreaker: true }]],
    logs: [["probe doctor requested", CTX]],
  },
  { method: "POST", url: "/api/probe/collect%3Aslow%3As1/run", status: 200, calls: [["scheduler.forceRun", "collect:slow:s1", { overrideBreaker: true }]] },
  { method: "POST", url: "/api/probe/nope/run", status: 404, json: { error: "unknown probe" } },
  { method: "POST", url: "/api/probe/boom/run", status: 500, json: { error: "kaboom" }, logs: [["probe boom requested", CTX], ["error: kaboom", CTX]] },
  { url: "/api/probe/doctor/run", ...NOT_FOUND },

  // ---- bootstrap ----
  { url: "/api/bootstrap/state", status: 200, json: { steps: BOOTSTRAP_STEPS }, calls: [["bootstrapRunner.getState"]] },
  {
    method: "POST",
    url: "/api/bootstrap/step/node/run",
    status: 200,
    json: { started: true },
    calls: [["bootstrapRunner.runStep", "node", CTX]],
    logs: [["bootstrap step node requested", CTX]],
  },
  { method: "POST", url: "/api/bootstrap/step/busy/run", status: 200, json: { started: false, reason: "already running" }, notCalled: ["bootstrapRunner.runStep"] },
  { method: "POST", url: "/api/bootstrap/step/win/run", status: 200, json: { started: false, reason: "windows-only" }, notCalled: ["bootstrapRunner.runStep"] },
  { method: "POST", url: "/api/bootstrap/step/bare/run", status: 200, json: { started: false, reason: "unsupported-platform" } },
  { method: "POST", url: "/api/bootstrap/step/ghost/run", status: 404, json: { error: "unknown bootstrap step" } },
  { method: "POST", url: "/api/bootstrap/step/Node/run", status: 404, json: { error: "unknown bootstrap step" }, notCalled: ["bootstrapRunner.getState"] },
  { method: "POST", url: "/api/bootstrap/step/node", status: 404, json: { error: "unknown bootstrap step" } },
  { url: "/api/bootstrap/state", omit: ["bootstrapRunner"], status: 500 },

  // ---- config ----
  { url: "/api/config", status: 200, json: { activeServerId: "s1" }, calls: [["getConfig"]] },
  { url: "/api/config", omit: ["getConfig"], status: 500 },
  { url: "/api/config/personal", status: 200, json: { config: { servers: [] } }, calls: [["getPersonalConfig"]] },
  {
    method: "POST",
    url: "/api/config/personal",
    body: { servers: [] },
    status: 200,
    json: { success: true, restartRequired: true },
    calls: [["savePersonalConfig", { servers: [] }, CTX], ["refreshConfigIntoKernel"]],
  },
  { method: "POST", url: "/api/config/personal", body: [], status: 400, json: { error: "invalid personal config" }, notCalled: ["savePersonalConfig"] },
  { method: "POST", url: "/api/config/personal", raw: "{broken", status: 400, json: { error: "invalid personal config" } },
  { method: "POST", url: "/api/config/personal", status: 400, json: { error: "invalid personal config" } },
  {
    method: "POST",
    url: "/api/config/personal",
    body: {},
    deps: (fn) => ({
      savePersonalConfig: fn("savePersonalConfig", async () => {
        throw httpError("字段非法", { status: 422, errors: [{ field: "x" }], code: "not-exposed" });
      }),
    }),
    status: 422,
    json: { error: "字段非法", errors: [{ field: "x" }] },
    notCalled: ["refreshConfigIntoKernel"],
  },
  {
    method: "POST",
    url: "/api/config/personal",
    body: {},
    deps: (fn) => ({
      savePersonalConfig: fn("savePersonalConfig", async () => {
        throw new Error("");
      }),
    }),
    status: 400,
    json: { error: "failed to save config" },
  },
  {
    method: "POST",
    url: "/api/config/personal",
    body: {},
    deps: (fn) => ({
      refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => {
        throw httpError("刷新失败", { status: 500 });
      }),
    }),
    status: 500,
    json: { error: "刷新失败" },
  },
  {
    method: "POST",
    url: "/api/config/active",
    body: { activeServerId: "s2" },
    status: 200,
    json: { success: true },
    calls: [
      ["setActiveServerConfig", "s2", CTX],
      ["refreshConfigIntoKernel"],
      ["toolkit.getMainServerConfig", PARSED_CONFIG],
      ["scheduler.forceRun", "log-signals", { contextKey: CONTEXT_KEY }],
      ["scheduler.forceRun", "collect:slow:s2", { contextKey: CONTEXT_KEY }],
    ],
  },
  {
    method: "POST",
    url: "/api/config/active",
    body: { activeServerId: "s3" },
    deps: (fn) => ({
      toolkit: { getMainServerConfig: fn("toolkit.getMainServerConfig", () => null) },
      refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => ({ activeServerId: "fallback" })),
    }),
    status: 200,
    calls: [
      ["scheduler.forceRun", "log-signals", { contextKey: computeConfigRevision({ activeServerId: "fallback" }) }],
      ["scheduler.forceRun", "collect:slow:fallback", { contextKey: computeConfigRevision({ activeServerId: "fallback" }) }],
    ],
  },
  { method: "POST", url: "/api/config/active", body: { activeServerId: "ghost" }, status: 400, json: { error: "invalid server id" }, notCalled: ["refreshConfigIntoKernel", "scheduler.forceRun"] },
  { method: "POST", url: "/api/config/active", ...INVALID_BODY, notCalled: ["setActiveServerConfig"] },
  { method: "POST", url: "/api/config/active", raw: "null", ...INVALID_BODY },
  // 只挡 null（空体 / 坏 JSON / 字面量 null）；数组等非对象正文照样放行，由 setActiveServerConfig 判定。
  { method: "POST", url: "/api/config/active", body: [], status: 200, calls: [["setActiveServerConfig", undefined, CTX]] },
  {
    method: "POST",
    url: "/api/config/agent-active",
    body: { activeAgentId: "codex" },
    status: 200,
    json: { success: true },
    calls: [
      ["setActiveAgentConfig", "codex", CTX],
      ["refreshConfigIntoKernel"],
      ["scheduler.forceRun", "doctor", { contextKey: CONTEXT_KEY }],
      ["scheduler.forceRun", "endpoint", { contextKey: CONTEXT_KEY }],
      ["scheduler.forceRun", "reclaude", { contextKey: CONTEXT_KEY }],
      ["scheduler.forceRun", "claude-endpoint", { contextKey: CONTEXT_KEY }],
    ],
  },
  { method: "POST", url: "/api/config/agent-active", body: { activeAgentId: "ghost" }, status: 400, json: { error: "invalid agent id" } },
  { method: "POST", url: "/api/config/agent-active", raw: "{broken", ...INVALID_BODY },

  // ---- v2.47 监控模块开关 / 界面面板显隐 ----
  { url: "/api/modules", deps: (fn) => ({ getConfig: fn("getConfig", async () => MODULE_CONFIG) }), status: 200, json: { modules: buildModuleCatalog(MODULE_CONFIG) } },
  {
    method: "POST",
    url: "/api/modules",
    body: { id: "agent:zcode", enabled: false },
    deps: (fn) => ({
      setModuleEnabled: fn("setModuleEnabled", async () => true),
      refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => MODULE_CONFIG),
      getConfig: fn("getConfig", async () => MODULE_CONFIG),
    }),
    status: 200,
    json: { success: true, modules: buildModuleCatalog(MODULE_CONFIG) },
    calls: [["setModuleEnabled", "agent:zcode", false, CTX], ["refreshConfigIntoKernel"]],
    notCalled: ["scheduler.forceRun"],
  },
  {
    method: "POST",
    url: "/api/modules",
    body: { id: "agent:zcode", enabled: true },
    deps: (fn) => ({
      setModuleEnabled: fn("setModuleEnabled", async () => true),
      refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => MODULE_CONFIG_ZCODE_ON),
      getConfig: fn("getConfig", async () => MODULE_CONFIG_ZCODE_ON),
    }),
    status: 200,
    calls: [
      ["setModuleEnabled", "agent:zcode", true, CTX],
      ["refreshConfigIntoKernel"],
      ["scheduler.forceRun", "zcode-status", { contextKey: computeConfigRevision(MODULE_CONFIG_ZCODE_ON) }],
    ],
  },
  {
    method: "POST",
    url: "/api/modules",
    body: { id: "core.signals", enabled: false },
    deps: (fn) => ({ setModuleEnabled: fn("setModuleEnabled", async () => false) }),
    status: 400,
    json: { error: "unknown or locked module" },
    notCalled: ["refreshConfigIntoKernel", "scheduler.forceRun"],
  },
  { method: "POST", url: "/api/modules", body: { id: "usage", enabled: "no" }, deps: (fn) => ({ setModuleEnabled: fn("setModuleEnabled", async () => true) }), status: 400, json: { error: "invalid module toggle" }, notCalled: ["setModuleEnabled"] },
  { method: "POST", url: "/api/modules", body: { enabled: true }, deps: (fn) => ({ setModuleEnabled: fn("setModuleEnabled", async () => true) }), status: 400, json: { error: "invalid module toggle" }, notCalled: ["setModuleEnabled"] },
  { method: "POST", url: "/api/modules", raw: "{broken", ...INVALID_BODY },
  {
    method: "POST",
    url: "/api/modules",
    body: { id: "usage", enabled: false },
    deps: (fn) => ({ setModuleEnabled: fn("setModuleEnabled", async () => { throw httpError("偏好设置未通过校验", { status: 400, errors: [{ field: "disabledModules" }] }); }) }),
    status: 400,
    json: { error: "偏好设置未通过校验", errors: [{ field: "disabledModules" }] },
    notCalled: ["refreshConfigIntoKernel"],
  },
  {
    method: "POST",
    url: "/api/ui-prefs",
    body: { hiddenPanels: ["view.usage"] },
    deps: (fn) => ({
      setHiddenPanels: fn("setHiddenPanels", async () => {}),
      refreshConfigIntoKernel: fn("refreshConfigIntoKernel", async () => ({ ...PARSED_CONFIG, hiddenPanels: ["view.usage"] })),
    }),
    status: 200,
    json: { success: true, hiddenPanels: ["view.usage"] },
    calls: [["setHiddenPanels", ["view.usage"], CTX], ["refreshConfigIntoKernel"]],
  },
  { method: "POST", url: "/api/ui-prefs", body: { hiddenPanels: "view.usage" }, deps: (fn) => ({ setHiddenPanels: fn("setHiddenPanels", async () => {}) }), status: 400, json: { error: "invalid ui preferences" }, notCalled: ["setHiddenPanels"] },
  { method: "POST", url: "/api/ui-prefs", body: [], deps: (fn) => ({ setHiddenPanels: fn("setHiddenPanels", async () => {}) }), status: 400, json: { error: "invalid ui preferences" }, notCalled: ["setHiddenPanels"] },
  { method: "POST", url: "/api/ui-prefs", raw: "{broken", ...INVALID_BODY },
  {
    method: "POST",
    url: "/api/ui-prefs",
    body: { hiddenPanels: ["bad id!"] },
    deps: (fn) => ({ setHiddenPanels: fn("setHiddenPanels", async () => { throw httpError("偏好设置未通过校验", { status: 400, errors: [{ field: "hiddenPanels", message: "包含非法 id" }] }); }) }),
    status: 400,
    json: { error: "偏好设置未通过校验", errors: [{ field: "hiddenPanels", message: "包含非法 id" }] },
    notCalled: ["refreshConfigIntoKernel"],
  },
  // 用量 / 作业模块关闭：读接口 200 { disabled: true }，不触达服务。
  { url: "/api/usage/summary", deps: () => ({ getConfig: async () => ({ modules: { usage: false, jobs: true } }) }), status: 200, json: { disabled: true } },
  { url: "/api/usage/session?key=a", deps: () => ({ getConfig: async () => ({ modules: { usage: false, jobs: true } }) }), status: 200, json: { disabled: true } },
  { url: "/api/jobs?serverId=s1", deps: () => ({ getConfig: async () => ({ modules: { usage: true, jobs: false } }) }), status: 200, json: { disabled: true } },
  { url: "/api/usage/summary", status: 503, json: { error: "usage unavailable" } },
  { url: "/api/jobs?serverId=s1", status: 503, json: { error: "jobs unavailable" } },

  // ---- 远端守护进程（v2.55）：模块关闭 / 服务缺失 503；serverId 可选但必须合格；daemon 只认白名单 ----
  { url: "/api/daemons", status: 200, json: { eligible: true, serverId: "s1", daemons: [], starting: null }, calls: [["daemons.status", null, { acquireSshSlot: "<fn>", fresh: false }]] },
  { url: "/api/daemons?serverId=s1&fresh=1", status: 200, calls: [["daemons.status", "s1", { acquireSshSlot: "<fn>", fresh: true }]] },
  { url: "/api/daemons?serverId=other", status: 409, json: { error: "只能查看 / 操作当前查看中的服务器，请刷新页面" } },
  { url: "/api/daemons?serverId=..%2Fx", status: 400, json: { error: "invalid serverId" }, notCalled: ["daemons.status"] },
  { url: "/api/daemons", deps: () => ({ getConfig: async () => ({ modules: { usage: true, jobs: true, daemons: false } }) }), status: 503, json: { error: "远端守护进程模块已关闭", disabled: true }, notCalled: ["daemons.status"] },
  { url: "/api/daemons", deps: () => ({ toolkit: { daemons: null } }), status: 503, json: { error: "daemons unavailable" } },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "paseo", serverId: "s1" }, status: 200, json: { daemon: "paseo", result: "alreadyRunning", ok: true }, calls: [["daemons.start", "paseo", { serverId: "s1" }, { acquireSshSlot: "<fn>" }]] },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "paseo" }, status: 200, calls: [["daemons.start", "paseo", { serverId: null }, { acquireSshSlot: "<fn>" }]] },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "t3code" }, status: 409, json: { error: "正在启动 Paseo，请稍候" } },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "bash -c id" }, status: 400, json: { error: "未知的守护进程" }, notCalled: ["daemons.start"] },
  { method: "POST", url: "/api/daemons/start", body: ["paseo"], status: 400, json: { error: "未知的守护进程" }, notCalled: ["daemons.start"] },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "paseo", serverId: "a b" }, status: 400, json: { error: "invalid serverId" }, notCalled: ["daemons.start"] },
  { method: "POST", url: "/api/daemons/start", raw: "{broken", ...INVALID_BODY },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "paseo" }, deps: () => ({ getConfig: async () => ({ modules: { daemons: false } }) }), status: 503, json: { error: "远端守护进程模块已关闭", disabled: true }, notCalled: ["daemons.start"] },
  { method: "DELETE", url: "/api/daemons", ...NOT_FOUND },
  { method: "POST", url: "/api/daemons/start", body: { daemon: "paseo" }, token: null, status: 401, json: { error: "Unauthorized" }, notCalled: ["daemons.start", "getConfig"] },
  { url: "/api/daemons", token: null, status: 401, json: { error: "Unauthorized" }, notCalled: ["daemons.status"] },
  // 服务直达（v2.62）：转发 / 关闭的正文只有 serverId + 端口（多带任何键 400），必须带 token，随模块开关。
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: 8814 }, status: 200, json: { forward: { serverId: "s1", port: 8814, localPort: 51814, url: "http://127.0.0.1:51814/" }, status: null }, calls: [["daemons.forward", { serverId: "s1", port: 8814 }, { acquireSshSlot: "<fn>" }]] },
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: 9999 }, status: 409, json: { error: "端口 9999 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」" } },
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: 8814, host: "10.0.0.5" }, status: 400, json: { error: "只接受 serverId 与 port" }, notCalled: ["daemons.forward"] },
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: "8814" }, status: 400, json: { error: "端口不合法" }, notCalled: ["daemons.forward"] },
  { method: "POST", url: "/api/daemons/forward", body: { port: 8814 }, status: 400, json: { error: "invalid serverId" }, notCalled: ["daemons.forward"] },
  { method: "POST", url: "/api/daemons/forward", raw: "{broken", ...INVALID_BODY },
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: 8814 }, deps: () => ({ getConfig: async () => ({ modules: { daemons: false } }) }), status: 503, json: { error: "远端守护进程模块已关闭", disabled: true }, notCalled: ["daemons.forward"] },
  { method: "POST", url: "/api/daemons/forward", body: { serverId: "s1", port: 8814 }, token: null, status: 401, json: { error: "Unauthorized" }, notCalled: ["daemons.forward", "getConfig"] },
  { method: "POST", url: "/api/daemons/forward/close", body: { serverId: "s1", port: 8814 }, status: 200, calls: [["daemons.closeForward", { serverId: "s1", port: 8814 }]] },
  { method: "POST", url: "/api/daemons/forward/close", body: { serverId: "s1", port: 8814, localPort: 51814 }, status: 400, json: { error: "只接受 serverId 与 port" }, notCalled: ["daemons.closeForward"] },
  { method: "POST", url: "/api/daemons/forward/close", body: { serverId: "s1", port: 8814 }, token: null, status: 401, json: { error: "Unauthorized" }, notCalled: ["daemons.closeForward", "getConfig"] },
  { url: "/api/daemons/forward", ...NOT_FOUND },

  // ---- servers ----
  { url: "/api/servers", status: 200, json: { servers: [] }, calls: [["serverRegistry.list", { includeDisabled: true }]] },
  { url: "/api/servers?includeDisabled=0", status: 200, calls: [["serverRegistry.list", { includeDisabled: false }]] },
  { url: "/api/servers?includeDisabled=false", status: 200, calls: [["serverRegistry.list", { includeDisabled: true }]] },
  { method: "POST", url: "/api/servers", body: { name: "a" }, status: 201, json: { id: "new" }, calls: [["serverRegistry.add", { name: "a" }]] },
  { method: "POST", url: "/api/servers", body: [], status: 400, json: { error: "invalid server" }, notCalled: ["serverRegistry.add"] },
  { method: "POST", url: "/api/servers", status: 400, json: { error: "invalid server" } },
  { method: "POST", url: "/api/servers", body: { name: "dup" }, status: 409, json: { error: "重复", code: "duplicate", errors: [{ field: "name" }] } },
  { method: "DELETE", url: "/api/servers", ...NOT_FOUND },
  { method: "POST", url: "/api/servers/s/test", raw: "{broken", status: 200, json: { ok: false, code: "auth-required" }, calls: [["serverRegistry.testConnection", "s"]] },
  { url: "/api/servers/s/test", ...NOT_FOUND },
  { url: "/api/servers/s/suggest-port", status: 200, json: { port: 7900 }, calls: [["serverRegistry.suggestPort", "s", { acquireSshSlot: "<fn>" }]] },
  { method: "POST", url: "/api/servers/s/suggest-port", body: [], status: 400, json: { error: "请求正文必须是 JSON 对象" } },
  { method: "POST", url: "/api/servers/s/suggest-port", body: {}, ...NOT_FOUND, notCalled: ["serverRegistry.suggestPort"] },
  { method: "POST", url: "/api/servers/s/claim-port", body: { remotePort: 7900, expectedRevision: 3 }, status: 200, json: { remotePort: 7900, registered: true }, calls: [["serverRegistry.claimPort", "s", { remotePort: 7900, expectedRevision: 3, acquireSshSlot: "<fn>" }]] },
  { url: "/api/servers/s/claim-port", ...NOT_FOUND, notCalled: ["serverRegistry.claimPort"] },
  { method: "POST", url: "/api/servers/s/disable", body: { expectedRevision: 1 }, status: 200, json: { ok: true }, calls: [["serverRegistry.disable", "s", { expectedRevision: 1 }]] },
  { method: "POST", url: "/api/servers/s/enable", body: { expectedRevision: 2 }, status: 200, calls: [["serverRegistry.enable", "s", { expectedRevision: 2 }]] },
  { method: "POST", url: "/api/servers/s/restore", body: { expectedRevision: 3 }, status: 200, calls: [["serverRegistry.restore", "s", { expectedRevision: 3 }]] },
  { method: "POST", url: "/api/servers/a%2Fb/disable", body: {}, status: 200, calls: [["serverRegistry.disable", "a/b", {}]] },
  { method: "POST", url: "/api/servers/%E0%A4%A/disable", body: {}, status: 500, notCalled: ["serverRegistry.disable"] },
  { method: "POST", url: "/api/servers/conflict/disable", body: {}, status: 409, json: { error: "配置已变化", code: "revision-conflict" } },
  { method: "POST", url: "/api/servers/plain/disable", body: {}, status: 400, json: { error: "无状态码" } },
  { method: "POST", url: "/api/servers/s/disable", status: 400, json: { error: "请求正文必须是 JSON 对象" }, notCalled: ["serverRegistry.disable"] },
  { method: "POST", url: "/api/servers/s/credentials", body: { password: "p" }, status: 200, calls: [["serverRegistry.putCredentials", "s", { password: "p" }]] },
  { method: "POST", url: "/api/servers/s/hostkey", body: {}, status: 200, json: { lines: ["k"], linesHash: "h" }, calls: [["serverRegistry.previewHostKey", "s"]] },
  { method: "POST", url: "/api/servers/s/hostkey", body: { confirm: true, linesHash: "h" }, status: 200, json: { confirmed: true }, calls: [["serverRegistry.confirmHostKey", "s", { linesHash: "h" }]] },
  { method: "POST", url: "/api/servers/s/hostkey", body: { confirm: true }, status: 200, calls: [["serverRegistry.confirmHostKey", "s", { linesHash: undefined }]] },
  { method: "POST", url: "/api/servers/s/hostkey", body: { linesHash: "h" }, status: 200, calls: [["serverRegistry.confirmHostKey", "s", { linesHash: "h" }]] },
  {
    method: "POST",
    url: "/api/servers/s/hostkey",
    body: { confirm: true, lines: ["raw"] },
    status: 400,
    json: { error: "确认主机密钥不得提交原始密钥行，请重新预览" },
    notCalled: ["serverRegistry.confirmHostKey", "serverRegistry.previewHostKey"],
  },
  { method: "PATCH", url: "/api/servers/s", body: { remotePort: 7896 }, status: 200, calls: [["serverRegistry.update", "s", { remotePort: 7896 }]] },
  { method: "PATCH", url: "/api/servers/s", body: "str", status: 400, json: { error: "请求正文必须是 JSON 对象" } },
  { method: "DELETE", url: "/api/servers/s", body: { expectedRevision: 4 }, status: 200, calls: [["serverRegistry.remove", "s", { expectedRevision: 4 }]] },
  { method: "PATCH", url: "/api/servers/s/disable", body: {}, ...NOT_FOUND },
  { method: "POST", url: "/api/servers/s", body: {}, ...NOT_FOUND },
  { url: "/api/servers/s", ...NOT_FOUND },
  { method: "PUT", url: "/api/servers/s", body: [], ...NOT_FOUND },
  { url: "/api/servers/s/unknown", ...NOT_FOUND },

  // ---- 本机资源 ----
  { method: "POST", url: "/api/local/resources", ...NOT_FOUND },

  // ---- 存储清理 / 数据面升级 ----
  {
    method: "POST",
    url: "/api/storage/prune",
    status: 200,
    json: { success: true, evicted: [{ path: "/x", bytes: 1 }], usedBytes: 5, budgetBytes: 10, overBudget: false },
    calls: [["storageSweeper.sweep", { targetRatio: 0.5 }]],
    logs: [["storage prune: 淘汰 1 个文件，剩余 5 / 10 bytes", { ...CTX, event: "storage-prune", evicted: 1, usedBytes: 5, budgetBytes: 10, overBudget: false }]],
  },
  { url: "/api/storage/prune", ...NOT_FOUND },
  {
    method: "POST",
    url: "/api/data-plane/upgrade",
    body: { components: ["proxy"] },
    status: 200,
    json: { ok: true },
    calls: [["dataPlaneUpgrader.upgrade", { components: ["proxy"] }]],
    logs: [["data-plane upgrade request -> 200 ok=true", { ...CTX, event: "data-plane-upgrade" }]],
  },
  {
    method: "POST",
    url: "/api/data-plane/upgrade",
    body: { components: ["fail"] },
    status: 200,
    json: { ok: false, reason: "pid changed" },
    logs: [["data-plane upgrade request -> 200 ok=false", { ...CTX, event: "data-plane-upgrade", level: "warn" }]],
  },
  {
    method: "POST",
    url: "/api/data-plane/upgrade",
    body: { components: ["busy"] },
    status: 409,
    json: { error: "in flight" },
    logs: [["data-plane upgrade request -> 409", { ...CTX, event: "data-plane-upgrade" }]],
  },
  { method: "POST", url: "/api/data-plane/upgrade", raw: "{broken", status: 400, calls: [["dataPlaneUpgrader.upgrade", null]] },
  {
    method: "POST",
    url: "/api/data-plane/upgrade",
    body: { components: ["proxy"], pad: "x".repeat(5000) },
    status: 400,
    calls: [["dataPlaneUpgrader.upgrade", null]],
  },

  // ---- 登录电脑后自动启动（v2.62）：服务缺席 503；状态透传；POST 只收 { enabled: 布尔 }；服务拒绝时带 code ----
  { url: "/api/autostart", status: 503, json: { error: "autostart unavailable" } },
  { method: "POST", url: "/api/autostart", body: { enabled: true }, status: 503, json: { error: "autostart unavailable" } },
  {
    url: "/api/autostart",
    deps: (fn) => ({ autostart: { status: fn("autostart.status", async () => ({ supported: true, method: "launch-agent", enabled: false, state: "off" })) } }),
    status: 200,
    json: { supported: true, method: "launch-agent", enabled: false, state: "off" },
    calls: [["autostart.status"]],
  },
  {
    method: "POST",
    url: "/api/autostart",
    body: { enabled: true },
    deps: (fn) => ({ autostart: { setEnabled: fn("autostart.setEnabled", async () => ({ supported: true, method: "launch-agent", enabled: true, state: "on", changed: true, launchd: null })) } }),
    status: 200,
    json: { supported: true, method: "launch-agent", enabled: true, state: "on", changed: true, launchd: null },
    calls: [["autostart.setEnabled", true]],
    logs: [["autostart enabled (launch-agent)", { ...CTX, event: "autostart" }]],
  },
  {
    method: "POST",
    url: "/api/autostart",
    body: { enabled: "yes" },
    deps: (fn) => ({ autostart: { setEnabled: fn("autostart.setEnabled", async () => ({})) } }),
    status: 400,
    json: { error: "enabled must be a boolean" },
    notCalled: ["autostart.setEnabled"],
  },
  {
    method: "POST",
    url: "/api/autostart",
    body: { enabled: false },
    deps: (fn) => ({ autostart: { setEnabled: fn("autostart.setEnabled", async () => { throw httpError("已经存在，但不是工作台放的，没有改动它。", { status: 409, code: "foreign-file" }); }) } }),
    status: 409,
    json: { error: "已经存在，但不是工作台放的，没有改动它。", code: "foreign-file" },
    logs: [["autostart not changed: foreign-file", { ...CTX, event: "autostart", level: "warn" }]],
  },

  // ---- 自更新（v2.59）：服务缺席 503；状态 / 检查 / 应用透传；重启只在启动器会重新拉起时受理 ----
  { url: "/api/self-update", status: 503, json: { error: "self-update unavailable" } },
  { method: "POST", url: "/api/self-update/check", status: 503, json: { error: "self-update unavailable" } },
  { method: "POST", url: "/api/self-update/apply", status: 503, json: { error: "self-update unavailable" } },
  { method: "POST", url: "/api/self-update/restart", status: 503, json: { error: "self-update unavailable" } },
  {
    url: "/api/self-update",
    deps: (fn) => ({ selfUpdate: { status: fn("selfUpdate.status", async () => ({ supported: true, available: false })) } }),
    status: 200,
    json: { supported: true, available: false },
    calls: [["selfUpdate.status"]],
  },
  {
    method: "POST",
    url: "/api/self-update/check",
    deps: (fn) => ({ selfUpdate: { check: fn("selfUpdate.check", async () => ({ supported: true, available: true, remoteVersion: "9.9.9" })) } }),
    status: 200,
    json: { supported: true, available: true, remoteVersion: "9.9.9" },
    calls: [["selfUpdate.check", { force: true }]],
  },
  {
    method: "POST",
    url: "/api/self-update/apply",
    deps: (fn) => ({ selfUpdate: { apply: fn("selfUpdate.apply", async () => ({ ok: true, fromVersion: "1.0.0", toVersion: "1.1.0", respawn: false })) } }),
    status: 200,
    json: { ok: true, fromVersion: "1.0.0", toVersion: "1.1.0", respawn: false },
    calls: [["selfUpdate.apply"]],
    logs: [["self-update applied: v1.0.0 -> v1.1.0", { ...CTX, event: "self-update" }]],
  },
  {
    method: "POST",
    url: "/api/self-update/apply",
    deps: (fn) => ({ selfUpdate: { apply: fn("selfUpdate.apply", async () => { throw httpError("新版本 v1.1.0 自检没有通过，没有更新", { status: 422, code: "smoke-failed" }); }) } }),
    status: 422,
    json: { error: "新版本 v1.1.0 自检没有通过，没有更新", code: "smoke-failed" },
    logs: [["self-update not applied: smoke-failed", { ...CTX, event: "self-update", level: "warn" }]],
  },
  {
    method: "POST",
    url: "/api/self-update/restart",
    deps: (fn) => ({ selfUpdate: { respawn: false }, requestRestart: fn("requestRestart") }),
    status: 409,
    notCalled: ["requestRestart"],
  },
  { url: "/api/self-update/apply", ...NOT_FOUND },

  // ---- 通道启停 ----
  { method: "POST", url: "/api/start", status: 200, json: FULL_STATUS, keys: FULL_STATUS_KEYS, calls: [["startChannel", CTX], ...STATUS_CALLS] },
  { method: "POST", url: "/api/stop", status: 200, json: FULL_STATUS, calls: [["dataPlaneUpgrader.isInFlight"], ["stopChannel", CTX], ...STATUS_CALLS] },
  {
    method: "POST",
    url: "/api/stop",
    deps: (fn) => ({ dataPlaneUpgrader: { isInFlight: fn("dataPlaneUpgrader.isInFlight", () => true) } }),
    status: 409,
    json: { error: "后台组件正在无缝升级（通常十几秒内完成），请稍后再停止通道" },
    notCalled: ["stopChannel"],
  },
  { method: "POST", url: "/api/stop", deps: () => ({ dataPlaneUpgrader: { isInFlight: () => "yes" } }), status: 200, calls: [["stopChannel", CTX]] },
  {
    method: "POST",
    url: "/api/restart",
    status: 200,
    json: FULL_STATUS,
    calls: [["restartChannel", { trigger: "manual", context: CTX }]],
    notCalled: ["stopChannel", "startChannel"],
  },
  {
    method: "POST",
    url: "/api/restart",
    deps: (fn) => ({ restartChannel: fn("restartChannel", async () => ({ ok: false, reason: "operation in flight" })) }),
    status: 409,
    json: { error: "operation in flight" },
  },
  { method: "POST", url: "/api/restart", deps: () => ({ restartChannel: async () => ({ ok: false }) }), status: 409, json: { error: "restart rejected" } },
  { method: "POST", url: "/api/restart", deps: () => ({ restartChannel: async () => undefined }), status: 200, json: FULL_STATUS },
  { url: "/api/start", ...NOT_FOUND },

  // ---- ReClaude 远端动作已移除：两条路由不再存在 ----
  { method: "POST", url: "/api/remote-action/preview", body: { actionId: "reclaude-restart" }, ...NOT_FOUND },
  { method: "POST", url: "/api/remote-action/run", body: { previewId: "p1" }, ...NOT_FOUND },

  // ---- T04b 单隧道操作 ----
  { method: "POST", url: "/api/operations/preview", body: { scope: "tunnel" }, status: 200, json: { previewId: "op-p1" }, calls: [["operationsRunner.preview", { scope: "tunnel" }]] },
  { method: "POST", url: "/api/operations/preview", body: { scope: "bad" }, status: 422, json: { error: "非法范围" } },
  { method: "POST", url: "/api/operations/preview", ...INVALID_BODY },
  {
    method: "POST",
    url: "/api/operations/run",
    body: { previewId: "op-p1", extra: 1 },
    status: 202,
    json: { operationId: OP_ID, previewId: "op-p1", state: "queued" },
    calls: [["operationsRunner.run", { previewId: "op-p1", operationId: OP_ID }]],
  },
  { method: "POST", url: "/api/operations/run", body: { previewId: "busy" }, status: 409, json: { error: "互斥" } },
  { method: "POST", url: "/api/operations/run", raw: "null", ...INVALID_BODY },
  { url: "/api/operations/op-1", status: 200, json: { operationId: "op-1", state: "succeeded" }, calls: [["operationsRunner.getOperation", "op-1"]] },
  { url: "/api/operations/a%20b", status: 200, calls: [["operationsRunner.getOperation", "a b"]] },
  { url: "/api/operations/missing", status: 404, json: { error: "operation not found" } },
  { url: "/api/operations/denied", status: 403, json: { error: "拒绝" } },
  { url: "/api/operations/plain", status: 400, json: { error: "无状态码" } },
  { url: "/api/operations/%E0%A4%A", status: 500, notCalled: ["operationsRunner.getOperation"] },
  { method: "POST", url: "/api/operations/other", body: {}, ...NOT_FOUND },

  // ---- T07 事件 ----
  {
    url: "/api/incidents",
    status: 200,
    json: { incidents: [], nextCursor: null },
    calls: [["incidentStore.query", { state: "open", serverId: undefined, fingerprint: undefined, limit: 0, cursor: undefined }]],
  },
  {
    url: "/api/incidents?state=resolved&serverId=s1&limit=10&cursor=c1",
    status: 200,
    calls: [["incidentStore.query", { state: "resolved", serverId: "s1", fingerprint: undefined, limit: 10, cursor: "c1" }]],
  },
  { url: "/api/incidents?state=weird&limit=abc", status: 200, calls: [["incidentStore.query", { state: "open", serverId: undefined, fingerprint: undefined, limit: 50, cursor: undefined }]] },
  // type = 汇总里某个类型的 key（指纹，含 | 与 :），原样传给 store 做筛选。
  {
    url: "/api/incidents?state=resolved&limit=50&type=s1%7Cagent%3Acodex%7CDEGRADED",
    status: 200,
    calls: [["incidentStore.query", { state: "resolved", serverId: undefined, fingerprint: "s1|agent:codex|DEGRADED", limit: 50, cursor: undefined }]],
  },
  // 按类型汇总：days 缺省 / 非法 / 非正数都交给 store 用缺省窗口；不与逐条查询、提醒动作混淆。
  {
    url: "/api/incidents/summary",
    status: 200,
    json: { days: [], total: 0, types: [], requestedDays: null },
    calls: [["incidentStore.summarize", { days: undefined }]],
    notCalled: ["incidentStore.query"],
  },
  { url: "/api/incidents/summary?days=7", status: 200, json: { days: [], total: 0, types: [], requestedDays: 7 }, calls: [["incidentStore.summarize", { days: 7 }]] },
  { url: "/api/incidents/summary?days=abc", status: 200, calls: [["incidentStore.summarize", { days: undefined }]] },
  { url: "/api/incidents/summary?days=-3", status: 200, calls: [["incidentStore.summarize", { days: undefined }]] },
  { method: "POST", url: "/api/incidents/summary", body: {}, ...NOT_FOUND, notCalled: ["incidentStore.summarize"] },
  {
    method: "POST",
    url: "/api/incidents/i-1/attention",
    body: { action: "acknowledge" },
    status: 200,
    json: { incidentId: "i-1", lifecycle: "open", attention: { acknowledgedAt: 1 } },
    calls: [["incidentStore.acknowledge", "i-1"]],
  },
  { method: "POST", url: "/api/incidents/i-1/attention", body: { action: "snooze", durationMs: 60000 }, status: 200, json: { incidentId: "i-1", lifecycle: "open", attention: { snoozedUntil: 60000 } }, calls: [["incidentStore.snooze", "i-1", 60000]] },
  { method: "POST", url: "/api/incidents/i%2F1/attention", body: { action: "unsnooze" }, status: 200, calls: [["incidentStore.unsnooze", "i/1"]] },
  { method: "POST", url: "/api/incidents/i-1/attention", body: { action: "delete" }, status: 400, json: { error: "action must be acknowledge | snooze | unsnooze" } },
  { method: "POST", url: "/api/incidents/ghost/attention", body: { action: "acknowledge" }, status: 404, json: { error: "事件不存在" } },
  { method: "POST", url: "/api/incidents/i-1/attention", ...INVALID_BODY },
  { method: "POST", url: "/api/incidents/%E0%A4%A/attention", body: { action: "acknowledge" }, status: 500 },

  // ---- 兜底 ----
  { url: "/api/nope", ...NOT_FOUND },
  { method: "DELETE", url: "/api/config", ...NOT_FOUND },
];

for (const row of ROWS) {
  const omitted = row.omit?.length ? ` [缺 ${row.omit.join(",")}]` : "";
  const variant = row.deps ? " [替换依赖]" : "";
  test(`契约：${row.method || "GET"} ${row.url.slice(0, 80)}${omitted}${variant} → ${row.status}`, async () => {
    await runRow(row);
  });
}

// ---------------------------------------------------------------------------
// 横切行为：鉴权、operation 上下文、?pretty=1、500 兜底
// ---------------------------------------------------------------------------

test("鉴权：读接口缺 token → 401 且落 unauthorized 日志、不触达任何依赖", async () => {
  const harness = makeHarness();
  const { res, json } = await harness.request({ url: "/api/status", token: "wrong" });
  assert.equal(res.status, 401);
  assert.deepEqual(json, { error: "Unauthorized" });
  assert.deepEqual(harness.logs, [["unauthorized API block: GET /api/status (invalid auth token)"]]);
  assert.deepEqual(harness.calls, []);
});

test("鉴权：?token= 查询参数等价于 x-auth-token 头；跨源 Origin 一律 403", async () => {
  const harness = makeHarness();
  assert.equal((await harness.request({ url: `/api/status-lite?token=${TOKEN}`, token: null })).res.status, 200);
  const crossSite = await harness.request({ url: "/api/status-lite", headers: { origin: "https://evil.example" } });
  assert.equal(crossSite.res.status, 403);
  assert.deepEqual(crossSite.json, { error: "Unauthorized" });
  const badHost = await harness.request({ url: "/api/status-lite", headers: { host: "evil.example" } });
  assert.equal(badHost.res.status, 403);
});

test("鉴权：写接口无 token 401，不读正文、不触达任何依赖", async () => {
  const harness = makeHarness();
  const { res } = await harness.request({ method: "POST", url: "/api/config/active", body: { activeServerId: "s2" }, token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.logs, [["unauthorized API block: POST /api/config/active (invalid auth token)"]]);
  assert.deepEqual(harness.runs, [CTX], "鉴权在 operation 上下文之内执行");
});

test("鉴权：/api/modules 与 /api/ui-prefs 和其它写接口一样要 token；读目录同样要", async () => {
  const harness = makeHarness({ deps: (fn) => ({ setModuleEnabled: fn("setModuleEnabled", async () => true), setHiddenPanels: fn("setHiddenPanels", async () => {}) }) });
  for (const request of [
    { method: "POST", url: "/api/modules", body: { id: "usage", enabled: false } },
    { method: "POST", url: "/api/ui-prefs", body: { hiddenPanels: [] } },
    { url: "/api/modules" },
  ]) {
    const { res } = await harness.request({ ...request, token: null });
    assert.equal(res.status, 401, `${request.method || "GET"} ${request.url}`);
  }
  assert.deepEqual(harness.calls, [], "不触达任何依赖");
});

test("operation 上下文：POST 带合法 UUID → 原样回写响应头并用 operationStorage.run 包住整个路由", async () => {
  const harness = makeHarness();
  const upper = OP_ID.toUpperCase();
  const { res } = await harness.request({ method: "POST", url: "/api/start", headers: { "x-operation-id": upper } });
  assert.equal(res.status, 200);
  assert.equal(res.setHeaders["x-operation-id"], OP_ID, "UUID 归一为小写");
  assert.deepEqual(harness.runs, [CTX]);
  assert.deepEqual(harness.calls.find((call) => call[0] === "startChannel"), ["startChannel", CTX]);
});

test("operation 上下文：POST 缺/非法 x-operation-id → 服务端生成 UUID；GET 永不建上下文", async () => {
  const harness = makeHarness();
  const { res } = await harness.request({ method: "POST", url: "/api/start", headers: { "x-operation-id": "not-a-uuid" } });
  const generated = res.setHeaders["x-operation-id"];
  assert.match(generated, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(harness.runs, [{ operationId: generated }]);

  const getHarness = makeHarness();
  const get = await getHarness.request({ url: "/api/status-lite" });
  assert.equal(get.res.setHeaders["x-operation-id"], undefined);
  assert.deepEqual(getHarness.runs, []);
});

test("?pretty=1 → 缩进 JSON；默认紧凑；API 响应恒 no-store", async () => {
  const harness = makeHarness();
  const compact = await harness.request({ url: "/api/status-lite" });
  assert.equal(compact.res.raw, '{"health":"lite"}');
  assert.deepEqual(compact.res.headers, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  const pretty = await harness.request({ url: "/api/status-lite?pretty=1" });
  assert.equal(pretty.res.raw, '{\n  "health": "lite"\n}');
});

test("依赖抛错 → 500 { error } 并以当前 operation 上下文落 error 日志", async () => {
  const harness = makeHarness({
    deps: (fn) => ({
      startChannel: fn("startChannel", async () => {
        throw new Error("boom-start");
      }),
    }),
  });
  const { res, json } = await harness.request({ method: "POST", url: "/api/start" });
  assert.equal(res.status, 500);
  assert.deepEqual(json, { error: "boom-start" });
  assert.deepEqual(harness.logs, [["error: boom-start", CTX]]);
});

test("bootstrap：runStep 异步失败只落日志，不影响已回的 { started: true }", async () => {
  const harness = makeHarness({
    deps: (fn) => ({
      bootstrapRunner: {
        runStep: fn("bootstrapRunner.runStep", async () => {
          throw new Error("step exploded");
        }),
      },
    }),
  });
  const { json } = await harness.request({ method: "POST", url: "/api/bootstrap/step/node/run" });
  assert.deepEqual(json, { started: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.logs, [
    ["bootstrap step node requested", CTX],
    ["bootstrap step node error: step exploded", CTX],
  ]);
});

test("/api/probes/history：缺 since 时默认回看 24h", async () => {
  const harness = makeHarness();
  const before = Date.now();
  await harness.request({ url: "/api/probes/history?id=doctor" });
  const after = Date.now();
  const [, query] = harness.calls.find((call) => call[0] === "metricsStore.query");
  assert.equal(query.serverId, "probe:doctor");
  assert.ok(query.since >= before - 86400e3 && query.since <= after - 86400e3);
});

test("/api/metrics/range：读近 7 天的日文件，只聚合该服务器的 sample，按小时取均值", async () => {
  const hour = 3600e3;
  const ts = Math.floor(Date.now() / hour) * hour - 2 * hour; // 两小时前的整点（一定在窗口内）
  const harness = makeHarness({
    deps: (fn) => ({
      historyStore: {
        // 每个日文件都返回同一批条目：只要样本的时刻在窗口内就会被聚合；重复读到的同一条按桶累加，
        // 均值不变，正好顺带验证「按天逐个读」不会改变结果。
        readDay: fn("historyStore.readDay", async () => [
          { type: "sample", ts: ts + 60e3, key: "s1", cpu: 10, ram: 20, disk: 30, cpuBusyPct: 4, loadNormalizedPct: 10 },
          { type: "sample", ts: ts + 120e3, key: "s1", cpu: 20, ram: 40, disk: 30, cpuBusyPct: 6, loadNormalizedPct: 20 },
          { type: "sample", ts: ts + 60e3, key: "other", cpu: 99, ram: 99, disk: 99 },
          { type: "transition", ts: ts + 60e3, key: "s1", from: "ok", to: "error" },
        ]),
      },
    }),
  });
  const { res, json } = await harness.request({ url: "/api/metrics/range?serverId=s1&range=7d" });
  assert.equal(res.status, 200);
  assert.equal(json.serverId, "s1");
  assert.equal(json.range, "7d");
  assert.equal(json.stepMs, hour);
  assert.deepEqual(json.samples, [{ ts, cpuBusyPct: 5, loadNormalizedPct: 15, cpu: 15, ram: 30, disk: 30 }]);
  assert.deepEqual(json.extremes, { cpu: { min: 4, max: 6 }, ram: { min: 20, max: 40 }, disk: { min: 30, max: 30 } });
  const reads = harness.calls.filter((call) => call[0] === "historyStore.readDay").map((call) => call[1]);
  assert.ok(reads.length >= 10 && reads.length <= 11, `7 天窗口跨 8 个（对齐跨零点时 9 个）本机日期，前后各多读一天，实际 ${reads.length}`);
  assert.ok(reads.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  assert.equal(new Set(reads).size, reads.length, "每个日期只读一次");
});

test("本机资源：新鲜缓存（<15s）直接复用，limit 取整并夹在 [1,50]，默认 20", async () => {
  for (const [qs, expected] of [["", 20], ["?limit=3.9", 3], ["?limit=9999", 50], ["?limit=-5", 1], ["?limit=0", 20], ["?limit=abc", 20]]) {
    const harness = makeHarness();
    const { res, json } = await harness.request({ url: `/api/local/resources${qs}` });
    assert.equal(res.status, 200);
    assert.equal(json.topProcesses.length, expected, `limit${qs}`);
    assert.equal(json.cpu, 3);
    assert.equal(harness.calls.some((call) => call[0] === "localResourceProbe.sample"), false);
  }
  const harness = makeHarness();
  const { json } = await harness.request({ url: "/api/local/processes?limit=2" });
  assert.deepEqual(Object.keys(json), ["schemaVersion", "scope", "observedAt", "quality", "processes"]);
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.scope, "local");
  assert.equal(json.quality, "ok");
  assert.deepEqual(json.processes, [{ pid: 0 }, { pid: 1 }]);
});

test("本机资源：缓存过期或缺失 → 重新 sample；sample 为空 → 503", async () => {
  const stale = { observedAt: new Date(Date.now() - 16000).toISOString(), topProcesses: [] };
  for (const url of ["/api/local/resources", "/api/local/processes"]) {
    const harness = makeHarness({ deps: (fn) => ({ localResourceProbe: { getLast: fn("localResourceProbe.getLast", () => stale) } }) });
    assert.equal((await harness.request({ url })).res.status, 200);
    assert.equal(harness.calls.filter((call) => call[0] === "localResourceProbe.sample").length, 1, url);

    const closing = makeHarness({
      deps: (fn) => ({
        localResourceProbe: { getLast: fn("localResourceProbe.getLast", () => null), sample: fn("localResourceProbe.sample", async () => null) },
      }),
    });
    const res = await closing.request({ url });
    assert.equal(res.res.status, 503);
    assert.deepEqual(res.json, { error: "本机采样器正在关闭" });
  }
});

// ---------------------------------------------------------------------------
// /api/logs：内存 ring 优先，ring 覆盖不到时回读磁盘轮转历史
// ---------------------------------------------------------------------------

test("/api/logs：ring 有结果直接返回；limit 夹到 [1,500]；未知 source 形状仍是 { entries, total }", async () => {
  const logger = createLogger("contract-ring");
  try {
    logger.info("第一条", { operationId: OP_ID });
    logger.warn("第二条");
    const harness = makeHarness();
    const all = await harness.request({ url: "/api/logs?source=contract-ring" });
    assert.equal(all.res.status, 200);
    assert.deepEqual(all.json.entries.map((e) => e.message), ["第一条", "第二条"]);
    assert.equal(all.json.total, 2);
    const limited = await harness.request({ url: "/api/logs?source=contract-ring&limit=1" });
    assert.deepEqual(limited.json.entries.map((e) => e.message), ["第二条"]);
    const byLevel = await harness.request({ url: "/api/logs?source=contract-ring&level=warn" });
    assert.deepEqual(byLevel.json.entries.map((e) => e.message), ["第二条"]);
    const byOp = await harness.request({ url: `/api/logs?source=contract-ring&operationId=${OP_ID}` });
    assert.deepEqual(byOp.json.entries.map((e) => e.message), ["第一条"]);
    const unknown = await harness.request({ url: "/api/logs?source=Upper_Case" });
    assert.deepEqual(unknown.json, { entries: [], total: 0 });
  } finally {
    await logger.dispose();
  }
});

test("/api/logs：ring 无该 source 时回读 <logsDir>/<source>.ndjson（含轮转文件）", async () => {
  const lines = [
    { ts: 10, source: "contract-disk", level: "info", message: "旧的" },
    { ts: 20, source: "contract-disk", level: "error", message: "新的" },
  ];
  writeFileSync(path.join(LOGS_DIR, "contract-disk.ndjson.1"), `${JSON.stringify(lines[0])}\n`);
  writeFileSync(path.join(LOGS_DIR, "contract-disk.ndjson"), `${JSON.stringify(lines[1])}\nnot json\n`);
  const harness = makeHarness();
  const { res, json } = await harness.request({ url: "/api/logs?source=contract-disk" });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { entries: lines, total: 2 });
  const since = await harness.request({ url: "/api/logs?source=contract-disk&since=15&level=error" });
  assert.deepEqual(since.json, { entries: [lines[1]], total: 1 });
});

test("/api/logs：按 operationId 回看（不限来源）且 ring 无命中时回读 ops 磁盘历史", async () => {
  // monitor 重启后 ring 清空，而事件与其关联的 operationId 是持久化的：「查看处置日志」仍要有内容。
  const opId = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
  const lines = [
    { ts: 30, source: "ops", level: "info", message: "stop requested", operationId: opId },
    { ts: 31, source: "ops", level: "info", message: "别的操作", operationId: "other-op" },
    { ts: 32, source: "ops", level: "info", message: "start completed", operationId: opId },
  ];
  writeFileSync(path.join(LOGS_DIR, "ops.ndjson"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const harness = makeHarness();
  const { res, json } = await harness.request({ url: `/api/logs?operationId=${opId}` });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { entries: [lines[0], lines[2]], total: 2 });
});

test("/api/logs/summary：透出 summarizeLogs 的三窗口聚合", async () => {
  const harness = makeHarness();
  const { res, json } = await harness.request({ url: "/api/logs/summary" });
  assert.equal(res.status, 200);
  assert.deepEqual(json.windows.map((w) => w.windowMs), [3600e3, 21600e3, 86400e3]);
});

// ---------------------------------------------------------------------------
// SSE：连接上限、首帧、断开清理
// ---------------------------------------------------------------------------

test("SSE：首帧是 { lite(+旁路字段), layers }；超过连接上限 503；断开后可重新接入", async () => {
  const harness = makeHarness();
  const first = await harness.request({ url: "/api/events" });
  assert.equal(first.res.status, 200);
  assert.deepEqual(first.res.headers, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  assert.equal(
    first.res.raw,
    `event: status\ndata: ${JSON.stringify({ lite: { ...LITE, ...EXTRAS, storage: STORAGE }, layers: LAYERS })}\n\n`,
  );
  assert.deepEqual(
    harness.calls.filter((call) => call[0].startsWith("store.")),
    [["store.getLayers"], ["store.getLiteStatus", { layers: LAYERS }]],
  );

  const second = await harness.request({ url: "/api/events" });
  assert.equal(second.res.status, 503);
  assert.deepEqual(second.json, { error: "too many SSE connections" });

  first.close();
  assert.equal(first.res.ended, true, "断开时 end 掉响应");
  const third = await harness.request({ url: "/api/events" });
  assert.equal(third.res.status, 200);
  third.close();
});
