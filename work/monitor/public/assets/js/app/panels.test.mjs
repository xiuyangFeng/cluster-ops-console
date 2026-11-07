import assert from "node:assert/strict";
import test from "node:test";

import {
  createPanelVisibility,
  effectiveHiddenPanels,
  hiddenViewsOf,
  moduleEnabled,
  PANELS,
  panelGroups,
  userHiddenPanels,
  VIEW_PANELS,
} from "./panels.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

test("注册表：数据链路与概览整页锁定；面板 id 不重复，每块面板都归属某个视图", () => {
  const ids = [...PANELS, ...VIEW_PANELS].map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(PANELS.find((p) => p.id === "overview.chain").locked, true);
  assert.equal(VIEW_PANELS.find((p) => p.id === "view.overview").locked, true);
  const views = new Set(VIEW_PANELS.map((p) => p.view));
  for (const panel of PANELS) assert.ok(views.has(panel.view), panel.id);
  assert.deepEqual(panelGroups().map((g) => [g.view, g.panels.length]), [["overview", 5], ["servers", 3], ["events", 2], ["usage", 0]]);
});

test("effectiveHiddenPanels：个人偏好 ∪ 模块联动；锁定项、未知 id、非字符串忽略；缺字段视为全开", () => {
  assert.deepEqual([...effectiveHiddenPanels({})], []);
  assert.deepEqual([...effectiveHiddenPanels(null)], []);
  assert.equal(moduleEnabled({}, "usage"), true, "旧后端 / 夹具没有 modules → 全开");
  assert.equal(moduleEnabled({ modules: {} }, "usage"), true);
  const status = { hiddenPanels: ["overview.brief", "overview.chain", "view.overview", "bogus.panel", 42, "overview.brief"], modules: { usage: true, jobs: false } };
  assert.deepEqual(userHiddenPanels(status), ["overview.brief"]);
  assert.deepEqual([...effectiveHiddenPanels(status)], ["overview.brief"]);
  const usageOff = effectiveHiddenPanels({ hiddenPanels: ["view.events"], modules: { usage: false } });
  assert.deepEqual([...usageOff].sort(), ["view.events", "view.usage"]);
  assert.deepEqual(hiddenViewsOf(usageOff).sort(), ["events", "usage"]);
  const daemonsOff = effectiveHiddenPanels({ modules: { usage: true, jobs: true, daemons: false } });
  assert.deepEqual([...daemonsOff], ["servers.daemons"], "远端守护进程模块关闭 → 服务器页那块面板隐藏，整页不受影响");
  assert.deepEqual(hiddenViewsOf(daemonsOff), []);
});

function setup() {
  const elements = Object.fromEntries(PANELS.map((p) => [p.el, fakeElement({ tag: "article" })]));
  elements.chainUptime.hidden = true; // 渲染层自己管的显隐：还没有数据
  elements.clusterPanel.hidden = false;
  elements.ovTop = fakeElement();
  const doc = fakeDocument(elements);
  const brief = { enter: spy(), leave: spy() };
  const stability = { enter: spy(), leave: spy() };
  const visibleViews = new Set(["overview"]);
  const onViewsChanged = spy();
  const panels = createPanelVisibility({
    doc,
    controllers: { "overview.brief": brief, "overview.stability": stability },
    isViewVisible: (view) => visibleViews.has(view),
    onViewsChanged,
  });
  return { elements, panels, brief, stability, visibleViews, onViewsChanged };
}

test("apply：隐藏的面板加 hidden、控制器 leave；重新显示时恢复并在可见视图里 enter；集合不变时什么都不做", () => {
  const ctx = setup();
  assert.equal(ctx.panels.apply({ hiddenPanels: ["overview.brief", "servers.resources"] }), true);
  assert.equal(ctx.elements.briefPanel.hidden, true);
  assert.equal(ctx.elements.resourcesPanel.hidden, true);
  assert.equal(ctx.elements.chainPanel.hidden, false, "锁定的数据链路不动");
  assert.equal(ctx.elements.chainUptime.hidden, true, "首次应用不抹掉渲染层自己的初始 hidden");
  assert.equal(ctx.panels.isHidden("overview.brief"), true);
  assert.equal(ctx.brief.leave.calls.length, 1);
  assert.equal(ctx.stability.leave.calls.length, 0);
  assert.equal(ctx.elements.ovTop.classList.contains("is-single"), true, "简报隐藏 → 链路占满整行");
  assert.deepEqual(ctx.onViewsChanged.calls.at(-1), [[]]);

  assert.equal(ctx.panels.apply({ hiddenPanels: ["servers.resources", "overview.brief"] }), false, "顺序不同、集合相同 → 不重复应用");
  assert.equal(ctx.onViewsChanged.calls.length, 1);

  ctx.panels.apply({ hiddenPanels: ["servers.resources"] });
  assert.equal(ctx.elements.briefPanel.hidden, false);
  assert.equal(ctx.brief.enter.calls.length, 1, "概览可见 → 重新显示的简报立即拉一次并续上轮询");
  assert.equal(ctx.elements.ovTop.classList.contains("is-single"), false);

  ctx.visibleViews.clear();
  ctx.panels.apply({ hiddenPanels: ["overview.brief"] });
  ctx.panels.apply({ hiddenPanels: [] });
  assert.equal(ctx.brief.enter.calls.length, 1, "所在视图不可见时重新显示不拉取，等进入概览再说");
});

test("apply：selfHidden 面板重新显示时还原隐藏前渲染层留下的状态", () => {
  const ctx = setup();
  ctx.elements.clusterPanel.hidden = true; // 这台没有 Slurm：渲染层把面板收起了
  ctx.panels.apply({ hiddenPanels: ["servers.cluster", "overview.stability"] });
  assert.equal(ctx.elements.clusterPanel.hidden, true);
  assert.equal(ctx.stability.leave.calls.length, 1);
  ctx.panels.apply({ hiddenPanels: [] });
  assert.equal(ctx.elements.clusterPanel.hidden, true, "还原成渲染层的「没有数据」状态，不露出空面板");
  assert.equal(ctx.elements.chainUptime.hidden, true);
  assert.equal(ctx.stability.enter.calls.length, 1);

  ctx.elements.chainUptime.hidden = false; // 有数据了
  ctx.panels.apply({ hiddenPanels: ["overview.stability"] });
  assert.equal(ctx.elements.chainUptime.hidden, true);
  ctx.panels.apply({ hiddenPanels: [] });
  assert.equal(ctx.elements.chainUptime.hidden, false);
});

test("apply：整页隐藏交给 onViewsChanged（含用量模块关闭联动）；gate 给控制器的可见性判断带上面板显隐", () => {
  const ctx = setup();
  ctx.panels.apply({ hiddenPanels: ["view.events"], modules: { usage: false } });
  assert.deepEqual(ctx.onViewsChanged.calls.at(-1)[0].sort(), ["events", "usage"]);
  const gated = ctx.panels.gate("overview.brief");
  assert.equal(gated("overview"), true);
  ctx.panels.apply({ hiddenPanels: ["overview.brief"] });
  assert.equal(gated("overview"), false);
  assert.equal(gated("servers"), false);
});

test("enterView：进入视图时只 enter 该视图里没被隐藏的面板，其余 leave", () => {
  const ctx = setup();
  ctx.panels.apply({ hiddenPanels: ["overview.stability"] });
  ctx.stability.leave.calls.length = 0;
  ctx.panels.enterView("overview");
  assert.equal(ctx.brief.enter.calls.length, 1);
  assert.equal(ctx.stability.enter.calls.length, 0);
  assert.equal(ctx.stability.leave.calls.length, 1);
  ctx.panels.enterView("servers");
  assert.equal(ctx.brief.leave.calls.length, 1);
  assert.equal(ctx.brief.enter.calls.length, 1);
});
