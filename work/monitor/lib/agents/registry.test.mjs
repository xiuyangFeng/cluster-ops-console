import assert from "node:assert/strict";
import test from "node:test";

import { codexAdapter } from "./codex.mjs";
import { reclaudeAdapter } from "./reclaude.mjs";
import { applyModulePreferences } from "../modules/catalog.mjs";
import { adapterForAgent, adapterForProbeId, agentAdapterEnabled, agentIdForAdapter, enabledAgentProbeIds, listAgentAdapters } from "./registry.mjs";
import { zcodeAdapter } from "./zcode.mjs";

// ---------------------------------------------------------------------------
// 内置适配器：注册面与探针 id 归属
// ---------------------------------------------------------------------------

test("registry: 内置 codex/reclaude 适配器按注册序列出，探针 id 归属正确", () => {
  const kinds = listAgentAdapters().map((a) => a.kind);
  assert.ok(kinds.indexOf("codex") >= 0 && kinds.indexOf("codex") < kinds.indexOf("reclaude"),
    "codex 必须先于 reclaude 注册（getLegacyStatus 键序依赖注册序）");
  assert.equal(adapterForProbeId("doctor").kind, "codex");
  assert.equal(adapterForProbeId("endpoint").kind, "codex");
  assert.equal(adapterForProbeId("reclaude").kind, "reclaude");
  assert.equal(adapterForProbeId("claude-endpoint").kind, "reclaude");
  assert.equal(adapterForProbeId("processes"), null, "通道探针不归任何适配器");
  // 配置条目 → 适配器：kind 优先，缺 kind 时按默认 agentId 兜底（旧配置兼容）。
  assert.equal(adapterForAgent({ id: "codex", kind: "codex" }).kind, "codex");
  assert.equal(adapterForAgent({ id: "claude-codewing" }).kind, "reclaude");
  assert.equal(adapterForAgent({ id: "unknown-agent", kind: "unknown" }), null);
});

// ---------------------------------------------------------------------------
// v2.47 统一门控：启用 = 运行配置 agents[]（已按 disabledModules 过滤）里有映射条目
// ---------------------------------------------------------------------------

test("registry 统一门控：适配器不再自带 isEnabled；三个 Agent 都按配置启停，id 与探针清单由配置派生", () => {
  for (const adapter of listAgentAdapters()) {
    assert.equal(typeof adapter.isEnabled, "undefined", `${adapter.kind} 不再声明 isEnabled`);
    assert.ok(adapter.moduleHint?.description, `${adapter.kind} 提供设置页说明 moduleHint`);
  }
  const all = applyModulePreferences({
    agents: [{ id: "codex", kind: "codex" }, { id: "claude-codewing", kind: "reclaude" }, { id: "zcode", kind: "zcode" }],
  });
  assert.deepEqual(enabledAgentProbeIds(all), ["doctor", "endpoint", "reclaude", "claude-endpoint", "zcode-status"]);

  const someOff = applyModulePreferences({ ...all, agents: all.agentCatalog, disabledModules: ["agent:claude-codewing"] });
  assert.equal(agentAdapterEnabled(reclaudeAdapter, someOff), false);
  assert.equal(agentAdapterEnabled(zcodeAdapter, someOff), true);
  assert.deepEqual(enabledAgentProbeIds(someOff), ["doctor", "endpoint", "zcode-status"]);

  // 配置条目 id 优先于适配器默认 agentId；缺省配置（无 agents 数组）按默认物化口径
  assert.equal(agentIdForAdapter(codexAdapter, { agents: [{ id: "codex-main", kind: "codex" }] }), "codex-main");
  assert.equal(agentIdForAdapter(reclaudeAdapter, {}), "claude-codewing");
  assert.deepEqual(enabledAgentProbeIds({}), ["doctor", "endpoint", "reclaude", "claude-endpoint"]);
  assert.deepEqual(enabledAgentProbeIds({ agents: [] }), [], "全关：没有 agent 探针");
});

// ---------------------------------------------------------------------------
// degradedReason 字段：内置适配器按严重度给出根因文案（前端直接展示）
// ---------------------------------------------------------------------------

test("codex 适配器 buildStatus: degradedReason 按严重度给出根因文案", () => {
  const codex = codexAdapter;
  const state = codex.createInitialState();
  state.doctor = { ok: true, summary: { ok: 16, fail: 2, warn: 0, notes: 0, raw: "" }, output: "d" };
  state.endpoint = { ok: true, output: "e" };
  assert.equal(codex.buildStatus(state).degradedReason, "降级：Doctor 报 2 项失败");

  state.doctor = { ok: true, summary: { ok: 18, fail: 0, warn: 0, notes: 0, raw: "18 ok" }, output: "d" };
  state.endpoint = { ok: false, output: "e" };
  assert.equal(codex.buildStatus(state).degradedReason, "降级：端点探测未通过");

  state.endpoint = { ok: true, output: "e" };
  assert.equal(codex.buildStatus(state).health, "ready");
  assert.equal(codex.buildStatus(state).degradedReason, null, "非降级不产出根因文案");
});

test("reclaude 适配器 buildStatus: degradedReason 端点优先于 Gateway", () => {
  const reclaude = reclaudeAdapter;
  const state = reclaude.createInitialState();
  state.reclaudeData = { ok: true, health: "ready", installed: true, loggedIn: true, gatewayOk: true, output: "st" };
  state.claudeEndpoint = { ok: false, output: "timeout" };
  assert.equal(reclaude.buildStatus(state).degradedReason, "降级：Claude API 端点不可达");

  state.claudeEndpoint = { ok: true, latencyMs: 300, output: "HTTP 401" };
  state.reclaudeData = { ...state.reclaudeData, gatewayOk: false };
  assert.equal(reclaude.buildStatus(state).degradedReason, "降级：Gateway 探活失败");

  state.reclaudeData = { ...state.reclaudeData, gatewayOk: true };
  assert.equal(reclaude.buildStatus(state).health, "ready");
  assert.equal(reclaude.buildStatus(state).degradedReason, null);
});

// ---------------------------------------------------------------------------
// v2.16 doctor 自适应节奏：健康稳态降频、任何非 ok 立即回快节奏
// ---------------------------------------------------------------------------

test("codex doctor 探针：连续 ok 达阈值后降频到 5 分钟，非 ok 立即回 90 秒", async () => {
  const { DOCTOR_ACTIVE_INTERVAL_MS, DOCTOR_IDLE_INTERVAL_MS, DOCTOR_IDLE_AFTER_OK_STREAK } =
    await import("./codex.mjs");
  const codex = codexAdapter;
  const specs = codex.probeSpecs({});
  const doctor = specs.find((s) => s.id === "doctor");
  assert.equal(typeof doctor.intervalMs, "function", "doctor 间隔应为自适应函数");

  // 连续 ok：阈值前保持快节奏，达阈值后降频
  for (let i = 1; i < DOCTOR_IDLE_AFTER_OK_STREAK; i += 1) {
    assert.equal(doctor.intervalMs({ level: "ok" }), DOCTOR_ACTIVE_INTERVAL_MS, `第 ${i} 轮 ok 仍是快节奏`);
  }
  assert.equal(doctor.intervalMs({ level: "ok" }), DOCTOR_IDLE_INTERVAL_MS, "达阈值后降频");
  assert.equal(doctor.intervalMs({ level: "ok" }), DOCTOR_IDLE_INTERVAL_MS, "稳态维持低频");

  // 任何非 ok（error/skipped）清零 streak，立即回快节奏
  assert.equal(doctor.intervalMs({ level: "error" }), DOCTOR_ACTIVE_INTERVAL_MS);
  assert.equal(doctor.intervalMs({ level: "ok" }), DOCTOR_ACTIVE_INTERVAL_MS, "重新计数");
  assert.equal(doctor.intervalMs({ level: "skipped" }), DOCTOR_ACTIVE_INTERVAL_MS, "熔断跳过也清零");

  // endpoint 探针保持固定间隔不受影响
  const endpoint = specs.find((s) => s.id === "endpoint");
  assert.equal(endpoint.intervalMs, 90000);

  // 每次 probeSpecs() 调用产生独立 streak 闭包（配置热载重注册后重新计数）
  const fresh = codex.probeSpecs({}).find((s) => s.id === "doctor");
  assert.equal(fresh.intervalMs({ level: "ok" }), DOCTOR_ACTIVE_INTERVAL_MS);
});
