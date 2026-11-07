import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopJobNotices, createJobNoticesController } from "./job-notices.mjs";

const timers = { setTimeout: () => ({ unref() {} }), clearTimeout() {} };
function fakeNotification(shown) {
  return class {
    static isSupported() { return true; }
    constructor(options) { this.options = options; }
    on(event, fn) { if (event === "click") this.click = fn; }
    show() { shown.push(this); }
  };
}

test("原生提醒持久去重、静音不重放，点击传递服务器与作业 ID", async () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "job-notices-test-"));
  const shown = [];
  const navigations = [];
  let quietUntil = 200;
  const notifications = [{ id: "quiet", serverId: "s", title: "完成", jobIds: ["1"], readAt: null }];
  const options = { runtimeDir, timers, now: () => 100, Notification: fakeNotification(shown), fetchNotifications: async () => ({ settings: { quietUntil }, notifications }), onNavigate: (...args) => navigations.push(args) };
  try {
    const first = createJobNoticesController(options);
    await first.start();
    quietUntil = 0;
    await first.poll();
    assert.equal(shown.length, 0);
    notifications.unshift({ id: "new", serverId: "s", title: "新完成", jobIds: ["2"], readAt: null });
    await first.poll();
    await first.poll();
    assert.equal(shown.length, 1);
    shown[0].click();
    await Promise.resolve();
    assert.deepEqual(navigations, [["s", "2"]]);
    first.stop();
    const second = createJobNoticesController(options);
    await second.start();
    assert.equal(shown.length, 1, "热重启不得重复发送");
    second.stop();
  } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
});

test("关闭后迟到请求不发送通知；批量积压最多三个加汇总", async () => {
  let resolve;
  const shown = [];
  const controller = createJobNoticesController({ timers, Notification: fakeNotification(shown), fetchNotifications: () => new Promise((r) => { resolve = r; }) });
  const result = controller.start();
  controller.stop();
  resolve({ notifications: [{ id: "x" }] });
  await result;
  assert.equal(shown.length, 0);
  const batch = createJobNoticesController({ timers, Notification: fakeNotification(shown), fetchNotifications: async () => ({ notifications: Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, title: `${i}` })) }) });
  await batch.start();
  assert.equal(shown.length, 4);
  assert.match(shown.at(-1).options.body, /5 条/);
  batch.stop();
});

test("桌面装配鉴权读取，等待控制台页面加载后安全发送导航 IPC", async () => {
  const shown = [];
  const sent = [];
  let ready;
  let url = "about:blank";
  const win = { isDestroyed: () => false, webContents: { getURL: () => url, isLoading: () => true, once: (_event, fn) => { ready = fn; }, send: (...args) => sent.push(args) } };
  const ctx = { monitorBaseUrl: "http://127.0.0.1:18877", authToken: "fixture", runtimePaths: {}, state: { mainWindow: win } };
  let request;
  const controller = createDesktopJobNotices({ ctx, Notification: fakeNotification(shown), windows: { createMainWindow: async () => {}, showMainWindow() {} }, fetchImpl: async (...args) => { request = args; return { ok: true, json: async () => ({ notifications: [{ id: "n", serverId: "s", jobIds: ["42"], title: "完成" }] }) }; } });
  await controller.start();
  shown[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request[1].headers["x-auth-token"], "fixture");
  assert.ok(request[1].signal);
  assert.deepEqual(sent, []);
  url = ctx.monitorBaseUrl;
  ready();
  assert.deepEqual(sent, [["job-notice-open", { serverId: "s", jobId: "42" }]]);
  controller.stop();
});

// ---- v2.62：失败提醒不属于任何关注组（watchId 为 null） ----

test("失败提醒没有 watchId 也照常去重与发送；点开带 history 目标，其余提醒的导航参数不变", async () => {
  const shown = [];
  const navigations = [];
  const notifications = [
    { id: "f1", serverId: "s", watchId: null, kind: "failed", title: "2 个作业失败", body: "2 个 KeyError: 'arm'。作业号 12、11。", jobIds: ["12", "11"], readAt: null },
    { id: "w1", serverId: "s", watchId: "w", kind: "ended", title: "实验组 全部完成", jobIds: ["7"], readAt: null },
  ];
  const controller = createJobNoticesController({ timers, now: () => 100, Notification: fakeNotification(shown), fetchNotifications: async () => ({ settings: { quietUntil: 0 }, notifications }), onNavigate: (...args) => navigations.push(args) });
  await controller.start();
  assert.deepEqual(shown.map((n) => [n.options.title, n.options.body]), [["2 个作业失败", "2 个 KeyError: 'arm'。作业号 12、11。"], ["实验组 全部完成", ""]]);
  shown[0].click();
  shown[1].click();
  await Promise.resolve();
  assert.deepEqual(navigations, [["s", "12", "history"], ["s", "7"]]);
  await controller.poll();
  assert.equal(shown.length, 2, "下一轮不重发");
  controller.stop();
});

test("免打扰期间失败提醒不弹，结束后也不补发；之后的新失败照常弹", async () => {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "job-notices-quiet-"));
  const shown = [];
  let clock = 100;
  let quietUntil = 500;
  const notifications = [{ id: "f1", serverId: "s", watchId: null, kind: "failed", title: "作业失败：train_a", jobIds: ["12"], readAt: null }];
  const options = { runtimeDir, timers, now: () => clock, Notification: fakeNotification(shown), fetchNotifications: async () => ({ settings: { quietUntil }, notifications }) };
  try {
    const controller = createJobNoticesController(options);
    await controller.start();
    assert.equal(shown.length, 0, "免打扰中");
    clock = 600;
    quietUntil = 0;
    await controller.poll();
    assert.equal(shown.length, 0, "免打扰结束后不补发那一条（它留在收件箱里）");
    controller.stop();
    // 重启桌面壳：去重记录在盘上，仍然不补发；新的失败照常弹。
    const again = createJobNoticesController(options);
    notifications.unshift({ id: "f2", serverId: "s", watchId: null, kind: "failed", title: "作业失败：train_b", jobIds: ["13"], readAt: null });
    await again.start();
    assert.deepEqual(shown.map((n) => n.options.title), ["作业失败：train_b"]);
    again.stop();
  } finally { rmSync(runtimeDir, { recursive: true, force: true }); }
});

test("桌面装配：失败提醒的导航 IPC 带 view，页面据此直接打开「我的历史」", async () => {
  const shown = [];
  const sent = [];
  const base = "http://127.0.0.1:18877";
  const win = { isDestroyed: () => false, webContents: { getURL: () => base, isLoading: () => false, once() {}, send: (...args) => sent.push(args) } };
  const ctx = { monitorBaseUrl: base, authToken: "fixture", runtimePaths: {}, state: { mainWindow: win } };
  const controller = createDesktopJobNotices({ ctx, Notification: fakeNotification(shown), windows: { createMainWindow: async () => {}, showMainWindow() {} },
    fetchImpl: async () => ({ ok: true, json: async () => ({ notifications: [{ id: "f", serverId: "s", watchId: null, kind: "failed", jobIds: ["42", "41"], title: "2 个作业失败" }] }) }) });
  await controller.start();
  shown[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [["job-notice-open", { serverId: "s", jobId: "42", view: "history" }]]);
  controller.stop();
});
