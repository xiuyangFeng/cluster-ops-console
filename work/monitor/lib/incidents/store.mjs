// incidents/store.mjs —— T07 事件合并与提醒管理（纯逻辑 + 有界序列化）。落盘调度见 persister.mjs。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §10）：
//   - 指纹 = 上下文目标(serverId|global) + 组件(component) + 稳定 reasonCode。
//     绝不用完整错误消息 / 时间戳做去重键——否则每条日志都成为新事件。
//   - incidentId 表示一次生命周期：恢复后重现创建新 incidentId，可保留前次关联。
//   - lifecycle 只有 open/resolved；attention（acknowledge/snooze）独立于故障事实——
//     已确认不等于已解决，稍后提醒不停止诊断/保活。
//   - 严重度升级解除 snooze 并说明原因（升级再提醒）；确认不随升级清空（A28）。
//   - 磁盘事件的确认记下当时用量；之后用量再涨 DISK_REARM_DELTA 个百分点即解除确认、重新提醒
//     （共享卷长期高位、用户无从清理时，可以"已知晓"而不被常驻告警打扰，真变糟时又不会漏掉）。
//   - 恢复按真实新采样判断：网络/组件类故障连续 2 次同上下文成功后恢复；
//     磁盘阈值迟滞（>=90 打开、<88 连续 2 次关闭、88–89 中性）；unknown 不算
//     恢复采样也不算失败采样（由调用方决定是否上报 observe）。
//   - 存储：内存有界（活跃 ≤500、已关闭 ≤1000），超限合并溢出摘要并告警；
//     当前状态原子保存（tmp+rename），文件纳入 runtime 存储预算（storage-sweeper）。
//   - 持久化按修订号驱动：只有真实持久化状态变化（打开/升级/关闭/确认/稍后提醒/
//     次数累加/生命周期同步）才递增 revision；成功连击（successStreaks）不落盘、
//     不递增修订号，空转的 reportSuccess / 磁盘中性带采样不会触发重写。
//     已关闭事件拆到独立文件（incidents-closed.json），只在已关闭集合变化时重写；
//     旧版单文件（incidents.json 内含 closed）透明兼容加载并在首次保存时迁移。
//     落盘调度（何时写、写哪份文件）在 incidents/persister.mjs；本模块只负责序列化。
//   - 不提供 "resolved:true" 之类的写接口掩盖观测失败：关闭只能由真实成功采样驱动。
//
// 降噪（2026-10，生产 incidents-closed.json 顶满 1000 条、915 条是 codex DEGRADED 48s 开关）：
//   - agent 作用域：带 agentId 的事实，指纹与成功连击都按 agent 区分（`srv|agent:codex|DEGRADED`、
//     连击键 `srv|agent:codex`）；agentId 为空时保持旧格式（隧道/通道/磁盘指纹不变）。
//     否则 claude 探针的成功会关掉 codex 的事件，下一次 doctor 失败又开新的。
//   - 打开门槛（INCIDENT_OPEN_GATE）：同指纹没有未解决事件时，首次失败只进内存里的待定候选
//     （pending），持续够久（minMs）或累计够多次（minCount）才转正为事件——一次成功采样即撤销候选；firstSeenAt/次数/
//     证据沿用候选。转正也由调用方定时 promotePending() 推动（隧道/通道断开只有一次层级变迁）。
//     候选按与恢复相同的规则（连续 RECOVERY_SUCCESS_STREAK 次成功）撤销；同指纹 15min 内撤销
//     ≥3 次视为抖动，下一次失败直接打开并注明。候选不落盘、不递增修订号、不进查询/计数。
//   - 已关闭池先按指纹限额（每指纹 ≤50 条，淘汰该指纹最旧），再按全局上限淘汰最旧——
//     一个刷屏的指纹不能把其它真实历史挤出去。读回超额快照时同样生效。
//
// 按类型汇总（事件页「已恢复 · 按类型」，summarize()）：
//   - 已关闭池每指纹只留 50 条，直接数留存记录的话次数会在 50 封顶。所以事件恢复时另记一笔
//     「指纹 × 北京自然日」计数：[当天处于发生中的条数, 当天恢复的条数]，之后不再受已关闭池淘汰影响。
//     只留最近 31 天、最多 200 个指纹，随已关闭文件（旧版单文件则随主文件）持久化。
//   - 旧文件没有计数：加载时按还留着的已恢复记录回填。回填只是下限——指纹留存数顶到限额时，
//     比它最旧一条留存记录更早恢复的事件已被清理；记下这个边界（evictedBefore），汇总时边界之前的
//     日子标成「记录已清理」、次数标成下限，不当成 0 也不当成准确值。上线后的日子是准确的。
//   - 次数与逐日分布来自计数；最近一次、持续时长统计、最近几条来自还留着的已恢复记录。

import { randomUUID as nodeRandomUUID } from "node:crypto";

import { dayKeyOf, offsetDay } from "../usage/time.mjs";
import { addDisposition, expireDispositions, hasPendingDisposition, normalizeDispositions, settleOnRecovery } from "./disposition.mjs";

export const INCIDENT_SCHEMA_VERSION = 1;
const INCIDENT_SEVERITIES = Object.freeze(["info", "warn", "error"]);
const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, error: 2 });
// 网络/组件类故障的恢复采样数（连续 2 次同上下文成功）。
const RECOVERY_SUCCESS_STREAK = 2;
const INCIDENT_MAX_ACTIVE = 500;
const INCIDENT_MAX_CLOSED = 1000;
const INCIDENT_MAX_ARCHIVED = INCIDENT_MAX_ACTIVE + INCIDENT_MAX_CLOSED;
export const INCIDENT_SERVER_TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INCIDENT_EVIDENCE_MAX = 8;
export const INCIDENT_SNOOZE_MAX_MS = 24 * 60 * 60 * 1000;
// 磁盘迟滞阈值（设计示例）：>=90 打开，<88 连续 2 次关闭，88–89 中性带。
export const DISK_OPEN_PCT = 90;
export const DISK_CLOSE_PCT = 88;
// 已确认的磁盘事件：用量比确认时再涨这么多个百分点就重新提醒。
export const DISK_REARM_DELTA = 2;
// 持久化文件软上限（纳入本地数据预算；超限只存活跃事件）。
export const INCIDENT_FILE_MAX_BYTES = 1024 * 1024;
// 已关闭池每个指纹最多保留的条数（先于全局上限生效）。
export const INCIDENT_MAX_CLOSED_PER_FINGERPRINT = 50;
// 打开门槛：组件 → { minMs?, minCount? }，两者任一先满足即转正；未列出的组件（磁盘
// filesystem 等）立即打开。隧道/通道的短暂掉线（supervisor 10–40s 内重连）与换网不再成事件；
// agent 探针每轮都会上报，按 3 次或 150s 先到者转正。
export const INCIDENT_OPEN_GATE = Object.freeze({
  tunnel: Object.freeze({ minMs: 120000 }),
  channel: Object.freeze({ minMs: 120000 }),
  agent: Object.freeze({ minMs: 150000, minCount: 3 }),
});
// 抖动保护：同指纹在窗口内被成功撤销的待定候选达到阈值，下一次失败直接打开。
export const INCIDENT_FLAP_WINDOW_MS = 15 * 60 * 1000;
export const INCIDENT_FLAP_THRESHOLD = 3;
// 按类型汇总的逐日计数：保留天数（含今天）、指纹数上限、汇总窗口缺省天数、每类附带的最近记录条数。
export const INCIDENT_DAY_COUNT_RETENTION_DAYS = 31;
export const INCIDENT_DAY_COUNT_MAX_TYPES = 200;
export const INCIDENT_DAY_COUNT_SCHEMA_VERSION = 1;
export const INCIDENT_SUMMARY_DEFAULT_DAYS = 14;
export const INCIDENT_SUMMARY_RECENT_MAX = 8;
// 单日计数的合理上限（损坏文件里的离谱数字夹到这里）。
const DAY_COUNT_CELL_MAX = 1_000_000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const COMPONENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
// 允许「+」：通道同时断了几段时原因码是组合的（TUNNEL_DOWN+REMOTE_PORT_CLOSED，见 readiness-view 的
// deriveTransportState）。此前不允许，这类最常见的通道故障被 observe 直接丢掉、从来不成事件。
const REASON_CODE_RE = /^[A-Z][A-Z0-9_+-]{0,63}$/;

function sanitizeText(value, maxChars) {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

function scopeOf(serverId) {
  return !serverId || typeof serverId !== "string" ? "global" : serverId.slice(0, 64);
}

function normalizeAgentId(agentId) {
  return typeof agentId === "string" && agentId ? agentId.slice(0, 64) : null;
}

// 组件段：带 agentId 时为 "agent:codex"，否则保持旧格式（只有组件名）。
function componentSegment(component, agentId) {
  const agent = normalizeAgentId(agentId);
  return agent ? `${sanitizeText(component, 32)}:${agent}` : sanitizeText(component, 32);
}

export function buildIncidentFingerprint({ serverId, agentId = null, component, reasonCode } = {}) {
  return `${scopeOf(serverId)}|${componentSegment(component, agentId)}|${sanitizeText(reasonCode, 64)}`;
}

// 成功连击 / 恢复判定的作用域键："scope|component" 或 "scope|component:agentId"。
function buildScopeKey({ serverId, agentId = null, component }) {
  return `${scopeOf(serverId)}|${componentSegment(component, agentId)}`;
}

// 北京自然日键（"YYYY-MM-DD"）：与用量 / 简报 / 隧道稳定性同一口径（lib/usage/time.mjs）。
const dayKeyOfMs = (ms) => dayKeyOf(Math.floor(ms / 1000));
// 能换算成日期的时间戳（Date 的合法范围是 ±8.64e15 ms）。读回的旧文件里可能有损坏的值：
// 超范围的时间戳算不出日期键，按天回溯时会原地打转，所以凡是要落到某一天的地方都先过这一关。
const MAX_DATE_MS = 8.64e15;
const isDateMs = (ms) => Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS;

function medianOf(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// 模块被关闭而结案的事件注记（设置页「监控模块」关掉某个 Agent）。
export const AGENT_MODULE_DISABLED_NOTE = "模块已关闭";

export function createIncidentStore({
  now = Date.now,
  randomUUID = nodeRandomUUID,
  maxActive = INCIDENT_MAX_ACTIVE,
  maxClosed = INCIDENT_MAX_CLOSED,
  maxClosedPerFingerprint = INCIDENT_MAX_CLOSED_PER_FINGERPRINT,
  maxArchived = INCIDENT_MAX_ARCHIVED,
  // 打开门槛策略（测试可注入 {} 关闭门槛 = 首次失败立即打开）。
  openGate = INCIDENT_OPEN_GATE,
  log = () => {},
} = {}) {
  const active = new Map(); // incidentId -> incident（open/resolved 前的活跃索引）
  const closed = new Map(); // incidentId -> incident（resolved，按关闭时间淘汰最旧）
  const successStreaks = new Map(); // 作用域键 "scope|component[:agentId]" -> 连续成功次数
  // 待定候选（未过打开门槛的失败）：fingerprint -> candidate。纯内存、不落盘、不递增修订号。
  const pending = new Map();
  // 候选被成功撤销的时间戳（抖动保护）：fingerprint -> number[]（只保留窗口内）。
  const pendingCancellations = new Map();
  // 删除服务器的事件保留原生命周期和提醒偏好，但完全退出查询/计数/提醒索引。
  const removedServers = new Map(); // serverId -> { removedAt, active: Map, closed: Map }
  let configuredServerIds = null; // 首次权威同步后阻止已删服务器的迟到观测复活事件。
  let pendingPersistenceChange = false;
  // 「指纹 × 北京自然日」计数：fingerprint -> { serverId, agentId, component, reasonCode,
  //   days: Map<dayKey, [发生中条数, 恢复条数]>, evictedBefore, lastResolvedAt, lastSeverity }。
  // evictedBefore：按留存记录回填时已顶到限额——早于这一刻恢复的同类记录已被清理，更早的日子不完整。
  const dayCounts = new Map();
  let dayCountsSince = null; // 逐日计数开始独立记录的时刻（旧文件 = 首次带本功能加载的时刻）
  // 最近一次因类型数封顶淘汰计数条目的时刻：被淘汰的类型再出现时，这之前的逐日计数已丢（只在内存里，
  // 重启后为空——此时退回只用 dayCountsSince 作下限）。
  let lastTypeEvictionAt = null;
  let overflow = { count: 0, lastAt: null };
  // 持久化修订号：revision 覆盖全部持久化状态；urgentRevision 只覆盖需要尽快落盘的
  // 结构性变化；closedRevision 只覆盖顶层已关闭集合（决定是否重写已关闭文件）。
  let revision = 0;
  let urgentRevision = 0;
  let closedRevision = 0;
  const changeListeners = new Set();

  function markChanged({ urgent = true, closedChanged = false } = {}) {
    revision += 1;
    if (urgent) urgentRevision += 1;
    if (closedChanged) closedRevision += 1;
    for (const listener of changeListeners) {
      try { listener(); } catch {}
    }
  }

  function canObserveServer(serverId) {
    if (!serverId) return true;
    return configuredServerIds ? configuredServerIds.has(serverId) : !removedServers.has(serverId);
  }

  function clearServerStreaks(serverId) {
    const prefix = `${serverId}|`;
    for (const key of successStreaks.keys()) if (key.startsWith(prefix)) successStreaks.delete(key);
  }

  // 删除/恢复服务器时一并丢弃它的待定候选与抖动记录（不跨越生命周期边界）。
  function clearServerPending(serverId) {
    const prefix = `${serverId}|`;
    for (const [fingerprint, candidate] of pending) if (candidate.serverId === serverId) pending.delete(fingerprint);
    for (const fingerprint of pendingCancellations.keys()) {
      if (fingerprint.startsWith(prefix)) pendingCancellations.delete(fingerprint);
    }
  }

  function purgeExpiredArchives(at = now()) {
    let purged = 0;
    for (const [serverId, entry] of removedServers) {
      if (entry.removedAt + INCIDENT_SERVER_TRASH_TTL_MS > at) continue;
      purged += entry.active.size + entry.closed.size;
      removedServers.delete(serverId);
    }
    return purged;
  }

  function enforceArchiveBound() {
    let total = [...removedServers.values()].reduce((sum, entry) => sum + entry.active.size + entry.closed.size, 0);
    let purged = 0;
    for (const [serverId, entry] of [...removedServers].sort((a, b) => a[1].removedAt - b[1].removedAt)) {
      if (total <= maxArchived) break;
      for (const pool of [entry.closed, entry.active]) {
        for (const id of pool.keys()) {
          if (total <= maxArchived) break;
          pool.delete(id);
          total -= 1;
          purged += 1;
        }
      }
      if (!entry.active.size && !entry.closed.size) removedServers.delete(serverId);
    }
    if (purged) markChanged({ closedChanged: true });
    if (purged) log(`incident trash capacity reached: discarded ${purged} oldest archived incidents`, {
      level: "warn", event: "incident-trash-overflow", evicted: purged,
    });
    return purged;
  }

  // servers 必须包含 disabled 条目；禁用不等于删除。tombstones 使用注册表的 removedAt，
  // 不从事件同步时间重新开始 7 天。无服务器且无有效删除记录的旧事件已不可恢复。
  function syncServerLifecycle({ servers, tombstones } = {}) {
    if (!Array.isArray(servers) || !Array.isArray(tombstones)) {
      throw new TypeError("server lifecycle requires complete servers and tombstones arrays");
    }
    const validId = (id) => typeof id === "string" && id.length > 0 && id.length <= 64;
    if (servers.some((server) => !validId(server?.id))
      || tombstones.some((item) => !validId(item?.id) || !Number.isFinite(item.removedAt) || item.removedAt < 0)) {
      throw new TypeError("server lifecycle contains invalid server or tombstone entries");
    }
    const at = now();
    const nextIds = new Set(servers.map((server) => server.id));
    const deletions = new Map();
    for (const item of tombstones) {
      if (!item || typeof item.id !== "string" || !Number.isFinite(item.removedAt) || item.removedAt > at || item.removedAt < 0) continue;
      if (item.removedAt + INCIDENT_SERVER_TRASH_TTL_MS <= at || nextIds.has(item.id)) continue;
      deletions.set(item.id, item.removedAt);
    }
    const result = { changed: pendingPersistenceChange, archived: 0, restored: 0, purged: purgeExpiredArchives(at) };
    configuredServerIds = nextIds;
    for (const [serverId, entry] of removedServers) {
      if (nextIds.has(serverId)) {
        for (const [id, incident] of entry.active) active.set(id, incident);
        for (const [id, incident] of entry.closed) closed.set(id, incident);
        result.restored += entry.active.size + entry.closed.size;
        removedServers.delete(serverId);
        clearServerStreaks(serverId);
        clearServerPending(serverId);
      } else if (deletions.get(serverId) !== entry.removedAt) {
        // 删除记录消失/过期或同 id 的另一轮删除，不得复活之前那一轮的事件。
        result.purged += entry.active.size + entry.closed.size;
        removedServers.delete(serverId);
      }
    }
    for (const [kind, pool] of [["active", active], ["closed", closed]]) {
      for (const [id, incident] of pool) {
        const serverId = incident.serverId;
        if (!serverId || nextIds.has(serverId)) continue;
        pool.delete(id);
        clearServerStreaks(serverId);
        if (!deletions.has(serverId)) {
          result.purged += 1;
          continue;
        }
        let archive = removedServers.get(serverId);
        if (!archive) {
          archive = { removedAt: deletions.get(serverId), active: new Map(), closed: new Map() };
          removedServers.set(serverId, archive);
        }
        archive[kind].set(id, incident);
        result.archived += 1;
      }
    }
    // 不保留无事件服务器的成功连击，避免删除之后的旧成功跨越恢复边界。
    for (const key of successStreaks.keys()) {
      const scope = key.split("|", 1)[0];
      if (scope !== "global" && !nextIds.has(scope)) successStreaks.delete(key);
    }
    // 已删服务器的待定候选同样丢弃：迟到的定时转正不能为已删服务器开事件。
    for (const candidate of [...pending.values()]) {
      if (candidate.serverId && !nextIds.has(candidate.serverId)) clearServerPending(candidate.serverId);
    }
    for (const fingerprint of pendingCancellations.keys()) {
      const scope = fingerprint.split("|", 1)[0];
      if (scope !== "global" && !nextIds.has(scope)) pendingCancellations.delete(fingerprint);
    }
    result.purged += enforceArchiveBound();
    enforceActiveBound();
    trimClosed();
    // 逐日计数跟着服务器走：仍在配置里或在回收站里的保留（恢复服务器时汇总原样回来），
    // 既不在配置也不在回收站的（已彻底清除）一并丢弃。
    for (const [fingerprint, entry] of dayCounts) {
      if (!entry.serverId || nextIds.has(entry.serverId) || removedServers.has(entry.serverId)) continue;
      dayCounts.delete(fingerprint);
      result.changed = true;
    }
    result.changed ||= result.archived + result.restored + result.purged > 0;
    pendingPersistenceChange = false;
    if (result.changed) markChanged({ closedChanged: true });
    return result;
  }

  function clampSnooze(durationMs) {
    const n = Number(durationMs);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.trunc(n), INCIDENT_SNOOZE_MAX_MS);
  }

  function makeIncident({ fingerprint, serverId, agentId, component, reasonCode, severity, at, evidence }) {
    return {
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      incidentId: randomUUID(),
      fingerprint,
      serverId: serverId || null,
      agentId: normalizeAgentId(agentId),
      component,
      reasonCode,
      severity,
      lifecycle: "open",
      firstSeenAt: at,
      lastSeenAt: at,
      resolvedAt: null,
      occurrences: 1,
      evidenceRefs: evidence ? [evidence] : [],
      relatedOperationIds: [],
      relatedIncidentIds: [],
      // 处置记录（disposition.mjs）：处置操作受理时追加，恢复 / 复核到时给出结果。
      dispositions: [],
      attention: { acknowledgedAt: null, snoozedUntil: null, snoozeReason: null },
      notes: [],
    };
  }

  // ---- 「指纹 × 北京自然日」计数 ----

  function dayCountMinKey(at = now()) {
    return offsetDay(dayKeyOfMs(at), -(INCIDENT_DAY_COUNT_RETENTION_DAYS - 1));
  }

  // 丢掉保留期之外的日子；一天都不剩的指纹整条删除。
  function pruneDayCounts(at = now()) {
    const minKey = dayCountMinKey(at);
    for (const [fingerprint, entry] of dayCounts) {
      for (const key of [...entry.days.keys()]) if (key < minKey) entry.days.delete(key);
      if (!entry.days.size) dayCounts.delete(fingerprint);
    }
  }

  // 一条已恢复事件记进一组逐日格子：从首见那天到恢复那天，每天「发生中」+1；恢复那天「恢复」+1。
  // 跨多天的持续型事件（磁盘超阈值）因此每天都有一格，而次数只算一次。minKey 之前的日子不记。
  function addResolvedToDays(days, incident, minKey) {
    const end = incident.resolvedAt;
    if (!isDateMs(end)) return;
    const endKey = dayKeyOfMs(end);
    const startKey = dayKeyOfMs(isDateMs(incident.firstSeenAt) ? Math.min(incident.firstSeenAt, end) : end);
    // 最多回溯保留期那么多天：再长的事件、再离谱的时间戳都到此为止。
    let key = endKey;
    for (let step = 0; step < INCIDENT_DAY_COUNT_RETENTION_DAYS && key >= minKey && key >= startKey; step += 1) {
      const cell = days.get(key) || [0, 0];
      cell[0] += 1;
      if (key === endKey) cell[1] += 1;
      days.set(key, cell);
      key = offsetDay(key, -1);
    }
  }

  // 留存记录的覆盖边界：早于这一刻恢复的同类事件可能已被限额清理（两个限额都没顶到时为 null）。
  // retained = 该指纹留存的已恢复记录。指纹限额淘汰的是该指纹最旧的，全局上限淘汰的是全池最旧的，
  // 所以边界取两者里较晚的那个。
  function retentionBoundary(retained) {
    let boundary = null;
    if (retained.length >= maxClosedPerFingerprint) {
      boundary = Math.min(...retained.map((incident) => incident.resolvedAt));
    }
    if (closed.size >= maxClosed) {
      let oldest = Infinity;
      for (const incident of closed.values()) if (incident.resolvedAt < oldest) oldest = incident.resolvedAt;
      if (Number.isFinite(oldest) && (boundary == null || oldest > boundary)) boundary = oldest;
    }
    return isDateMs(boundary) ? boundary : null;
  }

  function noteResolved(entry, incident, minKey) {
    if (!isDateMs(incident.resolvedAt)) return;
    addResolvedToDays(entry.days, incident, minKey);
    if (entry.lastResolvedAt == null || incident.resolvedAt >= entry.lastResolvedAt) {
      entry.lastResolvedAt = incident.resolvedAt;
      entry.lastSeverity = incident.severity;
    }
  }

  // 新建一个指纹的计数条目，并按它留存的已恢复记录回填（旧文件没有计数；或条目被指纹数上限淘汰后
  // 这一类再次出现）。回填只是下限：留存数顶到限额时记下边界，汇总时边界之前的日子标成「记录已清理」。
  // runtime = 运行中这一类首次恢复时新建（而不是加载时按留存记录回填）。加载时每个留存指纹都已建好条目，
  // 所以运行中才建条目的只有两种：全新的类型（没有任何更早的记录可缺）、或曾被类型数封顶淘汰过的类型
  // （淘汰那一刻之前的逐日计数丢了）。闲置超过保留期被清掉的类型，丢的都在窗口之外，不算缺。
  // 不能沿用 retentionBoundary 的全局池判断：池顶满是长期运行的常态，新类型会被误标「N+ / 记录已清理」。
  function createDayCountEntry(sample, retained, at, { runtime = false } = {}) {
    let evictedBefore = retentionBoundary(retained);
    if (runtime) {
      evictedBefore = evictedBefore != null && isDateMs(lastTypeEvictionAt) ? Math.min(evictedBefore, lastTypeEvictionAt) : null;
    }
    const entry = {
      serverId: sample.serverId || null,
      agentId: normalizeAgentId(sample.agentId),
      component: sample.component,
      reasonCode: sample.reasonCode,
      days: new Map(),
      evictedBefore,
      lastResolvedAt: null,
      lastSeverity: null,
    };
    const minKey = dayCountMinKey(at);
    for (const incident of retained) noteResolved(entry, incident, minKey);
    return entry;
  }

  // 指纹数封顶：先清过期的，再淘汰最久没有恢复记录的。被淘汰的指纹不丢正确性——汇总时没有条目的
  // 指纹按留存记录现算；它再次出现时条目按留存记录重建。
  function makeRoomForDayCount(at) {
    if (dayCounts.size < INCIDENT_DAY_COUNT_MAX_TYPES) return;
    pruneDayCounts(at);
    while (dayCounts.size >= INCIDENT_DAY_COUNT_MAX_TYPES) {
      let stalest = null;
      for (const [fingerprint, entry] of dayCounts) {
        if (!stalest || (entry.lastResolvedAt ?? 0) < stalest.at) stalest = { fingerprint, at: entry.lastResolvedAt ?? 0 };
      }
      dayCounts.delete(stalest.fingerprint);
      lastTypeEvictionAt = at;
    }
  }

  // 事件恢复时记一笔。必须在事件放进 closed 之前调用：新建条目要按「此前」留存的记录回填，
  // 正在恢复的这一条不能算两次。
  function recordResolvedDays(incident) {
    const at = now();
    let entry = dayCounts.get(incident.fingerprint);
    if (!entry) {
      makeRoomForDayCount(at);
      const retained = [...closed.values()]
        .filter((item) => item.fingerprint === incident.fingerprint && isDateMs(item.resolvedAt));
      entry = createDayCountEntry(incident, retained, at, { runtime: true });
      dayCounts.set(incident.fingerprint, entry);
    }
    noteResolved(entry, incident, dayCountMinKey(at));
    if (dayCountsSince == null) dayCountsSince = at;
  }

  // 旧文件没有逐日计数：按还留着的已恢复记录逐个指纹回填（含回收站里的服务器——恢复时汇总要对得上）。
  // 指纹多于上限时优先保留最近有恢复记录的。返回是否回填出了内容（有内容才值得尽快落盘）。
  function backfillDayCounts() {
    dayCounts.clear();
    const at = now();
    dayCountsSince = at;
    const groups = new Map();
    for (const pool of [closed, ...[...removedServers.values()].map((entry) => entry.closed)]) {
      for (const incident of pool.values()) {
        if (!isDateMs(incident.resolvedAt)) continue;
        const list = groups.get(incident.fingerprint);
        if (list) list.push(incident);
        else groups.set(incident.fingerprint, [incident]);
      }
    }
    const entries = [];
    for (const [fingerprint, retained] of groups) {
      const entry = createDayCountEntry(retained[0], retained, at);
      if (entry.days.size) entries.push([fingerprint, entry]);
    }
    entries.sort((a, b) => b[1].lastResolvedAt - a[1].lastResolvedAt);
    for (const [fingerprint, entry] of entries.slice(0, INCIDENT_DAY_COUNT_MAX_TYPES)) dayCounts.set(fingerprint, entry);
    return dayCounts.size > 0;
  }

  // 持久化形状：{ v, since, types: [{ serverId, agentId, component, reasonCode, evictedBefore,
  //   lastResolvedAt, lastSeverity, days: { "YYYY-MM-DD": [发生中, 恢复] } }] }
  function serializeDayCounts() {
    pruneDayCounts();
    return {
      v: INCIDENT_DAY_COUNT_SCHEMA_VERSION,
      since: dayCountsSince,
      types: [...dayCounts.values()].map((entry) => ({
        serverId: entry.serverId,
        agentId: entry.agentId,
        component: entry.component,
        reasonCode: entry.reasonCode,
        evictedBefore: entry.evictedBefore,
        lastResolvedAt: entry.lastResolvedAt,
        lastSeverity: entry.lastSeverity,
        days: Object.fromEntries(entry.days),
      })),
    };
  }

  // 读回持久化的计数；形状不对（旧文件没有这个字段 / 损坏）返回 false，由调用方回填。
  // 单个指纹或单个日子畸形时逐条跳过，不抛错。
  function restoreDayCounts(raw) {
    if (!raw || typeof raw !== "object" || raw.v !== INCIDENT_DAY_COUNT_SCHEMA_VERSION || !Array.isArray(raw.types)) return false;
    dayCounts.clear();
    const timestamp = (value) => (isDateMs(value) && value >= 0 ? value : null);
    const cellValue = (value) => (Number.isFinite(value) && value > 0 ? Math.min(Math.trunc(value), DAY_COUNT_CELL_MAX) : 0);
    dayCountsSince = timestamp(raw.since);
    for (const item of raw.types.slice(0, INCIDENT_DAY_COUNT_MAX_TYPES)) {
      if (!item || typeof item !== "object" || !item.days || typeof item.days !== "object") continue;
      if (!COMPONENT_RE.test(String(item.component || "")) || !REASON_CODE_RE.test(String(item.reasonCode || ""))) continue;
      const serverId = typeof item.serverId === "string" && item.serverId ? item.serverId.slice(0, 64) : null;
      const agentId = normalizeAgentId(item.agentId);
      const days = new Map();
      for (const [key, cell] of Object.entries(item.days).slice(0, INCIDENT_DAY_COUNT_RETENTION_DAYS * 2)) {
        if (!DAY_KEY_RE.test(key) || !Array.isArray(cell)) continue;
        const activeCount = cellValue(cell[0]);
        if (activeCount > 0) days.set(key, [activeCount, Math.min(cellValue(cell[1]), activeCount)]);
      }
      if (!days.size) continue;
      dayCounts.set(buildIncidentFingerprint({ serverId, agentId, component: item.component, reasonCode: item.reasonCode }), {
        serverId,
        agentId,
        component: item.component,
        reasonCode: item.reasonCode,
        days,
        evictedBefore: timestamp(item.evictedBefore),
        lastResolvedAt: timestamp(item.lastResolvedAt),
        lastSeverity: INCIDENT_SEVERITIES.includes(item.lastSeverity) ? item.lastSeverity : null,
      });
    }
    pruneDayCounts();
    return true;
  }

  // 先按指纹限额（刷屏指纹只淘汰自己最旧的），再按全局上限淘汰最旧。
  function trimClosed() {
    let evicted = 0;
    const byFingerprint = new Map();
    for (const incident of closed.values()) {
      const list = byFingerprint.get(incident.fingerprint);
      if (list) list.push(incident);
      else byFingerprint.set(incident.fingerprint, [incident]);
    }
    for (const list of byFingerprint.values()) {
      if (list.length <= maxClosedPerFingerprint) continue;
      list.sort((a, b) => a.resolvedAt - b.resolvedAt);
      for (const incident of list.slice(0, list.length - maxClosedPerFingerprint)) {
        closed.delete(incident.incidentId);
        evicted += 1;
      }
    }
    if (closed.size > maxClosed) {
      // 一次排序淘汰全部超额（读回两份来源时可能一次超出数百条）。
      const oldestFirst = [...closed.values()].sort((a, b) => a.resolvedAt - b.resolvedAt);
      for (const incident of oldestFirst.slice(0, closed.size - maxClosed)) {
        closed.delete(incident.incidentId);
        evicted += 1;
      }
    }
    if (evicted) markChanged({ closedChanged: true });
  }

  function enforceActiveBound() {
    if (active.size <= maxActive) return;
    // 溢出：最久未更新的活跃事件合并进溢出摘要（不丢进行中的修复状态——
    // 它们的指纹随下一次真实观测自然重建）。
    const entries = [...active.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    const evictCount = active.size - maxActive;
    for (const incident of entries.slice(0, evictCount)) {
      active.delete(incident.incidentId);
    }
    overflow = { count: overflow.count + evictCount, lastAt: now() };
    markChanged();
    log(`incident store overflow: merged ${evictCount} oldest active incidents into summary (total ${overflow.count})`, {
      level: "warn",
      event: "incident-overflow",
      evicted: evictCount,
    });
  }

  // ---- 打开门槛（待定候选）----

  function gateFor(component) {
    const gate = openGate && Object.hasOwn(openGate, component) ? openGate[component] : null;
    if (!gate) return null;
    const hasMs = Number.isFinite(gate.minMs) && gate.minMs > 0;
    const hasCount = Number.isFinite(gate.minCount) && gate.minCount > 1;
    return hasMs || hasCount ? { minMs: hasMs ? gate.minMs : null, minCount: hasCount ? gate.minCount : null } : null;
  }

  function gateSatisfied(gate, candidate, at) {
    if (!gate) return true;
    if (gate.minMs != null && at - candidate.firstAt >= gate.minMs) return true;
    return gate.minCount != null && candidate.count >= gate.minCount;
  }

  function pushEvidence(target, evidence) {
    if (!evidence) return;
    target.push(evidence);
    if (target.length > INCIDENT_EVIDENCE_MAX) target.shift();
  }

  // 窗口内的撤销次数（顺带清掉过期记录，保持有界）。
  function recentCancellations(fingerprint, at) {
    const list = pendingCancellations.get(fingerprint);
    if (!list) return 0;
    const kept = list.filter((ts) => at - ts < INCIDENT_FLAP_WINDOW_MS);
    if (kept.length) pendingCancellations.set(fingerprint, kept);
    else pendingCancellations.delete(fingerprint);
    return kept.length;
  }

  function recordCancellation(fingerprint, at) {
    const list = pendingCancellations.get(fingerprint) || [];
    list.push(at);
    if (list.length > INCIDENT_FLAP_THRESHOLD * 4) list.shift();
    pendingCancellations.set(fingerprint, list);
  }

  // 真正打开一个事件：恢复后重现时关联最近一次同指纹的已关闭事件。
  function openIncident(fields, { firstAt, lastAt, occurrences = 1, evidenceRefs = null, note = null } = {}) {
    const incident = makeIncident({ ...fields, at: firstAt });
    incident.lastSeenAt = lastAt ?? firstAt;
    incident.occurrences = occurrences;
    if (evidenceRefs) incident.evidenceRefs = evidenceRefs.slice(-INCIDENT_EVIDENCE_MAX);
    if (note) incident.notes.push({ at: incident.lastSeenAt, text: note });
    const previous = [...closed.values()]
      .filter((item) => item.fingerprint === fields.fingerprint)
      .sort((a, b) => b.resolvedAt - a.resolvedAt)[0];
    if (previous) incident.relatedIncidentIds = [previous.incidentId];
    active.set(incident.incidentId, incident);
    markChanged();
    enforceActiveBound();
    return incident;
  }

  // 候选转正：firstSeenAt / 次数 / 证据 / 最高严重度沿用候选。
  function promote(candidate) {
    pending.delete(candidate.fingerprint);
    const { firstAt, lastAt, count, evidenceRefs, ...fields } = candidate;
    return openIncident(fields, { firstAt, lastAt, occurrences: count, evidenceRefs });
  }

  // 无新观测时按时间推动转正（调用方定时调用）；已删服务器的候选直接丢弃。
  function promotePending(at) {
    const ts = Number.isFinite(at) ? Math.trunc(at) : now();
    const promoted = [];
    for (const candidate of [...pending.values()]) {
      if (!canObserveServer(candidate.serverId)) {
        pending.delete(candidate.fingerprint);
        continue;
      }
      const gate = gateFor(candidate.component);
      if (gateSatisfied(gate, candidate, ts)) {
        promoted.push(promote(candidate));
      } else if (gate.minMs == null && ts - candidate.lastAt >= INCIDENT_FLAP_WINDOW_MS) {
        // 纯计数门槛且长期没有新失败：候选作废（不让它永远挂在内存里）。
        pending.delete(candidate.fingerprint);
      }
    }
    for (const fingerprint of [...pendingCancellations.keys()]) recentCancellations(fingerprint, ts);
    return promoted;
  }

  // ---- 失败事实：合并或新建 ----

  // 返回：合并/新建的事件；被拒绝（非法输入 / 已删服务器）或仍在待定候选阶段时返回 null。
  function observe({ serverId, agentId = null, component, reasonCode, severity = "warn", evidence = null, at } = {}) {
    if (!canObserveServer(serverId)) return null;
    const ts = Number.isFinite(at) ? Math.trunc(at) : now();
    if (!COMPONENT_RE.test(String(component || ""))) return null;
    if (!REASON_CODE_RE.test(String(reasonCode || ""))) return null;
    const sev = INCIDENT_SEVERITIES.includes(severity) ? severity : "warn";
    const agent = normalizeAgentId(agentId);
    // 任何失败采样都打断该上下文组件（及该 agent）的恢复成功连击。
    breakStreaks({ serverId, component, agentId: agent });
    const fingerprint = buildIncidentFingerprint({ serverId, agentId: agent, component, reasonCode });
    const existing = [...active.values()].find((incident) => incident.fingerprint === fingerprint && incident.lifecycle === "open");
    if (existing) {
      let upgraded = false;
      existing.occurrences += 1;
      existing.lastSeenAt = ts;
      pushEvidence(existing.evidenceRefs, evidence);
      if (SEVERITY_RANK[sev] > SEVERITY_RANK[existing.severity]) {
        upgraded = true;
        existing.severity = sev;
        if (existing.attention.snoozedUntil != null) {
          existing.attention.snoozedUntil = null;
          existing.attention.snoozeReason = null;
          existing.notes.push({ at: ts, text: `severity upgraded to ${sev}, snooze cleared` });
        }
      }
      // 旧版本确认的磁盘事件没记确认时用量：以升级后第一次采样为基准（否则永远不会重新提醒）。
      if (existing.reasonCode === "DISK_THRESHOLD" && existing.attention.acknowledgedAt != null
        && !Number.isFinite(existing.attention.acknowledgedUsedPct) && Number.isFinite(evidence?.usedPct)) {
        existing.attention.acknowledgedUsedPct = evidence.usedPct;
        upgraded = true;
      }
      const ackPct = existing.attention.acknowledgedUsedPct;
      if (existing.attention.acknowledgedAt != null && Number.isFinite(ackPct)
        && Number.isFinite(evidence?.usedPct) && evidence.usedPct >= ackPct + DISK_REARM_DELTA) {
        upgraded = true; // 重新提醒是结构性变化，尽快落盘
        clearAcknowledgement(existing);
        existing.notes.push({ at: ts, text: `disk usage rose to ${evidence.usedPct}% (acknowledged at ${ackPct}%), acknowledgement cleared` });
      }
      // 纯次数/lastSeenAt/证据累加走长去抖；升级是结构性变化需尽快落盘。
      markChanged({ urgent: upgraded });
      enforceActiveBound();
      return existing;
    }
    const fields = { fingerprint, serverId: serverId || null, agentId: agent, component, reasonCode };
    const gate = gateFor(component);
    if (!gate) return openIncident({ ...fields, severity: sev, evidence }, { firstAt: ts });
    let candidate = pending.get(fingerprint);
    if (!candidate) {
      // 抖动：窗口内多次"失败后很快恢复"——不再等门槛，直接打开并注明（消耗掉这批撤销记录）。
      const flaps = recentCancellations(fingerprint, ts);
      if (flaps >= INCIDENT_FLAP_THRESHOLD) {
        pendingCancellations.delete(fingerprint);
        return openIncident({ ...fields, severity: sev, evidence }, {
          firstAt: ts,
          note: `flapping: ${flaps} short failures in ${Math.round(INCIDENT_FLAP_WINDOW_MS / 60000)}min`,
        });
      }
      candidate = { ...fields, severity: sev, firstAt: ts, lastAt: ts, count: 0, evidenceRefs: [] };
      pending.set(fingerprint, candidate);
    }
    candidate.count += 1;
    candidate.lastAt = Math.max(candidate.lastAt, ts);
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[candidate.severity]) candidate.severity = sev;
    pushEvidence(candidate.evidenceRefs, evidence);
    return gateSatisfied(gate, candidate, candidate.lastAt) ? promote(candidate) : null;
  }

  // ---- 成功 / 未知采样：恢复判定 ----

  // 失败/未知打断连击：带 agentId 时打断该 agent 与组件整体的连击；不带时打断组件整体
  // 及其下全部 agent 的连击。
  function breakStreaks({ serverId, component, agentId = null }) {
    const base = buildScopeKey({ serverId, component });
    successStreaks.delete(base);
    if (agentId) {
      successStreaks.delete(buildScopeKey({ serverId, component, agentId }));
      return;
    }
    for (const key of successStreaks.keys()) if (key.startsWith(`${base}:`)) successStreaks.delete(key);
  }

  function bumpStreak(scopeKey) {
    const next = (successStreaks.get(scopeKey) || 0) + 1;
    successStreaks.set(scopeKey, next);
    return next;
  }

  function resolveIncident(incident, at) {
    incident.lifecycle = "resolved";
    incident.resolvedAt = at;
    active.delete(incident.incidentId);
    // 逐日计数与已关闭池同一时刻变化、随已关闭文件一起落盘；要在放进 closed 之前记（见 recordResolvedDays）。
    recordResolvedDays(incident);
    // 处置闭环：等待复核的处置记「恢复」，已判未恢复的改记「之后才恢复」。
    const settled = settleOnRecovery(incident.dispositions, at);
    if (settled.changed) incident.dispositions = settled.list;
    closed.set(incident.incidentId, incident);
    markChanged({ closedChanged: true });
    trimClosed();
  }

  // 一次成功即撤销待定候选（还没转正的短暂失败已自愈）；连续 RECOVERY_SUCCESS_STREAK 次成功
  // 才关闭已打开的事件。候选只要一次：非活跃服务器的恢复采样 60s 一拍，等满两次（约 120s）
  // 会与隧道 120s 的转正门槛撞车，已恢复的短暂断开照样被转正。反复撤销由抖动规则兜底。
  // 带 agentId：连击按该 agent 计、只关闭/撤销该 agent 的；不带：按"上下文 + 组件"整体判定。
  function reportSuccess({ serverId, agentId = null, component, evidence = null, at } = {}) {
    if (!canObserveServer(serverId)) return [];
    const ts = Number.isFinite(at) ? Math.trunc(at) : now();
    if (!COMPONENT_RE.test(String(component || ""))) return [];
    const agent = normalizeAgentId(agentId);
    const scopeKey = buildScopeKey({ serverId, component, agentId: agent });
    const streak = bumpStreak(scopeKey);
    const inScope = (item) => item.component === component
      && (item.serverId || null) === (serverId || null)
      && (!agent || normalizeAgentId(item.agentId) === agent);
    for (const candidate of [...pending.values()]) {
      if (!inScope(candidate)) continue;
      pending.delete(candidate.fingerprint);
      recordCancellation(candidate.fingerprint, ts);
    }
    if (streak < RECOVERY_SUCCESS_STREAK) return [];
    successStreaks.delete(scopeKey);
    const resolved = [...active.values()].filter((incident) => incident.lifecycle === "open" && inScope(incident));
    for (const incident of resolved) {
      pushEvidence(incident.evidenceRefs, evidence);
      incident.notes.push({ at: ts, text: `resolved after ${RECOVERY_SUCCESS_STREAK} consecutive successes` });
      resolveIncident(incident, ts);
    }
    return resolved;
  }

  // unknown/超时：不是成功采样——打断连击（不中断"连续"语义），但不是失败事件。
  // v2.47 模块开关：设置页关掉的 Agent 不再有检测，其未结事件永远等不到恢复采样——
  // 直接关闭并注明「模块已关闭」；同时丢弃它的待定候选与成功连击（不跨越开关边界）。
  // 重新打开后的新失败按正常门槛另开新事件。
  function closeAgentIncidents({ agentIds, at } = {}) {
    const targets = new Set((Array.isArray(agentIds) ? agentIds : []).map(normalizeAgentId).filter(Boolean));
    if (!targets.size) return [];
    const ts = Number.isFinite(at) ? Math.trunc(at) : now();
    const ofTarget = (item) => item.component === "agent" && targets.has(normalizeAgentId(item.agentId));
    for (const candidate of [...pending.values()]) {
      if (ofTarget(candidate)) pending.delete(candidate.fingerprint);
    }
    for (const key of successStreaks.keys()) {
      const segment = key.split("|")[1] || "";
      if (segment.startsWith("agent:") && targets.has(segment.slice("agent:".length))) successStreaks.delete(key);
    }
    const resolved = [...active.values()].filter((incident) => incident.lifecycle === "open" && ofTarget(incident));
    for (const incident of resolved) {
      incident.notes.push({ at: ts, text: AGENT_MODULE_DISABLED_NOTE });
      resolveIncident(incident, ts);
    }
    return resolved;
  }

  function reportUnknown({ serverId, agentId = null, component } = {}) {
    if (!COMPONENT_RE.test(String(component || ""))) return;
    breakStreaks({ serverId, component, agentId: normalizeAgentId(agentId) });
  }

  // ---- 磁盘阈值（迟滞）----

  function observeDiskUsage({ serverId, usedPct, at } = {}) {
    const pct = Number(usedPct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
    if (pct >= DISK_OPEN_PCT) {
      return observe({
        serverId,
        component: "filesystem",
        reasonCode: "DISK_THRESHOLD",
        severity: pct >= 95 ? "error" : "warn",
        evidence: { kind: "disk-usage", usedPct: Math.round(pct), at: Number.isFinite(at) ? at : now() },
        at,
      });
    }
    if (pct < DISK_CLOSE_PCT) {
      return reportSuccess({ serverId, component: "filesystem", at });
    }
    // 88–89：中性带——不计恢复也不打断既有连击。
    return null;
  }

  // ---- 注意力（个人提醒偏好；不改变故障事实）----

  function requireOpen(incidentId) {
    const incident = active.get(String(incidentId || ""));
    if (incident?.lifecycle !== "open") {
      throw new Error(`incident not found or not open: ${String(incidentId)}`);
    }
    return incident;
  }

  function clearAcknowledgement(incident) {
    incident.attention.acknowledgedAt = null;
    delete incident.attention.acknowledgedUsedPct;
  }

  // 最近一次磁盘用量证据（%）；没有则 null。
  function latestDiskPct(incident) {
    for (let i = incident.evidenceRefs.length - 1; i >= 0; i -= 1) {
      const ev = incident.evidenceRefs[i];
      if (ev?.kind === "disk-usage" && Number.isFinite(ev.usedPct)) return ev.usedPct;
    }
    return null;
  }

  function acknowledge(incidentId) {
    const incident = requireOpen(incidentId);
    incident.attention.acknowledgedAt = now();
    if (incident.reasonCode === "DISK_THRESHOLD") {
      const pct = latestDiskPct(incident);
      if (pct != null) incident.attention.acknowledgedUsedPct = pct;
    }
    markChanged();
    return incident;
  }

  function snooze(incidentId, durationMs) {
    const incident = requireOpen(incidentId);
    const duration = clampSnooze(durationMs);
    if (duration <= 0) throw new Error("snooze durationMs must be positive");
    incident.attention.snoozedUntil = now() + duration;
    incident.attention.snoozeReason = `snoozed ${Math.round(duration / 60000)}min`;
    markChanged();
    return incident;
  }

  function unsnooze(incidentId) {
    const incident = requireOpen(incidentId);
    incident.attention.snoozedUntil = null;
    incident.attention.snoozeReason = null;
    markChanged();
    return incident;
  }

  // 关联一次操作（单隧道重启等）：供事件详情跳转。disposition（可选）：{ action, trigger }——
  // 同时记一条处置记录（受理时刻 = now()），恢复或复核到时给出结果（disposition.mjs）。
  function linkOperation(incidentId, operationId, disposition = null) {
    const incident = requireOpen(incidentId);
    const id = sanitizeText(operationId, 64);
    if (!id) return incident;
    let changed = false;
    if (!incident.relatedOperationIds.includes(id)) {
      incident.relatedOperationIds.push(id);
      if (incident.relatedOperationIds.length > 8) incident.relatedOperationIds.shift();
      changed = true;
    }
    if (disposition && typeof disposition === "object") {
      const next = addDisposition(incident.dispositions, { ...disposition, operationId: id, at: now() });
      if (next !== incident.dispositions) {
        incident.dispositions = next;
        changed = true;
      }
    }
    if (changed) markChanged();
    return incident;
  }

  // 处置复核到时（调用方定时调用）：受理满时限仍未恢复的处置记「未恢复」。返回改动的事件。
  function verifyDispositions(at) {
    const ts = Number.isFinite(at) ? Math.trunc(at) : now();
    const touched = [];
    for (const incident of active.values()) {
      if (incident.lifecycle !== "open" || !hasPendingDisposition(incident.dispositions)) continue;
      const expired = expireDispositions(incident.dispositions, ts);
      if (!expired.changed) continue;
      incident.dispositions = expired.list;
      touched.push(incident);
    }
    if (touched.length) markChanged();
    return touched;
  }

  // ---- 查询 ----

  function serialize(incident) {
    const { fingerprint, schemaVersion, ...rest } = incident;
    void fingerprint;
    void schemaVersion;
    return rest;
  }

  // fingerprint：只看某一类（summarize() 每个类型的 key）；每类最多留存 50 条，一页就能取全。
  function query({ state = "open", serverId, fingerprint, limit = 50, cursor } = {}) {
    const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    let pool = state === "resolved" ? [...closed.values()] : [...active.values()];
    if (serverId) pool = pool.filter((incident) => incident.serverId === serverId);
    if (fingerprint) pool = pool.filter((incident) => incident.fingerprint === fingerprint);
    pool.sort((a, b) => (b.lastSeenAt - a.lastSeenAt) || (a.incidentId < b.incidentId ? -1 : 1));
    let startIndex = 0;
    if (cursor) {
      const [cursorTs, cursorId] = String(cursor).split("|");
      const ts = Number(cursorTs);
      const idx = pool.findIndex((incident) => incident.lastSeenAt < ts || (incident.lastSeenAt === ts && incident.incidentId > cursorId));
      startIndex = idx === -1 ? pool.length : idx;
    }
    const page = pool.slice(startIndex, startIndex + cappedLimit);
    const last = page.at(-1);
    return {
      state: state === "resolved" ? "resolved" : "open",
      total: pool.length,
      incidents: page.map(serialize),
      nextCursor: page.length < cappedLimit || !last ? null : `${last.lastSeenAt}|${last.incidentId}`,
      overflow: state === "open" ? { ...overflow } : { count: 0, lastAt: null },
    };
  }

  // 某一状态的全部事件（不分页，序列化形状同 query）：事件簇与前后经过要看整个池子。
  // 活跃 ≤500、已关闭 ≤1000，一次拷贝的代价有界。
  function list({ state = "open", serverId } = {}) {
    let pool = state === "resolved" ? [...closed.values()] : [...active.values()];
    if (serverId) pool = pool.filter((incident) => incident.serverId === serverId);
    return pool.map(serialize);
  }

  // 按 id 取一条（未解决或已恢复）；已删服务器的归档不在其中。
  function get(incidentId) {
    const id = String(incidentId || "");
    const incident = active.get(id) || closed.get(id);
    return incident ? serialize(incident) : null;
  }

  function counts() {
    const bySeverity = { info: 0, warn: 0, error: 0 };
    let attention = 0;
    for (const incident of active.values()) {
      bySeverity[incident.severity] += 1;
      if (incident.attention.snoozedUntil == null) attention += 1;
    }
    return { open: active.size, resolved: closed.size, bySeverity, attention, overflow: { ...overflow } };
  }

  // 已恢复事件按类型（指纹）汇总。窗口 = 含今天在内的最近 days 个北京自然日（1–31，缺省 / 非法时 14）。
  // 列出所有还有留存记录、或最近 31 天内有计数的类型（窗口内没发生过的次数为 0），按最近一次发生倒序；
  // 已删除（在回收站里）的服务器不出现。返回：
  //   { schemaVersion, generatedAt, days: [dayKey 旧→新], countingSince, keepPerType, retained, total, capped,
  //     types: [{ key, serverId, agentId, component, reasonCode, severity,
  //               count, capped, coverageStart, perDay: [与 days 一一对应],
  //               lastSeenAt, lastResolvedAt, medianMs, longestMs, samples, retained,
  //               recent: [{ incidentId, firstSeenAt, lastSeenAt, resolvedAt, occurrences, operationId }] }] }
  //   count          窗口内恢复的条数（来自逐日计数，不受每类 50 条留存限额影响）
  //   perDay         每天处于发生中的条数（跨天的持续型事件每天都算）
  //   coverageStart  null = 窗口内每一天都完整；否则是一个日期：它之前的日子记录已被限额清理（不是没发生），
  //                  它当天只留下一部分。此时 capped 为 true，count / perDay 只是下限。
  //   lastSeenAt / medianMs / longestMs / samples / recent   来自这一类留存的逐条记录（最多 keepPerType 条）
  //   retained       留存的逐条记录数（顶层 = 全部，等于 query({ state: "resolved" }).total）
  //   key            指纹，可传给 query({ fingerprint }) 取这一类留存的全部逐条记录
  function summarize({ days = INCIDENT_SUMMARY_DEFAULT_DAYS } = {}) {
    const at = now();
    const requested = Math.trunc(Number(days));
    const span = Number.isFinite(requested) && requested >= 1
      ? Math.min(requested, INCIDENT_DAY_COUNT_RETENTION_DAYS)
      : INCIDENT_SUMMARY_DEFAULT_DAYS;
    const today = dayKeyOfMs(at);
    const dayKeys = Array.from({ length: span }, (_, index) => offsetDay(today, index - (span - 1)));
    const minKey = dayKeys[0];
    pruneDayCounts(at);
    const retainedBy = new Map();
    for (const incident of closed.values()) {
      if (!isDateMs(incident.resolvedAt)) continue;
      const list = retainedBy.get(incident.fingerprint);
      if (list) list.push(incident);
      else retainedBy.set(incident.fingerprint, [incident]);
    }
    const types = [];
    for (const fingerprint of new Set([...dayCounts.keys(), ...retainedBy.keys()])) {
      const entry = dayCounts.get(fingerprint) || null;
      const retained = (retainedBy.get(fingerprint) || [])
        .sort((a, b) => (b.resolvedAt - a.resolvedAt) || (a.incidentId < b.incidentId ? -1 : 1));
      const base = entry || retained[0];
      if (base.serverId && !canObserveServer(base.serverId)) continue;
      // 没有计数条目（指纹数顶到上限被淘汰）时按留存记录现算，覆盖边界同样如实给出。
      let cells = entry?.days;
      if (!cells) {
        cells = new Map();
        for (const incident of retained) addResolvedToDays(cells, incident, minKey);
      }
      const boundary = entry ? entry.evictedBefore : retentionBoundary(retained);
      const boundaryKey = boundary == null ? null : dayKeyOfMs(boundary);
      const coverageStart = boundaryKey != null && boundaryKey >= minKey ? boundaryKey : null;
      const durations = retained
        .filter((incident) => Number.isFinite(incident.firstSeenAt))
        .map((incident) => Math.max(0, incident.resolvedAt - incident.firstSeenAt));
      let severity = retained.length ? "info" : entry.lastSeverity || "warn";
      for (const incident of retained) if (SEVERITY_RANK[incident.severity] > SEVERITY_RANK[severity]) severity = incident.severity;
      types.push({
        key: fingerprint,
        serverId: base.serverId || null,
        agentId: normalizeAgentId(base.agentId),
        component: base.component,
        reasonCode: base.reasonCode,
        severity,
        count: dayKeys.reduce((sum, key) => sum + (cells.get(key)?.[1] ?? 0), 0),
        capped: coverageStart != null,
        coverageStart,
        perDay: dayKeys.map((key) => cells.get(key)?.[0] ?? 0),
        lastSeenAt: retained.length
          ? Math.max(...retained.map((incident) => (Number.isFinite(incident.lastSeenAt) ? incident.lastSeenAt : incident.resolvedAt)))
          : entry.lastResolvedAt,
        lastResolvedAt: retained.length ? retained[0].resolvedAt : entry.lastResolvedAt,
        medianMs: medianOf(durations),
        longestMs: durations.length ? Math.max(...durations) : null,
        samples: durations.length,
        retained: retained.length,
        recent: retained.slice(0, INCIDENT_SUMMARY_RECENT_MAX).map((incident) => ({
          incidentId: incident.incidentId,
          firstSeenAt: incident.firstSeenAt,
          lastSeenAt: incident.lastSeenAt,
          resolvedAt: incident.resolvedAt,
          occurrences: incident.occurrences,
          operationId: incident.relatedOperationIds.at(-1) ?? null,
        })),
      });
    }
    types.sort((a, b) => ((b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)) || (a.key < b.key ? -1 : 1));
    return {
      schemaVersion: INCIDENT_DAY_COUNT_SCHEMA_VERSION,
      generatedAt: at,
      days: dayKeys,
      countingSince: dayCountsSince,
      keepPerType: maxClosedPerFingerprint,
      retained: closed.size,
      total: types.reduce((sum, type) => sum + type.count, 0),
      capped: types.some((type) => type.capped),
      types,
    };
  }

  // ---- 持久化（当前状态原子保存；损坏/超限降级为空）----

  // includeClosed=false：拆分模式的主文件（活跃 + 删除服务器归档 + 溢出摘要），
  // 顶层已关闭事件改存独立文件；closedSplit 标记告诉加载方去读已关闭文件。
  function snapshotForSave({ includeClosed = true } = {}) {
    purgeExpiredArchives();
    const snapshot = {
      schemaVersion: INCIDENT_SCHEMA_VERSION,
      savedAt: now(),
      overflow: { ...overflow },
      active: [...active.values()].map(serialize),
      removedServers: [...removedServers].map(([serverId, entry]) => ({
        serverId,
        removedAt: entry.removedAt,
        active: [...entry.active.values()].map(serialize),
        closed: [...entry.closed.values()].map(serialize),
      })),
    };
    if (includeClosed) {
      // 旧版单文件格式：逐日计数跟已关闭事件放在一起（拆分格式下它在已关闭文件里）。
      snapshot.closed = [...closed.values()].map(serialize);
      snapshot.dayCounts = serializeDayCounts();
    } else {
      snapshot.closedSplit = true;
    }
    return snapshot;
  }

  function serializeWithBudget({ includeClosed }) {
    let json = JSON.stringify(snapshotForSave({ includeClosed }));
    if (Buffer.byteLength(json, "utf8") <= INCIDENT_FILE_MAX_BYTES) return json;
    // 超预算优先淘汰已关闭事件，再淘汰最早删除服务器的归档；所有降级均有日志，
    // 最终仍严格受文件预算约束（单条异常大的证据也不能突破上限）。
    const slim = snapshotForSave({ includeClosed });
    if (includeClosed) slim.closed = [];
    json = JSON.stringify(slim);
    let bytes = Buffer.byteLength(json, "utf8");
    const trimToBudget = (list) => {
      let dropped = 0;
      while (bytes > INCIDENT_FILE_MAX_BYTES && dropped < list.length) {
        bytes -= Buffer.byteLength(JSON.stringify(list[dropped]), "utf8") + (dropped + 1 < list.length ? 1 : 0);
        dropped += 1;
      }
      return list.slice(dropped);
    };
    slim.removedServers.sort((a, b) => a.removedAt - b.removedAt);
    let droppedServers = 0;
    for (const oldest of slim.removedServers) {
      if (bytes <= INCIDENT_FILE_MAX_BYTES) break;
      oldest.closed = trimToBudget(oldest.closed);
      oldest.active = trimToBudget(oldest.active);
      if (!oldest.active.length && !oldest.closed.length) {
        bytes -= Buffer.byteLength(JSON.stringify(oldest), "utf8") + (droppedServers + 1 < slim.removedServers.length ? 1 : 0);
        droppedServers += 1;
      }
    }
    slim.removedServers = slim.removedServers.slice(droppedServers);
    slim.active.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    slim.active = trimToBudget(slim.active);
    json = JSON.stringify(slim);
    // 最终输出重新验证实际字节；预算计算异常时仍不允许突破文件上限。
    if (Buffer.byteLength(json, "utf8") > INCIDENT_FILE_MAX_BYTES) {
      json = JSON.stringify({ ...slim, active: [], removedServers: [] });
    }
    log("incident snapshot storage budget reached: oldest history omitted from persistence", {
      level: "warn", event: "incident-persistence-overflow",
    });
    return json;
  }

  // 旧版单文件格式（顶层含 closed）：保留给 fixture / 兼容场景。
  function serializeForSave() {
    return serializeWithBudget({ includeClosed: true });
  }

  // 拆分格式主文件：不含顶层已关闭事件，常规保存只重写这一份。
  function serializeMainForSave() {
    return serializeWithBudget({ includeClosed: false });
  }

  // 拆分格式已关闭文件：只在 closedRevision 变化时重写；超预算淘汰最早关闭的。
  // 逐日计数（dayCounts）也在这份文件里：它只在事件恢复 / 服务器清除时变化，与已关闭集合同步；
  // 体积有界（≤200 指纹 × 31 天），预算紧张时先淘汰已关闭事件、计数始终保留。
  function serializeClosedForSave() {
    const list = [...closed.values()].sort((a, b) => a.resolvedAt - b.resolvedAt).map(serialize);
    const payload = { schemaVersion: INCIDENT_SCHEMA_VERSION, savedAt: now(), closed: list, dayCounts: serializeDayCounts() };
    let json = JSON.stringify(payload);
    let bytes = Buffer.byteLength(json, "utf8");
    if (bytes <= INCIDENT_FILE_MAX_BYTES) return json;
    let dropped = 0;
    while (bytes > INCIDENT_FILE_MAX_BYTES && dropped < list.length) {
      bytes -= Buffer.byteLength(JSON.stringify(list[dropped]), "utf8") + 1;
      dropped += 1;
    }
    payload.closed = list.slice(dropped);
    json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > INCIDENT_FILE_MAX_BYTES) json = JSON.stringify({ ...payload, closed: [] });
    log("incident closed-history storage budget reached: oldest resolved incidents omitted from persistence", {
      level: "warn", event: "incident-persistence-overflow",
    });
    return json;
  }

  // raw：主文件（旧版单文件或拆分主文件）；options.closed：拆分格式已关闭文件。
  // 返回 { loaded, legacyClosed, closedTrimmed, dayCountsBackfilled }：legacyClosed 表示主文件仍内嵌顶层
  // closed（旧格式），持久化层据此在下一次保存时迁移到拆分格式；closedTrimmed 表示读回的已关闭集合超额被裁剪；
  // dayCountsBackfilled 表示文件里没有逐日计数（旧版本写的）、已按留存记录回填，需要尽快写回已关闭文件。
  function loadSnapshot(raw, { closed: closedRaw = null } = {}) {
    const info = { loaded: false, legacyClosed: false, closedTrimmed: false, dayCountsBackfilled: false };
    if (!raw || typeof raw !== "object") return info;
    if (raw.schemaVersion !== INCIDENT_SCHEMA_VERSION) return info;
    info.loaded = true;
    info.legacyClosed = Array.isArray(raw.closed);
    const restore = (list, target, { limit = maxActive + maxClosed, serverId } = {}) => {
      for (const item of Array.isArray(list) ? list.slice(0, limit) : []) {
        if (!item || typeof item.incidentId !== "string" || item.incidentId.length > 64) continue;
        if (item.lifecycle !== "open" && item.lifecycle !== "resolved") continue;
        if (!COMPONENT_RE.test(String(item.component || ""))) continue;
        if (serverId && item.serverId !== serverId) continue;
        // 旧 schema 的完整事件保持原值；损坏/缺失的可选集合降级为空。
        target.set(item.incidentId, {
          ...item,
          schemaVersion: INCIDENT_SCHEMA_VERSION,
          severity: INCIDENT_SEVERITIES.includes(item.severity) ? item.severity : "warn",
          attention: { acknowledgedAt: null, snoozedUntil: null, snoozeReason: null, ...item.attention },
          evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs.slice(-INCIDENT_EVIDENCE_MAX) : [],
          relatedOperationIds: Array.isArray(item.relatedOperationIds) ? item.relatedOperationIds.slice(-8) : [],
          relatedIncidentIds: Array.isArray(item.relatedIncidentIds) ? item.relatedIncidentIds.slice(-8) : [],
          dispositions: normalizeDispositions(item.dispositions),
          notes: Array.isArray(item.notes) ? item.notes.slice(-16) : [],
          fingerprint: buildIncidentFingerprint(item),
        });
      }
    };
    restore(raw.active, active);
    restore(raw.closed, closed);
    if (closedRaw && typeof closedRaw === "object" && closedRaw.schemaVersion === INCIDENT_SCHEMA_VERSION) {
      restore(closedRaw.closed, closed);
    }
    // 两份文件跨崩溃窗口可能同时出现同一事件：已关闭版本更新，以它为准。
    for (const id of closed.keys()) active.delete(id);
    let archiveBudget = maxArchived;
    for (const entry of Array.isArray(raw.removedServers) ? raw.removedServers.slice(-maxArchived) : []) {
      if (archiveBudget <= 0) break;
      if (!entry || typeof entry.serverId !== "string" || !entry.serverId || entry.serverId.length > 64) continue;
      if (!Number.isFinite(entry.removedAt) || entry.removedAt < 0 || entry.removedAt > now()) continue;
      if (entry.removedAt + INCIDENT_SERVER_TRASH_TTL_MS <= now()) {
        pendingPersistenceChange = true;
        continue;
      }
      const archive = { removedAt: entry.removedAt, active: new Map(), closed: new Map() };
      restore(entry.active, archive.active, { limit: archiveBudget, serverId: entry.serverId });
      archiveBudget -= archive.active.size;
      restore(entry.closed, archive.closed, { limit: archiveBudget, serverId: entry.serverId });
      archiveBudget -= archive.closed.size;
      if (archive.active.size || archive.closed.size) removedServers.set(entry.serverId, archive);
    }
    if (raw.overflow && Number.isFinite(raw.overflow.count)) overflow = {
      count: Math.max(0, Math.trunc(raw.overflow.count)),
      lastAt: Number.isFinite(raw.overflow.lastAt) ? raw.overflow.lastAt : null,
    };
    enforceActiveBound();
    // 读回超额的已关闭集合（旧版本没有指纹限额）：裁剪后告诉持久化层尽快重写已关闭文件。
    const closedRevisionBeforeTrim = closedRevision;
    trimClosed();
    info.closedTrimmed = closedRevision !== closedRevisionBeforeTrim;
    enforceArchiveBound();
    // 逐日计数：拆分格式在已关闭文件里，旧版单文件在主文件里；都没有就按留存记录回填
    // （必须在上面的裁剪之后：覆盖边界按裁剪后的留存数判断）。
    const validClosedRaw = closedRaw && typeof closedRaw === "object" && closedRaw.schemaVersion === INCIDENT_SCHEMA_VERSION;
    if (!restoreDayCounts(validClosedRaw && closedRaw.dayCounts ? closedRaw.dayCounts : raw.dayCounts)) {
      info.dayCountsBackfilled = backfillDayCounts();
    }
    return info;
  }

  function getPersistRevisions() {
    return { revision, urgentRevision, closedRevision };
  }

  // 持久化状态变化订阅（同步回调；监听器异常被吞掉，不影响事件逻辑）。
  function onPersistChange(listener) {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  }

  return {
    observe,
    reportSuccess,
    reportUnknown,
    promotePending,
    observeDiskUsage,
    acknowledge,
    snooze,
    unsnooze,
    linkOperation,
    verifyDispositions,
    query,
    list,
    get,
    counts,
    summarize,
    syncServerLifecycle,
    closeAgentIncidents,
    serializeForSave,
    serializeMainForSave,
    serializeClosedForSave,
    loadSnapshot,
    getPersistRevisions,
    onPersistChange,
    // 测试辅助
    getIncident: (id) => active.get(String(id)) || closed.get(String(id)) || null,
    listPending: () => [...pending.values()].map((candidate) => ({ ...candidate, evidenceRefs: [...candidate.evidenceRefs] })),
  };
}
