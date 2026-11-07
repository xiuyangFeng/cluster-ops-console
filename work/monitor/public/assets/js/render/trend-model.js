// render/trend-model.js —— 资源趋势（三条 sparkline）的纯模型：范围定义、序列的合并与分桶、量程、
// 按时间铺开的折线（断档处断开）、悬停时刻。无 DOM，Node 可直接测；状态、取数与绘制在 charts.js。
// 序列一律是 { values: number[], ts: number[] }（两个数组等长、按 ts 升序），与 charts.seriesFromMetrics 同形。
import { clockOf, dayKeyOf, monthDay } from "./usage-model.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// stepMs：画线用的分桶宽度（0 = 逐条原始采样）；api：/api/metrics/range 的 range 参数
//（null = 用 /api/metrics 的 24 小时环形缓冲，在前端分桶）。
export const TREND_RANGES = Object.freeze([
  Object.freeze({ key: "m30", label: "30 分钟", full: "最近 30 分钟", spanMs: 30 * MINUTE_MS, stepMs: 0, stepText: "", api: null }),
  Object.freeze({ key: "h24", label: "24 小时", full: "最近 24 小时", spanMs: DAY_MS, stepMs: 5 * MINUTE_MS, stepText: "5 分钟均值", api: null }),
  Object.freeze({ key: "d7", label: "7 天", full: "最近 7 天", spanMs: 7 * DAY_MS, stepMs: HOUR_MS, stepText: "1 小时均值", api: "7d" }),
  Object.freeze({ key: "d30", label: "30 天", full: "最近 30 天", spanMs: 30 * DAY_MS, stepMs: 3 * HOUR_MS, stepText: "3 小时均值", api: "30d" }),
]);
export const DEFAULT_TREND_RANGE = "h24";

// 认不出的 key（含 localStorage 里的脏值）回落默认档。
export function trendRangeOf(key) {
  return TREND_RANGES.find((range) => range.key === key) || TREND_RANGES.find((range) => range.key === DEFAULT_TREND_RANGE);
}

export function emptySeries() {
  return { values: [], ts: [] };
}

// 只留 ts >= since 的那一段（不改入参）。
export function sliceSince(series, since) {
  const ts = series?.ts || [];
  let from = 0;
  while (from < ts.length && ts[from] < since) from += 1;
  return from === 0 ? { values: series?.values || [], ts } : { values: series.values.slice(from), ts: ts.slice(from) };
}

// 就地插入一个点并保持 ts 升序（实时追加几乎总是落在末尾）。
export function insertPoint(series, ts, value) {
  let at = series.ts.length;
  while (at > 0 && series.ts[at - 1] > ts) at -= 1;
  series.ts.splice(at, 0, ts);
  series.values.splice(at, 0, value);
}

// 把一段后端样本并进已有序列：incoming 覆盖的时段（两端各放宽 slackMs）以它为准，时段之外保留 base。
// 同一次采样在实时通路里的时刻是探针的 checkedAt、在后端样本里是入库时刻，差几百毫秒——
// 放宽一点才不会把同一个读数留两份。
export function mergeSeries(base, incoming, slackMs = 5000) {
  if (!incoming?.ts?.length) return base;
  if (!base?.ts?.length) return { values: [...incoming.values], ts: [...incoming.ts] };
  const from = incoming.ts[0] - slackMs;
  const to = incoming.ts[incoming.ts.length - 1] + slackMs;
  const out = emptySeries();
  let placed = false;
  const place = () => {
    out.ts.push(...incoming.ts);
    out.values.push(...incoming.values);
    placed = true;
  };
  for (let i = 0; i < base.ts.length; i += 1) {
    const t = base.ts[i];
    if (t >= from && t <= to) continue;
    if (!placed && t > to) place();
    out.ts.push(t);
    out.values.push(base.values[i]);
  }
  if (!placed) place();
  return out;
}

// 按 stepMs 对齐分桶取均值；点的时刻取桶的起点。没有样本的桶不出现。
export function bucketMeans(series, stepMs) {
  const out = emptySeries();
  const ts = series?.ts || [];
  let bucket = null;
  let sum = 0;
  let count = 0;
  const flush = () => {
    if (!count) return;
    out.ts.push(bucket);
    out.values.push(sum / count);
  };
  for (let i = 0; i < ts.length; i += 1) {
    const start = Math.floor(ts[i] / stepMs) * stepMs;
    if (start !== bucket) {
      flush();
      bucket = start;
      sum = 0;
      count = 0;
    }
    sum += series.values[i];
    count += 1;
  }
  flush();
  return out;
}

// 最小 / 最大值；空数组返回 null。
export function extentOf(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const value of values || []) {
    if (!Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return lo <= hi ? { lo, hi } : null;
}

// 纵轴量程。下限按范围内最低值留 5 个点的余量后向下取整到 10——磁盘常年 85% 以上，从 0 画起
// 几个百分点的涨落只有一两个像素，看不出走势。上限恒 100；dynamic（CPU 回落归一化负载时可 >100）
// 出现过载点才随峰值放大。
export function trendBounds(values, { dynamic = false } = {}) {
  const extent = extentOf(values);
  if (!extent) return { min: 0, max: 100 };
  let max = 100;
  if (dynamic && extent.hi > 100) max = Math.max(110, Math.ceil(extent.hi * 1.05));
  const min = Math.min(max - 10, Math.max(0, Math.floor((extent.lo - 5) / 10) * 10));
  return { min, max };
}

const round1 = (n) => Math.round(n * 10) / 10;

// 按时间铺开的折线：x 由时刻在 [start, end] 里的位置决定，相邻两点相隔超过 gapMs 就断开
//（没有数据的时段留白，不连成一条线）。返回折线、面积两条 path 的 d，以及每个点的横向位置（0–1，悬停吸附用）。
// y 映射与 charts.buildSmoothPath 一致（上下各留 2px）。
export function buildTimePath(series, { width = 300, height = 24, min = 0, max = 100, start, end, gapMs = Infinity } = {}) {
  const ts = series?.ts || [];
  const span = Math.max(1, end - start);
  const range = Math.max(1e-9, max - min);
  const xs = ts.map((t) => Math.max(0, Math.min(1, (t - start) / span)));
  const ys = (series?.values || []).map((v) => height - ((Math.max(min, Math.min(max, v)) - min) / range) * (height - 4) - 2);
  const lines = [];
  const areas = [];
  let from = 0;
  for (let i = 1; i <= ts.length; i += 1) {
    if (i < ts.length && ts[i] - ts[i - 1] <= gapMs) continue;
    // [from, i) 是一段连续的点
    const x0 = round1(xs[from] * width);
    if (i - from === 1) {
      // 孤立的一个桶：画成一个点（圆头线帽下零长线段可见）
      lines.push(`M${x0} ${round1(ys[from])}h0.01`);
    } else {
      let d = `M${x0} ${round1(ys[from])}`;
      for (let k = from + 1; k < i; k += 1) d += ` L${round1(xs[k] * width)} ${round1(ys[k])}`;
      lines.push(d);
      areas.push(`${d} L${round1(xs[i - 1] * width)} ${height} L${x0} ${height} Z`);
    }
    from = i;
  }
  return { line: lines.join(" "), area: areas.join(" "), xs };
}

// xs 升序（0–1）；返回离 x 最近的那个点的下标。
export function nearestIndex(xs, x) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < xs.length; i += 1) {
    const dist = Math.abs(xs[i] - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

// 悬停气泡里的时刻（北京时间）：当天只写「时:分」，跨天或长范围带上「月.日」。
export function formatTrendTime(ts, nowMs = Date.now(), withDate = false) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  const sec = Math.floor(n / 1000);
  const day = dayKeyOf(sec);
  const clock = clockOf(sec);
  return withDate || day !== dayKeyOf(Math.floor(nowMs / 1000)) ? `${monthDay(day)} ${clock}` : clock;
}
