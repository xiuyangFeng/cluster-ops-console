// attention.js —— v2.15 注意力队列：替代"单条告警横幅"的统一告警视图。
// 三类数据源（纯前端从 render(status) 已有数据推导）：
//   a) 通道健康 —— 复用 #alertBanner + renderAlertBanner（一键修复行为不变）；
//   b) 指标越线 —— status.serversBrief 的 cpu/ram/disk 按 thresholds.js 的 ALERT_THRESHOLDS 推导；
//   c) Doctor 警告 —— status.doctor.summary 的 warn/fail 计数。
// 按严重度排序，最多平铺 FLAT_LIMIT 条（通道异常条计入），多余折叠为"还有 N 项"。
// 注意：signalBanner 红条有独立数据通路，本模块不碰。
// 纯函数(buildAttentionItems/extractDiskCapacity) + 惰性 getEl，Node 可 import 测试。
import { createElementLookup } from "../dom-utils.js";
import { escapeHtml } from "../store.js";
import { ALERT_THRESHOLDS } from "../thresholds.js";
import { BUTTON_LABELS } from "../ui-labels.js";
import { renderAlertBanner, getDiagnosticMsg } from "./checklist.js";
import { buildOccupancy } from "./resources-model.js";

// 平铺上限：含通道异常条在内最多 3 条，其余折叠
export const FLAT_LIMIT = 3;

const getEl = createElementLookup();

// 从 serversBrief.output（hostname/uptime/free/df 原始输出）提取磁盘容量文本，
// df -h 行格式：Filesystem Size Used Avail Use% Mounted → "41T/44T"（已用/总量）。
export function extractDiskCapacity(output) {
  if (!output) return "";
  const m = String(output).match(/(\d+(?:[.,]\d+)?[KMGTP]i?B?)\s+(\d+(?:[.,]\d+)?[KMGTP]i?B?)\s+\S+\s+\d+%/);
  return m ? `${m[2]}/${m[1]}` : "";
}

// 服务器展示名：优先 serversBrief 的 displayName/name，取不到时退回 serverId
// （隧道层条目可能先于 serversBrief 到达，此时至少让人看得出是哪台）。
function serverNameOf(status, id) {
  const brief = status?.serversBrief || {};
  const s = brief[id];
  return (s && (s.displayName || s.name)) || id;
}

// 次要隧道断开的 serverId 列表：从 layers.tunnels 推导，level==="error" 且不是活跃服务器的
// 条目即为"次要隧道断开"（设计稿 §6.3：这类项不参与 computeHealth，只在注意力队列出一条
// "不影响主链路"的 warn）。
function resolveSecondaryTunnelDown(status) {
  const tunnels = status?.layers?.tunnels;
  if (!tunnels || typeof tunnels !== "object") return [];
  const activeId = status?.activeServerId;
  return Object.entries(tunnels)
    .filter(([id, t]) => id !== activeId && t && t.level === "error")
    .map(([id]) => id);
}

// 未解决事件里的磁盘超阈值（DISK_THRESHOLD）→ serverId → { incidentId, quiet }。
// quiet = 已确认或稍后提醒中：磁盘条目不再进队列（共享卷长期高位、用户无从清理时不常驻黄条）；
// 后端在用量比确认时再涨 2 个百分点时自动解除确认，条目随之回来。
export function diskIncidentsByServer(openIncidents, nowMs = Date.now()) {
  const map = {};
  for (const inc of Array.isArray(openIncidents) ? openIncidents : []) {
    if (inc?.reasonCode !== "DISK_THRESHOLD" || inc.lifecycle === "resolved" || !inc.serverId || !inc.incidentId) continue;
    const snoozedUntil = inc.attention?.snoozedUntil;
    const quiet = Boolean(inc.attention?.acknowledgedAt) || (Number.isFinite(snoozedUntil) && snoozedUntil > nowMs);
    map[inc.serverId] = { incidentId: inc.incidentId, quiet };
  }
  return map;
}

// 推导指标/Doctor/隧道/自动修复告警条目（纯函数）。cpuStreaks: serverId → 连续越线帧数；
// diskIncidents: diskIncidentsByServer() 的结果。severity: "critical" > "warn"；返回已按严重度稳定排序。
export function buildAttentionItems(status, cpuStreaks = {}, diskIncidents = {}) {
  const items = [];
  const brief = status.serversBrief || {};

  // 自动修复已达上限：策略层降级为人工，必须置顶——先入队即在同级 critical 中最前
  // （下方稳定排序保持同级插入序）。
  if (status.autoRepairExhausted === true) {
    items.push({ severity: "critical", kind: "auto-repair-exhausted", text: "自动修复已达上限，需人工处理" });
  }

  for (const [id, s] of Object.entries(brief)) {
    if (!s?.ok) continue;
    const name = s.displayName || s.name || id;
    const cap = extractDiskCapacity(s.output);
    const capText = cap ? ` (${cap})` : "";

    const diskIncident = diskIncidents[id] || null;
    if (s.disk >= ALERT_THRESHOLDS.diskWarn && !diskIncident?.quiet) {
      items.push({
        severity: s.disk >= ALERT_THRESHOLDS.diskCrit ? "critical" : "warn",
        kind: "metric",
        serverId: id,
        // 有对应事件才能"已知晓"（确认该事件）；事件尚未建立时只有定位
        ...(diskIncident ? { incidentId: diskIncident.incidentId } : {}),
        text: `${name} 磁盘 ${s.disk}%${capText}`,
      });
    }

    // v2.62：内存 / CPU 两条带上占用现场那一句（谁在用、是不是 Slurm 作业——与服务器页资源面板那一行是
    // 同一句，buildOccupancy 一处生成），只放进悬停提示：服务器页上那两块指标自己会写出来，这里不再占一行。
    // 没采到（旧采集脚本等）就不带。
    const procTop = status.layers?.resources?.[id]?.procTop;
    const withOccupancy = (item, metric) => {
      const detail = buildOccupancy(procTop, metric)?.text;
      return detail ? { ...item, detail } : item;
    };

    if (s.ram >= ALERT_THRESHOLDS.ramWarn) {
      items.push(withOccupancy({ severity: "warn", kind: "metric", serverId: id, text: `${name} 内存 ${s.ram}%` }, "memory"));
    }

    if (s.cpu >= ALERT_THRESHOLDS.cpuWarn && (cpuStreaks[id] || 0) >= ALERT_THRESHOLDS.cpuStreakFrames) {
      items.push(withOccupancy({ severity: "warn", kind: "metric", serverId: id, text: `${name} CPU ${s.cpu}% 持续高位` }, "cpu"));
    }
  }

  // 次要隧道断开：warn 级，文案明确"不影响主链路"，避免与通道条抢注意力。
  for (const id of resolveSecondaryTunnelDown(status)) {
    items.push({
      severity: "warn",
      kind: "tunnel-secondary",
      serverId: id,
      text: `${serverNameOf(status, id)} 隧道断开 · 不影响主链路`,
    });
  }

  // 反向端口被异己占用：孤儿隧道认领失败/别人占了同一端口，自动修复无从下手，给处置方向。
  const foreign = Array.isArray(status.tunnelPortForeign) ? status.tunnelPortForeign : [];
  for (const id of foreign) {
    items.push({
      severity: "warn",
      kind: "tunnel-port-foreign",
      serverId: id,
      text: `${serverNameOf(status, id)} 反向端口被其他进程占用，可重新分配一个空闲端口`,
    });
  }

  // 只有 fail 进注意力队列。warn 是建议级提示（rollout 文件缺失/可更新等），不影响
  // 使用——放这里会常驻黄条制造告警疲劳；其内容在 Agent 卡抽屉与 Doctor 浮层展示。
  const summary = status.doctor?.summary ? status.doctor.summary : null;
  if (summary && summary.fail > 0) {
    items.push({ severity: "critical", kind: "doctor", text: `Doctor 报告 ${summary.fail} 项失败` });
  }

  // 本机出网中断（egressHealth.state === "error"）：隧道与本机代理虽在线，但本机转发出网连续失败。
  if (status.shouldBeRunning !== false && status.localProxyUp && status.egressHealth?.state === "error") {
    const egSummary = status.egressHealth.summary || "上游代理不可达";
    items.push({
      severity: "critical",
      kind: "egress",
      text: `本机出网中断 · ${egSummary}`,
    });
  }

  // 稳定排序：critical 前置，同级保持推导顺序
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.severity === b.item.severity ? a.i - b.i : a.item.severity === "critical" ? -1 : 1))
    .map(({ item }) => item);
}

// cpu 连续越线帧计数。按 status.updatedAt 去重（rAF 合并/重复渲染不重复计帧）。
const cpuStreaks = {};
let lastFrameKey = null;
export function updateCpuStreaks(status, streaks = cpuStreaks) {
  const frameKey = status.updatedAt ?? null;
  if (frameKey != null && frameKey === lastFrameKey) return streaks;
  lastFrameKey = frameKey;
  const brief = status.serversBrief || {};
  for (const [id, s] of Object.entries(brief)) {
    if (s?.ok && s.cpu >= ALERT_THRESHOLDS.cpuWarn) {
      streaks[id] = (streaks[id] || 0) + 1;
    } else {
      streaks[id] = 0;
    }
  }
  return streaks;
}

// ---- 渲染 ----

let expanded = false;
let bound = false;
let lastStatus = null;
let lastSig = "";

// 注意力队列回调（app.js 经 initAttentionQueue 注入）：模块级存放，Node 下无 DOM 也安全。
// onOpenDialog = app/dialogs.openDialog：打开浮层必须走它，登记在该浮层上的打开钩子
// （dlgDoctor/dlgEndpoint 补渲、dlgLogs 拉日志）才会执行；直接 showModal 会打开一个旧内容的浮层。
// onAcknowledgeIncident(incidentId) = 事件「确认已看到」（磁盘条目的「已知晓」）。
let attentionCallbacks = {};
export function initAttentionQueue({ onReassignPort, onOpenDialog, onAcknowledgeIncident } = {}) {
  attentionCallbacks = { onReassignPort, onOpenDialog, onAcknowledgeIncident };
}

// 未解决事件（incidents-controller 每次拉到 open 列表后注入）：磁盘条目据此决定是否进队列。
let diskIncidents = {};
export function setAttentionIncidents(openIncidents) {
  const next = diskIncidentsByServer(openIncidents);
  if (JSON.stringify(next) === JSON.stringify(diskIncidents)) return;
  diskIncidents = next;
  if (lastStatus) renderAttentionQueue(lastStatus);
}

// 条目行动按钮：带 serverId 的条目（指标越线/隧道类）滚到服务器面板定位；
// 自动修复已达上限指向运维日志（人工接手前先看策略层做过什么）；其余进 Doctor 浮层。
// 纯函数，导出供测试断言转义。
export function actionHtml(item) {
  if (item.kind === "auto-repair-exhausted") {
    return '<button type="button" class="text-btn attention-action" data-action="logs">查看日志</button>';
  }
  if (item.kind === "egress") {
    return '<button type="button" class="text-btn attention-action" data-action="egress">打开出网设置</button>';
  }
  // W5：端口被异己占用 → L2 处置"重新分配端口…"（预览建议端口 → 确认写配置 → 单隧道重启），
  // 定位按钮保留。
  if (item.kind === "tunnel-port-foreign") {
    return `<button type="button" class="text-btn attention-action" data-action="reassign-port" data-server-id="${escapeHtml(item.serverId)}">${escapeHtml(BUTTON_LABELS.reassignPort)}</button>`
      + '<button type="button" class="text-btn attention-action" data-action="locate">定位</button>';
  }
  if (item.kind === "metric" && item.incidentId) {
    return `<button type="button" class="text-btn attention-action" data-action="ack-incident" data-incident-id="${escapeHtml(item.incidentId)}" title="不再在这里提醒；用量再涨 2% 会重新提醒">已知晓</button>`
      + '<button type="button" class="text-btn attention-action" data-action="locate">定位</button>';
  }
  if (item.kind === "metric" || item.kind === "tunnel-secondary") {
    return '<button type="button" class="text-btn attention-action" data-action="locate">定位</button>';
  }
  return '<button type="button" class="text-btn attention-action" data-action="doctor">查看详情</button>';
}

// item.detail（内存 / CPU 条目的占用现场一句话）写成正文的悬停提示。导出供测试断言转义。
export function itemHtml(item) {
  const action = actionHtml(item);
  const detail = item.detail ? ` title="${escapeHtml(item.detail)}"` : "";
  return `
    <div class="attention-item severity-${item.severity}">
      <span class="attention-text"${detail}>${escapeHtml(item.text)}</span>
      ${action}
    </div>`;
}

function bindEvents() {
  if (bound || typeof document === "undefined") return;
  const itemsEl = getEl("attentionItems");
  if (!itemsEl) return;
  itemsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const act = btn.dataset.action;
    if (act === "locate") {
      document.querySelector(".panel-servers")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (act === "doctor" || act === "logs") {
      attentionCallbacks.onOpenDialog?.(act === "doctor" ? "dlgDoctor" : "dlgLogs");
    } else if (act === "egress") {
      attentionCallbacks.onOpenDialog?.("dlgSettings");
      const section = getEl("settingsEgress");
      if (section) {
        section.open = true;
        section.scrollIntoView?.({ behavior: "smooth", block: "start" });
      }
    } else if (act === "ack-incident") {
      const incidentId = btn.dataset.incidentId || "";
      if (incidentId && typeof attentionCallbacks.onAcknowledgeIncident === "function") attentionCallbacks.onAcknowledgeIncident(incidentId);
    } else if (act === "reassign-port") {
      const serverId = btn.dataset.serverId || "";
      if (serverId && typeof attentionCallbacks.onReassignPort === "function") attentionCallbacks.onReassignPort(serverId);
    } else if (act === "toggle-more") {
      expanded = !expanded;
      lastSig = ""; // 强制重绘
      if (lastStatus) renderAttentionQueue(lastStatus);
    }
  });
  bound = true;
}

// 渲染注意力队列。返回 { topItem, items }（topItem 供粘性状态条展示最严重一条）。
// 通道条（#alertBanner）：ready 时隐藏（与页头「通道 已连接」重复，白占一行）；
// down/degraded 时带一键修复按钮并排在队列最前（flex order=0）；等待 / 停止时照常显示。
export function renderAttentionQueue(status) {
  const health = status.health || "down";
  const info = getDiagnosticMsg(status);
  renderAlertBanner(health, info);

  lastStatus = status;
  updateCpuStreaks(status);
  const items = buildAttentionItems(status, cpuStreaks, diskIncidents);
  const bannerUnhealthy = health === "down" || health === "degraded";
  const topItem = bannerUnhealthy
    ? { severity: health === "down" ? "critical" : "warn", kind: "channel", text: info.title }
    : items[0] || null;

  const itemsEl = getEl("attentionItems");
  const banner = getEl("alertBanner");
  if (!itemsEl) return { topItem, items };
  bindEvents();

  // 排序：通道异常条置顶(order 0)，指标/Doctor 条居中(order 1)，健康绿细条垫底(order 2)。
  // renderAlertBanner 只覆写 className，不碰 style，order 可安全存放于 style。
  if (banner) {
    banner.style.order = bannerUnhealthy || info.attention ? "0" : "2";
    const display = health === "ready" && !info.attention ? "none" : "";
    if (banner.style.display !== display) banner.style.display = display;
  }
  itemsEl.style.order = "1";

  const cap = Math.max(0, FLAT_LIMIT - (bannerUnhealthy ? 1 : 0));
  const visible = expanded ? items : items.slice(0, cap);
  const hiddenCount = items.length - visible.length;

  const sig = JSON.stringify([expanded, visible, hiddenCount]);
  if (sig === lastSig) return { topItem, items };
  lastSig = sig;

  let html = visible.map(itemHtml).join("");
  if (hiddenCount > 0) {
    html += `<button type="button" class="text-btn attention-more" data-action="toggle-more">还有 ${hiddenCount} 项 ▾</button>`;
  } else if (expanded && items.length > cap) {
    html += '<button type="button" class="text-btn attention-more" data-action="toggle-more">收起 ▴</button>';
  }
  itemsEl.innerHTML = html;
  itemsEl.style.display = html ? "" : "none";
  return { topItem, items };
}
