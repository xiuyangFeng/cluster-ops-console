// app/render-pipeline.js —— 一次状态渲染要刷新的全部面板（纯 DOM 侧）。
//
// 调用链：app.js render(status) 先提交数据（state + 首次版本记录），再经省电渲染闸门
// （render/visibility.js，隐藏时只缓存最新 status）调到这里的 renderDom。
// 后端错误不以 {error} 载荷进入此处——fetchJson 对非 2xx 抛错，由刷新/动作的错误分支
// （actions.js reportApiError）负责展示。
import { seedFromMetrics } from "../charts.js";
import { createElementLookup } from "../dom-utils.js";
import { renderAttentionQueue } from "../render/attention.js";
import { renderChain } from "../render/chain.js";
import { activeProbeBackoff } from "../render/checklist.js";
import { renderClusterPanel, setClusterJobsModule } from "../render/cluster-panel.js";
import { formatDoctorOutput, refreshTimeline } from "../render/diagnostics.js";
import { createEndpointPanel } from "../render/endpoint-panel.js";
import { renderRemoteLoad } from "../render/load-panel.js";
import { canTakeOver, handoverNote, handoverStandbyOf } from "../render/handover-model.js";
import { getActiveAgentView, hasDoctorAgent, renderAgentOverview, renderServerBriefs, renderStorageTile } from "../render/overview.js";
import { renderSignalBanner } from "../render/signal-banner.js";
import { escapeHtml, formatClock } from "../store.js";
import { moduleEnabled, PANELS } from "./panels.js";

const activeResourceLayer = (status) => (status.layers?.resources ? status.layers.resources[status.activeServerId] : null);

// setup = 还没领反向端口（v2.54）：配置未完成，不是断线——灰色（body[data-health] 无专属色即灰）+「未领取端口」。
const TRANSPORT_LABELS = { connected: "已连接", disconnected: "连接中断", stopped: "已停止", unknown: "待验证", setup: "未领取端口" };
const TRANSPORT_BODY_HEALTH = { connected: "ready", disconnected: "down", stopped: "stopped", unknown: "waiting", setup: "setup" };

// 纯函数：总体状态（body[data-health] + #overall 文案 + 悬停说明）。
// T02：transport 与 Agent 能力分离展示：主标题只描述数据通路，Agent 检查的 attention
// 由概览卡承载。/api/status、status-lite 与全局动作的响应恒带 summary（state-store.statusCore）。
export function resolveOverall(status) {
  const { summary } = status;
  const { state, checkedAt, freshness, reasonCode } = summary.transport;
  const checkedText = checkedAt ? new Date(checkedAt).toLocaleTimeString() : "—";
  return {
    health: TRANSPORT_BODY_HEALTH[state] || "waiting",
    // 另一台 Mac 在承载、本机待命（v2.88）：集群照样连着，侧栏写清楚是「待命」。
    text: reasonCode === "HANDOVER_STANDBY" ? "已连接 · 本机待命" : TRANSPORT_LABELS[state] || "未知",
    title: `transport ${state}（${freshness}，${reasonCode}）· 检查于 ${checkedText} · ${summary.agentCounts.attention} 项 Agent 检查需处理`,
  };
}

// 纯函数：#agentSelect 的 option 集合签名（id:name 拼接）。必须按签名比较而不是只比数量：
// Agent 集合变化但数量不变（换装/改名/一增一减）时，旧的 option 不会被重建，随后
// select.value = activeAgentId 匹配不到而静默保持旧值，而下拉的 change 又用 select.value
// 反调 switchActiveAgent → 用户以为在看 B，实际请求 A。
export function agentOptionsSignature(agents) {
  return (Array.isArray(agents) ? agents : []).map((a) => `${a.id}:${a.name || ""}`).join("|");
}

// #serverSelect 跟随统一渲染入口的最新 activeServerId。下拉框的选项只在 loadServers 时重建，
// 但切换查看视角的入口不止它一个（概览 / 服务器卡、其它窗口、后端回落）：只在 loadServers 里
// 设 value 时，从卡片切到 B 后状态与资源都已是 B、下拉框仍显示 A，再从下拉框选 A 也不会触发 change。
// 目标不在选项里（列表未加载 / 已停用）时不写，避免 select 变成空白。返回是否写入（测试用）。
export function syncServerSelect(select, activeServerId) {
  if (!select || !activeServerId || select.value === activeServerId) return false;
  if (!Array.from(select.options || []).some((option) => option.value === activeServerId)) return false;
  select.value = activeServerId;
  return true;
}

// #overall 的写入口（动作/刷新错误分支与渲染共用）。写前比较：SSE 每轮渲染都会调到
// 此处，而 #overall 是 aria-live="polite"——无条件重写 textContent（即便文案未变）会被
// 读屏当作一次内容变更反复播报，也白白制造 DOM 变更。
export function createOverallWriter(doc) {
  return function setOverall(health, text) {
    const el = doc.getElementById("overall");
    if (el && el.textContent !== text) el.textContent = text;
    if (doc.body.dataset.health !== health) doc.body.dataset.health = health;
  };
}

// 按面板注册表（app/panels.js）的顺序跑各面板的渲染，隐藏的面板整段跳过——不只是 CSS 藏起来。
// renderers：面板 id → (status) => void；返回实际渲染了的面板 id（测试用）。
export function runPanelRenders(renderers, status, isPanelHidden = () => false) {
  const rendered = [];
  for (const panel of PANELS) {
    const fn = renderers[panel.id];
    if (!fn || isPanelHidden(panel.id)) continue;
    fn(status);
    rendered.push(panel.id);
  }
  return rendered;
}

// 没有启用任何 Agent 时 Doctor 浮层的空态文案。
export const NO_AGENT_TEXT = "没有启用的 Agent。可在「配置 → 监控模块」中开启。";

export function createRenderPipeline({
  doc, getConfig, setOverall, isPanelOpen, isViewVisible = () => true, onSettingsStatus, onControlStatus = () => {},
  isPanelHidden = () => false,
}) {
  const getEl = createElementLookup(doc);
  const cache = { doctorOutput: "" };
  // 端点弹层（标题、徽标、结论条、报文、延迟图）整体交给 endpoint-panel：弹层关着时它什么都不做。
  const endpointPanel = createEndpointPanel({ doc, isOpen: () => isPanelOpen("endpointContent") });
  let seededMetrics = false; // 首次拿到 status 后为图表回填历史指标（一次性）
  let lastAgentSignature = null;

  function renderAgentSelect(status) {
    const select = getEl("agentSelect");
    if (!select) return;
    const agents = status.agents || [];
    const signature = agentOptionsSignature(agents);
    if (signature !== lastAgentSignature) {
      lastAgentSignature = signature;
      select.innerHTML = agents.length
        ? agents.map((a) => `<option value="${escapeHtml(a.id)}">${escapeHtml(a.name || a.id)}</option>`).join("")
        : '<option value="">没有启用的 Agent</option>';
      select.disabled = agents.length === 0;
    }
    // 只列启用的 Agent（status.agents 已由后端按监控模块过滤）；全部关闭时 activeAgentId 为空。
    const active = status.activeAgentId || "";
    if (select.value !== active) select.value = active;
  }

  function renderOverall(status) {
    const overall = resolveOverall(status);
    setOverall(overall.health, overall.text);
    getEl("overall")?.setAttribute("title", overall.title);
  }

  function setText(id, text) {
    const el = getEl(id);
    if (el) el.textContent = text;
  }

  // 端点 / Doctor 浮层：重输出只在浮层打开时渲染（openDialog 触发的 render 会补一帧）。
  // agentView 为 null（Agent 全部关闭）时两个浮层都显示空态。
  function renderDiagnostics(status, agentView) {
    // 弹层里可以临时切到别的 Agent 看（不改全局诊断视角）：给它一个「以某个 Agent 为视角」的取数函数
    endpointPanel.render(status, agentView, (agentId) => getActiveAgentView({ ...status, activeAgentId: agentId }));

    const doctorOutput = getEl("doctorOutput");
    if (!doctorOutput || !isPanelOpen("doctorContent")) return;
    if (!agentView) {
      if (cache.doctorOutput !== NO_AGENT_TEXT) {
        doctorOutput.textContent = NO_AGENT_TEXT;
        cache.doctorOutput = NO_AGENT_TEXT;
      }
      return;
    }
    const diagnostic = agentView.diagnostic;
    if (cache.doctorOutput !== diagnostic.output) {
      doctorOutput.innerHTML = formatDoctorOutput(diagnostic.output);
      cache.doctorOutput = diagnostic.output || "";
    }
  }

  // 首帧恢复非概览视图时 html[data-boot-view] 会隐藏 #view-overview：此时概览实际不可见，首包跳过概览重面板渲染。
  const overviewVisible = () => !doc.documentElement?.dataset?.bootView && isViewVisible("overview");
  // 首帧恢复服务器视图（html[data-boot-view="servers"]）或当前处于服务器视图时渲染服务器面板。
  const serversVisible = () => doc.documentElement?.dataset?.bootView === "servers" || isViewVisible("servers");

  // 随面板显隐门控的渲染（app/panels.js 注册表）：隐藏的面板或不在当前可见视图中的面板不渲染，切入视图或重新显示时补渲。
  const panelRenderers = {
    // 服务器卡的徽标/隧道胶囊/GPU 行读 layers.tunnels + layers.resources；source/tunnel
    // 优先取 /api/config 的服务器条目（config 未加载时由隧道层字段回退）。
    "overview.serverBriefs": (status) => {
      if (!overviewVisible()) return;
      renderServerBriefs(status.serversBrief, status.activeServerId, status.layers, getConfig()?.servers, status.probeBackoff?.servers ?? null);
    },
    // T03：新版资源结构（busyPct / 磁盘挂载点 / 配额未知）与整层（GPU、新鲜度）随层透传；旧后端无 usage → null，
    // 负载小条按旧口径渲染。签名键优先取资源层的 checkedAt，层缺失时回落 remoteLoad.output 本体。
    "servers.resources": (status) => {
      if (!serversVisible()) return;
      const layer = activeResourceLayer(status);
      // 探测已放慢时把退避条目附在层上：采样胶囊的悬停说明据此改写节奏（render/resources-model.js）。
      const backoff = activeProbeBackoff(status);
      const resourceLayer = layer && backoff ? { ...layer, backoff } : layer;
      const sampleKey = resourceLayer && resourceLayer.checkedAt != null ? resourceLayer.checkedAt : (status.remoteLoad?.output) || null;
      renderRemoteLoad(status.remoteLoad, status.activeServer || null, sampleKey, resourceLayer?.usage ?? null, resourceLayer);
    },
    // Slurm 节点与队列（作业表可达数百行）：只在服务器页可见时渲染，切到服务器页时补渲一次。
    // 「我的 Slurm 作业」模块关闭时不显示「我的」汇总与「我的历史」。
    "servers.cluster": (status) => {
      setClusterJobsModule(moduleEnabled(status, "jobs"));
      if (serversVisible()) renderClusterPanel(activeResourceLayer(status), status.activeServer || null);
    },
  };

  function renderView(view, status) {
    if (!status) return;
    if (view === "overview") {
      if (!isPanelHidden("overview.chain")) renderChain(status);
      if (!isPanelHidden("overview.serverBriefs")) panelRenderers["overview.serverBriefs"](status);
    } else if (view === "servers") {
      if (!isPanelHidden("servers.resources")) panelRenderers["servers.resources"](status);
      if (!isPanelHidden("servers.cluster")) panelRenderers["servers.cluster"](status);
    }
  }

  function renderDom(status) {
    doc.body.classList.remove("data-stale");

    if (!seededMetrics && status.activeServerId && serversVisible()) {
      seededMetrics = true;
      seedFromMetrics(status.activeServerId);
    }

    const agentView = getActiveAgentView(status); // null = 没有启用的 Agent

    // 版本徽章以后端 /api/status 返回的 version 为准（HTML 里的只是初始占位）。
    const versionBadge = getEl("versionBadge");
    if (versionBadge && status.version) versionBadge.textContent = `v${status.version}`;
    renderAgentSelect(status);
    syncServerSelect(getEl("serverSelect"), status.activeServerId);
    // 页头「Doctor」入口只在 Codex 监控开着时出现（status.doctor 随 Codex 门控一起消失）。
    const doctorBtn = getEl("doctorToolBtn");
    if (doctorBtn) doctorBtn.hidden = !hasDoctorAgent(status);

    // Agent 概览卡（点卡片即切换活跃 Agent）；v2.19：卡上的远端动作按钮只进确认层，不直接执行。
    renderAgentOverview(status, agentView);
    // 设置页配置来源只在浮层可见时渲染——打开设置时补渲一次，收起期间不必每轮重建。
    onSettingsStatus(status);
    // 「控制」浮层的启动按钮：已在运行时不再是主按钮（app/actions.js）。
    onControlStatus(status);
    renderStorageTile(status.storage);

    renderOverall(status);

    // 注意力队列（内部调用 renderAlertBanner 保持通道条行为不变）。
    renderAttentionQueue(status);
    // activeSignals 只在 SSE lite payload 顶层存在；全量刷新（/api/status = legacy+layers）
    // 没有该顶层字段，退回同源的 layers.signals.active，否则红条会被下一次全量刷新抹掉。
    renderSignalBanner(getEl("signalBanner"), status.activeSignals ?? status.layers?.signals?.active);
    if (overviewVisible() && !isPanelHidden("overview.chain")) renderChain(status);
    // 侧栏通道状态里的「一键修复」：只在通道异常 / 降级时出现（与横幅里的 #alertActionBtn 同一流程）。
    // 没领反向端口（transport setup）时重启修不好，不出修复按钮——横幅里有领端口的引导。
    const health = status.health || "down";
    const repairBtn = getEl("sidebarRepairBtn");
    const setupPending = status.summary?.transport?.state === "setup";
    if (repairBtn) repairBtn.style.display = !setupPending && (health === "down" || health === "degraded") ? "" : "none";
    // 同账号另一台 Mac 在承载、本机待命（v2.88）：给「让这台承载」。
    const takeoverBtn = getEl("sidebarTakeoverBtn");
    if (takeoverBtn) {
      const standby = canTakeOver(status) ? handoverStandbyOf(status) : null;
      takeoverBtn.style.display = standby ? "" : "none";
      if (standby) takeoverBtn.title = `${handoverNote(standby, status.connectionTargets?.machine)}。点这里让这台电脑接管（先弹预览）`;
    }

    // 服务器简报、资源与负载、集群节点与队列：按面板注册表门控（隐藏的跳过）。
    runPanelRenders(panelRenderers, status, isPanelHidden);

    // 固定 24 小时制（与日志、服务器卡同一口径）；不随系统语言变成「4:08:56 PM」
    setText("lastUpdateBadge", `最后更新 ${formatClock(new Date(status.updatedAt).getTime(), { locale: "zh-CN", hour12: false })}`);
    setText("doctorPanelTitle", agentView ? `查看 ${agentView.agent.diagnosticLabel || "Agent 诊断"} 详细输出` : "Agent 诊断");
    setText("doctorSummaryBadge", agentView ? agentView.diagnosticBadge : "未启用");
    renderDiagnostics(status, agentView);

    refreshTimeline(status);
  }

  return { renderDom, renderView };
}
