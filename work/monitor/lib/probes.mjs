import path from "node:path";

import { createCliInstallService } from "./cli/install-service.mjs";
import { resolveEgressUpstream } from "./cli/net.mjs";
import { createCliService } from "./cli/service.mjs";
import { createCliTaskLock } from "./cli/task-lock.mjs";
import { createCliVersionsService } from "./cli/versions.mjs";
import { createCodexAppServerService } from "./agents/app-server-service.mjs";
import { createDaemonsService } from "./daemons/service.mjs";
import { createDirUsageService } from "./dir-usage/service.mjs";
import { createDiskGrowthService } from "./disk-growth/service.mjs";
import { createCollectProbes } from "./probes/collect.mjs";
import { createJobsService } from "./jobs/service.mjs";
import { createProbeContext } from "./probes/context.mjs";
import { createProcessProbe } from "./probes/processes.mjs";
import { createProbeRegistrar } from "./probes/register.mjs";
import { createSystemProxyDetector } from "./proxy/system-proxy.mjs";
import { createValidationProbe } from "./probes/validation.mjs";
import { createUsageService } from "./usage/service.mjs";

// 通道探针工具箱（门面）：v1.5.2 monitor-server 中各轮询函数的命令与解析逻辑
// 原样搬入探针 run，供调度器按 TTL 驱动。SSH 身份（-i/-l）与 supervisor 共用
// ssh-args.mjs；ControlMaster 走家目录路径，不落到 Application Support。
// 实现按职责拆在 lib/probes/：
//   context.mjs     exec 注入点 / SSH 参数 / 失败归因 / 诊断上下文 / 主机记账键
//   processes.mjs   本机受管进程（快路径 pid 复核 + 周期全量 ps）
//   collect.mjs     零残留采集：fast（log-signals）/ slow（collect:slow:<id>）+ CPU 差分缓存
//   direct-nodes.mjs 直连节点（不在 Slurm 分区内）连通观察：变化才写日志，不参与判级
//   validation.mjs  validationProfile 验证探针
//   register.mjs    探针注册（processes / agent 适配器 / log-signals / slow / usage / jobs / validation）
// Agent 用量的扫描、存储与聚合在 lib/usage/（usage:<serverId> 探针随 slow 采集一起按服务器注册）。
// 「我的作业」（sacct 近 2 天）在 lib/jobs/（jobs:<serverId> 同上，与 usage 同一采集范围）。
// 远端守护进程（Paseo / T3 Code 的状态与启动，以及本人监听的服务与临时转发）在 lib/daemons/：只在界面请求时发 SSH，不注册探针。
// 磁盘增长归因（作业产出目录各子目录的大小，每 6 小时量一次）在 lib/disk-growth/：同样不注册探针，
// 服务自己按时间表发起，SSH 经调度器的全局槽位 → toolkit.diskGrowth。
// 官方 CLI（codex / Claude Code）在 lib/cli/：探测（安装态 / 版本 / 登录方式，cli:<serverId> 同 usage 采集范围，
// 10 分钟一轮）→ toolkit.cli；安装 / 更新 / 回滚（只在界面请求时发 SSH）→ toolkit.cliInstall；最新版本 → toolkit.cliVersions；
// 安装与登录（server/start.mjs 装配）共用 toolkit.cliTaskLock 这一把服务器级互斥锁。
// agent 专属探针（doctor/endpoint/reclaude/claude-endpoint/zcode）在 lib/agents/ 各适配器的
// probeSpecs(ctx)，register.mjs 按注册表与运行配置统一注册（registerAgentProbes 随配置热载增删）。
// getProxyCredential（v2.62 代理口令）：() → { user, password } | null。经反向端口出网的探测（验证档案的出网测试、
// codex doctor / 端点、Claude Code 连通性、reclaude）在它不为 null 时带上口令——口令只经标准输入到远端，
// 不进命令行。缺省恒为 null：发出去的命令与以前逐字相同。
export function createChannelToolkit({ rootDir, dataDir, getConfig, execFileImpl, getLocalProxyLog, getConnectionTargets,
  appendLog, usageStore = null, jobsStores = null, dirUsageStore = null, diskGrowthStore = null, serviceForwards = null, fixtureMode = false, writeTimeline = null, platform = process.platform, now = Date.now,
  getProxyCredential = () => null }) {
  const ctx = createProbeContext({ rootDir, dataDir, getConfig, execFileImpl });
  // slow 采集的 slurm 段 → 作业登记（v2.49）。jobs 在下面才创建，这里只在调用时取用。
  let observeSlurm = null;
  const processes = createProcessProbe({
    getConfig,
    execFileCmd: ctx.execFileCmd,
    getMainServerConfig: ctx.getMainServerConfig,
    getConnectionTargets,
    platform,
    now,
  });
  const collect = createCollectProbes({
    getConfig,
    dataDir,
    execCollector: ctx.execCollector,
    getMainServerConfig: ctx.getMainServerConfig,
    probeSshFailureReason: ctx.probeSshFailureReason,
    appendLog,
    onSlurmSection: (serverId, text) => observeSlurm?.(serverId, text),
  });
  const validation = createValidationProbe({ getConfig, execFileCmd: ctx.execFileCmd, sshArgsFor: ctx.sshArgsFor, getProxyCredential });
  // Agent 用量（lib/usage/）：只有装配处给了 usageStore 才启用（测试与 fixture 模式可不给）。
  const usage = usageStore
    ? createUsageService({
      store: usageStore,
      getConfig,
      dataDir,
      execCollector: ctx.execCollector,
      probeSshFailureReason: ctx.probeSshFailureReason,
      jobRegistry: jobsStores?.registry || null,
      now,
    })
    : null;
  // 我的作业（lib/jobs/）：服务恒创建（toolkit.jobs 恒可读，未扫描过返回 null）；
  // 探针注册与用量同一装配门槛（给了 usageStore 才注册）——测试与未接用量的装配不多出 SSH 探针。
  // jobsStores（{ registry, diagnoses }，v2.49 失败作业诊断）：装配处给落盘实例；缺省只在内存里。
  const jobs = createJobsService({
    getConfig,
    dataDir,
    execCollector: ctx.execCollector,
    probeSshFailureReason: ctx.probeSshFailureReason,
    now,
    ...(jobsStores?.registry ? { registry: jobsStores.registry } : {}),
    ...(jobsStores?.diagnoses ? { diagnoses: jobsStores.diagnoses } : {}),
    ...(jobsStores?.watch ? { watchStore: jobsStores.watch } : {}),
    ...(usage ? { listSessions: (serverId) => usage.listServerSessions(serverId) } : {}),
    ...(appendLog ? { log: appendLog } : {}),
  });
  if (usage) observeSlurm = jobs.observeSlurmSection;
  // 本人目录占用（lib/dir-usage/）：只在用户手动点击时扫描，不注册任何探针；装配处给了存储才启用。
  const dirUsage = dirUsageStore
    ? createDirUsageService({ store: dirUsageStore, getConfig, dataDir, execCollector: ctx.execCollector, probeSshFailureReason: ctx.probeSshFailureReason, log: appendLog || null, now })
    : null;
  // 磁盘增长归因（lib/disk-growth/，v2.62）：按作业登记找出集合目录、定时量各子目录的大小。不注册探针，
  // 由服务自己按时间表发起（装配处调 start）；给了存储与落盘的登记表才启用。用户在扫目录占用时让路。
  const diskGrowth = diskGrowthStore && jobsStores?.registry
    ? createDiskGrowthService({
      store: diskGrowthStore,
      registry: jobsStores.registry,
      getConfig,
      dataDir,
      execCollector: ctx.execCollector,
      probeSshFailureReason: ctx.probeSshFailureReason,
      isDirUsageBusy: (serverId) => dirUsage?.isScanning(serverId) === true,
      log: appendLog || null,
      now,
    })
    : null;
  // 远端守护进程（lib/daemons/）：服务恒创建（无本机存储），启动动作写运维日志与状态时间线。
  // 同一次状态查询顺带列出本人监听的服务；装配处给了 serviceForwards（lib/daemons/forwards.mjs）才能把它们转发到本机。
  // fixtureMode：这块面板一可见就读状态，fixture 实例里必须整段换成假数据（不发 SSH、不起进程，见 daemons/fixture.mjs）。
  const daemons = createDaemonsService({
    getConfig,
    getMainServerConfig: ctx.getMainServerConfig,
    sshArgsFor: ctx.sshArgsFor,
    execCollector: ctx.execCollector,
    probeSshFailureReason: ctx.probeSshFailureReason,
    forwards: serviceForwards,
    fixtureMode,
    log: appendLog || null,
    timeline: writeTimeline,
    now,
  });
  // 官方 CLI 探测（lib/cli/service.mjs）：服务恒创建（toolkit.cli 恒可读，未探测过返回 null）；探针注册与作业同一装配门槛。
  const cli = createCliService({ getConfig, dataDir, execCollector: ctx.execCollector, probeSshFailureReason: ctx.probeSshFailureReason, now });
  // Codex 客户端守护进程（v2.85）：只在用户点「重启」时发 SSH；状态由 codex doctor 探针顺带读取
  //（同一次 SSH 里读 /proc/<pid>/environ，不新增探针）。重启动作写运维日志与状态时间线。
  const codexAppServer = createCodexAppServerService({
    getConfig,
    getMainServerConfig: ctx.getMainServerConfig,
    sshArgsFor: ctx.sshArgsFor,
    execFileCmd: ctx.execFileCmd,
    probeSshFailureReason: ctx.probeSshFailureReason,
    log: appendLog || null,
    timeline: writeTimeline,
    now,
  });
  // CLI 安装 / 更新 / 回滚（lib/cli/install-service.mjs）：最新版本走本机出网设置；安装 / 回滚 / 登录共用 cliTaskLock。
  const cliTaskLock = createCliTaskLock();
  const egressDetector = createSystemProxyDetector({ platform });
  const getCliUpstream = async () => resolveEgressUpstream({ egress: (await getConfig())?.egress, detector: egressDetector });
  // fixture 实例不联网：最新版本一律取不到（latest:null + error，界面就是「未知」），不去碰 npm 的 registry。
  const cliVersions = createCliVersionsService({
    getUpstream: getCliUpstream,
    now,
    ...(appendLog ? { log: appendLog } : {}),
    ...(fixtureMode ? { fetchJson: async () => { throw new Error("fixture 模式不联网"); } } : {}),
  });
  const cliInstall = createCliInstallService({
    getConfig,
    getMainServerConfig: ctx.getMainServerConfig,
    sshArgsFor: ctx.sshArgsFor,
    execCollector: ctx.execCollector,
    versions: cliVersions,
    getUpstream: getCliUpstream,
    downloadDir: path.join(dataDir || rootDir || ".", "cli-downloads"),
    taskLock: cliTaskLock,
    log: appendLog || null,
    timeline: writeTimeline,
    now,
  });
  const registrar = createProbeRegistrar({ getConfig, getLocalProxyLog, ctx, processes, collect, validation, usage, jobs: usage ? jobs : null, cli: usage ? cli : null, getProxyCredential });

  return {
    execFile: ctx.execFileCmd,
    getProcesses: processes.getProcesses,
    getMainServerConfig: ctx.getMainServerConfig,
    registerProbes: registrar.registerProbes,
    registerAgentProbes: registrar.registerAgentProbes,
    registerLoadProbes: registrar.registerLoadProbes,
    runValidationProbe: validation.runValidationProbe,
    registerValidationProbes: registrar.registerValidationProbes,
    usage,
    jobs,
    dirUsage,
    diskGrowth,
    daemons,
    cli,
    cliInstall,
    cliVersions,
    cliTaskLock,
    codexAppServer,
  };
}
