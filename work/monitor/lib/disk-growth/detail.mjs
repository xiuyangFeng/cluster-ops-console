// 磁盘告警处的那句话：「近 24 小时你的作业目录增长约 X，其中 <目录名> +Y；按这个速度约 N 天写满。」
//
// 前半句是本模块量出来的（model.mjs growthSentence）；后半句不另算——取简报的磁盘趋势
// （lib/brief/service.mjs 的 diskTrendFor，同一份历史采样、同一个 diskTrend、同样缓存 10 分钟）
// 与简报同一句文案（lib/brief/model.mjs 的 daysToFullText）。两半各自可缺：没量过只说几天写满，
// 趋势不够只说增长，都没有就是空串（界面不加这一行）。
import { daysToFullText } from "../brief/model.mjs";
import { growthSentence } from "./model.mjs";

export function diskDetailText({ summary = null, trend = null } = {}) {
  const parts = [growthSentence(summary), daysToFullText(trend?.daysToFull)].filter(Boolean);
  return parts.length ? `${parts.join("；")}。` : "";
}

// (serverId) => { text, trend }：GET /api/disk-growth 与未解决的磁盘超阈值事件（GET /api/incidents）共用。
// 两个来源任何一个取不到都只是少半句，不抛错。
export function createDiskDetailProvider({ diskGrowthService = null, briefService = null } = {}) {
  return async function describeDisk(serverId) {
    const [summary, trend] = await Promise.all([
      Promise.resolve().then(() => diskGrowthService?.summaryFor(serverId) ?? null).catch(() => null),
      Promise.resolve().then(() => briefService?.diskTrendFor?.(serverId) ?? null).catch(() => null),
    ]);
    return {
      text: diskDetailText({ summary, trend }),
      trend: trend ? { usedPct: trend.usedPct ?? null, deltaPct: trend.deltaPct ?? null, daysToFull: trend.daysToFull ?? null } : null,
    };
  };
}
