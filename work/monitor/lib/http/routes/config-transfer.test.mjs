// /api/config/transfer · export · import*：透传、请求体上限与错误形状。业务行为在 lib/config-transfer/config-transfer.test.mjs。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { IMPORT_MAX_BYTES } from "../../config-transfer/document.mjs";
import { statusError } from "../../status-error.mjs";
import { createConfigTransferRoutes, IMPORT_BODY_MAX_BYTES } from "./config-transfer.mjs";

async function call(route, method, path, body, headers = {}) {
  const raw = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const req = Readable.from(raw ? [raw] : []);
  req.method = method;
  req.headers = { ...(raw ? { "content-length": String(raw.length) } : {}), ...headers };
  const res = {
    writeHead(code) { this.status = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: {} });
  return { handled, status: res.status, body: res.body };
}

function setup(overrides = {}) {
  const calls = [];
  const configTransfer = {
    describe: () => ({ excluded: ["x"], backups: { count: 0 } }),
    exportDocument: async () => ({ filename: "f.json", document: { format: "cluster-workbench-config" } }),
    previewImport: async (doc) => { calls.push(["preview", doc]); return { changes: [], revision: 3 }; },
    applyImport: async (doc, opts) => { calls.push(["apply", doc, opts]); return { success: true, applied: opts.selected }; },
    ...overrides,
  };
  return { route: createConfigTransferRoutes({ configTransfer }), calls };
}

test("没装配：四个接口都 503；不认识的路径交给下一组", async () => {
  const route = createConfigTransferRoutes({});
  for (const [method, path] of [["GET", "/api/config/transfer"], ["GET", "/api/config/export"], ["POST", "/api/config/import/preview"], ["POST", "/api/config/import"]]) {
    assert.equal((await call(route, method, path, method === "POST" ? { document: {} } : undefined)).status, 503, path);
  }
  assert.equal((await call(route, "GET", "/api/config/personal")).handled, false);
});

test("GET：说明与导出原样透传", async () => {
  const { route } = setup();
  assert.deepEqual(await call(route, "GET", "/api/config/transfer"), { handled: true, status: 200, body: { excluded: ["x"], backups: { count: 0 } } });
  const exported = await call(route, "GET", "/api/config/export");
  assert.deepEqual([exported.status, exported.body.filename], [200, "f.json"]);
});

test("POST：正文必须是 { document: 对象 }；导入把勾选与版本号交给服务", async () => {
  const { route, calls } = setup();
  const doc = { format: "cluster-workbench-config", formatVersion: 1 };
  assert.deepEqual((await call(route, "POST", "/api/config/import/preview", { document: doc })).body, { changes: [], revision: 3 });
  const applied = await call(route, "POST", "/api/config/import", { document: doc, selected: ["personal.sshUser"], revision: 3 });
  assert.deepEqual(applied.body, { success: true, applied: ["personal.sshUser"] });
  assert.deepEqual(calls, [["preview", doc], ["apply", doc, { selected: ["personal.sshUser"], revision: 3 }]]);
  for (const bad of ["not json", [], { document: [] }, { other: 1 }]) {
    const res = await call(route, "POST", "/api/config/import/preview", bad);
    assert.deepEqual([res.status, res.body.code], [400, "invalid-body"], JSON.stringify(bad));
  }
});

test("请求体上限：声明超限直接 413；没声明长度但实际超限按坏请求 400", async () => {
  const { route, calls } = setup();
  assert.ok(IMPORT_BODY_MAX_BYTES > IMPORT_MAX_BYTES);
  const big = await call(route, "POST", "/api/config/import", undefined, { "content-length": String(IMPORT_BODY_MAX_BYTES + 1) });
  assert.deepEqual([big.status, big.body.code], [413, "too-large"]);
  assert.match(big.body.error, /上限 256 KB/);
  const huge = { document: { pad: "x".repeat(IMPORT_BODY_MAX_BYTES) } };
  const streamed = await call(route, "POST", "/api/config/import/preview", huge, { "content-length": undefined });
  assert.equal(streamed.status, 400);
  assert.deepEqual(calls, [], "超限的正文不会交给服务");
});

test("服务抛错：按错误的状态码回 { error, code, errors }", async () => {
  const { route } = setup({
    previewImport: async () => { throw statusError("这不是工作台导出的配置文件", 400, { code: "bad-format" }); },
    applyImport: async () => { throw Object.assign(new Error("个人服务器配置未通过校验"), { status: 400, errors: [{ field: "servers[0].host", message: "x" }] }); },
    exportDocument: async () => { throw statusError("个人配置读不出来", 409, { code: "personal-unreadable" }); },
  });
  assert.deepEqual((await call(route, "POST", "/api/config/import/preview", { document: {} })).body, { error: "这不是工作台导出的配置文件", code: "bad-format" });
  const failed = await call(route, "POST", "/api/config/import", { document: {} });
  assert.deepEqual([failed.status, failed.body.errors[0].field], [400, "servers[0].host"]);
  assert.deepEqual((await call(route, "GET", "/api/config/export")).status, 409);
});
