import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { ensureWindowsOpenSshOnPath } from "./platform.mjs";

// 统一的 execFile 封装：channel-supervisor 与 probes 共用（此前两份私有实现，
// probes 那份缺 child.on("error")——ssh/ps ENOENT 时只触发 error 不触发 close，
// Promise 永不结算、定时器泄漏、20s 后还对已死 child 调 kill）。
//
// 语义：
// - 永不 reject：spawn 同步抛出与 'error' 事件（ENOENT/EACCES 等）都结算为
//   { code: 1, stderr: <错误信息> }，调用方永远拿得到结果。
// - 超时先 SIGTERM，宽限 KILL_GRACE_MS 后补 SIGKILL；timedOut 由 timer 显式标记。
// - stdout/stderr 各自有累积字节上限（默认 1MB）：超限部分丢弃（仍消费流避免
//   背压卡死子进程），结果标记 truncated: true。
// - 所有定时器在结算时清理，不留悬挂 timer。
// - execFileWithInput 走同一套核心，只多一条 stdin 管道（零残留采集脚本经此送达远端）。
export const DEFAULT_EXEC_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const KILL_GRACE_MS = 2000;

function runChild(command, args, {
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  spawnImpl = spawn,
  cwd,
  env,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  input = null,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false; // 由 timer 显式标记，不从 code/signal 反推。
    let truncated = false;
    let child;
    const spawnOptions = { cwd, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] };
    if (env) spawnOptions.env = env;
    // Windows 上运行中刚装好 OpenSSH 客户端：本进程（与传进来的 env）补上它的目录，不必重启（见 platform.mjs）。
    ensureWindowsOpenSshOnPath(command);
    if (env) ensureWindowsOpenSshOnPath(command, { env });
    try {
      child = spawnImpl(command, args, spawnOptions);
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: String((err?.message) || err), timedOut: false, truncated: false });
      return;
    }

    // 每条流独立累积与限额；超限后仍继续消费 data 事件（只丢弃内容），
    // 避免停止读取导致管道背压把子进程卡死在 write 上。
    //
    // 必须经 StringDecoder 解码，不能 buf.toString()：data 事件的 Buffer 按 64KB 边界
    // 任意切片，拼接点落在多字节字符（中文本项目大量使用）中间时 toString 各算各的，
    // 会产生 U+FFFD。exec 是所有 SSH 探针/远端采集输出的唯一通路，损坏的文本会污染
    // reclaude 日志行、activeSignals 关键字匹配与 parseAgentsInstalled 等解析，
    // 且不抛错、静默降级。StringDecoder 会把不完整的多字节序列留到下一块再拼。
    function makeCollector() {
      const state = { text: "", bytes: 0 };
      const decoder = new StringDecoder("utf8");
      state.push = (chunk) => {
        const remaining = maxOutputBytes - state.bytes;
        if (remaining <= 0) {
          truncated = true;
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        if (buf.length > remaining) {
          state.text += decoder.write(buf.subarray(0, remaining));
          // 截断点可能落在字符中间，end() 把残留字节显式解码（结果为替换符而非污染前文）。
          state.text += decoder.end();
          state.bytes = maxOutputBytes;
          truncated = true;
        } else {
          state.text += decoder.write(buf);
          state.bytes += buf.length;
        }
      };
      return state;
    }
    const stdout = makeCollector();
    const stderr = makeCollector();

    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => stdout.push(chunk));
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => stderr.push(chunk));
    }
    child.on("error", (err) => {
      finish({ code: 1, stdout: stdout.text, stderr: stderr.text || String((err?.message) || err), timedOut, truncated });
    });
    child.on("close", (code) => {
      finish({ code: code ?? 1, stdout: stdout.text, stderr: stderr.text, timedOut, truncated });
    });

    // stdin 脚本模式：先挂 error 监听再写。远端 sh 提前退出会让写入以 EPIPE 失败，
    // 那是正常收尾（结果由 close 事件结算），绝不能变成 unhandled 'error' 把进程带崩。
    if (input !== null) {
      const stdin = child.stdin;
      if (stdin && typeof stdin.on === "function") stdin.on("error", () => {});
      try {
        if (stdin && typeof stdin.write === "function") stdin.write(input);
        if (stdin && typeof stdin.end === "function") stdin.end();
      } catch {}
    }
  });
}

export function execFileWithTimeout(command, args, options = {}) {
  return runChild(command, args, { ...options, input: null });
}

// stdin 脚本执行：`ssh host "env ... sh -s"` 把 collect.sh 正文经 stdin 送到远端，
// 远端零残留。返回形状与 execFileWithTimeout 完全一致（永不 reject）。
export function execFileWithInput(command, args, { input = "", ...options } = {}) {
  return runChild(command, args, { ...options, input: String(input == null ? "" : input) });
}
