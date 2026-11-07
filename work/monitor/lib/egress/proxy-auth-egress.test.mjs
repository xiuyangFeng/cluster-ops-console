// 出网服务接上代理口令之后（v2.62）：状态里多一节 proxyAuth；本机自测与集群全链路在口令不是关时带上口令，
// 关着的时候发出去的东西与以前逐字相同。用真实的配置管理器、口令存储与一个真实的强制模式代理。
// 新用例单独成文件，service.test.mjs / self-test.test.mjs 原样不动。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createConfigManager } from "../config-hot-reload.mjs";
import { buildAuthPolicy, validateProxyAuthDocument } from "../proxy/auth.mjs";
import { createProxyServer } from "../proxy/server.mjs";
import { dialViaUpstream } from "../proxy/upstream.mjs";
import { createProxyAuthService } from "./proxy-auth-service.mjs";
import { createProxyAuthStore } from "./proxy-auth-store.mjs";
import { buildFullChainCommand, buildFullChainInvocation, parseFullChainOutput, probeTargetVia, runLocalSelfTest } from "./self-test.mjs";
import { createEgressService } from "./service.mjs";

function setup(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "egress-proxy-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const localConfigPath = path.join(dir, "config.local.json");
  writeFileSync(configPath, JSON.stringify({ activeServerId: "server-01", servers: [{ id: "server-01", host: "login.example", remotePort: 7891, localPort: 8888 }] }));
  writeFileSync(localConfigPath, JSON.stringify({ revision: 1 }));
  const manager = createConfigManager({ configPath, localConfigPath });
  const store = createProxyAuthStore({ filePath: path.join(dir, "runtime", "proxy-auth.json") });
  const calls = { local: [], remote: [] };
  const proxyAuth = createProxyAuthService({ store, usagePath: path.join(dir, "runtime", "proxy-usage.json"), getConfig: () => manager.loadConfig() });
  const service = createEgressService({
    getConfig: () => manager.loadConfig(),
    getPersonalConfig: manager.getPersonalConfig,
    savePersonalConfig: manager.savePersonalConfig,
    detector: { detect: async () => ({ proxy: null, socks: null, pac: null, error: null }) },
    readProxyHealth: async () => ({ running: true, supportsEgress: true, mode: "direct", pid: 4242 }),
    runLocal: async (options) => {
      calls.local.push(options);
      return [{ target: "api.openai.com", ok: true, ms: 5 }];
    },
    runRemote: async (_server, _config, command, options) => {
      calls.remote.push({ command, options });
      return { code: 0, stdout: "\nCW 200 401 0.5\nCW_EXIT=0\n", stderr: "" };
    },
    proxyAuth,
    ...overrides,
  });
  const token = () => JSON.parse(readFileSync(path.join(dir, "runtime", "proxy-auth.json"), "utf8")).token;
  return { service, store, calls, token, dir };
}

test("没有装配代理口令（旧的调用方式）：状态里 proxyAuth 为 null，其余字段照旧，自测不带口令", async (t) => {
  const { service, calls } = setup(t, { proxyAuth: null });
  const status = await service.getStatus();
  assert.equal(status.proxyAuth, null);
  assert.deepEqual(status.effective, { running: true, supportsEgress: true, mode: "direct", upstream: null }, "effective 的形状没有多出 pid");
  await service.runSelfTest({ scope: "full" });
  assert.deepEqual(calls.local, [{ proxyPort: 8888 }]);
  assert.deepEqual(calls.remote, [{ command: buildFullChainCommand(7891), options: { timeoutMs: 25000 } }]);
  await assert.rejects(service.setProxyAuth({ mode: "observe" }), { status: 503 });
  await assert.rejects(service.getUsage(), { status: 503 });
});

test("口令是关（默认）：自测与全链路发出去的与以前逐字相同——没有口令头、没有 -K -、没有标准输入", async (t) => {
  const { service, calls } = setup(t);
  const status = await service.getStatus();
  assert.equal(status.proxyAuth.mode, "off");
  assert.equal(status.proxyAuth.hasToken, false);
  await service.runSelfTest({ scope: "full" });
  assert.deepEqual(calls.local, [{ proxyPort: 8888 }]);
  assert.deepEqual(calls.remote, [{ command: buildFullChainCommand(7891), options: { timeoutMs: 25000 } }]);
  assert.equal(calls.remote[0].command.includes("-K"), false);
});

test("打开之后：改模式的回显是整份状态；自测带上口令头，全链路的口令走标准输入、不在命令里", async (t) => {
  const { service, calls, token } = setup(t);
  const saved = await service.setProxyAuth({ mode: "observe" });
  assert.equal(saved.proxyAuth.mode, "observe");
  assert.equal(saved.proxyAuth.hasToken, true);
  assert.deepEqual(saved.proxyAuthResult, { action: "mode", created: true, reset: false });
  assert.equal(saved.proxyPort, 8888, "其余字段与 GET /api/egress 相同");
  assert.equal(JSON.stringify(saved).includes(token()), false, "响应里没有口令");

  await service.runSelfTest({ scope: "full" });
  assert.deepEqual(calls.local, [{ proxyPort: 8888, proxyAuthorization: `Basic ${Buffer.from(`cwb:${token()}`).toString("base64")}` }]);
  assert.equal(calls.remote.length, 1);
  assert.equal(calls.remote[0].command, buildFullChainCommand(7891, { withProxyAuth: true }));
  assert.equal(calls.remote[0].command.includes(token()), false, "集群上的命令行里没有口令");
  assert.deepEqual(calls.remote[0].options, { timeoutMs: 25000, input: `proxy-user = "cwb:${token()}"\n` });

  const rotated = await service.setProxyAuth({ rotate: true });
  assert.equal(rotated.proxyAuthResult.action, "rotate");
  assert.ok(rotated.proxyAuth.rotation.until > Date.now());
  assert.equal((await service.setProxyAuth({ retirePrevious: true })).proxyAuth.rotation, null);
  assert.deepEqual(await service.getUsage(), { windowHours: 24, since: null, updatedAt: null, recording: true, totals: { connections: 0, up: 0, down: 0 }, recent: null, targets: [], other: null });
});

test("buildFullChainInvocation / parseFullChainOutput：没有口令时命令逐字不变；407 给出看得懂的原因", () => {
  assert.deepEqual(buildFullChainInvocation(7891, null), { command: buildFullChainCommand(7891), input: null });
  const withAuth = buildFullChainInvocation(7891, { user: "cwb", password: "TestTokenAAAAbbbbCCCCdddd0123456" });
  assert.equal(withAuth.command, buildFullChainCommand(7891).replace("-x http://127.0.0.1:7891 ", "-x http://127.0.0.1:7891 -K - "));
  assert.equal(withAuth.input, 'proxy-user = "cwb:TestTokenAAAAbbbbCCCCdddd0123456"\n');
  const denied = parseFullChainOutput("\nCW 407 000 0.012\nCW_EXIT=56\n", { remotePort: 7891 });
  assert.deepEqual({ ok: denied.ok, stage: denied.stage, connectCode: denied.connectCode }, { ok: false, stage: "proxy", connectCode: 407 });
  assert.match(denied.message, /本机代理要求口令/);
});

// ---- 经一个真实的强制模式代理 ----

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const AUTHORIZATION = `Basic ${Buffer.from(`cwb:${TOKEN}`).toString("base64")}`;

async function startEnforcing(t) {
  const echo = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const auth = buildAuthPolicy(validateProxyAuthDocument({ v: 1, mode: "enforce", user: "cwb", token: TOKEN }).doc);
  const lines = [];
  const proxy = createProxyServer({
    port: 0,
    log: (line) => lines.push(line),
    getPolicy: () => ({ allowTarget: () => true, upstream: null, egressMode: "direct", auth }),
  });
  await new Promise((resolve) => proxy.listen(resolve));
  t.after(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => echo.close(resolve));
  });
  return { port: proxy.server.address().port, echoPort: echo.address().port, lines };
}

test("dialViaUpstream 的 proxyAuthorization：带了才发这个头；形状不对（含换行）的值不进请求", async (t) => {
  const { port, echoPort } = await startEnforcing(t);
  const upstream = { host: "127.0.0.1", port };
  await assert.rejects(dialViaUpstream({ upstream, host: "127.0.0.1", port: echoPort }), { code: "UPSTREAM_REJECTED", statusCode: 407 });
  const ok = await dialViaUpstream({ upstream, host: "127.0.0.1", port: echoPort, proxyAuthorization: AUTHORIZATION });
  ok.socket.destroy();
  for (const bad of ["Basic abc\r\nX-Injected: 1", "Bearer token", "Basic", 42, null]) {
    await assert.rejects(dialViaUpstream({ upstream, host: "127.0.0.1", port: echoPort, proxyAuthorization: bad }), { code: "UPSTREAM_REJECTED", statusCode: 407 }, String(bad));
  }
  // 抓一下实际发出去的字节：不带时与以前逐字相同，带了只多这一行。
  const seen = [];
  const sink = net.createServer((socket) => socket.once("data", (buf) => {
    seen.push(String(buf));
    socket.end("HTTP/1.1 200 OK\r\n\r\n");
  }));
  await new Promise((resolve) => sink.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const viaSink = { host: "127.0.0.1", port: sink.address().port };
  (await dialViaUpstream({ upstream: viaSink, host: "api.example.com", port: 443 })).socket.destroy();
  (await dialViaUpstream({ upstream: viaSink, host: "api.example.com", port: 443, proxyAuthorization: AUTHORIZATION })).socket.destroy();
  assert.deepEqual(seen, [
    "CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n",
    `CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\nProxy-Authorization: ${AUTHORIZATION}\r\n\r\n`,
  ]);
});

test("本机段自测经强制模式的代理：不带口令 → 说清楚是口令的事；带了 → 过了口令这一关；直测别的代理时不把口令给它", async (t) => {
  const { port, echoPort } = await startEnforcing(t);
  const proxy = { host: "127.0.0.1", port };
  // 这里不测 TLS（回显服务不是 TLS 端点）。真实的握手结束时会关掉隧道，替身也得关——否则这条隧道一直开着，
  // 收尾时代理的 close() 等不到它结束。
  const handshake = async ({ socket }) => {
    socket.destroy();
  };
  // 自测的目标是 <主机>:443，测试里没有这样的目标：把拨号改到本机的回显端口，其余参数（含口令头）原样带过去。
  const dial = (options) => dialViaUpstream({ ...options, host: "127.0.0.1", port: echoPort });
  const denied = await probeTargetVia({ proxy, target: "api.openai.com", tlsHandshake: handshake, dial });
  assert.deepEqual({ ok: denied.ok, stage: denied.stage }, { ok: false, stage: "proxy" });
  assert.match(denied.message, /本机代理要求口令/);
  const passed = await probeTargetVia({ proxy, target: "api.openai.com", proxyAuthorization: AUTHORIZATION, tlsHandshake: handshake, dial });
  assert.equal(passed.ok, true, JSON.stringify(passed));

  const all = await runLocalSelfTest({ proxyPort: port, targets: ["api.openai.com", "claude.ai"], proxyAuthorization: AUTHORIZATION, probe: (options) => probeTargetVia({ ...options, tlsHandshake: handshake, dial }) });
  assert.deepEqual(all.map((r) => r.ok), [true, true]);
  const none = await runLocalSelfTest({ proxyPort: port, targets: ["api.openai.com"], probe: (options) => probeTargetVia({ ...options, tlsHandshake: handshake, dial }) });
  assert.match(none[0].message, /本机代理要求口令/, "不给口令就不带");

  // viaLocalProxy: false = 直测系统代理（别人的代理）：即使调用方手里有口令也不发。
  const dialed = [];
  await probeTargetVia({ proxy, target: "api.openai.com", viaLocalProxy: false, proxyAuthorization: AUTHORIZATION, tlsHandshake: handshake, dial: async (options) => {
    dialed.push(options);
    throw Object.assign(new Error("x"), { code: "UPSTREAM_REFUSED" });
  } });
  assert.equal(Object.hasOwn(dialed[0], "proxyAuthorization"), false);
});

test("源码：代理自己拨上游时从不带口令（server.mjs 里没有 proxyAuthorization）", () => {
  const server = readFileSync(new URL("../proxy/server.mjs", import.meta.url), "utf8");
  assert.equal(server.includes("proxyAuthorization"), false);
  assert.match(server, /dialViaUpstream\(\{/);
});
