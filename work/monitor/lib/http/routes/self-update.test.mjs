// /api/self-update*：状态码与载荷的透传在 routes.contract.test.mjs 里；这里补「重启监控服务」——
// 只有启动器会把服务重新拉起来时才受理，而且是先把响应发出去、再开始退出。
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { createSelfUpdateRoutes } from "./self-update.mjs";

async function call(route, method, path) {
  const req = Readable.from([]);
  req.method = method;
  const res = {
    writeHead(code) { this.status = code; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await route({ req, res, url: new URL(`http://127.0.0.1${path}`), operationContext: { operationId: "op-1" } });
  return { handled, status: res.status, body: res.body };
}

test("重启监控服务：启动器会重新拉起时受理——先回 200，稍后才触发退出", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const order = [];
  const logs = [];
  const route = createSelfUpdateRoutes({
    selfUpdate: { respawn: true },
    requestRestart: () => order.push("restart"),
    appendLog: (message, fields) => logs.push([message, fields]),
  });
  const res = await call(route, "POST", "/api/self-update/restart");
  order.push("responded");
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  assert.deepEqual(order, ["responded"], "响应发出之前不退出");
  t.mock.timers.tick(200);
  assert.deepEqual(order, ["responded", "restart"]);
  assert.deepEqual(logs, [["self-update: restarting monitor server (data plane preserved)", { operationId: "op-1", event: "self-update" }]]);
});

test("重启监控服务：不是启动器起的（桌面壳 / 手工起的）→ 409，说明该怎么重启，不触发退出", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let restarted = 0;
  for (const deps of [
    { selfUpdate: { respawn: false }, requestRestart: () => { restarted += 1; } },
    { selfUpdate: { respawn: true }, requestRestart: null },
  ]) {
    const res = await call(createSelfUpdateRoutes(deps), "POST", "/api/self-update/restart");
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "no-respawn");
    assert.match(res.body.error, /重启界面/);
  }
  t.mock.timers.tick(1000);
  assert.equal(restarted, 0);
});

test("应用失败：状态码与 code 原样带出；别的路径不归这一组", async () => {
  const route = createSelfUpdateRoutes({
    selfUpdate: {
      apply: async () => { throw Object.assign(new Error("这个版本改了依赖，需要在终端里更新"), { status: 409, code: "needs-install" }); },
      check: async ({ force }) => ({ forced: force }),
    },
  });
  const applied = await call(route, "POST", "/api/self-update/apply");
  assert.deepEqual([applied.status, applied.body], [409, { error: "这个版本改了依赖，需要在终端里更新", code: "needs-install" }]);
  assert.deepEqual((await call(route, "POST", "/api/self-update/check")).body, { forced: true }, "手动检查一律强制 fetch");
  assert.equal((await call(route, "GET", "/api/self-update/other")).handled, false);
});
