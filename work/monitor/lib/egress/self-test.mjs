// 出网自测（v2.54）：分两段报告哪一跳坏。
//   ① 本机：经本机代理（127.0.0.1:<端口>）对几个官方入口做 CONNECT + TLS 握手（校验证书），逐项给耗时
//      或失败原因；直连全挂而系统里有可用 HTTP 代理时，给出"改用系统代理"的建议。
//   ② 全链路（可选）：SSH 到活跃服务器，`curl -x http://127.0.0.1:<反向端口>` 打一次，
//      区分"集群连不上反向端口 / 本机代理拒绝或拨号失败 / 通"。
// 拨号复用代理自己的上游拨号器（本机代理本身就是一个 HTTP CONNECT 代理）；网络与 SSH 全部可注入。
//
// 代理口令（v2.62）不是关的时候，两段都带上口令：① 本机拨号时加 Proxy-Authorization 头；② 集群上的 curl
// 命令行不变（仍是 -x http://127.0.0.1:<端口>），另加 `-K -`，口令经 SSH 的标准输入交给 curl——它不进任何
// 命令行（集群上别人用 ps 看得到命令行）。关着的时候两段发出去的东西与以前逐字相同。
import tls from "node:tls";

import { dialViaUpstream, UPSTREAM_ERROR } from "../proxy/upstream.mjs";
import { CURL_STDIN_CONFIG_FLAG, curlProxyAuthInput } from "./remote-proxy-auth.mjs";

// 官方登录 / API 的入口：全是公网 443，默认策略零配置放行。
export const SELF_TEST_TARGETS = Object.freeze(["api.openai.com", "chatgpt.com", "api.anthropic.com", "claude.ai"]);
export const SELF_TEST_TIMEOUT_MS = 8000;

const TLS_CERT_ERROR_RE = /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME|ERR_TLS_CERT/i;

// 失败 → { stage, message }。stage：local-proxy（本机代理本身连不上）/ proxy（代理拒绝或拨号失败）/
// upstream（直测系统代理时上游不通）/ tls（握手失败）。
function describeFailure(err, { viaLocalProxy }) {
  const code = err?.code || "";
  if (code === UPSTREAM_ERROR.REFUSED) {
    return viaLocalProxy
      ? { stage: "local-proxy", message: "本机代理没有运行（连接被拒绝）" }
      : { stage: "upstream", message: "代理端口没有响应（代理软件没开或端口不对）" };
  }
  if (code === UPSTREAM_ERROR.REJECTED) {
    const status = err.statusCode;
    if (viaLocalProxy && status === 407) return { stage: "proxy", message: "本机代理要求口令，这次请求没有带对（代理口令是「强制」）" };
    if (viaLocalProxy && status === 403) return { stage: "proxy", message: "本机代理拒绝了这个目标（策略拦截）" };
    if (viaLocalProxy && status === 504) return { stage: "proxy", message: "本机代理连接目标超时" };
    if (viaLocalProxy) return { stage: "proxy", message: `本机代理连不上目标（HTTP ${status}）` };
    return { stage: "upstream", message: `代理拒绝了连接（HTTP ${status}）` };
  }
  if (code === UPSTREAM_ERROR.TIMEOUT) {
    return { stage: viaLocalProxy ? "proxy" : "upstream", message: "等待代理响应超时" };
  }
  if (code === UPSTREAM_ERROR.BAD_RESPONSE) {
    return { stage: viaLocalProxy ? "local-proxy" : "upstream", message: "对端不像 HTTP 代理（响应异常）" };
  }
  if (code === "TLS_TIMEOUT") return { stage: "tls", message: "TLS 握手超时" };
  if (TLS_CERT_ERROR_RE.test(code)) return { stage: "tls", message: "证书校验失败（网络可能在拦截 HTTPS）" };
  if (code === "ECONNRESET") return { stage: "tls", message: "TLS 握手被重置（可能被网络拦截）" };
  return { stage: "tls", message: `TLS 握手失败（${code || err?.message || "未知错误"}）` };
}

// 在已打通的隧道 socket 上做一次 TLS 握手（SNI = 目标主机，校验证书），握手成功即算通。
function defaultTlsHandshake({ socket, servername, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      tlsSocket.destroy();
      reject(Object.assign(new Error("tls timeout"), { code: "TLS_TIMEOUT" }));
    }, timeoutMs);
    tlsSocket.once("secureConnect", () => {
      clearTimeout(timer);
      tlsSocket.end();
      tlsSocket.destroy();
      resolve();
    });
    tlsSocket.once("error", (err) => {
      clearTimeout(timer);
      tlsSocket.destroy();
      reject(err);
    });
  });
}

// 经一个 HTTP CONNECT 代理（本机代理或系统代理）对 target:443 做 CONNECT + TLS 握手。
// 返回 { target, ok, ms } 或 { target, ok:false, stage, code, message, ms }，永不 reject。
// proxyAuthorization：经本机代理测时带的口令头（"Basic …"）；空串 = 不带。只在 viaLocalProxy 时才发——
// 直测系统代理时那是别人的代理，我们的口令不该给它。
export async function probeTargetVia({
  proxy,
  target,
  viaLocalProxy = true,
  timeoutMs = SELF_TEST_TIMEOUT_MS,
  proxyAuthorization = "",
  dial = dialViaUpstream,
  tlsHandshake = defaultTlsHandshake,
  now = Date.now,
}) {
  const t0 = now();
  let socket = null;
  try {
    const auth = viaLocalProxy && proxyAuthorization ? { proxyAuthorization } : {};
    ({ socket } = await dial({ upstream: proxy, host: target, port: 443, timeoutMs, ...auth }));
    socket.resume?.();
    await tlsHandshake({ socket, servername: target, timeoutMs });
    return { target, ok: true, ms: now() - t0 };
  } catch (err) {
    socket?.destroy?.();
    return { target, ok: false, code: err?.code || "error", ...describeFailure(err, { viaLocalProxy }), ms: now() - t0 };
  }
}

// ① 本机段：并发测全部目标。
export async function runLocalSelfTest({ proxyPort, targets = SELF_TEST_TARGETS, probe = probeTargetVia, proxyAuthorization = "" } = {}) {
  const proxy = { host: "127.0.0.1", port: proxyPort };
  const auth = proxyAuthorization ? { proxyAuthorization } : {};
  return Promise.all(targets.map((target) => probe({ proxy, target, viaLocalProxy: true, ...auth })));
}

function upstreamLabel(proxy) {
  return proxy?.url ? proxy.url.replace(/^http:\/\//, "") : "";
}

// 建议（中文一句话 + 可选动作）。effective：代理此刻实际的出网方式（/proxy-health 头）与控制面
// 在本机算出的上游（service.mjs 的 resolveEffectiveUpstream；代理不对外发布上游地址）；
// systemProxy：识别结果；systemCheck：直测系统代理的结果（只在直连全挂且识别到系统代理时才测）。
export function buildSuggestion({ results, effective, systemProxy, systemCheck = null }) {
  if (results.some((r) => r.stage === "local-proxy")) {
    return { kind: "proxy-down", text: "本机代理没有运行：先在「通道控制」里启动连接，再测试。" };
  }
  if (results.some((r) => r.ok)) {
    return results.every((r) => r.ok) ? null : { kind: "partial", text: "部分目标不通，见各项原因；只影响用到它的 CLI。" };
  }
  if (results.every((r) => r.stage === "proxy" && /策略/.test(r.message))) {
    return { kind: "policy", text: "全部被本机代理的策略拦截，请检查个人白名单与出网设置。" };
  }
  if (effective?.upstream) {
    return { kind: "check-upstream", text: `经上游 ${effective.upstream} 全部不通：确认代理软件在运行、端口正确，且它本身能上网。` };
  }
  const proxy = systemProxy?.proxy;
  if (proxy && systemCheck?.ok) {
    return { kind: "use-system", action: "use-system", text: `直连不通，但系统代理 ${upstreamLabel(proxy)} 能连上——建议把出网方式改为「系统代理」。` };
  }
  if (proxy) {
    return { kind: "check-network", text: `直连和系统代理 ${upstreamLabel(proxy)} 都不通，请确认代理软件在运行、本机能正常上网。` };
  }
  if (systemProxy?.socks) {
    return { kind: "socks-only", text: "直连不通；系统里只开了 SOCKS 代理，暂不支持。请在代理软件里打开 HTTP 或混合端口，再选「系统代理」或在「手动」里填写。" };
  }
  if (systemProxy?.pac) {
    return { kind: "pac-only", text: "直连不通；系统使用 PAC 自动配置，暂不支持。请在「手动」里填代理软件的 HTTP 端口。" };
  }
  return { kind: "no-proxy", text: "直连不通，也没检测到系统代理。如果你用代理软件，打开它的「系统代理」后选「系统代理」，或在「手动」里填它的 HTTP 端口。" };
}

// ② 全链路：集群上 curl -x 走自己的反向端口。%{http_connect} 是代理对 CONNECT 的应答码，
// %{http_code} 是目标站的 HTTP 码（不带凭证访问 /v1/models 得 401 也说明整条链路通）。
export const FULL_CHAIN_URL = "https://api.openai.com/v1/models";
// 输出两行带标记的结果（curl 的报错文本可能夹在中间，按标记行取值）：
//   CW <http_connect> <http_code> <time_total>
//   CW_EXIT=<curl 退出码>
// withProxyAuth：命令多一个 `-K -`（curl 从标准输入读一行配置），调用方把 fullChainInput() 的结果交给
// SSH 的标准输入。不给时命令与以前逐字相同。
export function buildFullChainCommand(remotePort, { withProxyAuth = false } = {}) {
  const port = Number(remotePort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid remote port: ${remotePort}`);
  const stdinConfig = withProxyAuth ? ` ${CURL_STDIN_CONFIG_FLAG}` : "";
  return `curl -sS -o /dev/null -w '\\nCW %{http_connect} %{http_code} %{time_total}\\n' --connect-timeout 10 --max-time 15 -x http://127.0.0.1:${port}${stdinConfig} ${FULL_CHAIN_URL} 2>&1; echo "CW_EXIT=$?"`;
}

// 全链路自测怎么发：{ command, input }。credential 为 null（口令是关）时 input 为 null、命令照旧。
export function buildFullChainInvocation(remotePort, credential = null) {
  const input = curlProxyAuthInput(credential);
  return { command: buildFullChainCommand(remotePort, { withProxyAuth: input !== null }), input };
}

// curl 输出 → { ok, stage, connectCode, httpCode, ms, exit, message }。
export function parseFullChainOutput(stdout, { remotePort } = {}) {
  const text = String(stdout || "");
  const m = text.match(/^CW (\d{3}) (\d{3}) ([\d.,]+)\s*$/m);
  const exitMatch = text.match(/^CW_EXIT=(\d+)\s*$/m);
  const exit = exitMatch ? Number(exitMatch[1]) : -1;
  const connectCode = m ? Number(m[1]) : 0;
  const httpCode = m ? Number(m[2]) : 0;
  const ms = m ? Math.round(parseFloat(m[3].replace(",", ".")) * 1000) : null;
  const base = { connectCode, httpCode, ms, exit };
  if (!exitMatch) return { ...base, ok: false, stage: "ssh", message: "远端命令没有跑完（SSH 失败或超时）" };
  if (httpCode > 0) return { ...base, ok: true, stage: null, message: `全链路通（HTTP ${httpCode}${ms != null ? `，${ms}ms` : ""}）` };
  if (exit === 7 && connectCode === 0) {
    return { ...base, ok: false, stage: "tunnel", message: `集群连不上反向端口 127.0.0.1:${remotePort}（隧道没起或端口不对）` };
  }
  if (connectCode === 407) return { ...base, ok: false, stage: "proxy", message: "本机代理要求口令，这次请求没有带对（代理口令是「强制」）" };
  if (connectCode === 403) return { ...base, ok: false, stage: "proxy", message: "本机代理拒绝了这个目标（策略拦截）" };
  if (connectCode >= 500) return { ...base, ok: false, stage: "proxy", message: `本机代理连不上外网（HTTP ${connectCode}）` };
  if (exit === 28) return { ...base, ok: false, stage: "tls", message: "连接超时（隧道或本机出网太慢）" };
  if (exit === 35 || exit === 60) return { ...base, ok: false, stage: "tls", message: "TLS 握手失败或证书不受信任" };
  return { ...base, ok: false, stage: "unknown", message: `未能完成请求（curl 退出码 ${exit}）` };
}
