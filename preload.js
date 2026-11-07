const { contextBridge, ipcRenderer } = require("electron");

let jobNotificationListener = null;
let pendingJobNotification = null;
ipcRenderer.on("job-notice-open", (_event, target) => {
  // view："history" = 失败提醒，页面直接定位到「我的历史」；其余为 null（先找关注列表）。只放行这一个已知值。
  const value = { serverId: typeof target?.serverId === "string" ? target.serverId : null, jobId: typeof target?.jobId === "string" ? target.jobId : null, view: target?.view === "history" ? "history" : null };
  if (jobNotificationListener) jobNotificationListener(value);
  else pendingJobNotification = value;
});

// 悬浮岛：钉住状态由托盘菜单改动时，主进程推一次 island-pinned，页面同步图钉按钮与拖动区域。
let islandPinnedListener = null;
ipcRenderer.on("island-pinned", (_event, pinned) => {
  if (islandPinnedListener) islandPinnedListener(pinned === true);
});

const electronAPI = {
  // 页面据此给 macOS 桌面壳让出红绿灯位置、把页头设为可拖动区域（shell.css [data-shell]）。
  platform: process.platform,
  onJobNotification: (listener) => {
    if (typeof listener !== "function") return () => {};
    jobNotificationListener = listener;
    if (pendingJobNotification) { const target = pendingJobNotification; pendingJobNotification = null; listener(target); }
    return () => { if (jobNotificationListener === listener) jobNotificationListener = null; };
  },
  openMainWindow: () => ipcRenderer.send("open-main-window"),
  hideWindow: () => ipcRenderer.send("hide-window"),
  quitApp: () => ipcRenderer.send("quit-app"),
  // 未确认的退出：主进程弹原生确认框（悬浮岛用，它失焦即隐藏，不能自己弹 confirm）。
  requestQuit: () => ipcRenderer.send("request-quit"),
  getAuthToken: () => ipcRenderer.invoke("get-auth-token"),
  // 热更新 B：重启界面（只重启 Electron 主进程 + monitor-server，隧道/守护/代理不中断）。
  restartControlPlane: () => ipcRenderer.invoke("restart-control-plane"),
  getBundleUpdate: () => ipcRenderer.invoke("get-bundle-update"),
  // 配置 →「启动」：打包的 App 的登录项（登录电脑后自动启动）。返回 { supported, enabled, status, error }。
  getAutostart: () => ipcRenderer.invoke("get-autostart"),
  setAutostart: (enabled) => ipcRenderer.invoke("set-autostart", enabled === true),
  // 配置 → 版本与更新 →「导出诊断包」：系统保存对话框。payload { filename, text }，返回 { saved, path } 或 { saved: false, canceled: true }。
  saveDiagnosticsBundle: (payload) => ipcRenderer.invoke("save-diagnostics", { filename: String(payload?.filename ?? ""), text: String(payload?.text ?? "") }),
  // 配置 →「备份与迁移」：导出文件走系统保存对话框。返回 { saved, name } / { saved: false, canceled } / { saved: false, error }。
  // 悬浮岛：钉在桌面（常驻、可拖动、记住位置）与按内容调整窗口高度。主进程只接受悬浮岛自己调用。
  getIslandState: () => ipcRenderer.invoke("island-get-state"),
  setIslandPinned: (pinned) => ipcRenderer.invoke("island-set-pinned", pinned === true),
  resizeIsland: (height) => ipcRenderer.send("island-resize", Number(height) || 0),
  onIslandPinned: (listener) => {
    islandPinnedListener = typeof listener === "function" ? listener : null;
  },
  saveExportFile: (defaultName, content) => ipcRenderer.invoke("save-export-file", { defaultName: String(defaultName || ""), content: String(content || "") }),
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
