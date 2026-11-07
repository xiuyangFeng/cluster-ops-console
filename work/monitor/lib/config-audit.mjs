import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs";
import { dirname } from "node:path";

const SENSITIVE_KEYS = new Set([
  "password", "sshPassword", "sshpass", "sshIdentityFile", "identityData", "privateKey", "authRef",
]);

export function hashSecretRef(value) {
  if (value == null || value === "") return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function redactAuditFields(input = {}) {
  const refs = {};
  for (const [key, value] of Object.entries(input)) {
    if (!SENSITIVE_KEYS.has(key) || value == null || value === "") continue;
    refs[key] = hashSecretRef(value);
  }
  return refs;
}

export function createConfigAudit({ filePath, appendLog = () => {}, now = Date.now, writeFileSync = appendFileSync, stat = statSync, truncate = truncateSync, maxBytes = 2 * 1024 * 1024 } = {}) {
  function record({ action, serverId = null, result = "ok", errorCode = null, fields = {}, actor = "local" }) {
    const event = {
      ts: new Date(now()).toISOString(),
      actor: String(actor).slice(0, 128),
      action: String(action).slice(0, 128),
      serverId: serverId == null ? null : String(serverId).slice(0, 128),
      result: String(result).slice(0, 64),
      errorCode: errorCode == null ? null : String(errorCode).slice(0, 128),
      fieldRefs: redactAuditFields(fields),
    };
    if (filePath) {
      try {
        mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
        const line = `${JSON.stringify(event)}\n`;
        let size = 0;
        try { size = stat(filePath).size; } catch (err) { if (err.code !== "ENOENT") throw err; }
        if (size + Buffer.byteLength(line) > maxBytes) {
          truncate(filePath, 0);
          const marker = `${JSON.stringify({ ts: event.ts, event: "config-audit-rotated" })}\n`;
          writeFileSync(filePath, marker, { mode: 0o600 });
        }
        writeFileSync(filePath, line, { mode: 0o600 });
      } catch (err) {
        appendLog(`config audit write failed: ${err.message}`, { level: "warn", event: "config-audit" });
      }
    }
    appendLog(`config ${action} ${result}${serverId ? ` ${serverId}` : ""}`, {
      event: "config-audit",
      action,
      serverId,
      result,
      errorCode,
    });
    return event;
  }

  return { record };
}
