import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { archiveCorruptFileSync, isParseFailure } from "./corrupt-archive.mjs";

// 每张 GPU 卡的利用率（%，按卡序）：GPU 卡的近 24 小时走势用。数组只收有限数，最多 16 张卡，取整。
export const GPU_UTIL_MAX_CARDS = 16;
export function normalizeGpuUtil(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const out = value.slice(0, GPU_UTIL_MAX_CARDS).map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : null));
  return out.some((v) => v != null) ? out : null;
}
// 直连节点（不在 Slurm 分区里、从登录节点跳采的机器，如 node04）各卡利用率：{ 节点名: [各卡 %] }。
// 节点名按 Slurm 节点名规则校验，最多 8 个节点，每个节点同 normalizeGpuUtil；一个有效值都没有就不存。
export const NODE_GPU_MAX_NODES = 8;
const NODE_KEY_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
export function normalizeNodeGpuUtil(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  let count = 0;
  for (const [node, list] of Object.entries(value)) {
    if (count >= NODE_GPU_MAX_NODES) break;
    if (!NODE_KEY_RE.test(node)) continue;
    const util = normalizeGpuUtil(list);
    if (!util) continue;
    out[node] = util;
    count += 1;
  }
  return count ? out : null;
}
const FIELDS = ["cpu", "ram", "disk", "cpuBusyPct", "loadNormalizedPct", "metricSchemaVersion", "tunnelUp", "probeDurationMs", "proxyLatencyMs", "level", "ok", "latencyMs", "stage", "durationMs", "consecutiveFailures", "lastSuccessAt", "checks", "restarts", "reconnects", "fastFailures", "backoffRemainingMs"];
const bounded = (n, fallback, max) => Number.isFinite(n) && n > 0 ? Math.min(max, Math.trunc(n)) : fallback;
let storeSequence = 0;
// 整份快照（生产约 2MB）重写的最小间隔。原 60s 意味着每小时 ~120MB 写放大；
// 改为 5 分钟一次，正常退出（dispose/flushSync）仍会立即落盘，崩溃最多丢 5 分钟采样。
export const METRICS_FLUSH_DEBOUNCE_MS = 5 * 60 * 1000;

// Bounds cover all server/probe keys together. Normal writes are serialized and
// versioned; flushSync is the terminal shutdown path and invalidates stale writes.
export function createMetricsStore({
  filePath, maxSamplesPerServer = 5760, maxAgeMs = 24 * 60 * 60 * 1000,
  flushDebounceMs = METRICS_FLUSH_DEBOUNCE_MS, maxMemoryBytes = 8 * 1024 * 1024,
  maxTotalSamples = 32768, maxServers = 128, now = Date.now,
  io = { mkdir, unlink, writeFile },
  // ops 日志：metrics.json 解析不了时记一条警告（先留档再按空表重来，见 load）。
  log = () => {},
} = {}) {
  maxSamplesPerServer = bounded(maxSamplesPerServer, 5760, 32768);
  maxMemoryBytes = bounded(maxMemoryBytes, 8 * 1024 * 1024, 32 * 1024 * 1024);
  maxTotalSamples = bounded(maxTotalSamples, 32768, 131072);
  maxServers = bounded(maxServers, 128, 1024);
  const servers = new Map();
  const sampleBytes = new WeakMap();
  let storedBytes = 0;
  let sampleCount = 0;
  let evicted = 0;
  let revision = 0;
  let persistedRevision = 0;
  let flushTimer = null;
  let flushPromise = null;
  let closed = false;
  let closing = false;
  let generation = 0;
  let writeErrors = 0;
  const tmp = filePath ? `${filePath}.async-${process.pid}-${++storeSequence}.tmp` : null;

  function dropFirst(id, list) {
    const removed = list.shift();
    if (removed) { storedBytes -= sampleBytes.get(removed) || 0; sampleCount -= 1; evicted += 1; }
    if (!list.length) servers.delete(id);
  }
  function prune() {
    const cutoff = now() - maxAgeMs;
    const before = sampleCount;
    for (const [id, list] of servers) {
      while (list.length && (list[0].ts < cutoff || list.length > maxSamplesPerServer)) dropFirst(id, list);
    }
    while (sampleCount > maxTotalSamples || storedBytes > maxMemoryBytes || servers.size > maxServers) {
      let oldestId;
      let oldestTs = Infinity;
      for (const [id, list] of servers) if (list[0]?.ts < oldestTs) { oldestTs = list[0].ts; oldestId = id; }
      if (oldestId == null) break;
      const list = servers.get(oldestId);
      if (servers.size > maxServers) {
        while (list.length) dropFirst(oldestId, list);
      } else dropFirst(oldestId, list);
    }
    if (sampleCount !== before) revision += 1;
  }
  function scheduleFlush() {
    if (!filePath || closed || flushTimer || flushPromise) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, flushDebounceMs);
    flushTimer.unref?.();
  }
  function clearTimer() { if (flushTimer) clearTimeout(flushTimer); flushTimer = null; }
  function snapshot() {
    return JSON.stringify({ version: 1, servers: Object.fromEntries(servers) });
  }
  function addSample(input = {}) {
    if (closed || closing || !input || typeof input.serverId !== "string" || !input.serverId || input.serverId.length > 128) return false;
    const { serverId } = input;
    const ts = input.ts ?? now();
    if (!Number.isFinite(ts) || ts < now() - maxAgeMs || ts > now() + 60000) return false;
    const sample = { ts, serverId, kind: typeof input.kind === "string" ? input.kind.slice(0, 64) : "resource" };
    for (const field of FIELDS) {
      const v = input[field];
      if (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) sample[field] = v;
      else if (typeof v === "string") sample[field] = v.slice(0, 256);
    }
    const gpuUtil = normalizeGpuUtil(input.gpuUtil);
    if (gpuUtil) sample.gpuUtil = gpuUtil;
    const nodeGpuUtil = normalizeNodeGpuUtil(input.nodeGpuUtil);
    if (nodeGpuUtil) sample.nodeGpuUtil = nodeGpuUtil;
    const line = JSON.stringify(sample);
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > maxMemoryBytes) return false;
    const list = servers.get(serverId) || [];
    if (sample.kind === "bridge-stage" && list.some((s) => s.ts === ts && s.stage === sample.stage && JSON.stringify(s) === line)) return false;
    // Replayed tails can arrive out of order; preserve timestamp ordering for TTL eviction.
    let at = list.length;
    while (at > 0 && list[at - 1].ts > ts) at -= 1;
    list.splice(at, 0, sample);
    sampleBytes.set(sample, bytes);
    storedBytes += bytes;
    sampleCount += 1;
    servers.set(serverId, list);
    revision += 1;
    prune();
    scheduleFlush();
    return true;
  }
  function query({ serverId, since, kind = "resource" } = {}) {
    prune();
    const list = serverId ? (servers.get(serverId) || []) : [...servers.values()].flat().sort((a, b) => a.ts - b.ts);
    return { samples: list.filter((s) => (!kind || s.kind === kind) && (since == null || s.ts >= since)).map((s) => ({ ...s })) };
  }
  function load() {
    if (!filePath || closed) return;
    try {
      // Reject oversized snapshots before reading/JSON parsing, including legacy data.
      if (statSync(filePath).size > maxMemoryBytes + maxServers * 300 + 128) return;
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(filePath, "utf8"));
      } catch (err) {
        // 解析不了：先留档（<名字>.corrupt-<北京时间>）再按空表重来；下一次落盘写新文件。
        if (isParseFailure(err)) archiveCorruptFileSync(filePath, { now, log, label: "资源指标" });
        return;
      }
      const data = parsed?.servers || parsed;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      for (const [id, list] of Object.entries(data)) {
        if (!Array.isArray(list)) continue;
        for (const sample of list) if (sample && typeof sample === "object") addSample({ ...sample, serverId: id });
      }
    } catch {}
  }
  function flush() {
    clearTimer();
    if (flushPromise) return flushPromise;
    if (!filePath || closed || persistedRevision === revision) return Promise.resolve();
    const epoch = generation;
    flushPromise = (async () => {
      try {
        await io.mkdir(dirname(filePath), { recursive: true });
        while (!closed && epoch === generation && persistedRevision !== revision) {
          prune();
          const writingRevision = revision;
          const payload = snapshot();
          await io.writeFile(tmp, payload, { mode: 0o600 });
          if (closed || epoch !== generation) break;
          // Only the atomic metadata commit is synchronous: shutdown cannot
          // interleave between the generation check and replacement.
          renameSync(tmp, filePath);
          persistedRevision = writingRevision;
        }
      } catch { writeErrors += 1; }
      finally { try { await io.unlink(tmp); } catch {} }
    })().finally(() => {
      flushPromise = null;
      if (!closed && persistedRevision !== revision) scheduleFlush();
    });
    return flushPromise;
  }
  function flushSync() {
    clearTimer();
    if (closed) return;
    closed = true;
    generation += 1;
    if (!filePath) return;
    // Write even when the async queue has already snapshotted the latest revision.
    // A distinct temp file prevents concurrent async write/truncate corruption.
    try {
      prune();
      mkdirSync(dirname(filePath), { recursive: true });
      const exitTmp = `${tmp}.exit`;
      writeFileSync(exitTmp, snapshot(), { mode: 0o600 });
      renameSync(exitTmp, filePath);
      persistedRevision = revision;
    } catch { writeErrors += 1; }
  }
  async function dispose() { closing = true; await flush(); closed = true; generation += 1; clearTimer(); }
  return { addSample, query, load, flush, flushSync, dispose,
    stats: () => ({ storedBytes, maxMemoryBytes, sampleCount, maxTotalSamples, servers: servers.size, maxServers, evicted, writeErrors, dirty: persistedRevision !== revision, flushing: Boolean(flushPromise) }) };
}

// 探针历史统计：可用率一位小数；延迟仅统计有 latencyMs 的样本。
export function computeProbeStats(samples = []) {
  const total = samples.length;
  const okCount = samples.filter((s) => s.ok === true).length;
  const lat = samples.map((s) => s.latencyMs).filter((v) => typeof v === "number");
  return {
    total,
    okCount,
    uptimePct: total ? Math.round((okCount / total) * 1000) / 10 : null,
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    maxLatencyMs: lat.length ? lat.reduce((max, value) => Math.max(max, value), -Infinity) : null,
  };
}
