// v2 monitor-server 组装根：按固定顺序调用各工厂并接线，本身不含业务逻辑。
// 加载配置 → 创建内核组件（logger / metrics / registry / scheduler / state-store）
// → 调各工厂（配置热载 / 通道生命周期 / 执行器 / 事件合并 / HTTP 路由）→ listen。
// 所有状态推导都在 state-store，探针命令都在 probes.mjs；通道启停与守护循环在
// lib/channel-lifecycle.mjs，配置缓存/热载在 lib/config-hot-reload.mjs，路由/SSE/静态
// 资源在 lib/http-router.mjs。
//
// 顺序即契约（改动前先读懂）：
//  - listen 之前完成全部 await：版本号 → 配置加载 → vault 监听并写回 process.env（supervisor
//    经 process.env 继承，必须早于任何 spawn）→ 构建信息冻结 → 事件持久化加载 → 生命周期同步；
//  - 同一事件内的监听器按挂载先后分发：
//      STATUS_CHANGED：时间线/历史 → 恢复补跑（doctor + 被熔断跳过的探针）→ 事件合并 → 自动修复（先清 exhausted 再评估）
//      PROBE_UPDATED ：state-store（createStateStore 内挂载）→ 事件合并 → 自动修复 → 指标/历史
//  - 互为依赖的组件（通道 ↔ 执行器、通道 ↔ 配置内核桥 ↔ 事件同步）只经 late 槽位迟绑定；
//    槽位只在本文件、各组件构造完成后立即填写，其它模块只读。

import { spawn } from "node:child_process";
import path from "node:path";

import { createAutostartService } from "../lib/autostart/service.mjs";
import { createChannelLifecycle } from "../lib/channel-lifecycle.mjs";
import { createConfigManager, createKernelConfigBridge } from "../lib/config-hot-reload.mjs";
import { createConfigTransferService } from "../lib/config-transfer/service.mjs";
import { writePersonalPreferences } from "../lib/modules/preferences-store.mjs";
import { createHttpRouter } from "../lib/http-router.mjs";
import { createBriefService } from "../lib/brief/service.mjs";
import { buildLoginSshArgs, checkLocalPortDefault, createCliLoginService } from "../lib/cli/login.mjs";
import { createCliChangeRefresher } from "../lib/cli/refresh.mjs";
import { listEnabledServers, resolveProxyPort } from "../lib/config-loader.mjs";
import { createServiceForwards } from "../lib/daemons/forwards.mjs";
import { createEgressHealth } from "../lib/egress/egress-health.mjs";
import { createEgressService } from "../lib/egress/service.mjs";
import { execFileWithInput, execFileWithTimeout } from "../lib/exec.mjs";
import { createAccessManager } from "../lib/onboarding-guide/access.mjs";
import { createOnboardingGuide } from "../lib/onboarding-guide/service.mjs";
import { resolveEgressUpstream } from "../lib/cli/net.mjs";
import { createSystemProxyDetector } from "../lib/proxy/system-proxy.mjs";
import { isPackagedApp } from "../lib/runtime-paths.mjs";
import { RESTART_EXIT_CODE } from "../lib/self-update/restart-code.mjs";
import { fetchLatestRelease } from "../lib/self-update/release-check.mjs";
import { createSelfUpdateService } from "../lib/self-update/service.mjs";
import { buildPinnedProbeSshArgs } from "../lib/ssh-args.mjs";
import { createTunnelStabilityService } from "../lib/tunnel-stability-service.mjs";
import { createProbeScheduler } from "../lib/probe-scheduler.mjs";
import { createChannelToolkit } from "../lib/probes.mjs";
import { createUsageStore } from "../lib/usage/store.mjs";
import { createDiagnosticsService } from "../lib/diagnostics/service.mjs";
import { createDirUsageStore, DIR_USAGE_FILE } from "../lib/dir-usage/store.mjs";
import { filesystemFromResources } from "../lib/disk-growth/model.mjs";
import { createDiskGrowthStore, DISK_GROWTH_FILE } from "../lib/disk-growth/store.mjs";
import { createDiagnosesStore, DIAGNOSES_FILE } from "../lib/jobs/diagnoses-store.mjs";
import { createJobRegistry, REGISTRY_FILE } from "../lib/jobs/registry.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "../lib/jobs/watch-store.mjs";
import { createStateStore } from "../lib/state-store.mjs";
import {
  createAutoRepairViewBuilder,
  createScopedTunnelRestarter,
  createServerLabeler,
  createWiredAutoRepairPolicy,
  startAutoRepair,
} from "./auto-repair.mjs";
import { createBridgeIngest } from "./bridge-ingest.mjs";
import { createBuildInfoService } from "./build-info-service.mjs";
import { createConfigRefresher } from "./config-refresh.mjs";
import { createCredentialRuntime } from "./credential-runtime.mjs";
import { runHotStart } from "./hot-start.mjs";
import { createMonitorHttpServer } from "./http-server.mjs";
import { createProbeBackoffRuntime } from "./probe-backoff.mjs";
import { createIncidentSync } from "./incident-sync.mjs";
import { createKernel } from "./kernel.mjs";
import { createShutdown, registerProcessGuards, registerShutdownSignals } from "./lifecycle.mjs";
import { createRunners, isAnyRunnerInFlight } from "./runners.mjs";
import {
  MISSING_AUTH_TOKEN_WARNING,
  NDJSON_TAIL_LINES,
  readPackageRepo,
  readPackageVersion,
  resolveRuntimeEnv,
  resolveServerLocations,
} from "./runtime-env.mjs";
import { createServices } from "./services.mjs";
import { createLogSignalsHandler } from "./signal-sink.mjs";
import { createRuntimeSnapshotPoller } from "./snapshot-poller.mjs";
import { createClusterEnvSync } from "../lib/cluster-env-sync.mjs";
import { createRuntimeExtras, egressHealthView } from "./status-extras.mjs";
import { createStorageMaintenance } from "./storage-maintenance.mjs";
import { createChannelGates, registerHistoryBaseline, registerProbeMetrics, registerRerunOnRecovery, registerStatusTimeline } from "./telemetry.mjs";
import { createProxyAuthService } from "../lib/egress/proxy-auth-service.mjs";
import { createProxyAuthStore } from "../lib/egress/proxy-auth-store.mjs";
import { PROXY_AUTH_FILE } from "../lib/proxy/auth.mjs";
import { PROXY_USAGE_FILE } from "../lib/proxy/usage.mjs";
import { createTeamMemberSync } from "../lib/team-admin/member-sync.mjs";
import { createStorageAdminService } from "../lib/storage-admin/service.mjs";
import { createStorageAdminStore, STORAGE_ADMIN_DIR } from "../lib/storage-admin/store.mjs";
import { createTeamAdminService } from "../lib/team-admin/service.mjs";

// env 在生产中就是 process.env（vault 端点写回它，supervisor 由此继承）。
export async function startMonitorServer({ env = process.env } = {}) {
  const { paths, rootDir, runtimeDir, publicDir } = resolveServerLocations(env);
  const { port, fixtureMode, authToken, maxSseConnections, sseHeartbeatMs } = resolveRuntimeEnv(env);
  if (!authToken) console.warn(MISSING_AUTH_TOKEN_WARNING);
  const version = await readPackageVersion(rootDir);

  // ---- 内核组件 ----
  const kernel = createKernel({ runtimeDir });
  const { appendLog, writeTimeline, historyStore, metricsStore, registry } = kernel;
  registerStatusTimeline(kernel);

  // ---- 配置缓存 ----
  const configManager = createConfigManager({ configPath: paths.configPath, localConfigPath: paths.localConfigPath, appendLog });
  const initialConfig = await configManager.loadConfig();
  // HTTP 控制面与共享 CONNECT 代理不能绑定同一个本机端口。HTTP server
  // 必须在代理/supervisor 之前启动，因此在 listen 前 fail fast，避免只看到
  // 一个含糊的 EADDRINUSE 并让同事误以为 SSH 隧道坏了。PORT=0 是随机端口，
  // 实际绑定值此时未知，交给内核选择，不做静态冲突判断。
  if (!fixtureMode && port !== 0 && Array.isArray(initialConfig?.servers) && initialConfig.servers.length > 0
    && resolveProxyPort(initialConfig) === port) {
    throw new Error(`配置冲突：共享代理端口 ${port} 与控制面 HTTP 端口相同，请修改服务器 localPort 后重试`);
  }
  // 合并配置的唯一取法：热载缓存优先，首轮之前回落启动时加载的那份。
  const getMergedConfig = () => configManager.getCache() || initialConfig;
  const { getConfig } = configManager;

  // 探针退避（默认关）：SSH 执行层报证据、守护进程快照与进程采样报信号、调度器按它放行。
  const probeBackoff = createProbeBackoffRuntime({ env, getMergedConfig, appendLog });
  const credentials = await createCredentialRuntime({ env, getConfig, runtimeDir, rootDir, onSshResult: probeBackoff.onSshResult, fixtureMode });
  const { executeRuntime } = credentials;

  // ---- 状态存储 + supervisor 旁路（bridge 快照 2s / 运行快照 5s）----
  // snapshots 在 store 之后创建；用迟绑定 getter 让状态层也能读取 supervisor
  // 首拍钉死的共享代理端口，切换查看服务器时不把配置 localPort 当成运行事实。
  let getEffectiveProxyPort = () => null;
  let getHandoverStandby = () => ({});
  const store = createStateStore({
    config: initialConfig,
    getEffectiveProxyPort: () => getEffectiveProxyPort(),
    getHandoverStandby: () => getHandoverStandby(),
  });
  // 历史基线要在任何历史写入之前接好（探针、信号、变迁都在这之后才开始产生）。
  registerHistoryBaseline({ historyStore, getLevelSnapshot: store.getLevelSnapshot });
  // 出网健康（v2.65）：被动统计吃 supervisor 消息，所以早于摄取创建（首拍读回的行也要数到）；主动探测要用
  // 出网服务算出的生效方式，出网服务创建之后才 start()。fixture 模式不探测、不读 /proxy-health。
  let resolveEgressEffective = async () => null;
  const egressHealth = createEgressHealth({ resolveEffective: () => resolveEgressEffective(), fixtureMode, log: appendLog });
  const bridge = createBridgeIngest({
    runtimeDir,
    store,
    onSnapshot: probeBackoff.onBridgeSnapshot,
    onMessage: egressHealth.noteSupervisorMessage,
  });
  bridge.start();
  const snapshots = createRuntimeSnapshotPoller({ runtimeDir, registry, getMergedConfig });
  snapshots.start();
  getEffectiveProxyPort = () => {
    const targets = snapshots.getConnectionTargets();
    return targets?.source === "supervisor-snapshot" && targets.freshness === "fresh"
      ? targets.effectiveProxyPort?.value ?? null
      : null;
  };
  // 同账号多台 Mac 接力（v2.88）：快照里本机待命的服务器（另一台 Mac 在承载）。只认新鲜、已核实归属的快照。
  getHandoverStandby = () => {
    const targets = snapshots.getConnectionTargets();
    if (targets?.source !== "supervisor-snapshot" || targets.freshness !== "fresh") return {};
    const out = {};
    for (const [serverId, entry] of Object.entries(targets.servers || {})) {
      if (entry?.handover?.role === "standby") out[serverId] = entry.handover;
    }
    return out;
  };

  // 迟绑定槽位（唯一一处）：下列组件晚于其使用者创建，使用者只在调用时解引用。
  const late = {
    channel: null,
    configKernel: null,
    incidentSync: null,
    operationsRunner: null,
    dataPlaneUpgrader: null,
    shutdown: null,
  };
  // 「查看处置日志」：处置操作（通道级重启 / 单隧道重启）一经受理即关联它处置的未解决事件。
  // 事件同步晚于通道与执行器创建，这里只在调用时经槽位取用（操作只可能发生在 listen 之后）。
  const linkOperation = (operation) => late.incidentSync?.linkOperation(operation);

  const getBuildInfo = await createBuildInfoService({
    rootDir,
    getUsableSnapshot: snapshots.getUsableSnapshot,
    getShouldBeRunning: () => late.channel.getShouldBeRunning(),
  });
  const scheduler = createProbeScheduler({ tickMs: 1000, sshConcurrency: 3, jitterRatio: 0.1, hostBackoff: probeBackoff.backoff });
  const autoRepairPolicy = createWiredAutoRepairPolicy({ autoRepairConfig: initialConfig.autoRepair, appendLog });
  const storage = createStorageMaintenance({ runtimeDir, getMergedConfig, appendLog });
  storage.startSweepSchedule();
  registerRerunOnRecovery({ scheduler });

  // 服务直达（lib/daemons/forwards.mjs）：把本人在集群上监听的服务临时转发到本机，每条一个独立的 ssh -L，
  // 与 supervisor 的隧道互不相干；本机端口避开控制面端口、本机代理端口与配置里出现过的所有端口。
  // fixture 模式不起任何进程，所以不创建；那时守护进程服务整段走假数据（下面把 fixtureMode 交给工具箱）。
  const serviceForwards = fixtureMode ? null : createServiceForwards({
    registry,
    runtimeDir,
    cwd: rootDir,
    monitorPort: port,
    getConfig: getMergedConfig,
    sshArgsFor: (server, config) => buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }),
    log: appendLog,
  });
  // 代理口令（v2.62）：runtime/proxy-auth.json 的唯一写入方；本机代理约 2 秒内热载。默认关——关着的时候
  // getCredential 恒为 null，探针与自测发出去的命令与以前逐字相同。
  // 口令文件损坏时，改设置之前先留档并记一条警告（不含口令）。
  const proxyAuthStore = createProxyAuthStore({ filePath: path.join(runtimeDir, PROXY_AUTH_FILE), log: appendLog });

  const toolkit = createChannelToolkit({
    rootDir,
    dataDir: paths.dataRoot,
    getConfig,
    getLocalProxyLog: bridge.readLocalProxyLog,
    getConnectionTargets: snapshots.getConnectionTargets,
    execFileImpl: executeRuntime,
    // 直连节点断开 / 恢复只写运维日志（lib/probes/direct-nodes.mjs）。
    appendLog,
    // Agent 用量（lib/usage/）：扫描结果落 runtimeDir/usage/<serverId>/（fixture 模式下 runtimeDir 是隔离的临时目录）。
    usageStore: createUsageStore({ rootDir: path.join(runtimeDir, "usage"), log: appendLog }),
    // 失败作业诊断（lib/jobs/，v2.49）：登记表与诊断结果各一个 runtime 下的 0600 文件，计入存储预算。
    jobsStores: {
      registry: createJobRegistry({ filePath: path.join(runtimeDir, REGISTRY_FILE), log: appendLog }),
      diagnoses: createDiagnosesStore({ filePath: path.join(runtimeDir, DIAGNOSES_FILE), log: appendLog }),
      watch: createJobWatchStore({ filePath: path.join(runtimeDir, JOB_WATCH_FILE), log: appendLog }),
    },
    // 本人目录占用（lib/dir-usage/）：扫描游标与部分结果，runtime 下单个 0600 文件（≤ 8MB），计入存储预算。
    dirUsageStore: createDirUsageStore({ filePath: path.join(runtimeDir, DIR_USAGE_FILE), log: appendLog }),
    // 磁盘增长归因（lib/disk-growth/，v2.62）：作业产出目录各子目录的测量，runtime 下单个 0600 文件（≤ 256 KB），计入存储预算。
    diskGrowthStore: createDiskGrowthStore({ filePath: path.join(runtimeDir, DISK_GROWTH_FILE), log: appendLog }),
    // 远端守护进程（lib/daemons/）：启动动作同时记一条状态时间线（timeline.ndjson）。
    writeTimeline,
    serviceForwards,
    // fixture 实例里「远端守护进程」的状态 / 启动 / 服务列表 / 转发一律不发 SSH、不起进程（lib/daemons/fixture.mjs）。
    fixtureMode,
    // 经反向端口出网的探测要不要带代理口令（口令经标准输入交给远端，不进命令行）。
    getProxyCredential: proxyAuthStore.getCredential,
  });
  // 配置热载后由 config-refresh.mjs 通知守护进程服务：模块被关、服务器不再符合条件时收回转发。
  late.daemons = toolkit.daemons;
  const { getTunnelUp, isChannelOk } = createChannelGates(store);

  // ---- 通道生命周期 + 执行器（互斥经 late 槽位）----
  // refreshConfigIntoKernel 与 getShouldBeRunning 互为对方工厂的依赖：channel 先创建、
  // 配置内核桥后创建，refreshConfigIntoKernel（config-refresh.mjs）在调用时才经 late 槽位取用内核桥。
  const refreshConfigIntoKernel = createConfigRefresher({ late, autoRepairPolicy, probeBackoff });
  const channel = createChannelLifecycle({
    rootDir,
    paths,
    fixtureMode,
    appendLog,
    registry,
    scheduler,
    toolkit,
    store,
    getConfig,
    refreshConfigIntoKernel,
    isBlocked: () => isAnyRunnerInFlight(late),
    onRestartAccepted: (context) => linkOperation({ operationId: context.operationId, trigger: context.trigger }),
  });
  late.channel = channel;
  const getShouldBeRunning = channel.getShouldBeRunning;
  const runners = createRunners({
    channel,
    getConfig,
    runtimeDir,
    registry,
    fixtureMode,
    appendLog,
    writeTimeline,
    snapshots,
    getBundleComponents: async () => (await getBuildInfo()).dataPlane?.bundle ?? null,
    onOperationAccepted: linkOperation,
  });
  Object.assign(late, runners);
  const { operationsRunner, dataPlaneUpgrader } = runners;

  // ---- 事件合并 + 自动修复（两者的总线监听器在此按序挂载）----
  const incidentSync = await createIncidentSync({ runtimeDir, appendLog, configManager });
  late.incidentSync = incidentSync;
  incidentSync.registerObservers({ store, getMergedConfig, getShouldBeRunning });
  // 只修坏的那条：单隧道重启复用界面同一条 preview → run 通路；整个通道重启期间的停止原因写成自动修复。
  const autoRepair = startAutoRepair({
    policy: autoRepairPolicy,
    scheduler,
    channel,
    buildView: createAutoRepairViewBuilder({
      store,
      channel,
      getMergedConfig,
      isTunnelOperationInFlight: () => operationsRunner.isInFlight(),
    }),
    appendLog,
    timeline: writeTimeline,
    operationStorage: kernel.operationStorage,
    restartTunnel: createScopedTunnelRestarter(operationsRunner),
    describeServer: createServerLabeler(getMergedConfig),
    noteChannelStop: (note) => store.setStopNote(note),
  });

  // agent 探针按启动配置注册（被关掉的 Agent 不注册），其 id 交给配置内核桥作热载基线。
  const { agentProbeIds } = toolkit.registerProbes({
    scheduler,
    config: initialConfig,
    getShouldBeRunning,
    isChannelOk,
    getTunnelUp,
    onLogSignals: createLogSignalsHandler({ store, signalLogger: kernel.signalLogger, historyStore }),
  });

  // ---- 配置热载 → 内核桥（lib/config-hot-reload.mjs）：登记首批按 Agent / 服务器展开的探针 ----
  late.configKernel = createKernelConfigBridge({ configManager, store, toolkit, scheduler, getShouldBeRunning, getChannelUp: isChannelOk });
  late.configKernel.registerInitialProbes(initialConfig, { agentProbeIds });

  const { serverRegistry, localResourceProbe, bootstrapRunner } = createServices({
    runtimeDir,
    dataDir: paths.dataRoot,
    localConfigPath: paths.localConfigPath,
    fixtureMode,
    appendLog,
    configManager,
    getMergedConfig,
    refreshConfigIntoKernel,
    credentialVault: credentials.credentialVault,
    executeRuntime,
    scheduler,
  });
  registerProbeMetrics({ metricsStore, historyStore, getTunnelUp, isChannelOk });
  // 进程采样 → 探针退避的「隧道稳住了」信号（与其它监听器互不依赖，挂在最后）。
  probeBackoff.attachBus();

  // ---- 隧道稳定性（断线账本）与今日简报 ----
  const tunnelStability = createTunnelStabilityService({ runtimeDir, getMergedConfig });
  const briefService = createBriefService({
    runtimeDir,
    getMergedConfig,
    tunnelStability,
    incidentStore: incidentSync.incidentStore,
    usageService: toolkit.usage ?? null,
    jobsService: toolkit.jobs ?? null,
    historyStore,
    diskGrowthService: toolkit.diskGrowth ?? null,
    getDoctorOutput: () => store.getLegacyStatus()?.doctor?.output ?? null,
    log: appendLog,
  });
  if (!fixtureMode) briefService.start();

  // ---- 磁盘增长归因（v2.62）：每 6 小时量一次作业产出目录各子目录的大小，磁盘涨得快时提前量 ----
  // 不是探针：服务自己按时间表发起，SSH 仍经调度器的全局槽位；整盘用量取资源采集已有的那一份。
  // fixture 模式整个停用：不定时量，「现在量一次」也回 409——冒烟 / 界面预览用的监控服务一条 SSH 都不发。
  if (fixtureMode) toolkit.diskGrowth?.disable("fixture 模式不发起真实 SSH");
  else {
    toolkit.diskGrowth?.start({
      acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
      getFilesystem: (serverId) => filesystemFromResources(store.getLayers().resources, serverId),
    });
  }
  // ---- 代理口令与隧道使用记录（v2.62）：读写口令文件、读代理写的使用记录、把口令写到集群 ----
  const proxyAuth = createProxyAuthService({
    store: proxyAuthStore,
    usagePath: path.join(runtimeDir, PROXY_USAGE_FILE),
    getConfig,
    getClusterEnvSync: () => late.clusterEnvSync ?? null,
    fixtureMode,
    log: appendLog,
  });
  // 用量文件每 30 秒看一眼（修改时刻没变就不读），近一分钟流量才按真正相邻的两版算（v2.65）。
  const usageSampler = setInterval(() => {
    try {
      proxyAuth.sampleUsage();
    } catch {}
  }, 30_000);
  usageSampler.unref();

  // ---- 本机出网（v2.54）：出网方式 / 个人白名单 / 自测。写入走个人层，本机代理自行热载 ----
  const egressService = createEgressService({
    getConfig,
    // 共享代理端口在 supervisor 首拍后固定；activeServer 切换只改查看视角，
    // egress 读新鲜运行快照才能继续访问实际监听端口。
    getConnectionTargets: snapshots.getConnectionTargets,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    // 全链路自测：与探针同一套 SSH 参数（钉住的 known_hosts）与执行入口（凭证注入）。
    runRemote: (server, config, command, { timeoutMs, input } = {}) => toolkit.execFile(
      "ssh",
      [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
      { timeoutMs, server, ...(input != null ? { input } : {}) },
    ),
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    proxyAuth,
    // fixture 模式下出网服务不发任何本机或远端的网络请求（不读现役代理的 /proxy-health、不自测、不发 SSH）。
    fixtureMode,
  });
  // 出网健康的主动探测：每 30 秒对生效的上游连一次 TCP（生效方式沿用 60 秒）。
  resolveEgressEffective = () => egressService.getEffective();
  egressHealth.start();

  // ---- 集群 CLI 安装 / 登录之后的刷新（v2.57）：重测 cli:<serverId>，成功时补跑 doctor / claude-code。
  // 安装（经 HTTP 路由的 runtime）与登录（onLoginChanged）共用这一个函数。
  const refreshAfterCliChange = createCliChangeRefresher({ cliProbe: toolkit.cli, scheduler, log: appendLog });

  // ---- 集群 CLI 登录（v2.57）：账号授权（伪终端会话）/ API / 中转站。key 只经 ssh 标准输入 ----
  const cliLoginService = createCliLoginService({
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    // 短命令：与探针同一套钉扎参数与执行入口（凭证注入）；input 走 ssh 标准输入。
    runRemote: (server, config, command, { timeoutMs, input } = {}) => executeRuntime(
      "ssh",
      [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
      { server, timeoutMs, ...(input != null ? { input } : {}) },
    ),
    // 账号会话：长连接 + 伪终端（密码服务器在服务里直接拒绝，这里不注入 askpass）。
    spawnSsh: (server, config, { sshOptions, command }) => spawn(
      "ssh",
      buildLoginSshArgs(buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), sshOptions, command),
      { cwd: rootDir, stdio: ["pipe", "pipe", "pipe"] },
    ),
    checkLocalPort: checkLocalPortDefault,
    // 与安装 / 回滚（toolkit.cliInstall）同一把服务器级锁：安装进行中不能登录，反之亦然。
    taskLock: toolkit.cliTaskLock,
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    // 登录成功后立即重测 CLI 登录方式，并补跑对应 Agent 探针（卡片的登录 / 需登录状态马上更新）。
    onLoginChanged: ({ serverId, cli }) => {
      refreshAfterCliChange(serverId, { cli, ok: true }).catch(() => {});
    },
    getEnvCredential: async (serverId) => (await late.clusterEnvSync?.credentialForRewrite(serverId)) ?? null,
    log: appendLog,
  });

  // ---- 集群侧受管配置跟随反向端口：端口变更后自动改 env.sh，平时只读检测不一致 ----
  const clusterEnvSync = createClusterEnvSync({
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    runRemote: (server, config, command, { timeoutMs, input } = {}) => executeRuntime(
      "ssh",
      [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
      { server, timeoutMs, ...(input != null ? { input } : {}) },
    ),
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    log: appendLog,
    autoCheck: !fixtureMode,
    getProxyCredential: proxyAuthStore.getStoredCredential,
    // 用户发起的整体重写（接入引导、登录引导）：口令模式打开着就一并写入口令（v2.64，与命令行向导同一条规则）。
    getProxyAuthMode: () => proxyAuthStore.getPublicState().mode,
  });
  // 先用启动时的配置登记各服务器的端口（只记不动），之后的变更才算"变了"；fixture 模式不发真实 SSH。
  if (!fixtureMode) {
    getConfig().then((config) => clusterEnvSync.onConfigRefreshed(config)).catch(() => {});
    late.clusterEnvSync = clusterEnvSync;
  }

  // ---- App 内接入引导：核对指纹 → 专用密钥 → 用一次密码装公钥 → 领端口 → 起隧道 → 出网自测 → 写集群侧配置 ----
  // 本机命令（ssh-keygen / ssh-keyscan / 装公钥的那次 ssh）直接 exec，不经凭证运行时——这时还没有任何凭证；
  // 之后的远端命令与探针走同一套钉扎参数与执行入口。fixture 模式下是不碰网络与文件的假流程。
  const onboardingGuide = createOnboardingGuide({
    fixtureMode,
    statePath: path.join(runtimeDir, "onboarding-guide.json"),
    helperDir: path.join(runtimeDir, "askpass"),
    teamConfigPath: paths.configPath,
    getMergedConfig,
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    serverRegistry,
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    exec: (cmd, args, options = {}) => (options.input != null ? execFileWithInput(cmd, args, options) : execFileWithTimeout(cmd, args, options)),
    runRemote: (server, config, command, { timeoutMs, input } = {}) => executeRuntime(
      "ssh",
      [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
      { server, timeoutMs, ...(input != null ? { input } : {}) },
    ),
    getStatus: () => store.getLegacyStatus(),
    getTunnelFailure: (serverId) => bridge.getTunnelFailures(listEnabledServers(getMergedConfig()).map((srv) => srv?.id))?.[serverId] ?? null,
    getShouldBeRunning,
    startChannel: channel.startChannel,
    egressService,
    clusterEnvSync: fixtureMode ? null : clusterEnvSync,
    log: appendLog,
  });

  // ---- 接入管理（配置 →「接入引导」下面）：名下的端口登记、释放闲置端口、撤销接入（setup:undo 的界面版）----
  // 远端命令与探针走同一套钉扎参数与执行入口；撤销期间占用安装 / 登录共用的那把任务锁。
  const accessManager = createAccessManager({
    fixtureMode,
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    runRemote: (server, config, command, { timeoutMs, input } = {}) => executeRuntime(
      "ssh",
      [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
      { server, timeoutMs, ...(input != null ? { input } : {}) },
    ),
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    taskLock: toolkit.cliTaskLock,
    onboardingGuide,
    // 撤销会删掉 keys/ 里的 API key：结束后重测一遍 CLI 的登录状态（只重测，不补跑 Agent 探针）。
    onClusterChanged: (serverId) => {
      refreshAfterCliChange(serverId, { ok: false }).catch(() => {});
    },
    log: appendLog,
  });

  // ---- 自更新（v2.59）：源码安装（git clone）从 GitHub main 取新版本，界面提示后一键更新。
  // 打包的 .app 在服务里如实报「不支持」；fixture 模式（冒烟 / 自检）不启用，免得自检里再去 fetch。
  // 打包的 App 改为到 GitHub Releases 查新版本，有就给「去下载」（lib/self-update/release-check.mjs）。
  const updateProxyDetector = createSystemProxyDetector({});
  const packagedApp = isPackagedApp(rootDir);
  const releaseRepo = packagedApp && !fixtureMode ? await readPackageRepo(rootDir) : null;
  const selfUpdate = fixtureMode ? null : createSelfUpdateService({
    rootDir,
    runtimeDir,
    packaged: packagedApp,
    releaseLookup: releaseRepo ? () => fetchLatestRelease(releaseRepo) : null,
    // git fetch 跟随个人层的出网设置（跟随系统代理 / 手动上游时带 -c http.proxy）。
    getUpstream: async () => (await resolveEgressUpstream({ egress: (await getConfig())?.egress, detector: updateProxyDetector }))?.url ?? null,
    env,
    log: appendLog,
  });

  // ---- 登录电脑后自动启动（v2.62）：macOS 源码安装写用户级 LaunchAgent，Windows 写「启动」文件夹；
  // 打包的 .app 的登录项在桌面壳里（desktop/login-item.mjs）。fixture 模式下文件只在内存里。
  const autostart = createAutostartService({ rootDir, packaged: isPackagedApp(rootDir), fixtureMode, env, log: appendLog });

  // ---- 工作台自己的诊断（v2.64）：导出诊断包（只读、脱敏）与页面脚本错误上报（写 renderer.ndjson）----
  // 已知秘密每次导出现取：本机鉴权令牌、保管库令牌、代理口令（含过渡期内的上一个），出现在包里任何位置都换掉。
  const diagnostics = createDiagnosticsService({
    runtimeDir,
    logsDir: kernel.logsDir,
    version,
    getConfig: getMergedConfig,
    getBuildInfo: () => getBuildInfo(),
    incidentStore: incidentSync.incidentStore,
    storageSweeper: storage.sweeperForRouter,
    getSecrets: () => {
      const proxy = [proxyAuthStore.getStoredCredential(), proxyAuthStore.getPreviousCredential()].filter(Boolean);
      return {
        secrets: [authToken, env.CODEX_MONITOR_VAULT_TOKEN, ...proxy.map((credential) => credential.password)],
        users: proxy.map((credential) => credential.user),
      };
    },
    fixtureMode,
    packaged: isPackagedApp(rootDir),
    env,
  });

  // ---- 配置的备份与迁移（v2.64）：导出个人层配置与本机偏好（不含令牌 / 口令 / 私钥），导入时列出改动、按勾选写入。
  // 个人层经 savePersonalConfig（同一套校验与 revision 核对）；模块 / 面板偏好经 preferences-store；作业提醒经作业关注服务。
  const configTransfer = createConfigTransferService({
    localConfigPath: paths.localConfigPath,
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    writePreferences: (patch) => writePersonalPreferences({ localConfigPath: paths.localConfigPath, patch }),
    refreshConfigIntoKernel,
    jobs: toolkit.jobs?.getWatchView && toolkit.jobs?.changeWatch ? toolkit.jobs : null,
    appVersion: version,
    log: appendLog,
  });

  // ---- 团队管理与成员后台同步（Team Admin & Member Sync）----
  const getSelfDirUsageBytes = async (serverId) => {
    try {
      const res = await toolkit.dirUsage?.get?.(serverId, "");
      return Number(res?.scan?.totalBytes) > 0 ? Number(res.scan.totalBytes) : null;
    } catch {
      return null;
    }
  };
  const runTeamSsh = (server, config, command, { timeoutMs, input } = {}) => executeRuntime(
    "ssh",
    [...buildPinnedProbeSshArgs(server, config, { dataDir: paths.dataRoot }), command],
    { server, timeoutMs, ...(input != null ? { input } : {}) },
  );
  const memberSync = createTeamMemberSync({
    getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    runRemote: runTeamSsh,
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    getEnvCredential: async (serverId) => (await late.clusterEnvSync?.credentialForRewrite(serverId)) ?? null,
    onLoginChanged: ({ serverId, cli }) => {
      refreshAfterCliChange(serverId, { cli, ok: true }).catch(() => {});
    },
    getStatus: () => store.getLegacyStatus(),
    getLayers: () => store.getLayers(),
    getEgressSnapshot: () => egressHealthView(egressHealth),
    getCliSnapshot: (serverId) => toolkit.cli?.getSnapshot?.(serverId) ?? null,
    getUsageSummary: async () => (await toolkit.usage?.summary?.({ range: 7 })) ?? null,
    getSelfDirUsageBytes,
    version,
    statePath: path.join(runtimeDir, "team-member-state.json"),
    fixtureMode,
    log: appendLog,
  });
  memberSync.start();

  const teamAdminService = createTeamAdminService({
    getConfig,
    getMergedConfig,
    runRemote: runTeamSsh,
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    getLayers: () => store.getLayers(),
    getSelfDirUsageBytes,
    memberSync,
    pendingPath: path.join(runtimeDir, "team-admin-pending.json"),
    version,
    fixtureMode,
    log: appendLog,
  });

  // ---- 管理员存储视图（只给 adminUsers；以 root 经专用受限密钥只读扫描）----
  const storageAdminDir = path.join(runtimeDir, STORAGE_ADMIN_DIR);
  const storageAdmin = createStorageAdminService({
    getConfig,
    isAdmin: (config) => teamAdminService.getAdminRole(config).isAdmin,
    store: createStorageAdminStore({ dir: storageAdminDir }),
    exec: (cmd, args, options = {}) => (fixtureMode && cmd === "ssh"
      ? Promise.resolve({ code: 255, stdout: "", stderr: "fixture 模式不发起真实 SSH", timedOut: false, truncated: false })
      : options.input != null ? execFileWithInput(cmd, args, options) : execFileWithTimeout(cmd, args, options)),
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
    dir: storageAdminDir,
    log: appendLog,
  });
  storageAdmin.resume();

  // ---- HTTP 路由（lib/http-router.mjs）----
  const router = createHttpRouter({
    authToken,
    version,
    publicDir,
    logsDir: kernel.logsDir,
    ndjsonTailLines: NDJSON_TAIL_LINES,
    maxSseConnections,
    sseHeartbeatMs,
    store,
    scheduler,
    metricsStore,
    historyStore,
    storageSweeper: storage.sweeperForRouter,
    getRuntimeExtras: createRuntimeExtras({
      rootDir,
      localConfigPath: paths.localConfigPath,
      getMergedConfig,
      autoRepairPolicy,
      autoRepair,
      bridge,
      scheduler,
      clusterEnvSync,
      onboardingGuide,
      probeBackoff,
      egressHealth,
      teamAdminService,
    }),
    bootstrapRunner,
    toolkit,
    appendLog,
    operationStorage: kernel.operationStorage,
    getConfig,
    setActiveServerConfig: configManager.setActiveServerConfig,
    setActiveAgentConfig: configManager.setActiveAgentConfig,
    setModuleEnabled: configManager.setModuleEnabled,
    setHiddenPanels: configManager.setHiddenPanels,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel,
    startChannel: channel.startChannel,
    stopChannel: channel.stopChannel,
    restartChannel: channel.restartChannel,
    operationsRunner, // T04b：单隧道操作三路由的数据源（preview/run/query）
    incidentStore: incidentSync.incidentStore, // T07：GET /api/incidents、POST .../attention
    getConnectionTargets: snapshots.getConnectionTargets, // T01：/api/status.connectionTargets
    getBuildInfo, // T05：/api/build-info
    dataPlaneUpgrader, // 热更新：POST /api/data-plane/upgrade
    getPersonalConfig: configManager.getPersonalConfig,
    serverRegistry,
    localResourceProbe,
    tunnelStability,
    briefService,
    egressService,
    cliLoginService,
    clusterEnvSync,
    onCliChanged: refreshAfterCliChange,
    selfUpdate,
    // 网页模式的「重启监控服务」：走同一条优雅退出，只是退出码告诉 launch.mjs 再拉起来一份。
    requestRestart: () => late.shutdown?.({ exitCode: RESTART_EXIT_CODE }),
    autostart,
    diagnostics,
    configTransfer,
    teamAdminService,
    memberSync,
    storageAdmin,
    onboardingGuide,
    accessManager,
  });

  // ---- 监听 + 热接管 ----
  const httpServer = createMonitorHttpServer({ router, isClosing: incidentSync.isClosing, appendLog });
  httpServer.listen(port, () => runHotStart({ fixtureMode, toolkit, channel, store, scheduler, appendLog }));
  // 上次异常退出留下的转发 ssh：监听成功（确认自己是这个端口上唯一的监控服务）之后才按进程注册表清，
  // 否则重复启动的第二份会把正在运行的那一份的转发当成孤儿。
  if (serviceForwards) httpServer.server.once("listening", () => serviceForwards.sweepOrphans().catch(() => {}));
  if (!fixtureMode) channel.scheduleAutoRepair(0);

  if (selfUpdate) {
    selfUpdate.start();
    // 刚做完自更新的那次重启：守护进程还是旧代码时自动平滑交接一次（等价于横幅上的按钮）。
    selfUpdate.resumeAfterRestart({ getBuildInfo, upgrade: (data) => dataPlaneUpgrader.upgrade(data) });
  }

  late.shutdown = createShutdown({
    incidentSync,
    httpServer,
    scheduler,
    localResourceProbe,
    metricsStore,
    historyStore,
    storage,
    credentials,
    serviceForwards,
    flushServices: () => {
      cliLoginService.dispose();
      memberSync.stop();
      selfUpdate?.stop();
      egressHealth.stop();
      clearInterval(usageSampler);
      toolkit.diskGrowth?.stop(); // 不再发起新的测量；进行中的那次发完手上这一轮就停
      storageAdmin.stop(); // 不再轮询服务器上的扫描进度（扫描本身在服务器上照常跑完）
      return toolkit.jobs?.flush?.();
    },
  });
  registerShutdownSignals(late.shutdown);
  registerProcessGuards({ appendLog });
}
