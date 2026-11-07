// app/server-switch.js —— 服务器列表加载与"查看哪台 / 哪个 Agent"的切换。
//
// v2.18：活跃服务器语义从"连哪台"改为"看哪台"——所有隧道常驻，这里只切重探针与
// Agent 视角，文案统一为"查看"并显式声明隧道不受影响（设计稿 §0/§6.8）。
import { escapeHtml } from "../store.js";

export function createServerSwitch({
  doc, state, getConfig, getStatus, postJson, render, showToast, pending, logsPanel,
  renderServerBriefs, resetCharts, seedFromMetrics,
}) {
  const getEl = (id) => doc.getElementById(id);
  // 切换请求序号：连点两张服务器卡时，先发的请求可能后返回并把界面渲染回旧视角
  // （下拉框是新的、status.activeServerId 是旧的），进而让"复制集群远端代理命令"
  // 复制到另一台服务器的端口。服务器与 Agent 切换共用一个序号，过期响应一律丢弃。
  let switchSeq = 0;

  // 动态载入多服务器列表并绑定切换事件。
  async function loadServers() {
    try {
      const config = await getConfig();
      const previousServerId = state.getStatus()?.activeServerId;
      state.setConfig(config);
      const visibleServers = config.servers.filter((s) => s.disabled !== true && s.monitorEnabled !== false);
      if (previousServerId && !visibleServers.some((s) => s.id === previousServerId)) resetCharts();
      const select = getEl("serverSelect");
      if (select) {
        select.innerHTML = visibleServers.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.displayName || s.name || s.id)}</option>`).join("");
        select.value = config.activeServerId || visibleServers[0]?.id || "";
        select.disabled = visibleServers.length === 0;
        select.onchange = () => switchActiveServer(select.value);
      }
      const status = state.getStatus();
      renderServerBriefs(status?.serversBrief, config.activeServerId, status?.layers, config.servers);
    } catch (err) {
      console.error("加载服务器列表失败:", err.message);
    }
  }

  // 共用流程：进入等待态 → 写选择 → 拉全量状态渲染；任何一步之后发现已被新切换取代就丢弃。
  // 等待态 pending.show(kind) / hide(kind)：kind = "server" | "agent"，由调用方决定哪些面板回到加载骨架
  // （v2.52 起不再盖全屏遮罩）。
  async function switchTo({ kind, post, afterPost = () => {}, afterRender, failLabel, failTitle }) {
    const seq = ++switchSeq;
    pending.show(kind);
    try {
      await post();
      if (seq !== switchSeq) return; // 已被后一次切换取代，丢弃本次结果
      afterPost();
      const data = await getStatus();
      if (seq !== switchSeq) return;
      render(data);
      afterRender();
    } catch (err) {
      if (seq !== switchSeq) return;
      console.error(`${failLabel}:`, err.message);
      showToast({ type: "error", message: `${failLabel}: ${err.message}`, title: failTitle });
    } finally {
      pending.hide(kind);
    }
  }

  function switchActiveServer(serverId) {
    return switchTo({
      kind: "server",
      post: () => postJson("/api/config/active", { activeServerId: serverId }),
      afterPost: resetCharts,
      afterRender: () => {
        seedFromMetrics(serverId);
        logsPanel.refresh();
        showToast({ type: "success", message: `正在查看服务器 [${serverId}]，隧道不受影响`, title: "查看服务器" });
      },
      failLabel: "切换查看视角失败",
      failTitle: "查看失败",
    });
  }

  function switchActiveAgent(agentId) {
    return switchTo({
      kind: "agent",
      post: () => postJson("/api/config/agent-active", { activeAgentId: agentId }),
      afterRender: () => {
        showToast({ type: "info", message: `已切换诊断视角至 [${agentId}]`, title: "Agent 切换" });
      },
      failLabel: "切换 Agent 失败",
      failTitle: "切换失败",
    });
  }

  // 切换入口：Agent 概览卡、服务器卡（整卡可点，卡内「查看」按钮经 closest("[data-id]")
  // 命中同一张卡）、Agent 下拉。服务器下拉在 loadServers 里随选项一起绑定。
  function bindSwitchers() {
    getEl("agentOverviewGrid")?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-agent-id]");
      if (card) switchActiveAgent(card.dataset.agentId);
    });
    getEl("serverBriefsContainer")?.addEventListener("click", (e) => {
      const card = e.target.closest("[data-id]");
      if (card && card.dataset.id !== state.getStatus()?.activeServerId) switchActiveServer(card.dataset.id);
    });
    const agentSelect = getEl("agentSelect");
    agentSelect?.addEventListener("change", () => switchActiveAgent(agentSelect.value));
  }

  return { loadServers, switchActiveServer, switchActiveAgent, bindSwitchers };
}
