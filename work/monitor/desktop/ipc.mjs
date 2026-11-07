// ipc.mjs —— 渲染层 → 主进程的 IPC 通道（与 preload.js 暴露的 window.electronAPI 一一对应）。
//
// 每个通道先校验调用方：只接受本应用两个窗口的主 frame，且页面 origin / 文件必须是预期的那个。
// 必须在任何窗口加载页面之前注册（入口在模块顶层调用，早于 app.whenReady）。

import { fileURLToPath } from "node:url";

import { isTrustedVaultIpcOrigin } from "../lib/vault-ipc.mjs";

// 应用窗口（主窗口 / 悬浮岛）的主 frame，且页面是预期的那一个。
export function isTrustedAppIpc(event, { mainWindow, islandWindow, islandHtmlPath }) {
  const owner = [mainWindow, islandWindow].find((win) => win && !win.isDestroyed() && event?.sender === win.webContents);
  if (!owner || event.senderFrame !== owner.webContents.mainFrame) return false;
  if (owner === mainWindow) return isTrustedVaultIpcOrigin(event.senderFrame.url);
  try {
    const url = new URL(event.senderFrame.url);
    return url.protocol === "file:" && fileURLToPath(url) === islandHtmlPath;
  } catch { return false; }
}

export function registerDesktopIpc({ ipcMain, ctx }) {
  const { state, actions, islandHtmlPath } = ctx;
  const trusted = (event) => isTrustedAppIpc(event, {
    mainWindow: state.mainWindow,
    islandWindow: state.islandWindow,
    islandHtmlPath,
  });

  ipcMain.handle("get-auth-token", (event) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return ctx.authToken;
  });

  ipcMain.on("open-main-window", (event) => {
    if (!trusted(event)) return;
    actions.createMainWindow();
    if (state.islandWindow) {
      state.islandWindow.hide(); // 弹出大窗口后自动隐藏弹出小卡片
    }
  });

  ipcMain.on("quit-app", (event) => {
    if (!trusted(event)) return;
    actions.requestQuit();
  });

  // 悬浮岛「退出」：未确认，交给 before-quit 弹原生确认框。
  ipcMain.on("request-quit", (event) => {
    if (!trusted(event)) return;
    actions.requestQuitWithConfirm();
  });

  // 渲染层"重启界面"按钮（更新横幅）。返回决策；成功时本进程随即退出，Promise 可能不会回到渲染层。
  ipcMain.handle("restart-control-plane", (event) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return actions.restartFromRenderer();
  });

  ipcMain.handle("get-bundle-update", (event) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return state.pendingBundleUpdate ? { ...state.pendingBundleUpdate } : null;
  });

  // 配置 →「启动」：打包的 App 的登录项（login-item.mjs）。源码安装的桌面壳在那边如实回「不支持」，
  // 页面改走监控服务的 /api/autostart。写入只收布尔 true，别的值一律当成关。
  ipcMain.handle("get-autostart", (event) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return actions.getAutostart();
  });

  ipcMain.handle("set-autostart", (event, enabled) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return actions.setAutostart(enabled === true);
  });

  // 配置 → 版本与更新 →「导出诊断包」：页面取到已脱敏的包，交给主进程弹保存框写盘（diagnostics-save.mjs 校验内容）。
  ipcMain.handle("save-diagnostics", (event, payload) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return actions.saveDiagnosticsBundle(payload);
  });

  // 配置 →「备份与迁移」：导出文件经系统保存对话框写到用户选的位置（export-file.mjs）。只收文本，不收路径。
  ipcMain.handle("save-export-file", (event, payload) => {
    if (!trusted(event)) throw new Error("仅接受应用窗口调用");
    return actions.saveExportFile({ defaultName: payload?.defaultName, content: payload?.content });
  });

  // 悬浮岛专用：钉在桌面与按内容调整高度。只认悬浮岛自己（主窗口调不到）。
  const fromIsland = (event) => trusted(event) && event.sender === state.islandWindow?.webContents;

  ipcMain.handle("island-get-state", (event) => {
    if (!fromIsland(event)) throw new Error("仅接受悬浮岛调用");
    return { pinned: actions.isIslandPinned() === true };
  });

  ipcMain.handle("island-set-pinned", (event, pinned) => {
    if (!fromIsland(event)) throw new Error("仅接受悬浮岛调用");
    return { pinned: actions.setIslandPinned(pinned === true) === true };
  });

  ipcMain.on("island-resize", (event, height) => {
    if (!fromIsland(event)) return;
    actions.resizeIslandWindow(Number(height));
  });

  ipcMain.on("hide-window", (event) => {
    if (!trusted(event)) return;
    if (state.mainWindow) {
      state.mainWindow.hide();
    }
  });
}
