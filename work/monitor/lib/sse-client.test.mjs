import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createSseParser, createSseSubscription } from "./sse-client.mjs";

test("createSseParser: 跨 chunk 拼接、CRLF、注释心跳、多行 data", () => {
  const events = [];
  const feed = createSseParser((evt) => events.push(evt));
  feed(":hb\n\nevent: status\ndata: {\"a\"");
  feed(":1}\r\n\r\n");
  feed("event: log\ndata: line1\ndata: line2\n\n");
  feed("data: plain\n\n");
  assert.deepEqual(events, [
    { event: "status", data: "{\"a\":1}" },
    { event: "log", data: "line1\nline2" },
    { event: "message", data: "plain" },
  ]);
});

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function waitFor(predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("createSseSubscription: 带头订阅、收事件、服务端断开后退避重连、stop 后不再重连", async () => {
  const seenTokens = [];
  const openResponses = new Set();
  const server = await listen((req, res) => {
    seenTokens.push(req.headers["x-auth-token"]);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: status\ndata: ${JSON.stringify({ lite: { health: "ready", n: seenTokens.length } })}\n\n`);
    openResponses.add(res);
    // 第一条连接立刻被服务端关闭（模拟 monitor 重启）。
    if (seenTokens.length === 1) setTimeout(() => res.end(), 20);
  });
  const events = [];
  const downs = [];
  const sub = createSseSubscription({
    url: `http://127.0.0.1:${server.address().port}/api/events`,
    headers: { "x-auth-token": "tok" },
    onEvent: (evt) => events.push(JSON.parse(evt.data).lite.n),
    onDown: (reason) => downs.push(reason),
    backoffBaseMs: 10,
  });
  try {
    sub.start();
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events.slice(0, 2), [1, 2], "断开后自动重连并再次拿到全量状态");
    assert.ok(downs.length >= 1);
    assert.deepEqual(seenTokens.slice(0, 2), ["tok", "tok"]);
    assert.equal(sub.isConnected(), true);
    sub.stop();
    assert.equal(sub.isConnected(), false);
    const connections = seenTokens.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(seenTokens.length, connections, "stop 之后不再重连");
  } finally {
    sub.stop();
    for (const res of openResponses) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("createSseSubscription: 非 200（401/503）按掉线处理并退避；连不上时 onDown 触发兜底", async () => {
  let hits = 0;
  const server = await listen((_req, res) => {
    hits += 1;
    res.writeHead(503, { "content-type": "application/json" });
    res.end("{}");
  });
  const downs = [];
  const sub = createSseSubscription({
    url: `http://127.0.0.1:${server.address().port}/api/events`,
    onDown: (reason) => downs.push(reason),
    backoffBaseMs: 10,
    backoffMaxMs: 40,
  });
  try {
    sub.start();
    await waitFor(() => hits >= 3);
    assert.ok(downs.every((reason) => reason === "http-503"));
  } finally {
    sub.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  // 取一个刚释放的端口模拟"monitor 不在"。Windows 上被拒连接要重试 SYN（~2s），放宽等待。
  const closed = await listen(() => {});
  const closedPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  const refused = [];
  const dead = createSseSubscription({ url: `http://127.0.0.1:${closedPort}/none`, onDown: (r) => refused.push(r), backoffBaseMs: 1000 });
  dead.start();
  await waitFor(() => refused.length >= 1, 10000);
  dead.stop();
  assert.equal(refused[0], "request-error");
});

test("createSseSubscription: 空闲超时（无心跳）判假死并重连；shouldRun=false 不重连", async () => {
  let connections = 0;
  const responses = [];
  const server = await listen((_req, res) => {
    connections += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(":hb\n\n");
    responses.push(res); // 之后再不发任何字节
  });
  let run = true;
  const downs = [];
  const sub = createSseSubscription({
    url: `http://127.0.0.1:${server.address().port}/api/events`,
    idleTimeoutMs: 50,
    backoffBaseMs: 10,
    onDown: (reason) => downs.push(reason),
    shouldRun: () => run,
  });
  try {
    sub.start();
    await waitFor(() => connections >= 2);
    assert.equal(downs[0], "idle-timeout");
    run = false;
    const before = connections;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(connections <= before + 1, "shouldRun=false 后停止重连");
  } finally {
    sub.stop();
    for (const res of responses) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
