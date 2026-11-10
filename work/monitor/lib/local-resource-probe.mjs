import { windowsSystemTool } from "./processes/windows-query.mjs";
import { execFileWithTimeout } from "./exec.mjs";
import { cpus, freemem, totalmem } from "node:os";
import { performance } from "node:perf_hooks";

const PROCESS_OUTPUT_LIMIT = 256 * 1024;
const SAMPLE_TIMEOUT_MS = 2000;
const MAX_PROCESS_SAMPLES = 10000;
const WINDOWS_PROCESS_SCRIPT = "$ErrorActionPreference='Stop'; @(Get-Process | ForEach-Object { $p=$_; try { [pscustomobject]@{pid=$p.Id;name=$p.ProcessName;rssBytes=[double]$p.WorkingSet64;cpuMs=$p.TotalProcessorTime.TotalMilliseconds;started=$p.StartTime.ToUniversalTime().Ticks.ToString()} } catch {} }) | ConvertTo-Json -Compress";
const round = (n) => Number(n.toFixed(1));
const nonnegative = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

// CPU time is cumulative, whereas ps %cpu is a lifetime/decayed average on POSIX.
export function parseProcessCpuTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!match) return null;
  return ((Number(match[1] || 0) * 86400) + (Number(match[2] || 0) * 3600)
    + Number(match[3]) * 60 + Number(match[4])) * 1000;
}

function processName(value) {
  // comm may contain an executable path or spaces, but never request argv/env.
  return [...String(value || "").split(/[\\/]/).at(-1)].filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join("").slice(0, 128);
}

export function parseLocalProcesses(stdout, platform) {
  if (platform === "win32") {
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((p) => ({
      pid: Number(p.pid), name: processName(p.name), rssBytes: Number(p.rssBytes),
      cpuMs: Number(p.cpuMs), started: String(p.started || ""),
    })).filter((p) => p.pid > 0 && p.started && nonnegative(p.rssBytes) && nonnegative(p.cpuMs));
  }
  return String(stdout || "").split("\n").map((line) => {
    // The five lstart columns identify PID reuse; parse comm from the remainder.
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const cpuMs = parseProcessCpuTime(match[3]);
    if (cpuMs == null) return null;
    return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, cpuMs,
      started: match[4].replace(/\s+/g, " "), name: processName(match[5]) };
  }).filter(Boolean);
}

export function createLocalResourceProbe({
  platform = process.platform,
  execFile = execFileWithTimeout,
  now = Date.now,
  monotonicNow = () => performance.now(),
  processLimit = 20,
  cpuUsage = () => process.cpuUsage(),
  memoryUsage = () => process.memoryUsage(),
  cpuSnapshot = cpus,
  totalMemory = totalmem,
  freeMemory = freemem,
} = {}) {
  const limit = Number.isFinite(processLimit) ? Math.min(100, Math.max(1, Math.trunc(processLimit))) : 20;
  let prevHost = null;
  let prevSelf = null;
  let prevProcesses = new Map();
  let lastSample = null;
  let inFlight = null;
  let generation = 0;
  let disposed = false;

  function sampleHost() {
    const host = { busyPct: null, logicalCpuCount: null, quality: "insufficient", cpuSource: "os.cpus.times-delta",
      memory: { totalBytes: null, freeBytes: null, usedBytes: null, usedPct: null, source: "os.totalmem-freemem", quality: "insufficient" } };
    try {
      const totalBytes = totalMemory();
      const freeBytes = freeMemory();
      if (nonnegative(totalBytes) && totalBytes > 0 && nonnegative(freeBytes) && freeBytes <= totalBytes) {
        host.memory = { ...host.memory, totalBytes, freeBytes, usedBytes: totalBytes - freeBytes,
          usedPct: round((totalBytes - freeBytes) / totalBytes * 100), quality: "ok" };
      }
      // Free memory is not OS "available" memory or pressure; never label it as such.
      const cores = cpuSnapshot();
      if (!Array.isArray(cores) || !cores.length) { prevHost = null; return host; }
      host.logicalCpuCount = cores.length;
      const counters = cores.map(({ times }) => {
        const values = [times?.user, times?.nice, times?.sys, times?.idle, times?.irq];
        return values.every(nonnegative) ? { idle: times.idle, total: values.reduce((a, b) => a + b, 0) } : null;
      });
      if (counters.some((c) => c === null)) { prevHost = null; return host; }
      const previous = prevHost;
      prevHost = counters;
      if (!previous || previous.length !== counters.length) return host;
      let total = 0;
      let idle = 0;
      for (let i = 0; i < counters.length; i += 1) {
        const dTotal = counters[i].total - previous[i].total;
        const dIdle = counters[i].idle - previous[i].idle;
        if (dTotal < 0 || dIdle < 0 || dIdle > dTotal) return host;
        total += dTotal;
        idle += dIdle;
      }
      if (total > 0) { host.busyPct = round((total - idle) / total * 100); host.quality = "ok"; }
    } catch { prevHost = null; }
    return host;
  }

  function sampleSelf(cores) {
    let memory = {};
    try { memory = memoryUsage(); } catch {}
    const self = { cpuPct: null, normalizedPct: null, rss: memory.rss ?? null, heapUsed: memory.heapUsed ?? null,
      cpuBasis: "one-core-100-percent", quality: "insufficient" };
    try {
      const usage = cpuUsage();
      const at = monotonicNow();
      const previous = prevSelf;
      prevSelf = { usage, at };
      if (!previous) return self;
      const elapsedUs = (at - previous.at) * 1000;
      const delta = (usage.user - previous.usage.user) + (usage.system - previous.usage.system);
      if (!(elapsedUs > 0) || !nonnegative(delta)) return self;
      self.cpuPct = round(delta / elapsedUs * 100);
      self.normalizedPct = cores ? round(self.cpuPct / cores) : null;
      self.quality = "ok";
    } catch { prevSelf = null; }
    return self;
  }

  async function sampleProcesses(host, epoch) {
    if (!["darwin", "linux", "win32"].includes(platform)) return { processes: [], quality: "unsupported" };
    try {
      const command = platform === "win32" ? windowsSystemTool("powershell") : "ps";
      const args = platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_SCRIPT]
        : [platform === "linux" ? "-eo" : "-axo", "pid=,rss=,time=,lstart=,comm="];
      const result = await execFile(command, args, { timeoutMs: SAMPLE_TIMEOUT_MS,
        maxOutputBytes: PROCESS_OUTPUT_LIMIT, env: { ...process.env, LC_ALL: "C" } });
      if (epoch !== generation) return { processes: [], quality: "insufficient" };
      if (result.code !== 0 || result.truncated || result.timedOut) {
        prevProcesses.clear();
        return { processes: [], quality: "insufficient" };
      }
      const rows = parseLocalProcesses(result.stdout, platform);
      if (!rows.length || rows.length > MAX_PROCESS_SAMPLES) { prevProcesses.clear(); return { processes: [], quality: "insufficient" }; }
      const at = monotonicNow();
      const observedAt = new Date(now()).toISOString();
      const next = new Map();
      let ready = false;
      const processes = rows.map((row) => {
        const key = `${row.pid}:${row.started}`;
        const previous = prevProcesses.get(key);
        const delta = previous ? row.cpuMs - previous.cpuMs : null;
        const elapsed = previous ? at - previous.at : 0;
        const cpuPct = elapsed > 0 && nonnegative(delta) ? round(delta / elapsed * 100) : null;
        next.set(key, { cpuMs: row.cpuMs, at });
        if (cpuPct != null) ready = true;
        return { pid: row.pid, name: row.name, cpuPct,
          normalizedPct: cpuPct != null && host.logicalCpuCount ? round(cpuPct / host.logicalCpuCount) : null,
          cpuBasis: "one-core-100-percent", rssBytes: row.rssBytes, rssKb: row.rssBytes / 1024,
          memPct: host.memory.totalBytes ? round(row.rssBytes / host.memory.totalBytes * 100) : null,
          observedAt, quality: cpuPct == null ? "insufficient" : "ok" };
      });
      prevProcesses = next; // Removed/reused PIDs never accumulate or inherit counters.
      processes.sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1) || b.rssBytes - a.rssBytes || a.pid - b.pid);
      return { processes: processes.slice(0, limit), quality: ready ? "ok" : "insufficient" };
    } catch { if (epoch === generation) prevProcesses.clear(); return { processes: [], quality: "insufficient" }; }
  }

  function sample() {
    if (disposed) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const epoch = generation;
    inFlight = (async () => {
      const host = sampleHost();
      const self = sampleSelf(host.logicalCpuCount);
      const processes = await sampleProcesses(host, epoch);
      if (epoch !== generation) return null;
      lastSample = { schemaVersion: 1, scope: "local", observedAt: new Date(now()).toISOString(), host, self,
        topProcesses: processes.processes, processQuality: processes.quality,
        quality: [host.quality, host.memory.quality, self.quality, processes.quality].every((q) => q === "ok") ? "ok" : "insufficient" };
      return lastSample;
    })().finally(() => { if (epoch === generation) inFlight = null; });
    return inFlight;
  }

  return { sample, getLast: () => lastSample,
    getSummary: () => { if (!lastSample) return null; const { topProcesses, ...summary } = lastSample; return summary; },
    dispose() { disposed = true; generation += 1; prevHost = null; prevSelf = null; prevProcesses.clear(); lastSample = null; inFlight = null; },
  };
}
