const WARN_MS = 3 * 864e5;

// B3：真实 codex auth.json 的过期时间不在顶层 expiresAt/exp 字段，而是编码在
// tokens.access_token 这枚 JWT 的 payload.exp 里。无第三方依赖：Buffer 内置
// 'base64url' 编码即可解 JWT 的 header.payload.signature 三段式。
// 解不出（非 JWT / 段数不对 / base64url 或 JSON 损坏）一律返回 null，安全降级，
// 不抛异常、不误报——调用方据此仍归并为 unknown。
function decodeJwtExpMs(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = payload?.exp;
    if (typeof exp !== "number") return null;
    return exp < 1e11 ? exp * 1000 : exp;
  } catch {
    return null;
  }
}

export function parseAgentExpiry({ kind, raw, now = Date.now() }) {
  let ms = null;
  try {
    const o = JSON.parse(raw);
    const c = o.expiresAt ?? o.expires_at ?? o.exp ?? o.token?.expiresAt ?? o.token?.expires_at;
    if (typeof c === "number") ms = c < 1e11 ? c * 1000 : c;
    else if (typeof c === "string") { const t = Date.parse(c); if (!Number.isNaN(t)) ms = t; }
    if (ms == null) ms = decodeJwtExpMs(o.tokens?.access_token);
  } catch {}
  if (ms == null) return { available: false, level: "unknown", expiresAt: null, remainingMs: null };
  const remainingMs = ms - now;
  const level = remainingMs <= 0 ? "expired" : remainingMs < WARN_MS ? "warn" : "ok";
  return { available: true, level, expiresAt: ms, remainingMs };
}
