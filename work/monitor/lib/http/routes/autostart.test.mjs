// /api/autostart：状态透传、正文校验、错误码映射与运维日志。业务行为在 lib/autostart/service.test.mjs。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { statusError } from "../../status-error.mjs";
import { createAutostartRoutes } from "./autostart.mjs";

async function call(route, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    writeHead(code) { this.status = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: { operationId: "op-1" } });
  return { handled, status: res.status, body: res.body };
}

const STATUS = { supported: true, method: "launch-agent", enabled: false, state: "off" };

function setup(overrides = {}) {
  const calls = [];
  const logs = [];
  const autostart = {
    status: async () => STATUS,
    setEnabled: async (enabled) => {
      calls.push(enabled);
      return { ...STATUS, enabled, state: enabled ? "on" : "off", changed: true, launchd: enabled ? null : "not-loaded" };
    },
    ...overrides,
  };
  const route = createAutostartRoutes({ autostart, appendLog: (message, fields) => logs.push([message, fields]) });
  return { route, calls, logs };
}

test("GET /api/autostart：原样给出现状；读状态抛错时按错误的状态码回", async () => {
  const { route } = setup();
  assert.deepEqual(await call(route, "GET", "/api/autostart"), { handled: true, status: 200, body: STATUS });
  const failing = setup({ status: async () => { throw new Error("boom"); } });
  assert.deepEqual(await call(failing.route, "GET", "/api/autostart"), { handled: true, status: 500, body: { error: "boom" } });
});

test("POST /api/autostart：{ enabled: 布尔 } 交给服务，回显结果并记一条运维日志", async () => {
  const { route, calls, logs } = setup();
  const on = await call(route, "POST", "/api/autostart", { enabled: true });
  assert.deepEqual([on.status, on.body.enabled, on.body.changed], [200, true, true]);
  const off = await call(route, "POST", "/api/autostart", { enabled: false });
  assert.deepEqual([off.status, off.body.enabled, off.body.launchd], [200, false, "not-loaded"]);
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(logs, [
    ["autostart enabled (launch-agent)", { operationId: "op-1", event: "autostart" }],
    ["autostart disabled (launch-agent, launchd: not-loaded)", { operationId: "op-1", event: "autostart" }],
  ]);
});

test("POST /api/autostart：什么都没改（重复打开）不记日志", async () => {
  const { route, logs } = setup({ setEnabled: async () => ({ ...STATUS, enabled: true, state: "on", changed: false, launchd: null }) });
  assert.equal((await call(route, "POST", "/api/autostart", { enabled: true })).status, 200);
  assert.deepEqual(logs, []);
});

test("POST /api/autostart：正文不是 { enabled: 布尔 } → 400，不碰服务", async () => {
  const { route, calls } = setup();
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }, [true], "true"]) {
    const res = await call(route, "POST", "/api/autostart", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await call(route, "POST", "/api/autostart", "{oops")).status, 400, "坏 JSON");
  assert.equal((await call(route, "POST", "/api/autostart")).status, 400, "空正文");
  assert.deepEqual(calls, []);
});

test("POST /api/autostart：服务拒绝时状态码与 code 原样带出，并记一条警告", async () => {
  const { route, logs } = setup({
    setEnabled: async () => { throw statusError("已经存在，但不是工作台放的，没有改动它。", 409, { code: "foreign-file" }); },
  });
  const res = await call(route, "POST", "/api/autostart", { enabled: true });
  assert.deepEqual([res.status, res.body], [409, { error: "已经存在，但不是工作台放的，没有改动它。", code: "foreign-file" }]);
  assert.deepEqual(logs, [["autostart not changed: foreign-file", { operationId: "op-1", event: "autostart", level: "warn" }]]);
});

test("服务缺席 → 503；别的路径与方法不归这一组", async () => {
  const route = createAutostartRoutes({});
  assert.deepEqual(await call(route, "GET", "/api/autostart"), { handled: true, status: 503, body: { error: "autostart unavailable" } });
  assert.equal((await call(route, "POST", "/api/autostart", { enabled: true })).status, 503);
  const { route: present } = setup();
  assert.equal((await call(present, "GET", "/api/autostart/other")).handled, false);
  assert.equal((await call(present, "DELETE", "/api/autostart")).handled, false);
});
