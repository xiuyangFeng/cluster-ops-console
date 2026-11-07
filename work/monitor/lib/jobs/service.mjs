// 「我的作业」服务：一轮 sacct 采集 → 每台服务器一份内存快照，供每日简报与「我的历史」接口读取。
//
// 采集范围与 Agent 用量同一口径（isUsageEligible：团队服务器、未禁用、未关监控）。
// 每轮覆盖近 48 小时，快照只放内存、不落盘（重启后下一轮 5 分钟内补齐）。
// 扫描只走 SSH（不经隧道 / 代理），结果只进本服务的快照：jobs:<serverId> 探针结果
// 与 usage 一样不被状态仓、事件、指标任何一处消费，不参与判级。
//
// getSnapshot(serverId) 契约（从未扫描过 → null）：
//   { state: "ok"|"absent"|"error", checkedAt: <ms>, user: string|null, reason: string|null,
//     total: <远端 sacct 的总行数>, truncated: boolean,
//     jobs: [{ id, name, state, stateRaw, exitCode, signal, submitAt, startAt, endAt, elapsedSec, nodes, partition }] }
// 时间为 epoch 毫秒或 null；jobs 按提交时刻倒序、最多 JOBS_MAX（6000）条；state 非 ok 时 jobs 为空数组。
// truncated = 这一轮没拿全（远端行数超过上限，或 SSH 输出被本机接收上限截断）：按 jobs 算出来的
// 合计只是下限，简报与历史页都要把这一点说出来，不能当成完整数字。
//
// v2.49 失败作业诊断（设计 docs/superpowers/specs/2026-10-05-job-failure-diagnosis-design.md）：
//   - 登记：slow 采集的 slurm 段带回本用户在队作业的日志路径模板（jobreg=），observeSlurmSection
//     存进登记表（registry.mjs）；完整视图里有作业从队列消失 → 提前跑一轮本探针（不等 5 分钟），
//     好赶在 MinJobAge（300s）内用 scontrol 取到展开好的路径与脚本。还没在 sacct 里看到它结束的，
//     后面两轮 slow 采集再各催一次。
//   - 取证：一轮 sacct 里出现本机还没诊断过的 FAILED / TIMEOUT / OUT_OF_MEMORY / NODE_FAIL 作业 →
//     同一轮里接着发一次取证 SSH（forensics.mjs，每轮最多一次、最多 20 个作业，新失败优先；
//     超过 20 个时每个数组作业先取 1 个代表，其余留给后面几轮）。分类在本机（diagnose.mjs），
//     结果入 diagnoses-store.mjs，每个作业只诊断一次；没取回来的作业最多重试 3 轮。
//   - 设置页关掉「我的作业」模块：不登记、不取证（探针本身也不注册），读接口回 { disabled: true }。
//
// v2.62 提醒规则：取证之后同一轮里交给关注服务（watch-service.mjs）——新失败的作业合成一条提醒（用刚取到的诊断写原因）、
// 规则命中的作业自动进关注组。不多发 SSH。

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { parseSlurmSection } from "../slurm.mjs";
import { isUsageEligible } from "../usage/service.mjs";
import { diagnoseJob, groupDiagnoses } from "./diagnose.mjs";
import { createDiagnosesStore } from "./diagnoses-store.mjs";
import { buildForensicsInvocation, FORENSICS_BATCH_MAX, FORENSICS_JOB_ID_RE, parseForensicsOutput } from "./forensics.mjs";
import { createLogReadbackService } from "./log-readback.mjs";
import { matchJobToSession } from "./model.mjs";
import { jobsErrorReason, parseJobsOutput } from "./parse.mjs";
import { createJobsLookup } from "./lookup.mjs";
import { createJobRegistry, parseJobRegSection } from "./registry.mjs";
import { buildJobsScanInvocation } from "./scan.mjs";
import { createJobWatchService } from "./watch-service.mjs";

export const JOBS_SCAN_INTERVAL_MS = 5 * 60000;
export const isJobsEligible = isUsageEligible;

// 触发取证的失败终态（PREEMPTED / DEADLINE 等原因已写在状态里，不取证）。
export const DIAGNOSE_STATES = new Set(["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"]);
// 「该取证的失败作业」：失败诊断与失败提醒（v2.62，watch-service.mjs）共用这一个判定，两边口径不会走样。
const isDiagnosableFailure = (job) => DIAGNOSE_STATES.has(job.state) && FORENSICS_JOB_ID_RE.test(job.id);
// 同一作业没取回来（SSH 失败 / 远端预算用完没轮到）的重试轮数上限。
export const FORENSICS_ATTEMPTS_MAX = 3;
// 作业消失后的提前复核：两次催促至少隔 50s（slow 采集 60s 一轮，每轮至多催一次），每个作业最多催 3 次。
export const EARLY_SCAN_COOLDOWN_MS = 50_000;
export const EARLY_SCAN_ATTEMPTS_MAX = 3;

const ABSENT_REASON = "服务器上没有 sacct（未安装 Slurm 或不在 PATH）";

// registry / diagnoses 缺省为只在内存里的实例（测试与未接存储的装配）；生产由装配处给落盘的实例。
export function createJobsService({
  getConfig,
  dataDir,
  execCollector,
  probeSshFailureReason,
  now = Date.now,
  registry = createJobRegistry({ now }),
  diagnoses = createDiagnosesStore({ now }),
  watchStore = null,
  listSessions = null,
  log = () => {},
}) {
  const snapshots = new Map(); // serverId -> 最近一轮快照
  const attempts = new Map(); // `${serverId}\0${jobId}` -> 没取回来的次数
  const recheck = new Map(); // serverId -> Map(jobId -> 已催次数)：从队列消失、还没在 sacct 里看到结束的作业
  const lastEarlyAt = new Map(); // serverId -> 上次提前复核时刻
  let earlyScan = null; // (serverId) => void：由探针注册方绑定（scheduler.forceRun）
  const ready = Promise.all([registry.load(), diagnoses.load(), watchStore?.load()]).catch(() => {});
  const watch = watchStore
    ? createJobWatchService({ store: watchStore, registry, getConfig, getSnapshot, dataDir, execCollector, now, isFailure: isDiagnosableFailure, diagnosisOf: failureCause, scanIntervalMs: JOBS_SCAN_INTERVAL_MS })
    : null;
  // v2.51 日志按段向前读取：只读本机登记 / 诊断记录里的路径，每段一次 SSH（槽位由路由注入的调度器给）。
  const readback = createLogReadbackService({ registry, diagnoses, watchStore, getConfig, dataDir, execCollector, probeSshFailureReason, ready, now });
  // v2.51 按需回查（lookup.mjs）：结果只读给用户看，不进 snapshots、不取证、不提醒、不进简报。
  const lookups = createJobsLookup({ getConfig, dataDir, execCollector, probeSshFailureReason, getSnapshot, diagnosisOf, now });
  const inFlight = new Set();
  const pendingMutations = new Set();
  function track(work, pending = inFlight) {
    pending.add(work);
    work.finally(() => pending.delete(work)).catch(() => {});
    return work;
  }

  function record(serverId, snapshot) {
    snapshots.set(serverId, snapshot);
    return snapshot;
  }

  async function runScan(serverId) {
    const config = await getConfig();
    const server = (config.servers || []).find((s) => s.id === serverId);
    if (!isJobsEligible(server) || !isDataModuleEnabled(config, "jobs")) {
      snapshots.delete(serverId);
      if (watch) await watch.view();
      return { level: "skipped", reason: "该服务器不在作业采集范围", data: null };
    }
    const invocation = buildJobsScanInvocation({
      server,
      parsed: config,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
    });
    let res;
    try {
      res = await execCollector(invocation, server);
    } catch (error) {
      res = { code: null, stdout: "", stderr: String(error?.message || error) };
    }
    const { stdout, stderr, code } = res || {};
    // 采集在途期间用户可能关模块 / 删服务器；迟到结果不可再发提醒。
    const current = await getConfig();
    if (!isDataModuleEnabled(current, "jobs") || !isJobsEligible((current.servers || []).find((s) => s.id === serverId))) {
      snapshots.delete(serverId);
      return { level: "skipped", reason: "作业采集已关闭", data: null };
    }
    const parsed = parseJobsOutput(stdout);
    const base = { checkedAt: now(), user: parsed.user, total: 0, truncated: false };

    if (parsed.state === null) {
      // 没有 state 行 = 远端脚本没跑到判定处（SSH 失败 / 被超时打断）。
      const reason = `作业查询失败 (${probeSshFailureReason(code, stderr, stdout)})`;
      record(serverId, { state: "error", ...base, reason, jobs: [] });
      return { level: "error", reason, data: { state: "error" } };
    }
    if (parsed.state === "absent") {
      record(serverId, { state: "absent", ...base, reason: ABSENT_REASON, jobs: [] });
      return { level: "ok", reason: ABSENT_REASON, data: { state: "absent" } };
    }
    if (parsed.state === "error") {
      const reason = jobsErrorReason(parsed);
      record(serverId, { state: "error", ...base, reason, jobs: [] });
      return { level: "error", reason, data: { state: "error", error: parsed.error } };
    }
    // res.truncated：SSH 输出撞到本机接收上限（exec 丢弃了超出的部分），同样算没拿全。
    const truncated = parsed.truncated || res?.truncated === true;
    const total = Math.max(parsed.rowsTotal ?? 0, parsed.jobs.length);
    record(serverId, { state: "ok", ...base, total, truncated, reason: null, jobs: parsed.jobs });
    settleRecheck(serverId, parsed.jobs);
    // 快照先落内存（读接口立即可见），再做本轮取证。
    const forensics = isDataModuleEnabled(config, "jobs") ? await diagnoseNewFailures(server, config, parsed.jobs) : null;
    if (watch) await watch.scan(serverId, getSnapshot(serverId));
    return {
      level: "ok",
      reason: truncated
        ? `作业已同步（近 2 天共 ${total} 个，只取到最新 ${parsed.jobs.length} 个）`
        : `作业已同步（近 2 天 ${parsed.jobs.length} 个）`,
      data: { state: "ok", count: parsed.jobs.length, total, truncated, badLines: parsed.badLines, ...(forensics ? { forensics } : {}) },
    };
  }

  // 返回副本：调用方改动不回写内存快照。
  function getSnapshot(serverId) {
    const snapshot = snapshots.get(serverId);
    return snapshot ? { ...snapshot, jobs: snapshot.jobs.map((job) => ({ ...job })) } : null;
  }

  // ---- 失败作业诊断 ----

  const attemptKey = (serverId, jobId) => `${serverId}\u0000${jobId}`;

  // 本轮该取证的作业：失败终态、本机没诊断过、重试没用完；新失败优先。
  // 超过上限时每个数组作业先取 1 个代表（同一数组多半同因），剩下的名额再按时间补。
  function pickForensicsBatch(serverId, jobs) {
    const candidates = jobs
      .filter(isDiagnosableFailure)
      .filter((job) => !diagnoses.has(serverId, job.id) && (attempts.get(attemptKey(serverId, job.id)) || 0) < FORENSICS_ATTEMPTS_MAX)
      .sort((a, b) => (b.endAt ?? 0) - (a.endAt ?? 0));
    if (candidates.length <= FORENSICS_BATCH_MAX) return candidates;
    const picked = [];
    const rest = [];
    const arrays = new Set();
    for (const job of candidates) {
      const array = /^(\d+)_\d+$/.exec(job.id)?.[1];
      if (array && arrays.has(array)) {
        rest.push(job);
        continue;
      }
      if (array) arrays.add(array);
      picked.push(job);
    }
    return [...picked, ...rest].slice(0, FORENSICS_BATCH_MAX);
  }

  async function diagnoseNewFailures(server, config, jobs) {
    await ready;
    const batch = pickForensicsBatch(server.id, jobs);
    if (!batch.length) return null;
    const invocation = buildForensicsInvocation({
      server,
      parsed: config,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
      jobs: batch.map((job) => ({ id: job.id, reg: registry.lookup(server.id, job.id) })),
    });
    let res;
    try {
      res = await execCollector(invocation, server);
    } catch (error) {
      res = { code: null, stdout: "", stderr: String(error?.message || error) };
    }
    const parsed = parseForensicsOutput(res?.stdout);
    const byId = new Map(parsed.jobs.map((item) => [item.id, item]));
    const items = [];
    for (const job of batch) {
      const found = byId.get(job.id);
      const key = attemptKey(server.id, job.id);
      if (!found) {
        attempts.set(key, (attempts.get(key) || 0) + 1);
        continue;
      }
      attempts.delete(key);
      const diagnosis = diagnoseJob({
        state: job.state,
        exitCode: job.exitCode,
        signal: job.signal,
        elapsedSec: job.elapsedSec,
        nodes: job.nodes,
        tool: found.tool,
        files: found.files,
        script: found.script,
        subruns: found.subruns,
        dispatch: found.dispatch,
      });
      items.push({
        jobId: job.id,
        serverId: server.id,
        name: job.name ?? found.name,
        state: job.state,
        exitCode: job.exitCode,
        endedAt: job.endAt,
        category: diagnosis.category,
        headline: diagnosis.headline,
        evidence: diagnosis.evidence,
        files: found.files.map((file) => ({ path: file.path, role: file.role, size: file.size, tail: file.tail })),
        script: found.script,
        source: found.source,
      });
    }
    // 重试计数只防同一批作业反复失败；异常增长（几千个不同作业）时整体清掉，内存有界。
    if (attempts.size > 4000) attempts.clear();
    const stored = await diagnoses.putMany(items);
    if (!parsed.jobs.length) {
      log(`job forensics failed on ${server.id}: ${probeSshFailureReason(res?.code ?? null, res?.stderr ?? "", res?.stdout ?? "")}`, { level: "warn", event: "jobs" });
    }
    return { requested: batch.length, diagnosed: stored, badLines: parsed.badLines };
  }

  // ---- 登记与提前复核 ----

  // 这一轮 sacct 已经看到结束的作业不必再催。
  function settleRecheck(serverId, jobs) {
    const pending = recheck.get(serverId);
    if (!pending) return;
    for (const job of jobs) if (pending.has(job.id) && Number.isFinite(job.endAt)) pending.delete(job.id);
    if (!pending.size) recheck.delete(serverId);
  }

  function requestEarlyScan(serverId) {
    const pending = recheck.get(serverId);
    if (!pending?.size || !earlyScan) return false;
    if (now() - (lastEarlyAt.get(serverId) ?? -Infinity) < EARLY_SCAN_COOLDOWN_MS) return false;
    lastEarlyAt.set(serverId, now());
    for (const [id, count] of pending) {
      if (count + 1 >= EARLY_SCAN_ATTEMPTS_MAX) pending.delete(id);
      else pending.set(id, count + 1);
    }
    if (!pending.size) recheck.delete(serverId);
    try {
      earlyScan(serverId);
    } catch {}
    return true;
  }

  // slow 采集每轮调用（lib/probes/collect.mjs 的 onSlurmSection）：登记在队作业，必要时提前复核。
  async function observeSlurmSection(serverId, text) {
    const config = await getConfig();
    if (!isDataModuleEnabled(config, "jobs")) { if (watch) await watch.view(); return { observed: false }; }
    const server = (config?.servers || []).find((s) => s.id === serverId);
    if (!isJobsEligible(server)) return { observed: false };
    if (watch) await watch.observeQueue(serverId, parseSlurmSection(text, { checkedAt: now() }));
    const parsed = parseJobRegSection(text);
    if (!parsed) return { observed: false };
    const { added, disappeared } = await registry.observe(serverId, parsed);
    if (disappeared.length) {
      const pending = recheck.get(serverId) || new Map();
      for (const id of disappeared) if (!pending.has(id)) pending.set(id, 0);
      recheck.set(serverId, pending);
    }
    return { observed: true, added, disappeared, early: requestEarlyScan(serverId) };
  }

  // 探针注册方（register.mjs）绑定 / 解绑提前复核的出口；jobs 模块关闭时绑 null。
  function bindEarlyScan(fn) {
    earlyScan = typeof fn === "function" ? fn : null;
    if (watch) track(watch.view()).catch(() => {}); // 热载时清理已关闭模块/服务器的通知资格。
  }

  // ---- 读接口 ----

  // 历史行 / 简报用的摘要：{ category, headline } | null（未诊断、或存储还没载入）。
  function diagnosisOf(serverId, jobId) {
    const item = diagnoses.get(serverId, jobId);
    return item ? { category: item.category, headline: item.headline } : null;
  }

  // 关联发起该作业的 Agent 会话（基于登记表路径与会话时间窗口）。
  function sessionOf(serverId, jobId, row = null) {
    if (typeof listSessions !== "function") return null;
    const reg = registry.lookup(serverId, jobId);
    if (!reg) return null;
    const sessions = listSessions(serverId);
    return matchJobToSession(reg, row, sessions);
  }

  // 失败提醒正文里的原因（v2.62）。同一个作业号可能失败两次（节点故障后重排、再次失败），而诊断每个作业号只存一份：
  // 给了结束时刻且与诊断那次对不上，说明诊断是上一次失败的，不拿来说这一次。
  function failureCause(serverId, jobId, endAt = null) {
    const item = diagnoses.get(serverId, jobId);
    if (!item || (Number.isFinite(endAt) && Number.isFinite(item.endedAt) && item.endedAt !== endAt)) return null;
    return { category: item.category, headline: item.headline };
  }

  // GET /api/jobs/diagnoses 的响应体。脚本原文不随列表返回（按需走 getDiagnosisScript）。
  async function listDiagnoses(serverId, { since = null } = {}) {
    await ready;
    const items = diagnoses.list(serverId, { since }).map((item) => ({
      jobId: item.jobId,
      serverId: item.serverId,
      name: item.name,
      state: item.state,
      exitCode: item.exitCode,
      endedAtMs: item.endedAt,
      category: item.category,
      headline: item.headline,
      evidence: item.evidence,
      files: item.files,
      hasScript: Boolean(item.script),
      source: item.source,
    }));
    return { items, groups: groupDiagnoses(items) };
  }

  async function getDiagnosisScript(serverId, jobId) {
    await ready;
    return diagnoses.get(serverId, jobId)?.script ?? null;
  }

  return {
    runScan: (serverId) => track(runScan(serverId)),
    getSnapshot,
    observeSlurmSection: (serverId, text) => track(observeSlurmSection(serverId, text)),
    bindEarlyScan,
    diagnosisOf,
    sessionOf,
    listDiagnoses,
    getDiagnosisScript,
    readLogSegment: (serverId, query, options) => track(readback.read(serverId, query, options)),
    // 诊断存储载入后再回查：回查行上的诊断摘要读的是同一份存储。
    lookupHistory: (serverId, query, options) => track(ready.then(() => lookups.lookup(serverId, query, options))),
    historyGroupPage: (serverId, snapshotId, key, options) => ready.then(() => lookups.groupPage(serverId, snapshotId, key, options)),
    getWatchView: watch ? (serverId) => track(watch.view(serverId)) : null,
    changeWatch: watch ? (serverId, body) => track(watch.change(serverId, body), pendingMutations) : null,
    flush: async ({ waitMs = 1000 } = {}) => {
      // HTTP 用户变更必须保存完；采集可能还在等 SSH，不能占满桌面热重启的 8 秒退出预算。
      await Promise.allSettled([...pendingMutations]);
      if (inFlight.size) {
        let timer = null;
        try {
          await Promise.race([
            Promise.allSettled([...inFlight]),
            new Promise((resolve) => { timer = setTimeout(resolve, Number.isFinite(waitMs) ? Math.max(0, Math.min(1000, waitMs)) : 1000); }),
          ]);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }
      // 超时只是停止等远端结果；已经排入本机的写入仍全部排干。
      await Promise.all([registry.flush?.(), diagnoses.flush?.(), watchStore?.flush()]);
    },
    ready: () => ready,
  };
}
