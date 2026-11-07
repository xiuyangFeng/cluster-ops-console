import assert from "node:assert/strict";
import { test } from "node:test";

import { createDirUsageRoutes } from "./dir-usage.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
function postReq(body) { return { method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }; }

test("目录占用路由：读接口不发 SSH；扫描把调度器槽位交给服务；参数与错误码", async () => {
  const calls = [];
  const svc = {
    get: async (serverId, root) => { calls.push(["get", serverId, root]); return { eligible: true, serverId, scan: null }; },
    scan: async (serverId, opts, { acquireSshSlot }) => {
      calls.push(["scan", serverId, opts, typeof acquireSshSlot]);
      if (opts.mode === "continue") throw Object.assign(new Error("没有可继续的扫描"), { status: 409 });
      await acquireSshSlot({ hostKey: "h" });
      return { eligible: true, serverId, scan: { complete: false } };
    },
  };
  const acquired = [];
  const scheduler = { acquireSshSlot: async (o) => { acquired.push(o); return () => {}; } };
  const route = createDirUsageRoutes({ dirUsageService: svc, scheduler });

  const get = fakeRes();
  await route({ req: { method: "GET" }, res: get, url: new URL("http://x/api/dir-usage?serverId=s1&root=a%2Fb") });
  assert.equal(get.statusCode, 200);
  assert.deepEqual(calls.at(-1), ["get", "s1", "a/b"]);
  const noRoot = fakeRes();
  await route({ req: { method: "GET" }, res: noRoot, url: new URL("http://x/api/dir-usage?serverId=s1") });
  assert.deepEqual(calls.at(-1), ["get", "s1", null]);
  const badId = fakeRes();
  await route({ req: { method: "GET" }, res: badId, url: new URL("http://x/api/dir-usage?serverId=../x") });
  assert.equal(badId.statusCode, 400);

  const ok = fakeRes();
  await route({ req: postReq({ serverId: "s1", root: "", mode: "start" }), res: ok, url: new URL("http://x/api/dir-usage/scan") });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(acquired, [{ hostKey: "h" }]);
  const conflict = fakeRes();
  await route({ req: postReq({ serverId: "s1", mode: "continue" }), res: conflict, url: new URL("http://x/api/dir-usage/scan") });
  assert.equal(conflict.statusCode, 409);
  assert.equal(JSON.parse(conflict.body).error, "没有可继续的扫描");
  const bad = fakeRes();
  await route({ req: postReq({ serverId: "s1", root: 5 }), res: bad, url: new URL("http://x/api/dir-usage/scan") });
  assert.equal(bad.statusCode, 400);

  const none = fakeRes();
  await createDirUsageRoutes({ dirUsageService: null })({ req: { method: "GET" }, res: none, url: new URL("http://x/api/dir-usage?serverId=s1") });
  assert.equal(none.statusCode, 503);
});

test("目录占用路由：auto 交给自动续扫（立刻返回），stop 停止；服务器参数不合格 400", async () => {
  const calls = [];
  const svc = {
    get: async () => ({}),
    scan: async () => { calls.push(["scan"]); return {}; },
    startAuto: async (serverId, opts, { acquireSshSlot }) => { calls.push(["startAuto", serverId, opts, typeof acquireSshSlot]); return { eligible: true, serverId, auto: { running: true } }; },
    stopAuto: async (serverId) => { calls.push(["stopAuto", serverId]); return { eligible: true, serverId, auto: { running: true, stopping: true } }; },
  };
  const route = createDirUsageRoutes({ dirUsageService: svc, scheduler: { acquireSshSlot: async () => () => {} } });
  const started = fakeRes();
  await route({ req: postReq({ serverId: "s1", root: "a", mode: "continue", auto: true }), res: started, url: new URL("http://x/api/dir-usage/scan") });
  assert.equal(started.statusCode, 200);
  assert.equal(JSON.parse(started.body).auto.running, true);
  const stopped = fakeRes();
  await route({ req: postReq({ serverId: "s1" }), res: stopped, url: new URL("http://x/api/dir-usage/stop") });
  assert.equal(JSON.parse(stopped.body).auto.stopping, true);
  assert.deepEqual(calls, [["startAuto", "s1", { root: "a", mode: "continue" }, "function"], ["stopAuto", "s1"]]);
  const bad = fakeRes();
  await route({ req: postReq({ serverId: "../x" }), res: bad, url: new URL("http://x/api/dir-usage/stop") });
  assert.equal(bad.statusCode, 400);
  const none = fakeRes();
  await createDirUsageRoutes({ dirUsageService: null })({ req: postReq({ serverId: "s1" }), res: none, url: new URL("http://x/api/dir-usage/stop") });
  assert.equal(none.statusCode, 503);
});
