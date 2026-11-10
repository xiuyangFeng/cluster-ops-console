import assert from "node:assert/strict";
import test from "node:test";
import { readWindowsProcesses } from "./query.mjs";
import { windowsSystemTool } from "./windows-query.mjs";

const row = { ProcessId: 123, CommandLine: "node owned.mjs" };
test("Windows 系统工具使用 SystemRoot；PATH 为空仍从绝对路径查询", async () => {
  const env = { SystemRoot: "D:\\Windows", PATH: "" };
  assert.equal(windowsSystemTool("powershell", env), "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const rows = await readWindowsProcesses(async (cmd, _args, options) => {
    assert.equal(cmd, windowsSystemTool("powershell", env));
    assert.equal(options.env.PATH, "");
    return { code: 0, stdout: JSON.stringify([row]) };
  }, { env });
  assert.equal(rows[0].pid, 123);
});
test("CIM 临时不可用可降级为 WMI 命令行查询", async () => {
  let calls = 0;
  const rows = await readWindowsProcesses(async (_cmd, args) => {
    calls++;
    return args.at(-1).includes("Get-CimInstance") ? { code: 1, stderr: "CIM unavailable" } : { code: 0, stdout: JSON.stringify([row]) };
  });
  assert.equal(calls, 2);
  assert.equal(rows[0].pid, 123);
});
test("缺少工具仅用 tasklist 记录存活能力；不返回虚假的空清单，5 分钟退避后恢复", async () => {
  let time = 0, calls = 0, restored = false;
  const exec = async (cmd) => {
    calls++;
    if (cmd.endsWith("tasklist.exe")) return { code: 0, stdout: '"node.exe","123","Console","1","5,000 K"' };
    return restored ? { code: 0, stdout: JSON.stringify([row]) } : { code: 1, stderr: "spawn ENOENT" };
  };
  const options = { now: () => time };
  await assert.rejects(readWindowsProcesses(exec, options), (e) => e.permanent && e.pidCount === 1 && e.nextRetryAt === 300000);
  for (time = 5000; time < 300000; time += 5000) await assert.rejects(readWindowsProcesses(exec, options));
  assert.equal(calls, 2);
  restored = true;
  assert.equal((await readWindowsProcesses(exec, options))[0].pid, 123);
});
test("瞬时故障连续失败指数退避，成功后清除；并发故障只执行一轮", async () => {
  let time = 0, calls = 0, restored = false;
  const exec = async () => { calls++; return restored ? { code: 0, stdout: "[]" } : { code: 1, stderr: "service busy" }; };
  const options = { now: () => time };
  await Promise.all([assert.rejects(readWindowsProcesses(exec, options)), assert.rejects(readWindowsProcesses(exec, options))]);
  assert.equal(calls, 3);
  time = 15000;
  await assert.rejects(readWindowsProcesses(exec, options), (e) => e.nextRetryAt === 45000);
  time = 45000; restored = true;
  assert.deepEqual(await readWindowsProcesses(exec, options), []);
});
test("原生 Windows PATH 为空仍找到当前 PID", { skip: process.platform !== "win32", timeout: 60000 }, async () => {
  const { execFileWithTimeout } = await import("../exec.mjs");
  const rows = await readWindowsProcesses(execFileWithTimeout, { env: { ...process.env, PATH: "" } });
  assert(rows.some((p) => p.pid === process.pid));
});

test("并发成功查询共用同一份命令行清单，所有调用者仍执行自己的解析", async () => {
  let calls = 0;
  const exec = async () => { calls++; return { code: 0, stdout: JSON.stringify([row]) }; };
  const results = await Promise.all([readWindowsProcesses(exec), readWindowsProcesses(exec)]);
  assert.equal(calls, 1);
  assert.equal(results[0][0].pid, 123);
  assert.equal(results[1][0].pid, 123);
});
