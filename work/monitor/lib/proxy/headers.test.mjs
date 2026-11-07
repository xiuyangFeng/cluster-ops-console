// 逐跳头剥离与跳标记（v2.54 终审）：纯函数单测 + 经代理的端到端（直连 / 上游两条明文分支、
// 发往上游的 CONNECT、经外部转发器绕回自己的环路）。全程随机端口，不碰真实网络。
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import {
  createHopId,
  forwardRequestHeaders,
  isHopId,
  isProxyLoop,
  MAX_PROXY_HOPS,
  PROXY_HOP_HEADER,
  readHopChain,
} from "./headers.mjs";
import { buildPolicy } from "./policy-reload.mjs";
import { createProxyServer } from "./server.mjs";

const SECRET = "Basic c2VjcmV0OnBhc3N3b3Jk";

test("forwardRequestHeaders：剥掉逐跳头与 Connection 点名的字段，其余原样保留，不改入参", () => {
  const input = {
    host: "example.com",
    "proxy-authorization": SECRET,
    "proxy-connection": "keep-alive",
    connection: "keep-alive, X-Secret-Hop, Upgrade",
    "keep-alive": "timeout=5",
    te: "trailers",
    trailer: "Expires",
    upgrade: "websocket",
    "x-secret-hop": "1",
    [PROXY_HOP_HEADER]: "0123456789abcdef",
    authorization: "Bearer end-to-end",
    "user-agent": "curl/8",
  };
  const snapshot = { ...input };
  assert.deepEqual(forwardRequestHeaders(input), { host: "example.com", authorization: "Bearer end-to-end", "user-agent": "curl/8" });
  assert.deepEqual(input, snapshot, "不改入参");
  assert.deepEqual(forwardRequestHeaders({ Connection: ["close", "X-A"], "X-A": "1", "X-B": "2", "Proxy-Authorization": SECRET }), { "X-B": "2" }, "大小写与数组形态");
  assert.deepEqual(forwardRequestHeaders(null), {});
});

test("跳标记：id 形态、链解析只留合法 id、命中自己或超长即环路", () => {
  const id = createHopId();
  assert.equal(isHopId(id), true);
  assert.notEqual(createHopId(), id, "每个实例随机");
  assert.deepEqual(readHopChain({ [PROXY_HOP_HEADER]: `${id}, junk, ABCDEF0123456789 ,0000000000000000` }), [id, "abcdef0123456789", "0000000000000000"]);
  assert.deepEqual(readHopChain({}), []);
  assert.equal(isProxyLoop([id], id), true);
  assert.equal(isProxyLoop(["0000000000000000"], id), false);
  assert.equal(isProxyLoop(Array.from({ length: MAX_PROXY_HOPS }, () => "0000000000000000"), id), true);
  assert.equal(isProxyLoop([], "not-an-id"), false);
});

// ---- 经代理的端到端 ----

async function startProxy(opts) {
  const lines = [];
  const proxy = createProxyServer({ port: 0, log: (l) => lines.push(l), ...opts });
  await new Promise((r) => proxy.listen(r));
  return { proxy, port: proxy.server.address().port, lines, close: () => new Promise((r) => proxy.close(r)) };
}

// 把收到的请求头作为 JSON 回显（既当源站，也当"上游 HTTP 代理"）。
async function startHeaderEcho() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.headers));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

function proxiedGet(proxyPort, url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function rawConnect(proxyPort, target, extraHeaders = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extraHeaders}\r\n`));
    socket.once("data", (buf) => resolve({ socket, response: String(buf) }));
    socket.once("error", reject);
  });
}

const publicLookup = (_hostname, options, cb) => {
  if (typeof options === "function") cb = options;
  if (options?.all) cb(null, [{ address: "93.184.216.34", family: 4 }]);
  else cb(null, "93.184.216.34", 4);
};

test("直连明文转发：客户端的 Proxy-Authorization 与其它逐跳头到不了源站", async (t) => {
  const echo = await startHeaderEcho();
  const p = await startProxy({ allowTarget: () => true }); // 测试放行 127.0.0.1 的 echo
  t.after(async () => {
    await p.close();
    await echo.close();
  });
  const res = await proxiedGet(p.port, `http://127.0.0.1:${echo.port}/h`, {
    "Proxy-Authorization": SECRET,
    "Proxy-Connection": "keep-alive",
    Connection: "X-Hop-Only",
    "X-Hop-Only": "1",
    "X-End-To-End": "kept",
  });
  assert.equal(res.status, 200);
  const got = JSON.parse(res.body);
  assert.equal(got["proxy-authorization"], undefined);
  assert.equal(got["proxy-connection"], undefined);
  assert.equal(got["x-hop-only"], undefined);
  assert.equal(got["x-end-to-end"], "kept");
  assert.ok(!res.body.includes("c2VjcmV0"), "凭证一个字节都不出现在源站");
});

test("上游明文转发：Proxy-Authorization 不转给上游代理，也不带跳标记头", async (t) => {
  const up = await startHeaderEcho();
  const policy = buildPolicy({
    egressMode: "manual",
    upstream: { host: "127.0.0.1", port: up.port, url: `http://127.0.0.1:${up.port}` },
    extraAllowedTargets: new Set(["relay.example.com:8080"]),
  });
  const p = await startProxy({ lookup: publicLookup, getPolicy: () => policy });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  const res = await proxiedGet(p.port, "http://relay.example.com:8080/v1", { "Proxy-Authorization": SECRET, "X-End-To-End": "kept" });
  assert.equal(res.status, 200);
  assert.equal(up.seen[0].url, "http://relay.example.com:8080/v1");
  assert.equal(up.seen[0].headers["proxy-authorization"], undefined);
  assert.equal(up.seen[0].headers[PROXY_HOP_HEADER], undefined, "明文分支不带跳标记（上游会把它转给源站）");
  assert.equal(up.seen[0].headers["x-end-to-end"], "kept");
});

test("发往上游的 CONNECT：只有 Host 与本实例的跳标记，客户端的 Proxy-Authorization 不带过去", async (t) => {
  const heads = [];
  const up = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (buf) => {
      heads.push(String(buf));
      socket.end("HTTP/1.1 403 Nope\r\n\r\n");
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upPort = up.address().port;
  const hopId = "00112233445566ff";
  const policy = buildPolicy({ egressMode: "manual", upstream: { host: "127.0.0.1", port: upPort, url: `http://127.0.0.1:${upPort}` } });
  const p = await startProxy({ lookup: publicLookup, hopId, getPolicy: () => policy });
  t.after(async () => {
    await p.close();
    await new Promise((r) => up.close(r));
  });
  const { socket } = await rawConnect(p.port, "api.openai.com:443", `Proxy-Authorization: ${SECRET}\r\nX-Other: 1\r\n`);
  socket.destroy();
  assert.equal(heads.length, 1);
  assert.equal(heads[0], `CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n${PROXY_HOP_HEADER}: ${hopId}\r\n\r\n`);
});

test("跳标记环路：CONNECT 带着本实例 id 回来 → 508 并记 connect-loop；经透明转发器绕回自己的上游 → 客户端 502、不递归", async (t) => {
  const hopId = "aaaaaaaaaaaaaaaa";
  let policy = buildPolicy();
  const p = await startProxy({ lookup: publicLookup, hopId, getPolicy: () => policy });
  // 透明 TCP 转发器（模拟 SSH -L / 端口映射）：原样把字节转回代理自己。落点复检看不出来，只能靠跳标记。
  let forwarded = 0;
  const forwarder = net.createServer((client) => {
    forwarded += 1;
    client.on("error", () => {});
    const back = net.connect(p.port, "127.0.0.1");
    back.on("error", () => client.destroy());
    client.pipe(back);
    back.pipe(client);
  });
  await new Promise((r) => forwarder.listen(0, "127.0.0.1", r));
  const fwdPort = forwarder.address().port;
  t.after(async () => {
    await p.close();
    await new Promise((r) => forwarder.close(r));
  });

  const direct = await rawConnect(p.port, "api.openai.com:443", `${PROXY_HOP_HEADER}: 0123456789abcdef, ${hopId}\r\n`);
  assert.match(direct.response, /^HTTP\/1\.1 508 Loop Detected/);
  direct.socket.destroy();
  assert.ok(p.lines.includes("connect-loop host=api.openai.com port=443 hops=2"), JSON.stringify(p.lines));

  policy = buildPolicy({ egressMode: "manual", upstream: { host: "127.0.0.1", port: fwdPort, url: `http://127.0.0.1:${fwdPort}` } });
  const looped = await rawConnect(p.port, "api.openai.com:443");
  assert.match(looped.response, /^HTTP\/1\.1 502 Bad Gateway/);
  looped.socket.destroy();
  assert.equal(forwarded, 1, "绕回一圈就被拦下，没有递归");
  assert.ok(p.lines.some((l) => /^connect-fail host=api\.openai\.com port=443 reason=upstream-loop .*via=upstream$/.test(l)), JSON.stringify(p.lines));

  // 明文请求带着本实例 id 回来同样 508。
  const plain = await proxiedGet(p.port, "http://api.openai.com/", { [PROXY_HOP_HEADER]: hopId });
  assert.equal(plain.status, 508);
});
