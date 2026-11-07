// readiness-view.mjs —— T02 能力状态 / 诊断上下文 / 新鲜度的纯投影。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §3.3 / §5）：
//   - transport 与 Agent 能力分开展示：总体 health（classifyHealth）混入 Doctor/端点
//     结论，导致"网络可达但 Doctor 失败"被三端（主窗口/托盘/悬浮岛）一致地显示成
//     "服务降级"。本模块只做事实 → 展示的投影，不复制第二套健康判定：
//     legacy health 与自动修复行为完全不动（§3.4 兼容策略）。
//   - transport 只描述数据通路（本地代理 + 隧道 + 远端监听），枚举
//     connected/disconnected/stopped/unknown/setup（v2.54：还没领反向端口，配置未完成、不是断线）；supervisor 缺位是组件层的 attention 事实，
//     不再把 transport 拖成 disconnected。
//   - freshness 枚举 fresh/stale/unknown；stale 必须保留 lastKnownState，不绿灯伪装。
//   - 能力 state 枚举 pass/fail/attention/unknown/unsupported；unknown 是证据不足，
//     unsupported 是环境不提供——两者都不是失败，更不能落成 0。
//   - 决策表（§5.1）：未认证 401 不判 identity pass；仅监听不推断网络可达；
//     手动停止 → stopped 而不是 disconnected。

export const SUMMARY_SCHEMA_VERSION = 1;

// 新鲜度宽限：初始取 max(该项 timeoutMs, 2 × scheduler tickMs)。fast 探针 10s 一轮、
// 超时 15s；slow 60s。这里用"nextCheckAt + grace"判定而不是固定 30s，避免把
// 5 分钟级的 Doctor 误标过期（§5.3）。graceMs 可按探针节奏传入，默认 15s。
export const DEFAULT_FRESHNESS_GRACE_MS = 15_000;

// 单调时钟安全阀：checkedAt 在"未来"（时钟回拨/伪造数据）视为不可判 fresh。
export function deriveFreshness({ checkedAt, nextCheckAt, nowMs, graceMs = DEFAULT_FRESHNESS_GRACE_MS } = {}) {
  if (!Number.isFinite(checkedAt)) return "unknown";
  if (!Number.isFinite(nowMs)) return "unknown";
  if (checkedAt > nowMs + 1000) return "unknown";
  // 有 nextCheckAt 用 nextCheckAt + grace；没有退回 checkedAt + grace 兜底。
  const deadline = (Number.isFinite(nextCheckAt) ? nextCheckAt : checkedAt) + graceMs;
  return nowMs <= deadline ? "fresh" : "stale";
}

// transport 决策（只看数据通路三要件 + 手动停止意图）。
export function deriveTransportState({
  shouldBeRunning,
  localProxyUp,
  tunnelUp,
  remotePortOpen,
  setupPending = false,
  // 另一台 Mac 在承载、本机待命（v2.88）：隧道这一段按已满足算，reasonCode 单独标出。
  handoverStandby = false,
  checkedAt = null,
  nextCheckAt,
  nowMs,
} = {}) {
  if (shouldBeRunning === false) {
    return { state: "stopped", freshness: "fresh", reasonCode: "MANUALLY_STOPPED", checkedAt };
  }
  // 没领反向端口（通道层 setupPending）：隧道根本不会建，不是"连接中断"。三端显示「未领取端口」灰色，
  // 事件存储也认这个 reasonCode 不立案。
  // 本地代理明确没跑时仍是"连接中断"（本机真故障，不能被"没端口"盖住）。
  if (setupPending === true && localProxyUp !== false) {
    return { state: "setup", freshness: deriveFreshness({ checkedAt, nextCheckAt, nowMs }), reasonCode: "MISSING_PORT", checkedAt };
  }
  const flagsKnown = localProxyUp != null && tunnelUp != null && remotePortOpen != null;
  const standby = handoverStandby === true && tunnelUp !== true;
  const broken = [
    !localProxyUp && "LOCAL_PROXY_DOWN",
    !tunnelUp && !standby && "TUNNEL_DOWN",
    !remotePortOpen && "REMOTE_PORT_CLOSED",
  ].filter(Boolean);
  return {
    state: !flagsKnown ? "unknown" : broken.length > 0 ? "disconnected" : "connected",
    freshness: deriveFreshness({ checkedAt, nextCheckAt, nowMs }),
    reasonCode: !flagsKnown ? "WAITING_FIRST_PROBE" : broken.join("+") || (standby ? "HANDOVER_STANDBY" : "TRANSPORT_DATA_PATH_OK"),
    checkedAt,
  };
}

const ATTENTION_HEALTHS = new Set(["degraded", "missing", "auth-required", "revoked", "banned"]);
const IDENTITY_FAIL_HEALTHS = new Set(["auth-required", "revoked", "banned"]);

function agentCountFor(health) {
  if (health === "ready") return "available";
  if (ATTENTION_HEALTHS.has(health)) return "attention";
  return "unknown";
}

// 汇总摘要：主窗口 / 托盘 / 悬浮岛共用同构输出（三端不得各自重新判断）。
// layers/state-store 仍是唯一事实源；这里只做展示投影。
export function buildStatusSummary({
  layers,
  agentsOverview = [],
  activeServerId = "",
  shouldBeRunning,
  nowMs = Date.now(),
  contextRevision = "",
} = {}) {
  const channel = layers?.channel || {};
  const detail = channel.detail || {};
  const transport = deriveTransportState({
    shouldBeRunning,
    localProxyUp: detail.localProxyUp,
    tunnelUp: detail.tunnelUp,
    remotePortOpen: detail.remotePortOpen,
    setupPending: channel.setupPending === true || detail.setupPending === true,
    handoverStandby: channel.handoverStandby === true || detail.handoverStandby === true,
    checkedAt: channel.checkedAt,
    nextCheckAt: channel.nextCheckAt,
    nowMs,
  });

  const agentCounts = { available: 0, attention: 0, unknown: 0 };
  for (const agent of Array.isArray(agentsOverview) ? agentsOverview : []) {
    if (!agent) continue;
    agentCounts[agentCountFor(agent.health)] += 1;
  }

  // 次要隧道（非活跃服务器）的断开不计入 transport，但要计入事件数——
  // "其它服务器事件数量"与当前选择上下文分开呈现（§3.3 契约）。
  let otherServersAttention = 0;
  const activeId = activeServerId || "";
  for (const [serverId, entry] of Object.entries(layers?.tunnels || {})) {
    if (!entry || serverId === activeId) continue;
    if (entry.tunnel === false) continue;
    if (entry.level === "error") otherServersAttention += 1;
  }

  const incidentCount = agentCounts.attention + otherServersAttention;
  let headline;
  if (transport.state === "stopped") headline = "通道已手动停止";
  else if (transport.state === "setup") headline = "未领取反向端口，隧道不会建立";
  else if (transport.state === "disconnected") headline = "连接中断";
  else if (transport.state === "unknown") headline = "通道状态待验证";
  else if (transport.reasonCode === "HANDOVER_STANDBY") headline = "另一台 Mac 正在承载隧道，本机待命";
  else if (incidentCount > 0) headline = `连接已建立，${incidentCount} 项检查需要处理`;
  else headline = "连接已建立";

  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    transport: {
      state: transport.state,
      freshness: transport.freshness,
      reasonCode: transport.reasonCode,
      checkedAt: transport.checkedAt,
      // 可追溯性：渲染侧不得自行推进 checkedAt。
      nextCheckAt: Number.isFinite(channel.nextCheckAt) ? channel.nextCheckAt : null,
      graceMs: DEFAULT_FRESHNESS_GRACE_MS,
    },
    agentCounts,
    incidentCount,
    otherServersAttention,
    headline,
    context: {
      serverId: activeId,
      generatedAt: Math.trunc(nowMs),
      ...(contextRevision ? { configRevision: contextRevision } : {}),
    },
  };
}

// ---- Agent 能力投影（§5.1 决策表）----
// 输入是适配器/探针产出的**事实**；state-store 负责喂事实，这里负责决策表。

export function deriveAgentCapabilities({
  health = "waiting",
  installed,
  endpointOk,
  endpointCheckedAt,
  doctorSummary,
  doctorCheckedAt,
  nowMs = Date.now(),
} = {}) {
  const network = {
    state: endpointOk === true ? "pass" : endpointOk === false ? "fail" : "unknown",
    freshness: deriveFreshness({ checkedAt: endpointCheckedAt, nowMs }),
    checkedAt: endpointCheckedAt ?? null,
    reasonCode: endpointOk === true ? "ENDPOINT_REACHED" : endpointOk === false ? "ENDPOINT_FAILED" : "NO_EVIDENCE",
    evidenceIds: endpointOk == null ? [] : ["probe:endpoint"],
  };
  // 未认证 401 / 账号层故障是"明确证据"→ fail；除此之外一律 unknown（不判 pass）。
  const identityFailed = IDENTITY_FAIL_HEALTHS.has(health);
  const identity = {
    state: identityFailed ? "fail" : "unknown",
    freshness: "unknown",
    checkedAt: null,
    reasonCode: identityFailed ? `IDENTITY_${String(health).toUpperCase()}` : "NO_EVIDENCE",
    evidenceIds: [],
  };
  // health=ready 只说明适配器聚合为就绪，identity 的专门证据仍是空——保持 unknown，
  // 不把"网络可达"推理成"身份有效"（A07）。
  let runtimeState = "unknown";
  let runtimeReason = "NO_EVIDENCE";
  if (health === "not-installed") {
    // 官方 CLI 没装（v2.57）：中性，不是运行时故障。
    runtimeState = "unknown";
    runtimeReason = "AGENT_NOT_INSTALLED";
  } else if (installed === false) {
    runtimeState = "fail";
    runtimeReason = "AGENT_MISSING";
  } else if (doctorSummary && typeof doctorSummary === "object") {
    const fail = Number(doctorSummary.fail) || 0;
    const warn = Number(doctorSummary.warn) || 0;
    if (fail > 0) {
      runtimeState = "attention";
      runtimeReason = `DOCTOR_FAIL_${fail}`;
    } else if (doctorSummary.raw || doctorSummary.ok > 0 || fail === 0) {
      runtimeState = "pass";
      runtimeReason = warn > 0 ? `DOCTOR_WARN_${warn}` : "DOCTOR_PASS";
    }
  }
  const runtime = {
    state: runtimeState,
    freshness: deriveFreshness({ checkedAt: doctorCheckedAt, nowMs }),
    checkedAt: doctorCheckedAt ?? null,
    reasonCode: runtimeReason,
    evidenceIds: doctorSummary?.raw ? ["probe:doctor"] : [],
  };
  // lastWork：当前没有"真实任务成功"的证据来源（§2.1 证据分层），恒 unknown。
  const lastWork = { state: "unknown", freshness: "unknown", checkedAt: null, reasonCode: "NO_EVIDENCE", evidenceIds: [] };
  return { network, identity, runtime, lastWork };
}

export function buildReadiness({ serverId, generation = 0, configRevision = "", agents = {} } = {}) {
  return {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    context: {
      serverId: serverId ?? "",
      generation: Number.isFinite(generation) ? generation : 0,
      configRevision: String(configRevision || ""),
    },
    agents,
  };
}
