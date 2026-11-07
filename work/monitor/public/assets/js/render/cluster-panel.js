// cluster-panel.js —— 服务器页「集群节点与队列」面板的 DOM 接线层。
// 模型在 cluster-model.js / cluster-history-model.js（纯函数），HTML 片段在 cluster-view.js（纯字符串）；
// 这里只负责：取 DOM、持有视图状态（过滤：全部/运行/排队/我的 + 按节点；作业列表：当前队列 / 我的历史）、
// 就地修补、「立即刷新」按钮（经注入的 onRefresh 触发一次 slow 采集），以及把「我的历史」的拉取
// 交给 cluster-history-loader.js（GET /api/jobs，跟随 5 分钟一轮的 sacct 采集，看不见时不拉）。
// 失败作业诊断（v2.49）并在「我的历史」里：原因行的展开、提交脚本的按需读取、日志路径复制与顶部同因筛选。
// 按需回查（v2.51，cluster-history-lookup.js）也并在「我的历史」里：查询框、「更早…」、组内「加载更多」。
import { copyText, createElementLookup, morphInnerHtml, setAttr, setText } from "../dom-utils.js";
import { emptyStateHtml } from "../empty-state.js";
import { createJobWatchController } from "../app/job-watch-controller.js";
import { createLogReadback } from "../app/log-readback.js";
import { createHistoryLoader } from "./cluster-history-loader.js";
import { buildLookupBarHtml, createLookupLoader, parseLookupInput } from "./cluster-history-lookup.js";
import { buildHistoryModel } from "./cluster-history-model.js";
import { buildClusterPanelModel } from "./cluster-model.js";
import {
  buildFiltersHtml,
  buildGroupedJobRowsHtml,
  buildHistoryCausesHtml,
  buildHistoryFiltersHtml,
  buildHistoryRowsHtml,
  buildHistorySummaryHtml,
  buildIdleRadarHtml,
  buildKpisHtml,
  buildMineSummaryHtml,
  buildNodesHtml,
  buildUsersHtml,
} from "./cluster-view.js";
import { buildLogReaderHtml, captureLogScroll, diagnosisLogOptions, restoreLogScroll } from "./log-readback-view.js";
import { createMemoRender, timeBucket } from "./render-skip.js";

const getEl = createElementLookup();

// 过滤 / 展开状态按「查看的服务器」隔离：切换服务器回到「全部」、分组全部收起、作业列表回到当前队列。
// expanded：已展开的同名实验组（key = 用户|名字前缀），60s 刷新时保持。
// mode：作业列表显示「当前队列」（queue）还是「我的历史」（history）；histFilter / histExpanded 是历史一侧的筛选与展开。
// histDiag / histScript：展开了诊断 / 提交脚本的作业号；histCause：按同因筛选的分组 key（null = 不筛）。
// 这几项都只存在这里，历史 5 分钟一刷、就地修补时照样保持展开。
const view = {
  serverKey: null, filter: "all", node: null, expanded: new Set(), mode: "queue",
  histFilter: "all", histExpanded: new Set(), histDiag: new Set(), histScript: new Set(), histCause: null,
  resourceOpen: new Set(), queueOpen: new Set(),
};
let lastGroupKeys = [];
let lastArgs = null;
let refreshing = false;
// 「我的历史」是否可用（有接口注入、服务器有 id、调度器里认得出当前用户）；由每次渲染更新。
let historyEnabled = false;
let historyAvailable = false;
let panelVisible = () => true;
// 「我的 Slurm 作业」监控模块（v2.47）：关闭时不显示「我的」汇总条与「我的历史」（/api/jobs 也只回 { disabled }）。
let jobsModuleOn = true;
let history = createHistoryLoader();
let lookup = createLookupLoader();
// 上次同步过组内分页的 48 小时快照标识（换代时把展开过的组按新快照重取）。
let lastLiveSnapshot = null;
let watchController = null;
// v2.51 失败诊断详情里的「读取前一段」：状态按查看的服务器清空（见 app/log-readback.js）。
let historyReadback = createLogReadback();
const diagLogReader = (d) => buildLogReaderHtml({ from: "diagnosis", jobId: d.jobId, options: diagnosisLogOptions(d.files), state: historyReadback.view("diagnosis", d.jobId) });
let notifyJobNavigation = () => {};

function setHidden(el, hidden) {
  if (el && el.hidden !== hidden) el.hidden = hidden;
}

function resetHistoryView() {
  view.histFilter = "all";
  view.histExpanded = new Set();
  view.histDiag = new Set();
  view.histScript = new Set();
  view.histCause = null;
  view.resourceOpen = new Set();
}

function renderHistory(now) {
  const { data, error, loading, diagnoses, scripts } = history.state();
  const lookupState = lookup.state();
  const model = buildHistoryModel({
    data, diagnoses, scripts, error, loading, now, lookup: lookupState,
    view: { filter: view.histFilter, expanded: view.histExpanded, diagOpen: view.histDiag, scriptOpen: view.histScript, cause: view.histCause },
  });
  // 渲染中不发请求：48 小时快照换代后的组内重取、回查失败作业的诊断补拉都放到微任务里。
  const liveId = data?.snapshotId ?? null;
  if (liveId !== lastLiveSnapshot) {
    lastLiveSnapshot = liveId;
    queueMicrotask(() => lookup.syncLive(liveId));
  }
  if (lookupState.segments.some((seg) => Number(seg.data?.summary?.failed) > 0)) queueMicrotask(() => history.ensureDiagnoses());
  view.histFilter = model.filter;
  // 同因分组随新一轮诊断消失（作业滑出 48 小时）：筛选自动回到全部。
  view.histCause = model.cause;
  morphInnerHtml(getEl("clusterHistoryFilters"), buildHistoryFiltersHtml(model.filters));
  const summaryEl = getEl("clusterHistorySummary");
  const summaryHtml = buildHistorySummaryHtml(model.summary);
  setHidden(summaryEl, !summaryHtml);
  if (summaryHtml) morphInnerHtml(summaryEl, summaryHtml);
  const causesEl = getEl("clusterHistoryCauses");
  const causesHtml = buildHistoryCausesHtml(model.causes);
  setHidden(causesEl, !causesHtml);
  if (causesHtml) morphInnerHtml(causesEl, causesHtml);
  const resourceList = watchController?.state().data?.resources || [];
  const resources = watchController ? new Map(resourceList.map((item) => [String(item.jobId), item])) : null;
  const historyBody = getEl("clusterHistoryBody");
  const logScroll = captureLogScroll(historyBody);
  morphInnerHtml(historyBody, buildHistoryRowsHtml(model.rows, model.emptyState || model.emptyText, { resources, resourceOpen: view.resourceOpen, serverId: data?.serverId || lastArgs?.serverId, logReader: diagLogReader }));
  restoreLogScroll(historyBody, logScroll);
  const note = getEl("clusterHistoryNote");
  setHidden(note, !model.noteText);
  setText(note, model.noteText);
  const bar = getEl("clusterHistoryMore");
  const barHtml = buildLookupBarHtml(model.lookupBar);
  setHidden(bar, !barHtml);
  if (barHtml) morphInnerHtml(bar, barHtml);
  setHidden(getEl("clusterHistoryLookupReset"), !(lookupState.query || lookupState.segments.length));
}

// 调度器查询失败：有上次成功的数据 → 顶部一条红色说明、下方照常显示旧数据；
// 从没拿到过数据 → 整块换成「暂时取不到集群状态」空状态（带原因与「重试」，重试 = 面板头的「立即刷新」），
// 节点 / 队列这些空架子不显示（.cl-body[data-no-data]，cluster.css）。
export function clusterErrorHtml(model) {
  if (!model?.errorText || model.hasData) return "";
  return emptyStateHtml({
    tone: "error", icon: "cloudOff", title: "暂时取不到集群状态",
    body: `调度器查询失败：${model.errorText}。随资源采集每 60 秒自动重试一次。`,
    actions: [{ label: "重试", kind: "secondary", attrs: { "data-cl-refresh": "" } }],
  });
}

function renderClusterError(panel, model) {
  const error = getEl("clusterError");
  const noData = clusterErrorHtml(model);
  const body = panel.querySelector?.(".cl-body");
  if (body) setAttr(body, "data-no-data", noData ? "true" : "false");
  setHidden(error, !model.errorText);
  if (!error) return;
  setAttr(error, "data-empty", noData ? "true" : "false");
  if (noData) morphInnerHtml(error, noData);
  else setText(error, model.errorText ? `调度器查询失败：${model.errorText}（下方为上次成功采集的数据）` : "");
}

function renderClusterPanelImpl(layer, serverKey, now, serverId = null) {
  const panel = getEl("clusterPanel");
  if (!panel) return;
  if (serverKey !== view.serverKey) {
    view.serverKey = serverKey;
    view.filter = "all";
    view.node = null;
    view.expanded = new Set();
    view.queueOpen = new Set();
    view.mode = "queue";
    resetHistoryView();
    resetLookupForm();
  }
  history.setServer(serverId);
  historyReadback.setServer(serverId);
  lookup.setServer(serverId);
  watchController?.setServer(serverId);
  const model = buildClusterPanelModel({ layer, now, view, historyRows: history.state().data?.rows });
  const pendingIds = new Set((model.jobs || []).filter((j) => j.mine && j.group === "pending").map((j) => j.id));
  for (const id of view.queueOpen) if (!pendingIds.has(id)) view.queueOpen.delete(id);
  setHidden(panel, !model.visible);
  if (!model.visible) {
    // 面板整块隐藏（这台服务器没有 Slurm）：历史也不必再拉。
    historyAvailable = false;
    history.stop();
    watchController?.stop();
    return;
  }
  // 模型会丢掉已不存在的节点过滤（节点下线 / 换了集群），这里同步回状态。
  view.node = model.node;
  view.filter = model.filter;

  setText(getEl("clusterBadge"), model.badge);
  const fresh = getEl("clusterFreshness");
  setText(fresh, model.freshness.text);
  setAttr(fresh, "data-level", model.freshness.level);
  setAttr(fresh, "title", model.freshness.title);

  renderClusterError(panel, model);

  morphInnerHtml(getEl("clusterKpis"), buildKpisHtml(model.kpis));
  setText(getEl("clusterNodeCount"), `${model.nodes.length} 台`);
  setText(getEl("clusterNodeHint"), model.offSlurmCount ? `${model.offSlurmCount} 台负载高于分配` : "点节点可筛选作业");
  const radarEl = getEl("clusterIdleRadar");
  const radarHtml = buildIdleRadarHtml(model.idleRadar);
  setHidden(radarEl, !radarHtml);
  if (radarEl && radarHtml) morphInnerHtml(radarEl, radarHtml);
  morphInnerHtml(getEl("clusterNodes"), buildNodesHtml(model.nodes, model.node));
  setText(getEl("clusterUserCount"), model.userCount ? `${model.userCount} 位` : "");
  morphInnerHtml(getEl("clusterUsers"), buildUsersHtml(model.users));
  morphInnerHtml(getEl("clusterFilters"), buildFiltersHtml(model.filters, model.node));
  lastGroupKeys = model.groupKeys;
  const mineEl = getEl("clusterMine");
  const mineHtml = jobsModuleOn ? buildMineSummaryHtml(model.mine) : "";
  setHidden(mineEl, !mineHtml);
  if (mineHtml) morphInnerHtml(mineEl, mineHtml);
  morphInnerHtml(getEl("clusterJobsBody"), buildGroupedJobRowsHtml(model.jobRows, model.emptyState || model.emptyText, { watches: jobsModuleOn ? watchController?.watchedIds() : null, watchGroups: watchController?.watchedGroups(), queueOpen: view.queueOpen }));
  const trunc = getEl("clusterTruncated");
  setHidden(trunc, !model.truncatedText);
  setText(trunc, model.truncatedText);

  // 作业列表的两种看法共用一块区域：当前队列（squeue 全员快照）/ 我的历史（sacct 近 48 小时）。
  historyAvailable = Boolean(jobsModuleOn && historyEnabled && serverId && model.viewer);
  if (!historyAvailable && view.mode === "history") {
    view.mode = "queue";
    history.stop();
  }
  const showHistory = view.mode === "history";
  const modeEl = getEl("clusterQueueMode");
  setHidden(modeEl, !historyAvailable);
  for (const btn of modeEl?.querySelectorAll("[data-cl-mode]") || []) {
    setAttr(btn, "aria-pressed", String(btn.getAttribute("data-cl-mode") === view.mode));
  }
  setText(getEl("clusterQueueCount"), String(model.filters[0]?.count ?? 0));
  setHidden(getEl("clusterFilters"), showHistory);
  setHidden(getEl("clusterQueueView"), showHistory);
  setHidden(getEl("clusterHistoryFilters"), !showHistory);
  setHidden(getEl("clusterHistory"), !showHistory);
  if (showHistory) renderHistory(now);
}

// 签名：slurm 快照只在新一轮采集时整体换新（checkedAt 必变），不必 stringify 数十 KB 的作业表；
// 另含层级别（采集失败提示）、过滤状态、作业列表模式与历史数据的版本、相对时间桶（「采样于 N 秒前」要走字）。
const memoRender = createMemoRender(renderClusterPanelImpl, (layer, serverKey, now, serverId) => {
  const slurm = layer?.slurm;
  const hist = history.state();
  return [
    serverKey ?? "",
    serverId ?? "",
    slurm ? `${slurm.state}/${slurm.checkedAt ?? ""}/${slurm.jobsTotal ?? ""}` : "none",
    layer ? `${layer.level ?? ""}/${layer.checkedAt ?? ""}` : "",
    view.filter,
    view.node ?? "",
    [...view.expanded].join(","),
    view.mode,
    jobsModuleOn ? 1 : 0,
    view.histFilter,
    [...view.histExpanded].join(","),
    [...view.histDiag].join(","),
    [...view.histScript].join(","),
    [...view.resourceOpen].join(","),
    watchController ? `${watchController.watchedIds() ? [...watchController.watchedGroups()].sort().join(";") : "off"}/${view.mode === "history" ? watchController.state().revision : 0}` : "0",
    view.histCause ?? "",
    `${hist.revision}/${hist.loading ? 1 : 0}`,
    historyReadback.revision(),
    lookup.state().revision,
    timeBucket(now),
  ].join("|");
});

export function renderClusterPanel(layer, activeServer, now = Date.now()) {
  const serverKey = activeServer?.id || activeServer?.host || null;
  const serverId = activeServer?.id || null;
  lastArgs = { layer, serverKey, serverId };
  const rendered = memoRender(layer, serverKey, now, serverId);
  // 渲染入口顺带对一下历史的轮询：回到服务器页 / 窗口重新可见后续上（看不见时这里不会被调到）。
  history.sync();
  if (layer?.slurm && layer.slurm.state !== "absent") watchController?.sync();
  return rendered;
}

// 面板看不见（不在服务器页 / 被隐藏）时不重绘：迟到的历史结果不该把用户隐藏的面板又显示出来，
// 回到可见时渲染管线会补一帧。
function rerender() {
  if (lastArgs && panelVisible()) memoRender(lastArgs.layer, lastArgs.serverKey, Date.now(), lastArgs.serverId);
}

// 「我的 Slurm 作业」模块开关（app.js 按 status.modules.jobs 每轮调用；值不变时什么都不做）。
export function setClusterJobsModule(enabled) {
  const next = enabled !== false;
  if (next === jobsModuleOn) return;
  jobsModuleOn = next;
  watchController?.setEnabled(next);
  if (!next) {
    historyAvailable = false;
    if (view.mode === "history") view.mode = "queue";
    history.stop();
  }
  rerender();
}

async function runRefresh(btn, onRefresh) {
  if (refreshing || !view.serverKey) return;
  refreshing = true;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    await onRefresh(view.serverKey);
    // 正在看历史：队列刷新完顺带重读一次作业历史（读的是后端快照，不另发 sacct）。
    if (view.mode === "history") await history.start();
  } catch {
    // 错误提示由注入方（withErrorToast）负责；这里只负责恢复按钮。
  } finally {
    refreshing = false;
    btn.disabled = false;
    btn.textContent = label;
  }
}

function setMode(mode) {
  const next = mode === "history" && historyAvailable ? "history" : "queue";
  if (next === view.mode) return;
  view.mode = next;
  if (next === "history") history.start();
  else history.stop();
  rerender();
}

// 查询框（v2.51）：作业号 / 日期 → 回查；空着提交 = 回到近 48 小时；认不出写在提示里，不发请求。
function setLookupHint(text) {
  setText(getEl("clusterHistoryLookupHint"), text || "");
}

function resetLookupForm() {
  const input = getEl("clusterHistoryQuery");
  if (input) input.value = "";
  setLookupHint("");
}

function submitLookup() {
  const input = getEl("clusterHistoryQuery");
  const parsed = parseLookupInput(input?.value || "");
  if (parsed.error) {
    setLookupHint(parsed.error);
    return;
  }
  setLookupHint("");
  view.histFilter = "all";
  view.histCause = null;
  if (parsed.kind === "none") lookup.backToLive();
  else lookup.search(parsed);
  rerender();
}

function backToLive() {
  resetLookupForm();
  lookup.backToLive();
  rerender();
}

function toggle(set, key) {
  if (set.has(key)) set.delete(key);
  else set.add(key);
}

// 「查看提交脚本」：收起只是不显示；展开时没取过 / 上次失败就去取（缓存按作业号，见 cluster-history-loader.js）。
function toggleScript(jobId) {
  if (view.histScript.has(jobId)) {
    view.histScript.delete(jobId);
    rerender();
    return;
  }
  view.histScript.add(jobId);
  rerender();
  const entry = history.state().scripts?.get(jobId);
  if (!entry || entry.state === "error") history.loadScript(jobId);
}

async function copyPath(btn) {
  const path = btn.getAttribute("data-cl-diag-copy") || "";
  // 剪贴板不可用时 copyText 弹可全选的输入框兜底，此时不显示「已复制」。
  if (!path || !(await copyText(path))) return;
  if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent || "复制";
  const orig = btn.dataset.origLabel;
  btn.textContent = "已复制";
  setTimeout(() => {
    if (btn.isConnected) btn.textContent = orig;
  }, 1500);
}

// 一次性事件委托：过滤芯片 / 节点卡 / 刷新按钮 / 作业列表模式与历史的筛选、展开。
// onRefresh(serverId) 返回 Promise；getJson(path) 读接口；isVisible() = 服务器页可见且窗口没被隐藏；
// onVisibilityChange(fn) 订阅窗口显隐（重新可见时续上历史的轮询）。
export function initClusterPanel({ onRefresh, getJson = null, postJson = null, showToast, isVisible = null, onVisibilityChange = null } = {}) {
  const panel = getEl("clusterPanel");
  if (!panel || panel.dataset.bound === "1") return;
  panel.dataset.bound = "1";
  if (typeof showToast === "function") notifyJobNavigation = showToast;
  if (typeof isVisible === "function") panelVisible = isVisible;
  if (typeof getJson === "function") {
    historyEnabled = true;
    history = createHistoryLoader({
      getJson,
      isActive: () => view.mode === "history" && historyAvailable && panelVisible(),
      onChange: rerender,
    });
    historyReadback = createLogReadback({ getJson, onChange: rerender });
    lookup = createLookupLoader({ getJson, onChange: rerender, onLiveExpired: () => history.start() });
    getEl("clusterHistoryLookup")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitLookup();
    });
    if (typeof postJson === "function") {
      let watchRoot = getEl("clusterJobWatch");
      if (!watchRoot) {
        watchRoot = panel.ownerDocument.createElement("section");
        watchRoot.id = "clusterJobWatch";
        const queue = getEl("clusterQueueView")?.closest(".cl-section");
        if (queue) queue.before(watchRoot);
        else panel.append(watchRoot);
      }
      watchController = createJobWatchController({ doc: panel.ownerDocument, getJson, postJson, showToast, isVisible: () => panelVisible() && !panel.hidden, onChange: rerender });
      watchController.bind(watchRoot);
      watchController.setEnabled(jobsModuleOn);
    }
  }
  onVisibilityChange?.(() => { history.sync(); watchController?.sync(); });
  // 组行 / 带诊断的失败行可聚焦：Enter / 空格展开或收起（与点击同一路径）。
  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (event.target.closest?.("button, a, input, select, summary")) return;
    const row = event.target instanceof Element ? event.target.closest("[data-cl-group], [data-cl-hist-group], tr[data-cl-diag]") : null;
    if (!row) return;
    event.preventDefault();
    row.click();
  });
  panel.addEventListener("toggle", (event) => {
    const details = event.target;
    const id = details?.dataset?.jwQueue;
    if (!id || !details.isConnected) return;
    if (details.open) view.queueOpen.add(id); else view.queueOpen.delete(id);
  }, true);
  panel.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const watchButton = target.closest("[data-job-watch]");
    if (watchButton) {
      if (!watchButton.disabled) watchController?.watch(watchButton.dataset.jobWatch.split(","), watchButton.dataset.watchLabel);
      return;
    }
    const copySbatch = target.closest("[data-copy-sbatch]");
    if (copySbatch) {
      const code = copySbatch.closest(".jw-sbatch")?.querySelector("code")?.textContent;
      if (code) copyText(code).then((copied) => { if (copied && copySbatch.isConnected) copySbatch.textContent = "已复制 SBATCH 建议"; });
      return;
    }
    const resourceButton = target.closest("[data-job-resource]");
    if (resourceButton) { toggle(view.resourceOpen, resourceButton.dataset.jobResource); rerender(); return; }
    if (target.closest("[data-job-report], .jw-review-row, #clusterJobWatch")) return;
    const refreshBtn = target.closest("#clusterRefreshBtn");
    if (refreshBtn) {
      if (typeof onRefresh === "function") runRefresh(refreshBtn, onRefresh);
      return;
    }
    // 空状态里的动作：「重试」走面板头「立即刷新」同一条路（按钮状态也一起变）；
    // 「清除筛选」回到全部作业、不按节点过滤；「按作业号或日期查」把焦点交给查询框。
    if (target.closest("[data-cl-refresh]")) {
      const headerBtn = getEl("clusterRefreshBtn");
      if (headerBtn && typeof onRefresh === "function") runRefresh(headerBtn, onRefresh);
      return;
    }
    if (target.closest("[data-cl-clear-filter]")) {
      view.filter = "all";
      view.node = null;
      rerender();
      return;
    }
    if (target.closest("[data-cl-lookup-focus]")) {
      getEl("clusterHistoryQuery")?.focus();
      return;
    }
    const modeBtn = target.closest("[data-cl-mode]");
    if (modeBtn) {
      setMode(modeBtn.getAttribute("data-cl-mode"));
      return;
    }
    // v2.51 回查：组内加载更多 / 更早… / 段重试 / 补齐 / 回到近 48 小时。
    const groupMore = target.closest("[data-cl-group-more]");
    if (groupMore) {
      if (!groupMore.disabled) lookup.loadGroup(groupMore.getAttribute("data-cl-group-more"), groupMore.getAttribute("data-cl-group-key") || "", Number(groupMore.getAttribute("data-cl-group-limit")));
      return;
    }
    const earlierBtn = target.closest("[data-cl-lookup-earlier]");
    if (earlierBtn) {
      if (!earlierBtn.disabled) lookup.loadEarlier(history.state().data);
      return;
    }
    const retryBtn = target.closest("[data-cl-lookup-retry]");
    if (retryBtn) {
      lookup.retry(retryBtn.getAttribute("data-cl-lookup-retry"));
      return;
    }
    if (target.closest("[data-cl-lookup-refill]")) {
      lookup.refillGap(history.state().data);
      return;
    }
    if (target.closest("#clusterHistoryLookupReset")) {
      backToLive();
      return;
    }
    const histFilter = target.closest("[data-cl-hist-filter]");
    if (histFilter) {
      view.histFilter = histFilter.getAttribute("data-cl-hist-filter") || "all";
      view.histCause = null;
      rerender();
      return;
    }
    // 诊断：先认展开内容里的按钮（复制 / 脚本），再认同因筛选，最后才是行的展开开关；
    // 展开内容里的其它点击（选中证据文字等）不收起。
    const copyBtn = target.closest("[data-cl-diag-copy]");
    if (copyBtn) {
      copyPath(copyBtn);
      return;
    }
    const readerBtn = target.closest("[data-lr-action]");
    if (readerBtn) {
      if (!readerBtn.disabled) historyReadback.handleAction(readerBtn.dataset);
      return;
    }
    const scriptBtn = target.closest("[data-cl-diag-script]");
    if (scriptBtn) {
      if (!scriptBtn.disabled) toggleScript(scriptBtn.getAttribute("data-cl-diag-script"));
      return;
    }
    const cause = target.closest("[data-cl-diag-cause]");
    if (cause) {
      const key = cause.getAttribute("data-cl-diag-cause");
      view.histCause = view.histCause === key ? null : key;
      rerender();
      return;
    }
    if (target.closest("[data-cl-diag-cause-clear]")) {
      view.histCause = null;
      rerender();
      return;
    }
    const diagToggle = target.closest("[data-cl-diag]");
    if (diagToggle) {
      toggle(view.histDiag, diagToggle.getAttribute("data-cl-diag"));
      rerender();
      return;
    }
    const histGroup = target.closest("[data-cl-hist-group]");
    if (histGroup) {
      toggle(view.histExpanded, histGroup.getAttribute("data-cl-hist-group"));
      rerender();
      return;
    }
    const expandAll = target.closest("[data-cl-expand-all]");
    if (expandAll) {
      view.expanded = expandAll.getAttribute("data-cl-expand-all") === "expand" ? new Set(lastGroupKeys) : new Set();
      rerender();
      return;
    }
    const groupRow = target.closest("[data-cl-group]");
    if (groupRow) {
      toggle(view.expanded, groupRow.getAttribute("data-cl-group"));
      rerender();
      return;
    }
    const filterBtn = target.closest("[data-cl-filter]");
    if (filterBtn && !filterBtn.disabled) {
      view.filter = filterBtn.getAttribute("data-cl-filter") || "all";
      rerender();
      return;
    }
    const nodeBtn = target.closest("[data-cl-node]");
    if (nodeBtn) {
      const name = nodeBtn.getAttribute("data-cl-node");
      view.node = view.node === name ? null : name;
      rerender();
    }
  });
}

// 测试用：重置模块级状态。
// 简报「作业失败」留意项的跳转：切到「我的历史」（作业模块关闭 / 尚无历史时留在当前队列视图）。
export function showClusterHistory() {
  setMode("history");
}

// 通知点击后的定位。根装配先切服务器并刷新，再调用这里；只接受独立作业号。
// target = "history"（v2.62 失败提醒）：直接去「我的历史」并展开那一行的失败诊断——原因、日志与提交脚本都在那里，
// 关注列表里看不到；历史里找不到时才退回关注列表。其余提醒照旧先找关注列表。
export async function focusClusterJob(jobId, target = null) {
  if (!/^\d{1,12}(?:_\d{1,9})?$/.test(String(jobId))) return false;
  const serverKey = view.serverKey;
  const watched = () => getEl("clusterJobWatch")?.querySelector(`[data-watch-job-id="${jobId}"]`);
  const toHistory = target === "history" && historyAvailable;
  let node = toHistory ? null : watched();
  if (!node && historyAvailable) {
    // 正在看查询结果：先回到近 48 小时（定位只在默认视图里找）。
    if (lookup.state().query) backToLive();
    setMode("history");
    await history.start();
    if (serverKey !== view.serverKey) return false;
    const rows = history.state().data?.rows || [];
    const group = rows.find((row) => row.kind === "group" && row.children?.some((child) => String(child.id) === String(jobId)));
    view.histFilter = "all";
    view.histCause = null;
    if (group) view.histExpanded.add(String(group.key));
    if (toHistory) view.histDiag.add(String(jobId));
    else view.resourceOpen.add(String(jobId));
    rerender();
    node = getEl("clusterHistoryBody")?.querySelector(`[data-history-job-id="${jobId}"]`);
  }
  if (!node && toHistory) node = watched();
  if (!node) {
    notifyJobNavigation({ type: "info", title: "作业定位", message: `作业 ${jobId} 当前不在关注列表或已加载的近 48 小时历史中；提醒记录仍保留。` });
    return false;
  }
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.setAttribute("tabindex", "-1");
  node.focus({ preventScroll: true });
  return true;
}

export async function refreshClusterWatches() { await watchController?.refresh(); }

export function resetClusterPanelState() {
  history.stop();
  watchController?.stop();
  watchController = null;
  notifyJobNavigation = () => {};
  history = createHistoryLoader();
  lookup = createLookupLoader();
  lastLiveSnapshot = null;
  historyEnabled = false;
  historyAvailable = false;
  panelVisible = () => true;
  jobsModuleOn = true;
  view.serverKey = null;
  view.filter = "all";
  view.node = null;
  view.expanded = new Set();
  view.queueOpen = new Set();
  view.mode = "queue";
  resetHistoryView();
  lastArgs = null;
  refreshing = false;
}
