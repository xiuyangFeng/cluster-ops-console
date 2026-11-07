// 本人目录占用扫描：本机侧的调用组装与输出解析。
//
// 远端脚本 remote/dir-usage.py 经 stdin 送达（与 collect.sh / usage-scan.py 同一零残留原则）：
//   ssh host "<固定 python3 引导命令>"，stdin 第 1 行 = 脚本源码的 JSON 字符串，其余 = 参数 JSON。
// 远端命令串是常量，不含任何插值；扫描根、游标、预算全部走 stdin。
// 远端输出一律当不可信数据：只认一行 end / err 记录，字段白名单、字符串截断、数值钳位、条目数封顶。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProbeSshArgs } from "../ssh-args.mjs";

export const DIR_USAGE_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "remote", "dir-usage.py");

export const DIR_USAGE_REMOTE_COMMAND = `python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),"dir-usage","exec"))'`;

// 每轮预算（远端同样钳到这两个上限）：≤ 2 万条目、≤ 8 秒。本机整轮超时留出 SSH 握手余量。
export const DIR_USAGE_MAX_ENTRIES = 20000;
export const DIR_USAGE_MAX_SEC = 8;
export const DIR_USAGE_TIMEOUT_MS = 25000;
export const DIR_USAGE_MAX_OUT_BYTES = 3 * 1024 * 1024;

// 与远端脚本同一组上限（远端多给的一律丢弃）。
export const AGG1_CAP = 2000;
export const AGG2_CAP = 4000;
export const TOP_N = 30;
export const PENDING_CAP = 5000;
export const PENDING_BYTES_CAP = 1024 * 1024;
const OTHER_FS_CAP = 20;
const MAX_REL = 4096;
const MAX_NAME = 1024;
const MAX_NUMBER = 2 ** 53 - 1;

// 相对路径（相对 $HOME 或扫描根）：'' = 根本身；否则逐段非空、不是 . / ..、不含 NUL，不以 / 开头或结尾。
// 远端还会用 realpath 再核一遍（拒绝路径上的符号链接、拒绝越出 $HOME）。
export function isValidRelPath(rel, maxLength = MAX_REL) {
  if (typeof rel !== "string" || rel.length > maxLength || rel.includes("\0")) return false;
  if (rel === "") return true;
  if (rel.startsWith("/") || rel.endsWith("/")) return false;
  return rel.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

let scriptCache = null;
export function loadDirUsageScript() {
  if (scriptCache === null) scriptCache = readFileSync(DIR_USAGE_SCRIPT_PATH, "utf8");
  return scriptCache;
}

// pending = null → 从扫描根开始；否则是上一轮交回的游标（[[相对扫描根的目录, 已处理条目数], ...]）。
export function buildDirUsageInvocation({ server = {}, parsed = {}, knownHostsPath, root = "", pending = null, platform = process.platform } = {}) {
  const payload = { root, maxEntries: DIR_USAGE_MAX_ENTRIES, maxSec: DIR_USAGE_MAX_SEC };
  if (Array.isArray(pending)) payload.pending = pending;
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), DIR_USAGE_REMOTE_COMMAND],
    input: `${JSON.stringify(loadDirUsageScript())}\n${JSON.stringify(payload)}`,
    timeoutMs: DIR_USAGE_TIMEOUT_MS,
    maxOutputBytes: DIR_USAGE_MAX_OUT_BYTES,
  };
}

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_NUMBER) : 0);

// [实际占用, 逻辑大小, 文件数, 子目录数]（rootFiles 只有前三项）；畸形 → null。
function quad(value, len = 4) {
  if (!Array.isArray(value) || value.length !== len) return null;
  if (!value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  return value.map(count);
}

function parseAgg(raw, { cap, depth }) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= cap) break;
    if (key.length > MAX_NAME * depth || !isValidRelPath(key) || key.split("/").length !== depth) continue;
    const v = quad(value);
    if (!v) continue;
    out[key] = v;
    n += 1;
  }
  return out;
}

function parseTop(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, TOP_N)) {
    if (!Array.isArray(item) || item.length !== 4 || !isValidRelPath(item[1]) || item[1] === "") continue;
    const mtime = typeof item[3] === "number" && Number.isFinite(item[3]) && item[3] > 0 && item[3] < 4e9 ? Math.floor(item[3]) : null;
    out.push({ path: item[1], blocks: count(item[0]), size: count(item[2]), mtime });
  }
  return out;
}

function parsePending(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  let bytes = 0;
  for (const item of raw) {
    if (out.length >= PENDING_CAP) return null;
    if (!Array.isArray(item) || item.length !== 2 || !isValidRelPath(item[0]) || !Number.isSafeInteger(item[1]) || item[1] < 0) return null;
    bytes += item[0].length;
    if (bytes > PENDING_BYTES_CAP) return null;
    out.push([item[0], item[1]]);
  }
  return out;
}

// 远端拒绝扫描的原因码 → 界面文案。
export const DIR_USAGE_ERROR_TEXT = Object.freeze({
  "bad-args": "扫描参数无效",
  "bad-root": "扫描路径无效",
  "outside-home": "路径不在 $HOME 内或包含符号链接，未扫描",
  "not-found": "目录不存在或无权访问",
  "not-dir": "不是目录",
  "other-fs": "该目录在另一个文件系统上，未扫描",
});

// 解析远端输出。返回 { ok: true, run } | { ok: false, code }；expectRoot 必须与本轮请求的扫描根一致，
// 游标（pending）畸形时整轮作废——续扫游标宁可丢，也不能把错位的游标存下来。
export function parseDirUsageOutput(stdout, { expectRoot = "" } = {}) {
  const lines = String(stdout ?? "").split("\n").filter((line) => line.trim());
  const line = lines[lines.length - 1];
  if (!line || line.length > DIR_USAGE_MAX_OUT_BYTES) return { ok: false, code: "no-output" };
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, code: "bad-output" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, code: "bad-output" };
  if (raw.k === "err") {
    return { ok: false, code: Object.hasOwn(DIR_USAGE_ERROR_TEXT, raw.code) ? raw.code : "remote-error" };
  }
  if (raw.k !== "end" || raw.v !== 1 || raw.root !== expectRoot) return { ok: false, code: "bad-output" };
  const home = typeof raw.home === "string" && raw.home.startsWith("/") && raw.home.length <= 1024 && !raw.home.includes("\0") ? raw.home : null;
  const pending = parsePending(raw.pending);
  if (!home || !pending) return { ok: false, code: "bad-output" };
  const rootFiles = quad(raw.rootFiles, 3) || [0, 0, 0];
  return {
    ok: true,
    run: {
      home,
      root: expectRoot,
      complete: raw.complete === true && pending.length === 0,
      stop: ["done", "entries", "time"].includes(raw.stop) ? raw.stop : "done",
      entries: count(raw.entries),
      dirsDone: count(raw.dirsDone),
      denied: count(raw.denied),
      errors: count(raw.errors),
      otherFs: count(raw.otherFs),
      otherFsNames: Array.isArray(raw.otherFsNames)
        ? raw.otherFsNames.filter((n) => isValidRelPath(n) && n !== "").slice(0, OTHER_FS_CAP).map((n) => n.slice(0, 512))
        : [],
      dropped: count(raw.dropped),
      hardlinks: count(raw.hardlinks),
      sec: typeof raw.sec === "number" && Number.isFinite(raw.sec) && raw.sec >= 0 ? Math.min(raw.sec, 3600) : null,
      agg1: parseAgg(raw.agg1, { cap: AGG1_CAP, depth: 1 }),
      agg1Over: quad(raw.agg1Over) || [0, 0, 0, 0],
      agg2: parseAgg(raw.agg2, { cap: AGG2_CAP, depth: 2 }),
      rootFiles,
      top: parseTop(raw.top),
      pending,
    },
  };
}
