// operations-runner.mjs —— T04b 单隧道操作的 monitor 侧编排（preview → run → query）。
//
// 设计（docs/reviews/2026-09-05/implementation/01 §7.2 / §7.4）：
//   - preview：受影响服务器由后端计算（前端不可自报）；previewId 120 秒有效、单次消费；
//     目标签名由后端按当前配置 + 运行快照生成并冻结。
//   - run：只接 previewId。重新核对目标签名、实例与快照归属；变化 → 409 拒绝执行，
//     要求重开预览。写入 supervisor 控制信箱后立即返回 202（已受理 ≠ 修复成功）。
//   - 操作阶段 queued → executing → verifying → succeeded / failed / unknown。
//     结果无法确认时如实 unknown，客户端超时不触发重放（A19/A20）。
//   - 互斥：与全局通道重启、数据面热升级、其它单隧道操作互斥（M1 保守串行化）。
//   - 仅切换查看对象不改变已绑定动作目标：预览冻结 serverId + 签名，run 时复核。

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_ACTION_TAKEOVER_TUNNEL,
  CONTROL_REQUEST_TTL_MS,
  ControlProtocolError,
  buildControlRequest,
  controlDir,
  findControlResultByOperationId,
  readControlResult,
  writeControlRequest,
} from "./supervisor-control.mjs";
import { buildTunnelSignature as buildTargetSignature } from "./supervisor/tunnel-spec.mjs";
import { BOUNDED_SERVER_ID_PATTERN, toPort } from "./validators.mjs";

const OPERATIONS_PREVIEW_TTL_MS = 120_000;
const OPERATIONS_MAX_PREVIEWS = 8;
const OPERATIONS_MAX_ENTRIES = 100;
// run 之后的查询宽限：超过仍无结果 → 状态 unknown（不重放）。
const OPERATIONS_RESULT_WAIT_MS = 90_000;

// 目标签名与 supervisor 同一实现（lib/supervisor/tunnel-spec.mjs 是零副作用纯函数模块），
// 跨进程两侧据此共同复核目标，不再各持一份副本。
export { buildTunnelSignature as buildTargetSignature } from "./supervisor/tunnel-spec.mjs";

// 按插入序淘汰最旧的条目（Map 迭代序即插入序）。调用方总在"插入新条目之前"调用，
// 因此只留 max - 1 条，插入后正好 max 条。
function evictOldest(map, max) {
  for (const key of map.keys()) {
    if (map.size < max) break;
    map.delete(key);
  }
}

export function createOperationsRunner({
  runtimeDir,
  getConfig,
  getSnapshot,
  log = () => {},
  timeline = () => {},
  now = Date.now,
  randomUUID = nodeRandomUUID,
  previewTtlMs = OPERATIONS_PREVIEW_TTL_MS,
  maxPreviews = OPERATIONS_MAX_PREVIEWS,
  maxOperations = OPERATIONS_MAX_ENTRIES,
  resultWaitMs = OPERATIONS_RESULT_WAIT_MS,
  isChannelBusy = () => false,
  // 已受理（请求已写入信箱）时回调 { operationId, serverId }：装配层据此把操作关联到
  // 该服务器未解决的隧道/通道事件（「查看处置日志」）。回调异常被吞掉。
  onAccepted = () => {},
} = {}) {
  if (typeof getConfig !== "function" || typeof getSnapshot !== "function") {
    throw new Error("createOperationsRunner 需要 getConfig 与 getSnapshot");
  }
  const previews = new Map(); // previewId -> { action, serverId, host, targetSignature, expiresAt, configRevision }
  const operations = new Map(); // operationId -> { operationId, serverId, requestId, state, phase, status, reason, evidence, createdAt, finishedAt }
  let activeOperationId = null;

  // 预览表：先清过期，再按上限挤掉最旧的。
  function evictPreviews(ts) {
    for (const [key, entry] of previews) {
      if (entry.expiresAt <= ts) previews.delete(key);
    }
    evictOldest(previews, maxPreviews);
  }

  function evictOperations() {
    evictOldest(operations, maxOperations);
  }

  // 运行快照必须可用且声明能力，否则诚实 503——不为旧 supervisor 假装能力存在。
  function requireCapability() {
    const snapshot = getSnapshot();
    if (!snapshot || snapshot.stale) {
      throw new ControlProtocolError(503, "supervisor 运行快照不可用（旧版本守护进程或未运行），单隧道操作暂不可用");
    }
    const caps = snapshot.capabilities || {};
    if (caps.scopedTunnelRestart !== true || Number(caps.controlProtocol) < 1) {
      throw new ControlProtocolError(503, "当前 supervisor 不支持单隧道操作（controlProtocol < 1），不自动重启它来升级");
    }
    return snapshot;
  }

  function serverEntryFrom(config, serverId) {
    const servers = Array.isArray(config?.servers) ? config.servers : [];
    const server = servers.find((s) => s && s.id === serverId);
    if (!server) return null;
    return {
      id: server.id,
      host: server.host,
      remotePort: server.remotePort,
      tunnelEnabled: server.tunnel !== false,
      disabled: server.disabled === true,
      localPortConfigured: server.localPort,
    };
  }

  // 目标签名以"当前配置 + 快照的实际代理端口"为准：supervisor 的 -R 由配置推导、
  // localPort 一律钉在 effectiveProxyPort。快照里的签名是上次 reconcile 的产物，
  // 配置刚变化时它可能滞后——run 复核必须用当前配置推导，配置漂移才能被 409 拦下。
  function signatureFor(snapshot, entry) {
    if (!Number.isInteger(snapshot.effectiveProxyPort)) return null;
    return buildTargetSignature({
      host: entry.host,
      remotePort: entry.remotePort,
      localPort: snapshot.effectiveProxyPort,
    });
  }

  async function preview({ action, target } = {}) {
    if (action !== CONTROL_ACTION_RESTART_TUNNEL && action !== CONTROL_ACTION_TAKEOVER_TUNNEL) {
      throw new ControlProtocolError(400, `不支持的操作: ${String(action)}`);
    }
    const takeover = action === CONTROL_ACTION_TAKEOVER_TUNNEL;
    const serverId = target?.serverId;
    if (!BOUNDED_SERVER_ID_PATTERN.test(String(serverId || ""))) {
      throw new ControlProtocolError(400, "target.serverId 非法");
    }
    const snapshot = requireCapability();
    if (takeover && snapshot.capabilities?.siblingTakeover !== true) {
      throw new ControlProtocolError(503, "当前守护进程还不支持多台 Mac 接力（需要 v2.88 及以上），更新后再试");
    }
    const config = await getConfig();
    const entry = serverEntryFrom(config, serverId);
    if (!entry || entry.disabled) {
      throw new ControlProtocolError(404, `未知或已禁用的服务器: ${String(serverId)}`);
    }
    if (!entry.tunnelEnabled) {
      throw new ControlProtocolError(400, "该服务器声明 tunnel:false（仅监控，无隧道可重启）");
    }
    // 没领反向端口：supervisor 不为它建隧道，签名里会出现 :undefined，直接说清楚。
    if (toPort(entry.remotePort) === null) {
      throw new ControlProtocolError(400, "该服务器还没有领取反向端口（未建隧道，无隧道可重启）");
    }
    const signature = signatureFor(snapshot, entry);
    if (!signature) {
      throw new ControlProtocolError(503, "无法确定该服务器的实际隧道目标（快照缺少 effectiveProxyPort），请稍后再试");
    }
    const ts = now();
    evictPreviews(ts);
    const previewId = randomUUID();
    const expiresAt = ts + previewTtlMs;
    const configRevision = snapshot.configRevision || "";
    previews.set(previewId, { action, serverId, host: entry.host, targetSignature: signature, expiresAt, configRevision });
    return {
      previewId,
      action,
      capabilityVersion: 1,
      target: { serverId, host: entry.host, remotePort: entry.remotePort },
      // 影响范围由后端计算：只重建该服务器的隧道；共享代理与其它服务器不受影响，
      // 但该服务器正在经过隧道的连接会中断。
      impact: {
        serverIds: [serverId],
        otherServersAffected: false,
        sharedProxyRestarted: false,
        existingStreamsMayClose: true,
        description: takeover
          ? `让这台电脑承载 ${serverId} 的反向端口 ${entry.remotePort}：同账号另一台 Mac 的隧道会让位并转为待命，集群上正在经它的连接会断开一次后重连。`
          : `仅重启 ${serverId} 的 SSH 反向隧道；本地代理进程与其它服务器的隧道保持运行。`,
      },
      steps: takeover
        ? [
          { key: "queued", label: "写入控制信箱" },
          { key: "executing", label: "让另一台 Mac 让位并在本机建隧道" },
          { key: "verifying", label: "验证监听与归属" },
        ]
        : [
          { key: "queued", label: "写入控制信箱" },
          { key: "executing", label: "重启该隧道" },
          { key: "verifying", label: "验证监听与归属" },
        ],
      notes: [
        "执行的是预览时冻结的目标签名；配置或目标变化后 run 会拒绝并要求重新预览。",
        "202 只表示已受理；最终状态以操作查询结果为准（succeeded / failed / unknown）。",
      ],
      expiresAt,
    };
  }

  // trigger:"auto"（v2.64）：自动修复发起的单隧道重启。只给日志 / 时间线打 trigger / ruleId
  // 字段（前端据此加「自动」徽标），流程与手动完全相同。
  async function run({ previewId, operationId, trigger, ruleId } = {}) {
    if (activeOperationId) {
      throw new ControlProtocolError(409, "已有单隧道操作在执行（同一时间只允许一个有副作用的操作）");
    }
    if (typeof isChannelBusy === "function" && isChannelBusy()) {
      throw new ControlProtocolError(409, "通道修复进行中，请等它结束后再执行单隧道操作");
    }
    const ts = now();
    // 先查过期再清理：预览过期要返回明确的 410（而不是被 evict 吞成 404）。
    const entry = previews.get(String(previewId || ""));
    if (!entry) throw new ControlProtocolError(404, "预览不存在，请重新打开预览");
    if (entry.expiresAt <= ts) {
      previews.delete(String(previewId));
      throw new ControlProtocolError(410, "预览已过期，请重新打开预览");
    }
    evictPreviews(ts);
    // 运行前重新核对：快照仍有效、目标签名未变（配置热载/切目标 → 409）。
    const snapshot = requireCapability();
    const config = await getConfig();
    const serverEntry = serverEntryFrom(config, entry.serverId);
    if (!serverEntry || serverEntry.disabled) {
      previews.delete(String(previewId));
      throw new ControlProtocolError(409, "目标服务器已从配置移除或禁用，动作不执行");
    }
    const currentSignature = signatureFor(snapshot, serverEntry);
    if (!currentSignature || currentSignature !== entry.targetSignature) {
      previews.delete(String(previewId));
      throw new ControlProtocolError(409, "目标配置已变化，旧预览不会改指新目标；请重新预览");
    }
    previews.delete(String(previewId));

    const opId = String(operationId || randomUUID());
    const requestId = randomUUID();
    const request = buildControlRequest({
      requestId,
      operationId: opId,
      instanceId: snapshot.instanceId,
      action: entry.action ?? CONTROL_ACTION_RESTART_TUNNEL,
      serverId: entry.serverId,
      targetSignature: entry.targetSignature,
      createdAt: ts,
      expiresAt: ts + CONTROL_REQUEST_TTL_MS,
    });
    try {
      await writeControlRequest({ runtimeDir, request });
    } catch (err) {
      if (err instanceof ControlProtocolError) throw err;
      throw new ControlProtocolError(503, `控制信箱写入失败: ${String(err?.message || err).slice(0, 120)}`);
    }
    evictOperations();
    // 只给日志字段用，不进 serializeOperation（查询接口形状不变）。
    const autoTag = trigger === "auto" ? { ruleId: typeof ruleId === "string" && ruleId ? ruleId : undefined } : null;
    // 日志 / 时间线里的动作名：接力单独叫 takeover，其余沿用 scoped-restart（前端处置日志按它认）。
    const verb = entry.action === CONTROL_ACTION_TAKEOVER_TUNNEL ? "takeover" : "scoped-restart";
    const operation = {
      operationId: opId,
      requestId,
      serverId: entry.serverId,
      verb,
      autoTag,
      state: "queued",
      phase: "queued",
      status: null,
      reason: "",
      evidence: {},
      instanceId: snapshot.instanceId,
      createdAt: ts,
      finishedAt: null,
    };
    operations.set(opId, operation);
    activeOperationId = opId;
    log(`operation ${opId} ${verb} ${entry.serverId} queued (requestId=${requestId})`, {
      event: "scoped-operation",
      operationId: opId,
      serverId: entry.serverId,
      requestId,
      ...(autoTag ? { trigger: "auto", ruleId: autoTag.ruleId } : {}),
    });
    timeline("info", `${verb} ${entry.serverId}: queued`, {
      operationId: opId,
      serverId: entry.serverId,
      event: "scoped-operation",
      ...(autoTag ? { trigger: "auto", ruleId: autoTag.ruleId } : {}),
    });
    try {
      onAccepted({ operationId: opId, serverId: entry.serverId, ...(autoTag ? { trigger: "auto" } : {}) });
    } catch {}
    watchOperation(operation);
    return { operationId: opId, previewId: String(previewId), state: "queued" };
  }

  // 后台监视：queued → executing（请求被认领）→ 终态（结果文件）。不重放、不重试。
  function watchOperation(operation) {
    const startedAt = now();
    const timer = setInterval(async () => {
      if (!operations.has(operation.operationId)) {
        clearInterval(timer);
        return;
      }
      if (operation.state === "queued") {
        const stillQueued = await isRequestPending(operation).catch(() => null);
        if (stillQueued === false) {
          operation.state = "executing";
          operation.phase = "executing";
          log(`operation ${operation.operationId} phase=executing`, {
            event: "scoped-operation",
            operationId: operation.operationId,
            serverId: operation.serverId,
          });
        }
      }
      const result = await readControlResult(runtimeDir, operation.instanceId, operation.requestId).catch(() => null);
      if (result) {
        applyResult(operation, result);
        clearInterval(timer);
        return;
      }
      if (now() - startedAt > resultWaitMs) {
        operation.state = "unknown";
        operation.phase = operation.phase === "queued" ? "queued" : "verifying";
        operation.reason = "查询超时：结果不确定，请核实隧道状态后决定是否重试";
        operation.finishedAt = now();
        activeOperationId = null;
        clearInterval(timer);
        log(`operation ${operation.operationId} result=unknown (query timeout, no replay)`, {
          level: "warn",
          event: "scoped-operation",
          operationId: operation.operationId,
          serverId: operation.serverId,
        });
      }
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function isRequestPending(operation) {
    const requestsDir = path.join(controlDir(runtimeDir, operation.instanceId), "requests");
    const names = await readdir(requestsDir).catch(() => []);
    return names.includes(`${operation.requestId}.json`);
  }

  function applyResult(operation, result) {
    operation.status = result.status;
    operation.phase = result.phase || "verifying";
    operation.reason = result.reason || "";
    operation.evidence = result.evidence || {};
    operation.finishedAt = now();
    operation.state = result.status === "succeeded"
      ? "succeeded"
      : result.status === "failed"
        ? "failed"
        : "unknown";
    if (activeOperationId === operation.operationId) activeOperationId = null;
    const autoFields = operation.autoTag ? { trigger: "auto", ruleId: operation.autoTag.ruleId } : {};
    log(`operation ${operation.operationId} ${operation.verb || "scoped-restart"} ${operation.serverId} result=${operation.status === "succeeded" ? "ok" : "fail"}${operation.reason ? ` (${operation.reason})` : ""}`, {
      event: "scoped-operation",
      operationId: operation.operationId,
      serverId: operation.serverId,
      status: operation.status,
      level: operation.state === "succeeded" ? "info" : "warn",
      ...autoFields,
    });
    timeline(operation.state === "succeeded" ? "info" : "warn", `${operation.verb || "scoped-restart"} ${operation.serverId}: ${operation.state}`, {
      event: "scoped-operation",
      operationId: operation.operationId,
      serverId: operation.serverId,
      status: operation.status,
      reason: operation.reason,
      ...autoFields,
    });
  }

  async function getOperation(operationIdInput) {
    const opId = String(operationIdInput || "");
    if (!opId) return null;
    const live = operations.get(opId);
    if (live) {
      // queued/executing 的实时态再查一次结果文件（可能刚落盘）。
      if (live.state === "queued" || live.state === "executing") {
        const result = await readControlResult(runtimeDir, live.instanceId, live.requestId).catch(() => null);
        if (result) applyResult(live, result);
      }
      return serializeOperation(live);
    }
    // monitor 重启后内存表已空：从信箱结果目录找回已验证结果（A20）。
    const snapshot = getSnapshot();
    if (snapshot?.instanceId) {
      const recovered = await findControlResultByOperationId(runtimeDir, snapshot.instanceId, opId).catch(() => null);
      if (recovered) {
        const recoveredOp = {
          operationId: opId,
          requestId: recovered.requestId,
          serverId: recovered.serverId,
          state: recovered.status === "succeeded" ? "succeeded" : recovered.status === "failed" ? "failed" : "unknown",
          phase: recovered.phase || "verifying",
          status: recovered.status,
          reason: recovered.reason || "",
          evidence: recovered.evidence || {},
          instanceId: snapshot.instanceId,
          createdAt: recovered.startedAt,
          finishedAt: recovered.finishedAt,
          recoveredAfterRestart: true,
        };
        return serializeOperation(recoveredOp);
      }
    }
    return null;
  }

  function serializeOperation(operation) {
    return {
      operationId: operation.operationId,
      serverId: operation.serverId,
      state: operation.state,
      phase: operation.phase,
      status: operation.status,
      reason: operation.reason,
      evidence: operation.evidence,
      createdAt: operation.createdAt,
      finishedAt: operation.finishedAt,
      ...(operation.recoveredAfterRestart ? { recoveredAfterRestart: true } : {}),
      ...(operation.state === "succeeded" && !operation.evidence.endToEndVerified
        ? { note: "进程与监听已核实；端到端连通性以探针结果为准" }
        : {}),
    };
  }

  return {
    preview,
    run,
    getOperation,
    isInFlight: () => activeOperationId !== null,
  };
}
