import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createConfigManager, createKernelConfigBridge } from "./config-hot-reload.mjs";
import { loadLayeredConfig } from "./config-loader.mjs";
import { createIncidentStore } from "./incidents/store.mjs";

// 拆分动机：配置缓存 / active 切换 / 热载进内核此前封在 monitor-server.mjs 的 if(isMain)
// 块内不可单测。这里 loadLayeredConfig / writeActiveSelection 全部注入 mock，不碰磁盘。

const CONFIG_PATH = "/repo/config.json";
const LOCAL_CONFIG_PATH = "/data/config.local.json";

function lifecycleManagerHarness() {
  const files = { team: JSON.stringify({ servers: [] }), personal: JSON.stringify({ servers: [] }) };
  const manager = createConfigManager({
    configPath: CONFIG_PATH, localConfigPath: LOCAL_CONFIG_PATH,
    loadLayeredConfigImpl: args => loadLayeredConfig({
      ...args, readFileSync: file => file === CONFIG_PATH ? files.team : files.personal, onLocalError: () => {},
    }),
  });
  return { files, manager };
}

test("incident lifecycle snapshot keeps same-read server/tombstone pairing when an older reload resumes after restore", async () => {
  const { files, manager } = lifecycleManagerHarness();
  files.personal = JSON.stringify({ servers: [{ id: "box", host: "box.invalid", disabled: true, tunnel: false, sshUser: "me" }] });
  await manager.loadConfig();
  const store = createIncidentStore({ openGate: {}, now: () => 1000 });
  store.syncServerLifecycle(manager.getIncidentServerLifecycle());
  const incident = store.observe({ serverId: "box", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  files.personal = JSON.stringify({ servers: [], _serverTombstones: [{ id: "box", removedAt: 999, snapshot: { authRef: "vault:private" } }] });
  await manager.loadConfig();
  store.syncServerLifecycle(manager.getIncidentServerLifecycle());
  assert.equal(store.counts().open, 0);
  const olderRead = manager.loadConfig();
  files.personal = JSON.stringify({ servers: [{ id: "box", host: "box.invalid", disabled: true, tunnel: false, sshUser: "me" }], _serverTombstones: [] });
  await manager.loadConfig();
  assert.deepEqual((await olderRead).servers, [], "old caller still holds the removed configuration");
  const latest = manager.getIncidentServerLifecycle();
  assert.deepEqual(latest, { servers: [{ id: "box", disabled: true }], tombstones: [] });
  store.syncServerLifecycle(latest);
  assert.equal(store.getIncident(incident.incidentId).lifecycle, "open");
  latest.servers.length = 0;
  assert.equal(manager.getIncidentServerLifecycle().servers.length, 1, "getter does not expose mutable internal storage");
});

test("incident lifecycle getter omits private snapshots and stays tied to cached config until a new successful read", async () => {
  const { files, manager } = lifecycleManagerHarness();
  files.personal = JSON.stringify({ _serverTombstones: [{ id: "box", removedAt: 123, snapshot: { host: "private.invalid", authRef: "vault:private" } }] });
  await manager.loadConfig();
  files.personal = JSON.stringify({ servers: [{ id: "later", host: "later.invalid" }], _serverTombstones: [] });
  assert.deepEqual(manager.getIncidentServerLifecycle(), { servers: [], tombstones: [{ id: "box", removedAt: 123 }] });
  assert.equal(JSON.stringify(manager.getCache()).includes("vault:private"), false);
  assert.equal(JSON.stringify(manager.getIncidentServerLifecycle()).includes("private"), false);
});

test("failed or malformed config has no authoritative incident lifecycle snapshot and cannot purge stored history", async () => {
  const { files, manager } = lifecycleManagerHarness();
  files.team = "{";
  await manager.loadConfig();
  assert.equal(manager.getIncidentServerLifecycle(), null);
  files.team = JSON.stringify({ servers: [{ id: "team", host: "team.invalid" }] });
  await manager.loadConfig();
  assert.equal(manager.getIncidentServerLifecycle().servers[0].id, "team");
  for (const invalidTeam of ["null", "[]", '{"servers":{}}']) {
    files.team = invalidTeam;
    await manager.loadConfig();
    assert.equal(manager.getCache().servers[0].id, "team");
    assert.equal(manager.getIncidentServerLifecycle(), null);
  }
  files.team = JSON.stringify({ servers: [{ id: "team", host: "team.invalid" }] });
  await manager.loadConfig();
  files.personal = "{";
  await manager.loadConfig();
  assert.equal(manager.getCache().servers[0].id, "team");
  assert.equal(manager.getIncidentServerLifecycle(), null);
  for (const invalid of [{ _serverTombstones: {} }, { _serverTombstones: [{ id: "box" }] }, { servers: [null] }, { servers: [{ id: "dropped", host: "box.invalid" }] }]) {
    files.personal = JSON.stringify(invalid);
    await manager.loadConfig();
    assert.equal(manager.getIncidentServerLifecycle(), null);
  }
});

function createManagerHarness({ layered, loadImpl } = {}) {
  const logs = [];
  const writes = [];
  let loadCalls = 0;
  const manager = createConfigManager({
    configPath: CONFIG_PATH,
    localConfigPath: LOCAL_CONFIG_PATH,
    appendLog: (message, fields) => logs.push({ message, fields }),
    loadLayeredConfigImpl: (args) => {
      loadCalls += 1;
      if (loadImpl) return loadImpl(args);
      return structuredClone(layered);
    },
    writeActiveSelectionImpl: (args) => writes.push(args),
  });
  return { manager, logs, writes, loadCalls: () => loadCalls };
}

// ---- createConfigManager ----

test("loadConfig: 正常路径归一化并缓存分层配置", async () => {
  const h = createManagerHarness({
    layered: {
      activeServerId: "server-02",
      servers: [
        { id: "server-01", host: "myserver" },
        { id: "server-02", host: "backup" },
      ],
    },
  });

  const parsed = await h.manager.loadConfig();

  assert.equal(parsed.activeServerId, "server-02");
  assert.equal(parsed.servers.length, 2);
  // normalizeAgentConfig 物化 localPort 默认值与默认 agents；remotePort 没有默认值（v2.54：
  // 没领端口就保持缺失，绝不回落 7891）。
  assert.equal(Object.hasOwn(parsed.servers[0], "remotePort"), false);
  assert.equal(parsed.servers[0].localPort, 8888);
  assert.ok(parsed.agents.some((a) => a.id === "codex"));
  assert.equal(h.manager.getCache(), parsed);
});

test("loadConfig: 首次加载失败进入空配置，不意外连接内置服务器", async () => {
  const h = createManagerHarness({
    loadImpl: () => {
      throw new Error("corrupted config");
    },
  });

  const parsed = await h.manager.loadConfig();

  assert.equal(parsed.activeServerId, "");
  assert.deepEqual(parsed.servers, []);
  assert.equal(parsed.activeAgentId, "codex");
  assert.equal(parsed._configLoadError, true);
  assert.equal(parsed._usedBuiltinFallback, true);
});

test("loadConfig: 个人层错误标记保留上一有效服务器，严格保存不误报成功", async () => {
  let localError = false;
  const manager = createConfigManager({
    loadLayeredConfigImpl: () => localError
      ? { servers: [{ id: "team", host: "team.invalid" }], _localConfigError: true }
      : { servers: [{ id: "personal", host: "personal.invalid" }] },
    writePersonalConfigImpl: () => { localError = true; return { revision: 1 }; },
  });
  await manager.loadConfig();
  await assert.rejects(() => manager.savePersonalConfig({}), /配置读取失败/);
  const after = await manager.loadConfig();
  assert.equal(after.servers[0].id, "personal");
  assert.equal(after._configLoadError, true);
});

test("setActiveServerConfig: disabled 节点拒绝选择", async () => {
  const h = createManagerHarness({ layered: { servers: [{ id: "disabled", host: "box.invalid", disabled: true }] } });
  assert.equal(await h.manager.setActiveServerConfig("disabled"), false);
  assert.equal(h.writes.length, 0);
});

test("loadConfig: 已有成功快照时加载失败保留快照，不回落默认服务器", async () => {
  let fail = false;
  const h = createManagerHarness({
    loadImpl: () => {
      if (fail) throw new Error("corrupted later");
      return {
        activeServerId: "server-02",
        servers: [{ id: "server-02", host: "keep-me", remotePort: 7893, localPort: 8890 }],
      };
    },
  });
  const first = await h.manager.loadConfig();
  assert.equal(first.activeServerId, "server-02");
  fail = true;
  const second = await h.manager.loadConfig();
  assert.equal(second.activeServerId, "server-02");
  assert.equal(second.servers[0].host, "keep-me");
  assert.equal(second._configLoadError, true);
  assert.equal(second._usedBuiltinFallback, undefined);
});

test("getConfig: 命中缓存不重复读盘；loadConfig 强制重读", async () => {
  const h = createManagerHarness({ layered: { servers: [] } });

  await h.manager.getConfig();
  await h.manager.getConfig();
  assert.equal(h.loadCalls(), 1);

  await h.manager.loadConfig();
  assert.equal(h.loadCalls(), 2);
});

test("setActiveServerConfig: 合法 id → 只写个人层 activeServerId 补丁并刷新缓存", async () => {
  const h = createManagerHarness({
    layered: {
      activeServerId: "server-01",
      servers: [
        { id: "server-01", host: "myserver" },
        { id: "server-02", host: "backup" },
      ],
    },
  });

  const ok = await h.manager.setActiveServerConfig("server-02", { operationId: "op-1" });

  assert.equal(ok, true);
  assert.deepEqual(h.writes, [{ localConfigPath: LOCAL_CONFIG_PATH, patch: { activeServerId: "server-02" } }]);
  assert.ok(h.logs.some((l) => l.message === "updated active server configuration to server-02"));
});

test("setActiveServerConfig: 未知 id → 拒绝且不写盘", async () => {
  const h = createManagerHarness({
    layered: { servers: [{ id: "server-01", host: "myserver" }] },
  });

  const ok = await h.manager.setActiveServerConfig("server-99");

  assert.equal(ok, false);
  assert.equal(h.writes.length, 0);
});

test("setActiveServerConfig: 写入抛异常 → 返回 false 并落失败日志，不向上抛", async () => {
  const logs = [];
  const manager = createConfigManager({
    configPath: CONFIG_PATH,
    localConfigPath: LOCAL_CONFIG_PATH,
    appendLog: (message) => logs.push(message),
    loadLayeredConfigImpl: () => ({ servers: [{ id: "server-01", host: "myserver" }] }),
    writeActiveSelectionImpl: () => {
      throw new Error("disk full");
    },
  });

  const ok = await manager.setActiveServerConfig("server-01");

  assert.equal(ok, false);
  assert.ok(logs.includes("failed to update active server: disk full"));
});

test("setActiveAgentConfig: 默认物化的 agent id 可切换；未知 id 拒绝", async () => {
  const h = createManagerHarness({ layered: { servers: [] } });

  assert.equal(await h.manager.setActiveAgentConfig("claude-codewing"), true);
  assert.deepEqual(h.writes, [{ localConfigPath: LOCAL_CONFIG_PATH, patch: { activeAgentId: "claude-codewing" } }]);
  assert.ok(h.logs.some((l) => l.message === "updated active agent diagnostics to claude-codewing"));

  assert.equal(await h.manager.setActiveAgentConfig("no-such-agent"), false);
  assert.equal(h.writes.length, 1);
});

// ---- createKernelConfigBridge ----

function createBridgeHarness(initialLayered) {
  let layered = initialLayered;
  const setConfigCalls = [];
  const unregistered = [];
  const manager = createConfigManager({
    configPath: CONFIG_PATH,
    localConfigPath: LOCAL_CONFIG_PATH,
    loadLayeredConfigImpl: () => structuredClone(layered),
    writeActiveSelectionImpl: () => {},
  });
  const bridge = createKernelConfigBridge({
    configManager: manager,
    store: { setConfig: (config) => setConfigCalls.push(config) },
    toolkit: {
      // 与真实 toolkit 一致的 id 形状：agent 探针按启用的 Agent，load 探针覆盖全部服务器，
      // validation 只覆盖活跃服务器。
      registerAgentProbes: ({ config }) => config.agents.map((a) => `agent-probe:${a.id}`),
      registerLoadProbes: ({ servers }) => servers.map((s) => `load:${s.id}`),
      registerValidationProbes: ({ servers, activeServerId }) =>
        servers.filter((s) => s.id === activeServerId).map((s) => `validation:${s.id}`),
    },
    scheduler: { unregisterProbe: (id) => unregistered.push(id) },
    getShouldBeRunning: () => true,
    getChannelUp: () => true,
  });
  return {
    manager,
    bridge,
    setConfigCalls,
    unregistered,
    setLayered: (next) => {
      layered = next;
    },
  };
}

test("refreshConfigIntoKernel: 重新灌配置进 state-store，注销已删除的探针、保留仍存在的", async () => {
  const h = createBridgeHarness({
    activeServerId: "server-01",
    servers: [
      { id: "server-01", host: "myserver" },
      { id: "server-02", host: "backup" },
    ],
  });
  const initial = await h.manager.loadConfig();
  h.bridge.registerInitialProbes(initial);

  // 外部编辑：删除 server-01、活跃切到 server-02。
  h.setLayered({ activeServerId: "server-02", servers: [{ id: "server-02", host: "backup" }] });
  const parsed = await h.bridge.refreshConfigIntoKernel();

  assert.equal(parsed.activeServerId, "server-02");
  assert.deepEqual(h.setConfigCalls, [parsed]);
  assert.deepEqual([...h.unregistered].sort(), ["load:server-01", "validation:server-01"]);
  assert.ok(!h.unregistered.includes("load:server-02"));
});

test("refreshConfigIntoKernel: 配置未变化时幂等，不产生任何注销", async () => {
  const h = createBridgeHarness({
    activeServerId: "server-01",
    servers: [{ id: "server-01", host: "myserver" }],
  });
  h.bridge.registerInitialProbes(await h.manager.loadConfig());

  await h.bridge.refreshConfigIntoKernel();
  await h.bridge.refreshConfigIntoKernel();

  assert.equal(h.unregistered.length, 0);
  assert.equal(h.setConfigCalls.length, 2);
});

test("refreshConfigIntoKernel: 无初始基线时也安全（不误注销）", async () => {
  const h = createBridgeHarness({
    activeServerId: "server-01",
    servers: [{ id: "server-01", host: "myserver" }],
  });

  await h.bridge.refreshConfigIntoKernel();

  assert.equal(h.unregistered.length, 0);
});

test("模块偏好：只认个人层 disabledModules，团队层同名字段忽略；单项开关写个人层后重载生效", async () => {
  const files = {
    team: JSON.stringify({ servers: [], disabledModules: ["agent:codex"], agents: [{ id: "zcode", name: "Zcode", kind: "zcode" }] }),
    personal: JSON.stringify({ disabledModules: ["usage"] }),
  };
  const writes = [];
  const logs = [];
  const manager = createConfigManager({
    configPath: CONFIG_PATH, localConfigPath: LOCAL_CONFIG_PATH,
    appendLog: (message) => logs.push(message),
    loadLayeredConfigImpl: args => loadLayeredConfig({
      ...args, readFileSync: file => file === CONFIG_PATH ? files.team : files.personal, onLocalError: () => {},
    }),
    writePersonalPreferencesImpl: ({ patch }) => {
      writes.push(patch);
      files.personal = JSON.stringify({ ...JSON.parse(files.personal), ...patch });
    },
  });
  let cfg = await manager.loadConfig();
  assert.deepEqual(cfg.agents.map(a => a.id), ["codex", "claude-codewing", "zcode"], "团队层的 disabledModules 不生效");
  assert.deepEqual(cfg.modules, { usage: false, jobs: true, daemons: true });

  assert.equal(await manager.setModuleEnabled("agent:zcode", false), true);
  assert.deepEqual(writes.at(-1), { disabledModules: ["usage", "agent:zcode"], enabledModules: [] });
  cfg = await manager.getConfig();
  assert.deepEqual(cfg.agents.map(a => a.id), ["codex", "claude-codewing"]);
  assert.equal(cfg.agentCatalog.find(a => a.id === "zcode").enabled, false);
  assert.match(logs.at(-1), /disabled monitor module agent:zcode/);

  assert.equal(await manager.setModuleEnabled("core.signals", false), false, "锁定项不可写");
  assert.equal(await manager.setModuleEnabled("agent:ghost", false), false, "未知 Agent 不可写");
  assert.equal(writes.length, 1);

  await manager.setHiddenPanels(["view.usage"]);
  assert.deepEqual((await manager.getConfig()).hiddenPanels, ["view.usage"]);
});

// ---- v2.47 模块开关：真实 toolkit 注册器 + 真实 state-store 的热载端到端 ----

function moduleToggleHarness({ team, personal = {} }) {
  const files = { team: JSON.stringify(team), personal: JSON.stringify(personal) };
  const manager = createConfigManager({
    configPath: CONFIG_PATH, localConfigPath: LOCAL_CONFIG_PATH,
    loadLayeredConfigImpl: args => loadLayeredConfig({
      ...args, readFileSync: file => file === CONFIG_PATH ? files.team : files.personal, onLocalError: () => {},
    }),
    writePersonalPreferencesImpl: ({ patch }) => {
      files.personal = JSON.stringify({ ...JSON.parse(files.personal), ...patch });
    },
  });
  // 调度器替身：记录注册 / 注销序列，registered 即当前在册集合。
  const registered = new Map();
  const registerCalls = [];
  const unregistered = [];
  const scheduler = {
    registerProbe: (spec) => { registered.set(spec.id, spec); registerCalls.push(spec.id); },
    unregisterProbe: (id) => { registered.delete(id); unregistered.push(id); },
  };
  return { files, manager, scheduler, registered, registerCalls, unregistered };
}

const MODULE_TEAM = {
  activeServerId: "server-01",
  servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
  agents: [{ id: "zcode", name: "Zcode", kind: "zcode" }],
};

function probeOk(data) {
  const checkedAt = Date.now();
  return { level: "ok", reason: "", data, checkedAt, nextCheckAt: checkedAt + 90000, durationMs: 1, error: false, probeContext: { serverId: "server-01" } };
}

test("模块热载：关闭 Agent → 探针注销、agentsStatus 无该键；重新打开 → 重新注册、状态回到初始「检测中」", async () => {
  const { createChannelToolkit } = await import("./probes.mjs");
  const { createStateStore } = await import("./state-store.mjs");
  const { bus, EVENTS } = await import("./event-bus.mjs");
  const h = moduleToggleHarness({ team: MODULE_TEAM });
  const initial = await h.manager.loadConfig();
  const store = createStateStore({ config: initial });
  try {
    const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: h.manager.getConfig });
    const gates = { getShouldBeRunning: () => true, isChannelOk: () => true };
    const { agentProbeIds } = toolkit.registerProbes({ scheduler: h.scheduler, config: initial, ...gates });
    const bridge = createKernelConfigBridge({ configManager: h.manager, store, toolkit, scheduler: h.scheduler, getShouldBeRunning: gates.getShouldBeRunning, getChannelUp: gates.isChannelOk });
    bridge.registerInitialProbes(initial, { agentProbeIds });
    assert.deepEqual(agentProbeIds, ["doctor", "endpoint", "reclaude", "claude-endpoint", "zcode-status"]);
    assert.equal(h.registerCalls.filter((id) => id === "doctor").length, 1, "基线不重注册");

    // zcode 有过一次真实结论
    bus.emit(EVENTS.PROBE_UPDATED, { id: "zcode-status", layer: "agents", result: probeOk({ ok: true, installed: true, version: "glm 0.13.3", proxyConfig: { state: "ok" }, serverRunning: false, output: "x" }) });
    assert.equal(store.getLegacyStatus().agentsStatus.zcode.health, "ready");

    await h.manager.setModuleEnabled("agent:zcode", false);
    await bridge.refreshConfigIntoKernel();
    assert.deepEqual(h.unregistered, ["zcode-status"], "只注销被关掉的 Agent 的探针");
    assert.ok(!h.registered.has("zcode-status"));
    assert.ok(h.registered.has("log-signals"), "log-signals 永不注销");
    const off = store.getLegacyStatus();
    assert.ok(!("zcode" in off.agentsStatus), "agentsStatus 不残留被关 Agent 的键");
    assert.ok(!("zcode" in store.getLayers().agents));
    assert.ok(!off.agentsOverview.some((a) => a.id === "zcode"));
    assert.equal(h.registerCalls.filter((id) => id === "doctor").length, 1, "未变化的 Agent 不重注册（doctor 自适应节奏不被重置）");

    // 关闭期间迟到的结果被丢弃
    bus.emit(EVENTS.PROBE_UPDATED, { id: "zcode-status", layer: "agents", result: probeOk({ ok: true, installed: true, proxyConfig: { state: "ok" }, output: "late" }) });
    assert.ok(!("zcode" in store.getLegacyStatus().agentsStatus));

    await h.manager.setModuleEnabled("agent:zcode", true);
    await bridge.refreshConfigIntoKernel();
    assert.ok(h.registered.has("zcode-status"), "重新打开后重新注册");
    assert.equal(h.registered.get("zcode-status").layer, "agents");
    assert.equal(typeof h.registered.get("zcode-status").enabled, "function", "熔断门控照常补齐");
    const back = store.getLegacyStatus().agentsStatus.zcode;
    assert.equal(back.health, "waiting", "不复用关闭前的旧结论");
    assert.equal(back.output, "检测中...");
    assert.equal(store.getLayers().agents.zcode.level, "waiting");
  } finally {
    store.dispose();
  }
});

test("模块热载：codex / reclaude 也能关；全关时 activeAgentId 为空、只剩 processes + log-signals", async () => {
  const { createChannelToolkit } = await import("./probes.mjs");
  const h = moduleToggleHarness({ team: MODULE_TEAM, personal: { disabledModules: ["agent:codex", "agent:claude-codewing", "agent:zcode"] } });
  const config = await h.manager.loadConfig();
  assert.equal(config.activeAgentId, "");
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: h.manager.getConfig });
  const { agentProbeIds } = toolkit.registerProbes({ scheduler: h.scheduler, config, getShouldBeRunning: () => true, isChannelOk: () => true });
  assert.deepEqual(agentProbeIds, []);
  assert.deepEqual([...h.registered.keys()], ["processes", "log-signals"]);
});

test("模块热载：usage / jobs 关闭 → 对应探针注销；打开 → 重新注册", async () => {
  const { createChannelToolkit } = await import("./probes.mjs");
  const h = moduleToggleHarness({ team: MODULE_TEAM });
  const initial = await h.manager.loadConfig();
  const toolkit = createChannelToolkit({ rootDir: "/tmp", getConfig: h.manager.getConfig, usageStore: {} });
  const bridge = createKernelConfigBridge({
    configManager: h.manager, store: { setConfig() {} }, toolkit, scheduler: h.scheduler,
    getShouldBeRunning: () => true, getChannelUp: () => true,
  });
  bridge.registerInitialProbes(initial);
  assert.ok(h.registered.has("usage:server-01") && h.registered.has("jobs:server-01"));

  await h.manager.setModuleEnabled("usage", false);
  await bridge.refreshConfigIntoKernel();
  assert.deepEqual(h.unregistered, ["usage:server-01"]);
  assert.ok(h.registered.has("jobs:server-01") && h.registered.has("collect:slow:server-01"));

  await h.manager.setModuleEnabled("jobs", false);
  await bridge.refreshConfigIntoKernel();
  assert.deepEqual(h.unregistered, ["usage:server-01", "jobs:server-01"]);

  await h.manager.setModuleEnabled("usage", true);
  await bridge.refreshConfigIntoKernel();
  assert.ok(h.registered.has("usage:server-01"));
  assert.ok(!h.registered.has("jobs:server-01"));
});

// ---------------------------------------------------------------------------
// v2.57 团队默认关 + 旧偏好迁移：真实团队 config.json + 真实个人层文件读写（临时目录）
// ---------------------------------------------------------------------------

const REPO_TEAM_CONFIG = fileURLToPath(new URL("../../../config.json", import.meta.url));

function realManager(personal) {
  const localConfigPath = path.join(mkdtempSync(path.join(tmpdir(), "prefs-migrate-")), "config.local.json");
  if (personal) writeFileSync(localConfigPath, JSON.stringify(personal));
  const manager = createConfigManager({ configPath: REPO_TEAM_CONFIG, localConfigPath, appendLog: () => {} });
  const enabled = async () => (await manager.getConfig()).agentCatalog.filter((a) => a.enabled).map((a) => a.id).sort();
  return { manager, enabled, readPersonal: () => JSON.parse(readFileSync(localConfigPath, "utf8")) };
}

test("kai 升级（真实团队 config.json）：旧个人层 disabledModules:[agent:zcode] → reclaude 仍开；任一偏好写入后物化并保持", async () => {
  const { manager, enabled, readPersonal } = realManager({
    activeServerId: "server-01",
    portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } },
    proxyAllowedTargets: ["api.relay-demo.example:9443"],
    disabledModules: ["agent:zcode"],
    revision: 7,
  });
  await manager.loadConfig({ strict: true });
  assert.deepEqual(await enabled(), ["claude-code", "claude-codewing", "codex"]);

  // 只改界面面板：旧偏好随之物化，reclaude 不会因为「打上新版本号」被关掉
  await manager.setHiddenPanels(["view.usage"]);
  let saved = readPersonal();
  assert.equal(saved.modulePrefsVersion, 2);
  assert.deepEqual(saved.enabledModules, ["agent:claude-codewing"]);
  assert.deepEqual(saved.disabledModules, ["agent:zcode"]);
  assert.deepEqual(saved.portOverrides, { "server-01": { remotePort: 7891, localPort: 8888 } }, "其它个人字段原样保留");
  assert.deepEqual(await enabled(), ["claude-code", "claude-codewing", "codex"]);

  // 之后照常双向开关
  await manager.setModuleEnabled("agent:claude-codewing", false);
  assert.deepEqual(await enabled(), ["claude-code", "codex"]);
  await manager.setModuleEnabled("agent:zcode", true);
  saved = readPersonal();
  assert.deepEqual(saved.enabledModules, ["agent:zcode"]);
  assert.deepEqual(saved.disabledModules, ["agent:claude-codewing"]);
  assert.deepEqual(await enabled(), ["claude-code", "codex", "zcode"]);
});

test("kai 升级（真实团队 config.json）：第一次写入就是模块开关时同样先物化", async () => {
  const { manager, enabled, readPersonal } = realManager({ disabledModules: ["agent:zcode"] });
  await manager.loadConfig({ strict: true });
  await manager.setModuleEnabled("usage", false);
  const saved = readPersonal();
  assert.deepEqual(saved.enabledModules, ["agent:claude-codewing"]);
  assert.deepEqual(saved.disabledModules, ["agent:zcode", "usage"]);
  assert.deepEqual(await enabled(), ["claude-code", "claude-codewing", "codex"]);
});

test("新同事（真实团队 config.json）：向导写的个人层没有偏好字段 → reclaude / zcode 关；可在设置里打开", async () => {
  for (const personal of [null, { sshUser: "simple", portOverrides: { "server-01": { remotePort: 7892, localPort: 8888 } } }]) {
    const { manager, enabled, readPersonal } = realManager(personal);
    await manager.loadConfig({ strict: true });
    assert.deepEqual(await enabled(), ["claude-code", "codex"]);
    assert.equal(await manager.setModuleEnabled("agent:claude-codewing", true), true);
    assert.deepEqual(readPersonal().enabledModules, ["agent:claude-codewing"]);
    assert.deepEqual(await enabled(), ["claude-code", "claude-codewing", "codex"]);
    // 面板偏好写入不会把新同事变成「旧偏好」（版本号已打上）
    assert.equal(await manager.setModuleEnabled("agent:claude-codewing", false), true);
    await manager.setHiddenPanels(["view.usage"]);
    assert.deepEqual(await enabled(), ["claude-code", "codex"]);
  }
});

// v2.57 终审：noProxyExtra 的写入校验从 config-loader（数据面指纹闭包内）挪到控制面的 personal-config-write。
// 默认装配必须接到新的写入口——否则登录引导保存的内网直连名单会被 config-loader 那份悄悄丢掉。
test("savePersonalConfig 默认走 personal-config-write：noProxyExtra 校验后落盘，不合法拒绝；合并后的运行配置不带它", async () => {
  const { manager, readPersonal } = realManager({ activeServerId: "server-01", revision: 3 });
  await manager.loadConfig({ strict: true });
  await manager.savePersonalConfig({ noProxyExtra: { "server-01": ["10.0.0.5", "10.0.0.5"] }, expectedRevision: 3 });
  assert.deepEqual(readPersonal().noProxyExtra, { "server-01": ["10.0.0.5"] });
  assert.deepEqual(manager.getPersonalConfig().noProxyExtra, { "server-01": ["10.0.0.5"] });
  await assert.rejects(
    () => manager.savePersonalConfig({ noProxyExtra: { "server-01": ["a b"] }, expectedRevision: 4 }),
    (err) => err.name === "ConfigValidationError" && err.errors[0].field === "noProxyExtra.server-01",
  );
  assert.deepEqual(readPersonal().noProxyExtra, { "server-01": ["10.0.0.5"] });
  assert.equal(Object.hasOwn(await manager.getConfig(), "noProxyExtra"), false);
});
