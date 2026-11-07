import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createErrorReporter, describeErrorEvent, describeRejectionEvent, REPORT_LIMITS, shouldIgnoreReport } from "./error-reporter.js";

function harness({ ready = true, send } = {}) {
  let now = 0;
  const sent = [];
  const reporter = createErrorReporter({ send: send || ((payload) => { sent.push(payload); return Promise.resolve(); }), now: () => now, page: "main" });
  if (ready) reporter.markReady();
  return { reporter, sent, advance: (ms) => { now += ms; } };
}

const report = (message, extra = {}) => ({ kind: "error", message, source: "http://127.0.0.1:8877/app.js", line: 1, column: 2, stack: "", ...extra });

test("describeErrorEvent：优先取 error 对象的类型、消息与栈；位置去掉查询串；没有消息返回 null", () => {
  const err = new TypeError("x is undefined");
  const out = describeErrorEvent({ error: err, message: "Uncaught TypeError: x is undefined", filename: "http://127.0.0.1:8877/assets/js/a.js?token=abc", lineno: 12, colno: 5 });
  assert.equal(out.kind, "error");
  assert.equal(out.message, "TypeError: x is undefined");
  assert.equal(out.source, "http://127.0.0.1:8877/assets/js/a.js");
  assert.deepEqual([out.line, out.column], [12, 5]);
  assert.match(out.stack, /TypeError: x is undefined/);
  assert.equal(describeErrorEvent({ message: "" }), null);
  const plain = describeErrorEvent({ message: "boom", filename: "", lineno: -1 });
  assert.deepEqual([plain.message, plain.line, plain.stack], ["boom", null, ""]);
  assert.ok(describeErrorEvent({ message: "m".repeat(2000) }).message.length <= REPORT_LIMITS.message + 1);
});

test("describeRejectionEvent：Error / 字符串 / 对象都能描述；位置取栈里第一处地址", () => {
  const err = new Error("network down");
  err.stack = "Error: network down\n    at load (http://127.0.0.1:8877/assets/js/app/x.js?v=1:40:7)\n    at y (http://127.0.0.1:8877/app.js:1:1)";
  const out = describeRejectionEvent({ reason: err });
  assert.deepEqual([out.kind, out.message, out.source, out.line, out.column], ["unhandledrejection", "network down", "http://127.0.0.1:8877/assets/js/app/x.js", 40, 7]);
  assert.equal(describeRejectionEvent({ reason: "plain" }).message, "plain");
  assert.equal(describeRejectionEvent({ reason: { code: 7 } }).message, '{"code":7}');
  assert.equal(describeRejectionEvent({ reason: undefined }).message.length > 0, true);
});

test("shouldIgnoreReport：扩展脚本、跨源「Script error.」、ResizeObserver 告警不报", () => {
  assert.equal(shouldIgnoreReport(null), true);
  assert.equal(shouldIgnoreReport(report("x", { source: "chrome-extension://abc/content.js" })), true);
  assert.equal(shouldIgnoreReport(report("Script error.")), true);
  assert.equal(shouldIgnoreReport(report("ResizeObserver loop completed with undelivered notifications.")), true);
  assert.equal(shouldIgnoreReport(report("TypeError: x")), false);
});

test("去重：同一条（消息 + 位置）10 分钟内只报一次，再报时带上期间出现的次数", () => {
  const h = harness();
  assert.equal(h.reporter.capture(report("A")), "sent");
  assert.equal(h.reporter.capture(report("A")), "duplicate");
  assert.equal(h.reporter.capture(report("A")), "duplicate");
  assert.equal(h.reporter.capture(report("A", { line: 99 })), "sent", "位置不同算另一条");
  h.advance(REPORT_LIMITS.dedupeMs);
  assert.equal(h.reporter.capture(report("A")), "sent");
  assert.deepEqual(h.sent.map((p) => [p.message, p.line, p.occurrences ?? 1, p.page]), [["A", 1, 1, "main"], ["A", 99, 1, "main"], ["A", 1, 3, "main"]]);
});

test("限流：每分钟最多 10 条，过了一分钟恢复", () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) assert.equal(h.reporter.capture(report(`m${i}`)), "sent");
  assert.equal(h.reporter.capture(report("m10")), "rate-limited");
  h.advance(60_000);
  assert.equal(h.reporter.capture(report("m11")), "sent");
  assert.equal(h.sent.length, 11);
});

test("拿到令牌前出的错先攒着（最多 10 条），markReady 后一并补报，之后直接发", () => {
  const h = harness({ ready: false });
  for (let i = 0; i < 12; i += 1) h.reporter.capture(report(`early${i}`));
  assert.equal(h.sent.length, 0);
  h.reporter.markReady();
  assert.equal(h.sent.length, 10);
  h.reporter.markReady();
  assert.equal(h.sent.length, 10, "只补报一次");
});

test("上报失败不重试、不外抛（同步抛错与 Promise 拒绝都吞掉）", async () => {
  let calls = 0;
  const sync = harness({ send: () => { calls += 1; throw new Error("offline"); } });
  assert.doesNotThrow(() => sync.reporter.capture(report("x")));
  const asyncFail = harness({ send: () => { calls += 1; return Promise.reject(new Error("401")); } });
  asyncFail.reporter.capture(report("y"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
});

test("install：接 window 的 error 与 unhandledrejection", () => {
  const h = harness();
  const win = new EventEmitter();
  win.addEventListener = (name, fn) => win.on(name, fn);
  h.reporter.install(win);
  win.emit("error", { message: "boom", filename: "http://127.0.0.1:8877/app.js", lineno: 3, colno: 4 });
  win.emit("unhandledrejection", { reason: new Error("nope") });
  win.emit("error", { message: "" }); // 没有消息：不报也不抛
  assert.deepEqual(h.sent.map((p) => [p.kind, p.message]), [["error", "boom"], ["unhandledrejection", "nope"]]);
});
