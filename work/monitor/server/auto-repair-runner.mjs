// ---- v2.18 L2 自动修复执行器（纯函数/纯工厂，无定时器、无 IO，测试可直接驱动）----
// 策略表在 lib/auto-repair-policy.mjs（不含任何 IO），这里只负责三件事：
// 组视图 → 把 Action 映射到既有的封闭 API → 记账与状态字段。
// 动作集合封闭（设计 §8）：只有 scheduler.forceRun、channel.restartChannel、单隧道受控重启
// （与界面「重启这条隧道」同一条 preview → run 通路）与两个状态字段，没有"执行任意命令"的通路。
// 装配（策略实例 / 视图 / 触发时机）见 auto-repair.mjs。

import { randomUUID as nodeRandomUUID } from "node:crypto";

// 分诊输入的挑选：活跃信号里 severity 最高、非 info、且已带 rootCause 的那一条。
// info 是采样取证（不分诊，也没有 rootCause），拿它当根因会让策略对着一条
// "抖动取证样本"去重启通道。同级并列时保留先遇到的那条——getActiveSignals 已按
// severity 排序，先遇到的即最靠前的一条。
const SIGNAL_SEVERITY_RANK = { error: 3, warn: 2, info: 1 };
export function pickTriageSignal(activeSignals) {
  let best = null;
  let bestRank = 0;
  for (const sig of activeSignals || []) {
    if (!sig || sig.severity === "info" || !sig.rootCause) continue;
    const rank = SIGNAL_SEVERITY_RANK[sig.severity] ?? 0;
    if (rank <= bestRank) continue;
    best = sig;
    bestRank = rank;
  }
  if (!best) return null;
  // since 用 firstSeenAt（"该故障最早何时被看见"，跨源归并后仍是最早值）——
  // 用 lastSeenAt 会让计时每轮清零、channel-down-restart 的 30s 门槛永远迈不过去。
  // 但 firstSeenAt 只是"这类日志行最早何时出现"，不是"通道从何时断开"：通道断开的
  // 起点还要经 freshenChannelTriage 用通道层自己的持续断开起点校正。
  return {
    rootCause: best.rootCause,
    since: Number.isFinite(best.firstSeenAt) ? best.firstSeenAt : Number.NaN,
  };
}

// 通道断开的分诊要按通道层"此刻"的事实校正（v2.64）。
// 根因：信号的 rootCause 是它第一次被看见那一刻分诊定下的（signal-sink.attachTriage），之后不再
// 重算；信号在最后一次命中后还要活 10 分钟（log-signals ACTIVE_TTL_MS）；firstSeenAt 也只是日志行
// 第一次出现的时刻。只拿它算"通道断开已持续多久"，通道恢复后规则仍会在这 10 分钟里一再触发——
// 2026-10-14 15:47:37 与 15:48:41 两次重启整个通道，都发生在通道已经恢复（15:47:16 / 15:47:47）之后，
// 日志里的「已持续 32s / 97s」其实是那条日志信号的年龄。
// 规则：channel 根因只在通道层当前为 error 时成立；断开起点取信号首见与通道层持续断开起点
// （detail.downSinceMs，离开 error 即清空，哪怕只恢复了一拍）两者中较晚的那个。其它根因原样返回。
export function freshenChannelTriage(triage, channelLayer) {
  if (triage?.rootCause !== "channel") return triage;
  const downSince = channelLayer?.level === "error" ? channelLayer?.detail?.downSinceMs : null;
  if (!Number.isFinite(downSince)) return null;
  // Math.max 遇 NaN 得 NaN：信号缺 firstSeenAt 时仍按"证据不足"处理，不因校正而放宽。
  return { rootCause: triage.rootCause, since: Math.max(triage.since, downSince) };
}

// 自动修复重启整个通道期间，通道层 / 隧道层"已停止"那一拍的原因文案（不再写成「通道已手动停止」）。
export const AUTO_CHANNEL_RESTART_NOTE = "自动修复：重启整个通道";

// 执行前复核 / 执行器忙而放弃时的 ops 说明。
const SKIP_DETAILS = {
  recovered: "执行前复核：通道已恢复，放弃本次重启",
  busy: "执行前复核：已有别的修复在进行，放弃本次重启",
  stopped: "执行前复核：通道已被停止，放弃本次重启",
  disabled: "执行前复核：规则已关闭，放弃本次重启",
  "precondition-changed": "执行前复核：前提已变化（本机进程不全等），放弃本次重启",
  "recheck-failed": "执行前复核没能完成，宁可不动",
};

// 自动修复执行器。依赖全部注入：
//   buildView()  → 组一份策略视图（activeSignals/进程/意图位都在装配层）
//   scheduler    → forceRun(id, { overrideBreaker })
//   channel      → restartChannel({ trigger, ruleId, context })
//   restartTunnel({ serverId, operationId, ruleId }) → 单隧道受控重启（已受理即返回；被拒时抛带
//                  status 的错误：409 忙 → 放弃，503 单隧道操作不可用 → 改为重启整个通道）
//   refreshBeforeExecute() → 执行前刷新本机进程事实（有界；装配层 forceRun processes 探针）
//   describeServer(serverId) → 界面用名（时间线文案）
//   noteChannelStop(text|null) → 重启整个通道期间"已停止"的原因文案（状态仓）
//   appendLog    → ops 日志（策略自己的 log 回调也走它）
//   timeline     → (level, message, fields) 写状态时间线
//   operationStorage → 与 HTTP 层同一个操作上下文（kernel.operationStorage）
export function createAutoRepairRunner({
  policy,
  scheduler,
  channel,
  restartTunnel = null,
  refreshBeforeExecute = async () => {},
  describeServer = (serverId) => serverId,
  noteChannelStop = () => {},
  buildView = () => ({}),
  appendLog = () => {},
  timeline = () => {},
  operationStorage = null,
  randomUUID = nodeRandomUUID,
} = {}) {
  // "自动修复已达上限，需人工"：注意力队列置顶用（render/attention.js 严格判 === true）。
  // 只由 escalate 置位，由通道恢复 ok 清零（见 auto-repair.mjs 的 STATUS_CHANGED 监听）。
  let exhausted = false;
  // 正在派发动作（含执行前复核那几百毫秒）：期间别的评估（复核时刷新探针引起的 STATUS_CHANGED、
  // 重启引起的层级变迁）一律静默，不消耗预算——与策略层 repairInFlight 护栏同一语义。
  let dispatching = false;
  // 派发期间被静默掉的唤醒拍（只记最近一次的挂钟跳变）：唤醒拍只有那一次，丢了就不会再来，
  // 所以派发结束后补跑一次；补跑照常走策略的冷却与窗口上限。
  let deferredWakeGapMs = 0;

  const inContext = (context, fn) => (operationStorage ? operationStorage.run(context, fn) : fn());
  const serverLabel = (serverId) => {
    try {
      return describeServer(serverId) || serverId;
    } catch {
      return serverId;
    }
  };

  // 执行前（停任何进程之前）用最新状态再看一眼：先刷新本机进程事实，再拿新视图把规则判据跑一遍。
  // 策略不支持复核（测试里的假策略）时放行；复核本身出错则宁可不动。
  async function recheckBeforeExecute(action) {
    if (typeof policy.recheck !== "function") return { ok: true };
    try {
      await refreshBeforeExecute();
    } catch {}
    try {
      return policy.recheck(action, buildView()) || { ok: true };
    } catch {
      return { ok: false, reason: "recheck-failed" };
    }
  }

  // 放弃本次动作：退回限频记账（不计入窗口上限），落一条 ops。不进状态时间线——什么都没发生。
  function skip(action, reason, detail) {
    try {
      policy.refund?.(action, reason);
    } catch {}
    const serverId = action.payload?.serverId;
    appendLog(`auto-repair: ${action.ruleId} skipped: ${reason} —— ${detail || SKIP_DETAILS[reason] || "放弃本次执行"}（不计入窗口上限）`, {
      level: "info",
      event: "auto-repair",
      trigger: "auto",
      ruleId: action.ruleId,
      kind: action.kind,
      skipped: reason,
      ...(typeof serverId === "string" ? { serverId } : {}),
    });
  }

  // 重启整个通道（与 /api/restart 同一条 stop + start 序列）。期间"已停止"那一拍的原因写成自动修复。
  async function runChannelRestart(action, operationId) {
    const context = { operationId };
    const restart = async () => channel.restartChannel({ trigger: "auto", ruleId: action.ruleId, context });
    try {
      noteChannelStop(AUTO_CHANNEL_RESTART_NOTE);
    } catch {}
    try {
      const result = await inContext(context, restart)
        .catch((error) => ({ ok: false, reason: error?.message || String(error) }));
      return { ok: result?.ok !== false, reason: result?.reason || "" };
    } finally {
      try {
        noteChannelStop(null);
      } catch {}
    }
  }

  // 只重启一条隧道：界面「重启这条隧道」同一条通路（preview → run → supervisor 控制信箱）。
  // 受控重启由 supervisor 停旧 ssh 时打 stopReason "restart"，断线账本记计划内，与手动单条重启同一口径。
  async function runTunnelRestart(action, operationId) {
    if (typeof restartTunnel !== "function") return { fallback: "单隧道重启未接线" };
    const context = { operationId };
    const serverId = action.payload?.serverId;
    try {
      await inContext(context, async () => restartTunnel({ serverId, operationId, ruleId: action.ruleId }));
      return { ok: true, reason: "" };
    } catch (error) {
      const reason = error?.message || String(error);
      if (error?.status === 409) return { busy: reason };
      if (error?.status === 503) return { fallback: reason };
      return { ok: false, reason };
    }
  }

  function executedMessage(kind, serverId, ok, fallbackFrom) {
    const head = kind === "restart-tunnel"
      ? `自动修复：重启 ${serverLabel(serverId)} 隧道`
      : `${AUTO_CHANNEL_RESTART_NOTE}${fallbackFrom ? "（单隧道重启暂不可用）" : ""}`;
    return ok ? head : `${head}（失败）`;
  }

  async function dispatchRestart(action) {
    const check = await recheckBeforeExecute(action);
    if (!check.ok) {
      skip(action, check.reason || "recovered");
      return;
    }
    // 每次自动重启一个新 operationId，在与 HTTP 请求同一套操作上下文里执行：没显式带
    // fields 的 ops 日志也继承它；受理时据它关联事件（「查看处置日志」）。
    const operationId = randomUUID();
    const serverId = action.payload?.serverId;
    let executedKind = action.kind;
    let fallbackFrom = null;
    let outcome;
    if (action.kind === "restart-tunnel") {
      outcome = await runTunnelRestart(action, operationId);
      if (outcome.busy) {
        skip(action, "busy", `单隧道操作被拒（${outcome.busy}），放弃本次重启`);
        return;
      }
      if (outcome.fallback) {
        // 单隧道操作整体不可用（supervisor 运行快照不可用 / 不支持）多半是 supervisor 本身出了状况，
        // 这正是重启整个通道能修的。
        appendLog(`auto-repair: ${action.ruleId} 单隧道重启不可用（${outcome.fallback}），改为重启整个通道`, {
          level: "warn",
          event: "auto-repair",
          trigger: "auto",
          ruleId: action.ruleId,
          kind: "restart-channel",
          operationId,
        });
        fallbackFrom = action.kind;
        executedKind = "restart-channel";
        outcome = await runChannelRestart(action, operationId);
      }
    } else {
      outcome = await runChannelRestart(action, operationId);
    }
    const ok = outcome.ok !== false;
    if (!ok) {
      appendLog(`auto-repair: ${action.ruleId} restart failed: ${outcome.reason || "unknown"}`, {
        level: "warn",
        event: "auto-repair",
        trigger: "auto",
        ruleId: action.ruleId,
        kind: executedKind,
        operationId,
      });
    }
    policy.markExecuted(action, ok);
    timeline(ok ? "info" : "warn", executedMessage(executedKind, serverId, ok, fallbackFrom), {
      trigger: "auto",
      event: "auto-repair",
      ruleId: action.ruleId,
      kind: executedKind,
      ok,
      reason: action.reason,
      operationId,
      ...(executedKind === "restart-tunnel" && typeof serverId === "string" ? { serverId } : {}),
      ...(fallbackFrom ? { fallbackFrom } : {}),
    });
  }

  async function dispatch(action) {
    if (action.kind === "escalate") {
      // escalate 不是"修复动作"，是策略在说"我帮不上忙了"。observeOnly 也照常置位与
      // 落时间线：观察模式的全部意义就是看策略的结论，把最重要的那条结论藏起来
      // 才是真的误导（此时确实需要人工，因为观察模式下根本没人在修）。
      exhausted = true;
      timeline("warn", `auto-repair: ${action.ruleId} escalate`, {
        trigger: "auto",
        event: "auto-repair",
        ruleId: action.ruleId,
        kind: "escalate",
        reason: action.reason,
      });
      return;
    }
    // observeOnly：只留策略自己那条 mode:"observe" 日志，不碰进程、不刷探针。
    if (action.observeOnly) return;

    if (action.kind === "restart-channel" || action.kind === "restart-tunnel") {
      await dispatchRestart(action);
      return;
    }
    if (action.kind === "force-probes") {
      const probeIds = Array.isArray(action.payload?.probeIds) ? action.payload.probeIds : [];
      for (const probeId of probeIds) {
        // 唤醒复核必须覆盖熔断：休眠期间探针大概率已连续失败被熔断，不覆盖就复核不到。
        scheduler.forceRun(probeId, { overrideBreaker: action.payload?.overrideBreaker === true })
          .catch(() => {});
      }
    }
    policy.markExecuted(action, true);
    timeline("info", `auto-repair: ${action.ruleId} ${action.kind}`, {
      trigger: "auto",
      event: "auto-repair",
      ruleId: action.ruleId,
      kind: action.kind,
      ok: true,
      reason: action.reason,
    });
  }

  // extra 覆盖在 buildView() 之上（唤醒拍只额外带 wakeGapMs）。
  // 整体 try/catch：evaluate 挂在事件总线上，抛一次就可能拖垮事件分发。
  async function evaluate(extra) {
    if (dispatching) {
      const gap = extra?.wakeGapMs;
      if (Number.isFinite(gap) && gap > 0) deferredWakeGapMs = gap;
      return [];
    }
    let actions = [];
    dispatching = true;
    try {
      const view = { ...buildView(), ...(extra || {}) };
      actions = policy.evaluate(view) || [];
      for (const action of actions) await dispatch(action);
    } catch (error) {
      appendLog(`auto-repair evaluate failed: ${error?.message || String(error)}`, {
        level: "error",
        event: "auto-repair",
        trigger: "auto",
      });
    } finally {
      dispatching = false;
    }
    if (deferredWakeGapMs > 0) {
      const wakeGapMs = deferredWakeGapMs;
      deferredWakeGapMs = 0;
      await evaluate({ wakeGapMs });
    }
    return actions;
  }

  return {
    evaluate,
    isExhausted: () => exhausted,
    clearExhausted: () => {
      exhausted = false;
    },
  };
}
