import assert from "node:assert/strict";
import test from "node:test";

import { bus, EVENTS } from "./event-bus.mjs";
import { createHttpRouter } from "./http-router.mjs";
import { readJsonBody, sendJson } from "./http/io.mjs";

// readJsonBody 此前是 `body += chunk`：chunk 是 Buffer，`+=` 会对每个分段各自
// toString("utf8")，拼接点落在多字节字符中间时产生 U+FFFD。它是合法 JSON 字符，
// JSON.parse 不报错——写接口会把「服务器甲」静默持久化成「服务器���」。
// 同时上限用的是 body.length（UTF-16 码元）而非字节。以下测试锁死这两点。

function makeReq(...buffers) {
  return {
    [Symbol.asyncIterator]: async function* iterator() {
      for (const buf of buffers) yield buf;
    },
  };
}

test("readJsonBody: 单块正常解析", async () => {
  const parsed = await readJsonBody(makeReq(Buffer.from('{"a":1}', "utf8")));
  assert.deepEqual(parsed, { a: 1 });
});

test("readJsonBody: 多字节字符跨 chunk 切开仍完整还原", async () => {
  const json = JSON.stringify({ name: "服务器甲", note: "隧道" });
  const buf = Buffer.from(json, "utf8");
  const cut = buf.indexOf(Buffer.from("甲")) + 1; // 落在「甲」的 3 字节中间

  const parsed = await readJsonBody(makeReq(buf.subarray(0, cut), buf.subarray(cut)));
  assert.equal(parsed.name, "服务器甲");
  assert.equal(parsed.note, "隧道");
});

test("readJsonBody: 逐字节切分也不产生替换符", async () => {
  const json = JSON.stringify({ name: "服务器甲" });
  const buf = Buffer.from(json, "utf8");
  const singles = Array.from({ length: buf.length }, (_v, i) => buf.subarray(i, i + 1));

  const parsed = await readJsonBody(makeReq(...singles));
  assert.equal(parsed.name, "服务器甲");
});

test("readJsonBody: 上限按字节统计而非 UTF-16 码元", async () => {
  const json = JSON.stringify({ n: "甲甲甲甲甲" });
  const byteLength = Buffer.byteLength(json, "utf8");
  const charLength = json.length;
  assert.ok(byteLength > charLength, "前提：该载荷字节数大于字符串长度");

  // 上限取字符长度：旧实现会放行（13 > 13 为假），新实现必须按字节拒绝。
  assert.equal(await readJsonBody(makeReq(Buffer.from(json, "utf8")), charLength), null);
  // 放宽到真实字节数后应正常解析。
  assert.deepEqual(await readJsonBody(makeReq(Buffer.from(json, "utf8")), byteLength), { n: "甲甲甲甲甲" });
});

test("readJsonBody: 非法 JSON 与超限均返回 null（调用方回 400）", async () => {
  assert.equal(await readJsonBody(makeReq(Buffer.from("{不是JSON", "utf8"))), null);
  assert.equal(await readJsonBody(makeReq(Buffer.from(`{"a":"${"x".repeat(64)}"}`, "utf8")), 16), null);
});

test("readJsonBody: 空体返回 null", async () => {
  assert.equal(await readJsonBody(makeReq()), null);
});

test("readJsonBody: 字符串 chunk（req.setEncoding 后 / 测试替身）同样正常工作", async () => {
  // Node 的 IncomingMessage 默认给 Buffer，但调用过 req.setEncoding() 之后给的是 string。
  // 此前实现直接 Buffer.concat(chunks)，遇到 string 会抛 TypeError，而抛错被外层 catch
  // 吞成 null → 所有写接口静默 400（server-http.test.mjs 的替身就 yield 字符串，正好命中）。
  assert.deepEqual(await readJsonBody(makeReq('{"name":"服务器甲"}')), { name: "服务器甲" });
  // 多段字符串拼接同样不能破坏多字节字符。
  assert.deepEqual(await readJsonBody(makeReq('{"name":"服务', '器甲"}')), { name: "服务器甲" });
  // 上限对字符串 chunk 也必须按字节计，而不是按 UTF-16 码元。
  const json = '{"n":"甲甲甲"}';
  assert.equal(await readJsonBody(makeReq(json), json.length), null);
  assert.deepEqual(await readJsonBody(makeReq(json), Buffer.byteLength(json, "utf8")), { n: "甲甲甲" });
});

test("sendJson: 默认紧凑输出，?pretty=1 时缩进", () => {
  const makeRes = () => {
    const res = { status: null, headers: null, body: null };
    res.writeHead = (status, headers) => {
      res.status = status;
      res.headers = headers;
    };
    res.end = (body) => {
      res.body = body;
    };
    return res;
  };

  const compact = makeRes();
  sendJson(compact, { a: 1 });
  assert.equal(compact.body, '{"a":1}');

  const pretty = makeRes();
  pretty.prettyJson = true;
  sendJson(pretty, { a: 1 });
  assert.equal(pretty.body, '{\n  "a": 1\n}');
});

// ---------------------------------------------------------------------------
// 读路径的性能契约（行为测试，不是源码文本断言）
// ---------------------------------------------------------------------------

function makeJsonRes() {
  const res = {
    status: null,
    headers: null,
    raw: "",
    writableLength: 0,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(value) {
      this.raw = value === undefined ? "" : String(value);
      try {
        this.json = JSON.parse(this.raw);
      } catch {
        this.json = null;
      }
    },
    write(chunk) {
      this.raw += String(chunk);
    },
    destroy() {
      this.destroyed = true;
    },
  };
  return res;
}

function makeStatusReq(url = "/api/status") {
  return { url, method: "GET", headers: { host: "127.0.0.1:8877", "x-auth-token": "fixture" } };
}

function makeRouter(overrides = {}) {
  return createHttpRouter({
    authToken: "fixture",
    publicDir: "/nonexistent",
    logsDir: "/nonexistent",
    maxSseConnections: 8,
    sseHeartbeatMs: 25000,
    store: {},
    scheduler: {},
    metricsStore: {},
    bootstrapRunner: {},
    toolkit: {},
    appendLog() {},
    operationStorage: { run: (_context, fn) => fn() },
    getConfig: async () => ({}),
    ...overrides,
  });
}

test("/api/status 每次请求只构建一次 layers，且顶层字段就是那份快照", async () => {
  const layers = { channel: { level: "ok" }, tunnels: { "server-a": { tunnelUp: true } } };
  let layersBuilt = 0;
  // getLegacyStatus 内部（经 getSummary）本就需要 layers：实现把同一份注入进去，
  // 因此这里必须观察到恰好一次构建，而不是两次。
  const store = {
    getLayers: () => {
      layersBuilt += 1;
      return layers;
    },
    getLegacyStatus: ({ layers: injected }) => {
      assert.equal(injected, layers, "router 必须把同一份快照注入 getLegacyStatus");
      return { health: "ready", summary: { schemaVersion: 2 } };
    },
    getLiteStatus: () => ({ health: "ready" }),
  };
  const router = makeRouter({ store, version: "9.9.9" });
  const res = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq(), res);

  assert.equal(res.status, 200);
  assert.equal(layersBuilt, 1, "同一请求内 layers 只应构建一次");
  // HTTP 响应体是序列化后的，只能做深比较；"就是那份快照"由 getLegacyStatus 里
  // 的 injected === layers 断言保证（构造阶段不会出现第二份 layers）。
  assert.deepEqual(res.json.layers, layers);
  assert.equal(res.json.version, "9.9.9");
  assert.equal(res.json.health, "ready", "legacy 字段仍要完整透传");
});

test("SSE 建立连接时只构建一次 layers，且 status 帧的 layers 与 lite 同源", async () => {
  const layers = { channel: { level: "degraded" }, tunnels: {} };
  let layersBuilt = 0;
  const seen = [];
  const store = {
    getLayers: () => {
      layersBuilt += 1;
      return layers;
    },
    getLegacyStatus: () => ({}),
    getLiteStatus: ({ layers: injected }) => {
      seen.push(injected);
      return { health: "degraded" };
    },
  };
  const router = makeRouter({ store });
  const req = makeStatusReq("/api/events");
  req.on = () => {};
  const res = makeJsonRes();
  await router.handleHttpRequest(req, res);

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");
  assert.equal(layersBuilt, 1, "建连时的首帧不应重复构建 layers");
  assert.deepEqual(seen, [layers], "lite 必须基于同一份快照生成");
  assert.match(res.raw, /event: status/);
  assert.match(res.raw, /"layers":\{"channel":\{"level":"degraded"\}/);
});

test("SSE 广播：一次事件对所有客户端写完全相同的帧（每客户端只序列化一次）", async () => {
  const router = makeRouter({ store: { getLayers: () => ({}), getLegacyStatus: () => ({}), getLiteStatus: () => ({}) } });
  const clients = [];
  for (let i = 0; i < 3; i += 1) {
    const req = makeStatusReq("/api/events");
    req.on = () => {};
    const res = makeJsonRes();
    clients.push(res);
    await router.handleHttpRequest(req, res);
  }
  for (const client of clients) client.raw = "";

  bus.emit(EVENTS.LOG_APPENDED, { level: "warn", message: "共用一份载荷", ts: 1 });

  const frames = clients.map((client) => client.raw);
  assert.equal(frames[0].length > 0, true, "所有客户端都必须收到事件");
  assert.equal(new Set(frames).size, 1, "三个客户端收到的帧必须逐字节相同");
  assert.match(frames[0], /^event: log\ndata: /);
  assert.match(frames[0], /共用一份载荷/);
});

test("/api/jobs 接在路由表里：读工具箱的 jobs 服务，和其它读接口一样要鉴权", async () => {
  const snapshot = { state: "ok", checkedAt: 1, user: "kai", reason: null, total: 0, truncated: false, jobs: [] };
  const router = makeRouter({ toolkit: { jobs: { getSnapshot: (id) => (id === "server-01" ? snapshot : null) } } });
  const ok = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs?serverId=server-01"), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.json.state, ok.json.serverId, ok.json.user], ["ok", "server-01", "kai"]);

  const denied = makeJsonRes();
  await router.handleHttpRequest({ url: "/api/jobs?serverId=server-01", method: "GET", headers: { host: "127.0.0.1:8877" } }, denied);
  assert.ok(denied.status === 401 || denied.status === 403, `未带令牌应被拒绝，实际 ${denied.status}`);
  assert.equal(denied.json?.state, undefined);
});

test("/api/jobs/diagnoses 与 /script（v2.49）接在路由表里，同样要鉴权", async () => {
  const jobs = {
    getSnapshot: () => null,
    listDiagnoses: async () => ({ items: [{ jobId: "1" }], groups: [] }),
    getDiagnosisScript: async () => "#!/bin/bash\n",
    readLogSegment: async (_serverId, query, { acquireSshSlot }) => ({ jobId: query.jobId, slot: typeof acquireSshSlot === "function" }),
  };
  const router = makeRouter({ toolkit: { jobs }, scheduler: { acquireSshSlot: async () => () => {} } });
  const ok = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs/diagnoses?serverId=server-01"), ok);
  assert.deepEqual([ok.status, ok.json.items[0].jobId], [200, "1"]);
  const script = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs/diagnoses/script?serverId=server-01&jobId=1"), script);
  assert.deepEqual([script.status, script.json], [200, { jobId: "1", script: "#!/bin/bash\n" }]);
  const segment = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=stdout"), segment);
  assert.deepEqual([segment.status, segment.json], [200, { jobId: "1", slot: true }], "日志分段读取拿到调度器的全局槽位");
  for (const url of ["/api/jobs/diagnoses?serverId=server-01", "/api/jobs/diagnoses/script?serverId=server-01&jobId=1", "/api/jobs/log-segment?serverId=server-01&jobId=1&from=watch&log=stdout"]) {
    const denied = makeJsonRes();
    await router.handleHttpRequest({ url, method: "GET", headers: { host: "127.0.0.1:8877" } }, denied);
    assert.ok(denied.status === 401 || denied.status === 403, `${url} 未带令牌应被拒绝，实际 ${denied.status}`);
    assert.equal(denied.json?.items, undefined);
    assert.equal(denied.json?.script, undefined);
  }
});

test("/api/jobs/lookup 与 /group（v2.51）接在路由表里：回查经调度器的全局 SSH 槽位，同样要鉴权", async () => {
  const seen = [];
  const jobs = {
    getSnapshot: () => null,
    lookupHistory: async (serverId, query, { acquireSshSlot }) => {
      const release = await acquireSshSlot({ hostKey: "myserver" });
      release();
      seen.push([serverId, query.kind]);
      return { state: "ok", rows: [] };
    },
    historyGroupPage: async () => ({ expired: true }),
  };
  const slots = [];
  const router = makeRouter({ toolkit: { jobs }, scheduler: { acquireSshSlot: async (options) => { slots.push(options); return () => {}; } } });
  const ok = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs/lookup?serverId=server-01&job=18036"), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(seen, [["server-01", "job"]]);
  assert.deepEqual(slots, [{ hostKey: "myserver" }]);
  const group = makeJsonRes();
  await router.handleHttpRequest(makeStatusReq("/api/jobs/group?serverId=server-01&snapshot=live-1&key=A%7Cb&limit=10"), group);
  assert.equal(group.status, 409);
  const denied = makeJsonRes();
  await router.handleHttpRequest({ url: "/api/jobs/lookup?serverId=server-01&job=18036", method: "GET", headers: { host: "127.0.0.1:8877" } }, denied);
  assert.ok(denied.status === 401 || denied.status === 403, `未带令牌应被拒绝，实际 ${denied.status}`);
  assert.equal(seen.length, 1);
});

// v2.57 第 2 期：/api/cli* 两组路由（登录 routes/cli-login.mjs、概览与安装 routes/cli.mjs）同挂一个前缀。
// 锁死：登录组排在前面，两组各自的路径都能命中对应服务，互不截胡。
test("/api/cli* 路由顺序：登录路径先被登录组认领，概览 / 安装 / 回滚 / 任务进度落到安装组", async () => {
  const hits = [];
  const cliLoginService = {
    start: async (cli, body) => { hits.push(["login.start", cli, body.method]); return { jobId: "L1", state: "running" }; },
    get: (jobId) => { hits.push(["login.get", jobId]); return { jobId }; },
    current: (serverId) => { hits.push(["login.current", serverId]); return null; },
    submitCode: (jobId) => { hits.push(["login.code", jobId]); return { jobId }; },
    cancel: async (jobId) => { hits.push(["login.cancel", jobId]); return { jobId }; },
    relayCheck: (baseUrl) => { hits.push(["login.relayCheck", baseUrl]); return { ok: true }; },
  };
  const cliInstall = {
    overview: async (serverId, runtime) => { hits.push(["install.overview", serverId, runtime.getCliState("server-01")?.checkedAt]); return { serverId: "server-01", clis: {}, job: null }; },
    startInstall: async (cli) => { hits.push(["install.start", cli]); return { jobId: "I1", job: {} }; },
    getJob: (jobId) => { hits.push(["install.job", jobId]); return { jobId }; },
    cancelJob: async (jobId) => { hits.push(["install.cancel", jobId]); return { jobId, status: "cancelled" }; },
    rollback: async (cli) => { hits.push(["install.rollback", cli]); return { ok: true }; },
  };
  const toolkit = { cliInstall, cli: { getSnapshot: () => ({ serverId: "server-01", checkedAt: 7, clis: {} }) } };
  const router = makeRouter({ toolkit, cliLoginService, scheduler: {} });
  const send = async (method, url, body) => {
    const req = {
      url,
      method,
      headers: { host: "127.0.0.1:8877", "x-auth-token": "fixture", ...(body ? { "content-type": "application/json" } : {}) },
      [Symbol.asyncIterator]: async function* iterator() {
        if (body) yield Buffer.from(JSON.stringify(body));
      },
    };
    const res = Object.assign(makeJsonRes(), { setHeader() {} });
    await router.handleHttpRequest(req, res);
    return res.status;
  };
  assert.equal(await send("POST", "/api/cli/codex/login", { method: "account" }), 202);
  assert.equal(await send("POST", "/api/cli/claude/login", { method: "api" }), 202);
  assert.equal(await send("GET", "/api/cli/login/jobs/L1"), 200);
  assert.equal(await send("GET", "/api/cli/login/current?serverId=server-01"), 200);
  assert.equal(await send("POST", "/api/cli/login/jobs/L1/code", { code: "x" }), 200);
  assert.equal(await send("POST", "/api/cli/login/jobs/L1/cancel", {}), 200);
  assert.equal(await send("POST", "/api/cli/login/relay-check", { baseUrl: "https://r.example.com" }), 200);
  assert.equal(await send("GET", "/api/cli"), 200);
  assert.equal(await send("POST", "/api/cli/codex/install", { serverId: "server-01" }), 202);
  assert.equal(await send("GET", "/api/cli/jobs/I1"), 200);
  // 安装任务的取消（v2.57 后续）与登录任务的取消路径只差一段 /login，各归各组。
  assert.equal(await send("POST", "/api/cli/jobs/I1/cancel", {}), 200);
  assert.equal(await send("POST", "/api/cli/claude/rollback", {}), 200);
  assert.deepEqual(hits, [
    ["login.start", "codex", "account"],
    ["login.start", "claude", "api"],
    ["login.get", "L1"],
    ["login.current", "server-01"],
    ["login.code", "L1"],
    ["login.cancel", "L1"],
    ["login.relayCheck", "https://r.example.com"],
    ["install.overview", null, 7],
    ["install.start", "codex"],
    ["install.job", "I1"],
    ["install.cancel", "I1"],
    ["install.rollback", "claude"],
  ]);
});
