// render/usage-view.js —— 用量视图的 DOM 渲染（只读 state 与 /api/usage/* 的数据，不发请求）。
// 远端来的字符串（项目路径、会话 ID、模型名）一律 escapeHtml；表格与列表用 morphInnerHtml
// 增量更新，刷新时不丢滚动位置与焦点。
import { createElementLookup, morphInnerHtml, setAttr, setText } from "../dom-utils.js";
import { emptyStateHtml } from "../empty-state.js";
import { createLineChart, niceCeil } from "../line-chart.js";
import { escapeHtml } from "../store.js";
import { observatoryHtml } from "./usage-observatory.js";
import { usageInsightsHtml } from "./usage-insights.js";
import {
  AGENT_IDS, AGENT_LABELS, calendarGrid, calendarMonths, causesText, clockOf, codesText, compactDate, errorKindLabel, errorTextNote, contextTone, dateLabel, dayKeyOf, failureDetailText, filterSessions,
  axisLabel, formatDuration, formatUsd, heatLevel, integer, monotoneSegments, monthDay, niceScale, ratioText, shortTokens, splitTokens, STATUS_LABELS, tokenAxisFormatter, TZ_LABEL,
} from "./usage-model.js";

const AGENTS = AGENT_IDS;
// 「分开」时小图从上到下的顺序，提示框里也按这个顺序列
const SPLIT_ORDER = ["claude", "codex", "antigravity", "gemini", "zcode", "opencode", "cursor", "custom"];
const SPLIT_HEAD = 20; // 每张小图标题行占的高度（含与图的间距）
const SPLIT_AXIS = 18; // 最下面那张多留给横轴标签的高度
const SPLIT_GAP = 4;
const TREND_LEFT = 44; // 纵轴刻度留白；合并图与小图一致，换模式时图不左右跳
const TREND_RIGHT = 18;

function detectedAgentsOf(summary, state) {
  const set = new Set(["codex", "claude"]);
  for (const a of summary?.detectedAgents || []) if (AGENT_LABELS[a]) set.add(a);
  for (const b of summary?.trend?.buckets || []) {
    for (const a of AGENTS) if ((b?.[a] || 0) > 0) set.add(a);
  }
  if (state?.agent && state.agent !== "all" && AGENT_LABELS[state.agent]) set.add(state.agent);
  return AGENTS.filter((a) => set.has(a));
}

function trendAgentsOf(list, summary, state) {
  if (state?.agent && state.agent !== "all") return [state.agent];
  const detected = detectedAgentsOf(summary, state);
  if (detected.length <= 4) return detected;
  const totals = new Map();
  const buckets = list?.length ? list : summary?.trend?.buckets || [];
  for (const a of detected) totals.set(a, 0);
  for (const b of buckets) {
    for (const a of detected) {
      const val = Number(b?.[a]) || 0;
      if (val > 0) totals.set(a, (totals.get(a) || 0) + val);
    }
  }
  const withData = detected.filter((a) => (totals.get(a) || 0) > 0 || a === "codex" || a === "claude");
  if (withData.length <= 4) return withData;
  // 最多展示用量最多的 4 个 AI，避免过多 AI 出行导致页面过长
  return [...withData]
    .sort((a, b) => (totals.get(b) || 0) - (totals.get(a) || 0))
    .slice(0, 4);
}

// ---- 空状态（纯函数，返回 empty-state.js 的 spec；动作由 app/usage-controller.js 委托处理） ----

// 页面级说明（顶部 #usageEmptyState）：没有可统计的团队服务器 / 从没扫到过数据（首次扫描中，或一直失败）。
// 扫描节奏见 lib/usage/service.mjs：每台团队服务器每 60 秒一轮，回填未完成时 5 秒后接着扫。
export function usagePageEmptyState(summary) {
  const sources = summary?.sources || [];
  if (!sources.length) {
    return { tone: "neutral", icon: "server", title: "没有可统计用量的团队服务器", body: "用量只统计团队服务器上 Agent 写的会话日志，个人服务器不统计。" };
  }
  if (summary.coverageStart) return null;
  const failing = sources.find((s) => s.lastError);
  if (failing) {
    return {
      tone: "error", icon: "cloudOff", title: "暂时取不到用量数据",
      body: `${failing.name ? `${failing.name}：` : ""}${failing.lastError}。会话日志每分钟同步一次，下一轮会再试。`,
      actions: [{ label: "重试", kind: "secondary", attrs: { "data-usage-sync": "" } }],
    };
  }
  return { tone: "wait", icon: "chart", title: "正在首次扫描会话日志", body: "通常一分钟内完成。扫描是只读的，按文件偏移增量读取，服务器上不落任何文件。" };
}

// 会话表为空（#usageSessionEmpty）。matched = 本地筛选（全部 / 近期活跃 / 有失败 + 搜索）后剩下的行数。
//   有会话但本地筛选没命中 → 搜索图标 +「清除会话筛选」；Agent / 项目筛选没命中 → 「清除筛选」（保留日期）；
//   顶部已有页面级说明 → 只留一句标题，不重复；否则说明节奏并给「立即同步」与换一个更长的范围。
export function usageSessionEmptyState(summary, state, matched = 0) {
  if (matched > 0) return null;
  const title = "这个时间段没有 Agent 会话";
  if ((summary?.sessions || []).length) {
    return {
      tone: "neutral", icon: "search", title: "没有匹配的会话", body: "当前的搜索或会话筛选在这个时间段里没有命中。",
      actions: [{ label: "清除会话筛选", kind: "text", attrs: { id: "usageResetSessions" } }],
    };
  }
  const filters = [state?.agent && state.agent !== "all" ? AGENT_LABELS[state.agent] || state.agent : "", state?.project && state.project !== "all" ? `项目 ${state.projectLabel || state.project}` : "", state?.model && state.model !== "all" ? `模型 ${state.model}` : ""].filter(Boolean);
  if (filters.length) {
    return {
      tone: "neutral", icon: "search", title: "没有符合筛选的会话", body: `当前筛选：${filters.join(" · ")}。`,
      actions: [{ label: "清除筛选", kind: "text", attrs: { "data-usage-clear-filter": "" } }],
    };
  }
  if (usagePageEmptyState(summary)) return { tone: "neutral", icon: "calendar", title };
  const range = state?.date || (state?.range ?? 1) < 7 ? 7 : (state?.range ?? 1) < 30 ? 30 : null;
  return {
    tone: "neutral", icon: "calendar", title,
    body: "会话日志每分钟从团队服务器同步一次（个人服务器不统计）。换个日期范围，或者现在同步一次。",
    actions: [
      { label: "立即同步", kind: "secondary", attrs: { "data-usage-sync": "" } },
      ...(range ? [{ label: `看近 ${range} 天`, kind: "text", attrs: { "data-usage-jump-range": String(range) } }] : []),
    ],
  };
}

// 用量模块关闭（后端回 { disabled: true }）时顶部的说明。
export const USAGE_DISABLED_STATE = Object.freeze({ tone: "neutral", icon: "chart", title: "用量模块已关闭", body: "可在「配置 → 监控模块」中重新开启。" });

// onPickBucket(index)：「分开」模式下点了某一档（合并图的点击由控制器直接接在图上）。
export function createUsageView({ doc, onPickBucket }) {
  const $ = createElementLookup(doc);
  let trendBuckets = [];
  let currentTrendAgents = ["codex", "claude"];

  function setFigure(id, value) {
    const [number, unit] = splitTokens(value);
    setText($(id), number);
    setText($(`${id}Unit`), unit || "Token");
  }

  function renderSource(summary, state) {
    const items = (summary?.sources || []).map((s) => {
      const failing = Boolean(s.lastError) && (!s.lastOkAt || s.lastScanAt > s.lastOkAt);
      const when = s.lastOkAt ? clockOf(s.lastOkAt / 1000, { seconds: true }) : null;
      const status = failing ? `同步失败：${escapeHtml(s.lastError)}` : s.complete === false ? `${when ?? ""} 回填中…` : when ? `${when} 已同步` : "等待首次同步";
      const detected = AGENTS.filter((a) => s.installed?.includes(a) || s.roots?.[a]);
      const tools = detected.length ? `<span class="us-source-tools" title="该服务器自动检测到的 AI 工具">· ${detected.map((a) => escapeHtml(AGENT_LABELS[a] || a)).join(" / ")}</span>` : "";
      return `<span class="us-source-item${failing ? " is-error" : ""}"><i class="us-dot ${failing ? "error" : s.complete === false || !when ? "warn" : "ok"}"></i><b>${escapeHtml(s.name)}</b><span>${status}</span>${tools}</span>`;
    }).join("");
    const coverage = summary?.coverageStart ? `<span class="us-source-item"><span>最早数据 ${compactDate(summary.coverageStart)}</span></span>` : "";
    morphInnerHtml($("usageSource"), `<span class="us-source-label">数据源 · 会话日志</span>${items || '<span class="us-source-item"><span>没有可统计的团队服务器</span></span>'}${coverage}`);
    // 平时不占一行：只在有服务器同步失败时露出来，正常的同步时刻放进「立即同步」的悬停提示
    const bar = $("usageSourceBar");
    const failing = (summary?.sources || []).some((s) => Boolean(s.lastError) && (!s.lastOkAt || s.lastScanAt > s.lastOkAt));
    if (bar && bar.hidden === failing) bar.hidden = !failing;
    const syncBtn = $("usageSyncBtn");
    const syncDisabled = Boolean(state.syncing || !summary?.sources?.length);
    if (syncBtn.disabled !== syncDisabled) syncBtn.disabled = syncDisabled;
    setText(syncBtn, state.syncing ? "同步中…" : "立即同步");
    const tip = (summary?.sources || []).map((s) => `${s.name}：${s.lastOkAt ? `${clockOf(s.lastOkAt / 1000, { seconds: true })} 已同步` : "等待首次同步"}`);
    if (summary?.coverageStart) tip.push(`最早数据 ${compactDate(summary.coverageStart)}`);
    const title = tip.join("\n");
    if (syncBtn.title !== title) syncBtn.title = title;
  }

  function renderScope(summary, state) {
    const scope = summary?.scope;
    let caption = "—";
    if (scope) {
      if (state.date) caption = `${compactDate(state.date)}${state.date === summary.today ? " · 今天" : ""}`;
      else if (scope.days === 1) caption = `${compactDate(summary.today)} · 今天，截至 ${clockOf(summary.now)}（${TZ_LABEL}）`;
      else caption = `${compactDate(scope.start)} — ${scope.end.slice(5).replace("-", ".")}`;
    }
    setText($("usageRangeCaption"), caption);
    for (const btn of doc.querySelectorAll("[data-usage-range]")) setAttr(btn, "aria-pressed", String(!state.date && Number(btn.dataset.usageRange) === state.range));
    const parts = [];
    if (state.date) parts.push(`日期 ${monthDay(state.date)}`);
    if (state.agent !== "all") parts.push(AGENT_LABELS[state.agent] || state.agent);
    if (state.project !== "all") parts.push(`项目 ${state.projectLabel || state.project}`);
    if (state.model && state.model !== "all") parts.push(`模型 ${state.model}`);
    const filterBar = $("usageFilterBar");
    const filterHidden = parts.length === 0;
    if (filterBar.hidden !== filterHidden) filterBar.hidden = filterHidden;
    setText($("usageFilterText"), parts.length ? `正在看：${parts.join(" · ")}` : "");
    const agentSelect = $("usageAgentFilter");
    if (agentSelect) {
      const detected = detectedAgentsOf(summary, state);
      const agentHtml = `<option value="all">全部 Agent</option>${detected.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(AGENT_LABELS[a] || a)}</option>`).join("")}`;
      if (agentSelect.dataset.html !== agentHtml) {
        agentSelect.innerHTML = agentHtml;
        agentSelect.dataset.html = agentHtml;
      }
      if (agentSelect.value !== state.agent) agentSelect.value = state.agent;
    }
    const select = $("usageProjectFilter");
    const options = (summary?.projects || []).map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join("");
    const known = (summary?.projects || []).some((p) => p.key === state.project);
    const extra = state.project !== "all" && !known ? `<option value="${escapeHtml(state.project)}">${escapeHtml(state.projectLabel || state.project)}</option>` : "";
    const html = `<option value="all">全部项目</option>${options}${extra}`;
    if (select.dataset.html !== html) {
      select.innerHTML = html;
      select.dataset.html = html;
    }
    if (select.value !== state.project) select.value = state.project;
  }

  function renderMetrics(summary, state) {
    const k = summary?.kpis;
    if (!k) return;
    setFigure("usageTotal", k.total);
    const costTag = k.costUsd > 0 ? `<span title="按内置模型族参考价估算，非账单金额">等效 <strong>${formatUsd(k.costUsd)}</strong></span>` : "";
    morphInnerHtml($("usageTotalDesc"), `<span>缓存读取 <strong>${shortTokens(k.cacheRead)}</strong></span><span>输出 <strong>${shortTokens(k.output)}</strong></span>${costTag}`);
    setFigure("usageFresh", k.fresh);
    const savedTag = k.savedUsd > 0 ? `<span title="命中缓存相比全部按普通输入计费净节省的等效花费">净省 <strong>${formatUsd(k.savedUsd)}</strong></span>` : "";
    morphInnerHtml($("usageFreshDesc"), `<span>普通 <strong>${shortTokens(k.inFresh)}</strong></span><span>缓存写入 <strong>${shortTokens(k.cacheWrite)}</strong></span><span>命中 <strong>${k.hitRate === null ? "—" : `${(k.hitRate * 100).toFixed(1)}%`}</strong></span>${savedTag}`);
    const ratio = ratioText(k.freshVsAvg);
    morphInnerHtml($("usageFreshDelta"), ratio ? `<b>${ratio}</b> 较近 ${k.freshVsAvg.days} 日${k.freshVsAvg.sameTime ? "同时段" : ""}均值` : "");
    setText($("usageCalls"), integer(k.calls));
    setText($("usageCallsRate"), k.calls ? `${((1 - k.errors / k.calls) * 100).toFixed(1)}% 成功` : "");
    const failureDetail = failureDetailText(k.codes, " · ", { limit: 3 });
    // 无状态码的失败按错误原文归类补一行（v2.51 起采集原文；之前的记录计入「v2.51 前未存原文」）
    const causes = causesText(k.causes);
    morphInnerHtml($("usageCallsDesc"), k.errors
      ? `<button type="button" class="text-btn us-metric-link" data-usage-jump="errors"><i class="us-dot error"></i><span class="us-nowrap">失败 <strong>${k.errors}</strong></span>${failureDetail ? `<span>${escapeHtml(failureDetail)}</span>` : ""}</button>${causes ? `<span class="us-cause-line" title="按失败调用的错误原文归类；类别只取实际见过的文案，认不出的记为其他">${escapeHtml(causes)}</span>` : ""}`
      : '<span><i class="us-dot ok"></i>无失败</span>');
    setText($("usageSessions"), String(k.sessions));
    const single = summary.scope.days === 1;
    const historical = state.date && state.date !== summary.today;
    setText($("usageSessionsUnit"), single ? (historical ? "个" : `个 · ${k.recentSessions} 个近期活跃`) : `个 · 日均 ${(k.sessions / summary.scope.days).toFixed(1)}`);
    morphInnerHtml($("usageSessionsDesc"), `<span>平均每轮 <strong>${k.avgTurnSec === null ? "—" : formatDuration(k.avgTurnSec)}</strong></span><span>${k.turnCount} 轮</span>`);
  }

  // 趋势：平滑曲线 + 渐变面积 + 外发光（同一路径叠一层宽描边，不用模糊滤镜，重绘便宜）。
  // 今天只画到当前时刻、横向铺满；最后一档还没过完画成虚线，最新点放一个 CSS 呼吸波纹
  // （只动 transform / opacity；视图隐藏时不运行，「减少动态效果」时关闭）。
  const GRANULARITY_LABEL = { quarter: "按 15 分钟", hour: "按小时", day: "按天 · 点击某天查看" };
  let trendGeometry = null; // 悬停参考线用：{ xs, ys: { agent: [] }, top, bottom }
  let lastMergedTrendHtml = "";
  // 合并 / 分开：两个系列量级差得远时（一个上亿、一个几百万）合并图里小的那条贴着基线，
  // 分开后每个 Agent 一张小图、各用各的刻度（不用双纵轴）。只筛了一个 Agent 时没有可分的。
  function renderTrend(summary, state) {
    const trend = summary?.trend;
    if (!trend) return;
    const list = trend.buckets;
    trendBuckets = list;
    const agents = trendAgentsOf(list, summary, state);
    currentTrendAgents = agents;
    const partial = Boolean(list.at(-1)?.partial) && list.length > 1;
    const split = state.trendMode === "split" && agents.length > 1;
    const scope = [GRANULARITY_LABEL[trend.granularity] || "", split ? "各自刻度" : partial && trend.granularity !== "day" ? "截至当前" : "", TZ_LABEL];
    setText($("usageTrendScope"), scope.filter(Boolean).join(" · "));
    // 分开时每张小图有自己的标题，页头不再重复系列图例，只留「进行中」
    const series = split ? "" : agents.map((a) => `<span><i class="us-line-key" data-agent="${a}"></i>${AGENT_LABELS[a] || a}</span>`).join("");
    morphInnerHtml($("usageTrendLegend"), `${series}${partial ? '<span><i class="us-line-key is-dashed"></i>进行中</span>' : ""}`);
    const modeEl = $("usageTrendMode");
    const modeHidden = agents.length < 2;
    if (modeEl.hidden !== modeHidden) modeEl.hidden = modeHidden;
    for (const btn of doc.querySelectorAll("[data-usage-trend]")) setAttr(btn, "aria-pressed", String(btn.dataset.usageTrend === (split ? "split" : "merged")));
    const mergedEl = $("usageTrendChart");
    const splitEl = $("usageTrendSplit");
    if (mergedEl.hidden !== split) {
      // 换模式：收起合并图的提示框与参考线，免得留在原地
      $("usageTooltip").hidden = true;
      moveCrosshair(null);
      mergedEl.hidden = split;
    }
    if (splitEl.hidden !== !split) splitEl.hidden = !split;
    if (split) renderSplitTrend(trend, agents, partial, !state.date && state.range !== 1);
    else renderMergedTrend(trend, agents, partial);
    const sums = list.map((b) => agents.reduce((v, a) => v + (b[a] || 0), 0));
    const peak = sums.indexOf(Math.max(...sums));
    morphInnerHtml($("usagePeak"), sums[peak] > 0 ? `用量峰值 <strong>${list[peak].label}</strong> · <strong>${shortTokens(sums[peak])}</strong> Token` : "当前范围暂无用量");
  }

  // ---- 分开：每个 Agent 一张小图（通用折线图模块），共用时间轴，十字线同步 ----
  const splitCharts = new Map(); // agent → { chart, head }
  let splitKey = "";

  function ensureSplitRows(order) {
    const key = order.join(",");
    if (key === splitKey) return;
    const stage = $("usageTrendSplitRows");
    for (const { chart } of splitCharts.values()) chart.destroy();
    splitCharts.clear();
    stage.textContent = "";
    for (const agent of order) {
      const row = doc.createElement("section");
      row.className = "us-split-row";
      row.dataset.agent = agent;
      const head = doc.createElement("div");
      head.className = "us-split-head";
      const host = doc.createElement("div");
      host.className = "us-split-chart";
      row.append(head, host);
      stage.append(row);
      splitCharts.set(agent, { chart: createLineChart(host), head });
    }
    splitKey = key;
  }

  function syncSplitCrosshair(source, index) {
    for (const [agent, { chart }] of splitCharts) {
      if (agent === source) continue;
      if (index == null) chart.clear();
      else chart.mark(index);
    }
  }

  function renderSplitTrend(trend, agents, partial, pickable) {
    const list = trend.buckets;
    const order = SPLIT_ORDER.filter((a) => agents.includes(a));
    ensureSplitRows(order);
    const stage = $("usageTrendSplitRows");
    const count = order.length;
    // 小图高度按容器可用高度均分（容器靠 flex 撑满面板，内容绝对定位不反过来撑高它）。
    // 视图还没显示出来时量不到高度：这一轮不画，变可见后控制器的 ResizeObserver 会再调一次。
    const available = stage.clientHeight;
    if (!available) return;
    const each = Math.max(54, Math.floor((available - count * SPLIT_HEAD - SPLIT_AXIS - (count - 1) * SPLIT_GAP) / count));
    const plotWidth = Math.max(120, (stage.clientWidth || 700) - TREND_LEFT - TREND_RIGHT);
    // 横轴标签约每 70px 一个；最后一个总是显示，离前一个太近时让位（与合并图同一规则）
    const stride = Math.max(1, Math.ceil(list.length / Math.max(2, Math.floor(plotWidth / 70))));
    const lastIndex = list.length - 1;
    const ticks = list
      .map((b, i) => ({ t: i, label: b.label, anchor: lastIndex > 0 && i === lastIndex ? "end" : lastIndex > 0 && i === 0 ? "start" : "middle" }))
      .filter((_, i) => i === lastIndex || (i % stride === 0 && lastIndex - i >= stride));
    const xs = list.map((_, i) => i);
    const tipFor = (i) => {
      const bucket = list[i];
      if (!bucket) return null;
      const rows = order.map((a) => ({ swatch: a, label: AGENT_LABELS[a] || a, value: shortTokens(bucket[a] || 0) }));
      if (bucket.calls) rows.push({ tone: "total", label: "调用", value: `${integer(bucket.calls)} 次${bucket.errors ? ` · 失败 ${bucket.errors}` : ""}` });
      return { title: `${bucket.label}${bucket.partial ? " · 进行中" : ""}`, rows };
    };
    order.forEach((agent, index) => {
      const bottomChart = index === count - 1;
      const { chart, head } = splitCharts.get(agent);
      const values = list.map((b) => b[agent] || 0);
      const total = values.reduce((sum, v) => sum + v, 0);
      const peak = values.indexOf(Math.max(...values));
      morphInnerHtml(head, `<i class="us-line-key" data-agent="${agent}"></i><b>${AGENT_LABELS[agent] || agent}</b><span>${total > 0 ? `合计 ${shortTokens(total)} · 峰值 ${escapeHtml(list[peak].label)} ${shortTokens(values[peak])}` : "当前范围暂无用量"}</span>`);
      const yMax = niceCeil(Math.max(2, ...values));
      chart.update({
        label: `${AGENT_LABELS[agent] || agent} ${GRANULARITY_LABEL[trend.granularity] || ""} Token 用量`,
        height: each + (bottomChart ? SPLIT_AXIS : 0),
        pad: { l: TREND_LEFT, r: TREND_RIGHT, t: 6, b: bottomChart ? SPLIT_AXIS + 6 : 6 },
        x: [0, Math.max(0, lastIndex)],
        yMax,
        yTicks: [0, yMax / 2, yMax],
        yFormat: tokenAxisFormatter(yMax),
        xTicks: bottomChart ? ticks : [],
        series: [{ tone: agent, points: values.map((v, i) => [i, v]), smooth: true, dashFrom: partial ? lastIndex - 1 : null }],
        hover: {
          xs,
          dots: (i) => [{ tone: agent, v: values[i] }],
          tip: tipFor,
          onIndex: (i) => syncSplitCrosshair(agent, i),
          onPick: pickable ? (i) => onPickBucket?.(i) : undefined,
        },
      });
    });
  }

  function renderMergedTrend(trend, agents, partial) {
    const list = trend.buckets;
    const wrap = $("usageTrendChart");
    const width = Math.max(280, wrap.clientWidth || 700);
    const height = Math.max(150, wrap.clientHeight || 190);
    const left = TREND_LEFT, right = TREND_RIGHT, bottom = 26, top = 20;
    const plotBottom = height - bottom;
    const plotHeight = plotBottom - top;
    const max = Math.max(1, ...list.flatMap((b) => agents.map((a) => b[a] || 0)));
    const { step, ceiling, segments, unit, divisor } = niceScale(max);
    const x = (i) => (list.length === 1 ? (left + width - right) / 2 : left + (i * (width - left - right)) / (list.length - 1));
    const y = (v) => top + plotHeight - (v / ceiling) * plotHeight;
    const grid = Array.from({ length: segments + 1 }, (_, i) => `<line x1="${left}" x2="${width - right}" y1="${y(step * i)}" y2="${y(step * i)}" class="us-grid${i === 0 ? " is-base" : ""}"/><text x="${left - 10}" y="${y(step * i) + 3}" text-anchor="end" class="us-axis">${axisLabel(step * i, divisor)}</text>`).join("");
    const unitLabel = `<text x="${left - 10}" y="${top - 9}" text-anchor="end" class="us-axis us-axis-unit">${unit ? `${unit} Token` : "Token"}</text>`;
    // 横轴标签约每 70px 一个；最后一个总是显示，离前一个太近时让位
    const stride = Math.max(1, Math.ceil(list.length / Math.max(2, Math.floor((width - left - right) / 70))));
    const labelAt = (i) => (i === list.length - 1 ? true : i % stride === 0 && list.length - 1 - i >= stride);
    const anchor = (i) => (list.length > 1 && i === list.length - 1 ? "end" : list.length > 1 && i === 0 ? "start" : "middle");
    const labels = list.map((b, i) => (labelAt(i) ? `<text x="${x(i)}" y="${height - 8}" text-anchor="${anchor(i)}" class="us-axis">${b.label}</text>` : "")).join("");

    const ys = {};
    const defs = [];
    const layers = agents.map((a) => {
      const pts = list.map((b, i) => [x(i), y(b[a] || 0)]);
      ys[a] = pts.map((p) => p[1]);
      if (pts.length === 1) return `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="3.5" class="us-point" data-agent="${a}"/>`;
      const segs = monotoneSegments(pts);
      const start = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      const solidSegs = partial ? segs.slice(0, -1) : segs;
      const solid = `${start}${solidSegs.join("")}`;
      const tail = partial ? `M${pts.at(-2)[0].toFixed(1)},${pts.at(-2)[1].toFixed(1)}${segs.at(-1)}` : "";
      const area = `${start}${segs.join("")}L${pts.at(-1)[0].toFixed(1)},${plotBottom}L${pts[0][0].toFixed(1)},${plotBottom}Z`;
      defs.push(`<linearGradient id="usFill-${a}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="us-stop-top" data-agent="${a}"/><stop offset="1" class="us-stop-bottom" data-agent="${a}"/></linearGradient>`);
      return `<path d="${area}" fill="url(#usFill-${a})" class="us-fill"/><path d="${solid}" class="us-glow" data-agent="${a}"/><path d="${solid}" class="us-series" data-agent="${a}"/>${tail ? `<path d="${tail}" class="us-series is-partial" data-agent="${a}"/>` : ""}`;
    }).join("");
    // 最新点：今天（或含今天的多日范围）且当前范围确实有用量时放呼吸波纹，表示数据仍在增长。
    // 波纹是叠在图上的 HTML 圆点（SVG 坐标 = 容器像素坐标）：SVG 子元素的 transform 动画进不了合成层，
    // 每帧都要重算样式与布局（实测用量页停着不动每秒约 50 次布局）；HTML 元素只动 transform / opacity，交给合成器。
    const hasTrendData = list.some((b) => agents.some((a) => (b[a] || 0) > 0));
    const live = Boolean(list.at(-1)?.partial) && hasTrendData;
    const pulseAt = (a) => [x(list.length - 1), ys[a].at(-1)];
    const pulses = live ? agents.map((a) => {
      const [cx, cy] = pulseAt(a);
      return `<g class="us-pulse" data-agent="${a}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})"><circle r="3.2" class="us-pulse-core"/></g>`;
    }).join("") : "";
    const rings = live ? agents.map((a) => {
      const [cx, cy] = pulseAt(a);
      return `<span class="us-pulse-ring" data-agent="${a}" style="left:${cx.toFixed(1)}px;top:${cy.toFixed(1)}px" aria-hidden="true"></span>`;
    }).join("") : "";
    // 峰值星：标在图上最高的那个点（单个 Agent 的峰值，多条线时写上是谁；图下一行是各 Agent 合计的峰值）。
    // 星空版 / 纸面版显示；简洁版 CSS 隐藏
    let peakMark = "";
    if (hasTrendData && list.length > 1) {
      let best = null;
      for (const a of agents) list.forEach((b, i) => { const v = b[a] || 0; if (!best || v > best.v) best = { i, v, a }; });
      if (best?.v > 0) {
        const px = x(best.i);
        const py = y(best.v);
        const toLeft = px > width * 0.72;
        const below = py < top + 18;
        peakMark = `<g class="us-peak" transform="translate(${px.toFixed(1)},${py.toFixed(1)})"><path class="us-peak-star" d="M0,-7L1.5,-1.5L7,0L1.5,1.5L0,7L-1.5,1.5L-7,0L-1.5,-1.5Z"/><text class="us-peak-label" x="${toLeft ? -11 : 11}" y="${below ? 15 : -8}" text-anchor="${toLeft ? "end" : "start"}">峰值 ${escapeHtml(list[best.i].label)} · ${agents.length > 1 ? `${escapeHtml(AGENT_LABELS[best.a] || best.a)} ` : ""}${shortTokens(best.v)}</text></g>`;
      }
    }
    const cross = `<line class="us-cross" x1="0" x2="0" y1="${top}" y2="${plotBottom}" visibility="hidden"/>${agents.map((a) => `<circle class="us-hover-dot" data-agent="${a}" r="4" visibility="hidden"/>`).join("")}`;
    const slot = list.length === 1 ? width - left - right : (width - left - right) / (list.length - 1);
    const hover = list.map((_, i) => {
      const x0 = Math.max(left, x(i) - slot / 2);
      const x1 = Math.min(width - right, x(i) + slot / 2);
      return `<rect class="us-hover" data-bucket="${i}" x="${x0}" y="${top}" width="${Math.max(1, x1 - x0)}" height="${plotHeight}"/>`;
    }).join("");
    trendGeometry = { xs: list.map((_, i) => x(i)), ys };
    const nextHtml = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${GRANULARITY_LABEL[trend.granularity] || ""} Token 用量"><defs>${defs.join("")}</defs>${grid}${unitLabel}${layers}${peakMark}${pulses}${cross}${labels}${hover}</svg>${rings}`;
    if (nextHtml !== lastMergedTrendHtml || !wrap.firstChild) {
      lastMergedTrendHtml = nextHtml;
      wrap.innerHTML = nextHtml;
    }
  }

  // 悬停参考线：只挪已有的一条线和几个点，不重绘整张图。
  function moveCrosshair(index) {
    const svg = $("usageTrendChart")?.querySelector("svg");
    if (!svg || !trendGeometry) return;
    const line = svg.querySelector(".us-cross");
    const visible = Number.isInteger(index) && index >= 0 && index < trendGeometry.xs.length;
    line?.setAttribute("visibility", visible ? "visible" : "hidden");
    if (visible) {
      line.setAttribute("x1", trendGeometry.xs[index]);
      line.setAttribute("x2", trendGeometry.xs[index]);
    }
    for (const dot of svg.querySelectorAll(".us-hover-dot")) {
      const ys = trendGeometry.ys[dot.dataset.agent];
      dot.setAttribute("visibility", visible && ys ? "visible" : "hidden");
      if (visible && ys) {
        dot.setAttribute("cx", trendGeometry.xs[index]);
        dot.setAttribute("cy", ys[index]);
      }
    }
  }

  function renderTooltip(index, clientX, clientY, state) {
    const tip = $("usageTooltip");
    const bucket = trendBuckets[index];
    if (!bucket) {
      tip.hidden = true;
      return;
    }
    const agents = state.agent !== "all" ? [state.agent] : currentTrendAgents;
    tip.innerHTML = `<strong>${bucket.label}${bucket.partial ? " · 进行中" : ""}</strong>${agents.map((a) => `<p><span><i class="us-line-key" data-agent="${a}"></i>${AGENT_LABELS[a] || a}</span><span>${shortTokens(bucket[a] || 0)}</span></p>`).join("")}${bucket.calls ? `<p class="us-tip-total"><span>调用</span><span>${integer(bucket.calls)} 次${bucket.errors ? ` · 失败 ${bucket.errors}` : ""}</span></p>` : ""}`;
    tip.hidden = false;
    const bounds = $("usageChartBody").getBoundingClientRect();
    tip.style.left = `${Math.max(6, Math.min(bounds.width - tip.offsetWidth - 6, clientX - bounds.left + 14))}px`;
    tip.style.top = `${Math.max(4, clientY - bounds.top - tip.offsetHeight - 10)}px`;
  }

  const bucketKey = (index) => trendBuckets[index]?.key;

  function renderCalendar(summary, state) {
    if (!summary) return;
    const today = summary.today;
    const periodSelect = $("usageCalendarPeriod");
    const months = calendarMonths(today);
    const periodHtml = `<option value="rolling">近 30 天</option>${months.map((m) => `<option value="${m}">${m.slice(0, 4)} 年 ${Number(m.slice(5))} 月</option>`).join("")}`;
    if (periodSelect.dataset.html !== periodHtml) {
      periodSelect.innerHTML = periodHtml;
      periodSelect.dataset.html = periodHtml;
    }
    if (periodSelect.value !== state.calendarPeriod) periodSelect.value = state.calendarPeriod;
    const metricSelect = $("usageCalendarMetric");
    if (metricSelect.value !== state.calendarMetric) metricSelect.value = state.calendarMetric;
    const { first, last, dates } = calendarGrid(state.calendarPeriod, today);
    const metric = state.calendarMetric;
    const cells = summary.calendar || {};
    const max = Math.max(1, ...dates.filter((d) => d >= first && d <= last).map((d) => cells[d]?.[metric] ?? 0));
    setText($("usageCalendarCaption"), `${compactDate(first)} — ${last.slice(5).replace("-", ".")}`);
    const selected = state.date ?? (state.range === 1 ? today : null);
    const coverage = summary.coverageStart;
    morphInnerHtml($("usageCalendarDays"), dates.map((d) => {
      const stats = cells[d] ?? { calls: 0, tokens: 0 };
      const adjacent = d < first || d > last;
      const future = d > today;
      const uncollected = !coverage || d < coverage;
      const inRange = !state.date && state.range > 1 && d >= summary.scope.start && d <= today;
      const label = `${dateLabel(d)}，${future ? "未来日期" : uncollected ? "未采集" : `${integer(stats.calls)} 次调用，${shortTokens(stats.tokens)} Token`}`;
      const cls = ["us-day", adjacent && "is-adjacent", future && "is-future", uncollected && !future && !adjacent && "is-uncollected", d === selected && !adjacent && "is-selected", inRange && !adjacent && "is-in-range", d === today && "is-today"].filter(Boolean).join(" ");
      const disabled = adjacent || future || uncollected;
      return `<button type="button" class="${cls}" data-date="${d}" data-heat="${disabled ? 0 : heatLevel(stats[metric], max)}" aria-label="${label}" title="${label}" aria-pressed="${d === selected && !adjacent}"${disabled ? " disabled" : ""}>${Number(d.slice(8))}${d.slice(8) === "01" && !adjacent ? `<small>${Number(d.slice(5, 7))}月</small>` : ""}</button>`;
    }).join(""));
    const shown = state.date ?? today;
    const shownStats = cells[shown] ?? { calls: 0, tokens: 0 };
    morphInnerHtml($("usageCalendarSelection"), `<strong>${dateLabel(shown)}</strong>${shown === today ? "<span>今天</span>" : ""}<span>· ${integer(shownStats.calls)} 次调用</span><span class="us-selection-tokens">${shortTokens(shownStats.tokens)} Token</span>`);
  }

  function renderProjects(summary, state) {
    const rows = summary?.projects || [];
    const max = Math.max(1, ...rows.map((r) => r.stats.total));
    const selectedIndex = rows.findIndex((r) => r.key === state.project);
    const shown = rows.slice(0, Math.max(5, selectedIndex + 1));
    const rest = rows.slice(shown.length);
    morphInnerHtml($("usageProjects"), rows.length ? shown.map((r) => {
      const selected = r.key === state.project;
      const segs = AGENTS.filter((a) => (r.byAgent?.[a] || 0) > 0).map((a) => `<span class="us-seg" data-agent="${a}" style="width:${((r.byAgent[a] || 0) / max) * 100}%" title="${AGENT_LABELS[a] || a} ${shortTokens(r.byAgent[a] || 0)}"></span>`).join("");
      const costMeta = r.stats.costUsd > 0 ? `<span title="等效 API 花费">${formatUsd(r.stats.costUsd)}</span>` : "";
      return `<button type="button" class="us-project${selected ? " is-selected" : ""}" data-project="${escapeHtml(r.key)}" aria-pressed="${selected}" title="${escapeHtml(r.key)}"><span class="us-project-top"><strong>${escapeHtml(r.label)}</strong><span>${shortTokens(r.stats.total)}</span></span><span class="us-bar">${segs}</span><span class="us-project-meta"><span>${r.sessions} 会话</span><span>未命中 ${shortTokens(r.stats.fresh)}</span>${costMeta}${r.stats.errors ? `<span class="is-error">失败 ${r.stats.errors}</span>` : ""}</span></button>`;
    }).join("") + (rest.length ? `<div class="us-project-rest" title="${rest.map((r) => escapeHtml(r.label)).join("、")}">其余 ${rest.length} 个 · ${shortTokens(rest.reduce((v, r) => v + r.stats.total, 0))}<span>${rest.map((r) => escapeHtml(r.label)).join("、")}</span></div>` : "")
      : '<p class="us-project-empty">当前范围没有会话</p>');
  }

  function contextCell(ctx) {
    if (!ctx?.window) return '<span class="us-muted">—</span>';
    const pct = Math.round(ctx.ratio * 100);
    const tone = contextTone(ctx.ratio);
    return `<span class="us-context" title="${integer(ctx.tokens)} / ${integer(ctx.window)}${ctx.estimated ? "（窗口为推断）" : ""}"><span class="us-context-track"><span class="us-context-fill" data-tone="${tone}" style="width:${Math.min(100, pct)}%"></span></span><span class="us-context-value" data-tone="${tone}">${pct}%${ctx.estimated ? '<span class="us-est">估</span>' : ""}</span></span>`;
  }

  function statusCell(s) {
    const label = STATUS_LABELS[s.status];
    const status = label ? `<span class="us-status" data-status="${s.status}"><i class="us-dot ${s.status === "recent" ? "ok is-live" : "idle"}"></i>${label}</span>` : "";
    const errors = s.stats.errors ? `<button type="button" class="us-errors" data-failed="${escapeHtml(s.key)}" title="查看失败调用">${escapeHtml(codesText(s.stats.codes))}</button>` : "";
    const hint = s.healthHint ? `<span class="us-tag" data-tone="${escapeHtml(s.healthHint.tone || "warn")}" title="${escapeHtml(s.healthHint.detail)}">${escapeHtml(s.healthHint.label)}</span>` : "";
    return status || errors || hint ? `${status}${errors}${hint}` : '<span class="us-muted">—</span>';
  }

  function renderSessions(summary, state, { highlight = new Set() } = {}) {
    const all = summary?.sessions || [];
    const rows = filterSessions(all, { filter: state.sessionFilter, search: state.search, sort: state.sort });
    const multiDay = !state.date && state.range > 1;
    const visible = rows.slice(0, state.limit);
    const today = summary?.today;
    morphInnerHtml($("usageSessionRows"), visible.map((s) => `<tr data-session="${escapeHtml(s.key)}" class="${s.status === "recent" ? "is-active" : ""}${highlight.has(s.key) ? " is-new" : ""}"><td>${multiDay || s.day !== today ? `<span class="us-sub us-date">${monthDay(s.day)}</span>` : ""}${clockOf(s.last)}<span class="us-sub">起 ${clockOf(s.first)}</span></td><td><span class="us-project-name">${escapeHtml(s.projectLabel)}</span><span class="us-sub us-narrow"><i class="us-key" data-agent="${s.agent}"></i>${AGENT_LABELS[s.agent]} · ${integer(s.stats.calls)} 次 · 未命中 ${shortTokens(s.stats.fresh)}</span></td><td class="us-col-agent"><span class="us-agent"><i class="us-key" data-agent="${s.agent}"></i>${AGENT_LABELS[s.agent]}</span><span class="us-sub us-mono">${escapeHtml(s.model || "—")}</span></td><td class="us-num us-col-calls">${integer(s.stats.calls)}</td><td class="us-num">${shortTokens(s.stats.total)}</td><td class="us-num us-col-fresh">${shortTokens(s.stats.fresh)}</td><td class="us-col-context">${contextCell(s.context)}</td><td>${statusCell(s)}</td><td><span class="us-chevron" aria-hidden="true">›</span></td></tr>`).join(""));
    const empty = usageSessionEmptyState(summary, state, rows.length);
    const emptyEl = $("usageSessionEmpty");
    if (emptyEl.hidden !== !empty) emptyEl.hidden = !empty;
    if (empty) morphInnerHtml(emptyEl, emptyStateHtml(empty));
    const moreEl = $("usageMore");
    const moreHidden = rows.length <= state.limit;
    if (moreEl.hidden !== moreHidden) moreEl.hidden = moreHidden;
    setText($("usageMoreBtn"), `显示更多（还有 ${rows.length - state.limit} 个）`);
    setText($("usageSessionCount"), `${rows.length} 个`);
    for (const btn of doc.querySelectorAll("[data-usage-sort]")) {
      const active = btn.dataset.usageSort === state.sort;
      setAttr(btn.closest("th"), "aria-sort", active ? "descending" : "none");
      if (btn.classList.contains("is-sorted") !== active) btn.classList.toggle("is-sorted", active);
    }
    for (const btn of doc.querySelectorAll("[data-usage-filter]")) setAttr(btn, "aria-pressed", String(btn.dataset.usageFilter === state.sessionFilter));
  }

  function renderLive(summary, state) {
    const historical = Boolean(state.date && summary && state.date !== summary.today);
    const hasSources = Boolean(summary?.sources?.length);
    setText($("usageSessionsTitle"), historical ? `${dateLabel(state.date)}的会话` : "会话");
    morphInnerHtml($("usageLive"), historical ? '<i class="us-dot idle"></i>历史记录' : state.follow ? `<i class="us-dot ok${hasSources ? " is-live" : ""}"></i>跟随最新` : '<i class="us-dot idle"></i>已停止跟随，列表不重排');
    const followBtn = $("usageFollowBtn");
    if (followBtn.hidden !== historical) followBtn.hidden = historical;
    setAttr(followBtn, "aria-pressed", String(state.follow));
    setText(followBtn, state.follow ? "停止跟随" : "跟随最新");
    setText($("usageSessionFoot"), `会话表与 CSV 为全会话累计；成本榜仅所选时段 · ${state.follow ? "向下滚动或指针停在表格上时保持位置" : "列表保持不动，上方统计继续更新"}`);
  }

  function renderHeld(count) {
    const heldEl = $("usageHeld");
    const heldHidden = count === 0;
    if (heldEl.hidden !== heldHidden) heldEl.hidden = heldHidden;
    setText($("usageHeldText"), `${count} 个会话有更新`);
  }

  // 星空版 / 纸面版的星图总览（简洁版里这块 display:none，照样写入，换皮肤不用等下一轮数据）
  function renderObservatory(summary, state) {
    const el = $("usageGalaxyStage");
    if (el) morphInnerHtml(el, observatoryHtml(summary, state));
  }

  function renderEmptyState(summary, spec = usagePageEmptyState(summary)) {
    const el = $("usageEmptyState");
    if (!el) return;
    if (el.hidden !== !spec) el.hidden = !spec;
    if (spec) morphInnerHtml(el, emptyStateHtml({ ...spec, compact: true }));
  }

  function renderDisabled() {
    renderEmptyState(null, USAGE_DISABLED_STATE);
    renderObservatory(null, null);
  }

  function render(summary, state, options) {
    renderSource(summary, state);
    renderEmptyState(summary);
    renderScope(summary, state);
    renderObservatory(summary, state);
    renderMetrics(summary, state);
    const insights = $("usageInsights");
    if (insights) {
      const opened = new Set([...insights.querySelectorAll("details[open][data-cost-details]")].map(el => el.dataset.costDetails));
      morphInnerHtml(insights, usageInsightsHtml(summary, state, opened));
    }
    renderTrend(summary, state);
    renderCalendar(summary, state);
    renderProjects(summary, state);
    if (!options?.skipSessions) renderSessions(summary, state, options);
    renderLive(summary, state);
  }

  // ---- 会话详情：会话 → 轮次 → 调用 ----
  function contextChart(detail) {
    const points = detail.contextSeries || [];
    const window = detail.context?.window;
    if (points.length < 2 || !window) return '<p class="us-note">调用不足两次，暂不绘制。</p>';
    const width = 860, height = 110, left = 40, right = 8, top = 10, bottom = 18;
    const t0 = points[0][0];
    const t1 = points.at(-1)[0];
    const top_ = Math.max(window, ...points.map((p) => p[1]));
    const x = (t) => left + ((t - t0) / Math.max(1, t1 - t0)) * (width - left - right);
    const y = (v) => top + (height - top - bottom) * (1 - v / top_);
    const line = points.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const warn = y(window * 0.85);
    return `<svg class="us-context-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="每次调用的上下文占用"><line x1="${left}" x2="${width - right}" y1="${y(window)}" y2="${y(window)}" class="us-grid"/><text x="${left - 6}" y="${y(window) + 3}" text-anchor="end" class="us-axis">${shortTokens(window)}</text><line x1="${left}" x2="${width - right}" y1="${warn}" y2="${warn}" class="us-warn-line"/><text x="${left + 4}" y="${warn - 4}" class="us-axis">85%</text><line x1="${left}" x2="${width - right}" y1="${y(0)}" y2="${y(0)}" class="us-grid is-base"/><text x="${left - 6}" y="${y(0) + 3}" text-anchor="end" class="us-axis">0</text><path d="${line}" class="us-series" data-agent="${detail.agent}"/><circle cx="${x(t1)}" cy="${y(points.at(-1)[1])}" r="4" class="us-context-dot" data-agent="${detail.agent}"/><text x="${left}" y="${height - 3}" class="us-axis">${clockOf(t0)}</text><text x="${width - right}" y="${height - 3}" text-anchor="end" class="us-axis">${clockOf(t1)}</text></svg>`;
  }

  // 跨天会话两端都写日期（例：10 月 1 日 21:38 – 10 月 2 日 01:05）。
  function sessionSpan(first, last) {
    const firstDay = dayKeyOf(first);
    const lastDay = dayKeyOf(last);
    return `${dateLabel(firstDay)} ${clockOf(first)} – ${firstDay === lastDay ? "" : `${dateLabel(lastDay)} `}${clockOf(last)}`;
  }

  const CALL_HEAD = '<th>请求 ID</th><th>状态</th><th class="us-num">普通输入</th><th class="us-num">缓存写入</th><th class="us-num">缓存读取</th><th class="us-num">输出</th>';
  // 失败调用：状态格写错误码；没有码时写按原文归出的类别（认不出 / 没有原文仍写「失败」）。
  // 「原文」按钮原地展开下一行显示脱敏后的错误原文；展开状态与轮次共用 state.expanded（键 err:<rid>）。
  function failedLabel(call) {
    if (call.code !== null && call.code !== undefined) return String(call.code);
    const kind = call.errorKind;
    return kind && !["other", "unrecorded", "empty", "dropped"].includes(kind) ? errorKindLabel(kind) : "失败";
  }
  function errorTextRow(call, colspan) {
    const { text, note } = errorTextNote(call);
    return `<tr class="us-err-text"><td colspan="${colspan}">${text ? `<p class="us-err-body">${escapeHtml(text)}</p>` : ""}<span class="us-note">${escapeHtml(note)}</span></td></tr>`;
  }
  function callRows(calls, expanded = new Set()) {
    return calls.map(({ call, turn }) => {
      const errKey = `err:${call.rid}`;
      const open = !call.ok && expanded.has(errKey);
      const status = call.ok
        ? '<span class="us-ok">成功</span>'
        : `<span class="us-errors is-static">${escapeHtml(failedLabel(call))}</span><button type="button" class="text-btn us-err-toggle" data-call-err="${escapeHtml(errKey)}" aria-expanded="${open}">${open ? "收起" : "原文"}</button>`;
      const row = `<tr class="${call.ok ? "" : "is-error"}"><td>${clockOf(call.t, { seconds: true })}</td>${turn ? `<td class="us-num">${turn.index}</td>` : ""}<td class="us-mono us-rid" title="${escapeHtml(call.rid)}">${escapeHtml(call.rid)}${call.sidechain ? '<span class="us-tag">子 Agent</span>' : ""}</td><td class="us-nowrap">${status}</td>${call.ok ? `<td class="us-num">${shortTokens(call.inFresh)}</td><td class="us-num">${shortTokens(call.cacheWrite)}</td><td class="us-num">${shortTokens(call.cacheRead)}</td><td class="us-num">${shortTokens(call.output)}</td>` : '<td class="us-num">—</td><td class="us-num">—</td><td class="us-num">—</td><td class="us-num">—</td>'}</tr>`;
      return open ? row + errorTextRow(call, turn ? 8 : 7) : row;
    }).join("");
  }

  // 上一次写进详情区的 HTML。浮层开着时每 15 秒重读一次，历史会话的内容不会变：
  // 原样重建会清掉用户正选中的会话 ID / 报错原文和键盘焦点，所以内容没变就不动 DOM。
  let detailHtml = null;

  function renderDetailLoading() {
    detailHtml = null;
    $("usageSessionDetail").innerHTML = '<p class="us-note">加载中…</p>';
  }

  function renderDetail(detail, state) {
    const body = $("usageSessionDetail");
    if (!detail) {
      detailHtml = null;
      body.innerHTML = '<p class="us-note">会话不存在或已超出保留期。</p>';
      return;
    }
    const scroller = body.querySelector(".us-turn-scroll");
    const keepTurn = scroller?.scrollTop ?? 0;
    const prevTurnHeight = scroller?.scrollHeight ?? 0;
    const keepDialog = $("dlgUsageSession").scrollTop;
    setText($("usageSessionTitle"), detail.projectLabel);
    setText($("usageSessionLive"), detail.status === "recent" ? "近期活跃 · 有新调用时自动追加，滚动位置保持" : detail.status === "quiet" ? "暂无新记录 · 有新调用时自动追加" : "历史会话");
    const failed = detail.turns.flatMap((turn) => turn.calls.filter((c) => !c.ok).map((call) => ({ call, turn })));
    const failedOnly = state.failedOnly && failed.length > 0;
    let table;
    if (failedOnly) {
      table = `<table class="us-data"><thead><tr><th>时间</th><th class="us-num">轮</th>${CALL_HEAD}</tr></thead><tbody>${callRows([...failed].reverse(), state.expanded)}</tbody></table>`;
    } else {
      table = `<table class="us-data"><thead><tr><th>轮</th><th>开始</th><th class="us-num">耗时</th><th class="us-num">调用</th><th class="us-num">未命中输入</th><th class="us-num">输出</th><th>备注</th></tr></thead><tbody>${[...detail.turns].reverse().map((turn) => {
        const key = `${detail.key}#${turn.index}`;
        const open = state.expanded.has(key);
        const notes = [];
        if (turn.open) notes.push('<span class="us-status" data-status="recent">未记录结束</span>');
        if (turn.stats.errors) notes.push(`<span class="us-errors is-static">${escapeHtml(codesText(turn.stats.codes))}</span>`);
        if (turn.compacted) notes.push('<span class="us-tag">已压缩上下文</span>');
        const head = `<tr class="us-turn${open ? " is-open" : ""}" data-turn="${escapeHtml(key)}" tabindex="0" aria-expanded="${open}"><td><span class="us-caret" aria-hidden="true">${open ? "▾" : "▸"}</span>${turn.index}</td><td>${turn.t0 ? clockOf(turn.t0) : "—"}</td><td class="us-num">${turn.durationSec === null ? "—" : formatDuration(turn.durationSec)}</td><td class="us-num">${turn.stats.calls}</td><td class="us-num">${shortTokens(turn.stats.fresh)}</td><td class="us-num">${shortTokens(turn.stats.output)}</td><td>${notes.join(" ")}</td></tr>`;
        const calls = open ? `<tr class="us-calls"><td colspan="7"><table class="us-data us-call-table"><thead><tr><th>时间</th>${CALL_HEAD}</tr></thead><tbody>${callRows(turn.calls.map((call) => ({ call })), state.expanded)}</tbody></table></td></tr>` : "";
        return head + calls;
      }).join("")}</tbody></table>`;
    }
    const s = detail.stats;
    const ctx = detail.context;
    const slurmRow = Array.isArray(detail.slurmJobs) && detail.slurmJobs.length
      ? `<div class="is-wide"><dt>关联 Slurm 作业</dt><dd class="us-mono">${detail.slurmJobs.map((j) => `#${escapeHtml(String(j.jobId))}${j.name ? `（${escapeHtml(j.name)}）` : ""}`).join("、")}</dd></div>`
      : "";
    const hintNote = detail.healthHint
      ? `<p class="us-note" data-tone="${escapeHtml(detail.healthHint.tone || "warn")}">${escapeHtml(detail.healthHint.detail)}</p>`
      : "";
    const costNote = s.costUsd > 0 ? ` · 等效花费 <b>${formatUsd(s.costUsd)}</b>${s.savedUsd > 0 ? `（缓存净省 ${formatUsd(s.savedUsd)}）` : ""}` : "";
    const html = `<div class="us-detail"><div class="us-detail-summary"><span class="us-agent"><i class="us-key" data-agent="${detail.agent}"></i>${AGENT_LABELS[detail.agent]}</span><span class="us-mono">${escapeHtml(detail.model || "—")}</span></div><dl class="us-detail-grid"><div><dt>时间 · ${TZ_LABEL}</dt><dd>${sessionSpan(detail.first, detail.last)}</dd></div><div><dt>轮次 / 调用</dt><dd>${detail.turns.length} / ${integer(s.calls)}${s.errors ? `（失败 ${s.errors}）` : ""}</dd></div><div class="is-wide"><dt>工作目录</dt><dd>${escapeHtml(detail.project)}</dd></div><div class="is-wide"><dt>会话 ID</dt><dd class="us-mono">${escapeHtml(detail.sid)}</dd></div>${slurmRow}</dl><div class="us-tokens"><div><span>普通输入</span><strong>${shortTokens(s.inFresh)}</strong></div><div><span>缓存写入</span><strong>${shortTokens(s.cacheWrite)}</strong></div><div><span>缓存读取</span><strong>${shortTokens(s.cacheRead)}</strong></div><div><span>输出</span><strong>${shortTokens(s.output)}</strong></div></div><p class="us-note">未命中输入 = 普通输入 + 缓存写入 = <b>${shortTokens(s.fresh)}</b> · 总 ${integer(s.total)} Token${costNote}</p>${hintNote}<h3 class="us-detail-h">上下文占用 <span>${ctx?.ratio ? `${Math.round(ctx.ratio * 100)}%${ctx.estimated ? "（估）" : ""} · ${shortTokens(ctx.tokens)} / ${shortTokens(ctx.window)}` : "—"}</span></h3>${contextChart(detail)}<div class="us-detail-h us-detail-row"><h3>${failedOnly ? `失败调用 <span>${failed.length} 次 · 最新在前</span>` : "每轮明细 <span>点一轮展开逐次调用 · 最新在前</span>"}</h3>${failed.length ? `<fieldset class="us-segmented us-segmented-sm" aria-label="明细范围"><button type="button" data-detail-view="turns" aria-pressed="${!failedOnly}">全部轮次</button><button type="button" data-detail-view="failed" aria-pressed="${failedOnly}">只看失败 ${failed.length}</button></fieldset>` : ""}</div><div class="us-turn-scroll">${table}</div><p class="us-note">请求 ID：Codex 为 response_id，Claude 为 requestId；失败调用没有请求 ID 时显示日志记录 ID。首 Token 时间日志不记录。</p></div>`;
    if (html === detailHtml) return;
    detailHtml = html;
    body.innerHTML = html;
    const next = body.querySelector(".us-turn-scroll");
    if (next) {
      const delta = keepTurn > 4 && prevTurnHeight > 0 ? Math.max(0, next.scrollHeight - prevTurnHeight) : 0;
      next.scrollTop = keepTurn + delta;
    }
    $("dlgUsageSession").scrollTop = keepDialog;
  }

  return { render, renderSessions, renderLive, renderHeld, renderTrend, renderTooltip, moveCrosshair, bucketKey, renderDetail, renderDetailLoading, renderDisabled };
}
