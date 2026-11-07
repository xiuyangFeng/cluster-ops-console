// onLogSignals 出口：分诊只在有 warn/error 时取快照；日志级别与历史计数口径。
import assert from "node:assert/strict";
import test from "node:test";

import { createLogSignalsHandler } from "./signal-sink.mjs";

function harness() {
  const writes = [];
  const history = [];
  let snapshots = 0;
  const logger = (level) => (message, fields) => writes.push({ level, message, ...fields });
  const onLogSignals = createLogSignalsHandler({
    store: {
      getLayers: () => {
        snapshots += 1;
        return { channel: { level: "error", detail: {} }, agents: {} };
      },
      getLegacyStatus: () => ({ agentsStatus: {}, health: "error" }),
    },
    signalLogger: { error: logger("error"), warn: logger("warn"), info: logger("info") },
    historyStore: { record: (entry) => history.push(entry) },
  });
  return { onLogSignals, writes, history, snapshotCount: () => snapshots };
}

const signal = (id, severity) => ({ id, severity, title: `T-${id}`, sample: "line", advice: "do x", category: "net", sourceId: "src" });

test("info 采样批：不取状态快照、按 info 落盘、不进历史计数", () => {
  const h = harness();
  h.onLogSignals([signal("a", "info")], []);
  assert.equal(h.snapshotCount(), 0);
  assert.deepEqual(h.writes.map((w) => [w.level, w.message, w.signalId, "rootCause" in w]), [["info", "[T-a] line —— do x", "a", false]]);
  assert.deepEqual(h.history, []);
});

test("warn/error 批：取一次快照分诊，分类字段随日志与历史落盘，active 浅拷贝同步补写", () => {
  const h = harness();
  const active = [{ id: "b" }];
  h.onLogSignals([signal("b", "error"), signal("c", "warn")], active);
  assert.equal(h.snapshotCount(), 1);
  assert.deepEqual(h.writes.map((w) => w.level), ["error", "warn"]);
  assert.ok(h.writes.every((w) => typeof w.rootCause === "string" && w.rootCauseLabel && w.rootCauseAdvice));
  assert.equal(active[0].rootCause, h.writes[0].rootCause);
  assert.deepEqual(h.history.map((e) => [e.type, e.signalId, e.severity, typeof e.rootCause]), [
    ["signal", "b", "error", "string"],
    ["signal", "c", "warn", "string"],
  ]);
});
