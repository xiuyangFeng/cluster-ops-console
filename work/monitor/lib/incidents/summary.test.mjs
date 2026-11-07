// 事件「按类型汇总」与逐日计数（store.mjs 的 summarize / dayCounts，persister.mjs 的回填后重写）。
// 假时钟驱动，无 IO。日子一律按北京自然日。
import assert from "node:assert/strict";
import { test } from "node:test";

import { INCIDENT_SAVE_URGENT_DELAY_MS, createIncidentPersister } from "./persister.mjs";
import {
  createIncidentStore,
  INCIDENT_DAY_COUNT_MAX_TYPES,
  INCIDENT_DAY_COUNT_RETENTION_DAYS,
  INCIDENT_FILE_MAX_BYTES,
  INCIDENT_MAX_CLOSED_PER_FINGERPRINT,
  INCIDENT_SUMMARY_DEFAULT_DAYS,
  INCIDENT_SUMMARY_RECENT_MAX,
} from "./store.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// 北京时间 2026 年某月某日某时某分 → epoch ms
const beijing = (month, day, hour = 0, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute);
const NOON = beijing(10, 3, 12); // 2026-10-03 12:00

function makeStore({ now = NOON, overrides = {} } = {}) {
  let clock = now;
  let seq = 0;
  const store = createIncidentStore({
    openGate: {}, now: () => clock, randomUUID: () => `id-${String(++seq).padStart(4, "0")}`, log: () => {}, ...overrides,
  });
  return { store, tick: (ms) => { clock += ms; }, setClock: (ms) => { clock = ms; } };
}

// 一次完整的「发生 → 恢复」：at 首见，持续 lasting 后恢复。返回这条事件。
function cycle(ctx, { serverId = "srv-a", component = "tunnel", agentId = null, reasonCode = "TUNNEL_DOWN", severity = "error", at, lasting = MIN, operationId } = {}) {
  if (at != null) ctx.setClock(at);
  const incident = ctx.store.observe({ serverId, agentId, component, reasonCode, severity });
  if (operationId) ctx.store.linkOperation(incident.incidentId, operationId);
  ctx.tick(lasting);
  ctx.store.reportSuccess({ serverId, agentId, component });
  ctx.store.reportSuccess({ serverId, agentId, component });
  return incident;
}

// 旧版本写的已关闭事件（没有逐日计数字段的文件里的一条）。
const closedItem = (incidentId, { resolvedAt, lasting = MIN, ...fields }) => ({
  incidentId, lifecycle: "resolved", severity: "warn", occurrences: 1,
  firstSeenAt: resolvedAt - lasting, lastSeenAt: resolvedAt - Math.min(lasting, 30_000), resolvedAt,
  evidenceRefs: [], relatedOperationIds: [], relatedIncidentIds: [], notes: [],
  attention: { acknowledgedAt: null, snoozedUntil: null, snoozeReason: null },
  ...fields,
});
const legacyClosedFile = (closed) => ({ schemaVersion: 1, savedAt: 1, closed });
const SPLIT_MAIN = { schemaVersion: 1, savedAt: 1, closedSplit: true, active: [], removedServers: [] };
const typeOf = (summary, predicate) => summary.types.find(predicate);
const savedDayCounts = (store) => JSON.parse(store.serializeClosedForSave()).dayCounts;

test("逐日计数: 恢复时按北京自然日记数；跨零点的事件两天都算发生中、次数只算一次", () => {
  const ctx = makeStore();
  // 10-02 23:50 发生，10-03 00:10 恢复（UTC 都在 10-02，北京时间跨了零点）。
  cycle(ctx, { at: beijing(10, 2, 23, 50), lasting: 20 * MIN });
  // UTC 10-02 17:00 = 北京 10-03 01:00：按北京时间算在 10-03。
  cycle(ctx, { at: Date.UTC(2026, 9, 2, 17, 0), lasting: MIN });
  ctx.setClock(NOON);
  const summary = ctx.store.summarize({ days: 3 });
  assert.deepEqual(summary.days, ["2026-10-01", "2026-10-02", "2026-10-03"]);
  assert.equal(summary.types.length, 1);
  const [type] = summary.types;
  assert.deepEqual(type.perDay, [0, 1, 2], "每天处于发生中的条数");
  assert.equal(type.count, 2, "次数按恢复那天算，跨零点的只算一次");
  assert.equal(type.capped, false);
  assert.equal(type.coverageStart, null);
  assert.equal(summary.total, 2);
  assert.equal(summary.capped, false);
  assert.equal(summary.countingSince, beijing(10, 3, 0, 10), "逐日计数从第一条恢复记录起");
  assert.deepEqual(savedDayCounts(ctx.store).types[0].days, { "2026-10-02": [1, 0], "2026-10-03": [2, 2] });
});

test("逐日计数: 次数不受每类留存限额影响；留存的逐条记录仍只有最近几条", () => {
  const ctx = makeStore({ now: beijing(10, 3, 8), overrides: { maxClosedPerFingerprint: 3 } });
  for (let i = 0; i < 10; i += 1) cycle(ctx, { serverId: "srv-a", agentId: "codex", component: "agent", reasonCode: "DEGRADED", severity: "warn" });
  const summary = ctx.store.summarize();
  assert.equal(summary.days.length, INCIDENT_SUMMARY_DEFAULT_DAYS);
  const [type] = summary.types;
  assert.equal(type.key, "srv-a|agent:codex|DEGRADED");
  assert.equal(type.count, 10, "计数不跟着已关闭池一起淘汰");
  assert.equal(type.perDay.at(-1), 10);
  assert.equal(type.retained, 3);
  assert.equal(type.recent.length, 3);
  assert.equal(type.capped, false, "上线后才出现的类型，每一天都是准确的");
  assert.equal(summary.keepPerType, 3);
  assert.equal(summary.retained, 3);
  assert.equal(ctx.store.query({ state: "resolved" }).total, 3);
});

test("汇总: 类型按最近一次发生倒序；持续时长取留存记录的中位与最长；严重度取最高；最近几条带处置日志入口", () => {
  const ctx = makeStore({ now: beijing(10, 3, 6) });
  const base = beijing(10, 3, 6);
  // 隧道：1 / 3 / 5 / 10 分钟四条（偶数条 → 中位取中间两条的平均）。
  for (const [i, minutes] of [1, 3, 5, 10].entries()) {
    cycle(ctx, { at: base + i * 20 * MIN, lasting: minutes * MIN, severity: i === 2 ? "error" : "warn" });
  }
  // Agent：12 条，各 2 分钟；最后一条关联了一次处置。
  for (let i = 0; i < 12; i += 1) {
    cycle(ctx, {
      serverId: "srv-a", agentId: "claude", component: "agent", reasonCode: "DEGRADED", severity: "warn",
      at: base + 2 * HOUR + i * 10 * MIN, lasting: 2 * MIN, operationId: i === 11 ? "op-last" : undefined,
    });
  }
  // 全局（没有服务器）的事件也是一类。
  cycle(ctx, { serverId: null, component: "proxy", reasonCode: "PROXY_DOWN", at: base + 5 * HOUR, lasting: 30_000 });
  ctx.setClock(NOON + 6 * HOUR);
  const summary = ctx.store.summarize({ days: 14 });
  assert.deepEqual(summary.types.map((type) => type.key), ["global|proxy|PROXY_DOWN", "srv-a|agent:claude|DEGRADED", "srv-a|tunnel|TUNNEL_DOWN"]);
  const tunnel = typeOf(summary, (type) => type.component === "tunnel");
  assert.equal(tunnel.medianMs, 4 * MIN);
  assert.equal(tunnel.longestMs, 10 * MIN);
  assert.equal(tunnel.samples, 4);
  assert.equal(tunnel.severity, "error", "留存记录里最高的严重度");
  assert.equal(tunnel.serverId, "srv-a");
  assert.equal(tunnel.agentId, null);
  assert.equal(tunnel.lastSeenAt, base + 3 * 20 * MIN, "最近一次发生 = 最后一次看到故障的时刻");
  assert.equal(tunnel.lastResolvedAt, base + 3 * 20 * MIN + 10 * MIN);
  const agent = typeOf(summary, (type) => type.component === "agent");
  assert.equal(agent.agentId, "claude");
  assert.equal(agent.count, 12);
  assert.equal(agent.retained, 12);
  assert.equal(agent.recent.length, INCIDENT_SUMMARY_RECENT_MAX);
  assert.deepEqual(Object.keys(agent.recent[0]), ["incidentId", "firstSeenAt", "lastSeenAt", "resolvedAt", "occurrences", "operationId"]);
  assert.equal(agent.recent[0].operationId, "op-last", "最新的排最前，带最近一次处置的 operationId");
  assert.equal(agent.recent[1].operationId, null);
  assert.ok(agent.recent[0].resolvedAt > agent.recent[7].resolvedAt);
  const global = typeOf(summary, (type) => type.component === "proxy");
  assert.equal(global.serverId, null);
  assert.equal(summary.total, 17);
  assert.equal(summary.retained, 17);
  // 类型的 key 就是逐条查询的筛选值。
  const onlyAgent = ctx.store.query({ state: "resolved", fingerprint: agent.key, limit: 50 });
  assert.equal(onlyAgent.total, 12);
  assert.ok(onlyAgent.incidents.every((incident) => incident.component === "agent"));
  assert.equal(ctx.store.query({ state: "resolved", fingerprint: "nope|tunnel|TUNNEL_DOWN" }).total, 0);
});

test("汇总: days 取 1–31，非法值用缺省 14；窗口含今天，按北京自然日从旧到新", () => {
  const ctx = makeStore();
  cycle(ctx, { at: beijing(10, 3, 9) });
  ctx.setClock(NOON);
  assert.equal(ctx.store.summarize().days.length, 14);
  assert.equal(ctx.store.summarize({ days: 0 }).days.length, 14);
  assert.equal(ctx.store.summarize({ days: "abc" }).days.length, 14);
  assert.equal(ctx.store.summarize({ days: -2 }).days.length, 14);
  assert.equal(ctx.store.summarize({ days: "7" }).days.length, 7);
  assert.equal(ctx.store.summarize({ days: 1 }).days[0], "2026-10-03");
  const wide = ctx.store.summarize({ days: 500 });
  assert.equal(wide.days.length, INCIDENT_DAY_COUNT_RETENTION_DAYS);
  assert.equal(wide.days[0], "2026-09-03");
  assert.equal(wide.days.at(-1), "2026-10-03");
  // 北京时间零点前后：UTC 15:59 还是 10-03，16:00 已是 10-04。
  ctx.setClock(Date.UTC(2026, 9, 3, 15, 59));
  assert.equal(ctx.store.summarize({ days: 1 }).days[0], "2026-10-03");
  ctx.setClock(Date.UTC(2026, 9, 3, 16, 0));
  assert.equal(ctx.store.summarize({ days: 1 }).days[0], "2026-10-04");
});

test("回填: 旧文件没有计数 → 按留存记录回填；顶到限额的类型在最旧留存之前标成记录已清理、次数是下限", () => {
  assert.equal(INCIDENT_MAX_CLOSED_PER_FINGERPRINT, 50);
  const noisy = Array.from({ length: 50 }, (_, i) => closedItem(`a-${i}`, {
    serverId: "srv-a", agentId: "codex", component: "agent", reasonCode: "DEGRADED", resolvedAt: beijing(10, 1, 10) + i * 30 * MIN,
  }));
  const steady = Array.from({ length: 5 }, (_, i) => closedItem(`b-${i}`, {
    serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", resolvedAt: beijing(9, 25 + i, 9), lasting: 2 * MIN,
  }));
  const disk = closedItem("c-0", {
    serverId: "srv-a", component: "filesystem", reasonCode: "DISK_THRESHOLD", severity: "error",
    resolvedAt: beijing(10, 3, 9), lasting: beijing(10, 3, 9) - beijing(9, 10, 8),
  });
  const stale = closedItem("d-0", { serverId: "srv-b", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(9, 1, 9) });
  const ctx = makeStore();
  const info = ctx.store.loadSnapshot(SPLIT_MAIN, { closed: legacyClosedFile([...noisy, ...steady, disk, stale]) });
  assert.equal(info.dayCountsBackfilled, true);
  const summary = ctx.store.summarize({ days: 14 });
  assert.equal(summary.days[0], "2026-09-20");
  assert.equal(summary.countingSince, NOON, "逐日计数从首次带本功能加载这一刻起独立记录");
  assert.deepEqual(summary.types.map((type) => `${type.component}@${type.serverId}`), ["filesystem@srv-a", "agent@srv-a", "tunnel@srv-a", "tunnel@srv-b"]);

  const agent = typeOf(summary, (type) => type.component === "agent");
  assert.equal(agent.capped, true);
  assert.equal(agent.coverageStart, "2026-10-01", "最旧一条留存记录那天；更早的日子记录已清理");
  assert.equal(agent.count, 50, "只是下限（界面写成 50+）");
  // 10-01 10:00 起每 30 分钟一条：10-01 当天恢复 28 条，另有一条 23:59 发生、次日 00:00 恢复。
  assert.deepEqual(agent.perDay.slice(-3), [29, 22, 0]);
  assert.ok(agent.perDay.slice(0, 11).every((n) => n === 0), "边界之前没有留存记录，格子里是 0——由 coverageStart 标成已清理而不是当成没发生");
  assert.equal(agent.retained, 50);

  const tunnel = typeOf(summary, (type) => type.component === "tunnel" && type.serverId === "srv-a");
  assert.equal(tunnel.capped, false, "没顶到限额的类型，留存记录就是全部");
  assert.equal(tunnel.coverageStart, null);
  assert.equal(tunnel.count, 5);
  assert.deepEqual(tunnel.perDay, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0]);

  const filesystem = typeOf(summary, (type) => type.component === "filesystem");
  assert.equal(filesystem.count, 1, "持续 23 天的一条：次数 1");
  assert.deepEqual(filesystem.perDay, Array(14).fill(1), "但窗口里每一天都处于发生中");
  assert.equal(filesystem.longestMs, beijing(10, 3, 9) - beijing(9, 10, 8));

  const old = typeOf(summary, (type) => type.serverId === "srv-b");
  assert.equal(old.count, 0, "窗口内没发生过的类型仍然列出，次数为 0");
  assert.deepEqual(old.perDay, Array(14).fill(0));
  assert.equal(old.retained, 1);
  assert.equal(old.lastResolvedAt, beijing(9, 1, 9));

  assert.equal(summary.total, 56);
  assert.equal(summary.capped, true);
  assert.equal(summary.retained, 57);

  // 持久化的形状：边界记在类型上；超出保留期（31 天）的那一类不进计数。
  const saved = savedDayCounts(ctx.store);
  assert.equal(saved.v, 1);
  assert.equal(saved.since, NOON);
  assert.equal(saved.types.length, 3);
  const savedAgent = saved.types.find((type) => type.component === "agent");
  assert.deepEqual(Object.keys(savedAgent), ["serverId", "agentId", "component", "reasonCode", "evictedBefore", "lastResolvedAt", "lastSeverity", "days"]);
  assert.equal(savedAgent.evictedBefore, beijing(10, 1, 10));
  assert.deepEqual(savedAgent.days, { "2026-10-01": [29, 28], "2026-10-02": [22, 22] });
  assert.equal(saved.types.find((type) => type.component === "tunnel").evictedBefore, null);

  // 上线之后：同一类再恢复一条 → 次数继续往上数，留存仍是 50 条，边界不动。
  cycle(ctx, { serverId: "srv-a", agentId: "codex", component: "agent", reasonCode: "DEGRADED", severity: "warn", at: NOON + HOUR });
  const after = typeOf(ctx.store.summarize({ days: 14 }), (type) => type.component === "agent");
  assert.equal(after.count, 51);
  assert.equal(after.perDay.at(-1), 1);
  assert.equal(after.retained, 50);
  assert.equal(after.coverageStart, "2026-10-01");
  // 边界滑出窗口之后，窗口内每一天都是准确的。
  ctx.setClock(beijing(10, 16, 12));
  const later = typeOf(ctx.store.summarize({ days: 14 }), (type) => type.component === "agent");
  assert.equal(later.capped, false);
  assert.equal(later.coverageStart, null);
  assert.equal(later.count, 1, "窗口 10-03…10-16 里只有上线后的那一条");
});

test("回填: 已关闭池顶到全局上限时，全池最旧一条之前的日子对所有类型都不完整", () => {
  const ctx = makeStore({ overrides: { maxClosed: 6 } });
  const closed = [
    ...Array.from({ length: 4 }, (_, i) => closedItem(`a-${i}`, { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(9, 28, 9) + i * DAY })),
    ...Array.from({ length: 2 }, (_, i) => closedItem(`b-${i}`, { serverId: "srv-a", component: "channel", reasonCode: "REMOTE_PORT_CLOSED", resolvedAt: beijing(10, 2, 9) + i * HOUR })),
  ];
  ctx.store.loadSnapshot(SPLIT_MAIN, { closed: legacyClosedFile(closed) });
  const summary = ctx.store.summarize({ days: 14 });
  assert.deepEqual(summary.types.map((type) => type.coverageStart), ["2026-09-28", "2026-09-28"]);
  assert.ok(summary.types.every((type) => type.capped));
});

test("持久化: 计数随已关闭文件保存，读回后汇总一致且不再回填；旧版单文件同样携带", () => {
  const ctx = makeStore({ now: beijing(10, 1, 8), overrides: { maxClosedPerFingerprint: 4 } });
  for (let i = 0; i < 9; i += 1) cycle(ctx, { at: beijing(10, 1, 8) + i * 5 * HOUR, lasting: 3 * MIN });
  cycle(ctx, { serverId: "srv-b", agentId: "codex", component: "agent", reasonCode: "AUTH_REQUIRED", at: beijing(10, 3, 10), lasting: 90_000 });
  ctx.setClock(NOON);
  const expected = ctx.store.summarize({ days: 14 });
  assert.equal(typeOf(expected, (type) => type.component === "tunnel").count, 9);

  const closedJson = ctx.store.serializeClosedForSave();
  const mainJson = ctx.store.serializeMainForSave();
  assert.equal(JSON.parse(mainJson).dayCounts, undefined, "拆分格式下计数只在已关闭文件里");
  const reloaded = makeStore({ overrides: { maxClosedPerFingerprint: 4 } });
  const info = reloaded.store.loadSnapshot(JSON.parse(mainJson), { closed: JSON.parse(closedJson) });
  assert.equal(info.dayCountsBackfilled, false);
  assert.deepEqual(reloaded.store.summarize({ days: 14 }), expected);
  assert.equal(reloaded.store.summarize().countingSince, beijing(10, 1, 8) + 3 * MIN, "计数起点不因重启后移");

  // 旧版单文件格式（fixture / 兼容场景）也带着计数。
  const legacy = makeStore({ overrides: { maxClosedPerFingerprint: 4 } });
  const legacyInfo = legacy.store.loadSnapshot(JSON.parse(ctx.store.serializeForSave()));
  assert.equal(legacyInfo.legacyClosed, true);
  assert.equal(legacyInfo.dayCountsBackfilled, false);
  assert.deepEqual(legacy.store.summarize({ days: 14 }), expected);

  // 没有计数字段时回填：留存只剩 4 条 → 次数退回下限并如实标记，而不是假装只发生过 4 次。
  const stripped = JSON.parse(closedJson);
  delete stripped.dayCounts;
  const backfilled = makeStore({ overrides: { maxClosedPerFingerprint: 4 } });
  assert.equal(backfilled.store.loadSnapshot(JSON.parse(mainJson), { closed: stripped }).dayCountsBackfilled, true);
  const tunnel = typeOf(backfilled.store.summarize({ days: 14 }), (type) => type.component === "tunnel");
  assert.equal(tunnel.count, 4);
  assert.equal(tunnel.capped, true);
  assert.equal(tunnel.coverageStart, "2026-10-02");
});

test("持久化: 计数字段损坏或版本不认识 → 当作没有、按留存记录回填；畸形条目逐条跳过，不抛错", () => {
  const ctx = makeStore({ now: beijing(10, 2, 9) });
  cycle(ctx, { at: beijing(10, 2, 9) });
  cycle(ctx, { at: beijing(10, 3, 9) });
  ctx.setClock(NOON);
  const closedFile = JSON.parse(ctx.store.serializeClosedForSave());
  const main = JSON.parse(ctx.store.serializeMainForSave());
  for (const broken of ["junk", { v: 99, types: [] }, { v: 1, types: "junk" }, null, 7]) {
    const target = makeStore();
    const info = target.store.loadSnapshot(main, { closed: { ...closedFile, dayCounts: broken } });
    assert.equal(info.dayCountsBackfilled, true, JSON.stringify(broken));
    assert.equal(target.store.summarize().types[0].count, 2);
  }
  const good = closedFile.dayCounts.types[0];
  const mixed = {
    v: 1,
    since: "yesterday",
    types: [
      null,
      "junk",
      { ...good, component: "!!" },
      { ...good, reasonCode: "lower-case" },
      { ...good, days: "junk" },
      { ...good, serverId: "srv-z", days: { "2026-10-03": "x", nope: [1, 1], "2026-10-02": [0, 5] } },
      { ...good, days: { ...good.days, "2026-10-03": [1e12, 1e12], "2026-10-01": [2, 9], bad: [1, 1] }, lastSeverity: "fatal", evictedBefore: -5 },
    ],
  };
  const target = makeStore();
  const info = target.store.loadSnapshot(main, { closed: { ...closedFile, dayCounts: mixed } });
  assert.equal(info.dayCountsBackfilled, false, "外层形状对就按文件里的来");
  const saved = savedDayCounts(target.store);
  assert.equal(saved.since, null);
  assert.equal(saved.types.length, 1, "只有最后一条有可用的日子");
  assert.deepEqual(saved.types[0].days, { "2026-10-02": [1, 1], "2026-10-03": [1_000_000, 1_000_000], "2026-10-01": [2, 2] }, "离谱的数字夹住；恢复数不超过发生数");
  assert.equal(saved.types[0].lastSeverity, null);
  assert.equal(saved.types[0].evictedBefore, null);
});

test("逐日计数: 只留最近 31 天；过期的日子在保存时清掉，类型本身只要还有留存记录就仍然列出", () => {
  const ctx = makeStore({ now: beijing(9, 1, 9) });
  cycle(ctx, { at: beijing(9, 1, 9) });
  cycle(ctx, { at: beijing(9, 5, 9) });
  ctx.setClock(beijing(10, 3, 12));
  // 10-03 往前 31 天（含当天）= 09-03 起：09-01 的格子过期，09-05 的还在。
  assert.deepEqual(savedDayCounts(ctx.store).types[0].days, { "2026-09-05": [1, 1] });
  const wide = ctx.store.summarize({ days: 31 });
  assert.equal(wide.types[0].count, 1);
  ctx.setClock(beijing(10, 20, 12));
  assert.deepEqual(savedDayCounts(ctx.store).types, []);
  const summary = ctx.store.summarize({ days: 14 });
  assert.equal(summary.types.length, 1);
  assert.equal(summary.types[0].count, 0);
  assert.equal(summary.types[0].retained, 2);
  assert.equal(summary.total, 0);
});

test("逐日计数: 指纹数封顶 200，淘汰最久没有恢复记录的；被淘汰的类型按留存记录现算，再次出现时重建", () => {
  const ctx = makeStore({ now: beijing(10, 3, 1) });
  const extra = 5;
  for (let i = 0; i < INCIDENT_DAY_COUNT_MAX_TYPES + extra; i += 1) cycle(ctx, { serverId: `srv-${i}`, lasting: 1000 });
  const saved = savedDayCounts(ctx.store);
  assert.equal(saved.types.length, INCIDENT_DAY_COUNT_MAX_TYPES);
  assert.equal(saved.types.some((type) => type.serverId === "srv-0"), false, "最早的几个被淘汰");
  assert.equal(saved.types.some((type) => type.serverId === `srv-${extra}`), true);
  const summary = ctx.store.summarize();
  assert.equal(summary.types.length, INCIDENT_DAY_COUNT_MAX_TYPES + extra, "没有计数条目的类型仍然列出");
  const evicted = typeOf(summary, (type) => type.serverId === "srv-0");
  assert.equal(evicted.count, 1, "按留存记录现算");
  assert.equal(evicted.capped, false);
  // 被淘汰的类型再次出现：条目按留存记录重建，不会从 0 重新数。
  cycle(ctx, { serverId: "srv-0", lasting: 1000 });
  assert.equal(typeOf(ctx.store.summarize(), (type) => type.serverId === "srv-0").count, 2);
  const again = savedDayCounts(ctx.store);
  assert.equal(again.types.length, INCIDENT_DAY_COUNT_MAX_TYPES);
  assert.deepEqual(again.types.find((type) => type.serverId === "srv-0").days, { "2026-10-03": [2, 2] });
});

test("服务器生命周期: 删除的服务器不出现在汇总里，恢复后原样回来；彻底清除后计数一并丢弃", () => {
  const ctx = makeStore({ now: beijing(10, 3, 8) });
  const servers = [{ id: "srv-a" }, { id: "srv-b" }];
  ctx.store.syncServerLifecycle({ servers, tombstones: [] });
  cycle(ctx, { serverId: "srv-a" });
  for (let i = 0; i < 3; i += 1) cycle(ctx, { serverId: "srv-b" });
  assert.deepEqual(ctx.store.summarize().types.map((type) => [type.serverId, type.count]), [["srv-b", 3], ["srv-a", 1]]);

  const removedAt = beijing(10, 3, 9);
  ctx.setClock(removedAt);
  ctx.store.syncServerLifecycle({ servers: [{ id: "srv-a" }], tombstones: [{ id: "srv-b", removedAt }] });
  const hidden = ctx.store.summarize();
  assert.deepEqual(hidden.types.map((type) => type.serverId), ["srv-a"]);
  assert.equal(hidden.total, 1);
  assert.equal(hidden.retained, 1);
  assert.equal(savedDayCounts(ctx.store).types.length, 2, "回收站里的服务器计数先留着");

  // 回收期内重启：计数与归档一起读回，恢复服务器后汇总原样回来。
  const reloaded = makeStore({ now: removedAt + HOUR });
  reloaded.store.loadSnapshot(JSON.parse(ctx.store.serializeMainForSave()), { closed: JSON.parse(ctx.store.serializeClosedForSave()) });
  reloaded.store.syncServerLifecycle({ servers: [{ id: "srv-a" }], tombstones: [{ id: "srv-b", removedAt }] });
  assert.deepEqual(reloaded.store.summarize().types.map((type) => type.serverId), ["srv-a"]);
  reloaded.store.syncServerLifecycle({ servers, tombstones: [] });
  assert.deepEqual(reloaded.store.summarize().types.map((type) => [type.serverId, type.count]), [["srv-b", 3], ["srv-a", 1]]);

  // 彻底清除（不在配置里、也没有删除记录）：计数跟着丢，并要求落盘。
  const before = ctx.store.getPersistRevisions().closedRevision;
  const result = ctx.store.syncServerLifecycle({ servers: [{ id: "srv-a" }], tombstones: [] });
  assert.equal(result.changed, true);
  assert.ok(ctx.store.getPersistRevisions().closedRevision > before);
  assert.deepEqual(savedDayCounts(ctx.store).types.map((type) => type.serverId), ["srv-a"]);
});

test("回填: 回收站里的服务器也回填，恢复后汇总对得上", () => {
  const removedAt = NOON - HOUR;
  const main = {
    ...SPLIT_MAIN,
    removedServers: [{
      serverId: "srv-b", removedAt, active: [],
      closed: [closedItem("z-1", { serverId: "srv-b", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 2, 9) })],
    }],
  };
  const ctx = makeStore();
  const info = ctx.store.loadSnapshot(main, { closed: legacyClosedFile([closedItem("a-1", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 3, 9) })]) });
  assert.equal(info.dayCountsBackfilled, true);
  assert.deepEqual(ctx.store.summarize().types.map((type) => type.serverId), ["srv-a"]);
  ctx.store.syncServerLifecycle({ servers: [{ id: "srv-a" }, { id: "srv-b" }], tombstones: [] });
  assert.deepEqual(ctx.store.summarize().types.map((type) => [type.serverId, type.count]), [["srv-a", 1], ["srv-b", 1]]);
});

test("预算: 已关闭文件超预算时先淘汰最旧的逐条记录，计数保留——重启后次数不变", () => {
  const logs = [];
  const ctx = makeStore({ now: beijing(10, 3, 8), overrides: { log: (_message, data) => logs.push(data) } });
  const bulky = "x".repeat(Math.ceil(INCIDENT_FILE_MAX_BYTES * 0.6));
  for (let i = 0; i < 2; i += 1) {
    const incident = ctx.store.observe({ serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", evidence: { text: bulky } });
    assert.ok(incident);
    ctx.tick(MIN);
    ctx.store.reportSuccess({ serverId: "srv-a", component: "tunnel" });
    ctx.store.reportSuccess({ serverId: "srv-a", component: "tunnel" });
    ctx.tick(MIN);
  }
  const json = ctx.store.serializeClosedForSave();
  assert.ok(Buffer.byteLength(json, "utf8") <= INCIDENT_FILE_MAX_BYTES);
  assert.ok(logs.some((entry) => entry.event === "incident-persistence-overflow"));
  const file = JSON.parse(json);
  assert.equal(file.closed.length, 1, "最旧的一条逐条记录没写进文件");
  assert.deepEqual(file.dayCounts.types[0].days, { "2026-10-03": [2, 2] });
  const reloaded = makeStore();
  const info = reloaded.store.loadSnapshot(JSON.parse(ctx.store.serializeMainForSave()), { closed: file });
  assert.equal(info.dayCountsBackfilled, false);
  const [type] = reloaded.store.summarize().types;
  assert.equal(type.count, 2);
  assert.equal(type.retained, 1);
});

test("损坏的时间戳: 超出日期范围 / 非数字的恢复时刻不计数也不会让加载卡住；首见时间离谱时只回溯到保留期为止", () => {
  const closed = [
    closedItem("ok", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 3, 9) }),
    { ...closedItem("huge", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 3, 10) }), resolvedAt: 1e20 },
    { ...closedItem("nan", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 3, 10) }), resolvedAt: "soon" },
    { ...closedItem("ancient", { serverId: "srv-a", component: "filesystem", reasonCode: "DISK_THRESHOLD", resolvedAt: beijing(10, 3, 11) }), firstSeenAt: -1e20 },
    { ...closedItem("epoch", { serverId: "srv-b", component: "filesystem", reasonCode: "DISK_THRESHOLD", resolvedAt: beijing(10, 3, 11) }), firstSeenAt: 0 },
  ];
  const ctx = makeStore();
  const info = ctx.store.loadSnapshot(SPLIT_MAIN, { closed: legacyClosedFile(closed) });
  assert.equal(info.dayCountsBackfilled, true);
  const summary = ctx.store.summarize({ days: 31 });
  const tunnel = typeOf(summary, (type) => type.component === "tunnel");
  assert.equal(tunnel.count, 1, "只有时间戳正常的那条计数");
  assert.equal(tunnel.retained, 1);
  const ancient = typeOf(summary, (type) => type.serverId === "srv-a" && type.component === "filesystem");
  assert.equal(ancient.count, 1);
  assert.deepEqual(ancient.perDay, [...Array(30).fill(0), 1], "首见时间算不出日期：只算恢复当天");
  const epoch = typeOf(summary, (type) => type.serverId === "srv-b");
  assert.deepEqual(epoch.perDay, Array(31).fill(1), "从 1970 年持续到今天：回溯到保留期为止");
  const saved = savedDayCounts(ctx.store);
  assert.ok(saved.types.every((type) => Object.keys(type.days).length <= INCIDENT_DAY_COUNT_RETENTION_DAYS));
  // 读回的计数里时间戳离谱：丢掉该字段，不影响其余内容。
  const reloaded = makeStore();
  const mangled = { ...saved, since: 1e20, types: saved.types.map((type) => ({ ...type, evictedBefore: 1e20, lastResolvedAt: -3 })) };
  assert.equal(reloaded.store.loadSnapshot(SPLIT_MAIN, { closed: { ...legacyClosedFile(closed), dayCounts: mangled } }).dayCountsBackfilled, false);
  const again = reloaded.store.summarize({ days: 31 });
  assert.equal(again.countingSince, null);
  assert.ok(again.types.every((type) => type.capped === false));
});

// ---- 落盘调度 ----

function makePersisted({ files = {}, now = NOON } = {}) {
  const ctx = makeStore({ now });
  const store = new Map(Object.entries(files));
  const writes = [];
  const io = {
    readFile: async (target) => {
      if (!store.has(target)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return store.get(target);
    },
    writeFile: async (target, data) => { store.set(target, String(data)); },
    rename: async (from, to) => { store.set(to, store.get(from)); store.delete(from); writes.push(to); },
    unlink: async (target) => { store.delete(target); },
  };
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  const advance = async (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  const persister = createIncidentPersister({
    store: ctx.store, filePath: "/rt/incidents.json", io,
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  return { ...ctx, files: store, writes, advance, persister };
}

test("落盘: 旧版本写的已关闭文件（没有计数）读入即回填并尽快重写；重写后再读回是干净的、计数起点不后移", async () => {
  const closedFile = JSON.stringify(legacyClosedFile([
    closedItem("a-1", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 2, 9) }),
    closedItem("a-2", { serverId: "srv-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", resolvedAt: beijing(10, 3, 9) }),
  ]));
  const first = makePersisted({ files: { "/rt/incidents.json": JSON.stringify(SPLIT_MAIN), "/rt/incidents-closed.json": closedFile } });
  const info = await first.persister.load();
  assert.equal(info.dayCountsBackfilled, true);
  assert.equal(info.closedTrimmed, false);
  assert.equal(first.persister.isUrgentDirty(), true, "回填结果要尽快落盘");
  await first.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.deepEqual(first.writes, ["/rt/incidents-closed.json", "/rt/incidents.json"]);
  const rewritten = JSON.parse(first.files.get("/rt/incidents-closed.json"));
  assert.equal(rewritten.closed.length, 2, "逐条记录原样保留");
  assert.equal(rewritten.dayCounts.since, NOON);
  assert.deepEqual(rewritten.dayCounts.types[0].days, { "2026-10-02": [1, 1], "2026-10-03": [1, 1] });
  assert.equal(await first.persister.flush(), false, "写回之后没有变化不再写");

  const second = makePersisted({ files: Object.fromEntries(first.files), now: NOON + 3 * DAY });
  const info2 = await second.persister.load();
  assert.equal(info2.dayCountsBackfilled, false);
  assert.equal(second.persister.isDirty(), false);
  assert.equal(second.store.summarize().countingSince, NOON);
});

test("落盘: 没有任何已恢复记录时不为回填多写一次盘；之后第一条恢复记录把计数一并写进已关闭文件", async () => {
  const empty = makePersisted();
  const info = await empty.persister.load();
  assert.equal(info.dayCountsBackfilled, false);
  assert.equal(empty.persister.isDirty(), false);
  cycle(empty, { at: NOON + MIN });
  await empty.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  const closedFile = JSON.parse(empty.files.get("/rt/incidents-closed.json"));
  assert.equal(closedFile.closed.length, 1);
  assert.equal(closedFile.dayCounts.since, NOON, "全新安装：计数起点 = 首次启动");
  assert.deepEqual(closedFile.dayCounts.types.map((type) => type.days), [{ "2026-10-03": [1, 1] }]);
});

test("逐日计数: 全局已关闭池顶满（长期运行的常态）时，新出现的类型不被误标「记录已清理 / N+」", () => {
  const ctx = makeStore({ overrides: { maxClosed: 20 } });
  for (let i = 0; i < 25; i += 1) cycle(ctx, { serverId: "srv-a", reasonCode: "TUNNEL_DOWN", at: NOON - 2 * DAY + i * HOUR });
  cycle(ctx, { serverId: "srv-b", component: "channel", reasonCode: "CHANNEL_ERROR", at: NOON + HOUR });
  const type = ctx.store.summarize({ days: 7 }).types.find((t) => t.reasonCode === "CHANNEL_ERROR");
  assert.equal(type.count, 1);
  assert.equal(type.capped, false, "全新的类型没有任何更早的记录可缺");
  assert.equal(type.coverageStart, null);
});

test("组合原因码（通道几段同时断开）能记成事件，指纹与汇总照常", () => {
  const ctx = makeStore();
  const incident = cycle(ctx, { serverId: "srv-a", component: "channel", reasonCode: "TUNNEL_DOWN+REMOTE_PORT_CLOSED", at: NOON });
  assert.ok(incident, "此前格式校验不允许「+」，observe 直接返回 null");
  const type = ctx.store.summarize({ days: 3 }).types.find((t) => t.reasonCode === "TUNNEL_DOWN+REMOTE_PORT_CLOSED");
  assert.equal(type.count, 1);
});
