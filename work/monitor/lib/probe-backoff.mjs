// 探针退避：一台服务器 SSH 连不上时，它名下的周期探针不再各发各的，改为按退避节奏只放行一条探路的。
//
// 背景：控制面有 5 条不受通道熔断约束的 SSH 探针（log-signals 10s / collect:slow 60s / usage 60s /
// jobs 5min / cli 10min）。服务器不可达的几个小时里它们照常到期，每条都要等到超时才被杀——
// 一次 3 小时的故障会发出上千次必败的 SSH，还可能撞上服务器的登录限速。
//
// 判据只看 SSH 本身通没通（见 classifySshTransport），绝不看通道红绿：通道的端口结论本来就来自
// 这些探针，拿通道状态决定探不探是死锁的形状（探针停 → 结论不更新 → 永远不恢复）。
// 这里每台主机永远有一个有限的「下次探测时刻」，任何一次成功立即清零。
//
// 节奏：首次失败起 graceMs 内一切照旧（短暂抖动的发现速度不变）；之后每次探路失败把下一次推后
// 10 → 20 → 40 → 80 秒，封顶 120 秒，每步 ±20% 抖动。清零后被按住的探针随机错开 0–15 秒恢复。
//
// 纯逻辑：没有定时器、没有 IO。时钟 / 随机数 / 网络地址变化检测都由外面注入；调度器每拍调 beat()，
// 发探针前调 nextCanary() / admit()，探针的物理执行结算后调 settle()；SSH 执行层调 observe()。

export const PROBE_BACKOFF_RULE_ID = "probe-backoff";
export const BACKOFF_GRACE_MS = 30_000;
export const BACKOFF_STEPS_MS = Object.freeze([10_000, 20_000, 40_000, 80_000]);
export const BACKOFF_CAP_MS = 120_000;
export const BACKOFF_JITTER_RATIO = 0.2;
export const BACKOFF_RESUME_SPREAD_MS = 15_000;
// 两拍间隔超过它即判为休眠唤醒（与自动修复 / supervisor 同一个 90 秒）。
export const BACKOFF_WAKE_GAP_MS = 90_000;
export const BACKOFF_NETWORK_CHECK_MS = 5_000;
// 下次探测时刻过去这么久仍没有新的失败：说明这台主机名下已经没有会发 SSH 的探针了
// （服务器被删 / 探针全被门控），状态作废，免得界面一直挂着「已放慢探测」。
export const BACKOFF_STALE_MS = 5 * 60_000;
// 宽限期内两次失败相隔超过它：中间那段说明不了是不是一直连不上，按新的一轮故障重新起算宽限期。
export const BACKOFF_EPISODE_GAP_MS = 5 * 60_000;

// 一次 ssh 执行的结果说明了什么：
//   "fail" —— ssh 自己没连上：退出码 255（ssh 保留给自身错误）或被超时杀掉，且远端一个字节都没回；
//   "ok"   —— 远端有输出，或命令正常退出：连得上；
//   null   —— 说明不了（本机 spawn 失败、远端命令无输出地以 1–254 退出）。
export function classifySshTransport(result) {
  if (!result || typeof result !== "object") return null;
  const hasOutput = typeof result.stdout === "string" && result.stdout.trim() !== "";
  if (hasOutput || result.code === 0) return "ok";
  if (result.timedOut === true || result.code === 255) return "fail";
  return null;
}

// 开关：环境变量优先（1/true/on 开，0/false/off 关），否则看配置。
// v2.64 起默认开（v2.61–v2.63 默认关，在发布方电脑上试运行两天：进入退避 14 次、恢复 13 次，
// 一次 6.8 小时的故障只发了 227 次失败的 SSH）。只有两种情况关：自动修复总开关关着
// （autoRepair.enabled === false），或规则显式写了 autoRepair.rules["probe-backoff"] === false。
export function isProbeBackoffEnabled({ env = {}, config = null } = {}) {
  const raw = String(env?.CODEX_MONITOR_PROBE_BACKOFF ?? "").trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  if (["0", "false", "off", "no"].includes(raw)) return false;
  const autoRepair = config?.autoRepair;
  if (autoRepair && typeof autoRepair === "object") {
    if (autoRepair.enabled === false) return false;
    if (autoRepair.rules?.[PROBE_BACKOFF_RULE_ID] === false) return false;
  }
  return true;
}

export function createProbeBackoff({
  now = Date.now,
  rng = Math.random,
  enabled = false,
  graceMs = BACKOFF_GRACE_MS,
  stepsMs = BACKOFF_STEPS_MS,
  capMs = BACKOFF_CAP_MS,
  jitterRatio = BACKOFF_JITTER_RATIO,
  resumeSpreadMs = BACKOFF_RESUME_SPREAD_MS,
  wakeGapMs = BACKOFF_WAKE_GAP_MS,
  networkCheckMs = BACKOFF_NETWORK_CHECK_MS,
  staleMs = BACKOFF_STALE_MS,
  episodeGapMs = BACKOFF_EPISODE_GAP_MS,
  // () => 真值表示本机网络地址自上次调用以来变过（lib/supervisor/network-watch.mjs 的 check）。
  networkChanged = null,
  // ({ type: "enter" | "recover" | "reset", hostKey, ... }) 只在进入 / 离开退避、被整体重置时回调。
  onEvent = null,
} = {}) {
  let on = enabled === true;
  // hostKey -> { firstFailureAt, lastFailureAt, failures, level, nextProbeAt, canary, held:Set }
  // nextProbeAt === null 表示还在宽限期（一切照旧）；数字表示已在退避，到点才放行一条。
  const hosts = new Map();
  const resumeAt = new Map(); // probeId -> 最早恢复时刻（清零后错开）
  let lastBeatAt = null;
  let lastNetworkCheckAt = null;
  const counters = { holds: 0, canaries: 0, entered: 0, recovered: 0 };

  function emit(event) {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {}
  }

  function stepDelay(level) {
    const base = level < stepsMs.length ? stepsMs[level] : capMs;
    const jittered = Math.round(Math.min(base, capMs) * (1 + (rng() * 2 - 1) * jitterRatio));
    return Math.max(1000, jittered);
  }

  const inBackoff = (state) => Boolean(state) && state.nextProbeAt !== null;

  function drop(hostKey, { spread = false } = {}) {
    const state = hosts.get(hostKey);
    if (!state) return null;
    hosts.delete(hostKey);
    if (spread && inBackoff(state)) {
      const at = now();
      for (const probeId of state.held) resumeAt.set(probeId, at + Math.round(rng() * resumeSpreadMs));
    }
    return state;
  }

  // SSH 执行层的观察：verdict 取自 classifySshTransport。
  function observe(hostKey, verdict) {
    if (!on || !hostKey || !verdict) return;
    const at = now();
    if (verdict === "ok") {
      const state = drop(hostKey, { spread: true });
      if (inBackoff(state)) {
        counters.recovered += 1;
        emit({ type: "recover", hostKey, downMs: at - state.firstFailureAt, failures: state.failures });
      }
      return;
    }
    if (verdict !== "fail") return;
    let state = hosts.get(hostKey);
    if (!state) {
      state = { firstFailureAt: at, lastFailureAt: at, failures: 0, level: 0, nextProbeAt: null, canary: null, held: new Set() };
      hosts.set(hostKey, state);
    }
    if (state.nextProbeAt === null && at - state.lastFailureAt > episodeGapMs) {
      state.firstFailureAt = at;
      state.failures = 0;
    }
    state.failures += 1;
    state.lastFailureAt = at;
    if (at - state.firstFailureAt < graceMs) return;
    // 退避中、还没到下次探测时刻的失败是迟到的（闸门关上之前发出去的探针、手动动作）：不重复推后。
    if (state.nextProbeAt !== null && at < state.nextProbeAt) return;
    const entering = state.nextProbeAt === null;
    const delay = stepDelay(state.level);
    state.nextProbeAt = at + delay;
    state.level += 1;
    if (entering) {
      counters.entered += 1;
      emit({ type: "enter", hostKey, failures: state.failures, sinceMs: at - state.firstFailureAt, nextProbeAt: state.nextProbeAt });
    }
  }

  // 这台主机现在是否按住周期探针（退避中）。宽限期与无状态都不按。
  function isHolding(hostKey) {
    return on && inBackoff(hosts.get(hostKey));
  }

  // 现在可以放一条探路的主机（退避中、到点、没有在飞的探路探针）。
  function hostsAwaitingCanary() {
    if (!on) return [];
    const at = now();
    const out = [];
    for (const [hostKey, state] of hosts) {
      if (!inBackoff(state)) continue;
      if (at - state.nextProbeAt > staleMs && !state.canary) {
        hosts.delete(hostKey);
        continue;
      }
      if (!state.canary && at >= state.nextProbeAt) out.push(hostKey);
    }
    return out;
  }

  // 调度器登记「这条探针被按住了」（清零时据此错开恢复）。
  function hold(hostKey, probeId) {
    const state = hosts.get(hostKey);
    if (!state) return;
    if (!state.held.has(probeId)) counters.holds += 1;
    state.held.add(probeId);
  }

  // 调度器即将把 probeId 作为探路探针发出去。返回 false 表示不该发（已有探路的在飞 / 还没到点）。
  function admit(hostKey, probeId) {
    const state = hosts.get(hostKey);
    if (!on || !inBackoff(state)) return true;
    if (state.canary || now() < state.nextProbeAt) return false;
    state.canary = probeId;
    state.held.delete(probeId);
    counters.canaries += 1;
    return true;
  }

  // 探针的物理执行结算（SSH 子进程真的结束了）。探路探针没带回任何结论（比如它根本没发 SSH）时
  // nextProbeAt 仍在过去，下一拍换一条探针来探。
  function settle(hostKey, probeId) {
    const state = hosts.get(hostKey);
    if (state && state.canary === probeId) state.canary = null;
  }

  // 清零后错开恢复：周期调度在这个时刻之前不发这条探针（手动 / 事件触发的 forceRun 不受影响）。
  function isResumeDeferred(probeId) {
    const at = resumeAt.get(probeId);
    if (at === undefined) return false;
    if (now() >= at) {
      resumeAt.delete(probeId);
      return false;
    }
    return true;
  }

  // 有理由相信可能已经恢复（隧道进程稳住了 / 守护进程的隧道心跳）：下一拍就探一次，节奏不重置。
  function nudge(hostKey) {
    const state = hosts.get(hostKey);
    if (!on || !inBackoff(state)) return false;
    const at = now();
    if (state.nextProbeAt <= at) return false;
    state.nextProbeAt = at;
    return true;
  }

  // 环境变了（隧道刚建立 / 休眠唤醒 / 换网 / 配置变更）：下一拍就探，且退避阶梯从头开始。
  // 不直接删状态——那会把按住的探针一次全放出去，对面还没通的话又是一轮齐射。
  function reset(hostKey) {
    const state = hosts.get(hostKey);
    if (!on || !inBackoff(state)) return false;
    state.level = 0;
    state.nextProbeAt = now();
    return true;
  }

  function resetAll(reason) {
    let count = 0;
    for (const hostKey of hosts.keys()) if (reset(hostKey)) count += 1;
    if (count) emit({ type: "reset", reason, hosts: count });
    return count;
  }

  // 只保留仍在配置里的主机（服务器被删 / 改了地址）。
  function retain(hostKeys) {
    const keep = new Set(hostKeys || []);
    for (const hostKey of [...hosts.keys()]) if (!keep.has(hostKey)) hosts.delete(hostKey);
  }

  function clearAll() {
    hosts.clear();
    resumeAt.clear();
  }

  function setEnabled(value) {
    const next = value === true;
    if (on && !next) clearAll();
    on = next;
  }

  // 调度器每拍调用：挂钟跳变（休眠唤醒）与本机网络地址变化都让全部主机从头再探。
  function beat() {
    const at = now();
    const gap = lastBeatAt === null ? 0 : at - lastBeatAt;
    lastBeatAt = at;
    if (!on) return;
    for (const [probeId, until] of resumeAt) if (at >= until) resumeAt.delete(probeId);
    if (gap > wakeGapMs) resetAll("wake");
    if (networkChanged && (lastNetworkCheckAt === null || at - lastNetworkCheckAt >= networkCheckMs)) {
      lastNetworkCheckAt = at;
      let changed = false;
      try {
        changed = Boolean(networkChanged());
      } catch {}
      if (changed) resetAll("network");
    }
  }

  // 只读视图：退避中的主机（宽限期内的不算）。
  function getView() {
    const out = {};
    if (!on) return out;
    for (const [hostKey, state] of hosts) {
      if (!inBackoff(state)) continue;
      out[hostKey] = {
        since: state.firstFailureAt,
        nextProbeAt: state.nextProbeAt,
        failures: state.failures,
        probing: Boolean(state.canary),
      };
    }
    return out;
  }

  function getMetrics() {
    return { enabled: on, hosts: hosts.size, backedOff: Object.keys(getView()).length, deferred: resumeAt.size, ...counters };
  }

  return {
    isEnabled: () => on,
    setEnabled,
    observe,
    isHolding,
    hostsAwaitingCanary,
    hold,
    admit,
    settle,
    isResumeDeferred,
    nudge,
    reset,
    resetAll,
    retain,
    beat,
    getView,
    getMetrics,
  };
}
