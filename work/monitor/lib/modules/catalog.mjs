// 可拔插模块目录：「哪些监控可以在页面上开关」的唯一来源。
//
// 个人层 config.local.json 存用户的显式选择（没写的项按默认）：
//   disabledModules  ["agent:zcode", "usage", ...]   显式关闭的监控模块（本文件）
//   enabledModules   ["agent:claude-codewing"]       显式开启的监控模块（v2.57：团队默认关的 Agent 由个人打开）
//   hiddenPanels     ["overview.brief", "view.usage"] 界面面板显隐（面板目录在前端 panels.js）
//   modulePrefsVersion  2                            偏好语义版本（见下「默认开关与旧偏好迁移」）
// 这些字段只属于个人层：团队 config.json 里出现一律忽略（只从个人层原始对象读取，见 preferences-store）。
//
// 默认开关与旧偏好迁移（v2.57）：
//   - 团队层 agents[] 条目可写 defaultEnabled:false（团队默认关闭，如 reclaude / zcode）；缺省为开。
//     数据采集模块恒为默认开。个人层显式开关双向覆盖默认值；两边都写了同一项时关闭优先。
//   - v2.56 及以前没有「默认关」：个人层只记关掉的项，没记的一律是开着的。个人层写过偏好字段
//    （disabledModules / hiddenPanels 任一是数组）却没有 modulePrefsVersion:2 的，视为旧偏好——
//     团队默认关、但用户没显式关的 Agent 继续按开处理（kai 生产：disabledModules:["agent:zcode"]
//     → 升级后 reclaude 仍开、zcode 仍关）。从没碰过偏好的新同事按团队默认（reclaude / zcode 关）。
//   - 旧偏好在第一次写入偏好时物化：把「靠旧语义开着」的 Agent 写进 enabledModules，并打上
//     modulePrefsVersion:2，此后完全按显式选择 + 团队默认解释。
//
// 本模块只在控制面使用（monitor-server 的配置缓存）。数据面 supervisor 经
// monitor-core.normalizeAgentConfig 读配置、不感知模块开关——隧道永远不受影响。

import { adapterForAgent } from "../agents/registry.mjs";

export const PREFERENCE_FIELDS = ["disabledModules", "enabledModules", "hiddenPanels"];
export const MODULE_PREFS_VERSION = 2;

// 模块 / 面板 id：字母数字与 _ . : -，1–64 字符（agent:<agentId>、view.usage 等）。
const PREFERENCE_ID_PATTERN = /^[\w.:-]{1,64}$/;
const MAX_PREFERENCE_IDS = 64;

const AGENT_PREFIX = "agent:";

export function agentModuleId(agentId) {
  return `${AGENT_PREFIX}${agentId}`;
}

// 数据采集类模块：关闭后停掉对应探针（registerLoadProbes 门控）与界面入口。
export const DATA_MODULES = Object.freeze([
  Object.freeze({
    id: "usage",
    label: "Agent 用量统计",
    description: "扫描集群上的会话记录，统计 Token 用量；关闭后隐藏「用量」页与简报用量格",
    cost: "每 60 秒一次 SSH",
  }),
  Object.freeze({
    id: "jobs",
    label: "我的 Slurm 作业",
    description: "用 sacct 读取近 2 天的个人作业；关闭后隐藏简报「我的作业」与作业队列个人汇总，也不再量作业产出目录的大小",
    cost: "每 5 分钟一次 SSH；另每 6 小时量一次作业产出目录（分多轮，最多 10 分钟）",
  }),
  // 不注册探针：只有服务器页「远端守护进程」面板可见时才查状态（lib/daemons/）；关闭后接口 503、面板隐藏。
  Object.freeze({
    id: "daemons",
    label: "远端守护进程",
    description: "查看活跃服务器上 Paseo 与 T3 Code 是否在运行，停了可一键启动（从不重启或停止）；同时列出你在这台服务器上监听的服务，可临时转发到本机打开；关闭后隐藏服务器页「远端守护进程」面板，开着的转发随即收回",
    cost: "仅服务器页可见时每 60 秒一次 SSH",
  }),
]);

// 核心部分：只作说明、不可关闭。log-signals 同时是远端端口状态的唯一数据源，
// 关掉会让通道永远恢复不了；slow 采集已有「按服务器禁用」，不重复做模块开关。
export const LOCKED_MODULES = Object.freeze([
  Object.freeze({ id: "core.tunnel", label: "隧道与本地代理", description: "数据链路本身" }),
  Object.freeze({ id: "core.signals", label: "日志信号与远端端口", description: "卡顿信号与通道恢复判定的数据源" }),
  Object.freeze({ id: "core.resources", label: "服务器资源采集", description: "可在「服务器管理」里按服务器禁用" }),
]);

const DATA_MODULE_IDS = new Set(DATA_MODULES.map((m) => m.id));

// 个人层偏好列表归一：非数组视为空；丢弃非法 id、去重、截断到上限。
// 未知但格式合法的 id 保留——Agent 暂时从团队配置消失时不洗掉用户偏好。
export function normalizePreferenceIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !PREFERENCE_ID_PATTERN.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length >= MAX_PREFERENCE_IDS) break;
  }
  return out;
}

// 写入前的严格校验：任一元素非法即拒绝（不静默丢弃用户提交的内容）。
export function validatePreferenceIds(value) {
  if (!Array.isArray(value)) return { ok: false, message: "必须是字符串数组" };
  if (value.length > MAX_PREFERENCE_IDS) return { ok: false, message: `最多 ${MAX_PREFERENCE_IDS} 项` };
  if (!value.every((item) => typeof item === "string" && PREFERENCE_ID_PATTERN.test(item))) {
    return { ok: false, message: "包含非法 id" };
  }
  return { ok: true, value: [...new Set(value)] };
}

// 个人层原始对象是否是「旧偏好」（v2.56 及以前写的，没记的项一律视为开着）。规则见文件头。
export function isLegacyModulePreferences(personal) {
  if (!personal || typeof personal !== "object" || Array.isArray(personal)) return false;
  if (personal.modulePrefsVersion === MODULE_PREFS_VERSION) return false;
  return Array.isArray(personal.disabledModules) || Array.isArray(personal.hiddenPanels);
}

// 团队层是否默认开启该 Agent（缺省为开）。
export function agentDefaultEnabled(agent) {
  return agent?.defaultEnabled !== false;
}

// 归一化配置（normalizeAgentConfig 的输出）→ 叠加模块偏好后的运行配置：
//   agentCatalog   全部 Agent（含被关掉的），带 enabled / defaultEnabled 布尔，供设置页列开关
//   agents         只含启用的 Agent——下游所有读 cfg.agents 的地方自动只看到启用项
//   activeAgentId  原值启用则保留；否则取第一个启用的 Agent；全关为 ""
//   modules        { usage, jobs, daemons } 数据采集模块是否启用
//   disabledModules / enabledModules / hiddenPanels  归一后的个人偏好
//   legacyModuleDefaults  个人层是旧偏好（preferences-store.pickPreferences 从个人层原始对象判定）
// Agent 启用判定：显式关 > 显式开 > 团队默认（旧偏好时团队默认关的也按开）。纯函数，不改入参。
export function applyModulePreferences(config) {
  const disabledModules = normalizePreferenceIds(config?.disabledModules);
  const enabledModules = normalizePreferenceIds(config?.enabledModules);
  const hiddenPanels = normalizePreferenceIds(config?.hiddenPanels);
  const legacyModuleDefaults = config?.legacyModuleDefaults === true;
  const disabled = new Set(disabledModules);
  const explicitlyOn = new Set(enabledModules);
  const isAgentEnabled = (agent) => {
    const id = agentModuleId(agent.id);
    if (disabled.has(id)) return false;
    if (explicitlyOn.has(id)) return true;
    return agentDefaultEnabled(agent) || legacyModuleDefaults;
  };
  const allAgents = Array.isArray(config?.agents) ? config.agents : [];
  const agentCatalog = allAgents.map((agent) => ({ ...agent, enabled: isAgentEnabled(agent), defaultEnabled: agentDefaultEnabled(agent) }));
  const agents = allAgents.filter(isAgentEnabled);
  const activeAgentId = agents.some((agent) => agent.id === config?.activeAgentId)
    ? config.activeAgentId
    : (agents[0]?.id || "");
  const modules = Object.fromEntries(DATA_MODULES.map((m) => [m.id, !disabled.has(m.id)]));
  return { ...config, agents, agentCatalog, activeAgentId, modules, disabledModules, enabledModules, hiddenPanels, legacyModuleDefaults };
}

// 运行配置 → 要落盘的显式偏好 { disabledModules, enabledModules }。旧偏好在这里物化：
// 团队默认关、靠旧语义开着的 Agent 补进 enabledModules（写盘时 preferences-store 再打上版本号）。
export function explicitModulePreferences(config) {
  const disabledModules = normalizePreferenceIds(config?.disabledModules);
  const enabledModules = normalizePreferenceIds(config?.enabledModules);
  if (config?.legacyModuleDefaults === true) {
    for (const agent of config?.agentCatalog || []) {
      const id = agentModuleId(agent.id);
      if (agent.enabled === true && agent.defaultEnabled === false && !enabledModules.includes(id)) enabledModules.push(id);
    }
  }
  return { disabledModules, enabledModules };
}

// 数据采集模块是否启用（缺省全开：旧配置 / 测试替身没有 modules 字段时为 true）。
export function isDataModuleEnabled(config, moduleId) {
  return config?.modules?.[moduleId] !== false;
}

// 设置页「监控模块」目录：Agent 组 + 数据采集组 + 核心说明组。
export function buildModuleCatalog(config) {
  const disabled = new Set(normalizePreferenceIds(config?.disabledModules));
  const agentEntries = (config?.agentCatalog || []).map((agent) => {
    const hint = adapterForAgent(agent)?.moduleHint || {};
    return {
      id: agentModuleId(agent.id),
      group: "agent",
      label: agent.name || agent.id,
      description: hint.description || "",
      cost: hint.cost || "",
      warning: hint.disableWarning || "",
      enabled: agent.enabled !== false,
      defaultEnabled: agent.defaultEnabled !== false,
      locked: false,
    };
  });
  const dataEntries = DATA_MODULES.map((m) => ({
    id: m.id, group: "data", label: m.label, description: m.description, cost: m.cost, warning: "",
    enabled: !disabled.has(m.id), defaultEnabled: true, locked: false,
  }));
  const lockedEntries = LOCKED_MODULES.map((m) => ({
    id: m.id, group: "core", label: m.label, description: m.description, cost: "", warning: "",
    enabled: true, defaultEnabled: true, locked: true,
  }));
  return [...agentEntries, ...dataEntries, ...lockedEntries];
}

// 可开关的模块 id 是否存在于当前目录（锁定项与未知 id 均不可写）。
export function isToggleableModule(config, moduleId) {
  if (DATA_MODULE_IDS.has(moduleId)) return true;
  if (typeof moduleId !== "string" || !moduleId.startsWith(AGENT_PREFIX)) return false;
  const agentId = moduleId.slice(AGENT_PREFIX.length);
  return (config?.agentCatalog || []).some((agent) => agent.id === agentId);
}

// 在偏好列表上切换一项，返回新列表（保留其它未知 id）。
export function toggleDisabledModule(disabledModules, moduleId, enabled) {
  const current = normalizePreferenceIds(disabledModules).filter((id) => id !== moduleId);
  return enabled ? current : [...current, moduleId];
}

// v2.57 双向切换：先从两张表里都拿掉，再记进代表本次选择的那张（总是显式记录、不依赖当时的默认值——
// 团队以后改默认也不会翻转用户亲手做过的选择）。返回 { disabledModules, enabledModules }。
export function toggleModulePreference({ disabledModules, enabledModules } = {}, moduleId, enabled) {
  const off = normalizePreferenceIds(disabledModules).filter((id) => id !== moduleId);
  const on = normalizePreferenceIds(enabledModules).filter((id) => id !== moduleId);
  return enabled
    ? { disabledModules: off, enabledModules: [...on, moduleId] }
    : { disabledModules: [...off, moduleId], enabledModules: on };
}
