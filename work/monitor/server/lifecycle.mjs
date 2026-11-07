// 进程生命周期：SIGTERM/SIGINT 优雅退出 + 进程级异常兜底。

import { flushAllLoggers } from "../lib/logger.mjs";

// 正常退出先停止采样并排干异步日志/指标写入，再结束进程。顺序即契约：
// 停摄事件（HTTP 同步转 503）→ 关监听 → 停调度 → 给服务直达的转发 ssh 发 SIGTERM → 排干在途请求 →
// 服务收尾 → 确认转发 ssh 已退出 → 指标落盘 → 事件最终落盘
// （排在所有在途保存之后，避免旧快照覆盖删除/恢复后的最终状态）→ 历史 → 存储清理 →
// 日志排干 → 自建 vault → exit(0)。重复信号只执行一次。
// 转发 ssh（lib/daemons/forwards.mjs）分两步收：SIGTERM 是同步的，赶在排干之前发——排干可能被一次慢 SSH
// 拖住，而桌面壳只给 1.5 秒就强杀本进程；来不及确认的留着登记，下次启动按进程注册表清。
export function createShutdown({
  incidentSync,
  httpServer,
  scheduler,
  localResourceProbe,
  metricsStore,
  historyStore,
  storage,
  credentials,
  serviceForwards = null,
  flushServices = async () => {},
  flushLoggers = flushAllLoggers,
  exit = (code) => process.exit(code),
}) {
  let shuttingDown = false;
  // 信号处理器会把信号名（字符串）当第一个参数传进来；只有显式传 { exitCode } 才改退出码
  // （自更新的「请把我重新拉起来」，见 lib/self-update/restart-code.mjs）。
  return async function shutdown(options) {
    if (shuttingDown) return;
    shuttingDown = true;
    const exitCode = Number.isInteger(options?.exitCode) ? options.exitCode : 0;
    incidentSync.beginShutdown(); // 停止排期；最终落盘在下方排干在途保存后进行
    httpServer.server.close();
    httpServer.server.closeAllConnections();
    scheduler.stop();
    localResourceProbe.dispose();
    try { serviceForwards?.beginShutdown(); } catch {}
    await httpServer.drainPendingRequests();
    try { await flushServices(); } catch {}
    try { await serviceForwards?.dispose(); } catch {}
    try {
      await metricsStore.dispose();
    } catch {}
    try {
      await incidentSync.close();
    } catch {}
    try {
      historyStore.dispose();
    } catch {}
    try {
      storage.stopSweeper(); // 退出途中不再启动新的删除轮次
    } catch {}
    try { await flushLoggers(); } catch {}
    credentials.closeOwnedVault();
    exit(exitCode);
  };
}

export function registerShutdownSignals(shutdown) {
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, shutdown);
}

// 进程级兜底（风格对齐 channel-supervisor.mjs 的 crashGuard 注册）：monitor 是守护面，
// 任何漏网的同步异常 / 未处理 rejection 只记日志不退出——宁可带伤运行也不能静默消失，
// 否则守护循环与探针调度一起蒸发，通道故障将无人修复也无人上报。
export function registerProcessGuards({ appendLog }) {
  process.on("uncaughtException", (err) => {
    try {
      appendLog(`uncaughtException: ${err?.stack || err?.message || String(err)}`, { level: "error" });
    } catch {}
  });
  process.on("unhandledRejection", (err) => {
    try {
      appendLog(`unhandledRejection: ${err?.stack || err?.message || String(err)}`, { level: "error" });
    } catch {}
  });
}
