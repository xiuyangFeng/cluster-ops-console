// context.mjs —— Electron 主进程各模块共享的上下文：常量、可变状态、跨模块动作表。
//
// 为什么集中成一个对象：拆分前这些是 electron-main.mjs 顶层的二十多个 `let`，每个函数
// 直接读写。拆成模块后，跨模块共享的标志（isQuitting / quitConfirmed / controlPlaneRestarting …）
// 必须始终经 ctx.state 现读现写——**绝不解构布尔值**，否则拿到的是创建时的快照，
// 例如"重启界面进行中"判定会永远读到 false。只被单个模块使用的缓存（托盘图标、告警队列、
// 保管库句柄等）留在各自模块的闭包里，不进这里。
//
// 跨模块调用一律经 ctx.actions（构造完所有模块后由入口 bindDesktopActions 一次性填入），
// 模块之间没有 import 依赖，也就没有循环；未绑定就调用会立刻抛错，而不是静默 undefined。
//
// 本目录（work/monitor/desktop/）随 .app 打包；模块一律不 import "electron"，
// Electron API 由入口经工厂参数注入，node:test 可以用假对象驱动。

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";

export const APP_DISPLAY_NAME = "Codex Tunnel Operations Console";
export const MONITOR_PORT = 8877;
// Windows 的应用身份（AppUserModelID）：原生通知要靠它认出发送方，必须与安装器开始菜单快捷方式上写的一致
// （scripts/windows-installer.iss）。取值与 macOS 的 CFBundleIdentifier 相同。
export const APP_USER_MODEL_ID = "com.xiuyang.codex-operations-console";

// 打包 .app 从 Finder/Dock 启动时 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，找不到 Homebrew 的
// ssh/lsof 等；把常见前缀放到最前面，原 PATH 保留在末尾。
const DESKTOP_PATH_PREFIX = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
// Windows 不需要（PATH 分隔符是 ;，ssh 在 System32\OpenSSH，资源管理器启动时 PATH 本就完整），原样返回。
export function buildDesktopPathEnv(currentPath, platform = process.platform) {
  if (platform === "win32") return currentPath;
  return [...DESKTOP_PATH_PREFIX, currentPath || ""].join(":");
}

// buildDesktopPathEnv 的逆操作：从入口继承到的 PATH 里取回加前缀之前的那一份，也就是启动器当时的 PATH。
// 开机自启写 LaunchAgent 用的是它（lib/autostart/）——拿加过前缀的 PATH 去写，登录时 start.sh 先找到的
// 可能是 Homebrew / /usr/local 的 node，而不是平时手动启动用的那个。
// 「重启界面」（app.relaunch）起来的新实例继承的是上一个实例已经加过前缀的 PATH，每重启一次多一段，
// 所以开头的整段前缀有几段剥几段。用户自己的 PATH 恰好以这一整段开头时会被一起剥掉：能跑起 start.sh 的
// PATH 一定有 /usr/bin 与 /bin，剥完发现没有了，就说明原来的 PATH 自己带着这一段，补回一段。
export function stripDesktopPathEnv(pathEnv, platform = process.platform) {
  if (platform === "win32") return pathEnv;
  const prefix = `${DESKTOP_PATH_PREFIX.join(":")}:`;
  let rest = String(pathEnv ?? "");
  while (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  const dirs = rest.split(":");
  return dirs.includes("/usr/bin") && dirs.includes("/bin") ? rest : `${prefix}${rest}`;
}

// 跨模块共享的可变状态。字段含义：
//   serverProcess / serverExiting / serverRestartTimer  monitor-server 子进程及自愈（monitor-process 写，quit 清理）
//   mainWindow / islandWindow / tray / statusInterval   窗口、托盘与托盘状态订阅的心跳定时器
//   isQuitting          显式退出：清理会停数据面。重启界面绝不置它。
//   quitConfirmed       W5 退出确认已通过；quitPromptOpen 确认框正开着
//   cleanupStarted      before-quit 的清理已开始（防重入）
//   controlPlaneRestarting  重启界面进行中（见 lib/control-plane-restart.mjs 的状态机说明）
//   startupComplete     monitor-server 启动完成后才接受重启请求
//   pendingRestartReason 启动完成前收到的 SIGUSR2：启动完成后再执行
//   pendingBundleUpdate 已安装未生效的新构建（托盘菜单 / 渲染层横幅读取）
export function createDesktopState() {
  return {
    serverProcess: null,
    serverExiting: false, // 主动清理期间为 true，抑制退出监听器触发重启
    serverRestartTimer: null,
    mainWindow: null,
    islandWindow: null,
    tray: null,
    statusInterval: null,
    isQuitting: false,
    quitConfirmed: false,
    quitPromptOpen: false,
    cleanupStarted: false,
    controlPlaneRestarting: false,
    startupComplete: false,
    pendingRestartReason: "",
    pendingBundleUpdate: null,
  };
}

// 跨模块动作表的全部槽位（名字即契约）。新增跨模块调用时先在这里登记，
// 入口的 bindDesktopActions 会校验"一个不少、一个不多"。
export const DESKTOP_ACTION_NAMES = Object.freeze([
  "startCredentialVault", // vault
  "teardownCredentialVault", // vault：只在显式退出路径调用
  "pkillScopedByPattern", // monitor-process
  "markTrayDown", // tray
  "createMainWindow", // windows
  "toggleIslandWindow", // windows
  "isIslandPinned", // windows：悬浮岛钉在桌面（托盘菜单勾选项）
  "setIslandPinned", // windows
  "resizeIslandWindow", // windows：悬浮岛页面按内容高度请求改窗口高度
  "getTrayMetric", // tray-glance：菜单栏数字显示哪项（托盘菜单「菜单栏显示」）
  "setTrayMetric", // tray-glance
  "requestQuit", // quit
  "requestQuitWithConfirm", // quit
  "cleanupBackground", // quit
  "removeDesktopMainRecord", // control-plane
  "restartControlPlane", // control-plane
  "restartFromRenderer", // control-plane
  "getAutostart", // login-item：打包的 App 的登录项（配置 → 启动）
  "setAutostart", // login-item
  "saveDiagnosticsBundle", // diagnostics-save：配置 → 版本与更新 →「导出诊断包」的保存对话框
  "saveExportFile", // export-file：配置 →「备份与迁移」的导出另存为（系统保存对话框）
]);

function createActionSlots() {
  const actions = {};
  for (const name of DESKTOP_ACTION_NAMES) {
    actions[name] = () => {
      throw new Error(`desktop action "${name}" 尚未绑定`);
    };
  }
  return actions;
}

export function bindDesktopActions(ctx, impls) {
  const unknown = Object.keys(impls).filter((name) => !DESKTOP_ACTION_NAMES.includes(name));
  if (unknown.length) throw new Error(`未登记的 desktop action：${unknown.join(", ")}`);
  const missing = DESKTOP_ACTION_NAMES.filter((name) => typeof impls[name] !== "function");
  if (missing.length) throw new Error(`desktop action 缺少实现：${missing.join(", ")}`);
  Object.assign(ctx.actions, impls);
  return ctx.actions;
}

// rootDir：应用根（源码模式是仓库根，打包模式是 .app/Contents/Resources/app），即 electron-main.mjs 所在目录。
export function createDesktopContext({
  rootDir,
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const monitorBaseUrl = `http://127.0.0.1:${MONITOR_PORT}`;
  return {
    rootDir: resolvedRoot,
    appDisplayName: APP_DISPLAY_NAME,
    runtimePaths: resolveRuntimePaths({ appRoot: resolvedRoot, env, platform, homeDir }),
    monitorPort: MONITOR_PORT,
    monitorBaseUrl,
    statusLiteUrl: `${monitorBaseUrl}/api/status-lite`,
    preloadPath: path.join(resolvedRoot, "preload.js"),
    // Windows 安装版的窗口 / 任务栏图标：构建时放在 resources\app-icon.ico（应用根的上一级）。
    // 源码运行时没有这个文件，Electron 用 exe 自带的图标；macOS 用 .app 的图标，不需要。
    windowIconPath: platform === "win32" ? path.join(resolvedRoot, "..", "app-icon.ico") : null,
    islandHtmlPath: path.join(resolvedRoot, "work/monitor/public/island.html"),
    authToken: randomBytes(16).toString("hex"), // 经 process.env.AUTH_TOKEN 传给 monitor-server
    vaultToken: randomBytes(32).toString("hex"),
    state: createDesktopState(),
    actions: createActionSlots(),
  };
}
