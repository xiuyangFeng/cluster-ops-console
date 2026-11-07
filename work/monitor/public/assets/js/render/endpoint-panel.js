// render/endpoint-panel.js —— 端点检测弹层（#dlgEndpoint）：一行指标 + 全宽延迟图 + 结论条 + 报文原文。
//
// 弹层里可以直接切 Agent：只换弹层显示的内容（结论条、报文原文、延迟图一起换），不改全局
// 诊断视角、不发写请求；每次打开弹层回到全局视角的那个 Agent。延迟图的数据来自
// GET /api/probes/history（近 24 小时），只在弹层打开时拉。
// 纯函数（指标、图表配置、结论文案）不碰 DOM，Node 下可直接测。
import { getProbeHistory } from "../api.js";
import { agentDisplayName } from "../display-names.js";
import { createElementLookup, morphInnerHtml } from "../dom-utils.js";
import { createLineChart, hourTicks, linearTicks, nearestIndex, niceCeil } from "../line-chart.js";
import { escapeHtml } from "../store.js";
import { buildStarfieldModel, createStarfieldChart } from "./endpoint-starfield.js";
import { clockOf, dayKeyOf, monthDay } from "./usage-model.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const HISTORY_MAX_AGE_MS = 120_000; // 弹层开着时，检测记录最久多久重拉一次
const CHART_HEIGHT = 220;
const CHART_PAD = { l: 46, r: 14, t: 14, b: 46 };
const RAIL_GAP = 12; // 失败标记带离图底边的距离
const RAIL_HEIGHT = 6;
const FAIL_SNAP_PX = 12; // 指针落在标记带上时，离失败刻度多近算选中它

// 有独立端点探针（并记检测历史）的 Agent → 探针 id。其余 Agent 没有网络探测，只有一句检查结论。
export const ENDPOINT_PROBE_IDS = Object.freeze({ codex: "endpoint", "claude-codewing": "claude-endpoint" });

// 263ms / 1.16s / 11.6s；非法值给「—」。
export function formatMs(value) {
  const v = Number(value);
  if (value == null || !Number.isFinite(v) || v < 0) return "—";
  const ms = Math.round(v);
  if (ms < 1000) return `${ms}ms`;
  return `${Number((ms / 1000).toFixed(ms < 10000 ? 2 : 1))}s`;
}

// 升序数组的分位数（最近秩：q=0.95 → 有 95% 的值不超过它）。
export function quantileOf(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

// 检测记录 → 指标与图表数据。samples：/api/probes/history 的样本（ts / ok / latencyMs / probeDurationMs）。
// 用哪个量：成功的样本里绝大多数（≥95%）带请求往返耗时（latencyMs）就用它，否则统一用整次检测耗时
// （probeDurationMs，含 SSH 开销）——两个口径不混在一张图里。没有样本返回 null。
export function buildEndpointTrend(samples, { nowMs = Date.now(), windowMs = DAY_MS } = {}) {
  const rows = (Array.isArray(samples) ? samples : []).filter((s) => s && Number.isFinite(s.ts)).sort((a, b) => a.ts - b.ts);
  if (!rows.length) return null;
  const okRows = rows.filter((s) => s.ok === true);
  const withLatency = okRows.filter((s) => Number.isFinite(s.latencyMs)).length;
  const metric = okRows.length > 0 && withLatency / okRows.length >= 0.95 ? "latency" : "duration";
  const metricValue = (s) => {
    const v = metric === "latency" ? s.latencyMs : s.probeDurationMs;
    return Number.isFinite(v) ? v : null;
  };
  const points = rows.map((s) => ({ ts: s.ts, ok: s.ok === true, value: metricValue(s) }));
  const values = points.filter((p) => p.ok && p.value != null).map((p) => p.value).sort((a, b) => a - b);
  const failures = points.filter((p) => !p.ok);
  // 纵轴截到 99 分位：一两次十几秒的超时不该把其余几百个点压成一条贴底的线
  const yMax = values.length ? Math.max(100, niceCeil(quantileOf(values, 0.99))) : 1000;
  const gaps = rows.slice(1).map((s, i) => s.ts - rows[i].ts).sort((a, b) => a - b);
  const t1 = Math.max(nowMs, rows[rows.length - 1].ts);
  return {
    metric,
    partialLatency: metric === "duration" && withLatency > 0, // 请求往返耗时刚开始记，还盖不满窗口
    points,
    total: rows.length,
    failed: failures.length,
    availability: (rows.length - failures.length) / rows.length,
    median: quantileOf(values, 0.5),
    p95: quantileOf(values, 0.95),
    slowest: values.length ? values[values.length - 1] : null,
    clipped: values.filter((v) => v > yMax).length,
    yMax,
    lastFailureAt: failures.length ? failures[failures.length - 1].ts : null,
    t0: t1 - windowMs,
    t1,
    spanMs: t1 - rows[0].ts,
    intervalMs: gaps.length ? gaps[gaps.length >> 1] : null,
  };
}

// 时刻（北京时间）：与 nowMs 同一天只写时分，否则带月.日。
function whenText(ts, nowMs) {
  const sec = Math.floor(ts / 1000);
  const day = dayKeyOf(sec);
  return day === dayKeyOf(Math.floor(nowMs / 1000)) ? clockOf(sec) : `${monthDay(day)} ${clockOf(sec)}`;
}

const METRIC_NAMES = { latency: "请求往返", duration: "整次检测" };

// 指标行：可用率 / 中位 / 95% 以内 / 最慢 / 失败。
export function endpointStats(trend) {
  const availability = trend.failed === 0 ? "100%" : `${Math.min(99.9, trend.availability * 100).toFixed(1)}%`;
  return [
    { label: "可用率", value: availability, hint: `${trend.total} 次检测`, tone: trend.availability >= 0.999 ? "" : trend.availability >= 0.99 ? "warn" : "critical" },
    { label: "中位", value: formatMs(trend.median), hint: METRIC_NAMES[trend.metric], tone: "" },
    { label: "95% 以内", value: formatMs(trend.p95), hint: "", tone: "" },
    { label: "最慢", value: formatMs(trend.slowest), hint: trend.clipped ? `${trend.clipped} 次超出图表量程` : "", tone: "" },
    { label: "失败", value: `${trend.failed} 次`, hint: trend.failed ? `最近 ${whenText(trend.lastFailureAt, trend.t1)}` : "", tone: trend.failed ? "warn" : "" },
  ];
}

export function endpointStatsHtml(stats) {
  return stats.map((s) => `<div class="ep-stat"${s.tone ? ` data-tone="${s.tone}"` : ""}><span class="ep-stat-label">${escapeHtml(s.label)}</span><span class="ep-stat-value">${escapeHtml(s.value)}</span><span class="ep-stat-hint">${escapeHtml(s.hint)}</span></div>`).join("");
}

// 图注：覆盖多久、多久检测一次、图里画的是哪个量。
export function endpointCaption(trend, endpointLabel) {
  const hours = trend.spanMs / HOUR_MS;
  const span = hours >= 23 ? "近 24 小时" : hours >= 1 ? `近 ${Math.round(hours)} 小时` : `近 ${Math.max(1, Math.round(trend.spanMs / 60_000))} 分钟`;
  const seconds = trend.intervalMs == null ? null : trend.intervalMs / 1000;
  const interval = seconds == null ? "" : seconds < 120 ? `约每 ${Math.max(10, Math.round(seconds / 10) * 10)} 秒检测一次` : `约每 ${Math.round(seconds / 60)} 分钟检测一次`;
  const what = trend.metric === "latency"
    ? `集群经隧道请求 ${endpointLabel || "接口"} 的往返耗时`
    : `这里是整次检测的耗时（含本机到集群的 SSH 往返）${trend.partialLatency ? "；请求往返耗时刚开始记录，覆盖满这段时间后改用它" : ""}`;
  return [span, interval, what].filter(Boolean).join(" · ");
}

const axisMs = (v) => (v === 0 ? "0" : v >= 1000 ? `${Number((v / 1000).toFixed(2))}s` : `${Math.round(v)}ms`);

// 延迟图的配置（交给 createLineChart）。纵轴截到 trend.yMax，超出的点压在上沿并在图顶画三角标；
// 图下一条失败标记带（绿底 = 检测正常，红色刻度 = 那次检测失败，与隧道在线条同一画法）。
export function endpointChartOptions(trend, { label = "" } = {}) {
  const { points, yMax, t0, t1 } = trend;
  const line = points.filter((p) => p.ok && p.value != null);
  const clipped = line.filter((p) => p.value > yMax);
  const failed = [];
  points.forEach((p, index) => { if (!p.ok) failed.push({ ts: p.ts, index }); });
  const failedXs = failed.map((f) => f.ts);
  const metricName = METRIC_NAMES[trend.metric];
  return {
    label,
    height: CHART_HEIGHT,
    pad: CHART_PAD,
    x: [t0, t1],
    yMax,
    yTicks: linearTicks(yMax, 4),
    yFormat: axisMs,
    // 整点刻度离右端太近时让位给「现在」
    xTicks: [...hourTicks(t0, t1 - 1.2 * HOUR_MS, 4), { t: t1, label: "现在", anchor: "end" }],
    series: [{ thin: true, points: line.map((p) => [p.ts, Math.min(yMax, p.value)]) }],
    extra: ({ x, W, H, pad }) => {
      const railY = H - pad.b + RAIL_GAP;
      let s = `<rect class="ep-rail" x="${pad.l}" y="${railY}" width="${W - pad.l - pad.r}" height="${RAIL_HEIGHT}" rx="2"/>`;
      s += `<text class="lc-axis" x="${pad.l - 7}" y="${railY + RAIL_HEIGHT + 1}" text-anchor="end">失败</text>`;
      for (const f of failed) s += `<rect class="ep-fail" x="${(x(f.ts) - 1).toFixed(1)}" y="${railY}" width="2" height="${RAIL_HEIGHT}"/>`;
      for (const p of clipped) s += `<path class="ep-clip" d="M${x(p.ts).toFixed(1)},${pad.t - 8}l3.5,6h-7z"/>`;
      return s;
    },
    hover: {
      xs: points.map((p) => p.ts),
      dots: (i) => (points[i].ok && points[i].value != null ? [{ v: Math.min(yMax, points[i].value) }] : []),
      tip: (i) => {
        const p = points[i];
        const sec = Math.floor(p.ts / 1000);
        const row = p.ok
          ? { label: metricName, value: formatMs(p.value) }
          : { tone: "fail", label: "检测失败", value: p.value != null ? `等了 ${formatMs(p.value)}` : "" };
        return { title: `${monthDay(dayKeyOf(sec))} ${clockOf(sec)}`, rows: [row] };
      },
      // 失败只是几百个点里的一个，按「最近的点」很难指中：指针落在标记带上时吸到最近的失败刻度
      resolve: ({ t, px, py, ctx }) => {
        if (!failed.length || py < ctx.H - ctx.pad.b + RAIL_GAP - 4) return null;
        const hit = failed[nearestIndex(failedXs, t)];
        return Math.abs(ctx.x(hit.ts) - px) <= FAIL_SNAP_PX ? hit.index : null;
      },
    },
    tipTop: 8,
  };
}

// 弹层里某个 Agent 的端点结论。viewFor(agentId)：以该 Agent 为诊断视角的 getActiveAgentView（由调用方给，
// 两个带探针的 Agent 的结论 / 徽标文案与概览同源）；没有独立探针的 Agent 读 agentsStatus[id].endpoint。
// 返回 { agent, endpoint: { ok, output }, badge, probeId, target }。
export function endpointViewOf(status, agentId, viewFor) {
  const agents = Array.isArray(status?.agents) ? status.agents : [];
  const agent = agents.find((a) => a && a.id === agentId) || { id: String(agentId || ""), name: String(agentId || "") };
  const probeId = ENDPOINT_PROBE_IDS[agent.id] || null;
  if (probeId) {
    const view = viewFor(agent.id);
    return {
      agent: view.agent || agent,
      endpoint: { ok: view.endpoint?.ok === true, output: view.endpoint?.output || "" },
      badge: view.endpointBadge || "",
      probeId,
      target: agent.id === "claude-codewing" ? status?.claudeEndpoint?.target || "" : "",
    };
  }
  const raw = status?.agentsStatus?.[agent.id]?.endpoint || {};
  const ok = raw.ok === true ? true : raw.ok === false ? false : null;
  return {
    agent,
    endpoint: { ok, output: raw.output || "" },
    badge: ok === true ? "检查通过" : ok === false ? "检查未通过" : "尚未检查",
    probeId: null,
    target: "",
  };
}

// 结论条：{ tone: "ok" | "bad", text }。
export function endpointBriefOf(view) {
  const { agent, endpoint, probeId, target } = view;
  const label = agent.endpointLabel || "外部接口";
  if (endpoint.ok === true) {
    if (agent.id === "claude-codewing") return { tone: "ok", text: `✓ Claude API${target ? ` (${target})` : ""} 经隧道代理可达，ReClaude 可复用远端 HTTP CONNECT 通道` };
    return { tone: "ok", text: probeId ? "✓ API 端点连通性测试通过 (响应 HTTP 200/405)" : `✓ ${label} 检查通过` };
  }
  if (!endpoint.output) return { tone: "bad", text: "暂无测试数据" };
  return { tone: "bad", text: probeId ? `✗ ${label} 握手失败，请求无法到达目标` : `✗ ${label} 检查未通过` };
}

// 星空版 / 纸面版：读数头先给结论、延迟图换成星点图（render/endpoint-starfield.js），图注附图例。
const isSkyStyle = (doc) => {
  const skin = doc?.body?.dataset?.skin;
  return skin === "starry" || skin === "paper";
};

// 最近一次检测已经过去一阵（隧道停了、探针没在跑）时注明多久以前，免得和「现在的结论」读成同一时刻。
function agoText(ms) {
  if (!(ms > 10 * 60_000)) return "";
  if (ms < HOUR_MS) return `（${Math.round(ms / 60_000)} 分钟前）`;
  if (ms < 2 * DAY_MS) return `（${Math.round(ms / HOUR_MS)} 小时前）`;
  return `（${Math.round(ms / DAY_MS)} 天前）`;
}

// 读数头：左边是结论（现在可达与否 + 结论条的原话 + 最近一次检测），右边四个数；
// 「最慢」不在这里——星点图上直接标在那颗星旁边。结论条在这两套皮肤下由它代替（CSS 隐藏）。
export function endpointHeroHtml(view, trend) {
  const ok = view.endpoint.ok === true;
  const tone = ok ? "ok" : view.endpoint.output ? "bad" : "idle";
  const word = ok ? "可达" : tone === "bad" ? "不可达" : "暂无结论";
  const detail = tone === "idle" ? "" : endpointBriefOf(view).text.replace(/^[✓✗]\s*/, "");
  const last = trend.points[trend.points.length - 1];
  const lastText = last ? `最近一次检测 ${whenText(last.ts, trend.t1)}${agoText(trend.t1 - last.ts)} · ${last.ok ? formatMs(last.value) : "失败"}` : "";
  const stats = endpointStats(trend).filter((s) => s.label !== "最慢");
  return `<div class="ep-hero" data-tone="${tone}">`
    + `<div class="ep-now"><span class="ep-now-star" aria-hidden="true"></span><div class="ep-now-text">`
    + `<span class="ep-now-word">${word}</span>`
    + (detail ? `<span class="ep-now-detail">${escapeHtml(detail)}</span>` : "")
    + (lastText ? `<span class="ep-now-last">${escapeHtml(lastText)}</span>` : "")
    + `</div></div><div class="ep-readouts">${endpointStatsHtml(stats)}</div></div>`;
}

export const STARFIELD_LEGEND_HTML = '<span class="sf-keys" aria-label="图例">'
  + '<span class="sf-key"><i class="sf-key-star"></i>一次检测</span>'
  + '<span class="sf-key"><i class="sf-key-star is-slow"></i>最慢 5%</span>'
  + '<span class="sf-key"><i class="sf-key-band"></i>中位与 25–75 分位</span>'
  + '<span class="sf-key"><i class="sf-key-fail"></i>失败</span>'
  + "</span>";

// 弹层控制：render(status, agentView, viewFor) 由渲染管线每轮调用；弹层关着时什么都不做。
// getHistory / now / morph / createChart / createStarfield 可注入（测试用）。
export function createEndpointPanel({ doc, isOpen, getHistory = getProbeHistory, now = Date.now, morph = morphInnerHtml, createChart = createLineChart, createStarfield = createStarfieldChart }) {
  const $ = createElementLookup(doc);
  const histories = new Map(); // probeId → { trend, version, sig, fetchedAt, inFlight, loaded, error }
  let selected = null; // 弹层里点选的 Agent；null = 跟随全局诊断视角
  let wasOpen = false;
  let bound = false;
  let chart = null;
  let chartKind = ""; // "line" | "starfield"：换皮肤时销毁重建
  let drawnKey = "";
  let last = null; // 最近一次 render 的入参（切 Agent / 记录到达时重画用）

  function bind() {
    if (bound) return;
    const seg = $("endpointAgents");
    const dialog = $("endpointContent")?.closest("dialog");
    if (!seg || !dialog) return;
    bound = true;
    seg.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-ep-agent]");
      if (!btn || !last) return;
      selected = btn.dataset.epAgent;
      paint();
    });
    // 关掉弹层 = 这次的临时选择作废，下次打开回到全局视角
    dialog.addEventListener("close", () => {
      selected = null;
      wasOpen = false;
      chart?.clear();
    });
  }

  function historyOf(probeId, sig) {
    let entry = histories.get(probeId);
    if (!entry) {
      entry = { trend: null, version: 0, sig: null, fetchedAt: 0, inFlight: false, loaded: false, error: false };
      histories.set(probeId, entry);
    }
    // 端点输出变了说明探针又跑了一轮（有新样本）；输出没变也隔一阵重拉一次
    const stale = entry.sig !== sig || now() - entry.fetchedAt > HISTORY_MAX_AGE_MS;
    if (stale && !entry.inFlight) {
      entry.inFlight = true;
      entry.sig = sig;
      getHistory({ id: probeId })
        .then((data) => {
          entry.trend = buildEndpointTrend(data?.samples, { nowMs: now() });
          entry.loaded = true;
          entry.error = false;
        })
        .catch(() => {
          entry.error = true;
        })
        .finally(() => {
          entry.inFlight = false;
          entry.fetchedAt = now();
          entry.version += 1;
          if (isOpen() && last) paint();
        });
    }
    return entry;
  }

  function paintTrend(view, name) {
    const stats = $("endpointStats");
    const host = $("endpointChart");
    const empty = $("endpointEmpty");
    const caption = $("endpointCaption");
    if (!stats || !host || !empty || !caption) return;
    const entry = view.probeId ? historyOf(view.probeId, `${view.endpoint.ok}|${view.endpoint.output}`) : null;
    const trend = entry?.trend || null;
    let message = "";
    if (!view.probeId) message = `${name} 没有单独的端点探针，暂无延迟记录。`;
    else if (!trend) message = !entry.loaded ? (entry.error ? "检测记录读取失败，稍后会自动重试。" : "正在读取检测记录…") : `${name} 近 24 小时还没有端点检测记录。`;
    empty.hidden = !message;
    empty.textContent = message;
    stats.hidden = !trend;
    host.hidden = !trend;
    caption.hidden = !trend;
    if (!trend) {
      drawnKey = "";
      return;
    }
    const sky = isSkyStyle(doc);
    const kind = sky ? "starfield" : "line";
    morph(stats, sky ? endpointHeroHtml(view, trend) : endpointStatsHtml(endpointStats(trend)));
    const captionText = endpointCaption(trend, view.agent.endpointLabel);
    if (sky) morph(caption, `<span>${escapeHtml(captionText)} · 纵轴为对数刻度</span>${STARFIELD_LEGEND_HTML}`);
    else if (caption.textContent !== captionText || caption.firstElementChild) caption.textContent = captionText;
    if (chart && chartKind !== kind) {
      chart.destroy?.();
      chart = null;
      drawnKey = "";
    }
    if (!chart) {
      chart = sky ? createStarfield(host) : createChart(host);
      chartKind = kind;
    }
    const key = `${kind}:${view.probeId}:${entry.version}`;
    // 同一份记录不重画（渲染管线每轮都会走到这里）；上次画的时候弹层还没量到宽度则补画
    if (key !== drawnKey) {
      const label = `${name} 近 24 小时端点延迟`;
      const drawn = sky
        ? chart.update({ model: buildStarfieldModel(trend), label, metricName: METRIC_NAMES[trend.metric], formatMs })
        : chart.update(endpointChartOptions(trend, { label }));
      if (drawn) drawnKey = key;
    }
  }

  // 没有启用的 Agent（监控模块全部关闭）：空态，不画趋势、不拉记录。
  function paintEmpty() {
    const seg = $("endpointAgents");
    if (seg) seg.hidden = true;
    const title = $("endpointPanelTitle");
    if (title) title.textContent = "端点检测";
    const badge = $("epStatusBadge");
    if (badge) badge.textContent = "未启用";
    const briefEl = $("endpointBrief");
    if (briefEl) {
      briefEl.className = "endpoint-brief";
      briefEl.textContent = "没有启用的 Agent，端点检测已停止。可在「配置 → 监控模块」中开启。";
    }
    const raw = $("endpoint");
    if (raw && raw.textContent !== "-") raw.textContent = "-";
    // 原始输出框在空态下只会剩一个「-」，整框收起；paint() 有 Agent 时再放出来。
    const rawBox = raw?.parentElement;
    if (rawBox) rawBox.hidden = true;
    for (const id of ["endpointStats", "endpointChart", "endpointCaption", "endpointEmpty"]) {
      const el = $(id);
      if (el) el.hidden = true;
    }
    drawnKey = "";
  }

  function paint() {
    if (!last) return;
    const { status, agentView, viewFor } = last;
    const agents = Array.isArray(status.agents) ? status.agents : [];
    if (selected && !agents.some((a) => a.id === selected)) selected = null;
    const agentId = selected || agentView?.agent?.id || agents[0]?.id || null;
    if (!agentId) return paintEmpty();
    const rawBox = $("endpoint")?.parentElement;
    if (rawBox) rawBox.hidden = false;
    const view = endpointViewOf(status, agentId, viewFor);
    const name = agentDisplayName(status, agentId);

    const seg = $("endpointAgents");
    if (seg) {
      seg.hidden = agents.length < 2;
      morph(seg, agents.map((a) => `<button type="button" data-ep-agent="${escapeHtml(a.id)}" aria-pressed="${a.id === agentId}">${escapeHtml(a.name || a.id)}</button>`).join(""));
    }
    const title = $("endpointPanelTitle");
    if (title) title.textContent = `端点检测 · ${name}`;
    const badge = $("epStatusBadge");
    if (badge) badge.textContent = view.badge;
    const brief = endpointBriefOf(view);
    const briefEl = $("endpointBrief");
    if (briefEl) {
      briefEl.className = `endpoint-brief state-${brief.tone}`;
      briefEl.textContent = brief.text;
    }
    const raw = $("endpoint");
    const output = view.endpoint.output || "无输出";
    if (raw && raw.textContent !== output) raw.textContent = output;
    paintTrend(view, name);
  }

  function render(status, agentView, viewFor) {
    const open = isOpen();
    if (!open) {
      wasOpen = false;
      return;
    }
    bind();
    if (!wasOpen) selected = null; // 每次打开都从全局诊断视角的 Agent 开始
    wasOpen = true;
    last = { status, agentView, viewFor };
    paint();
  }

  return { render };
}
