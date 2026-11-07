// 今日简报服务：从各数据源取当天事实 → buildBrief（model.mjs）；今天实时生成（缓存 60s），
// 过去的日子读归档快照（store.mjs，保留 31 天）。跨过北京时间 0 点后定稿昨天并落盘。
//
// 数据源（全部只读、全部已有）：断线账本（隧道）、事件存储、用量服务、作业采集（sacct）、
// 历史采样（磁盘趋势）、codex doctor 输出（可升级）。任何一个源失败只让对应格子降级为「—」，
// 不影响整张简报。设置页「监控模块」关掉用量 / 作业时对应格子整格不出现（不取数）。
import path from "node:path";

import { beijingDayStartMs as dayStartMs } from "../beijing-time.mjs";
import { listEnabledServers } from "../config-loader.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { computeTunnelStability } from "../tunnel-ledger-stats.mjs";
import { dayKeyOf, offsetDay } from "../usage/time.mjs";
import { usageServers } from "../usage/service.mjs";
import { buildBrief } from "./model.mjs";
import { BRIEF_RETENTION_DAYS, createBriefStore } from "./store.mjs";

const LIVE_CACHE_MS = 60_000;
const DISK_CACHE_MS = 10 * 60_000;
const TICK_MS = 5 * 60_000;
// 启动后至少等这么久（或作业采集已就绪）才定稿昨天：刚启动时作业快照还是空的。
const FINALIZE_WARMUP_MS = 15 * 60_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_LABEL = { codex: "Codex", "claude-codewing": "Claude CodeWing", zcode: "Zcode" };

export function parseDoctorUpgrade(output) {
  const match = /\bupdates\s+(\S+)\s+available\s+\(current\s+([^)\s]+)\)/i.exec(String(output || ""));
  return match ? { agent: "Codex", latest: match[1], current: match[2] } : null;
}

// 磁盘趋势：最新采样、24 小时前的采样、近 72 小时线性回归斜率（%/天）→ 约几天写满。
export function diskTrend(samples, nowMs) {
  const sorted = samples.filter((s) => Number.isFinite(s.disk) && Number.isFinite(s.ts)).sort((a, b) => a.ts - b.ts);
  const latest = sorted.at(-1);
  if (!latest || nowMs - latest.ts > 30 * 60_000) return null;
  const target = nowMs - 24 * 3600_000;
  const dayAgo = sorted.filter((s) => Math.abs(s.ts - target) <= 3600_000).sort((a, b) => Math.abs(a.ts - target) - Math.abs(b.ts - target))[0];
  const recent = sorted.filter((s) => s.ts >= nowMs - 72 * 3600_000);
  let daysToFull = null;
  if (recent.length >= 10 && recent.at(-1).ts - recent[0].ts >= 12 * 3600_000) {
    const xs = recent.map((s) => (s.ts - recent[0].ts) / 86_400_000);
    const ys = recent.map((s) => s.disk);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i += 1) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    const slope = den > 0 ? num / den : 0;
    if (slope > 0.05) daysToFull = (100 - latest.disk) / slope;
  }
  return { usedPct: latest.disk, deltaPct: dayAgo ? latest.disk - dayAgo.disk : null, daysToFull };
}

export function createBriefService({
  runtimeDir,
  getMergedConfig,
  tunnelStability,
  incidentStore,
  usageService = null,
  jobsService = null,
  historyStore = null,
  // 磁盘增长归因（lib/disk-growth/service.mjs）：磁盘提示后面接「其中你的 <目录名> 近 24 小时 +Y」用。
  diskGrowthService = null,
  getDoctorOutput = () => null,
  now = Date.now,
  log = () => {},
  store = createBriefStore({ dir: path.join(runtimeDir, "briefs"), now, log }),
}) {
  const startedAt = now();
  let liveCache = null;
  let liveInflight = null; // 正在算的今天那一份：并发的请求共用它，不各算一遍
  let diskCache = null;
  let timer = null;

  const config = () => getMergedConfig() || {};
  const todayKey = () => dayKeyOf(now() / 1000);
  const modulesOf = () => ({ usage: isDataModuleEnabled(config(), "usage"), jobs: isDataModuleEnabled(config(), "jobs") });

  async function tunnelsFor(range, calcNow) {
    const servers = listEnabledServers(config()).filter((s) => s.tunnel !== false);
    const events = await tunnelStability.loadEvents();
    const stats = computeTunnelStability({ events, nowMs: calcNow, serverIds: servers.map((s) => s.id), ranges: { day: range }, recentLimit: Infinity });
    const tunnels = servers.map((server) => {
      const entry = stats.servers[server.id] || {};
      // 休眠造成的断开（清单里带 sleep 的那条）不是断线：不出「断开 N 分」的提示，也不算进最近一次断线的时刻。
      const drops = stats.recentDrops.filter((d) => d.serverId === server.id && !d.sleep && d.at >= range[0] && d.at < range[1]);
      return {
        serverId: server.id,
        name: shortName(server),
        state: entry.state,
        since: entry.since,
        window: entry.windows?.day,
        drops,
        lastDropAt: drops.length ? Math.max(...drops.map((d) => d.at)) : null,
      };
    });
    // sleep：这个区间里电脑休眠了多久、几次、最后一次醒来的时刻（没有休眠时 ms 为 0）。
    return { tunnels, ledgerSince: stats.since, sleep: stats.sleep?.day ?? null };
  }

  function incidentsFor([start, end], isToday) {
    if (!incidentStore) return null;
    const all = [];
    for (const state of ["open", "resolved"]) {
      let cursor;
      do {
        const page = incidentStore.query({ state, limit: 200, cursor });
        all.push(...page.incidents);
        cursor = page.nextCursor;
      } while (cursor);
    }
    const names = Object.fromEntries(listEnabledServers(config()).map((s) => [s.id, shortName(s)]));
    const nowMs = now();
    const open = all.filter((i) => i.lifecycle === "open");
    const quietOf = (i) => i.attention?.acknowledgedAt != null || (i.attention?.snoozedUntil ?? 0) > nowMs;
    return {
      opened: all.filter((i) => i.firstSeenAt >= start && i.firstSeenAt < end).length,
      resolved: all.filter((i) => i.resolvedAt != null && i.resolvedAt >= start && i.resolvedAt < end).length,
      pending: isToday ? open.filter((i) => !quietOf(i)).sort((a, b) => b.firstSeenAt - a.firstSeenAt).map((i) => ({
        incidentId: i.incidentId,
        reasonCode: i.reasonCode,
        serverName: names[i.serverId] || i.serverId || "全局",
        agentLabel: i.agentId ? AGENT_LABEL[i.agentId] || i.agentId : "",
        firstSeenAt: i.firstSeenAt,
      })) : [],
      quiet: isToday ? open.filter(quietOf).length : 0,
    };
  }

  async function usageFor(day) {
    if (!usageService) return null;
    try {
      const summary = await usageService.summary({ range: 1, date: day });
      const k = summary?.kpis;
      if (!k) return null;
      return { total: k.total || 0, calls: k.calls || 0, errors: k.errors || 0, freshRatio: k.freshVsAvg?.ratio ?? null, costUsd: k.costUsd || 0, savedUsd: k.savedUsd || 0 };
    } catch {
      return null;
    }
  }

  function jobsFor() {
    if (!jobsService) return { state: "none" };
    const servers = usageServers(config());
    const pairs = servers.map((s) => [s.id, jobsService.getSnapshot(s.id)]).filter(([, snap]) => snap);
    const snaps = pairs.map(([, snap]) => snap);
    if (!snaps.length) return { state: "none" };
    const ok = pairs.filter(([, snap]) => snap.state === "ok");
    // v2.49：失败作业带上诊断摘要（{ category, headline }），值得留意按原因归组。
    const withDiagnosis = (serverId, job) => {
      const diagnosis = jobsService.diagnosisOf?.(serverId, job.id) ?? null;
      return diagnosis ? { ...job, diagnosis } : job;
    };
    // truncated：有服务器这一轮没拿全（见 lib/jobs/service.mjs）——简报把数字标成下限。
    if (ok.length) {
      return {
        state: "ok",
        jobs: ok.flatMap(([serverId, snap]) => (snap.jobs || []).map((job) => withDiagnosis(serverId, job))),
        truncated: ok.some(([, snap]) => snap.truncated === true),
      };
    }
    return { state: snaps.some((s) => s.state === "absent") ? "absent" : "error", jobs: [] };
  }

  async function disksFor() {
    if (!historyStore) return [];
    if (diskCache && now() - diskCache.at < DISK_CACHE_MS) return diskCache.value;
    const nowMs = now();
    let value = [];
    try {
      // listDays 是新 → 旧；取最近 4 个文件（按本机日期分文件，样本再按时间戳筛 72 小时）。
      const days = [...(await historyStore.listDays())].sort().slice(-4);
      const entries = (await Promise.all(days.map((d) => historyStore.readDay(d).catch(() => [])))).flat();
      value = listEnabledServers(config()).map((server) => {
        const trend = diskTrend(entries.filter((e) => e.type === "sample" && e.key === server.id), nowMs);
        return trend ? { serverId: server.id, name: shortName(server), ...trend } : null;
      }).filter(Boolean);
    } catch (err) {
      log(`brief disk trend failed: ${err.message}`, { level: "warn", event: "brief" });
    }
    diskCache = { at: nowMs, value };
    return value;
  }

  // 一台服务器的磁盘趋势（就是上面那一份，同样缓存 10 分钟）；没有近期采样 → null。
  // 磁盘超阈值事件的详情从这里取「按这个速度约 N 天写满」（lib/disk-growth/detail.mjs），不另算一遍。
  async function diskTrendFor(serverId) {
    return (await disksFor()).find((d) => d.serverId === serverId) ?? null;
  }

  // 给各台的磁盘趋势挂上作业目录的增长摘要（model.mjs conditionNotes 决定提不提）。
  // 不进 10 分钟缓存：测量随时可能量完；「我的作业」模块关着时那边给 null。
  async function disksWithGrowth() {
    const disks = await disksFor();
    if (!diskGrowthService) return disks;
    return Promise.all(disks.map(async (d) => {
      const growth = await Promise.resolve().then(() => diskGrowthService.summaryFor(d.serverId)).catch(() => null);
      return growth ? { ...d, growth } : d;
    }));
  }

  async function compute(day) {
    const today = todayKey();
    const isToday = day === today;
    const start = dayStartMs(day);
    const end = start + 24 * 3600_000;
    const calcNow = isToday ? now() : end;
    // 隧道：今天按近 24 小时滚动（与概览「隧道稳定性」同一窗口），定稿的过去某天按自然日。
    const tunnelRange = isToday ? [calcNow - 24 * 3600_000, calcNow] : [start, end];
    const modules = modulesOf();
    const [{ tunnels, ledgerSince, sleep }, usage, disks] = await Promise.all([
      tunnelsFor(tunnelRange, calcNow).catch(() => ({ tunnels: [], ledgerSince: null, sleep: null })),
      modules.usage ? usageFor(day) : Promise.resolve(null),
      isToday ? disksWithGrowth() : Promise.resolve([]),
    ]);
    const upgrade = isToday ? parseDoctorUpgrade(getDoctorOutput()) : null;
    return buildBrief({
      day,
      dayStart: start,
      dayEnd: end,
      nowMs: calcNow,
      isToday,
      ledgerSince,
      tunnelRange,
      tunnels,
      sleep,
      incidents: incidentsFor([start, end], isToday),
      usage,
      jobs: modules.jobs ? jobsFor() : null,
      disks,
      upgrades: upgrade ? [upgrade] : [],
      modules,
    });
  }

  // day 缺省 = 今天。今天：实时（缓存 60s）；过去：读快照，昨天缺快照时现算并定稿；更早且无快照 → null。
  async function get(day) {
    const today = todayKey();
    const target = day || today;
    if (!DAY_RE.test(target) || target > today) return null;
    if (target === today) {
      // 模块开关一变缓存即失效：关掉的格子不必等 60s 才消失。
      const modulesKey = JSON.stringify(modulesOf());
      if (liveCache && liveCache.day === today && liveCache.modulesKey === modulesKey && now() - liveCache.at < LIVE_CACHE_MS) return liveCache.brief;
      if (liveInflight && liveInflight.day === today && liveInflight.modulesKey === modulesKey) return liveInflight.promise;
      const promise = compute(today).then((brief) => {
        liveCache = { day: today, at: now(), modulesKey, brief };
        return brief;
      }).finally(() => {
        if (liveInflight?.promise === promise) liveInflight = null;
      });
      liveInflight = { day: today, modulesKey, promise };
      return promise;
    }
    const saved = await store.read(target);
    if (saved) return saved;
    if (target === offsetDay(today, -1)) return finalize(target);
    return null;
  }

  async function finalize(day) {
    const brief = await compute(day);
    try {
      await store.write(brief, { today: todayKey() });
    } catch (err) {
      log(`brief snapshot write failed: ${err.message}`, { level: "warn", event: "brief" });
    }
    return brief;
  }

  async function listDays() {
    const today = todayKey();
    const saved = await store.listDays();
    return { today, days: [today, ...saved.filter((d) => d !== today)], retentionDays: BRIEF_RETENTION_DAYS };
  }

  // 定时：跨天后定稿昨天（作业快照就绪或启动满 15 分钟后），并清理超出保留期的旧快照。
  async function tick() {
    const today = todayKey();
    const yesterday = offsetDay(today, -1);
    // 作业模块关闭时不会再有快照，不必等。
    const jobsReady = !jobsService || !modulesOf().jobs || usageServers(config()).every((s) => jobsService.getSnapshot(s.id));
    if (!(await store.read(yesterday)) && (jobsReady || now() - startedAt >= FINALIZE_WARMUP_MS)) await finalize(yesterday);
    await store.prune(today);
  }

  function start() {
    timer = setInterval(() => tick().catch((err) => log(`brief tick failed: ${err.message}`, { level: "warn", event: "brief" })), TICK_MS);
    timer.unref?.();
    tick().catch(() => {});
  }

  function stop() {
    clearInterval(timer);
  }

  return { get, listDays, tick, start, stop, compute, diskTrendFor };
}

// 卡片 / 文案里用短名：「主集群服务器 (myserver)」→「主集群」，「阿里云服务器 (vpn-aliyun)」→「阿里云」。
export function shortName(server) {
  const name = String(server?.name || server?.id || "");
  return name.replace(/\s*\(.*\)\s*$/, "").replace(/服务器$/, "") || name;
}
