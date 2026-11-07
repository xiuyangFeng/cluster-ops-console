// /api/diagnostics/*：服务缺席 503、诊断包透传、状态快照取不到时只影响那一块、脚本错误上报的状态码。
// 取数与限流的行为在 lib/diagnostics/service.test.mjs。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createDiagnosticsRoutes } from "./diagnostics.mjs";

async function call(route, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    writeHead(code) { this.status = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: undefined });
  return { handled, status: res.status, body: res.body };
}

test("服务缺席：两条都 503；别的路径不接", async () => {
  const route = createDiagnosticsRoutes({});
  assert.equal((await call(route, "GET", "/api/diagnostics/bundle")).status, 503);
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", { kind: "error", message: "x" })).status, 503);
  assert.equal((await call(route, "GET", "/api/diagnostics")).handled, false);
});

test("GET /api/diagnostics/bundle：带上当前状态快照；取状态抛错时以 { error } 交给服务", async () => {
  const seen = [];
  const diagnostics = { buildBundle: async ({ status }) => { seen.push(status); return { filename: "f.json", bundle: { status }, bytes: 1, redactions: 0 }; } };
  const ok = await call(createDiagnosticsRoutes({ diagnostics, getStatusPayload: () => ({ health: "ok" }) }), "GET", "/api/diagnostics/bundle");
  assert.deepEqual([ok.status, ok.body.filename, ok.body.bundle.status], [200, "f.json", { health: "ok" }]);
  const broken = await call(createDiagnosticsRoutes({ diagnostics, getStatusPayload: () => { throw new Error("store down"); } }), "GET", "/api/diagnostics/bundle");
  assert.equal(broken.status, 200);
  assert.deepEqual(seen.at(-1), { error: "store down" });
  const failing = await call(createDiagnosticsRoutes({ diagnostics: { buildBundle: async () => { throw new Error("disk"); } } }), "GET", "/api/diagnostics/bundle");
  assert.deepEqual([failing.status, failing.body], [500, { error: "disk" }]);
});

test("POST /api/diagnostics/client-error：收下 202，坏正文 400，重复 / 超限 429", async () => {
  const bodies = [];
  const verdicts = [{ ok: true }, { ok: false, reason: "duplicate" }, { ok: false, reason: "rate-limited" }, { ok: false, reason: "invalid" }];
  const diagnostics = { recordClientError: (body) => { bodies.push(body); return verdicts.shift(); } };
  const route = createDiagnosticsRoutes({ diagnostics });
  const payload = { kind: "error", message: "boom" };
  assert.deepEqual(await call(route, "POST", "/api/diagnostics/client-error", payload), { handled: true, status: 202, body: { accepted: true } });
  assert.deepEqual((await call(route, "POST", "/api/diagnostics/client-error", payload)).body, { accepted: false, reason: "duplicate" });
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", payload)).status, 429);
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", payload)).status, 400);
  assert.equal(bodies.length, 4);
  // 不是对象 / 坏 JSON / 超过 16 KB：不交给服务
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", [1, 2])).status, 400);
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", "{bad")).status, 400);
  assert.equal((await call(route, "POST", "/api/diagnostics/client-error", { kind: "error", message: "x".repeat(20 * 1024) })).status, 400);
  assert.equal(bodies.length, 4);
});
