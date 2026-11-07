// render/incident-insights.js —— 事件中心的「看懂 → 处置 → 复核」（纯函数 + HTML 片段，Node 可直接 import 测试）：
//   - incidentRemedy：原因 → 建议处置（能一键处置的给按钮与预期效果，处置不了的给明确的下一步）
//   - dispositionView：事件上的处置记录（lib/incidents/disposition.mjs）→「02:31 手动重启这条隧道 → 38 秒后恢复」
//   - recurrenceText：未解决事件的「25 分钟内第 8 次」（lib/incidents/clusters.mjs 的 recurrenceOf）
//   - contextEntryView / incidentContextHtml：事件前后经过的小时间轴（GET /api/incidents/:id/context）
//   - buildIncidentCopyText：可复制的排障信息（纯文本，贴给同事 / 集群管理员）
//   - buildClusterModel / clusterCardHtml：已恢复「逐条」改成事件簇卡片（GET /api/incidents?group=cluster）
// 名字（事件标题、服务器名）由调用方的 titleOf / serverLabelOf 给出，本模块不认识原因码与显示名的翻译表
// （那两张表在 incidents.js，避免循环依赖）。时刻一律北京时间（usage-model.js）。
import { escapeHtml } from "../store.js";
import { causeLabel } from "./tunnel-stability-model.js";
import { clockOf, dateTimeOf, dayKeyOf, TZ_LABEL } from "./usage-model.js";

const finite = (value) => (Number.isFinite(value) ? value : null);
const isTime = (ms) => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;
const clock = (ms, seconds = false) => (isTime(ms) ? clockOf(ms / 1000, { seconds }) : "—");
const dayOf = (ms) => dayKeyOf(ms / 1000);

// 「38 秒」「2 分 5 秒」「1 小时 12 分」「3 天 4 小时」
export function spanText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} 天 ${h % 24} 小时` : `${d} 天`;
}

// 统计量用的粗粒度时长（「累计 14 分钟」「跨 1 小时 12 分」）：满 1 分钟后不再带秒。
export function roughSpanText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return spanText(ms);
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
  return spanText(m * 60_000);
}

// 当天只显示时刻，跨天前缀「MM-DD」。
function momentText(ms, nowMs, seconds = false) {
  if (!isTime(ms)) return "—";
  const day = dayOf(ms);
  return day === dayOf(nowMs) ? clock(ms, seconds) : `${day.slice(5)} ${clock(ms, seconds)}`;
}

// ---- 建议处置 ----

// 处置动作：restart-tunnel = 只重启这条隧道（单隧道重启，要 supervisor 声明能力）；restart-channel = 一键修复（所有连接）。
// 返回 { action | null, label, expect, advice }：action 为 null 时没有一键处置，只给 advice（下一步该做什么）。
const TUNNEL_EXPECT = "只重连这台服务器，其它连接不受影响；通常 10–30 秒内重连，连续两次检测正常后事件自动恢复。";
const CHANNEL_EXPECT = "先停后起本地代理与全部 SSH 隧道，期间所有连接会中断约 30–60 秒；恢复后事件自动关闭。";
const NO_RESTART = "重启连接解决不了这类问题。";
const AGENT_ADVICE = {
  AUTH_REQUIRED: "需要在集群上重新登录：到「配置 → Agent」用登录引导重新登录。",
  ACCOUNT_REVOKED: "账号授权被吊销，属于账号层故障：联系账号管理员重新授权或换号。",
  ACCOUNT_BANNED: "账号被封禁，属于账号层故障：联系账号管理员处理。",
  AGENT_MISSING: "集群上找不到这个 Agent 的命令：到「Doctor」页看安装位置，或在「配置 → Agent」重新安装。",
  DEGRADED: "到「Doctor」页看警告行定位降级原因；连接正常时多为 Agent 自身或上游服务的问题。",
  AGENT_ATTENTION: "到「Doctor」页看具体提示。",
};

export function incidentRemedy(item, { canScoped = false } = {}) {
  const src = item && typeof item === "object" ? item : {};
  const codes = String(src.reasonCode || "").split("+");
  if (src.lifecycle === "resolved") return null;
  if (src.component === "tunnel" && src.serverId) {
    return canScoped
      ? { action: "restart-tunnel", label: "重启这条隧道", expect: TUNNEL_EXPECT, advice: "" }
      : { action: "restart-channel", label: "一键修复（所有连接）", expect: `后台组件还不支持只重启单条隧道，${CHANNEL_EXPECT}`, advice: "" };
  }
  if (src.component === "channel") {
    if (codes.includes("MANUALLY_STOPPED")) return { action: null, label: "", expect: "", advice: "通道是手动停止的：点侧栏「控制」重新启动。" };
    return { action: "restart-channel", label: "一键修复（所有连接）", expect: CHANNEL_EXPECT, advice: "" };
  }
  if (src.component === "agent") {
    const advice = AGENT_ADVICE[codes[0]] || AGENT_ADVICE.AGENT_ATTENTION;
    return { action: null, label: "", expect: "", advice: codes[0] === "DEGRADED" || codes[0] === "AGENT_ATTENTION" ? advice : `${advice}${NO_RESTART}` };
  }
  if (src.component === "filesystem") {
    if (codes.includes("DISK_THRESHOLD")) return { action: null, label: "", expect: "", advice: "清理 $HOME 下不用的大文件（作业输出、缓存、旧模型）；用量回到 88% 以下且连续两次检测后自动恢复。" };
    return { action: null, label: "", expect: "", advice: `共享存储读写缓慢多为集群侧问题，${NO_RESTART}可复制排障信息给集群管理员。` };
  }
  return null;
}

// ---- 处置记录 ----

const ACTION_LABELS = { "restart-tunnel": "重启这条隧道", "restart-channel": "重启所有连接" };

// 一条处置 → { text, tone, outcome }。tone：ok 恢复 / warn 未恢复 / pending 等待复核。
export function dispositionView(d, { nowMs = Date.now() } = {}) {
  if (!d || typeof d !== "object" || !isTime(d.at)) return null;
  const who = d.trigger === "auto" ? "自动修复" : "手动";
  const head = `${momentText(d.at, nowMs)} ${who}${ACTION_LABELS[d.action] || ACTION_LABELS["restart-channel"]}`;
  const after = finite(d.afterMs);
  if (d.outcome === "recovered") return { text: `${head} → ${after != null ? `${spanText(after)}后恢复` : "已恢复"}`, tone: "ok", outcome: "recovered" };
  if (d.outcome === "recovered-late") return { text: `${head} → 当时未见效，${after != null ? `${spanText(after)}后才恢复` : "之后才恢复"}`, tone: "warn", outcome: "recovered-late" };
  if (d.outcome === "not-recovered") return { text: `${head} → 3 分钟后仍未恢复`, tone: "warn", outcome: "not-recovered" };
  return { text: `${head} → 正在复核（恢复要连续两次检测正常）`, tone: "pending", outcome: null };
}

// 事件上最近一次处置（卡片只显示这一条，完整记录在前后经过里）。
export function latestDisposition(item, { nowMs = Date.now() } = {}) {
  const list = Array.isArray(item?.dispositions) ? item.dispositions : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const view = dispositionView(list[i], { nowMs });
    if (view) return view;
  }
  return null;
}

// ---- 短时间内第几次 ----

// 「25 分钟」「2 小时」：只取一个单位（「多久之内」不需要精确到秒）。
function withinText(ms) {
  const minutes = Math.max(1, Math.ceil(Math.max(0, ms) / 60000));
  if (minutes < 120) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`;
}

export function recurrenceText(recurrence, { nowMs = Date.now(), continuous = false } = {}) {
  const r = recurrence && typeof recurrence === "object" ? recurrence : null;
  if (!r || !Number.isFinite(r.count) || r.count < 2 || !isTime(r.sinceAt)) return "";
  const head = `${withinText(nowMs - r.sinceAt)}内第 ${r.count} 次`;
  if (continuous || !Number.isFinite(r.downMs) || r.downMs <= 0) return head;
  return `${head}（之前 ${r.count - 1} 次累计 ${roughSpanText(r.downMs)}）`;
}

// ---- 前后经过 ----

const SCOPE_NOTES = { view: "当时查看的服务器", local: "本机" };
const LOG_KIND_TEXT = {
  handoff: "后台组件热更新交接",
  "self-update": "工作台自更新",
  network: "本机网络切换",
};

// 一条时间轴条目 → { time, text, tone, self, note }。tone：bad / ok / warn / info。
// titleOf(entry)：其它事件的「隧道 · 连接断开 · GPU 节点 B」（调用方按界面用语拼）。
export function contextEntryView(entry, { nowMs = Date.now(), titleOf = () => "另一事件" } = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  if (!isTime(e.at)) return null;
  const base = { time: momentText(e.at, nowMs, true), self: Boolean(e.self), note: SCOPE_NOTES[e.scope] || "" };
  switch (e.kind) {
    case "incident-open":
      return { ...base, tone: e.self ? "bad" : "warn", text: e.self ? "本事件开始（首次检测到）" : `${titleOf(e)} 开始` };
    case "incident-resolved":
      return { ...base, tone: "ok", text: e.self ? "本事件恢复（连续两次检测正常）" : `${titleOf(e)} 恢复` };
    case "tunnel-down": {
      const tags = [e.planned ? "计划内" : "", e.networkChange ? "换网" : "", e.sleep ? "休眠期间" : ""].filter(Boolean);
      return { ...base, tone: e.planned || e.sleep ? "warn" : "bad", text: `隧道断开 · ${causeLabel(e.cause)}${tags.length ? `（${tags.join("、")}）` : ""}` };
    }
    case "tunnel-up": {
      const parts = [Number.isFinite(e.downMs) ? `断开 ${spanText(e.downMs)}` : "", Number.isFinite(e.attempts) && e.attempts > 1 ? `第 ${e.attempts} 次尝试` : "", e.via === "restart" ? "重启后" : ""].filter(Boolean);
      return { ...base, tone: "ok", text: `隧道重连${parts.length ? `（${parts.join("，")}）` : ""}` };
    }
    case "sleep":
      return { ...base, tone: "warn", text: `电脑休眠 ${spanText(e.sleptMs)}${isTime(e.wokeAt) ? `，${clock(e.wokeAt)} 醒来` : ""}` };
    case "config":
      return { ...base, tone: "warn", text: e.scope ? (e.event === "config-audit" ? "服务器配置被修改" : "配置文件改动，已热载") : "配置变更，隧道按计划重连" };
    case "signal":
      return { ...base, tone: e.severity === "error" ? "bad" : "warn", text: `卡顿信号：${e.title || e.signalId || "未知"}` };
    case "monitor-start":
      return { ...base, tone: e.unclean ? "warn" : "info", text: e.unclean ? "监控服务启动（上次非正常退出）" : "监控服务启动" };
    case "monitor-stop":
      return { ...base, tone: "info", text: "监控服务停止" };
    case "disposition": {
      const view = dispositionView(e, { nowMs });
      return view ? { ...base, tone: view.tone === "pending" ? "info" : view.tone, text: view.text.replace(/^\S+ /, "") } : null;
    }
    case "auto-repair":
      return { ...base, tone: "info", text: `自动修复${e.ruleId ? `（${e.ruleId}）` : ""}` };
    default:
      return LOG_KIND_TEXT[e.kind] ? { ...base, tone: "info", text: LOG_KIND_TEXT[e.kind] } : null;
  }
}

// 时间轴 HTML。payload = null 加载中；failed = 取不到。
export function incidentContextHtml(payload, { nowMs = Date.now(), titleOf, failed = false } = {}) {
  if (failed) return '<p class="ev-ctx-empty">暂时取不到前后经过，稍后再展开试试。</p>';
  if (!payload) return '<p class="ev-ctx-empty">正在整理前后经过…</p>';
  const entries = (Array.isArray(payload.entries) ? payload.entries : []).map((entry) => ({ entry, view: contextEntryView(entry, { nowMs, titleOf }) })).filter((x) => x.view);
  const gap = payload.gap && isTime(payload.gap.from) && isTime(payload.gap.to) ? payload.gap : null;
  const range = isTime(payload.from) && isTime(payload.to) ? `${momentText(payload.from, nowMs)} – ${momentText(payload.to, nowMs)}` : "";
  const rows = [];
  let gapShown = false;
  for (const { entry, view } of entries) {
    if (gap && !gapShown && entry.at > gap.from) {
      rows.push(`<li class="ev-ctx-gap">中间 ${escapeHtml(spanText(gap.to - gap.from))} 省略</li>`);
      gapShown = true;
    }
    rows.push(`<li data-tone="${view.tone}"${view.self ? ' data-self="true"' : ""}><time>${escapeHtml(view.time)}</time><span>${escapeHtml(view.text)}${view.note ? ` <em>· ${escapeHtml(view.note)}</em>` : ""}</span></li>`);
  }
  const truncated = Number.isFinite(payload.truncated) && payload.truncated > 0 ? `<p class="ev-ctx-note">另有 ${escapeHtml(String(payload.truncated))} 条离开始 / 结束较远的记录未列出。</p>` : "";
  const onlySelf = entries.every(({ entry }) => entry.self);
  const hint = onlySelf ? '<p class="ev-ctx-note">这段时间没有别的相关记录（断线账本、休眠、配置、处置、卡顿信号都没有动静）。</p>' : "";
  return `<p class="ev-ctx-head">前后经过 · ${escapeHtml(range)}（${escapeHtml(TZ_LABEL)}）</p><ol class="ev-ctx">${rows.join("")}</ol>${truncated}${hint}`;
}

// ---- 可复制的排障信息 ----

// item：incidents.js 的列表模型条目（带原始字段 raw）。纯文本，按「是什么 / 多久 / 做过什么 / 证据」排。
export function buildIncidentCopyText(item, { nowMs = Date.now(), context = null, titleOf } = {}) {
  const raw = item?.raw && typeof item.raw === "object" ? item.raw : {};
  const lines = [];
  const at = (ms) => (isTime(ms) ? `${dateTimeOf(ms / 1000)}` : "—");
  lines.push(`【事件】${item?.title || "—"}（${raw.reasonCode || "UNKNOWN"}）`);
  lines.push(`服务器：${item?.serverLabel || "—"}${raw.serverId ? `（${raw.serverId}）` : ""}`);
  const state = raw.lifecycle === "resolved" ? `已恢复于 ${at(raw.resolvedAt)}` : `未解决 · 已持续 ${spanText(nowMs - raw.firstSeenAt)}`;
  lines.push(`状态：${state} · ${item?.severityLabel || ""}`);
  lines.push(`首次：${at(raw.firstSeenAt)}　最近：${at(raw.lastSeenAt)}　检测 ${Number.isFinite(raw.occurrences) ? raw.occurrences : 1} 次（${TZ_LABEL}）`);
  const rec = recurrenceText(raw.recurrence, { nowMs });
  if (rec) lines.push(`近况：${rec}`);
  for (const d of Array.isArray(raw.dispositions) ? raw.dispositions.slice(-3) : []) {
    const view = dispositionView(d, { nowMs });
    if (view) lines.push(`处置：${view.text}`);
  }
  const remedy = incidentRemedy(raw, { canScoped: true });
  if (remedy?.advice) lines.push(`建议：${remedy.advice}`);
  const evidence = (Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs : []).slice(-3).map((ev) => {
    if (!ev || typeof ev !== "object") return "";
    const bits = [ev.kind, ev.reason, ev.probeId, Number.isFinite(ev.usedPct) ? `${ev.usedPct}%` : ""].filter((x) => typeof x === "string" && x);
    return bits.join(" · ");
  }).filter(Boolean);
  if (evidence.length) lines.push(`证据：${evidence.join("；")}`);
  const ctxEntries = Array.isArray(context?.entries) ? context.entries : [];
  if (ctxEntries.length) {
    lines.push("前后经过：");
    for (const entry of ctxEntries.slice(0, 30)) {
      const view = contextEntryView(entry, { nowMs, titleOf });
      if (view) lines.push(`  ${view.time} ${view.text}${view.note ? `（${view.note}）` : ""}`);
    }
  }
  lines.push(`事件 ID：${raw.incidentId || "—"}`);
  return lines.join("\n");
}

// ---- 事件簇（已恢复「逐条」）----

// payload = GET /api/incidents?group=cluster 的响应。titleOf / serverLabelOf 由调用方给（界面用语）。
// expanded = 展开着的簇 id 集合。
export function buildClusterModel(payload, { nowMs = Date.now(), titleOf = () => "", serverLabelOf = () => "", severityOf = (s) => s, expanded = null } = {}) {
  const src = payload && typeof payload === "object" ? payload : {};
  const clusters = (Array.isArray(src.clusters) ? src.clusters : []).map((raw) => {
    const c = raw && typeof raw === "object" ? raw : {};
    if (typeof c.clusterId !== "string" || !c.clusterId || !isTime(c.firstSeenAt)) return null;
    const count = Number.isFinite(c.count) && c.count > 0 ? c.count : 1;
    const last = isTime(c.lastSeenAt) ? c.lastSeenAt : c.firstSeenAt;
    const continuous = c.reasonCode === "DISK_THRESHOLD";
    const members = (Array.isArray(c.members) ? c.members : []).filter((m) => m && typeof m.incidentId === "string" && isTime(m.firstSeenAt)).map((m) => ({
      incidentId: m.incidentId,
      whenText: `${momentText(m.firstSeenAt, nowMs, true)}${isTime(m.resolvedAt) ? ` – ${clock(m.resolvedAt, true)}` : " 起"}`,
      durationText: isTime(m.resolvedAt) ? `持续 ${spanText(Math.max(0, m.resolvedAt - m.firstSeenAt))}` : "未恢复",
      occurrencesText: continuous ? "" : `检测 ${Number.isFinite(m.occurrences) ? m.occurrences : 1} 次`,
      operationId: Array.isArray(m.relatedOperationIds) && typeof m.relatedOperationIds.at(-1) === "string" ? m.relatedOperationIds.at(-1) : "",
      disposition: latestDisposition(m, { nowMs })?.text || "",
    }));
    const severity = severityOf(c.severity);
    return {
      clusterId: c.clusterId,
      serverId: typeof c.serverId === "string" ? c.serverId : "",
      severity,
      title: titleOf(c),
      serverLabel: serverLabelOf(c.serverId),
      count,
      open: Boolean(c.open),
      rangeText: count > 1 ? `${momentText(c.firstSeenAt, nowMs)} – ${momentText(last, nowMs)}` : momentText(c.firstSeenAt, nowMs, true),
      spanText: count > 1 && Number.isFinite(c.spanMs) ? roughSpanText(c.spanMs) : "",
      // 「7 次 · 累计断开 14 分钟」：持续型（磁盘）不说断开
      summaryText: count > 1
        ? `${count} 次 · 累计${continuous ? "超阈值" : "故障"} ${roughSpanText(c.downMs)}`
        : `持续 ${roughSpanText(c.downMs)}${continuous ? "" : ` · 检测 ${Number.isFinite(c.occurrences) ? c.occurrences : 1} 次`}`,
      resolvedText: c.open ? "仍有未恢复" : `已恢复于 ${momentText(last, nowMs)}`,
      expanded: Boolean(expanded && typeof expanded.has === "function" && expanded.has(c.clusterId)),
      members,
      moreCount: Math.max(0, count - members.length),
      // 单条的簇：前后经过 / 排障报告直接对那一条
      latestIncidentId: members[0]?.incidentId || c.clusterId,
      operationId: Array.isArray(c.operationIds) && typeof c.operationIds[0] === "string" ? c.operationIds[0] : "",
    };
  }).filter(Boolean);
  return {
    total: Number.isFinite(src.total) ? src.total : clusters.length,
    incidentTotal: Number.isFinite(src.incidentTotal) ? src.incidentTotal : clusters.reduce((sum, c) => sum + c.count, 0),
    clusters,
    empty: clusters.length === 0,
  };
}

const SEV_LABELS = { error: "严重", warn: "警告", info: "提示" };

export function clusterCardHtml(c, { withViewOps = false, contextHtml = "" } = {}) {
  const sevClass = `sev-${SEV_LABELS[c.severity] ? c.severity : "warn"}`;
  const listId = `incidentCluster-${c.clusterId}`;
  const members = c.expanded && c.count > 1
    ? `<ul class="ev-cluster-members" id="${escapeHtml(listId)}">${c.members.map((m) => `<li><span class="ev-member-when">${escapeHtml(m.whenText)}</span><span>${escapeHtml(m.durationText)}</span>${m.occurrencesText ? `<span>${escapeHtml(m.occurrencesText)}</span>` : ""}${m.disposition ? `<span class="ev-disp">${escapeHtml(m.disposition)}</span>` : ""}<button type="button" class="text-btn" data-incident-context="${escapeHtml(m.incidentId)}">前后经过</button>${m.operationId && withViewOps ? `<button type="button" class="text-btn" data-view-ops="${escapeHtml(m.operationId)}">处置日志</button>` : ""}</li>`).join("")}${c.moreCount ? `<li class="ev-more"><span>另有 ${escapeHtml(String(c.moreCount))} 次更早的记录未列出</span></li>` : ""}</ul>`
    : "";
  const toggle = c.count > 1
    ? `<button type="button" class="text-btn" data-cluster-toggle="${escapeHtml(c.clusterId)}" aria-expanded="${c.expanded ? "true" : "false"}"${c.expanded ? ` aria-controls="${escapeHtml(listId)}"` : ""}>${c.expanded ? "收起逐次" : `展开 ${escapeHtml(String(c.count))} 次`}</button>`
    : `<button type="button" class="text-btn" data-incident-context="${escapeHtml(c.latestIncidentId)}">前后经过</button>`;
  return `
    <div class="incident-item incident-cluster ${sevClass}" data-cluster-id="${escapeHtml(c.clusterId)}" data-incident-id="${escapeHtml(c.latestIncidentId)}">
      <div class="incident-head">
        <span class="incident-sev">${escapeHtml(SEV_LABELS[c.severity] || "警告")}</span>
        <span class="incident-title">${escapeHtml(c.title)}</span>
        <span class="incident-server">${escapeHtml(c.serverLabel)}</span>
        ${c.count > 1 ? `<span class="ev-count" title="同一类 15 分钟内接连发生，合成一簇">×${escapeHtml(String(c.count))}</span>` : ""}
        <span class="incident-when">${escapeHtml(c.rangeText)}${c.spanText ? ` <span class="incident-when-sub">· ${escapeHtml(c.spanText)}</span>` : ""}</span>
      </div>
      <div class="incident-meta"><span>${escapeHtml(c.summaryText)}</span><span class="incident-flag">${escapeHtml(c.resolvedText)}</span></div>
      <div class="incident-actions">${toggle}<button type="button" class="text-btn" data-incident-report="${escapeHtml(c.latestIncidentId)}" data-report-server="${escapeHtml(c.serverId || "global")}">排障报告</button>${c.operationId && withViewOps && c.count === 1 ? `<button type="button" class="text-btn" data-view-ops="${escapeHtml(c.operationId)}">查看处置日志</button>` : ""}</div>${members}${contextHtml}
    </div>`;
}
