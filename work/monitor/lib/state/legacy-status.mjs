import { buildNetworkChannel } from "../../monitor-core.mjs";
import { copyBridgeStages } from "./bridge-stages.mjs";

// /api/status（getLegacyStatus）与 status-lite（getLiteStatus）的兼容契约。
// 旧字段与 v1.5.2 同构；T02 起的 summary / readiness / bridgeStages 等是加法演进。
// **键的集合与顺序即契约**（前端、托盘、悬浮岛、旧脚本都按它取值），改动必须同步
// state-store.test 的 golden 键序用例。这里只做组装，所有判定在调用方算好传入。

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function formatLogTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// 活跃服务器（按裸 activeServerId 取 serversBrief）的负载摘要。
function remoteLoadOf(activeBrief) {
  return {
    ok: activeBrief ? activeBrief.ok : false,
    output: activeBrief ? activeBrief.output : "",
  };
}

// 旧 activeServer：按裸 activeServerId 找，找不到回落第一条（含屏蔽条目，v1.5.2 语义）。
function legacyActiveServer(config) {
  return (config.servers || []).find((s) => s.id === config.activeServerId) || (config.servers || [])[0] || null;
}

// 入参：
//   core         { updatedAt, health, summary, shouldBeRunning, flags }——两份输出共用的头部
//   activeBrief  serversBrief[config.activeServerId]
//   adapterLegacy 各适配器的旧版顶层字段（codex: doctor/endpoint；reclaude: claudeEndpoint），
//                注册序决定键序
export function buildLegacyStatus({
  core, readiness, processes, remotePort, adapterLegacy, activeBrief, config,
  agentsStatus, agentsOverview, mainServer, proxyPort = null, bridgeStages, serversBrief, logEntries,
}) {
  const { flags } = core;
  return {
    updatedAt: core.updatedAt,
    health: core.health,
    // T02：与 lite 同构的 summary（加法演进，旧字段一律不动）。
    summary: core.summary,
    readiness,
    shouldBeRunning: core.shouldBeRunning,
    supervisorUp: flags.supervisorUp,
    localProxyUp: flags.localProxyUp,
    tunnelUp: flags.tunnelUp,
    remotePortOpen: flags.remotePortOpen,
    processes,
    remotePort,
    ...adapterLegacy,
    remoteLoad: remoteLoadOf(activeBrief),
    activeServerId: config.activeServerId,
    activeAgentId: config.activeAgentId,
    activeServer: legacyActiveServer(config),
    agents: config.agents || [],
    // v2.47 可拔插模块：全部 Agent（含被关掉的，带 enabled）、数据采集模块开关、隐藏面板。
    agentCatalog: config.agentCatalog || config.agents || [],
    modules: config.modules || {},
    hiddenPanels: config.hiddenPanels || [],
    agentsStatus,
    agentsOverview,
    networkChannel: buildNetworkChannel({
      shouldBeRunning: core.shouldBeRunning,
      localProxyUp: flags.localProxyUp,
      tunnelUp: flags.tunnelUp,
      remotePortOpen: flags.remotePortOpen,
      server: Number.isInteger(proxyPort) ? { ...mainServer, localPort: proxyPort } : mainServer,
    }),
    bridgeStages: copyBridgeStages(bridgeStages),
    serversBrief,
    log: logEntries.map((entry) => `${formatLogTime(entry.ts)} ${entry.message}`),
  };
}

export function buildLiteStatus({ core, activeBrief, config, recentTransitions, activeSignals, bridgeStages }) {
  const { flags } = core;
  return {
    updatedAt: core.updatedAt,
    health: core.health,
    // T02：托盘/悬浮岛与主窗口共用同一份 summary（同构输出，不各自实现判断）。
    summary: core.summary,
    shouldBeRunning: core.shouldBeRunning,
    supervisorUp: flags.supervisorUp,
    localProxyUp: flags.localProxyUp,
    tunnelUp: flags.tunnelUp,
    remotePortOpen: flags.remotePortOpen,
    remoteLoad: remoteLoadOf(activeBrief),
    activeServerId: config.activeServerId,
    activeAgentId: config.activeAgentId,
    // v2.1：状态时间线（最近 5 条 level 变迁）与活动服务器负载快照（Task 4 悬浮岛依赖）。
    recentTransitions,
    activeServerLoad: activeBrief ? { cpu: activeBrief.cpu, ram: activeBrief.ram, disk: activeBrief.disk } : null,
    // 同 getLayers().signals.active：无 data（探针超时/SSH 失败）时回退到最近已知信号快照。
    activeSignals,
    bridgeStages: copyBridgeStages(bridgeStages),
  };
}
