import assert from "node:assert/strict";
import { test } from "node:test";

import { recordedLedger, replaySleepScene, sceneTime } from "./supervisor/sleep-scene-fixture.mjs";
import { computeTunnelStability, OBSERVED_GAP_MAX_MS, parseLedgerText, sleepPeriodsOf } from "./tunnel-ledger-stats.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = 1_790_000_000_000;

// 每 5 分钟一条 alive，模拟 supervisor 一直在运行。
function alives(from, to) {
  const out = [];
  for (let t = from; t <= to; t += 5 * MIN) out.push({ type: "alive", at: t });
  return out;
}

test("断线计数、断开时长、可用率与恢复用时", () => {
  const now = T0 + 10 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, now),
    { type: "up", serverId: "a", host: "vpn-aliyun", at: T0 + MIN },
    { type: "down", serverId: "a", at: T0 + 2 * HOUR, cause: "keepalive-timeout", detail: "Timeout", uptimeMs: 2 * HOUR, planned: false },
    { type: "up", serverId: "a", at: T0 + 2 * HOUR + 30_000, downMs: 30_000, attempts: 2 },
    { type: "down", serverId: "a", at: T0 + 5 * HOUR, cause: "remote-closed", planned: false, networkChange: true },
    { type: "up", serverId: "a", at: T0 + 5 * HOUR + 90_000 },
  ];
  const stats = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] });
  const w = stats.servers.a.windows["24h"];
  assert.equal(w.drops, 2);
  assert.equal(w.downMs, 120_000);
  assert.equal(w.recoveries, 2);
  assert.equal(w.meanRecoveryMs, 60_000);
  assert.equal(w.maxRecoveryMs, 90_000);
  assert.equal(w.networkChangeDrops, 1);
  assert.deepEqual(w.causes, { "keepalive-timeout": 1, "remote-closed": 1 });
  const observed = now - (T0 + MIN);
  assert.ok(Math.abs(w.availability - (observed - 120_000) / observed) < 1e-9);
  assert.equal(stats.servers.a.state, "up");
  assert.equal(stats.servers.a.since, T0 + 5 * HOUR + 90_000);
  assert.equal(stats.servers.a.lastDrop.cause, "remote-closed");
  assert.equal(stats.recentDrops.length, 2);
  assert.equal(stats.recentDrops[0].at, T0 + 5 * HOUR, "最近的在前");
  assert.equal(stats.recentDrops[0].downMs, 90_000);
  assert.equal(stats.recentDrops[1].attempts, 2);
  assert.equal(w.longestUpMs, 5 * HOUR - 90_000, "最后一段：5h+90s → 10h");
});

test("仍在断开中：计入进行中的断开时长，状态为 down", () => {
  const now = T0 + HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, now),
    { type: "up", serverId: "a", at: T0 },
    { type: "down", serverId: "a", at: T0 + 50 * MIN, cause: "closed", planned: false },
  ];
  const s = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a;
  assert.equal(s.state, "down");
  assert.equal(s.since, T0 + 50 * MIN);
  assert.equal(s.windows["24h"].downMs, 10 * MIN);
  assert.equal(s.windows["24h"].recoveries, 0);
});

test("计划内停止不算断线；停机 / 睡眠空档既不算在线也不算断开", () => {
  const now = T0 + 6 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, T0 + HOUR),
    { type: "up", serverId: "a", at: T0 },
    { type: "down", serverId: "a", at: T0 + HOUR, cause: "stopped", planned: true },
    // 停机 4 小时
    { type: "start", at: T0 + 5 * HOUR },
    ...alives(T0 + 5 * HOUR, now),
    { type: "up", serverId: "a", at: T0 + 5 * HOUR + MIN },
  ];
  const w = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a.windows["24h"];
  assert.equal(w.drops, 0);
  assert.equal(w.downMs, 0);
  assert.equal(w.upMs, HOUR + (HOUR - MIN));
  assert.equal(w.availability, 1);
});

test("超过心跳上限的空档（睡眠）之后，在线状态不延续", () => {
  const now = T0 + 3 * HOUR;
  const events = [
    { type: "start", at: T0 },
    { type: "up", serverId: "a", at: T0 },
    { type: "alive", at: T0 + 5 * MIN },
    // 之后再无记录：supervisor 没在跑
  ];
  const s = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a;
  assert.equal(s.windows["24h"].upMs, 5 * MIN);
  assert.equal(s.state, "unknown");
  assert.ok(OBSERVED_GAP_MAX_MS < 3 * HOUR);
});

test("窗口裁剪：24h 外的断线只进 7d", () => {
  const now = T0 + 48 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, now),
    { type: "up", serverId: "a", at: T0 },
    { type: "down", serverId: "a", at: T0 + HOUR, cause: "closed", planned: false },
    { type: "up", serverId: "a", at: T0 + HOUR + MIN },
  ];
  const s = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a;
  assert.equal(s.windows["24h"].drops, 0);
  assert.equal(s.windows["7d"].drops, 1);
  assert.equal(s.windows["24h"].availability, 1);
});

test("没有数据的服务器：状态未知、可用率为空；坏行被跳过", () => {
  const events = parseLedgerText('{"type":"start","at":1}\n{bad json\n{"type":"up","serverId":"b","at":2}\n{"type":"alive"}\n');
  assert.equal(events.length, 2);
  const stats = computeTunnelStability({ events, nowMs: 3, serverIds: ["a"] });
  assert.equal(stats.servers.a.state, "unknown");
  assert.equal(stats.servers.a.windows["24h"].availability, null);
});

test("自定义区间：简报按「今天 0 点起」统计，区间外的断线不计", () => {
  const now = T0 + 10 * HOUR;
  const dayStart = T0 + 4 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, now),
    { type: "up", serverId: "a", at: T0 },
    { type: "down", serverId: "a", at: T0 + 2 * HOUR, cause: "closed", planned: false },
    { type: "up", serverId: "a", at: T0 + 2 * HOUR + MIN },
    { type: "down", serverId: "a", at: T0 + 6 * HOUR, cause: "keepalive-timeout", planned: false },
    { type: "up", serverId: "a", at: T0 + 6 * HOUR + 2 * MIN },
  ];
  const w = computeTunnelStability({ events, nowMs: now, serverIds: ["a"], ranges: { today: [dayStart, dayStart + 24 * HOUR] } }).servers.a.windows.today;
  assert.equal(w.drops, 1);
  assert.equal(w.downMs, 2 * MIN);
  assert.equal(w.upMs, 6 * HOUR - 2 * MIN, "区间终点截到现在");
  assert.deepEqual(w.causes, { "keepalive-timeout": 1 });
});

test("时间线：账本之前未观测、断开段带原因、相邻同状态合并", () => {
  const now = T0 + 24 * HOUR;
  const ledgerStart = T0 + 10 * HOUR;
  const events = [
    { type: "start", at: ledgerStart },
    ...alives(ledgerStart, now),
    { type: "up", serverId: "a", at: ledgerStart },
    { type: "down", serverId: "a", at: T0 + 20 * HOUR, cause: "keepalive-timeout", planned: false },
    { type: "up", serverId: "a", at: T0 + 20 * HOUR + 3 * MIN },
  ];
  const { segments, start, end } = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a.timeline;
  assert.equal(start, now - 24 * HOUR);
  assert.equal(end, now);
  assert.deepEqual(segments.map((s) => s.state), ["unobserved", "up", "down", "up"]);
  assert.equal(segments[0].to, ledgerStart);
  assert.equal(segments[2].cause, "keepalive-timeout");
  assert.equal(segments[2].to - segments[2].from, 3 * MIN);
  assert.equal(segments.at(-1).to, now);
});

test("热更新交接：start 紧接上一条记录时会话延续，在线时长与最长在线不归零", () => {
  const now = T0 + 10 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, now),
    { type: "up", serverId: "a", at: T0 },
    // 5 小时后热更新：新 supervisor 启动并原样接管隧道（adopted up）
    { type: "start", at: T0 + 5 * HOUR + 1000 },
    { type: "up", serverId: "a", at: T0 + 5 * HOUR + 1020, via: "adopted" },
  ];
  const s = computeTunnelStability({ events, nowMs: now, serverIds: ["a"] }).servers.a;
  assert.equal(s.state, "up");
  assert.equal(s.since, T0, "在线起点仍是最初那次建立");
  assert.equal(s.windows["24h"].longestUpMs, 10 * HOUR);
  assert.deepEqual(s.timeline.segments.filter((x) => x.state !== "unobserved").map((x) => x.state), ["up"]);
});

// ---------------------------------------------------------------------------
// 休眠归因（v2.62）
// ---------------------------------------------------------------------------

const SEC = 1000;
const wake = (at, sleptMs) => ({ type: "wake", at, sleptMs });
const sleepDown = (at, extra = {}) => ({ type: "down", serverId: "a", at, cause: "remote-closed", planned: false, networkChange: true, sleep: true, ...extra });
const states = (summary) => summary.timeline.segments.filter((s) => s.state !== "unobserved").map((s) => [s.state, s.from - T0, s.to - T0]);

// 一小时在线 → 睡 30 分钟（T0+60 分 → T0+90 分）→ 醒来。after：醒来之后的记录。
function napLedger(after = [], { now = T0 + 2 * HOUR } = {}) {
  return [
    { type: "start", at: T0 },
    ...alives(T0, T0 + HOUR),
    { type: "up", serverId: "a", host: "example-cluster", at: T0 },
    wake(T0 + 90 * MIN, 30 * MIN),
    ...alives(T0 + 90 * MIN, now),
    ...after,
  ];
}
const napStats = (after, { now = T0 + 2 * HOUR, ...rest } = {}) => computeTunnelStability({ events: napLedger(after, { now }), nowMs: now, serverIds: ["a"], ...rest });

test("休眠里隧道没断：那一段不算在线也不算断开；醒来后在线状态延续，不像停机空档那样归为未知", () => {
  const stats = napStats();
  const s = stats.servers.a;
  const w = s.windows["24h"];
  assert.equal(s.state, "up");
  assert.equal(s.since, T0, "同一条会话，在线起点不变");
  assert.deepEqual([w.upMs, w.downMs, w.sleepDownMs], [90 * MIN, 0, 30 * MIN]);
  assert.deepEqual([w.drops, w.sleepDrops, w.availability], [0, 0, 1]);
  assert.equal(w.longestUpMs, HOUR, "连续在线被休眠打断");
  assert.deepEqual(states(s), [["up", 0, HOUR], ["sleep", HOUR, 90 * MIN], ["up", 90 * MIN, 2 * HOUR]]);
  assert.deepEqual(stats.recentDrops, [], "隧道没断，清单里没有东西");
  assert.deepEqual(stats.sleep["24h"], { ms: 30 * MIN, count: 1, lastWakeAt: T0 + 90 * MIN });

  // 同一段记录、没有 wake 行（旧账本）：30 分钟的空档是「未观测」，之后状态未知——与之前一样
  const old = computeTunnelStability({ events: napLedger().filter((e) => e.type !== "wake"), nowMs: T0 + 2 * HOUR, serverIds: ["a"] });
  assert.equal(old.servers.a.state, "unknown");
  assert.equal(old.servers.a.windows["24h"].upMs, HOUR);
  assert.deepEqual(old.sleep["24h"], { ms: 0, count: 0, lastWakeAt: null });
});

test("醒来后被标了 sleep 的断线：不计断线次数 / 原因 / 可用率 / 恢复用时，另计 sleepDrops；清单里并进那段休眠", () => {
  const at = T0 + 90 * MIN;
  const stats = napStats([sleepDown(at + 5 * SEC, { uptimeMs: 5_405_000, detail: "Connection to 192.0.2.10 closed by remote host." }), { type: "up", serverId: "a", at: at + 30 * SEC, attempts: 1 }]);
  const s = stats.servers.a;
  const w = s.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.recoveries, w.meanRecoveryMs, w.maxRecoveryMs, w.networkChangeDrops], [0, 1, 0, null, null, 0]);
  assert.deepEqual(w.causes, {});
  assert.deepEqual([w.downMs, w.sleepDownMs, w.availability], [0, 30 * MIN + 25 * SEC, 1]);
  assert.equal(w.upMs, HOUR + 5 * SEC + (30 * MIN - 30 * SEC));
  assert.equal(s.lastDrop, null, "最近一次断线不含休眠");
  assert.deepEqual([s.state, s.since], ["up", at + 30 * SEC]);
  assert.deepEqual(states(s), [
    ["up", 0, HOUR], ["sleep", HOUR, 90 * MIN], ["up", 90 * MIN, 90 * MIN + 5 * SEC],
    ["sleep", 90 * MIN + 5 * SEC, 90 * MIN + 30 * SEC], ["up", 90 * MIN + 30 * SEC, 2 * HOUR],
  ]);
  assert.deepEqual(stats.recentDrops, [{
    serverId: "a", host: "example-cluster", at: T0 + HOUR, cause: "sleep", detail: "", uptimeMs: null, networkChange: false,
    recoveredAt: at + 30 * SEC, downMs: 30 * MIN + 30 * SEC, attempts: 1, sleep: true, drops: 1,
  }], "从入睡那一刻算起，到重新建立为止");
});

test("唤醒后的重连宽限：10 分钟内连上整段算休眠；超过，从断开那一刻起照旧记一次普通断线", () => {
  const at = T0 + 90 * MIN;
  const down = sleepDown(at + 500, { cause: "process-lost", uptimeMs: 5_400_500 });
  const quick = napStats([down, { type: "up", serverId: "a", at: at + 9 * MIN }]).servers.a.windows["24h"];
  assert.deepEqual([quick.drops, quick.sleepDrops, quick.downMs, quick.sleepDownMs], [0, 1, 0, 30 * MIN + 9 * MIN - 500]);

  const slow = napStats([down, { type: "up", serverId: "a", at: at + 11 * MIN, attempts: 6 }]);
  const w = slow.servers.a.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.downMs, w.sleepDownMs], [1, 0, 11 * MIN - 500, 30 * MIN]);
  assert.deepEqual(w.causes, { "process-lost": 1 });
  assert.deepEqual([w.recoveries, w.maxRecoveryMs, w.networkChangeDrops], [1, 11 * MIN - 500, 1]);
  assert.ok(Math.abs(w.availability - w.upMs / (w.upMs + 11 * MIN - 500)) < 1e-12);
  assert.deepEqual(states(slow.servers.a).slice(1), [["sleep", HOUR, 90 * MIN], ["up", 90 * MIN, 90 * MIN + 500], ["down", 90 * MIN + 500, 101 * MIN], ["up", 101 * MIN, 2 * HOUR]]);
  assert.deepEqual(slow.recentDrops, [{
    serverId: "a", host: "example-cluster", at: at + 500, cause: "process-lost", detail: "", uptimeMs: 5_400_500, networkChange: true,
    recoveredAt: at + 11 * MIN, downMs: 11 * MIN - 500, attempts: 6,
  }], "就是一条普通断线（没有 sleep 标记），休眠那段隧道没断、不出条目");
  assert.equal(slow.servers.a.lastDrop.at, at + 500);
});

// 合盖期间短暂唤醒时发现 ssh 死了（T0+75 分），随后又睡到 T0+90 分：醒来时隧道是断的。
function deadOnWake(after, options) {
  return napStats([wake(T0 + 75 * MIN, 15 * MIN), sleepDown(T0 + 75 * MIN + SEC, { cause: "closed", detail: "Connection closed by 192.0.2.10 port 22" }), ...after], options);
}

test("醒来时隧道是断的：宽限内连上算休眠（一条清单）；没连上，从醒来那一刻起记普通断线，休眠条目到醒来为止", () => {
  const at = T0 + 90 * MIN;
  const quick = deadOnWake([{ type: "up", serverId: "a", at: at + 8 * MIN, attempts: 2 }]);
  assert.deepEqual(quick.sleep["24h"], { ms: 30 * MIN, count: 1, lastWakeAt: at }, "两段休眠之间只醒了 2 秒：并成一段");
  assert.deepEqual(states(quick.servers.a), [["up", 0, HOUR], ["sleep", HOUR, 98 * MIN], ["up", 98 * MIN, 2 * HOUR]]);
  assert.deepEqual(quick.recentDrops.map((d) => [d.cause, d.at, d.recoveredAt, d.downMs, d.drops, d.attempts]), [["sleep", T0 + HOUR, at + 8 * MIN, 38 * MIN, 1, 2]]);
  assert.deepEqual([quick.servers.a.windows["24h"].drops, quick.servers.a.windows["24h"].sleepDrops], [0, 1]);

  const slow = deadOnWake([{ type: "up", serverId: "a", at: at + 12 * MIN }]);
  const w = slow.servers.a.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.downMs, w.sleepDownMs, w.recoveries], [1, 1, 12 * MIN, 30 * MIN, 1]);
  assert.deepEqual(w.causes, { closed: 1 }, "原因沿用休眠里最后那次断开的");
  assert.deepEqual(states(slow.servers.a), [["up", 0, HOUR], ["sleep", HOUR, 90 * MIN], ["down", 90 * MIN, 102 * MIN], ["up", 102 * MIN, 2 * HOUR]]);
  assert.deepEqual(slow.recentDrops.map((d) => [d.cause, d.sleep === true, d.at, d.recoveredAt, d.downMs]), [
    ["closed", false, at, at + 12 * MIN, 12 * MIN],
    ["sleep", true, T0 + HOUR, at, 30 * MIN],
  ]);
  assert.equal(slow.recentDrops[0].detail, "Connection closed by 192.0.2.10 port 22");
  assert.equal(slow.recentDrops[0].uptimeMs, null, "醒来才开始算的断线没有「此前在线」");
});

test("还在宽限内：状态是 sleep（重连中）、从醒来算起，不计断线；宽限过了仍没连上就是普通的断开中", () => {
  const at = T0 + 90 * MIN;
  const early = deadOnWake([], { now: at + 3 * MIN });
  assert.deepEqual([early.servers.a.state, early.servers.a.since], ["sleep", at]);
  assert.deepEqual([early.servers.a.windows["24h"].drops, early.servers.a.windows["24h"].downMs], [0, 0]);
  assert.deepEqual(early.recentDrops.map((d) => [d.cause, d.recoveredAt, d.downMs]), [["sleep", null, null]], "条目保持未恢复");
  assert.equal(states(early.servers.a).at(-1)[0], "sleep");

  const late = deadOnWake([], { now: at + 11 * MIN });
  assert.deepEqual([late.servers.a.state, late.servers.a.since], ["down", at]);
  assert.deepEqual([late.servers.a.windows["24h"].drops, late.servers.a.windows["24h"].downMs], [1, 11 * MIN]);
  assert.equal(late.servers.a.lastDrop.recoveredAt, null);
});

test("醒着半小时没连上、电脑又睡了：这半小时是一次普通断线（记到入睡为止，不算恢复），之后的休眠另起一条", () => {
  const events = [
    ...napLedger([], { now: T0 + 2 * HOUR }),
    wake(T0 + 75 * MIN, 15 * MIN),
    sleepDown(T0 + 75 * MIN + SEC, { cause: "closed" }),
    wake(T0 + 3 * HOUR, HOUR),
    ...alives(T0 + 3 * HOUR, T0 + 4 * HOUR),
    { type: "up", serverId: "a", at: T0 + 3 * HOUR + 30 * SEC },
  ];
  const stats = computeTunnelStability({ events, nowMs: T0 + 4 * HOUR, serverIds: ["a"] });
  const w = stats.servers.a.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.downMs, w.recoveries, w.maxRecoveryMs], [1, 1, 30 * MIN, 0, null]);
  assert.equal(w.sleepDownMs, 30 * MIN + HOUR + 30 * SEC);
  assert.deepEqual(states(stats.servers.a), [
    ["up", 0, HOUR], ["sleep", HOUR, 90 * MIN], ["down", 90 * MIN, 2 * HOUR], ["sleep", 2 * HOUR, 3 * HOUR + 30 * SEC], ["up", 3 * HOUR + 30 * SEC, 4 * HOUR],
  ]);
  assert.deepEqual(stats.recentDrops.map((d) => [d.cause, d.at - T0, d.recoveredAt - T0, d.endedBy ?? null, d.drops ?? null]), [
    ["sleep", 2 * HOUR, 3 * HOUR + 30 * SEC, null, 0],
    ["closed", 90 * MIN, 2 * HOUR, "sleep", null],
    ["sleep", HOUR, 90 * MIN, null, 1],
  ]);
  assert.deepEqual(stats.sleep["24h"], { ms: 90 * MIN, count: 2, lastWakeAt: T0 + 3 * HOUR });

  // 宽限内又睡了（只醒了 5 分钟）：照旧算休眠，不出普通断线
  const brief = computeTunnelStability({
    events: [...napLedger([], { now: T0 + 95 * MIN }), wake(T0 + 75 * MIN, 15 * MIN), sleepDown(T0 + 75 * MIN + SEC), wake(T0 + 3 * HOUR, 85 * MIN), ...alives(T0 + 3 * HOUR, T0 + 4 * HOUR), { type: "up", serverId: "a", at: T0 + 3 * HOUR + 30 * SEC }],
    nowMs: T0 + 4 * HOUR,
    serverIds: ["a"],
  });
  assert.deepEqual([brief.servers.a.windows["24h"].drops, brief.servers.a.windows["24h"].downMs], [0, 0]);
  assert.deepEqual(states(brief.servers.a), [["up", 0, HOUR], ["sleep", HOUR, 3 * HOUR + 30 * SEC], ["up", 3 * HOUR + 30 * SEC, 4 * HOUR]]);
  assert.equal(brief.sleep["24h"].count, 2, "中间醒了 5 分钟：是两段休眠");
});

test("普通断线还没恢复电脑就睡了：断线照算、记到入睡为止；醒来后宽限内连上的那段归休眠", () => {
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, T0 + HOUR),
    { type: "up", serverId: "a", at: T0 },
    { type: "down", serverId: "a", at: T0 + 55 * MIN, cause: "keepalive-timeout", planned: false, networkChange: false, sleep: false },
    wake(T0 + 90 * MIN, 30 * MIN),
    ...alives(T0 + 90 * MIN, T0 + 2 * HOUR),
    { type: "up", serverId: "a", at: T0 + 90 * MIN + 20 * SEC },
  ];
  const stats = computeTunnelStability({ events, nowMs: T0 + 2 * HOUR, serverIds: ["a"] });
  const w = stats.servers.a.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.downMs, w.sleepDownMs, w.recoveries], [1, 0, 5 * MIN, 30 * MIN + 20 * SEC, 0]);
  assert.deepEqual(w.causes, { "keepalive-timeout": 1 });
  assert.deepEqual(stats.recentDrops.map((d) => [d.cause, d.at - T0, d.recoveredAt - T0, d.endedBy ?? null]), [
    ["sleep", HOUR, 90 * MIN + 20 * SEC, null],
    ["keepalive-timeout", 55 * MIN, HOUR, "sleep"],
  ]);
});

test("带 sleep 标记但账本里没有对应的 wake 行：照样不计断线，清单条目从断开那一刻算", () => {
  const at = T0 + 90 * MIN;
  const stats = computeTunnelStability({
    events: [...napLedger().filter((e) => e.type !== "wake"), sleepDown(at + SEC), { type: "up", serverId: "a", at: at + 31 * SEC }],
    nowMs: T0 + 2 * HOUR,
    serverIds: ["a"],
  });
  const w = stats.servers.a.windows["24h"];
  assert.deepEqual([w.drops, w.sleepDrops, w.sleepDownMs], [0, 1, 30 * SEC]);
  assert.deepEqual(stats.recentDrops.map((d) => [d.cause, d.at, d.downMs]), [["sleep", at + SEC, 30 * SEC]]);
  assert.deepEqual(stats.sleep["24h"], { ms: 0, count: 0, lastWakeAt: null }, "不知道睡了多久");
  assert.deepEqual(states(stats.servers.a), [["up", 0, HOUR], ["sleep", 90 * MIN + SEC, 90 * MIN + 31 * SEC], ["up", 90 * MIN + 31 * SEC, 2 * HOUR]]);
});

test("休眠区间：醒着不超过 120 秒的几段并成一段，各控制器重复记的行并起来；坏行忽略", () => {
  const rel = (periods) => periods.map((p) => [p.from - T0, p.to - T0]);
  // 三行：10 分钟处醒来（两个控制器各记一行，差 300 毫秒），醒了 60 秒又睡到 20 分钟处 → 一段
  assert.deepEqual(rel(sleepPeriodsOf([wake(T0 + 20 * MIN, 9 * MIN), wake(T0 + 10 * MIN, 10 * MIN), wake(T0 + 10 * MIN + 300, 10 * MIN)])), [[0, 20 * MIN]]);
  // 中间醒了 120 秒零 1 毫秒 → 两段
  assert.deepEqual(rel(sleepPeriodsOf([wake(T0 + 10 * MIN, 10 * MIN), wake(T0 + 22 * MIN + 1, 10 * MIN)])), [[0, 10 * MIN], [12 * MIN + 1, 22 * MIN + 1]]);
  assert.deepEqual(rel(sleepPeriodsOf([wake(T0 + 10 * MIN, 10 * MIN), wake(T0 + 22 * MIN, 10 * MIN)])), [[0, 22 * MIN]], "恰好 120 秒：并");
  assert.deepEqual(sleepPeriodsOf([{ type: "wake", at: T0 }, wake(T0, -1), wake(T0, 0), { type: "wake", at: T0, sleptMs: "x" }, { type: "alive", at: T0, sleptMs: 3 }, null]), []);
  assert.deepEqual(sleepPeriodsOf([wake(T0, T0 + 1), wake(T0, T0)]), [], "睡得比时间戳本身还久：坏行");
  // 截到统计时刻：还没发生的不算，跨过截止时刻的只算到截止
  assert.deepEqual(rel(sleepPeriodsOf([wake(T0 + 10 * HOUR, 8 * HOUR), wake(T0 + 20 * HOUR, HOUR)], T0 + 4 * HOUR)), [[2 * HOUR, 4 * HOUR]]);
});

test("统计截到休眠中途（简报定稿昨天、休眠跨过 0 点）：这一天只算到 0 点，剩下的算进第二天", () => {
  const midnight = T0 + 24 * HOUR;
  const events = [
    { type: "start", at: T0 },
    ...alives(T0, T0 + 22 * HOUR),
    { type: "up", serverId: "a", at: T0 },
    wake(midnight + 8 * HOUR, 10 * HOUR), // 22 点睡到次日 8 点
    ...alives(midnight + 8 * HOUR, midnight + 12 * HOUR),
  ];
  const day1 = computeTunnelStability({ events, nowMs: midnight, serverIds: ["a"], ranges: { day: [T0, midnight] }, timelineStartMs: T0 });
  assert.deepEqual(day1.sleep.day, { ms: 2 * HOUR, count: 1, lastWakeAt: midnight });
  assert.deepEqual([day1.servers.a.windows.day.upMs, day1.servers.a.windows.day.sleepDownMs], [22 * HOUR, 2 * HOUR]);
  assert.deepEqual(states(day1.servers.a), [["up", 0, 22 * HOUR], ["sleep", 22 * HOUR, 24 * HOUR]]);
  assert.equal(day1.servers.a.state, "sleep", "截止时刻电脑还睡着");

  const day2 = computeTunnelStability({ events, nowMs: midnight + 12 * HOUR, serverIds: ["a"], ranges: { day: [midnight, midnight + 24 * HOUR] } });
  assert.deepEqual(day2.sleep.day, { ms: 8 * HOUR, count: 1, lastWakeAt: midnight + 8 * HOUR });
  assert.deepEqual([day2.servers.a.windows.day.upMs, day2.servers.a.windows.day.sleepDownMs, day2.servers.a.state], [4 * HOUR, 8 * HOUR, "up"]);
});

// ---- 2026-10-11 现场（夹具见 lib/supervisor/sleep-scene-fixture.mjs）----
// 合盖 19:03:39 – 21:45:50；统计截至当晚 23:00，区间取北京时间当天。

const SCENE_DAY_START = sceneTime("00:00:00");
const sceneArgs = { nowMs: sceneTime("23:00:00"), serverIds: ["server-01", "server-02"], ranges: { day: [SCENE_DAY_START, SCENE_DAY_START + 24 * HOUR] }, recentLimit: Infinity };
// [状态, 起, 止]（当天 0 点起的秒数）
const dayStates = (summary) => summary.timeline.segments.map((s) => [s.state, (s.from - SCENE_DAY_START) / 1000, (s.to - SCENE_DAY_START) / 1000]);

test("现场 · 旧账本（没有 sleep / wake）：口径与改动之前逐字相同——仍是 3 + 4 次断线", () => {
  const stats = computeTunnelStability({ events: recordedLedger(), ...sceneArgs });
  // 下面的数取自改动之前的统计模块对同一份账本的输出。
  assert.deepEqual(stats.servers["server-01"].windows.day, {
    drops: 3, upMs: 3580046, downMs: 588000, availability: 0.8589267009049324, recoveries: 3, meanRecoveryMs: 1518333, maxRecoveryMs: 3021000,
    longestUpMs: 3307046, causes: { "process-lost": 1, "remote-closed": 1, closed: 1 }, networkChangeDrops: 3, sleepDrops: 0, sleepDownMs: 0,
  });
  assert.deepEqual(stats.servers["server-02"].windows.day, {
    drops: 4, upMs: 3502083, downMs: 111000, availability: 0.9692783143924455, recoveries: 4, meanRecoveryMs: 1176750, maxRecoveryMs: 2592000,
    longestUpMs: 3307083, causes: { "process-lost": 1, closed: 2, "remote-closed": 1 }, networkChangeDrops: 3, sleepDrops: 0, sleepDownMs: 0,
  });
  assert.deepEqual(dayStates(stats.servers["server-01"]), [
    ["unobserved", -3600, 65102.954], ["up", 65102.954, 68410], ["unobserved", 68410, 77790], ["up", 77790, 77791], ["down", 77791, 78379], ["up", 78379, 78651], ["unobserved", 78651, 82800],
  ]);
  assert.deepEqual(dayStates(stats.servers["server-02"]), [
    ["unobserved", -3600, 65102.917], ["up", 65102.917, 68410], ["unobserved", 68410, 73749], ["down", 73749, 73753], ["unobserved", 73753, 74763], ["up", 74763, 74764],
    ["unobserved", 74764, 78350], ["down", 78350, 78379], ["up", 78379, 78453], ["down", 78453, 78531], ["up", 78531, 78651], ["unobserved", 78651, 82800],
  ]);
  assert.deepEqual(stats.recentDrops.map((d) => [d.serverId, (d.at - SCENE_DAY_START) / 1000, d.cause, (d.recoveredAt - SCENE_DAY_START) / 1000, d.downMs, d.uptimeMs, d.networkChange, d.attempts]), [
    ["server-02", 78453, "remote-closed", 78531, 78000, 95597, true, 1],
    ["server-01", 77791, "closed", 78379, 588000, 972434, true, 1],
    ["server-02", 75787, "closed", 78379, 2592000, 1017464, true, 2],
    ["server-01", 74769, "remote-closed", 77790, 3021000, 3033413, true, 1],
    ["server-02", 74764, "closed", 75787, 1023000, 1011219, true, 1],
    ["server-02", 73749, "process-lost", 74763, 1014000, 8646583, false, 1],
    ["server-01", 71733, "process-lost", 72679, 946000, 6630046, true, 1],
  ]);
  assert.ok(stats.recentDrops.every((d) => !("sleep" in d) && !("endedBy" in d)));
  assert.deepEqual(stats.sleep, { day: { ms: 0, count: 0, lastWakeAt: null } });
  assert.deepEqual([stats.servers["server-01"].lastDrop.cause, stats.servers["server-02"].lastDrop.cause], ["closed", "remote-closed"]);
});

test("现场 · 现在的 supervisor 记下的账本：0 次断线，整段记为休眠 2 小时 42 分，每条隧道清单里只有一条", async () => {
  const { rows } = await replaySleepScene();
  const stats = computeTunnelStability({ events: rows, ...sceneArgs });
  const lidClosed = sceneTime("19:03:39");
  assert.deepEqual(stats.sleep.day, { ms: 9_738_611, count: 1, lastWakeAt: sceneTime("21:45:57.611") }, "19:03:39 → 21:45:57.611 = 2 小时 42 分 18.6 秒");

  const main = stats.servers["server-01"];
  assert.deepEqual(main.windows.day, {
    drops: 0, upMs: 3_788_146, downMs: 0, availability: 1, recoveries: 0, meanRecoveryMs: null, maxRecoveryMs: null,
    longestUpMs: 3_516_046, causes: {}, networkChangeDrops: 0, sleepDrops: 3, sleepDownMs: 9_760_200,
  });
  assert.equal(main.lastDrop, null);
  // 在线一直算到合盖那一刻（旧口径停在 19:00:10 的最后一条心跳）；休眠到 21:46:19 重新建立为止，中间没有一小段断开。
  assert.deepEqual(dayStates(main), [["unobserved", -3600, 65102.954], ["up", 65102.954, 68619], ["sleep", 68619, 78379.2], ["up", 78379.2, 78651.3], ["unobserved", 78651.3, 82800]]);

  const cloud = stats.servers["server-02"];
  assert.deepEqual([cloud.windows.day.drops, cloud.windows.day.sleepDrops, cloud.windows.day.downMs, cloud.windows.day.availability], [0, 4, 0, 1]);
  assert.deepEqual([cloud.windows.day.upMs, cloud.windows.day.sleepDownMs], [3_710_091, 9_838_292]);
  // 开盖后 21:47:33 那次（距发现跳变 95.6 秒）也算休眠造成的：时间线上是紧挨着的一小段，清单里并进同一条。
  assert.deepEqual(dayStates(cloud).slice(1, -1), [["up", 65102.917, 68619], ["sleep", 68619, 78379.2], ["up", 78379.2, 78453.208], ["sleep", 78453.208, 78531.3], ["up", 78531.3, 78651.3]]);

  assert.deepEqual(stats.recentDrops, [
    { serverId: "server-01", host: "example-cluster", at: lidClosed, cause: "sleep", detail: "", uptimeMs: null, networkChange: false, recoveredAt: sceneTime("21:46:19.200"), downMs: 9_760_200, attempts: 1, sleep: true, drops: 3 },
    { serverId: "server-02", host: "example-cloud", at: lidClosed, cause: "sleep", detail: "", uptimeMs: null, networkChange: false, recoveredAt: sceneTime("21:48:51.300"), downMs: 9_912_300, attempts: 1, sleep: true, drops: 4 },
  ]);
});

test("现场 · 同一份账本里新旧行混着：旧行照旧算断线，新行按休眠（两天前那次是旧版记的）", async () => {
  const { rows } = await replaySleepScene();
  const twoDays = 48 * HOUR;
  const events = [...recordedLedger().map((row) => ({ ...row, at: row.at - twoDays })), ...rows];
  const stats = computeTunnelStability({
    events,
    nowMs: sceneArgs.nowMs,
    serverIds: sceneArgs.serverIds,
    ranges: { old: [SCENE_DAY_START - twoDays, SCENE_DAY_START - twoDays + 24 * HOUR], today: sceneArgs.ranges.day, "7d": [sceneArgs.nowMs - 7 * 24 * HOUR, sceneArgs.nowMs] },
    recentLimit: Infinity,
  });
  const pick = (id, key) => [stats.servers[id].windows[key].drops, stats.servers[id].windows[key].sleepDrops];
  assert.deepEqual([pick("server-01", "old"), pick("server-02", "old")], [[3, 0], [4, 0]]);
  assert.deepEqual([pick("server-01", "today"), pick("server-02", "today")], [[0, 3], [0, 4]]);
  assert.deepEqual([pick("server-01", "7d"), pick("server-02", "7d")], [[3, 3], [4, 4]]);
  assert.deepEqual([stats.sleep.old.ms, stats.sleep.today.ms, stats.sleep["7d"].count], [0, 9_738_611, 1]);
  assert.equal(stats.servers["server-01"].windows.old.maxRecoveryMs, 3021000, "旧行那次 50 分钟的断开照旧在");
  assert.equal(stats.recentDrops.filter((d) => d.sleep).length, 2);
  assert.equal(stats.recentDrops.filter((d) => !d.sleep).length, 7);
});

// ---- 性质测试：记账自洽（固定种子） ----

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("性质：任意新格式账本（含乱序、重叠的 wake、没头没尾的 up / down）——时间线首尾相接、时长与时间线对得上、休眠区间里只有休眠、计数自洽", () => {
  const rnd = mulberry32(20261011);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pickOne = (list) => list[int(0, list.length - 1)];
  const overlapMs = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
  let seenSleepEntries = 0;
  let seenEscalations = 0;
  for (let round = 0; round < 600; round += 1) {
    const servers = ["a", "b"].slice(0, int(1, 2));
    const events = [];
    let t = T0;
    for (let i = int(0, 90); i > 0; i -= 1) {
      const r = rnd();
      t += r < 0.15 ? 0 : r < 0.5 ? int(1, 90 * SEC) : r < 0.8 ? int(4 * MIN, 6 * MIN) : r < 0.93 ? int(9 * MIN, 12 * MIN) : int(15 * MIN, 9 * HOUR);
      const kind = rnd();
      const serverId = pickOne(servers);
      if (kind < 0.3) events.push({ type: "alive", at: t });
      else if (kind < 0.33) events.push({ type: "start", at: t });
      else if (kind < 0.55) events.push({ type: "up", serverId, at: t, attempts: int(0, 3) });
      else if (kind < 0.8) {
        const planned = rnd() < 0.15;
        const sleep = rnd();
        events.push({ type: "down", serverId, at: t, cause: pickOne(["closed", "remote-closed", "process-lost", "keepalive-timeout"]), planned, networkChange: rnd() < 0.4, ...(sleep < 0.45 ? { sleep: true } : sleep < 0.8 ? { sleep: false } : {}) });
      } else events.push(wake(t, pickOne([int(1, 80 * SEC), int(91 * SEC, 20 * MIN), int(20 * MIN, 10 * HOUR)])));
    }
    for (let i = events.length - 1; i > 0; i -= 1) {
      if (rnd() < 0.08) {
        const j = int(0, i);
        [events[i], events[j]] = [events[j], events[i]];
      }
    }
    const nowMs = rnd() < 0.25 ? T0 + Math.floor((t - T0) * rnd()) : t + int(0, 3 * HOUR);
    const start = T0 - 11 * HOUR; // 早于任何一条 wake 行所说的入睡时刻
    const sub = [start + Math.floor((nowMs - start) * rnd() * 0.8), nowMs - int(0, HOUR)];
    const input = structuredClone(events);
    const stats = computeTunnelStability({ events, nowMs, serverIds: servers, ranges: { all: [start, nowMs], sub }, timelineStartMs: start, recentLimit: Infinity });
    assert.deepEqual(events, input, "不改入参");
    const periods = sleepPeriodsOf(events, nowMs);
    assert.equal(stats.sleep.all.ms, periods.reduce((sum, p) => sum + overlapMs(p.from, p.to, start, nowMs), 0));
    assert.equal(stats.sleep.all.count, periods.length);

    for (const serverId of servers) {
      const s = stats.servers[serverId];
      const segs = s.timeline.segments;
      const label = `round ${round} ${serverId}`;
      // 时间线：从起点到现在首尾相接，没有空段，相邻两段不是同一种
      assert.equal(segs[0].from, start, label);
      assert.equal(segs.at(-1).to, nowMs, label);
      for (let i = 0; i < segs.length; i += 1) {
        assert.ok(["up", "down", "sleep", "unobserved"].includes(segs[i].state), label);
        assert.ok(segs[i].to > segs[i].from, label);
        if (i > 0) {
          assert.equal(segs[i].from, segs[i - 1].to, label);
          assert.ok(segs[i].state !== segs[i - 1].state || (segs[i].cause ?? null) !== (segs[i - 1].cause ?? null) || segs[i].at !== segs[i - 1].at, label);
        }
      }
      // 各类时长 = 时间线上同类分段的总长
      const total = (state) => segs.filter((x) => x.state === state).reduce((sum, x) => sum + (x.to - x.from), 0);
      const w = s.windows.all;
      assert.deepEqual([w.upMs, w.downMs, w.sleepDownMs], [total("up"), total("down"), total("sleep")], label);
      // 电脑睡着的时间里只有休眠
      for (const p of periods) {
        for (const seg of segs) {
          if (overlapMs(seg.from, seg.to, p.from, p.to) > 0) assert.equal(seg.state, "sleep", label);
        }
      }
      // 计数：普通断线一条清单一次；休眠造成的断开只进 sleepDrops
      const own = stats.recentDrops.filter((d) => d.serverId === serverId);
      const counted = own.filter((d) => !d.sleep);
      const sleeps = own.filter((d) => d.sleep);
      assert.equal(w.drops, counted.length, label);
      assert.equal(Object.values(w.causes).reduce((a, b) => a + b, 0), w.drops, label);
      assert.equal(w.sleepDrops, sleeps.reduce((sum, d) => sum + d.drops, 0), label);
      assert.ok(counted.every((d) => !("sleep" in d) && d.cause !== "sleep"), label);
      assert.ok(sleeps.every((d) => d.cause === "sleep" && d.uptimeMs === null), label);
      for (const d of own) {
        if (d.recoveredAt == null) assert.equal(d.downMs, null, label);
        else assert.equal(d.downMs, d.recoveredAt - d.at, label);
        assert.ok(d.downMs == null || d.downMs >= 0, label);
      }
      // 休眠条目至多一条还没收尾，而且只在隧道此刻确实因休眠断着的时候
      const openSleeps = sleeps.filter((d) => d.recoveredAt == null);
      assert.ok(openSleeps.length <= 1, label);
      if (openSleeps.length) assert.equal(s.state, "sleep", label);
      assert.equal(w.recoveries, counted.filter((d) => d.recoveredAt != null && d.endedBy !== "sleep").length, label);
      assert.ok(["up", "down", "sleep", "unknown"].includes(s.state), label);
      if (s.state === "down") assert.equal(s.lastDrop.recoveredAt, null, label);
      // 子区间：都不超过全区间，三类时长之和不超过区间长度
      const v = s.windows.sub;
      for (const key of ["upMs", "downMs", "sleepDownMs", "drops", "sleepDrops", "recoveries"]) assert.ok(v[key] <= w[key], `${label} ${key}`);
      assert.ok(v.upMs + v.downMs + v.sleepDownMs <= Math.max(0, Math.min(sub[1], nowMs) - sub[0]), label);
      seenSleepEntries += sleeps.length;
      seenEscalations += counted.filter((d) => d.endedBy === "sleep").length;
    }
  }
  assert.ok(seenSleepEntries > 300 && seenEscalations > 20, `样本要真的覆盖到休眠分支（休眠条目 ${seenSleepEntries}，入睡收尾的断线 ${seenEscalations}）`);
});
