// incidents/clusters.mjs —— 事件簇（纯函数）：同一类（指纹）短时间内接连发生的事件合成一簇。
//
// 为什么要：事件存储按「一次生命周期」记事件——隧道抖动 25 分钟里断开 7 次，就是 7 条一模一样的
// 「隧道 · 连接断开」，已恢复的逐条列表被刷屏，真正想知道的「抖了几次、断了多久、从几点到几点」
// 反而要自己数。打开门槛与抖动保护（store.mjs）只管「要不要立案」，不管「怎么给人看」。
//
// 规则：同指纹的事件按首次发生排序，前一条结束（已恢复取 resolvedAt，未恢复取 lastSeenAt）到后一条
// 开始的间隔不超过 gapMs（缺省 15 分钟，与抖动窗口一致）就并入同一簇。只读、不改事件、不落盘；
// 指纹与 store 同一份算法（buildIncidentFingerprint），簇 id 取簇里最早一条的 incidentId。
import { buildIncidentFingerprint, INCIDENT_FLAP_WINDOW_MS } from "./store.mjs";

export const INCIDENT_CLUSTER_GAP_MS = INCIDENT_FLAP_WINDOW_MS;
// 每簇附带的逐条记录上限（簇的统计量按全部成员算）。
export const INCIDENT_CLUSTER_MEMBERS_MAX = 20;
const SEVERITY_RANK = { info: 0, warn: 1, error: 2 };

const finite = (value) => (Number.isFinite(value) ? value : null);
const endOf = (incident) => finite(incident.resolvedAt) ?? finite(incident.lastSeenAt) ?? finite(incident.firstSeenAt);

function memberOf(incident) {
  return {
    incidentId: incident.incidentId,
    lifecycle: incident.lifecycle === "resolved" ? "resolved" : "open",
    firstSeenAt: finite(incident.firstSeenAt),
    lastSeenAt: finite(incident.lastSeenAt),
    resolvedAt: finite(incident.resolvedAt),
    occurrences: Number.isFinite(incident.occurrences) ? incident.occurrences : 1,
    relatedOperationIds: Array.isArray(incident.relatedOperationIds) ? incident.relatedOperationIds.slice(-3) : [],
    dispositions: Array.isArray(incident.dispositions) ? incident.dispositions : [],
  };
}

function summarizeCluster(members, nowMs) {
  const first = members[0];
  const ordered = [...members].reverse(); // 最新在前
  let downMs = 0;
  let severity = "info";
  let occurrences = 0;
  let lastAt = null;
  let open = false;
  for (const item of members) {
    const start = finite(item.firstSeenAt);
    const end = item.lifecycle === "resolved" ? finite(item.resolvedAt) : nowMs;
    if (start != null && end != null && end >= start) downMs += end - start;
    if ((SEVERITY_RANK[item.severity] ?? 1) > SEVERITY_RANK[severity]) severity = item.severity;
    occurrences += Number.isFinite(item.occurrences) ? item.occurrences : 1;
    const itemEnd = endOf(item);
    if (itemEnd != null && (lastAt == null || itemEnd > lastAt)) lastAt = itemEnd;
    if (item.lifecycle !== "resolved") open = true;
  }
  const firstSeenAt = finite(first.firstSeenAt);
  const operationIds = [];
  for (const item of ordered) {
    for (const id of Array.isArray(item.relatedOperationIds) ? item.relatedOperationIds : []) {
      if (typeof id === "string" && !operationIds.includes(id)) operationIds.push(id);
    }
  }
  return {
    clusterId: first.incidentId,
    serverId: first.serverId || null,
    agentId: first.agentId || null,
    component: first.component,
    reasonCode: first.reasonCode,
    severity: SEVERITY_RANK[severity] != null ? severity : "warn",
    count: members.length,
    occurrences,
    open,
    firstSeenAt,
    lastSeenAt: lastAt,
    resolvedAt: open ? null : lastAt,
    // 期间处于故障中的累计时长（各条首次 → 恢复，未恢复的算到现在）与整簇跨度（首次 → 最近）
    downMs,
    spanMs: firstSeenAt != null && lastAt != null ? Math.max(0, (open ? nowMs : lastAt) - firstSeenAt) : null,
    operationIds: operationIds.slice(0, 3),
    members: ordered.slice(0, INCIDENT_CLUSTER_MEMBERS_MAX).map(memberOf),
  };
}

// incidents：store.query / store.list 的序列化事件（不带指纹，按字段重算）。返回按「最近一次」倒序的簇。
export function clusterIncidents(incidents, { gapMs = INCIDENT_CLUSTER_GAP_MS, nowMs = Date.now() } = {}) {
  const byType = new Map();
  for (const incident of Array.isArray(incidents) ? incidents : []) {
    if (!incident || typeof incident.incidentId !== "string" || finite(incident.firstSeenAt) == null) continue;
    const key = buildIncidentFingerprint(incident);
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(incident);
  }
  const clusters = [];
  for (const list of byType.values()) {
    list.sort((a, b) => (a.firstSeenAt - b.firstSeenAt) || (a.incidentId < b.incidentId ? -1 : 1));
    let current = [];
    let currentEnd = null;
    for (const incident of list) {
      if (current.length && incident.firstSeenAt - currentEnd > gapMs) {
        clusters.push(summarizeCluster(current, nowMs));
        current = [];
        currentEnd = null;
      }
      current.push(incident);
      const end = endOf(incident);
      if (currentEnd == null || end > currentEnd) currentEnd = end;
    }
    if (current.length) clusters.push(summarizeCluster(current, nowMs));
  }
  clusters.sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (a.clusterId < b.clusterId ? -1 : 1));
  return clusters;
}

// 未解决事件的「这是短时间内的第几次」：同指纹、紧挨着它之前（间隔 ≤ gapMs，一条接一条往前追）的已恢复事件。
// 返回 { count（含它自己）, sinceAt（这一串的首次）, downMs（之前几次已恢复的累计故障时长） }；之前没有则 null。
export function recurrenceOf(incident, resolvedIncidents, { gapMs = INCIDENT_CLUSTER_GAP_MS } = {}) {
  if (!incident || finite(incident.firstSeenAt) == null) return null;
  const key = buildIncidentFingerprint(incident);
  const sameType = (Array.isArray(resolvedIncidents) ? resolvedIncidents : []).filter((item) => item && buildIncidentFingerprint(item) === key);
  return recurrenceFromSameType(incident, sameType, gapMs);
}

// 一批未解决事件一起算（未解决列表每次轮询都要算）：已恢复池只按指纹分组一次，
// 只留未解决事件用得到的那几类——O(未解决 + 已恢复)，而不是逐条全池扫描。返回 Map<incidentId, recurrence>。
export function recurrenceMap(openIncidents, resolvedIncidents, { gapMs = INCIDENT_CLUSTER_GAP_MS } = {}) {
  const result = new Map();
  const open = (Array.isArray(openIncidents) ? openIncidents : []).filter((item) => item && finite(item.firstSeenAt) != null);
  if (!open.length) return result;
  const wanted = new Map(open.map((item) => [buildIncidentFingerprint(item), []]));
  for (const item of Array.isArray(resolvedIncidents) ? resolvedIncidents : []) {
    if (!item) continue;
    wanted.get(buildIncidentFingerprint(item))?.push(item);
  }
  for (const item of open) {
    const recurrence = recurrenceFromSameType(item, wanted.get(buildIncidentFingerprint(item)), gapMs);
    if (recurrence) result.set(item.incidentId, recurrence);
  }
  return result;
}

function recurrenceFromSameType(incident, sameType, gapMs) {
  const before = (sameType || [])
    .filter((item) => item.incidentId !== incident.incidentId && finite(item.resolvedAt) != null
      && finite(item.firstSeenAt) != null && item.resolvedAt <= incident.firstSeenAt)
    .sort((a, b) => b.resolvedAt - a.resolvedAt);
  let edge = incident.firstSeenAt;
  let count = 1;
  let sinceAt = incident.firstSeenAt;
  let downMs = 0;
  for (const item of before) {
    if (edge - item.resolvedAt > gapMs) break;
    count += 1;
    downMs += Math.max(0, item.resolvedAt - item.firstSeenAt);
    sinceAt = Math.min(sinceAt, item.firstSeenAt);
    edge = Math.min(edge, item.firstSeenAt);
  }
  return count > 1 ? { count, sinceAt, downMs } : null;
}
