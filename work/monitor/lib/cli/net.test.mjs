import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Duplex, Readable } from "node:stream";
import test from "node:test";

import { contentLength, fetchJson, openHttps, resolveEgressUpstream } from "./net.mjs";

// 假 http/https.request：按顺序吐出预设响应，记录每次请求的选项。
function fakeRequest(responses, log) {
  return (opts, cb) => {
    log.push(opts);
    const req = new EventEmitter();
    req.end = () => {
      const r = responses.shift();
      const res = Readable.from([Buffer.from(r.body || "")]);
      res.statusCode = r.status;
      res.headers = r.headers || {};
      setImmediate(() => cb(res));
    };
    req.destroy = () => {};
    return req;
  };
}

test("resolveEgressUpstream：direct → 直连；manual → 填写的地址；system → 系统代理识别结果", async () => {
  assert.equal(await resolveEgressUpstream({ egress: undefined }), null);
  assert.equal(await resolveEgressUpstream({ egress: { mode: "direct" } }), null);
  const manual = await resolveEgressUpstream({ egress: { mode: "manual", url: "http://127.0.0.1:7890" } });
  assert.deepEqual([manual.host, manual.port], ["127.0.0.1", 7890]);
  const detector = { detect: async () => ({ proxy: { host: "127.0.0.1", port: 7897, url: "http://127.0.0.1:7897" } }) };
  assert.equal((await resolveEgressUpstream({ egress: { mode: "system" }, detector })).port, 7897);
  assert.equal(await resolveEgressUpstream({ egress: { mode: "system" }, detector: { detect: async () => ({ proxy: null }) } }), null);
});

test("openHttps 直连：跟随 https 重定向；非 2xx 带 statusCode 拒绝；http:// 直接拒绝", async () => {
  const log = [];
  const https = fakeRequest([
    { status: 302, headers: { location: "https://objects.example.com/blob?sig=1" } },
    { status: 200, headers: { "content-length": "3" }, body: "abc" },
  ], log);
  const { res, url } = await openHttps("https://github.com/x", { requestImpl: { https, http: () => assert.fail() } });
  assert.equal(res.statusCode, 200);
  assert.equal(url, "https://objects.example.com/blob?sig=1");
  assert.deepEqual(log.map((o) => [o.host, o.path]), [["github.com", "/x"], ["objects.example.com", "/blob?sig=1"]]);

  const notFound = fakeRequest([{ status: 404 }], []);
  await assert.rejects(openHttps("https://a.example.com/x", { requestImpl: { https: notFound } }), (err) => err.statusCode === 404);
  await assert.rejects(openHttps("http://a.example.com/x"), /只允许 https/);
});

test("openHttps 经上游：CONNECT 目标:443 → TLS（SNI = 目标）→ 在 TLS socket 上说 HTTP/1.1", async () => {
  const dials = [];
  const tlsCalls = [];
  const log = [];
  const tlsSocket = { destroy() {} };
  const http = fakeRequest([{ status: 200, body: '{"latest":"0.160.1"}' }], log);
  const json = await fetchJson("https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags", {
    upstream: { host: "127.0.0.1", port: 7890 },
    dial: async (opts) => {
      dials.push(opts);
      return { socket: { unshift() {} }, rest: Buffer.alloc(0) };
    },
    tlsConnect: (opts) => {
      tlsCalls.push(opts);
      return tlsSocket;
    },
    requestImpl: { http, https: () => assert.fail("经上游时不该走 https 模块") },
  });
  assert.deepEqual(json, { latest: "0.160.1" });
  assert.deepEqual([dials[0].host, dials[0].port, dials[0].upstream.port], ["registry.npmjs.org", 443, 7890]);
  assert.equal(tlsCalls[0].servername, "registry.npmjs.org");
  assert.equal(log[0].agent, undefined);
  assert.equal(log[0].createConnection(), tlsSocket);
  assert.equal(log[0].headers.host, "registry.npmjs.org");
});

test("openHttps 经上游（真实 http.request）：确保 Node ClientRequest 实际使用 createConnection 提供的 tlsSocket", async () => {
  const written = [];
  const body = '{"latest":"0.160.1"}';
  const rawResponse = `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
  const fakeTlsSocket = new Duplex({
    read() {},
    write(chunk, _enc, cb) {
      written.push(chunk.toString("utf8"));
      if (written.join("").includes("\r\n\r\n")) {
        setImmediate(() => {
          fakeTlsSocket.push(Buffer.from(rawResponse, "utf8"));
          fakeTlsSocket.push(null);
        });
      }
      cb();
    },
  });
  const json = await fetchJson("https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags", {
    upstream: { host: "127.0.0.1", port: 7897 },
    dial: async () => ({ socket: { unshift() {} }, rest: Buffer.alloc(0) }),
    tlsConnect: () => fakeTlsSocket,
  });
  assert.deepEqual(json, { latest: "0.160.1" });
  assert.match(written.join(""), /^GET \/-\/package\/@openai%2Fcodex\/dist-tags HTTP\/1\.1\r\n/);
});

test("contentLength：只取响应头", async () => {
  const https = fakeRequest([{ status: 200, headers: { "content-length": "160785122" } }], []);
  assert.equal(await contentLength("https://g.example.com/a", { requestImpl: { https } }), 160785122);
});
