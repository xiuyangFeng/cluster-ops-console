import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ConfigValidationError } from "../../config-loader.mjs";
import { createEgressRoutes } from "./egress.mjs";

const STATUS = { egress: { mode: "direct", url: null }, allowlist: { personal: [], team: [], max: 32 }, proxyPort: 8888 };

async function call(route, method, path, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  req.method = method;
  const res = {
    writeHead(code) {
      this.status = code;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: { operationId: "op-1" } });
  return { handled, status: res.status, body: res.body };
}

test("/api/egress*：GET 读状态；POST 改方式 / 白名单把正文与操作上下文交给服务；自测只收 local / full", async () => {
  const calls = [];
  const route = createEgressRoutes({
    egressService: {
      getStatus: async () => STATUS,
      setMode: async (data, ctx) => {
        calls.push(["setMode", data, ctx]);
        return { ...STATUS, egress: { mode: data.mode, url: null } };
      },
      updateAllowlist: async (data, ctx) => {
        calls.push(["updateAllowlist", data, ctx]);
        return STATUS;
      },
      runSelfTest: async (opts) => {
        calls.push(["runSelfTest", opts]);
        return { results: [], suggestion: null };
      },
    },
  });
  assert.deepEqual(await call(route, "GET", "/api/egress"), { handled: true, status: 200, body: STATUS });
  const set = await call(route, "POST", "/api/egress", { mode: "system" });
  assert.equal(set.status, 200);
  assert.equal(set.body.egress.mode, "system");
  assert.equal((await call(route, "POST", "/api/egress/allowlist", { add: "a.example.com:9443" })).status, 200);
  assert.equal((await call(route, "POST", "/api/egress/self-test", { scope: "full" })).status, 200);
  assert.equal((await call(route, "POST", "/api/egress/self-test", { scope: "everything" })).status, 200);
  assert.deepEqual(calls, [
    ["setMode", { mode: "system" }, { operationId: "op-1" }],
    ["updateAllowlist", { add: "a.example.com:9443" }, { operationId: "op-1" }],
    ["runSelfTest", { scope: "full" }],
    ["runSelfTest", { scope: "local" }],
  ]);
  assert.equal((await call(route, "POST", "/api/egress", "{bad json")).status, 400);
  assert.equal((await call(route, "GET", "/api/egress/self-test")).handled, false, "只认 POST");
  assert.equal((await call(route, "DELETE", "/api/egress")).handled, false);
});

test("/api/egress*：校验失败回 400 { error, errors }，版本冲突 409；服务缺席 503", async () => {
  const route = createEgressRoutes({
    egressService: {
      getStatus: async () => STATUS,
      setMode: async () => {
        throw new ConfigValidationError("出网设置未通过校验", [{ field: "egress.url", message: "手动地址必须是 http://主机:端口" }]);
      },
      updateAllowlist: async () => {
        throw new ConfigValidationError("配置已被修改，请重新加载后保存", [], 409);
      },
      runSelfTest: async () => {
        throw new Error("boom");
      },
    },
  });
  const bad = await call(route, "POST", "/api/egress", { mode: "manual", url: "x" });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "出网设置未通过校验", errors: [{ field: "egress.url", message: "手动地址必须是 http://主机:端口" }] });
  assert.equal((await call(route, "POST", "/api/egress/allowlist", { add: "x" })).status, 409);
  assert.deepEqual(await call(route, "POST", "/api/egress/self-test", {}), { handled: true, status: 500, body: { error: "boom" } });

  const missing = createEgressRoutes({ egressService: null });
  for (const [method, path] of [["GET", "/api/egress"], ["POST", "/api/egress"], ["POST", "/api/egress/allowlist"], ["POST", "/api/egress/self-test"]]) {
    assert.equal((await call(missing, method, path, {})).status, 503, `${method} ${path}`);
  }
});
