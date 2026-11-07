// 同账号多台 Mac 接力（v2.88）的前端事实与文案（纯函数）。
//
// 数据源：/api/status.connectionTargets（supervisor 运行快照的投影）——
//   servers[serverId].handover = { role: "standby", since, reason, health, holder: { label, ownerId, heldSec } }
//   machine = { label, ownerId }（本机）
//   capabilities.siblingTakeover（守护进程支持「让这台承载」）
// 本机待命 = 另一台 Mac 正在承载这台服务器的反向端口；集群照样经隧道出网，这台不是故障。

const REASON_TEXT = {
  "holder-active": "端口在另一台 Mac 手里，它在线",
  "holder-unresponsive": "另一台 Mac 没有应答，确认后本机自动接上",
  yielded: "另一台 Mac 接管了，本机让位",
};

// 本机在这台服务器上待命的事实；不是待命返回 null。
export function handoverStandbyOf(status, serverId = status?.activeServerId) {
  if (!serverId) return null;
  const entry = status?.connectionTargets?.servers?.[serverId]?.handover;
  if (entry?.role !== "standby") return null;
  return {
    serverId,
    since: Number.isFinite(entry.since) ? entry.since : null,
    reason: typeof entry.reason === "string" ? entry.reason : null,
    health: typeof entry.health === "string" ? entry.health : null,
    holderLabel: entry.holder?.label || null,
    holderTag: typeof entry.holder?.ownerId === "string" ? entry.holder.ownerId.slice(0, 4) : null,
    heldSec: Number.isFinite(entry.holder?.heldSec) ? entry.holder.heldSec : null,
  };
}

// 守护进程支持接力，且这台服务器上本机正在待命：才出「让这台承载」。
export function canTakeOver(status, serverId = status?.activeServerId) {
  const projection = status?.connectionTargets;
  return projection?.source === "supervisor-snapshot"
    && projection?.capabilities?.siblingTakeover === true
    && Boolean(handoverStandbyOf(status, serverId));
}

// 承载方的称呼：两台 Mac 主机名可能一样，同名时带上识别码前 4 位区分。
export function holderName(standby, machine = null) {
  if (!standby) return "另一台 Mac";
  const label = standby.holderLabel;
  if (!label) return standby.holderTag ? `另一台 Mac（${standby.holderTag}）` : "另一台 Mac";
  const same = machine?.label && machine.label === label;
  return same && standby.holderTag ? `${label}（${standby.holderTag}）` : label;
}

function roughDuration(sec) {
  if (!Number.isFinite(sec) || sec < 60) return "不到 1 分钟";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时`;
  return `${Math.floor(sec / 86400)} 天`;
}

// 一行摘要：链路图管子上的小字、侧栏提示。
export function handoverNote(standby, machine = null) {
  if (!standby) return "";
  return `由 ${holderName(standby, machine)} 承载 · 本机待命`;
}

// 隧道节点详情：描述 + 事实行（label / value / tone）。
export function handoverDetail(standby, machine = null) {
  if (!standby) return null;
  const name = holderName(standby, machine);
  const facts = [{ label: "承载方", value: name }];
  if (standby.heldSec != null) facts.push({ label: "已承载", value: roughDuration(standby.heldSec) });
  if (standby.health === "dead") facts.push({ label: "对方状态", value: "经端口打不通对方的代理（可能睡眠或断网）", tone: "warn" });
  else if (standby.health === "unknown") facts.push({ label: "对方状态", value: "集群上没有 curl，判断不了对方是否在线" });
  if (machine?.label) facts.push({ label: "本机", value: machine.label });
  return {
    desc: `${name} 正在承载这条隧道，集群照常经它出网；本机待命，对方睡眠或断网时会自动接上`,
    reason: REASON_TEXT[standby.reason] || "",
    facts,
  };
}
