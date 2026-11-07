import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { agentAdapterEnabled, enabledAgentProbeIds, listAgentAdapters } from "../agents/registry.mjs";
import {
  applyModulePreferences,
  buildModuleCatalog,
  explicitModulePreferences,
  isDataModuleEnabled,
  isLegacyModulePreferences,
  isToggleableModule,
  normalizePreferenceIds,
  toggleDisabledModule,
  toggleModulePreference,
  validatePreferenceIds,
} from "./catalog.mjs";

const ZCODE = { id: "zcode", name: "Zcode", kind: "zcode" };

function runtimeConfig(extra = {}) {
  return applyModulePreferences({ ...normalizeAgentConfig({ agents: [ZCODE], activeAgentId: "codex", servers: [] }), ...extra });
}

const adapter = (kind) => listAgentAdapters().find((a) => a.kind === kind);

test("默认全开：agents 与 agentCatalog 一致，数据模块全开", () => {
  const cfg = runtimeConfig();
  assert.deepEqual(cfg.agents.map((a) => a.id), ["codex", "claude-codewing", "zcode"]);
  assert.deepEqual(cfg.agentCatalog.map((a) => [a.id, a.enabled]), [["codex", true], ["claude-codewing", true], ["zcode", true]]);
  assert.deepEqual(cfg.modules, { usage: true, jobs: true, daemons: true });
  assert.equal(cfg.activeAgentId, "codex");
  assert.deepEqual(cfg.disabledModules, []);
  assert.deepEqual(cfg.hiddenPanels, []);
});

test("关闭 zcode：agents 去掉、目录保留并标记关闭、适配器门控关闭", () => {
  const cfg = runtimeConfig({ disabledModules: ["agent:zcode"] });
  assert.deepEqual(cfg.agents.map((a) => a.id), ["codex", "claude-codewing"]);
  assert.equal(cfg.agentCatalog.find((a) => a.id === "zcode").enabled, false);
  assert.equal(agentAdapterEnabled(adapter("zcode"), cfg), false);
  assert.equal(agentAdapterEnabled(adapter("codex"), cfg), true);
  assert.deepEqual(enabledAgentProbeIds(cfg), ["doctor", "endpoint", "reclaude", "claude-endpoint"]);
});

test("关闭活跃 Agent：activeAgentId 回落第一个启用项；全关为空串", () => {
  assert.equal(runtimeConfig({ disabledModules: ["agent:codex"] }).activeAgentId, "claude-codewing");
  const allOff = runtimeConfig({ disabledModules: ["agent:codex", "agent:claude-codewing", "agent:zcode"] });
  assert.equal(allOff.activeAgentId, "");
  assert.deepEqual(allOff.agents, []);
  assert.deepEqual(enabledAgentProbeIds(allOff), []);
});

test("数据模块开关", () => {
  const cfg = runtimeConfig({ disabledModules: ["usage"] });
  assert.equal(isDataModuleEnabled(cfg, "usage"), false);
  assert.equal(isDataModuleEnabled(cfg, "jobs"), true);
  assert.equal(isDataModuleEnabled(cfg, "daemons"), true, "远端守护进程默认开启");
  assert.equal(isDataModuleEnabled(runtimeConfig({ disabledModules: ["daemons"] }), "daemons"), false);
  assert.equal(isDataModuleEnabled({}, "usage"), true, "没有 modules 字段的旧配置按全开处理");
});

test("未归一化的替身配置（无 agents 数组）按默认物化口径启用 codex/reclaude", () => {
  assert.equal(agentAdapterEnabled(adapter("codex"), {}), true);
  assert.equal(agentAdapterEnabled(adapter("reclaude"), {}), true);
  assert.equal(agentAdapterEnabled(adapter("zcode"), {}), false);
});

test("偏好 id 归一：丢弃非法、去重、未知但合法的保留", () => {
  assert.deepEqual(normalizePreferenceIds(["agent:x", "agent:x", "../etc", 3, "view.usage"]), ["agent:x", "view.usage"]);
  assert.deepEqual(normalizePreferenceIds("usage"), []);
  assert.equal(validatePreferenceIds(["ok", "bad id"]).ok, false);
  assert.equal(validatePreferenceIds("usage").ok, false);
  assert.deepEqual(validatePreferenceIds(["a", "a"]).value, ["a"]);
});

test("目录：Agent 组带提示、数据组、核心组锁定；可开关判定", () => {
  const cfg = runtimeConfig({ disabledModules: ["agent:zcode", "jobs"] });
  const catalog = buildModuleCatalog(cfg);
  const byId = Object.fromEntries(catalog.map((m) => [m.id, m]));
  assert.equal(byId["agent:zcode"].enabled, false);
  assert.equal(byId["agent:zcode"].group, "agent");
  assert.ok(byId["agent:claude-codewing"].warning.includes("账号层"));
  assert.ok(byId["agent:codex"].cost);
  assert.equal(byId.jobs.enabled, false);
  assert.equal(byId["core.signals"].locked, true);
  assert.equal(isToggleableModule(cfg, "agent:zcode"), true);
  assert.equal(isToggleableModule(cfg, "usage"), true);
  assert.equal(isToggleableModule(cfg, "daemons"), true);
  assert.equal(byId.daemons.group, "data");
  assert.equal(byId.daemons.label, "远端守护进程");
  assert.equal(isToggleableModule(cfg, "core.signals"), false);
  assert.equal(isToggleableModule(cfg, "agent:nope"), false);
});

test("切换只改目标项，保留其它未知 id", () => {
  assert.deepEqual(toggleDisabledModule(["agent:old", "usage"], "agent:zcode", false), ["agent:old", "usage", "agent:zcode"]);
  assert.deepEqual(toggleDisabledModule(["agent:old", "usage"], "usage", true), ["agent:old"]);
  assert.deepEqual(toggleDisabledModule(["usage"], "usage", false), ["usage"]);
});

// ---------------------------------------------------------------------------
// v2.57 团队默认关（defaultEnabled:false）+ 个人双向覆盖 + 旧偏好迁移
// ---------------------------------------------------------------------------

// 与仓库 config.json 同形：codex / claude-code 默认开，reclaude / zcode 团队默认关。
const TEAM_AGENTS = [
  { id: "codex", name: "Codex", kind: "codex" },
  { id: "claude-code", name: "Claude Code", kind: "claude-code" },
  { id: "claude-codewing", name: "Claude CodeWing", kind: "reclaude", defaultEnabled: false },
  { id: "zcode", name: "Zcode", kind: "zcode", defaultEnabled: false },
];

function teamRuntime(prefs = {}) {
  return applyModulePreferences({ ...normalizeAgentConfig({ agents: TEAM_AGENTS, activeAgentId: "codex", servers: [] }), ...prefs });
}

const enabledIds = (cfg) => cfg.agentCatalog.filter((a) => a.enabled).map((a) => a.id).sort();

test("团队默认：新同事（没碰过偏好）只开 codex 与 claude-code；探针集合随之", () => {
  const cfg = teamRuntime();
  assert.deepEqual(enabledIds(cfg), ["claude-code", "codex"]);
  assert.equal(cfg.agentCatalog.find((a) => a.id === "zcode").defaultEnabled, false);
  assert.deepEqual(enabledAgentProbeIds(cfg), ["doctor", "endpoint", "claude-code"]);
  const catalog = Object.fromEntries(buildModuleCatalog(cfg).map((m) => [m.id, m]));
  assert.equal(catalog["agent:claude-codewing"].enabled, false);
  assert.equal(catalog["agent:claude-codewing"].defaultEnabled, false);
  assert.equal(catalog["agent:codex"].defaultEnabled, true);
  assert.equal(catalog.usage.defaultEnabled, true);
});

test("个人双向覆盖：enabledModules 打开团队默认关的，disabledModules 关掉默认开的；两边都写时关闭优先", () => {
  assert.deepEqual(enabledIds(teamRuntime({ enabledModules: ["agent:claude-codewing"], disabledModules: ["agent:claude-code"] })),
    ["claude-codewing", "codex"]);
  assert.deepEqual(enabledIds(teamRuntime({ enabledModules: ["agent:zcode"], disabledModules: ["agent:zcode"] })), ["claude-code", "codex"]);
});

test("迁移：kai 生产个人层（v2.56 写的 disabledModules:[agent:zcode]）升级后 reclaude 仍开、zcode 仍关", () => {
  const personal = { disabledModules: ["agent:zcode"], portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } };
  assert.equal(isLegacyModulePreferences(personal), true);
  const cfg = teamRuntime({ disabledModules: personal.disabledModules, legacyModuleDefaults: true });
  assert.deepEqual(enabledIds(cfg), ["claude-code", "claude-codewing", "codex"]);
  assert.ok(enabledAgentProbeIds(cfg).includes("reclaude"));
  // 物化：靠旧语义开着的 reclaude 写进 enabledModules；zcode 是显式关，不动
  assert.deepEqual(explicitModulePreferences(cfg), { disabledModules: ["agent:zcode"], enabledModules: ["agent:claude-codewing"] });
  // 物化后（不再是旧偏好）结论不变
  const after = teamRuntime({ ...explicitModulePreferences(cfg), legacyModuleDefaults: false });
  assert.deepEqual(enabledIds(after), enabledIds(cfg));
  // 不是旧偏好时物化为空操作
  assert.deepEqual(explicitModulePreferences(teamRuntime({ disabledModules: ["usage"] })), { disabledModules: ["usage"], enabledModules: [] });
});

test("toggleModulePreference：显式记录本次选择，从另一张表移除，保留其它 id", () => {
  assert.deepEqual(toggleModulePreference({ disabledModules: ["agent:zcode", "usage"], enabledModules: [] }, "agent:zcode", true),
    { disabledModules: ["usage"], enabledModules: ["agent:zcode"] });
  assert.deepEqual(toggleModulePreference({ disabledModules: [], enabledModules: ["agent:claude-codewing", "agent:x"] }, "agent:claude-codewing", false),
    { disabledModules: ["agent:claude-codewing"], enabledModules: ["agent:x"] });
  assert.deepEqual(toggleModulePreference(undefined, "usage", false), { disabledModules: ["usage"], enabledModules: [] });
});
