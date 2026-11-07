import { spawn as defaultSpawn } from "node:child_process";
import { mkdir as defaultMkdir, stat as defaultStat } from "node:fs/promises";

import {
  getSupervisorCommand,
  computeRepairBackoffMs,
  tunnelRecordName,
} from "../monitor-core.mjs";
import { resolveProxyPort, resolveTunnelTargets } from "./config-loader.mjs";
import { collectSlowProbeId, LOG_SIGNALS_PROBE_ID, PROCESSES_PROBE_ID } from "./probe-ids.mjs";
import { cmdlineMatches } from "./process-registry.mjs";
import { buildTunnelSignature } from "./supervisor/tunnel-spec.mjs";

// ---- 命名常量（值与历史行为一致）----

const AUTO_REPAIR_TICK_MS = 5000; // 守护巡检节拍
const MAINTENANCE_SWEEP_EVERY_TICKS = 12; // 低频维护挂在巡检的第 12 拍（约 60s）
// processes 探针周期 5s：结果在 6s 内视为新鲜，守护巡检直接复用，免去独立的全量 ps 扫描。
const PROCESSES_RESULT_FRESH_MS = 6000;

// stopChannel 的 pgrep 兜底（A3）：曾用 `cmdline.includes(rootDir)` 校验候选 pid 是否属于
// 本项目，但受管进程都以相对路径 argv 启动（spawn 前先 cd 到 rootDir），该判据对全部三个
// 角色都永假——兜底从未真正生效过，孤儿隧道从 UI/clean-start 都杀不掉，却回报
// "stop completed"。改用与 monitor-core.parseProcessList 一致的强特征（脚本名 / 精确 -R
// 转发串 + host），不依赖绝对 rootDir。
const MANAGED_PROCESS_SIGNATURES = {
  supervisor: "work/monitor/channel-supervisor.mjs",
  localProxy: "local_http_connect_proxy.mjs",
};

// 单条隧道的强特征：精确 -R 转发串 + host，即 supervisor 的隧道签名（buildTunnelSignature），
// 按 process-registry 同一把尺子（签名每一段都须出现在命令行里）比对。
function matchesTunnelForward(cmdline, target) {
  if (!target?.remotePort || !target.localPort || !target.host) return false;
  return cmdlineMatches(cmdline, { signature: buildTunnelSignature(target) });
}

// tunnel 角色的 config 就是那一条隧道（host / remotePort / localPort）。
export function matchesManagedProcess(cmdline, { role, config } = {}) {
  if (typeof cmdline !== "string" || !cmdline) return false;
  if (role === "supervisor" || role === "localProxy") {
    return cmdline.includes(MANAGED_PROCESS_SIGNATURES[role]);
  }
  if (role === "tunnel") return matchesTunnelForward(cmdline, config);
  return false;
}

// 通道生命周期工厂：startChannel / stopChannel / autoRepairChannel / maintenanceSweep /
// 守护循环调度，以及 shouldBeRunning 运行意图与修复退避状态。所有外部效应（spawn、fs、
// 定时器、进程信号）经依赖注入传入，模块顶层无副作用，便于单元测试直接驱动状态机。
export function createChannelLifecycle({
  rootDir,
  paths, // resolveRuntimePaths 结果：{ dataRoot, runtimeDir, configPath, localConfigPath, ... }
  fixtureMode = false,
  appendLog,
  registry,
  scheduler,
  toolkit,
  store,
  getConfig,
  refreshConfigIntoKernel,
  spawnImpl = defaultSpawn,
  mkdirImpl = defaultMkdir,
  statImpl = defaultStat,
  setTimeoutImpl = setTimeout,
  killImpl = (pid, signal) => process.kill(pid, signal),
  selfPid = process.pid,
  env = process.env,
  now = Date.now,
  // 执行器（单隧道操作 / 数据面热升级）在飞时挡下通道重启——两者都在动同一批
  // 隧道/进程，并发会互踩。迟绑定闭包，装配顺序上 runner 后创建也成立。
  isBlocked = () => false,
  // 通道级重启已受理（未重入、未被执行器挡下）时回调本次操作上下文（含 operationId）：
  // 装配层据此关联未解决的隧道/通道事件（「查看处置日志」）。回调异常被吞掉。
  onRestartAccepted = () => {},
} = {}) {
  let shouldBeRunning = true;
  let repairInFlight = false;
  let restartInFlight = false;
  let repairFailures = 0;
  let repairLastAttemptAt = 0;
  // 热更新数据面交接窗口：旧 supervisor 已退出、新 supervisor 尚未登记的这几秒里，
  // 守护巡检绝不能抢先拉起第二个 supervisor（它会覆写注册表并与交接流程互踩）。
  // 计数而非布尔：嵌套持有安全。
  let autoRepairHolds = 0;

  // ---- 通道启停 ----

  async function startChannel(context) {
    appendLog("start requested", context);
    shouldBeRunning = true;
    store.setShouldBeRunning(true);
    if (fixtureMode) {
      appendLog("start completed (fixture)", context);
      return;
    }
    await autoRepairChannel({ force: true });
    // 强制立即刷新通道探针缓存。
    // v2.18：primary-remote 已随零残留采集注销，forceRun 它只会 reject 一个
    // "未注册的探针"（被 .catch 吞掉）——探活验证这一步实际上从未执行过。
    // 现在改刷真正承担那两份职责的探针：log-signals（fast，含远端端口结论）
    // 与活跃服务器的 collect:slow（负载/GPU）。
    const forcedProbeIds = [PROCESSES_PROBE_ID, LOG_SIGNALS_PROBE_ID];
    const activeServerId = await resolveActiveServerId();
    // 没有活跃服务器时不拼半截 id：`collect:slow:` 在调度器里查无此探针，
    // 只会白跑一次 forceRun 并留下误导性日志（与 auto-repair-policy 同口径）。
    if (activeServerId) forcedProbeIds.push(collectSlowProbeId(activeServerId));
    for (const probeId of forcedProbeIds) scheduler.forceRun(probeId).catch(() => {});
    // runbook 的"探活验证"步骤靠日志文案推进（render/repair-runbook.js 的 mapLogToStep
    // 匹配 /probe|探活|验证/）。这条是该步骤在 /api/restart 全程里唯一的证据。
    appendLog(`probe ${forcedProbeIds.join(" / ")} forced`, context);
    appendLog("start completed", context);
  }

  // 活跃服务器 id：优先走 toolkit.getMainServerConfig（与 state-store 的 mainServer()
  // 同一套回落规则），拿不到再退回配置里的裸 activeServerId。读配置失败不能让启动流程
  // 中断——探针刷新是锦上添花，通道已经拉起来了。
  async function resolveActiveServerId() {
    try {
      const parsed = await getConfig();
      return toolkit.getMainServerConfig?.(parsed)?.id || parsed?.activeServerId || "";
    } catch {
      return "";
    }
  }

  // v2.18 L2 自动修复的执行入口：与 /api/restart 完全同一条序列（stopChannel +
  // startChannel），只是把 trigger/ruleId/event 打进 operation context，让 ops 日志与
  // 前端时间线能把这次重启认成"自动"而不是某个看不见的人点的。
  //
  // 为什么单独一个 restartInFlight 而不复用 repairInFlight：startChannel 内部会调
  // autoRepairChannel({force:true})，而后者开头就是 `if (repairInFlight) return`——
  // 若在这里置 repairInFlight，重启的"拉起 supervisor"那一步会被自己挡掉，变成
  // 只停不起。两个旗标经 getRepairInFlight 合并对外，策略层看到的仍是一个"修复进行中"。
  async function restartChannel(options = {}) {
    const trigger = options.trigger === "auto" ? "auto" : "manual";
    const ruleId = typeof options.ruleId === "string" ? options.ruleId : "";
    if (restartInFlight) return { ok: false, reason: "restart already in flight" };
    // 执行器互斥：只挡"发起"，已在飞的重启不受影响（执行器那边同样先看通道旗标）。
    try {
      if (isBlocked()) return { ok: false, reason: "operation in flight" };
    } catch {}
    restartInFlight = true;
    // options.context：手动路径（/api/restart）把请求的 operationContext 原样带进来，
    // 日志形状与旧的 stop+start 两句逐字一致；自动路径才额外打 trigger/ruleId/event。
    const context = {
      ...(options.context && typeof options.context === "object" ? options.context : {}),
      trigger,
      ...(trigger === "auto" ? { event: "auto-repair", ...(ruleId ? { ruleId } : {}) } : {}),
    };
    try {
      onRestartAccepted(context);
    } catch {}
    try {
      await stopChannel(context);
      await startChannel(context);
      return { ok: true, reason: "" };
    } catch (error) {
      appendLog(`restart failed: ${error.message}`, { level: "error", ...context });
      return { ok: false, reason: error.message };
    } finally {
      restartInFlight = false;
    }
  }

  // 停止目标清单：supervisor 在首位（停止次序的前提），随后是本地代理与各条隧道。
  // D2：没有任何要建隧道的服务器（空配置 / 全部屏蔽或 tunnel:false）时跳过按端口模式的
  // tunnel 清理（无端口对无从匹配，乱杀反而危险），supervisor/local-proxy 照停。
  function buildStopTargets(parsed, context) {
    const targets = [
      {
        name: "channel-supervisor",
        role: "supervisor",
        pattern: "work/monitor/channel-supervisor.mjs",
      },
      {
        name: "local-proxy",
        role: "localProxy",
        pattern: "work/local_http_connect_proxy.mjs",
      },
    ];
    // v2.18 多隧道：每台配了隧道的服务器展开一个 tunnel.<serverId> 目标，各自带 -R 端口模式：
    // 缺记录（或记录校验失败）时 stopTarget 按它走 pgrep 兜底。
    // 所有 -R 都落在同一个本地代理端口上，所以模式里的 localPort 一律取 proxyPort。
    const proxyPort = resolveProxyPort(parsed);
    const tunnelConfigs = resolveTunnelTargets(parsed, {
      warn: (message) => appendLog(message, context),
    })
      // 无 id 的条目没有 tunnel.<serverId> 记录可停（supervisor 侧同样不给它建隧道）。
      .filter((target) => Boolean(target.serverId))
      .map((target) => ({ id: target.serverId, host: target.host, remotePort: target.remotePort, localPort: proxyPort }));
    for (const tunnel of tunnelConfigs) {
      targets.push({
        name: tunnelRecordName(tunnel.id),
        role: "tunnel",
        pattern: `ssh.*127.0.0.1:${tunnel.remotePort}:127.0.0.1:${tunnel.localPort}`,
        config: tunnel,
      });
    }
    if (tunnelConfigs.length === 0) {
      appendLog("stop: no tunnel configured, skipping tunnel port-pattern cleanup", context);
    }
    return targets;
  }

  // 1. 优先用进程注册表（pid.json + 命令行校验）精准停止。返回是否已停下。
  async function stopViaRegistry(target, context) {
    if (!registry.readMeta(target.name)) return false;
    const result = await registry.stopProcess(target.name);
    appendLog(`stop ${target.name}: ${result.reason}`, context);
    return Boolean(result.stopped);
  }

  // 2. pgrep 兜底：仅在无 pid 记录时启用，逐个 PID 用与 monitor-core.parseProcessList
  //    一致的强特征（脚本名 / 精确 -R 转发串 + host）校验命令行才杀（A3：旧版用
  //    cmdline.includes(rootDir) 校验，但受管进程 argv 全相对路径，该判据永假，
  //    兜底从未真正生效——孤儿隧道从 UI/clean-start 都杀不掉，却回报 "stop completed"）。
  async function stopViaPgrep(target) {
    try {
      const { stdout } = await toolkit.execFile("pgrep", ["-f", target.pattern]);
      const pids = stdout
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => pid > 0 && pid !== selfPid);
      for (const pid of pids) {
        const { stdout: cmdline } = await toolkit.execFile("ps", ["-o", "command=", "-p", String(pid)]);
        if (cmdline && matchesManagedProcess(cmdline, { role: target.role, config: target.config })) {
          try {
            killImpl(pid, "SIGTERM");
            appendLog(`stop ${target.name}: fallback kill pid ${pid}`);
          } catch {}
        }
      }
    } catch {}
  }

  async function stopTarget(target, context) {
    if (await stopViaRegistry(target, context)) return;
    await stopViaPgrep(target);
  }

  async function stopChannel(context) {
    appendLog("stop requested", context);
    // 停止意图落地：清除 shouldBeRunning，autoRepairChannel（5s 巡检）据此不再自动拉起。
    // /api/restart 会在 stopChannel 之后调用 startChannel 重新置为 true；启动引导路径亦会显式复位。
    shouldBeRunning = false;
    store.setShouldBeRunning(false);
    if (fixtureMode) {
      appendLog("stop completed (fixture)", context);
      return;
    }
    const parsed = await getConfig();
    const [supervisorTarget, ...childTargets] = buildStopTargets(parsed, context);

    // 停止次序：必须先确认 channel-supervisor 已死，再动 proxy/tunnel——
    // 否则 supervisor 的保活循环会在停止窗口内把刚杀掉的子进程重新拉起。
    // 两个子进程互不依赖，随后并行停止。
    await stopTarget(supervisorTarget, context).catch((err) => {
      appendLog(`stop ${supervisorTarget.name} failed: ${err.message}`);
    });
    await Promise.all(childTargets.map((target) => stopTarget(target, context).catch((err) => {
      appendLog(`stop ${target.name} failed: ${err.message}`);
    })));

    appendLog("stop completed");
  }

  // E1：守护巡检每 5s 一拍，旧实现每拍都独立跑一次全量 ps 扫描，而 processes 探针（同为
  // 5s 周期）刚扫过。结果在 PROCESSES_RESULT_FRESH_MS(6s) 内视为新鲜直接复用；过期（探针
  // 停摆/尚未首轮）才回落自扫。注意 force 路径（/api/start、restart）不走缓存：stop→start
  // 连续操作时缓存可能还是 stop 前的旧世界，必须以实时扫描为准。
  async function getProcessesPreferCached() {
    try {
      const cached = scheduler.getResult(PROCESSES_PROBE_ID);
      const cachedProcesses = cached?.data?.processes;
      if (
        cachedProcesses &&
        typeof cached.checkedAt === "number" &&
        now() - cached.checkedAt <= PROCESSES_RESULT_FRESH_MS
      ) {
        return cachedProcesses;
      }
    } catch {}
    return toolkit.getProcesses();
  }

  // 拉起一个 supervisor（守护巡检自愈与热更新交接共用同一条 spawn 路径）：
  // 用当前 process.execPath（打包模式即新 .app 的 Electron 二进制）+ appRoot 下的
  // work/monitor/channel-supervisor.mjs，detached + stdio ignore，登记注册表。
  async function spawnSupervisor() {
    const spec = getSupervisorCommand(rootDir, {
      dataRoot: paths.dataRoot,
      runtimeDir: paths.runtimeDir,
      configPath: paths.configPath,
      localConfigPath: paths.localConfigPath,
    });
    for (const dir of spec.mkdir || []) {
      await mkdirImpl(dir, { recursive: true });
    }
    const child = spawnImpl(spec.execPath, spec.args, {
      cwd: spec.cwd,
      env: { ...env, ...spec.env },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) {
      registry.recordProcess("channel-supervisor", child.pid, {
        command: "node work/monitor/channel-supervisor.mjs",
        args: spec.args,
        cwd: spec.cwd,
        parentPid: selfPid,
        signature: "work/monitor/channel-supervisor.mjs",
      });
    }
    return { pid: child.pid ?? null };
  }

  function holdAutoRepair() {
    autoRepairHolds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      autoRepairHolds = Math.max(0, autoRepairHolds - 1);
    };
  }

  async function autoRepairChannel(options = {}) {
    if (repairInFlight) return;
    if (autoRepairHolds > 0) {
      if (options.force) appendLog("start: data-plane handoff in progress, supervisor spawn deferred to the handoff flow");
      return;
    }
    if (!shouldBeRunning && !options.force) return;
    repairInFlight = true;
    try {
      const processes = options.force ? await toolkit.getProcesses() : await getProcessesPreferCached();
      const supervisorUp = processes.supervisor.length > 0;
      if (supervisorUp) {
        // D1：force（/api/start、restart）此前完全跳过存活检查直接 spawn——supervisor 有
        // 单实例锁，重复 spawn 的新进程会立刻 exit(3)，但 pid 文件与注册表已被覆写成必死
        // pid，之后 stopProcess 因命令行校验失败拒绝停止（孤儿 supervisor 杀不掉）。
        // 现在无论 force 与否：已存活就绝不重复 spawn、绝不覆写注册表。
        if (options.force) {
          appendLog("start: channel supervisor already running, skipping duplicate spawn");
        }
        repairFailures = 0;
        repairLastAttemptAt = 0;
        return;
      }
      if (!options.force) {
        const { verified } = await registry.verifyProcess("channel-supervisor");
        if (verified) {
          repairFailures = 0;
          repairLastAttemptAt = 0;
          return;
        }
        const nowMs = now();
        if (repairFailures > 0 && nowMs < repairLastAttemptAt + computeRepairBackoffMs(repairFailures)) {
          return;
        }
      }
      appendLog("auto starting channel supervisor", {
        level: repairFailures > 0 ? "warn" : "info",
        event: "supervisor-repair",
        attempt: repairFailures + 1,
        nextAction: "若反复失败，查看 work/runtime/logs/supervisor.ndjson 中的 ssh 失败原因与 nextAction",
      });
      await spawnSupervisor();
      repairFailures += 1;
      repairLastAttemptAt = now();
    } catch (error) {
      appendLog(`auto repair failed: ${error.message}`, { level: "error", event: "supervisor-repair" });
      repairFailures += 1;
      repairLastAttemptAt = now();
    } finally {
      repairInFlight = false;
    }
  }

  // 低频维护（约 60s 一次，挂在 5s 巡检的第 12 拍）：
  // 1) 注册表 GC——listRuntimeProcesses 对校验失败的 pid.json 有 unlink 副作用，
  //    崩溃/被 kill -9 的进程登记靠这里回收；
  // 2) config.json / config.local.json 外部编辑侦测——mtime 变化即热载进内核（探针注册/注销随之收敛）。
  let configMtimeMs = null;
  let localConfigMtimeMs = null;
  // 基线必须在启动时就位：若等到首次巡检（~60s）才记录，启动后 60s 内的外部编辑
  // 会被吸收进基线而永远不触发热载。
  statImpl(paths.configPath).then((info) => {
    if (configMtimeMs == null) configMtimeMs = info.mtimeMs;
  }).catch(() => {});
  statImpl(paths.localConfigPath).then((info) => {
    if (localConfigMtimeMs == null) localConfigMtimeMs = info.mtimeMs;
  }).catch(() => {});
  async function maintenanceSweep() {
    try {
      await registry.listRuntimeProcesses();
    } catch {}
    let changed = false;
    try {
      const info = await statImpl(paths.configPath);
      if (configMtimeMs != null && info.mtimeMs !== configMtimeMs) changed = true;
      configMtimeMs = info.mtimeMs;
    } catch {}
    try {
      const info = await statImpl(paths.localConfigPath);
      if (localConfigMtimeMs != null && info.mtimeMs !== localConfigMtimeMs) changed = true;
      localConfigMtimeMs = info.mtimeMs;
    } catch {
      // 个人层文件缺失是正常态（未生成/被删除）；若此前存在过则视为一次变化，需回落团队层。
      if (localConfigMtimeMs != null) changed = true;
      localConfigMtimeMs = null;
    }
    if (changed) {
      appendLog("config.json changed on disk, reloading into kernel");
      // C：热载失败（配置损坏 / 探针注册异常）不能让 maintenanceSweep 向上抛——
      // 否则守护循环的续期链会被打断。记 error 日志，下一拍会因 mtime 已推进而不再重试，
      // 直到文件再次被编辑。
      try {
        await refreshConfigIntoKernel();
      } catch (err) {
        appendLog(`config hot-reload failed: ${err.message}`, { level: "error" });
      }
    }
  }

  let repairTickCount = 0;
  // C：守护循环断链修复。旧实现 `await autoRepairChannel(); ...; scheduleAutoRepair()`——
  // 任一 await 抛出（autoRepairChannel 自身有 try/catch，但 maintenanceSweep 的
  // listRuntimeProcesses/stat 之外仍有未包裹路径）则续期语句永不执行，5s 巡检从此静默死亡，
  // supervisor 崩溃后再无人拉起。现在循环体整体 try/catch，续期放 finally 保证必然发生。
  function scheduleAutoRepair(delayMs = AUTO_REPAIR_TICK_MS) {
    setTimeoutImpl(async () => {
      try {
        await autoRepairChannel();
        repairTickCount += 1;
        if (repairTickCount % MAINTENANCE_SWEEP_EVERY_TICKS === 0) await maintenanceSweep();
      } catch (error) {
        appendLog(`auto repair loop error: ${error.message}`, { level: "error", event: "supervisor-repair" });
      } finally {
        scheduleAutoRepair();
      }
    }, delayMs);
  }

  return {
    getShouldBeRunning: () => shouldBeRunning,
    setShouldBeRunning: (value) => {
      shouldBeRunning = value === true;
    },
    startChannel,
    stopChannel,
    restartChannel,
    // 策略层的互斥判据（设计 §6.7 "runbook 进行中互斥"）：守护巡检的自愈与
    // 一键/自动重启都算"修复进行中"，任一在跑就不许再产出新动作。
    getRepairInFlight: () => repairInFlight || restartInFlight || autoRepairHolds > 0,
    getProcessesPreferCached,
    autoRepairChannel,
    spawnSupervisor,
    holdAutoRepair,
    maintenanceSweep,
    scheduleAutoRepair,
  };
}
