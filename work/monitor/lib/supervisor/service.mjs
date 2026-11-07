// supervisor 服务：数据面守护进程的装配与主循环（本地代理 1 个 + 每台服务器 1 条 ssh -R）。
//
// 共享状态只有一个对象（createSupervisorState），由本服务持有；各协作模块拿到的是这个对象
// 或读它的 getter，按字段现读——不许把 stopping / handoffExiting 这类布尔值解构成局部副本，
// 否则交接退出/停止置位后，协作方看到的仍是旧值。
import path from "node:path";

import { tunnelRecordName } from "../../monitor-core.mjs";
import { createRateLimiter } from "../auto-repair-policy.mjs";
import { flushAllLoggers } from "../logger.mjs";
import { createVerifyPrefetcher, waitForPidExit } from "../process-registry.mjs";
import { RUNTIME_SNAPSHOT_FILENAME, writeRuntimeSnapshotFile } from "../runtime-snapshot.mjs";
import { createControlMailbox } from "../supervisor-control.mjs";
import { createBridgeStageEmitter } from "./bridge-stage.mjs";
import { createControlHandlers } from "./control-handlers.mjs";
import { createCrashGuard } from "./crash-guard.mjs";
import { buildShutdownPlan, createHandoffExitStarter, runShutdown } from "./handoff.mjs";
import { createLocalProxyController } from "./proxy-controller.mjs";
import { createNetworkWatcher } from "./network-watch.mjs";
import { createTickProxyHealth, probeProxyHealth } from "./proxy-health.mjs";
import { reconcileTunnels } from "./reconcile.mjs";
import { createSnapshotWriter } from "./snapshot-writer.mjs";
import { createTunnelController } from "./tunnel-controller.mjs";
import { createTunnelLedgerWriter, TUNNEL_LEDGER_ALIVE_MS } from "./tunnel-ledger.mjs";

export function createSupervisorState() {
  return {
    stopping: false,
    // 活跃服务器（只决定"看哪台"）；日志与阶段快照据此打 channelId。
    currentServerId: null,
    // 热更新交接退出进行中：此后 SIGTERM 不再走 shutdown（那会杀掉要留给下一任的子进程）。
    handoffExiting: false,
    // 主循环当前这一拍（交接退出要等它收尾）与首拍完成时间（快照发布，monitor 据此确认
    // 新 supervisor 已完成接管）。
    currentTick: null,
    firstTickCompletedAt: null,
    // 本地代理只有一个，端口在首拍钉死；之后所有 -R 都指向它（见 runTick），
    // 信箱 proxy-handoff 也按它校验与执行。
    effectiveProxyPort: null,
  };
}

// 生产实例的全部依赖在这里装配（spawn/registry/log/文件落盘均为真实实现）。
// io：createRuntimeIo 的落盘簿记；loadConfig / getAutoRepair：createConfigLoader 的两个出口。
// 末尾一组带默认值的依赖只供测试替换，默认值即生产实现。
export function createSupervisorService({
  rootDir,
  runtimeDir,
  instanceId,
  // 本机识别码（owner-id.mjs）：隧道会话标记与残留会话回收用；为空则隧道保持 -N。
  tunnelOwnerId = null,
  // 本机机器名（sanitizeMachineLabel 之后）：同账号多台 Mac 接力时互相显示「由谁承载」。
  machineLabel = "Mac",
  startedAt,
  build,
  componentHash,
  checkIntervalMs = 5000,
  registry,
  io,
  log = () => {},
  loadConfig,
  getAutoRepair = () => null,
  state = createSupervisorState(),
  selfPid = process.pid,
  createLocalProxyControllerImpl = createLocalProxyController,
  createTunnelControllerImpl = createTunnelController,
  createControlMailboxImpl = createControlMailbox,
  probeProxyHealthImpl = probeProxyHealth,
  writeSnapshotFile = writeRuntimeSnapshotFile,
  flushLogs = flushAllLoggers,
  waitForPidExitImpl = waitForPidExit,
  killProcess = (pid, signal) => process.kill(pid, signal),
  exit = (code) => process.exit(code),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  networkWatcher = createNetworkWatcher(),
  ledger = runtimeDir ? createTunnelLedgerWriter({ runtimeDir }) : { append: () => Promise.resolve(), flush: () => Promise.resolve() },
  now = Date.now,
} = {}) {
  // 断线账本（tunnel-ledger.ndjson）：会话 up/down 同时写一行 supervisor 日志，便于对照排查。
  function recordSessionEvent(event) {
    ledger.append(event);
    if (event.type === "up") {
      const down = event.downMs != null ? `after ${Math.round(event.downMs / 1000)}s down, ${event.attempts} attempt(s)` : "initial";
      log(`tunnel session up: ${event.host} (${event.via}, ${down})`, { event: "tunnel-session-up", serverId: event.serverId, downMs: event.downMs, attempts: event.attempts });
    } else if (event.type === "down") {
      log(`tunnel session down: ${event.host} after ${Math.round(event.uptimeMs / 1000)}s (${event.cause}${event.planned ? ", planned" : ""}${event.networkChange ? ", network changed" : ""})`, {
        level: event.planned ? "info" : "warn",
        event: "tunnel-session-down",
        serverId: event.serverId,
        cause: event.cause,
        uptimeMs: event.uptimeMs,
        planned: event.planned,
      });
    }
  }
  let lastLedgerAliveAt = 0;
  const emitBridgeStage = createBridgeStageEmitter({ log, getChannelServerId: () => state.currentServerId });

  async function checkProxyHealth(port) {
    const result = await probeProxyHealthImpl(port);
    emitBridgeStage({ stage: "local-proxy", ok: result.ok, durationMs: result.durationMs, checkDelta: 1 });
    return result;
  }

  // 每拍一次代理探活，代理控制器与各隧道共享（见 createTickProxyHealth）。
  const tickProxyHealth = createTickProxyHealth({ check: checkProxyHealth, maxAgeMs: checkIntervalMs });
  // 每拍一轮批量校验全部隧道的注册表记录（见 createVerifyPrefetcher）。
  const tunnelVerifier = createVerifyPrefetcher(registry, { maxAgeMs: checkIntervalMs });

  const localProxyController = createLocalProxyControllerImpl({
    log,
    removeRuntimeRecord: io.removeRuntimeRecord,
    recordRuntimeProcess: io.recordRuntimeProcess,
    rootDir,
    emitStage: (partial) => emitBridgeStage({ stage: "local-proxy", ...partial }),
    // 接管来的代理（上一任 supervisor 留下的）判不健康时：先按注册表确认进程是否还在，
    // 卡死才按注册表（命令行复核）停掉，再起新的。
    verifyAdopted: () => registry.verifyProcess("local-proxy"),
    stopAdoptedProxy: () => registry.stopProcess("local-proxy", { forceAfterMs: 2000 }),
  });

  // 每台服务器一条常驻隧道：Map<serverId, { config, controller }>。
  // 活跃服务器只决定"看哪台"，切换不再停任何隧道（旧实现会放掉 myserver 的 7891，
  // 集群上 reclaude/codex 立刻断网——这是本轮要修的唯一真实断网缺陷）。
  const controllers = new Map();

  // 所有隧道共用一个限频器：key 已按 serverId 分桶，共用只是为了让"最近自动动作"
  // 有单一真相源（未来要往控制台透出时不用把 N 个 snapshot 拼起来）。
  const orphanRateLimiter = createRateLimiter();

  function createTunnelControllerFor(serverId) {
    return createTunnelControllerImpl({
      runtimeDir,
      registry: tunnelVerifier.registry,
      name: tunnelRecordName(serverId),
      log,
      removeRuntimeRecord: io.removeRuntimeRecord,
      recordRuntimeProcess: io.recordRuntimeProcess,
      isLocalProxyHealthy: (config) => tickProxyHealth.isHealthy(config.localPort),
      rootDir,
      emitStage: (partial) => emitBridgeStage({ stage: "ssh-tunnel", serverId, ...partial }),
      getAutoRepair,
      rateLimiter: orphanRateLimiter,
      tunnelOwnerId,
      machineLabel,
      onSessionEvent: recordSessionEvent,
    });
  }

  const crashGuard = createCrashGuard({
    // 交接退出途中出了意外异常也不能杀子进程：它们已经托付给下一任 supervisor。
    getChildren: () => (state.handoffExiting ? [] : buildShutdownPlan(localProxyController, controllers).children),
    log,
  });

  const startHandoffExit = createHandoffExitStarter({
    state,
    controllers,
    registry,
    // 信箱在本函数之后才建好；这里是调用时才解引用的闭包。
    waitForMailboxIdle: () => controlMailbox.whenIdle(),
    removeRuntimeRecord: io.removeRuntimeRecord,
    log,
    flushLogs,
    exit,
    selfPid,
  });

  const controlMailbox = createControlMailboxImpl({
    runtimeDir,
    instanceId,
    log,
    stopping: () => state.stopping,
    handlers: createControlHandlers({
      state,
      controllers,
      proxyController: localProxyController,
      instanceId,
      startHandoffExit,
      probe: probeProxyHealthImpl,
      proxyRelease: {
        requestRelease: io.requestProxyRelease,
        clearRelease: io.clearProxyRelease,
        recordDraining: io.recordDrainingProxy,
        clearDraining: io.clearDrainingProxy,
      },
      selfPid,
    }),
  });

  const writeSnapshot = createSnapshotWriter({
    snapshotPath: path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME),
    state,
    controllers,
    proxyController: localProxyController,
    instanceId,
    pid: selfPid,
    startedAt,
    build,
    componentHash,
    log,
    writeSnapshotFile,
    machine: { label: machineLabel, ownerId: tunnelOwnerId },
  });

  // 主循环私有的节拍记账（不属于共享状态）。
  let proxyPortDriftLogged = false;
  let proxyPortConflictLogged = false;

  // 核心循环的一拍。任何异常只记日志；finally 里结束 currentTick（交接退出在等它）。
  async function runTick() {
    let finishTick = () => {};
    state.currentTick = new Promise((resolve) => {
      finishTick = resolve;
    });
    try {
      const config = await loadConfig();

      // 控制面和共享代理不能监听同一个本地端口。配置热载时也要先收敛掉
      // 已有隧道，避免继续把集群流量送进错误的本地服务；配置修好后下一拍再恢复。
      // activeServer.localPort is a view/configuration value after the first
      // tick; all tunnels may still be pinned to a different, safe runtime
      // port. Only enforce the conflict before a runtime port is established,
      // or when the pinned runtime port itself is the conflicting value.
      const proxyPortConflict = config.proxyPortConflict
        && (state.effectiveProxyPort == null || state.effectiveProxyPort === config.proxyPort);
      if (proxyPortConflict) {
        if (!proxyPortConflictLogged) {
          proxyPortConflictLogged = true;
          log(`local proxy port ${config.proxyPort} conflicts with the monitor HTTP port; all tunnels are paused`, {
            level: "error",
            event: "proxy-control-port-conflict",
            nextAction: `修改服务器 localPort（不能使用 ${config.proxyPort}），保存后会自动恢复隧道`,
          });
        }
        state.effectiveProxyPort = null;
        await reconcileTunnels({
          controllers,
          targets: [],
          createController: createTunnelControllerFor,
          stopping: () => state.stopping,
          log,
          onRemoved: (serverId) => io.removeRuntimeRecord(tunnelRecordName(serverId)),
        });
        await localProxyController.stopCurrent().catch(() => {});
        await writeSnapshot({ config, tunnels: [] });
        controlMailbox.poll().catch((err) => {
          log(`control mailbox poll failed: ${err.message}`, { level: "warn", event: "control-mailbox-error" });
        });
        return;
      }
      proxyPortConflictLogged = false;

      // 本地代理只有一个，端口在首拍钉死。用户之后切到 localPort 不同的服务器时本期
      // 不重启代理（重启会让所有隧道的落点在几秒内消失）——只提示一次"沿用旧端口"，
      // 并让全部 -R 继续指向这个仍在监听的端口。
      if (state.effectiveProxyPort == null) {
        state.effectiveProxyPort = config.proxyPort;
      } else if (config.proxyPort !== state.effectiveProxyPort && !proxyPortDriftLogged) {
        proxyPortDriftLogged = true;
        log(`active server localPort is now ${config.proxyPort}; 代理端口沿用 ${state.effectiveProxyPort}（本期不重启本地代理，所有隧道继续指向它）`, {
          level: "warn",
          event: "proxy-port-pinned",
          nextAction: "如需真正切换代理端口，停止再启动通道",
        });
      }

      // 活跃服务器变化只是"看哪台"变了：不停隧道、不重置退避、不动本地代理。
      if (state.currentServerId && state.currentServerId !== config.activeServerId) {
        log(`active server changed from ${state.currentServerId} to ${config.activeServerId}; all tunnels stay up (view only)`, {
          event: "active-server-switch",
        });
      }
      state.currentServerId = config.activeServerId;

      // 所有 -R 统一指向同一个本地代理端口。
      const tunnels = config.tunnels.map((target) => (
        target.localPort === state.effectiveProxyPort ? target : { ...target, localPort: state.effectiveProxyPort }
      ));

      // T01 运行快照：记录实际共享代理端口与每台服务器的真实 -R 目标（含首拍钉死
      // 的 effectiveProxyPort）。快照失败不影响隧道保活。
      await writeSnapshot({ config, tunnels });

      tickProxyHealth.beginTick();
      await localProxyController.ensure({ ...config, localPort: state.effectiveProxyPort }, {
        checkHealth: tickProxyHealth.checkHealth,
        stopping: () => state.stopping,
      });

      // 本机地址变了（换网 / 换校园网账号 / 休眠唤醒）：各隧道立即复核，连接绑在已消失地址上的
      // 当场重建，不等 ServerAlive 超时，也不等异己占用的 5 分钟长退避。
      const networkChange = state.stopping ? null : networkWatcher.check();
      if (networkChange) {
        log(`network addresses changed (removed: ${networkChange.removed.join(", ") || "-"}; added: ${networkChange.added.join(", ") || "-"}); rechecking tunnels now`, {
          event: "network-changed",
          removed: networkChange.removed,
          added: networkChange.added,
        });
        for (const { controller } of controllers.values()) {
          await controller.handleNetworkChange(networkChange).catch((err) => {
            log(`tunnel network recheck failed: ${err.message}`, { level: "warn", event: "network-changed" });
          });
        }
      }

      // 一轮查询预取全部隧道记录的校验结果，各 controller 的首个 verifyProcess 直接消费。
      // 预取失败只意味着回落逐条实时校验，绝不影响保活。
      await Promise.resolve().then(() => tunnelVerifier.prefetch(tunnels.map((target) => tunnelRecordName(target.id)))).catch(() => {});

      await reconcileTunnels({
        controllers,
        targets: tunnels,
        createController: createTunnelControllerFor,
        stopping: () => state.stopping,
        log,
        onRemoved: (serverId) => io.removeRuntimeRecord(tunnelRecordName(serverId)),
      });

      // 账本存活心跳：读侧据相邻记录的间隔判断 supervisor 是否一直在看（停机 / 睡眠不计入可用率）。
      const tickAt = now();
      if (!state.stopping && tickAt - lastLedgerAliveAt >= TUNNEL_LEDGER_ALIVE_MS) {
        lastLedgerAliveAt = tickAt;
        ledger.append({ type: "alive", at: tickAt });
      }

      // 首拍收尾：代理与全部隧道已按注册表接管/收敛完毕。立即补写一次快照，monitor 的
      // 热更新流程据 firstTickCompletedAt 确认"新 supervisor 已完成接管"。
      if (state.firstTickCompletedAt == null && !state.stopping) {
        state.firstTickCompletedAt = Date.now();
        await writeSnapshot({ config, tunnels });
      }

      // T04b：控制信箱轮询（挂循环边界，内部互斥、主循环不等待——处理期间隧道
      // 保活照常进行）。
      controlMailbox.poll().catch((err) => {
        log(`control mailbox poll failed: ${err.message}`, { level: "warn", event: "control-mailbox-error" });
      });
    } catch (error) {
      log(`supervisor loop error: ${error.message}`, { level: "error" });
    } finally {
      finishTick();
    }
  }

  async function run() {
    lastLedgerAliveAt = now();
    ledger.append({ type: "start", at: lastLedgerAliveAt });
    // 信箱快速轮询：交接退出 / 代理交接不该等满一个 5s 节拍（poll 内部互斥，主循环
    // 那一次调用与这里互不重入）。unref：它不是进程存活的理由。
    setInterval(() => {
      if (state.stopping) return;
      controlMailbox.poll().catch(() => {});
    }, 1000).unref();

    while (!state.stopping) {
      await runTick();
      if (state.stopping) break;
      await sleep(checkIntervalMs);
    }
  }

  // SIGINT / SIGTERM 的处理器：忽略信号名参数。
  function shutdown() {
    return runShutdown({
      state,
      proxyController: localProxyController,
      controllers,
      registry,
      removeRuntimeRecord: io.removeRuntimeRecord,
      log,
      waitForPidExitImpl,
      killProcess,
      flushLogs,
      exit,
    });
  }

  return {
    state,
    controllers,
    localProxyController,
    controlMailbox,
    crashGuard,
    startHandoffExit,
    shutdown,
    runTick,
    run,
  };
}
