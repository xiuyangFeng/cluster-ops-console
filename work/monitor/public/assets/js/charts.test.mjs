// charts.js 的状态与取数逻辑（无 DOM：绘制在 Node 里直接跳过，这里测的是序列、范围、摘要）。
// fetch 用桩替换：/api/metrics 与 /api/metrics/range 各返回给定样本，并记下每次请求的地址。
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmoothPath,
  claimTrendServer,
  getTrendSummary,
  onTrendChange,
  parseRangePayload,
  pushSample,
  resetCharts,
  seedFromMetrics,
  setTrendRange,
  trendRevision,
} from "./charts.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// routes: { metrics(url) → 样本数组 | Promise, range(url) → 响应体 | Promise }；返回请求记录。
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (path) => {
    const url = new URL(path, "http://localhost");
    calls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/metrics") return json({ samples: await routes.metrics(url) });
    if (url.pathname === "/api/metrics/range") {
      if (!routes.range) return json({ error: "not found" }, 404);
      return json(await routes.range(url));
    }
    return json({ error: "unexpected" }, 500);
  };
  return calls;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// 一条新采集口径的后端样本。
const metric = (ts, cpuBusyPct, ram, disk) => ({ ts, serverId: "s1", kind: "resource", cpu: 99, ram, disk, cpuBusyPct, loadNormalizedPct: 50, metricSchemaVersion: 1 });

test.afterEach(() => {
  globalThis.fetch = realFetch;
  resetCharts();
  setTrendRange("h24");
});

test("buildSmoothPath: 纵轴下限——量程收窄到 [min, max]，低于下限的值压在底边", () => {
  const { line } = buildSmoothPath([80, 90, 100], 200, 24, 100, 80);
  assert.match(line, /^M 0 22 /, "80 在 80–100 的轴上是底边");
  assert.match(line, / 100 12 C /, "90 在正中");
  assert.match(line, / 200 2$/, "100 在顶边");
  assert.match(buildSmoothPath([10, 90], 200, 24, 100, 80).line, /^M 0 22 /);
  // 不传 min 与此前完全一致；非法的 min 当 0
  assert.deepEqual(buildSmoothPath([0, 50, 100], 300, 24), buildSmoothPath([0, 50, 100], 300, 24, 100, 0));
  assert.deepEqual(buildSmoothPath([0, 50, 100], 300, 24, 100, 100), buildSmoothPath([0, 50, 100], 300, 24));
});

test("parseRangePayload: CPU 按 busy → 归一化负载 → 旧 cpu 取值；极值换成 { lo, hi }，缺失时退回均值序列自己的高低值", () => {
  const parsed = parseRangePayload({
    samples: [
      { ts: 3000, cpuBusyPct: null, loadNormalizedPct: 130, cpu: 100, ram: 50, disk: 86 },
      { ts: 1000, cpuBusyPct: 7.5, loadNormalizedPct: 20, cpu: 20, ram: 40, disk: 93 },
      { ts: 2000, cpuBusyPct: null, loadNormalizedPct: null, cpu: 46, ram: null, disk: 90 },
    ],
    extremes: { cpu: { min: 0.1, max: 140 }, ram: { min: 12, max: 66 }, disk: null },
  });
  // 历史样本不带 metricSchemaVersion：busy / 负载都缺时回落旧 cpu（旧采集脚本那几天不至于整段空白）
  assert.deepEqual(parsed.series.cpu, { values: [7.5, 46, 130], ts: [1000, 2000, 3000] });
  assert.deepEqual(parsed.series.ram, { values: [40, 50], ts: [1000, 3000] });
  assert.deepEqual(parsed.extents, { cpu: { lo: 0.1, hi: 140 }, ram: { lo: 12, hi: 66 }, disk: { lo: 86, hi: 93 } });
  assert.deepEqual(parseRangePayload(null).extents, { cpu: null, ram: null, disk: null });
});

test("播种：认领服务器、拉近 24 小时；30 分钟 / 24 小时的高低值取逐条采样，近 7 天序列给磁盘走势", async () => {
  const now = Date.now();
  const calls = stubFetch({
    metrics: () => [metric(now - 20 * HOUR, 60, 30, 93), metric(now - 10 * MIN, 5, 22, 86), metric(now - 5 * MIN, 9, 24, 86)],
    range: (url) => ({
      serverId: "s1", range: url.searchParams.get("range"), stepMs: HOUR,
      samples: [{ ts: now - 6 * 24 * HOUR, cpuBusyPct: 3, loadNormalizedPct: 4, cpu: 4, ram: 20, disk: 94 }, { ts: now - HOUR, cpuBusyPct: 6, loadNormalizedPct: 8, cpu: 8, ram: 23, disk: 86 }],
      extremes: { cpu: { min: 0, max: 99.6 }, ram: { min: 1, max: 66 }, disk: { min: 86, max: 96 } },
    }),
  });
  let notified = 0;
  const off = onTrendChange(() => { notified += 1; });
  const before = trendRevision();
  assert.deepEqual(getTrendSummary().extents, { cpu: null, ram: null, disk: null }, "没播种、也没攒够实时点：不给高低值");

  await seedFromMetrics("s1");
  await settle();
  const since = Number(new URL(calls.find((c) => c.startsWith("/api/metrics?")), "http://localhost").searchParams.get("since"));
  assert.ok(Math.abs(since - (now - 24 * HOUR)) < 5000, "播种恒拉 24 小时（30 分钟与 24 小时两档共用）");
  assert.ok(calls.includes("/api/metrics/range?serverId=s1&range=7d"), "近 7 天恒要");
  assert.ok(!calls.some((c) => c.includes("range=30d")), "没选 30 天就不拉 30 天");
  assert.ok(trendRevision() > before && notified >= 2, "历史与 7 天结果到货各通知一次");

  const day = getTrendSummary();
  assert.equal(day.rangeKey, "h24");
  assert.equal(day.label, "24 小时");
  assert.deepEqual(day.extents, { cpu: { lo: 5, hi: 60 }, ram: { lo: 22, hi: 30 }, disk: { lo: 86, hi: 93 } });
  assert.deepEqual(day.diskWeek.values, [94, 86]);

  assert.equal(setTrendRange("m30"), true);
  assert.equal(setTrendRange("m30"), false, "同一档不重复通知");
  assert.deepEqual(getTrendSummary().extents, { cpu: { lo: 5, hi: 9 }, ram: { lo: 22, hi: 24 }, disk: { lo: 86, hi: 86 } });

  // 7 天：已缓存，不再请求；高低值取后端给的逐条极值（不是均值序列的高低值）
  const requests = calls.length;
  setTrendRange("d7");
  await settle();
  assert.equal(calls.length, requests);
  assert.deepEqual(getTrendSummary().extents, { cpu: { lo: 0, hi: 99.6 }, ram: { lo: 1, hi: 66 }, disk: { lo: 86, hi: 96 } });
  assert.equal(getTrendSummary().label, "7 天");

  // 30 天：切过去才拉；到货前不给高低值
  setTrendRange("d30");
  assert.deepEqual(getTrendSummary().extents, { cpu: null, ram: null, disk: null });
  await settle();
  assert.equal(calls.at(-1), "/api/metrics/range?serverId=s1&range=30d");
  assert.deepEqual(getTrendSummary().extents.disk, { lo: 86, hi: 96 });

  // 认不出的范围回落默认档
  setTrendRange("1y");
  assert.equal(getTrendSummary().rangeKey, "h24");

  // 重新认领同一台服务器（切走再切回）：长范围不看缓存、取新的
  const again = calls.length;
  await seedFromMetrics("s1");
  await settle();
  assert.deepEqual(calls.slice(again).filter((c) => c.includes("/range")), ["/api/metrics/range?serverId=s1&range=7d"]);
  off();
});

test("播种以后端为准：请求发出前残留的点丢掉，在途时追加的实时点并回去", async () => {
  const now = Date.now();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stubFetch({ metrics: async () => { await gate; return [metric(now - 10 * MIN, 10, 20, 30), metric(now - 9 * MIN, 12, 20, 30)]; } });
  // 切换前残留的一条（上一台服务器的读数）
  assert.equal(pushSample({ cpu: 99, ram: 99, disk: 99 }, { dedupeKey: now - 3 * MIN }), true);
  const seeding = seedFromMetrics("s1");
  // 请求在途时来了一条新采样
  assert.equal(pushSample({ cpu: 14, ram: 21, disk: 30 }, { dedupeKey: now - MIN }), true);
  release();
  await seeding;
  setTrendRange("m30");
  assert.deepEqual(getTrendSummary().extents, { cpu: { lo: 10, hi: 14 }, ram: { lo: 20, hi: 21 }, disk: { lo: 30, hi: 30 } });
});

test("切换服务器：过期的播种结果丢弃，不落到新服务器的序列里", async () => {
  const now = Date.now();
  const gates = {};
  const calls = stubFetch({
    metrics: (url) => new Promise((resolve) => { gates[url.searchParams.get("serverId")] = resolve; }),
  });
  const first = seedFromMetrics("a");
  await settle();
  resetCharts();
  const second = seedFromMetrics("b");
  await settle();
  gates.b([metric(now - 5 * MIN, 20, 20, 20), metric(now - 4 * MIN, 22, 20, 20)]);
  gates.a([metric(now - 5 * MIN, 90, 90, 90), metric(now - 4 * MIN, 95, 90, 90)]);
  await Promise.all([first, second]);
  assert.deepEqual(calls.filter((c) => c.startsWith("/api/metrics?")).map((c) => new URL(c, "http://localhost").searchParams.get("serverId")), ["a", "b"]);
  assert.deepEqual(getTrendSummary().extents.cpu, { lo: 20, hi: 22 });
  // resetCharts 之后不属于任何服务器：高低值清空，新采样也不触发任何请求
  resetCharts();
  const requests = calls.length;
  pushSample({ cpu: 1, ram: 1, disk: 1 }, { dedupeKey: now });
  await settle();
  assert.equal(calls.length, requests);
  assert.deepEqual(getTrendSummary().extents, { cpu: null, ram: null, disk: null });
});

test("认领：实时序列不属于正在看的这台就当场清空并重新播种；已经是它就什么都不做", async () => {
  const now = Date.now();
  const calls = stubFetch({
    metrics: (url) => (url.searchParams.get("serverId") === "a"
      ? [metric(now - 3 * MIN, 80, 80, 80), metric(now - 2 * MIN, 85, 80, 80)]
      : [metric(now - 3 * MIN, 10, 10, 10), metric(now - 2 * MIN, 12, 10, 10)]),
  });
  const seeds = () => calls.filter((c) => c.startsWith("/api/metrics?")).map((c) => new URL(c, "http://localhost").searchParams.get("serverId"));
  assert.equal(claimTrendServer(undefined), false, "没给 id（旧调用方 / 测试）不认领");
  assert.equal(claimTrendServer("a"), true);
  assert.equal(claimTrendServer("a"), false);
  // 认领已经发起了播种：紧跟着的显式播种（切换流程里的 seedFromMetrics）不重复请求
  await seedFromMetrics("a");
  await settle();
  assert.deepEqual(seeds(), ["a"]);
  pushSample({ cpu: 90, ram: 80, disk: 80 }, { dedupeKey: now - MIN });
  assert.deepEqual(getTrendSummary().extents.cpu, { lo: 80, hi: 90 });

  // 另一个窗口把查看视角切到了 b：a 的点一条都不能留在 b 的曲线里
  assert.equal(claimTrendServer("b"), true);
  assert.deepEqual(getTrendSummary().extents, { cpu: null, ram: null, disk: null }, "认领的那一刻旧序列就清空");
  // 同一个 dedupeKey 也要收（去重门控随认领清零），并在播种到货后保留
  assert.equal(pushSample({ cpu: 14, ram: 10, disk: 10 }, { dedupeKey: now - MIN }), true);
  await settle();
  assert.deepEqual(seeds(), ["a", "b"]);
  assert.deepEqual(getTrendSummary().extents.cpu, { lo: 10, hi: 14 });
});

test("补缺口：新采样离上一条太远（窗口被隐藏过）就把中间缺的拉回来；紧挨着的不拉", async () => {
  const now = Date.now();
  const calls = stubFetch({
    metrics: (url) => {
      const since = Number(url.searchParams.get("since"));
      return [metric(now - 60 * MIN, 10, 10, 10), metric(now - 59 * MIN, 11, 10, 10), metric(now - 30 * MIN, 70, 10, 10), metric(now - 2 * MIN, 12, 10, 10)]
        .filter((s) => s.ts >= since && (since > now - 23 * HOUR || s.ts <= now - 59 * MIN));
    },
  });
  await seedFromMetrics("s1"); // 播种只拿到一小时前的两条（之后窗口被隐藏）
  const metricsCalls = () => calls.filter((c) => c.startsWith("/api/metrics?"));
  assert.equal(metricsCalls().length, 1);

  // 回到前台：新采样离上一条 57 分钟 → 从上一条之后补
  pushSample({ cpu: 13, ram: 10, disk: 10 }, { dedupeKey: now - 2 * MIN });
  await settle();
  assert.equal(metricsCalls().length, 2);
  assert.equal(Number(new URL(metricsCalls()[1], "http://localhost").searchParams.get("since")), now - 59 * MIN + 1);
  // 补回了中间那条 70；同一次采样（实时点与后端样本）只留一份
  assert.deepEqual(getTrendSummary().extents.cpu, { lo: 10, hi: 70 });

  // 下一条按时到：不再请求
  pushSample({ cpu: 14, ram: 10, disk: 10 }, { dedupeKey: now - MIN });
  await settle();
  assert.equal(metricsCalls().length, 2);
});

test("长范围取不到（旧后端没有这个接口）：不抛错、不反复请求，其余照常", async () => {
  const now = Date.now();
  const calls = stubFetch({ metrics: () => [metric(now - 2 * MIN, 10, 20, 30), metric(now - MIN, 12, 20, 30)] });
  // 换一个服务器 id：长范围结果按服务器缓存，resetCharts 不清（切回去时不用重拉），别的用例里 s1 已经有了。
  await seedFromMetrics("legacy");
  await settle();
  assert.equal(calls.filter((c) => c.includes("/api/metrics/range")).length, 1);
  assert.equal(getTrendSummary().diskWeek, null);
  pushSample({ cpu: 11, ram: 20, disk: 30 }, { dedupeKey: now });
  setTrendRange("d7");
  await settle();
  assert.equal(calls.filter((c) => c.includes("/api/metrics/range")).length, 1, "重试间隔内不再请求");
  assert.deepEqual(getTrendSummary().extents, { cpu: null, ram: null, disk: null });
  setTrendRange("h24");
  assert.deepEqual(getTrendSummary().extents.cpu, { lo: 10, hi: 12 });
});
