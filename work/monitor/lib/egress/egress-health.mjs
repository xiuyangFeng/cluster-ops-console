// 出网健康（v2.65，设计稿 2026-10-15 W1 §1）：本机代理之后那一段——「出网」——此刻通不通。
// 此前链路只看到本机代理在监听；Clash 之类的上游退出时整条链全绿，集群其实已经断网。
//
// 两路证据，结果只放在内存快照里（/api/status.egressHealth 读它，请求里不发任何连接）：
//   主动探测  每 30 秒一次：代理实际生效的出网方式是 manual / system、并且解析得出上游 host:port 时，
//             对上游做一次 TCP 连接（1.5 秒超时），连上立刻断开，一个字节都不发。direct 不探测（check:null）。
//             生效方式与上游跟 /api/egress 的 effective 同一口径（调用方注入，复用 resolveEffectiveUpstream）；
//             它要读本机代理的 /proxy-health，所以沿用最近一次结果，60 秒内有效。探测失败时下一轮重读一次，
//             免得刚改完出网方式还拿旧上游连续探两次、误报中断。
//   被动统计  bridge-ingest 已经在读的 supervisor 消息里，本机代理建连失败那一行
//             `[proxy] connect-fail host=… port=… reason=… ms=… via=upstream|direct`（lib/proxy/server.mjs）
//             按 reason 分四类计近 10 分钟的次数：
//               refused   upstream-refused，或 direct 下的 ECONNREFUSED
//               timeout   upstream-timeout，或 direct 下的 timeout（代理自己的拨号超时）/ ETIMEDOUT（系统层超时）
//               rejected  upstream-rejected-<状态码>（上游回了非 200）
//               other     其余原因；以及字段不合规的行（host 按使用记录的键规则校验，不合规的 host 记为 null）
//             另记最近一次失败 { host, port, reason, at } 与失败最多的前 5 个 host。原始消息一个字都不留；
//             时刻取日志行自己的 ts——刚启动时摄取会先读回文件尾巴里的旧行，按 ts 算才不会把旧失败当成刚发生的。
//
// 状态判定（snapshot 时现算，窗口按现在淘汰）：
//   unknown  代理没在运行（reason proxy-down）、还没有结果、fixture 模式
//   error    连续 2 次主动探测失败（reason 按最近一次：超时 upstream-timeout，其余 upstream-refused）；
//            或近 2 分钟内经上游的 upstream-refused ≥ 3（代理连不上上游，不必等两轮主动探测）。
//            直连下目标拒连只说明那个目标不收，不算出网中断——落到下面 warn 那一条。
//   warn     主动探测正常或不适用，但近 10 分钟失败 ≥ 3：上游在，但它到目标不通（例如 Clash 节点坏了）；
//            direct 模式也按这一条算。reason target-failures
//   ok       其余情况。单独一次探测失败不改变判定（等第二次确认），免得一次抖动就闪红
//
// 有界：失败记录最多 2000 条（超出丢最旧的），只留近 10 分钟。
// fixture 模式（冒烟 / 界面预览的隔离监控服务）：既不调 connect 也不调 resolveEffective，快照恒为 unknown、mode null。
//
// 只属于控制面：不在本机代理与 channel-supervisor 的指纹闭包里（只 import 它们的共享件，不被它们 import）。
import net from "node:net";

import { usageTargetKey } from "../proxy/usage.mjs";

export const EGRESS_CHECK_INTERVAL_MS = 30_000;
export const EGRESS_CHECK_TIMEOUT_MS = 1500;
export const EGRESS_EFFECTIVE_TTL_MS = 60_000;
export const EGRESS_FAILURE_WINDOW_MS = 10 * 60_000;
export const EGRESS_REFUSED_WINDOW_MS = 2 * 60_000;
export const EGRESS_FAILURE_WARN_COUNT = 3;
export const EGRESS_REFUSED_ERROR_COUNT = 3;
export const EGRESS_CHECK_FAILURES_FOR_ERROR = 2;
export const EGRESS_FAILURE_CAP = 2000;
export const EGRESS_TOP_HOSTS = 5;
// 解析生效方式的上限（读 /proxy-health 本身 2 秒超时、系统代理识别有执行超时；这里再兜一层，免得一轮卡住整个循环）
export const EGRESS_EFFECTIVE_TIMEOUT_MS = 5000;

const EFFECTIVE_MODES = new Set(["manual", "system", "direct"]);
const CHECKED_MODES = new Set(["manual", "system"]);

// 只认 supervisor 转写的代理输出（stdout 是 "[proxy] "，stderr 是 "[proxy:err] "）。
const CONNECT_FAIL_RE = /^\[proxy(?::err)?\] connect-fail (.*)$/;
const FIELD_RE = /(?:^| )(host|port|reason|ms|via)=(\S*)/g;
// reason：upstreamFailureReason() 的单词形态（含 upstream-<errno 小写>）或直连的 timeout / errno 码。
const REASON_RE = /^[A-Za-z0-9_-]{1,64}$/;
// 主动探测的错误只留短码（errno 码 / timeout），不留 message。
const ERROR_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MESSAGE_MAX = 2048;

// reason（+ via）→ 四类之一。
export function classifyConnectFailReason(reason, via) {
  if (typeof reason !== "string") return "other";
  if (reason === "upstream-refused") return "refused";
  if (reason === "upstream-timeout") return "timeout";
  if (reason.startsWith("upstream-rejected-")) return "rejected";
  if (via === "direct") {
    if (reason === "ECONNREFUSED") return "refused";
    if (reason === "timeout" || reason === "ETIMEDOUT") return "timeout";
  }
  return "other";
}

// "host:port" 键 → host 部分（IPv6 带中括号，与使用记录同形）。
const hostOfKey = (key) => key.slice(0, key.lastIndexOf(":"));

// supervisor 消息 → { host, port, reason, via, cls } | null（不是 connect-fail 行）。
// 字段不合规的行照样算一次失败，但只记进 other：host 不合规 → host / port 为 null，reason 不合规 → null。
export function parseConnectFailMessage(message) {
  if (typeof message !== "string" || message.length > MESSAGE_MAX) return null;
  const match = CONNECT_FAIL_RE.exec(message);
  if (!match) return null;
  const fields = {};
  for (const [, name, value] of match[1].matchAll(FIELD_RE)) {
    if (!(name in fields)) fields[name] = value;
  }
  const key = /^\d{1,5}$/.test(fields.port ?? "") ? usageTargetKey(fields.host, fields.port) : null;
  const reason = REASON_RE.test(fields.reason ?? "") ? fields.reason : null;
  const via = fields.via === "upstream" || fields.via === "direct" ? fields.via : null;
  const valid = key !== null && reason !== null && via !== null && /^\d{1,9}$/.test(fields.ms ?? "");
  return {
    host: key ? hostOfKey(key) : null,
    port: key ? Number(fields.port) : null,
    reason,
    via,
    cls: valid ? classifyConnectFailReason(reason, via) : "other",
  };
}

// 近 10 分钟的失败记录：按时刻升序的数组，有界。
export function createFailureWindow({ windowMs = EGRESS_FAILURE_WINDOW_MS, cap = EGRESS_FAILURE_CAP } = {}) {
  const entries = [];

  function evict(now) {
    const from = now - windowMs;
    let drop = 0;
    while (drop < entries.length && entries[drop].at <= from) drop += 1;
    if (drop) entries.splice(0, drop);
  }

  // failure：parseConnectFailMessage 的结果。at 晚于现在的（时钟差）按现在记；早于窗口的直接不收。
  function add(failure, at, now) {
    const when = Number.isFinite(at) ? Math.min(at, now) : now;
    if (when <= now - windowMs) return false;
    const entry = { at: when, cls: failure.cls, host: failure.host, port: failure.port, reason: failure.reason, via: failure.via };
    // 摄取基本按时间顺序到达；偶尔乱序时插到该在的位置，淘汰才能只看队头。
    let index = entries.length;
    while (index > 0 && entries[index - 1].at > when) index -= 1;
    entries.splice(index, 0, entry);
    if (entries.length > cap) entries.splice(0, entries.length - cap);
    return true;
  }

  // → { windowMs, total, refused, timeout, rejected, other, last, topHosts, recentRefused, recentRefusedViaUpstream }
  // 后两项是状态判定用的近 2 分钟 refused 计数，不进对外快照。
  function summarize(now, { refusedWindowMs = EGRESS_REFUSED_WINDOW_MS, topHosts = EGRESS_TOP_HOSTS } = {}) {
    evict(now);
    const counts = { refused: 0, timeout: 0, rejected: 0, other: 0 };
    const byHost = new Map();
    let recentRefused = 0;
    let recentRefusedViaUpstream = 0;
    for (const entry of entries) {
      counts[entry.cls] += 1;
      if (entry.host) {
        const item = byHost.get(entry.host) || { host: entry.host, count: 0, lastAt: 0 };
        item.count += 1;
        item.lastAt = Math.max(item.lastAt, entry.at);
        byHost.set(entry.host, item);
      }
      if (entry.cls === "refused" && entry.at > now - refusedWindowMs) {
        recentRefused += 1;
        if (entry.via === "upstream") recentRefusedViaUpstream += 1;
      }
    }
    const lastEntry = entries.at(-1);
    return {
      windowMs,
      total: entries.length,
      ...counts,
      last: lastEntry ? { host: lastEntry.host, port: lastEntry.port, reason: lastEntry.reason, at: lastEntry.at } : null,
      topHosts: [...byHost.values()]
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt || a.host.localeCompare(b.host))
        .slice(0, topHosts)
        .map(({ host, count }) => ({ host, count })),
      recentRefused,
      recentRefusedViaUpstream,
    };
  }

  return { add, summarize, size: () => entries.length };
}

// 状态判定（纯函数）。
//   effective        出网服务算出的 { running, supportsEgress, mode, upstream } | null（还没有结果）
//   checkApplicable  这一轮是否该有主动探测（manual / system 且有上游）
//   check            最近一次主动探测 { ok, ms, at, error } | null
//   consecutiveCheckFailures  连续失败次数
//   failures         createFailureWindow().summarize() 的结果
// → { state, reason }
export function decideEgressState({ fixtureMode = false, effective, checkApplicable, check, consecutiveCheckFailures, failures }) {
  if (fixtureMode || !effective) return { state: "unknown", reason: null };
  if (!effective.running) return { state: "unknown", reason: "proxy-down" };
  if (checkApplicable && !check) return { state: "unknown", reason: null };
  if (checkApplicable && consecutiveCheckFailures >= EGRESS_CHECK_FAILURES_FOR_ERROR) {
    return { state: "error", reason: check?.error === "timeout" ? "upstream-timeout" : "upstream-refused" };
  }
  // 只在此刻经上游出网时才算：刚从手动切到直连，窗口里残留的「经上游被拒」不该把直连判成中断。
  if (checkApplicable && failures.recentRefusedViaUpstream >= EGRESS_REFUSED_ERROR_COUNT) return { state: "error", reason: "upstream-refused" };
  if (failures.total >= EGRESS_FAILURE_WARN_COUNT) return { state: "warn", reason: "target-failures" };
  return { state: "ok", reason: null };
}

// "host:port"（formatAuthority 的形状，IPv6 带中括号）→ { host, port } | null。
export function parseUpstreamAuthority(authority) {
  if (typeof authority !== "string") return null;
  const index = authority.lastIndexOf(":");
  if (index <= 0) return null;
  const port = Number(authority.slice(index + 1));
  const host = authority.slice(0, index).replace(/^\[|\]$/g, "");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

const errorCodeOf = (err) => {
  const code = err?.code;
  return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : "error";
};

// 一次 TCP 连接：连上立刻 destroy，不写任何字节。→ { ok, ms, error }（error 是短码；超时为 "timeout"）。
export function probeTcp({ connect = net.connect, host, port, timeoutMs = EGRESS_CHECK_TIMEOUT_MS, now = Date.now }) {
  return new Promise((resolve) => {
    const startedAt = now();
    let settled = false;
    let socket = null;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {}
      resolve({ ok, ms: ok ? Math.max(0, now() - startedAt) : null, error });
    };
    const timer = setTimeout(() => finish(false, "timeout"), timeoutMs);
    timer.unref?.();
    try {
      socket = connect({ host, port });
    } catch (err) {
      finish(false, errorCodeOf(err));
      return;
    }
    // 连上之后再来的 error（对端立刻重置之类）也由这里接住，不变成未捕获异常。
    socket.on("error", (err) => finish(false, errorCodeOf(err)));
    socket.once("connect", () => finish(true, null));
  });
}

const emptyFailures = (windowMs) => ({ windowMs, total: 0, refused: 0, timeout: 0, rejected: 0, other: 0, last: null, topHosts: [] });

export function createEgressHealth({
  // async () → { running, supportsEgress, mode, upstream }（出网服务的 getEffective，与 /api/egress 的 effective 同口径）
  resolveEffective,
  connect = net.connect,
  now = Date.now,
  intervalMs = EGRESS_CHECK_INTERVAL_MS,
  timeoutMs = EGRESS_CHECK_TIMEOUT_MS,
  effectiveTtlMs = EGRESS_EFFECTIVE_TTL_MS,
  fixtureMode = false,
  log = () => {},
} = {}) {
  const failures = createFailureWindow();
  let effective = null; // 最近一次解析出的生效方式
  let effectiveAt = null;
  let checkTarget = null; // 当前探测的上游 "host:port"；换了就重新计连续失败
  let lastCheck = null;
  let consecutiveCheckFailures = 0;
  let checkedAt = null;
  let lastLoggedState = null;
  let inflight = null;
  let timer = null;

  async function currentEffective() {
    if (effective && effectiveAt !== null && now() - effectiveAt < effectiveTtlMs) return effective;
    let timer = null;
    try {
      const value = await Promise.race([
        resolveEffective(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), EGRESS_EFFECTIVE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      effective = value && typeof value === "object" ? value : null;
      // 代理没在运行（冷启动还没监听、被守护进程重启、/proxy-health 慢了一拍）不缓存：下一轮就重读，
      // 免得代理已经起来了，出网节点还灰着「未知」一分钟。
      effectiveAt = effective?.running ? now() : null;
    } catch {
      // 读不出来 / 超时：留着上一份（可能为 null），下一轮再读。
    } finally {
      clearTimeout(timer);
    }
    return effective;
  }

  // 这一轮该探测的上游：生效方式 manual / system 且解析得出上游时 → { host, port, authority }，否则 null。
  function activeTarget(value) {
    if (!value?.running || !CHECKED_MODES.has(value.mode)) return null;
    const parsed = parseUpstreamAuthority(value.upstream);
    return parsed ? { ...parsed, authority: value.upstream } : null;
  }

  async function runRound() {
    const value = await currentEffective();
    const target = activeTarget(value);
    if (!target) {
      checkTarget = null;
      lastCheck = null;
      consecutiveCheckFailures = 0;
    } else {
      if (checkTarget !== target.authority) {
        checkTarget = target.authority;
        lastCheck = null;
        consecutiveCheckFailures = 0;
      }
      const result = await probeTcp({ connect, host: target.host, port: target.port, timeoutMs, now });
      lastCheck = { ok: result.ok, ms: result.ms, at: now(), error: result.error };
      consecutiveCheckFailures = result.ok ? 0 : consecutiveCheckFailures + 1;
      if (!result.ok) effectiveAt = null; // 下一轮重读生效方式（可能刚改了设置）
    }
    checkedAt = now();
    logTransition();
  }

  // 判定变化时写一行运维日志（只有状态与原因，没有目标名）。
  function logTransition() {
    const { state, reason } = currentState(failures.summarize(now()));
    const key = `${state}:${reason ?? ""}`;
    if (key === lastLoggedState) return;
    if (lastLoggedState !== null || state !== "ok") log(`egress health: ${state}${reason ? ` (${reason})` : ""}`);
    lastLoggedState = key;
  }

  function currentState(summary) {
    return decideEgressState({
      fixtureMode,
      effective,
      checkApplicable: checkTarget !== null,
      check: lastCheck,
      consecutiveCheckFailures,
      failures: summary,
    });
  }

  // 立刻跑一轮（同一时刻只有一轮在途，重复调用复用它）。fixture 模式什么都不做。
  function checkNow() {
    if (fixtureMode) return Promise.resolve(snapshot());
    if (!inflight) {
      inflight = runRound()
        .catch(() => {})
        .finally(() => {
          inflight = null;
        });
    }
    return inflight.then(() => snapshot());
  }

  function start() {
    if (fixtureMode || timer) return;
    timer = setInterval(() => {
      checkNow().catch(() => {});
    }, intervalMs);
    timer.unref?.();
    checkNow().catch(() => {});
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // bridge-ingest 的旁路观察者：每条 supervisor 消息进来一次。at：日志行的 ts。不是 connect-fail 行的直接忽略。
  function noteSupervisorMessage(message, at) {
    const failure = parseConnectFailMessage(message);
    if (failure) failures.add(failure, Number(at), now());
  }

  function snapshot() {
    if (fixtureMode) {
      return { mode: null, upstream: null, state: "unknown", reason: null, check: null, failures: emptyFailures(EGRESS_FAILURE_WINDOW_MS), checkedAt: null };
    }
    const summary = failures.summarize(now());
    const { recentRefused: _recentRefused, recentRefusedViaUpstream: _viaUpstream, ...publicFailures } = summary;
    const { state, reason } = currentState(summary);
    const running = effective?.running === true;
    return {
      mode: running && EFFECTIVE_MODES.has(effective.mode) ? effective.mode : null,
      upstream: running && typeof effective.upstream === "string" ? effective.upstream : null,
      state,
      reason,
      check: checkTarget !== null && lastCheck ? { ...lastCheck } : null,
      failures: publicFailures,
      checkedAt,
    };
  }

  return { start, stop, checkNow, noteSupervisorMessage, snapshot };
}
