import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildBatchCmdlineQueries,
  cmdlineMatches,
  createProcessRegistry,
  createVerifyPrefetcher,
  ensurePidExited,
  parseCmdlineRows,
  queryCmdlines,
} from "./process-registry.mjs";

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// S7: process-registry win32 平台感知校验（D1）
// ---------------------------------------------------------------------------

test("S7: win32 平台下 verifyProcess 走 PowerShell Get-CimInstance 查询命令行", async () => {
  let captured = null;
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("pr-win32-"),
    platform: "win32",
    execFileImpl: async (cmd, args) => {
      captured = { cmd, args };
      return { stdout: "C:\\node.exe work\\monitor\\channel-supervisor.mjs\r\n" };
    },
  });
  registry.recordProcess("supervisor", 4242, {
    command: "node",
    args: ["work/monitor/channel-supervisor.mjs"],
    cwd: "C:\\app",
  });

  const result = await registry.verifyProcess("supervisor");
  assert.equal(captured.cmd, "powershell", "win32 应改走 PowerShell，而不是不存在的 ps");
  const joinedArgs = captured.args.join(" ");
  assert.match(joinedArgs, /Get-CimInstance/);
  assert.match(joinedArgs, /Win32_Process/);
  assert.match(joinedArgs, /CommandLine/);
  assert.match(joinedArgs, /4242/, "查询应按目标 pid 过滤");
  assert.equal(result.verified, true);
  assert.equal(result.indeterminate, false);
});

test("S7: win32 查询命令本身失败（execFile 抛异常）时 verifyProcess 返回 indeterminate=true，不判定为不存在", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("pr-win32-"),
    platform: "win32",
    execFileImpl: async () => {
      throw new Error("powershell.exe not found");
    },
  });
  registry.recordProcess("supervisor", 4242, { command: "node", args: ["x.mjs"], cwd: "C:\\app" });

  const result = await registry.verifyProcess("supervisor");
  assert.equal(result.verified, false);
  assert.equal(result.indeterminate, true, "查询失败应标记为'无法验证'而非'确认不存在'");
});

test("S7: win32 查询失败（indeterminate）时 stopProcess 保守拒绝杀进程", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("pr-win32-"),
    platform: "win32",
    execFileImpl: async () => {
      throw new Error("powershell.exe not found");
    },
  });
  registry.recordProcess("supervisor", 4242, { command: "node", args: ["x.mjs"], cwd: "C:\\app" });

  const result = await registry.stopProcess("supervisor");
  assert.equal(result.stopped, false, "无法验证时绝不能杀——D1 的'宁可漏报不可误杀'");
});

test("S7: win32 查询失败（indeterminate）时 listRuntimeProcesses 的 GC 保留记录，不 unlink", async () => {
  const dir = mkTmp("pr-win32-gc-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "win32",
    execFileImpl: async () => {
      throw new Error("powershell.exe not found");
    },
  });
  registry.recordProcess("supervisor", 4242, { command: "node", args: ["x.mjs"], cwd: "C:\\app" });

  const list = await registry.listRuntimeProcesses();
  assert.equal(
    existsSync(join(dir, "supervisor.pid.json")),
    true,
    "查询不可用（indeterminate）时不得把 pid.json GC 掉——这正是 D1 的核心：60s GC 会把 win32 下全部活进程记录误删",
  );
  const entry = list.find((e) => e.name === "supervisor");
  assert.ok(entry, "无法验证的记录仍应出现在列表中（标注 indeterminate），而不是被静默吞掉");
  assert.equal(entry.indeterminate, true);
});

test("S7: win32 查询成功但确认没有该 pid（空输出）时仍视为确认不存在，GC 正常删除", async () => {
  const dir = mkTmp("pr-win32-gc2-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "win32",
    execFileImpl: async () => ({ stdout: "" }), // CIM 查询正常跑完，但没有匹配的进程
  });
  registry.recordProcess("dead", 999999, { command: "node", args: ["dead.mjs"], cwd: "C:\\app" });

  const list = await registry.listRuntimeProcesses();
  assert.equal(list.length, 0);
  assert.equal(existsSync(join(dir, "dead.pid.json")), false, "确认不存在（非查询失败）时应正常 GC");
});

test("S7: 缺省 platform 回落 process.platform——POSIX 下查询失败即确认不存在", async () => {
  const registry = createProcessRegistry({
    runtimeDir: mkTmp("pr-posix-"),
    // 不传 platform：应回落到 process.platform
    execFileImpl: async () => {
      throw new Error("no such process");
    },
  });
  registry.recordProcess("dead", 1, { command: "node", args: ["x.mjs"], cwd: "/app" });
  const result = await registry.verifyProcess("dead");
  assert.equal(result.verified, false);
  // 回落到宿主平台：POSIX 下查询失败=确认进程不存在；win32 下按 D1 保守语义判 indeterminate。
  assert.equal(result.indeterminate, process.platform === "win32", "缺省必须回落到宿主平台的语义");
});

// ---------------------------------------------------------------------------
// S8: pid 复用精确签名校验（D2）
// ---------------------------------------------------------------------------

test("S8: cmdlineMatches 无 signature 时对旗标型短参（-o/-N）不再单独判定匹配", () => {
  const meta = {
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-N", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"],
  };
  // 无关命令行恰好含 "-o" 子串——旧逻辑会因 args 里的 "-o" 单独命中而误判 true。
  assert.equal(
    cmdlineMatches("grep -o foo bar.txt", meta),
    false,
    "旗标型短参不得单独作为匹配依据（pid 复用给 grep -o 之类无关进程时会误判 verified）",
  );
  // 真正的隧道命令行仍应通过（走 args 里的强特征，如转发串/host）。
  assert.equal(
    cmdlineMatches("ssh -o BatchMode=yes -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver", meta),
    true,
  );
});

test("S8: cmdlineMatches 有 signature 时要求精确 -R 转发串 + host 双条件同时命中", () => {
  const meta = {
    command: "ssh",
    args: ["-o", "BatchMode=yes", "-N", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"],
    signature: "-R 127.0.0.1:7891:127.0.0.1:8888 myserver",
  };
  assert.equal(
    cmdlineMatches("ssh -o BatchMode=yes -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver", meta),
    true,
  );
  // pid 复用：无关进程命令行恰好含 "-o" 子串，但没有精确转发串——不得误判。
  assert.equal(cmdlineMatches("grep -o 127.0.0.1:7891 access.log", meta), false);
  // 转发端口相同但 host 不同（例如复用给指向另一台服务器隧道的残留 pid）——不得误判。
  assert.equal(
    cmdlineMatches("ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 otherhost", meta),
    false,
    "转发串相同但 host 不同时不得判定匹配",
  );
});

test("S8: recordProcess 落 signature 字段；未显式传入时不自动派生（向后兼容旧调用方）", () => {
  const dir = mkTmp("pr-sig-");
  const registry = createProcessRegistry({ runtimeDir: dir });
  const meta = registry.recordProcess("tunnel", 555, {
    command: "ssh",
    args: ["-N", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"],
    cwd: "/app",
    signature: "-R 127.0.0.1:7891:127.0.0.1:8888 myserver",
  });
  assert.equal(meta.signature, "-R 127.0.0.1:7891:127.0.0.1:8888 myserver");
  assert.equal(registry.readMeta("tunnel").signature, "-R 127.0.0.1:7891:127.0.0.1:8888 myserver");

  const metaNoSig = registry.recordProcess("proxy", 666, { command: "node", args: ["x.mjs"], cwd: "/app" });
  assert.equal(
    "signature" in metaNoSig,
    false,
    "未显式传入 signature 时不应凭空派生一个——避免收紧既有调用方（未升级到 signature）的匹配语义",
  );
});

test("recordProcess: 唯一临时文件名 + 0600，不覆盖同名并发登记者的临时文件", { skip: process.platform === "win32" }, () => {
  const dir = mkTmp("pr-atomic-");
  const registry = createProcessRegistry({ runtimeDir: dir });
  // 模拟另一个进程正在写同名记录的临时文件（旧实现固定用 <name>.pid.json.tmp）。
  const foreignTmp = join(dir, "tunnel.pid.json.tmp");
  writeFileSync(foreignTmp, "in-flight");
  registry.recordProcess("tunnel", 777, { command: "ssh", args: ["-N"], cwd: "/app" });
  assert.equal(readFileSync(foreignTmp, "utf8"), "in-flight", "别人的临时文件原样保留");
  assert.equal(registry.readMeta("tunnel").pid, 777);
  assert.equal(statSync(join(dir, "tunnel.pid.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ["tunnel.pid.json", "tunnel.pid.json.tmp"], "自己的临时文件不残留");
});

// ---------------------------------------------------------------------------
// 死进程 pid.json 回收可观测性（2026-07-02 v2 终审 ship-as-is 跟进）：
// listRuntimeProcesses 的 GC unlink 此前是静默的——生产上无法回答"这个 pid.json
// 是谁、什么时候、为什么删掉的"。onReclaim 回调让调用方（monitor-server 的
// maintenanceSweep）能记一条日志。校验逻辑完全复用 verifyProcess，不新增判定分支。
// ---------------------------------------------------------------------------

test("GC回收: 进程已死的 pid.json 被删除并触发 onReclaim（带 name/pid/reason）", async () => {
  const dir = mkTmp("pr-gc-cb-");
  const reclaimed = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    // ps 抛异常 = POSIX 语义下进程确认不存在
    execFileImpl: async () => { throw new Error("no such process"); },
    onReclaim: (info) => reclaimed.push(info),
  });
  registry.recordProcess("dead-proc", 999999, { command: "node", args: ["dead.mjs"], cwd: "/app" });

  await registry.listRuntimeProcesses();
  assert.equal(existsSync(join(dir, "dead-proc.pid.json")), false, "死进程记录应被回收");
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].name, "dead-proc");
  assert.equal(reclaimed[0].pid, 999999);
  assert.ok(reclaimed[0].reason, "回收原因必须透传，供日志排查");
});

test("GC回收: pid 存活但命令行不匹配（pid 复用）同样回收并回调", async () => {
  const dir = mkTmp("pr-gc-reuse-");
  const reclaimed = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    // ps 查询成功，但 pid 已被复用为无关进程——复用现有 verifier 的"命令行不匹配"判死。
    execFileImpl: async () => ({ stdout: " 4242 some-unrelated-binary --flag\n" }),
    onReclaim: (info) => reclaimed.push(info),
  });
  registry.recordProcess("reused", 4242, { command: "node work/x.mjs", args: ["work/x.mjs"], cwd: "/app" });

  await registry.listRuntimeProcesses();
  assert.equal(existsSync(join(dir, "reused.pid.json")), false);
  assert.equal(reclaimed.length, 1);
  assert.match(reclaimed[0].reason, /命令行不匹配/);
});

test("GC回收: 活进程（校验通过）绝不触发 onReclaim，记录保留", async () => {
  const dir = mkTmp("pr-gc-alive-");
  const reclaimed = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    execFileImpl: async () => ({ stdout: " 1234 node work/x.mjs\n" }),
    onReclaim: (info) => reclaimed.push(info),
  });
  registry.recordProcess("alive", 1234, { command: "node work/x.mjs", args: ["work/x.mjs"], cwd: "/app" });

  const list = await registry.listRuntimeProcesses();
  assert.equal(list.length, 1);
  assert.equal(existsSync(join(dir, "alive.pid.json")), true);
  assert.equal(reclaimed.length, 0, "活进程绝不能被回收回调误报");
});

test("GC回收: indeterminate（win32 查询失败）不回收也不回调——沿用 D1 保守语义", async () => {
  const dir = mkTmp("pr-gc-indet-");
  const reclaimed = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "win32",
    execFileImpl: async () => { throw new Error("powershell not found"); },
    onReclaim: (info) => reclaimed.push(info),
  });
  registry.recordProcess("maybe", 4242, { command: "node", args: ["x.mjs"], cwd: "C:\\app" });

  await registry.listRuntimeProcesses();
  assert.equal(existsSync(join(dir, "maybe.pid.json")), true);
  assert.equal(reclaimed.length, 0);
});

test("GC回收: onReclaim 回调抛异常不中断 listRuntimeProcesses（GC 不能被日志回调拖垮）", async () => {
  const dir = mkTmp("pr-gc-throw-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async () => { throw new Error("no such process"); },
    onReclaim: () => { throw new Error("logger exploded"); },
  });
  registry.recordProcess("dead-a", 999998, { command: "node", args: ["a.mjs"], cwd: "/app" });
  registry.recordProcess("dead-b", 999999, { command: "node", args: ["b.mjs"], cwd: "/app" });

  const list = await registry.listRuntimeProcesses();
  assert.deepEqual(list, []);
  assert.equal(existsSync(join(dir, "dead-a.pid.json")), false, "回调抛异常不影响回收本身");
  assert.equal(existsSync(join(dir, "dead-b.pid.json")), false, "后续条目的回收也不受影响");
});

test("GC回收: 未传 onReclaim 时行为与旧版完全一致（向后兼容）", async () => {
  const dir = mkTmp("pr-gc-nocb-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async () => { throw new Error("no such process"); },
  });
  registry.recordProcess("dead", 999999, { command: "node", args: ["x.mjs"], cwd: "/app" });
  const list = await registry.listRuntimeProcesses();
  assert.deepEqual(list, []);
  assert.equal(existsSync(join(dir, "dead.pid.json")), false);
});

test("S8: verifyProcess 端到端——隧道用精确签名，pid 复用给含 '-o' 的无关进程判 verified=false", async () => {
  const dir = mkTmp("pr-sig-e2e-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    execFileImpl: async () => ({ stdout: " 777 grep -o 127.0.0.1:7891 access.log\n" }), // pid 复用为无关 grep 进程
  });
  registry.recordProcess("tunnel", 777, {
    command: "ssh",
    args: ["-N", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"],
    cwd: "/app",
    signature: "-R 127.0.0.1:7891:127.0.0.1:8888 myserver",
  });

  const result = await registry.verifyProcess("tunnel");
  assert.equal(result.verified, false, "pid 复用给无关 grep -o 进程时，精确签名应拒绝误判为 verified");
});

// 以下两例的 execFileImpl 返回 POSIX `ps -o command= -p <pid>` 的输出形状，因此显式注入
// platform——win32 走的是 PowerShell 查询与另一套解析（另有专门用例覆盖）。
test("config identity persists and requires the complete SSH command rather than matching -R alone", async () => {
  const command = "ssh -p 22 -l user-one -i /tmp/key -N -R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid";
  const registry = createProcessRegistry({ runtimeDir: mkTmp("registry-identity-"), platform: "linux", execFileImpl: async () => ({ stdout: `123 ${command}` }) });
  registry.recordProcess("tunnel.fixture", 123, { command, signature: "-R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid", configIdentity: "identity-one", adopted: true });
  const meta = registry.readMeta("tunnel.fixture");
  assert.equal(meta.configIdentity, "identity-one");
  assert.equal(meta.adopted, true);
  assert.equal((await registry.verifyProcess("tunnel.fixture")).verified, true);
  assert.equal(cmdlineMatches(command.replace("user-one", "user-two"), meta), false);
  assert.equal(cmdlineMatches(`echo ${command}`, meta), false);
  assert.equal(cmdlineMatches(command.replace(/^ssh/, "/usr/bin/ssh"), meta), true);
});

test("scoped registry stop rejects changed PID or identity without sending signals", async () => {
  const signals = [];
  const command = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid";
  const registry = createProcessRegistry({ runtimeDir: mkTmp("registry-stop-identity-"), platform: "linux",
    execFileImpl: async () => ({ stdout: `123 ${command}` }), killProcess: (...args) => signals.push(args), waitForPidExitImpl: async () => true });
  registry.recordProcess("tunnel.fixture", 123, { command, configIdentity: "identity-new" });
  assert.equal((await registry.stopProcess("tunnel.fixture", { expectedPid: 122, expectedConfigIdentity: "identity-new" })).stopped, false);
  assert.equal((await registry.stopProcess("tunnel.fixture", { expectedPid: 123, expectedConfigIdentity: "identity-old" })).stopped, false);
  assert.deepEqual(signals, []);
  assert.equal((await registry.stopProcess("tunnel.fixture", { expectedPid: 123, expectedConfigIdentity: "identity-new" })).stopped, true);
  assert.deepEqual(signals, [[123, "SIGTERM"]]);
});

test("scoped registry stop rechecks registry changed while command-line verification awaited", async () => {
  const command = "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid";
  const signals = [];
  let registry;
  registry = createProcessRegistry({ runtimeDir: mkTmp("registry-stop-race-"),
    execFileImpl: async () => {
      registry.recordProcess("tunnel.fixture", 124, { command, configIdentity: "identity-new" });
      return { stdout: `123 ${command}` };
    }, killProcess: (...args) => signals.push(args), waitForPidExitImpl: async () => true });
  registry.recordProcess("tunnel.fixture", 123, { command, configIdentity: "identity-old" });
  const result = await registry.stopProcess("tunnel.fixture", { expectedPid: 123, expectedConfigIdentity: "identity-old" });
  assert.equal(result.stopped, false);
  assert.deepEqual(signals, []);
  assert.equal(registry.readMeta("tunnel.fixture").pid, 124);
});

// ---------------------------------------------------------------------------
// 批量校验（性能优化）：supervisor 每拍 N 条隧道合并为一轮查询
// ---------------------------------------------------------------------------

test("buildBatchCmdlineQueries: linux 一条逗号列表；darwin 拆成单 pid（多 pid 会全表扫描）；win32 为空", () => {
  assert.deepEqual(buildBatchCmdlineQueries("linux", [11, 12, 11, "x", -1]).map((q) => q.args), [["-o", "pid=,command=", "-p", "11,12"]]);
  assert.deepEqual(buildBatchCmdlineQueries("darwin", [11, 12]).map((q) => q.args), [
    ["-o", "pid=,command=", "-p", "11"],
    ["-o", "pid=,command=", "-p", "12"],
  ]);
  assert.deepEqual(buildBatchCmdlineQueries("win32", [11]), []);
  assert.deepEqual(buildBatchCmdlineQueries("linux", []), []);
});

test("parseCmdlineRows: 按 pid 列归属，忽略空行", () => {
  const rows = parseCmdlineRows("   11 node work/a.mjs\n\n  12 ssh -N -R x host  \n");
  assert.equal(rows.get(11), "node work/a.mjs");
  assert.equal(rows.get(12), "ssh -N -R x host");
  assert.equal(rows.size, 2);
});

test("queryCmdlines: linux 批量命令失败时对缺席 pid 逐个单查兜底，不连坐", async () => {
  const calls = [];
  const found = await queryCmdlines("linux", [11, 12], async (_command, args) => {
    calls.push(args.at(-1));
    if (args.at(-1) === "11,12") return { stdout: "", failed: true };
    if (args.at(-1) === "11") return { stdout: " 11 node a.mjs\n", failed: false };
    return { stdout: "", failed: true };
  });
  assert.deepEqual(calls, ["11,12", "11", "12"]);
  assert.equal(found.get(11), "node a.mjs");
  assert.equal(found.has(12), false);
});

test("verifyProcesses: linux 下多条记录只 fork 一次 ps，逐条判定与 verifyProcess 同语义", async () => {
  const dir = mkTmp("pr-batch-");
  const calls = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { stdout: " 101 node work/a.mjs\n 102 some-unrelated --flag\n" };
    },
  });
  registry.recordProcess("a", 101, { command: "node work/a.mjs", args: ["work/a.mjs"], cwd: "/app" });
  registry.recordProcess("b", 102, { command: "node work/b.mjs", args: ["work/b.mjs"], cwd: "/app" });
  registry.recordProcess("c", 103, { command: "node work/c.mjs", args: ["work/c.mjs"], cwd: "/app" });

  const results = await registry.verifyProcesses(["a", "b", "c", "missing"]);
  assert.equal(calls.length, 1, "三条记录只允许一次 ps");
  assert.deepEqual(calls[0], ["ps", "-o", "pid=,command=", "-p", "101,102,103"]);
  assert.equal(results.get("a").verified, true);
  assert.equal(results.get("b").verified, false);
  assert.match(results.get("b").reason, /命令行不匹配/);
  assert.equal(results.get("c").verified, false);
  assert.match(results.get("c").reason, /不存在/);
  assert.equal(results.get("missing").meta, null);
  assert.equal(results.get("missing").reason, "缺少 pid 元数据");
});

test("verifyProcesses: ps 以非零退出但 stdout 里有已找到的行（promisify reject 形态）时仍采信这些行", async () => {
  const dir = mkTmp("pr-batch-reject-");
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async (_cmd, args) => {
      if (args.at(-1) === "201,202") throw Object.assign(new Error("exit 1"), { stdout: " 201 node work/a.mjs\n" });
      throw Object.assign(new Error("exit 1"), { stdout: "" });
    },
  });
  registry.recordProcess("a", 201, { command: "node work/a.mjs", args: ["work/a.mjs"], cwd: "/app" });
  registry.recordProcess("b", 202, { command: "node work/b.mjs", args: ["work/b.mjs"], cwd: "/app" });
  const results = await registry.verifyProcesses(["a", "b"]);
  assert.equal(results.get("a").verified, true);
  assert.equal(results.get("b").verified, false);
  assert.equal(results.get("b").indeterminate, false, "POSIX 查询失败沿用'确认不存在'语义");
});

test("verifyProcesses: win32 回落逐条 verifyProcess（PowerShell 与 indeterminate 语义不变）", async () => {
  const dir = mkTmp("pr-batch-win-");
  const calls = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "win32",
    execFileImpl: async (cmd) => { calls.push(cmd); throw new Error("powershell missing"); },
  });
  registry.recordProcess("a", 301, { command: "node", args: ["a.mjs"], cwd: "C:\\app" });
  const results = await registry.verifyProcesses(["a"]);
  assert.deepEqual(calls, ["powershell"]);
  assert.equal(results.get("a").indeterminate, true);
});

test("createVerifyPrefetcher: 预取结果一次性消费；元数据变化或过期时透传实时校验", async () => {
  const dir = mkTmp("pr-prefetch-");
  let batchCalls = 0;
  let singleCalls = 0;
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async (_cmd, args) => {
      if (args.at(-1).includes(",")) batchCalls += 1;
      else singleCalls += 1;
      return { stdout: " 401 ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver\n 402 ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 other\n" };
    },
  });
  registry.recordProcess("tunnel.a", 401, { command: "ssh", args: [], cwd: "/app", signature: "-R 127.0.0.1:7891:127.0.0.1:8888 myserver" });
  registry.recordProcess("tunnel.b", 402, { command: "ssh", args: [], cwd: "/app", signature: "-R 127.0.0.1:7893:127.0.0.1:8888 other" });
  let clock = 1000;
  const prefetcher = createVerifyPrefetcher(registry, { now: () => clock, maxAgeMs: 5000 });
  await prefetcher.prefetch(["tunnel.a", "tunnel.b"]);
  assert.equal(batchCalls, 1);

  const first = await prefetcher.registry.verifyProcess("tunnel.a");
  assert.equal(first.verified, true);
  assert.equal(singleCalls, 0, "首次校验命中预取，不再 fork ps");

  // 二次复核（A6：远端探测之后）必须是实时查询。
  await prefetcher.registry.verifyProcess("tunnel.a");
  assert.equal(singleCalls, 1);

  // 预取后 pid.json 被受控重启改写：预取结果作废，走实时查询。
  registry.recordProcess("tunnel.b", 402, { command: "ssh", args: ["changed"], cwd: "/app", signature: "-R 127.0.0.1:7893:127.0.0.1:8888 other" });
  await prefetcher.registry.verifyProcess("tunnel.b");
  assert.equal(singleCalls, 2);

  // 过期同样透传。
  await prefetcher.prefetch(["tunnel.a"]); // 单 pid：本身就是一次单查
  assert.equal(singleCalls, 3);
  clock += 6000;
  await prefetcher.registry.verifyProcess("tunnel.a");
  assert.equal(singleCalls, 4);
  // 其余方法原样透出。
  assert.equal(typeof prefetcher.registry.stopProcess, "function");
  assert.equal(prefetcher.registry.readMeta("tunnel.a").pid, 401);
});

test("ps 查询带 UTF-8 区域 env（verifyProcess / verifyProcesses），win32 不带", async () => {
  const { utf8LocaleEnv } = await import("./process-registry.mjs");
  assert.equal(utf8LocaleEnv("darwin", { A: "1" }).LC_ALL, "en_US.UTF-8");
  assert.equal(utf8LocaleEnv("linux", { A: "1" }).LC_ALL, "C.UTF-8");
  assert.equal(utf8LocaleEnv("darwin", { A: "1" }).A, "1");
  assert.equal(utf8LocaleEnv("win32", { A: "1" }).LC_ALL, undefined);

  const runtimeDir = mkTmp("registry-locale-");
  const execPath = "/Users/x/集群codex连接/dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";
  const calls = [];
  // 假 ps：带 UTF-8 区域时原样输出中文，否则按 C 区域转义成 M-...
  const fakePs = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const utf8 = /UTF-8$/.test(options?.env?.LC_ALL || "");
    const line = utf8 ? execPath : execPath.replace(/[^ -~]/gu, "M-?");
    return { stdout: `${args[args.length - 1]} ${line}\n` };
  };
  const registry = createProcessRegistry({ runtimeDir, execFileImpl: fakePs, platform: "darwin" });
  registry.recordProcess("desktop-main", 4242, { command: execPath, args: [], cwd: "/r" });
  const one = await registry.verifyProcess("desktop-main");
  assert.equal(one.verified, true, one.reason);
  const many = await registry.verifyProcesses(["desktop-main"]);
  assert.equal(many.get("desktop-main").verified, true);
  assert.ok(calls.length >= 2);
  for (const call of calls) assert.equal(call.options.env.LC_ALL, "en_US.UTF-8");
  // GC 不会删掉它
  const listed = await registry.listRuntimeProcesses();
  assert.equal(listed.find((r) => r.name === "desktop-main")?.verified, true);

  const winCalls = [];
  const winRegistry = createProcessRegistry({
    runtimeDir: mkTmp("registry-locale-win-"),
    platform: "win32",
    execFileImpl: async (_cmd, _args, options) => {
      winCalls.push(options);
      return { stdout: execPath };
    },
  });
  winRegistry.recordProcess("desktop-main", 4242, { command: execPath, args: [] });
  assert.equal((await winRegistry.verifyProcess("desktop-main")).verified, true);
  assert.equal(winCalls[0]?.env, undefined);
});

test("M- 转义输出下：带 ASCII signature 的记录仍校验通过，没有签名的记录失败", async () => {
  const runtimeDir = mkTmp("registry-escaped-");
  const escaped = "/Users/x/M-iM-^[M-^FM-gM->M-$codex/dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";
  const registry = createProcessRegistry({ runtimeDir, platform: "darwin", execFileImpl: async (_cmd, args) => ({ stdout: `${args[args.length - 1]} ${escaped}\n` }) });
  const execPath = "/Users/x/集群codex/dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console";
  registry.recordProcess("with-sig", 11, { command: execPath, args: [], signature: "dist/Codex Operations Console.app/Contents/MacOS/Codex Operations Console" });
  registry.recordProcess("no-sig", 12, { command: execPath, args: [] });
  assert.equal((await registry.verifyProcess("with-sig")).verified, true);
  assert.equal((await registry.verifyProcess("no-sig")).verified, false);
});

// ---------------------------------------------------------------------------
// ensurePidExited：SIGTERM 无果时升级 SIGKILL
// 隧道/代理重建必须在 spawn 新进程前确认旧进程真的让出了端口。只用 SIGTERM + 等 2 秒
// 是不够的（ssh 卡在半开的 -R 建立、代理卡在不可中断 syscall 时都不响应 SIGTERM），
// 旧进程占着端口会让新进程报 remote port forwarding failed / EADDRINUSE。
// ---------------------------------------------------------------------------

test("ensurePidExited: 预算内已退出则不补发信号", async () => {
  const signals = [];
  const exited = await ensurePidExited(1001, 50, {
    waitImpl: async () => true,
    killImpl: (pid, signal) => signals.push([pid, signal]),
  });
  assert.equal(exited, true);
  assert.deepEqual(signals, [], "已经退出就绝不能补一记 SIGKILL");
});

test("ensurePidExited: 预算耗尽后升级 SIGKILL，并用宽限预算复查", async () => {
  const signals = [];
  const waits = [];
  const exited = await ensurePidExited(1002, 2000, {
    killImpl: (pid, signal) => signals.push([pid, signal]),
    waitImpl: async (pid, budgetMs) => {
      waits.push([pid, budgetMs]);
      return false;
    },
    killGraceMs: 500,
  });
  assert.deepEqual(signals, [[1002, "SIGKILL"]], "调用方已发 SIGTERM，本函数只负责升级");
  assert.deepEqual(waits, [[1002, 2000], [1002, 500]], "升级后要复查，而不是假定成功");
  assert.equal(exited, false, "复查仍未退出就如实返回 false");
});

test("ensurePidExited: 升级后确认退出才返回 true", async () => {
  const signals = [];
  let call = 0;
  const exited = await ensurePidExited(1003, 10, {
    killImpl: (pid, signal) => signals.push([pid, signal]),
    waitImpl: async () => {
      call += 1;
      return call > 1; // 第一次未退出 → 升级 SIGKILL → 第二次退出
    },
  });
  assert.equal(exited, true);
  assert.deepEqual(signals, [[1003, "SIGKILL"]]);
});

test("ensurePidExited: kill 抛错（ESRCH/EPERM）不得外抛，交给复查判定", async () => {
  const exited = await ensurePidExited(1004, 10, {
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
    waitImpl: async () => false,
  });
  assert.equal(exited, false);
});

test("ensurePidExited: 无 pid 视为已退出，且不做任何等待或信号", async () => {
  let waited = false;
  const options = {
    waitImpl: async () => {
      waited = true;
      return false;
    },
    killImpl: () => assert.fail("无 pid 时不得发信号"),
  };
  assert.equal(await ensurePidExited(0, 10, options), true);
  assert.equal(await ensurePidExited(null, 10, options), true);
  assert.equal(await ensurePidExited(undefined, 10, options), true);
  assert.equal(waited, false);
});
