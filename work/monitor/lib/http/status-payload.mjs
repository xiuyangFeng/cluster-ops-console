// 状态载荷合成：/api/status 全量、以及 SSE status 帧与 /api/status 共用的旁路字段补挂。
//
// 键序是协议的一部分（status-payload.contract.test.mjs 金样锁定）：
//   /api/status = legacy 字段 → layers → version → connectionTargets → runtimeExtras → storage
//   SSE status  = { lite: lite + runtimeExtras + storage, layers }
// /api/status-lite 不经这里（直接是 store.getLiteStatus()，不补挂旁路字段）。
export function createStatusPayload({ store, version, storageSweeper, getRuntimeExtras, getConnectionTargets }) {
  // v2.18 本地数据预算：storage 是 /api/status 与 SSE lite 的顶层可选字段
  // （设计 §6.3）。挂在载荷合成处而不是 state-store 内部，是因为占用量不参与任何
  // 健康推导——它是旁路观测数据，塞进 layers 只会把探针状态机和磁盘统计耦在一起。
  // getState() 是纯内存读（sweeper 只在定时/手动 sweep 时碰盘），可以放心地在每次
  // 状态推送上调用。取值失败时整个字段消失，不拦状态接口。
  function storageState() {
    try {
      return storageSweeper.getState();
    } catch {
      return null;
    }
  }

  // v2.18 L2 自动修复的旁路字段（设计 §6.7）：autoRepairExhausted / tunnelPortForeign /
  // autoRepair，与 storage 同一层合成、同样不进 state-store 的层级模型。取值抛错（或不是
  // 对象）时整组字段消失，不拦状态接口。
  function runtimeExtras() {
    try {
      const extras = getRuntimeExtras();
      return extras && typeof extras === "object" ? extras : null;
    } catch {
      return null;
    }
  }

  function withStorage(payload) {
    if (!payload || typeof payload !== "object") return payload;
    const storage = storageState();
    const extras = runtimeExtras();
    if (!storage && !extras) return payload;
    return { ...payload, ...(extras || {}), ...(storage ? { storage } : {}) };
  }

  function getStatusPayload() {
    // getLayers 只构建一次并显式注入。此前写成
    //   { ...store.getLegacyStatus(), layers: store.getLayers() }
    // 而 getLegacyStatus 内部（经 getSummary）本来就要用 layers —— 同一棵五层对象
    //（通道/Agent/隧道/资源/信号 + 派生字段）每次请求被完整构建两遍。该接口是前端
    // 5-10s 轮询与每次 SSE 建连的必经之路，是最热的读路径。
    const layers = store.getLayers();
    const payload = { ...store.getLegacyStatus({ layers }), layers, version };
    // T01：supervisor 运行快照投影。快照不可用（旧 supervisor/过期/归属失败）时
    // 投影本身已是 config-only 降级形状，前端据此把端口标为"配置值"。
    try {
      payload.connectionTargets = getConnectionTargets();
    } catch {
      // 投影失败不拦状态接口。
    }
    return withStorage(payload);
  }

  // SSE status 帧。lite 由 state-store 随 STATUS_CHANGED 事件发布；storage 等旁路字段
  // 在此按同一契约补挂，让 SSE 与 /api/status 两条通路的字段完全一致（前端只需一套读取逻辑）。
  function statusFrame({ layers, lite }) {
    return { lite: withStorage(lite), layers };
  }

  // 建连首帧：layers 与 lite 共用同一份快照（getLiteStatus 内部会用到它），不重复构建。
  function initialStatusFrame() {
    const layers = store.getLayers();
    return statusFrame({ layers, lite: store.getLiteStatus({ layers }) });
  }

  return { getStatusPayload, statusFrame, initialStatusFrame };
}
