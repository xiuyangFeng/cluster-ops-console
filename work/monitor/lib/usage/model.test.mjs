import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionDetail, buildUsageSummary, claudeWindow, estimateCallCost, evaluateSessionHealth, listSessionsForJobs, modelPricingOf, offsetDay, projectPath, sessionKeyOf } from "./model.mjs";
import { dayKeyOf } from "./store.mjs";

// 北京时间 2026-10-02 hour:minute（与本机时区无关）
const at = (hour, minute = 0, dayOffset = 0) => Date.UTC(2026, 9, 2 + dayOffset, hour - 8, minute) / 1000;
const NOW = at(15, 0);

function call(rid, t, patch = {}) {
  const base = { serverId: "server-01", agent: "claude", sid: "cl-1", rid, t, model: "claude-opus-5-5", ok: true, code: null, inFresh: 2, cacheWrite: 100, cacheRead: 1000, output: 10, prompt: 1102, turnId: null, sidechain: false };
  const c = { ...base, ...patch };
  return { ...c, day: dayKeyOf(c.t) };
}

function snapshot() {
  return {
    sessions: [
      { serverId: "server-01", agent: "claude", sid: "cl-1", cwd: "/home/u/Digital_twin/GNN", window: null },
      { serverId: "server-01", agent: "codex", sid: "cx-1", cwd: "/home/u/ops/GNN", window: 258400 },
      { serverId: "server-01", agent: "claude", sid: "cl-old", cwd: "/home/u/paper", window: null },
    ],
    calls: [
      call("a", at(14, 0)),
      call("b", at(14, 1), { cacheWrite: 0, cacheRead: 1100, prompt: 1102 }),
      call("e", at(14, 2), { ok: false, code: 429, inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, prompt: 0 }),
      call("s", at(14, 1) + 30, { sidechain: true, prompt: 50000 }),
      call("c", at(14, 58)),
      call("x1", at(9, 0), { agent: "codex", sid: "cx-1", model: "gpt-6.1-sol", inFresh: 300, cacheWrite: 0, cacheRead: 700, output: 40, prompt: 1000, turnId: "t1" }),
      call("x2", at(9, 2), { agent: "codex", sid: "cx-1", model: "gpt-6.1-sol", inFresh: 50, cacheWrite: 0, cacheRead: 1000, output: 20, prompt: 1050, turnId: "t1" }),
      call("old1", at(11, 0, -3), { sid: "cl-old" }),
    ],
    turns: [
      { serverId: "server-01", agent: "claude", sid: "cl-1", tid: "u1", t0: at(13, 59), t1: at(14, 2) },
      { serverId: "server-01", agent: "codex", sid: "cx-1", tid: "t1", t0: at(8, 59), t1: at(9, 3) },
    ],
    compacts: [{ serverId: "server-01", agent: "claude", sid: "cl-1", t: at(14, 1) }],
  };
}

test("口径：未命中输入 = 普通输入 + 缓存写入；失败调用不计 Token", () => {
  const summary = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, homes: { "server-01": "/home/u" } });
  const k = summary.kpis;
  // 今天的成功调用：a b s c（claude）+ x1 x2（codex）
  assert.equal(k.calls, 7);
  assert.equal(k.errors, 1);
  assert.deepEqual(k.codes, { 429: 1 });
  assert.equal(k.inFresh, 2 * 4 + 300 + 50);
  assert.equal(k.cacheWrite, 100 * 3);
  assert.equal(k.fresh, k.inFresh + k.cacheWrite);
  assert.equal(k.total, k.inFresh + k.cacheWrite + k.cacheRead + k.output);
  assert.equal(k.sessions, 2);
  assert.equal(k.recentSessions, 1); // cl-1 的最后调用 14:58，距 15:00 两分钟
  assert.equal(k.turnCount, 2);
});

test("趋势：今天只画到当前时刻（最后一档进行中）；不足 6 小时按 15 分钟；历史某天 24 小时；多日按天", () => {
  const today = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1 });
  assert.equal(today.trend.granularity, "hour");
  assert.equal(today.trend.buckets.length, 16); // 00:00 … 15:00
  assert.equal(today.trend.buckets.at(-1).label, "15:00");
  assert.deepEqual(today.trend.buckets.map((b) => b.partial).filter(Boolean).length, 1);
  assert.equal(today.trend.buckets.at(-1).partial, true);

  const early = buildUsageSummary(snapshot(), { nowSec: at(3, 30), range: 1 });
  assert.equal(early.trend.granularity, "quarter");
  assert.equal(early.trend.buckets.length, 15); // 00:00, 00:15 … 03:30
  assert.deepEqual([early.trend.buckets[1].label, early.trend.buckets.at(-1).label], ["00:15", "03:30"]);

  const past = buildUsageSummary(snapshot(), { nowSec: NOW, date: "2026-09-29" });
  assert.equal(past.trend.granularity, "hour");
  assert.equal(past.trend.buckets.length, 24);
  assert.ok(past.trend.buckets.every((b) => !b.partial));
  assert.ok(past.trend.buckets[11].claude > 0);
  assert.equal(today.trend.buckets[9].codex, (300 + 700 + 40) + (50 + 1000 + 20));
  assert.equal(today.trend.buckets[14].errors, 1);

  const week = buildUsageSummary(snapshot(), { nowSec: NOW, range: 7 });
  assert.equal(week.trend.granularity, "day");
  assert.equal(week.trend.buckets.length, 7);
  assert.equal(week.trend.buckets.at(-1).key, "2026-10-02");
  assert.ok(week.trend.buckets.find((b) => b.key === offsetDay("2026-10-02", -3)).claude > 0);
});

test("项目：同名末段补一级父目录；不受项目筛选、受 Agent 筛选", () => {
  const summary = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, homes: { "server-01": "/home/u" } });
  const labels = summary.projects.map((p) => p.label).sort();
  assert.deepEqual(labels, ["Digital_twin/GNN", "ops/GNN"]);
  const filtered = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, project: "~/ops/GNN", homes: { "server-01": "/home/u" } });
  assert.equal(filtered.projects.length, 2);
  assert.equal(filtered.kpis.calls, 2);
  const codexOnly = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, agent: "codex", homes: { "server-01": "/home/u" } });
  assert.equal(codexOnly.projects.length, 1);
});

test("会话：状态只凭日志判断；上下文取最近一次成功主线调用，Claude 标估算", () => {
  const summary = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1 });
  const claude = summary.sessions.find((s) => s.sid === "cl-1");
  assert.equal(claude.status, "recent");
  assert.equal(claude.context.tokens, 1102); // 子 Agent 调用（50000）不算主线上下文
  assert.equal(claude.context.window, 200000);
  assert.equal(claude.context.estimated, true);
  const codex = summary.sessions.find((s) => s.sid === "cx-1");
  assert.equal(codex.status, "quiet");
  assert.deepEqual([codex.context.window, codex.context.estimated], [258400, false]);
  assert.equal(claudeWindow("claude-opus-5-5[1m]", 0), 1_000_000);
  assert.equal(claudeWindow("claude-opus-5-5", 300_000), 1_000_000);
});

test("日历与近 7 日均值：采集起始之前的日子不计入", () => {
  const summary = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, coverageStart: "2026-09-29" });
  assert.equal(summary.calendar["2026-09-29"].calls, 1);
  assert.equal(summary.kpis.freshVsAvg.days, 3);
  assert.equal(summary.kpis.freshVsAvg.sameTime, true);
  const none = buildUsageSummary(snapshot(), { nowSec: NOW, range: 1, coverageStart: "2026-10-02" });
  assert.equal(none.kpis.freshVsAvg, null);
});

test("会话详情：Claude 按 turn_duration 区间归轮、区间外归「未记录结束」；Codex 按 turn_id", () => {
  const snap = snapshot();
  const claude = buildSessionDetail(snap, sessionKeyOf({ serverId: "server-01", agent: "claude", sid: "cl-1" }), { nowSec: NOW });
  assert.equal(claude.turns.length, 2);
  assert.deepEqual(claude.turns[0].calls.map((c) => c.rid), ["a", "b", "s", "e"]);
  assert.equal(claude.turns[0].durationSec, 180);
  assert.equal(claude.turns[0].compacted, true);
  assert.equal(claude.turns[0].stats.errors, 1);
  assert.equal(claude.turns[1].open, true);
  assert.deepEqual(claude.turns[1].calls.map((c) => c.rid), ["c"]);
  assert.equal(claude.contextSeries.length, 3); // 子 Agent 与失败调用不进上下文曲线

  const codex = buildSessionDetail(snap, sessionKeyOf({ serverId: "server-01", agent: "codex", sid: "cx-1" }), { nowSec: NOW });
  assert.deepEqual(codex.turns.map((t) => [t.calls.length, t.durationSec]), [[2, 240]]);
  assert.equal(buildSessionDetail(snap, "nope", { nowSec: NOW }), null);
});

test("无状态码失败按错误原文归类计数；会话详情的失败调用带原文与类别", () => {
  const fail = (rid, minute, patch) => call(rid, at(14, minute), { ok: false, code: null, inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, prompt: 0, ...patch });
  const snap = snapshot();
  snap.calls.push(
    fail("n1", 10, { errorText: "API Error: The response stopped arriving.", errorDropped: false }),
    fail("n2", 11, { errorText: "API Error: The response stopped arriving.", errorDropped: false }),
    fail("n3", 12, { errorText: null, errorDropped: false }),
    fail("n4", 13, { errorText: "", errorDropped: false }),
    fail("c5", 14, { code: 502, errorText: "API Error: 502 Cannot reach the reclaude gateway.", errorDropped: false }),
  );
  const k = buildUsageSummary(snap, { nowSec: NOW }).kpis;
  // 有状态码的失败只进 codes，不进 causes（码本身已说明）
  assert.deepEqual(k.causes, { stream_stopped: 2, unrecorded: 1, empty: 1 });
  assert.equal(k.codes.error, 4);

  const detail = buildSessionDetail(snap, sessionKeyOf({ serverId: "server-01", agent: "claude", sid: "cl-1" }), { nowSec: NOW });
  const calls = Object.fromEntries(detail.turns.flatMap((t) => t.calls).map((c) => [c.rid, c]));
  assert.deepEqual([calls.n1.errorKind, calls.n1.errorText], ["stream_stopped", "API Error: The response stopped arriving."]);
  assert.deepEqual([calls.n3.errorKind, calls.n3.errorText], ["unrecorded", null]);
  assert.equal(calls.c5.errorKind, "gateway_unreachable");
  assert.ok(!("errorText" in calls.a)); // 成功调用不带原文字段
});

test("projectPath：家目录前缀显示为 ~", () => {
  assert.equal(projectPath("/home/u/a/b", "/home/u"), "~/a/b");
  assert.equal(projectPath("/home/uu/a", "/home/u"), "/home/uu/a");
  assert.equal(projectPath(null, "/home/u"), null);
});

test("会话健康诊断与 Slurm 作业关联：高频压缩 / 低缓存命中率提示，以及匹配会话期间同目录提交的 Slurm 作业", () => {
  assert.equal(evaluateSessionHealth({ calls: 5, errors: 0, hitRate: 0.1, fresh: 100000 }, 0), null, "成功调用不足 8 次不报低缓存");
  const lowCache = evaluateSessionHealth({ calls: 10, errors: 0, hitRate: 0.15, fresh: 80000 }, 0);
  assert.equal(lowCache.kind, "low-cache");
  assert.match(lowCache.label, /命中偏低 15%/);

  const highCompact = evaluateSessionHealth({ calls: 10, errors: 0, hitRate: 0.9, fresh: 1000 }, 3);
  assert.equal(highCompact.kind, "high-compact");
  assert.match(highCompact.label, /压缩 3 次/);

  const snap = snapshot();
  const sessions = listSessionsForJobs(snap, "server-01");
  assert.equal(sessions.length, 3);
  const regEntries = [
    { jobId: "18901", name: "gnn_train", workDir: "/home/u/Digital_twin/GNN/exp1", firstSeenAt: at(14, 10) * 1000 },
    { jobId: "18902", name: "other_job", workDir: "/home/u/other", firstSeenAt: at(14, 10) * 1000 },
  ];
  const detail = buildSessionDetail(snap, sessionKeyOf({ serverId: "server-01", agent: "claude", sid: "cl-1" }), { nowSec: NOW, regEntries });
  assert.deepEqual(detail.slurmJobs, [{ jobId: "18901", name: "gnn_train" }]);
});

test("成本账单折算与缓存净节省：按模型分档计价，失败调用不计费", () => {
  assert.equal(modelPricingOf("claude-opus-4-6", "claude").input, 15);
  assert.equal(modelPricingOf("claude-sonnet-4-6", "claude").input, 3);
  assert.equal(modelPricingOf("gpt-5.3-codex", "codex").input, 2.5);

  const c = estimateCallCost({
    ok: true,
    agent: "claude",
    model: "claude-sonnet-4-6",
    inFresh: 1_000_000,
    cacheWrite: 0,
    cacheRead: 2_000_000,
    output: 100_000,
  });
  // input: $3, cacheRead: 2 * $0.3 = $0.6, output: 0.1 * $15 = $1.5 => $5.1
  // saved: 2M * ($3 - $0.3)/1M = $5.4
  assert.ok(Math.abs(c.costUsd - 5.1) < 1e-6);
  assert.ok(Math.abs(c.savedUsd - 5.4) < 1e-6);
  assert.deepEqual(estimateCallCost({ ok: false, inFresh: 1_000_000 }), { costUsd: 0, savedUsd: 0 });

  const sum = buildUsageSummary(snapshot(), { nowSec: NOW });
  assert.ok(sum.kpis.costUsd > 0);
  assert.ok(sum.kpis.savedUsd > 0);
});

test("多 Agent 自动发现与聚合：Antigravity / Gemini / ZCode / 自定义 AI 的上下文窗口、趋势桶与会话明细", () => {
  assert.equal(modelPricingOf("gemini-3-flash-preview", "antigravity").input, 0.3);
  assert.equal(modelPricingOf("gemini-2.5-pro", "gemini").input, 1.25);
  assert.equal(modelPricingOf("glm-5.1", "zcode").input, 0.4);

  const snap = snapshot();
  snap.sessions.push({ serverId: "server-01", agent: "antigravity", sid: "ag-1", cwd: "/home/u/ops/GNN", window: 1048576 });
  snap.calls.push(
    call("ag-c1", at(10, 0), { agent: "antigravity", sid: "ag-1", model: "gemini-3-flash-preview", inFresh: 2000, cacheWrite: 0, cacheRead: 8000, output: 500, prompt: 10000, turnId: "step-0" }),
    call("ag-c2", at(10, 1), { agent: "antigravity", sid: "ag-1", model: "gemini-3-flash-preview", inFresh: 1500, cacheWrite: 0, cacheRead: 10000, output: 400, prompt: 11500, turnId: "step-0" }),
  );
  snap.turns.push({ serverId: "server-01", agent: "antigravity", sid: "ag-1", tid: "step-0", t0: at(10, 0), t1: at(10, 2) });

  const sum = buildUsageSummary(snap, {
    nowSec: NOW,
    range: 1,
    homes: { "server-01": "/home/u" },
    sources: [{ id: "server-01", installed: ["codex", "claude", "antigravity", "zcode"], roots: { antigravity: true } }],
  });
  assert.deepEqual(sum.detectedAgents, ["codex", "claude", "antigravity", "zcode"]);
  assert.equal(sum.trend.buckets[10].antigravity, (2000 + 8000 + 500) + (1500 + 10000 + 400));
  const opsProj = sum.projects.find((p) => p.label === "ops/GNN");
  assert.equal(opsProj.byAgent.antigravity, 22400);
  const agRow = sum.sessions.find((s) => s.agent === "antigravity" && s.sid === "ag-1");
  assert.deepEqual([agRow.context.window, agRow.context.estimated], [1048576, false]);

  const agDetail = buildSessionDetail(snap, sessionKeyOf({ serverId: "server-01", agent: "antigravity", sid: "ag-1" }), { nowSec: NOW });
  assert.equal(agDetail.turns.length, 1);
  assert.equal(agDetail.turns[0].calls.length, 2);
  assert.equal(agDetail.turns[0].durationSec, 120);
});



test("成本洞察：跨日会话 Top 5 仅算所选时段，保留全会话契约，三维模型筛选一致", () => {
  const snap = snapshot();
  snap.calls.find(c => c.rid === "e").model = null;
  snap.calls.push(call("expensive-yesterday", at(10, 0, -1), { inFresh: 1_000_000, sid: "cl-1" }));
  const summary = buildUsageSummary(snap, { nowSec: NOW, range: 1, model: "claude-opus-5-5", homes: { "server-01": "/home/u" } });
  assert.equal(summary.models.length, 1);
  assert.equal(summary.kpis.calls, 4, "有模型筛选时没有模型名的失败不归入该模型");
  const top = summary.insights.topSessions;
  assert.equal(top.length, 1);
  assert.equal(top[0].stats.calls, 4);
  assert.equal(top[0].stats.costUsd, summary.kpis.costUsd);
  assert.ok(summary.sessions[0].stats.costUsd > top[0].stats.costUsd, "旧会话行仍是全会话累计");
  assert.equal(summary.projects.reduce((n, p) => n + p.stats.calls, 0), summary.kpis.calls);
  assert.equal(summary.byAgent.reduce((n, p) => n + p.calls, 0), summary.kpis.calls);
  const detail = buildSessionDetail(snap, top[0].key, { nowSec: NOW });
  assert.ok(detail.stats.costUsd > top[0].stats.costUsd);
});

test("同期对比：北京时间对齐上周期末日时刻，完整旧日不截短；缓存率按输入加权", () => {
  const snap = { sessions: [], turns: [], compacts: [], calls: [
    call("current", at(14), { inFresh: 900, cacheWrite: 0, cacheRead: 100 }),
    call("previous", at(14, 0, -7), { inFresh: 100, cacheWrite: 0, cacheRead: 900 }),
    call("previous-too-late", at(16, 0, -7), { inFresh: 1_000_000 }),
    call("previous-first-full-day", at(23, 0, -13), { inFresh: 100, cacheWrite: 0, cacheRead: 100 }),
  ] };
  const opts = { nowSec: NOW, range: 7, coverageStart: "2026-09-01" };
  const s = buildUsageSummary(snap, opts);
  const c = s.insights.comparison;
  assert.deepEqual(c.previousScope, { start: "2026-09-19", end: "2026-09-25" });
  assert.equal(c.sameTime, true);
  assert.equal(c.previous.calls, 2);
  assert.equal(c.previous.hitRate, 1000 / 1200);
  assert.equal(c.hitRateDelta, 0.1 - 1000 / 1200);
  assert.ok(c.costRatio > 1);
  assert.equal(s.trend.buckets.at(-1).input, 1000);
  assert.equal(s.trend.buckets.at(-1).cacheRead, 100);
  assert.equal(Math.round(s.trend.buckets.at(-1).costUsd * 10000) / 10000, s.kpis.costUsd);
  const insufficient = buildUsageSummary(snap, { ...opts, coverageStart: "2026-10-01" }).insights.comparison;
  assert.equal(insufficient.costRatio, null);
  assert.equal(insufficient.hitRateDelta, null);
  const backfill = buildUsageSummary(snap, { ...opts, sources: [{ complete: false }] }).insights.comparison;
  assert.equal(backfill.scanIncomplete, true);
  assert.equal(backfill.costRatio, null);
});

test("会话静态统计缓存不冻结近期状态；空数据和前期零花费不制造涨跌", () => {
  const snap = snapshot();
  const first = buildUsageSummary(snap, { nowSec: NOW });
  const later = buildUsageSummary(snap, { nowSec: NOW + 600 });
  assert.equal(first.sessions.find(s => s.sid === "cl-1").status, "recent");
  assert.equal(later.sessions.find(s => s.sid === "cl-1").status, "quiet");
  assert.equal(later.insights.comparison.costRatio, null);
  const empty = buildUsageSummary({ calls: [], sessions: [], turns: [], compacts: [] }, { nowSec: NOW, coverageStart: "2026-01-01" });
  assert.deepEqual(empty.insights.topSessions, []);
  assert.equal(empty.insights.comparison.costRatio, null);
  assert.equal(empty.insights.comparison.hitRateDelta, null);
});

test("成本榜严格取最高五项；历史日期超出摘要快照范围时禁止错误环比", () => {
  const snap = { turns: [], compacts: [], sessions: [], calls: Array.from({ length: 8 }, (_, i) => call(`top-${i}`, NOW - i, { sid: `s-${i}`, inFresh: (i + 1) * 1000 })) };
  const summary = buildUsageSummary(snap, { nowSec: NOW, range: 30, coverageStart: "2026-01-01" });
  assert.deepEqual(summary.insights.topSessions.map(s => s.sid), ["s-7", "s-6", "s-5", "s-4", "s-3"]);
  const missing = buildUsageSummary(snap, { nowSec: NOW, date: "2026-08-01", coverageStart: "2026-01-01", snapshotStart: "2026-08-01" });
  assert.equal(missing.insights.comparison.covered, false);
  assert.equal(missing.insights.comparison.tokenRatio, null);
});
