import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIncidentContext, CONTEXT_AFTER_MS, CONTEXT_BEFORE_MS, CONTEXT_EDGE_MS, contextWindow } from "./context.mjs";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 2, 0, 0);
const base = { incidentId: "me", serverId: "s1", agentId: null, component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", lifecycle: "resolved", firstSeenAt: T0, lastSeenAt: T0 + 3 * MIN, resolvedAt: T0 + 4 * MIN };

test("时间窗：开始前 10 分钟到恢复后 10 分钟（不超过现在）；未恢复的到现在；太长时只看开始与结束两段", () => {
  assert.deepEqual(contextWindow(base, { nowMs: T0 + 60 * MIN }).ranges, [[T0 - CONTEXT_BEFORE_MS, T0 + 4 * MIN + CONTEXT_AFTER_MS]]);
  assert.deepEqual(contextWindow({ ...base, lifecycle: "open", resolvedAt: null }, { nowMs: T0 + 5 * MIN }).ranges, [[T0 - CONTEXT_BEFORE_MS, T0 + 5 * MIN]]);
  const long = contextWindow({ ...base, resolvedAt: T0 + 24 * 60 * MIN }, { nowMs: T0 + 48 * 60 * MIN });
  assert.equal(long.ranges.length, 2);
  assert.deepEqual(long.gap, { from: T0 + CONTEXT_EDGE_MS, to: T0 + 24 * 60 * MIN - CONTEXT_EDGE_MS });
  assert.equal(contextWindow({ firstSeenAt: "x" }), null);
});

test("前后经过：断线账本（本服务器的断开 / 重连、配置变更、全局休眠）+ 同服务器其它类型的事件（同类的不重复列） + 处置 + 信号 + 日志，按时刻排", () => {
  const ledger = [
    { type: "down", at: T0 - 2 * MIN, serverId: "s1", cause: "process-lost", sleep: true },
    { type: "wake", at: T0 - MIN, sleptMs: 3 * MIN },
    { type: "down", at: T0 + MIN, serverId: "s1", cause: "config-change", planned: true },
    { type: "up", at: T0 + 3 * MIN, serverId: "s1", downMs: 2 * MIN, attempts: 2, via: "spawned" },
    { type: "down", at: T0 + MIN, serverId: "s2", cause: "port-closed" },
    { type: "down", at: T0 - 60 * MIN, serverId: "s1", cause: "port-closed" },
    { type: "alive", at: T0 },
  ];
  const me = { ...base, dispositions: [{ operationId: "op-1", at: T0 + 2 * MIN, action: "restart-tunnel", trigger: "manual", outcome: "recovered", afterMs: 2 * MIN }] };
  const incidents = [
    me,
    { ...base, incidentId: "chan", component: "channel", reasonCode: "REMOTE_PORT_CLOSED", lifecycle: "open", resolvedAt: null, firstSeenAt: T0 + 30_000 },
    { ...base, incidentId: "other-server", serverId: "s2", firstSeenAt: T0 + 30_000 },
    { ...base, incidentId: "same-type-sibling", firstSeenAt: T0 - 5 * MIN, resolvedAt: T0 - 3 * MIN },
  ];
  const history = [
    { type: "signal", ts: T0 + 90_000, severity: "warn", signalId: "rate-limited", title: "账号限流（429）", rootCause: "account" },
    { type: "signal", ts: T0 + 90_000, severity: "info", signalId: "x", title: "不收 info" },
    { type: "levels", ts: T0 - 5 * MIN, cause: "start", unclean: true },
    { type: "levels", ts: T0 - 4 * MIN, cause: "view" },
    { type: "sample", ts: T0 },
  ];
  const logs = [
    { ts: T0 + 2 * MIN, event: "auto-repair", operationId: "op-1", message: "重复：已有处置记录" },
    { ts: T0 + 2.5 * MIN, event: "auto-repair", operationId: "op-2", serverId: "s1", ruleId: "tunnel-down", message: "auto restart" },
    { ts: T0 + 2.5 * MIN, event: "auto-repair", message: "只观察，没动手" },
    { ts: T0 + 2.6 * MIN, event: "auto-repair", operationId: "op-3", serverId: "s2", message: "别的服务器" },
    { ts: T0 + 20_000, event: "supervisor-handoff", message: "handoff ok" },
    { ts: T0 + 40_000, message: "config.json changed on disk, reloading into kernel" },
    { ts: T0 + 50_000, event: "probe", message: "无关" },
  ];
  const ctx = buildIncidentContext({ incident: me, incidents, ledger, history, logs, nowMs: T0 + 60 * MIN });
  assert.equal(ctx.incidentId, "me");
  assert.equal(ctx.truncated, 0);
  assert.deepEqual(ctx.entries.map((e) => [e.at - T0, e.kind, e.self ?? e.scope ?? null]), [
    [-5 * MIN, "monitor-start", "local"],
    [-4 * MIN, "sleep", "local"],
    [-2 * MIN, "tunnel-down", null],
    [0, "incident-open", true],
    [20_000, "handoff", "local"],
    [30_000, "incident-open", false],
    [40_000, "config", "local"],
    [MIN, "config", null],
    [90_000, "signal", "view"],
    [2 * MIN, "disposition", true],
    [2.5 * MIN, "auto-repair", "local"],
    [3 * MIN, "tunnel-up", null],
    [4 * MIN, "incident-resolved", true],
  ]);
  const sleep = ctx.entries.find((e) => e.kind === "sleep");
  assert.equal(sleep.sleptMs, 3 * MIN);
  assert.equal(ctx.entries.find((e) => e.kind === "tunnel-down").sleep, true);
  assert.equal(ctx.entries.find((e) => e.kind === "disposition").afterMs, 2 * MIN);
  assert.equal(ctx.entries.find((e) => e.kind === "signal").signalId, "rate-limited");
});

test("前后经过：条目过多时保留离开始 / 结束最近的，并说明省略了几条；没有时刻的事件返回 null", () => {
  const ledger = Array.from({ length: 80 }, (_, i) => ({ type: i % 2 ? "up" : "down", at: T0 - 9 * MIN + i * 5000, serverId: "s1" }));
  const ctx = buildIncidentContext({ incident: base, ledger, nowMs: T0 + 60 * MIN, maxEntries: 20 });
  assert.equal(ctx.entries.length, 20);
  assert.equal(ctx.truncated, 62);
  assert.ok(ctx.entries.some((e) => e.kind === "incident-open" && e.self));
  assert.ok(ctx.entries.some((e) => e.kind === "incident-resolved" && e.self));
  for (let i = 1; i < ctx.entries.length; i += 1) assert.ok(ctx.entries[i].at >= ctx.entries[i - 1].at, "仍按时刻排");
  assert.equal(buildIncidentContext({ incident: { incidentId: "x" } }), null);
});
