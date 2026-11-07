// L2 自动修复装配（设计 §6.7）：策略实例 + 策略视图 + 评估时机。
// 策略只产出意图（lib/auto-repair-policy.mjs）；执行、记账与状态字段在 auto-repair-runner.mjs。

import { createAutoRepairPolicy, normalizeAutoRepairConfig } from "../lib/auto-repair-policy.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { LOG_SIGNALS_PROBE_ID, PROCESSES_PROBE_ID } from "../lib/probe-ids.mjs";
import { isChannelSetupPending } from "../lib/state/channel-layer.mjs";
import { CONTROL_ACTION_RESTART_TUNNEL } from "../lib/supervisor-control.mjs";
import { createAutoRepairRunner, freshenChannelTriage, pickTriageSignal } from "./auto-repair-runner.mjs";

const WAKE_TICK_MS = 5000; // 挂钟跳变探测节拍
const WAKE_GAP_THRESHOLD_MS = 90000; // 两拍间隔超过它即判为休眠唤醒（与 supervisor / 策略同阈值）
// 执行前复核刷新本机进程探针的等待上限：ps 通常几百毫秒；等不到就用手上最新的结果复核。
const PRE_EXECUTE_REFRESH_BUDGET_MS = 3000;

// 策略自己的 log 回调直接落 ops 日志：event/trigger 固定，规则携带的字段透传，
// 前端时间线据 trigger === "auto" 打"自动"徽标。
export function createWiredAutoRepairPolicy({ autoRepairConfig, appendLog }) {
  return createAutoRepairPolicy({
    config: normalizeAutoRepairConfig(autoRepairConfig),
    log: (fields) => {
      const f = fields || {};
      appendLog(
        `auto-repair: ${f.ruleId || "?"} ${f.kind || "?"}（${f.mode || "execute"}）${f.reason ? ` —— ${f.reason}` : ""}`,
        { ...f, event: "auto-repair", trigger: "auto" },
      );
    },
  });
}

// 各条隧道此刻的级别（策略据此决定只重启哪一条）：仅监控 / 没领端口 / 已停止的不算隧道。
export function tunnelLevelsOf(tunnelsLayer) {
  const out = [];
  for (const [serverId, entry] of Object.entries(tunnelsLayer || {})) {
    if (!entry || entry.tunnel === false || entry.setupPending === true || entry.level === "skipped") continue;
    out.push({ serverId, level: entry.level });
  }
  return out;
}

// 策略视图：每个字段都从既有的单一事实来源取，不新建平行状态。
// isTunnelOperationInFlight：单隧道操作（手动或自动）在飞也算修复进行中。
export function createAutoRepairViewBuilder({ store, channel, getMergedConfig, isTunnelOperationInFlight = () => false }) {
  return function buildAutoRepairView() {
    const layers = store.getLayers();
    const detail = layers.channel.detail || {};
    const cfg = getMergedConfig();
    let tunnelOperationInFlight = false;
    try {
      tunnelOperationInFlight = isTunnelOperationInFlight() === true;
    } catch {}
    return {
      now: Date.now(),
      // 运行意图以 lifecycle 为准（store 里的那份是它同步过去的镜像）。
      shouldBeRunning: channel.getShouldBeRunning(),
      // 守护巡检自愈 / 一键重启 / 单隧道操作任一在跑都算修复进行中，此时策略静默
      // （设计 §6.7 互斥）。策略层已在 view.repairInFlight 为真时于消耗任何限频预算之前
      // 直接返回空动作，因此这里 OR 一下即可。
      repairInFlight: channel.getRepairInFlight() || tunnelOperationInFlight,
      activeServerId: typeof cfg.activeServerId === "string" ? cfg.activeServerId : "",
      // 没领反向端口：通道层的结构化标记（lib/state/channel-layer.mjs），策略据此不重启通道。
      setupPending: isChannelSetupPending(layers.channel),
      // 根因来自 v2.17 的信号分诊（layers.signals.active 的条目已被 attachTriage 写上 rootCause）；
      // 通道断开这一根因再按通道层此刻是否仍在 error、从何时起持续 error 校正（v2.64，见 freshenChannelTriage）。
      triage: freshenChannelTriage(pickTriageSignal(layers.signals?.active), layers.channel),
      processes: { supervisorUp: detail.supervisorUp === true, localProxyUp: detail.localProxyUp === true },
      tunnels: tunnelLevelsOf(layers.tunnels),
      wakeGapMs: 0,
    };
  };
}

// 自动修复的单隧道重启：与界面「重启这条隧道」同一条通路（operations-runner 的 preview → run，
// 经 supervisor 控制信箱），不新造协议。已受理即返回；被拒时抛 ControlProtocolError（带 status）。
export function createScopedTunnelRestarter(operationsRunner) {
  return async function restartTunnel({ serverId, operationId, ruleId }) {
    const preview = await operationsRunner.preview({ action: CONTROL_ACTION_RESTART_TUNNEL, target: { serverId } });
    return operationsRunner.run({ previewId: preview.previewId, operationId, trigger: "auto", ruleId });
  };
}

// 执行前复核的刷新：强制跑一次本机进程探针（ps，不发 SSH），有界等待。结果经 PROBE_UPDATED
// 进状态仓后再组视图；远端端口结论沿用 fast 采集的最近一次（10 秒一轮）。
export function createPreExecuteRefresher({ scheduler, budgetMs = PRE_EXECUTE_REFRESH_BUDGET_MS, setTimer = setTimeout }) {
  return function refreshBeforeExecute() {
    let timer = null;
    const budget = new Promise((resolve) => {
      timer = setTimer(resolve, budgetMs);
      timer?.unref?.();
    });
    const run = Promise.resolve()
      .then(() => scheduler.forceRun(PROCESSES_PROBE_ID))
      .catch(() => {});
    return Promise.race([run, budget]).finally(() => clearTimeout(timer));
  };
}

// 界面用名（时间线文案「自动修复：重启 阿里云 隧道」）：配置里的 name，没有就用 id。
export function createServerLabeler(getMergedConfig) {
  return function describeServer(serverId) {
    const servers = getMergedConfig()?.servers;
    const server = (Array.isArray(servers) ? servers : []).find((entry) => entry && entry.id === serverId);
    return typeof server?.name === "string" && server.name.trim() ? server.name.trim() : serverId;
  };
}

// 挂钟跳变检测：合盖/休眠期间定时器不走，醒来后这一拍的间隔会远大于节拍。
// tick() 返回超过阈值的间隔（毫秒），否则 0。
export function createWakeGapDetector({ thresholdMs = WAKE_GAP_THRESHOLD_MS, now = Date.now } = {}) {
  let lastTickAt = now();
  return function tick() {
    const nowMs = now();
    const gap = nowMs - lastTickAt;
    lastTickAt = nowMs;
    return gap > thresholdMs ? gap : 0;
  };
}

// 创建执行器并挂上评估时机（三处，都是"结论可能变了"的时刻，不做独立轮询）：
//  1) STATUS_CHANGED——层级变迁后（通道刚判红/刚恢复）；
//  2) log-signals 的 PROBE_UPDATED——分诊结论的唯一来源刷新后（level 不变时不发
//     STATUS_CHANGED，只靠 1) 会漏掉"红了很久、刚满 30s"这一拍）；
//  3) 唤醒拍（挂钟跳变）。
export function startAutoRepair({
  policy,
  scheduler,
  channel,
  buildView,
  appendLog,
  timeline,
  operationStorage,
  restartTunnel = null,
  describeServer,
  noteChannelStop,
}) {
  const autoRepair = createAutoRepairRunner({
    policy,
    scheduler,
    channel,
    restartTunnel,
    refreshBeforeExecute: createPreExecuteRefresher({ scheduler }),
    describeServer,
    noteChannelStop,
    buildView,
    appendLog,
    timeline,
    operationStorage,
  });

  bus.on(EVENTS.STATUS_CHANGED, ({ transitions }) => {
    // 通道回到 ok 即认为"不需要人工了"，清掉注意力队列的置顶条目（必须先于本拍评估）。
    if ((transitions || []).some((t) => t.key === "channel" && t.to === "ok")) autoRepair.clearExhausted();
    autoRepair.evaluate().catch(() => {});
  });
  bus.on(EVENTS.PROBE_UPDATED, ({ id }) => {
    if (id === LOG_SIGNALS_PROBE_ID) autoRepair.evaluate().catch(() => {});
  });

  // 不依赖 Electron powerMonitor——网页模式与 Windows 同事都没有它，阈值与
  // supervisor 侧保持同一个 90s。unref：它不该成为进程存活的理由。
  const wakeGap = createWakeGapDetector();
  const wakeTickTimer = setInterval(() => {
    const gap = wakeGap();
    if (gap > 0) autoRepair.evaluate({ wakeGapMs: gap }).catch(() => {});
  }, WAKE_TICK_MS);
  wakeTickTimer.unref();

  return autoRepair;
}
