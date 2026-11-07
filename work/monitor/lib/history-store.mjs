import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { beijingDayKey } from "./beijing-time.mjs";

// 历史持久化存储：状态迁移（timeline 条目）与指标采样按天落盘为
// runtime/history/YYYY-MM-DD.ndjson，供"按天复盘"回放（/api/history*）。
//
// 设计约束（与 metrics-store / logger 的分工）：
//  - 热路径零同步 IO：record() 只做内存追加 + 定时器调度，写盘统一在 ~1s 的
//    异步批量 flush 里（appendFile）。唯一的同步写在 dispose()——进程收到退出
//    信号时必须在 process.exit 前排干缓冲，异步写根本来不及（与 metricsStore.flush
//    在信号处理器里同步落盘是同一理由）。
//  - 指标采样降采样：type === "sample" 的条目按 key（serverId）限频为每
//    sampleIntervalMs 至多一条；值未变化时进一步跳写（heartbeat 周期兜底强写一条，
//    避免"一整天值没变 → 当天文件里一条样本都没有"的空洞）。
//  - 保留 retentionDays 天：新一天首写时在 flush 链上异步清理过期文件；文件名
//    即日期（ISO 格式字典序 = 时间序），比较无需解析。
//  - 读取容错：损坏/半截行逐行跳过，绝不抛出（断电/并发写的现实防御）。
//  - 日期参数白名单校验（^\d{4}-\d{2}-\d{2}$）后才拼路径，杜绝路径穿越。
//  - 状态基线（type === "levels"）：变迁条目只记「变了什么」，按天复盘 / 泳道图还需要知道
//    「起点是什么状态」。形状 { type:"levels", ts, cause, view, levels:{ key: level } }：
//      cause "start" 进程启动后的第一份；"day" 跨天后的第一份（两者都由 checkpoint() 定时
//      补，也会在当天第一次写入之前自动补）；"view" 状态键集合换了一批却没有变迁（切换查看
//      视角、删停服务器），由调用方 recordBaseline() 记；"stop" 优雅退出时的停止标记
//      （levels 为空）——复盘时「停止 → 下次启动」之间是无记录，不把旧状态一直延续过去。
//    快照由 setBaselineProvider 注入的函数给出（没注入就什么都不记），一条只有十来个键。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// 基线条目的体量上限：键数、键长、级别名长度（正常只有十来个键）。
const BASELINE_MAX_KEYS = 64;
const BASELINE_KEY_MAX = 80;
const BASELINE_LEVEL_MAX = 16;
const BASELINE_CAUSES = new Set(["start", "day", "view"]);
export const HISTORY_BASELINE_TYPE = "levels";

// 快照净化成可落盘的基线条目；没有任何可用的键 → null（不写空基线）。
export function buildBaselineEntry({ ts, cause, view, levels } = {}) {
  if (!levels || typeof levels !== "object") return null;
  const clean = {};
  let count = 0;
  for (const [key, level] of Object.entries(levels)) {
    if (count >= BASELINE_MAX_KEYS) break;
    if (typeof key !== "string" || !key || key.length > BASELINE_KEY_MAX) continue;
    if (typeof level !== "string" || !level || level.length > BASELINE_LEVEL_MAX) continue;
    clean[key] = level;
    count += 1;
  }
  if (!count) return null;
  return {
    type: HISTORY_BASELINE_TYPE,
    ts,
    cause: BASELINE_CAUSES.has(cause) ? cause : "view",
    view: typeof view === "string" ? view.slice(0, BASELINE_KEY_MAX) : "",
    levels: clean,
  };
}

// 北京时间（UTC+8，无夏令时）的 YYYY-MM-DD："昨晚断了几次"是按用户的自然日提问的，UTC 分桶会把
// 北京时间的晚上切进两天。不用进程的本地时区：应用从带着别的 TZ 环境变量的终端里重启（热更新）
// 时本地时区会跟着变，同一个日文件前后两段就按两种日界分了；界面上的时刻也一律是北京时间
// （与 lib/usage/time.mjs 同一口径）。v2.44 及更早按本地时区分桶，留下的旧文件读取端自己兼容。
// 日界换算只有 lib/beijing-time.mjs 一份：按日期读这些文件的一方（metrics-range 等）必须用同一份，
// 不能自己拿本机时区再算一遍日历。
export function formatHistoryDate(ts) {
  return beijingDayKey(ts);
}

export function createHistoryStore({
  dir,
  now = Date.now,
  flushDelayMs = 1000,
  retentionDays = 30,
  sampleIntervalMs = 60000,
  sampleHeartbeatMs = 5 * 60000,
} = {}) {
  const pending = new Map(); // date -> lines[]
  const lastSampleWrites = new Map(); // sampleKey -> { ts, sig }
  let flushTimer = null;
  let flushChain = Promise.resolve();
  let dirReady = null;
  let lastSeenDay = null;
  let cleanupPending = false;
  let disposed = false;
  let baselineProvider = null; // () => { view, levels } | null
  let lastBaselineDay = null; // 已经写过基线的最近一天（null = 本进程还没写过）
  let crashChecked = false; // 本进程第一次落盘前，是否已检查过上一次的退出方式

  function ensureDir() {
    if (!dirReady) dirReady = mkdir(dir, { recursive: true }).catch(() => {});
    return dirReady;
  }

  // 过期清理：挂在 flush 链上串行执行（与写盘互不交错），单个文件删除失败忽略。
  async function cleanupExpired() {
    const cutoff = formatHistoryDate(now() - retentionDays * DAY_MS);
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = FILE_RE.exec(name);
      if (!match || match[1] >= cutoff) continue;
      await rm(join(dir, name), { force: true }).catch(() => {});
    }
  }

  // 取走当前缓冲并异步写盘。挂到 flushChain 串行化：同一文件的 append 不交错，
  // readDay/listDays 也经由该链等到数据落盘后再读。
  function drainToChain() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending.size && !cleanupPending) return flushChain;
    const batches = [...pending.entries()];
    pending.clear();
    const runCleanup = cleanupPending;
    cleanupPending = false;
    flushChain = flushChain.then(async () => {
      await ensureDir();
      if (!crashChecked) {
        crashChecked = true;
        await markUncleanExit();
      }
      for (const [date, lines] of batches) {
        try {
          await appendFile(join(dir, `${date}.ndjson`), `${lines.join("\n")}\n`);
        } catch {
          // 写盘失败不重试也不抛出：历史是旁路观测数据，绝不反噬主流程。
        }
      }
      if (runCleanup) await cleanupExpired();
    });
    return flushChain;
  }

  // 上一个进程没留停止标记（崩溃 / 强杀 / 断电——只有优雅退出的 dispose() 才写）：在它最后一条记录的
  // 时刻补一条，复盘才会把「停机 → 这次启动」画成无记录，而不是把停机前的状态一直延续过来。
  // 采样至少 5 分钟落一条心跳，补的时刻最多比真实停机早几分钟。只看最新那天的文件；读不了就算了。
  async function markUncleanExit() {
    try {
      const days = (await readdir(dir)).map((name) => FILE_RE.exec(name)?.[1]).filter(Boolean).sort();
      const latest = days.at(-1);
      if (!latest) return;
      const raw = await readFile(join(dir, `${latest}.ndjson`), "utf8");
      const lastLine = raw.trimEnd().split("\n").at(-1);
      if (!lastLine) return;
      const last = JSON.parse(lastLine);
      if (last?.type === HISTORY_BASELINE_TYPE && last.cause === "stop") return;
      const ts = Number(last?.ts);
      if (!Number.isFinite(ts)) return;
      await appendFile(join(dir, `${latest}.ndjson`), `${JSON.stringify({ type: HISTORY_BASELINE_TYPE, ts, cause: "stop", view: "", levels: {}, unclean: true })}\n`);
    } catch {
      // 旁路数据：检查失败只是少一条标记。
    }
  }

  function scheduleFlush() {
    if (flushTimer || disposed) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      drainToChain();
    }, flushDelayMs);
    if (typeof flushTimer.unref === "function") flushTimer.unref();
  }

  // 采样降采样门：每 key 每 sampleIntervalMs 至多放行一条；间隔够但值没变时跳写，
  // 超过 sampleHeartbeatMs 未落盘则强写一条心跳样本。
  function admitSample(entry, ts) {
    const key = String(entry.key ?? entry.serverId ?? "default");
    const { ts: _ts, type: _type, key: _key, ...values } = entry;
    const sig = JSON.stringify(values);
    const last = lastSampleWrites.get(key);
    if (last) {
      if (ts - last.ts < sampleIntervalMs) return false;
      if (last.sig === sig && ts - last.ts < sampleHeartbeatMs) return false;
    }
    lastSampleWrites.set(key, { ts, sig });
    return true;
  }

  function pushLine(date, line) {
    if (!pending.has(date)) pending.set(date, []);
    pending.get(date).push(line);
  }

  // 「新的一天」只认往后走：零点前后时间戳略有乱序的迟到条目（仍属前一天）不算跨天，
  // 否则日期会来回跳、基线连写好几条。
  function touchDay(date) {
    if (lastSeenDay !== null && date <= lastSeenDay) return;
    lastSeenDay = date;
    cleanupPending = true; // 新一天首写：随下一次 flush 异步清理过期文件
  }

  // ---- 状态基线 ----

  // 取快照并净化成一条基线；provider 抛错 / 给不出可用的键 → null（基线是旁路数据，不抛）。
  function snapshotEntry(ts, cause, snapshot) {
    try {
      return buildBaselineEntry({ ts, cause, ...(snapshot ?? baselineProvider?.() ?? {}) });
    } catch {
      return null;
    }
  }

  // 这一天还没有基线就先写一条：本进程的第一份记 start，之后每跨一天记 day。
  // 写不出来（没有 provider 等）不记账——下一次写入或 checkpoint 再试。
  function ensureDayBaseline(date, ts, snapshot = null) {
    if (lastBaselineDay !== null && date <= lastBaselineDay) return false;
    const entry = snapshotEntry(ts, lastBaselineDay === null ? "start" : "day", snapshot);
    if (!entry) return false;
    lastBaselineDay = date;
    pushLine(date, JSON.stringify(entry));
    return true;
  }

  function record(entry) {
    if (disposed || !entry || typeof entry !== "object") return false;
    const ts = Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : now();
    if (entry.type === "sample" && !admitSample(entry, ts)) return false;
    const date = formatHistoryDate(ts);
    let line;
    try {
      line = JSON.stringify({ ...entry, ts });
    } catch {
      return false; // 循环引用等不可序列化条目
    }
    touchDay(date);
    // 先记基线、再记触发它的这条：同一时间戳下基线排在前面（readDay 的排序是稳定的）。
    ensureDayBaseline(date, ts);
    pushLine(date, line);
    scheduleFlush();
    return true;
  }

  // 定时检查用：当天还没有基线就补一条，已有则什么都不做。启动时调一次落下 start；
  // 跨天后若一直没有别的写入（通道断了一夜，没有采样也没有变迁），靠它在零点后及时记下
  // 「当时的状态」——否则要等到下一次写入才补，那时取到的已经是变化之后的状态。
  function checkpoint() {
    if (disposed) return false;
    const ts = now();
    const date = formatHistoryDate(ts);
    if (!ensureDayBaseline(date, ts)) return false;
    touchDay(date);
    scheduleFlush();
    return true;
  }

  // 显式记一份基线（状态键集合换了一批）。levels 省略时向 provider 取。
  // 这次写入本身就是当天 / 启动后的第一份时只记那一份，不再叠一条。
  function recordBaseline({ cause = "view", ts, view, levels } = {}) {
    if (disposed) return false;
    const at = Number.isFinite(Number(ts)) ? Number(ts) : now();
    const date = formatHistoryDate(at);
    const snapshot = levels ? { view, levels } : null;
    let written = ensureDayBaseline(date, at, snapshot);
    if (!written) {
      const entry = snapshotEntry(at, cause, snapshot);
      if (entry) {
        pushLine(date, JSON.stringify(entry));
        written = true;
      }
    }
    if (!written) return false;
    touchDay(date);
    scheduleFlush();
    return true;
  }

  function setBaselineProvider(fn) {
    baselineProvider = typeof fn === "function" ? fn : null;
  }

  async function listDays() {
    await drainToChain();
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    return names
      .map((name) => FILE_RE.exec(name)?.[1])
      .filter(Boolean)
      .sort()
      .reverse(); // 新日期在前，前端下拉直接可用
  }

  async function readDay(date) {
    if (typeof date !== "string" || !DATE_RE.test(date)) {
      const err = new Error("invalid date");
      err.code = "EINVALIDDATE";
      throw err;
    }
    await drainToChain();
    let raw;
    try {
      raw = await readFile(join(dir, `${date}.ndjson`), "utf8");
    } catch {
      return [];
    }
    const entries = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 损坏/半截行跳过
      }
      if (entry && typeof entry === "object" && Number.isFinite(entry.ts)) entries.push(entry);
    }
    entries.sort((a, b) => a.ts - b.ts);
    return entries;
  }

  // dispose：清定时器 + 同步排干缓冲。唯一允许同步 IO 的路径——只在进程退出/测试
  // 收尾时调用，异步 flush 在 SIGTERM 处理器里赶不上 process.exit。
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    // 本进程记过基线才留停止标记：复盘据此把「停止 → 下次启动」之间画成无记录。
    if (lastBaselineDay !== null) {
      const ts = now();
      pushLine(formatHistoryDate(ts), JSON.stringify({ type: HISTORY_BASELINE_TYPE, ts, cause: "stop", view: "", levels: {} }));
    }
    if (!pending.size) return;
    try {
      mkdirSync(dir, { recursive: true });
      for (const [date, lines] of pending) {
        appendFileSync(join(dir, `${date}.ndjson`), `${lines.join("\n")}\n`);
      }
    } catch {
      // 退出路径写盘失败只能放弃这最后一批
    }
    pending.clear();
  }

  return { record, recordBaseline, checkpoint, setBaselineProvider, listDays, readDay, flush: drainToChain, dispose };
}
