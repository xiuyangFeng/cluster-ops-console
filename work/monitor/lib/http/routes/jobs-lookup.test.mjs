import assert from "node:assert/strict";
import { test } from "node:test";

import { createJobsLookupRoutes } from "./jobs-lookup.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}

const NOW = Date.UTC(2026, 9, 6, 7, 0, 0);

async function call(route, path) {
  const res = fakeRes();
  const handled = await route({ req: { method: "GET" }, res, url: new URL(`http://x${path}`) });
  return { handled, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

function service(overrides = {}) {
  const calls = [];
  return {
    calls,
    lookupHistory: async (serverId, query, options) => { calls.push(["lookup", serverId, query, typeof options.acquireSshSlot]); return { state: "ok", rows: [], snapshotId: "qabc0001" }; },
    historyGroupPage: async (serverId, snapshot, key, options) => { calls.push(["group", serverId, snapshot, key, options.limit]); return { snapshotId: snapshot, key, total: 0, children: [], more: 0 }; },
    ...overrides,
  };
}

test("GET /api/jobs/lookup：作业号 / 日期范围校验通过才转给服务，并带上全局 SSH 槽位", async () => {
  const jobs = service();
  const route = createJobsLookupRoutes({ jobsService: jobs, acquireSshSlot: async () => () => {}, now: () => NOW });
  const a = await call(route, "/api/jobs/lookup?serverId=server-01&job=13207_5");
  assert.deepEqual([a.handled, a.status, a.body.snapshotId], [true, 200, "qabc0001"]);
  await call(route, "/api/jobs/lookup?serverId=server-01&from=2026-09-30&to=2026-10-06");
  await call(route, "/api/jobs/lookup?serverId=server-01&from=2026-10-04&to=2026-10-04&endBefore=1791100000000");
  assert.deepEqual(jobs.calls, [
    ["lookup", "server-01", { kind: "job", job: "13207_5" }, "function"],
    ["lookup", "server-01", { kind: "range", from: "2026-09-30", to: "2026-10-06", endBefore: null }, "function"],
    ["lookup", "server-01", { kind: "range", from: "2026-10-04", to: "2026-10-04", endBefore: 1791100000000 }, "function"],
  ]);
});

test("GET /api/jobs/lookup：非法参数一律 400 且不碰服务；在途过多 429；模块关闭 { disabled }；无服务 503", async () => {
  const jobs = service();
  const route = createJobsLookupRoutes({ jobsService: jobs, now: () => NOW });
  for (const qs of [
    "serverId=server-01",
    "serverId=..%2Fx&job=1",
    "serverId=server-01&job=1%3Bid",
    "serverId=server-01&job=1&from=2026-10-01&to=2026-10-01",
    "serverId=server-01&from=2026-09-01&to=2026-09-30",
    "serverId=server-01&from=2026-10-02&to=2026-10-01",
    "serverId=server-01&from=2030-01-01&to=2030-01-01",
    "serverId=server-01&from=2026-10-01&to=2026-10-01&endBefore=abc",
  ]) {
    const { status } = await call(route, `/api/jobs/lookup?${qs}`);
    assert.equal(status, 400, qs);
  }
  assert.deepEqual(jobs.calls, []);
  const busy = createJobsLookupRoutes({ jobsService: service({ lookupHistory: async () => ({ busy: true }) }), now: () => NOW });
  assert.equal((await call(busy, "/api/jobs/lookup?serverId=server-01&job=1")).status, 429);
  const off = createJobsLookupRoutes({ jobsService: jobs, getConfig: async () => ({ modules: { jobs: false } }), now: () => NOW });
  assert.deepEqual((await call(off, "/api/jobs/lookup?serverId=server-01&job=1")).body, { disabled: true });
  assert.equal((await call(createJobsLookupRoutes({ jobsService: null }), "/api/jobs/lookup?serverId=server-01&job=1")).status, 503);
});

test("GET /api/jobs/group：快照标识 / 组 key / limit 校验；快照换代或过期 → 409", async () => {
  const jobs = service();
  const route = createJobsLookupRoutes({ jobsService: jobs });
  const ok = await call(route, `/api/jobs/group?serverId=server-01&snapshot=live-${NOW}&key=${encodeURIComponent("COMPLETED|cfa-agiter20")}&limit=150`);
  assert.equal(ok.status, 200);
  assert.deepEqual(jobs.calls, [["group", "server-01", `live-${NOW}`, "COMPLETED|cfa-agiter20", 150]]);
  for (const qs of [
    "snapshot=x&key=A%7Cb&limit=10",
    "snapshot=live-1&key=nobar&limit=10",
    "snapshot=live-1&key=A%7C%0Ab&limit=10",
    `snapshot=live-1&key=${"A|".repeat(101)}&limit=10`,
    "snapshot=live-1&key=A%7Cb&limit=0",
    "snapshot=live-1&key=A%7Cb&limit=1001",
    "snapshot=live-1&key=A%7Cb&limit=1.5",
  ]) assert.equal((await call(route, `/api/jobs/group?serverId=server-01&${qs}`)).status, 400, qs);
  const expired = createJobsLookupRoutes({ jobsService: service({ historyGroupPage: async () => ({ expired: true }) }) });
  const res = await call(expired, "/api/jobs/group?serverId=server-01&snapshot=qabc0001&key=A%7Cb&limit=10");
  assert.deepEqual([res.status, res.body], [409, { error: "snapshot expired" }]);
});

test("不认识的路径不接", async () => {
  const route = createJobsLookupRoutes({ jobsService: service() });
  assert.equal((await call(route, "/api/jobs?serverId=server-01")).handled, false);
});
