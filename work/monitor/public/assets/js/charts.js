// charts.js —— 资源面板三条 sparkline（CPU / 内存 / 磁盘）。
// 范围可切：30 分钟 / 24 小时 / 7 天 / 30 天（默认 24 小时，选择记在 localStorage）。
//   · 30 分钟、24 小时：从 /api/metrics 的 24 小时环形缓冲播种（页面刷新后曲线不丢），之后由渲染循环
//     逐条追加；24 小时档按 5 分钟均值画。
//   · 7 天、30 天：/api/metrics/range 的服务端降采样（按小时 / 3 小时均值），10 分钟内不重拉。
// CPU 曲线与 tile 大字同一口径：cpuBusyPct → loadNormalizedPct（见 resources-model.pickCpuMetric）。
// 范围、分桶、量程、按时间铺开的路径等纯逻辑在 render/trend-model.js；这里管状态、取数与 DOM。
// SVG 三次贝塞尔平滑逻辑从 app.js 迁移而来。

import { getMetrics, getMetricsRange } from "./api.js";
import { metricSampleValues } from "./render/resources-model.js";
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
  trendBounds,
  trendRangeOf,
} from "./render/trend-model.js";
import { finite, RESOURCE_THRESHOLDS } from "./thresholds.js";

const LIVE_SPAN_MS = 24 * 60 * 60 * 1000; // 实时序列保留的时长（= /api/metrics 环形缓冲的长度）
const LIVE_MAX_POINTS = 2000; // 兜底上限（正常每分钟一条，24 小时约 1440 条）
const MAX_POINTS = 60; // 30 分钟档 path 最多 60 个点
const BACKFILL_GAP_MS = 150_000; // 新样本离上一条超过 2.5 个采样周期：中间有缺口（窗口被隐藏 / SSE 断过），去补
const SEED_RETRY_MS = 60_000; // 播种失败后至少隔这么久再试
const RANGE_TTL_MS = 10 * 60 * 1000; // 7 天 / 30 天的降采样结果：这么久之内不重拉
const RANGE_RETRY_MS = 2 * 60 * 1000; // 取不到（旧后端没有这个接口等）时的重试间隔
const RANGE_CACHE_MAX = 16;
const RANGE_STORAGE_KEY = "resTrendRange";

// 由数值数组生成平滑折线与填充面积路径。纯函数，便于测试。
// v2.15：可选 max 参数支持超 100 的量程（归一化负载 >100% 的过载段），默认 100 保持旧语义。
// min 是纵轴下限（默认 0）：量程收窄到 [min, max] 后，高位指标的小幅涨落才看得出来。
export function buildSmoothPath(values, width = 300, height = 24, max = 100, min = 0) {
  const top = Number.isFinite(Number(max)) && Number(max) > 0 ? Number(max) : 100;
  const floor = Number.isFinite(Number(min)) && Number(min) >= 0 && Number(min) < top ? Number(min) : 0;
  const data = (Array.isArray(values) ? values : []).map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(floor, Math.min(top, n)) : floor;
  });
  if (data.length < 2) return { line: "", area: "" };

  const dx = width / (data.length - 1);
  const points = data.map((val, idx) => ({
    x: idx * dx,
    y: height - ((val - floor) / (top - floor)) * (height - 4) - 2,
  }));

  let line = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpX = p0.x + (p1.x - p0.x) / 2;
    line += ` C ${cpX} ${p0.y}, ${cpX} ${p1.y}, ${p1.x} ${p1.y}`;
  }
  const area = `${line} L ${points[points.length - 1].x} ${height} L ${points[0].x} ${height} Z`;
  return { line, area };
}

// ---- 数据状态（惰性访问，import 时不触碰 document / localStorage）----

const TREND_TYPES = ["cpu", "ram", "disk"];

// 实时序列：当前查看的那台服务器近 24 小时的逐条采样（{ values, ts }，ts 升序）。播种用后端样本的 ts，
// pushSample 从 dedupeKey（探针 checkedAt）推断。30 分钟 / 24 小时两档都从这里取。
const live = { cpu: emptySeries(), ram: emptySeries(), disk: emptySeries() };
let liveServerId = null; // 实时序列属于哪台服务器（seedFromMetrics / claimTrendServer 认领，resetCharts 清空）
let liveSeeded = false; // 历史已到货：范围内高低值这时才可信
let liveLoading = false;
let liveAttemptAt = 0;
// 播种请求在途时追加进来的实时点：到货后以后端样本为准整体替换，再把这些点并回去。
let seedPending = null;

// 7 天 / 30 天的降采样结果：`${serverId}|${range}` → { at, series: { cpu, ram, disk }, extents }。
const rangeCache = new Map();
const rangeInflight = new Set();
const rangeFailedAt = new Map();

// 当前范围（惰性读取存储；脏值回落默认档）。
let rangeKey = null;

function readStoredRange() {
  try {
    if (typeof localStorage !== "undefined") return trendRangeOf(localStorage.getItem(RANGE_STORAGE_KEY)).key;
  } catch {
    // 存储不可用（隐私模式等）：用默认档，不持久化。
  }
  return DEFAULT_TREND_RANGE;
}

function currentRange() {
  if (rangeKey == null) rangeKey = readStoredRange();
  return trendRangeOf(rangeKey);
}

// 趋势数据变了（切范围 / 历史到货）要通知面板重画明细行里的高低值与磁盘走势。revision 进面板的渲染签名。
const listeners = new Set();
let revision = 0;

export function onTrendChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function trendRevision() {
  return revision;
}

function notifyTrendChange() {
  revision += 1;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // 监听方出错不影响图表自身。
    }
  }
}

function clearLive() {
  for (const type of TREND_TYPES) live[type] = emptySeries();
  seedPending = null;
}

function cachedRange(api) {
  return liveServerId ? rangeCache.get(`${liveServerId}|${api}`) || null : null;
}

// 画线用的序列：长范围直接用后端的分桶均值；24 小时在前端按 5 分钟分桶；30 分钟是逐条采样（最多 60 点）。
function seriesFor(type, range, now) {
  if (range.api) return cachedRange(range.api)?.series[type] || emptySeries();
  const raw = sliceSince(live[type], now - range.spanMs);
  if (range.stepMs) return bucketMeans(raw, range.stepMs);
  const idx = downsampleIndexes(raw.values.length, MAX_POINTS);
  return { values: idx.map((i) => raw.values[i]), ts: idx.map((i) => raw.ts[i]) };
}

// 实时序列够不够覆盖这个范围：播种成功即可；播种失败时要靠实时点自己攒够八成时长。
function liveCovers(range, now) {
  if (liveSeeded) return true;
  const first = Math.min(...TREND_TYPES.map((type) => live[type].ts[0] ?? Infinity));
  return first <= now - range.spanMs * 0.8;
}

// 给面板模型的趋势摘要（resources-model.withTrendNotes 的入参）：当前范围的名字、三项在范围内的
// 最低 / 最高值（还没取到 = null）、近 7 天的磁盘序列（磁盘走势一句话恒按 7 天算）。
// 30 分钟 / 24 小时的高低值取逐条采样；7 天 / 30 天取后端给的逐条极值（均值曲线会把尖峰抹平）。
export function getTrendSummary(now = Date.now()) {
  const range = currentRange();
  const extents = { cpu: null, ram: null, disk: null };
  if (range.api) {
    const cached = cachedRange(range.api);
    if (cached) Object.assign(extents, cached.extents);
  } else if (liveCovers(range, now)) {
    for (const type of TREND_TYPES) extents[type] = extentOf(sliceSince(live[type], now - range.spanMs).values);
  }
  return { rangeKey: range.key, label: range.label, extents, diskWeek: cachedRange("7d")?.series.disk || null };
}

// ---- DOM 绑定层 ----

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_H = 24;

// 阈值线 = 该指标的「严重」分档线（thresholds.js 单一事实源，与 tile 配色同一口径），
// 线以上铺一层极淡的红带。CPU 在利用率缺失、回落归一化负载时可能 >100（过载），
// 量程随峰值放大；其余两项上限恒 100。
const TREND_META = {
  cpu: { threshold: RESOURCE_THRESHOLDS.cpu.critical, dynamic: true, name: " CPU", aria: " CPU 趋势" },
  ram: { threshold: RESOURCE_THRESHOLDS.memory.critical, name: "内存", aria: "内存占用趋势" },
  disk: { threshold: RESOURCE_THRESHOLDS.disk.critical, name: "磁盘", aria: "磁盘占用趋势" },
};

// 最近一次绘制快照（画出来的值 / 时间戳 / 横向位置），hover 层据此吸附与取数。
const lastDrawn = { cpu: null, ram: null, disk: null };

// 均匀降采样到 maxPoints 个点（始终保留首尾），返回索引：值数组与时间戳数组按同一批点对齐。
// 纯函数，便于测试。
export function downsampleIndexes(length, maxPoints = MAX_POINTS) {
  if (length <= maxPoints) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_, i) => Math.round(i * step));
}

// buildSmoothPath / buildTimePath 同款 y 映射（阈值线/带与曲线必须共用一套坐标）。
function yFor(value, max, min) {
  return CHART_H - ((value - min) / (max - min)) * (CHART_H - 4) - 2;
}

// 在 SVG 内确保阈值带 rect + 阈值线 line 存在（插在面积路径之前，曲线盖在上层）。
function ensureThresholdEls(svgEl, type, beforeEl) {
  let band = svgEl.querySelector(`#${type}TrendBand`);
  let line = svgEl.querySelector(`#${type}TrendThreshold`);
  if (!band) {
    band = document.createElementNS(SVG_NS, "rect");
    band.setAttribute("id", `${type}TrendBand`);
    band.setAttribute("class", "trend-threshold-band");
    svgEl.insertBefore(band, beforeEl);
  }
  if (!line) {
    line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("id", `${type}TrendThreshold`);
    line.setAttribute("class", "trend-threshold-line");
    svgEl.insertBefore(line, beforeEl);
  }
  return { band, line };
}

function hideThreshold(svgEl, type) {
  const band = svgEl.querySelector(`#${type}TrendBand`);
  const line = svgEl.querySelector(`#${type}TrendThreshold`);
  if (band) band.setAttribute("width", "0");
  if (line) line.setAttribute("x2", "0");
}

// 阈值落在量程之内：线以上铺红带 + 一条虚线。整段量程都在阈值之上（下限已经抬过了阈值）：
// 红带铺满、不画线。阈值在量程之上：都不画。
function drawThreshold(svgEl, type, width, max, min, beforeEl) {
  const meta = TREND_META[type];
  const { band, line } = ensureThresholdEls(svgEl, type, beforeEl);
  if (meta.threshold >= max) {
    hideThreshold(svgEl, type);
    return;
  }
  const inside = meta.threshold > min;
  const y = inside ? yFor(meta.threshold, max, min) : CHART_H;
  band.setAttribute("x", "0");
  band.setAttribute("y", "0");
  band.setAttribute("width", String(width));
  band.setAttribute("height", String(Math.max(0, y)));
  line.setAttribute("x1", "0");
  line.setAttribute("x2", inside ? String(width) : "0");
  line.setAttribute("y1", String(y));
  line.setAttribute("y2", String(y));
}

// 宽度来源：ResizeObserver 缓存（每次采样不再读 clientWidth 强制同步布局）。
// 所在视图 display:none 时宽度为 0 → 跳过绘制；切回该视图或窗口缩放时 RO 回调
// 带着真实宽度补画一次。此前隐藏时回落 300 画，preserveAspectRatio="none" 下切过去
// 曲线被横向拉伸，且缩放窗口后不重绘。无 RO 的环境沿用"一次读完三张再统一写"的旧路径。
const trendWidths = { cpu: 0, ram: 0, disk: 0 };
let trendObserver = null;

function ensureTrendObserver() {
  if (trendObserver || typeof ResizeObserver === "undefined") return trendObserver;
  const observer = new ResizeObserver((entries) => {
    let changed = false;
    for (const entry of entries) {
      const type = entry.target.id.replace(/TrendSvg$/, "");
      const width = Math.round(entry.contentRect.width);
      if (type in trendWidths && trendWidths[type] !== width) {
        trendWidths[type] = width;
        changed = true;
      }
    }
    if (changed) drawAllTrends();
  });
  let observed = 0;
  for (const type of TREND_TYPES) {
    const svgEl = document.getElementById(`${type}TrendSvg`);
    if (svgEl) {
      observer.observe(svgEl);
      observed += 1;
    }
  }
  if (observed) trendObserver = observer;
  return trendObserver;
}

function drawAllTrends() {
  if (typeof document === "undefined") return;
  const now = Date.now();
  if (ensureTrendObserver()) {
    // 首次 observe 后 RO 回调前宽度仍是 0：本轮跳过，回调里会带真实宽度补画。
    for (const type of TREND_TYPES) {
      if (trendWidths[type] > 0) drawTrend(type, trendWidths[type], now);
    }
    return;
  }
  const widths = {};
  for (const type of TREND_TYPES) {
    const svgEl = document.getElementById(`${type}TrendSvg`);
    widths[type] = svgEl ? svgEl.clientWidth || 300 : 300;
  }
  for (const type of TREND_TYPES) drawTrend(type, widths[type], now);
}

function setAttrIfChanged(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// 悬停提示写明范围、每个点代表什么、纵轴范围（纵轴不从 0 起，得让人知道）。
function describeTrend(type, svgEl, range, bounds) {
  if (!svgEl) return;
  const meta = TREND_META[type];
  const lead = `${range.full}${meta.name}`;
  const title = bounds
    ? `${lead}${range.stepText ? ` · 每点为 ${range.stepText}` : ""} · 纵轴 ${bounds.min}–${bounds.max}%`
    : `${lead} · 暂无数据`;
  setAttrIfChanged(svgEl.closest(".trend-chart-container"), "title", title);
  setAttrIfChanged(svgEl, "aria-label", `${range.full}${meta.aria}`);
}

function drawTrend(type, measuredWidth, now = Date.now()) {
  if (typeof document === "undefined") return;
  const svgEl = document.getElementById(`${type}TrendSvg`);
  const svgLine = document.getElementById(`${type}TrendLine`);
  const svgArea = document.getElementById(`${type}TrendArea`);
  if (!svgLine || !svgArea) return;

  const range = currentRange();
  const series = seriesFor(type, range, now);
  if (series.values.length < 2) {
    svgLine.setAttribute("d", "");
    svgArea.setAttribute("d", "");
    lastDrawn[type] = null;
    // 清掉上一台服务器 / 上一个范围残留的阈值带（首帧不该带旧红区）。
    if (svgEl) hideThreshold(svgEl, type);
    describeTrend(type, svgEl, range, null);
    return;
  }

  const width = measuredWidth ?? (svgEl ? svgEl.clientWidth || 300 : 300);
  if (svgEl) svgEl.setAttribute("viewBox", `0 0 ${width} ${CHART_H}`);

  const bounds = trendBounds(series.values, { dynamic: TREND_META[type].dynamic });
  let path;
  let xs;
  if (range.stepMs) {
    // 长范围：按时刻铺开，缺了整桶数据的地方断开。
    path = buildTimePath(series, { width, height: CHART_H, min: bounds.min, max: bounds.max, start: now - range.spanMs, end: now, gapMs: range.stepMs * 1.5 });
    xs = path.xs;
  } else {
    // 30 分钟：逐条采样均匀铺开、平滑连线（与此前一致）。
    path = buildSmoothPath(series.values, width, CHART_H, bounds.max, bounds.min);
    xs = series.values.map((_, i) => i / (series.values.length - 1));
  }
  svgLine.setAttribute("d", path.line);
  svgArea.setAttribute("d", path.area);
  if (svgEl) drawThreshold(svgEl, type, width, bounds.max, bounds.min, svgArea);
  describeTrend(type, svgEl, range, bounds);
  lastDrawn[type] = { data: series.values, dataTs: series.ts, xs, withDate: Boolean(range.api) };
  ensureHoverLayer(type, svgEl);
}

// ---- hover 十字线 + 数值气泡（纯 CSS+JS；触屏/无 hover 环境不挂监听自然降级）----

const hoverAttached = new Set();

function ensureHoverLayer(type, svgEl) {
  if (hoverAttached.has(type)) return;
  if (typeof window === "undefined" || !svgEl) return;
  const container = svgEl.closest(".trend-chart-container");
  if (!container) return;
  hoverAttached.add(type);
  // 无精确指针 hover 能力（触屏等）→ 不建 DOM、不挂监听，静默降级。
  if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;

  const cross = document.createElement("div");
  cross.className = "trend-crosshair";
  const bubble = document.createElement("div");
  bubble.className = "trend-value-bubble";
  container.append(cross, bubble);

  // perf：pointermove 是 60~120Hz。每帧最多处理一次；容器 rect 在一次悬停内缓存；
  // 气泡宽度只在文案变化时重量（读 offsetWidth 会强制同步布局）。
  let rect = null;
  let rafId = 0;
  let pendingX = 0;
  let bubbleText = "";
  let bubbleHalf = 0;

  const hide = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    rect = null;
    cross.classList.remove("visible");
    bubble.classList.remove("visible");
  };

  const update = () => {
    rafId = 0;
    const drawn = lastDrawn[type];
    if (!rect) rect = container.getBoundingClientRect();
    if (!drawn || drawn.data.length < 2 || rect.width <= 0) {
      hide();
      return;
    }
    const i = nearestIndex(drawn.xs, (pendingX - rect.left) / rect.width);
    const snapX = drawn.xs[i] * rect.width;
    const val = Math.round(Number(drawn.data[i]) || 0);
    const time = formatTrendTime(drawn.dataTs[i], Date.now(), drawn.withDate);
    // 数值在前、时间在后（tooltip 里读者要的是数）；textContent 杜绝注入面。
    const text = time ? `${val}% · ${time}` : `${val}%`;
    const remeasure = text !== bubbleText || !bubble.classList.contains("visible");
    if (text !== bubbleText) {
      bubble.textContent = text;
      bubbleText = text;
    }
    cross.style.left = `${snapX}px`;
    cross.classList.add("visible");
    bubble.classList.add("visible");
    if (remeasure) bubbleHalf = (bubble.offsetWidth || 0) / 2;
    const bx = Math.max(bubbleHalf + 2, Math.min(rect.width - bubbleHalf - 2, snapX));
    bubble.style.left = `${bx}px`;
  };

  container.addEventListener("pointermove", (ev) => {
    pendingX = ev.clientX;
    if (!rafId) rafId = requestAnimationFrame(update);
  });
  container.addEventListener("pointerleave", hide);
  container.addEventListener("pointercancel", hide);
}

// ---- 范围切换 ----

function syncRangeButtons(doc) {
  const key = currentRange().key;
  for (const btn of doc.querySelectorAll("[data-res-range]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.resRange === key));
  }
}

// 切到某个范围（m30 / h24 / d7 / d30）：记住选择、按需取长范围数据、重画、通知面板。返回是否真的变了。
export function setTrendRange(key) {
  const next = trendRangeOf(key).key;
  if (next === currentRange().key) return false;
  rangeKey = next;
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(RANGE_STORAGE_KEY, next);
  } catch {
    // 存不了就只在本次会话里生效。
  }
  if (typeof document !== "undefined") syncRangeButtons(document);
  ensureRangeData(Date.now());
  drawAllTrends();
  notifyTrendChange();
  return true;
}

// 面板头的范围分段按钮（index.html 里 [data-res-range]）：绑定点击，并把记住的选择回显到按下态。
// 顺带画一遍：还没有数据时也把趋势线的说明（title / aria-label）对齐到记住的范围，并挂上宽度观察。
export function initTrendRange({ doc = typeof document !== "undefined" ? document : null } = {}) {
  if (!doc) return;
  for (const btn of doc.querySelectorAll("[data-res-range]")) {
    btn.addEventListener("click", () => setTrendRange(btn.dataset.resRange));
  }
  syncRangeButtons(doc);
  drawAllTrends();
}

// ---- 取数 ----

// /api/metrics/range 的结果 → 画线用的三条序列 + 范围内的逐条极值。纯函数，便于测试。
// 样本不带 metricSchemaVersion，metricSampleValues 按 busy → 归一化负载 → 旧 cpu 取 CPU；
// extremes 缺失（不该发生）时退回用均值序列自己的高低值。
export function parseRangePayload(payload) {
  const series = seriesFromMetrics(payload?.samples);
  const extents = {};
  for (const type of TREND_TYPES) {
    const raw = payload?.extremes?.[type];
    const lo = finite(raw?.min);
    const hi = finite(raw?.max);
    extents[type] = lo != null && hi != null ? { lo, hi } : extentOf(series[type].values);
  }
  return { series, extents };
}

// force：不看缓存新旧与失败退避，直接重取（在途的请求仍然不重复发）。
async function loadRange(serverId, api, now, force = false) {
  const cacheKey = `${serverId}|${api}`;
  if (rangeInflight.has(cacheKey)) return;
  if (!force) {
    const cached = rangeCache.get(cacheKey);
    if (cached && now - cached.at < RANGE_TTL_MS) return;
    if (now - (rangeFailedAt.get(cacheKey) ?? 0) < RANGE_RETRY_MS) return;
  }
  rangeInflight.add(cacheKey);
  try {
    const payload = await getMetricsRange({ serverId, range: api });
    rangeCache.delete(cacheKey);
    rangeCache.set(cacheKey, { at: Date.now(), ...parseRangePayload(payload) });
    rangeFailedAt.delete(cacheKey);
    while (rangeCache.size > RANGE_CACHE_MAX) rangeCache.delete(rangeCache.keys().next().value);
    if (serverId === liveServerId) {
      drawAllTrends();
      notifyTrendChange();
    }
  } catch {
    // 取不到时保持现状（已有的旧结果继续用）；RANGE_RETRY_MS 之后随下一个采样点再试。
    rangeFailedAt.set(cacheKey, Date.now());
  } finally {
    rangeInflight.delete(cacheKey);
  }
}

// 当前服务器需要的长范围数据：近 7 天恒要（磁盘走势一句话），选中 30 天时再加 30 天。
// 平时 10 分钟内不重拉；force（认领服务器的那一刻）一律取新的，旧结果在新结果到货前继续顶着。
function ensureRangeData(now, force = false) {
  if (!liveServerId) return;
  const wanted = new Set(["7d"]);
  const api = currentRange().api;
  if (api) wanted.add(api);
  for (const key of wanted) loadRange(liveServerId, key, now, force);
}

function trimLive(now) {
  const cutoff = now - LIVE_SPAN_MS - 5 * 60_000;
  for (const type of TREND_TYPES) {
    const series = live[type];
    let drop = Math.max(0, series.ts.length - LIVE_MAX_POINTS);
    while (drop < series.ts.length && series.ts[drop] < cutoff) drop += 1;
    if (drop > 0) {
      series.ts.splice(0, drop);
      series.values.splice(0, drop);
    }
  }
}

// seedSeq：A→B 快速切换时两次 /api/metrics 可能乱序返回。若不校验，界面与服务器名是 B、
// 曲线却是 A 的历史，pushSample 的 dedupeKey 无法纠正已写入的序列 —— 展示错误归属的监控数据
// 比不展示更有害。resetCharts / seedFromMetrics 都会让在飞的请求作废。
let seedSeq = 0;

// 拉取 since 之后的样本并进实时序列。replace = 播种（以后端为准整体替换，只把请求在途时
// 追加的实时点并回去）；否则是补缺口（只覆盖返回样本所在的那一段）。
async function loadLive(since, { replace }) {
  const seq = seedSeq;
  const serverId = liveServerId;
  if (!serverId) return;
  liveLoading = true;
  liveAttemptAt = Date.now();
  if (replace) seedPending = { cpu: emptySeries(), ram: emptySeries(), disk: emptySeries() };
  try {
    const { samples } = await getMetrics({ serverId, since });
    if (seq !== seedSeq) return; // 期间已切换到别的服务器，丢弃过期快照
    const fetched = seriesFromMetrics(samples);
    for (const type of TREND_TYPES) {
      live[type] = mergeSeries(replace && seedPending ? seedPending[type] : live[type], fetched[type]);
    }
    liveSeeded = true;
    trimLive(Date.now());
    drawAllTrends();
    notifyTrendChange();
  } catch {
    // 指标不可用时保持现有历史；SEED_RETRY_MS 之后随下一个采样点再试。
  } finally {
    if (seq === seedSeq) {
      liveLoading = false;
      seedPending = null;
    }
  }
}

// 采样去重门控：render() 频率（SSE status ~2s + 800ms 防抖补齐）远高于探针采样节奏，
// 用探针的 checkedAt 作为 dedupeKey，同一次探测结果只 push 一个点，
// 避免重复平点冲掉播种的历史。
let lastSampleKey = null;

// 纯判定函数，便于测试：key 未提供时不去重（兼容无 key 的调用方）。
export function isDuplicateSample(lastKey, nextKey) {
  return nextKey != null && lastKey != null && String(lastKey) === String(nextKey);
}

// 清空历史（切换服务器时调用）。不通知面板：切换后的那一帧渲染自然会带上新的趋势版本号。
export function resetCharts() {
  seedSeq += 1; // 作废在飞的播种 / 补缺口请求，避免旧服务器的曲线落到新服务器视图上
  clearLive();
  liveServerId = null;
  liveSeeded = false;
  liveLoading = false;
  liveAttemptAt = 0;
  lastSampleKey = null;
  revision += 1;
  drawAllTrends();
}

// dedupeKey 常规取值即探针 checkedAt（epoch 毫秒）；形似毫秒时间戳则用作采样时刻，
// 回落串（如 output 文本）则取当前时间——气泡时间容忍这点误差（采样距渲染 <2s）。
function stampFromKey(dedupeKey) {
  const n = Number(dedupeKey);
  if (Number.isFinite(n) && n > 1e12 && n < 1e13) return n;
  return Date.now();
}

// 追加一次实时采样并重绘。dedupeKey（通常为采样时刻 checkedAt）相同则跳过，返回是否入列。
// 各项独立：某项未知只跳过那一条曲线的点，其余照常追加。
export function pushSample({ cpu, ram, disk }, { dedupeKey } = {}) {
  if (isDuplicateSample(lastSampleKey, dedupeKey)) return false;
  if (dedupeKey != null) lastSampleKey = String(dedupeKey);
  const ts = stampFromKey(dedupeKey);
  const previousTs = Math.max(...TREND_TYPES.map((type) => live[type].ts.at(-1) ?? -Infinity));
  const values = { cpu, ram, disk };
  for (const type of TREND_TYPES) {
    // 可画的值：有限数才入列。未知（null/undefined/NaN）直接跳过该点，不用 0 冒充——
    // 一条掉到 0 的曲线读起来是"突然空闲"，比缺一个点更误导。
    const v = finite(values[type]);
    if (v == null) continue;
    insertPoint(live[type], ts, v);
    if (seedPending) insertPoint(seedPending[type], ts, v);
  }
  const now = Date.now();
  trimLive(now);
  drawAllTrends();
  if (liveServerId) {
    if (!liveLoading) {
      if (!liveSeeded) {
        if (now - liveAttemptAt >= SEED_RETRY_MS) loadLive(now - LIVE_SPAN_MS, { replace: true });
      } else if (Number.isFinite(previousTs) && ts - previousTs > BACKFILL_GAP_MS) {
        loadLive(previousTs + 1, { replace: false });
      }
    }
    ensureRangeData(now);
  }
  return true;
}

// /api/metrics 样本 → 三条曲线（按 ts 升序；未知点逐条跳过）。纯函数，便于测试。
export function seriesFromMetrics(samples) {
  const out = { cpu: { values: [], ts: [] }, ram: { values: [], ts: [] }, disk: { values: [], ts: [] } };
  const ordered = (Array.isArray(samples) ? samples : []).filter((s) => s && typeof s === "object").slice().sort((a, b) => a.ts - b.ts);
  for (const sample of ordered) {
    const values = metricSampleValues(sample);
    const ts = Number(sample.ts) || null;
    for (const type of TREND_TYPES) {
      if (values[type] == null) continue;
      out[type].values.push(values[type]);
      out[type].ts.push(ts);
    }
  }
  return out;
}

// 认领这台服务器并从 /api/metrics 播种近 24 小时的历史（用于首帧与切换服务器后）；
// 同时备好它的长范围数据（近 7 天恒要，选中 30 天时再加 30 天）。
// 这台已经在取数（claimTrendServer 先认领了）时不重复请求；换了服务器则先清掉旧序列。
export async function seedFromMetrics(serverId) {
  const owner = serverId || null;
  if (owner && owner === liveServerId && liveLoading) return;
  if (owner !== liveServerId) {
    clearLive();
    lastSampleKey = null;
  }
  seedSeq += 1;
  liveServerId = owner;
  liveSeeded = false;
  liveLoading = false;
  seedPending = null;
  const now = Date.now();
  ensureRangeData(now, true);
  await loadLive(now - LIVE_SPAN_MS, { replace: true });
}

// 面板每次渲染前报一声「现在看的是哪台」：实时序列不属于它就当场认领（清空 + 播种）。
// 正常切换走 resetCharts → seedFromMetrics；这里兜住别的路径——另一个窗口切了查看视角、
// 查看中的服务器被移除后后端换了一台——否则两台服务器的读数会混进同一条曲线。返回是否发生了认领。
export function claimTrendServer(serverId) {
  if (!serverId || serverId === liveServerId) return false;
  seedFromMetrics(serverId);
  return true;
}
