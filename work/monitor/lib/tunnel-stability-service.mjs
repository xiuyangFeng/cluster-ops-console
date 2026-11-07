// 隧道稳定性服务（monitor 侧）：读 supervisor 写的断线账本（含轮转出的 .1），按当前启用、
// 建隧道的服务器算出稳定性指标（GET /api/tunnel-stability）。
// 两份文件的 size+mtime 都没变时复用上次解析结果，只按当前时间重算窗口。
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { beijingDayEndMs, beijingDayStartMs } from "./beijing-time.mjs";
import { listEnabledServers } from "./config-loader.mjs";
import { TUNNEL_LEDGER_FILENAME } from "./supervisor/tunnel-ledger.mjs";
import { computeTunnelStability, defaultRanges, parseLedgerText } from "./tunnel-ledger-stats.mjs";
import { dayKeyOf, offsetDay } from "./usage/time.mjs";

// 「近 7 天」在线条：按北京时间自然日的 7 个区间（今天在最后），每天一块色。
export const DAILY_DAYS = 7;

export function createTunnelStabilityService({ runtimeDir, getMergedConfig, now = Date.now }) {
  const current = path.join(runtimeDir, TUNNEL_LEDGER_FILENAME);
  const files = [`${current}.1`, current];
  let cache = { sig: null, events: [] };

  async function loadEvents() {
    const infos = await Promise.all(files.map((file) => stat(file).catch(() => null)));
    const sig = infos.map((info) => (info ? `${info.size}:${info.mtimeMs}` : "-")).join("|");
    if (sig === cache.sig) return cache.events;
    const texts = await Promise.all(files.map((file, i) => (infos[i] ? readFile(file, "utf8").catch(() => "") : "")));
    cache = { sig, events: texts.flatMap(parseLedgerText) };
    return cache.events;
  }

  async function get() {
    const servers = listEnabledServers(getMergedConfig() || {}).filter((server) => server.tunnel !== false);
    const events = await loadEvents();
    const nowMs = now();
    const today = dayKeyOf(nowMs / 1000);
    const days = Array.from({ length: DAILY_DAYS }, (_, i) => offsetDay(today, i - DAILY_DAYS + 1));
    const ranges = { ...defaultRanges(nowMs), ...Object.fromEntries(days.map((day) => [`day:${day}`, [beijingDayStartMs(day), beijingDayEndMs(day)]])) };
    const stats = computeTunnelStability({ events, nowMs, serverIds: servers.map((server) => server.id), ranges });
    for (const server of servers) {
      const entry = stats.servers[server.id];
      if (!entry) continue;
      entry.name = server.name || server.id;
      entry.daily = days.map((day) => {
        const w = entry.windows[`day:${day}`];
        delete entry.windows[`day:${day}`];
        // sleepMs：当天电脑休眠了多久（整台电脑的事实，各隧道相同；不计入断线与可用率）。
        return { day, availability: w.availability, drops: w.drops, observedMs: w.upMs + w.downMs, downMs: w.downMs, sleepMs: stats.sleep[`day:${day}`]?.ms ?? 0 };
      });
    }
    // 按天的休眠时长已并进各服务器的 daily；对外的 sleep 只留「近 24 小时 / 近 7 天」两个窗口。
    for (const day of days) delete stats.sleep[`day:${day}`];
    return stats;
  }

  return { get, loadEvents };
}
