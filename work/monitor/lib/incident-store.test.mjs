// incident-store 行为测试（T07，验收 A27/A28）。假时钟驱动，无 IO。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createIncidentStore,
  INCIDENT_SNOOZE_MAX_MS,
  DISK_OPEN_PCT,
  DISK_CLOSE_PCT,
  buildIncidentFingerprint,
  INCIDENT_SERVER_TRASH_TTL_MS,
  INCIDENT_FILE_MAX_BYTES,
  INCIDENT_OPEN_GATE,
  INCIDENT_MAX_CLOSED_PER_FINGERPRINT,
  INCIDENT_FLAP_WINDOW_MS,
  AGENT_MODULE_DISABLED_NOTE,
} from "./incidents/store.mjs";
import {
  INCIDENT_SAVE_URGENT_DELAY_MS,
  INCIDENT_SAVE_MINOR_DELAY_MS,
  createIncidentPersister,
} from "./incidents/persister.mjs";

function makeStore({ now, overrides = {} } = {}) {
  let clock = now ?? 1_000_000;
  const store = createIncidentStore({ openGate: {}, now: () => clock, randomUUID: (() => { let i = 0; return () => `id-${String(++i).padStart(4, "0")}`; })(), log: () => {}, ...overrides });
  return { store, tick: (ms) => { clock += ms; } };
}

// ---- A27: 合并与隔离 ----

test("A27: 同指纹重复 100 次 → 一个事件累加次数；恢复后重现 → 新 incidentId 且关联前次", () => {
  const { store, tick } = makeStore();
  let last = null;
  for (let i = 0; i < 100; i += 1) {
    tick(1000);
    last = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error", evidence: { kind: "probe", seq: i } });
  }
  const open = store.query({ state: "open" });
  assert.equal(open.total, 1, "同一故障只应有一个事件");
  assert.equal(open.incidents[0].occurrences, 100);
  assert.equal(open.incidents[0].evidenceRefs.length, 8, "证据引用有界保留最新");
  assert.equal(last.evidenceRefs.at(-1).seq, 99);

  // 连续 2 次成功 → 恢复；再故障 → 新事件并关联前次。
  tick(1000);
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  tick(1000);
  const resolvedList = store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.equal(resolvedList.length, 1);
  assert.equal(resolvedList[0].lifecycle, "resolved");
  tick(1000);
  const again = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  assert.notEqual(again.incidentId, resolvedList[0].incidentId, "恢复后重现必须是新生命周期");
  assert.deepEqual(again.relatedIncidentIds, [resolvedList[0].incidentId]);
  assert.equal(store.counts().open, 1);
});

test("A27: 不同服务器同文案不合并；agentId/组件不同不合并", () => {
  const { store } = makeStore();
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.observe({ serverId: "fixture-b", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.observe({ serverId: "fixture-a", component: "agent", agentId: "codex", reasonCode: "DEGRADED", severity: "warn" });
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "REMOTE_PORT_CLOSED", severity: "error" });
  assert.equal(store.counts().open, 4);
  assert.equal(store.query({ serverId: "fixture-a" }).total, 3);
});

test("指纹: 非法组件/reasonCode 拒绝（稳定 reasonCode 是白名单形态）", () => {
  const { store } = makeStore();
  assert.equal(store.observe({ serverId: "a", component: "Bad Component", reasonCode: "X" }), null);
  assert.equal(store.observe({ serverId: "a", component: "channel", reasonCode: "带中文" }), null);
  assert.equal(buildIncidentFingerprint({ serverId: null, component: "channel", reasonCode: "X" }), "global|channel|X");
});

// ---- A28: 注意力偏好不改变故障事实；升级打断 snooze；恢复/unknown 语义 ----

test("A28: acknowledge/snooze 不改变 lifecycle；snooze 上限 24h；unsnooze 恢复提醒", () => {
  const { store, tick } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.acknowledge(incident.incidentId);
  assert.throws(() => store.snooze(incident.incidentId, 0));
  store.snooze(incident.incidentId, 100 * 60 * 60 * 1000); // 100h → 钳到 24h
  assert.equal(incident.lifecycle, "open", "偏好不得改变故障事实");
  assert.ok(incident.attention.acknowledgedAt > 0);
  const remaining = incident.attention.snoozedUntil - (1_000_000 + incident.attention.acknowledgedAt - 1_000_000);
  assert.ok(remaining <= INCIDENT_SNOOZE_MAX_MS);
  tick(24 * 60 * 60 * 1000 + 1);
  // snooze 过期后事件仍在（事实不变），提醒资格由消费方按 snoozedUntil 判定。
  assert.equal(store.counts().open, 1);
  store.unsnooze(incident.incidentId);
  assert.equal(incident.attention.snoozedUntil, null);
  // 已恢复的事件不能再设置注意力。
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.throws(() => store.acknowledge(incident.incidentId));
});

test("A28: 严重度升级解除 snooze 并留痕；升级不清空 acknowledge", () => {
  const { store } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "filesystem", reasonCode: "DISK_THRESHOLD", severity: "warn" });
  store.acknowledge(incident.incidentId);
  store.snooze(incident.incidentId, 60 * 60 * 1000);
  store.observe({ serverId: "fixture-a", component: "filesystem", reasonCode: "DISK_THRESHOLD", severity: "error" });
  assert.equal(incident.severity, "error");
  assert.equal(incident.attention.snoozedUntil, null, "升级必须再提醒");
  assert.ok(incident.attention.acknowledgedAt, "确认记录保留");
  assert.ok(incident.notes.at(-1).text.includes("snooze cleared"));
  // 降级不回写：warn 不会再改回 severity。
  store.observe({ serverId: "fixture-a", component: "filesystem", reasonCode: "DISK_THRESHOLD", severity: "warn" });
  assert.equal(incident.severity, "error");
});

test("A28: 恢复判定——连续 2 次成功；失败/未知打断连击；不算恢复采样", () => {
  const { store } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.equal(incident.lifecycle, "open", "1 次成功不恢复");
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.equal(incident.lifecycle, "open", "失败打断连击后 1 次成功仍不恢复");
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.equal(incident.lifecycle, "resolved");
  // unknown 打断连击（不算恢复采样）。
  const incident2 = store.observe({ serverId: "fixture-b", component: "agent", agentId: "codex", reasonCode: "DEGRADED", severity: "warn" });
  store.reportSuccess({ serverId: "fixture-b", component: "agent" });
  store.reportUnknown({ serverId: "fixture-b", component: "agent" });
  store.reportSuccess({ serverId: "fixture-b", component: "agent" });
  assert.equal(incident2.lifecycle, "open", "unknown 之后只有 1 次有效成功");
  store.reportSuccess({ serverId: "fixture-b", component: "agent" });
  assert.equal(incident2.lifecycle, "resolved");
});

// ---- 磁盘迟滞 ----

test("磁盘迟滞: >=90 打开、88–89 中性、<88 连续 2 次关闭", () => {
  const { store } = makeStore();
  const at95 = store.observeDiskUsage({ serverId: "fixture-a", usedPct: 95 });
  assert.equal(at95.severity, "error");
  store.observeDiskUsage({ serverId: "fixture-a", usedPct: 89 });
  assert.equal(at95.lifecycle, "open", "中性带不关闭也不打断连击");
  store.observeDiskUsage({ serverId: "fixture-a", usedPct: 80 });
  assert.equal(at95.lifecycle, "open");
  store.observeDiskUsage({ serverId: "fixture-a", usedPct: 80 });
  assert.equal(at95.lifecycle, "resolved");
  assert.ok(DISK_OPEN_PCT === 90 && DISK_CLOSE_PCT === 88);
});

// ---- 有界与持久化 ----

test("容量: 活跃超 500 合并溢出摘要并告警；closed 上限淘汰最旧", () => {
  const logs = [];
  const { store } = makeStore({ overrides: { maxActive: 500, maxClosed: 3, log: (msg, fields) => logs.push({ msg, fields }) } });
  for (let i = 0; i < 505; i += 1) {
    store.observe({ serverId: `srv-${i}`, component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  }
  const counts = store.counts();
  assert.equal(counts.open, 500);
  assert.equal(counts.overflow.count, 5);
  assert.ok(logs.some((l) => l.fields.event === "incident-overflow"));
  const open = store.query({ state: "open", limit: 200 });
  assert.equal(open.overflow.count, 5, "查询 meta 透出溢出摘要");
  // closed 上限：反复开关后 closed ≤ 3。
  for (let i = 0; i < 10; i += 1) {
    store.observe({ serverId: `cyc-${i}`, component: "agent", agentId: "x", reasonCode: "DEGRADED" });
    store.reportSuccess({ serverId: `cyc-${i}`, component: "agent" });
    store.reportSuccess({ serverId: `cyc-${i}`, component: "agent" });
  }
  assert.ok(store.counts().resolved <= 3);
});

test("持久化: 原子保存/读回 round-trip；损坏文件降级为空", () => {
  const { store } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error", evidence: { kind: "probe" } });
  store.acknowledge(incident.incidentId);
  const json = store.serializeForSave();
  const restored = createIncidentStore({ openGate: {}, now: () => 2_000_000, randomUUID: () => "fresh" });
  restored.loadSnapshot(JSON.parse(json));
  const q = restored.query({ state: "open" });
  assert.equal(q.total, 1);
  assert.equal(q.incidents[0].incidentId, incident.incidentId);
  assert.ok(q.incidents[0].attention.acknowledgedAt, "注意力偏好随快照恢复");
  // 损坏输入：形状不符整份忽略，不抛错。
  const bad = createIncidentStore({ openGate: {}, now: () => 2_000_000 });
  bad.loadSnapshot({ schemaVersion: 99, active: "junk" });
  assert.equal(bad.counts().open, 0);
  bad.loadSnapshot({ schemaVersion: 1, active: [{ incidentId: "x", lifecycle: "weird", component: "!!" }] });
  assert.equal(bad.counts().open, 0);
});

test("查询: state/serverId 过滤、limit 上限 200、游标翻页稳定", () => {
  const { store } = makeStore();
  for (let i = 0; i < 7; i += 1) {
    store.observe({ serverId: i % 2 ? "fixture-a" : "fixture-b", component: "channel", reasonCode: `RC_${i}`, severity: "warn" });
  }
  assert.equal(store.query({ limit: 1000 }).incidents.length, 7, "limit 钳到 200 以内不越界");
  const page1 = store.query({ serverId: "fixture-a", limit: 2 });
  assert.equal(page1.incidents.length, 2);
  const page2 = store.query({ serverId: "fixture-a", limit: 2, cursor: page1.nextCursor });
  assert.equal(page1.incidents.length + page2.incidents.length, 3, "fixture-a 共 3 条");
  assert.equal(store.query({ state: "resolved" }).total, 0);
  // 指纹唯一性兜底：同页不重复。
  const ids = new Set([...page1.incidents, ...page2.incidents].map((x) => x.incidentId));
  assert.equal(ids.size, 3);
  // 同指纹不同 serverId 的合并方向（A27 补充）：同组件+reasonCode 各自独立成事件并各自累加。
  const { store: store2 } = makeStore();
  for (let i = 0; i < 7; i += 1) {
    store2.observe({ serverId: i % 2 ? "fixture-a" : "fixture-b", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  }
  assert.equal(store2.counts().open, 2, "两台服务器各一个事件");
  const perServer = store2.query({ serverId: "fixture-a" }).incidents[0];
  assert.equal(perServer.occurrences, 3);
});

test("删除服务器同时隔离未解决/已解决事件，恢复原提醒偏好与统计且需要新的连续成功", () => {
  const { store, tick } = makeStore();
  const servers = [{ id: "fixture-a" }, { id: "fixture-b", disabled: true }];
  store.syncServerLifecycle({ servers, tombstones: [] });
  const incident = store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  tick(20);
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", evidence: { kind: "probe", value: "retained" } });
  store.acknowledge(incident.incidentId);
  store.snooze(incident.incidentId, 60_000);
  store.linkOperation(incident.incidentId, "operation-1");
  store.reportSuccess({ serverId: "fixture-a", component: "tunnel" });
  const closedIncident = store.observe({ serverId: "fixture-a", component: "filesystem", reasonCode: "DISK_THRESHOLD" });
  store.reportSuccess({ serverId: "fixture-a", component: "filesystem" });
  store.reportSuccess({ serverId: "fixture-a", component: "filesystem" });
  const other = store.observe({ serverId: "fixture-b", component: "agent", reasonCode: "DEGRADED" });
  store.reportSuccess({ serverId: "fixture-b", component: "agent" });
  const global = store.observe({ component: "proxy", reasonCode: "PROXY_DOWN" });
  const before = structuredClone([incident, closedIncident]);
  const tombstones = [{ id: "fixture-a", removedAt: 1_000_020 }];
  assert.deepEqual(store.syncServerLifecycle({ servers: [servers[1]], tombstones }), {
    changed: true, archived: 2, restored: 0, purged: 0,
  });
  assert.equal(store.query({ serverId: "fixture-a" }).total, 0);
  assert.equal(store.query({ state: "resolved", serverId: "fixture-a" }).total, 0);
  assert.deepEqual(store.counts(), {
    open: 2, resolved: 0, bySeverity: { info: 0, warn: 2, error: 0 }, attention: 2,
    overflow: { count: 0, lastAt: null },
  });
  assert.equal(store.getIncident(incident.incidentId), null, "事件详情也不能通过旧 id 访问已删除事件");
  assert.throws(() => store.acknowledge(incident.incidentId), /not found/);
  assert.equal(store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" }), null);
  assert.deepEqual(store.reportSuccess({ serverId: "fixture-a", component: "tunnel" }), []);
  assert.equal(store.observeDiskUsage({ serverId: "fixture-a", usedPct: 98 }), null);
  assert.equal(store.reportSuccess({ serverId: "fixture-b", component: "agent" })[0].incidentId, other.incidentId,
    "删除另一台服务器不应打断本机已开始的成功连击");
  assert.equal(store.getIncident(global.incidentId).lifecycle, "open");

  tick(5000);
  const restored = store.syncServerLifecycle({ servers: servers.map((server) => ({ ...server, disabled: true })), tombstones: [] });
  assert.deepEqual(restored, { changed: true, archived: 0, restored: 2, purged: 0 });
  assert.deepEqual([store.getIncident(incident.incidentId), store.getIncident(closedIncident.incidentId)], before);
  assert.equal(store.reportSuccess({ serverId: "fixture-a", component: "tunnel" }).length, 0,
    "删除前和删除期间的成功不能参与恢复后的连续采样");
  assert.equal(store.reportSuccess({ serverId: "fixture-a", component: "tunnel" })[0].incidentId, incident.incidentId);
});

test("已有旧快照启动同步会隔离早先删除的服务器，7天起点沿用注册表删除时间", () => {
  const { store } = makeStore();
  const deleted = store.observe({ serverId: "server-tengxun", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.observe({ serverId: "fixture-b", component: "channel", reasonCode: "TUNNEL_DOWN" });
  const legacy = JSON.parse(store.serializeForSave());
  delete legacy.removedServers;
  const restarted = createIncidentStore({ openGate: {}, now: () => 1_000_000 + 2 * 24 * 60 * 60 * 1000 });
  restarted.loadSnapshot(legacy);
  restarted.syncServerLifecycle({ servers: [{ id: "fixture-b" }], tombstones: [{ id: "server-tengxun", removedAt: 1_000_000 }] });
  assert.equal(restarted.query().total, 1);
  const saved = JSON.parse(restarted.serializeForSave());
  assert.equal(saved.schemaVersion, legacy.schemaVersion, "新增可选字段兼容旧快照 schema");
  assert.equal(saved.removedServers[0].removedAt, 1_000_000);
  assert.equal(saved.removedServers[0].active[0].incidentId, deleted.incidentId);
});

test("回收事件跨进程重启保留，恢复禁用服务器后仍保留原事件id与完整提醒偏好", () => {
  const { store } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.acknowledge(incident.incidentId);
  store.snooze(incident.incidentId, 20000);
  const before = structuredClone(incident);
  const deletedConfig = { servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] };
  store.syncServerLifecycle(deletedConfig);
  const restarted = createIncidentStore({ openGate: {}, now: () => 1_020_000 });
  restarted.loadSnapshot(JSON.parse(store.serializeForSave()));
  assert.equal(restarted.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" }), null);
  assert.equal(restarted.syncServerLifecycle(deletedConfig).changed, false);
  assert.equal(restarted.counts().open, 0);
  restarted.syncServerLifecycle({ servers: [{ id: "fixture-a", disabled: true }], tombstones: [] });
  assert.deepEqual(restarted.getIncident(incident.incidentId), before);
});

test("到达7天边界立即清除归档，同id重建不能复活旧事件", () => {
  const { store, tick } = makeStore();
  const incident = store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] });
  tick(INCIDENT_SERVER_TRASH_TTL_MS);
  assert.deepEqual(store.syncServerLifecycle({ servers: [{ id: "fixture-a" }], tombstones: [] }), {
    changed: true, archived: 0, restored: 0, purged: 1,
  });
  assert.equal(store.getIncident(incident.incidentId), null);
  assert.equal(JSON.parse(store.serializeForSave()).removedServers.length, 0);
  const newIncident = store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  assert.notEqual(newIncident.incidentId, incident.incidentId);
  assert.equal(newIncident.occurrences, 1);
  assert.deepEqual(newIncident.relatedIncidentIds, []);
});

test("到期归档不因原始配置仍含旧tombstone而重新保留，迟到故障保持被拦截", () => {
  const { store, tick } = makeStore();
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  const config = { servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] };
  store.syncServerLifecycle(config);
  tick(INCIDENT_SERVER_TRASH_TTL_MS + 1);
  assert.equal(store.syncServerLifecycle(config).purged, 1);
  assert.equal(store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" }), null);
  assert.equal(store.counts().open, 0);
  assert.deepEqual(JSON.parse(store.serializeForSave()).removedServers, []);
});

test("同id另一轮删除不能继承前次归档，丢失删除记录的孤儿事件不再恢复", () => {
  const { store, tick } = makeStore();
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] });
  tick(1000);
  assert.equal(store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_001_000 }] }).purged, 1);
  store.syncServerLifecycle({ servers: [{ id: "fixture-a" }], tombstones: [] });
  assert.equal(store.counts().open, 0);
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  assert.equal(store.syncServerLifecycle({ servers: [], tombstones: [] }).purged, 1);
  store.syncServerLifecycle({ servers: [{ id: "fixture-a" }], tombstones: [] });
  assert.equal(store.counts().open, 0);
});

test("缺失或损坏生命周期输入不得清空事件和上一次观测许可", () => {
  const { store } = makeStore();
  store.syncServerLifecycle({ servers: [{ id: "fixture-a" }], tombstones: [] });
  const incident = store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  for (const input of [undefined, {}, { servers: [] }, { servers: {}, tombstones: [] },
    { servers: [null], tombstones: [] }, { servers: [], tombstones: [{ id: "fixture-a" }] }]) {
    assert.throws(() => store.syncServerLifecycle(input), TypeError);
    assert.equal(store.getIncident(incident.incidentId).lifecycle, "open");
  }
  assert.equal(store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" }).occurrences, 2);
});

test("归档容量与读回内存有界，溢出有告警但不会再次显示删除事件", () => {
  const logs = [];
  const { store } = makeStore({ overrides: { maxArchived: 2, log: (_, data) => logs.push(data) } });
  const ids = ["fixture-a", "fixture-b", "fixture-c"];
  for (const id of ids) store.observe({ serverId: id, component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  assert.equal(store.syncServerLifecycle({ servers: [], tombstones: ids.map((id) => ({ id, removedAt: 1_000_000 })) }).purged, 1);
  assert.equal(store.counts().open, 0);
  assert.ok(logs.some((entry) => entry.event === "incident-trash-overflow"));
  const snapshot = JSON.parse(store.serializeForSave());
  assert.equal(snapshot.removedServers.reduce((sum, entry) => sum + entry.active.length + entry.closed.length, 0), 2);
  const restarted = createIncidentStore({ openGate: {}, now: () => 1_000_000, maxArchived: 1 });
  restarted.loadSnapshot(snapshot);
  restarted.syncServerLifecycle({ servers: ids.map((id) => ({ id })), tombstones: [] });
  assert.equal(restarted.counts().open, 1);
});

test("归档和异常大证据不能突破事件持久化文件上限", () => {
  const logs = [];
  const { store } = makeStore({ overrides: { log: (_, data) => logs.push(data) } });
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", evidence: { text: "x".repeat(INCIDENT_FILE_MAX_BYTES + 1) } });
  store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] });
  store.observe({ component: "proxy", reasonCode: "PROXY_DOWN", evidence: { text: "x".repeat(INCIDENT_FILE_MAX_BYTES + 1) } });
  assert.ok(Buffer.byteLength(store.serializeForSave(), "utf8") <= INCIDENT_FILE_MAX_BYTES);
  assert.ok(logs.some((entry) => entry.event === "incident-persistence-overflow"));
});

test("读入已过期归档后首次同步仍要求落盘清理，随后同步无需重复保存", () => {
  const { store } = makeStore();
  store.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] });
  const restarted = createIncidentStore({ openGate: {}, now: () => 1_000_000 + INCIDENT_SERVER_TRASH_TTL_MS });
  restarted.loadSnapshot(JSON.parse(store.serializeForSave()));
  assert.equal(restarted.syncServerLifecycle({ servers: [], tombstones: [] }).changed, true);
  assert.deepEqual(JSON.parse(restarted.serializeForSave()).removedServers, []);
  assert.equal(restarted.syncServerLifecycle({ servers: [], tombstones: [] }).changed, false);
});

test("快照预算裁剪跨服务器保留其余归档且按UTF-8实际字节约束", () => {
  const { store } = makeStore({ overrides: { maxActive: 2000, maxArchived: 2000 } });
  const tombstones = Array.from({ length: 30 }, (_, index) => ({ id: `fixture-${index}`, removedAt: 900_000 + index }));
  for (const { id } of tombstones) {
    for (let i = 0; i < 40; i += 1) {
      store.observe({ serverId: id, component: "tunnel", reasonCode: `CODE_${i}`, evidence: { text: "证据".repeat(200) } });
    }
  }
  store.syncServerLifecycle({ servers: [], tombstones });
  const json = store.serializeForSave();
  assert.ok(Buffer.byteLength(json, "utf8") <= INCIDENT_FILE_MAX_BYTES);
  const saved = JSON.parse(json);
  const kept = saved.removedServers.reduce((sum, entry) => sum + entry.active.length, 0);
  assert.ok(kept > 500 && kept < 1200, "应只移除超额旧记录，保留预算内的大部分归档");
  assert.equal(saved.removedServers.at(-1).serverId, "fixture-29");
  assert.equal(saved.removedServers.at(-1).active.length, 40);
});

// ---- 落盘调度：修订号门控 + 已关闭拆分文件（W1 磁盘写放大修复）----

function makeFakeIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  return {
    files,
    writes,
    io: {
      readFile: async (p) => {
        if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return files.get(p);
      },
      writeFile: async (p, data) => { files.set(p, String(data)); },
      rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); writes.push(to); },
      unlink: async (p) => { files.delete(p); },
    },
  };
}

function makeFakeTimers() {
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()].map((t) => t.at - clock),
    async advance(ms) {
      clock += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= clock) { timers.delete(id); t.fn(); }
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function makePersisted({ files = {} } = {}) {
  const { store, tick } = makeStore();
  const fs = makeFakeIo(files);
  const timers = makeFakeTimers();
  const persister = createIncidentPersister({
    store, filePath: "/rt/incidents.json", io: fs.io,
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  return { store, tick, fs, timers, persister };
}

test("落盘: 空转的 reportSuccess / 磁盘中性带 / unknown 不改修订号、不写盘", async () => {
  const { store, fs, timers, persister } = makePersisted();
  await persister.load();
  const before = store.getPersistRevisions();
  for (let i = 0; i < 50; i += 1) {
    store.reportSuccess({ serverId: "fixture-a", component: "agent" });
    store.reportUnknown({ serverId: "fixture-a", component: "agent" });
    store.observeDiskUsage({ serverId: "fixture-a", usedPct: 50 });
    store.observeDiskUsage({ serverId: "fixture-a", usedPct: 89 });
  }
  assert.deepEqual(store.getPersistRevisions(), before, "无事件可关闭的成功采样不是持久化变化");
  assert.equal(persister.isDirty(), false);
  assert.deepEqual(timers.pending(), [], "干净状态不排期");
  await timers.advance(120_000);
  assert.equal(await persister.flush(), false, "显式 flush 在干净时也不写");
  assert.deepEqual(fs.writes, []);
});

test("落盘: 打开事件 2s 内写主文件；关闭事件才写已关闭文件；纯次数累加走长去抖", async () => {
  const { store, fs, timers, persister } = makePersisted();
  await persister.load();
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  assert.deepEqual(timers.pending(), [INCIDENT_SAVE_URGENT_DELAY_MS]);
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.deepEqual(fs.writes, ["/rt/incidents.json"], "新事件只写主文件（已关闭集合未变）");
  const main = JSON.parse(fs.files.get("/rt/incidents.json"));
  assert.equal(main.closedSplit, true);
  assert.equal(main.closed, undefined, "拆分主文件不再内嵌已关闭事件");
  assert.equal(main.active.length, 1);

  // 同指纹重复 = 仅次数/lastSeenAt 变化 → 长去抖。
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  assert.deepEqual(timers.pending(), [INCIDENT_SAVE_MINOR_DELAY_MS]);
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.equal(fs.writes.length, 1, "次数累加不在 2s 内重写");
  // 升级是结构性变化：把长去抖提前到 2s。
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  assert.deepEqual(timers.pending(), [INCIDENT_SAVE_URGENT_DELAY_MS]);
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.equal(fs.writes.length, 2);

  // 关闭：两次成功 → 已关闭文件先写、主文件后写。
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  assert.equal(persister.isDirty(), false, "第一次成功只是连击，不落盘");
  store.reportSuccess({ serverId: "fixture-a", component: "channel" });
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.deepEqual(fs.writes.slice(2), ["/rt/incidents-closed.json", "/rt/incidents.json"]);
  const closedFile = JSON.parse(fs.files.get("/rt/incidents-closed.json"));
  assert.equal(closedFile.closed.length, 1);
  assert.equal(JSON.parse(fs.files.get("/rt/incidents.json")).active.length, 0);

  // 提醒偏好（ack）也是持久化变化：新事件 + ack 只重写主文件。
  const again = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  const writesBeforeAck = fs.writes.length;
  store.acknowledge(again.incidentId);
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.deepEqual(fs.writes.slice(writesBeforeAck), ["/rt/incidents.json"]);
  assert.ok(JSON.parse(fs.files.get("/rt/incidents.json")).active[0].attention.acknowledgedAt);
  assert.equal(fs.writes.filter((p) => p.endsWith("-closed.json")).length, 1, "已关闭文件只在关闭时写一次");
});

test("落盘: 旧版单文件（内嵌 closed）透明加载并在首次保存时迁移为拆分格式；拆分格式读回一致", async () => {
  const { store: legacyStore } = makeStore();
  const openOne = legacyStore.observe({ serverId: "fixture-a", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  legacyStore.observe({ serverId: "fixture-b", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  legacyStore.reportSuccess({ serverId: "fixture-b", component: "channel" });
  const [closedOne] = legacyStore.reportSuccess({ serverId: "fixture-b", component: "channel" });
  const legacyJson = legacyStore.serializeForSave();
  assert.ok(Array.isArray(JSON.parse(legacyJson).closed), "fixture 为旧格式");

  const { store, fs, persister } = makePersisted({ files: { "/rt/incidents.json": legacyJson } });
  const info = await persister.load();
  assert.equal(info.legacyClosed, true);
  assert.equal(store.counts().open, 1);
  assert.equal(store.counts().resolved, 1);
  assert.equal(persister.isUrgentDirty(), true, "旧格式读入即标记待迁移");
  assert.equal(await persister.flush(), true);
  assert.deepEqual(fs.writes, ["/rt/incidents-closed.json", "/rt/incidents.json"]);
  const main = JSON.parse(fs.files.get("/rt/incidents.json"));
  assert.equal(main.closed, undefined);
  assert.equal(main.active[0].incidentId, openOne.incidentId);
  assert.equal(JSON.parse(fs.files.get("/rt/incidents-closed.json")).closed[0].incidentId, closedOne.incidentId);
  assert.equal(await persister.flush(), false, "迁移后无变化不再写");

  // 拆分格式重启读回。
  const reloaded = makePersisted({ files: Object.fromEntries(fs.files) });
  const info2 = await reloaded.persister.load();
  assert.equal(info2.legacyClosed, false);
  assert.equal(reloaded.persister.isDirty(), false, "拆分格式读回后是干净的");
  assert.equal(reloaded.store.counts().open, 1);
  assert.equal(reloaded.store.query({ state: "resolved" }).incidents[0].incidentId, closedOne.incidentId);
  // 缺失文件/损坏已关闭文件：按空处理不抛。
  const broken = makePersisted({ files: { "/rt/incidents.json": fs.files.get("/rt/incidents.json"), "/rt/incidents-closed.json": "{bad" } });
  await broken.persister.load();
  assert.equal(broken.store.counts().open, 1);
  assert.equal(broken.store.counts().resolved, 0);
  const empty = makePersisted();
  await empty.persister.load();
  assert.equal(empty.store.counts().open, 0);
});

test("落盘: 崩溃窗口内同一事件同时出现在主文件 active 与已关闭文件 → 以已关闭为准", async () => {
  const { store: src } = makeStore();
  const inc = src.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  const staleMain = src.serializeMainForSave();
  src.reportSuccess({ serverId: "fixture-a", component: "channel" });
  src.reportSuccess({ serverId: "fixture-a", component: "channel" });
  const newClosed = src.serializeClosedForSave();
  const { store, persister } = makePersisted({ files: { "/rt/incidents.json": staleMain, "/rt/incidents-closed.json": newClosed } });
  await persister.load();
  assert.equal(store.counts().open, 0);
  assert.equal(store.getIncident(inc.incidentId).lifecycle, "resolved");
});

test("落盘: close() 在长去抖挂起时立即落盘、之后不再排期；写失败不丢修订号并可重试", async () => {
  const { store, fs, timers, persister } = makePersisted();
  await persister.load();
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  assert.deepEqual(timers.pending(), [INCIDENT_SAVE_MINOR_DELAY_MS]);
  persister.dispose();
  assert.deepEqual(timers.pending(), [], "退出时取消排期");
  assert.equal(await persister.close(), true, "退出时冲刷挂起的次数累加");
  assert.equal(JSON.parse(fs.files.get("/rt/incidents.json")).active[0].occurrences, 2);
  store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "OTHER", severity: "warn" });
  assert.deepEqual(timers.pending(), [], "关闭后不再排期");

  // 写失败：修订号保持脏，下次 flush 重试成功。
  const failing = makePersisted();
  await failing.persister.load();
  let fail = true;
  const realRename = failing.fs.io.rename;
  failing.fs.io.rename = async (...args) => { if (fail) throw new Error("disk full"); return realRename(...args); };
  failing.store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  await assert.rejects(failing.persister.flush(), /disk full/);
  assert.equal(failing.persister.isDirty(), true);
  assert.deepEqual([...failing.fs.files.keys()].filter((p) => p.includes(".tmp")), [], "失败清理临时文件");
  fail = false;
  assert.equal(await failing.persister.flush(), true);
  assert.equal(failing.persister.isDirty(), false);
});

test("修订号: 生命周期同步变化 / 提醒偏好 / 关联操作递增；无变化同步不递增", () => {
  const { store } = makeStore();
  const servers = [{ id: "fixture-a" }];
  store.syncServerLifecycle({ servers, tombstones: [] });
  const r0 = store.getPersistRevisions();
  store.syncServerLifecycle({ servers, tombstones: [] });
  assert.deepEqual(store.getPersistRevisions(), r0, "无变化的生命周期同步不产生写入");
  const inc = store.observe({ serverId: "fixture-a", component: "channel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  for (const act of [() => store.snooze(inc.incidentId, 60000), () => store.unsnooze(inc.incidentId), () => store.linkOperation(inc.incidentId, "op-1")]) {
    const before = store.getPersistRevisions().urgentRevision;
    act();
    assert.equal(store.getPersistRevisions().urgentRevision, before + 1);
  }
  const before = store.getPersistRevisions();
  store.syncServerLifecycle({ servers: [], tombstones: [{ id: "fixture-a", removedAt: 1_000_000 }] });
  const after = store.getPersistRevisions();
  assert.ok(after.urgentRevision > before.urgentRevision && after.closedRevision > before.closedRevision);
});

test("磁盘确认：记下确认时用量；再涨 2 个百分点才解除确认、重新提醒（升级本身不清空，A28）", () => {
  let clock = 1_000;
  const store = createIncidentStore({ openGate: {}, now: () => clock, randomUUID: () => `i-${clock}` });
  const opened = store.observeDiskUsage({ serverId: "s1", usedPct: 92 });
  clock += 1000;
  store.acknowledge(opened.incidentId);
  assert.equal(opened.attention.acknowledgedUsedPct, 92);

  clock += 1000;
  store.observeDiskUsage({ serverId: "s1", usedPct: 93 });
  assert.ok(opened.attention.acknowledgedAt != null, "+1 个点仍保持已确认");

  clock += 1000;
  store.observeDiskUsage({ serverId: "s1", usedPct: 94 });
  assert.equal(opened.attention.acknowledgedAt, null, "+2 个点解除确认");
  assert.equal("acknowledgedUsedPct" in opened.attention, false);
  assert.match(opened.notes.at(-1).text, /rose to 94% \(acknowledged at 92%\)/);

  // 再次确认后以新用量为基准
  store.acknowledge(opened.incidentId);
  assert.equal(opened.attention.acknowledgedUsedPct, 94);
});

test("非磁盘事件确认不记用量，也不因证据变化被解除", () => {
  let clock = 1_000;
  const store = createIncidentStore({ openGate: {}, now: () => clock, randomUUID: () => `i-${clock}` });
  const inc = store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "warn" });
  store.acknowledge(inc.incidentId);
  assert.equal("acknowledgedUsedPct" in inc.attention, false);
  clock += 1000;
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "warn", evidence: { kind: "x", usedPct: 99 } });
  assert.ok(inc.attention.acknowledgedAt != null);
});

test("磁盘确认迁移：旧版本确认时没记用量 → 以之后第一次采样为基准", () => {
  let clock = 1_000;
  const store = createIncidentStore({ openGate: {}, now: () => clock, randomUUID: () => `i-${clock}` });
  const opened = store.observeDiskUsage({ serverId: "s1", usedPct: 92 });
  opened.attention.acknowledgedAt = 500; // 模拟旧版本落盘的确认（无 acknowledgedUsedPct）
  clock += 1000;
  store.observeDiskUsage({ serverId: "s1", usedPct: 92 });
  assert.equal(opened.attention.acknowledgedUsedPct, 92);
  clock += 1000;
  store.observeDiskUsage({ serverId: "s1", usedPct: 94 });
  assert.equal(opened.attention.acknowledgedAt, null);
});

// ---- 降噪：agent 作用域 / 打开门槛 / 已关闭池按指纹限额 ----

// 默认门槛策略的 store（makeStore 默认注入零门槛，这里显式还原生产策略）。
function makeGatedStore(overrides = {}) {
  return makeStore({ overrides: { openGate: INCIDENT_OPEN_GATE, ...overrides } });
}

test("指纹兼容: agentId 为空时保持旧格式；带 agentId 时组件段为 agent:<id>", () => {
  assert.equal(buildIncidentFingerprint({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" }), "s1|tunnel|TUNNEL_DOWN");
  assert.equal(buildIncidentFingerprint({ serverId: "s1", agentId: null, component: "filesystem", reasonCode: "DISK_THRESHOLD" }), "s1|filesystem|DISK_THRESHOLD");
  assert.equal(buildIncidentFingerprint({ component: "channel", reasonCode: "X" }), "global|channel|X");
  assert.equal(buildIncidentFingerprint({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" }), "s1|agent:codex|DEGRADED");
});

test("agent 作用域: codex 与 claude 同 reasonCode 不合并；claude 的成功关不掉 codex 事件", () => {
  const { store } = makeStore();
  const codex = store.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  const claude = store.observe({ serverId: "s1", agentId: "claude-codewing", component: "agent", reasonCode: "DEGRADED" });
  assert.notEqual(codex.incidentId, claude.incidentId);
  for (let i = 0; i < 6; i += 1) store.reportSuccess({ serverId: "s1", agentId: "claude-codewing", component: "agent" });
  assert.equal(claude.lifecycle, "resolved");
  assert.equal(codex.lifecycle, "open", "别的 agent 的成功不是 codex 的恢复采样");
  store.reportSuccess({ serverId: "s1", agentId: "codex", component: "agent" });
  store.reportUnknown({ serverId: "s1", agentId: "codex", component: "agent" });
  store.reportSuccess({ serverId: "s1", agentId: "codex", component: "agent" });
  assert.equal(codex.lifecycle, "open", "该 agent 的 unknown 打断连击");
  store.reportSuccess({ serverId: "s1", agentId: "codex", component: "agent" });
  assert.equal(codex.lifecycle, "resolved");
});

test("agent 作用域: 交错的 claude 成功不累计进 codex 连击；codex 失败打断 codex 连击", () => {
  const { store } = makeStore();
  const codex = store.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  store.reportSuccess({ serverId: "s1", agentId: "codex", component: "agent" });
  store.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  store.reportSuccess({ serverId: "s1", agentId: "claude-codewing", component: "agent" });
  store.reportSuccess({ serverId: "s1", agentId: "codex", component: "agent" });
  assert.equal(codex.lifecycle, "open");
  assert.equal(codex.occurrences, 2);
});

test("agent 作用域: 旧快照里的 agent 事件读回后按新指纹继续合并", () => {
  const { store } = makeStore();
  const incident = store.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  const { store: restarted } = makeStore();
  restarted.loadSnapshot(JSON.parse(store.serializeForSave()));
  const merged = restarted.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  assert.equal(merged.incidentId, incident.incidentId);
  assert.equal(merged.occurrences, 2);
});

test("打开门槛: 隧道失败先进待定，不进查询/计数、不递增修订号；120s 后定时转正并沿用首见时间与证据", () => {
  const { store, tick } = makeGatedStore();
  const revisions = store.getPersistRevisions();
  assert.equal(store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "warn", evidence: { kind: "t", n: 1 } }), null);
  tick(30_000);
  assert.equal(store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", evidence: { kind: "t", n: 2 } }), null);
  assert.deepEqual(store.getPersistRevisions(), revisions, "待定候选不是持久化状态");
  assert.equal(store.query().total, 0);
  assert.equal(store.counts().open, 0);
  assert.equal(store.listPending().length, 1);
  tick(60_000);
  assert.deepEqual(store.promotePending(), [], "未满 120s 不转正");
  tick(30_000);
  const [promoted] = store.promotePending();
  assert.ok(promoted);
  assert.equal(promoted.firstSeenAt, 1_000_000);
  assert.equal(promoted.lastSeenAt, 1_030_000, "lastSeenAt 是最后一次真实失败，不是转正时刻");
  assert.equal(promoted.occurrences, 2);
  assert.equal(promoted.severity, "error", "候选期间的最高严重度");
  assert.deepEqual(promoted.evidenceRefs.map((e) => e.n), [1, 2]);
  assert.equal(store.counts().open, 1);
  assert.equal(store.listPending().length, 0);
  assert.ok(store.getPersistRevisions().urgentRevision > revisions.urgentRevision, "转正是结构性变化");
  tick(1000);
  assert.equal(store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" }).incidentId, promoted.incidentId,
    "转正后同指纹继续合并");
});

test("打开门槛: 有新观测时到时也直接转正（不必等定时器）", () => {
  const { store, tick } = makeGatedStore();
  store.observe({ serverId: "s1", component: "channel", reasonCode: "CHANNEL_ERROR", severity: "error" });
  tick(120_000);
  const incident = store.observe({ serverId: "s1", component: "channel", reasonCode: "CHANNEL_ERROR", severity: "error" });
  assert.equal(incident.occurrences, 2);
  assert.equal(incident.firstSeenAt, 1_000_000);
});

test("打开门槛: agent 按次数（3 次）或 150s 先到者转正", () => {
  const { store, tick } = makeGatedStore();
  const fact = { serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED", evidence: { kind: "probe", probeId: "doctor" } };
  assert.equal(store.observe(fact), null);
  tick(10_000);
  assert.equal(store.observe(fact), null);
  tick(10_000);
  const opened = store.observe(fact);
  assert.equal(opened.occurrences, 3);
  assert.equal(opened.agentId, "codex");
  assert.equal(opened.firstSeenAt, 1_000_000);
  assert.equal(opened.evidenceRefs.length, 3);
  // 另一个 agent：只失败一次，150s 后由定时转正。
  store.observe({ ...fact, agentId: "claude-codewing" });
  tick(149_000);
  assert.equal(store.promotePending().length, 0);
  tick(1000);
  assert.equal(store.promotePending()[0].agentId, "claude-codewing");
});

test("打开门槛: 待定期间 1 次成功即撤销候选（已打开的事件仍要 2 次）；别的 agent 的成功不撤销", () => {
  const { store, tick } = makeGatedStore();
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.observe({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  tick(20_000);
  store.reportSuccess({ serverId: "s1", component: "tunnel" });
  assert.deepEqual(store.listPending().map((c) => c.fingerprint), ["s1|agent:codex|DEGRADED"], "1 次成功即撤销隧道候选");
  store.reportSuccess({ serverId: "s1", agentId: "claude-codewing", component: "agent" });
  store.reportSuccess({ serverId: "s1", agentId: "claude-codewing", component: "agent" });
  assert.deepEqual(store.listPending().map((c) => c.fingerprint), ["s1|agent:codex|DEGRADED"]);
  const revisions = store.getPersistRevisions();
  tick(10 * 60_000);
  assert.equal(store.promotePending().length, 1, "codex 候选仍按时转正");
  assert.ok(store.getPersistRevisions().revision > revisions.revision);
  assert.equal(store.query().incidents.filter((i) => i.component === "tunnel").length, 0, "短暂掉线不成事件");
});

test("打开门槛: 15min 内 3 次短暂失败后，下一次失败直接打开并注明抖动；之后重新计数", () => {
  const { store, tick } = makeGatedStore();
  const fail = () => store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  const recover = () => {
    store.reportSuccess({ serverId: "s1", component: "tunnel" });
    store.reportSuccess({ serverId: "s1", component: "tunnel" });
  };
  for (let i = 0; i < 3; i += 1) {
    assert.equal(fail(), null);
    tick(30_000);
    recover();
    tick(60_000);
  }
  const flapping = fail();
  assert.ok(flapping, "抖动直接打开");
  assert.match(flapping.notes.at(-1).text, /^flapping: 3 short failures in 15min/);
  recover();
  assert.equal(flapping.lifecycle, "resolved");
  assert.equal(fail(), null, "撤销记录已被消耗：重新回到门槛");
  // 窗口外的撤销不计入抖动。
  const { store: other, tick: tickOther } = makeGatedStore();
  for (let i = 0; i < 3; i += 1) {
    other.observe({ serverId: "s1", component: "channel", reasonCode: "CHANNEL_ERROR" });
    other.reportSuccess({ serverId: "s1", component: "channel" });
    other.reportSuccess({ serverId: "s1", component: "channel" });
    tickOther(INCIDENT_FLAP_WINDOW_MS / 2);
  }
  assert.equal(other.observe({ serverId: "s1", component: "channel", reasonCode: "CHANNEL_ERROR" }), null);
});

test("打开门槛: 磁盘阈值不受门槛影响（立即打开）；转正后恢复重现仍关联前次", () => {
  const { store, tick } = makeGatedStore();
  const disk = store.observeDiskUsage({ serverId: "s1", usedPct: 93 });
  assert.equal(disk.lifecycle, "open");
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  tick(120_000);
  const [first] = store.promotePending();
  store.reportSuccess({ serverId: "s1", component: "tunnel" });
  store.reportSuccess({ serverId: "s1", component: "tunnel" });
  assert.equal(first.lifecycle, "resolved");
  tick(1000);
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  tick(120_000);
  const [second] = store.promotePending();
  assert.deepEqual(second.relatedIncidentIds, [first.incidentId]);
});

test("打开门槛: 删除服务器丢弃其待定候选，定时转正不为已删服务器开事件", () => {
  const { store, tick } = makeGatedStore();
  store.syncServerLifecycle({ servers: [{ id: "s1" }, { id: "s2" }], tombstones: [] });
  store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.observe({ serverId: "s2", component: "tunnel", reasonCode: "TUNNEL_DOWN" });
  store.syncServerLifecycle({ servers: [{ id: "s2" }], tombstones: [{ id: "s1", removedAt: 1_000_000 }] });
  assert.deepEqual(store.listPending().map((c) => c.serverId), ["s2"]);
  tick(120_000);
  assert.deepEqual(store.promotePending().map((i) => i.serverId), ["s2"]);
  assert.equal(store.query({ serverId: "s1" }).total, 0);
});

test("已关闭池: 每指纹最多保留 50 条（淘汰该指纹最旧），其它指纹的历史不被挤出", () => {
  assert.equal(INCIDENT_MAX_CLOSED_PER_FINGERPRINT, 50);
  const { store, tick } = makeStore({ overrides: { maxClosedPerFingerprint: 3 } });
  const cycle = (serverId, component) => {
    tick(1000);
    const incident = store.observe({ serverId, component, reasonCode: "TUNNEL_DOWN" });
    store.reportSuccess({ serverId, component });
    store.reportSuccess({ serverId, component });
    return incident;
  };
  const keep = cycle("quiet", "tunnel");
  const noisy = Array.from({ length: 10 }, () => cycle("noisy", "tunnel"));
  const resolved = store.query({ state: "resolved", limit: 200 }).incidents.map((i) => i.incidentId);
  assert.equal(resolved.length, 4);
  assert.ok(resolved.includes(keep.incidentId), "安静指纹的历史保留");
  assert.deepEqual(new Set(resolved.filter((id) => id !== keep.incidentId)), new Set(noisy.slice(-3).map((i) => i.incidentId)));
});

test("已关闭池: 读回超额快照（915 条同指纹 + 85 条其它）立即按指纹限额裁剪为 50 + 85，并排期重写", async () => {
  const closedItem = (i, extra) => ({
    incidentId: `c-${i}`, lifecycle: "resolved", severity: "warn", firstSeenAt: i, lastSeenAt: i, resolvedAt: i + 1,
    occurrences: 1, evidenceRefs: [{ kind: "probe", probeId: "doctor" }], ...extra,
  });
  const noisy = Array.from({ length: 915 }, (_, i) => closedItem(i, { serverId: "server-01", agentId: "codex", component: "agent", reasonCode: "DEGRADED" }));
  const others = Array.from({ length: 85 }, (_, i) => closedItem(10_000 + i, { serverId: `srv-${i}`, component: "tunnel", reasonCode: "TUNNEL_DOWN" }));
  const closedFile = JSON.stringify({ schemaVersion: 1, savedAt: 1, closed: [...noisy, ...others] });
  const mainFile = JSON.stringify({ schemaVersion: 1, savedAt: 1, closedSplit: true, active: [], removedServers: [] });
  const { store, persister, timers, fs } = makePersisted({ files: { "/rt/incidents.json": mainFile, "/rt/incidents-closed.json": closedFile } });
  const info = await persister.load();
  assert.equal(info.closedTrimmed, true);
  assert.equal(store.counts().resolved, 135);
  const kept = store.query({ state: "resolved", limit: 200 }).incidents;
  const keptNoisy = kept.filter((i) => i.component === "agent");
  assert.equal(keptNoisy.length, 50);
  assert.equal(Math.min(...keptNoisy.map((i) => i.resolvedAt)), 866, "保留该指纹最新的 50 条");
  assert.equal(kept.filter((i) => i.component === "tunnel").length, 85);
  assert.equal(persister.isUrgentDirty(), true);
  await timers.advance(INCIDENT_SAVE_URGENT_DELAY_MS);
  assert.equal(JSON.parse(fs.files.get("/rt/incidents-closed.json")).closed.length, 135);
});

test("closeAgentIncidents：只关闭指定 Agent 的未结 agent 事件并注明「模块已关闭」，丢弃其待定候选；重开后另开新事件", () => {
  let clock = 1_000_000;
  const store = createIncidentStore({ now: () => clock });
  const openNow = (fields) => {
    let incident = null;
    for (let i = 0; i < 3 && !incident; i += 1) {
      clock += 30_000;
      incident = store.observe(fields);
    }
    return incident;
  };
  const zcode = openNow({ serverId: "s1", agentId: "zcode", component: "agent", reasonCode: "DEGRADED" });
  const codex = openNow({ serverId: "s1", agentId: "codex", component: "agent", reasonCode: "DEGRADED" });
  assert.ok(zcode && codex);
  store.observe({ serverId: "s1", agentId: "zcode", component: "agent", reasonCode: "AGENT_MISSING" });
  assert.equal(store.listPending().length, 1, "zcode 另一类失败仍在待定");

  assert.deepEqual(store.closeAgentIncidents({ agentIds: [] }), []);
  const closed = store.closeAgentIncidents({ agentIds: ["zcode"] });
  assert.deepEqual(closed.map((i) => i.incidentId), [zcode.incidentId]);
  assert.equal(store.getIncident(zcode.incidentId).lifecycle, "resolved");
  assert.equal(store.getIncident(zcode.incidentId).notes.at(-1).text, AGENT_MODULE_DISABLED_NOTE);
  assert.equal(AGENT_MODULE_DISABLED_NOTE, "模块已关闭");
  assert.equal(store.getIncident(codex.incidentId).lifecycle, "open", "其它 Agent 不受影响");
  assert.equal(store.listPending().length, 0, "待定候选一并丢弃，不会在关闭后转正");

  const again = openNow({ serverId: "s1", agentId: "zcode", component: "agent", reasonCode: "DEGRADED" });
  assert.notEqual(again.incidentId, zcode.incidentId, "重新打开后的新失败另开新事件");
});
