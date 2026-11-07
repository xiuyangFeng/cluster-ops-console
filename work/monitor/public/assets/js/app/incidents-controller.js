// app/incidents-controller.js —— T06 事件视图 / 概览事件摘要（消费 /api/incidents、/api/incidents/summary）。
// 偏好动作（确认 / 稍后提醒）只影响提醒资格，不改变故障事实（T07 契约）。
//
// 已恢复事件有两种排列：按类型（缺省，汇总表，点一行展开这一类最近的逐条记录）与逐条（卡片）。
// 汇总表里「查看这一类留存的全部 N 条」会切到逐条并只看那一类；分段控件直接点「逐条」看全部类型。
//
// 事件中心（2026-10-23）：已恢复的「逐条」按事件簇取（group=cluster，同类 15 分钟内接连发生的合成一张卡）；
// 卡片上的「前后经过」按需取 /api/incidents/:id/context（缓存 30 秒），「复制排障信息」把事件事实 + 前后经过
// 拼成纯文本复制；建议处置的按钮交给 onRemedy（app.js 接到修复 runbook：单隧道重启 / 一键修复），
// 处置受理后后端把结果记在事件上（lib/incidents/disposition.mjs），这里只管刷新。
//
// perf：每次状态刷新都会走到 fetch。open 列表是概览摘要与事件页默认视图的数据源，常态只拉它；
// 已恢复的数据只有事件页可见且筛选器选中"已恢复"时才拉，而且只拉当前排列用的那一份。
import { createRefreshQueue } from "../refresh-queue.js";
import { buildIncidentCopyText } from "../render/incident-insights.js";
import {
  buildIncidentListModel,
  incidentTitleWithServer,
  renderIncidentChrome,
  renderIncidentList,
  renderIncidentSummary,
  renderOverviewIncidentSummary,
} from "../render/incidents.js";

// 按类型汇总的统计窗口（北京自然日，含今天）。
export const INCIDENT_SUMMARY_DAYS = 14;
const SUMMARY_PATH = `/api/incidents/summary?days=${INCIDENT_SUMMARY_DAYS}`;
const EMPTY_OPEN = Object.freeze({ incidents: [], total: 0, state: "open" });
const FAILED = Symbol("failed");
// 未解决列表请求失败：带上原因（从没取到过时显示「暂时取不到」，取到过就继续显示上一次的）。
const OPEN_FAILED = Symbol("openFailed");
const errorText = (err) => err?.serverMessage || err?.message || "请求失败";
// 前后经过的缓存时长：展开着的事件每次状态刷新不重取，过了这么久再展开 / 复制才重取。
const CONTEXT_TTL_MS = 30_000;
const attentionNotice = (action) => (action === "acknowledge"
  ? "已确认（事件保持未解决直到恢复）"
  : action === "snooze" ? "已设置稍后提醒" : "已取消稍后提醒");

// onOpenIncidents(open)：每次拿到新的 open 列表后回调（注意力队列据此隐藏已确认的磁盘告警）。
// getStatus()：最近一次 /api/status 快照，只用来把 serverId / agentId 换成界面上的名字。
// onRemedy(action, serverId)：建议处置的按钮（restart-tunnel | restart-channel）；canScopedRestart()：后台组件是否支持单隧道重启。
// copyText(text)：复制到剪贴板（dom-utils.copyText），返回 Promise<boolean>。
export function createIncidentsController({
  doc, getJson, postJson, showToast, isViewVisible, openLogsForOperation, onOpenIncidents, getStatus = () => null,
  onRemedy = null, canScopedRestart = () => false, copyText = null, now = Date.now,
}) {
  let lastOpen = null;
  let openError = "";
  let lastResolved = null; // { typeKey, payload }：typeKey 记下这份列表是按哪一类取的（"" = 全部类型）
  let lastSummary = null;
  let summaryFailed = false;
  let mode = "type"; // 已恢复事件的排列：type 按类型 | each 逐条
  let typeFilter = null; // 逐条视图只看某一类：汇总表里的那一行 { key, component, agentId, serverId, reasonCode }
  const expanded = new Set(); // 汇总表里展开着的类型 key
  const expandedClusters = new Set(); // 逐条（事件簇）里展开着逐次记录的簇 id
  const contexts = new Map(); // 展开着「前后经过」的事件：incidentId -> payload | null（加载中）| "failed"
  const contextCache = new Map(); // incidentId -> { payload, at }：收起后再展开 / 复制时 30 秒内复用（≤ 最近 20 条）
  const filterValue = () => doc.getElementById("incidentStateFilter")?.value;
  // 现在要哪一份已恢复数据：事件页可见且筛选器选中"已恢复"时才要，按当前排列取。
  const resolvedView = () => (isViewVisible("events") && filterValue() === "resolved" ? mode : null);
  const typeKey = () => typeFilter?.key || "";

  const queue = createRefreshQueue({
    load: () => {
      const view = resolvedView();
      const key = typeKey();
      return Promise.all([
        getJson("/api/incidents?state=open&limit=50").catch((err) => ({ [OPEN_FAILED]: errorText(err) })),
        view === "each"
          ? getJson(`/api/incidents?state=resolved&group=cluster&limit=50${key ? `&type=${encodeURIComponent(key)}` : ""}`)
            .then((payload) => (payload ? { typeKey: key, payload } : null)).catch(() => null)
          : null,
        view === "type" ? getJson(SUMMARY_PATH).catch(() => FAILED) : null,
      ]);
    },
    commit: ([open, resolved, summary]) => {
      if (open?.[OPEN_FAILED]) openError = open[OPEN_FAILED];
      else if (open) {
        lastOpen = open;
        openError = "";
        onOpenIncidents?.(open);
      }
      if (resolved) lastResolved = resolved;
      if (summary === FAILED) summaryFailed = true;
      else if (summary) {
        lastSummary = summary;
        summaryFailed = false;
      }
      render();
    },
  });
  const fetchIncidents = (options) => queue(options);
  // 排列 / 筛选变了：先用手头的数据重画，再按需强制拉新的。
  const refreshResolved = () => {
    render();
    if (resolvedView()) fetchIncidents({ force: true });
  };

  async function setAttention(incidentId, action, durationMs) {
    try {
      await postJson(`/api/incidents/${encodeURIComponent(incidentId)}/attention`, { action, durationMs });
      showToast({ type: "success", message: attentionNotice(action), title: "事件提醒" });
    } catch (err) {
      showToast({ type: "error", message: err.serverMessage || err.message || "请求失败", title: "事件提醒" });
    }
    fetchIncidents({ force: true });
  }

  // 前后经过：展开即取（已有且没过期不重取），再点收起。
  async function loadContext(incidentId, { force = false } = {}) {
    const cached = contextCache.get(incidentId);
    if (!force && cached && now() - cached.at < CONTEXT_TTL_MS) return cached.payload;
    try {
      const payload = await getJson(`/api/incidents/${encodeURIComponent(incidentId)}/context`);
      if (!payload || typeof payload !== "object") return "failed";
      contextCache.delete(incidentId);
      contextCache.set(incidentId, { payload, at: now() });
      if (contextCache.size > 20) contextCache.delete(contextCache.keys().next().value);
      return payload;
    } catch {
      return "failed";
    }
  }

  async function toggleContext(incidentId) {
    if (!incidentId) return;
    if (contexts.has(incidentId)) {
      contexts.delete(incidentId);
      render();
      return;
    }
    contexts.set(incidentId, null);
    render();
    const payload = await loadContext(incidentId);
    if (!contexts.has(incidentId)) return; // 取的过程中被收起了
    contexts.set(incidentId, payload);
    render();
  }

  function toggleCluster(clusterId) {
    if (!expandedClusters.delete(clusterId)) expandedClusters.add(clusterId);
    render();
  }

  // 复制排障信息：事件事实 + 前后经过（取不到前后经过时只复制事实）。
  async function copyIncident(incidentId) {
    const status = getStatus();
    const item = buildIncidentListModel(lastOpen || EMPTY_OPEN, { status, nowMs: now() }).items.find((entry) => entry.incidentId === incidentId);
    if (!item || typeof copyText !== "function") return;
    const context = await loadContext(incidentId);
    if (context !== "failed" && context && contexts.has(incidentId)) contexts.set(incidentId, context);
    const text = buildIncidentCopyText(item, {
      nowMs: now(), context: context === "failed" ? null : context, titleOf: (fields) => incidentTitleWithServer(status, fields),
    });
    const ok = await copyText(text);
    showToast({ type: ok ? "success" : "error", title: "排障信息", message: ok ? "已复制，可直接粘贴给同事或集群管理员" : "浏览器不允许直接写剪贴板，已弹出文本框，请手动复制" });
  }

  function remedy(action, serverId) {
    if (typeof onRemedy === "function") onRemedy(action, serverId);
  }

  function toggleType(key) {
    if (!expanded.delete(key)) expanded.add(key);
    render();
  }

  // 分段控件：直接点「逐条」是看全部类型，所以清掉「只看这一类」。
  function setMode(next) {
    mode = next === "each" ? "each" : "type";
    typeFilter = null;
    refreshResolved();
  }

  // 汇总表里「查看这一类留存的全部 N 条」：切到逐条并只看这一类（每类最多留存 50 条，一页取全）。
  function viewType(key) {
    const type = (Array.isArray(lastSummary?.types) ? lastSummary.types : []).find((item) => item?.key === key);
    if (!type) return;
    typeFilter = { key, component: type.component, agentId: type.agentId, serverId: type.serverId, reasonCode: type.reasonCode };
    mode = "each";
    refreshResolved();
    // 刚才点的按钮随汇总表一起隐藏了：把键盘焦点交给分段控件里当前选中的那一项。
    doc.getElementById("incidentModeEach")?.focus?.();
  }

  function clearTypeFilter() {
    typeFilter = null;
    refreshResolved();
  }

  // 「没有未解决的事件」空状态里的「查看已恢复事件」：等同于把筛选器切到「已恢复」（同一条按需拉取路径）。
  // 按钮随列表一起换掉了，焦点交给筛选器。
  function showResolved() {
    const select = doc.getElementById("incidentStateFilter");
    if (!select) return;
    select.value = "resolved";
    refreshResolved();
    select.focus?.();
  }

  // 按类型汇总取不到时的「改看逐条」：等同于点分段控件里的「逐条」。
  function showEach() {
    setMode("each");
    doc.getElementById("incidentModeEach")?.focus?.();
  }

  function render() {
    const status = getStatus();
    renderOverviewIncidentSummary(buildIncidentListModel(lastOpen || EMPTY_OPEN, { status }));
    const state = filterValue() === "resolved" ? "resolved" : "open";
    let badge;
    if (state === "resolved" && mode === "type") {
      ({ badge } = renderIncidentSummary(lastSummary, {
        status, expanded, failed: summaryFailed && !lastSummary,
        onToggle: toggleType, onViewOps: openLogsForOperation, onViewType: viewType, onShowEach: showEach,
      }));
    } else {
      // 已恢复列表要与当前「只看这一类」对得上；换了类型、新的还没到时显示加载而不是上一类的记录。
      const resolvedPayload = lastResolved?.typeKey === typeKey() ? lastResolved.payload : null;
      badge = renderIncidentList(state === "resolved" ? resolvedPayload : lastOpen, {
        state, status, typeFilter: state === "resolved" ? typeFilter : null, failed: state === "open" ? openError : "",
        canScoped: Boolean(canScopedRestart()), contexts, expandedClusters, nowMs: now(),
        onAttention: setAttention, onViewOps: openLogsForOperation, onClearType: clearTypeFilter, onShowResolved: showResolved,
        onRemedy: typeof onRemedy === "function" ? remedy : undefined, onToggleContext: toggleContext, onCopy: copyIncident, onToggleCluster: toggleCluster,
      });
    }
    renderIncidentChrome({ state, mode, badge });
  }

  function bindFilter() {
    doc.getElementById("incidentStateFilter")?.addEventListener("change", refreshResolved); // 切到"已恢复"才按需拉取
    doc.getElementById("incidentResolvedMode")?.addEventListener("click", (event) => {
      const next = event.target?.closest?.("[data-ev-mode]")?.dataset.evMode;
      if (next && next !== mode) setMode(next);
      else if (next === "each" && typeFilter) clearTypeFilter(); // 已在逐条、但只看着某一类：再点一次回到全部类型
    });
  }

  return { fetch: fetchIncidents, render, bindFilter, setAttention, toggleContext, copyIncident };
}
