// Coalesce routine reads, but never lose a refresh requested after a mutation.
// A forced refresh invalidates an older in-flight response before it can render.
//
// watchdogMs 是兜底：若 load() 因任何原因永不结算（api.js 已有请求超时，这里防的是
// load 自身实现里的悬挂），队列会永久卡死——inFlight 永不为 null，之后所有 refresh()
// 只是返回同一个 pending promise，onError/commit 都不执行，呈现为无提示的假死数据。
// 看门狗到点后释放队列并报错；迟到的结果用 stale 标记作废，避免"旧值盖新值"。
const DEFAULT_REFRESH_WATCHDOG_MS = 20000;

export function createRefreshQueue({ load, commit, onError = () => {}, watchdogMs = DEFAULT_REFRESH_WATCHDOG_MS }) {
  let inFlight = null;
  let rerun = false;
  return function refresh({ force = false } = {}) {
    if (inFlight) {
      if (force) rerun = true;
      return inFlight;
    }
    let stale = false;
    const watchdog = watchdogMs > 0
      ? setTimeout(() => {
          stale = true;
          const error = new Error(`refresh watchdog timeout after ${watchdogMs}ms`);
          error.timeout = true;
          inFlight = null;
          onError(error);
        }, watchdogMs)
      : null;
    if (watchdog && typeof watchdog.unref === "function") watchdog.unref();

    const run = Promise.resolve().then(async () => {
      do {
        rerun = false;
        try {
          const value = await load();
          if (!rerun && !stale) commit(value);
        } catch (error) {
          if (!rerun && !stale) onError(error);
        }
      } while (rerun && !stale);
    });
    inFlight = run;
    run
      .finally(() => {
        if (watchdog) clearTimeout(watchdog);
        // 只清理自己这一次：看门狗可能已释放队列并被新一轮 refresh 接管。
        if (inFlight === run) inFlight = null;
      })
      .catch(() => {});
    return run;
  };
}
