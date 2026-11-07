import assert from "node:assert/strict";
import test from "node:test";

import { morphInnerHtml } from "./dom-utils.js";
import { COUNT_MS, createMotion, ENTRANCE, formatFigure, parseFigure } from "./motion.js";

test("入场关键帧只动 transform / opacity / clip-path（圆环例外：dasharray）", () => {
  const ALLOWED = new Set(["transform", "transformOrigin", "opacity", "clipPath"]);
  for (const spec of ENTRANCE) {
    for (const frame of spec.keyframes("scaleX(0.5)")) {
      for (const prop of Object.keys(frame)) {
        const ok = ALLOWED.has(prop) || (spec.name === "arc" && prop === "strokeDasharray");
        assert.ok(ok, `${spec.name} 不该动画 ${prop}`);
      }
    }
    assert.ok(spec.duration <= 900, `${spec.name} 时长不超过 900ms`);
  }
});

test("parseFigure / formatFigure：保留前后缀、小数位与千分位", () => {
  assert.deepEqual(parseFigure("13%"), { prefix: "", value: 13, decimals: 0, grouped: false, suffix: "%" });
  const g = parseFigure("1,316");
  assert.equal(formatFigure(g, 658), "658");
  assert.equal(formatFigure(g, 1316), "1,316");
  const d = parseFigure(" 3.18");
  assert.equal(formatFigure(d, 1.5), " 1.50");
  assert.equal(parseFigure("—"), null);
  assert.equal(parseFigure(""), null);
});

function fakeEl({ transform = "none", dash = "", w = 100, h = 6 } = {}) {
  return { animate: (...args) => { fakeEl.calls.push(args); }, style: { strokeDasharray: dash }, _t: transform, offsetWidth: w, offsetHeight: h };
}
fakeEl.calls = [];

function fakeRoot(map) {
  return { dataset: {}, querySelectorAll: (sel) => map[sel] || [] };
}

function setup({ reduced = false, hidden = false, inView } = {}) {
  fakeEl.calls = [];
  const frames = [];
  let t = 0;
  const doc = { hidden, body: { hasAttribute: () => false }, addEventListener() {} };
  const motion = createMotion({
    doc,
    matchMedia: () => ({ matches: reduced }),
    raf: (fn) => frames.push(fn),
    now: () => t,
    getStyle: (el) => ({ transform: el._t, strokeDasharray: el.style.strokeDasharray }),
    ...(inView ? { inView } : {}),
  });
  return { motion, frames, tick: (ms) => { t += ms; for (const fn of frames.splice(0)) fn(); } };
}

test("playEntrance：每块只播一次；折线揭开、计量条从 0 长到当前值、圆环沿弧长画出；force 可重放", () => {
  const ctx = setup();
  const line = fakeEl();
  const meter = fakeEl({ transform: "matrix(0.4, 0, 0, 1, 0, 0)" });
  const ring = fakeEl({ dash: "33.3 100" });
  const root = fakeRoot({ [ENTRANCE[0].selector]: [line], [ENTRANCE[1].selector]: [meter], [ENTRANCE[2].selector]: [ring] });
  assert.equal(ctx.motion.playEntrance(root), true);
  assert.equal(fakeEl.calls.length, 3);
  assert.deepEqual(fakeEl.calls[0][0][0].clipPath, "inset(0 100% 0 0)");
  assert.deepEqual(fakeEl.calls[1][0], [{ transform: "scaleX(0)", transformOrigin: "left center" }, { transform: "matrix(0.4, 0, 0, 1, 0, 0)", transformOrigin: "left center" }]);
  assert.deepEqual(fakeEl.calls[2][0], [{ strokeDasharray: "0 100" }, { strokeDasharray: "33.3 100" }]);
  assert.equal(fakeEl.calls[0][1].fill, "none", "动画结束后元素回到自己的样式");

  assert.equal(ctx.motion.playEntrance(root), false, "第二次不播（刷新 / 切回来）");
  assert.equal(fakeEl.calls.length, 3);
  assert.equal(ctx.motion.playEntrance(root, { force: true }), true);
  assert.equal(fakeEl.calls.length, 6);
});

test("竖条（概览服务器卡的 GPU 柱）从底部长出，横条从左长出", () => {
  const ctx = setup();
  const column = fakeEl({ transform: "matrix(1, 0, 0, 0.6, 0, 0)", w: 7, h: 19 });
  ctx.motion.playEntrance(fakeRoot({ [ENTRANCE[1].selector]: [column] }));
  assert.deepEqual(fakeEl.calls[0][0], [{ transform: "scaleY(0)", transformOrigin: "center bottom" }, { transform: "matrix(1, 0, 0, 0.6, 0, 0)", transformOrigin: "center bottom" }]);
});

test("perf：只给视口里的元素播，每类封顶 maxAnimated（上百根计量条不再全部升成合成层）", () => {
  const grow = ENTRANCE.find((spec) => spec.name === "grow");
  const bars = Array.from({ length: 200 }, (_, i) => Object.assign(fakeEl({ transform: "matrix(0.5, 0, 0, 1, 0, 0)" }), { offscreen: i % 2 === 1 }));
  const ctx = setup({ inView: (el) => !el.offscreen });
  ctx.motion.playEntrance(fakeRoot({ [grow.selector]: bars }));
  assert.equal(fakeEl.calls.length, grow.maxAnimated);
  for (const spec of ENTRANCE) assert.ok(Number.isInteger(spec.maxAnimated) && spec.maxAnimated > 0, `${spec.name} 有封顶`);
});

test("减弱动画 / 窗口隐藏：一律不播", () => {
  const reduced = setup({ reduced: true });
  assert.equal(reduced.motion.playEntrance(fakeRoot({ [ENTRANCE[0].selector]: [fakeEl()] })), false);
  const hidden = setup({ hidden: true });
  assert.equal(hidden.motion.playEntrance(fakeRoot({ [ENTRANCE[0].selector]: [fakeEl()] })), false);
  assert.equal(fakeEl.calls.length, 0);
});

test("countUp：从 0 数到原值；中途被真实数据改写就让位", () => {
  const ctx = setup();
  const node = { nodeType: 3, data: "1,316" };
  assert.equal(ctx.motion.countUp({ childNodes: [node] }), true);
  assert.equal(node.data, "0");
  ctx.tick(COUNT_MS / 2);
  const mid = Number(node.data.replace(/,/g, ""));
  assert.ok(mid > 0 && mid < 1316, `半程在 0 与目标之间：${node.data}`);
  ctx.tick(COUNT_MS);
  assert.equal(node.data, "1,316", "结束时恢复原文");

  const live = { nodeType: 3, data: "42%" };
  ctx.motion.countUp({ childNodes: [live] });
  live.data = "43%"; // 刷新改写
  ctx.tick(COUNT_MS);
  assert.equal(live.data, "43%", "不覆盖真值");

  assert.equal(ctx.motion.countUp({ childNodes: [{ nodeType: 3, data: "—" }] }), false);
});

test("playView：跳过还在骨架里的面板，只认最外层面板", () => {
  const ctx = setup();
  const ready = fakeRoot({});
  ready.parentElement = { closest: () => null };
  const loading = fakeRoot({});
  loading.dataset.skeleton = "loading";
  loading.parentElement = { closest: () => null };
  const nested = fakeRoot({});
  nested.parentElement = { closest: () => ({}) };
  ctx.motion.playView({ querySelectorAll: () => [ready, loading, nested] });
  assert.equal(ctx.motion.hasPlayed(ready), true);
  assert.equal(ctx.motion.hasPlayed(loading), false);
  assert.equal(ctx.motion.hasPlayed(nested), false);
});

test("countUp：改写文本节点后使祖先容器的 morphInnerHtml 缓存失效，相同 HTML 重渲时能恢复真值", () => {
  const ctx = setup();
  const textNode = { nodeType: 3, nodeName: "#text", data: "63%", get nodeValue() { return this.data; }, set nodeValue(v) { this.data = v; } };
  const valEl = { nodeType: 1, nodeName: "DIV", attributes: [], childNodes: [textNode], hasAttribute: () => false, getAttribute: () => null, setAttribute() {}, removeAttribute() {} };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    childNodes: [valEl],
    ownerDocument: {
      createElement: () => ({
        set innerHTML(_v) {},
        content: {
          nodeType: 11,
          childNodes: [{
            nodeType: 1,
            nodeName: "DIV",
            attributes: [],
            hasAttribute: () => false,
            childNodes: [{ nodeType: 3, nodeName: "#text", nodeValue: "63%" }],
          }],
        },
      }),
    },
  };
  valEl.parentElement = container;
  morphInnerHtml(container, "<div>63%</div>");
  assert.equal(ctx.motion.countUp(valEl), true);
  assert.equal(textNode.data, "0%");
  // 同一份 HTML 再次 morph：由于 countUp 已使 container 的 morph 缓存失效，文本节点应恢复为 63%
  morphInnerHtml(container, "<div>63%</div>");
  assert.equal(textNode.data, "63%");
});

