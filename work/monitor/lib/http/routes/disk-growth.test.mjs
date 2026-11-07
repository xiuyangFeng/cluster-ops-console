import assert from "node:assert/strict";
import { test } from "node:test";

import { createDiskGrowthRoutes } from "./disk-growth.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
function postReq(body) { return { method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); } }; }
const url = (path) => new URL(`http://x${path}`);

test("磁盘增长路由：读接口只读本机结果并带上趋势与那句话；不在范围 / 模块关着的原样返回", async () => {
  const calls = [];
  const svc = {
    get: async (serverId) => {
      calls.push(["get", serverId]);
      if (serverId === "me") return { eligible: false, serverId };
      if (serverId === "off") return { eligible: true, serverId, disabled: true };
      return { eligible: true, serverId, running: false, run: null, growth: { measuredAt: 5, rows: [] } };
    },
  };
  const described = [];
  const describeDisk = async (serverId) => {
    described.push(serverId);
    return { text: "近 24 小时你的作业目录增长约 1.1 TiB；按这个速度约 4 天写满。", trend: { usedPct: 91, deltaPct: 5, daysToFull: 4.2 } };
  };
  const route = createDiskGrowthRoutes({ diskGrowthService: svc, describeDisk });

  const ok = fakeRes();
  assert.equal(await route({ req: { method: "GET" }, res: ok, url: url("/api/disk-growth?serverId=s1") }), true);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(JSON.parse(ok.body), {
    eligible: true, serverId: "s1", running: false, run: null, growth: { measuredAt: 5, rows: [] },
    trend: { usedPct: 91, deltaPct: 5, daysToFull: 4.2 }, detail: "近 24 小时你的作业目录增长约 1.1 TiB；按这个速度约 4 天写满。",
  });
  const personal = fakeRes();
  await route({ req: { method: "GET" }, res: personal, url: url("/api/disk-growth?serverId=me") });
  assert.deepEqual(JSON.parse(personal.body), { eligible: false, serverId: "me" });
  const off = fakeRes();
  await route({ req: { method: "GET" }, res: off, url: url("/api/disk-growth?serverId=off") });
  assert.deepEqual(JSON.parse(off.body), { eligible: true, serverId: "off", disabled: true });
  assert.deepEqual(described, ["s1"], "只给量得出东西的服务器算那句话");

  for (const bad of ["/api/disk-growth", "/api/disk-growth?serverId=", "/api/disk-growth?serverId=..%2Fx"]) {
    const res = fakeRes();
    await route({ req: { method: "GET" }, res, url: url(bad) });
    assert.equal(res.statusCode, 400, bad);
  }
  assert.deepEqual(calls.map((c) => c[1]), ["s1", "me", "off"]);

  // 没接趋势来源：照常返回测量，不带那两项
  const plain = fakeRes();
  await createDiskGrowthRoutes({ diskGrowthService: svc })({ req: { method: "GET" }, res: plain, url: url("/api/disk-growth?serverId=s1") });
  assert.deepEqual(Object.keys(JSON.parse(plain.body)), ["eligible", "serverId", "running", "run", "growth"]);
  const none = fakeRes();
  await createDiskGrowthRoutes({ diskGrowthService: null })({ req: { method: "GET" }, res: none, url: url("/api/disk-growth?serverId=s1") });
  assert.equal(none.statusCode, 503);
  assert.equal(await route({ req: { method: "GET" }, res: fakeRes(), url: url("/api/disk-growth/other") }), false, "别的路径不归这一组");
});

test("磁盘增长路由：按需量一次把调度器槽位交给服务并立刻返回；同时只跑一个 → 409；参数不合格 400", async () => {
  const calls = [];
  const svc = {
    get: async () => ({}),
    scanNow: async (serverId, deps) => {
      calls.push([serverId, typeof deps.acquireSshSlot]);
      if (serverId === "busy") throw Object.assign(new Error("这台服务器正在量，请稍候"), { status: 409 });
      if (serverId === "me") throw Object.assign(new Error("这台服务器不量作业产出目录（只对团队集群开放）"), { status: 404 });
      if (serverId === "boom") throw new Error("意外");
      await deps.acquireSshSlot({ hostKey: "h" });
      return { eligible: true, serverId, running: true, run: { trigger: "manual", rounds: 0 }, growth: null };
    },
  };
  const acquired = [];
  const route = createDiskGrowthRoutes({ diskGrowthService: svc, scheduler: { acquireSshSlot: async (o) => { acquired.push(o); return () => {}; } } });

  const started = fakeRes();
  await route({ req: postReq({ serverId: "s1" }), res: started, url: url("/api/disk-growth/scan") });
  assert.equal(started.statusCode, 200);
  assert.deepEqual([JSON.parse(started.body).running, JSON.parse(started.body).run.trigger], [true, "manual"]);
  assert.deepEqual(acquired, [{ hostKey: "h" }]);
  for (const [serverId, status, message] of [["busy", 409, "这台服务器正在量，请稍候"], ["me", 404, "这台服务器不量作业产出目录（只对团队集群开放）"], ["boom", 500, "意外"]]) {
    const res = fakeRes();
    await route({ req: postReq({ serverId }), res, url: url("/api/disk-growth/scan") });
    assert.deepEqual([res.statusCode, JSON.parse(res.body).error], [status, message]);
  }
  for (const body of [{ serverId: "../x" }, {}, [], { serverId: 5 }]) {
    const res = fakeRes();
    await route({ req: postReq(body), res, url: url("/api/disk-growth/scan") });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.deepEqual(calls.map((c) => c[0]), ["s1", "busy", "me", "boom"]);

  // 没有调度器：不替服务编一个槽位，由服务自己决定（没有定时用的槽位就 503）
  const bare = [];
  await createDiskGrowthRoutes({ diskGrowthService: { scanNow: async (_id, deps) => { bare.push(deps); return {}; } } })({ req: postReq({ serverId: "s1" }), res: fakeRes(), url: url("/api/disk-growth/scan") });
  assert.deepEqual(bare, [{}]);
  const none = fakeRes();
  await createDiskGrowthRoutes({ diskGrowthService: null })({ req: postReq({ serverId: "s1" }), res: none, url: url("/api/disk-growth/scan") });
  assert.equal(none.statusCode, 503);
});
