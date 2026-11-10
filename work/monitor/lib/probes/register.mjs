import { agentAdapterEnabled, listAgentAdapters } from "../agents/registry.mjs";
import { reclaudeAdapter } from "../agents/reclaude.mjs";
import { createSignalEngine } from "../log-signals.mjs";
import { createSectionScanner, DEFAULT_LOG_SOURCES } from "../log-tail-probe.mjs";
import { isJobsEligible, JOBS_SCAN_INTERVAL_MS } from "../jobs/service.mjs";
import { FORENSICS_TIMEOUT_MS } from "../jobs/forensics.mjs";
import { JOBS_SCAN_TIMEOUT_MS } from "../jobs/scan.mjs";
import { JOB_WATCH_TIMEOUT_MS } from "../jobs/watch-scan.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { CLI_SCAN_INTERVAL_MS, CLI_SCAN_TIMEOUT_MS, isCliEligible } from "../cli/service.mjs";
import { cliProbeId, collectSlowProbeId, jobsProbeId, LOG_SIGNALS_PROBE_ID, PROCESSES_PROBE_ID, usageProbeId, validationProbeId } from "../probe-ids.mjs";
import { isUsageEligible, USAGE_BACKFILL_INTERVAL_MS, USAGE_SCAN_INTERVAL_MS } from "../usage/service.mjs";
import { USAGE_SCAN_TIMEOUT_MS } from "../usage/scan.mjs";
import { toPort } from "../validators.mjs";
import { COLLECT_SLOW_INTERVAL_MS, COLLECT_SLOW_TIMEOUT_MS } from "./collect.mjs";
import { SSH_JUMP_EXTRA_TIMEOUT_MS } from "../ssh-route.mjs";
import { shouldRegisterValidation, VALIDATION_INTERVAL_MS, validationTimeoutMs } from "./validation.mjs";

// reclaude 关闭时 fast 采集仍取回 reclaude 两段（脚本不变、端口证据不受影响），只是不再扫描。
const RECLAUDE_LOG_SOURCE_IDS = new Set(["reclaude-logs", "reclaude-state"]);

// 探针注册（间隔与规格 3.2 表格一致）。注册序即调度器 tick 的遍历序，改动须谨慎：
// 启动时 processes → 启用的适配器探针（按注册表序）→ log-signals；热载新启用的适配器
// 追加在末尾（只影响 SSH 槽位满载时同一拍的先后，不影响正确性）。
// agent 专属探针已收拢进 lib/agents/ 各适配器的 probeSpecs(ctx)，这里按注册表统一注册。
export function createProbeRegistrar({ getConfig, getLocalProxyLog, ctx, processes, collect, validation, usage = null, jobs = null, cli = null, getProxyCredential = () => null }) {
  const adapterCtx = {
    getConfig,
    getMainServerConfig: ctx.getMainServerConfig,
    // 代理口令（v2.62）：经反向端口出网的适配器探针用它决定带不带口令（null = 不带，命令与以前逐字相同）。
    getProxyCredential,
    execFileCmd: ctx.execFileCmd,
    // 远端脚本经 stdin 送达的执行入口（claude-code 适配器复用 remote/cli-probe.sh）。
    execCollector: ctx.execCollector,
    sshArgsFor: ctx.sshArgsFor,
    probeSshFailureReason: ctx.probeSshFailureReason,
  };

  // 适配器探针：各适配器的 probeSpecs(ctx) 声明 id/间隔/超时/run，
  // layer/usesSsh/熔断门控在此统一补齐——接第三个 agent 只需注册新适配器。
  function registerAdapterSpecs(scheduler, adapter, breakerEnabled) {
    const buildContext = ctx.activeServerProbeContext();
    const hostKey = ctx.activeHostKey();
    for (const spec of adapter.probeSpecs(adapterCtx)) {
      scheduler.registerProbe({
        layer: "agents",
        usesSsh: true,
        hostKey,
        enabled: breakerEnabled,
        ...spec,
        run: ctx.wrapWithProbeContext(async () => {
          const main = ctx.getMainServerConfig(await getConfig());
          if (!main || main.tunnel === false) return { level: "skipped", reason: main ? "仅监控，未启用 Agent 检查" : "未配置可用服务器", data: null };
          // 没领反向端口：agent 探针的远端命令都要经 http://127.0.0.1:<端口> 出网，没有端口就没有通路
          //（也绝不能拼出 :undefined 或借用别人的端口）。通道熔断门本就会挡住，这里是纵深防御。
          if (toPort(main.remotePort) === null) return { level: "skipped", reason: "未领取反向端口，暂不检查 Agent", data: null };
          return spec.run();
        }, buildContext),
      });
    }
  }

  // 按配置注册启用适配器的探针，返回本轮应存活的 agent 探针 id（热载 diff 注销用）。
  // 启用口径与 state-store 同一判定（agentAdapterEnabled：运行配置 agents[] 已按个人层
  // disabledModules 过滤）；config 缺省（未经归一化的调用方）按默认物化口径 codex + reclaude。
  // 不注册禁用适配器而不是靠 enabled 回调门控：调度器对 enabled=false 的探针每轮都会发
  // level:"skipped" 的 PROBE_UPDATED，泄漏出禁用 agent 的足迹——不注册才是零足迹。
  // alreadyRegistered：上一轮已注册的 id。整组已在册的适配器不重注册——probeSpecs() 每次
  // 调用都会新建闭包（doctor 的 ok 连击计数），重注册会把健康稳态的 5 分钟节奏打回 90 秒；
  // 调度器的 results/nextCheckAt 本就按 id 保留，不重注册也不影响主机键与诊断上下文
  // （两者都在运行时现读配置）。
  function registerAgentProbes({ scheduler, config, getShouldBeRunning, isChannelOk, alreadyRegistered = [] }) {
    const breakerEnabled = () => getShouldBeRunning() && isChannelOk();
    const registered = new Set(alreadyRegistered);
    const ids = [];
    for (const adapter of listAgentAdapters()) {
      if (!agentAdapterEnabled(adapter, config)) continue;
      if (!adapter.probeIds.every((id) => registered.has(id))) registerAdapterSpecs(scheduler, adapter, breakerEnabled);
      ids.push(...adapter.probeIds);
    }
    return ids;
  }

  // v2.10：卡顿反馈信号探针——10s 增量抓取远端日志尾巴，统一签名识别。
  // v2.18 起改走 fast profile 采集脚本（一条 SSH 同时拿日志尾巴/state/端口）。
  // 命中账号层信号时立即 forceRun reclaude 复核完整账号状态（不等 90s TTL）。
  // v2.47：reclaude 模块关闭时不扫 reclaude 两段、也不触发复核（探针已注销）；
  // 本探针本身永不注销——它是远端端口结论的唯一数据源。
  function registerLogSignalsProbe(scheduler, getShouldBeRunning, onLogSignals) {
    const signalEngine = createSignalEngine({});
    const reclaudeEnabled = (config) => agentAdapterEnabled(reclaudeAdapter, config);
    const runCollectFastProbe = collect.createCollectFastRun({
      scanSections: createSectionScanner({
        // connect-deny 由本地 CONNECT 代理打印、经 supervisor 结构化日志落盘；它不在
        // 远端 reclaude logs 中。读取失败只让该来源为空，不得影响远端日志探测或通道保活。
        getLocalProxyLog,
        engine: signalEngine,
        onSignals: (newSignals, activeSignals) => {
          if (newSignals.some((s) => s.category === "account")) {
            // 以触发时的配置为准：关掉 reclaude 后账号层信号不再复核（其探针已注销）。
            getConfig()
              .then((config) => (reclaudeEnabled(config) ? scheduler.forceRun("reclaude") : null))
              .catch(() => {});
          }
          if (onLogSignals) onLogSignals(newSignals, activeSignals);
        },
      }),
      logSourcesFor: (config) => (reclaudeEnabled(config)
        ? DEFAULT_LOG_SOURCES
        : DEFAULT_LOG_SOURCES.filter((source) => !RECLAUDE_LOG_SOURCE_IDS.has(source.id))),
    });
    scheduler.registerProbe({
      id: LOG_SIGNALS_PROBE_ID,
      layer: "agents",
      intervalMs: 10000,
      timeoutMs: 15000,
      usesSsh: true,
      hostKey: ctx.activeHostKey(),
      // 门控与旧 primary-remote 一致（只看 shouldBeRunning），**不受通道健康熔断**：
      // 这条探针现在同时是 remotePortOpen 的唯一数据源，若跟着熔断走，
      // 通道一断 → 探针被跳过 → remotePortOpen 永不更新 → 通道永远恢复不了（死锁）。
      enabled: () => getShouldBeRunning(),
      // 主机退避期间由它探路：最快（15s 内有结论），且端口结论就在它身上。
      canary: true,
      run: ctx.wrapWithProbeContext(runCollectFastProbe, ctx.activeServerProbeContext()),
    });
  }

  // 启动注册：processes → 按 config 启用的适配器探针 → log-signals。返回 { agentProbeIds }，
  // 供配置内核桥（config-hot-reload.mjs）作为 agent 探针的热载基线。
  function registerProbes({ scheduler, getShouldBeRunning, isChannelOk, onLogSignals, config }) {
    scheduler.registerProbe({
      id: PROCESSES_PROBE_ID,
      layer: "channel",
      intervalMs: 5000,
      timeoutMs: processes.queryTimeoutMs || 10000,
      run: processes.runProcessesProbe,
    });
    const agentProbeIds = registerAgentProbes({ scheduler, config, getShouldBeRunning, isChannelOk });
    registerLogSignalsProbe(scheduler, getShouldBeRunning, onLogSignals);
    return { agentProbeIds };
  }

  // v2.18：每台未禁用服务器（含 tunnel:false 的「只监控」条目）注册一枚 60s 的
  // slow 采集探针，取代旧的 primary-remote(15s) + load:*(120s) 两组 SSH 探针。
  // 函数名沿用 registerLoadProbes：config-hot-reload 的热载 diff/注销走同一入口，
  // 返回的 id 列表即该轮应存活的探针集合。
  // 幂等：registerProbe 以 id 覆盖旧定义，配置变化后可重复调用。
  // modules（运行配置的 { usage, jobs }）：设置页「监控模块」关掉的数据采集不产出对应探针，
  // 热载 diff 随即注销；缺省全开。
  function registerLoadProbes({ scheduler, servers, getShouldBeRunning, modules }) {
    const usageOn = Boolean(usage) && isDataModuleEnabled({ modules }, "usage");
    const jobsOn = Boolean(jobs) && isDataModuleEnabled({ modules }, "jobs");
    const ids = [];
    const liveServerIds = [];
    for (const server of servers || []) {
      // disabled 条目不进探针（个人层"我不在这个集群，屏蔽它"）。
      if (!server || server.disabled === true) continue;
      const id = collectSlowProbeId(server.id);
      scheduler.registerProbe({
        id,
        layer: "resources",
        intervalMs: COLLECT_SLOW_INTERVAL_MS,
        timeoutMs: COLLECT_SLOW_TIMEOUT_MS + (server.sshJumpServerId ? SSH_JUMP_EXTRA_TIMEOUT_MS : 0),
        usesSsh: true,
        hostKey: () => server.host,
        enabled: () => getShouldBeRunning(),
        // 不是查看中的服务器没有 fast 采集，退避期间由 slow 探路（同一台上两者都在时 fast 注册在前、优先）。
        canary: true,
        run: ctx.wrapWithProbeContext(() => collect.runCollectSlowProbe(server.id), ctx.serverProbeContext(server.id)),
      });
      ids.push(id);
      liveServerIds.push(server.id);
      // Agent 用量：团队服务器各一枚 usage:<serverId>（个人服务器不采集）。回填未完成时 5s 后接着扫。
      if (usageOn && isUsageEligible(server)) {
        const usageId = usageProbeId(server.id);
        scheduler.registerProbe({
          id: usageId,
          layer: "usage",
          intervalMs: (result) => (result?.level === "ok" && result.data?.complete === false ? USAGE_BACKFILL_INTERVAL_MS : USAGE_SCAN_INTERVAL_MS),
          timeoutMs: USAGE_SCAN_TIMEOUT_MS + 5000,
          usesSsh: true,
          hostKey: () => server.host,
          enabled: () => getShouldBeRunning(),
          run: ctx.wrapWithProbeContext(() => usage.runScan(server.id), ctx.serverProbeContext(server.id)),
        });
        ids.push(usageId);
      }
      // 我的作业：与用量同一采集范围，各一枚 jobs:<serverId>，5 分钟一轮（每轮覆盖近 48h）。
      // layer "jobs" 不被状态仓 / 事件 / 指标消费，结果只进 jobs 服务的内存快照。
      // v2.49：有新失败时同一轮接着发一次取证 SSH，整轮超时把取证的预算也算进去。
      if (jobsOn && isJobsEligible(server)) {
        const jobsId = jobsProbeId(server.id);
        scheduler.registerProbe({
          id: jobsId,
          layer: "jobs",
          intervalMs: JOBS_SCAN_INTERVAL_MS,
          timeoutMs: JOBS_SCAN_TIMEOUT_MS + FORENSICS_TIMEOUT_MS + JOB_WATCH_TIMEOUT_MS + 5000,
          usesSsh: true,
          hostKey: () => server.host,
          enabled: () => getShouldBeRunning(),
          run: ctx.wrapWithProbeContext(() => jobs.runScan(server.id), ctx.serverProbeContext(server.id)),
        });
        ids.push(jobsId);
      }
      // 官方 CLI（v2.57）：与用量同一采集范围，各一枚 cli:<serverId>，10 分钟一轮；安装 / 登录后由
      // CLI 服务的 refresh() 经 forceRun 插队。不受模块开关影响（安装 / 登录入口要用它）。
      if (cli && isCliEligible(server)) {
        const cliId = cliProbeId(server.id);
        scheduler.registerProbe({
          id: cliId,
          layer: "cli",
          intervalMs: CLI_SCAN_INTERVAL_MS,
          timeoutMs: CLI_SCAN_TIMEOUT_MS + 5000,
          usesSsh: true,
          hostKey: () => server.host,
          enabled: () => getShouldBeRunning(),
          run: ctx.wrapWithProbeContext(() => cli.runScan(server.id), ctx.serverProbeContext(server.id)),
        });
        ids.push(cliId);
      }
    }
    collect.pruneCpuCache(liveServerIds);
    if (cli) {
      cli.prune(liveServerIds.filter((serverId) => isCliEligible((servers || []).find((s) => s?.id === serverId))));
      cli.bindRefresh((serverId) => scheduler.forceRun(cliProbeId(serverId)));
    }
    // v2.49：slow 采集发现本用户作业从队列消失 → 提前跑一轮 jobs:<id>（赶 MinJobAge 窗口）。
    // 模块关闭时解绑；未注册的服务器 forceRun 会 reject，吞掉即可。
    if (jobs?.bindEarlyScan) {
      jobs.bindEarlyScan(jobsOn ? (serverId) => scheduler.forceRun(jobsProbeId(serverId)).catch(() => {}) : null);
    }
    return ids;
  }

  // validation 探针：只注册活跃服务器那一枚，返回 id 列表供热载 diff 注销旧别名。
  function registerValidationProbes({ scheduler, servers, activeServerId, getShouldBeRunning, getChannelUp }) {
    const ids = [];
    for (const server of servers || []) {
      if (!shouldRegisterValidation(server, activeServerId)) continue;
      const id = validationProbeId(server.id);
      scheduler.registerProbe({
        id,
        layer: "resources",
        intervalMs: VALIDATION_INTERVAL_MS,
        timeoutMs: validationTimeoutMs(server.validationProfile),
        usesSsh: true,
        hostKey: () => server.host,
        enabled: () => getShouldBeRunning() && getChannelUp(),
        run: ctx.wrapWithProbeContext(() => validation.runValidationProbe(server.id), ctx.serverProbeContext(server.id)),
      });
      ids.push(id);
    }
    return ids;
  }

  return { registerProbes, registerAgentProbes, registerLoadProbes, registerValidationProbes };
}
