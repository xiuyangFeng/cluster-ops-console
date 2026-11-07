// 「我的历史」按需回查（v2.51）：按作业号 / 日期查 48 小时之外的作业，以及组内「加载更多」。
//
// 为什么单独一块：定期采集（service.mjs runScan）固定近 48 小时、每 5 分钟一轮，结果会触发关注提醒、
// 失败取证与今日简报；回查只是「读给用户看」——这里拿到的作业一律不进 service 的快照、不登记、
// 不取证、不发提醒、不算进简报。失败作业只读挂上本机已有的诊断摘要（diagnosisOf），没有就没有。
//
// 实测（2026-10-06，kai@myserver，Slurm 23.11.8）：sacct 记账从 2026-03-11 起都在（这是该账号最早的作业，
// 集群更早的保留期限未知）；近 7 天约 2,500 行 / 300KB、峰值单日约 920 行 / 110KB，sacct 都在 0.1s 内返回。
// 因此：日期范围一次最多 LOOKUP_RANGE_DAYS_MAX（7）天、一次 SSH；「更早…」每次只加载一天。
// 超过远端 6,000 行上限（JOBS_MAX）时标 truncated 并给出实际覆盖到的最早提交时刻，不默默少算。
//
// sacct -S/-E 选的是窗口内「存在过」的作业（含之前提交、窗口内结束或仍在跑的），这里按结束时刻落在
// 哪一天（远端本地时间，按同段 tz= 换算）归段；endBefore（毫秒）再切掉已在近 48 小时视图里的部分。
//
// 成本：同一查询在 LOOKUP_CACHE_TTL_MS 内直接用缓存（含今天的范围 / 作业号只缓存 LOOKUP_RECENT_TTL_MS），
// 每次真正查询一次 SSH、经全局调度（acquireSshSlot，受全局并发上限 3 约束）；组内分页只读本机快照，0 SSH。
// 结果整份冻结成一份快照（q… 标识），组内分页的游标绑定它；定期采集的快照标识是 live-<采集时刻>，
// 新一轮采集后旧标识失效（409，由前端换新快照后重取），不会把两轮数据拼在一页里。

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { isUsageEligible } from "../usage/service.mjs";
import { buildHistoryGroupPage, buildJobsHistory, HISTORY_GROUP_PAGE_MAX, liveSnapshotId } from "./model.mjs";
import { jobsErrorReason, parseJobsOutput } from "./parse.mjs";
import { buildJobsLookupInvocation, JOBS_LOOKUP_DATE_RE, JOBS_LOOKUP_ID_RE } from "./scan.mjs";

export const LOOKUP_RANGE_DAYS_MAX = 7;
// 日期下限只防明显的误输入；实际能查多早由集群的记账保留期限决定（查不到不代表没有作业）。
export const LOOKUP_DATE_FLOOR = "2000-01-01";
export const LOOKUP_CACHE_TTL_MS = 10 * 60_000;
export const LOOKUP_RECENT_TTL_MS = 60_000;
// 分页游标的有效期（自最近一次访问起算）；过期后组内「加载更多」回 409，前端重查这一段。
export const LOOKUP_KEEP_MS = 30 * 60_000;
export const LOOKUP_CACHE_ENTRIES_MAX = 12;
export const LOOKUP_CACHE_JOBS_MAX = 30_000;
// 每台服务器同时在查的回查上限：用户连点不会排起一串 SSH。
export const LOOKUP_INFLIGHT_PER_SERVER = 2;
export const LOOKUP_SNAPSHOT_RE = /^(?:live-\d{1,15}|q[0-9a-z]{4,24})$/;
export const LOOKUP_GROUP_KEY_MAX = 200;

const DAY_MS = 86_400_000;
const ABSENT_REASON = "服务器上没有 sacct（未安装 Slurm 或不在 PATH）";
const INELIGIBLE_REASON = "该服务器不在作业采集范围";

// "2026-10-01" → 当天 UTC 零点的毫秒；不是真实日期（2026-02-30）→ null。
function dateMs(text) {
  if (!JOBS_LOOKUP_DATE_RE.test(String(text ?? ""))) return null;
  const [y, m, d] = text.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  return new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

const dateText = (ms) => new Date(ms).toISOString().slice(0, 10);

// 远端本地日期：epoch 毫秒 + tz 偏移（分钟）→ "YYYY-MM-DD"。
export function remoteDayOf(ms, tzOffsetMin) {
  return Number.isFinite(ms) && Number.isFinite(tzOffsetMin) ? dateText(ms + tzOffsetMin * 60_000) : null;
}

// 查询参数（URLSearchParams 或普通对象）→ { query } | { error }。纯函数，路由层与服务层共用。
//   job=<作业号>                         → { kind: "job", job }
//   from=YYYY-MM-DD&to=YYYY-MM-DD[&endBefore=<ms>] → { kind: "range", from, to, endBefore }
// 两类条件不能混用；范围最多 LOOKUP_RANGE_DAYS_MAX 天，不早于 LOOKUP_DATE_FLOOR，不晚于「明天」
// （按最东的时区 UTC+14 算，远端时区未知时不误拒今天）。
export function parseLookupQuery(params, { now = Date.now() } = {}) {
  const get = (name) => {
    const value = typeof params?.get === "function" ? params.get(name) : params?.[name];
    return value == null || value === "" ? null : String(value);
  };
  const job = get("job");
  const from = get("from");
  const to = get("to");
  const endBefore = get("endBefore");
  if (job !== null) {
    if (from !== null || to !== null || endBefore !== null) return { error: "job 与日期条件不能同时给" };
    if (!JOBS_LOOKUP_ID_RE.test(job)) return { error: "invalid job" };
    return { query: { kind: "job", job } };
  }
  if (from === null || to === null) return { error: "需要 job，或 from 与 to" };
  const fromMs = dateMs(from);
  const toMs = dateMs(to);
  if (fromMs === null || toMs === null) return { error: "invalid date" };
  if (fromMs > toMs) return { error: "from 晚于 to" };
  if ((toMs - fromMs) / DAY_MS + 1 > LOOKUP_RANGE_DAYS_MAX) return { error: `日期范围最多 ${LOOKUP_RANGE_DAYS_MAX} 天` };
  if (fromMs < dateMs(LOOKUP_DATE_FLOOR)) return { error: "日期太早" };
  if (toMs > dateMs(dateText(now + 14 * 3_600_000))) return { error: "日期在未来" };
  if (endBefore !== null && !/^\d{1,15}$/.test(endBefore)) return { error: "invalid endBefore" };
  return { query: { kind: "range", from, to, endBefore: endBefore === null ? null : Number(endBefore) } };
}

// 范围查询的归段（纯函数）：只留已结束、结束日在 [from, to]（远端本地日期）且早于 endBefore 的作业。
// 远端没报 tz（date +%z 失败）时没法按日切，只按 endBefore 切——宁可多列，不漏。
export function filterRangeJobs(jobs, { from, to, endBefore = null }, tzOffsetMin) {
  return (Array.isArray(jobs) ? jobs : []).filter((job) => {
    if (!job || !Number.isFinite(job.endAt)) return false;
    if (Number.isFinite(endBefore) && job.endAt >= endBefore) return false;
    const day = remoteDayOf(job.endAt, tzOffsetMin);
    return day === null || (day >= from && day <= to);
  });
}

// 作业号查询能否只用本机的近 48 小时快照回答（0 SSH）：快照里正好有这个作业号，且它不是数组本体
// （查 48213 而快照里只有 48213_3 这类任务时，更早结束的任务不在快照里，必须去远端查全）。
export function localJobMatch(snapshot, jobId) {
  if (snapshot?.state !== "ok" || !Array.isArray(snapshot.jobs)) return null;
  const exact = snapshot.jobs.filter((job) => job?.id === jobId);
  if (!exact.length) return null;
  if (!jobId.includes("_") && snapshot.jobs.some((job) => String(job?.id || "").startsWith(`${jobId}_`))) return null;
  return exact;
}

const cacheKeyOf = (serverId, query) => `${serverId}\u0000${query.kind}\u0000${query.job ?? ""}\u0000${query.from ?? ""}\u0000${query.to ?? ""}\u0000${query.endBefore ?? ""}`;

// 含今天（或明天：远端时区比本机靠东）的范围 / 作业号查询，作业可能还在变，缓存短一些。
function ttlOf(query, nowMs) {
  if (query.kind === "job") return LOOKUP_RECENT_TTL_MS;
  return query.to >= dateText(nowMs - 14 * 3_600_000) ? LOOKUP_RECENT_TTL_MS : LOOKUP_CACHE_TTL_MS;
}

export function createJobsLookup({
  getConfig,
  dataDir,
  execCollector,
  probeSshFailureReason = (code) => `ssh exit ${code}`,
  getSnapshot = () => null,
  diagnosisOf = null,
  now = Date.now,
}) {
  const entries = new Map(); // 快照标识 -> { id, serverId, key, query, snapshot, coverage, source, createdAt, accessedAt, expiresAt }
  const latest = new Map(); // 查询 key -> 最新一份的快照标识（同一查询过期后重查，旧快照仍留给分页直到 LOOKUP_KEEP_MS）
  const inflight = new Map(); // 查询 key -> Promise
  const perServer = new Map(); // serverId -> 在查的数量
  let counter = 0;

  function nextId() {
    counter = (counter + 1) % 1_679_616; // 36^4
    return `q${now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
  }

  function drop(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (latest.get(entry.key) === id) latest.delete(entry.key);
  }

  // 过期清理 + 条目 / 作业总数封顶（先丢最久没访问的）。
  function sweep() {
    const t = now();
    for (const [id, entry] of entries) if (t - entry.accessedAt > LOOKUP_KEEP_MS) drop(id);
    let jobs = 0;
    for (const entry of entries.values()) jobs += entry.snapshot.jobs.length;
    while (entries.size > LOOKUP_CACHE_ENTRIES_MAX || jobs > LOOKUP_CACHE_JOBS_MAX) {
      let oldest = null;
      for (const entry of entries.values()) if (!oldest || entry.accessedAt < oldest.accessedAt) oldest = entry;
      if (!oldest) break;
      jobs -= oldest.snapshot.jobs.length;
      drop(oldest.id);
    }
  }

  function respond(serverId, entry, cached) {
    entry.accessedAt = now();
    const history = buildJobsHistory(entry.snapshot, {
      serverId,
      snapshotId: entry.id,
      diagnosisOf: typeof diagnosisOf === "function" ? (jobId) => diagnosisOf(serverId, jobId) : null,
    });
    return { ...history, windowHours: null, query: entry.query, coverage: entry.coverage, source: entry.source, fetchedAt: entry.createdAt, cached };
  }

  // 失败 / 不可用的结果不进缓存，原样告诉用户（与定期采集同一套中文原因）。
  function failure(serverId, query, state, reason) {
    const history = buildJobsHistory({ state, reason, checkedAt: now(), user: null, jobs: [] }, { serverId });
    return { ...history, windowHours: null, query, coverage: null, source: "ssh", fetchedAt: now(), cached: false };
  }

  function store(serverId, key, query, snapshot, coverage, source) {
    const t = now();
    const entry = { id: nextId(), serverId, key, query, snapshot, coverage, source, createdAt: t, accessedAt: t, expiresAt: t + ttlOf(query, t) };
    entries.set(entry.id, entry);
    latest.set(key, entry.id);
    sweep();
    return entry;
  }

  const eligible = (config, serverId) => isDataModuleEnabled(config, "jobs") && isUsageEligible((config?.servers || []).find((s) => s.id === serverId));

  async function runRemote(serverId, key, query, acquireSshSlot) {
    const config = await getConfig();
    const server = (config?.servers || []).find((s) => s.id === serverId);
    if (!eligible(config, serverId)) return failure(serverId, query, "none", INELIGIBLE_REASON);
    const invocation = buildJobsLookupInvocation({ server, parsed: config, knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id), query });
    let release = null;
    let res;
    try {
      // 与定期采集同走调度器的全局 SSH 并发槽位（按主机记账）；没注入时（测试）直接发。
      if (typeof acquireSshSlot === "function") release = await acquireSshSlot({ hostKey: server.host || null });
      res = await execCollector(invocation, server);
    } catch (error) {
      res = { code: null, stdout: "", stderr: String(error?.message || error) };
    } finally {
      try { release?.(); } catch {}
    }
    // 查询在途期间关了模块 / 删了服务器：迟到的结果不要了。
    if (!eligible(await getConfig(), serverId)) return failure(serverId, query, "none", INELIGIBLE_REASON);
    const parsed = parseJobsOutput(res?.stdout);
    if (parsed.state === null) return failure(serverId, query, "error", `作业查询失败 (${probeSshFailureReason(res?.code ?? null, res?.stderr ?? "", res?.stdout ?? "")})`);
    if (parsed.state === "absent") return failure(serverId, query, "absent", ABSENT_REASON);
    if (parsed.state === "error") return failure(serverId, query, "error", jobsErrorReason(parsed));
    const truncated = parsed.truncated || res?.truncated === true;
    const jobs = query.kind === "range" ? filterRangeJobs(parsed.jobs, query, parsed.tzOffsetMin) : parsed.jobs;
    const submits = jobs.map((job) => job.submitAt).filter(Number.isFinite);
    const coverage = {
      kind: query.kind,
      from: query.from ?? null,
      to: query.to ?? null,
      endBefore: query.endBefore ?? null,
      // 没取全时远端保留的是作业号最大（最新）的那部分：实际覆盖从这批里最早的提交时刻开始。
      keptFrom: truncated && submits.length ? Math.min(...submits) : null,
      rowsTotal: parsed.rowsTotal,
      tzKnown: Number.isFinite(parsed.tzOffsetMin),
    };
    const snapshot = { state: "ok", checkedAt: now(), user: parsed.user, reason: null, total: jobs.length, truncated, jobs };
    return respond(serverId, store(serverId, key, query, snapshot, coverage, "ssh"), false);
  }

  // 一次回查。返回历史接口同形的响应体（另带 query / coverage / source / fetchedAt / cached），
  // 或 { busy: true }（这台服务器已有 LOOKUP_INFLIGHT_PER_SERVER 个查询在途）。
  async function lookup(serverId, query, { acquireSshSlot = null } = {}) {
    sweep();
    const key = cacheKeyOf(serverId, query);
    const hitId = latest.get(key);
    const hit = hitId ? entries.get(hitId) : null;
    if (hit && now() < hit.expiresAt) return respond(serverId, hit, true);
    if (query.kind === "job") {
      const live = getSnapshot(serverId);
      const local = localJobMatch(live, query.job);
      if (local) {
        const snapshot = { state: "ok", checkedAt: live.checkedAt, user: live.user ?? null, reason: null, total: local.length, truncated: false, jobs: local };
        return respond(serverId, store(serverId, key, query, snapshot, { kind: "job", from: null, to: null, endBefore: null, keptFrom: null, rowsTotal: local.length, tzKnown: true }, "local"), false);
      }
    }
    if (inflight.has(key)) return inflight.get(key);
    const running = perServer.get(serverId) || 0;
    if (running >= LOOKUP_INFLIGHT_PER_SERVER) return { busy: true };
    perServer.set(serverId, running + 1);
    const work = runRemote(serverId, key, query, acquireSshSlot).finally(() => {
      inflight.delete(key);
      const left = (perServer.get(serverId) || 1) - 1;
      if (left > 0) perServer.set(serverId, left);
      else perServer.delete(serverId);
    });
    inflight.set(key, work);
    return work;
  }

  // 组内「加载更多」：同一份快照里这一组的前 limit 条。快照已换代 / 过期 / 不属于这台服务器 → { expired: true }。
  async function groupPage(serverId, snapshotId, key, { limit = HISTORY_GROUP_PAGE_MAX } = {}) {
    const config = await getConfig();
    if (!eligible(config, serverId)) return { expired: true };
    const diag = typeof diagnosisOf === "function" ? (jobId) => diagnosisOf(serverId, jobId) : null;
    let snapshot = null;
    if (snapshotId.startsWith("live-")) {
      const live = getSnapshot(serverId);
      if (liveSnapshotId(live) === snapshotId) snapshot = live;
    } else {
      sweep();
      const entry = entries.get(snapshotId);
      if (entry && entry.serverId === serverId) {
        entry.accessedAt = now();
        snapshot = entry.snapshot;
      }
    }
    if (!snapshot) return { expired: true };
    return { snapshotId, ...buildHistoryGroupPage(snapshot, key, { limit, diagnosisOf: diag }) };
  }

  return { lookup, groupPage, size: () => entries.size };
}
