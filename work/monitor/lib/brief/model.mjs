// 今日简报（纯函数）：把各数据源已经算好的当日事实整理成「一句话结论 + 四格指标 + 值得留意」。
// 采集与取数在 service.mjs；本模块不读盘、不碰时钟（nowMs 由调用方给），便于测试与快照复现。
//
// 口径：
//   - 一天按北京时间 0 点起算（与用量页同一口径，见 lib/usage/time.mjs）；「今天」截到现在。
//   - 文案在这里生成并随快照落盘：归档的简报以当时的说法为准，不随以后的口径调整而变。
//   - 值得留意最多 3 条，严重（critical）→ 留意（warn）→ 提示（info），同级按发生时间新→旧。
//     每条带 at（发生时刻；持续性状态如磁盘、可升级为 null），前端据此标「上次查看之后新出现」。

import { BEIJING_OFFSET_MS } from "../beijing-time.mjs";
import { briefGrowthClause } from "../disk-growth/model.mjs";
import { normalizeHeadline } from "../jobs/diagnose.mjs";
import { jobOutcome } from "../jobs/model.mjs";

export const BRIEF_NOTES_MAX = 3;
const TONE_RANK = { critical: 3, warn: 2, info: 1, neutral: 0, ok: 0 };
// 电脑休眠不足这么久不值得单独说一句（与「断开满 10 分钟才单独提示」同一条线）。
const SLEEP_NOTE_MIN_MS = 10 * 60_000;

export const DROP_CAUSE_TEXT = Object.freeze({
  "keepalive-timeout": "心跳超时",
  "remote-closed": "服务器端断开",
  closed: "连接被关闭",
  reset: "连接被重置",
  "broken-pipe": "连接中断",
  "port-closed": "远端端口失联",
  "process-lost": "隧道进程消失",
  "network-change": "换网重建",
  sleep: "本机休眠",
  unknown: "原因未知",
});

const REASON_TEXT = Object.freeze({
  TUNNEL_DOWN: "隧道断开",
  REMOTE_PORT_CLOSED: "远端端口未开放",
  CHANNEL_ERROR: "通道异常",
  DEGRADED: "降级",
  AGENT_MISSING: "未安装",
  AUTH_REQUIRED: "需要重新登录",
  ACCOUNT_REVOKED: "账号授权被吊销",
  ACCOUNT_BANNED: "账号被封禁",
  AGENT_ATTENTION: "需要关注",
  DISK_THRESHOLD: "磁盘超阈值",
});

// 组合原因码（通道几段同时断开：TUNNEL_DOWN+REMOTE_PORT_CLOSED）逐段翻译后用顿号连起来。
export function reasonText(code) {
  return String(code || "").split("+").filter(Boolean).map((part) => REASON_TEXT[part] || part).join("、") || "未知原因";
}

const JOB_STATE_TEXT = Object.freeze({ TIMEOUT: "超时", OUT_OF_MEMORY: "内存不足", NODE_FAIL: "节点故障", BOOT_FAIL: "启动失败", DEADLINE: "超过截止时间", PREEMPTED: "被抢占" });

const pad = (n) => String(n).padStart(2, "0");
// 北京时间 HH:MM（UTC+8，无夏令时）
export function clockBj(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function monthDayBj(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}

export function tokensText(n) {
  if (!Number.isFinite(n) || n <= 0) return { value: "0", unit: " Token" };
  if (n >= 1e8) return { value: (n / 1e8).toFixed(2), unit: " 亿 Token" };
  if (n >= 1e4) return { value: (n / 1e4).toFixed(n >= 1e6 ? 0 : 1), unit: " 万 Token" };
  return { value: String(Math.round(n)), unit: " Token" };
}

function pctText(ratio) {
  return `${(Math.min(0.9999, ratio) * 100).toFixed(1)}%`;
}

function signedPct(ratio) {
  const pct = Math.round((ratio - 1) * 100);
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%`;
}

function dominantCause(causes = {}) {
  const top = Object.entries(causes).sort((a, b) => b[1] - a[1])[0];
  return top ? { cause: top[0], count: top[1] } : null;
}

// ---- 隧道 ----
// tunnels：[{ serverId, name, state, since, window: {drops, upMs, downMs, maxRecoveryMs, recoveries, causes}, drops: [{at, cause, recoveredAt, downMs}] }]
// sleep：{ ms, count, lastWakeAt } | null —— 统计区间里电脑休眠了多久（lib/tunnel-ledger-stats.mjs）。
// 休眠造成的断开不在 window.drops / drops 里（不出断线提示、不标红）；state 为 "sleep" 是醒来后还在重连，
// 也不当成「断开中」。当天有休眠时只多一条中性的说明。
function tunnelSection(tunnels, { nowMs, isToday, warming, rolling, dayStart, sleep = null }) {
  const notes = [];
  let drops = 0;
  let up = 0;
  let down = 0;
  let longest = 0;
  for (const t of tunnels) {
    const w = t.window || {};
    drops += Number(w.drops) || 0;
    up += Number(w.upMs) || 0;
    down += Number(w.downMs) || 0;
    longest = Math.max(longest, Number(w.maxRecoveryMs) || 0);
    if (isToday && t.state === "down" && Number.isFinite(t.since)) {
      longest = Math.max(longest, nowMs - t.since);
      notes.push({ key: `tunnel-down:${t.serverId}:${t.since}`, tone: "critical", at: t.since, link: "stability", text: `${t.name}断开中 · 已 ${humanDuration(nowMs - t.since)}` });
    }
    for (const d of t.drops || []) {
      const span = d.recoveredAt ? d.recoveredAt - d.at : null;
      if (span != null && span >= 10 * 60_000) {
        notes.push({ key: `tunnel-outage:${t.serverId}:${d.at}`, tone: "critical", at: d.at, link: "stability", text: `${t.name} ${d.at < dayStart ? "昨天 " : ""}${clockBj(d.at)}–${clockBj(d.recoveredAt)} 断开 ${humanDuration(span)}（${DROP_CAUSE_TEXT[d.cause] || DROP_CAUSE_TEXT.unknown}）` });
      }
    }
    const top = dominantCause(w.causes);
    if ((Number(w.drops) || 0) >= 3 && top) {
      notes.push({ key: `tunnel-drops:${t.serverId}`, tone: "warn", at: t.lastDropAt ?? null, link: "stability", text: `${t.name}断线 ${w.drops} 次，${top.count === w.drops ? "都是" : `${top.count} 次是`}${DROP_CAUSE_TEXT[top.cause] || DROP_CAUSE_TEXT.unknown}` });
    }
  }
  if (sleep && Number.isFinite(sleep.ms) && sleep.ms >= SLEEP_NOTE_MIN_MS) {
    const times = sleep.count > 1 ? ` ${sleep.count} 次共` : "";
    notes.push({ key: `sleep:${sleep.lastWakeAt ?? "day"}`, tone: "neutral", at: sleep.lastWakeAt ?? null, link: "stability", text: `电脑休眠${times} ${humanDuration(sleep.ms)}，期间隧道不可用` });
  }
  const observed = up + down;
  const availability = observed >= 10 * 60_000 ? up / observed : null;
  const ongoing = isToday && tunnels.some((t) => t.state === "down");
  const tone = ongoing || longest >= 10 * 60_000 ? "critical" : drops ? "warn" : "ok";
  let sub;
  if (warming && availability == null) sub = "账本记录不足 · 可用率稍后计算";
  else if (availability == null) sub = "暂无足够记录";
  else sub = `可用率 ${availability >= 1 ? "100%" : pctText(availability)}${drops ? ` · 最长断开 ${humanDuration(longest)}` : ""}`;
  return {
    stat: { key: "tunnel", label: rolling ? "隧道 · 近 24 小时" : "隧道", value: String(drops), unit: " 次断线", sub, tone: warming && drops === 0 ? "neutral" : tone, view: "stability" },
    notes,
    facts: { drops, longest, ongoing, allQuick: drops > 0 && longest < 60_000 },
  };
}

// ---- 事件 ----
// incidents：{ opened: n, resolved: n, pending: [{incidentId, serverName, reasonCode, agentId, firstSeenAt}], quiet: n }
function incidentSection(incidents, { nowMs, isToday }) {
  const pending = incidents.pending || [];
  const notes = isToday ? pending.slice(0, 2).map((i) => ({
    key: `incident:${i.incidentId}`,
    tone: "critical",
    at: i.firstSeenAt,
    link: "events",
    text: `${i.agentLabel ? `${i.agentLabel} ` : ""}${reasonText(i.reasonCode)} · ${i.serverName}（已持续 ${humanDuration(nowMs - i.firstSeenAt)}）`,
  })) : [];
  const openCount = isToday ? pending.length : null;
  const sub = isToday
    ? `${incidents.resolved} 条已恢复 · 待处理 ${pending.length}${incidents.quiet ? ` · ${incidents.quiet} 条已确认` : ""}`
    : `${incidents.resolved} 条已恢复`;
  const tone = openCount ? "critical" : incidents.opened ? "warn" : "ok";
  return {
    stat: { key: "events", label: "事件", value: String(incidents.opened), unit: " 新开", sub, tone, view: "events" },
    notes,
    facts: { opened: incidents.opened, pending: pending.length },
  };
}

// ---- 用量 ----
// usage：{ total, calls, errors, freshRatio, costUsd?, savedUsd? } | null
function briefUsdText(usd) {
  const v = Number(usd) || 0;
  if (v <= 0) return "";
  if (v < 0.01) return "<$0.01";
  if (v >= 100) return `$${Math.round(v)}`;
  return `$${v.toFixed(2)}`;
}

function usageSection(usage) {
  if (!usage) {
    return { stat: { key: "usage", label: "用量", value: "—", unit: "", sub: "用量采集未启用", tone: "neutral", view: "usage" }, notes: [], facts: {} };
  }
  const t = tokensText(usage.total);
  const parts = [];
  if (Number.isFinite(usage.costUsd) && usage.costUsd > 0) parts.push(`等效 ${briefUsdText(usage.costUsd)}`);
  if (Number.isFinite(usage.freshRatio)) parts.push(`未命中输入较近 7 日 ${signedPct(usage.freshRatio)}`);
  parts.push(`失败 ${usage.errors} 次`);
  const errorRate = usage.calls ? usage.errors / usage.calls : 0;
  const tone = usage.errors >= 20 && errorRate >= 0.05 ? "warn" : "neutral";
  const notes = tone === "warn"
    ? [{ key: "usage-errors", tone: "warn", at: null, link: "usage", text: `模型调用失败 ${usage.errors} 次（占 ${(errorRate * 100).toFixed(0)}%）` }]
    : [];
  return { stat: { key: "usage", label: "用量", value: t.value, unit: t.unit, sub: parts.join(" · "), tone, view: "usage" }, notes, facts: {} };
}

// ---- 失败作业的值得留意（v2.49 按原因归组）----
// 原因来自失败作业诊断（job.diagnosis = { category, headline }，lib/jobs/diagnose.mjs）；还没诊断到的
// 按 sacct 状态 / 退出码兜底。一个失败 → 点名这个作业；多个 → 一句话按原因合并：
//   「今天 12 个作业失败：10 个 KeyError: 'arm'，2 个超时」。链接到「我的历史」。
const CAUSE_TEXT = Object.freeze({
  timeout: "超时",
  oom: "内存不足",
  "gpu-oom": "显存不足",
  nan: "出现 NaN",
  node: "节点故障",
  refused: "子任务被拒绝启动",
  unknown: "原因不明",
  "no-log": "日志已不可得",
});
// 这两类的原因就是报错原文本身：按归一化后的原文分组，展示时截短。
const TEXT_CAUSES = new Set(["python", "missing-file"]);
const CAUSE_TEXT_MAX = 48;
const CAUSE_GROUPS_MAX = 3;

function failureCause(job) {
  const d = job.diagnosis;
  if (d && TEXT_CAUSES.has(d.category) && d.headline) {
    const text = d.headline.length > CAUSE_TEXT_MAX ? `${d.headline.slice(0, CAUSE_TEXT_MAX - 1)}…` : d.headline;
    return { key: `${d.category}|${normalizeHeadline(d.headline)}`, text };
  }
  if (d && CAUSE_TEXT[d.category]) return { key: CAUSE_TEXT[d.category], text: CAUSE_TEXT[d.category] };
  const text = JOB_STATE_TEXT[job.state] || (job.exitCode === 137 ? "疑似内存不足" : "原因待查");
  return { key: text, text };
}

function failedJobNotes(failed, { isToday, plus }) {
  if (!failed.length) return [];
  const sorted = [...failed].sort((a, b) => b.endAt - a.endAt);
  const latest = sorted[0];
  if (sorted.length === 1) {
    const why = latest.diagnosis ? failureCause(latest).text : JOB_STATE_TEXT[latest.state] || (latest.exitCode === 137 ? "退出码 137，疑似内存不足" : `退出码 ${latest.exitCode ?? "?"}`);
    return [{ key: `job:${latest.id}`, tone: "critical", at: latest.endAt, link: "cluster-history", text: `作业 #${latest.id}${latest.name ? ` ${latest.name}` : ""} 失败：${why}${latest.nodes ? `（${latest.nodes}）` : ""}` }];
  }
  const groups = new Map();
  for (const job of sorted) {
    const cause = failureCause(job);
    const entry = groups.get(cause.key) || { text: cause.text, count: 0 };
    entry.count += 1;
    groups.set(cause.key, entry);
  }
  const ranked = [...groups.values()].sort((a, b) => b.count - a.count);
  const lead = `${isToday ? "今天 " : ""}${sorted.length}${plus} 个作业失败`;
  let text;
  // 中文后面接英文报错时补一个空格（「10 个 KeyError: 'arm'」）。
  const gap = (t) => (/^[A-Za-z]/.test(t) ? " " : "");
  if (ranked.length === 1) text = `${lead}，都是${gap(ranked[0].text)}${ranked[0].text}`;
  else {
    const parts = ranked.slice(0, CAUSE_GROUPS_MAX).map((g) => `${g.count} 个${gap(g.text)}${g.text}`);
    const rest = ranked.slice(CAUSE_GROUPS_MAX).reduce((sum, g) => sum + g.count, 0);
    if (rest) parts.push(`其余 ${rest} 个`);
    text = `${lead}：${parts.join("，")}`;
  }
  return [{ key: "job:failed", tone: "critical", at: latest.endAt, link: "cluster-history", text }];
}

// ---- 我的作业 ----
// jobs：{ state: "ok"|"absent"|"error"|"none", jobs: [...]（getSnapshot 的 jobs，已合并各服务器）,
//         truncated?: boolean（有服务器这一轮没拿全作业记录：下面的数字只是下限）}
// 归类口径在 lib/jobs/model.mjs jobOutcome（与「我的历史」同一套）：失败含超时 / 内存不足 / 节点故障等，取消单算。
function jobsSection(jobs, { dayStart, dayEnd, nowMs, isToday }) {
  if (!jobs || jobs.state === "none") {
    return { stat: { key: "jobs", label: "我的作业", value: "—", unit: "", sub: "尚未采集到作业记录", tone: "neutral", view: "cluster" }, notes: [], facts: { available: false } };
  }
  if (jobs.state === "absent") {
    return { stat: { key: "jobs", label: "我的作业", value: "—", unit: "", sub: "集群没有作业记账（sacct）", tone: "neutral", view: "cluster" }, notes: [], facts: { available: false } };
  }
  if (jobs.state === "error" && !jobs.jobs?.length) {
    return { stat: { key: "jobs", label: "我的作业", value: "—", unit: "", sub: "作业记录读取失败", tone: "neutral", view: "cluster" }, notes: [], facts: { available: false } };
  }
  const list = jobs.jobs || [];
  const truncated = jobs.truncated === true;
  const endedToday = list.filter((j) => Number.isFinite(j.endAt) && j.endAt >= dayStart && j.endAt < dayEnd);
  const outcomes = new Map(endedToday.map((j) => [j, jobOutcome(j)]));
  const completed = endedToday.filter((j) => outcomes.get(j) === "completed");
  const failed = endedToday.filter((j) => outcomes.get(j) === "failed");
  const cancelled = endedToday.filter((j) => outcomes.get(j) === "cancelled");
  const running = isToday ? list.filter((j) => j.state === "RUNNING") : [];
  const pending = isToday ? list.filter((j) => j.state === "PENDING") : [];
  const longestPending = pending.reduce((m, j) => (Number.isFinite(j.submitAt) ? Math.max(m, nowMs - j.submitAt) : m), 0);
  const notes = failedJobNotes(failed, { isToday, plus: truncated ? "+" : "" });
  // 没拿全时数字只是下限：数字后面挂「+」，并把原因写在说明行最前（这一行放不下会被省略，要紧的在前），
  // 不把少算的数字当成完整的。
  const plus = truncated ? "+" : "";
  const subParts = [];
  if (truncated) subParts.push(`作业太多，只统计了最新 ${list.length} 个`);
  if (failed.length) subParts.push(`${completed.length}${plus} 完成`);
  else subParts.push(truncated ? "未见失败" : "0 失败");
  if (cancelled.length) subParts.push(`${cancelled.length}${plus} 取消`);
  if (running.length) subParts.push(`${running.length} 运行中`);
  if (pending.length) subParts.push(`${pending.length} 个排队中（最久 ${humanDuration(longestPending)}）`);
  const headline = failed.length ? { value: `${failed.length}${plus}`, unit: " 失败" } : { value: `${completed.length}${plus}`, unit: " 完成" };
  const tone = failed.length ? "critical" : completed.length ? "ok" : "neutral";
  return {
    stat: { key: "jobs", label: "我的作业", ...headline, sub: subParts.join(" · "), tone, view: "cluster" },
    notes,
    facts: { available: true, completed: completed.length, failed: failed.length, cancelled: cancelled.length, truncated, failedFirst: failed[0] || null },
  };
}

// ---- 磁盘 / 可升级（持续性状态，at = null）----

// 「按这个速度约 N 天写满」：斜率不够（daysToFull 为空）或超过 90 天 → ""。
// 磁盘超阈值事件的详情用同一句（lib/disk-growth/detail.mjs），不另写一份。
export function daysToFullText(daysToFull) {
  return Number.isFinite(daysToFull) && daysToFull <= 90 ? `按这个速度约 ${Math.max(1, Math.round(daysToFull))} 天写满` : "";
}

// disks：[{ serverId, name, usedPct, deltaPct, daysToFull, growth? }]；upgrades：[{ agent, current, latest }]
// growth：磁盘增长归因的摘要（lib/disk-growth/model.mjs buildSummary）。作业目录的增长占到整盘同期增长的
// 三成以上时，在这句后面接「其中你的 <目录名> 近 24 小时 +Y」；不够就不提。
function conditionNotes(disks = [], upgrades = []) {
  const notes = [];
  for (const d of disks) {
    if (!Number.isFinite(d.usedPct) || d.usedPct < 90) continue;
    const parts = [`${d.name}磁盘 ${Math.round(d.usedPct)}%`];
    if (Number.isFinite(d.deltaPct)) parts.push(`比昨天${d.deltaPct >= 0 ? "多" : "少"} ${Math.abs(d.deltaPct).toFixed(1)}%`);
    const full = daysToFullText(d.daysToFull);
    if (full) parts.push(full);
    const mine = briefGrowthClause(d.growth);
    if (mine) parts.push(mine);
    notes.push({ key: `disk:${d.serverId}`, tone: d.usedPct >= 95 ? "critical" : "warn", at: null, link: "servers", text: parts.join("；") });
  }
  for (const u of upgrades) {
    notes.push({ key: `upgrade:${u.agent}:${u.latest}`, tone: "info", at: null, link: "doctor", text: `${u.agent} ${u.latest} 可升级（当前 ${u.current}）` });
  }
  return notes;
}

export function noteCategoryOf(key) {
  const s = String(key ?? "");
  if (s.startsWith("tunnel-") || s.startsWith("sleep:")) return "tunnel";
  const idx = s.indexOf(":");
  if (idx > 0) return s.slice(0, idx);
  if (s.startsWith("usage")) return "usage";
  return s;
}

export function rankNotes(notes, max = BRIEF_NOTES_MAX) {
  const seen = new Set();
  const sorted = (Array.isArray(notes) ? notes : [])
    .filter((n) => (seen.has(n.key) ? false : seen.add(n.key)))
    .sort((a, b) => (TONE_RANK[b.tone] - TONE_RANK[a.tone]) || ((b.at ?? 0) - (a.at ?? 0)));
  if (sorted.length <= max || max < 2) return sorted.slice(0, max);
  const top = sorted.slice(0, max);
  const firstCat = noteCategoryOf(top[0].key);
  // 若前 max 条全被同一类别（如多条隧道断线）占满，且后续还有其它类别的 critical/warn 项（如作业失败、磁盘告急），
  // 保底让出最后一个槽位给排名最高的异类告警，避免跨类异常被单一类别刷屏淹没。
  if (top.every((n) => noteCategoryOf(n.key) === firstCat)) {
    const otherHigh = sorted.slice(max).find((n) => noteCategoryOf(n.key) !== firstCat && (TONE_RANK[n.tone] || 0) >= TONE_RANK.warn);
    if (otherHigh) top[max - 1] = otherHigh;
  }
  return top;
}

export function rankNotesWithOverflow(notes, max = BRIEF_NOTES_MAX) {
  const seen = new Set();
  const deduped = (Array.isArray(notes) ? notes : []).filter((n) => (seen.has(n.key) ? false : seen.add(n.key)));
  const shown = rankNotes(deduped, max);
  const shownKeys = new Set(shown.map((n) => n.key));
  const overflow = deduped
    .filter((n) => !shownKeys.has(n.key))
    .sort((a, b) => (TONE_RANK[b.tone] - TONE_RANK[a.tone]) || ((b.at ?? 0) - (a.at ?? 0)));
  return { notes: shown, hiddenCount: overflow.length, overflow };
}

// input：{ day, dayStart, dayEnd, nowMs, isToday, ledgerSince, tunnelRange?, tunnels, sleep?, incidents, usage, jobs, disks, upgrades, modules? }
// tunnelRange：隧道数字的统计窗口 [start, end]。今天的简报传近 24 小时（与概览「隧道稳定性」同一口径，
// 凌晨看也是完整一天的量）；定稿的过去某天不传，按自然日。其余三格恒按自然日。
// modules：运行配置的 { usage, jobs }（设置页「监控模块」）。关掉的模块整格不出现（连同它的留意项
// 与一句话结论里的片段），而不是显示「—」；缺省全开。
export function buildBrief(input) {
  const { day, dayStart, dayEnd, nowMs, isToday } = input;
  const ledgerSince = Number.isFinite(input.ledgerSince) ? input.ledgerSince : null;
  const tunnelStart = Number.isFinite(input.tunnelRange?.[0]) ? input.tunnelRange[0] : dayStart;
  const rolling = tunnelStart !== dayStart;
  // 账本没覆盖到隧道窗口起点（刚开始记录 / 中途才装上）：隧道数字只是部分事实，如实说明。
  const warming = ledgerSince == null || ledgerSince > tunnelStart + 60_000;
  const tunnel = tunnelSection(input.tunnels || [], { nowMs, isToday, warming, rolling, dayStart, sleep: input.sleep ?? null });
  const incident = incidentSection(input.incidents || { opened: 0, resolved: 0, pending: [], quiet: 0 }, { nowMs, isToday });
  const usageOn = input.modules?.usage !== false;
  const jobsOn = input.modules?.jobs !== false;
  const usage = usageOn ? usageSection(input.usage || null) : null;
  const jobs = jobsOn ? jobsSection(input.jobs || null, { dayStart, dayEnd, nowMs, isToday }) : null;
  const all = [...tunnel.notes, ...incident.notes, ...(jobs?.notes || []), ...(usage?.notes || []), ...conditionNotes(input.disks, input.upgrades)];
  const notes = rankNotes(all);
  const worst = all.reduce((m, n) => Math.max(m, TONE_RANK[n.tone] || 0), 0);

  let headline;
  if (worst >= TONE_RANK.warn && all.some((n) => n.tone === "critical" || (n.tone === "warn" && n.at != null))) {
    const top = rankNotes(all.filter((n) => n.tone !== "info"), 2).map((n) => n.text);
    headline = { tone: worst >= TONE_RANK.critical ? "critical" : "warn", lead: "需要留意。", text: `${top.join("；")}。` };
  } else if (warming) {
    const since = ledgerSince ? `断线账本从 ${monthDayBj(ledgerSince)} ${clockBj(ledgerSince)} 开始记录` : "断线账本还没有记录";
    const scope = rolling ? "近 24 小时中的" : isToday ? "今天" : "当天";
    const covered = ledgerSince ? `，已覆盖${scope} ${humanDuration(Math.min(nowMs, dayEnd) - Math.max(ledgerSince, tunnelStart))}` : "";
    headline = { tone: "neutral", lead: "数据积累中。", text: `${since}${covered}；满${rolling ? " 24 小时" : "一整天"}后隧道可用率才完整。` };
  } else {
    const parts = [];
    const f = tunnel.facts;
    const scope = rolling ? "近 24 小时" : isToday ? "今天" : "全天";
    parts.push(f.drops === 0 ? `隧道${scope}没有断线` : `隧道${rolling ? "近 24 小时" : ""}断线 ${f.drops} 次，${f.allQuick ? "都在 1 分钟内自愈" : `最长断开 ${humanDuration(f.longest)}`}`);
    parts.push(incident.facts.opened ? `新开事件 ${incident.facts.opened} 条，均已恢复` : "没有新的事件");
    if (jobs?.facts.available && jobs.facts.completed) parts.push(`你的 ${jobs.facts.completed}${jobs.facts.truncated ? "+" : ""} 个作业已完成`);
    headline = { tone: worst >= TONE_RANK.warn ? "warn" : "ok", lead: "整体平稳。", text: `${parts.join("；")}。` };
  }

  return {
    schemaVersion: 1,
    day,
    range: { start: dayStart, end: dayEnd },
    generatedAt: nowMs,
    final: !isToday,
    ledgerSince,
    warming,
    headline,
    stats: [tunnel.stat, incident.stat, usage?.stat, jobs?.stat].filter(Boolean),
    notes,
  };
}
