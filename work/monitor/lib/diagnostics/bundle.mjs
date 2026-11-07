// 诊断包的组装（v2.64，纯函数）：把 service.mjs 读到的各块事实拼成一个 JSON，整份过一遍脱敏（redact.mjs）。
//
// 包里有什么写在 DIAGNOSTICS_CONTENTS（界面上导出前列出的那几条与它对应）。每块都有上限：
// 每份日志末尾 ≤ 300 行、断线账本末尾 ≤ 200 行、单行 ≤ 4 KB（超出的只留开头并标出）。
// 顺序是先脱敏、再截断：先截断会把 "token":"… 的收尾引号切掉，值以半截的形式漏过脱敏规则。
import { BEIJING_OFFSET_MS } from "../beijing-time.mjs";
import { redactDiagnostics } from "./redact.mjs";

export const DIAGNOSTICS_SCHEMA = "cluster-workbench-diagnostics";
export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const LOG_TAIL_LINES = 300;
export const LEDGER_TAIL_LINES = 200;
export const LINE_MAX_CHARS = 4096;

export const DIAGNOSTICS_CONTENTS = Object.freeze([
  "版本与构建信息、操作系统与架构、Node / Electron 版本",
  "合并后的配置（团队层 + 个人层，已脱敏）",
  "当前状态快照与未结事件",
  "各日志（runtime/logs/*.ndjson）末尾各至多 300 行",
  "隧道断线账本末尾至多 200 行",
  "后台进程登记摘要与本地存储占用",
]);

export const DIAGNOSTICS_PRIVACY_NOTE = "令牌、口令、代理口令、保管库、认证头与 Cookie、URL 中的口令、常见服务商密钥已替换为「[已隐藏]」；主机名、账号名与路径保留，便于排查。";

// 一行 NDJSON → 对象；解析不了的保留原文。这里不截断（读文件时每份最多读 256 KB，单行有上限）——
// 截断在整份脱敏之后（clipTailEntries）。
export function parseTailLine(line) {
  const text = String(line ?? "");
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : { raw: text };
  } catch {
    return { raw: text };
  }
}

// 脱敏之后：日志 / 账本里序列化超过 4 KB 的一行只留开头（对象先序列化再截），标出 truncated。
function clipEntry(entry) {
  if (entry && typeof entry === "object" && typeof entry.raw === "string" && Object.keys(entry).length === 1) {
    return entry.raw.length > LINE_MAX_CHARS ? { raw: entry.raw.slice(0, LINE_MAX_CHARS), truncated: true } : entry;
  }
  const serialized = JSON.stringify(entry) ?? "";
  return serialized.length > LINE_MAX_CHARS ? { raw: serialized.slice(0, LINE_MAX_CHARS), truncated: true } : entry;
}

export function clipTailEntries(block) {
  if (!block || typeof block !== "object" || !Array.isArray(block.entries)) return block;
  return { ...block, entries: block.entries.map(clipEntry) };
}

// 进程登记（runtime/<name>.pid.json）→ 摘要：不带配置身份签名之类的长串，参数各截 300 字、最多 24 个。
export function summarizeProcessRecord(name, meta, { alive = null } = {}) {
  const src = meta && typeof meta === "object" ? meta : {};
  const args = Array.isArray(src.args) ? src.args.slice(0, 24).map((arg) => String(arg).slice(0, 300)) : [];
  return {
    name: String(name).slice(0, 128),
    pid: Number.isInteger(src.pid) ? src.pid : null,
    alive,
    startedAt: typeof src.startedAt === "string" ? src.startedAt.slice(0, 40) : null,
    command: typeof src.command === "string" ? src.command.slice(0, 300) : null,
    args,
    parentPid: Number.isInteger(src.parentPid) ? src.parentPid : null,
    ...(src.adopted === true ? { adopted: true } : {}),
    ...(typeof src.signature === "string" ? { hasSignature: true } : {}),
  };
}

const pad = (n, width = 2) => String(n).padStart(width, "0");

// 北京时间的时间戳：文件名用紧凑写法，包里另给一份可读写法。
export function beijingStamp(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return {
    compact: `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`,
    text: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} 北京时间`,
  };
}

export function diagnosticsFilename(generatedAt) {
  return `cluster-workbench-diagnostics-${beijingStamp(generatedAt).compact}.json`;
}

// parts：service.mjs 读到的各块；secrets：已知秘密的各种写法（redact.secretVariants）。
// 返回 { filename, bundle, bytes, redactions }。读失败的块以 { error } 出现，不让整份导出失败。
export function assembleDiagnosticsBundle(parts = {}, { generatedAt = Date.now(), secrets = [] } = {}) {
  const stamp = beijingStamp(generatedAt);
  const draft = {
    schema: DIAGNOSTICS_SCHEMA,
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt,
    generatedAtText: stamp.text,
    summary: {
      contents: [...DIAGNOSTICS_CONTENTS],
      privacy: DIAGNOSTICS_PRIVACY_NOTE,
      limits: { logTailLines: LOG_TAIL_LINES, ledgerTailLines: LEDGER_TAIL_LINES, lineMaxChars: LINE_MAX_CHARS },
      redactions: 0,
    },
    app: parts.app ?? null,
    platform: parts.platform ?? null,
    runtime: parts.runtime ?? null,
    config: parts.config ?? null,
    status: parts.status ?? null,
    openIncidents: parts.openIncidents ?? null,
    logs: parts.logs ?? null,
    tunnelLedger: parts.tunnelLedger ?? null,
    processes: parts.processes ?? null,
    storage: parts.storage ?? null,
  };
  const { value, count } = redactDiagnostics(draft, { secrets });
  if (value.logs && typeof value.logs === "object" && !Array.isArray(value.logs)) {
    for (const source of Object.keys(value.logs)) value.logs[source] = clipTailEntries(value.logs[source]);
  }
  value.tunnelLedger = clipTailEntries(value.tunnelLedger);
  value.summary.redactions = count;
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { filename: diagnosticsFilename(generatedAt), bundle: value, bytes, redactions: count };
}
