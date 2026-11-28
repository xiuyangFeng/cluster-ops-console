// render/usage-observatory.js —— 用量页星空版 / 纸面版的「星图总览舱」（#usageGalaxyStage；简洁版隐藏，仍用 .us-metrics 四卡）。
//
// 左舱：范围标题 + 同期对比徽标 + 双环恒星光谱星盘（外环 Token 四维构成、内环缓存命中率）+ Token 总量大字
//      + 发射光谱构成条（缓存读取 / 普通输入 / 缓存写入 / 输出）+ 四项带微缩计量条的读数；
// 右舱：上方「Agent 星系构成」分段光带与可点胶囊（占比 / 花费 / 上下文均值），下方「模型星等」彗星轨
//      （彗头是星，尾长 = 相对最大模型的 Token 用量，轨底细线 = 缓存命中率，点一条按 Agent 筛选，再点取消）。
// 数据只用 /api/usage/summary 的真实聚合字段，不补位、不造数；纯函数，Node 下可直接测。
import { escapeHtml } from "../store.js";
import {
  AGENT_LABELS, causesText, clockOf, dateLabel, failureDetailText, formatDuration, formatUsd, integer, monthDay, ratioText, shortTokens, splitTokens,
} from "./usage-model.js";

export const OBSERVATORY_MODEL_LIMIT = 5;

const SPECTRUM_DEFS = [
  { key: "cacheRead", label: "缓存读取", short: "缓读" },
  { key: "inFresh", label: "普通输入", short: "输入" },
  { key: "cacheWrite", label: "缓存写入", short: "缓写" },
  { key: "output", label: "输出", short: "输出" },
];

const pctText = (share) => (share >= 0.995 ? "100%" : share >= 0.1 ? `${Math.round(share * 100)}%` : share >= 0.005 ? `${(share * 100).toFixed(1)}%` : "<0.5%");

// 缓存命中率：缓存读取 / (缓存读取 + 未命中输入)。两者都没有返回 null。
export function hitRateOf(cacheRead, fresh) {
  const read = Number(cacheRead) || 0;
  const miss = Number(fresh) || 0;
  return read + miss > 0 ? read / (read + miss) : null;
}

// Token 四维发射光谱构成：只返回真实大于 0 的维度，不造假段。
export function observatorySpectrum(kpis) {
  if (!kpis) return { total: 0, segments: [] };
  const raw = SPECTRUM_DEFS.map((d) => ({ ...d, tokens: Math.max(0, Number(kpis[d.key]) || 0) }));
  const sum = raw.reduce((acc, item) => acc + item.tokens, 0);
  if (sum <= 0) return { total: 0, segments: [] };
  const segments = raw
    .filter((item) => item.tokens > 0)
    .map((item) => ({ ...item, share: item.tokens / sum }));
  return { total: sum, segments };
}

// Agent 星系占比：优先用后端精确聚合的 summary.byAgent；缺省时由 summary.models 归并兜底。
export function observatoryAgents(summary) {
  const source = Array.isArray(summary?.byAgent) && summary.byAgent.length
    ? summary.byAgent
    : (() => {
      const byMap = new Map();
      for (const m of summary?.models || []) {
        if (!m || !(m.total > 0 || m.calls > 0)) continue;
        const id = AGENT_LABELS[m.agent] ? m.agent : "custom";
        const cur = byMap.get(id) || { agent: id, total: 0, costUsd: 0, calls: 0, errors: 0, cacheRead: 0, fresh: 0, ctxRatio: null };
        cur.total += Number(m.total) || 0;
        cur.costUsd += Number(m.costUsd) || 0;
        cur.calls += Number(m.calls) || 0;
        cur.errors += Number(m.errors) || 0;
        cur.cacheRead += Number(m.cacheRead) || 0;
        cur.fresh += Number(m.fresh) || 0;
        byMap.set(id, cur);
      }
      return [...byMap.values()].map((item) => ({ ...item, hitRate: hitRateOf(item.cacheRead, item.fresh) }));
    })();
  const active = source
    .filter((a) => a && (Number(a.total) > 0 || Number(a.calls) > 0))
    .map((a) => {
      const id = AGENT_LABELS[a.agent] ? a.agent : "custom";
      return {
        agent: id,
        label: AGENT_LABELS[id] || id,
        total: Number(a.total) || 0,
        costUsd: Number(a.costUsd) || 0,
        calls: Number(a.calls) || 0,
        errors: Number(a.errors) || 0,
        hitRate: a.hitRate === undefined ? hitRateOf(a.cacheRead, a.fresh) : a.hitRate,
        ctxRatio: typeof a.ctxRatio === "number" && Number.isFinite(a.ctxRatio) ? a.ctxRatio : null,
      };
    })
    .sort((a, b) => b.total - a.total || b.costUsd - a.costUsd);
  const grand = active.reduce((sum, a) => sum + a.total, 0);
  return active.map((a) => ({ ...a, share: grand > 0 ? a.total / grand : 0 }));
}

// summary.models → 彗星行。最多 limit 条，其余并成一行「其余 N 个」。
// live：这个模型有「近期活跃」的会话（会话的主模型与之同名）。
export function observatoryModels(summary, { limit = OBSERVATORY_MODEL_LIMIT } = {}) {
  const models = Array.isArray(summary?.models) ? summary.models.filter((m) => m && (m.total > 0 || m.calls > 0)) : [];
  const grand = models.reduce((sum, m) => sum + (Number(m.total) || 0), 0);
  const peak = Math.max(1, ...models.map((m) => Number(m.total) || 0));
  const liveModels = new Set((summary?.sessions || []).filter((s) => s?.status === "recent" && s.model).map((s) => s.model));
  const rows = models.slice(0, limit).map((m) => ({
    model: String(m.model || ""),
    agent: AGENT_LABELS[m.agent] ? m.agent : "custom",
    total: Number(m.total) || 0,
    calls: Number(m.calls) || 0,
    errors: Number(m.errors) || 0,
    share: grand > 0 ? (Number(m.total) || 0) / grand : 0,
    reach: (Number(m.total) || 0) / peak,
    hitRate: hitRateOf(m.cacheRead, m.fresh),
    costUsd: Number(m.costUsd) || 0,
    live: liveModels.has(m.model),
  }));
  const restList = models.slice(limit);
  const rest = restList.length
    ? { count: restList.length, total: restList.reduce((sum, m) => sum + (Number(m.total) || 0), 0), names: restList.map((m) => String(m.model || "")) }
    : null;
  return { rows, rest, grand };
}

// 标题：今天的星图 / 近 7 天 / 近 30 天 / 某一天。
export function observatoryTitle(summary, state) {
  const scope = summary?.scope;
  if (!scope) return { title: "星图", caption: "—" };
  if (state?.date) {
    const isToday = state.date === summary.today;
    return { title: isToday ? "今日星图" : `${dateLabel(state.date)}星图`, caption: isToday ? `${dateLabel(state.date)} · 截至 ${clockOf(summary.now)}` : "全天" };
  }
  if (scope.days === 1) return { title: "今日星图", caption: `${dateLabel(summary.today)} · 截至 ${clockOf(summary.now)}` };
  const days = { 7: "七日", 30: "三十日" }[scope.days] || `${scope.days} 天`;
  return { title: `${days}星图`, caption: `${dateLabel(scope.start)} — ${dateLabel(scope.end)}` };
}

// 双环恒星光谱星盘（外环：Token 四维光谱占比；内环：缓存命中率；中心：四芒主星）。
export function astrolabeSvg(kpis, spectrum = observatorySpectrum(kpis)) {
  const hit = kpis?.hitRate == null ? null : Math.max(0, Math.min(1, Number(kpis.hitRate)));
  let offset = 0;
  const outerArcs = spectrum.segments.map((seg) => {
    const len = Math.max(0.8, seg.share * 100);
    const arc = `<circle cx="34" cy="34" r="27" pathLength="100" class="ob-ring-arc" data-spec="${seg.key}" style="stroke-dasharray:${len.toFixed(2)} 100;stroke-dashoffset:${(-offset).toFixed(2)}"/>`;
    offset += seg.share * 100;
    return arc;
  }).join("");
  const innerArc = hit !== null && hit > 0
    ? `<circle cx="34" cy="34" r="18.5" pathLength="100" class="ob-ring-arc is-hit" style="stroke-dasharray:${(hit * 100).toFixed(2)} 100"/>`
    : "";
  const tipParts = spectrum.segments.map((s) => `${s.label} ${pctText(s.share)}（${shortTokens(s.tokens)}）`);
  if (hit !== null) tipParts.push(`缓存命中 ${(hit * 100).toFixed(1)}%`);
  const tip = tipParts.length ? tipParts.join(" · ") : "当前范围暂无 Token 构成";
  return `<svg class="ob-astrolabe" viewBox="0 0 68 68" width="64" height="64" role="img" aria-label="${escapeHtml(tip)}">`
    + `<title>${escapeHtml(tip)}</title>`
    + '<circle cx="34" cy="34" r="32" class="ob-astro-meridian"/>'
    + '<line x1="34" y1="0.5" x2="34" y2="4.5" class="ob-astro-tick"/><line x1="67.5" y1="34" x2="63.5" y2="34" class="ob-astro-tick"/>'
    + '<line x1="34" y1="67.5" x2="34" y2="63.5" class="ob-astro-tick"/><line x1="0.5" y1="34" x2="4.5" y2="34" class="ob-astro-tick"/>'
    + '<circle cx="34" cy="34" r="27" class="ob-astro-track"/>'
    + outerArcs
    + '<circle cx="34" cy="34" r="18.5" class="ob-astro-track is-inner"/>'
    + innerArc
    + '<path class="ob-astro-star" d="M34,26.5L35.7,32.3L41.5,34L35.7,35.7L34,41.5L32.3,35.7L26.5,34L32.3,32.3Z"/>'
    + "</svg>";
}

function spectrumHtml(kpis) {
  const spectrum = observatorySpectrum(kpis);
  if (!spectrum.segments.length) {
    return '<div class="ob-spectrum is-empty"><div class="ob-spectrum-bar" aria-hidden="true"></div><div class="ob-spectrum-legend"><span>等待模型调用光谱…</span></div></div>';
  }
  const segs = spectrum.segments.map((s) => `<span class="ob-spec-seg" data-spec="${s.key}" style="width:${(Math.max(0.015, s.share) * 100).toFixed(2)}%" title="${escapeHtml(`${s.label}：${shortTokens(s.tokens)}（${pctText(s.share)}）`)}"></span>`).join("");
  const legend = spectrum.segments.map((s) => `<span class="ob-spec-item" title="${escapeHtml(`${s.label}：${integer(s.tokens)} Token`)}"><i class="ob-spec-dot" data-spec="${s.key}"></i>${escapeHtml(s.short)} <b>${pctText(s.share)}</b></span>`).join("");
  return `<div class="ob-spectrum"><div class="ob-spectrum-bar" role="img" aria-label="Token 光谱构成">${segs}</div><div class="ob-spectrum-legend">${legend}</div></div>`;
}

function comparisonPillsHtml(summary) {
  const c = summary?.insights?.comparison;
  if (!c?.covered || c.scanIncomplete) return "";
  const prevRange = c.previousScope.start === c.previousScope.end
    ? monthDay(c.previousScope.start)
    : `${monthDay(c.previousScope.start)}–${monthDay(c.previousScope.end)}`;
  const items = [];
  if (c.costRatio !== null && c.costRatio !== undefined) {
    const diff = (c.costRatio - 1) * 100;
    const arrow = diff > 0.05 ? "▲" : diff < -0.05 ? "▼" : "";
    const txt = `${Math.abs(diff) >= 1000 ? Math.round(Math.abs(diff)) : Math.abs(diff).toFixed(1)}%`;
    items.push(`<span class="ob-comp-pill${diff > 0.05 ? " is-worse" : diff < -0.05 ? " is-better" : ""}" title="${escapeHtml(`等效花费对比 ${prevRange}${c.sameTime ? " 同时段" : ""}：${formatUsd(c.previous.costUsd)} → ${formatUsd(c.current.costUsd)}`)}">花费 ${arrow}${txt}</span>`);
  }
  if (c.tokenRatio !== null && c.tokenRatio !== undefined) {
    const diff = (c.tokenRatio - 1) * 100;
    const arrow = diff > 0.05 ? "▲" : diff < -0.05 ? "▼" : "";
    const txt = `${Math.abs(diff) >= 1000 ? Math.round(Math.abs(diff)) : Math.abs(diff).toFixed(1)}%`;
    items.push(`<span class="ob-comp-pill${diff > 0.05 ? " is-worse" : ""}" title="${escapeHtml(`Token 用量对比 ${prevRange}${c.sameTime ? " 同时段" : ""}：${shortTokens(c.previous.total)} → ${shortTokens(c.current.total)}`)}">Token ${arrow}${txt}</span>`);
  }
  return items.length ? `<div class="ob-comp-pills">${items.join("")}</div>` : "";
}

function readout(label, value, unit, sub, meterHtml, extraClass = "") {
  return `<div class="ob-readout${extraClass}"><span class="ob-readout-label">${label}</span><span class="ob-readout-value">${value}${unit ? `<small>${unit}</small>` : ""}</span><span class="ob-readout-sub">${sub || "&nbsp;"}</span>${meterHtml}</div>`;
}

function meterSingle(pct, tone) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<span class="ob-readout-meter" aria-hidden="true"><i class="ob-readout-fill" data-tone="${tone}" style="transform:scaleX(${(w / 100).toFixed(3)})"></i></span>`;
}

function readoutsHtml(summary, state) {
  const k = summary.kpis;
  const [freshNum, freshUnit] = splitTokens(k.fresh);
  const ratio = ratioText(k.freshVsAvg);
  const freshSub = ratio ? `<b>${escapeHtml(ratio)}</b> 较近 ${k.freshVsAvg.days} 日${k.freshVsAvg.sameTime ? "同时段" : ""}均值` : `普通 ${shortTokens(k.inFresh)} · 缓存写入 ${shortTokens(k.cacheWrite)}`;
  const freshPct = k.freshVsAvg?.ratio != null
    ? Math.min(100, k.freshVsAvg.ratio * 50)
    : (k.total > 0 ? Math.min(100, (k.fresh / k.total) * 100) : 0);

  const hit = k.hitRate === null || k.hitRate === undefined ? null : k.hitRate;
  const hitSub = k.savedUsd > 0 ? `缓存净省 <b>${formatUsd(k.savedUsd)}</b>` : `缓存读取 ${shortTokens(k.cacheRead)}`;

  let callsSub;
  if (k.errors) {
    // 行内只写有状态码的（502×5 …）；没有状态码的失败与按原文的归类放进悬停说明，不重复写「失败×N」
    const coded = Object.fromEntries(Object.entries(k.codes || {}).filter(([code]) => code !== "error"));
    const detail = failureDetailText(coded, " · ", { limit: 1 });
    const title = [failureDetailText(k.codes, " · "), causesText(k.causes)].filter(Boolean).join("；") || "查看失败的会话";
    callsSub = `<button type="button" class="ob-link" data-usage-jump="errors" title="${escapeHtml(title)}"><i class="ob-flare"></i>失败 <b>${integer(k.errors)}</b>${detail ? ` · ${escapeHtml(detail)}` : ""}</button>`;
  } else {
    callsSub = k.calls ? "全部成功" : "暂无调用";
  }
  const okPct = k.calls > 0 ? Math.max(0, ((k.calls - (k.errors || 0)) / k.calls) * 100) : 0;
  const errPct = k.calls > 0 && k.errors > 0 ? Math.max(3, (k.errors / k.calls) * 100) : 0;
  const callsMeter = `<span class="ob-readout-meter is-dual" aria-hidden="true"><i class="ob-readout-fill" data-tone="ok" style="width:${Math.max(0, 100 - errPct).toFixed(1)}%;transform:scaleX(${(k.calls > 0 ? 1 : 0)})"></i>${errPct > 0 ? `<i class="ob-readout-err" style="width:${errPct.toFixed(1)}%"></i>` : ""}</span>`;

  const single = summary.scope.days === 1;
  const historical = state?.date && state.date !== summary.today;
  const sessionsSub = single
    ? `${!historical && k.recentSessions ? `${k.recentSessions} 个活跃 · ` : ""}${k.turnCount} 轮${k.avgTurnSec == null ? "" : ` · 每轮 ${formatDuration(k.avgTurnSec)}`}`
    : `日均 ${(k.sessions / summary.scope.days).toFixed(1)} 个 · ${k.turnCount} 轮`;
  const sessionPct = single && !historical && k.sessions > 0
    ? Math.max(12, (k.recentSessions / k.sessions) * 100)
    : (k.sessions > 0 ? Math.min(100, Math.log10(k.sessions + 1) * 48) : 0);

  return [
    readout("未命中输入", escapeHtml(freshNum), freshUnit || "Token", freshSub, meterSingle(freshPct, k.freshVsAvg?.ratio > 1.15 ? "warn" : "fresh")),
    readout("缓存命中", hit === null ? "—" : (hit * 100).toFixed(1), hit === null ? "" : "%", hitSub, meterSingle(hit === null ? 0 : hit * 100, "hit")),
    readout("模型调用", integer(k.calls), "次", callsSub, k.errors ? callsMeter : meterSingle(okPct, "ok"), k.errors ? " has-errors" : ""),
    readout("会话", integer(k.sessions), "个", sessionsSub, meterSingle(sessionPct, !historical && k.recentSessions ? "ok" : "session")),
  ].join("");
}

function constellationHtml(summary, state) {
  const agents = observatoryAgents(summary);
  if (!agents.length) return "";
  const barSegs = agents.map((a) => `<span class="ob-agent-seg" data-agent="${escapeHtml(a.agent)}" style="width:${(Math.max(0.015, a.share) * 100).toFixed(2)}%" title="${escapeHtml(`${a.label}：${shortTokens(a.total)}（${pctText(a.share)}）${a.costUsd > 0 ? ` · ${formatUsd(a.costUsd)}` : ""}`)}"></span>`).join("");
  const pills = agents.slice(0, 5).map((a) => {
    const selected = state?.agent && state.agent !== "all" && state.agent === a.agent;
    const ctxText = a.ctxRatio !== null ? ` · 上下文均值 ${Math.round(a.ctxRatio * 100)}%` : "";
    const tip = `${a.label}：${shortTokens(a.total)}（${pctText(a.share)}）${a.costUsd > 0 ? ` · 等效 ${formatUsd(a.costUsd)}` : ""}${ctxText}。点击${selected ? "取消筛选" : `只看 ${a.label}`}`;
    return `<button type="button" class="ob-agent-pill${selected ? " is-selected" : ""}" data-agent="${escapeHtml(a.agent)}" data-usage-pick-agent="${escapeHtml(a.agent)}" aria-pressed="${Boolean(selected)}" title="${escapeHtml(tip)}">`
      + `<i class="ob-agent-dot"></i><span class="ob-agent-name">${escapeHtml(a.label)}</span>`
      + `<span class="ob-agent-pct">${pctText(a.share)}</span>`
      + `${a.costUsd > 0 ? `<span class="ob-agent-cost">${formatUsd(a.costUsd)}</span>` : ""}`
      + "</button>";
  }).join("");
  return `<div class="ob-constellation">`
    + `<div class="ob-agents-bar" role="img" aria-label="Agent 用量星系占比">${barSegs}</div>`
    + `<div class="ob-agent-pills">${pills}</div>`
    + "</div>";
}

function cometHtml(row, state) {
  const label = AGENT_LABELS[row.agent] || row.agent;
  const selected = state?.agent && state.agent !== "all" && state.agent === row.agent;
  const pct = row.share >= 0.995 ? "100%" : row.share >= 0.01 ? `${Math.round(row.share * 100)}%` : "<1%";
  const hit = row.hitRate === null ? "—" : `${Math.round(row.hitRate * 100)}%`;
  const hitWidth = row.hitRate === null ? 0 : Math.round(row.hitRate * 100);
  const title = `${row.model} · ${label}：${integer(row.total)} Token，${integer(row.calls)} 次调用${row.errors ? `（失败 ${row.errors}）` : ""}。点击${selected ? "取消筛选" : `只看 ${label}`}`;
  return `<button type="button" class="ob-comet${row.live ? " is-live" : ""}${selected ? " is-selected" : ""}" data-agent="${escapeHtml(row.agent)}" data-usage-pick-agent="${escapeHtml(row.agent)}" aria-pressed="${Boolean(selected)}" title="${escapeHtml(title)}">`
    + `<span class="ob-comet-name"><span class="ob-comet-model">${escapeHtml(row.model)}</span><span class="ob-comet-agent">${escapeHtml(label)}</span>${row.live ? '<span class="ob-comet-live">活跃</span>' : ""}</span>`
    + `<span class="ob-comet-track" aria-hidden="true"><span class="ob-comet-tail" style="width:${(Math.max(0.012, row.reach) * 100).toFixed(2)}%"></span>${hitWidth > 0 ? `<span class="ob-comet-hitbar" style="width:${hitWidth}%"></span>` : ""}</span>`
    + `<span class="ob-comet-figs"><span class="ob-comet-total">${shortTokens(row.total)}</span><span class="ob-comet-share">${pct}</span><span class="ob-comet-hit" title="缓存命中率">命中 ${hit}</span><span class="ob-comet-cost" title="按官方单价折算的等效花费">${row.costUsd > 0 ? formatUsd(row.costUsd) : "—"}</span></span>`
    + "</button>";
}

// 整块 HTML。summary 为空（首次加载 / 模块关闭）时给占位骨架，高度与有数据时一致，避免跳动。
export function observatoryHtml(summary, state) {
  const k = summary?.kpis;
  if (!k) {
    return '<div class="ob-hero is-empty" aria-busy="true"><div class="ob-hero-main"><div class="ob-hero-left"><span class="ob-eyebrow">星图</span><div class="ob-total"><span class="ob-total-num">—</span></div></div><div class="ob-hero-right"></div></div></div>';
  }
  const { title, caption } = observatoryTitle(summary, state);
  const [num, unit] = splitTokens(k.total);
  const spectrum = observatorySpectrum(k);
  const subParts = [
    k.costUsd > 0 ? `等效 <b>${formatUsd(k.costUsd)}</b>` : "",
    k.savedUsd > 0 ? `净省 <b class="is-saved">${formatUsd(k.savedUsd)}</b>` : "",
    `缓存读取 <b>${shortTokens(k.cacheRead)}</b>`,
    `输出 <b>${shortTokens(k.output)}</b>`,
  ].filter(Boolean);
  const { rows, rest } = observatoryModels(summary);
  const filtered = state?.agent && state.agent !== "all";
  const comets = rows.length
    ? rows.map((row) => cometHtml(row, state)).join("")
    : '<p class="ob-empty">这个范围没有模型调用</p>';
  const restHtml = rest ? `<p class="ob-rest" title="${escapeHtml(rest.names.join("、"))}">其余 ${rest.count} 个模型 · ${shortTokens(rest.total)}</p>` : "";
  return `<div class="ob-hero">`
    + '<div class="ob-hero-main">'
    + '<div class="ob-hero-left">'
    + `<div class="ob-heading"><h2 class="ob-title">${escapeHtml(title)}</h2><span class="ob-eyebrow">${escapeHtml(caption)}</span>${comparisonPillsHtml(summary)}</div>`
    + `<div class="ob-core-row">${astrolabeSvg(k, spectrum)}<div class="ob-core-copy">`
    + `<div class="ob-total" aria-label="Token 总量 ${escapeHtml(num + unit)}"><span class="ob-total-num">${escapeHtml(num)}</span><span class="ob-total-unit">${escapeHtml(unit)}</span><span class="ob-total-label">Token 总量</span></div>`
    + `<p class="ob-total-sub">${subParts.join('<i class="ob-sep" aria-hidden="true"></i>')}</p>`
    + "</div></div>"
    + spectrumHtml(k)
    + `<div class="ob-readouts">${readoutsHtml(summary, state)}</div>`
    + "</div>"
    + '<div class="ob-hero-right">'
    + constellationHtml(summary, state)
    + `<div class="ob-models-head"><h3>模型星等</h3><span>尾长 = 用量 · 轨底 = 缓存命中${filtered ? " · 再点一次取消筛选" : " · 点击按 Agent 筛选"}</span></div>`
    + `<div class="ob-comets">${comets}</div>${restHtml}`
    + "</div>"
    + "</div>"
    + "</div>";
}
