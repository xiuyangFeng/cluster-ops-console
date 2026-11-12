// app.js —— 控制台入口：只做接线。
//
// 控制器在 assets/js/app/*（数据状态、动作、浮层、刷新循环、视图、配置浮层……），面板渲染在
// assets/js/render/*。控制器一律 createX({ 依赖 }) 工厂创建、依赖显式传入，模块在 import 时
// 不碰 DOM（Node 可测）。控制器之间的回调用箭头函数延迟绑定：启动（bootstrap）之前
// 不会有任何回调被调用，所以声明先后不构成依赖。

import { configure, deleteJson, eventsUrl, fetchApi, getConfig, getJson, getStatus, patchJson, postAction, postJson } from "./assets/js/api.js";
import { createErrorReporter } from "./assets/js/error-reporter.js";
import { createActions, reportApiError, withErrorToast } from "./assets/js/app/actions.js";
import { createCliController } from "./assets/js/app/cli-controller.js";
import { createCliLoginDialog } from "./assets/js/app/cli-login-dialog.js";
import { createCodexAppServerRestart } from "./assets/js/app/codex-app-server.js";
import { createDaemonsController } from "./assets/js/app/daemons-controller.js";
import { createDiagnosticsExport } from "./assets/js/app/diagnostics-export.js";
import { createDialogs } from "./assets/js/app/dialogs.js";
import { createDirUsageController } from "./assets/js/app/dir-usage-controller.js";
import { createStorageAdminController } from "./assets/js/app/storage-admin-controller.js";
import { createGpuCardController } from "./assets/js/app/gpu-card-controller.js";
import { createIncidentsController } from "./assets/js/app/incidents-controller.js";
import { createReportController } from "./assets/js/app/report-controller.js";
import { createJobNotificationsController } from "./assets/js/app/job-notifications-controller.js";
import { createOnboardingGuideUi } from "./assets/js/app/onboarding-guide.js";
import { createJobNavigation } from "./assets/js/app/job-navigation.js";
import { createRefreshLoop } from "./assets/js/app/refresh-loop.js";
import { createPanelVisibility } from "./assets/js/app/panels.js";
import { createOverallWriter, createRenderPipeline } from "./assets/js/app/render-pipeline.js";
import { createServerActions } from "./assets/js/app/server-actions.js";
import { createServerSwitch } from "./assets/js/app/server-switch.js";
import { initSession } from "./assets/js/app/session.js";
import { createSettingsAccess } from "./assets/js/app/settings-access.js";
import { createSettingsCli } from "./assets/js/app/settings-cli.js";
import { createSettingsDialog } from "./assets/js/app/settings-dialog.js";
import { createSettingsModules } from "./assets/js/app/settings-modules.js";
import { createSettingsAutostart } from "./assets/js/app/settings-autostart.js";
import { createSettingsBackup } from "./assets/js/app/settings-backup.js";
import { createSidebar } from "./assets/js/app/sidebar.js";
import { createHoldGroup, createSkeletons } from "./assets/js/app/skeleton.js";
import { createBriefController } from "./assets/js/app/brief-controller.js";
import { createChainTrafficController } from "./assets/js/app/chain-traffic-controller.js";
import { createTunnelStabilityController } from "./assets/js/app/tunnel-stability-controller.js";
import { createUsageController } from "./assets/js/app/usage-controller.js";
import { createAppState } from "./assets/js/app/state.js";
import { createViewTabs } from "./assets/js/app/view-tabs.js";
import { createBootstrapPanel } from "./assets/js/bootstrap-panel.js";
import { initTrendRange, resetCharts, seedFromMetrics } from "./assets/js/charts.js";
import { createCommandPalette } from "./assets/js/command-palette.js";
import { serverShortName } from "./assets/js/display-names.js";
import { canScopedRestart } from "./assets/js/connection-target.js";
import { copyText } from "./assets/js/dom-utils.js";
import { createLogsPanel } from "./assets/js/logs-panel.js";
import { createMotion } from "./assets/js/motion.js";
import { initAttentionQueue, setAttentionIncidents } from "./assets/js/render/attention.js";
import { initChain, setChainStability, setChainTraffic, setChainTrips } from "./assets/js/render/chain.js";
import { renderAlertBanner } from "./assets/js/render/checklist.js";
import { focusClusterJob, initClusterPanel, refreshClusterWatches, showClusterHistory } from "./assets/js/render/cluster-panel.js";
import { initChangelog, initTimelineHistory, refreshTimeline, refreshTimelineDays } from "./assets/js/render/diagnostics.js";
import { createLogStream } from "./assets/js/render/log-stream.js";
import { renderServerBriefs, setAgentCliPayload, setCliManageHandler } from "./assets/js/render/overview.js";
import { createSkinTransition } from "./assets/js/render/skin-transition.js";
import { handleRunbookLog, initRepairRunbook, requestRepair, requestScopedRestart, requestTunnelTakeover } from "./assets/js/render/repair-runbook.js";
import { initUpdateBanner } from "./assets/js/render/update-banner.js";
import { createRenderGate, initConsoleVisibility, isConsoleHidden, onVisibilityChange } from "./assets/js/render/visibility.js";
import { initServerRegistryUi } from "./assets/js/server-cards.js";
import { createThemeController, THEME_LABELS, SKIN_LABELS } from "./assets/js/theme.js";
import { showToast } from "./assets/js/toast.js";
import { modKeyLabel } from "./assets/js/ui-labels.js";

const doc = document;
// 页面脚本错误上报（v2.64，error-reporter.js）：尽早挂上；拿到令牌前出的错先攒着，initSession 之后补报。
// 失败不重试、不提示（fetchApi 不对非 2xx 抛错，网络错误在 reporter 里吞掉）。
const errorReporter = createErrorReporter({
  send: (payload) => fetchApi("/api/diagnostics/client-error", { method: "POST", body: JSON.stringify(payload), timeoutMs: 5000 }),
});
errorReporter.install(window);
// macOS 桌面壳（hiddenInset 标题栏）：红绿灯落在侧栏顶部的拖拽区、页头条可拖动（shell.css [data-shell]）。在模块顶层尽早设置，减少首帧位移。
if (window.electronAPI?.platform === "darwin") doc.documentElement.dataset.shell = "mac-desktop";
const byId = (id) => doc.getElementById(id);
// 破坏性动作的确认闸：每次调用时才读 window.confirm（冒烟测试会运行时替换它）；
// 环境没有 confirm 时视为同意，与此前各处 typeof 判断一致。
const confirmed = (text) => typeof window.confirm !== "function" || window.confirm(text);
const setStale = (stale) => doc.body.classList.toggle("data-stale", stale);

initConsoleVisibility();
const state = createAppState();
const logsPanel = createLogsPanel({
  logEl: byId("log"), logBox: byId("logBox"), sourceSelect: byId("logSourceFilter"), levelSelect: byId("logLevelFilter"),
  searchInput: byId("logSearchInput"), rangeSelect: byId("logRangeSelect"),
  summaryEl: byId("logSummary"), exportBtn: byId("exportLogBtn"), opFilterChip: byId("logOpFilterChip"),
});
const logStream = createLogStream({ streamEl: byId("logStream") });
const bootstrapPanel = createBootstrapPanel({ listEl: byId("bootstrapList") });
const dialogs = createDialogs({ doc, logsPanel });
const reports = createReportController({ doc, getJson, getStatus: state.getStatus, toast: showToast, confirm: confirmed });
// 资源与负载面板「查看我的目录占用」：只在用户点击时扫描（app/dir-usage-controller.js）。
const dirUsage = createDirUsageController({ doc, getJson, postJson, showToast, getConfig: state.getConfig });
// GPU 逐卡详情：点服务器页 GPU 行的卡号/整行打开（app/gpu-card-controller.js）。
// 数据就地取自当前资源层的快照，不发请求；浮层开着时随每轮状态刷新就地重渲。
const gpuCard = createGpuCardController({ doc, getStatus: state.getStatus, openDialog: dialogs.openDialog });
const setOverall = createOverallWriter(doc);
const reportError = (err, kind) => reportApiError(err, kind, { setStale, setOverall, renderAlertBanner, showToast });

const refreshLoop = createRefreshLoop({
  loadStatus: getStatus, render, getStatus: state.getStatus, reportError, setStale,
  fetchIncidents: () => incidents.fetch(),
  logsPanel, logStream, handleRunbookLog, eventsUrl, pollSelect: byId("refreshSelect"),
  isHidden: isConsoleHidden, onVisibilityChange, flushRender: () => renderGate.flush(),
});
const refresh = (options) => refreshLoop.refresh(options);

// 入场动效（motion.js）与加载骨架（app/skeleton.js）：骨架退场时，这块的图表与数字播一次入场；
// 还没进过的页，等第一次进入时再播（viewTabs onEnter → motion.playView）。
const motion = createMotion({ doc });
// 同一轮里撤掉骨架的几块攒到微任务里一起播入场：骨架逐块撤（写），这里统一量可见性、采集几何（读），最后一起启动（写），
// 不再每撤一块就强制重排一次（用量页一次撤 5 块时原来要重排 5 次）。
const revealedHosts = [];
const skeletons = createSkeletons({
  doc,
  onReveal: (host) => {
    revealedHosts.push(host);
    if (revealedHosts.length === 1) {
      queueMicrotask(() => {
        const hosts = revealedHosts.splice(0).filter((h) => h.getClientRects().length);
        if (hosts.length) motion.playEntrances(hosts);
      });
    }
  },
});
// 切换查看的服务器：不再盖全屏遮罩——跟这台服务器有关的面板回到骨架，直到新状态渲染完；服务器卡片区给出「正在切换」。
// 切 Agent 只换诊断视角，不动资源与集群面板。连点两台服务器时，先发、被丢弃的那次结束不撤骨架（createHoldGroup 计数）。
const serverSwitchHold = createHoldGroup(skeletons, ["resources", "cluster"], {
  onBusy: (busy) => doc.body.classList.toggle("is-switching-server", busy),
});
const switchPending = {
  show: (kind) => {
    if (kind === "server") serverSwitchHold.begin();
  },
  hide: (kind) => {
    if (kind === "server") serverSwitchHold.end();
  },
};
const serverSwitch = createServerSwitch({
  doc, state, getConfig, getStatus, postJson, render, showToast, logsPanel,
  pending: switchPending,
  renderServerBriefs: (...args) => {
    if (!doc.documentElement?.dataset?.bootView && viewTabs.isViewVisible("overview") && !panels.isHidden("overview.serverBriefs")) {
      renderServerBriefs(...args);
    }
  },
  resetCharts, seedFromMetrics,
});
const viewTabs = createViewTabs({ doc });
// 侧边栏：开合 / 窄窗浮层 / 细栏提示 / ⌘\；页头条的页名与「查看中的服务器」（app/sidebar.js）。
const sidebar = createSidebar({ doc, modKey: modKeyLabel() });
const incidents = createIncidentsController({
  doc, getJson, postJson, showToast, isViewVisible: viewTabs.isViewVisible, openLogsForOperation: dialogs.openLogsForOperation,
  onOpenIncidents: (open) => {
    setAttentionIncidents(open?.incidents);
    galaxyStage.updateEvents(open);
  },
  getStatus: state.getStatus, // 事件标题 / 服务器用界面上的名字（display-names.js）
  // 事件卡片上的建议处置：复用修复 runbook（预览确认 → 执行 → 进度条目），处置结果由后端记在事件上
  onRemedy: (action, serverId) => (action === "restart-tunnel" && serverId ? requestScopedRestart(serverId) : requestRepair()),
  canScopedRestart: () => canScopedRestart(state.getStatus()),
  copyText,
});
// Agent 用量视图：只在该视图可见时轮询 /api/usage/*（app/usage-controller.js）。
const usage = createUsageController({
  doc, win: window, getJson, postJson, showToast, isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden, onVisibilityChange,
});
// 团队管理视图：仅对管理员可见，在该视图可见时轮询 /api/team/overview（app/team-admin-controller.js）。
let teamAdminController = null;
let teamAdminPromise = null;
let teamAdminBound = false;
function bindTeamAdminOnce() {
  if (teamAdminController && teamAdminBound === false) {
    teamAdminBound = true;
    teamAdminController.bind();
  }
}
function loadTeamAdmin() {
  if (teamAdminPromise) return teamAdminPromise;
  teamAdminPromise = import("./assets/js/app/team-admin-controller.js")
    .then(({ createTeamAdminController }) => {
      teamAdminController = createTeamAdminController({
        doc, getJson, postJson, showToast, confirm: confirmed, copyText,
        openDialog: dialogs.openDialog, isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden, onVisibilityChange,
      });
      const current = state.getStatus();
      if (current) teamAdminController.onStatus(current);
      bindTeamAdminOnce();
      return teamAdminController;
    })
    .catch((err) => {
      teamAdminPromise = null;
      console.error("团队管理模块加载失败:", err?.message || err);
      return null;
    });
  return teamAdminPromise;
}
const teamAdmin = {
  onStatus(status) {
    // 团队模块按需加载：管理员不代表此刻在看团队页。只有团队页可见时才拉模块并建团队星图，
    // 否则仅由 syncHiddenViews / rememberTeamAdmin 维护入口显隐，避免每次启动都解析/执行 180KB。
    if (status?.teamAdmin?.isAdmin) {
      if (viewTabs.isViewVisible("team")) loadTeamAdmin().then((c) => c?.onStatus(status));
    } else {
      teamAdminController?.onStatus(status);
    }
  },
  bind() {
    if (teamAdminController) bindTeamAdminOnce();
  },
  enter() {
    // viewTabs 已把 team 设为可见，loadTeamAdmin 内部用最新 state 调 onStatus + bind，
    // 再 enter 启动轮询/星图，首开不会空白。
    loadTeamAdmin().then((c) => c?.enter());
  },
  leave() {
    teamAdminController?.leave();
  },
};

// 概览链路面板底部「隧道稳定性」：只在概览可见时轮询 /api/tunnel-stability（app/tunnel-stability-controller.js）；
// 拿到的统计顺带送给链路面板（节点详情里的断线统计）。
const tunnelStability = createTunnelStabilityController({
  doc, getJson, isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden, onVisibilityChange,
  onStability: setChainStability, isPanelHidden: () => panels.isHidden("overview.stability"),
});
// 数据链路的去向与近一分钟流量（/api/egress/usage）、端到端往返历史（环境校验）：只在概览可见时轮询
//（app/chain-traffic-controller.js），拿到的数据送给链路面板。
const chainTraffic = createChainTrafficController({
  getJson, isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden, onVisibilityChange,
  getActiveServerId: () => state.getStatus()?.activeServerId || null,
  onUsage: setChainTraffic, onTrips: setChainTrips,
});
// 概览「今日简报」：只在概览可见时轮询（app/brief-controller.js）。
// 跳转：指标格 / 留意项 → 对应视图或浮层；「隧道稳定性」就在概览链路面板底部，滚过去即可。
function gotoFromBrief(link) {
  if (link === "doctor") return dialogs.openDialog("dlgDoctor");
  if (link === "events" || link === "usage") return viewTabs.switchView(link);
  if (link === "stability") {
    viewTabs.switchView("overview");
    requestAnimationFrame(() => byId("chainUptime")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    return;
  }
  viewTabs.switchView("servers");
  if (link === "cluster-history") showClusterHistory();
  const target = link === "cluster" || link === "cluster-history" ? byId("clusterPanel") : doc.querySelector(".panel-servers");
  requestAnimationFrame(() => target?.scrollIntoView({ behavior: "smooth", block: "start" }));
}
// 服务器页「远端守护进程」：只在服务器页可见、面板没被隐藏时轮询 /api/daemons；启动先行内确认（app/daemons-controller.js）。
const daemons = createDaemonsController({
  doc, getJson, postJson, showToast, getConfig: state.getConfig,
  isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden, onVisibilityChange,
  isPanelHidden: () => panels.isHidden("servers.daemons"),
});
// 「存储管理」页（侧栏，仅管理员）：进入该页或服务器页时读本机概览（服务器页磁盘卡片里有它的入口摘要），
// 扫描在跑时每 5 秒重读（app/storage-admin-controller.js）。
const storageAdmin = createStorageAdminController({
  doc, getJson, postJson, showToast, copyText,
  isViewVisible: viewTabs.isViewVisible, isHidden: isConsoleHidden,
  onOpen: () => viewTabs.switchView("storage"),
  playEntrance: (el) => motion.playEntrance(el, { force: true }),
});
// Codex 详情里的「重启守护进程…」（v2.85）：只在用户确认后 POST，成功后补拉状态等 doctor 读回新端口。
const codexAppServer = createCodexAppServerRestart({
  doc, postJson, showToast, confirm: confirmed, refresh,
  getActiveServerId: () => state.activeServerId(),
});
codexAppServer.init();
// Agent 卡片的官方 CLI 版本 / 登录方式 / 「可更新到 x」：低频拉 /api/cli，接口未就绪时安静降级（app/cli-controller.js）。
const cliInfo = createCliController({ getJson, isHidden: isConsoleHidden, onVisibilityChange, onCli: setAgentCliPayload });
const brief = createBriefController({
  doc, getJson, isViewVisible: (view) => viewTabs.isViewVisible(view) && !panels.isHidden("overview.brief"),
  isHidden: isConsoleHidden, onVisibilityChange, onNavigate: gotoFromBrief,
});
// 界面面板显隐（app/panels.js）：status.hiddenPanels ∪ 模块联动，每次渲染前应用；
// 带轮询的面板隐藏即 leave()、重新显示且所在视图可见即 enter()；整页隐藏交给 view-tabs。
let latestPanelHiddenViews = [];
// 记住这台机器上一次是不是团队管理员：sidebar-boot.js 首帧前据此留出「团队管理」入口（键名与它一致）。
const TEAM_ADMIN_FLAG_KEY = "consoleTeamAdmin";
function rememberTeamAdmin(status) {
  if (!status) return; // 首包状态之前不动（不然入口会先藏后显）
  const admin = Boolean(status.teamAdmin?.isAdmin);
  if (admin) doc.documentElement.dataset.teamAdmin = "1";
  else delete doc.documentElement.dataset.teamAdmin;
  try {
    if (admin) localStorage.setItem(TEAM_ADMIN_FLAG_KEY, "1");
    else localStorage.removeItem(TEAM_ADMIN_FLAG_KEY);
  } catch {}
}
function syncHiddenViews(status = state.getStatus(), panelViews = latestPanelHiddenViews) {
  latestPanelHiddenViews = Array.isArray(panelViews) ? panelViews : [];
  rememberTeamAdmin(status);
  const next = status?.teamAdmin?.isAdmin
    ? latestPanelHiddenViews
    : [...new Set([...latestPanelHiddenViews, "team", "storage"])];
  viewTabs.setHiddenViews(next);
}
const panels = createPanelVisibility({
  doc, controllers: { "overview.chain": chainTraffic, "overview.brief": brief, "overview.stability": tunnelStability, "servers.daemons": daemons },
  isViewVisible: (view) => viewTabs.isViewVisible(view),
  onViewsChanged: (views) => syncHiddenViews(state.getStatus(), views),
});
const navigateJob = createJobNavigation({ state, serverSwitch, viewTabs, panels, refresh, refreshWatches: refreshClusterWatches, focusJob: focusClusterJob, openInbox: () => jobNotifications.open(), toast: showToast });
const jobNotifications = createJobNotificationsController({ doc, getJson, postJson, showToast, nativeDelivery: Boolean(window.electronAPI), onNavigate: navigateJob });
const serverActions = createServerActions({
  state, showToast, confirm: confirmed, getJson, postJson,
  loadServers: serverSwitch.loadServers, refresh, requestScopedRestart,
});
const settings = createSettingsDialog({
  doc, win: window, state, getJson, postJson, patchJson, deleteJson, showToast, confirm: confirmed, isHidden: isConsoleHidden,
  initRegistryUi: initServerRegistryUi, getClientVersion: () => loadedClientVersion,
  loadServers: serverSwitch.loadServers, refresh, fetchIncidents: (options) => incidents.fetch(options),
});
function openAddConnection() {
  doc.getElementById("dlgOnboarding")?.close();
  dialogs.openDialog("dlgSettings");
  settings.registry.beginAdd?.();
}
doc.getElementById("connectionAddBtn")?.addEventListener("click", openAddConnection);
doc.getElementById("onboardingAddConnection")?.addEventListener("click", openAddConnection);
// 配置浮层「监控模块」「界面面板」两段（app/settings-modules.js）。面板勾选先乐观应用：
// 用改过 hiddenPanels 的状态重渲一次。两种保存成功后都立即全量刷新（关掉 Agent 不是级别变化，后端不推 SSE），
// Agent 状态带 / 诊断入口 / 用量页 / 简报格随之对齐。
const settingsModules = createSettingsModules({
  doc, getJson, postJson, showToast, getStatus: state.getStatus,
  // 简报格随用量 / 作业模块增减：顺带重拉一次简报，不等 60 秒一轮。
  onModulesChanged: () => Promise.all([refresh({ force: true }), brief.refresh().catch(() => {}), jobNotifications.refresh()]),
  onPanelsSaved: () => refresh({ force: true }),
  onHiddenPanels: (hiddenPanels) => {
    const status = state.getStatus();
    if (status) render({ ...status, hiddenPanels });
  },
});
// 配置浮层「版本与更新」面板头的「导出诊断包…」（app/diagnostics-export.js，v2.64）：就地展开说明，确认后导出。
const diagnosticsExport = createDiagnosticsExport({ doc, getJson, showToast, electronAPI: window.electronAPI || null });
// 配置浮层「启动」（app/settings-autostart.js，v2.62）：登录电脑后自动启动。打包的 App 的登录项经桌面壳的 electronAPI 读写。
const settingsAutostart = createSettingsAutostart({ doc, getJson, postJson, showToast, electronAPI: window.electronAPI || null });
// 配置浮层「命令行工具」（app/settings-cli.js，v2.57）：集群上 codex / Claude Code 的安装、更新与回滚。
// 安装 / 登录结束：卡片立即重拉一次 /api/cli，15 秒后再拉一次（后端补跑的探测 / doctor 那时已落地）。
const refreshCliInfoSoon = (job) => {
  cliInfo.refresh();
  onboardingGuide.onCliChanged(job);
  setTimeout(() => cliInfo.refresh(), 15000);
};
const settingsCli = createSettingsCli({ doc, getJson, postJson, showToast, openDialog: dialogs.openDialog, onCliChanged: refreshCliInfoSoon });
// Agent 卡片的「可更新到 x」chip 与详情里的「安装…」直达这一节的同一个确认（不另造更新入口）。
setCliManageHandler(settingsCli.openFor);
// 接入引导（app/onboarding-guide.js）：还没配置好时自动弹出；走完后的「安装命令行工具」是上面那一节的第二个宿主。
const onboardingGuide = createOnboardingGuideUi({
  doc, getJson, postJson, showToast, copyText, refresh,
  cliSection: createSettingsCli({
    doc, getJson, postJson, showToast, onCliChanged: refreshCliInfoSoon,
    bodyId: "onboardingCliBody", dialogId: "dlgOnboarding", sectionId: "onboardingNext",
    getServerId: () => onboardingGuide.getState().guide?.server?.id,
    onOverview: (data) => onboardingGuide.onCliOverview(data),
    onJobChange: (job) => onboardingGuide?.onCliJob(job),
  }),
});
// 配置浮层「接入引导」那一行下面（app/settings-access.js）：名下的端口登记、释放闲置端口、撤销接入。
const settingsAccess = createSettingsAccess({ doc, getJson, postJson, showToast, copyText, refresh });
// 配置浮层「备份与迁移」（app/settings-backup.js，v2.64）：导出 / 导入个人配置与本机偏好。桌面窗口里导出走系统保存对话框。
// 导入写完后：服务器列表、模块 / 面板、作业提醒各自重读；个人配置 JSON 编辑器随状态里的版本号自己跟上。
const settingsBackup = createSettingsBackup({
  doc, getJson, postJson, showToast, electronAPI: window.electronAPI || null,
  onImported: async () => {
    await serverSwitch.loadServers();
    await Promise.all([refresh({ force: true }), settingsModules.onOpen(), jobNotifications.refresh(), Promise.resolve(settings.registry.refresh()).catch(() => {})]);
  },
});
const actions = createActions({
  doc, postAction, postJson, render, refresh, logsPanel, showToast, confirm: confirmed, copyText, reportError, setOverall,
  requestRepair, openDialog: dialogs.openDialog, reassignPort: serverActions.reassignPort,
  confirmHostKey: (serverId) => settings.registry.confirmHostKey(serverId),
  getStatus: state.getStatus, activeServerId: state.activeServerId,
  openOnboardingGuide: () => onboardingGuide.open(),
});

// 浮层打开时各自补拉数据（按登记顺序执行）。
dialogs.onDialogOpen("dlgTimeline", () => {
  refreshTimeline();
  refreshTimelineDays(); // 复盘日期下拉只在打开浮层时刷新一次
});
dialogs.onDialogOpen("dlgSettings", settings.onOpen);
dialogs.onDialogOpen("dlgSettings", settingsModules.onOpen);
dialogs.onDialogOpen("dlgSettings", settingsAutostart.onOpen);
dialogs.onDialogOpen("dlgSettings", settingsCli.onOpen);
dialogs.onDialogOpen("dlgSettings", settingsAccess.onOpen);
dialogs.onDialogOpen("dlgSettings", settingsBackup.onOpen);
dialogs.onDialogOpen("dlgLogs", () => logsPanel.refresh());
// 离线安装面板不在启动时预取：打开时才拉取并建行。
dialogs.onDialogOpen("dlgBootstrap", () => bootstrapPanel.refresh());
const rerender = () => {
  const status = state.getStatus();
  if (status) render(status);
};
dialogs.onDialogOpen("dlgEndpoint", rerender);
dialogs.onDialogOpen("dlgDoctor", rerender);
dialogs.initDialogChrome();
// 集群 CLI 登录（v2.57，app/cli-login-dialog.js）：Agent 详情里的「登录」经 [data-cli-login] 整页委托打开。
const cliLogin = createCliLoginDialog({
  doc, getJson, postJson, showToast, copyText, openDialog: dialogs.openDialog,
  getActiveServerId: () => state.activeServerId(),
  onCliChanged: refreshCliInfoSoon,
});
cliLogin.init();
onboardingGuide.init();
actions.bindControls();
serverSwitch.bindSwitchers();

// 外观与视觉版本切换及持久化（简洁版 classic / 星空版 starry / 纸面天台版 paper；逻辑在 theme.js 与 galaxy-stage.js）。
// 入口只在「配置」里；在那里切换时播放换肤过场（render/skin-transition.js），幕布盖住页面那一刻才真正换皮肤。
const themeButtons = [...doc.querySelectorAll("#themeSegmented [data-theme-pref]")];
const skinButtons = [...doc.querySelectorAll("#settingsSkinSegmented [data-skin-mode]")];
const skinTransition = createSkinTransition({ doc, win: window });

let galaxyStageController = null;
let galaxyStagePromise = null;
let galaxyStageSkin = null;
let galaxyEventsArgs = null;
let galaxyStatusArg = null;
const isGalaxySkin = (skin) => skin === "starry" || skin === "paper";
function loadGalaxyStage(initialSkin) {
  if (galaxyStagePromise) return galaxyStagePromise;
  galaxyStagePromise = import("./assets/js/render/galaxy-stage.js")
    .then(({ createGalaxyStageController }) => {
      const controller = createGalaxyStageController({
        doc,
        win: window,
        onAcknowledgeIncident: (incidentId) => incidents.setAttention(incidentId, "acknowledge"),
      });
      galaxyStageSkin = initialSkin || galaxyStageSkin || "starry";
      controller.init(galaxyStageSkin);
      galaxyStageController = controller;
      if (galaxyStatusArg) controller.updateStatus?.(galaxyStatusArg);
      if (galaxyEventsArgs) controller.updateEvents(galaxyEventsArgs[0]);
      return controller;
    })
    .catch((err) => {
      galaxyStagePromise = null;
      console.error("天体观测模块加载失败:", err?.message || err);
      return null;
    });
  return galaxyStagePromise;
}
const galaxyStage = {
  init(skin) {
    if (isGalaxySkin(skin)) loadGalaxyStage(skin);
  },
  applySkin(skin, prevSkin) {
    const shouldLoad = isGalaxySkin(skin) || Boolean(galaxyStagePromise);
    if (shouldLoad) {
      loadGalaxyStage(skin).then((controller) => {
        if (controller) {
          if (galaxyStageSkin === skin) return;
          controller.applySkin(skin, prevSkin);
          galaxyStageSkin = skin;
        }
      });
    }
  },
  updateStatus(status) {
    galaxyStatusArg = status;
    galaxyStageController?.updateStatus?.(status);
  },
  updateEvents(open) {
    galaxyEventsArgs = [open];
    galaxyStageController?.updateEvents(open);
  },
};


const themeController = createThemeController({
  onApplied: ({ skin, prevSkin }) => {
    for (const btn of themeButtons) btn.setAttribute("aria-pressed", String(btn.dataset.themePref === themeController.getPref()));
    for (const btn of skinButtons) {
      const active = btn.dataset.skinMode === skin;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", String(active));
    }
    galaxyStage.applySkin(skin, prevSkin);
  },
});

const cmdPalette = createCommandPalette({
  dialogEl: byId("dlgCommandPalette"), inputEl: byId("cmdInput"), listEl: byId("cmdList"),
  // "refresh" 不是后端动作（没有 /api/refresh），走本地全量刷新；返回值供面板决定是否提示成功。
  onAction: (act) => (act === "refresh"
    ? refresh({ force: true }).then(() => !doc.body.classList.contains("data-stale"))
    : actions.action(act)),
  // T04a：面板里的 restart 与控制面板/粘性条同一条 runbook 预览流程。
  onRepair: () => requestRepair(),
  // T04b：单隧道重启（仅运行快照声明能力时显示）。
  onScopedRestart: (serverId) => requestScopedRestart(serverId),
  onSwitchServer: (sid) => serverSwitch.switchActiveServer(sid),
  onSwitchAgent: (aid) => serverSwitch.switchActiveAgent(aid),
  onOpenDialog: (did) => dialogs.openDialog(did),
  onSetTheme: (th) => themeController.set(th),
  onTeamCommand: (cmd) => {
    if (cmd === "storage-view") {
      viewTabs.switchView("storage");
      return;
    }
    viewTabs.switchView("team");
    loadTeamAdmin().then((c) => {
      if (!c) return;
      if (cmd === "add-member") c.openAddMember?.();
      else if (cmd === "batch-assign") c.openBatchAssign?.();
      else if (cmd === "notice") c.openNotice?.();
      else if (cmd === "root-guide") c.openRootGuide?.();
      else if (cmd === "sync") c.syncNow?.();
    });
  },
  getStatus: state.getStatus,
  getConfig: state.getConfig,
});
const cmdPaletteBtn = byId("cmdPaletteBtn");
cmdPaletteBtn?.addEventListener("click", () => cmdPalette.open());
// ⌘K 徽标按客户端平台显示（非 Apple 键盘显示 Ctrl+K）。
const cmdKbd = cmdPaletteBtn?.querySelector(".cmd-kbd-badge");
if (cmdKbd) cmdKbd.textContent = `${modKeyLabel()}K`;

const pipeline = createRenderPipeline({
  doc, getConfig: state.getConfig, setOverall, isPanelOpen: dialogs.isPanelOpen, isViewVisible: viewTabs.isViewVisible,
  isPanelHidden: (id) => panels.isHidden(id),
  onSettingsStatus: (status) => {
    settings.onStatus(status);
    settingsModules.onStatus();
  },
  onControlStatus: actions.onStatus,
});
// 渲染闸门：可见时直通 renderDom；隐藏时只缓存最新 status（恢复可见时 refresh-loop 冲刷）。
const renderGate = createRenderGate({ isHidden: isConsoleHidden, render: (status) => pipeline.renderDom(status) });

// 本次页面**实际加载到**的前端版本：首次拿到 /api/status 时的 version。
// 必须来自页面加载时真正的数据，绝不能是写死的字面量——此前设置页「版本与更新」
// 写死过 "2.25.2"，之后每次发版都没跟着改，"前端已加载"一行长期显示错误版本。更新日志
// 弹窗那条通路（diagnostics.js）取自页面自带的 changelog 首条版本，两条通路必须一致。
// 存的是加载时快照而非每次最新值：覆盖升级后没有刷新的旧页面会一直报旧版本，
// 这正是 reload-ui 想识别的情况。
let loadedClientVersion = "";
function rememberClientVersion(status) {
  if (!loadedClientVersion && status && typeof status.version === "string") loadedClientVersion = status.version;
}

// 渲染入口：数据先行提交——状态始终最新（SSE 增量合并 {...last, ...lite} 与命令面板
// getStatus 都读它，隐藏期也不能停），DOM 渲染经省电闸门。
// 面板显隐在 DOM 渲染之前应用（首帧不闪：隐藏的面板从一开始就不出现、也不被渲染）。
function render(status) {
  rememberClientVersion(status);
  state.setStatus(status);
  sidebar.setCrumb(status?.activeServerId ? serverShortName(status, status.activeServerId) : "");
  panels.apply(status);
  syncHiddenViews(status);
  dirUsage.onStatus(status);
  gpuCard.onStatus(status);
  daemons.onStatus(status);
  storageAdmin.onStatus(status);
  cliInfo.onStatus(status);
  onboardingGuide.onStatus(status);
  teamAdmin.onStatus(status);
  galaxyStage.updateStatus(status);
  renderGate.push(status);
}

async function bootstrap() {
  themeController.init();
  galaxyStage.init(themeController.getSkin());
  sidebar.init();
  skeletons.attachAll();
  motion.bindCrossfade();
  try {
    if (doc.documentElement.dataset.teamAdmin === "1" && localStorage.getItem("consoleView") === "team") {
      loadTeamAdmin().then((c) => c?.warmFromCache?.());
    }
  } catch {}
  for (const btn of themeButtons) {
    btn.addEventListener("click", () => {
      const prevSkin = themeController.getSkin();
      themeController.set(btn.dataset.themePref);
      // 星空版选浅色 / 纸面版选深色会连带换皮肤：同样放一场过场
      const skin = themeController.getSkin();
      if (skin !== prevSkin) skinTransition.play(skin);
      showToast({ type: "info", message: `已应用「${THEME_LABELS[themeController.getPref()] || btn.dataset.themePref}」外观`, title: "外观切换" });
    });
  }
  for (const btn of skinButtons) {
    btn.addEventListener("click", () => {
      const nextSkin = btn.dataset.skinMode;
      if (nextSkin === themeController.getSkin()) return;
      skinTransition.play(nextSkin, {
        onCovered: () => {
          themeController.setSkin(nextSkin);
          showToast({ type: "info", message: `已切换至「${SKIN_LABELS[themeController.getSkin()] || nextSkin}」`, title: "视觉版本" });
        },
      });
    });
  }
  // 侧栏通道状态里的「一键修复」：与 #alertActionBtn 共用同一 runbook 预览流程
  byId("sidebarRepairBtn")?.addEventListener("click", () => requestRepair());
  // 同账号另一台 Mac 在承载、本机待命时出现（render-pipeline 控制显隐）：把查看中服务器的隧道接到这台。
  byId("sidebarTakeoverBtn")?.addEventListener("click", () => {
    const serverId = state.getStatus()?.activeServerId;
    if (serverId) requestTunnelTakeover(serverId);
  });
  // 修复 runbook：确认后带预生成 operationId 执行 restart（SSE 日志按同 id 关联）；失败态
  // "查看本次操作日志"= 按 operationId 过滤 + 打开 dlgLogs。T04b 单隧道重启复用同一
  // runbook：preview 取影响范围 → 确认层 → run 只带 previewId（x-operation-id 预生成，
  // 进度日志按它关联）。非 2xx 先 toast serverMessage 再重新抛出，runbook 据此
  // settle(false)；单隧道重启成功收尾补一次全量刷新。
  initRepairRunbook({
    onExecute: (operationId) => actions.action("restart", { operationId }),
    onViewLogs: dialogs.openLogsForOperation,
    onPreviewScoped: withErrorToast(showToast, "单隧道操作", (serverId, action = "restart-tunnel") => postJson("/api/operations/preview", { action, target: { serverId } })),
    onExecuteScoped: withErrorToast(showToast, "单隧道重启", (previewId, operationId) => postJson("/api/operations/run", { previewId }, { operationId })),
    // 单隧道重启 run 返回 202 后轮询操作结果；单次轮询失败按"尚无结果"处理。
    onPollScoped: (operationId) => getJson(`/api/operations/${encodeURIComponent(operationId)}`).catch(() => null),
    onSettled: (kind, ok) => {
      if (kind === "scoped" && ok) refreshLoop.scheduleRefresh();
    },
  });
  // 链路节点详情里的跳转（稳定性统计 / 资源与负载）与「切到这台查看」。
  initChain({
    onNavigate: gotoFromBrief,
    onSwitchServer: (serverId) => serverSwitch.switchActiveServer(serverId),
    onNeedTrips: () => chainTraffic.ensureTrips(),
    onTakeover: (serverId) => requestTunnelTakeover(serverId),
    // 出网节点 / 去向详情里的「出网设置」、去向不记录时的空状态按钮：打开配置并展开出网一节
    onOpenEgress: () => {
      dialogs.openDialog("dlgSettings");
      requestAnimationFrame(() => {
        const section = byId("settingsEgress");
        if (!section) return;
        section.open = true;
        section.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    },
    onEnableObserve: withErrorToast(showToast, "开启去向统计", async () => {
      await postJson("/api/egress/proxy-auth", { mode: "observe" });
      showToast({ type: "success", message: "已开启「只记录」模式，几秒后开始统计去向与流量", title: "去向统计" });
      setTimeout(() => chainTraffic.refresh?.(), 2600);
    }),
  });
  initAttentionQueue({
    onReassignPort: (serverId) => serverActions.reassignPort(serverId),
    onOpenDialog: dialogs.openDialog,
    onAcknowledgeIncident: (incidentId) => incidents.setAttention(incidentId, "acknowledge"),
  });
  // 集群节点与队列的「立即刷新」：手动跑一次该服务器的 slow 采集（只读 sinfo / squeue），完成后全量对齐。
  // 「我的历史」读 /api/jobs：只在服务器页可见且窗口没被隐藏时轮询（render/cluster-history-loader.js）。
  initClusterPanel({
    onRefresh: withErrorToast(showToast, "刷新集群状态", (serverId) =>
      postJson(`/api/probe/${encodeURIComponent(`collect:slow:${serverId}`)}/run`, {}).then(() => refresh({ force: true }))),
    getJson,
    postJson,
    showToast,
    isVisible: () => viewTabs.isViewVisible("servers") && !isConsoleHidden() && !panels.isHidden("servers.cluster"),
    onVisibilityChange,
  });
  // 资源趋势的范围分段按钮（30 分钟 / 24 小时 / 7 天 / 30 天）：绑定点击并回显记住的选择。
  initTrendRange({ doc });
  await initSession({ doc, electronAPI: window.electronAPI || null, configure, confirm: confirmed });
  errorReporter.markReady();
  // 首包状态与服务器列表并行取：在恢复上次停留的视图之前应用面板显隐——
  // 上次停在已被隐藏的整页（如用量模块已关）时直接落在概览，不先闪进去再跳回。失败无妨，刷新循环会再取。
  await Promise.all([serverSwitch.loadServers(), getStatus().then((status) => {
    render(status);
    refreshLoop.markFresh();
  }).catch(() => {})]);
  usage.bind();
  teamAdmin.bind();
  reports.bind();
  dirUsage.bind();
  gpuCard.bind();
  daemons.bind();
  storageAdmin.bind();
  jobNotifications.bind();
  jobNotifications.start();
  window.electronAPI?.onJobNotification?.(({ serverId, jobId, view }) => navigateJob(serverId, jobId, view));
  window.addEventListener("pagehide", () => jobNotifications.stop());
  tunnelStability.bind();
  chainTraffic.bind();
  brief.bind();
  cliInfo.start();
  let viewTabsBooted = false;
  let rememberShownTimer = 0;
  viewTabs.initViewTabs({
    onEnter: (view) => {
      sidebar.setView(view);
      // 第一次进入这一页：已就绪的块补播入场（之后切回来不重播；还在骨架里的等骨架退场再播）
      requestAnimationFrame(() => motion.playView(byId(`view-${view}`)));
      // 概览的简报 / 隧道稳定性：进入且没被隐藏才轮询，其余情况停表（app/panels.js）。
      panels.enterView(view);
      if ((view === "servers" || (viewTabsBooted && view === "overview")) && !isConsoleHidden()) {
        pipeline.renderView(view, state.getStatus()); // 只补渲当前页在收起期间跳过的面板，不重跑整页全量 render
      }
      if (view === "events") incidents.fetch();
      if (view === "usage") usage.enter();
      else usage.leave();
      if (view === "servers" || view === "storage") storageAdmin.enter(view);
      if (view === "team") teamAdmin.enter();
      else teamAdmin.leave();
      // 内容落定后记下这一页各面板的真实高度，下次启动首帧照它占位（不跳）
      clearTimeout(rememberShownTimer);
      rememberShownTimer = setTimeout(() => skeletons.rememberShown(), 1500);
    },
  });
  viewTabsBooted = true;
  window.addEventListener("pagehide", () => skeletons.rememberShown());
  incidents.bindFilter();
  byId("openChangelogBtn")?.addEventListener("click", () => dialogs.openDialog("changelogModal"));
  diagnosticsExport.bind();
  refreshLoop.start();
  initChangelog();
  initTimelineHistory();
  // 热更新：已安装新版本 → 重启界面（隧道不中断）；后台组件待升级 → 平滑升级。
  initUpdateBanner({
    root: byId("updateBanner"),
    getJson,
    postJson,
    electronAPI: window.electronAPI || null,
    toast: showToast,
  });
}

// 启动半路出错（initSession 之前）时也把攒下的脚本错误补报出去；markReady 只生效一次。
bootstrap().finally(() => errorReporter.markReady());
