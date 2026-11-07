import assert from "node:assert/strict";
import test from "node:test";

// diagnostics.js 的 DOM 引用全部惰性获取（createElementLookup，无 document 返回 null），Node 下可安全导入纯函数。
import {
  normalizeHistoryTransition,
  summarizeHistoryEntries,
  formatHistorySummary,
  buildHistoryRowHtml,
} from "./render/diagnostics.js";

const T = new Date("2026-08-30T22:00:00").getTime();
const MIN = 60e3;

const transition = (offsetMin, from, to, extra = {}) => ({
  type: "transition",
  ts: T + offsetMin * MIN,
  key: "channel",
  layer: "channel",
  from,
  to,
  reason: "",
  ...extra,
});

// ---- normalizeHistoryTransition ----

test("normalizeHistoryTransition: 结构化字段原样归一，layer 缺失时按 key 推断", () => {
  const t = normalizeHistoryTransition({ ts: T, key: "agent:codex", from: "ok", to: "warn", reason: "slow" });
  assert.deepEqual(t, { ts: T, key: "agent:codex", from: "ok", to: "warn", reason: "slow", layer: "agents" });
});

test("normalizeHistoryTransition: 兼容 'channel: ok -> error reason=...' 消息体条目", () => {
  const t = normalizeHistoryTransition({ ts: T, message: "channel: ok -> error reason=tunnel down" });
  assert.equal(t.key, "channel");
  assert.equal(t.from, "ok");
  assert.equal(t.to, "error");
  assert.equal(t.reason, "tunnel down");
  assert.equal(t.layer, "channel");
});

test("normalizeHistoryTransition: 无法解析的条目返回 null", () => {
  assert.equal(normalizeHistoryTransition(null), null);
  assert.equal(normalizeHistoryTransition({ ts: T, message: "just some log line" }), null);
  assert.equal(normalizeHistoryTransition({ ts: T, type: "sample", key: "server-01", cpu: 10 }), null);
});

// ---- summarizeHistoryEntries：断开次数 / 最长恢复 ----

test("summarize: 两段独立故障——各自计一次断开，最长恢复取较长段", () => {
  const summary = summarizeHistoryEntries([
    transition(0, "ok", "error"),
    transition(5, "error", "ok"), // 第一段恢复 5 分钟
    transition(60, "ok", "error"),
    transition(72, "error", "ok"), // 第二段恢复 12 分钟
  ]);
  assert.equal(summary.disconnects, 2);
  assert.equal(summary.maxRecoveryMs, 12 * MIN);
  assert.equal(summary.unrecovered, false);
});

test("summarize: error→warn→error 属同一故障段，恢复以回到 ok 为准", () => {
  const summary = summarizeHistoryEntries([
    transition(0, "ok", "error"),
    transition(3, "error", "warn"),
    transition(6, "warn", "error"),
    transition(10, "error", "ok"),
  ]);
  assert.equal(summary.disconnects, 1);
  assert.equal(summary.maxRecoveryMs, 10 * MIN);
});

test("summarize: 当日未恢复的故障不计入最长恢复，但置 unrecovered 标记", () => {
  const summary = summarizeHistoryEntries([
    transition(0, "ok", "error"),
    transition(5, "error", "ok"),
    transition(30, "ok", "error"), // 直到当日结束未回 ok
  ]);
  assert.equal(summary.disconnects, 2);
  assert.equal(summary.maxRecoveryMs, 5 * MIN);
  assert.equal(summary.unrecovered, true);
});

test("summarize: 条目乱序输入也按时间排序后聚合", () => {
  const summary = summarizeHistoryEntries([
    transition(5, "error", "ok"),
    transition(0, "ok", "error"),
  ]);
  assert.equal(summary.disconnects, 1);
  assert.equal(summary.maxRecoveryMs, 5 * MIN);
});

test("summarize: 信号条目计数（info 除外），采样与非通道迁移不影响断开统计", () => {
  const summary = summarizeHistoryEntries([
    { type: "signal", ts: T, severity: "warn", signalId: "stall", title: "响应停滞" },
    { type: "signal", ts: T + MIN, severity: "error", signalId: "banned", title: "账号异常" },
    { type: "signal", ts: T + 2 * MIN, severity: "info", signalId: "probe-sample", title: "采样" },
    { type: "sample", ts: T + 3 * MIN, key: "server-01", cpu: 10, ram: 40, disk: 55, channelOk: true },
    { type: "transition", ts: T + 4 * MIN, key: "agent:codex", from: "ok", to: "error" },
  ]);
  assert.equal(summary.signals, 2);
  assert.equal(summary.disconnects, 0);
  assert.equal(summary.maxRecoveryMs, null);
});

test("summarize: 消息体形式的通道迁移条目同样参与断开/恢复聚合", () => {
  const summary = summarizeHistoryEntries([
    { ts: T, message: "channel: ok -> error reason=tunnel down" },
    { ts: T + 7 * MIN, message: "channel: error -> ok" },
  ]);
  assert.equal(summary.disconnects, 1);
  assert.equal(summary.maxRecoveryMs, 7 * MIN);
});

// ---- formatHistorySummary ----

test("formatHistorySummary: 完整摘要 'N 次断开 · 最长恢复 X 分钟 · 卡顿信号 M 次'", () => {
  assert.equal(
    formatHistorySummary({ disconnects: 3, maxRecoveryMs: 12 * MIN, signals: 5 }),
    "3 次断开 · 最长恢复 12 分钟 · 卡顿信号 5 次",
  );
  // 分钟一位小数；秒级恢复不四舍五入成 0
  assert.equal(
    formatHistorySummary({ disconnects: 1, maxRecoveryMs: 90e3, signals: 0 }),
    "1 次断开 · 最长恢复 1.5 分钟 · 卡顿信号 0 次",
  );
  assert.match(formatHistorySummary({ disconnects: 1, maxRecoveryMs: 1000, signals: 0 }), /最长恢复 0\.1 分钟/);
});

test("formatHistorySummary: 无恢复段省略中段；未恢复标注；全空日给全零文案", () => {
  assert.equal(
    formatHistorySummary({ disconnects: 0, maxRecoveryMs: null, signals: 0 }),
    "0 次断开 · 卡顿信号 0 次",
  );
  assert.equal(
    formatHistorySummary({ disconnects: 1, maxRecoveryMs: null, signals: 2, unrecovered: true }),
    "1 次断开 · 当日未恢复 · 卡顿信号 2 次",
  );
  assert.equal(formatHistorySummary(), "0 次断开 · 卡顿信号 0 次");
  assert.equal(formatHistorySummary(summarizeHistoryEntries([])), "0 次断开 · 卡顿信号 0 次");
});

// ---- buildHistoryRowHtml：插值转义 ----

test("buildHistoryRowHtml: 迁移行复用时间线样式类，reason 注入被转义", () => {
  const html = buildHistoryRowHtml(transition(0, "ok", "error", { reason: '<img src=x onerror="alert(1)">' }));
  assert.match(html, /timeline-dot state-error/);
  assert.match(html, /timeline-transition/);
  assert.ok(!html.includes("<img"), "reason 中的 HTML 必须被转义");
  assert.match(html, /&lt;img/);
});

test("buildHistoryRowHtml: 信号行按 severity 着色，title 转义；无法解析条目返回空串", () => {
  const html = buildHistoryRowHtml({ type: "signal", ts: T, severity: "error", category: "account", title: "<b>bad</b>" });
  assert.match(html, /timeline-dot state-error/);
  assert.match(html, /信号/);
  assert.ok(!html.includes("<b>"));
  assert.equal(buildHistoryRowHtml({ ts: T, message: "nothing" }), "");
});

test("buildHistoryRowHtml: 时刻按北京时间的 24 小时制（与本机时区、系统区域无关），缺时间戳显示 --:--:--", () => {
  const morning = Date.parse("2026-08-30T09:05:07+08:00");
  const evening = Date.parse("2026-08-30T13:05:07Z");
  assert.match(buildHistoryRowHtml(transition(0, "ok", "error", { ts: morning })), /<span class="timeline-time">09:05:07<\/span>/);
  assert.match(buildHistoryRowHtml({ type: "signal", ts: evening, severity: "warn" }), /<span class="timeline-time">21:05:07<\/span>/);
  assert.match(buildHistoryRowHtml({ type: "signal", severity: "warn" }), /<span class="timeline-time">--:--:--<\/span>/);
});

// ---- 界面用名：层名 / 对象名 / 原因；状态基线条目不进清单与摘要 ----

const NAMES = {
  activeServerId: "server-01",
  serversBrief: { "server-01": { displayName: "主集群服务器 (myserver)" }, "server-aliyun": { displayName: "阿里云服务器 (vpn-aliyun)" } },
  agents: [{ id: "claude-codewing", name: "Claude CodeWing" }],
};

test("buildHistoryRowHtml: 层名、对象名、原因换成界面用语，内部键与原因原文留在 title 里", () => {
  const context = { status: NAMES, viewAt: () => "server-01" };
  const agent = buildHistoryRowHtml(transition(0, "ok", "warn", { key: "agent:claude-codewing", layer: "agents", reason: "degraded" }), context);
  assert.match(agent, /<span class="timeline-layer">Agent<\/span>/);
  assert.match(agent, /<span class="timeline-key" title="agent:claude-codewing">Claude CodeWing<\/span>/);
  assert.match(agent, /<span class="timeline-reason" title="degraded">降级<\/span>/);
  assert.match(agent, /正常 → 警告/);

  const tunnel = buildHistoryRowHtml(transition(0, "ok", "error", { key: "tunnel:server-aliyun", layer: "tunnels", reason: "SSH 隧道未开启" }), context);
  assert.match(tunnel, /<span class="timeline-layer">隧道<\/span>/, "tunnels 层有中文名");
  assert.match(tunnel, /title="tunnel:server-aliyun">阿里云</);
  assert.match(tunnel, /正常 → 故障/);
  assert.match(tunnel, /title="SSH 隧道未开启">SSH 隧道未开启</);

  const validation = buildHistoryRowHtml(transition(0, "warn", "ok", { key: "res:validation:server-01", layer: "resources", reason: "timeout after 25000ms" }), context);
  assert.match(validation, /<span class="timeline-layer">资源<\/span>/);
  assert.match(validation, />环境校验 · 主集群</);
  assert.match(validation, /title="timeout after 25000ms">检测超时（25 秒）</);
  assert.match(buildHistoryRowHtml(transition(0, "ok", "warn", { key: "res:server-aliyun", layer: "resources" }), context), /title="res:server-aliyun">阿里云</);

  // 通道：知道当时查看的是哪台就写上，不知道就只留层名（不再出现「通道 通道」）
  const channel = buildHistoryRowHtml(transition(0, "ok", "error"), context);
  assert.match(channel, /<span class="timeline-layer">通道<\/span>\s*<span class="timeline-key" title="channel">主集群<\/span>/);
  const blind = buildHistoryRowHtml(transition(0, "ok", "error"));
  assert.equal(blind.split("timeline-key").length - 1, 0);
  assert.equal(blind.split(">通道<").length - 1, 1);
  // 没带 layer 字段的条目按键推断层：隧道键归「隧道」，不再落进「资源」
  assert.match(buildHistoryRowHtml({ ts: T, key: "tunnel:server-aliyun", from: "ok", to: "error" }, context), /<span class="timeline-layer">隧道<\/span>/);
});

test("buildHistoryRowHtml: 信号类别用中文名；状态基线（levels）不出行", () => {
  assert.match(buildHistoryRowHtml({ type: "signal", ts: T, severity: "error", category: "gateway", title: "网关不健康" }), /<span class="timeline-key" title="gateway">网关<\/span>/);
  assert.match(buildHistoryRowHtml({ type: "signal", ts: T, severity: "warn", category: "weird<x>", title: "t" }), /title="weird&lt;x&gt;">weird&lt;x&gt;</);
  assert.equal(buildHistoryRowHtml({ type: "levels", ts: T, cause: "day", view: "server-01", levels: { channel: "ok" } }), "");
  assert.equal(buildHistoryRowHtml({ type: "levels", ts: T, cause: "stop", view: "", levels: {} }), "");
});

test("summarize: 状态基线条目不影响断开 / 恢复 / 信号统计", () => {
  const entries = [
    { type: "levels", ts: T - MIN, cause: "start", view: "server-01", levels: { channel: "error", "agent:codex": "ok" } },
    transition(0, "ok", "error"),
    { type: "levels", ts: T + MIN, cause: "view", view: "server-aliyun", levels: { channel: "ok" } },
    transition(5, "error", "ok"),
    { type: "levels", ts: T + 6 * MIN, cause: "stop", view: "", levels: {} },
  ];
  assert.deepEqual(summarizeHistoryEntries(entries), { disconnects: 1, maxRecoveryMs: 5 * MIN, signals: 0, unrecovered: false });
});
