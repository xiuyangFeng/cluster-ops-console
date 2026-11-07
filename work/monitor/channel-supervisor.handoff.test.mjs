// 热更新：supervisor 交接退出 + 新 supervisor 接管既有隧道/代理 + 代理平滑交接（全部 fake 进程）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { tunnelRecordName } from "./monitor-core.mjs";
import { createProcessRegistry } from "./lib/process-registry.mjs";
import { HANDOFF_WAITING_MARKER, parseProxyHealthHeaders } from "./lib/proxy/protocol.mjs";
import { buildShutdownPlan, partitionShutdownRecords, performHandoffExit } from "./lib/supervisor/handoff.mjs";
import { createLocalProxyController } from "./lib/supervisor/proxy-controller.mjs";
import { createTunnelController } from "./lib/supervisor/tunnel-controller.mjs";
import { buildTunnelIdentity } from "./lib/supervisor/tunnel-spec.mjs";

const cfg = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.kills = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    child.kills.push(signal);
  };
  return child;
}

// 一个"机器"：live 进程表 + 真实文件注册表（临时目录）+ 所有信号记录。
async function machine(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const live = new Map();
  const signals = [];
  const registry = createProcessRegistry({
    runtimeDir: dir,
    platform: "linux",
    execFileImpl: async (_cmd, args) => {
      const pid = Number(args.at(-1));
      return { stdout: live.has(pid) ? `${pid} ${live.get(pid)}` : "" };
    },
    killProcess: (pid, signal) => {
      signals.push({ pid, signal });
      live.delete(pid);
    },
    waitForPidExitImpl: async (pid) => !live.has(pid),
  });
  return { dir, live, signals, registry };
}

function tunnelControllerOn(m, spawned, { onSpawn } = {}) {
  let seq = spawned.length ? Math.max(...spawned) : 7000;
  return createTunnelController({
    name: tunnelRecordName(cfg.id),
    rootDir: m.dir,
    registry: m.registry,
    execFileImpl: async () => {
      throw new Error("adoption path must not run SSH probes or ps");
    },
    spawnImpl: (_cmd, args) => {
      const child = makeFakeChild(++seq);
      m.live.set(child.pid, `ssh ${args.join(" ")}`);
      spawned.push(child.pid);
      onSpawn?.(child);
      return child;
    },
    recordRuntimeProcess: m.registry.recordProcess,
    killProcess: (pid, signal) => m.signals.push({ pid, signal }),
    waitForPidExitImpl: async (pid) => !m.live.has(pid),
  });
}

test("交接退出：不杀任何子进程、不删隧道/代理登记，只删仍指向自己的 supervisor 记录，exit 0", async (t) => {
  const m = await machine(t);
  const spawned = [];
  const children = [];
  const oldSupervisor = tunnelControllerOn(m, spawned, { onSpawn: (c) => children.push(c) });
  await oldSupervisor.restartControlled(cfg, { verifyBudgetMs: 0 });
  const tunnelPid = spawned[0];
  m.live.set(4242, "/usr/bin/node work/local_http_connect_proxy.mjs");
  m.registry.recordProcess("local-proxy", 4242, { command: "node work/local_http_connect_proxy.mjs", args: ["work/local_http_connect_proxy.mjs"], cwd: m.dir });
  m.registry.recordProcess("channel-supervisor", 999, { command: "node work/monitor/channel-supervisor.mjs", cwd: m.dir });

  const calls = [];
  let stopping = false;
  let exitCode = null;
  let tickDone;
  const tick = new Promise((resolve) => { tickDone = resolve; });
  const done = performHandoffExit({
    trigger: "test",
    setStopping: () => { stopping = true; calls.push("stopping"); },
    waitForTick: () => tick,
    tickBudgetMs: 1000,
    releaseResources: async () => { calls.push("release"); await oldSupervisor.releaseForHandoff(); },
    removeOwnRecord: async () => {
      calls.push("remove-own");
      const meta = m.registry.readMeta("channel-supervisor");
      if (meta?.pid === 999) await rm(path.join(m.dir, "channel-supervisor.pid.json"), { force: true });
    },
    flushLogs: async () => calls.push("flush"),
    exit: (code) => { exitCode = code; },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
  });
  assert.equal(stopping, true, "第一步就要停主循环");
  tickDone();
  await done;

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, ["stopping", "release", "remove-own", "flush"]);
  assert.deepEqual(children.flatMap((c) => c.kills), [], "隧道 child 一个信号都不能收到");
  assert.deepEqual(m.signals, []);
  assert.equal(m.registry.readMeta(tunnelRecordName(cfg.id)).pid, tunnelPid, "隧道登记保留");
  assert.equal(m.registry.readMeta("local-proxy").pid, 4242, "代理登记保留");
  assert.equal(m.registry.readMeta("channel-supervisor"), null, "只删自己的记录");
});

test("交接退出：进行中的一拍卡住也有界（tickBudgetMs 到点照样退出）", async () => {
  let exitCode = null;
  await performHandoffExit({
    waitForTick: () => new Promise(() => {}),
    tickBudgetMs: 10,
    flushLogs: () => new Promise(() => {}),
    flushBudgetMs: 10,
    exit: (code) => { exitCode = code; },
    // 默认 sleep 的定时器是 unref 的（生产上不该由它吊住进程）。这里另外两路永不 resolve，
    // 事件循环里只剩它时 Node 22 的测试运行器会判"事件循环已空"并取消本文件余下全部用例。
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.equal(exitCode, 0);
});

test("新 supervisor 接管：既有隧道（配置未变）与健康代理原样保留，零 spawn、零信号", async (t) => {
  const m = await machine(t);
  const spawned = [];
  await tunnelControllerOn(m, spawned).restartControlled(cfg, { verifyBudgetMs: 0 });
  const tunnelPid = spawned[0];
  // 旧 supervisor 交接退出后：隧道仍在、登记仍在；代理同理（它是旧 supervisor 的子进程）。
  m.live.set(4242, "/usr/bin/node work/local_http_connect_proxy.mjs");
  m.registry.recordProcess("local-proxy", 4242, { command: "node work/local_http_connect_proxy.mjs", args: ["work/local_http_connect_proxy.mjs"], cwd: m.dir });

  // —— 新 supervisor（新进程 = 新 controller 实例，无任何 child 句柄）——
  const newTunnel = tunnelControllerOn(m, spawned);
  const tunnelResult = await newTunnel.ensure(cfg);
  assert.equal(tunnelResult.ok, true);
  assert.equal(tunnelResult.configIdentityState, "verified", "身份只由配置决定，与 supervisor 版本/进程无关");
  assert.equal(tunnelResult.configApplied, true);
  assert.equal(newTunnel.getState().adoptedPid, tunnelPid, "冷接管保留后续定向重启/移除所需的句柄");
  assert.deepEqual(spawned, [tunnelPid], "不得重建隧道");

  const proxySpawns = [];
  const newProxy = createLocalProxyController({
    spawnImpl: () => {
      proxySpawns.push(1);
      throw new Error("healthy adopted proxy must not be respawned");
    },
    verifyAdopted: () => m.registry.verifyProcess("local-proxy"),
  });
  const health = { ok: true, durationMs: 1, proxy: { pid: 4242, component: "abc123abc123", handoff: true } };
  const proxyResult = await newProxy.ensure(cfg, { checkHealth: async () => health });
  assert.equal(proxyResult.ok, true);
  assert.equal(proxyResult.adopted, true);
  assert.equal(newProxy.getCurrentChild(), null, "不拥有 child 句柄也照样保留");
  assert.deepEqual(newProxy.getState().observed, health.proxy, "代理指纹供快照发布");
  assert.deepEqual(proxySpawns, []);
  assert.deepEqual(m.signals, []);
  assert.equal(m.live.has(tunnelPid) && m.live.has(4242), true);
});

test("隧道身份与 supervisor 无关：只由配置决定（同配置恒等，换配置才变）", () => {
  assert.equal(buildTunnelIdentity(cfg), buildTunnelIdentity({ ...cfg }));
  assert.notEqual(buildTunnelIdentity(cfg), buildTunnelIdentity({ ...cfg, remotePort: 7892 }));
  assert.doesNotMatch(buildTunnelIdentity(cfg), /supervisor|version|commit|pid/i);
});

test("接管来的代理：进程已不在 → 立即重建；进程仍在但持续不健康 → 走死计数后按注册表停掉再起", async () => {
  const spawnedPids = [];
  const make = (verified, stops) => createLocalProxyController({
    spawnImpl: () => {
      const child = makeFakeChild(9000 + spawnedPids.length);
      spawnedPids.push(child.pid);
      return child;
    },
    verifyAdopted: async () => ({ verified }),
    stopAdoptedProxy: async () => {
      stops.push("stop");
      return { stopped: true, reason: "已停止" };
    },
    deathThreshold: 3,
    spawnGraceMs: 0,
  });
  const ok = async () => ({ ok: true, durationMs: 0 });
  const bad = async () => ({ ok: false, durationMs: 0 });

  const goneStops = [];
  const gone = make(false, goneStops);
  await gone.ensure(cfg, { checkHealth: ok });
  const r1 = await gone.ensure(cfg, { checkHealth: bad });
  assert.equal(r1.respawned, true, "进程已不在：不等死计数");
  assert.deepEqual(goneStops, []);

  const stuckStops = [];
  const stuck = make(true, stuckStops);
  await stuck.ensure(cfg, { checkHealth: ok });
  const before = spawnedPids.length;
  assert.equal((await stuck.ensure(cfg, { checkHealth: bad })).deathCount, 1);
  assert.equal((await stuck.ensure(cfg, { checkHealth: async () => ({ ok: false, timedOut: true }) })).timedOut, true);
  assert.equal((await stuck.ensure(cfg, { checkHealth: bad })).deathCount, 2);
  const r3 = await stuck.ensure(cfg, { checkHealth: bad });
  assert.equal(r3.respawned, true);
  assert.deepEqual(stuckStops, ["stop"], "卡死的接管代理先按注册表停掉，再起新的");
  assert.equal(spawnedPids.length, before + 1);
});

test("shutdown 分区：接管来的隧道/代理按注册表停，不被一刀切删登记；自己的 child 照旧删", () => {
  const ownChild = makeFakeChild(7001);
  const controllers = new Map([
    ["server-01", { controller: { getCurrentChild: () => ownChild } }],
    ["server-02", { controller: { getCurrentChild: () => null } }],
  ]);
  const plan = buildShutdownPlan({ getCurrentChild: () => null }, controllers);
  const metas = {
    "local-proxy": { pid: 4242 },
    "tunnel.server-01": { pid: 7001 },
    "tunnel.server-02": { pid: 7002 },
    "channel-supervisor": { pid: 1 },
  };
  const { adopted, remove } = partitionShutdownRecords(plan, (name) => metas[name] || null);
  assert.deepEqual(adopted.sort(), ["local-proxy", "tunnel.server-02"]);
  assert.deepEqual(remove.sort(), ["channel-supervisor", "tunnel.server-01"]);
});

test("代理指纹头解析：新代理带 pid/指纹/交接能力，旧代理全缺省为未知", () => {
  assert.deepEqual(parseProxyHealthHeaders({ "x-codex-proxy-pid": "321", "x-codex-proxy-component": "0123456789ab", "x-codex-proxy-handoff": "1" }),
    { pid: 321, component: "0123456789ab", handoff: true });
  assert.deepEqual(parseProxyHealthHeaders({}), { pid: null, component: "", handoff: false });
  assert.deepEqual(parseProxyHealthHeaders({ "x-codex-proxy-pid": "abc", "x-codex-proxy-component": "../x" }), { pid: null, component: "", handoff: false });
});

// ---- 代理平滑交接（controller 层，fake 进程）----

function handoffScene({ oldHandoff = true, emitWaiting = true, takeOver = true } = {}) {
  const spawned = [];
  const recorded = [];
  const releases = [];
  const cleared = [];
  const draining = [];
  let servingPid = 4242;
  const controller = createLocalProxyController({
    spawnImpl: (_exec, _args, options) => {
      const child = makeFakeChild(5000 + spawned.length);
      spawned.push({ child, env: options.env });
      if (options.env.CODEX_PROXY_HANDOFF === "1" && emitWaiting) {
        setTimeout(() => child.stdout.emit("data", `${HANDOFF_WAITING_MARKER} 127.0.0.1:8888\n`), 5);
      }
      return child;
    },
    recordRuntimeProcess: (name, pid) => recorded.push({ name, pid }),
    waitForPidExitImpl: async () => true,
  });
  const probe = async () => ({
    ok: true,
    durationMs: 0,
    proxy: { pid: servingPid, component: servingPid === 4242 ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb", handoff: servingPid === 4242 ? oldHandoff : true },
  });
  const options = {
    probe,
    requestRelease: async (pid) => {
      releases.push(pid);
      if (takeOver) servingPid = spawned.at(-1).child.pid;
    },
    clearRelease: async (pid) => cleared.push(pid),
    recordDraining: async (pid) => draining.push(["record", pid, releases.length]),
    clearDraining: async (pid) => draining.push(["clear", pid]),
    waitingTimeoutMs: 200,
    bindTimeoutMs: 200,
    pollMs: 5,
  };
  return { controller, spawned, recorded, releases, cleared, draining, options };
}

test("代理交接成功：新代理以交接模式起、等到 waiting 才请旧代理释放，确认新 pid 接管后才换登记", async () => {
  const s = handoffScene();
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "succeeded", result.reason);
  const newChild = s.spawned[0].child;
  assert.equal(s.spawned[0].env.CODEX_PROXY_HANDOFF, "1");
  assert.deepEqual(result.evidence, { oldPid: 4242, newPid: newChild.pid });
  assert.deepEqual(s.releases, [4242]);
  assert.deepEqual(s.cleared, [4242], "释放请求文件用完即清");
  assert.deepEqual(s.draining, [["record", 4242, 0]], "发释放请求之前就把旧代理登记为 draining，交接成功后保留");
  assert.deepEqual(s.recorded, [{ name: "local-proxy", pid: newChild.pid }]);
  assert.equal(s.controller.getCurrentChild(), newChild);
  assert.deepEqual(newChild.kills, []);
  assert.equal(s.controller.getState().observed.component, "bbbbbbbbbbbb");
});

test("代理交接：旧代理不支持交接（旧版本）→ 直接拒绝，不起新进程、不发释放请求", async () => {
  const s = handoffScene({ oldHandoff: false });
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /predates graceful handoff/);
  assert.deepEqual(s.spawned, []);
  assert.deepEqual(s.releases, []);
});

test("代理交接：新代理迟迟不进入 waiting → 停掉新代理，旧代理完全不受影响", async () => {
  const s = handoffScene({ emitWaiting: false });
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "failed");
  assert.deepEqual(s.releases, [], "没等到 waiting 绝不请旧代理释放");
  assert.deepEqual(s.draining, [], "没走到释放就不登记 draining");
  assert.deepEqual(s.spawned[0].child.kills, ["SIGTERM"]);
  assert.deepEqual(s.recorded, []);
});

test("代理交接：已释放但新代理没接管 → 停掉交接进程并立即普通模式补一个（不等死计数）", async () => {
  const s = handoffScene({ takeOver: false });
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "failed");
  assert.deepEqual(s.releases, [4242]);
  assert.equal(s.spawned.length, 2);
  assert.deepEqual(s.spawned[0].child.kills, ["SIGTERM"]);
  assert.equal(s.spawned[1].env.CODEX_PROXY_HANDOFF, undefined, "补起的是普通模式代理");
  assert.equal(result.evidence.fallbackPid, s.spawned[1].child.pid);
  assert.deepEqual(s.draining, [["record", 4242, 0]], "已释放的旧代理在排空：draining 登记保留");
  assert.deepEqual(s.recorded, [{ name: "local-proxy", pid: s.spawned[1].child.pid }]);
});

test("代理交接期间保活 ensure 排队等待，不会在 20ms 空窗里误判死亡", async () => {
  const s = handoffScene();
  const order = [];
  const handoff = s.controller.handoff(cfg, s.options).then((r) => { order.push("handoff"); return r; });
  const ensure = s.controller.ensure(cfg, { checkHealth: async () => { order.push("ensure-probe"); return { ok: true, durationMs: 0 }; } });
  await Promise.all([handoff, ensure]);
  assert.deepEqual(order, ["handoff", "ensure-probe"]);
});

test("代理交接：释放请求没送达 → 撤销 draining 登记（旧代理照常服务，仍是 local-proxy）", async () => {
  const s = handoffScene();
  s.options.requestRelease = async () => { throw new Error("EACCES"); };
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "failed");
  assert.match(result.reason, /could not be delivered/);
  assert.deepEqual(s.draining, [["record", 4242, 0], ["clear", 4242]]);
});

test("代理交接：登记 draining 失败不阻断交接", async () => {
  const s = handoffScene();
  s.options.recordDraining = async () => { throw new Error("disk full"); };
  const result = await s.controller.handoff(cfg, s.options);
  assert.equal(result.status, "succeeded", result.reason);
});
