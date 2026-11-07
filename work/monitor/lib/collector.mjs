// 零残留远端采集：本机侧的调用组装与解析（v2.18）。
// 设计：docs/superpowers/specs/2026-09-02-multi-tunnel-team-hub-design.md §6.4
//
// 远端脚本 remote/collect.sh 经 stdin 送达（`ssh host "env CT_...=... sh -s"`），
// 远端不落任何文件；参数全部走环境变量并在远端二次校验，本机这一侧是第一道校验。
//
// 安全边界（与 §8 一致）：
//   - 远端命令串只由固定模板 + 白名单校验过的值构成，值一律单引号包裹；
//     校验白名单本身不含单引号，所以包裹后不可能被闭合逃逸。
//   - 段内原文一律当"不可信数据"：解析器只认整行精确等于 marker 的行，
//     日志里出现的 marker 字样不会切段。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachGpuUsers, parseGpuAppLine, parseGpuCardLine, parseGpuProcLine } from "./gpu-cards.mjs";
import { assertSafePort, buildProbeSshArgs } from "./ssh-args.mjs";
import { toPort } from "./validators.mjs";

export const COLLECTOR_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "remote",
  "collect.sh",
);

// 段名固定：与 collect.sh 的 ct_emit 调用逐字一致。
// v2.20（T03）：slow 新增 cpu-stat（/proc/stat 聚合计数 + boot_id）与 filesystem
// （$HOME 挂载点字节/inode 用量）。缺段向后兼容：旧脚本输出按段缺失处理，
// 消费方（probes/resource-usage）一律 null → "未知"，不重解释旧数据。
// v2.32：slow 末尾新增 slurm（Slurm 节点与队列只读快照，解析在 lib/slurm.mjs）。
// 放最后是因为它体量最大，不能挤占其它段的总上限；旧脚本缺该段 → slurm: null。
// v2.62：slow 在 slurm 之前新增 proc-top（占用现场：按账号汇总的 CPU 与常驻内存，分作业内 / 作业外）。
// 之后在 proc-top 与 slurm 之间新增 tunnel-egress（经隧道出网的程序，解析在 lib/tunnel-egress.mjs）。
export const COLLECTOR_SECTION_NAMES = [
  "sys",
  "cpu-stat",
  "filesystem",
  "gpu",
  "ports",
  "agents",
  "proc-top",
  "tunnel-egress",
  "slurm",
  "reclaude-state",
  "reclaude-logs",
];

// fast 每 10s 一轮、slow 每 60s 一轮；超时留足一次 SSH 握手 + 远端采集。
export const COLLECTOR_TIMEOUT_MS = { fast: 15000, slow: 20000 };

const SECTION_NAME_SET = new Set(COLLECTOR_SECTION_NAMES);
const BEGIN_RE = /^__CT_BEGIN ([a-z-]+)__$/;
const END_RE = /^__CT_END ([a-z-]+)__$/;

let scriptCache = null;

// 脚本文本带进程内缓存：每 10s 一轮探测不该反复读盘。
export function loadCollectorScript() {
  if (scriptCache === null) {
    scriptCache = readFileSync(COLLECTOR_SCRIPT_PATH, "utf8");
  }
  return scriptCache;
}

function assertProfile(profile) {
  if (profile !== "fast" && profile !== "slow") {
    throw new Error(`unsafe collector profile: ${JSON.stringify(profile)}，只允许 "fast" | "slow"`);
  }
  return profile;
}

export function buildCollectorInvocation({
  server = {},
  parsed = {},
  profile,
  ports = [],
  platform = process.platform,
  knownHostsPath,
} = {}) {
  assertProfile(profile);

  // 端口进的是远端 shell 串，走与 buildRemotePortProbeCommand 同一道硬校验（非法即 throw）。
  const safePorts = (Array.isArray(ports) ? ports : [])
    .map((port) => assertSafePort(port, "collector port"));

  const envParts = [`CT_PROFILE='${profile}'`];
  if (safePorts.length) envParts.push(`CT_PORTS='${safePorts.join(",")}'`);

  const remoteCommand = `env ${envParts.join(" ")} sh -s`;
  const args = [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), remoteCommand];

  return {
    file: "ssh",
    args,
    input: loadCollectorScript(),
    timeoutMs: COLLECTOR_TIMEOUT_MS[profile],
  };
}

export function parseCollectorOutput(stdout) {
  const lines = String(stdout == null ? "" : stdout).split("\n");
  const sections = {};
  let current = null;
  let buffer = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (current === null) {
      const begin = BEGIN_RE.exec(line);
      // 只认已知段名，且同名段"先到先得"：段外出现的伪 marker 顶多多切一个空段，
      // 无法覆盖已经收下的真实段内容。
      if (begin && SECTION_NAME_SET.has(begin[1]) && !(begin[1] in sections)) {
        current = begin[1];
        buffer = [];
      }
      continue;
    }
    const end = END_RE.exec(line);
    // 只有"整行精确等于本段的 END marker"才收段：日志正文里出现 __CT_BEGIN sys__
    // 或别的段的 END 字样，都只当普通内容。
    if (end && end[1] === current) {
      sections[current] = buffer.join("\n").trim();
      current = null;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  // 输出被截断（远端 head -c 触顶或 SSH 中途断开）时保留已收到的半段内容。
  if (current !== null) sections[current] = buffer.join("\n").trim();

  return { sections };
}

// ---- T03：cpu-stat / filesystem 段解析 ----

// cpu-stat 段：`cpu=<user> <nice> <system> <idle> <iowait> <irq> <softirq> <steal>
// <guest> <guest_nice>` 与 `boot_id=<hex>`。cpu=unknown（非 Linux / /proc 不可读）
// 或任何非数字值 → 对应字段 null；boot_id 非法 → null（本机差分据此判 reset）。
// guest/guest_nice 原样带回：差分公式不重复相加它们，但保留原始计数可追溯。
export function parseCpuStat(text) {
  const out = {
    user: null, nice: null, system: null, idle: null, iowait: null,
    irq: null, softirq: null, steal: null, guest: null, guestNice: null,
    bootId: null,
  };
  let cpuSeen = false;
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "cpu") {
      cpuSeen = true;
      if (value === "" || value === "unknown") continue;
      const fields = value.split(/\s+/).map((v) => (/^\d+$/.test(v) ? Number(v) : null));
      const names = ["user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal", "guest", "guestNice"];
      names.forEach((name, i) => {
        out[name] = fields[i] ?? null;
      });
      continue;
    }
    if (key === "boot_id" && /^[0-9a-f-]{8,64}$/.test(value)) {
      out.bootId = value;
    }
  }
  // 整行缺失（旧脚本没有该段不该走到这里——段存在但内容为空时 cpuSeen=false）。
  out.present = cpuSeen;
  return out;
}

// filesystem 段：key=value 行。数值只认非负整数（KB 口径）；mount 原样保留
//（df -P 会把挂载点内空格转义成 \040，展示端原样呈现，不做猜测性反转义）。
export function parseFilesystem(text) {
  const out = {
    state: null, device: null, mount: null,
    totalKb: null, usedKb: null, availKb: null, capacityPct: null,
    inodesTotal: null, inodesUsed: null, inodePct: null,
  };
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "state":
        out.state = value === "ok" || value === "unavailable" ? value : null;
        break;
      case "device":
      case "mount":
        out[key] = value === "" ? null : value.slice(0, 512);
        break;
      case "total_kb":
      case "used_kb":
      case "avail_kb":
      case "capacity_pct":
      case "inodes_total":
      case "inodes_used":
      case "inode_pct": {
        const camel = {
          total_kb: "totalKb", used_kb: "usedKb", avail_kb: "availKb", capacity_pct: "capacityPct",
          inodes_total: "inodesTotal", inodes_used: "inodesUsed", inode_pct: "inodePct",
        }[key];
        out[camel] = /^\d+$/.test(value) ? Number(value) : null;
        break;
      }
      default:
        break;
    }
  }
  out.present = out.state != null;
  return out;
}

// gpu 段：每张卡一行 `gpu=…`、每个计算进程一行 `gpuproc=…`（格式见 gpu-cards.mjs）。
// 返回 [{ index, name, memUsedMb, memTotalMb, util, tempC, powerW, users: [{ user, memMb, procs? }] }]。
// 不带前缀的行是旧格式 `0, NVIDIA GeForce RTX 4090, 8 MiB, 24564 MiB, 0 %`（只有前五项），照旧能读。
// selfUser（采集账号，agents 段的 user）给了的话，它在每张卡上的那一项另带 jobs: [{ id, memMb }]
// ——按 Slurm 作业合并的显存（v2.62，见 gpu-cards.attachGpuUsers）；别人的仍只到属主。
// v2.76：每张卡上的属主那一项另带 procs（逐进程的 pid / 已运行秒数 / 命令行）。`gpuapp=` 是 v2.75
// 及更早脚本的行，照旧能读，只是没有 procs。
const GPU_MAX_CARDS = 16;
const GPU_MAX_APPS = 64;

function parseLegacyGpuLine(line) {
  const parts = line.split(",");
  if (parts.length < 5) return null;
  const index = Number.parseInt(parts[0].trim(), 10);
  const name = parts[1].trim();
  const memUsedMb = Number.parseInt(parts[2].trim(), 10);
  const memTotalMb = Number.parseInt(parts[3].trim(), 10);
  const util = Number.parseInt(parts[4].trim(), 10);
  if (!Number.isInteger(index) || !name) return null;
  if (!Number.isInteger(memUsedMb) || !Number.isInteger(memTotalMb) || !Number.isInteger(util)) return null;
  return { index, name, memUsedMb, memTotalMb, util };
}

export function parseGpu(text, { selfUser = null } = {}) {
  const cards = [];
  const apps = [];
  const legacy = [];
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("gpu=")) {
      const card = parseGpuCardLine(line.slice(4));
      // 显存两项是这张卡最基本的读数，缺了就不算有效的一行
      if (!card || card.memUsedMb == null || card.memTotalMb == null) continue;
      if (cards.length < GPU_MAX_CARDS && !cards.some((c) => c.index === card.index)) cards.push(card);
    } else if (line.startsWith("gpuapp=")) {
      const app = parseGpuAppLine(line.slice(7));
      if (app && apps.length < GPU_MAX_APPS) apps.push(app);
    } else if (line.startsWith("gpuproc=")) {
      const proc = parseGpuProcLine(line.slice(8));
      if (proc && apps.length < GPU_MAX_APPS) apps.push(proc);
    } else {
      const card = parseLegacyGpuLine(line);
      if (card) legacy.push(card);
    }
  }
  if (!cards.length) return legacy;
  attachGpuUsers(cards, apps, { selfUser });
  return cards
    .sort((a, b) => a.index - b.index)
    .map((card) => ({
      index: card.index,
      name: card.name,
      memUsedMb: Math.round(card.memUsedMb),
      memTotalMb: Math.round(card.memTotalMb),
      util: card.util == null ? null : Math.round(card.util),
      tempC: card.tempC,
      powerW: card.powerW,
      users: card.users,
    }));
}

// proc-top 段（v2.62，remote/collect.sh ct_proc_top）：这台机器的占用现场——取 %CPU 与常驻内存最高的
// 几十个进程按账号汇总，再按 cgroup 分成「在 Slurm 作业里」与「不经 Slurm」两部分。
//   sampled=<参与汇总的进程数>   slurm=1|0
//   top=<账号>|<作业内 %CPU>|<作业外 %CPU>|<作业内常驻内存 KB>|<作业外常驻内存 KB>|<作业内进程数>|<作业外进程数>
// 返回 { sampled, slurm, users: [{ user, cpuJobPct, cpuOtherPct, rssJobKb, rssOtherKb, procsJob, procsOther }] }；
// 空段（ps 不可用 / 超时）或没有一行有效的 top= → null。
// slurm：这台机器分不分得出作业内外（远端看到了 Slurm 的 cgroup 层级，或这一轮确有进程在作业里）。
// 为假时数字都在「作业外」几栏，消费方不能据此说「不经 Slurm」。
// %CPU 是 ps 的口径：进程启动以来的平均值，100 = 一个核；汇总只覆盖取到的这些进程。
// 只有账号名与汇总数字，没有任何进程的命令行。top= 行尾多出来的字段忽略（以后只在末尾加）。
export const PROC_TOP_MAX_USERS = 8;
const PROC_TOP_FIELDS = 7;
const PROC_TOP_USER_RE = /^[A-Za-z0-9._-]{1,32}$/;
// 上限只为挡住损坏的数字：%CPU 1e6（一万个核）、常驻内存 1e12 KB、进程数 1e4。
const PROC_TOP_LIMITS = [1e6, 1e6, 1e12, 1e12, 1e4, 1e4];

function procTopNumber(text, max, integer) {
  const value = String(text ?? "").trim();
  if (!(integer ? /^\d{1,13}$/ : /^\d{1,7}(?:\.\d{1,3})?$/).test(value)) return null;
  const n = Number(value);
  return n <= max ? n : null;
}

export function parseProcTop(text) {
  let sampled = null;
  let slurm = false;
  const users = [];
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "sampled") {
      sampled = /^\d{1,4}$/.test(value) ? Number(value) : null;
    } else if (key === "slurm") {
      slurm = value === "1";
    } else if (key === "top") {
      const fields = value.split("|");
      const user = fields[0];
      if (fields.length < PROC_TOP_FIELDS || !PROC_TOP_USER_RE.test(user)) continue;
      if (users.length >= PROC_TOP_MAX_USERS || users.some((entry) => entry.user === user)) continue;
      const nums = PROC_TOP_LIMITS.map((max, i) => procTopNumber(fields[i + 1], max, i >= 2));
      if (nums.some((n) => n == null)) continue;
      const [cpuJobPct, cpuOtherPct, rssJobKb, rssOtherKb, procsJob, procsOther] = nums;
      users.push({ user, cpuJobPct, cpuOtherPct, rssJobKb, rssOtherKb, procsJob, procsOther });
    }
  }
  if (!users.length) return null;
  const seenInJob = users.some((entry) => entry.cpuJobPct > 0 || entry.rssJobKb > 0 || entry.procsJob > 0);
  return { sampled, slurm: slurm || seenInJob, users };
}

// ss -ltn / netstat -ltn 的监听行里找 `:<port>` 且后接空白或行尾，
// 避免 :789 命中 :7891。
export function parseListeningPorts(text, ports = []) {
  const source = String(text == null ? "" : text);
  const out = {};
  for (const value of Array.isArray(ports) ? ports : []) {
    const port = toPort(value);
    if (port === null) continue;
    out[port] = new RegExp(`:${port}(?=\\s|$)`, "m").test(source);
  }
  return out;
}

export function parseAgentsInstalled(text) {
  const out = {
    codex: false,
    claude: false,
    reclaude: false,
    zcode: false,
    reclaudeActive: "unknown",
    user: "",
    hostname: "",
  };
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    switch (key) {
      case "codex":
      case "claude":
      case "reclaude":
      case "zcode":
        out[key] = value === "1";
        break;
      case "reclaudeActive":
        out.reclaudeActive = value === "active" || value === "inactive" ? value : "unknown";
        break;
      case "user":
      case "hostname":
        out[key] = value;
        break;
      default:
        break;
    }
  }
  return out;
}
