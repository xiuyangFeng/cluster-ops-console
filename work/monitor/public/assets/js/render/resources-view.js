// resources-view.js —— 「资源与负载」面板的 HTML 片段（纯字符串函数，Node 可测）。
// 输入是 resources-model.js 的模型；输出交给 load-panel.js 用 morphInnerHtml 就地修补。
// 所有动态文案一律 escapeHtml；级别只写进 data-level 属性（配色在 tiles.css），
// 不拼 className——渲染层对 className 的整体覆写不会吃掉级别。
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml } from "../store.js";
import { clampPct } from "../thresholds.js";

// 面板级提示（紧凑型空状态，贴在三块指标上方）：只在这台服务器从没采到过数据时出现
//（model.firstSample，见 resources-model.js）。指标块与 sparkline 照常留着（charts.js 依赖它们常驻）。
export function buildResourceNoticeHtml(firstSample) {
  if (firstSample?.state === "wait") {
    return emptyStateHtml({
      compact: true, tone: "wait", icon: "chart", title: "正在等这台服务器的第一次采样",
      body: "资源每分钟经 SSH 采一次；刚添加或工作台刚启动时，通常 1 分钟内出现。",
    });
  }
  if (firstSample?.state === "error") {
    return emptyStateHtml({
      compact: true, tone: "error", icon: "cloudOff", title: "暂时取不到这台服务器的资源数据",
      body: `${firstSample.reason || "采集失败"}；每分钟会自动重试一次。`,
    });
  }
  return "";
}

// 用量条：贴在 tile 底边的整宽细条（颜色随 tile 的 data-level）。大字已经给出数值，
// 不再画重复表达同一个数的环形仪表。进度走内联 style 的 scaleX（style 变化才触发 CSS 过渡）。
function usageBarHtml(gauge) {
  const scale = Math.round(clampPct(gauge) * 10) / 1000;
  return `<div class="res-tile-meter" aria-hidden="true"><span class="res-tile-meter-fill" style="transform: scaleX(${scale})"></span></div>`;
}

function deltaHtml(delta) {
  if (!delta) return "";
  return `<span class="res-delta" data-dir="${escapeHtml(delta.dir)}" title="${escapeHtml(delta.title)}">${escapeHtml(delta.text)}</span>`;
}

// 明细项：普通项是字符串；带语义的项是 { text, kind }（range = 范围内高低值、outlook = 磁盘走势），
// kind 写在 data-kind 上（配色在 tiles.css）。
function detailHtml(detail) {
  if (detail && typeof detail === "object") {
    return `<li data-kind="${escapeHtml(detail.kind || "")}">${escapeHtml(detail.text || "")}</li>`;
  }
  return `<li>${escapeHtml(detail)}</li>`;
}

// 占用现场（v2.62，resources-model.buildOccupancy）：只在档位到「警告」及以上时出现的一行，排在明细的最后、
// 独占一行、固定一行高（tiles.css）。行内两项各是一个 .res-tile-occ：第二项放不下时整项换到被裁掉的第二行、
// 不显示；第一项自己放不下时只收账号名（.res-tile-occ-name，省略号），数字与标注所在的元素不收缩——
// 不会出现截了一半的数字。
// 这一行按原样保留空白（white-space: pre），所以标签之间不能有空白，数值前的那个空格写在 span 里面。
// 完整的逐账号明细在它自己的悬停提示里。
function occupancyHtml(occupancy) {
  const first = occupancy?.first;
  if (!first?.name) return "";
  const second = occupancy.second ? `<span class="res-tile-occ">${escapeHtml(occupancy.second)}</span>` : "";
  return (
    `<li data-kind="occupancy" title="${escapeHtml(occupancy.title || occupancy.text || "")}">` +
    `<span class="res-tile-occ"><span>${escapeHtml(occupancy.label || "")}</span>` +
    `<span class="res-tile-occ-name">${escapeHtml(first.name)}</span><span> ${escapeHtml(first.value || "")}</span></span>` +
    `${second}</li>`
  );
}

// 单块 tile 的正文（标题 + 大字 + 环比 + 明细 + 注释 + 底边用量条）。sparkline 不在这里：
// 它是 index.html 里的静态 SVG（charts.js 的 ResizeObserver 只盯首绘时就在的节点）；
// 正文容器是 display: contents，各段与 sparkline 一起排进 tile 的网格（tiles.css）。
// t.hint（占用现场的逐账号明细）写成标题与大字的悬停提示：平时不占版面，想看时悬停即可。
export function buildTileBodyHtml(tile) {
  const t = tile || {};
  const known = t.value != null;
  const qualifier = t.qualifier ? `<span class="res-tile-qualifier">${escapeHtml(t.qualifier)}</span>` : "";
  const figure = known
    ? `<span class="res-tile-value">${escapeHtml(t.display)}</span><span class="res-tile-unit">${escapeHtml(t.unit)}</span>${deltaHtml(t.delta)}`
    : `<span class="res-tile-value res-tile-value-empty">${escapeHtml(t.display || "未知")}</span>`;
  const items = (t.details || []).map(detailHtml).join("") + occupancyHtml(t.occupancy);
  const details = items ? `<ul class="res-tile-details">${items}</ul>` : "";
  const note = t.note ? `<p class="res-tile-note">${escapeHtml(t.note)}</p>` : "";
  const hint = t.hint ? ` title="${escapeHtml(t.hint)}"` : "";
  return (
    `<div class="res-tile-title"${hint}>${escapeHtml(t.title || "")}${qualifier}</div>` +
    `<div class="res-tile-figure"${hint}>${figure}</div>` +
    details +
    note +
    usageBarHtml(t.gauge)
  );
}

// GPU 区标题行：「GPU  8 卡 · A100-SXM4-80GB」+ 平均利用率 / 显存合计 / 空闲卡数。
export function buildGpuSummaryHtml(summary) {
  if (!summary) return "";
  // 多个节点（登录节点 + node04 这类直连节点）：型号各异，头部只写卡数与节点数，分组标题里再写型号
  const head = `${summary.count} 卡${summary.nodes > 1 ? ` · ${summary.nodes} 个节点` : summary.model ? ` · ${summary.model}` : ""}`;
  const stats = [
    ["平均利用率", summary.avgUtil == null ? "未知" : `${summary.avgUtil}%`],
    ["显存合计", summary.memText || "未知"],
    ["空闲", `${summary.idle} 卡`],
  ];
  if (summary.maxTemp != null) stats.push(["最高温度", `${summary.maxTemp}°C`]);
  if (summary.totalPowerW != null) stats.push(["总功耗", summary.totalPowerW >= 1000 ? `${(summary.totalPowerW / 1000).toFixed(2)} kW` : `${Math.round(summary.totalPowerW)} W`]);
  return (
    `<div class="res-gpu-title"><h3>GPU</h3><span class="res-gpu-model">${escapeHtml(head)}</span></div>` +
    `<dl class="res-gpu-stats">${stats.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>`
  );
}

// ---- GPU 列表：一张卡一行，各列上下对齐（v2.53.2 起取代竖长卡片）----
// 列：节点（同一节点的几行合并成一格：节点名 + 卡数 × 型号，直连节点标「直连」）/ 卡号 / 利用率条 + 百分比 /
// 近 24 小时走势 / 显存条 + 用量 / 温度 · 功耗 / 占用者。完整信息在整行的悬停提示里
// （第一行是这张卡的读数；自己的占用分得出 Slurm 作业时，下面一个作业一行：作业号、作业名、显存）。
// v2.76：整行可点 → 打开「这块卡上谁在跑」浮层（逐进程的属主 / 命令行 / 已运行时长 / 提交方式，
// 见 render/gpu-card-view.js 与 app/gpu-card-controller.js）。行上带分组 key（"" = 本机，节点名 = 直连节点）
// 与卡号，浮层据此回原始卡取数据；卡号那格是按钮，键盘也能打开（整行的点击只委托给鼠标）。
// groups：resources-model.buildGpuGroups 的分组（只有本机一组时也照样有节点列，口径一致）；
// trendFor(key, index)：分组的走势数据键（"" = 本机，节点名 = 直连节点）+ 卡号 → 走势 SVG（没有数据时给空串）。

// 走势：SVG 由 gpu-trend.js 生成（数值已格式化、不含外部文本）；没有数据时写「积累中」占位，列不塌。
function gpuTrendHtml(svg) {
  return svg
    ? `<span class="res-gpu-trend" title="近 24 小时利用率（5 分钟一档取最高）">${svg}</span>`
    : '<span class="res-gpu-trend is-empty" title="近 24 小时利用率：数据还在积累">积累中</span>';
}

// kind=util 恒用强调色（利用率高是 GPU 在干活，不是告警）；kind=mem 按 data-level 分档着色。
// 条在左、数值在右（数值列宽固定，几行的条右端对齐）。
function meterHtml(kind, valueHtml, pct, level, label) {
  const scale = clampPct(pct) / 100;
  return (
    `<div class="res-gpu-meter" data-kind="${kind}" data-level="${escapeHtml(level)}" aria-label="${escapeHtml(label)}">` +
    `<span class="res-meter"><span class="res-meter-fill" style="transform: scaleX(${scale})"></span></span>` +
    `<span class="res-gpu-meter-value">${valueHtml}</span></div>`
  );
}

const GPU_OPEN_HINT = "点击查看这块卡上的进程（谁、跑了多久、怎么起的）";

function gpuRowHtml(c, trendSvg, nodeCell, idleHold = false, group = null) {
  const util = c.util == null ? "—" : `${escapeHtml(String(c.util))}<small>%</small>`;
  const mem = c.memTotalMb != null ? escapeHtml(c.memText) : "未知";
  const idleHoldBadge = idleHold
    ? '<span class="res-gpu-idle-hold" title="近 30 分钟利用率为 0%，但仍占用显存（可能是训练挂起或交互式进程未退出）"> · 空占显存 ≥30m</span>'
    : "";
  const key = typeof group?.key === "string" ? group.key : "";
  const label = typeof group?.label === "string" ? group.label : "";
  const open = ` data-gpu-key="${escapeHtml(key)}" data-gpu-index="${escapeHtml(String(c.index))}" data-gpu-label="${escapeHtml(label)}"`;
  const where = label ? `${label} GPU #${c.index}` : `GPU #${c.index}`;
  return (
    `<tr class="res-gpu-row"${idleHold ? ' data-idle-hold="true"' : ""}${open} title="${escapeHtml([c.title, GPU_OPEN_HINT].filter(Boolean).join("\n"))}">` +
    nodeCell +
    `<td class="res-gpu-c-idx"><button type="button" class="res-gpu-index" data-gpu-open aria-label="${escapeHtml(`${where}：${GPU_OPEN_HINT}`)}">${escapeHtml(c.index)}</button></td>` +
    `<td class="res-gpu-c-util">${meterHtml("util", util, c.util, c.util == null ? "unknown" : "ok", `利用率 ${c.util == null ? "未知" : `${c.util}%`}`)}</td>` +
    `<td class="res-gpu-c-trend">${gpuTrendHtml(trendSvg)}</td>` +
    `<td class="res-gpu-c-mem">${meterHtml("mem", mem, c.memPct, c.memLevel, `显存 ${c.memText}`)}</td>` +
    `<td class="res-gpu-c-env">${c.envText ? escapeHtml(c.envText) : '<span class="res-gpu-na">—</span>'}</td>` +
    `<td class="res-gpu-c-owner"><span class="res-gpu-owner" data-idle="${c.ownerText === "空闲" ? "true" : "false"}">${escapeHtml(c.ownerText)}${idleHoldBadge}</span></td>` +
    "</tr>"
  );
}

// 节点格里的型号写紧凑一点（列窄）：去掉接口后缀（-PCIE / -SXM4），型号与显存之间换成空格——
// 「A100-PCIE-40GB」→「A100 40GB」。完整型号在节点格的悬停提示与整行提示里。纯函数。
export function compactGpuModel(name) {
  return String(name || "").replace(/-(?:PCIE|PCIe|SXM\d*)(?=-|$)/g, "").replace(/-(\d+\s*GB)$/i, " $1").trim();
}

export function buildGpuTableHtml(groups, { trendFor = null, idleHoldFor = null } = {}) {
  const list = (Array.isArray(groups) ? groups : []).filter((g) => Array.isArray(g?.cards) && g.cards.length);
  if (!list.length) return "";
  const body = list.map((g) => {
    const model = g.summary?.model || "";
    const meta = `${g.cards.length} × ${compactGpuModel(model) || "GPU"}`;
    const tip = [model ? `${g.cards.length} × ${model}` : "", g.direct ? "直连：不在 Slurm 分区里，从登录节点直连采集（与集群面板的直连节点同一份数据）" : ""].filter(Boolean).join("\n");
    const nodeCell = `<th scope="rowgroup" class="res-gpu-c-node" rowspan="${g.cards.length}"${tip ? ` title="${escapeHtml(tip)}"` : ""}>`
      + `<span class="res-gpu-node-name">${escapeHtml(g.label)}</span><span class="res-gpu-node-meta">${escapeHtml(meta)}</span>`
      + `${g.direct ? '<span class="res-gpu-node-tag">直连</span>' : ""}</th>`;
    const rows = g.cards.map((c, i) => gpuRowHtml(
      c,
      trendFor ? trendFor(g.key, c.index) : "",
      i === 0 ? nodeCell : "",
      idleHoldFor ? Boolean(idleHoldFor(g.key, c)) : false,
      g,
    )).join("");
    return `<tbody aria-label="${escapeHtml(g.label)} GPU">${rows}</tbody>`;
  }).join("");
  return (
    '<table class="res-gpu-table"><caption class="res-gpu-caption">GPU 逐卡</caption>' +
    '<colgroup><col class="res-gpu-c-node" /><col class="res-gpu-c-idx" /><col class="res-gpu-c-util" /><col class="res-gpu-c-trend" />' +
    '<col class="res-gpu-c-mem" /><col class="res-gpu-c-env" /><col class="res-gpu-c-owner" /></colgroup>' +
    '<thead><tr><th scope="col" class="res-gpu-c-node">节点</th><th scope="col" class="res-gpu-c-idx">卡</th><th scope="col" class="res-gpu-c-util">利用率</th>' +
    '<th scope="col" class="res-gpu-c-trend">近 24 小时</th><th scope="col" class="res-gpu-c-mem">显存</th><th scope="col" class="res-gpu-c-env">温度 · 功耗</th>' +
    '<th scope="col" class="res-gpu-c-owner">占用</th></tr></thead>' +
    `${body}</table>`
  );
}
