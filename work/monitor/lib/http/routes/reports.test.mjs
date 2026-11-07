import assert from "node:assert/strict";
import test from "node:test";
import { createReportRoutes } from "./reports.mjs";

const config = { servers: [{ id: "s1", host: "example.test" }] };
const route = createReportRoutes({ getConfig: async () => config,
  jobsService: { getSnapshot: () => ({ state: "ok", jobs: [{ id: "12", state: "RUNNING" }] }) } });
async function call(query, method = "GET") {
  const res = { writeHead(code) { this.status = code; }, end(body) { this.body = JSON.parse(body); } };
  const handled = await route({ req: { method }, res, url: new URL(`http://local/api/reports?${query}`) });
  return { ...res, handled };
}

test("报告接口合法目标有内容，非法标识拒绝，未知目标404，不接受写入", async () => {
  const good = await call("kind=job&serverId=s1&jobId=12");
  assert.equal(good.status, 200);
  assert.match(good.body.markdown, /RUNNING/);
  for (const q of ["", "kind=other&serverId=s1", "kind=job&serverId=..%2F&jobId=12", "kind=job&serverId=s1&jobId=12;id", "kind=incident&serverId=s1&incidentId=../../passwd"]) assert.equal((await call(q)).status, 400);
  assert.equal((await call("kind=job&serverId=s1&jobId=13")).status, 404);
  assert.equal((await call("kind=job&serverId=s1&jobId=12", "POST")).handled, false);
});
