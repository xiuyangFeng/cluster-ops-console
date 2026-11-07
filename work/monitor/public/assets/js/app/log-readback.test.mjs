import assert from "node:assert/strict";
import test from "node:test";

import { createLogReadback, LOG_READBACK_TIMEOUT_MS, READBACK_SEGMENTS_MAX } from "./log-readback.js";

const seg = (start, end, extra = {}) => ({
  jobId: "9", from: "diagnosis", log: "0", path: "/w/o.log", start, end, size: 1000, dropped: 4, noBreak: false, text: `[${start}-${end}]`,
  atStart: start === 0, next: start > 0 ? { before: start, ino: "77", size: 1000, mtimeMs: 5, sig: `3-${"a".repeat(40)}` } : null,
  anchorText: "TAIL", anchorCheckedAt: null, continuous: true, notes: ["n1"], ...extra,
});

function harness(replies) {
  const calls = [];
  let changes = 0;
  const rb = createLogReadback({
    getJson: async (url, opts) => {
      calls.push({ url: new URL(url, "http://x"), opts });
      const next = replies.shift();
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    },
    onChange: () => { changes += 1; },
  });
  rb.setServer("server 01");
  return { rb, calls, changes: () => changes };
}

test("第一段不带游标；之后原样带回后端给的游标，新读到的更早一段插在最前；到开头为止", async () => {
  const { rb, calls } = harness([seg(600, 900), seg(0, 600)]);
  await rb.read("diagnosis", "9", "0");
  const first = calls[0].url.searchParams;
  assert.deepEqual(Object.fromEntries(first), { serverId: "server 01", jobId: "9", from: "diagnosis", log: "0" });
  assert.equal(calls[0].opts.timeoutMs, LOG_READBACK_TIMEOUT_MS);
  let r = rb.view("diagnosis", "9").readers.get("0");
  assert.deepEqual([r.segments.length, r.anchorText, r.notes, r.atStart], [1, "TAIL", ["n1"], false]);
  await rb.read("diagnosis", "9", "0");
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { serverId: "server 01", jobId: "9", from: "diagnosis", log: "0", before: "600", ino: "77", size: "1000", mtimeMs: "5", sig: `3-${"a".repeat(40)}` });
  r = rb.view("diagnosis", "9").readers.get("0");
  assert.deepEqual(r.segments.map((s) => s.text), ["[0-600]", "[600-900]"]);
  assert.equal(r.atStart, true);
  await rb.read("diagnosis", "9", "0");
  assert.equal(calls.length, 2, "到开头后不再发请求");
  assert.ok(rb.revision() > 0);
});

test("文件身份失效（409 + code）→ 停用旧游标；「重新读取」走 fresh 并清掉旧段；其它错误可重试", async () => {
  const gone = Object.assign(new Error("HTTP 409"), { status: 409, code: "rotated", serverMessage: "日志文件已被替换" });
  const busy = Object.assign(new Error("HTTP 429"), { status: 429, serverMessage: "已有日志读取在进行" });
  const { rb, calls } = harness([seg(600, 900), gone, seg(0, 50, { continuous: false, anchorText: null, notes: [] }), busy]);
  await rb.read("watch", "18765", "stdout");
  await rb.read("watch", "18765", "stdout");
  let r = rb.view("watch", "18765").readers.get("stdout");
  assert.deepEqual([r.stopped, r.code, r.error, r.segments.length], [true, "rotated", "日志文件已被替换", 1]);
  await rb.read("watch", "18765", "stdout");
  assert.equal(calls.length, 2, "停用后不再沿用旧游标");
  rb.handleAction({ lrAction: "restart", lrFrom: "watch", lrJob: "18765", lrLog: "stdout" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[2].url.searchParams.get("fresh"), "1");
  assert.equal(calls[2].url.searchParams.get("before"), null);
  r = rb.view("watch", "18765").readers.get("stdout");
  assert.deepEqual([r.stopped, r.fresh, r.segments.map((s) => s.text)], [false, true, ["[0-50]"]]);
  await rb.read("watch", "18765", "stderr");
  const e = rb.view("watch", "18765").readers.get("stderr");
  assert.deepEqual([e.stopped, e.error], [false, "已有日志读取在进行"], "非身份错误：保留重试");
});

test("换服务器清空；迟到响应丢弃；读取中不重复发；段数封顶；非法参数不发", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { rb, calls } = harness([async () => { await gate; return seg(600, 900); }]);
  const pending = rb.read("diagnosis", "9", "0");
  rb.read("diagnosis", "9", "0");
  assert.equal(calls.length, 1);
  rb.setServer("server-02");
  release();
  await pending;
  assert.equal(rb.view("diagnosis", "9").readers.size, 0, "迟到的旧服务器结果不落到新服务器");
  await rb.read("diagnosis", "9;rm", "0");
  await rb.read("diagnosis", "9", "/etc/passwd");
  assert.equal(calls.length, 1);

  const many = harness(Array.from({ length: READBACK_SEGMENTS_MAX + 2 }, (_, i) => seg(10000 - (i + 1) * 100, 10000 - i * 100)));
  for (let i = 0; i < READBACK_SEGMENTS_MAX + 2; i += 1) await many.rb.read("diagnosis", "9", "0");
  const r = many.rb.view("diagnosis", "9").readers.get("0");
  assert.deepEqual([r.segments.length, r.capped, many.calls.length], [READBACK_SEGMENTS_MAX, true, READBACK_SEGMENTS_MAX]);
});

test("选择流只换显示，不发请求", () => {
  const { rb, calls, changes } = harness([]);
  rb.handleAction({ lrAction: "pick", lrFrom: "watch", lrJob: "1", lrLog: "stderr" });
  assert.deepEqual([rb.view("watch", "1").log, calls.length, changes()], ["stderr", 0, 1]);
  rb.handleAction({ lrAction: "pick", lrFrom: "elsewhere", lrJob: "1", lrLog: "stdout" });
  assert.equal(rb.view("watch", "1").log, "stderr");
});
