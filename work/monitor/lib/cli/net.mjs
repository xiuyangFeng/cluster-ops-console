// 本机侧 HTTPS 下载底座（第 2 期 P-D）：查最新版本（npm dist-tags）与回退安装的本机下载都走这里，
// 按个人层的「出网」设置（设计稿 §5.B）选路：
//   direct → 直接 https；system → 系统代理识别结果；manual → 个人层填写的 http://主机:端口。
// 经上游时复用本机代理自己的拨号器（proxy/upstream.mjs 的 dialViaUpstream：CONNECT host:443 → 200），
// 在拿回的 socket 上做 TLS（校验证书、SNI = 目标主机），再用 http.request 的 createConnection 跑 HTTP/1.1。
// 不经本机代理（127.0.0.1:<proxyPort>）：那是给隧道另一头用的，本机这边直接按出网设置走即可，
// 代理没起来时版本检测与回退下载照样可用。
//
// 只做 GET；只跟随 https 重定向（GitHub Releases 会 302 到 objects.githubusercontent.com），最多 5 跳；
// 响应头超时与「body 长时间没数据」超时分开算（慢链路上整体时长不设上限，见设计稿 §8「下载慢」）。
// 全部网络入口可注入（requestImpl / dial / tlsConnect），单测零真实网络。
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

import { resolveEgressSetting } from "../config-loader.mjs";
import { dialViaUpstream } from "../proxy/upstream.mjs";

export const HEADERS_TIMEOUT_MS = 20000;
export const IDLE_TIMEOUT_MS = 60000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "cluster-workbench-cli-installer";

// 个人层 egress（+ 系统代理识别器）→ 上游 { host, port, url } 或 null（直连）。
// system 模式识别不到 HTTP 代理时按直连（与本机代理 policy-reload 同口径）。
export async function resolveEgressUpstream({ egress, detector = null } = {}) {
  const setting = resolveEgressSetting(egress);
  if (setting.mode === "manual") return setting.upstream || null;
  if (setting.mode === "system" && detector) {
    try {
      const sp = await detector.detect();
      return sp?.proxy || null;
    } catch {
      return null;
    }
  }
  return null;
}

function httpError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// 经上游 CONNECT 拿到一条到 host:443 的 TLS socket。
async function connectViaUpstream({ upstream, host, timeoutMs, signal, dial, tlsConnect }) {
  const { socket, rest } = await dial({ upstream, host, port: 443, timeoutMs, signal });
  if (rest?.length) socket.unshift(rest);
  return tlsConnect({ socket, servername: host, ALPNProtocols: ["http/1.1"] });
}

// 发一次 GET，拿到响应头即 resolve（IncomingMessage，body 由调用方消费）。不跟随重定向。
function requestOnce(url, { upstream, headers, timeoutMs, signal, requestImpl, dial, tlsConnect }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      reject(httpError("EPROTO_NOT_HTTPS", `只允许 https 地址：${u.protocol}`));
      return;
    }
    const baseHeaders = { "user-agent": USER_AGENT, accept: "*/*", ...headers };
    const options = {
      method: "GET",
      host: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      headers: { host: u.host, ...baseHeaders },
      signal,
    };
    let req;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, httpError("ETIMEDOUT_HEADERS", `等待 ${u.host} 响应超时`));
      req?.destroy();
    }, timeoutMs);
    const onResponse = (res) => finish(resolve, res);
    const onError = (err) => finish(reject, err);
    if (upstream) {
      connectViaUpstream({ upstream, host: u.hostname, timeoutMs, signal, dial, tlsConnect }).then(
        (tlsSocket) => {
          if (settled) {
            tlsSocket.destroy();
            return;
          }
          // http（而非 https）模块 + 现成的 TLS socket：它只负责在 socket 上说 HTTP/1.1。
          // 注意：不可传 agent: false，否则 Node.js ClientRequest 会实例化新 Agent 并忽略 createConnection。
          req = requestImpl.http({ ...options, createConnection: () => tlsSocket }, onResponse);
          req.on("error", onError);
          req.end();
        },
        onError,
      );
    } else {
      req = requestImpl.https(options, onResponse);
      req.on("error", onError);
      req.end();
    }
  });
}

const DEFAULT_REQUEST_IMPL = Object.freeze({ http: (o, cb) => http.request(o, cb), https: (o, cb) => https.request(o, cb) });

// GET 并跟随 https 重定向，返回最终的 { res, url }。2xx / 206 以外一律 reject（带 statusCode）。
export async function openHttps(url, {
  upstream = null,
  headers = {},
  timeoutMs = HEADERS_TIMEOUT_MS,
  signal,
  requestImpl = DEFAULT_REQUEST_IMPL,
  dial = dialViaUpstream,
  tlsConnect = (opts) => tls.connect(opts),
} = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const res = await requestOnce(current, { upstream, headers, timeoutMs, signal, requestImpl, dial, tlsConnect });
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers?.location) {
      res.resume?.();
      current = new URL(res.headers.location, current).toString();
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume?.();
      throw httpError("EHTTP", `${new URL(current).host} 返回 HTTP ${status}`, { statusCode: status });
    }
    return { res, url: current };
  }
  throw httpError("EREDIRECT", `重定向超过 ${MAX_REDIRECTS} 次`);
}

// 读完整个 body（元数据用，有字节上限；body 长时间无数据按超时失败）。
export async function fetchBuffer(url, { maxBytes = 8 * 1024 * 1024, idleTimeoutMs = IDLE_TIMEOUT_MS, ...options } = {}) {
  const { res } = await openHttps(url, options);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let idle = setTimeout(onIdle, idleTimeoutMs);
    function onIdle() {
      res.destroy?.();
      reject(httpError("ETIMEDOUT_IDLE", `${new URL(url).host} 长时间没有数据`));
    }
    res.on("data", (chunk) => {
      clearTimeout(idle);
      idle = setTimeout(onIdle, idleTimeoutMs);
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(idle);
        res.destroy?.();
        reject(httpError("ETOOBIG", `${new URL(url).host} 的响应超过 ${maxBytes} 字节`));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      clearTimeout(idle);
      resolve(Buffer.concat(chunks));
    });
    res.on("error", (err) => {
      clearTimeout(idle);
      reject(err);
    });
  });
}

// 只要响应头里的 Content-Length（跟随重定向后），拿到即断开；拿不到 → null。
export async function contentLength(url, options) {
  const { res } = await openHttps(url, options);
  res.destroy?.();
  const n = Number(res.headers?.["content-length"]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function fetchText(url, options) {
  return (await fetchBuffer(url, options)).toString("utf8");
}

export async function fetchJson(url, options) {
  const text = await fetchText(url, { ...options, headers: { accept: "application/json", ...(options?.headers || {}) } });
  try {
    return JSON.parse(text);
  } catch {
    throw httpError("EBADJSON", `${new URL(url).host} 返回的不是 JSON`);
  }
}
