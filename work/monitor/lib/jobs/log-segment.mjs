// 日志按段向前读取（v2.51）：本机侧的调用组装与输出解析。
//
// 远端脚本 remote/log-segment.py 经 stdin 送达（与 job-forensics 同一零残留模式）：
//   ssh host "<固定 python3 引导命令>"，stdin 第 1 行 = 脚本源码的 JSON 字符串，第 2 行 = 参数 JSON。
// 远端命令串是常量；路径（本机从登记表 / 诊断记录解析出的绝对路径）、偏移与文件身份全部走 stdin。
// 远端输出一律当不可信数据：只认一行已知类型的 JSON，字段逐个校验，文本按单段上限截断。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildProbeSshArgs } from "../ssh-args.mjs";

export const SEGMENT_SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "remote", "log-segment.py");
export const SEGMENT_REMOTE_COMMAND = `python3 -c 'import sys,json;exec(compile(json.loads(sys.stdin.readline()),"log-segment","exec"))'`;
// 单段上限（远端另有 32KB 硬上限）；签名取区间起点之后最多 64 字节。
export const SEGMENT_MAX_BYTES = 32 * 1024;
export const SEGMENT_SIG_BYTES = 64;
export const SEGMENT_TIMEOUT_MS = 15000;
// 32KB 原文按 JSON 转义最坏约 6 倍；留足余量但仍有界。
const MAX_OUTPUT_BYTES = 256 * 1024;
export const SEGMENT_ERROR_CODES = Object.freeze(["missing", "unreadable", "notRegular", "notOwner", "rotated", "truncated", "rewritten", "binary"]);
const ERROR_SET = new Set(SEGMENT_ERROR_CODES);
export const SIG_RE = /^\d{1,2}-[0-9a-f]{40}$/;
const INO_RE = /^\d{1,20}$/;

let scriptCache = null;
export function loadSegmentScript() {
  if (scriptCache === null) scriptCache = readFileSync(SEGMENT_SCRIPT_PATH, "utf8");
  return scriptCache;
}

const offset = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

// 本机已采集文本开头若干字节的签名（与远端 sig 同一算法："<字节数>-<sha1>"）。
// 文本里有 U+FFFD（远端按 replace 解码过的坏字节）时字节已对不上原文，返回 null，不拿它做校验。
export function textSignature(text) {
  if (typeof text !== "string" || !text || text.includes("�")) return null;
  const buf = Buffer.from(text, "utf8").subarray(0, SEGMENT_SIG_BYTES);
  return `${buf.length}-${createHash("sha1").update(buf).digest("hex")}`;
}

// request：{ path, end?, skip?, expect?: { ino, size, mtimeMs, sig } }。
export function buildSegmentInvocation({ server = {}, parsed = {}, knownHostsPath, request, platform = process.platform } = {}) {
  const expect = request?.expect || {};
  const payload = {
    path: request.path,
    max: SEGMENT_MAX_BYTES,
    ...(offset(request.end) !== null ? { end: request.end } : { skip: offset(request.skip) ?? 0 }),
    expect: {
      ...(typeof expect.ino === "string" && INO_RE.test(expect.ino) ? { ino: expect.ino } : {}),
      ...(offset(expect.size) !== null ? { size: expect.size } : {}),
      ...(offset(expect.mtimeMs) !== null ? { mtimeMs: expect.mtimeMs } : {}),
      ...(typeof expect.sig === "string" && SIG_RE.test(expect.sig) ? { sig: expect.sig } : {}),
    },
  };
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), SEGMENT_REMOTE_COMMAND],
    input: `${JSON.stringify(loadSegmentScript())}\n${JSON.stringify(payload)}\n`,
    timeoutMs: SEGMENT_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  };
}

// stdout → { ok: true, segment } | { ok: false, code }；没有可认的输出 → { ok: false, code: null }（SSH 失败等）。
export function parseSegmentOutput(stdout) {
  for (const line of String(stdout ?? "").slice(0, MAX_OUTPUT_BYTES + 1024).split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    if (raw.k === "err") return { ok: false, code: ERROR_SET.has(raw.code) ? raw.code : "unreadable" };
    if (raw.k !== "seg") continue;
    const start = offset(raw.start);
    const end = offset(raw.end);
    const size = offset(raw.size);
    const dropped = offset(raw.dropped);
    if (start === null || end === null || size === null || dropped === null || start > end || end > size || end - start > SEGMENT_MAX_BYTES) continue;
    if (typeof raw.t !== "string" || typeof raw.ino !== "string" || !INO_RE.test(raw.ino)) continue;
    return {
      ok: true,
      segment: {
        start,
        end,
        dropped: Math.min(dropped, SEGMENT_MAX_BYTES),
        noBreak: raw.noBreak === true,
        size,
        ino: raw.ino,
        mtimeMs: offset(raw.mt),
        sig: typeof raw.sig === "string" && SIG_RE.test(raw.sig) ? raw.sig : null,
        text: raw.t.slice(0, SEGMENT_MAX_BYTES),
      },
    };
  }
  return { ok: false, code: null };
}
