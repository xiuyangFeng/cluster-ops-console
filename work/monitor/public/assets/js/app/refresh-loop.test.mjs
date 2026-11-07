import assert from "node:assert/strict";
import test from "node:test";

import { BOOT_FRESH_MS, createRefreshLoop, FIRST_LOAD_FALLBACK_MS, HIDDEN_POLL_INTERVAL_MS, REFRESH_DEBOUNCE_MS } from "./refresh-loop.js";
import { fakeElement, fakeTimers, flush, spy } from "./test-support.mjs";

function setup({ load = async () => ({ v: "full" }), pollValue = "5000" } = {}) {
  const timers = fakeTimers();
  const clock = { t: 1_000_000 };
  let hidden = false;
  let status = null;
  let visibilityCb = null;
  let sse = null;
  const deps = {
    loadStatus: spy(load),
    render: spy((s) => { status = s; }),
    getStatus: () => status,
    reportError: spy(),
    setStale: spy(),
    fetchIncidents: spy(),
    logsPanel: { refresh: spy(), appendEntry: spy() },
    logStream: { refresh: spy(), append: spy() },
    handleRunbookLog: spy(),
    eventsUrl: (p) => `http://x${p}`,
    pollSelect: fakeElement({ value: pollValue }),
    isHidden: () => hidden,
    onVisibilityChange: (cb) => { visibilityCb = cb; },
    flushRender: spy(),
    createSse: (opts) => {
      sse = { ...opts, start: spy() };
      return sse;
    },
    timers,
    now: () => clock.t,
  };
  const loop = createRefreshLoop(deps);
  return {
    deps, loop, timers,
    setHidden: (v) => { hidden = v; },
    setStatus: (s) => { status = s; },
    fireVisibility: (h) => visibilityCb(h),
    sse: () => sse,
    clock,
  };
}

test("scheduleRender: 同帧多次到达只渲染一次最新 status", () => {
  const { loop, deps, timers } = setup();
  loop.scheduleRender({ n: 1 });
  loop.scheduleRender({ n: 2 });
  assert.equal(timers.frames.length, 1);
  assert.equal(deps.render.calls.length, 0);
  timers.runFrames();
  assert.deepEqual(deps.render.calls, [[{ n: 2 }]]);
});

test("scheduleRender: 隐藏期直接提交且丢弃 rAF 挂起项（恢复后不会被旧帧覆盖）", () => {
  const ctx = setup();
  ctx.loop.scheduleRender({ n: 1 });
  ctx.setHidden(true);
  ctx.loop.scheduleRender({ n: 2 });
  assert.deepEqual(ctx.deps.render.calls, [[{ n: 2 }]]);
  ctx.timers.runFrames();
  assert.equal(ctx.deps.render.calls.length, 1, "挂起的旧帧不再渲染");
});

test("refresh: 全量结果提交时丢弃排队中的 lite 渲染，并联动日志/事件；失败交给 reportError", async () => {
  const ctx = setup();
  ctx.loop.scheduleRender({ lite: true });
  await ctx.loop.refresh();
  assert.deepEqual(ctx.deps.render.calls, [[{ v: "full" }]]);
  assert.deepEqual(ctx.deps.setStale.calls, [[false]]);
  assert.equal(ctx.deps.logsPanel.refresh.calls.length, 1, "兜底模式（SSE 未连）下随刷新拉日志");
  assert.equal(ctx.deps.fetchIncidents.calls.length, 1);
  ctx.timers.runFrames();
  assert.equal(ctx.deps.render.calls.length, 1, "旧 lite 帧被丢弃");

  const err = new Error("down");
  const failing = setup({ load: async () => { throw err; } });
  const origError = console.error;
  console.error = () => {};
  try {
    await failing.loop.refresh();
  } finally {
    console.error = origError;
  }
  assert.deepEqual(failing.deps.reportError.calls, [[err, "refresh"]]);
});

test("scheduleRefresh: 防抖合并连锁变化；隐藏期跳过", async () => {
  const ctx = setup();
  ctx.loop.scheduleRefresh();
  ctx.loop.scheduleRefresh();
  assert.equal(ctx.timers.timeouts.size, 1);
  assert.equal([...ctx.timers.timeouts.values()][0].ms, REFRESH_DEBOUNCE_MS);
  ctx.timers.runTimeouts();
  await flush();
  assert.equal(ctx.deps.loadStatus.calls.length, 1);
  ctx.setHidden(true);
  ctx.loop.scheduleRefresh();
  assert.equal(ctx.timers.timeouts.size, 0);
});

test("start: 连 SSE、排首载兜底、按所选间隔轮询；SSE 连上后停轮询", async () => {
  const ctx = setup();
  ctx.loop.start();
  assert.equal(ctx.sse().start.calls.length, 1);
  assert.equal(ctx.sse().url(), "http://x/api/events");
  assert.deepEqual([...ctx.timers.intervals.values()].map((t) => t.ms), [5000]);
  const fallback = [...ctx.timers.timeouts.values()].find((t) => t.ms === FIRST_LOAD_FALLBACK_MS);
  assert.ok(fallback, "首载兜底计时器");
  fallback.fn();
  await flush();
  assert.equal(ctx.deps.loadStatus.calls.length, 1, "还没有 status → 主动拉一次");
  assert.equal(ctx.deps.logStream.refresh.calls.length, 1);
  fallback.fn();
  await flush();
  assert.equal(ctx.deps.loadStatus.calls.length, 1, "已有 status 就不再拉");

  ctx.sse().onFallbackChange(false);
  assert.equal(ctx.timers.intervals.size, 0, "SSE 正常时不轮询");
  ctx.sse().onFallbackChange(true);
  assert.equal(ctx.timers.intervals.size, 1);
  ctx.deps.pollSelect.value = "0";
  await ctx.deps.pollSelect.dispatch("change");
  assert.equal(ctx.timers.intervals.size, 0, "选择关闭轮询");
});

test("可见性：隐藏时轮询降频到 60s；恢复时先冲刷闸门再全量刷新并重播种日志", async () => {
  const ctx = setup();
  ctx.loop.start();
  ctx.setHidden(true);
  ctx.fireVisibility(true);
  assert.deepEqual([...ctx.timers.intervals.values()].map((t) => t.ms), [HIDDEN_POLL_INTERVAL_MS]);
  assert.equal(ctx.deps.flushRender.calls.length, 0);
  ctx.setHidden(false);
  const before = ctx.deps.loadStatus.calls.length;
  ctx.fireVisibility(false);
  await flush();
  assert.deepEqual([...ctx.timers.intervals.values()].map((t) => t.ms), [5000]);
  assert.equal(ctx.deps.flushRender.calls.length, 1);
  assert.equal(ctx.deps.loadStatus.calls.length, before + 1);
  assert.equal(ctx.deps.logsPanel.refresh.calls.length, 2, "恢复时重播种 + 兜底模式下全量刷新联动");
  assert.equal(ctx.deps.logStream.refresh.calls.length, 1);
});

test("SSE 事件：status 合并进最新全量状态；日志隐藏期不写 DOM 但 runbook 照常推进", () => {
  const ctx = setup();
  ctx.loop.start();
  ctx.sse().onStatus({ lite: { health: "ready" } });
  assert.equal(ctx.timers.frames.length, 0, "还没有全量状态时不渲染 lite");
  ctx.setStatus({ health: "down", layers: { a: 1 }, version: "1" });
  ctx.sse().onStatus({ lite: { health: "ready" }, layers: null });
  ctx.timers.runFrames();
  assert.deepEqual(ctx.deps.render.calls.at(-1)[0], { health: "ready", layers: { a: 1 }, version: "1" });

  const entry = { message: "x" };
  ctx.setHidden(true);
  ctx.sse().onLog(entry);
  assert.equal(ctx.deps.logsPanel.appendEntry.calls.length, 0);
  assert.deepEqual(ctx.deps.handleRunbookLog.calls, [[entry]]);
  ctx.setHidden(false);
  ctx.sse().onLog(entry);
  assert.equal(ctx.deps.logStream.append.calls.length, 1);
});

test("SSE 首次连上：启动那份全量 status 还新鲜时不重拉，只对齐日志与事件；之后的重连照常全量对齐", async () => {
  const ctx = setup();
  ctx.loop.start();
  ctx.loop.markFresh();
  ctx.clock.t += 80;
  ctx.sse().onOpen();
  await flush();
  assert.equal(ctx.deps.loadStatus.calls.length, 0, "不再整页重拉 status");
  assert.equal(ctx.deps.logsPanel.refresh.calls.length, 1);
  assert.equal(ctx.deps.logStream.refresh.calls.length, 1);
  assert.equal(ctx.deps.fetchIncidents.calls.length, 1);
  // 断线重连：照常全量对齐
  ctx.sse().onOpen();
  await flush();
  assert.equal(ctx.deps.loadStatus.calls.length, 1);
});

test("SSE 首次连上：启动那份 status 已过时（或没拿到）就照常全量对齐", async () => {
  const stale = setup();
  stale.loop.start();
  stale.loop.markFresh();
  stale.clock.t += BOOT_FRESH_MS + 1;
  stale.sse().onOpen();
  await flush();
  assert.equal(stale.deps.loadStatus.calls.length, 1);
  const none = setup();
  none.loop.start();
  none.sse().onOpen();
  await flush();
  assert.equal(none.deps.loadStatus.calls.length, 1);
});
