// 作业关注服务：GET/POST 只动本机状态；SSH 仅由 jobs 探针同一调度槽串行驱动。
//
// v2.62 提醒规则（设计 docs/superpowers/specs/2026-10-12-completeness-round-design.md 的 W1；规则的纯函数在 watch-rules.mjs，
// 一轮采集里对关注数据的改动——自动进组与名额、「这一批已全部结束」、失败提醒——在 watch-auto.mjs，这里只管取数、调用与落盘）：
//   - 失败提醒：jobs 探针这一轮新出现的失败作业（与失败诊断同一口径，由 isFailure 注入）合成一条提醒，不依赖关注。
//     这类提醒不属于任何关注组，watchId 为 null。按 作业号 + 结束时刻 记「见过」（data.failures），重启、关掉再打开
//     都不重发，同一个作业号重排后再失败算新的一次；同一台服务器两条之间至少隔 10 分钟，间隔内的攒到下一条。
//     作业在任何静音的关注组里（手动组收着它，或它命中一条被静音的规则）就不提。
//   - 自动关注：名字命中规则或已运行超过阈值的在跑作业自动进组（排队中的不占名额），每条规则一组（组上带 auto.rule），
//     采集与手动关注同一套；提醒只发疑似停滞、临近时限、子任务非零退出，名字规则另有「这一批全部结束」
//     （长作业规则没有「一批」的说法，不报结束），同一组同一种提醒有最短间隔。
//     合计最多 60 个作业，只用手动关注剩下的名额；手动关注撞 40 组 / 200 个作业的上限时先腾自动的。
//     组的静音同时记在规则上（settings[serverId].autoMuted），组被挤掉再建回来仍然静音。
//   - 免打扰（quietUntil）沿用原有做法：提醒照记进收件箱，由桌面 / 浏览器那一侧决定不弹系统通知。
//   - 不新增 SSH 的种类：读日志用的还是原有的那一次关注采集（python3 -c，每台每轮至多一次）。以前它只在有手动关注的
//     在跑作业、或有刚结束的作业要做资源复盘时才发；现在有自动关注的在跑作业的轮次也会发。
import { randomUUID } from "node:crypto";

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { statusError } from "../status-error.mjs";
import { isUsageEligible } from "../usage/service.mjs";
import { FORENSICS_JOB_ID_RE } from "./forensics.mjs";
import { applySubrunRecord, finalizeSubruns, subrunActivity, subrunFailures, subrunView } from "./subrun-model.mjs";
import { createSubrunStore } from "./subrun-store.mjs";
import { admitAutoJobs, autoHeld, autoSent, closeAutoBatches, endedFloors, isAuto, jobCount, jobState, limitGapMs, noteFailures, notify, own, refreshItem, setOwn, setRuleMuted, syncAutoGroups, terminal, yieldToManual } from "./watch-auto.mjs";
import { buildProgress, buildResourceReview, progressView, WATCH_DEFAULT_SETTINGS, WATCH_FRESH_MS } from "./watch-model.mjs";
import { buildSuggestions, createRuleMatcher, normalizeRules, patchRules, withoutRule } from "./watch-rules.mjs";
import { buildWatchInvocation, parseWatchOutput, WATCH_BATCH_MAX } from "./watch-scan.mjs";
import { WATCH_MAX_GROUPS, WATCH_MAX_JOBS } from "./watch-store.mjs";

// 间隔与保留期的常量随实现搬到了 watch-auto.mjs，仍从这里出口。
export { AUTO_KEEP_MS, AUTO_LIMIT_GAP_MS, AUTO_NOTIFY_GAP_MS, AUTO_SETTLE_MS, FAIL_NOTIFY_GAP_MS } from "./watch-auto.mjs";

const SUGGESTIONS_TTL_MS = 60000;
const SUGGESTIONS_WINDOW_MS = 7 * 86400000;

const prefs = (data, serverId) => ({
  silenceMinutes: own(data.settings, serverId)?.silenceMinutes ?? WATCH_DEFAULT_SETTINGS.silenceMinutes,
  limitMinutes: own(data.settings, serverId)?.limitMinutes ?? WATCH_DEFAULT_SETTINGS.limitMinutes,
  quietUntil: data.quietUntil || 0,
});
const rulesOf = (data, serverId) => normalizeRules(own(data.settings, serverId)?.rules);
const jobsKey = (ids) => [...ids].sort().join(",");

const subrunMap = (data, serverId) => new Map(data.jobs.filter((s) => s.serverId === serverId).map((s) => [s.jobId, s]));

// 子任务非零退出并入现有「作业提醒」：每个关注组每轮合并一条，按 run/phase/尝试/结束时刻去重，静音沿用 notify。
function notifySubrunFailures(data, watch, states, now) {
  // 自动组还在间隔内：这一轮不记「已提醒」，留到间隔过后与新的合成一条。
  if (autoHeld(watch, "subrun-failed", now)) return;
  const failed = [];
  const lines = [];
  for (const item of watch.jobs) {
    const seen = new Set(item.subrunNotified || []);
    // 自动进组的作业按进组时刻算（组本身可能早就建了）：进组之前就失败的只显示、不提醒。
    const fresh = subrunFailures(states.get(item.id), (item.addedAt ?? watch.createdAt) - 60_000).filter((f) => !seen.has(f.key));
    if (!fresh.length) continue;
    failed.push(item);
    item.subrunNotified = [...seen, ...fresh.map((f) => f.key)].slice(-100);
    for (const f of fresh) lines.push(`${item.id} · ${f.run} ${f.phase}（退出码 ${f.code}）`);
  }
  if (!lines.length) return;
  const sent = notify(data, watch, "subrun-failed", failed, now, `${watch.label} 有子任务失败`,
    `${lines.slice(0, 3).join("；")}${lines.length > 3 ? ` 等 ${lines.length} 个` : ""}。按 stdout 的结束记录判断，退出码非 0 即失败；其余子任务仍由作业内调度器决定是否继续。`);
  if (sent) autoSent(watch, "subrun-failed", now);
}

// 普通作业（stdout 里没出现过 LAUNCH / END，不是编排型）不建子任务状态，只在关注条目上记 stdout 读到哪了
// （item.orch = { path, cid: 文件身份, off: 偏移, gap?, tries? }）：下一轮接着读，不必每轮从头扫一遍，也不占子任务
// 存储的名额。有了子任务状态之后以状态里的游标为准，条目上的拿掉。作业结束后照旧补一次收尾读取（见 scan 里的
// cursorFinals）：最后一次采样之后才写出来的 LAUNCH / END 不会漏。
function trackStdoutCursor(item, state, record) {
  if (state) { delete item.orch; return; }
  if (!record || record.missing || record.events.length) return;
  const gap = stdoutGap(record.gap, item.orch?.gap);
  item.orch = { path: record.path, cid: record.cid, off: record.off, ...(gap ? { gap } : {}) };
}

// 普通作业读 stdout 时留下的覆盖缺口，等它真成了编排型再写进状态：这一轮新出的（首次就很大只读了末尾 / 跳过了
// 一段超长行）记下；文件被换掉或截断后是从头读的，旧缺口作废；其余情况沿用之前记着的。
function stdoutGap(recordGap, before) {
  if (recordGap === "head" || recordGap === "skipped") return recordGap;
  if (recordGap === "replaced" || recordGap === "truncated") return null;
  return before === "head" || before === "skipped" ? before : null; // 盘上的值只认这两种
}

// isFailure(job)：触发失败提醒的口径，由 jobs 服务注入失败诊断用的同一个判定；缺省（只在单测里）不提醒。
// diagnosisOf(serverId, jobId, 结束时刻) → { category, headline } | null：失败提醒正文里的原因（只认那一次失败的诊断）。
// scanIntervalMs：jobs 探针的周期，只用来估自动关注的作业多久能轮到一次日志采样。
export function createJobWatchService({ store, registry, getConfig, getSnapshot, dataDir, execCollector, now = Date.now, isFailure = () => false, diagnosisOf = () => null, scanIntervalMs = 5 * 60000 }) {
  const subrunStore = store.subruns ?? createSubrunStore({ now });
  const queues = new Map();
  const resourceAttempts = new Map();
  const suggestionCache = new Map(); // serverId -> { key, at, value }
  let previousScope = null;

  async function configContext() {
    const config = await getConfig();
    const enabled = isDataModuleEnabled(config, "jobs");
    const servers = enabled ? (config?.servers || []).filter(isUsageEligible) : [];
    const ids = new Set(servers.map((s) => s.id));
    const scope = `${enabled}:${[...ids].sort().join(",")}`;
    if (scope !== previousScope) {
      await store.update((data) => {
        data.notifications = data.notifications.filter((n) => ids.has(n.serverId));
        for (const w of data.watches) if (!ids.has(w.serverId)) w.suspended = true;
        // 退出采集范围的服务器不留失败基线：回来时重新建，期间的失败不补发。
        for (const id of Object.keys(data.failures)) if (!ids.has(id)) delete data.failures[id];
      });
      for (const id of suggestionCache.keys()) if (!ids.has(id)) suggestionCache.delete(id);
      previousScope = scope;
    }
    return { config, enabled, servers, ids };
  }

  function knownJobs(serverId) {
    const jobs = new Map();
    const snap = getSnapshot(serverId);
    if (snap?.state === "ok" && now() - snap.checkedAt <= WATCH_FRESH_MS) {
      for (const job of snap.jobs) jobs.set(job.id, job);
    }
    const queue = queues.get(serverId);
    if (queue && now() - queue.checkedAt <= 90_000) for (const job of queue.jobs) jobs.set(job.id, job);
    return jobs;
  }

  // 建议的名字前缀：近 7 天登记过的作业名 + 近 48 小时的作业。界面每 30 秒读一次，结果留一分钟。
  function suggestionsFor(serverId, rules) {
    const key = rules.patterns.join("\u0000");
    const hit = suggestionCache.get(serverId);
    if (hit && hit.key === key && now() - hit.at < SUGGESTIONS_TTL_MS) return hit.value;
    const snap = getSnapshot(serverId);
    const entries = [
      ...(registry?.names?.(serverId, { since: now() - SUGGESTIONS_WINDOW_MS }) ?? []),
      ...(snap?.state === "ok" ? snap.jobs.map((job) => ({ id: job.id, name: job.name })) : []),
    ];
    const value = buildSuggestions(entries, rules);
    suggestionCache.set(serverId, { key, at: now(), value });
    return value;
  }

  // 自动组里先看在跑的、再看排队的，结束的按结束先后排在最后（新的在前）。
  function orderedJobs(watch) {
    if (!isAuto(watch)) return watch.jobs;
    const rank = (item) => (item.state === "RUNNING" ? 0 : terminal(item) ? 2 : 1);
    return [...watch.jobs].sort((a, b) => rank(a) - rank(b) || (terminal(a) ? (b.endedAt ?? 0) - (a.endedAt ?? 0) : 0));
  }

  async function view(serverId = null) {
    const ctx = await configContext();
    if (!ctx.enabled) return { disabled: true };
    const data = await store.snapshot();
    const notifications = data.notifications.filter((n) => ctx.ids.has(n.serverId) && (!serverId || n.serverId === serverId)).reverse();
    if (!serverId) {
      // 全局收件箱不跟着「正在看哪台」走：提醒规则按服务器列出，浮层里每台一块。
      const servers = ctx.servers.map((s) => {
        const rules = rulesOf(data, s.id);
        return { serverId: s.id, name: s.name || s.id, rules, suggestions: suggestionsFor(s.id, rules) };
      });
      return { schemaVersion: 1, settings: { quietUntil: data.quietUntil || 0 }, notifications, servers };
    }
    const rules = rulesOf(data, serverId);
    if (!ctx.ids.has(serverId)) return { schemaVersion: 1, serverId, inactive: true, settings: prefs(data, serverId), rules, suggestions: [], watches: [], resources: [], notifications: [] };
    const resources = data.resources.filter((r) => r.serverId === serverId).reverse();
    const byId = new Map(resources.map((r) => [r.jobId, r]));
    const subruns = subrunMap(await subrunStore.snapshot().catch(() => ({ jobs: [] })), serverId);
    // 手动关注在前；还没收进任何作业的自动组不显示。
    const mine = data.watches.filter((w) => w.serverId === serverId && !(isAuto(w) && !w.jobs.length));
    return {
      schemaVersion: 1, serverId, disabled: false, settings: prefs(data, serverId), rules, suggestions: suggestionsFor(serverId, rules), notifications, resources,
      watches: [...mine.filter((w) => !isAuto(w)), ...mine.filter(isAuto)].map((w) => {
        const jobs = orderedJobs(w);
        return {
          id: w.id, label: w.label, jobIds: jobs.map((j) => j.id), muted: w.muted, createdAt: w.createdAt, ...(isAuto(w) ? { auto: { rule: w.auto.rule } } : {}),
          jobs: jobs.map((j) => ({ ...jobState(j, j.checkedAt), progress: progressView(j.progress, now(), j.state), resources: byId.get(j.id) || null, subruns: subrunView(subruns.get(j.id), now()) })),
        };
      }),
    };
  }

  // 用户自己存过规则之后，「这是默认开启的失败提醒」那句说明就不成立了：把还挂在提醒上的 intro 标记拿掉。
  function saveRules(data, serverId, rules) {
    setOwn(data.settings, serverId, { ...own(data.settings, serverId), rules });
    for (const n of data.notifications) if (n.serverId === serverId) delete n.intro;
    suggestionCache.delete(serverId);
  }

  async function change(serverId, body) {
    const ctx = await configContext();
    if (!ctx.enabled) throw statusError("我的 Slurm 作业模块已关闭", 409);
    if (serverId && !ctx.ids.has(serverId)) throw statusError("服务器不在作业采集范围", 404);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw statusError("无效的请求正文");
    if (!serverId && !["settings", "ack"].includes(body.action)) throw statusError("此操作需要 serverId");
    const known = serverId ? knownJobs(serverId) : new Map();
    await store.update((data) => {
      const stamp = now();
      if (body.action === "settings") {
        if (serverId) {
          const next = { ...WATCH_DEFAULT_SETTINGS, ...own(data.settings, serverId) };
          let changed = false;
          for (const [key, min] of [["silenceMinutes", 10], ["limitMinutes", 1]]) {
            if (body[key] === undefined) continue;
            if (!Number.isInteger(body[key]) || body[key] < min || body[key] > 1440) throw statusError(`${key} 必须是 ${min}–1440 分钟`);
            next[key] = body[key]; changed = true;
          }
          if (!changed) throw statusError("未指定进度提醒设置");
          setOwn(data.settings, serverId, next);
        } else {
          if (!Number.isSafeInteger(body.quietUntil) || body.quietUntil < 0 || body.quietUntil > stamp + 86400_000) throw statusError("免打扰最多设置 24 小时");
          data.quietUntil = body.quietUntil;
        }
        return;
      }
      if (body.action === "rules") {
        const rules = patchRules(rulesOf(data, serverId), body);
        saveRules(data, serverId, rules);
        const floors = endedFloors(getSnapshot(serverId), rules);
        syncAutoGroups(data, serverId, rules, stamp, (key) => floors.get(key) ?? 0);
        return;
      }
      if (body.action === "ack") {
        const notices = data.notifications.filter((n) => ctx.ids.has(n.serverId) && (!serverId || n.serverId === serverId) && (body.notificationId === "all" || n.id === body.notificationId));
        if (body.notificationId !== "all" && !notices.length) throw statusError("通知不存在", 404);
        for (const n of notices) n.readAt ??= stamp;
        return;
      }
      if (body.action === "watch") {
        const ids = Array.isArray(body.jobIds) ? [...new Set(body.jobIds)] : [];
        if (!ids.length || ids.length > 100 || ids.some((id) => typeof id !== "string" || !FORENSICS_JOB_ID_RE.test(id))) throw statusError("请选择 1–100 个具体作业（暂不支持未展开的数组区间）");
        if (ids.some((id) => !known.has(id))) throw statusError("只能关注最近采集到的本人作业，请先刷新队列", 409);
        if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 80)) throw statusError("关注名称最多 80 个字符");
        // 上限只跟手动关注比：自动关注的不占手动的名额，撞上限时由下面腾出来。
        const manual = data.watches.filter((w) => !isAuto(w));
        if (manual.some((w) => w.serverId === serverId && jobsKey(w.jobs.map((j) => j.id)) === jobsKey(ids))) return;
        if (manual.length >= WATCH_MAX_GROUPS || jobCount(manual) + ids.length > WATCH_MAX_JOBS) throw statusError("关注上限为 40 组 / 200 个作业，请先取消部分关注", 409);
        // 手动关注优先：这些作业若已被自动关注，挪出来由手动组接管（提醒不出两份）。自动组已经提醒过的
        // （临近时限、疑似停滞、子任务失败）与采样进度一并带过去，否则同一件事手动组会再提一遍。
        const taken = new Map();
        for (const w of data.watches) {
          if (!isAuto(w) || w.serverId !== serverId) continue;
          for (const item of w.jobs) if (ids.includes(item.id)) taken.set(item.id, item);
          w.jobs = w.jobs.filter((j) => !ids.includes(j.id));
        }
        const carried = (id) => {
          const from = taken.get(id);
          if (!from) return { limitNotified: false, stalledNotified: false, progress: null };
          return {
            limitNotified: from.limitNotified === true, stalledNotified: from.stalledNotified === true, progress: from.progress ?? null,
            ...(Array.isArray(from.subrunNotified) ? { subrunNotified: from.subrunNotified } : {}), ...(from.orch ? { orch: from.orch } : {}),
          };
        };
        yieldToManual(data, ids.length);
        data.watches.push({
          id: randomUUID(), serverId, label: body.label?.trim() || (ids.length === 1 ? known.get(ids[0]).name || ids[0] : `${ids.length} 个作业`), muted: false, createdAt: stamp,
          jobs: ids.map((id) => ({ ...jobState(known.get(id), stamp), notifiedStarted: known.get(id).state === "RUNNING" || terminal(known.get(id)), notifiedEnded: terminal(known.get(id)), ...carried(id) })),
        });
        return;
      }
      if (["unwatch", "mute"].includes(body.action)) {
        const watch = data.watches.find((w) => w.serverId === serverId && w.id === body.watchId);
        if (!watch) throw statusError("关注项不存在", 404);
        if (body.action === "mute") {
          if (typeof body.muted !== "boolean") throw statusError("muted 必须为布尔值");
          watch.muted = body.muted;
          // 自动组的静音同时记在规则上：组被手动关注挤掉再建回来时还认得。
          if (isAuto(watch)) setRuleMuted(data, serverId, watch.auto.rule, body.muted);
        } else if (isAuto(watch)) {
          // 自动组的移除 = 停用这条规则；只撤组的话下一轮又会收进来。
          const rules = withoutRule(rulesOf(data, serverId), watch.auto.rule);
          saveRules(data, serverId, rules);
          syncAutoGroups(data, serverId, rules, stamp);
          data.watches = data.watches.filter((w) => w !== watch);
        } else data.watches = data.watches.filter((w) => w !== watch);
        return;
      }
      throw statusError("不支持的关注操作");
    });
    return view(serverId);
  }

  async function observeQueue(serverId, snapshot) {
    const ctx = await configContext();
    if (!ctx.ids.has(serverId) || snapshot?.state !== "ok" || !snapshot.user) { queues.delete(serverId); return; }
    const jobs = snapshot.jobs.filter((j) => j.user === snapshot.user && FORENSICS_JOB_ID_RE.test(j.id));
    queues.set(serverId, { checkedAt: now(), jobs });
    for (const id of queues.keys()) if (!ctx.ids.has(id)) queues.delete(id);
    const data = await store.snapshot();
    if (!data.watches.some((w) => w.serverId === serverId)) return;
    await store.update((d) => {
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const settings = prefs(d, serverId);
      for (const watch of d.watches.filter((w) => w.serverId === serverId)) {
        const near = [];
        const started = [];
        const held = autoHeld(watch, "limit", now(), limitGapMs(settings.limitMinutes));
        for (const item of watch.jobs) {
          const j = byId.get(item.id);
          if (!j) continue;
          // 自动组不报「开始运行」。
          if (item.state === "PENDING" && j.state === "RUNNING" && !item.notifiedStarted) { if (!isAuto(watch)) started.push(item); item.notifiedStarted = true; }
          refreshItem(item, j, now(), isAuto(watch));
          const remaining = j.timeLimitSec !== null && j.elapsedSec !== null ? j.timeLimitSec - j.elapsedSec : Infinity;
          if (j.state === "RUNNING" && j.timeLimitSec > 0 && remaining >= 0 && remaining <= settings.limitMinutes * 60 && !item.limitNotified) { near.push(item); if (!held) item.limitNotified = true; }
        }
        if (!watch.suspended && !held && notify(d, watch, "limit", near, now(), `${watch.label} 接近作业时限`, `${near.length} 个作业剩余时限不足 ${settings.limitMinutes} 分钟，请核对检查点；不会自动延长或取消。`)) autoSent(watch, "limit", now());
        if (!watch.suspended) notify(d, watch, "started", started, now(), `${watch.label} 开始运行`, `${started.length} 个关注的作业已从排队转为运行。`);
      }
    });
  }

  // 子任务游标与配对结果同一次原子写入；只有收到远端记录的作业才推进，没收到的保持原游标下轮重读。
  // autoIds：只被自动关注着的作业——它们的状态标上 auto，存储给另算名额，挤不到手动关注的那些。
  async function updateSubruns(serverId, jobs, finals, cursorFinals, records, { autoIds, manualIds }) {
    const live = new Map(records.filter((r) => r.kind === "live").map((r) => [r.id, r]));
    const ended = new Map(records.filter((r) => r.kind === "final").map((r) => [r.id, r]));
    return subrunStore.update((sd) => {
      // 状态记在谁的名额里跟着现在的关注归属走：只被自动关注着 → 自动；手动关注着（含接管过去的）→ 手动；
      // 已经没人关注的保持原样，到期清掉。
      const retag = (state) => {
        if (autoIds.has(state.jobId)) state.auto = true;
        else if (manualIds.has(state.jobId)) delete state.auto;
      };
      for (const state of sd.jobs) if (state.serverId === serverId) retag(state);
      const states = subrunMap(sd, serverId);
      const stamp = now();
      const put = (state) => {
        retag(state);
        sd.jobs = sd.jobs.filter((s) => s.serverId !== serverId || s.jobId !== state.jobId);
        sd.jobs.push(state);
        states.set(state.jobId, state);
      };
      for (const j of jobs) {
        const record = live.get(j.id);
        if (!record) continue;
        const prev = states.get(j.id);
        if (prev) { put(applySubrunRecord(prev, record, { now: stamp, serverId, jobId: j.id })); continue; }
        // 只给真是编排型的作业留状态：还没见过 LAUNCH / END 的普通作业不建（它读到哪了记在关注条目上，见 trackStdoutCursor）。
        if (record.missing || !record.events.length) continue;
        // 此前是按条目上的游标续读的：文件被换 / 截断对一份新状态没有意义（就是从头读的）；早先记着的缺口要带上。
        put(applySubrunRecord(null, { ...record, gap: stdoutGap(record.gap, j.seedGap) }, { now: stamp, serverId, jobId: j.id }));
      }
      for (const f of finals) {
        const prev = states.get(f.jobId);
        if (!prev) continue;
        if (ended.has(f.jobId)) { put(applySubrunRecord(prev, ended.get(f.jobId), { now: stamp, serverId, jobId: f.jobId })); continue; }
        const tries = (prev.finalAttempts || 0) + 1;
        put(tries >= 2 ? finalizeSubruns({ ...prev, finalAttempts: tries }, { now: stamp, note: "收尾读取两轮未成功，最后的结束记录可能缺失" }) : { ...prev, finalAttempts: tries });
      }
      // 只有条目游标的作业结束后的收尾读取：读到了 LAUNCH / END 才建状态（建出来就是已收尾的）。
      for (const item of cursorFinals) {
        const record = ended.get(item.id);
        if (states.has(item.id) || !record || record.missing || !record.events.length) continue;
        put(applySubrunRecord(null, { ...record, gap: stdoutGap(record.gap, item.orch.gap) }, { now: stamp, serverId, jobId: item.id }));
      }
      return states;
    });
  }

  async function scan(serverId, snapshot) {
    let ctx = await configContext();
    let server = ctx.servers.find((s) => s.id === serverId);
    if (!server || snapshot?.state !== "ok") return;
    const byId = new Map(snapshot.jobs.map((j) => [j.id, j]));
    suggestionCache.delete(serverId); // 新一轮作业到了，建议的前缀下次读时重算。
    await store.update((data) => {
      const stamp = now();
      // 删除 / 禁用服务器的旧通知不留到下一次重新启用时突然弹出。
      data.notifications = data.notifications.filter((n) => ctx.ids.has(n.serverId));
      const rules = rulesOf(data, serverId);
      const ruleOf = createRuleMatcher(rules);
      const floors = endedFloors(snapshot, rules);
      syncAutoGroups(data, serverId, rules, stamp, (key) => floors.get(key) ?? 0);
      const resumed = new Set(data.watches.filter((w) => w.serverId === serverId && w.suspended).map((w) => w.id));
      const told = new Set();
      for (const watch of data.watches.filter((w) => w.serverId === serverId)) {
        const ended = [];
        const started = [];
        const auto = isAuto(watch);
        for (const item of watch.jobs) {
          const j = byId.get(item.id);
          if (!j) continue; // 部分/截断视图下缺失永远不等同结束。
          if (item.state === "PENDING" && j.state === "RUNNING" && !item.notifiedStarted) { if (!watch.suspended && !auto) started.push(item); item.notifiedStarted = true; }
          refreshItem(item, j, stamp, auto);
          if (terminal(j) && !item.notifiedEnded) {
            if (!watch.suspended && !auto) ended.push(item);
            item.notifiedEnded = true;
            if (auto) item.endedAt = Number.isFinite(j.endAt) ? j.endAt : stamp;
          }
        }
        // 自动组不报「开始运行」与单个结束（几百个流水线作业会刷屏），整批结束见 closeAutoBatches。
        if (!auto) {
          const finished = watch.jobs.every(terminal);
          const allDone = finished && watch.jobs.every((j) => j.outcome === "completed");
          const ending = allDone ? "全部完成" : finished && watch.jobs.length > 1 ? "整组已结束" : `有 ${ended.length} 个作业结束`;
          if (notify(data, watch, "ended", ended, stamp, `${watch.label} ${ending}`, `${watch.jobs.filter((j) => j.outcome === "completed").length} 完成 · ${watch.jobs.filter((j) => j.outcome === "failed").length} 失败 · ${watch.jobs.filter((j) => j.outcome === "cancelled").length} 取消。可在作业历史查看原因与资源复盘。`)) {
            for (const item of ended) told.add(item.id);
          }
          notify(data, watch, "started", started, stamp, `${watch.label} 开始运行`, `${started.length} 个关注的作业已从排队转为运行。`);
        }
        watch.suspended = false;
      }
      admitAutoJobs(data, serverId, snapshot, ruleOf, stamp);
      closeAutoBatches(data, serverId, snapshot, ruleOf, stamp, resumed, told);
      noteFailures(data, serverId, snapshot, rules, told, stamp, { isFailure, diagnosisOf, ruleOf });
    });
    const data = await store.snapshot();
    // 这一轮读谁的日志：手动关注的在前，自动关注的只用剩下的名额；各自最久没采的先采。
    const runningOf = (auto) => [...new Map(data.watches.filter((w) => w.serverId === serverId && isAuto(w) === auto).flatMap((w) => w.jobs).filter((j) => byId.get(j.id)?.state === "RUNNING").map((j) => [j.id, j])).values()]
      .sort((a, b) => (a.progress?.checkedAt || 0) - (b.progress?.checkedAt || 0));
    const manualRunning = runningOf(false);
    const autoRunning = runningOf(true);
    const active = [...new Map([...manualRunning, ...autoRunning].map((j) => [j.id, j])).values()].slice(0, WATCH_BATCH_MAX);
    // 自动关注的作业一轮排不完就轮着来：判「疑似停滞」要求相邻两次采样连得上，这个窗口随轮转周期放宽。
    const autoSlots = Math.max(0, WATCH_BATCH_MAX - manualRunning.length);
    const autoFreshMs = autoSlots ? Math.max(WATCH_FRESH_MS, Math.ceil(autoRunning.length / autoSlots) * scanIntervalMs + 60_000) : WATCH_FRESH_MS;
    // 子任务游标随同一次 SSH 送达（新增连接 0）；首次关注的作业给空对象，由远端从头有限额回填。
    const priorSubruns = subrunMap(await subrunStore.snapshot().catch(() => ({ jobs: [] })), serverId);
    const jobs = active.map((j) => ({ id: j.id, reg: registry.lookup(serverId, j.id), orch: priorSubruns.get(j.id) || (j.orch ? { cursor: j.orch } : {}), seedGap: j.orch?.gap ?? null }));
    const watchedIds = new Set(data.watches.filter((w) => w.serverId === serverId).flatMap((w) => w.jobs.map((j) => j.id)));
    const manualIds = new Set(data.watches.filter((w) => w.serverId === serverId && !isAuto(w)).flatMap((w) => w.jobs.map((j) => j.id)));
    const autoIds = new Set([...watchedIds].filter((id) => !manualIds.has(id)));
    // 父作业结束后的一次收尾读取：补上最后的 END；最多试两轮。
    const finals = [...priorSubruns.values()].filter((s) => watchedIds.has(s.jobId) && s.cursor && !s.finalized && terminal(byId.get(s.jobId))).slice(0, 10);
    // 还没建状态、只有条目游标的作业结束后同样读一次（合计仍是每轮至多 10 个，有状态的在前）：
    // 它可能在最后一次采样之后才写出 LAUNCH / END。
    const cursorFinals = [...new Map(data.watches.filter((w) => w.serverId === serverId).flatMap((w) => w.jobs)
      .filter((j) => typeof j.orch?.path === "string" && !priorSubruns.has(j.id) && terminal(byId.get(j.id))).map((j) => [j.id, j])).values()].slice(0, 10 - finals.length);
    const recent = snapshot.jobs.filter((j) => terminal(j) && FORENSICS_JOB_ID_RE.test(j.id)).sort((a, b) => (b.endAt || 0) - (a.endAt || 0)).slice(0, 300);
    const resources = recent.filter((j) => !data.resources.some((r) => r.serverId === serverId && r.jobId === j.id) && (resourceAttempts.get(`${serverId}:${j.id}`) || 0) < 3).slice(0, WATCH_BATCH_MAX);
    if (!jobs.length && !resources.length && !finals.length && !cursorFinals.length) return;
    ctx = await configContext(); server = ctx.servers.find((s) => s.id === serverId);
    if (!server) return;
    const invocation = buildWatchInvocation({ server, parsed: ctx.config, knownHostsPath: resolveKnownHostsIfPresent(dataDir, serverId), jobs, resourceIds: resources.map((j) => j.id), orchFinal: [...finals.map((s) => ({ id: s.jobId, cursor: s.cursor })), ...cursorFinals.map((j) => ({ id: j.id, cursor: j.orch }))] });
    let result;
    try { result = await execCollector(invocation, server); } catch { result = null; }
    const parsed = parseWatchOutput(result?.stdout);
    ctx = await configContext();
    if (!ctx.ids.has(serverId)) return; // 采集期间关闭/删除的目标，结果不再产生提醒。
    for (const j of resources) {
      const key = `${serverId}:${j.id}`;
      resourceAttempts.set(key, (resourceAttempts.get(key) || 0) + 1);
    }
    if (resourceAttempts.size > 2000) for (const k of [...resourceAttempts.keys()].slice(0, resourceAttempts.size - 2000)) resourceAttempts.delete(k);
    const subStates = await updateSubruns(serverId, jobs, finals, cursorFinals, parsed.subruns, { autoIds, manualIds }).catch(() => priorSubruns);
    const liveRecords = new Map(parsed.subruns.filter((r) => r.kind === "live").map((r) => [r.id, r]));
    // 子任务存储没写成（退回了旧状态）时，这一轮读回来的收尾记录等于没用上：不算读过。
    const finalRead = new Set(subStates === priorSubruns ? [] : parsed.subruns.filter((r) => r.kind === "final").map((r) => r.id));
    const cursorFinalIds = new Set(cursorFinals.map((j) => j.id));
    await store.update((d) => {
      const settings = prefs(d, serverId);
      const results = new Map(parsed.progress.filter((p) => active.some((j) => j.id === p.id)).map((p) => [p.id, p]));
      for (const watch of d.watches.filter((w) => w.serverId === serverId)) {
        notifySubrunFailures(d, watch, subStates, now());
        let stalled = [];
        const auto = isAuto(watch);
        const held = autoHeld(watch, "stalled", now());
        for (const item of watch.jobs) {
          // 收尾读取发出去过的条目游标：读回来了就不再留；没读回来（远端预算用完之类）记一次，下一轮再试，两轮为止。
          if (cursorFinalIds.has(item.id) && item.orch) {
            if (finalRead.has(item.id) || item.orch.tries) delete item.orch;
            else item.orch = { ...item.orch, tries: 1 };
          }
          if (!active.some((j) => j.id === item.id) || item.state !== "RUNNING") continue;
          trackStdoutCursor(item, subStates.get(item.id), liveRecords.get(item.id));
          item.progress = buildProgress(results.get(item.id), item.progress, { now: now(), silenceMinutes: settings.silenceMinutes, activity: subrunActivity(subStates.get(item.id)), freshMs: auto ? autoFreshMs : WATCH_FRESH_MS });
          if (item.progress.status === "stalled" && !item.stalledNotified && !auto) { stalled.push(item); item.stalledNotified = true; }
          if (item.progress.status === "ok") item.stalledNotified = false;
        }
        // 自动组：间隔内判出的停滞先攒着；能发的那一轮把组里所有还没提过的一起带上（不止这一轮读到的那几个）。
        // 只认采样还新鲜的：很久没轮到的（名额被手动关注占满时）不拿旧结论去提醒。
        if (auto && !held) {
          stalled = watch.jobs.filter((item) => item.state === "RUNNING" && item.progress?.status === "stalled" && !item.stalledNotified && now() - item.progress.checkedAt <= Math.max(autoFreshMs, WATCH_FRESH_MS));
          for (const item of stalled) item.stalledNotified = true;
        }
        if (notify(d, watch, "stalled", stalled, now(), `${watch.label} 日志长时间未更新`, `${stalled.length} 个运行中的作业连续 ${settings.silenceMinutes} 分钟没有日志变化；这是疑似停滞，数据准备与输出缓冲也可能导致安静。`)) autoSent(watch, "stalled", now());
      }
      for (const r of parsed.resources) {
        if (!resources.some((j) => j.id === r.id)) continue;
        const review = buildResourceReview(r, byId.get(r.id), now());
        if (!review) continue;
        resourceAttempts.set(`${serverId}:${r.id}`, 3);
        d.resources = d.resources.filter((old) => old.serverId !== serverId || old.jobId !== r.id);
        d.resources.push({ ...review, serverId });
      }
      for (const j of resources) {
        if ((resourceAttempts.get(`${serverId}:${j.id}`) || 0) < 3 || d.resources.some((r) => r.serverId === serverId && r.jobId === j.id)) continue;
        d.resources.push({ serverId, jobId: j.id, name: j.name || j.id, state: j.state, checkedAt: now(), allocCpus: null, requestedMemoryBytes: null, maxRssBytes: null, totalCpuSeconds: null, elapsedSeconds: null, cpuEfficiency: null,
          detail: "连续 3 轮未能读取作业资源记账（可能未启用记账、采集失败或预算不足）；不将缺失指标视为零。" });
      }
    });
  }
  return { view, change, observeQueue, scan };
}
