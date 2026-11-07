// W5：SSH 失败归因从 supervisor 透出到 /api/status（tunnelFailures）的链路测试。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { reduceBridgeStage, shouldLogBridgeSnapshot } from "./lib/supervisor/bridge-stage.mjs";
import { createTunnelController } from "./lib/supervisor/tunnel-controller.mjs";
import { tunnelRecordName } from "./monitor-core.mjs";
import { applyTunnelFailureSnapshot, pruneTunnelFailures } from "./server/bridge-ingest.mjs";

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

const cfg = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };

test("sshFailure: 失败归因粘性沿用、恢复即清空为 null（合并语义不残留）", () => {
  let snapshot = reduceBridgeStage(undefined, { stage: "ssh-tunnel", ok: false, durationMs: 10, sshFailure: { code: "auth", nextAction: "重跑 setup", at: 5 } }, 1000);
  assert.deepEqual(snapshot.sshFailure, { code: "auth", nextAction: "重跑 setup", at: 5 });
  snapshot = reduceBridgeStage(snapshot, { stage: "ssh-tunnel", ok: false, durationMs: 0, backoffUntil: 9000 }, 2000);
  assert.equal(snapshot.sshFailure.code, "auth", "退避期不带 sshFailure 的快照必须沿用");
  snapshot = reduceBridgeStage(snapshot, { stage: "ssh-tunnel", ok: true, durationMs: 1 }, 3000);
  assert.equal(snapshot.sshFailure, null, "恢复后显式 null，state-store 合并时才会覆盖旧值");
  const clean = reduceBridgeStage(undefined, { stage: "ssh-tunnel", ok: true, durationMs: 1 }, 1000);
  assert.equal("sshFailure" in clean, false, "从未失败过的快照不出现该字段（旧协议不变）");
  assert.equal(reduceBridgeStage(undefined, { stage: "x", ok: false, sshFailure: { nope: 1 } }).sshFailure, undefined);
});

test("sshFailure: 归因变化触发快照日志（monitor 只从日志摄取快照）", () => {
  const before = reduceBridgeStage(undefined, { stage: "ssh-tunnel", ok: false }, 1000);
  const after = reduceBridgeStage(before, { stage: "ssh-tunnel", ok: false, sshFailure: { code: "hostkey", nextAction: "x" } }, 1001);
  // 连续失败计数也变了，这里单独构造只差 sshFailure 的两份快照。
  assert.equal(shouldLogBridgeSnapshot({ snapshot: { ...after, sshFailure: null }, loggedAt: 1000 }, after, 1001), true);
});

test("sshFailure: stderr 归因随快速失败快照上报，并出现在 getState", async () => {
  const children = [];
  const emitted = [];
  let clock = 1000;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(7100 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    log: () => {},
    spawnGraceMs: 0,
    emitStage: (event) => emitted.push(event),
  });
  await controller.ensure(cfg);
  children[0].stderr.emit("data", "user@myserver: Permission denied (publickey).");
  assert.equal(controller.getState().lastSshFailure.code, "auth");
  clock += 500;
  children[0].emit("exit", 255, null);
  const failure = emitted.find((e) => e.ok === false && e.sshFailure);
  assert.ok(failure, "快速失败快照必须带 sshFailure");
  assert.equal(failure.sshFailure.code, "auth");
  assert.match(failure.sshFailure.nextAction, /setup/);
});

test("applyTunnelFailureSnapshot: 按 serverId 记录/清除失败归因", () => {
  const map = new Map();
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "local-proxy", ok: false, sshFailure: { code: "auth" } }), false);
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", ok: false, sshFailure: { code: "auth", nextAction: "n", at: 1 } }), false, "无 serverId 不归类");
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", serverId: "s1", ok: false, sshFailure: { code: "timeout", nextAction: "n", at: 2 } }), true);
  assert.deepEqual(map.get("s1"), { code: "timeout", nextAction: "n", at: 2 });
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", serverId: "s1", ok: true, sshFailure: null }), true);
  assert.equal(map.has("s1"), false);
});

test("修复轮 reduceBridgeStage: 新失败显式带 sshFailure:null 时清掉旧归因，不带该键才沿用", () => {
  let snap = reduceBridgeStage(undefined, { stage: "ssh-tunnel", ok: false, sshFailure: { code: "auth", nextAction: "x" } }, 1000);
  snap = reduceBridgeStage(snap, { stage: "ssh-tunnel", ok: false, backoffUntil: 5000 }, 2000);
  assert.equal(snap.sshFailure.code, "auth", "退避期（不带键）沿用");
  snap = reduceBridgeStage(snap, { stage: "ssh-tunnel", ok: false, sshFailure: null, fastFailureDelta: 1 }, 3000);
  assert.equal(snap.sshFailure, null, "新一次无法归类的失败 → 显式 null");
  snap = reduceBridgeStage(snap, { stage: "ssh-tunnel", ok: false, sshFailure: { code: "timeout", nextAction: "y" } }, 4000);
  assert.equal(snap.sshFailure.code, "timeout", "新归因整条替换");
});

test("修复轮 supervisor: 归因按每次尝试计算——上一次 auth 不粘到这次无法归类的快速失败上", async () => {
  const children = [];
  const emitted = [];
  let clock = 1000;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(7200 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    log: () => {},
    spawnGraceMs: 0,
    emitStage: (event) => emitted.push(event),
  });
  await controller.ensure(cfg);
  children[0].stderr.emit("data", "user@myserver: Permission denied (publickey).");
  clock += 500;
  children[0].emit("exit", 255, null);
  assert.equal(emitted.at(-1).sshFailure.code, "auth");
  // 退避结束后第二次尝试：stderr 无可归类内容就断了
  clock += 120000;
  await controller.ensure(cfg);
  assert.equal(children.length, 2, "退避结束后应重新 spawn");
  children[1].stderr.emit("data", "some unrelated noise line");
  clock += 500;
  children[1].emit("exit", 255, null);
  const last = emitted.filter((e) => e.fastFailureDelta === 1).at(-1);
  assert.ok("sshFailure" in last && last.sshFailure === null, `期望显式 null，实际 ${JSON.stringify(last)}`);
  assert.equal(controller.getState().lastSshFailure, null);
});

test("修复轮 applyTunnelFailureSnapshot: 新失败快照整条替换，归因无效即清除", () => {
  const map = new Map([["s1", { code: "auth", nextAction: "n", at: 1 }]]);
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", serverId: "s1", ok: false, sshFailure: { code: "" } }), true);
  assert.equal(map.has("s1"), false);
  map.set("s1", { code: "auth", nextAction: "n", at: 1 });
  // 完全不带 sshFailure 字段的旧协议快照不动
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", serverId: "s1", ok: false }), false);
  assert.equal(map.get("s1").code, "auth");
  assert.equal(applyTunnelFailureSnapshot(map, { stage: "ssh-tunnel", serverId: "s1", ok: false, sshFailure: { code: "timeout", nextAction: "t", at: 3 } }), true);
  assert.deepEqual(map.get("s1"), { code: "timeout", nextAction: "t", at: 3 });
});

test("修复轮 pruneTunnelFailures: 删除/禁用的服务器归因被修剪", () => {
  const map = new Map([["a", { code: "auth" }], ["b", { code: "timeout" }], ["c", { code: "dns" }]]);
  assert.equal(pruneTunnelFailures(map, ["a", "c"]), true);
  assert.deepEqual([...map.keys()], ["a", "c"]);
  assert.equal(pruneTunnelFailures(map, ["a", "c"]), false);
  assert.equal(pruneTunnelFailures(map, []), true);
  assert.equal(map.size, 0);
  assert.equal(pruneTunnelFailures(null, []), false);
});
