import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createDesktopContext } from "./context.mjs";
import { createWindowManager, ISLAND_HEIGHT_RANGE, ISLAND_WIDTH, positionNearTray } from "./windows.mjs";

function makeHarness({ ready = true, savedBounds = null, screen = null, boundsSaveDelayMs = 400, watchWindow, onStartupFailed, widget = {}, platform = "darwin", fileExists = () => false } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform, homeDir: "/Users/t" });
  const calls = [];
  const created = [];
  const savedList = [];
  // 窗口状态的读写换成内存假件：测试不碰磁盘
  const boundsStore = { load: () => savedBounds, save: (bounds) => { savedList.push(bounds); return true; } };
  let prefs = { trayMetric: "gpu", islandPinned: false, islandPosition: null, ...widget };
  const widgetPrefs = { load: () => ({ ...prefs }), update: (patch) => { prefs = { ...prefs, ...patch }; return { ...prefs }; } };
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.listeners = {};
      this.once = (name, fn) => { this.handlers[`once:${name}`] = fn; };
      // 与 Electron 一样允许同一事件挂多个监听；handlers[name](...) 依次全部触发
      this.on = (name, fn) => {
        if (!this.listeners[name]) this.listeners[name] = [];
        this.listeners[name].push(fn);
        this.handlers[name] = (...args) => { for (const listener of this.listeners[name]) listener(...args); };
      };
      this.normalBounds = { x: 40, y: 60, width: 1280, height: 860 };
      this.visible = false;
      this.minimized = false;
      this.destroyed = false;
      this.alwaysOnTop = [];
      const contentsHandlers = {};
      this.bounds = { x: 0, y: 0, width: options.width ?? 320, height: options.height ?? 195 };
      this.focused = false;
      this.sent = [];
      this.webContents = {
        handlers: contentsHandlers,
        send: (channel, ...args) => this.sent.push([channel, ...args]),
        setWindowOpenHandler: (fn) => { contentsHandlers.windowOpen = fn; },
        on: (name, fn) => { contentsHandlers[name] = fn; },
      };
      created.push(this);
    }
    isMinimized() { return this.minimized; }
    restore() { calls.push("restore"); this.minimized = false; }
    show() { calls.push("show"); this.visible = true; }
    hide() { calls.push("hide"); this.visible = false; }
    focus() { calls.push("focus"); this.focused = true; }
    isFocused() { return this.focused; }
    moveTop() { calls.push("moveTop"); }
    isVisible() { return this.visible; }
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop(...args) { this.alwaysOnTop.push(args); calls.push(`setAlwaysOnTop(${args.join(",")})`); }
    setVisibleOnAllWorkspaces(...args) { this.workspaces = args; }
    setPosition(x, y) { this.position = [x, y]; this.bounds = { ...this.bounds, x, y }; }
    setBounds(bounds) { calls.push(`setBounds ${bounds.width}x${bounds.height}`); this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    getNormalBounds() { return this.normalBounds; }
    loadURL(url) { calls.push(`loadURL ${url}`); }
    loadFile(file) { calls.push(`loadFile ${file}`); }
  }
  const app = { focus: (opts) => calls.push(`app.focus(${JSON.stringify(opts)})`) };
  const errors = [];
  const dialog = { showErrorBox: (title, body) => errors.push({ title, body }) };
  const opened = [];
  const shell = { openExternal: async (url) => { opened.push(url); } };
  let resolveReady;
  const readyGate = new Promise((resolve) => { resolveReady = resolve; });
  const readyCalls = [];
  const windows = createWindowManager({
    ctx,
    app,
    BrowserWindow,
    dialog,
    shell,
    waitForReady: async (opts) => { readyCalls.push(opts); await readyGate; return ready; },
    screen,
    boundsStore,
    boundsSaveDelayMs,
    widgetPrefs,
    platform,
    fileExists,
    ...(watchWindow ? { watchWindow } : {}),
    ...(onStartupFailed ? { onStartupFailed } : {}),
  });
  return { ctx, state: ctx.state, calls, created, errors, opened, windows, readyCalls, savedList, prefs: () => prefs, openReadyGate: () => resolveReady() };
}

test("主窗口：sandbox + contextIsolation + preload；就绪探测通过后才 loadURL", async () => {
  const h = makeHarness();
  const pending = h.windows.createMainWindow();
  assert.equal(h.created.length, 1);
  const win = h.created[0];
  assert.equal(h.state.mainWindow, win);
  assert.deepEqual(win.options.webPreferences, { preload: h.ctx.preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(win.options.title, h.ctx.appDisplayName);
  assert.equal(win.options.show, false);
  assert.ok(!h.calls.some((c) => c.startsWith("loadURL")), "探测完成前不加载");
  h.openReadyGate();
  await pending;
  assert.equal(h.readyCalls[0].url, h.ctx.statusLiteUrl);
  assert.equal(h.readyCalls[0].token, h.ctx.authToken);
  assert.equal(h.calls.at(-1), "loadURL http://127.0.0.1:8877");
});

test("主窗口标题栏：macOS 隐藏标题栏嵌红绿灯；Windows 保留系统标题栏（否则没有关闭按钮），安装版带图标", () => {
  const mac = makeHarness();
  mac.windows.createMainWindow();
  assert.equal(mac.created[0].options.titleBarStyle, "hiddenInset");
  assert.equal(mac.created[0].options.icon, undefined);

  const win = makeHarness({ platform: "win32", fileExists: (file) => file.endsWith("app-icon.ico") });
  win.windows.createMainWindow();
  assert.equal(win.created[0].options.titleBarStyle, undefined);
  assert.equal(win.created[0].options.trafficLightPosition, undefined);
  assert.equal(win.created[0].options.icon, win.ctx.windowIconPath);
  assert.equal(win.created[0].options.autoHideMenuBar, true);

  // 源码运行（没有 resources\\app-icon.ico）：不传 icon，Electron 用 exe 自带的。
  const source = makeHarness({ platform: "win32" });
  source.windows.createMainWindow();
  assert.equal(source.created[0].options.icon, undefined);
});

test("主窗口：15s 未就绪弹错误框；等待期间窗口被关掉则什么都不做", async () => {
  const h = makeHarness({ ready: false });
  const pending = h.windows.createMainWindow();
  h.openReadyGate();
  await pending;
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].title, "启动失败");
  assert.match(h.errors[0].body, /8877 端口占用/);

  const h2 = makeHarness();
  const pending2 = h2.windows.createMainWindow();
  h2.state.mainWindow.handlers.closed();
  h2.openReadyGate();
  await pending2;
  assert.ok(!h2.calls.some((c) => c.startsWith("loadURL")));
  assert.equal(h2.errors.length, 0);
});

test("主窗口：关闭按钮默认隐藏（托盘常驻），显式退出时才真正关闭", () => {
  const h = makeHarness();
  h.windows.createMainWindow();
  const win = h.created[0];
  let prevented = 0;
  win.handlers.close({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(h.calls.at(-1), "hide");
  h.state.isQuitting = true;
  win.handlers.close({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
});

test("主窗口：已存在则只显示并聚焦一次（不反复抢焦点、不临时置顶，避免启动抖动）", () => {
  const h = makeHarness();
  h.windows.createMainWindow();
  const win = h.created[0];
  win.minimized = true;
  h.calls.length = 0;
  h.windows.createMainWindow();
  assert.equal(h.created.length, 1, "不重复创建");
  assert.deepEqual(h.calls, ["restore", "show", "moveTop", 'app.focus({"steal":true})', "focus", "setAlwaysOnTop(false)"]);
  assert.ok(!win.alwaysOnTop.some(([on]) => on === true), "绝不临时置顶");
  // ready-to-show 同样只聚焦一次
  h.calls.length = 0;
  win.handlers["once:ready-to-show"]();
  assert.equal(h.calls.filter((c) => c === "focus").length, 1);
});

test("重启界面进行中：不创建新窗口（由新实例重建）", async () => {
  const h = makeHarness();
  h.state.controlPlaneRestarting = true;
  await h.windows.createMainWindow();
  assert.equal(h.created.length, 0);
});

test("悬浮岛：sandbox、只加载 island.html、失焦隐藏、关闭后清空句柄", () => {
  const h = makeHarness();
  h.windows.createIslandWindow();
  const island = h.state.islandWindow;
  assert.deepEqual(island.options.webPreferences, { preload: h.ctx.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true });
  assert.equal(island.options.show, false);
  assert.deepEqual(island.alwaysOnTop, [[true, "status"]]);
  assert.deepEqual(island.workspaces, [true, { visibleOnFullScreen: true }]);
  assert.equal(h.calls.at(-1), `loadFile ${h.ctx.islandHtmlPath}`);
  island.visible = true;
  island.handlers.blur();
  assert.equal(island.visible, false);
  island.handlers.closed();
  assert.equal(h.state.islandWindow, null);
});

test("悬浮岛切换：按需创建，定位在托盘图标正下方居中；再点一次收起", () => {
  const h = makeHarness();
  h.state.tray = { getBounds: () => ({ x: 1000, y: 0, width: 24, height: 22 }) };
  h.windows.toggleIslandWindow();
  const island = h.state.islandWindow;
  assert.ok(island);
  assert.deepEqual(island.position, [1000 + 12 - 160, 26]);
  assert.equal(island.visible, true);
  h.windows.toggleIslandWindow();
  assert.equal(h.created.length, 1, "不重复创建");
  assert.equal(island.visible, false);
});

test("悬浮岛钉在桌面：失焦不收起、换到浮窗层、立刻显示并记下位置；页面收到 island-pinned", () => {
  const h = makeHarness();
  h.state.tray = { getBounds: () => ({ x: 1000, y: 0, width: 24, height: 22 }) };
  assert.equal(h.windows.isIslandPinned(), false);
  assert.equal(h.windows.setIslandPinned(true), true);
  const island = h.state.islandWindow;
  assert.equal(island.visible, true, "从托盘菜单钉住：没打开就打开");
  assert.deepEqual(island.alwaysOnTop.at(-1), [true, "floating"]);
  assert.deepEqual(island.workspaces, [true, { visibleOnFullScreen: false }], "钉住的小组件不跟进全屏应用");
  assert.deepEqual(h.prefs().islandPosition, { x: 852, y: 26 });
  assert.deepEqual(island.sent, [["island-pinned", true]]);
  island.handlers.blur();
  assert.equal(island.visible, true, "钉住时失焦不收起");

  // 取消钉住：回到 status 层；当前没有焦点就收起
  island.focused = false;
  h.windows.setIslandPinned(false);
  assert.deepEqual(island.alwaysOnTop.at(-1), [true, "status"]);
  assert.deepEqual(island.workspaces, [true, { visibleOnFullScreen: true }]);
  assert.equal(island.visible, false);
  assert.deepEqual(island.sent.at(-1), ["island-pinned", false]);
  assert.equal(h.prefs().islandPinned, false);
});

test("悬浮岛钉住：拖动停下来才记位置；下次打开回到记下的位置（屏幕没了退回托盘下方）", async () => {
  const screen = { getAllDisplays: () => [{ workArea: { x: 0, y: 25, width: 1440, height: 875 } }] };
  const h = makeHarness({ screen, boundsSaveDelayMs: 5, widget: { islandPinned: true, islandPosition: { x: 40, y: 500 } } });
  h.state.tray = { getBounds: () => ({ x: 1000, y: 0, width: 24, height: 22 }) };
  h.windows.toggleIslandWindow();
  const island = h.state.islandWindow;
  assert.deepEqual(island.position, [40, 500]);
  assert.deepEqual(island.alwaysOnTop, [[true, "floating"]], "钉住状态下新建的窗口直接在浮窗层");
  island.setPosition(60, 520);
  island.handlers.move();
  island.handlers.move();
  assert.deepEqual(h.prefs().islandPosition, { x: 40, y: 500 }, "拖动中不写");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(h.prefs().islandPosition, { x: 60, y: 520 });

  const gone = makeHarness({ screen, widget: { islandPinned: true, islandPosition: { x: 4000, y: 500 } } });
  gone.state.tray = { getBounds: () => ({ x: 1000, y: 0, width: 24, height: 22 }) };
  gone.windows.toggleIslandWindow();
  assert.deepEqual(gone.state.islandWindow.position, [852, 26]);
});

test("悬浮岛高度跟内容走：宽度固定、上沿不动、夹在范围内；没变不重设", () => {
  const h = makeHarness();
  h.windows.resizeIslandWindow(260);
  h.windows.createIslandWindow();
  const island = h.state.islandWindow;
  island.setPosition(100, 30);
  h.windows.resizeIslandWindow(260.4);
  assert.deepEqual(island.getBounds(), { x: 100, y: 30, width: ISLAND_WIDTH, height: 260 });
  h.windows.resizeIslandWindow(5000);
  assert.equal(island.getBounds().height, ISLAND_HEIGHT_RANGE.max);
  h.windows.resizeIslandWindow(10);
  assert.equal(island.getBounds().height, ISLAND_HEIGHT_RANGE.min);
  const before = h.calls.filter((c) => c.startsWith("setBounds")).length;
  h.windows.resizeIslandWindow(ISLAND_HEIGHT_RANGE.min);
  h.windows.resizeIslandWindow(Number.NaN);
  assert.equal(h.calls.filter((c) => c.startsWith("setBounds")).length, before);
});

test("导航加固：window.open 一律拒绝（http(s) 交系统浏览器），导航只放行白名单", () => {
  const h = makeHarness();
  h.windows.createMainWindow();
  h.windows.createIslandWindow();
  const [main, island] = h.created;
  for (const win of [main, island]) {
    assert.deepEqual(win.webContents.handlers.windowOpen({ url: "https://docs.example/x" }), { action: "deny" });
    assert.deepEqual(win.webContents.handlers.windowOpen({ url: "file:///etc/passwd" }), { action: "deny" });
  }
  assert.deepEqual(h.opened, ["https://docs.example/x", "https://docs.example/x"]);
  const navigate = (win, url) => {
    let prevented = false;
    for (const name of ["will-navigate", "will-redirect"]) {
      win.webContents.handlers[name]({ preventDefault: () => { prevented = true; } }, url);
    }
    return prevented;
  };
  assert.equal(navigate(main, "http://127.0.0.1:8877/#/servers"), false);
  assert.equal(navigate(main, "http://127.0.0.1:8877@evil.example/"), true);
  assert.equal(navigate(island, pathToFileURL(h.ctx.islandHtmlPath).href), false);
  assert.equal(navigate(island, pathToFileURL("/tmp/poisoned.html").href), true);
});

// ---- 主窗口的大小与位置（window-bounds.mjs） ----

const DISPLAY = (x, y, width, height) => ({ workArea: { x, y, width, height } });
const fakeScreen = (displays) => ({ getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] });

test("主窗口：没有记录时用默认大小 1280×860，位置交给系统居中", () => {
  const h = makeHarness({ screen: fakeScreen([DISPLAY(0, 25, 1728, 1050)]) });
  h.windows.createMainWindow();
  const { width, height } = h.created[0].options;
  assert.deepEqual([width, height], [1280, 860]);
  assert.equal("x" in h.created[0].options, false);
  assert.equal("y" in h.created[0].options, false);
});

test("主窗口：恢复上次的大小与位置；屏幕装不下的默认大小收进工作区", () => {
  const restored = makeHarness({ savedBounds: { x: 200, y: 120, width: 1440, height: 900 }, screen: fakeScreen([DISPLAY(0, 25, 1728, 1050)]) });
  restored.windows.createMainWindow();
  const { x, y, width, height } = restored.created[0].options;
  assert.deepEqual([x, y, width, height], [200, 120, 1440, 900]);

  const small = makeHarness({ screen: fakeScreen([DISPLAY(0, 25, 1152, 695)]) });
  small.windows.createMainWindow();
  assert.deepEqual([small.created[0].options.width, small.created[0].options.height], [1152, 695]);

  // 取不到显示器信息（没有注入 screen）：照记录恢复大小，不做位置校正
  const blind = makeHarness({ savedBounds: { x: 5, y: 5, width: 900, height: 700 } });
  blind.windows.createMainWindow();
  assert.deepEqual([blind.created[0].options.width, blind.created[0].options.height], [900, 700]);
});

test("主窗口：关闭（隐藏到托盘）时立刻记下摆放；缩放 / 移动停下来后才写一次", async () => {
  const h = makeHarness({ boundsSaveDelayMs: 5 });
  h.windows.createMainWindow();
  const win = h.created[0];
  win.normalBounds = { x: 10, y: 20, width: 1100, height: 800 };
  win.handlers.close({ preventDefault() {} });
  assert.deepEqual(h.savedList, [{ x: 10, y: 20, width: 1100, height: 800 }]);

  // 连续的 resize / move 只落一次盘，且取停下来时的矩形
  h.savedList.length = 0;
  win.handlers.resize();
  win.handlers.move();
  win.handlers.resize();
  win.normalBounds = { x: 30, y: 40, width: 1300, height: 900 };
  assert.deepEqual(h.savedList, [], "还在拖动：不写");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.savedList, [{ x: 30, y: 40, width: 1300, height: 900 }]);

  // 窗口销毁后迟到的定时器不再读窗口
  h.savedList.length = 0;
  win.handlers.resize();
  win.destroyed = true;
  win.handlers.closed();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(h.savedList, []);
});

test("crash-watch 接线：主窗口与悬浮岛建好即交给 watchWindow；重载分别是 loadURL / loadFile，放弃时主窗口弹框、悬浮岛关掉", async () => {
  const watched = [];
  const h = makeHarness({ watchWindow: (win, options) => watched.push({ win, ...options }) });
  const pending = h.windows.createMainWindow();
  h.windows.createIslandWindow();
  assert.deepEqual(watched.map((w) => [w.label, w.onGiveUp]), [["main", "prompt"], ["island", "close"]]);
  assert.equal(watched[0].win, h.created[0]);
  assert.equal(watched[1].win, h.created[1]);
  watched[0].reload();
  watched[1].reload();
  assert.deepEqual(h.calls.slice(-2), ["loadURL http://127.0.0.1:8877", `loadFile ${h.ctx.islandHtmlPath}`]);
  h.openReadyGate();
  await pending;
});

test("后端 15 秒未就绪：先记启动失败（desktop 日志），再弹错误框", async () => {
  const failures = [];
  const h = makeHarness({ ready: false, onStartupFailed: (info) => failures.push(info) });
  const pending = h.windows.createMainWindow();
  h.openReadyGate();
  await pending;
  assert.deepEqual(failures, [{ reason: "monitor-not-ready", timeoutMs: 15000, url: "http://127.0.0.1:8877" }]);
  assert.equal(h.errors.length, 1);
});

test("悬浮岛弹出位置：菜单栏在上贴在下面；任务栏在下放到上面；收进工作区", () => {
  const size = { width: 320, height: 300 };
  // macOS：菜单栏托盘，工作区从菜单栏下沿开始。
  assert.deepEqual(positionNearTray({ x: 1000, y: 0, width: 24, height: 24 }, size, { x: 0, y: 25, width: 1440, height: 875 }), { x: 852, y: 28 });
  // 拿不到工作区：保持老行为（下方居中）。
  assert.deepEqual(positionNearTray({ x: 1000, y: 0, width: 24, height: 24 }, size), { x: 852, y: 28 });
  // Windows：任务栏在底部，托盘在右下角——放在托盘上方，右边不出屏。
  assert.deepEqual(positionNearTray({ x: 1850, y: 1044, width: 32, height: 32 }, size, { x: 0, y: 0, width: 1920, height: 1040 }), { x: 1600, y: 740 });
});
