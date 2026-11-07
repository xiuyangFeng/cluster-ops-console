// 链路阶段遥测（bridge stage）：把代理/隧道控制器每拍上报的局部事件归并成快照，
// 按"状态变化或心跳到期"写进 supervisor 结构化日志——monitor 只从日志摄取这些快照。
const BRIDGE_HEARTBEAT_MS = 60000;

export function reduceBridgeStage(previous, event, nowMs = Date.now()) {
  const prior = previous && previous.stage === event.stage ? previous : {};
  const ok = event.ok === true;
  const snapshot = {
    stage: String(event.stage || "unknown").slice(0, 64),
    ok,
    durationMs: Math.max(0, Number(event.durationMs) || 0),
    consecutiveFailures: ok ? 0 : Math.max(0, Number(prior.consecutiveFailures) || 0) + 1,
    lastSuccessAt: ok ? nowMs : (prior.lastSuccessAt ?? null),
  };
  for (const [field, deltaField] of [["checks", "checkDelta"], ["restarts", "restartDelta"], ["reconnects", "reconnectDelta"], ["fastFailures", "fastFailureDelta"]]) {
    const value = Math.max(0, Number(prior[field]) || 0) + Math.max(0, Number(event[deltaField]) || 0);
    if (value || field in prior || event[deltaField] != null) snapshot[field] = value;
  }
  if (event.backoffUntil != null || "backoffRemainingMs" in prior) {
    snapshot.backoffRemainingMs = Math.max(0, (Number(event.backoffUntil) || 0) - nowMs);
  }
  // 孤儿接管的两个判定要透传给 state-store / 前端。
  // adopted 是一次性事件（"这一拍认领了一条孤儿"），下一拍即落回 false；
  // foreign 是持续状态（端口被别人占着，直到有人换端口），必须粘住——退避期里每一拍
  // emitStage 都不带它，不粘住就只有一拍能被看见，1s 轮询的前端必然错过。ok 即清除。
  // 两者一旦出现过就恒在快照里（哪怕是 false）：state-store.ingestBridgeStage 是**合并**
  // 语义，省略字段等于沿用旧值，一次 adopted:true 会永远粘在 /api/status 上。
  if (event.adopted === true || "adopted" in prior) snapshot.adopted = event.adopted === true;
  // 待命（同账号另一台 Mac 在承载，v2.88）不是异己占用：同时清掉粘住的 foreign。
  const standby = ok ? null : (event.standby && typeof event.standby === "object" ? event.standby : null);
  const foreign = ok || standby ? false : (event.foreign === true || prior.foreign === true);
  if (foreign || "foreign" in prior) snapshot.foreign = foreign;
  if (standby || "standby" in prior) snapshot.standby = standby ? { since: standby.since ?? null, reason: standby.reason ?? null, peer: standby.holder?.label ?? null } : null;
  if (["verified", "unverified", "changed", "blocked"].includes(event.configIdentityState)) {
    snapshot.configIdentityState = event.configIdentityState;
    snapshot.configApplied = event.configApplied === true;
  } else if (prior.configIdentityState) {
    snapshot.configIdentityState = prior.configIdentityState;
    snapshot.configApplied = prior.configApplied === true;
  }
  // 最近一次 SSH 失败归因（classifySshFailure 的 {code,nextAction} + at）：粘性语义同 foreign——
  // 退避期的 emitStage 不带它也要沿用，ok 即清空；一旦出现过就恒在快照里（null 表示已恢复），
  // 否则 state-store 的合并语义会让旧失败永远粘在 /api/status 上。
  // 事件显式带了 sshFailure 键（哪怕是 null）= 这是一次新失败的"本次归因"，以它为准、不回落旧值：
  // 否则上一轮的 auth 会粘在之后所有无法归类的断线上，误导用户去重跑向导。
  const sshFailure = ok
    ? null
    : ("sshFailure" in event ? normalizeSshFailure(event.sshFailure) : (prior.sshFailure || null));
  if (sshFailure || "sshFailure" in prior) snapshot.sshFailure = sshFailure;
  return snapshot;
}

function normalizeSshFailure(value) {
  if (!value || typeof value !== "object" || typeof value.code !== "string" || !value.code) return null;
  return {
    code: value.code.slice(0, 32),
    nextAction: typeof value.nextAction === "string" ? value.nextAction.slice(0, 200) : "",
    at: Number.isFinite(Number(value.at)) ? Number(value.at) : null,
  };
}

export function shouldLogBridgeSnapshot(previous, snapshot, nowMs = Date.now(), heartbeatMs = BRIDGE_HEARTBEAT_MS) {
  if (!previous) return true;
  if (nowMs - previous.loggedAt >= heartbeatMs) return true;
  const before = previous.snapshot || {};
  return ["stage", "ok", "restarts", "reconnects", "fastFailures", "configIdentityState", "configApplied"]
    .some((field) => before[field] !== snapshot[field])
    || Boolean(before.standby) !== Boolean(snapshot.standby)
    || (before.sshFailure?.code ?? null) !== (snapshot.sshFailure?.code ?? null);
}

// 多隧道后 stage 不再唯一：N 台服务器都发 stage:"ssh-tunnel"，只按 stage 做键会让
// 各自的重连/失败计数互相覆盖。键改成 stage+serverId，snapshot.stage 保持 "ssh-tunnel"
// 不变（前端/日志的既有字段语义不动），额外带 serverId 供下游按服务器归类。
function bridgeStageKey(event) {
  return event.serverId ? `${event.stage}#${event.serverId}` : String(event.stage);
}

// 每个 supervisor 实例一份阶段表。getChannelServerId 是 getter（活跃服务器随配置变化），
// 每次上报时现读，不在构造时冻结。
export function createBridgeStageEmitter({ log = () => {}, getChannelServerId = () => null } = {}) {
  const bridgeStages = new Map();
  const bridgeLogState = new Map();

  return function emitBridgeStage(event) {
    const nowMs = Date.now();
    const key = bridgeStageKey(event);
    const snapshot = reduceBridgeStage(bridgeStages.get(key), event, nowMs);
    if (event.serverId) snapshot.serverId = event.serverId;
    const currentServerId = getChannelServerId();
    if (currentServerId) snapshot.channelServerId = currentServerId;
    bridgeStages.set(key, snapshot);
    const previousLog = bridgeLogState.get(key);
    if (shouldLogBridgeSnapshot(previousLog, snapshot, nowMs)) {
      bridgeLogState.set(key, { snapshot, loggedAt: nowMs });
      log("bridge stage snapshot", { bridgeStage: snapshot });
    }
    return snapshot;
  };
}
