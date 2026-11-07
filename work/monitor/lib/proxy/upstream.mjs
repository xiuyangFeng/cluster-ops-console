// 经上游 HTTP 代理拨号（出网方式 system / manual，v2.54）：本机代理不再直接连目标，而是向
// 上游代理（Clash 等的 HTTP / 混合端口）发 `CONNECT host:port`，收到 200 后把这条 socket 交回
// 调用方做双向管道；明文绝对地址请求则原样（absolute-form）转给上游。
// 首版只支持 http:// 上游：不支持 SOCKS / HTTPS 上游，也不带上游认证——客户端发来的
// Proxy-Authorization 是给本代理的，绝不转给上游（将来支持上游认证时，注入的是我们自己的上游凭证）。
// 放行判定与解析闸门仍由调用方（server.mjs）在拨号前做完，这里只管"怎么连上去"。
//
// 自环两道闸（v2.54 终审）：
//   ① 字面量：isSelfUpstream（环回 / 0.0.0.0 / :: 的各种写法 + 同端口），策略加载与拨号前都判；
//   ② 落点：TCP 连上之后看实际对端——是本代理自己的监听端点（127.0.0.1:<自己端口>）就在写出
//      任何字节之前断开（landedOnSelf）。上游地址怎么写都绕不过（主机名解析到环回、数字简写等）。
// 经外部转发器绕回自己的环路由 CONNECT 里的跳标记头兜（headers.mjs / server.mjs）。
import net from "node:net";

import { formatAuthority, isLoopbackHost } from "./address.mjs";
import { forwardRequestHeaders, PROXY_HOP_HEADER } from "./headers.mjs";

// 上游响应头上限：正常的 "HTTP/1.1 200 Connection established" 不过几十字节，
// 超过 8KB 还没读到头尾就当对端不是 HTTP 代理，别无界累积。
export const UPSTREAM_HEADER_LIMIT = 8 * 1024;
// dialViaUpstream 的 proxyAuthorization 只收这个形状（见该函数说明）。
const BASIC_AUTHORIZATION_RE = /^Basic [A-Za-z0-9+/]+={0,2}$/;

// 可区分的失败码：server.mjs 据此回 502 / 504 并写日志，自测据此给中文原因。
export const UPSTREAM_ERROR = Object.freeze({
  REFUSED: "UPSTREAM_REFUSED", // 上游端口没人听（代理软件没开 / 端口填错）
  TIMEOUT: "UPSTREAM_TIMEOUT", // 连上游或等上游回应超时
  REJECTED: "UPSTREAM_REJECTED", // 上游回了非 200（statusCode 挂在 error 上）
  BAD_RESPONSE: "UPSTREAM_BAD_RESPONSE", // 响应头超限 / 不是 HTTP / 没回完就断开
  LOOP: "UPSTREAM_LOOP", // 上游就是本代理自己（会无限转圈）
  NETWORK: "UPSTREAM_NETWORK", // 其余网络错误（原始 code 在 error.cause）
  ABORTED: "UPSTREAM_ABORTED", // 调用方取消（集群侧客户端先断开）
});

function upstreamError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

// 上游是否就是本代理自己：环回地址 + 同端口。selfPort 未知（0 / null）时无法判定，按否处理。
export function isSelfUpstream(upstream, selfPort) {
  const port = Number(selfPort);
  if (!upstream || !Number.isInteger(port) || port <= 0) return false;
  return Number(upstream.port) === port && isLoopbackHost(upstream.host);
}

// 已连上的 socket 是否落在本代理自己的监听端点上（本代理只监听 127.0.0.1:<selfPort>）。
export function landedOnSelf(socket, selfPort) {
  const port = Number(selfPort);
  if (!Number.isInteger(port) || port <= 0) return false;
  const address = String(socket?.remoteAddress || "").replace(/^::ffff:/i, "");
  return socket?.remotePort === port && address === "127.0.0.1";
}

const loopError = (upstream) => upstreamError(UPSTREAM_ERROR.LOOP, `upstream ${formatAuthority(upstream.host, upstream.port)} is this proxy itself`);

// 失败码 → 日志里的单词形态原因（connect-fail ... reason=<这里>）。
export function upstreamFailureReason(err) {
  switch (err?.code) {
    case UPSTREAM_ERROR.REFUSED: return "upstream-refused";
    case UPSTREAM_ERROR.TIMEOUT: return "upstream-timeout";
    case UPSTREAM_ERROR.REJECTED: return `upstream-rejected-${err.statusCode || 0}`;
    case UPSTREAM_ERROR.BAD_RESPONSE: return "upstream-bad-response";
    case UPSTREAM_ERROR.LOOP: return "upstream-loop";
    case UPSTREAM_ERROR.ABORTED: return "upstream-aborted";
    default: return `upstream-${String(err?.cause?.code || err?.code || "error").toLowerCase()}`;
  }
}

// 与上游建 TCP → 发 CONNECT → 读响应头（≤ 8KB）→ 200 才 resolve { socket, rest }。
// rest 是响应头之后已经读到的字节（极少见，但不能丢），调用方要先写给客户端再接管道。
// head 是客户端随 CONNECT 一起发来的首包（http 'connect' 事件的 head），隧道建好后先写给上游。
// 交回的 socket 处于暂停态，调用方 pipe() 时自动恢复流动——之前挂过 'data' 监听，不暂停的话
// 移除监听后的数据会直接丢掉。
// signal（AbortSignal）：客户端先断开时取消拨号，立即销毁 socket 并以 ABORTED 失败。
// hopChain：写进 CONNECT 的跳 id 链（server.mjs 传"收到的链 + 自己的 id"）；本代理之外的调用方
// （出网自测）不传。发给上游的 CONNECT 只有 Host 与跳标记两个头，客户端的任何头都不带过去。
// 带了跳标记而上游回 508（Loop Detected）= 请求绕回了某个带标记的本代理实例，按 LOOP 报。
// proxyAuthorization（v2.62）：只给「把本代理当上游」的本机调用方用（出网自测经 8888 测连通时带上代理口令，
// 值形如 "Basic <base64>"）。代理自己拨上游时从不传它——上游代理仍不支持带认证，客户端发来的口令也绝不转出去；
// 形状不对的值直接忽略（它会被写进请求头，不能带进换行）。
export function dialViaUpstream({
  upstream,
  host,
  port,
  timeoutMs = 10000,
  head,
  selfPort,
  signal,
  hopChain = [],
  proxyAuthorization = "",
  connect = net.connect,
} = {}) {
  return new Promise((resolve, reject) => {
    if (isSelfUpstream(upstream, selfPort)) {
      reject(loopError(upstream));
      return;
    }
    if (signal?.aborted) {
      reject(upstreamError(UPSTREAM_ERROR.ABORTED, "dial aborted"));
      return;
    }
    const authority = formatAuthority(host, port);
    let settled = false;
    let buffered = Buffer.alloc(0);
    const socket = connect({ host: upstream.host, port: Number(upstream.port) });

    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const fail = (code, message, extra) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(upstreamError(code, message, extra));
    };
    function onData(chunk) {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > UPSTREAM_HEADER_LIMIT) fail(UPSTREAM_ERROR.BAD_RESPONSE, "upstream response header too large");
        return;
      }
      if (end + 4 > UPSTREAM_HEADER_LIMIT) {
        fail(UPSTREAM_ERROR.BAD_RESPONSE, "upstream response header too large");
        return;
      }
      const statusLine = buffered.subarray(0, end).toString("latin1").split("\r\n")[0];
      const match = statusLine.match(/^HTTP\/1\.[01] (\d{3})\b/);
      if (!match) {
        fail(UPSTREAM_ERROR.BAD_RESPONSE, `upstream is not an HTTP proxy: ${JSON.stringify(statusLine.slice(0, 60))}`);
        return;
      }
      const statusCode = Number(match[1]);
      if (statusCode === 508 && hopChain.length > 0) {
        fail(UPSTREAM_ERROR.LOOP, "upstream answered 508: request looped back to a proxy on the hop chain", { statusCode });
        return;
      }
      if (statusCode !== 200) {
        fail(UPSTREAM_ERROR.REJECTED, `upstream answered ${statusCode}`, { statusCode });
        return;
      }
      settled = true;
      cleanup();
      socket.pause();
      if (head?.length && !socket.destroyed) socket.write(head);
      resolve({ socket, rest: buffered.subarray(end + 4) });
    }
    function onError(err) {
      if (err?.code === "ECONNREFUSED") fail(UPSTREAM_ERROR.REFUSED, `upstream ${formatAuthority(upstream.host, upstream.port)} refused`, { cause: err });
      else fail(UPSTREAM_ERROR.NETWORK, err?.message || "upstream network error", { cause: err });
    }
    function onEnd() {
      fail(UPSTREAM_ERROR.BAD_RESPONSE, "upstream closed before answering CONNECT");
    }
    function onAbort() {
      fail(UPSTREAM_ERROR.ABORTED, "dial aborted");
    }
    const timer = setTimeout(() => fail(UPSTREAM_ERROR.TIMEOUT, `upstream did not answer within ${timeoutMs}ms`), timeoutMs);

    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 30000);
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("end", onEnd);
    socket.on("close", onEnd);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    socket.once("connect", () => {
      if (settled) return;
      if (landedOnSelf(socket, selfPort)) {
        const err = loopError(upstream);
        fail(err.code, err.message);
        return;
      }
      const hop = hopChain.length ? `${PROXY_HOP_HEADER}: ${hopChain.join(", ")}\r\n` : "";
      const auth = BASIC_AUTHORIZATION_RE.test(proxyAuthorization) ? `Proxy-Authorization: ${proxyAuthorization}\r\n` : "";
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${hop}${auth}\r\n`);
    });
  });
}

// 明文转发：把客户端发来的绝对地址请求（GET http://host/path）交给上游代理。
// HTTP 代理本就接受 absolute-form 请求行，所以 path 直接用完整 URL；请求头先剥逐跳头
// （Proxy-Authorization 等，见 headers.mjs）再转。不带跳标记：上游会把普通头原样转给源站。
// selfPort 给出时自建连接并做落点复检：连到的是本代理自己就在写出请求之前断开（LOOP 错误经
// http.request 的 error 事件交给调用方）——复检监听先于请求写缓冲的 connect 回调注册，所以
// 一个字节都不会写给自己。自建连接不走 http.Agent，即每个明文请求一条到上游的新连接（明文
// 走上游本就少见，换来环路不能递归到耗尽文件描述符）。
export function upstreamForwardOptions({ upstream, url, method, headers, selfPort, connect = net.connect }) {
  const options = {
    host: upstream.host,
    port: Number(upstream.port),
    path: url,
    method,
    headers: forwardRequestHeaders(headers),
  };
  if (selfPort) {
    options.createConnection = () => {
      const socket = connect({ host: upstream.host, port: Number(upstream.port) });
      socket.once("connect", () => {
        if (landedOnSelf(socket, selfPort)) socket.destroy(loopError(upstream));
      });
      return socket;
    };
  }
  return options;
}
