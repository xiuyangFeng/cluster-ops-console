// 关注作业的纯计算：日志只支持有证据的「疑似停滞」，资源缺失不补零。
import { resourceAdvice } from "./resource-advice.mjs";

export const WATCH_FRESH_MS = 11 * 60000;
export const WATCH_DEFAULT_SETTINGS = Object.freeze({ silenceMinutes: 30, limitMinutes: 30 });
const positive = (v) => Number.isFinite(v) && v > 0 ? v : null;

export function parseMemoryBytes(raw) {
  const m = /^(\d+(?:\.\d+)?)([KMGTPE]?)(?:[cn])?$/i.exec(String(raw ?? "").trim());
  if (!m || Number(m[1]) <= 0) return null;
  // sacct --units=K：没有单位的内存字段也是 KB；ReqMem/MaxRSS 的显式单位优先。
  return positive(Number(m[1]) * 1024 ** Math.max(1, " KMGTPE".indexOf(m[2].toUpperCase())));
}

function cpuSeconds(raw) {
  const m = /^(?:(\d+)-)?(\d+):(\d+(?:\.\d+)?)(?::(\d+(?:\.\d+)?))?$/.exec(String(raw ?? ""));
  if (!m) return null;
  const result = Number(m[1] || 0) * 86400 + (m[4] === undefined ? Number(m[2]) * 60 + Number(m[3]) : Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]));
  return positive(result);
}

// TRES 的 gpuutil 是各 task 的高水位（多 GPU 时可合计超过 100），不是时间平均利用率。
export function parseTres(raw) {
  const result = {};
  for (const item of String(raw ?? "").slice(0, 4096).split(",")) {
    const m = /^([a-zA-Z0-9_/:.-]+)=([^=,]+)$/.exec(item.trim());
    if (m && !Object.hasOwn(result, m[1])) Object.defineProperty(result, m[1], { value: m[2], enumerable: true });
  }
  return result;
}

const nonnegative = (v) => /^\d+(?:\.\d+)?$/.test(String(v ?? "")) && Number.isFinite(Number(v)) ? Number(v) : null;

export function buildResourceReview(record, job, checkedAt) {
  if (!record || !Array.isArray(record.rows)) return null;
  const rows = record.rows.filter((r) => r && typeof r.id === "string" && (r.id === record.id || r.id?.startsWith(`${record.id}.`)));
  const top = rows.find((r) => r.id === record.id);
  if (!top) return null;
  const steps = rows.filter((r) => r !== top);
  const allocCpus = positive(Number(top.cpus));
  const elapsedSeconds = positive(Number(top.elapsed));
  const stepCpu = steps.map((r) => cpuSeconds(r.totalCpu)).filter((v) => v !== null);
  const totalCpuSeconds = cpuSeconds(top.totalCpu) ?? (stepCpu.length ? stepCpu.reduce((a, b) => a + b, 0) : null);
  const rss = rows.map((r) => parseMemoryBytes(r.maxRss)).filter((v) => v !== null);
  const maxRssBytes = rss.length ? Math.max(...rss) : null;
  const tresMem = /(?:^|,)mem=([^,]+)/.exec(top.reqTres || "")?.[1];
  const multiplier = /c$/i.test(top.reqMem || "") ? allocCpus : positive(Number(top.nodes));
  const requestedMemoryBytes = parseMemoryBytes(tresMem) ?? (multiplier && parseMemoryBytes(top.reqMem) ? multiplier * parseMemoryBytes(top.reqMem) : null);
  const ratio = allocCpus && elapsedSeconds && totalCpuSeconds !== null ? totalCpuSeconds / (allocCpus * elapsedSeconds) : null;
  const cpuEfficiency = ratio !== null && ratio <= 1.05 ? Math.min(1, ratio) : null;
  const gpuPeaks = rows.map((r) => parseTres(r.tresMax));
  const gpuMem = gpuPeaks.map((t) => parseMemoryBytes(t["gres/gpumem"])).filter((v) => v !== null);
  const gpuUtil = gpuPeaks.map((t) => nonnegative(t["gres/gpuutil"])).filter((v) => v !== null);
  const reqTres = parseTres(top.reqTres);
  const gpuCount = nonnegative(reqTres["gres/gpu"]) ?? (() => {
    const counts = Object.entries(reqTres).filter(([k]) => k.startsWith("gres/gpu:")).map(([, v]) => nonnegative(v));
    return counts.length && counts.every((v) => v !== null) ? counts.reduce((a, b) => a + b, 0) : null;
  })();
  const taskRows = steps.filter((r) => !r.id.endsWith(".extern"));
  const taskCounts = (taskRows.length ? taskRows : [top]).map((r) => positive(Number(r.tasks)));
  const singleTask = !record.truncated && positive(Number(top.nodes)) === 1 && taskRows.length <= 1 && taskCounts.length > 0 && taskCounts.every((v) => v === 1) && Number(top.tasks) === 1;
  const review = {
    reviewVersion: 2,
    jobId: record.id, name: job?.name || record.id, state: job?.state || top.state, checkedAt,
    allocCpus, requestedMemoryBytes, maxRssBytes, totalCpuSeconds, elapsedSeconds, cpuEfficiency,
    singleTask, requestedGpus: gpuCount,
    timeLimitSeconds: positive(Number(top.timeLimit)) ? Number(top.timeLimit) * 60 : null,
    gpuMemoryPeakBytes: gpuMem.length ? Math.max(...gpuMem) : null,
    gpuUtilPeak: gpuUtil.length ? Math.max(...gpuUtil) : null,
    detail: `${record.truncated ? "资源明细未取全，不据此缩减 CPU / 内存。" : ""}CPU 效率 = 累计 CPU 时间 ÷（分配核数 × 墙钟时间）。MaxRSS 是最大单任务常驻内存，不代表整个作业峰值；GPU 为 Slurm TRESUsageInMax 的单任务高水位，多卡可合计超过 100%，不是时间平均效率或单卡峰值。${totalCpuSeconds === null || maxRssBytes === null ? "部分记账指标不可得。" : ""}${ratio !== null && ratio > 1.05 ? "CPU 记账超过分配量，效率不作推断。" : ""}`,
  };
  return { ...review, ...resourceAdvice(review) };
}

function lastMetric(tail, key) {
  const re = new RegExp(`\\b${key}\\s*(?:[:=#]\\s*)?(\\d+(?:\\.\\d+)?)`, "gi");
  const values = [...tail.matchAll(re)];
  return values.length ? Number(values.at(-1)[1]) : null;
}

// activity（可选，v2.51）：编排型作业「正在跑」的子任务日志指纹。这类作业的 stdout 只在子任务启动 / 结束时才写，
// 子任务日志有更新也算活动，避免把正在训练的作业误报成疑似停滞。
// freshMs（可选，v2.62）：相邻两次采样隔多久以内算连得上。自动关注的作业多于一轮能读的数量时轮着采，
// 间隔比默认的两轮长，窗口随之放宽（放宽了才记在结果里，progressView 判「采样已过期」用同一个值）。
export function buildProgress(record, previous, { now, silenceMinutes, activity = null, freshMs = WATCH_FRESH_MS }) {
  const window = freshMs > WATCH_FRESH_MS ? { freshMs } : {};
  const base = { status: "unavailable", checkedAt: now, lastLogAt: null, step: null, epoch: null, silenceMinutes, detail: record?.reason || "本轮没有读取到日志", path: null, tail: "", unchangedSince: null, fingerprint: null, ...window };
  const files = record?.files || [];
  if (!files.length || !Number.isFinite(record.remoteNow)) return base;
  const latest = [...files].filter((f) => Number.isFinite(f.mtime)).sort((a, b) => b.mtime - a.mtime)[0];
  if (!latest || latest.mtime > record.remoteNow + 60) return { ...base, detail: "日志时间异常，暂不判断停滞" };
  const tail = files.map((f) => f.tail).join("\n").slice(-4096);
  const fingerprint = files.map((f) => `${f.path}:${f.size}:${f.mtime}`).join("|") + (activity?.fingerprint ? `|subruns:${activity.fingerprint}` : "");
  const continuous = previous?.fingerprint === fingerprint && now - previous.checkedAt <= Math.max(freshMs, WATCH_FRESH_MS);
  const unchangedSince = continuous ? previous.unchangedSince ?? now : now;
  const stalled = now - unchangedSince >= silenceMinutes * 60000;
  const stdoutAt = now - Math.max(0, record.remoteNow - latest.mtime) * 1000;
  return {
    ...base, status: stalled ? "stalled" : continuous ? "quiet" : "ok",
    lastLogAt: Math.max(stdoutAt, Number.isFinite(activity?.lastLogAt) ? Math.min(now, activity.lastLogAt) : 0),
    step: lastMetric(tail, "(?:global[_ ]?)?step"), epoch: lastMetric(tail, "epoch"),
    detail: stalled ? `连续 ${silenceMinutes} 分钟未观察到日志更新；可能仍在准备数据或缓冲输出，请核对训练。` : activity ? "根据 stdout 与正在跑的子任务日志是否更新判断活动；安静不等于训练停止。" : "仅根据日志更新判断活动；安静不等于训练停止。",
    path: latest.path, tail: latest.tail.slice(-2048), fingerprint, unchangedSince,
  };
}

export function progressView(progress, now, state) {
  if (!progress) return { status: "waiting", checkedAt: null, lastLogAt: null, step: null, epoch: null, detail: state === "RUNNING" ? "下一轮采集后显示（约 5 分钟）" : "仅在运行中读取日志", path: null, tail: "" };
  const { fingerprint: _fingerprint, unchangedSince: _unchangedSince, freshMs, ...view } = progress;
  const window = Number.isFinite(freshMs) ? Math.max(freshMs, WATCH_FRESH_MS) : WATCH_FRESH_MS;
  if (state === "RUNNING" && now - progress.checkedAt > window) return { ...view, status: "stale", detail: "采样已过期，暂不判断停滞" };
  return view;
}
