// visibility.test.mjs —— 后台省电模块单测：可见性状态源 + 渲染闸门。
import assert from "node:assert/strict";
import test from "node:test";

import {
  HIDDEN_ATTR,
  createVisibilityTracker,
  createRenderGate,
  initConsoleVisibility,
  isConsoleHidden,
  onVisibilityChange,
} from "./visibility.js";

// 假 document：可控 hidden、可触发 visibilitychange、可查 body 属性。
function makeFakeDoc({ hidden = false } = {}) {
  const attrs = new Map();
  const listeners = {};
  return {
    hidden,
    body: {
      setAttribute: (k, v) => attrs.set(k, v),
      removeAttribute: (k) => attrs.delete(k),
      hasAttribute: (k) => attrs.has(k),
    },
    addEventListener(type, fn) {
      listeners[type] ||= [];
      listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    fire(type) {
      for (const fn of [...(listeners[type] || [])]) fn();
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
  };
}

// ---- createVisibilityTracker ----

test("tracker: 隐藏/恢复翻转 body 的 data-console-hidden 属性并广播", () => {
  const doc = makeFakeDoc();
  const tracker = createVisibilityTracker(doc);
  const seen = [];
  tracker.onChange((hidden) => seen.push(hidden));

  assert.equal(tracker.isHidden(), false);
  assert.equal(doc.body.hasAttribute(HIDDEN_ATTR), false);

  doc.hidden = true;
  doc.fire("visibilitychange");
  assert.equal(tracker.isHidden(), true);
  assert.equal(doc.body.hasAttribute(HIDDEN_ATTR), true);

  doc.hidden = false;
  doc.fire("visibilitychange");
  assert.equal(tracker.isHidden(), false);
  assert.equal(doc.body.hasAttribute(HIDDEN_ATTR), false);

  assert.deepEqual(seen, [true, false]);
  tracker.dispose();
});

test("tracker: 同状态重复事件不重复广播（去抖）", () => {
  const doc = makeFakeDoc();
  const tracker = createVisibilityTracker(doc);
  const seen = [];
  tracker.onChange((hidden) => seen.push(hidden));
  doc.hidden = true;
  doc.fire("visibilitychange");
  doc.fire("visibilitychange"); // hidden 仍为 true → 不应再广播
  assert.deepEqual(seen, [true]);
  tracker.dispose();
});

test("tracker: 加载时即隐藏 → 初始同步打属性（订阅方以 isHidden 读初值，不补发广播）", () => {
  const doc = makeFakeDoc({ hidden: true });
  const tracker = createVisibilityTracker(doc);
  assert.equal(tracker.isHidden(), true);
  assert.equal(doc.body.hasAttribute(HIDDEN_ATTR), true);
  const seen = [];
  tracker.onChange((hidden) => seen.push(hidden));
  assert.deepEqual(seen, []); // 初始态不广播
  doc.hidden = false;
  doc.fire("visibilitychange");
  assert.deepEqual(seen, [false]);
  tracker.dispose();
});

test("tracker: 退订生效；单个回调抛错不阻断其余订阅者", () => {
  const doc = makeFakeDoc();
  const tracker = createVisibilityTracker(doc);
  const seen = [];
  const off = tracker.onChange(() => seen.push("a"));
  tracker.onChange(() => {
    throw new Error("boom");
  });
  tracker.onChange(() => seen.push("c"));

  doc.hidden = true;
  doc.fire("visibilitychange");
  assert.deepEqual(seen, ["a", "c"]); // 抛错的订阅者被隔离

  off();
  doc.hidden = false;
  doc.fire("visibilitychange");
  assert.deepEqual(seen, ["a", "c", "c"]); // a 已退订
  tracker.dispose();
});

test("tracker: dispose 移除 visibilitychange 监听", () => {
  const doc = makeFakeDoc();
  const tracker = createVisibilityTracker(doc);
  assert.equal(doc.listenerCount("visibilitychange"), 1);
  tracker.dispose();
  assert.equal(doc.listenerCount("visibilitychange"), 0);
});

test("tracker: doc 缺失（Node 环境）安全降级为常驻可见", () => {
  const tracker = createVisibilityTracker(null);
  assert.equal(tracker.isHidden(), false);
  const off = tracker.onChange(() => {});
  assert.equal(typeof off, "function");
  tracker.dispose(); // 不抛
});

// ---- createRenderGate ----

test("gate: 可见时直通渲染并清空缓存", () => {
  const rendered = [];
  const gate = createRenderGate({ isHidden: () => false, render: (s) => rendered.push(s) });
  assert.equal(gate.push({ v: 1 }), true);
  assert.deepEqual(rendered, [{ v: 1 }]);
  assert.equal(gate.hasPending(), false);
  assert.equal(gate.flush(), false); // 无缓存可冲刷
});

test("gate: 隐藏期只缓存最新一份，恢复时 flush 恰渲染一次", () => {
  const rendered = [];
  let hidden = true;
  const gate = createRenderGate({ isHidden: () => hidden, render: (s) => rendered.push(s) });

  assert.equal(gate.push({ v: 1 }), false);
  assert.equal(gate.push({ v: 2 }), false);
  assert.equal(gate.push({ v: 3 }), false);
  assert.deepEqual(rendered, []); // 隐藏期零渲染
  assert.equal(gate.hasPending(), true);

  hidden = false;
  assert.equal(gate.flush(), true);
  assert.deepEqual(rendered, [{ v: 3 }]); // 只冲刷最新，不回放中间态
  assert.equal(gate.hasPending(), false);
  assert.equal(gate.flush(), false); // 二次 flush 无事发生
});

test("gate: 恢复可见后的直通渲染会清掉隐藏期残留缓存（flush 不再重放旧数据）", () => {
  const rendered = [];
  let hidden = true;
  const gate = createRenderGate({ isHidden: () => hidden, render: (s) => rendered.push(s) });
  gate.push({ v: 1 }); // 隐藏期缓存
  hidden = false;
  gate.push({ v: 2 }); // 直通渲染，同时应清缓存
  assert.deepEqual(rendered, [{ v: 2 }]);
  assert.equal(gate.flush(), false); // v:1 不得再被冲刷出来
  assert.deepEqual(rendered, [{ v: 2 }]);
});

// ---- tracker + gate 集成：app.js 的接线形状 ----

test("集成: 隐藏期 push 全部缓存，visibilitychange 恢复回调里 flush 出最新", () => {
  const doc = makeFakeDoc();
  const tracker = createVisibilityTracker(doc);
  const rendered = [];
  const gate = createRenderGate({ isHidden: tracker.isHidden, render: (s) => rendered.push(s) });
  tracker.onChange((hidden) => {
    if (!hidden) gate.flush();
  });

  gate.push({ v: 1 });
  assert.deepEqual(rendered, [{ v: 1 }]); // 可见期直通

  doc.hidden = true;
  doc.fire("visibilitychange");
  gate.push({ v: 2 });
  gate.push({ v: 3 });
  assert.deepEqual(rendered, [{ v: 1 }]); // 隐藏期零渲染

  doc.hidden = false;
  doc.fire("visibilitychange"); // 恢复回调冲刷
  assert.deepEqual(rendered, [{ v: 1 }, { v: 3 }]);
  tracker.dispose();
});

// ---- 模块级单例：Node 导入安全 ----

test("单例: 无 document 环境下导入与调用安全，默认按可见处理", () => {
  assert.equal(isConsoleHidden(), false);
  const off = onVisibilityChange(() => {});
  assert.equal(typeof off, "function");
  off();
  const tracker = initConsoleVisibility(); // Node 下 document 缺省 → null doc 降级
  assert.equal(tracker.isHidden(), false);
  assert.equal(isConsoleHidden(), false);
});
