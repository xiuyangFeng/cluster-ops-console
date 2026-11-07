// 同账号多台 Mac 的隧道接力（v2.88）：待命状态、看对方、接管。远端脚本与解析在 sibling-tunnel.mjs。
//
// 每个隧道控制器一个实例。控制器只在两处问它：
//   - 要建隧道、却发现远端端口已经有人在听（ensure 冷启动 / 断线后，或 ssh 报端口被占）→ resolve()；
//   - 用户点了「让这台承载」→ takeOver()。
// 它不碰本机进程、不管退避：给出判定（none / standby / took-over / …）与建议的复查间隔，由控制器落到
// 自己的退避与 emitStage 上。
//
// 判定规则（同一时刻只有一台承载，绝不来回抢）：
//   - 端口上没有另一台 Mac 的会话 → none（交回原有流程：本机残留会话回收 / 异己占用长退避）；
//   - 有，且经端口打得通对方的代理 → standby，30 秒后再看；
//   - 有，但连续两次打不通（对方睡着 / 断网，会话还挂在服务器上）→ 结束对方会话并接管（自动，限频）；
//   - 集群上没有 curl 判断不了 → 当对方活着，待命。
// 自动接管受 autoRepair 管：规则 sibling-handover 可单独关；observeOnly 只记日志不动手。
// 用户手动接管不受这两项限制（那是用户明确的指令）。
import { isRuleEnabled } from "../auto-repair-policy.mjs";
import {
  buildSiblingSurveyCommand,
  buildSiblingTakeoverCommand,
  describeHolder,
  parseSiblingSurvey,
  parseSiblingTakeover,
} from "./sibling-tunnel.mjs";

export const SIBLING_HANDOVER_RULE_ID = "sibling-handover";
// 对方活着时的复查间隔：待命期间每 30 秒一次 SSH（只读查看 + 一次 4 秒的 curl）。
export const STANDBY_RECHECK_MS = 30_000;
// 对方第一次打不通后，10 秒后再确认一次；连续两次才接管，单次抖动不动手。
export const SIBLING_DEAD_RECHECK_MS = 10_000;
export const SIBLING_DEAD_STRIKES = 2;
// 被接力（读到让位通知）后，10 秒后看一眼接管方是否真的接上了；没接上（端口空着）就自己连回去。
export const YIELD_RECHECK_MS = 10_000;
const SURVEY_TIMEOUT_MS = 15_000;
const TAKEOVER_TIMEOUT_MS = 15_000;
// 自动接管是有副作用的远端动作：两次之间至少 30 秒，10 分钟内最多 4 次。
const AUTO_TAKEOVER_COOLDOWN_MS = 30_000;
const AUTO_TAKEOVER_WINDOW_MS = 600_000;
const AUTO_TAKEOVER_MAX_PER_WINDOW = 4;

export function createSiblingHandover({
  runRemote, // (config, command, { timeoutMs }) => { code, stdout, stderr, timedOut }
  log = () => {},
  now = Date.now,
  // 账本事件（type: "handover"）：承载 / 待命的切换记录。
  onEvent = () => {},
  rateLimiter,
  machineLabel = "Mac",
  name = "tunnel",
} = {}) {
  // { since, reason, holder: { ownerId, label, heldSec } | null, health, checkedAt }
  let standby = null;
  let deadStrikes = 0;

  function serverIdOf(config) {
    return config?.id ?? config?.serverId ?? null;
  }

  function emitEvent(event) {
    try {
      onEvent(event);
    } catch {}
  }

  function getStandby() {
    if (!standby) return null;
    return {
      since: standby.since,
      reason: standby.reason,
      holder: standby.holder ? { ...standby.holder } : null,
      health: standby.health ?? null,
      checkedAt: standby.checkedAt ?? null,
    };
  }

  function enter(config, { reason, holder = null, health = null }) {
    const first = !standby;
    standby = {
      since: standby?.since ?? now(),
      reason,
      holder: holder || standby?.holder || null,
      health,
      checkedAt: now(),
    };
    if (first) {
      const peer = standby.holder?.label || null;
      log(`remote port ${config?.remotePort} on ${config?.host} is carried by another Mac of this account${peer ? ` (${peer})` : ""}; this Mac stands by`, {
        event: "tunnel-standby",
        serverId: serverIdOf(config),
        reason,
        peer,
      });
      emitEvent({ type: "handover", role: "standby", serverId: serverIdOf(config), host: config?.host ?? null, at: now(), reason, peer: peer || undefined });
    }
  }

  // 离开待命（本机接上了 / 端口空了）。只清状态；「本机承载」的账本行由 takeOver 或隧道 up 行表达。
  function leave() {
    standby = null;
    deadStrikes = 0;
  }

  async function survey(config, marker) {
    let result;
    try {
      result = await runRemote(config, buildSiblingSurveyCommand({ marker, label: machineLabel }), { timeoutMs: SURVEY_TIMEOUT_MS });
    } catch {
      return null;
    }
    if (result?.code !== 0 || result.timedOut) return null;
    return parseSiblingSurvey(result.stdout);
  }

  // 结束另一台 Mac 在这个端口上的会话。reason: manual（用户点的）/ unresponsive（对方连续打不通）。
  async function takeOver(config, marker, { reason = "manual", holder = null } = {}) {
    let result;
    try {
      result = await runRemote(config, buildSiblingTakeoverCommand({ marker, label: machineLabel }), { timeoutMs: TAKEOVER_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const parsed = result && result.code === 0 && !result.timedOut ? parseSiblingTakeover(result.stdout) : null;
    if (!parsed) {
      const why = `ssh code ${result?.code ?? "?"}${result?.timedOut ? ", timed out" : ""}`;
      log(`taking over remote port ${config?.remotePort} on ${config?.host} from another Mac failed (${why})`, {
        level: "warn", event: "tunnel-handover-takeover", serverId: serverIdOf(config), result: "error", reason,
      });
      return { ok: false, reason: why };
    }
    const peer = holder?.label || standby?.holder?.label || null;
    leave();
    if (parsed.found > 0) {
      log(`took over remote port ${config?.remotePort} on ${config?.host} from another Mac of this account${peer ? ` (${peer})` : ""}: ${reason}`, {
        event: "tunnel-handover-takeover",
        serverId: serverIdOf(config),
        reason,
        peer,
        found: parsed.found,
        ended: parsed.ended,
      });
      emitEvent({ type: "handover", role: "active", serverId: serverIdOf(config), host: config?.host ?? null, at: now(), reason, peer: peer || undefined });
    }
    return { ok: true, found: parsed.found, ended: parsed.ended, peer };
  }

  // 端口有人在听、本机没有自己的隧道时调用。返回 { verdict, recheckMs? }：
  //   none        端口上没有另一台 Mac 的会话，交回原有流程
  //   standby     另一台 Mac 在承载，recheckMs 后再看
  //   took-over   对方连续打不通，已结束对方会话，可以立刻建隧道
  //   error       没查成（SSH 失败 / 输出不完整），交回原有流程
  //   disabled    规则关着，交回原有流程
  async function resolve(config, marker, { autoRepair = null } = {}) {
    if (!marker) return { verdict: "none" };
    if (!isRuleEnabled(autoRepair, SIBLING_HANDOVER_RULE_ID)) {
      leave();
      return { verdict: "disabled" };
    }
    const found = await survey(config, marker);
    if (!found) return { verdict: "error" };
    if (!found.siblings.length) {
      leave();
      return { verdict: "none" };
    }
    const holder = describeHolder(found.siblings);
    if (found.health !== "dead") {
      deadStrikes = 0;
      enter(config, { reason: standby?.reason === "yielded" ? "yielded" : "holder-active", holder, health: found.health });
      return { verdict: "standby", recheckMs: STANDBY_RECHECK_MS, holder };
    }
    deadStrikes += 1;
    if (deadStrikes < SIBLING_DEAD_STRIKES) {
      enter(config, { reason: "holder-unresponsive", holder, health: "dead" });
      return { verdict: "standby", recheckMs: SIBLING_DEAD_RECHECK_MS, holder };
    }
    const limitKey = `handover:${serverIdOf(config) ?? name}`;
    const allowed = rateLimiter
      ? rateLimiter.allow(limitKey, { cooldownMs: AUTO_TAKEOVER_COOLDOWN_MS, maxPerWindow: AUTO_TAKEOVER_MAX_PER_WINDOW, windowMs: AUTO_TAKEOVER_WINDOW_MS })
      : { ok: true };
    if (!allowed.ok) {
      enter(config, { reason: "holder-unresponsive", holder, health: "dead" });
      return { verdict: "standby", recheckMs: STANDBY_RECHECK_MS, holder };
    }
    if (autoRepair?.observeOnly) {
      rateLimiter?.record(limitKey);
      log(`would take over remote port ${config?.remotePort} on ${config?.host} from an unresponsive Mac${holder?.label ? ` (${holder.label})` : ""}, observe mode only`, {
        level: "warn", event: "tunnel-handover-takeover", mode: "observe", serverId: serverIdOf(config),
      });
      enter(config, { reason: "holder-unresponsive", holder, health: "dead" });
      return { verdict: "standby", recheckMs: STANDBY_RECHECK_MS, holder };
    }
    rateLimiter?.record(limitKey);
    const taken = await takeOver(config, marker, { reason: "unresponsive", holder });
    if (!taken.ok) {
      enter(config, { reason: "holder-unresponsive", holder, health: "dead" });
      return { verdict: "standby", recheckMs: SIBLING_DEAD_RECHECK_MS, holder };
    }
    return { verdict: "took-over", holder };
  }

  // 本机隧道读到了让位通知：另一台 Mac 接管了，进入待命，YIELD_RECHECK_MS 后再看。
  function noteYielded(config) {
    log(`another Mac of this account took over remote port ${config?.remotePort} on ${config?.host}; this Mac stands by`, {
      event: "tunnel-handover-yielded",
      serverId: serverIdOf(config),
    });
    enter(config, { reason: "yielded" });
    return YIELD_RECHECK_MS;
  }

  return { resolve, takeOver, noteYielded, leave, getStandby, isStandby: () => Boolean(standby) };
}
