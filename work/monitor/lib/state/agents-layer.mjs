import { buildAgentOverview } from "../../monitor-core.mjs";
import { adapterForAgent } from "../agents/registry.mjs";
import { deriveAgentCapabilities } from "../readiness-view.mjs";
import { latestCheckedAt } from "./probe-results.mjs";

// layers.agents 与 readiness.agents 的投影。agent 专属的熔断态 / 关联探针由
// lib/agents/ 注册表里的适配器声明；这里只做"事实 → 层级"的决策表。
// 依赖注入：stateFor(adapter) → 适配器私有归并状态（state-store 惰性创建）；
// resultFor(probeId) → 该探针最近一次结果。

// agent health → 层级 level 的映射。
// revoked/banned（B1 账号层故障：device_revoked/account_banned）映射到 error（红）——
// 这是此前三层判定全绿的盲区，明确判红才能让控制台反映真实故障。
// not-installed（v2.57）：官方 CLI 没装是用户的选择（只用 codex 或只用 Claude），不是故障——映射到
// skipped：不产生事件事实（transitions / incident-sync 只对 error/warn 立案）、不计入注意力。
const HEALTH_LEVELS = {
  "not-installed": "skipped",
  ready: "ok",
  degraded: "warn",
  "auth-required": "warn",
  missing: "error",
  revoked: "error",
  banned: "error",
  waiting: "waiting",
};

function healthToLevel(health) {
  return HEALTH_LEVELS[health] || "warn";
}

// 凭证过期兜底：expired 至少降到 error、warn 至少降到 warn，但绝不下调既有更严重的结论
// （既有 level 已经比过期兜底更严重时，原样保留 level/reason，不追加过期提示，
//  避免用不那么要紧的过期提醒盖掉更严重的既有原因）。
const LEVEL_SEVERITY = { ok: 0, waiting: 0, skipped: 0, warn: 1, error: 2 };
const EXPIRY_FLOOR_LEVEL = { expired: "error", warn: "warn" };

export function applyExpiryFloor(level, reason, expiry, agentLabel) {
  const floor = expiry && EXPIRY_FLOOR_LEVEL[expiry.level];
  if (!floor) return { level, reason };
  const currentSeverity = LEVEL_SEVERITY[level] ?? 0;
  const floorSeverity = LEVEL_SEVERITY[floor];
  if (currentSeverity >= floorSeverity) return { level, reason };
  const remainingDays = expiry.remainingMs != null ? Math.max(0, Math.ceil(expiry.remainingMs / 864e5)) : null;
  const hint = expiry.level === "expired"
    ? `凭证已过期，请在服务器上执行 ${agentLabel} login`
    : `凭证即将过期${remainingDays != null ? `（约 ${remainingDays} 天后）` : ""}，建议尽快在服务器上执行 ${agentLabel} login`;
  return { level: floor, reason: reason ? `${reason}；${hint}` : hint };
}

// 该 agent 关联探针的最近探测时刻。未注册 kind 的 agent 无关联探针（不错借别家探针的时间戳）。
function relatedResults(adapter, resultFor) {
  return adapter ? adapter.probeIds.map((probeId) => resultFor(probeId)) : [];
}

// monitorOnly：查看视角是仅监控 / 无服务器——不做 Agent 检查，整层 skipped。
export function buildAgentsLayer({ config, agentsStatus, agentExpiry, monitorOnly, stateFor, resultFor }) {
  const overview = buildAgentOverview(config.agents || [], agentsStatus, config.activeAgentId);
  const summaryByAgent = new Map(overview.map((item) => [item.id, item.summary]));
  const agents = {};
  for (const agent of config.agents || []) {
    const status = agentsStatus[agent.id] || { health: "waiting", output: "检测中..." };
    const adapter = adapterForAgent(agent);
    // 短路：仅监控时不触碰适配器状态（不惰性创建）。
    const skipped = monitorOnly || (adapter ? Boolean(adapter.isSkipped(stateFor(adapter))) : false);
    const related = relatedResults(adapter, resultFor);
    const checkedAt = latestCheckedAt(related);
    const seen = related.some(Boolean);
    let level = skipped ? "skipped" : (seen ? healthToLevel(status.health) : "waiting");
    let reason = monitorOnly
      ? "未启用 Agent 检查"
      : skipped
        ? "通道异常，熔断跳过"
        : (status.health === "not-installed" && seen ? "未安装（不计入健康）" : (status.health || "waiting"));
    const expiry = agentExpiry[agent.id] || null;
    // 熔断跳过时不受凭证过期兜底影响：那是通道层问题，与 agent 自身凭证过期是两码事。
    if (!skipped && expiry && expiry.level !== "unknown") {
      ({ level, reason } = applyExpiryFloor(level, reason, expiry, agent.command || agent.id));
    }
    agents[agent.id] = {
      level,
      reason,
      checkedAt,
      health: status.health || "waiting",
      summary: summaryByAgent.get(agent.id) ?? "",
      output: status.output || "",
      expiry,
    };
  }
  return agents;
}

// readiness.agents：能力投影（readiness-view 的决策表）+ 与 agentsOverview 同源的展示 summary。
export function buildReadinessAgents({ config, agentsStatus, resultFor, nowMs }) {
  const agents = {};
  for (const agent of config.agents || []) {
    const status = agentsStatus[agent.id] || {};
    const checkedAt = latestCheckedAt(relatedResults(adapterForAgent(agent), resultFor));
    const endpointOk = typeof status.endpoint?.ok === "boolean"
      ? status.endpoint.ok
      : typeof status.claudeEndpoint?.ok === "boolean"
        ? status.claudeEndpoint.ok
        : null;
    agents[agent.id] = {
      ...deriveAgentCapabilities({
        health: status.health || "waiting",
        installed: typeof status.installed === "boolean" ? status.installed : undefined,
        endpointOk,
        endpointCheckedAt: checkedAt,
        doctorSummary: status.summary && typeof status.summary === "object" ? status.summary : null,
        doctorCheckedAt: checkedAt,
        nowMs,
      }),
      // 适配器层的展示 summary 原样透传（与 agentsOverview 同源）。
      displaySummary: buildAgentOverview([agent], agentsStatus, config.activeAgentId)[0]?.summary || "",
    };
  }
  return agents;
}
