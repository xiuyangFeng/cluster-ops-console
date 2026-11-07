// line-chart.js 的纯函数部分：取整上限、刻度、路径、最近点、SVG 内容。
import assert from "node:assert/strict";
import test from "node:test";

import { buildChartSvg, hourTicks, linearTicks, linePath, monotonePath, monotoneSegments, nearestIndex, niceCeil } from "./line-chart.js";

test("niceCeil: 向上取整到 1 / 2 / 2.5 / 5 / 10 × 10^n；非正数与非法值给 1", () => {
  const cases = [[1, 1], [1.01, 2], [2, 2], [2.2, 2.5], [2.6, 5], [5.1, 10], [10, 10], [1234, 2000], [2400, 2500], [197e6, 2e8], [0.07, 0.1], [0.3, 0.5], [0.25, 0.25], [0.2, 0.2]];
  for (const [input, expected] of cases) assert.equal(niceCeil(input), expected, `niceCeil(${input})`);
  for (const bad of [0, -3, Number.NaN, undefined, null, "x", Number.POSITIVE_INFINITY]) assert.equal(niceCeil(bad), 1, `niceCeil(${bad})`);
});

test("linearTicks: 含两端的均分刻度，不带浮点尾巴", () => {
  assert.deepEqual(linearTicks(2000), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(linearTicks(1, 2), [0, 0.5, 1]);
  assert.deepEqual(linearTicks(0.3, 3), [0, 0.1, 0.2, 0.3]);
  assert.deepEqual(linearTicks(5, 0), [0, 5], "段数至少为 1");
});

test("linePath / monotonePath: 起点 M，其后逐点 L 或三次贝塞尔；空与单点不出错", () => {
  assert.equal(linePath([[0, 10], [5.25, 0], [10, 3]]), "M0.0,10.0L5.3,0.0L10.0,3.0");
  assert.equal(linePath([]), "");
  assert.equal(monotonePath([]), "");
  assert.equal(monotonePath([[4, 2]]), "M4.0,2.0");
  const pts = [[0, 50], [10, 20], [20, 20], [30, 40]];
  assert.equal(monotonePath(pts), `M0.0,50.0${monotoneSegments(pts).join("")}`);
  assert.equal(monotoneSegments(pts).length, 3);
  assert.deepEqual(monotoneSegments([[1, 1]]), []);
});

test("monotoneSegments: 曲线不越过相邻两点的取值范围（0 值不会画到基线以下）", () => {
  // SVG 坐标：y 越大越靠下。一段平的 0（y=100）后面跟一个尖峰，再回到 0。
  const pts = [[0, 100], [10, 100], [20, 100], [30, 12], [40, 100], [50, 100], [60, 55], [70, 80]];
  const segments = monotoneSegments(pts);
  segments.forEach((seg, i) => {
    const [c1, c2, end] = seg.slice(1).split(" ").map((pair) => pair.split(",").map(Number));
    const lo = Math.min(pts[i][1], pts[i + 1][1]) - 0.051;
    const hi = Math.max(pts[i][1], pts[i + 1][1]) + 0.051;
    for (const [, y] of [c1, c2, end]) assert.ok(y >= lo && y <= hi, `第 ${i} 段控制点 ${y} 越出 [${lo}, ${hi}]`);
    assert.deepEqual(end, [pts[i + 1][0], pts[i + 1][1]]);
  });
  // 横坐标相同的两点不产生 NaN
  assert.doesNotMatch(monotoneSegments([[0, 1], [0, 5], [3, 2]]).join(""), /NaN/);
});

test("nearestIndex: 二分找最近点，并列取靠前，越界夹到两端，空数组 -1", () => {
  const xs = [10, 20, 30, 45];
  assert.equal(nearestIndex([], 5), -1);
  assert.equal(nearestIndex(undefined, 5), -1);
  assert.equal(nearestIndex(xs, 20), 1);
  assert.equal(nearestIndex(xs, 24), 1);
  assert.equal(nearestIndex(xs, 26), 2);
  assert.equal(nearestIndex(xs, 25), 1, "正中间取靠前的");
  assert.equal(nearestIndex(xs, -100), 0);
  assert.equal(nearestIndex(xs, 999), 3);
  assert.equal(nearestIndex([7], 3), 0);
});

test("hourTicks: 按北京时间的整点，每 N 小时一格，0 点单独标出；与本机时区无关", () => {
  const t0 = Date.parse("2026-10-02T18:30:00+08:00");
  const t1 = Date.parse("2026-10-03T18:30:00+08:00");
  assert.deepEqual(hourTicks(t0, t1, 6).map((tick) => [tick.label, tick.strong, tick.t - t0]), [
    ["0 点", true, 5.5 * 3600e3],
    ["06:00", false, 11.5 * 3600e3],
    ["12:00", false, 17.5 * 3600e3],
    ["18:00", false, 23.5 * 3600e3],
  ]);
  assert.deepEqual(hourTicks(t0, t1, 4).map((tick) => tick.label), ["20:00", "0 点", "04:00", "08:00", "12:00", "16:00"]);
  // 窗口起点恰好在整点上：起点本身也是一格
  const midnight = Date.parse("2026-10-03T00:00:00+08:00");
  assert.deepEqual(hourTicks(midnight, midnight + 23.4 * 3600e3, 6).map((tick) => tick.label), ["0 点", "06:00", "12:00", "18:00"]);
  // 别的时区口径（UTC）
  assert.deepEqual(hourTicks(midnight, midnight + 12 * 3600e3, 6, 0).map((tick) => tick.label), ["18:00", "0 点"]);
  assert.deepEqual(hourTicks(t1, t0, 6), []);
});

const baseOptions = (extra = {}) => ({
  height: 100,
  pad: { l: 40, r: 10, t: 10, b: 20 },
  x: [0, 10],
  yMax: 100,
  yTicks: [0, 50, 100],
  yFormat: (v) => `${v}ms`,
  xTicks: [],
  series: [],
  ...extra,
});
const count = (text, needle) => text.split(needle).length - 1;

test("buildChartSvg: 网格与刻度——基线单独标出，刻度文字转义，范围外的横轴刻度不画，加粗刻度带竖线", () => {
  const { markup, ctx } = buildChartSvg(baseOptions({
    yFormat: (v) => (v === 50 ? "<b>50</b>" : String(v)),
    xTicks: [{ t: 0, label: "20:00" }, { t: 5, label: '0 点"><x', strong: true }, { t: 10, label: "现在", anchor: "end" }, { t: 11, label: "界外" }],
  }), 350);
  assert.deepEqual([ctx.W, ctx.H, ctx.x(0), ctx.x(10), ctx.y(0), ctx.y(100)], [350, 100, 40, 340, 80, 10]);
  assert.equal(count(markup, 'class="lc-grid'), 3);
  assert.equal(count(markup, 'class="lc-grid is-base"'), 1);
  assert.match(markup, /&lt;b&gt;50&lt;\/b&gt;/);
  assert.match(markup, /class="lc-axis is-strong" x="190.0" y="94" text-anchor="middle">0 点&quot;&gt;&lt;x</);
  assert.equal(count(markup, 'class="lc-rule"'), 1);
  assert.match(markup, /text-anchor="end">现在</);
  assert.doesNotMatch(markup, /界外/);
  assert.doesNotMatch(markup, /lc-hit/, "没有 hover 配置就不放命中区");
});

test("buildChartSvg: 系列——面积 + 实线 + 进行中的虚线尾巴 + 末点；超上限的值压在上沿", () => {
  const { markup, ctx } = buildChartSvg(baseOptions({
    series: [{ tone: "claude", points: [[0, 0], [5, 250], [10, 50]], dashFrom: 1 }],
    hover: { xs: [0, 5, 10], onPick: () => {} },
  }), 350);
  assert.equal(ctx.y(250), 10, "250 超过 yMax=100，画在上沿");
  assert.match(markup, /<path class="lc-area" data-tone="claude" d="M40\.0,80\.0L190\.0,10\.0L340\.0,45\.0L340\.0,80\.0L40\.0,80\.0Z"\/>/);
  assert.match(markup, /<path class="lc-line" data-tone="claude" d="M40\.0,80\.0L190\.0,10\.0"\/>/);
  assert.match(markup, /<path class="lc-line is-partial" data-tone="claude" d="M190\.0,10\.0L340\.0,45\.0"\/>/);
  assert.match(markup, /<circle class="lc-end" data-tone="claude" cx="340\.0" cy="45\.0" r="3\.5"\/>/);
  assert.match(markup, /<rect class="lc-hit is-pickable" x="40" y="0" width="300" height="100"\/>/);
});

test("buildChartSvg: 平滑、细线、关掉面积与末点、单点、色调转义、追加片段、最小宽度", () => {
  const smooth = buildChartSvg(baseOptions({ series: [{ points: [[0, 10], [5, 60], [10, 20]], smooth: true, thin: true, area: false, endDot: false }] }), 350).markup;
  assert.match(smooth, /<path class="lc-line is-thin" d="M40\.0,73\.0C/);
  assert.doesNotMatch(smooth, /lc-area|lc-end/);
  const single = buildChartSvg(baseOptions({ series: [{ tone: 'a"b', points: [[5, 50]] }, { points: [] }] }), 350).markup;
  assert.equal(count(single, "<path"), 0);
  assert.match(single, /<circle class="lc-end" data-tone="a&quot;b" cx="190\.0" cy="45\.0" r="4"\/>/);
  const extra = buildChartSvg(baseOptions({ extra: ({ W, pad }) => `<rect class="rail" width="${W - pad.l - pad.r}"/>` }), 120);
  assert.equal(extra.ctx.W, 240, "容器太窄时按最小宽度画");
  assert.match(extra.markup, /<rect class="rail" width="190"\/>/);
  // 横轴范围退化成一个点时不除以 0
  assert.equal(buildChartSvg(baseOptions({ x: [3, 3] }), 350).ctx.x(3), 190);
});
