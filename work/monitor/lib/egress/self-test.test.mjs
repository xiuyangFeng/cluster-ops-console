import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { UPSTREAM_ERROR } from "../proxy/upstream.mjs";
import {
  buildFullChainCommand,
  buildSuggestion,
  parseFullChainOutput,
  probeTargetVia,
  runLocalSelfTest,
  SELF_TEST_TARGETS,
} from "./self-test.mjs";

const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const fakeSocket = () => ({ destroyed: false, resume() {}, destroy() { this.destroyed = true; } });

test("probeTargetVia：CONNECT 成功且 TLS 握手成功 → ok + 耗时；SNI 用目标主机名", async () => {
  let clock = 100;
  const dialed = [];
  const handshakes = [];
  const result = await probeTargetVia({
    proxy: { host: "127.0.0.1", port: 8888 },
    target: "api.openai.com",
    dial: async (opts) => {
      dialed.push(opts);
      clock += 40;
      return { socket: fakeSocket(), rest: Buffer.alloc(0) };
    },
    tlsHandshake: async ({ servername }) => {
      handshakes.push(servername);
      clock += 60;
    },
    now: () => clock,
  });
  assert.deepEqual(result, { target: "api.openai.com", ok: true, ms: 100 });
  assert.deepEqual(dialed[0].upstream, { host: "127.0.0.1", port: 8888 });
  assert.equal(dialed[0].host, "api.openai.com");
  assert.equal(dialed[0].port, 443);
  assert.deepEqual(handshakes, ["api.openai.com"]);
});

test("probeTargetVia：失败分段——本机代理没起 / 策略拦截 / 拨号失败 / 超时 / 证书 / 重置", async () => {
  const run = (failure, { viaLocalProxy = true, at = "dial" } = {}) => probeTargetVia({
    proxy: { host: "127.0.0.1", port: 8888 },
    target: "chatgpt.com",
    viaLocalProxy,
    dial: async () => {
      if (at === "dial") throw failure;
      return { socket: fakeSocket() };
    },
    tlsHandshake: async () => {
      if (at === "tls") throw failure;
    },
  });
  const pick = (r) => [r.stage, r.message];
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.REFUSED))), ["local-proxy", "本机代理没有运行（连接被拒绝）"]);
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.REJECTED, { statusCode: 403 }))), ["proxy", "本机代理拒绝了这个目标（策略拦截）"]);
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.REJECTED, { statusCode: 502 }))), ["proxy", "本机代理连不上目标（HTTP 502）"]);
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.REJECTED, { statusCode: 504 }))), ["proxy", "本机代理连接目标超时"]);
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.TIMEOUT))), ["proxy", "等待代理响应超时"]);
  assert.deepEqual(pick(await run(err("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), { at: "tls" })), ["tls", "证书校验失败（网络可能在拦截 HTTPS）"]);
  assert.deepEqual(pick(await run(err("ERR_TLS_CERT_ALTNAME_INVALID"), { at: "tls" })), ["tls", "证书校验失败（网络可能在拦截 HTTPS）"]);
  assert.deepEqual(pick(await run(err("ECONNRESET"), { at: "tls" })), ["tls", "TLS 握手被重置（可能被网络拦截）"]);
  assert.deepEqual(pick(await run(err("TLS_TIMEOUT"), { at: "tls" })), ["tls", "TLS 握手超时"]);
  // 直测系统代理时的口径（不是本机代理）。
  assert.deepEqual(pick(await run(err(UPSTREAM_ERROR.REFUSED), { viaLocalProxy: false })), ["upstream", "代理端口没有响应（代理软件没开或端口不对）"]);
  const failed = await run(err(UPSTREAM_ERROR.REJECTED, { statusCode: 403 }));
  assert.equal(failed.ok, false);
  assert.equal(failed.code, UPSTREAM_ERROR.REJECTED);
});

test("probeTargetVia（默认 TLS 握手）：隧道对端不说 TLS（如被拦截页替换）→ 归为 tls 段失败，不挂住", async (t) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\n\r\nblocked page"));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const result = await probeTargetVia({
    proxy: { host: "127.0.0.1", port: 1 },
    target: "api.openai.com",
    timeoutMs: 2000,
    dial: async () => ({ socket: net.connect(server.address().port, "127.0.0.1") }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, "tls");
});

test("runLocalSelfTest：对全部官方入口并发测，经 127.0.0.1:<代理端口>", async () => {
  const seen = [];
  const results = await runLocalSelfTest({
    proxyPort: 18888,
    probe: async ({ proxy, target, viaLocalProxy }) => {
      seen.push([proxy.port, target, viaLocalProxy]);
      return { target, ok: true, ms: 1 };
    },
  });
  assert.deepEqual(SELF_TEST_TARGETS, ["api.openai.com", "chatgpt.com", "api.anthropic.com", "claude.ai"]);
  assert.equal(results.length, 4);
  assert.deepEqual(seen.map((s) => s[1]), SELF_TEST_TARGETS);
  assert.ok(seen.every(([port, , via]) => port === 18888 && via === true));
});

test("buildSuggestion：代理没起 / 全通 / 部分不通 / 全被策略拦 / 上游不通 / 直连不通但系统代理可用 / SOCKS / PAC / 什么都没有", () => {
  const down = (stage, message = "x") => ({ ok: false, stage, message });
  const allDown = [down("proxy", "本机代理连不上目标（HTTP 502）"), down("tls")];
  const systemProxy = { proxy: { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897" } };
  assert.equal(buildSuggestion({ results: [down("local-proxy")] }).kind, "proxy-down");
  assert.equal(buildSuggestion({ results: [{ ok: true }, { ok: true }] }), null);
  assert.equal(buildSuggestion({ results: [{ ok: true }, down("tls")] }).kind, "partial");
  assert.equal(buildSuggestion({ results: [down("proxy", "本机代理拒绝了这个目标（策略拦截）")] }).kind, "policy");
  const upstream = buildSuggestion({ results: allDown, effective: { upstream: "127.0.0.1:7890" } });
  assert.equal(upstream.kind, "check-upstream");
  assert.match(upstream.text, /127\.0\.0\.1:7890/);
  const useSystem = buildSuggestion({ results: allDown, effective: { upstream: null }, systemProxy, systemCheck: { ok: true } });
  assert.equal(useSystem.action, "use-system");
  assert.match(useSystem.text, /系统代理 127\.0\.0\.1:7897 能连上/);
  assert.equal(buildSuggestion({ results: allDown, systemProxy, systemCheck: { ok: false } }).kind, "check-network");
  assert.equal(buildSuggestion({ results: allDown, systemProxy: { socks: { host: "127.0.0.1", port: 7891 } } }).kind, "socks-only");
  assert.equal(buildSuggestion({ results: allDown, systemProxy: { pac: "http://x/pac" } }).kind, "pac-only");
  assert.equal(buildSuggestion({ results: allDown, systemProxy: {} }).kind, "no-proxy");
});

test("buildFullChainCommand：curl -x 走反向端口，输出带标记行；端口非法直接抛", () => {
  const cmd = buildFullChainCommand(7892);
  assert.match(cmd, /-x http:\/\/127\.0\.0\.1:7892 https:\/\/api\.openai\.com\/v1\/models/);
  assert.match(cmd, /-w '\\nCW %\{http_connect\} %\{http_code\} %\{time_total\}\\n'/);
  assert.match(cmd, /echo "CW_EXIT=\$\?"$/);
  assert.throws(() => buildFullChainCommand("7892; rm -rf ~"));
  assert.throws(() => buildFullChainCommand(0));
});

test("parseFullChainOutput：按 curl 真实输出形态区分通 / 隧道没起 / 代理拒绝 / 代理拨号失败 / 超时 / SSH 没跑完", () => {
  const ok = parseFullChainOutput("\nCW 200 401 0.812345\nCW_EXIT=0\n", { remotePort: 7891 });
  assert.equal(ok.ok, true);
  assert.equal(ok.httpCode, 401);
  assert.equal(ok.ms, 812);
  assert.match(ok.message, /全链路通（HTTP 401，812ms）/);

  const tunnel = parseFullChainOutput("\nCW 000 000 0.001102\ncurl: (7) Failed to connect to 127.0.0.1 port 7892 after 0 ms: Connection refused\nCW_EXIT=7\n", { remotePort: 7892 });
  assert.equal(tunnel.stage, "tunnel");
  assert.match(tunnel.message, /集群连不上反向端口 127\.0\.0\.1:7892/);

  const denied = parseFullChainOutput("\nCW 403 000 0.004\ncurl: (56) CONNECT tunnel failed, response 403\nCW_EXIT=56\n", { remotePort: 7891 });
  assert.deepEqual([denied.stage, denied.connectCode], ["proxy", 403]);
  assert.match(denied.message, /策略拦截/);

  const dialFail = parseFullChainOutput("curl: (56) CONNECT tunnel failed, response 502\n\nCW 502 000 0,104\nCW_EXIT=56", { remotePort: 7891 });
  assert.match(dialFail.message, /本机代理连不上外网（HTTP 502）/);
  assert.equal(dialFail.ms, 104, "逗号小数点也能读");

  const slow = parseFullChainOutput("\nCW 200 000 15.001\ncurl: (28) Operation timed out\nCW_EXIT=28\n", { remotePort: 7891 });
  assert.equal(slow.stage, "tls");
  assert.match(slow.message, /超时/);

  const ssh = parseFullChainOutput("ssh: connect to host login port 22: Operation timed out\n", { remotePort: 7891 });
  assert.equal(ssh.stage, "ssh");
  assert.equal(ssh.ok, false);
});
