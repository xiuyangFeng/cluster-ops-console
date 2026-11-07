// 失败作业取证：本机侧的调用组装与输出解析（v2.49 §2.2）。
//
// 远端脚本 remote/job-forensics.py 经 stdin 送达（与 usage-scan 同一零残留模式）：
//   ssh host "<固定 python3 引导命令>"，stdin 第 1 行 = 脚本源码的 JSON 字符串，第 2 行 = 参数 JSON。
// 远端命令串是常量，不含任何插值；作业号与登记表里的路径模板全部走 stdin。
// 远端输出一律当不可信数据：逐行 JSON、字段白名单、字符串截断、条目数封顶，坏行丢弃。
// 远端只回传原文尾部，分类在本机（diagnose.mjs）。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProbeSshArgs } from "../ssh-args.mjs";

export const FORENSICS_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "remote", "job-forensics.py");
export const FORENSICS_REMOTE_COMMAND = `python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),"job-forensics","exec"))'`;

// 每轮最多取证的作业数（远端脚本另有 32 的硬上限）。
export const FORENSICS_BATCH_MAX = 20;
export const FORENSICS_TAIL_BYTES = 16 * 1024;
export const FORENSICS_SIBLINGS_MAX = 4;
export const FORENSICS_SCRIPT_BYTES = 32 * 1024;
// 远端自限 15s / 3MB 输出；本机整轮超时留出 SSH 握手余量。
export const FORENSICS_BUDGET_SEC = 15;
export const FORENSICS_MAX_OUT_BYTES = 3 * 1024 * 1024;
export const FORENSICS_TIMEOUT_MS = 25000;

// 远端 sacct / squeue 风格的作业号：123 / 123_4（取证只针对已结束的具体作业，不收排队中的数组写法）。
export const FORENSICS_JOB_ID_RE = /^\d{1,12}(?:_\d{1,9})?$/;
const SOURCES = new Set(["registry", "scontrol", "submitline", "default", "none"]);
const ROLES = new Set(["stdout", "stderr", "sibling"]);
const FILES_MAX = 2 + FORENSICS_SIBLINGS_MAX;
const PATH_MAX = 1024;
const SHORT_MAX = 256;

let scriptCache = null;
export function loadForensicsScript() {
  if (scriptCache === null) scriptCache = readFileSync(FORENSICS_SCRIPT_PATH, "utf8");
  return scriptCache;
}

// 登记表条目 → 送给远端的路径模板（只带取证需要的字段）。
function regPayload(reg) {
  if (!reg) return null;
  const pick = (value) => (typeof value === "string" && value ? value.slice(0, 512) : null);
  return {
    workDir: pick(reg.workDir),
    stdout: pick(reg.stdout),
    stderr: pick(reg.stderr),
    command: pick(reg.command),
    name: pick(reg.name),
    user: pick(reg.user),
  };
}

// jobs：[{ id, reg }]，id 不合格的在这里就丢掉（不进远端）。
export function buildForensicsInvocation({ server = {}, parsed = {}, knownHostsPath, jobs = [], platform = process.platform } = {}) {
  const list = jobs
    .filter((job) => FORENSICS_JOB_ID_RE.test(String(job?.id || "")))
    .slice(0, FORENSICS_BATCH_MAX)
    .map((job) => ({ id: String(job.id), reg: regPayload(job.reg) }));
  const payload = {
    jobs: list,
    tailBytes: FORENSICS_TAIL_BYTES,
    siblingMax: FORENSICS_SIBLINGS_MAX,
    scriptBytes: FORENSICS_SCRIPT_BYTES,
    budgetSec: FORENSICS_BUDGET_SEC,
    maxOutBytes: FORENSICS_MAX_OUT_BYTES,
  };
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), FORENSICS_REMOTE_COMMAND],
    input: `${JSON.stringify(loadForensicsScript())}\n${JSON.stringify(payload)}\n`,
    timeoutMs: FORENSICS_TIMEOUT_MS,
    maxOutputBytes: FORENSICS_MAX_OUT_BYTES + 256 * 1024,
  };
}

const str = (value, max = SHORT_MAX) => (typeof value === "string" && value.length > 0 ? value.slice(0, max) : null);

function parseFile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const filePath = str(raw.p, PATH_MAX);
  if (!filePath?.startsWith("/") || !ROLES.has(raw.r) || typeof raw.t !== "string") return null;
  // 远端已按 16KB 读尾，这里再按字符数兜一道（多字节字符解码后字符数只会更少）。
  return { path: filePath, role: raw.r, size: Number.isSafeInteger(raw.sz) && raw.sz >= 0 ? raw.sz : null, tail: raw.t.slice(-FORENSICS_TAIL_BYTES) };
}

// 编排型作业主日志里的 END 统计：{ ended, failed, failures: [{ run, phase, code }] }；不是编排型作业为 null。
const SUBRUN_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
const SUBRUN_FAILURES_MAX = 8;

function parseSubruns(raw) {
  if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.n) || raw.n <= 0) return null;
  const failures = [];
  for (const item of Array.isArray(raw.fail) ? raw.fail : []) {
    if (failures.length >= SUBRUN_FAILURES_MAX) break;
    if (!Array.isArray(item)) continue;
    const [run, phase, code] = item;
    if (typeof run !== "string" || typeof phase !== "string" || !SUBRUN_TOKEN_RE.test(run) || !SUBRUN_TOKEN_RE.test(phase)) continue;
    if (!Number.isSafeInteger(code) || code === 0 || Math.abs(code) > 9999) continue;
    failures.push({ run, phase, code });
  }
  const failed = Number.isSafeInteger(raw.bad) && raw.bad >= 0 ? Math.min(raw.bad, raw.n) : failures.length;
  return { ended: raw.n, failed: Math.max(failed, failures.length), failures };
}

// 编排脚本状态文件里没跑完的子任务：{ arms, unfinished, items: [{ name, status, reason }] }；没有状态文件为 null。
function parseDispatch(raw) {
  if (!raw || typeof raw !== "object" || !Number.isSafeInteger(raw.n) || raw.n <= 0) return null;
  const items = [];
  for (const item of Array.isArray(raw.arms) ? raw.arms : []) {
    if (items.length >= SUBRUN_FAILURES_MAX) break;
    if (!Array.isArray(item) || typeof item[0] !== "string" || !SUBRUN_TOKEN_RE.test(item[0])) continue;
    items.push({ name: item[0], status: str(item[1], 32), reason: str(item[2], 300) });
  }
  const unfinished = Number.isSafeInteger(raw.bad) && raw.bad >= 0 ? Math.min(raw.bad, raw.n) : items.length;
  return { arms: raw.n, unfinished: Math.max(unfinished, items.length), items };
}

function parseJob(raw) {
  const id = typeof raw.id === "string" && FORENSICS_JOB_ID_RE.test(raw.id) ? raw.id : null;
  if (!id) return null;
  const files = [];
  for (const file of Array.isArray(raw.files) ? raw.files : []) {
    if (files.length >= FILES_MAX) break;
    const parsed = parseFile(file);
    if (parsed) files.push(parsed);
  }
  const script = typeof raw.sc === "string" ? raw.sc.slice(0, FORENSICS_SCRIPT_BYTES) : null;
  return {
    id,
    rawId: typeof raw.raw === "string" && /^\d{1,12}$/.test(raw.raw) ? raw.raw : null,
    name: str(raw.name),
    workDir: str(raw.wd, PATH_MAX),
    source: SOURCES.has(raw.src) ? raw.src : "none",
    tool: str(raw.tool, 32),
    live: raw.live === true,
    files,
    script,
    scriptFrom: script && (raw.scs === "scontrol" || raw.scs === "file") ? raw.scs : null,
    subruns: parseSubruns(raw.sub),
    dispatch: parseDispatch(raw.st),
  };
}

// stdout → { jobs: [...], end: { n, complete, sec } | null, badLines }。同一作业号重复出现只认第一条。
export function parseForensicsOutput(stdout) {
  const result = { jobs: [], end: null, badLines: 0 };
  const seen = new Set();
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      result.badLines += 1;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      result.badLines += 1;
      continue;
    }
    if (raw.k === "job") {
      const job = parseJob(raw);
      if (!job || seen.has(job.id) || result.jobs.length >= FORENSICS_BATCH_MAX * 2) {
        result.badLines += 1;
        continue;
      }
      seen.add(job.id);
      result.jobs.push(job);
    } else if (raw.k === "end") {
      result.end = {
        n: Number.isSafeInteger(raw.n) && raw.n >= 0 ? raw.n : 0,
        complete: raw.complete === true,
        sec: typeof raw.sec === "number" && Number.isFinite(raw.sec) ? raw.sec : null,
      };
    } else {
      result.badLines += 1;
    }
  }
  return result;
}
