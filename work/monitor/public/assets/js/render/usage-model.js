// render/usage-model.js —— 用量页的纯函数（格式化 / 刻度 / 日历网格 / 会话排序筛选 / CSV）。
// 数据口径在后端 lib/usage/model.mjs 已经算好；这里只做展示层的派生，不碰 DOM（Node 可测）。

export const AGENT_IDS = Object.freeze(["codex", "claude", "antigravity", "gemini", "zcode", "opencode", "cursor", "custom"]);
export const AGENT_LABELS = Object.freeze({
  codex: "Codex",
  claude: "Claude",
  antigravity: "Antigravity",
  gemini: "Gemini CLI",
  zcode: "ZCode",
  opencode: "OpenCode",
  cursor: "Cursor",
  custom: "自定义 AI",
});
export const STATUS_LABELS = Object.freeze({ recent: "近期活跃", quiet: "暂无新记录", past: "" });
export const RECENT_SECONDS = 300;

// 1234567 → ["1.23", "M"]；数量级越大保留位数越少，避免 "123.45M" 这种假精度。
export function splitTokens(value) {
  const v = Number(value) || 0;
  if (v >= 1e9) return [(v / 1e9).toFixed(2), "B"];
  if (v >= 1e6) return [(v / 1e6).toFixed(v >= 1e8 ? 0 : v >= 1e7 ? 1 : 2), "M"];
  if (v >= 1e3) return [(v / 1e3).toFixed(v >= 1e5 ? 0 : 1), "K"];
  return [String(Math.round(v)), ""];
}
const EN_INT_FORMATTER = new Intl.NumberFormat("en-US");
export const shortTokens = (value) => splitTokens(value).join("");
export const integer = (value) => {
  const r = Math.round(Number(value) || 0);
  return r > -1000 && r < 1000 ? String(r) : EN_INT_FORMATTER.format(r);
};

export function formatUsd(usd) {
  const v = Number(usd) || 0;
  if (v <= 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  if (v >= 100) return `$${integer(v)}`;
  return `$${v.toFixed(2)}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

// 用量页的时刻 / 日期一律按北京时间显示（UTC+8，无夏令时），与本机时区无关；
// 与后端 lib/usage/time.mjs 同一口径（后端按它归日、分档，前端按它显示）。
// 这是前端唯一一份偏移量：别的模块（时间轴刻度、隧道稳定性、作业、目录占用……）要北京时间的
// 时刻 / 日期一律从这里取 clockOf / dayKeyOf / TZ_OFFSET_SEC，不要再写 8 * 3600，也不要用
// getHours / getDate 这类按本机时区取值的写法。后端那一份在 lib/beijing-time.mjs，两边的值由
// lib/beijing-time.test.mjs 钉成相等。
export const TZ_OFFSET_SEC = 8 * 3600;
export const TZ_LABEL = "北京时间";
const pad = (n) => String(n).padStart(2, "0");
const shifted = (epochSec) => new Date((epochSec + TZ_OFFSET_SEC) * 1000);
export function clockOf(epochSec, { seconds = false } = {}) {
  const totalSec = Math.floor(Number(epochSec) + TZ_OFFSET_SEC);
  if (Number.isFinite(totalSec)) {
    const secInDay = ((totalSec % 86400) + 86400) % 86400;
    const hh = Math.floor(secInDay / 3600);
    const mm = Math.floor((secInDay % 3600) / 60);
    if (!seconds) return `${pad(hh)}:${pad(mm)}`;
    const ss = secInDay % 60;
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  }
  const d = shifted(epochSec);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${seconds ? `:${pad(d.getUTCSeconds())}` : ""}`;
}
export const monthDay = (day) => `${Number(day.slice(5, 7))}.${Number(day.slice(8))}`;
export const dateLabel = (day) => `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日`;
export const compactDate = (day) => day.replaceAll("-", ".");

export function dayKeyOf(epochSec) {
  const d = shifted(epochSec);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// 纯日历运算（与时区无关）
const calendarDate = (y, m, d) => new Date(Date.UTC(y, m, d));
const keyOfCalendar = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
export function offsetDay(day, days) {
  const [y, m, d] = day.split("-").map(Number);
  return keyOfCalendar(calendarDate(y, m - 1, d + days));
}
// 北京时间的「年-月-日 时:分:秒」（CSV 用）
export function dateTimeOf(epochSec) {
  return `${dayKeyOf(epochSec)} ${clockOf(epochSec, { seconds: true })}`;
}

// 纵轴刻度：固定 3 段，步长取 1 / 2 / 5 × 10^n（如 0 / 50 / 100 / 150），峰值上方留一些余量，
// 曲线起伏不会被放大得太剧烈。单位按上限统一选（K / M / B），刻度只写数字。
// 返回 { step, ceiling, segments, unit, divisor }。
export function niceScale(max) {
  const raw = Math.max(1, max) / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((f) => f * power).find((v) => v >= raw) ?? power * 10);
  const ceiling = step * 3;
  const [unit, divisor] = ceiling >= 1e9 ? ["B", 1e9] : ceiling >= 1e6 ? ["M", 1e6] : ceiling >= 1e3 ? ["K", 1e3] : ["", 1];
  return { step, ceiling, segments: 3, unit, divisor };
}

// 刻度文字：按统一单位只写数字，去掉多余小数（50 / 100 / 0.5 / 1.5）。
export function axisLabel(value, divisor = 1) {
  if (!value) return "0";
  return String(Number((value / divisor).toFixed(2)));
}

// 单调三次插值的实现在通用折线图模块里（合并图与「分开」的小图共用一份）。
export { monotoneSegments } from "../line-chart.js";

// 「分开」的小图各有自己的纵轴，没有地方单独写单位：刻度文字自带单位，单位按上限统一选
//（上限 5M → 0 / 2.5M / 5M）。返回格式化函数。
export function tokenAxisFormatter(max) {
  const [unit, divisor] = max >= 1e9 ? ["B", 1e9] : max >= 1e6 ? ["M", 1e6] : max >= 1e3 ? ["K", 1e3] : ["", 1];
  return (value) => (value ? `${axisLabel(value, divisor)}${unit}` : "0");
}

// limit：只列次数最多的几种，其余合并为「等 N 种」（KPI 卡里一行放得下）。
export function codesText(codes, sep = " ", { limit = Infinity } = {}) {
  const entries = Object.entries(codes || {}).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, limit).map(([code, count]) => `${code === "error" ? "失败" : code}×${count}`);
  if (entries.length > limit) shown.push(`等 ${entries.length} 种`);
  return shown.join(sep);
}

// KPI 卡「失败 N」后面的错误码明细。只有一种、且是没有错误码的笼统失败时不写——
// 「失败 3 · 失败×3」是同一件事说两遍；有具体错误码或不止一种时照常列出。
export function failureDetailText(codes, sep = " · ", options = {}) {
  const keys = Object.keys(codes || {});
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "error")) return "";
  return codesText(codes, sep, options);
}

// 失败调用按错误原文的归类（后端 lib/usage/error-text.mjs 给键；类别只来自实际抽查到的文案）。
// unrecorded / empty / dropped 不是错误类别，而是「为什么没有原文」，单独写清口径。
export const ERROR_KIND_LABELS = Object.freeze({
  stream_stopped: "响应中途停止",
  connection_lost: "连接中途断开",
  server_mid_response: "服务端中途出错",
  safeguards: "安全策略拦截",
  usage_limit: "额度用尽",
  gateway_unreachable: "网关不可达",
  account_unavailable: "账号暂不可用",
  client_state: "客户端状态异常",
  auth_revoked: "登录失效",
  other: "其他",
  unrecorded: "v2.51 前未存原文",
  empty: "日志无文本",
  dropped: "超出保存上限",
});
const NO_TEXT_KINDS = new Set(["unrecorded", "empty", "dropped"]);
export const errorKindLabel = (kind) => ERROR_KIND_LABELS[kind] ?? "其他";

// 「无状态码 N：响应中途停止×20 · 连接中途断开×6 · v2.51 前未存原文×4」。有原文的类别按次数排前，
// 「没有原文」的几类放最后；全部都没原文时返回 ""（只会重复「失败×N」，不加信息）。
export function causesText(causes, { limit = 4, sep = " · " } = {}) {
  const entries = Object.entries(causes || {}).filter(([, n]) => n > 0);
  if (!entries.length || entries.every(([kind]) => NO_TEXT_KINDS.has(kind))) return "";
  entries.sort((a, b) => Number(NO_TEXT_KINDS.has(a[0])) - Number(NO_TEXT_KINDS.has(b[0])) || b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  const shown = entries.slice(0, limit).map(([kind, n]) => `${errorKindLabel(kind)}×${n}`);
  if (entries.length > limit) shown.push(`等 ${entries.length} 类`);
  return `无状态码 ${total}：${shown.join(sep)}`;
}

// 失败调用展开后的原文说明：有原文给原文，没有就写明原因（不猜）。
export function errorTextNote(call) {
  if (call.errorDropped) return { text: null, note: "原文超出本机保存上限（每台服务器 1 MiB），未保存" };
  if (typeof call.errorText !== "string") return { text: null, note: "该记录采集于 v2.51 之前，未保存原文" };
  if (!call.errorText) return { text: null, note: "日志里这条错误没有文本" };
  return { text: call.errorText, note: "已脱敏 · 单行化 · 最多 300 字" };
}

// 「较近 N 日均值」：≥1.95 倍写成 5.3×，其余写成 ±百分比。
export function ratioText(freshVsAvg) {
  if (!freshVsAvg || !Number.isFinite(freshVsAvg.ratio)) return "";
  const { ratio } = freshVsAvg;
  return ratio >= 1.95 ? `${ratio.toFixed(1)}×` : `${ratio > 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%`;
}

// 日历网格：周一开头，补齐首尾周；period = "rolling"（近 30 天）或 "YYYY-MM"。
export function calendarGrid(period, today) {
  const rolling = period === "rolling";
  const first = rolling ? offsetDay(today, -29) : `${period}-01`;
  const [y, m] = first.split("-").map(Number);
  const last = rolling ? today : keyOfCalendar(calendarDate(y, m, 0));
  const weekday = (calendarDate(y, m - 1, Number(first.slice(8))).getUTCDay() + 6) % 7;
  let count = 0;
  for (let d = first; d <= last; d = offsetDay(d, 1)) count += 1;
  const cells = Math.ceil((count + weekday) / 7) * 7;
  return { first, last, dates: Array.from({ length: cells }, (_, i) => offsetDay(first, i - weekday)) };
}

// 日历两个可选月份：本月与上月（摘要只带近 62 天的数据）。
export function calendarMonths(today) {
  const [y, m] = today.split("-").map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
  return [`${y}-${pad(m)}`, prev];
}

export function heatLevel(value, max) {
  if (!value) return 0;
  return Math.min(4, Math.ceil((value / Math.max(1, max)) * 4));
}

export const SESSION_SORTS = Object.freeze({
  recent: (a, b) => (a.status === "recent" ? 0 : 1) - (b.status === "recent" ? 0 : 1) || b.last - a.last,
  tokens: (a, b) => b.stats.total - a.stats.total,
  cost: (a, b) => (b.stats.costUsd || 0) - (a.stats.costUsd || 0) || b.stats.total - a.stats.total,
  errors: (a, b) => b.stats.errors - a.stats.errors || b.last - a.last,
  context: (a, b) => (b.context?.ratio ?? -1) - (a.context?.ratio ?? -1),
});

export function filterSessions(sessions, { filter = "all", search = "", sort = "recent" } = {}) {
  const query = search.trim().toLowerCase();
  return (sessions || [])
    .filter((s) => {
      if (filter === "recent" && s.status !== "recent") return false;
      if (filter === "error" && !s.stats.errors) return false;
      if (!query) return true;
      return [s.sid, s.project, s.projectLabel, s.model, AGENT_LABELS[s.agent]].some((v) => String(v || "").toLowerCase().includes(query));
    })
    .sort(SESSION_SORTS[sort] || SESSION_SORTS.recent);
}

export function contextTone(ratio) {
  if (!Number.isFinite(ratio)) return "ok";
  return ratio >= 0.95 ? "error" : ratio >= 0.85 ? "warn" : "ok";
}

const csvCell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
export function sessionsCsv(sessions) {
  const headers = ["会话 ID", "Agent", "模型", "项目", `开始（${TZ_LABEL}）`, `最近活动（${TZ_LABEL}）`, "调用", "失败", "普通输入", "缓存写入", "缓存读取", "输出", "未命中输入(普通+缓存写入)", "总 Token", "等效花费(USD)", "缓存节省(USD)", "上下文 Token", "上下文窗口", "上下文为估算"];
  const rows = sessions.map((s) => [
    s.sid, AGENT_LABELS[s.agent] || s.agent, s.model, s.project, dateTimeOf(s.first), dateTimeOf(s.last),
    s.stats.calls, s.stats.errors, s.stats.inFresh, s.stats.cacheWrite, s.stats.cacheRead, s.stats.output, s.stats.fresh, s.stats.total,
    Number.isFinite(s.stats.costUsd) ? s.stats.costUsd.toFixed(4) : "",
    Number.isFinite(s.stats.savedUsd) ? s.stats.savedUsd.toFixed(4) : "",
    s.context?.tokens ?? "", s.context?.window ?? "", s.context?.estimated ? "是" : "否",
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
