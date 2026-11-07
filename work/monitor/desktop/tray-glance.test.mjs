import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createTrayGlance, TRAY_GLANCE_FIRST_MS, TRAY_GLANCE_POLL_MS } from "./tray-glance.mjs";

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

// 非 Slurm 机器：菜单栏退到查看中服务器的 CPU 使用率（Slurm 读数的口径由 glance-model.test 覆盖）。
const STATUS = {
  activeServerId: "s1",
  serversBrief: { s1: { displayName: "主集群服务器 (myserver)" } },
  layers: { tunnels: { s1: { level: "ok" } }, resources: { s1: { level: "ok", cpu: 42, ram: 10 } } },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeHarness({ platform = "darwin", metric = "gpu", respond = async () => ({ ok: true, json: async () => STATUS }) } = {}) {
  const ctx = createDesktopContext({ rootDir: "/app", env: {}, platform: "darwin", homeDir: "/Users/t" });
  const titles = [];
  ctx.state.tray = { setTitle: (title, options) => titles.push([title, options?.fontType]) };
  let prefs = { trayMetric: metric };
  const fetches = [];
  const timers = makeTimers();
  const glance = createTrayGlance({
    ctx,
    prefs: { load: () => ({ ...prefs }), update: (patch) => { prefs = { ...prefs, ...patch }; return prefs; } },
    fetchImpl: async (url, opts) => { fetches.push({ url, opts }); return respond(); },
    timers,
    platform,
  });
  return { ctx, glance, titles, fetches, timers, prefs: () => prefs };
}

test("start：只在 macOS 起；3 秒后首拉、之后 30 秒一次，带令牌打 /api/status", async () => {
  const h = makeHarness();
  h.glance.start();
  h.glance.start();
  const intervals = h.timers.pending.filter((t) => t.kind === "interval");
  const [first] = h.timers.pending.filter((t) => t.kind === "timeout");
  assert.equal(intervals.length, 1, "幂等");
  assert.equal(intervals[0].ms, TRAY_GLANCE_POLL_MS);
  assert.equal(first.ms, TRAY_GLANCE_FIRST_MS);
  assert.equal(first.unrefed, true);
  first.fn();
  await flush();
  assert.equal(h.fetches[0].url, "http://127.0.0.1:8877/api/status");
  assert.deepEqual(h.fetches[0].opts.headers, { "x-auth-token": h.ctx.authToken });
  assert.deepEqual(h.titles, [[" CPU 42%", "monospacedDigit"]]);
  intervals[0].fn();
  await flush();
  assert.equal(h.titles.length, 1, "读数没变不重设标题");
  h.ctx.state.serverExiting = true;
  intervals[0].fn();
  assert.equal(h.timers.pending.filter((t) => t.kind === "interval").length, 0, "退出中：停掉轮询");

  const win = makeHarness({ platform: "win32" });
  win.glance.start();
  assert.equal(win.timers.pending.length, 0, "Windows 托盘没有标题");
});

test("监控服务不可达 / 非 2xx：清空数字，不挂过期读数", async () => {
  let fail = false;
  const h = makeHarness({ respond: async () => { if (fail) throw new Error("ECONNREFUSED"); return { ok: true, json: async () => STATUS }; } });
  await h.glance.refresh();
  fail = true;
  await h.glance.refresh();
  assert.deepEqual(h.titles.map(([t]) => t), [" CPU 42%", ""]);
  const bad = makeHarness({ respond: async () => ({ ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) }) });
  await bad.glance.refresh();
  assert.deepEqual(bad.titles, [], "从没显示过就不必清空");
});

test("setMetric：写进偏好并立刻换显示；不显示时不拉取，切回来补拉一次", async () => {
  const h = makeHarness({ metric: "off" });
  await h.glance.refresh();
  assert.equal(h.fetches.length, 0, "不显示时不拉取");
  h.glance.setMetric("cpu");
  assert.equal(h.prefs().trayMetric, "cpu");
  assert.equal(h.glance.getMetric(), "cpu");
  await flush();
  assert.equal(h.fetches.length, 1, "从不显示切回来补拉");
  assert.deepEqual(h.titles.at(-1), [" CPU 42%", "monospacedDigit"]);
  h.glance.setMetric("off");
  assert.deepEqual(h.titles.at(-1), ["", "monospacedDigit"]);
  h.glance.setMetric("cpu");
  assert.deepEqual(h.titles.at(-1), [" CPU 42%", "monospacedDigit"], "已有读数：直接换显示");
  assert.equal(h.fetches.length, 1);
});
