// app/sidebar.js —— 侧边栏：展开 / 细栏 / 窄窗浮层、细栏悬停提示、⌘\ 快捷键，以及页头条（页名、
// 服务器页的当前服务器、滚动后的底边）。视图切换本身在 app/view-tabs.js，这里只跟着改页名。
//
// 三种形态（状态写在 <html> 的类上，宽度与文字淡入淡出全在 shell.css）：
//   推挤模式（窗口 ≥1180）：展开 232px / 细栏 64px，用户的选择存本机；
//   浮层模式（窗口 <1180）：版面固定按细栏排，展开时侧栏浮在内容上 + 遮罩，选了条目 / 点遮罩 / Esc 收回。
// 「不笨拙」靠三点：图标 x 坐标两种宽度下不变（CSS）；分组标题行高不变（CSS）；推挤模式下内容区只回流
// 一次，位移用 transform 补间（FLIP，与侧栏宽度同曲线同时长），图表的 ResizeObserver 只触发一次。
// 依赖全部可注入（doc / win / storage / matchMedia），Node 可测。

export const SIDEBAR_STORAGE_KEY = "consoleSidebar";
export const WIDE_QUERY = "(min-width: 1180px)";
export const PAGE_TITLES = Object.freeze({ overview: "概览", servers: "服务器", events: "事件", usage: "用量", team: "团队管理", storage: "存储管理" });
export const SIDEBAR_ANIM_MS = 240;
const SIDEBAR_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
export const TIP_DELAY_MS = 350;
const TIP_WARM_MS = 400; // 提示刚收起的这段时间里移到别的条目，立即出提示（不再等 350ms）

// 纯函数：窗口宽窄 + 记住的选择 + 浮层开合 → 侧栏形态。
export function resolveSidebarState({ wide, saved, overlayOpen }) {
  if (!wide) return { narrow: true, rail: !overlayOpen, overlayOpen: Boolean(overlayOpen) };
  return { narrow: false, rail: saved === "rail", overlayOpen: false };
}

// ⌘\（Windows / Linux：Ctrl+\）。按 code 兜底：部分键盘布局下 key 不是反斜杠。
export function isToggleShortcut(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.key === "\\" || e.code === "Backslash";
}

// 细栏提示的文字：条目名 + 实时内容（data-tip-live 指向的元素，如通道状态文案、事件数），没有内容就只写名字。
export function tipText(label, live) {
  const extra = String(live ?? "").trim();
  return extra ? `${label} · ${extra}` : label;
}

// 细栏提示的位置：条目右侧 10px、垂直居中（提示高约 26px）。
export function tipPosition(rect) {
  return { left: Math.round(rect.right + 10), top: Math.round(rect.top + rect.height / 2 - 13) };
}

export function createSidebar({
  doc,
  win = typeof window !== "undefined" ? window : null,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  matchMedia = win && typeof win.matchMedia === "function" ? (q) => win.matchMedia(q) : null,
  modKey = "⌘",
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  const root = doc.documentElement;
  const getEl = (id) => doc.getElementById(id);
  let saved = readSaved();
  let overlayOpen = false;
  let wideQuery = null;
  let view = "overview";
  let tipEl = null;
  let tipTimer = 0;
  let tipWarm = false;
  let tipWarmTimer = 0;
  let scrollFrame = 0;
  let pagebarEl = null;
  let lastScrolled = null;

  function readSaved() {
    try {
      return storage?.getItem(SIDEBAR_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  }

  function writeSaved(value) {
    try {
      storage?.setItem(SIDEBAR_STORAGE_KEY, value);
    } catch {}
  }

  const isWide = () => (wideQuery ? wideQuery.matches : true);
  const state = () => resolveSidebarState({ wide: isWide(), saved, overlayOpen });
  const reducedMotion = () => Boolean(matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);

  function apply() {
    const s = state();
    root.classList.toggle("sidebar-narrow", s.narrow);
    root.classList.toggle("sidebar-rail", s.rail);
    root.classList.toggle("sidebar-overlay-open", s.overlayOpen);
    const toggle = getEl("sidebarToggle");
    if (toggle) {
      const label = s.rail ? "展开侧栏" : "收起侧栏";
      toggle.setAttribute("aria-expanded", String(!s.rail));
      toggle.dataset.tip = label;
      const text = toggle.querySelector?.(".sidebar-label");
      if (text) text.textContent = label;
    }
    if (!s.rail) hideTip();
    return s;
  }

  // 推挤模式下的收起 / 展开：先量内容区左缘，改类（版面只回流这一次），再把位移用 transform 补回去。
  function setCollapsed(next) {
    const main = doc.querySelector("main.console");
    const before = main?.getBoundingClientRect?.().left;
    saved = next ? "rail" : "full";
    writeSaved(saved);
    apply();
    if (!main || typeof main.animate !== "function" || reducedMotion() || doc.hidden) return;
    const dx = before - main.getBoundingClientRect().left;
    if (Math.abs(dx) > 1) {
      // 补间期间内容区右缘会伸出窗口：只在这 240ms 里裁掉横向溢出（shell.css html.sidebar-animating）
      root.classList.add("sidebar-animating");
      const anim = main.animate([{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }], { duration: SIDEBAR_ANIM_MS, easing: SIDEBAR_EASE });
      const done = () => root.classList.remove("sidebar-animating");
      if (anim?.finished) anim.finished.then(done, done);
      else done();
    }
  }

  function setOverlay(open) {
    if (isWide()) return;
    overlayOpen = Boolean(open);
    apply();
  }

  function toggle() {
    if (!isWide()) setOverlay(!overlayOpen);
    else setCollapsed(saved !== "rail");
  }

  const isRail = () => state().rail;

  // ---- 页头条 ----
  function setView(next) {
    view = next;
    const title = getEl("pageTitle");
    if (title) title.textContent = PAGE_TITLES[next] || "";
    const bar = getEl("pagebar");
    if (bar) bar.dataset.view = next;
  }

  // 服务器页标题旁的「查看中的服务器」（其它页 CSS 自动隐藏）。
  function setCrumb(text) {
    const crumb = getEl("pageCrumb");
    if (crumb && crumb.textContent !== text) crumb.textContent = text || "";
  }

  function syncScrolled() {
    scrollFrame = 0;
    const next = (win?.scrollY || 0) > 4;
    if (next === lastScrolled) return;
    lastScrolled = next;
    pagebarEl = pagebarEl || getEl("pagebar");
    pagebarEl?.classList.toggle("is-scrolled", next);
  }

  // ---- 细栏悬停提示：一个浮动元素复用 ----
  function showTip(target) {
    if (!isRail() || !target?.getBoundingClientRect) return;
    if (!tipEl) {
      tipEl = doc.createElement("div");
      tipEl.className = "sidebar-tip";
      tipEl.setAttribute("role", "tooltip");
      doc.body.append(tipEl);
    }
    const live = target.dataset.tipLive ? getEl(target.dataset.tipLive) : null;
    tipEl.textContent = tipText(target.dataset.tip || "", live && !live.hidden ? live.textContent : "");
    if (target.dataset.kbd) {
      const kbd = doc.createElement("kbd");
      kbd.textContent = target.dataset.kbd;
      tipEl.append(kbd);
    }
    const pos = tipPosition(target.getBoundingClientRect());
    tipEl.style.left = `${pos.left}px`;
    tipEl.style.top = `${pos.top}px`;
    tipEl.classList.add("is-on");
    clearTimer(tipWarmTimer);
    tipWarm = false;
  }

  function hideTip() {
    clearTimer(tipTimer);
    if (!tipEl?.classList.contains("is-on")) return;
    tipEl.classList.remove("is-on");
    tipWarm = true;
    clearTimer(tipWarmTimer);
    tipWarmTimer = setTimer(() => {
      tipWarm = false;
    }, TIP_WARM_MS);
  }

  function bindTips(sidebar) {
    sidebar.addEventListener("pointerover", (e) => {
      const target = e.target.closest?.("[data-tip]");
      if (!target) return;
      clearTimer(tipTimer);
      if (tipWarm || tipEl?.classList.contains("is-on")) showTip(target);
      else tipTimer = setTimer(() => showTip(target), TIP_DELAY_MS);
    });
    sidebar.addEventListener("pointerout", (e) => {
      const target = e.target.closest?.("[data-tip]");
      if (target && !target.contains?.(e.relatedTarget)) hideTip();
    });
    sidebar.addEventListener("focusin", (e) => {
      const target = e.target.closest?.("[data-tip]");
      if (target) showTip(target);
    });
    sidebar.addEventListener("focusout", hideTip);
  }

  function init() {
    const sidebar = getEl("sidebar");
    if (!sidebar) return;
    wideQuery = matchMedia?.(WIDE_QUERY) || null;
    wideQuery?.addEventListener?.("change", () => {
      if (isWide()) overlayOpen = false;
      apply();
    });
    apply();

    // 快捷键文字按平台显示（非 Apple 键盘是 Ctrl+）。
    const toggleBtn = getEl("sidebarToggle");
    if (toggleBtn) {
      toggleBtn.dataset.kbd = `${modKey}\\`;
      const kbd = toggleBtn.querySelector?.(".sidebar-kbd");
      if (kbd) kbd.textContent = `${modKey}\\`;
      toggleBtn.addEventListener("click", toggle);
    }
    const cmd = getEl("cmdPaletteBtn");
    if (cmd) cmd.dataset.kbd = `${modKey}K`;

    getEl("sidebarScrim")?.addEventListener("click", () => setOverlay(false));
    // 浮层模式：选了视图或打开浮层就收回侧栏。
    sidebar.addEventListener("click", (e) => {
      if (!overlayOpen) return;
      if (e.target.closest?.(".view-tab, [data-dialog], #cmdPaletteBtn, #jobNotificationsBtn")) setOverlay(false);
    });
    win?.addEventListener("keydown", (e) => {
      if (isToggleShortcut(e)) {
        e.preventDefault();
        toggle();
      } else if (e.key === "Escape" && overlayOpen && !e.defaultPrevented && !doc.querySelector?.("dialog[open]")) {
        // 命令面板 / 浮层开着时，Esc 只关它们，不连带收起侧栏
        setOverlay(false);
        toggleBtn?.focus();
      }
    });
    bindTips(sidebar);
    win?.addEventListener("scroll", () => {
      if (((win?.scrollY || 0) > 4) === lastScrolled) return;
      if (!scrollFrame) scrollFrame = win.requestAnimationFrame(syncScrolled);
    }, { passive: true });
    syncScrolled();
  }

  return { init, toggle, setCollapsed, setOverlay, isRail, setView, setCrumb, getView: () => view };
}
