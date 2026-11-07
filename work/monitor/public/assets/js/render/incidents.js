// render/incidents.js —— T06 事件视图与概览事件摘要（消费 T07 的 /api/incidents 与 /api/incidents/summary）。
// 纯模型函数（buildIncidentListModel / buildIncidentSummaryModel / buildOverviewIncidentSummary）可 Node 测试；
// DOM 层惰性 getEl（dom-utils.createElementLookup）。所有动态串 escapeHtml，偏好动作只影响提醒资格、
// 不改变故障事实（T07 契约）。
//
// 名字一律用界面用语：组件 / 原因见下面两张表，Agent 与服务器走 display-names.js（调用方传入
// /api/status 快照）。时刻一律北京时间（usage-model.js），与后端按北京自然日分桶的口径一致。
import { agentDisplayName, serverShortName } from "../display-names.js";
import { createElementLookup, morphInnerHtml, setAttr, setText } from "../dom-utils.js";
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml } from "../store.js";
import {
  buildClusterModel, clusterCardHtml, incidentContextHtml, incidentRemedy, latestDisposition, recurrenceText,
} from "./incident-insights.js";
import { createMemoRender, timeBucket } from "./render-skip.js";
import { clockOf, dateTimeOf, dayKeyOf, monthDay, TZ_LABEL } from "./usage-model.js";

const SEVERITY_LABELS = { error: "严重", warn: "警告", info: "提示" };
const SEVERITY_CLASSES = { error: "sev-error", warn: "sev-warn", info: "sev-info" };
// filesystem 组件 = 集群机器上 $HOME 所在的磁盘（df / 慢 IO 探测），界面统一叫「磁盘」。
const COMPONENT_LABELS = {
  channel: "通道",
  tunnel: "隧道",
  agent: "Agent",
  filesystem: "磁盘",
};
// 稳定原因码 → 界面文案。要覆盖后端会产生的全部取值（lib/incidents/reason-labels.test.mjs 守护）：
//   隧道 TUNNEL_DOWN；通道取 transport.reasonCode（lib/readiness-view.mjs），取不到时 CHANNEL_ERROR；
//   Agent 见 server/incident-sync.mjs 的 agentReasonCode；磁盘 DISK_THRESHOLD（store.observeDiskUsage）。
// 未登记的原样显示作兜底。
const REASON_LABELS = {
  TUNNEL_DOWN: "连接断开",
  REMOTE_PORT_CLOSED: "远端端口关闭",
  LOCAL_PROXY_DOWN: "本地代理未运行",
  CHANNEL_ERROR: "状态异常",
  TRANSPORT_DATA_PATH_OK: "状态异常",
  WAITING_FIRST_PROBE: "尚未完成首次检测",
  MANUALLY_STOPPED: "已手动停止",
  DEGRADED: "降级",
  AGENT_ATTENTION: "需要处理",
  AGENT_MISSING: "未安装或找不到",
  AUTH_REQUIRED: "需要重新登录",
  ACCOUNT_REVOKED: "账号授权被吊销",
  ACCOUNT_BANNED: "账号被封禁",
  DISK_THRESHOLD: "用量超过阈值",
  FS_SLOW: "读写缓慢",
};
// 已恢复事件汇总里，每类展开后最多列出的逐条记录数由后端决定（INCIDENT_SUMMARY_RECENT_MAX）；
// 每类留存上限取响应里的 keepPerType，取不到时按后端缺省值。
const DEFAULT_KEEP_PER_TYPE = 50;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 原因码 → 界面文案。通道的原因可能是几个码用 + 连起来（数据通路同时断了几段）：逐段翻译。
export function incidentReasonLabel(reasonCode) {
  const code = typeof reasonCode === "string" && reasonCode ? reasonCode : "UNKNOWN";
  return code.split("+").map((part) => REASON_LABELS[part] || part).join("、");
}

const componentLabelOf = (component) => COMPONENT_LABELS[component] || String(component || "组件").slice(0, 16);

// 事件标题：Agent 事件用 Agent 的显示名（「Codex · 降级」），其余用组件名（「隧道 · 连接断开」）。
function incidentTitle(status, { component, agentId, reasonCode }) {
  const subject = component === "agent" && agentId ? agentDisplayName(status, agentId) : componentLabelOf(component);
  return `${subject} · ${incidentReasonLabel(reasonCode)}`;
}

// 服务器短名（「主集群」）；不属于任何服务器的事件显示「全局」。
const serverLabelOf = (status, serverId) => (serverId ? serverShortName(status, serverId) : "全局");

// ---- 时间文案（北京时间）----

// 能换算成日期的时间戳（Date 的合法范围是 ±8.64e15 ms）；对端数据损坏时别画出「NaN:NaN」。
const isTime = (ms) => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
const dayOf = (ms) => dayKeyOf(ms / 1000);
// 「10.3 18:02」
const momentText = (ms) => `${monthDay(dayOf(ms))} ${clockOf(ms / 1000)}`;

// 卡片上的时刻：当天只显示时刻，跨天前缀「MM-DD」（持续数周的事件只看时刻会误以为是今天发生的）。
function formatMoment(ts, nowMs) {
  if (!isTime(ts)) return "—";
  const clock = clockOf(ts / 1000, { seconds: true });
  const day = dayOf(ts);
  return day === dayOf(nowMs) ? clock : `${day.slice(5)} ${clock}`;
}

// 已持续时长："N 分钟 / N 小时 / N 天"。
function formatSpan(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

// "最近 N 分钟前"：按分钟取整，不足 1 分钟为「刚刚」。不复用 store.formatRelativeTime——
// 它会细到"N 秒前"，而本模块的渲染签名只按 30s 时间桶（render-skip.timeBucket）刷新，秒级文案会停在旧值。
function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

// 粗粒度时长，只取一个单位（「2 分」「12 小时」）：给「典型持续」这类统计量用，精确值放悬停提示。
export function coarseDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return "不到 1 秒";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分`;
  const hours = Math.round(ms / 3600000);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.round(ms / 86400000)} 天`;
}

// 精确到相邻两个单位的时长（「1 分 44 秒」「12 小时 5 分」「28 天 3 小时」）：逐条记录与悬停提示用。
export function preciseDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

// 最近一次磁盘用量证据（%），没有则 null。
function latestDiskPct(item) {
  const refs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [];
  for (let i = refs.length - 1; i >= 0; i -= 1) {
    if (refs[i]?.kind === "disk-usage" && Number.isFinite(refs[i].usedPct)) return refs[i].usedPct;
  }
  return null;
}

// 事件带的详情文字（detail.text）；没有、不是字符串、已恢复的都当没有。
const DETAIL_MAX = 400;
function diskDetailOf(item) {
  const text = item.lifecycle !== "resolved" && typeof item.detail?.text === "string" ? item.detail.text.trim() : "";
  return text.slice(0, DETAIL_MAX);
}

// 未解决事件的排序：先「需要处理」（未确认、未稍后提醒），再按严重度，最后按最近一次——
// 此前只按最近一次，已确认的磁盘警告会排在仍在断开的隧道（严重）之上。
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };
const needsAttention = (item) => !item.acknowledged && !item.snoozed;
function compareOpen(a, b) {
  return (Number(needsAttention(b)) - Number(needsAttention(a)))
    || (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    || (b.lastSeenAt - a.lastSeenAt);
}

// 事件簇 / 前后经过里其它事件的名字：「隧道 · 连接断开 · GPU 节点 B」（全局事件不带服务器）。
export const incidentTitleWithServer = (status, fields) => {
  const title = incidentTitle(status, fields || {});
  return fields?.serverId ? `${title} · ${serverLabelOf(status, fields.serverId)}` : title;
};

// /api/incidents 响应 → 列表模型。畸形条目逐条降级，不抛错（对端可能混合版本）。
// status = /api/status 快照，只用来把 serverId / agentId 换成界面上的名字；没有时退回 id。
// canScoped：后台组件支持单隧道重启（connection-target.canScopedRestart），决定隧道事件的建议处置。
export function buildIncidentListModel(payload, { nowMs = Date.now(), status = null, canScoped = false } = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(src.incidents) ? src.incidents : [];
  const items = list.map((incident) => {
    const item = incident && typeof incident === "object" ? incident : {};
    const severity = SEVERITY_LABELS[item.severity] ? item.severity : "warn";
    const snoozedUntil = Number.isFinite(item.attention?.snoozedUntil) ? item.attention.snoozedUntil : null;
    const reasonCode = typeof item.reasonCode === "string" ? item.reasonCode : "UNKNOWN";
    const agentId = typeof item.agentId === "string" ? item.agentId : "";
    const serverId = typeof item.serverId === "string" ? item.serverId : "";
    // 持续性状态（磁盘超阈值）每次采样都累加次数，"发生 N 万次"没有意义：改显当前用量与持续时长。
    const continuous = reasonCode === "DISK_THRESHOLD";
    return {
      incidentId: typeof item.incidentId === "string" ? item.incidentId : "",
      severity,
      severityLabel: SEVERITY_LABELS[severity],
      severityClass: SEVERITY_CLASSES[severity],
      componentLabel: componentLabelOf(item.component),
      agentId,
      serverId,
      reasonCode,
      reasonLabel: incidentReasonLabel(reasonCode),
      // 界面上显示的标题与服务器名（不外露 server-01、DEGRADED 这类内部写法）
      title: incidentTitle(status, { component: item.component, agentId, reasonCode }),
      serverLabel: serverLabelOf(status, serverId),
      occurrences: Number.isFinite(item.occurrences) ? item.occurrences : 1,
      continuous,
      usedPct: continuous ? latestDiskPct(item) : null,
      // 未解决的磁盘事件带的一句详情（后端现算：近 24 小时作业目录的增长 + 按这个速度几天写满，lib/disk-growth/detail.mjs）。
      detailText: continuous ? diskDetailOf(item) : "",
      ongoingText: continuous && Number.isFinite(item.firstSeenAt) ? formatSpan(nowMs - item.firstSeenAt) : "",
      firstSeenText: formatMoment(item.firstSeenAt, nowMs),
      lastSeenText: formatAgo(nowMs - item.lastSeenAt),
      lastSeenAt: Number.isFinite(item.lastSeenAt) ? item.lastSeenAt : 0,
      // 未解决的非持续型事件：标题行右侧「已持续 40 分钟」（此前只有磁盘显示持续时长）
      durationText: item.lifecycle !== "resolved" && Number.isFinite(item.firstSeenAt) ? `已持续 ${formatSpan(nowMs - item.firstSeenAt)}` : "",
      // 「25 分钟内第 8 次（之前 7 次累计 14 分钟）」：同类短时间内反复发生（后端 recurrence）
      recurrenceText: item.lifecycle !== "resolved" ? recurrenceText(item.recurrence, { nowMs, continuous }) : "",
      remedy: incidentRemedy(item, { canScoped }),
      disposition: latestDisposition(item, { nowMs }),
      raw: item,
      acknowledged: Boolean(item.attention?.acknowledgedAt),
      snoozed: snoozedUntil != null && snoozedUntil > nowMs,
      // 后端按关联先后追加（最旧在前）：保留最近 3 个，按钮打开最后一个（最近一次处置）。
      relatedOperationIds: Array.isArray(item.relatedOperationIds) ? item.relatedOperationIds.filter((id) => typeof id === "string").slice(-3) : [],
      // lifecycle 只读展示（T07：偏好不改变事实；resolved 只出现在 resolved 查询里）
      lifecycle: item.lifecycle === "resolved" ? "resolved" : "open",
      resolvedAtText: item.lifecycle === "resolved" ? formatMoment(item.resolvedAt, nowMs) : "",
    };
  }).filter((item) => item.incidentId);
  if (src.state !== "resolved") items.sort(compareOpen);
  return {
    state: src.state === "resolved" ? "resolved" : "open",
    total: Number.isFinite(src.total) ? src.total : items.length,
    overflow: src.overflow && Number.isFinite(src.overflow.count) ? src.overflow : { count: 0, lastAt: null },
    items,
    empty: items.length === 0,
  };
}

// 概览摘要：「需要处理」= 未确认且不在稍后提醒中的事件；取最严重的前 max 条
// （error > warn > info，同级按发生次数）。已确认 / 稍后提醒的只计数（quiet），完整列表在「事件」视图。
export function buildOverviewIncidentSummary(model, { max = 3 } = {}) {
  const m = model && Array.isArray(model.items) ? model : { items: [], total: 0, overflow: { count: 0 } };
  const rank = { error: 0, warn: 1, info: 2 };
  const pending = m.items.filter((item) => !item.acknowledged && !item.snoozed);
  const quiet = m.items.length - pending.length;
  // 服务端 total 可能多于本页条目（limit）：多出的部分按"需要处理"计。
  const count = Math.max(0, (m.total ?? m.items.length) - quiet);
  const top = [...pending]
    .sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.occurrences - a.occurrences))
    .slice(0, max);
  return {
    count,
    quiet,
    shown: top.length,
    hidden: Math.max(0, count - top.length),
    items: top,
    overflowCount: m.overflow?.count ?? 0,
  };
}

// ---- 已恢复事件按类型汇总（/api/incidents/summary）----

// 一天里处于发生中的条数 → 热度档（0 没有，1–4 由浅到深）：1 / 2–3 / 4–7 / 8 条以上。
const heatOf = (count) => (count <= 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 7 ? 3 : 4);

// 「典型持续」一栏：持续型事件（磁盘超阈值）写「持续 N 天」；其余多于一条时写中位与最长，只有一条就写它的时长。
// 都是统计量，用粗粒度时长；精确值与样本数放悬停提示。
function durationColumn({ continuous, medianMs, longestMs, samples }) {
  if (medianMs == null || longestMs == null) return { main: "—", sub: "", title: "这一类的逐条记录已清理，没有可用的持续时长" };
  if (continuous) {
    return {
      main: `持续 ${coarseDuration(longestMs)}`,
      sub: "",
      title: samples > 1 ? `最长一次持续 ${preciseDuration(longestMs)}（留存的 ${samples} 条记录）` : `持续 ${preciseDuration(longestMs)}`,
    };
  }
  if (samples > 1) {
    return {
      main: `中位 ${coarseDuration(medianMs)}`,
      sub: `最长 ${coarseDuration(longestMs)}`,
      title: `中位 ${preciseDuration(medianMs)} · 最长 ${preciseDuration(longestMs)}（留存的最近 ${samples} 条记录）`,
    };
  }
  return { main: coarseDuration(medianMs), sub: "", title: `持续 ${preciseDuration(medianMs)}` };
}

// /api/incidents/summary 响应 → 表格模型。expanded = 展开着的类型 key 集合（Set）。畸形字段逐项降级，不抛错。
//   ready    响应形状可用（否则界面显示加载 / 取不到）
//   badge    标题旁徽标：「近 14 天 173+ 次 · 9 类」——次数是窗口内各类次数之和，带 + 表示只是下限
//   rows[]   每类一行；cells 与窗口里的日子一一对应，heat 为 "0"–"4" 或 "none"（记录已清理）
export function buildIncidentSummaryModel(payload, { nowMs = Date.now(), status = null, expanded = null } = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const days = Array.isArray(src.days) ? src.days.filter((day) => typeof day === "string" && DAY_KEY_RE.test(day)) : [];
  const keepPerType = Number.isFinite(src.keepPerType) && src.keepPerType > 0 ? src.keepPerType : DEFAULT_KEEP_PER_TYPE;
  const today = dayOf(nowMs);
  const isExpanded = (key) => Boolean(expanded && typeof expanded.has === "function" && expanded.has(key));
  const finite = (value) => (Number.isFinite(value) ? value : null);
  const timeOf = (value) => (isTime(value) ? value : null);
  const countingSinceMs = timeOf(src.countingSince);
  const countingSinceDay = countingSinceMs == null ? null : dayOf(countingSinceMs);
  const rows = (Array.isArray(src.types) ? src.types : []).map((raw) => {
    const type = raw && typeof raw === "object" ? raw : {};
    if (typeof type.key !== "string" || !type.key) return null;
    const severity = SEVERITY_LABELS[type.severity] ? type.severity : "warn";
    const reasonCode = typeof type.reasonCode === "string" ? type.reasonCode : "UNKNOWN";
    const agentId = typeof type.agentId === "string" ? type.agentId : "";
    const serverId = typeof type.serverId === "string" ? type.serverId : "";
    const continuous = reasonCode === "DISK_THRESHOLD";
    const count = Number.isFinite(type.count) ? Math.max(0, type.count) : 0;
    const coverageStart = typeof type.coverageStart === "string" && DAY_KEY_RE.test(type.coverageStart) ? type.coverageStart : null;
    const capped = Boolean(type.capped) || coverageStart != null;
    const perDay = Array.isArray(type.perDay) ? type.perDay : [];
    const cells = days.map((day, index) => {
      const active = Number.isFinite(perDay[index]) ? Math.max(0, perDay[index]) : 0;
      const label = monthDay(day);
      if (coverageStart && day < coverageStart) {
        return { day, heat: "none", title: `${label} · 记录已清理（每类只留最近 ${keepPerType} 条）` };
      }
      if (coverageStart && day === coverageStart) {
        return { day, heat: String(heatOf(active)), title: `${label} · ${active ? `至少 ${active} 条` : "记录不完整"}（当天更早的记录已清理）` };
      }
      // 开始逐日计数之前、留存记录里也没有的日子：如实标「无记录」，不画成 0（那几天的记录可能已因
      // 文件大小上限被裁掉，无从知道）。
      if (!active && countingSinceDay && day < countingSinceDay) {
        return { day, heat: "none", title: `${label} · 无记录（${monthDay(countingSinceDay)} 起才逐日计数）` };
      }
      return { day, heat: String(heatOf(active)), title: `${label} · ${active ? `${active} 条` : "没有"}` };
    });
    // 分布条给读屏的文字：只念有事件的日子，再说明哪天之前的记录已清理。
    const busyDays = days.map((day, index) => [day, Number.isFinite(perDay[index]) ? Math.max(0, perDay[index]) : 0])
      .filter(([day, active]) => active > 0 && !(coverageStart && day < coverageStart))
      .map(([day, active]) => `${monthDay(day)} ${active} 条`);
    const stripLabel = `近 ${days.length} 天每天处于发生中的条数：${busyDays.length ? busyDays.join("、") : "没有"}`
      + (coverageStart ? `；${monthDay(coverageStart)} 之前的记录已清理` : "");
    const recent = (Array.isArray(type.recent) ? type.recent : []).map((entry) => {
      const item = entry && typeof entry === "object" ? entry : {};
      if (typeof item.incidentId !== "string" || !item.incidentId) return null;
      const start = timeOf(item.firstSeenAt);
      const end = timeOf(item.resolvedAt);
      const from = start ?? end;
      let whenText = "—";
      if (from != null) {
        whenText = momentText(from);
        if (start != null && end != null) whenText += ` – ${dayOf(end) === dayOf(start) ? clockOf(end / 1000) : momentText(end)}`;
      }
      return {
        incidentId: item.incidentId,
        whenText,
        durationText: start != null && end != null ? `持续 ${preciseDuration(Math.max(0, end - start))}` : "",
        // 持续型事件每次采样都累加次数，逐条里也不显示。
        occurrencesText: !continuous && Number.isFinite(item.occurrences) ? `期间检测到 ${item.occurrences} 次` : "",
        operationId: typeof item.operationId === "string" ? item.operationId : "",
      };
    }).filter(Boolean);
    const retained = Number.isFinite(type.retained) ? Math.max(type.retained, recent.length) : recent.length;
    const lastSeenAt = timeOf(type.lastSeenAt);
    const samples = Number.isFinite(type.samples) ? type.samples : finite(type.medianMs) != null ? 1 : 0;
    const duration = durationColumn({ continuous, medianMs: finite(type.medianMs), longestMs: finite(type.longestMs), samples });
    return {
      key: type.key,
      severity,
      severityLabel: SEVERITY_LABELS[severity],
      severityClass: SEVERITY_CLASSES[severity],
      title: incidentTitle(status, { component: type.component, agentId, reasonCode }),
      serverLabel: serverLabelOf(status, serverId),
      count,
      capped,
      countText: `${count}${capped ? "+" : ""}`,
      countTitle: capped
        ? `${coverageStart ? `${monthDay(coverageStart)} 之前的记录已清理` : "更早的记录已清理"}（每类只留最近 ${keepPerType} 条），实际次数不少于这个数`
        : "",
      lastText: lastSeenAt == null ? "—" : dayOf(lastSeenAt) === today ? clockOf(lastSeenAt / 1000) : momentText(lastSeenAt),
      lastAgo: lastSeenAt == null ? "" : formatAgo(nowMs - lastSeenAt),
      lastTitle: lastSeenAt == null ? "" : `${dateTimeOf(lastSeenAt / 1000)}（${TZ_LABEL}）`,
      durationMain: duration.main,
      durationSub: duration.sub,
      durationTitle: duration.title,
      cells,
      stripLabel,
      expanded: isExpanded(type.key),
      recent,
      retained,
      moreCount: Math.max(0, retained - recent.length),
    };
  }).filter(Boolean);
  const total = Number.isFinite(src.total) ? src.total : rows.reduce((sum, row) => sum + row.count, 0);
  const capped = Boolean(src.capped) || rows.some((row) => row.capped);
  const totalText = `${total}${capped ? "+" : ""}`;
  // 窗口内真的发生过的类型数（更早发生、窗口内次数为 0 的类型照样列在表里，但不算进徽标）。
  const activeTypes = rows.filter((row) => row.count > 0 || row.cells.some((cell) => cell.heat !== "0" && cell.heat !== "none")).length;
  const countingSince = countingSinceMs;
  return {
    ready: Array.isArray(src.types) && Array.isArray(src.days),
    windowDays: days.length,
    keepPerType,
    total,
    totalText,
    capped,
    activeTypes,
    retained: finite(src.retained),
    sinceText: countingSince == null ? "" : monthDay(dayOf(countingSince)),
    badge: rows.length ? `近 ${days.length} 天 ${totalText} 次 · ${activeTypes} 类` : "已恢复 0",
    rows,
    empty: rows.length === 0,
  };
}

// ---- DOM 层 ----

const getEl = createElementLookup();

// 容器换了（元素被重建 / 测试里的假 DOM）就当成新的渲染目标：点击委托重新绑、渲染记忆不沿用。
const containerSeq = new WeakMap();
let containerCount = 0;
function containerId(el) {
  let id = containerSeq.get(el);
  if (!id) {
    containerCount += 1;
    id = containerCount;
    containerSeq.set(el, id);
  }
  return id;
}
const clickBound = new WeakSet();
function bindClicksOnce(container, listener) {
  if (clickBound.has(container) || typeof container.addEventListener !== "function") return;
  clickBound.add(container);
  container.addEventListener("click", listener);
}

// 结构固定、文案常变的区域就地修补（保住键盘焦点与悬停提示）；宿主没有 <template>（测试里的假 DOM）时整块写入。
function patchHtml(el, html) {
  if (typeof el.ownerDocument?.createElement === "function") morphInnerHtml(el, html);
  else el.innerHTML = html;
}

function setHidden(el, hidden) {
  if (el && el.hidden !== hidden) el.hidden = hidden;
}

// 事件面板的外壳：哪个容器可见、「按类型 / 逐条」分段控件的显隐与选中、标题旁的徽标。
// state = 筛选器的值（open | resolved）；mode = 已恢复事件的排列（type | each）。值没变不写 DOM。
export function renderIncidentChrome({ state = "open", mode = "type", badge = "-" } = {}) {
  const resolved = state === "resolved";
  const byType = resolved && mode === "type";
  setHidden(getEl("incidentSummary"), !byType);
  setHidden(getEl("incidentList"), byType);
  setHidden(getEl("incidentResolvedMode"), !resolved);
  setAttr(getEl("incidentModeType"), "aria-pressed", String(mode === "type"));
  setAttr(getEl("incidentModeEach"), "aria-pressed", String(mode !== "type"));
  setText(getEl("incidentListBadge"), badge);
}

// 渲染签名（纯函数，可单测）：只取影响 DOM 的输入——列表态/总数/溢出、逐条的
// incidentId·lastSeenAt·次数·确认·稍后提醒·生命周期·界面用名，再加相对时间桶（"X 分钟前"文案）。
// 每次状态刷新都会调用渲染入口，签名不变就完全不碰 DOM（不重建 innerHTML）。
export function buildIncidentRenderSignature(payload, { nowMs = Date.now(), withViewOps = false, status = null } = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const list = Array.isArray(src.incidents) ? src.incidents : [];
  const rows = list.map((item) => {
    const i = item && typeof item === "object" ? item : {};
    const snoozedUntil = Number.isFinite(i.attention?.snoozedUntil) ? i.attention.snoozedUntil : "";
    const snoozedNow = snoozedUntil !== "" && snoozedUntil > nowMs ? 1 : 0;
    return [
      i.incidentId, i.lastSeenAt, i.firstSeenAt, i.occurrences, i.severity, i.component, i.agentId, i.serverId,
      i.reasonCode, i.attention?.acknowledgedAt || "", snoozedUntil, snoozedNow, i.lifecycle, i.resolvedAt,
      latestDiskPct(i) ?? "",
      i.reasonCode === "DISK_THRESHOLD" ? diskDetailOf(i) : "",
      Array.isArray(i.relatedOperationIds) ? i.relatedOperationIds.at(-1) : "",
      i.recurrence ? `${i.recurrence.count}:${i.recurrence.sinceAt}:${i.recurrence.downMs}` : "",
      Array.isArray(i.dispositions) ? i.dispositions.map((d) => `${d?.operationId}:${d?.outcome}:${d?.afterMs}`).join(",") : "",
      // 名字来自状态快照：快照晚到或服务器改名后要重渲
      typeof i.serverId === "string" && i.serverId ? serverShortName(status, i.serverId) : "",
      typeof i.agentId === "string" && i.agentId ? agentDisplayName(status, i.agentId) : "",
    ].join("\u0001");
  });
  // 事件簇（已恢复的逐条）：簇本身就是签名（≤50 簇）
  const clusters = Array.isArray(src.clusters) ? JSON.stringify(src.clusters) : "";
  return [payload == null ? "loading" : src.state, src.total, src.overflow?.count ?? 0, withViewOps ? 1 : 0, timeBucket(nowMs), clusters, ...rows].join("\u0002");
}

// 列表为空时的空状态（纯函数）。未解决为 0 是好消息：不放主按钮，只给去「已恢复」的入口；
// 已恢复为空说明还没有恢复过的事件（或这一类的逐条记录已被清理）。
export function incidentListEmptyHtml(state, { filtered = false } = {}) {
  if (state !== "resolved") {
    return emptyStateHtml({
      tone: "ok", icon: "check", title: "没有未解决的事件",
      body: "连接链路（隧道、端口、本地代理）、Agent 或磁盘出现异常时会在这里成为一条事件；恢复后自动归档到「已恢复」，按类型汇总。",
      actions: [{ label: "查看已恢复事件", kind: "secondary", attrs: { "data-show-resolved": "" } }],
    });
  }
  if (filtered) {
    return emptyStateHtml({ tone: "neutral", icon: "inbox", title: "这一类没有留存的逐条记录", body: "每类只保留最近的逐条记录，更早的已清理；按类型汇总里仍有每天的次数。" });
  }
  return emptyStateHtml({
    tone: "neutral", icon: "inbox", title: "还没有已恢复的事件",
    body: "连接链路、Agent 或磁盘的异常恢复后会归档到这里，每一类保留最近的逐条记录。",
  });
}

// 点击委托每个容器只绑一次；回调随每次渲染更新（闭包里读最新引用），不再每轮重设 onclick。
const incidentHandlers = {
  onAttention: null, onViewOps: null, onClearType: null, onShowResolved: null,
  onRemedy: null, onToggleContext: null, onCopy: null, onToggleCluster: null,
};
const LIST_ACTIONS = "[data-attention],[data-view-ops],[data-clear-type],[data-show-resolved],[data-remedy],[data-incident-context],[data-copy-incident],[data-cluster-toggle]";
function onIncidentListClick(event) {
  const target = event.target instanceof Element ? event.target.closest(LIST_ACTIONS) : null;
  if (!target) return;
  const { onAttention, onViewOps, onClearType, onShowResolved, onRemedy, onToggleContext, onCopy, onToggleCluster } = incidentHandlers;
  if (target.dataset.remedy) {
    if (typeof onRemedy === "function") onRemedy(target.dataset.remedy, target.dataset.serverId || "");
  } else if (target.dataset.incidentContext) {
    if (typeof onToggleContext === "function") onToggleContext(target.dataset.incidentContext);
  } else if (target.dataset.copyIncident) {
    if (typeof onCopy === "function") onCopy(target.dataset.copyIncident);
  } else if (target.dataset.clusterToggle) {
    if (typeof onToggleCluster === "function") onToggleCluster(target.dataset.clusterToggle);
  } else if (target.dataset.showResolved != null) {
    if (typeof onShowResolved === "function") onShowResolved();
  } else if (target.dataset.attention && typeof onAttention === "function") {
    const action = target.dataset.attention;
    onAttention(target.dataset.id, action, action === "snooze" ? 60 * 60 * 1000 : undefined);
  } else if (target.dataset.viewOps && typeof onViewOps === "function") {
    onViewOps(target.dataset.viewOps);
  } else if (target.dataset.clearType != null && typeof onClearType === "function") {
    onClearType();
  }
}

// 逐条卡片。payload 为 null 表示这份数据还没拿到（显示加载占位）。
//   state       这份列表对应的筛选（open | resolved），只在 payload 还没到时用来写徽标
//   typeFilter  逐条视图只看某一类时：{ key, component, agentId, serverId, reasonCode }（来自汇总里的那一行）
//   canScoped   后台组件支持单隧道重启：隧道事件的建议处置是「重启这条隧道」，否则「一键修复（所有连接）」
//   contexts    展开着「前后经过」的事件：Map<incidentId, payload | null（加载中）| "failed">
//   expandedClusters 展开着逐次记录的事件簇 id（Set）
// 已恢复的逐条数据是事件簇（GET /api/incidents?group=cluster，payload.clusters）：同类 15 分钟内接连发生的合成一张卡。
// 返回标题旁徽标要显示的文字。
// failed：这份列表从没取到过、最近一次请求失败时的原因（有数据时忽略——旧数据照常显示）。
export function renderIncidentList(payload, {
  nowMs = Date.now(), state = "open", status = null, typeFilter = null, failed = "", canScoped = false, contexts = null, expandedClusters = null,
  onAttention, onViewOps, onClearType, onShowResolved, onRemedy, onToggleContext, onCopy, onToggleCluster,
} = {}) {
  const loading = payload == null;
  const clustered = !loading && Array.isArray(payload?.clusters);
  const model = clustered
    ? { state: "resolved", ...buildClusterModel(payload, {
      nowMs, expanded: expandedClusters,
      titleOf: (c) => incidentTitle(status, c), serverLabelOf: (id) => serverLabelOf(status, id),
      severityOf: (sev) => (SEVERITY_LABELS[sev] ? sev : "warn"),
    }), clustered: true, overflow: { count: 0 } }
    : buildIncidentListModel(payload, { nowMs, status, canScoped });
  const resolved = loading ? state === "resolved" : model.state === "resolved";
  let badge = loading ? (resolved ? "已恢复" : "未解决") : `${resolved ? "已恢复" : "未解决"} ${model.total}`;
  if (clustered) badge = model.incidentTotal > model.total ? `已恢复 ${model.incidentTotal} 次 · ${model.total} 簇` : `已恢复 ${model.incidentTotal}`;
  const container = getEl("incidentList");
  if (!container) return badge;
  Object.assign(incidentHandlers, { onAttention, onViewOps, onClearType, onShowResolved, onRemedy, onToggleContext, onCopy, onToggleCluster });
  bindClicksOnce(container, onIncidentListClick);
  const filterLabel = resolved && typeFilter ? `${incidentTitle(status, typeFilter)} · ${serverLabelOf(status, typeFilter.serverId)}` : "";
  const contextOf = (incidentId) => {
    if (!contexts || typeof contexts.has !== "function" || !contexts.has(incidentId)) return "";
    const value = contexts.get(incidentId);
    return `<div class="ev-ctx-panel">${incidentContextHtml(value === "failed" ? null : value, {
      nowMs, failed: value === "failed", titleOf: (fields) => incidentTitleWithServer(status, fields),
    })}</div>`;
  };
  const contextKey = contexts && typeof contexts.entries === "function"
    ? [...contexts.entries()].map(([id, value]) => `${id}:${value === "failed" ? "f" : value ? `${value.to}:${value.entries?.length}` : "l"}`).join(",")
    : "";
  const clusterKey = expandedClusters && typeof expandedClusters.values === "function" ? [...expandedClusters.values()].join(",") : "";
  renderIncidentListMemo(container, payload, {
    nowMs, status, withViewOps: typeof onViewOps === "function", filterLabel, model, loading, failed: loading ? failed : "",
    canScoped, contextOf, contextKey, clusterKey, withRemedy: typeof onRemedy === "function",
  });
  return badge;
}

const renderIncidentListMemo = createMemoRender(
  (container, _payload, view) => renderIncidentListDom(container, view),
  (container, payload, { nowMs, status, withViewOps, filterLabel, failed, canScoped, contextKey, clusterKey, withRemedy }) =>
    `${containerId(container)}\u0002${filterLabel}\u0002${failed}\u0002${canScoped ? 1 : 0}${withRemedy ? 1 : 0}\u0002${contextKey}\u0002${clusterKey}\u0002${buildIncidentRenderSignature(payload, { nowMs, withViewOps, status })}`,
);

function renderIncidentListDom(container, { model, loading, withViewOps, filterLabel, failed, contextOf, withRemedy }) {
  // 只看某一类时在最上面说明，并给一个回到全部的入口。
  const filterNote = filterLabel
    ? `<p class="ev-filter-note"><span>只看这一类：${escapeHtml(filterLabel)}</span><button type="button" class="text-btn" data-clear-type>显示全部类型</button></p>`
    : "";
  if (loading) {
    container.innerHTML = filterNote + (failed
      ? emptyStateHtml({ tone: "error", icon: "cloudOff", title: "暂时取不到事件列表", body: `${failed}；稍后会自动重试。` })
      : '<p class="incidents-empty">正在加载事件…</p>');
    return;
  }
  if (model.empty) {
    container.innerHTML = filterNote + incidentListEmptyHtml(model.state, { filtered: Boolean(filterNote) });
    return;
  }
  if (model.clustered) {
    container.innerHTML = filterNote + model.clusters.map((cluster) => {
      const ids = cluster.count > 1 ? cluster.members.map((m) => m.incidentId) : [cluster.latestIncidentId];
      return clusterCardHtml(cluster, { withViewOps, contextHtml: ids.map(contextOf).join("") });
    }).join("");
    return;
  }
  const overflowNote = model.overflow.count > 0
    ? `<p class="incidents-overflow">另有 ${escapeHtml(String(model.overflow.count))} 条更早的活跃事件已合并为溢出摘要。</p>`
    : "";
  // 已恢复列表一页只取最近的若干条：如实说明没列全，并指到按类型汇总。
  const truncatedNote = model.state === "resolved" && model.total > model.items.length
    ? `<p class="incidents-overflow">只列出最近 ${escapeHtml(String(model.items.length))} 条，共 ${escapeHtml(String(model.total))} 条；「按类型」里可以按类别查看更早的记录。</p>`
    : "";
  container.innerHTML = filterNote + overflowNote + model.items.map((item) => incidentCardHtml(item, { withViewOps, withRemedy, contextHtml: contextOf(item.incidentId) })).join("") + truncatedNote;
}

// 一张事件卡片（纯函数，可单测）：标题行（严重度 · 名字 · 服务器 · 已持续）→ 时刻与次数 →（磁盘详情）→
// 建议处置（能一键处置的给按钮与预期效果）→ 最近一次处置的结果 → 操作 →（展开的前后经过）。
export function incidentCardHtml(item, { withViewOps = false, withRemedy = false, contextHtml = "" } = {}) {
  const open = item.lifecycle === "open";
  const id = escapeHtml(item.incidentId);
  const remedy = open ? item.remedy : null;
  const pending = item.disposition?.outcome === null;
  let remedyHtml = "";
  if (remedy?.action && withRemedy) {
    remedyHtml = `
      <div class="incident-remedy">
        <p><b>建议处置</b>${escapeHtml(remedy.expect)}</p>
        <button type="button" class="btn btn-secondary" data-remedy="${escapeHtml(remedy.action)}" data-server-id="${escapeHtml(item.serverId)}"${pending ? " disabled" : ""}>${escapeHtml(pending ? "处置复核中…" : remedy.label)}</button>
      </div>`;
  } else if (remedy?.advice) {
    remedyHtml = `
      <div class="incident-remedy" data-kind="advice"><p><b>下一步</b>${escapeHtml(remedy.advice)}</p></div>`;
  }
  const disposition = item.disposition
    ? `
      <p class="incident-disp" data-tone="${escapeHtml(item.disposition.tone)}"><b>处置</b>${escapeHtml(item.disposition.text)}${item.disposition.outcome === "not-recovered" && open ? "：重启解决不了，建议「复制排障信息」发给管理员" : ""}</p>`
    : "";
  return `
    <div class="incident-item ${item.severityClass}" data-incident-id="${id}">
      <div class="incident-head">
        <span class="incident-sev">${escapeHtml(item.severityLabel)}</span>
        <span class="incident-title">${escapeHtml(item.title)}</span>
        <span class="incident-server">${escapeHtml(item.serverLabel)}</span>
        ${open && !item.continuous && item.durationText ? `<span class="incident-when">${escapeHtml(item.durationText)}</span>` : ""}
      </div>
      <div class="incident-meta">
        <span>首次 ${escapeHtml(item.firstSeenText)}</span>
        <span>最近 ${escapeHtml(item.lastSeenText)}</span>
        ${occurrenceMetaHtml(item)}
        ${item.recurrenceText ? `<span class="incident-recur" title="同一类 15 分钟内接连发生">${escapeHtml(item.recurrenceText)}</span>` : ""}
        ${item.acknowledged ? `<span class="incident-flag">已确认${item.continuous ? "（用量再涨 2% 会重新提醒）" : ""}</span>` : ""}
        ${item.snoozed ? '<span class="incident-flag">已稍后提醒</span>' : ""}
        ${item.lifecycle === "resolved" ? `<span class="incident-flag">已恢复于 ${escapeHtml(item.resolvedAtText)}</span>` : ""}
      </div>${item.detailText ? `
      <p class="incident-detail">${escapeHtml(item.detailText)}</p>` : ""}${remedyHtml}${disposition}
      <div class="incident-actions">
        <button type="button" class="text-btn" data-incident-context="${id}" aria-expanded="${contextHtml ? "true" : "false"}">${contextHtml ? "收起前后经过" : "前后经过"}</button>
        <button type="button" class="text-btn" data-copy-incident="${id}">复制排障信息</button>
        <button type="button" class="text-btn" data-incident-report="${id}" data-report-server="${escapeHtml(item.serverId || "global")}">排障报告</button>
        ${open && !item.acknowledged ? `<button type="button" class="text-btn" data-attention="acknowledge" data-id="${id}">确认已看到</button>` : ""}
        ${open && !item.snoozed ? `<button type="button" class="text-btn" data-attention="snooze" data-id="${id}">稍后提醒（1 小时）</button>` : ""}
        ${open && item.snoozed ? `<button type="button" class="text-btn" data-attention="unsnooze" data-id="${id}">取消稍后提醒</button>` : ""}
        ${item.relatedOperationIds.length && withViewOps ? `<button type="button" class="text-btn" data-view-ops="${escapeHtml(item.relatedOperationIds.at(-1))}">查看处置日志</button>` : ""}
      </div>${contextHtml}
    </div>`;
}

// 次数 / 持续：持续性状态显示当前用量与已持续时长，其余显示检测次数。
function occurrenceMetaHtml(item) {
  if (!item.continuous) return `<span>检测 ${escapeHtml(String(item.occurrences))} 次</span>`;
  const pct = item.usedPct != null ? `<span>当前 ${escapeHtml(String(item.usedPct))}%</span>` : "";
  return `${pct}<span>已持续 ${escapeHtml(item.ongoingText || "—")}</span>`;
}

// ---- 已恢复 · 按类型汇总的表格 ----

const SUMMARY_COLUMNS = 6;

function summaryChildHtml(row, withViewOps) {
  if (!row.recent.length) return '<p class="ev-more">这一类的逐条记录已清理，只留下每天的次数。</p>';
  const items = row.recent.map((item) => `
          <li><span class="ev-when">${escapeHtml(item.whenText)}</span>${item.durationText ? `<span>${escapeHtml(item.durationText)}</span>` : ""}${item.occurrencesText ? `<span>${escapeHtml(item.occurrencesText)}</span>` : ""}${item.operationId && withViewOps ? `<button type="button" class="text-btn" data-view-ops="${escapeHtml(item.operationId)}">相关日志</button>` : ""}</li>`).join("");
  const more = row.moreCount > 0
    ? `
          <li class="ev-more"><span>还有 ${escapeHtml(String(row.moreCount))} 条更早的记录</span><button type="button" class="text-btn" data-view-type="${escapeHtml(row.key)}">查看这一类留存的全部 ${escapeHtml(String(row.retained))} 条</button></li>`
    : "";
  return `<ul class="ev-children">${items}${more}
        </ul>`;
}

// 表格模型 → HTML（纯函数，可单测）。model.ready 为 false 时由调用方决定显示加载还是取不到。
export function incidentSummaryHtml(model, { withViewOps = false } = {}) {
  if (model.empty) {
    return emptyStateHtml({
      tone: "neutral", icon: "inbox", title: "还没有已恢复的事件",
      body: `事件恢复后会归档到这里，按类型汇总近 ${model.windowDays} 天的次数、最近一次和典型持续时长；每类保留最近 ${model.keepPerType} 条逐条记录。`,
    });
  }
  const days = model.windowDays;
  const keyHtml = (heats) => `<span class="ev-strip ev-strip-key" aria-hidden="true">${heats.map((heat) => `<i data-heat="${heat}"></i>`).join("")}</span>`;
  const clearedTitle = `每类只留最近 ${model.keepPerType} 条逐条记录，更早的已清理${model.sinceText ? `；${model.sinceText} 起另记每天的次数，不再受这个上限影响` : ""}`;
  const body = model.rows.map((row, index) => {
    const detailId = `incidentTypeDetail-${index}`;
    const strip = row.cells.map((cell) => `<i data-heat="${escapeHtml(cell.heat)}" title="${escapeHtml(cell.title)}"></i>`).join("");
    return `
      <tr class="ev-row ${row.severityClass}" data-type-key="${escapeHtml(row.key)}"${row.expanded ? ' data-open="true"' : ""}>
        <td class="ev-type"><button type="button" class="ev-toggle" aria-expanded="${row.expanded ? "true" : "false"}" aria-controls="${detailId}" title="${row.expanded ? "收起逐条记录" : "展开这一类最近的逐条记录"}"><span class="ev-caret" aria-hidden="true">▸</span><span class="incident-sev">${escapeHtml(row.severityLabel)}</span><span class="ev-title">${escapeHtml(row.title)}</span></button></td>
        <td>${escapeHtml(row.serverLabel)}</td>
        <td class="ev-num${row.count ? "" : " is-zero"}"${row.countTitle ? ` title="${escapeHtml(row.countTitle)}"` : ""}>${escapeHtml(row.countText)}</td>
        <td${row.lastTitle ? ` title="${escapeHtml(row.lastTitle)}"` : ""}><span class="ev-main">${escapeHtml(row.lastText)}</span>${row.lastAgo ? ` <span class="ev-sub">· ${escapeHtml(row.lastAgo)}</span>` : ""}</td>
        <td title="${escapeHtml(row.durationTitle)}"><span class="ev-main">${escapeHtml(row.durationMain)}</span>${row.durationSub ? ` <span class="ev-sub">· ${escapeHtml(row.durationSub)}</span>` : ""}</td>
        <td><span class="ev-strip" role="img" aria-label="${escapeHtml(row.stripLabel)}">${strip}</span></td>
      </tr>
      <tr class="ev-child" id="${detailId}"${row.expanded ? "" : " hidden"}>
        <td colspan="${SUMMARY_COLUMNS}">${row.expanded ? summaryChildHtml(row, withViewOps) : ""}</td>
      </tr>`;
  }).join("");
  return `
    <table class="ev-table">
      <caption class="ev-caption">已恢复事件按类型汇总</caption>
      <colgroup><col class="ev-col-type"><col class="ev-col-server"><col class="ev-col-count"><col class="ev-col-last"><col class="ev-col-duration"><col class="ev-col-strip"></colgroup>
      <thead><tr><th scope="col">类型</th><th scope="col">服务器</th><th scope="col" class="ev-num" title="近 ${days} 天内恢复的事件数">次数</th><th scope="col">最近一次</th><th scope="col" title="按每类留存的逐条记录统计">典型持续</th><th scope="col">近 ${days} 天</th></tr></thead>
      <tbody>${body}
      </tbody>
    </table>
    <p class="ev-legend"><span>每格一天</span>${keyHtml([0, 1, 2, 3, 4])}<span>少 → 多</span>${model.capped ? `${keyHtml(["none"])}<span title="${escapeHtml(clearedTitle)}">记录已清理</span>` : ""}<span class="ev-legend-note">次数按近 ${days} 天统计 · 逐条记录每类最多保留最近 ${escapeHtml(String(model.keepPerType))} 条</span></p>`;
}

// 汇总从没取到过（failed）：说明取不到并给「改看逐条」（逐条列表是另一个接口，常常还能取到）。
// 汇总随每次状态刷新自动重拉，所以不另放「重试」。
export function incidentSummaryPlaceholderHtml({ failed = false } = {}) {
  if (!failed) return '<p class="incidents-empty">正在加载事件…</p>';
  return emptyStateHtml({
    tone: "error", icon: "cloudOff", title: "暂时取不到按类型汇总",
    body: "稍后会自动重试；也可以先切到「逐条」查看。",
    actions: [{ label: "改看逐条", kind: "text", attrs: { "data-show-each": "" } }],
  });
}

const summaryHandlers = { onToggle: null, onViewOps: null, onViewType: null, onShowEach: null };
function onIncidentSummaryClick(event) {
  const origin = event.target instanceof Element ? event.target : null;
  if (!origin) return;
  const { onToggle, onViewOps, onViewType, onShowEach } = summaryHandlers;
  if (origin.closest("[data-show-each]")) {
    if (typeof onShowEach === "function") onShowEach();
    return;
  }
  const action = origin.closest("[data-view-ops],[data-view-type]");
  if (action) {
    if (action.dataset.viewOps && typeof onViewOps === "function") onViewOps(action.dataset.viewOps);
    else if (action.dataset.viewType && typeof onViewType === "function") onViewType(action.dataset.viewType);
    return;
  }
  // 点类型行的任何位置都展开 / 收起（行首的按钮只是给键盘与读屏的入口）；展开出来的子行不算。
  const row = origin.closest("[data-type-key]");
  if (row?.dataset.typeKey && typeof onToggle === "function") onToggle(row.dataset.typeKey);
}

// 已恢复事件按类型汇总。payload 为 null 表示还没拿到；failed = 最近一次请求失败（且从没成功过）。
// 返回 { badge, model }：标题旁徽标要显示的文字，以及表格模型（没有可用数据时为 null）。
export function renderIncidentSummary(payload, { nowMs = Date.now(), status = null, expanded = null, failed = false, onToggle, onViewOps, onViewType, onShowEach } = {}) {
  const model = buildIncidentSummaryModel(payload, { nowMs, status, expanded });
  const usable = model.ready ? model : null;
  const result = { badge: usable ? usable.badge : "已恢复", model: usable };
  const container = getEl("incidentSummary");
  if (!container) return result;
  summaryHandlers.onToggle = onToggle;
  summaryHandlers.onViewOps = onViewOps;
  summaryHandlers.onViewType = onViewType;
  summaryHandlers.onShowEach = onShowEach;
  bindClicksOnce(container, onIncidentSummaryClick);
  renderIncidentSummaryMemo(container, usable, { failed, withViewOps: typeof onViewOps === "function" });
  return result;
}

// 签名 = 表格模型本身（相对时间文案按分钟粒度变化，至多每分钟重渲一次）。
const renderIncidentSummaryMemo = createMemoRender(
  (container, model, { failed, withViewOps }) => {
    if (model) patchHtml(container, incidentSummaryHtml(model, { withViewOps }));
    else patchHtml(container, incidentSummaryPlaceholderHtml({ failed }));
  },
  (container, model, { failed, withViewOps }) => `${containerId(container)}\u0002${failed ? 1 : 0}${withViewOps ? 1 : 0}\u0002${model ? JSON.stringify(model) : ""}`,
);

// 概览摘要（≤3 条）：只渲染，不改判断。签名 = 摘要模型本身（相对时间文案按分钟粒度变化，至多每分钟重渲一次）。
export function renderOverviewIncidentSummary(model) {
  if (!getEl("overviewIncidentSummary")) return;
  renderOverviewIncidentSummaryMemo(buildOverviewIncidentSummary(model));
}

const renderOverviewIncidentSummaryMemo = createMemoRender(
  (summary) => renderOverviewIncidentSummaryDom(summary),
  (summary) => JSON.stringify(summary),
);

function renderOverviewIncidentSummaryDom(summary) {
  const container = getEl("overviewIncidentSummary");
  const badge = getEl("overviewIncidentBadge");
  if (!container) return;
  if (badge) {
    badge.textContent = summary.count > 0 ? `待处理 ${summary.count}` : "无待处理";
    badge.dataset.tone = summary.count > 0 ? "" : "ok";
  }
  // 侧栏「事件」的数字与这里同一口径（细栏时变成图标上的小红点，shell.css）
  const navCount = getEl("eventsNavCount");
  if (navCount) {
    navCount.hidden = summary.count === 0;
    navCount.textContent = summary.count > 0 ? String(summary.count) : "";
  }
  // 没有待处理事件时整块收成一行（只留表头，已确认 / 稍后提醒的条数写进表头提示）：
  // 首屏让给链路与简报；有事件时照常展开。
  const panel = container.closest?.(".panel-overview-events");
  const hint = getEl("overviewIncidentHint");
  panel?.classList.toggle("is-collapsed", summary.count === 0);
  if (hint) hint.textContent = summary.count === 0 && summary.quiet > 0 ? `${summary.quiet} 条已确认或稍后提醒` : "";
  if (summary.count === 0) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = summary.items.map((item) => `
    <div class="overview-incident-row ${item.severityClass}">
      <span class="incident-sev">${escapeHtml(item.severityLabel)}</span>
      <span class="incident-title">${escapeHtml(item.title)}</span>
      <span class="incident-server">${escapeHtml(item.serverLabel)}</span>
      <span class="incident-meta-inline">${item.continuous
        ? `${item.usedPct != null ? `当前 ${escapeHtml(String(item.usedPct))}% · ` : ""}已持续 ${escapeHtml(item.ongoingText || "—")}`
        : `检测 ${escapeHtml(String(item.occurrences))} 次${item.recurrenceText ? ` · ${escapeHtml(item.recurrenceText)}` : ""}`}</span>
    </div>`).join("")
    + (summary.hidden > 0 ? `<p class="incidents-overflow">其余 ${escapeHtml(String(summary.hidden))} 条见「事件」视图。</p>` : "")
    + (summary.quiet > 0 ? `<p class="incidents-overflow">另有 ${escapeHtml(String(summary.quiet))} 条已确认或稍后提醒，见「事件」视图。</p>` : "");
}
