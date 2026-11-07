// 代理转发时的请求头处理（v2.54 终审）：逐跳头剥离 + 本代理的跳标记（环路检测）。
// 纯函数，不碰 socket；直连与上游两条明文转发分支、以及发往上游的 CONNECT 共用这一份口径。
//
// 为什么必须剥：节点上任何账号都能把请求打进同事 Mac 上的本代理，客户端发来的
// Proxy-Authorization 是给"本跳"（本代理）的凭证——原样转给目标站 / 上游就等于把凭证外泄
// （第 4 期给本代理加口令后，这就是同事的代理口令）。其余逐跳头只对本跳有意义，转发出去会被
// 下一跳误解（Connection 指名的字段、Upgrade 等）。
import { randomBytes } from "node:crypto";

// 本代理自己的跳标记头：值是逗号分隔的跳 id 链（每个代理实例一个随机 id）。
// 只出现在发往上游的 CONNECT 请求里——上游代理消费 CONNECT 头、不会转给目标站；
// 明文转发时上游会把普通头原样转给源站，所以明文分支不带它（见 server.mjs 的环路说明）。
export const PROXY_HOP_HEADER = "x-codex-proxy-hop";
// 跳 id 形态：16 位小写十六进制。链里不认识的 token 一律丢弃（不回写进下一跳的 CONNECT）。
const HOP_ID_RE = /^[0-9a-f]{16}$/;
// 链长上限：正常部署最多两三跳（热更新交接期新旧两个代理），超过就当环路。
export const MAX_PROXY_HOPS = 8;

// RFC 9110 §7.6.1 的逐跳头，外加 Proxy-Connection（非标准但客户端常发）与本代理的跳标记。
const HOP_BY_HOP_HEADERS = new Set([
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  PROXY_HOP_HEADER,
]);

function headerTokens(value) {
  const list = Array.isArray(value) ? value : [value];
  return list
    .flatMap((item) => String(item ?? "").split(","))
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

// 客户端请求头 → 可以转给下一跳（目标站或上游代理）的请求头：剥掉逐跳头，以及 Connection
// 头里点名的字段。返回新对象，不改入参。上游若将来要求认证，应在调用方另行注入"我们自己的"
// 上游凭证，绝不能沿用客户端的 Proxy-Authorization。
export function forwardRequestHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  const nominated = new Set(headerTokens(headers.connection ?? headers.Connection));
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || nominated.has(key)) continue;
    out[name] = value;
  }
  return out;
}

// 新的跳 id（每个代理实例一个，进程内随机，不落盘、不对外发布）。
export function createHopId() {
  return randomBytes(8).toString("hex");
}

export function isHopId(value) {
  return typeof value === "string" && HOP_ID_RE.test(value);
}

// 收到的请求头里的跳 id 链（只留合法 id，保持顺序）。
export function readHopChain(headers) {
  return headerTokens(headers?.[PROXY_HOP_HEADER]).filter(isHopId);
}

// 环路判定：链里已经有自己的 id（请求绕回了本代理），或链长超限。
export function isProxyLoop(chain, ownHopId) {
  return chain.length >= MAX_PROXY_HOPS || (isHopId(ownHopId) && chain.includes(ownHopId));
}
