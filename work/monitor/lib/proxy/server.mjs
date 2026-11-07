// CONNECT 代理的 http.Server：/proxy-health、明文绝对地址转发、CONNECT 隧道、在册连接跟踪，
// 以及热更新交接的两半——新代理侧的 bind 重试（listenWithHandoffRetry）与旧代理侧的
// 释放监听 + 排空（release）。放行判定与解析闸门见 ./target-policy.mjs，经上游代理拨号见
// ./upstream.mjs（v2.54 出网方式 system / manual），本机解析器金丝雀见 ./resolver-canary.mjs，
// 逐跳头与跳标记见 ./headers.mjs。代理口令的判定见 ./auth.mjs，使用记录见 ./usage.mjs（v2.62）。
import http from "node:http";
import net from "node:net";
import { URL } from "node:url";

import { classifyProxyAuthorization, CONNECT_AUTH_REQUIRED_RESPONSE, PROXY_AUTH_REQUIRED_HEADERS } from "./auth.mjs";
import { createCachedLookup } from "./dns-cache.mjs";
import { HANDOFF_BIND_TIMEOUT_MS, HANDOFF_DRAIN_MAX_MS, HANDOFF_RETRY_MS } from "./handoff.mjs";
import { createHopId, forwardRequestHeaders, isProxyLoop, readHopChain } from "./headers.mjs";
import { canaryResolveFromLookup, createDefaultCanaryResolve, createResolverCanary } from "./resolver-canary.mjs";
import {
  createRebindGuardedLookup,
  EXTRA_ALLOWED_TARGETS,
  isValidPort,
  makeDefaultAllowTarget,
  parseConnectAuthority,
  RESOLVED_PRIVATE_ERROR_CODE,
} from "./target-policy.mjs";
import { dialViaUpstream, UPSTREAM_ERROR, upstreamFailureReason, upstreamForwardOptions } from "./upstream.mjs";
import { usageTargetKey } from "./usage.mjs";

// auth-deny 的日志限频：强制模式下有人不带口令反复连，每分钟最多记一条（带上这期间压掉了几条）。
// 逐目标的次数在使用记录里，日志只留一个「有人被拒了」的痕迹。
const AUTH_DENY_LOG_INTERVAL_MS = 60_000;

// 上游模式下本地解析闸门的时间预算：本机 DNS 挂住时不能把每个 CONNECT 都拖到拨号超时，
// 超时（ETIMEOUT）与其它解析失败同等处理——交给金丝雀定夺放行还是拒绝（见 preflightTarget）。
export const UPSTREAM_LOOKUP_BUDGET_MS = 2000;
// lookup-fail-forwarded / lookup-fail-denied 的日志限频：同一 host 每分钟各最多记一条，
// DNS 整体不通或有人刷请求时不刷屏。
const LOOKUP_FAIL_LOG_INTERVAL_MS = 60_000;

// /proxy-health 的出网头：只发布出网方式（旧版代理没有这个头）。不发布上游地址——节点上任何账号
// 都能 curl 别人的反向端口打到这里，上游代理地址是同事本机网络的细节，不该外泄；控制面在本机
// 读同一份分层配置与系统代理识别结果自己算出"经哪个上游"（egress/service.mjs）。
export function egressHealthHeaders(policy) {
  return { "x-codex-proxy-egress": policy?.egressMode || "direct" };
}

// 监听起来之后 http.Server 的 'error' 基本只剩 accept 失败（EMFILE / ENFILE / ECONNABORTED…）：
// libuv 照常继续监听，下一个连接还能 accept——这类错误只限频记日志，绝不让代理退出（集群出网的
// 生命线；之前一个自环就能递归到 EMFILE 把进程带走）。其它错误交给 onFatal（CLI 决定退出码）。
export function createServerErrorHandler({ onFatal, log = (line) => console.error(line), now = Date.now, intervalMs = 5000 }) {
  let lastLoggedAt = -Infinity;
  let suppressed = 0;
  return function onServerError(err) {
    if (err?.syscall !== "accept") {
      onFatal(err);
      return;
    }
    if (now() - lastLoggedAt < intervalMs) {
      suppressed += 1;
      return;
    }
    log(`[proxy] accept failed (still listening): ${err.code || err.message}${suppressed ? ` (+${suppressed} suppressed)` : ""}`);
    lastLoggedAt = now();
    suppressed = 0;
  };
}

function closeQuietly(socket, message) {
  if (!socket || socket.destroyed) return;
  try {
    if (message && socket.writable && !socket.writableEnded) {
      socket.end(message);
    } else {
      socket.destroy();
    }
  } catch {
    socket.destroy();
  }
}

// CONNECT 代理工厂：依赖可注入（lookup/log/now/超时/allowTarget/extraAllowedTargets/getPolicy），
// 便于测试与打点。extraAllowedTargets 只影响默认策略；显式传 allowTarget 时整体覆盖（含白名单逻辑）。
// 无论 lookup/allowTarget 是否被注入覆盖，解析闸门（createRebindGuardedLookup）都在
// 拨号前对解析结果复检，闸门的放行判定与活动 allowTarget 保持同一套语义。
//
// getPolicy()（v2.54）：每个请求现取 { allowTarget, upstream, egressMode }——热重载时整体替换
// 返回值即可，已建立的连接不受影响。缺省时由 allowTarget 组成静态直连策略（旧调用方式不变）。
// upstream 非空时走"经上游代理"分支，闸门语义见 preflightTarget。
// 策略里的 auth（v2.62，代理口令）：没有它或 mode 为 off 时，下面与口令、使用记录有关的代码一行都不走——
// 对外行为与加这项功能之前逐字节相同。observe 全部放行、只记数；enforce 对没带对口令的 CONNECT 与明文
// 转发回 407。/proxy-health 在口令判定之前就已应答，任何模式下都不受影响，也不带任何与口令有关的信息。
// usage：使用记录器（./usage.mjs 的 createUsageRecorder）；只在口令模式不是 off 时才会被调用。
// resolverCanary：{ isHealthy(): Promise<boolean> }，缺省按 lookup 是否注入选探测方式（注入时用同一个
// lookup，测试保持封闭）。hopId：本实例的跳标记 id（缺省随机；生产一进程一个实例 = 每进程一个 id）。
export function createProxyServer({
  port = 8888,
  connectTimeoutMs = 10000,
  lookup: lookupOverride,
  log = (line) => console.log(line),
  now = Date.now,
  extraAllowedTargets = EXTRA_ALLOWED_TARGETS,
  allowTarget = makeDefaultAllowTarget(extraAllowedTargets),
  getPolicy,
  upstreamLookupBudgetMs = UPSTREAM_LOOKUP_BUDGET_MS,
  resolverCanary,
  hopId = createHopId(),
  // /proxy-health 追加的响应头（pid / 组件指纹 / 交接能力）。旧 supervisor 只看 body，
  // 多出的头对它透明。
  healthHeaders = {},
  usage = null,
} = {}) {
  // 只监听 loopback：这是本机代理，绝不对外暴露。
  const host = "127.0.0.1";
  const lookup = lookupOverride || createCachedLookup({ now });
  const canary = resolverCanary || createResolverCanary({
    resolve: lookupOverride ? canaryResolveFromLookup(lookupOverride) : createDefaultCanaryResolve({ budgetMs: upstreamLookupBudgetMs }),
    budgetMs: upstreamLookupBudgetMs,
    now,
  });
  // 在册连接（含已升级为 CONNECT 隧道的 socket）：释放监听后据此判断何时排空。
  const sockets = new Set();
  let released = false;
  let drainWaiters = [];
  const staticPolicy = { allowTarget, upstream: null, egressMode: "direct" };
  // 策略取不到（返回空 / 抛错）时回落静态直连策略：取策略本身不能成为崩进程的入口。
  function currentPolicy() {
    if (typeof getPolicy !== "function") return staticPolicy;
    try {
      return getPolicy() || staticPolicy;
    } catch {
      return staticPolicy;
    }
  }
  const lookupFailLoggedAt = new Map();
  const boundPort = () => server.address()?.port ?? port;

  // 上游模式的本地解析闸门。目标字面量已过 allowTarget；这里在本机解析一次主机名并逐地址复检：
  //   - 解析出私网（且活动策略未显式放行）→ verdict "private"，调用方按 403 拒绝（与直连同语义）；
  //   - 解析成功且全是公网 → "ok"；
  //   - 解析失败 / 超出时间预算 → 问本机解析器金丝雀（resolver-canary.mjs）：
  //       · 金丝雀也失败（本机 DNS 整体不可用，只能靠代理软件解析）→ "lookup-fail-forwarded"，
  //         照常交给上游——这正是要上游的原因；
  //       · 金丝雀成功（本机 DNS 健康，偏偏这个域名解析不了）→ "lookup-fail-denied"，调用方回 502。
  //         v2.54 终审前这里一律放行：节点上任何账号都能用一个"对本机解析器必然失败 / 超时"的域名
  //         （自建权威 DNS 不应答、只在代理软件的 DNS 里有记录等）确定性绕过私网闸门，借上游
  //         （Clash 对私网规则 DIRECT）打到同事的局域网。
  //     两种结论都按 host 限频记一条日志。
  // 交给上游的始终是原主机名（不是本地解析出的 IP）：代理软件按域名分流的规则才能生效。
  // 残余风险（已接受）：
  //   ① 分裂 DNS / TOCTOU——本机解析得到公网地址、上游（代理软件自己的 DNS / 远端节点）解析成
  //      私网地址，我们看不到上游的解析结果，拦不住；
  //   ② 本机 DNS 整体不可用期间（金丝雀失败、结论缓存 60 秒），解析失败的目标照常交给上游自行解析。
  //   两者端口仍受 443 / 白名单约束；第 4 期的代理口令进一步收窄可利用面。
  function preflightTarget(targetHost, targetPort, policyAllowTarget) {
    return new Promise((resolve) => {
      if (net.isIP(String(targetHost).replace(/^\[|\]$/g, ""))) {
        resolve({ verdict: "ok", dnsMs: 0 }); // IP 字面量：allowTarget 已按字面量判过
        return;
      }
      const t0 = now();
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ ...result, dnsMs: now() - t0 });
      };
      const timer = setTimeout(() => finish({ verdict: "lookup-fail", reason: "ETIMEOUT" }), upstreamLookupBudgetMs);
      const guarded = createRebindGuardedLookup({ lookup, allowTarget: policyAllowTarget, port: targetPort });
      try {
        guarded(targetHost, { all: true }, (err) => {
          if (err?.code === RESOLVED_PRIVATE_ERROR_CODE) finish({ verdict: "private", blockedAddress: err.blockedAddress });
          else if (err) finish({ verdict: "lookup-fail", reason: err.code || "error" });
          else finish({ verdict: "ok" });
        });
      } catch (err) {
        finish({ verdict: "lookup-fail", reason: err?.code || "error" });
      }
    });
  }

  function logLookupFail(kind, targetHost, targetPort, reason) {
    const key = `${kind}|${String(targetHost).toLowerCase()}`;
    const last = lookupFailLoggedAt.get(key);
    if (last !== undefined && now() - last < LOOKUP_FAIL_LOG_INTERVAL_MS) return;
    if (lookupFailLoggedAt.size >= 256) lookupFailLoggedAt.clear(); // 目标域名个位数，上限纯防御（刷随机域名也只是清表）
    lookupFailLoggedAt.set(key, now());
    log(`${kind} host=${targetHost} port=${targetPort} reason=${reason}`);
  }

  // 本地解析闸门 + 金丝雀定夺 → verdict ∈ ok / private / lookup-fail-forwarded / lookup-fail-denied。
  // 永不 reject：金丝雀本身出错按"健康"处理（失败关闭——宁可拒掉解析失败的目标，也不放行）。
  async function gateUpstreamTarget(targetHost, targetPort, policyAllowTarget) {
    const pre = await preflightTarget(targetHost, targetPort, policyAllowTarget);
    if (pre.verdict !== "lookup-fail") return pre;
    let resolverHealthy = true;
    try {
      resolverHealthy = (await canary.isHealthy()) !== false;
    } catch {}
    const verdict = resolverHealthy ? "lookup-fail-denied" : "lookup-fail-forwarded";
    logLookupFail(verdict, targetHost, targetPort, pre.reason);
    return { ...pre, verdict };
  }

  // 跳标记：请求头里的跳 id 链已含本实例 id（请求经外部转发器绕回了自己）或链长超限 → true。
  function isLoopedBack(headers) {
    return isProxyLoop(readHopChain(headers), hopId);
  }

  // 口令闸。策略里没有 auth 或 mode 为 off → null，调用方原路继续。否则 → { verdict, deny, key }：
  //   verdict  "ok" | "missing" | "bad"（只用于计数，不外泄——407 对「没带」与「带错」逐字节相同）
  //   deny     enforce 且凭证不对
  //   key      使用记录里这个目标的键（字符不合规的目标为 null，记进「其它」）
  // 放在环路判定之后、放行策略之前：不带口令的人拿不到 403 / 502 这些能用来探白名单与内网的回答；
  // 环路判定在前不泄露什么（跳 id 是进程内随机数），却能让绕回自己的请求照旧被认成环路而不是 407。
  function checkAuth(policy, headers, targetHost, targetPort) {
    const auth = policy.auth;
    if (!auth || auth.mode === "off") return null;
    const verdict = classifyProxyAuthorization(auth, headers?.["proxy-authorization"], now());
    return { verdict, deny: auth.mode === "enforce" && verdict !== "ok", key: usageTargetKey(targetHost, targetPort) };
  }

  // 使用记录是旁路：记录器自己兜异常，这里再兜一层，绝不让它影响转发。
  function note(method, ...args) {
    if (!usage) return;
    try {
      usage[method](...args);
    } catch {}
  }

  let authDenyLoggedAt = -Infinity;
  let authDenySuppressed = 0;
  // 407 之前的记账与日志。目标本身过得了放行策略才按目标记（否则记进「其它」）：不带口令的人拿随机
  // 主机名、内网地址来试，刷不出一堆目标名。
  // 日志行的写法有讲究（supervisor 按子串给代理输出分级、界面按行首认信号，两边都不在这次改动范围内）：
  // 不能含 "connect-deny "（那是「目标被策略拒绝」，界面会亮红条并提示改白名单），也不能出现
  // "connect host="（那是建连成功的打点，supervisor 不落盘）——所以前缀是 auth-deny、方式写在 host / port 之后。
  function denyAuth(via, authState, policy, targetHost, targetPort) {
    let allowed = false;
    try {
      allowed = policy.allowTarget(targetHost, Number(targetPort)) === true;
    } catch {}
    note("noteDenied", allowed ? authState.key : null, authState.verdict);
    if (now() - authDenyLoggedAt < AUTH_DENY_LOG_INTERVAL_MS) {
      authDenySuppressed += 1;
      return;
    }
    log(`auth-deny host=${targetHost} port=${targetPort} via=${via} reason=${authState.verdict}${authDenySuppressed ? ` suppressed=${authDenySuppressed}` : ""}`);
    authDenyLoggedAt = now();
    authDenySuppressed = 0;
  }

  const server = http.createServer((req, res) => {
    const policy = currentPolicy();
    if (req.url === "/proxy-health") {
      res.writeHead(200, { ...healthHeaders, ...egressHealthHeaders(policy), "x-codex-proxy": "active", "content-type": "text/plain" });
      res.end("ok");
      return;
    }

    let target;
    try {
      target = new URL(req.url || "");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const forwardPort = Number(target.port || 80);
    if (isLoopedBack(req.headers)) {
      log(`forward-loop host=${target.hostname} port=${forwardPort}`);
      res.writeHead(508);
      res.end();
      return;
    }
    const authState = checkAuth(policy, req.headers, target.hostname, forwardPort);
    if (authState?.deny) {
      denyAuth("forward", authState, policy, target.hostname, forwardPort);
      res.writeHead(407, PROXY_AUTH_REQUIRED_HEADERS);
      res.end();
      return;
    }
    if (!policy.allowTarget(target.hostname, forwardPort)) {
      log(`forward-deny host=${target.hostname} port=${forwardPort}`);
      res.writeHead(403);
      res.end();
      return;
    }
    // 过了放行策略才记「带没带口令」：被策略拒掉的请求无论有没有口令都出不去，不算进「强制后会断」。
    if (authState) note("noteAuth", authState.key, authState.verdict);
    const usageKey = authState ? authState.key : undefined;

    if (policy.upstream) {
      // 上游模式：先过本地解析闸门，再把绝对地址请求（剥掉逐跳头）交给上游代理。
      // 闸门结果出来之前请求正文留在缓冲里（尚未 pipe），不会丢。
      // 明文分支不带跳标记头（取舍）：上游代理会把普通请求头原样转给源站，带上就等于把本进程的
      // 跳 id 发给任意源站（可用来跨请求关联同一位同事的代理）。明文走上游本就少见（只有白名单里
      // 的非 443 http 端口）；直接指回自己由 upstreamForwardOptions 的落点复检拦住，经外部转发器
      // 绕回的明文环路只会逐层耗连接直到超时，accept 失败由 createServerErrorHandler 兜住不退出。
      gateUpstreamTarget(target.hostname, forwardPort, policy.allowTarget).then((pre) => {
        if (res.writableEnded || res.destroyed) return;
        if (pre.verdict === "private") {
          log(`forward-deny host=${target.hostname} port=${forwardPort} reason=resolved-private resolved=${pre.blockedAddress}`);
          res.writeHead(403);
          res.end();
          return;
        }
        if (pre.verdict === "lookup-fail-denied") {
          res.writeHead(502);
          res.end();
          return;
        }
        pipeHttpRequest(
          req,
          res,
          upstreamForwardOptions({
            upstream: policy.upstream,
            url: req.url,
            method: req.method,
            headers: req.headers,
            selfPort: boundPort(),
          }),
          { targetHost: target.hostname, forwardPort, usageKey },
        );
      }).catch(() => {
        // http.request 同步抛错（畸形请求头等）：回 502，不让它变成进程级 unhandledRejection。
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end();
      });
      return;
    }

    // 明文转发分支与 CONNECT 共用同一个解析闸门：主机名字面量过了 allowTarget
    // 之后，解析出的地址仍要逐一复检，堵 DNS rebinding（字面量公网、解析私网）。
    const forwardLookup = createRebindGuardedLookup({
      lookup,
      allowTarget: policy.allowTarget,
      port: forwardPort,
    });
    pipeHttpRequest(
      req,
      res,
      {
        host: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        // 逐跳头（Proxy-Authorization 等）只给本跳，转给目标站前剥掉（headers.mjs）。
        headers: forwardRequestHeaders(req.headers),
        lookup: forwardLookup,
      },
      { targetHost: target.hostname, forwardPort, usageKey },
    );
  });

  // 明文请求发出去之后的公共收尾（直连与上游两条分支共用）：超时 504、闸门拒绝 403、其余 502，
  // 以及客户端先断开时的清理。options 是 http.request 的参数（直连带解析闸门 lookup，上游是绝对地址）。
  // usageKey 不是 undefined（口令模式不是 off）时，另记这一次转发的正文字节数；off 时这里与以前一字不差。
  function pipeHttpRequest(req, res, options, { targetHost, forwardPort, usageKey }) {
    const upstream = http.request(options, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });

    let httpTimedOut = false;
    upstream.setTimeout(connectTimeoutMs, () => {
      httpTimedOut = true;
      upstream.destroy(new Error("upstream timeout"));
    });
    upstream.on("response", () => upstream.setTimeout(0));

    upstream.on("error", (err) => {
      if (!res.headersSent) {
        // 解析闸门拒绝：与字面量拒绝路径同格式（forward-deny 日志 + 403），
        // 而不是伪装成拨号失败的 502——运维排查时一眼分清"策略拒"与"网络挂"。
        if (err && err.code === RESOLVED_PRIVATE_ERROR_CODE) {
          log(
            `forward-deny host=${targetHost} port=${forwardPort} ` +
              `reason=resolved-private resolved=${err.blockedAddress}`,
          );
          res.writeHead(403);
        } else {
          res.writeHead(httpTimedOut ? 504 : 502);
        }
      }
      if (!res.writableEnded) res.end();
    });
    upstream.on("socket", (s) => s.setNoDelay(true));
    // 客户端先断开时防 pipe 重抛打崩常驻进程；close 在正常完成时也会触发，
    // 此时 upstream 已结束，destroy 是幂等无害的。
    res.on("error", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    if (usageKey !== undefined) {
      // 明文转发少见（只有白名单里的非 443 端口），按正文字节记个大概：旁听 data 事件，不改转发本身。
      const bytes = { up: 0, down: 0 };
      req.on("data", (chunk) => {
        bytes.up += chunk.length;
      });
      upstream.once("response", (upstreamRes) => {
        upstreamRes.on("data", (chunk) => {
          bytes.down += chunk.length;
        });
        upstreamRes.once("close", () => note("requestDone", usageKey, bytes));
      });
    }
    req.pipe(upstream);
  }

  // 热路径：转发的都是 TLS 小包与流式分片，Nagle 攒批只添延迟；keep-alive 探测防半开连接。
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (released && sockets.size === 0) notifyDrained();
    });
  });

  function notifyDrained() {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const waiter of waiters) waiter();
  }

  // CONNECT 经上游代理：解析闸门 → 向上游发 CONNECT → 200 后双向管道。
  // 失败一律 connect-fail（via=upstream）+ 502/504；解析出私网与直连同格式 connect-deny + 403。
  // hopChain：客户端 CONNECT 里带来的跳 id 链；发给上游时追加本实例 id。
  // usageKey：口令模式不是 off 时这个目标在使用记录里的键（off 时为 undefined，不记）。
  function connectViaUpstream({ policy, clientSocket, head, targetHost, targetPort, hopChain, usageKey }) {
    const startedAt = now();
    const cached = lookup.has ? lookup.has(targetHost) : false;
    // 客户端在解析 / 拨号期间先断开：取消拨号，免得上游 socket 悬着。
    const abort = new AbortController();
    const onClientGone = () => abort.abort();
    clientSocket.once("close", onClientGone);
    clientSocket.on("error", onClientGone);

    gateUpstreamTarget(targetHost, Number(targetPort), policy.allowTarget)
      .then((pre) => {
        if (clientSocket.destroyed) return null;
        if (pre.verdict === "private") {
          log(`connect-deny host=${targetHost} port=${targetPort} reason=resolved-private resolved=${pre.blockedAddress}`);
          closeQuietly(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
          return null;
        }
        if (pre.verdict === "lookup-fail-denied") {
          closeQuietly(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
          return null;
        }
        return dialViaUpstream({
          upstream: policy.upstream,
          host: targetHost,
          port: Number(targetPort),
          timeoutMs: connectTimeoutMs,
          head,
          selfPort: boundPort(),
          signal: abort.signal,
          // 发往上游的 CONNECT 只带 Host 与跳标记：客户端的 Proxy-Authorization 等一概不转。
          hopChain: [...hopChain, hopId],
        }).then((dialed) => ({ ...dialed, dnsMs: pre.dnsMs }));
      })
      .then((dialed) => {
        if (!dialed) return;
        const { socket: upstreamSocket, rest, dnsMs } = dialed;
        clientSocket.off("close", onClientGone);
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        log(
          `connect host=${targetHost} port=${targetPort} dnsMs=${dnsMs} ` +
            `tcpMs=${Math.max(0, now() - startedAt - dnsMs)} cached=${cached ? 1 : 0} via=upstream`,
        );
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length > 0) clientSocket.write(rest);
        if (usageKey !== undefined) {
          // 建隧道本身用掉的字节（发给上游的 CONNECT、上游的应答）不算流量，从此刻的计数里扣掉；
          // 随 CONNECT 一起到的首包（head）与应答之后已读到的字节（rest）是流量，留着。
          note("tunnelOpened", usageKey, upstreamSocket, {
            baseUp: upstreamSocket.bytesWritten - (head?.length || 0),
            baseDown: upstreamSocket.bytesRead - rest.length,
          });
        }
        upstreamSocket.on("error", () => clientSocket.destroy());
        upstreamSocket.on("close", () => clientSocket.destroy());
        clientSocket.on("error", () => upstreamSocket.destroy());
        clientSocket.on("close", () => upstreamSocket.destroy());
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      })
      .catch((err) => {
        clientSocket.off("close", onClientGone);
        if (err?.code === UPSTREAM_ERROR.ABORTED) return; // 客户端先走了，无人可回
        log(
          `connect-fail host=${targetHost} port=${targetPort} ` +
            `reason=${upstreamFailureReason(err)} ms=${now() - startedAt} via=upstream`,
        );
        closeQuietly(
          clientSocket,
          err?.code === UPSTREAM_ERROR.TIMEOUT ? "HTTP/1.1 504 Gateway Timeout\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n",
        );
      });
  }

  server.on("connect", (req, clientSocket, head) => {
    const policy = currentPolicy();
    const authority = parseConnectAuthority(req.url || "");
    if (!authority?.host || !isValidPort(authority.port)) {
      closeQuietly(clientSocket, "HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const { host: targetHost, port: targetPort } = authority;

    // 跳标记环路：本实例发往上游的 CONNECT 经外部转发器（SSH 端口转发、另一层透明转发等）绕回
    // 了自己。不拦的话每一圈都新开一条连接，递归到文件描述符耗尽。
    const hopChain = readHopChain(req.headers);
    if (isProxyLoop(hopChain, hopId)) {
      log(`connect-loop host=${targetHost} port=${targetPort} hops=${hopChain.length}`);
      closeQuietly(clientSocket, "HTTP/1.1 508 Loop Detected\r\n\r\n");
      return;
    }

    const authState = checkAuth(policy, req.headers, targetHost, targetPort);
    if (authState?.deny) {
      denyAuth("connect", authState, policy, targetHost, targetPort);
      closeQuietly(clientSocket, CONNECT_AUTH_REQUIRED_RESPONSE);
      return;
    }

    if (!policy.allowTarget(targetHost, Number(targetPort))) {
      log(`connect-deny host=${targetHost} port=${targetPort}`);
      closeQuietly(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    // 过了放行策略才记「带没带口令」（理由同明文转发分支）。
    if (authState) note("noteAuth", authState.key, authState.verdict);
    const usageKey = authState ? authState.key : undefined;

    if (policy.upstream) {
      connectViaUpstream({ policy, clientSocket, head, targetHost, targetPort, hopChain, usageKey });
      return;
    }

    const startedAt = now();
    const stats = { dnsMs: 0, cached: lookup.has ? lookup.has(targetHost) : false };
    // 解析闸门是字面量策略之外的兜底：主机名过了 allowTarget，解析出的每个候选
    // 地址（autoSelectFamily 双栈全量）仍要复检，堵 DNS rebinding 穿透。
    const guardedLookup = createRebindGuardedLookup({
      lookup,
      allowTarget: policy.allowTarget,
      port: Number(targetPort),
    });
    const timedLookup = (hostname, options, cb) => {
      const t0 = now();
      guardedLookup(hostname, options, (...args) => {
        stats.dnsMs = now() - t0;
        cb(...args);
      });
    };

    let settled = false;   // 拨号已成功
    let timedOut = false;  // 拨号被超时器终止

    const upstream = net.connect(
      {
        host: targetHost,
        port: Number(targetPort),
        lookup: timedLookup,
        autoSelectFamily: true,              // 双栈并行竞速，IPv6 黑洞不再阻塞
        autoSelectFamilyAttemptTimeout: 250,
      },
      () => {
        settled = true;
        clearTimeout(dialTimer);
        if (clientSocket.destroyed) {
          upstream.destroy();
          return;
        }
        log(
          `connect host=${targetHost} port=${targetPort} dnsMs=${stats.dnsMs} ` +
            `tcpMs=${Math.max(0, now() - startedAt - stats.dnsMs)} cached=${stats.cached ? 1 : 0} via=direct`,
        );
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (usageKey !== undefined) note("tunnelOpened", usageKey, upstream);
        if (head.length > 0 && !upstream.destroyed) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
    );
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, 30000);

    const dialTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      upstream.destroy(new Error(`dial timeout after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    upstream.on("error", (err) => {
      clearTimeout(dialTimer);
      if (!settled) {
        // 解析闸门拒绝（rebind 拦截）：与字面量拒绝路径同格式（connect-deny + 403）。
        // 有意不驱逐 DNS 缓存——TTL 内重复 CONNECT 直接用缓存记录快速拒绝，
        // 也避免攻击者靠反复触发重新解析来"抖"出一次放行窗口。
        if (err && err.code === RESOLVED_PRIVATE_ERROR_CODE) {
          log(
            `connect-deny host=${targetHost} port=${targetPort} ` +
              `reason=resolved-private resolved=${err.blockedAddress}`,
          );
          closeQuietly(clientSocket, "HTTP/1.1 403 Forbidden\r\n\r\n");
          return;
        }
        // 拨号失败：驱逐该 host 的 DNS 正缓存条目，避免死 IP 在 TTL 内
        // 持续制造 502/504（下次 CONNECT 会重新解析而不是复用死记录）。
        if (lookup.cache) lookup.cache.delete(targetHost);
        log(
          `connect-fail host=${targetHost} port=${targetPort} ` +
            `reason=${timedOut ? "timeout" : (err?.code) || "error"} ms=${now() - startedAt} via=direct`,
        );
        closeQuietly(
          clientSocket,
          timedOut ? "HTTP/1.1 504 Gateway Timeout\r\n\r\n" : "HTTP/1.1 502 Bad Gateway\r\n\r\n",
        );
        return;
      }
      clientSocket.destroy();
    });
    clientSocket.on("error", () => upstream.destroy());
    clientSocket.on("close", () => {
      clearTimeout(dialTimer);
      upstream.destroy();
    });
  });

  server.on("clientError", (_err, socket) => {
    closeQuietly(socket, "HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  function listen(cb) {
    server.listen(port, host, () => {
      log(`HTTP CONNECT proxy listening on http://${host}:${server.address().port}`);
      if (cb) cb();
    });
  }

  function close(cb) {
    server.close(cb);
  }

  // 交接模式的 listen：EADDRINUSE 时每 retryMs 重试，直到 timeoutMs。第一次撞上占用时
  // 回调 onWaiting（CLI 据此打印 HANDOFF_WAITING_MARKER）。其它错误立即 reject。
  function listenWithHandoffRetry({
    retryMs = HANDOFF_RETRY_MS,
    timeoutMs = HANDOFF_BIND_TIMEOUT_MS,
    onWaiting = () => {},
  } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = now() + timeoutMs;
      let announced = false;
      const attempt = () => {
        const onError = (err) => {
          server.off("listening", onListening);
          if (err?.code !== "EADDRINUSE") {
            reject(err);
            return;
          }
          if (!announced) {
            announced = true;
            try {
              onWaiting();
            } catch {}
          }
          if (now() >= deadline) {
            reject(err);
            return;
          }
          setTimeout(attempt, retryMs);
        };
        const onListening = () => {
          server.off("error", onError);
          log(`HTTP CONNECT proxy listening on http://${host}:${server.address().port} (handoff)`);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      };
      attempt();
    });
  }

  // 旧代理侧：立刻关闭 listener（新连接交给新代理），已建立的连接继续服务直到自然结束；
  // 排空或到达 maxDrainMs 时 resolve（{ drained, remaining }）。幂等。
  function release({ maxDrainMs = HANDOFF_DRAIN_MAX_MS } = {}) {
    if (!released) {
      released = true;
      try {
        server.close();
      } catch {}
      // 空闲的 keep-alive 连接没有在途请求，留着只会把排空拖到窗口上限：立即关掉，
      // 让"零活动连接"的旧代理尽快退出（CONNECT 隧道已脱离 http 管理，不受影响）。
      try {
        server.closeIdleConnections?.();
      } catch {}
    }
    return new Promise((resolve) => {
      if (sockets.size === 0) {
        resolve({ drained: true, remaining: 0 });
        return;
      }
      const onDrained = () => {
        clearTimeout(timer);
        resolve({ drained: true, remaining: 0 });
      };
      const timer = setTimeout(() => {
        drainWaiters = drainWaiters.filter((w) => w !== onDrained);
        resolve({ drained: false, remaining: sockets.size });
      }, maxDrainMs);
      if (typeof timer.unref === "function") timer.unref();
      drainWaiters.push(onDrained);
    });
  }

  return {
    server,
    listen,
    close,
    listenWithHandoffRetry,
    release,
    activeConnections: () => sockets.size,
  };
}
