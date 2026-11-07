import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { BUNDLE_UPDATE_CHECK_MS, DATA_PLANE_UPGRADING_MESSAGE, RELAUNCH_MARKER_ENV } from "../lib/control-plane-restart.mjs";
import { UPGRADE_GRACEFUL_STOP_MS } from "../lib/upgrade-marker.mjs";
import { createDesktopContext } from "./context.mjs";
import { createControlPlane } from "./control-plane.mjs";

const silent = { log() {}, warn() {}, error() {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeTimers() {
  const pending = [];
  const add = (kind) => (fn, ms) => {
    const t = { kind, fn, ms, unrefed: false, unref() { this.unrefed = true; } };
    pending.push(t);
    return t;
  };
  const remove = (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); };
  return { pending, setTimeout: add("timeout"), setInterval: add("interval"), clearTimeout: remove, clearInterval: remove };
}

// sourceVersion / diskSourceVersion：源码运行（没有 build-info.json）时启动那一刻与之后磁盘上 package.json 的版本。
function makeHarness({ runningBuild = { version: "2.28.0", gitCommit: "aaa" }, diskBuild = null, sourceVersion = null, diskSourceVersion = null, upgrading = () => false, ownRecord = true } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const calls = [];
  const notifications = [];
  class Notification {
    constructor(opts) { this.opts = opts; this.handlers = {}; notifications.push(this); }
    on(name, fn) { this.handlers[name] = fn; }
    show() { calls.push(`notify:${this.opts.title}`); }
  }
  const app = {
    relaunch: () => calls.push("app.relaunch"),
    exit: (code) => calls.push(`app.exit(${code})`),
    quit: () => calls.push("app.quit"),
  };
  const recorded = [];
  const registry = {
    recordProcess: (name, pid, meta) => recorded.push({ name, pid, meta }),
    readMeta: () => (ownRecord ? { pid: 4242 } : { pid: 9999 }),
  };
  const env = {};
  const timers = makeTimers();
  let cleanupArgs = null;
  Object.assign(ctx.actions, {
    cleanupBackground: async (args) => { cleanupArgs = args; calls.push("cleanupBackground"); },
    createMainWindow: () => calls.push("createMainWindow"),
  });
  let nowValue = 1_000_000;
  const controlPlane = createControlPlane({
    ctx,
    app,
    registry,
    Notification,
    isUpgradeInFlight: ({ runtimeDir }) => {
      assert.equal(runtimeDir, ctx.runtimePaths.runtimeDir);
      return upgrading();
    },
    readFileSync: (file) => {
      if (file === path.join(ctx.rootDir, "package.json")) {
        if (!sourceVersion) throw new Error("ENOENT");
        return JSON.stringify({ version: sourceVersion });
      }
      assert.equal(file, path.join(ctx.rootDir, "build-info.json")); // rootDir 已 path.resolve（Windows 带盘符）
      if (!runningBuild) throw new Error("ENOENT");
      return JSON.stringify(runningBuild);
    },
    readFile: async (file) => {
      if (file === path.join(ctx.rootDir, "package.json")) {
        if (!diskSourceVersion) throw new Error("ENOENT");
        return JSON.stringify({ version: diskSourceVersion });
      }
      if (!diskBuild) throw new Error("ENOENT");
      return JSON.stringify(diskBuild);
    },
    unlinkSync: (file) => calls.push(`unlink ${path.basename(file)}`),
    env,
    pid: 4242,
    ppid: 1,
    execPath: "/Applications/Console.app/Contents/MacOS/Console",
    now: () => nowValue,
    timers,
    logger: silent,
  });
  return {
    ctx,
    state: ctx.state,
    calls,
    notifications,
    recorded,
    env,
    timers,
    controlPlane,
    cleanupArgs: () => cleanupArgs,
    setNow: (v) => { nowValue = v; },
  };
}

function fakeWindow(calls, name) {
  return { isDestroyed: () => false, destroy: () => calls.push(`destroy ${name}`) };
}

test("重启界面：保留数据面、销毁窗口与托盘，relaunch 之后 exit(0)，绝不置 isQuitting / quitConfirmed", async () => {
  const h = makeHarness();
  h.state.startupComplete = true;
  h.state.mainWindow = fakeWindow(h.calls, "main");
  h.state.islandWindow = fakeWindow(h.calls, "island");
  h.state.tray = { destroy: () => h.calls.push("tray.destroy") };
  const decision = await h.controlPlane.restartControlPlane("tray");
  assert.deepEqual(decision, { ok: true, reason: "ok" });
  assert.equal(h.state.controlPlaneRestarting, true);
  assert.equal(h.state.isQuitting, false);
  assert.equal(h.state.quitConfirmed, false);
  assert.deepEqual(h.cleanupArgs(), { preserveDataPlane: true, monitorStopBudgetMs: 1500 });
  assert.deepEqual(h.calls, [
    "destroy island",
    "destroy main",
    "cleanupBackground",
    "unlink desktop-main.pid.json",
    "tray.destroy",
    "app.relaunch",
    "app.exit(0)",
  ]);
  assert.ok(!h.calls.includes("app.quit"), "走 app.exit，不经 before-quit");
  assert.equal(h.env[RELAUNCH_MARKER_ENV], "1000000", "新实例继承重启标记");
  assert.deepEqual(h.timers.pending.map((t) => t.ms), [8000], "cleanup 预算 8s");
  // 重复触发只执行第一次
  assert.deepEqual(await h.controlPlane.restartControlPlane("signal"), { ok: false, reason: "already-restarting" });
});

test("重启界面：决策之后升级才开始 → monitor-server 按升级宽限优雅退出", async () => {
  let checks = 0;
  const h = makeHarness({ upgrading: () => (checks++ > 0) });
  h.state.startupComplete = true;
  await h.controlPlane.restartControlPlane("tray");
  assert.deepEqual(h.cleanupArgs(), { preserveDataPlane: true, monitorStopBudgetMs: UPGRADE_GRACEFUL_STOP_MS });
  assert.deepEqual(h.timers.pending.map((t) => t.ms), [UPGRADE_GRACEFUL_STOP_MS + 5000]);
});

test("重启界面：启动未完成时信号请求记下待办，其它来源直接忽略；退出/确认框进行中不抢", async () => {
  const h = makeHarness();
  assert.equal((await h.controlPlane.restartControlPlane("tray")).reason, "not-ready");
  assert.equal(h.state.pendingRestartReason, "");
  assert.equal((await h.controlPlane.restartControlPlane("signal")).reason, "not-ready");
  assert.equal(h.state.pendingRestartReason, "signal");
  h.state.startupComplete = true;
  h.state.quitPromptOpen = true;
  assert.equal((await h.controlPlane.restartControlPlane("tray")).reason, "quit-prompt-open");
  h.state.quitPromptOpen = false;
  h.state.isQuitting = true;
  assert.equal((await h.controlPlane.restartControlPlane("tray")).reason, "quitting");
  assert.equal(h.state.controlPlaneRestarting, false);
  assert.deepEqual(h.calls, []);
});

test("数据面升级在飞：用户触发弹通知说明原因；信号触发每 2s 复查，升级结束后自动重启", async () => {
  let upgrading = true;
  const h = makeHarness({ upgrading: () => upgrading });
  h.state.startupComplete = true;
  const tips = [];
  h.state.tray = { setToolTip: (t) => tips.push(t), destroy() {} };
  const refused = await h.controlPlane.restartControlPlane("tray");
  assert.equal(refused.reason, "data-plane-upgrading");
  assert.deepEqual(h.calls, ["notify:暂不能重启界面"]);
  assert.equal(h.notifications[0].opts.body, `${DATA_PLANE_UPGRADING_MESSAGE}（升级完成后再试）`);
  assert.deepEqual(tips, [`集群运维工作台 · ${DATA_PLANE_UPGRADING_MESSAGE}`]);

  await h.controlPlane.restartControlPlane("signal");
  await h.controlPlane.restartControlPlane("signal");
  const retries = h.timers.pending.filter((t) => t.kind === "interval");
  assert.equal(retries.length, 1, "重试定时器只起一个");
  assert.equal(retries[0].ms, 2000);
  retries[0].fn(); // 仍在升级：继续等
  assert.equal(h.state.controlPlaneRestarting, false);
  upgrading = false;
  retries[0].fn();
  await flush();
  assert.equal(h.state.controlPlaneRestarting, true);
  assert.ok(h.calls.includes("app.exit(0)"));
  assert.ok(!h.timers.pending.includes(retries[0]), "重试定时器已清掉");
});

test("数据面升级在飞：信号重试最多等 90s，超时后照常尝试重启", async () => {
  const h = makeHarness({ upgrading: () => true });
  h.state.startupComplete = true;
  await h.controlPlane.restartControlPlane("signal");
  const retry = h.timers.pending.find((t) => t.kind === "interval");
  h.setNow(1_000_000 + 90_001);
  retry.fn();
  await flush();
  assert.ok(!h.timers.pending.includes(retry));
  // 标记仍在：再次被拒，并重新挂起下一轮重试（信号触发的重启不能丢）
  assert.equal(h.state.controlPlaneRestarting, false);
  const next = h.timers.pending.filter((t) => t.kind === "interval");
  assert.equal(next.length, 1);
  assert.notEqual(next[0], retry);
});

test("渲染层重启：先回包再动手（50ms 后），拒绝时原样返回决策", async () => {
  const h = makeHarness();
  h.state.startupComplete = true;
  const decision = h.controlPlane.restartFromRenderer();
  assert.deepEqual(decision, { ok: true, reason: "ok" });
  assert.equal(h.state.controlPlaneRestarting, false, "回包之前不动手");
  const scheduled = h.timers.pending.find((t) => t.ms === 50);
  assert.ok(scheduled);
  scheduled.fn();
  await flush();
  assert.equal(h.state.controlPlaneRestarting, true);

  const h2 = makeHarness({ upgrading: () => true });
  h2.state.startupComplete = true;
  assert.equal(h2.controlPlane.restartFromRenderer().reason, "data-plane-upgrading");
  assert.deepEqual(h2.calls, ["notify:暂不能重启界面"]);
  assert.deepEqual(h2.timers.pending, []);
});

test("desktop-main 登记：command = 应用主可执行文件、无脚本参数；只删自己的记录", () => {
  const h = makeHarness();
  h.controlPlane.recordDesktopMain();
  assert.deepEqual(h.recorded, [{
    name: "desktop-main",
    pid: 4242,
    meta: { command: "/Applications/Console.app/Contents/MacOS/Console", args: [], cwd: h.ctx.rootDir, parentPid: 1 },
  }]);
  h.controlPlane.removeDesktopMainRecord();
  assert.deepEqual(h.calls, ["unlink desktop-main.pid.json"]);
  const other = makeHarness({ ownRecord: false });
  other.controlPlane.removeDesktopMainRecord();
  assert.deepEqual(other.calls, [], "新实例已写入自己的 pid：旧实例不能删");
});

test("已安装更新检测：磁盘构建与运行构建不同 → 记下待生效更新并只通知一次；点击通知只打开主窗口", async () => {
  const h = makeHarness({ diskBuild: { version: "2.29.0", gitCommit: "bbb", builtAt: "t" } });
  await h.controlPlane.checkBundleUpdate();
  assert.equal(h.state.pendingBundleUpdate.version, "2.29.0");
  assert.deepEqual(h.calls, ["notify:新版本 v2.29.0 已安装"]);
  await h.controlPlane.checkBundleUpdate();
  assert.equal(h.notifications.length, 1, "同一构建只通知一次");
  h.notifications[0].handlers.click();
  assert.deepEqual(h.calls.slice(-1), ["createMainWindow"]);

  const same = makeHarness({ diskBuild: { version: "2.28.0", gitCommit: "aaa" } });
  await same.controlPlane.checkBundleUpdate();
  assert.equal(same.state.pendingBundleUpdate, null);

  const unreadable = makeHarness();
  unreadable.state.pendingBundleUpdate = { key: "keep" };
  await unreadable.controlPlane.checkBundleUpdate();
  assert.deepEqual(unreadable.state.pendingBundleUpdate, { key: "keep" }, "读不到磁盘构建 → 不猜");
});

test("更新检测周期：unref、幂等；重启界面时停掉", async () => {
  const h = makeHarness();
  h.state.startupComplete = true;
  h.controlPlane.startBundleUpdateWatch();
  h.controlPlane.startBundleUpdateWatch();
  const watches = h.timers.pending.filter((t) => t.kind === "interval");
  assert.equal(watches.length, 1);
  assert.equal(watches[0].ms, BUNDLE_UPDATE_CHECK_MS);
  assert.equal(watches[0].unrefed, true);
  await h.controlPlane.restartControlPlane("tray");
  assert.ok(!h.timers.pending.includes(watches[0]));
});

// v2.59：源码运行（同事 git clone 后 npm run start）没有 build-info.json，版本取 package.json。
test("源码运行：磁盘上 package.json 的版本号变了（git pull / 界面里点了更新）→ 同样算已安装未生效", async () => {
  const h = makeHarness({ runningBuild: null, sourceVersion: "2.58.1", diskSourceVersion: "2.58.1" });
  await h.controlPlane.checkBundleUpdate();
  assert.equal(h.state.pendingBundleUpdate, null, "版本没变：没有待生效更新");
  assert.equal(h.notifications.length, 0);

  const updated = makeHarness({ runningBuild: null, sourceVersion: "2.58.1", diskSourceVersion: "2.59.0" });
  await updated.controlPlane.checkBundleUpdate();
  assert.deepEqual(updated.state.pendingBundleUpdate, { version: "2.59.0", gitCommit: "", builtAt: "", key: "2.59.0||" });
  assert.deepEqual(updated.calls, ["notify:新版本 v2.59.0 已安装"]);
  await updated.controlPlane.checkBundleUpdate();
  assert.equal(updated.notifications.length, 1, "同一个版本只通知一次");
});

test("打包运行：换包那一瞬间读不到 build-info.json 时不回落去读 package.json", async () => {
  const h = makeHarness({ runningBuild: { version: "2.58.0", gitCommit: "aaa" }, diskBuild: null, diskSourceVersion: "2.59.0" });
  await h.controlPlane.checkBundleUpdate();
  assert.equal(h.state.pendingBundleUpdate, null);
  assert.equal(h.notifications.length, 0);
});

