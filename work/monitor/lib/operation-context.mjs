import { randomUUID as nodeRandomUUID } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_RE = /^(authorization|proxy-authorization|x-auth-token|api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|token|password|passwd|secret)$/i;
const OUTPUT_KEY_RE = /^(output|stdout|stderr|commandOutput)$/i;
const MAX_OUTPUT_CHARS = 64 * 1024;

export function normalizeOperationId(value, { randomUUID = nodeRandomUUID } = {}) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return UUID_RE.test(candidate) ? candidate.toLowerCase() : randomUUID();
}

function redactString(value, { bounded = false } = {}) {
  let text = value
    .replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 [REDACTED]")
    .replace(/\b((?:api[-_]?key|api[-_]?token|access[-_]?token|auth[-_]?token|x-auth-token)\s*[:=]\s*)[^\s,"']+/gi, "$1[REDACTED]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("//") + 2)}[REDACTED]@`);
  if (bounded && text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
  }
  return text;
}

function redactValue(value, key, inheritedBounded) {
  if (SENSITIVE_KEY_RE.test(key)) return "[REDACTED]";
  const bounded = inheritedBounded || OUTPUT_KEY_RE.test(key);
  if (typeof value === "string") return redactString(value, { bounded });
  if (Array.isArray(value)) return value.map((item) => redactValue(item, "", bounded));
  if (!value || typeof value !== "object") return value;
  const copy = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = redactValue(childValue, childKey, bounded);
  }
  return copy;
}

export function redactSensitive(value) {
  return redactValue(value, "", false);
}
