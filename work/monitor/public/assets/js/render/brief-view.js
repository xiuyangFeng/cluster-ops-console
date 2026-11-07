// render/brief-view.js —— 概览「今日简报」卡片的 HTML。
// 数据：/api/brief（文案在后端生成并随归档快照落盘，见 lib/brief/model.mjs）。
// 链路面板底部的「隧道稳定性」在 render/tunnel-stability-view.js。
// 动态文案一律 escapeHtml；语气只写 data-tone（配色在 assets/css/brief.css）；正文经 morphInnerHtml 就地修补。
import { morphInnerHtml } from "../dom-utils.js";
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml } from "../store.js";
import { clockOf, dayKeyOf } from "./usage-model.js";

const LINK_TEXT = Object.freeze({ stability: "隧道稳定性", servers: "服务器", events: "事件", usage: "用量", cluster: "集群队列", doctor: "Doctor" });
const DAY_MS = 86_400_000;

// 北京时间的「今天 / 昨天 / M 月 D 日」+ HH:MM
export function relativeDayTime(ms, nowMs) {
  if (!Number.isFinite(ms)) return "";
  const day = dayKeyOf(ms / 1000);
  const today = dayKeyOf(nowMs / 1000);
  const yesterday = dayKeyOf((nowMs - DAY_MS) / 1000);
  const label = day === today ? "今天" : day === yesterday ? "昨天" : `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日`;
  return `${label} ${clockOf(ms / 1000)}`;
}

export function previousDay(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function dayLabel(day, today) {
  if (day === today) return "今天";
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8))} 日`;
}

// 简报表头说明：今天「截至 HH:MM · 上次查看 …」；归档「M 月 D 日全天 · 已归档」。
export function briefCaption(brief, { nowMs, lastViewedAt }) {
  if (!brief) return "—";
  if (brief.final) return `${dayLabel(brief.day, "")}全天 · 已归档`;
  const parts = [`截至 ${clockOf(brief.generatedAt / 1000)}`];
  if (Number.isFinite(lastViewedAt)) parts.push(`上次查看 ${relativeDayTime(lastViewedAt, nowMs)}`);
  return parts.join(" · ");
}

// 上次查看之后新出现的留意项（持续性状态 at 为空，永不标新）。
export const isNewNote = (note, lastViewedAt) => Number.isFinite(lastViewedAt) && Number.isFinite(note?.at) && note.at > lastViewedAt;

// 某一天没有简报（归档里没有 / 已过保留期）。过去的日子由运行中的工作台在第二天定稿归档
//（lib/brief/service.mjs tick：只定稿「昨天」），所以那天之后工作台没运行就不会有。
// retentionDays 来自 /api/brief/days（BRIEF_RETENTION_DAYS）。
export function briefMissingHtml({ day = "", today = "", retentionDays = null } = {}) {
  const isToday = Boolean(day) && day === today;
  const label = day && today ? dayLabel(day, today) : "这一天";
  const keep = Number.isFinite(retentionDays) && retentionDays > 0 ? `归档保留最近 ${retentionDays} 天。` : "";
  return emptyStateHtml({
    tone: "neutral", icon: "calendar", title: `${label}没有简报`,
    body: isToday ? "简报由运行中的工作台实时生成，稍后会自动刷新。" : `每天的简报在第二天由运行中的工作台定稿归档；第二天工作台没有运行，这一天就不会有归档。${keep}`,
    actions: isToday ? [] : [{ label: "回到今天", kind: "text", attrs: { "data-brief-back": "" } }],
  });
}

// 一直没取到简报（不是 404）：红色「暂时取不到」+ 原有的具体原因；轮询每分钟会再拉一次。
export function briefErrorHtml(detail) {
  return emptyStateHtml({ tone: "error", icon: "cloudOff", title: "暂时取不到简报", body: `${detail || "未知错误"}；每分钟会自动重试。` });
}

export function briefBodyHtml(brief, { lastViewedAt, day = "", today = "", retentionDays = null } = {}) {
  if (!brief) return briefMissingHtml({ day, today, retentionDays });
  const h = brief.headline || {};
  const stats = (brief.stats || []).map((s) => (
    `<button type="button" class="bf-stat" data-tone="${escapeHtml(s.tone || "neutral")}" data-brief-goto="${escapeHtml(s.view || "")}">`
    + `<span class="bf-label">${escapeHtml(s.label)}</span>`
    + `<span class="bf-value">${escapeHtml(s.value)}<small>${escapeHtml(s.unit || "")}</small></span>`
    + `<span class="bf-sub">${escapeHtml(s.sub || "")}</span></button>`
  )).join("");
  const notes = (brief.notes || []).map((n) => (
    `<li data-tone="${escapeHtml(n.tone)}"><span class="bf-note-text">`
    + `${isNewNote(n, lastViewedAt) && !brief.final ? '<span class="bf-new" title="上次查看之后出现">新</span>' : ""}${escapeHtml(n.text)}</span>`
    + (n.link ? `<button type="button" class="bf-note-link" data-brief-goto="${escapeHtml(n.link)}">${escapeHtml(LINK_TEXT[n.link] || "查看")} →</button>` : "")
    + "</li>"
  )).join("");
  return `<p class="bf-headline" data-tone="${escapeHtml(h.tone || "neutral")}"><strong>${escapeHtml(h.lead || "")}</strong>${escapeHtml(h.text || "")}</p>`
    + (stats ? `<div class="bf-stats">${stats}</div>` : "") // 格子随模块增减（v2.47），一格都没有时不留空卡
    + (notes ? `<section class="bf-notes" aria-label="值得留意"><h3>值得留意</h3><ul>${notes}</ul></section>`
      : '<section class="bf-notes" aria-label="值得留意"><h3>值得留意</h3><p class="bf-empty">没有需要留意的事。</p></section>');
}

export function createBriefView({ doc }) {
  const byId = (id) => doc.getElementById(id);

  // brief 为 null = 这一天没有简报；day / today / retentionDays 只用于这时的说明。
  function renderBrief(brief, { nowMs = Date.now(), lastViewedAt = null, day = "", today = "", retentionDays = null } = {}) {
    const body = byId("briefBody");
    if (body) morphInnerHtml(body, briefBodyHtml(brief, { lastViewedAt, day, today, retentionDays }));
    const caption = byId("briefCaption");
    if (caption) caption.textContent = briefCaption(brief, { nowMs, lastViewedAt });
    const title = byId("briefTitle");
    if (title) title.textContent = brief?.final || (!brief && day && day !== today) ? "当日简报" : "今日简报";
  }

  // 取不到时只在还没有内容可看时写说明：已经显示着简报就保留（旧数据比空白有用）。
  function renderError(detail) {
    const body = byId("briefBody");
    if (body && !body.querySelector(".bf-headline")) morphInnerHtml(body, briefErrorHtml(detail));
  }

  // 「昨天」恒可选（后端缺快照时现算定稿）；更早的日子只列归档里有的（最多 31 天）。
  function renderDays({ days = [], today = "" } = {}, selected) {
    const yesterday = today ? previousDay(today) : null;
    for (const btn of doc.querySelectorAll("[data-brief-day]")) {
      const target = btn.dataset.briefDay === "today" ? today : yesterday;
      btn.disabled = !target;
      btn.setAttribute("aria-pressed", String(Boolean(target) && target === selected));
    }
    const select = byId("briefArchiveSelect");
    if (!select) return;
    const older = days.filter((d) => d < today && d !== yesterday);
    select.hidden = older.length === 0;
    const isOlder = older.includes(selected);
    const options = [`<option value=""${isOlder ? "" : " selected"}>更早…</option>`]
      .concat(older.map((d) => `<option value="${escapeHtml(d)}"${d === selected ? " selected" : ""}>${escapeHtml(dayLabel(d, today))}</option>`));
    const html = options.join("");
    if (select.innerHTML !== html) select.innerHTML = html;
  }

  return { renderBrief, renderError, renderDays };
}
