// app/view-tabs.js —— 主视图导航（概览/服务器/事件/用量）；配置从顶部浮层打开。
//
// 只切换 .view.active、hidden 与 aria-selected；视图内的所有既有 ID 保持渲染（render
// 函数不感知视图）。上次停留视图本地持久化；方向键 / Home / End 在标签间循环（A25 键盘可达）。
// 进入某个视图（含启动时恢复）时调 onEnter(view)，由调用方补渲该视图收起期间跳过的内容。
// v2.47：整页可隐藏（app/panels.js → setHiddenViews）：隐藏视图的标签与跳转按钮一起藏、切换与方向键循环跳过它；
// 当前视图被隐藏时回到概览。概览不可隐藏。
export const VIEWS = Object.freeze(["overview", "servers", "events", "usage", "team", "storage"]);
export const VIEW_STORAGE_KEY = "consoleView";

export function createViewTabs({ doc, storage = typeof localStorage !== "undefined" ? localStorage : null }) {
  let onEnter = () => {};
  let hiddenViews = new Set();
  let current = null;
  // 页面共用文档滚动容器；切到短页会把长页的位置截掉，因此在隐藏前按页记录。
  const scrollPositions = new Map();
  const tabList = () => [...doc.querySelectorAll(".view-tab")];
  const visibleTabs = () => tabList().filter((tab) => !hiddenViews.has(tab.dataset.view));
  const usable = (view) => VIEWS.includes(view) && !hiddenViews.has(view);

  function readSaved() {
    try {
      return storage?.getItem(VIEW_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function writeSaved(view) {
    try {
      storage?.setItem(VIEW_STORAGE_KEY, view);
    } catch {}
  }

  let settleTimer = null;

  function applyView(view) {
    current = view;
    // 首帧占位的视图（sidebar-boot.js）交还给 .active / hidden
    if (doc.documentElement?.dataset) delete doc.documentElement.dataset.bootView;
    clearTimeout(settleTimer);
    settleTimer = null;
    const clusterPanel = doc.getElementById("clusterPanel");
    if (clusterPanel?.dataset) delete clusterPanel.dataset.settled;
    if (view === "servers") {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (current === "servers") {
          const panel = doc.getElementById("clusterPanel");
          if (panel?.dataset) panel.dataset.settled = "1";
        }
      }, 1350);
      settleTimer?.unref?.();
    }
    for (const tab of tabList()) {
      const active = tab.dataset.view === view;
      tab.setAttribute("aria-selected", String(active));
      // 读屏的「当前页」标记：role=tab 的 aria-selected 已表达选中，但浏览器 / 读屏的页面导航
      // 习惯还会找 aria-current="page"；两处保持一致，切页时一起搬。
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
      tab.tabIndex = active ? 0 : -1;
      const section = doc.getElementById(`view-${tab.dataset.view}`);
      if (section) {
        section.classList.toggle("active", active);
        section.hidden = !active;
      }
    }
  }

  function switchView(view) {
    if (!usable(view) || view === current) return;
    const scroller = doc.scrollingElement;
    if (scroller && current) scrollPositions.set(current, scroller.scrollTop);
    writeSaved(view);
    applyView(view);
    onEnter(view);
    // 在同步补渲之后、绘制之前恢复；首次进入从顶部开始。跳转到具体作业的调用方仍可随后定位。
    if (scroller) scroller.scrollTop = scrollPositions.get(view) || 0;
  }

  function isViewVisible(view) {
    const section = doc.getElementById(`view-${view}`);
    return Boolean(section && !section.hidden);
  }

  // 整页显隐：views 为要隐藏的视图名（概览忽略）。初始化之前调用也可以——initViewTabs 会据此选初始视图。
  function setHiddenViews(views) {
    hiddenViews = new Set((views || []).filter((view) => view !== "overview" && VIEWS.includes(view)));
    for (const tab of tabList()) tab.hidden = hiddenViews.has(tab.dataset.view);
    for (const btn of doc.querySelectorAll("[data-goto-view]")) btn.hidden = hiddenViews.has(btn.dataset.gotoView);
    if (current && hiddenViews.has(current)) switchView("overview");
  }

  function initViewTabs({ onEnter: enter } = {}) {
    if (typeof enter === "function") onEnter = enter;
    const tabs = tabList();
    if (tabs.length === 0) return;
    const saved = readSaved();
    const initial = usable(saved) ? saved : "overview";
    applyView(initial);
    for (const tab of tabs) {
      tab.addEventListener("click", () => switchView(tab.dataset.view));
      tab.addEventListener("keydown", (e) => {
        // 只在可见的标签之间循环（隐藏的整页跳过）
        const cycle = visibleTabs();
        const idx = cycle.indexOf(tab);
        let next = null;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = cycle[(idx + 1) % cycle.length];
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = cycle[(idx - 1 + cycle.length) % cycle.length];
        else if (e.key === "Home") next = cycle[0];
        else if (e.key === "End") next = cycle[cycle.length - 1];
        if (!next) return;
        e.preventDefault();
        next.focus();
        switchView(next.dataset.view);
      });
    }
    for (const btn of doc.querySelectorAll("[data-goto-view]")) {
      btn.addEventListener("click", () => switchView(btn.dataset.gotoView));
    }
    onEnter(initial);
  }

  return { initViewTabs, switchView, isViewVisible, setHiddenViews };
}
