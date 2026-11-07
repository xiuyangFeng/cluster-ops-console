import { mkdirSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { appendFile, open, stat } from "node:fs/promises";
import { join } from "node:path";

import { bus, EVENTS } from "./event-bus.mjs";
import { redactSensitive } from "./operation-context.mjs";

// 模块级 ring 缓冲注册表：每个 logger 拥有独立的环形缓冲，
// queryLogs 跨所有 logger 聚合，从而支持按 source 统一检索。
const registry = [];
// 单调递增序号，保证同毫秒内写入的日志仍有稳定的时间升序。
let globalSeq = 0;

// 增量读取持续追加的 NDJSON 文件。保留文件 offset，轮转（inode 变化）或
// 原地截断后自动从新文件开头恢复，避免 monitor-server 周期性整文件读取。
export function createNdjsonTailReader(filePath, {
  initialTailBytes = 128 * 1024,
  maxReadBytes = 256 * 1024,
} = {}) {
  let offset = null;
  let identity = null;
  let carry = "";

  async function readNew() {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return "";
    }
    const nextIdentity = `${info.dev ?? ""}:${info.ino ?? ""}`;
    let dropFirstPartial = false;
    if (offset == null) {
      offset = Math.max(0, info.size - initialTailBytes);
      dropFirstPartial = offset > 0;
    } else if (identity !== nextIdentity || info.size < offset) {
      offset = 0;
      carry = "";
    }
    identity = nextIdentity;
    if (info.size <= offset) return "";

    let start = offset;
    if (info.size - start > maxReadBytes) {
      start = info.size - maxReadBytes;
      carry = "";
      dropFirstPartial = true;
    }
    const readLen = info.size - start;
    const handle = await open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readLen);
      const { bytesRead } = await handle.read(buffer, 0, readLen, start);
      offset = start + bytesRead;
      const parts = `${carry}${buffer.subarray(0, bytesRead).toString("utf8")}`.split("\n");
      carry = parts.pop() || "";
      if (dropFirstPartial) parts.shift();
      return parts.length ? `${parts.join("\n")}\n` : "";
    } finally {
      await handle.close();
    }
  }

  return { readNew };
}

// 轮转只保留一份 .1（v2.18 由 3 份收紧）：agent.md「日志处理与系统轻量化规范」第 2 条明令
// "严禁无限制增长或保留过多历史冗余分卷，避免宿主机磁盘空间被高频轮询的 SSH 日志爆盘"。
// 每个 source 原先最多占 2MB×4 = 8MB，十来个 source 就把 50MB 的 runtime 预算吃掉大半；
// 收到 1 份后每 source 上限 4MB，深回溯仍有一份完整轮转历史可读（readLogHistoryFiles 只读 .1 + 当前）。
const GLOBAL_RING_BYTES = 8 * 1024 * 1024;
const GLOBAL_QUEUE_BYTES = 2 * 1024 * 1024;
const MAX_LOGGERS = 256;
let globalRingBytes = 0;
let globalQueuedBytes = 0;

function trimGlobalRings() {
  while (globalRingBytes > GLOBAL_RING_BYTES) {
    let oldest = null;
    for (const record of registry) if (record.ring.length && (!oldest || record.ring[0].seq < oldest.ring[0].seq)) oldest = record;
    if (!oldest) break;
    const removed = oldest.ring.shift();
    oldest.bytes -= removed.bytes;
    globalRingBytes -= removed.bytes;
  }
}

export function getLoggerStats() {
  return { ringBytes: globalRingBytes, maxRingBytes: GLOBAL_RING_BYTES,
    queuedBytes: globalQueuedBytes, maxQueueBytes: GLOBAL_QUEUE_BYTES, loggers: registry.length, maxLoggers: MAX_LOGGERS };
}

// Used by graceful signal handlers before process.exit. It also waits for a
// currently running append; an empty pending queue does not mean the disk is done.
export async function flushAllLoggers() { await Promise.all(registry.map((r) => r.flush?.())); }

export function createLogger(source, {
  dir, maxBytes = 2 * 1024 * 1024, ringSize = 2000,
  defaultFields = {}, maxQueueBytes = 256 * 1024, maxRingBytes = 512 * 1024,
  flushDebounceMs = 50, appendFileImpl = appendFile,
} = {}) {
  if (!/^[\w.-]{1,128}$/.test(source)) throw new Error("Invalid logger source");
  if (registry.length >= MAX_LOGGERS) throw new Error("Logger limit reached; dispose unused loggers");
  maxBytes = Math.min(2 * 1024 * 1024, Math.max(1024, Number(maxBytes) || 2 * 1024 * 1024));
  ringSize = Math.min(10000, Math.max(1, Number(ringSize) || 2000));
  maxRingBytes = Math.min(GLOBAL_RING_BYTES, Math.max(1024, Number(maxRingBytes) || 512 * 1024));
  maxQueueBytes = Math.min(GLOBAL_QUEUE_BYTES, Math.max(1024, Number(maxQueueBytes) || 256 * 1024));
  const ring = [];
  const record = { source, ring, bytes: 0, flush: null };
  registry.push(record);
  let filePath = null;
  let fileSize = 0;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      filePath = join(dir, `${source}.ndjson`);
      try { fileSize = statSync(filePath).size; } catch {}
    } catch {}
  }
  const queue = [];
  let queuedBytes = 0; // Includes the one batch currently awaiting disk I/O.
  let dropped = 0;
  let writeErrors = 0;
  let flushTimer = null;
  let flushPromise = null;
  let disposed = false;
  let closing = false;

  function rotate() {
    if (fileSize > maxBytes) truncateSync(filePath, maxBytes);
    try { renameSync(filePath, `${filePath}.1`); } catch (e) { if (e.code !== "ENOENT") throw e; }
    const marker = `${JSON.stringify({ ts: Date.now(), source, level: "info", message: `LOG AUTO-ROTATED AT ${new Date().toISOString()}`, rotated: true })}\n`;
    // A tiny synchronous metadata/reset operation, only at rotation. Normal log
    // bodies are appended asynchronously and never make a file exceed maxBytes.
    writeFileSync(filePath, marker, { mode: 0o600 });
    fileSize = Buffer.byteLength(marker);
  }
  function clearTimer() { if (flushTimer) clearTimeout(flushTimer); flushTimer = null; }
  function flush() {
    clearTimer();
    if (flushPromise) return flushPromise;
    if (!filePath || !queue.length) return Promise.resolve();
    flushPromise = (async () => {
      while (queue.length) {
        let count = 0;
        let bytes = 0;
        try {
          if (fileSize + queue[0].bytes > maxBytes) rotate();
          while (count < queue.length && bytes + queue[count].bytes <= Math.min(64 * 1024, maxBytes - fileSize)) {
            bytes += queue[count].bytes;
            count += 1;
          }
          if (!count) throw new Error("log entry exceeds remaining file budget");
          const batch = queue.splice(0, count);
          try {
            await appendFileImpl(filePath, batch.map((item) => item.line).join(""), { mode: 0o600 });
            fileSize += bytes;
          } catch { dropped += count; writeErrors += 1; try { fileSize = statSync(filePath).size; } catch { fileSize = 0; } }
        } catch {
          // Rotation failure must not leave a permanent queue or recursive retry storm.
          const item = queue.shift();
          bytes = item?.bytes || 0;
          dropped += item ? 1 : 0;
          writeErrors += 1;
        } finally {
          queuedBytes -= bytes;
          globalQueuedBytes -= bytes;
        }
      }
    })().finally(() => {
      flushPromise = null;
      // An append queued between the last drain iteration and this microtask
      // must not lose its wakeup (nor escape the caller's flush promise).
      if (queue.length) return flush();
    });
    return flushPromise;
  }
  record.flush = flush;
  function persist(line, bytes) {
    if (!filePath) return;
    if (queuedBytes + bytes > maxQueueBytes || globalQueuedBytes + bytes > GLOBAL_QUEUE_BYTES) { dropped += 1; return; }
    queue.push({ line, bytes });
    queuedBytes += bytes;
    globalQueuedBytes += bytes;
    if (!flushTimer && !flushPromise) {
      flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, flushDebounceMs);
      flushTimer.unref?.();
    }
  }
  function append(level, message, fields) {
    if (disposed || closing) return null;
    let entry = redactSensitive({ ts: Date.now(), source, ...defaultFields, ...(fields || {}), level, message });
    let line = `${JSON.stringify(entry)}\n`;
    const entryLimit = Math.min(16384, maxBytes - 512);
    if (Buffer.byteLength(line) > entryLimit) {
      // Do not retain a huge nested object in the ring or event bus either.
      entry = { ts: entry.ts, source, level, message: String(entry.message || "").slice(0, 64), truncated: true };
      line = `${JSON.stringify(entry)}\n`;
    }
    const bytes = Buffer.byteLength(line);
    ring.push({ seq: globalSeq++, entry, bytes });
    record.bytes += bytes;
    globalRingBytes += bytes;
    while (ring.length > ringSize || record.bytes > maxRingBytes) {
      const removed = ring.shift();
      record.bytes -= removed.bytes;
      globalRingBytes -= removed.bytes;
    }
    trimGlobalRings();
    bus.emit(EVENTS.LOG_APPENDED, entry);
    persist(line, bytes);
    return entry;
  }
  async function dispose() {
    if (disposed) return;
    closing = true;
    await flush();
    disposed = true;
    clearTimer();
    globalRingBytes -= record.bytes;
    record.bytes = 0;
    ring.length = 0;
    const i = registry.indexOf(record);
    if (i >= 0) registry.splice(i, 1);
  }
  return { info: (msg, fields) => append("info", msg, fields), warn: (msg, fields) => append("warn", msg, fields),
    error: (msg, fields) => append("error", msg, fields), flush, dispose,
    stats: () => ({ queuedBytes, maxQueueBytes, ringBytes: record.bytes, maxRingBytes, dropped, writeErrors, flushing: Boolean(flushPromise) }) };
}

function isRoutineBridgeSnapshot(entry) {
  return entry?.message === "bridge stage snapshot"
    && entry.bridgeStage?.ok === true
    && !entry.bridgeStage?.adopted
    && !entry.bridgeStage?.foreign;
}

// 共享过滤谓词：queryLogs 与 parseNdjsonTail 使用同一套筛选语义。
// q 为大小写不敏感子串，匹配 message 或整条序列化 entry（含 fields）。
function matchEntry(entry, { source, level, since, until, q, operationId, hideRoutineSnapshots = false } = {}) {
  if (source && entry.source !== source) return false;
  if (level && entry.level !== level) return false;
  if (since != null && entry.ts < since) return false;
  if (until != null && entry.ts > until) return false;
  if (operationId && entry.operationId !== operationId) return false;
  const needle = q ? String(q).toLowerCase() : "";
  if (hideRoutineSnapshots && isRoutineBridgeSnapshot(entry) && (!needle || !"bridge stage snapshot".includes(needle))) return false;
  if (needle) {
    // 剔除 ts 再序列化：毫秒时间戳几乎包含任意数字子串，会让数字查询全量误命中。
    const { ts: _ts, ...rest } = entry;
    const hay = `${entry.message || ""}\n${JSON.stringify(rest)}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

// 日志检索的 limit 语义：缺省条数与上限。queryLogs / parseNdjsonTail 共用，
// /api/logs 也按它判断"ring 是否已返回满 limit 条"（lib/http/routes/logs.mjs）。
export const LOG_QUERY_DEFAULT_LIMIT = 200;
export const LOG_QUERY_MAX_LIMIT = 500;

// 跨所有 logger 聚合检索日志。entries 按时间升序，返回最近的 limit 条。
export function queryLogs({ source, level, since, until, q, operationId, hideRoutineSnapshots = false, limit = LOG_QUERY_DEFAULT_LIMIT } = {}) {
  const matched = [];
  for (const { ring } of registry) {
    for (const item of ring) {
      if (!matchEntry(item.entry, { source, level, since, until, q, operationId, hideRoutineSnapshots })) continue;
      matched.push(item);
    }
  }

  matched.sort((a, b) => (a.entry.ts - b.entry.ts) || (a.seq - b.seq));

  const cappedLimit = Math.min(Math.max(1, limit), LOG_QUERY_MAX_LIMIT);
  const total = matched.length;
  const sliced = matched.slice(-cappedLimit).map((item) => item.entry);
  return { entries: sliced, total };
}

// 某 source 在内存 ring 中的未过滤最旧时间戳（ring 按写入序，ring[0] 即最旧）。
// 供 /api/logs 判断"请求的 since 范围是否已被 ring 完整覆盖"——过滤后的结果集最旧
// 条目恒 >= since（matchEntry 保证），不能用来判断覆盖范围。ring 为空返回 null。
export function getRingOldestTs(source) {
  let oldest = null;
  for (const { source: src, ring } of registry) {
    if (source && src !== source) continue;
    if (ring.length && (oldest == null || ring[0].entry.ts < oldest)) oldest = ring[0].entry.ts;
  }
  return oldest;
}

// 按时间先后（最旧轮转 → 当前）拼接某 source 的磁盘 NDJSON 历史；供 /api/logs 深回溯。
// 文件缺失逐个跳过，绝不抛出。
//
// 性能加固：此前为同步 readFileSync ×(轮转份数+1)（每个文件至多 2MB），在 HTTP 请求
// 路径上阻塞事件循环。现改为：
//  - fs/promises 异步读取（调用方 await）；
//  - 逐文件缓存：以 (path, size, mtimeMs) 为不变性判据，未变化直接复用上次读取内容
//    （轮转文件 .1 一旦生成即不可变，几乎永远命中）；
//  - 最小读盘间隔：HISTORY_MIN_READ_INTERVAL_MS 内对同一 (dir, source) 的重复请求直接
//    返回上次拼接结果，连 stat 都不再发起（前端轮询风暴的兜底）。
const HISTORY_MIN_READ_INTERVAL_MS = 2000;
const historyFileCache = new Map(); // filePath -> { size, mtimeMs, text }
const historyJoinCache = new Map(); // `${dir}|${source}` -> { joined, readAt, sig }
const HISTORY_CACHE_BYTES = 4 * 1024 * 1024;
const HISTORY_FILE_BYTES = 2 * 1024 * 1024;
// 回读磁盘历史只在有人翻日志时发生（日志面板按来源筛选、按操作回看）。缓存的原文、拼接串与解析结果（真实日志
// 约 5MB）原先一直留到进程退出：最后一次回读满 60s 后一并放手（常驻内存），下次回读按需重读。
// 面板轮询的间隔远小于 60s，翻看期间照常命中缓存。
const HISTORY_IDLE_RELEASE_MS = 60_000;
let historyReleaseTimer = null;
function scheduleHistoryRelease() {
  if (historyReleaseTimer) {
    historyReleaseTimer.refresh();
    return;
  }
  historyReleaseTimer = setTimeout(() => {
    historyReleaseTimer = null;
    historyFileCache.clear();
    historyJoinCache.clear();
    parsedTailCache.clear();
  }, HISTORY_IDLE_RELEASE_MS);
  historyReleaseTimer.unref?.();
}

function cacheHistory(cache, key, value, textField) {
  cache.delete(key);
  const bytes = Buffer.byteLength(value[textField]);
  if (bytes > HISTORY_CACHE_BYTES) return;
  cache.set(key, { ...value, bytes });
  let total = [...cache.values()].reduce((sum, item) => sum + item.bytes, 0);
  while (total > HISTORY_CACHE_BYTES || cache.size > 64) {
    const oldest = cache.keys().next().value;
    total -= cache.get(oldest).bytes;
    cache.delete(oldest);
  }
}

export async function readLogHistoryFiles(dir, source, { now = Date.now } = {}) {
  if (!dir || !source) return "";
  scheduleHistoryRelease();
  const joinKey = `${dir}|${source}`;
  const ts = now();
  const recent = historyJoinCache.get(joinKey);
  if (recent && ts - recent.readAt < HISTORY_MIN_READ_INTERVAL_MS) return recent.joined;

  const base = join(dir, `${source}.ndjson`);
  const files = [`${base}.1`, base];

  const parts = [];
  const sigParts = [];
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch {
      historyFileCache.delete(file);
      continue;
    }
    sigParts.push(`${file}:${info.size}:${info.mtimeMs}`);
    const cached = historyFileCache.get(file);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
      parts.push(cached.text);
      continue;
    }
    try {
      // Old/external logs can exceed rotation policy; never read an unbounded file.
      const handle = await open(file, "r");
      let text;
      try {
        const length = Math.min(info.size, HISTORY_FILE_BYTES);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
        text = buffer.subarray(0, bytesRead).toString("utf8");
        if (info.size > length) text = text.slice(text.indexOf("\n") + 1);
      } finally { await handle.close(); }
      cacheHistory(historyFileCache, file, { size: info.size, mtimeMs: info.mtimeMs, text }, "text");
      parts.push(text);
    } catch {}
  }
  const sig = sigParts.join("|");
  if (recent && recent.sig === sig) {
    recent.readAt = ts;
    return recent.joined;
  }
  const joined = parts.join("");
  cacheHistory(historyJoinCache, joinKey, { joined, readAt: ts, sig }, "joined");
  return joined;
}

// 基于内存 ring 的异常聚合：各时间窗口内逐源 error/warn 计数 + top-5 高频异常消息。
// 统计范围受 ring 容量限制（每源默认 2000 条），足够覆盖近期异常画像。
export function summarizeLogs({ windows = [3600e3, 21600e3, 86400e3], now = Date.now } = {}) {
  const ts = now();
  return {
    windows: windows.map((windowMs) => {
      const bySource = {};
      const msgCounts = new Map(); // 归一化 message -> { message, level, count }
      for (const { ring } of registry) {
        for (const { entry } of ring) {
          if (entry.ts < ts - windowMs) continue;
          if (entry.level !== "error" && entry.level !== "warn") continue;
          bySource[entry.source] ||= { error: 0, warn: 0 };
          const src = bySource[entry.source];
          src[entry.level] += 1;
          const norm = String(entry.message || "").slice(0, 80);
          const item = msgCounts.get(norm) || { message: norm, level: entry.level, count: 0 };
          item.count += 1;
          if (entry.level === "error") item.level = "error";
          msgCounts.set(norm, item);
        }
      }
      const topMessages = Array.from(msgCounts.values()).sort((a, b) => b.count - a.count).slice(0, 5);
      return { windowMs, bySource, topMessages };
    }),
  };
}

const parsedTailCache = new Map(); // tailLines -> { text, entries }

function parseRawTailEntries(text, tailLines) {
  if (!text || tailLines <= 0) return [];
  const cached = parsedTailCache.get(tailLines);
  if (cached && cached.text === text) return cached.entries;

  const lines = [];
  let end = text.length;
  while (end > 0 && lines.length < tailLines) {
    const nl = text.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    if (end > start) lines.push(text.slice(start, end));
    if (nl < 0) break;
    end = nl;
  }
  const entries = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue; // 跳过损坏/不完整行
    }
    if (!entry || typeof entry !== "object" || typeof entry.ts !== "number") continue;
    entries.push(entry);
  }
  entries.sort((a, b) => a.ts - b.ts);
  if (text.length <= 8 * 1024 * 1024 && tailLines <= 5000) {
    if (parsedTailCache.size >= 4) parsedTailCache.delete(parsedTailCache.keys().next().value);
    parsedTailCache.set(tailLines, { text, entries });
  }
  return entries;
}

// 从 NDJSON 文本尾部解析日志（用于 ring 中无条目、但磁盘存在 <source>.ndjson 的进程，
// 例如 supervisor）。防御式逐行解析（跳过不可解析行），并应用与 queryLogs 相同的过滤。
export function parseNdjsonTail(rawText, { source, level, since, until, q, operationId, hideRoutineSnapshots = false, limit = LOG_QUERY_DEFAULT_LIMIT, tailLines = 500 } = {}) {
  const rawEntries = parseRawTailEntries(String(rawText || ""), tailLines);
  const parsed = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];
    if (matchEntry(entry, { source, level, since, until, q, operationId, hideRoutineSnapshots })) {
      parsed.push(entry);
    }
  }
  const cappedLimit = Math.min(Math.max(1, limit), LOG_QUERY_MAX_LIMIT);
  const total = parsed.length;
  const sliced = total > cappedLimit ? parsed.slice(-cappedLimit) : parsed;
  return { entries: sliced, total };
}
