// HTTP 外壳：退出途中 503、路由异常兜底 500、监听失败 exit(1)。只绑 127.0.0.1 临时端口。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import { createMonitorHttpServer } from "./http-server.mjs";

const quietLog = { log: () => {}, error: () => {} };

function listenOnce(httpServer) {
  return new Promise((resolve) => {
    httpServer.listen(0, () => resolve(httpServer.server.address().port));
  });
}

test("http-server：正常转交路由；退出途中一律 503；路由抛错兜底 500 并记日志", async (t) => {
  let closing = false;
  let mode = "ok";
  const logs = [];
  const httpServer = createMonitorHttpServer({
    router: {
      handleHttpRequest: async (_req, res) => {
        if (mode === "throw") throw new Error("bad host");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("routed");
      },
    },
    isClosing: () => closing,
    appendLog: (message) => logs.push(message),
    exit: () => assert.fail("不应退出"),
    log: quietLog,
  });
  const port = await listenOnce(httpServer);
  t.after(() => httpServer.server.close());
  const base = `http://127.0.0.1:${port}/`;

  let res = await fetch(base);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "routed");

  mode = "throw";
  res = await fetch(base);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "bad host" });
  assert.deepEqual(logs, ["error: bad host"]);

  closing = true;
  res = await fetch(base);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "服务正在退出" });
  await httpServer.drainPendingRequests();
});

test("http-server：端口被占（EADDRINUSE）→ 记日志并 exit(1)，不留僵尸进程", async (t) => {
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  t.after(() => blocker.close());
  const logs = [];
  const exited = new Promise((resolve) => {
    const httpServer = createMonitorHttpServer({
      router: { handleHttpRequest: async () => {} },
      isClosing: () => false,
      appendLog: (message, fields) => logs.push({ message, ...fields }),
      exit: resolve,
      log: quietLog,
    });
    httpServer.listen(blocker.address().port, () => assert.fail("不应监听成功"));
  });
  assert.equal(await exited, 1);
  assert.equal(logs[0].level, "error");
  assert.match(logs[0].message, /^server listen failed: /);
});
