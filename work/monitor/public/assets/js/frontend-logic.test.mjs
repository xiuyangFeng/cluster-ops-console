import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeBackoff, applyJitter, createSseClient } from "./sse.js";
import { sliceLogWindow, matchesFilter, logLevelClass, buildLogLineHtml } from "./logs-panel.js";
import { downsampleIndexes, buildSmoothPath, isDuplicateSample, pushSample, resetCharts, seriesFromMetrics } from "./charts.js";
import { formatRelativeTime, escapeHtml, shouldRefreshOnProbe } from "./store.js";
import {
  buildBridgeStabilityHtml,
  buildAgentHeadline,
  buildAgentCardModel,
  buildAppServerNotice,
  agentLatencyMs,
  recordBridgeSample,
  computeBridgeWindowDelta,
  setAgentDrawerExpanded,
  isAgentDrawerExpanded,
} from "./render/overview.js";
import { buildValidationSummary, buildValidationSummaryLabel, sortValidationItems } from "./render/validation-model.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, "../..");

// ---- SSE 指数退避 ----

test("computeBackoff: 1s → 2s → 4s ... 封顶 30s", () => {
  assert.equal(computeBackoff(0), 1000);
  assert.equal(computeBackoff(1000), 2000);
  assert.equal(computeBackoff(2000), 4000);
  assert.equal(computeBackoff(16000), 30000);
  assert.equal(computeBackoff(30000), 30000);
});

test("computeBackoff: 支持自定义 base/max", () => {
  assert.equal(computeBackoff(0, { base: 500, max: 4000 }), 500);
  assert.equal(computeBackoff(3000, { base: 500, max: 4000 }), 4000);
});

test("createSseClient: open 停止兜底、error 恢复兜底并退避重连", () => {
  const timers = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    timers.push({ fn, ms });
    return timers.length;
  };
  const instances = [];
  class FakeES {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      instances.push(this);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }
    close() {
      this.closed = true;
    }
    fire(type) {
      if (this.listeners[type]) this.listeners[type]();
    }
  }
  const fallbacks = [];
  try {
    const client = createSseClient({
      url: () => "/api/events",
      onFallbackChange: (active) => fallbacks.push(active),
      EventSourceImpl: FakeES,
    });
    client.start();
    assert.equal(instances.length, 1);
    instances[0].fire("open");
    assert.deepEqual(fallbacks, [false]); // 连通 → 关闭轮询
    instances[0].fire("error");
    assert.deepEqual(fallbacks, [false, true]); // 断开 → 恢复轮询
    assert.equal(timers.length, 1);
    assert.ok(timers[0].ms >= 800 && timers[0].ms <= 1200, `首次退避 1s ± 20% 抖动，实际 ${timers[0].ms}`);
    timers[0].fn(); // 触发重连
    assert.equal(instances.length, 2);
    instances[1].fire("error");
    assert.ok(timers[1].ms >= 1600 && timers[1].ms <= 2400, `第二次退避 2s ± 20% 抖动，实际 ${timers[1].ms}`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// ---- 日志切片 / 过滤 / 级别 ----

test("sliceLogWindow: 不超窗口全展示", () => {
  const r = sliceLogWindow([1, 2, 3], 300);
  assert.deepEqual(r.visible, [1, 2, 3]);
  assert.equal(r.omitted, 0);
});

test("sliceLogWindow: 超窗口保留最新并统计省略", () => {
  const entries = Array.from({ length: 305 }, (_, i) => i);
  const r = sliceLogWindow(entries, 300);
  assert.equal(r.visible.length, 300);
  assert.equal(r.visible[0], 5);
  assert.equal(r.visible[299], 304);
  assert.equal(r.omitted, 5);
});

test("matchesFilter: source/level 过滤", () => {
  const entry = { source: "supervisor", level: "warn", message: "x" };
  assert.equal(matchesFilter(entry, {}), true);
  assert.equal(matchesFilter(entry, { source: "supervisor" }), true);
  assert.equal(matchesFilter(entry, { source: "ops" }), false);
  assert.equal(matchesFilter(entry, { level: "warn" }), true);
  assert.equal(matchesFilter(entry, { level: "error" }), false);
});

test("matchesFilter: operationId 精确过滤", () => {
  const entry = { source: "ops", operationId: "op-a", message: "done" };
  assert.equal(matchesFilter(entry, { operationId: "op-a" }), true);
  assert.equal(matchesFilter(entry, { operationId: "op-b" }), false);
});

test("logLevelClass: 依据 level 与消息启发式着色", () => {
  assert.equal(logLevelClass({ level: "error" }), "log-error");
  assert.equal(logLevelClass({ level: "warn" }), "log-warn");
  assert.equal(logLevelClass({ level: "info", message: "task completed" }), "log-ok");
  assert.equal(logLevelClass({ level: "info", message: "connect failed" }), "log-error");
  assert.equal(logLevelClass({ level: "info", message: "auto starting supervisor" }), "log-warn");
});

// ---- 指标降采样 / 平滑路径 ----

test("downsampleIndexes: 不超上限原样返回全部索引", () => {
  assert.deepEqual(downsampleIndexes(3, 60), [0, 1, 2]);
});

test("downsampleIndexes: 降到目标点数并保留首尾", () => {
  const out = downsampleIndexes(500, 60);
  assert.equal(out.length, 60);
  assert.equal(out[0], 0);
  assert.equal(out[59], 499);
});

test("buildSmoothPath: 少于两点返回空路径", () => {
  assert.deepEqual(buildSmoothPath([50]), { line: "", area: "" });
});

test("buildSmoothPath: 生成 M/C 曲线与闭合面积", () => {
  const { line, area } = buildSmoothPath([0, 50, 100], 300, 24);
  assert.match(line, /^M /);
  assert.match(line, / C /);
  assert.match(area, /Z$/);
});

// ---- 采样去重门控（防止渲染频率冲掉 30 分钟播种历史）----

test("isDuplicateSample: 同 key 判重，无 key 不去重", () => {
  assert.equal(isDuplicateSample("100", "100"), true);
  assert.equal(isDuplicateSample(100, "100"), true); // 字符串化比较
  assert.equal(isDuplicateSample("100", "200"), false);
  assert.equal(isDuplicateSample(null, "100"), false); // 尚无历史 key
  assert.equal(isDuplicateSample("100", null), false); // 未提供 key → 不去重
  assert.equal(isDuplicateSample(null, null), false);
});

test("pushSample: dedupeKey 相同只入列一次，key 变化或 reset 后恢复", () => {
  resetCharts();
  const sample = { cpu: 10, ram: 20, disk: 30 };
  assert.equal(pushSample(sample, { dedupeKey: 1000 }), true); // 首次入列
  assert.equal(pushSample(sample, { dedupeKey: 1000 }), false); // 同一次探测重复 render → 跳过
  assert.equal(pushSample(sample, { dedupeKey: 1000 }), false);
  assert.equal(pushSample(sample, { dedupeKey: 2000 }), true); // 新一次探测 → 入列
  assert.equal(pushSample(sample), true); // 无 key（兼容路径）→ 不去重
  resetCharts();
  assert.equal(pushSample(sample, { dedupeKey: 2000 }), true); // reset 清空门控
});

test("pushSample: 未知项（null/undefined/NaN）只跳过该曲线，不以 0 入列、不抛错", () => {
  resetCharts();
  assert.equal(pushSample({ cpu: null, ram: 20, disk: undefined }, { dedupeKey: 3000 }), true);
  assert.equal(pushSample({ cpu: Number.NaN, ram: "x", disk: 30 }, { dedupeKey: 4000 }), true);
  resetCharts();
});

test("seriesFromMetrics: CPU 与 tile 同口径（busy → 归一化负载 → 旧 cpu），按 ts 升序，未知点逐条跳过", () => {
  const series = seriesFromMetrics([
    { ts: 3, cpu: 100, ram: 50, disk: 70, cpuBusyPct: null, loadNormalizedPct: 130, metricSchemaVersion: 1 },
    { ts: 1, cpu: 46, ram: 40, disk: 70 }, // 旧采集脚本样本：legacy cpu
    { ts: 2, cpu: 100, ram: 45, disk: 70, cpuBusyPct: 37.5, loadNormalizedPct: 130, metricSchemaVersion: 1 },
    { ts: 4, cpu: 100, ram: null, disk: 71, cpuBusyPct: null, loadNormalizedPct: null, metricSchemaVersion: 1 },
    null,
  ]);
  assert.deepEqual(series.cpu, { values: [46, 37.5, 130], ts: [1, 2, 3] });
  assert.deepEqual(series.ram, { values: [40, 45, 50], ts: [1, 2, 3] });
  assert.deepEqual(series.disk, { values: [70, 70, 70, 71], ts: [1, 2, 3, 4] });
  assert.deepEqual(seriesFromMetrics(undefined), { cpu: { values: [], ts: [] }, ram: { values: [], ts: [] }, disk: { values: [], ts: [] } });
});

// ---- 相对时间 ----

test("formatRelativeTime: 秒/分/小时/天", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(now, now), "刚刚");
  assert.equal(formatRelativeTime(now - 12_000, now), "12 秒前");
  assert.equal(formatRelativeTime(now - 3 * 60_000, now), "3 分钟前");
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), "2 小时前");
  assert.equal(formatRelativeTime(now - 3 * 86_400_000, now), "3 天前");
  assert.equal(formatRelativeTime(null, now), "");
});

test("formatRelativeTime: 时间线用例（刚刚 / 1 分钟前 / 2 小时前）", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(now, now), "刚刚");
  assert.equal(formatRelativeTime(now - 90_000, now), "1 分钟前");
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), "2 小时前");
});

test("escapeHtml: 转义危险字符", () => {
  assert.equal(escapeHtml('<b>&"\''), "&lt;b&gt;&amp;&quot;&#039;");
});

test("buildBridgeStabilityHtml: renders only canonical stages in approved order", () => {
  const html = buildBridgeStabilityHtml({
    "proxy<script>": { stage: "proxy<script>", ok: false, durationMs: 18, consecutiveFailures: 2 },
    "ssh-tunnel": { stage: "ssh-tunnel", ok: true, durationMs: 31, consecutiveFailures: 0, reconnects: 4, fastFailures: 1, backoffRemainingMs: 2000 },
    "local-proxy": { stage: "local-proxy", ok: true, durationMs: 5, consecutiveFailures: 0 },
  });
  assert.match(html, /桥接稳定性/);
  assert.doesNotMatch(html, /proxy<script>/);
  // 阶段名写界面用语，不露内部标识
  assert.doesNotMatch(html, /local-proxy|ssh-tunnel/);
  assert(html.indexOf("本地代理") < html.indexOf("SSH 隧道"));
  assert.match(html, /<span>本地代理 稳定 · 5ms<\/span>/);
  assert.match(html, /重连 4/);
  assert.match(html, /退避 2s/);
});

test("buildBridgeStabilityHtml: 没有任何一轮结果的段写「尚无数据」，不写成「失败×0」；0ms 不显示", () => {
  const html = buildBridgeStabilityHtml({
    "ssh-tunnel": { stage: "ssh-tunnel", ok: true, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: 1 },
    "remote-port": { stage: "remote-port", ok: false, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: null },
    "agent-endpoint": { stage: "agent-endpoint", ok: false, durationMs: 0, consecutiveFailures: 3, lastSuccessAt: 1 },
  });
  assert.match(html, /<span>SSH 隧道 稳定<\/span>/);
  assert.match(html, /<span>远端端口 尚无数据<\/span>/);
  assert.match(html, /<span>Agent 端点 失败×3<\/span>/);
  assert.doesNotMatch(html, /失败×0|0ms/);
  const reported = buildBridgeStabilityHtml({
    "remote-port": { stage: "remote-port", ok: true, durationMs: 412, consecutiveFailures: 0, lastSuccessAt: 5000, serverId: "server-01" },
  });
  assert.match(reported, /<span>远端端口 稳定 · 412ms<\/span>/);
});

// ---- v2.15 Agent 卡片：一句话根因 / 统一模板 / 计数窗口化 / 抽屉状态 ----

// 共享 fixture：截图里的真实降级场景（17 ok / 1 warn / 0 fail，端点可达 379ms）
function codexDegradedStatus(over = {}) {
  return {
    agentsStatus: {
      codex: {
        health: "degraded",
        summary: { ok: 17, fail: 0, warn: 1, notes: 2, raw: "17 ok | 2 notes | 1 warn | 0 fail degraded" },
        endpoint: { ok: true, output: "" },
      },
    },
    layers: { agents: { codex: { level: "warn", reason: "degraded", checkedAt: 987_000, expiry: null } } },
    bridgeStages: { "agent-endpoint": { stage: "agent-endpoint", ok: true, durationMs: 379, consecutiveFailures: 0 } },
    ...over,
  };
}

const codexAgent = { id: "codex", kind: "codex", name: "Codex", tag: "降级", health: "degraded", summary: "17 项通过，0 项失败" };
const claudeAgent = { id: "claude-codewing", kind: "reclaude", name: "Claude CodeWing", tag: "Ready", health: "ready", summary: "ReClaude 2.1 已就绪" };

test("buildAgentHeadline: 降级根因直用后端 detail.degradedReason；推不出时回落层级原因", () => {
  // 截图场景：0 fail / 1 warn → 后端适配器给出「Doctor 报 1 项警告」，前端原样展示
  const withReason = codexDegradedStatus();
  withReason.agentsStatus.codex.degradedReason = "降级：Doctor 报 1 项警告";
  const warnCase = buildAgentHeadline(withReason, codexAgent);
  assert.equal(warnCase.text, "降级：Doctor 报 1 项警告");
  assert.equal(warnCase.tone, "warn");

  // 适配器推不出（degradedReason 为 null）：层级原因兜底；层级原因只是 "degraded" 时提示展开详情
  const layerReason = codexDegradedStatus();
  layerReason.agentsStatus.codex.degradedReason = null;
  layerReason.layers.agents.codex.reason = "Doctor 输出无法解析";
  assert.equal(buildAgentHeadline(layerReason, codexAgent).text, "降级：Doctor 输出无法解析");
  assert.equal(buildAgentHeadline(codexDegradedStatus(), codexAgent).text, "降级：原因待定位（展开详情）");
});

test("buildAgentHeadline: ready 只给结论（延迟在标题行、可达在 chips，不再重复）；有提醒时透出计数", () => {
  // fixture 带 1 warn：warn 不再降级，但 ready 根因行要透出提醒计数（内容在抽屉）
  const ready = buildAgentHeadline(codexDegradedStatus(), { ...codexAgent, health: "ready" });
  assert.equal(ready.text, "就绪 · Doctor 1 项提醒");
  assert.equal(ready.tone, "ok");

  const cleanStatus = codexDegradedStatus();
  cleanStatus.agentsStatus.codex.summary = { ok: 18, fail: 0, warn: 0, notes: 1, raw: "" };
  assert.equal(buildAgentHeadline(cleanStatus, { ...codexAgent, health: "ready" }).text, "就绪");

  const noBridge = codexDegradedStatus({ bridgeStages: {} });
  assert.equal(buildAgentHeadline(noBridge, { ...codexAgent, health: "ready" }).text, "就绪 · Doctor 1 项提醒");

  const claudeReady = {
    agentsStatus: { "claude-codewing": { health: "ready", gatewayOk: true, loggedIn: true, version: "2.1" } },
    claudeEndpoint: { ok: true, latencyMs: 320, target: "x" },
    layers: { agents: {} },
  };
  assert.equal(buildAgentHeadline(claudeReady, claudeAgent).text, "就绪");
});

test("buildAgentHeadline: claude 降级根因同样直用后端 degradedReason", () => {
  const base = {
    agentsStatus: { "claude-codewing": { health: "degraded", gatewayOk: false, degradedReason: "降级：Claude API 端点不可达" } },
    claudeEndpoint: { ok: false, output: "" },
    layers: { agents: {} },
  };
  const degradedClaude = { ...claudeAgent, health: "degraded" };
  assert.equal(buildAgentHeadline(base, degradedClaude).text, "降级：Claude API 端点不可达");
});

test("buildAgentHeadline: error 家族（down 态）/ waiting / 熔断 / 凭证过期", () => {
  const bare = { agentsStatus: {}, layers: { agents: {} } };
  assert.equal(buildAgentHeadline(bare, { ...claudeAgent, health: "revoked" }).tone, "error");
  assert.match(buildAgentHeadline(bare, { ...claudeAgent, health: "revoked" }).text, /设备已被解绑/);
  assert.match(buildAgentHeadline(bare, { ...claudeAgent, health: "banned" }).text, /账号被封禁/);
  assert.match(buildAgentHeadline(bare, { ...claudeAgent, health: "missing" }).text, /未检测到运行环境/);

  const waiting = buildAgentHeadline(bare, { ...codexAgent, health: "waiting" });
  assert.equal(waiting.tone, "idle");
  assert.match(waiting.text, /检测中/);

  // 通道熔断：health 是旧值也不能当真
  const skipped = { agentsStatus: {}, layers: { agents: { codex: { level: "skipped", reason: "通道异常，熔断跳过" } } } };
  assert.match(buildAgentHeadline(skipped, { ...codexAgent, health: "ready" }).text, /检测暂停/);

  // 凭证过期优先于 ready 文案（layers 同步会把该 agent 押到 error）
  const expired = codexDegradedStatus();
  expired.layers.agents.codex.expiry = { level: "expired", remainingMs: -1 };
  const h = buildAgentHeadline(expired, { ...codexAgent, health: "ready" });
  assert.equal(h.tone, "error");
  assert.match(h.text, /凭证已过期/);
});

// ---- v2.17 第三 agent（zcode）通用化：切换按钮标签 / 延迟取数不串数 ----

const zcodeAgent = {
  id: "zcode",
  kind: "zcode",
  name: "Zcode",
  diagnosticLabel: "Zcode 代理配置",
  switchLabel: "Server",
  tag: "Ready",
  health: "ready",
  summary: "zcode 就绪",
};

test("agentLatencyMs: 第三 agent 走通用 endpoint.latencyMs，不串显 codex 桥接延迟", () => {
  // bridgeStages.agent-endpoint 只由 codex endpoint 探针写入——v2.17 前 zcode
  // 会经旧兜底分支读到 379ms（codex 的数），这是串数回归测试。
  const status = codexDegradedStatus({
    agentsStatus: {
      codex: { health: "ready", summary: { ok: 18, fail: 0, warn: 0 }, endpoint: { ok: true } },
      zcode: { health: "ready", endpoint: { ok: true, output: "" } },
    },
  });
  assert.equal(agentLatencyMs(status, "codex"), 379, "codex 仍走桥接阶段延迟");
  assert.equal(agentLatencyMs(status, "zcode"), null, "zcode 无自有延迟数据时必须为 null");

  // 若第三 agent 的 endpoint 自带 latencyMs（未来有真端点探针时）则直用
  status.agentsStatus.zcode.endpoint = { ok: true, latencyMs: 42 };
  assert.equal(agentLatencyMs(status, "zcode"), 42);
  // 端点失败时延迟不可信 → null
  status.agentsStatus.zcode.endpoint = { ok: false, latencyMs: 15000 };
  assert.equal(agentLatencyMs(status, "zcode"), null);
});

test("zcode 卡片: headline 直用后端 degradedReason，通用端点 chip 语义成立", () => {
  const degradedStatus = {
    agentsStatus: {
      zcode: {
        health: "degraded",
        endpoint: { ok: false, output: "" },
        degradedReason: "降级：zcode 代理配置漂移（httpProxy 应为 http://127.0.0.1:7891），远程会话将 TLS 失败",
        version: "glm 0.13.3",
        output: "httpProxy: http://127.0.0.1:7893",
      },
    },
    layers: { agents: { zcode: { level: "warn", reason: "degraded", checkedAt: 987_000, expiry: null } } },
    bridgeStages: {},
  };
  const degraded = buildAgentHeadline(degradedStatus, { ...zcodeAgent, health: "degraded" });
  assert.equal(degraded.tone, "warn");
  assert.match(degraded.text, /代理配置漂移.*TLS 失败/);

  const model = buildAgentCardModel(degradedStatus, { ...zcodeAgent, health: "degraded" }, 1_000_000);
  assert.equal(model.chips[0].text, "端点不可达", "endpoint.ok=false → 通用 chip 生效");
  assert.ok(model.drawer.rows.some((row) => row.label === "版本" && row.value === "glm 0.13.3"));

  // ready（zcode 无延迟数据：卡片延迟位给占位，不串显他家延迟）
  const readyStatus = {
    agentsStatus: { zcode: { health: "ready", endpoint: { ok: true, output: "" } } },
    layers: { agents: { zcode: { level: "ok", reason: "ready", checkedAt: 987_000, expiry: null } } },
    bridgeStages: { "agent-endpoint": { stage: "agent-endpoint", ok: true, durationMs: 379 } },
  };
  const ready = buildAgentHeadline(readyStatus, zcodeAgent);
  assert.equal(ready.tone, "ok");
  assert.equal(ready.text, "就绪");
  assert.equal(buildAgentCardModel(readyStatus, zcodeAgent, 1_000_000).latency, null);
});

test("buildAgentCardModel: 两个 agent 同一模板，缺数据字段给占位而非整块消失", () => {
  const nowMs = 1_000_000;
  const codexModel = buildAgentCardModel(codexDegradedStatus(), codexAgent, nowMs);
  assert.equal(codexModel.chips.length, 2, "默认只保留 2 个主 chips（延迟单独放标题行）");
  assert.equal(codexModel.chips[0].text, "端点可达");
  assert.equal(codexModel.latency, 379);
  assert.match(codexModel.chips[1].text, /^检查 · /);
  // codex 没有版本/Gateway/登录 → 占位「—」
  const codexRows = Object.fromEntries(codexModel.drawer.rows.map((r) => [r.label, r.value]));
  assert.equal(codexRows.版本, "—");
  assert.equal(codexRows.Gateway, "—");
  assert.equal(codexRows.登录, "—");
  assert.match(codexRows["Doctor 计数"], /17 ok \/ 1 warn \/ 0 fail \/ 2 notes/);
  assert.equal(codexRows["Doctor 提醒"], "—", "fixture 无 warnItems 明细时给占位");

  // claude 缺延迟/层级数据 → chips 显示占位，行给「—」
  const claudeStatus = {
    agentsStatus: { "claude-codewing": { health: "ready", gatewayOk: true, loggedIn: true, version: "2.1" } },
    claudeEndpoint: { ok: true },
    layers: { agents: {} },
  };
  const claudeModel = buildAgentCardModel(claudeStatus, claudeAgent, nowMs);
  assert.equal(claudeModel.chips.length, 2);
  assert.equal(claudeModel.latency, null);
  assert.equal(claudeModel.chips[1].text, "未检查");
  const claudeRows = Object.fromEntries(claudeModel.drawer.rows.map((r) => [r.label, r.value]));
  assert.equal(claudeRows.版本, "2.1");
  assert.equal(claudeRows["Doctor 计数"], "—");
  assert.equal(claudeRows.层级结论, "—");
  // 模板同构：行标签集合完全一致
  assert.deepEqual(codexModel.drawer.rows.map((r) => r.label), claudeModel.drawer.rows.map((r) => r.label));
});

test("buildAgentCardModel: warnItems 明细透出到「Doctor 提醒」行（修复 warn 计数无处看内容）", () => {
  const status = codexDegradedStatus();
  status.agentsStatus.codex.health = "ready";
  status.agentsStatus.codex.summary.warnItems = [
    { name: "threads", text: "rollout files are missing from the state DB" },
  ];
  const model = buildAgentCardModel(status, { ...codexAgent, health: "ready" }, 1_000_000);
  const rows = Object.fromEntries(model.drawer.rows.map((r) => [r.label, r.value]));
  assert.match(rows["Doctor 提醒"], /维护提示.*会话记录与状态库索引不一致/);
  assert.match(rows["Doctor 提醒"], /threads：rollout files are missing from the state DB/);
});

test("buildAppServerNotice（v2.85）：Codex 守护进程端口一致只说一句；漂移时告警并可重启；没有进程不显示", () => {
  assert.equal(buildAppServerNotice(codexAgent, {}), null);
  assert.equal(buildAppServerNotice(claudeAgent, { appServer: { running: true, expectedPort: 7893, instances: [{ pid: 1, proxyPort: 7891 }] } }), null, "只对 codex");
  assert.equal(buildAppServerNotice(codexAgent, { appServer: { running: false, expectedPort: 7893, instances: [] } }), null);

  const ok = buildAppServerNotice(codexAgent, {
    appServer: { running: true, expectedPort: 7893, instances: [{ pid: 1106744, proxyPort: 7893 }] },
  });
  assert.deepEqual([ok.tone, ok.restart], ["ok", false]);
  assert.match(ok.text, /PID 1106744.*7893.*一致/);

  const stale = buildAppServerNotice(codexAgent, {
    appServer: { running: true, expectedPort: 7893, mismatch: true, instances: [{ pid: 668325, proxyPort: 7891 }] },
  });
  assert.deepEqual([stale.tone, stale.restart], ["warn", true]);
  assert.match(stale.text, /668325.*旧代理端口 7891.*当前应为 7893.*没有回复/);

  const noProxy = buildAppServerNotice(codexAgent, {
    appServer: { running: true, expectedPort: 7893, noProxy: true, instances: [{ pid: 1, proxyPort: null }] },
  });
  assert.deepEqual([noProxy.tone, noProxy.restart], ["warn", true]);
  assert.match(noProxy.text, /没有走隧道代理/);
});

test("formatDoctorOutput: 识别 codex doctor 真实标记 [!!]/[up]，计数行不误染 fail 色", async () => {
  const { formatDoctorOutput } = await import("./render/diagnostics.js");
  const html = formatDoctorOutput([
    "  [!!] threads      rollout files are missing from the state DB",
    "   [up] updates      0.151.0 available (current 0.144.1)",
    "  [ok] state        databases healthy",
    "17 ok | 2 notes | 1 warn | 0 fail degraded",
  ].join("\n"));
  const lines = html.split("</span>");
  assert.match(lines[0], /doc-line info/, "已知维护提示保留原文，改为信息色");
  assert.match(lines[1], /doc-line ok/);
  assert.match(lines[2], /doc-line ok/);
  assert.doesNotMatch(lines[3], /doc-line fail/, "『0 fail』计数行不应染成失败色");
});

test("recordBridgeSample/computeBridgeWindowDelta: 窗口差值、样本不足回退、计数回退自愈", () => {
  const map = new Map();
  const t0 = 10_000_000;
  recordBridgeSample(map, "codex", { reconnects: 638, fastFailures: 566 }, t0);
  assert.equal(computeBridgeWindowDelta(map.get("codex"), t0), null, "单样本不足以算差值");

  recordBridgeSample(map, "codex", { reconnects: 641, fastFailures: 567 }, t0 + 60e3);
  const delta = computeBridgeWindowDelta(map.get("codex"), t0 + 60e3);
  assert.equal(delta.reconnects, 3, "窗口差值 = 641 - 638");
  assert.equal(delta.fastFails, 1);

  // 超过 1 小时的旧样本自然过期 → 又回到样本不足
  recordBridgeSample(map, "codex", { reconnects: 642, fastFailures: 567 }, t0 + 3700e3);
  assert.equal(computeBridgeWindowDelta(map.get("codex"), t0 + 3700e3), null);

  // 切服务器：累计计数回退 → 清空该 agent 历史（自愈），不产生负差值
  recordBridgeSample(map, "codex", { reconnects: 2, fastFailures: 0 }, t0 + 3710e3);
  assert.equal(map.get("codex").length, 1);
  assert.equal(computeBridgeWindowDelta(map.get("codex"), t0 + 3710e3), null);

  // 计数不变时按最小间隔采样，不会每帧灌一个样本
  recordBridgeSample(map, "codex", { reconnects: 2, fastFailures: 0 }, t0 + 3711e3);
  assert.equal(map.get("codex").length, 1, "1s 后计数未变不重复采样");
});

test("buildBridgeStabilityHtml: 有窗口差值显示 1h 口径，样本不足回退累计并带「累计」", () => {
  const stages = {
    "ssh-tunnel": { stage: "ssh-tunnel", ok: true, durationMs: 0, consecutiveFailures: 0, reconnects: 641, fastFailures: 567 },
  };
  const cumulative = buildBridgeStabilityHtml(stages);
  assert.match(cumulative, /累计重连 641/);
  assert.match(cumulative, /累计快失败 567/);

  const windowed = buildBridgeStabilityHtml(stages, { reconnects: 3, fastFails: 1 });
  assert.match(windowed, /1h 内重连 3 次/);
  assert.match(windowed, /1h 内快失败 1 次/);
  assert.doesNotMatch(windowed, /641/, "窗口化后不再展示无口径累计值");
});

test("Agent 详情展开态：模块内状态在 rerender 间保持，未知 agent 默认折叠", () => {
  assert.equal(isAgentDrawerExpanded("codex"), false, "初始默认折叠");
  setAgentDrawerExpanded("codex", true);
  assert.equal(isAgentDrawerExpanded("codex"), true, "展开态跨读保持");
  assert.equal(isAgentDrawerExpanded("claude-codewing"), false, "互不串台");
  setAgentDrawerExpanded("codex", false);
  assert.equal(isAgentDrawerExpanded("codex"), false);
});

test("Agent 详情一次只展开一个：详情是状态带下方的同一块区域，展开另一个会收起前一个", () => {
  setAgentDrawerExpanded("codex", true);
  setAgentDrawerExpanded("claude-codewing", true);
  assert.equal(isAgentDrawerExpanded("claude-codewing"), true);
  assert.equal(isAgentDrawerExpanded("codex"), false, "前一个被收起");
  setAgentDrawerExpanded("zcode", false);
  assert.equal(isAgentDrawerExpanded("claude-codewing"), true, "收起别的不影响当前展开的");
  setAgentDrawerExpanded("claude-codewing", false);
  assert.equal(isAgentDrawerExpanded("claude-codewing"), false);
});

// ---- v2.15 环境完整性校验折叠 ----

test("buildValidationSummary/Label: 全过折叠一行并标注最慢项", () => {
  const items = [
    { key: "sshBaseline", ok: true, durationMs: 120 },
    { key: "remoteProxyTest", ok: true, durationMs: 443 },
    { key: "dnsCheck", ok: true, durationMs: 80 },
    { key: "tunnelPort", ok: true, durationMs: 30 },
  ];
  const s = buildValidationSummary(items);
  assert.equal(s.allOk, true);
  assert.equal(buildValidationSummaryLabel(s), "4/4 通过 · 最慢 remoteProxyTest 443ms");

  const s2 = buildValidationSummary([...items, { key: "authCheck", ok: false, durationMs: 999 }]);
  assert.equal(s2.failCount, 1);
  assert.match(buildValidationSummaryLabel(s2), /^1\/5 失败/);
  assert.match(buildValidationSummaryLabel(s2), /最慢 authCheck 999ms/);

  assert.equal(buildValidationSummaryLabel(buildValidationSummary([{ key: "a", ok: true }])), "1/1 通过", "无耗时数据不渲染最慢项");
});

test("sortValidationItems: 失败行置顶且稳定排序", () => {
  const sorted = sortValidationItems([
    { key: "a", ok: true },
    { key: "b", ok: false },
    { key: "c", ok: true },
    { key: "d", ok: false },
  ]);
  assert.deepEqual(sorted.map((i) => i.key), ["b", "d", "a", "c"]);
});

// ---- SSE 探针事件触发重刷新的门控（避免每 5s processes 事件都拉重接口）----

test("shouldRefreshOnProbe: processes 级别未变 → 不触发重刷新", () => {
  assert.equal(shouldRefreshOnProbe({ id: "processes", level: "ok" }, { processes: "ok" }), false);
});

test("shouldRefreshOnProbe: 级别变化 → 触发重刷新", () => {
  assert.equal(shouldRefreshOnProbe({ id: "processes", level: "warn" }, { processes: "ok" }), true);
});

test("shouldRefreshOnProbe: 首见（无历史级别）→ 触发重刷新", () => {
  assert.equal(shouldRefreshOnProbe({ id: "processes", level: "ok" }, {}), true);
});

test("shouldRefreshOnProbe: 重字段低频探针（doctor/endpoint/reclaude）级别未变也触发", () => {
  assert.equal(shouldRefreshOnProbe({ id: "doctor", level: "ok" }, { doctor: "ok" }), true);
  assert.equal(shouldRefreshOnProbe({ id: "endpoint", level: "ok" }, { endpoint: "ok" }), true);
  assert.equal(shouldRefreshOnProbe({ id: "reclaude", level: "ok" }, { reclaude: "ok" }), true);
});

test("shouldRefreshOnProbe: v2.18 已注销的 primary-remote / load:* 不再特判，按普通探针只在级别变化时触发", () => {
  assert.equal(shouldRefreshOnProbe({ id: "primary-remote", level: "ok" }, { "primary-remote": "ok" }), false);
  assert.equal(shouldRefreshOnProbe({ id: "load:server-02", level: "ok" }, { "load:server-02": "ok" }), false);
});

test("shouldRefreshOnProbe: 非法/空事件 → 不触发", () => {
  assert.equal(shouldRefreshOnProbe(null, {}), false);
  assert.equal(shouldRefreshOnProbe({ level: "ok" }, {}), false);
});

// ---- browser runtime wiring ----

// 导入说明符必须是裸路径，不带 ?v= 缓存串。
//
// 历史：曾用 `./x.js?v=<pkg version>` 做缓存 busting，全前端 37 处、12 个文件，每次发版
// 手工同步。这套机制其实从未生效——monitor-server.sendFile() 对所有静态资源发
// `cache-control: no-store`，浏览器根本不缓存，?v= 破坏的是不存在的缓存。它唯一的实际
// 效果是：漏改任何一处，同一模块就会被浏览器按两个不同 URL 实例化两份，module-level 状态
// （如 api.js 的 authToken）各自为政——这个事故真实发生过。
//
// 现在断言反过来：任何相对导入都不得带 ?v=，从原理上消灭这一整类故障。若将来真要做
// HTTP 缓存，正确做法是服务端发 immutable 长缓存 + 构建期注入版本，而不是手写查询串。
test("frontend modules: internal ESM imports carry no ?v= cache-busting string", () => {
  const files = [
    "app.js",
    "assets/js/charts.js",
    "assets/js/logs-panel.js",
    "assets/js/bootstrap-panel.js",
    "assets/js/render/overview.js",
    "assets/js/render/checklist.js",
    "assets/js/render/load-panel.js",
    "assets/js/render/diagnostics.js",
    "assets/js/render/log-stream.js",
    "assets/js/render/repair-runbook.js",
    "assets/js/render/attention.js",
    "assets/js/command-palette.js",
    "assets/js/api.js",
  ];
  for (const file of files) {
    const src = readFileSync(resolve(publicDir, file), "utf8");
    const versioned = [...src.matchAll(/from\s+["'](\.\.?\/[^"']*\?v=[^"']*)["']/g)].map((m) => m[1]);
    assert.deepEqual(versioned, [], `${file} 的相对导入不应带 ?v=（会造成模块双实例）`);
  }
});

// index.html / island.html 的 <link>/<script> 同理：no-store 下 ?v= 无意义，
// 且 island.html 曾长期停在 ?v=2.2.0 从未随版本更新，是纯粹的误导。
test("frontend pages: asset references carry no ?v= cache-busting string", () => {
  for (const file of ["index.html", "island.html"]) {
    const src = readFileSync(resolve(publicDir, file), "utf8");
    assert.deepEqual([...src.matchAll(/\?v=[^"'\s>]*/g)].map((m) => m[0]), [], `${file} 的资源引用不应带 ?v=`);
  }
});

// app.js 只做接线；切换与渲染在 assets/js/app/ 的控制器里（server-switch / render-pipeline）。
test("app wiring: switch actions call the registered config endpoints and import escapeHtml", async () => {
  const { readdirSync } = await import("node:fs");
  const appDir = resolve(publicDir, "assets/js/app");
  const sources = [
    ["app.js", readFileSync(resolve(publicDir, "app.js"), "utf8")],
    ...readdirSync(appDir).filter((f) => f.endsWith(".js")).map((f) => [`app/${f}`, readFileSync(resolve(appDir, f), "utf8")]),
  ];
  const byName = Object.fromEntries(sources);
  // 拼 HTML 的控制器统一从 store.js 取 escapeHtml，任何入口/控制器都不得私自再定义一份。
  for (const name of ["app/server-switch.js", "app/render-pipeline.js", "app/settings-dialog.js"]) {
    assert.match(byName[name], /import\s+\{[^}]*escapeHtml[^}]*\}\s+from\s+["']\.\.\/store\.js["']/, `${name} 应从 store.js 导入 escapeHtml`);
  }
  for (const [name, src] of sources) {
    assert.doesNotMatch(src, /function escapeHtml|(?:const|let)\s+escapeHtml\s*=/, `${name} 不应自带 escapeHtml`);
    assert.doesNotMatch(src, /\/api\/active-server|\/api\/active-agent/, `${name} 不应调用已废弃的切换接口`);
  }
  assert.match(byName["app/render-pipeline.js"], /versionBadge\.textContent\s*=\s*`v\$\{status\.version\}`/, "版本徽章必须由 status.version 动态渲染");
  const switcher = byName["app/server-switch.js"];
  assert.match(switcher, /postJson\("\/api\/config\/active",\s*\{\s*activeServerId:\s*serverId\s*\}\)/);
  assert.match(switcher, /postJson\("\/api\/config\/agent-active",\s*\{\s*activeAgentId:\s*agentId\s*\}\)/);
  assert.match(byName["app.js"], /createServerSwitch\(/, "app.js 经 server-switch 控制器接线切换动作");
});

// ---- v2.3: Claude API 数据流视角与探针历史纯函数 ----

test("getActiveAgentView: claude 视角 endpoint 取 status.claudeEndpoint（真实 Claude API 探测）", async () => {
  const { getActiveAgentView } = await import("./render/overview.js");
  const status = {
    activeAgentId: "claude-codewing",
    agents: [{ id: "claude-codewing", name: "Claude CodeWing", endpointLabel: "Claude API" }],
    agentsStatus: { "claude-codewing": { health: "ready", output: "st" } },
    claudeEndpoint: { ok: true, target: "api.relay-demo.example:9443", httpCode: 401, latencyMs: 320, output: "HTTP 401" },
  };
  const view = getActiveAgentView(status);
  assert.equal(view.endpoint.ok, true);
  assert.match(view.endpointBadge, /Claude API/);
  assert.match(view.endpointBadge, /api\.relay-demo\.example:9443/);
  assert.match(view.endpointBadge, /320ms/);

  // 未探测（claudeEndpoint 缺失）→ 待探测徽章，回落 daemon 状态
  const waiting = getActiveAgentView({ ...status, claudeEndpoint: null });
  assert.match(waiting.endpointBadge, /待探测/);
});

// ---- B1: 账号层故障（revoked/banned）在详情面板不得显示 0 失败/0 警告 ----

test("getActiveAgentView: revoked/banned 健康态计入 diagnostic.summary.fail，diagnosticBadge 给出可读文案", async () => {
  const { getActiveAgentView } = await import("./render/overview.js");
  const baseStatus = {
    activeAgentId: "claude-codewing",
    agents: [{ id: "claude-codewing", name: "Claude CodeWing", endpointLabel: "Claude API" }],
    claudeEndpoint: null,
  };

  const revokedView = getActiveAgentView({
    ...baseStatus,
    agentsStatus: { "claude-codewing": { health: "revoked", output: "此设备已被解绑" } },
  });
  assert.equal(revokedView.diagnostic.summary.fail, 1, "revoked 不得在详情面板显示 0 失败");
  assert.equal(revokedView.diagnosticBadge, "设备已解绑");

  const bannedView = getActiveAgentView({
    ...baseStatus,
    agentsStatus: { "claude-codewing": { health: "banned", output: "当前绑定账号暂不可用" } },
  });
  assert.equal(bannedView.diagnostic.summary.fail, 1, "banned 不得在详情面板显示 0 失败");
  assert.equal(bannedView.diagnosticBadge, "账号被封");
});

// ---- v2.47 可拔插模块：Agent 可全部关闭，不再伪造 codex 视角 ----

test("getActiveAgentView: 没有启用的 Agent 时返回 null；活跃 id 不在启用列表里时取第一个启用的", async () => {
  const { getActiveAgentView, hasDoctorAgent } = await import("./render/overview.js");
  assert.equal(getActiveAgentView({ activeAgentId: "", agents: [] }), null);
  assert.equal(getActiveAgentView({ activeAgentId: "codex" }), null, "缺 agents 也不伪造 codex");
  const zcodeOnly = { activeAgentId: "codex", agents: [{ id: "zcode", kind: "zcode", name: "Zcode" }], agentsStatus: {} };
  assert.equal(getActiveAgentView(zcodeOnly).agent.id, "zcode");
  assert.equal(hasDoctorAgent(zcodeOnly), false, "Codex 关闭 → 不出 Doctor 入口");
  assert.equal(hasDoctorAgent({ agents: [{ id: "codex", kind: "codex" }] }), true);
  assert.equal(hasDoctorAgent({ agents: [{ id: "codex" }] }), true, "旧配置缺 kind 按 id 兜底");
  assert.equal(hasDoctorAgent(null), false);
});

test("logs-panel: matchesFilter 支持 q；timeRangeToSince 换算；buildExportText 产出 NDJSON", async () => {
  const { matchesFilter: mf, timeRangeToSince, buildExportText } = await import("./logs-panel.js");
  assert.equal(mf({ source: "ops", level: "info", message: "Alpha done" }, { q: "alpha" }), true);
  assert.equal(mf({ source: "ops", level: "info", message: "beta" }, { q: "alpha" }), false);
  assert.equal(mf({ source: "ops", level: "info", message: "beta" }, {}), true);
  const now = 1000000000;
  assert.equal(timeRangeToSince("15m", now), now - 15 * 60e3);
  assert.equal(timeRangeToSince("24h", now), now - 24 * 3600e3);
  assert.equal(timeRangeToSince("", now), undefined);
  const text = buildExportText([{ ts: 1, source: "ops", level: "info", message: "a" }]);
  assert.equal(JSON.parse(text.trim().split("\n")[0]).message, "a");
  assert.equal(buildExportText([]), "");
});

// ---------------------------------------------------------------------------
// v2.4：SSE 重连抖动 / 日志行 HTML 构建（增量 append 与全量渲染共用）
// ---------------------------------------------------------------------------

test("applyJitter: 在 ±20% 范围内抖动，随机源可注入", () => {
  assert.equal(applyJitter(1000, () => 0.5), 1000, "rand=0.5 → 无偏移");
  assert.equal(applyJitter(1000, () => 1), 1200, "rand=1 → +20%");
  assert.equal(applyJitter(1000, () => 0), 800, "rand=0 → -20%");
  const jittered = applyJitter(30000);
  assert.ok(jittered >= 24000 && jittered <= 36000, "默认随机源也应落在 ±20% 区间");
});

test("buildLogLineHtml: 输出带级别 class 的行并转义 message/source", () => {
  const html = buildLogLineHtml({ ts: 0, source: "ops<b>", level: "error", message: "<script>x</script>" });
  assert.match(html, /^<span class="log-line log-error">/);
  assert.ok(html.includes("[ops&lt;b&gt;]"), "source 必须转义");
  assert.ok(html.includes("&lt;script&gt;"), "message 必须转义");
  assert.ok(!html.includes("<script>"), "不得出现未转义的脚本标签");

  const plain = buildLogLineHtml({ ts: 0, message: "hello" });
  assert.match(plain, /log-line log-ok/);
  assert.ok(!plain.includes("["), "无 source 时不渲染来源前缀");

  const withAction = buildLogLineHtml({
    ts: 0,
    source: "supervisor",
    message: "connect-deny host=evil.example port=443",
    nextAction: "确认白名单",
    reason: "deny",
    channelId: "server-01",
  });
  assert.ok(withAction.includes("nextAction=确认白名单"));
  assert.ok(withAction.includes("reason=deny"));
  assert.ok(withAction.includes("channel=server-01"));
});

// app.js 曾把"前端已加载"的版本写成 const clientBuild = "2.25.2"。它只在发版那一刻是对的，
// 之后没人会记得改：设置页于是长期显示一个与安装包无关的版本号。这里断言它必须来自
// 页面实际加载到的状态，而不是字面量。（断言"不存在硬编码"而非"存在某写法"，
// 因此不会因为后续重构而误报。）
test("版本详情: app.js 不得写死前端版本号，必须取自实际加载到的 status.version", () => {
  const src = readFileSync(resolve(publicDir, "app.js"), "utf8");
  // 先剥注释：说明这段历史的注释里会提到当年那个字面量，不该因此让测试变红。
  // （剥注释只会漏报、不会误报，所以同一用例里仍有正向断言兜底。）
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /clientBuild\s*=\s*["'`]\d+\.\d+\.\d+/,
    "app.js 里出现了写死的 clientBuild 版本号；应取自 loadedClientVersion（首次 status.version）",
  );
  assert.match(src, /loadedClientVersion/, "app.js 应保留页面加载时记录的前端版本");
  // 记录动作必须真的挂在数据入口上，否则 loadedClientVersion 永远是空串。
  assert.match(src, /function render\(status\) \{\s*\n\s*rememberClientVersion\(status\);/);
});

// ---------------------------------------------------------------------------
// v2.5：非 2xx 抛带 status 的错误 / 持续断开提示
// ---------------------------------------------------------------------------

test("api: 非 2xx 响应抛出带 status 的错误（401 可被上层识别为鉴权失败）", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) });
  try {
    const { getStatus } = await import("./api.js");
    await assert.rejects(() => getStatus(), (err) => err.status === 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("api: POST request adds operation ID and exposes response operation ID", async () => {
  const realFetch = globalThis.fetch;
  const realCrypto = globalThis.crypto;
  const wanted = "123e4567-e89b-42d3-a456-426614174000";
  let captured;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => wanted } });
  globalThis.fetch = async (_url, options) => {
    captured = options;
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => name.toLowerCase() === "x-operation-id" ? wanted : null },
      json: async () => ({ success: true }),
    };
  };
  try {
    const { postJson } = await import("./api.js");
    const result = await postJson("/api/config/active", { activeServerId: "server-01" });
    assert.equal(captured.headers["x-operation-id"], wanted);
    assert.equal(result.operationId, wanted);
  } finally {
    globalThis.fetch = realFetch;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: realCrypto });
  }
});

test("api: getLogs includes operationId query", async () => {
  const realFetch = globalThis.fetch;
  let requested;
  globalThis.fetch = async (url) => {
    requested = url;
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ entries: [] }) };
  };
  try {
    const { getLogs } = await import("./api.js");
    await getLogs({ operationId: "op-123" });
    assert.match(requested, /operationId=op-123/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("buildPersistentDownHint: 超过阈值才提示，包含持续分钟数", async () => {
  const { buildPersistentDownHint } = await import("./store.js");
  const mkStatus = (since) => ({ layers: { channel: { detail: { downSinceMs: since } } } });

  assert.equal(buildPersistentDownHint(mkStatus(null), 1000_000), "", "未断开不提示");
  assert.equal(buildPersistentDownHint(mkStatus(900_000), 1000_000), "", "断开 100s 未达 5 分钟阈值不提示");
  const hint = buildPersistentDownHint(mkStatus(100_000), 700_000);
  assert.ok(hint.includes("约 10 分钟"), `应包含持续分钟数，实际: ${hint}`);
  assert.ok(hint.includes("白名单"), "应包含白名单场景说明");
  assert.equal(buildPersistentDownHint({}, 700_000), "", "缺 layers 结构不崩溃");
});

// ---- render-skip：模块级签名跳过 ----

test("render-skip: timeBucket 按桶宽取整", async () => {
  const { timeBucket, RELATIVE_TIME_BUCKET_MS } = await import("./render/render-skip.js");
  assert.equal(typeof RELATIVE_TIME_BUCKET_MS, "number");
  assert.equal(timeBucket(0), 0);
  assert.equal(timeBucket(RELATIVE_TIME_BUCKET_MS - 1), 0);
  assert.equal(timeBucket(RELATIVE_TIME_BUCKET_MS), 1);
  assert.equal(timeBucket(2.5 * RELATIVE_TIME_BUCKET_MS), 2);
});

test("render-skip: createMemoRender 签名未变跳过、变化重渲、抛错不污染缓存", async () => {
  const { createMemoRender } = await import("./render/render-skip.js");

  let calls = 0;
  const seen = [];
  const render = createMemoRender(
    (value) => {
      calls += 1;
      seen.push(value);
    },
    (value) => String(value),
  );

  assert.equal(render("a"), true, "首次必然渲染");
  assert.equal(render("a"), false, "签名相同跳过");
  assert.equal(render("a"), false);
  assert.equal(render("b"), true, "签名变化重渲");
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(calls, 2);

  // renderFn 抛错时缓存不得更新：下一轮同签名仍要重试，而不是静默吞掉
  let shouldThrow = true;
  const flaky = createMemoRender(
    (value) => {
      if (shouldThrow) throw new Error("boom");
      return value;
    },
    (value) => String(value),
  );
  assert.throws(() => flaky("x"), /boom/);
  shouldThrow = false;
  assert.equal(flaky("x"), true, "上次失败后同签名仍会重试渲染");
});

// ==========================================================================
// v2.18：零残留采集探针 id 判定 / 自动修复徽标 / 本地数据 tile
// ==========================================================================

import { isAutoTriggered, autoBadgeHtml } from "./store.js";
import { buildHistoryRowHtml } from "./render/diagnostics.js";
import { buildStorageTileModel } from "./render/overview.js";

// ---- 采集探针 id 判定（collect:slow:* 接管 primary-remote / load:* 的资源采集）----

test("shouldRefreshOnProbe: 零残留采集慢档探针（collect:slow:*）级别未变也触发", () => {
  assert.equal(
    shouldRefreshOnProbe({ id: "collect:slow:server-01", level: "ok" }, { "collect:slow:server-01": "ok" }),
    true,
  );
  assert.equal(
    shouldRefreshOnProbe({ id: "collect:slow:server-02", level: "ok" }, { "collect:slow:server-02": "ok" }),
    true,
  );
});

test("shouldRefreshOnProbe: log-signals 级别未变也触发（fast profile 的 ports 段已并入该探针）", () => {
  assert.equal(shouldRefreshOnProbe({ id: "log-signals", level: "ok" }, { "log-signals": "ok" }), true);
});

test("shouldRefreshOnProbe: collect 前缀不误伤其它 id（仅 slow 档整份重拉）", () => {
  // fast 档只带信号/端口，级别未变时由 SSE lite 覆盖，不需要重量级完整拉取。
  assert.equal(
    shouldRefreshOnProbe({ id: "collect:fast:server-01", level: "ok" }, { "collect:fast:server-01": "ok" }),
    false,
  );
  assert.equal(shouldRefreshOnProbe({ id: "collector", level: "ok" }, { collector: "ok" }), false);
});

// ---- 自动修复徽标（trigger:"auto" / event:"auto-repair"）----

test("isAutoTriggered: trigger==='auto' 或 event==='auto-repair' 命中，其余不命中", () => {
  assert.equal(isAutoTriggered({ trigger: "auto" }), true);
  assert.equal(isAutoTriggered({ event: "auto-repair" }), true);
  assert.equal(isAutoTriggered({ trigger: "manual" }), false);
  assert.equal(isAutoTriggered({ event: "repair" }), false);
  assert.equal(isAutoTriggered({}), false);
  assert.equal(isAutoTriggered(null), false);
  assert.equal(isAutoTriggered("auto"), false);
});

test("autoBadgeHtml: 命中时输出「自动」小徽标，未命中输出空串", () => {
  assert.match(autoBadgeHtml({ trigger: "auto" }), /class="auto-badge"/);
  assert.match(autoBadgeHtml({ trigger: "auto" }), />自动</);
  assert.equal(autoBadgeHtml({ trigger: "manual" }), "");
});

test("buildLogLineHtml: 自动触发的日志行前缀「自动」徽标，手动行不变", () => {
  const auto = buildLogLineHtml({ ts: 1756000000000, source: "ops", message: "auto restart", trigger: "auto" });
  assert.match(auto, /class="auto-badge"/);
  const manual = buildLogLineHtml({ ts: 1756000000000, source: "ops", message: "auto restart" });
  assert.equal(/auto-badge/.test(manual), false);
});

test("buildHistoryRowHtml: 自动触发的时间线条目带「自动」徽标", () => {
  const row = buildHistoryRowHtml({
    type: "transition",
    ts: 1756000000000,
    key: "channel",
    layer: "channel",
    from: "error",
    to: "ok",
    trigger: "auto",
  });
  assert.match(row, /class="auto-badge"/);
  const plain = buildHistoryRowHtml({
    type: "transition",
    ts: 1756000000000,
    key: "channel",
    layer: "channel",
    from: "error",
    to: "ok",
  });
  assert.equal(/auto-badge/.test(plain), false);
  // event:"auto-repair" 走同一判定
  assert.match(
    buildHistoryRowHtml({ type: "signal", ts: 1756000000000, severity: "warn", title: "x", event: "auto-repair" }),
    /class="auto-badge"/,
  );
});

// ---- 本地数据 tile（storage = { usedBytes, budgetBytes, lastSweepAt, evicted }）----

const MB = 1024 * 1024;

test("buildStorageTileModel: 正常档显示 usedMB / budgetMB，绿色", () => {
  const m = buildStorageTileModel({ usedBytes: 12 * MB, budgetBytes: 50 * MB });
  assert.equal(m.available, true);
  assert.equal(m.usedMB, 12);
  assert.equal(m.budgetMB, 50);
  assert.equal(m.value, "12MB / 50MB");
  assert.equal(m.percent, 24);
  assert.equal(m.colorClass, "green");
  assert.equal(m.critical, false);
});

test("buildStorageTileModel: 超 80% 转黄，超预算转红", () => {
  assert.equal(buildStorageTileModel({ usedBytes: 40 * MB, budgetBytes: 50 * MB }).colorClass, "green"); // 恰好 80%
  assert.equal(buildStorageTileModel({ usedBytes: 41 * MB, budgetBytes: 50 * MB }).colorClass, "yellow");
  assert.equal(buildStorageTileModel({ usedBytes: 50 * MB, budgetBytes: 50 * MB }).colorClass, "yellow");
  const over = buildStorageTileModel({ usedBytes: 63 * MB, budgetBytes: 50 * MB });
  assert.equal(over.colorClass, "red");
  assert.equal(over.critical, true);
  assert.equal(over.percent, 100); // 进度条封顶 100，超预算语义由红色表达
});

test("buildStorageTileModel: 次行给出上次清理与淘汰计数", () => {
  const now = Date.UTC(2026, 8, 2, 12, 0, 0);
  const m = buildStorageTileModel(
    { usedBytes: 5 * MB, budgetBytes: 50 * MB, lastSweepAt: now - 120000, evicted: 3 },
    { now },
  );
  assert.match(m.sub, /上次清理 2 分钟前/);
  assert.match(m.sub, /已淘汰 3 项/);
});

test("buildStorageTileModel: 字段缺失/畸形时降级为不可用，不抛错", () => {
  const none = buildStorageTileModel(undefined);
  assert.equal(none.available, false);
  assert.equal(none.value, "-");
  assert.equal(none.percent, 0);
  assert.equal(none.colorClass, "green");
  assert.equal(buildStorageTileModel({ usedBytes: "x", budgetBytes: 0 }).available, false);
  assert.equal(buildStorageTileModel({ usedBytes: 5 * MB }).available, false); // 无预算 → 无分档依据
});

// ---- ReClaude 远端动作已移除（重启服务 / 写回 drop-in 由用户手动处理）：
// 徽标只剩「自动」一种、概览卡无动作行、确认层只服务单隧道重启 ----

test("autoBadgeHtml: 自动 → auto-badge，其余（含历史 manual-l3 条目）→ 空串", () => {
  assert.match(autoBadgeHtml({ trigger: "auto" }), /class="auto-badge"/);
  assert.equal(autoBadgeHtml({ trigger: "manual-l3", event: "remote-action" }), "");
  assert.equal(autoBadgeHtml({ trigger: "manual" }), "");
  assert.equal(autoBadgeHtml(null), "");
});

test("buildLogLineHtml / buildHistoryRowHtml: 轮转日志里残留的 manual-l3 条目不再带「远端」徽标", () => {
  const line = buildLogLineHtml({ ts: 1756000000000, source: "ops", message: "remote-action reclaude-restart stage=restart ok", trigger: "manual-l3" });
  assert.doesNotMatch(line, /remote-badge/);
  assert.doesNotMatch(line, /auto-badge/);
  const row = buildHistoryRowHtml({
    type: "transition",
    ts: 1756000000000,
    key: "remote-action:reclaude-restart",
    layer: "agents",
    from: "error",
    to: "ok",
    trigger: "manual-l3",
  });
  assert.doesNotMatch(row, /remote-badge/);
});

test("buildAgentCardModel: 不再产出 remoteActions，快照里残留的字段也被忽略", async () => {
  const overview = await import("./render/overview.js");
  assert.equal("buildAgentActionRowHtml" in overview, false);
  const nowMs = 1_000_000;
  const claudeStatus = {
    agentsStatus: { "claude-codewing": { health: "ready" } },
    claudeEndpoint: { ok: true },
    layers: { agents: {} },
    remoteActions: { enabled: true, available: [{ id: "reclaude-restart", label: "重启 ReClaude 服务", agentId: "claude-codewing" }], inFlight: null },
  };
  const model = buildAgentCardModel(claudeStatus, claudeAgent, nowMs);
  assert.equal("remoteActions" in model, false);
});

test("store: isRemoteTriggered 已移除", async () => {
  const store = await import("./store.js");
  assert.equal("isRemoteTriggered" in store, false);
});

test("index.html: 操作确认层 markup 齐全（只服务单隧道重启），远端动作确认层已移除", () => {
  const src = readFileSync(resolve(publicDir, "index.html"), "utf8");
  // 断言标签结构与属性，而不是逐字节匹配整个开头标签：只要类名与 id 符合契约，
  // 为此标签补 aria-* 之类的可访问性属性不该让测试变红。
  const tag = src.match(/<dialog\b[^>]*id="dlgActionPreview"[^>]*>/);
  assert.ok(tag, "index.html 缺 #dlgActionPreview 的 dialog");
  assert.match(tag[0], /class="[^"]*\bhud-dialog\b/);
  assert.match(tag[0], /class="[^"]*\bdialog-wide\b/);
  for (const id of [
    "actionPreviewTitle",
    "actionPreviewTarget",
    "actionPreviewCommands",
    "actionPreviewNotes",
    "actionPreviewExpire",
    "actionPreviewCancelBtn",
    "actionPreviewConfirmBtn",
  ]) {
    assert.match(src, new RegExp(`id="${id}"`), `index.html 缺 #${id}`);
  }
  assert.match(src, /id="actionPreviewCancelBtn"[^>]*data-close/);
  assert.doesNotMatch(src, /dlgRemoteActionPreview|remoteAction[A-Z]|systemd --user/);
});

test("app wiring: 单隧道重启走 operations 预览/执行路由；远端动作路由与入口全部移除", () => {
  const src = readFileSync(resolve(publicDir, "app.js"), "utf8");
  assert.match(src, /postJson\("\/api\/operations\/preview",/);
  assert.match(src, /postJson\("\/api\/operations\/run",\s*\{\s*previewId\s*\},\s*\{\s*operationId\s*\}\)/);
  assert.match(src, /import\s+\{[^}]*initAttentionQueue[^}]*\}\s+from\s+["']\.\/assets\/js\/render\/attention\.js["']/);
  assert.match(src, /onSettled:/);
  assert.doesNotMatch(src, /remote-action|requestRemoteAction|onRemoteAction|onRemoteFix/);
});

test("command palette: 不再生成远端动作命令", () => {
  const src = readFileSync(resolve(publicDir, "assets/js/command-palette.js"), "utf8");
  assert.doesNotMatch(src, /remoteActions|remote-action|onRemoteAction/);
});
