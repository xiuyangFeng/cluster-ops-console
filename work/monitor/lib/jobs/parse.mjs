// 「我的作业」输出解析（纯函数）：scan.mjs 远端脚本的 stdout → 结构化作业列表。
//
// 远端原文一律当不可信数据：行格式不对整行丢弃、字符串截断、数值校验，条目数封顶。
// 封顶不能悄悄发生：远端先报 sacct 的总行数（rows=），实际收到 / 留下的比它少就标 truncated，
// 由上层在界面上说明——此前上限 300 且不报总数，实验多的日子今日简报会少算、还漏掉失败的作业。
// 时间：sacct 的 "2026-10-01T15:21:27" 是远端本地时间，按同段 tz 偏移换算成 epoch 毫秒
// （与 lib/slurm.mjs 的 squeue 时间同一套换算）；Unknown / None / 空 → null。
// 状态：取首个词并大写（"CANCELLED by 1234" → CANCELLED，"CANCELLED+" 去掉尾部 +），原文另存 stateRaw。

import { parseSlurmDuration, parseSlurmTimestamp, parseTzOffset } from "../slurm.mjs";

// 一轮最多保留的作业条数（远端 tail 与本机解析共用这一个上限）。实测单人近 48 小时约 1,100 条
// （同时十几个、每个不到 1 小时的批量实验），6,000 条留出五倍余量；每条约 100 字节，一轮不到 1MB。
export const JOBS_MAX = 6000;
const FIELDS = 10;
const NAME_MAX = 120;
const ID_MAX = 64;
const STATE_RAW_MAX = 64;
const NODES_MAX = 200;
const SHORT_MAX = 64;
const USER_MAX = 64;
const DETAIL_MAX = 200;

// 作业号：48213 / 48213_7（数组任务）/ 48213_[1-10%2]（排队中的数组）/ 48213+1（异构作业分量）。
const JOB_ID_RE = /^\d+(?:_(?:\d+|\[[0-9,\-%:]+\]))?(?:\+\d+)?$/;
const STATE_RE = /^[A-Z_]+$/;
const PLACEHOLDERS = new Set(["", "unknown", "none", "none assigned", "n/a", "(null)"]);

const ERROR_REASONS = {
  "no-user": "无法确定远端用户名（id -un 失败）",
  "sacct-timeout": "sacct 超时（slurmdbd 无响应）",
};

function clip(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function textOrNull(value, max) {
  const text = clip(value, max);
  return PLACEHOLDERS.has(text.toLowerCase()) ? null : text;
}

// "137:0" → { exitCode: 137, signal: 0 }；其它 → 两者 null。
export function parseExitCode(value) {
  const match = /^(\d+):(\d+)$/.exec(String(value == null ? "" : value).trim());
  if (!match) return { exitCode: null, signal: null };
  return { exitCode: Number(match[1]), signal: Number(match[2]) };
}

export function normalizeJobState(value) {
  const first = String(value == null ? "" : value).trim().split(/\s+/)[0].replace(/\+$/, "").toUpperCase();
  return STATE_RE.test(first) ? first : null;
}

// 一行 sacct -P 输出 → 作业；格式不对 → null。JobName 是自由文本、可能含 |：
// 首段是 JobID、末 8 段定长，中间多出来的段拼回名字。
export function parseJobLine(line, tzOffsetMin) {
  const f = String(line == null ? "" : line).split("|");
  if (f.length < FIELDS) return null;
  const tail = f.slice(f.length - (FIELDS - 2));
  const id = clip(f[0], ID_MAX + 1);
  if (id.length > ID_MAX || !JOB_ID_RE.test(id)) return null;
  const [stateRaw, exitRaw, submit, start, end, elapsed, nodes, partition] = tail;
  const state = normalizeJobState(stateRaw);
  if (!state) return null;
  const { exitCode, signal } = parseExitCode(exitRaw);
  return {
    id,
    name: textOrNull(f.slice(1, f.length - (FIELDS - 2)).join("|"), NAME_MAX),
    state,
    stateRaw: clip(stateRaw, STATE_RAW_MAX),
    exitCode,
    signal,
    submitAt: parseSlurmTimestamp(submit, tzOffsetMin),
    startAt: parseSlurmTimestamp(start, tzOffsetMin),
    endAt: parseSlurmTimestamp(end, tzOffsetMin),
    elapsedSec: parseSlurmDuration(elapsed),
    nodes: textOrNull(nodes, NODES_MAX),
    partition: textOrNull(partition, SHORT_MAX),
  };
}

// 整段 stdout → { state, error, detail, remoteNow, tzOffsetMin, user, jobs, badLines, rowsTotal, truncated }。
// state 为 null 表示没收到 state 行（SSH 失败 / 远端没跑起来）。
// jobs 按提交时刻倒序（同刻或缺提交时刻时按原文行序倒序），只留最新 JOBS_MAX 条。
// rowsTotal：远端 sacct 输出的总行数（rows= 行；旧脚本没有这一行 → null）。
// truncated：收到的作业行少于远端总行数，或本机又按 JOBS_MAX 截了一刀——合计都不完整。
export function parseJobsOutput(stdout) {
  const out = { state: null, error: null, detail: null, remoteNow: null, tzOffsetMin: null, user: null, jobs: [], badLines: 0, rowsTotal: null, truncated: false };
  const rows = [];
  for (const rawLine of String(stdout == null ? "" : stdout).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case "now": {
        const sec = /^\d{9,11}$/.test(value.trim()) ? Number(value.trim()) : null;
        out.remoteNow = sec == null ? null : sec * 1000;
        break;
      }
      case "tz":
        out.tzOffsetMin = parseTzOffset(value);
        break;
      case "user":
        out.user = textOrNull(value, USER_MAX);
        break;
      case "state":
        // 先到先得：作业原文里不会出现裸的 state= 行（都带 job= 前缀），但不给覆盖的机会。
        if (out.state === null && ["ok", "absent", "error"].includes(value.trim())) out.state = value.trim();
        break;
      case "error":
        if (out.error === null) out.error = clip(value, SHORT_MAX) || null;
        break;
      case "detail":
        if (out.detail === null) out.detail = clip(value, DETAIL_MAX) || null;
        break;
      case "rows":
        // 先到先得：rows= 在作业行之前输出，作业原文都带 job= 前缀。
        if (out.rowsTotal === null && /^\d{1,9}$/.test(value.trim())) out.rowsTotal = Number(value.trim());
        break;
      case "job":
        rows.push(value);
        break;
      default:
        break;
    }
  }
  if (out.state !== "ok") return out;
  // tz 行在 job 行之前；统一在收齐后解析，行序不影响换算。
  const jobs = [];
  rows.forEach((row, index) => {
    const job = parseJobLine(row, out.tzOffsetMin);
    if (job) jobs.push({ job, index });
    else out.badLines += 1;
  });
  jobs.sort((a, b) => (b.job.submitAt ?? -Infinity) - (a.job.submitAt ?? -Infinity) || b.index - a.index);
  out.jobs = jobs.slice(0, JOBS_MAX).map((entry) => entry.job);
  out.truncated = jobs.length > JOBS_MAX || (out.rowsTotal != null && out.rowsTotal > rows.length);
  return out;
}

// state=error 的中文原因（远端 error 代码 + sacct 首行报错）。
export function jobsErrorReason(parsed) {
  const detail = parsed?.detail || "";
  if (/accounting storage is disabled/i.test(detail)) return "集群未启用作业记账，sacct 不可用";
  if (ERROR_REASONS[parsed?.error]) return ERROR_REASONS[parsed.error];
  return detail ? `sacct 执行失败：${detail}` : "sacct 执行失败";
}
