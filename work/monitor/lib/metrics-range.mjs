// 资源指标的长范围降采样（7 天 / 30 天），供 GET /api/metrics/range。
//
// 数据源是 history-store 的按天文件（type:"sample"、key = serverId，保留 30 天）——metrics-store 的
// 环形缓冲只有 24 小时。前端不能自己拉：一天的文件约 290KB，30 天近 9MB。
//
// 做法：每个日文件先按服务器归成「小时桶」；7 天直接用小时桶，30 天把 3 个小时桶并成一个。
// 已经过完的日子文件不会再变，它的小时桶缓存到进程结束（几十天 × 服务器数 × 24 桶，很小）；
// 当天的文件 liveTtlMs 内不重读。
//
// 均值按时长加权，不按条数：history-store 落盘时去重（读数没变就跳过，最多 5 分钟才强写一条），
// 一段平稳的读数只留下几条，按条数平均会被旁边波动时段的密集样本压过去。每条样本管到下一条为止
//（间隔超过 HOLD_CAP_MS 就是断档——应用没在跑 / 电脑睡眠——只算一个采样周期，不拿旧读数去填）。
//
// 返回的样本字段与 /api/metrics 的 resource 样本同名同义（保留一位小数），且不带
// metricSchemaVersion：前端 metricSampleValues 对这类样本按 cpuBusyPct → loadNormalizedPct → cpu
// 取值，与指标卡大字是同一条口径链。extremes 是逐条原始样本的最小 / 最大值（均值曲线会把尖峰抹平，
// 「30 天内最高到过多少」要看这里），CPU 同样按那条口径链逐条取值。
//
// 日历口径：日文件按北京时间的日期命名（history-store.formatHistoryDate），这里列日期、判断某天是否
// 过完用的是同一份换算（lib/beijing-time.mjs），与进程的本机时区无关。此前这两处按本机时区算日历：
// 机器时区在 UTC+8 以东时，北京时间还没过完的一天会被判成「已过完」，当天后面写进去的样本
// 直到进程重启都读不到。
import { beijingDayEndMs, beijingDaysBetween } from "./beijing-time.mjs";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const METRIC_RANGES = Object.freeze({
  "7d": Object.freeze({ spanMs: 7 * DAY_MS, stepMs: HOUR_MS }),
  "30d": Object.freeze({ spanMs: 30 * DAY_MS, stepMs: 3 * HOUR_MS }),
});

const MEAN_FIELDS = ["cpuBusyPct", "loadNormalizedPct", "cpu", "ram", "disk"];
const EXTREME_KEYS = ["cpu", "ram", "disk"];
// history-store 的采样限频：每台服务器每分钟至多一条；读数没变时 5 分钟强写一条（再留 1 分钟抖动余量）。
const SAMPLE_INTERVAL_MS = 60 * 1000;
const HOLD_CAP_MS = 6 * 60 * 1000;
// 当天过完这么久之后读到的文件才算定稿：刚过零点时可能还有一批缓冲没落盘。
const FINAL_GRACE_MS = 2 * 60 * 1000;
const DAY_CACHE_MAX = 40;

// Number(null) === 0：空值必须先挡掉，否则「没采到」会被当成 0 拉低均值。
function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const round1 = (value) => Math.round(value * 10) / 10;

// 统一口径的 CPU：利用率 → 归一化负载 → 旧采集脚本的 cpu（与前端 pickCpuMetric 同一优先级）。
export function unifiedCpu(sample) {
  return finite(sample?.cpuBusyPct) ?? finite(sample?.loadNormalizedPct) ?? finite(sample?.cpu);
}

// 桶：sum = Σ 读数 × 时长，weight = Σ 时长（毫秒），均按字段分开记（某个字段没采到不影响别的字段）。
function emptyBucket() {
  return { sum: {}, weight: {}, min: {}, max: {} };
}

function bucketAt(buckets, start) {
  let bucket = buckets.get(start);
  if (!bucket) {
    bucket = emptyBucket();
    buckets.set(start, bucket);
  }
  return bucket;
}

function addExtreme(bucket, key, lo, hi) {
  if (bucket.min[key] == null || lo < bucket.min[key]) bucket.min[key] = lo;
  if (bucket.max[key] == null || hi > bucket.max[key]) bucket.max[key] = hi;
}

// 一个日文件的全部条目 → Map<serverId, Map<小时起点, 桶>>。纯函数。
export function aggregateDay(entries) {
  const samplesByServer = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.type !== "sample" || typeof entry.key !== "string" || !Number.isFinite(entry.ts)) continue;
    const list = samplesByServer.get(entry.key);
    if (list) list.push(entry);
    else samplesByServer.set(entry.key, [entry]);
  }
  const byServer = new Map();
  for (const [serverId, list] of samplesByServer) {
    list.sort((a, b) => a.ts - b.ts);
    const hours = new Map();
    list.forEach((entry, index) => {
      const gap = index + 1 < list.length ? list[index + 1].ts - entry.ts : 0;
      const hold = gap > 0 && gap <= HOLD_CAP_MS ? gap : SAMPLE_INTERVAL_MS;
      const values = MEAN_FIELDS.map((field) => finite(entry[field]));
      // 这条读数管的时段可能跨过整点：按落在各小时里的时长分摊。
      const stop = entry.ts + hold;
      let start = entry.ts;
      while (start < stop) {
        const hourStart = Math.floor(start / HOUR_MS) * HOUR_MS;
        const span = Math.min(stop, hourStart + HOUR_MS) - start;
        const bucket = bucketAt(hours, hourStart);
        MEAN_FIELDS.forEach((field, i) => {
          if (values[i] == null) return;
          bucket.sum[field] = (bucket.sum[field] || 0) + values[i] * span;
          bucket.weight[field] = (bucket.weight[field] || 0) + span;
        });
        start += span;
      }
      const own = bucketAt(hours, Math.floor(entry.ts / HOUR_MS) * HOUR_MS);
      const extremes = { cpu: unifiedCpu(entry), ram: finite(entry.ram), disk: finite(entry.disk) };
      for (const key of EXTREME_KEYS) {
        if (extremes[key] != null) addExtreme(own, key, extremes[key], extremes[key]);
      }
    });
    byServer.set(serverId, hours);
  }
  return byServer;
}

function mergeBucket(target, source) {
  for (const field of MEAN_FIELDS) {
    if (source.weight[field]) {
      target.sum[field] = (target.sum[field] || 0) + source.sum[field];
      target.weight[field] = (target.weight[field] || 0) + source.weight[field];
    }
  }
  for (const key of EXTREME_KEYS) {
    if (source.min[key] != null) addExtreme(target, key, source.min[key], source.max[key]);
  }
}

export function createMetricsRange({ historyStore, now = Date.now, liveTtlMs = 60 * 1000 } = {}) {
  const dayCache = new Map(); // date -> { at, final, byServer }
  const inflight = new Map(); // date -> Promise<byServer>

  function pruneCache() {
    if (dayCache.size <= DAY_CACHE_MAX) return;
    const dates = [...dayCache.keys()].sort();
    for (const date of dates.slice(0, dayCache.size - DAY_CACHE_MAX)) dayCache.delete(date);
  }

  function loadDay(date) {
    const nowMs = now();
    const cached = dayCache.get(date);
    if (cached && (cached.final || nowMs - cached.at < liveTtlMs)) return Promise.resolve(cached.byServer);
    const pending = inflight.get(date);
    if (pending) return pending;
    const task = (async () => {
      const byServer = aggregateDay(await historyStore.readDay(date));
      // 「过完」按北京时间的日界判（文件就是按它分的），不看本机时区的零点。
      dayCache.set(date, { at: nowMs, final: nowMs >= beijingDayEndMs(date) + FINAL_GRACE_MS, byServer });
      pruneCache();
      return byServer;
    })().finally(() => inflight.delete(date));
    inflight.set(date, task);
    return task;
  }

  // { serverId, range, stepMs, since, generatedAt, samples: [{ ts, cpuBusyPct, loadNormalizedPct, cpu, ram, disk }], extremes }
  // ts 是桶的起点；没有样本的桶不出现（应用没在运行 / 电脑睡眠的时段就是断档）。
  async function query({ serverId, range }) {
    const spec = METRIC_RANGES[range];
    if (!spec) {
      const err = new Error("invalid range");
      err.code = "EINVALIDRANGE";
      throw err;
    }
    const end = now();
    const since = Math.floor((end - spec.spanMs) / spec.stepMs) * spec.stepMs;
    // 日文件现在按北京时间的日期命名；v2.44 及更早按「写入时的本机日期」命名，那台电脑不在 UTC+8 时
    // 窗口两端的样本可能落在相邻日期的旧文件里，所以前后各多读一天（多读的那两个文件同样走缓存；
    // 不存在的日期读出来是空）。取舍只看样本自己的 ts。
    const days = await Promise.all(beijingDaysBetween(since - DAY_MS, end + DAY_MS).map(loadDay));
    const steps = new Map(); // 桶起点 -> 桶
    for (const byServer of days) {
      const hours = byServer.get(serverId);
      if (!hours) continue;
      for (const [hourStart, bucket] of hours) {
        if (hourStart < since || hourStart > end) continue;
        mergeBucket(bucketAt(steps, Math.floor(hourStart / spec.stepMs) * spec.stepMs), bucket);
      }
    }
    const total = emptyBucket();
    const samples = [...steps.entries()].sort((a, b) => a[0] - b[0]).map(([ts, bucket]) => {
      mergeBucket(total, bucket);
      const sample = { ts };
      for (const field of MEAN_FIELDS) {
        sample[field] = bucket.weight[field] ? round1(bucket.sum[field] / bucket.weight[field]) : null;
      }
      return sample;
    });
    const extremes = Object.fromEntries(EXTREME_KEYS.map((key) => [
      key,
      total.min[key] == null ? null : { min: round1(total.min[key]), max: round1(total.max[key]) },
    ]));
    return { serverId, range, stepMs: spec.stepMs, since, generatedAt: end, samples, extremes };
  }

  return { query };
}
