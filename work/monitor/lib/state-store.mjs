import { bus, EVENTS } from "./event-bus.mjs";
import { queryLogs } from "./logger.mjs";
import { adapterForProbeId, agentAdapterEnabled, listAgentAdapters } from "./agents/registry.mjs";
import { buildAgentOverview, classifyHealth } from "../monitor-core.mjs";
import { buildReadiness, buildStatusSummary } from "./readiness-view.mjs";
import { computeConfigRevision } from "./runtime-snapshot.mjs";
import { isServerEnabled, listEnabledServers, selectMainServer } from "./config-loader.mjs";
import {
  boundServerIdOf,
  COLLECT_SLOW_PREFIX,
  collectSlowProbeId,
  LOG_SIGNALS_PROBE_ID,
  PROCESSES_PROBE_ID,
  VALIDATION_PREFIX,
} from "./probe-ids.mjs";
import { buildAgentsLayer, buildReadinessAgents } from "./state/agents-layer.mjs";
import { createBridgeStages, mergeBridgeSnapshot } from "./state/bridge-stages.mjs";
import {
  buildChannelLayer,
  deriveChannelFlags,
  deriveChannelLevel,
  tunnelSatisfied,
  isMonitorOnly,
  remotePortFromFastResult,
  selectPortEvidence,
} from "./state/channel-layer.mjs";
import { buildLegacyStatus, buildLiteStatus } from "./state/legacy-status.mjs";
import {
  buildResourcesLayer,
  buildSignalsLayer,
  buildValidationLayer,
  resourceExtrasFrom,
} from "./state/resource-layers.mjs";
import { createTransitionRing, diffTransitions, isViewScopedKey, levelMap } from "./state/transitions.mjs";
import { buildTunnelsLayer } from "./state/tunnels-layer.mjs";

// 状态聚合器：订阅 PROBE_UPDATED，把离散探针结果归并为多层状态
// （channel / tunnels / agents / resources / validation / signals），并派生出与 v1.5.2
// 完全同构的旧版 /api/status。任一层的 level 发生变化时，通过事件总线发出
// STATUS_CHANGED { layers, lite, transitions }。
// 本文件只持有可变状态与归并流程；各层投影、旧字段组装、变迁时间线都是 lib/state/ 下的
// 纯函数。agent 专属归并（熔断占位、状态合成、凭证过期透传）由 lib/agents/ 注册表
// 分派到各适配器，不按 id 字符串分支。

// getHandoverStandby() → { serverId: 待命事实 }（v2.88，supervisor 运行快照里本机待命的服务器；同账号另一台 Mac 在承载）。
export function createStateStore({ config, now = Date.now, logSource = "ops", getEffectiveProxyPort = () => null, getHandoverStandby = () => ({}) } = {}) {
  let cfg = config || { servers: [], agents: [] };
  let shouldBeRunning = true;
  // 运行意图为"停"时的说明（v2.64）：自动修复重启整个通道期间由执行器写入、结束即清空；
  // 为 null 时通道层 / 隧道层沿用「通道已手动停止」。只影响原因文案，不影响任何判级。
  let stopNote = null;
  let updatedAt = new Date(now()).toISOString();

  const probeResults = new Map(); // probeId -> 最近一次调度器结果
  const validationByServer = new Map(); // serverId -> validation probe result

  // 与 v1.5.2 globalStateCache 等价的派生状态。
  let channelErrorSince = null; // channel 层 level 进入 error 的时刻（离开即清空）
  let processes = { localProxy: [], reverseTunnel: [], supervisor: [] };
  let remotePort = { ok: false, output: "检测中..." };
  let remotePortOpen = false;
  const fastPortsByServer = new Map(); // serverId -> fast 采集的端口结论 { open, checkedAt }
  // agent 归并状态：kind -> 适配器私有 state（doctor/endpoint/claudeEndpoint 等
  // 旧模块级变量全部收进各适配器的 createInitialState，含熔断跳过旗标）。
  // 惰性创建：适配器可能在 store 创建之后才注册（测试注册 mock 第三 agent）。
  const agentStates = new Map();
  // log-signals 探针最近一次「有 data」结果的信号快照。探针超时/SSH 失败时结果形如
  // { level:"error", reason:"timeout after 15000ms", error:true }（无 data 键）——
  // 若直接拿 result.data 兜底成 []，一次超时就会把仍然活跃的信号（红条）清空、
  // lastActivityAt 清空。网络抖动/慢查询 ≠ 故障消失，这恰恰是 SSH 降级、本功能最该
  // 起作用的场景，绝不能在这种时候把红条抹掉。getLayers/getLiteStatus 在结果无 data
  // 时回退到这里保存的最近已知值；level/reason/checkedAt 仍如实反映本次 error。
  let lastKnownSignalsData = { active: [], lastActivityAt: null };
  // v2.18 slow 采集的旁路数据（GPU / Agent 安装态）：与 serversBrief 一样
  // 只在「本轮确有 data」时刷新。60s 一轮的探针偶发超时不该把 GPU 行抹空——
  // 那和 lastKnownSignalsData 不清空红条是同一个理由。
  const resourceExtras = new Map(); // serverId -> { gpu, agents, usage, slurm, procTop, tunnelEgress }
  const agentExpiry = {}; // agentId -> parseAgentExpiry() 结果（探针 data.expiry 原样透传），无/不可用时为 null
  const agentsStatus = {};
  const serversBrief = {};
  // T02 上下文世代：配置热载/选择变化时 +1，供 readiness.context 与迟到结果隔离。
  let contextGeneration = 0;
  const bridgeStages = createBridgeStages();
  // 多隧道并存后 supervisor 按服务器分别上报 ssh-tunnel 快照（带 serverId）。各自存一份；对外的
  // bridgeStages["ssh-tunnel"] 只给查看中的那台——此前所有隧道挤一个槽位、谁最后上报算谁的，
  // 界面上「重连 N 次」会在两台服务器的计数之间来回跳。
  const tunnelStagesByServer = new Map();
  const transitionRing = createTransitionRing(); // 最近 50 条 {ts, layer, key, from, to, reason}

  function agentStateFor(adapter) {
    if (!agentStates.has(adapter.kind)) agentStates.set(adapter.kind, adapter.createInitialState());
    return agentStates.get(adapter.kind);
  }
  // 适配器 → agentsStatus/agentExpiry 键：配置里有同 kind 条目时用其 id，
  // 否则回落适配器默认 agentId（与 v1.5.2 的 "codex"/"claude-codewing" 字面量一致）。
  function agentIdFor(adapter) {
    const entry = (cfg.agents || []).find((agent) => agent?.kind === adapter.kind);
    return entry ? entry.id : adapter.agentId;
  }
  const resultFor = (probeId) => probeResults.get(probeId);
  const slowResultFor = (serverId) => probeResults.get(collectSlowProbeId(serverId));

  function ensureConfigEntries() {
    for (const agent of cfg.agents || []) {
      if (!agentsStatus[agent.id]) {
        agentsStatus[agent.id] = { ok: false, health: "waiting", output: "检测中..." };
      }
    }
    for (const server of listEnabledServers(cfg)) {
      if (!serversBrief[server.id]) {
        serversBrief[server.id] = {
          name: server.host,
          displayName: server.name,
          ok: false,
          cpu: 0,
          ram: 0,
          disk: 0,
          output: "",
        };
      }
    }
  }
  ensureConfigEntries();

  // 查看视角（config-loader.selectMainServer 同一条回落链）；都没有时返回 {}——
  // 下游一律 main.id / main.tunnel 取值，不必判空。
  function mainServer() {
    return selectMainServer(cfg) || {};
  }

  // 共享代理是 supervisor 的运行时事实。配置切换查看服务器后，配置里的
  // localPort 可能变化，但 supervisor 为了不打断其它隧道会继续使用首拍端口；
  // 只在快照明确给出合法端口时采用它，快照缺失时回落配置值保持旧行为。
  function effectiveProxyPort() {
    try {
      const port = getEffectiveProxyPort();
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
    } catch {
      return null;
    }
  }

  function portEvidence(server) {
    return selectPortEvidence(fastPortsByServer.get(server.id), slowResultFor(server.id), server.remotePort);
  }

  // 远端端口是否已有任何证据。没有证据 ≠ 端口未开放：通道层与 health 据此在本地两段都在时
  // 保持 waiting（见 deriveChannelLevel）；flags.remotePortOpen 仍回落 false，旧字段形状不变。
  function hasPortEvidence(server) {
    return portEvidence(server) != null;
  }

  function standbyFor(serverId) {
    try {
      const map = getHandoverStandby();
      return map && typeof map === "object" && map[serverId] ? map[serverId] : null;
    } catch {
      return null;
    }
  }

  function channelFlags(main = mainServer()) {
    return deriveChannelFlags({
      main,
      shouldBeRunning,
      processes,
      remotePortOpen: portEvidence(main)?.open ?? remotePortOpen,
      handoverStandby: Boolean(main.id && standbyFor(main.id)),
    });
  }

  function computeHealth() {
    const main = mainServer();
    if (isMonitorOnly(main)) {
      if (!shouldBeRunning) return "stopped";
      const sample = slowResultFor(main.id);
      return !sample ? "waiting" : sample.level === "ok" ? "ready" : "degraded";
    }
    // v1.5.2 初始态：首个进程探针到达前保持 waiting。
    if (shouldBeRunning && (!probeResults.get(PROCESSES_PROBE_ID)
      || probeResults.get(PROCESSES_PROBE_ID)?.data?.processQueryIndeterminate === true)) return "waiting";
    const f = channelFlags(main);
    // 同理（与 deriveChannelLevel 同一判据）：本地两段都在、远端端口首个样本未到 → 仍是 waiting，不报 down。
    if (shouldBeRunning && f.localProxyUp && f.tunnelUp && !hasPortEvidence(main)) return "waiting";
    // 各适配器贡献自己的健康聚合片段（codex: endpoint+doctor.summary；
    // reclaude: claudeEndpoint——B2 单/双链路失败都只收敛到 degraded，不判 down）。
    // 未启用的适配器（配置无条目 / 设置页关闭）跳过：不合入片段、也不惰性创建其状态。
    const agentHealthInputs = {};
    for (const adapter of listAgentAdapters()) {
      if (!agentAdapterEnabled(adapter, cfg)) continue;
      Object.assign(agentHealthInputs, adapter.healthInputs(agentStateFor(adapter)));
    }
    return classifyHealth({
      shouldBeRunning,
      supervisorUp: f.supervisorUp,
      localProxyUp: f.localProxyUp,
      // 另一台 Mac 在承载（本机待命）：集群照样出网，隧道这一段按已满足算。
      tunnelUp: tunnelSatisfied(f),
      remotePortOpen: f.remotePortOpen,
      ...agentHealthInputs,
    });
  }

  // 注意：getLayers 有副作用——推进 channelErrorSince（持续断开起点）。
  function getLayers() {
    const main = mainServer();
    const procResult = probeResults.get(PROCESSES_PROBE_ID);
    const flags = channelFlags(main);
    const levelInfo = deriveChannelLevel({
      main,
      shouldBeRunning,
      stopNote,
      hasProcessesResult: Boolean(procResult) && procResult.data?.processQueryIndeterminate !== true,
      hasPortEvidence: hasPortEvidence(main),
      flags,
    });
    const channel = buildChannelLayer({ main, levelInfo, flags, procResult, remoteResult: probeResults.get(LOG_SIGNALS_PROBE_ID), proxyPort: effectiveProxyPort() });

    // 持续断开起点：level 进入 error 时记录、离开清空。前端据此区分
    // "临时故障"与"持续无法连接"（用户常不在 SSH 白名单网络，后者是预期现象）。
    if (channel.level === "error") {
      if (channelErrorSince == null) channelErrorSince = now();
    } else {
      channelErrorSince = null;
    }
    channel.detail.downSinceMs = channelErrorSince;

    const servers = listEnabledServers(cfg);
    const agents = buildAgentsLayer({
      config: cfg, agentsStatus, agentExpiry, monitorOnly: isMonitorOnly(main), stateFor: agentStateFor, resultFor,
    });
    const resources = buildResourcesLayer({ servers, slowResultFor, serversBrief, resourceExtras, config: cfg, now: now() });
    const tunnels = buildTunnelsLayer({
      servers,
      mainId: main.id,
      channel,
      flags,
      shouldBeRunning,
      stopNote,
      // parseProcessList 的多隧道分桶（processes 探针只产出 data.processes；旧形状无此键 → null）。
      tunnelsByServer: processes?.tunnelsByServer || null,
      evidenceFor: portEvidence,
      slowResultFor,
      standbyFor,
    });
    const validation = buildValidationLayer({ validationByServer, servers: cfg.servers });
    const signals = buildSignalsLayer(probeResults.get(LOG_SIGNALS_PROBE_ID), lastKnownSignalsData);
    return { channel, tunnels, agents, resources, validation, signals };
  }

  // ---- T02：统一 summary / readiness（主窗口、托盘、悬浮岛共用，不各自判断）----
  // legacy health 与自动修复行为完全不变（readiness-view 只做展示投影）。

  // layers 可显式注入：调用方若已经算过（或需要与其它字段同一份快照），传进来即可，
  // 避免 getSummary → getLayers 与调用方各自再构建一遍整棵层对象。
  function getSummary(nowMs = now(), { layers = getLayers() } = {}) {
    return buildStatusSummary({
      layers,
      agentsOverview: buildAgentOverview(cfg.agents || [], agentsStatus, cfg.activeAgentId),
      activeServerId: mainServer().id || "",
      shouldBeRunning,
      nowMs,
      contextRevision: computeConfigRevision(cfg),
    });
  }

  function getReadiness(nowMs = now()) {
    return buildReadiness({
      serverId: mainServer().id || "",
      generation: contextGeneration,
      configRevision: computeConfigRevision(cfg),
      agents: buildReadinessAgents({ config: cfg, agentsStatus, resultFor, nowMs }),
    });
  }

  // legacy / lite 共用的头部。
  function statusCore(layers) {
    return {
      updatedAt,
      health: computeHealth(),
      summary: getSummary(undefined, { layers }),
      shouldBeRunning,
      flags: channelFlags(),
    };
  }

  function getLegacyStatus({ layers = getLayers() } = {}) {
    // 各适配器的旧版顶层字段（codex: doctor/endpoint；reclaude: claudeEndpoint）。
    // 注册序保证键序与 v1.5.2 逐字节一致。配置门控关闭的适配器跳过。
    const adapterLegacy = {};
    for (const adapter of listAgentAdapters()) {
      if (!agentAdapterEnabled(adapter, cfg)) continue;
      Object.assign(adapterLegacy, adapter.legacyFields(agentStateFor(adapter)));
    }
    return buildLegacyStatus({
      core: statusCore(layers),
      readiness: getReadiness(),
      processes,
      remotePort,
      adapterLegacy,
      activeBrief: serversBrief[cfg.activeServerId],
      config: cfg,
      agentsStatus,
      agentsOverview: buildAgentOverview(cfg.agents || [], agentsStatus, cfg.activeAgentId),
      mainServer: mainServer(),
      proxyPort: effectiveProxyPort(),
      bridgeStages,
      serversBrief,
      logEntries: queryLogs({ source: logSource, limit: 80 }).entries,
    });
  }

  function getLiteStatus({ layers = getLayers() } = {}) {
    return buildLiteStatus({
      core: statusCore(layers),
      activeBrief: serversBrief[cfg.activeServerId],
      config: cfg,
      recentTransitions: transitionRing.recent(5),
      // 同 getLayers().signals.active：无 data（探针超时/SSH 失败）时回退到最近已知信号快照。
      activeSignals: (probeResults.get(LOG_SIGNALS_PROBE_ID)?.data?.activeSignals) || lastKnownSignalsData.active,
      bridgeStages,
    });
  }

  // ---- STATUS_CHANGED：仅 level 变化才发，携带逐 key transitions ----

  function currentLevelMap(layers = getLayers()) {
    return levelMap(layers, mainServer().id);
  }

  let lastLevels = currentLevelMap();

  function maybeEmitStatusChanged() {
    const layers = getLayers();
    const next = currentLevelMap(layers);
    const transitions = diffTransitions(lastLevels, next, layers, now);
    if (transitions.length === 0) return;
    lastLevels = next;
    transitionRing.push(transitions);
    bus.emit(EVENTS.STATUS_CHANGED, { layers, lite: getLiteStatus({ layers }), transitions });
  }

  function getRecentTransitions(limit = 5) {
    return transitionRing.recent(limit);
  }

  // 当前全量级别快照（key → level）与查看视角：历史基线（history-store 的 levels 条目）用。
  function getLevelSnapshot() {
    return { view: mainServer().id || "", levels: { ...currentLevelMap() } };
  }

  // ---- 探针结果归并 ----

  // T02 上下文隔离（A08）：绑定活跃服务器的探针（agent 诊断 / log-signals）在
  // 运行开始时捕获 serverId；结果回来时若"当前查看的服务器"已不是它，说明这是
  // 配置热载或切服后迟到的旧上下文结果——不更新当前状态、不触发 STATUS_CHANGED。
  // 执行记录本身仍进探针历史（metrics probe:<id>），历史归属可追溯。
  // 绑定具体服务器的探针（slow 采集 / 验证）则要求该服务器仍在且未屏蔽。
  function isStaleResult(id, result) {
    const boundServerId = boundServerIdOf(id);
    if (boundServerId && !isServerEnabled(cfg, boundServerId)) return true;
    const scopedToActiveServer = id === LOG_SIGNALS_PROBE_ID || Boolean(adapterForProbeId(id));
    if (!scopedToActiveServer) return false;
    const contextServerId = result.probeContext?.serverId;
    const activeId = mainServer().id;
    return contextServerId != null && activeId != null && contextServerId !== activeId;
  }

  // 注册表驱动：探针 id → 所属适配器 → 熔断占位/状态合成/凭证透传全在适配器内。
  // patch 键缺省即「不触碰存量值」（熔断轮不覆盖 expiry 靠此语义）。
  function ingestAgentResult(adapter, id, result) {
    const agentId = agentIdFor(adapter);
    const patch = adapter.onProbeResult({
      id,
      result,
      state: agentStateFor(adapter),
      helpers: {
        getPreviousStatus: () => agentsStatus[agentId] || {},
        getBridgeStage: (stage) => bridgeStages[stage],
        ingestBridgeStage,
        now,
      },
    }) || {};
    if ("expiry" in patch) agentExpiry[agentId] = patch.expiry;
    if ("status" in patch) agentsStatus[agentId] = patch.status;
  }

  function ingestLogSignals(result, data) {
    // 只在有 data 时刷新「最近已知」快照；超时/错误轮（无 data）故意不动它，
    // 让 getLayers/getLiteStatus 的回退逻辑保留上一次仍然活跃的信号。
    if (data) {
      lastKnownSignalsData = {
        active: data.activeSignals || [],
        lastActivityAt: data.lastActivityAt ?? null,
      };
    }
    // v2.18：远端端口结论改由这条 fast 采集探针提供（旧 primary-remote 的职责）。
    const update = remotePortFromFastResult(result);
    if (update) {
      remotePortOpen = update.open;
      remotePort = update.remotePort;
      const checkedAt = result.checkedAt ?? now();
      fastPortsByServer.set(mainServer().id, { open: remotePortOpen, checkedAt });
      ingestRemotePortStage(update.open, result, checkedAt);
    }
  }

  // bridgeStages 四段里的「remote-port」此前没有任何一处上报，/api/status 上永远停在初值
  //（ok:false / 0ms / 连败 0）——界面上是一条常驻的「remote-port 失败×0」。远端端口的结论
  // 来自 fast 采集探针，就在这里同步写进这一段：耗时是那次探测（一次 SSH 往返）的用时，
  // 连败按探测轮数累计。serverId 标明是哪台（这枚探针只跑查看中的服务器）。
  function ingestRemotePortStage(open, result, checkedAt) {
    const previous = bridgeStages["remote-port"];
    mergeBridgeSnapshot(bridgeStages, {
      stage: "remote-port",
      ok: open,
      durationMs: open ? Math.max(0, Number(result.durationMs) || 0) : 0,
      consecutiveFailures: open ? 0 : (Number(previous.consecutiveFailures) || 0) + 1,
      lastSuccessAt: open ? checkedAt : previous.lastSuccessAt,
      serverId: mainServer().id ?? null,
    });
  }

  function ingestCollectSlow(serverId, result, data) {
    if (result.level === "skipped") {
      // 保留最近数据。
    } else if (data?.load) {
      serversBrief[serverId] = data.load;
    } else if (serversBrief[serverId]) {
      serversBrief[serverId] = { ...serversBrief[serverId], ok: false };
    }
    // GPU / Agent 安装态：只在本轮确有 data 时刷新，避免一次抖动抹空面板。
    if (data) resourceExtras.set(serverId, resourceExtrasFrom(data));
  }

  function onProbeUpdated(payload) {
    if (!payload?.id || !payload.result) return;
    const { id, result } = payload;
    if (isStaleResult(id, result)) return;
    probeResults.set(id, result);
    updatedAt = new Date(result.checkedAt ?? now()).toISOString();
    const data = result.data || null;
    const adapter = adapterForProbeId(id);

    if (id === PROCESSES_PROBE_ID) {
      if (data?.processes) processes = data.processes;
    } else if (adapter && agentAdapterEnabled(adapter, cfg)) {
      // 配置门控纵深防御：禁用适配器的探针本不会注册（registerAgentProbes 已门控、热载时注销），
      // 万一结果仍到达（关闭瞬间在途的迟到结果 / 测试直发事件）也不合成状态——保证
      // /api/status 的 agentsStatus/layers 不出现禁用 agent 的键。
      ingestAgentResult(adapter, id, result);
    } else if (id === LOG_SIGNALS_PROBE_ID) {
      ingestLogSignals(result, data);
    } else if (id.startsWith(COLLECT_SLOW_PREFIX)) {
      ingestCollectSlow(id.slice(COLLECT_SLOW_PREFIX.length), result, data);
    } else if (id.startsWith(VALIDATION_PREFIX)) {
      validationByServer.set(id.slice(VALIDATION_PREFIX.length), result);
    }

    maybeEmitStatusChanged();
  }

  bus.on(EVENTS.PROBE_UPDATED, onProbeUpdated);

  function setShouldBeRunning(value) {
    shouldBeRunning = Boolean(value);
    updatedAt = new Date(now()).toISOString();
    maybeEmitStatusChanged();
  }

  // 只记文案、不发变迁：说明在下一次 setShouldBeRunning(false) 产生的变迁里生效。
  function setStopNote(note) {
    stopNote = typeof note === "string" && note ? note.slice(0, 120) : null;
  }

  // 配置热载时清理已移除服务器的残留状态（2026-07-02 v2 终审跟进）：
  // 探针本身的注销在 monitor-server 的 refreshConfigIntoKernel（diff 新旧 id 后
  // unregisterProbe），但 state-store 此前只增不删——serversBrief 经未鉴权
  // /api/status.serversBrief 原样透出，被删服务器的负载快照会永久残留；
  // probeResults/validationByServer 里的旧结果则会在同 id 服务器"删了再加回"
  // （可能已指向另一台机器）时冒充新数据。注意 metrics 历史样本不在这里管
  // （metrics-store 独立持久化）：选保留，便于事后排查"删除前这台服务器的负载曲线"。
  function pruneRemovedServers() {
    const liveIds = new Set(listEnabledServers(cfg).map((s) => s.id));
    for (const id of fastPortsByServer.keys()) {
      if (!liveIds.has(id)) fastPortsByServer.delete(id);
    }
    for (const id of Object.keys(serversBrief)) {
      if (!liveIds.has(id)) delete serversBrief[id];
    }
    for (const id of [...validationByServer.keys()]) {
      if (!liveIds.has(id)) validationByServer.delete(id);
    }
    for (const id of [...resourceExtras.keys()]) {
      if (!liveIds.has(id)) resourceExtras.delete(id);
    }
    for (const id of [...tunnelStagesByServer.keys()]) {
      if (!liveIds.has(id)) tunnelStagesByServer.delete(id);
    }
    for (const probeId of [...probeResults.keys()]) {
      const serverId = boundServerIdOf(probeId);
      if (serverId && !liveIds.has(serverId)) probeResults.delete(probeId);
    }
  }

  // v2.47 模块开关：被关掉（或从配置删除）的 Agent 不在 /api/status 残留任何键——删掉其
  // agentsStatus / agentExpiry 条目、适配器私有归并状态与相关探针结果。重新打开时私有状态由
  // agentStateFor 按 createInitialState() 重建、agentsStatus 由 ensureConfigEntries 回到
  // 「检测中...」，绝不复用关闭前的旧结论。
  function pruneDisabledAgents() {
    const liveAgentIds = new Set((cfg.agents || []).map((agent) => agent?.id));
    for (const adapter of listAgentAdapters()) {
      if (agentAdapterEnabled(adapter, cfg)) {
        liveAgentIds.add(agentIdFor(adapter));
        continue;
      }
      agentStates.delete(adapter.kind);
      for (const probeId of adapter.probeIds) probeResults.delete(probeId);
    }
    for (const id of Object.keys(agentsStatus)) {
      if (!liveAgentIds.has(id)) delete agentsStatus[id];
    }
    for (const id of Object.keys(agentExpiry)) {
      if (!liveAgentIds.has(id)) delete agentExpiry[id];
    }
  }

  function setConfig(nextConfig) {
    if (!nextConfig) return;
    const previousId = mainServer().id;
    const previousKeys = Object.keys(currentLevelMap());
    const connectionKey = (server, config) => JSON.stringify([server?.host, server?.sshHostName, server?.sshPort,
      server?.sshUser || config.sshUser, server?.sshIdentityFile || config.sshIdentityFile, server?.authRef, server?.sshJumpServerId]);
    for (const server of nextConfig.servers || []) {
      const previous = cfg.servers?.find((s) => s.id === server.id);
      const oldJump = cfg.servers?.find((s) => s.id === previous?.sshJumpServerId);
      const nextJump = nextConfig.servers?.find((s) => s.id === server.sshJumpServerId);
      if (connectionKey(previous, cfg) !== connectionKey(server, nextConfig) || connectionKey(oldJump, cfg) !== connectionKey(nextJump, nextConfig)) {
        resourceExtras.delete(server.id);
        delete serversBrief[server.id];
        probeResults.delete(`${COLLECT_SLOW_PREFIX}${server.id}`);
      }
    }
    cfg = nextConfig;
    pruneDisabledAgents();
    ensureConfigEntries();
    pruneRemovedServers();
    // T02：配置变化即推进上下文世代（readiness.context.generation 可追溯）。
    contextGeneration += 1;
    if (previousId !== mainServer().id) {
      const evidence = portEvidence(mainServer());
      remotePortOpen = evidence?.open ?? false;
      remotePort = evidence ? { ok: evidence.open, output: evidence.open ? "open" : "closed" } : { ok: false, output: "等待此服务器探测" };
      // 桥接阶段里按服务器区分的两段跟着换：「ssh-tunnel」换成这台自己的快照（还没上报过就是
      // 「尚无数据」的初值），「remote-port」描述的是上一台，回到初值等这台的第一轮探测。
      const blank = createBridgeStages();
      bridgeStages["ssh-tunnel"] = tunnelStagesByServer.get(mainServer().id) || blank["ssh-tunnel"];
      bridgeStages["remote-port"] = blank["remote-port"];
      // 查看对象变化不是故障或恢复。按服务器命名的隧道仍正常比较；
      // channel/agent 聚合视角重新建立基线，避免生成桌面通知。
      const next = currentLevelMap();
      for (const key of Object.keys(next)) {
        if (isViewScopedKey(key, previousId)) lastLevels[key] = next[key];
      }
    }
    // 状态键换了含义（切换查看视角：channel / agent:* 指向另一台）或从快照里消失（新视角那台的
    // tunnel:<id>、删掉 / 停用的服务器与 Agent）都不产出变迁。通知历史另记一份全量基线，
    // 否则按天复盘会把不再跟踪的键的旧状态一直延续下去。
    const levels = currentLevelMap();
    if (previousId !== mainServer().id || previousKeys.some((key) => !(key in levels))) {
      bus.emit(EVENTS.LEVELS_REBASED, { view: mainServer().id || "", levels: { ...levels } });
    }
    maybeEmitStatusChanged();
  }

  function ingestBridgeStage(snapshot) {
    // 带 serverId 的 ssh-tunnel 快照按服务器各自归并；只有查看中的那台进对外的槽位。
    if (snapshot?.stage === "ssh-tunnel" && typeof snapshot.serverId === "string" && snapshot.serverId) {
      const serverId = snapshot.serverId;
      const slot = { "ssh-tunnel": tunnelStagesByServer.get(serverId) || createBridgeStages()["ssh-tunnel"] };
      if (!mergeBridgeSnapshot(slot, snapshot)) return false;
      tunnelStagesByServer.set(serverId, slot["ssh-tunnel"]);
      if (serverId !== mainServer().id) return true;
      bridgeStages["ssh-tunnel"] = slot["ssh-tunnel"];
      updatedAt = new Date(now()).toISOString();
      return true;
    }
    if (!mergeBridgeSnapshot(bridgeStages, snapshot)) return false;
    updatedAt = new Date(now()).toISOString();
    return true;
  }

  function dispose() {
    bus.off(EVENTS.PROBE_UPDATED, onProbeUpdated);
  }

  return { getLayers, getLegacyStatus, getLiteStatus, getSummary, getReadiness, getRecentTransitions, getLevelSnapshot, ingestBridgeStage, setShouldBeRunning, setStopNote, setConfig, dispose };
}
