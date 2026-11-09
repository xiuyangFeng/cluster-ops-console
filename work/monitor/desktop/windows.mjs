// windows.mjs —— 主控制台窗口与托盘下拉的悬浮岛窗口：创建、显示/聚焦、导航加固。
//
// 两个窗口都 sandbox + contextIsolation，preload 只暴露 window.electronAPI（见 preload.js）。
// 窗口句柄存在 ctx.state（重启界面 / IPC 来源校验 / 托盘菜单都要读）。
// 主窗口的大小与位置记在 runtime/window-state.json（window-bounds.mjs），下次打开原样恢复。
// 悬浮岛平时是托盘弹出卡片（失焦即收起）；「钉在桌面」后常驻、可拖动、记住位置（widget-prefs.mjs）。

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { isNavigationAllowed, waitForServerReady } from "../desktop-lifecycle.mjs";
import { createWindowBoundsStore, resolveWindowBounds } from "./window-bounds.mjs";
import { createWidgetPrefsStore, resolveIslandPosition } from "./widget-prefs.mjs";

const BOUNDS_SAVE_DELAY_MS = 400; // 拖动 / 缩放过程中事件很密，停下来再写盘
// 悬浮岛宽度固定；高度由页面按内容报上来（island-resize），夹在这个范围内。
export const ISLAND_WIDTH = 320;
export const ISLAND_DEFAULT_HEIGHT = 300;
export const ISLAND_HEIGHT_RANGE = Object.freeze({ min: 150, max: 560 });

export const READY_POLL_MS = 50;

// 悬浮岛弹出位置：水平居中对准托盘图标；托盘在屏幕上半（macOS 菜单栏）就贴在下面，在下半（Windows 任务栏）
// 就放到上面。拿得到工作区时收进工作区，不压任务栏、不出屏。
export function positionNearTray(trayBounds, size, workArea = null) {
  let x = Math.round(trayBounds.x + (trayBounds.width / 2) - (size.width / 2));
  let y = Math.round(trayBounds.y + trayBounds.height + 4);
  if (workArea) {
    const trayCenterY = trayBounds.y + trayBounds.height / 2;
    if (trayCenterY > workArea.y + workArea.height / 2) y = Math.round(trayBounds.y - size.height - 4);
    const clamp = (v, min, max) => Math.min(Math.max(v, min), Math.max(min, max));
    x = clamp(x, workArea.x, workArea.x + workArea.width - size.width);
    y = clamp(y, workArea.y, workArea.y + workArea.height - size.height);
  }
  return { x, y };
}

export function createWindowManager({
  ctx,
  app,
  BrowserWindow,
  dialog,
  shell,
  screen = null, // Electron screen 模块（app ready 之后才可用）；缺省时不做显示器校正
  waitForReady = waitForServerReady,
  fetchImpl = fetch,
  boundsStore = createWindowBoundsStore({ runtimeDir: ctx.runtimePaths.runtimeDir }),
  boundsSaveDelayMs = BOUNDS_SAVE_DELAY_MS,
  widgetPrefs = createWidgetPrefsStore({ runtimeDir: ctx.runtimePaths.runtimeDir }),
  // v2.64：窗口建好后交给 crash-watch 盯界面进程（退出 / 无响应）；后端没就绪的启动失败记进 desktop 日志。缺省什么都不做。
  watchWindow = () => {},
  onStartupFailed = () => {},
  platform = process.platform,
  fileExists = fs.existsSync,
}) {
  const { state, appDisplayName, preloadPath, islandHtmlPath, monitorBaseUrl, monitorPort, statusLiteUrl, authToken } = ctx;

  // 窗口加固：拒绝 window.open（外链交系统浏览器），导航只允许白名单 origin——
  // preload 暴露的 getAuthToken 不能被任何外部 origin 继承调用（Token 外泄面）。
  // 判定逻辑在 work/monitor/desktop-lifecycle.mjs 的 isNavigationAllowed（含单测）：
  // http(s) 按解析后的 URL.origin 比较；file: 按具体文件放行（不接受整个 scheme）。
  function hardenWebContents(win, allowedTargets) {
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url).catch(() => {}); // 返回 Promise，同步 try/catch 捕不到 rejection
      }
      return { action: "deny" };
    });
    const guard = (event, url) => {
      if (!isNavigationAllowed(url, allowedTargets)) {
        event.preventDefault();
      }
    };
    win.webContents.on("will-navigate", guard);
    win.webContents.on("will-redirect", guard);
  }

  // 显示并聚焦主窗口（一次性，不反复抢焦点、不临时置顶——那会造成启动时窗口抖动）。
  function showMainWindow() {
    const win = state.mainWindow;
    if (!win) return;
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    if (typeof win.moveTop === "function") {
      win.moveTop();
    }
    app.focus({ steal: true });
    win.focus();
    win.setAlwaysOnTop(false);
  }

  const islandPinned = () => widgetPrefs.load().islandPinned;
  const liveIsland = () => (state.islandWindow && !state.islandWindow.isDestroyed() ? state.islandWindow : null);

  // 弹出卡片在托盘图标之上（status 层），全屏应用里点托盘也能弹出；钉住后退到普通浮窗层（floating），
  // 不压住菜单栏与系统弹层，也不跟进全屏应用——常驻的小组件不该挡全屏看视频 / 演示。
  function applyIslandLevel(island) {
    const pinned = islandPinned();
    island.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !pinned });
    island.setAlwaysOnTop(true, pinned ? "floating" : "status");
  }

  // 创建托盘下拉弹出窗口 (IslandWindow)
  function createIslandWindow() {
    const island = new BrowserWindow({
      width: ISLAND_WIDTH,
      height: ISLAND_DEFAULT_HEIGHT,
      frame: false,
      show: false, // 初始时隐藏，点击托盘才弹出
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      hasShadow: true,
      skipTaskbar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    state.islandWindow = island;

    // file: 不放行整个 scheme，只放行这个确切的页面文件。
    hardenWebContents(island, [pathToFileURL(islandHtmlPath).href]);

    // 在所有虚拟桌面中都保持可见（全屏应用里是否可见见 applyIslandLevel）
    applyIslandLevel(island);

    // 界面进程反复退出时悬浮岛直接关掉（closed 里清空句柄），下次点托盘重建，不弹框。
    watchWindow(island, { label: "island", reload: () => island.loadFile(islandHtmlPath), onGiveUp: "close" });

    island.loadFile(islandHtmlPath);

    // 失去焦点时自动隐藏窗口（钉在桌面时常驻）
    island.on("blur", () => {
      if (!islandPinned()) island.hide();
    });

    // 钉住时拖到哪记到哪；拖动过程中事件很密，停下来再写盘。
    let moveTimer = null;
    island.on("move", () => {
      if (!islandPinned()) return;
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        moveTimer = null;
        if (island.isDestroyed() || !islandPinned()) return;
        const { x, y } = island.getBounds();
        widgetPrefs.update({ islandPosition: { x, y } });
      }, boundsSaveDelayMs);
    });

    island.on("closed", () => {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = null;
      state.islandWindow = null;
    });
  }

  // 钉住时回到上次拖到的位置（换了显示器布局、位置已不在屏上则退回托盘下方）。
  function pinnedIslandPosition(island) {
    if (!islandPinned()) return null;
    let displays = [];
    try {
      displays = screen?.getAllDisplays?.() ?? [];
    } catch {}
    return resolveIslandPosition(widgetPrefs.load().islandPosition, island.getBounds(), { displays });
  }

  // 切换下拉面板的显示与隐藏，并精确定位在托盘图标正下方
  function toggleIslandWindow() {
    if (!state.islandWindow) {
      createIslandWindow();
    }
    const island = state.islandWindow;
    if (island.isVisible()) {
      island.hide();
    } else {
      const pinned = pinnedIslandPosition(island);
      if (pinned) {
        island.setPosition(pinned.x, pinned.y, false);
      } else {
        const trayBounds = state.tray.getBounds();
        let workArea = null;
        try {
          workArea = screen?.getDisplayMatching?.(trayBounds)?.workArea ?? null;
        } catch {}
        const { x, y } = positionNearTray(trayBounds, island.getBounds(), workArea);
        island.setPosition(x, y, false);
      }
      island.show();
      island.focus();
    }
  }

  // 钉在桌面 / 取消（悬浮岛的图钉按钮与托盘菜单勾选项）。钉住时立刻显示出来并记下当前位置；
  // 取消时回到弹出卡片的行为——当前没有焦点就直接收起。页面经 island-pinned 同步按钮与拖动区域。
  function setIslandPinned(pinned) {
    const next = pinned === true;
    widgetPrefs.update({ islandPinned: next });
    let island = liveIsland();
    if (next && !island?.isVisible()) {
      toggleIslandWindow();
      island = liveIsland();
    }
    if (island) {
      applyIslandLevel(island);
      if (next) {
        const { x, y } = island.getBounds();
        widgetPrefs.update({ islandPosition: { x, y } });
      } else if (island.isVisible() && !island.isFocused?.()) {
        island.hide();
      }
      island.webContents.send?.("island-pinned", next);
    }
    return next;
  }

  // 页面按内容高度请求改窗口高度（宽度固定）；上沿不动，向下长。
  function resizeIslandWindow(height) {
    const island = liveIsland();
    const h = Math.round(Number(height));
    if (!island || !Number.isFinite(h) || h <= 0) return;
    const clamped = Math.min(Math.max(h, ISLAND_HEIGHT_RANGE.min), ISLAND_HEIGHT_RANGE.max);
    const bounds = island.getBounds();
    if (bounds.height === clamped && bounds.width === ISLAND_WIDTH) return;
    island.setBounds({ x: bounds.x, y: bounds.y, width: ISLAND_WIDTH, height: clamped });
  }

  // 主窗口的初始矩形：上次记下的大小与位置，按当前显示器布局校正；没有记录就是默认大小、系统居中。
  function initialMainBounds() {
    let displays = [];
    let primary = null;
    try {
      displays = screen?.getAllDisplays?.() ?? [];
      primary = screen?.getPrimaryDisplay?.() ?? null;
    } catch {} // 取不到显示器信息：按没有显示器校正处理
    return resolveWindowBounds(boundsStore.load(), { displays, primary });
  }

  // 记住主窗口的摆放：缩放 / 移动停下来后写一次，关闭（隐藏到托盘 / 退出）时立刻写。
  // 取 getNormalBounds（最大化 / 全屏时仍是还原后的矩形），不把全屏尺寸当成窗口大小记下来。
  function trackMainBounds(win) {
    let timer = null;
    const persist = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (win.isDestroyed()) return;
      const bounds = typeof win.getNormalBounds === "function" ? win.getNormalBounds() : win.getBounds();
      boundsStore.save(bounds);
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(persist, boundsSaveDelayMs);
    };
    win.on("resize", schedule);
    win.on("move", schedule);
    win.on("close", persist);
    win.on("closed", () => {
      if (timer) clearTimeout(timer);
      timer = null;
    });
  }

  // 标题栏：macOS 隐藏标题栏、红绿灯嵌进页头；Windows 必须保留系统标题栏——titleBarStyle 在 Windows 上
  // 只要不是 default 就整条去掉，连最小化 / 关闭按钮都没有。安装版另给窗口一个图标（任务栏用它）。
  function mainWindowChrome() {
    if (platform === "darwin") {
      // 红绿灯与页头第一行（品牌行）垂直居中对齐；页面侧的让位与拖动区域见 shell.css [data-shell="mac-desktop"]。
      return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 22 } };
    }
    const iconPath = ctx.windowIconPath;
    return iconPath && fileExists(iconPath) ? { icon: iconPath, autoHideMenuBar: true } : { autoHideMenuBar: true };
  }

  // 创建主控制台大窗口。先轮询就绪探测再 loadURL，避免固定 setTimeout 竞态导致的白屏/连接被拒。
  async function createMainWindow() {
    if (state.controlPlaneRestarting) return; // 重启界面中：窗口由新实例重建
    if (state.mainWindow) {
      showMainWindow();
      return;
    }

    state.mainWindow = new BrowserWindow({
      ...initialMainBounds(),
      show: false,
      title: appDisplayName,
      ...mainWindowChrome(),
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    hardenWebContents(state.mainWindow, [monitorBaseUrl]);
    const mainWindow = state.mainWindow;
    watchWindow(mainWindow, { label: "main", reload: () => mainWindow.loadURL(monitorBaseUrl), onGiveUp: "prompt" });

    state.mainWindow.once("ready-to-show", () => {
      showMainWindow();
    });

    trackMainBounds(state.mainWindow);

    state.mainWindow.on("close", (event) => {
      if (state.mainWindow && !state.isQuitting) {
        event.preventDefault();
        state.mainWindow.hide();
      }
    });

    state.mainWindow.on("closed", () => {
      state.mainWindow = null;
    });

    // 50ms 一探（perf）：监控服务冷启动约 300ms 就绪，按 250ms 一探平均要多白等 ~125ms 才 loadURL；
    // 连接被拒的探测几乎零成本，15 秒上限不变。
    const ready = await waitForReady({
      url: statusLiteUrl,
      token: authToken,
      intervalMs: READY_POLL_MS,
      timeoutMs: 15000,
      fetchImpl,
    });
    if (!state.mainWindow || state.mainWindow.isDestroyed()) return; // 等待期间窗口已被关闭
    if (!ready) {
      onStartupFailed({ reason: "monitor-not-ready", timeoutMs: 15000, url: monitorBaseUrl });
      dialog.showErrorBox(
        "启动失败",
        `后端监控服务在 15 秒内未就绪（${monitorBaseUrl}）。请检查 ${monitorPort} 端口占用或查看日志后重试。`,
      );
      return;
    }
    await state.mainWindow.loadURL(monitorBaseUrl);
    return true;
  }

  return { showMainWindow, createIslandWindow, toggleIslandWindow, isIslandPinned: islandPinned, setIslandPinned, resizeIslandWindow, createMainWindow };
}
