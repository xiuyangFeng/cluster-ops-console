// 端点检测弹层：指标 / 图表配置 / 结论文案的纯函数，以及弹层内切 Agent 的控制流（假 DOM）。
import assert from "node:assert/strict";
import test from "node:test";

import { fakeDialog, fakeDocument, fakeElement, flush } from "../app/test-support.mjs";
import {
  buildEndpointTrend, createEndpointPanel, endpointBriefOf, endpointCaption, endpointChartOptions, endpointHeroHtml, endpointStats, endpointStatsHtml,
  endpointViewOf, formatMs, quantileOf,
} from "./endpoint-panel.js";

const NOW = Date.parse("2026-10-03T18:30:00+08:00");
const MIN = 60_000;
// 每 90 秒一个样本，从 24 小时前排到现在
const sample = (index, extra = {}) => ({ ts: NOW - 24 * 60 * MIN + index * 90_000, ok: true, level: "ok", probeDurationMs: 300, latencyMs: 200, ...extra });

test("formatMs / quantileOf", () => {
  assert.deepEqual([0, 263.4, 999.6, 1160, 9999, 11600, 15002].map(formatMs), ["0ms", "263ms", "1s", "1.16s", "10s", "11.6s", "15s"]);
  assert.deepEqual([null, undefined, Number.NaN, -5, "x"].map(formatMs), ["—", "—", "—", "—", "—"]);
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.deepEqual([quantileOf(values, 0.5), quantileOf(values, 0.95), quantileOf(values, 0.99), quantileOf(values, 1), quantileOf(values, 0)], [50, 95, 99, 100, 1]);
  assert.equal(quantileOf([], 0.5), null);
  assert.equal(quantileOf([7], 0.99), 7);
});

test("buildEndpointTrend: 请求往返齐全时用它；可用率、分位数、99 分位截顶与超出量程的次数", () => {
  const samples = Array.from({ length: 200 }, (_, i) => sample(i, { latencyMs: 100 + i }));
  samples[10] = sample(10, { ok: false, level: "error", latencyMs: 10002 });
  samples[150] = sample(150, { ok: false, level: "error", latencyMs: 3017 });
  samples[199] = sample(199, { latencyMs: 15002 }); // 一次十几秒的慢请求：算进「最慢」，但不拉高纵轴
  const trend = buildEndpointTrend(samples, { nowMs: NOW });
  assert.equal(trend.metric, "latency");
  assert.deepEqual([trend.total, trend.failed], [200, 2]);
  assert.equal(trend.availability, 0.99);
  assert.equal(trend.slowest, 15002);
  assert.equal(trend.yMax, 500, "198 个成功值的 99 分位落在 298 → 取整到 500");
  assert.equal(trend.clipped, 1);
  assert.deepEqual([trend.median, trend.p95], [199, 290]);
  assert.equal(trend.lastFailureAt, samples[150].ts);
  assert.deepEqual([trend.t1, trend.t0], [NOW, NOW - 24 * 60 * MIN]);
  assert.equal(trend.intervalMs, 90_000);
  assert.equal(trend.points.length, 200);
  assert.deepEqual(trend.points[10], { ts: samples[10].ts, ok: false, value: 10002 });
});

test("buildEndpointTrend: 请求往返记录不全（Codex 旧样本）时统一用整次检测耗时，不把两个口径混在一张图里", () => {
  const samples = Array.from({ length: 100 }, (_, i) => sample(i, { latencyMs: i < 40 ? null : 180, probeDurationMs: 260 }));
  const trend = buildEndpointTrend(samples, { nowMs: NOW });
  assert.equal(trend.metric, "duration");
  assert.equal(trend.partialLatency, true);
  assert.equal(trend.median, 260);
  assert.equal(trend.yMax, 500);
  // 全都没有请求往返
  const legacy = buildEndpointTrend(samples.map((s) => ({ ...s, latencyMs: null })), { nowMs: NOW });
  assert.deepEqual([legacy.metric, legacy.partialLatency], ["duration", false]);
  // 个别成功样本缺往返耗时（<5%）不影响口径，那几个点不画
  const mostly = buildEndpointTrend(samples.map((s, i) => ({ ...s, latencyMs: i === 3 ? null : 180 })), { nowMs: NOW });
  assert.equal(mostly.metric, "latency");
  assert.equal(mostly.points[3].value, null);
});

test("buildEndpointTrend: 没有样本返回 null；全部失败时不出分位数，纵轴给默认量程；乱序输入按时间排", () => {
  assert.equal(buildEndpointTrend([], { nowMs: NOW }), null);
  assert.equal(buildEndpointTrend(undefined, { nowMs: NOW }), null);
  assert.equal(buildEndpointTrend([{ ok: true }, null], { nowMs: NOW }), null);
  const failed = buildEndpointTrend([sample(1, { ok: false, latencyMs: null }), sample(0, { ok: false, latencyMs: null })], { nowMs: NOW });
  assert.deepEqual([failed.availability, failed.median, failed.p95, failed.slowest, failed.yMax, failed.clipped], [0, null, null, null, 1000, 0]);
  assert.ok(failed.points[0].ts < failed.points[1].ts);
  // 最新样本比本机时钟还新（时钟偏差）时右端取样本时刻
  assert.equal(buildEndpointTrend([sample(0, { ts: NOW + 5000 })], { nowMs: NOW }).t1, NOW + 5000);
});

test("endpointStats: 五项指标的文案与语气；失败时刻按北京时间，跨天带日期", () => {
  const samples = Array.from({ length: 1000 }, (_, i) => sample(i % 960, { ts: NOW - (1000 - i) * 80_000, latencyMs: 250 }));
  samples[990] = { ...samples[990], ok: false, latencyMs: 3000 };
  const stats = endpointStats(buildEndpointTrend(samples, { nowMs: NOW }));
  assert.deepEqual(stats.map((s) => s.label), ["可用率", "中位", "95% 以内", "最慢", "失败"]);
  assert.deepEqual(stats[0], { label: "可用率", value: "99.9%", hint: "1000 次检测", tone: "" });
  assert.deepEqual([stats[1].value, stats[1].hint, stats[2].value, stats[3].value, stats[3].hint], ["250ms", "请求往返", "250ms", "250ms", ""]);
  assert.deepEqual(stats[4], { label: "失败", value: "1 次", hint: "最近 18:16", tone: "warn" });

  const bad = Array.from({ length: 200 }, (_, i) => sample(i, { latencyMs: null, probeDurationMs: i === 199 ? 20000 : 300 }));
  for (const i of [0, 1, 2, 3, 4, 5]) bad[i] = { ...bad[i], ok: false };
  const badStats = endpointStats(buildEndpointTrend(bad, { nowMs: NOW }));
  assert.deepEqual([badStats[0].value, badStats[0].tone], ["97.0%", "critical"]);
  assert.equal(badStats[1].hint, "整次检测");
  assert.deepEqual([badStats[3].value, badStats[3].hint], ["20s", "1 次超出图表量程"]);
  assert.equal(badStats[4].hint, "最近 10.2 18:37", "昨天的失败带上日期");

  const clean = endpointStats(buildEndpointTrend([sample(0), sample(1)], { nowMs: NOW }));
  assert.deepEqual([clean[0].value, clean[0].tone, clean[4].value, clean[4].hint, clean[4].tone], ["100%", "", "0 次", "", ""]);
  // 99.95% 以上有失败时不显示成 100.0%
  const many = Array.from({ length: 5000 }, (_, i) => sample(0, { ts: NOW - (5000 - i) * 1000 }));
  many[0] = { ...many[0], ok: false };
  assert.equal(endpointStats(buildEndpointTrend(many, { nowMs: NOW }))[0].value, "99.9%");

  const html = endpointStatsHtml([{ label: "可用率", value: "<97%>", hint: 'a"b', tone: "critical" }, { label: "中位", value: "1s", hint: "", tone: "" }]);
  assert.equal(html, '<div class="ep-stat" data-tone="critical"><span class="ep-stat-label">可用率</span><span class="ep-stat-value">&lt;97%&gt;</span><span class="ep-stat-hint">a&quot;b</span></div><div class="ep-stat"><span class="ep-stat-label">中位</span><span class="ep-stat-value">1s</span><span class="ep-stat-hint"></span></div>');
});

test("endpointCaption: 覆盖时长、检测间隔、图里画的是哪个量", () => {
  const full = buildEndpointTrend(Array.from({ length: 960 }, (_, i) => sample(i)), { nowMs: NOW });
  assert.equal(endpointCaption(full, "Claude API"), "近 24 小时 · 约每 90 秒检测一次 · 集群经隧道请求 Claude API 的往返耗时");
  const fresh = buildEndpointTrend(Array.from({ length: 20 }, (_, i) => sample(940 + i, { latencyMs: null })), { nowMs: NOW });
  assert.equal(endpointCaption(fresh, "ChatGPT Codex API"), "近 30 分钟 · 约每 90 秒检测一次 · 这里是整次检测的耗时（含本机到集群的 SSH 往返）");
  const mixed = buildEndpointTrend(Array.from({ length: 200 }, (_, i) => sample(760 + i, { latencyMs: i < 150 ? null : 120 })), { nowMs: NOW });
  assert.equal(endpointCaption(mixed, "ChatGPT Codex API"), "近 5 小时 · 约每 90 秒检测一次 · 这里是整次检测的耗时（含本机到集群的 SSH 往返）；请求往返耗时刚开始记录，覆盖满这段时间后改用它");
  const slow = buildEndpointTrend([sample(0, { ts: NOW - 20 * MIN }), sample(0, { ts: NOW - 15 * MIN }), sample(0, { ts: NOW - 10 * MIN })], { nowMs: NOW });
  assert.match(endpointCaption(slow, ""), /^近 20 分钟 · 约每 5 分钟检测一次 · 集群经隧道请求 接口 的往返耗时$/);
  assert.equal(endpointCaption(buildEndpointTrend([sample(959)], { nowMs: NOW }), "X").split(" · ").length, 2, "只有一个样本时不写检测间隔");
});

test("endpointChartOptions: 折线只连成功的点并压到量程内；失败标记带、三角标、整点刻度与悬停读数", () => {
  const samples = Array.from({ length: 200 }, (_, i) => sample(i * 4, { latencyMs: 200 + (i % 7) }));
  samples[50] = { ...samples[50], ok: false, latencyMs: 10002 };
  samples[120] = { ...samples[120], ok: false, latencyMs: null };
  samples[60] = { ...samples[60], latencyMs: 9000 };
  const trend = buildEndpointTrend(samples, { nowMs: NOW });
  const options = endpointChartOptions(trend, { label: "Codex 近 24 小时端点延迟" });
  assert.equal(options.yMax, 250);
  assert.deepEqual(options.yTicks, [0, 62.5, 125, 187.5, 250]);
  assert.deepEqual([0, 62.5, 250, 1500].map(options.yFormat), ["0", "63ms", "250ms", "1.5s"]);
  assert.deepEqual(options.x, [NOW - 24 * 60 * MIN, NOW]);
  assert.equal(options.series[0].points.length, 198);
  assert.equal(Math.max(...options.series[0].points.map((p) => p[1])), 250, "9 秒那次压在上沿");
  assert.deepEqual(options.xTicks.map((t) => t.label), ["20:00", "0 点", "04:00", "08:00", "12:00", "16:00", "现在"]);
  assert.deepEqual(options.xTicks.at(-1), { t: NOW, label: "现在", anchor: "end" });

  const ctx = { W: 846, H: 220, pad: options.pad, x: (t) => 46 + ((t - options.x[0]) / (options.x[1] - options.x[0])) * 786 };
  const extra = options.extra(ctx);
  assert.match(extra, /<rect class="ep-rail" x="46" y="186" width="786" height="6" rx="2"\/>/);
  assert.equal(extra.split('class="ep-fail"').length - 1, 2);
  assert.equal(extra.split('class="ep-clip"').length - 1, 1);
  assert.match(extra, />失败<\/text>/);

  const { hover } = options;
  assert.equal(hover.xs.length, 200);
  assert.deepEqual(hover.dots(0), [{ v: 200 }]);
  assert.deepEqual(hover.dots(60), [{ v: 250 }]);
  assert.deepEqual(hover.dots(50), []);
  assert.deepEqual(hover.tip(0), { title: "10.2 18:30", rows: [{ label: "请求往返", value: "200ms" }] });
  assert.deepEqual(hover.tip(60).rows, [{ label: "请求往返", value: "9s" }], "提示框里写真实值，不是压顶后的值");
  assert.deepEqual(hover.tip(50).rows, [{ tone: "fail", label: "检测失败", value: "等了 10s" }]);
  assert.deepEqual(hover.tip(120).rows, [{ tone: "fail", label: "检测失败", value: "" }]);
  // 指针在标记带上：吸到附近的失败刻度；离得远或在图区里则交回「最近的点」
  const failX = ctx.x(samples[50].ts);
  assert.equal(hover.resolve({ t: samples[51].ts, px: failX + 5, py: 190, ctx }), 50);
  assert.equal(hover.resolve({ t: samples[80].ts, px: ctx.x(samples[80].ts), py: 190, ctx }), null);
  assert.equal(hover.resolve({ t: samples[51].ts, px: failX + 5, py: 100, ctx }), null);
  const noFail = endpointChartOptions(buildEndpointTrend([sample(0), sample(1)], { nowMs: NOW }));
  assert.equal(noFail.hover.resolve({ t: 0, px: 50, py: 190, ctx }), null);
});

const STATUS = {
  activeAgentId: "codex",
  agents: [
    { id: "codex", name: "Codex", endpointLabel: "ChatGPT Codex API" },
    { id: "claude-codewing", name: "Claude CodeWing", endpointLabel: "Claude API" },
    { id: "zcode", name: "Zcode", endpointLabel: "Zcode 模型代理" },
  ],
  endpoint: { ok: true, output: "HTTP/2 405" },
  claudeEndpoint: { ok: true, target: "api.example.com:9443", latencyMs: 134, output: "HTTP 401" },
  agentsStatus: { zcode: { endpoint: { ok: true, output: "httpProxy=http://127.0.0.1:7891 期望 http://127.0.0.1:7891" } } },
};
// 以某个 Agent 为视角的结论（render-pipeline 里由 getActiveAgentView 提供；这里给一个同形状的替身）
const viewFor = (status) => (agentId) => {
  const agent = status.agents.find((a) => a.id === agentId);
  return agentId === "claude-codewing"
    ? { agent, endpoint: { ok: status.claudeEndpoint.ok, output: status.claudeEndpoint.output }, endpointBadge: "Claude API 可达 · 134ms" }
    : { agent, endpoint: status.endpoint, endpointBadge: status.endpoint.ok ? "200 Connection Established" : "测试未通过" };
};

test("endpointViewOf / endpointBriefOf: 带探针的两个 Agent 取各自的结论；没有独立探针的读 agentsStatus，不串用 Codex 的结果", () => {
  const codex = endpointViewOf(STATUS, "codex", viewFor(STATUS));
  assert.deepEqual([codex.probeId, codex.badge, codex.endpoint.ok], ["endpoint", "200 Connection Established", true]);
  assert.deepEqual(endpointBriefOf(codex), { tone: "ok", text: "✓ API 端点连通性测试通过 (响应 HTTP 200/405)" });

  const claude = endpointViewOf(STATUS, "claude-codewing", viewFor(STATUS));
  assert.deepEqual([claude.probeId, claude.target, claude.endpoint.output], ["claude-endpoint", "api.example.com:9443", "HTTP 401"]);
  assert.equal(endpointBriefOf(claude).text, "✓ Claude API (api.example.com:9443) 经隧道代理可达，ReClaude 可复用远端 HTTP CONNECT 通道");

  const zcode = endpointViewOf(STATUS, "zcode", viewFor(STATUS));
  assert.deepEqual([zcode.probeId, zcode.badge, zcode.endpoint.output], [null, "检查通过", "httpProxy=http://127.0.0.1:7891 期望 http://127.0.0.1:7891"]);
  assert.deepEqual(endpointBriefOf(zcode), { tone: "ok", text: "✓ Zcode 模型代理 检查通过" });

  const down = { ...STATUS, endpoint: { ok: false, output: "curl: (28) timed out" }, agentsStatus: { zcode: { endpoint: { ok: false, output: "httpProxy=(未设置) 期望 x" } } } };
  assert.deepEqual(endpointBriefOf(endpointViewOf(down, "codex", viewFor(down))), { tone: "bad", text: "✗ ChatGPT Codex API 握手失败，请求无法到达目标" });
  const zcodeDown = endpointViewOf(down, "zcode", viewFor(down));
  assert.deepEqual([zcodeDown.badge, endpointBriefOf(zcodeDown).text], ["检查未通过", "✗ Zcode 模型代理 检查未通过"]);

  // 没装 / 还没检查：ok 为 null，没有输出
  const unknown = endpointViewOf({ ...STATUS, agentsStatus: {} }, "zcode", viewFor(STATUS));
  assert.deepEqual([unknown.endpoint.ok, unknown.badge, endpointBriefOf(unknown).text], [null, "尚未检查", "暂无测试数据"]);
  // 状态里查不到的 Agent id 不抛错
  assert.equal(endpointViewOf(STATUS, "ghost", viewFor(STATUS)).agent.name, "ghost");
  assert.equal(endpointViewOf(null, "ghost", viewFor(STATUS)).badge, "尚未检查");
});

function panelHarness({ history = { samples: [sample(958), sample(959)] }, skin = "" } = {}) {
  const dialog = fakeDialog();
  const ids = ["endpointAgents", "endpointStats", "endpointChart", "endpointEmpty", "endpointCaption", "endpointPanelTitle", "epStatusBadge", "endpointBrief", "endpoint"];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  elements.endpointContent = fakeElement({ parent: dialog });
  const requests = [];
  const charts = [];
  const starfields = [];
  const doc = fakeDocument(elements);
  if (skin) doc.body.dataset.skin = skin;
  const panel = createEndpointPanel({
    doc,
    isOpen: () => dialog.open,
    now: () => NOW,
    getHistory: async ({ id }) => {
      requests.push(id);
      if (history instanceof Error) throw history;
      return history;
    },
    morph: (el, html) => { el.innerHTML = html; },
    createChart: () => {
      const chart = { updates: [], cleared: 0, update(options) { chart.updates.push(options); return true; }, clear() { chart.cleared += 1; } };
      charts.push(chart);
      return chart;
    },
    createStarfield: () => {
      const chart = { kind: "starfield", updates: [], destroyed: 0, update(options) { chart.updates.push(options); return true; }, clear() {}, destroy() { chart.destroyed += 1; } };
      starfields.push(chart);
      return chart;
    },
  });
  const render = (status = STATUS) => panel.render(status, viewFor(status)(status.activeAgentId), viewFor(status));
  const pick = (agentId) => elements.endpointAgents.dispatch("click", { target: fakeElement({ dataset: { epAgent: agentId } }) });
  return { dialog, doc, elements, requests, charts, starfields, render, pick };
}

test("createEndpointPanel: 弹层关着时不碰 DOM 也不拉记录；打开后画全局视角的 Agent", async () => {
  const h = panelHarness();
  h.render();
  assert.deepEqual(h.requests, []);
  assert.equal(h.elements.endpointPanelTitle.textContent, "");

  h.dialog.showModal();
  h.render();
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测 · Codex");
  assert.equal(h.elements.epStatusBadge.textContent, "200 Connection Established");
  assert.equal(h.elements.endpoint.textContent, "HTTP/2 405");
  assert.equal(h.elements.endpointBrief.className, "endpoint-brief state-ok");
  assert.match(h.elements.endpointAgents.innerHTML, /data-ep-agent="codex" aria-pressed="true">Codex</);
  assert.match(h.elements.endpointAgents.innerHTML, /data-ep-agent="zcode" aria-pressed="false">Zcode</);
  assert.equal(h.elements.endpointEmpty.textContent, "正在读取检测记录…");
  assert.deepEqual(h.requests, ["endpoint"]);
  await flush();
  assert.equal(h.elements.endpointEmpty.hidden, true);
  assert.equal(h.elements.endpointStats.hidden, false);
  assert.match(h.elements.endpointStats.innerHTML, /可用率/);
  assert.match(h.elements.endpointCaption.textContent, /往返耗时$/);
  assert.equal(h.charts[0].updates.length, 1);
  // 同一份记录下一轮渲染不重画、不重拉
  h.render();
  h.render();
  assert.equal(h.charts[0].updates.length, 1);
  assert.deepEqual(h.requests, ["endpoint"]);
  // 端点输出变了（探针又跑了一轮）才重拉
  h.render({ ...STATUS, endpoint: { ok: true, output: "HTTP/2 405 again" } });
  assert.deepEqual(h.requests, ["endpoint", "endpoint"]);
});

test("createEndpointPanel: 弹层内切 Agent 只换显示（结论条、报文、延迟图一起换），不改全局视角；重开回到全局视角", async () => {
  const h = panelHarness();
  h.dialog.showModal();
  h.render();
  await flush();

  await h.pick("claude-codewing");
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测 · Claude CodeWing");
  assert.equal(h.elements.epStatusBadge.textContent, "Claude API 可达 · 134ms");
  assert.equal(h.elements.endpoint.textContent, "HTTP 401");
  assert.match(h.elements.endpointBrief.textContent, /Claude API \(api\.example\.com:9443\)/);
  assert.match(h.elements.endpointAgents.innerHTML, /data-ep-agent="claude-codewing" aria-pressed="true"/);
  assert.deepEqual(h.requests, ["endpoint", "claude-endpoint"], "只发读请求：各自的检测记录");
  assert.equal(STATUS.activeAgentId, "codex");
  await flush();
  assert.equal(h.charts[0].updates.length, 2);
  // 后续轮询渲染（全局视角仍是 Codex）不把弹层拉回去
  h.render();
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测 · Claude CodeWing");

  // 没有独立探针的 Agent：空态，不拉记录
  await h.pick("zcode");
  assert.equal(h.elements.endpointEmpty.textContent, "Zcode 没有单独的端点探针，暂无延迟记录。");
  assert.deepEqual([h.elements.endpointStats.hidden, h.elements.endpointChart.hidden, h.elements.endpointCaption.hidden, h.elements.endpointEmpty.hidden], [true, true, true, false]);
  assert.equal(h.elements.endpoint.textContent, "httpProxy=http://127.0.0.1:7891 期望 http://127.0.0.1:7891");
  assert.equal(h.requests.length, 2);

  // 关掉再开：回到全局诊断视角的 Agent
  h.dialog.close();
  assert.equal(h.charts[0].cleared, 1);
  h.dialog.showModal();
  h.render();
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测 · Codex");
  // 点选的 Agent 之后从配置里消失：退回全局视角
  await h.pick("zcode");
  h.render({ ...STATUS, agents: STATUS.agents.slice(0, 2) });
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测 · Codex");
});

test("createEndpointPanel: 没有记录 / 读取失败的空态；只有一个 Agent 时不显示切换", async () => {
  const empty = panelHarness({ history: { samples: [] } });
  empty.dialog.showModal();
  empty.render();
  await flush();
  assert.equal(empty.elements.endpointEmpty.textContent, "Codex 近 24 小时还没有端点检测记录。");
  assert.equal(empty.charts.length, 0);

  const failing = panelHarness({ history: new Error("offline") });
  failing.dialog.showModal();
  failing.render({ ...STATUS, agents: STATUS.agents.slice(0, 1) });
  await flush();
  assert.equal(failing.elements.endpointEmpty.textContent, "检测记录读取失败，稍后会自动重试。");
  assert.equal(failing.elements.endpointAgents.hidden, true);
  // 失败后不在每一轮渲染里反复重试
  failing.render({ ...STATUS, agents: STATUS.agents.slice(0, 1) });
  assert.equal(failing.requests.length, 1);
});

test("createEndpointPanel: 没有启用的 Agent（agentView 为 null）→ 空态，不拉记录、不画图", async () => {
  const h = panelHarness();
  h.dialog.showModal();
  h.render({ activeAgentId: "", agents: [], endpoint: { ok: false, output: "" } });
  await flush();
  assert.deepEqual(h.requests, []);
  assert.equal(h.elements.endpointPanelTitle.textContent, "端点检测");
  assert.equal(h.elements.epStatusBadge.textContent, "未启用");
  assert.match(h.elements.endpointBrief.textContent, /没有启用的 Agent/);
  assert.equal(h.elements.endpointAgents.hidden, true);
  assert.equal(h.elements.endpointChart.hidden, true);
  assert.equal(h.charts.length, 0);
});

test("createEndpointPanel: 星空版 / 纸面版先给结论读数头、画星点图并附图例；换回简洁版销毁它改画折线、读数回到五格", async () => {
  const h = panelHarness({ skin: "starry", history: { samples: [sample(958), sample(959, { ok: false, level: "critical", latencyMs: null })] } });
  h.dialog.showModal();
  h.render();
  await flush();
  assert.equal(h.charts.length, 0, "星空版不建折线图");
  assert.equal(h.starfields.length, 1);
  const { model, metricName } = h.starfields[0].updates[0];
  assert.deepEqual([model.stars.length, model.failures.length], [1, 1]);
  assert.equal(metricName, "请求往返");
  const hero = h.elements.endpointStats.innerHTML;
  assert.match(hero, /class="ep-hero" data-tone="ok"/);
  assert.match(hero, /<span class="ep-now-word">可达<\/span>/);
  assert.match(hero, /API 端点连通性测试通过/, "结论条的原话搬进读数头，去掉 ✓");
  assert.match(hero, /最近一次检测 18:28 · 失败/);
  assert.equal((hero.match(/class="ep-stat"/g) || []).length, 4, "最慢写在图上，读数头只有四格");
  assert.doesNotMatch(hero, /最慢/);
  assert.match(h.elements.endpointCaption.innerHTML, /纵轴为对数刻度/);
  assert.match(h.elements.endpointCaption.innerHTML, /class="sf-key"><i class="sf-key-fail"><\/i>失败/);
  // 同一份记录不重画
  h.render();
  assert.equal(h.starfields[0].updates.length, 1);
  // 换皮肤：销毁星点图、改建折线图，读数与图注回到简洁版
  h.doc.body.dataset.skin = "classic";
  h.render();
  assert.equal(h.starfields[0].destroyed, 1);
  assert.equal(h.charts.length, 1);
  assert.equal(h.charts[0].updates.length, 1);
  assert.doesNotMatch(h.elements.endpointStats.innerHTML, /ep-hero/);
  assert.match(h.elements.endpointStats.innerHTML, /最慢/);
  assert.match(h.elements.endpointCaption.textContent, /往返耗时$/);
});

test("endpointHeroHtml: 不可达 / 暂无结论的措辞与语气", () => {
  const trend = { points: [{ ts: NOW - 60_000, ok: true, value: 180 }], t1: NOW, total: 1, failed: 0, availability: 1, median: 180, p95: 180, slowest: 180, clipped: 0, metric: "latency", lastFailureAt: null };
  const bad = endpointHeroHtml({ agent: { id: "codex", endpointLabel: "ChatGPT Codex API" }, endpoint: { ok: false, output: "curl: (7)" }, probeId: "endpoint", target: "" }, trend);
  assert.match(bad, /data-tone="bad"/);
  assert.match(bad, /<span class="ep-now-word">不可达<\/span><span class="ep-now-detail">ChatGPT Codex API 握手失败，请求无法到达目标<\/span>/);
  assert.match(bad, /最近一次检测 18:29 · 180ms/);
  const idle = endpointHeroHtml({ agent: { id: "codex" }, endpoint: { ok: null, output: "" }, probeId: "endpoint", target: "" }, trend);
  assert.match(idle, /data-tone="idle"/);
  assert.match(idle, /暂无结论<\/span><span class="ep-now-last">/, "没有结论时不重复「暂无测试数据」");
});
