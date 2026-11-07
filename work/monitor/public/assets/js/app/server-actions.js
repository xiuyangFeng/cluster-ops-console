// app/server-actions.js —— W5 的"重新分配反向端口"处置（注意力队列与命令面板调用）。
// 复制代理命令与单隧道重启只在命令面板（⌘K）里提供：服务器页原先的「连接与修复」面板
// 与首页的一键修复重复，v2.40 起移除。
import { canScopedRestart } from "../connection-target.js";
import { describePortReassign, describePortReassignBlocked } from "../server-cards.js";
import { BUTTON_LABELS } from "../ui-labels.js";

export function createServerActions({ state, showToast, confirm, getJson, postJson, loadServers, refresh, requestScopedRestart }) {
  let reassignInFlight = false;

  // W5 L2 处置：端口被占 → 预览建议端口（后端 SSH 读集群端口登记目录 + 远端监听 + 本机配置保留集）→ 确认 →
  // 领取并写个人配置（POST /api/servers/:id/claim-port：登记目录可用时原子登记，不可用时回落并标明"未登记"）
  // → 只重启该服务器的隧道。
  async function reassignPort(serverId) {
    if (reassignInFlight) return;
    reassignInFlight = true;
    const title = BUTTON_LABELS.reassignPort;
    try {
      let suggestion;
      try {
        suggestion = await getJson(`/api/servers/${encodeURIComponent(serverId)}/suggest-port`);
      } catch (err) {
        showToast({ type: "error", message: `获取建议端口失败：${err.serverMessage || err.message}`, title });
        return;
      }
      const serverName = (state.getConfig()?.servers || []).find((s) => s.id === serverId)?.name || serverId;
      // 远端占用探测不到 → 后端不给自动建议，绝不拿未核对的端口去写配置。
      if (!suggestion?.suggested?.remotePort) {
        showToast({ type: "warn", message: describePortReassignBlocked(suggestion, serverName), title, duration: 10000 });
        return;
      }
      if (!confirm(describePortReassign(suggestion, serverName))) return;
      let claimed;
      try {
        claimed = await postJson(`/api/servers/${encodeURIComponent(serverId)}/claim-port`, {
          remotePort: suggestion.suggested.remotePort,
          expectedRevision: suggestion.revision,
        });
      } catch (err) {
        showToast({ type: "error", message: `领取端口失败：${err.serverMessage || err.message}`, title });
        return;
      }
      const port = claimed?.remotePort ?? suggestion.suggested.remotePort;
      const note = claimed?.registered === false ? "（未登记：集群上没有端口登记目录，可能与他人冲突）" : claimed?.mode === "claimed" ? "（已在集群登记）" : "";
      showToast({ type: claimed?.registered === false ? "warn" : "success", message: `已把「${serverName}」的反向端口改为 ${port}${note}`, title });
      await loadServers();
      await refresh({ force: true });
      if (canScopedRestart(state.getStatus())) requestScopedRestart(serverId);
      else showToast({ type: "info", message: `守护进程会按新端口重建该隧道；若稍后仍未恢复，可在「${BUTTON_LABELS.control}」里${BUTTON_LABELS.restart}。`, title });
    } finally {
      reassignInFlight = false;
    }
  }

  return { reassignPort };
}
