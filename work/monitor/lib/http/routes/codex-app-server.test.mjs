import assert from "node:assert/strict";
import { test } from "node:test";

import { createCodexAppServerRoutes } from "./codex-app-server.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
const postReq = (body) => ({ method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); } });

function setup({ result = { ok: true, result: "restarted" }, service = undefined } = {}) {
  const calls = [];
  const forced = [];
  const codexAppServer = service === null ? null : {
    restart: async (target, runtime) => {
      calls.push([target, typeof runtime?.acquireSshSlot]);
      if (target.serverId === "other") throw Object.assign(new Error("只能操作当前查看中的服务器，请刷新页面"), { status: 409 });
      return result;
    },
  };
  const route = createCodexAppServerRoutes({
    codexAppServer,
    scheduler: { acquireSshSlot: async () => () => {}, forceRun: (id) => forced.push(id) },
  });
  const post = async (body) => {
    const res = fakeRes();
    const handled = await route({ req: postReq(body), res, url: new URL("http://x/api/codex/app-server/restart") });
    return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  return { post, calls, forced };
}

test("重启路由：只把 serverId 交给服务层，带上 SSH 槽位；成功后补跑 doctor，不阻塞响应", async () => {
  const h = setup();
  const res = await h.post({ serverId: "s1" });
  assert.deepEqual([res.status, res.json], [200, { ok: true, result: "restarted" }]);
  assert.deepEqual(h.calls, [[{ serverId: "s1" }, "function"]]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.forced, ["doctor"]);
  const bare = await h.post({});
  assert.deepEqual([bare.status, bare.json], [200, { ok: true, result: "restarted" }]);
});

test("重启路由：请求里不接受别的键、serverId 不合法一律 400；服务层的 409 原样返回，失败结果不补跑探针", async () => {
  const h = setup({ result: { ok: false, result: "failed", error: "ssh exit 255" } });
  for (const body of [
    { serverId: "s1", port: 7893 },
    { serverId: "s1", command: "id" },
    ["s1"],
  ]) {
    const res = await h.post(body);
    assert.deepEqual([res.status, res.json], [400, { error: "只接受 serverId" }]);
  }
  assert.deepEqual((await h.post({ serverId: "../x" })).json, { error: "invalid serverId" });
  assert.equal((await h.post("{broken")).status, 400);
  assert.equal((await h.post({ serverId: "other" })).status, 409);
  const failed = await h.post({ serverId: "s1" });
  assert.deepEqual([failed.status, failed.json.ok], [200, false]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.forced, [], "失败不补跑探针");
});

test("服务缺席 503；GET 不归这一组", async () => {
  const none = setup({ service: null });
  assert.deepEqual((await none.post({})).json, { error: "codex app-server unavailable" });
  const route = createCodexAppServerRoutes({ codexAppServer: {}, scheduler: null });
  const res = fakeRes();
  assert.equal(await route({ req: { method: "GET" }, res, url: new URL("http://x/api/codex/app-server/restart") }), false);
});
