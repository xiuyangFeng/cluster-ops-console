// 同账号多台 Mac 的隧道接力（v2.88）：控制器 + handover 的场景测试（假 ssh / 假远端）。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { createRateLimiter } from "../auto-repair-policy.mjs";
import { reduceBridgeStage } from "./bridge-stage.mjs";
import { STANDBY_RECHECK_MS, SIBLING_DEAD_RECHECK_MS, YIELD_RECHECK_MS } from "./sibling-handover.mjs";
import { SIBLING_YIELD_TOKEN } from "./sibling-tunnel.mjs";
import { createTunnelController } from "./tunnel-controller.mjs";

const OWNER = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const cfg = { id: "server-01", host: "myserver", remotePort: 7893, localPort: 8888 };
const FORWARD_FAILED_LINE = "Warning: remote port forwarding failed for listen port 7893";

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

// remote：{ listening, sibling: null | { health, label }, takeoverFound }，用例中途可改。
function makeScene({ autoRepair = null } = {}) {
  const children = [];
  const remote = { listening: true, sibling: { health: "ok", label: "Mac-mini" }, takeoverFound: 1 };
  const commands = [];
  const logs = [];
  const stages = [];
  const sessionEvents = [];
  let clock = 1_000_000;
  let firstProbe = true;
  let verified = false;
  const controller = createTunnelController({
    name: "tunnel.server-01",
    spawnImpl: () => {
      const child = makeFakeChild(9000 + children.length);
      children.push(child);
      return child;
    },
    // 远端端口探测：首次冷启动按「没在听」走到 spawn；之后按 remote.listening。
    execFileImpl: async () => {
      const open = firstProbe ? false : remote.listening;
      firstProbe = false;
      return { code: open ? 0 : 1, stdout: "", stderr: "", timedOut: false };
    },
    listSshProcesses: async () => [],
    runRemoteCommandImpl: async (_config, command) => {
      commands.push(command);
      if (command.includes("HEALTH=")) {
        const s = remote.sibling;
        const out = s ? `SIB 201 ${OTHER} 03:00:00 ${s.label}\nHEALTH=${s.health}\nEND\n` : "HEALTH=none\nEND\n";
        return { code: 0, stdout: out, stderr: "", timedOut: false };
      }
      if (command.includes("TAKEOVER")) {
        const found = remote.sibling ? remote.takeoverFound : 0;
        remote.sibling = null;
        return { code: 0, stdout: `TAKEOVER found=${found} ended=${found}\n`, stderr: "", timedOut: false };
      }
      // 本机残留会话回收：端口上没有本机的会话。
      return { code: 0, stdout: "found=0 reclaimed=0\n", stderr: "", timedOut: false };
    },
    registry: { verifyProcess: async () => ({ verified, meta: verified ? { pid: children.at(-1)?.pid, name: "tunnel.server-01", rootDir: "/repo" } : null }) },
    getAutoRepair: () => autoRepair,
    rateLimiter: createRateLimiter({ now: () => clock }),
    now: () => clock,
    waitForPidExitImpl: async () => true,
    killProcess: () => {},
    emitStage: (partial) => stages.push(partial),
    log: (message, fields) => logs.push({ message, fields: fields || {} }),
    onSessionEvent: (event) => sessionEvents.push(event),
    rootDir: "/repo",
    selfPid: 4242,
    deathThreshold: 1,
    spawnGraceMs: 0,
    platform: "linux",
    tunnelOwnerId: OWNER,
    machineLabel: "MacBook-Air",
  });
  async function failForwardOnce() {
    await controller.ensure(cfg);
    const child = children.at(-1);
    child.stderr.emit("data", FORWARD_FAILED_LINE);
    child.emit("exit", 255, null);
    await controller.whenOrphanSettled();
    return child;
  }
  return {
    controller, children, remote, commands, logs, stages, sessionEvents, failForwardOnce,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    setVerified: (v) => { verified = v; },
    event: (name) => logs.find((entry) => entry.fields.event === name)?.fields ?? null,
    surveys: () => commands.filter((c) => c.includes("HEALTH=")).length,
    takeovers: () => commands.filter((c) => c.includes("TAKEOVER")).length,
  };
}

test("冷启动撞上同账号另一台 Mac（对方在线）→ 待命：不按异己占用退避 5 分钟，快照带待命、清掉 foreign", async () => {
  const scene = makeScene();
  await scene.failForwardOnce();
  assert.equal(scene.event("tunnel-port-foreign"), null, "另一台 Mac 不是异己");
  const standby = scene.controller.getState().standby;
  assert.equal(standby.reason, "holder-active");
  assert.deepEqual(standby.holder, { ownerId: OTHER, label: "Mac-mini", heldSec: 3 * 3600 });
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + STANDBY_RECHECK_MS);
  assert.ok(scene.event("tunnel-standby"));
  assert.deepEqual(scene.sessionEvents.filter((e) => e.type === "handover").map((e) => [e.role, e.reason, e.peer]), [["standby", "holder-active", "Mac-mini"]]);
  // bridge-stage：待命粘住，并把此前粘住的 foreign 清掉
  const prior = reduceBridgeStage(null, { stage: "ssh-tunnel", ok: false, foreign: true });
  const last = scene.stages.at(-1);
  const snapshot = reduceBridgeStage(prior, { stage: "ssh-tunnel", ...last });
  assert.equal(snapshot.foreign, false);
  assert.equal(snapshot.standby.peer, "Mac-mini");
  // 本机命令里带上本机机器名（写进集群的 tunnel-macs 目录）
  assert.ok(scene.commands.find((c) => c.includes("HEALTH=")).includes("MacBook-Air"));
});

test("待命期间的复查只查看、不 spawn；对方的隧道断了（端口空了）就离开待命、立刻自己建", async () => {
  const scene = makeScene();
  await scene.failForwardOnce();
  const spawned = scene.children.length;
  // 退避期内不动
  await scene.controller.ensure(cfg);
  assert.equal(scene.children.length, spawned);
  assert.equal(scene.surveys(), 1);
  // 到点复查：对方还在 → 仍待命，只多一次查看
  scene.tick(STANDBY_RECHECK_MS);
  assert.deepEqual(await scene.controller.ensure(cfg), { ok: false, standby: true });
  assert.equal(scene.children.length, spawned, "待命中不撞端口");
  assert.equal(scene.surveys(), 2);
  // 对方退出 App：端口空了 → 离开待命并建隧道
  scene.remote.listening = false;
  scene.remote.sibling = null;
  scene.tick(STANDBY_RECHECK_MS);
  await scene.controller.ensure(cfg);
  assert.equal(scene.children.length, spawned + 1);
  assert.equal(scene.controller.getState().standby, null);
});

test("对方睡着（会话挂着但打不通）：连续两次才接管，结束对方会话后立刻自己建；单次打不通不动手", async () => {
  const scene = makeScene();
  scene.remote.sibling = { health: "dead", label: "Mac-mini" };
  await scene.failForwardOnce();
  assert.equal(scene.takeovers(), 0, "第一次打不通只记一笔");
  assert.equal(scene.controller.getState().standby.reason, "holder-unresponsive");
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + SIBLING_DEAD_RECHECK_MS);
  const spawned = scene.children.length;
  scene.tick(SIBLING_DEAD_RECHECK_MS);
  await scene.controller.ensure(cfg);
  assert.equal(scene.takeovers(), 1);
  assert.equal(scene.event("tunnel-handover-takeover").reason, "unresponsive");
  assert.equal(scene.children.length, spawned + 1, "接管后同一拍就建隧道");
  assert.deepEqual(scene.sessionEvents.filter((e) => e.type === "handover").map((e) => [e.role, e.reason]), [["standby", "holder-unresponsive"], ["active", "unresponsive"]]);
});

test("观察模式 / 规则关闭：对方打不通也不接管；规则关闭时回到原有的异己占用处置", async () => {
  const observe = makeScene({ autoRepair: { enabled: true, observeOnly: true } });
  observe.remote.sibling = { health: "dead", label: "Mac-mini" };
  await observe.failForwardOnce();
  observe.tick(SIBLING_DEAD_RECHECK_MS);
  await observe.controller.ensure(cfg);
  assert.equal(observe.takeovers(), 0);
  assert.equal(observe.event("tunnel-handover-takeover").mode, "observe");

  const off = makeScene({ autoRepair: { enabled: true, rules: { "sibling-handover": false } } });
  await off.failForwardOnce();
  assert.equal(off.surveys(), 0);
  assert.equal(off.controller.getState().standby, null);
  assert.ok(off.event("tunnel-port-foreign"));
});

test("被接力：读到让位通知 → 计划内交接（不算断线）、进入待命，10 秒内不重连", async () => {
  const scene = makeScene();
  scene.remote.listening = false;
  scene.remote.sibling = null;
  await scene.controller.ensure(cfg); // 冷启动：端口空着，建隧道
  const child = scene.children.at(-1);
  scene.setVerified(true);
  scene.tick(25_000);
  await scene.controller.ensure(cfg); // 存活满 20 秒 → 已建立
  assert.equal(scene.sessionEvents.filter((e) => e.type === "up").length, 1);
  // 另一台 Mac 接管：等待进程写一行让位通知后退出（ssh 以 0 退出）
  child.stdout.emit("data", `${SIBLING_YIELD_TOKEN}\n`);
  scene.setVerified(false);
  child.emit("exit", 0, null);
  const down = scene.sessionEvents.find((e) => e.type === "down");
  assert.equal(down.cause, "handover");
  assert.equal(down.planned, true);
  assert.equal(scene.controller.getState().standby.reason, "yielded");
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + YIELD_RECHECK_MS);
  assert.ok(scene.logs.every((entry) => !entry.message.includes(SIBLING_YIELD_TOKEN)), "让位通知不当成 ssh 输出刷日志");
  assert.ok(scene.event("tunnel-handover-yielded"));
  // 10 秒后：接管方在承载 → 查看、继续待命，不 spawn
  scene.remote.listening = true;
  scene.remote.sibling = { health: "ok", label: "Mac-mini" };
  const spawned = scene.children.length;
  scene.tick(YIELD_RECHECK_MS);
  assert.deepEqual(await scene.controller.ensure(cfg), { ok: false, standby: true });
  assert.equal(scene.children.length, spawned);
  assert.equal(scene.controller.getState().standby.holder.label, "Mac-mini");
});

test("让这台承载（手动）：结束另一台 Mac 的会话，再按受控重启在本机建隧道并验证", async () => {
  const scene = makeScene();
  await scene.failForwardOnce();
  assert.ok(scene.controller.getState().standby);
  scene.setVerified(true);
  const result = await scene.controller.takeOverControlled(cfg, { verifyBudgetMs: 10_000, verifyIntervalMs: 1 });
  assert.equal(scene.takeovers(), 1);
  assert.equal(result.status, "succeeded");
  assert.equal(result.evidence.takenFrom, "Mac-mini");
  assert.equal(result.evidence.sessionsEnded, 1);
  assert.equal(scene.controller.getState().standby, null);
  assert.equal(scene.event("tunnel-handover-takeover").reason, "manual");
});
