// 页面脚本错误的上报入口（v2.64，服务端这一侧）：POST /api/diagnostics/client-error 的正文规整与限流。
//
// 页面那边（public/assets/js/error-reporter.js）已经按「消息 + 位置」去重、每分钟最多 10 条、截断过；
// 这里不信它：同一份规则再做一遍，另加每小时上限，任何页面（包括开了好几个标签页、或脚本出错刷屏）
// 都没法把 renderer.ndjson 写爆。被挡下的条数记在下一条放行的记录上（droppedBefore），不额外写日志。
// 纯逻辑，不碰盘；落盘在 service.mjs。

export const CLIENT_ERROR_LIMITS = Object.freeze({
  message: 500,
  stack: 4000,
  source: 300,
  page: 32,
  perMinute: 10,
  perHour: 60,
  dedupeMs: 60_000,
  bodyBytes: 16 * 1024,
});

const KINDS = new Set(["error", "unhandledrejection"]);

// 去掉控制字符（换行与制表留着，栈要分行），截到上限。
function clip(value, max) {
  if (typeof value !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉控制字符
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return text.length > max ? `${text.slice(0, max)}…[已截断]` : text;
}

// 位置只留到路径：查询串与锚点里可能带令牌（EventSource 的 ?token=），一律剥掉。
function cleanSource(value) {
  const text = clip(value, 2048).trim();
  if (!text) return "";
  return clip(text.replace(/[?#].*$/, ""), CLIENT_ERROR_LIMITS.source);
}

function lineNumber(value) {
  if (value == null || value === "") return null; // Number(null) 是 0：没有位置不能记成第 0 行
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < 10_000_000 ? n : null;
}

// 正文 → 规整后的一条；不是对象、kind 不认识、没有消息时返回 null（路由回 400）。
export function normalizeClientError(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const kind = KINDS.has(body.kind) ? body.kind : null;
  const message = clip(body.message, CLIENT_ERROR_LIMITS.message).trim();
  if (!kind || !message) return null;
  const page = /^[a-z][a-z0-9-]{0,31}$/.test(String(body.page ?? "")) ? body.page : "main";
  const occurrences = lineNumber(body.occurrences);
  return {
    kind,
    message,
    // 字段名不用 source：日志记录里的 source 是日志来源（desktop），会被它盖掉。
    script: cleanSource(body.source),
    line: lineNumber(body.line),
    column: lineNumber(body.column),
    stack: clip(body.stack, CLIENT_ERROR_LIMITS.stack),
    page,
    ...(occurrences && occurrences > 1 ? { occurrences } : {}),
  };
}

export function clientErrorSignature(entry) {
  return [entry.kind, entry.message, entry.script, entry.line ?? "", entry.column ?? ""].join("\u0001");
}

// 限流 + 去重：accept(entry) → { ok: true, droppedBefore } | { ok: false, reason: "duplicate" | "rate-limited" }。
export function createClientErrorGate({ now = Date.now, limits = CLIENT_ERROR_LIMITS } = {}) {
  const accepted = []; // 放行的时刻（只留近一小时）
  const lastSeen = new Map(); // 签名 → 上次放行时刻（最多 200 个）
  let dropped = 0;

  function accept(entry) {
    const ts = now();
    while (accepted.length && ts - accepted[0] >= 3600_000) accepted.shift();
    const signature = clientErrorSignature(entry);
    const seenAt = lastSeen.get(signature);
    if (seenAt != null && ts - seenAt < limits.dedupeMs) {
      dropped += 1;
      return { ok: false, reason: "duplicate" };
    }
    const lastMinute = accepted.filter((t) => ts - t < 60_000).length;
    if (lastMinute >= limits.perMinute || accepted.length >= limits.perHour) {
      dropped += 1;
      return { ok: false, reason: "rate-limited" };
    }
    accepted.push(ts);
    lastSeen.delete(signature);
    lastSeen.set(signature, ts);
    while (lastSeen.size > 200) lastSeen.delete(lastSeen.keys().next().value);
    const droppedBefore = dropped;
    dropped = 0;
    return { ok: true, droppedBefore };
  }

  return { accept };
}
