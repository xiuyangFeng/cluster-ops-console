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

function connectionQuickStats(layer, model) {
  const cards = Array.isArray(model?.cards) ? model.cards : [];
  const state = layer?.level === "error" ? "error" : cards.length ? "ok" : layer?.checkedAt ? "idle" : "pending";
  if (!cards.length) return { state, count: 0, utilPct: null, memPct: null };
  const utilVals = cards.map((c) => c.utilizationPct).filter((v) => Number.isFinite(v));
  const utilPct = utilVals.length ? Math.round(utilVals.reduce((a, b) => a + b, 0) / utilVals.length) : null;
  const memUsed = cards.reduce((s, c) => s + (Number.isFinite(c.memoryUsedMiB) ? c.memoryUsedMiB : 0), 0);
  const memTotal = cards.reduce((s, c) => s + (Number.isFinite(c.memoryTotalMiB) ? c.memoryTotalMiB : 0), 0);
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : null;
  return { state, count: cards.length, utilPct, memPct };
}

function accountCardHtml(s, layer, model, { isSelected, routeShort }) {
  const stats = connectionQuickStats(layer, model);
  const meters = stats.count > 0
    ? `<span class="gpu-acc-metrics">` +
      `<span class="gpu-acc-count">${stats.count} GPU</span>` +
      (stats.utilPct != null
        ? `<span class="gpu-acc-mini" title="平均算力利用率 ${stats.utilPct}%"><span class="gpu-acc-mini-lbl">算力</span><span class="gpu-acc-bar"><i style="width:${Math.max(2, Math.min(100, stats.utilPct))}%"></i></span><b>${stats.utilPct}%</b></span>`
        : "") +
      (stats.memPct != null
        ? `<span class="gpu-acc-mini" data-kind="mem" title="总显存占用 ${stats.memPct}%"><span class="gpu-acc-mini-lbl">显存</span><span class="gpu-acc-bar"><i style="width:${Math.max(2, Math.min(100, stats.memPct))}%"></i></span><b>${stats.memPct}%</b></span>`
        : "") +
      `</span>`
    : `<span class="gpu-acc-empty">${stats.state === "error" ? "采集异常" : layer?.checkedAt ? "无 GPU" : "等待采集"}</span>`;
  return (
    `<label class="gpu-acc-card" data-state="${stats.state}">` +
    `<input type="checkbox" data-gpu-connection="${escapeHtml(s.id)}"${isSelected ? " checked" : ""}>` +
    `<span class="gpu-acc-body">` +
    `<span class="gpu-acc-top">` +
    `<span class="gpu-acc-dot" aria-hidden="true"></span>` +
    `<span class="gpu-acc-name">${escapeHtml(s.name || s.host)}</span>` +
    `<span class="gpu-acc-user">${escapeHtml(s.sshUser)}</span>` +
    `<span class="gpu-acc-route">${escapeHtml(routeShort)}</span>` +
    `</span>` +
    `${meters}` +
    `</span>` +
    `</label>`
  );
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
    const modelsById = new Map(choices.map((s) => {
      const layer = status.layers?.resources?.[s.id];
      return [s.id, { layer, model: buildGpuGroups(layer?.gpu, layer?.slurm, s.name || s.host) }];
    }));
    const nextSelectorHtml = `<div class="gpu-acc-head"><p title="可多选。普通账号显示本人进程与作业，root 显示全部；各连接独立采集。">GPU 节点与账号</p><span class="gpu-acc-hint">已选 ${choices.filter((s) => selected.includes(s.id)).length} / ${choices.length}</span></div><div class="gpu-acc-grid">${choices.map((s) => {
      const entry = modelsById.get(s.id);
      const routeShort = s.sshJumpServerId ? "跳转" : "直连";
      return accountCardHtml(s, entry?.layer, entry?.model, { isSelected: selected.includes(s.id), routeShort });
    }).join("")}</div>`;
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
    // 口径说明在「GPU 节点与账号」标题的悬停说明里，这一行不再常驻一句话。
    if (summary?.textContent) summary.textContent = "";
    const now = Date.now();
    const html = choices.filter((s) => selected.includes(s.id)).map((s) => {
      const entry = modelsById.get(s.id);
      const layer = entry?.layer;
      const model = entry?.model || buildGpuGroups(layer?.gpu, layer?.slurm, s.name || s.host);
      if (trend && model.cards.length) ensureGpuTrend(s.id);
      const trendFor = trend ? (key, index) => gpuSparkSvg(gpuSeriesFor(s.id, index, key), { start: now - GPU_TREND_SPAN_MS, end: now }) : null;
      const idleHoldFor = trend ? (key, card) => isGpuIdleHoldingMemory(card, gpuSeriesFor(s.id, card.index, key), { now }) : null;
      const route = s.sshJumpServerId ? `经 ${choices.find((c) => c.id === s.sshJumpServerId)?.name || s.sshJumpServerId} 跳转` : "直连";
      const noteLevel = layer?.level === "error" ? "error" : layer?.checkedAt ? "ok" : "pending";
      const note = layer?.level === "error" ? layer.reason : layer?.checkedAt ? `采样于 ${formatRelativeTime(layer.checkedAt, now)}` : "等待首次采集";
      return (
        `<section class="gpu-connection" data-gpu-server-id="${escapeHtml(s.id)}">` +
        `<div class="gpu-conn-head">` +
        `<div class="gpu-conn-id"><h4>${escapeHtml(s.name || s.host)}</h4><span class="gpu-conn-endpoint">${escapeHtml(s.sshUser)}@${escapeHtml(s.host)}</span><span class="gpu-conn-route">${escapeHtml(route)}</span></div>` +
        `<span class="gpu-conn-status" data-level="${noteLevel}"><i aria-hidden="true"></i>${escapeHtml(note)}</span>` +
        `</div>` +
        `${buildGpuSummaryHtml(model.summary)}` +
        `${model.cards.length ? buildGpuTableHtml(model.groups, { trendFor, idleHoldFor }) : '<p class="sa-note">尚未采到 GPU 数据；采集成功后会自动显示。</p>'}` +
        `</section>`
      );
    }).join("");
    paint(list, html || '<p class="sa-note">勾选上方节点和账号以查看 GPU。</p>');
  }
  if (trend) onGpuTrendChange(() => { if (latest && !doc.hidden) render(latest, config); });
  return { render };
}
