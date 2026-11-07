// 端点星点图：对数刻度、银河分档、无检测时段、失败成段、SVG 内容与悬停取点（纯函数）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  axisLabel, bucketSizeOf, buildStarfieldModel, buildStarfieldSvg, failureSpans, latencyScale, pickStar, starfieldGeometry, starTip,
} from "./endpoint-starfield.js";

const NOW = Date.parse("2026-10-22T11:30:00+08:00");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (hhmm, day = "22") => Date.parse(`2026-10-${day}T${hhmm}:00+08:00`);

// 每 90 秒一次；from / to 是北京时间 "HH:MM"（day 21 / 22），value(i) 给读数，fail(i) 为真则失败
function series(from, to, { value = () => 200, fail = () => false } = {}) {
  const points = [];
  for (let ts = from, i = 0; ts <= to; ts += 90_000, i += 1) points.push({ ts, ok: !fail(i, ts), value: value(i, ts) });
  return points;
}
const trendOf = (points, extra = {}) => ({ points, t0: NOW - 24 * HOUR, t1: NOW, intervalMs: 90_000, p95: 400, metric: "latency", ...extra });

test("latencyScale: 量程落在 1-2-3-5 上且至少跨 4 倍；刻度优先 1-3，太少换 1-2-5；没有读数给 100ms–1s", () => {
  assert.deepEqual(latencyScale([90, 160, 8330]), { lo: 50, hi: 10000, ticks: [100, 300, 1000, 3000, 10000] });
  assert.deepEqual(latencyScale([150, 151]), { lo: 100, hi: 500, ticks: [100, 200, 500] });
  assert.deepEqual(latencyScale([]), { lo: 100, hi: 1000, ticks: [100, 300, 1000] });
  assert.deepEqual(latencyScale([null, -1, Number.NaN]).ticks, [100, 300, 1000]);
  assert.deepEqual([47, 300, 1000, 2500, 10000].map(axisLabel), ["47ms", "300ms", "1s", "2.5s", "10s"]);
});

test("bucketSizeOf: 约 20 分钟一档；检测稀时放宽到每档至少 6 次，最长 2 小时", () => {
  assert.equal(bucketSizeOf(90_000), 20 * MIN);
  assert.equal(bucketSizeOf(10 * MIN), 60 * MIN);
  assert.equal(bucketSizeOf(3 * HOUR), 2 * HOUR);
  assert.equal(bucketSizeOf(null), 20 * MIN);
});

test("failureSpans: 挨着的失败连成一段，隔开的各成一段", () => {
  const f = (minute) => ({ ts: NOW + minute * MIN });
  assert.deepEqual(failureSpans([f(0), f(1.5), f(3), f(30), f(31.5)], 90_000).map((s) => [(s.to - s.from) / MIN, s.count]), [[3, 3], [1.5, 2]]);
  assert.deepEqual(failureSpans([], 90_000), []);
});

test("buildStarfieldModel: 星点、最慢 5%、银河分段、无检测时段、最慢与最近", () => {
  // 11:30 前 24 小时：12:00–19:00 有检测（16:00 前后一段连续失败），19:00–06:30 没有，06:30–现在又有
  const morning = series(at("06:30"), at("11:29"), { value: (i) => (i === 40 ? 950 : 180 + (i % 7) * 10) });
  const afternoon = series(at("12:00", "21"), at("19:00", "21"), { value: (i) => (i === 100 ? 8330 : 150 + (i % 5) * 20), fail: (_i, ts) => ts >= at("16:00", "21") && ts < at("16:30", "21") });
  const model = buildStarfieldModel(trendOf([...afternoon, ...morning, { ts: NOW - 30 * HOUR, ok: true, value: 100 }]));
  assert.equal(model.all.length, afternoon.length + morning.length, "窗口外的样本丢掉");
  assert.equal(model.failures.length, 20);
  assert.equal(model.slowest.value, 8330);
  assert.equal(model.latest.ts, morning.at(-1).ts);
  assert.deepEqual([model.lo, model.hi], [100, 10000]);
  assert.ok(model.stars.filter((s) => s.slow).every((s) => s.value > 400), "高于 95 分位的才算最慢 5%");
  assert.ok(model.stars.some((s) => s.slow));
  // 无检测：窗口开头 11:30–12:00、19:00–06:30；16:00–16:30 有检测（虽然失败），不算无检测
  assert.deepEqual(model.gaps.map((g) => [g.from, g.to]), [[NOW - 24 * HOUR, afternoon[0].ts], [afternoon.at(-1).ts, morning[0].ts]]);
  // 银河在失败段与无检测处断开：下午两段 + 早上一段
  assert.equal(model.runs.length, 3);
  for (const run of model.runs) for (const c of run) assert.ok(c.p25 <= c.p50 && c.p50 <= c.p75);
  assert.equal(buildStarfieldModel(null), null);
});

test("buildStarfieldModel: 成功不足 20 次时不分「最慢 5%」；每档不足 3 次不画银河", () => {
  const few = buildStarfieldModel(trendOf(series(at("11:00"), at("11:20"), { value: (i) => 100 + i * 100 }), { p95: 1000 }));
  assert.equal(few.stars.length, 14);
  assert.ok(few.stars.every((s) => !s.slow));
  const sparse = buildStarfieldModel(trendOf([{ ts: at("10:00"), ok: true, value: 200 }, { ts: at("10:05"), ok: true, value: 210 }]));
  assert.deepEqual(sparse.runs, []);
});

test("buildStarfieldSvg: 无检测标注、两条星点路径、失败成段、最慢与最近写在图上", () => {
  const afternoon = series(at("12:00", "21"), at("19:00", "21"), { value: (i) => (i === 100 ? 8330 : i % 9 === 0 ? 900 : 160), fail: (_i, ts) => ts >= at("16:00", "21") && ts < at("16:30", "21") });
  const morning = series(at("06:30"), at("11:29"), { value: () => 170 });
  const model = buildStarfieldModel(trendOf([...afternoon, ...morning]));
  const { markup, geo } = buildStarfieldSvg(model, 900, { formatMs: (v) => `${v}ms` });
  assert.match(markup, /class="sf-gap-label"[^>]*>无检测 19:00–06:30<\/text>/);
  assert.equal((markup.match(/class="sf-star"/g) || []).length, 1);
  assert.equal((markup.match(/class="sf-star is-slow"/g) || []).length, 1);
  assert.equal((markup.match(/class="sf-fail"/g) || []).length, 1, "连续 20 次失败画成一段");
  assert.match(markup, />最慢 8330ms<\/text>/);
  assert.match(markup, />最近 170ms<\/text>/);
  assert.match(markup, />100ms<\/text>/);
  assert.match(markup, />10s<\/text>/);
  assert.match(markup, />现在<\/text>/);
  assert.equal(geo.W, 900);
  assert.equal(starfieldGeometry(model, 100).W, 360, "最窄 360");
  // 纵轴对数：100ms 在图底、10s 在图顶
  assert.equal(Math.round(geo.y(100)), Math.round(geo.y(1)), "低于量程的压在图底");
  assert.ok(geo.y(10000) < geo.y(1000) && geo.y(1000) < geo.y(100));
  assert.ok(Math.abs((geo.y(100) - geo.y(1000)) - (geo.y(1000) - geo.y(10000))) < 0.01, "每十倍等高");
});

test("buildStarfieldSvg: 最近一次就是最慢时只写一处；最近一次失败写在失败一道上", () => {
  const points = series(at("11:00"), at("11:28"), { value: (i) => 150 + i });
  const slowLast = buildStarfieldSvg(buildStarfieldModel(trendOf(points)), 800, { formatMs: (v) => `${v}ms` }).markup;
  assert.match(slowLast, />最近 168ms（最慢）<\/text>/);
  assert.doesNotMatch(slowLast, />最慢 /);
  const failedLast = buildStarfieldSvg(buildStarfieldModel(trendOf([...points, { ts: at("11:29") + 30_000, ok: false, value: 5000 }])), 800).markup;
  assert.match(failedLast, /class="sf-latest is-fail"/);
  assert.match(failedLast, />最近一次失败<\/text>/);
});

test("pickStar: 失败一道上吸到最近的失败；图里取横向最近的检测；落在无检测时段里不算", () => {
  const points = [...series(at("09:00"), at("10:00"), { fail: (i) => i === 20 }), ...series(at("11:00"), at("11:28"))];
  const model = buildStarfieldModel(trendOf(points));
  const geo = starfieldGeometry(model, 900);
  const failTs = points[20].ts;
  const onLane = pickStar(model, geo, geo.x(failTs) + 6, geo.laneY + 3);
  assert.equal(onLane.ts, failTs);
  const inPlot = pickStar(model, geo, geo.x(points[5].ts) + 0.4, geo.y(200));
  assert.equal(inPlot.ts, points[5].ts);
  assert.equal(pickStar(model, geo, geo.x(at("10:30")), geo.y(200)), null, "10:00–11:00 没有检测");
  assert.equal(pickStar(model, geo, geo.x(at("05:00")), geo.laneY + 3), null);
});

test("starTip: 成功给耗时，失败给等了多久", () => {
  const fmt = (v) => `${v}ms`;
  assert.deepEqual(starTip({ ts: at("11:22"), ok: true, value: 277 }, "请求往返", fmt), { title: "10.22 11:22:00", rows: [{ label: "请求往返", value: "277ms" }] });
  assert.deepEqual(starTip({ ts: at("09:05"), ok: false, value: 5020 }, "请求往返", fmt).rows, [{ tone: "fail", label: "检测失败", value: "等了 5020ms" }]);
  assert.equal(starTip({ ts: at("09:05"), ok: false, value: null }, "请求往返", fmt).rows[0].value, "");
});
