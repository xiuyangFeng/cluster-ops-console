// 通知跳转保持服务器上下文：切换失败或被后一次点击替代时不定位旧目标。
// target（可选）原样交给 focusJob："history" = 失败提醒，直接定位到「我的历史」。
export function createJobNavigation({ state, serverSwitch, viewTabs, panels, refresh, refreshWatches, focusJob, openInbox, toast }) {
  let generation = 0;
  let switchPending = Promise.resolve();
  return async function navigate(serverId, jobId, target = null) {
    const request = ++generation;
    if (!serverId) { openInbox(); return; }
    try {
      if (panels.isHidden("view.servers") || panels.isHidden("servers.cluster")) {
        toast({ type: "info", message: "服务器或作业面板已隐藏，请在配置的界面面板中开启后查看。" });
        openInbox();
        return;
      }
      // 前一次切服可能还没更新 state；等待其落定后按最新目标重判，避免 A→B 在飞时
      // 点击 A 被误认为「已在 A」而跳过切换，最终仍被旧请求带到 B。
      await switchPending;
      if (request !== generation) return;
      if (state.activeServerId() !== serverId) {
        const switching = serverSwitch.switchActiveServer(serverId);
        switchPending = Promise.resolve(switching).catch(() => {});
        await switching;
      }
      if (request !== generation || state.activeServerId() !== serverId) return;
      viewTabs.switchView("servers");
      await refresh({ force: true });
      if (request !== generation || state.activeServerId() !== serverId) return;
      await refreshWatches();
      if (request === generation && state.activeServerId() === serverId) await focusJob(jobId, target);
    } catch (error) { if (request === generation) toast({ type: "error", message: error?.message || "无法打开对应作业" }); }
  };
}
