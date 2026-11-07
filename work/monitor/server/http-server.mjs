// HTTP 服务器外壳：退出途中一律 503、在途请求登记（退出时排干）、监听失败即退出。
// 路由 / SSE / 静态资源全部在 lib/http-router.mjs（读写基础件在 lib/http/io.mjs）。

import { createServer } from "node:http";

import { sendJson } from "../lib/http/io.mjs";

export function createMonitorHttpServer({ router, isClosing, appendLog, exit = (code) => process.exit(code), log = console }) {
  const pendingRequests = new Set();
  const server = createServer((req, res) => {
    if (isClosing()) return sendJson(res, { error: "服务正在退出" }, 503);
    const request = router.handleHttpRequest(req, res).catch((error) => {
      // 兜底：URL 解析失败（畸形 Host 头等）或响应写入前的极早期异常。
      appendLog(`error: ${error.message}`);
      try {
        sendJson(res, { error: error.message }, 500);
      } catch {}
    }).finally(() => pendingRequests.delete(request));
    pendingRequests.add(request);
  });

  // 监听失败（EADDRINUSE 等）是启动期致命错误，必须显式退出——不能被 uncaughtException
  // 兜底吞掉变成"进程活着但没监听"的僵尸态：launch.mjs/electron-main
  // 都依赖子进程退出与否来做 8877 冲突清理与失败提示。
  server.on("error", (err) => {
    log.error(`[FATAL] monitor-server listen failed: ${err.message}`);
    try {
      appendLog(`server listen failed: ${err.message}`, { level: "error" });
    } catch {}
    exit(1);
  });

  // 只绑 127.0.0.1。PORT=0 时打印实际端口（冒烟 / 测试据这一行拿端口）。
  function listen(port, onListening) {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const boundPort = address && typeof address === "object" ? address.port : port;
      log.log(`Codex tunnel monitor: http://127.0.0.1:${boundPort}`);
      return onListening();
    });
  }

  return {
    server,
    listen,
    drainPendingRequests: () => Promise.allSettled([...pendingRequests]),
  };
}
