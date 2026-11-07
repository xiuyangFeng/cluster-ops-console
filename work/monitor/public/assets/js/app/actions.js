// app/actions.js —— 全局动作（start/restart/stop）、控制按钮接线、横幅按钮分派，
// 以及 API 错误的统一展示（动作失败与状态刷新失败共用一份文案表）。
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../api.js";
import { activeProbeBackoff, setupCommandFor } from "../render/checklist.js";
import { formatClock } from "../store.js";
import { BUTTON_LABELS } from "../ui-labels.js";

// 全局动作的影响范围说明（T04a：所有入口同一套文案，不出现"看起来像局部动作"的全局动作）。
export const ACTION_TITLES = Object.freeze({ start: BUTTON_LABELS.start, restart: BUTTON_LABELS.restart, stop: BUTTON_LABELS.stop });
export const STOP_CONFIRM_TEXT = "停止所有连接：守护进程、本地代理与全部服务器的 SSH 隧道都会停止，集群上的 Agent 将失去网络，且不会自动重启（需再点启动）。确定继续？";
const PRUNE_CONFIRM_TEXT = "将把本地运维数据清理到预算的一半（多余日志分卷、最旧的历史文件、指标采样）。历史记录被删后不可恢复，确定继续？";

// 「启动所有连接」按钮的形态（纯函数）。所有连接都在运行（应运行且健康）时它没有事可做：
// 不再占着主按钮的位置，改成说明状态的禁用按钮；已停止 / 降级 / 中断时它才是主按钮。
const START_TITLE = "启动守护进程、本地代理与全部服务器的 SSH 隧道（所有连接）";
export function startButtonView(status) {
  const running = Boolean(status?.shouldBeRunning) && status?.health === "ready";
  return running
    ? { idle: true, label: "已在运行", title: `所有连接都在运行；需要重建时用「${BUTTON_LABELS.restart}」` }
    : { idle: false, label: BUTTON_LABELS.start, title: START_TITLE };
}

// 操作在飞时一并禁用：sidebarRepairBtn/repairConfirmBtn 从侧栏/预览层触发的二次执行
// 会被 action 的 in-flight 守卫拒绝，runbook 将误收尾为失败。
export const ACTION_BUTTON_IDS = Object.freeze(["startBtn", "restartBtn", "stopBtn", "refreshBtn", "sidebarRepairBtn", "repairConfirmBtn", "alertActionBtn"]);

// 鉴权失败 ≠ 断网：Token 失效（Electron 重启后未刷新页面、直接跑 monitor-server 等），指引明确动作。
export const AUTH_FAILURE_BANNER = Object.freeze({
  title: "监控接口鉴权失败（Token 失效）",
  body: "请求被后端拒绝。请用 npm run start（或双击 start-codex-desktop.command / start-codex-monitor.command）启动，不要直接跑 node work/monitor/monitor-server.mjs。桌面模式请重启 App 以重新注入 Token。",
});

// 纯函数：API 错误 → 总体状态文案 / 横幅 / toast。kind = "action"（用户动作）| "refresh"（状态刷新）。
// 刷新失败不弹 toast（每轮都弹会刷屏），靠横幅与总体状态表达；动作失败两者都给。
export function describeApiError(err, kind = "refresh") {
  const isAction = kind === "action";
  if (err?.status === 401) {
    return {
      text: "鉴权失败",
      banner: AUTH_FAILURE_BANNER,
      toast: isAction ? { type: "error", message: "监控接口鉴权失败，请重新启动控制台", title: "鉴权失败" } : null,
    };
  }
  if (err?.serverMessage) {
    // 后端可达但内部出错（非 2xx 携带 {error}）：展示具体原因，不误导为断网。
    const body = `后台报告错误: ${err.serverMessage}`;
    return isAction
      ? { text: "执行失败", banner: { title: "操作执行失败", body }, toast: { type: "error", message: err.serverMessage, title: "操作失败" } }
      : { text: "系统故障", banner: { title: "监测核心系统故障", body }, toast: null };
  }
  if (isAction) return { text: "执行失败", banner: null, toast: { type: "error", message: err?.message || "请求异常", title: "操作失败" } };
  if (err?.timeout) {
    // 请求超时（api.js 的 AbortSignal.timeout / 刷新队列看门狗）：连接已建立但对方不再响应，
    // 或睡眠唤醒/VPN 切换留下的半开连接。与"完全连不上"分开表述，便于排查。
    return {
      text: "响应超时",
      banner: {
        title: "监控接口响应超时",
        body: `请求超过 ${DEFAULT_REQUEST_TIMEOUT_MS / 1000} 秒未返回。若刚唤醒系统或切换过网络，通常会自动恢复；持续超时请检查后台日志。`,
      },
      toast: null,
    };
  }
  return { text: "通信阻断", banner: null, toast: null };
}

// 把 describeApiError 的结论落到界面：数据标记过期 → 总体状态 → 横幅 → toast。
export function reportApiError(err, kind, { setStale, setOverall, renderAlertBanner, showToast }) {
  const view = describeApiError(err, kind);
  setStale(true);
  setOverall("down", view.text);
  if (view.banner) renderAlertBanner("down", view.banner);
  if (view.toast) showToast(view.toast);
  return view;
}

// 包一层"失败先 toast 服务端原因、再原样抛出"：runbook 靠抛错 settle(false)，toast 由这里统一给。
export function withErrorToast(showToast, title, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      showToast({ type: "error", message: err?.serverMessage || err?.message || "请求异常", title });
      throw err;
    }
  };
}

// POST /api/servers/:id/sync-cluster-env 的结果 → 提示文案。
export function describeClusterEnvSync(result) {
  const port = result?.state?.expectedPort;
  const sync = result?.state?.lastSync;
  switch (result?.status) {
    case "synced": {
      const note = sync?.error ? `（${sync.error}）` : "";
      return { type: sync?.error ? "warn" : "success", message: `已把集群上的代理配置改到端口 ${port}（${(sync?.changed || []).join("、")}）${note}。只对新开的终端生效，已在运行的 codex / claude 需要重开。` };
    }
    case "in-sync": return { type: "info", message: `集群上的代理配置已经指向端口 ${port}，不需要改。` };
    case "absent": return { type: "warn", message: "集群上还没有受管的 env.sh。打开「配置 → 接入引导」走一遍，会把集群侧配置写好。" };
    case "no-port": return { type: "warn", message: "这台服务器还没有反向端口，先领取端口。" };
    default: return { type: "error", message: `同步没有成功：${sync?.error || result?.state?.error || "未知原因"}。集群上的文件没有改动，可以稍后再试。` };
  }
}

// 纯函数：「立即探测」之后的提示。backoff = 探测并刷新状态后查看中的服务器是否仍在退避
// （render/checklist.js activeProbeBackoff）；ran = 这次有没有真的发出探测（探针被门控跳过时为 false）。
export function describeProbeNow({ ran, backoff }) {
  if (!ran) return { type: "info", message: "这台服务器现在没有可发的探测（连接已停止，或它被设为不监控）。" };
  if (!backoff) return { type: "success", message: "服务器已经能连上，探测回到正常节奏。" };
  const when = formatClock(backoff.nextProbeAt, { locale: "zh-CN", hour12: false });
  return { type: "warn", message: `还是连不上。工作台会继续自动重试，下次 ${when}。` };
}

export function createActions({
  doc, postAction, postJson, render, refresh, logsPanel, showToast, confirm, copyText, reportError, setOverall,
  requestRepair, openDialog, reassignPort, confirmHostKey, getStatus, activeServerId,
  // 横幅「开始配置 / 重新接入」：打开接入引导（app/onboarding-guide.js）。
  openOnboardingGuide = null,
}) {
  const getEl = (id) => doc.getElementById(id);
  let inFlight = false;
  let startIdle = false; // 所有连接都在运行：启动按钮没有事可做（见 startButtonView）

  // 按钮可用性只有这一处写：动作在飞时全部禁用；平时只有「已在运行」的启动按钮保持禁用。
  function syncButtons() {
    for (const id of ACTION_BUTTON_IDS) {
      const btn = getEl(id);
      if (btn) btn.disabled = inFlight || (id === "startBtn" && startIdle);
    }
  }

  // 每轮状态渲染时调用（render-pipeline 的 onControlStatus）。
  function onStatus(status) {
    const btn = getEl("startBtn");
    if (!btn) return;
    const view = startButtonView(status);
    startIdle = view.idle;
    btn.classList.toggle("btn-primary", !view.idle);
    btn.classList.toggle("btn-secondary", view.idle);
    if (btn.textContent !== view.label) btn.textContent = view.label;
    if (btn.title !== view.title) btn.title = view.title;
    btn.disabled = inFlight || startIdle;
  }

  // 返回 true/false 表示操作成败（修复 runbook 依赖此收尾判定；其余调用方忽略返回值）。
  async function action(name, { operationId } = {}) {
    if (inFlight) return false;
    // 停止是有破坏性的全局动作：确认层即"预览"，取消无任何副作用（A17）。
    if (name === "stop" && !confirm(STOP_CONFIRM_TEXT)) return false;
    inFlight = true;
    syncButtons();
    setOverall("waiting", "执行中");
    const title = ACTION_TITLES[name] || name;
    showToast({ type: "info", message: `正在执行 [${title}]...`, title: "操作提示" });
    try {
      const res = await postAction(name, { operationId });
      render(res);
      logsPanel.refresh();
      showToast({ type: "success", message: `[${title}] 操作已完成`, title: "操作成功" });
      return true;
    } catch (err) {
      reportError(err, "action");
      console.error(`执行 [${name}] 操作发生错误: ${err?.message}`);
      return false;
    } finally {
      inFlight = false;
      syncButtons();
    }
  }

  async function copySetupCommand() {
    const command = setupCommandFor(getStatus());
    if (await copyText(command, { fallbackMessage: "请复制下面的命令，在项目目录的终端里运行：" })) {
      showToast({ type: "info", message: `已复制「${command}」。请在项目目录的终端里运行它，完成后回到这里点「${BUTTON_LABELS.start}」。`, title: "配置向导" });
    }
  }

  // 横幅「同步到集群」：把集群上的受管 env.sh 改到当前反向端口（后端先备份、原子写；只对新开的终端生效）。
  let clusterEnvSyncing = false;
  async function syncClusterEnv(serverId) {
    if (clusterEnvSyncing || !serverId) return;
    clusterEnvSyncing = true;
    const title = "同步到集群";
    try {
      const result = await postJson(`/api/servers/${encodeURIComponent(serverId)}/sync-cluster-env`, {});
      const view = describeClusterEnvSync(result);
      showToast({ ...view, title, duration: 10000 });
      await refresh({ force: true });
    } catch (err) {
      showToast({ type: "error", message: `同步失败：${err.serverMessage || err.message}`, title });
    } finally {
      clusterEnvSyncing = false;
    }
  }

  // 横幅「立即探测」（探测已放慢时才出现）：手动复核不受退避约束，结果照样喂给退避状态机——连得上即清零。
  // 先探 fast 采集（端口结论在它身上）；查看中的服务器是「只监控」时它不发 SSH（skipped），改探 slow 采集。
  let probing = false;
  async function probeNow(serverId) {
    if (probing) return;
    probing = true;
    const btn = getEl("alertProbeBtn");
    if (btn) btn.disabled = true;
    const title = "立即探测";
    const run = async (probeId) => (await postJson(`/api/probe/${encodeURIComponent(probeId)}/run`, {}))?.result ?? null;
    try {
      let result = await run("log-signals");
      if (result?.level === "skipped" && serverId) result = await run(`collect:slow:${serverId}`);
      await refresh({ force: true });
      const view = describeProbeNow({ ran: Boolean(result) && result.level !== "skipped", backoff: activeProbeBackoff(getStatus()) });
      showToast({ ...view, title });
    } catch (err) {
      showToast({ type: "error", message: `探测没有发出去：${err.serverMessage || err.message}`, title });
    } finally {
      probing = false;
      if (btn) btn.disabled = false;
    }
  }

  // 横幅按钮按 data-banner-action 分派（W5：不再一律一键修复，见 checklist.js BANNER_ACTIONS）。
  // repair 与粘性条一样走 runbook 预览流程；dlgControl/命令面板的 restart 保持直连。
  function handleBannerAction(kind) {
    const activeId = activeServerId();
    switch (kind) {
      case "start": return action("start");
      case "open-guide": return openOnboardingGuide ? openOnboardingGuide() : copySetupCommand();
      case "setup-hint": return copySetupCommand();
      case "open-settings": return openDialog("dlgSettings");
      case "open-egress": {
        openDialog("dlgSettings");
        const section = getEl("settingsEgress");
        if (section) {
          section.open = true;
          section.scrollIntoView?.({ behavior: "smooth", block: "start" });
        }
        return undefined;
      }
      case "doctor": return openDialog("dlgDoctor");
      case "reassign-port": return activeId ? reassignPort(activeId) : undefined;
      case "sync-cluster-env": return syncClusterEnv(activeId);
      case "hostkey":
        openDialog("dlgSettings");
        if (!activeId) return undefined;
        return confirmHostKey(activeId).catch((err) => {
          showToast({ type: "error", message: err.serverMessage || err.message || "主机密钥确认失败", title: BUTTON_LABELS.confirmHostKey });
        });
      case "none": return undefined;
      default: return requestRepair();
    }
  }

  // 本地数据 tile：清理前必须确认——这是有副作用的动作（删日志分卷/历史文件）。
  async function pruneStorage() {
    if (!confirm(PRUNE_CONFIRM_TEXT)) return;
    const btn = getEl("storagePruneBtn");
    if (btn) btn.disabled = true;
    try {
      await postJson("/api/storage/prune", {});
      showToast({ type: "success", message: "本地数据已清理到预算的一半", title: "本地数据" });
      refresh();
    } catch (err) {
      showToast({ type: "error", message: `清理失败: ${err.serverMessage || err.message}`, title: "本地数据" });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 全局动作的三个入口语义统一（T04a）。start：直接启动（无破坏性）。restart：与横幅/粘性条
  // 一样走 runbook 预览——确认层列明"影响所有连接"的修复序列，取消无副作用。stop：弹影响范围确认后执行。
  function bindControls() {
    getEl("startBtn")?.addEventListener("click", () => action("start"));
    getEl("restartBtn")?.addEventListener("click", () => requestRepair());
    getEl("stopBtn")?.addEventListener("click", () => action("stop"));
    getEl("refreshBtn")?.addEventListener("click", () => refresh());
    getEl("clearLogBtn")?.addEventListener("click", () => {
      logsPanel.clear();
      showToast({ type: "info", message: "历史日志视图已清空", title: "日志控制" });
    });
    const banner = getEl("alertActionBtn");
    banner?.addEventListener("click", () => handleBannerAction(banner.dataset.bannerAction || "repair"));
    getEl("alertProbeBtn")?.addEventListener("click", () => probeNow(activeServerId()));
    getEl("storagePruneBtn")?.addEventListener("click", pruneStorage);
  }

  return { action, bindControls, handleBannerAction, onStatus, probeNow };
}
