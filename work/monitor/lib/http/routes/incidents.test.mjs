import assert from "node:assert/strict";
import { test } from "node:test";

import { createIncidentStore } from "../../incidents/store.mjs";
import { createIncidentRoutes } from "./incidents.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
const get = async (route, path) => {
  const res = fakeRes();
  assert.equal(await route({ req: { method: "GET" }, res, url: new URL(`http://x${path}`) }), true);
  return JSON.parse(res.body);
};

test("事件列表：未解决的磁盘超阈值事件带一句详情；别的事件、已恢复的列表不带；详情不写回事件", async () => {
  const store = createIncidentStore({ openGate: {} });
  store.observeDiskUsage({ serverId: "s1", usedPct: 92 });
  store.observeDiskUsage({ serverId: "s2", usedPct: 96 });
  store.observeDiskUsage({ serverId: "quiet", usedPct: 93 });
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  const asked = [];
  const describeDisk = async (serverId) => {
    asked.push(serverId);
    if (serverId === "s2") throw new Error("趋势读不到");
    if (serverId === "quiet") return { text: "", trend: null };
    return { text: "近 24 小时你的作业目录增长约 1.1 TiB，其中 b1 +1 TiB；按这个速度约 4 天写满。", trend: { daysToFull: 4 } };
  };
  const route = createIncidentRoutes({ incidentStore: store, describeDisk });

  const open = await get(route, "/api/incidents?state=open&limit=50");
  const byKey = Object.fromEntries(open.incidents.map((i) => [`${i.serverId}|${i.reasonCode}`, i]));
  assert.deepEqual(byKey["s1|DISK_THRESHOLD"].detail, { text: "近 24 小时你的作业目录增长约 1.1 TiB，其中 b1 +1 TiB；按这个速度约 4 天写满。" });
  assert.equal("detail" in byKey["s2|DISK_THRESHOLD"], false, "取详情出错：照常列出，只是不带");
  assert.equal("detail" in byKey["quiet|DISK_THRESHOLD"], false, "没有话可说：不带空串");
  assert.equal("detail" in byKey["s1|TUNNEL_DOWN"], false);
  assert.deepEqual(asked.sort(), ["quiet", "s1", "s2"], "只问磁盘事件，每条一次");
  assert.equal(open.total, 4);
  assert.ok(store.query({ state: "open" }).incidents.every((i) => !("detail" in i)), "事件本身没有被改写");

  // 已恢复的磁盘事件不带
  store.observeDiskUsage({ serverId: "s1", usedPct: 50 });
  store.observeDiskUsage({ serverId: "s1", usedPct: 50 });
  store.observeDiskUsage({ serverId: "s1", usedPct: 50 });
  asked.length = 0;
  const resolved = await get(route, "/api/incidents?state=resolved&limit=50");
  assert.ok(resolved.incidents.some((i) => i.reasonCode === "DISK_THRESHOLD" && i.serverId === "s1"), "夹具：s1 的磁盘事件已恢复");
  assert.ok(resolved.incidents.every((i) => !("detail" in i)));
  assert.deepEqual(asked, []);

  // 没接详情来源：与原来逐字相同
  const plain = createIncidentRoutes({ incidentStore: store });
  assert.deepEqual(await get(plain, "/api/incidents?state=open"), store.query({ state: "open", limit: 50 }));
});

test("事件簇：group=cluster 按簇返回（同类 15 分钟内接连发生的合成一簇），type 过滤同逐条；不带 group 形状不变", async () => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 9, 23, 1, 0, 0);
  let clock = T0;
  const store = createIncidentStore({ now: () => clock, openGate: {} });
  const flap = (start, dur, serverId = "s1") => {
    store.observe({ serverId, component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", at: start });
    store.reportSuccess({ serverId, component: "tunnel", at: start + dur });
    store.reportSuccess({ serverId, component: "tunnel", at: start + dur + 1 });
  };
  for (const offset of [0, 4, 9]) flap(T0 + offset * MIN, MIN);
  flap(T0 + 2 * MIN, MIN, "s2");
  clock = T0 + 30 * MIN;
  const route = createIncidentRoutes({ incidentStore: store, now: () => clock });
  const grouped = await get(route, "/api/incidents?state=resolved&group=cluster&limit=50");
  assert.equal(grouped.state, "resolved");
  assert.equal(grouped.total, 2);
  assert.equal(grouped.incidentTotal, 4);
  const s1 = grouped.clusters.find((c) => c.serverId === "s1");
  assert.equal(s1.count, 3);
  assert.equal(s1.members.length, 3);
  const typed = await get(route, `/api/incidents?state=resolved&group=cluster&type=${encodeURIComponent("s2|tunnel|TUNNEL_DOWN")}`);
  assert.deepEqual(typed.clusters.map((c) => c.serverId), ["s2"]);
  const flat = await get(route, "/api/incidents?state=resolved&limit=50");
  assert.equal(flat.incidents.length, 4);
  assert.equal("clusters" in flat, false);

  // 未解决事件：带「短时间内第几次」
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", at: T0 + 15 * MIN });
  store.observe({ serverId: "s2", component: "filesystem", reasonCode: "FS_SLOW", severity: "warn", at: T0 + 15 * MIN });
  const open = await get(route, "/api/incidents?state=open");
  const tunnel = open.incidents.find((i) => i.component === "tunnel");
  assert.deepEqual(tunnel.recurrence, { count: 4, sinceAt: T0, downMs: 3 * MIN + 3 });
  assert.equal("recurrence" in open.incidents.find((i) => i.component === "filesystem"), false);
});

test("前后经过：GET /api/incidents/:id/context 汇集账本 / 历史 / 日志；任一数据源出错当没有；事件不存在 404", async () => {
  const MIN = 60_000;
  const T0 = Date.UTC(2026, 9, 23, 1, 0, 0);
  const store = createIncidentStore({ now: () => T0, openGate: {} });
  const incident = store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", at: T0 });
  const daysAsked = [];
  const route = createIncidentRoutes({
    incidentStore: store,
    now: () => T0 + 5 * MIN,
    loadLedger: async () => [{ type: "wake", at: T0 - MIN, sleptMs: 2 * MIN }],
    readHistoryDay: async (day) => {
      daysAsked.push(day);
      if (day === "2026-10-22") throw new Error("读不到");
      return [{ type: "signal", ts: T0 + MIN, severity: "warn", signalId: "rate-limited", title: "限流" }];
    },
    queryLogs: () => { throw new Error("日志环坏了"); },
  });
  const ctx = await get(route, `/api/incidents/${incident.incidentId}/context`);
  assert.deepEqual(ctx.entries.map((e) => e.kind), ["sleep", "incident-open", "signal"]);
  assert.deepEqual(daysAsked.sort(), ["2026-10-23"], "窗口 [T0-10min, 现在] 在北京时间同一天");

  const bare = createIncidentRoutes({ incidentStore: store, now: () => T0 + 5 * MIN });
  assert.deepEqual((await get(bare, `/api/incidents/${incident.incidentId}/context`)).entries.map((e) => e.kind), ["incident-open"], "没有数据源也能返回");
  const res = fakeRes();
  await route({ req: { method: "GET" }, res, url: new URL("http://x/api/incidents/nope/context") });
  assert.equal(res.statusCode, 404);
  const bad = fakeRes();
  await route({ req: { method: "GET" }, res: bad, url: new URL("http://x/api/incidents/%E0%A4%A/context") });
  assert.equal(bad.statusCode, 404, "畸形转义当不存在");
});
