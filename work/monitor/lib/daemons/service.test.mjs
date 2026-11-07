import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildDaemonInvocation, DAEMON_IDS, DAEMON_REMOTE_COMMAND, DAEMON_STATUS_SCRIPT, DAEMONS, daemonDef, daemonView, isDaemonId, parseDaemonOutput,
} from "./commands.mjs";
import { RELAY_PROXY_PRELOAD_SOURCE } from "./relay-proxy-preload.mjs";
import { createDaemonsService, DAEMONS_STATUS_TTL_MS, FORWARD_LISTING_MAX_AGE_MS, isDaemonsEligible, relayPortOf } from "./service.mjs";

// 实测集群上的状态输出（2026-10-07，两者都在运行）。
const RUNNING = [
  "v=1", "paseo.bin=1", "paseo.daemon=running", "paseo.version=0.10.3", "paseo.port=1",
  "t3code.bin=1", "t3code.binver=0.0.45-zh.1", "t3code.port=1", "t3code.proc=1", "t3code.version=0.0.45", "end=1",
].join("\n");
const T3_DOWN = RUNNING.replace("t3code.port=1", "t3code.port=0").replace("t3code.proc=1", "t3code.proc=0").replace("t3code.version=0.0.45\n", "");

test("注册表：只有 paseo / t3code 两个 id；远端命令是常量，脚本里没有 kill / restart / stop / sudo", () => {
  assert.deepEqual(DAEMON_IDS, ["paseo", "t3code"]);
  assert.equal(isDaemonId("paseo"), true);
  for (const bad of ["", "PASEO", "paseo;rm -rf ~", "__proto__", null, 1]) assert.equal(isDaemonId(bad), false, String(bad));
  const scripts = [DAEMON_STATUS_SCRIPT, ...DAEMONS.map((d) => d.script)];
  for (const script of scripts) {
    assert.doesNotMatch(script, /\b(kill|pkill|killall|sudo|restart)\b/);
    assert.doesNotMatch(script, /daemon stop/);
    assert.match(script, /^\{\n/, "整个脚本包在 { } 里，远端命令读 stdin 读不到脚本本身");
  }
  // 启动脚本先判端口：已在监听即 already，不碰进程。
  assert.match(daemonDef("paseo").script, /if port_up 6767; then\n {2}echo "result=already"/);
  assert.match(daemonDef("t3code").script, /if port_up 3773; then\n {2}echo "result=already"/);
  assert.match(daemonDef("t3code").script, /setsid nohup "\$HOME\/\.t3\/runtime\/versions\/\$v\/t3" serve --host 127\.0\.0\.1 --port 3773 --base-dir "\$HOME\/\.t3"/);
});

test("调用组装：命令串固定为 bash -s，脚本只走 stdin；未知动作直接抛错", () => {
  const status = buildDaemonInvocation(["-o", "BatchMode=yes", "kai@h"]);
  assert.deepEqual(status.args, ["-o", "BatchMode=yes", "kai@h", DAEMON_REMOTE_COMMAND]);
  assert.equal(status.input, DAEMON_STATUS_SCRIPT);
  const start = buildDaemonInvocation(["h"], "t3code");
  assert.equal(start.args.at(-1), "bash -s");
  assert.equal(start.input, daemonDef("t3code").script);
  assert.ok(start.timeoutMs > status.timeoutMs);
  assert.throws(() => buildDaemonInvocation(["h"], "x; reboot"));
});

test("输出解析：只认白名单 key 与合格的值；缺 v=1 / end=1 视为不完整", () => {
  const parsed = parseDaemonOutput(`noise\npaseo.version=$(id)\nevil=1\n${RUNNING}\npaseo.port=0`);
  assert.equal(parsed.complete, true);
  assert.equal(parsed.values["paseo.version"], "0.10.3", "不合格的值丢弃，后面合格的生效");
  assert.equal(parsed.values["paseo.port"], "1", "同一 key 只取第一次");
  assert.equal("evil" in parsed.values, false);
  assert.equal(parseDaemonOutput(RUNNING.replace("end=1", "")).complete, false);
  assert.equal(parseDaemonOutput("").complete, false);
  assert.equal(parseDaemonOutput(`${RUNNING}\r\n`).complete, true);
});

test("状态视图：running / stopped / missing / unknown 与说明", () => {
  const running = parseDaemonOutput(RUNNING);
  assert.deepEqual(DAEMONS.map((d) => [d.id, daemonView(d, running).state, daemonView(d, running).version]), [["paseo", "running", "0.10.3"], ["t3code", "running", "0.0.45"]]);
  const t3 = daemonView(daemonDef("t3code"), parseDaemonOutput(T3_DOWN));
  assert.equal(t3.state, "stopped");
  assert.match(t3.note, /0\.0\.45-zh\.1/);
  const missing = daemonView(daemonDef("t3code"), parseDaemonOutput(T3_DOWN.replace("t3code.bin=1", "t3code.bin=0")));
  assert.equal(missing.state, "missing");
  const foreign = daemonView(daemonDef("t3code"), parseDaemonOutput(RUNNING.replace("t3code.proc=1", "t3code.proc=0")));
  assert.equal(foreign.state, "running");
  assert.match(foreign.note, /其它程序占用/);
  const unknown = daemonView(daemonDef("paseo"), parseDaemonOutput("garbage"));
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.installed, null);
});

// 本机真跑一遍状态脚本（假 HOME：假 paseo + 两个 t3 版本目录，只有一个装完整）：校验程序发现与版本选择。
// 端口状态取决于本机，不做断言。
test("状态脚本在 bash 下可执行：PATH 补 ~/.local/bin、t3 只选装完整的最高版本", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "daemons-home-"));
  try {
    mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    const paseo = path.join(home, ".local", "bin", "paseo");
    writeFileSync(paseo, "#!/bin/sh\nprintf 'localDaemon: stopped\\ndaemonVersion: 9.8.7\\n'\n");
    chmodSync(paseo, 0o755);
    for (const [ver, complete] of [["0.0.45", true], ["0.0.46", false], ["0.0.45-zh.1", true]]) {
      const dir = path.join(home, ".t3", "runtime", "versions", ver);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "t3"), "#!/bin/sh\n");
      chmodSync(path.join(dir, "t3"), 0o755);
      if (complete) writeFileSync(path.join(dir, ".install-complete"), ver);
    }
    const run = spawnSync("bash", ["-s"], { input: DAEMON_STATUS_SCRIPT, env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 20000 });
    const parsed = parseDaemonOutput(run.stdout);
    assert.equal(parsed.complete, true, run.stderr);
    assert.equal(parsed.values["paseo.bin"], "1");
    assert.equal(parsed.values["paseo.daemon"], "stopped");
    assert.equal(parsed.values["paseo.version"], "9.8.7");
    assert.equal(parsed.values["t3code.bin"], "1");
    assert.equal(parsed.values["t3code.binver"], "0.0.45-zh.1", "0.0.46 没有 .install-complete，不选");
    assert.match(parsed.values["paseo.port"], /^[01]$/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 远端日志容量上限（评审 #9）----

const capLogFn = () => DAEMON_STATUS_SCRIPT.match(/^cap_log\(\) \{\n[\s\S]*?\n\}\n/m)[0];

test("日志上限：两个启动脚本在写日志之前先 cap_log；T3 仍以 >> 追加；守护只在启动成功后留下", () => {
  for (const [id, log] of [["paseo", "$HOME/.paseo/console-launch.log"], ["t3code", "$HOME/.t3/console-launch.log"]]) {
    const script = daemonDef(id).script;
    const cap = script.indexOf(`cap_log "${log}"`);
    assert.ok(cap > 0, `${id} 启动前要 cap_log`);
    assert.ok(cap < script.indexOf(`>>"${log}"`), `${id}：截断在第一次追加之前`);
  }
  const t3 = daemonDef("t3code").script;
  assert.match(t3, /serve --host 127\.0\.0\.1 --port 3773 --base-dir "\$HOME\/\.t3" >>"\$HOME\/\.t3\/console-launch\.log" 2>&1/, "常驻输出必须保持 O_APPEND");
  const started = t3.indexOf('echo "result=started"');
  const guard = t3.indexOf("trap '' HUP");
  assert.ok(started > 0 && guard > started && guard < t3.indexOf('echo "result=failed"'), "守护只在 started 分支");
  assert.match(t3, /\) <\/dev\/null >\/dev\/null 2>&1 &\n/, "守护的输入输出全指向 /dev/null，不拖住 SSH 会话");
  assert.doesNotMatch(daemonDef("paseo").script, /console-log-guard/, "Paseo 只记启动阶段输出，不需要守护");
  assert.doesNotMatch(DAEMON_STATUS_SCRIPT, /cap_log "/, "只查状态不写远端文件");
});

test("cap_log：超过 1 MiB 就地截断保留末尾 256 KiB；inode 不变，常驻进程的 O_APPEND 写入落在新末尾", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "daemons-cap-"));
  try {
    const file = path.join(dir, "console-launch.log");
    const small = path.join(dir, "small.log");
    writeFileSync(small, "start ok\n");
    writeFileSync(file, `${"x".repeat(2 * 1024 * 1024)}\nLAST-STARTUP-ERROR: port in use\n`);
    const inode = statSync(file).ino;
    // 模拟 T3：以 O_APPEND 长期打开同一文件。
    const fd = openSync(file, "a");
    writeSync(fd, "line-before-cap\n");
    const run = spawnSync("bash", ["-c", `${capLogFn()}\ncap_log "$1"\ncap_log "$2"`, "cap", file, small], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    writeSync(fd, "line-after-cap\n");
    closeSync(fd);
    const after = readFileSync(file);
    assert.equal(statSync(file).ino, inode, "就地截断，不是 rename");
    assert.ok(after.length < 256 * 1024 + 512, `截断后 ${after.length} 字节`);
    assert.equal(after.includes(0), false, "O_APPEND 写入不会在截断后留下空洞");
    const text = after.toString("utf8");
    assert.match(text, /LAST-STARTUP-ERROR: port in use\nline-before-cap\n/, "末尾诊断保留");
    assert.match(text, /console: log exceeded 1 MiB, kept the last 256 KiB\n/);
    assert.ok(text.endsWith("line-after-cap\n"), "常驻进程之后的写入落在新末尾");
    assert.equal(readFileSync(small, "utf8"), "start ok\n", "没超限不动");
    assert.deepEqual(readdirSync(dir).sort(), ["console-launch.log", "small.log"], "临时文件清掉");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 守护循环本身：把 sleep 300 换成 sleep 0、port_up 换成计数桩，在前台跑一遍。
function runGuard(home, portUpBody) {
  const block = daemonDef("t3code").script.match(/\(\n\s+trap '' HUP\n[\s\S]*?\n\s+\)(?= <\/dev\/null >\/dev\/null 2>&1 &)/)[0];
  const script = `${capLogFn()}\nport_up() {\n${portUpBody}\n}\n${block.replace("sleep 300", "sleep 0")}\n`;
  return spawnSync("bash", ["-c", script], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8", timeout: 20000 });
}

test("T3 日志守护：端口在监听就周期性 cap_log，T3 退出即结束；被更新一次启动的守护取代就退出", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "daemons-guard-"));
  try {
    const log = path.join(home, ".t3", "console-launch.log");
    const count = path.join(home, "port-calls");
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, `${"y".repeat(1536 * 1024)}\nTAIL\n`);
    writeFileSync(count, "0");
    // 前 2 次"端口在监听"，第 3 次 T3 已退出。
    const live = runGuard(home, `n=$(cat "$HOME/port-calls"); echo $((n + 1)) >"$HOME/port-calls"; [ "$n" -lt 2 ]`);
    assert.equal(live.status, 0, live.stderr);
    assert.equal(readFileSync(count, "utf8").trim(), "3", "端口不再监听即退出循环");
    assert.ok(statSync(log).size < 256 * 1024 + 512, "运行期增长被截断");
    assert.match(readFileSync(log, "utf8"), /TAIL\n/);

    // 新一次启动写了自己的标识：旧守护下一拍发现不是自己，直接退出、不再截断。
    writeFileSync(log, `${"z".repeat(1536 * 1024)}\n`);
    const replaced = runGuard(home, `echo other-session >"$HOME/.t3/console-log-guard.pid"; true`);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.ok(statSync(log).size > 1024 * 1024, "被取代的守护不再动日志");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 终审：守护原先把 $$ 写进 pid 文件——子 shell 里 $$ 仍是外层 bash -s 的 pid，那个进程几秒后就退出、
// pid 可能被别的进程（甚至下一次启动的 bash -s）复用，「只认最新一个守护」就不成立了。
test("T3 日志守护：pid 文件记的是守护子 shell 自己的 pid，不是外层 bash 的 $$", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "daemons-guard-pid-"));
  try {
    mkdirSync(path.join(home, ".t3"), { recursive: true });
    const block = daemonDef("t3code").script.match(/\(\n\s+trap '' HUP\n[\s\S]*?\n\s+\)(?= <\/dev\/null >\/dev\/null 2>&1 &)/)[0];
    // port_up 桩在守护子 shell 里执行：用独立的办法取这个子 shell 的 pid（起一个子进程报它的 PPID），
    // 同时抄下此刻 pid 文件的内容，然后报「端口不在监听」让守护退出。末尾再跟一条命令，保证子 shell 真的 fork。
    const script = [
      "port_up() {",
      "  sh -c 'echo \"$PPID\"' >\"$HOME/guard-real-pid\"",
      "  cat \"$HOME/.t3/console-log-guard.pid\" >\"$HOME/guard-recorded-pid\"",
      "  return 1",
      "}",
      block.replace("sleep 300", "sleep 0"),
      "echo \"outer=$$\"",
      "",
    ].join("\n");
    const run = spawnSync("bash", ["-c", script], { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8", timeout: 20000 });
    assert.equal(run.status, 0, run.stderr);
    const outer = run.stdout.match(/^outer=(\d+)$/m)?.[1];
    const real = readFileSync(path.join(home, "guard-real-pid"), "utf8").trim();
    const recorded = readFileSync(path.join(home, "guard-recorded-pid"), "utf8").trim();
    assert.match(recorded, /^[1-9]\d*$/, "pid 文件是一个纯数字");
    assert.notEqual(real, outer, "夹具有效：守护确实在另一个进程里");
    assert.equal(recorded, real, "记下的是守护自己的 pid");
    assert.notEqual(recorded, outer, "不是外层 bash 的 $$");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---- 服务（注入 exec，零真实 SSH）----

function harness({ servers = [{ id: "s1", name: "主集群", host: "kai@h", remotePort: 7891 }], activeServerId = "s1", respond, forwards = null } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const logs = [];
  const timeline = [];
  const slots = { acquired: 0, released: 0 };
  const config = { activeServerId, servers };
  const service = createDaemonsService({
    getConfig: async () => config,
    getMainServerConfig: (c) => c.servers.find((s) => s.id === c.activeServerId) || null,
    sshArgsFor: (server) => [server.host],
    execCollector: async (invocation, server) => {
      calls.push({ invocation, server });
      return respond ? respond(invocation, calls.length) : { code: 0, stdout: RUNNING, stderr: "" };
    },
    probeSshFailureReason: (code, stderr) => (/Permission denied/.test(stderr) ? "auth: 检查密钥" : `ssh exit ${code}`),
    forwards,
    log: (message, fields) => logs.push([message, fields?.level]),
    timeline: (level, message, fields) => timeline.push([level, message, fields]),
    now: () => clock,
  });
  const acquireSshSlot = async () => {
    slots.acquired += 1;
    return () => { slots.released += 1; };
  };
  return { service, calls, logs, timeline, slots, config, acquireSshSlot, tick: (ms) => { clock += ms; }, clock: () => clock };
}

test("范围：团队服务器才提供；个人服务器 / 禁用 / 关监控不提供", () => {
  assert.equal(isDaemonsEligible({ id: "a" }), true);
  assert.equal(isDaemonsEligible({ id: "a", source: "personal" }), false);
  assert.equal(isDaemonsEligible({ id: "a", disabled: true }), false);
  assert.equal(isDaemonsEligible({ id: "a", monitorEnabled: false }), false);
  assert.equal(isDaemonsEligible(null), false);
});

test("状态：一次 SSH 拿两个守护进程；10 秒内复用；fresh 跳过缓存；并发查询合并成一次", async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.service.status(null, { acquireSshSlot: h.acquireSshSlot }), h.service.status("s1", { acquireSshSlot: h.acquireSshSlot })]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(a, b);
  assert.equal(a.eligible, true);
  assert.equal(a.reachable, true);
  assert.equal(a.serverName, "主集群");
  assert.equal(a.starting, null);
  assert.deepEqual(a.daemons.map((d) => [d.id, d.state, d.port]), [["paseo", "running", 6767], ["t3code", "running", 3773]]);
  assert.equal(h.calls[0].invocation.args.at(-1), "bash -s");
  assert.equal(h.calls[0].invocation.input, DAEMON_STATUS_SCRIPT);
  assert.deepEqual(h.slots, { acquired: 1, released: 1 });
  h.tick(DAEMONS_STATUS_TTL_MS - 1);
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1);
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot, fresh: true });
  assert.equal(h.calls.length, 2);
  h.tick(DAEMONS_STATUS_TTL_MS);
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 3);
});

test("状态：SSH 失败 / 超时如实返回 unknown + 原因，不抛错；exec 抛错同样折成 unknown", async () => {
  const auth = harness({ respond: () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)" }) });
  const view = await auth.service.status(null, { acquireSshSlot: auth.acquireSshSlot });
  assert.equal(view.reachable, false);
  assert.equal(view.error, "auth: 检查密钥");
  assert.deepEqual(view.daemons.map((d) => d.state), ["unknown", "unknown"]);
  assert.equal(auth.logs.at(-1)[1], "warn");
  const slow = harness({ respond: () => ({ code: null, stdout: "v=1\npaseo.bin=1", stderr: "", timedOut: true }) });
  assert.match((await slow.service.status(null, { acquireSshSlot: slow.acquireSshSlot })).error, /SSH 未在 25 秒内返回/);
  const boom = harness({ respond: () => { throw new Error("spawn ssh ENOENT"); } });
  const boomView = await boom.service.status(null, { acquireSshSlot: boom.acquireSshSlot });
  assert.equal(boomView.reachable, false);
  assert.deepEqual(boom.slots, { acquired: 1, released: 1 }, "抛错也归还槽位");
});

test("状态：serverId 不是活跃服务器 → 409；个人服务器 → eligible:false 且不发 SSH；缺 SSH 调度 → 503", async () => {
  const h = harness();
  await assert.rejects(h.service.status("other", { acquireSshSlot: h.acquireSshSlot }), { status: 409 });
  const personal = harness({ servers: [{ id: "p1", host: "h", source: "personal" }], activeServerId: "p1" });
  assert.deepEqual(await personal.service.status(null, { acquireSshSlot: personal.acquireSshSlot }), { eligible: false, serverId: "p1", daemons: [], starting: null });
  assert.equal(personal.calls.length, 0);
  await assert.rejects(h.service.status(null, {}), { status: 503 });
});

test("启动：已在运行 → alreadyRunning（远端脚本自己判端口）；结果带最新状态并刷新缓存；写运维日志与时间线", async () => {
  const h = harness({ respond: (inv) => ({ code: 0, stdout: inv.input === DAEMON_STATUS_SCRIPT ? T3_DOWN : `result=already\n${RUNNING}`, stderr: "" }) });
  const before = await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(before.daemons[1].state, "stopped");
  const res = await h.service.start("t3code", { serverId: "s1" }, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(res.result, "alreadyRunning");
  assert.equal(res.ok, true);
  assert.equal(res.status.daemons[1].state, "running");
  assert.equal(res.status.starting, null);
  assert.equal(h.calls.at(-1).invocation.input, daemonDef("t3code").script);
  const after = await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(after.daemons[1].state, "running", "启动结果直接进缓存");
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.logs.map((l) => l[0]), [
    "daemons start t3code on s1: requested",
    "daemons start t3code on s1: alreadyRunning",
  ]);
  assert.deepEqual(h.timeline, [["info", "daemons start t3code on s1: alreadyRunning", { event: "daemon-start", serverId: "s1", daemon: "t3code", result: "alreadyRunning" }]]);
});

test("启动：started / missing / failed（带远端说明）/ unknown（超时，缓存作废）", async () => {
  const outcomes = [
    ["result=started", "started", true],
    ["result=missing", "missing", false],
    ["result=failed\ndetail=bind: address already in use", "failed", false],
  ];
  for (const [line, result, ok] of outcomes) {
    const h = harness({ respond: () => ({ code: 0, stdout: `${line}\n${RUNNING}`, stderr: "" }) });
    const res = await h.service.start("paseo", {}, { acquireSshSlot: h.acquireSshSlot });
    assert.equal(res.result, result);
    assert.equal(res.ok, ok);
    if (result === "failed") assert.equal(res.detail, "bind: address already in use");
    assert.equal(h.timeline[0][0], ok ? "info" : "warn");
  }
  const h = harness({ respond: (inv) => (inv.input === DAEMON_STATUS_SCRIPT ? { code: 0, stdout: RUNNING } : { code: null, stdout: "v=1\n", timedOut: true }) });
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  const res = await h.service.start("paseo", {}, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(res.result, "unknown");
  assert.equal(res.status, null);
  assert.match(res.error, /SSH 未在 115 秒内返回/);
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 3, "结果不确定时缓存作废，下一次查询重新问远端");
  const noResult = harness();
  assert.equal((await noResult.service.start("paseo", {}, { acquireSshSlot: noResult.acquireSshSlot })).error, "远端没有给出启动结果");
});

test("启动：同一时刻只允许一个（第二个 409，进行中的状态带 starting）；结束后可再次启动", async () => {
  let releaseRemote;
  const gate = new Promise((resolve) => { releaseRemote = resolve; });
  const h = harness({
    respond: async (inv) => {
      if (inv.input === DAEMON_STATUS_SCRIPT) return { code: 0, stdout: T3_DOWN };
      await gate;
      return { code: 0, stdout: `result=started\n${RUNNING}` };
    },
  });
  const first = h.service.start("t3code", {}, { acquireSshSlot: h.acquireSshSlot });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(h.service.start("paseo", {}, { acquireSshSlot: h.acquireSshSlot }), { status: 409, message: /正在启动 T3 Code/ });
  const during = await h.service.status(null, { acquireSshSlot: h.acquireSshSlot, fresh: true });
  assert.equal(during.starting, "t3code");
  releaseRemote();
  assert.equal((await first).result, "started");
  const again = await h.service.start("paseo", {}, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(again.ok, true);
  assert.equal(h.logs.filter(([m]) => m.endsWith("requested")).length, 2, "被拒的那次不发 SSH、不记日志");
});

test("启动：未知守护进程 400、非活跃服务器 409、个人服务器 404、缺 SSH 调度 503——都不发 SSH", async () => {
  const h = harness();
  await assert.rejects(h.service.start("rm -rf", {}, { acquireSshSlot: h.acquireSshSlot }), { status: 400 });
  await assert.rejects(h.service.start("paseo", { serverId: "other" }, { acquireSshSlot: h.acquireSshSlot }), { status: 409 });
  await assert.rejects(h.service.start("paseo", {}, {}), { status: 503 });
  const personal = harness({ servers: [{ id: "p1", host: "h", source: "personal" }], activeServerId: "p1" });
  await assert.rejects(personal.service.start("paseo", {}, { acquireSshSlot: personal.acquireSshSlot }), { status: 404 });
  assert.equal(h.calls.length + personal.calls.length, 0);
});

test("Paseo 启动脚本：内嵌中继走代理预加载（写入 + NODE_OPTIONS），源码可安全放进 heredoc；T3 与状态脚本不带", () => {
  const paseo = DAEMONS.find((d) => d.id === "paseo").script;
  assert.match(paseo, /<<'PRELOAD_EOF'/);
  assert.match(paseo, /export NODE_OPTIONS="--require \$HOME\/\.paseo\/relay-proxy\.cjs \$\{NODE_OPTIONS:-\}"/);
  assert.ok(paseo.includes(RELAY_PROXY_PRELOAD_SOURCE), "预加载源码原样内嵌");
  assert.ok(paseo.indexOf("PRELOAD_EOF\n", paseo.indexOf("<<'PRELOAD_EOF'") + 20) > 0, "heredoc 有结束行");
  // 源码约束：无反引号、无 "${"、没有单独成行的结束标记（否则 String.raw / heredoc 会被截断）。
  assert.doesNotMatch(RELAY_PROXY_PRELOAD_SOURCE, /`|\$\{/);
  assert.doesNotMatch(RELAY_PROXY_PRELOAD_SOURCE, /^PRELOAD_EOF$/m);
  assert.match(RELAY_PROXY_PRELOAD_SOURCE, /paseo\\\.sh/);
  for (const d of DAEMONS.filter((x) => x.id !== "paseo")) assert.doesNotMatch(d.script, /NODE_OPTIONS|PRELOAD_EOF/);
  assert.doesNotMatch(DAEMON_STATUS_SCRIPT, /NODE_OPTIONS|PRELOAD_EOF/);
});

// ---- v2.56：Paseo 中继走本账号自己的反向端口 ----

test("Paseo 中继端口：只前置一行 export 合法端口；T3 与状态脚本不带；非法端口抛错；预加载不再默认 7891", () => {
  const p = buildDaemonInvocation(["h"], "paseo", { relayProxyPort: 7892 });
  assert.equal(p.input, `export PASEO_RELAY_PROXY_PORT=7892\n${daemonDef("paseo").script}`);
  assert.equal(buildDaemonInvocation(["h"], "paseo").input, daemonDef("paseo").script, "没有端口就不导出，预加载不套隧道");
  assert.equal(buildDaemonInvocation(["h"], "t3code", { relayProxyPort: 7892 }).input, daemonDef("t3code").script);
  assert.equal(buildDaemonInvocation(["h"], null, { relayProxyPort: 7892 }).input, DAEMON_STATUS_SCRIPT);
  for (const bad of ["7892; reboot", 0, 70000, "abc"]) assert.throws(() => buildDaemonInvocation(["h"], "paseo", { relayProxyPort: bad }), String(bad));
  assert.doesNotMatch(RELAY_PROXY_PRELOAD_SOURCE, /7891/);
  assert.match(RELAY_PROXY_PRELOAD_SOURCE, /if \(!PROXY_OK \|\| !opts/);
  assert.match(daemonDef("paseo").script, /relay-proxy\.port/);
  assert.equal(relayPortOf({ remotePort: 7893 }), 7893);
  assert.equal(relayPortOf({}), null);
  assert.equal(relayPortOf({ remotePort: "x" }), null);
});

test("Paseo 启动：用合并后配置里本账号的端口（7891 / 7892 / 8022）；没领端口 → 409 且不发 SSH", async () => {
  for (const port of [7891, 7892, 8022]) {
    const h = harness({ servers: [{ id: "s1", host: "u@h", remotePort: port }], respond: () => ({ code: 0, stdout: `result=started\n${RUNNING}`, stderr: "" }) });
    const res = await h.service.start("paseo", { serverId: "s1" }, { acquireSshSlot: h.acquireSshSlot });
    assert.equal(res.result, "started");
    assert.ok(h.calls[0].invocation.input.startsWith(`export PASEO_RELAY_PROXY_PORT=${port}\n`), String(port));
  }
  const h = harness({ servers: [{ id: "s1", host: "u@h" }], respond: () => ({ code: 0, stdout: `result=started\n${RUNNING}`, stderr: "" }) });
  await assert.rejects(h.service.start("paseo", { serverId: "s1" }, { acquireSshSlot: h.acquireSshSlot }), (err) => err.status === 409 && /领取反向端口/.test(err.message));
  assert.equal(h.calls.length, 0);
  const t3 = await h.service.start("t3code", { serverId: "s1" }, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(t3.ok, true, "T3 不走中继，没端口照常可启动");
});

test("Paseo 状态：已在运行但启动时用的中继端口与现在不同 → 说明里提示，不自动重启", () => {
  const def = daemonDef("paseo");
  const parsed = parseDaemonOutput(RUNNING.replace("paseo.port=1", "paseo.port=1\npaseo.relayport=7891"));
  assert.match(daemonView(def, parsed, { expectedRelayPort: 7892 }).note, /端口 7891.*7892/);
  assert.equal(daemonView(def, parsed, { expectedRelayPort: 7891 }).note, "");
  assert.equal(daemonView(def, parseDaemonOutput(RUNNING), { expectedRelayPort: 7892 }).note, "", "没有记录（旧版启动）不猜");
});

// ---- v2.62 服务直达：状态里的服务列表与转发把关（转发管理器用记录型替身，不起任何进程）----

const SERVICES = [
  'ss=LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("python",pid=3301234,fd=3))',
  'ss=LISTEN 0 5 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=2200001,fd=4))',
  'ss=LISTEN 0 128 [::1]:5173 [::]:* users:(("node",pid=600,fd=20))',
  'ss=LISTEN 0 128 10.1.2.3:7100 0.0.0.0:* users:(("java",pid=701,fd=9))',
  'ss=LISTEN 0 128 127.0.0.1:6767 0.0.0.0:* users:(("Paseo Daemon",pid=211354,fd=23))',
  'ss=LISTEN 0 128 127.0.0.1:3773 0.0.0.0:* users:(("t3",pid=1500001,fd=30))',
  'ss=LISTEN 0 128 127.0.0.1:7891 0.0.0.0:* users:(("sshd",pid=800001,fd=9))',
  "proc=3301234\t/public/home/kai/outputs/report\tpython -m http.server 8814 --bind 127.0.0.1",
  ...[2200001, 600, 701, 211354, 1500001, 800001].map((pid) => `proc=${pid}\t\t`),
  "age=3301234 11520",
  "svc.home=/public/home/kai",
];
const withServices = (lines = SERVICES, state = "ok", base = RUNNING) => base.replace("end=1", [...lines, ...(state ? [`svc.state=${state}`] : []), "end=1"].join("\n"));

function fakeForwards() {
  const calls = [];
  const open = new Map(); // "serverId:port" → { view, baseKey }
  const baseKeyFor = (server, config) => (server ? JSON.stringify([server.host, server.sshUser || config?.sshUser || ""]) : null);
  const drop = (predicate, reason) => {
    let closed = 0;
    for (const [key, entry] of [...open]) {
      if (!predicate({ ...entry.view, baseKey: entry.baseKey })) continue;
      open.delete(key);
      calls.push(["closed", entry.view.serverId, entry.view.port, reason]);
      closed += 1;
    }
    return closed;
  };
  return {
    calls,
    limit: 4,
    baseKeyFor,
    list: (serverId = null) => [...open.values()].map((entry) => entry.view).filter((view) => serverId == null || view.serverId === serverId),
    open: async ({ server, config, remotePort, remoteHost, acquireSshSlot }) => {
      calls.push(["open", server.id, remotePort, remoteHost, typeof acquireSshSlot]);
      const view = { serverId: server.id, port: remotePort, localPort: 51000 + remotePort % 1000, url: `http://127.0.0.1:${51000 + remotePort % 1000}/`, startedAt: 1, expiresAt: 2 };
      open.set(`${server.id}:${remotePort}`, { view, baseKey: baseKeyFor(server, config) });
      return view;
    },
    close: (serverId, port, reason) => drop((entry) => entry.serverId === serverId && entry.port === port, reason) > 0,
    closeIf: drop,
    reconcile: (serverId, ports, asOf) => {
      calls.push(["reconcile", serverId, [...ports].sort((a, b) => a - b), asOf]);
      return drop((entry) => entry.serverId === serverId && !ports.has(entry.port), "gone");
    },
  };
}

test("状态：同一次 SSH 带回本人监听的服务（不含 sshd、已单列的 Paseo / T3 端口）；转发现取不进缓存", async () => {
  const forwards = fakeForwards();
  const h = harness({ forwards, respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
  const view = await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1, "没有为服务列表多发 SSH");
  assert.equal(h.calls[0].invocation.input, DAEMON_STATUS_SCRIPT);
  assert.deepEqual(view.daemons.map((d) => d.state), ["running", "running"]);
  assert.deepEqual(view.services.map((s) => [s.port, s.name, s.scope, s.forwardable]), [
    [5173, "node", "loopback", true], [7100, "java", "address", false], [8765, "python", "all", true], [8814, "python", "loopback", true],
  ]);
  assert.deepEqual(view.services.find((s) => s.port === 8814), {
    port: 8814, name: "python", pid: 3301234, procCount: 1, binds: ["127.0.0.1"], scope: "loopback", forwardable: true,
    cmdline: "python -m http.server 8814 --bind 127.0.0.1", cwd: "~/outputs/report", uptimeSec: 11520,
    kind: { id: "http-server", label: "静态文件服务" },
  });
  assert.deepEqual([view.servicesState, view.servicesMore, view.forwardBlocked, view.forwards, view.forwardLimit], ["ok", 0, null, [], 4]);
  assert.deepEqual(forwards.calls, [["reconcile", "s1", [5173, 7100, 8765, 8814], 1_000_000]], "列全了的清单交给管理器收回已经不在的转发，带上查询发出的时刻");
  // 开一条之后，10 秒内的缓存结果也带着它（转发是每次现取的）。
  await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
  const cached = await h.service.status("s1", { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(cached.forwards.map((f) => [f.port, f.localPort]), [[8814, 51814]]);
});

test("状态：装配处没给转发管理器时照样列服务，只是标明不能转发；密码连接的服务器标 password", async () => {
  const plain = harness({ respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
  const view = await plain.service.status(null, { acquireSshSlot: plain.acquireSshSlot });
  assert.deepEqual([view.services.length, view.forwardBlocked, view.forwards, view.forwardLimit], [4, "unavailable", [], 0]);
  await assert.rejects(plain.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: plain.acquireSshSlot }), { status: 503 });
  await assert.rejects(plain.service.closeForward({ serverId: "s1", port: 8814 }), { status: 503 });
  assert.equal(plain.service.onConfigRefreshed(plain.config), 0);
  const password = harness({ forwards: fakeForwards(), servers: [{ id: "s1", host: "u@h", authRef: "vault:s1" }], respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
  assert.equal((await password.service.status(null, { acquireSshSlot: password.acquireSshSlot })).forwardBlocked, "password");
});

test("状态：这一轮没列出来（SSH 失败 / 没有 ss / ss 没跑成 / 被截断 / 旧脚本没有这一段）都不算「服务没了」，不收回转发", async () => {
  for (const [stdout, state, count] of [
    [withServices(SERVICES, "trunc"), "trunc", 4],
    [withServices([], "unavailable"), "unavailable", 0],
    [withServices([], "failed"), "failed", 0],
    [RUNNING, "unknown", 0],
  ]) {
    const forwards = fakeForwards();
    const h = harness({ forwards, respond: () => ({ code: 0, stdout, stderr: "" }) });
    const view = await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
    assert.deepEqual([view.reachable, view.servicesState, view.services.length], [true, state, count], state);
    assert.deepEqual(forwards.calls, [], state);
  }
  const forwards = fakeForwards();
  const down = harness({ forwards, respond: () => ({ code: 255, stdout: "", stderr: "Permission denied (publickey)" }) });
  const view = await down.service.status(null, { acquireSshSlot: down.acquireSshSlot });
  assert.deepEqual([view.reachable, view.servicesState, view.services], [false, "unknown", []]);
  assert.deepEqual(forwards.calls, []);
});

test("转发：只认最近一次列表里的端口；转发目标由列表里的监听地址决定，请求里没有主机", async () => {
  const forwards = fakeForwards();
  const h = harness({ forwards, respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
  await h.service.status(null, { acquireSshSlot: h.acquireSshSlot });
  forwards.calls.length = 0;
  const res = await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual(res.forward, { serverId: "s1", port: 8814, localPort: 51814, url: "http://127.0.0.1:51814/", startedAt: 1, expiresAt: 2 });
  assert.deepEqual(res.status.forwards.map((f) => f.port), [8814], "返回里带最新状态，界面不用再读一次");
  assert.deepEqual(forwards.calls, [["open", "s1", 8814, "127.0.0.1", "function"]]);
  await h.service.forward({ serverId: "s1", port: 5173 }, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual(forwards.calls.at(-1), ["open", "s1", 5173, "[::1]", "function"], "只绑 ::1 的服务走 [::1]");
  await h.service.forward({ serverId: "s1", port: 8765 }, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual(forwards.calls.at(-1), ["open", "s1", 8765, "127.0.0.1", "function"], "0.0.0.0 上的服务从回环连");
  assert.equal(h.calls.length, 1, "列表还新鲜时不为转发多发状态查询");

  const before = forwards.calls.length;
  await assert.rejects(h.service.forward({ serverId: "s1", port: 9999 }, { acquireSshSlot: h.acquireSshSlot }), (err) => err.status === 409 && /端口 9999 不在最近一次的服务列表里/.test(err.message));
  await assert.rejects(h.service.forward({ serverId: "s1", port: 7100 }, { acquireSshSlot: h.acquireSshSlot }), (err) => err.status === 409 && /只绑定在 10\.1\.2\.3.*不能转发/.test(err.message));
  // 列表里被剔除的端口同样不能转发：守护进程自己的端口、sshd 的反向隧道端口、1024 以下。
  for (const port of [6767, 3773, 7891]) await assert.rejects(h.service.forward({ serverId: "s1", port }, { acquireSshSlot: h.acquireSshSlot }), { status: 409 }, String(port));
  for (const port of [22, 0, 70000, "8814", 8814.5, null, undefined]) await assert.rejects(h.service.forward({ serverId: "s1", port }, { acquireSshSlot: h.acquireSshSlot }), { status: 400 }, String(port));
  assert.equal(forwards.calls.length, before, "被拒的请求到不了管理器");
});

test("转发：列表超过 90 秒先重查一次再判断；重查没成功就不转发；从没查过时自己查一次", async () => {
  let stdout = withServices();
  let code = 0;
  const forwards = fakeForwards();
  const h = harness({ forwards, respond: () => ({ code, stdout: code === 0 ? stdout : "", stderr: code === 0 ? "" : "Connection timed out" }) });
  // 冷启动：没有列表 → 自己查一次。
  await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1);
  h.tick(FORWARD_LISTING_MAX_AGE_MS);
  await h.service.forward({ serverId: "s1", port: 8765 }, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1, "正好 90 秒还算新鲜");
  // 过期：重查；这时 5173 已经不在了 → 拒绝（不凭旧列表转发）。
  h.tick(1);
  stdout = withServices(SERVICES.filter((line) => !line.includes(":5173 ")));
  await assert.rejects(h.service.forward({ serverId: "s1", port: 5173 }, { acquireSshSlot: h.acquireSshSlot }), (err) => err.status === 409 && /不在最近一次的服务列表里/.test(err.message));
  assert.equal(h.calls.length, 2);
  // 过期 + 重查失败：拒绝并说明，不调管理器。
  h.tick(FORWARD_LISTING_MAX_AGE_MS + 1);
  code = 255;
  const opened = forwards.calls.filter((call) => call[0] === "open").length;
  await assert.rejects(h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot }), (err) => err.status === 409 && /这一轮没拿到 主集群 上的服务列表/.test(err.message));
  assert.equal(h.calls.length, 3);
  assert.equal(forwards.calls.filter((call) => call[0] === "open").length, opened);
  // 服务器上没有 ss：列表不可用，同样拒绝。
  const noSs = harness({ forwards: fakeForwards(), respond: () => ({ code: 0, stdout: withServices([], "unavailable"), stderr: "" }) });
  await assert.rejects(noSs.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: noSs.acquireSshSlot }), (err) => err.status === 409 && /没拿到/.test(err.message));
});

test("转发：密码连接 409、不是查看中的服务器 409、个人服务器 404、缺 SSH 调度 503——都不发 SSH、不起转发", async () => {
  const forwards = fakeForwards();
  const password = harness({ forwards, servers: [{ id: "s1", host: "u@h", authRef: "vault:s1" }] });
  await assert.rejects(password.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: password.acquireSshSlot }), (err) => err.status === 409 && /用密码连接/.test(err.message));
  const h = harness({ forwards });
  await assert.rejects(h.service.forward({ serverId: "other", port: 8814 }, { acquireSshSlot: h.acquireSshSlot }), { status: 409 });
  await assert.rejects(h.service.forward({ serverId: "s1", port: 8814 }, {}), { status: 503 });
  const personal = harness({ forwards, servers: [{ id: "p1", host: "h", source: "personal" }], activeServerId: "p1" });
  await assert.rejects(personal.service.forward({ serverId: "p1", port: 8814 }, { acquireSshSlot: personal.acquireSshSlot }), { status: 404 });
  assert.equal(password.calls.length + h.calls.length + personal.calls.length, 0);
  assert.deepEqual(forwards.calls, []);
});

test("关闭转发：只按「服务器 + 端口」结束自己那一条；没有这条不算错；参数不合格 400", async () => {
  const forwards = fakeForwards();
  const h = harness({ forwards, respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
  await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
  const res = await h.service.closeForward({ serverId: "s1", port: 8814 });
  assert.deepEqual([res.closed, res.serverId, res.port, res.status.forwards], [true, "s1", 8814, []]);
  assert.deepEqual(forwards.calls.at(-1), ["closed", "s1", 8814, "manual"]);
  assert.equal((await h.service.closeForward({ serverId: "s1", port: 8814 })).closed, false);
  assert.equal((await h.service.closeForward({ serverId: "elsewhere", port: 8814 })).status, null, "别的服务器上的也能关，只是不带这台的状态");
  for (const bad of [{ port: 8814 }, { serverId: "s1" }, { serverId: "s1", port: "8814" }, { serverId: 1, port: 8814 }, {}]) await assert.rejects(h.service.closeForward(bad), { status: 400 });
  assert.equal(h.calls.length, 1, "关闭不发 SSH");
});

test("启动守护进程带回来的服务列表同样记下并用于收回转发", async () => {
  const forwards = fakeForwards();
  const h = harness({ forwards, respond: (inv) => ({ code: 0, stdout: inv.input === DAEMON_STATUS_SCRIPT ? withServices() : withServices(SERVICES.filter((line) => !line.includes(":8814 ")), "ok", `result=started\n${RUNNING}`), stderr: "" }) });
  await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
  h.tick(500);
  const res = await h.service.start("t3code", { serverId: "s1" }, { acquireSshSlot: h.acquireSshSlot });
  assert.deepEqual(res.status.services.map((s) => s.port), [5173, 7100, 8765]);
  assert.deepEqual(forwards.calls.slice(-2), [["reconcile", "s1", [5173, 7100, 8765], 1_000_500], ["closed", "s1", 8814, "gone"]]);
  assert.deepEqual(res.status.forwards, []);
  await assert.rejects(h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot }), { status: 409 });
});

test("配置热载：模块关掉、服务器被删 / 停用 / 改成密码连接、连接参数变了 → 收回它名下的转发；其余不动", async () => {
  const servers = [{ id: "s1", name: "主集群", host: "kai@h" }, { id: "s2", host: "kai@h2" }];
  const setup = async () => {
    const forwards = fakeForwards();
    const h = harness({ forwards, servers, respond: () => ({ code: 0, stdout: withServices(), stderr: "" }) });
    await h.service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot: h.acquireSshSlot });
    await forwards.open({ server: servers[1], config: h.config, remotePort: 9000, remoteHost: "127.0.0.1" });
    forwards.calls.length = 0;
    return { forwards, h };
  };
  const closedBy = async (config) => {
    const { forwards, h } = await setup();
    const count = h.service.onConfigRefreshed(config);
    assert.equal(count, forwards.calls.length);
    return forwards.calls.map((call) => call.slice(1)).sort();
  };
  const base = { activeServerId: "s1", servers, modules: { usage: true, jobs: true, daemons: true } };
  assert.deepEqual(await closedBy(base), [], "配置没变什么都不动");
  assert.deepEqual(await closedBy({ ...base, activeServerId: "s2" }), [], "只是换了查看的服务器：转发留着");
  assert.deepEqual(await closedBy({ ...base, modules: { daemons: false } }), [["s1", 8814, "config"], ["s2", 9000, "config"]]);
  assert.deepEqual(await closedBy({ ...base, servers: [servers[0]] }), [["s2", 9000, "config"]], "服务器被删");
  assert.deepEqual(await closedBy({ ...base, servers: [{ ...servers[0], disabled: true }, servers[1]] }), [["s1", 8814, "config"]]);
  assert.deepEqual(await closedBy({ ...base, servers: [{ ...servers[0], monitorEnabled: false }, servers[1]] }), [["s1", 8814, "config"]]);
  assert.deepEqual(await closedBy({ ...base, servers: [{ ...servers[0], authRef: "vault:s1" }, servers[1]] }), [["s1", 8814, "config"]]);
  assert.deepEqual(await closedBy({ ...base, servers: [{ ...servers[0], source: "personal" }, servers[1]] }), [["s1", 8814, "config"]]);
  assert.deepEqual(await closedBy({ ...base, servers: [servers[0], { ...servers[1], host: "kai@moved" }] }), [["s2", 9000, "config"]], "连接参数变了");
  assert.deepEqual(await closedBy({ ...base, sshUser: "someone-else" }), [["s1", 8814, "config"], ["s2", 9000, "config"]], "全局登录名变了，两台都受影响");
  assert.deepEqual(await closedBy(null), [["s1", 8814, "config"], ["s2", 9000, "config"]], "读不到配置时按「都不在了」收回");
});
