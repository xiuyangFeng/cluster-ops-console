// control-plane.mjs —— 热更新 B：desktop-main 登记 + 重启界面（控制面）+ 已安装更新检测。
//
// 重启界面：保留数据面（不置 isQuitting，cleanupBackground 走 preserveDataPlane 只停
// monitor-server）→ 销毁窗口/托盘 → app.relaunch() + app.exit(0)。
// app.relaunch() 默认用 process.execPath + 原 argv + 原工作目录：execPath 是启动时的路径字符串，
// A 把新 bundle 原子 rename 到同一路径后它指向新 bundle 的可执行文件；dev 模式（electron .）
// 同样以原参数重新拉起 electron。relauncher 在本进程退出后才启动新实例（单实例锁已释放）。
// app.exit 不触发 before-quit / will-quit，所以这条路径既不弹 W5 确认框，也不会被当成显式退出。
// 纯决策逻辑（状态机、构建比对）在 lib/control-plane-restart.mjs，这里只做接线与副作用。

import fs from "node:fs";
import path from "node:path";

import { parseBuildInfo, parseSourceVersion } from "../lib/build-info.mjs";
import {
  BUNDLE_UPDATE_CHECK_MS,
  buildDesktopMainMeta,
  DATA_PLANE_UPGRADING_MESSAGE,
  DESKTOP_MAIN_RECORD,
  decideControlPlaneRestart,
  detectBundleUpdate,
  formatUpdateVersion,
  isOwnDesktopMainRecord,
  RELAUNCH_MARKER_ENV,
} from "../lib/control-plane-restart.mjs";
import { isDataPlaneUpgradeInFlight, UPGRADE_GRACEFUL_STOP_MS } from "../lib/upgrade-marker.mjs";

const UPGRADE_RETRY_INTERVAL_MS = 2000;
const UPGRADE_RETRY_WINDOW_MS = 90_000;

export function createControlPlane({
  ctx,
  app,
  registry,
  Notification,
  isUpgradeInFlight = isDataPlaneUpgradeInFlight,
  readFileSync = fs.readFileSync,
  readFile = fs.promises.readFile,
  unlinkSync = fs.unlinkSync,
  env = process.env,
  pid = process.pid,
  ppid = process.ppid,
  execPath = process.execPath,
  now = Date.now,
  timers = globalThis,
  logger = console,
}) {
  const { state, actions, rootDir, runtimePaths } = ctx;
  // 启动时冻结"本进程运行的构建"：A 把新 bundle 原子 rename 到同一路径后，rootDir 下的
  // build-info.json 就是磁盘上的新构建，与这里的冻结值比较即可发现"已安装未生效"。
  // 只读：打包模式下 rootDir 是已签名的 .app，主进程绝不往里写。
  const bundleBuildInfoPath = path.join(rootDir, "build-info.json");
  let runningBundleBuild = null;
  try {
    runningBundleBuild = parseBuildInfo(readFileSync(bundleBuildInfoPath, "utf8"));
  } catch {}
  // 源码运行（同事 git clone 后 npm run start，没有 build-info.json）：运行中的版本取启动时 package.json 的
  // version，之后磁盘上的版本号变了（git pull / 界面里点「更新」）同样算「已安装未生效」，走同一条重启界面的路。
  // 是不是源码运行在启动时定死：打包 App 换包的那一瞬间读不到 build-info.json，不能回落去读 package.json。
  const sourceMode = !runningBundleBuild;
  const packageJsonPath = path.join(rootDir, "package.json");
  const sourceBuildOf = (raw) => {
    const version = parseSourceVersion(raw);
    return version ? { version, gitCommit: "", builtAt: "" } : null;
  };
  if (sourceMode) {
    try {
      runningBundleBuild = sourceBuildOf(readFileSync(packageJsonPath, "utf8"));
    } catch {}
  }
  let notifiedBundleUpdateKey = "";
  let bundleUpdateTimer = null;
  let upgradeRetryTimer = null;

  // 登记 Electron 主进程，供 bundle 替换流程按 pid 校验（命令行 == 应用主可执行文件、无脚本参数）
  // 后发送 SIGUSR2。退出时只删自己的记录（重启后新实例可能已写入自己的 pid）。
  function recordDesktopMain() {
    try {
      registry.recordProcess(DESKTOP_MAIN_RECORD, pid, buildDesktopMainMeta({
        execPath,
        rootDir,
        parentPid: ppid,
      }));
    } catch (err) {
      logger.warn("[desktop-main] record failed:", err?.message || err);
    }
  }

  function removeDesktopMainRecord() {
    try {
      if (!isOwnDesktopMainRecord(registry.readMeta(DESKTOP_MAIN_RECORD), pid)) return;
      unlinkSync(path.join(runtimePaths.runtimeDir, `${DESKTOP_MAIN_RECORD}.pid.json`));
    } catch {}
  }

  function dataPlaneUpgradeInFlight() {
    try {
      return isUpgradeInFlight({ runtimeDir: runtimePaths.runtimeDir });
    } catch {
      return false;
    }
  }

  function currentRestartDecision() {
    return decideControlPlaneRestart({
      ready: state.startupComplete,
      controlPlaneRestarting: state.controlPlaneRestarting,
      cleanupStarted: state.cleanupStarted,
      isQuitting: state.isQuitting,
      quitPromptOpen: state.quitPromptOpen,
      dataPlaneUpgrading: dataPlaneUpgradeInFlight(),
    });
  }

  // 数据面升级在飞时拒绝重启：用户触发的（托盘 / 横幅按钮）弹一条原生通知说明原因；
  // 信号触发的（bundle 替换脚本）不能丢——每 2s 复查，标记消失后自动重启（最多等 90s）。
  function handleUpgradeRefusal(source) {
    if (source === "signal") {
      if (upgradeRetryTimer) return;
      const deadline = now() + UPGRADE_RETRY_WINDOW_MS;
      upgradeRetryTimer = timers.setInterval(() => {
        if (dataPlaneUpgradeInFlight() && now() < deadline) return;
        timers.clearInterval(upgradeRetryTimer);
        upgradeRetryTimer = null;
        restartControlPlane("signal");
      }, UPGRADE_RETRY_INTERVAL_MS);
      return;
    }
    try {
      new Notification({ title: "暂不能重启界面", body: `${DATA_PLANE_UPGRADING_MESSAGE}（升级完成后再试）` }).show();
    } catch {}
    try {
      state.tray?.setToolTip(`集群运维工作台 · ${DATA_PLANE_UPGRADING_MESSAGE}`);
    } catch {}
  }

  async function restartControlPlane(source = "unknown") {
    const decision = currentRestartDecision();
    if (!decision.ok) {
      if (decision.reason === "not-ready" && source === "signal") state.pendingRestartReason = source;
      if (decision.reason === "data-plane-upgrading") handleUpgradeRefusal(source);
      logger.log(`[restart-control-plane] ignored (${source}): ${decision.reason}`);
      return decision;
    }
    state.controlPlaneRestarting = true;
    logger.log(`[restart-control-plane] start (${source}); data plane preserved`);
    if (bundleUpdateTimer) {
      timers.clearInterval(bundleUpdateTimer);
      bundleUpdateTimer = null;
    }
    // destroy 而非 close：close 监听器在非退出状态下会把主窗口改成隐藏。
    for (const win of [state.islandWindow, state.mainWindow]) {
      try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    }
    // 决策与动手之间升级可能刚开始：此时给 monitor-server 足够的优雅退出预算排干升级请求。
    const upgrading = dataPlaneUpgradeInFlight();
    const monitorStopBudgetMs = upgrading ? UPGRADE_GRACEFUL_STOP_MS : 1500;
    if (upgrading) logger.log(`[restart-control-plane] data-plane upgrade in flight; monitor-server graceful budget ${monitorStopBudgetMs}ms`);
    const timeout = new Promise((resolve) => timers.setTimeout(resolve, upgrading ? monitorStopBudgetMs + 5000 : 8000));
    await Promise.race([
      actions.cleanupBackground({ preserveDataPlane: true, monitorStopBudgetMs }).catch((err) => logger.error("Restart cleanup error:", err?.message)),
      timeout,
    ]);
    removeDesktopMainRecord();
    try { state.tray?.destroy(); } catch {}
    env[RELAUNCH_MARKER_ENV] = String(now()); // 新实例继承：锁未释放时短暂重试
    app.relaunch();
    app.exit(0); // 不触发 before-quit / will-quit
    return decision;
  }

  // 渲染层"重启界面"按钮（更新横幅，经 IPC）：返回决策；成功时本进程随即退出，Promise 可能不会回到渲染层。
  function restartFromRenderer() {
    const decision = currentRestartDecision();
    if (!decision.ok) {
      if (decision.reason === "data-plane-upgrading") handleUpgradeRefusal("ipc");
      return decision;
    }
    // 先回包再动手：让渲染层拿到 {ok:true} 显示"正在重启"，下一拍再销毁窗口。
    timers.setTimeout(() => restartControlPlane("ipc"), 50);
    return decision;
  }

  async function checkBundleUpdate() {
    let disk = null;
    try {
      disk = parseBuildInfo(await readFile(bundleBuildInfoPath, "utf8"));
    } catch {
      if (!sourceMode) return; // 打包 App 读不到（rename 瞬间）→ 不猜，保持现状
      try {
        disk = sourceBuildOf(await readFile(packageJsonPath, "utf8"));
      } catch {
        return;
      }
    }
    const update = detectBundleUpdate({ running: runningBundleBuild, disk });
    state.pendingBundleUpdate = update;
    if (!update || update.key === notifiedBundleUpdateKey || state.controlPlaneRestarting) return;
    notifiedBundleUpdateKey = update.key;
    logger.log(`[bundle-update] installed build differs from running: ${update.key}`);
    try {
      const version = formatUpdateVersion(update);
      const n = new Notification({
        title: `新版本${version ? ` ${version}` : ""} 已安装`,
        body: "重启界面即可生效（隧道不中断）。可从托盘菜单或主窗口横幅操作。",
      });
      // 点击通知只打开主窗口（横幅上有按钮），不直接重启，避免误触。
      n.on("click", () => actions.createMainWindow());
      n.show();
    } catch {}
  }

  function startBundleUpdateWatch() {
    if (bundleUpdateTimer) return;
    checkBundleUpdate();
    bundleUpdateTimer = timers.setInterval(checkBundleUpdate, BUNDLE_UPDATE_CHECK_MS);
    if (typeof bundleUpdateTimer.unref === "function") bundleUpdateTimer.unref();
  }

  return {
    recordDesktopMain,
    removeDesktopMainRecord,
    restartControlPlane,
    restartFromRenderer,
    checkBundleUpdate,
    startBundleUpdateWatch,
  };
}
