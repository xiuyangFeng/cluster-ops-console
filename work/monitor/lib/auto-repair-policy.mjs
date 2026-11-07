// L2 自动修复策略（纯函数、无 IO、无计时器）：把"什么时候该自动修"这件事
// 从 monitor-server 的接线里剥出来，做成可单测的规则表。
// 设计：docs/superpowers/specs/2026-09-02-multi-tunnel-team-hub-design.md §6.7
//
// 分层边界（用户已拍板，本模块不得放宽）：
//   L1 = 只读复核（强制跑探针），L2 = 本机有副作用（重启本机通道进程），
//   L3 = 远端动作（一律人工确认），L4 = 永不自动。
// 因此本模块只产出三类动作：force-probes（L1）、restart-tunnel 与 restart-channel（L2）。
// restart-tunnel（v2.64）= 只重启一台服务器的隧道（界面「重启这条隧道」同一条通路，
// supervisor、本地代理与其它隧道都不动）；只有说不清坏在哪一条、或不止一条坏时才 restart-channel。
// 孤儿隧道认领同属 L2，但它的判定材料只在 supervisor 进程里（进程命令行签名、
// rootDir 比对），放这里等于把 supervisor 状态搬过来——所以那条规则在 supervisor
// 内实现，本模块只把限频（createRateLimiter）与开关（isRuleEnabled）原语导出去复用，
// 保证"每服务器 5 分钟 1 次"和这里的限频是同一套语义、同一份配置。
//
// 本模块只描述"意图"，不执行任何东西：动作对象里没有命令串、没有回调，
// 接线层拿到 kind 后映射到既有的封闭 API（autoRepairChannel / forceRun）。
// 这是设计 §8 "自动修复动作集合封闭、没有执行任意命令的通路"的落点。

import { collectSlowProbeId, LOG_SIGNALS_PROBE_ID, PROCESSES_PROBE_ID } from "./probe-ids.mjs";

// ---- 阈值常量（集中放置，规则表与测试都引用同一份口径） ----

// 挂钟跳变阈值：与 supervisor 侧的休眠检测同为 90s，跨平台不依赖 Electron powerMonitor。
const WAKE_GAP_THRESHOLD_MS = 90_000;
// 通道断开需要持续多久才自动重启：短于此的断开多半是探针抖动/一次性超时，
// 自动重启反而制造噪声（重启本身会让通道短暂不可用）。
const CHANNEL_DOWN_SUSTAIN_MS = 30_000;
// 两次自动动作之间的最小间隔：一轮修复要几秒才能反映到下一拍探针上，
// 冷却短于此会在结果落地前重复出手。
const DEFAULT_COOLDOWN_MS = 60_000;
// 自动修复预算窗口：10 分钟内修不好就不是自动能解决的问题，交人工。
const REPAIR_WINDOW_MS = 600_000;
// 分诊里"通道断开"的 rootCause 取值。注意：设计文档写的是 "channel-down"，
// 但 signal-triage.mjs 的规则表里实际取值是 "channel"——以代码为准，
// 写错这个字符串的后果是规则永不触发且没有任何报错。
const CHANNEL_DOWN_ROOT_CAUSE = "channel";
// lastActions 只留最近 20 条：给控制台"最近自动动作"面板用，不是审计日志
// （审计走 ops 日志），无需无限增长。
const LAST_ACTIONS_LIMIT = 20;
// 单个限频 key 保留的时间戳上限：allow() 会按窗口裁剪，但 record() 可能在没人
// 调 allow 的情况下反复被调用（比如 supervisor 侧只 record 不 allow），加个硬顶防泄漏。
const RATE_LIMITER_MAX_HITS = 100;

// ---- 规则表（数据结构，追加规则 = 追加一条） ----
// detect(view) → trigger | null：trigger 携带 reason（人话解释），evaluate 会把它
//   透传进 Action.reason，让日志与时间线不用再拼一遍。
// action(view, trigger) → { kind, payload }：只描述意图；ruleId/tier/observeOnly/reason
//   由 evaluate 统一补齐，规则里写不了也改不了这些护栏字段。

export const AUTO_REPAIR_RULES = [
  {
    id: "wake-recheck",
    tier: "L1",
    title: "唤醒后强制复核",
    cooldownMs: DEFAULT_COOLDOWN_MS,
    // 只读动作，没有副作用，不设窗口上限——机器一天合盖十次就该复核十次。
    maxPerWindow: Number.POSITIVE_INFINITY,
    windowMs: REPAIR_WINDOW_MS,
    detect(view) {
      if (!(view.wakeGapMs > WAKE_GAP_THRESHOLD_MS)) return null;
      const gapSec = Math.round(view.wakeGapMs / 1000);
      const thresholdSec = WAKE_GAP_THRESHOLD_MS / 1000;
      return {
        reason: `挂钟跳变 ${gapSec}s（阈值 ${thresholdSec}s），疑似休眠唤醒，强制复核关键探针`,
        wakeGapMs: view.wakeGapMs,
      };
    },
    action(view) {
      // 唤醒后最不可信的三件事：本机进程还在不在、日志里有没有堆积的错、
      // 活跃服务器那边还通不通。overrideBreaker 是必须的——休眠期间探针大概率
      // 已经连续失败触发熔断，不覆盖就复核不到。
      const probeIds = [PROCESSES_PROBE_ID, LOG_SIGNALS_PROBE_ID];
      // 没有活跃服务器时不拼 "collect:slow:"（半截 id 在调度器里找不到探针，
      // 只会白跑一次 forceRun 并留下误导性日志）。
      if (view.activeServerId) probeIds.push(collectSlowProbeId(view.activeServerId));
      return { kind: "force-probes", payload: { probeIds, overrideBreaker: true } };
    },
  },
  {
    id: "channel-down-restart",
    tier: "L2",
    title: "通道断开自动重启（只修坏的那条）",
    cooldownMs: DEFAULT_COOLDOWN_MS,
    // 10 分钟 2 次：足够覆盖"一次没修好再来一次"，又不会在真故障时无限重启。
    maxPerWindow: 2,
    windowMs: REPAIR_WINDOW_MS,
    detect(view) {
      // 还没领反向端口（通道层 setupPending）：隧道本来就不会建，重启通道修不好它，只会每 10 分钟
      // 白重启两次、再把"已达上限"顶到注意力队列。分诊此时归 setup（不是 channel），这里再挡一道：
      // 哪怕是标记出现之前分诊的旧信号，也不对没端口的通道出手。
      if (view.setupPending) return null;
      const triage = view.triage;
      if (!triage || triage.rootCause !== CHANNEL_DOWN_ROOT_CAUSE) return null;
      if (!Number.isFinite(triage.since)) return null;
      const downForMs = view.now - triage.since;
      if (!(downForMs >= CHANNEL_DOWN_SUSTAIN_MS)) return null;
      // 本机 supervisor / 代理不在时，断开的根因在本机进程层，走既有的
      // autoRepairChannel 5s 巡检拉起就行；此时重启通道属于"前提不成立的动作"，
      // 只会白烧一次预算。
      if (!view.processes.supervisorUp || !view.processes.localProxyUp) return null;
      const scope = pickRestartScope(view);
      const downSec = Math.round(downForMs / 1000);
      return {
        reason: scope.kind === "restart-tunnel"
          ? `分诊判定通道断开且已持续 ${downSec}s，只重启 ${scope.serverId} 的隧道（本地代理与其它隧道不动）`
          : `分诊判定通道断开且已持续 ${downSec}s，执行一键修复`,
        downForMs,
        scope,
      };
    },
    action(_view, trigger) {
      if (trigger?.scope?.kind === "restart-tunnel") {
        return { kind: "restart-tunnel", payload: { serverId: trigger.scope.serverId } };
      }
      // force:true = 一键修复四步（与人工点"修复"同一条通路），
      // 接线层负责补 trigger:"auto" 与 ruleId 字段。
      return { kind: "restart-channel", payload: { force: true } };
    },
  },
];

const RULES_BY_ID = new Map(AUTO_REPAIR_RULES.map((rule) => [rule.id, rule]));

// 只修坏的那条（v2.64）：重启整个通道会先停 supervisor，连带把健康的隧道一起断掉
// （2026-10-14 15:47 阿里云隧道好好的，跟着主集群那条一起被断）。本地代理在、坏的隧道
// 恰好一条 → 只重启那一条；多条都坏、或通道断了却说不清是哪条（视图里没有隧道明细）→ 整个通道。
// 本地代理挂了的情形 detect 已经挡掉（交给 supervisor 自己拉起），这里再判一次只为自洽。
// 规则可能被直接拿原始视图调用（单测），缺 tunnels 按空表处理。
function pickRestartScope(view) {
  const bad = (Array.isArray(view.tunnels) ? view.tunnels : []).filter((tunnel) => tunnel?.state === "bad");
  if (view.processes?.localProxyUp === true && bad.length === 1) {
    return { kind: "restart-tunnel", serverId: bad[0].serverId };
  }
  return { kind: "restart-channel" };
}

// ---- 配置 ----

export const DEFAULT_AUTO_REPAIR_CONFIG = Object.freeze({
  enabled: true,
  observeOnly: false,
  rules: Object.freeze({
    "channel-down-restart": true,
    // 本模块不实现这条（在 supervisor 内），但开关归属配置层，
    // 默认表里必须有它，否则前端渲染开关列表会漏一项。
    "orphan-tunnel-adopt": true,
    // 换网后结束本机自己的残留隧道会话（supervisor 内实现，见 lib/supervisor/tunnel-controller）。
    "stale-session-reclaim": true,
    "wake-recheck": true,
  }),
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 与默认深合并；任何类型不对的字段单独回落默认，绝不因为一个坏字段丢掉整份配置
// （配置来自 config.local.json，用户手写，坏一个键就静默关掉自动修复是最坏的失败模式）。
export function normalizeAutoRepairConfig(raw) {
  const src = isPlainObject(raw) ? raw : {};
  const rules = { ...DEFAULT_AUTO_REPAIR_CONFIG.rules };
  if (isPlainObject(src.rules)) {
    for (const [id, value] of Object.entries(src.rules)) {
      // 未知规则 id 的布尔开关照收：配置可以先于规则实现下发。
      if (typeof value === "boolean") rules[id] = value;
    }
  }
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_AUTO_REPAIR_CONFIG.enabled,
    observeOnly:
      typeof src.observeOnly === "boolean" ? src.observeOnly : DEFAULT_AUTO_REPAIR_CONFIG.observeOnly,
    rules,
  };
}

// 总开关 + 单规则开关。未列出的规则按启用处理（新规则上线不需要先改配置）。
export function isRuleEnabled(config, ruleId) {
  const cfg = normalizeAutoRepairConfig(config);
  if (!cfg.enabled) return false;
  return cfg.rules[ruleId] !== false;
}

// ---- 限频原语（策略层与 supervisor 的孤儿认领共用一套语义） ----
//
// 两道闸：cooldownMs（两次之间的最小间隔）与 maxPerWindow/windowMs（滑动窗口预算）。
// allow() 只判定不记账，record() 才记账——因为调用方可能在 allow 之后还有别的
// 前置条件要过（比如策略层的规则开关），记账必须发生在真正产出动作那一刻。
export function createRateLimiter({ now = Date.now } = {}) {
  const buckets = new Map(); // key → { lastAt, hits: number[] }

  function bucket(key) {
    let entry = buckets.get(key);
    if (!entry) {
      entry = { lastAt: null, hits: [] };
      buckets.set(key, entry);
    }
    return entry;
  }

  function prune(entry, at, windowMs) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return;
    const floor = at - windowMs;
    // 时间戳按记录顺序单调递增，从头砍即可；挂钟回拨会让 hits 显得"过新"，
    // 后果只是多留一会儿预算，比错误放行安全。
    while (entry.hits.length > 0 && entry.hits[0] <= floor) entry.hits.shift();
  }

  function allow(key, { cooldownMs = 0, maxPerWindow = Number.POSITIVE_INFINITY, windowMs = 0 } = {}) {
    const at = now();
    const entry = bucket(key);
    prune(entry, at, windowMs);
    const remaining = Number.isFinite(maxPerWindow)
      ? Math.max(0, maxPerWindow - entry.hits.length)
      : Number.POSITIVE_INFINITY;

    // 窗口上限先于冷却判定：两者同时不满足时，"预算耗尽"才是需要升级人工的
    // 那个事实；先报 cooldown 会把升级推迟一个冷却周期，用户干等。
    if (remaining <= 0) return { ok: false, reason: "window-exhausted", remaining: 0 };
    if (entry.lastAt !== null && cooldownMs > 0 && at - entry.lastAt < cooldownMs) {
      return { ok: false, reason: "cooldown", remaining };
    }
    return { ok: true, remaining };
  }

  function record(key) {
    const at = now();
    const entry = bucket(key);
    entry.lastAt = at;
    entry.hits.push(at);
    if (entry.hits.length > RATE_LIMITER_MAX_HITS) entry.hits.shift();
    return at;
  }

  // 退回最近一笔记账（v2.64）：记了账、却在真正动手前放弃的动作，既不占窗口预算也不留冷却。
  // 冷却基准回到上一笔（没有就清空）。没有可退的返回 false。
  function refund(key) {
    const entry = buckets.get(key);
    if (!entry || entry.hits.length === 0) return false;
    entry.hits.pop();
    entry.lastAt = entry.hits.length > 0 ? entry.hits[entry.hits.length - 1] : null;
    return true;
  }

  function reset(key) {
    if (key === undefined) buckets.clear();
    else buckets.delete(key);
  }

  return { allow, record, refund, reset };
}

// ---- 视图归一化 ----
// 缺字段一律归位为"无证据 / 不允许动作"，让规则只面对干净的形状，
// 同时保证 evaluate 对残缺 view 绝不抛错（它挂在 STATUS_CHANGED 事件上，
// 抛一次就可能拖垮事件分发）。

function normalizeView(raw, at) {
  const view = isPlainObject(raw) ? raw : {};
  const processes = isPlainObject(view.processes) ? view.processes : {};
  const triage = isPlainObject(view.triage) ? view.triage : null;
  return {
    now: at,
    // 缺省视为 false：没有"该运行"的证据时不做任何有副作用的事（fail-safe）。
    shouldBeRunning: view.shouldBeRunning === true,
    repairInFlight: view.repairInFlight === true,
    // 通道层"配置未完成（没领端口）"标记；缺省 false（旧调用方语义不变）。
    setupPending: view.setupPending === true,
    activeServerId: typeof view.activeServerId === "string" ? view.activeServerId : "",
    triage: triage
      ? {
          rootCause: typeof triage.rootCause === "string" ? triage.rootCause : "",
          since: Number.isFinite(triage.since) ? triage.since : Number.NaN,
        }
      : null,
    processes: {
      supervisorUp: processes.supervisorUp === true,
      localProxyUp: processes.localProxyUp === true,
    },
    // 各条隧道当前的级别（v2.64，决定只重启哪一条）：error 记为坏、ok 记为好，其余（等待 / 未知）
    // 两头都不算。缺省空表 = 说不清哪条坏，回落重启整个通道（旧调用方语义不变）。
    tunnels: Array.isArray(view.tunnels)
      ? view.tunnels
          .filter((tunnel) => isPlainObject(tunnel) && typeof tunnel.serverId === "string" && tunnel.serverId !== "")
          .map((tunnel) => ({
            serverId: tunnel.serverId,
            state: tunnel.level === "error" ? "bad" : tunnel.level === "ok" ? "ok" : "other",
          }))
      : [],
    wakeGapMs: Number.isFinite(view.wakeGapMs) ? view.wakeGapMs : 0,
  };
}

// ---- 策略实例 ----

export function createAutoRepairPolicy({ config, now = Date.now, log = () => {} } = {}) {
  let cfg = normalizeAutoRepairConfig(config);
  const limiter = createRateLimiter({ now });
  const lastActions = [];

  // 产出一条动作：进 lastActions（控制台"最近自动动作"）并落 ops 日志。
  function noteAction(action, at) {
    lastActions.push({ ...action, at, ok: null });
    while (lastActions.length > LAST_ACTIONS_LIMIT) lastActions.shift();
    try {
      log({
        level: "info",
        event: "auto-repair",
        ruleId: action.ruleId,
        kind: action.kind,
        mode: action.observeOnly ? "observe" : "execute",
        reason: action.reason,
        ...(typeof action.payload?.serverId === "string" ? { serverId: action.payload.serverId } : {}),
      });
    } catch {
      // 日志下游（ops 日志、SSE）出问题绝不能反噬策略：动作照产出。
    }
  }

  function evaluate(rawView) {
    // view.now 是"这拍快照的时刻"，用于与 triage.since 做差（两者必须同一时间轴）；
    // 限频用的是注入的 now()，即真实当下。快照略陈旧时不该让预算跟着倒退。
    const at = Number.isFinite(rawView?.now) ? rawView.now : now();
    const view = normalizeView(rawView, at);

    // 护栏在规则之前，且不消耗任何限频预算——通道被用户手动停掉的这段时间里，
    // 不该把 10 分钟 2 次的修复预算烧光，否则用户一开机就已经"达到上限"。
    if (!cfg.enabled) return [];
    if (!view.shouldBeRunning) return [];
    if (view.repairInFlight) return [];

    const actions = [];
    for (const rule of AUTO_REPAIR_RULES) {
      if (!isRuleEnabled(cfg, rule.id)) continue;

      let trigger = null;
      try {
        trigger = rule.detect(view);
      } catch {
        // 规则自身抛错按未命中处理（与 signal-triage 同策略）：
        // 一条坏规则不能让整轮评估失效。
        continue;
      }
      if (!trigger) continue;

      const limits = { cooldownMs: rule.cooldownMs, maxPerWindow: rule.maxPerWindow, windowMs: rule.windowMs };
      const verdict = limiter.allow(rule.id, limits);
      if (!verdict.ok) {
        if (verdict.reason === "window-exhausted") {
          const escalation = maybeEscalate(rule, at);
          if (escalation) actions.push(escalation);
        }
        continue;
      }

      let intent = null;
      try {
        intent = rule.action(view, trigger);
      } catch {
        continue;
      }
      if (!isPlainObject(intent) || typeof intent.kind !== "string") continue;

      const action = {
        ruleId: rule.id,
        tier: rule.tier,
        kind: intent.kind,
        payload: isPlainObject(intent.payload) ? intent.payload : {},
        observeOnly: cfg.observeOnly,
        reason: typeof trigger.reason === "string" ? trigger.reason : rule.title,
      };
      // 观察模式也记账：不然打开 observeOnly 观察一天，日志里的节奏与真实
      // 执行时的节奏对不上，观察就失去了意义。
      limiter.record(rule.id);
      noteAction(action, at);
      actions.push(action);
    }
    return actions;
  }

  // 预算耗尽 → 给接线层一条"该人工了"的条目（进注意力队列置顶）。
  // 单独一个限频 key 做去重：窗口内只报一次，否则每拍探针都会推一条。
  function maybeEscalate(rule, at) {
    const key = `${rule.id}:escalate`;
    const verdict = limiter.allow(key, { cooldownMs: 0, maxPerWindow: 1, windowMs: rule.windowMs });
    if (!verdict.ok) return null;
    limiter.record(key);
    const action = {
      ruleId: rule.id,
      tier: rule.tier,
      kind: "escalate",
      payload: {},
      observeOnly: cfg.observeOnly,
      escalate: true,
      reason: "auto repair limit reached",
    };
    noteAction(action, at);
    return action;
  }

  // 接线层执行完动作后回填结果（lastActions 的 ok / executedAt）。
  function markExecuted(action, ok) {
    const ruleId = isPlainObject(action) ? action.ruleId : null;
    if (typeof ruleId !== "string" || ruleId === "") return;
    const at = now();
    const success = ok !== false;
    // 回填到最近一条同 ruleId+kind 的记录上（同一轮 evaluate 产出的那条）。
    for (let i = lastActions.length - 1; i >= 0; i -= 1) {
      if (lastActions[i].ruleId === ruleId && lastActions[i].kind === action.kind) {
        lastActions[i].ok = success;
        lastActions[i].executedAt = at;
        break;
      }
    }
  }

  // 执行前复核（v2.64）：接线层在真正动手（停进程）之前，拿最新视图把同一条规则的判据再跑一遍。
  // 不碰限频、不写日志。{ ok:false, reason } 时接线层放弃执行并 refund：
  //   recovered —— 已经不需要修了（通道已恢复 / 要重启的那条隧道已经好了）；
  //   busy      —— 别的修复已在进行（用户手动重启、单隧道操作在飞）；
  //   stopped / disabled / precondition-changed —— 通道被停、规则被关、前提变了（如本地代理没了）。
  // 认不出的动作一律放行（不比 evaluate 多拦任何东西）。
  function recheck(action, rawView) {
    const rule = isPlainObject(action) ? RULES_BY_ID.get(action.ruleId) : null;
    if (!rule) return { ok: true };
    const view = normalizeView(rawView, Number.isFinite(rawView?.now) ? rawView.now : now());
    if (!isRuleEnabled(cfg, rule.id)) return { ok: false, reason: "disabled" };
    if (!view.shouldBeRunning) return { ok: false, reason: "stopped" };
    if (view.repairInFlight) return { ok: false, reason: "busy" };
    let trigger = null;
    try {
      trigger = rule.detect(view);
    } catch {
      trigger = null;
    }
    if (!trigger) {
      // 视图里已没有通道断开的分诊（接线层在通道离开 error 时就不再给 triage）= 已恢复。
      const stillTriaged = view.triage?.rootCause === CHANNEL_DOWN_ROOT_CAUSE;
      return { ok: false, reason: stillTriaged ? "precondition-changed" : "recovered" };
    }
    if (action.kind === "restart-tunnel") {
      const target = view.tunnels.find((tunnel) => tunnel.serverId === action.payload?.serverId);
      if (target?.state !== "bad") return { ok: false, reason: "recovered" };
    }
    return { ok: true };
  }

  // 接线层放弃了 evaluate 刚产出的动作（复核不过 / 执行器忙）：退回那一笔限频记账
  // （不计入窗口上限、不留冷却），lastActions 里那条标 skipped。
  function refund(action, reason = "skipped") {
    const ruleId = isPlainObject(action) ? action.ruleId : null;
    if (typeof ruleId !== "string" || ruleId === "") return false;
    const refunded = limiter.refund(ruleId);
    for (let i = lastActions.length - 1; i >= 0; i -= 1) {
      const entry = lastActions[i];
      if (entry.ruleId === ruleId && entry.kind === action.kind && entry.ok === null && !entry.skipped) {
        entry.skipped = String(reason);
        entry.skippedAt = now();
        break;
      }
    }
    return refunded;
  }

  function setConfig(next) {
    // 只换配置，不重置限频：切换 observeOnly / 开关不该成为绕过预算的手段。
    cfg = normalizeAutoRepairConfig(next);
  }

  function getState() {
    return {
      config: { ...cfg, rules: { ...cfg.rules } },
      lastActions: lastActions.map((entry) => ({ ...entry })),
    };
  }

  return { evaluate, recheck, refund, markExecuted, setConfig, getState };
}
