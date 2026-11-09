import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bus, EVENTS } from "../event-bus.mjs";
import { createSseHub } from "./sse.mjs";

test("切换查看对象但健康级别未变化时，SSE 仍推送新配置版本；断开后移除监听", () => {
  const before = bus.listenerCount(EVENTS.LEVELS_REBASED);
  let revision = 2;
  const frames = [];
  const req = new EventEmitter();
  const res = { writableLength: 0, writeHead() {}, write: (s) => frames.push(s), end() {} };
  const hub = createSseHub({ maxConnections: 2, heartbeatMs: 60000, statusPayload: {
    initialStatusFrame: () => ({ lite: { personalRevision: revision }, layers: {} }),
    statusFrame: (frame) => frame,
  } });
  try {
    hub.handle(req, res);
    revision = 4;
    bus.emit(EVENTS.LEVELS_REBASED, { view: "fixture-server", levels: {} });
    assert.equal(frames.length, 2);
    assert(frames[1].startsWith("event: status\n"));
    assert.equal(JSON.parse(frames[1].split("data: ")[1]).lite.personalRevision, 4);
  } finally { req.emit("close"); }
  assert.equal(bus.listenerCount(EVENTS.LEVELS_REBASED), before);
  bus.emit(EVENTS.LEVELS_REBASED, { view: "other", levels: {} });
  assert.equal(frames.length, 2);
});
