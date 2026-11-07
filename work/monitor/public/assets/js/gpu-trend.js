// gpu-trend.js —— GPU 卡的「近 24 小时利用率」小走势：数据是 /api/metrics 资源样本里的 gpuUtil
// （本机各卡，按卡序）与 nodeGpuUtil（直连节点各卡，{ 节点名: [...] }，v2.53 起）——每次 slow 采集一份，后端只留 24 小时。按服务器缓存，首次整段取、之后只增量取新样本，
// 60 秒内不重复拉。数据到货后递增版本号并通知订阅者（load-panel 据此补渲一帧，同 charts.js 的做法）。
import { getMetrics } from "./api.js";

export const GPU_TREND_SPAN_MS = 24 * 60 * 60 * 1000;
export const GPU_TREND_REFRESH_MS = 60_000;
const BUCKET_MS = 5 * 60_000; // 5 分钟一档，取档内最高（短暂的满载不被平均掉）
const GAP_MS = 15 * 60_000; // 两档之间超过这么久没数据：断开不连线（采集中断 / 应用没开）

const state = new Map(); // serverId -> { samples: [{ ts, util: number[] | null, nodes: { [节点]: number[] } | null }], fetchedAt, inFlight }
const listeners = new Set();
let revision = 0;

export function gpuTrendRevision() {
  return revision;
}

export function onGpuTrendChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// 新拉到的样本并进缓存（按 ts 去重、排序、只留窗口内）。纯函数，便于测试。
export function mergeGpuSamples(existing, incoming, cutoff) {
  const byTs = new Map((existing || []).map((s) => [s.ts, s]));
  for (const s of incoming || []) {
    if (!s || !Number.isFinite(s.ts)) continue;
    const util = Array.isArray(s.gpuUtil) ? s.gpuUtil : null;
    const nodes = s.nodeGpuUtil && typeof s.nodeGpuUtil === "object" && !Array.isArray(s.nodeGpuUtil) ? s.nodeGpuUtil : null;
    if (!util && !nodes) continue;
    byTs.set(s.ts, { ts: s.ts, util, nodes });
  }
  return [...byTs.values()].filter((s) => s.ts >= cutoff).sort((a, b) => a.ts - b.ts);
}

// 需要时拉一次（首次整段 / 之后从最新一条之后增量）；失败保留已有的，下一轮再试。
export function ensureGpuTrend(serverId, { now = Date.now(), fetchMetrics = getMetrics } = {}) {
  if (!serverId) return;
  const entry = state.get(serverId) || { samples: [], fetchedAt: 0, inFlight: false };
  state.set(serverId, entry);
  if (entry.inFlight || now - entry.fetchedAt < GPU_TREND_REFRESH_MS) return;
  entry.inFlight = true;
  entry.fetchedAt = now;
  const cutoff = now - GPU_TREND_SPAN_MS;
  const latest = entry.samples.at(-1)?.ts;
  const since = latest != null && latest >= cutoff ? latest + 1 : cutoff;
  Promise.resolve()
    .then(() => fetchMetrics({ serverId, since }))
    .then((data) => {
      const beforeLen = entry.samples.length;
      const beforeLast = entry.samples.at(-1)?.ts;
      entry.samples = mergeGpuSamples(entry.samples, data?.samples, cutoff);
      if (entry.samples.length !== beforeLen || entry.samples.at(-1)?.ts !== beforeLast) {
        revision += 1;
        for (const fn of listeners) {
          try { fn(); } catch {}
        }
      }
    })
    .catch(() => {})
    .finally(() => { entry.inFlight = false; });
}

// 某张卡的 5 分钟一档序列：[{ ts（档起点）, v（档内最高 %）}]，按时间升序。纯函数。
// node：直连节点名（取 nodes[node]）；缺省 / 空串 = 本机（取 util）。
export function gpuCardSeries(samples, index, node = "") {
  const buckets = new Map();
  for (const s of samples || []) {
    const list = node ? s.nodes?.[node] : s.util;
    const v = Array.isArray(list) ? list[index] : null;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const key = Math.floor(s.ts / BUCKET_MS) * BUCKET_MS;
    buckets.set(key, Math.max(buckets.get(key) ?? 0, v));
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([ts, v]) => ({ ts, v }));
}

export function gpuSeriesFor(serverId, index, node = "") {
  return gpuCardSeries(state.get(serverId)?.samples, index, node);
}

// 小走势 SVG：横轴固定近 24 小时（start → end），纵轴 0–100%；断档处另起一段。
// 拉伸到卡片宽度，线宽用 non-scaling-stroke 不变形。少于 2 个点不画（返回空串）。
export function gpuSparkSvg(series, { start, end, w = 240, h = 20 } = {}) {
  const points = (series || []).filter((p) => p.ts >= start && p.ts <= end);
  if (points.length < 2 || !(end > start)) return "";
  const x = (ts) => (((ts - start) / (end - start)) * w).toFixed(1);
  const y = (v) => (h - 1 - (Math.min(100, Math.max(0, v)) / 100) * (h - 2)).toFixed(1);
  const segments = [];
  let current = [];
  for (const p of points) {
    if (current.length && p.ts - current.at(-1).ts > GAP_MS) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) segments.push(current);
  const line = segments.filter((seg) => seg.length > 1).map((seg) => `M${seg.map((p) => `${x(p.ts)} ${y(p.v)}`).join("L")}`).join("");
  const area = segments.filter((seg) => seg.length > 1)
    .map((seg) => `M${x(seg[0].ts)} ${h}L${seg.map((p) => `${x(p.ts)} ${y(p.v)}`).join("L")}L${x(seg.at(-1).ts)} ${h}Z`).join("");
  if (!line) return "";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path class="res-gpu-trend-area" d="${area}"/><path class="res-gpu-trend-line" d="${line}"/></svg>`;
}

// 检测 GPU 卡是否处于「0% 利用率但持续占用高显存」（如 PyTorch 进程挂起或忘记退出交互式会话）：
// 判据：当前 util === 0，显存占用 ≥ 25% 或 ≥ 4096 MB，且近 windowMs（默认 30 分钟）内至少有 minBuckets 个
// 5 分钟采样桶、所有桶的最大利用率全为 0%。纯函数。
export function isGpuIdleHoldingMemory(card, series, { now = Date.now(), windowMs = 30 * 60_000, minBuckets = 3 } = {}) {
  if (!card || typeof card !== "object") return false;
  if (card.util !== 0) return false;
  const memPct = Number(card.memPct);
  const memUsedMb = Number(card.memUsedMb);
  const holdingMem = (Number.isFinite(memPct) && memPct >= 25) || (Number.isFinite(memUsedMb) && memUsedMb >= 4096);
  if (!holdingMem) return false;
  const recent = (Array.isArray(series) ? series : []).filter((p) => p && Number.isFinite(p.ts) && p.ts >= now - windowMs && p.ts <= now);
  if (recent.length < minBuckets) return false;
  return recent.every((p) => p.v === 0);
}

