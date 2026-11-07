// 本地 CONNECT 代理的探活（/proxy-health）与每拍共享的探活缓存。
// supervisor ↔ 代理的进程间约定（身份头、释放请求路径、等待标记、draining 记录名）只在
// ../proxy/protocol.mjs 一处定义，两侧 import 同一份。
import { request as httpRequest } from "node:http";

import { parseProxyHealthHeaders } from "../proxy/protocol.mjs";

export function probeProxyHealth(port, {
  request = httpRequest,
  timeoutMs = 3000,
  maxResponseBytes = 64,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const startedAt = now();
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let req;
    const deadlineTimer = setTimer(() => {
      timedOut = true;
      if (req && typeof req.destroy === "function") req.destroy(new Error("proxy health timeout"));
      finish({ ok: false, statusCode: null, timedOut: true });
    }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimer(deadlineTimer);
      resolve({ ...result, durationMs: Math.max(0, now() - startedAt) });
    };
    req = request({ hostname: "127.0.0.1", port, path: "/proxy-health", method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += String(chunk);
        if (Buffer.byteLength(body) > maxResponseBytes) {
          if (typeof res.destroy === "function") res.destroy();
          finish({ ok: false, statusCode: res.statusCode ?? null, tooLarge: true });
        }
      });
      res.on("end", () => {
        const ok = res.statusCode === 200 && body.trim() === "ok";
        // 只有新版代理（带身份头）才附 proxy 字段；旧代理的结果形状与以前逐字一致。
        const identity = ok ? parseProxyHealthHeaders(res.headers || {}) : null;
        const known = identity && (identity.pid || identity.component || identity.handoff);
        finish({ ok, statusCode: res.statusCode ?? null, ...(known ? { proxy: identity } : {}) });
      });
    });
    req.on("error", () => finish({ ok: false, statusCode: null, ...(timedOut ? { timedOut: true } : {}) }));
    if (typeof req.setTimeout === "function") {
      req.setTimeout(timeoutMs, () => {
        timedOut = true;
        req.destroy(new Error("proxy health timeout"));
      });
    }
    if (typeof req.end === "function") req.end();
  });
}

// 每拍共享的本地代理探活：旧实现一拍里 localProxyController.ensure 探一次，随后每条
// 隧道的 isLocalProxyHealthy 又各探一次（1+N 次 HTTP）。现在：
//   - checkHealth(port)：代理控制器本拍的那一次探活，结果记下；
//   - isHealthy(port)：隧道复用本拍结果——本拍已判健康（且未过期）直接 true；
//     本拍未探或判不健康（代理可能刚被重建），全部隧道共享一次新的探活，而不是各探各的。
// beginTick() 在每拍开头清空；maxAgeMs 防止被受控重启拖住的 ensure 用到过期结果。
export function createTickProxyHealth({ check, now = Date.now, maxAgeMs = 5000 } = {}) {
  let primary = null;
  let shared = null;
  const run = (port) => ({ port, at: now(), promise: Promise.resolve().then(() => check(port)) });
  const fresh = (entry, port) => entry && entry.port === port && now() - entry.at <= maxAgeMs;
  function beginTick() {
    primary = null;
    shared = null;
  }
  function checkHealth(port) {
    primary = run(port);
    return primary.promise;
  }
  async function isHealthy(port) {
    if (fresh(primary, port)) {
      const result = await primary.promise.catch(() => null);
      if (result?.ok) return true;
    }
    if (!fresh(shared, port)) shared = run(port);
    const result = await shared.promise.catch(() => null);
    return Boolean(result?.ok);
  }
  return { beginTick, checkHealth, isHealthy };
}
