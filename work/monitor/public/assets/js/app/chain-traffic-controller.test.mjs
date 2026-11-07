import assert from "node:assert/strict";
import test from "node:test";

import { spy } from "./test-support.mjs";
import { CHAIN_TRIPS_REFRESH_MS, createChainTrafficController } from "./chain-traffic-controller.js";

const T0 = Date.UTC(2026, 9, 15, 2, 0, 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ serverId = "server-01", fail = () => false } = {}) {
  let nowMs = T0;
  let active = serverId;
  const usage = [];
  const trips = [];
  const getJson = spy(async (path) => {
    if (fail(path)) throw new Error("boom");
    if (path === "/api/egress/usage") return { recording: true, targets: [] };
    if (path.startsWith("/api/metrics?kind=validation&serverId=")) return { samples: [{ ts: nowMs, proxyLatencyMs: 300 }] };
    throw new Error(`unexpected ${path}`);
  });
  const controller = createChainTrafficController({
    getJson,
    isViewVisible: () => false, // 不可见：不排轮询定时器，测试里手动 refresh
    isHidden: () => false,
    getActiveServerId: () => active,
    onUsage: (value) => usage.push(value),
    onTrips: (value, id) => trips.push({ value, id }),
    now: () => nowMs,
  });
  return { controller, getJson, usage, trips, advance: (ms) => { nowMs += ms; }, switchTo: (id) => { active = id; }, paths: () => getJson.calls.map((c) => c[0]) };
}

test("每轮都拉用量；往返历史 5 分钟内不重复拉，切换查看的服务器后立即重拉", async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  assert.deepEqual(ctx.paths(), ["/api/egress/usage", "/api/metrics?kind=validation&serverId=server-01"]);
  assert.equal(ctx.usage.length, 1);
  assert.deepEqual(ctx.trips[0], { value: [{ ts: T0, proxyLatencyMs: 300 }], id: "server-01" }, "带上是哪台的");

  ctx.advance(20_000);
  await ctx.controller.refresh();
  assert.equal(ctx.paths().filter((p) => p.startsWith("/api/metrics")).length, 1, "5 分钟内不重拉往返");
  assert.equal(ctx.usage.length, 2);

  ctx.switchTo("server-02");
  await ctx.controller.refresh();
  assert.equal(ctx.paths().at(-1), "/api/metrics?kind=validation&serverId=server-02");

  ctx.advance(CHAIN_TRIPS_REFRESH_MS);
  await ctx.controller.refresh();
  assert.equal(ctx.paths().filter((p) => p.includes("server-02")).length, 2);
});

test("拉取失败保留上一份：用量不回调，往返下一轮再试；没有查看中的服务器不拉往返", async () => {
  let failing = true;
  const ctx = setup({ fail: () => failing });
  await ctx.controller.refresh();
  assert.deepEqual([ctx.usage.length, ctx.trips.length], [0, 0]);
  failing = false;
  await ctx.controller.refresh();
  assert.deepEqual([ctx.usage.length, ctx.trips.length], [1, 1], "往返失败后不等 5 分钟");

  const none = setup({ serverId: null });
  await none.controller.refresh();
  assert.deepEqual(none.paths(), ["/api/egress/usage"]);
  await settle();
});

test("并发的 refresh 合并成一次", async () => {
  const ctx = setup();
  await Promise.all([ctx.controller.refresh(), ctx.controller.refresh()]);
  assert.equal(ctx.paths().filter((p) => p === "/api/egress/usage").length, 1);
});

test("ensureTrips：链路催拉往返时只在概览可见才拉，换了服务器立即拉", async () => {
  let visible = false;
  let active = "server-01";
  const getJson = spy(async () => ({ samples: [] }));
  const controller = createChainTrafficController({
    getJson, isViewVisible: () => visible, isHidden: () => false, getActiveServerId: () => active, onUsage() {}, onTrips() {}, now: () => T0,
  });
  controller.ensureTrips();
  await settle();
  assert.equal(getJson.calls.length, 0, "不可见不拉");
  visible = true;
  controller.ensureTrips();
  await settle();
  assert.deepEqual(getJson.calls.map((c) => c[0]), ["/api/metrics?kind=validation&serverId=server-01"]);
  active = "server-02";
  controller.ensureTrips();
  await settle();
  assert.equal(getJson.calls.at(-1)[0], "/api/metrics?kind=validation&serverId=server-02");
});
