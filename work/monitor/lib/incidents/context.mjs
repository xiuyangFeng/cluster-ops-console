// incidents/context.mjs —— 事件前后经过（纯函数）：把一条事件前后若干分钟里的相关信号排成一条小时间轴，
// 帮人判断因果（「是先休眠再断的」「是配置一改就断了」「重启后 38 秒恢复」）。
//
// 只读本机已有的记录，不发 SSH：
//   ledger   断线账本（runtime/tunnel-ledger.ndjson，tunnelStability.loadEvents()）：该服务器的
//            down / up（含原因、计划内、换网、休眠期间）与全局的 wake（电脑休眠 [at - sleptMs, at]）
//   incidents 其它事件（未解决 + 已恢复）：同一服务器或全局的事件开始 / 恢复，以及它们的处置记录
//   history  历史日文件（runtime/history/<北京日期>.ndjson）的 signal 行（卡顿信号，含 429 限流）与
//            levels 行里的 start / stop（监控服务启动 / 停止——热更新重启界面也在这里留痕）
//   logs     内存日志环（logger.queryLogs）里的热更新交接、自动修复、换网、配置变更
// 输出是结构化条目（kind + 字段），文案由前端按界面用语拼（原因码 / 名字的翻译表都在前端）。
// 信号与日志没有 serverId（只覆盖当时查看的服务器 / 本机），条目上标 scope: "view" | "local"。
// 同一类（同指纹）的其它事件不列：它们就是事件簇里的逐次，开始 / 恢复与断线账本的断开 / 重连重复，只会翻倍刷屏。
import { buildIncidentFingerprint } from "./store.mjs";

export const CONTEXT_BEFORE_MS = 10 * 60 * 1000;
export const CONTEXT_AFTER_MS = 10 * 60 * 1000;
// 事件持续很久时只看「开始前后」与「结束前后」两段，中间折叠（不然一条持续一天的事件会把整天的抖动都列进来）。
export const CONTEXT_EDGE_MS = 30 * 60 * 1000;
export const CONTEXT_MAX_SPAN_MS = 2 * CONTEXT_EDGE_MS + CONTEXT_BEFORE_MS + CONTEXT_AFTER_MS;
export const CONTEXT_MAX_ENTRIES = 60;

// 日志事件名 → 时间轴条目种类（只收对判断因果有用的几类）。
const LOG_EVENT_KINDS = {
  "supervisor-handoff": "handoff",
  "proxy-handoff": "handoff",
  "data-plane-upgrade": "handoff",
  "self-update": "self-update",
  "network-changed": "network",
  "tunnel-network-changed": "network",
  "config-audit": "config",
};
// 配置文件被外部改动后的热载没有 event 字段，只有这句 ops 日志（lib/channel-lifecycle.mjs）。
const CONFIG_RELOAD_RE = /^config\.json changed on disk/;

const finite = (value) => (Number.isFinite(value) ? value : null);
const text = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : "");

// 时间窗：[开始 - before, min(现在, 结束 + after)]；太长时拆成两段，返回 { ranges, gap }。
export function contextWindow(incident, { nowMs = Date.now(), beforeMs = CONTEXT_BEFORE_MS, afterMs = CONTEXT_AFTER_MS } = {}) {
  const start = finite(incident?.firstSeenAt);
  if (start == null) return null;
  const end = incident.lifecycle === "resolved" && finite(incident.resolvedAt) != null ? incident.resolvedAt : nowMs;
  const from = start - beforeMs;
  const to = Math.max(start, Math.min(nowMs, end + afterMs));
  if (to - from <= CONTEXT_MAX_SPAN_MS) return { from, to, ranges: [[from, to]], gap: null };
  const headEnd = start + CONTEXT_EDGE_MS;
  const tailStart = Math.max(headEnd, end - CONTEXT_EDGE_MS);
  return { from, to, ranges: [[from, headEnd], [tailStart, to]], gap: { from: headEnd, to: tailStart } };
}

const inRanges = (ranges, at) => Number.isFinite(at) && ranges.some(([a, b]) => at >= a && at <= b);

function ledgerEntries(ledger, incident, ranges) {
  const out = [];
  const serverId = incident.serverId || null;
  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (!row || typeof row.type !== "string") continue;
    if (row.type === "wake") {
      const slept = finite(row.sleptMs);
      const at = finite(row.at);
      if (slept == null || at == null) continue;
      // 休眠段与窗口有交集就列，时刻取「睡着」那一刻
      const sleptAt = at - slept;
      if (!ranges.some(([a, b]) => sleptAt <= b && at >= a)) continue;
      out.push({ at: sleptAt, kind: "sleep", sleptMs: slept, wokeAt: at, scope: "local" });
      continue;
    }
    if (row.type !== "down" && row.type !== "up") continue;
    if (!serverId || row.serverId !== serverId || !inRanges(ranges, row.at)) continue;
    if (row.type === "down") {
      out.push({
        at: row.at,
        kind: row.planned && row.cause === "config-change" ? "config" : "tunnel-down",
        serverId,
        cause: text(row.cause, 40),
        detail: text(row.detail),
        planned: row.planned === true,
        networkChange: row.networkChange === true,
        sleep: row.sleep === true,
      });
    } else {
      out.push({
        at: row.at,
        kind: "tunnel-up",
        serverId,
        downMs: finite(row.downMs),
        attempts: finite(row.attempts),
        via: text(row.via, 20),
      });
    }
  }
  return out;
}

const sameScope = (a, b) => (a.serverId || null) === (b.serverId || null) || !a.serverId || !b.serverId;

function incidentEntries(incident, incidents, ranges) {
  const out = [];
  const seenOps = new Set();
  const pick = ({ serverId, agentId, component, reasonCode, incidentId, severity }) => ({ serverId: serverId || null, agentId: agentId || null, component, reasonCode, incidentId, severity });
  const pushDispositions = (item, self) => {
    for (const d of Array.isArray(item.dispositions) ? item.dispositions : []) {
      if (!d || seenOps.has(d.operationId) || !inRanges(ranges, d.at)) continue;
      seenOps.add(d.operationId);
      out.push({ at: d.at, kind: "disposition", self, operationId: d.operationId, action: d.action, trigger: d.trigger, outcome: d.outcome ?? null, afterMs: finite(d.afterMs) });
    }
  };
  if (inRanges(ranges, incident.firstSeenAt)) out.push({ at: incident.firstSeenAt, kind: "incident-open", self: true, ...pick(incident) });
  if (incident.lifecycle === "resolved" && inRanges(ranges, incident.resolvedAt)) out.push({ at: incident.resolvedAt, kind: "incident-resolved", self: true, ...pick(incident) });
  pushDispositions(incident, true);
  const ownType = buildIncidentFingerprint(incident);
  for (const other of Array.isArray(incidents) ? incidents : []) {
    if (!other || other.incidentId === incident.incidentId || !sameScope(incident, other)) continue;
    if (buildIncidentFingerprint(other) === ownType) continue;
    if (inRanges(ranges, other.firstSeenAt)) out.push({ at: other.firstSeenAt, kind: "incident-open", self: false, ...pick(other) });
    if (other.lifecycle === "resolved" && inRanges(ranges, other.resolvedAt)) out.push({ at: other.resolvedAt, kind: "incident-resolved", self: false, ...pick(other) });
    pushDispositions(other, false);
  }
  return out;
}

function historyEntries(history, ranges) {
  const out = [];
  for (const row of Array.isArray(history) ? history : []) {
    if (!row || !inRanges(ranges, row.ts)) continue;
    if (row.type === "signal" && (row.severity === "warn" || row.severity === "error")) {
      out.push({ at: row.ts, kind: "signal", scope: "view", signalId: text(row.signalId, 40), title: text(row.title), severity: row.severity, rootCause: text(row.rootCause, 20) });
    } else if (row.type === "levels" && (row.cause === "start" || row.cause === "stop")) {
      out.push({ at: row.ts, kind: row.cause === "start" ? "monitor-start" : "monitor-stop", scope: "local", unclean: row.unclean === true });
    }
  }
  return out;
}

function logEntries(logs, incident, ranges) {
  const out = [];
  for (const entry of Array.isArray(logs) ? logs : []) {
    if (!entry || !inRanges(ranges, entry.ts)) continue;
    const message = text(entry.message, 160);
    if (entry.event === "auto-repair") {
      // 自动修复：只收真的动了手的（有 operationId）且与本事件服务器相关（单隧道带 serverId，整通道不带）
      if (!entry.operationId) continue;
      if (entry.serverId && incident.serverId && entry.serverId !== incident.serverId) continue;
      out.push({ at: entry.ts, kind: "auto-repair", scope: "local", operationId: text(entry.operationId, 64), ruleId: text(entry.ruleId, 40), message });
      continue;
    }
    const kind = LOG_EVENT_KINDS[entry.event] || (CONFIG_RELOAD_RE.test(message) ? "config" : null);
    if (!kind) continue;
    if (entry.serverId && incident.serverId && entry.serverId !== incident.serverId) continue;
    out.push({ at: entry.ts, kind, scope: "local", event: text(entry.event, 40), message });
  }
  return out;
}

// 组装：窗口内的条目按时刻升序；同一时刻自己的事件排前面。处置记录与日志里的自动修复同一 operationId 只留处置记录。
// 超过 maxEntries 时保留离开始 / 结束最近的，truncated 记被省略的条数。
export function buildIncidentContext({ incident, incidents = [], ledger = [], history = [], logs = [], nowMs = Date.now(), maxEntries = CONTEXT_MAX_ENTRIES } = {}) {
  const window = contextWindow(incident, { nowMs });
  if (!window) return null;
  const { ranges } = window;
  const fromIncidents = incidentEntries(incident, incidents, ranges);
  const ops = new Set(fromIncidents.filter((e) => e.kind === "disposition").map((e) => e.operationId));
  let entries = [
    ...fromIncidents,
    ...ledgerEntries(ledger, incident, ranges),
    ...historyEntries(history, ranges),
    ...logEntries(logs, incident, ranges).filter((e) => e.kind !== "auto-repair" || !ops.has(e.operationId)),
  ];
  entries.sort((a, b) => (a.at - b.at) || (Number(Boolean(b.self)) - Number(Boolean(a.self))));
  let truncated = 0;
  if (entries.length > maxEntries) {
    const anchors = [incident.firstSeenAt, incident.resolvedAt ?? nowMs].filter(Number.isFinite);
    const distance = (e) => Math.min(...anchors.map((t) => Math.abs(e.at - t)));
    const keep = new Set([...entries].sort((a, b) => (Number(Boolean(b.self)) - Number(Boolean(a.self))) || (distance(a) - distance(b))).slice(0, maxEntries));
    truncated = entries.length - keep.size;
    entries = entries.filter((e) => keep.has(e));
  }
  return { incidentId: incident.incidentId, from: window.from, to: window.to, gap: window.gap, entries, truncated };
}
