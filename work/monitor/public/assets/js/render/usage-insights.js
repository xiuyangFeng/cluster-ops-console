// Cost attribution uses range-scoped calls. Lifetime session rows stay unchanged.
// 少写字、多用图：三项读数各带一条分段迷你柱；三个维度用占比条代替百分比文字，细节放进悬停说明。
import { escapeHtml } from "../store.js";
import { AGENT_LABELS, formatUsd, monthDay, shortTokens } from "./usage-model.js";

const pct = (ratio) => `${(ratio * 100).toFixed(1)}%`;
const hit = (rate) => rate === null || rate === undefined ? "—" : pct(rate);
const bucketTokens = (b) => Object.keys(AGENT_LABELS).reduce((sum, a) => sum + (Number(b?.[a]) || 0), 0);
const bucketHit = (b) => b.input > 0 ? b.cacheRead / b.input : null;
const barWidth = (ratio) => `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(1)}%`;

// 迷你柱：value(b) 为 null 的档画虚线空格（没有成功调用 ≠ 0）；进行中的末档半透明。
export function sparkHtml(buckets, { label, value, format, max }) {
  if (!buckets?.length) return "";
  const values = buckets.map(value);
  const top = max ?? Math.max(0, ...values.filter((v) => v !== null));
  const bars = buckets.map((b, i) => {
    const v = values[i];
    const h = v === null || top <= 0 ? 0 : Math.max(v > 0 ? 4 : 0, (v / top) * 100);
    return `<span class="us-spark-slot${v === null ? " is-empty" : ""}${b.partial ? " is-partial" : ""}" title="${escapeHtml(b.label)}：${v === null ? "—" : format(v)}${b.partial ? " · 进行中" : ""}"><i style="height:${h.toFixed(1)}%"></i></span>`;
  }).join("");
  return `<div class="us-spark" role="img" aria-label="${escapeHtml(label)}，${escapeHtml(buckets[0].label)} 至 ${escapeHtml(buckets.at(-1).label)}，明细见分段表">${bars}</div><div class="us-spark-axis"><span>${escapeHtml(buckets[0].label)}</span><span>${escapeHtml(buckets.at(-1).label)}</span></div>`;
}

// 涨跌徽标：worse 表示这个方向对花费不利（花费 / Token 上涨、命中下降），加 is-worse 着色，箭头本身表明方向。
function deltaChip(text, sign, worse, title) {
  if (text === null) return `<span class="us-delta-chip is-na" title="${escapeHtml(title)}">—</span>`;
  const arrow = sign > 0 ? "▲" : sign < 0 ? "▼" : "";
  return `<span class="us-delta-chip${worse ? " is-worse" : ""}" title="${escapeHtml(title)}">${arrow}${arrow ? " " : ""}${text}</span>`;
}

function ratioChip(ratio, prev, cur, note) {
  if (ratio === null) return deltaChip(null, 0, false, note);
  const change = (ratio - 1) * 100;
  const text = `${Math.abs(change) >= 1000 ? Math.round(Math.abs(change)) : Math.abs(change).toFixed(1)}%`;
  return deltaChip(text, Math.sign(Math.round(change * 10)), change > 0.05, `${prev} → ${cur}`);
}

function kpi(label, value, chip, spark) {
  return `<div class="us-kpi"><div class="us-kpi-head"><span class="us-kpi-label">${label}</span>${chip}</div><div class="us-kpi-value">${value}</div>${spark}</div>`;
}

function barRow(r, total) {
  const share = total > 0 ? r.costUsd / total : 0;
  return `<span class="us-cost-name">${escapeHtml(r.label)}</span><span class="us-cost-bar" aria-hidden="true"><i style="width:${barWidth(share)}"></i></span><b>${formatUsd(r.costUsd)}</b>`;
}

function dimension(title, rows, total, kind, selected, opened, toneOf) {
  const sorted = rows.filter(r => r.costUsd > 0 || r.total > 0).sort((a, b) => b.costUsd - a.costUsd || b.total - a.total);
  const rowHtml = (r) => {
    const tone = toneOf?.(r);
    const share = total > 0 ? ` · ${pct(r.costUsd / total)}` : "";
    return `<li><button type="button" class="us-cost-pick"${tone ? ` data-tone="${escapeHtml(tone)}"` : ""} data-cost-kind="${kind}" data-cost-key="${escapeHtml(r.key)}" aria-pressed="${selected === r.key}" title="${escapeHtml(r.label)} · ${formatUsd(r.costUsd)}${share} · ${shortTokens(r.total || 0)} Token · 点击${selected === r.key ? "取消筛选" : "筛选"}">${barRow(r, total)}</button></li>`;
  };
  return `<section class="us-cost-dim"><h3>${title}</h3><ol class="us-cost-list">${sorted.slice(0, 4).map(rowHtml).join("") || '<li class="us-muted">暂无用量</li>'}</ol>${sorted.length > 4 ? `<details data-cost-details="${kind}"${opened.has(kind) ? " open" : ""}><summary>+${sorted.length - 4}</summary><ol class="us-cost-list">${sorted.slice(4).map(rowHtml).join("")}</ol></details>` : ""}</section>`;
}

// 分段明细：迷你柱的表格视图（读屏 / 精确数值），默认收起，展开状态随刷新保留。
export function bucketTableHtml(trend, opened = new Set()) {
  const buckets = trend?.buckets || [];
  if (!buckets.length) return "";
  return `<details class="us-cache-data" data-cost-details="cache"${opened.has("cache") ? " open" : ""}><summary>分段明细</summary><div class="us-cost-scroll"><table class="us-data"><thead><tr><th>时间段</th><th class="us-num">等效花费</th><th class="us-num">Token</th><th class="us-num">缓存命中</th></tr></thead><tbody>${buckets.map(b => `<tr><td>${escapeHtml(b.label)}${b.partial ? "（进行中）" : ""}</td><td class="us-num">${formatUsd(b.costUsd || 0)}</td><td class="us-num">${shortTokens(bucketTokens(b))}</td><td class="us-num">${hit(bucketHit(b))}</td></tr>`).join("")}</tbody></table></div></details>`;
}

export function usageInsightsHtml(summary, state = {}, opened = new Set()) {
  const insights = summary?.insights;
  if (!insights) return "";
  const c = insights.comparison;
  const k = summary.kpis;
  const total = k.costUsd;
  const buckets = summary.trend?.buckets || [];
  const period = summary.scope.days === 1 ? summary.scope.start === summary.today ? "今日" : monthDay(summary.scope.start) : `近 ${summary.scope.days} 天`;
  const prevRange = c.previousScope.start === c.previousScope.end ? monthDay(c.previousScope.start) : `${monthDay(c.previousScope.start)}–${monthDay(c.previousScope.end)}`;
  const versus = summary.scope.days === 7 ? `周环比 ${prevRange}` : `对比 ${prevRange}${c.sameTime ? " 同时段" : ""}`;
  const note = !c.covered ? "前期覆盖不足，暂不计算涨跌" : c.scanIncomplete ? "存在扫描失败或回填未完成，暂不计算涨跌" : c.previous.costUsd === 0 ? "前期花费为零，无涨跌百分比" : "";
  const projects = (summary.projects || []).filter(p => !state.project || state.project === "all" || p.key === state.project).map(p => ({ key:p.key, label:p.label, ...p.stats }));
  const agents = (summary.byAgent || []).filter(a => !state.agent || state.agent === "all" || a.agent === state.agent).map(a => ({ ...a, key:a.agent, label:AGENT_LABELS[a.agent] || a.agent }));
  const models = (summary.models || []).map(m => ({ ...m, key:m.model, label:m.model }));
  const hitDelta = c.hitRateDelta;
  const hitChip = hitDelta === null
    ? deltaChip(null, 0, false, note || "缺少可比数据")
    : deltaChip(`${Math.abs(hitDelta * 100).toFixed(1)} pp`, Math.sign(Math.round(hitDelta * 1000)), hitDelta < -0.0005, `${hit(c.previous.hitRate)} → ${hit(c.current.hitRate)}`);
  const kpis = [
    kpi("等效花费", formatUsd(total), ratioChip(c.costRatio, formatUsd(c.previous.costUsd), formatUsd(c.current.costUsd), note), sparkHtml(buckets, { label: "等效花费分段", value: (b) => b.costUsd || 0, format: formatUsd })),
    kpi("Token", shortTokens(k.total), ratioChip(c.tokenRatio, shortTokens(c.previous.total), shortTokens(c.current.total), note), sparkHtml(buckets, { label: "Token 分段", value: bucketTokens, format: shortTokens })),
    kpi("缓存命中", hit(k.hitRate), hitChip, sparkHtml(buckets, { label: "缓存命中率分段，0 到 100%", value: bucketHit, format: hit, max: 1 })),
  ].join("");
  const hint = `${period} · ${versus}`;
  return `<div class="panel-header flex-header"><h2>钱花在哪</h2><span class="panel-hint" title="等效 API 花费按内置模型族参考价估算，非账单金额；占比按等效 USD；仅比较已采集日志，没有调用不等于没有消费。北京时间。">${escapeHtml(hint)}${note ? ` · <span class="us-insights-note">${escapeHtml(note)}</span>` : ""} · 估算</span></div>`
    + `<div class="us-insights-body"><div class="us-kpis">${kpis}</div>`
    + `<div class="us-cost-grid">${dimension("项目", projects, total, "project", state.project, opened)}${dimension("模型", models, total, "model", state.model, opened, (r) => AGENT_LABELS[r.agent] ? r.agent : "custom")}${dimension("Agent", agents, total, "agent", state.agent, opened, (r) => r.key)}`
    + "</div>"
    + `${bucketTableHtml(summary.trend, opened)}</div>`;
}
