import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createQuitController, listTunnelRecordNames } from "./quit.mjs";

const silent = { log() {}, warn() {}, error() {} };

function makeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout(fn, ms) { const t = { kind: "timeout", fn, ms }; pending.push(t); return t; },
    clearTimeout(t) { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    setInterval(fn, ms) { const t = { kind: "interval", fn, ms }; pending.push(t); return t; },
    clearInterval(t) { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
  };
}

function makeHarness({ platform = "darwin", records = {}, stopResults = {}, tunnelFiles = [] } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform, homeDir: "/Users/t" });
  const calls = [];
  const app = {
    quit: () => calls.push("app.quit"),
    exit: (code) => calls.push(`app.exit(${code})`),
    focus: (opts) => calls.push(`app.focus(${JSON.stringify(opts)})`),
  };
  const dialogResponses = [];
  const dialog = {
    showMessageBox: (...args) => {
      calls.push(`dialog(${args.length === 2 ? "parent" : "none"})`);
      return new Promise((resolve) => dialogResponses.push(resolve));
    },
  };
  const stopLog = [];
  const registry = {
    readMeta: (name) => (name in records ? records[name] : { pid: 1 }),
    stopProcess: (name, opts) => {
      const entry = { name, opts, resolve: null };
      stopLog.push(entry);
      return new Promise((resolve) => {
        entry.resolve = () => resolve(stopResults[name] || { stopped: true });
        if (name !== "channel-supervisor") entry.resolve();
      });
    },
  };
  Object.assign(ctx.actions, {
    pkillScopedByPattern: async (pattern) => calls.push(`pkill ${pattern}`),
    teardownCredentialVault: async () => calls.push("teardownCredentialVault"),
    removeDesktopMainRecord: () => calls.push("removeDesktopMainRecord"),
  });
  const timers = makeTimers();
  const quit = createQuitController({
    ctx,
    app,
    dialog,
    registry,
    platform,
    readdirImpl: () => tunnelFiles,
    timers,
    logger: silent,
  });
  return { ctx, state: ctx.state, app, calls, dialogResponses, stopLog, timers, quit };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("listTunnelRecordNames：按 pid 记录反推每台服务器的隧道（只收 tunnel.<serverId>）", () => {
  const files = ["tunnel.srv-a.pid.json", "tunnel.pid.json", "local-proxy.pid.json", "tunnel.srv-b.pid.json", "tunnel.srv-c.log"];
  assert.deepEqual(listTunnelRecordNames("/rt", () => files), ["tunnel.srv-a", "tunnel.srv-b"]);
  assert.deepEqual(listTunnelRecordNames("/missing", () => { throw new Error("ENOENT"); }), []);
});

test("cleanupBackground（重启界面 / 隐式退出）：只停 monitor-server，数据面与保管库原样保留", async () => {
  for (const scenario of [{ preserveDataPlane: true, isQuitting: true }, { preserveDataPlane: false, isQuitting: false }]) {
    const h = makeHarness();
    const killed = [];
    h.state.isQuitting = scenario.isQuitting;
    h.state.serverProcess = { kill: (sig) => killed.push(sig) };
    h.state.serverRestartTimer = h.timers.setTimeout(() => {}, 1000);
    h.state.statusInterval = h.timers.setInterval(() => {}, 30000);
    await h.quit.cleanupBackground({ preserveDataPlane: scenario.preserveDataPlane, monitorStopBudgetMs: 65000 });
    assert.equal(h.state.serverExiting, true);
    assert.equal(h.state.serverProcess, null);
    assert.equal(h.state.serverRestartTimer, null);
    assert.equal(h.state.statusInterval, null);
    assert.deepEqual(h.timers.pending, [], "自愈定时器与托盘心跳都已清掉");
    assert.deepEqual(killed, ["SIGTERM"]);
    assert.deepEqual(h.stopLog.map((s) => [s.name, s.opts]), [["monitor-server", { forceAfterMs: 65000 }]]);
    assert.ok(!h.calls.includes("teardownCredentialVault"), "端点文件必须留给存活的 supervisor");
  }
});

test("cleanupBackground（显式退出）：supervisor 独占第一段，其余并发，兜底只针对缺记录/校验失败，最后关保管库", async () => {
  const h = makeHarness({
    records: { "local-proxy-draining": null },
    stopResults: { "local-proxy": { stopped: false, reason: "cmdline mismatch" } },
    tunnelFiles: ["tunnel.srv-a.pid.json", "tunnel.srv-b.pid.json"],
  });
  h.state.isQuitting = true;
  const done = h.quit.cleanupBackground();
  await flush();
  assert.deepEqual(h.stopLog.map((s) => s.name), ["monitor-server", "channel-supervisor"], "supervisor 停完之前不碰子进程");
  assert.deepEqual(h.stopLog[1].opts, { forceAfterMs: 1500 });
  h.stopLog[1].resolve();
  await done;
  assert.deepEqual(h.stopLog.map((s) => s.name), ["monitor-server", "channel-supervisor", "local-proxy", "tunnel.srv-a", "tunnel.srv-b"]);
  assert.deepEqual(h.stopLog[0].opts, { forceAfterMs: 1500 }, "默认 monitor-server 预算 1.5s");
  // local-proxy 校验失败 → 按脚本名兜底；draining 缺记录但没有安全的模式兜底
  assert.deepEqual(h.calls, ["pkill work/local_http_connect_proxy.mjs", "teardownCredentialVault"]);
});

test("before-quit：重启界面进行中一律拦下，不弹框、不置 isQuitting", () => {
  const h = makeHarness();
  h.state.controlPlaneRestarting = true;
  let prevented = 0;
  h.quit.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(h.state.isQuitting, false);
  assert.deepEqual(h.calls, []);
});

test("before-quit：未确认的退出先抢前台再弹 W5 确认框；框开着时不重复弹；确认后走显式退出", async () => {
  const h = makeHarness({ platform: "darwin" });
  let prevented = 0;
  const event = { preventDefault: () => { prevented += 1; } };
  h.quit.handleBeforeQuit(event);
  assert.equal(prevented, 1);
  assert.equal(h.state.quitPromptOpen, true);
  assert.deepEqual(h.calls, ['app.focus({"steal":true})', "dialog(none)"], "macOS 先 app.focus({steal:true}) 再弹框");
  h.quit.handleBeforeQuit(event);
  assert.equal(prevented, 2);
  assert.equal(h.dialogResponses.length, 1, "prompt-open：不重复弹框");
  assert.equal(h.state.isQuitting, false);
  h.dialogResponses[0]({ response: 0 });
  await flush();
  assert.equal(h.state.quitPromptOpen, false);
  assert.equal(h.state.quitConfirmed, true);
  assert.equal(h.state.isQuitting, true);
  assert.equal(h.calls.at(-1), "app.quit");
});

test("before-quit：取消确认框什么都不做（隧道继续运行）；主窗口可见时以它为父窗口", async () => {
  const h = makeHarness({ platform: "linux" });
  const focused = [];
  h.state.mainWindow = { isDestroyed: () => false, isVisible: () => true, focus: () => focused.push("main") };
  h.quit.handleBeforeQuit({ preventDefault() {} });
  assert.deepEqual(h.calls, ["dialog(parent)"], "非 macOS 不调用 app.focus");
  assert.deepEqual(focused, ["main"]);
  h.dialogResponses[0]({ response: 1 });
  await flush();
  assert.equal(h.state.quitPromptOpen, false);
  assert.equal(h.state.quitConfirmed, false);
  assert.equal(h.state.isQuitting, false);
});

test("before-quit：已确认 → 置 isQuitting/cleanupStarted，清理（8s 预算）后删 desktop-main 记录再 app.exit(0)；再次进入放行", async () => {
  const h = makeHarness();
  h.state.quitConfirmed = true;
  let prevented = 0;
  h.quit.handleBeforeQuit({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.equal(h.state.isQuitting, true);
  assert.equal(h.state.cleanupStarted, true);
  assert.deepEqual(h.timers.pending.map((t) => t.ms), [8000]);
  await flush();
  h.stopLog.find((s) => s.name === "channel-supervisor").resolve();
  await flush();
  await flush();
  assert.deepEqual(h.calls.slice(-3), ["teardownCredentialVault", "removeDesktopMainRecord", "app.exit(0)"]);
  // pass-through：清理已开始后的 before-quit 不再拦截
  const again = { preventDefault: () => { prevented += 1; } };
  h.quit.handleBeforeQuit(again);
  assert.equal(prevented, 1);
});

test("before-quit：清理超过 8s 仍强制退出", async () => {
  const h = makeHarness();
  h.state.quitConfirmed = true;
  h.quit.handleBeforeQuit({ preventDefault() {} });
  await flush();
  // channel-supervisor 永不返回（卡死）：靠 8s 预算兜底
  const budget = h.timers.pending.find((t) => t.ms === 8000);
  budget.fn();
  await flush();
  assert.deepEqual(h.calls.slice(-2), ["removeDesktopMainRecord", "app.exit(0)"]);
});

test("显式退出入口：重启界面期间拒绝；requestQuitWithConfirm 不置 quitConfirmed", () => {
  const h = makeHarness();
  h.state.controlPlaneRestarting = true;
  h.quit.requestQuit();
  h.quit.requestQuitWithConfirm();
  assert.equal(h.state.isQuitting, false);
  assert.equal(h.state.quitConfirmed, false);
  assert.deepEqual(h.calls, []);

  const h2 = makeHarness();
  h2.quit.requestQuitWithConfirm();
  assert.equal(h2.state.quitConfirmed, false);
  assert.equal(h2.state.isQuitting, false);
  assert.deepEqual(h2.calls, ["app.quit"]);
  h2.state.quitPromptOpen = true;
  h2.quit.requestQuitWithConfirm();
  assert.deepEqual(h2.calls, ["app.quit"], "确认框已开着时不重复触发");
});

test("关机/注销：视为已确认；确认框已开着则直接退出；重启界面期间不介入", () => {
  const h = makeHarness();
  h.quit.handlePowerShutdown();
  assert.equal(h.state.quitConfirmed, true);
  assert.deepEqual(h.calls, [], "没弹框时只标记，交给随后的 before-quit");

  const h2 = makeHarness();
  h2.state.quitPromptOpen = true;
  h2.quit.handlePowerShutdown();
  assert.equal(h2.state.isQuitting, true);
  assert.deepEqual(h2.calls, ["app.quit"]);

  const h3 = makeHarness();
  h3.state.controlPlaneRestarting = true;
  h3.state.quitPromptOpen = true;
  h3.quit.handlePowerShutdown();
  assert.equal(h3.state.quitConfirmed, false);
  assert.deepEqual(h3.calls, []);
});
