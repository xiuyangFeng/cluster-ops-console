// incidents/disposition.mjs —— 处置记录（纯函数）：一次处置操作（一键修复 / 单隧道重启，手动或自动修复）
// 受理时记在它处置的未解决事件上，之后按真实恢复采样给出结果——闭环「点了修复 → 到底好了没有」。
//
// 记录形状（事件的 dispositions 数组，最多 DISPOSITION_MAX 条，最旧在前）：
//   { operationId, at, action: "restart-channel" | "restart-tunnel", trigger: "manual" | "auto",
//     outcome: null（等待复核）| "recovered" | "not-recovered" | "recovered-late", settledAt, afterMs }
// 结果只由事实驱动：事件关闭（连续两次成功采样）时，等待复核的记 recovered、已判「未恢复」的改记
// recovered-late（如实说明不是这次处置立刻见效）；受理后过了复核时限仍未恢复记 not-recovered。
// afterMs = 处置受理到事件恢复的毫秒数（未恢复时为 null）。不推断、不改故障事实。

export const DISPOSITION_MAX = 8;
// 复核时限：重启后 supervisor 10–40 秒内重连，恢复判定还要连续两次成功采样（非活跃服务器 60 秒一拍）；
// 3 分钟仍未关闭就如实判「未恢复」，引导去看排障信息而不是反复点修复。
export const DISPOSITION_VERIFY_MS = 3 * 60 * 1000;

const ACTIONS = new Set(["restart-channel", "restart-tunnel"]);
const OUTCOMES = new Set(["recovered", "not-recovered", "recovered-late"]);
const finite = (value) => (Number.isFinite(value) ? value : null);

function normalizeOne(raw) {
  if (!raw || typeof raw !== "object") return null;
  const operationId = typeof raw.operationId === "string" ? raw.operationId.slice(0, 64) : "";
  const at = finite(raw.at);
  if (!operationId || at == null) return null;
  return {
    operationId,
    at,
    action: ACTIONS.has(raw.action) ? raw.action : "restart-channel",
    trigger: raw.trigger === "auto" ? "auto" : "manual",
    outcome: OUTCOMES.has(raw.outcome) ? raw.outcome : null,
    settledAt: finite(raw.settledAt),
    afterMs: finite(raw.afterMs),
  };
}

// 读回 / 对端数据：逐条校验，畸形的丢掉，只留最近 DISPOSITION_MAX 条。
export function normalizeDispositions(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeOne).filter(Boolean).slice(-DISPOSITION_MAX);
}

// 追加一条处置（同一 operationId 只记一次）。返回新数组；没变化时返回原数组（调用方据此判断要不要落盘）。
export function addDisposition(list, { operationId, at, action, trigger } = {}) {
  const current = Array.isArray(list) ? list : [];
  const entry = normalizeOne({ operationId, at, action, trigger });
  if (!entry || current.some((item) => item.operationId === entry.operationId)) return current;
  return [...current, entry].slice(-DISPOSITION_MAX);
}

// 事件恢复：等待复核的记 recovered，已判未恢复的改记 recovered-late。返回 { list, changed }。
export function settleOnRecovery(list, at) {
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map((item) => {
    if (item.outcome !== null && item.outcome !== "not-recovered") return item;
    if (!Number.isFinite(at) || at < item.at) return item;
    changed = true;
    return { ...item, outcome: item.outcome === null ? "recovered" : "recovered-late", settledAt: at, afterMs: at - item.at };
  });
  return { list: changed ? next : list, changed };
}

// 复核到时：受理满 verifyMs 仍在等待复核的记 not-recovered。返回 { list, changed }。
export function expireDispositions(list, at, { verifyMs = DISPOSITION_VERIFY_MS } = {}) {
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map((item) => {
    if (item.outcome !== null || !Number.isFinite(at) || at - item.at < verifyMs) return item;
    changed = true;
    return { ...item, outcome: "not-recovered", settledAt: at, afterMs: null };
  });
  return { list: changed ? next : list, changed };
}

// 还在等待复核的处置（有则调用方定时调 expireDispositions）。
export const hasPendingDisposition = (list) => (Array.isArray(list) ? list : []).some((item) => item.outcome === null);
