// tunnel-egress-view.js —— 「经隧道出网的程序」的 HTML 片段（纯字符串函数，Node 可测）。
// 输入是 tunnel-egress-model.js 的模型；输出交给 load-panel.js 用 morphInnerHtml 就地修补 #resEgressSection。
// 所有动态文案一律 escapeHtml（程序名来自远端 ss 输出）；样式在 assets/css/tiles.css「经隧道出网的程序」。
import { escapeHtml } from "../store.js";

const EGRESS_COLORS = [
  "var(--cyan)",
  "var(--green)",
  "var(--accent)",
  "var(--yellow)",
  "var(--orange, #f59e0b)",
  "var(--purple, #a78bfa)",
];

function bytesBadgesHtml(bytesText) {
  if (!bytesText) return "";
  const parts = String(bytesText).trim().split(/\s+/).filter(Boolean);
  return parts
    .map((p) => {
      const dir = p.startsWith("↑") ? "up" : p.startsWith("↓") ? "down" : "neutral";
      return `<span class="res-egress-chip" data-dir="${dir}">${escapeHtml(p)}</span>`;
    })
    .join("");
}

function rowHtml(row, maxConns, totalConns, idx) {
  const pctMax = maxConns > 0 ? Math.max(4, Math.min(100, Math.round((row.conns / maxConns) * 100))) : 0;
  const pctTotal = totalConns > 0 ? Math.round((row.conns / totalConns) * 100) : 0;
  const color = row.other ? "var(--muted)" : EGRESS_COLORS[idx % EGRESS_COLORS.length];
  const bytes = row.bytesText ? `<span class="res-egress-bytes">${bytesBadgesHtml(row.bytesText)}</span>` : "";
  const glyph = row.other ? "?" : escapeHtml((row.name || "?").slice(0, 1).toUpperCase());
  return (
    `<li class="res-egress-row" data-other="${row.other ? "true" : "false"}" style="--egress-color:${color}" title="${escapeHtml(row.title || "")}">` +
    `<span class="res-egress-badge" aria-hidden="true">${glyph}</span>` +
    `<span class="res-egress-name">${escapeHtml(row.name)}</span>` +
    `<span class="res-egress-bar" aria-hidden="true"><span class="res-egress-bar-fill" style="width:${pctMax}%"></span></span>` +
    `<span class="res-egress-conns">${escapeHtml(row.connsText)}${pctTotal > 0 ? ` <b>${pctTotal}%</b>` : ""}</span>` +
    `${bytes}</li>`
  );
}

function distributionBarHtml(rows, totalConns) {
  if (!rows.length || totalConns <= 0) return "";
  const segments = rows
    .map((row, idx) => {
      const pct = Math.max(2, (row.conns / totalConns) * 100);
      const color = row.other ? "var(--muted)" : EGRESS_COLORS[idx % EGRESS_COLORS.length];
      return `<span class="res-egress-seg" style="width:${pct.toFixed(2)}%;background:${color}" title="${escapeHtml(row.name)} · ${escapeHtml(row.connsText)}"></span>`;
    })
    .join("");
  return `<div class="res-egress-dist" aria-hidden="true">${segments}</div>`;
}

export function buildTunnelEgressHtml(model) {
  if (!model?.visible) return "";
  const meta = model.portText
    ? `<span class="res-egress-meta"><span class="res-egress-pulse" data-state="${escapeHtml(model.state || "")}" aria-hidden="true"></span>${escapeHtml(model.portText)}</span>`
    : "";
  const totalBadge = model.total?.text
    ? `<span class="res-egress-total-pill" title="${escapeHtml(model.total.title || "")}">${escapeHtml(model.total.text)}</span>`
    : "";
  const head = `<div class="res-egress-head"><div class="res-egress-head-left"><h3>经隧道出网的程序</h3>${meta}</div>${totalBadge}</div>`;
  const notice = model.notice ? `<p class="res-egress-note" data-state="${escapeHtml(model.state || "")}">${escapeHtml(model.notice)}</p>` : "";
  const listRows = Array.isArray(model.rows) ? model.rows : [];
  const maxConns = listRows.reduce((m, r) => Math.max(m, r.conns || 0), 0);
  const totalConns = listRows.reduce((s, r) => s + (r.conns || 0), 0);
  const dist = listRows.length ? distributionBarHtml(listRows, totalConns) : "";
  const rows = listRows.length
    ? `<ul class="res-egress-list">${listRows.map((r, i) => rowHtml(r, maxConns, totalConns, i)).join("")}</ul>`
    : "";
  const more = model.more ? `<p class="res-egress-more">${escapeHtml(model.more)}</p>` : "";
  const total = model.total?.text
    ? `<p class="res-egress-total"${model.total.title ? ` title="${escapeHtml(model.total.title)}"` : ""}>${escapeHtml(model.total.text)}</p>`
    : "";
  return head + notice + dist + rows + more + total;
}
