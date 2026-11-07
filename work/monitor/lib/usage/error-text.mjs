// 失败调用的错误原文：本机侧的二次脱敏、限长与归类（纯函数，无 IO）。
//
// 来源：remote/usage-scan.py 在失败调用的 c 记录上附带 em（v2.51 起）——Claude 取
// message.content 的 text 块，Codex 取 payload.message；远端已单行化、限 300 字符、粗脱敏。
// 远端输出仍按不可信数据处理：这里再过一遍 redactSensitive、去控制字符、再次限长。
//
// 状态区分（界面据此写口径，不猜）：
//   errorText 为字符串      → 已采集（"" = 日志里这条错误没有文本）
//   errorText 为 null       → 采集于 v2.51 之前（远端没给 em），未保存原文
//   errorDropped 为 true    → 远端给了原文，但超出本机保存上限，未保存

import { redactSensitive } from "../operation-context.mjs";

export const MAX_ERROR_TEXT_CHARS = 300;
// 每台服务器保留期内错误原文的总字节上限。实测（2026-10）一个月约 460 条错误、单条 100–250 字节，
// 1 MiB 足够；超出后新失败调用只记「未保存」，不挤掉已有原文。
export const ERROR_TEXT_BUDGET_BYTES = 1024 * 1024;

// 远端 em → 本机保存的原文；没有该字段（旧版远端脚本）→ null。
export function sanitizeErrorText(value) {
  if (typeof value !== "string") return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉远端文本里的控制字符
  const single = value.slice(0, MAX_ERROR_TEXT_CHARS * 2).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return redactSensitive(single).slice(0, MAX_ERROR_TEXT_CHARS);
}

export const errorTextBytes = (text) => (typeof text === "string" ? Buffer.byteLength(text) : 0);

// 按原文归类。规则只收 2026-10 在集群上实际抽查到的文案（Claude Code 生成的合成错误消息），
// 认不出的归 other，不臆造类别。顺序有意义：先匹配更具体的。
const ERROR_KIND_RULES = [
  ["stream_stopped", /response stopped arriving/i],
  ["connection_lost", /connection lost mid-response/i],
  ["server_mid_response", /server error mid-response/i],
  ["safeguards", /safeguards flagged/i],
  ["usage_limit", /reached your .{0,40}limit|hit your session limit/i],
  ["gateway_unreachable", /cannot reach the .{0,40}gateway/i],
  ["account_unavailable", /绑定账号暂不可用/],
  ["client_state", /客户端状态异常/],
  ["auth_revoked", /token has been revoked|run \/login/i],
];

export function classifyErrorText(text) {
  if (typeof text !== "string" || !text) return null;
  for (const [kind, re] of ERROR_KIND_RULES) if (re.test(text)) return kind;
  return "other";
}

// 失败调用的原文状态 → 归类键。没有原文时给出原因键，供「无状态码失败」一行按口径计数。
export function errorKindOf(call) {
  if (call.ok) return null;
  if (call.errorDropped) return "dropped";
  if (call.errorText === null || call.errorText === undefined) return "unrecorded";
  if (call.errorText === "") return "empty";
  return classifyErrorText(call.errorText);
}
