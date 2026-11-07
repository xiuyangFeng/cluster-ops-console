// app/skeleton.js —— 加载骨架：首次加载与切换查看的服务器时，面板先显示内容轮廓，不出空白、不转圈。
//
// 规则（设计稿 §6）：
//   - 数据 150ms 内到 → 不出骨架；出了 → 至少停 300ms；退场 180ms 与内容交叉淡化，然后交给入场动效（onReveal）。
//   - 零版面跳动：骨架高度 = 这块上次的真实高度（存本机），首次用登记的默认值。
//   - 各块独立就绪：每块登记一个「就绪」判断（只看 DOM 事实：渲染器把占位换成真内容即就绪），
//     宿主子树一有变化就重判（MutationObserver），谁先到谁先显示；不需要各控制器回调。
//   - hold(ids) / release(ids)：切换查看的服务器时，受影响的面板回到骨架直到新数据渲染完（不再用全屏遮罩）。
//   - 12 秒仍没就绪且这块正被看着 → 先撤掉骨架露出真实内容（各块自己的空状态 / 错误态接手）。
//   - 定时刷新不出骨架：骨架只在 attach / hold 时出现，刷新时内容原地更新。
// 光带与形状样式在 styles.css「加载骨架」；依赖全部可注入，Node 可测。

export const SKELETON_SHOW_AFTER_MS = 150;
export const SKELETON_MIN_SHOW_MS = 300;
export const SKELETON_FADE_MS = 180;
export const SKELETON_TIMEOUT_MS = 12000;
export const SKELETON_HEIGHTS_KEY = "consoleSkeletonHeights";

// ---- 形状：只有静态结构，不含任何数据（安全地 innerHTML） ----
const line = (w, cls = "") => `<i class="sk sk-line${cls ? ` ${cls}` : ""}" style="width:${w}"></i>`;
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join("");
const card = (inner, extra = "") => `<div class="sk-card"${extra}>${inner}</div>`;

export const SKELETON_SHAPES = Object.freeze({
  agents: () => '<div class="sk-row sk-end"><i class="sk sk-pill" style="width:150px"></i><i class="sk sk-pill" style="width:200px"></i></div>',
  chain: () => {
    const node = (w) => `<div class="sk-node"><i class="sk sk-orb"></i>${line("40px", "is-lg")}${line(w, "is-dim")}</div>`;
    const link = '<i class="sk sk-link"></i>';
    // 请求之路（v2.65）：三节点一行 + 四张去向卡，下面是隧道稳定性
    return `<div class="sk-row sk-chain">${node("64px")}${link}${link}${node("70px")}${link}${node("48px")}</div>`
      + `<div class="sk-grid sk-cols-4 sk-dests">${repeat(4, () => card(`${line("60px")}${line("80%", "is-dim")}`))}</div>`
      + `<div class="sk-foot"><div class="sk-row">${line("90px", "is-lg")}<i class="sk sk-seg"></i></div>`
      + `${repeat(2, () => `<div class="sk-row">${line("44px")}<i class="sk sk-bar"></i>${line("96px")}</div>`)}</div>`;
  },
  brief: () => `${line("92%", "is-lg")}${line("64%", "is-lg")}`
    + `<div class="sk-grid sk-cols-2">${repeat(4, () => card(`${line("70px")}<i class="sk sk-num"></i>${line("80%", "is-dim")}`))}</div>`
    + `${line("64px")}${repeat(3, (i) => `<div class="sk-row"><i class="sk sk-dot"></i>${line(["70%", "62%", "78%"][i])}<span class="sk-grow"></span>${line("60px", "is-dim")}</div>`)}`,
  row: () => `<div class="sk-row">${line("30%")}<span class="sk-grow"></span>${line("80px", "is-dim")}</div>`,
  serverBriefs: () => `<div class="sk-grid sk-cols-2">${repeat(2, () => card(`<div class="sk-row">${line("40%", "is-lg")}<span class="sk-grow"></span>${line("40px")}</div>`
    + `<div class="sk-row">${repeat(3, () => `<div class="sk-stack">${line("50%", "is-dim")}${line("40%", "is-lg")}</div>`)}</div>`))}</div>`,
  resources: () => `<div class="sk-grid sk-cols-3">${repeat(3, () => card(`<div class="sk-row sk-top"><div class="sk-stack">${line("40px")}<i class="sk sk-num is-xl"></i></div><i class="sk sk-spark"></i></div>${line("70%", "is-dim")}${line("50%", "is-dim")}`, ' style="height:150px"'))}</div>`
    + `<div class="sk-row">${line("50px", "is-lg")}${line("90px", "is-dim")}</div>`
    + card(repeat(4, () => `<div class="sk-row">${line("72px")}${line("18px", "is-dim")}<i class="sk sk-bar"></i><i class="sk sk-bar"></i><i class="sk sk-bar"></i>${line("80px", "is-dim")}</div>`)),
  cluster: () => `<div class="sk-grid sk-cols-5">${repeat(5, () => card(`${line("60%")}<i class="sk sk-num"></i>${line("80%", "is-dim")}`))}</div>`
    + `${line("60px", "is-lg")}`
    + `<div class="sk-grid sk-cols-3">${repeat(6, () => card(`<div class="sk-row">${line("50px", "is-lg")}<span class="sk-grow"></span><i class="sk sk-ring"></i></div>${line("70%", "is-dim")}${line("60%", "is-dim")}`, ' style="height:140px"'))}</div>`
    + `${line("80px", "is-lg")}${repeat(7, () => `<div class="sk-row sk-tr">${line("26%")}${line("10%")}${line("8%")}${line("14%")}${line("12%")}<span class="sk-grow"></span>${line("10%", "is-dim")}</div>`)}`,
  incidents: () => repeat(3, () => card(`<div class="sk-row"><i class="sk sk-stripe"></i><div class="sk-stack sk-grow">${line("46%", "is-lg")}${line("72%", "is-dim")}</div>${line("70px", "is-dim")}</div>`)),
  usageMetrics: () => `<div class="sk-grid sk-cols-4">${repeat(4, () => card(`${line("50%")}<i class="sk sk-num is-xl"></i>${line("70%", "is-dim")}`, ' style="background:var(--panel)"'))}</div>`,
  chart: () => `<div class="sk-plot">${repeat(4, (i) => `<i class="sk sk-gridline" style="top:${i * 28}%"></i>`)}`
    + '<svg class="sk-curve" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true"><path d="M0 100 C40 96 60 70 100 74 S160 40 200 52 S260 90 300 60 S360 30 400 36"/></svg></div>'
    + `<div class="sk-row">${line("30%", "is-dim")}<span class="sk-grow"></span>${line("24%", "is-dim")}</div>`,
  calendar: () => `${line("50%")}<div class="sk-grid sk-cols-7">${repeat(35, (i) => `<i class="sk sk-cell" style="opacity:${(0.5 + ((i * 37) % 50) / 100).toFixed(2)}"></i>`)}</div>`,
  strip: () => `<div class="sk-row">${repeat(4, () => card(`${line("60%")}${line("40%", "is-dim")}`, ' style="flex:1"'))}</div>`,
  table: () => `<div class="sk-row">${line("220px")}<span class="sk-grow"></span>${line("160px", "is-dim")}</div>`
    + repeat(8, () => `<div class="sk-row sk-tr">${line("12%")}${line("20%")}${line("16%")}<span class="sk-grow"></span>${line("8%")}${line("10%")}${line("12%", "is-dim")}</div>`),
});

// ---- 登记：宿主、形状、默认高度、就绪判断（只读 DOM 事实）；watch = 就绪判断依赖的元素不在宿主里时，改为盯这个祖先 ----
const text = (doc, id) => (doc.getElementById(id)?.textContent || "").trim();
const hasChildren = (doc, id) => (doc.getElementById(id)?.childElementCount || 0) > 0;
const usageReady = (doc) => text(doc, "usageTotal") !== "—" || doc.getElementById("usageEmptyState")?.hidden === false;

export const SKELETON_PANELS = Object.freeze([
  // Agent 全部关闭时整条胶囊带隐藏（render/overview.js）：也算就绪
  { id: "agents", host: ".pagebar-agents", shape: "agents", height: 32, bare: true,
    ready: (doc) => hasChildren(doc, "agentOverviewGrid") || doc.querySelector(".pagebar-agents")?.hidden === true },
  { id: "chain", host: "#chainPanel", shape: "chain", height: 485, ready: (doc) => hasChildren(doc, "chainTrack") },
  { id: "brief", host: "#briefPanel", shape: "brief", height: 485, ready: (doc) => !doc.getElementById("briefBody")?.querySelector(".bf-loading") },
  { id: "overviewEvents", host: "#overviewEventsPanel", shape: "row", height: 52, ready: (doc) => text(doc, "overviewIncidentBadge") !== "-" },
  { id: "serverBriefs", host: "#serverBriefsPanel", shape: "serverBriefs", height: 170, ready: (doc) => hasChildren(doc, "serverBriefsContainer") },
  { id: "resources", host: "#resourcesPanel", shape: "resources", height: 620, ready: (doc) => text(doc, "hostBadge") !== "-" },
  // 远端守护进程：要等一次 SSH 才有内容；先按上次的高度占位，免得结果回来时把下面的集群面板整块往下推。
  { id: "daemons", host: "#daemonsPanel", shape: "row", height: 180,
    ready: (doc) => Boolean(doc.getElementById("daemonsBody")?.firstElementChild) && !text(doc, "daemonsBody").includes("正在检查远端守护进程") },
  { id: "cluster", host: "#clusterPanel", shape: "cluster", height: 1100,
    ready: (doc) => hasChildren(doc, "clusterKpis") || doc.getElementById("clusterError")?.hidden === false },
  // 初始占位带 data-skeleton-wait（index.html）；渲染器第一次写列表就把它换掉
  { id: "incidents", host: "#incidentsPanel", shape: "incidents", height: 360, ready: (doc) => !doc.getElementById("incidentList")?.querySelector("[data-skeleton-wait]") },
  { id: "usageMetrics", host: ".us-metrics", shape: "usageMetrics", height: 112, bare: true, ready: usageReady, watch: "#view-usage" },
  { id: "usageTrend", host: ".us-trend", shape: "chart", height: 360, ready: usageReady, watch: "#view-usage" },
  { id: "usageCalendar", host: ".us-calendar", shape: "calendar", height: 360, ready: usageReady, watch: "#view-usage" },
  { id: "usageProjects", host: ".us-projects", shape: "strip", height: 120, ready: usageReady, watch: "#view-usage" },
  { id: "usageSessions", host: "#usageSessionsPanel", shape: "table", height: 460, ready: usageReady, watch: "#view-usage" },
]);

const isShown = (el) => typeof el.getClientRects === "function" && el.getClientRects().length > 0;

// 并发的等待共用一次 hold（连点两台服务器：先发的那次即使被丢弃，也不能提前撤掉骨架）：
// 每次 begin 计一次，最后一个 end 才 release；onBusy(true / false) 在第一次进入 / 最后一次退出时回调。
export function createHoldGroup(skeletons, ids, { onBusy = () => {} } = {}) {
  let depth = 0;
  return {
    begin() {
      depth += 1;
      if (depth === 1) onBusy(true);
      skeletons.hold(ids);
    },
    end() {
      if (depth === 0) return;
      depth -= 1;
      if (depth > 0) return;
      onBusy(false);
      skeletons.release(ids);
    },
    depth: () => depth,
  };
}

export function createSkeletons({
  doc,
  storage = typeof localStorage !== "undefined" ? localStorage : null,
  panels = SKELETON_PANELS,
  shapes = SKELETON_SHAPES,
  now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  observe = (target, fn) => {
    if (typeof MutationObserver === "undefined") return () => {};
    const mo = new MutationObserver(fn);
    mo.observe(target, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden"] });
    return () => mo.disconnect();
  },
  onReveal = () => {},
}) {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const active = new Map(); // id → { host, el, held, shownAt, timers, stop }
  let heights = readHeights();

  function readHeights() {
    try {
      return JSON.parse(storage?.getItem(SKELETON_HEIGHTS_KEY) || "{}") || {};
    } catch {
      return {};
    }
  }

  // 记忆高度同时写成宿主的 --ph（shell.css 里 content-visibility 的占位高度）：第一次显示时不按 600px 默认值闪一帧。
  function applyPlaceholder(panel, px) {
    const host = typeof doc.querySelector === "function" ? doc.querySelector(panel.host) : null;
    if (px > 40) host?.style?.setProperty?.("--ph", `${Math.round(px)}px`);
  }
  for (const p of panels) applyPlaceholder(p, heights[p.id]);

  function rememberHeight(id, px) {
    if (!(px > 40)) return; // 隐藏视图里量出来是 0：不记
    const rounded = Math.round(px);
    if (heights[id] === rounded) return;
    if (byId.has(id)) applyPlaceholder(byId.get(id), rounded);
    heights = { ...heights, [id]: rounded };
    try {
      storage?.setItem(SKELETON_HEIGHTS_KEY, JSON.stringify(heights));
    } catch {}
  }

  const isReady = (panel) => {
    try {
      return Boolean(panel.ready(doc));
    } catch {
      return true; // 判断本身出错：宁可露出内容，也不让骨架卡住
    }
  };

  function attach(id, { held = false, headerHeight } = {}) {
    const panel = byId.get(id);
    if (!panel || active.has(id)) return false;
    const host = doc.querySelector(panel.host);
    if (!host) return false;
    if (!held && isReady(panel)) return false;

    const el = doc.createElement("div");
    el.className = `skeleton is-pending${panel.bare ? " is-bare" : ""}`;
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = shapes[panel.shape]();
    let topPx = headerHeight;
    if (topPx === undefined) {
      const header = host.querySelector(":scope > .panel-header");
      topPx = header ? (header.offsetHeight || 50) : 0;
    }
    el.style.top = `${topPx}px`;
    host.dataset.skeleton = "loading";
    host.setAttribute("aria-busy", "true");
    host.style.minHeight = `${heights[id] || panel.height}px`;
    if (panel.width) host.style.minWidth = `${panel.width}px`;
    host.append(el);

    const entry = { id, panel, host, el, held, shownAt: 0, showTimer: 0, timeoutTimer: 0 };
    entry.showTimer = setTimer(() => {
      entry.showTimer = 0;
      if (isShown(host)) entry.shownAt = now();
      el.classList.remove("is-pending");
    }, SKELETON_SHOW_AFTER_MS);
    entry.stop = held ? () => {} : observe((panel.watch && doc.querySelector(panel.watch)) || host, () => {
      if (!entry.held && isReady(panel)) finish(entry);
    });
    armTimeout(entry);
    active.set(id, entry);
    return true;
  }

  // 超时只在这块正被看着时生效：没进过的视图（如用量页只在可见时才拉数据）骨架原地等着。
  // 面板本身被隐藏（界面面板显隐、没有 Slurm 的集群面板）就不必再等：直接撤掉，不留空转的计时器。
  // 每块同时只挂一个超时计时器（到点没撤就换一个新的，不累积）。
  function armTimeout(entry) {
    entry.timeoutTimer = setTimer(() => {
      entry.timeoutTimer = 0;
      if (!active.has(entry.id)) return;
      if (entry.host.hidden || isShown(entry.host)) finish(entry);
      else armTimeout(entry);
    }, SKELETON_TIMEOUT_MS);
  }

  function finish(entry) {
    if (entry.finishing) return;
    entry.finishing = true;
    entry.stop();
    clearTimer(entry.showTimer);
    clearTimer(entry.timeoutTimer);
    const wait = entry.shownAt ? Math.max(0, SKELETON_MIN_SHOW_MS - (now() - entry.shownAt)) : 0;
    if (wait > 0) setTimer(() => reveal(entry), wait);
    else reveal(entry);
  }

  // 淡入结束后收尾：同一时刻撤掉的几块共用一个定时器，先统一去掉 revealing 标记、再统一量高度（一次重排，不是每块一次）。
  let settleBatch = null;
  function settleLater(entry) {
    if (!settleBatch || now() - settleBatch.at > 16) {
      const batch = { at: now(), list: [] };
      settleBatch = batch;
      setTimer(() => {
        if (settleBatch === batch) settleBatch = null;
        for (const { host } of batch.list) if (host.dataset.skeleton === "revealing") delete host.dataset.skeleton;
        for (const { id, host } of batch.list) rememberHeight(id, host.offsetHeight);
      }, 240);
    }
    settleBatch.list.push(entry);
  }

  function reveal(entry) {
    const { id, host, el } = entry;
    active.delete(id);
    const wasShown = Boolean(entry.shownAt);
    host.dataset.skeleton = "revealing"; // 内容 220ms 淡入（styles.css）
    host.removeAttribute("aria-busy");
    host.style.minHeight = "";
    host.style.minWidth = "";
    if (wasShown) {
      el.classList.add("is-leaving");
      setTimer(() => el.remove(), SKELETON_FADE_MS + 20);
    } else el.remove();
    settleLater(entry);
    onReveal(host, { id, wasShown });
    // 正在退场（至少停 300ms 的那段）时又来了一次切换：退场完立刻再上骨架，这次切换不落空
    if (entry.rehold) attach(id, { held: true });
  }

  return {
    // 启动时：所有登记的面板先上骨架（已就绪的跳过）。先批量读取面板头高度再统一写 DOM，避免逐面板强制重排。
    attachAll() {
      const headerHeights = new Map();
      for (const p of panels) {
        if (active.has(p.id)) continue;
        const host = doc.querySelector(p.host);
        if (!host) continue;
        const header = host.querySelector(":scope > .panel-header");
        headerHeights.set(p.id, header ? (header.offsetHeight || 50) : 0);
      }
      for (const p of panels) attach(p.id, { headerHeight: headerHeights.get(p.id) });
      // 首帧前 sidebar-boot.js 先按同样的高度占了位；骨架挂上（行内 min-height）之后撤掉，就绪的面板回到自然高度。
      doc.getElementById?.("bootSkeletonHeights")?.remove();
    },
    attach,
    // 切换查看的服务器：这几块回到骨架，直到 release（新状态渲染完）
    hold(ids) {
      for (const id of ids) {
        const entry = active.get(id);
        if (entry?.finishing) entry.rehold = true;
        else if (entry) entry.held = true;
        else attach(id, { held: true });
      }
    },
    release(ids) {
      for (const id of ids) {
        const entry = active.get(id);
        if (!entry) continue;
        entry.held = false;
        entry.rehold = false;
        finish(entry);
      }
    },
    isLoading: (id) => active.has(id),
    // 记下当前看得见、已就绪的面板的真实高度（下次启动首帧 / 骨架照这个占位）。骨架只在 reveal 时记一次，
    // 而数据在视图还藏着时就到了的面板（如事件列表）reveal 时量出来是 0、记不下：进入视图后与离开页面时补记。
    rememberShown() {
      const measured = [];
      for (const p of panels) {
        if (active.has(p.id)) continue;
        const host = doc.querySelector(p.host);
        if (host && !host.hidden && isShown(host)) measured.push([p.id, host.offsetHeight]);
      }
      for (const [id, px] of measured) rememberHeight(id, px);
    },
  };
}
