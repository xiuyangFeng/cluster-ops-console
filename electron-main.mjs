// Electron 主进程入口：只做接线。各职责的实现在 work/monitor/desktop/（随 .app 打包）：
//   context.mjs          共享常量 / 可变状态（ctx.state）/ 跨模块动作表（ctx.actions）
//   vault.mjs            凭证保管库（safeStorage + 本机 HTTP 端点）
//   monitor-process.mjs  monitor-server 子进程：端口回收、启动、崩溃自愈
//   windows.mjs          主窗口 / 悬浮岛窗口（主窗口的大小与位置记忆在 window-bounds.mjs）
//   tray.mjs             托盘状态、菜单与原生通知
//   tray-glance.mjs      托盘图标旁的数字（GPU / CPU / 我的作业，macOS）；偏好与悬浮岛钉住位置在 widget-prefs.mjs
//   quit.mjs             退出编排（W5 确认框、before-quit、后台清理）
//   control-plane.mjs    热更新 B：重启界面（隧道不中断）+ 已安装更新检测
//   login-item.mjs       打包的 App 的登录项（登录电脑后自动启动）
//   export-file.mjs      配置导出的另存为（系统保存对话框）
//   ipc.mjs              渲染层 IPC 通道与来源校验
//   crash-watch.mjs      自身故障可见：主进程未捕获异常、界面进程退出 / 无响应、子进程退出 → runtime/logs/desktop.ndjson
//   diagnostics-save.mjs 「导出诊断包」的保存对话框
// 这里保留必须在模块顶层按序发生的事：故障日志与进程兜底 → setName → 单实例锁 → 进程信号 → IPC 注册 → whenReady。
// 绝不顶层 await app.whenReady()（ESM 顶层 await 会与 Electron 的就绪事件互相等待而死锁）。
// 第一个 import：Windows 安装版的子进程不弹命令行窗口（work/monitor/lib/windows-hide-children.mjs）。
import "./work/monitor/lib/windows-hide-children.mjs";
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, nativeImage, nativeTheme, powerMonitor, safeStorage, screen, shell, Tray } from "electron";

import { APP_USER_MODEL_ID, bindDesktopActions, buildDesktopPathEnv, createDesktopContext, stripDesktopPathEnv } from "./work/monitor/desktop/context.mjs";
import { createControlPlane } from "./work/monitor/desktop/control-plane.mjs";
import { createCrashWatch } from "./work/monitor/desktop/crash-watch.mjs";
import { createDiagnosticsSaver } from "./work/monitor/desktop/diagnostics-save.mjs";
import { createExportFileSaver } from "./work/monitor/desktop/export-file.mjs";
import { registerDesktopIpc } from "./work/monitor/desktop/ipc.mjs";
import { createLoginItemController } from "./work/monitor/desktop/login-item.mjs";
import { createMonitorProcess } from "./work/monitor/desktop/monitor-process.mjs";
import { createQuitController } from "./work/monitor/desktop/quit.mjs";
import { createTrayController } from "./work/monitor/desktop/tray.mjs";
import { createTrayGlance } from "./work/monitor/desktop/tray-glance.mjs";
import { createWidgetPrefsStore } from "./work/monitor/desktop/widget-prefs.mjs";
import { createDesktopJobNotices } from "./work/monitor/desktop/job-notices.mjs";
import { createCredentialVaultService } from "./work/monitor/desktop/vault.mjs";
import { createWindowManager } from "./work/monitor/desktop/windows.mjs";
import { LAUNCHER_PATH_ENV } from "./work/monitor/lib/autostart/launch-flag.mjs";
import { RELAUNCH_MARKER_ENV, shouldRetrySingleInstanceLock } from "./work/monitor/lib/control-plane-restart.mjs";
import { DESKTOP_LOG_SOURCE } from "./work/monitor/lib/diagnostics/log-sources.mjs";
import { createLogger } from "./work/monitor/lib/logger.mjs";
import { createProcessRegistry } from "./work/monitor/lib/process-registry.mjs";
import { confirmPackageUpdate } from "./work/monitor/lib/self-update/package-recovery.mjs";

const ctx = createDesktopContext({ rootDir: import.meta.dirname });
const { state } = ctx;
// 自身故障日志（v2.64）：最先接上——之后任何一步抛出的未捕获异常都要落进 desktop.ndjson。
// 本进程是 desktop.ndjson 唯一的写入方（launcher.ndjson 归启动器、renderer.ndjson 归监控服务，见 log-sources.mjs）：
// 拉起监控服务的事件与窗口等不到后端的启动失败也记在这里。
const desktopLog = createLogger(DESKTOP_LOG_SOURCE, { dir: ctx.runtimePaths.logsDir });
const crashWatch = createCrashWatch({ ctx, app, dialog, logger: desktopLog });
crashWatch.registerProcessGuards();
crashWatch.watchApp(app);
process.env.AUTH_TOKEN = ctx.authToken; // 传递给后台 monitor-server.mjs
app.setName(ctx.appDisplayName); // 须早于单实例锁：锁文件在 userData 下，userData 由应用名决定
// Electron 与后端在同一 rootDir，直接复用进程注册表（默认 execFileImpl）。
const registry = createProcessRegistry({ runtimeDir: ctx.runtimePaths.runtimeDir });
// 开机自启写 LaunchAgent 要用加前缀之前的 PATH。启动器（scripts/launch.mjs）会经环境变量带下来；它没带时
//（更新之前就在跑的旧启动器、或直接 electron . 起的）在这里取回——必须赶在下一行加前缀之前。
process.env[LAUNCHER_PATH_ENV] ||= stripDesktopPathEnv(process.env.PATH);
process.env.PATH = buildDesktopPathEnv(process.env.PATH);

// 单实例锁。重启界面时 app.relaunch() 由 Electron 的 relauncher 在本进程退出后才拉起新实例，
// 锁（userData 下的 SingletonLock）随进程退出释放，正常不会冲突；兜底：带重启标记的新实例
// 若仍拿不到锁（旧进程退出慢），在 10s 内每 250ms 重试，而不是直接退出导致界面消失。
const relaunchMarker = process.env[RELAUNCH_MARKER_ENV];
delete process.env[RELAUNCH_MARKER_ENV]; // 不下传给 monitor-server 及其后代
let gotSingleInstanceLock = app.requestSingleInstanceLock();
const singleInstanceReady = (async () => {
  if (gotSingleInstanceLock) return true;
  if (shouldRetrySingleInstanceLock({ gotLock: false, marker: relaunchMarker, now: Date.now() })) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      gotSingleInstanceLock = app.requestSingleInstanceLock();
      if (gotSingleInstanceLock) {
        console.log("[relaunch] single-instance lock acquired after retry");
        return true;
      }
    }
  }
  if (!gotSingleInstanceLock) app.exit(0);
  return false;
})();

if (process.platform === "darwin") {
  app.setActivationPolicy("regular");
}
// Windows：原生通知按 AppUserModelID 认发送方，须与安装器建的开始菜单快捷方式一致，否则通知不显示。
if (process.platform === "win32") {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

const vault = createCredentialVaultService({ ctx, safeStorage });
const monitor = createMonitorProcess({ ctx, registry, eventLog: desktopLog });
// 悬浮岛与菜单栏数字共用一份偏好（各自带缓存，必须是同一个实例）。
const widgetPrefs = createWidgetPrefsStore({ runtimeDir: ctx.runtimePaths.runtimeDir });
const windows = createWindowManager({ ctx, app, BrowserWindow, dialog, shell, screen, widgetPrefs,
  watchWindow: crashWatch.watchWindow,
  onStartupFailed: (info) => desktopLog.error("桌面窗口启动失败：后端监控服务 15 秒内未就绪", { event: "window-startup-failed", origin: "desktop-shell", ...info }),
});
const tray = createTrayController({ ctx, Tray, Menu, nativeImage, Notification, nativeTheme });
const trayGlance = createTrayGlance({ ctx, prefs: widgetPrefs });
const jobNotices = createDesktopJobNotices({ ctx, Notification, windows });
const quit = createQuitController({ ctx, app, dialog, registry });
const controlPlane = createControlPlane({ ctx, app, registry, Notification });
const loginItem = createLoginItemController({ ctx, app });
const diagnosticsSaver = createDiagnosticsSaver({ ctx, app, dialog, logger: desktopLog });
const exportFile = createExportFileSaver({ ctx, dialog });
bindDesktopActions(ctx, {
  startCredentialVault: vault.startCredentialVault,
  teardownCredentialVault: vault.teardownCredentialVault,
  pkillScopedByPattern: monitor.pkillScopedByPattern,
  markTrayDown: tray.markTrayDown,
  createMainWindow: windows.createMainWindow,
  toggleIslandWindow: windows.toggleIslandWindow,
  isIslandPinned: windows.isIslandPinned,
  setIslandPinned: windows.setIslandPinned,
  resizeIslandWindow: windows.resizeIslandWindow,
  getTrayMetric: trayGlance.getMetric,
  setTrayMetric: trayGlance.setMetric,
  requestQuit: quit.requestQuit,
  requestQuitWithConfirm: quit.requestQuitWithConfirm,
  cleanupBackground: quit.cleanupBackground,
  removeDesktopMainRecord: controlPlane.removeDesktopMainRecord,
  restartControlPlane: controlPlane.restartControlPlane,
  restartFromRenderer: controlPlane.restartFromRenderer,
  getAutostart: loginItem.getAutostart,
  setAutostart: loginItem.setAutostart,
  saveDiagnosticsBundle: diagnosticsSaver.saveDiagnosticsBundle,
  saveExportFile: exportFile.saveExportFile,
});

// 退出时只删自己的 desktop-main 记录（重启后新实例可能已写入自己的 pid）。
process.on("exit", controlPlane.removeDesktopMainRecord);

// A 的 bundle 替换完成后发 SIGUSR2：启动未完成则记下、启动完成后执行。
process.on("SIGUSR2", () => {
  console.log("[restart-control-plane] SIGUSR2 received");
  controlPlane.restartControlPlane("signal");
});

registerDesktopIpc({ ipcMain, ctx });

// App 生命周期
app.whenReady().then(async () => {
  // 未拿到单实例锁（普通重复启动）→ 不做任何初始化；singleInstanceReady 内部已 app.exit。
  if (!(await singleInstanceReady)) return;
  await monitor.startMonitorServer();
  controlPlane.recordDesktopMain();
  tray.createTray();
  trayGlance.start();
  // 上次钉在桌面的状态面板：启动即放回原位。
  if (windows.isIslandPinned()) windows.setIslandPinned(true);
  jobNotices.start();
  state.startupComplete = true;
  controlPlane.startBundleUpdateWatch();
  if (state.pendingRestartReason) {
    state.pendingRestartReason = "";
    controlPlane.restartControlPlane("signal");
    return;
  }
  // 启动时直接打开大窗口；createMainWindow 内部会轮询就绪探测后再 loadURL（不再用固定 setTimeout 竞态）。
  if (await windows.createMainWindow()) confirmPackageUpdate(ctx.rootDir);

  app.on("activate", () => {
    if (state.controlPlaneRestarting) return;
    windows.createMainWindow();
    if (!state.islandWindow) {
      windows.createIslandWindow();
    }
  });
});

app.on("second-instance", () => {
  if (state.controlPlaneRestarting) return; // 重启中：窗口已销毁，新实例（带重启标记）稍后接手
  windows.createMainWindow();
  windows.showMainWindow();
});

// 必须保留这个空监听：不订阅 window-all-closed 时 Electron 默认在窗口全关后退出应用；
// macOS 托盘常驻，关闭大窗口不退出。
app.on("window-all-closed", () => {});

// 系统关机/注销触发的退出不能被确认框卡住（quit.handlePowerShutdown）。
app.whenReady().then(() => {
  powerMonitor.on("shutdown", quit.handlePowerShutdown);
});

// 显式退出：preventDefault 一次 → 异步清理（8s 超时强退）→ app.exit(0)（quit.handleBeforeQuit）。
app.on("before-quit", quit.handleBeforeQuit);
app.on("before-quit", () => { if (state.isQuitting || state.controlPlaneRestarting) jobNotices.stop(); });
