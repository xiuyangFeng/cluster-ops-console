// 桥接阶段快照（status-lite.bridgeStages / /api/status.bridgeStages）：supervisor 自检把
// 数据通路四段各自的耗时 / 连续失败 / 最近成功时刻推上来，state-store 合并保存。

export const BRIDGE_STAGE_ORDER = ["local-proxy", "ssh-tunnel", "remote-port", "agent-endpoint"];

export function createBridgeStages() {
  return Object.fromEntries(BRIDGE_STAGE_ORDER.map((stage) => [stage, {
    stage, ok: false, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: null,
  }]));
}

// 把一份快照**合并**进 stages（未出现的字段保留旧值）；非法/未知阶段返回 false 不动。
// 深拷贝一遍：快照对象来自 IPC/事件载荷，不能与调用方共享可变引用。
export function mergeBridgeSnapshot(stages, snapshot) {
  if (!snapshot || typeof snapshot.stage !== "string" || !snapshot.stage) return false;
  const stage = snapshot.stage.slice(0, 64);
  if (!BRIDGE_STAGE_ORDER.includes(stage)) return false;
  stages[stage] = JSON.parse(JSON.stringify({ ...stages[stage], ...snapshot, stage }));
  return true;
}

// 对外输出一律给副本，调用方改动不回写内部状态。
export function copyBridgeStages(stages) {
  return Object.fromEntries(Object.entries(stages).map(([stage, value]) => [stage, { ...value }]));
}
