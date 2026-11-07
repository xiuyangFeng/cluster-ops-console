// tunnel-egress-view.js —— 「经隧道出网的程序」的 HTML 片段（纯字符串函数，Node 可测）。
// 输入是 tunnel-egress-model.js 的模型；输出交给 load-panel.js 用 morphInnerHtml 就地修补 #resEgressSection。
// 所有动态文案一律 escapeHtml（程序名来自远端 ss 输出）；样式在 assets/css/tiles.css「经隧道出网的程序」。
import { escapeHtml } from "../store.js";

function rowHtml(row) {
  const bytes = row.bytesText ? `<span class="res-egress-sep"> · </span><span class="res-egress-bytes">${escapeHtml(row.bytesText)}</span>` : "";
  return (
    `<li class="res-egress-row" data-other="${row.other ? "true" : "false"}" title="${escapeHtml(row.title || "")}">` +
    `<span class="res-egress-name">${escapeHtml(row.name)}</span>` +
    `<span class="res-egress-sep"> · </span><span class="res-egress-conns">${escapeHtml(row.connsText)}</span>` +
    `${bytes}</li>`
  );
}

export function buildTunnelEgressHtml(model) {
  if (!model?.visible) return "";
  const meta = model.portText ? `<span class="res-egress-meta">${escapeHtml(model.portText)}</span>` : "";
  const head = `<div class="res-egress-head"><h3>经隧道出网的程序</h3>${meta}</div>`;
  const notice = model.notice ? `<p class="res-egress-note" data-state="${escapeHtml(model.state || "")}">${escapeHtml(model.notice)}</p>` : "";
  const rows = Array.isArray(model.rows) && model.rows.length ? `<ul class="res-egress-list">${model.rows.map(rowHtml).join("")}</ul>` : "";
  const more = model.more ? `<p class="res-egress-more">${escapeHtml(model.more)}</p>` : "";
  const total = model.total?.text
    ? `<p class="res-egress-total"${model.total.title ? ` title="${escapeHtml(model.total.title)}"` : ""}>${escapeHtml(model.total.text)}</p>`
    : "";
  return head + notice + rows + more + total;
}
