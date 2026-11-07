// 服务直达的转发管理器（纯函数那部分——ssh 参数、保留端口、命令行特征——的用例在 forward-spec.test.mjs）。三部分：
//   1) 本机端口与登记文件名这两个贴着系统的小件；
//   2) 管理器逻辑（假子进程，不起任何真实进程）：就绪判定、上限、到点收回、关停、失败归因；
//   3) 真实子进程（假 ssh）：登记与真实 ps 校验对得上、孤儿清理、关停确实结束进程。
// 任何用例都不会执行真正的 ssh：管理器的 spawn / exec 一律注入，sshCommand 另指向一个不存在的路径兜底。
// 假 ssh 是一个 node 脚本，用 process.execPath 直接跑（不新写可执行文件：macOS 对新写出的可执行文件第一次执行
// 要做安全评估，机器忙时能卡上几十秒）。本机端口全部由系统分配（:0），不占任何固定端口。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { execFileWithTimeout } from "../exec.mjs";
import { createProcessRegistry, isPidAlive } from "../process-registry.mjs";
import { buildForwardBase, buildForwardSshArgs, collectReservedPorts, forwardSignature } from "./forward-spec.mjs";
import { canConnectLocal, createServiceForwards, FORWARD_LIMIT, FORWARD_TTL_MS, listForwardRecordNames, pickFreeLocalPort } from "./forwards.mjs";

const SERVER = { id: "s1", name: "主集群", host: "fixture.invalid" };
// 探针的钉扎参数长这样：复用三件套 + 主机密钥 + 端口 + 身份 + 主机（最后一位）。
const PINNED = [
  "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/cm-1a2b3c4d-%C", "-o", "ControlPersist=5m",
  "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
  "-p", "2222", "-i", "/tmp/fixture keys/id_ed25519_codextunnel", "-o", "IdentitiesOnly=yes", "-l", "tester", "fixture.invalid",
];
const CONFIG = {
  activeServerId: "s1",
  storageBudgetBytes: 52428800,
  egress: { mode: "manual", url: "http://127.0.0.1:7890" },
  proxyAllowedTargets: ["relay.example.com:8443"],
  portOverrides: { s1: { remotePort: 7893, localPort: 8893 } },
  servers: [
    { id: "s1", host: "fixture.invalid", sshPort: 2222, remotePort: 7891, localPort: 8888 },
    { id: "p1", host: "other.invalid", remotePort: "7894", localPort: 8894, source: "personal" },
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 等一个条件成立。时限给得很宽（机器卡顿时子进程起得慢），正常几十毫秒内就满足。
async function until(predicate, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`等不到：${label}`);
    await sleep(10);
  }
}
const pendingStill = async (promise, ms = 60) => (await Promise.race([promise.then(() => "settled", () => "settled"), sleep(ms).then(() => "pending")])) === "pending";

// ---------------------------------------------------------------------------
// 1) 本机端口、登记文件名
// ---------------------------------------------------------------------------

test("挑本机端口：系统给的端口落在保留集合里就重挑；总挑不到则报错；默认实现拿到的是真能绑的空闲端口", async () => {
  const sequence = [8888, 7891, 800, 51234];
  const port = await pickFreeLocalPort({ reserved: new Set([8888, 7891]), allocate: async () => sequence.shift() });
  assert.equal(port, 51234, "保留端口与 1024 以下的都跳过");
  await assert.rejects(pickFreeLocalPort({ reserved: new Set([8888]), attempts: 3, allocate: async () => 8888 }), /没有挑到/);
  const real = await pickFreeLocalPort({ reserved: collectReservedPorts(CONFIG) });
  assert.ok(Number.isInteger(real) && real >= 1024 && !collectReservedPorts(CONFIG).has(real));
  assert.equal(await canConnectLocal(real), false, "挑完就放开，没人在听");
});

test("登记文件名：只认 service-forward.<服务器>.<端口>.pid.json", () => {
  const files = ["service-forward.s1.8814.pid.json", "service-forward.server-01.40161.pid.json", "tunnel.s1.pid.json", "service-forward.pid.json", "service-forward.s1.abc.pid.json", "service-forward.s1.8814.json", "channel-supervisor.pid.json"];
  assert.deepEqual(listForwardRecordNames("/x", () => files), ["service-forward.s1.8814", "service-forward.server-01.40161"]);
  assert.deepEqual(listForwardRecordNames("/x", () => { throw new Error("ENOENT"); }), []);
});

// ---------------------------------------------------------------------------
// 2) 管理器逻辑（假子进程）
// ---------------------------------------------------------------------------

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stderr = new EventEmitter();
  child.signals = [];
  child.exited = false;
  child.ignoreTerm = false;
  child.exit = (code, signalName = null) => {
    if (child.exited) return;
    child.exited = true;
    child.emit("exit", code, signalName);
  };
  child.kill = (signalName = "SIGTERM") => {
    child.signals.push(signalName);
    if (child.exited || (child.ignoreTerm && signalName === "SIGTERM")) return true;
    setImmediate(() => child.exit(null, signalName));
    return true;
  };
  child.say = (text) => child.stderr.emit("data", Buffer.from(text));
  child.auth = () => child.say('Authenticated to fixture.invalid ([192.0.2.10]:22) using "publickey".\n');
  return child;
}

// 默认：起来的假 ssh 立刻「认证通过」，本机端口「连得上」——即一路顺利。各用例按需改 onSpawn / probe。
function harness(t, options = {}) {
  const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "svc-forward-unit-"));
  t.after(() => rmSync(runtimeDir, { recursive: true, force: true }));
  const state = { children: [], execCalls: [], logs: [], timers: [], picked: [], slots: { acquired: [], released: 0 }, clock: 1_800_000_000_000, nextPort: 51000 };
  const registry = options.registry ?? createProcessRegistry({ runtimeDir });
  const forwards = createServiceForwards({
    registry,
    runtimeDir,
    cwd: runtimeDir,
    sshArgsFor: options.sshArgsFor ?? (() => PINNED),
    getConfig: () => CONFIG,
    monitorPort: 18877,
    sshCommand: "/nonexistent/not-the-real-ssh",
    spawnImpl: (command, args, spawnOptions) => {
      const child = fakeChild(4_000_000 + state.children.length);
      Object.assign(child, { command, args, spawnOptions });
      state.children.push(child);
      (options.onSpawn ?? ((c) => setImmediate(() => c.auth())))(child, state.children.length);
      return child;
    },
    execImpl: async (command, args, execOptions) => {
      state.execCalls.push({ command, args, execOptions });
      return options.preflight ? options.preflight(args) : { code: 0, stdout: "user tester\nhostname fixture.invalid\n", stderr: "" };
    },
    pickPort: async ({ reserved }) => {
      state.picked.push(new Set(reserved));
      state.nextPort += 1;
      return state.nextPort;
    },
    probePort: async (port) => (options.probe ? options.probe(port, state) : true),
    log: (message, fields) => state.logs.push([message, fields?.level || "info"]),
    now: () => state.clock,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      state.timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    // 不靠真实时间碰运气：「一直没看到认证」的回退与整体超时默认都放得很远，要测它们的用例自己调小。
    timings: { pollMs: 5, settleMs: 10, noAuthLineMs: 600_000, readyMs: 600_000, killGraceMs: 25, disposeGraceMs: 40, disposeKillMs: 40, ...options.timings },
    ...(options.limit ? { limit: options.limit } : {}),
  });
  const acquireSshSlot = async (slotOptions) => {
    state.slots.acquired.push(slotOptions);
    return () => { state.slots.released += 1; };
  };
  const open = (port, extra = {}) => forwards.open({ server: SERVER, config: CONFIG, remotePort: port, acquireSshSlot, ...extra });
  const recordFiles = () => readdirSync(runtimeDir).filter((file) => file.endsWith(".pid.json")).sort();
  return { forwards, registry, runtimeDir, state, open, recordFiles, acquireSshSlot };
}

test("打开：先 ssh -G 预检，再起一条 -N -L；认证通过、稍等、端口连得上才算建好；登记进注册表并排上 2 小时收回", async (t) => {
  const h = harness(t);
  const view = await h.open(8814);
  assert.deepEqual(view, { serverId: "s1", port: 8814, localPort: 51001, url: "http://127.0.0.1:51001/", startedAt: h.state.clock, expiresAt: h.state.clock + FORWARD_TTL_MS });
  assert.equal(h.state.execCalls.length, 1);
  assert.equal(h.state.execCalls[0].command, "/nonexistent/not-the-real-ssh");
  assert.deepEqual([h.state.execCalls[0].args[0], h.state.execCalls[0].args.at(-1)], ["-G", "fixture.invalid"]);
  assert.equal(h.state.execCalls[0].args.includes("-L") || h.state.execCalls[0].args.includes("-N"), false, "预检不带转发、不连接");
  const [child] = h.state.children;
  assert.deepEqual([child.args[0], ...child.args.slice(-3)], ["-N", "-L", "127.0.0.1:51001:127.0.0.1:8814", "fixture.invalid"]);
  assert.deepEqual(child.spawnOptions.stdio, ["ignore", "ignore", "pipe"]);
  assert.equal(child.spawnOptions.windowsHide, true);
  assert.equal("env" in child.spawnOptions, false, "不改环境变量");
  // 挑端口时带着保留集合：固定三项 + 配置里的端口 + 监控服务自己的端口。
  for (const port of [8877, 8888, 1455, 7891, 2222, 7893, 8893, 18877]) assert.ok(h.state.picked[0].has(port), String(port));
  // 进程注册表：记了 pid、完整参数与命令行特征；没有 configIdentity（特征逐段包含，见 forwards.mjs 文件头）。
  assert.deepEqual(h.recordFiles(), ["service-forward.s1.8814.pid.json"]);
  const meta = h.registry.readMeta("service-forward.s1.8814");
  assert.deepEqual([meta.pid, meta.signature, meta.parentPid, meta.args.join(" ") === child.args.join(" "), "configIdentity" in meta], [child.pid, "-N ExitOnForwardFailure=yes -L 127.0.0.1:51001:127.0.0.1:8814 fixture.invalid", process.pid, true, false]);
  if (process.platform !== "win32") assert.equal(statSync(path.join(h.runtimeDir, "service-forward.s1.8814.pid.json")).mode & 0o777, 0o600);
  // 到点收回的定时器 + 建连期间才占 SSH 槽位。
  assert.deepEqual(h.state.timers.map((timer) => [timer.ms, timer.cleared]), [[FORWARD_TTL_MS, false]]);
  assert.deepEqual([h.state.slots.acquired, h.state.slots.released], [[{ hostKey: "fixture.invalid" }], 1]);
  assert.deepEqual(h.forwards.list("s1"), [view]);
  assert.deepEqual(h.forwards.list("other"), []);
  assert.deepEqual(h.state.logs.at(-1), [`service forward s1:8814 -> 127.0.0.1:51001 opened (pid ${child.pid})`, "info"]);
  assert.equal(child.signals.length, 0);
});

test("就绪判定：本机端口连得上、但 ssh 还没认证 → 不算建好（那是别的程序占着这个端口）；认证后才返回", async (t) => {
  const h = harness(t, { onSpawn: () => {}, probe: () => true });
  const opening = h.open(8814);
  assert.equal(await pendingStill(opening), true, "端口连得上也不算数");
  assert.deepEqual(h.forwards.list(), [], "没建好的不在列表里");
  h.state.children[0].auth();
  assert.equal((await opening).localPort, 51001);
});

test("就绪判定：认证之后本机端口被别人占着 → ssh 自己退出（ExitOnForwardFailure），换一个端口重来", async (t) => {
  const h = harness(t, {
    onSpawn: (child, n) => setImmediate(() => {
      child.auth();
      if (n === 1) {
        child.say("bind [127.0.0.1]:51001: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 51001\nCould not request local forwarding.\n");
        child.exit(255);
      }
    }),
  });
  const view = await h.open(8814);
  assert.equal(view.localPort, 51002);
  assert.equal(h.state.children.length, 2);
  assert.ok(h.state.picked[1].has(51001), "没建成的那个端口下一次不再挑");
  assert.deepEqual(h.recordFiles(), ["service-forward.s1.8814.pid.json"]);
  assert.equal(h.registry.readMeta("service-forward.s1.8814").pid, h.state.children[1].pid, "登记指向活着的那一条");
  assert.equal(h.state.slots.released, 1);
});

test("就绪判定：三次都被占 → 409，不留进程、不留登记", async (t) => {
  const h = harness(t, { onSpawn: (child) => setImmediate(() => { child.say("bind [127.0.0.1]:1: Address already in use\n"); child.exit(255); }) });
  await assert.rejects(h.open(8814), (err) => err.status === 409 && /本机端口 51003 刚好被别的程序占了/.test(err.message));
  assert.equal(h.state.children.length, 3);
  assert.deepEqual([h.recordFiles(), h.forwards.list(), h.state.slots.released], [[], [], 1]);
});

test("就绪判定：一直没有「认证通过」那一行的 ssh，过了回退时间只看本机端口", async (t) => {
  const h = harness(t, { onSpawn: () => {}, timings: { noAuthLineMs: 40 } });
  const startedAt = Date.now();
  const view = await h.open(8814);
  assert.ok(Date.now() - startedAt >= 35, "回退时间到之前不会放行");
  assert.equal(view.localPort, 51001);
});

test("失败归因：认证失败 / 主机密钥 / 不认识的退出 / ssh 起不来 / 超时，各有说法；都不留进程与登记", async (t) => {
  const cases = [
    ["tester@fixture.invalid: Permission denied (publickey).\n", 255, 502, /SSH 连不上服务器：检查 ssh 用户名与密钥/],
    ["Host key verification failed.\n", 255, 502, /主机密钥变化或尚未确认/],
    ["ssh: connect to host fixture.invalid port 22: Connection timed out\n", 255, 502, /网络不通或未在白名单网段/],
    ["something odd happened\nlast words\n", 3, 502, /转发没建起来：ssh 退出了（退出码 3），last words/],
    ["Warning: remote port forwarding failed for listen port 7891\n", 255, 502, /转发没建起来：ssh 退出了（退出码 255）/],
  ];
  for (const [stderr, code, status, pattern] of cases) {
    const h = harness(t, { onSpawn: (child) => setImmediate(() => { child.say(stderr); child.exit(code); }) });
    await assert.rejects(h.open(8814), (err) => err.status === status && pattern.test(err.message), stderr);
    assert.deepEqual([h.state.children.length, h.recordFiles(), h.forwards.list(), h.state.slots.released], [1, [], [], 1], "不重试、不留痕迹");
    assert.equal(h.state.logs.at(-1)[1], "warn");
  }
  const enoent = harness(t, { onSpawn: (child) => { child.pid = undefined; setImmediate(() => child.emit("error", new Error("spawn ssh ENOENT"))); } });
  await assert.rejects(enoent.open(8814), (err) => err.status === 500 && /启动 ssh 失败：spawn ssh ENOENT/.test(err.message));
  assert.deepEqual(enoent.recordFiles(), []);
  const slow = harness(t, { onSpawn: () => {}, probe: () => false, timings: { readyMs: 60 } });
  await assert.rejects(slow.open(8814), (err) => err.status === 504 && /转发还没建好，已放弃/.test(err.message));
  assert.deepEqual(slow.state.children[0].signals, ["SIGTERM"], "超时的那条 ssh 被结束");
  assert.deepEqual(slow.recordFiles(), []);
});

test("预检：~/.ssh/config 给这台主机配了端口转发 → 409 并说明，根本不起 ssh；预检本身跑不成则放行", async (t) => {
  const ambient = harness(t, { preflight: () => ({ code: 0, stdout: "user tester\nremoteforward 7891 [127.0.0.1]:8888\nlocalforward 8888 [127.0.0.1]:80\n", stderr: "" }) });
  await assert.rejects(ambient.open(8814), (err) => err.status === 409 && /~\/\.ssh\/config 里给 fixture\.invalid 配了端口转发（RemoteForward 7891 \[127\.0\.0\.1\]:8888；LocalForward 8888 \[127\.0\.0\.1\]:80）/.test(err.message));
  assert.deepEqual([ambient.state.children.length, ambient.state.slots.acquired.length, ambient.recordFiles()], [0, 0, []]);
  const unsupported = harness(t, { preflight: () => ({ code: 255, stdout: "", stderr: "unknown option -- G" }) });
  assert.equal((await unsupported.open(8814)).port, 8814);
  assert.match(unsupported.state.logs[0][0], /preflight skipped/);
});

test("同一个端口：并发的两次打开合并成一条 ssh；已经开着再打开直接返回那一条", async (t) => {
  const h = harness(t);
  const [a, b] = await Promise.all([h.open(8814), h.open(8814)]);
  assert.deepEqual(a, b);
  assert.equal(h.state.children.length, 1);
  assert.deepEqual(await h.open(8814), a);
  assert.equal(h.state.children.length, 1);
  assert.equal((await h.open(8815)).localPort, 51002);
  assert.deepEqual(h.forwards.list().map((f) => f.port), [8814, 8815]);
});

test(`上限：同时最多 ${FORWARD_LIMIT} 条（正在建立的也算）；关掉一条才能再开；说明里点出开在别的服务器上的`, async (t) => {
  const h = harness(t);
  await h.forwards.open({ server: { id: "s2", host: "fixture.invalid" }, config: CONFIG, remotePort: 9000, acquireSshSlot: h.acquireSshSlot });
  await Promise.all([8814, 8815, 8816].map((port) => h.open(port)));
  await assert.rejects(h.open(8817), (err) => err.status === 409 && /已经开了 4 条转发，先关掉一条再打开（有的开在 s2 上/.test(err.message));
  assert.equal(h.state.children.length, 4, "超限的那次没有起 ssh");
  assert.equal(h.forwards.close("s2", 9000), true);
  assert.equal((await h.open(8817)).port, 8817);
  // 正在建立的也占名额。
  const gate = harness(t, { onSpawn: () => {}, limit: 2 });
  const first = gate.open(8814);
  const second = gate.open(8815);
  await until(() => gate.state.children.length === 2, "两条都已经起了");
  await assert.rejects(gate.open(8816), { status: 409 });
  for (const child of gate.state.children) child.auth();
  await Promise.all([first, second]);
});

test("参数把关：端口、转发目标、服务器 id 不合格直接拒绝，不起 ssh", async (t) => {
  const h = harness(t);
  for (const port of [80, 1023, 0, 70000, "8814", 8814.5, null]) await assert.rejects(h.open(port), { status: 400 }, String(port));
  for (const remoteHost of ["10.0.0.5", "example.com", "localhost", "0.0.0.0"]) await assert.rejects(h.open(8814, { remoteHost }), { status: 400 }, remoteHost);
  await assert.rejects(h.forwards.open({ server: { id: "../x", host: "fixture.invalid" }, config: CONFIG, remotePort: 8814 }), { status: 400 });
  await assert.rejects(h.forwards.open({ server: { id: "s1", host: "another.invalid" }, config: CONFIG, remotePort: 8814 }), (err) => err.status === 409 && /连接参数不可用/.test(err.message));
  await assert.rejects(h.forwards.open({ server: { ...SERVER, authRef: "vault:s1" }, config: CONFIG, remotePort: 8814 }), (err) => err.status === 409 && /密码连接/.test(err.message));
  assert.deepEqual([h.state.children.length, h.state.execCalls.length], [0, 0]);
  assert.equal((await h.open(5173, { remoteHost: "[::1]" })).port, 5173);
  assert.equal(h.state.children[0].args.at(-2), "127.0.0.1:51001:[::1]:5173");
});

test("关闭：立刻从列表里拿掉并发 SIGTERM；进程退出后删登记；不认 SIGTERM 的补 SIGKILL；关不存在的返回 false", async (t) => {
  const h = harness(t);
  await h.open(8814);
  await h.open(8815);
  h.state.children[1].ignoreTerm = true;
  assert.equal(h.forwards.close("s1", 8814), true);
  assert.deepEqual(h.forwards.list().map((f) => f.port), [8815], "不等进程退出，列表里立刻没有它");
  await until(() => h.recordFiles().length === 1, "登记随进程退出删除");
  assert.deepEqual(h.state.children[0].signals, ["SIGTERM"]);
  assert.equal(h.state.timers[0].cleared, true, "到点收回的定时器取消");
  assert.equal(h.forwards.close("s1", 8815), true);
  await until(() => h.state.children[1].signals.includes("SIGKILL"), "宽限过后补 SIGKILL");
  await until(() => h.recordFiles().length === 0, "登记删除");
  assert.deepEqual(h.state.children[1].signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.forwards.close("s1", 8815), false);
  assert.equal(h.forwards.close("s1", 9999), false);
  assert.deepEqual(h.state.logs.slice(-2).map(([message]) => message), ["service forward s1:8814 -> 127.0.0.1:51001 closed (manual)", "service forward s1:8815 -> 127.0.0.1:51002 closed (manual)"]);
});

test("到点收回：2 小时的定时器触发即收回；电脑睡过头（定时器没走）时按墙上时间在下一次读列表时收回", async (t) => {
  const h = harness(t);
  await h.open(8814);
  await h.open(8815);
  h.state.timers[0].fn();
  assert.deepEqual(h.forwards.list().map((f) => f.port), [8815]);
  h.state.clock += FORWARD_TTL_MS - 1;
  assert.deepEqual(h.forwards.list().map((f) => f.port), [8815], "差 1 毫秒还不到");
  h.state.clock += 1;
  assert.deepEqual(h.forwards.list(), []);
  await until(() => h.recordFiles().length === 0, "两条都结束并删了登记");
  assert.deepEqual(h.state.logs.slice(-2).map(([message]) => message.replace(/^.*closed /, "")).sort(), ["(expired)", "(expired)"]);
  assert.equal((await h.open(8814)).localPort, 51001, "收回之后重新打开，优先复用上次的本机端口");
});

test("固定本机端口记忆：同一服务关了再开优先复用上次本机端口；若该端口已被占用则自动重挑并更新记忆", async (t) => {
  let rejectPort = null;
  const h = harness(t, {
    onSpawn: (child) => setImmediate(() => {
      child.auth();
      const spec = child.args[child.args.indexOf("-L") + 1] || "";
      const lp = Number(spec.split(":")[1]);
      if (lp === rejectPort) {
        child.say(`bind [127.0.0.1]:${lp}: Address already in use\n`);
        child.exit(255);
      }
    }),
  });
  const first = await h.open(8814);
  assert.equal(first.localPort, 51001);
  h.forwards.close("s1", 8814);
  const pickedCountBefore = h.state.picked.length;
  const second = await h.open(8814);
  assert.equal(second.localPort, 51001, "未冲突时直接复用 51001");
  assert.equal(h.state.picked.length, pickedCountBefore, "复用记忆端口时不调 pickPort");

  // 关掉后再开，但此时 51001 被别的本机进程占了 -> 自动回退到 pickPort 挑出 51002 并更新记忆
  h.forwards.close("s1", 8814);
  rejectPort = 51001;
  const third = await h.open(8814);
  assert.equal(third.localPort, 51002, "记忆端口冲突时自动重挑新端口");
  h.forwards.close("s1", 8814);
  rejectPort = null;
  const fourth = await h.open(8814);
  assert.equal(fourth.localPort, 51002, "更新记忆为最新成功的端口 51002");
});

test("端口从服务列表里消失：收回；清单发出之后才开的转发不归这份清单判断；别的服务器不受影响", async (t) => {
  const h = harness(t);
  await h.open(8814);
  await h.open(8815);
  await h.forwards.open({ server: { id: "s2", host: "fixture.invalid" }, config: CONFIG, remotePort: 8814, acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.forwards.reconcile("s1", new Set([8815]), h.state.clock - 1), 0, "这份清单比转发还早");
  assert.equal(h.forwards.reconcile("s1", new Set([8815]), h.state.clock), 1);
  assert.deepEqual(h.forwards.list().map((f) => [f.serverId, f.port]), [["s1", 8815], ["s2", 8814]]);
  assert.equal(h.forwards.reconcile("s1", new Set([8815])), 0);
  await until(() => h.state.logs.some(([message]) => message.endsWith("closed (gone)")), "记下原因");
});

test("ssh 自己退出（连接断了 / 心跳超时）：从列表里消失、删登记、记一条告警", async (t) => {
  const h = harness(t);
  await h.open(8814);
  h.state.children[0].say("Timeout, server fixture.invalid not responding.\n");
  h.state.children[0].exit(255);
  assert.deepEqual([h.forwards.list(), h.recordFiles()], [[], []]);
  assert.deepEqual(h.state.logs.at(-1), ["service forward s1:8814 -> 127.0.0.1:51001 ended: ssh exited (code 255) Timeout, server fixture.invalid not responding.", "warn"]);
  assert.equal(h.state.timers[0].cleared, true);
});

test("按条件收回（配置变了）：baseKey 是这条转发建立时的连接参数", async (t) => {
  let pinned = PINNED;
  const h = harness(t, { sshArgsFor: () => pinned });
  await h.open(8814);
  const before = h.forwards.baseKeyFor(SERVER, CONFIG);
  assert.equal(h.forwards.closeIf((entry) => entry.baseKey !== before, "config"), 0);
  pinned = PINNED.map((arg) => (arg === "tester" ? "someone-else" : arg));
  assert.notEqual(h.forwards.baseKeyFor(SERVER, CONFIG), before);
  assert.equal(h.forwards.baseKeyFor({ id: "s1", host: "another.invalid" }, CONFIG), null, "参数拼不出来 → null（调用方按「变了」处理）");
  assert.equal(h.forwards.closeIf((entry) => h.forwards.baseKeyFor(SERVER, CONFIG) !== entry.baseKey, "config"), 1);
  assert.deepEqual(h.forwards.list(), []);
});

test("登记不上（运行目录写不进去）：不留这条转发——没有登记，工作台被强杀后就没人能清它", async (t) => {
  const h = harness(t, { registry: { recordProcess: () => { throw new Error("EACCES"); }, readMeta: () => null } });
  await assert.rejects(h.open(8814), (err) => err.status === 500 && /登记不上/.test(err.message));
  assert.deepEqual(h.state.children[0].signals, ["SIGTERM"]);
  assert.deepEqual(h.forwards.list(), []);
});

test("退出：beginShutdown 同步给全部转发发 SIGTERM、不再接受新的；dispose 等它们结束，不认 SIGTERM 的补 SIGKILL", async (t) => {
  const h = harness(t);
  await h.open(8814);
  await h.open(8815);
  h.state.children[1].ignoreTerm = true;
  h.forwards.beginShutdown();
  assert.deepEqual(h.state.children.map((child) => child.signals), [["SIGTERM"], ["SIGTERM"]], "同步发出，不等任何 await");
  assert.deepEqual(h.forwards.list(), []);
  await assert.rejects(h.open(8816), { status: 503 });
  await h.forwards.dispose();
  assert.deepEqual(h.state.children[1].signals.slice(0, 2), ["SIGTERM", "SIGKILL"]);
  await until(() => h.recordFiles().length === 0, "登记都删了");
  assert.ok(h.state.logs.some(([message]) => message.endsWith("closed (shutdown)")));
  h.forwards.beginShutdown();
  await h.forwards.dispose();
});

test("退出：正在建立的转发被打断——那次请求立刻以 503 结束（不拖住在途请求的排干），ssh 被结束", async (t) => {
  const h = harness(t, { onSpawn: () => {} });
  const opening = h.open(8814);
  await until(() => h.state.children.length === 1, "ssh 已经起了");
  h.forwards.beginShutdown();
  await assert.rejects(opening, (err) => err.status === 503 && /正在退出/.test(err.message));
  assert.ok(h.state.children[0].signals.includes("SIGTERM"));
  await h.forwards.dispose();
  assert.deepEqual(h.recordFiles(), []);
});

// ---------------------------------------------------------------------------
// 3) 真实子进程（假 ssh）
// ---------------------------------------------------------------------------

// 假 ssh：-G 打印一份配置；否则按 -L 在 127.0.0.1 上监听那个本机端口，谁连上就回一行自己的转发串。
// 行为由 <dir>/mode 文件决定：ok | stubborn（不理 SIGTERM）| auth-fail。每次调用的参数追加到 <dir>/calls.ndjson。
const FAKE_SSH_SOURCE = String.raw`
import fs from "node:fs";
import net from "node:net";
const dir = process.env.FAKE_SSH_DIR;
const args = process.argv.slice(2);
let mode = "ok";
try { mode = fs.readFileSync(dir + "/mode", "utf8").trim() || "ok"; } catch {}
fs.appendFileSync(dir + "/calls.ndjson", JSON.stringify({ pid: process.pid, args }) + "\n");
if (args[0] === "-G") {
  process.stdout.write("user tester\nhostname fixture.invalid\nexitonforwardfailure yes\n");
  process.exit(0);
}
const spec = args[args.indexOf("-L") + 1] || "";
const localPort = Number(spec.split(":")[1]);
if (mode === "auth-fail") {
  process.stderr.write("tester@fixture.invalid: Permission denied (publickey).\n");
  process.exit(255);
}
if (mode === "stubborn") process.on("SIGTERM", () => {});
const server = net.createServer((socket) => {
  socket.on("error", () => {}); // 就绪探测连上即断，回写可能撞上已关闭的连接
  socket.end("fake-forward " + spec + "\n");
});
server.on("error", () => {
  process.stderr.write("bind [127.0.0.1]:" + localPort + ": Address already in use\nCould not request local forwarding.\n");
  process.exit(255);
});
server.listen(localPort, "127.0.0.1", () => {
  process.stderr.write('Authenticated to fixture.invalid ([192.0.2.10]:22) using "publickey".\n');
});
`;

const realTest = process.platform === "win32" ? test.skip : test;

function realHarness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "svc-forward-real-"));
  const fake = path.join(dir, "fake-ssh.mjs");
  const runtimeDir = path.join(dir, "runtime");
  mkdirSync(runtimeDir);
  writeFileSync(fake, FAKE_SSH_SOURCE);
  const env = { ...process.env, FAKE_SSH_DIR: dir };
  const spawned = [];
  const logs = [];
  const spawnFake = (args, spawnOptions = {}) => {
    const child = spawn(process.execPath, [fake, ...args], { stdio: ["ignore", "ignore", "pipe"], ...spawnOptions, env });
    spawned.push(child);
    return child;
  };
  const registry = createProcessRegistry({ runtimeDir });
  const create = (overrides = {}) => createServiceForwards({
    registry,
    runtimeDir,
    cwd: dir,
    sshArgsFor: () => PINNED,
    getConfig: () => CONFIG,
    sshCommand: "/nonexistent/not-the-real-ssh",
    spawnImpl: (_command, args, spawnOptions) => spawnFake(args, spawnOptions),
    execImpl: (_command, args, execOptions) => execFileWithTimeout(process.execPath, [fake, ...args], { ...execOptions, env }),
    log: (message, fields) => logs.push([message, fields?.level || "info"]),
    ...overrides,
  });
  t.after(() => {
    for (const child of spawned) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const calls = () => (existsSync(path.join(dir, "calls.ndjson")) ? readFileSync(path.join(dir, "calls.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  const setMode = (mode) => writeFileSync(path.join(dir, "mode"), mode);
  const recordFiles = () => readdirSync(runtimeDir).filter((file) => file.endsWith(".pid.json")).sort();
  return { dir, runtimeDir, registry, create, spawnFake, calls, setMode, recordFiles, logs };
}

// 连上本机端口读一行（假 ssh 会回自己的转发串）。
function readBanner(port) {
  return new Promise((resolve, reject) => {
    let text = "";
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(30000, () => socket.destroy(new Error("timeout")));
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("end", () => resolve(text.trim()));
    socket.on("error", reject);
  });
}

realTest("真实子进程：打开后本机端口上监听的就是这条 ssh；登记用真实 ps 校验得过；关闭后进程退出、登记删除", async (t) => {
  const h = realHarness(t);
  const forwards = h.create();
  const view = await forwards.open({ server: SERVER, config: CONFIG, remotePort: 8814 });
  assert.equal(view.url, `http://127.0.0.1:${view.localPort}/`);
  assert.equal(collectReservedPorts(CONFIG).has(view.localPort), false, "系统挑的端口不在保留集合里");
  assert.equal(await readBanner(view.localPort), `fake-forward 127.0.0.1:${view.localPort}:127.0.0.1:8814`);
  const calls = h.calls();
  assert.deepEqual(calls.map((call) => call.args[0]), ["-G", "-N"], "先预检，再起一条转发");
  const meta = h.registry.readMeta("service-forward.s1.8814");
  assert.equal(meta.pid, calls[1].pid);
  const check = await h.registry.verifyProcess("service-forward.s1.8814");
  assert.equal(check.verified, true, check.reason);
  // 注册表自己的 60 秒巡检（listRuntimeProcesses）不会把活着的转发登记当垃圾删掉。
  assert.deepEqual((await h.registry.listRuntimeProcesses()).map((item) => [item.name, item.verified]), [["service-forward.s1.8814", true]]);
  // 自己开着的转发不算孤儿。
  assert.deepEqual(await forwards.sweepOrphans(), { stopped: 0, removed: 0, kept: 0 });
  assert.equal(isPidAlive(meta.pid), true);

  assert.equal(forwards.close("s1", 8814), true);
  await until(() => !isPidAlive(meta.pid), "ssh 进程退出");
  await until(() => h.recordFiles().length === 0, "登记删除");
  assert.equal(await canConnectLocal(view.localPort), false, "本机端口不再有人监听");
  await forwards.dispose();
});

realTest("真实子进程：到点收回——存活时限一到，这条 ssh 被结束、登记删除、列表里不再有它", async (t) => {
  const h = realHarness(t);
  const forwards = h.create({ ttlMs: 600 });
  const view = await forwards.open({ server: SERVER, config: CONFIG, remotePort: 8814 });
  assert.equal(view.expiresAt - view.startedAt, 600);
  // pid 从假 ssh 自己的调用记录里取（机器一卡，回头再去读登记时它可能已经到点被删了）。
  const { pid } = h.calls().find((call) => call.args[0] === "-N");
  await until(() => !isPidAlive(pid), "到点后 ssh 进程退出");
  await until(() => h.recordFiles().length === 0, "登记删除");
  assert.deepEqual(forwards.list(), []);
  assert.ok(h.logs.some(([message]) => message.endsWith("closed (expired)")));
  await forwards.dispose();
});

realTest("真实子进程：认证失败如实报错，不留进程与登记", async (t) => {
  const h = realHarness(t);
  h.setMode("auth-fail");
  const forwards = h.create();
  await assert.rejects(forwards.open({ server: SERVER, config: CONFIG, remotePort: 8814 }), (err) => err.status === 502 && /SSH 连不上服务器：检查 ssh 用户名与密钥/.test(err.message));
  assert.deepEqual([forwards.list(), h.recordFiles()], [[], []]);
  assert.equal(h.calls().filter((call) => call.args[0] === "-N").length, 1, "认证失败不重试");
});

realTest("孤儿清理：上一次留下的转发 ssh——pid 还在且命令行特征对得上才结束；对不上 / 进程不在了只删登记", async (t) => {
  const h = realHarness(t);
  // 上一次会话留下的那条：直接起一个假 ssh，并照管理器的写法登记。
  const base = buildForwardBase(PINNED, "fixture.invalid");
  const localPort = await pickFreeLocalPort({ reserved: collectReservedPorts(CONFIG) });
  const target = { localPort, remotePort: 8814, remoteHost: "127.0.0.1" };
  const args = buildForwardSshArgs(base, target);
  const orphan = h.spawnFake(args);
  await until(() => canConnectLocal(localPort), "孤儿 ssh 已在监听");
  h.registry.recordProcess("service-forward.s1.8814", orphan.pid, { command: `ssh ${args.join(" ")}`, args, signature: forwardSignature(base, target) });
  // pid 被别的进程复用了：登记说它是 8815 的转发，实际是个不相干的进程。
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" });
  t.after(() => bystander.kill("SIGKILL"));
  const other = { localPort: localPort + 1, remotePort: 8815, remoteHost: "127.0.0.1" };
  h.registry.recordProcess("service-forward.s1.8815", bystander.pid, { command: "ssh …", args: buildForwardSshArgs(base, other), signature: forwardSignature(base, other) });
  // 进程早就不在了。
  const gone = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  h.registry.recordProcess("service-forward.s1.8816", gone.pid, { command: "ssh …", args: [], signature: forwardSignature(base, { ...other, remotePort: 8816 }) });
  // 不是转发的登记：不碰。
  h.registry.recordProcess("tunnel.s1", bystander.pid, { command: "ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid", signature: "-R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid" });
  writeFileSync(path.join(h.runtimeDir, "service-forward.s1.9999.pid.json"), "{not json");

  const forwards = h.create();
  const summary = await forwards.sweepOrphans();
  assert.deepEqual(summary, { stopped: 1, removed: 3, kept: 0 });
  await until(() => !isPidAlive(orphan.pid), "孤儿 ssh 被结束");
  assert.equal(await canConnectLocal(localPort), false);
  assert.equal(isPidAlive(bystander.pid), true, "命令行对不上的进程绝不动");
  assert.deepEqual(h.recordFiles(), ["tunnel.s1.pid.json"], "转发的登记清干净，别的登记原样");
  assert.ok(h.logs.some(([message]) => message === `service forward orphan service-forward.s1.8814 (pid ${orphan.pid}) stopped`));
  assert.deepEqual(await forwards.sweepOrphans(), { stopped: 0, removed: 0, kept: 0 }, "再扫一遍什么都不做");
});

realTest("退出：两条真实的转发都被结束——其中一条不理 SIGTERM，由 dispose 补 SIGKILL；登记全部删除", async (t) => {
  const h = realHarness(t);
  const forwards = h.create({ timings: { disposeGraceMs: 1500, disposeKillMs: 5000 } });
  const first = await forwards.open({ server: SERVER, config: CONFIG, remotePort: 8814 });
  h.setMode("stubborn");
  const second = await forwards.open({ server: SERVER, config: CONFIG, remotePort: 8815 });
  const pids = ["service-forward.s1.8814", "service-forward.s1.8815"].map((name) => h.registry.readMeta(name).pid);
  assert.ok(pids.every((pid) => isPidAlive(pid)));
  forwards.beginShutdown();
  await forwards.dispose();
  await until(() => pids.every((pid) => !isPidAlive(pid)), "两条 ssh 都退出");
  await until(() => h.recordFiles().length === 0, "登记删除");
  assert.deepEqual([await canConnectLocal(first.localPort), await canConnectLocal(second.localPort)], [false, false]);
});
