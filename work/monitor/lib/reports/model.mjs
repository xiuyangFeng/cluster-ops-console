// 排障报告的纯投影：只接收已经筛选的本机证据，默认脱敏，不执行或上传任何内容。
import { isIP } from "node:net";
import { BEIJING_OFFSET_MS } from "../beijing-time.mjs";
import { headBytes } from "../jobs/diagnoses-store.mjs";

export const REPORT_MAX_BYTES = 64 * 1024;
const clean = (value, max = 1000) => String(value ?? "").replace(/\p{Cc}/gu, (char) => ["\t", "\n", "\r"].includes(char) ? char : "").slice(0, max);
const line = (value) => clean(value).replace(/[\r\n]+/g, " ");
const plain = (value) => line(value).replace(/([\\`*_{}[\]()<>!#|])/g, "\\$1");
const stamp = (value) => Number.isFinite(value) && value > 0 && value < 8.64e15 - BEIJING_OFFSET_MS ? `${new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ")} 北京时间` : "未记录";
const quoted = (value) => `\`${line(value).replace(/`/g, "'")}\``;

// 证据原文可包含 Markdown fence，使用比原文更长的 fence 保持其始终是文本。
function fence(value, max = 8192) {
  const text = clean(value, max);
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const delimiter = "`".repeat(longest + 1);
  return `${delimiter}text\n${text}\n${delimiter}`;
}

export function redactReport(text, { hosts = [], users = [] } = {}) {
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      const next = typeof replacement === "function" ? replacement(...args) : replacement;
      if (next !== args[0]) count += 1;
      return next;
    });
  };
  replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, "[私钥已隐藏]");
  // Cookie headers may contain several semicolon-separated credentials. Redact the whole
  // value before the generic key=value rule, which intentionally stops at separators.
  replace(/(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]*/gi, (_match, prefix) => `${prefix}[凭据已隐藏]`);
  replace(/(--(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|proxy-user)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s]+)/gi, (_match, prefix) => `${prefix}[凭据已隐藏]`);
  replace(/\b(Bearer|Basic)\s+[A-Za-z0-9_+./=:-]+/gi, "[认证已隐藏]");
  // Markdown inline text escapes underscores. Match those separators without
  // consuming unrelated key/value pairs (a URL prefix must not swallow ?token=).
  // curl 的代理认证（配置行里的 proxy-user 一项，与上面那条规则里的 --proxy-user）：v2.62 代理口令经它交给 curl。
  replace(/((?:[\w\\-]*(?:api(?:\\?[_-])?key|token|secret(?:(?:\\?[_-])?access)?(?:\\?[_-])?key|secret|password|passwd|authorization|cookie|proxy(?:\\?[_-])?user))["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;]+)/gi, (_match, prefix) => `${prefix}[凭据已隐藏]`);
  replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bhf_[A-Za-z0-9]{16,}\b/g, "[密钥已隐藏]");
  replace(/\b(?:sk|ghp|github_pat|xoxb|xoxp)[_-][A-Za-z0-9_-]{8,}\b/g, "[密钥已隐藏]");
  replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, (_match, scheme) => `${scheme}[凭据已隐藏]@`);
  replace(/\[?([A-Fa-f0-9]*:[A-Fa-f0-9:.]+(?:%[\w.-]+)?)\]?/g, (match, address) => isIP(address) === 6 ? "[IP已隐藏]" : match);
  replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP已隐藏]");
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已隐藏]");
  replace(/\/(?:Users|home)\/[^\s/"'`]+/g, "/home/[用户]");
  const escapePattern = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const host of [...new Set(hosts)].filter((x) => typeof x === "string" && x.length >= 2).sort((a, b) => b.length - a.length)) {
    replace(new RegExp(`(?<![\\w.-])${escapePattern(host)}(?![\\w.-])`, "gi"), "[服务器]");
  }
  for (const user of [...new Set(users)].filter((x) => typeof x === "string" && x.length >= 1)) {
    replace(new RegExp(`(?<![\\w])${escapePattern(user)}(?![\\w])`, "g"), "[用户]");
  }
  return { text, count };
}

export function buildTroubleshootingReport({ kind, server, version, generatedAt, job, diagnosis, script, incident, incidents = [], disconnects = [], operations = [], availability = [], snapshotAt, sensitive = {} }) {
  const targetId = kind === "job" ? job?.id || diagnosis?.jobId : incident?.incidentId;
  const out = [
    `# ${kind === "job" ? "作业" : "事件"}排障报告`, "",
    `- 生成时间：${stamp(generatedAt)}`,
    `- 工作台版本：${quoted(version || "未知")}`,
    `- 服务器：${quoted(server?.name || server?.id || "全局")}`,
    `- ${kind === "job" ? "作业" : "事件"}编号：${quoted(targetId)}`,
    "- 本报告来自本机已采集记录；未触发远程命令。时间相近的事件仅供排查，不代表因果关系。", "",
  ];
  if (kind === "job") {
    out.push("## 作业与失败证据", "",
      `- 名称：${quoted(job?.name || diagnosis?.name || "未记录")}`,
      `- 状态：${quoted(job?.state || diagnosis?.state || "未知")}；退出码：${quoted(job?.exitCode ?? diagnosis?.exitCode ?? "未知")}`,
      `- 节点：${quoted(job?.nodes || "未记录")}；分区：${quoted(job?.partition || "未记录")}`,
      `- 开始：${stamp(job?.startAt)}；结束：${stamp(job?.endAt ?? diagnosis?.endedAtMs)}`,
      `- 作业快照采集：${stamp(snapshotAt)}`, "",
      diagnosis ? `诊断：${plain(diagnosis.headline)}` : "尚无失败诊断记录。", "");
    if (diagnosis?.evidence?.length) out.push(fence(diagnosis.evidence.slice(0, 20).join("\n")), "");
    for (const file of (diagnosis?.files || []).slice(0, 4)) {
      out.push(`日志 ${quoted(file.path)}`, "", fence(file.tail, 4096), "");
    }
    out.push("## 提交脚本", "", script ? fence(script) : "未包含（可在预览中勾选；只包含本机已保存的脚本）。", "");
  } else {
    out.push("## 事件事实", "",
      `- 组件：${quoted(incident?.component)}；原因：${quoted(incident?.reasonCode)}`,
      `- 状态：${quoted(incident?.lifecycle)}；次数：${incident?.occurrences ?? "未知"}`,
      `- 首次：${stamp(incident?.firstSeenAt)}；最近：${stamp(incident?.lastSeenAt)}；恢复：${stamp(incident?.resolvedAt)}`, "");
    if (incident?.evidenceRefs?.length) out.push(fence(JSON.stringify(incident.evidenceRefs.slice(-8), null, 2), 8192), "");
  }
  out.push("## 同期事件", "");
  if (!incidents.length) out.push("本机留存中没有找到同期事件。", "");
  for (const item of incidents.slice(0, 12)) {
    out.push(`- ${stamp(item.firstSeenAt)} · ${quoted(item.component)} / ${quoted(item.reasonCode)} · ${quoted(item.lifecycle)} · ${quoted(item.incidentId)}`);
  }
  out.push("", "## 同期隧道断线", "");
  if (!disconnects.length) out.push("本机断线账本中没有找到同期断线。", "");
  // 账本里带 sleep 的断线是电脑休眠造成的（lib/supervisor/tunnel-controller.mjs），照实标出，不让它看着像服务器故障。
  for (const event of disconnects.slice(-12)) out.push(`- ${stamp(event.at)} · ${quoted(event.cause || "未知原因")} · ${plain(event.detail || "")} · ${event.planned ? "计划内" : event.sleep === true ? "本机休眠造成" : "非计划内"}`);
  out.push("", "## 关联处置日志", "");
  if (!operations.length) out.push("没有关联的处置日志（可能未执行处置，或记录已轮转）。", "");
  for (const operation of operations.slice(0, 4)) {
    out.push(`操作 ${quoted(operation.id)}`, "", fence(operation.entries.map((e) => `${stamp(e.ts)} ${line(e.level)} ${clean(e.message, 1200)}`).join("\n") || "未找到日志。"), "");
  }
  out.push("## 数据范围与隐私", "",
    "仅汇集本机仍然留存的证据，不是完整审计记录。已自动隐藏常见凭据、IP、用户名和已配置主机地址；分享前仍可在预览中检查内容。",
    ...availability.map((note) => `- ${plain(note)}`), "");
  const redacted = redactReport(out.join("\n"), sensitive);
  const truncated = Buffer.byteLength(redacted.text) > REPORT_MAX_BYTES;
  const markdown = truncated ? `${headBytes(redacted.text, REPORT_MAX_BYTES - 100)}\n\n[报告达到大小上限，后续内容已省略]\n` : redacted.text;
  const safeId = String(targetId || "report").replace(/[^\w-]/g, "_").slice(0, 64);
  return { schemaVersion: 1, kind, generatedAt, filename: `${kind}-${safeId}-report.md`, markdown, redactions: redacted.count, truncated };
}
