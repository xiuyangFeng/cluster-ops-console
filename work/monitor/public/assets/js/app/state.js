// app/state.js —— 控制台前端的数据状态：最近一次 /api/status 与 /api/config。
//
// 无 DOM（Node 可直接 import 测试）。所有控制器都经它读"当前状态"，不再各自持有
// lastStatus / currentConfig 副本；写入只有两处：app.js 的 render()（status）与
// server-switch 的 loadServers()（config）。方法都是闭包，可以脱离对象单独传递。
export function createAppState() {
  let status = null;
  let config = null;
  return {
    getStatus: () => status,
    getConfig: () => config,
    setStatus(next) {
      status = next;
    },
    setConfig(next) {
      config = next;
    },
    // "正在查看哪台"：以运行状态为准，状态未到时回落配置里的选择（与 connection-target
    // 的 resolveCurrentTarget 同一规则）。
    activeServerId() {
      return status?.activeServerId || config?.activeServerId || "";
    },
  };
}
