// 代理口令的本机存储：真实临时目录里读写；写出去的文件必须是代理读得进来的那个形状。
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyProxyAuthorization, parseProxyAuthFile, PROXY_AUTH_TOKEN_RE } from "../proxy/auth.mjs";
import { createProxyAuthStore, generateProxyToken, PROXY_ROTATION_GRACE_MS, PROXY_TOKEN_LENGTH } from "./proxy-auth-store.mjs";

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-auth-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "runtime", "proxy-auth.json");
  const clock = { now: 1_700_000_000_000 };
  const store = createProxyAuthStore({ filePath, now: () => clock.now, ...options });
  const raw = () => JSON.parse(readFileSync(filePath, "utf8"));
  return { dir, filePath, clock, store, raw };
}

const basic = (credential) => `Basic ${Buffer.from(`${credential.user}:${credential.password}`).toString("base64")}`;

test("generateProxyToken：32 个 [A-Za-z0-9]（约 190 位），每个字符在 62 个里均匀", () => {
  const token = generateProxyToken();
  assert.equal(token.length, PROXY_TOKEN_LENGTH);
  assert.match(token, PROXY_AUTH_TOKEN_RE);
  assert.ok(PROXY_TOKEN_LENGTH * Math.log2(62) >= 128);
  assert.notEqual(generateProxyToken(), token);
  // 拒绝采样：248..255 的字节丢掉，不取模（否则前 8 个字符出现得略多）。
  // 255 / 250 / 248 丢弃；0 → A，61 → 9，62 → A（62 % 62 = 0），247 → 9（247 % 62 = 61）。
  const fed = generateProxyToken({ length: 4, randomBytesImpl: () => Buffer.from([255, 250, 248, 0, 61, 62, 247]) });
  assert.equal(fed, "A9A9");
  // 统计上看一眼：6200 个字符里每个字符的次数不该离 100 太远。
  const counts = new Map();
  for (const ch of generateProxyToken({ length: 6200 })) counts.set(ch, (counts.get(ch) || 0) + 1);
  assert.equal(counts.size, 62);
  for (const [ch, n] of counts) assert.ok(n > 40 && n < 180, `${ch}: ${n}`);
});

test("从没打开过：没有文件，就是关；不带口令、不该带口令", (t) => {
  const { store, filePath } = setup(t);
  assert.deepEqual(store.read(), { state: "missing", doc: null, reason: null });
  assert.deepEqual(store.getPublicState(), { mode: "off", hasToken: false, updatedAt: null, rotation: null, issue: null });
  assert.equal(store.getCredential(), null);
  assert.equal(store.getStoredCredential(), null);
  assert.equal(existsSync(filePath), false, "读不会把文件建出来");
});

test("第一次打开：生成口令、建文件（0600，目录不存在会自己建）；写出来的文件代理读得进来", (t) => {
  const { store, filePath, raw, clock } = setup(t);
  const result = store.setMode("observe");
  assert.equal(result.created, true);
  assert.equal(result.reset, false);
  const file = raw();
  assert.deepEqual(Object.keys(file), ["v", "mode", "user", "token", "updatedAt"]);
  assert.deepEqual({ v: file.v, mode: file.mode, user: file.user, updatedAt: file.updatedAt }, { v: 1, mode: "observe", user: "cwb", updatedAt: clock.now });
  assert.match(file.token, PROXY_AUTH_TOKEN_RE);
  if (process.platform !== "win32") assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(path.dirname(filePath)), ["proxy-auth.json"], "没有留下临时文件");

  const parsed = parseProxyAuthFile(readFileSync(filePath, "utf8"));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.policy.mode, "observe");
  assert.equal(classifyProxyAuthorization(parsed.policy, basic(store.getCredential()), clock.now), "ok", "控制面拿出来的口令正是代理认的那个");
});

test("改模式：口令不变；关掉时口令留着但不再对外给（关 = 一切照旧），再打开还是原来那个", (t) => {
  const { store, raw } = setup(t);
  store.setMode("observe");
  const token = raw().token;
  assert.equal(store.setMode("enforce").created, false);
  assert.equal(raw().token, token);
  assert.deepEqual(store.getCredential(), { user: "cwb", password: token });

  store.setMode("off");
  assert.equal(raw().token, token, "口令留在文件里");
  assert.equal(raw().mode, "off");
  assert.equal(store.getCredential(), null, "关着的时候探针与自测不带口令");
  assert.deepEqual(store.getStoredCredential(), { user: "cwb", password: token }, "但可以先写到集群再打开");
  assert.deepEqual(store.getPublicState().hasToken, true);

  store.setMode("observe");
  assert.equal(raw().token, token);
  assert.throws(() => store.setMode("strict"), { status: 400, code: "bad-mode" });
});

test("换口令：新口令立即生效，旧口令再接受 24 小时；过渡期内默认不让再换；可以提前结束过渡期", (t) => {
  const { store, raw, clock, filePath } = setup(t);
  assert.throws(() => store.rotate(), { status: 409, code: "no-token" });
  store.setMode("enforce");
  const first = raw().token;

  clock.now += 1000;
  store.rotate();
  const second = raw().token;
  assert.notEqual(second, first);
  assert.equal(raw().previousToken, first);
  assert.equal(raw().previousUntil, clock.now + PROXY_ROTATION_GRACE_MS);
  assert.deepEqual(store.getPublicState().rotation, { until: clock.now + PROXY_ROTATION_GRACE_MS });
  assert.deepEqual(store.getPreviousCredential(), { user: "cwb", password: first });
  const policy = parseProxyAuthFile(readFileSync(filePath, "utf8")).policy;
  assert.equal(classifyProxyAuthorization(policy, basic({ user: "cwb", password: first }), clock.now), "ok");
  assert.equal(classifyProxyAuthorization(policy, basic({ user: "cwb", password: second }), clock.now), "ok");

  // 过渡期内再换：仍在用第一个口令的程序会立刻断，默认拒绝。
  assert.throws(() => store.rotate(), (err) => err.status === 409 && err.code === "rotation-in-progress" && err.previousUntil === raw().previousUntil);
  store.rotate({ force: true });
  assert.equal(raw().previousToken, second);
  const third = raw().token;

  // 提前结束：上一个口令立刻作废。
  store.retirePrevious();
  assert.deepEqual(Object.keys(raw()), ["v", "mode", "user", "token", "updatedAt"]);
  assert.equal(raw().token, third);
  assert.equal(store.getPublicState().rotation, null);
});

test("过渡期自己到点：不用改文件旧口令就失效；下次写盘顺手把它清掉", (t) => {
  const { store, raw, clock } = setup(t);
  store.setMode("enforce");
  store.rotate();
  clock.now += PROXY_ROTATION_GRACE_MS;
  assert.equal(store.getPublicState().rotation, null);
  assert.equal(store.getPreviousCredential(), null);
  assert.ok(raw().previousToken, "文件里还留着，只是不再作数");
  store.rotate(); // 过渡期已过：可以直接再换
  assert.notEqual(raw().previousToken, undefined);
  store.setMode("observe");
  clock.now += PROXY_ROTATION_GRACE_MS;
  store.setMode("enforce");
  assert.equal(raw().previousToken, undefined, "过期的上一个口令随这次写盘清掉");
});

test("文件损坏：读作「有问题」并按关处理；再打开时重新生成口令并说明", (t) => {
  const { store, filePath, raw } = setup(t);
  store.setMode("enforce");
  const before = raw().token;
  writeFileSync(filePath, "{ half-written");
  assert.deepEqual(store.read(), { state: "invalid", doc: null, reason: "not-json" });
  assert.deepEqual(store.getPublicState(), { mode: "off", hasToken: false, updatedAt: null, rotation: null, issue: { state: "invalid", reason: "not-json" } });
  assert.equal(store.getCredential(), null);

  const result = store.setMode("observe");
  assert.deepEqual({ created: result.created, reset: result.reset }, { created: true, reset: true });
  assert.notEqual(raw().token, before, "原来的口令已经取不回来");
  assert.equal(store.getPublicState().issue, null);

  writeFileSync(filePath, JSON.stringify({ v: 1, mode: "enforce", user: "cwb", token: "short" }));
  assert.deepEqual(store.read(), { state: "invalid", doc: null, reason: "bad-token" });
  writeFileSync(filePath, JSON.stringify({ pad: "x".repeat(8192) }));
  assert.deepEqual(store.read(), { state: "invalid", doc: null, reason: "too-large" });
});

test("文件损坏：重新生成口令之前先把坏文件留档（0600、最多 2 份）并记一条不含口令的警告", (t) => {
  const logs = [];
  const { store, filePath, raw, clock } = setup(t, { log: (message, fields) => logs.push({ message, fields }) });
  const dir = path.dirname(filePath);
  const archives = () => readdirSync(dir).filter((name) => name.startsWith("proxy-auth.json.corrupt-")).sort();
  store.setMode("enforce");
  const original = raw().token;
  // 半截文件里还看得出原来的口令：留档就是为了这种时候还能找回来。
  const damaged = `{"v":1,"mode":"enforce","user":"cwb","token":"${original}"`;
  writeFileSync(filePath, damaged, { mode: 0o644 });

  const result = store.setMode("observe");
  assert.equal(result.reset, true);
  assert.notEqual(raw().token, original);
  assert.deepEqual(archives(), ["proxy-auth.json.corrupt-20231115-061320"]);
  const archived = path.join(dir, archives()[0]);
  assert.equal(readFileSync(archived, "utf8"), damaged, "留档是原样的坏文件");
  if (process.platform !== "win32") assert.equal(statSync(archived).mode & 0o777, 0o600);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].fields.level, "warn");
  assert.equal(logs[0].fields.event, "store-corrupt");
  assert.match(logs[0].message, /^代理口令（proxy-auth\.json）认不出（not-json），原文件已留档为 proxy-auth\.json\.corrupt-20231115-061320，重新生成口令$/);
  assert.equal(JSON.stringify(logs).includes(original), false, "日志里没有口令");

  // 形状不对（JSON 本身没坏）也一样：要整份盖掉之前先留档。关着时改模式同样会重写文件。
  for (const [i, body] of [JSON.stringify({ v: 1, mode: "enforce", user: "cwb", token: "short" }), "{", "["].entries()) {
    clock.now += 1000;
    writeFileSync(filePath, body);
    store.setMode(i === 0 ? "off" : "observe");
  }
  assert.equal(archives().length, 2, "同一个文件的留档最多 2 份");
  assert.match(logs[1].message, /认不出（bad-token），原文件已留档为 .+，按「关」重写$/);
  assert.equal(store.read().state, "ok");
});

test("文件读不出（权限）：不动任何设置，如实报错", { skip: process.platform === "win32" || process.getuid?.() === 0 ? "需要 POSIX 权限位且不是 root" : false }, (t) => {
  const { store, filePath } = setup(t);
  store.setMode("observe");
  chmodSync(filePath, 0o000);
  try {
    assert.equal(store.read().state, "unreadable");
    assert.equal(store.getPublicState().issue.state, "unreadable");
    assert.equal(store.getCredential(), null);
    assert.throws(() => store.setMode("enforce"), { status: 500, code: "proxy-auth-unreadable" });
    assert.throws(() => store.rotate(), { status: 500, code: "proxy-auth-unreadable" });
  } finally {
    chmodSync(filePath, 0o600); // 临时目录要删得掉
  }
  assert.equal(store.getPublicState().mode, "observe", "权限恢复后原来的设置还在，一个字没动");
});

test("按文件戳缓存：文件没变不重读；别处改了文件立刻看得到", (t) => {
  let reads = 0;
  const { store, filePath } = setup(t);
  store.setMode("observe");
  const fs = { statSync, readFileSync: (...args) => { reads += 1; return readFileSync(...args); } };
  const counted = createProxyAuthStore({ filePath, fs });
  for (let i = 0; i < 20; i += 1) counted.getCredential();
  assert.equal(reads, 1);
  // 另一个写入方（同一份文件的另一个存储实例）原子替换之后，文件戳变了，缓存失效。
  store.setMode("enforce");
  assert.equal(counted.getPublicState().mode, "enforce");
  assert.equal(reads, 2);
});

test("getPublicState 里没有口令：怎么序列化都漏不出来", (t) => {
  const { store, raw } = setup(t);
  store.setMode("enforce");
  store.rotate();
  const { token, previousToken } = raw();
  const dumped = JSON.stringify(store.getPublicState());
  assert.equal(dumped.includes(token), false);
  assert.equal(dumped.includes(previousToken), false);
});
