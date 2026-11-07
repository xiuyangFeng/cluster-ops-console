// render/tunnel-stability-view.js —— 概览「隧道稳定性」的 HTML（模型见 tunnel-stability-model.js）。
// 位置：链路面板底部（#chainUptime），每条隧道一行——名称 | 在线条 + SSH 响应细线 | 当前状态 +「N 次断线 · 可用率」，
// 下面一行「最近一次」与可展开的断线清单。原服务器页的「隧道稳定性」面板已并入这里（v2.46）。
// 动态文案一律 escapeHtml；语气只写 data-tone（配色在 assets/css/brief.css 的 .cu-* 与 tunnels.css 的 .ts-*）。
// 正文经 morphInnerHtml 就地修补，30s 刷新不丢焦点、不闪；交互全走 #chainUptime 上的事件委托（控制器）。
import { morphInnerHtml } from "../dom-utils.js";
import { escapeHtml } from "../store.js";
import {
  buildDropRows, buildHandoverRows, buildStabilityRows, causeLabel, causeLines, countDropRows, humanDuration, lastDropText, responseHoverAt, responsePaths,
  shortDateTime, sinceCaption, uptimeTicks, windowStartOf,
} from "./tunnel-stability-model.js";

// SSH 响应线的坐标系（preserveAspectRatio="none" 横向拉伸到条的宽度；线宽用 non-scaling-stroke 不跟着变形）。
const RESPONSE_W = 600;
const RESPONSE_H = 14;

const pct = (v, start, span) => `${(((v - start) / span) * 100).toFixed(3)}%`;

// 在线条下面的 SSH 响应细线：与条共用时间轴，中位 / 最慢写在悬停提示里（概览上不再单占一行说明）。
// 十字线与气泡沿用资源趋势的 .trend-crosshair / .trend-value-bubble（tiles.css），由视图里的悬停处理定位。
export function responseHtml(response, serverId) {
  if (!response) return "";
  const { line, area } = responsePaths(response, RESPONSE_W, RESPONSE_H);
  return `<div class="trend-chart-container ts-resp cu-resp" data-server="${escapeHtml(serverId)}" title="${escapeHtml(`SSH 响应 · 中位 ${response.medianText} · 最慢 ${response.slowestText}（${response.title.replace(/^SSH 响应 · /, "")}）`)}">`
    + `<svg viewBox="0 0 ${RESPONSE_W} ${RESPONSE_H}" preserveAspectRatio="none" role="img" aria-label="近 24 小时 SSH 响应耗时，中位 ${escapeHtml(response.medianText)}">`
    + `<line class="ts-resp-base" x1="0" x2="${RESPONSE_W}" y1="${RESPONSE_H - 0.5}" y2="${RESPONSE_H - 0.5}"/>`
    + `<path class="ts-resp-area" d="${escapeHtml(area)}"/><path class="ts-resp-line" d="${escapeHtml(line)}"/></svg>`
    + '<div class="trend-crosshair"></div><div class="trend-value-bubble"></div></div>';
}

// 一条隧道的条：近 24 小时 = 分段条（红 = 断开，可点；斜纹 = 没有记录或电脑休眠，悬停说明是哪种；竖线 = 今天 0 点）+ SSH 响应细线；
// 近 7 天 = 7 块日色块（日期只在最后一行写，各行共用）。
export function stripHtml(strip, { response = null, serverId = "", midnight = null, labels = true } = {}) {
  if (!strip) return "";
  if (strip.kind === "daily") {
    const cells = strip.days.map((d) => `<span class="ts-day" data-tone="${d.tone}" title="${escapeHtml(d.title)}"><i></i>${labels ? `<b>${escapeHtml(d.label)}</b>` : ""}</span>`).join("");
    return `<div class="ts-strip-daily cu-daily" aria-label="近 7 天每日在线情况">${cells}</div>`;
  }
  if (!Number.isFinite(strip.start) || !Number.isFinite(strip.end)) return '<div class="cu-track"><span class="cu-bar"></span></div>';
  const span = Math.max(1, strip.end - strip.start);
  const segs = (strip.segments || []).map((seg) => {
    const width = `max(2px, ${(((seg.to - seg.from) / span) * 100).toFixed(3)}%)`;
    if (seg.state === "unobserved") {
      return `<span class="cu-unobserved" style="left:${pct(seg.from, strip.start, span)};width:${width}" title="没有记录（账本开始之前 / 应用未运行 / 电脑睡眠）"></span>`;
    }
    // 待命（v2.88）：同账号另一台 Mac 在承载，集群照常出网——淡色，不是断线。
    if (seg.state === "standby") {
      const title = `${shortDateTime(seg.from)} 起由另一台 Mac 承载 · ${humanDuration(seg.to - seg.from)}（本机待命，不计入断线与可用率）`;
      return `<span class="cu-standby" style="left:${pct(seg.from, strip.start, span)};width:${width}" title="${escapeHtml(title)}"></span>`;
    }
    // 休眠：与「没有记录」同样的斜纹（都不是断线），悬停写明是休眠、多久。
    if (seg.state === "sleep") {
      const title = `${shortDateTime(seg.from)} ${causeLabel("sleep")} · ${humanDuration(seg.to - seg.from)}（期间隧道不可用，不计入断线与可用率）`;
      return `<span class="cu-unobserved" style="left:${pct(seg.from, strip.start, span)};width:${width}" title="${escapeHtml(title)}"></span>`;
    }
    const title = `${shortDateTime(seg.from)} ${causeLabel(seg.cause)} · ${seg.to >= strip.end - 1000 ? "断开中" : `断开 ${humanDuration(seg.to - seg.from)}`}（点击查看）`;
    return `<button type="button" class="cu-drop" style="left:${pct(seg.from, strip.start, span)};width:${width}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}" data-drop-key="${escapeHtml(`${serverId}:${seg.at ?? seg.from}`)}"></button>`;
  }).join("");
  return `<div class="cu-track"><span class="cu-bar">${midnight ? `<span class="cu-midnight" style="left:${midnight.left}"></span>` : ""}${segs}</span>${responseHtml(response, serverId)}</div>`;
}

// 断线清单：时间 / 服务器 / 原因 / 恢复用时（「此前在线」与原始报错放在整行的悬停提示里，链路面板放不下五列）。
// 组行（连续同一服务器同一原因）：▸/▾ + 次数徽标，整行可点击 / 回车展开；逐条行缩进跟在后面。
// 「本机休眠」那一行不是断线：不标红（data-ongoing 恒为 false），悬停说明它不计入断线次数与可用率。
function dropsTableHtml(rows) {
  if (!rows.length) return '<p class="ts-empty">这段时间没有断线记录。</p>';
  const body = rows.map((r) => {
    if (r.kind === "group") {
      return `<tr class="ts-group" data-group="${escapeHtml(r.key)}" data-ongoing="${r.ongoing}" aria-expanded="${r.expanded}" tabindex="0" title="${escapeHtml(r.sleep ? r.title : `${r.title} · 此前在线 ${r.uptime}`)}">`
        + `<td class="ts-num"><span class="ts-group-caret" aria-hidden="true">${r.expanded ? "▾" : "▸"}</span>${escapeHtml(r.time)}</td><td>${escapeHtml(r.name)}</td>`
        + `<td>${escapeHtml(r.cause)}<span class="ts-group-count">×${r.count}</span>${r.networkChangeCount ? `<span class="ts-tag">换网 ${r.networkChangeCount}</span>` : ""}</td>`
        + `<td class="ts-num">${escapeHtml(r.recovery)}</td></tr>`;
    }
    const title = r.sleep ? r.detail : [`此前在线 ${r.uptime}`, r.detail].filter(Boolean).join(" · ");
    return `<tr data-ongoing="${r.ongoing}" data-key="${escapeHtml(r.key)}"${r.child ? ` class="ts-group-child" data-parent="${escapeHtml(r.groupKey)}"` : ""} title="${escapeHtml(title)}">`
      + `<td class="ts-num">${escapeHtml(r.time)}</td><td>${escapeHtml(r.name)}</td>`
      + `<td>${escapeHtml(r.cause)}${r.networkChange ? '<span class="ts-tag">换网</span>' : ""}</td>`
      + `<td class="ts-num">${escapeHtml(r.recovery)}</td></tr>`;
  }).join("");
  return '<table class="ts-table cu-drops-table"><thead><tr><th scope="col">时间</th><th scope="col">服务器</th><th scope="col">原因</th>'
    + `<th scope="col">恢复用时</th></tr></thead><tbody>${body}</tbody></table>`;
}

const LEGEND = {
  "24h": '<i class="cu-key"></i>在线<i class="cu-key cu-key-drop"></i>断开<i class="cu-key cu-key-none"></i>无记录<i class="cu-key cu-key-resp"></i>SSH 响应',
  "7d": '<i class="cu-key"></i>无断线<i class="cu-key cu-key-warn"></i>有断线<i class="cu-key cu-key-drop"></i>较多<i class="cu-key cu-key-none"></i>无记录',
};

// 整块 HTML。没有建隧道的服务器 → 空串（整块隐藏）。返回 { html, dropRows（控制器定位断线用）, rows }。
export function stabilityHtml(stats, { windowKey = "24h", nowMs = Date.now(), responses = null, expandedDrops = new Set(), dropsOpen = false } = {}) {
  const rows = buildStabilityRows(stats, windowKey, nowMs, responses).filter((row) => row.strip.kind === "daily" || Number.isFinite(row.strip.start));
  if (!rows.length) return { html: "", dropRows: [], rows };
  const timeline = rows.find((row) => row.strip.kind === "timeline")?.strip;
  const ticks = timeline ? uptimeTicks(timeline.start, timeline.end) : [];
  const midnight = ticks.find((t) => t.today) || null;
  const windowButtons = ["24h", "7d"].map((key) => `<button type="button" data-stability-window="${key}" aria-pressed="${key === windowKey}">${key === "7d" ? "7 天" : "24 小时"}</button>`).join("");
  let html = `<div class="cu-head"><span class="cu-title"><b title="${escapeHtml(sinceCaption(stats))}">隧道稳定性</b>`
    + `<fieldset class="us-segmented us-segmented-sm cu-window" aria-label="统计窗口">${windowButtons}</fieldset></span>`
    + `<span class="cu-legend">${LEGEND[windowKey] || LEGEND["24h"]}</span></div>`;
  html += rows.map((row, i) => (
    `<div class="cu-row" data-server="${escapeHtml(row.serverId)}"><span class="cu-name" title="${escapeHtml(row.fullName)}">${escapeHtml(row.name)}</span>`
    + stripHtml(row.strip, { response: row.response, serverId: row.serverId, midnight, labels: i === rows.length - 1 })
    + `<span class="cu-state" data-tone="${row.stateTone}"><span>${escapeHtml(row.stateText)}</span>`
    + `<small class="cu-summary" data-tone="${row.summaryTone}" title="${escapeHtml(row.summaryTitle)}">${escapeHtml(row.summaryText)}</small></span></div>`
  )).join("");
  if (windowKey !== "7d" && ticks.length) {
    const axis = ticks.map((t) => `<span class="cu-tick${t.today ? " cu-tick-today" : ""}" style="left:${t.left}">${t.label}</span>`).join("");
    html += `<div class="cu-row cu-axis-row" aria-hidden="true"><span></span><span class="cu-axis">${axis}</span><span class="cu-now">现在</span></div>`;
  }
  const total = rows.reduce((n, row) => n + row.drops, 0);
  const dropRows = buildDropRows(stats, undefined, { expanded: expandedDrops, since: windowStartOf(stats, windowKey) });
  // 清单里可能还有「本机休眠」的行：不算进断线次数；窗口里只有休眠、没有断线时按钮改说休眠了几次。
  const { drops: listed, sleeps: sleepRows } = countDropRows(dropRows);
  const slept = sleepRows ? Number(stats?.sleep?.[windowKey]?.count) || sleepRows : 0;
  const open = dropsOpen && (total > 0 || slept > 0);
  const last = lastDropText(stats);
  html += `<div class="cu-foot"><span class="cu-last" title="${escapeHtml(last)}"><span class="cu-label">最近一次</span>${escapeHtml(last)}</span>`
    + (total || slept ? `<button type="button" class="cu-more" data-stability-drops aria-expanded="${open}" aria-controls="stabilityDrops">${total ? `全部 ${total} 次` : `休眠 ${slept} 次`}<span aria-hidden="true">${open ? "▴" : "▾"}</span></button>` : "")
    + "</div>";
  // 承载切换记录（同账号多台 Mac 接力，v2.88）：有就列，不折叠——一天通常只有几条。
  const handovers = buildHandoverRows(stats, { since: windowStartOf(stats, windowKey) });
  if (handovers.length) {
    html += `<div class="cu-handovers" aria-label="承载切换记录"><span class="cu-label">承载切换</span>`
      + handovers.map((h) => `<span class="cu-handover" data-role="${escapeHtml(h.role)}"><b>${escapeHtml(h.time)}</b> ${escapeHtml(h.name)} · ${escapeHtml(h.text)}</span>`).join("")
      + "</div>";
  }
  if (open) {
    const causes = causeLines(stats, windowKey).map((c) => `<span><b>${escapeHtml(c.name)}</b>${escapeHtml(c.text)}</span>`).join("");
    const more = listed < total ? `<p class="cu-drops-note">只列出最近 ${listed} 次。</p>` : "";
    html += `<div class="cu-drops" id="stabilityDrops">${causes ? `<p class="cu-causes">${causes}</p>` : ""}${dropsTableHtml(dropRows)}${more}</div>`;
  }
  return { html, dropRows, rows };
}

export function createTunnelStabilityView({ doc, win = typeof window !== "undefined" ? window : null }) {
  const byId = (id) => doc.getElementById(id);
  // 最近一次渲染的各服务器响应线模型：悬停时按它取数。
  let responses = new Map();
  let hoverBound = false;

  // SSH 响应线的悬停：整块是 morphInnerHtml 维护的，监听挂在容器上（事件委托）；每帧最多处理一次。
  // 无精确指针 hover 能力（触屏等）不挂监听。重渲会把十字线 / 气泡的状态同步回初始，下一次移动再显示。
  function bindResponseHover(rootEl) {
    if (hoverBound || !rootEl?.addEventListener) return;
    hoverBound = true;
    if (!win?.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    const raf = win.requestAnimationFrame?.bind(win) || ((fn) => setTimeout(fn, 16));
    let active = null;
    let pending = null;
    let frame = 0;
    const hide = () => {
      if (!active) return;
      active.querySelector(".trend-crosshair")?.classList.remove("visible");
      active.querySelector(".trend-value-bubble")?.classList.remove("visible");
      active = null;
    };
    const update = () => {
      frame = 0;
      const { box, clientX } = pending || {};
      if (box !== active) hide();
      const rect = box?.getBoundingClientRect();
      const hit = rect && rect.width > 0 ? responseHoverAt(responses.get(box.dataset.server), (clientX - rect.left) / rect.width) : null;
      const cross = box?.querySelector(".trend-crosshair");
      const bubble = box?.querySelector(".trend-value-bubble");
      if (!hit || !cross || !bubble) {
        hide();
        return;
      }
      active = box;
      const left = hit.left * rect.width;
      if (bubble.textContent !== hit.text) bubble.textContent = hit.text;
      cross.style.left = `${left}px`;
      cross.classList.add("visible");
      bubble.classList.add("visible");
      const half = (bubble.offsetWidth || 0) / 2;
      bubble.style.left = `${Math.max(half + 2, Math.min(rect.width - half - 2, left))}px`;
    };
    rootEl.addEventListener("pointermove", (event) => {
      pending = { box: event.target?.closest?.(".ts-resp") || null, clientX: event.clientX };
      if (!frame) frame = raf(update);
    });
    rootEl.addEventListener("pointerleave", () => {
      pending = null;
      hide();
    });
  }

  // state：{ windowKey, nowMs, responses（Map<serverId, [{ ts, ms }]>）, expandedDrops, dropsOpen }。返回本次的断线行，供控制器定位。
  function render(stats, state = {}) {
    const el = byId("chainUptime");
    if (!el) return [];
    const { html, dropRows, rows } = stabilityHtml(stats, state);
    responses = new Map(rows.filter((row) => row.response).map((row) => [row.serverId, row.response]));
    el.hidden = !html;
    if (html) {
      morphInnerHtml(el, html);
      bindResponseHover(el);
    }
    return dropRows;
  }

  return { render };
}
