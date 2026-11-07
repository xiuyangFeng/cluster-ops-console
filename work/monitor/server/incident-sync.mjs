// ---- T07 事件合并（incident store）接线 ----
// 只消费规范化事实（层级 level 变迁 / 探针错误 / 磁盘用量），绝不从中文文案反推。
// 偏好（acknowledge/snooze）只影响提醒资格，不改变故障事实；关闭事件只能由
// 连续真实成功采样驱动。持久化 runtime/incidents.json 原子写、软上限 1MB，
// 纳入 runtime 存储预算（storage-sweeper 扫描 runtime 目录）。
// 落盘由 store 持久化修订号驱动（createIncidentPersister 订阅变化）：成功连击、
// 磁盘中性带等不改变持久化状态的采样不再触发重写；已关闭事件拆到
// incidents-closed.json，只在已关闭集合变化时重写。旧单文件格式透明迁移。
// agent 探针归属经注册表（adapterForProbeId）+ 运行配置反查 agentId，不按 id 字符串写死；
// 设置页关掉的 Agent 不再摄入新事实，其未结事件在生命周期同步时以「模块已关闭」结案。
// 降噪：agent 事实按 agentId 分作用域（codex 的失败不会被 claude 探针的成功关掉）；同一 agent
// 多枚探针里任一枚最近一次是 error，其它探针的 ok 都不算该 agent 的恢复采样。打开门槛的待定候选
// 由本模块每 15s 调一次 promotePending() 推动转正（隧道/通道断开只有一次层级变迁）。

import path from "node:path";

import { adapterForProbeId, agentAdapterEnabled, agentIdForAdapter } from "../lib/agents/registry.mjs";
import { isServerEnabled } from "../lib/config-loader.mjs";
import { bus, EVENTS } from "../lib/event-bus.mjs";
import { incidentProbeServerId, recoverConnectionIncidents } from "../lib/incident-recovery.mjs";
import { createIncidentPersister } from "../lib/incidents/persister.mjs";
import { createIncidentStore } from "../lib/incidents/store.mjs";
import { serverIdFromCollectSlow } from "../lib/probe-ids.mjs";
import { isChannelSetupOnly } from "../lib/state/channel-layer.mjs";

const INCIDENT_LIFECYCLE_SYNC_MS = 60000;
// 待定候选按时间转正的检查节奏（门槛 120s/150s，15s 粒度足够）。
export const INCIDENT_PENDING_PROMOTE_MS = 15000;

// agent 探针 → agentId：经注册表反查所属适配器，再按运行配置取其 agentId（配置条目 id 优先）。
// 非 agent 探针、或所属适配器在当前配置下未启用（设置页关闭 / 关闭瞬间迟到的结果）→ null。
export function agentIdForProbe(probeId, config) {
  const adapter = adapterForProbeId(probeId);
  if (!adapter || !agentAdapterEnabled(adapter, config)) return null;
  return agentIdForAdapter(adapter, config);
}

// 设置页关掉的 Agent（agentCatalog 里 enabled:false 的条目）。从配置里整个删掉的 Agent 不在此列。
export function disabledAgentIds(config) {
  return (Array.isArray(config?.agentCatalog) ? config.agentCatalog : [])
    .filter((agent) => agent?.enabled === false && typeof agent.id === "string")
    .map((agent) => agent.id);
}

// agent health → 稳定 reasonCode（指纹的一部分；展示文案不进指纹）。
const AGENT_HEALTH_REASON = {
  degraded: "DEGRADED",
  missing: "AGENT_MISSING",
  "auth-required": "AUTH_REQUIRED",
  revoked: "ACCOUNT_REVOKED",
  banned: "ACCOUNT_BANNED",
};

export function agentReasonCode(health) {
  return AGENT_HEALTH_REASON[health || ""] || "AGENT_ATTENTION";
}

export function sanitizeIncidentText(text) {
  return typeof text === "string" ? text.slice(0, 120) : "";
}

// 「查看处置日志」：处置操作一经受理，就把它的 operationId 关联到它处置的全部未解决事件。
// 规则刻意简单：只有连接类故障（隧道 / 通道）是重启能处置的——账号吊销/封禁等（agent）
// 与磁盘（filesystem）一律不关联；给 serverId = 单隧道重启，只关联该服务器的事件；
// 不给 = 通道级重启（手动一键修复 / 自动修复），关联所有服务器的事件。已恢复事件不动。
// 同时在事件上记一条处置记录（action 由有无 serverId 推出，trigger 由调用方给出：auto = 自动修复），
// 恢复或复核到时给出结果（lib/incidents/disposition.mjs），事件卡片据此显示「处置后 N 秒恢复 / 仍未恢复」。
const OPERATION_LINKED_COMPONENTS = new Set(["tunnel", "channel"]);

export function linkOperationToIncidents({ incidentStore, operationId, serverId = null, trigger = "manual" }) {
  if (typeof operationId !== "string" || !operationId) return [];
  const linked = [];
  const disposition = { action: serverId ? "restart-tunnel" : "restart-channel", trigger: trigger === "auto" ? "auto" : "manual" };
  let cursor;
  do {
    const page = incidentStore.query({ state: "open", serverId: serverId || undefined, limit: 200, cursor });
    for (const incident of page.incidents) {
      if (incident.lifecycle !== "open" || !OPERATION_LINKED_COMPONENTS.has(incident.component)) continue;
      incidentStore.linkOperation(incident.incidentId, operationId, disposition);
      linked.push(incident.incidentId);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return linked;
}

// 总线事实 → 事件存储。每个事件只取一次 layers / summary（getSummary 复用同一份 layers），
// 此前一次 PROBE_UPDATED 要重算 3～5 次层级模型。退出途中（isClosing）不再摄入事实。
export function createIncidentObservers({ store, incidentStore, getMergedConfig, getShouldBeRunning, isClosing }) {
  // 每台服务器每枚 agent 探针的最近一次 level："serverId|probeId" -> agentId/level（≤ 服务器数 × agent 探针数）。
  const probeLevels = new Map();
  // 该 agent 在该服务器上是否有探针最近一次是 error（有则别的探针 ok 也不算恢复采样）。
  function agentHasProbeError(serverId, agentId) {
    const prefix = `${serverId}|`;
    for (const [key, entry] of probeLevels) {
      if (key.startsWith(prefix) && entry.agentId === agentId && entry.level === "error") return true;
    }
    return false;
  }

  function snapshot() {
    const layers = store.getLayers();
    const summary = store.getSummary(undefined, { layers });
    return { layers, summary, activeId: summary?.context?.serverId || "" };
  }

  // 层级变迁 → 事件事实（只对 error/warn 观测、ok 恢复；skipped/waiting 不产生事实）。
  function onStatusChanged({ transitions }) {
    if (isClosing()) return;
    try {
      const { layers, summary, activeId } = snapshot();
      const merged = getMergedConfig();
      for (const t of transitions || []) {
        if (t.key === "channel") {
          if (!isServerEnabled(merged, activeId)) continue;
          // 没领反向端口是配置未完成，不立案（通道层已判 skipped，这里按结构化标记再挡一道）；
          // 本地代理明确没跑是本机真故障，照常立案。
          if (isChannelSetupOnly(layers.channel)) continue;
          if (t.to === "error") {
            const reasonCode = summary?.transport?.reasonCode || "CHANNEL_ERROR";
            incidentStore.observe({ serverId: activeId, component: "channel", reasonCode, severity: "error", evidence: { kind: "channel-transition", reason: sanitizeIncidentText(t.reason) } });
          }
          continue;
        }
        if (t.key.startsWith("tunnel:")) {
          const serverId = t.key.slice("tunnel:".length);
          if (!isServerEnabled(merged, serverId)) continue;
          if (t.to === "error") {
            incidentStore.observe({ serverId, component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", evidence: { kind: "tunnel-transition", reason: sanitizeIncidentText(t.reason) } });
          }
          continue;
        }
        if (t.key.startsWith("agent:")) {
          if (!isServerEnabled(merged, activeId)) continue;
          const agentId = t.key.slice("agent:".length);
          const reasonCode = agentReasonCode(layers.agents?.[agentId]?.health);
          if (t.to === "error" || t.to === "warn") {
            incidentStore.observe({ serverId: activeId, agentId, component: "agent", reasonCode, severity: t.to === "error" ? "error" : "warn", evidence: { kind: "agent-transition" } });
          } else if (t.to === "ok" && !agentHasProbeError(activeId, agentId)) {
            incidentStore.reportSuccess({ serverId: activeId, agentId, component: "agent" });
          }
        }
      }
    } catch {}
  }

  // agent 探针每轮失败都是一次真实检测（occurrence 累加）；ok 是成功采样——但只在同一 agent
  // 的其它探针最近一次都不是 error 时才算（doctor 持续报错时 endpoint 的 ok 不能把事件关掉）。
  function onProbeUpdated({ id, result }) {
    if (isClosing()) return;
    try {
      const { layers, activeId } = snapshot();
      const serverId = incidentProbeServerId({ id, result, activeServerId: activeId, servers: getMergedConfig().servers });
      if (!serverId) return;
      recoverConnectionIncidents({ id, result, activeServerId: activeId, layers, incidentStore, shouldBeRunning: getShouldBeRunning() });
      if (adapterForProbeId(id)) {
        const agentId = agentIdForProbe(id, getMergedConfig());
        // 所属 Agent 已被关闭：迟到结果不摄入，也不留下错误记录（重新打开后从头判定）。
        if (!agentId) {
          probeLevels.delete(`${serverId}|${id}`);
          return;
        }
        const level = result?.level;
        probeLevels.set(`${serverId}|${id}`, { agentId, level });
        if (level === "error") {
          incidentStore.observe({
            serverId: activeId,
            agentId,
            component: "agent",
            reasonCode: agentReasonCode(layers.agents?.[agentId]?.health),
            severity: "warn",
            evidence: { kind: "probe", probeId: id },
          });
        } else if (level === "ok") {
          if (!agentHasProbeError(serverId, agentId)) incidentStore.reportSuccess({ serverId: activeId, agentId, component: "agent" });
        } else {
          incidentStore.reportUnknown({ serverId: activeId, agentId, component: "agent" });
        }
        return;
      }
      const diskServerId = serverIdFromCollectSlow(id);
      if (diskServerId && result?.data?.usage?.filesystem?.usedPct != null) {
        incidentStore.observeDiskUsage({ serverId: diskServerId, usedPct: result.data.usage.filesystem.usedPct });
      }
    } catch {}
  }

  return { onStatusChanged, onProbeUpdated };
}

// 构造即加载持久化快照并做一次服务器生命周期同步（listen 之前完成），之后每 60s 复核一次；
// 待定候选每 15s 检查一次是否到时转正。openGate 仅供测试注入（{} = 首次失败立即打开）。
export async function createIncidentSync({ runtimeDir, appendLog, configManager, openGate }) {
  const incidentStore = createIncidentStore({ log: appendLog, ...(openGate ? { openGate } : {}) });
  const persister = createIncidentPersister({ store: incidentStore, filePath: path.join(runtimeDir, "incidents.json"), log: appendLog });
  try { await persister.load(); } catch {}
  let closing = false;

  // 服务器生命周期 + v2.47 Agent 模块开关：设置页关掉的 Agent 的未结事件自动关闭（「模块已关闭」）。
  async function syncServerLifecycle() {
    // 同一次成功配置读取的完整快照；读取失败不将降级空数组当作删除指令。
    const lifecycle = configManager.getIncidentServerLifecycle();
    if (!lifecycle) return { changed: false, skipped: true };
    const result = incidentStore.syncServerLifecycle(lifecycle);
    // Agent 开关只认同一份权威配置缓存（lifecycle 非空即说明缓存来自成功读取）。
    const closedAgents = incidentStore.closeAgentIncidents({ agentIds: disabledAgentIds(configManager.getCache?.()) }) || [];
    if (closedAgents.length) {
      result.changed = true;
      result.agentsClosed = closedAgents.length;
      appendLog(`incident lifecycle: closed ${closedAgents.length} incident(s) of disabled agent modules`);
    }
    // CRUD 必须等事件快照保存后才返回；失败后下次刷新仍会重试。
    if (persister.isUrgentDirty()) await persister.flush();
    return result;
  }
  await syncServerLifecycle();
  const expiryTimer = setInterval(() => {
    syncServerLifecycle()
      .catch((err) => appendLog(`incident lifecycle sync failed: ${err.message}`));
  }, INCIDENT_LIFECYCLE_SYNC_MS);
  expiryTimer.unref?.();
  const promoteTimer = setInterval(() => {
    if (closing) return;
    try {
      incidentStore.promotePending();
      // 处置复核：受理满时限仍未恢复的处置记「未恢复」（同一 15s 节奏，时限 3 分钟）。
      incidentStore.verifyDispositions?.();
    } catch (err) {
      appendLog(`incident pending promotion failed: ${err.message}`);
    }
  }, INCIDENT_PENDING_PROMOTE_MS);
  promoteTimer.unref?.();

  const isClosing = () => closing;

  return {
    incidentStore,
    syncServerLifecycle,
    isClosing,
    // STATUS_CHANGED / PROBE_UPDATED 各挂一个观察者（挂载时机决定其在同一事件内的顺序）。
    registerObservers({ store, getMergedConfig, getShouldBeRunning }) {
      const observers = createIncidentObservers({ store, incidentStore, getMergedConfig, getShouldBeRunning, isClosing });
      bus.on(EVENTS.STATUS_CHANGED, observers.onStatusChanged);
      bus.on(EVENTS.PROBE_UPDATED, observers.onProbeUpdated);
    },
    // 处置操作受理 → 关联事件（start.mjs 经 late 槽位调用）。尽力而为：任何异常只落日志、
    // 绝不抛回操作路径——关联失败不能让重启失败或变慢。退出途中不再改事件。
    linkOperation({ operationId, serverId = null, trigger = "manual" } = {}) {
      if (closing) return [];
      try {
        return linkOperationToIncidents({ incidentStore, operationId, serverId, trigger });
      } catch (err) {
        appendLog(`incident link failed: ${err?.message || err}`, { level: "warn", event: "incident-link", operationId });
        return [];
      }
    },
    // 退出第一步：停止摄入事实（HTTP 同时转 503）、停止落盘排期与周期复核；
    // 最终落盘（close）排在排干在途请求之后。
    beginShutdown() {
      closing = true;
      persister.dispose();
      clearInterval(expiryTimer);
      clearInterval(promoteTimer);
    },
    close: () => persister.close(),
  };
}
