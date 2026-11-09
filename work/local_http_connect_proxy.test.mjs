import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";

import { createCachedLookup } from "./monitor/lib/proxy/dns-cache.mjs";
import { createProxyServer } from "./monitor/lib/proxy/server.mjs";
import {
  createRebindGuardedLookup,
  EXTRA_ALLOWED_TARGETS,
  isPrivateTarget,
  parseProxyAllowedTargets,
  RESOLVED_PRIVATE_ERROR_CODE,
  resolveExtraAllowedTargets,
} from "./monitor/lib/proxy/target-policy.mjs";

// 起一个随机端口代理，返回 { proxy, port }
export async function startProxy(opts = {}) {
  const proxy = createProxyServer({ port: 0, ...opts });
  await new Promise((resolve) => proxy.listen(resolve));
  return { proxy, port: proxy.server.address().port };
}

// 裸 socket 发 CONNECT，返回 { socket, response(首个数据块字符串) }
export function rawConnect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (buf) => resolve({ socket, response: String(buf) }));
    socket.once("error", reject);
  });
}

function httpGet(options) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("proxy-health 返回 200 与标识头", async () => {
  const { proxy, port } = await startProxy();
  const res = await httpGet({ host: "127.0.0.1", port, path: "/proxy-health" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-codex-proxy"], "active");
  assert.equal(res.body, "ok");
  await new Promise((r) => proxy.close(r));
});

test("CONNECT 隧道端到端：经代理连本地 echo 服务收发数据", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = echo.address().port;
  // 目标是 loopback + 随机端口：这条测的是隧道转发机制本身，不是 C2 的目标
  // 白名单，所以显式放开默认策略（默认策略见下方"目标白名单"专项测试）。
  const { proxy, port } = await startProxy({ allowTarget: () => true });

  const { socket, response } = await rawConnect(port, `127.0.0.1:${echoPort}`);
  assert.match(response, /HTTP\/1\.1 200 Connection Established/);
  const echoed = await new Promise((resolve) => {
    socket.once("data", (buf) => resolve(String(buf)));
    socket.write("ping");
  });
  assert.equal(echoed, "ping");

  socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => echo.close(r));
});

test("普通 HTTP 绝对地址转发", async () => {
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello ${req.url}`);
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const originPort = origin.address().port;
  // 同上：测的是明文 HTTP 转发机制，默认目标策略在专项测试里单独覆盖。
  const { proxy, port } = await startProxy({ allowTarget: () => true });

  const res = await httpGet({ host: "127.0.0.1", port, path: `http://127.0.0.1:${originPort}/abc` });
  assert.equal(res.status, 200);
  assert.equal(res.body, "hello /abc");

  await new Promise((r) => proxy.close(r));
  await new Promise((r) => origin.close(r));
});

test("相对 URL 请求返回 400 而非进程崩溃", async () => {
  const { proxy, port } = await startProxy();
  const res = await httpGet({ host: "127.0.0.1", port, path: "/not-proxy-form" });
  assert.equal(res.status, 400);
  await new Promise((r) => proxy.close(r));
});

test("CONNECT 两端 socket 均关闭 Nagle 并开启 keep-alive", async (t) => {
  const noDelayCalls = [];
  const keepAliveCalls = [];
  const origNoDelay = net.Socket.prototype.setNoDelay;
  const origKeepAlive = net.Socket.prototype.setKeepAlive;
  net.Socket.prototype.setNoDelay = function (v) { noDelayCalls.push(v); return origNoDelay.call(this, v); };
  net.Socket.prototype.setKeepAlive = function (v, d) { keepAliveCalls.push([v, d]); return origKeepAlive.call(this, v, d); };
  t.after(() => {
    net.Socket.prototype.setNoDelay = origNoDelay;
    net.Socket.prototype.setKeepAlive = origKeepAlive;
  });

  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const { proxy, port } = await startProxy({ allowTarget: () => true });

  const { socket } = await rawConnect(port, `127.0.0.1:${echo.address().port}`);

  // 代理入站 socket + 上游 socket 各一次（测试客户端自身不调用）
  assert.ok(noDelayCalls.filter((v) => v === true).length >= 2, `setNoDelay(true) 至少 2 次，实际 ${JSON.stringify(noDelayCalls)}`);
  assert.ok(keepAliveCalls.filter(([v, d]) => v === true && d === 30000).length >= 2, `setKeepAlive(true,30000) 至少 2 次，实际 ${JSON.stringify(keepAliveCalls)}`);

  socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => echo.close(r));
});

test("createCachedLookup：TTL 内命中缓存，过期重新解析，失败不缓存", async () => {
  let clock = 1000;
  let calls = 0;
  let failNext = false;
  const baseLookup = (_hostname, _options, cb) => {
    calls += 1;
    if (failNext) { cb(new Error("ENOTFOUND")); return; }
    cb(null, [{ address: "1.2.3.4", family: 4 }, { address: "::1", family: 6 }]);
  };
  const lookup = createCachedLookup({ ttlMs: 60000, baseLookup, now: () => clock });

  // all:true 形态（autoSelectFamily 使用）
  const all = await new Promise((res, rej) => lookup("api.test", { all: true }, (e, records) => (e ? rej(e) : res(records))));
  assert.equal(all.length, 2);
  assert.equal(calls, 1);
  assert.equal(lookup.has("api.test"), true);

  // TTL 内第二次：不再解析；单地址形态取首条
  const single = await new Promise((res, rej) => lookup("api.test", {}, (e, addr, family) => (e ? rej(e) : res({ addr, family }))));
  assert.deepEqual(single, { addr: "1.2.3.4", family: 4 });
  assert.equal(calls, 1);

  // 过期后重新解析
  clock += 60001;
  assert.equal(lookup.has("api.test"), false);
  await new Promise((res, rej) => lookup("api.test", { all: true }, (e, r) => (e ? rej(e) : res(r))));
  assert.equal(calls, 2);

  // 失败不写缓存
  failNext = true;
  clock += 60001;
  await new Promise((res) => lookup("api.test", {}, (e) => { assert.ok(e); res(); }));
  assert.equal(lookup.has("api.test"), false);
});

test("createCachedLookup：超过 maxEntries 清空重建", async () => {
  const baseLookup = (_h, _o, cb) => cb(null, [{ address: "9.9.9.9", family: 4 }]);
  const lookup = createCachedLookup({ ttlMs: 60000, baseLookup, now: () => 0, maxEntries: 2 });
  for (const h of ["a.test", "b.test", "c.test"]) {
    await new Promise((res) => lookup(h, {}, () => res()));
  }
  assert.ok(lookup.cache.size <= 2, `缓存应被清空重建，实际 size=${lookup.cache.size}`);
});

test("CONNECT 拨号超时快速返回 504 而非挂到 OS 超时", async () => {
  const hangingLookup = () => {}; // 永不回调 => 拨号永远停在 DNS 阶段
  const { proxy, port } = await startProxy({ lookup: hangingLookup, connectTimeoutMs: 200 });

  const t0 = Date.now();
  const { response } = await rawConnect(port, "blackhole.test:443");
  const elapsed = Date.now() - t0;

  assert.match(response, /HTTP\/1\.1 504 Gateway Timeout/);
  assert.ok(elapsed < 1500, `应在注入的 200ms 超时附近失败，实际 ${elapsed}ms`);
  await new Promise((r) => proxy.close(r));
});

test("CONNECT 畸形端口不崩溃：超范围与非数字端口均返回 400，随后仍能正常处理请求", async () => {
  const { proxy, port } = await startProxy();

  const overRange = await rawConnect(port, "badhost:70000");
  assert.match(overRange.response, /HTTP\/1\.1 400 Bad Request/);

  const nonNumeric = await rawConnect(port, "badhost:abc");
  assert.match(nonNumeric.response, /HTTP\/1\.1 400 Bad Request/);

  // 同一测试进程内，代理仍应正常处理下一个请求 —— 证明前两次畸形 CONNECT 没有崩掉进程
  const res = await httpGet({ host: "127.0.0.1", port, path: "/proxy-health" });
  assert.equal(res.status, 200);

  await new Promise((r) => proxy.close(r));
});

test("CONNECT IPv6 字面量 authority 正确解析中括号包裹的 host", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "::1", r));
  const echoPort = echo.address().port;
  const { proxy, port } = await startProxy({ allowTarget: () => true });

  const { socket, response } = await rawConnect(port, `[::1]:${echoPort}`);
  assert.match(response, /HTTP\/1\.1 200 Connection Established/);
  const echoed = await new Promise((resolve) => {
    socket.once("data", (buf) => resolve(String(buf)));
    socket.write("ping6");
  });
  assert.equal(echoed, "ping6");

  socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => echo.close(r));
});

test("CONNECT IPv6 字面量畸形端口同样返回 400 而不崩溃", async () => {
  const { proxy, port } = await startProxy();
  const { response } = await rawConnect(port, "[::1]:70000");
  assert.match(response, /HTTP\/1\.1 400 Bad Request/);
  await new Promise((r) => proxy.close(r));
});

test("建连成功与失败各输出一行结构化打点", async () => {
  const lines = [];
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const { proxy, port } = await startProxy({ log: (l) => lines.push(l), connectTimeoutMs: 200, allowTarget: () => true });

  const ok = await rawConnect(port, `127.0.0.1:${echo.address().port}`);
  ok.socket.destroy();
  assert.ok(
    lines.some((l) => /^connect host=127\.0\.0\.1 port=\d+ dnsMs=\d+ tcpMs=\d+ cached=[01] via=direct$/.test(l)),
    `缺成功打点，实际: ${JSON.stringify(lines)}`,
  );

  // 关掉 echo 后拨同端口 => ECONNREFUSED => connect-fail
  const deadPort = echo.address().port;
  await new Promise((r) => echo.close(r));
  await rawConnect(port, `127.0.0.1:${deadPort}`);
  assert.ok(
    lines.some((l) => /^connect-fail host=127\.0\.0\.1 port=\d+ reason=\S+ ms=\d+ via=direct$/.test(l)),
    `缺失败打点，实际: ${JSON.stringify(lines)}`,
  );

  await new Promise((r) => proxy.close(r));
});

test("isPrivateTarget：loopback/私网段/link-local 判 true，公网主机/IP 判 false", () => {
  const privateHosts = [
    "127.0.0.1",
    "127.0.0.2",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.168.0.1",
    "169.254.1.1",
    "100.64.0.1", // 100.64.0.0/10 CGNAT
    "100.127.255.255",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "localhost",
    "LOCALHOST",
    "[::1]",
    // IPv4-mapped/-compatible IPv6：点分形 + 十六进制形都必须识破（否则 SSRF 绕过）
    "::ffff:127.0.0.1",
    "::ffff:7f00:0001", // = 127.0.0.1 hex 形
    "[::ffff:7f00:0001]",
    "::ffff:c0a8:0101", // = 192.168.1.1
    "::ffff:0a00:0001", // = 10.0.0.1
    "::7f00:0001", // IPv4-compatible = 127.0.0.1
  ];
  for (const h of privateHosts) {
    assert.equal(isPrivateTarget(h), true, `${h} 应判私网/loopback/link-local`);
  }

  const publicHosts = [
    "api.anthropic.com",
    "www.reclaude.ai",
    "chatgpt.com",
    "api.github.com",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // 172.16/12 之外
    "100.63.255.255", // CGNAT 下界之外
    "100.128.0.1", // CGNAT 上界之外
    "2001:4860:4860::8888", // 公网 IPv6 (Google DNS)
    "::ffff:8.8.8.8", // IPv4-mapped 公网 IP 不能误拦
    "::ffff:0808:0808", // = 8.8.8.8 hex 形，公网
  ];
  for (const h of publicHosts) {
    assert.equal(isPrivateTarget(h), false, `${h} 应判公网`);
  }
});

test("默认 allowTarget 策略：CONNECT 到私网/loopback/非 443 端口一律 403", async () => {
  const { proxy, port } = await startProxy();

  const cases = [
    "127.0.0.1:8080", // loopback + 非 443
    "127.0.0.1:443", // loopback，即便是 443 也拒
    "10.0.0.5:443", // 私网段，即便是 443 也拒
    "192.168.1.1:443",
    "169.254.1.1:443",
    "[::1]:443",
    "api.anthropic.com:8080", // 公网主机但端口不是 443
  ];
  for (const target of cases) {
    const { response } = await rawConnect(port, target);
    assert.match(response, /HTTP\/1\.1 403 Forbidden/, `${target} 应被默认策略拒绝，实际: ${response}`);
  }

  await new Promise((r) => proxy.close(r));
});

test("默认 allowTarget 策略：CONNECT 到公网 443 目标放行至拨号阶段（失败原因来自拨号而非策略）", async () => {
  // 注入一个总是失败的 lookup：如果策略放行，会走到 dial 失败的 502；
  // 如果被策略挡在门外，会是 403。二者互斥，用来区分"放行"与"拒绝"。
  const failingLookup = (_hostname, _options, cb) => cb(new Error("ENOTFOUND"));
  const { proxy, port } = await startProxy({ lookup: failingLookup });

  for (const host of ["api.anthropic.com", "www.reclaude.ai", "chatgpt.com", "api.github.com"]) {
    const { response } = await rawConnect(port, `${host}:443`);
    assert.match(
      response,
      /HTTP\/1\.1 502 Bad Gateway/,
      `${host}:443 应被默认策略放行到拨号阶段，实际: ${response}`,
    );
  }

  await new Promise((r) => proxy.close(r));
});

test("默认 allowTarget 策略：内置白名单为空（v2.54），未注入 extraAllowedTargets 时任何非 443 端口都拒", async (t) => {
  // 同 443 用例的手法：失败 lookup 区分"放行到拨号(502)"与"策略拒绝(403)"。
  const failingLookup = (_hostname, _options, cb) => cb(new Error("ENOTFOUND"));
  const { proxy, port } = await startProxy({ lookup: failingLookup });
  t.after(() => new Promise((r) => proxy.close(r)));

  assert.equal(EXTRA_ALLOWED_TARGETS.size, 0, "代码里不再预烤任何人的站点");
  // 曾经内置的 close-api:9443 现在要靠配置层（个人白名单）声明，缺省一律 403。
  for (const target of ["api.relay-demo.example:9443", "api.anthropic.com:9443", "api.relay-demo.example:8080"]) {
    const { response } = await rawConnect(port, target);
    assert.match(response, /HTTP\/1\.1 403 Forbidden/, `${target} 应被默认策略拒绝，实际: ${response}`);
  }
  // 公网 443 大门不受影响。
  const std = await rawConnect(port, "api.anthropic.com:443");
  assert.match(std.response, /HTTP\/1\.1 502 Bad Gateway/);
});

test("注入 extraAllowedTargets 覆盖内置白名单：新条目放行、旧内置条目不再放行", async () => {
  const failingLookup = (_hostname, _options, cb) => cb(new Error("ENOTFOUND"));
  const { proxy, port } = await startProxy({
    lookup: failingLookup,
    extraAllowedTargets: new Set(["my-api.example.com:9444"]),
  });

  // 注入的条目放行至拨号阶段（大小写不敏感）。
  for (const target of ["my-api.example.com:9444", "MY-API.example.com:9444"]) {
    const { response } = await rawConnect(port, target);
    assert.match(response, /HTTP\/1\.1 502 Bad Gateway/, `${target} 应被注入白名单放行到拨号阶段，实际: ${response}`);
  }

  // 注入即整体替换：内置默认条目不再自动放行（否则同事无法收紧策略）。
  const { response } = await rawConnect(port, "api.relay-demo.example:9443");
  assert.match(response, /HTTP\/1\.1 403 Forbidden/, `覆盖后内置条目应被拒，实际: ${response}`);

  // 公网 443 大门不受白名单注入影响。
  const std = await rawConnect(port, "api.anthropic.com:443");
  assert.match(std.response, /HTTP\/1\.1 502 Bad Gateway/, `443 常规放行不应受影响，实际: ${std.response}`);

  await new Promise((r) => proxy.close(r));
});

test("私网/loopback 拦截优先级高于白名单：即便条目被注入进 extraAllowedTargets 也一律 403", async () => {
  // 生产生命线：白名单绝不能成为 SSRF 后门——即使配置被写入私网目标（误配或恶意），
  // isPrivateTarget 拦截必须先于白名单命中生效。
  const { proxy, port } = await startProxy({
    extraAllowedTargets: new Set(["127.0.0.1:9443", "localhost:9443", "10.0.0.5:9443", "::1:9443"]),
  });

  for (const target of ["127.0.0.1:9443", "localhost:9443", "10.0.0.5:9443", "[::1]:9443"]) {
    const { response } = await rawConnect(port, target);
    assert.match(response, /HTTP\/1\.1 403 Forbidden/, `${target} 在白名单内也必须被私网拦截拒绝，实际: ${response}`);
  }

  await new Promise((r) => proxy.close(r));
});

// ---- DNS rebinding 兜底闸门：字面量是公网主机名、解析结果却是私网地址的穿透场景 ----

// 按 host 表返回固定记录的 lookup mock（dns.lookup 兼容签名，支持 all:true 与单地址两种形态）。
function makeStaticLookup(table) {
  return (hostname, options, cb) => {
    if (typeof options === "function") {
      cb = options;
      options = {};
    }
    const records = table[hostname];
    if (!records) {
      cb(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }));
      return;
    }
    if (options?.all) cb(null, records);
    else cb(null, records[0].address, records[0].family);
  };
}

test("DNS rebinding：主机名非私网字面量、但解析到 loopback/私网/IPv6 私网地址的 CONNECT 一律 403", async () => {
  const lines = [];
  const lookup = makeStaticLookup({
    "rebind-v4-loop.example.com": [{ address: "127.0.0.1", family: 4 }],
    "rebind-v4-rfc1918.example.com": [{ address: "10.1.2.3", family: 4 }],
    "rebind-v6-loop.example.com": [{ address: "::1", family: 6 }],
    "rebind-v6-mapped.example.com": [{ address: "::ffff:127.0.0.1", family: 6 }],
    "rebind-cgnat.example.com": [{ address: "100.64.0.7", family: 4 }],
  });
  const { proxy, port } = await startProxy({ lookup, log: (l) => lines.push(l) });

  for (const host of [
    "rebind-v4-loop.example.com",
    "rebind-v4-rfc1918.example.com",
    "rebind-v6-loop.example.com",
    "rebind-v6-mapped.example.com",
    "rebind-cgnat.example.com",
  ]) {
    const { response } = await rawConnect(port, `${host}:443`);
    assert.match(response, /HTTP\/1\.1 403 Forbidden/, `${host} 解析到私网地址应被拒，实际: ${response}`);
  }

  // 拒绝路径日志与字面量拒绝同格式（connect-deny 前缀），并带解析出的地址便于排障。
  assert.ok(
    lines.some((l) =>
      /^connect-deny host=rebind-v4-loop\.example\.com port=443 reason=resolved-private resolved=127\.0\.0\.1$/.test(l),
    ),
    `缺 resolved-private 拒绝打点，实际: ${JSON.stringify(lines)}`,
  );

  // 拒绝之后代理进程仍健康可服务（socket 无泄漏、无未捕获异常打崩进程）。
  const res = await httpGet({ host: "127.0.0.1", port, path: "/proxy-health" });
  assert.equal(res.status, 200);

  await new Promise((r) => proxy.close(r));
});

test("DNS rebinding：多地址混合（一个公网 + 一个私网）必须整体拒绝", async () => {
  const lookup = makeStaticLookup({
    "mixed.example.com": [
      { address: "8.8.8.8", family: 4 }, // 公网在前也救不了
      { address: "192.168.1.10", family: 4 },
    ],
  });
  const { proxy, port } = await startProxy({ lookup });

  const { response } = await rawConnect(port, "mixed.example.com:443");
  assert.match(response, /HTTP\/1\.1 403 Forbidden/, `混合地址应整体拒绝，实际: ${response}`);

  await new Promise((r) => proxy.close(r));
});

test("DNS rebinding 闸门不拦公网解析：多 A + AAAA 全公网时放行至拨号阶段（非 403）", async () => {
  const lookup = makeStaticLookup({
    "public.example.com": [
      // TEST-NET-1 与文档段 IPv6：isPrivateTarget 判公网。放行后的拨号结局取决于
      // 环境——裸机上不可达（502/504），本机挂透明代理/VPN 时可能被瞬间接成 200。
      // 策略拒绝的 403 与所有拨号结局互斥，断言"非 403 且为合法拨号结局"即可
      // 环境无关地锁住"闸门放行了多 A + AAAA 公网解析"这条语义。
      { address: "192.0.2.10", family: 4 },
      { address: "192.0.2.11", family: 4 },
      { address: "2001:db8::10", family: 6 },
    ],
  });
  const { proxy, port } = await startProxy({ lookup, connectTimeoutMs: 300 });

  const { socket, response } = await rawConnect(port, "public.example.com:443");
  socket.destroy(); // 若被透明代理接成 200，立即拆隧道，别让残留连接拖住 proxy.close
  assert.doesNotMatch(response, /403/, `全公网解析不应被闸门误拦，实际: ${response}`);
  assert.match(
    response,
    /HTTP\/1\.1 (200 Connection Established|50[24])/,
    `应放行至拨号阶段（200/502/504 之一），实际: ${response}`,
  );

  await new Promise((r) => proxy.close(r));
});

test("DNS rebinding：extraAllowedTargets 白名单命中也逃不过解析闸门", async () => {
  const lookup = makeStaticLookup({
    "sneaky.example.com": [{ address: "127.0.0.1", family: 4 }],
  });
  const { proxy, port } = await startProxy({
    lookup,
    extraAllowedTargets: new Set(["sneaky.example.com:9443"]),
  });

  const { response } = await rawConnect(port, "sneaky.example.com:9443");
  assert.match(response, /HTTP\/1\.1 403 Forbidden/, `白名单主机解析到私网也必须拒，实际: ${response}`);

  await new Promise((r) => proxy.close(r));
});

test("DNS rebinding：明文 HTTP 转发分支同样过解析闸门，解析到私网返回 403", async () => {
  const lines = [];
  const lookup = makeStaticLookup({
    "rebind-fwd.example.com": [{ address: "127.0.0.1", family: 4 }],
  });
  const { proxy, port } = await startProxy({ lookup, log: (l) => lines.push(l) });

  const res = await httpGet({ host: "127.0.0.1", port, path: "http://rebind-fwd.example.com:443/x" });
  assert.equal(res.status, 403);
  assert.ok(
    lines.some((l) =>
      /^forward-deny host=rebind-fwd\.example\.com port=443 reason=resolved-private resolved=127\.0\.0\.1$/.test(l),
    ),
    `缺 forward-deny resolved-private 打点，实际: ${JSON.stringify(lines)}`,
  );

  await new Promise((r) => proxy.close(r));
});

test("解析闸门与 allowTarget 同语义：策略显式放行的私网解析结果仍可正常建连（覆盖策略语义保留）", async () => {
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));
  const echoPort = echo.address().port;

  const lookup = makeStaticLookup({ "intra.test": [{ address: "127.0.0.1", family: 4 }] });
  // 调用方整体覆盖策略、显式放行该私网 IP:端口 => 闸门尊重同一套策略，不另行拦截。
  const allowTarget = (h, p) => (h === "intra.test" || h === "127.0.0.1") && Number(p) === echoPort;
  const { proxy, port } = await startProxy({ lookup, allowTarget });

  const { socket, response } = await rawConnect(port, `intra.test:${echoPort}`);
  assert.match(response, /HTTP\/1\.1 200 Connection Established/, `显式放行的私网解析应连通，实际: ${response}`);
  const echoed = await new Promise((resolve) => {
    socket.once("data", (buf) => resolve(String(buf)));
    socket.write("rebind-ok");
  });
  assert.equal(echoed, "rebind-ok");

  socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => echo.close(r));
});

test("createRebindGuardedLookup：单地址与 all:true 两种形态都透传公网结果、拦截私网结果、透传解析错误", async () => {
  const base = makeStaticLookup({
    "pub.test": [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ],
    "priv.test": [{ address: "10.0.0.1", family: 4 }],
  });
  const guard = createRebindGuardedLookup({ lookup: base, allowTarget: () => false, port: 443 });

  // all:true（autoSelectFamily 形态）：公网记录原样透传，多 A + AAAA 不丢不改。
  const records = await new Promise((res, rej) => guard("pub.test", { all: true }, (e, r) => (e ? rej(e) : res(r))));
  assert.deepEqual(records, [
    { address: "8.8.8.8", family: 4 },
    { address: "2001:db8::1", family: 6 },
  ]);

  // 单地址形态：address/family 原样透传。
  const single = await new Promise((res, rej) => guard("pub.test", {}, (e, a, f) => (e ? rej(e) : res({ a, f }))));
  assert.deepEqual(single, { a: "8.8.8.8", f: 4 });

  // 私网解析：以专用错误码拒绝，并带命中的地址。
  const err = await new Promise((res) => guard("priv.test", { all: true }, (e) => res(e)));
  assert.equal(err?.code, RESOLVED_PRIVATE_ERROR_CODE);
  assert.equal(err.blockedAddress, "10.0.0.1");

  // 底层解析错误原样透传（不吞、不改码）。
  const nf = await new Promise((res) => guard("nope.test", {}, (e) => res(e)));
  assert.equal(nf?.code, "ENOTFOUND");
});

test("parseProxyAllowedTargets：合法条目归一化（host 小写、端口数字化），数组顺序无关", () => {
  const parsed = parseProxyAllowedTargets([
    "api.relay-demo.example:9443",
    "MY-API.Example.COM:8443",
    "  padded.example.com:9443  ", // 前后空白应被容忍（手改 JSON 常见）
    "dup.example.com:9443",
    "dup.example.com:9443", // 重复条目自然去重（Set 语义）
  ]);
  assert.deepEqual(
    [...parsed].sort(),
    ["api.relay-demo.example:9443", "dup.example.com:9443", "my-api.example.com:8443", "padded.example.com:9443"].sort(),
  );
});

test("parseProxyAllowedTargets：非法条目逐条跳过并告警，绝不抛异常（配置烂不能导致代理起不来）", () => {
  const warnings = [];
  const log = (line) => warnings.push(line);

  const parsed = parseProxyAllowedTargets(
    [
      "good.example.com:9443", // 唯一合法条目
      "no-port.example.com", // 缺端口
      "bad-port.example.com:abc", // 非数字端口
      "zero.example.com:0", // 端口越下界
      "over.example.com:70000", // 端口越上界
      ":9443", // 空 host
      "127.0.0.1:9443", // 私网字面量：启动期即告警跳过，别等到 CONNECT 才发现 403
      "[::1]", // IPv6 字面量但缺显式端口
      42, // 非字符串
      null,
    ],
    { log },
  );

  assert.deepEqual([...parsed], ["good.example.com:9443"]);
  assert.equal(warnings.length, 9, `每个非法条目一条告警，实际: ${JSON.stringify(warnings)}`);

  // 非数组输入：返回空集 + 一条告警，同样不抛。
  const notArrayWarnings = [];
  const empty = parseProxyAllowedTargets("api.relay-demo.example:9443", { log: (l) => notArrayWarnings.push(l) });
  assert.equal(empty.size, 0);
  assert.equal(notArrayWarnings.length, 1);

  // undefined/null（配置无此字段）：静默返回空集，不告警。
  const silent = [];
  assert.equal(parseProxyAllowedTargets(undefined, { log: (l) => silent.push(l) }).size, 0);
  assert.equal(parseProxyAllowedTargets(null, { log: (l) => silent.push(l) }).size, 0);
  assert.equal(silent.length, 0);
});

test("resolveExtraAllowedTargets：配置缺字段回落内置默认（v2.54 起为空集）；显式空数组表示清空；整字段类型烂回落默认", () => {
  // 字段缺失（undefined/null）→ 内置默认，现在是空集。
  assert.equal(resolveExtraAllowedTargets(undefined), EXTRA_ALLOWED_TARGETS);
  assert.equal(resolveExtraAllowedTargets(null), EXTRA_ALLOWED_TARGETS);
  assert.equal(EXTRA_ALLOWED_TARGETS.size, 0);
  // 字段显式存在（哪怕是空数组）→ 尊重配置意图，不再偷偷混入内置默认。
  assert.equal(resolveExtraAllowedTargets([]).size, 0);
  const custom = resolveExtraAllowedTargets(["a.example.com:9443"]);
  assert.ok(custom.has("a.example.com:9443"));
  assert.equal(custom.has("api.relay-demo.example:9443"), false);
  // 整个字段类型写错（如误写成字符串）→ 告警并回落内置默认，而不是把生效中的白名单静默清空。
  const warnings = [];
  assert.equal(resolveExtraAllowedTargets("api.relay-demo.example:9443", { log: (l) => warnings.push(l) }), EXTRA_ALLOWED_TARGETS);
  assert.equal(warnings.length, 1);
});

// ---- CLI 入口 e2e：真实子进程 + 临时 config.json，验证配置层到 allowTarget 的完整链路 ----

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const proxyScriptPath = fileURLToPath(new URL("./local_http_connect_proxy.mjs", import.meta.url));

// 以随机端口（PORT=0）+ 指定 config 路径启动真实代理子进程，从启动日志解析实际端口。
// 生产 8888 实例由 supervisor 管理，这里绝不触碰——全程随机端口、用完即杀。
// 个人层与数据目录也指到 config 旁边的临时位置：开发模式下个人层默认是仓库根目录的 config.local.json，
// 白名单与团队层取并集——开发机上那份真实配置里的条目会混进来（曾让「配置覆盖后内置条目应被拒」只在
// 本机失败、CI 通过）；代理默认记录流量，不隔离数据目录还会往真实运行目录里写使用记录。
async function spawnProxyProcess(configPath, extraEnv = {}) {
  const sandbox = path.dirname(configPath);
  const child = spawn(process.execPath, [proxyScriptPath], {
    env: {
      ...process.env,
      PORT: "0",
      CODEX_MONITOR_CONFIG_PATH: configPath,
      CODEX_MONITOR_LOCAL_CONFIG_PATH: path.join(sandbox, "config.local.json"),
      CODEX_MONITOR_DATA_DIR: path.join(sandbox, "data"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed; // Windows 必须等句柄释放后再删除临时目录。
  };
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  let port;
  try { port = await new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`proxy 未在 5s 内就绪，stdout=${stdout} stderr=${stderr}`)), 5000);
    child.stdout.on("data", (c) => {
      stdout += c;
      const m = stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy 提前退出 code=${code}，stderr=${stderr}`));
    });
  });
  } catch (error) { await stop(); throw error; }
  return { child, port, stop, getStderr: () => stderr };
}

test("e2e：config.json 的 proxyAllowedTargets 生效——配置条目放行、旧内置条目被配置覆盖后拒绝", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-allowlist-"));
  let stopProxy = async () => {};
  t.after(async () => {
    await stopProxy();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ proxyAllowedTargets: ["allowed-e2e.invalid:9443"] }));

  const { port, stop } = await spawnProxyProcess(configPath);
  stopProxy = stop;

  // 真实子进程无法注入 lookup，且本地 DNS 可能对任意域名做 NXDOMAIN 劫持（返回真实 IP），
  // 拨号结果（200/502/504）不可控——但"被策略拒绝"必然是 403 且互斥，用"非 403"判放行。
  const allowed = await rawConnect(port, "allowed-e2e.invalid:9443");
  assert.doesNotMatch(allowed.response, /HTTP\/1\.1 403/, `配置白名单条目应放行（不该 403），实际: ${allowed.response}`);

  // 配置显式给出字段 → 内置默认条目不再放行（整体替换语义，端到端锁死）。
  const overridden = await rawConnect(port, "api.relay-demo.example:9443");
  assert.match(overridden.response, /HTTP\/1\.1 403 Forbidden/, `配置覆盖后内置条目应被拒，实际: ${overridden.response}`);
});

test("e2e：config.json 整个烂掉（JSON 解析失败）代理仍能启动，且私网/未白名单目标照拒", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-badconf-"));
  let stopProxy = async () => {};
  t.after(async () => {
    await stopProxy();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, "{definitely not json");

  // 关键断言就在 spawnProxyProcess 内部：能解析出监听端口 = 没有因配置烂而起不来。
  const { port, stop, getStderr } = await spawnProxyProcess(configPath);
  stopProxy = stop;

  assert.match(getStderr(), /proxyAllowedTargets|config/i, "应有一条配置回落告警（含上下文），方便排障");

  // 回落后策略仍完整：私网 403、未白名单端口 403。
  const priv = await rawConnect(port, "127.0.0.1:9443");
  assert.match(priv.response, /HTTP\/1\.1 403 Forbidden/);
  const notListed = await rawConnect(port, "nope.invalid:9443");
  assert.match(notListed.response, /HTTP\/1\.1 403 Forbidden/);
});

// 轮询直到 check() 为真（代理 2 秒一查文件戳，给足 8 秒）。
async function waitFor(check, { timeoutMs = 8000, stepMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

test("e2e：改个人层白名单与出网方式，运行中的代理几秒内热载（同一进程，不重启）", { timeout: 60000 }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "proxy-hot-reload-"));
  let stopProxy = async () => {};
  t.after(async () => {
    await stopProxy();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const configPath = path.join(dir, "config.json");
  const localConfigPath = path.join(dir, "config.local.json");
  await writeFile(configPath, JSON.stringify({}));
  await writeFile(localConfigPath, JSON.stringify({}));

  // 假上游 HTTP 代理：记下 CONNECT 目标，回 200 后当 echo。
  const upstreamRequests = [];
  const upstreamSockets = new Set();
  const upstream = net.createServer((socket) => {
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", (buf) => {
      upstreamRequests.push(String(buf).split("\r\n")[0]);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("data", (more) => socket.write(more));
    });
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    for (const socket of upstreamSockets) socket.destroy();
    await new Promise((r) => upstream.close(r));
  });

  const { child, port, stop, getStderr } = await spawnProxyProcess(configPath, {
    CODEX_MONITOR_LOCAL_CONFIG_PATH: localConfigPath,
    CODEX_MONITOR_DATA_DIR: path.join(dir, "data"),
  });
  stopProxy = stop;
  const pid = child.pid;

  const before = await rawConnect(port, "hot-reload.invalid:9443");
  assert.match(before.response, /HTTP\/1\.1 403 Forbidden/, "还没加白名单");
  before.socket.destroy();

  // ① 加个人白名单：同一进程、几秒内放行（非 403 即放行，拨号结果取决于本机 DNS）。
  await writeFile(localConfigPath, JSON.stringify({ proxyAllowedTargets: ["hot-reload.invalid:9443"] }));
  const allowed = await waitFor(async () => {
    const r = await rawConnect(port, "hot-reload.invalid:9443");
    r.socket.destroy();
    return !/403/.test(r.response);
  });
  assert.ok(allowed, `白名单应热载生效，stderr=${getStderr()}`);
  assert.match(getStderr(), /策略已热重载：白名单 1 条/);

  // ② 切到手动上游：之后的 CONNECT 交给上游（发过去的是原主机名）。
  await writeFile(localConfigPath, JSON.stringify({
    proxyAllowedTargets: ["hot-reload.invalid:9443"],
    egress: { mode: "manual", url: `http://127.0.0.1:${upstream.address().port}` },
  }));
  const viaUpstream = await waitFor(async () => {
    const r = await rawConnect(port, "api.openai.com:443");
    r.socket.destroy();
    return upstreamRequests.some((line) => line.startsWith("CONNECT api.openai.com:443 "));
  });
  assert.ok(viaUpstream, `出网方式应热载为手动上游，stderr=${getStderr()}`);
  assert.equal(child.pid, pid);
  assert.equal(child.exitCode, null, "全程同一个代理进程，没有重启");
});

test("默认 allowTarget 策略同样作用于明文 HTTP 转发分支：私网目标 403", async () => {
  const { proxy, port } = await startProxy();
  const res = await httpGet({ host: "127.0.0.1", port, path: "http://127.0.0.1:9/xyz" });
  assert.equal(res.status, 403);
  await new Promise((r) => proxy.close(r));
});

test("拨号失败后驱逐 DNS 缓存条目，下一次 CONNECT 重新解析而非复用死记录", async () => {
  // 制造一个稳定失败的目标：绑定后立即关掉，端口在本机不再有人监听 => ECONNREFUSED。
  const deadServer = net.createServer();
  await new Promise((r) => deadServer.listen(0, "127.0.0.1", r));
  const deadPort = deadServer.address().port;
  await new Promise((r) => deadServer.close(r));

  let baseCalls = 0;
  const baseLookup = (_hostname, _options, cb) => {
    baseCalls += 1;
    cb(null, [{ address: "127.0.0.1", family: 4 }]);
  };
  const lookup = createCachedLookup({ ttlMs: 60000, baseLookup, now: Date.now });
  const { proxy, port } = await startProxy({ lookup, allowTarget: () => true });

  const first = await rawConnect(port, `dead.test:${deadPort}`);
  assert.match(first.response, /HTTP\/1\.1 502 Bad Gateway/);
  assert.equal(baseCalls, 1, "首次 CONNECT 应触发一次真实解析");
  assert.equal(lookup.has("dead.test"), false, "拨号失败后应把该 host 从 DNS 缓存驱逐");

  const second = await rawConnect(port, `dead.test:${deadPort}`);
  assert.match(second.response, /HTTP\/1\.1 502 Bad Gateway/);
  assert.equal(baseCalls, 2, "驱逐后下一次 CONNECT 应重新触发 lookup，而不是复用死记录");

  await new Promise((r) => proxy.close(r));
});

test("allowTarget 可由调用方整体覆盖默认策略", async () => {
  const { proxy, port } = await startProxy({ allowTarget: () => true });
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise((r) => echo.listen(0, "127.0.0.1", r));

  const { socket, response } = await rawConnect(port, `127.0.0.1:${echo.address().port}`);
  assert.match(response, /HTTP\/1\.1 200 Connection Established/);

  socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => echo.close(r));
});
