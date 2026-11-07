// 服务直达（v2.62）的接线守卫。生产装配（server/start.mjs）不便在 node:test 里真跑——非 fixture 模式会去
// 接管守护进程与隧道——所以这里锁源码里的几处接线，另用真实的工具箱验证「转发管理器确实交到了守护进程服务手里」。
// 行为层面的覆盖在 work/monitor/lib/daemons/{services,forwards,service}.test.mjs。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMPONENT_ENTRIES, listImportClosure } from "../work/monitor/lib/component-version.mjs";
import { createChannelToolkit } from "../work/monitor/lib/probes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("装配：转发管理器只在非 fixture 模式创建，带进程注册表、运行目录与要避开的端口来源；监听成功之后才清孤儿", () => {
  const start = read("work/monitor/server/start.mjs");
  const create = start.match(/const serviceForwards = fixtureMode \? null : createServiceForwards\(\{([\s\S]*?)\n {2}\}\);/);
  assert.ok(create, "fixture 模式绝不起进程：不创建转发管理器");
  for (const wiring of [/\bregistry,/, /\bruntimeDir,/, /monitorPort: port,/, /getConfig: getMergedConfig,/, /sshArgsFor: \(server, config\) => buildPinnedProbeSshArgs\(server, config, \{ dataDir: paths\.dataRoot \}\)/, /log: appendLog,/]) {
    assert.match(create[1], wiring);
  }
  assert.doesNotMatch(create[1], /spawnImpl|execImpl|sshCommand/, "生产里用真正的 ssh，不注入替身");
  // 交给工具箱（守护进程服务）与关停顺序。
  const toolkitArgs = start.match(/const toolkit = createChannelToolkit\(\{([\s\S]*?)\n {2}\}\);/)[1];
  assert.match(toolkitArgs, /^ {4}serviceForwards,$/m);
  assert.match(toolkitArgs, /^ {4}fixtureMode,$/m, "fixture 实例里守护进程服务整段走假数据：fixtureMode 必须交给工具箱");
  assert.match(start.match(/late\.shutdown = createShutdown\(\{([\s\S]*?)\n {2}\}\);/)[1], /^ {4}serviceForwards,$/m);
  assert.match(start, /late\.daemons = toolkit\.daemons;/);
  // 孤儿清理挂在 listening 上，且排在 listen 调用之后：重复启动的第二份监听失败就退出，轮不到它去清。
  const listen = start.indexOf("httpServer.listen(port,");
  const sweep = start.indexOf('if (serviceForwards) httpServer.server.once("listening", () => serviceForwards.sweepOrphans().catch(() => {}));');
  assert.ok(listen > 0 && sweep > listen, "sweepOrphans 只在监听成功后调用");
  assert.equal(start.match(/sweepOrphans/g).length, 1);
});

test("装配：配置热载通知守护进程服务收回不再合规的转发；关停时转发先收到信号、最后确认", () => {
  const refresh = read("work/monitor/server/config-refresh.mjs");
  assert.match(refresh, /try \{\n\s+late\.daemons\?\.onConfigRefreshed\?\.\(parsed\);\n\s+\} catch \{\}/);
  const lifecycle = read("work/monitor/server/lifecycle.mjs");
  const begin = lifecycle.indexOf("serviceForwards?.beginShutdown()");
  const drain = lifecycle.indexOf("await httpServer.drainPendingRequests()");
  const flush = lifecycle.indexOf("await flushServices()");
  const dispose = lifecycle.indexOf("await serviceForwards?.dispose()");
  assert.ok(begin > 0 && begin < drain && drain < flush && flush < dispose, "beginShutdown → 排干 → 服务收尾 → dispose");
});

test("工具箱：装配处给的转发管理器交到守护进程服务手里；不给时照常列服务、不提供转发", async () => {
  const stdout = ["v=1", "paseo.bin=0", "paseo.port=0", "t3code.bin=0", "t3code.port=0", "t3code.proc=0",
    'ss=LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("python",pid=4242,fd=3))', "proc=4242\t\t", "svc.state=ok", "end=1"].join("\n");
  const config = { activeServerId: "s1", servers: [{ id: "s1", host: "fixture.invalid" }] };
  const calls = [];
  const forwards = {
    limit: 4,
    list: () => [],
    reconcile: (serverId, ports) => calls.push(["reconcile", serverId, [...ports]]),
    open: async ({ server, remotePort, remoteHost }) => {
      calls.push(["open", server.id, remotePort, remoteHost]);
      return { serverId: server.id, port: remotePort, localPort: 51814, url: "http://127.0.0.1:51814/" };
    },
  };
  const make = (serviceForwards) => createChannelToolkit({
    rootDir: root,
    dataDir: path.join(root, "nonexistent-data-dir"),
    getConfig: async () => config,
    execFileImpl: async () => ({ code: 0, stdout, stderr: "" }),
    ...(serviceForwards ? { serviceForwards } : {}),
  });
  const acquireSshSlot = async () => () => {};
  const wired = make(forwards);
  const view = await wired.daemons.status("s1", { acquireSshSlot });
  assert.deepEqual([view.services.map((s) => s.port), view.forwardBlocked, view.forwardLimit], [[8814], null, 4]);
  assert.equal((await wired.daemons.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot })).forward.localPort, 51814);
  assert.deepEqual(calls, [["reconcile", "s1", [8814]], ["open", "s1", 8814, "127.0.0.1"]]);
  const bare = make(null);
  const plain = await bare.daemons.status("s1", { acquireSshSlot });
  assert.deepEqual([plain.services.map((s) => s.port), plain.forwardBlocked, plain.forwardLimit], [[8814], "unavailable", 0]);
  await assert.rejects(bare.daemons.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot }), { status: 503 });
});

test("工具箱：fixtureMode 交到守护进程服务手里——状态与转发都是假数据，执行器一次也不调用", async () => {
  const execCalls = [];
  const toolkit = createChannelToolkit({
    rootDir: root,
    dataDir: path.join(root, "nonexistent-data-dir"),
    getConfig: async () => ({ activeServerId: "s1", servers: [{ id: "s1", host: "fixture.invalid" }] }),
    execFileImpl: async (...args) => {
      execCalls.push(args);
      return { code: 255, stdout: "", stderr: "must not run in fixture mode" };
    },
    fixtureMode: true,
  });
  const acquireSshSlot = async () => () => {};
  const view = await toolkit.daemons.status("s1", { acquireSshSlot, fresh: true });
  assert.deepEqual([view.reachable, view.services.map((s) => s.port), view.forwardBlocked], [true, [5173, 8765, 8814], null]);
  const opened = await toolkit.daemons.forward({ serverId: "s1", port: 8814 }, { acquireSshSlot });
  assert.match(opened.forward.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal((await toolkit.daemons.closeForward({ serverId: "s1", port: 8814 })).closed, true);
  assert.deepEqual(execCalls, []);
});

test("数据面不受影响：supervisor / 本机代理的 import 闭包里没有 lib/daemons/ 的任何文件", async () => {
  for (const [component, entry] of Object.entries(COMPONENT_ENTRIES)) {
    const closure = await listImportClosure(root, entry);
    assert.ok(closure.length > 5, component);
    assert.deepEqual(closure.filter((file) => file.includes("/daemons/")), [], `${component} 的指纹闭包不该包含服务直达的代码`);
  }
});
