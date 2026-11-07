// POST /api/servers/:id/sync-cluster-env：用户点的「同步到集群」一律是强制同步；服务缺失 / 不在范围内给出明确状态码。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createServerRoutes } from "./servers.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
function postReq(body = {}) { return { method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }; }
const url = (id) => new URL(`http://x/api/servers/${id}/sync-cluster-env`);

test("同步到集群：强制同步并原样返回结果；不在范围内 409；服务缺失 503", async () => {
  const calls = [];
  const clusterEnvSync = {
    sync: async (id, options) => {
      calls.push([id, options]);
      return id === "mine" ? { status: "ineligible", state: null } : { status: "synced", state: { state: "in-sync", expectedPort: 7893 } };
    },
  };
  const route = createServerRoutes({ serverRegistry: {}, scheduler: {}, clusterEnvSync });

  const ok = fakeRes();
  assert.equal(await route({ req: postReq(), res: ok, url: url("server-01") }), true);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), { serverId: "server-01", status: "synced", state: { state: "in-sync", expectedPort: 7893 } });
  assert.deepEqual(calls, [["server-01", { force: true }]]);

  const personal = fakeRes();
  await route({ req: postReq(), res: personal, url: url("mine") });
  assert.equal(personal.statusCode, 409);
  assert.equal(JSON.parse(personal.body).code, "ineligible");

  const missing = fakeRes();
  await createServerRoutes({ serverRegistry: {}, scheduler: {} })({ req: postReq(), res: missing, url: url("server-01") });
  assert.equal(missing.statusCode, 503);
});
