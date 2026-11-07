import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTH_OFF,
  buildAuthPolicy,
  classifyProxyAuthorization,
  CONNECT_AUTH_REQUIRED_RESPONSE,
  credentialDigest,
  parseProxyAuthFile,
  PROXY_AUTH_FILE_MAX_BYTES,
  PROXY_AUTH_REQUIRED_HEADERS,
  PROXY_AUTH_TOKEN_RE,
  PROXY_AUTH_USER,
  validateProxyAuthDocument,
} from "./auth.mjs";

// 测试用口令：形状合规、一眼看得出是假的。
const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const OLD_TOKEN = "OldTokenZZZZyyyyXXXXwwww98765432";
const doc = (extra = {}) => ({ v: 1, mode: "enforce", user: "cwb", token: TOKEN, updatedAt: 1000, ...extra });
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const policyOf = (extra) => buildAuthPolicy(validateProxyAuthDocument(doc(extra)).doc);

test("validateProxyAuthDocument：三种模式；关着可以没有口令，打开了必须有；用户名固定", () => {
  for (const mode of ["off", "observe", "enforce"]) {
    const checked = validateProxyAuthDocument(doc({ mode }));
    assert.equal(checked.ok, true, mode);
    assert.deepEqual(checked.doc, { v: 1, mode, user: "cwb", token: TOKEN, previousToken: null, previousUntil: 0, updatedAt: 1000 });
  }
  assert.equal(validateProxyAuthDocument({ v: 1, mode: "off", user: "cwb" }).ok, true, "从没打开过：没有口令也合法");
  assert.deepEqual(validateProxyAuthDocument({ v: 1, mode: "observe", user: "cwb" }), { ok: false, reason: "bad-token" });
  assert.deepEqual(validateProxyAuthDocument(doc({ user: "root" })), { ok: false, reason: "bad-user" });
  assert.deepEqual(validateProxyAuthDocument(doc({ mode: "strict" })), { ok: false, reason: "bad-mode" });
  assert.deepEqual(validateProxyAuthDocument(doc({ v: 2 })), { ok: false, reason: "bad-version" });
  for (const value of [null, [], "x", 3]) assert.deepEqual(validateProxyAuthDocument(value), { ok: false, reason: "not-object" });
});

test("口令形状：只收 [A-Za-z0-9]，不少于 22 个字符（≥128 位）", () => {
  assert.equal(PROXY_AUTH_TOKEN_RE.test("a".repeat(22)), true);
  assert.ok(22 * Math.log2(62) >= 128, "22 个字符的下限确实不少于 128 位");
  for (const bad of ["a".repeat(21), `${"a".repeat(22)}:`, `${"a".repeat(22)}@`, `${"a".repeat(21)} `, "a".repeat(129), 12345, ""]) {
    assert.deepEqual(validateProxyAuthDocument(doc({ token: bad })), { ok: false, reason: "bad-token" }, String(bad));
  }
});

test("上一个口令：要有截止时刻；形状不对整份不认", () => {
  const ok = validateProxyAuthDocument(doc({ previousToken: OLD_TOKEN, previousUntil: 5000 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.doc.previousToken, OLD_TOKEN);
  assert.equal(ok.doc.previousUntil, 5000);
  assert.deepEqual(validateProxyAuthDocument(doc({ previousToken: OLD_TOKEN })), { ok: false, reason: "bad-previous" });
  assert.deepEqual(validateProxyAuthDocument(doc({ previousToken: "short", previousUntil: 5000 })), { ok: false, reason: "bad-previous" });
  assert.deepEqual(validateProxyAuthDocument(doc({ previousToken: OLD_TOKEN, previousUntil: "soon" })), { ok: false, reason: "bad-previous" });
});

test("buildAuthPolicy：策略里只有摘要，没有口令原文；off / 没有口令 → AUTH_OFF", () => {
  const policy = policyOf({ previousToken: OLD_TOKEN, previousUntil: 5000 });
  assert.equal(policy.mode, "enforce");
  assert.ok(Buffer.isBuffer(policy.current) && policy.current.length === 32);
  assert.deepEqual(policy.current, credentialDigest("cwb", TOKEN));
  assert.deepEqual(policy.previous, credentialDigest("cwb", OLD_TOKEN));
  // 把策略对象怎么序列化、怎么拼字符串，都漏不出原文。
  const dumped = `${JSON.stringify(policy)} ${Object.values(policy).map(String).join(" ")}`;
  assert.equal(dumped.includes(TOKEN), false);
  assert.equal(dumped.includes(OLD_TOKEN), false);
  assert.equal(Object.isFrozen(policy), true);

  assert.equal(policyOf({ mode: "off" }), AUTH_OFF);
  assert.equal(buildAuthPolicy(null), AUTH_OFF);
  assert.equal(AUTH_OFF.mode, "off");
});

test("parseProxyAuthFile：坏文件只给固定代号，绝不回显内容", () => {
  assert.equal(parseProxyAuthFile(JSON.stringify(doc())).ok, true);
  assert.deepEqual(parseProxyAuthFile("{ half-written"), { ok: false, reason: "not-json" });
  assert.deepEqual(parseProxyAuthFile(""), { ok: false, reason: "not-json" });
  assert.deepEqual(parseProxyAuthFile("[]"), { ok: false, reason: "not-object" });
  assert.deepEqual(parseProxyAuthFile(JSON.stringify(doc({ token: "x" }))), { ok: false, reason: "bad-token" });
  const huge = JSON.stringify(doc({ pad: "x".repeat(PROXY_AUTH_FILE_MAX_BYTES) }));
  assert.deepEqual(parseProxyAuthFile(huge), { ok: false, reason: "too-large" });
  // 认不得的多余字段不影响解析（以后加字段不用两边同时升级）。
  assert.equal(parseProxyAuthFile(JSON.stringify(doc({ note: "future field" }))).ok, true);
});

test("classifyProxyAuthorization：带对 / 没带 / 带错", () => {
  const policy = policyOf();
  assert.equal(classifyProxyAuthorization(policy, basic("cwb", TOKEN), 0), "ok");
  assert.equal(classifyProxyAuthorization(policy, `basic   ${Buffer.from(`cwb:${TOKEN}`).toString("base64")}`, 0), "ok", "方案名不分大小写，中间空白随意");
  assert.equal(classifyProxyAuthorization(policy, `Basic ${Buffer.from(`cwb:${TOKEN}`).toString("base64url")}`, 0), "ok", "base64url 字母表也认");

  for (const absent of [undefined, null, "", "   ", 42, ["Basic x"]]) {
    assert.equal(classifyProxyAuthorization(policy, absent, 0), "missing", JSON.stringify(absent));
  }

  const wrong = [
    basic("cwb", `${TOKEN}x`),
    basic("cwb", TOKEN.slice(0, -1)),
    basic("cwb", TOKEN.toLowerCase()),
    basic("CWB", TOKEN),
    basic("other", TOKEN),
    basic("", TOKEN),
    `Basic ${Buffer.from(TOKEN).toString("base64")}`,
    `Bearer ${TOKEN}`,
    `Basic`,
    `Basic !!!not-base64!!!`,
    `Basic ${"A".repeat(2000)}`,
    `Digest username="cwb"`,
  ];
  for (const value of wrong) assert.equal(classifyProxyAuthorization(policy, value, 0), "bad", value.slice(0, 40));
});

test("上一个口令只在截止时刻之前接受；过期后与任何错口令一样", () => {
  const policy = policyOf({ previousToken: OLD_TOKEN, previousUntil: 5000 });
  assert.equal(classifyProxyAuthorization(policy, basic("cwb", OLD_TOKEN), 4999), "ok");
  assert.equal(classifyProxyAuthorization(policy, basic("cwb", OLD_TOKEN), 5000), "bad", "到点即失效");
  assert.equal(classifyProxyAuthorization(policy, basic("cwb", OLD_TOKEN), 9e12), "bad");
  assert.equal(classifyProxyAuthorization(policy, basic("cwb", TOKEN), 9e12), "ok", "当前口令不受过渡期影响");
  // 没有上一个口令时，谁也冒充不了它。
  assert.equal(classifyProxyAuthorization(policyOf(), basic("cwb", OLD_TOKEN), 0), "bad");
});

test("407 应答：CONNECT 的裸应答与明文转发的响应头都带 Basic 质询，除此之外没有任何可区分的信息", () => {
  assert.equal(
    CONNECT_AUTH_REQUIRED_RESPONSE,
    'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="cluster-workbench"\r\nContent-Length: 0\r\n\r\n',
  );
  assert.deepEqual(PROXY_AUTH_REQUIRED_HEADERS, { "proxy-authenticate": 'Basic realm="cluster-workbench"' });
  assert.equal(PROXY_AUTH_USER, "cwb");
});

test("判定跑在每个请求的处理路径上，永不抛错：手搓的残缺策略对象一律按「谁也对不上」", () => {
  for (const broken of [{ mode: "enforce" }, { mode: "enforce", current: Buffer.from("short"), previous: "nope", previousUntil: 9e12 }, { mode: "enforce", current: null, previous: null }, null, undefined]) {
    assert.equal(classifyProxyAuthorization(broken, basic("cwb", TOKEN), 0), "bad");
    assert.equal(classifyProxyAuthorization(broken, undefined, 0), "missing");
  }
});

// 源码级守卫：判定必须是常数时间比较，且代理这一侧不留口令原文。
test("源码：比较只用 timingSafeEqual；策略对象不保存 token 原文", () => {
  const source = readFileSync(new URL("./auth.mjs", import.meta.url), "utf8");
  const classify = source.slice(source.indexOf("export function classifyProxyAuthorization"));
  assert.match(classify, /timingSafeEqual\(digest, digestOrNever\(auth\?\.current\)\)/);
  assert.match(classify, /timingSafeEqual\(digest, digestOrNever\(auth\?\.previous\)\)/);
  assert.doesNotMatch(classify, /===\s*auth\.|auth\.\w+\s*===|\.equals\(|indexOf|startsWith|localeCompare/, "不出现会提前返回的逐字节比较");
  const build = source.slice(source.indexOf("export function buildAuthPolicy"), source.indexOf("export function parseProxyAuthFile"));
  assert.doesNotMatch(build, /token:\s*doc\.token|previousToken:\s*doc\.previousToken/, "策略里不放原文");
});
