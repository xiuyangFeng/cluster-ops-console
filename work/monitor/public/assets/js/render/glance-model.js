// glance-model.js —— 「一眼看」读数：菜单栏托盘旁的数字与悬浮岛的集群区共用（纯函数，Node 可直接 import）。
// 数据源是 /api/status（layers.tunnels / layers.resources / serversBrief）；Slurm 计数全部取自
// cluster-model.js 的 buildClusterPanelModel（与主控制台集群面板同一口径），这里只挑字段、不另算。
// 托盘在 Electron 主进程里 import 本文件（desktop/tray-glance.mjs），所以这里和依赖链都不能碰 DOM。

import { serverShortName } from "../display-names.js";
import { clampPct, finite } from "../thresholds.js";
import { buildClusterPanelModel } from "./cluster-model.js";

// 菜单栏数字显示哪一项（托盘右键菜单「菜单栏显示」，存 runtime/widget-state.json）。
export const GLANCE_METRICS = Object.freeze(["gpu", "cpu", "mine", "off"]);
export const DEFAULT_GLANCE_METRIC = "gpu";
export const GLANCE_METRIC_LABELS = Object.freeze({ gpu: "GPU 在用", cpu: "CPU 核分配", mine: "我的作业", off: "不显示" });

export function normalizeGlanceMetric(value) {
  return GLANCE_METRICS.includes(value) ? value : DEFAULT_GLANCE_METRIC;
}

// layers.tunnels[id].level → 链路点：ok 通 / warn 存疑 / down 断 / off 不建隧道或已停止 / waiting 等首次探测。
function linkOf(tunnel) {
  const level = tunnel?.level;
  if (level === "ok") return "ok";
  if (level === "warn") return "warn";
  if (level === "error") return "down";
  if (level === "skipped") return "off";
  return "waiting";
}

function clusterGlance(layer, now) {
  const model = buildClusterPanelModel({ layer, now });
  if (!model.visible || !model.glance) return null;
  const kpi = (key) => model.kpis.find((item) => item.key === key);
  return {
    ...model.glance,
    // 每台节点一个状态点（tone：busy / idle / warn / critical），顺序与集群面板节点卡相同。
    nodes: kpi("nodes")?.visual?.dots || [],
    // 按节点分组的 GPU 卡位（slots[].fill：已分配 / 利用率 0–1）。
    gpuGroups: kpi("gpu")?.visual?.groups || [],
    mine: model.viewer ? { user: model.viewer, running: model.mine.running, pending: model.mine.pending } : null,
    freshness: model.freshness,
    errorText: model.errorText,
  };
}

// status = /api/status 载荷。servers 按 layers.tunnels 的顺序（即配置顺序），active 是查看中的那台；
// cluster 只看查看中服务器的 Slurm 快照，不是 Slurm 集群时为 null。
export function buildGlanceModel(status, { now = Date.now() } = {}) {
  const layers = status?.layers && typeof status.layers === "object" ? status.layers : {};
  const tunnels = layers.tunnels && typeof layers.tunnels === "object" ? layers.tunnels : {};
  const resources = layers.resources && typeof layers.resources === "object" ? layers.resources : {};
  const ids = [...new Set([...Object.keys(tunnels), ...Object.keys(resources)])];
  const servers = ids.map((id) => {
    const res = resources[id] || null;
    return {
      id,
      name: serverShortName(status, id),
      active: id === status?.activeServerId,
      link: linkOf(tunnels[id]),
      linkReason: String(tunnels[id]?.reason || ""),
      loadOk: res?.level === "ok",
      cpu: finite(res?.cpu) == null ? null : clampPct(res.cpu),
      ram: finite(res?.ram) == null ? null : clampPct(res.ram),
    };
  });
  const active = servers.find((s) => s.active) || servers[0] || null;
  const linked = servers.filter((s) => s.link !== "off");
  return {
    servers,
    active,
    links: { up: linked.filter((s) => s.link === "ok").length, total: linked.length },
    cluster: active ? clusterGlance(resources[active.id], now) : null,
  };
}

// 集群读数还能不能信：采样过且最近一次采集没失败（数据较旧也照常显示，提示里会写）。
function clusterUsable(cluster) {
  const level = cluster?.freshness?.level;
  return level === "ok" || level === "warn";
}

// 菜单栏数字：短到能和图标并排（「GPU 1/6」「CPU 13%」「作业 2+1」）。没有可信读数时为空串——
// 图标上的状态点已经说明链路，空着比挂一个过期数字好。
export function glanceTitle(glance, metric) {
  const m = normalizeGlanceMetric(metric);
  if (m === "off" || !glance) return "";
  const cluster = clusterUsable(glance.cluster) ? glance.cluster : null;
  if (m === "mine") {
    if (!cluster?.mine) return "";
    return `作业 ${cluster.mine.running}${cluster.mine.pending ? `+${cluster.mine.pending}` : ""}`;
  }
  if (m === "gpu" && cluster && cluster.gpuTotal > 0) return `GPU ${cluster.gpuUsed}/${cluster.gpuTotal}`;
  // CPU，或没有 GPU 的集群 / 非 Slurm 机器上的 GPU 选项：退到 CPU。
  if (cluster && cluster.cpuAllocPct != null) return `CPU ${Math.round(cluster.cpuAllocPct)}%`;
  if (glance.active?.loadOk && glance.active.cpu != null) return `CPU ${Math.round(glance.active.cpu)}%`;
  return "";
}
