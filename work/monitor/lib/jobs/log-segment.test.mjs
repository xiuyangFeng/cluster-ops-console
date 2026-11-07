import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSegmentInvocation, loadSegmentScript, parseSegmentOutput, SEGMENT_MAX_BYTES, SEGMENT_REMOTE_COMMAND, textSignature } from "./log-segment.mjs";

const PYTHON = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
const pyTest = PYTHON && process.platform !== "win32" ? test : test.skip;

// 真跑远端脚本：本机 python3 + 临时目录里的日志。
function runRemote(request) {
  const inv = buildSegmentInvocation({ server: { id: "s1", host: "example" }, request });
  const bootstrap = SEGMENT_REMOTE_COMMAND.slice("python3 -c '".length, -1);
  const res = spawnSync(PYTHON, ["-c", bootstrap], { input: inv.input, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return parseSegmentOutput(res.stdout);
}

function withDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "log-segment-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("调用组装：远端命令是常量；路径、偏移、身份只走 stdin；不合格的身份字段不送", () => {
  const inv = buildSegmentInvocation({
    server: { id: "s1", host: "cluster" },
    request: { path: "/w/o_1.log", end: 100, expect: { ino: "12", size: 200, mtimeMs: 5, sig: "bad" } },
  });
  assert.equal(inv.args.at(-1), SEGMENT_REMOTE_COMMAND);
  assert.ok(!inv.args.join(" ").includes("/w/o_1.log"));
  const [first, second] = inv.input.split("\n");
  assert.equal(JSON.parse(first), loadSegmentScript());
  assert.deepEqual(JSON.parse(second), { path: "/w/o_1.log", max: SEGMENT_MAX_BYTES, end: 100, expect: { ino: "12", size: 200, mtimeMs: 5 } });
  const skip = JSON.parse(buildSegmentInvocation({ request: { path: "/a", skip: 7 } }).input.split("\n")[1]);
  assert.deepEqual([skip.skip, skip.end], [7, undefined]);
});

test("输出解析：只认已知类型、区间自洽、文本封顶；错误码白名单", () => {
  const seg = { k: "seg", start: 10, end: 20, dropped: 3, noBreak: false, size: 30, ino: "77", mt: 5, sig: `5-${"a".repeat(40)}`, t: "hello" };
  assert.deepEqual(parseSegmentOutput(`noise\n${JSON.stringify(seg)}\n`), {
    ok: true,
    segment: { start: 10, end: 20, dropped: 3, noBreak: false, size: 30, ino: "77", mtimeMs: 5, sig: seg.sig, text: "hello" },
  });
  for (const bad of [{ ...seg, start: 25 }, { ...seg, end: 40 }, { ...seg, ino: 77 }, { ...seg, t: 1 }, { ...seg, start: 0, end: SEGMENT_MAX_BYTES + 1, size: SEGMENT_MAX_BYTES + 1 }]) {
    assert.deepEqual(parseSegmentOutput(JSON.stringify(bad)), { ok: false, code: null });
  }
  assert.deepEqual(parseSegmentOutput(JSON.stringify({ k: "err", code: "rotated" })), { ok: false, code: "rotated" });
  assert.deepEqual(parseSegmentOutput(JSON.stringify({ k: "err", code: "rm -rf" })), { ok: false, code: "unreadable" });
  assert.deepEqual(parseSegmentOutput(""), { ok: false, code: null });
});

test("文本签名：与远端同算法；含替换字符（坏字节）时不签", () => {
  assert.match(textSignature("abc"), /^3-[0-9a-f]{40}$/);
  assert.equal(textSignature("x".repeat(100)).split("-")[0], "64");
  assert.equal(textSignature("bad �"), null);
  assert.equal(textSignature(""), null);
});

pyTest("远端脚本：按行边界往前取一段，丢掉的不完整首行由下一段补回，到开头为止", () => {
  withDir((dir) => {
    const file = path.join(dir, "o.log");
    const lines = Array.from({ length: 4000 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"z".repeat(i % 17)}`);
    const body = `${lines.join("\n")}\n`;
    writeFileSync(file, body);
    const size = Buffer.byteLength(body);
    const first = runRemote({ path: file, skip: 0 });
    assert.equal(first.ok, true);
    const s = first.segment;
    assert.equal(s.end, size);
    assert.ok(s.end - s.start <= SEGMENT_MAX_BYTES);
    assert.ok(s.dropped > 0, "从中间开始：首个不完整的行被丢掉");
    assert.ok(/^line \d{4}/.test(s.text), "段首是完整的行");
    assert.equal(s.text, body.slice(s.start, s.end));
    // 一路往前读到开头，拼起来与原文逐字节一致。
    const parts = [s.text];
    let cursor = s;
    let guard = 0;
    while (cursor.start > 0 && guard++ < 20) {
      const next = runRemote({ path: file, end: cursor.start, expect: { ino: cursor.ino, size: cursor.size, mtimeMs: cursor.mtimeMs, sig: cursor.sig } });
      assert.equal(next.ok, true, JSON.stringify(next));
      parts.unshift(next.segment.text);
      cursor = next.segment;
    }
    assert.equal(cursor.start, 0);
    assert.equal(parts.join(""), body);
  });
});

pyTest("远端脚本：文件身份——轮转 / 截断 / 原地改写 / 删除都停下，追加不算变化", () => {
  withDir((dir) => {
    const file = path.join(dir, "o.log");
    writeFileSync(file, "a\n".repeat(30000));
    const first = runRemote({ path: file, skip: 0 }).segment;
    const expect = { ino: first.ino, size: first.size, mtimeMs: first.mtimeMs, sig: first.sig };
    appendFileSync(file, "more\n");
    assert.equal(runRemote({ path: file, end: first.start, expect }).ok, true, "运行中的作业日志在增长：旧区间仍可读");
    // 原地重写成更长的不同内容：inode 与大小都过关，衔接处签名对不上。
    writeFileSync(file, "b\n".repeat(40000));
    assert.deepEqual(runRemote({ path: file, end: first.start, expect }), { ok: false, code: "rewritten" });
    writeFileSync(file, "short\n");
    assert.deepEqual(runRemote({ path: file, end: first.start, expect }), { ok: false, code: "truncated" });
    rmSync(file);
    writeFileSync(file, "a\n".repeat(30000));
    assert.deepEqual(runRemote({ path: file, end: first.start, expect: { ...expect, ino: first.ino === "1" ? "2" : "1" } }), { ok: false, code: "rotated" });
    rmSync(file);
    assert.deepEqual(runRemote({ path: file, end: first.start, expect }), { ok: false, code: "missing" });
  });
});

pyTest("远端脚本：大小不变但修改时刻变了 = 改写；目录 / 二进制拒绝；符号链接按目标普通文件读", () => {
  withDir((dir) => {
    const file = path.join(dir, "o.log");
    writeFileSync(file, "x\n".repeat(100));
    const seg = runRemote({ path: file, skip: 0 }).segment;
    assert.equal(seg.start, 0, "小文件一段读完");
    assert.equal(seg.dropped, 0);
    assert.deepEqual(runRemote({ path: file, end: 100, expect: { size: seg.size, mtimeMs: seg.mtimeMs + 5000 } }), { ok: false, code: "rewritten" });
    assert.deepEqual(runRemote({ path: dir, skip: 0 }), { ok: false, code: "notRegular" });
    const bin = path.join(dir, "ckpt.log");
    writeFileSync(bin, Buffer.from([1, 0, 2, 10]));
    assert.deepEqual(runRemote({ path: bin, skip: 0 }), { ok: false, code: "binary" });
    const link = path.join(dir, "link.log");
    symlinkSync(file, link);
    assert.equal(runRemote({ path: link, skip: 0 }).ok, true);
    assert.deepEqual(runRemote({ path: "relative.log", skip: 0 }), { ok: false, code: "unreadable" });
  });
});

pyTest("远端脚本：整段没有换行时原样保留并注明；end 超过文件大小 = 截断", () => {
  withDir((dir) => {
    const file = path.join(dir, "one.log");
    writeFileSync(file, "q".repeat(SEGMENT_MAX_BYTES * 2));
    const seg = runRemote({ path: file, skip: 0 }).segment;
    assert.deepEqual([seg.noBreak, seg.dropped, seg.end - seg.start], [true, 0, SEGMENT_MAX_BYTES]);
    assert.deepEqual(runRemote({ path: file, end: SEGMENT_MAX_BYTES * 3 }), { ok: false, code: "truncated" });
  });
});
