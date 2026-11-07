// empty-state.js —— 空状态组件（纯函数，Node 可测）：所有「这里还没有东西」的位置共用一个渲染函数。
//
// 写法规则（文案在各调用处，规则在这里统一）：
//   标题说状态：「没有… / 正在… / 暂时取不到…」，不用「暂无数据」这类不说原因的话；
//   正文回答三件事：这里会出现什么 · 为什么现在是空的 · 什么时候会有（写真实节奏：每分钟 / 每 5 分钟）；
//   动作最多两个：一个主按钮 + 一个文字按钮；好消息（没有事件）不放主按钮，只给去处；
//   语气：ok 绿（好事）· wait 蓝（正在等）· neutral 灰（还没有）· error 红（取不到），图标 + 文字，颜色从不单独表意；
//   能力缺失（没 GPU / 没 Slurm / 个人服务器不统计用量）整块隐藏，不给空状态。
// 所有文字一律转义（服务器名、筛选条件等可能来自他人可写的 config.json）。样式在 styles.css「空状态」。
import { escapeHtml } from "./store.js";

export const EMPTY_TONES = Object.freeze(["ok", "wait", "neutral", "error"]);

// 24 栅格、1.6 线宽、圆头（与侧栏图标同一套语言）
export const EMPTY_ICONS = Object.freeze({
  check: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.3 2.4 2.4 4.6-4.9"/>',
  inbox: '<path d="M3.5 13.5 6 5.5a2 2 0 0 1 1.9-1.4h8.2A2 2 0 0 1 18 5.5l2.5 8"/><path d="M3.5 13.5v4a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4h-5l-1.5 2.5h-4L8.5 13.5Z"/>',
  wave: '<path d="M3 12h2.5M18.5 12H21"/><path d="M5.5 12c1.5 0 1.5-5 3-5s1.5 10 3 10 1.5-10 3-10 1.5 5 3 5"/>',
  cloudOff: '<path d="M8 8.5a5.5 5.5 0 0 1 10.2 2.2A3.8 3.8 0 0 1 17.5 18H8.3A4.3 4.3 0 0 1 6 10.2"/><path d="m3.5 3.5 17 17"/>',
  serverPlus: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><path d="M3.5 15.5V18a2 2 0 0 0 2 2h7M17.5 14.5v6M14.5 17.5h6"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.3-4.3"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 4v4h4M12 8v4.2l2.8 1.6"/>',
  chart: '<path d="M3.5 20.5h17"/><path d="M7 16.5v-5M12 16.5v-10M17 16.5v-7"/>',
});

const iconSvg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${EMPTY_ICONS[name] || EMPTY_ICONS.inbox}</svg>`;

// 动作：{ label, kind: "primary" | "secondary" | "text", attrs: { "data-x": "y", id: "z" } }；最多取两个。
function actionHtml({ label, kind = "secondary", attrs = {} }) {
  const cls = kind === "text" ? "text-btn" : `btn ${kind === "primary" ? "btn-primary" : "btn-secondary"}`;
  const extra = Object.entries(attrs)
    .filter(([name]) => /^[a-z][a-z0-9-]*$/.test(name) && !name.startsWith("on")) // 不收内联事件属性
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  return `<button type="button" class="${cls}"${extra}>${escapeHtml(label)}</button>`;
}

export function emptyStateHtml({ tone = "neutral", icon = "inbox", title = "", body = "", actions = [], meta = "", compact = false } = {}) {
  const t = EMPTY_TONES.includes(tone) ? tone : "neutral";
  const acts = (actions || []).slice(0, 2).map(actionHtml).join("");
  const text = `<p class="empty-state-title">${escapeHtml(title)}</p>${body ? `<p class="empty-state-body">${escapeHtml(body)}</p>` : ""}`;
  // 只在「正在等」和「取不到」时宣告：前者是异步结果，后者需要立刻知道；空 / 好消息不打断朗读。
  const live = t === "wait" ? ' role="status" aria-live="polite"' : t === "error" ? ' role="alert"' : "";
  return `<div class="empty-state${compact ? " is-compact" : ""}" data-tone="${t}"${live}>`
    + `<div class="empty-state-icon">${iconSvg(icon)}</div>`
    + (compact ? `<div class="empty-state-text">${text}</div>` : text)
    + (acts ? `<div class="empty-state-actions">${acts}</div>` : "")
    + (meta ? `<p class="empty-state-meta">${escapeHtml(meta)}</p>` : "")
    + "</div>";
}
