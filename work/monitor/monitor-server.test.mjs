import assert from "node:assert/strict";
import test from "node:test";

// 控制面各装配簇（lib/ 与 server/）的纯函数单测：模块均无顶层副作用，import 不会启动任何
// 生产实例、不绑定端口、不触碰 ~/Library/Application Support/、不 ssh。
import { matchesManagedProcess } from "./lib/channel-lifecycle.mjs";
import { authorizeRequest } from "./lib/http-auth.mjs";
import { sendFile } from "./lib/http/static.mjs";
import { createAutoRepairRunner, pickTriageSignal } from "./server/auto-repair-runner.mjs";
import { applyTunnelForeignSnapshot } from "./server/bridge-ingest.mjs";
import { decideHotStart } from "./server/hot-start.mjs";
import { attachTriage } from "./server/signal-sink.mjs";
// 策略表本身（限频/规则）已有独立单测；这里用真策略跑接线，保证两边口径一致——
// 用假策略的话，"窗口内第三次不重启"这条断言测的就只是测试替身自己。
import { createAutoRepairPolicy, normalizeAutoRepairConfig } from "./lib/auto-repair-policy.mjs";

// 入口链接冒烟：本文件不是被直接执行的入口，monitor-server.mjs 的 isMain 守卫为假，import 只
// 链接 server/start.mjs 起的整棵装配模块图（缺导出等链接错误在这里暴露），不启动服务。
test("monitor-server.mjs：被 import 时整棵装配模块图可链接", async () => {
  assert.ok(await import("./monitor-server.mjs"));
});

// ---- V1: matchesManagedProcess（A3 stopChannel 兜底强特征匹配）----

test("matchesManagedProcess: supervisor matches by script name even with relative argv", () => {
  // 受管进程都以相对路径 argv 启动（spawn 前 cd 到 rootDir），旧的
  // cmdline.includes(rootDir) 校验对这类 argv 永假；这里断言新判据能正确识别。
  const cmdline = "node work/monitor/channel-supervisor.mjs";
  assert.equal(matchesManagedProcess(cmdline, { role: "supervisor" }), true);
});

test("matchesManagedProcess: supervisor rejects unrelated process", () => {
  const cmdline = "node work/some-other-script.mjs";
  assert.equal(matchesManagedProcess(cmdline, { role: "supervisor" }), false);
});

test("matchesManagedProcess: localProxy matches by script name even with relative argv", () => {
  const cmdline = "node work/local_http_connect_proxy.mjs";
  assert.equal(matchesManagedProcess(cmdline, { role: "localProxy" }), true);
});

test("matchesManagedProcess: localProxy rejects unrelated process", () => {
  assert.equal(matchesManagedProcess("bash -c ls", { role: "localProxy" }), false);
});

test("matchesManagedProcess: tunnel matches exact -R forward spec + host, ignores rootDir", () => {
  const cmdline = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver";
  assert.equal(
    matchesManagedProcess(cmdline, { role: "tunnel", config: { remotePort: 7891, localPort: 8888, host: "myserver" } }),
    true,
  );
});

test("matchesManagedProcess: tunnel rejects mismatched port pairing (pid-reuse style false positive)", () => {
  const cmdline = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver";
  // 同 host 但 remotePort/localPort 对不上（例如另一台服务器复用了相同 host 别名）不应匹配。
  assert.equal(
    matchesManagedProcess(cmdline, { role: "tunnel", config: { remotePort: 9999, localPort: 8888, host: "myserver" } }),
    false,
  );
});

test("matchesManagedProcess: tunnel rejects mismatched host", () => {
  const cmdline = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 otherhost";
  assert.equal(
    matchesManagedProcess(cmdline, { role: "tunnel", config: { remotePort: 7891, localPort: 8888, host: "myserver" } }),
    false,
  );
});

test("matchesManagedProcess: tunnel with incomplete config is conservatively false", () => {
  const cmdline = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver";
  assert.equal(
    matchesManagedProcess(cmdline, { role: "tunnel", config: { remotePort: 7891, localPort: 8888 } }),
    false,
  );
});

test("matchesManagedProcess: unknown role is conservatively false", () => {
  assert.equal(matchesManagedProcess("node work/monitor/channel-supervisor.mjs", { role: "bogus" }), false);
});

test("matchesManagedProcess: non-string cmdline is conservatively false", () => {
  assert.equal(matchesManagedProcess(null, { role: "supervisor" }), false);
  assert.equal(matchesManagedProcess(undefined, { role: "tunnel", config: { remotePort: 1, localPort: 2, host: "h" } }), false);
});

// ---- V2: authorizeRequest（C3 Web 模式强制鉴权 + Origin/Host 校验 + 读接口收口）----

test("authorizeRequest: write method with empty auth token is rejected (no more open-fallback)", () => {
  // Host 给本地值：让用例精确命中"token 未配置 → 401"分支，而非先被 Host 校验 403。
  const result = authorizeRequest({ method: "POST", path: "/api/stop", headers: { host: "127.0.0.1:8877" }, authToken: "" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("authorizeRequest: write method with cross-site Origin is rejected even with a matching token", () => {
  const result = authorizeRequest({
    method: "POST",
    path: "/api/restart",
    headers: { "x-auth-token": "secret", origin: "http://evil.com", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("authorizeRequest: Electron 灵动岛 file:// 的 Origin=null + 本地 Host + 正确 token 必须放行", () => {
  const result = authorizeRequest({
    method: "POST",
    path: "/api/start",
    headers: { "x-auth-token": "secret", origin: "null", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

test("authorizeRequest: write method with non-local Host is rejected", () => {
  const result = authorizeRequest({
    method: "DELETE",
    path: "/api/whatever",
    headers: { "x-auth-token": "secret", host: "evil.com" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("authorizeRequest: write method with mismatched token is rejected", () => {
  const result = authorizeRequest({
    method: "POST",
    path: "/api/stop",
    headers: { "x-auth-token": "wrong", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("authorizeRequest: write method with matching token + local host + no Origin header is allowed (electron-style direct http client)", () => {
  const result = authorizeRequest({
    method: "POST",
    path: "/api/stop",
    headers: { "x-auth-token": "secret", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

test("authorizeRequest: write method with matching token + local Origin + local host is allowed (same-origin browser fetch)", () => {
  const result = authorizeRequest({
    method: "POST",
    path: "/api/config/active",
    headers: { "x-auth-token": "secret", origin: "http://127.0.0.1:8877", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

// ---- 读接口收口：/api/* 只读也要求 Host/Origin 本地；authToken 已配置时还要求有效 token ----

test("authorizeRequest: /api read with valid token + local host is allowed", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/logs",
    headers: { "x-auth-token": "secret", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

test("authorizeRequest: /api read without token is 401 when authToken is configured", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/logs",
    headers: { host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("authorizeRequest: /api read with wrong token is 401 when authToken is configured", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/status",
    headers: { "x-auth-token": "wrong", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("authorizeRequest: /api/session read is exempt from token (browser token-bootstrap endpoint)", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/session",
    headers: { host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

test("authorizeRequest: /api read with malicious (DNS-rebinding style) Host is 403 even with valid token", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/logs",
    headers: { "x-auth-token": "secret", host: "rebind.evil.com" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("authorizeRequest: /api read with cross-site Origin is 403 even with valid token + local host", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/logs",
    headers: { "x-auth-token": "secret", origin: "http://evil.com", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("authorizeRequest: /api read with Origin 'null' (Electron file:// island) + token is allowed", () => {
  const result = authorizeRequest({
    method: "GET",
    path: "/api/status-lite",
    headers: { "x-auth-token": "secret", origin: "null", host: "127.0.0.1:8877" },
    authToken: "secret",
  });
  assert.equal(result.ok, true);
});

test("authorizeRequest: /api read without token is allowed when authToken is NOT configured (local debug), Host check still applies", () => {
  assert.equal(
    authorizeRequest({ method: "GET", path: "/api/status", headers: { host: "127.0.0.1:8877" }, authToken: "" }).ok,
    true,
  );
  assert.equal(
    authorizeRequest({ method: "GET", path: "/api/status", headers: { host: "localhost:8877" }, authToken: "" }).ok,
    true,
  );
  // token 未配置也绝不给非本地 Host 放行（DNS 重绑定页面读状态）。
  const rebind = authorizeRequest({ method: "GET", path: "/api/status", headers: { host: "evil.com" }, authToken: "" });
  assert.equal(rebind.ok, false);
  assert.equal(rebind.status, 403);
});

test("authorizeRequest: non-API static reads stay open (first page load has no token yet)", () => {
  assert.equal(authorizeRequest({ method: "GET", path: "/", headers: {}, authToken: "secret" }).ok, true);
  assert.equal(authorizeRequest({ method: "GET", path: "/styles.css", headers: {}, authToken: "secret" }).ok, true);
  assert.equal(
    authorizeRequest({ method: "GET", path: "/assets/js/api.js", headers: {}, authToken: "secret" }).ok,
    true,
  );
});

// ---- v2.16 /api/history* 路由：date 参数校验 + historyStore 透传 ----
// createHttpRouter 是无副作用工厂（见 lib/http-router.mjs 模块注释），直接以 stub 依赖
// 构造并用假 req/res 打路由，不监听端口。authToken 留空 + 本地 Host 使读路径放行。

function makeHistoryRouterHarness(historyStore) {
  return import("./lib/http-router.mjs").then(({ createHttpRouter }) => {
    const router = createHttpRouter({
      authToken: "",
      version: "0.0.0-test",
      publicDir: "/nonexistent-public-dir-for-test",
      logsDir: "/nonexistent-logs-dir-for-test",
      ndjsonTailLines: 100,
      maxSseConnections: 1,
      sseHeartbeatMs: 60000,
      store: {},
      scheduler: {},
      metricsStore: {},
      historyStore,
      bootstrapRunner: {},
      toolkit: {},
      appendLog: () => {},
      operationStorage: { run: (_ctx, fn) => fn() },
      getConfig: async () => ({}),
    });
    const request = async (path) => {
      const res = {
        headers: {},
        setHeader: () => {},
        writeHead(status, headers) {
          res.status = status;
          res.headers = headers || {};
          return res;
        },
        end(body) {
          res.body = body;
          return res;
        },
      };
      await router.handleHttpRequest({ method: "GET", url: path, headers: { host: "127.0.0.1:8877" } }, res);
      return res;
    };
    return { request };
  });
}

test("/api/history: 非法 date 参数一律 400（缺失/格式错/路径穿越）", async () => {
  let readCalls = 0;
  const { request } = await makeHistoryRouterHarness({
    listDays: async () => [],
    readDay: async () => {
      readCalls += 1;
      return [];
    },
  });
  for (const qs of ["", "?date=", "?date=2026-8-30", "?date=20260830", "?date=..%2F..%2Fetc", "?date=2026-08-30%2F..%2Fx"]) {
    const res = await request(`/api/history${qs}`);
    assert.equal(res.status, 400, `应 400: /api/history${qs}`);
    assert.deepEqual(JSON.parse(res.body), { error: "invalid date" });
  }
  assert.equal(readCalls, 0, "非法 date 绝不触达 historyStore.readDay");
});

test("/api/history: 合法 date 返回 200 + entries，响应 no-store", async () => {
  const entries = [{ ts: 1756500000000, type: "transition", key: "channel", from: "ok", to: "error" }];
  const { request } = await makeHistoryRouterHarness({
    listDays: async () => ["2026-08-30"],
    readDay: async (date) => (date === "2026-08-30" ? entries : []),
  });
  const res = await request("/api/history?date=2026-08-30");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(res.body), { date: "2026-08-30", entries });
});

test("/api/history: types 只留指定类型的条目；省略时原样返回；没有 type 的旧迁移条目按 transition 算", async () => {
  const entries = [
    { ts: 1, type: "levels", cause: "start", view: "server-01", levels: { channel: "ok" } },
    { ts: 2, type: "transition", key: "channel", from: "ok", to: "error" },
    { ts: 3, type: "sample", key: "server-01", cpu: 1 },
    { ts: 4, type: "signal", severity: "warn" },
    { ts: 5, message: "channel: error -> ok" },
  ];
  const { request } = await makeHistoryRouterHarness({ listDays: async () => [], readDay: async () => entries });
  const tsOf = async (qs) => JSON.parse((await request(`/api/history?date=2026-08-30${qs}`)).body).entries.map((e) => e.ts);
  assert.deepEqual(await tsOf(""), [1, 2, 3, 4, 5]);
  assert.deepEqual(await tsOf("&types="), [1, 2, 3, 4, 5]);
  assert.deepEqual(await tsOf("&types=transition,levels"), [1, 2, 5]);
  assert.deepEqual(await tsOf("&types=sample"), [3]);
  assert.deepEqual(await tsOf("&types=..%2Fx,UPPER"), [], "写了 types 但没有一个合法类型名时不回退成全部");
});

test("/api/history/days: 返回 historyStore.listDays 结果，响应 no-store", async () => {
  const { request } = await makeHistoryRouterHarness({
    listDays: async () => ["2026-08-30", "2026-08-29"],
    readDay: async () => [],
  });
  const res = await request("/api/history/days");
  assert.equal(res.status, 200);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(res.body), { days: ["2026-08-30", "2026-08-29"] });
});

// ---- v2.17 根因分诊接线：attachTriage（onLogSignals 的纯函数部分）----
// 契约：warn/error 信号条目被写入 rootCause/rootCauseLabel/rootCauseAdvice；
// newSignals（与引擎 active 表共享引用）与本轮 activeSignals 浅拷贝按 id 双写；
// info 采样信号绝不分诊。

test("attachTriage: warn/error 信号条目带上分类字段，activeSignals 同 id 浅拷贝同步补写", () => {
  const sig = { id: "gateway-unhealthy", category: "gateway", severity: "error", title: "网关不健康" };
  const activeCopy = { id: "gateway-unhealthy", severity: "error", title: "网关不健康" };
  const otherCopy = { id: "rate-limited", severity: "warn", title: "限流" };
  const snapshot = {
    layers: { channel: { level: "error", detail: { localProxyUp: true, tunnelUp: false, remotePortOpen: false } }, agents: {} },
    agentsStatus: {},
    health: "down",
  };
  attachTriage([sig], [activeCopy, otherCopy], snapshot);
  assert.equal(sig.rootCause, "channel");
  assert.equal(sig.rootCauseLabel, "通道断开");
  assert.equal(sig.rootCauseAdvice, "通道断开，等待自愈或点一键修复");
  // 同 id 的本轮浅拷贝同步获得分类（红条两条数据通路当轮可见）。
  assert.equal(activeCopy.rootCause, "channel");
  assert.equal(activeCopy.rootCauseLabel, "通道断开");
  // 不同 id 的活跃条目不受本条信号分诊影响。
  assert.equal(otherCopy.rootCause, undefined);
});

test("attachTriage: 优先级压制——账号故障与通道断同时存在时判 account", () => {
  const sig = { id: "request-timeout", category: "request", severity: "warn", title: "请求超时" };
  const snapshot = {
    layers: { channel: { level: "error", detail: { tunnelUp: false, remotePortOpen: false, localProxyUp: true } }, agents: {} },
    agentsStatus: { "claude-codewing": { health: "revoked", accountFault: "revoked", loggedIn: true } },
    health: "down",
  };
  attachTriage([sig], [], snapshot);
  assert.equal(sig.rootCause, "account");
  assert.equal(sig.rootCauseLabel, "账号层故障");
  assert.equal(sig.rootCauseAdvice, "设备已解绑，需在服务器重新登录");
});

test("attachTriage: info 采样信号不分诊；null 条目与缺参不抛错", () => {
  const info = { id: "probe-timeout-sample", category: "sampling", severity: "info", title: "采样" };
  attachTriage([info, null], null, null);
  assert.equal(info.rootCause, undefined);
  assert.equal(attachTriage(null, null, null), null);
});

test("attachTriage: 快照缺字段时落 unknown 兜底（分类字段依然齐全可落盘）", () => {
  const sig = { id: "http-5xx", category: "request", severity: "warn", title: "上游 5xx 错误" };
  attachTriage([sig], [], {});
  assert.equal(sig.rootCause, "unknown");
  assert.equal(sig.rootCauseLabel, "根因未定位");
  assert.equal(sig.rootCauseAdvice, "根因未定位，查看日志与 Doctor 输出");
});

// ---- 静态资源 ETag / 304 协商缓存（v2.13.0）----

test("sendFile: 首次 200 携带强 ETag + no-cache，If-None-Match 命中回 304 零载荷", async () => {
  const { writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "zcode-etag-"));
  try {
    const file = join(dir, "app.js");
    const content = "// cache-test fixture\n";
    await writeFile(file, content);

    const makeRes = () => {
      const res = {};
      res.writeHead = (status, headers) => { res.status = status; res.headers = headers; return res; };
      res.end = (body) => { res.body = body; return res; };
      return res;
    };

    // 首次请求：200 + etag + no-cache
    const res1 = makeRes();
    await sendFile({ headers: {} }, res1, file, "text/javascript; charset=utf-8");
    assert.equal(res1.status, 200);
    assert.equal(res1.headers["cache-control"], "no-cache");
    assert.match(res1.headers.etag, /^"[0-9a-f]{24}-[0-9a-f]+"$/);
    assert.equal(res1.body.toString(), content);

    // 命中 If-None-Match：304 且无载荷
    const res2 = makeRes();
    await sendFile({ headers: { "if-none-match": res1.headers.etag } }, res2, file, "text/javascript; charset=utf-8");
    assert.equal(res2.status, 304);
    assert.equal(res2.body, undefined);

    // 内容变化后 etag 随之变化，旧 if-none-match 不再命中
    await writeFile(file, `${content}// changed\n`);
    const res3 = makeRes();
    await sendFile({ headers: { "if-none-match": res1.headers.etag } }, res3, file, "text/javascript; charset=utf-8");
    assert.equal(res3.status, 200);
    assert.notEqual(res3.headers.etag, res1.headers.etag);

    // W/ 前缀与多值列表也能正确匹配
    const res4 = makeRes();
    await sendFile(
      { headers: { "if-none-match": `W/${res3.headers.etag}, "stale"` } },
      res4,
      file,
      "text/javascript; charset=utf-8",
    );
    assert.equal(res4.status, 304);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- v2.18 本地数据预算：/api/status.storage 与 POST /api/storage/prune ----
// 与上面的 history harness 同法：createHttpRouter 是无副作用工厂，注入 stub sweeper
// 直接打路由，不监听端口、不碰真实 runtime 目录。

function makeStorageRouterHarness({ storageSweeper, authToken = "", getRuntimeExtras }) {
  return import("./lib/http-router.mjs").then(({ createHttpRouter }) => {
    const logged = [];
    const router = createHttpRouter({
      authToken,
      getRuntimeExtras,
      version: "0.0.0-test",
      publicDir: "/nonexistent-public-dir-for-test",
      logsDir: "/nonexistent-logs-dir-for-test",
      ndjsonTailLines: 100,
      maxSseConnections: 1,
      sseHeartbeatMs: 60000,
      store: {
        getLegacyStatus: () => ({ health: "ok", running: true }),
        getLayers: () => ({ channel: { level: "ok" } }),
      },
      scheduler: {},
      metricsStore: {},
      historyStore: null,
      storageSweeper,
      bootstrapRunner: {},
      toolkit: {},
      appendLog: (message, fields) => logged.push({ message, ...fields }),
      operationStorage: { run: (_ctx, fn) => fn() },
      getConfig: async () => ({}),
    });
    const request = async (method, reqPath, headers = {}) => {
      const res = {
        headers: {},
        setHeader: () => {},
        writeHead(status, resHeaders) {
          res.status = status;
          res.headers = resHeaders || {};
          return res;
        },
        end(body) {
          res.body = body;
          return res;
        },
      };
      await router.handleHttpRequest({ method, url: reqPath, headers: { host: "127.0.0.1:8877", ...headers } }, res);
      return res;
    };
    return { request, logged };
  });
}

test("/api/status: 顶层带 storage（usedBytes/budgetBytes/lastSweepAt/evicted），旧字段不受影响", async () => {
  const state = { usedBytes: 12 * 1024 * 1024, budgetBytes: 50 * 1024 * 1024, lastSweepAt: 1756500000000, evicted: 3 };
  const { request } = await makeStorageRouterHarness({ storageSweeper: { getState: () => state } });

  const res = await request("GET", "/api/status");
  assert.equal(res.status, 200);
  const payload = JSON.parse(res.body);
  assert.deepEqual(payload.storage, state);
  // 旧字段一个不少（legacy status + layers + version 原样透出）。
  assert.equal(payload.health, "ok");
  assert.equal(payload.running, true);
  assert.equal(payload.version, "0.0.0-test");
  assert.deepEqual(payload.layers, { channel: { level: "ok" } });
});

test("/api/status: 未接 sweeper 时 storage 字段整体缺席（旧协议逐字节不变）", async () => {
  const { request } = await makeStorageRouterHarness({ storageSweeper: null });
  const payload = JSON.parse((await request("GET", "/api/status")).body);
  assert.equal("storage" in payload, false);
});

test("POST /api/storage/prune: 无 token 401 且绝不触达 sweeper", async () => {
  let sweeps = 0;
  const { request } = await makeStorageRouterHarness({
    authToken: "secret",
    storageSweeper: {
      getState: () => ({ usedBytes: 1, budgetBytes: 2, lastSweepAt: null, evicted: 0 }),
      sweep: async () => {
        sweeps += 1;
        return { evicted: [], usedBytes: 1, budgetBytes: 2, overBudget: false };
      },
    },
  });

  const res = await request("POST", "/api/storage/prune");
  assert.equal(res.status, 401);
  assert.deepEqual(JSON.parse(res.body), { error: "Unauthorized" });
  assert.equal(sweeps, 0);
});

test("POST /api/storage/prune: 带 token 清到预算 50% 并返回 evicted 数组 + ops 日志", async () => {
  const evicted = [
    { path: "/rt/logs/ops.ndjson.2", bytes: 2048, kind: "logRotations" },
    { path: "/rt/history/2026-08-01.ndjson", bytes: 1024, kind: "history" },
  ];
  const calls = [];
  const { request, logged } = await makeStorageRouterHarness({
    authToken: "secret",
    storageSweeper: {
      getState: () => ({ usedBytes: 100, budgetBytes: 200, lastSweepAt: null, evicted: 2 }),
      sweep: async (options) => {
        calls.push(options);
        return { evicted, usedBytes: 97, budgetBytes: 200, overBudget: false };
      },
    },
  });

  const res = await request("POST", "/api/storage/prune", { "x-auth-token": "secret" });
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ targetRatio: 0.5 }], "手动清理的目标是预算的一半");
  const payload = JSON.parse(res.body);
  assert.equal(payload.success, true);
  assert.deepEqual(payload.evicted, evicted);
  assert.equal(payload.usedBytes, 97);
  assert.equal(payload.budgetBytes, 200);
  assert.equal(payload.overBudget, false);
  const entry = logged.find((l) => l.event === "storage-prune");
  assert.ok(entry, "应落一条 event=storage-prune 的 ops 日志");
  assert.equal(entry.evicted, 2);
});

// ---- v2.18 零残留采集：切换活跃服务器后要 forceRun 的新探针 id ----
// 同 history / storage harness：createHttpRouter 是无副作用工厂，注入 stub 依赖打路由。

function makeActiveServerRouterHarness({ parsed, forced }) {
  return import("./lib/http-router.mjs").then(({ createHttpRouter }) => {
    const router = createHttpRouter({
      authToken: "secret",
      version: "0.0.0-test",
      publicDir: "/nonexistent-public-dir-for-test",
      logsDir: "/nonexistent-logs-dir-for-test",
      ndjsonTailLines: 100,
      maxSseConnections: 1,
      sseHeartbeatMs: 60000,
      store: {},
      scheduler: {
        forceRun: (id) => {
          forced.push(id);
          return Promise.resolve();
        },
      },
      metricsStore: {},
      historyStore: null,
      bootstrapRunner: {},
      toolkit: {
        getMainServerConfig: (config) => (config.servers || []).find((s) => s.id === config.activeServerId) || null,
      },
      appendLog: () => {},
      operationStorage: { run: (_ctx, fn) => fn() },
      getConfig: async () => parsed,
      setActiveServerConfig: async () => true,
      refreshConfigIntoKernel: async () => parsed,
    });
    const request = async (body) => {
      const res = {
        headers: {},
        setHeader: () => {},
        writeHead(status, headers) {
          res.status = status;
          res.headers = headers || {};
          return res;
        },
        end(payload) {
          res.body = payload;
          return res;
        },
      };
      const chunks = [Buffer.from(JSON.stringify(body))];
      const req = {
        method: "POST",
        url: "/api/config/active",
        headers: { host: "127.0.0.1:8877", "x-auth-token": "secret" },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
        on(event, handler) {
          if (event === "data") for (const chunk of chunks) handler(chunk);
          if (event === "end") handler();
          return req;
        },
      };
      await router.handleHttpRequest(req, res);
      return res;
    };
    return { request };
  });
}

test("POST /api/config/active: 立即 forceRun 的是 log-signals 与新活跃服务器的 collect:slow", async () => {
  const forced = [];
  const parsed = {
    activeServerId: "server-tengxun",
    servers: [
      { id: "server-01", host: "myserver", remotePort: 7891 },
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893 },
    ],
  };
  const { request } = await makeActiveServerRouterHarness({ parsed, forced });
  const res = await request({ activeServerId: "server-tengxun" });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { success: true });
  assert.deepEqual(forced, ["log-signals", "collect:slow:server-tengxun"]);
  assert.equal(forced.includes("primary-remote"), false, "primary-remote 已删除，不得再触发");
});

// ---- v2.18 PROBE_UPDATED → metrics/history 分发：只有 collect:slow:* 携带资源样本 ----

// ---- v2.18 L2 自动修复接线（createAutoRepairRunner + 真策略表）----
// 与 history/storage harness 同法：两个工厂都无副作用，注入假 scheduler / 假通道
// 直接驱动，不监听端口、不 spawn、不碰 runtime。策略与执行器共用同一枚假时钟，
// 否则限频（用注入的 now()）与规则判定（用 view.now）会跑在两条时间轴上。

function makeAutoRepairHarness({ autoRepairConfig = {}, view: viewOverrides = {} } = {}) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const logs = [];
  const timeline = [];
  const forced = [];
  const restarts = [];
  const contexts = [];
  let restartResult = { ok: true, reason: "" };
  let opSeq = 0;

  const appendLog = (message, fields) => logs.push({ message, ...(fields || {}) });
  const policy = createAutoRepairPolicy({
    config: normalizeAutoRepairConfig(autoRepairConfig),
    now,
    // 与 monitor-server 装配处逐字同形：策略自己的日志也走 ops 日志，固定 event/trigger。
    log: (fields) => appendLog(
      `auto-repair: ${fields.ruleId} ${fields.kind}（${fields.mode}）`,
      { ...fields, event: "auto-repair", trigger: "auto" },
    ),
  });

  // 默认视图：通道被分诊判定断开且已持续 60s，本机两个进程都在 —— 即
  // channel-down-restart 的全部前提成立。单个用例只覆写它关心的那一两个字段。
  const view = {
    shouldBeRunning: true,
    repairInFlight: false,
    activeServerId: "server-01",
    triage: { rootCause: "channel", since: clock - 60_000 },
    processes: { supervisorUp: true, localProxyUp: true },
    wakeGapMs: 0,
    ...viewOverrides,
  };

  const runner = createAutoRepairRunner({
    policy,
    scheduler: {
      forceRun: (id, options) => {
        forced.push({ id, ...(options || {}) });
        return Promise.resolve();
      },
    },
    channel: {
      restartChannel: async (options) => {
        restarts.push(options);
        return restartResult;
      },
    },
    buildView: () => ({ ...view, now: now() }),
    appendLog,
    timeline: (level, message, fields) => timeline.push({ level, message, ...(fields || {}) }),
    // 与 HTTP 层同一个操作上下文（生产注入 kernel.operationStorage）：记录每次进入的上下文。
    operationStorage: {
      run: (context, fn) => {
        contexts.push(context);
        return fn();
      },
    },
    randomUUID: () => `op-auto-${++opSeq}`,
  });

  return {
    runner,
    policy,
    view,
    logs,
    timeline,
    forced,
    restarts,
    contexts,
    setRestartResult: (value) => {
      restartResult = value;
    },
    // 时钟推进同时把"断开起点"往回挪，保持"已经断了 60s"这个前提不随时间流逝失效。
    advance: (ms) => {
      clock += ms;
      if (view.triage) view.triage.since = clock - 60_000;
    },
  };
}

test('auto-repair 接线: 通道持续断开时以 trigger:"auto" 调一次 restartChannel，并落 ops 日志 + 时间线', async () => {
  const h = makeAutoRepairHarness();
  await h.runner.evaluate();

  assert.equal(h.restarts.length, 1, "窗口内第一次断开必须真的重启一次");
  // 每次自动重启带新 operationId，并在同一操作上下文里执行（没带 fields 的 ops 日志也继承它，
  // 通道生命周期受理时据它关联事件「查看处置日志」）。
  assert.deepEqual(h.restarts[0], { trigger: "auto", ruleId: "channel-down-restart", context: { operationId: "op-auto-1" } });
  assert.deepEqual(h.contexts, [{ operationId: "op-auto-1" }]);
  // 动作集合封闭：L2 只允许重启本机通道，绝不顺手刷探针或做别的事。
  assert.deepEqual(h.forced, []);

  const opsEntry = h.logs.find((l) => l.event === "auto-repair" && l.ruleId === "channel-down-restart");
  assert.ok(opsEntry, "应落一条 event=auto-repair 的 ops 日志");
  assert.equal(opsEntry.trigger, "auto");
  assert.equal(opsEntry.mode, "execute");

  const timelineEntry = h.timeline.find((t) => t.kind === "restart-channel");
  assert.ok(timelineEntry, "执行的动作要进状态时间线");
  assert.equal(timelineEntry.message, "自动修复：重启整个通道", "时间线写人话，看得出是自动修复");
  assert.equal(timelineEntry.trigger, "auto", "前端据此打「自动」徽标");
  assert.equal(timelineEntry.ok, true);
  assert.equal(timelineEntry.operationId, "op-auto-1", "时间线收尾行归入同一操作组");
  assert.equal(h.runner.isExhausted(), false);
});

test("auto-repair 接线: 10 分钟窗口内第三次不再重启，改为 escalate 并置 autoRepairExhausted", async () => {
  const h = makeAutoRepairHarness();
  await h.runner.evaluate();
  h.advance(61_000); // 越过 60s 冷却
  await h.runner.evaluate();
  assert.equal(h.restarts.length, 2, "预算是 10 分钟 2 次");
  assert.deepEqual(h.restarts.map((r) => r.context.operationId), ["op-auto-1", "op-auto-2"], "每次重启一个新 operationId");
  assert.equal(h.runner.isExhausted(), false);

  h.advance(61_000); // 仍在 10 分钟窗口内，但预算已耗尽
  await h.runner.evaluate();
  assert.equal(h.restarts.length, 2, "第三次绝不执行");
  assert.equal(h.runner.isExhausted(), true, "转人工：注意力队列置顶");

  const escalateTimeline = h.timeline.find((t) => t.kind === "escalate");
  assert.ok(escalateTimeline, "升级人工要留一条时间线");
  assert.equal("operationId" in escalateTimeline, false, "escalate 不是处置操作，不带 operationId");
  assert.equal(escalateTimeline.level, "warn");
  assert.equal(escalateTimeline.trigger, "auto");

  // 通道恢复后旗标清零（装配层挂在 channel → ok 的 STATUS_CHANGED 上）。
  h.runner.clearExhausted();
  assert.equal(h.runner.isExhausted(), false);
});

test("auto-repair 接线: observeOnly 只写日志不执行任何动作", async () => {
  const h = makeAutoRepairHarness({ autoRepairConfig: { observeOnly: true } });
  await h.runner.evaluate();

  assert.deepEqual(h.restarts, [], "观察模式绝不重启通道");
  assert.deepEqual(h.forced, []);
  const entry = h.logs.find((l) => l.event === "auto-repair" && l.ruleId === "channel-down-restart");
  assert.ok(entry, "观察模式仍要留下「本来会做什么」的日志");
  assert.equal(entry.mode, "observe");
  assert.equal(entry.trigger, "auto");
  assert.deepEqual(h.timeline, [], "没执行就不进时间线");
});

test("auto-repair 接线: 用户手动停止通道 / 修复进行中 / 总开关关闭时完全静默", async () => {
  for (const patch of [{ shouldBeRunning: false }, { repairInFlight: true }]) {
    const h = makeAutoRepairHarness({ view: patch });
    await h.runner.evaluate();
    assert.deepEqual(h.restarts, [], `${JSON.stringify(patch)} 时不得有任何动作`);
    assert.deepEqual(h.logs, [], `${JSON.stringify(patch)} 时连日志都不该有`);
  }
  const off = makeAutoRepairHarness({ autoRepairConfig: { enabled: false } });
  await off.runner.evaluate();
  assert.deepEqual(off.restarts, []);
  assert.deepEqual(off.logs, []);
});

test("auto-repair 接线: 单规则开关关掉 channel-down-restart 后不再重启", async () => {
  const h = makeAutoRepairHarness({ autoRepairConfig: { rules: { "channel-down-restart": false } } });
  await h.runner.evaluate();
  assert.deepEqual(h.restarts, []);
});

test("auto-repair 接线: 唤醒拍强制复核 processes / log-signals / collect:slow:<活跃服务器>，覆盖熔断", async () => {
  // 唤醒复核是 L1 只读动作：即便没有任何分诊结论也要跑（休眠期间的结论全都不可信）。
  const h = makeAutoRepairHarness({ view: { triage: null } });
  await h.runner.evaluate({ wakeGapMs: 120_000 });

  assert.deepEqual(h.forced.map((f) => f.id), ["processes", "log-signals", "collect:slow:server-01"]);
  assert.ok(h.forced.every((f) => f.overrideBreaker === true), "休眠期间探针大概率已熔断，必须覆盖");
  assert.deepEqual(h.restarts, [], "L1 复核不碰进程");

  const entry = h.timeline.find((t) => t.kind === "force-probes");
  assert.equal(entry.trigger, "auto");
  assert.equal(entry.ruleId, "wake-recheck");
});

test("auto-repair 接线: 挂钟没跳变时不触发唤醒复核", async () => {
  const h = makeAutoRepairHarness({ view: { triage: null } });
  await h.runner.evaluate({ wakeGapMs: 5_000 });
  assert.deepEqual(h.forced, []);
});

test("auto-repair 接线: restartChannel 返回 ok:false 时记账为失败并落 warn 日志", async () => {
  const h = makeAutoRepairHarness();
  h.setRestartResult({ ok: false, reason: "ssh 拒绝连接" });
  await h.runner.evaluate();

  assert.equal(h.restarts.length, 1);
  const failLog = h.logs.find((l) => typeof l.message === "string" && l.message.includes("restart failed"));
  assert.ok(failLog, "失败原因必须落盘，否则用户只看到「自动修了但没好」");
  assert.equal(failLog.level, "warn");
  assert.equal(failLog.operationId, "op-auto-1", "失败行归入本次操作的处置日志");
  const entry = h.timeline.find((t) => t.kind === "restart-channel");
  assert.equal(entry.ok, false);
  assert.equal(h.policy.getState().lastActions.at(-1).ok, false);
});

test("auto-repair 接线: buildView 抛错不会把异常抛回事件总线", async () => {
  const runner = createAutoRepairRunner({
    policy: { evaluate: () => [], markExecuted: () => {} },
    scheduler: { forceRun: () => Promise.resolve() },
    channel: { restartChannel: async () => ({ ok: true }) },
    buildView: () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(await runner.evaluate(), []);
});

// ---- 分诊输入挑选：策略视图的 triage 字段来源 ----

test("pickTriageSignal: 取 severity 最高且带 rootCause 的非 info 信号，since 用 firstSeenAt", () => {
  const picked = pickTriageSignal([
    { id: "a", severity: "warn", rootCause: "upstream", firstSeenAt: 100, lastSeenAt: 900 },
    { id: "b", severity: "error", rootCause: "channel", firstSeenAt: 200, lastSeenAt: 800 },
  ]);
  assert.deepEqual(picked, { rootCause: "channel", since: 200 });
});

test("pickTriageSignal: info 采样信号与无 rootCause 的条目一律不参与；无候选返回 null", () => {
  assert.equal(pickTriageSignal([{ id: "s", severity: "info", rootCause: "channel", firstSeenAt: 1 }]), null);
  assert.equal(pickTriageSignal([{ id: "s", severity: "error", firstSeenAt: 1 }]), null);
  assert.equal(pickTriageSignal([]), null);
  assert.equal(pickTriageSignal(null), null);
  assert.equal(pickTriageSignal([null, undefined]), null);
});

test("pickTriageSignal: 缺 firstSeenAt 时 since 为 NaN（策略据此判定证据不足，不动手）", () => {
  const picked = pickTriageSignal([{ id: "b", severity: "error", rootCause: "channel" }]);
  assert.equal(picked.rootCause, "channel");
  assert.equal(Number.isNaN(picked.since), true);
});

// ---- tunnelPortForeign：bridge 的 ssh-tunnel 快照 → 端口被异己占用的服务器集合 ----

test("applyTunnelForeignSnapshot: foreign 快照进集合，ok 快照移除，其它快照一律不动", () => {
  const set = new Set();
  applyTunnelForeignSnapshot(set, { stage: "ssh-tunnel", serverId: "server-02", ok: false, foreign: true });
  assert.deepEqual([...set], ["server-02"]);

  // 另一台也被占用：两台并存。
  applyTunnelForeignSnapshot(set, { stage: "ssh-tunnel", serverId: "server-03", ok: false, foreign: true });
  assert.deepEqual([...set].sort(), ["server-02", "server-03"]);

  // 认领成功（ok:true）即移出；只影响它自己那台。
  applyTunnelForeignSnapshot(set, { stage: "ssh-tunnel", serverId: "server-02", ok: true, adopted: true });
  assert.deepEqual([...set], ["server-03"]);

  // 非 ssh-tunnel 段、缺 serverId、既不 foreign 也不 ok 的快照都不改变集合。
  applyTunnelForeignSnapshot(set, { stage: "local-proxy", serverId: "server-03", ok: true });
  applyTunnelForeignSnapshot(set, { stage: "ssh-tunnel", ok: true });
  applyTunnelForeignSnapshot(set, { stage: "ssh-tunnel", serverId: "server-03", ok: false });
  applyTunnelForeignSnapshot(set, null);
  assert.deepEqual([...set], ["server-03"]);
});

// ---- /api/status 与 SSE lite 的顶层旁路字段（与 storage 同一合成处）----

test("/api/status: 顶层带 autoRepairExhausted / tunnelPortForeign / autoRepair，且与 storage 并存", async () => {
  const extras = {
    autoRepairExhausted: true,
    tunnelPortForeign: ["server-tengxun"],
    autoRepair: {
      enabled: true,
      observeOnly: false,
      lastActions: [{ ruleId: "channel-down-restart", kind: "restart-channel", at: 1756500000000, ok: true }],
    },
  };
  const state = { usedBytes: 1, budgetBytes: 2, lastSweepAt: null, evicted: 0 };
  const { request } = await makeStorageRouterHarness({
    storageSweeper: { getState: () => state },
    getRuntimeExtras: () => extras,
  });

  const payload = JSON.parse((await request("GET", "/api/status")).body);
  assert.equal(payload.autoRepairExhausted, true);
  assert.deepEqual(payload.tunnelPortForeign, ["server-tengxun"]);
  assert.deepEqual(payload.autoRepair, extras.autoRepair);
  assert.deepEqual(payload.storage, state, "storage 与自动修复字段互不覆盖");
  assert.equal(payload.health, "ok", "旧字段一个不少");
});

test("/api/status: getRuntimeExtras 未注入或抛错时新字段整体缺席（旧协议逐字节不变）", async () => {
  const bare = await makeStorageRouterHarness({ storageSweeper: null });
  const barePayload = JSON.parse((await bare.request("GET", "/api/status")).body);
  assert.equal("autoRepairExhausted" in barePayload, false);
  assert.equal("tunnelPortForeign" in barePayload, false);
  assert.equal("autoRepair" in barePayload, false);

  const boom = await makeStorageRouterHarness({
    storageSweeper: null,
    getRuntimeExtras: () => {
      throw new Error("boom");
    },
  });
  const boomPayload = JSON.parse((await boom.request("GET", "/api/status")).body);
  assert.equal("autoRepairExhausted" in boomPayload, false);
  assert.equal(boomPayload.health, "ok", "取值抛错不得影响状态载荷本身");
});

// ---- POST 路由契约：与上面的 harness 同法，createHttpRouter 是无副作用工厂，注入 stub 直接打路由 ----

function makePostRouterHarness({ restartChannel, authToken = "secret" }) {
  return import("./lib/http-router.mjs").then(({ createHttpRouter }) => {
    const router = createHttpRouter({
      authToken,
      version: "0.0.0-test",
      publicDir: "/nonexistent-public-dir-for-test",
      logsDir: "/nonexistent-logs-dir-for-test",
      ndjsonTailLines: 100,
      maxSseConnections: 1,
      sseHeartbeatMs: 60000,
      store: {
        getLegacyStatus: () => ({ health: "ok" }),
        getLayers: () => ({ channel: { level: "ok" } }),
      },
      scheduler: {},
      metricsStore: {},
      historyStore: null,
      storageSweeper: null,
      bootstrapRunner: {},
      toolkit: {},
      appendLog: () => {},
      operationStorage: { run: (_ctx, fn) => fn() },
      getConfig: async () => ({}),
      restartChannel,
    });
    const request = async (reqPath, body, headers = {}) => {
      const res = {
        headers: {},
        setHeader: () => {},
        writeHead(status, resHeaders) {
          res.status = status;
          res.headers = resHeaders || {};
          return res;
        },
        end(payload) {
          res.body = payload;
          return res;
        },
      };
      const chunks = [Buffer.from(JSON.stringify(body ?? {}))];
      const req = {
        method: "POST",
        url: reqPath,
        headers: { host: "127.0.0.1:8877", "x-auth-token": authToken, ...headers },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk;
        },
        on(event, handler) {
          if (event === "data") for (const chunk of chunks) handler(chunk);
          if (event === "end") handler();
          return req;
        },
      };
      await router.handleHttpRequest(req, res);
      return res;
    };
    return { request };
  });
}

test("POST /api/restart: restartChannel 返回 ok:false 时回 409（此前吞掉返回值回 200）", async () => {
  const { request } = await makePostRouterHarness({
    restartChannel: async () => ({ ok: false, reason: "tunnel operation in flight" }),
  });
  const res = await request("/api/restart", {});
  assert.equal(res.status, 409);
  assert.equal(JSON.parse(res.body).error, "tunnel operation in flight");

  const okHarness = await makePostRouterHarness({
    restartChannel: async () => ({ ok: true, reason: "" }),
  });
  const ok = await okHarness.request("/api/restart", {});
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).health, "ok", "成功路径仍回完整 status 载荷");
});


test("decideHotStart：supervisor 缺失但代理/隧道存活 → adopt（只拉起 supervisor，绝不清场）", async () => {
  assert.equal(decideHotStart({ supervisor: [{ pid: 1 }], localProxy: [{ pid: 2 }], reverseTunnel: [], tunnelsByServer: {} }), "preserve");
  // 数据面升级途中控制面被重启 / supervisor 崩溃后重启界面：代理 + 隧道都在
  assert.equal(decideHotStart({ supervisor: [], localProxy: [{ pid: 2 }], reverseTunnel: [{ pid: 3 }] }), "adopt");
  // 只剩代理
  assert.equal(decideHotStart({ supervisor: [], localProxy: [{ pid: 2 }], reverseTunnel: [] }), "adopt");
  // 只剩某台非活跃服务器的隧道（reverseTunnel 为空，tunnelsByServer 有）
  assert.equal(decideHotStart({ supervisor: [], localProxy: [], reverseTunnel: [], tunnelsByServer: { a: [], b: [{ pid: 9 }] } }), "adopt");
  // 什么都没有 → 清场重启
  assert.equal(decideHotStart({ supervisor: [], localProxy: [], reverseTunnel: [], tunnelsByServer: { a: [] } }), "clean");
  assert.equal(decideHotStart({}), "clean");
  // supervisor 在但代理缺失：沿用旧行为
  assert.equal(decideHotStart({ supervisor: [{ pid: 1 }], localProxy: [] }), "clean");
});

// 行为化（原为读 monitor-server.mjs 源码切片做正则）：直接驱动 listen 回调体 runHotStart，
// 断言 adopt 分支的完整调用序列——只拉起 supervisor 认领存活代理/隧道，绝不清场。
test("热启动接线：adopt 分支走 autoRepairChannel({ force: true })，不调用 stopChannel", async () => {
  const { runHotStart } = await import("./server/hot-start.mjs");
  const calls = [];
  let shouldBeRunning = false;
  const channel = {
    setShouldBeRunning: (value) => {
      calls.push(`setShouldBeRunning:${value}`);
      shouldBeRunning = value;
    },
    getShouldBeRunning: () => shouldBeRunning,
    autoRepairChannel: async (options) => calls.push(`autoRepairChannel:${JSON.stringify(options)}`),
    stopChannel: async () => calls.push("stopChannel"),
  };
  await runHotStart({
    fixtureMode: false,
    toolkit: { getProcesses: async () => ({ supervisor: [], localProxy: [{ pid: 2 }], reverseTunnel: [{ pid: 3 }] }) },
    channel,
    store: { setShouldBeRunning: (value) => calls.push(`store:${value}`) },
    scheduler: { start: () => calls.push("scheduler.start"), tick: () => calls.push("scheduler.tick") },
    appendLog: () => {},
  });
  assert.deepEqual(calls, [
    "setShouldBeRunning:true",
    'autoRepairChannel:{"force":true}',
    "store:true",
    "scheduler.start",
    "scheduler.tick",
  ]);
  assert.ok(!calls.includes("stopChannel"), "adopt 绝不清场");
});
