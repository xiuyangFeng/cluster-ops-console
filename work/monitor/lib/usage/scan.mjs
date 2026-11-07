// Agent 用量扫描：本机侧的调用组装与输出解析。
//
// 远端脚本 remote/usage-scan.py 经 stdin 送达（与 collect.sh 同一零残留原则）：
//   ssh host "<固定 python3 引导命令>"，stdin 第 1 行 = 脚本源码的 JSON 字符串，其余 = 参数 JSON。
// 远端命令串是常量，不含任何插值；游标、时间窗、预算全部走 stdin。
// 远端输出一律当不可信数据：逐行 JSON、字段白名单、字符串截断、数值钳位，坏行丢弃。

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProbeSshArgs } from "../ssh-args.mjs";
import { sanitizeErrorText } from "./error-text.mjs";

export const USAGE_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "remote", "usage-scan.py");

// 引导命令：读 stdin 第一行（脚本源码）并执行；脚本再读剩余 stdin 作参数。
export const USAGE_REMOTE_COMMAND = `python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),"usage-scan","exec"))'`;

// 一轮扫描：远端自限 12s / 4MB 输出，本机整轮超时留出 SSH 握手余量。
// 输出预算由远端在记录边界按 UTF-8 字节执行（含游标与 end，见 usage-scan.py 的 Emitter），
// 放不下就停在某条日志之前、游标停在那里，下一轮接着读；本机接收上限只多留 512KB 余量兜底，
// 正常情况下不会触发截断——一旦触发（输出被截），游标与 end 可能缺失，按「没跑完」处理。
export const USAGE_SCAN_BUDGET_SEC = 12;
export const USAGE_SCAN_MAX_OUT_BYTES = 4 * 1024 * 1024;
export const USAGE_SCAN_TIMEOUT_MS = 30000;

export const USAGE_AGENT_IDS = ["codex", "claude", "antigravity", "gemini", "zcode", "opencode", "cursor", "custom"];
const AGENTS = new Set(USAGE_AGENT_IDS);
const MAX_NUMBER = 1e10; // 单次调用的 Token 上限（远超任何真实值，只防垃圾数据）
const LIMITS = { sid: 128, rid: 160, m: 80, cwd: 512, tid: 128, f: 1024 };

let scriptCache = null;
export function loadUsageScript() {
  if (scriptCache === null) scriptCache = readFileSync(USAGE_SCRIPT_PATH, "utf8");
  return scriptCache;
}

export function buildUsageScanInvocation({ server = {}, parsed = {}, knownHostsPath, cursors = {}, sinceSec = 0, platform = process.platform } = {}) {
  const rawDirs = [
    ...(Array.isArray(parsed?.customUsageDirs) ? parsed.customUsageDirs : []),
    ...(Array.isArray(server?.customUsageDirs) ? server.customUsageDirs : []),
  ];
  const customDirs = [...new Set(rawDirs.filter((d) => typeof d === "string" && d.trim().length > 0 && d.length <= 256).map((d) => d.trim()))].slice(0, 16);
  const payload = {
    since: Number.isFinite(sinceSec) ? sinceSec : 0,
    budgetSec: USAGE_SCAN_BUDGET_SEC,
    maxOutBytes: USAGE_SCAN_MAX_OUT_BYTES,
    cursors,
    ...(customDirs.length ? { customDirs } : {}),
  };
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), USAGE_REMOTE_COMMAND],
    input: `${JSON.stringify(loadUsageScript())}\n${JSON.stringify(payload)}`,
    timeoutMs: USAGE_SCAN_TIMEOUT_MS,
    // 增量输出可达数 MB，默认的 1MB exec 输出上限不够；远端已按字节自限，这里只是兜底
    maxOutputBytes: USAGE_SCAN_MAX_OUT_BYTES + 512 * 1024,
  };
}

const str = (value, key) => (typeof value === "string" && value.length > 0 ? value.slice(0, LIMITS[key] ?? 256) : null);
const time = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 4e9 ? value : null);
const count = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_NUMBER) : 0);

function parseCall(raw) {
  const agent = raw.a;
  const sid = str(raw.sid, "sid");
  const rid = str(raw.rid, "rid");
  const t = time(raw.t);
  if (!AGENTS.has(agent) || !sid || !rid || t === null) return null;
  const ok = raw.st !== "err";
  const code = Number.isInteger(raw.code) && raw.code >= 100 && raw.code <= 599 ? raw.code : null;
  return {
    agent, sid, rid, t,
    model: str(raw.m, "m"),
    ok,
    code: ok ? null : code,
    inFresh: ok ? count(raw.in) : 0,
    cacheWrite: ok ? count(raw.cw) : 0,
    cacheRead: ok ? count(raw.cr) : 0,
    output: ok ? count(raw.o) : 0,
    prompt: ok ? count(raw.p) : 0,
    turnId: str(raw.tid, "tid"),
    sidechain: raw.sc === 1,
    // 错误原文（v2.51 起远端附带）：只给失败调用保存，二次脱敏 + 限长；旧版远端没有 em → null。
    errorText: ok ? null : sanitizeErrorText(raw.em),
    errorDropped: false,
  };
}

function parseSession(raw) {
  const sid = str(raw.sid, "sid");
  if (!AGENTS.has(raw.a) || !sid) return null;
  return { agent: raw.a, sid, cwd: str(raw.cwd, "cwd"), t: time(raw.t), window: count(raw.w) || null };
}

function parseTurn(raw) {
  const sid = str(raw.sid, "sid");
  const tid = str(raw.tid, "tid");
  const t0 = time(raw.t0);
  const t1 = time(raw.t1);
  if (!AGENTS.has(raw.a) || !sid || !tid || (t0 === null && t1 === null)) return null;
  return { agent: raw.a, sid, tid, t0, t1 };
}

function parseCursor(raw) {
  const file = str(raw.f, "f");
  // inode 以十进制字符串往返（共享文件系统的 inode 可能超出 Number 安全整数）。
  if (!file || typeof raw.i !== "string" || !/^\d{1,24}$/.test(raw.i) || !Number.isSafeInteger(raw.o) || raw.o < 0) return null;
  // s 是远端自己的解析状态（Codex 的会话 id / 模型 / 累计值），原样回传即可；只限制体积。
  const state = raw.s && typeof raw.s === "object" && !Array.isArray(raw.s) && JSON.stringify(raw.s).length <= 4096 ? raw.s : {};
  const cursor = { i: raw.i, o: raw.o, mt: time(raw.mt) ?? 0, s: state };
  if (raw.skip === true) cursor.skip = true;
  return [file, cursor];
}

export function parseUsageScanOutput(stdout) {
  const result = { calls: [], sessions: [], turns: [], compacts: [], cursors: {}, end: null, badLines: 0 };
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
    let parsed = null;
    switch (raw.k) {
      case "c": parsed = parseCall(raw); if (parsed) result.calls.push(parsed); break;
      case "s": parsed = parseSession(raw); if (parsed) result.sessions.push(parsed); break;
      case "t": parsed = parseTurn(raw); if (parsed) result.turns.push(parsed); break;
      case "x": {
        const sid = str(raw.sid, "sid");
        const t = time(raw.t);
        parsed = AGENTS.has(raw.a) && sid && t !== null ? { agent: raw.a, sid, t } : null;
        if (parsed) result.compacts.push(parsed);
        break;
      }
      case "cur": parsed = parseCursor(raw); if (parsed) result.cursors[parsed[0]] = parsed[1]; break;
      case "end":
        parsed = {
          complete: raw.complete === true,
          files: count(raw.files),
          pending: count(raw.pending),
          bytes: count(raw.bytes),
          sec: typeof raw.sec === "number" && Number.isFinite(raw.sec) ? raw.sec : null,
          roots: Object.fromEntries(USAGE_AGENT_IDS.map((id) => [id, raw.roots?.[id] === true])),
          installed: Array.isArray(raw.installed) ? [...new Set(raw.installed.filter((a) => AGENTS.has(a)))] : null,
          home: typeof raw.home === "string" && raw.home.startsWith("/") ? raw.home.slice(0, 256) : null,
        };
        result.end = parsed;
        break;
      default: break;
    }
    if (!parsed) result.badLines += 1;
  }
  return result;
}
