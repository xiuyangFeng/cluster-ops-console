// app/panels.js —— 界面面板显隐（v2.47）：面板注册表 + 「实际隐藏集合」的计算与应用。
//
// 隐藏集合 = 个人偏好 status.hiddenPanels（个人层 config.local.json，经 POST /api/ui-prefs 写入；
// 不用 localStorage——页面 origin 带端口，端口隔离后会丢）∪ 随监控模块联动的隐藏（用量模块关闭 → 用量页，
// 远端守护进程模块关闭 → 服务器页「远端守护进程」）。
// 「隐藏」不只是 CSS 藏起来：面板加 hidden、渲染管线跳过它的 render（render-pipeline.js 按注册表门控）、
// 带轮询的控制器 leave()，重新显示时 enter() 并立即拉一次；整页隐藏时同时藏标签（view-tabs.js 跳过）。
// 概览整页、数据链路、页头（通道状态 / 注意力队列 / 横幅）不可隐藏：总要有一处能看到通道状态。
//
// 模块在 import 时不碰 DOM（Node 可测），DOM 只经注入的 doc 访问。

// 面板：id 与后端偏好里存的字符串一致；el 是面板根元素的 id。
// selfHidden：渲染层自己也会按数据显隐（没有数据时整块隐藏），重新显示时恢复隐藏前的那个状态，交给下一次渲染校正。
export const PANELS = Object.freeze([
  { id: "overview.chain", view: "overview", label: "数据链路", el: "chainPanel", locked: true },
  { id: "overview.stability", view: "overview", label: "隧道稳定性", el: "chainUptime", selfHidden: true },
  { id: "overview.brief", view: "overview", label: "今日简报", el: "briefPanel" },
  { id: "overview.events", view: "overview", label: "需要处理的事件", el: "overviewEventsPanel" },
  { id: "overview.serverBriefs", view: "overview", label: "服务器简报", el: "serverBriefsPanel" },
  { id: "servers.resources", view: "servers", label: "资源与负载", el: "resourcesPanel" },
  { id: "servers.daemons", view: "servers", label: "远端守护进程", el: "daemonsPanel", selfHidden: true },
  { id: "servers.cluster", view: "servers", label: "集群节点与队列", el: "clusterPanel", selfHidden: true },
  { id: "events.incidents", view: "events", label: "事件列表", el: "incidentsPanel" },
  { id: "events.logstream", view: "events", label: "实时日志流", el: "logStreamPanel" },
].map(Object.freeze));

// 整页：隐藏时连标签一起藏；概览锁定。
export const VIEW_PANELS = Object.freeze([
  { id: "view.overview", view: "overview", label: "概览", locked: true },
  { id: "view.servers", view: "servers", label: "服务器" },
  { id: "view.events", view: "events", label: "事件" },
  { id: "view.usage", view: "usage", label: "用量" },
].map(Object.freeze));

const KNOWN_IDS = new Set([...PANELS, ...VIEW_PANELS].filter((p) => !p.locked).map((p) => p.id));

// 设置页「界面面板」按视图分组：{ view, label, page（整页项）, panels }。
export function panelGroups() {
  return VIEW_PANELS.map((page) => ({ view: page.view, label: page.label, page, panels: PANELS.filter((p) => p.view === page.view) }));
}

// 数据采集模块是否开着（缺省全开：旧后端 / 夹具没有 modules 字段）。
export function moduleEnabled(status, moduleId) {
  return status?.modules?.[moduleId] !== false;
}

// 个人偏好里的隐藏项：只认注册表里可隐藏的 id（锁定项、未知 id 一律忽略，后端会原样保留未知 id）。
export function userHiddenPanels(status) {
  const list = Array.isArray(status?.hiddenPanels) ? status.hiddenPanels : [];
  return [...new Set(list.filter((id) => typeof id === "string" && KNOWN_IDS.has(id)))];
}

// 随监控模块联动的隐藏：用量模块关闭 → 用量页；远端守护进程模块关闭 → 服务器页那块面板（与面板显隐共用同一套机制）。
export function moduleHiddenPanels(status) {
  const out = [];
  if (!moduleEnabled(status, "usage")) out.push("view.usage");
  if (!moduleEnabled(status, "daemons")) out.push("servers.daemons");
  return out;
}

// 实际隐藏集合 = 个人偏好 ∪ 模块联动。
export function effectiveHiddenPanels(status) {
  return new Set([...userHiddenPanels(status), ...moduleHiddenPanels(status)]);
}

// 被隐藏的整页（视图名）。
export function hiddenViewsOf(hidden) {
  return VIEW_PANELS.filter((p) => !p.locked && hidden.has(p.id)).map((p) => p.view);
}

// 面板显隐控制器。controllers：面板 id → { enter, leave }（带轮询的面板）；isViewVisible(view)：该视图当前是否可见。
// onViewsChanged(hiddenViews)：隐藏集合变化时回调（view-tabs.setHiddenViews）。
// apply 在每次状态渲染前调用（app.js render），重新显示的面板随后的 renderDom 就会补上内容，不另外补帧。
export function createPanelVisibility({ doc, controllers = {}, isViewVisible = () => true, onViewsChanged = () => {} }) {
  let hidden = new Set();
  let signature = null;
  // selfHidden 面板隐藏前渲染层留下的显隐状态：重新显示时还原，避免「没有数据」的面板先空着露出来。
  const prevHidden = new Map();

  const isHidden = (id) => hidden.has(id);
  // 「这一视图可见且这块面板没被隐藏」：给控制器当可见性判断，隐藏的面板不会被 leave() 后的 schedule() 又排上轮询。
  const gate = (id, viewVisible = isViewVisible) => (view) => viewVisible(view) && !hidden.has(id);

  function applyPanel(panel, off) {
    const el = doc.getElementById(panel.el);
    if (!el) return;
    if (off) {
      if (panel.selfHidden && !prevHidden.has(panel.id)) prevHidden.set(panel.id, Boolean(el.hidden));
      el.hidden = true;
    } else {
      el.hidden = panel.selfHidden && prevHidden.has(panel.id) ? prevHidden.get(panel.id) : false;
      prevHidden.delete(panel.id);
    }
  }

  // 概览上排两栏（链路 + 简报）：一侧隐藏时另一侧占满整行（类名切换，不用 :has()）。
  function applyLayout() {
    const top = doc.getElementById("ovTop");
    top?.classList.toggle("is-single", hidden.has("overview.chain") || hidden.has("overview.brief"));
  }

  // 按最新 status 应用；集合没变时什么都不做（每次状态渲染前都会调到这里）。返回本次是否有变化。
  function apply(status) {
    const next = effectiveHiddenPanels(status);
    const nextSig = [...next].sort().join("|");
    if (nextSig === signature) return false;
    const first = signature === null;
    signature = nextSig;
    const before = hidden;
    hidden = next;
    for (const panel of PANELS) {
      if (panel.locked) continue;
      const off = next.has(panel.id);
      if (!first && off === before.has(panel.id)) continue;
      // 首次应用只处理要隐藏的：可见的面板保持页面原样（selfHidden 的初始 hidden 不能被抹掉）。
      if (first && !off) continue;
      applyPanel(panel, off);
    }
    applyLayout();
    onViewsChanged(hiddenViewsOf(next));
    // 控制器：新隐藏的停轮询；重新显示且所在视图可见的立即拉一次并续上轮询。
    for (const [id, ctl] of Object.entries(controllers)) {
      const panel = PANELS.find((p) => p.id === id);
      if (!panel) continue;
      const off = next.has(id);
      if (off && !before.has(id)) ctl.leave?.();
      else if (!off && before.has(id) && isViewVisible(panel.view)) ctl.enter?.();
    }
    return true;
  }

  // 切进某个视图：该视图里带轮询的面板，没被隐藏的 enter()，其余 leave()（替代 app.js 里逐个写死的 enter/leave）。
  function enterView(view) {
    for (const [id, ctl] of Object.entries(controllers)) {
      const panel = PANELS.find((p) => p.id === id);
      if (panel && panel.view === view && !hidden.has(id)) ctl.enter?.();
      else ctl.leave?.();
    }
  }

  return { apply, enterView, isHidden, gate, hidden: () => new Set(hidden) };
}
