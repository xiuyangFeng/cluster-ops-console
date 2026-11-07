import assert from "node:assert/strict";
import test from "node:test";

import { createViewTabs, VIEW_STORAGE_KEY, VIEWS } from "./view-tabs.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

function setup(saved = null) {
  const tabs = VIEWS.map((view) => fakeElement({ tag: "button", dataset: { view } }));
  const sections = Object.fromEntries(VIEWS.map((view) => [`view-${view}`, fakeElement({ tag: "section" })]));
  const goto = fakeElement({ dataset: { gotoView: "events" } });
  const doc = fakeDocument(sections, { ".view-tab": tabs, "[data-goto-view]": [goto] });
  const store = new Map(saved == null ? [] : [[VIEW_STORAGE_KEY, saved]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const onEnter = spy();
  const viewTabs = createViewTabs({ doc, storage });
  return { doc, tabs, sections, goto, store, onEnter, viewTabs };
}

const activeView = ({ tabs, sections }) => {
  const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.view);
  const visible = VIEWS.filter((v) => !sections[`view-${v}`].hidden && sections[`view-${v}`].classList.contains("active"));
  const focusable = tabs.filter((t) => t.tabIndex === 0).map((t) => t.dataset.view);
  const current = tabs.filter((t) => t.getAttribute("aria-current") === "page").map((t) => t.dataset.view);
  assert.deepEqual(selected, visible, "标签选中态与视图显隐一致");
  assert.deepEqual(focusable, visible, "只有当前标签可 Tab 聚焦");
  assert.deepEqual(current, visible, "当前页带 aria-current=page，切页时一起搬");
  return visible[0];
};

test("initViewTabs: 恢复上次停留的视图并调 onEnter；无效记录回落概览", () => {
  const ctx = setup("events");
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  assert.equal(activeView(ctx), "events");
  assert.deepEqual(ctx.onEnter.calls, [["events"]]);

  const junk = setup("settings");
  junk.viewTabs.initViewTabs({ onEnter: junk.onEnter });
  assert.equal(activeView(junk), "overview");
});

test("switchView: 持久化 + 切换 + onEnter；未知视图（含已无视图的 settings）忽略", () => {
  const ctx = setup();
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  ctx.viewTabs.switchView("servers");
  assert.equal(activeView(ctx), "servers");
  assert.equal(ctx.store.get(VIEW_STORAGE_KEY), "servers");
  assert.equal(ctx.viewTabs.isViewVisible("servers"), true);
  assert.equal(ctx.viewTabs.isViewVisible("events"), false);
  ctx.viewTabs.switchView("settings");
  ctx.viewTabs.switchView("bogus");
  assert.equal(activeView(ctx), "servers");
  assert.deepEqual(ctx.onEnter.calls.map((c) => c[0]), ["overview", "servers"]);
});

test("标签点击、[data-goto-view] 与方向键/Home/End 循环切换", async () => {
  const ctx = setup();
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  await ctx.tabs[1].dispatch("click");
  assert.equal(activeView(ctx), "servers");
  await ctx.goto.dispatch("click");
  assert.equal(activeView(ctx), "events");
  const lastTab = ctx.tabs.at(-1);
  await lastTab.dispatch("click");
  const right = await lastTab.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(right.defaultPrevented, true);
  assert.equal(activeView(ctx), "overview", "末尾向右回到第一个");
  assert.equal(ctx.tabs[0].focused, true);
  await ctx.tabs[0].dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(activeView(ctx), VIEWS.at(-1), "开头向左回到最后一个");
  await ctx.tabs[2].dispatch("keydown", { key: "Home" });
  assert.equal(activeView(ctx), "overview");
  await ctx.tabs[0].dispatch("keydown", { key: "End" });
  assert.equal(activeView(ctx), VIEWS.at(-1));
  const other = await ctx.tabs[2].dispatch("keydown", { key: "a" });
  assert.equal(other.defaultPrevented, false);
});

test("setHiddenViews：隐藏视图的标签与跳转按钮一起藏；切换忽略隐藏视图；概览不可隐藏", async () => {
  const ctx = setup();
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  ctx.viewTabs.setHiddenViews(["events", "overview", "bogus"]);
  assert.deepEqual(ctx.tabs.map((t) => t.hidden), [false, false, true, false, false, false]);
  assert.equal(ctx.goto.hidden, true, "「查看全部事件 →」随事件页隐藏");
  ctx.viewTabs.switchView("events");
  await ctx.goto.dispatch("click");
  assert.equal(activeView(ctx), "overview");
  ctx.viewTabs.setHiddenViews([]);
  assert.equal(ctx.tabs[2].hidden, false);
  assert.equal(ctx.goto.hidden, false);
  ctx.viewTabs.switchView("events");
  assert.equal(activeView(ctx), "events");
});

test("setHiddenViews：当前视图被隐藏 → 回到概览并触发 onEnter；方向键循环跳过隐藏的标签", async () => {
  const ctx = setup();
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  ctx.viewTabs.switchView("usage");
  ctx.viewTabs.setHiddenViews(["usage"]);
  assert.equal(activeView(ctx), "overview");
  assert.deepEqual(ctx.onEnter.calls.map((c) => c[0]), ["overview", "usage", "overview"]);

  ctx.viewTabs.setHiddenViews(["servers", "usage", "team", "storage"]);
  await ctx.tabs[0].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(activeView(ctx), "events", "跳过隐藏的服务器页");
  await ctx.tabs[2].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(activeView(ctx), "overview", "跳过隐藏的用量、团队与存储管理页回到开头");
  await ctx.tabs[0].dispatch("keydown", { key: "End" });
  assert.equal(activeView(ctx), "events");
});

test("initViewTabs：上次停留的视图已被隐藏（初始化前应用）→ 落在概览", () => {
  const ctx = setup("usage");
  ctx.viewTabs.setHiddenViews(["usage"]);
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  assert.equal(activeView(ctx), "overview");
  assert.deepEqual(ctx.onEnter.calls, [["overview"]]);
  assert.equal(ctx.store.get(VIEW_STORAGE_KEY), "usage", "只是暂时落在概览，不改写记住的选择");
});

test("重复点击当前页不重新加载；跨页往返独立恢复阅读位置，首次进入从顶部开始", () => {
  const ctx = setup();
  const scroller = { scrollTop: 0 };
  ctx.doc.scrollingElement = scroller;
  ctx.viewTabs.initViewTabs({ onEnter: ctx.onEnter });
  scroller.scrollTop = 120;
  ctx.viewTabs.switchView("servers");
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 900;
  ctx.viewTabs.switchView("servers");
  assert.equal(scroller.scrollTop, 900);
  assert.deepEqual(ctx.onEnter.calls, [["overview"], ["servers"]]);
  ctx.viewTabs.switchView("events");
  assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 60;
  ctx.viewTabs.switchView("servers");
  assert.equal(scroller.scrollTop, 900);
  ctx.viewTabs.switchView("overview");
  assert.equal(scroller.scrollTop, 120);
  ctx.viewTabs.switchView("events");
  assert.equal(scroller.scrollTop, 60);
});

test("恢复滚动发生在 onEnter 补渲之后；隐藏当前页仍回到概览保存的位置", () => {
  const ctx = setup();
  const scroller = { scrollTop: 0 };
  ctx.doc.scrollingElement = scroller;
  ctx.viewTabs.initViewTabs({ onEnter: () => { scroller.scrollTop = 0; } });
  scroller.scrollTop = 100;
  ctx.viewTabs.switchView("servers");
  scroller.scrollTop = 800;
  ctx.viewTabs.setHiddenViews(["servers"]);
  assert.equal(activeView(ctx), "overview");
  assert.equal(scroller.scrollTop, 100);
});
