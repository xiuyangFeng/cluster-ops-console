// 残留会话回收（换网后服务器端 sshd 残留占着反向端口）与网络切换复核。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRateLimiter } from "../auto-repair-policy.mjs";
import { createNetworkWatcher, listLocalAddresses } from "./network-watch.mjs";
import { loadOrCreateTunnelOwnerId, TUNNEL_OWNER_ID_FILE } from "./owner-id.mjs";
import { createTunnelController, parseLsofLocalAddresses } from "./tunnel-controller.mjs";
import {
  buildStaleSessionReclaimCommand,
  buildTunnelArgs,
  buildTunnelHoldCommand,
  buildTunnelIdentity,
  buildTunnelMarker,
  parseStaleSessionReclaimOutput,
} from "./tunnel-spec.mjs";

const OWNER = "0123456789abcdef";
const MARKER = `codex-tunnel:${OWNER}:7891`;
const cfg = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
const FORWARD_FAILED_LINE = "Warning: remote port forwarding failed for listen port 7891";

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    child.killSignal = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

function makeScene({
  ownerId = OWNER,
  platform = "linux",
  remoteListening = true,
  sshProcesses = [],
  reclaimOutput = "found=1 reclaimed=1",
  autoRepair = null,
  localAddresses = async () => ["10.0.4.21"],
} = {}) {
  const children = [];
  const spawns = [];
  const remoteCalls = [];
  const logs = [];
  const stages = [];
  let probeCalls = 0;
  let clock = 1_000_000;
  // 回收查询的应答，可在用例中途改（模拟"第一次 SSH 没查成，之后查成了"）。
  const reclaim = { code: 0, output: reclaimOutput };
  const rateLimiter = createRateLimiter({ now: () => clock });
  const controller = createTunnelController({
    name: "tunnel.server-01",
    spawnImpl: (_cmd, args) => {
      spawns.push(args);
      const child = makeFakeChild(9000 + children.length);
      children.push(child);
      return child;
    },
    // 第一次是冷启动的远端端口探测（失败才会 spawn）；之后是孤儿判定的远端复核。
    execFileImpl: async () => {
      probeCalls += 1;
      const failed = probeCalls === 1 || !remoteListening;
      return { code: failed ? 1 : 0, stdout: "", stderr: "", timedOut: false };
    },
    listSshProcesses: async () => sshProcesses,
    runRemoteCommandImpl: async (config, command) => {
      remoteCalls.push({ config, command });
      if (reclaim.code !== 0) return { code: reclaim.code, stdout: "", stderr: "Connection closed by remote host", timedOut: false };
      return { code: 0, stdout: `${reclaim.output}\n`, stderr: "", timedOut: false };
    },
    readTcpLocalAddresses: localAddresses,
    // 注册表里查不到受管隧道：远端端口开着也不能算健康，才会走到 spawn（与生产一致）。
    registry: { verifyProcess: async () => ({ verified: false, reason: "test" }) },
    getAutoRepair: () => autoRepair,
    rateLimiter,
    now: () => clock,
    waitForPidExitImpl: async () => true,
    killProcess: () => {},
    emitStage: (partial) => stages.push(partial),
    log: (message, fields) => logs.push({ message, fields: fields || {} }),
    rootDir: "/repo",
    selfPid: 4242,
    deathThreshold: 1,
    spawnGraceMs: 0,
    platform,
    tunnelOwnerId: ownerId,
  });
  async function failForwardOnce() {
    await controller.ensure(cfg);
    const child = children[children.length - 1];
    child.stderr.emit("data", FORWARD_FAILED_LINE);
    child.emit("exit", 255, null);
    await controller.whenOrphanSettled();
    return child;
  }
  return {
    controller, children, spawns, remoteCalls, logs, stages, failForwardOnce,
    tick: (ms) => { clock += ms; },
    setReclaim: (next) => Object.assign(reclaim, next),
    rateLimiter,
    events: (name) => logs.filter((entry) => entry.fields.event === name).map((entry) => entry.fields),
    now: () => clock,
    event: (name) => logs.find((entry) => entry.fields.event === name)?.fields ?? null,
  };
}

// ---- tunnel-spec ----

test("会话标记：只接受十六进制识别码与合法端口，非法值绝不进远端命令", () => {
  assert.equal(buildTunnelMarker(OWNER, 7891), MARKER);
  assert.throws(() => buildTunnelMarker("x; rm -rf /", 7891), /unsafe tunnel owner id/);
  assert.throws(() => buildTunnelMarker(OWNER, "7891; id"), /unsafe/);
  assert.throws(() => buildTunnelHoldCommand("codex-tunnel:$(id):7891"), /unsafe tunnel marker/);
  assert.throws(() => buildStaleSessionReclaimCommand("anything"), /unsafe tunnel marker/);
});

test("隧道参数：有标记时 -T + 远端等待进程（以标记结尾），没有标记保持 -N；签名与身份不受标记影响", () => {
  const marked = buildTunnelArgs({ ...cfg, reclaimMarker: MARKER });
  const plain = buildTunnelArgs(cfg);
  assert.deepEqual(plain.slice(-4), ["-N", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"]);
  assert.deepEqual(marked.slice(-5, -1), ["-T", "-R", "127.0.0.1:7891:127.0.0.1:8888", "myserver"]);
  assert.equal(marked.at(-1), buildTunnelHoldCommand(MARKER));
  assert.ok(marked.at(-1).startsWith("exec sh -c '"));
  assert.ok(marked.at(-1).endsWith(` ${MARKER}`), "进程命令行必须以标记结尾，回收脚本按结尾匹配");
  assert.equal(buildTunnelIdentity({ ...cfg, reclaimMarker: MARKER }), buildTunnelIdentity(cfg), "标记不进身份：升级不触发已有隧道重建");
});

test("回收脚本：脚本自身不含完整标记（不会匹配到自己），也不含单引号（外层 sh -c 可安全包裹）", () => {
  const command = buildStaleSessionReclaimCommand(MARKER);
  assert.ok(command.startsWith("sh -c '") && command.endsWith("'"));
  const inner = command.slice("sh -c '".length, -1);
  assert.ok(!inner.includes("'"));
  assert.ok(!command.includes(MARKER), "命令行里出现完整标记就会把回收会话自己也当成残留会话");
  assert.deepEqual(parseStaleSessionReclaimOutput("found=2 reclaimed=1\n"), { found: 2, reclaimed: 1 });
  assert.equal(parseStaleSessionReclaimOutput("garbage"), null);
});

test("回收脚本真跑（POSIX sh + 假 ps）：只结束以本机标记结尾的会话的 sshd 父进程", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reclaim-"));
  try {
    // 进程表：100 = 残留会话 sshd，101 = 其等待进程（带本机标记）；
    // 200 = 另一台电脑的会话（标记识别码不同）；300 = 普通交互会话。
    const table = [
      ["100", "1", "sshd: kai@notty"],
      ["101", "100", `sh -c while kill -0 "$PPID" 2>/dev/null; do sleep 30; done ${MARKER}`],
      ["200", "1", "sshd: kai@notty"],
      ["201", "200", `sh -c while kill -0 "$PPID" 2>/dev/null; do sleep 30; done codex-tunnel:ffffffffffffffff:7891`],
      ["300", "1", "sshd: kai@pts/0"],
      ["301", "300", "-bash"],
    ];
    const psScript = [
      "#!/bin/sh",
      `table='${table.map((row) => row.join("\t")).join("\n")}'`,
      'case "$*" in',
      '  *"-o pid=,args="*) printf "%s\\n" "$table" | while IFS="$(printf "\\t")" read -r pid ppid args; do echo " $pid $args"; done ;;',
      '  *"-o ppid= -p "*) for a in "$@"; do p="$a"; done; printf "%s\\n" "$table" | while IFS="$(printf "\\t")" read -r pid ppid args; do [ "$pid" = "$p" ] && echo " $ppid"; done ;;',
      '  *"-o args= -p "*) for a in "$@"; do p="$a"; done; printf "%s\\n" "$table" | while IFS="$(printf "\\t")" read -r pid ppid args; do [ "$pid" = "$p" ] && echo "$args"; done ;;',
      "esac",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "ps"), `${psScript}\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "id"), "#!/bin/sh\necho 1006\n", { mode: 0o755 });
    const killsFile = path.join(dir, "kills");
    const command = buildStaleSessionReclaimCommand(MARKER);
    const inner = command.slice("sh -c '".length, -1);
    // kill 是 shell 内建：用函数替身记录目标，而不是真的发信号。
    const out = execFileSync("sh", ["-c", `kill() { echo "$1" >> "${killsFile}"; }; ${inner}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.deepEqual(parseStaleSessionReclaimOutput(out), { found: 1, reclaimed: 1 });
    assert.equal(fs.readFileSync(killsFile, "utf8").trim(), "100", "只结束本机标记会话的 sshd（pid 100）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- tunnel-controller ----

test("控制器：有识别码时新建隧道挂标记；win32 与没有识别码时保持 -N", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  assert.equal(scene.spawns[0].at(-1), buildTunnelHoldCommand(MARKER));

  const win = makeScene({ platform: "win32" });
  await win.controller.ensure(cfg);
  assert.equal(win.spawns[0].at(-1), "myserver");
  assert.ok(win.spawns[0].includes("-N"));

  const noOwner = makeScene({ ownerId: null });
  await noOwner.controller.ensure(cfg);
  assert.ok(noOwner.spawns[0].includes("-N"));
});

test("控制器：远端等待进程起不来（很快以非 255 退出）→ 回落 -N，隧道照常重建", async () => {
  const scene = makeScene({ remoteListening: false });
  await scene.controller.ensure(cfg);
  scene.children[0].emit("exit", 1, null);
  scene.tick(10_000);
  await scene.controller.ensure(cfg);
  assert.ok(scene.event("tunnel-hold-unsupported"));
  assert.ok(scene.spawns[1].includes("-N"), "回落后改用 -N");
  assert.equal(scene.spawns[1].at(-1), "myserver");
});

test("端口被占且没有本机对应 ssh：先回收本机残留会话，成功则短暂等待后重建，不进 5 分钟长退避", async () => {
  const scene = makeScene();
  await scene.failForwardOnce();
  assert.equal(scene.remoteCalls.length, 1);
  assert.equal(scene.remoteCalls[0].command, buildStaleSessionReclaimCommand(MARKER));
  const reclaimed = scene.event("tunnel-stale-session-reclaimed");
  assert.ok(reclaimed);
  assert.equal(reclaimed.reclaimed, 1);
  assert.equal(scene.event("tunnel-port-foreign"), null, "回收成功就不是异己占用");
  const state = scene.controller.getState();
  assert.equal(state.tunnelRetryCount, 0);
  assert.equal(state.tunnelNextRetryTime, scene.now() + 2000);
  assert.ok(scene.stages.some((s) => s.reclaimed === 1));
});

test("远端没有本机标记的会话（found=0）→ 照旧按异己占用长退避 5 分钟", async () => {
  const scene = makeScene({ reclaimOutput: "found=0 reclaimed=0" });
  await scene.failForwardOnce();
  assert.ok(scene.event("tunnel-port-foreign"));
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + 300_000);
});

test("回收查询自己没查成（ssh 255）→ 不按异己占用等 5 分钟，冷却一过再查；查成后照常回收重建", async () => {
  const scene = makeScene();
  scene.setReclaim({ code: 255 });
  await scene.failForwardOnce();
  assert.equal(scene.event("tunnel-port-foreign"), null, "没查成不等于别人占着");
  assert.equal(scene.event("tunnel-port-held-recheck").reason, "ssh code 255");
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + 35_000);

  scene.setReclaim({ code: 0 });
  scene.tick(35_000);
  await scene.failForwardOnce();
  assert.ok(scene.event("tunnel-stale-session-reclaimed"), "第二次查成了，回收并重建");
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + 2000);
});

test("刚查过还在冷却里（断线后的预回收 10 秒前刚跑过）→ 只等冷却，不重复发 SSH、不进长退避", async () => {
  const scene = makeScene();
  // 预回收与端口被占时的回收共用同一个限频桶（reclaim:<serverId>）：这里直接记一笔，等价于它刚跑过。
  scene.rateLimiter.record("reclaim:server-01");
  scene.tick(10_000);
  await scene.failForwardOnce();
  assert.equal(scene.remoteCalls.length, 0, "冷却内不重复发 SSH");
  assert.equal(scene.event("tunnel-port-held-recheck").reason, "cooldown");
  assert.equal(scene.event("tunnel-port-foreign"), null);
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + 35_000);
  scene.tick(35_000);
  await scene.failForwardOnce();
  assert.ok(scene.event("tunnel-stale-session-reclaimed"));
});

test("一直查不成：回收预算（10 分钟 4 次）耗尽后落回 5 分钟长退避，不会无限空打", async () => {
  const scene = makeScene();
  scene.setReclaim({ code: 255 });
  for (let i = 0; i < 4; i += 1) {
    await scene.failForwardOnce();
    scene.tick(35_000);
  }
  assert.equal(scene.remoteCalls.length, 4);
  assert.equal(scene.events("tunnel-port-held-recheck").length, 4);
  assert.equal(scene.event("tunnel-port-foreign"), null);
  await scene.failForwardOnce();
  assert.equal(scene.remoteCalls.length, 4, "预算耗尽后不再发 SSH");
  assert.ok(scene.event("tunnel-port-foreign"));
  assert.equal(scene.controller.getState().tunnelNextRetryTime, scene.now() + 300_000);
});

test("本机还有挂着同一标记的 ssh（活会话只是没认出来）→ 绝不回收", async () => {
  const scene = makeScene({ sshProcesses: [{ pid: 777, command: `ssh -T -R 127.0.0.1:7891:127.0.0.1:1 other ${MARKER}` }] });
  await scene.failForwardOnce();
  assert.equal(scene.remoteCalls.length, 0);
  assert.ok(scene.event("tunnel-port-foreign"));
});

test("规则可单独关闭；观察模式只记日志不执行", async () => {
  const off = makeScene({ autoRepair: { enabled: true, rules: { "stale-session-reclaim": false } } });
  await off.failForwardOnce();
  // 回收关着时仍会看一眼是不是同账号另一台 Mac（v2.88 接力，只读），但绝不发回收命令。
  assert.equal(off.remoteCalls.filter((c) => !c.command.includes("HEALTH=")).length, 0);
  assert.ok(off.event("tunnel-port-foreign"));

  const observe = makeScene({ autoRepair: { enabled: true, observeOnly: true } });
  await observe.failForwardOnce();
  assert.equal(observe.remoteCalls.filter((c) => !c.command.includes("HEALTH=")).length, 0);
  assert.equal(observe.event("tunnel-stale-session-reclaim")?.mode, "observe");
});

test("网络切换：隧道连接绑在已消失的地址上 → 立即重建；否则只清退避", async () => {
  const scene = makeScene();
  await scene.controller.ensure(cfg);
  const child = scene.children[0];
  const result = await scene.controller.handleNetworkChange({ removed: ["10.0.4.21"], added: ["10.0.4.22"] });
  assert.equal(result.action, "restarted");
  assert.equal(child.killed, true);
  assert.ok(scene.event("tunnel-network-changed"));

  const unaffected = makeScene({ localAddresses: async () => ["192.168.1.5"] });
  await unaffected.controller.ensure(cfg);
  const kept = await unaffected.controller.handleNetworkChange({ removed: ["10.0.4.21"], added: [] });
  assert.equal(kept.action, "backoff-reset");
  assert.equal(unaffected.children[0].killed, false);

  const noLsof = makeScene({ localAddresses: async () => null });
  await noLsof.controller.ensure(cfg);
  assert.equal((await noLsof.controller.handleNetworkChange({ removed: ["10.0.4.21"] })).action, "backoff-reset");
  assert.equal(noLsof.children[0].killed, false, "查不到连接地址时不猜，交给 ServerAlive 兜底");
});

test("网络切换清掉限频：此前刚判过异己占用，换网后立刻允许再回收一次", async () => {
  const scene = makeScene({ reclaimOutput: "found=0 reclaimed=0" });
  // 回收查过、不是本机的会话后还会看一眼同账号另一台 Mac（v2.88，命令里带 HEALTH=）：这里只数回收。
  const reclaimCalls = () => scene.remoteCalls.filter((c) => !c.command.includes("HEALTH=")).length;
  await scene.failForwardOnce();
  assert.equal(reclaimCalls(), 1);
  scene.tick(1000);
  await scene.controller.handleNetworkChange({ removed: [], added: ["10.0.0.9"] });
  assert.equal(scene.controller.getState().tunnelNextRetryTime, 0, "换网后清零退避，本拍立即复核");
  await scene.failForwardOnce();
  assert.equal(reclaimCalls(), 2, "限频桶已重置，换网后再次尝试回收");
});

test("lsof -Fn 解析：取本端地址，兼容 IPv6 方括号", () => {
  assert.deepEqual(parseLsofLocalAddresses("p123\nf5\nn10.0.4.21:51606->203.0.113.10:22\n"), ["10.0.4.21"]);
  assert.deepEqual(parseLsofLocalAddresses("n[2001:db8::5]:6000->[2001:db8::1]:22\nnlisten:*\n"), ["2001:db8::5"]);
});

// ---- network-watch / owner-id ----

test("网络地址：忽略回环与 IPv6 链路本地；首拍只记基线，之后报告增删", () => {
  let interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    en0: [
      { address: "10.0.4.21", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
  };
  assert.deepEqual(listLocalAddresses(interfaces), ["10.0.4.21"]);
  const watcher = createNetworkWatcher({ getInterfaces: () => interfaces });
  assert.equal(watcher.check(), null, "首拍只记基线");
  assert.equal(watcher.check(), null, "没变化");
  interfaces = { en0: [{ address: "10.0.4.22", family: "IPv4", internal: false }] };
  assert.deepEqual(watcher.check(), { removed: ["10.0.4.21"], added: ["10.0.4.22"], current: ["10.0.4.22"] });
  assert.equal(watcher.check(), null);
});

test("本机识别码：首次生成 16 位十六进制并以 0600 落盘，之后沿用", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-"));
  try {
    const first = loadOrCreateTunnelOwnerId(dir);
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.equal(loadOrCreateTunnelOwnerId(dir), first);
    assert.equal(fs.statSync(path.join(dir, TUNNEL_OWNER_ID_FILE)).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(dir, TUNNEL_OWNER_ID_FILE), "not-hex\n");
    assert.match(loadOrCreateTunnelOwnerId(dir, { random: () => "aaaaaaaaaaaaaaaa" }), /^a{16}$/, "坏内容重新生成");
    assert.equal(loadOrCreateTunnelOwnerId(null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("心跳容忍：团队集群 40s（20×2），个人公网服务器 100s（20×5）；心跳不进隧道身份，改动不重启现有隧道", () => {
  const base = { host: "myserver", remotePort: 7891, localPort: 8888 };
  const optionValue = (args, key) => args.find((a) => a.startsWith(`${key}=`))?.split("=")[1];
  const team = buildTunnelArgs({ ...base, source: "team" });
  assert.equal(optionValue(team, "ServerAliveInterval"), "20");
  assert.equal(optionValue(team, "ServerAliveCountMax"), "2");
  assert.equal(optionValue(buildTunnelArgs(base), "ServerAliveCountMax"), "2", "缺省按团队处理");
  const personal = buildTunnelArgs({ ...base, host: "vpn-aliyun", remotePort: 7894, source: "personal" });
  assert.equal(optionValue(personal, "ServerAliveCountMax"), "5");
  assert.equal(buildTunnelIdentity({ ...base, source: "team" }), buildTunnelIdentity({ ...base, source: "personal" }));
});
