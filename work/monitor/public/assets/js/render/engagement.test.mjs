// 流畅或静止：在用 = 可见 + 前台 + 最近有操作 + 没开减弱动效；切换时通知订阅者，空闲判定只用一个定时器。
import assert from "node:assert/strict";
import test from "node:test";

import { createEngagement, ENGAGED_MS } from "./engagement.js";

function harness({ focused = true, reduced = false } = {}) {
  const clock = { t: 1000 };
  const timers = [];
  const listeners = new Map();
  const mqListeners = new Set();
  const mq = { matches: reduced, addEventListener: (_type, fn) => mqListeners.add(fn) };
  const win = {
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock.t + ms }); return timers.length; },
    matchMedia: () => mq,
    addEventListener: (type, fn) => listeners.set(type, fn),
  };
  const doc = { hidden: false, hasFocus: () => focused, addEventListener: (type, fn) => listeners.set(`doc:${type}`, fn) };
  const engagement = createEngagement({ win, doc, now: () => clock.t });
  const fire = (type) => listeners.get(type)();
  // 时钟走到 t，并跑掉到点的定时器（定时器里可能再排新的）
  const advance = (ms) => {
    clock.t += ms;
    for (let guard = 0; guard < 20; guard += 1) {
      const due = timers.findIndex((tm) => tm.at <= clock.t);
      if (due < 0) break;
      timers.splice(due, 1)[0].fn();
    }
  };
  return { engagement, fire, advance, doc, mq, mqListeners, timers, setFocus: (v) => { focused = v; } };
}

test("刚打开算在用；空闲满 ENGAGED_MS 停下并通知，再有操作立刻恢复", () => {
  const h = harness();
  const seen = [];
  h.engagement.subscribe((v) => seen.push(v));
  assert.equal(h.engagement.engaged(), true);
  h.advance(ENGAGED_MS - 1000);
  h.fire("pointermove");
  h.advance(ENGAGED_MS - 1000);
  assert.equal(h.engagement.engaged(), true, "中间有过操作：从那次操作起重新计时");
  assert.deepEqual(seen, []);
  h.advance(2000);
  assert.equal(h.engagement.engaged(), false);
  assert.deepEqual(seen, [false]);
  h.fire("wheel");
  assert.equal(h.engagement.engaged(), true);
  assert.deepEqual(seen, [false, true]);
  assert.ok(h.timers.length <= 1, "任何时候最多一个空闲定时器");
});

test("失焦 / 隐藏 / 减弱动效：不算在用", () => {
  const h = harness();
  h.setFocus(false);
  h.fire("blur");
  assert.equal(h.engagement.engaged(), false);
  h.setFocus(true);
  h.fire("focus");
  assert.equal(h.engagement.engaged(), true);
  h.doc.hidden = true;
  h.fire("doc:visibilitychange");
  assert.equal(h.engagement.engaged(), false);
  h.doc.hidden = false;
  h.fire("doc:visibilitychange");
  assert.equal(h.engagement.engaged(), true);
  h.mq.matches = true;
  for (const fn of h.mqListeners) fn();
  assert.equal(h.engagement.engaged(), false);
  assert.equal(harness({ reduced: true }).engagement.engaged(), false);
});

test("订阅者抛错不影响其他订阅者；退订后不再通知", () => {
  const h = harness();
  const seen = [];
  h.engagement.subscribe(() => { throw new Error("boom"); });
  const off = h.engagement.subscribe((v) => seen.push(v));
  h.advance(ENGAGED_MS + 10);
  assert.deepEqual(seen, [false]);
  off();
  h.fire("keydown");
  assert.deepEqual(seen, [false]);
});
