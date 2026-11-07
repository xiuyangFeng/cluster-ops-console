// 失败作业诊断的「登记表」（v2.49 §2.1）：作业还在队列 / 运行时记下它的日志路径与脚本路径。
//
// 为什么要登记：Agent 常用「写临时脚本 → sbatch → 删脚本」的方式提交，作业失败后脚本没了、
// 日志路径也就无从得知（实测事后能找到日志的只有约 20%）。集群 MinJobAge = 300s，作业结束 5 分钟后
// scontrol 也查不到了——只有趁作业还活着时记下来，失败后才有路可循。
//
// 数据来源：slow 采集（60s）slurm 段里的 jobreg= 行（remote/collect.sh ct_slurm，只含当前用户的作业）：
//   jobreg_total=<squeue -u 的总行数>（squeue 失败时不出这一行 → 本轮不算观察到）
//   jobreg=JobID|ArrayJobID|ArrayTaskID|Name|WorkDir|StdOut|StdErr|Command
// StdOut / StdErr 是 squeue 的原样模板（%j %A %a %x %u 未展开），展开在取证脚本里按作业号做。
// 远端原文一律当不可信数据：字段数不对整行丢弃、作业号白名单、字符串截断、条目数封顶。
//
// 存储：runtime/job-registry.json（0600、原子写）。按服务器 + 作业号去重，记首次 / 最近见到时刻；
// 最近见到超过 7 天的淘汰，总数上限 2000 条（约 1MB 内）。文件损坏 → 当空表重来，不抛错。
// 只在新增条目（或已存条目的最近见到时刻落后 6 小时以上）时写盘：每分钟一轮不至于每轮都写。

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";

export const REGISTRY_FILE = "job-registry.json";
export const REGISTRY_MAX_ENTRIES = 2000;
export const REGISTRY_RETENTION_MS = 7 * 24 * 3600_000;
export const JOBREG_MAX_LINES = 64;
const LASTSEEN_PERSIST_MS = 6 * 3600_000;
const FIELDS = 8;
const PATH_MAX = 512;
const NAME_MAX = 200;
const ID_MAX = 64;
const USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
// 作业号：48213 / 48213_7 / 48213_[1-10%2]（排队中的数组）/ 48213+1（异构作业分量）。
const JOB_ID_RE = /^\d{1,12}(?:_(?:\d{1,9}|\[[0-9,\-%:]{1,48}\]))?(?:\+\d{1,4})?$/;
const NUM_RE = /^\d{1,12}$/;
const TASK_RE = /^\d{1,9}$/;
const PLACEHOLDERS = new Set(["", "n/a", "(null)", "none"]);

function field(value, max) {
  const text = String(value == null ? "" : value).trim();
  return PLACEHOLDERS.has(text.toLowerCase()) ? null : text.slice(0, max);
}

// 路径：只认绝对路径或相对路径的可打印文本，含控制字符的整段丢弃；超长截断后基本没用，置 null。
function pathField(value) {
  const text = String(value == null ? "" : value).trim();
  if (PLACEHOLDERS.has(text.toLowerCase()) || text.length > PATH_MAX) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 远端原文里的控制字符就是要挡掉的
  if (/[\u0000-\u001f\u007f]/.test(text)) return null;
  return text;
}

// 一行 jobreg 原文 → 登记条目；格式不对 → null。
export function parseJobRegLine(line) {
  const f = String(line == null ? "" : line).split("|");
  if (f.length !== FIELDS) return null;
  const jobId = String(f[0]).trim();
  if (jobId.length > ID_MAX || !JOB_ID_RE.test(jobId)) return null;
  const arrayJobId = NUM_RE.test(f[1].trim()) ? f[1].trim() : null;
  const arrayTaskId = TASK_RE.test(f[2].trim()) ? f[2].trim() : null;
  return {
    jobId,
    arrayJobId,
    arrayTaskId,
    name: field(f[3], NAME_MAX),
    workDir: pathField(f[4]),
    stdout: pathField(f[5]),
    stderr: pathField(f[6]),
    command: pathField(f[7]),
  };
}

// slurm 段原文 → { user, total, complete, entries, badLines }；没有 jobreg_total 行（远端没查 / 查失败）→ null。
// complete：收到的行数等于总数（没被 64 行 / 16KB 上限截掉）——只有完整视图才能判定「作业消失」。
export function parseJobRegSection(text) {
  let total = null;
  let user = null;
  const lines = [];
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("jobreg_total=")) {
      const value = line.slice(13).trim();
      if (total === null && /^\d{1,6}$/.test(value)) total = Number(value);
    } else if (line.startsWith("jobreg=")) {
      if (lines.length < JOBREG_MAX_LINES) lines.push(line.slice(7));
    } else if (line.startsWith("user=") && user === null) {
      const value = line.slice(5).trim();
      user = USER_RE.test(value) ? value : null;
    }
  }
  if (total === null) return null;
  const entries = [];
  let badLines = 0;
  const seen = new Set();
  for (const line of lines) {
    const entry = parseJobRegLine(line);
    if (!entry || seen.has(entry.jobId)) {
      badLines += 1;
      continue;
    }
    seen.add(entry.jobId);
    entries.push(entry);
  }
  return { user, total, complete: badLines === 0 && entries.length === total, entries, badLines };
}

const keyOf = (serverId, jobId) => `${serverId}\u0000${jobId}`;

function sanitizeStored(raw) {
  if (!raw || typeof raw !== "object") return null;
  const serverId = typeof raw.serverId === "string" && raw.serverId.length <= 64 ? raw.serverId : null;
  const jobId = typeof raw.jobId === "string" && JOB_ID_RE.test(raw.jobId) ? raw.jobId : null;
  if (!serverId || !jobId || !Number.isFinite(raw.firstSeenAt) || !Number.isFinite(raw.lastSeenAt)) return null;
  return {
    serverId,
    jobId,
    arrayJobId: typeof raw.arrayJobId === "string" && NUM_RE.test(raw.arrayJobId) ? raw.arrayJobId : null,
    arrayTaskId: typeof raw.arrayTaskId === "string" && TASK_RE.test(raw.arrayTaskId) ? raw.arrayTaskId : null,
    name: typeof raw.name === "string" ? raw.name.slice(0, NAME_MAX) : null,
    user: typeof raw.user === "string" && USER_RE.test(raw.user) ? raw.user : null,
    workDir: pathField(raw.workDir),
    stdout: pathField(raw.stdout),
    stderr: pathField(raw.stderr),
    command: pathField(raw.command),
    firstSeenAt: raw.firstSeenAt,
    lastSeenAt: raw.lastSeenAt,
  };
}

// filePath 为 null：只在内存里（测试 / 未接存储的装配）。
export function createJobRegistry({ filePath = null, now = Date.now, maxEntries = REGISTRY_MAX_ENTRIES, retentionMs = REGISTRY_RETENTION_MS, log = () => {} } = {}) {
  const entries = new Map(); // key -> entry
  const persistedSeen = new Map(); // key -> 写盘时的 lastSeenAt
  const queued = new Map(); // serverId -> Set(jobId)：上一次完整观察到的在队作业
  let loaded = null;
  let writing = Promise.resolve();

  async function load() {
    if (!loaded) {
      loaded = (async () => {
        if (!filePath) return;
        let parsed = null;
        try {
          parsed = JSON.parse(await readFile(filePath, "utf8"));
        } catch (err) {
          // 不存在是常态；内容损坏先留档（<名字>.corrupt-<北京时间>）再当空表重来；读不出（权限等）当空表重来。
          // 两种都是下次写盘写新文件。
          if (isParseFailure(err)) await archiveCorruptFile(filePath, { now, log, label: "作业登记" });
          else if (err?.code !== "ENOENT") log(`job registry unreadable, starting empty: ${err.message}`, { level: "warn", event: "jobs" });
          return;
        }
        const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
        for (const raw of list.slice(0, maxEntries * 2)) {
          const entry = sanitizeStored(raw);
          if (!entry) continue;
          entries.set(keyOf(entry.serverId, entry.jobId), entry);
          persistedSeen.set(keyOf(entry.serverId, entry.jobId), entry.lastSeenAt);
        }
        prune();
      })();
    }
    return loaded;
  }

  function prune() {
    const cutoff = now() - retentionMs;
    for (const [key, entry] of entries) {
      if (entry.lastSeenAt < cutoff) entries.delete(key);
    }
    if (entries.size > maxEntries) {
      const sorted = [...entries.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
      for (const [key] of sorted.slice(0, entries.size - maxEntries)) entries.delete(key);
    }
    for (const key of [...persistedSeen.keys()]) if (!entries.has(key)) persistedSeen.delete(key);
  }

  function persist() {
    if (!filePath) return Promise.resolve();
    const body = JSON.stringify({ schemaVersion: 1, entries: [...entries.values()] });
    for (const [key, entry] of entries) persistedSeen.set(key, entry.lastSeenAt);
    writing = writing
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFileAtomic(filePath, body);
      })
      .catch((err) => log(`job registry write failed: ${err.message}`, { level: "warn", event: "jobs" }));
    return writing;
  }

  // 一轮 slow 采集的 jobreg 解析结果 → 登记；返回 { added, disappeared }。
  // disappeared：上一次完整视图里在队、这一次完整视图里不在了的作业号（只在两次都完整时才算）。
  async function observe(serverId, parsed) {
    await load();
    if (!parsed) return { added: 0, disappeared: [] };
    const ts = now();
    let added = 0;
    let stale = false;
    for (const item of parsed.entries) {
      const key = keyOf(serverId, item.jobId);
      const existing = entries.get(key);
      if (existing) {
        existing.lastSeenAt = ts;
        // 排队时 squeue 给的 WorkDir / StdOut 不会变，但缺的字段可以补上。
        for (const name of ["workDir", "stdout", "stderr", "command", "name"]) if (!existing[name] && item[name]) existing[name] = item[name];
        if (ts - (persistedSeen.get(key) ?? 0) >= LASTSEEN_PERSIST_MS) stale = true;
        continue;
      }
      entries.set(key, { serverId, ...item, user: parsed.user, firstSeenAt: ts, lastSeenAt: ts });
      added += 1;
    }
    let disappeared = [];
    if (parsed.complete) {
      const current = new Set(parsed.entries.map((e) => e.jobId));
      const previous = queued.get(serverId);
      if (previous) disappeared = [...previous].filter((id) => !current.has(id));
      queued.set(serverId, current);
    } else {
      // 被截断的一轮不作数：下一轮完整视图重新建立基线，避免把没列出来的当成消失。
      queued.delete(serverId);
    }
    if (added || stale) {
      prune();
      await persist();
    }
    return { added, disappeared };
  }

  // 按 sacct 的作业号找登记：精确命中优先；数组任务（123_4）没有单独登记时，退到排队时的
  // 数组整体记录（123_[1-10]），并把任务号补上（取证脚本据此展开 %a）。
  function lookup(serverId, jobId) {
    const exact = entries.get(keyOf(serverId, jobId));
    if (exact) return { ...exact };
    const match = /^(\d+)_(\d+)$/.exec(String(jobId || ""));
    if (!match) return null;
    for (const entry of entries.values()) {
      if (entry.serverId === serverId && entry.arrayJobId === match[1] && entry.jobId.startsWith(`${match[1]}_[`)) {
        return { ...entry, jobId, arrayTaskId: match[2] };
      }
    }
    return null;
  }

  // 运行中的数组子作业以实际编号登记（jobId = 实际编号，另带 arrayJobId / arrayTaskId）：按 数组号 + 任务号 找回它
  // （日志按段读取据此在本机展开 %j，见 log-paths.mjs）。找不到 → null。
  function findArrayTask(serverId, arrayJobId, taskId) {
    for (const entry of entries.values()) {
      if (entry.serverId === serverId && entry.arrayJobId === arrayJobId && entry.arrayTaskId === taskId && NUM_RE.test(entry.jobId)) return { ...entry };
    }
    return null;
  }

  function has(serverId, jobId) {
    return entries.has(keyOf(serverId, jobId));
  }

  // 这台服务器 since（epoch 毫秒）以来见到过的作业名（v2.62 提醒规则的建议前缀用）：[{ id, name }]，没有名字的不带。
  function names(serverId, { since = -Infinity } = {}) {
    const found = [];
    for (const entry of entries.values()) {
      if (entry.serverId === serverId && entry.name && entry.lastSeenAt >= since) found.push({ id: entry.jobId, name: entry.name });
    }
    return found;
  }

  // 一台服务器的全部登记条目（副本；调用前先 await load()）。磁盘增长归因据此推出「集合目录」
  // （lib/disk-growth/collections.mjs），只读路径字段，不改登记。
  function list(serverId) {
    const out = [];
    for (const entry of entries.values()) if (entry.serverId === serverId) out.push({ ...entry });
    return out;
  }

  function size() {
    return entries.size;
  }

  return { load, observe, lookup, findArrayTask, has, names, list, size, flush: () => writing };
}
