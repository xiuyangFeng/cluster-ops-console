// server-card-model.js —— 概览「服务器简报」卡的纯模型（团队/个人徽标 + 隧道胶囊 + GPU 行）。
// 从 load-panel.js 拆出：它只服务概览卡（render/overview.js），与服务器页的资源面板无关。
import { escapeHtml, formatClock, formatGb } from "../store.js";
import { colorFor, levelFor } from "../thresholds.js";
import { buildGpuModel, directGpuNodes } from "./resources-model.js";

// GPU 显存分档（纯函数，便于测试）：与服务器页资源面板同一张阈值表（thresholds.gpuMemory），
// 配色类沿用 .bar-progress.color-green/yellow/red。缺值按 0（绿）处理，保持卡片不出灰条。
export function gpuColor(percent) {
  return colorFor(levelFor("gpuMemory", Number(percent) || 0));
}

// 隧道胶囊四态的展示常量（文案 + class 一一对应，渲染层不再拼字符串）。
const TUNNEL_PILLS = {
  ok: { tunnelPill: "在线", tunnelClass: "tunnel-pill-ok" },
  error: { tunnelPill: "断开", tunnelClass: "tunnel-pill-error" },
  muted: { tunnelPill: "仅监控", tunnelClass: "tunnel-pill-muted" },
  waiting: { tunnelPill: "等待", tunnelClass: "tunnel-pill-waiting" },
};

// 服务器卡模型（纯函数，便于测试）。防御性读取：后端字段缺失一律降级到可渲染值，
// 绝不抛错——本模型在后端 Task 4b/5 落地前就会被渲染路径调用。
// 字段来源（设计稿 §6.3）：
//   server.source / server.tunnel（配置条目；隧道层同名字段作为回退）
//   layers.tunnels[server.id] = { level, reason, tunnelUp, remotePortOpen, checkedAt, source, tunnel }
//   layers.resources[server.id].gpu = [{ index, name, memUsedMb, memTotalMb, util }]
//   backoff = /api/status.probeBackoff.servers[server.id]（探针退避：这台 SSH 连不上、探测已放慢；没有为 null）
export function buildServerCardModel(server = {}, layers = {}, backoff = null) {
  const srv = server && typeof server === "object" ? server : {};
  const lay = layers && typeof layers === "object" ? layers : {};
  const id = srv.id == null ? "" : String(srv.id);
  const tunnels = lay.tunnels && typeof lay.tunnels === "object" ? lay.tunnels : {};
  const entry = (id && tunnels[id] && typeof tunnels[id] === "object") ? tunnels[id] : null;

  // 徽标：配置条目的 source 优先，其次隧道层的同名字段；两者都无按团队（老配置无该字段）。
  const source = srv.source ?? (entry ? entry.source : null) ?? "team";
  const badge = source === "personal" ? "个人" : "团队";

  // tunnel 缺省 true：老配置没有该字段时表示常驻隧道，不能误判成"仅监控"。
  const tunnelDisabled = srv.tunnel === false || (entry && entry.tunnel === false);

  let pill = TUNNEL_PILLS.waiting;
  if (tunnelDisabled || (entry && entry.level === "skipped")) {
    pill = TUNNEL_PILLS.muted;
  } else if (entry) {
    if (entry.level === "error" || entry.tunnelUp === false || entry.remotePortOpen === false) {
      pill = TUNNEL_PILLS.error;
    } else if (entry.level === "ok" || entry.tunnelUp === true) {
      pill = TUNNEL_PILLS.ok;
    }
  }

  const resources = lay.resources && typeof lay.resources === "object" ? lay.resources : {};
  // 逐卡数值与服务器页 GPU 区同一份模型（resources-model.buildGpuModel），这里只换成卡片行的紧凑写法。
  // 直连节点（node04 这类从登录节点跳采的机器）的卡排在本机之后，标签带节点名，两组之间留一道间隔（groupStart）。
  const res = id && resources[id] ? resources[id] : null;
  const cards = [
    ...buildGpuModel(res?.gpu).cards.map((c) => ({ ...c, node: "" })),
    ...directGpuNodes(res?.slurm).flatMap(({ node, cards: raw }) => buildGpuModel(raw).cards.map((c) => ({ ...c, node }))),
  ];
  const gpu = cards.map((c, i) => {
    const memText = c.memTotalMb != null ? `${formatGb(c.memUsedMb)}/${formatGb(c.memTotalMb)}G` : "";
    const memPercent = c.memPct ?? 0;
    const where = c.node ? `${c.node} ` : "";
    // v2.18.1：条长 = 利用率（与右侧百分比同一口径，100% 就是满条——用户反馈半条对不上 100%）；
    // 颜色 = 显存压力（70/90 分档），显存数字写进标签；完整型号放 title 悬停。
    return {
      label: memText ? `${where}#${c.index} ${memText}` : `${where}GPU ${c.index}`,
      title: `${where}#${c.index}${c.fullName ? ` ${c.fullName}` : ""}${memText ? ` · 显存 ${memText.replace("G", " GB")}` : ""}${c.util == null ? "" : ` · 利用率 ${c.util}%`}`,
      memPercent,
      util: c.util,
      barPercent: c.util ?? 0,
      colorClass: gpuColor(memPercent),
      groupStart: i > 0 && cards[i - 1].node !== c.node,
    };
  });

  // 探测已放慢：卡片上的数字不再每分钟更新。不另加胶囊（三列布局下会把服务器名挤得只剩两三个字），
  // 只在隧道胶囊后面带一个「·慢」并在悬停里写清楚。
  const nextProbeAt = typeof backoff?.nextProbeAt === "number" && Number.isFinite(backoff.nextProbeAt) ? backoff.nextProbeAt : null;
  const slowed = nextProbeAt == null
    ? null
    : { mark: "·慢", title: `SSH 连不上，探测已放慢 · 下次 ${formatClock(nextProbeAt, { locale: "zh-CN", hour12: false })} · 连上后自动恢复` };

  return { badge, source: source === "personal" ? "personal" : "team", ...pill, gpu, slowed };
}

// 服务器卡的徽标/胶囊/GPU 行 HTML（渲染层拼接用；所有动态串走 escapeHtml）。
export function buildServerCardExtrasHtml(model) {
  const m = model || buildServerCardModel();
  const head =
    `<span class="server-source-badge source-${m.source}">${escapeHtml(m.badge)}</span>` +
    (m.slowed
      ? `<span class="tunnel-pill ${m.tunnelClass}" title="${escapeHtml(m.slowed.title)}">${escapeHtml(m.tunnelPill)}${escapeHtml(m.slowed.mark)}</span>`
      : `<span class="tunnel-pill ${m.tunnelClass}">${escapeHtml(m.tunnelPill)}</span>`);
  // GPU 栏：平均利用率大字 + 每卡一根竖柱（柱高 = 利用率，柱色 = 显存压力；逐卡明细在悬停提示里）。
  // 无 GPU 不渲染这一栏（缺 nvidia-smi 的机器不该出现空栏）。
  const utils = m.gpu.map((g) => g.util).filter((u) => u != null);
  const avg = utils.length ? Math.round(utils.reduce((a, b) => a + b, 0) / utils.length) : null;
  const gpu = m.gpu.length
    ? `<div class="brief-stat brief-stat-gpu" title="${escapeHtml(m.gpu.map((g) => g.title || g.label).join("\n"))}">` +
      `<span class="brief-metric-label">GPU · ${m.gpu.length} 卡</span>` +
      '<span class="server-gpu-figure">' +
      `<span class="brief-metric-value">${avg == null ? "-" : `${avg}<small>%</small>`}</span>` +
      `<span class="server-gpu-bars">${m.gpu.map((g) => (
        `<span class="server-gpu-bar${g.groupStart ? " is-group-start" : ""}"><span class="bar-progress color-${g.colorClass}" style="transform: scaleY(${Math.max(0, Math.min(100, g.barPercent)) / 100})"></span></span>`
      )).join("")}</span>` +
      "</span></div>"
    : "";
  return { head, gpu };
}
