// render/usage-observatory.js —— 用量页星空版 / 纸面版的「星图总览」（#usageGalaxyStage；简洁版隐藏，仍用 .us-metrics 四卡）。
//
// 左边：范围标题 + Token 总量大字 + 四项读数（未命中输入 / 缓存命中 / 模型调用 / 会话）；
// 右边：「模型星等」——每个模型一条彗星：彗头是星，尾巴长度 = 该模型的 Token 用量（相对用量最多的那个），
// 后面直接写数（用量、占比、缓存命中、等效花费），点一条按它的 Agent 筛选，再点取消。
// 数据只用 /api/usage/summary 的 kpis 与 models（后端按每次调用精确聚合，已带 Agent / 项目筛选），
// 不补位、不造数：没有调用的范围就写「这个范围没有模型调用」。纯函数，Node 下可直接测。
import { escapeHtml } from "../store.js";
import {
  AGENT_LABELS, causesText, clockOf, dateLabel, failureDetailText, formatDuration, formatUsd, integer, ratioText, shortTokens, splitTokens,
} from "./usage-model.js";

export const OBSERVATORY_MODEL_LIMIT = 5;

// 缓存命中率：缓存读取 / (缓存读取 + 未命中输入)。两者都没有返回 null。
export function hitRateOf(cacheRead, fresh) {
  const read = Number(cacheRead) || 0;
  const miss = Number(fresh) || 0;
  return read + miss > 0 ? read / (read + miss) : null;
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

function readout(label, value, unit, sub, extraClass = "") {
  return `<div class="ob-readout${extraClass}"><span class="ob-readout-label">${label}</span><span class="ob-readout-value">${value}${unit ? `<small>${unit}</small>` : ""}</span><span class="ob-readout-sub">${sub || "&nbsp;"}</span></div>`;
}

function readoutsHtml(summary, state) {
  const k = summary.kpis;
  const [freshNum, freshUnit] = splitTokens(k.fresh);
  const ratio = ratioText(k.freshVsAvg);
  const freshSub = ratio ? `<b>${escapeHtml(ratio)}</b> 较近 ${k.freshVsAvg.days} 日${k.freshVsAvg.sameTime ? "同时段" : ""}均值` : `普通 ${shortTokens(k.inFresh)} · 缓存写入 ${shortTokens(k.cacheWrite)}`;
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
  const single = summary.scope.days === 1;
  const historical = state?.date && state.date !== summary.today;
  const sessionsSub = single
    ? `${!historical && k.recentSessions ? `${k.recentSessions} 个活跃 · ` : ""}${k.turnCount} 轮${k.avgTurnSec == null ? "" : ` · 每轮 ${formatDuration(k.avgTurnSec)}`}`
    : `日均 ${(k.sessions / summary.scope.days).toFixed(1)} 个 · ${k.turnCount} 轮`;
  return [
    readout("未命中输入", escapeHtml(freshNum), freshUnit || "Token", freshSub),
    readout("缓存命中", hit === null ? "—" : (hit * 100).toFixed(1), hit === null ? "" : "%", hitSub),
    readout("模型调用", integer(k.calls), "次", callsSub, k.errors ? " has-errors" : ""),
    readout("会话", integer(k.sessions), "个", sessionsSub),
  ].join("");
}

function cometHtml(row, state) {
  const label = AGENT_LABELS[row.agent] || row.agent;
  const selected = state?.agent && state.agent !== "all" && state.agent === row.agent;
  const pct = row.share >= 0.995 ? "100%" : row.share >= 0.01 ? `${Math.round(row.share * 100)}%` : "<1%";
  const hit = row.hitRate === null ? "—" : `${Math.round(row.hitRate * 100)}%`;
  const title = `${row.model} · ${label}：${integer(row.total)} Token，${integer(row.calls)} 次调用${row.errors ? `（失败 ${row.errors}）` : ""}。点击${selected ? "取消筛选" : `只看 ${label}`}`;
  return `<button type="button" class="ob-comet${row.live ? " is-live" : ""}${selected ? " is-selected" : ""}" data-agent="${escapeHtml(row.agent)}" data-usage-pick-agent="${escapeHtml(row.agent)}" aria-pressed="${Boolean(selected)}" title="${escapeHtml(title)}">`
    + `<span class="ob-comet-name"><span class="ob-comet-model">${escapeHtml(row.model)}</span><span class="ob-comet-agent">${escapeHtml(label)}</span>${row.live ? '<span class="ob-comet-live">活跃</span>' : ""}</span>`
    + `<span class="ob-comet-track" aria-hidden="true"><span class="ob-comet-tail" style="width:${(Math.max(0.012, row.reach) * 100).toFixed(2)}%"></span></span>`
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
  const subParts = [
    k.costUsd > 0 ? `等效 <b>${formatUsd(k.costUsd)}</b>` : "",
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
    + `<div class="ob-heading"><h2 class="ob-title">${escapeHtml(title)}</h2><span class="ob-eyebrow">${escapeHtml(caption)}</span></div>`
    + `<div class="ob-total" aria-label="Token 总量 ${escapeHtml(num + unit)}"><span class="ob-total-num">${escapeHtml(num)}</span><span class="ob-total-unit">${escapeHtml(unit)}</span><span class="ob-total-label">Token 总量</span></div>`
    + `<p class="ob-total-sub">${subParts.join('<i class="ob-sep" aria-hidden="true"></i>')}</p>`
    + `<div class="ob-readouts">${readoutsHtml(summary, state)}</div>`
    + "</div>"
    + '<div class="ob-hero-right">'
    + `<div class="ob-models-head"><h3>模型星等</h3><span>按 Token 用量 · 尾长即用量${filtered ? " · 再点一次取消筛选" : " · 点击按 Agent 筛选"}</span></div>`
    + `<div class="ob-comets">${comets}</div>${restHtml}`
    + "</div>"
    + "</div>"
    + "</div>";
}
