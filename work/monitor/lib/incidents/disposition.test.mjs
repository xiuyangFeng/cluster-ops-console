import assert from "node:assert/strict";
import { test } from "node:test";

import { createIncidentStore } from "./store.mjs";
import {
  addDisposition, DISPOSITION_MAX, DISPOSITION_VERIFY_MS, expireDispositions, hasPendingDisposition, normalizeDispositions, settleOnRecovery,
} from "./disposition.mjs";

const T0 = 1_800_000_000_000;

test("addDisposition：同一操作只记一次，最多留最近几条，畸形入参不记", () => {
  let list = addDisposition([], { operationId: "op-1", at: T0, action: "restart-tunnel", trigger: "auto" });
  assert.deepEqual(list, [{ operationId: "op-1", at: T0, action: "restart-tunnel", trigger: "auto", outcome: null, settledAt: null, afterMs: null }]);
  assert.equal(addDisposition(list, { operationId: "op-1", at: T0 + 1 }), list, "重复：返回原数组");
  assert.equal(addDisposition(list, { operationId: "", at: T0 }), list);
  assert.equal(addDisposition(list, { operationId: "op-x" }), list, "没有时刻");
  for (let i = 2; i <= DISPOSITION_MAX + 3; i += 1) list = addDisposition(list, { operationId: `op-${i}`, at: T0 + i });
  assert.equal(list.length, DISPOSITION_MAX);
  assert.equal(list.at(-1).operationId, `op-${DISPOSITION_MAX + 3}`);
  assert.equal(list.at(-1).action, "restart-channel", "未知动作按整通道重启记");
  assert.equal(list.at(-1).trigger, "manual");
});

test("恢复：等待复核的记 recovered（带用时），已判未恢复的改记 recovered-late；早于受理的恢复不算", () => {
  const list = [
    { operationId: "a", at: T0, action: "restart-tunnel", trigger: "manual", outcome: null, settledAt: null, afterMs: null },
    { operationId: "b", at: T0 - DISPOSITION_VERIFY_MS - 1, action: "restart-channel", trigger: "auto", outcome: "not-recovered", settledAt: T0 - 1, afterMs: null },
    { operationId: "c", at: T0 + 99_000, action: "restart-tunnel", trigger: "manual", outcome: null, settledAt: null, afterMs: null },
  ];
  const { list: next, changed } = settleOnRecovery(list, T0 + 38_000);
  assert.equal(changed, true);
  assert.deepEqual(next.map((d) => [d.operationId, d.outcome, d.afterMs]), [
    ["a", "recovered", 38_000],
    ["b", "recovered-late", 38_000 + DISPOSITION_VERIFY_MS + 1],
    ["c", null, null],
  ]);
  assert.equal(settleOnRecovery([], T0).changed, false);
});

test("复核到时：受理满 3 分钟仍在等待的记 not-recovered；没到时限、已有结果的不动", () => {
  const list = normalizeDispositions([
    { operationId: "a", at: T0 },
    { operationId: "b", at: T0 + 60_000 },
    { operationId: "c", at: T0 - 1, outcome: "recovered", afterMs: 5 },
  ]);
  assert.equal(hasPendingDisposition(list), true);
  const early = expireDispositions(list, T0 + DISPOSITION_VERIFY_MS - 1);
  assert.equal(early.changed, false);
  const { list: next, changed } = expireDispositions(list, T0 + DISPOSITION_VERIFY_MS);
  assert.equal(changed, true);
  assert.deepEqual(next.map((d) => d.outcome), ["not-recovered", null, "recovered"]);
});

test("normalizeDispositions：读回的畸形数据逐条丢掉，不抛", () => {
  assert.deepEqual(normalizeDispositions(null), []);
  assert.deepEqual(normalizeDispositions([null, 1, { operationId: 3, at: 1 }, { operationId: "ok", at: "x" }]), []);
  assert.equal(normalizeDispositions([{ operationId: "ok", at: 1, outcome: "bogus" }])[0].outcome, null);
});

test("事件存储：处置受理记在事件上 → 恢复时记「N 秒后恢复」并随已关闭事件持久化；复核到时记「未恢复」", () => {
  let clock = T0;
  const store = createIncidentStore({ now: () => clock, openGate: {} });
  const a = store.observe({ serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  const b = store.observe({ serverId: "s2", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error" });
  store.linkOperation(a.incidentId, "op-a", { action: "restart-tunnel", trigger: "manual" });
  store.linkOperation(b.incidentId, "op-b", { action: "restart-channel", trigger: "auto" });
  const rev = store.getPersistRevisions().revision;
  store.linkOperation(a.incidentId, "op-a", { action: "restart-tunnel" });
  assert.equal(store.getPersistRevisions().revision, rev, "重复关联不算变化");
  store.linkOperation(a.incidentId, "op-legacy");
  assert.equal(store.get(a.incidentId).dispositions.length, 1, "不带处置信息的关联（旧调用方）只记操作 id");

  clock = T0 + 40_000;
  store.reportSuccess({ serverId: "s1", component: "tunnel", at: clock - 1000 });
  store.reportSuccess({ serverId: "s1", component: "tunnel", at: clock });
  const resolved = store.get(a.incidentId);
  assert.equal(resolved.lifecycle, "resolved");
  assert.deepEqual(resolved.dispositions.map((d) => [d.operationId, d.outcome, d.afterMs]), [["op-a", "recovered", 40_000]]);

  assert.deepEqual(store.verifyDispositions(T0 + DISPOSITION_VERIFY_MS - 1), []);
  const touched = store.verifyDispositions(T0 + DISPOSITION_VERIFY_MS);
  assert.deepEqual(touched.map((i) => i.incidentId), [b.incidentId]);
  assert.equal(store.get(b.incidentId).dispositions[0].outcome, "not-recovered");
  assert.equal(store.get(b.incidentId).dispositions[0].trigger, "auto");

  const reloaded = createIncidentStore({ now: () => clock, openGate: {} });
  reloaded.loadSnapshot(JSON.parse(store.serializeMainForSave()), { closed: JSON.parse(store.serializeClosedForSave()) });
  assert.equal(reloaded.get(a.incidentId).dispositions[0].outcome, "recovered");
  assert.equal(reloaded.get(b.incidentId).dispositions[0].outcome, "not-recovered");
  assert.deepEqual(reloaded.list({ state: "open" }).map((i) => i.incidentId), [b.incidentId]);
  assert.equal(reloaded.get("nope"), null);
});
