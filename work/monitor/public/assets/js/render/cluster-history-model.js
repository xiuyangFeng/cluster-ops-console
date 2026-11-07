// cluster-history-model.js —— 服务器页「我的历史 · 48 小时」的纯模型（无 DOM，Node 可直接测）。
//
// 数据源：GET /api/jobs?serverId=（后端 lib/jobs/model.mjs buildJobsHistory）。合计、排序（先失败、
// 后取消、再完成）与同名实验归并都在服务端做完——近 48 小时可能有上千条作业，不原样发给前端；
// 这里只把它变成可显示的文案，并处理筛选与展开。时刻一律按北京时间（与用量页、简报同一口径）。
// 失败作业诊断（v2.49）并在这里：失败行带 diag（原因行 / 展开详情），顶部同因合并见 causes（模型在
// cluster-diagnosis-model.js）；诊断接口不可用时 diag 恒为 null、causes 为空，输出与没有诊断时一致。
// 按需回查（v2.51）并在这里：lookup = 回查加载器的状态（cluster-history-lookup.js）。有查询时表格换成查询结果；
// 「更早…」加载的各段带段头接在后面；组内「加载更多」取回的成员替换组内带回的那几条。没有 lookup 时输出与之前一致。
import { formatRelativeTime } from "../store.js";
import { causesModel, diagnosisIndex, diagnosisModel, historyWindowStart } from "./cluster-diagnosis-model.js";
import { GROUP_PAGE_MAX, GROUP_PAGE_STEP, groupExtraOf, liveWindowStart, nextEarlierSegment, segmentSummaryText } from "./cluster-history-lookup.js";
import { computeDurationBaselines, evaluateDurationAnomaly, formatCount, formatDuration, nodeRangeOf } from "./cluster-model.js";
import { clockOf, dayKeyOf, monthDay, offsetDay } from "./usage-model.js";

export const HISTORY_FILTERS = Object.freeze(["all", "problem", "done"]);

// sacct 采集 5 分钟一轮（后端 lib/jobs/service.mjs JOBS_SCAN_INTERVAL_MS）：列表跟着它刷新，不比它更勤。
export const HISTORY_SCAN_INTERVAL_MS = 5 * 60_000;
const HISTORY_RETRY_MS = 60_000;
const HISTORY_SLACK_MS = 15_000;

// 下一次拉取的等待：上次采集时刻 + 一轮间隔 + 一点余量；还没有快照 / 采集迟到时每分钟看一次。
export function nextHistoryDelay(checkedAt, now = Date.now()) {
  if (!Number.isFinite(checkedAt)) return HISTORY_RETRY_MS;
  const untilNextScan = checkedAt + HISTORY_SCAN_INTERVAL_MS + HISTORY_SLACK_MS - now;
  return Math.min(HISTORY_SCAN_INTERVAL_MS + HISTORY_SLACK_MS, Math.max(HISTORY_RETRY_MS, untilNextScan));
}

// 结束时刻（epoch 毫秒）→「今天 11:54」「昨天 17:36」「10.1 09:20」。
export function endTextOf(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "—";
  const sec = ms / 1000;
  const day = dayKeyOf(sec);
  const today = dayKeyOf(now / 1000);
  if (day === today) return `今天 ${clockOf(sec)}`;
  if (day === offsetDay(today, -1)) return `昨天 ${clockOf(sec)}`;
  return `${monthDay(day)} ${clockOf(sec)}`;
}

// 一组实验的结束时刻范围：同一天只写一次日期（「今天 09:12 – 11:54」），落在同一分钟只写一个时刻。
function endRangeText(first, last, now) {
  if (!Number.isFinite(last)) return "—";
  const from = endTextOf(first, now);
  const to = endTextOf(last, now);
  if (!Number.isFinite(first) || from === to) return to;
  const sameDay = dayKeyOf(first / 1000) === dayKeyOf(last / 1000);
  return `${from} – ${sameDay ? clockOf(last / 1000) : to}`;
}

// 耗时范围，写成同一单位省地方：「38 – 61 分」「0.6 – 6.2 小时」；两端相同只写一个。
export function formatDurationRange(loSec, hiSec) {
  const lo = Number.isFinite(loSec) ? loSec : null;
  const hi = Number.isFinite(hiSec) ? hiSec : null;
  if (lo == null && hi == null) return "—";
  const single = (v) => formatDuration(v) || "0 秒";
  if (lo == null || hi == null) return single(lo ?? hi);
  if (single(lo) === single(hi)) return single(lo);
  if (hi < 60) return `${Math.floor(lo)} – ${Math.floor(hi)} 秒`;
  if (hi < 100 * 60) return `${Math.floor(lo / 60)} – ${Math.floor(hi / 60)} 分`;
  const tenth = (v, unit) => String(Math.round((v / unit) * 10) / 10);
  if (hi < 48 * 3600) return `${tenth(lo, 3600)} – ${tenth(hi, 3600)} 小时`;
  return `${tenth(lo, 86400)} – ${tenth(hi, 86400)} 天`;
}

// sacct 终态 → 中文。认不出的：失败类统一写「失败」，其余原样显示。
const STATE_TEXT = {
  COMPLETED: "完成",
  FAILED: "失败",
  TIMEOUT: "超时",
  OUT_OF_MEMORY: "内存不足",
  NODE_FAIL: "节点故障",
  BOOT_FAIL: "启动失败",
  DEADLINE: "超过截止",
  PREEMPTED: "被抢占",
  CANCELLED: "已取消",
};
// 状态点 / 汇总数字的语气，与行首状态色条的级别（只有有问题的行才有）。
const OUTCOME_TONE = { completed: "ok", failed: "critical", cancelled: "warn" };
const OUTCOME_LEVEL = { failed: "critical", cancelled: "warn" };

function stateOf(row) {
  const key = String(row.state || "").toUpperCase();
  return { label: STATE_TEXT[key] || (row.outcome === "failed" ? "失败" : key || "未知"), tone: OUTCOME_TONE[row.outcome] || "idle" };
}

const kindOf = (row) => (row.outcome === "failed" || row.outcome === "cancelled" ? "problem" : "done");

// 「退出」一列：完成写 0；有问题的写原因里最要紧的一条。
function exitTextOf({ outcome, state, exitCode, signal, cancelledBy }) {
  if (outcome === "completed") return "0";
  if (state === "TIMEOUT") return "到达时限";
  if (state === "OUT_OF_MEMORY") return "超出申请内存";
  if (outcome === "cancelled") return cancelledBy ? "手动取消" : "—";
  if (Number(exitCode) > 0) return `退出码 ${Number(exitCode)}`;
  if (Number(signal) > 0) return `信号 ${Number(signal)}`;
  return "—";
}

// 悬停提示里的补充：137 = 128 + SIGKILL，绝大多数是内存不足被杀（与简报同一说法）。
function exitHintOf(row) {
  const text = exitTextOf(row);
  if (text === "—" || text === "0") return "";
  return Number(row.exitCode) === 137 ? `${text}，疑似内存不足` : text;
}

function groupExitText(group) {
  if (group.outcome === "completed") return "—";
  if (group.state === "TIMEOUT" || group.state === "OUT_OF_MEMORY") return exitTextOf(group);
  const children = Array.isArray(group.children) ? group.children : [];
  if (group.outcome === "cancelled") return children.length && children.every((c) => c.cancelledBy) ? "手动取消" : "—";
  const exits = (Array.isArray(group.exits) ? group.exits : []).filter((e) => Number(e.exitCode) > 0 || Number(e.signal) > 0);
  if (!exits.length) return "—";
  const first = exitTextOf({ outcome: group.outcome, state: group.state, exitCode: exits[0].exitCode, signal: exits[0].signal });
  return exits.length > 1 ? `${first} 等 ${exits.length} 种` : first;
}

// 节点 · 分区。sacct 对还没分到节点就结束的作业写 "None assigned"。
function whereText(nodeLists, partitions) {
  const lists = (Array.isArray(nodeLists) ? nodeLists : [nodeLists]).filter((n) => typeof n === "string" && n);
  const assigned = lists.filter((n) => n !== "None assigned");
  const nodes = assigned.length ? nodeRangeOf(assigned, { withCount: false }) : lists.length ? "未分配" : "";
  const parts = (Array.isArray(partitions) ? partitions : [partitions]).filter((p) => typeof p === "string" && p);
  return [nodes, parts.join(" / ")].filter(Boolean).join(" · ") || "—";
}

function jobModel(row, now, { child = false, parent = "", diag = null, baselines = null } = {}) {
  const state = stateOf(row);
  const endText = endTextOf(row.endAt, now);
  const elapsedText = Number.isFinite(row.elapsedSec) ? formatDuration(row.elapsedSec) || "0 秒" : "—";
  const where = whereText(row.nodes, row.partition);
  const exitHint = exitHintOf(row);
  const name = typeof row.name === "string" ? row.name : "";
  const slowAnomaly = baselines ? evaluateDurationAnomaly(name, row.elapsedSec, baselines) : null;
  const session = row.session && typeof row.session === "object" ? row.session : null;
  return {
    kind: "job",
    key: String(row.id),
    id: String(row.id),
    name,
    rowKind: kindOf(row),
    level: OUTCOME_LEVEL[row.outcome] || "",
    state,
    endText,
    elapsedText,
    slowAnomaly,
    session,
    where,
    exitText: exitTextOf(row),
    child,
    parent,
    diag,
    title: [
      `作业 ${row.id}${name ? ` · ${name}` : ""}`,
      `${state.label}${exitHint ? ` · ${exitHint}` : ""}`,
      `结束于 ${endText} · 耗时 ${elapsedText}`,
      slowAnomaly ? slowAnomaly.title : "",
      session ? `关联 Agent 会话：${session.agent || "Agent"} · ${session.title || session.id}` : "",
      where === "—" ? "" : where,
    ].filter(Boolean).join("\n"),
  };
}

function groupModel(group, now, expanded) {
  const state = stateOf(group);
  const count = Number(group.count) || 0;
  const stagesText = (Array.isArray(group.stages) ? group.stages : []).map((s) => `${s.name} ×${s.count}`).join(" · ");
  const endText = endRangeText(group.firstEndAt, group.lastEndAt, now);
  const elapsedText = formatDurationRange(group.elapsedMinSec, group.elapsedMaxSec);
  const exitText = groupExitText(group);
  return {
    kind: "group",
    key: String(group.key),
    label: String(group.label ?? ""),
    count,
    rowKind: kindOf(group),
    level: OUTCOME_LEVEL[group.outcome] || "",
    state: { label: `${formatCount(count)} ${state.label}`, tone: state.tone },
    stagesText,
    endText,
    elapsedText,
    where: whereText(group.nodeLists, group.partitions),
    exitText,
    expanded,
    title: [
      `${group.label} · ${formatCount(count)} 个作业${expanded ? "" : "（点击展开）"}`,
      `${state.label}${exitText === "—" ? "" : ` · ${exitText}`}`,
      `结束于 ${endText} · 耗时 ${elapsedText}`,
      stagesText ? `阶段 ${stagesText}` : "",
    ].filter(Boolean).join("\n"),
  };
}

const EMPTY_BY_FILTER = {
  all: "近 48 小时没有结束的作业",
  problem: "近 48 小时没有失败或取消的作业",
  done: "近 48 小时没有完成的作业",
};

// 近 48 小时视图的空状态 spec（只覆盖「该说清楚」的几种；其余仍是一句话，见 emptyTextFor）：
//   一直没取到（请求失败 / sacct 失败）→ 红色「暂时取不到」+ 原因；全部为空 → 说明会出现什么、多久同步一次，
//   并给「按作业号或日期查」（聚焦查询框，cluster-panel.js 的 [data-cl-lookup-focus]）。
function emptyStateFor({ data, error, filter }) {
  if (!data) {
    return error ? { tone: "error", icon: "cloudOff", title: "暂时取不到作业历史", body: `${error}；稍后会自动重试。` } : null;
  }
  if (data.state === "error") {
    return { tone: "error", icon: "cloudOff", title: "暂时取不到作业历史", body: `作业记录读取失败${data.reason ? `：${data.reason}` : ""}。作业记录每 5 分钟经 sacct 采集一次，下一轮会再试。` };
  }
  if (data.state === "ok" && filter === "all") {
    return {
      tone: "neutral", icon: "history", title: "近 48 小时没有结束的作业",
      body: "作业完成、失败或取消后会出现在这里（sacct 每 5 分钟同步）。更早的记录可以按作业号或日期查。",
      actions: [{ label: "按作业号或日期查", kind: "secondary", attrs: { "data-cl-lookup-focus": "" } }],
    };
  }
  return null;
}

// 回查结果为空（作业号没查到 / 这段日期没有已结束的作业）：搜索图标，标题里写查的是什么。
function queryEmptyState(query, main) {
  const d = main?.data;
  if (!d || main.loading || main.error || d.state !== "ok") return null;
  const sum = d.summary || {};
  if (Number(sum.ended) || 0) return null;
  if (query.kind === "job") {
    if ((Number(sum.running) || 0) + (Number(sum.pending) || 0) > 0) return null;
    return { tone: "neutral", icon: "search", title: `没有查到作业 ${query.job}`, body: "它不是当前用户的作业，或已超出集群记账的保留期限。" };
  }
  return { tone: "neutral", icon: "search", title: `${query.label}没有已结束的作业`, body: "能查多早取决于集群记账的保留期限。" };
}

function emptyTextFor({ data, error, loading, filter }) {
  if (!data) return error ? `作业历史加载失败：${error}` : loading ? "正在读取作业记录…" : "还没有读取作业记录";
  if (data.state === "none") return "还没有采集到这台服务器的作业记录（每 5 分钟采集一次，稍后再看）";
  if (data.state === "absent") return "这个集群没有作业记账（sacct），看不了作业历史";
  if (data.state !== "ok") return `作业记录读取失败${data.reason ? `：${data.reason}` : ""}`;
  return EMPTY_BY_FILTER[filter];
}

// 历史行（含组内）里出现的全部作业号：同因合并只算这份历史里的作业。
function historyJobIds(rows) {
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.kind !== "group") {
      if (row.id != null) ids.add(String(row.id));
      continue;
    }
    for (const child of Array.isArray(row.children) ? row.children : []) if (child?.id != null) ids.add(String(child.id));
  }
  return ids;
}

// 按同因筛选：把行（含组内）里属于这一类的作业拉平列出；组里没带回的写「还有 N 个」。
function causeRows(rows, cause, toJob) {
  const out = [];
  const seen = new Set();
  const take = (row) => {
    const id = String(row.id);
    if (!cause.ids.includes(id) || seen.has(id)) return;
    seen.add(id);
    out.push(toJob(row));
  };
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    if (row.kind !== "group") take(row);
    else for (const child of Array.isArray(row.children) ? row.children : []) if (child && typeof child === "object") take(child);
  }
  const missing = cause.count - out.length;
  if (out.length && missing > 0) out.push({ kind: "more", key: `cause:${cause.key}:more`, parent: "", rowKind: "problem", text: `还有 ${formatCount(missing)} 个没有列出…` });
  return out;
}

// 查询结果为空 / 未就绪时的说明。
function queryEmptyText(query, main, filter) {
  if (!main || main.loading || (!main.data && !main.error)) return `正在查询${query.label}…`;
  if (main.error) return `查询失败：${main.error}`;
  const d = main.data;
  if (d.state === "none") return d.reason ? `无法查询：${d.reason}` : "这台服务器不在作业采集范围，无法查询";
  if (d.state === "absent") return "这个集群没有作业记账（sacct），无法查询";
  if (d.state !== "ok") return `查询失败${d.reason ? `：${d.reason}` : ""}`;
  const sum = d.summary || {};
  const ended = Number(sum.ended) || 0;
  if (query.kind === "job" && !ended) {
    return (Number(sum.running) || 0) + (Number(sum.pending) || 0) > 0
      ? `作业 ${query.job} 还在运行或排队，见「当前队列」`
      : `没有查到作业 ${query.job}（不是当前用户的作业，或已超出集群记账的保留期限）`;
  }
  if (!ended) return "这段日期没有已结束的作业（能查多早取决于集群记账的保留期限）";
  return EMPTY_BY_FILTER[filter].replace("近 48 小时", "这段日期");
}

// 一段的段头文字：加载中 / 失败 / 合计（没取全时说明实际覆盖到哪里）。
function segmentHeader(segment, now) {
  if (segment.loading || (!segment.data && !segment.error)) return { text: "正在查询…", retry: null };
  if (segment.error) return { text: `查询失败：${segment.error}`, retry: segment.key };
  const d = segment.data;
  if (d.state !== "ok") return { text: `读取失败${d.reason ? `：${d.reason}` : ""}`, retry: d.state === "error" ? segment.key : null };
  const kept = Number.isFinite(d.coverage?.keptFrom) ? `（记录过多，只取到 ${endTextOf(d.coverage.keptFrom, now)} 之后提交的部分）` : d.truncated ? "（记录没有取全）" : "";
  return { text: `${segmentSummaryText(d)}${kept}`, retry: null };
}

// 面板模型（纯函数）。data = 接口响应（还没取到为 null）；diagnoses = 诊断接口响应（不可用为 null）；
// scripts = 加载器的脚本缓存（Map<作业号, { state, script, error }>）；
// view = { filter, expanded: Set<组 key>, diagOpen: Set<作业号>, scriptOpen: Set<作业号>, cause: 同因分组 key | null }；
// lookup = 回查加载器的状态 { query, segments, extras }（没有 = 只有近 48 小时视图）。
export function buildHistoryModel({ data = null, diagnoses = null, scripts = null, error = "", loading = false, view = {}, now = Date.now(), lookup = null } = {}) {
  const filter = HISTORY_FILTERS.includes(view.filter) ? view.filter : "all";
  const expanded = view.expanded instanceof Set ? view.expanded : new Set();
  const diagOpen = view.diagOpen instanceof Set ? view.diagOpen : new Set();
  const scriptOpen = view.scriptOpen instanceof Set ? view.scriptOpen : new Set();
  const query = lookup?.query || null;
  const allSegments = Array.isArray(lookup?.segments) ? lookup.segments : [];
  const extras = lookup?.extras;
  // 有查询时：第一段是查询本身（汇总条说它），其余是「更早…」接上的段；没有查询时各段都接在 48 小时后面。
  const main = query ? allSegments[0] || null : null;
  const earlier = query ? allSegments.slice(1) : allSegments;
  const shown = query ? (main?.data ?? null) : data;
  const ok = shown?.state === "ok";
  const sum = ok && shown.summary && typeof shown.summary === "object" ? shown.summary : {};
  const num = (value) => (Number.isFinite(value) ? value : 0);
  const completed = num(sum.completed);
  const failed = num(sum.failed);
  const cancelled = num(sum.cancelled);
  const other = num(sum.other);
  const ended = num(sum.ended);
  const truncated = ok && shown.truncated === true;
  // 没拿全时数字只是下限：挂「+」，并在表格下方说明（与今日简报同一写法）。
  const figure = (value) => `${formatCount(value)}${truncated ? "+" : ""}`;

  const dataRows = ok && Array.isArray(shown.rows) ? shown.rows : [];
  const baselines = computeDurationBaselines(dataRows);
  const index = diagnosisIndex(diagnoses);
  // 同因合并只看近 48 小时（查询结果不参与）。
  const causes = causesModel(query || !ok ? null : index, { historyIds: historyJobIds(dataRows), windowStart: historyWindowStart(data, now), active: view.cause ?? null });
  const diagOf = (row) => {
    if (!index) return null;
    const id = String(row.id);
    return diagnosisModel(row, index, { open: diagOpen.has(id), scriptOpen: scriptOpen.has(id), scriptEntry: scripts instanceof Map ? scripts.get(id) : null });
  };
  const activeCause = causes.items.find((c) => c.active) || null;

  // 一份数据的行（筛选 / 展开 / 组内加载更多）。prefix：段内组的展开 key 前缀（48 小时 / 查询本身为空，保持原有 key）。
  const pushRows = (rows, sourceRows, snapshotId, prefix) => {
    for (const row of sourceRows) {
      if (!row || typeof row !== "object") continue;
      if (filter !== "all" && kindOf(row) !== filter) continue;
      if (row.kind !== "group") {
        rows.push(jobModel(row, now, { diag: diagOf(row), baselines }));
        continue;
      }
      const key = `${prefix}${row.key}`;
      const open = expanded.has(key);
      rows.push({ ...groupModel(row, now, open), key });
      if (!open) continue;
      const extra = groupExtraOf(extras, snapshotId, String(row.key));
      const children = Array.isArray(extra?.children) ? extra.children : Array.isArray(row.children) ? row.children : [];
      for (const child of children) rows.push(jobModel(child, now, { child: true, parent: key, diag: diagOf(child), baselines }));
      const more = Array.isArray(extra?.children) ? num(extra.more) : num(row.more);
      if (more <= 0) continue;
      const canLoad = Boolean(snapshotId) && children.length < GROUP_PAGE_MAX;
      const capped = snapshotId && !canLoad ? `（组内最多显示 ${formatCount(GROUP_PAGE_MAX)} 个，其余用作业号查询）` : "";
      rows.push({
        kind: "more",
        key: `${key}:more`,
        parent: key,
        rowKind: kindOf(row),
        text: canLoad ? `还有 ${formatCount(more)} 个` : `还有 ${formatCount(more)} 个…${capped}`,
        action: canLoad ? { snapshot: snapshotId, group: String(row.key), limit: Math.min(GROUP_PAGE_MAX, children.length + GROUP_PAGE_STEP), label: `再显示 ${formatCount(Math.min(GROUP_PAGE_STEP, more))} 个` } : null,
        loading: Boolean(extra?.loading),
        error: extra?.error || "",
      });
    }
  };

  const rows = [];
  if (activeCause) rows.push(...causeRows(dataRows, activeCause, (row) => jobModel(row, now, { diag: diagOf(row), baselines })));
  else pushRows(rows, dataRows, shown?.snapshotId || null, "");
  if (!activeCause) {
    for (const segment of earlier) {
      const header = segmentHeader(segment, now);
      rows.push({ kind: "segment", key: segment.key, label: segment.label, text: header.text, retry: header.retry });
      const d = segment.data;
      if (d?.state === "ok" && Array.isArray(d.rows)) pushRows(rows, d.rows, d.snapshotId || null, `${segment.key}|`);
    }
  }

  const notes = [];
  if (truncated && query) {
    const keptFrom = shown.coverage?.keptFrom;
    notes.push(Number.isFinite(keptFrom)
      ? `记录超过上限，只取到 ${endTextOf(keptFrom, now)} 之后提交的部分，上面的数字偏少；请缩小日期范围。`
      : "作业记录没有取全（输出过大），上面的数字偏少。");
  } else if (truncated) {
    notes.push(num(shown.total) > num(shown.kept)
      ? `作业太多：近 48 小时共 ${formatCount(shown.total)} 个，只取到最新的 ${formatCount(shown.kept)} 个，上面的数字偏少。`
      : "作业记录没有取全（输出过大），上面的数字偏少。");
  }
  if (ok && num(shown.rowsOmitted) > 0) notes.push(`另有 ${formatCount(shown.rowsOmitted)} 行没有列出。`);
  if (query?.kind === "job" && ok && ended > 0 && num(sum.running) + num(sum.pending) > 0) notes.push(`另有 ${formatCount(num(sum.running) + num(sum.pending))} 个还在运行或排队，见「当前队列」。`);
  if (!query && data && error) notes.push(`刷新失败（${error}），显示的是上次取到的数据。`);

  // 筛选芯片的计数：显示中的主体 + 已加载的各段。
  const counts = { ended, problem: failed + cancelled, done: completed + other };
  for (const segment of activeCause ? [] : earlier) {
    const s = segment.data?.state === "ok" ? segment.data.summary || {} : {};
    counts.ended += num(s.ended);
    counts.problem += num(s.failed) + num(s.cancelled);
    counts.done += num(s.completed) + num(s.other);
  }

  const relative = !query && ok && Number.isFinite(data.checkedAt) ? formatRelativeTime(data.checkedAt, now) : "";
  const queryFresh = query && ok && Number.isFinite(shown.fetchedAt)
    ? `${shown.source === "local" ? "取自近 48 小时采集" : `查询于 ${endTextOf(shown.fetchedAt, now)}`}${shown.cached ? "（复用结果）" : ""}`
    : "";

  // 表格下方：覆盖范围、「更早…」、48 小时窗口后移后的补齐。
  const loadingAny = allSegments.some((s) => s.loading);
  const next = activeCause ? null : nextEarlierSegment({ query, segments: earlier, liveData: data, now });
  const lastEarlier = earlier.length ? earlier[earlier.length - 1] : null;
  const coverText = [
    query?.kind === "range" ? `按结束时间：${query.label}` : "",
    lastEarlier?.params?.from ? `已往前加载到 ${lastEarlier.label.replace(/ \d{2}:\d{2} 之前$/, "")}` : "",
  ].filter(Boolean).join(" · ");
  const firstBound = !query && earlier[0] ? earlier[0].params?.endBefore : null;
  const windowStart = liveWindowStart(data);
  const gapMin = Number.isFinite(firstBound) && windowStart != null ? Math.floor((windowStart - firstBound) / 60_000) : 0;
  const gap = gapMin > 0 && !earlier[0].loading ? `近 48 小时窗口已后移 ${formatCount(gapMin)} 分钟，这段时间结束的作业未列出` : "";
  const lookupBar = {
    visible: Boolean(next || coverText || gap),
    text: coverText,
    gap,
    earlier: next ? { label: loadingAny ? "加载中…" : "更早…", disabled: loadingAny, title: `加载 ${next.label} 结束的作业（每次一天，一次只读 sacct 查询）` } : null,
  };

  return {
    state: shown?.state || (error && !query ? "error" : "none"),
    filter,
    filters: [
      { key: "all", label: "全部", count: counts.ended },
      { key: "problem", label: "有问题", count: counts.problem },
      { key: "done", label: "完成", count: counts.done },
      // 按同因筛选时三个芯片都不按下（点任一个即回到普通筛选）。
    ].map((f) => ({ ...f, active: !activeCause && f.key === filter })),
    summary: {
      visible: ok,
      ...(query ? { label: query.label } : {}),
      items: [
        { key: "ended", value: figure(ended), label: "个已结束" },
        { key: "completed", value: figure(completed), label: "完成", tone: completed ? "ok" : "" },
        { key: "failed", value: figure(failed), label: "失败 / 超时", tone: failed ? "critical" : "" },
        { key: "cancelled", value: figure(cancelled), label: "取消", tone: cancelled ? "warn" : "" },
        ...(other ? [{ key: "other", value: figure(other), label: "其它" }] : []),
      ],
      hint: failed + cancelled > 0 ? "有问题的排在最前" : "",
      fresh: query ? queryFresh : relative ? (relative === "刚刚" ? "刚刚采集" : `${relative}采集`) : "",
      freshTitle: query ? "按需只读查询 sacct；同一查询短时间内复用结果，不触发提醒、失败诊断或简报统计" : "作业记录每 5 分钟采集一次（sacct，只读）",
    },
    causes,
    cause: causes.active,
    query,
    rows,
    emptyText: rows.length
      ? ""
      : activeCause
        ? "这些作业已不在近 48 小时的列表里"
        : query
          ? queryEmptyText(query, main, filter)
          : emptyTextFor({ data, error, loading, filter }),
    // 表格为空时的完整空状态（null = 只用上面那一句话）。
    emptyState: rows.length || activeCause
      ? null
      : query
        ? queryEmptyState(query, main)
        : emptyStateFor({ data, error, filter }),
    noteText: notes.join(" "),
    lookupBar,
  };
}
