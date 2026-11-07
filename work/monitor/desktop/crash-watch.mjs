// crash-watch.mjs —— 桌面壳自己出问题时看得见（v2.64）。
//
//   - 主进程未捕获异常 / 未处理 rejection：写 runtime/logs/desktop.ndjson（带栈），照常运行——与 monitor-server
//     （server/lifecycle.mjs 的 registerProcessGuards）同一取向：宁可带伤运行，也不静默消失。
//     接住它们之后 Electron 自带的「A JavaScript error occurred in the main process」框不再出现：启动期（app 还没
//     ready、或还没有主窗口）出错时改由这里弹一次简短的错误框（标题 + 首行消息 + 日志位置），免得既没窗口也没提示；
//     有了主窗口之后只记日志。
//   - 窗口的渲染进程没了（render-process-gone）：记原因与退出码；不是正常退出（clean-exit）就自动重新加载。
//     5 分钟内超过 3 次不再自动重载：主窗口弹框给「重新加载」，悬浮岛直接关掉（下次点托盘重建）。
//     退出 / 重启界面途中的不处理。
//   - 窗口无响应 / 恢复响应：记日志，恢复时带卡住多久。
//   - GPU 等子进程没了（child-process-gone）：记日志。
//
// 开机自启时主进程的标准输出被丢弃（LaunchAgent 指向 /dev/null），这些只有写进结构化日志才看得见。
// 不 import electron：dialog / app / 窗口都由入口注入，node:test 用假对象驱动。
import path from "node:path";

export const RENDERER_RELOAD_WINDOW_MS = 5 * 60_000;
export const RENDERER_MAX_AUTO_RELOADS = 3;
export const RENDERER_RELOAD_DELAY_MS = 1000;
export const STARTUP_ERROR_TITLE = "集群运维工作台启动时出错";

const WINDOW_LABELS = { main: "主窗口", island: "悬浮岛" };

// 近 windowMs 内的异常退出次数；第 maxReloads 次（含）以内自动重载，再多就停。
export function createReloadBudget({ windowMs = RENDERER_RELOAD_WINDOW_MS, maxReloads = RENDERER_MAX_AUTO_RELOADS, now = Date.now } = {}) {
  const crashes = [];
  function record() {
    const ts = now();
    crashes.push(ts);
    while (crashes.length && ts - crashes[0] > windowMs) crashes.shift();
    return crashes.length <= maxReloads ? "reload" : "give-up";
  }
  return { record, count: () => crashes.length };
}

// 异常 → 日志字段。throw 的不一定是 Error（字符串、对象都可能）。
export function describeError(err) {
  if (err instanceof Error) {
    return { name: err.name, message: String(err.message ?? "").slice(0, 2000), stack: String(err.stack ?? "").slice(0, 8000) };
  }
  let message;
  try {
    message = typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    message = String(err);
  }
  return { name: typeof err, message: String(message ?? "").slice(0, 2000), stack: "" };
}

// 启动期错误框的正文：首行消息（≤ 200 字）+ 日志位置。
export function startupErrorText(message, logFile) {
  const first = String(message ?? "").split("\n").find((line) => line.trim())?.trim() || "未知错误";
  return `${first.length > 200 ? `${first.slice(0, 200)}…` : first}\n\n详细经过（含调用栈）已记在：\n${logFile}`;
}

export function createCrashWatch({
  ctx,
  app = null, // 只用 isReady()：判断还在不在启动期
  dialog,
  logger,
  now = Date.now,
  timers = globalThis,
  windowMs = RENDERER_RELOAD_WINDOW_MS,
  maxReloads = RENDERER_MAX_AUTO_RELOADS,
  reloadDelayMs = RENDERER_RELOAD_DELAY_MS,
}) {
  const { state } = ctx;
  const log = (level, message, fields) => {
    try { logger[level](message, fields); } catch {}
  };
  const logFile = path.join(ctx.runtimePaths?.logsDir ?? "runtime/logs", "desktop.ndjson");
  let startupNoticeShown = false;

  // 启动期（app 还没 ready、或还没有主窗口）出错：弹一次错误框（showErrorBox 在 ready 之前也能用）；之后只记日志。
  // 退出 / 重启界面途中不弹。
  function noticeDuringStartup(message) {
    if (startupNoticeShown || state.isQuitting || state.controlPlaneRestarting) return;
    let ready = false;
    try { ready = app?.isReady?.() === true; } catch {}
    if (ready && state.mainWindow) return;
    startupNoticeShown = true;
    try { dialog?.showErrorBox?.(STARTUP_ERROR_TITLE, startupErrorText(message, logFile)); } catch {}
  }

  function registerProcessGuards(proc = process) {
    // 日志记录的 message 是整句话，错误自己的 message 已经在句子里，字段里只放类型与栈。
    proc.on("uncaughtException", (err, origin) => {
      const { message, ...info } = describeError(err);
      log("error", `主进程未捕获异常：${message}`, { event: "uncaught-exception", origin: "main", via: origin, ...info });
      noticeDuringStartup(message);
    });
    proc.on("unhandledRejection", (reason) => {
      const { message, ...info } = describeError(reason);
      log("error", `主进程未处理的 Promise 拒绝：${message}`, { event: "unhandled-rejection", origin: "main", ...info });
      noticeDuringStartup(message);
    });
  }

  // GPU / 网络服务等子进程。正常退出只记一条 info。
  function watchApp(app) {
    app.on("child-process-gone", (_event, details = {}) => {
      const reason = String(details.reason || "unknown");
      const fields = {
        event: "child-process-gone",
        origin: "main",
        type: details.type ?? null,
        reason,
        exitCode: details.exitCode ?? null,
        ...(details.serviceName ? { serviceName: details.serviceName } : {}),
        ...(details.name ? { name: details.name } : {}),
      };
      log(reason === "clean-exit" ? "info" : "warn", `子进程退出（${details.type || "未知类型"}，${reason}，退出码 ${details.exitCode ?? "-"}）`, fields);
    });
  }

  // label：main / island；reload：重新加载这个窗口；onGiveUp：prompt（弹框给「重新加载」）/ close（关掉，下次重建）。
  function watchWindow(win, { label, reload, onGiveUp = "prompt" }) {
    const name = WINDOW_LABELS[label] || label;
    const budget = createReloadBudget({ windowMs, maxReloads, now });
    let unresponsiveSince = null;
    let promptOpen = false;
    const alive = () => !win.isDestroyed?.();
    const busy = () => state.isQuitting || state.controlPlaneRestarting;

    function reloadNow(trigger) {
      if (!alive() || busy()) return;
      try {
        reload();
        log("info", `${name}已重新加载`, { event: "renderer-reload", origin: "main", window: label, trigger });
      } catch (err) {
        const { message, ...info } = describeError(err);
        log("error", `${name}重新加载失败：${message}`, { event: "renderer-reload-failed", origin: "main", window: label, ...info });
      }
    }

    function giveUp(count) {
      if (onGiveUp === "close") {
        log("warn", `${name}的界面进程反复退出，先关掉，下次打开时重建`, { event: "renderer-give-up", origin: "main", window: label, recentCount: count });
        try { win.destroy?.(); } catch {}
        return;
      }
      if (promptOpen) return;
      promptOpen = true;
      const options = {
        type: "warning",
        buttons: ["重新加载", "稍后"],
        defaultId: 0,
        cancelId: 1,
        message: "界面反复退出，已停止自动重新加载",
        detail: `${Math.round(windowMs / 60_000)} 分钟内退出了 ${count} 次。经过已记在运行目录的 logs/desktop.ndjson；重新加载后可以在「配置 → 版本与更新」导出诊断包发给发布方。隧道与后台服务不受影响。`,
      };
      // 窗口收在托盘里（隐藏）时挂在它上面的对话框看不见：那时不挂父窗口。
      const parent = win.isVisible?.() === false ? null : win;
      Promise.resolve()
        .then(() => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)))
        .then((result) => {
          if (result?.response === 0) reloadNow("user");
        })
        .catch(() => {})
        .finally(() => { promptOpen = false; });
    }

    win.webContents.on("render-process-gone", (_event, details = {}) => {
      const reason = String(details.reason || "unknown");
      const exitCode = details.exitCode ?? null;
      const stuckMs = unresponsiveSince == null ? null : now() - unresponsiveSince;
      unresponsiveSince = null;
      const base = { event: "render-process-gone", origin: "main", window: label, reason, exitCode, ...(stuckMs != null ? { stuckMs } : {}) };
      if (reason === "clean-exit" || busy() || !alive()) {
        log("info", `${name}的界面进程退出（${reason}）`, { ...base, action: "none" });
        return;
      }
      const decision = budget.record();
      const count = budget.count();
      log("error", `${name}的界面进程异常退出（${reason}，退出码 ${exitCode ?? "-"}）`, {
        ...base,
        recentCount: count,
        action: decision === "reload" ? "auto-reload" : onGiveUp,
      });
      if (decision === "reload") {
        timers.setTimeout(() => reloadNow("auto"), reloadDelayMs);
        return;
      }
      giveUp(count);
    });

    win.on("unresponsive", () => {
      if (unresponsiveSince != null) return;
      unresponsiveSince = now();
      log("warn", `${name}无响应`, { event: "unresponsive", origin: "main", window: label });
    });

    win.on("responsive", () => {
      if (unresponsiveSince == null) return;
      const stuckMs = now() - unresponsiveSince;
      unresponsiveSince = null;
      log("info", `${name}恢复响应（卡住约 ${Math.max(1, Math.round(stuckMs / 1000))} 秒）`, { event: "responsive", origin: "main", window: label, stuckMs });
    });
  }

  return { registerProcessGuards, watchApp, watchWindow };
}
