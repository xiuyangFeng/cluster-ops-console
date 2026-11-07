// 资源趋势纯模型的测试（无 DOM）。
import assert from "node:assert/strict";
import test from "node:test";

import {
  bucketMeans,
  buildTimePath,
  DEFAULT_TREND_RANGE,
  emptySeries,
  extentOf,
  formatTrendTime,
  insertPoint,
  mergeSeries,
  nearestIndex,
  sliceSince,
  TREND_RANGES,
  trendBounds,
  trendRangeOf,
} from "./trend-model.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
// 2026-10-03 18:30 北京时间
const NOW = Date.UTC(2026, 9, 3, 10, 30, 0);

const series = (points) => ({ ts: points.map((p) => p[0]), values: points.map((p) => p[1]) });

test("TREND_RANGES: 四档、默认 24 小时；长范围的步长与后端降采样一致；认不出的 key 回落默认档", () => {
  assert.deepEqual(TREND_RANGES.map((r) => [r.key, r.label, r.api]), [
    ["m30", "30 分钟", null],
    ["h24", "24 小时", null],
    ["d7", "7 天", "7d"],
    ["d30", "30 天", "30d"],
  ]);
  assert.equal(DEFAULT_TREND_RANGE, "h24");
  assert.equal(trendRangeOf("d7").stepMs, HOUR);
  assert.equal(trendRangeOf("d30").stepMs, 3 * HOUR);
  assert.equal(trendRangeOf("m30").stepMs, 0, "30 分钟逐条画");
  for (const dirty of [null, undefined, "", "1y", "__proto__", 7]) assert.equal(trendRangeOf(dirty).key, "h24");
});

test("sliceSince / insertPoint: 按时刻截取不改入参；插入保持升序", () => {
  const s = series([[10, 1], [20, 2], [30, 3]]);
  assert.deepEqual(sliceSince(s, 20), series([[20, 2], [30, 3]]));
  assert.deepEqual(sliceSince(s, 5), s);
  assert.deepEqual(sliceSince(s, 31), emptySeries());
  assert.deepEqual(sliceSince(null, 0), emptySeries());
  assert.deepEqual(s, series([[10, 1], [20, 2], [30, 3]]));
  insertPoint(s, 40, 4);
  insertPoint(s, 25, 2.5);
  insertPoint(s, 5, 0.5);
  assert.deepEqual(s, series([[5, 0.5], [10, 1], [20, 2], [25, 2.5], [30, 3], [40, 4]]));
});

test("mergeSeries: 后端样本覆盖的时段以它为准，时段之外保留已有的点；同一次采样不留两份", () => {
  const base = series([[1000, 1], [61_000, 2], [121_000, 3], [300_000, 9]]);
  // 后端给了 60s–120s 这一段：实时通路里同一次采样的时刻早几百毫秒，落在放宽的范围里被替掉
  const merged = mergeSeries(base, series([[61_300, 20], [121_400, 30]]));
  assert.deepEqual(merged, series([[1000, 1], [61_300, 20], [121_400, 30], [300_000, 9]]));
  assert.deepEqual(base.ts, [1000, 61_000, 121_000, 300_000], "不改入参");
  // 后端样本整体在已有点之后 / 之前
  assert.deepEqual(mergeSeries(series([[1000, 1]]), series([[90_000, 5]])), series([[1000, 1], [90_000, 5]]));
  assert.deepEqual(mergeSeries(series([[90_000, 5]]), series([[1000, 1]])), series([[1000, 1], [90_000, 5]]));
  // 空的一方
  assert.equal(mergeSeries(base, emptySeries()), base);
  assert.deepEqual(mergeSeries(emptySeries(), series([[1, 1]])), series([[1, 1]]));
});

test("bucketMeans: 按步长对齐分桶取均值，点的时刻是桶的起点；没有样本的桶不出现", () => {
  const step = 5 * MIN;
  const base = Math.floor(NOW / step) * step;
  const out = bucketMeans(series([
    [base + 10_000, 10], [base + MIN, 20], [base + 4 * MIN, 30],
    [base + step, 50],
    [base + 3 * step + MIN, 7],
  ]), step);
  assert.deepEqual(out, series([[base, 20], [base + step, 50], [base + 3 * step, 7]]));
  assert.deepEqual(bucketMeans(emptySeries(), step), emptySeries());
});

test("extentOf / trendBounds: 下限按最低值留余量后向下取整到 10；上限恒 100，只有过载的 CPU 才放大", () => {
  assert.deepEqual(extentOf([3, 1, 2]), { lo: 1, hi: 3 });
  assert.equal(extentOf([]), null);
  assert.equal(extentOf([Number.NaN]), null);
  // 磁盘常年 86%+：从 80 画起
  assert.deepEqual(trendBounds([86, 87, 93]), { min: 80, max: 100 });
  assert.deepEqual(trendBounds([85]), { min: 80, max: 100 });
  assert.deepEqual(trendBounds([84.9]), { min: 70, max: 100 }, "离整十不到 5 个点就再退一档");
  assert.deepEqual(trendBounds([100, 100]), { min: 90, max: 100 });
  // 低位指标仍从 0 画起
  assert.deepEqual(trendBounds([2, 26]), { min: 0, max: 100 });
  assert.deepEqual(trendBounds([14, 30]), { min: 0, max: 100 });
  assert.deepEqual(trendBounds([23, 29]), { min: 10, max: 100 });
  // 过载：只有 dynamic 的那条（CPU 回落归一化负载）放大上限
  assert.deepEqual(trendBounds([40, 130], { dynamic: true }), { min: 30, max: 137 });
  assert.deepEqual(trendBounds([40, 101], { dynamic: true }), { min: 30, max: 110 });
  assert.deepEqual(trendBounds([40, 130]), { min: 30, max: 100 });
  assert.deepEqual(trendBounds([]), { min: 0, max: 100 });
});

test("buildTimePath: 横向按时刻铺开，纵向按量程映射；缺了整桶的地方断开，孤立的桶画成一个点", () => {
  const start = 0;
  const end = 100;
  const { line, area, xs } = buildTimePath(series([[0, 0], [10, 50], [20, 100], [60, 50], [90, 0], [100, 100]]), {
    width: 200, height: 24, min: 0, max: 100, start, end, gapMs: 15,
  });
  // 三段：0–20 连着；60 孤立；90–100 连着
  assert.equal(line, "M0 22 L20 12 L40 2 M120 12h0.01 M180 22 L200 2");
  assert.equal(area, "M0 22 L20 12 L40 2 L40 24 L0 24 Z M180 22 L200 2 L200 24 L180 24 Z");
  assert.deepEqual(xs, [0, 0.1, 0.2, 0.6, 0.9, 1]);
  // 量程收窄：80–100 的轴上 90 在正中
  const narrow = buildTimePath(series([[0, 80], [100, 90]]), { width: 100, height: 24, min: 80, max: 100, start, end });
  assert.equal(narrow.line, "M0 22 L100 12");
  // 窗口之外的点贴边（最早一桶的起点常比窗口起点早一点），超出量程的值压在边上
  const clipped = buildTimePath(series([[-5, 150], [50, -20]]), { width: 100, height: 24, start, end });
  assert.equal(clipped.line, "M0 2 L50 22");
  assert.deepEqual(clipped.xs, [0, 0.5]);
  assert.deepEqual(buildTimePath(emptySeries(), { start, end }), { line: "", area: "", xs: [] });
});

test("nearestIndex: 取横向最近的点", () => {
  const xs = [0, 0.1, 0.2, 0.6, 0.9, 1];
  assert.equal(nearestIndex(xs, -1), 0);
  assert.equal(nearestIndex(xs, 0.14), 1);
  assert.equal(nearestIndex(xs, 0.45), 3);
  assert.equal(nearestIndex(xs, 2), 5);
});

test("formatTrendTime: 北京时间；当天只写时分，跨天或长范围带月.日", () => {
  assert.equal(formatTrendTime(NOW - 5 * MIN, NOW), "18:25");
  assert.equal(formatTrendTime(NOW - 20 * HOUR, NOW), "10.2 22:30", "24 小时范围里昨天的点要带日期");
  assert.equal(formatTrendTime(NOW - 5 * MIN, NOW, true), "10.3 18:25");
  assert.equal(formatTrendTime(null, NOW), "");
  assert.equal(formatTrendTime(0, NOW), "");
});
