import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterIncidents, INCIDENT_CLUSTER_GAP_MS, INCIDENT_CLUSTER_MEMBERS_MAX, recurrenceMap, recurrenceOf } from "./clusters.mjs";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 23, 2, 0, 0);
let seq = 0;
function incident({ serverId = "s1", agentId = null, component = "tunnel", reasonCode = "TUNNEL_DOWN", start, end = null, severity = "error", occurrences = 2, ops = [] }) {
  seq += 1;
  return {
    incidentId: `i${String(seq).padStart(3, "0")}`,
    serverId, agentId, component, reasonCode, severity, occurrences,
    lifecycle: end == null ? "open" : "resolved",
    firstSeenAt: start,
    lastSeenAt: end ?? start + MIN,
    resolvedAt: end,
    relatedOperationIds: ops,
  };
}

test("事件簇：同一类 15 分钟内接连发生的合成一簇——次数、累计故障时长、首次 / 最近、跨度", () => {
  const flaps = [[0, 2], [4, 1], [7, 3], [12, 1]].map(([o, d]) => incident({ start: T0 + o * MIN, end: T0 + (o + d) * MIN }));
  const [cluster, ...rest] = clusterIncidents(flaps, { nowMs: T0 + 60 * MIN });
  assert.equal(rest.length, 0);
  assert.equal(cluster.count, 4);
  assert.equal(cluster.occurrences, 8);
  assert.equal(cluster.downMs, 7 * MIN);
  assert.equal(cluster.firstSeenAt, T0);
  assert.equal(cluster.lastSeenAt, T0 + 13 * MIN);
  assert.equal(cluster.resolvedAt, T0 + 13 * MIN);
  assert.equal(cluster.spanMs, 13 * MIN);
  assert.equal(cluster.open, false);
  assert.equal(cluster.clusterId, flaps[0].incidentId, "簇 id = 最早一条");
  assert.deepEqual(cluster.members.map((m) => m.incidentId), flaps.map((f) => f.incidentId).reverse(), "成员最新在前");
});

test("事件簇：间隔超过 15 分钟另起一簇；不同服务器 / 原因 / Agent 不合并", () => {
  const list = [
    incident({ start: T0, end: T0 + MIN }),
    incident({ start: T0 + MIN + INCIDENT_CLUSTER_GAP_MS + 1, end: T0 + 30 * MIN }),
    incident({ serverId: "s2", start: T0 + 2 * MIN, end: T0 + 3 * MIN }),
    incident({ component: "channel", reasonCode: "REMOTE_PORT_CLOSED", start: T0 + 2 * MIN, end: T0 + 3 * MIN }),
    incident({ component: "agent", agentId: "codex", reasonCode: "DEGRADED", start: T0, end: T0 + MIN }),
    incident({ component: "agent", agentId: "claude", reasonCode: "DEGRADED", start: T0 + 2 * MIN, end: T0 + 3 * MIN }),
  ];
  const clusters = clusterIncidents(list, { nowMs: T0 + 60 * MIN });
  assert.equal(clusters.length, 6);
  assert.ok(clusters.every((c) => c.count === 1));
  assert.equal(clusters[0].lastSeenAt, T0 + 30 * MIN, "按最近一次倒序");
});

test("事件簇：含未恢复的成员时整簇未恢复，故障时长算到现在；严重度取最高；处置日志取最近的 3 个", () => {
  const list = [
    incident({ start: T0, end: T0 + 2 * MIN, severity: "warn", ops: ["op-1"] }),
    incident({ start: T0 + 5 * MIN, end: T0 + 6 * MIN, ops: ["op-2", "op-3"] }),
    incident({ start: T0 + 10 * MIN, ops: ["op-4"] }),
  ];
  const [cluster] = clusterIncidents(list, { nowMs: T0 + 20 * MIN });
  assert.equal(cluster.open, true);
  assert.equal(cluster.resolvedAt, null);
  assert.equal(cluster.severity, "error");
  assert.equal(cluster.downMs, 2 * MIN + MIN + 10 * MIN);
  assert.equal(cluster.spanMs, 20 * MIN);
  assert.deepEqual(cluster.operationIds, ["op-4", "op-2", "op-3"]);
});

test("事件簇：成员列表有上限，统计量按全部成员算；畸形条目跳过不抛", () => {
  const many = Array.from({ length: INCIDENT_CLUSTER_MEMBERS_MAX + 5 }, (_, i) => incident({ start: T0 + i * 2 * MIN, end: T0 + i * 2 * MIN + MIN }));
  const [cluster] = clusterIncidents([...many, null, { incidentId: "x" }, { firstSeenAt: T0 }], { nowMs: T0 + 999 * MIN });
  assert.equal(cluster.count, INCIDENT_CLUSTER_MEMBERS_MAX + 5);
  assert.equal(cluster.members.length, INCIDENT_CLUSTER_MEMBERS_MAX);
  assert.deepEqual(clusterIncidents(undefined), []);
});

test("recurrenceOf：未解决事件之前紧挨着的同类已恢复事件——第几次、从几点开始、之前累计断了多久", () => {
  const before = [
    incident({ start: T0, end: T0 + 2 * MIN }),
    incident({ start: T0 + 10 * MIN, end: T0 + 11 * MIN }),
    incident({ start: T0 + 20 * MIN, end: T0 + 23 * MIN }),
  ];
  const far = incident({ start: T0 - 120 * MIN, end: T0 - 100 * MIN });
  const other = incident({ serverId: "s2", start: T0 + 25 * MIN, end: T0 + 26 * MIN });
  const current = incident({ start: T0 + 30 * MIN });
  assert.deepEqual(recurrenceOf(current, [...before, far, other]), { count: 4, sinceAt: T0, downMs: 6 * MIN });
  assert.equal(recurrenceOf(incident({ serverId: "s3", start: T0 }), before), null, "之前没有同类：不带");
  assert.equal(recurrenceOf(incident({ start: T0 + 60 * MIN }), before), null, "离上一次超过 15 分钟：不算一串");
});

test("recurrenceMap：一批未解决事件一起算，结果与逐条 recurrenceOf 一致；没有前情的不在表里", () => {
  const resolved = [
    incident({ start: T0, end: T0 + 2 * MIN }),
    incident({ serverId: "s2", start: T0, end: T0 + MIN }),
    incident({ serverId: "s2", start: T0 + 5 * MIN, end: T0 + 6 * MIN }),
    incident({ component: "channel", reasonCode: "REMOTE_PORT_CLOSED", start: T0, end: T0 + MIN }),
  ];
  const open = [incident({ start: T0 + 10 * MIN }), incident({ serverId: "s2", start: T0 + 12 * MIN }), incident({ serverId: "s3", start: T0 + 12 * MIN })];
  const map = recurrenceMap(open, resolved);
  assert.equal(map.size, 2);
  for (const item of open) assert.deepEqual(map.get(item.incidentId) ?? null, recurrenceOf(item, resolved));
  assert.equal(recurrenceMap([], resolved).size, 0);
});
