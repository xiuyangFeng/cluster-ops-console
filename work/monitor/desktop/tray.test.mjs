import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { TRAY_STATUS_DOT } from "./tray-icon.mjs";
import { createTrayController, describeTransitionNotice, healthLabel, readAlertConfirmMs, trayHealthFromStatus, trayIconColor } from "./tray.mjs";

function makeTimers() {
  const pending = [];
  const add = (kind) => (fn, ms) => {
    const t = { kind, fn, ms, unref() { this.unrefed = true; } };
    pending.push(t);
    return t;
  };
  const remove = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  return { pending, setTimeout: add("timeout"), setInterval: add("interval"), clearTimeout: remove, clearInterval: remove };
}

function makeHarness({ config = null, layered = null, now = 1_000_000, platform = "darwin" } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const calls = [];
  const notifications = [];
  class Tray {
    constructor(icon) { this.icon = icon; this.handlers = {}; this.images = [icon]; this.tooltips = []; }
    setToolTip(text) { this.tooltips.push(text); }
    setImage(icon) { this.images.push(icon); }
    on(name, fn) { this.handlers[name] = fn; }
    popUpContextMenu(menu) { this.menu = menu; }
  }
  class Notification {
    constructor(opts) { this.opts = opts; notifications.push(this); }
    on(_name, fn) { this.click = fn; }
    show() {}
  }
  const Menu = { buildFromTemplate: (template) => template };
  // 图标是 BGRA 位图：记下状态点中心的颜色（#rrggbb）与字形节点像素（判断深浅色字形）
  const hex = (v) => v.toString(16).padStart(2, "0");
  const pixel = (buf, w, x, y) => {
    const i = (y * w + x) * 4;
    return { color: `#${hex(buf[i + 2])}${hex(buf[i + 1])}${hex(buf[i])}`, alpha: buf[i + 3] };
  };
  const nativeImage = {
    createFromBitmap: (buf, opts) => {
      const dot = pixel(buf, opts.width, Math.round(TRAY_STATUS_DOT.x), Math.round(TRAY_STATUS_DOT.y));
      return { opts, center: dot.color, alpha: dot.alpha, glyph: pixel(buf, opts.width, 8, 9).color };
    },
  };
  const themeListeners = [];
  const nativeTheme = { shouldUseDarkColors: true, on: (name, fn) => themeListeners.push([name, fn]) };
  const subscriptions = [];
  const subscribe = (opts) => {
    const sub = { opts, started: 0, stopped: 0, connected: false };
    sub.start = () => { sub.started += 1; };
    sub.stop = () => { sub.stopped += 1; };
    sub.isConnected = () => sub.connected;
    subscriptions.push(sub);
    return sub;
  };
  const fetches = [];
  let clock = now;
  const timers = makeTimers();
  Object.assign(ctx.actions, {
    toggleIslandWindow: () => calls.push("toggleIslandWindow"),
    createMainWindow: () => calls.push("createMainWindow"),
    restartControlPlane: (source) => calls.push(`restartControlPlane ${source}`),
    requestQuit: () => calls.push("requestQuit"),
    isIslandPinned: () => islandPinned,
    setIslandPinned: (pinned) => { calls.push(`setIslandPinned ${pinned}`); islandPinned = pinned; return pinned; },
    getTrayMetric: () => trayMetric,
    setTrayMetric: (metric) => { calls.push(`setTrayMetric ${metric}`); trayMetric = metric; },
  });
  let islandPinned = false;
  let trayMetric = "gpu";
  const tray = createTrayController({
    ctx,
    Tray,
    Menu,
    nativeImage,
    Notification,
    nativeTheme,
    fetchImpl: async (url, opts) => { fetches.push({ url, opts }); return { json: async () => ({ health: "ready" }) }; },
    subscribe,
    readFileSync: () => { if (!config) throw new Error("ENOENT"); return JSON.stringify(config); },
    // layered = 分层配置（服务器 / Agent 名称）；不给时与配置文件不存在同样处理
    existsSync: () => Boolean(layered),
    loadConfig: () => layered,
    now: () => clock,
    timers,
    logger: { error() {} },
    platform,
  });
  return {
    ctx,
    state: ctx.state,
    calls,
    notifications,
    subscriptions,
    fetches,
    timers,
    tray,
    nativeTheme,
    themeListeners,
    advance: (ms) => { clock += ms; },
  };
}

const statusWith = (fields) => ({ health: "ready", recentTransitions: [], ...fields });

test("纯函数：健康标签、transport 优先的健康映射、图标颜色", () => {
  assert.equal(healthLabel("ready"), "正常");
  assert.equal(healthLabel("nope"), "未知");
  const summary = { schemaVersion: 1, transport: { state: "connected" }, incidentCount: 0, headline: "全部正常" };
  assert.deepEqual(trayHealthFromStatus({ summary, health: "down" }), { summary, health: "ready" });
  assert.equal(trayHealthFromStatus({ summary: { ...summary, transport: { state: "weird" } } }).health, "waiting");
  assert.deepEqual(trayHealthFromStatus({ health: "degraded" }), { summary: null, health: "degraded" });
  assert.equal(trayHealthFromStatus({}).health, "down", "旧后端缺 health 视为异常");
  assert.equal(trayIconColor("ready", summary), "#34d399");
  assert.equal(trayIconColor("ready", { ...summary, incidentCount: 2 }), "#fbbf24", "通路好但有待处理检查 → amber");
  assert.equal(trayIconColor("degraded"), "#fbbf24");
  assert.equal(trayIconColor("waiting"), "#fbbf24");
  assert.equal(trayIconColor("down"), "#f87171");
  assert.equal(trayIconColor("stopped"), "#9ca3af");
});

test("告警确认期：默认 30s，可由 config.json alerting.confirmMs 覆盖", () => {
  assert.equal(readAlertConfirmMs("/x", () => { throw new Error("ENOENT"); }), 30000);
  assert.equal(readAlertConfirmMs("/x", () => JSON.stringify({ alerting: { confirmMs: 5000 } })), 5000);
  assert.equal(readAlertConfirmMs("/x", () => JSON.stringify({ alerting: { confirmMs: -1 } })), 30000);
});

test("createTray：灰色等待态；左键切悬浮岛；SSE 延后 3s 订阅，30s 兜底轮询；幂等", () => {
  const h = makeHarness();
  h.tray.createTray();
  const tray = h.state.tray;
  assert.equal(tray.icon.center, "#9ca3af");
  assert.equal(tray.icon.alpha, 255);
  assert.match(tray.icon.glyph, /^#f[0-9a-f]f[0-9a-f]f[0-9a-f]$/, "深色外观：近白字形（预乘 alpha 0.95）");
  assert.deepEqual(tray.icon.opts, { width: 36, height: 36, scaleFactor: 2 });
  assert.deepEqual(tray.tooltips, ["集群运维工作台"]);
  tray.handlers.click();
  assert.deepEqual(h.calls, ["toggleIslandWindow"]);
  const [interval] = h.timers.pending.filter((t) => t.kind === "interval");
  const [first] = h.timers.pending.filter((t) => t.kind === "timeout");
  assert.equal(h.state.statusInterval, interval);
  assert.equal(interval.ms, 30000);
  assert.equal(first.ms, 3000);
  assert.equal(first.unrefed, true);
  const sub = h.subscriptions[0];
  assert.equal(sub.opts.url, "http://127.0.0.1:8877/api/events");
  assert.deepEqual(sub.opts.headers, { "x-auth-token": h.ctx.authToken });
  first.fn();
  assert.equal(sub.started, 1);
  // 退出中（cleanupBackground 置 serverExiting）→ 停止重连
  assert.equal(sub.opts.shouldRun(), true);
  h.state.serverExiting = true;
  assert.equal(sub.opts.shouldRun(), false);
  interval.fn();
  assert.equal(sub.stopped, 1);
  h.tray.createTray();
  assert.equal(h.subscriptions.length, 1, "已有托盘时不重复创建");
});

test("状态推送：只在健康层级变化时重绘；monitor 不可达即刻变红", async () => {
  const h = makeHarness();
  h.tray.createTray();
  const tray = h.state.tray;
  h.tray.applyTrayStatus(statusWith({ health: "ready" }));
  h.tray.applyTrayStatus(statusWith({ health: "ready" }));
  assert.equal(tray.images.length, 2, "同层级不重绘");
  assert.deepEqual(tray.tooltips.at(-1), "集群运维工作台 · 正常");
  h.tray.markTrayDown();
  h.tray.markTrayDown();
  assert.equal(tray.images.length, 3);
  assert.equal(tray.images.at(-1).center, "#f87171");
  assert.equal(tray.tooltips.at(-1), "集群运维工作台 · 监控服务不可达");
  // SSE 掉线 → 立即轮询一次 status-lite
  h.subscriptions[0].opts.onDown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.fetches[0].url, h.ctx.statusLiteUrl);
  assert.deepEqual(h.fetches[0].opts.headers, { "x-auth-token": h.ctx.authToken });
  assert.equal(tray.tooltips.at(-1), "集群运维工作台 · 正常");
});

const LAYERED = {
  activeServerId: "server-01",
  servers: [{ id: "server-01", name: "主集群服务器" }, { id: "server-aliyun", name: "阿里云服务器 (vpn-aliyun)" }],
  agents: [{ id: "codex", name: "Codex" }, { id: "claude-codewing", name: "Claude CodeWing" }],
};

test("describeTransitionNotice: 通知写界面用语——哪台服务器的隧道 / 哪个 Agent / 数据通道", () => {
  const names = { servers: { "server-01": "主集群服务器", "server-aliyun": "阿里云服务器 (vpn-aliyun)" }, agents: { codex: "Codex" }, activeServerId: "server-01" };
  assert.deepEqual(describeTransitionNotice({ key: "tunnel:server-aliyun", from: "ok", to: "error", reason: "隧道断开" }, "alert", names),
    { title: "连接告警", body: "阿里云的隧道断开：隧道断开" });
  assert.deepEqual(describeTransitionNotice({ key: "tunnel:server-aliyun", from: "error", to: "ok" }, "recovery", names),
    { title: "已恢复", body: "阿里云的隧道已恢复" });
  assert.deepEqual(describeTransitionNotice({ key: "channel", from: "ok", to: "error", reason: "SSH 隧道未建立" }, "alert", names),
    { title: "连接告警", body: "主集群的数据通道中断：SSH 隧道未建立" });
  assert.deepEqual(describeTransitionNotice({ key: "channel", from: "error", to: "ok" }, "recovery", names),
    { title: "已恢复", body: "主集群的数据通道已恢复" });
  assert.deepEqual(describeTransitionNotice({ key: "agent:codex", from: "ok", to: "error", reason: "端点不可达" }, "alert", names),
    { title: "Agent 告警", body: "Codex 不可用：端点不可达" });
  assert.deepEqual(describeTransitionNotice({ key: "agent:codex", from: "error", to: "ok" }, "recovery", names),
    { title: "已恢复", body: "Codex 已恢复" });
  // 查不到名称（配置读不到 / 服务器刚被删）：退回 id，通知照发；没有原因就不带冒号
  assert.deepEqual(describeTransitionNotice({ key: "tunnel:server-x", from: "ok", to: "error" }, "alert"),
    { title: "连接告警", body: "server-x的隧道断开" });
  assert.deepEqual(describeTransitionNotice({ key: "channel", to: "error", reason: "r" }, "alert"), { title: "连接告警", body: "数据通道中断：r" });
  assert.deepEqual(describeTransitionNotice({ key: "agent:zcode", to: "error" }, "alert", names), { title: "Agent 告警", body: "zcode 不可用" });
});

test("状态变迁告警：→error 先挂起确认期，到期才通知；resources 层不打扰", () => {
  const h = makeHarness({ config: { alerting: { confirmMs: 5000 } }, layered: LAYERED });
  h.tray.createTray();
  const ts = 1_000_001;
  h.tray.applyTrayStatus(statusWith({
    recentTransitions: [
      { key: "tunnel:server-aliyun", from: "ok", to: "error", ts, layer: "tunnels", reason: "exit 255" },
      { key: "res:server-01", from: "ok", to: "error", ts, layer: "resources" },
    ],
  }));
  assert.equal(h.notifications.length, 0, "确认期内不通知");
  const flush = h.timers.pending.find((t) => t.kind === "timeout" && t.ms === 5050);
  assert.ok(flush, "按最早 dueAt 定时冲刷");
  h.advance(5000);
  flush.fn();
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].opts.title, "连接告警");
  assert.equal(h.notifications[0].opts.body, "阿里云的隧道断开：exit 255", "正文是界面用语，不是内部键与级别");

  // 恢复：同一个键 60 秒内不重复打扰（抖动抑制），过后才发「已恢复」
  h.advance(61_000);
  h.tray.applyTrayStatus(statusWith({
    recentTransitions: [{ key: "tunnel:server-aliyun", from: "error", to: "ok", ts: ts + 70_000, layer: "tunnels", reason: "隧道正常" }],
  }));
  assert.equal(h.notifications.length, 2);
  assert.deepEqual(h.notifications[1].opts, { title: "已恢复", body: "阿里云的隧道已恢复" });
});

test("状态变迁告警：配置读不到时名称退回 id，通知照发", () => {
  const h = makeHarness({ config: { alerting: { confirmMs: 1000 } } });
  h.tray.createTray();
  h.tray.applyTrayStatus(statusWith({
    recentTransitions: [{ key: "agent:codex", from: "ok", to: "error", ts: 1_000_001, layer: "agents", reason: "端点不可达" }],
  }));
  h.advance(1000);
  h.timers.pending.find((t) => t.kind === "timeout" && t.ms === 1050).fn();
  assert.deepEqual(h.notifications[0].opts, { title: "Agent 告警", body: "codex 不可用：端点不可达" });
});

test("托盘菜单：状态行、待生效更新入口、重启界面 / 退出都经动作表", () => {
  const h = makeHarness();
  h.tray.createTray();
  let menu = h.tray.buildTrayMenu();
  assert.equal(menu[0].label, "状态：检测中");
  assert.equal(menu[0].enabled, false);
  assert.ok(!menu.some((item) => item.label?.startsWith("新版本")));
  assert.equal(menu.find((item) => item.label === "隐藏主控制台").enabled, false);
  h.state.pendingBundleUpdate = { version: "2.29.0", gitCommit: "", builtAt: "", key: "k" };
  h.state.mainWindow = { hide: () => h.calls.push("hide") };
  menu = h.tray.buildTrayMenu();
  assert.equal(menu[1].label, "新版本 v2.29.0 已安装 · 重启界面（隧道不中断）");
  menu[1].click();
  const byLabel = (label) => menu.find((item) => item.label === label);
  byLabel("打开主控制台").click();
  byLabel("隐藏主控制台").click();
  byLabel("显示状态面板").click();
  byLabel("重启界面（隧道不中断）").click();
  byLabel("退出并停止后台").click();
  assert.deepEqual(h.calls, [
    "restartControlPlane tray-update",
    "createMainWindow",
    "hide",
    "toggleIslandWindow",
    "restartControlPlane tray",
    "requestQuit",
  ]);
  byLabel("重启所有连接（完整通道自愈）").click();
  assert.equal(h.fetches.at(-1).url, "http://127.0.0.1:8877/api/restart");
  assert.equal(h.fetches.at(-1).opts.method, "POST");
  // 右键弹出同一份菜单
  h.state.tray.handlers["right-click"]();
  assert.equal(h.state.tray.menu[0].label, "状态：检测中");
});

test("托盘菜单：状态面板钉在桌面（勾选取打开那一刻的状态）；菜单栏显示只在 macOS 出现", () => {
  const h = makeHarness();
  h.tray.createTray();
  let menu = h.tray.buildTrayMenu();
  const pin = menu.find((item) => item.label === "状态面板钉在桌面");
  assert.equal(pin.type, "checkbox");
  assert.equal(pin.checked, false);
  pin.click();
  menu = h.tray.buildTrayMenu();
  assert.equal(menu.find((item) => item.label === "状态面板钉在桌面").checked, true);
  menu.find((item) => item.label === "状态面板钉在桌面").click();
  const metrics = menu.find((item) => item.label === "菜单栏显示").submenu;
  assert.deepEqual(metrics.map((item) => [item.label, item.type, item.checked]), [
    ["GPU 在用", "radio", true],
    ["CPU 核分配", "radio", false],
    ["我的作业", "radio", false],
    ["不显示", "radio", false],
  ]);
  metrics[3].click();
  assert.deepEqual(h.calls, ["setIslandPinned true", "setIslandPinned false", "setTrayMetric off"]);
  assert.equal(h.tray.buildTrayMenu().find((item) => item.label === "菜单栏显示").submenu[3].checked, true);

  const win = makeHarness({ platform: "win32" });
  win.tray.createTray();
  assert.ok(!win.tray.buildTrayMenu().some((item) => item.label === "菜单栏显示"), "托盘标题只有 macOS 菜单栏能显示");
});

test("系统外观切到浅色：按当前状态色重绘为黑色字形", () => {
  const h = makeHarness();
  h.tray.createTray();
  const tray = h.state.tray;
  const updated = h.themeListeners.find(([name]) => name === "updated");
  assert.ok(updated, "订阅了 nativeTheme updated");
  h.nativeTheme.shouldUseDarkColors = false;
  updated[1]();
  const latest = tray.images.at(-1);
  assert.equal(latest.glyph, "#000000");
  assert.equal(latest.center, "#9ca3af", "状态色不变");
});
