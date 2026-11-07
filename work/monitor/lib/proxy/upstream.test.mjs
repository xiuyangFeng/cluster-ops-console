// 经上游代理拨号（dialViaUpstream）的单元测试，以及 createProxyServer 上游模式（getPolicy().upstream
// 非空）的闸门 / 失败映射 / 明文转发 / 策略热替换。全程随机端口 + 假上游，不碰真实网络。
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { buildPolicy } from "./policy-reload.mjs";
import { createProxyServer, createServerErrorHandler, egressHealthHeaders } from "./server.mjs";
import { dialViaUpstream, isSelfUpstream, landedOnSelf, UPSTREAM_ERROR, upstreamFailureReason, upstreamForwardOptions } from "./upstream.mjs";

// 假上游 HTTP 代理：记录收到的 CONNECT 头，按 respond 回应；回 200 后把隧道当 echo 用。
// respond(head) → { status?: 200, extra?: Buffer|string, raw?: string, hang?: true, close?: true }
async function startFakeUpstream(respond = () => ({ status: 200 })) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buf = Buffer.alloc(0);
    let tunneled = false;
    socket.on("data", (chunk) => {
      if (tunneled) {
        socket.write(chunk); // 隧道建好后：echo
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = buf.subarray(0, end).toString("latin1");
      const after = buf.subarray(end + 4);
      requests.push(head);
      const plan = respond(head) || {};
      if (plan.hang) return;
      if (plan.close) {
        socket.end();
        return;
      }
      if (plan.raw !== undefined) {
        socket.write(plan.raw);
        return;
      }
      const status = plan.status ?? 200;
      socket.write(`HTTP/1.1 ${status} ${status === 200 ? "Connection established" : "Nope"}\r\n\r\n`);
      if (status !== 200) {
        socket.end();
        return;
      }
      tunneled = true;
      if (plan.extra) socket.write(plan.extra);
      if (after.length) socket.write(after);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(r);
    }),
  };
}

const roundTrip = (socket, text) => new Promise((resolve) => {
  socket.once("data", (buf) => resolve(String(buf)));
  socket.resume();
  socket.write(text);
});

test("dialViaUpstream：发 CONNECT host:port（IPv6 加中括号），200 后交回暂停态 socket，隧道可双向收发", async (t) => {
  const up = await startFakeUpstream();
  t.after(() => up.close());
  const upstream = { host: "127.0.0.1", port: up.port };

  const { socket, rest } = await dialViaUpstream({ upstream, host: "api.openai.com", port: 443 });
  assert.match(up.requests[0], /^CONNECT api\.openai\.com:443 HTTP\/1\.1\r\nHost: api\.openai\.com:443$/);
  assert.equal(rest.length, 0);
  assert.equal(socket.isPaused(), true, "交回时暂停，调用方 pipe 才开始流动");
  assert.equal(await roundTrip(socket, "ping"), "ping");
  socket.destroy();

  const v6 = await dialViaUpstream({ upstream, host: "2001:db8::1", port: 443 });
  assert.match(up.requests[1], /^CONNECT \[2001:db8::1\]:443 /);
  v6.socket.destroy();
});

test("dialViaUpstream：200 之后同包到达的字节作为 rest 交回；head 在隧道建好后写给上游", async (t) => {
  const up = await startFakeUpstream(() => ({ status: 200, extra: "server-first" }));
  t.after(() => up.close());
  const { socket, rest } = await dialViaUpstream({
    upstream: { host: "127.0.0.1", port: up.port },
    host: "x.example.com",
    port: 443,
    head: Buffer.from("client-hello"),
  });
  // 假上游把 head 当隧道数据 echo 回来：rest 至少含 server-first，后续数据里有 client-hello。
  const seen = await new Promise((resolve) => {
    let text = String(rest);
    if (text.includes("client-hello")) return resolve(text);
    socket.on("data", (buf) => {
      text += String(buf);
      if (text.includes("client-hello")) resolve(text);
    });
    socket.resume();
  });
  assert.match(seen, /^server-first/);
  assert.match(seen, /client-hello/);
  socket.destroy();
});

test("dialViaUpstream：非 200 → REJECTED（带 statusCode）；拒连 → REFUSED；不回应 → TIMEOUT；非 HTTP / 头过大 / 提前断开 → BAD_RESPONSE", async (t) => {
  const rejecting = await startFakeUpstream(() => ({ status: 403 }));
  const hanging = await startFakeUpstream(() => ({ hang: true }));
  const garbage = await startFakeUpstream(() => ({ raw: "SSH-2.0-OpenSSH\r\n\r\n" }));
  const huge = await startFakeUpstream(() => ({ raw: `HTTP/1.1 200 OK\r\nX: ${"a".repeat(9000)}` }));
  const closing = await startFakeUpstream(() => ({ close: true }));
  t.after(() => Promise.all([rejecting, hanging, garbage, huge, closing].map((u) => u.close())));
  const dial = (port, extra = {}) => dialViaUpstream({ upstream: { host: "127.0.0.1", port }, host: "a.example.com", port: 443, ...extra });

  await assert.rejects(dial(rejecting.port), (err) => err.code === UPSTREAM_ERROR.REJECTED && err.statusCode === 403);
  await assert.rejects(dial(hanging.port, { timeoutMs: 150 }), (err) => err.code === UPSTREAM_ERROR.TIMEOUT);
  await assert.rejects(dial(garbage.port), (err) => err.code === UPSTREAM_ERROR.BAD_RESPONSE);
  await assert.rejects(dial(huge.port), (err) => err.code === UPSTREAM_ERROR.BAD_RESPONSE);
  await assert.rejects(dial(closing.port), (err) => err.code === UPSTREAM_ERROR.BAD_RESPONSE);

  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  await assert.rejects(dial(deadPort), (err) => err.code === UPSTREAM_ERROR.REFUSED);
});

test("dialViaUpstream：上游就是本代理自己 → LOOP（不发起连接）；signal 取消 → ABORTED 并销毁 socket", async (t) => {
  let connects = 0;
  await assert.rejects(
    dialViaUpstream({ upstream: { host: "localhost", port: 8888 }, host: "a.example.com", port: 443, selfPort: 8888, connect: () => { connects += 1; } }),
    (err) => err.code === UPSTREAM_ERROR.LOOP,
  );
  assert.equal(connects, 0);

  const hanging = await startFakeUpstream(() => ({ hang: true }));
  t.after(() => hanging.close());
  const controller = new AbortController();
  const pending = dialViaUpstream({ upstream: { host: "127.0.0.1", port: hanging.port }, host: "a.example.com", port: 443, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, (err) => err.code === UPSTREAM_ERROR.ABORTED);
});

test("dialViaUpstream：上游地址字面量看不出是自己、TCP 却落在本代理监听端点上 → LOOP，一个字节都不写给自己", async (t) => {
  const received = [];
  const self = net.createServer((socket) => {
    socket.on("data", (buf) => received.push(String(buf)));
    socket.on("error", () => {});
  });
  await new Promise((r) => self.listen(0, "127.0.0.1", r));
  const selfPort = self.address().port;
  t.after(() => new Promise((r) => self.close(r)));
  // 主机名形态的上游（比如解析到环回的 localtest.me）：connect 注入成直连本"代理"。
  const connect = () => net.connect(selfPort, "127.0.0.1");
  await assert.rejects(
    dialViaUpstream({ upstream: { host: "looks-public.example", port: selfPort }, host: "a.example.com", port: 443, selfPort, connect }),
    (err) => err.code === UPSTREAM_ERROR.LOOP,
  );
  const options = upstreamForwardOptions({ upstream: { host: "looks-public.example", port: selfPort }, url: "http://x.example.com/", method: "GET", headers: {}, selfPort, connect });
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = http.request(options, resolve);
      req.on("error", reject);
      req.end();
    }),
    (err) => err.code === UPSTREAM_ERROR.LOOP,
  );
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(received, [], "CONNECT / 明文请求都没写出去");
  assert.equal(landedOnSelf({ remoteAddress: "::ffff:127.0.0.1", remotePort: selfPort }, selfPort), true);
  assert.equal(landedOnSelf({ remoteAddress: "127.0.0.1", remotePort: selfPort + 1 }, selfPort), false);
  assert.equal(landedOnSelf({ remoteAddress: "127.0.0.1", remotePort: selfPort }, 0), false);
});

test("isSelfUpstream / upstreamFailureReason / upstreamForwardOptions", () => {
  assert.equal(isSelfUpstream({ host: "127.0.0.1", port: 8888 }, 8888), true);
  assert.equal(isSelfUpstream({ host: "::1", port: 8888 }, "8888"), true);
  for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "127.1", "localhost."]) {
    assert.equal(isSelfUpstream({ host, port: 8888 }, 8888), true, `${host} 作为目的地址连到的就是本机`);
  }
  assert.equal(isSelfUpstream({ host: "127.0.0.1", port: 7890 }, 8888), false);
  assert.equal(isSelfUpstream({ host: "192.168.1.2", port: 8888 }, 8888), false, "局域网上的另一台代理不是自己");
  assert.equal(isSelfUpstream({ host: "127.0.0.1", port: 8888 }, 0), false, "端口未知不判环路");

  assert.equal(upstreamFailureReason({ code: UPSTREAM_ERROR.REJECTED, statusCode: 502 }), "upstream-rejected-502");
  assert.equal(upstreamFailureReason({ code: UPSTREAM_ERROR.REFUSED }), "upstream-refused");
  assert.equal(upstreamFailureReason({ code: UPSTREAM_ERROR.NETWORK, cause: { code: "EHOSTUNREACH" } }), "upstream-ehostunreach");

  assert.deepEqual(
    upstreamForwardOptions({ upstream: { host: "127.0.0.1", port: 7890 }, url: "http://x.example.com/a?b=1", method: "GET", headers: { host: "x.example.com" } }),
    { host: "127.0.0.1", port: 7890, path: "http://x.example.com/a?b=1", method: "GET", headers: { host: "x.example.com" } },
  );
  assert.deepEqual(
    upstreamForwardOptions({ upstream: { host: "127.0.0.1", port: 7890 }, url: "http://x/", method: "GET", headers: { host: "x", "proxy-authorization": "Basic Zm9v" } }).headers,
    { host: "x" },
    "转给上游的明文请求不带客户端的 Proxy-Authorization",
  );
});

// ---- createProxyServer 的上游模式 ----

const publicLookup = (records) => (_hostname, options, cb) => {
  if (typeof options === "function") {
    cb = options;
    options = {};
  }
  if (options?.all) cb(null, records);
  else cb(null, records[0].address, records[0].family);
};
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

async function startProxyWith(opts) {
  const lines = [];
  const proxy = createProxyServer({ port: 0, log: (l) => lines.push(l), ...opts });
  await new Promise((r) => proxy.listen(r));
  return { proxy, port: proxy.server.address().port, lines, close: () => new Promise((r) => proxy.close(r)) };
}

function rawConnect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.once("data", (buf) => resolve({ socket, response: String(buf) }));
    socket.once("error", reject);
  });
}

const upstreamPolicy = (port, extra = {}) => buildPolicy({ egressMode: "manual", upstream: { host: "127.0.0.1", port, url: `http://127.0.0.1:${port}` }, ...extra });

test("上游模式 CONNECT：交给上游的是原主机名（不是本地解析出的 IP），200 后隧道可收发，打点带 via=upstream", async (t) => {
  const up = await startFakeUpstream();
  const p = await startProxyWith({ lookup: publicLookup(PUBLIC), getPolicy: () => upstreamPolicy(up.port) });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  const { socket, response } = await rawConnect(p.port, "api.openai.com:443");
  assert.match(response, /HTTP\/1\.1 200 Connection Established/);
  assert.match(up.requests[0], /^CONNECT api\.openai\.com:443 /);
  assert.equal(await roundTrip(socket, "hello"), "hello");
  socket.destroy();
  assert.ok(p.lines.some((l) => /^connect host=api\.openai\.com port=443 dnsMs=\d+ tcpMs=\d+ cached=[01] via=upstream$/.test(l)), JSON.stringify(p.lines));
});

test("上游模式闸门：字面量私网 / 非 443 仍 403（日志格式不变）；解析出私网 403 且不碰上游", async (t) => {
  const up = await startFakeUpstream();
  const lookup = (hostname, options, cb) => publicLookup(hostname === "rebind.example.com" ? [{ address: "10.0.0.7", family: 4 }] : PUBLIC)(hostname, options, cb);
  const p = await startProxyWith({ lookup, getPolicy: () => upstreamPolicy(up.port) });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  for (const target of ["127.0.0.1:443", "10.0.0.5:443", "api.anthropic.com:8080", "rebind.example.com:443"]) {
    const { response } = await rawConnect(p.port, target);
    assert.match(response, /HTTP\/1\.1 403 Forbidden/, target);
  }
  assert.equal(up.requests.length, 0, "被闸门拦下的目标一个都不该发给上游");
  assert.ok(p.lines.includes("connect-deny host=api.anthropic.com port=8080"), "字面量拒绝行与直连同格式（日志信号靠它）");
  assert.ok(p.lines.includes("connect-deny host=rebind.example.com port=443 reason=resolved-private resolved=10.0.0.7"));
});

test("上游模式闸门：本地解析失败或超出预算 + 金丝雀也失败（本机 DNS 整体不可用）→ 照常交给上游，同一 host 的日志限频", async (t) => {
  const up = await startFakeUpstream();
  // 注入的 lookup 同时充当金丝雀的解析器：api.openai.com 也解析失败 = 本机 DNS 整体不可用。
  const lookup = (hostname, _options, cb) => {
    if (hostname === "slow.example.com") return; // 永不回调
    cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  };
  const p = await startProxyWith({ lookup, upstreamLookupBudgetMs: 80, getPolicy: () => upstreamPolicy(up.port) });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  for (const target of ["poisoned.example.com:443", "poisoned.example.com:443", "slow.example.com:443"]) {
    const { socket, response } = await rawConnect(p.port, target);
    assert.match(response, /HTTP\/1\.1 200/, target);
    socket.destroy();
  }
  assert.deepEqual(up.requests.map((r) => r.split(" ")[1]), ["poisoned.example.com:443", "poisoned.example.com:443", "slow.example.com:443"]);
  assert.deepEqual(p.lines.filter((l) => l.startsWith("lookup-fail-forwarded")), [
    "lookup-fail-forwarded host=poisoned.example.com port=443 reason=ENOTFOUND",
    "lookup-fail-forwarded host=slow.example.com port=443 reason=ETIMEOUT",
  ]);
});

test("上游模式闸门：金丝雀成功（本机 DNS 健康）而目标解析失败 / 超时 → 502 + lookup-fail-denied，一个字节都不发给上游", async (t) => {
  const up = await startFakeUpstream();
  const canaryHosts = [];
  const lookup = (hostname, options, cb) => {
    if (hostname === "slow.example.com") return; // 永不回调 → 超出预算
    if (hostname === "api.openai.com") {
      canaryHosts.push(hostname);
      publicLookup(PUBLIC)(hostname, options, cb);
      return;
    }
    cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  };
  const p = await startProxyWith({
    lookup,
    upstreamLookupBudgetMs: 80,
    getPolicy: () => upstreamPolicy(up.port, { extraAllowedTargets: new Set(["evil-plain.example.com:8080"]) }),
  });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  for (const target of ["evil.example.com:443", "evil.example.com:443", "slow.example.com:443"]) {
    const { socket, response } = await rawConnect(p.port, target);
    assert.match(response, /HTTP\/1\.1 502 Bad Gateway/, target);
    socket.destroy();
  }
  // 明文分支同一口径。
  const plain = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p.port, path: "http://evil-plain.example.com:8080/x", agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(plain, 502);
  assert.equal(up.requests.length, 0, "金丝雀健康时解析失败的目标一个都不交给上游");
  assert.deepEqual(p.lines.filter((l) => l.startsWith("lookup-fail")), [
    "lookup-fail-denied host=evil.example.com port=443 reason=ENOTFOUND",
    "lookup-fail-denied host=slow.example.com port=443 reason=ETIMEOUT",
    "lookup-fail-denied host=evil-plain.example.com port=8080 reason=ENOTFOUND",
  ], "同一 host 限频：evil.example.com 两次只记一条");
  assert.equal(canaryHosts.length, 1, "金丝雀结论缓存：多次失败只探测一次");
});

test("上游模式闸门：注入的金丝雀决定放行 / 拒绝；金丝雀抛错按健康处理（失败关闭）", async (t) => {
  const up = await startFakeUpstream();
  const failing = (_h, _o, cb) => cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  let canary = { isHealthy: async () => false };
  const p = await startProxyWith({ lookup: failing, resolverCanary: { isHealthy: () => canary.isHealthy() }, getPolicy: () => upstreamPolicy(up.port) });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  const first = await rawConnect(p.port, "a.example.com:443");
  assert.match(first.response, /200/);
  first.socket.destroy();
  canary = { isHealthy: async () => true };
  assert.match((await rawConnect(p.port, "a.example.com:443")).response, /502/);
  canary = { isHealthy: async () => { throw new Error("boom"); } };
  assert.match((await rawConnect(p.port, "b.example.com:443")).response, /502/);
  assert.equal(up.requests.length, 1);
});

test("上游模式失败：上游拒连 / 回非 200 → 502，等不到回应 → 504，上游指回自己 → 502；均记 connect-fail via=upstream", async (t) => {
  const rejecting = await startFakeUpstream(() => ({ status: 403 }));
  const hanging = await startFakeUpstream(() => ({ hang: true }));
  const dead = net.createServer();
  await new Promise((r) => dead.listen(0, "127.0.0.1", r));
  const deadPort = dead.address().port;
  await new Promise((r) => dead.close(r));
  let policy = upstreamPolicy(deadPort);
  const p = await startProxyWith({ lookup: publicLookup(PUBLIC), connectTimeoutMs: 150, getPolicy: () => policy });
  t.after(async () => {
    await p.close();
    await rejecting.close();
    await hanging.close();
  });

  assert.match((await rawConnect(p.port, "a.example.com:443")).response, /502 Bad Gateway/);
  policy = upstreamPolicy(rejecting.port);
  assert.match((await rawConnect(p.port, "a.example.com:443")).response, /502 Bad Gateway/);
  policy = upstreamPolicy(hanging.port);
  assert.match((await rawConnect(p.port, "a.example.com:443")).response, /504 Gateway Timeout/);
  policy = upstreamPolicy(p.port);
  assert.match((await rawConnect(p.port, "a.example.com:443")).response, /502 Bad Gateway/);

  const failLines = p.lines.filter((l) => l.startsWith("connect-fail"));
  assert.deepEqual(failLines.map((l) => l.match(/reason=(\S+)/)[1]), ["upstream-refused", "upstream-rejected-403", "upstream-timeout", "upstream-loop"]);
  assert.ok(failLines.every((l) => / via=upstream$/.test(l)));
});

test("上游模式明文转发：绝对地址请求交给上游（白名单端口同样生效），/proxy-health 只报出网方式、不报上游地址", async (t) => {
  const seen = [];
  const upstreamHttp = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("via-upstream");
  });
  await new Promise((r) => upstreamHttp.listen(0, "127.0.0.1", r));
  const upPort = upstreamHttp.address().port;
  const p = await startProxyWith({
    lookup: publicLookup(PUBLIC),
    getPolicy: () => upstreamPolicy(upPort, { extraAllowedTargets: new Set(["relay.example.com:8080"]) }),
  });
  t.after(async () => {
    await p.close();
    await new Promise((r) => upstreamHttp.close(r));
  });
  const get = (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: p.port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
  const ok = await get("http://relay.example.com:8080/v1/models?x=1");
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "via-upstream");
  assert.deepEqual(seen, ["GET http://relay.example.com:8080/v1/models?x=1"]);
  assert.equal((await get("http://other.example.com:8080/")).status, 403, "未在白名单的端口照拒");

  const health = await get("/proxy-health");
  assert.equal(health.headers["x-codex-proxy-egress"], "manual");
  assert.equal(health.headers["x-codex-proxy-upstream"], undefined, "上游地址是同事本机网络细节，不经反向端口外泄");
  assert.ok(!Object.values(health.headers).some((v) => String(v).includes(String(upPort))), "任何健康头都不含上游端口");
});

test("策略热替换：已建立的上游隧道不受影响；之后的新连接按新策略（直连）走，/proxy-health 跟着变", async (t) => {
  const up = await startFakeUpstream();
  let policy = upstreamPolicy(up.port);
  const failingLookup = (_h, _o, cb) => cb(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
  const p = await startProxyWith({ lookup: failingLookup, getPolicy: () => policy });
  t.after(async () => {
    await p.close();
    await up.close();
  });
  const tunnel = await rawConnect(p.port, "keep.example.com:443");
  assert.match(tunnel.response, /200/);

  policy = buildPolicy(); // 切回直连、空白名单
  assert.equal(await roundTrip(tunnel.socket, "still-alive"), "still-alive", "旧隧道照常收发");
  const fresh = await rawConnect(p.port, "new.example.com:443");
  assert.match(fresh.response, /502 Bad Gateway/, "直连 + 解析失败 = 拨号阶段失败，说明没再走上游");
  assert.equal(up.requests.length, 1);
  assert.ok(p.lines.some((l) => /^connect-fail host=new\.example\.com .* via=direct$/.test(l)));
  tunnel.socket.destroy();

  const health = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: p.port, path: "/proxy-health", agent: false }, (res) => {
    res.resume();
    resolve(res.headers);
  }));
  assert.equal(health["x-codex-proxy-egress"], "direct");
  assert.equal(health["x-codex-proxy-upstream"], undefined);
});

test("getPolicy 抛错时回落静态直连策略，代理照常判定", async (t) => {
  const p = await startProxyWith({ getPolicy: () => { throw new Error("boom"); } });
  t.after(() => p.close());
  const { socket, response } = await rawConnect(p.port, "127.0.0.1:443");
  assert.match(response, /403 Forbidden/, "回落策略仍是默认 allowTarget（私网照拒）");
  socket.destroy();
});

test("egressHealthHeaders 只发布出网方式；createServerErrorHandler：accept 失败限频告警不退出，其余错误交给 onFatal", () => {
  assert.deepEqual(egressHealthHeaders(upstreamPolicy(7890)), { "x-codex-proxy-egress": "manual" });
  assert.deepEqual(egressHealthHeaders(null), { "x-codex-proxy-egress": "direct" });

  let clock = 0;
  const fatal = [];
  const lines = [];
  const onError = createServerErrorHandler({ onFatal: (e) => fatal.push(e.code), log: (l) => lines.push(l), now: () => clock, intervalMs: 5000 });
  const emfile = Object.assign(new Error("accept EMFILE"), { code: "EMFILE", syscall: "accept" });
  onError(emfile);
  onError(emfile);
  onError(emfile);
  clock = 6000;
  onError(emfile);
  assert.deepEqual(lines, ["[proxy] accept failed (still listening): EMFILE", "[proxy] accept failed (still listening): EMFILE (+2 suppressed)"]);
  assert.deepEqual(fatal, []);
  onError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE", syscall: "listen" }));
  assert.deepEqual(fatal, ["EADDRINUSE"]);
});
