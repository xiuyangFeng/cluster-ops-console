// fixture 模式下的远端守护进程：状态 / 启动 / 服务列表 / 转发一律不发 SSH、不起进程。
// 三层：假数据本身；守护进程服务在 fixtureMode 下不碰任何真实出口；真起一份 fixture 监控（PATH 里只有一个
// 只会记账的假 ssh）把四个接口都打一遍，假 ssh 一次也没被调用。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawnFixtureMonitor } from "../fixture-monitor.mjs";
import { DAEMONS, daemonView, parseDaemonOutput } from "./commands.mjs";
import { createDaemonsFixture } from "./fixture.mjs";
import { collectReservedPorts } from "./forward-spec.mjs";
import { FORWARD_LIMIT, pickFreeLocalPort } from "./forwards.mjs";
import { createDaemonsService } from "./service.mjs";
import { buildServices, parseServiceOutput } from "./services.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
// 本进程当前持有的子进程 / 监听套接字个数：假转发前后都不该变。
const handles = () => {
  const kinds = process.getActiveResourcesInfo();
  return { children: kinds.filter((kind) => kind === "ProcessWrap").length, listeners: kinds.filter((kind) => kind === "TCPServerWrap").length };
};
const SERVER = { id: "s1", name: "主集群", host: "fixture.invalid" };

test("假数据：远端输出与真实脚本同形，照常解析出两个守护进程与三个服务；「启动」只改内存里的状态", () => {
  const fixture = createDaemonsFixture();
  const first = fixture.remote();
  assert.deepEqual([first.code, first.stderr, first.timedOut], [0, "", false]);
  const parsed = parseDaemonOutput(first.stdout);
  assert.equal(parsed.complete, true);
  assert.deepEqual(DAEMONS.map((def) => [def.id, daemonView(def, parsed).state]), [["paseo", "running"], ["t3code", "stopped"]]);
  const services = buildServices(parseServiceOutput(first.stdout), { excludePorts: DAEMONS.map((def) => def.port) });
  assert.deepEqual([services.state, services.complete], ["ok", true]);
  assert.deepEqual(services.services.map((s) => [s.port, s.name, s.scope, s.target, s.cwd]), [
    [5173, "node", "loopback", "[::1]", "~/web"],
    [8765, "python", "all", "127.0.0.1", "~/dashboard"],
    [8814, "python", "loopback", "127.0.0.1", "~/reports/demo"],
  ]);
  // 启动：第一次 started，之后 already；状态随之变成运行中。别的实例互不影响。
  assert.equal(parseDaemonOutput(fixture.remote("t3code").stdout).values.result, "started");
  assert.equal(daemonView(DAEMONS[1], parseDaemonOutput(fixture.remote().stdout)).state, "running");
  assert.equal(parseDaemonOutput(fixture.remote("t3code").stdout).values.result, "already");
  assert.equal(parseDaemonOutput(fixture.remote("paseo").stdout).values.result, "already");
  assert.equal(daemonView(DAEMONS[1], parseDaemonOutput(createDaemonsFixture().remote().stdout)).state, "stopped");
});

test("假转发：上限、重复打开、关闭、随列表收回都照常，但不起任何进程、不监听任何端口", async () => {
  const before = handles();
  const { forwards } = createDaemonsFixture();
  const a = await forwards.open({ server: SERVER, config: {}, remotePort: 8814 });
  assert.deepEqual([a.serverId, a.port, a.localPort, a.url], ["s1", 8814, 52000, "http://127.0.0.1:52000/"]);
  assert.equal(a.expiresAt - a.startedAt, forwards.ttlMs);
  assert.deepEqual(await forwards.open({ server: SERVER, config: {}, remotePort: 8814 }), a, "已经开着就返回同一条");
  assert.deepEqual(handles(), before, "开着一条假转发：没有子进程，也没有监听套接字（本机端口只是个数字）");
  for (const port of [8765, 5173, 9000]) await forwards.open({ server: SERVER, config: {}, remotePort: port, remoteHost: port === 5173 ? "[::1]" : "127.0.0.1" });
  assert.equal(forwards.list("s1").length, FORWARD_LIMIT);
  await assert.rejects(forwards.open({ server: SERVER, config: {}, remotePort: 9001 }), { status: 409 });
  assert.equal(forwards.reconcile("s1", new Set([8814, 8765, 5173])), 1, "列表里没有的 9000 被收回");
  assert.equal(forwards.close("s1", 8814), true);
  assert.deepEqual(forwards.list("s1").map((f) => f.port), [5173, 8765]);
  assert.deepEqual(await forwards.sweepOrphans(), { stopped: 0, removed: 0, kept: 0 });
  forwards.beginShutdown();
  await forwards.dispose();
  assert.deepEqual(forwards.list(), []);
  assert.deepEqual(handles(), before, "全程没有起过子进程、没有监听过端口");
});

// 任何一次访问都记下来并抛错的替身：fixture 模式下，真实的出口一个都不许碰。
function trap(name, touched) {
  return new Proxy(() => {}, {
    get: (_target, prop) => {
      touched.push(`${name}.${String(prop)}`);
      throw new Error(`${name} must not be touched in fixture mode`);
    },
    apply: () => {
      touched.push(`${name}()`);
      throw new Error(`${name} must not be called in fixture mode`);
    },
  });
}

test("守护进程服务在 fixture 模式下：状态 / 启动 / 转发 / 关闭全程不组装 SSH 参数、不调执行器、不占调度槽位、不用真的转发管理器", async () => {
  const touched = [];
  const before = handles();
  const config = { activeServerId: "s1", servers: [{ ...SERVER, remotePort: 17891 }], modules: { daemons: true } };
  const logs = [];
  const service = createDaemonsService({
    getConfig: async () => config,
    getMainServerConfig: (c) => c.servers.find((s) => s.id === c.activeServerId) || null,
    sshArgsFor: trap("sshArgsFor", touched),
    execCollector: trap("execCollector", touched),
    probeSshFailureReason: trap("probeSshFailureReason", touched),
    forwards: trap("realForwards", touched),
    fixtureMode: true,
    log: (message) => logs.push(message),
  });
  let slots = 0;
  const acquireSshSlot = async () => {
    slots += 1;
    return () => {};
  };

  const view = await service.status("s1", { acquireSshSlot });
  assert.deepEqual([view.eligible, view.reachable, view.error, view.forwardBlocked, view.forwardLimit], [true, true, null, null, FORWARD_LIMIT]);
  assert.deepEqual(view.daemons.map((d) => [d.id, d.state]), [["paseo", "running"], ["t3code", "stopped"]]);
  assert.deepEqual(view.services.map((s) => [s.port, s.forwardable]), [[5173, true], [8765, true], [8814, true]]);
  assert.deepEqual((await service.status("s1", { acquireSshSlot, fresh: true })).services.length, 3, "「刷新」也一样");

  const started = await service.start("t3code", { serverId: "s1" }, { acquireSshSlot });
  assert.deepEqual([started.result, started.ok, started.status.daemons[1].state], ["started", true, "running"]);
  assert.equal((await service.start("paseo", { serverId: "s1" }, { acquireSshSlot })).result, "alreadyRunning");

  const opened = await service.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot });
  assert.match(opened.forward.url, /^http:\/\/127\.0\.0\.1:52\d{3}\/$/);
  assert.deepEqual(opened.status.forwards.map((f) => f.port), [8814]);
  assert.deepEqual(handles(), before, "转发「开着」的时候也没有子进程与监听套接字");
  await assert.rejects(service.forward({ serverId: "s1", port: 9999 }, { acquireSshSlot }), { status: 409 }, "把关照旧：不在列表里的端口不转发");
  assert.deepEqual((await service.status("s1", { acquireSshSlot })).forwards.map((f) => f.port), [8814]);
  const closed = await service.closeForward({ serverId: "s1", port: 8814 });
  assert.deepEqual([closed.closed, closed.status.forwards], [true, []]);
  assert.equal(service.onConfigRefreshed(config), 0);

  assert.deepEqual(touched, [], "真实的出口一个都没碰");
  assert.equal(slots, 0, "没有 SSH 可发，不占调度槽位");
  assert.deepEqual(handles(), before, "没有起过子进程、没有监听过端口");
  assert.ok(logs.some((message) => /^daemons start t3code on s1: started$/.test(message)), "动作照常记运维日志");

  // 对照：同样的装配、不开 fixtureMode，第一步就会去组装 SSH 参数——上面的「没碰」不是替身没接上。
  const live = createDaemonsService({
    getConfig: async () => config,
    getMainServerConfig: (c) => c.servers.find((s) => s.id === c.activeServerId) || null,
    sshArgsFor: trap("sshArgsFor", touched),
    execCollector: trap("execCollector", touched),
    probeSshFailureReason: () => "ssh exit null",
  });
  assert.equal((await live.status("s1", { acquireSshSlot })).reachable, false);
  assert.deepEqual(touched, ["sshArgsFor()"]);
});

// 真起一份 fixture 监控。监控进程的 PATH 里只有一个目录，里面的 ssh / scp / sftp 都是只记账、以 255 退出的假货：
// 就算哪条路径真的去 spawn("ssh")，也只可能落到它们（真正的 ssh 不在 PATH 上），并在记账文件里留下一行。
// 配置里唯一的服务器是 fixture.invalid。Windows 上没法照这个办法摆假 ssh，跳过。
test("fixture 监控：/api/daemons 的状态、启动、转发、关闭都应答假数据，一次 ssh 也不发", { skip: process.platform === "win32" }, async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "daemons-fixture-monitor-"));
  const fakeBin = path.join(tmp, "bin");
  const sshLog = path.join(tmp, "fake-ssh.log");
  mkdirSync(fakeBin);
  for (const name of ["ssh", "scp", "sftp"]) {
    writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${sshLog}"\nexit 255\n`);
    chmodSync(path.join(fakeBin, name), 0o755);
  }
  const teamConfig = JSON.parse(readFileSync(path.join(repoRoot, "config.json"), "utf8"));
  teamConfig.activeServerId = "fixture-server";
  teamConfig.servers = [{ id: "fixture-server", name: "Fixture", host: "fixture.invalid", localPort: 18888, remotePort: 17891 }];
  writeFileSync(path.join(tmp, "config.json"), JSON.stringify(teamConfig));
  const port = await pickFreeLocalPort({ reserved: collectReservedPorts(null, [7891, 7892, 7893, 7894]) });
  const token = randomBytes(16).toString("hex");

  // spawnFixtureMonitor 把当前环境带给子进程：只在 spawn 的那一刻把 PATH 换成假目录，随即还原。
  const savedPath = process.env.PATH;
  let monitor;
  try {
    process.env.PATH = fakeBin;
    monitor = spawnFixtureMonitor({
      command: process.execPath, script: "work/monitor/monitor-server.mjs", cwd: repoRoot, port, authToken: token,
      dataDir: path.join(tmp, "data"), configPath: path.join(tmp, "config.json"), localConfigPath: path.join(tmp, "config.local.json"),
    });
  } finally {
    process.env.PATH = savedPath;
  }
  t.after(async () => {
    await monitor.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "x-auth-token": token, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    return { status: res.status, json: await res.json() };
  };
  // 等监控服务起来（机器忙的时候起一个 node 进程要好几秒，时限放宽）。
  const deadline = Date.now() + 90000;
  for (;;) {
    if (monitor.child.exitCode != null) assert.fail(`fixture 监控启动后退出了：${monitor.output().slice(-600)}`);
    try {
      if ((await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) })).ok) break;
    } catch {}
    if (Date.now() > deadline) assert.fail(`fixture 监控 90 秒内没有就绪：${monitor.output().slice(-600)}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const status = await call("GET", "/api/daemons?serverId=fixture-server&fresh=1");
  assert.equal(status.status, 200);
  assert.deepEqual([status.json.eligible, status.json.reachable, status.json.serverId, status.json.forwardBlocked], [true, true, "fixture-server", null]);
  assert.deepEqual(status.json.daemons.map((d) => [d.id, d.state]), [["paseo", "running"], ["t3code", "stopped"]]);
  assert.deepEqual(status.json.services.map((s) => s.port), [5173, 8765, 8814]);

  const started = await call("POST", "/api/daemons/start", { daemon: "t3code", serverId: "fixture-server" });
  assert.deepEqual([started.status, started.json.result, started.json.status.daemons[1].state], [200, "started", "running"]);

  const opened = await call("POST", "/api/daemons/forward", { serverId: "fixture-server", port: 8814 });
  assert.equal(opened.status, 200);
  assert.match(opened.json.forward.url, /^http:\/\/127\.0\.0\.1:52\d{3}\/$/);
  assert.deepEqual((await call("GET", "/api/daemons?serverId=fixture-server")).json.forwards.map((f) => f.port), [8814]);
  assert.equal((await call("POST", "/api/daemons/forward", { serverId: "fixture-server", port: 9999 })).status, 409);
  const closed = await call("POST", "/api/daemons/forward/close", { serverId: "fixture-server", port: 8814 });
  assert.deepEqual([closed.status, closed.json.closed, closed.json.status.forwards], [200, true, []]);

  assert.equal(existsSync(sshLog), false, existsSync(sshLog) ? `fixture 监控调用了 ssh：${readFileSync(sshLog, "utf8").slice(0, 400)}` : "");
});
