// 「我的作业」的纯模型：结束状态归类、同名实验归并、近 48 小时历史的展示聚合。
//
// 今日简报（lib/brief/model.mjs）与历史接口（lib/http/routes/jobs.mjs）共用这里的归类口径，
// 两处对「失败 / 取消 / 完成」的判断不会各说各话。本模块不读盘、不碰时钟。
//
// 历史接口为什么在服务端聚合：批量实验的用户近 48 小时有上千条作业（实测 1,137 条），
// 原样发给前端既大又没法看。这里先把同名实验折成组（数量 / 阶段分布 / 时间与耗时范围 / 节点），
// 组内只带最近的几条；有问题的作业排在最前（先失败、后取消），三个以上同名同状态的也折成一组
// （组内尽量带全，上限 50，并附退出码分布）。组里没带回的成员按需走 buildHistoryGroupPage（v2.51 组内「加载更多」）。

// 同名实验折叠的门槛，与作业队列（前端 render/cluster-model.js 的 JOB_GROUP_MIN）一致。
export const JOB_GROUP_MIN = 3;
export const HISTORY_WINDOW_HOURS = 48;
// 一组里随接口带回的作业条数：完成的只带最近几条（展开看个大概），有问题的尽量带全。
export const HISTORY_CHILDREN_MAX = 12;
export const HISTORY_PROBLEM_CHILDREN_MAX = 50;
// 整张表的行数上限（折叠之后）：正常情况下几十行，防的是几百个互不同名的作业。
export const HISTORY_ROWS_MAX = 300;
const NODE_LISTS_MAX = 32;
const EXITS_MAX = 3;

// sacct 的失败类终态（退出码非零的其它终态也算失败，见 jobOutcome）。
const FAILED_STATES = new Set(["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL", "DEADLINE", "PREEMPTED"]);

// 作业结局：
//   completed 正常完成 / failed 失败（含超时、内存不足、节点故障等）/ cancelled 被取消 /
//   running 运行中 / pending 排队中 / active 其它进行中的状态（收尾、挂起、重排…）/
//   other 已结束但不属于以上几类（少见状态，退出码为 0）。
export function jobOutcome(job) {
  const state = String(job?.state || "").toUpperCase();
  if (state === "COMPLETED") return "completed";
  if (FAILED_STATES.has(state)) return "failed";
  if (state === "CANCELLED") return "cancelled";
  if (state === "RUNNING") return "running";
  if (state === "PENDING") return "pending";
  if (!Number.isFinite(job?.endAt)) return "active";
  return Number(job?.exitCode) > 0 ? "failed" : "other";
}

const isEndedOutcome = (outcome) => outcome === "completed" || outcome === "failed" || outcome === "cancelled" || outcome === "other";

// 名字去掉末尾哈希（连同阶段后缀）与序号：cfa-agiter20-35607b-cfd1 → cfa-agiter20，sweep_lr_12 → sweep_lr。
// 与前端 render/cluster-model.js 的 jobBaseName 同一口径（前端不能引用 lib/，两份由 model.test.mjs 对拍）。
export function jobBaseName(name) {
  const text = String(name || "");
  const noHash = text.replace(/[-_][0-9a-f]{5,}(?:[-_].*)?$/i, "");
  return noHash.replace(/[-_]\d+$/, "") || text;
}

// 哈希之后的阶段后缀（cfa-agiter20-35607b-cfd1 → cfd1）；没有 → null。
export function jobStage(name, base) {
  const rest = String(name || "").slice(String(base || "").length);
  const match = /^[-_][0-9a-f]{5,}[-_]([A-Za-z][A-Za-z0-9]*)$/i.exec(rest);
  return match ? match[1] : null;
}

// "CANCELLED by 1001" → "1001"；没有 → null。
function cancelledBy(stateRaw) {
  const match = /\bby\s+(\d{1,10})\b/i.exec(String(stateRaw || ""));
  return match ? match[1] : null;
}

// 排序用的时刻：结束时刻优先，缺了退到开始 / 提交时刻。
const timeOf = (job) => (Number.isFinite(job.endAt) ? job.endAt : Number.isFinite(job.startAt) ? job.startAt : Number.isFinite(job.submitAt) ? job.submitAt : 0);

function jobRow(job, outcome) {
  return {
    kind: "job",
    outcome,
    id: job.id,
    name: job.name ?? null,
    state: job.state,
    exitCode: job.exitCode ?? null,
    signal: job.signal ?? null,
    cancelledBy: outcome === "cancelled" ? cancelledBy(job.stateRaw) : null,
    endAt: Number.isFinite(job.endAt) ? job.endAt : null,
    elapsedSec: Number.isFinite(job.elapsedSec) ? job.elapsedSec : null,
    nodes: job.nodes ?? null,
    partition: job.partition ?? null,
    // v2.49 失败作业诊断摘要（{ category, headline }），由 buildJobsHistory 按 diagnosisOf 填上。
    diagnosis: null,
  };
}

// 组内退出码分布（多的在前，最多 EXITS_MAX 种）：有问题的组靠它在一行里说清原因。
function exitSummary(members) {
  const counts = new Map();
  for (const { job } of members) {
    const key = `${job.exitCode ?? ""}:${job.signal ?? ""}`;
    const entry = counts.get(key) || { exitCode: job.exitCode ?? null, signal: job.signal ?? null, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || (a.exitCode ?? 0) - (b.exitCode ?? 0)).slice(0, EXITS_MAX);
}

function groupRow(key, members, outcome, childrenMax) {
  // members 已按时刻新 → 旧排好。
  const first = members[0].job;
  const base = jobBaseName(first.name);
  const sameName = members.every((m) => m.job.name === first.name);
  const stages = new Map();
  for (const { job } of members) {
    const stage = jobStage(job.name, base);
    if (stage) stages.set(stage, (stages.get(stage) || 0) + 1);
  }
  const ends = members.map((m) => m.job.endAt).filter(Number.isFinite);
  const elapsed = members.map((m) => m.job.elapsedSec).filter(Number.isFinite);
  const nodeLists = [...new Set(members.map((m) => m.job.nodes).filter(Boolean))];
  return {
    kind: "group",
    outcome,
    key,
    state: first.state,
    label: sameName ? String(first.name ?? base) : `${base}-*`,
    count: members.length,
    stages: [...stages.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    firstEndAt: ends.length ? Math.min(...ends) : null,
    lastEndAt: ends.length ? Math.max(...ends) : null,
    elapsedMinSec: elapsed.length ? Math.min(...elapsed) : null,
    elapsedMaxSec: elapsed.length ? Math.max(...elapsed) : null,
    nodeLists: nodeLists.slice(0, NODE_LISTS_MAX),
    partitions: [...new Set(members.map((m) => m.job.partition).filter(Boolean))].slice(0, 4),
    exits: exitSummary(members),
    children: members.slice(0, childrenMax).map((m) => jobRow(m.job, outcome)),
    more: Math.max(0, members.length - childrenMax),
  };
}

// 折叠组的 key 与组内次序：历史表与组内分页（buildHistoryGroupPage）共用，同一份快照上两边列出的成员一致。
const groupKeyOf = (job) => `${job.state}|${jobBaseName(job.name)}`;
const byTimeDesc = (a, b) => b.time - a.time || String(b.job.id).localeCompare(String(a.job.id), "en", { numeric: true });

// 一段（失败的 / 取消的 / 完成的）里的作业 → 行：同名同状态 ≥ groupMin 个折成组，其余逐条；按时刻新 → 旧。
function sectionRows(entries, { groupMin, childrenMax }) {
  const buckets = new Map();
  for (const entry of entries) {
    const key = groupKeyOf(entry.job);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const rows = [];
  for (const [key, members] of buckets) {
    members.sort(byTimeDesc);
    if (members.length >= groupMin) rows.push({ time: members[0].time, row: groupRow(key, members, members[0].outcome, childrenMax) });
    else for (const m of members) rows.push({ time: m.time, row: jobRow(m.job, m.outcome) });
  }
  rows.sort((a, b) => b.time - a.time);
  return rows.map((r) => r.row);
}

const EMPTY_SUMMARY = Object.freeze({ ended: 0, completed: 0, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 });

// v2.49：失败的作业行挂上诊断摘要（只读本机已有的诊断，不触发取证）。
function attachDiagnosis(row, diagnosisOf) {
  if (typeof diagnosisOf !== "function" || row.outcome !== "failed") return;
  const found = diagnosisOf(row.id);
  if (found && typeof found.category === "string" && typeof found.headline === "string") row.diagnosis = { category: found.category, headline: found.headline };
}

// 匹配发起该 Slurm 作业的 Agent 会话：按工作目录（或日志父目录）前缀与会话活跃时间窗口匹配。
export function matchJobToSession(reg, job, sessions = []) {
  if (!reg || typeof reg !== "object" || !Array.isArray(sessions) || !sessions.length) return null;
  const rawDir = reg.workDir || (typeof reg.stdout === "string" && reg.stdout.startsWith("/") ? reg.stdout.replace(/\/[^/]+$/, "") : "");
  const jobDir = String(rawDir || "").replace(/\/+$/, "");
  if (!jobDir) return null;
  const tsMs = Number.isFinite(job?.submitAt)
    ? job.submitAt
    : Number.isFinite(job?.startAt)
      ? job.startAt
      : Number.isFinite(reg.firstSeenAt)
        ? reg.firstSeenAt
        : Number.isFinite(job?.endAt)
          ? job.endAt
          : null;
  const submitSec = tsMs !== null ? tsMs / 1000 : null;
  let best = null;
  let bestDiff = Infinity;
  for (const s of sessions) {
    if (!s || typeof s.cwd !== "string" || !s.cwd) continue;
    const cwd = s.cwd.replace(/\/+$/, "");
    if (!cwd) continue;
    const pathMatch = jobDir === cwd || jobDir.startsWith(`${cwd}/`) || cwd.startsWith(`${jobDir}/`);
    if (!pathMatch) continue;
    if (submitSec !== null && Number.isFinite(s.firstSec) && Number.isFinite(s.lastSec)) {
      if (submitSec < s.firstSec - 600 || submitSec > s.lastSec + 1800) continue;
      const diff = Math.abs(submitSec - s.lastSec);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = s;
      }
    } else if (!best) {
      best = s;
    }
  }
  if (!best) return null;
  const agentName = best.agent === "claude" ? "Claude" : "Codex";
  const shortSid = String(best.sid || "").slice(0, 8);
  return {
    key: `${best.serverId}|${best.agent}|${best.sid}`,
    agent: best.agent,
    sid: best.sid,
    label: shortSid ? `${agentName} ${shortSid}` : agentName,
  };
}

function attachSession(row, sessionOf) {
  if (typeof sessionOf !== "function") return;
  const found = sessionOf(row.id, row);
  if (found && typeof found.label === "string") row.session = found;
}

// 快照的分页标识（v2.51 组内「加载更多」的游标绑定它）：定期采集的快照 = live-<采集时刻>，
// 新一轮采集换掉快照后旧标识自然失效；回查结果由 lookup.mjs 另给 q… 标识。
export function liveSnapshotId(snapshot) {
  return snapshot?.state === "ok" && Number.isFinite(snapshot.checkedAt) ? `live-${snapshot.checkedAt}` : null;
}

// 组内分页上限：一次最多带回这么多条（再多的作业用作业号 / 日期查询定位）。
export const HISTORY_GROUP_PAGE_MAX = 1000;

// 组内「加载更多」（v2.51）：同一份快照里 key 这一组的前 limit 条（与历史表组内同一次序），纯函数。
// 返回 { key, total, children, more }；快照里没有这一组 → total 0、children 空。
export function buildHistoryGroupPage(snapshot, key, { limit = HISTORY_CHILDREN_MAX, diagnosisOf = null, sessionOf = null } = {}) {
  const cap = Math.max(1, Math.min(HISTORY_GROUP_PAGE_MAX, Math.floor(Number(limit)) || HISTORY_CHILDREN_MAX));
  const members = [];
  for (const job of Array.isArray(snapshot?.jobs) ? snapshot.jobs : []) {
    if (!job || typeof job !== "object" || job.id == null) continue;
    const outcome = jobOutcome(job);
    if (!isEndedOutcome(outcome) || groupKeyOf(job) !== key) continue;
    members.push({ job, outcome, time: timeOf(job) });
  }
  members.sort(byTimeDesc);
  const children = members.slice(0, cap).map((m) => jobRow(m.job, m.outcome));
  for (const row of children) {
    attachDiagnosis(row, diagnosisOf);
    attachSession(row, sessionOf);
  }
  return { key, total: members.length, children, more: Math.max(0, members.length - children.length) };
}

// service.getSnapshot(serverId) 的快照 → 历史接口的响应体（纯函数）。
// snapshot 为 null（从未采集 / 不在采集范围）→ state "none"。
// diagnosisOf(jobId) → { category, headline } | null：失败作业的诊断摘要来源（缺省不挂，行上恒为 null）。
export function buildJobsHistory(snapshot, {
  serverId = null,
  diagnosisOf = null,
  sessionOf = null,
  snapshotId = liveSnapshotId(snapshot),
  groupMin = JOB_GROUP_MIN,
  childrenMax = HISTORY_CHILDREN_MAX,
  problemChildrenMax = HISTORY_PROBLEM_CHILDREN_MAX,
  rowsMax = HISTORY_ROWS_MAX,
} = {}) {
  const base = {
    schemaVersion: 1,
    serverId,
    windowHours: HISTORY_WINDOW_HOURS,
    state: snapshot?.state || "none",
    reason: snapshot?.reason || null,
    user: snapshot?.user || null,
    checkedAt: Number.isFinite(snapshot?.checkedAt) ? snapshot.checkedAt : null,
    total: 0,
    kept: 0,
    truncated: false,
    summary: { ...EMPTY_SUMMARY },
    rows: [],
    rowsOmitted: 0,
    snapshotId: snapshot?.state === "ok" ? snapshotId : null,
  };
  if (snapshot?.state !== "ok") return base;

  const jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
  const summary = { ...EMPTY_SUMMARY };
  const failed = [];
  const cancelled = [];
  const done = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object" || job.id == null) continue;
    const outcome = jobOutcome(job);
    if (outcome === "running" || outcome === "pending") summary[outcome] += 1;
    if (!isEndedOutcome(outcome)) continue;
    summary.ended += 1;
    summary[outcome] += 1;
    (outcome === "failed" ? failed : outcome === "cancelled" ? cancelled : done).push({ job, outcome, time: timeOf(job) });
  }
  // 有问题的排最前：先失败（含超时 / 内存不足等），再取消；之后才是完成的。
  const all = [
    ...sectionRows(failed, { groupMin, childrenMax: problemChildrenMax }),
    ...sectionRows(cancelled, { groupMin, childrenMax: problemChildrenMax }),
    ...sectionRows(done, { groupMin, childrenMax }),
  ];
  const rows = all.slice(0, rowsMax);
  // v2.49：失败的作业行（顶层的单条行，以及折叠组 children 里的每一条）挂上诊断摘要。
  if (typeof diagnosisOf === "function" || typeof sessionOf === "function") {
    for (const row of rows) {
      if (row.kind === "job") {
        attachDiagnosis(row, diagnosisOf);
        attachSession(row, sessionOf);
      } else {
        for (const child of row.children) {
          attachDiagnosis(child, diagnosisOf);
          attachSession(child, sessionOf);
        }
      }
    }
  }
  return {
    ...base,
    total: Number.isFinite(snapshot.total) ? snapshot.total : jobs.length,
    kept: jobs.length,
    truncated: snapshot.truncated === true,
    summary,
    rows,
    rowsOmitted: Math.max(0, all.length - rowsMax),
  };
}

