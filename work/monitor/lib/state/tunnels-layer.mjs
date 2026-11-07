// layers.tunnels —— v2.18 多隧道并存（设计 §6.3）：每台服务器一条隧道，各自独立呈现。
//
// **不参与 computeHealth()**：全局 health 只描述"你正在看的那台"（layers.channel）。
// 腾讯云隧道断开不该把主链路判红——这正是本轮设计要消灭的"切换视角掉隧道"的反面：
// 次要隧道的故障只影响它自己的卡片，前端从本层生成"次要隧道断开"的注意力条目。

import { toPort } from "../validators.mjs";
import { HANDOVER_STANDBY_REASON, stoppedReason } from "./channel-layer.mjs";

// 次要（非活跃）隧道的结论：任一要件明确为 false 即 error；两者皆 true 才 ok；
// 只知道一半 → warn（未知）；都不知道 → waiting。
function classifySecondaryTunnel(tunnelUp, portOpen) {
  if (tunnelUp === false || portOpen === false) {
    const reason = [
      tunnelUp === false ? "SSH 隧道未开启" : null,
      portOpen === false ? "远端端口未开放" : null,
    ].filter(Boolean).join("；");
    return { level: "error", reason };
  }
  if (tunnelUp === true && portOpen === true) return { level: "ok", reason: "隧道正常" };
  if (tunnelUp !== null || portOpen !== null) return { level: "warn", reason: "隧道状态未知" };
  return { level: "waiting", reason: "等待首次探测" };
}

// servers：已过滤掉屏蔽条目的服务器列表（配置顺序即输出键序）。
// tunnelsByServer：parseProcessList 的多隧道分桶；缺失（旧形状/首轮）时对非活跃服务器
// 一律给 null（未知），只有活跃服务器能回落到全局 reverseTunnel（那条就是它的隧道）。
// evidenceFor(server) → 端口证据 { open, checkedAt } | null；slowResultFor(serverId) → slow 采集结果。
// standbyFor(serverId) → 该服务器本机待命的事实（另一台 Mac 在承载，见 channel-layer 的 handoverStandby）| null。
export function buildTunnelsLayer({ servers, mainId, channel, flags, shouldBeRunning, tunnelsByServer, evidenceFor, slowResultFor, stopNote = null, standbyFor = () => null }) {
  const out = {};
  for (const server of servers) {
    const tunnel = server.tunnel !== false;
    const source = server.source ?? "team";
    const slow = slowResultFor(server.id);
    const evidence = evidenceFor(server);
    const portOpen = evidence?.open ?? null;
    const checkedAt = evidence?.checkedAt ?? slow?.checkedAt ?? null;

    if (!tunnel) {
      // "只监控不建隧道"：没有隧道可断，永远不该变红。
      out[server.id] = {
        level: "skipped", reason: "仅监控", tunnelUp: null,
        remotePortOpen: portOpen, checkedAt, source, tunnel,
      };
      continue;
    }
    if (server.id !== mainId && toPort(server.remotePort) === null) {
      // 还没领反向端口（v2.54 起团队层不预烤端口）：supervisor 不为它建隧道，不是故障，
      // 不进"次要隧道断开"。活跃服务器走下面与 layers.channel 同源的分支（同样是 skipped + setupPending）。
      out[server.id] = {
        level: "skipped", reason: "未领取反向端口", tunnelUp: null,
        remotePortOpen: null, checkedAt, source, tunnel, setupPending: true,
      };
      continue;
    }
    if (!shouldBeRunning) {
      // 用户手动停止通道（或自动修复重启整个通道的那一下）：所有隧道都是按意图停的，不是故障。
      out[server.id] = {
        level: "skipped", reason: stoppedReason(stopNote), tunnelUp: false,
        remotePortOpen: false, checkedAt, source, tunnel,
      };
      continue;
    }
    if (server.id === mainId) {
      // 活跃服务器与 layers.channel 同源：同一条链路不允许出现两种结论。
      out[server.id] = {
        level: channel.level, reason: channel.reason, tunnelUp: flags.tunnelUp,
        remotePortOpen: flags.remotePortOpen, checkedAt: channel.checkedAt, source, tunnel,
        ...(channel.setupPending ? { setupPending: true } : {}),
        ...(channel.handoverStandby ? { handoverStandby: true, handover: standbyFor(server.id) } : {}),
      };
      continue;
    }
    const entry = tunnelsByServer ? tunnelsByServer[server.id] : undefined;
    const tunnelUp = tunnelsByServer ? Array.isArray(entry) && entry.length > 0 : null;
    const standby = !tunnelUp && portOpen === true ? standbyFor(server.id) : null;
    if (standby) {
      out[server.id] = { level: "ok", reason: HANDOVER_STANDBY_REASON, tunnelUp, remotePortOpen: portOpen, checkedAt, source, tunnel, handoverStandby: true, handover: standby };
      continue;
    }
    const { level, reason } = classifySecondaryTunnel(tunnelUp, portOpen);
    out[server.id] = { level, reason, tunnelUp, remotePortOpen: portOpen, checkedAt, source, tunnel };
  }
  return out;
}
