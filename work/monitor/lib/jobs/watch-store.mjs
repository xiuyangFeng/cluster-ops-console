// 个人关注、通知已读与资源复盘：单文件有界存储，0600 原子写，整次更新串行。
import * as nodeFsPromises from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { FORENSICS_JOB_ID_RE } from "./forensics.mjs";
import { createSubrunStore, SUBRUNS_FILE } from "./subrun-store.mjs";

export const JOB_WATCH_FILE = "job-watch.json";
export const WATCH_MAX_BYTES = 2 * 1024 * 1024;
export const WATCH_MAX_GROUPS = 40;
export const WATCH_MAX_JOBS = 200;
// 失败提醒（v2.62）每台服务器最多记这么多个「见过」的失败作业。
export const FAIL_SEEN_MAX = 2000;
const RETENTION_MS = 30 * 86400_000;
const FAIL_SEEN_KEEP_MS = 72 * 3600_000;
// 到期的「见过」成批清：最老的一条过期满一天才动手，一次把到期的全清掉。
const FAIL_SEEN_SWEEP_MS = 24 * 3600_000;
// failures（v2.62）：serverId → { since, seen: { 作业号: 结束时刻 }, introduced?, notifiedAt?, pending?: 作业号[] }，
// 失败提醒按 作业号 + 结束时刻 去重（同一个作业号重排后再失败算新的一次）、两条之间留间隔用（见 watch-auto.mjs）。
// settings[serverId]（v2.62 新增的两项）：rules（提醒规则）、autoMuted（被静音的规则 key 列表）。
// watches[].jobs[].orch（v2.62）：普通作业 stdout 读到哪了（{ path, cid, off, gap?, tries? }），见 watch-service.mjs trackStdoutCursor。
const fresh = () => ({ schemaVersion: 1, quietUntil: 0, settings: {}, watches: [], notifications: [], resources: [], failures: {} });
const clone = (value) => JSON.parse(JSON.stringify(value));
const isAuto = (watch) => Boolean(watch.auto);
const plain = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// 自动组（v2.62，带 auto.rule）跟着提醒规则走、由服务增删：服务器还在采集范围内就留着（静音与「这一批结束」的起算点
// 记在组上）；服务器退出采集范围（suspended）后与手动关注一样，过 30 天且没有在跑的作业就清掉。
function keepWatch(watch, now) {
  return watch.createdAt >= now - RETENTION_MS || watch.jobs.some((j) => ["RUNNING", "PENDING"].includes(j.state)) || (isAuto(watch) && !watch.suspended);
}

// 总上限里手动关注优先：超出 40 组 / 200 个作业时先放掉自动组（规则还在，服务之后按名额重新收进来）。
function yieldAutoGroups(data) {
  const jobs = () => data.watches.reduce((sum, watch) => sum + watch.jobs.length, 0);
  while (data.watches.length > WATCH_MAX_GROUPS || jobs() > WATCH_MAX_JOBS) {
    const index = data.watches.findIndex(isAuto);
    if (index < 0) break;
    data.watches.splice(index, 1);
  }
}

// 「见过」的失败作业：结束 48 小时后就不在采集窗口里了，留 72 小时足够。到期的成批清——逐条到期就清的话，
// 每个失败作业在 72 小时后都要为它重写一次整份文件；多留一天不碍事（留在「见过」里只会少提醒，不会多提醒）。
// 超出条数时丢最早结束的，并把 since 抬到那里——结束时刻不晚于 since 的失败不再当新的，被丢掉的不会回头再提醒一遍。
function pruneFailures(data, now) {
  for (const state of Object.values(data.failures)) {
    const all = Object.entries(state.seen);
    const oldest = all.reduce((min, [, endedAt]) => Math.min(min, endedAt), Infinity);
    const kept = oldest < now - FAIL_SEEN_KEEP_MS - FAIL_SEEN_SWEEP_MS ? all.filter(([, endedAt]) => endedAt >= now - FAIL_SEEN_KEEP_MS) : [...all];
    if (kept.length > FAIL_SEEN_MAX) {
      kept.sort((a, b) => a[1] - b[1]);
      const dropped = kept.splice(0, kept.length - FAIL_SEEN_MAX);
      state.since = Math.max(state.since, dropped.at(-1)[1]);
    }
    // 没清掉任何一条就不动 seen（连键的顺序都不变：内容没变不写盘）。
    if (kept.length !== all.length) state.seen = Object.fromEntries(kept);
  }
}

function prune(data, now, maxBytes) {
  if (!plain(data.failures)) data.failures = {};
  data.notifications = data.notifications.filter((n) => n.createdAt >= now - RETENTION_MS).slice(-200);
  data.resources = data.resources.filter((r) => r.checkedAt >= now - RETENTION_MS).slice(-300);
  data.watches = data.watches.filter((w) => keepWatch(w, now));
  yieldAutoGroups(data);
  data.watches = data.watches.slice(-WATCH_MAX_GROUPS);
  pruneFailures(data, now);
  while (Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
    if (data.notifications.length) data.notifications.shift();
    else if (data.resources.length) data.resources.shift();
    else if (data.watches.length) data.watches.splice(Math.max(0, data.watches.findIndex(isAuto)), 1);
    else if (Object.keys(data.failures).length) data.failures = {};
    else { data.settings = {}; break; }
  }
}

// 读盘时的规整：形状不对的整项丢弃（丢了的服务器下一轮重新建基线，不会补发提醒）。
function cleanFailures(value) {
  const out = {};
  if (!plain(value)) return out;
  for (const [serverId, state] of Object.entries(value)) {
    if (!plain(state) || !plain(state.seen)) continue;
    const seen = {};
    for (const [jobId, endedAt] of Object.entries(state.seen)) if (FORENSICS_JOB_ID_RE.test(jobId) && Number.isFinite(endedAt)) seen[jobId] = endedAt;
    const pending = Array.isArray(state.pending) ? state.pending.filter((jobId) => typeof jobId === "string" && FORENSICS_JOB_ID_RE.test(jobId)).slice(-FAIL_SEEN_MAX) : [];
    // 服务器 id 可以是 __proto__、constructor 这类名字：按自有属性定义，不走会改原型的普通赋值。
    Object.defineProperty(out, serverId, { enumerable: true, writable: true, configurable: true, value: {
      since: Number.isFinite(state.since) ? state.since : 0,
      seen,
      ...(state.introduced === true ? { introduced: true } : {}),
      ...(Number.isFinite(state.notifiedAt) ? { notifiedAt: state.notifiedAt } : {}),
      ...(pending.length ? { pending } : {}),
    } });
  }
  return out;
}

// fs 可注入（node:fs/promises 的形状；测试用它数写盘次数）。log：ops 日志，文件损坏时记一条警告。
export function createJobWatchStore({ filePath = null, now = Date.now, maxBytes = WATCH_MAX_BYTES, fs = nodeFsPromises, log = () => {} } = {}) {
  let data = fresh();
  let loaded = null;
  let writing = Promise.resolve();
  // 盘上那份文件的原文：最近一次读到的或写成的。作业采集每一轮都会走 update()，绝大多数轮次什么都没改——
  // 候选内容与它逐字节相同就不重写（现役文件约 113 KB、每轮一次）。只在读到 / 写成之后更新：
  // 写失败时它还是更早的那份，下一次 update 比出不同照样重试。
  let onDisk = null;
  function load() {
    loaded ??= (async () => {
      if (!filePath) return;
      try {
        if ((await fs.stat(filePath)).size > maxBytes) return;
        const raw = await fs.readFile(filePath, "utf8");
        let value;
        try {
          value = JSON.parse(raw);
        } catch (err) {
          // 解析不了：先留档（关注列表与提醒规则只存在这一份里），再按空表重来；下次写盘写新文件。
          if (!isParseFailure(err)) throw err;
          await archiveCorruptFile(filePath, { fs, now, log, label: "作业关注与提醒规则" });
          return;
        }
        onDisk = raw;
        if (value?.schemaVersion !== 1 || !Array.isArray(value.watches) || !Array.isArray(value.notifications) || !Array.isArray(value.resources)) return;
        data = { ...fresh(), ...value, settings: plain(value.settings) ? value.settings : {}, failures: cleanFailures(value.failures) };
        // 自动组的 auto 形状不对就整组丢掉（规则还在，服务会重建），不能把它当成手动关注留下。
        data.watches = data.watches.filter((w) => typeof w?.id === "string" && typeof w.serverId === "string" && Array.isArray(w.jobs) && w.jobs.every((j) => j && FORENSICS_JOB_ID_RE.test(j.id))
          && (w.auto === undefined || (plain(w.auto) && typeof w.auto.rule === "string" && Number.isFinite(w.auto.doneAt))));
        yieldAutoGroups(data);
        data.watches = data.watches.slice(-WATCH_MAX_GROUPS);
        let keptJobs = 0;
        data.watches = data.watches.filter((w) => { keptJobs += w.jobs.length; return keptJobs <= WATCH_MAX_JOBS; });
        data.notifications = data.notifications.filter((n) => typeof n?.id === "string" && typeof n.serverId === "string" && Number.isFinite(n.createdAt));
        data.resources = data.resources.filter((r) => r && FORENSICS_JOB_ID_RE.test(r.jobId) && typeof r.serverId === "string" && Number.isFinite(r.checkedAt));
        prune(data, now(), maxBytes);
      } catch { data = fresh(); }
    })();
    return loaded;
  }
  async function snapshot() { await load(); await writing.catch(() => {}); return clone(data); }
  function update(fn) {
    const next = writing.catch(() => {}).then(async () => {
      await load();
      const candidate = clone(data);
      const result = await fn(candidate);
      prune(candidate, now(), maxBytes);
      const body = filePath ? JSON.stringify(candidate) : null;
      if (filePath && body !== onDisk) {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFileAtomic(filePath, body, { fs });
        onDisk = body;
      }
      data = candidate; // 持久化失败不谎报成功，不丢此前已确认的偏好。
      return result;
    });
    writing = next;
    return next;
  }
  // 编排型作业的子任务游标（v2.51）放在同目录的独立有界文件里，随关注存储一起创建与 flush。
  const subruns = createSubrunStore({ filePath: filePath ? path.join(path.dirname(filePath), SUBRUNS_FILE) : null, now, fs, log });
  return { load, snapshot, update, subruns, flush: () => Promise.all([writing, subruns.flush()]) };
}
