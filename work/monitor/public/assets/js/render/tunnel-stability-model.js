// render/tunnel-stability-model.js —— 概览「隧道稳定性」（链路面板底部）的纯模型：把 /api/tunnel-stability
// 的统计（口径见 lib/tunnel-ledger-stats.mjs）整理成每条隧道一行与断线清单的展示数据。
// 时刻一律按北京时间显示（与用量页同一口径，见 usage-model.js）。
import { shortServerName } from "../display-names.js";
import { clockOf, dayKeyOf, TZ_OFFSET_SEC } from "./usage-model.js";

export const STABILITY_WINDOW_LABELS = Object.freeze({ "24h": "近 24 小时", "7d": "近 7 天" });

export const DROP_CAUSE_LABELS = Object.freeze({
  "keepalive-timeout": "心跳超时",
  "remote-closed": "服务器端断开",
  closed: "连接被关闭",
  reset: "连接被重置",
  "broken-pipe": "连接中断",
  "port-closed": "远端端口失联",
  "process-lost": "隧道进程消失",
  "network-change": "换网重建",
  // 不是断线：电脑合盖 / 休眠期间隧道本来就不可用（口径见 lib/tunnel-ledger-stats.mjs）。语气中性，不计入断线次数与可用率。
  sleep: "本机休眠",
  unknown: "原因未知",
});

// 「主集群服务器 (myserver)」→「主集群」：卡片标题旁已显示主机名，不再重复。
// 实现在共享件 display-names.js（事件 / 时间线 / 链路同用），这里保留导出给既有调用方。
export { shortServerName };

export function causeLabel(cause) {
  return DROP_CAUSE_LABELS[cause] || DROP_CAUSE_LABELS.unknown;
}

// 18 秒 / 3 分 20 秒 / 2 小时 5 分 / 3 天 4 小时
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

export function availabilityText(value) {
  if (!Number.isFinite(value)) return "数据不足";
  if (value >= 1) return "100%";
  // 99.995% 以上四舍五入会显示成 100.00%，与"有断开"矛盾：封顶到 99.99%。
  return `${Math.min(99.99, value * 100).toFixed(2)}%`;
}

export function availabilityTone(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 0.999) return "ok";
  if (value >= 0.99) return "warn";
  return "critical";
}

// 断线次数的语气：每天 0 次 ok，1–3 次 warn，更多 critical（7 天窗口按日均折算）。
export function dropsTone(drops, windowKey) {
  const perDay = windowKey === "7d" ? drops / 7 : drops;
  if (drops === 0) return "ok";
  return perDay <= 3 ? "warn" : "critical";
}

export function shortDateTime(ms) {
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.floor(ms / 1000);
  const day = dayKeyOf(sec);
  return `${Number(day.slice(5, 7))}.${Number(day.slice(8))} ${clockOf(sec)}`;
}

export function causesText(causes = {}) {
  return Object.entries(causes)
    .sort((a, b) => b[1] - a[1])
    .map(([cause, n]) => `${causeLabel(cause)} ×${n}`)
    .join(" · ");
}

function stateOf(entry, nowMs) {
  if (entry.state === "up") {
    return { tone: "ok", text: entry.since ? `在线 ${humanDuration(nowMs - entry.since)}` : "在线" };
  }
  if (entry.state === "down") {
    return { tone: "critical", text: entry.since ? `断开中 · ${humanDuration(nowMs - entry.since)}` : "断开中" };
  }
  // 因休眠断开、电脑醒来后还在重连：10 分钟内连上，这一段整个算休眠；连不上才转成「断开中」。
  if (entry.state === "sleep") {
    return { tone: "neutral", text: entry.since ? `唤醒后重连中 · ${humanDuration(nowMs - entry.since)}` : "唤醒后重连中" };
  }
  // 同账号另一台 Mac 在承载（v2.88）：集群照样出网，本机待命，中性色。
  if (entry.state === "standby") {
    const who = entry.standbyPeer ? `由 ${entry.standbyPeer} 承载` : "由另一台 Mac 承载";
    return { tone: "neutral", text: entry.since ? `待命 · ${who} · ${humanDuration(nowMs - entry.since)}` : `待命 · ${who}` };
  }
  return { tone: "unknown", text: "暂无记录" };
}

const HANDOVER_REASON_TEXT = {
  "holder-active": "另一台 Mac 在承载",
  "holder-unresponsive": "对方没有应答",
  yielded: "对方接管了",
  manual: "手动接管",
  unresponsive: "对方没有应答，自动接上",
};

// 承载切换记录（v2.88）：新 → 旧，只列 since 之后的。行：{ key, time, name, text, role }。
export function buildHandoverRows(stats, { since = -Infinity, limit = 8 } = {}) {
  const names = Object.fromEntries(Object.values(stats?.servers || {}).map((entry) => [entry.serverId, shortServerName(entry.name || entry.serverId)]));
  return (stats?.recentHandovers || [])
    .filter((h) => Number.isFinite(h.at) && h.at >= since)
    .slice(0, limit)
    .map((h) => {
      const peer = h.peer || "另一台 Mac";
      const text = h.role === "active" ? `接到本机（自 ${peer}）` : `本机待命（${peer} 承载）`;
      const why = HANDOVER_REASON_TEXT[h.reason] || "";
      return { key: `${h.serverId}:${h.at}:${h.role}`, time: shortDateTime(h.at), name: names[h.serverId] || h.serverId, role: h.role, text: why ? `${text} · ${why}` : text };
    });
}

// 「本机休眠 2 小时 42 分」：不足 1 分钟不提。
function sleptText(ms) {
  return Number(ms) >= 60_000 ? `本机休眠 ${humanDuration(ms)}` : "";
}

const TONE_RANK = { ok: 0, unknown: 0, neutral: 0, warn: 1, critical: 2 };
const worstTone = (...tones) => tones.reduce((worst, tone) => ((TONE_RANK[tone] ?? 0) > (TONE_RANK[worst] ?? 0) ? tone : worst), "ok");

// 概览「隧道稳定性」：每条隧道一行——名称 | 在线条（+ SSH 响应细线）| 当前状态 +「N 次断线 · 可用率」。
// 悬停第二行看原因分布 / 断开共计 / 平均恢复 / 最长连续在线（原服务器页卡片上的四项指标），窗口里电脑休眠过再带一句。
// responses：Map<serverId, [{ ts, ms }]>（SSH 响应的原始序列）；没给就不带响应线。
export function buildStabilityRows(stats, windowKey = "24h", nowMs = Date.now(), responses = null) {
  const servers = Object.values(stats?.servers || {});
  const slept = sleptText(stats?.sleep?.[windowKey]?.ms);
  return servers.map((entry) => {
    const w = entry.windows?.[windowKey] || {};
    const drops = Number(w.drops) || 0;
    const state = stateOf(entry, nowMs);
    const strip = buildStrip(entry, windowKey);
    const detail = [
      drops ? causesText(w.causes) : `${STABILITY_WINDOW_LABELS[windowKey] || "这段时间"}没有断线`,
      w.downMs ? `断开共 ${humanDuration(w.downMs)}` : "",
      w.recoveries ? `平均恢复 ${humanDuration(w.meanRecoveryMs)}${w.recoveries > 1 && w.maxRecoveryMs != null ? `（最长 ${humanDuration(w.maxRecoveryMs)}）` : ""}` : "",
      w.longestUpMs ? `最长连续在线 ${humanDuration(w.longestUpMs)}` : "",
      w.networkChangeDrops ? `其中 ${w.networkChangeDrops} 次刚换过网` : "",
      slept ? `${slept}（不计入断线与可用率）` : "",
    ].filter(Boolean).join(" · ");
    return {
      serverId: entry.serverId,
      name: shortServerName(entry.name || entry.serverId),
      fullName: entry.name || entry.serverId,
      stateTone: state.tone,
      stateText: state.text,
      drops,
      summaryText: `${drops} 次断线 · ${Number.isFinite(w.availability) ? availabilityText(w.availability) : "记录不足"}`,
      summaryTone: worstTone(dropsTone(drops, windowKey), Number.isFinite(w.availability) ? availabilityTone(w.availability) : "ok"),
      summaryTitle: detail,
      strip,
      // SSH 响应只在近 24 小时窗口画（数据只留 24 小时），与在线条共用它的时间轴。
      response: strip.kind === "timeline" ? buildResponseStrip(responses?.get(entry.serverId), strip.start, strip.end) : null,
    };
  });
}

// 底部一行「最近一次」：所有隧道里最新的那次断线（不限窗口——窗口里没断线时它说明上一次是什么时候）。
// 休眠造成的不是断线，不在这里说。断着的时候电脑睡了的那次（endedBy=sleep）没有「恢复」，写它持续了多久。
export function lastDropText(stats) {
  const names = Object.fromEntries(Object.values(stats?.servers || {}).map((entry) => [entry.serverId, shortServerName(entry.name || entry.serverId)]));
  const last = (stats?.recentDrops || []).find((drop) => !drop.sleep);
  if (!last) return Number.isFinite(stats?.since) ? `记录以来没有断线（自 ${shortDateTime(stats.since)}）` : "还没有记录";
  const parts = [`${shortDateTime(last.at)} ${names[last.serverId] || last.serverId} · ${causeLabel(last.cause)}`];
  if (Number.isFinite(last.uptimeMs)) parts.push(`此前在线 ${humanDuration(last.uptimeMs)}`);
  if (!last.recoveredAt) parts.push("尚未恢复");
  else parts.push(last.endedBy === "sleep" ? `持续 ${humanDuration(last.downMs)}后电脑休眠` : `${humanDuration(last.downMs)}后恢复`);
  if (last.networkChange) parts.push("断线前刚换过网");
  return parts.join(" · ");
}

// 展开清单上方：每台有断线的服务器一行原因分布与恢复情况。
export function causeLines(stats, windowKey = "24h") {
  return Object.values(stats?.servers || {}).flatMap((entry) => {
    const w = entry.windows?.[windowKey] || {};
    if (!w.drops) return [];
    const parts = [causesText(w.causes)];
    if (w.recoveries) parts.push(`平均恢复 ${humanDuration(w.meanRecoveryMs)}`);
    if (w.longestUpMs) parts.push(`最长连续在线 ${humanDuration(w.longestUpMs)}`);
    return [{ name: shortServerName(entry.name || entry.serverId), text: parts.join(" · ") }];
  });
}

// 在线条：近 24 小时 = 分段时间线；近 7 天 = 每天一块（按当天可用率定语气）。
export function buildStrip(entry, windowKey) {
  if (windowKey === "7d") {
    const days = (entry?.daily || []).map((d) => {
      const tone = d.observedMs < 10 * 60_000 ? "none" : d.drops === 0 && (d.downMs || 0) === 0 ? "ok" : availabilityTone(d.availability);
      const label = `${Number(d.day.slice(5, 7))}.${Number(d.day.slice(8))}`;
      const slept = sleptText(d.sleepMs);
      const title = `${tone === "none" ? `${label} 没有记录` : `${label} · 断线 ${d.drops} 次 · 可用率 ${availabilityText(d.availability)}`}${slept ? ` · ${slept}` : ""}`;
      return { day: d.day, label, tone, title };
    });
    return { kind: "daily", days };
  }
  const tl = entry?.timeline;
  if (!tl) return { kind: "timeline", start: null, end: null, segments: [] };
  // 只留要画在在线条上面的段：断开（红）、未观测与休眠（都是斜纹，悬停说明不同）。
  return { kind: "timeline", start: tl.start, end: tl.end, segments: (tl.segments || []).filter((s) => s.state === "down" || s.state === "unobserved" || s.state === "sleep" || s.state === "standby") };
}

// ---- SSH 响应（在线条下面那条细线）----
// 数据是每分钟一次资源采集的耗时（/api/metrics 的 probeDurationMs，后端只留 24 小时）。它包含远端
// 采集脚本的执行时间，是粗略指标，不是纯网络延迟；和在线条画在同一根时间轴上，慢的时段和断线能对上看。

export const RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RESPONSE_BUCKET_MS = 5 * 60 * 1000;

// 292ms / 1.74s
export function formatResponseMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

// 取整上限：1 / 2 / 2.5 / 5 × 10^n 里不小于 value 的最小一档。
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= value) ?? 10 * power;
}

// 分位数（线性插值）；sorted 升序、非空。
function quantile(sorted, q) {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

// 把一批 /api/metrics 资源样本并进缓存（Map<serverId, [{ ts, ms }]>，各自按 ts 升序），并丢掉 cutoff 之前的点。
// 返回新的 Map，不改入参。没带耗时的样本跳过；同一时刻的重复样本只留一条（增量拉取的边界上可能重叠）。
export function mergeResponseSamples(cache, samples, cutoff = -Infinity) {
  const next = new Map();
  for (const [serverId, list] of cache || []) next.set(serverId, list.filter((point) => point.ts >= cutoff));
  for (const sample of Array.isArray(samples) ? samples : []) {
    const ms = sample?.probeDurationMs;
    if (!sample || typeof sample.serverId !== "string" || !Number.isFinite(sample.ts) || !Number.isFinite(ms) || ms < 0 || sample.ts < cutoff) continue;
    const list = next.get(sample.serverId) || [];
    let at = list.length;
    while (at > 0 && list[at - 1].ts > sample.ts) at -= 1;
    if (at > 0 && list[at - 1].ts === sample.ts) continue;
    list.splice(at, 0, { ts: sample.ts, ms });
    next.set(sample.serverId, list);
  }
  for (const [serverId, list] of next) if (!list.length) next.delete(serverId);
  return next;
}

// 缓存里最新一条样本的时刻（增量拉取从它之后开始）；空缓存返回 null。
export function latestResponseTs(cache) {
  let latest = null;
  for (const list of (cache || new Map()).values()) {
    const ts = list.at(-1)?.ts;
    if (ts != null && (latest == null || ts > latest)) latest = ts;
  }
  return latest;
}

// 一台服务器的 SSH 响应条。samples = [{ ts, ms }]（升序）；[start, end] 取在线条的时间轴。
// 5 分钟一段取最慢的那一次，点就画在它实际发生的时刻；中间缺了整段（那 5 分钟一次都没采到）就断开。
// 纵轴上限按各段最慢值的 99 分位取整——偶发的一次极慢不该把整条线压扁，超出的点贴顶。
// 中位 / 最慢按逐条样本算（不是按分段后的最慢值）。窗口内不足两条样本返回 null（不画这条线）。
export function buildResponseStrip(samples, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const inWindow = (samples || []).filter((point) => point.ts >= start && point.ts <= end);
  if (inWindow.length < 2) return null;
  const points = [];
  for (const point of inWindow) {
    const bucket = Math.floor(point.ts / RESPONSE_BUCKET_MS);
    const last = points.at(-1);
    if (!last || last.bucket !== bucket) points.push({ bucket, ts: point.ts, ms: point.ms });
    else if (point.ms > last.ms) Object.assign(last, { ts: point.ts, ms: point.ms });
  }
  const all = inWindow.map((point) => point.ms).sort((a, b) => a - b);
  const peaks = points.map((point) => point.ms).sort((a, b) => a - b);
  const yMax = niceMax(quantile(peaks, 0.99));
  const median = quantile(all, 0.5);
  const slowest = all.at(-1);
  return {
    start,
    end,
    points,
    yMax,
    medianText: formatResponseMs(median),
    slowestText: formatResponseMs(slowest),
    title: `SSH 响应 · 每 5 分钟取最慢的一次 · 纵轴 0–${formatResponseMs(yMax)}`,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// 响应条的两条 path（折线 + 面积）。坐标系 width × height，底边留 1px 给基线；相邻两点隔了整段就另起一段，
// 孤立的一段画成一个点（圆头线帽下零长线段可见）。
export function responsePaths(strip, width = 600, height = 26) {
  const points = strip?.points || [];
  const span = Math.max(1, (strip?.end ?? 0) - (strip?.start ?? 0));
  const x = (point) => round1(((point.ts - strip.start) / span) * width);
  const y = (point) => round1(height - 1 - Math.min(1, point.ms / strip.yMax) * (height - 3));
  const lines = [];
  const areas = [];
  let from = 0;
  for (let i = 1; i <= points.length; i += 1) {
    if (i < points.length && points[i].bucket - points[i - 1].bucket <= 1) continue;
    if (i - from === 1) {
      lines.push(`M${x(points[from])} ${y(points[from])}h0.01`);
    } else {
      let d = `M${x(points[from])} ${y(points[from])}`;
      for (let k = from + 1; k < i; k += 1) d += ` L${x(points[k])} ${y(points[k])}`;
      lines.push(d);
      areas.push(`${d} L${x(points[i - 1])} ${height} L${x(points[from])} ${height} Z`);
    }
    from = i;
  }
  return { line: lines.join(" "), area: areas.join(" ") };
}

// 悬停：横向位置（0–1）落在哪一段——取时刻最近的那个点。返回 { left（0–1）, text } 或 null。
export function responseHoverAt(strip, fraction) {
  const points = strip?.points || [];
  if (!points.length) return null;
  const span = strip.end - strip.start;
  const at = strip.start + Math.max(0, Math.min(1, fraction)) * span;
  let hit = points[0];
  for (const point of points) {
    if (Math.abs(point.ts - at) < Math.abs(hit.ts - at)) hit = point;
  }
  // 数值在前、时刻在后（与资源趋势的气泡同一写法）
  return { left: (hit.ts - strip.start) / span, text: `${formatResponseMs(hit.ms)} · ${shortDateTime(hit.ts)}` };
}

export const DROP_GROUP_MIN = 2;

function rangeText(values, fmt) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return "—";
  const lo = fmt(list[0]);
  const hi = fmt(list.at(-1));
  return lo === hi ? lo : `${lo} – ${hi}`;
}

// 清单里的一行「本机休眠」：同一段休眠造成的几次断开后端已经并成一条（sleep: true），这里只负责说明。
const SLEEP_ROW_NOTE = "电脑休眠期间隧道不可用，不计入断线次数与可用率";

// 最近断线：同一台服务器、同一原因、连续发生的断线（≥ DROP_GROUP_MIN 次）合并成一组，显示次数与
// 时间 / 此前在线 / 恢复用时的范围，点开看逐条（阿里云那种「服务器端断开」一晚上七八次的就不再刷屏）。
// 组的 key 用组里最早那次的时刻：新的断线接进同一组时 key 不变，展开状态保持。
// expanded：展开着的组 key 集合（控制器持有）。返回行：{ kind: "group" | "drop", … }，展开的组后面紧跟逐条（child）。
// since：只列这个时刻之后的断线（概览按当前统计窗口过滤；不给 = 全部）。
export function buildDropRows(stats, limit = 20, { expanded = new Set(), since = -Infinity } = {}) {
  const names = Object.fromEntries(Object.values(stats?.servers || {}).map((entry) => [entry.serverId, shortServerName(entry.name || entry.serverId)]));
  const drops = (stats?.recentDrops || []).filter((drop) => drop.at >= since).slice(0, limit).map((drop) => {
    // 休眠那一行：中性，不标红；还没连上写「重连中」，「恢复用时」一栏是休眠让这条隧道不可用了多久。
    const sleep = drop.sleep === true;
    return {
      kind: "drop",
      key: `${drop.serverId}:${drop.at}`,
      serverId: drop.serverId,
      causeCode: drop.cause,
      at: drop.at,
      time: shortDateTime(drop.at),
      name: names[drop.serverId] || drop.serverId,
      cause: causeLabel(drop.cause),
      sleep,
      detail: sleep ? `${SLEEP_ROW_NOTE}${drop.drops > 1 ? `；期间断开 ${drop.drops} 次` : ""}` : drop.detail || "",
      networkChange: drop.networkChange === true,
      uptimeMs: Number.isFinite(drop.uptimeMs) ? drop.uptimeMs : null,
      downMs: drop.recoveredAt ? drop.downMs : null,
      uptime: Number.isFinite(drop.uptimeMs) ? humanDuration(drop.uptimeMs) : "—",
      recovery: drop.recoveredAt ? humanDuration(drop.downMs) : sleep ? "重连中" : "进行中",
      ongoing: !drop.recoveredAt && !sleep,
    };
  });
  // recentDrops 新 → 旧：按相邻的「服务器 + 原因」切段。
  const runs = [];
  for (const drop of drops) {
    const last = runs.at(-1);
    if (last && last[0].serverId === drop.serverId && last[0].causeCode === drop.causeCode) last.push(drop);
    else runs.push([drop]);
  }
  const rows = [];
  for (const run of runs) {
    if (run.length < DROP_GROUP_MIN) {
      rows.push(run[0]);
      continue;
    }
    const newest = run[0];
    const oldest = run.at(-1);
    const key = `g:${newest.serverId}:${newest.causeCode}:${oldest.at}`;
    const open = expanded.has(key);
    const sameDay = shortDateTime(oldest.at).split(" ")[0] === shortDateTime(newest.at).split(" ")[0];
    const ongoing = run.some((d) => d.ongoing);
    // 休眠行还没连上的不标红（ongoing 为假），但组的「恢复用时」要如实带上「重连中」。
    const reconnecting = run.some((d) => d.sleep && d.downMs == null);
    const recovered = run.filter((d) => !d.ongoing && !(d.sleep && d.downMs == null));
    const changes = run.filter((d) => d.networkChange).length;
    rows.push({
      kind: "group",
      key,
      count: run.length,
      expanded: open,
      memberKeys: run.map((d) => d.key),
      name: newest.name,
      cause: newest.cause,
      sleep: newest.sleep,
      time: `${oldest.time} – ${sameDay ? newest.time.split(" ")[1] : newest.time}`,
      uptime: rangeText(run.map((d) => d.uptimeMs), humanDuration),
      recovery: [recovered.length ? rangeText(recovered.map((d) => d.downMs), humanDuration) : "", ongoing ? "进行中" : "", reconnecting ? "重连中" : ""].filter(Boolean).join(" · "),
      ongoing,
      networkChangeCount: changes,
      title: `${newest.name} · ${newest.cause} · ${run.length} 次（${oldest.time} – ${newest.time}）${open ? "" : "，点击展开"}`,
    });
    if (open) for (const drop of run) rows.push({ ...drop, child: true, groupKey: key });
  }
  return rows;
}

// 清单里有几次真正的断线、几行休眠（组行按组里的次数算）。「全部 N 次」与「只列出最近 N 次」只数断线。
export function countDropRows(rows) {
  const out = { drops: 0, sleeps: 0 };
  for (const row of rows) {
    if (row.child) continue;
    out[row.sleep ? "sleeps" : "drops"] += row.kind === "group" ? row.count : 1;
  }
  return out;
}

// 某次断线所在的组（点在线条上的断线刻度定位时先展开它）；不在任何组里返回 null。
export function dropGroupKeyOf(rows, dropKey) {
  return rows.find((row) => row.kind === "group" && row.memberKeys.includes(dropKey))?.key ?? null;
}

// 统计窗口的起点：近 24 小时 / 近 7 天，从统计生成时刻往回推（清单按它过滤）。
export function windowStartOf(stats, windowKey) {
  const end = Number.isFinite(stats?.generatedAt) ? stats.generatedAt : Date.now();
  return end - (windowKey === "7d" ? 7 : 1) * 24 * 3600_000;
}

// 横轴刻度：12:00 / 18:00 / 0 点 / 06:00 这类整 6 小时时刻（北京时间），落在窗口内的才画。
export function uptimeTicks(start, end) {
  const out = [];
  const span = end - start;
  const bjOffset = TZ_OFFSET_SEC * 1000;
  const pct = (v) => `${(((v - start) / span) * 100).toFixed(3)}%`;
  const first = Math.ceil((start + bjOffset) / (6 * 3600_000)) * 6 * 3600_000 - bjOffset;
  for (let t = first; t < end - 30 * 60_000; t += 6 * 3600_000) {
    if (t - start < 30 * 60_000) continue;
    const hour = new Date(t + bjOffset).getUTCHours();
    out.push({ left: pct(t), label: hour === 0 ? "0 点" : `${String(hour).padStart(2, "0")}:00`, today: hour === 0 });
  }
  return out;
}

export function sinceCaption(stats) {
  return Number.isFinite(stats?.since) ? `记录始于 ${shortDateTime(stats.since)}（北京时间）` : "尚无记录";
}
