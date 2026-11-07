// 本地 CONNECT 代理的热更新平滑交接（真实 loopback socket，不碰 8888/生产目录）。
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildProxyHealthHeaders,
  DRAINING_PROXY_RECORD_NAME,
  HANDOFF_WAITING_MARKER,
  PROXY_HANDOFF_ENV,
  proxyReleaseRequestPath,
} from "./monitor/lib/proxy/protocol.mjs";
import { removeOwnDrainingRecord, watchReleaseRequest } from "./monitor/lib/proxy/handoff.mjs";
import { createProxyServer } from "./monitor/lib/proxy/server.mjs";

const proxyScript = fileURLToPath(new URL("./local_http_connect_proxy.mjs", import.meta.url));
const repoRoot = path.resolve(path.dirname(proxyScript), "..");

function health(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/proxy-health", method: "GET", agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ ok: res.statusCode === 200 && body === "ok", headers: res.headers }));
    });
    req.on("error", () => resolve({ ok: false, headers: {} }));
    req.setTimeout(1000, () => req.destroy());
    req.end();
  });
}

function connectThrough(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (buf) => resolve({ socket, response: String(buf) }));
    socket.once("error", reject);
  });
}

function roundTrip(socket, payload) {
  return new Promise((resolve) => {
    socket.once("data", (buf) => resolve(String(buf)));
    socket.write(payload);
  });
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

test("交接（进程内）：旧代理上的 CONNECT 流在交接后持续收发，新连接由新代理服务", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const echoTarget = `127.0.0.1:${echo.address().port}`;

  const oldProxy = createProxyServer({ port: 0, allowTarget: () => true, log: () => {}, healthHeaders: { "x-tag": "old" } });
  await new Promise((r) => oldProxy.listen(r));
  const port = oldProxy.server.address().port;

  // 1) 集群侧一条长连接：经旧代理打到 echo。
  const stream = await connectThrough(port, echoTarget);
  assert.match(stream.response, /200 Connection Established/);
  assert.equal(await roundTrip(stream.socket, "before"), "before");

  // 2) 新代理交接模式启动：端口被占 → 进入重试并回报 waiting。
  const newProxy = createProxyServer({ port, allowTarget: () => true, log: () => {}, healthHeaders: { "x-tag": "new" } });
  let waiting = false;
  const bound = newProxy.listenWithHandoffRetry({ retryMs: 20, timeoutMs: 5000, onWaiting: () => { waiting = true; } });
  assert.ok(await waitFor(() => waiting), "新代理应先报告 waiting（旧代理仍占着端口）");

  // 3) 旧代理释放监听：listener 立刻关，已有连接不断。
  const releasedAt = Date.now();
  const drained = oldProxy.release({ maxDrainMs: 10_000 });
  await bound;
  assert.ok(Date.now() - releasedAt < 1000, "新代理应在释放后很快（~20ms 级）绑定");

  // 4) 新连接由新代理服务。
  const h = await health(port);
  assert.equal(h.ok, true);
  assert.equal(h.headers["x-tag"], "new");
  const fresh = await connectThrough(port, echoTarget);
  assert.match(fresh.response, /200/);
  assert.equal(await roundTrip(fresh.socket, "fresh"), "fresh");
  assert.equal(newProxy.activeConnections() >= 1, true);

  // 5) 旧流仍在旧进程里持续传输（多轮）。
  for (const word of ["after-1", "after-2", "after-3"]) {
    assert.equal(await roundTrip(stream.socket, word), word);
  }
  assert.equal(oldProxy.activeConnections(), 1, "旧代理只剩那条长连接");

  // 6) 长连接结束 → 旧代理排空。
  stream.socket.destroy();
  const result = await drained;
  assert.deepEqual(result, { drained: true, remaining: 0 });

  fresh.socket.destroy();
  await new Promise((r) => newProxy.close(r));
  await new Promise((r) => echo.close(r));
});

test("交接（进程内）：排空窗口到期时如实报告剩余连接数", async () => {
  const oldProxy = createProxyServer({ port: 0, log: () => {} });
  await new Promise((r) => oldProxy.listen(r));
  const port = oldProxy.server.address().port;
  const accepted = [];
  oldProxy.server.on("connection", (socket) => accepted.push(socket));
  const held = net.connect(port, "127.0.0.1");
  await new Promise((r) => held.once("connect", r));
  held.write("GET /partial HTTP/1.1\r\nHost: x\r\n"); // 未写完的请求：不是空闲连接
  // 等到代理侧真的读到了这半截请求再释放：连接刚建立、一个字节都还没读到时，它在 http.Server 眼里是
  // 空闲连接，server.close() 会顺手关掉它（Node 19+），排空结果就成了 drained——全量并发下偶发。
  await waitFor(() => oldProxy.activeConnections() === 1 && accepted[0]?.bytesRead > 0);
  const result = await oldProxy.release({ maxDrainMs: 50 });
  assert.deepEqual(result, { drained: false, remaining: 1 });
  held.destroy();
});

test("交接模式超时仍抢不到端口 → reject（不无限等）", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  const proxy = createProxyServer({ port, log: () => {} });
  let waits = 0;
  await assert.rejects(
    proxy.listenWithHandoffRetry({ retryMs: 10, timeoutMs: 120, onWaiting: () => { waits += 1; } }),
    (err) => err.code === "EADDRINUSE",
  );
  assert.equal(waits, 1, "waiting 只报告一次");
  await new Promise((r) => blocker.close(r));
});

test("watchReleaseRequest：文件出现即删除并只回调一次", () => {
  const ticks = [];
  let present = false;
  const unlinked = [];
  let released = 0;
  watchReleaseRequest({
    file: "/tmp/x/release-1",
    exists: () => present,
    unlink: (f) => unlinked.push(f),
    onRelease: () => { released += 1; },
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  ticks[0]();
  assert.equal(released, 0);
  present = true;
  ticks[0]();
  ticks[0]();
  assert.equal(released, 1);
  assert.deepEqual(unlinked, ["/tmp/x/release-1"]);
});

async function tempEnv(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "proxy-handoff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "runtime"), { recursive: true });
  await writeFile(path.join(dir, "config.json"), JSON.stringify({ servers: [] }));
  return {
    dir,
    env: {
      ...process.env,
      CODEX_MONITOR_DATA_DIR: dir,
      CODEX_MONITOR_CONFIG_PATH: path.join(dir, "config.json"),
      CODEX_MONITOR_LOCAL_CONFIG_PATH: path.join(dir, "config.local.json"),
      [PROXY_HANDOFF_ENV]: "",
    },
  };
}

function spawnProxyCli(env, port, extra = {}) {
  const child = spawn(process.execPath, [proxyScript], {
    cwd: repoRoot,
    env: { ...env, PORT: String(port), ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.output = "";
  child.stdout.on("data", (c) => { child.output += String(c); });
  child.stderr.on("data", (c) => { child.output += String(c); });
  child.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return child;
}

test("CLI：普通模式撞上端口占用仍快速失败（exit 2），不进入交接重试", async (t) => {
  const { env } = await tempEnv(t);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  const startedAt = Date.now();
  const child = spawnProxyCli(env, port);
  const { code } = await child.exited;
  assert.equal(code, 2);
  assert.ok(Date.now() - startedAt < 5000);
  assert.doesNotMatch(child.output, /\[handoff\] waiting/);
  await new Promise((r) => blocker.close(r));
});

test("CLI：真实进程交接——控制文件释放旧监听、新进程接管端口、旧进程排空后 exit 0", async (t) => {
  const { dir, env } = await tempEnv(t);
  const port = await freePort();
  const oldChild = spawnProxyCli(env, port);
  t.after(() => { try { oldChild.kill("SIGKILL"); } catch {} });
  const first = await waitFor(async () => {
    const h = await health(port);
    return h.ok ? h : null;
  });
  assert.ok(first, `旧代理应起来: ${oldChild.output}`);
  assert.equal(first.headers["x-codex-proxy-pid"], String(oldChild.pid));
  assert.equal(first.headers["x-codex-proxy-handoff"], "1");
  assert.match(first.headers["x-codex-proxy-component"], /^[0-9a-f]{12}$/);

  // 一条"进行中"的连接：交接后必须留在旧进程里，直到它自己结束。
  const held = net.connect(port, "127.0.0.1");
  await new Promise((r) => held.once("connect", r));
  held.write("GET /still-streaming HTTP/1.1\r\nHost: x\r\n");

  const newChild = spawnProxyCli(env, port, { [PROXY_HANDOFF_ENV]: "1" });
  t.after(() => { try { newChild.kill("SIGKILL"); } catch {} });
  assert.ok(await waitFor(() => newChild.output.includes(HANDOFF_WAITING_MARKER)), `新代理应进入等待: ${newChild.output}`);

  // supervisor 在发释放请求前把旧代理登记为 local-proxy-draining；旧代理排空退出时自行删掉。
  const drainingRecord = path.join(dir, "runtime", `${DRAINING_PROXY_RECORD_NAME}.pid.json`);
  await mkdir(path.dirname(drainingRecord), { recursive: true });
  await writeFile(drainingRecord, JSON.stringify({ name: DRAINING_PROXY_RECORD_NAME, pid: oldChild.pid }));
  const releaseFile = proxyReleaseRequestPath(path.join(dir, "runtime"), oldChild.pid);
  await mkdir(path.dirname(releaseFile), { recursive: true });
  await writeFile(releaseFile, "");
  const takeover = await waitFor(async () => {
    const h = await health(port);
    return h.ok && h.headers["x-codex-proxy-pid"] === String(newChild.pid) ? h : null;
  });
  assert.ok(takeover, `新代理应接管端口: old=${oldChild.output} new=${newChild.output}`);
  assert.equal(oldChild.exitCode, null, "旧代理仍有连接在跑，不能退出");

  held.destroy();
  const exit = await Promise.race([oldChild.exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.match(oldChild.output, /all connections drained/);
  await assert.rejects(access(drainingRecord), "排空退出后删掉指向自己的 local-proxy-draining 记录");
  newChild.kill("SIGTERM");
  await newChild.exited;
});

test("身份头：只有装上释放监听才声明 handoff", () => {
  assert.deepEqual(buildProxyHealthHeaders({ pid: 42, component: "abc", handoff: false }), {
    "x-codex-proxy-pid": "42",
    "x-codex-proxy-component": "abc",
  });
  assert.equal(buildProxyHealthHeaders({ pid: 42, component: "abc", handoff: true })["x-codex-proxy-handoff"], "1");
});

test("removeOwnDrainingRecord：只删 pid 指向自己的记录", () => {
  const removed = [];
  const record = path.join("/rt", "local-proxy-draining.pid.json"); // 实现按 path.join 拼，Windows 上是反斜杠
  const files = { [record]: JSON.stringify({ pid: 11 }) };
  const deps = { readFile: (f) => { if (!(f in files)) throw new Error("ENOENT"); return files[f]; }, unlink: (f) => removed.push(f) };
  assert.equal(removeOwnDrainingRecord({ runtimeDir: "/rt", pid: 22, ...deps }), false);
  assert.deepEqual(removed, []);
  assert.equal(removeOwnDrainingRecord({ runtimeDir: "/rt", pid: 11, ...deps }), true);
  assert.deepEqual(removed, [record]);
  assert.equal(removeOwnDrainingRecord({ runtimeDir: "/nope", pid: 11, ...deps }), false);
  assert.equal(removeOwnDrainingRecord({ pid: 11, ...deps }), false);
});

test("release：无活动连接时立即判定排空（空闲 keep-alive 连接不拖住退出）", async () => {
  const proxy = createProxyServer({ port: 0, log: () => {} });
  await new Promise((r) => proxy.server.listen(0, "127.0.0.1", r));
  const port = proxy.server.address().port;
  // 一条 keep-alive 的空闲连接：请求完成后连接仍开着。
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve) => {
    http.get({ hostname: "127.0.0.1", port, path: "/proxy-health", agent }, (res) => { res.resume(); res.on("end", resolve); });
  });
  const startedAt = Date.now();
  const result = await proxy.release({ maxDrainMs: 5000 });
  assert.equal(result.drained, true);
  assert.ok(Date.now() - startedAt < 2000);
  agent.destroy();
});
