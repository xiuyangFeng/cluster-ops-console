// 换肤过场：幕布盖住页面时（onCovered）才换皮肤；停留后收场并关掉 popover；连切时上一场该换的立刻换掉。
import assert from "node:assert/strict";
import test from "node:test";

import { createSkinTransition } from "./skin-transition.js";

function makeEnv({ reduced = false } = {}) {
  const classes = new Set();
  let open = false;
  const overlay = {
    dataset: {},
    onclick: null,
    classList: { add: (c) => classes.add(c), remove: (...cs) => { for (const c of cs) classes.delete(c); } },
    showPopover: () => { open = true; },
    hidePopover: () => { open = false; },
    matches: (sel) => sel === ":popover-open" && open,
  };
  const els = { celestialOverlay: overlay, celestialOverlaySvg: { innerHTML: "" }, celestialOverlayCaption: { innerHTML: "" } };
  const doc = { getElementById: (id) => els[id] || null };
  const win = { requestAnimationFrame: (fn) => fn(), matchMedia: () => ({ matches: reduced }) };
  return { doc, win, overlay, els, classes, isOpen: () => open };
}

test("play: 点亮 → 盖住时换皮肤 → 停留后收场并关掉遮罩", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = makeEnv();
  const covered = [];
  createSkinTransition(env).play("paper", { onCovered: () => covered.push("paper") });
  assert.ok(env.isOpen(), "popover 进了 top layer");
  assert.ok(env.classes.has("is-active"));
  assert.equal(env.overlay.dataset.dir, "to-light");
  assert.match(env.els.celestialOverlayCaption.innerHTML, /破晓日出/);
  assert.deepEqual(covered, [], "幕布还没盖住时不换");
  t.mock.timers.tick(420);
  assert.deepEqual(covered, ["paper"]);
  t.mock.timers.tick(2999);
  assert.ok(!env.classes.has("is-leaving"), "停留期间不收场");
  t.mock.timers.tick(1);
  assert.ok(env.classes.has("is-leaving"));
  t.mock.timers.tick(700);
  assert.ok(!env.isOpen());
  assert.ok(!env.classes.has("is-active") && !env.classes.has("is-leaving"));
  assert.deepEqual(covered, ["paper"], "只换一次");
});

test("play: 点一下幕布提前收场；连切时上一场的皮肤立刻换上", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = makeEnv();
  const covered = [];
  const tr = createSkinTransition(env);
  tr.play("starry", { onCovered: () => covered.push("starry") });
  tr.play("classic", { onCovered: () => covered.push("classic") });
  assert.deepEqual(covered, ["starry"], "上一场没盖住就被打断：它的皮肤立刻换");
  assert.equal(env.overlay.dataset.dir, "to-classic");
  env.overlay.onclick();
  assert.deepEqual(covered, ["starry", "classic"], "提前收场也要换上皮肤");
  assert.ok(env.classes.has("is-leaving"));
  t.mock.timers.tick(5000);
  assert.deepEqual(covered, ["starry", "classic"]);
  assert.ok(!env.isOpen());
});

test("play: 减少动态效果时节奏缩短；没有遮罩节点时直接换", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const env = makeEnv({ reduced: true });
  const covered = [];
  createSkinTransition(env).play("starry", { onCovered: () => covered.push(1) });
  t.mock.timers.tick(120);
  assert.equal(covered.length, 1);
  t.mock.timers.tick(1100);
  t.mock.timers.tick(200);
  assert.ok(!env.isOpen());

  const bare = [];
  createSkinTransition({ doc: { getElementById: () => null }, win: {} }).play("paper", { onCovered: () => bare.push(1) });
  assert.equal(bare.length, 1);
});
