import { readFileSync } from "node:fs";
import { normalizeAgentConfig } from "../monitor-core.mjs";
import {
  ConfigValidationError,
  isServerEnabled,
  loadLayeredConfig as defaultLoadLayeredConfig,
  writeActiveSelection as defaultWriteActiveSelection,
} from "./config-loader.mjs";
// 个人层整份写入走控制面的包装（多管一个 noProxyExtra，见 personal-config-write.mjs 文件头）。
import { writePersonalConfig as defaultWritePersonalConfig } from "./personal-config-write.mjs";
import { applyModulePreferences, explicitModulePreferences, isToggleableModule, toggleModulePreference } from "./modules/catalog.mjs";
import { pickPreferences, writePersonalPreferences as defaultWritePersonalPreferences } from "./modules/preferences-store.mjs";
import { isBoundedServerId } from "./validators.mjs";

// 配置缓存与活跃选择写入。
//
// 注意：活跃选择（activeServerId/activeAgentId）只写个人层 config.local.json——
// 绝不把 normalizeAgentConfig 的归一化结果（回落的 host/port、物化的默认 agents）
// 持久化回盘，也绝不改写团队 config.json，否则一次 UI 切换就会永久改写团队/用户手写的配置。
export function createConfigManager({
  configPath,
  localConfigPath,
  appendLog = () => {},
  loadLayeredConfigImpl = defaultLoadLayeredConfig,
  writeActiveSelectionImpl = defaultWriteActiveSelection,
  writePersonalConfigImpl = defaultWritePersonalConfig,
  writePersonalPreferencesImpl = defaultWritePersonalPreferences,
} = {}) {
  let configCache = null;
  const incidentLifecycleByConfig = new WeakMap();

  function readValidConfig() {
    let personal = null;
    const loaded = loadLayeredConfigImpl({ configPath, localConfigPath, onPersonalConfig: value => { personal = value; } });
    if (loaded?._localConfigError) throw new ConfigValidationError("个人配置读取失败，已保留上一有效配置");
    // 模块偏好只取自个人层原始对象（合并结果里可能混入团队层同名字段）。
    const normalized = applyModulePreferences({ ...normalizeAgentConfig(loaded), ...pickPreferences(personal) });
    const normalizedServerIds = new Set(normalized.servers.map(server => server?.id));
    const tombstones = personal?._serverTombstones ?? [];
    // 回收站和服务器必须来自同次同步读取；损坏/非权威数据不能被当成空回收站。
    const validPersonalServers = personal?.servers === undefined
      || (Array.isArray(personal.servers) && personal.servers.every(server => isBoundedServerId(server?.id) && normalizedServerIds.has(server.id)));
    if (personal && typeof personal === "object" && !Array.isArray(personal)
      && validPersonalServers && normalized.servers.every(server => isBoundedServerId(server?.id))
      && Array.isArray(tombstones) && tombstones.every(item => isBoundedServerId(item?.id) && Number.isFinite(item.removedAt) && item.removedAt >= 0)) {
      incidentLifecycleByConfig.set(normalized, {
        servers: normalized.servers.map(server => ({ id: server.id, disabled: server.disabled === true })),
        tombstones: tombstones.map(item => ({ id: item.id, removedAt: item.removedAt })),
      });
    }
    return normalized;
  }

  async function loadConfig({ strict = false } = {}) {
    try {
      configCache = readValidConfig();
    } catch {
      // 故意不绑定 err：JSON 解析错误文本可能包含配置原文，不将其返回前端或日志。
      const message = "配置读取失败，请检查配置文件；运行配置未切换";
      if (strict) throw new ConfigValidationError(message);
      if (configCache) {
        configCache = { ...configCache, _configLoadError: true, _configLoadErrorMessage: message };
        return configCache;
      }
      configCache = applyModulePreferences(normalizeAgentConfig({
        activeServerId: "",
        servers: [],
        _configLoadError: true,
        _usedBuiltinFallback: true,
        _configLoadErrorMessage: message,
      }));
    }
    return configCache;
  }

  async function getConfig() {
    return configCache || loadConfig();
  }

  // 活跃服务器 / 诊断 agent 切换共用：校验 id → 只写个人层补丁 → 严格重载缓存；
  // 失败只落日志并返回 false。日志文案保持原样（前端日志面板按它归类）。
  async function setActiveSelection({ field, label, noun, isValid }, id, context) {
    try {
      if (!isValid(readValidConfig(), id)) return false;
      writeActiveSelectionImpl({ localConfigPath, patch: { [field]: id } });
      await loadConfig({ strict: true });
      appendLog(`updated active ${label} ${noun} to ${id}`, context);
      return true;
    } catch (err) {
      appendLog(`failed to update active ${label}: ${err.message}`, context);
      return false;
    }
  }

  const setActiveServerConfig = (serverId, context) => setActiveSelection(
    { field: "activeServerId", label: "server", noun: "configuration", isValid: isServerEnabled },
    serverId,
    context,
  );

  const setActiveAgentConfig = (agentId, context) => setActiveSelection(
    { field: "activeAgentId", label: "agent", noun: "diagnostics", isValid: (config, id) => config.agents.some((a) => a.id === id) },
    agentId,
    context,
  );

  // 设置页「监控模块」单项开关：只改这一项的显式选择（其它窗口的修改不被整表覆盖）。
  // 旧偏好在这里物化（靠旧语义开着的 Agent 补进 enabledModules，见 modules/catalog.mjs 文件头）。
  // 返回 false 表示 id 不可开关（未知 / 锁定）；写盘失败抛 ConfigValidationError。
  async function setModuleEnabled(moduleId, enabled, context) {
    const current = readValidConfig();
    if (!isToggleableModule(current, moduleId)) return false;
    const patch = toggleModulePreference(explicitModulePreferences(current), moduleId, enabled === true);
    writePersonalPreferencesImpl({ localConfigPath, patch });
    await loadConfig({ strict: true });
    appendLog(`${enabled ? "enabled" : "disabled"} monitor module ${moduleId}`, context);
    return true;
  }

  // 设置页「界面面板」：整表写入隐藏面板列表（面板目录归前端，后端只校验格式）。
  // 写入会打上新的偏好版本号，旧偏好要一并物化——否则 reclaude 会因「不再是旧偏好」被悄悄关掉。
  async function setHiddenPanels(hiddenPanels, context) {
    const current = readValidConfig();
    const modulePatch = current.legacyModuleDefaults ? explicitModulePreferences(current) : {};
    writePersonalPreferencesImpl({ localConfigPath, patch: { ...modulePatch, hiddenPanels } });
    await loadConfig({ strict: true });
    appendLog("updated hidden panels", context);
  }

  async function savePersonalConfig(patch, context) {
    const currentConfig = readValidConfig();
    const teamServerIds = (currentConfig.servers || []).filter((s) => s?.source !== "personal").map((s) => s.id);
    const saved = await writePersonalConfigImpl({
      localConfigPath,
      patch,
      expectedRevision: patch?.expectedRevision ?? patch?.revision,
      teamServerIds,
    });
    await loadConfig({ strict: true });
    appendLog("updated personal configuration", context);
    return saved;
  }

  return {
    loadConfig,
    getConfig,
    getCache: () => configCache,
    getIncidentServerLifecycle: () => {
      if (!configCache || configCache._configLoadError || configCache._localConfigError || configCache._usedBuiltinFallback) return null;
      const snapshot = incidentLifecycleByConfig.get(configCache);
      return snapshot ? structuredClone(snapshot) : null;
    },
    setActiveServerConfig,
    setActiveAgentConfig,
    setModuleEnabled,
    setHiddenPanels,
    savePersonalConfig,
    getPersonalConfig: () => {
      try { return JSON.parse(readFileSync(localConfigPath, "utf8")); }
      catch (err) { if (err.code === "ENOENT") return {}; throw new Error("个人配置无法读取，请检查文件格式"); }
    },
  };
}

// 配置 → 内核桥：把（重新）加载的配置灌进 state-store，并按当前服务器 / agents / 模块集合
// 注册 agent / load / validation 三组探针、注销已从配置中消失的旧探针，避免僵尸调度。
// registerInitialProbes 建立首次注册的探针 id 基线；refreshConfigIntoKernel 为热载入口
// （maintenanceSweep 的 mtime 侦测与 /api/config/*、/api/modules 写路径都走它）。
export function createKernelConfigBridge({
  configManager,
  store,
  toolkit,
  scheduler,
  getShouldBeRunning,
  getChannelUp,
  // agent 探针的熔断门：生产装配与 validation 同一判据（通道 ok）。
  isChannelOk = getChannelUp,
}) {
  let agentProbeIds = [];
  let loadProbeIds = [];
  let validationProbeIds = [];

  // agent 探针：只注册本轮新启用的适配器（已在册的不重注册，见 registerAgentProbes 注释），
  // 返回本轮应存活的全部 agent 探针 id。
  function registerAgents(config) {
    return toolkit.registerAgentProbes({
      scheduler,
      config,
      getShouldBeRunning,
      isChannelOk,
      alreadyRegistered: agentProbeIds,
    });
  }

  // 按配置（重新）注册探针；registerProbe 以 id 覆盖，幂等。返回该轮应存活的 id 列表。
  function registerLoad(config) {
    return toolkit.registerLoadProbes({
      scheduler,
      servers: config.servers,
      activeServerId: config.activeServerId,
      modules: config.modules,
      getShouldBeRunning,
    });
  }

  function registerValidation(config) {
    return toolkit.registerValidationProbes({
      scheduler,
      servers: config.servers,
      agents: config.agents,
      activeServerId: config.activeServerId,
      getShouldBeRunning,
      getChannelUp,
    });
  }

  // 注销上一轮有、这一轮没有的探针（服务器被删 / 不再活跃 / 模块被关），返回新的存活集合。
  function replaceProbeIds(previousIds, nextIds) {
    for (const id of previousIds) {
      if (!nextIds.includes(id)) scheduler.unregisterProbe(id);
    }
    return nextIds;
  }

  // agentProbeIds：启动时 toolkit.registerProbes 已按同一份配置注册过 agent 探针，传入其返回值
  // 作基线（不重注册，保持 processes → agents → log-signals 的注册序）；缺省则在此注册。
  function registerInitialProbes(config, { agentProbeIds: initialAgentProbeIds } = {}) {
    agentProbeIds = Array.isArray(initialAgentProbeIds) ? [...initialAgentProbeIds] : registerAgents(config);
    loadProbeIds = registerLoad(config);
    validationProbeIds = registerValidation(config);
  }

  async function refreshConfigIntoKernel() {
    const parsed = await configManager.loadConfig();
    // 先灌状态（清掉被关 Agent 的状态 / 为重新打开的 Agent 建「检测中」初态），再增删探针：
    // 两步之间迟到的旧结果由 state-store 的启用门控丢弃。
    store.setConfig(parsed);
    // 热载：按当前启用的 Agent 注册 / 注销 agent 探针；注册当前服务器集合的 load 探针，并注销
    // 已从配置中删除（或所属模块被关）的旧 load 探针，避免僵尸调度；再注册当前活跃服务器的
    // validation 探针并清理其余别名探针。
    agentProbeIds = replaceProbeIds(agentProbeIds, registerAgents(parsed));
    loadProbeIds = replaceProbeIds(loadProbeIds, registerLoad(parsed));
    validationProbeIds = replaceProbeIds(validationProbeIds, registerValidation(parsed));
    return parsed;
  }

  return { registerInitialProbes, refreshConfigIntoKernel };
}
