// cluster-view.js —— 「集群节点与队列」面板的 HTML 片段（纯字符串函数，Node 可测）。
// 输入是 cluster-model.js 的模型；输出交给 cluster-panel.js 用 morphInnerHtml 就地修补。
// 动态文案一律 escapeHtml；级别 / 语气只写 data-* 属性（配色在 assets/css/cluster.css）。
// 进度一律走内联 style 的 stroke-dasharray / transform（style 变化才触发 CSS 过渡）。
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml } from "../store.js";
import { buildAgentDiagnosisPrompt, NO_LOG_TEXT } from "./cluster-diagnosis-model.js";
import { buildMoreRowHtml, buildSegmentRowHtml } from "./cluster-history-lookup.js";
import { buildResourceReviewHtml, buildWatchButton } from "./job-watch-view.js";
import { formatCount } from "./cluster-model.js";
import { clampPct } from "../thresholds.js";

function clamp01(pct) {
  return clampPct(pct) / 100;
}

function meterHtml(pct, attrs = "") {
  return `<span class="res-meter cl-meter"${attrs}><span class="res-meter-fill" style="transform: scaleX(${clamp01(pct)})"></span></span>`;
}

// 环形仪表：pathLength=100 让 dasharray 直接等于百分比，起点经 rotate 转到 12 点钟。
// outer = 主指标（分配 / 利用率，强调色），inner = 负载（中性灰细环），中心写主指标数值。
export function ringHtml({ outer = null, inner = null, center = "—", caption = "" } = {}, size = "node") {
  const arc = (cls, r, pct) => (
    `<circle class="${cls}-track" cx="32" cy="32" r="${r}" pathLength="100"></circle>` +
    // 0 时不画弧：圆头线帽会在 12 点钟留一个小圆点，看起来像「有一点」。
    (pct == null || clamp01(pct) <= 0.002 ? "" : `<circle class="${cls}" cx="32" cy="32" r="${r}" pathLength="100" transform="rotate(-90 32 32)" style="stroke-dasharray: ${Math.round(clamp01(pct) * 1000) / 10} 100"></circle>`)
  );
  return (
    `<span class="cl-ring" data-size="${size}">` +
    '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    arc("cl-ring-outer", 27, outer) +
    (size === "node" ? arc("cl-ring-inner", 19, inner) : "") +
    "</svg>" +
    (center || caption
      ? `<span class="cl-ring-center"><span class="cl-ring-value">${escapeHtml(center)}</span>` +
        (caption ? `<span class="cl-ring-caption">${escapeHtml(caption)}</span>` : "") +
        "</span>"
      : "") +
    "</span>"
  );
}

// GPU 卡位：每张卡一根小柱，柱高 = 利用率（Slurm 节点只知道分配与否：分配 = 满柱）。
export function slotsHtml(slots) {
  return (Array.isArray(slots) ? slots : []).map((s) => (
    `<span class="cl-slot"${s.busy ? ' data-busy="true"' : ""} title="${escapeHtml(s.title || "")}">` +
    `<span class="cl-slot-fill" style="transform: scaleY(${Math.round(Math.max(0, Math.min(1, s.fill || 0)) * 1000) / 1000})"></span></span>`
  )).join("");
}

function kpiVisualHtml(visual) {
  if (!visual) return "";
  // 数值已在大字里：KPI 只画一条细进度条（汇总带里横向排布更紧凑，环形仪表留给节点卡）。
  // share = 「我的作业」占全集群核数的比例，同一种细条。
  if (visual.kind === "ring" || visual.kind === "share") return meterHtml(visual.pct, ' data-kind="kpi"');
  if (visual.kind === "dots") {
    return `<span class="cl-dots">${(visual.dots || []).map((d) => (
      `<span class="cl-dotcell" data-tone="${escapeHtml(d.tone)}" title="${escapeHtml(d.title)}"></span>`
    )).join("")}</span>`;
  }
  if (visual.kind === "split") {
    const segs = (visual.segments || []).map((seg) => (
      `<span class="cl-split-seg" data-tone="${escapeHtml(seg.tone)}" style="flex-grow: ${Math.max(0, Number(seg.pct) || 0).toFixed(2)}" title="${escapeHtml(seg.title)}"></span>`
    )).join("");
    return `<span class="cl-splitbar">${segs}</span>`;
  }
  if (visual.kind === "slots") {
    return `<span class="cl-slot-groups">${(visual.groups || []).map((g) => (
      `<span class="cl-slot-group" title="${escapeHtml(g.title)}">${slotsHtml(g.slots)}</span>`
    )).join("")}</span>`;
  }
  return "";
}

// KPI 汇总带：一条分栏卡，每栏 标签 / 大字 / 说明 + 底部图形（进度条 / 点阵 / 占比条 / 卡位条）。
export function buildKpisHtml(kpis) {
  return (Array.isArray(kpis) ? kpis : []).map((k) => {
    const unit = k.unit ? `<span class="cl-kpi-unit">${escapeHtml(k.unit)}</span>` : "";
    const title = k.hint ? ` title="${escapeHtml(k.hint)}"` : "";
    const visual = kpiVisualHtml(k.visual);
    return (
      `<div class="cl-kpi" data-key="${escapeHtml(k.key)}" data-level="${escapeHtml(k.level || "ok")}"${k.emphasis ? ' data-emphasis="true"' : ""}${title}>` +
      '<div class="cl-kpi-main">' +
      `<div class="cl-kpi-label">${escapeHtml(k.label)}</div>` +
      `<div class="cl-kpi-figure"><span class="cl-kpi-value">${escapeHtml(k.value)}</span>${unit}</div>` +
      `<div class="cl-kpi-sub">${escapeHtml(k.sub || "")}</div>` +
      (k.sub2 ? `<div class="cl-kpi-sub cl-kpi-sub2">${escapeHtml(k.sub2)}</div>` : "") +
      "</div>" +
      (visual ? `<div class="cl-kpi-visual" data-kind="${escapeHtml(k.visual.kind)}"${k.visual.title ? ` title="${escapeHtml(k.visual.title)}"` : ""}>${visual}</div>` : "") +
      "</div>"
    );
  }).join("");
}

function statHtml(stat) {
  return (
    `<span class="cl-stat" data-dot="${escapeHtml(stat.dot || "")}">` +
    `<span class="cl-stat-label">${escapeHtml(stat.label)}</span>` +
    `<span class="cl-stat-value">${escapeHtml(stat.value)}</span></span>`
  );
}

// 节点卡：点击 = 按该节点过滤下方作业（再点取消）。button 内只放 span（短语内容）。
export function buildNodesHtml(nodes, selected = null) {
  return (Array.isArray(nodes) ? nodes : []).map((n) => {
    const pressed = selected === n.name;
    const badge = n.direct ? '<span class="cl-node-badge" title="不在任何 Slurm 分区，由登录节点 ssh 直连采集">直连</span>' : "";
    let body;
    if (n.offline) {
      body = (
        '<span class="cl-node-offline">' +
        `<span class="cl-node-offline-text">${escapeHtml(n.offline.text)}</span>` +
        `<span class="cl-node-offline-note">${escapeHtml(n.offline.note)}</span>` +
        "</span>"
      );
    } else {
      const mem = (
        `<span class="cl-stat cl-stat-mem" data-level="${escapeHtml(n.memLevel)}">` +
        '<span class="cl-stat-label">内存</span>' +
        `<span class="cl-stat-value">${escapeHtml(n.memText)}</span>` +
        meterHtml(n.memPct) +
        "</span>"
      );
      body = (
        '<span class="cl-node-main">' +
        ringHtml(n.ring, "node") +
        `<span class="cl-node-stats">${(n.stats || []).map(statHtml).join("")}${mem}</span>` +
        "</span>"
      );
    }
    const gpu = n.gpu
      ? (
        '<span class="cl-node-gpu">' +
        '<span class="cl-node-gpu-label">GPU</span>' +
        `<span class="cl-slots">${slotsHtml(n.gpu.slots)}</span>` +
        `<span class="cl-node-gpu-text">${escapeHtml(n.gpu.text)}</span>` +
        (n.gpu.userText ? `<span class="cl-node-gpu-users">${escapeHtml(n.gpu.userText)}</span>` : "") +
        "</span>"
      )
      : "";
    const notes = [];
    if (n.offSlurm) notes.push('<span class="cl-node-note" data-kind="off-slurm">负载高于分配（有 Slurm 外进程）</span>');
    if (n.reason && n.state.level !== "ok") notes.push(`<span class="cl-node-note" data-kind="reason">原因：${escapeHtml(n.reason)}</span>`);
    return (
      `<button type="button" class="cl-node" data-cl-node="${escapeHtml(n.name)}" aria-pressed="${pressed}" data-level="${escapeHtml(n.state.level)}"${n.direct ? ' data-direct="true"' : ""}${n.offline ? ' data-offline="true"' : ""} title="${escapeHtml(n.title)}">` +
      '<span class="cl-node-head">' +
      `<span class="cl-node-name">${escapeHtml(n.name)}</span>${badge}` +
      `<span class="cl-state" data-tone="${escapeHtml(n.state.tone)}"><span class="cl-dot" aria-hidden="true"></span>${escapeHtml(n.state.label)}</span>` +
      "</span>" +
      `<span class="cl-node-meta">${escapeHtml(n.meta || "")}</span>` +
      body +
      gpu +
      notes.join("") +
      "</button>"
    );
  }).join("");
}

// 按用户占用：条长 = 占全集群核数比例；当前用户强调色，其余中性灰（emphasis 形式，不用分类色）。
export function buildUsersHtml(users) {
  const list = Array.isArray(users) ? users : [];
  if (!list.length) return '<p class="cl-empty">暂无作业占用</p>';
  return list.map((u) => {
    const share = u.pct == null ? "" : `占全集群 ${u.pct < 1 && u.pct > 0 ? "<1" : Math.round(u.pct)}% 核`;
    return (
      `<div class="cl-user"${u.mine ? ' data-mine="true"' : ""}${u.other ? ' data-other="true"' : ""} title="${escapeHtml([u.user, u.coresText, share, u.detail].filter(Boolean).join(" · "))}">` +
      // 顺序即网格自动排布顺序：名字 + 核数同一行，细条与明细各占满一行。
      `<span class="cl-user-name">${escapeHtml(u.user)}${u.mine ? '<span class="cl-me">我</span>' : ""}</span>` +
      `<span class="cl-user-value">${escapeHtml(u.coresText)}</span>` +
      meterHtml(u.pct) +
      (u.detail ? `<span class="cl-user-detail">${escapeHtml(u.detail)}</span>` : "") +
      "</div>"
    );
  }).join("");
}

export function buildFiltersHtml(filters, node = null) {
  const chips = (Array.isArray(filters) ? filters : []).map((f) => (
    `<button type="button" class="cl-filter" data-cl-filter="${escapeHtml(f.key)}" aria-pressed="${f.active}"${f.disabled ? " disabled" : ""}>` +
    `${escapeHtml(f.label)}<span class="cl-filter-count">${escapeHtml(String(f.count))}</span></button>`
  ));
  if (node) {
    chips.push(
      `<button type="button" class="cl-filter cl-filter-node" data-cl-node="${escapeHtml(node)}" aria-pressed="true" title="取消按节点过滤">` +
      `节点 ${escapeHtml(node)}<span class="cl-filter-clear" aria-hidden="true">×</span></button>`,
    );
  }
  return chips.join("");
}

// 作业表的 tbody 行：单行紧凑，长文本省略（完整内容在行的悬停提示里）。空态单独一行跨满列。
export const JOB_COLUMNS = Object.freeze(["作业", "用户", "状态", "时长", "资源", "节点 / 原因"]);

// 时限进度细线（贴在时长单元格底边）：单个作业从左端画到已用比例；一组实验画组内最小–最大那一段。
// 颜色只读 data-tone（80% 转黄、95% 转红，见 cluster-model.progressTone）。
const pct1 = (value) => Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 1000) / 10;

function progressHtml(progress, tone) {
  if (progress == null) return "";
  const pct = pct1(progress);
  return `<span class="cl-job-progress" data-tone="${escapeHtml(tone || "ok")}" title="已用时限的 ${Math.round(pct)}%"><i style="width: ${pct}%"></i></span>`;
}

function progressRangeHtml(range) {
  if (!range) return "";
  const lo = pct1(range.lo);
  const hi = pct1(range.hi);
  // 至少 3px 宽（组内进度接近时仍看得见），且不画出轨道右端。
  return `<span class="cl-job-progress" data-tone="${escapeHtml(range.tone || "ok")}" title="组内进度 ${Math.round(lo)}%–${Math.round(hi)}%（已用 / 时限）">` +
    `<i style="left: min(${lo}%, calc(100% - 3px)); width: max(3px, ${Math.round((hi - lo) * 10) / 10}%)"></i></span>`;
}

function jobRowHtml(j, { child = false, groupKey = "", watches = null, queueOpen = new Set() } = {}) {
  const deadlockHint = j.deadlock && j.mine
    ? `<span class="cl-job-sub" data-tone="warn" title="前序依赖作业失败或取消，永远无法满足"> · 建议 scancel ${escapeHtml(j.id)}</span>`
    : j.cascadeDeadlock && j.mine
      ? `<span class="cl-job-sub" data-tone="warn" title="同流水线前序作业已死锁，此作业永远不会启动"> · 前序死锁</span>`
      : "";
  const slowHtml = j.slowAnomaly
    ? `<span class="cl-job-sub" data-tone="warn" title="${escapeHtml(j.slowAnomaly.title)}"> · ${escapeHtml(j.slowAnomaly.text)}</span>`
    : "";
  const gpuHazardHtml = j.gpuHazard
    ? `<span class="cl-job-sub" data-tone="${escapeHtml(j.gpuHazard.tone)}" title="${escapeHtml(j.gpuHazard.title)}"> · ${escapeHtml(j.gpuHazard.text)}</span>`
    : "";
  return `<tr data-group="${escapeHtml(j.group)}"${j.mine ? ' data-mine="true"' : ""}${j.deadlock ? ' data-deadlock="true"' : ""}${child ? ` class="cl-group-child" data-parent="${escapeHtml(groupKey)}"` : ""} title="${escapeHtml(j.title)}">` +
    `<td class="cl-job-id"><span class="cl-job-num">${escapeHtml(j.id)}</span><span class="cl-job-name">${escapeHtml(j.name || "—")}</span>${j.mine && watches ? buildWatchButton({ ids: [j.id], label: j.name, watched: watches.has(j.id) }) : ""}</td>` +
    `<td class="cl-job-user">${escapeHtml(j.user || "—")}${j.mine ? '<span class="cl-me">我</span>' : ""}</td>` +
    `<td><span class="cl-state" data-tone="${escapeHtml(j.state.tone)}"><span class="cl-dot" aria-hidden="true"></span>${escapeHtml(j.state.label)}</span></td>` +
    `<td class="cl-job-time">${escapeHtml(j.durationText)}${j.limitShort ? `<span class="cl-job-sub"> / ${escapeHtml(j.limitShort)}</span>` : ""}${slowHtml}${progressHtml(j.progress, j.progressTone)}</td>` +
    // 分区名不再跟在资源后面：节点列与节点卡已经说明了分区，完整信息在行的悬停提示里。
    `<td class="cl-job-res">${escapeHtml(j.resourceText)}${gpuHazardHtml}</td>` +
    `<td class="cl-job-where"${j.whereIsReason ? ' data-reason="true"' : ""}>${escapeHtml(j.where || "—")}${deadlockHint}</td>` +
    "</tr>" + (j.queueAdvice ? `<tr class="jw-queue-row${child ? " cl-group-child" : ""}"${child ? ` data-parent="${escapeHtml(groupKey)}"` : ""}><td colspan="${JOB_COLUMNS.length}"><details class="jw-queue-help" data-jw-queue="${escapeHtml(j.id)}"${queueOpen.has(j.id) ? " open" : ""}><summary>原因与建议${j.reasonRaw ? ` · ${escapeHtml(j.reasonRaw)}` : ""}${j.startEstimate ? `<span class="cl-job-sub" data-confidence="${escapeHtml(j.startEstimate.confidence)}" title="${escapeHtml(j.startEstimate.title)}"> · ${escapeHtml(j.startEstimate.text)}</span>` : ""}</summary><p>${escapeHtml(j.queueAdvice)}</p><p>${escapeHtml(j.startEstimate?.title || "")}</p></details></td></tr>` : "");
}

// 空态单独一行跨满列：empty 是一句话（字符串）或空状态 spec（emptyStateHtml 的参数，带图标 / 正文 / 动作）。
function emptyCellHtml(empty, fallback) {
  return empty && typeof empty === "object" ? emptyStateHtml(empty) : escapeHtml(empty || fallback);
}

function emptyRowHtml(empty) {
  return `<tr class="cl-job-empty"><td colspan="${JOB_COLUMNS.length}">${emptyCellHtml(empty, "队列里没有作业")}</td></tr>`;
}

export function buildJobRowsHtml(jobs, emptyText = "") {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return emptyRowHtml(emptyText);
  return list.map((j) => jobRowHtml(j)).join("");
}

// 同名实验组行（cluster-model.groupJobRows）：▸/▾ + 名字 + 数量 + 阶段分布；整行可点击展开 / 收起。
function groupRowHtml(g, watches = null, watchGroups = new Set()) {
  const state = [
    g.running ? `<span class="cl-state" data-tone="busy"><span class="cl-dot" aria-hidden="true"></span>${g.running} 运行中</span>` : "",
    g.pending ? `<span class="cl-state cl-state-tail" data-tone="pending"><span class="cl-dot" aria-hidden="true"></span>${g.pending} 排队</span>` : "",
  ].join("");
  return `<tr class="cl-group" data-cl-group="${escapeHtml(g.key)}"${g.mine ? ' data-mine="true"' : ""} aria-expanded="${g.expanded}" tabindex="0" title="${escapeHtml(g.title)}">` +
    `<td class="cl-job-id"><span class="cl-group-caret" aria-hidden="true">${g.expanded ? "▾" : "▸"}</span>` +
    `<span class="cl-job-name">${escapeHtml(g.label)}</span><span class="cl-group-count">×${g.count}</span>` +
    `${g.stagesText ? `<span class="cl-job-sub cl-group-stages">${escapeHtml(g.stagesText)}</span>` : ""}${g.mine && watches ? buildWatchButton({ ids: g.jobIds || [], label: g.label, group: true, watched: Boolean(watchGroups?.size && watchGroups.has([...(g.jobIds || [])].sort().join(","))) }) : ""}</td>` +
    `<td class="cl-job-user">${escapeHtml(g.user || "—")}${g.mine ? '<span class="cl-me">我</span>' : ""}</td>` +
    `<td>${state}</td>` +
    `<td class="cl-job-time">${escapeHtml(g.timeText || "—")}${progressRangeHtml(g.progress)}</td>` +
    `<td class="cl-job-res">${escapeHtml(g.resText || "—")}</td>` +
    `<td class="cl-job-where"${g.whereIsReason ? ' data-reason="true"' : ""}>${escapeHtml(g.where || "—")}</td>` +
    "</tr>";
}

// 分组后的表格行（groupJobRows 的 rows）。
export function buildGroupedJobRowsHtml(rows, emptyText = "", { watches = null, watchGroups = new Set(), queueOpen = new Set() } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return emptyRowHtml(emptyText);
  return list.map((row) => (row.kind === "group" ? groupRowHtml(row, watches, watchGroups) : jobRowHtml(row.job, { child: row.child, groupKey: row.groupKey, watches, queueOpen }))).join("");
}

// 空闲算力雷达（最佳投递建议）：展示无需排队即可立即调度的推荐 GPU / CPU 节点与一键复制 srun / #SBATCH 按钮。
export function buildIdleRadarHtml(radar) {
  if (!radar?.visible) return "";
  const parts = ['<span class="cl-mine-label">空闲算力雷达</span>'];
  if (radar.bestGpu) {
    const g = radar.bestGpu;
    const detail = [
      `空 ${formatCount(g.freeGpus)} 卡`,
      g.model ? g.model : "",
      g.freeCpus > 0 ? `${formatCount(g.freeCpus)} 核` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    parts.push(
      `<span class="cl-mine-item" data-tone="busy">GPU 最佳 <b>${escapeHtml(g.node)}</b>（${escapeHtml(detail)}）</span>` +
        `<button type="button" class="text-btn cl-radar-copy" data-cl-diag-copy="${escapeHtml(g.srunCmd)}" title="复制交互式 GPU 上机命令：${escapeHtml(g.srunCmd)}">复制 srun</button>` +
        `<button type="button" class="text-btn cl-radar-copy" data-cl-diag-copy="${escapeHtml(g.sbatchSnippet)}" title="复制 #SBATCH 节点与 GPU 参数：${escapeHtml(g.sbatchSnippet)}">复制 #SBATCH</button>`
    );
  }
  if (radar.bestCpu && (!radar.bestGpu || radar.bestCpu.node !== radar.bestGpu.node)) {
    const c = radar.bestCpu;
    parts.push(
      `<span class="cl-mine-item">CPU 最佳 <b>${escapeHtml(c.node)}</b>（空 ${formatCount(c.freeCpus)} 核）</span>` +
        `<button type="button" class="text-btn cl-radar-copy" data-cl-diag-copy="${escapeHtml(c.srunCmd)}" title="复制交互式 CPU 上机命令：${escapeHtml(c.srunCmd)}">复制 srun</button>`
    );
  }
  return parts.join("");
}

// 作业表上方「我的」汇总条。
export function buildMineSummaryHtml(mine) {
  if (!mine?.visible) return "";
  const items = [
    mine.count ? `<span class="cl-mine-label">我的</span><span class="cl-mine-item"><b>${formatCount(mine.count)}</b> 个作业</span>` : "",
    mine.count ? `<span class="cl-mine-item" data-tone="busy"><b>${formatCount(mine.running)}</b> 运行中</span>` : "",
    mine.count ? `<span class="cl-mine-item"><b>${formatCount(mine.pending)}</b> 排队</span>` : "",
    mine.cores ? `<span class="cl-mine-item">占用 <b>${formatCount(mine.cores)}</b> 核${mine.gpus ? ` · <b>${formatCount(mine.gpus)}</b> 卡` : ""}</span>` : "",
    mine.deadlockChain
      ? `<span class="cl-mine-item" data-tone="warn" title="前序依赖失败，这些排队作业永远不会启动">${escapeHtml(mine.deadlockChain.text)}</span>` +
        `<button type="button" class="text-btn cl-mine-scancel" data-cl-diag-copy="${escapeHtml(mine.deadlockChain.command)}" title="复制整链清理命令：${escapeHtml(mine.deadlockChain.command)}">复制 scancel</button>`
      : "",
    mine.groups ? `<span class="cl-mine-item cl-mine-groups">${mine.collapsed ? `${mine.collapsed} 组实验已折叠` : `${mine.groups} 组实验已展开`}</span>` : "",
    mine.groups ? `<button type="button" class="text-btn cl-expand-all" data-cl-expand-all="${mine.allExpanded ? "collapse" : "expand"}">${mine.allExpanded ? "全部折叠" : "全部展开"}</button>` : "",
  ];
  return items.join("");
}

// ---- 我的历史 · 48 小时（模型见 cluster-history-model.js） ----

export const HISTORY_COLUMNS = Object.freeze(["作业", "状态", "结束", "耗时", "节点 · 分区", "退出"]);

function stateHtml(state) {
  return `<span class="cl-state" data-tone="${escapeHtml(state.tone)}"><span class="cl-dot" aria-hidden="true"></span>${escapeHtml(state.label)}</span>`;
}

// 汇总条（沿用「我的」汇总条的样式）：近 48 小时 · N 个已结束 · N 完成 · N 失败 / 超时 · N 取消。
export function buildHistorySummaryHtml(summary) {
  if (!summary?.visible) return "";
  return (
    `<span class="cl-mine-label">${escapeHtml(summary.label || "近 48 小时")}</span>` +
    (summary.items || []).map((it) => (
      `<span class="cl-mine-item"${it.tone ? ` data-tone="${escapeHtml(it.tone)}"` : ""}><b>${escapeHtml(it.value)}</b> ${escapeHtml(it.label)}</span>`
    )).join("") +
    (summary.hint ? `<span class="cl-mine-item cl-mine-groups">${escapeHtml(summary.hint)}</span>` : "") +
    (summary.fresh ? `<span class="cl-mine-item cl-hist-fresh" title="${escapeHtml(summary.freshTitle || "")}">${escapeHtml(summary.fresh)}</span>` : "")
  );
}

export function buildHistoryFiltersHtml(filters) {
  return (Array.isArray(filters) ? filters : []).map((f) => (
    `<button type="button" class="cl-filter" data-cl-hist-filter="${escapeHtml(f.key)}" aria-pressed="${f.active}">` +
    `${escapeHtml(f.label)}<span class="cl-filter-count">${escapeHtml(formatCount(f.count))}</span></button>`
  )).join("");
}

// ---- 失败作业诊断（v2.49，模型见 cluster-diagnosis-model.js）：原因行紧跟作业行，展开内容就在原因行里 ----
// 日志尾部、路径、脚本都是不可信文本：一律 escapeHtml，<pre> 只靠 CSS 保留空白。

function diagScriptHtml(d) {
  const s = d.script;
  if (!s.available) return '<span class="cl-diag-muted">提交脚本已不可得</span>';
  const label = s.state === "loading" ? "读取中…" : s.state === "error" ? "重新读取脚本" : s.open && s.state !== "idle" ? "收起脚本" : "查看提交脚本";
  return `<button type="button" class="text-btn cl-diag-script-btn" data-cl-diag-script="${escapeHtml(d.jobId)}" aria-expanded="${s.open && (s.state === "ok" || s.state === "missing")}"${s.state === "loading" ? " disabled" : ""}>${label}</button>`;
}

function diagScriptBodyHtml(s) {
  if (!s.available || !s.open) return "";
  if (s.state === "ok") return `<pre class="cl-diag-pre cl-diag-script">${escapeHtml(s.text)}</pre>`;
  if (s.state === "missing") return '<p class="cl-diag-muted">脚本已不可得</p>';
  if (s.state === "error") return `<p class="cl-diag-muted">脚本读取失败：${escapeHtml(s.error)}</p>`;
  return "";
}

// logReader(d)：v2.51「读取前一段」（render/log-readback-view.js），接在日志路径列表之后。
function diagDetailHtml(d, serverId, logReader = null, r = null) {
  const files = d.files.map((f) => (
    `<li><code class="cl-diag-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</code>` +
    `<button type="button" class="text-btn cl-diag-copy" data-cl-diag-copy="${escapeHtml(f.path)}" title="复制日志路径">复制</button></li>`
  )).join("");
  const firstPath = String(d.files?.[0]?.path || "");
  const slashIdx = firstPath.lastIndexOf("/");
  const logDir = slashIdx > 0 ? firstPath.slice(0, slashIdx) : "";
  const copyPrompt = buildAgentDiagnosisPrompt(d, r);
  return '<div class="cl-diag-detail">' +
    (d.evidence.length ? `<pre class="cl-diag-pre cl-diag-evidence">${escapeHtml(d.evidence.join("\n"))}</pre>` : "") +
    (files ? `<ul class="cl-diag-files">${files}</ul>` : "") +
    (files && typeof logReader === "function" ? logReader(d) : "") +
    `<div class="cl-diag-actions">${diagScriptHtml(d)}${d.sourceText ? `<span class="cl-diag-muted">${escapeHtml(d.sourceText)}</span>` : ""}${logDir ? `<button type="button" class="text-btn cl-diag-copy-cd" data-cl-diag-copy="cd ${escapeHtml(logDir)}" title="复制进入日志所在目录命令：cd ${escapeHtml(logDir)}">复制 cd 目录</button>` : ""}${copyPrompt ? `<button type="button" class="text-btn cl-diag-copy-agent" data-cl-diag-copy="${escapeHtml(copyPrompt)}" title="复制诊断结论、日志路径与关键报错，可直接粘贴给 Claude Code / Codex">复制排障上下文</button>` : ""}${serverId ? `<button type="button" class="text-btn" data-job-report="${escapeHtml(d.jobId)}" data-report-server="${escapeHtml(serverId)}">生成排障报告</button>` : ""}</div>` +
    diagScriptBodyHtml(d.script) +
    "</div>";
}

// 原因行：分类小标签 + 一行 headline（等宽、单行省略，完整内容在悬停提示）；日志已不可得只写一句灰字。
// 可展开时整行可点（data-cl-diag，与作业行同一开关），展开内容画在同一格里。
function diagRowHtml(r, serverId, logReader = null) {
  const d = r.diag;
  const line = d.noLog
    ? `<span class="cl-diag-muted">${escapeHtml(NO_LOG_TEXT)}</span>`
    : `<span class="cl-diag-tag" data-category="${escapeHtml(d.category)}">${escapeHtml(d.label)}</span>` +
      `<span class="cl-diag-headline" title="${escapeHtml(d.headline)}">${escapeHtml(d.headline)}</span>`;
  return `<tr class="cl-diag${r.child ? " cl-group-child" : ""}" data-kind="${escapeHtml(r.rowKind)}"${r.level ? ` data-level="${escapeHtml(r.level)}"` : ""}${r.child ? ` data-parent="${escapeHtml(r.parent)}"` : ""}>` +
    `<td class="cl-diag-cell" colspan="${HISTORY_COLUMNS.length}">` +
    `<div class="cl-diag-line"${d.expandable ? ` data-cl-diag="${escapeHtml(d.jobId)}"` : ""}>` +
    (d.expandable ? `<span class="cl-group-caret" aria-hidden="true">${d.open ? "▾" : "▸"}</span>` : "") +
    `${line}</div>` +
    (d.open ? diagDetailHtml(d, serverId, logReader, r) : "") +
    "</td></tr>";
}

// 顶部同因合并（不是新卡片，只是列表上方的几行可点筛选）：「10 个失败同因：KeyError: 'arm'」。
export function buildHistoryCausesHtml(causes) {
  const items = Array.isArray(causes?.items) ? causes.items : [];
  if (!items.length) return "";
  const lines = items.map((c) => (
    `<button type="button" class="cl-diag-cause" data-cl-diag-cause="${escapeHtml(c.key)}" aria-pressed="${Boolean(c.active)}" title="${escapeHtml(c.title)}">` +
    `<span class="cl-diag-cause-count">${escapeHtml(formatCount(c.count))} 个失败同因：</span>` +
    `<span class="cl-diag-headline">${escapeHtml(c.headline)}</span></button>`
  )).join("");
  const foot = [
    causes.more > 0 ? `<span class="cl-diag-muted">另有 ${escapeHtml(formatCount(causes.more))} 类</span>` : "",
    causes.active ? '<button type="button" class="text-btn cl-diag-all" data-cl-diag-cause-clear="1">显示全部</button>' : "",
  ].join("");
  return lines + (foot ? `<div class="cl-diag-causes-foot">${foot}</div>` : "");
}

// 有问题的行（失败 / 取消）带 data-level：首列左侧一道状态色。
// 带诊断的失败行后面紧跟一行原因；能展开的作业行可聚焦（Enter / 空格与点击同一路径）。
function historyJobRowHtml(r, { resources = null, resourceOpen = new Set(), serverId = null, logReader = null } = {}) {
  const d = r.diag;
  const classes = [r.child ? "cl-group-child" : "", d ? "cl-has-diag" : ""].filter(Boolean).join(" ");
  const toggle = d?.expandable ? ` data-cl-diag="${escapeHtml(d.jobId)}" aria-expanded="${d.open}" tabindex="0"` : "";
  const sessionHtml = r.session
    ? `<span class="cl-job-sub cl-job-session" title="${escapeHtml(`关联 Agent 会话：${r.session.agent || "Agent"} · ${r.session.title || r.session.id}`)}"> · ${escapeHtml(r.session.agent || "Agent")}</span>`
    : "";
  const slowHtml = r.slowAnomaly
    ? `<span class="cl-job-sub" data-tone="warn" title="${escapeHtml(r.slowAnomaly.title)}"> · ${escapeHtml(r.slowAnomaly.text)}</span>`
    : "";
  return `<tr data-kind="${escapeHtml(r.rowKind)}"${r.level ? ` data-level="${escapeHtml(r.level)}"` : ""}${classes ? ` class="${classes}"` : ""}${r.child ? ` data-parent="${escapeHtml(r.parent)}"` : ""}${toggle} title="${escapeHtml(r.title)}" data-history-job-id="${escapeHtml(r.id)}">` +
    `<td class="cl-job-id"><span class="cl-job-num">${escapeHtml(r.id)}</span><span class="cl-job-name">${escapeHtml(r.name || "—")}</span>${sessionHtml}</td>` +
    `<td>${stateHtml(r.state)}</td>` +
    `<td class="cl-job-end">${escapeHtml(r.endText)}</td>` +
    `<td class="cl-job-time">${escapeHtml(r.elapsedText)}${slowHtml}</td>` +
    `<td class="cl-job-where">${escapeHtml(r.where)}</td>` +
    `<td class="cl-job-exit">${escapeHtml(r.exitText)}${resources ? `<button type="button" class="text-btn jw-review-btn" data-job-resource="${escapeHtml(r.id)}" aria-expanded="${resourceOpen.has(r.id)}">资源复盘</button>` : ""}</td>` +
    "</tr>" +
    (d ? diagRowHtml(r, serverId, logReader) : "") +
    (resources && resourceOpen.has(r.id) ? `<tr class="jw-review-row"><td colspan="${HISTORY_COLUMNS.length}">${buildResourceReviewHtml(resources.get(r.id))}</td></tr>` : "");
}

function historyGroupRowHtml(g) {
  return `<tr class="cl-group" data-cl-hist-group="${escapeHtml(g.key)}" data-kind="${escapeHtml(g.rowKind)}"${g.level ? ` data-level="${escapeHtml(g.level)}"` : ""} aria-expanded="${g.expanded}" tabindex="0" title="${escapeHtml(g.title)}">` +
    `<td class="cl-job-id"><span class="cl-group-caret" aria-hidden="true">${g.expanded ? "▾" : "▸"}</span>` +
    `<span class="cl-job-name">${escapeHtml(g.label)}</span><span class="cl-group-count">×${escapeHtml(String(g.count))}</span>` +
    `${g.stagesText ? `<span class="cl-job-sub cl-group-stages">${escapeHtml(g.stagesText)}</span>` : ""}</td>` +
    `<td>${stateHtml(g.state)}</td>` +
    `<td class="cl-job-end">${escapeHtml(g.endText)}</td>` +
    `<td class="cl-job-time">${escapeHtml(g.elapsedText)}</td>` +
    `<td class="cl-job-where">${escapeHtml(g.where)}</td>` +
    `<td class="cl-job-exit">${escapeHtml(g.exitText)}</td>` +
    "</tr>";
}

export function buildHistoryRowsHtml(rows, emptyText = "", options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `<tr class="cl-job-empty"><td colspan="${HISTORY_COLUMNS.length}">${emptyCellHtml(emptyText, "近 48 小时没有结束的作业")}</td></tr>`;
  return list.map((row) => {
    if (row.kind === "group") return historyGroupRowHtml(row);
    // v2.51：组内「加载更多」与「更早…」的段头（cluster-history-lookup.js）。
    if (row.kind === "more") return buildMoreRowHtml(row, HISTORY_COLUMNS.length);
    if (row.kind === "segment") return buildSegmentRowHtml(row, HISTORY_COLUMNS.length);
    return historyJobRowHtml(row, options);
  }).join("");
}
