import assert from "node:assert/strict";
import test from "node:test";

import { fakeDocument, fakeElement, spy } from "./test-support.mjs";
import { createTunnelStabilityController, TUNNEL_RESPONSE_REFRESH_MS, TUNNEL_STABILITY_POLL_MS } from "./tunnel-stability-controller.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 3, 10, 30, 0);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ stored = null, metrics = () => [], stats = { since: T0 - DAY, generatedAt: T0, servers: {}, recentDrops: [] } } = {}) {
  let nowMs = T0;
  const root = fakeElement({ tag: "section" });
  const doc = fakeDocument({ chainUptime: root });
  const saved = [];
  const renders = [];
  const view = { render: (s, state) => { renders.push({ stats: s, ...state, expandedDrops: [...state.expandedDrops] }); return []; } };
  const getJson = spy(async (path) => {
    if (path === "/api/tunnel-stability") return stats;
    if (path.startsWith("/api/metrics?since=")) return { samples: metrics(Number(path.split("=")[1])) };
    throw new Error(`unexpected ${path}`);
  });
  const fed = [];
  const controller = createTunnelStabilityController({
    doc,
    getJson,
    isViewVisible: () => false, // 不可见：不排轮询定时器，测试里手动 refresh
    isHidden: () => false,
    onStability: (value) => fed.push(value),
    storage: { getItem: () => stored, setItem: (_key, value) => saved.push(value) },
    now: () => nowMs,
    view,
  });
  // 在 #chainUptime 上模拟一次点击：target 是带 data-* 的按钮（事件委托）。
  const click = (dataset) => root.dispatch("click", { target: fakeElement({ tag: "button", dataset, parent: root }) });
  return { controller, getJson, root, saved, renders, fed, click, advance: (ms) => { nowMs += ms; }, paths: () => getJson.calls.map((c) => c[0]) };
}

test("SSH 响应：首次取整 24 小时，之后只取上一条之后的新样本，一分钟内不重复取", async () => {
  const ctx = setup({
    metrics: (since) => [
      { ts: T0 - 120_000, serverId: "a", kind: "resource", probeDurationMs: 300 },
      { ts: T0 - 60_000, serverId: "b", kind: "resource", probeDurationMs: 1700 },
      { ts: T0 + 30_000, serverId: "a", kind: "resource", probeDurationMs: 320 },
    ].filter((s) => s.ts >= since && s.ts <= T0 + 61_000),
  });
  await ctx.controller.refresh();
  assert.deepEqual(ctx.paths(), ["/api/tunnel-stability", `/api/metrics?since=${T0 - DAY}`]);

  // 30 秒后的下一轮轮询：断线统计照取，响应序列不取
  ctx.advance(30_000);
  await ctx.controller.refresh();
  assert.deepEqual(ctx.paths().slice(2), ["/api/tunnel-stability"]);

  // 满一分钟：从缓存里最新一条之后增量取
  ctx.advance(TUNNEL_RESPONSE_REFRESH_MS - 30_000);
  await ctx.controller.refresh();
  assert.deepEqual(ctx.paths().slice(3), ["/api/tunnel-stability", `/api/metrics?since=${T0 + 30_000 + 1}`]);
});

test("SSH 响应：取不到不影响断线统计；缓存整体过期（隔了一天多）时重新整段取", async () => {
  let fail = true;
  const ctx = setup({
    metrics: () => {
      if (fail) throw new Error("boom");
      return [{ ts: T0, serverId: "a", kind: "resource", probeDurationMs: 300 }];
    },
  });
  await assert.doesNotReject(ctx.controller.refresh());
  assert.equal(ctx.paths().length, 2);
  assert.equal(ctx.renders.length, 1, "响应线取不到，断线统计照常渲染");
  fail = false;
  ctx.advance(TUNNEL_RESPONSE_REFRESH_MS);
  await ctx.controller.refresh();
  assert.equal(ctx.paths().at(-1), `/api/metrics?since=${T0 + TUNNEL_RESPONSE_REFRESH_MS - DAY}`);
  // 窗口被隐藏了一天多：最新一条已经在 24 小时之外，按整段取
  ctx.advance(2 * DAY);
  await ctx.controller.refresh();
  assert.equal(ctx.paths().at(-1), `/api/metrics?since=${T0 + TUNNEL_RESPONSE_REFRESH_MS + DAY}`);
});

test("近 7 天窗口不取响应序列；点表头的窗口切换：切回近 24 小时时补取并记住选择", async () => {
  const ctx = setup({ stored: "7d" });
  ctx.controller.bind();
  await ctx.controller.refresh();
  assert.deepEqual(ctx.paths(), ["/api/tunnel-stability"]);
  assert.equal(ctx.renders.at(-1).windowKey, "7d");

  await ctx.click({ stabilityWindow: "24h" });
  await settle();
  assert.deepEqual(ctx.saved, ["24h"]);
  assert.deepEqual(ctx.paths().slice(1), ["/api/tunnel-stability", `/api/metrics?since=${T0 - DAY}`]);
  assert.equal(ctx.renders.at(-1).windowKey, "24h");

  // 切到 7 天再切回来：一分钟内已经取过，不再请求
  await ctx.click({ stabilityWindow: "7d" });
  await ctx.click({ stabilityWindow: "24h" });
  await settle();
  assert.equal(ctx.paths().length, 3);
});

test("拿到统计就经 onStability 送给链路面板；拉取失败的那一轮不送、不重渲", async () => {
  const ctx = setup();
  await ctx.controller.refresh();
  assert.deepEqual(ctx.fed, [ctx.renders[0].stats]);
  const broken = createTunnelStabilityController({
    doc: fakeDocument({}), getJson: async () => { throw new Error("boom"); }, isViewVisible: () => false, isHidden: () => false,
    onStability: () => assert.fail("失败时不该送"), storage: null, now: () => T0, view: { render: () => assert.fail("失败时不该重渲") },
  });
  await assert.doesNotReject(broken.refresh());
});

test("面板被隐藏（界面面板）：照常轮询断线统计送链路面板，但不渲染、不取 SSH 响应序列", async () => {
  const fed = [];
  const timers = [];
  const urls = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (_fn, ms) => { timers.push(ms); return 0; };
  try {
    const hiddenPanel = createTunnelStabilityController({
      doc: fakeDocument({}),
      getJson: async (url) => { urls.push(url); return { since: T0 - DAY, generatedAt: T0, servers: {}, recentDrops: [] }; },
      isViewVisible: () => true, isHidden: () => false, isPanelHidden: () => true,
      onStability: (value) => fed.push(value), storage: null, now: () => T0, view: { render: () => assert.fail("隐藏时不该渲染") },
    });
    hiddenPanel.enter();
    await hiddenPanel.refresh();
    assert.equal(fed.length, 1);
    assert.ok(timers.includes(TUNNEL_STABILITY_POLL_MS), "链路面板仍需断线统计 → 照常排下一轮");
    assert.ok(urls.every((url) => !url.startsWith("/api/metrics")), "隐藏时不取 SSH 响应序列");
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("断线清单：按钮切换展开；点断线刻度 → 展开清单并展开它所在的组", async () => {
  const at = (h) => T0 - h * 3_600_000;
  const stats = {
    since: T0 - 2 * DAY, generatedAt: T0, servers: { a: { serverId: "a", name: "阿里云服务器", windows: { "24h": { drops: 3 } } } },
    recentDrops: [3, 4, 5].map((h) => ({ serverId: "a", at: at(h), cause: "remote-closed", recoveredAt: at(h) + 20_000, downMs: 20_000 })),
  };
  const ctx = setup({ stats });
  ctx.controller.bind();
  await ctx.controller.refresh();
  assert.equal(ctx.renders.at(-1).dropsOpen, false, "默认收起");

  await ctx.click({ stabilityDrops: "" });
  assert.equal(ctx.renders.at(-1).dropsOpen, true);
  await ctx.click({ stabilityDrops: "" });
  assert.equal(ctx.renders.at(-1).dropsOpen, false);

  await ctx.click({ dropKey: `a:${at(4)}` });
  const last = ctx.renders.at(-1);
  assert.equal(last.dropsOpen, true);
  assert.deepEqual(last.expandedDrops, [`g:a:remote-closed:${at(5)}`], "三次连续同因断线合成一组，定位时先展开它");
});
