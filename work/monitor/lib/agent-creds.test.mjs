import { test } from "node:test"; import assert from "node:assert/strict";
import { parseAgentExpiry } from "./agent-creds.mjs";
const NOW = 1_000_000_000_000;
test("epoch-ms expiresAt → ok/warn/expired by remaining", () => {
  assert.equal(parseAgentExpiry({ kind:"codex", raw: JSON.stringify({ expiresAt: NOW + 10*864e5 }), now: NOW }).level, "ok");
  assert.equal(parseAgentExpiry({ kind:"codex", raw: JSON.stringify({ expiresAt: NOW + 1*864e5 }), now: NOW }).level, "warn");
  assert.equal(parseAgentExpiry({ kind:"codex", raw: JSON.stringify({ expiresAt: NOW - 1 }), now: NOW }).level, "expired");
});
test("epoch-seconds and ISO both parse", () => {
  assert.equal(parseAgentExpiry({ kind:"codex", raw: JSON.stringify({ exp: Math.floor((NOW+10*864e5)/1000) }), now: NOW }).available, true);
  assert.equal(parseAgentExpiry({ kind:"reclaude", raw: JSON.stringify({ expires_at: new Date(NOW+10*864e5).toISOString() }), now: NOW }).available, true);
});
test("unparseable → unknown, not throw", () => {
  assert.equal(parseAgentExpiry({ kind:"codex", raw: "not json", now: NOW }).level, "unknown");
  assert.equal(parseAgentExpiry({ kind:"codex", raw: JSON.stringify({ foo: 1 }), now: NOW }).available, false);
});

// ---------------------------------------------------------------------------
// B3: 真实 codex auth.json 结构——tokens.access_token 是 JWT，exp 在 payload 里，
// 不是顶层 expiresAt/exp 字段。之前恒返回 unknown。
// ---------------------------------------------------------------------------

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${body}.${sig}`;
}

test("tokens.access_token JWT 的 payload.exp 解析出 ok/warn/expired", () => {
  const okJwt = makeJwt({ exp: Math.floor((NOW + 10 * 864e5) / 1000), sub: "user-1" });
  const okResult = parseAgentExpiry({
    kind: "codex",
    raw: JSON.stringify({ tokens: { access_token: okJwt }, last_refresh: new Date(NOW).toISOString() }),
    now: NOW,
  });
  assert.equal(okResult.available, true);
  assert.equal(okResult.level, "ok");

  const warnJwt = makeJwt({ exp: Math.floor((NOW + 1 * 864e5) / 1000) });
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: JSON.stringify({ tokens: { access_token: warnJwt } }), now: NOW }).level,
    "warn",
  );

  const expiredJwt = makeJwt({ exp: Math.floor((NOW - 1 * 864e5) / 1000) });
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: JSON.stringify({ tokens: { access_token: expiredJwt } }), now: NOW }).level,
    "expired",
  );
});

test("tokens.access_token 不是合法 JWT（缺段/非 base64url/JSON 损坏）仍安全降级为 unknown，不抛异常", () => {
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: JSON.stringify({ tokens: { access_token: "not-a-jwt" } }), now: NOW }).level,
    "unknown",
  );
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: JSON.stringify({ tokens: { access_token: "a.b" } }), now: NOW }).level,
    "unknown",
  );
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: JSON.stringify({ tokens: {} }), now: NOW }).level,
    "unknown",
  );
  assert.equal(parseAgentExpiry({ kind: "codex", raw: JSON.stringify({}), now: NOW }).level, "unknown");
});

test("顶层 expiresAt 候选字段优先于 JWT 解析（既有字段命中时不需要再解 JWT）", () => {
  const jwtWithDifferentExp = makeJwt({ exp: Math.floor((NOW - 864e5) / 1000) }); // 已过期
  const raw = JSON.stringify({
    expiresAt: NOW + 10 * 864e5, // 未过期
    tokens: { access_token: jwtWithDifferentExp },
  });
  assert.equal(parseAgentExpiry({ kind: "codex", raw, now: NOW }).level, "ok");
});

test("16KB 截断 vs 2048B 截断：真实体量 auth.json（~4.4KB）在旧的 head -c 2048 下会截断成非法 JSON 而返回 unknown，放宽截断后能正常解析", () => {
  const jwt = makeJwt({ exp: Math.floor((NOW + 10 * 864e5) / 1000), sub: "user-1" });
  // 模拟真实 auth.json：id_token/refresh_token 等大字段排在 access_token 之前，
  // 撑到 ~4.4KB，access_token 落在 2048 字节截断点之后。
  const fatFiller = "x".repeat(4200);
  const fullRaw = JSON.stringify({
    id_token: fatFiller,
    refresh_token: "r".repeat(200),
    tokens: { access_token: jwt },
    last_refresh: new Date(NOW).toISOString(),
    account_id: "acct-123",
  });
  assert.ok(fullRaw.length > 4300, "样本需接近真实 auth.json 体量（~4.4KB）");

  const truncatedAt2048 = fullRaw.slice(0, 2048);
  const truncatedAt16384 = fullRaw.slice(0, 16384);

  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: truncatedAt2048, now: NOW }).level,
    "unknown",
    "head -c 2048 截断把合法 JSON 切成非法片段，旧行为只能是 unknown",
  );
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: truncatedAt16384, now: NOW }).level,
    "ok",
    "放宽到 16384 后完整 JSON 未被截断，能正常解析出 exp",
  );
  assert.equal(
    parseAgentExpiry({ kind: "codex", raw: fullRaw, now: NOW }).level,
    "ok",
    "整读同样可解析",
  );
});
