// /api/egress/proxy-auth*、/api/egress/usage 的路由层：正文与错误怎么过。业务规则在 lib/egress/ 各自的测试里。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { statusError } from "../../status-error.mjs";
import { createEgressRoutes } from "./egress.mjs";

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

test("改模式 / 换口令 / 写到集群 / 读使用记录：正文原样交给服务，结果原样回给界面", async () => {
  const calls = [];
  const route = createEgressRoutes({
    egressService: {
      getStatus: async () => ({}),
      setProxyAuth: async (data) => {
        calls.push(["setProxyAuth", data]);
        return { proxyAuth: { mode: data.mode ?? "observe" }, proxyAuthResult: { action: "mode" } };
      },
      syncProxyAuth: async (data) => {
        calls.push(["syncProxyAuth", data]);
        return { sync: { status: data.confirm ? "synced" : "preview" }, proxyAuth: {} };
      },
      getUsage: async () => ({ windowHours: 24, targets: [] }),
    },
  });
  const set = await call(route, "POST", "/api/egress/proxy-auth", { mode: "observe" });
  assert.deepEqual(set, { handled: true, status: 200, body: { proxyAuth: { mode: "observe" }, proxyAuthResult: { action: "mode" } } });
  assert.equal((await call(route, "POST", "/api/egress/proxy-auth", { rotate: true })).status, 200);
  assert.equal((await call(route, "POST", "/api/egress/proxy-auth/sync", {})).body.sync.status, "preview");
  assert.equal((await call(route, "POST", "/api/egress/proxy-auth/sync", { confirm: true })).body.sync.status, "synced");
  assert.deepEqual((await call(route, "GET", "/api/egress/usage")).body, { windowHours: 24, targets: [] });
  assert.deepEqual(calls, [
    ["setProxyAuth", { mode: "observe" }],
    ["setProxyAuth", { rotate: true }],
    ["syncProxyAuth", {}],
    ["syncProxyAuth", { confirm: true }],
  ]);
  // 方法不对的不归这组路由管（最终 404）；正文不是 JSON 的 400。
  assert.equal((await call(route, "GET", "/api/egress/proxy-auth")).handled, false);
  assert.equal((await call(route, "POST", "/api/egress/usage", {})).handled, false);
  assert.equal((await call(route, "POST", "/api/egress/proxy-auth", "{bad json")).status, 400);
});

test("错误：带上状态码与 code；切强制要确认时把风险清单一并给界面", async () => {
  const risks = [{ code: "unauthenticated", requests: 5, targets: [{ target: "chatgpt.com:443", missing: 5, bad: 0, denied: 0, lastAt: 1 }], moreTargets: 0 }];
  const route = createEgressRoutes({
    egressService: {
      setProxyAuth: async (data) => {
        if (data.mode === "enforce") throw statusError("切到「强制」前请先确认", 409, { code: "confirm-required", risks });
        if (data.rotate) throw statusError("上一次换口令的过渡期还没结束", 409, { code: "rotation-in-progress", previousUntil: 12345 });
        throw statusError("口令模式只能是 off / observe / enforce", 400, { code: "bad-mode" });
      },
      syncProxyAuth: async () => {
        throw statusError("没有写成：SSH 执行失败", 502, { code: "failed" });
      },
      getUsage: async () => {
        throw new Error("boom");
      },
    },
  });
  assert.deepEqual(await call(route, "POST", "/api/egress/proxy-auth", { mode: "enforce" }), {
    handled: true,
    status: 409,
    body: { error: "切到「强制」前请先确认", code: "confirm-required", risks },
  });
  assert.deepEqual((await call(route, "POST", "/api/egress/proxy-auth", { rotate: true })).body, { error: "上一次换口令的过渡期还没结束", code: "rotation-in-progress", previousUntil: 12345 });
  assert.equal((await call(route, "POST", "/api/egress/proxy-auth", { mode: "x" })).status, 400);
  assert.deepEqual(await call(route, "POST", "/api/egress/proxy-auth/sync", { confirm: true }), { handled: true, status: 502, body: { error: "没有写成：SSH 执行失败", code: "failed" } });
  assert.equal((await call(route, "GET", "/api/egress/usage")).status, 400);
});

test("服务没有这几项能力（旧装配 / 未装配）：503，不是 500", async () => {
  for (const egressService of [null, { getStatus: async () => ({}) }]) {
    const route = createEgressRoutes({ egressService });
    assert.equal((await call(route, "POST", "/api/egress/proxy-auth", { mode: "observe" })).status, 503);
    assert.equal((await call(route, "POST", "/api/egress/proxy-auth/sync", {})).status, 503);
    assert.equal((await call(route, "GET", "/api/egress/usage")).status, 503);
  }
});
