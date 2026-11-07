// 失败作业诊断结果的持久化（v2.49 §2.4）：runtime/job-diagnoses.json（0600、原子写）。
//
// 每个失败作业一条（按服务器 + 作业号去重，诊断过就不再取证）：
//   { jobId, serverId, name, state, exitCode, endedAt, category, headline, evidence (≤ 20 行),
//     files [{ path, tail (≤ 4KB), role?, size? }], script (≤ 8KB) | null, source, diagnosedAt }
// 保留 30 天（按结束时刻，缺了按诊断时刻）、上限 300 条、整个文件不超过 2MB（超了从最旧的删起）。
// 日志尾部与脚本可能含路径与参数：只存在本机用户数据目录，不出现在任何日志里。
// 文件损坏 → 当空表重来（下次写盘覆盖），不抛错。

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { DIAGNOSIS_CATEGORIES, EVIDENCE_MAX_LINES, HEADLINE_MAX } from "./diagnose.mjs";

export const DIAGNOSES_FILE = "job-diagnoses.json";
export const DIAGNOSES_MAX_ITEMS = 300;
export const DIAGNOSES_RETENTION_MS = 30 * 24 * 3600_000;
export const DIAGNOSES_MAX_BYTES = 2 * 1024 * 1024;
export const STORED_TAIL_BYTES = 4 * 1024;
export const STORED_SCRIPT_BYTES = 8 * 1024;
const FILES_MAX = 6;
const EVIDENCE_LINE_MAX = 300;
const SOURCES = new Set(["registry", "scontrol", "submitline", "default", "none"]);
const CATEGORY_SET = new Set(DIAGNOSIS_CATEGORIES);
const FILE_ROLES = new Set(["stdout", "stderr", "sibling"]);
const JOB_ID_RE = /^\d{1,12}(?:_\d{1,9})?$/;

const str = (value, max) => (typeof value === "string" && value ? value.slice(0, max) : null);
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

// 按 UTF-8 字节保留末尾 maxBytes（不切坏多字节字符）。
export function tailBytes(text, maxBytes) {
  const value = String(text ?? "");
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

export function headBytes(text, maxBytes) {
  const value = String(text ?? "");
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

// 入库前的规整：字段白名单 + 截断。不合格 → null。
export function sanitizeDiagnosis(raw) {
  if (!raw || typeof raw !== "object") return null;
  const jobId = typeof raw.jobId === "string" && JOB_ID_RE.test(raw.jobId) ? raw.jobId : null;
  const serverId = str(raw.serverId, 64);
  if (!jobId || !serverId || !CATEGORY_SET.has(raw.category) || typeof raw.headline !== "string") return null;
  return {
    jobId,
    serverId,
    name: str(raw.name, 200),
    state: str(raw.state, 32),
    exitCode: Number.isInteger(raw.exitCode) ? raw.exitCode : null,
    endedAt: finiteOrNull(raw.endedAt),
    category: raw.category,
    headline: raw.headline.slice(0, HEADLINE_MAX),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : [])
      .filter((line) => typeof line === "string")
      .slice(-EVIDENCE_MAX_LINES)
      .map((line) => line.slice(0, EVIDENCE_LINE_MAX)),
    files: (Array.isArray(raw.files) ? raw.files : [])
      .filter((file) => file && typeof file.path === "string" && file.path)
      .slice(0, FILES_MAX)
      .map((file) => ({
        path: file.path.slice(0, 1024),
        tail: tailBytes(typeof file.tail === "string" ? file.tail : "", STORED_TAIL_BYTES),
        // v2.51 起：文件角色与取证时的大小（日志按段向前读取据此衔接）；旧记录没有这两项。
        ...(FILE_ROLES.has(file.role) ? { role: file.role } : {}),
        ...(Number.isSafeInteger(file.size) && file.size >= 0 ? { size: file.size } : {}),
      })),
    script: typeof raw.script === "string" && raw.script ? headBytes(raw.script, STORED_SCRIPT_BYTES) : null,
    source: SOURCES.has(raw.source) ? raw.source : "none",
    diagnosedAt: finiteOrNull(raw.diagnosedAt),
  };
}

const keyOf = (serverId, jobId) => `${serverId}\u0000${jobId}`;
const timeOf = (item) => item.endedAt ?? item.diagnosedAt ?? 0;

// filePath 为 null：只在内存里（测试 / 未接存储的装配）。
export function createDiagnosesStore({
  filePath = null,
  now = Date.now,
  maxItems = DIAGNOSES_MAX_ITEMS,
  retentionMs = DIAGNOSES_RETENTION_MS,
  maxBytes = DIAGNOSES_MAX_BYTES,
  log = () => {},
} = {}) {
  const items = new Map();
  let loaded = null;
  let writing = Promise.resolve();

  function load() {
    if (!loaded) {
      loaded = (async () => {
        if (!filePath) return;
        let parsed = null;
        try {
          parsed = JSON.parse(await readFile(filePath, "utf8"));
        } catch (err) {
          // 内容损坏先留档再当空表重来；读不出（权限等）只记日志、当空表重来。
          if (isParseFailure(err)) await archiveCorruptFile(filePath, { now, log, label: "失败作业诊断" });
          else if (err?.code !== "ENOENT") log(`job diagnoses unreadable, starting empty: ${err.message}`, { level: "warn", event: "jobs" });
          return;
        }
        for (const raw of (Array.isArray(parsed?.items) ? parsed.items : []).slice(0, maxItems * 2)) {
          const item = sanitizeDiagnosis(raw);
          if (item) items.set(keyOf(item.serverId, item.jobId), item);
        }
        prune();
      })();
    }
    return loaded;
  }

  // 保留期 → 条数上限 → 字节预算，三道都从最旧的删起。返回最终的序列化正文。
  function prune() {
    const cutoff = now() - retentionMs;
    for (const [key, item] of items) if (timeOf(item) < cutoff) items.delete(key);
    const sorted = [...items.entries()].sort((a, b) => timeOf(a[1]) - timeOf(b[1]));
    while (sorted.length > maxItems) items.delete(sorted.shift()[0]);
    let body = serialize();
    while (Buffer.byteLength(body) > maxBytes && sorted.length) {
      // 一次删掉超出比例对应的条数（至少 1 条），避免逐条重算整份 JSON。
      const over = Buffer.byteLength(body) / maxBytes;
      const drop = Math.max(1, Math.ceil(sorted.length * (1 - 1 / over)));
      for (const [key] of sorted.splice(0, drop)) items.delete(key);
      body = serialize();
    }
    return body;
  }

  function serialize() {
    return JSON.stringify({ schemaVersion: 1, items: [...items.values()] });
  }

  function has(serverId, jobId) {
    return items.has(keyOf(serverId, jobId));
  }

  function get(serverId, jobId) {
    const item = items.get(keyOf(serverId, jobId));
    return item ? { ...item, evidence: [...item.evidence], files: item.files.map((f) => ({ ...f })) } : null;
  }

  // 新 → 旧；since（epoch 毫秒）只留结束（或诊断）时刻不早于它的。
  function list(serverId, { since = null } = {}) {
    return [...items.values()]
      .filter((item) => item.serverId === serverId && (!Number.isFinite(since) || timeOf(item) >= since))
      .sort((a, b) => timeOf(b) - timeOf(a) || b.jobId.localeCompare(a.jobId, "en", { numeric: true }))
      .map((item) => ({ ...item, evidence: [...item.evidence], files: item.files.map((f) => ({ ...f })) }));
  }

  // 一批诊断结果入库并写盘（一轮取证最多一次写盘）。返回实际入库的条数。
  async function putMany(list) {
    await load();
    let count = 0;
    for (const raw of Array.isArray(list) ? list : []) {
      const item = sanitizeDiagnosis({ diagnosedAt: now(), ...raw });
      if (!item) continue;
      items.set(keyOf(item.serverId, item.jobId), item);
      count += 1;
    }
    if (!count) return 0;
    const body = prune();
    if (filePath) {
      writing = writing
        .catch(() => {})
        .then(async () => {
          await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
          await writeFileAtomic(filePath, body);
        })
        .catch((err) => log(`job diagnoses write failed: ${err.message}`, { level: "warn", event: "jobs" }));
      await writing;
    }
    return count;
  }

  return { load, has, get, list, putMany, size: () => items.size, flush: () => writing };
}
