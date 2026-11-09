import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readWindowsProcesses, windowsCommandArgs } from "./query.mjs";

test("Windows 原生 CIM 查询找到真实子进程，并正确解码中文与空格参数", { skip: process.platform !== "win32", timeout: 60000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "中文 路径参数"], { stdio: "ignore" });
  try {
    await once(child, "spawn");
    const row = (await readWindowsProcesses()).find((p) => p.pid === child.pid);
    assert(row);
    assert(row.command.includes("中文 路径参数"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("CIM 清单保留中文/空格命令行，PowerShell 失败或坏输出绝不能退化为空进程清单", async () => {
  const command = '"C:\\应用 程序\\Codex Operations Console.exe" work\\monitor\\channel-supervisor.mjs';
  const rows = await readWindowsProcesses(async (cmd, args) => {
    assert.equal(cmd, "powershell");
    assert.match(args.at(-1), /UTF8Encoding/);
    assert.match(args.at(-1), /Get-CimInstance Win32_Process/);
    return { code: 0, stdout: `\uFEFF${JSON.stringify([{ ProcessId: 42, ParentProcessId: 1, CommandLine: command }])}` };
  });
  assert.deepEqual(rows, [{ pid: 42, parentPid: 1, command }]);
  for (const result of [{ code: 1, stdout: "" }, { code: 0, stdout: "" }, { code: 0, stdout: "{}" }, { code: 0, stdout: "[]", truncated: true }]) {
    await assert.rejects(() => readWindowsProcesses(async () => result));
  }
  assert.deepEqual(await readWindowsProcesses(async () => ({ code: 0, stdout: "[]" })), []);
});

test("Windows argv 解析：带空格私钥、空参数、转义引号与结尾反斜杠", () => {
  assert.deepEqual(windowsCommandArgs('"C:\\Windows\\ssh.exe" -i "C:\\用户 名\\id key" "" host'), ["C:\\Windows\\ssh.exe", "-i", "C:\\用户 名\\id key", "", "host"]);
  assert.deepEqual(windowsCommandArgs('node "a\\\\" "a\\"b"'), ["node", "a\\", 'a"b']);
});
