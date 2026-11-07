// 隧道使用记录的读取与汇总（v2.62，控制面）：代理把记录写在 <runtimeDir>/proxy-usage.json
// （lib/proxy/usage.mjs，有变化时最多每分钟一次），这里只读——不碰代理进程，也不往文件里写任何东西。
//
// 汇总都是纯函数：把最近 24 小时的小时桶合并成「合计 + 按目标排名」。小时桶按整点切（UTC 整点即北京时间
// 整点），窗口是相对现在的 24 小时，没有日界，与机器时区无关。窗口最早的那个小时桶整个算进来，所以实际
// 覆盖 24–25 小时——界面写「近 24 小时」，不去按比例拆一个桶。
//
// 近一分钟（v2.65，概览「请求之路」的流量与「正在传输」）：代理有变化时最多每分钟重写一次文件，控制面把见过的
// 相邻两个版本（按 writtenAt）相减，得到这段时间的增量。只在内存里记上一版，重启后从头看。
import { readFileSync, statSync } from "node:fs";

import { parseUsageDocument, USAGE_FLUSH_INTERVAL_MS, USAGE_HOUR_MS, USAGE_MAX_BYTES, USAGE_OTHER_KEY, usageHourStart } from "../proxy/usage.mjs";

export const USAGE_WINDOW_HOURS = 24;
export const USAGE_TOP_TARGETS = 12;
export const USAGE_TOP_UNAUTHENTICATED = 5;
// 文件超过这么久没重写 = 这段时间没有变化（代理有变化才写，最多每分钟一次），近一分钟按空闲（null）。
export const USAGE_RECENT_STALE_MS = 150_000;
// 文件比代理自己的上限大出一截：不是它写的，不读。
const READ_MAX_BYTES = USAGE_MAX_BYTES * 2;

const [CONN, UP, DOWN, LAST_AT, AUTHED, MISSING, BAD, DENIED] = [0, 1, 2, 3, 4, 5, 6, 7];

// → parseUsageDocument 的结果 | null（没有文件、读不出、不认识）。
export function readProxyUsage(filePath, { readFile = readFileSync, stat = statSync } = {}) {
  if (!filePath) return null;
  try {
    if (stat(filePath).size > READ_MAX_BYTES) return null;
    return parseUsageDocument(readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

const emptyTotals = () => ({ connections: 0, up: 0, down: 0, authed: 0, missing: 0, bad: 0, denied: 0 });

// 记录 → 最近 windowHours 小时的合计与逐目标合并。
//   { since, totals, targets: [{ target, connections, up, down, lastAt, authed, missing, bad, denied }] }
//   since：算进来的最早一个小时桶的起点（没有数据时为 null）。target 为 "*" 的那一行是「其它」。
export function summarizeUsage(usage, { now = Date.now(), windowHours = USAGE_WINDOW_HOURS } = {}) {
  const from = now - windowHours * USAGE_HOUR_MS;
  const merged = new Map();
  const totals = emptyTotals();
  let since = null;
  for (const { t, targets } of usage?.hours || []) {
    if (t + USAGE_HOUR_MS <= from || t > now) continue;
    since = since === null ? t : Math.min(since, t);
    for (const [target, row] of targets) {
      const item = merged.get(target) || { target, connections: 0, up: 0, down: 0, lastAt: 0, authed: 0, missing: 0, bad: 0, denied: 0 };
      item.connections += row[CONN];
      item.up += row[UP];
      item.down += row[DOWN];
      item.lastAt = Math.max(item.lastAt, row[LAST_AT]);
      item.authed += row[AUTHED];
      item.missing += row[MISSING];
      item.bad += row[BAD];
      item.denied += row[DENIED];
      merged.set(target, item);
      totals.connections += row[CONN];
      totals.up += row[UP];
      totals.down += row[DOWN];
      totals.authed += row[AUTHED];
      totals.missing += row[MISSING];
      totals.bad += row[BAD];
      totals.denied += row[DENIED];
    }
  }
  return { since, totals, targets: [...merged.values()] };
}

const isOther = (item) => item.target === USAGE_OTHER_KEY;
const unauthenticated = (item) => item.missing + item.bad;

// 没带对口令的目标前几名（「强制之后会断的是谁」）。「其它」不是一个具体目标，排在最后单列。
export function topUnauthenticated(summary, limit = USAGE_TOP_UNAUTHENTICATED) {
  const named = summary.targets.filter((item) => !isOther(item) && unauthenticated(item) > 0)
    .sort((a, b) => unauthenticated(b) - unauthenticated(a) || b.lastAt - a.lastAt || a.target.localeCompare(b.target));
  const shown = named.slice(0, limit).map(({ target, missing, bad, denied, lastAt }) => ({ target, missing, bad, denied, lastAt }));
  const rest = [...named.slice(limit), ...summary.targets.filter((item) => isOther(item) && unauthenticated(item) > 0)];
  return { targets: shown, moreTargets: named.length - shown.length, moreRequests: rest.reduce((sum, item) => sum + unauthenticated(item), 0) };
}

// 流量最多的目标（表格用）：按上下行合计排，同量按连接数。「其它」并在末尾。
export function topByTraffic(summary, limit = USAGE_TOP_TARGETS) {
  const named = summary.targets.filter((item) => !isOther(item) && (item.connections > 0 || item.up + item.down > 0))
    .sort((a, b) => (b.up + b.down) - (a.up + a.down) || b.connections - a.connections || a.target.localeCompare(b.target));
  const pick = ({ target, connections, up, down, lastAt }) => ({ target, connections, up, down, lastAt });
  const rest = [...named.slice(limit), ...summary.targets.filter((item) => isOther(item) && (item.connections > 0 || item.up + item.down > 0))];
  const other = rest.reduce((acc, item) => ({
    targets: acc.targets + (isOther(item) ? 0 : 1),
    connections: acc.connections + item.connections,
    up: acc.up + item.up,
    down: acc.down + item.down,
    lastAt: Math.max(acc.lastAt, item.lastAt),
  }), { targets: 0, connections: 0, up: 0, down: 0, lastAt: 0 });
  return { targets: named.slice(0, limit).map(pick), other: rest.length ? other : null };
}

// 相邻两版记录 → 这段时间的增量 { fromAt, toAt, connections, up, down, targets: Map<键, { connections, up, down }> } | null。
// 逐桶、逐目标相减，只计正增量再求和——不能拿 24 小时合计相减：旧桶滑出窗口会让合计变小。
//   新出现的桶整桶算；消失的桶（滑出保留期）不管；文件回退（current 不比 previous 新）→ null。
//   只看 previous.writtenAt 所在的小时及之后的桶：更早的桶在上一版写出时已经定型，再「变多」只可能是文件超限
//   压缩（并进「其它」）前后口径不同，不是新流量。
//   fromAt 不是上一版的时刻：代理最多每分钟写一次、有变化才写，相邻两版之间的字节都落在后一版之前的一个写盘周期里
//   （空闲几分钟后的第一版也是）——按 max(上一版, 这一版 − 一个周期) 起算，速率才不被前面的空闲摊薄。
//   前提是两版真的相邻：控制面每 30 秒看一眼文件（proxy-auth-service 的 sampleUsage），不只在有人拉接口时才看。
export function diffUsage(previous, current) {
  const prevAt = previous?.writtenAt || 0;
  const toAt = current?.writtenAt || 0;
  if (!prevAt || !toAt || toAt <= prevAt) return null;
  const fromAt = Math.max(prevAt, toAt - USAGE_FLUSH_INTERVAL_MS);
  const before = new Map((previous.hours || []).map((bucket) => [bucket.t, bucket.targets]));
  const firstOpen = usageHourStart(prevAt);
  const targets = new Map();
  const totals = { connections: 0, up: 0, down: 0 };
  for (const { t, targets: rows } of current.hours || []) {
    if (t < firstOpen) continue;
    const old = before.get(t);
    for (const [key, row] of rows) {
      const prev = old?.get(key);
      const delta = {
        connections: Math.max(0, row[CONN] - (prev?.[CONN] ?? 0)),
        up: Math.max(0, row[UP] - (prev?.[UP] ?? 0)),
        down: Math.max(0, row[DOWN] - (prev?.[DOWN] ?? 0)),
      };
      if (!delta.connections && !delta.up && !delta.down) continue;
      const item = targets.get(key) || { connections: 0, up: 0, down: 0 };
      item.connections += delta.connections;
      item.up += delta.up;
      item.down += delta.down;
      targets.set(key, item);
      totals.connections += delta.connections;
      totals.up += delta.up;
      totals.down += delta.down;
    }
  }
  return { fromAt, toAt, ...totals, targets };
}

// 这个进程见过的相邻两版：{ previous, current } → 读到新一版之后的 { previous, current }。
// 同一版（writtenAt 相同）不动；更新的一版顶上来；比手上的还旧（文件被换回旧的）就从这一版重新看。
export function trackUsageVersion(seen, usage) {
  const writtenAt = usage?.writtenAt || 0;
  if (!writtenAt) return seen;
  const current = seen?.current || null;
  if (!current) return { previous: null, current: usage };
  if (writtenAt === current.writtenAt) return seen;
  if (writtenAt > current.writtenAt) return { previous: current, current: usage };
  return { previous: null, current: usage };
}

// 近一分钟的增量；只见过一版、或文件超过 USAGE_RECENT_STALE_MS 没重写（空闲）→ null。
export function recentUsage(seen, { now = Date.now(), staleMs = USAGE_RECENT_STALE_MS } = {}) {
  if (!seen?.previous || !seen.current) return null;
  if (now - seen.current.writtenAt > staleMs) return null;
  return diffUsage(seen.previous, seen.current);
}

// 流量表（topByTraffic 的结果）每行补上同一份增量：recentConnections / recentUp / recentDown（没有增量为 0）。
// 「其它」那一行取没单列出来的目标（含「其它」键）的增量之和。
export function withRecentTraffic({ targets, other }, recent) {
  const fields = (delta) => ({ recentConnections: delta?.connections ?? 0, recentUp: delta?.up ?? 0, recentDown: delta?.down ?? 0 });
  const shown = new Set(targets.map((item) => item.target));
  const rest = { connections: 0, up: 0, down: 0 };
  for (const [key, delta] of recent?.targets || []) {
    if (shown.has(key)) continue;
    rest.connections += delta.connections;
    rest.up += delta.up;
    rest.down += delta.down;
  }
  return {
    targets: targets.map((item) => ({ ...item, ...fields(recent?.targets.get(item.target)) })),
    other: other ? { ...other, ...fields(rest) } : null,
  };
}
