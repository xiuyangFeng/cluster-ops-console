// ---------------------------------------------------------------------------
// A7 进程级兜底：spawn 失败经 'error' 事件异步抛出（已在两个控制器的 attachHandlers
// 里用 child.on('error') 接住，走既有 death 路径，"永不 reject"）。这里补最后一道防线。
//
// 两类致命信号的处理必须分开：
//   uncaughtException —— 同步异常穿透了调用栈，进程状态不可信；沿用"先同步 kill 已登记
//     子进程再 exit(1)"，避免 supervisor 带病继续运行。
//   unhandledRejection —— 只是一个没人接的 promise 失败了，不构成"进程不可继续"的证据。
//     此前它走的是同一条杀子进程 + exit(1) 的路径，代价是全部 SSH 隧道与本地代理一起
//     被拆掉（整段中断），收益只是"重启一次"。这与本项目刻意设计的交接/接管机制
//     （performHandoffExit 明确"leaving tunnels and local proxy running for the next
//     supervisor"，以及 startAdoption/stopAdopted 的接管路径）方向相反。
//     现在：单次 rejection 只记日志、不动任何进程；只有同一窗口内出现"rejection 风暴"
//     （系统性损坏的强信号）才按致命处理。
// ---------------------------------------------------------------------------
const CRASH_GUARD_REJECTION_STORM_WINDOW_MS = 60_000;
const CRASH_GUARD_REJECTION_STORM_THRESHOLD = 20;

export function createCrashGuard({
  getChildren = () => [],
  log: logImpl = () => {},
  exitImpl = process.exit,
  now = Date.now,
  rejectionStormWindowMs = CRASH_GUARD_REJECTION_STORM_WINDOW_MS,
  rejectionStormThreshold = CRASH_GUARD_REJECTION_STORM_THRESHOLD,
} = {}) {
  let windowStartedAt = now();
  let rejectionsInWindow = 0;

  return function handleFatal(kind, err) {
    try {
      logImpl(`${kind}: ${err?.stack ? err.stack : err}`);
    } catch {
      // 日志失败也不能阻塞兜底退出流程
    }

    if (kind === "unhandledRejection") {
      if (now() - windowStartedAt > rejectionStormWindowMs) {
        windowStartedAt = now();
        rejectionsInWindow = 0;
      }
      rejectionsInWindow += 1;
      if (rejectionsInWindow < rejectionStormThreshold) {
        try {
          logImpl(
            `unhandledRejection 已记录并忽略（本窗口第 ${rejectionsInWindow}/${rejectionStormThreshold} 次）；` +
              "不杀子进程、不退出：单次未处理的 rejection 不足以证明进程不可继续，而杀掉子进程会中断全部隧道",
          );
        } catch {}
        return;
      }
      try {
        logImpl(`unhandledRejection 风暴：${rejectionStormWindowMs}ms 内累计 ${rejectionsInWindow} 次，按致命处理`);
      } catch {}
    }

    let children = [];
    try {
      children = getChildren() || [];
    } catch {
      children = [];
    }
    for (const child of children) {
      if (child?.pid && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // 已经在处理致命错误的路径上，杀不掉也不能再抛
        }
      }
    }
    exitImpl(1);
  };
}
