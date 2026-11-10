// Slurm 集群快照：collect.sh 的 slurm 段（slow profile，恒在最后）→ 结构化节点与队列数据。
//
// 段内格式（远端 remote/collect.sh ct_slurm 产出）：
//   state=ok|absent|error   version=23.11.8   now=<epoch 秒>   tz=+0800   user=kai
//   error=<代码>            jobs_total=<全量行数>   count=<STATE>=<n>（截断前统计）
//   node=NodeList|StateLong|CPUsState(A/I/O/T)|CPUsLoad|FreeMem|Memory|AllocMem|Gres|GresUsed|Partition|Reason
//   job=JobID|User|Partition|State|TimeUsed|TimeLimit|NumNodes|NumCPUs|tres-alloc|tres-per-node|MinMemory|Submit|Start|Reason|NodeList|Name
// Reason / Name 是行尾自由文本（可能含 |），解析时把剩余部分拼回去。
//   hop=<节点名>|<ok|timeout|unreachable>|<scontrol State 原文>
//   hopkv=<节点名>|<key=value>   直连节点（不在任何分区、经登录节点 ssh 采集）的远端原文：
//     nproc / load / uptime / cpu1 / cpu2（/proc/stat 相隔 1s 的两帧）/ mem_total_kb /
//     mem_avail_kb / gpu=… / gpuproc=…（GPU 两种行与主采集的 gpu 段同一格式，见 gpu-cards.mjs；
//     gpuproc 行的第 6 段是 Slurm 作业号（v2.62 追加）、第 7 段是命令行（v2.76 追加）；
//     采集账号自己的进程按作业号另按作业合并显存，两种行都认）
// 直连节点以 source:"direct" 并入 nodes（Slurm 节点为 source:"slurm"），整体按名字自然序。
//
// 段内原文一律当不可信数据：畸形数字 → null、字符串截断、条目数封顶，任何一行坏掉只丢那一行。
// 时间：squeue 的 "2026-09-30T11:53:47" 是远端本地时间，按同段 tz 偏移换算成 epoch 毫秒；
// 排队时长用远端 now 减提交时刻（同一远端时钟，不受本机时钟偏差影响）。

import { attachGpuUsers, parseGpuAppLine, parseGpuCardLine, parseGpuProcLine } from "./gpu-cards.mjs";
import { humanSizeToBytes } from "./resource-usage.mjs";

export const SLURM_SCHEMA_VERSION = 1;
export const SLURM_MAX_NODES = 256;
export const SLURM_MAX_JOBS = 300;
export const SLURM_MAX_DIRECT_NODES = 8;
const HOP_MAX_KV_LINES = 64;
const HOP_MAX_GPUS = 16;

const NODE_FIELDS = 11;
const JOB_FIELDS = 16;
const NAME_MAX = 200;
const REASON_MAX = 200;
const SHORT_MAX = 64;

const ERROR_REASONS = {
  "sinfo-timeout": "sinfo 超时（slurmctld 无响应）",
  "sinfo-failed": "sinfo 执行失败",
  "squeue-timeout": "squeue 超时（slurmctld 无响应）",
  "squeue-failed": "squeue 执行失败",
};

// 节点状态后缀符号（sinfo StateLong 追加在状态名后）。
const STATE_SUFFIX_FLAGS = {
  "*": "not_responding",
  "~": "powered_off",
  "#": "powering_up",
  "%": "powering_down",
  "!": "power_down_pending",
  $: "maintenance",
  "@": "reboot_pending",
  "^": "reboot_issued",
  "-": "planned",
};

function clip(value, max) {
  const text = String(value == null ? "" : value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

function toInt(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function toFloat(value) {
  const text = String(value == null ? "" : value).trim();
  return /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

function nullIfPlaceholder(value, placeholders, max) {
  const text = clip(value, max);
  if (!text || placeholders.includes(text.toLowerCase())) return null;
  return text;
}

// Slurm 时长："M" / "M:S" / "H:M:S" / "D-H" / "D-H:M" / "D-H:M:S"（与 sbatch --time 同一套规则；
// squeue 的 TimeUsed / TimeLimit 输出是其中的规范形）。UNLIMITED / INVALID / NOT_SET 等 → null。
export function parseSlurmDuration(value) {
  const text = String(value == null ? "" : value).trim();
  let match = /^(\d+)-(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (match) {
    const [, d, h, m = "0", s = "0"] = match;
    return Number(d) * 86400 + Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  match = /^(\d+)(?::(\d+))?(?::(\d+))?$/.exec(text);
  if (!match) return null;
  const parts = match.slice(1).filter((p) => p !== undefined).map(Number);
  if (parts.length === 1) return parts[0] * 60;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// "+0800" / "-0530" → 分钟偏移；非法 → null。
export function parseTzOffset(value) {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (minutes > 14 * 60) return null;
  return match[1] === "-" ? -minutes : minutes;
}

// "2026-09-30T11:53:47"（远端本地时间）+ 偏移分钟 → epoch 毫秒；N/A / Unknown / None → null。
export function parseSlurmTimestamp(value, tzOffsetMin) {
  if (tzOffsetMin == null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(String(value == null ? "" : value).trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi, s);
  return Number.isFinite(utc) ? utc - tzOffsetMin * 60000 : null;
}

// 按顶层逗号切分（括号内的逗号不切："gpu:2(S:0,1),mps:100"）。
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

// GRES 串中的 GPU 项："gpu:4090:4" / "gpu:4" / "gres/gpu:a100:2" / "gres:gpu:1" / "gpu:4090:0(IDX:N/A)"。
// 返回 { count, model, seen }：seen=出现过 gpu 项（即使数量解析不了）。
function parseGresGpu(text) {
  const raw = String(text == null ? "" : text).trim();
  const result = { count: 0, model: null, seen: false, parsed: false };
  if (!raw || raw === "(null)" || raw.toUpperCase() === "N/A") return result;
  const models = [];
  for (const item of splitTopLevel(raw)) {
    const body = item.replace(/\(.*$/, "").replace(/^gres[/:]/i, "");
    const parts = body.split(":");
    if (parts[0].toLowerCase() !== "gpu") continue;
    result.seen = true;
    const last = parts.length >= 2 ? parts[parts.length - 1] : "";
    if (!/^\d+$/.test(last)) continue;
    result.count += Number(last);
    result.parsed = true;
    if (parts.length >= 3 && parts[1]) models.push(clip(parts[1], SHORT_MAX));
  }
  const unique = [...new Set(models)];
  result.model = unique.length ? unique.join("/") : null;
  return result;
}

function parseNodeGpus(gres, gresUsed) {
  const total = parseGresGpu(gres);
  if (!total.parsed || total.count <= 0) return null;
  const used = parseGresGpu(gresUsed);
  return { total: total.count, used: used.parsed ? used.count : null, model: total.model };
}

// "mixed+drain" / "down*" / "idle~" / "drained" → { state, flags }。
export function parseNodeState(raw) {
  const text = clip(raw, SHORT_MAX).toLowerCase();
  const flags = [];
  const parts = text.split("+").filter(Boolean);
  let state = "unknown";
  parts.forEach((part, index) => {
    const match = /^([a-z_]*)([*~#%!$@^-]*)$/.exec(part);
    if (!match) return;
    const [, word, suffix] = match;
    for (const ch of suffix) {
      const flag = STATE_SUFFIX_FLAGS[ch];
      if (flag && !flags.includes(flag)) flags.push(flag);
    }
    if (!word) return;
    if (index === 0) state = word;
    else if (!flags.includes(word)) flags.push(word);
  });
  return { state, flags };
}

function parseCpus(value) {
  const match = /^(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(String(value == null ? "" : value).trim());
  if (!match) return { alloc: null, idle: null, other: null, total: null };
  const [, alloc, idle, other, total] = match.map(Number);
  return { alloc, idle, other, total };
}

function splitFields(line, count) {
  const parts = line.split("|");
  if (parts.length < count) return null;
  // 行尾自由文本（Reason / Name）可能含 |：把多出的部分拼回最后一列。
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join("|")];
}

function parseNodeLine(line) {
  const f = splitFields(line, NODE_FIELDS);
  if (!f) return null;
  const name = clip(f[0], SHORT_MAX);
  if (!name) return null;
  const { state, flags } = parseNodeState(f[1]);
  const partitionRaw = clip(f[9], SHORT_MAX);
  return {
    name,
    state,
    stateRaw: clip(f[1], SHORT_MAX),
    flags,
    partitionRaw,
    cpus: parseCpus(f[2]),
    load: toFloat(f[3]),
    memFreeMb: toInt(f[4]),
    memTotalMb: toInt(f[5]),
    memAllocMb: toInt(f[6]),
    gpus: parseNodeGpus(f[7], f[8]),
    reason: nullIfPlaceholder(f[10], ["none", "(null)", "n/a"], REASON_MAX),
  };
}

// 作业 GPU 数：优先 tres-alloc 的 gres/gpu=N（有无型号项并存时取无型号总数，避免重复相加）；
// 否则 tres-per-node 的 gpu 数 × 节点数；都没提到 gpu → 0；提到了但解析不了 → null。
export function parseJobGpus(tresAlloc, tresPerNode, nodes) {
  const alloc = String(tresAlloc == null ? "" : tresAlloc).trim();
  let seen = false;
  if (alloc && alloc.toUpperCase() !== "N/A") {
    let plain = null;
    let typed = 0;
    let typedSeen = false;
    for (const item of alloc.split(",")) {
      const match = /^gres\/gpu(?::([^=]+))?=(\d+)$/i.exec(item.trim());
      if (!match) {
        if (/gpu/i.test(item)) seen = true;
        continue;
      }
      if (match[1] === undefined) plain = Number(match[2]);
      else {
        typed += Number(match[2]);
        typedSeen = true;
      }
    }
    if (plain != null) return plain;
    if (typedSeen) return typed;
  }
  const perNode = parseGresGpu(tresPerNode);
  if (perNode.parsed) return perNode.count * (Number.isInteger(nodes) && nodes > 0 ? nodes : 1);
  if (perNode.seen || seen) return null;
  return 0;
}

function parseJobLine(line, { tzOffsetMin, remoteNow }) {
  const f = splitFields(line, JOB_FIELDS);
  if (!f) return null;
  const id = clip(f[0], SHORT_MAX);
  if (!id) return null;
  const stateText = clip(f[3], SHORT_MAX).toUpperCase();
  const state = /^[A-Z_]+$/.test(stateText) ? stateText : "UNKNOWN";
  const nodes = toInt(f[6]);
  const submitAt = parseSlurmTimestamp(f[11], tzOffsetMin);
  const waitSec = state !== "RUNNING" && remoteNow != null && submitAt != null
    ? Math.max(0, Math.round((remoteNow - submitAt) / 1000))
    : null;
  const memory = nullIfPlaceholder(f[10], ["0", "n/a"], SHORT_MAX);
  return {
    id,
    user: clip(f[1], SHORT_MAX),
    partition: clip(f[2], SHORT_MAX),
    state,
    elapsedSec: parseSlurmDuration(f[4]),
    timeLimitSec: parseSlurmDuration(f[5]),
    nodes,
    cpus: toInt(f[7]),
    gpus: parseJobGpus(f[8], f[9], nodes),
    memory,
    submitAt,
    startAt: parseSlurmTimestamp(f[12], tzOffsetMin),
    waitSec,
    reason: nullIfPlaceholder(f[13], ["none", "(null)", "n/a"], REASON_MAX),
    nodeList: nullIfPlaceholder(f[14], ["(null)", "n/a"], REASON_MAX),
    name: clip(f[15], NAME_MAX),
  };
}

// 节点统一形状（Slurm 分区节点与直连节点共用），overrides 覆盖对应字段。
function baseNode(name, overrides) {
  return {
    name,
    source: "slurm",
    reachable: true,
    failure: null,
    state: "unknown",
    stateRaw: null,
    flags: [],
    partitions: [],
    cpus: { alloc: null, idle: null, other: null, total: null },
    load: null,
    memTotalMb: null,
    memFreeMb: null,
    memAllocMb: null,
    busyPct: null,
    gpus: null,
    uptimeSec: null,
    reason: null,
    ...overrides,
  };
}

// ---- 直连节点 ----

const HOP_STATUSES = new Set(["ok", "timeout", "unreachable"]);
const NODE_NAME_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

// /proc/stat 首行 "cpu  u n s idle iowait irq softirq steal guest guest_nice" → 前 8 项计数。
function parseProcStatCpu(text) {
  const parts = String(text == null ? "" : text).trim().split(/\s+/);
  if (parts[0] !== "cpu" || parts.length < 9) return null;
  const nums = parts.slice(1, 9).map((v) => (/^\d+$/.test(v) ? Number(v) : null));
  return nums.every((n) => n != null) ? nums : null;
}

// 两帧差分：(Δtotal − Δidle − Δiowait) / Δtotal × 100，一位小数；Δtotal ≤ 0 → null。
export function cpuBusyFromFrames(first, second) {
  const a = parseProcStatCpu(first);
  const b = parseProcStatCpu(second);
  if (!a || !b) return null;
  const total = b.reduce((sum, v) => sum + v, 0) - a.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;
  const idle = (b[3] - a[3]) + (b[4] - a[4]);
  const busy = Math.max(0, Math.min(100, ((total - idle) / total) * 100));
  return Math.round(busy * 10) / 10;
}

function shortGpuModel(name) {
  return String(name || "").replace(/^NVIDIA\s+/i, "").replace(/^(GeForce|Tesla)\s+/i, "").trim();
}

// 直连节点的 GPU：gpu= / gpuproc= 行与主采集的 gpu 段同一格式（解析在 gpu-cards.mjs）。
// 占用者按属主合并显存（nvidia-cuda-mps 守护进程不算）；selfUser（同段的 user）自己的进程另按作业合并。
function buildDirectGpus(cards, apps, selfUser) {
  if (!cards.length) return null;
  attachGpuUsers(cards, apps, { selfUser });
  const used = cards.filter((c) => (c.util != null && c.util >= 5)
    || (c.memUsedMb != null && c.memTotalMb > 0 && c.memUsedMb / c.memTotalMb >= 0.1)).length;
  const models = [...new Set(cards.map((c) => shortGpuModel(c.name)))];
  return {
    total: cards.length,
    used,
    model: models.length === 1 ? models[0] : "",
    cards: cards.map(({ uuid, ...card }) => card),
  };
}

function directNode(name, status, stateRaw, kvLines, selfUser) {
  const reachable = status === "ok";
  const node = baseNode(name, {
    source: "direct",
    reachable,
    failure: reachable ? null : status,
    state: reachable ? "direct" : "unreachable",
    stateRaw,
  });
  if (!reachable) return node;
  const kv = {};
  const cards = [];
  const apps = [];
  for (const line of kvLines.slice(0, HOP_MAX_KV_LINES)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (key === "gpu") {
      if (cards.length >= HOP_MAX_GPUS) continue;
      const card = parseGpuCardLine(value);
      if (card && !cards.some((c) => c.index === card.index)) cards.push(card);
    } else if (key === "gpuapp") {
      // v2.75 及更早的直连节点脚本：没有逐进程明细，照旧能读
      const app = parseGpuAppLine(value);
      if (app) apps.push(app);
    } else if (key === "gpuproc") {
      const proc = parseGpuProcLine(value);
      if (proc) apps.push(proc);
    } else if (!(key in kv)) {
      kv[key] = value;
    }
  }
  node.cpus.total = toInt(kv.nproc);
  node.busyPct = cpuBusyFromFrames(kv.cpu1, kv.cpu2);
  node.load = toFloat(String(kv.load || "").trim().split(/\s+/)[0]);
  node.uptimeSec = toInt(kv.uptime);
  const memTotalKb = toInt(kv.mem_total_kb);
  const memAvailKb = toInt(kv.mem_avail_kb);
  node.memTotalMb = memTotalKb == null ? null : Math.round(memTotalKb / 1024);
  node.memFreeMb = memAvailKb == null ? null : Math.round(memAvailKb / 1024);
  if (kv.user) node.sshUser = clip(kv.user, SHORT_MAX) || null;
  node.gpus = buildDirectGpus(cards.sort((a, b) => a.index - b.index), apps, node.sshUser || selfUser);
  return node;
}

// 已保存连接自己的 slow 采集可替代登录节点上失败的 SSH 跳采。
// 沿用直连节点的指标与 GPU 口径；缺失数据保持 null，不保留失败跳采的旧值。
export function directNodeFromResource(node, resource, { connectionId, sshUser } = {}) {
  const out = directNode(node.name, "ok", node.stateRaw, [], sshUser);
  const usage = resource.usage;
  out.connectionId = connectionId;
  out.sshUser = sshUser || null;
  out.lastSeenAt = resource.checkedAt;
  out.cpus.total = usage?.cpu?.logicalCores ?? null;
  out.load = usage?.cpu?.load1 ?? null;
  out.busyPct = usage?.cpu?.busyPct ?? null;
  const total = usage?.memory?.totalBytes;
  out.memTotalMb = Number.isFinite(total) ? Math.round(total / 1024 ** 2) : null;
  const memLine = String(resource.output || "").split("\n").find((line) => /^Mem:\s/.test(line));
  const available = humanSizeToBytes(memLine?.trim().split(/\s+/)[6]);
  out.memFreeMb = available == null ? null : Math.round(available / 1024 ** 2);
  out.gpus = buildDirectGpus(structuredClone(resource.gpu || []), [], sshUser);
  return out;
}

function parseDirectNodes(hopLines, hopKvLines, slurmNames, selfUser) {
  const order = [];
  const meta = new Map();
  for (const line of hopLines) {
    const [rawName, rawStatus, rawState] = line.split("|");
    const name = String(rawName || "").trim();
    if (!NODE_NAME_RE.test(name) || slurmNames.has(name) || meta.has(name)) continue;
    if (order.length >= SLURM_MAX_DIRECT_NODES) break;
    const status = String(rawStatus || "").trim();
    const stateText = clip(rawState, SHORT_MAX);
    meta.set(name, {
      status: HOP_STATUSES.has(status) ? status : "unreachable",
      stateRaw: /^[A-Za-z0-9_+*~-]+$/.test(stateText) ? stateText : null,
      kv: [],
    });
    order.push(name);
  }
  for (const line of hopKvLines) {
    const bar = line.indexOf("|");
    if (bar <= 0) continue;
    const entry = meta.get(line.slice(0, bar));
    if (entry && entry.kv.length < HOP_MAX_KV_LINES) entry.kv.push(line.slice(bar + 1));
  }
  return order.map((name) => {
    const entry = meta.get(name);
    return directNode(name, entry.status, entry.stateRaw, entry.kv, selfUser);
  });
}

// 作业状态 → counts 的桶名。
function jobBucket(state) {
  if (state === "RUNNING") return "running";
  if (state === "PENDING") return "pending";
  return "other";
}

function countJobs(jobs) {
  const counts = { running: 0, pending: 0, other: 0 };
  for (const job of jobs) counts[jobBucket(job.state)] += 1;
  return counts;
}

function emptySnapshot(checkedAt) {
  return {
    schemaVersion: SLURM_SCHEMA_VERSION,
    state: "absent",
    reason: null,
    version: null,
    user: null,
    checkedAt,
    remoteNow: null,
    defaultPartition: null,
    nodes: [],
    jobs: [],
    jobsTotal: 0,
    jobsTruncated: false,
    counts: { running: 0, pending: 0, other: 0 },
  };
}

export function parseSlurmSection(text, { checkedAt = Date.now() } = {}) {
  const out = emptySnapshot(checkedAt);
  const source = String(text == null ? "" : text);
  if (!source.trim()) return out;

  let stateLine = null;
  let errorCode = null;
  let tzOffsetMin = null;
  let jobsTotal = null;
  let stateCounts = null;
  const nodeLines = [];
  const jobLines = [];
  const hopLines = [];
  const hopKvLines = [];

  for (const rawLine of source.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case "state": {
        const v = value.trim();
        if (v === "ok" || v === "absent" || v === "error") stateLine = v;
        break;
      }
      case "version": {
        const v = value.trim();
        out.version = /^[0-9A-Za-z._-]{1,32}$/.test(v) ? v : null;
        break;
      }
      case "now": {
        const n = toInt(value);
        out.remoteNow = n == null ? null : n * 1000;
        break;
      }
      case "tz":
        tzOffsetMin = parseTzOffset(value);
        break;
      case "user": {
        const v = value.trim();
        out.user = /^[A-Za-z0-9._-]{1,64}$/.test(v) ? v : null;
        break;
      }
      case "error":
        errorCode = clip(value, REASON_MAX) || null;
        break;
      case "jobs_total":
        jobsTotal = toInt(value);
        break;
      case "count": {
        const match = /^([A-Z_]+)=(\d+)$/.exec(value.trim());
        if (!match) break;
        stateCounts = stateCounts || { running: 0, pending: 0, other: 0 };
        stateCounts[jobBucket(match[1])] += Number(match[2]);
        break;
      }
      case "node":
        nodeLines.push(value);
        break;
      case "job":
        jobLines.push(value);
        break;
      case "hop":
        if (hopLines.length < SLURM_MAX_DIRECT_NODES * 4) hopLines.push(value);
        break;
      case "hopkv":
        if (hopKvLines.length < SLURM_MAX_DIRECT_NODES * HOP_MAX_KV_LINES) hopKvLines.push(value);
        break;
      default:
        break;
    }
  }

  if (stateLine === "absent") return { ...emptySnapshot(checkedAt), version: out.version, user: out.user, remoteNow: out.remoteNow };

  // 按节点名合并（节点属于多个分区时 sinfo -N 每个分区各出一行）。
  const nodesByName = new Map();
  for (const line of nodeLines) {
    const node = parseNodeLine(line);
    if (!node) continue;
    const partition = node.partitionRaw.replace(/\*$/, "");
    if (node.partitionRaw.endsWith("*") && partition && !out.defaultPartition) out.defaultPartition = partition;
    const existing = nodesByName.get(node.name);
    if (existing) {
      if (partition && !existing.partitions.includes(partition)) existing.partitions.push(partition);
      continue;
    }
    if (nodesByName.size >= SLURM_MAX_NODES) continue;
    const { partitionRaw, ...fields } = node;
    nodesByName.set(node.name, baseNode(node.name, { ...fields, partitions: partition ? [partition] : [] }));
  }
  const directNodes = parseDirectNodes(hopLines, hopKvLines, new Set(nodesByName.keys()), out.user);
  out.nodes = [...nodesByName.values(), ...directNodes]
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

  const jobs = [];
  for (const line of jobLines) {
    if (jobs.length >= SLURM_MAX_JOBS) break;
    const job = parseJobLine(line, { tzOffsetMin, remoteNow: out.remoteNow });
    if (job) jobs.push(job);
  }
  out.jobs = jobs;
  out.jobsTotal = Math.max(jobsTotal ?? jobs.length, jobs.length);
  out.jobsTruncated = out.jobsTotal > jobs.length;
  out.counts = stateCounts || countJobs(jobs);

  const hasData = out.nodes.length > 0 || jobs.length > 0 || jobsTotal != null;
  if (stateLine === "error" || errorCode) {
    out.state = "error";
    out.reason = errorCode ? (ERROR_REASONS[errorCode] || errorCode) : "Slurm 查询失败";
  } else if (stateLine === "ok" || hasData) {
    out.state = "ok";
  }
  return out;
}
