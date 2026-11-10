import { isActiveTunnelUp } from "../../monitor-core.mjs";
import { toPort } from "../validators.mjs";
import { earliestNextCheckAt, latestCheckedAt } from "./probe-results.mjs";

// layers.channel —— "你正在看的那台"（查看视角主服务器）的数据通路三要件 + 守护进程。
// 纯函数：输入是 state-store 持有的事实（进程快照、端口证据、运行意图），输出是层级投影。

// 远端端口证据：fast 采集（log-signals，仅活跃服务器）与该服务器 slow 采集的 ports 段，
// 谁更新用谁；都没有 → null（未知）。
export function selectPortEvidence(fast, slowResult, remotePort) {
  const ports = slowResult?.data?.ports;
  const sampled = ports && Object.hasOwn(ports, remotePort)
    ? { open: ports[remotePort] === true, checkedAt: slowResult.checkedAt } : null;
  return fast && (!sampled || fast.checkedAt >= sampled.checkedAt) ? fast : sampled;
}

// 查看视角不需要数据通路：没有可用服务器，或该服务器声明 tunnel:false（仅监控）。
export function isMonitorOnly(main) {
  return !main.id || main.tunnel === false;
}

// v2.54 起团队层不预烤 remotePort：要建隧道却还没领到反向端口，是"配置未完成"而不是故障。
// 通道层据此给结构化标记 setupPending / setupReason，下游（分诊、自动修复、事件、托盘与悬浮岛、
// 注意力队列）一律认这个标记，不再从"隧道不通"推断出一次断线。
export const SETUP_REASON_MISSING_PORT = "missing-port";

export function isPortUnclaimed(main) {
  return !isMonitorOnly(main) && toPort(main.remotePort) === null;
}

// 通道旗标：仅监控时数据通路三项为 null（不适用）；手动停止时强制全部拉低
// （与 v1.5.2 高频轮询的 stopped 分支一致）。
// handoverStandby（v2.88）：同账号另一台 Mac 正在承载这台服务器的反向端口、本机待命（supervisor 运行快照给出）。
// 本机没有隧道进程（tunnelUp 仍如实为 false），但集群照样经隧道出网：下游一律把它当作「隧道这一段已满足」，
// 不判断开、不立案、不自动重启。只在端口确实开着时才算（对方的隧道也断了就照常判断开）。
export function deriveChannelFlags({ main, shouldBeRunning, processes, remotePortOpen, handoverStandby = false }) {
  if (isMonitorOnly(main)) {
    return { supervisorUp: processes.supervisor.length > 0, localProxyUp: null, tunnelUp: null, remotePortOpen: null };
  }
  if (!shouldBeRunning) {
    return { supervisorUp: false, localProxyUp: false, tunnelUp: false, remotePortOpen: false };
  }
  // v2.18 多隧道：reverseTunnel 是"所有隧道的并集"——直接拿它当主链路的 tunnelUp，
  // 会在活跃服务器隧道断、别的服务器隧道还在时给出假绿；按活跃服务器那一格判定。
  const tunnelUp = isActiveTunnelUp(processes, main.id);
  return {
    supervisorUp: processes.supervisor.length > 0,
    localProxyUp: processes.localProxy.length > 0,
    tunnelUp,
    remotePortOpen,
    ...(handoverStandby === true && !tunnelUp && remotePortOpen === true ? { handoverStandby: true } : {}),
  };
}

// 隧道这一段是否满足：本机隧道在，或另一台 Mac 在承载（handoverStandby）。
export function tunnelSatisfied(flags) {
  return flags?.tunnelUp === true || flags?.handoverStandby === true;
}

export const HANDOVER_STANDBY_REASON = "另一台 Mac 正在承载这条隧道，本机待命";

// 运行意图为"停"时的原因文案：缺省是用户手动停止；自动修复重启整个通道的那一下由执行器
// 经 state-store.setStopNote 给出说明（v2.64），时间线不再把它写成「通道已手动停止」。
export const MANUAL_STOP_REASON = "通道已手动停止";
export function stoppedReason(stopNote) {
  return typeof stopNote === "string" && stopNote ? stopNote : MANUAL_STOP_REASON;
}

// hasPortEvidence：该服务器的远端端口是否已有任何证据（fast 采集 / slow 采集的 ports 段）。
// 缺省 true（旧调用方语义不变）。
export function deriveChannelLevel({ main, shouldBeRunning, hasProcessesResult, hasPortEvidence = true, flags, stopNote = null }) {
  if (isMonitorOnly(main)) return { level: "skipped", reason: main.id ? "仅监控，未启用反向隧道" : "未配置可用服务器" };
  if (!shouldBeRunning) return { level: "skipped", reason: stoppedReason(stopNote) };
  // 还没领反向端口：supervisor 不会为它建隧道（不回落任何默认端口），通道必然不通——但这是
  // 配置未完成，不是故障。判 skipped 并带 setupPending：不产生 error 变迁（于是不进事件、不发桌面通知），
  // 分诊归为 setup、自动修复不重启通道。legacy health 仍按旗标算 down（首次配置引导卡据此出现）。
  // 例外：本机进程已探到、本地代理却没跑——这是本机真故障（与端口无关），照常判 error，
  // 标记仍保留（下游据 localProxyUp === false 区分"没端口"与"本地代理挂了"），不让 setup 吞掉真故障。
  if (isPortUnclaimed(main)) {
    const setup = { setupPending: true, setupReason: SETUP_REASON_MISSING_PORT };
    if (hasProcessesResult && flags?.localProxyUp === false) {
      return { level: "error", reason: "本地代理未运行（另：未领取反向端口，隧道不会建立）", ...setup };
    }
    return { level: "skipped", reason: "未领取反向端口，隧道不会建立", ...setup };
  }
  if (!hasProcessesResult) return { level: "waiting", reason: "等待首次探测" };
  const f = flags;
  // 本地代理与隧道都在、远端端口还没有任何证据（热启动后本机 ps 先回、SSH fast 采集首轮未回）：
  // 端口是「未知」不是「未开放」。此时判 error 会在时间线/事件里留下一次 waiting → error → ok
  // 的假故障，所以保持 waiting 等首个样本（fast 采集超时/SSH 失败也会给出 false 结论，等待有界）。
  // 本地任一段缺失仍立即判 error——冷启动的真故障照常浮出。
  if (f.localProxyUp && f.tunnelUp && !hasPortEvidence) return { level: "waiting", reason: "等待远端端口探测" };
  if (f.supervisorUp && f.localProxyUp && f.tunnelUp && f.remotePortOpen) {
    return { level: "ok", reason: "通道全链路正常" };
  }
  if (f.supervisorUp && f.localProxyUp && f.handoverStandby && f.remotePortOpen) {
    return { level: "ok", reason: HANDOVER_STANDBY_REASON, handoverStandby: true };
  }
  if (!f.localProxyUp || !f.tunnelUp || !f.remotePortOpen) {
    const broken = [
      !f.localProxyUp ? "本地代理未运行" : null,
      !f.tunnelUp ? "SSH 隧道未开启" : null,
      !f.remotePortOpen ? "远端端口未开放" : null,
    ].filter(Boolean).join("；");
    return { level: "error", reason: broken };
  }
  return { level: "warn", reason: "守护进程未运行" };
}

// v2.18：远端端口结论由 fast 采集探针（id 仍是 log-signals）承担，
// 通道层的探测时刻随之改看它——primary-remote 已随零残留采集一并删除。
// detail.downSinceMs 由调用方（持有 channelErrorSince 状态）追加在最后。
export function buildChannelLayer({ main, levelInfo, flags, procResult, remoteResult, proxyPort = null }) {
  const timing = [procResult, remoteResult];
  const queryDiagnostic = procResult?.data?.processQueryIndeterminate ? procResult.data.processQueryDiagnostic : null;
  return {
    ...levelInfo,
    ...(queryDiagnostic ? { level: "waiting", reason: queryDiagnostic.message } : {}),
    checkedAt: latestCheckedAt(timing),
    nextCheckAt: earliestNextCheckAt(timing),
    detail: {
      ...flags,
      ...(queryDiagnostic ? { processQueryDiagnostic: queryDiagnostic } : {}),
      host: main.host,
      // supervisor 首拍后会把共享代理端口钉死；切换查看服务器不会重启它。
      // 有运行快照时优先展示实际端口，避免把新活跃服务器的配置端口误报成运行端口。
      localPort: Number.isInteger(proxyPort) ? proxyPort : main.localPort,
      // 没领端口时显式给 null（"未领取"），不让键随 undefined 静默消失。
      remotePort: main.remotePort ?? null,
      ...(isMonitorOnly(main) ? { transportRequired: false } : {}),
      // 标记同时放进 detail：分诊快照、自动修复视图与 readiness 投影都只读 detail。
      ...(levelInfo?.setupPending ? { setupPending: true, setupReason: levelInfo.setupReason } : {}),
    },
    ...(levelInfo?.handoverStandby ? { handoverStandby: true } : {}),
  };
}

// 通道层是否处于"配置未完成（没领端口）"：layer 或 detail 任一带标记即是。
export function isChannelSetupPending(channel) {
  return channel?.setupPending === true || channel?.detail?.setupPending === true;
}

// 没领端口、且本机这一段也没有真故障（本地代理不是明确未运行）：下游据此"整段忽略"——
// 不立案、不自动重启。本地代理明确挂了时返回 false，真故障照常走事件 / 通知。
export function isChannelSetupOnly(channel) {
  return isChannelSetupPending(channel) && channel?.detail?.localProxyUp !== false;
}

// fast 采集结果 → 旧 remotePort / remotePortOpen 字段的更新；null = 本轮不改动。
// 分支语义与旧 primary-remote 逐条对齐：skipped 保留最近结果；有结论就采信；
// error 轮（超时/SSH 失败，无端口结论）判定端口不通——绝不留一个假的 true，
// 否则通道断开时面板会一直显示"远端端口开放"。
export function remotePortFromFastResult(result) {
  const data = result.data || null;
  if (result.level === "skipped") return null;
  if (data && typeof data.remotePortOpen === "boolean") {
    return {
      open: data.remotePortOpen,
      remotePort: data.remotePortOpen
        ? { ok: true, code: 0, output: "open" }
        : { ok: false, code: 1, output: "closed" },
    };
  }
  if (result.level === "error") {
    return { open: false, remotePort: { ok: false, code: -1, output: result.reason || "远端探测失败" } };
  }
  return null;
}
