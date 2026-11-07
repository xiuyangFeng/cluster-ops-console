import assert from "node:assert/strict";
import { test } from "node:test";

import {
  axisLabel, calendarGrid, calendarMonths, causesText, clockOf, dateTimeOf, dayKeyOf, codesText, errorTextNote, contextTone, failureDetailText, filterSessions, formatDuration, formatUsd, heatLevel, monotoneSegments, niceScale, ratioText, sessionsCsv, tokenAxisFormatter, shortTokens, splitTokens,
} from "./usage-model.js";

test("Token 数字：量级越大保留位数越少", () => {
  assert.deepEqual(splitTokens(999), ["999", ""]);
  assert.deepEqual(splitTokens(1234), ["1.2", "K"]);
  assert.deepEqual(splitTokens(123_456), ["123", "K"]);
  assert.deepEqual(splitTokens(2_345_678), ["2.35", "M"]);
  assert.deepEqual(splitTokens(32_400_000), ["32.4", "M"]);
  assert.deepEqual(splitTokens(322_344_518), ["322", "M"]);
  assert.equal(shortTokens(6_984_930_173), "6.98B");
});

test("刻度与时长、比较文案", () => {
  // 3 段、1 / 2 / 5 × 10^n 步长，峰值上方留余量；刻度只写数字，单位统一
  assert.deepEqual(niceScale(120_000_000), { step: 50_000_000, ceiling: 150_000_000, segments: 3, unit: "M", divisor: 1e6 });
  assert.deepEqual(niceScale(44_200_000), { step: 20_000_000, ceiling: 60_000_000, segments: 3, unit: "M", divisor: 1e6 });
  assert.deepEqual(niceScale(1_480_000_000), { step: 500_000_000, ceiling: 1_500_000_000, segments: 3, unit: "B", divisor: 1e9 });
  assert.deepEqual(niceScale(0), { step: 1, ceiling: 3, segments: 3, unit: "", divisor: 1 });
  for (const max of [7, 99, 1234, 98_765, 5_000_000, 333_333_333, 2e9]) {
    const { step, ceiling } = niceScale(max);
    assert.ok(ceiling >= max && Number.isInteger(step), `niceScale(${max})`);
    assert.ok(ceiling <= max * 3.01, `niceScale(${max}) 上限不应远高于峰值：${ceiling}`);
  }
  assert.deepEqual([axisLabel(0, 1e6), axisLabel(50_000_000, 1e6), axisLabel(150_000_000, 1e6), axisLabel(500_000_000, 1e9), axisLabel(1_500_000_000, 1e9)], ["0", "50", "150", "0.5", "1.5"]);
  // 单调插值：经过每个数据点，控制点不越过相邻两点的取值范围（不会画出低于 0 的弧）
  const pts = [[0, 100], [10, 0], [20, 100], [30, 100], [40, 50]];
  const segs = monotoneSegments(pts);
  assert.equal(segs.length, 4);
  for (const [i, seg] of segs.entries()) {
    const nums = seg.slice(1).split(/[ ,]/).map(Number);
    assert.deepEqual(nums.slice(4), pts[i + 1]);
    const lo = Math.min(pts[i][1], pts[i + 1][1]);
    const hi = Math.max(pts[i][1], pts[i + 1][1]);
    assert.ok(nums[1] >= lo - 1e-9 && nums[1] <= hi + 1e-9 && nums[3] >= lo - 1e-9 && nums[3] <= hi + 1e-9, `段 ${i} 控制点越界：${seg}`);
  }
  assert.deepEqual(monotoneSegments([[0, 1]]), []);
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(386), "6m26s");
  assert.equal(formatDuration(5400), "1h30m");
  assert.equal(ratioText({ ratio: 5.31 }), "5.3×");
  assert.equal(ratioText({ ratio: 1.05 }), "+5%");
  assert.equal(ratioText({ ratio: 0.8 }), "-20%");
  assert.equal(ratioText(null), "");
  assert.equal(codesText({ 502: 4, error: 2 }), "502×4 失败×2");
  // KPI 卡的失败明细：只有笼统的「失败」一种时不重复写
  assert.equal(failureDetailText({ error: 3 }), "");
  assert.equal(failureDetailText({}), "");
  assert.equal(failureDetailText(undefined), "");
  assert.equal(failureDetailText({ 429: 3 }), "429×3");
  assert.equal(failureDetailText({ 502: 4, error: 2 }), "502×4 · 失败×2");
  assert.equal(failureDetailText({ 429: 366, error: 64, 502: 36, 400: 11 }, " · ", { limit: 2 }), "429×366 · 失败×64 · 等 4 种");
  assert.equal(codesText({ 429: 366, error: 64, 502: 36, 400: 11, 401: 2 }, " · ", { limit: 3 }), "429×366 · 失败×64 · 502×36 · 等 5 种");
  assert.deepEqual([contextTone(0.5), contextTone(0.86), contextTone(0.96), contextTone(null)], ["ok", "warn", "error", "ok"]);
  assert.deepEqual([heatLevel(0, 10), heatLevel(1, 10), heatLevel(10, 10)], [0, 1, 4]);
});

test("日历网格：周一开头、补齐整周；可选本月与上月", () => {
  const rolling = calendarGrid("rolling", "2026-10-02");
  assert.equal(rolling.first, "2026-09-03");
  assert.equal(rolling.last, "2026-10-02");
  assert.equal(rolling.dates.length % 7, 0);
  assert.equal(rolling.dates[0], "2026-08-31"); // 9.3 是周四，往前补到周一
  const sep = calendarGrid("2026-09", "2026-10-02");
  assert.deepEqual([sep.first, sep.last], ["2026-09-01", "2026-09-30"]);
  assert.deepEqual(calendarMonths("2026-01-15"), ["2026-01", "2025-12"]);
});

const session = (key, patch) => ({ key, sid: key, agent: "claude", project: "~/p", projectLabel: "p", model: "claude-opus-5-5", status: "past", last: 0, stats: { total: 0, errors: 0 }, context: null, ...patch });

test("会话：筛选、搜索与排序", () => {
  const rows = [
    session("a", { status: "recent", last: 10, stats: { total: 5, errors: 0 } }),
    session("b", { last: 30, stats: { total: 50, errors: 3 }, context: { ratio: 0.9 } }),
    session("c", { agent: "codex", model: "gpt-6.1-sol", last: 20, stats: { total: 20, errors: 1 }, context: { ratio: 0.2 } }),
  ];
  assert.deepEqual(filterSessions(rows).map((s) => s.key), ["a", "b", "c"]); // 近期活跃置顶
  assert.deepEqual(filterSessions(rows, { sort: "tokens" }).map((s) => s.key), ["b", "c", "a"]);
  assert.deepEqual(filterSessions(rows, { sort: "context" }).map((s) => s.key), ["b", "c", "a"]);
  assert.deepEqual(filterSessions(rows, { filter: "error", sort: "errors" }).map((s) => s.key), ["b", "c"]);
  assert.deepEqual(filterSessions(rows, { search: "GPT" }).map((s) => s.key), ["c"]);
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(12.345), "$12.35");
  assert.equal(formatUsd(128.6), "$129");
});

test("CSV：分列四个基础量并注明未命中输入的算法", () => {
  const csv = sessionsCsv([session("x", { first: 0, last: 60, stats: { calls: 2, errors: 0, inFresh: 1, cacheWrite: 2, cacheRead: 3, output: 4, fresh: 3, total: 10, costUsd: 0.12, savedUsd: 0.05 }, context: { tokens: 5, window: 200000, estimated: true } })]);
  const [header, row] = csv.split("\r\n");
  assert.match(header, /"普通输入","缓存写入","缓存读取","输出","未命中输入\(普通\+缓存写入\)","总 Token","等效花费\(USD\)","缓存节省\(USD\)"/);
  assert.match(row, /"1","2","3","4","3","10","0\.1200","0\.0500"/);
  assert.match(row, /"是"$/);
});

test("时刻与日期按北京时间显示，与本机时区无关", () => {
  const t = Date.UTC(2026, 9, 2, 10, 41, 5) / 1000; // 北京 18:41:05
  assert.equal(clockOf(t), "18:41");
  assert.equal(clockOf(t, { seconds: true }), "18:41:05");
  assert.equal(dayKeyOf(Date.UTC(2026, 9, 1, 16, 0) / 1000), "2026-10-02");
  assert.equal(dateTimeOf(t), "2026-10-02 18:41:05");
});

test("tokenAxisFormatter：刻度文字自带单位，单位按上限统一选", () => {
  const millions = tokenAxisFormatter(5e6);
  assert.deepEqual([0, 2.5e6, 5e6].map(millions), ["0", "2.5M", "5M"]);
  const hundreds = tokenAxisFormatter(2e8);
  assert.deepEqual([1e8, 2e8].map(hundreds), ["100M", "200M"]);
  const thousands = tokenAxisFormatter(1000);
  assert.deepEqual([500, 1000].map(thousands), ["0.5K", "1K"]);
  assert.deepEqual([1, 2].map(tokenAxisFormatter(2)), ["1", "2"]);
  assert.equal(tokenAxisFormatter(2.5e9)(1.25e9), "1.25B");
});

test("无状态码失败的归类一行：有原文的类别在前，全都没有原文时不写", () => {
  assert.equal(causesText({ unrecorded: 3, stream_stopped: 20, connection_lost: 6 }), "无状态码 29：响应中途停止×20 · 连接中途断开×6 · v2.51 前未存原文×3");
  assert.equal(causesText({ unrecorded: 30 }), "");
  assert.equal(causesText({}), "");
  assert.equal(causesText({ safeguards: 1, stream_stopped: 3, connection_lost: 2 }, { limit: 2 }), "无状态码 6：响应中途停止×3 · 连接中途断开×2 · 等 3 类");
});

test("失败调用原文说明：有原文给原文，没有就写明原因", () => {
  assert.deepEqual(errorTextNote({ errorText: "boom" }), { text: "boom", note: "已脱敏 · 单行化 · 最多 300 字" });
  assert.equal(errorTextNote({ errorText: null }).note, "该记录采集于 v2.51 之前，未保存原文");
  assert.equal(errorTextNote({}).note, "该记录采集于 v2.51 之前，未保存原文");
  assert.equal(errorTextNote({ errorText: "" }).note, "日志里这条错误没有文本");
  assert.match(errorTextNote({ errorText: null, errorDropped: true }).note, /超出本机保存上限/);
});
