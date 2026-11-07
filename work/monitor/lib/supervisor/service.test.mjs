// supervisor 服务装配与主循环一拍的特征化测试（fake 控制器/信箱/注册表或 fake 进程，不起任何真实进程）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createProcessRegistry } from "../process-registry.mjs";
import {
  CONTROL_ACTION_HANDOFF_EXIT,
  CONTROL_ACTION_PROXY_HANDOFF,
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_ACTION_TAKEOVER_TUNNEL,
} from "../supervisor-control.mjs";
import { createLocalProxyController } from "./proxy-controller.mjs";
import { createRuntimeIo } from "./runtime-io.mjs";
import { createSupervisorService, createSupervisorState } from "./service.mjs";
import { createTunnelController } from "./tunnel-controller.mjs";

function target(id, localPort, remotePort) {
  return { id, serverId: id, host: `${id}.example`, remotePort, localPort };
}

function configWith(proxyPort, activeServerId = "server-01") {
  return {
    proxyPort,
    activeServerId,
    tunnels: [target("server-01", proxyPort, 7891), target("server-02", proxyPort, 7892)],
  };
}

async function makeService(t, { configs }) {
  const dir = await mkdtemp(path.join(tmpdir(), "sup-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const out = { logs: [], proxyEnsures: [], tunnelEnsures: [], snapshots: [], polls: 0, created: [], exits: [], mailboxOptions: null };
  let index = 0;
  const proxyController = {
    ensure: async (config, options) => {
      out.proxyEnsures.push(config.localPort);
      await options.checkHealth(config.localPort);
      return { ok: true };
    },
    getState: () => ({ observed: null }),
    getCurrentChild: () => null,
    handoff: async () => ({ status: "succeeded" }),
  };
  out.service = createSupervisorService({
    rootDir: dir,
    runtimeDir: dir,
    instanceId: "abcd1234",
    startedAt: 1,
    build: { version: "", gitCommit: "" },
    componentHash: "",
    registry: {
      readMeta: () => null,
      recordProcess: () => {},
      verifyProcess: async () => ({ verified: false }),
      stopProcess: async () => ({ stopped: true, reason: "ok" }),
    },
    io: {
      removeRuntimeRecord: async () => {},
      recordRuntimeProcess: () => {},
      readPidCommand: async () => "",
      requestProxyRelease: async () => {},
      clearProxyRelease: async () => {},
      recordDrainingProxy: async () => {},
      clearDrainingProxy: async () => {},
    },
    log: (message, fields) => out.logs.push({ message, fields: fields || {} }),
    loadConfig: async () => configs[Math.min(index++, configs.length - 1)],
    createLocalProxyControllerImpl: () => proxyController,
    createTunnelControllerImpl: (options) => {
      out.created.push(options);
      return {
        ensure: async (config) => {
          out.tunnelEnsures.push({ name: options.name, localPort: config.localPort });
          return { ok: true };
        },
        getState: () => ({ configApplied: true, configIdentityState: "verified" }),
        getCurrentChild: () => null,
        stopCurrent: async () => {},
        restartControlled: async () => ({ status: "succeeded" }),
        releaseForHandoff: async () => {},
        handleNetworkChange: async () => ({ action: "backoff-reset" }),
      };
    },
    createControlMailboxImpl: (options) => {
      out.mailboxOptions = options;
      return {
        poll: async () => { out.polls += 1; },
        whenIdle: async () => {},
      };
    },
    probeProxyHealthImpl: async () => ({ ok: true, durationMs: 1 }),
    writeSnapshotFile: async (_file, snapshot) => out.snapshots.push(snapshot),
    flushLogs: async () => {},
    exit: (code) => out.exits.push(code),
  });
  return out;
}

test("createSupervisorState：唯一的共享状态对象，初值全部为空", () => {
  assert.deepEqual(createSupervisorState(), {
    stopping: false,
    currentServerId: null,
    handoffExiting: false,
    currentTick: null,
    firstTickCompletedAt: null,
    effectiveProxyPort: null,
  });
});

test("代理端口首拍钉死：之后配置换端口只提示一次，代理与全部 -R 继续指向原端口", async (t) => {
  const s = await makeService(t, { configs: [configWith(8888), configWith(8890, "server-02"), configWith(8891, "server-02")] });
  const { state } = s.service;

  await s.service.runTick();
  assert.equal(state.effectiveProxyPort, 8888);
  assert.equal(state.currentServerId, "server-01");
  assert.ok(Number.isFinite(state.firstTickCompletedAt), "首拍完成即记时间");
  assert.equal(s.snapshots.length, 2, "首拍：常规一次 + 首拍收尾补写一次");
  assert.equal(s.snapshots[1].firstTickCompletedAt, state.firstTickCompletedAt);

  await s.service.runTick();
  await s.service.runTick();
  const drift = s.logs.filter((entry) => entry.fields.event === "proxy-port-pinned");
  assert.deepEqual(drift, [{
    message: "active server localPort is now 8890; 代理端口沿用 8888（本期不重启本地代理，所有隧道继续指向它）",
    fields: { level: "warn", event: "proxy-port-pinned", nextAction: "如需真正切换代理端口，停止再启动通道" },
  }], "只提示一次");
  assert.equal(state.effectiveProxyPort, 8888);
  assert.deepEqual(s.proxyEnsures, [8888, 8888, 8888]);
  assert.ok(s.tunnelEnsures.every((entry) => entry.localPort === 8888), "所有 -R 仍指向钉死的端口");
  assert.ok(s.snapshots.every((snapshot) => snapshot.effectiveProxyPort === 8888));

  const switches = s.logs.filter((entry) => entry.fields.event === "active-server-switch");
  assert.deepEqual(switches.map((entry) => entry.message), [
    "active server changed from server-01 to server-02; all tunnels stay up (view only)",
  ]);
  assert.equal(state.currentServerId, "server-02");
  assert.equal(s.polls, 3, "每拍收尾轮询一次信箱");
});

test("活跃服务器切换到控制面端口时沿用已钉死的安全代理端口，不误停全部隧道", async (t) => {
  const conflict = {
    ...configWith(8877, "server-02"),
    proxyPortConflict: true,
  };
  const s = await makeService(t, { configs: [configWith(8888), conflict] });
  await s.service.runTick();
  await s.service.runTick();
  assert.deepEqual(s.proxyEnsures, [8888, 8888]);
  assert.ok(s.tunnelEnsures.every((entry) => entry.localPort === 8888));
  assert.equal(s.logs.some((entry) => entry.fields.event === "proxy-control-port-conflict"), false);
});

test("一拍：每台服务器一个 controller（按注册表名隔离、带运行时目录与共享限频器），currentTick 在拍末落地", async (t) => {
  const s = await makeService(t, { configs: [configWith(8888)] });
  const tick = s.service.runTick();
  const inFlight = s.service.state.currentTick;
  assert.ok(inFlight instanceof Promise, "拍内即可等待 currentTick");
  await tick;
  await inFlight;
  assert.deepEqual(s.created.map((options) => options.name), ["tunnel.server-01", "tunnel.server-02"]);
  assert.ok(s.created.every((options) => options.runtimeDir && options.rateLimiter === s.created[0].rateLimiter));
  assert.deepEqual([...s.service.controllers.keys()], ["server-01", "server-02"]);
});

test("一拍出错只记日志，currentTick 照样落地", async (t) => {
  const s = await makeService(t, { configs: [null] });
  await s.service.runTick();
  await s.service.state.currentTick;
  const loopError = s.logs.find((entry) => entry.message.startsWith("supervisor loop error: "));
  assert.ok(loopError);
  assert.equal(loopError.fields.level, "error", "主循环异常按 error 级记录");
});

test("信箱装配：本实例 id、四种动作、stopping 按调用时现读", async (t) => {
  const s = await makeService(t, { configs: [configWith(8888)] });
  const options = s.mailboxOptions;
  assert.equal(options.instanceId, "abcd1234");
  assert.deepEqual(Object.keys(options.handlers).sort(), [
    CONTROL_ACTION_HANDOFF_EXIT,
    CONTROL_ACTION_PROXY_HANDOFF,
    CONTROL_ACTION_RESTART_TUNNEL,
    CONTROL_ACTION_TAKEOVER_TUNNEL,
  ].sort());
  assert.equal(options.stopping(), false);
  s.service.state.stopping = true;
  assert.equal(options.stopping(), true);
});

test("shutdown 与交接退出共用同一份状态：交接中收到 SIGTERM 被忽略", async (t) => {
  const s = await makeService(t, { configs: [configWith(8888)] });
  s.service.startHandoffExit("SIGUSR2");
  assert.equal(s.service.state.handoffExiting, true);
  assert.equal(s.service.state.stopping, true);
  await s.service.shutdown("SIGTERM");
  assert.ok(s.logs.some((entry) => entry.message.startsWith("SIGTERM ignored: supervisor handoff exit already in progress")));
});

// 端到端装配：真实的代理/隧道控制器、注册表、落盘簿记、信箱与快照写者，只把"进程"换成
// fake（spawn / ps / ssh 探测都不真跑）。守的是装配本身：依赖名接错、状态没共享、
// 簿记写错目录这类问题单测各模块时看不出来。
test("生产装配（真实控制器 + fake 进程）：首拍拉起代理与每台服务器一条 -R 并落盘登记；稳态零 spawn；shutdown 全部收回", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sup-wiring-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const live = new Map();
  const spawned = [];
  let nextPid = 5000;
  let sshProbes = 0;
  const fakeSpawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = ++nextPid;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      child.killed = true;
      live.delete(child.pid);
      setImmediate(() => child.emit("exit", null, signal));
    };
    live.set(child.pid, `${command === process.execPath ? "node" : command} ${args.join(" ")}`);
    spawned.push({ command, args, options });
    return child;
  };
  const execFileImpl = async (command, args) => {
    if (command === "ssh") {
      sshProbes += 1;
      return { code: 1, stdout: "", stderr: "", timedOut: false }; // 远端端口没开 → 冷启动建隧道
    }
    const pids = String(args.at(-1)).split(",").map(Number);
    return { code: 0, stdout: pids.filter((pid) => live.has(pid)).map((pid) => `${pid} ${live.get(pid)}`).join("\n") };
  };
  const waitGone = async (pid) => !live.has(pid);
  const registry = createProcessRegistry({ runtimeDir, platform: "linux", execFileImpl, killProcess: (pid) => live.delete(pid), waitForPidExitImpl: waitGone });
  const logs = [];
  const log = (message, fields) => logs.push({ message, fields: fields || {} });
  const io = createRuntimeIo({ rootDir: root, runtimeDir, registry });
  const exits = [];
  const tunnels = [
    { id: "server-01", serverId: "server-01", host: "alpha.example", remotePort: 7891, localPort: 18888 },
    { id: "server-02", serverId: "server-02", host: "beta.example", remotePort: 7892, localPort: 18888 },
  ];
  const service = createSupervisorService({
    rootDir: root,
    runtimeDir,
    instanceId: "abcd1234",
    startedAt: 1,
    build: { version: "", gitCommit: "" },
    componentHash: "",
    registry,
    io,
    log,
    loadConfig: async () => ({ proxyPort: 18888, activeServerId: "server-01", tunnels }),
    createLocalProxyControllerImpl: (options) => createLocalProxyController({ ...options, spawnImpl: fakeSpawn, waitForPidExitImpl: waitGone }),
    createTunnelControllerImpl: (options) => createTunnelController({ ...options, spawnImpl: fakeSpawn, execFileImpl, waitForPidExitImpl: waitGone }),
    probeProxyHealthImpl: async () => ({ ok: [...live.values()].some((cmd) => cmd.includes("local_http_connect_proxy")), statusCode: null, durationMs: 1 }),
    flushLogs: async () => {},
    exit: (code) => exits.push(code),
    waitForPidExitImpl: waitGone,
    killProcess: (pid) => live.delete(pid),
  });

  await service.runTick();
  await service.controlMailbox.whenIdle();
  const [proxy, ...ssh] = spawned;
  assert.equal(proxy.command, process.execPath);
  assert.deepEqual(proxy.args, ["work/local_http_connect_proxy.mjs"]);
  assert.equal(proxy.options.env.PORT, "18888");
  assert.equal(proxy.options.cwd, root);
  assert.deepEqual(ssh.map((entry) => entry.args.slice(-3)), [
    ["-R", "127.0.0.1:7891:127.0.0.1:18888", "alpha.example"],
    ["-R", "127.0.0.1:7892:127.0.0.1:18888", "beta.example"],
  ]);
  assert.deepEqual((await readdir(runtimeDir)).filter((name) => name.endsWith(".pid.json")).sort(),
    ["local-proxy.pid.json", "tunnel.server-01.pid.json", "tunnel.server-02.pid.json"]);
  assert.equal(registry.readMeta("tunnel.server-01").signature, "-R 127.0.0.1:7891:127.0.0.1:18888 alpha.example");
  assert.equal(registry.readMeta("local-proxy").cwd, root);
  const snapshot = JSON.parse(await readFile(path.join(runtimeDir, "supervisor-state.json"), "utf8"));
  assert.equal(snapshot.instanceId, "abcd1234");
  assert.equal(snapshot.effectiveProxyPort, 18888);
  assert.deepEqual(Object.keys(snapshot.targets), ["server-01", "server-02"]);
  assert.equal(snapshot.firstTickCompletedAt, service.state.firstTickCompletedAt);
  const stages = logs.filter((entry) => entry.message === "bridge stage snapshot").map((entry) => entry.fields.bridgeStage);
  assert.ok(stages.some((stage) => stage.stage === "local-proxy" && stage.channelServerId === "server-01"));
  assert.ok(stages.some((stage) => stage.stage === "ssh-tunnel" && stage.serverId === "server-02"));

  // 稳态：代理探活健康、隧道注册表校验通过 → 不再 spawn，也不再发探测 ssh。
  await service.runTick();
  await service.controlMailbox.whenIdle();
  assert.equal(spawned.length, 3, "稳态零 spawn");
  assert.equal(sshProbes, 2, "稳态不再发探测 ssh（只有首拍冷启动各一次）");

  await service.shutdown("SIGTERM");
  assert.equal(service.state.stopping, true);
  assert.deepEqual(exits, [0]);
  assert.equal(live.size, 0, "代理与全部隧道都被收回");
  assert.deepEqual((await readdir(runtimeDir)).filter((name) => name.endsWith(".pid.json")), []);
});
