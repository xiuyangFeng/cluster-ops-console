// tunnel-egress 段（slow 采集，remote/collect.sh ct_tunnel_egress）的解析：此刻经反向隧道出网的程序。
// 集群上的 CLI 用 HTTP_PROXY=http://127.0.0.1:<反向端口> 出网，远端用 ss 列出连着这个端口的 TCP 连接，
// 按程序名汇总连接数与这些连接上已收发的字节，这里只做白名单解析：
//   state=ok|absent|error|skip:<原因>   port=<端口>   detail=full|basic
//   total=<连接数>|<发送字节|->|<接收字节|->
//   others=<连接数>|<发送字节|->|<接收字节|->   （看不到进程的连接：多半是别的账号的程序；只在 detail=full 时有）
//   progs=<程序个数>
//   prog=<程序名>|<连接数>|<发送字节|->|<接收字节|->   最多 20 行，按连接数从多到少
// 返回 { state, port, detail, total, others, programCount, programs }，每组数字是
// { conns, sentBytes, recvBytes }，字节 null = 内核没给（老内核 / ss 不认 -i）。
// state 不是 ok 时只有 state 与 port（absent = 远端没有 ss，error = ss 查询失败或超时，skip = 没有可查的端口）。
// 空段（旧采集脚本 / 整段失败）或没有可认的 state 行 → null。
// 字节是这些连接建立以来的累计，只覆盖此刻还开着的连接——不是某段时间的流量。
// 行尾多出来的字段忽略（以后只在末尾加）；程序名白名单外的行整行不计。

import { toPort } from "./validators.mjs";

export const TUNNEL_EGRESS_MAX_PROGRAMS = 20;
const NAME_RE = /^[A-Za-z0-9._+-]{1,32}$/;
const STATES = new Set(["ok", "absent", "error"]);
// 上限只为挡住损坏的数字：连接数 1e7、字节 1e18（1 EB）。
const MAX_CONNS = 1e7;
const MAX_BYTES = 1e18;

function count(text) {
  const value = String(text ?? "").trim();
  if (!/^\d{1,8}$/.test(value)) return null;
  const n = Number(value);
  return n <= MAX_CONNS ? n : null;
}

// 字节："-" = 内核没给 → null；畸形 → undefined（整行不计）。
function bytes(text) {
  const value = String(text ?? "").trim();
  if (value === "-") return null;
  if (!/^\d{1,19}$/.test(value)) return undefined;
  const n = Number(value);
  return n <= MAX_BYTES ? n : undefined;
}

function triple(fields) {
  const conns = count(fields[0]);
  const sentBytes = bytes(fields[1]);
  const recvBytes = bytes(fields[2]);
  if (conns == null || sentBytes === undefined || recvBytes === undefined) return null;
  return { conns, sentBytes, recvBytes };
}

export function parseTunnelEgress(text) {
  let state = null;
  let port = null;
  let detail = null;
  let total = null;
  let others = null;
  let programCount = null;
  const programs = [];
  for (const rawLine of String(text == null ? "" : text).split("\n")) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "state") {
      if (state !== null) continue;
      if (STATES.has(value)) state = value;
      else if (/^skip(?::[a-z-]{1,32})?$/.test(value)) state = "skip";
    } else if (key === "port") {
      port = toPort(value);
    } else if (key === "detail") {
      detail = value === "full" || value === "basic" ? value : null;
    } else if (key === "total") {
      total = triple(value.split("|"));
    } else if (key === "others") {
      others = triple(value.split("|"));
    } else if (key === "progs") {
      programCount = count(value);
    } else if (key === "prog") {
      const fields = value.split("|");
      const name = fields[0];
      if (!NAME_RE.test(name) || programs.length >= TUNNEL_EGRESS_MAX_PROGRAMS) continue;
      if (programs.some((entry) => entry.name === name)) continue;
      const nums = triple(fields.slice(1));
      if (nums) programs.push({ name, ...nums });
    }
  }
  if (state === null) return null;
  if (state !== "ok") return { state, port, detail: null, total: null, others: null, programCount: 0, programs: [] };
  // ok 却没有 total 行（输出截断在它之前）：连接数无从说起，按没采到处理
  if (!total) return null;
  return {
    state,
    port,
    detail: detail ?? "full",
    total,
    others: detail === "basic" ? null : others,
    programCount: programCount ?? programs.length,
    programs,
  };
}
