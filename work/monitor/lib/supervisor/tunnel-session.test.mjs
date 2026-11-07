// 隧道会话账本与退避（B1/B2/B3）：握手中的进程不算健康、已建立才清退避、断线记账、
// 断线后先回收残留会话再重连。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRateLimiter } from "../auto-repair-policy.mjs";
import { classifyTunnelDrop, createTunnelController, TUNNEL_ESTABLISHED_MS, TUNNEL_MAX_BACKOFF_S } from "./tunnel-controller.mjs";
import { createTunnelLedgerWriter, sanitizeLedgerEvent, TUNNEL_LEDGER_FILENAME } from "./tunnel-ledger.mjs";

const OWNER = "0123456789abcdef";
const cfg = { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, localPort: 8888 };

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

// 注册表按"当前存活的受管 pid"作答：spawn 后即 verified（与生产一致：进程活着就能校验过），
// 退出后不再 verified。远端端口探测恒为关闭，冷路径一律 spawn。
function makeScene({ ownerId = OWNER, reclaimOutput = "found=1 reclaimed=1" } = {}) {
  const children = [];
  const sessions = [];
  const logs = [];
  const remoteCalls = [];
  let alivePid = null;
  let clock = 1_000_000;
  const controller = createTunnelController({
    name: "tunnel.server-aliyun",
    spawnImpl: () => {
      const child = makeFakeChild(7000 + children.length);
      children.push(child);
      alivePid = child.pid;
      child.on("exit", () => {
        if (alivePid === child.pid) alivePid = null;
      });
      return child;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    listSshProcesses: async () => [],
    runRemoteCommandImpl: async (config, command) => {
      remoteCalls.push({ config, command, at: clock });
      return { code: 0, stdout: `${reclaimOutput}\n`, stderr: "", timedOut: false };
    },
    registry: {
      verifyProcess: async () => (alivePid
        ? { verified: true, meta: { pid: alivePid, name: "tunnel.server-aliyun", rootDir: "/repo" } }
        : { verified: false, reason: "test" }),
    },
    rateLimiter: createRateLimiter({ now: () => clock }),
    now: () => clock,
    waitForPidExitImpl: async () => true,
    killProcess: () => {},
    log: (message, fields) => logs.push({ message, fields: fields || {} }),
    rootDir: "/repo",
    deathThreshold: 1,
    spawnGraceMs: 0,
    platform: "linux",
    tunnelOwnerId: ownerId,
    onSessionEvent: (event) => sessions.push(event),
    sleep: async () => {},
  });
  const last = () => children[children.length - 1];
  return {
    controller, children, sessions, logs, remoteCalls, last,
    tick: (ms) => { clock += ms; },
    now: () => clock,
    // 让当前 ssh 以给定 stderr 异常退出（255）。
    async crash(stderr = "") {
      const child = last();
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("exit", 255, null);
      await controller.whenOrphanSettled();
    },
  };
}

test("B1：握手中（存活不满 20s）的自家 ssh 不算健康，不清退避也不记会话建立", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg); // 冷启动 spawn
  scene.tick(5000);
  const result = await scene.controller.ensure(cfg);
  assert.equal(result.connecting, true);
  assert.equal(scene.sessions.length, 0);
});

test("B1：连不上时退避逐次翻倍（不再被握手中的进程清零），上限 120s", async () => {
  const scene = makeScene();
  const backoffs = [];
  for (let i = 0; i < 8; i += 1) {
    const before = scene.children.length;
    await scene.controller.ensure(cfg);
    assert.equal(scene.children.length, before + 1, `第 ${i + 1} 次应当 spawn`);
    scene.tick(5000);
    await scene.controller.ensure(cfg); // 握手中：不清退避
    scene.tick(5000);
    await scene.crash("ssh: connect to host 8.8.8.8 port 22: Operation timed out");
    const state = scene.controller.getState();
    backoffs.push(Math.round((state.tunnelNextRetryTime - scene.now()) / 1000));
    // 生产里主循环每 5s 调一次 ensure（退避期内直接跳过）；按节拍推进，避免被当成睡眠唤醒。
    while (scene.now() < state.tunnelNextRetryTime) {
      scene.tick(5000);
      if (scene.now() < state.tunnelNextRetryTime) await scene.controller.ensure(cfg);
    }
  }
  assert.deepEqual(backoffs, [5, 10, 20, 40, 80, TUNNEL_MAX_BACKOFF_S, TUNNEL_MAX_BACKOFF_S, TUNNEL_MAX_BACKOFF_S]);
  assert.equal(scene.logs.filter((entry) => entry.fields.event === "tunnel-unreachable").length, 1, "不可达只提示一次");
});

test("会话建立：存活满 20s 记 up（含断线时长与尝试次数），并清零退避", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  const result = await scene.controller.ensure(cfg);
  assert.equal(result.ok, true);
  assert.equal(scene.sessions.length, 1);
  assert.equal(scene.sessions[0].type, "up");
  assert.equal(scene.sessions[0].serverId, "server-aliyun");
  assert.equal(scene.sessions[0].downMs, null, "首次建立没有断线时长");
  assert.equal(scene.controller.getState().tunnelRetryCount, 0);
  await scene.controller.ensure(cfg);
  assert.equal(scene.sessions.length, 1, "同一会话只记一次 up");
});

test("异常断线：记 down（按 stderr 归因），重连前先回收残留会话，恢复后 up 带断线时长", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  scene.tick(3_600_000);
  await scene.crash("Timeout, server 198.51.100.41 not responding.");
  const down = scene.sessions.at(-1);
  assert.equal(down.type, "down");
  assert.equal(down.cause, "keepalive-timeout");
  assert.equal(down.planned, false);
  assert.equal(down.uptimeMs, TUNNEL_ESTABLISHED_MS + 3_600_000, "在线时长从 spawn 算起");
  assert.match(down.detail, /not responding/);
  assert.equal(scene.controller.getState().pendingReclaim, true);

  scene.tick(1000);
  await scene.controller.ensure(cfg);
  assert.equal(scene.remoteCalls.length, 1, "spawn 之前先跑一次残留会话回收");
  assert.match(scene.remoteCalls[0].command, /codex-tunne/);
  assert.equal(scene.children.length, 2);
  assert.equal(scene.controller.getState().pendingReclaim, false);

  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  const up = scene.sessions.at(-1);
  assert.equal(up.type, "up");
  assert.equal(up.attempts, 1);
  assert.equal(up.downMs, 1000, "断线时长 = 断开 → 新会话 spawn");
});

test("握手阶段的快速失败不记 down，也不触发预回收", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(3000);
  await scene.crash("ssh: connect to host 8.8.8.8 port 22: Operation timed out");
  assert.equal(scene.sessions.length, 0);
  assert.equal(scene.controller.getState().pendingReclaim, false);
});

test("受控重启是计划内停止：down planned，之后 up 不带断线时长", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  await scene.controller.restartControlled(cfg, { verifyBudgetMs: 0 });
  const down = scene.sessions.find((event) => event.type === "down");
  assert.equal(down.planned, true);
  assert.equal(down.cause, "restart");
  assert.equal(scene.controller.getState().pendingReclaim, false);
  assert.equal(scene.controller.getState().downSince, null);
});

test("停止 / 重启整个通道（runShutdown 直接 child.kill）：ssh 捕获 SIGTERM 以 255 退出，仍记计划内", async () => {
  // 生产账本（2026-10-14 15:47:37 / 15:48:41）：自动修复重启整个通道时两条隧道都记成
  // code 255、planned:false、cause unknown 的异常断线——ssh 收到 SIGTERM 自己收尾，exit 的 signal 为 null。
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  const child = scene.last();
  child.kill = () => {
    child.killed = true; // Node 在 child.kill() 成功发出信号时置位
    queueMicrotask(() => child.emit("exit", 255, null));
    return true;
  };
  child.kill("SIGTERM"); // runShutdown 的做法：不经控制器、不带 stopReason
  await new Promise((resolve) => setImmediate(resolve));
  const down = scene.sessions.at(-1);
  assert.equal(down.type, "down");
  assert.equal(down.planned, true, "我们自己停的不算断线、不计入可用率");
  assert.equal(down.cause, "stopped");
  assert.equal(down.sleep, false);
  assert.equal(scene.controller.getState().pendingReclaim, false, "计划内停止不预约残留会话回收");
});

test("没被我们 kill 的 255 退出仍是异常断线（口径只放宽到我们自己发的停止）", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  await scene.crash("");
  const down = scene.sessions.at(-1);
  assert.equal(down.planned, false);
  assert.equal(down.cause, "unknown");
});

test("网络切换导致的重建：down 归因 network-change 并带 networkChange 标记", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  scene.tick(TUNNEL_ESTABLISHED_MS);
  await scene.controller.ensure(cfg);
  // 没有 lsof 结果时只清退避；这里直接模拟心跳超时退出，验证 networkChange 归因。
  await scene.controller.handleNetworkChange({ removed: ["10.38.124.152"], added: [] });
  scene.tick(30_000);
  await scene.crash("Timeout, server 198.51.100.41 not responding.");
  const down = scene.sessions.at(-1);
  assert.equal(down.type, "down");
  assert.equal(down.networkChange, true);
});

test("classifyTunnelDrop：按 ssh 最后一行 stderr 归因", () => {
  assert.equal(classifyTunnelDrop("Timeout, server 1.2.3.4 not responding."), "keepalive-timeout");
  assert.equal(classifyTunnelDrop("Connection to 1.2.3.4 closed by remote host."), "remote-closed");
  assert.equal(classifyTunnelDrop("client_loop: send disconnect: Broken pipe"), "broken-pipe");
  assert.equal(classifyTunnelDrop("Connection reset by peer"), "reset");
  assert.equal(classifyTunnelDrop("Connection closed by 1.2.3.4 port 22"), "closed");
  assert.equal(classifyTunnelDrop(""), "unknown");
});

test("账本写入：只落白名单字段并封顶长度，超过上限轮转为 .1", async () => {
  const clean = sanitizeLedgerEvent({ type: "down", at: 5, serverId: "s", detail: "x".repeat(500), evil: { a: 1 }, planned: false });
  assert.equal(clean.detail.length, 200);
  assert.equal("evil" in clean, false);
  assert.equal(sanitizeLedgerEvent({ type: "bogus", at: 1 }), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  try {
    const writer = createTunnelLedgerWriter({ runtimeDir: dir, maxBytes: 100 });
    for (let i = 0; i < 6; i += 1) writer.append({ type: "alive", at: i });
    await writer.flush();
    const file = path.join(dir, TUNNEL_LEDGER_FILENAME);
    assert.ok(fs.existsSync(`${file}.1`), "超限后轮转");
    const lines = [fs.readFileSync(`${file}.1`, "utf8"), fs.readFileSync(file, "utf8")].join("").trim().split("\n");
    assert.ok(lines.every((line) => JSON.parse(line).type === "alive"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
