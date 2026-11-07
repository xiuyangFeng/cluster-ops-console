import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import path from "node:path";

import { createCrashWatch, createReloadBudget, describeError, RENDERER_MAX_AUTO_RELOADS, RENDERER_RELOAD_WINDOW_MS, STARTUP_ERROR_TITLE, startupErrorText } from "./crash-watch.mjs";

function makeLogger() {
  const rows = [];
  const push = (level) => (message, fields) => rows.push({ level, message, ...fields });
  return { rows, info: push("info"), warn: push("warn"), error: push("error") };
}

function makeWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  win.destroyed = false;
  win.isDestroyed = () => win.destroyed;
  win.destroy = () => { win.destroyed = true; };
  return win;
}

function makeHarness({ promptResponse = 0 } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const logger = makeLogger();
  let now = 1_000_000;
  const timers = [];
  const prompts = [];
  const dialog = { showMessageBox: async (win, options) => { prompts.push({ win, options }); return { response: promptResponse }; } };
  const watch = createCrashWatch({
    ctx, dialog, logger,
    now: () => now,
    timers: { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } },
  });
  const runTimers = () => { while (timers.length) timers.shift().fn(); };
  return { ctx, logger, watch, prompts, timers, runTimers, advance: (ms) => { now += ms; } };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("createReloadBudget：窗口内第 3 次（含）以内重载，第 4 次放弃；滑出窗口的不算", () => {
  let now = 0;
  const budget = createReloadBudget({ now: () => now });
  assert.deepEqual([budget.record(), budget.record(), budget.record()], ["reload", "reload", "reload"]);
  assert.equal(budget.record(), "give-up");
  assert.equal(budget.count(), RENDERER_MAX_AUTO_RELOADS + 1);
  now = RENDERER_RELOAD_WINDOW_MS + 1;
  assert.equal(budget.record(), "reload", "5 分钟前的几次已经滑出");
  assert.equal(budget.count(), 1);
});

test("describeError：Error 带栈，非 Error 也能记", () => {
  const info = describeError(new TypeError("bad"));
  assert.equal(info.name, "TypeError");
  assert.equal(info.message, "bad");
  assert.match(info.stack, /TypeError: bad/);
  assert.deepEqual(describeError("plain"), { name: "string", message: "plain", stack: "" });
  assert.equal(describeError({ code: 1 }).message, '{"code":1}');
  const circular = {};
  circular.self = circular;
  assert.equal(describeError(circular).message, "[object Object]");
});

test("主进程兜底：未捕获异常与未处理 rejection 写 desktop 日志（带栈），进程照常运行", () => {
  const h = makeHarness();
  const proc = new EventEmitter();
  h.watch.registerProcessGuards(proc);
  proc.emit("uncaughtException", new Error("boom"), "uncaughtException");
  proc.emit("unhandledRejection", new RangeError("nope"));
  assert.equal(h.logger.rows.length, 2);
  const [uncaught, rejection] = h.logger.rows;
  assert.deepEqual([uncaught.level, uncaught.event, uncaught.message, uncaught.via, uncaught.origin], ["error", "uncaught-exception", "主进程未捕获异常：boom", "uncaughtException", "main"]);
  assert.match(uncaught.stack, /Error: boom/);
  assert.deepEqual([rejection.event, rejection.name, rejection.message], ["unhandled-rejection", "RangeError", "主进程未处理的 Promise 拒绝：nope"]);
});

test("日志器自己抛错也不连锁出事", () => {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const throwing = { error() { throw new Error("disk full"); }, warn() { throw new Error("x"); }, info() { throw new Error("x"); } };
  const watch = createCrashWatch({ ctx, dialog: {}, logger: throwing });
  const proc = new EventEmitter();
  watch.registerProcessGuards(proc);
  assert.doesNotThrow(() => proc.emit("uncaughtException", new Error("boom")));
});

test("子进程退出：异常退出记 warn，正常退出记 info", () => {
  const h = makeHarness();
  const app = new EventEmitter();
  h.watch.watchApp(app);
  app.emit("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 139 });
  app.emit("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0, serviceName: "network.mojom.NetworkService", name: "Network Service" });
  assert.deepEqual(h.logger.rows.map((r) => [r.level, r.event, r.type, r.reason, r.exitCode]), [
    ["warn", "child-process-gone", "GPU", "crashed", 139],
    ["info", "child-process-gone", "Utility", "clean-exit", 0],
  ]);
  assert.equal(h.logger.rows[1].serviceName, "network.mojom.NetworkService");
});

test("界面进程异常退出：记原因与退出码，1 秒后自动重载；5 分钟内第 4 次起改为弹框，点「重新加载」才重载", async () => {
  const h = makeHarness({ promptResponse: 0 });
  const win = makeWindow();
  const reloads = [];
  h.watch.watchWindow(win, { label: "main", reload: () => reloads.push("main"), onGiveUp: "prompt" });
  for (let i = 0; i < 3; i += 1) {
    win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    assert.equal(h.timers.at(-1).ms, 1000);
    h.runTimers();
    h.advance(10_000);
  }
  assert.equal(reloads.length, 3);
  const gone = h.logger.rows.filter((r) => r.event === "render-process-gone");
  assert.deepEqual(gone.map((r) => [r.level, r.reason, r.exitCode, r.window, r.recentCount, r.action]), [
    ["error", "crashed", 11, "main", 1, "auto-reload"],
    ["error", "crashed", 11, "main", 2, "auto-reload"],
    ["error", "crashed", 11, "main", 3, "auto-reload"],
  ]);
  win.webContents.emit("render-process-gone", {}, { reason: "oom", exitCode: 9 });
  assert.equal(h.timers.length, 0, "第 4 次不再排自动重载");
  await flush();
  assert.equal(h.prompts.length, 1);
  assert.equal(h.prompts[0].win, win);
  assert.deepEqual(h.prompts[0].options.buttons, ["重新加载", "稍后"]);
  assert.match(h.prompts[0].options.detail, /5 分钟内退出了 4 次/);
  assert.equal(reloads.length, 4, "用户点了「重新加载」");
  assert.equal(h.logger.rows.at(-1).trigger, "user");
  assert.equal(gone.length + 1, h.logger.rows.filter((r) => r.event === "render-process-gone").length);
  assert.equal(h.logger.rows.filter((r) => r.event === "render-process-gone").at(-1).action, "prompt");
});

test("放弃后选「稍后」不重载；同一时刻只弹一个框", async () => {
  const h = makeHarness({ promptResponse: 1 });
  const win = makeWindow();
  const reloads = [];
  h.watch.watchWindow(win, { label: "main", reload: () => reloads.push(1) });
  for (let i = 0; i < 5; i += 1) win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  h.timers.length = 0;
  await flush();
  assert.equal(h.prompts.length, 1, "第 4、5 次连着来只弹一次");
  assert.equal(reloads.length, 0);
});

test("放弃时窗口收在托盘里（隐藏）：对话框不挂父窗口，免得看不见", async () => {
  const h = makeHarness({ promptResponse: 1 });
  const parentless = [];
  // harness 的 dialog 只认 (win, options)；这里换成能区分两种调用的
  const ctx = h.ctx;
  const watch = createCrashWatch({
    ctx,
    dialog: { showMessageBox: async (...args) => { parentless.push(args.length); return { response: 1 }; } },
    logger: h.logger,
    timers: { setTimeout: () => 0 },
  });
  const win = makeWindow();
  win.isVisible = () => false;
  watch.watchWindow(win, { label: "main", reload: () => {} });
  for (let i = 0; i < 4; i += 1) win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  await flush();
  assert.deepEqual(parentless, [1], "只传了选项");
});

test("悬浮岛放弃时直接关掉窗口（下次点托盘重建），不弹框", async () => {
  const h = makeHarness();
  const win = makeWindow();
  h.watch.watchWindow(win, { label: "island", reload: () => {}, onGiveUp: "close" });
  for (let i = 0; i < 4; i += 1) win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  await flush();
  assert.equal(win.destroyed, true);
  assert.equal(h.prompts.length, 0);
  assert.equal(h.logger.rows.at(-1).event, "renderer-give-up");
});

test("正常退出、退出 / 重启界面途中、窗口已销毁：只记一条，不重载", () => {
  const h = makeHarness();
  const win = makeWindow();
  const reloads = [];
  h.watch.watchWindow(win, { label: "main", reload: () => reloads.push(1) });
  win.webContents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
  h.ctx.state.isQuitting = true;
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  h.ctx.state.isQuitting = false;
  h.ctx.state.controlPlaneRestarting = true;
  win.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
  h.ctx.state.controlPlaneRestarting = false;
  win.destroyed = true;
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.equal(h.timers.length, 0);
  assert.equal(reloads.length, 0);
  assert.deepEqual(h.logger.rows.map((r) => [r.level, r.action]), [["info", "none"], ["info", "none"], ["info", "none"], ["info", "none"]]);
});

test("排好的自动重载在执行前遇到退出：不再重载", () => {
  const h = makeHarness();
  const win = makeWindow();
  const reloads = [];
  h.watch.watchWindow(win, { label: "main", reload: () => reloads.push(1) });
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  h.ctx.state.isQuitting = true;
  h.runTimers();
  assert.equal(reloads.length, 0);
});

test("无响应 / 恢复响应：恢复时记卡住多久；无响应期间界面进程没了也带上时长", () => {
  const h = makeHarness();
  const win = makeWindow();
  h.watch.watchWindow(win, { label: "main", reload: () => {} });
  win.emit("unresponsive");
  win.emit("unresponsive"); // 重复事件不重复记
  h.advance(12_400);
  win.emit("responsive");
  win.emit("responsive");
  assert.deepEqual(h.logger.rows.map((r) => [r.level, r.event, r.stuckMs]), [["warn", "unresponsive", undefined], ["info", "responsive", 12_400]]);
  assert.match(h.logger.rows[1].message, /卡住约 12 秒/);
  win.emit("unresponsive");
  h.advance(3000);
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.equal(h.logger.rows.at(-1).stuckMs, 3000);
});

test("重载本身抛错：记一条，不外抛", () => {
  const h = makeHarness();
  const win = makeWindow();
  h.watch.watchWindow(win, { label: "main", reload: () => { throw new Error("load failed"); } });
  win.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  assert.doesNotThrow(() => h.runTimers());
  assert.equal(h.logger.rows.at(-1).event, "renderer-reload-failed");
});

function startupHarness({ ready = false } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const logger = makeLogger();
  const boxes = [];
  const app = { ready, isReady() { return this.ready; } };
  const watch = createCrashWatch({ ctx, app, dialog: { showErrorBox: (title, body) => boxes.push({ title, body }) }, logger });
  const proc = new EventEmitter();
  watch.registerProcessGuards(proc);
  return { ctx, app, logger, boxes, proc };
}

test("启动期（app 没 ready）出错：照样记日志，另弹一次错误框（标题 + 首行消息 + 日志位置）；同一启动期只弹一次", () => {
  const h = startupHarness();
  h.proc.emit("uncaughtException", new Error("monitor-server 拉不起来\n第二行细节"), "uncaughtException");
  h.proc.emit("unhandledRejection", new Error("又一个"));
  assert.equal(h.logger.rows.length, 2, "两条都记了");
  assert.equal(h.boxes.length, 1, "只弹一次");
  assert.equal(h.boxes[0].title, STARTUP_ERROR_TITLE);
  const logFile = path.join(h.ctx.runtimePaths.logsDir, "desktop.ndjson");
  assert.equal(h.boxes[0].body, `monitor-server 拉不起来\n\n详细经过（含调用栈）已记在：\n${logFile}`);
  assert.doesNotMatch(h.boxes[0].body, /第二行细节/, "只带首行");
});

test("启动期的未处理 rejection 同样弹框；ready 了但还没有主窗口仍算启动期", () => {
  const h = startupHarness({ ready: true });
  h.proc.emit("unhandledRejection", new Error("startMonitorServer failed"));
  assert.equal(h.boxes.length, 1);
  assert.match(h.boxes[0].body, /^startMonitorServer failed\n/);
});

test("ready 且有主窗口之后只记日志不弹框；退出 / 重启界面途中也不弹", () => {
  const h = startupHarness({ ready: true });
  h.ctx.state.mainWindow = {};
  h.proc.emit("uncaughtException", new Error("later"));
  assert.equal(h.boxes.length, 0);
  assert.equal(h.logger.rows.length, 1);
  const q = startupHarness();
  q.ctx.state.isQuitting = true;
  q.proc.emit("uncaughtException", new Error("while quitting"));
  q.ctx.state.isQuitting = false;
  q.ctx.state.controlPlaneRestarting = true;
  q.proc.emit("uncaughtException", new Error("while restarting"));
  assert.equal(q.boxes.length, 0);
});

test("startupErrorText：空消息、超长首行都有合理的样子；弹框本身抛错不连锁出事", () => {
  assert.match(startupErrorText("", "/x/desktop.ndjson"), /^未知错误\n\n/);
  assert.equal(startupErrorText("a".repeat(500), "/x").split("\n")[0].length, 201);
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const watch = createCrashWatch({ ctx, app: { isReady: () => { throw new Error("x"); } }, dialog: { showErrorBox: () => { throw new Error("no display"); } }, logger: makeLogger() });
  const proc = new EventEmitter();
  watch.registerProcessGuards(proc);
  assert.doesNotThrow(() => proc.emit("uncaughtException", new Error("boom")));
});
