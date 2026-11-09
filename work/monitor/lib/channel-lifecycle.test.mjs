import assert from "node:assert/strict";
import test from "node:test";

import { createChannelLifecycle, matchesManagedProcess } from "./channel-lifecycle.mjs";

// 拆分动机：这些状态机此前封在 monitor-server.mjs 的 if(isMain) 块内，完全不可单测。
// 这里全部经依赖注入 mock 驱动：不 spawn 真进程、不碰文件系统、不依赖墙钟。

const FIXED_NOW = 1_700_000_000_000;

test("spawnSupervisor: 在册存活进程直接复用；无法验证时拒绝再 spawn 或覆写登记", async () => {
  const h = createHarness();
  h.deps.registry.verifyProcess = async () => ({ verified: true, meta: { pid: 41376 } });
  assert.deepEqual(await h.create().spawnSupervisor(), { pid: 41376, reused: true });
  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.recordCalls.length, 0);
  h.deps.registry.verifyProcess = async () => ({ verified: false, indeterminate: true, meta: { pid: 41376 } });
  await assert.rejects(() => h.create().spawnSupervisor(), /无法校验/);
  assert.equal(h.spawnCalls.length, 0);
});

test("spawnSupervisor: 恢复登记丢失的存活进程；并发调用只起一个子进程且父进程不登记", async () => {
  const h = createHarness();
  h.deps.toolkit.getProcesses = async () => ({ supervisor: [{ pid: "42856", command: "node work/monitor/channel-supervisor.mjs" }] });
  const adopted = await h.create().spawnSupervisor();
  assert.deepEqual(adopted, { pid: 42856, reused: true });
  assert.equal(h.recordCalls[0].pid, 42856);
  assert.equal(h.spawnCalls.length, 0);
  h.deps.toolkit.getProcesses = async () => ({ supervisor: [] });
  const lifecycle = h.create();
  const results = await Promise.all(Array.from({ length: 4 }, () => lifecycle.spawnSupervisor()));
  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.recordCalls.length, 1, "唯一记录来自收养；未提前登记新 PID");
  assert(results.every((r) => r.pid === 4242));
});

test("Windows 热交接：退场同一安装目录的所有旧 supervisor，保留 SSH、代理和其它安装的进程", async () => {
  const table = new Map([
    [41376, '"C:\\Console\\Codex Operations Console.exe" work/monitor/channel-supervisor.mjs'],
    [42856, '"C:\\Console\\Codex Operations Console.exe" work\\monitor\\channel-supervisor.mjs'],
    [43000, '"C:\\Console\\Codex Operations Console.exe" work/local_http_connect_proxy.mjs'],
    [44000, '"C:\\Other\\Codex Operations Console.exe" work/monitor/channel-supervisor.mjs'],
    [45000, 'ssh.exe -N -R 127.0.0.1:7895:127.0.0.1:8888 cluster.example'],
  ]);
  const killed = [];
  const h = createHarness({ platform: "win32", rootDir: 'C:\\Console\\resources\\app',
    ensurePidExitedImpl: async () => true,
    killImpl: (pid) => { killed.push(pid); table.delete(pid); },
  });
  h.deps.registry.readMeta = () => ({ pid: 41376 });
  h.deps.registry.stopProcess = async () => { killed.push(41376); table.delete(41376); return { stopped: true }; };
  h.deps.toolkit.execFile = async (cmd) => {
    assert.equal(cmd, "powershell");
    return { code: 0, stdout: JSON.stringify([...table].map(([ProcessId, CommandLine]) => ({ ProcessId, CommandLine }))) };
  };
  await h.create().spawnSupervisor({ replaceExisting: true });
  assert.deepEqual(killed, [41376, 42856]);
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual([...table.keys()], [43000, 44000, 45000]);
});

function createHarness(overrides = {}) {
  const logs = [];
  const spawnCalls = [];
  const recordCalls = [];
  const stopOrder = [];
  const killCalls = [];
  const execCalls = [];
  const timers = [];
  let getProcessesCalls = 0;

  const deps = {
    rootDir: "/repo",
    paths: {
      dataRoot: "/data",
      runtimeDir: "/data/runtime",
      configPath: "/repo/config.json",
      localConfigPath: "/data/config.local.json",
    },
    fixtureMode: false,
    appendLog: (message, fields) => logs.push({ message, fields }),
    registry: {
      readMeta: () => null,
      stopProcess: async (name) => {
        stopOrder.push(name);
        return { stopped: true, reason: "SIGTERM delivered" };
      },
      verifyProcess: async () => ({ verified: false }),
      recordProcess: (name, pid, meta) => recordCalls.push({ name, pid, meta }),
      listRuntimeProcesses: async () => [],
    },
    scheduler: {
      getResult: () => undefined,
      forceRun: async () => ({}),
    },
    toolkit: {
      getProcesses: async () => {
        getProcessesCalls += 1;
        return { supervisor: [], localProxy: [], tunnel: [] };
      },
      getMainServerConfig: () => undefined,
      execFile: async (cmd, args) => {
        execCalls.push({ cmd, args });
        return { stdout: "" };
      },
    },
    store: { setShouldBeRunning: () => {} },
    getConfig: async () => ({ servers: [] }),
    refreshConfigIntoKernel: async () => ({}),
    spawnImpl: (execPath, args, options) => {
      spawnCalls.push({ execPath, args, options });
      return { pid: 4242, unref() {} };
    },
    mkdirImpl: async () => {},
    statImpl: async () => {
      throw new Error("ENOENT");
    },
    setTimeoutImpl: (fn, delay) => {
      timers.push({ fn, delay });
    },
    killImpl: (pid, signal) => killCalls.push({ pid, signal }),
    selfPid: 999,
    env: {},
    platform: "darwin",
    now: () => FIXED_NOW,
    ...overrides,
  };

  return {
    deps,
    logs,
    spawnCalls,
    recordCalls,
    stopOrder,
    killCalls,
    execCalls,
    timers,
    getProcessesCalls: () => getProcessesCalls,
    create: () => createChannelLifecycle(deps),
  };
}

// ---- matchesManagedProcess（原 monitor-server.mjs 顶层纯函数，随生命周期模块迁移）----

test("matchesManagedProcess: 迁移后判据不变（supervisor/localProxy/tunnel）", () => {
  assert.equal(matchesManagedProcess("node work/monitor/channel-supervisor.mjs", { role: "supervisor" }), true);
  assert.equal(matchesManagedProcess("node work/local_http_connect_proxy.mjs", { role: "localProxy" }), true);
  assert.equal(
    matchesManagedProcess("ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver", {
      role: "tunnel",
      config: { remotePort: 7891, localPort: 8888, host: "myserver" },
    }),
    true,
  );
  assert.equal(matchesManagedProcess("bash -c ls", { role: "supervisor" }), false);
});

// ---- autoRepairChannel ----

test("autoRepairChannel: supervisor 已存活（processes 探针缓存新鲜）→ 不 spawn、不扫描、不碰注册表", async () => {
  const h = createHarness({
    scheduler: {
      getResult: (id) =>
        id === "processes"
          ? { checkedAt: FIXED_NOW, data: { processes: { supervisor: [{ pid: 11 }], localProxy: [], tunnel: [] } } }
          : undefined,
      forceRun: async () => ({}),
    },
  });
  const lifecycle = h.create();

  await lifecycle.autoRepairChannel();

  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.recordCalls.length, 0);
  // 缓存新鲜时守护巡检直接复用，不应再触发一次全量 ps 扫描。
  assert.equal(h.getProcessesCalls(), 0);
});

test("autoRepairChannel: force 且 supervisor 已存活 → 跳过重复 spawn、不覆写注册表（D1 语义）", async () => {
  const h = createHarness();
  h.deps.toolkit.getProcesses = async () => ({ supervisor: [{ pid: 22 }], localProxy: [], tunnel: [] });
  const lifecycle = h.create();
  // force 路径必须无视 shouldBeRunning=false 的停止意图（/api/start 就是要显式拉起）。
  lifecycle.setShouldBeRunning(false);

  await lifecycle.autoRepairChannel({ force: true });

  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.recordCalls.length, 0);
  assert.ok(h.logs.some((l) => l.message.includes("channel supervisor already running, skipping duplicate spawn")));
});

test("autoRepairChannel: supervisor 未存活 → 正常拉起，登记由取得所有权的子进程完成", async () => {
  const h = createHarness();
  const lifecycle = h.create();

  await lifecycle.autoRepairChannel();

  // 缓存缺失（getResult undefined）时回落到真实扫描。
  assert.equal(h.getProcessesCalls(), 2);
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual(h.spawnCalls[0].args, ["work/monitor/channel-supervisor.mjs"]);
  assert.equal(h.spawnCalls[0].options.cwd, "/repo");
  assert.equal(h.spawnCalls[0].options.detached, true);
  assert.equal(h.spawnCalls[0].options.stdio, "ignore");
  assert.equal(h.spawnCalls[0].options.env.CODEX_MONITOR_APP_ROOT, "/repo");
  assert.equal(h.recordCalls.length, 0, "父进程不得覆写 PID 注册表");
  assert.ok(h.logs.some((l) => l.message === "auto starting channel supervisor"));
});

test("autoRepairChannel: 上次尝试失败后处于退避窗口内 → 不重复 spawn", async () => {
  const h = createHarness();
  const lifecycle = h.create();

  await lifecycle.autoRepairChannel(); // 第一次尝试：spawn，repairFailures=1
  await lifecycle.autoRepairChannel(); // now 未推进，仍在退避窗口内

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.logs.filter((l) => l.message === "auto starting channel supervisor").length, 1);
});

// ---- stopChannel ----

test("stopChannel: 空 servers 配置不抛异常，跳过 tunnel 端口模式清理（D2 语义）", async () => {
  const h = createHarness();
  const lifecycle = h.create();
  const storeCalls = [];
  h.deps.store.setShouldBeRunning = (v) => storeCalls.push(v);

  await lifecycle.stopChannel();

  assert.equal(lifecycle.getShouldBeRunning(), false);
  assert.deepEqual(storeCalls, [false]);
  assert.ok(h.logs.some((l) => l.message === "stop: no tunnel configured, skipping tunnel port-pattern cleanup"));
  assert.ok(h.logs.some((l) => l.message === "stop completed"));
  // 无端口对时绝不能按 ssh 模式乱杀：pgrep 只应扫 supervisor 与 local-proxy 两个脚本特征。
  const pgrepPatterns = h.execCalls.filter((c) => c.cmd === "pgrep").map((c) => c.args[1]);
  assert.deepEqual(pgrepPatterns.sort(), ["work/local_http_connect_proxy.mjs", "work/monitor/channel-supervisor.mjs"]);
  assert.equal(h.killCalls.length, 0);
});

test("stopChannel: 正常配置走完整停止序列，supervisor 必须先于子目标停止", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => ({
    servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
  });
  h.deps.registry.readMeta = (name) => ({ name });
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  assert.deepEqual([...h.stopOrder].sort(), ["channel-supervisor", "local-proxy", "tunnel.server-01"]);
  assert.equal(h.stopOrder[0], "channel-supervisor");
  assert.ok(h.logs.some((l) => l.message === "stop channel-supervisor: SIGTERM delivered"));
  assert.ok(h.logs.some((l) => l.message === "stop completed"));
  // 注册表精准停止成功后不应再走 pgrep 兜底。
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.killCalls.length, 0);
});

test("stopChannel: pgrep 兜底逐 pid 校验命令行强特征，只杀受管进程（A3 语义）", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => ({
    servers: [{ id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 }],
  });
  h.deps.toolkit.execFile = async (cmd, args) => {
    h.execCalls.push({ cmd, args });
    if (cmd === "pgrep") {
      // supervisor 特征命中两个候选 pid：123 是真 supervisor，456 是 pid 复用后的无关进程。
      if (args[1] === "work/monitor/channel-supervisor.mjs") return { stdout: "123\n456\n" };
      return { stdout: "" };
    }
    if (cmd === "ps") {
      if (args[3] === "123") return { stdout: "node work/monitor/channel-supervisor.mjs" };
      return { stdout: "bash -c unrelated-process" };
    }
    return { stdout: "" };
  };
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  assert.deepEqual(h.killCalls, [{ pid: 123, signal: "SIGTERM" }]);
  assert.ok(h.logs.some((l) => l.message === "stop channel-supervisor: fallback kill pid 123"));
});

test("startChannel/stopChannel: fixture 模式只落日志与意图位，不做任何进程操作", async () => {
  const h = createHarness({ fixtureMode: true });
  const lifecycle = h.create();

  await lifecycle.startChannel();
  await lifecycle.stopChannel();

  assert.equal(h.spawnCalls.length, 0);
  assert.equal(h.getProcessesCalls(), 0);
  assert.equal(h.execCalls.length, 0);
  assert.ok(h.logs.some((l) => l.message === "start completed (fixture)"));
  assert.ok(h.logs.some((l) => l.message === "stop completed (fixture)"));
  assert.equal(lifecycle.getShouldBeRunning(), false);
});

// ---- maintenanceSweep ----

test("maintenanceSweep: refreshConfigIntoKernel 抛异常不中断、不冒泡，且同一 mtime 不重试", async () => {
  const mtimes = { config: 100, local: 50 };
  let refreshCalls = 0;
  const h = createHarness({
    statImpl: async (p) => ({ mtimeMs: p === "/repo/config.json" ? mtimes.config : mtimes.local }),
    refreshConfigIntoKernel: async () => {
      refreshCalls += 1;
      throw new Error("boom");
    },
  });
  const lifecycle = h.create();
  // 工厂创建时异步建立 mtime 基线，先让其落定。
  await new Promise((resolve) => setImmediate(resolve));

  mtimes.config = 200;
  await lifecycle.maintenanceSweep(); // 不应向上抛

  assert.equal(refreshCalls, 1);
  assert.ok(h.logs.some((l) => l.message === "config.json changed on disk, reloading into kernel"));
  const failure = h.logs.find((l) => l.message === "config hot-reload failed: boom");
  assert.ok(failure);
  assert.equal(failure.fields?.level, "error");

  // mtime 未再变化：下一拍不重试热载（避免坏配置每分钟刷屏）。
  await lifecycle.maintenanceSweep();
  assert.equal(refreshCalls, 1);
});

test("maintenanceSweep: 个人层文件消失视为一次变化，回落团队层触发热载", async () => {
  const mtimes = { config: 100 };
  let localExists = true;
  let refreshCalls = 0;
  const h = createHarness({
    statImpl: async (p) => {
      if (p === "/repo/config.json") return { mtimeMs: mtimes.config };
      if (!localExists) throw new Error("ENOENT");
      return { mtimeMs: 50 };
    },
    refreshConfigIntoKernel: async () => {
      refreshCalls += 1;
      return {};
    },
  });
  const lifecycle = h.create();
  await new Promise((resolve) => setImmediate(resolve));

  localExists = false;
  await lifecycle.maintenanceSweep();

  assert.equal(refreshCalls, 1);
});

// ---- 守护循环 ----

test("scheduleAutoRepair: 循环体抛异常后仍会续期（finally 语义），并落 loop error 日志", async () => {
  let appendLogCalls = 0;
  const recorded = [];
  const h = createHarness({
    appendLog: (message, fields) => {
      appendLogCalls += 1;
      // 前两次抛：第 1 次打断 autoRepairChannel 的 try 块，第 2 次打断其 catch 块，
      // 让异常真正冒泡进守护循环体——这正是 finally 续期要兜住的场景。
      if (appendLogCalls <= 2) throw new Error("logger down");
      recorded.push({ message, fields });
    },
  });
  const lifecycle = h.create();

  lifecycle.scheduleAutoRepair(0);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 0);

  await h.timers[0].fn();

  // 关键断言：循环体抛出后 finally 仍然续期了下一拍（5s 节拍）。
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[1].delay, 5000);
  assert.ok(recorded.some((l) => l.message === "auto repair loop error: logger down"));
});

test("scheduleAutoRepair: 正常拍续期且第 12 拍才做低频维护", async () => {
  let sweeps = 0;
  const h = createHarness({
    scheduler: {
      getResult: () => ({ checkedAt: FIXED_NOW, data: { processes: { supervisor: [{ pid: 1 }], localProxy: [], tunnel: [] } } }),
      forceRun: async () => ({}),
    },
    registry: {
      readMeta: () => null,
      stopProcess: async () => ({ stopped: false, reason: "no record" }),
      verifyProcess: async () => ({ verified: true }),
      recordProcess: () => {},
      listRuntimeProcesses: async () => {
        sweeps += 1;
        return [];
      },
    },
  });
  const lifecycle = h.create();

  lifecycle.scheduleAutoRepair(0);
  for (let tick = 0; tick < 12; tick += 1) {
    await h.timers[tick].fn();
  }

  assert.equal(h.timers.length, 13); // 每拍都续期
  assert.equal(sweeps, 1); // 只有第 12 拍触发 maintenanceSweep
});

// ---- v2.18 多隧道：stopChannel 要停掉每台服务器的 tunnel.<serverId> ----

const MULTI_TUNNEL_CONFIG = {
  activeServerId: "server-01",
  servers: [
    { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888, source: "team", disabled: false, tunnel: true },
    { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890, source: "personal", disabled: false, tunnel: true },
    { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, localPort: 8891, source: "personal", disabled: false, tunnel: false },
  ],
};

test("stopChannel: 每台配了隧道的服务器各停一个 tunnel.<serverId> 记录（tunnel:false 的不停）", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  h.deps.registry.readMeta = (name) => ({ name });
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  assert.deepEqual([...h.stopOrder].sort(), [
    "channel-supervisor", "local-proxy", "tunnel.server-01", "tunnel.server-tengxun",
  ]);
  assert.equal(h.stopOrder[0], "channel-supervisor", "supervisor 必须先于子目标停止");
  assert.ok(!h.stopOrder.includes("tunnel.server-aliyun"), "tunnel:false 的服务器没有隧道可停");
  // 注册表精准停止成功后不再走 pgrep 兜底。
  assert.equal(h.execCalls.length, 0);
});

test("stopChannel: 服务器都不建隧道时不按端口模式清理，只停 supervisor / local-proxy", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => ({
    ...MULTI_TUNNEL_CONFIG,
    servers: MULTI_TUNNEL_CONFIG.servers.map((server) => ({ ...server, tunnel: false })),
  });
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  assert.ok(h.logs.some((l) => l.message === "stop: no tunnel configured, skipping tunnel port-pattern cleanup"));
  const pgrepPatterns = h.execCalls.filter((c) => c.cmd === "pgrep").map((c) => c.args[1]);
  assert.deepEqual(pgrepPatterns.sort(), ["work/local_http_connect_proxy.mjs", "work/monitor/channel-supervisor.mjs"]);
});

test("stopChannel: 缺记录 / 记录校验失败的隧道各按自己的 -R 端口模式走 pgrep 兜底", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  // server-01 有记录但校验失败（stopProcess 拒绝），server-tengxun 缺记录。
  h.deps.registry.readMeta = (name) => (name === "tunnel.server-tengxun" ? null : { name });
  h.deps.registry.stopProcess = async (name) => {
    h.stopOrder.push(name);
    return name === "tunnel.server-01"
      ? { stopped: false, reason: "拒绝停止：进程校验失败" }
      : { stopped: true, reason: "SIGTERM delivered" };
  };
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  const pgrepPatterns = h.execCalls.filter((c) => c.cmd === "pgrep").map((c) => c.args[1]);
  assert.deepEqual(pgrepPatterns.sort(), ["ssh.*127.0.0.1:7891:127.0.0.1:8888", "ssh.*127.0.0.1:7893:127.0.0.1:8888"]);
});

test("stopChannel: pgrep 兜底按每台服务器自己的 -R 转发串校验，不误杀别的隧道", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  h.deps.registry.readMeta = () => null; // 无任何注册表记录 → 全部走 pgrep 兜底
  h.deps.toolkit.execFile = async (cmd, args) => {
    h.execCalls.push({ cmd, args });
    if (cmd === "pgrep") {
      if (args[1] === "ssh.*127.0.0.1:7893:127.0.0.1:8888") return { stdout: "555\n666\n" };
      return { stdout: "" };
    }
    if (cmd === "ps") {
      if (args[3] === "555") return { stdout: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver" };
      return { stdout: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 someoneelses-host" };
    }
    return { stdout: "" };
  };
  const lifecycle = h.create();

  await lifecycle.stopChannel();

  assert.deepEqual(h.killCalls, [{ pid: 555, signal: "SIGTERM" }]);
});

// ---- startChannel 的探活验证：v2.18 换掉已注销的 primary-remote ----

test("startChannel: forceRun 的是 processes / log-signals / 活跃服务器的 collect:slow，不再碰 primary-remote", async () => {
  const forced = [];
  const h = createHarness({
    scheduler: {
      getResult: () => undefined,
      forceRun: async (id) => {
        forced.push(id);
        return {};
      },
    },
  });
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  h.deps.toolkit.getMainServerConfig = (config) => config.servers.find((s) => s.id === config.activeServerId);
  const lifecycle = h.create();

  await lifecycle.startChannel();

  assert.deepEqual(forced, ["processes", "log-signals", "collect:slow:server-01"]);
  assert.equal(forced.includes("primary-remote"), false, "该探针已注销，forceRun 它只会 reject");
  // runbook 的"探活验证"步骤靠这条日志推进（render/repair-runbook.js 的 mapLogToStep）。
  const probeLog = h.logs.find((l) => typeof l.message === "string" && l.message.startsWith("probe "));
  assert.ok(probeLog, "必须留下一条 probe ... forced 日志");
  assert.equal(probeLog.message, "probe processes / log-signals / collect:slow:server-01 forced");
});

test("startChannel: 取不到活跃服务器时不拼半截 collect:slow: 探针 id", async () => {
  const forced = [];
  const h = createHarness({
    scheduler: {
      getResult: () => undefined,
      forceRun: async (id) => {
        forced.push(id);
        return {};
      },
    },
  });
  // getConfig 直接抛错（配置损坏）：启动流程不得中断，只是少刷一枚探针。
  h.deps.getConfig = async () => {
    throw new Error("config broken");
  };
  const lifecycle = h.create();

  await lifecycle.startChannel();

  assert.deepEqual(forced, ["processes", "log-signals"]);
});

// ---- restartChannel：L2 自动修复的执行入口 ----

test("restartChannel: 等价于 /api/restart 的 stop→start，日志带 trigger/ruleId/event", async () => {
  const h = createHarness();
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  h.deps.toolkit.getMainServerConfig = (config) => config.servers[0];
  const lifecycle = h.create();

  const result = await lifecycle.restartChannel({ trigger: "auto", ruleId: "channel-down-restart" });

  assert.deepEqual(result, { ok: true, reason: "" });
  const stopRequested = h.logs.find((l) => l.message === "stop requested");
  const startRequested = h.logs.find((l) => l.message === "start requested");
  assert.ok(stopRequested && startRequested, "必须走完整的停→起序列");
  assert.deepEqual(stopRequested.fields, { trigger: "auto", ruleId: "channel-down-restart", event: "auto-repair" });
  assert.deepEqual(startRequested.fields, { trigger: "auto", ruleId: "channel-down-restart", event: "auto-repair" });
  // 重启结束后意图位回到"该运行"，守护巡检继续保活。
  assert.equal(lifecycle.getShouldBeRunning(), true);
  assert.equal(lifecycle.getRepairInFlight(), false);
});

test("restartChannel: 手动触发不打 event=auto-repair（日志形状与既有 /api/restart 一致）", async () => {
  const h = createHarness();
  const lifecycle = h.create();

  await lifecycle.restartChannel();

  const stopRequested = h.logs.find((l) => l.message === "stop requested");
  assert.deepEqual(stopRequested.fields, { trigger: "manual" });
});

test("restartChannel: 重启期间 getRepairInFlight 为真，但内部拉起 supervisor 不被自己挡掉", async () => {
  const h = createHarness();
  let inFlightDuringStart = null;
  h.deps.getConfig = async () => MULTI_TUNNEL_CONFIG;
  h.deps.toolkit.getMainServerConfig = (config) => config.servers[0];
  const h2 = h;
  const lifecycle = h2.create();
  // 在 stop→start 之间偷看一眼旗标：探活验证的 forceRun 就发生在 startChannel 尾部。
  h.deps.scheduler.forceRun = async (id) => {
    if (inFlightDuringStart === null) inFlightDuringStart = lifecycle.getRepairInFlight();
    return { id };
  };

  await lifecycle.restartChannel({ trigger: "auto", ruleId: "channel-down-restart" });

  assert.equal(inFlightDuringStart, true, "策略层据此互斥，不许在重启途中再产出动作");
  // 关键回归点：若 restartChannel 复用 repairInFlight，autoRepairChannel({force:true})
  // 会在开头就 return，supervisor 永远不会被重新拉起（变成只停不起）。
  assert.equal(h.spawnCalls.length, 1, "supervisor 必须真的被重新 spawn");
});

test("restartChannel: 已有一次重启在飞时第二次直接拒绝，不重入", async () => {
  const h = createHarness();
  const lifecycle = h.create();
  let second = null;
  h.deps.scheduler.forceRun = async () => {
    if (second === null) second = await lifecycle.restartChannel({ trigger: "auto", ruleId: "x" });
    return {};
  };

  await lifecycle.restartChannel({ trigger: "auto", ruleId: "channel-down-restart" });

  assert.deepEqual(second, { ok: false, reason: "restart already in flight" });
});

test("restartChannel: 停止阶段抛错时返回 ok:false 并落 error 日志，旗标照样归零", async () => {
  const h = createHarness();
  h.deps.registry.readMeta = () => ({ name: "channel-supervisor" });
  h.deps.registry.stopProcess = async () => {
    throw new Error("registry 炸了");
  };
  // stopTarget 内部对 stopProcess 的异常有 catch，这里让 getConfig 抛以模拟真失败。
  h.deps.getConfig = async () => {
    throw new Error("配置读不出来");
  };
  const lifecycle = h.create();

  const result = await lifecycle.restartChannel({ trigger: "auto", ruleId: "channel-down-restart" });

  assert.equal(result.ok, false);
  assert.match(result.reason, /配置读不出来/);
  const failLog = h.logs.find((l) => typeof l.message === "string" && l.message.startsWith("restart failed"));
  assert.equal(failLog.fields.level, "error");
  assert.equal(failLog.fields.trigger, "auto");
  assert.equal(lifecycle.getRepairInFlight(), false, "finally 必须归零，否则策略层从此永久静默");
});

test("getRepairInFlight: 守护巡检自愈进行中同样算「修复进行中」", async () => {
  const h = createHarness();
  let seen = null;
  const lifecycle = h.create();
  h.deps.toolkit.getProcesses = async () => {
    seen = lifecycle.getRepairInFlight();
    return { supervisor: [{ pid: 1 }], localProxy: [], tunnel: [] };
  };

  await lifecycle.autoRepairChannel({ force: true });

  assert.equal(seen, true);
  assert.equal(lifecycle.getRepairInFlight(), false);
});

// v2.18：手动 /api/restart 也走 restartChannel——请求的 operationContext 原样透传，
// 手动路径只多一个 trigger:"manual"，不打 event/ruleId；自动路径才打全套。
test("restartChannel: 手动路径透传 context 且不打 event，自动路径才打 event/ruleId", async () => {
  const h = createHarness();
  const lifecycle = h.create();

  const manual = await lifecycle.restartChannel({ trigger: "manual", context: { operationId: "op-1" } });
  assert.equal(manual.ok, true);
  const manualLogs = h.logs.filter((e) => e.fields?.operationId === "op-1");
  assert.ok(manualLogs.length > 0, "手动重启的日志必须带请求的 operationId");
  assert.ok(manualLogs.every((e) => e.fields.trigger === "manual" && e.fields.event === undefined && e.fields.ruleId === undefined));

  h.logs.length = 0;
  const auto = await lifecycle.restartChannel({ trigger: "auto", ruleId: "channel-down-restart", context: { operationId: "op-2" } });
  assert.equal(auto.ok, true);
  const autoLogs = h.logs.filter((e) => e.fields?.operationId === "op-2");
  assert.ok(autoLogs.length > 0);
  assert.ok(autoLogs.every((e) => e.fields.trigger === "auto" && e.fields.event === "auto-repair" && e.fields.ruleId === "channel-down-restart"));
});
