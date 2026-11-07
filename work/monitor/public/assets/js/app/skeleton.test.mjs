import assert from "node:assert/strict";
import test from "node:test";

import {
  createHoldGroup,
  createSkeletons,
  SKELETON_HEIGHTS_KEY,
  SKELETON_MIN_SHOW_MS,
  SKELETON_PANELS,
  SKELETON_SHAPES,
  SKELETON_SHOW_AFTER_MS,
  SKELETON_TIMEOUT_MS,
} from "./skeleton.js";

// 最小假 DOM：只实现骨架用到的接口
function fakeNode(tag = "div") {
  const classes = new Set();
  const attrs = new Map();
  const node = {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    children: [],
    innerHTML: "",
    offsetHeight: 0,
    shown: true,
    parent: null,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    get className() { return [...classes].join(" "); },
    set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    removeAttribute: (k) => attrs.delete(k),
    append(child) { child.parent = node; node.children.push(child); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
    querySelector: (sel) => (sel === ":scope > .panel-header" ? node.header || null : null),
    getClientRects: () => (node.shown ? [{}] : []),
  };
  return node;
}

// 手动时钟 + 计时器：测试决定时间流逝
function clock() {
  let t = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { id += 1; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (i) => timers.delete(i),
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    },
  };
}

function setup({ ready = false, stored = null, panels } = {}) {
  const c = clock();
  const host = fakeNode("article");
  host.header = { offsetHeight: 48 };
  const state = { ready };
  const list = panels || [{ id: "chain", host: "#chainPanel", shape: "row", height: 200, ready: () => state.ready }];
  const doc = {
    querySelector: (sel) => (sel === "#chainPanel" ? host : null),
    createElement: (tag) => fakeNode(tag),
  };
  const store = new Map(stored ? [[SKELETON_HEIGHTS_KEY, JSON.stringify(stored)]] : []);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  let notify = null;
  const revealed = [];
  const sk = createSkeletons({
    doc, storage, panels: list, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    observe: (_target, fn) => { notify = fn; return () => { notify = null; }; },
    onReveal: (_host, info) => revealed.push(info),
  });
  return { c, host, state, sk, store, revealed, mutate: () => notify?.(), skeletonEl: () => host.children.find((n) => n.className.includes("skeleton")) };
}

test("形状与登记：每个登记的形状都存在、只产出静态结构（不含插值占位）", () => {
  for (const p of SKELETON_PANELS) {
    assert.ok(SKELETON_SHAPES[p.shape], `${p.id} 的形状 ${p.shape} 存在`);
    const html = SKELETON_SHAPES[p.shape]();
    assert.match(html, /class="sk/);
    assert.doesNotMatch(html, /undefined|\$\{/);
    assert.ok(p.height > 0);
  }
});

test("已就绪的面板不上骨架", () => {
  const ctx = setup({ ready: true });
  assert.equal(ctx.sk.attach("chain"), false);
  assert.equal(ctx.host.children.length, 0);
});

test("数据 150ms 内到：骨架从未显出就撤掉，内容直接出现", () => {
  const ctx = setup();
  ctx.sk.attachAll();
  const el = ctx.skeletonEl();
  assert.ok(el.className.includes("is-pending"), "先隐身");
  assert.equal(ctx.host.dataset.skeleton, "loading");
  assert.equal(ctx.host.getAttribute("aria-busy"), "true");
  assert.equal(el.style.top, "48px", "让出面板头");
  ctx.c.advance(SKELETON_SHOW_AFTER_MS - 50);
  ctx.state.ready = true;
  ctx.mutate();
  assert.equal(ctx.skeletonEl(), undefined, "没显出过：立即移除");
  assert.equal(ctx.host.dataset.skeleton, "revealing");
  assert.deepEqual(ctx.revealed, [{ id: "chain", wasShown: false }]);
});

test("骨架显出后至少停 300ms，再淡出交给入场动效", () => {
  const ctx = setup();
  ctx.sk.attachAll();
  ctx.c.advance(SKELETON_SHOW_AFTER_MS);
  assert.equal(ctx.skeletonEl().className.includes("is-pending"), false, "150ms 后显出");
  ctx.c.advance(100);
  ctx.state.ready = true;
  ctx.mutate();
  assert.equal(ctx.revealed.length, 0, "显出才 100ms，还要再等");
  ctx.c.advance(SKELETON_MIN_SHOW_MS - 100);
  assert.deepEqual(ctx.revealed, [{ id: "chain", wasShown: true }]);
  assert.ok(ctx.skeletonEl().className.includes("is-leaving"), "交叉淡出");
  ctx.c.advance(400);
  assert.equal(ctx.skeletonEl(), undefined);
  assert.equal(ctx.host.dataset.skeleton, undefined);
});

test("高度：首次用默认值，撤掉后记住真实高度，下次按记住的高度占位", () => {
  const ctx = setup();
  ctx.sk.attachAll();
  assert.equal(ctx.host.style.minHeight, "200px");
  ctx.state.ready = true;
  ctx.mutate();
  ctx.host.offsetHeight = 487;
  ctx.c.advance(500);
  assert.equal(ctx.host.style.minHeight, "");
  assert.deepEqual(JSON.parse(ctx.store.get(SKELETON_HEIGHTS_KEY)), { chain: 487 });

  const again = setup({ stored: { chain: 487 } });
  again.sk.attachAll();
  assert.equal(again.host.style.minHeight, "487px");
});

test("超时只在这块正被看着时生效；没在看的视图里原地等着", () => {
  const ctx = setup();
  ctx.host.shown = false;
  ctx.sk.attachAll();
  ctx.c.advance(SKELETON_TIMEOUT_MS * 2);
  assert.equal(ctx.sk.isLoading("chain"), true, "看不见：继续等");
  ctx.host.shown = true;
  ctx.c.advance(SKELETON_TIMEOUT_MS);
  assert.equal(ctx.sk.isLoading("chain"), false, "看得见且超时：露出真实内容");
});

test("面板本身被隐藏（面板显隐 / 没有 Slurm）：到点直接撤掉，不再空转", () => {
  const ctx = setup();
  ctx.host.shown = false;
  ctx.host.hidden = true;
  ctx.sk.attachAll();
  ctx.c.advance(SKELETON_TIMEOUT_MS);
  assert.equal(ctx.sk.isLoading("chain"), false);
});

test("hold / release：切换查看的服务器时即便内容已在也回到骨架，直到新状态渲染完", () => {
  const ctx = setup({ ready: true });
  ctx.sk.hold(["chain"]);
  assert.equal(ctx.sk.isLoading("chain"), true);
  ctx.mutate(); // 旧内容在变也不算就绪
  ctx.c.advance(SKELETON_SHOW_AFTER_MS + 50);
  assert.equal(ctx.sk.isLoading("chain"), true);
  ctx.sk.release(["chain"]);
  ctx.c.advance(SKELETON_MIN_SHOW_MS);
  assert.equal(ctx.sk.isLoading("chain"), false);
  assert.equal(ctx.revealed.length, 1);
});

test("就绪判断本身抛错：按就绪处理，不让骨架卡住", () => {
  const ctx = setup({ panels: [{ id: "chain", host: "#chainPanel", shape: "row", height: 100, ready: () => { throw new Error("x"); } }] });
  assert.equal(ctx.sk.attach("chain"), false);
});

test("退场途中又来一次切换（hold）：退场完立刻再上骨架，这次切换不落空", () => {
  const ctx = setup();
  ctx.sk.attachAll();
  ctx.c.advance(SKELETON_SHOW_AFTER_MS);
  ctx.state.ready = true;
  ctx.mutate(); // 进入至少停 300ms 的退场等待
  ctx.sk.hold(["chain"]);
  ctx.c.advance(SKELETON_MIN_SHOW_MS);
  assert.equal(ctx.revealed.length, 1, "上一轮照常退场");
  assert.equal(ctx.sk.isLoading("chain"), true, "随即为这次切换重新上骨架");
  ctx.sk.release(["chain"]);
  ctx.c.advance(SKELETON_MIN_SHOW_MS + 400);
  assert.equal(ctx.sk.isLoading("chain"), false);
});

test("计时器不累积：看不见的面板每次只挂一个超时计时器", () => {
  const ctx = setup();
  ctx.host.shown = false;
  ctx.sk.attachAll();
  ctx.c.advance(SKELETON_TIMEOUT_MS * 5);
  assert.equal(ctx.sk.isLoading("chain"), true);
  assert.equal(ctx.c.pending(), 1, "只剩一个超时计时器在等");
});

test("createHoldGroup：并发等待共用一次 hold，最后一个结束才 release；忙闲回调只在首尾各一次", () => {
  const calls = [];
  const sk = { hold: (ids) => calls.push(["hold", ids]), release: (ids) => calls.push(["release", ids]) };
  const busy = [];
  const group = createHoldGroup(sk, ["resources", "cluster"], { onBusy: (b) => busy.push(b) });
  group.begin();
  group.begin();
  group.end(); // 先发的那次结束（已被丢弃）
  assert.equal(calls.filter((c) => c[0] === "release").length, 0, "还有一次在等：不撤骨架");
  group.end();
  assert.deepEqual(calls.at(-1), ["release", ["resources", "cluster"]]);
  assert.deepEqual(busy, [true, false]);
  group.end(); // 多余的 end 无害
  assert.equal(group.depth(), 0);
});

test("rememberShown：数据在视图藏着时就到了的面板，进入视图后补记真实高度（下次启动照它占位）", async () => {
  const { createSkeletons, SKELETON_HEIGHTS_KEY } = await import("./skeleton.js");
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const hosts = {
    "#shown": { hidden: false, offsetHeight: 208, getClientRects: () => [1] },
    "#hiddenView": { hidden: false, offsetHeight: 0, getClientRects: () => [] },
    "#hiddenPanel": { hidden: true, offsetHeight: 300, getClientRects: () => [1] },
  };
  const doc = { querySelector: (sel) => hosts[sel] || null };
  const panels = [
    { id: "a", host: "#shown", shape: "row", height: 360, ready: () => true },
    { id: "b", host: "#hiddenView", shape: "row", height: 360, ready: () => true },
    { id: "c", host: "#hiddenPanel", shape: "row", height: 360, ready: () => true },
  ];
  const sk = createSkeletons({ doc, storage, panels, shapes: { row: () => "" }, observe: () => () => {} });
  sk.rememberShown();
  assert.deepEqual(JSON.parse(store.get(SKELETON_HEIGHTS_KEY)), { a: 208 });
});
