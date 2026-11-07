import assert from "node:assert/strict";
import { test } from "node:test";

import { createDaemonsRoutes } from "./daemons.mjs";

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}
const postReq = (body) => ({ method: "POST", async *[Symbol.asyncIterator]() { yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body)); } });
const fail = (message, status) => Object.assign(new Error(message), { status });

function setup({ modules = { daemons: true }, service } = {}) {
  const calls = [];
  const daemonsService = service === null ? null : {
    forward: async (target, { acquireSshSlot }) => {
      calls.push(["forward", target, typeof acquireSshSlot]);
      if (target.port === 9999) throw fail("端口 9999 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」", 409);
      if (target.port === 9998) throw fail("SSH 连不上服务器：检查 ssh 用户名与密钥，或重跑 npm run setup", 502);
      return { forward: { serverId: target.serverId, port: target.port, localPort: 51814, url: "http://127.0.0.1:51814/" }, status: { eligible: true } };
    },
    closeForward: async (target) => {
      calls.push(["close", target]);
      return { closed: target.port === 8814, serverId: target.serverId, port: target.port, status: null };
    },
  };
  const route = createDaemonsRoutes({ daemonsService, getConfig: async () => ({ modules }), scheduler: { acquireSshSlot: async () => () => {} } });
  const post = async (pathname, body) => {
    const res = fakeRes();
    const handled = await route({ req: postReq(body), res, url: new URL(`http://x${pathname}`) });
    return { handled, status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  return { post, calls };
}

test("转发路由：只把 serverId 与端口交给服务层，带上 SSH 槽位；服务层的拒绝原样带状态码返回", async () => {
  const h = setup();
  const ok = await h.post("/api/daemons/forward", { serverId: "s1", port: 8814 });
  assert.deepEqual([ok.status, ok.json.forward.url, ok.json.status], [200, "http://127.0.0.1:51814/", { eligible: true }]);
  assert.deepEqual(h.calls, [["forward", { serverId: "s1", port: 8814 }, "function"]]);
  const notListed = await h.post("/api/daemons/forward", { serverId: "s1", port: 9999 });
  assert.deepEqual([notListed.status, notListed.json], [409, { error: "端口 9999 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」" }]);
  assert.equal((await h.post("/api/daemons/forward", { serverId: "s1", port: 9998 })).status, 502);
});

test("转发路由：请求里不接受任意主机与端口——多带任何键、端口不是 1024–65535 的整数、服务器 id 不合格，一律 400 且到不了服务层", async () => {
  const h = setup();
  const bad = [
    [{ serverId: "s1", port: 8814, host: "10.0.0.5" }, "只接受 serverId 与 port"],
    [{ serverId: "s1", port: 8814, remoteHost: "example.com" }, "只接受 serverId 与 port"],
    [{ serverId: "s1", port: 8814, localPort: 8888 }, "只接受 serverId 与 port"],
    [{ serverId: "s1", port: 8814, target: "127.0.0.1:22" }, "只接受 serverId 与 port"],
    [["s1", 8814], "只接受 serverId 与 port"],
    [{ port: 8814 }, "invalid serverId"],
    [{ serverId: "../x", port: 8814 }, "invalid serverId"],
    [{ serverId: 1, port: 8814 }, "invalid serverId"],
    [{ serverId: "s1" }, "端口不合法"],
    [{ serverId: "s1", port: "8814" }, "端口不合法"],
    [{ serverId: "s1", port: 8814.5 }, "端口不合法"],
    [{ serverId: "s1", port: 80 }, "端口不合法"],
    [{ serverId: "s1", port: 1023 }, "端口不合法"],
    [{ serverId: "s1", port: 65536 }, "端口不合法"],
    [{ serverId: "s1", port: "8814; reboot" }, "端口不合法"],
  ];
  for (const pathname of ["/api/daemons/forward", "/api/daemons/forward/close"]) {
    for (const [body, error] of bad) {
      const res = await h.post(pathname, body);
      assert.deepEqual([res.status, res.json], [400, { error }], `${pathname} ${JSON.stringify(body)}`);
    }
    const broken = await h.post(pathname, "{broken");
    assert.deepEqual([broken.status, broken.json], [400, { error: "invalid request body" }]);
  }
  assert.deepEqual(h.calls, []);
  assert.equal((await h.post("/api/daemons/forward", { serverId: "s1", port: 1024 })).status, 200, "1024 是下界");
  assert.equal((await h.post("/api/daemons/forward", { serverId: "s1", port: 65535 })).status, 200);
});

test("关闭路由：同样只收 serverId 与端口；没有这条转发时 closed 为 false", async () => {
  const h = setup();
  const closed = await h.post("/api/daemons/forward/close", { serverId: "s1", port: 8814 });
  assert.deepEqual([closed.status, closed.json], [200, { closed: true, serverId: "s1", port: 8814, status: null }]);
  assert.equal((await h.post("/api/daemons/forward/close", { serverId: "s1", port: 8815 })).json.closed, false);
  assert.deepEqual(h.calls, [["close", { serverId: "s1", port: 8814 }], ["close", { serverId: "s1", port: 8815 }]]);
});

test("转发与关闭都随「远端守护进程」模块开关；服务缺失 503；别的方法与路径不归这一组", async () => {
  const off = setup({ modules: { daemons: false } });
  for (const pathname of ["/api/daemons/forward", "/api/daemons/forward/close"]) {
    const res = await off.post(pathname, { serverId: "s1", port: 8814 });
    assert.deepEqual([res.status, res.json], [503, { error: "远端守护进程模块已关闭", disabled: true }]);
  }
  assert.deepEqual(off.calls, []);
  const none = setup({ service: null });
  assert.deepEqual((await none.post("/api/daemons/forward", { serverId: "s1", port: 8814 })).json, { error: "daemons unavailable" });
  const h = setup();
  assert.equal((await h.post("/api/daemons/forward/open", { serverId: "s1", port: 8814 })).handled, false);
  const res = fakeRes();
  assert.equal(await createDaemonsRoutes({ daemonsService: {} })({ req: { method: "GET" }, res, url: new URL("http://x/api/daemons/forward") }), false, "没有 GET");
});
