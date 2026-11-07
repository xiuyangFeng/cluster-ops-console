// 代理口令的三种模式（v2.62）经真实 http.Server 的端到端：放行 / 拒绝 / 计数、判定顺序、热切换、
// 日志与上游都不泄露口令。全程随机端口、本机回环，不碰真实网络与真实运行目录。
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { SIGNAL_RULES } from "../log-signals.mjs";
import { classifyProxyLogLine } from "../supervisor/log-policy.mjs";
import { AUTH_OFF, buildAuthPolicy, CONNECT_AUTH_REQUIRED_RESPONSE, validateProxyAuthDocument } from "./auth.mjs";
import { PROXY_HOP_HEADER } from "./headers.mjs";
import { makeDefaultAllowTarget } from "./target-policy.mjs";
import { createProxyServer } from "./server.mjs";
import { createUsageRecorder, USAGE_OTHER_KEY } from "./usage.mjs";

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const OLD_TOKEN = "OldTokenZZZZyyyyXXXXwwww98765432";
const WRONG = "WrongTokenQQQQrrrrSSSStttt555555";
const basic = (token, user = "cwb") => `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
const authPolicy = (mode, extra = {}) => buildAuthPolicy(validateProxyAuthDocument({ v: 1, mode, user: "cwb", token: TOKEN, ...extra }).doc);

// 可热切换的策略：state.policy 整体替换即可（与 policy-reload 的做法一致）。
function policyBox({ auth, allowTarget = () => true, upstream = null } = {}) {
  const state = { policy: { allowTarget, upstream, egressMode: upstream ? "manual" : "direct", ...(auth ? { auth } : {}) } };
  return { state, getPolicy: () => state.policy, setAuth: (next) => { state.policy = { ...state.policy, auth: next }; } };
}

async function startProxy(options = {}) {
  const lines = [];
  const proxy = createProxyServer({ port: 0, log: (line) => lines.push(line), connectTimeoutMs: 500, ...options });
  await new Promise((resolve) => proxy.listen(resolve));
  return { proxy, port: proxy.server.address().port, lines, close: () => new Promise((resolve) => proxy.close(resolve)) };
}

async function startEcho() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.pipe(socket);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let connections = 0;
  server.on("connection", () => { connections += 1; });
  return {
    port: server.address().port,
    connections: () => connections,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

// 源站：固定 Date 头（否则每秒都不同，没法逐字节比），回显收到的请求头。
async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/plain", date: "Mon, 01 Jan 2024 00:00:00 GMT", connection: "close" });
      res.end(`origin saw ${req.method} ${req.url} body=${body}`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

// 裸 socket 发一段请求，收到连接关闭为止的全部字节。
function rawExchange(port, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", reject);
  });
}

// CONNECT：返回 { socket, head }，head 是到第一个空行为止的应答（隧道建成后 socket 留给调用方）。
function connect(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""];
    let received = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(lines.join("\r\n")));
    const onData = (chunk) => {
      received += chunk.toString("latin1");
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      resolve({ socket, head: received.slice(0, end + 4), rest: received.slice(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve({ socket, head: received, rest: "", closed: true }));
  });
}

function roundTrip(socket, payload) {
  return new Promise((resolve) => {
    socket.once("data", (chunk) => resolve(String(chunk)));
    socket.write(payload);
  });
}

const plainRequest = (target, headers = {}, body = "") => [
  `${body ? "POST" : "GET"} ${target} HTTP/1.1`,
  `Host: ${new URL(target, "http://x").host}`,
  "Connection: close",
  ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
  ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
  "",
  body,
].join("\r\n");

// 代理自己生成的应答带 Date 头（每秒变）：比较前抹掉这一行的值。
const withoutDate = (text) => text.replace(/^date: .*$/gim, "date: <masked>");

// 记录器替身：任何方法被调用都记下来。off 模式下必须一次都没有。
function usageSpy() {
  const calls = [];
  return { calls, recorder: new Proxy({}, { get: (_target, name) => (...args) => { calls.push([String(name), ...args]); } }) };
}

function memoryRecorder(options = {}) {
  const writes = [];
  const recorder = createUsageRecorder({
    filePath: "/nowhere/proxy-usage.json",
    readFile: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    write: async (_file, body) => { writes.push(body); },
    writeSync: (_file, body) => { writes.push(body); },
    setIntervalImpl: () => 1,
    clearIntervalImpl: () => {},
    ...options,
  });
  return { recorder, writes };
}

const rowOf = (recorder, key) => {
  const merged = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const hour of recorder.snapshot().hours) {
    const row = hour.targets.get(key);
    if (row) row.forEach((value, i) => { merged[i] = i === 3 ? Math.max(merged[i], value) : merged[i] + value; });
  }
  const [conn, up, down, lastAt, authed, missing, bad, denied] = merged;
  return { conn, up, down, lastAt, authed, missing, bad, denied };
};

const HEADER_VARIANTS = [
  ["不带", {}],
  ["带对的口令", { "Proxy-Authorization": basic(TOKEN) }],
  ["带错的口令", { "Proxy-Authorization": basic(WRONG) }],
  ["带不认识的方案", { "Proxy-Authorization": "Bearer something" }],
];

for (const [label, auth] of [["策略里没有 auth", undefined], ["auth 为 off", AUTH_OFF]]) {
  test(`off（${label}）：带不带 Proxy-Authorization、带什么，应答都逐字节相同；记录器一次都不调用`, async (t) => {
    const echo = await startEcho();
    const origin = await startOrigin();
    const spy = usageSpy();
    // 用默认放行策略之外再放行本机的两个测试端口，同时保留「私网 / 非 443 拒绝」来测 403。
    const allowed = new Set([`127.0.0.1:${echo.port}`, `127.0.0.1:${origin.port}`]);
    const fallback = makeDefaultAllowTarget(new Set());
    const box = policyBox({ auth, allowTarget: (host, port) => allowed.has(`${host}:${port}`) || fallback(host, port) });
    const p = await startProxy({ getPolicy: box.getPolicy, usage: spy.recorder });
    t.after(async () => {
      await p.close();
      await echo.close();
      await origin.close();
    });

    const cases = {
      "CONNECT 放行": async (headers) => {
        const { socket, head } = await connect(p.port, `127.0.0.1:${echo.port}`, headers);
        const echoed = await roundTrip(socket, "ping");
        socket.destroy();
        return `${head}|${echoed}`;
      },
      "CONNECT 被策略拒绝": (headers) => rawExchange(p.port, [`CONNECT 127.0.0.1:9 HTTP/1.1`, "Host: x", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n")),
      "CONNECT 畸形端口": (headers) => rawExchange(p.port, [`CONNECT badhost:70000 HTTP/1.1`, "Host: x", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n")),
      "明文转发": async (headers) => rawExchange(p.port, plainRequest(`http://127.0.0.1:${origin.port}/path?q=1`, headers)),
      "明文转发带正文": async (headers) => rawExchange(p.port, plainRequest(`http://127.0.0.1:${origin.port}/post`, headers, "payload")),
      "明文被策略拒绝": async (headers) => withoutDate(await rawExchange(p.port, plainRequest("http://127.0.0.1:9/x", headers))),
      "相对地址": async (headers) => withoutDate(await rawExchange(p.port, plainRequest("/not-proxy-form", headers))),
    };
    const expectedStart = {
      "CONNECT 放行": "HTTP/1.1 200 Connection Established\r\n\r\n|ping",
      "CONNECT 被策略拒绝": "HTTP/1.1 403 Forbidden\r\n\r\n",
      "CONNECT 畸形端口": "HTTP/1.1 400 Bad Request\r\n\r\n",
      "明文转发": "HTTP/1.1 200 OK\r\n",
      "明文转发带正文": "HTTP/1.1 200 OK\r\n",
      "明文被策略拒绝": "HTTP/1.1 403 Forbidden\r\n",
      "相对地址": "HTTP/1.1 400 Bad Request\r\n",
    };
    for (const [name, run] of Object.entries(cases)) {
      const outputs = [];
      for (const [, headers] of HEADER_VARIANTS) outputs.push(await run(headers));
      assert.ok(outputs[0].startsWith(expectedStart[name]), `${name}: ${JSON.stringify(outputs[0].slice(0, 80))}`);
      for (let i = 1; i < outputs.length; i += 1) {
        assert.equal(outputs[i], outputs[0], `${name}：「${HEADER_VARIANTS[i][0]}」与「不带」的应答应逐字节相同`);
      }
    }
    // 源站从没见过 Proxy-Authorization（逐跳头照旧剥掉），其余请求头在各种写法下也相同。
    assert.equal(origin.seen.length, 2 * HEADER_VARIANTS.length);
    for (const request of origin.seen) assert.equal(request.headers["proxy-authorization"], undefined);
    assert.deepEqual(spy.calls, [], "off 模式下使用记录器不该被碰");
    assert.equal(p.lines.some((line) => /auth-deny/.test(line)), false);
  });
}

test("observe：全部放行，带对 / 没带 / 带错分别计数；被策略拒掉的不计入", async (t) => {
  const echo = await startEcho();
  const { recorder } = memoryRecorder();
  recorder.setAuthMode("observe");
  recorder.start();
  const fallback = makeDefaultAllowTarget(new Set());
  const box = policyBox({ auth: authPolicy("observe"), allowTarget: (host, port) => (host === "127.0.0.1" && Number(port) === echo.port) || fallback(host, port) });
  const p = await startProxy({ getPolicy: box.getPolicy, usage: recorder });
  t.after(async () => {
    await p.close();
    await echo.close();
  });
  const target = `127.0.0.1:${echo.port}`;

  for (const headers of [{}, {}, { "Proxy-Authorization": basic(TOKEN) }, { "Proxy-Authorization": basic(WRONG) }]) {
    const { socket, head } = await connect(p.port, target, headers);
    assert.equal(head, "HTTP/1.1 200 Connection Established\r\n\r\n", "observe 不拦任何请求");
    assert.equal(await roundTrip(socket, "hello"), "hello");
    await new Promise((resolve) => {
      socket.once("close", resolve);
      socket.destroy();
    });
  }
  // 被放行策略拒掉的请求：照旧 403，不计入「没带口令」。
  assert.equal(await rawExchange(p.port, "CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: x\r\n\r\n"), "HTTP/1.1 403 Forbidden\r\n\r\n");

  // 隧道关闭后字节才补记完：等记录器把四条都收尾。
  for (let i = 0; i < 100 && recorder.liveCount() > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const row = rowOf(recorder, target);
  assert.deepEqual({ conn: row.conn, authed: row.authed, missing: row.missing, bad: row.bad, denied: row.denied }, { conn: 4, authed: 1, missing: 2, bad: 1, denied: 0 });
  assert.equal(row.up, 4 * 5, "上行 = 四次 hello");
  assert.equal(row.down, 4 * 5, "下行 = 四次回显");
  assert.equal(rowOf(recorder, "127.0.0.1:9").missing, 0);
  assert.equal(rowOf(recorder, USAGE_OTHER_KEY).missing, 0);
  assert.equal(p.lines.some((line) => /auth-deny/.test(line)), false, "observe 不记 auth-deny");
});

test("enforce：没带 / 带错 → 407（两种情况字节完全相同）；带对 → 放行；过渡期内上一个口令也放行", async (t) => {
  const echo = await startEcho();
  const origin = await startOrigin();
  let clock = 1_000;
  const box = policyBox({ auth: authPolicy("enforce", { previousToken: OLD_TOKEN, previousUntil: 5_000 }) });
  const p = await startProxy({ getPolicy: box.getPolicy, now: () => clock });
  t.after(async () => {
    await p.close();
    await echo.close();
    await origin.close();
  });
  const target = `127.0.0.1:${echo.port}`;
  const connectRaw = (headers) => rawExchange(p.port, [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));

  // CONNECT：没带、带错、过期的旧口令、乱七八糟的头——全是同一串字节，连接随即关闭，目标从未被连过。
  const denied = [];
  for (const headers of [{}, { "Proxy-Authorization": basic(WRONG) }, { "Proxy-Authorization": "Bearer x" }, { "Proxy-Authorization": basic(TOKEN, "root") }, { "Proxy-Authorization": basic(TOKEN.slice(0, -1)) }]) {
    denied.push(await connectRaw(headers));
  }
  for (const response of denied) assert.equal(response, CONNECT_AUTH_REQUIRED_RESPONSE);
  assert.equal(echo.connections(), 0, "被拒的请求一个字节都没到目标");

  // 带对：放行，隧道可收发。
  const ok = await connect(p.port, target, { "Proxy-Authorization": basic(TOKEN) });
  assert.equal(ok.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  assert.equal(await roundTrip(ok.socket, "ping"), "ping");
  ok.socket.destroy();

  // 上一个口令：过渡期内放行，到点之后与错口令一样。
  const previous = await connect(p.port, target, { "Proxy-Authorization": basic(OLD_TOKEN) });
  assert.equal(previous.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  previous.socket.destroy();
  clock = 5_000;
  assert.equal(await connectRaw({ "Proxy-Authorization": basic(OLD_TOKEN) }), CONNECT_AUTH_REQUIRED_RESPONSE);

  // 明文转发：同样的判定；407 带质询头、没有正文，「没带」与「带错」逐字节相同（抹掉每秒变化的 Date）。
  const plain = (headers) => rawExchange(p.port, plainRequest(`http://127.0.0.1:${origin.port}/x`, headers));
  const plainMissing = withoutDate(await plain({}));
  const plainBad = withoutDate(await plain({ "Proxy-Authorization": basic(WRONG) }));
  assert.equal(plainMissing, plainBad);
  assert.match(plainMissing, /^HTTP\/1\.1 407 Proxy Authentication Required\r\n/);
  assert.match(plainMissing, /\r\nproxy-authenticate: Basic realm="cluster-workbench"\r\n/i);
  assert.match(plainMissing, /\r\n\r\n$/, "没有正文");
  assert.equal(origin.seen.length, 0);
  const plainOk = await plain({ "Proxy-Authorization": basic(TOKEN) });
  assert.match(plainOk, /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(origin.seen.length, 1);
  assert.equal(origin.seen[0].headers["proxy-authorization"], undefined, "口令是给本跳的，不转给源站");
});

test("/proxy-health：三种模式下都是 200，响应头完全相同、不带任何与口令有关的信息", async (t) => {
  const box = policyBox({ auth: AUTH_OFF });
  const p = await startProxy({ getPolicy: box.getPolicy, healthHeaders: { "x-codex-proxy-pid": "4242", "x-codex-proxy-component": "abcdef012345" } });
  t.after(() => p.close());
  const health = async () => withoutDate(await rawExchange(p.port, "GET /proxy-health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
  const off = await health();
  assert.match(off, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(off, /\r\n\r\n2\r\nok\r\n0\r\n\r\n$/, "正文就是 ok（Connection: close 下是分块编码）");
  for (const mode of ["observe", "enforce"]) {
    box.setAuth(authPolicy(mode, { previousToken: OLD_TOKEN, previousUntil: 9e12 }));
    const response = await health();
    assert.equal(response, off, `${mode} 下的 /proxy-health 应与 off 逐字节相同`);
    assert.doesNotMatch(response, /auth|token|enforce|observe|cwb|realm/i);
  }
});

test("判定顺序：畸形 400、环路 508 在口令之前；407 在放行策略之前——不带口令探不出白名单与内网", async (t) => {
  const hopId = "0123456789abcdef";
  const box = policyBox({ auth: authPolicy("enforce"), allowTarget: makeDefaultAllowTarget(new Set(["relay.example.com:9443"])) });
  const p = await startProxy({ getPolicy: box.getPolicy, hopId });
  t.after(() => p.close());
  const request = (target, headers = {}) => rawExchange(p.port, [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));

  assert.equal(await request("badhost:70000"), "HTTP/1.1 400 Bad Request\r\n\r\n");
  assert.equal(await request("api.example.com:443", { [PROXY_HOP_HEADER]: hopId }), "HTTP/1.1 508 Loop Detected\r\n\r\n");
  // 内网地址、不在白名单的端口、在白名单的端口：不带口令时全是同一个 407。
  for (const target of ["127.0.0.1:22", "10.0.0.5:443", "other.example.com:9443", "relay.example.com:9443"]) {
    assert.equal(await request(target), CONNECT_AUTH_REQUIRED_RESPONSE, target);
  }
  // 带了口令才看得到策略的回答。
  assert.equal(await request("127.0.0.1:22", { "Proxy-Authorization": basic(TOKEN) }), "HTTP/1.1 403 Forbidden\r\n\r\n");
  assert.equal(await request("other.example.com:9443", { "Proxy-Authorization": basic(TOKEN) }), "HTTP/1.1 403 Forbidden\r\n\r\n");
});

test("热切换：已建立的隧道不受影响；之后的新请求按新策略；切回 off 立即恢复", async (t) => {
  const echo = await startEcho();
  const box = policyBox({ auth: AUTH_OFF });
  const p = await startProxy({ getPolicy: box.getPolicy });
  t.after(async () => {
    await p.close();
    await echo.close();
  });
  const target = `127.0.0.1:${echo.port}`;

  const held = await connect(p.port, target); // off 时建立，不带口令
  assert.equal(await roundTrip(held.socket, "before"), "before");

  box.setAuth(authPolicy("enforce"));
  assert.equal(await roundTrip(held.socket, "still-alive"), "still-alive", "切到强制不断已有连接");
  assert.equal(await rawExchange(p.port, `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`), CONNECT_AUTH_REQUIRED_RESPONSE);
  assert.equal(p.proxy.activeConnections() >= 1, true);

  box.setAuth(authPolicy("observe"));
  const observed = await connect(p.port, target);
  assert.equal(observed.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  observed.socket.destroy();

  box.setAuth(AUTH_OFF);
  const reopened = await connect(p.port, target);
  assert.equal(reopened.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  reopened.socket.destroy();
  assert.equal(await roundTrip(held.socket, "after"), "after");
  held.socket.destroy();
});

test("auth-deny 日志：每分钟最多一条并带压掉的条数；行里没有任何口令；不会被当成 connect-deny 或建连打点", async (t) => {
  let clock = 0;
  const { recorder } = memoryRecorder({ now: () => clock });
  recorder.setAuthMode("enforce");
  recorder.start();
  const box = policyBox({ auth: authPolicy("enforce"), allowTarget: makeDefaultAllowTarget(new Set()) });
  const p = await startProxy({ getPolicy: box.getPolicy, now: () => clock, usage: recorder });
  t.after(() => p.close());
  const request = (target, headers = {}) => rawExchange(p.port, [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));

  await request("api.example.com:443");
  await request("api.example.com:443", { "Proxy-Authorization": basic(WRONG) });
  await request("10.0.0.5:22", { "Proxy-Authorization": basic(WRONG) });
  clock = 60_000;
  await request("api.example.com:443", { "Proxy-Authorization": basic(WRONG) });

  const denyLines = p.lines.filter((line) => line.startsWith("auth-deny "));
  assert.deepEqual(denyLines, [
    "auth-deny host=api.example.com port=443 via=connect reason=missing",
    "auth-deny host=api.example.com port=443 via=connect reason=bad suppressed=2",
  ]);
  const everything = p.lines.join("\n");
  for (const secret of [TOKEN, WRONG, Buffer.from(`cwb:${TOKEN}`).toString("base64"), Buffer.from(`cwb:${WRONG}`).toString("base64")]) {
    assert.equal(everything.includes(secret), false, "日志里不该出现口令或它的 base64");
  }
  // supervisor 按子串给代理输出分级、界面按行首认「目标被拒绝」信号：auth-deny 两边都不该撞上。
  const connectDenyRule = SIGNAL_RULES.find((rule) => rule.id === "connect-deny");
  for (const line of denyLines) {
    assert.deepEqual(classifyProxyLogLine(line), { persist: true, level: "info" });
    assert.equal(connectDenyRule.lineRe.every((re) => re.test(line) || re.test(`[proxy] ${line}`)), false);
  }
  // 记账：过得了放行策略的目标按目标记，过不了的（内网）只进「其它」。
  const row = rowOf(recorder, "api.example.com:443");
  assert.deepEqual({ denied: row.denied, missing: row.missing, bad: row.bad, conn: row.conn }, { denied: 3, missing: 1, bad: 2, conn: 0 });
  assert.equal(rowOf(recorder, "10.0.0.5:22").denied, 0);
  assert.equal(rowOf(recorder, USAGE_OTHER_KEY).denied, 1);
});

test("上游模式 + enforce：发给上游代理的 CONNECT 仍只有 Host 与跳标记，口令不外泄；建隧道的字节不算流量", async (t) => {
  const upstreamRequests = [];
  const upstream = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (buf) => {
      upstreamRequests.push(String(buf));
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("data", (more) => socket.write(more));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { recorder } = memoryRecorder();
  recorder.setAuthMode("enforce");
  recorder.start();
  const box = policyBox({
    auth: authPolicy("enforce"),
    allowTarget: makeDefaultAllowTarget(new Set()),
    upstream: { host: "127.0.0.1", port: upstream.address().port, url: `http://127.0.0.1:${upstream.address().port}` },
  });
  const p = await startProxy({
    getPolicy: box.getPolicy,
    usage: recorder,
    lookup: (_host, options, cb) => (options?.all ? cb(null, [{ address: "93.184.216.34", family: 4 }]) : cb(null, "93.184.216.34", 4)),
  });
  t.after(async () => {
    await p.close();
    await new Promise((resolve) => upstream.close(resolve));
  });

  assert.equal(await rawExchange(p.port, "CONNECT api.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"), CONNECT_AUTH_REQUIRED_RESPONSE);
  assert.equal(upstreamRequests.length, 0, "被拒的请求不碰上游");

  const tunnel = await connect(p.port, "api.example.com:443", { "Proxy-Authorization": basic(TOKEN) });
  assert.equal(tunnel.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  assert.equal(await roundTrip(tunnel.socket, "0123456789"), "0123456789");
  await new Promise((resolve) => {
    tunnel.socket.once("close", resolve);
    tunnel.socket.destroy();
  });
  assert.equal(upstreamRequests.length, 1);
  assert.match(upstreamRequests[0], /^CONNECT api\.example\.com:443 HTTP\/1\.1\r\nHost: api\.example\.com:443\r\nx-codex-proxy-hop: [0-9a-f]{16}\r\n\r\n$/);
  assert.equal(/authorization|cwb|Basic/i.test(upstreamRequests[0]), false);

  for (let i = 0; i < 100 && recorder.liveCount() > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  // 上行 / 下行各 10 字节：发给上游的 CONNECT 请求行与上游的 200 应答都没算进去。被拒的那一次只记次数。
  const row = rowOf(recorder, "api.example.com:443");
  assert.deepEqual(
    { conn: row.conn, up: row.up, down: row.down, authed: row.authed, missing: row.missing, denied: row.denied },
    { conn: 1, up: 10, down: 10, authed: 1, missing: 1, denied: 1 },
  );
  assert.equal(rowOf(recorder, USAGE_OTHER_KEY).denied, 0);
});

test("记录器抛错不影响转发；目标名字符不合规的记进「其它」", async (t) => {
  const echo = await startEcho();
  const exploding = new Proxy({}, { get: () => () => { throw new Error("recorder bug"); } });
  const box = policyBox({ auth: authPolicy("observe") });
  const p = await startProxy({ getPolicy: box.getPolicy, usage: exploding });
  t.after(async () => {
    await p.close();
    await echo.close();
  });
  const tunnel = await connect(p.port, `127.0.0.1:${echo.port}`);
  assert.equal(tunnel.head, "HTTP/1.1 200 Connection Established\r\n\r\n");
  assert.equal(await roundTrip(tunnel.socket, "ping"), "ping");
  tunnel.socket.destroy();
});
