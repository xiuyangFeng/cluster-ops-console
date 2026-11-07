// 出网健康：connect-fail 行解析 / 分类 / 窗口淘汰 / 状态判定是纯函数；服务用假的 connect、假的生效方式与假时钟，
// 一个真实连接都不发（假 connect 只回一个事件对象）。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { COMPONENT_ENTRIES, listImportClosure } from "../component-version.mjs";
import {
  classifyConnectFailReason,
  createEgressHealth,
  createFailureWindow,
  decideEgressState,
  EGRESS_EFFECTIVE_TTL_MS,
  EGRESS_FAILURE_CAP,
  EGRESS_FAILURE_WINDOW_MS,
  parseConnectFailMessage,
  parseUpstreamAuthority,
  probeTcp,
} from "./egress-health.mjs";

// 保活：probeTcp / 服务里的超时定时器都是 unref 的（不挡进程退出），假 socket 也不占事件循环——用例在等
// 「上游一直不回应」的超时那几十毫秒里，事件循环是空的。Node 22.12 的测试运行器见到「Promise 未决而事件循环
// 已空」会把整个文件取消（后面的用例跟着全红，CI 的 22.12 任务曾因此红了几天），较新的 Node 不会。
// 整个文件跑完再清掉。
const keepAlive = setInterval(() => {}, 60_000);
after(() => clearInterval(keepAlive));

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const T0 = 1_800_000_000_000;
const MIN = 60_000;

const upstreamLine = (host, reason, { port = 443, ms = 12 } = {}) => `[proxy] connect-fail host=${host} port=${port} reason=${reason} ms=${ms} via=upstream`;
const directLine = (host, reason, { port = 443, ms = 12 } = {}) => `[proxy] connect-fail host=${host} port=${port} reason=${reason} ms=${ms} via=direct`;

// 假 connect：behavior 为 "ok" / "hang" / errno 码，或 (opts, n) → 其中之一。返回的 socket 只是事件对象。
function fakeConnect(behavior = "ok") {
  const calls = [];
  const connect = (opts) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.writes = [];
    socket.destroy = () => {
      socket.destroyed = true;
    };
    socket.write = (chunk) => {
      socket.writes.push(chunk);
      return true;
    };
    calls.push({ opts, socket });
    const outcome = typeof behavior === "function" ? behavior(opts, calls.length) : behavior;
    if (outcome === "ok") queueMicrotask(() => socket.emit("connect"));
    else if (outcome !== "hang") queueMicrotask(() => socket.emit("error", Object.assign(new Error(`connect ${outcome} 127.0.0.1:7897`), { code: outcome })));
    return socket;
  };
  return { connect, calls };
}

const MANUAL = Object.freeze({ running: true, supportsEgress: true, mode: "manual", upstream: "127.0.0.1:7897" });
const DIRECT = Object.freeze({ running: true, supportsEgress: true, mode: "direct", upstream: null });

function harness({ effective = MANUAL, behavior = "ok", fixtureMode = false, timeoutMs = 50, intervalMs = 3_600_000 } = {}) {
  const clock = { now: T0 };
  const state = { effective, resolves: 0, logs: [] };
  const fake = fakeConnect(behavior);
  const health = createEgressHealth({
    resolveEffective: async () => {
      state.resolves += 1;
      if (state.effective instanceof Error) throw state.effective;
      return state.effective;
    },
    connect: fake.connect,
    now: () => clock.now,
    intervalMs,
    timeoutMs,
    fixtureMode,
    log: (line) => state.logs.push(line),
  });
  return { health, clock, state, calls: fake.calls };
}

test("parseConnectFailMessage：两种 via 的 connect-fail 行 → host / port / reason / 分类；不留原始消息", () => {
  assert.deepEqual(parseConnectFailMessage(upstreamLine("api.openai.com", "upstream-refused")), { host: "api.openai.com", port: 443, reason: "upstream-refused", via: "upstream", cls: "refused" });
  assert.deepEqual(parseConnectFailMessage(upstreamLine("Chatgpt.COM", "upstream-rejected-502")), { host: "chatgpt.com", port: 443, reason: "upstream-rejected-502", via: "upstream", cls: "rejected" }, "host 按使用记录的键规则小写");
  assert.deepEqual(parseConnectFailMessage(directLine("github.com", "ECONNREFUSED", { port: 22 })), { host: "github.com", port: 22, reason: "ECONNREFUSED", via: "direct", cls: "refused" });
  assert.deepEqual(parseConnectFailMessage(directLine("github.com", "timeout")), { host: "github.com", port: 443, reason: "timeout", via: "direct", cls: "timeout" });
  assert.equal(parseConnectFailMessage(directLine("github.com", "ENOTFOUND")).cls, "other");
  assert.equal(parseConnectFailMessage(upstreamLine("x.example.com", "upstream-econnreset")).cls, "other");
  // IPv6 字面量：与使用记录同形，带中括号。
  assert.equal(parseConnectFailMessage(directLine("2001:db8::1", "ECONNREFUSED")).host, "[2001:db8::1]");
  // stderr 转写的前缀也认。
  assert.equal(parseConnectFailMessage(`[proxy:err] ${upstreamLine("a.example.com", "upstream-timeout").slice(8)}`).cls, "timeout");
  const parsed = parseConnectFailMessage(upstreamLine("api.openai.com", "upstream-refused", { ms: 987654 }));
  assert.deepEqual(Object.keys(parsed).sort(), ["cls", "host", "port", "reason", "via"]);
  assert.equal(JSON.stringify(parsed).includes("987654"), false, "ms 等原始字段不保留");
});

test("parseConnectFailMessage：不是 connect-fail 行 → null；字段不合规 → 计入 other，host 不合规为 null", () => {
  for (const line of [
    "[proxy] connect host=a.example.com port=443 dnsMs=1 tcpMs=2 cached=0 via=direct",
    "[proxy] connect-deny host=a.example.com port=443",
    "connect-fail host=a.example.com port=443 reason=timeout ms=1 via=direct", // 没有 supervisor 前缀
    "tunnel up",
    "",
    null,
    42,
    `[proxy] connect-fail host=${"a".repeat(3000)} port=443 reason=timeout ms=1 via=direct`,
  ]) {
    assert.equal(parseConnectFailMessage(line), null, String(line).slice(0, 60));
  }
  assert.deepEqual(parseConnectFailMessage(upstreamLine('evil"<script>', "upstream-refused")), { host: null, port: null, reason: "upstream-refused", via: "upstream", cls: "other" });
  assert.deepEqual(parseConnectFailMessage(upstreamLine("a.example.com", "upstream-refused", { port: 70000 })), { host: null, port: null, reason: "upstream-refused", via: "upstream", cls: "other" });
  assert.equal(parseConnectFailMessage(upstreamLine("a.example.com", "bad;reason")).reason, null);
  assert.equal(parseConnectFailMessage(upstreamLine("a.example.com", "bad;reason")).cls, "other");
  assert.equal(parseConnectFailMessage("[proxy] connect-fail host=a.example.com port=443 reason=upstream-refused ms=3").cls, "other", "没有 via");
  assert.equal(parseConnectFailMessage("[proxy] connect-fail host=a.example.com port=443 reason=upstream-refused ms=3 via=sideways").cls, "other");
  assert.equal(parseConnectFailMessage("[proxy] connect-fail host=a.example.com port=443 reason=upstream-refused via=upstream").cls, "other", "没有 ms");
});

test("classifyConnectFailReason：四类；ECONNREFUSED / timeout 只在直连下算 refused / timeout", () => {
  const table = [
    ["upstream-refused", "upstream", "refused"],
    ["upstream-timeout", "upstream", "timeout"],
    ["upstream-rejected-403", "upstream", "rejected"],
    ["upstream-rejected-0", "upstream", "rejected"],
    ["upstream-bad-response", "upstream", "other"],
    ["upstream-loop", "upstream", "other"],
    ["upstream-econnreset", "upstream", "other"],
    ["ECONNREFUSED", "direct", "refused"],
    ["timeout", "direct", "timeout"],
    ["ETIMEDOUT", "direct", "timeout"],
    ["ECONNREFUSED", "upstream", "other"],
    ["EHOSTUNREACH", "direct", "other"],
    ["error", "direct", "other"],
    [null, "direct", "other"],
  ];
  for (const [reason, via, expected] of table) assert.equal(classifyConnectFailReason(reason, via), expected, `${reason}/${via}`);
});

test("失败窗口：10 分钟淘汰、按 ts 记（旧行不算刚发生的）、乱序插入、计数 / 最近一次 / 前 5 个 host", () => {
  const window = createFailureWindow();
  const add = (line, at, now = T0) => window.add(parseConnectFailMessage(line), at, now);
  assert.equal(add(upstreamLine("old.example.com", "upstream-refused"), T0 - EGRESS_FAILURE_WINDOW_MS), false, "窗口之外的旧行不收");
  for (let i = 0; i < 7; i += 1) add(upstreamLine(`h${i}.example.com`, "upstream-timeout"), T0 - 9 * MIN + i);
  add(upstreamLine("h0.example.com", "upstream-rejected-502"), T0 - 8 * MIN);
  add(upstreamLine("h0.example.com", "upstream-refused"), T0 - 30_000);
  add(upstreamLine("h1.example.com", "upstream-refused"), T0 - 60_000); // 乱序到达
  add(upstreamLine('bad"host', "upstream-refused"), T0 - 70_000);
  add(directLine("future.example.com", "ECONNREFUSED"), T0 + 5 * MIN); // 时钟差：按现在记
  let summary = window.summarize(T0);
  assert.equal(summary.total, 12);
  assert.deepEqual([summary.refused, summary.timeout, summary.rejected, summary.other], [3, 7, 1, 1], "不合规的那行算 other");
  assert.deepEqual(summary.last, { host: "future.example.com", port: 443, reason: "ECONNREFUSED", at: T0 });
  assert.deepEqual(summary.topHosts, [
    { host: "h0.example.com", count: 3 },
    { host: "h1.example.com", count: 2 },
    { host: "future.example.com", count: 1 },
    { host: "h6.example.com", count: 1 },
    { host: "h5.example.com", count: 1 },
  ], "按次数，同次数按最近；不合规的 host 不进排名；最多 5 个");
  assert.equal(summary.recentRefused, 3, "近 2 分钟的 refused：h0、h1、future（不合规那行算 other）");
  assert.equal(summary.recentRefusedViaUpstream, 2);
  // 9 分钟前那批在 1 分钟后滑出窗口。
  summary = window.summarize(T0 + MIN + 10);
  assert.equal(summary.total, 5);
  assert.equal(summary.timeout, 0);
  assert.equal(window.size(), 5);
});

test("失败窗口：有界——超过上限丢最旧的", () => {
  const window = createFailureWindow();
  const failure = parseConnectFailMessage(directLine("a.example.com", "timeout"));
  for (let i = 0; i < EGRESS_FAILURE_CAP + 50; i += 1) window.add(failure, T0 - 5 * MIN + i, T0);
  assert.equal(window.size(), EGRESS_FAILURE_CAP);
  assert.equal(window.summarize(T0).total, EGRESS_FAILURE_CAP);
});

test("decideEgressState：unknown / error（连续两次才判）/ warn / ok 与 reason", () => {
  const none = { total: 0, recentRefused: 0, recentRefusedViaUpstream: 0 };
  const ok = { ok: true, ms: 1, at: T0, error: null };
  const refused = { ok: false, ms: null, at: T0, error: "ECONNREFUSED" };
  const timeout = { ok: false, ms: null, at: T0, error: "timeout" };
  const base = { effective: MANUAL, checkApplicable: true, check: ok, consecutiveCheckFailures: 0, failures: none };
  const decide = (patch) => decideEgressState({ ...base, ...patch });
  assert.deepEqual(decide({}), { state: "ok", reason: null });
  assert.deepEqual(decide({ fixtureMode: true }), { state: "unknown", reason: null });
  assert.deepEqual(decide({ effective: null }), { state: "unknown", reason: null }, "还没有结果");
  assert.deepEqual(decide({ effective: { ...MANUAL, running: false } }), { state: "unknown", reason: "proxy-down" });
  assert.deepEqual(decide({ check: null }), { state: "unknown", reason: null }, "该探测但还没探过");
  assert.deepEqual(decide({ check: refused, consecutiveCheckFailures: 1 }), { state: "ok", reason: null }, "一次失败不判");
  assert.deepEqual(decide({ check: refused, consecutiveCheckFailures: 2 }), { state: "error", reason: "upstream-refused" });
  assert.deepEqual(decide({ check: timeout, consecutiveCheckFailures: 3 }), { state: "error", reason: "upstream-timeout" });
  assert.deepEqual(decide({ failures: { total: 3, recentRefused: 3, recentRefusedViaUpstream: 3 } }), { state: "error", reason: "upstream-refused" });
  assert.deepEqual(decide({ failures: { total: 3, recentRefused: 3, recentRefusedViaUpstream: 1 } }), { state: "warn", reason: "target-failures" }, "经上游的拒连不到 3 次");
  assert.deepEqual(decide({ failures: { total: 3, recentRefused: 2, recentRefusedViaUpstream: 2 } }), { state: "warn", reason: "target-failures" });
  assert.deepEqual(decide({ failures: { total: 2, recentRefused: 0, recentRefusedViaUpstream: 0 } }), { state: "ok", reason: null });
  // direct：不适用主动探测；被动统计照常判。
  const direct = { effective: DIRECT, checkApplicable: false, check: null };
  assert.deepEqual(decide({ ...direct }), { state: "ok", reason: null });
  assert.deepEqual(decide({ ...direct, failures: { total: 4, recentRefused: 0, recentRefusedViaUpstream: 0 } }), { state: "warn", reason: "target-failures" });
  assert.deepEqual(decide({ ...direct, failures: { total: 3, recentRefused: 3, recentRefusedViaUpstream: 0 } }), { state: "warn", reason: "target-failures" }, "直连下目标拒连只是目标不收，不算出网中断");
  // 代理不在跑时，失败再多也是 unknown（是代理的事，不是出网的事）。
  assert.deepEqual(decide({ effective: { ...MANUAL, running: false }, failures: { total: 9, recentRefused: 9, recentRefusedViaUpstream: 9 } }), { state: "unknown", reason: "proxy-down" });
});

test("parseUpstreamAuthority：host:port / [IPv6]:port；不合规 → null", () => {
  assert.deepEqual(parseUpstreamAuthority("127.0.0.1:7897"), { host: "127.0.0.1", port: 7897 });
  assert.deepEqual(parseUpstreamAuthority("[::1]:7890"), { host: "::1", port: 7890 });
  for (const bad of [null, "", "7897", ":7897", "host:0", "host:65536", "host:x"]) assert.equal(parseUpstreamAuthority(bad), null, String(bad));
});

test("probeTcp：连上立刻断开、一个字节都不写；拒连给短码；超时给 timeout；connect 同步抛错也接住", async () => {
  const ok = fakeConnect("ok");
  const result = await probeTcp({ connect: ok.connect, host: "127.0.0.1", port: 7897, timeoutMs: 1000 });
  assert.equal(result.ok, true);
  assert.equal(typeof result.ms, "number");
  assert.equal(result.error, null);
  assert.deepEqual(ok.calls[0].opts, { host: "127.0.0.1", port: 7897 });
  assert.equal(ok.calls[0].socket.destroyed, true);
  assert.deepEqual(ok.calls[0].socket.writes, []);
  // 连上之后对端又报错：不抛未捕获异常。
  ok.calls[0].socket.emit("error", new Error("late reset"));

  const refused = fakeConnect("ECONNREFUSED");
  assert.deepEqual(await probeTcp({ connect: refused.connect, host: "127.0.0.1", port: 7897, timeoutMs: 1000 }), { ok: false, ms: null, error: "ECONNREFUSED" });
  assert.equal(refused.calls[0].socket.destroyed, true);

  const hang = fakeConnect("hang");
  assert.deepEqual(await probeTcp({ connect: hang.connect, host: "127.0.0.1", port: 7897, timeoutMs: 20 }), { ok: false, ms: null, error: "timeout" });
  assert.equal(hang.calls[0].socket.destroyed, true);

  const weird = fakeConnect("bad code with spaces");
  assert.equal((await probeTcp({ connect: weird.connect, host: "h", port: 1, timeoutMs: 1000 })).error, "error", "错误只留合规的短码");
  const throws = await probeTcp({ connect: () => { throw Object.assign(new Error("boom"), { code: "ERR_INVALID_ARG_VALUE" }); }, host: "h", port: 1, timeoutMs: 1000 });
  assert.deepEqual(throws, { ok: false, ms: null, error: "ERR_INVALID_ARG_VALUE" });
});

test("服务：manual 下对上游做一次 TCP 连接；快照形状与契约一致", async () => {
  const h = harness();
  assert.equal(h.health.snapshot().state, "unknown", "还没跑过");
  assert.equal(h.health.snapshot().checkedAt, null);
  const snap = await h.health.checkNow();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].opts, { host: "127.0.0.1", port: 7897 });
  assert.deepEqual(h.calls[0].socket.writes, []);
  assert.equal(h.calls[0].socket.destroyed, true);
  assert.deepEqual(Object.keys(snap), ["mode", "upstream", "state", "reason", "check", "failures", "checkedAt"]);
  assert.deepEqual(snap, {
    mode: "manual",
    upstream: "127.0.0.1:7897",
    state: "ok",
    reason: null,
    check: { ok: true, ms: 0, at: T0, error: null },
    failures: { windowMs: 600000, total: 0, refused: 0, timeout: 0, rejected: 0, other: 0, last: null, topHosts: [] },
    checkedAt: T0,
  });
});

test("服务：生效方式沿用 60 秒；探测失败时下一轮重读；连续两次失败才判 error", async () => {
  const h = harness();
  await h.health.checkNow();
  h.clock.now += 30_000;
  await h.health.checkNow();
  assert.equal(h.state.resolves, 1, "60 秒内不重读 /proxy-health");
  h.clock.now += EGRESS_EFFECTIVE_TTL_MS;
  await h.health.checkNow();
  assert.equal(h.state.resolves, 2);

  // Clash 退出：第一次失败不判，第二次判 error；每次失败后下一轮都重读一次生效方式。
  let upstream = "ok";
  const down = harness({ behavior: () => upstream });
  await down.health.checkNow();
  upstream = "ECONNREFUSED";
  down.clock.now += 30_000;
  let snap = await down.health.checkNow();
  assert.equal(snap.state, "ok");
  assert.deepEqual(snap.check, { ok: false, ms: null, at: T0 + 30_000, error: "ECONNREFUSED" });
  down.clock.now += 30_000;
  snap = await down.health.checkNow();
  assert.deepEqual([snap.state, snap.reason], ["error", "upstream-refused"]);
  assert.equal(down.state.resolves, 2, "失败之后重读了一次");
  assert.deepEqual(down.state.logs, ["egress health: error (upstream-refused)"], "判定变化才记一行（只有状态与原因）");
  // 恢复：一次成功就回 ok。
  upstream = "ok";
  down.clock.now += 30_000;
  snap = await down.health.checkNow();
  assert.deepEqual([snap.state, snap.check.ok], ["ok", true]);
  assert.deepEqual(down.state.logs, ["egress health: error (upstream-refused)", "egress health: ok"]);
});

test("服务：上游一直不回应 → 超时；两次后 error upstream-timeout", async () => {
  const h = harness({ behavior: "hang", timeoutMs: 15 });
  await h.health.checkNow();
  h.clock.now += 30_000;
  const snap = await h.health.checkNow();
  assert.deepEqual([snap.state, snap.reason, snap.check.error], ["error", "upstream-timeout", "timeout"]);
});

test("服务：换了上游（刚改完设置）连续失败重新计；切到 direct 不再探测", async () => {
  const h = harness({ behavior: "ECONNREFUSED" });
  await h.health.checkNow();
  h.state.effective = { ...MANUAL, upstream: "127.0.0.1:7890" };
  h.clock.now += 30_000;
  let snap = await h.health.checkNow();
  assert.equal(h.calls.at(-1).opts.port, 7890, "失败后重读，拿到了新上游");
  assert.equal(snap.state, "ok", "新上游只失败了一次");
  h.state.effective = DIRECT;
  h.clock.now += 30_000;
  const before = h.calls.length;
  snap = await h.health.checkNow();
  assert.equal(h.calls.length, before, "direct 不探测");
  assert.deepEqual([snap.mode, snap.upstream, snap.check, snap.state], ["direct", null, null, "ok"]);
});

test("服务：direct / 系统代理未识别 / 旧版代理不探测；被动失败 ≥ 3 → warn", async () => {
  for (const effective of [DIRECT, { ...MANUAL, mode: "system", upstream: null }, { running: true, supportsEgress: false, mode: null, upstream: null }]) {
    const h = harness({ effective });
    await h.health.checkNow();
    assert.equal(h.calls.length, 0, JSON.stringify(effective));
    assert.equal(h.health.snapshot().check, null);
    assert.equal(h.health.snapshot().state, "ok");
  }
  const h = harness({ effective: DIRECT });
  await h.health.checkNow();
  for (const host of ["github.com", "github.com", "pypi.org"]) h.health.noteSupervisorMessage(directLine(host, "ENOTFOUND"), T0 - MIN);
  const snap = h.health.snapshot();
  assert.deepEqual([snap.state, snap.reason], ["warn", "target-failures"]);
  assert.deepEqual(snap.failures.topHosts, [{ host: "github.com", count: 2 }, { host: "pypi.org", count: 1 }]);
  assert.equal(snap.mode, "direct");
});

test("服务：manual 下近 2 分钟经上游拒连 ≥ 3 → error（不用等两轮主动探测）；10 分钟后淘汰回 ok", async () => {
  const h = harness();
  await h.health.checkNow();
  for (let i = 0; i < 3; i += 1) h.health.noteSupervisorMessage(upstreamLine("api.openai.com", "upstream-refused"), T0 - 10_000 + i);
  let snap = h.health.snapshot();
  assert.deepEqual([snap.state, snap.reason], ["error", "upstream-refused"]);
  assert.deepEqual(snap.failures.last, { host: "api.openai.com", port: 443, reason: "upstream-refused", at: T0 - 10_000 + 2 });
  h.clock.now += 3 * MIN;
  snap = h.health.snapshot();
  assert.deepEqual([snap.state, snap.reason], ["warn", "target-failures"], "过了 2 分钟只剩 10 分钟窗口的那条规则");
  h.clock.now += 8 * MIN;
  snap = h.health.snapshot();
  assert.deepEqual([snap.state, snap.failures.total, snap.failures.last], ["ok", 0, null]);
});

test("服务：刚启动读回的旧失败行按它们自己的 ts 算，不当成刚发生的；快照里没有原始消息", async () => {
  const h = harness();
  await h.health.checkNow();
  const secretish = "upstream-refused";
  for (let i = 0; i < 5; i += 1) h.health.noteSupervisorMessage(upstreamLine("old.example.com", secretish, { ms: 424242 }), T0 - 20 * MIN);
  h.health.noteSupervisorMessage("[proxy] connect host=a.example.com port=443 dnsMs=1 tcpMs=2 cached=0 via=upstream", T0);
  h.health.noteSupervisorMessage("tunnel up", T0);
  h.health.noteSupervisorMessage(undefined, undefined);
  let snap = h.health.snapshot();
  assert.equal(snap.failures.total, 0);
  assert.equal(snap.state, "ok");
  h.health.noteSupervisorMessage(upstreamLine("new.example.com", "upstream-rejected-503", { ms: 424242 }), Number.NaN); // 没有 ts：按现在
  snap = h.health.snapshot();
  assert.equal(snap.failures.rejected, 1);
  assert.equal(snap.failures.last.at, T0);
  const text = JSON.stringify(snap);
  assert.equal(text.includes("424242"), false);
  assert.equal(text.includes("connect-fail"), false);
  assert.equal(text.includes("via="), false);
});

test("服务：代理没在运行 → unknown proxy-down，不探测；读生效方式出错 → 还是 unknown，不抛", async () => {
  const h = harness({ effective: { running: false, supportsEgress: false, mode: null, upstream: null } });
  const snap = await h.health.checkNow();
  assert.equal(h.calls.length, 0);
  assert.deepEqual([snap.state, snap.reason, snap.mode, snap.upstream, snap.check], ["unknown", "proxy-down", null, null, null]);
  const broken = harness({ effective: new Error("config unreadable") });
  const brokenSnap = await broken.health.checkNow();
  assert.deepEqual([brokenSnap.state, brokenSnap.reason], ["unknown", null]);
  broken.clock.now += 1000;
  await broken.health.checkNow();
  assert.equal(broken.state.resolves, 2, "没读出来不缓存，下一轮再读");
});

test("服务：同一时刻只有一轮在途；start 立即跑一轮、定时器不挡进程退出、stop 后不再跑", async () => {
  const h = harness({ behavior: "hang", timeoutMs: 30 });
  const [a, b] = await Promise.all([h.health.checkNow(), h.health.checkNow()]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(a, b);
  const s = harness({ intervalMs: 5 });
  s.health.start();
  s.health.start(); // 重复调用不多起一个定时器
  await new Promise((resolve) => setTimeout(resolve, 40));
  s.health.stop();
  const rounds = s.calls.length;
  assert.ok(rounds >= 2, `定时器跑起来了（${rounds} 轮）`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(s.calls.length, rounds, "stop 之后不再探测");
});

test("服务：fixture 模式不调 connect、不读生效方式；快照恒为 unknown、mode null", async () => {
  const h = harness({ fixtureMode: true, intervalMs: 5 });
  h.health.start();
  const snap = await h.health.checkNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  h.health.stop();
  h.health.noteSupervisorMessage(upstreamLine("api.openai.com", "upstream-refused"), T0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state.resolves, 0);
  for (const value of [snap, h.health.snapshot()]) {
    assert.deepEqual(value, {
      mode: null,
      upstream: null,
      state: "unknown",
      reason: null,
      check: null,
      failures: { windowMs: 600000, total: 0, refused: 0, timeout: 0, rejected: 0, other: 0, last: null, topHosts: [] },
      checkedAt: null,
    });
  }
});

test("指纹闭包：出网健康只属于控制面，不进本机代理 / supervisor 的闭包", async () => {
  for (const [name, entry] of Object.entries(COMPONENT_ENTRIES)) {
    const closure = await listImportClosure(APP_ROOT, entry);
    assert.ok(closure.length > 5, name);
    assert.equal(closure.includes("work/monitor/lib/egress/egress-health.mjs"), false, name);
    assert.deepEqual(closure.filter((file) => file.includes("/egress/")), [], `${name} 的闭包里不该有 lib/egress/`);
  }
});

test("服务：代理没在运行的结果不缓存，下一轮就重读（不等 60 秒的缓存期）", async () => {
  const h = harness({ effective: { ...MANUAL, running: false } });
  await h.health.checkNow();
  assert.equal(h.health.snapshot().state, "unknown");
  h.state.effective = MANUAL;
  h.clock.now += 30_000; // 远不到 60 秒的缓存期
  await h.health.checkNow();
  assert.equal(h.state.resolves, 2, "没在运行的结果不缓存");
  assert.equal(h.health.snapshot().state, "ok");
});

test("服务：从手动切到直连后，窗口里残留的「经上游被拒」不把直连判成中断", async () => {
  const h = harness();
  await h.health.checkNow();
  for (let i = 0; i < 3; i += 1) h.health.noteSupervisorMessage(upstreamLine("api.openai.com", "upstream-refused"), T0 - 5000 + i);
  assert.equal(h.health.snapshot().state, "error");
  h.state.effective = DIRECT;
  h.clock.now += EGRESS_EFFECTIVE_TTL_MS + 1;
  await h.health.checkNow();
  const snap = h.health.snapshot();
  assert.deepEqual([snap.mode, snap.state, snap.reason], ["direct", "warn", "target-failures"]);
});

test("服务：resolveEffective 一直不返回时这一轮在 5 秒后放弃，循环不卡死", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const health = createEgressHealth({ resolveEffective: () => { calls += 1; return new Promise(() => {}); }, connect: fakeConnect().connect, now: () => T0 });
  const round = health.checkNow();
  t.mock.timers.tick(5000);
  const snap = await round;
  assert.equal(calls, 1);
  assert.equal(snap.state, "unknown");
  const again = health.checkNow();
  t.mock.timers.tick(5000);
  await again;
  assert.equal(calls, 2, "上一轮放弃后，下一轮照常再试");
});
