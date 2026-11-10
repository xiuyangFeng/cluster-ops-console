import { morphInnerHtml } from "../dom-utils.js";
import { escapeHtml, formatRelativeTime } from "../store.js";
import { buildGpuGroups } from "../render/resources-model.js";
import { buildGpuSummaryHtml, buildGpuTableHtml } from "../render/resources-view.js";
import { ensureGpuTrend, gpuSeriesFor, gpuSparkSvg, GPU_TREND_SPAN_MS, isGpuIdleHoldingMemory, onGpuTrendChange } from "../gpu-trend.js";

export const GPU_SELECTION_KEY = "gpuConnectionSelection";
export function gpuConnections(status, config) {
  const servers = config?.servers || (status.activeServer ? [status.activeServer] : []);
  return servers.filter((s) => !s.disabled && s.monitorEnabled !== false).map((s) => ({
    ...s, sshUser: status.layers?.resources?.[s.id]?.agentsInstalled?.user || s.sshUser || config?.sshUser || "默认账号",
  }));
}

export function createGpuConnectionsController({ doc, storage = globalThis.localStorage, trend = true, paint = morphInnerHtml } = {}) {
  let selected = null, latest = null, config = null;
  try { const saved = JSON.parse(storage?.getItem(GPU_SELECTION_KEY) || "null"); if (Array.isArray(saved)) selected = saved.filter((id) => typeof id === "string"); } catch {}
  let bound = false;
  let selectorHtml = "";
  function render(status, nextConfig) {
    latest = status; config = nextConfig;
    const section = doc.getElementById("resGpuSection");
    const selector = doc.getElementById("resGpuAccounts");
    const list = doc.getElementById("resGpuList");
    if (!section || !selector || !list) return;
    const choices = gpuConnections(status, config);
    if (selected === null) selected = [status.activeServerId || choices[0]?.id].filter(Boolean);
    section.hidden = choices.length === 0;
    const nextSelectorHtml = '<p>GPU 节点与账号（可多选）</p>' + choices.map((s) => `<label><input type="checkbox" data-gpu-connection="${escapeHtml(s.id)}"${selected.includes(s.id) ? " checked" : ""}>${escapeHtml(s.name || s.host)} · ${escapeHtml(s.sshUser)}</label>`).join("");
    if (selectorHtml !== nextSelectorHtml) { selectorHtml = nextSelectorHtml; selector.innerHTML = selectorHtml; }
    if (!bound) {
      bound = true;
      selector.addEventListener("change", (event) => {
        const id = event.target?.dataset?.gpuConnection;
        if (!id) return;
        selected = selected.filter((value) => value !== id);
        if (event.target.checked) selected.push(id);
        try { storage?.setItem(GPU_SELECTION_KEY, JSON.stringify(selected)); } catch {}
        render(latest, config);
      });
    }
    const summary = doc.getElementById("resGpuSummary");
    if (summary) summary.textContent = "普通账号显示本人进程与作业，root 显示全部；各连接独立采集。";
    const now = Date.now();
    const html = choices.filter((s) => selected.includes(s.id)).map((s) => {
      const layer = status.layers?.resources?.[s.id];
      const model = buildGpuGroups(layer?.gpu, layer?.slurm, s.name || s.host);
      if (trend && model.cards.length) ensureGpuTrend(s.id);
      const trendFor = trend ? (key, index) => gpuSparkSvg(gpuSeriesFor(s.id, index, key), { start: now - GPU_TREND_SPAN_MS, end: now }) : null;
      const idleHoldFor = trend ? (key, card) => isGpuIdleHoldingMemory(card, gpuSeriesFor(s.id, card.index, key), { now }) : null;
      const route = s.sshJumpServerId ? `经 ${choices.find((c) => c.id === s.sshJumpServerId)?.name || s.sshJumpServerId} 跳转` : "直连";
      const note = layer?.level === "error" ? layer.reason : layer?.checkedAt ? `采样于 ${formatRelativeTime(layer.checkedAt, now)}` : "等待首次采集";
      return `<section class="gpu-connection" data-gpu-server-id="${escapeHtml(s.id)}"><h4>${escapeHtml(s.name || s.host)} · ${escapeHtml(s.sshUser)}@${escapeHtml(s.host)}</h4><p class="sa-note">${escapeHtml(route)} · ${escapeHtml(note)}</p>${buildGpuSummaryHtml(model.summary)}${model.cards.length ? buildGpuTableHtml(model.groups, { trendFor, idleHoldFor }) : '<p class="sa-note">尚未采到 GPU 数据；采集成功后会自动显示。</p>'}</section>`;
    }).join("");
    paint(list, html || '<p class="sa-note">勾选上方节点和账号以查看 GPU。</p>');
  }
  if (trend) onGpuTrendChange(() => { if (latest && !doc.hidden) render(latest, config); });
  return { render };
}
