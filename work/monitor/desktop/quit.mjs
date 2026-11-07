// quit.mjs —— 退出编排：显式/未确认退出入口、before-quit（W5 确认框 + 8s 清理预算）、
// 关机放行、后台进程清理（cleanupBackground）。
//
// 两条清理路径共用 cleanupBackground：
//   - 显式退出（isQuitting）：停 monitor-server 后按"supervisor 先、其余并发"停数据面，关保管库。
//   - 隐式退出 / 重启界面（preserveDataPlane）：只停 monitor-server，数据面留给下个实例热接管。

import fs from "node:fs";

import { partitionQuitStopTargets } from "../desktop-lifecycle.mjs";
import { decideBeforeQuit } from "../lib/control-plane-restart.mjs";
// 只取命名常量：monitor-core 是零副作用模块。
import { TUNNEL_RECORD_PREFIX } from "../monitor-core.mjs";

const BEFORE_QUIT_CLEANUP_BUDGET_MS = 8000;

// pkill 兜底仅针对 pid.json 缺失或校验失败的目标，且命令行须包含本 rootDir。
// tunnel(ssh) 命令行不含 rootDir，无法安全甄别，故不做模式兜底（宁可漏杀也不误杀他处 ssh）。
const QUIT_FALLBACK_PATTERNS = {
  "channel-supervisor": "work/monitor/channel-supervisor.mjs",
  "local-proxy": "work/local_http_connect_proxy.mjs",
};

// v2.18 多隧道：每台配了隧道的服务器各有一条 tunnel.<serverId>.pid.json，显式退出要全部停掉，
// 漏一条就会留成孤儿进程（下次启动的热接管又会认为链路还在，于是永远没人重建）。
// 这里按 runtime 目录里的 pid 记录文件名反推记录名，不读配置——退出时配置可能已被改过，
// 而 pid.json 描述的才是"这次会话真的起了哪些隧道"。
// 纯函数（除 readdirSync 外无副作用），刻意不复用 registry.listRuntimeProcesses：
// 后者会对校验失败的记录做 unlink，在退出路径上删掉别人的记录是危险的副作用。
export function listTunnelRecordNames(runtimeDir, readdirImpl = fs.readdirSync) {
  const suffix = ".pid.json";
  try {
    return readdirImpl(runtimeDir)
      .filter((file) => file.startsWith(TUNNEL_RECORD_PREFIX) && file.endsWith(suffix))
      .map((file) => file.slice(0, -suffix.length))
      // 前缀后必须还有 serverId：裸 "tunnel.pid.json" 不是按服务器的记录名。
      .filter((name) => name.length > TUNNEL_RECORD_PREFIX.length);
  } catch {
    // 目录不存在 / 读不了：没有可停的隧道记录。
    return [];
  }
}

export function createQuitController({
  ctx,
  app,
  dialog,
  registry,
  platform = process.platform,
  readdirImpl = fs.readdirSync,
  timers = globalThis,
  logger = console,
}) {
  const { state, actions, runtimePaths } = ctx;

  // 显式退出入口（托盘「退出并停止后台」/ 主窗口按钮经渲染层确认后的 IPC）：视为已确认。
  // 未经这里的退出（Cmd+Q / 应用菜单 Quit / Dock 退出）会在 before-quit 里先弹原生确认框。
  function requestQuit() {
    // 重启界面进行中：本进程马上 app.exit 并由新实例接手，此时不接受显式退出（否则
    // isQuitting 会让清理路径去停数据面，把"不中断隧道"的重启变成全量停止）。
    if (state.controlPlaneRestarting) return;
    state.quitConfirmed = true;
    state.isQuitting = true;
    app.quit();
  }

  // 未确认的退出入口（悬浮岛「退出」按钮）：不置 quitConfirmed，交给 before-quit 弹原生确认框。
  // 悬浮岛失焦即自动隐藏，不能在它里面用 window.confirm，所以确认统一走主进程的原生对话框。
  function requestQuitWithConfirm() {
    if (state.cleanupStarted || state.quitPromptOpen || state.controlPlaneRestarting) return;
    app.quit();
  }

  // 停止后台衍生进程（异步）。返回 Promise，供 before-quit 用 8s 超时包裹。
  // preserveDataPlane：重启界面专用——无论 isQuitting 如何都只停 monitor-server。
  async function cleanupBackground({ preserveDataPlane = false, monitorStopBudgetMs = 1500 } = {}) {
    logger.log("Cleaning up backend processes...");
    state.serverExiting = true; // 抑制退出监听器触发重启
    if (state.serverRestartTimer) {
      timers.clearTimeout(state.serverRestartTimer);
      state.serverRestartTimer = null;
    }
    if (state.statusInterval) {
      timers.clearInterval(state.statusInterval);
      state.statusInterval = null;
    }

    // 无论显式/隐式退出，都关闭本会话 spawn 的 monitor-server，释放 8877 端口，避免占用冲突。
    if (state.serverProcess) {
      try { state.serverProcess.kill("SIGTERM"); } catch {}
      state.serverProcess = null;
    }
    // forceAfterMs=1500ms 是 SIGTERM→SIGKILL 升级前的等待预算；registry.stopProcess 内改用 isAlive 轮询，
    // 进程一旦退出即刻推进，故 4 次串行 stop 在进程正常退出时远快于固定 1500ms×4，稳落 8s 退出预算内。
    // 数据面升级在飞时（重启界面路径）调用方会放宽 monitorStopBudgetMs，让 monitor-server 的
    // SIGTERM 处理排干在飞的升级请求再退出，而不是 1.5s 后被 SIGKILL 打断交接。
    await registry.stopProcess("monitor-server", { forceAfterMs: monitorStopBudgetMs }).catch(() => {}); // 清理其 pid.json（若仍在）

    // 隐式退出（窗口关闭/隐藏、覆盖升级、热重启）保留底层 supervisor 与 tunnel，实现热接管。
    if (preserveDataPlane || !state.isQuitting) {
      logger.log("Implicit quit/restart detected. Preserving background supervisor and tunnel (hot-takeover).");
      return;
    }

    logger.log("Explicit quit requested. Stopping supervisor tree via process registry.");
    // 父进程优先（channel-supervisor 先停）：避免它在清理期间重生 local-proxy / tunnel；随后停子进程。
    // 两段式而非逐个串行：父进程独占第一段，其余目标并发停止（它们互不相关）。
    // 串行 await 在 N 台服务器时最坏 (N+2)×1.5s 以上，会撞上 before-quit 的 8s 死线。
    // local-proxy-draining：代理交接后仍在排空旧连接的旧代理（最多 15 分钟），显式退出一并停掉。
    const stopOrder = ["channel-supervisor", "local-proxy", "local-proxy-draining", ...listTunnelRecordNames(runtimePaths.runtimeDir, readdirImpl)];
    const fallbackTargets = [];
    const stopOne = async (name) => {
      if (!registry.readMeta(name)) {
        fallbackTargets.push(name); // pid.json 缺失 → 交给 rootDir 兜底
        return;
      }
      const result = await registry.stopProcess(name, { forceAfterMs: 1500 }).catch((err) => ({ stopped: false, reason: err.message }));
      logger.log(`[quit] stop ${name}:`, result);
      if (!result.stopped) fallbackTargets.push(name); // 校验失败（多为进程已不在）
    };
    const { first, rest } = partitionQuitStopTargets(stopOrder);
    await Promise.all(first.map(stopOne));
    await Promise.all(rest.map(stopOne));

    for (const name of fallbackTargets) {
      const pattern = QUIT_FALLBACK_PATTERNS[name];
      if (pattern) await actions.pkillScopedByPattern(pattern);
    }
    // 数据面已停：关保管库并删端点文件（重启界面路径走不到这里，端点文件留给存活的 supervisor）。
    await actions.teardownCredentialVault();
  }

  // Cmd+Q 等未确认的退出：弹原生确认框；取消则什么都不做（隧道继续运行）。
  function showQuitConfirmDialog() {
    state.quitPromptOpen = true;
    const win = state.mainWindow;
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    // 主窗口隐藏/被别的应用盖住时（托盘常驻、从悬浮岛触发），确认框会落在其他窗口后面
    // 看不见，before-quit 又已 preventDefault——表现为"点了退出没反应"。先把本应用抢到前台。
    if (platform === "darwin") {
      try { app.focus({ steal: true }); } catch {}
    }
    if (parent) {
      try { parent.focus(); } catch {}
    }
    const options = {
      type: "warning",
      buttons: ["退出并停止后台", "取消"],
      defaultId: 1,
      cancelId: 1,
      message: "退出并停止后台？",
      detail: "退出会关闭控制台，并停止守护进程、本地代理与全部服务器的 SSH 隧道，集群上的 Agent 将失去网络。只想关掉窗口请用「隐藏窗口」。",
    };
    (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
      .then(({ response }) => {
        state.quitPromptOpen = false;
        if (response === 0) requestQuit();
      })
      .catch(() => { state.quitPromptOpen = false; });
  }

  // 显式退出：preventDefault 一次 → 异步清理（8s 超时强退）→ app.exit(0)。cleanupStarted 防重入。
  function handleBeforeQuit(event) {
    const action = decideBeforeQuit({
      controlPlaneRestarting: state.controlPlaneRestarting,
      cleanupStarted: state.cleanupStarted,
      quitConfirmed: state.quitConfirmed,
      quitPromptOpen: state.quitPromptOpen,
    });
    if (action === "block-restarting") {
      // 重启界面进行中（路径以 app.exit 结束，不经 before-quit）：拦下其它退出请求，
      // 不弹确认框，也绝不置 isQuitting——否则清理会把数据面一起停掉。
      event.preventDefault();
      return;
    }
    if (action === "pass-through") {
      state.isQuitting = true;
      return; // 清理已在进行，放行本次退出
    }
    if (action === "prompt" || action === "prompt-open") {
      event.preventDefault();
      if (action === "prompt") showQuitConfirmDialog();
      return;
    }
    state.isQuitting = true;
    state.cleanupStarted = true;
    event.preventDefault();
    const timeout = new Promise((resolve) => timers.setTimeout(resolve, BEFORE_QUIT_CLEANUP_BUDGET_MS));
    Promise.race([
      cleanupBackground().catch((err) => logger.error("Cleanup error:", err?.message)),
      timeout,
    ]).finally(() => {
      actions.removeDesktopMainRecord();
      app.exit(0); // app.exit 不再触发 before-quit，避免二次进入
    });
  }

  // 系统关机/注销触发的退出不能被确认框卡住：视为已确认（若确认框已弹出则直接放行）。
  function handlePowerShutdown() {
    if (state.controlPlaneRestarting) return; // 重启路径几秒内自行 app.exit
    const pending = state.quitPromptOpen;
    state.quitConfirmed = true;
    if (pending) requestQuit();
  }

  return { requestQuit, requestQuitWithConfirm, cleanupBackground, handleBeforeQuit, handlePowerShutdown };
}
