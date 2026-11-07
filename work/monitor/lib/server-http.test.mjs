import assert from "node:assert/strict";
import test from "node:test";
import { createHttpRouter } from "./http-router.mjs";

function harness(deps) {
  const router = createHttpRouter({
    authToken: "fixture", publicDir: "/nonexistent", logsDir: "/nonexistent",
    store: {}, scheduler: {}, toolkit: {}, metricsStore: {}, bootstrapRunner: {},
    appendLog() {}, getConfig: async () => ({}),
    operationStorage: { run: (_context, fn) => fn() }, ...deps,
  });
  return async (url, { method = "GET", body, token = "fixture", raw } = {}) => {
    const req = { url, method, headers: { host: "127.0.0.1:8877", "x-auth-token": token },
      async *[Symbol.asyncIterator]() { yield raw ?? JSON.stringify(body ?? {}); } };
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await router.handleHttpRequest(req, res);
    return res;
  };
}

test("server lifecycle routes carry revision guards including DELETE", async () => {
  const calls = [];
  const serverRegistry = Object.fromEntries(["add", "update", "disable", "enable", "remove", "restore", "putCredentials"].map(name => [name, async (...args) => { calls.push([name, ...args]); return { ok: true }; }]));
  const request = harness({ serverRegistry });
  for (const [path, method, name] of [["", "POST", "add"], ["/s", "PATCH", "update"], ["/s", "DELETE", "remove"], ["/s/disable", "POST", "disable"], ["/s/enable", "POST", "enable"], ["/s/restore", "POST", "restore"], ["/s/credentials", "POST", "putCredentials"]]) {
    const result = await request(`/api/servers${path}`, { method, body: { expectedRevision: 7 } });
    assert.ok([200, 201].includes(result.status));
    assert.equal(calls.at(-1)[0], name);
    // 正文是 add 的第 1 个参数、其余路由的第 2 个参数（update 另带 { acquireSshSlot } 选项）。
    assert.equal(calls.at(-1)[name === "add" ? 1 : 2].expectedRevision, 7);
  }
});

test("suggest-port 把调度器 SSH 槽位交给 registry（并发上限 3 是硬约束）；PATCH 只写配置", async () => {
  const seen = [];
  const acquired = [];
  const scheduler = { acquireSshSlot: async (opts) => { acquired.push(opts); return () => {}; } };
  const serverRegistry = {
    suggestPort: async (id, opts) => { seen.push(["suggestPort", id]); await opts.acquireSshSlot({ hostKey: "h" }); return { ok: true }; },
    update: async (id) => { seen.push(["update", id]); return { ok: true }; },
  };
  const request = harness({ serverRegistry, scheduler });
  assert.equal((await request("/api/servers/s/suggest-port")).status, 200);
  assert.equal((await request("/api/servers/s", { method: "PATCH", body: { remotePort: 7896 } })).status, 200);
  assert.deepEqual(seen, [["suggestPort", "s"], ["update", "s"]]);
  assert.deepEqual(acquired, [{ hostKey: "h" }]);
});

test("malformed/array bodies and unauthorized calls cannot mutate servers", async () => {
  const forbidden = () => assert.fail("must not mutate");
  const request = harness({ serverRegistry: { add: forbidden, update: forbidden, disable: forbidden, remove: forbidden, putCredentials: forbidden } });
  for (const [url, method] of [["/api/servers", "POST"], ["/api/servers/s", "PATCH"], ["/api/servers/s", "DELETE"], ["/api/servers/s/disable", "POST"], ["/api/servers/s/credentials", "POST"]]) {
    assert.equal((await request(url, { method, body: [] })).status, 400);
    assert.equal((await request(url, { method, raw: "{broken" })).status, 400);
    assert.equal((await request(url, { method, token: "incorrect" })).status, 401);
  }
});

test("conflict and failed SSH test remain distinguishable HTTP results", async () => {
  const request = harness({ serverRegistry: {
    disable: async () => { throw Object.assign(new Error("配置已变化"), { status: 409, code: "revision-conflict" }); },
    testConnection: async () => ({ ok: false, code: "auth-required", nextAction: "重新输入密码" }),
  } });
  const conflict = await request("/api/servers/s/disable", { method: "POST", body: { expectedRevision: 1 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "revision-conflict");
  const tested = await request("/api/servers/s/test", { method: "POST" });
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, false);
});

test("local detail reads reuse fresh cache, bound integer limits and refresh stale data", async () => {
  let count = 0;
  let last = { observedAt: new Date().toISOString(), topProcesses: Array.from({ length: 55 }, (_, pid) => ({ pid })) };
  const request = harness({ localResourceProbe: { getLast: () => last, sample: async () => { count++; return last; } } });
  assert.equal((await request("/api/local/resources?limit=3.9")).body.topProcesses.length, 3);
  assert.equal((await request("/api/local/processes?limit=9999")).body.processes.length, 50);
  assert.equal(count, 0);
  last = { ...last, observedAt: new Date(Date.now() - 16000).toISOString() };
  await request("/api/local/resources");
  assert.equal(count, 1);
  last = null;
  assert.equal((await request("/api/local/resources")).status, 503);
});

test("POST /api/data-plane/upgrade：鉴权、透传状态码与响应体", async () => {
  const seen = [];
  const dataPlaneUpgrader = {
    upgrade: async (body) => {
      seen.push(body);
      if (!Array.isArray(body?.components)) return { status: 400, body: { error: "bad components" } };
      return { status: 200, body: { ok: true, steps: [], tunnels: { before: {}, after: {} }, proxy: { beforePid: 1, afterPid: 2 } } };
    },
  };
  const request = harness({ dataPlaneUpgrader });
  const ok = await request("/api/data-plane/upgrade", { method: "POST", body: { components: ["proxy"] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.proxy, { beforePid: 1, afterPid: 2 });
  assert.deepEqual(seen.at(-1), { components: ["proxy"] });
  assert.equal((await request("/api/data-plane/upgrade", { method: "POST", raw: "{broken" })).status, 400);
  const denied = await request("/api/data-plane/upgrade", { method: "POST", body: { components: ["proxy"] }, token: "incorrect" });
  assert.equal(denied.status, 401);
  assert.equal(seen.length, 2, "未鉴权的请求到不了 upgrader");
});

test("POST /api/stop：数据面升级在飞时回 409，不调用 stopChannel；升级结束后照常停止", async () => {
  let inFlight = true;
  let stops = 0;
  const request = harness({
    dataPlaneUpgrader: { upgrade: async () => ({ status: 200, body: { ok: true } }), isInFlight: () => inFlight },
    stopChannel: async () => { stops += 1; },
  });
  const blocked = await request("/api/stop", { method: "POST" });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /升级/);
  assert.equal(stops, 0);
  inFlight = false;
  const ok = await request("/api/stop", { method: "POST" });
  // 状态载荷依赖的 store/scheduler 在此是空桩，只断言停止确实被执行、且不再是 409。
  assert.notEqual(ok.status, 409);
  assert.equal(stops, 1);
});
