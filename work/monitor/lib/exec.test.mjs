import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { execFileWithInput, execFileWithTimeout, DEFAULT_MAX_OUTPUT_BYTES } from "./exec.mjs";

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = [];
  child.kill = (sig) => child.killed.push(sig);
  return child;
}

// stdin 版的假 child：记录写入内容与 end 调用，便于断言"全量写入后立刻 end"。
function makeFakeChildWithStdin() {
  const child = makeFakeChild();
  const stdin = new EventEmitter();
  stdin.written = [];
  stdin.ended = false;
  stdin.write = (chunk) => {
    stdin.written.push(String(chunk));
    return true;
  };
  stdin.end = () => {
    stdin.ended = true;
  };
  child.stdin = stdin;
  return child;
}

// ---------------------------------------------------------------------------
// ENOENT / spawn 失败：Promise 必须正常结算（旧 probes 实现缺 child.on("error")，
// ENOENT 只触发 error 不触发 close，Promise 永挂）。
// ---------------------------------------------------------------------------

test("ENOENT：真实 spawn 不存在的二进制，Promise 正常结算不挂起", async () => {
  const result = await execFileWithTimeout("definitely-not-a-real-binary-xyz-12345", [], { timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.timedOut, false);
});

test("'error' 事件（假 child）结算 Promise 并清理定时器，close 迟到不二次结算", async () => {
  const child = makeFakeChild();
  const pending = execFileWithTimeout("ssh", ["host"], { timeoutMs: 60000, spawnImpl: () => child });
  child.emit("error", new Error("spawn ssh ENOENT"));
  const result = await pending;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  // 迟到的 close 不应改变结果或抛异常（settled 守卫）。
  child.emit("close", 0);
  assert.equal(result.code, 1);
});

test("spawnImpl 同步抛出时也结算为 code=1，不向外抛", async () => {
  const result = await execFileWithTimeout("x", [], {
    spawnImpl: () => {
      throw new Error("spawn x EACCES");
    },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /EACCES/);
});

// ---------------------------------------------------------------------------
// 超时：SIGTERM → 宽限 2s → SIGKILL，timedOut 显式标记。
// ---------------------------------------------------------------------------

test("超时先 SIGTERM，约 2 秒后补 SIGKILL，结果 timedOut=true", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = makeFakeChild();
  const pending = execFileWithTimeout("ssh", ["host"], { timeoutMs: 6000, spawnImpl: () => child });
  t.mock.timers.tick(6000);
  assert.deepEqual(child.killed, ["SIGTERM"]);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
  const result = await pending;
  assert.equal(result.timedOut, true);
  t.mock.timers.reset();
});

test("真实进程超时：睡 10s 的 node 子进程在 timeoutMs 内被杀掉", async () => {
  const startedAt = Date.now();
  const result = await execFileWithTimeout(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 5000, "不应等满子进程的 10s");
});

test("未超时的正常退出 timedOut=false 且不残留 killTimer", async () => {
  const child = makeFakeChild();
  const pending = execFileWithTimeout("ssh", ["host"], { timeoutMs: 6000, spawnImpl: () => child });
  child.stdout.emit("data", "hello ");
  child.stdout.emit("data", "world");
  child.stderr.emit("data", "warn");
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello world");
  assert.equal(result.stderr, "warn");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

// ---------------------------------------------------------------------------
// 输出上限：超限截断并标记 truncated，不再无界累积。
// ---------------------------------------------------------------------------

test("stdout 超过 maxOutputBytes 时截断并标记 truncated", async () => {
  const child = makeFakeChild();
  const pending = execFileWithTimeout("cat", [], { timeoutMs: 5000, spawnImpl: () => child, maxOutputBytes: 10 });
  child.stdout.emit("data", Buffer.from("0123456789ABCDEF"));
  child.stdout.emit("data", Buffer.from("more-after-limit"));
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.stdout, "0123456789");
  assert.equal(result.truncated, true);
  assert.equal(result.code, 0);
});

test("真实进程输出超限：200KB 输出在 1KB 上限下被截断", async () => {
  const result = await execFileWithTimeout(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(200000))'],
    { timeoutMs: 10000, maxOutputBytes: 1024 },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.truncated, true);
});

test("默认上限为 1MB", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1024 * 1024);
});

// ---------------------------------------------------------------------------
// 多字节 UTF-8 跨 chunk：data 事件的 Buffer 按 64KB 边界任意切片，拼接点若落在
// 汉字/emoji 中间，按块各自 toString() 会产生 U+FFFD 且不抛错（静默损坏远端采集文本）。
// ---------------------------------------------------------------------------

test("跨 chunk 的多字节 UTF-8 按字符边界切开后不被损坏", async () => {
  const child = makeFakeChild();
  const pending = execFileWithTimeout("cat", [], { timeoutMs: 5000, spawnImpl: () => child });
  const text = "服务器甲：隧道正常\n第二行 中文";
  const buf = Buffer.from(text, "utf8");
  const cut = buf.indexOf(Buffer.from("甲")) + 1; // 落在「甲」的 3 字节中间
  child.stdout.emit("data", buf.subarray(0, cut));
  child.stdout.emit("data", buf.subarray(cut));
  child.emit("close", 0);

  const result = await pending;
  assert.equal(result.stdout, text);
  assert.equal(result.stdout.includes("\uFFFD"), false, "不得出现替换符");
});

test("逐字节切分含 emoji 的输出也能完整还原", async () => {
  const child = makeFakeChild();
  const pending = execFileWithTimeout("cat", [], { timeoutMs: 5000, spawnImpl: () => child });
  const text = "状态正常 ✅ 结束";
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += 1) child.stdout.emit("data", buf.subarray(i, i + 1));
  child.emit("close", 0);

  const result = await pending;
  assert.equal(result.stdout, text);
});

test("截断对齐字符边界时：保留完整字符、无替换符", async () => {
  const child = makeFakeChild();
  // 每个汉字 3 字节，上限 6 恰好容纳「服务」两个整字。
  const pending = execFileWithTimeout("cat", [], { timeoutMs: 5000, spawnImpl: () => child, maxOutputBytes: 6 });
  child.stdout.emit("data", Buffer.from("服务甲尾", "utf8"));
  child.emit("close", 0);

  const result = await pending;
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, "服务");
});

test("截断落在多字节字符中间时：仅被切断的那个字符降级，前文不受污染", async () => {
  const child = makeFakeChild();
  // 上限 4：容纳「服」(3B) + 「务」的第 1 字节 → 「务」不完整。
  const pending = execFileWithTimeout("cat", [], { timeoutMs: 5000, spawnImpl: () => child, maxOutputBytes: 4 });
  child.stdout.emit("data", Buffer.from("服务甲尾", "utf8"));
  child.emit("close", 0);

  const result = await pending;
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, "服\uFFFD", "完整字符必须保留，只有被切断的那个降级为替换符");
  assert.equal(result.stdout.startsWith("服"), true);
});

// ---------------------------------------------------------------------------
// 正常场景（真实进程）。
// ---------------------------------------------------------------------------

test("真实进程正常退出：code/stdout/stderr 齐全", async () => {
  const result = await execFileWithTimeout(
    process.execPath,
    ["-e", 'console.log("out-line"); console.error("err-line")'],
    { timeoutMs: 10000 },
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /out-line/);
  assert.match(result.stderr, /err-line/);
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("非零退出码原样透传", async () => {
  const result = await execFileWithTimeout(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10000 });
  assert.equal(result.code, 3);
});

// ---------------------------------------------------------------------------
// execFileWithInput：零残留采集脚本经 stdin 送到远端（`ssh host "env ... sh -s"`）。
// 返回形状与 execFileWithTimeout 完全一致。
// ---------------------------------------------------------------------------

const ECHO_STDIN = 'let n=0;process.stdin.on("data",(c)=>{n+=c.length});process.stdin.on("end",()=>{process.stdout.write("GOT:"+n)})';

test("execFileWithInput: stdin 全量写入（100KB 脚本一字不少）", async () => {
  const input = "x".repeat(102400);
  const result = await execFileWithInput(process.execPath, ["-e", ECHO_STDIN], { input, timeoutMs: 10000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "GOT:102400");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("execFileWithInput: 真实脚本原样送达并被 sh 执行", { skip: process.platform === "win32" }, async () => {
  const script = '#!/bin/sh\nprintf "__CT_BEGIN t__\\n"\nprintf "%s\\n" "$CT_X"\nprintf "__CT_END t__\\n"\n';
  const result = await execFileWithInput("/bin/sh", ["-s"], {
    input: script,
    timeoutMs: 10000,
    env: { ...process.env, CT_X: "hello" },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "__CT_BEGIN t__\nhello\n__CT_END t__\n");
});

test("execFileWithInput: 超时先 SIGTERM 再 SIGKILL，timedOut=true", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = makeFakeChildWithStdin();
  const pending = execFileWithInput("ssh", ["host"], { input: "script", timeoutMs: 6000, spawnImpl: () => child });
  assert.deepEqual(child.stdin.written, ["script"]);
  assert.equal(child.stdin.ended, true, "写完必须立刻 end，否则远端 sh -s 永远读不到 EOF");
  t.mock.timers.tick(6000);
  assert.deepEqual(child.killed, ["SIGTERM"]);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null);
  const result = await pending;
  assert.equal(result.timedOut, true);
  t.mock.timers.reset();
});

test("execFileWithInput: 真实进程超时被杀掉，不等满子进程寿命", async () => {
  const startedAt = Date.now();
  const result = await execFileWithInput(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    input: "ignored",
    timeoutMs: 300,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - startedAt < 5000);
});

test("execFileWithInput: 非零退出码原样透传，stderr 齐全", async () => {
  const result = await execFileWithInput(
    process.execPath,
    ["-e", 'console.error("boom"); process.exit(3)'],
    { input: "unused", timeoutMs: 10000 },
  );
  assert.equal(result.code, 3);
  assert.match(result.stderr, /boom/);
});

test("execFileWithInput: 子进程不读 stdin 就退出（EPIPE）不抛，正常结算", async () => {
  const result = await execFileWithInput(process.execPath, ["-e", "process.exit(0)"], {
    input: "y".repeat(1024 * 1024),
    timeoutMs: 10000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
});

test("execFileWithInput: stdin 的 'error' 事件（EPIPE）被吞掉，不变成 unhandled", async () => {
  const child = makeFakeChildWithStdin();
  const pending = execFileWithInput("ssh", ["host"], { input: "script", timeoutMs: 60000, spawnImpl: () => child });
  child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.code, 0);
});

test("execFileWithInput: stdin.write 同步抛出也不影响结算", async () => {
  const child = makeFakeChildWithStdin();
  child.stdin.write = () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  };
  const pending = execFileWithInput("ssh", ["host"], { input: "script", timeoutMs: 60000, spawnImpl: () => child });
  child.stdout.emit("data", "partial");
  child.emit("close", 0);
  const result = await pending;
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "partial");
});

test("execFileWithInput: ENOENT 正常结算不挂起", async () => {
  const result = await execFileWithInput("definitely-not-a-real-binary-xyz-12345", [], { input: "x", timeoutMs: 5000 });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.timedOut, false);
});

test("execFileWithInput: stdout 超限截断并标记 truncated", async () => {
  const result = await execFileWithInput(
    process.execPath,
    ["-e", 'process.stdout.write("z".repeat(200000))'],
    { input: "", timeoutMs: 10000, maxOutputBytes: 1024 },
  );
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.truncated, true);
});

test("execFileWithInput 开 stdin 管道，execFileWithTimeout 仍是 ignore", async () => {
  let inputStdio = null;
  let plainStdio = null;
  const child1 = makeFakeChildWithStdin();
  const pending1 = execFileWithInput("ssh", [], {
    input: "x",
    timeoutMs: 5000,
    spawnImpl: (_command, _args, opts) => {
      inputStdio = opts.stdio;
      return child1;
    },
  });
  child1.emit("close", 0);
  await pending1;

  const child2 = makeFakeChild();
  const pending2 = execFileWithTimeout("ssh", [], {
    timeoutMs: 5000,
    spawnImpl: (_command, _args, opts) => {
      plainStdio = opts.stdio;
      return child2;
    },
  });
  child2.emit("close", 0);
  await pending2;

  assert.deepEqual(inputStdio, ["pipe", "pipe", "pipe"]);
  assert.deepEqual(plainStdio, ["ignore", "pipe", "pipe"]);
});
