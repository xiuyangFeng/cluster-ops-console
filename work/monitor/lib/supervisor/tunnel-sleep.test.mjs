// 休眠归因（supervisor 侧，假时钟）：挂钟跳变期间 / 醒来后短时间内发现的断线带 sleep，正常运行中的不带；
// 每次发现跳变落一行 wake。只是记账——同一串输入下起 ssh、回收、退避都与之前一致（见最后的现场回放）。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRateLimiter } from "../auto-repair-policy.mjs";
import { createSupervisorService } from "./service.mjs";
import { LID_CLOSED_AT, RECORDED_ROWS, replaySleepScene, sceneTime, SCENE_SERVERS } from "./sleep-scene-fixture.mjs";
import { createTunnelController, SLEEP_ATTRIBUTION_MS, TUNNEL_ESTABLISHED_MS, WAKE_GAP_MS } from "./tunnel-controller.mjs";
import { createTunnelLedgerWriter, sanitizeLedgerEvent, TUNNEL_LEDGER_FILENAME } from "./tunnel-ledger.mjs";

const MIN = 60_000;
const TICK = 5000;
const cfg = { id: "server-01", host: "example-cluster", remotePort: 7891, localPort: 8888 };

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

// 注册表按「当前存活的受管 pid」作答；远端端口探测恒为关闭。adoptedPid：上一任 supervisor 留下的隧道
// （不是子进程，没有 exit 事件，只能靠注册表校验发现它没了）。onProbe：远端端口探测期间发生的事。
function makeScene({ adoptedPid = null, tcpLocalAddresses = null } = {}) {
  const children = [];
  const sessions = [];
  const scene = { alivePid: adoptedPid, onProbe: null };
  let clock = 1_000_000;
  const controller = createTunnelController({
    name: "tunnel.server-01",
    spawnImpl: () => {
      const child = makeFakeChild(7000 + children.length);
      children.push(child);
      scene.alivePid = child.pid;
      child.on("exit", () => {
        if (scene.alivePid === child.pid) scene.alivePid = null;
      });
      return child;
    },
    execFileImpl: async (command) => {
      if (command === "ssh" && scene.onProbe) {
        const hook = scene.onProbe;
        scene.onProbe = null;
        await hook();
      }
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    },
    listSshProcesses: async () => [],
    runRemoteCommandImpl: async () => ({ code: 0, stdout: "found=0 reclaimed=0\n", stderr: "", timedOut: false }),
    registry: {
      verifyProcess: async () => (scene.alivePid
        ? { verified: true, meta: { pid: scene.alivePid, name: "tunnel.server-01", rootDir: "/repo" } }
        : { verified: false, reason: "test" }),
    },
    ...(tcpLocalAddresses ? { readTcpLocalAddresses: async () => tcpLocalAddresses } : {}),
    rateLimiter: createRateLimiter({ now: () => clock }),
    now: () => clock,
    waitForPidExitImpl: async () => true,
    killProcess: () => {},
    rootDir: "/repo",
    platform: "linux",
    tunnelOwnerId: "0123456789abcdef",
    onSessionEvent: (event) => sessions.push(event),
    sleep: async () => {},
  });
  return Object.assign(scene, {
    controller, children, sessions,
    now: () => clock,
    jump: (ms) => { clock += ms; },
    ensure: () => controller.ensure(cfg),
    // 醒着过 ms 毫秒：5 秒一拍地调 ensure（生产里主循环就是这个节奏）。
    async run(ms) {
      for (let passed = TICK; passed <= ms; passed += TICK) {
        clock += TICK;
        await controller.ensure(cfg);
      }
    },
    // 当前 ssh 以给定 stderr 异常退出（255）。
    async crash(stderr = "Connection to 192.0.2.10 closed by remote host.") {
      const child = children.at(-1);
      child.stderr.emit("data", stderr);
      child.emit("exit", 255, null);
      await controller.whenOrphanSettled();
    },
    // 起一条自己的隧道并等它建立。
    async establish() {
      await controller.ensure(cfg);
      await scene.run(TUNNEL_ESTABLISHED_MS);
      assert.equal(sessions.at(-1).type, "up");
    },
    of: (type) => sessions.filter((event) => event.type === type),
  });
}

test("正常运行中的断线不带 sleep；没有挂钟跳变就不写 wake 行", async () => {
  const scene = makeScene();
  await scene.establish();
  await scene.run(60 * MIN);
  scene.jump(2000);
  await scene.crash("Timeout, server 192.0.2.10 not responding.");
  const down = scene.sessions.at(-1);
  assert.equal(down.type, "down");
  assert.equal(down.cause, "keepalive-timeout");
  assert.equal(down.sleep, false, "账本行显式写 false，不是缺字段");
  assert.deepEqual(scene.of("wake"), []);
  assert.equal(scene.controller.getState().lastWakeAt, null);

  // 5 秒一拍、不到 WAKE_GAP_MS 的停顿都不算跳变；刚好超过才算
  await scene.ensure();
  scene.jump(WAKE_GAP_MS);
  await scene.ensure();
  assert.deepEqual(scene.of("wake"), [], "恰好等于阈值不算");
  scene.jump(WAKE_GAP_MS + 1);
  await scene.ensure();
  assert.deepEqual(scene.of("wake").map((event) => event.sleptMs), [WAKE_GAP_MS + 1]);
});

test("跳变后这一拍发现接管来的隧道进程没了：先落 wake（起止），断线带 sleep", async () => {
  const scene = makeScene({ adoptedPid: 501 });
  await scene.ensure();
  await scene.run(MIN);
  const asleepAt = scene.now();
  scene.jump(17 * MIN);
  scene.alivePid = null;
  await scene.ensure();

  const [wake] = scene.of("wake");
  assert.deepEqual(wake, { type: "wake", at: scene.now(), sleptMs: 17 * MIN }, "不带 serverId：休眠是整台电脑的事");
  assert.equal(wake.at - wake.sleptMs, asleepAt, "at - sleptMs = 睡前最后一次 ensure");
  const down = scene.of("down").at(-1);
  assert.equal(down.cause, "process-lost");
  assert.equal(down.sleep, true);
  assert.ok(scene.sessions.indexOf(wake) < scene.sessions.indexOf(down), "wake 行在前");
  assert.equal(scene.controller.getState().lastWakeAt, wake.at);
  assert.equal(scene.children.length, 1, "照常立刻重建");
});

test("醒来后 ssh 的 exit 事件先于本拍 ensure：跳变还没被记下也算休眠；随后那次 ensure 才落 wake", async () => {
  const scene = makeScene();
  await scene.establish();
  await scene.run(MIN);
  scene.jump(17 * MIN);
  await scene.crash();
  assert.equal(scene.of("down").at(-1).sleep, true);
  assert.deepEqual(scene.of("wake"), [], "此刻 ensure 还没跑到");
  await scene.ensure();
  assert.equal(scene.of("wake").length, 1);
  assert.equal(scene.of("wake")[0].sleptMs, 17 * MIN);
});

test("醒来后 120 秒内发现的算休眠，超过就是普通断线", async () => {
  assert.equal(SLEEP_ATTRIBUTION_MS, 120_000);
  for (const [afterWakeMs, expected] of [[SLEEP_ATTRIBUTION_MS, true], [SLEEP_ATTRIBUTION_MS + 1, false]]) {
    const scene = makeScene();
    await scene.establish();
    scene.jump(10 * MIN);
    await scene.ensure(); // 醒来：ssh 进程还在，这一拍不记断线
    assert.equal(scene.of("wake").length, 1);
    assert.equal(scene.of("down").length, 0);
    const wokeAt = scene.now();
    await scene.run(115_000);
    scene.jump(wokeAt + afterWakeMs - scene.now());
    await scene.crash();
    assert.equal(scene.of("down").at(-1).sleep, expected, `醒来后 ${afterWakeMs}ms`);
  }
});

test("醒来后系统对时把挂钟往回拨了一点：照样算", async () => {
  const scene = makeScene();
  await scene.establish();
  scene.jump(10 * MIN);
  await scene.ensure();
  scene.jump(-1500);
  await scene.crash();
  assert.equal(scene.of("down").at(-1).sleep, true);
});

test("计划内的停止（受控重启）不做休眠归因", async () => {
  const scene = makeScene();
  await scene.establish();
  scene.jump(17 * MIN);
  await scene.controller.restartControlled(cfg, { verifyBudgetMs: 0 });
  const down = scene.of("down").at(-1);
  assert.equal(down.planned, true);
  assert.equal(down.sleep, false);
});

test("醒来时换网复核把隧道当场重建（network-change）：发生在本拍 ensure 之前，同样带 sleep", async () => {
  const scene = makeScene({ tcpLocalAddresses: ["10.0.0.5"] });
  await scene.establish();
  await scene.run(MIN);
  scene.jump(17 * MIN);
  const result = await scene.controller.handleNetworkChange({ removed: ["10.0.0.5"], added: [] });
  assert.equal(result.action, "restarted");
  const down = scene.of("down").at(-1);
  assert.equal(down.cause, "network-change");
  assert.equal(down.networkChange, true);
  assert.equal(down.sleep, true);

  // 没有跳变时的换网重建不带
  const awake = makeScene({ tcpLocalAddresses: ["10.0.0.5"] });
  await awake.establish();
  await awake.run(MIN);
  await awake.controller.handleNetworkChange({ removed: ["10.0.0.5"], added: [] });
  assert.equal(awake.of("down").at(-1).cause, "network-change");
  assert.equal(awake.of("down").at(-1).sleep, false);
});

test("睡前卡在远端探测上、醒来才跑完的那次 ensure 里记下的断线也带 sleep（它自己发现不了跳变）", async () => {
  const scene = makeScene({ adoptedPid: 501 });
  await scene.ensure();
  await scene.run(MIN);
  scene.jump(TICK);
  scene.alivePid = null;
  scene.onProbe = () => scene.jump(17 * MIN); // 探测发出去，电脑就睡了
  await scene.ensure();
  assert.equal(scene.of("down").at(-1).cause, "process-lost");
  assert.equal(scene.of("down").at(-1).sleep, true);
  assert.deepEqual(scene.of("wake"), [], "这次 ensure 是睡前开始的");
  scene.jump(TICK);
  await scene.ensure();
  assert.equal(scene.of("wake").length, 1, "下一拍补记这次跳变");
});

test("账本白名单：wake 行与 sleptMs、down 行的 sleep 能落盘；别的字段照旧挡在外面", () => {
  assert.deepEqual(sanitizeLedgerEvent({ type: "wake", at: 5000.9, sleptMs: 1061000.4, evil: 1 }), { v: 1, type: "wake", at: 5000, sleptMs: 1061000 });
  assert.equal(sanitizeLedgerEvent({ type: "down", at: 1, planned: false, networkChange: true, sleep: true }).sleep, true);
  assert.equal(sanitizeLedgerEvent({ type: "down", at: 1, sleep: false }).sleep, false);
  assert.equal("sleep" in sanitizeLedgerEvent({ type: "down", at: 1, sleep: "yes" }), false, "不是布尔值不收");
  assert.equal("sleep" in sanitizeLedgerEvent({ type: "down", at: 1 }), false);
});

test("supervisor 装配：控制器上报的 wake / 带 sleep 的 down 原样进断线账本文件", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sleep-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = createTunnelLedgerWriter({ runtimeDir: dir });
  const created = [];
  const service = createSupervisorService({
    rootDir: dir,
    runtimeDir: dir,
    instanceId: "abcd1234",
    startedAt: 1,
    build: { version: "", gitCommit: "" },
    componentHash: "",
    registry: { readMeta: () => null, recordProcess: () => {}, verifyProcess: async () => ({ verified: false }), stopProcess: async () => ({ stopped: true }) },
    io: { removeRuntimeRecord: async () => {}, recordRuntimeProcess: () => {} },
    loadConfig: async () => ({ proxyPort: 8888, activeServerId: "server-01", tunnels: [{ ...cfg, serverId: cfg.id }] }),
    createLocalProxyControllerImpl: () => ({ ensure: async () => ({ ok: true }), getState: () => ({ observed: null }), getCurrentChild: () => null }),
    createTunnelControllerImpl: (options) => {
      created.push(options);
      return { ensure: async () => ({ ok: true }), getState: () => ({}), getCurrentChild: () => null, stopCurrent: async () => {}, handleNetworkChange: async () => ({}) };
    },
    createControlMailboxImpl: () => ({ poll: async () => {}, whenIdle: async () => {} }),
    probeProxyHealthImpl: async () => ({ ok: true, durationMs: 1 }),
    writeSnapshotFile: async () => {},
    networkWatcher: { check: () => null },
    ledger,
    now: () => 9_000_000,
  });
  await service.runTick();
  assert.equal(created.length, 1);
  created[0].onSessionEvent({ type: "wake", at: 9_000_100, sleptMs: 1_061_000 });
  created[0].onSessionEvent({ type: "down", serverId: "server-01", host: "example-cluster", at: 9_000_200, pid: 7, uptimeMs: 5, cause: "closed", detail: "", code: 255, signal: null, planned: false, networkChange: true, sleep: true });
  await ledger.flush();
  const lines = fs.readFileSync(path.join(dir, TUNNEL_LEDGER_FILENAME), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.filter((row) => row.type === "wake"), [{ v: 1, type: "wake", at: 9_000_100, sleptMs: 1_061_000 }]);
  assert.deepEqual(lines.find((row) => row.type === "down"), { v: 1, type: "down", at: 9_000_200, serverId: "server-01", host: "example-cluster", cause: "closed", pid: 7, uptimeMs: 5, code: 255, planned: false, networkChange: true, sleep: true });
});

// ---- 2026-10-11 现场回放 ----

// 去掉休眠归因新增的东西（wake 行、sleep 字段）与对不上号的细节（pid、毫秒），剩下的就是旧版会记的内容。
const asRecorded = (rows) => rows
  .filter((row) => row.type !== "wake" && row.at >= sceneTime("19:00:00"))
  .map(({ sleep: _sleep, pid: _pid, ...row }) => ({ ...row, at: Math.floor(row.at / 1000) * 1000 }));

test("现场回放：去掉新增的字段与行，与当时账本记下的逐行逐字段一致（既有字段一个没变）", async () => {
  const { rows } = await replaySleepScene();
  assert.deepEqual(asRecorded(rows), RECORDED_ROWS.map((row) => ({ ...row })));
});

test("现场回放：合盖期间与开盖后 120 秒内的 7 次断线全部带 sleep，原因五花八门；wake 行连成一整段休眠", async () => {
  const { rows } = await replaySleepScene();
  const downs = rows.filter((row) => row.type === "down");
  assert.deepEqual(downs.map((row) => [row.serverId, row.cause, row.sleep]), [
    ["server-01", "process-lost", true],
    ["server-02", "process-lost", true],
    ["server-02", "closed", true],
    ["server-01", "remote-closed", true],
    ["server-02", "closed", true],
    ["server-01", "closed", true],
    ["server-02", "remote-closed", true],
  ]);
  // 21:47:33 那一次：开盖（21:45:50）后 1 分 43 秒，距控制器发现跳变（21:45:57.611）95.6 秒 —— 在 120 秒内，算。
  const wakes = rows.filter((row) => row.type === "wake");
  const last = downs.at(-1);
  assert.equal(last.serverId, SCENE_SERVERS.cloud.id);
  assert.equal(last.at - wakes.at(-1).at, 95_597);
  assert.ok(last.at - wakes.at(-1).at <= SLEEP_ATTRIBUTION_MS);

  // wake 行（两个控制器各记各的，共 18 行，都不带 serverId）首尾相接——醒着的片刻最多几秒——
  // 从合盖前最后一拍一直盖到开盖后的第一拍。
  assert.equal(wakes.length, 18);
  assert.ok(wakes.every((row) => !("serverId" in row) && !("host" in row)));
  const naps = wakes.map((row) => [row.at - row.sleptMs, row.at]).sort((a, b) => a[0] - b[0]);
  assert.equal(naps[0][0], LID_CLOSED_AT);
  assert.equal(Math.max(...naps.map((nap) => nap[1])), sceneTime("21:45:57.611"));
  let coveredTo = naps[0][1];
  for (const [from, to] of naps) {
    assert.ok(from - coveredTo <= 6000, "相邻两段之间醒着不超过几秒");
    coveredTo = Math.max(coveredTo, to);
  }
});

test("现场回放：每次重建的时刻由账本里的 downMs 钉死——归因没有让任何一次重连提前或推后", async () => {
  const { trace } = await replaySleepScene();
  const spawns = trace.filter((entry) => entry.what === "spawn").map((entry) => [entry.server, entry.at]);
  assert.deepEqual(spawns, [
    ["server-01", sceneTime("19:55:35.642")],
    ["server-02", sceneTime("20:29:13.325")],
    ["server-02", sceneTime("20:46:10.129")],
    ["server-01", sceneTime("21:20:19.201")],
    ["server-02", sceneTime("21:45:50.300")],
    ["server-02", sceneTime("21:45:57.611")],
    ["server-01", sceneTime("21:45:59.098")],
    ["server-02", sceneTime("21:48:31.076")],
  ]);
  assert.equal(trace.filter((entry) => entry.what === "reclaim").length, 7, "每次异常断开后重建前回收一次残留会话");
  assert.deepEqual(trace.filter((entry) => entry.what === "kill"), [], "全程没有杀过任何进程");
});
