// store.js —— 通用视图纯函数（时间/字节格式、转义、刷新门控、徽标）。
// 无 DOM 依赖，可被 node:test 直接 import。
import { finite } from "./thresholds.js";
import { BUTTON_LABELS } from "./ui-labels.js";

// 相对时间格式化（"12 秒前" / "3 分钟前" / "刚刚"）。纯函数，便于测试。
export function formatRelativeTime(ts, now = Date.now()) {
  if (ts == null || Number.isNaN(Number(ts))) return "";
  const diff = now - Number(ts);
  if (diff < 0) return "刚刚";
  const sec = Math.floor(diff / 1000);
  if (sec < 5) return "刚刚";
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  return `${day} 天前`;
}

// 字节数 → 人类可读（1024 进制，保留 1 位小数，整数去掉 .0）："512 MiB" / "1.8 TiB"。
// 非法或负数返回 "—"。compact：≥100 取整（"251 GiB" / "98.2 GiB"，资源面板的大数更好扫读）；
// maxUnit：封顶单位（集群内存按 GiB 报，不进位到 TiB）。
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];

function byteUnit(bytes, maxUnit) {
  const max = maxUnit ? BYTE_UNITS.indexOf(maxUnit) : BYTE_UNITS.length - 1;
  let unit = 0;
  for (let value = bytes; value >= 1024 && unit < max; value /= 1024) unit += 1;
  return unit;
}

function scaledText(value, unit, compact) {
  if (unit === 0 || (compact && value >= 100)) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, "");
}

export function formatBytes(bytes, { compact = false, maxUnit } = {}) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  const unit = byteUnit(n, maxUnit);
  return `${scaledText(n / 1024 ** unit, unit, compact)} ${BYTE_UNITS[unit]}`;
}

// 成对：按总量选单位，已用量与之同单位 —— "98.2 / 251 GiB"、"1.1 / 1.8 TiB"。
// 任一缺失、总量 ≤0 或已用为负返回空串（调用方据此整行不显示）。选项同 formatBytes。
export function formatBytePair(used, total, { compact = false, maxUnit } = {}) {
  const u = finite(used);
  const t = finite(total);
  if (u == null || t == null || t <= 0 || u < 0) return "";
  const unit = byteUnit(t, maxUnit);
  const scale = 1024 ** unit;
  return `${scaledText(u / scale, unit, compact)} / ${scaledText(t / scale, unit, compact)} ${BYTE_UNITS[unit]}`;
}

// MB（nvidia-smi / sinfo 口径，即 MiB）→ GB 数字串，固定 1 位小数："8.1" / "24.0"。
export function formatGb(mb) {
  return (mb / 1024).toFixed(1);
}

// 时间戳 → 本地时刻（toLocaleTimeString，格式随系统区域）；非法值返回 fallback（默认 "—"）。
// 需要与区域无关的固定 24 小时制 "14:03:07" 时传 { locale: "zh-CN", hour12: false }。
export function formatClock(ts, { fallback = "—", locale, hour12 } = {}) {
  const n = Number(ts);
  if (ts == null || !Number.isFinite(n)) return fallback;
  try {
    const date = new Date(n);
    if (!Number.isFinite(date.getTime())) return fallback;
    // 日志、服务器卡与最后更新共用的固定本地 HH:mm:ss：免去逐行创建 Intl 格式器。
    // 直接读本地时分秒，不缓存时区；默认区域与其他调用方式保持 Intl 的格式规则。
    if (locale === "zh-CN" && hour12 === false) {
      const pad = (value) => String(value).padStart(2, "0");
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }
    return date.toLocaleTimeString(locale, hour12 == null ? undefined : { hour12 });
  } catch {
    return fallback;
  }
}

// 重字段低频探针：每次运行都携带 lite+layers 快速路径无法补齐的重字段（诊断详情/端点/reClaude），
// 因此其事件即便级别未变也需要一次完整 /api/status 拉取补齐。
const HEAVY_OUTPUT_PROBES = ["doctor", "endpoint", "reclaude"];

// 判断某个 SSE probe 事件是否需要触发一次重量级 /api/status 完整刷新。纯函数，便于测试。
// 规则：
//   (a) 该 id 的 level 相比上次已变化，或首次见到该 id → 需要（级别变化会带来新的重字段）。
//   (b) id 属于重字段低频探针（doctor/endpoint/reclaude）→ 需要（新一轮运行携带快路径给不出的重字段）。
//   (c) 零残留采集的慢档 collect:slow:<serverId>（60s）→ 需要：probe 事件不带数据、status
//       快路径仅在级别变化时推送，负载卡（remoteLoad/serversBrief/趋势点/最后更新徽标）与
//       GPU / 隧道层 / 未登记端口这些字段只在完整 /api/status 里，依赖完整拉取保持新鲜度。
//   (d) log-signals：v2.18 起 fast profile 的 ports 段并入该探针（原 primary-remote 的
//       15s 远端端口探测由它以 10s 承担）。若不在此放行，稳定期就只剩 60s 的
//       collect:slow 能刷新隧道/端口新鲜度——即"漏刷"。
// 其余（processes 等）级别未变时不触发——SSE status 事件已用 lite+layers 覆盖级别变化。
export function shouldRefreshOnProbe(probe, lastLevels = {}) {
  if (!probe || probe.id == null) return false;
  const id = probe.id;
  if (HEAVY_OUTPUT_PROBES.includes(id)) return true;
  if (id === "log-signals") return true;
  if (typeof id === "string" && id.startsWith("collect:slow:")) return true;
  const prev = lastLevels[id];
  return prev === undefined || prev !== probe.level;
}

// 自动修复徽标（v2.18）：策略层执行的动作会在时间线/日志条目上打 trigger:"auto"
// （runbook 之外的 ops 日志则用 event:"auto-repair"）。任一命中即视为"非人工触发"。
// 纯函数，日志面板与时间线共用，避免两处各写一份判定漂移。
export function isAutoTriggered(entry) {
  if (!entry || typeof entry !== "object") return false;
  return entry.trigger === "auto" || entry.event === "auto-repair";
}

// 触发来源徽标：自动 → 「自动」小徽标；人工操作 → 空串。日志面板与时间线都调这个入口。
// 常量字符串，无外部插值，调用方可直接拼进 innerHTML。
export function autoBadgeHtml(entry) {
  return isAutoTriggered(entry) ? '<span class="auto-badge" title="由自动修复策略触发，非人工操作">自动</span>' : "";
}

// 统一 HTML 转义，供各渲染模块复用。不含特殊字符时单次检测直接返回原串，免去 5 次 replace。
const RE_HTML_ESCAPE = /[&<>"']/;
export function escapeHtml(unsafe) {
  const s = String(unsafe == null ? "" : unsafe);
  if (!RE_HTML_ESCAPE.test(s)) return s;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// 持续断开提示（纯函数，便于测试）：channel 层 error 持续超过阈值（默认 5 分钟）时，
// 提示"这可能是不在 SSH 白名单网络的预期现象"，引导暂停重试而非反复点修复。
// 参照时钟优先取服务端的 status.updatedAt：downSinceMs 由服务端时钟生成，
// 网页模式跨机器访问时用客户端 Date.now() 做差会被时钟偏移破坏阈值语义。
export function buildPersistentDownHint(status, nowMs = null, thresholdMs = 5 * 60e3) {
  const since = status?.layers?.channel?.detail?.downSinceMs ?? null;
  if (!since) return "";
  const serverNow = status?.updatedAt ? Date.parse(status.updatedAt) : NaN;
  const base = nowMs ?? (Number.isFinite(serverNow) ? serverNow : Date.now());
  if (base - since < thresholdMs) return "";
  const minutes = Math.round((base - since) / 60e3);
  return `已持续断开约 ${minutes} 分钟。若你当前不在服务器 SSH 白名单网络（校外/移动网络），这是预期现象——可在「${BUTTON_LABELS.control}」里点「${BUTTON_LABELS.stop}」暂停自动重试，回到白名单网络后再点「${BUTTON_LABELS.start}」。`;
}
