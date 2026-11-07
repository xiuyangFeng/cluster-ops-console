import assert from "node:assert/strict";
import test from "node:test";

import { createSidebar, isToggleShortcut, PAGE_TITLES, resolveSidebarState, SIDEBAR_STORAGE_KEY, tipPosition, tipText, WIDE_QUERY } from "./sidebar.js";
import { fakeDocument, fakeElement, spy } from "./test-support.mjs";

test("resolveSidebarState：宽窗按记住的选择，窄窗固定细栏、展开即浮层", () => {
  assert.deepEqual(resolveSidebarState({ wide: true, saved: null, overlayOpen: false }), { narrow: false, rail: false, overlayOpen: false });
  assert.deepEqual(resolveSidebarState({ wide: true, saved: "rail", overlayOpen: false }), { narrow: false, rail: true, overlayOpen: false });
  // 宽窗不存在浮层：即便残留 overlayOpen 也忽略
  assert.deepEqual(resolveSidebarState({ wide: true, saved: "full", overlayOpen: true }), { narrow: false, rail: false, overlayOpen: false });
  // 窄窗无视记住的选择
  assert.deepEqual(resolveSidebarState({ wide: false, saved: "full", overlayOpen: false }), { narrow: true, rail: true, overlayOpen: false });
  assert.deepEqual(resolveSidebarState({ wide: false, saved: "rail", overlayOpen: true }), { narrow: true, rail: false, overlayOpen: true });
});

test("isToggleShortcut：⌘\\ / Ctrl+\\，带 Alt / Shift 或没有修饰键都不算", () => {
  assert.equal(isToggleShortcut({ metaKey: true, key: "\\" }), true);
  assert.equal(isToggleShortcut({ ctrlKey: true, key: "\\" }), true);
  assert.equal(isToggleShortcut({ metaKey: true, key: "、", code: "Backslash" }), true, "中文输入法下 key 不是反斜杠，按 code 认");
  assert.equal(isToggleShortcut({ key: "\\" }), false);
  assert.equal(isToggleShortcut({ metaKey: true, shiftKey: true, key: "\\" }), false);
  assert.equal(isToggleShortcut({ metaKey: true, key: "k" }), false);
});

test("tipText：条目名 + 实时内容；没有内容只写名字", () => {
  assert.equal(tipText("通道", "已连接"), "通道 · 已连接");
  assert.equal(tipText("事件", " 2 "), "事件 · 2");
  assert.equal(tipText("事件", ""), "事件");
  assert.equal(tipText("作业提醒", null), "作业提醒");
});

test("tipPosition：条目右侧 10px、垂直居中", () => {
  assert.deepEqual(tipPosition({ right: 64, top: 100, height: 32 }), { left: 74, top: 103 });
});

function setup({ wide = true, saved = null, reduced = false } = {}) {
  const html = fakeElement({ tag: "html" });
  const main = fakeElement({ tag: "main" });
  let left = 232;
  main.getBoundingClientRect = () => ({ left });
  main.animate = spy();
  const label = fakeElement({ tag: "span" });
  const kbd = fakeElement({ tag: "span" });
  const toggleBtn = fakeElement({ tag: "button" });
  toggleBtn.querySelector = (sel) => (sel === ".sidebar-label" ? label : sel === ".sidebar-kbd" ? kbd : null);
  const elements = {
    sidebar: fakeElement({ tag: "aside" }),
    sidebarToggle: toggleBtn,
    sidebarScrim: fakeElement(),
    cmdPaletteBtn: fakeElement({ tag: "button" }),
    pageTitle: fakeElement({ tag: "h1" }),
    pageCrumb: fakeElement({ tag: "span" }),
    pagebar: fakeElement(),
  };
  const doc = fakeDocument(elements, { "main.console": [main] });
  doc.documentElement = html;
  doc.hidden = false;
  const listeners = {};
  const wideQuery = { matches: wide, addEventListener: (_t, fn) => { wideQuery.onchange = fn; } };
  const win = {
    scrollY: 0,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
  };
  const store = new Map(saved ? [[SIDEBAR_STORAGE_KEY, saved]] : []);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const matchMedia = (q) => (q.includes("reduced-motion") ? { matches: reduced } : wideQuery);
  const sidebar = createSidebar({ doc, win, storage, matchMedia, modKey: "Ctrl+", setTimer: () => 0, clearTimer: () => {} });
  sidebar.init();
  const setLeft = (v) => { left = v; };
  return { html, main, label, kbd, elements, doc, win, listeners, wideQuery, store, sidebar, setLeft };
}

test("推挤模式：收起 / 展开写本机并更新按钮；内容区位移走一次 FLIP 补间", () => {
  const ctx = setup();
  assert.equal(ctx.html.classList.contains("sidebar-rail"), false);
  assert.equal(ctx.elements.sidebarToggle.getAttribute("aria-expanded"), "true");
  assert.equal(ctx.kbd.textContent, "Ctrl+\\", "快捷键文字按平台");
  assert.equal(ctx.elements.cmdPaletteBtn.dataset.kbd, "Ctrl+K");

  // 收起：改类之后内容区左缘从 232 变 64 → 从 +168px 补间回 0
  const realToggle = ctx.html.classList.toggle;
  ctx.html.classList.toggle = (c, force) => {
    const on = realToggle(c, force);
    if (c === "sidebar-rail") ctx.setLeft(on ? 64 : 232);
    return on;
  };
  ctx.sidebar.toggle();
  assert.equal(ctx.html.classList.contains("sidebar-rail"), true);
  assert.equal(ctx.store.get(SIDEBAR_STORAGE_KEY), "rail");
  assert.equal(ctx.elements.sidebarToggle.getAttribute("aria-expanded"), "false");
  assert.equal(ctx.label.textContent, "展开侧栏");
  assert.equal(ctx.main.animate.calls.length, 1);
  assert.deepEqual(ctx.main.animate.calls[0][0], [{ transform: "translateX(168px)" }, { transform: "translateX(0)" }]);

  ctx.sidebar.toggle();
  assert.equal(ctx.html.classList.contains("sidebar-rail"), false);
  assert.equal(ctx.store.get(SIDEBAR_STORAGE_KEY), "full");
  assert.deepEqual(ctx.main.animate.calls[1][0][0], { transform: "translateX(-168px)" });
});

test("推挤模式：记住的细栏在启动时恢复；减弱动画时不补间", () => {
  const ctx = setup({ saved: "rail", reduced: true });
  assert.equal(ctx.html.classList.contains("sidebar-rail"), true);
  ctx.sidebar.toggle();
  assert.equal(ctx.main.animate.calls.length, 0);
});

test("浮层模式：固定细栏；展开浮在上方，点遮罩 / Esc / 选条目收回；不改记住的选择", async () => {
  const ctx = setup({ wide: false, saved: "full" });
  assert.equal(ctx.html.classList.contains("sidebar-narrow"), true);
  assert.equal(ctx.html.classList.contains("sidebar-rail"), true);

  ctx.sidebar.toggle();
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), true);
  assert.equal(ctx.html.classList.contains("sidebar-rail"), false);
  assert.equal(ctx.store.get(SIDEBAR_STORAGE_KEY), "full", "浮层开合不写本机");
  assert.equal(ctx.main.animate.calls.length, 0, "浮层模式不动内容区");

  await ctx.elements.sidebarScrim.dispatch("click");
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), false);

  ctx.sidebar.toggle();
  ctx.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), false);
  assert.equal(ctx.elements.sidebarToggle.focused, true, "Esc 收回后焦点回到收起按钮");

  ctx.sidebar.toggle();
  const tab = fakeElement({ tag: "button" });
  tab.closest = (sel) => (sel.includes(".view-tab") ? tab : null);
  await ctx.elements.sidebar.dispatch("click", { target: tab });
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), false);
});

test("窗口从窄变宽：浮层自动收起，回到记住的形态", () => {
  const ctx = setup({ wide: false, saved: "rail" });
  ctx.sidebar.toggle();
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), true);
  ctx.wideQuery.matches = true;
  ctx.wideQuery.onchange();
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), false);
  assert.equal(ctx.html.classList.contains("sidebar-narrow"), false);
  assert.equal(ctx.html.classList.contains("sidebar-rail"), true);
});

test("⌘\\ 快捷键切换并阻止默认行为", () => {
  const ctx = setup();
  const e = { metaKey: true, key: "\\", defaultPrevented: false, preventDefault() { e.defaultPrevented = true; } };
  ctx.listeners.keydown(e);
  assert.equal(e.defaultPrevented, true);
  assert.equal(ctx.html.classList.contains("sidebar-rail"), true);
});

test("页名跟视图；服务器页的当前服务器写进 crumb；滚动后页头条出底边", () => {
  const ctx = setup();
  ctx.sidebar.setView("usage");
  assert.equal(ctx.elements.pageTitle.textContent, PAGE_TITLES.usage);
  assert.equal(ctx.elements.pagebar.dataset.view, "usage");
  ctx.sidebar.setCrumb("主集群");
  assert.equal(ctx.elements.pageCrumb.textContent, "主集群");

  assert.equal(ctx.elements.pagebar.classList.contains("is-scrolled"), false);
  ctx.win.scrollY = 120;
  ctx.listeners.scroll();
  assert.equal(ctx.elements.pagebar.classList.contains("is-scrolled"), true);
});

test("sidebar-boot.js（首帧前的经典脚本）与 sidebar.js 用同一个存储键与断点", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../sidebar-boot.js", import.meta.url), "utf8");
  assert.ok(src.includes(`"${SIDEBAR_STORAGE_KEY}"`), "存储键一致");
  assert.ok(src.includes(`"${WIDE_QUERY}"`), "断点一致");
  // 首帧视图与骨架占位（perf）：视图存储键、可恢复的视图、骨架宿主与默认高度都与正式模块一致
  const { VIEW_STORAGE_KEY, VIEWS } = await import("./view-tabs.js");
  const { SKELETON_HEIGHTS_KEY, SKELETON_PANELS } = await import("./skeleton.js");
  assert.ok(src.includes(`"${VIEW_STORAGE_KEY}"`), "视图存储键一致");
  for (const view of VIEWS.filter((v) => v !== "overview")) assert.ok(src.includes(`view === "${view}"`), `首帧可恢复 ${view}`);
  assert.ok(src.includes(`"${SKELETON_HEIGHTS_KEY}"`), "骨架高度存储键一致");
  for (const panel of SKELETON_PANELS.filter((p) => !p.bare || p.id.startsWith("usage"))) {
    assert.ok(src.includes(`["${panel.id}", "${panel.host}", ${panel.height}]`), `骨架占位 ${panel.id} 与 skeleton.js 一致`);
  }
  const html = await readFile(new URL("../../../index.html", import.meta.url), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  assert.match(head, /<script src="\/assets\/js\/sidebar-boot\.js"><\/script>/, "在 <head> 里同步加载（不是 module / defer）");
  // 首帧留出「团队管理」入口（perf：免得状态回来后侧栏下半截被挤下去）：键名与 app.js 一致，shell.css 有对应规则
  const appSrc = await readFile(new URL("../../../app.js", import.meta.url), "utf8");
  const key = appSrc.match(/const TEAM_ADMIN_FLAG_KEY = "([^"]+)"/)?.[1];
  assert.ok(key, "app.js 定义了 TEAM_ADMIN_FLAG_KEY");
  assert.ok(src.includes(`getItem("${key}")`), "团队管理员标记键一致");
  const shell = await readFile(new URL("../../css/shell.css", import.meta.url), "utf8");
  assert.match(shell, /html\[data-team-admin\] #tab-team\[hidden\]/, "shell.css 按标记显示团队管理入口");
  // 团队页头的批量按钮同理首帧占位（perf：免得概览到了才插进页头把整页挤下一行）
  const teamSrc = await readFile(new URL("./team-admin-controller.js", import.meta.url), "utf8");
  const extrasKey = teamSrc.match(/export const TEAM_HEAD_EXTRAS_KEY = "([^"]+)"/)?.[1];
  assert.ok(extrasKey, "team-admin-controller.js 定义了 TEAM_HEAD_EXTRAS_KEY");
  assert.ok(src.includes(`getItem("${extrasKey}")`), "页头批量按钮记忆键一致");
});

test("Esc：命令面板或浮层开着时只关它们，不连带收起侧栏", () => {
  const ctx = setup({ wide: false });
  ctx.sidebar.toggle();
  ctx.doc.querySelector = (sel) => (sel === "dialog[open]" ? {} : null);
  ctx.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ctx.html.classList.contains("sidebar-overlay-open"), true);
});
