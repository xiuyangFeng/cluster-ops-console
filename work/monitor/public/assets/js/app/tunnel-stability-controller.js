// app/tunnel-stability-controller.js —— 概览「隧道稳定性」（链路面板底部，#chainUptime）：拉取 /api/tunnel-stability、
// 窗口切换（近 24 小时 / 近 7 天）、断线清单的展开与定位；只在概览可见且窗口没被隐藏时轮询。
// 近 24 小时窗口每条隧道另带一条「SSH 响应」细线：数据是 /api/metrics 里各服务器资源采集的耗时
// （probeDurationMs，后端只留 24 小时），首次整段取、之后只增量取新样本。
// 拿到的统计经 onStability 顺带送给链路面板（节点详情里的断线统计），不另起一路轮询。
// 交互全部挂在 #chainUptime 上做事件委托：正文经 morphInnerHtml 修补，按钮节点可能被替换。
// isPanelHidden()：用户在「界面面板」里隐藏了它（app/panels.js）——不渲染（视图层会按内容把
// #chainUptime 的 hidden 改回来）、不取 SSH 响应序列，但断线统计照常轮询：链路面板锁定不可隐藏，
// 节点详情里的断线统计靠这一路数据。
import { buildDropRows, dropGroupKeyOf, latestResponseTs, mergeResponseSamples, RESPONSE_WINDOW_MS, windowStartOf } from "../render/tunnel-stability-model.js";
import { createTunnelStabilityView } from "../render/tunnel-stability-view.js";

export const TUNNEL_STABILITY_POLL_MS = 30000;
// 采集每分钟一次：响应序列不必跟着 30 秒的轮询每次都取。
export const TUNNEL_RESPONSE_REFRESH_MS = 60000;
const WINDOW_STORAGE_KEY = "tunnelStabilityWindow";
const FOCUS_MS = 4000;

export function createTunnelStabilityController({
  doc, getJson, isViewVisible, isHidden, onVisibilityChange, onStability, isPanelHidden = () => false,
  storage = typeof localStorage !== "undefined" ? localStorage : null, now = Date.now, view = createTunnelStabilityView({ doc }),
}) {
  let windowKey = "24h";
  try {
    if (storage?.getItem(WINDOW_STORAGE_KEY) === "7d") windowKey = "7d";
  } catch {}
  let stats = null;
  let timer = null;
  let inFlight = null;
  let focusKey = null;
  let focusTimer = null;
  // 断线清单是否展开、展开着哪些组（key = g:服务器:原因:组里最早一次的时刻）：30 秒刷新时保持。
  let dropsOpen = false;
  let expandedDrops = new Set();
  // SSH 响应的原始序列：Map<serverId, [{ ts, ms }]>，只留近 24 小时。
  let responses = new Map();
  let responsesAt = 0;
  const renderNow = () => (isPanelHidden() ? [] : view.render(stats, { windowKey, nowMs: now(), responses, expandedDrops, dropsOpen }));

  // 轮询门控只看概览是否可见：面板被隐藏时链路面板仍要断线统计。
  const visible = () => isViewVisible("overview") && !isHidden();

  // 点在线条上的断线刻度：展开清单（那次断线被合进了某个组就先展开组），高亮那一行并滚到视口。
  function applyFocus() {
    if (!focusKey || !stats) return;
    const since = windowStartOf(stats, windowKey);
    const groupKey = dropGroupKeyOf(buildDropRows(stats, undefined, { expanded: expandedDrops, since }), focusKey);
    if (!dropsOpen || (groupKey && !expandedDrops.has(groupKey))) {
      dropsOpen = true;
      if (groupKey) expandedDrops = new Set([...expandedDrops, groupKey]);
      renderNow();
    }
    for (const tr of doc.querySelectorAll("#stabilityDrops tr.is-focus")) tr.classList.remove("is-focus");
    const row = [...doc.querySelectorAll("#stabilityDrops tr[data-key]")].find((tr) => tr.dataset.key === focusKey);
    if (row) {
      row.classList.add("is-focus");
      row.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      row?.classList.remove("is-focus");
      focusKey = null;
    }, FOCUS_MS);
  }

  // 响应序列只有近 24 小时窗口用得上；取不到时保留已有的（这条线是锦上添花，不让它拖累断线统计）。
  async function refreshResponses() {
    const nowMs = now();
    if (isPanelHidden() || windowKey !== "24h" || nowMs - responsesAt < TUNNEL_RESPONSE_REFRESH_MS) return;
    responsesAt = nowMs;
    const cutoff = nowMs - RESPONSE_WINDOW_MS;
    const latest = latestResponseTs(responses);
    const since = latest != null && latest >= cutoff ? latest + 1 : cutoff;
    try {
      const { samples } = await getJson(`/api/metrics?since=${since}`);
      responses = mergeResponseSamples(responses, samples, cutoff);
    } catch {
      // 保留已有序列，下一轮再试。
    }
  }

  async function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const [next] = await Promise.all([getJson("/api/tunnel-stability"), refreshResponses()]);
        stats = next;
        renderNow();
        applyFocus();
        onStability?.(stats);
      } catch {
        // 拉取失败：保留上一份（整块不动），下一轮再试。
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!visible()) return;
    timer = setTimeout(async () => {
      if (visible()) await refresh();
      schedule();
    }, TUNNEL_STABILITY_POLL_MS);
  }

  function setWindow(next) {
    windowKey = next === "7d" ? "7d" : "24h";
    try {
      storage?.setItem(WINDOW_STORAGE_KEY, windowKey);
    } catch {}
    if (stats) renderNow();
    // 从 7 天切回 24 小时：响应序列可能还没取过（或已经旧了），补一轮。
    if (windowKey === "24h" && now() - responsesAt >= TUNNEL_RESPONSE_REFRESH_MS) refresh();
  }

  function toggleGroup(row) {
    const key = row.dataset.group;
    const next = new Set(expandedDrops);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedDrops = next;
    if (stats) renderNow();
  }

  function bind() {
    const root = doc.getElementById("chainUptime");
    root?.addEventListener("click", (event) => {
      const target = event.target;
      const windowBtn = target?.closest?.("[data-stability-window]");
      if (windowBtn) return setWindow(windowBtn.dataset.stabilityWindow);
      const drop = target?.closest?.("[data-drop-key]");
      if (drop) return focusDrop(drop.dataset.dropKey);
      if (target?.closest?.("[data-stability-drops]")) {
        dropsOpen = !dropsOpen;
        if (stats) renderNow();
        return;
      }
      const group = target?.closest?.("tr[data-group]");
      if (group) toggleGroup(group);
    });
    root?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const group = event.target?.closest?.("tr[data-group]");
      if (!group) return;
      event.preventDefault();
      toggleGroup(group);
    });
    onVisibilityChange?.(() => { if (visible()) { refresh(); schedule(); } else schedule(); });
  }

  function enter() {
    refresh();
    schedule();
  }

  function leave() {
    schedule();
  }

  // 定位到某次断线（key = serverId:断开时刻）；数据还没到就等这一轮拉到后再高亮。
  function focusDrop(key) {
    focusKey = key || null;
    if (stats) applyFocus();
    else refresh();
  }

  return { bind, enter, leave, refresh, focusDrop };
}
