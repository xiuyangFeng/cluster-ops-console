// thresholds.js —— 资源阈值的单一事实源（服务器卡、资源面板、注意力队列、悬浮岛共用）。
// 两张表语义不同，别混用：
//   RESOURCE_THRESHOLDS —— 进度条/数值"配色分档"（绿/黄/红），全界面同一口径；
//   ALERT_THRESHOLDS    —— 注意力队列"何时单独立一条告警"，门槛比配色红档更高，
//                          避免资源稍一变红就常驻告警（告警疲劳）。
// levelFor(kind, pct) → "ok" | "warn" | "critical" | "unknown"。
// colorFor(level) → 进度条颜色类后缀（沿用既有 green/yellow/red 约定，load-panel 会整体覆写 className）。
// 数值小工具 finite / clampPct / worstLevel 也放这里：各面板模型与视图共用一份，不再各抄一遍。

export const RESOURCE_THRESHOLDS = Object.freeze({
  cpu: Object.freeze({ warn: 70, critical: 85 }),
  memory: Object.freeze({ warn: 70, critical: 90 }),
  disk: Object.freeze({ warn: 80, critical: 90 }),
  gpu: Object.freeze({ warn: 70, critical: 90 }),
  gpuMemory: Object.freeze({ warn: 80, critical: 95 }),
});

// 注意力队列告警门槛（render/attention.js）：磁盘 ≥diskCrit 严重、≥diskWarn 警告；
// 内存 ≥ramWarn 警告；CPU ≥cpuWarn 且连续 cpuStreakFrames 帧才告警（削抖）。
export const ALERT_THRESHOLDS = Object.freeze({
  diskWarn: 90,
  diskCrit: 95,
  ramWarn: 92,
  cpuWarn: 95,
  cpuStreakFrames: 2,
});

// Number(null) === 0：空值必须先挡掉，否则"未知"会被悄悄当成 0。非有限数一律 null。
export function finite(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// 百分比夹到 [0, 100]；非数值按 0（进度条宁可空着也不画 NaN）。
export function clampPct(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

export function levelFor(kind, pct) {
  const t = RESOURCE_THRESHOLDS[kind];
  const n = Number(pct);
  if (!t || pct == null || !Number.isFinite(n)) return "unknown";
  if (n >= t.critical) return "critical";
  if (n >= t.warn) return "warn";
  return "ok";
}

const LEVEL_COLORS = { ok: "green", warn: "yellow", critical: "red", unknown: "gray" };
export function colorFor(level) {
  return LEVEL_COLORS[level] || "gray";
}

// 多个级别取最严重的一个：unknown < ok < warn < critical（认不出的级别按 unknown 算）。
const LEVEL_RANK = { unknown: 0, ok: 1, warn: 2, critical: 3 };
export function worstLevel(...levels) {
  return levels.reduce((worst, l) => ((LEVEL_RANK[l] ?? 0) > (LEVEL_RANK[worst] ?? 0) ? l : worst), "unknown");
}
