// 提醒规则在一轮采集里的状态推进（v2.62，从 watch-service.mjs 拆出）：自动关注的名额与进出、自动组跟着规则增删、
// 「这一批已全部结束」、不属于任何关注组的失败提醒，以及手动 / 自动两类关注共用的几样小工具。
// 全是对 job-watch 数据（store.update 给的那份候选）的同步改动：不发 SSH、不读盘、不读时钟（时刻由调用方给）。
// 由 watch-service.mjs 在 jobs 探针那一轮与界面的写操作里调用；规则本身的纯函数在 watch-rules.mjs。
import { randomUUID } from "node:crypto";

import { FORENSICS_JOB_ID_RE } from "./forensics.mjs";
import { jobOutcome } from "./model.mjs";
import { AUTO_MAX_JOBS, createRuleMatcher, LONG_RUN_RULE, ruleKeys, ruleLabel, summarizeFailures } from "./watch-rules.mjs";
import { WATCH_MAX_GROUPS, WATCH_MAX_JOBS } from "./watch-store.mjs";

// 自动组同一种提醒的最短间隔：间隔内新出现的先不发、也不记「已提醒」，到点后与之后的合成一条。
// 临近时限等不了半小时（默认提前 30 分钟提醒），单独给 10 分钟。
export const AUTO_NOTIFY_GAP_MS = 30 * 60000;
export const AUTO_LIMIT_GAP_MS = 10 * 60000;
// 一条规则名下没有在跑 / 排队的作业并安静这么久，才算「这一批全部结束」（流水线两段之间的空当不算）。
export const AUTO_SETTLE_MS = 5 * 60000;
// 自动组里结束超过两天的作业不再留着（已不在作业采集的 48 小时窗口里）；两天没在作业记录里见到的同样放掉。
export const AUTO_KEEP_MS = 48 * 3600000;
// 自动组里没变化的作业隔这么久才更新一次「最近见到」，免得每分钟为一个时间戳重写文件。
const AUTO_SEEN_REFRESH_MS = 6 * 3600000;
// 同一台服务器两条失败提醒之间至少隔这么久：作业一结束探针就会被提前催一轮，一批作业接连失败时
// 一分钟就是一轮。头一个失败立刻提醒，间隔内接着失败的攒到下一条里。
export const FAIL_NOTIFY_GAP_MS = 10 * 60000;
// 头一轮建基线时往前让一小时：之后才冒出来、但结束在这之前的失败（那一轮没拿全）不算新的。
const FAIL_BASELINE_SLACK_MS = 3600000;
const FAIL_PENDING_MAX = 2000;
const NOTICE_JOB_IDS_MAX = 50;

// 以服务器 id 为键的表（settings / failures）一律按自有属性读写：id 可以是 constructor、toString、__proto__ 这类
// Object 原型上的名字——直接下标读会读到原型上的东西，给 __proto__ 赋值则是改原型而不是存一项。
export const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
export function setOwn(table, key, value) {
  Object.defineProperty(table, key, { value, enumerable: true, writable: true, configurable: true });
}

export const terminal = (job) => ["completed", "failed", "cancelled", "other"].includes(job?.outcome ?? jobOutcome(job));
export const jobState = (j, checkedAt) => ({ id: j.id, name: j.name || j.id, state: j.state, outcome: jobOutcome(j), checkedAt });
export const isAuto = (watch) => Boolean(watch.auto);
export const jobCount = (watches) => watches.reduce((sum, w) => sum + w.jobs.length, 0);

// 返回是否真的记下了一条（静音 / 没有作业时不记）。
export function notify(data, watch, kind, jobs, now, title, body) {
  if (watch.muted || !jobs.length) return false;
  data.notifications.push({ id: randomUUID(), serverId: watch.serverId, watchId: watch.id, kind, createdAt: now, title, body, jobIds: jobs.map((j) => j.id), readAt: null });
  return true;
}

// gapMs：这一类提醒的间隔。临近时限的由 limitGapMs 按提醒窗口给（见下），其余用 30 分钟。
export const autoHeld = (watch, kind, now, gapMs = AUTO_NOTIFY_GAP_MS) => isAuto(watch) && now - (watch.auto.notifiedAt?.[kind] || 0) < gapMs;
// 临近时限的间隔：平时 10 分钟；提醒窗口（limitMinutes，可设 1–1440）更短时取窗口的一半——
// 否则间隔还没过，后一个作业已经超时，它的提醒就永远发不出来了。
export const limitGapMs = (limitMinutes) => Math.min(AUTO_LIMIT_GAP_MS, Math.floor((limitMinutes * 60000) / 2));
export function autoSent(watch, kind, now) {
  if (isAuto(watch)) watch.auto.notifiedAt = { ...watch.auto.notifiedAt, [kind]: now };
}

// 把队列 / sacct 里的最新状态记到关注条目上。自动组里状态没变的隔几小时才动一次时间戳。
export function refreshItem(item, job, stamp, coarse) {
  const next = jobState(job, stamp);
  if (coarse && item.state === next.state && item.name === next.name && item.outcome === next.outcome && stamp - item.checkedAt < AUTO_SEEN_REFRESH_MS) return;
  Object.assign(item, next);
}

// ---- 自动关注的名额 ----

// 自动关注里该先放掉的一条：结束最久的；pressing（给手动关注腾地方）时再放不在跑的（收尾中之类）、最后才是在跑的。
function pickAutoVictim(data, { pressing = false } = {}) {
  const all = data.watches.filter(isAuto).flatMap((watch) => watch.jobs.map((item) => ({ watch, item })));
  const ended = all.filter((entry) => terminal(entry.item)).sort((a, b) => (a.item.endedAt ?? a.item.checkedAt) - (b.item.endedAt ?? b.item.checkedAt));
  if (ended.length) return ended[0];
  if (!pressing) return null;
  return all.find((entry) => entry.item.state !== "RUNNING") ?? all.at(-1) ?? null;
}

function dropAutoItem({ watch, item }) {
  watch.jobs = watch.jobs.filter((other) => other !== item);
}

// 再收一个自动关注的作业之前腾出名额：合计不超过 60 个，且只用手动关注剩下的；满了挤掉结束最久的，没有可挤的就不收。
function reserveAutoSlot(data) {
  const room = Math.min(AUTO_MAX_JOBS, WATCH_MAX_JOBS - jobCount(data.watches.filter((w) => !isAuto(w))));
  while (jobCount(data.watches.filter(isAuto)) >= room) {
    const victim = pickAutoVictim(data);
    if (!victim) return false;
    dropAutoItem(victim);
  }
  return room > 0;
}

// 手动关注撞总上限时先腾自动的：组数满了撤自动组（先撤没有在跑 / 排队作业的），作业数满了逐个放掉自动关注的作业。
// 撤掉的组规则还在，等有名额时会重新建起来。
export function yieldToManual(data, incoming) {
  while (data.watches.length >= WATCH_MAX_GROUPS) {
    const autos = data.watches.filter(isAuto).sort((a, b) => a.jobs.filter((j) => !terminal(j)).length - b.jobs.filter((j) => !terminal(j)).length);
    if (!autos.length) break;
    data.watches = data.watches.filter((w) => w !== autos[0]);
  }
  while (jobCount(data.watches) + incoming > WATCH_MAX_JOBS) {
    const victim = pickAutoVictim(data, { pressing: true });
    if (!victim) break;
    dropAutoItem(victim);
  }
}

// 被静音的规则（key 列表）。静音除了记在组上，也记在 settings[serverId].autoMuted 里：自动组会被手动关注挤掉
// （组数满了）再建回来，只记在组上的话一挤就丢了。
export const mutedRules = (data, serverId) => {
  const list = own(data.settings, serverId)?.autoMuted;
  return Array.isArray(list) ? list.filter((key) => typeof key === "string") : [];
};
export function setRuleMuted(data, serverId, key, muted) {
  const before = mutedRules(data, serverId);
  const after = muted ? [...new Set([...before, key])] : before.filter((item) => item !== key);
  if (after.length === before.length && after.every((item, i) => item === before[i])) return;
  const { autoMuted: _dropped, ...rest } = own(data.settings, serverId) ?? {};
  setOwn(data.settings, serverId, after.length ? { ...rest, autoMuted: after } : rest);
}

// 自动组跟着规则走：规则没了组就撤（它的静音也不留）；新规则先建一个空组（「这一批结束」从哪算起记在组上）。
// doneFloor(key) → 新组「这一批结束」的起算点（结束时刻不晚于它的作业不算进去）。
export function syncAutoGroups(data, serverId, rules, stamp, doneFloor = () => stamp) {
  const keys = ruleKeys(rules);
  data.watches = data.watches.filter((w) => w.serverId !== serverId || !isAuto(w) || keys.includes(w.auto.rule));
  for (const key of mutedRules(data, serverId)) if (!keys.includes(key)) setRuleMuted(data, serverId, key, false);
  const muted = mutedRules(data, serverId);
  for (const key of keys) {
    const label = ruleLabel(key, rules);
    const existing = data.watches.find((w) => w.serverId === serverId && w.auto?.rule === key);
    if (existing) { existing.label = label; continue; }
    if (data.watches.length >= WATCH_MAX_GROUPS) continue; // 组数满了：手动关注优先，这条规则等有名额再落组。
    data.watches.push({ id: randomUUID(), serverId, label, muted: muted.includes(key), createdAt: stamp, jobs: [], auto: { rule: key, doneAt: Math.max(stamp, doneFloor(key)), idleSince: null, notifiedAt: {} } });
  }
}

// 一份 sacct 快照里各条规则名下已结束作业的最晚结束时刻：新建 / 恢复的自动组从这里起算，之前结束的不补报。
export function endedFloors(snapshot, rules) {
  const floors = new Map();
  if (snapshot?.state !== "ok") return floors;
  const ruleOf = createRuleMatcher(rules);
  for (const job of snapshot.jobs) {
    if (!terminal(job) || !Number.isFinite(job.endAt)) continue;
    const key = ruleOf(job);
    if (key) floors.set(key, Math.max(floors.get(key) ?? 0, job.endAt));
  }
  return floors;
}

// 规则命中的在跑作业收进自动组（已被任何组关注的不重复收），按提交先后。
// 排队中的不收、收进来之后又回到排队（被重排）的也放掉：名额只给在跑的和刚结束的。排队的作业没有日志可盯，
// 还可能因为上游失败、依赖永远满足不了而一直排着，把 60 个名额占死。它们仍算「这一批还没结束」（closeAutoBatches 按快照数）。
export function admitAutoJobs(data, serverId, snapshot, ruleOf, stamp) {
  const groups = new Map(data.watches.filter((w) => w.serverId === serverId && isAuto(w)).map((w) => [w.auto.rule, w]));
  if (!groups.size) return;
  for (const watch of groups.values()) {
    watch.jobs = watch.jobs.filter((item) => item.state !== "PENDING" && stamp - (terminal(item) ? item.endedAt ?? item.checkedAt : item.checkedAt) <= AUTO_KEEP_MS);
  }
  const tracked = new Set(data.watches.filter((w) => w.serverId === serverId).flatMap((w) => w.jobs.map((j) => j.id)));
  const candidates = [];
  for (const job of snapshot.jobs) {
    if (job.state !== "RUNNING" || tracked.has(job.id) || !FORENSICS_JOB_ID_RE.test(job.id)) continue;
    const watch = groups.get(ruleOf(job));
    if (watch) candidates.push({ job, watch });
  }
  candidates.sort((a, b) => (a.job.submitAt ?? Infinity) - (b.job.submitAt ?? Infinity) || a.job.id.localeCompare(b.job.id, "en", { numeric: true }));
  for (const { job, watch } of candidates) {
    if (!reserveAutoSlot(data)) break;
    watch.jobs.push({ ...jobState(job, stamp), notifiedStarted: true, notifiedEnded: false, limitNotified: false, stalledNotified: false, progress: null, addedAt: stamp });
  }
}

// 自动组不逐个报「结束」：规则名下没有在跑 / 排队的作业并安静了一阵，才把这段时间结束的合成一条「这一批已全部结束」。
// 数的是 sacct 快照里这条规则名下的全部作业（不止收进组的那些：跑得快的作业可能两轮之间就结束了，排队的也不收进组）。
// 只有名字规则有「一批」的说法。长作业规则不报：谁先超过阈值谁先进来，错开提交的长作业会变成逐个报结束。
export function closeAutoBatches(data, serverId, snapshot, ruleOf, stamp, resumed, told) {
  const groups = data.watches.filter((w) => w.serverId === serverId && isAuto(w) && w.auto.rule !== LONG_RUN_RULE);
  if (!groups.length) return;
  // 服务器刚回到采集范围：离开期间结束的一律不补报，起算点直接抬到现在。放在「这一轮没拿全」的判断之前——
  // 恢复的记号这一轮就会清掉，等下一轮再处理就晚了。
  for (const watch of groups) {
    if (!resumed.has(watch.id)) continue;
    watch.auto.doneAt = Math.max(watch.auto.doneAt, stamp);
    watch.auto.idleSince = null;
  }
  // 快照没拿全时看不出是不是真的都结束了，这一轮不下结论。
  if (snapshot.truncated) return;
  const buckets = new Map();
  for (const job of snapshot.jobs) {
    const key = ruleOf(job);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, { active: 0, ended: [] });
    if (!terminal(job)) buckets.get(key).active += 1;
    else if (Number.isFinite(job.endAt) && FORENSICS_JOB_ID_RE.test(job.id)) buckets.get(key).ended.push(job);
  }
  for (const watch of groups) {
    const bucket = buckets.get(watch.auto.rule) ?? { active: 0, ended: [] };
    const fresh = bucket.ended.filter((job) => job.endAt > watch.auto.doneAt).sort((a, b) => b.endAt - a.endAt);
    if (resumed.has(watch.id)) {
      // 这一轮看得见的、离开期间结束的也一并划过去（远端时钟略快于本机时，它们的结束时刻可能比「现在」还晚一点）。
      if (fresh.length) watch.auto.doneAt = fresh[0].endAt;
      continue;
    }
    if (bucket.active || !fresh.length) { watch.auto.idleSince = null; continue; }
    if (watch.muted) {
      // 静音着的时候结束的这一批直接划过去：不等安静期，免得其间取消静音后又补报出来。
      watch.auto.doneAt = fresh[0].endAt;
      watch.auto.idleSince = null;
      continue;
    }
    watch.auto.idleSince ??= stamp;
    if (stamp - watch.auto.idleSince < AUTO_SETTLE_MS || autoHeld(watch, "ended", stamp)) continue;
    const count = (outcome) => fresh.filter((job) => jobOutcome(job) === outcome).length;
    const sent = notify(data, watch, "ended", fresh.slice(0, NOTICE_JOB_IDS_MAX), stamp, `${watch.label} 这一批已全部结束`,
      `${fresh.length} 个作业：${count("completed")} 完成 · ${count("failed")} 失败 · ${count("cancelled")} 取消。可在作业历史查看原因与资源复盘。`);
    if (sent) {
      autoSent(watch, "ended", stamp);
      for (const job of fresh) told.add(job.id);
    }
    watch.auto.doneAt = fresh[0].endAt;
    watch.auto.idleSince = null;
  }
}

// 失败提醒：这一轮新出现的失败作业合成一条，不依赖关注。told = 这一轮已经由关注组的「结束」提醒带到的作业，不重复提。
// isFailure(job) / diagnosisOf(serverId, jobId, 结束时刻)：由关注服务转交（jobs 服务注入的那两个）；ruleOf：规则归属。
export function noteFailures(data, serverId, snapshot, rules, told, stamp, { isFailure, diagnosisOf, ruleOf }) {
  const failed = snapshot.jobs.filter((job) => isFailure(job));
  const endedAt = (job) => (Number.isFinite(job.endAt) ? job.endAt : stamp);
  const state = own(data.failures, serverId);
  if (!state) {
    // 头一轮只记不发：升级、新装或这台服务器刚回到采集范围时，近两天里已有的失败不算新的。
    setOwn(data.failures, serverId, { since: stamp - FAIL_BASELINE_SLACK_MS, seen: Object.fromEntries(failed.map((job) => [job.id, endedAt(job)])) });
    return;
  }
  // 「见过」按 作业号 + 结束时刻 认：同一个作业号可以失败两次（节点故障后重排、再次失败），后一次的结束时刻更晚，算新的。
  // 读不出结束时刻的只按作业号认（否则每一轮都会被当成又失败了一次）。
  const isNew = (job) => !Object.hasOwn(state.seen, job.id) || (Number.isFinite(job.endAt) && job.endAt > state.seen[job.id]);
  const fresh = failed.filter((job) => isNew(job) && endedAt(job) > state.since);
  // 关着、静音着的时候也照记：之后再打开 / 取消静音，期间的失败不会一股脑补发。
  for (const job of fresh) state.seen[job.id] = endedAt(job);
  if (!rules.failNotify) { delete state.pending; return; }
  // 作业在任何静音的关注组里就不提：手动组看它收着哪些作业；自动组看规则——命中被静音的规则即算，不管这个作业有没有被收进组。
  const mine = data.watches.filter((w) => w.serverId === serverId);
  const mutedIds = new Set(mine.filter((w) => w.muted).flatMap((w) => w.jobs.map((item) => item.id)));
  const mutedKeys = new Set([...mutedRules(data, serverId), ...mine.filter((w) => isAuto(w) && w.muted).map((w) => w.auto.rule)]);
  const silenced = (job) => mutedIds.has(job.id) || (mutedKeys.size > 0 && mutedKeys.has(ruleOf(job)));
  // pending：间隔内攒着、还没提醒的作业号（落盘，重启不丢也不重发）。
  const pending = new Set(state.pending || []);
  for (const job of fresh) pending.add(job.id);
  // 关注组这一轮已经报过的（含攒着还没发、这一轮被「这一批结束」带到的）不再单独提。
  for (const id of told) pending.delete(id);
  const byId = new Map(failed.map((job) => [job.id, job]));
  for (const id of [...pending]) if (byId.has(id) && silenced(byId.get(id))) pending.delete(id);
  if (!pending.size) { delete state.pending; return; }
  if (stamp - (state.notifiedAt || 0) < FAIL_NOTIFY_GAP_MS) { state.pending = [...pending].slice(-FAIL_PENDING_MAX); return; }
  delete state.pending;
  const report = [...pending].map((id) => byId.get(id)).filter(Boolean).sort((a, b) => endedAt(b) - endedAt(a));
  if (!report.length) return;
  const { title, body } = summarizeFailures(report, (jobId) => diagnosisOf(serverId, jobId, byId.get(jobId)?.endAt ?? null));
  // 没动过规则的人收到的头一条失败提醒带 intro：界面据此说明「这是默认开启的」。
  const intro = !state.introduced && !own(data.settings, serverId)?.rules;
  data.notifications.push({ id: randomUUID(), serverId, watchId: null, kind: "failed", createdAt: stamp, title, body, jobIds: report.slice(0, NOTICE_JOB_IDS_MAX).map((job) => job.id), readAt: null, ...(intro ? { intro: true } : {}) });
  state.notifiedAt = stamp;
  state.introduced = true;
}
