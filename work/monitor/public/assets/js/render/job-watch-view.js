// 作业关注 / 进度 / 资源复盘 / 提醒规则：沿用集群表格的紧凑结构和状态令牌。
// 远端日志、作业名、路径均为不可信数据；每个文本与属性出口都转义。
import { shortServerName } from "../display-names.js";
import { emptyStateHtml } from "../empty-state.js";
import { escapeHtml, formatBytes, formatRelativeTime } from "../store.js";
import { clockOf } from "./usage-model.js";

const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const STATES = { PENDING: "排队", RUNNING: "运行中", COMPLETING: "收尾中", COMPLETED: "完成", FAILED: "失败", TIMEOUT: "超时", OUT_OF_MEMORY: "内存不足", CANCELLED: "已取消", NODE_FAIL: "节点故障" };
const PROGRESS = { waiting: "等待首次采样", ok: "进度有更新", quiet: "日志暂未更新", stalled: "疑似停滞", unavailable: "进度未知", stale: "采样已过期" };

export function jobStateLabel(state) {
  return STATES[state] || state || "未知";
}

export function buildWatchButton({ ids = [], label = "", watched = false, group = false } = {}) {
  const valid = ids.filter((id) => /^\d{1,12}(?:_\d{1,9})?$/.test(String(id)));
  if (!valid.length || valid.length !== ids.length || valid.length > 100) return "";
  return `<button type="button" class="text-btn jw-follow" data-job-watch="${escapeHtml(valid.join(","))}" data-watch-label="${escapeHtml(label)}"${watched ? " disabled" : ""} title="${group ? "关注本组当前列出的作业；之后新提交的作业需另行关注" : "关注开始、结束、临近时限与疑似停滞提醒"}">${watched ? "已关注" : group ? "关注此组" : "关注"}</button>`;
}

export function progressText(progress = {}, now = Date.now()) {
  const parts = [PROGRESS[progress.status] || "进度未知"];
  if (number(progress.epoch) != null) parts.push(`Epoch ${progress.epoch}`);
  if (number(progress.step) != null) parts.push(`Step ${progress.step}`);
  if (number(progress.lastLogAt) != null && progress.lastLogAt > 0) parts.push(`日志${formatRelativeTime(progress.lastLogAt, now)}更新`);
  return parts.join(" · ");
}

export function buildResourceReviewHtml(resource) {
  const r = resource || {};
  const bytes = (v) => number(v) == null ? "未知" : formatBytes(v);
  const cpu = number(r.cpuEfficiency);
  const fields = [
    ["分配 CPU", number(r.allocCpus) == null ? "未知" : `${r.allocCpus} 核`],
    ["CPU 效率", cpu == null ? "未知" : `${Math.round(cpu * 1000) / 10}%`],
    ["申请内存", bytes(r.requestedMemoryBytes)],
    ["单任务峰值内存", bytes(r.maxRssBytes)],
    ["墙钟时间", number(r.elapsedSeconds) == null ? "未知" : `${Math.round(r.elapsedSeconds / 60 * 10) / 10} 分钟`],
    ["累计 CPU 时间", number(r.totalCpuSeconds) == null ? "未知" : `${Math.round(r.totalCpuSeconds / 60 * 10) / 10} 核分钟`],
    ["申请时限", number(r.timeLimitSeconds) == null ? "未知" : `${Math.round(r.timeLimitSeconds / 60)} 分钟`],
    ["申请 GPU", number(r.requestedGpus) == null ? "未知" : `${r.requestedGpus} 张`],
    ["GPU 利用率记账峰值", number(r.gpuUtilPeak) == null ? "未知" : `${r.gpuUtilPeak}%（非时间平均）`],
    ["GPU 显存记账峰值", bytes(r.gpuMemoryPeakBytes)],
  ];
  const assessments = (Array.isArray(r.assessments) ? r.assessments : []).filter((a) => a && typeof a === "object").slice(0, 4);
  const labels = { over: "可能过量", risk: "余量风险", unknown: "无法判断", observed: "实测参考" };
  const advice = assessments.length ? `<ul class="jw-assessments">${assessments.map((a) => `<li data-kind="${escapeHtml(a.kind)}"><strong>${escapeHtml(a.resource)} · ${escapeHtml(labels[a.kind] || "实测参考")}</strong><span>${escapeHtml(a.text)}</span></li>`).join("")}</ul>` : "";
  const snippet = typeof r.sbatch === "string" && r.sbatch
    ? `<div class="jw-sbatch"><p class="jw-note">下次同规模试跑建议 <button type="button" class="text-btn" data-copy-sbatch>复制 SBATCH 建议</button></p><pre tabindex="0" aria-label="下次试跑的 SBATCH 建议"><code>${escapeHtml(r.sbatch)}</code></pre></div>` : "";
  return `<div class="jw-review"><dl class="jw-resource-grid">${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` +
    advice + snippet + (r.adviceNote ? `<p class="jw-note">${escapeHtml(r.adviceNote)}</p>` : "") +
    `<p class="jw-note">${escapeHtml(r.detail || "CPU 效率 = 累计 CPU 时间 ÷（分配核数 × 墙钟时间）。缺失记账数据标为未知；内存为 Slurm 记录的最大单任务 RSS，不代表整作业峰值。")}</p></div>`;
}

// ---- 编排型作业的子任务（v2.51）----
// 计数只是 stdout 里看到的启动 / 结束行；总子任务数未知，所以不画完成率、不写「还剩 N 个」。

// 时刻按北京时间（与作业历史、排队行的预计开始同一口径，见 usage-model.js），不随本机时区变。
const clock = (ms) => (number(ms) == null ? "未知" : clockOf(ms / 1000));
const minutes = (ms) => (ms < 60000 ? "不到 1 分钟" : ms < 3600000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 360000) / 10} 小时`);
const metricValue = (v) => (typeof v !== "number" || !Number.isFinite(v) ? "—" : Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.001) ? v.toExponential(2) : String(Math.round(v * 10000) / 10000));

export function subrunSummaryText(s) {
  if (!s) return "";
  const parts = [`子任务 已启动 ${s.launched}`, `已结束 ${s.ended}`];
  if (s.failed) parts.push(`失败 ${s.failed}`);
  parts.push(s.finalized ? `未见结束 ${s.unended?.length || 0}` : `正在跑 ${s.runningCount}`);
  return parts.join(" · ");
}

// 很小的内联走势：只表达近期方向，数值看旁边的文字；单序列，用强调蓝。
export function sparklineSvg(values, label = "") {
  const list = (Array.isArray(values) ? values : []).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(-30);
  if (list.length < 3) return "";
  const lo = Math.min(...list);
  const span = Math.max(...list) - lo || 1;
  const pts = list.map((v, i) => `${Math.round((i / (list.length - 1)) * 600) / 10},${Math.round((12 - ((v - lo) / span) * 10) * 10) / 10}`);
  const tip = `${label} 最近 ${list.length} 个记录：首 ${metricValue(list[0])} · 最低 ${metricValue(lo)} · 最新 ${metricValue(list.at(-1))}`;
  return `<svg class="jw-spark" viewBox="0 0 60 14" width="60" height="14" role="img" aria-label="${escapeHtml(tip)}"><title>${escapeHtml(tip)}</title>` +
    `<polyline points="${pts.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function subrunLogHtml(log, now) {
  if (!log) return '<p class="jw-note">等待下一轮读取子任务日志。</p>';
  if (log.missing) return '<p class="jw-note">子任务日志不存在或不可读（只认同目录下 &lt;run&gt;_&lt;phase&gt;_&lt;作业号&gt;.log）。</p>';
  const fresh = number(log.lastLogAt) != null ? `日志${formatRelativeTime(log.lastLogAt, now)}更新` : "日志更新时间未知";
  if (log.epoch == null) return `<p class="jw-note">${escapeHtml(fresh)}${log.lastLine ? " · 未识别的格式，最后一行：" : ""}</p>${log.lastLine ? `<pre class="jw-subrun-raw">${escapeHtml(log.lastLine)}</pre>` : ""}`;
  const metrics = log.metrics.slice(0, 4).map(([k, v]) => `${k} ${metricValue(v)}`);
  const head = [`Epoch ${log.epoch}${log.total ? ` / ${log.total}` : ""}`, ...metrics, log.best ? "本轮最佳" : ""].filter(Boolean).join(" · ");
  const eta = log.eta
    ? `粗估 ${clock(log.eta.endLo)}–${clock(log.eta.endHi)} 训练完（按最近 ${log.eta.points} 个 epoch 记录、约 ${log.eta.secPerEpoch} 秒 / epoch；只针对这个子任务，不含其后的评估阶段）`
    : log.etaNote || "";
  return `<p class="jw-subrun-metrics"><span>${escapeHtml(head)}</span>${sparklineSvg(log.history, log.primary || "")}</p>` +
    `<p class="jw-note">${escapeHtml([fresh, log.restarted ? "日志中出现 epoch 回退，此前的记录已不计入" : "", eta].filter(Boolean).join(" · "))}</p>`;
}

function subrunRunLabel(r) {
  return `<code>${escapeHtml(r.run)}</code><span class="jw-subrun-phase">${escapeHtml(r.phase)}${r.attempt > 1 ? ` · 第 ${r.attempt} 次` : ""}</span>`;
}

export function buildSubrunHtml(s, now = Date.now()) {
  if (!s) return "";
  const notes = [];
  for (const g of s.gaps || []) notes.push(`<p class="jw-note" data-level="warn">覆盖缺口（${escapeHtml(clock(g.at))}）：${escapeHtml(g.text)}</p>`);
  if (s.orphanEnds) notes.push(`<p class="jw-note" data-level="warn">${s.orphanEnds} 条结束记录找不到对应的启动记录，只计入结束数。</p>`);
  if (s.ambiguous) notes.push(`<p class="jw-note" data-level="warn">${s.ambiguous} 个子任务在上一次还未结束时又被启动，无法确定结束记录属于哪一次，已标「无法配对」。</p>`);
  if (s.catchingUp) notes.push('<p class="jw-note">stdout 尚未读完，下一轮继续追读，计数会增加。</p>');
  if (s.finalNote) notes.push(`<p class="jw-note" data-level="warn">${escapeHtml(s.finalNote)}</p>`);
  const running = (s.running || []).map((r) => `<li data-status="running"><div class="jw-subrun-line">${subrunRunLabel(r)}` +
    `<span class="jw-note">${number(r.launchAt) != null ? `已运行 ${escapeHtml(minutes(Math.max(0, now - r.launchAt)))}` : ""}${r.ambiguous ? " · 无法配对" : ""}</span></div>${subrunLogHtml(r.log, now)}</li>`).join("");
  const failed = (s.failedRuns || []).map((r) => `<li data-status="failed"><div class="jw-subrun-line">${subrunRunLabel(r)}` +
    `<span class="jw-subrun-code">退出码 ${escapeHtml(String(r.code))}</span><span class="jw-note">${escapeHtml(clock(r.endAt))} 结束${r.orphan ? " · 未找到启动记录" : ""}</span></div></li>`).join("");
  const unended = (s.unended || []).map((r) => `<li data-status="unended"><div class="jw-subrun-line">${subrunRunLabel(r)}<span class="jw-note">作业结束时仍未见结束记录</span></div></li>`).join("");
  const recent = (s.recent || []).map((r) => `${r.run} ${r.phase} ${clock(r.endAt)}`).join("；");
  // 计数摘要已在作业行上（jw-subrun-sum），这里只写来源与采样时刻，不重复。
  return `<div class="jw-subruns"><p class="jw-subrun-head">子任务明细<span class="jw-note">（stdout 启动 / 结束记录${number(s.checkedAt) != null ? ` · ${escapeHtml(formatRelativeTime(s.checkedAt, now))}读取` : ""}）</span></p>${notes.join("")}` +
    (running ? `<p class="jw-subrun-title">正在跑</p><ul class="jw-subrun-list">${running}</ul>` : "") +
    (failed ? `<p class="jw-subrun-title">非零退出</p><ul class="jw-subrun-list">${failed}</ul>` : "") +
    (unended ? `<p class="jw-subrun-title">未见结束记录</p><ul class="jw-subrun-list">${unended}</ul>` : "") +
    (recent ? `<p class="jw-note">最近正常结束：${escapeHtml(recent)}</p>` : "") +
    `<p class="jw-note">口径：按 stdout 的 LAUNCH / END 行计数，总子任务数未知，所以不显示完成率；退出码非 0 记为失败，调度器另以「完成标志」判失败的情况 stdout 看不到。作业被取消或超时时，调度器直接终止子任务、不写结束记录。</p></div>`;
}

// logReader(job)：v2.51「读取前一段」的 HTML（render/log-readback-view.js），放在路径与末尾之间，读到的更早内容在末尾上方。
function jobHtml(job, { expanded, now, logReader = null }) {
  const id = String(job.id);
  const progress = job.progress || {};
  const open = expanded.has(id);
  const ended = ["completed", "failed", "cancelled", "other"].includes(job.outcome) && !["PENDING", "RUNNING", "COMPLETING"].includes(job.state);
  const subruns = job.subruns || null;
  const detail = open ? `<div class="jw-evidence">` +
    (ended ? buildSubrunHtml(subruns, now) + buildResourceReviewHtml(job.resources) : `<p class="jw-note">${escapeHtml(progress.detail || "关注后等待下一轮采集。日志没有更新本身不能证明作业卡死。")}</p>` +
      buildSubrunHtml(subruns, now) +
      (progress.path ? `<p class="jw-path"><code>${escapeHtml(progress.path)}</code></p>` : "") +
      (typeof logReader === "function" ? logReader(job) : "") +
      (progress.tail ? `<pre class="cl-diag-pre">${escapeHtml(progress.tail)}</pre>` : "")) +
    `</div>` : "";
  return `<li class="jw-job" data-watch-job-id="${escapeHtml(id)}" data-progress="${escapeHtml(progress.status || "waiting")}"${subruns?.failed ? ' data-subrun-failed="true"' : ""}>` +
    `<div class="jw-job-line"><span class="cl-job-num">${escapeHtml(id)}</span><span class="jw-job-name" title="${escapeHtml(job.name || "")}">${escapeHtml(job.name || "—")}</span>` +
    `<span class="jw-state">${escapeHtml(jobStateLabel(job.state))}</span><button type="button" class="text-btn" data-watch-evidence="${escapeHtml(id)}" aria-expanded="${open}">${open ? "收起" : ended ? "资源复盘" : "进度依据"}</button></div>` +
    (!ended ? `<p class="jw-progress">${escapeHtml(progressText(progress, now))}</p>` : "") +
    (subruns ? `<p class="jw-progress jw-subrun-sum">${escapeHtml(subrunSummaryText(subruns))}</p>` : "") + detail + `</li>`;
}

export function buildWatchListHtml(data, { expanded = new Set(), now = Date.now(), loading = false, error = "", logReader = null } = {}) {
  if (data?.disabled) return '<p class="cl-empty">「我的 Slurm 作业」模块已关闭。</p>';
  const watches = Array.isArray(data?.watches) ? data.watches : [];
  if (!watches.length) {
    if (loading && !error) return '<p class="jw-note">正在读取关注列表…</p>';
    if (error) return emptyStateHtml({ compact: true, tone: "error", icon: "cloudOff", title: "暂时取不到关注列表", body: `${error}；稍后会自动重试。` });
    // 「关注」按钮只出现在自己的作业行上（cluster-view.js buildWatchButton），文案照实写。
    return emptyStateHtml({
      compact: true, tone: "neutral", icon: "eye", title: "还没有关注的作业",
      body: "在下方作业队列里点自己作业行上的「关注」，或关注整个实验组。只有关注的作业会采集日志进度，开始、结束、临近时限和疑似停滞时提醒你。想按名字或运行时长自动关注，在侧栏「作业提醒」的提醒规则里设置。",
    });
  }
  return (error ? `<p class="jw-note" data-level="warn">刷新失败：${escapeHtml(error)}；以下为上次记录。</p>` : "") + watches.map((watch) => {
    const id = escapeHtml(watch.id);
    const jobs = Array.isArray(watch.jobs) ? watch.jobs : [];
    const done = jobs.filter((j) => ["completed", "failed", "cancelled"].includes(j.outcome)).length;
    // 自动组（v2.62，按提醒规则收进来的）：带「自动」标记；它跟着规则走，所以移除入口是停用那条规则。
    // 名字规则的组多一条「这一批全部结束」；长作业规则没有「一批」的说法，结束时不提醒。
    const auto = Boolean(watch.auto);
    const autoTitle = watch.auto?.rule === "longRun"
      ? "按提醒规则自动关注：疑似停滞、临近时限、子任务非零退出时提醒，结束时不提醒"
      : "按提醒规则自动关注：疑似停滞、临近时限、子任务非零退出和这一批全部结束时提醒";
    return `<section class="jw-watch" data-watch-id="${id}"${auto ? ' data-auto="true"' : ""}><div class="jw-watch-head"><strong>${escapeHtml(watch.label || `作业 ${watch.jobIds?.join("、") || ""}`)}</strong>` +
      (auto ? `<span class="badge" title="${autoTitle}">自动</span>` : "") +
      `<span class="jw-note">${done} / ${watch.jobIds?.length || jobs.length} 已结束${watch.muted ? " · 已静音" : ""}</span>` +
      `<div class="jw-watch-actions"><button type="button" class="text-btn" data-watch-mute="${id}" data-muted="${Boolean(watch.muted)}">${watch.muted ? "取消静音" : "静音"}</button>` +
      `<button type="button" class="text-btn" data-watch-remove="${id}"${auto ? ' data-watch-auto="true"' : ""}>${auto ? "停用这条规则" : "取消关注"}</button></div></div>` +
      `<ul class="jw-jobs">${jobs.length ? jobs.map((job) => jobHtml(job, { expanded, now, logReader })).join("") : '<li class="jw-note">等待下一轮作业采集…</li>'}</ul></section>`;
  }).join("");
}

// ---- 提醒规则（v2.62）：作业提醒浮层里的一节，每台在采集范围内的服务器一块 ----

export const RULE_PATTERNS_MAX = 12;
export const RULE_PATTERN_MAX_LENGTH = 64;
export const LONG_RUN_MIN_MINUTES = 10;
export const LONG_RUN_MAX_MINUTES = 10080;

const rulesOf = (server) => ({
  failNotify: server?.rules?.failNotify !== false,
  longRunMinutes: Number.isInteger(server?.rules?.longRunMinutes) ? server.rules.longRunMinutes : null,
  patterns: Array.isArray(server?.rules?.patterns) ? server.rules.patterns.filter((p) => typeof p === "string") : [],
});

// 一次规则改动（发给后端的那几个字段）按界面这边的理解先应用上：保存在途时就按改后的样子显示，回包到了以回包为准。
export function applyRulesPatch(rules, patch) {
  const next = rulesOf({ rules });
  if (typeof patch?.failNotify === "boolean") next.failNotify = patch.failNotify;
  if (patch?.longRunMinutes !== undefined) next.longRunMinutes = Number.isInteger(patch.longRunMinutes) ? patch.longRunMinutes : null;
  if (typeof patch?.removePattern === "string") next.patterns = next.patterns.filter((pattern) => pattern !== patch.removePattern);
  if (typeof patch?.addPattern === "string" && !next.patterns.includes(patch.addPattern)) next.patterns = [...next.patterns, patch.addPattern];
  return next;
}

// 收起时标题行上的一句话：现在生效的是什么。
export function rulesSummaryText(rules) {
  const r = rulesOf({ rules });
  const auto = [r.patterns.length ? `${r.patterns.length} 条名字规则` : "", r.longRunMinutes ? `运行超过 ${r.longRunMinutes} 分钟自动关注` : ""].filter(Boolean);
  return [r.failNotify ? "失败提醒已开" : "失败提醒已关", ...(auto.length ? auto : ["没有自动关注的规则"])].join(" · ");
}

// servers：GET /api/jobs/watch 的 servers（[{ serverId, name, rules, suggestions }]）；open：展开着的 serverId；busy：有保存在途。
// 输入框的值 / 勾选不写进 HTML（就地修补不同步这类「属性 ≠ 状态」的字段），由控制器在渲染后按数据设回去。
export function buildRulesHtml(servers, { open = new Set(), busy = false } = {}) {
  const list = (Array.isArray(servers) ? servers : []).filter((s) => s && typeof s.serverId === "string");
  const off = busy ? " disabled" : "";
  return list.map((server) => {
    const id = escapeHtml(server.serverId);
    const rules = rulesOf(server);
    const expanded = open.has(server.serverId);
    // 只有一台服务器时不写名字（就是它）；多台时按界面用名区分。
    const title = list.length > 1 ? `提醒规则 · ${shortServerName(server.name || server.serverId)}` : "提醒规则";
    const head = `<div class="jw-rules-head"><button type="button" class="text-btn jw-rules-toggle" data-rules-toggle="${id}" aria-expanded="${expanded}">${escapeHtml(title)}</button>` +
      `<span class="jw-note">${escapeHtml(rulesSummaryText(rules))}</span></div>`;
    if (!expanded) return `<section class="jw-rules" data-rules-server="${id}">${head}</section>`;
    const full = rules.patterns.length >= RULE_PATTERNS_MAX;
    const patterns = rules.patterns.map((pattern) => `<li><code>${escapeHtml(pattern)}</code><button type="button" class="text-btn" data-rule-remove="${escapeHtml(pattern)}" data-rule-server="${id}"${off}>移除</button></li>`).join("");
    const suggestions = (Array.isArray(server.suggestions) ? server.suggestions : []).filter((s) => s && typeof s.pattern === "string" && !rules.patterns.includes(s.pattern));
    const chips = suggestions.map((s) => `<button type="button" class="text-btn jw-rule-chip" data-rule-suggest="${escapeHtml(s.pattern)}" data-rule-server="${id}" title="近 7 天的作业里有 ${escapeHtml(s.count)} 个会被这条规则命中，点一下加入"${off}>` +
      `${escapeHtml(s.pattern)}<span>${escapeHtml(s.count)}</span></button>`).join("");
    return `<section class="jw-rules" data-rules-server="${id}">${head}<div class="jw-rules-body">` +
      '<label class="jw-rule"><span class="jw-rule-text"><span class="jw-rule-title">作业失败时提醒</span>' +
      '<span class="jw-note">我的作业失败、超时、内存不足或节点故障时提醒；接连失败的合成一条，写明原因和作业号。不用先关注。</span></span>' +
      `<input type="checkbox" role="switch" class="jw-rule-switch" data-rule-fail="${id}" aria-label="作业失败时提醒"${off}></label>` +
      '<div class="jw-rule"><span class="jw-rule-text"><span class="jw-rule-title">长作业自动关注</span>' +
      '<span class="jw-note">运行超过这个时长的作业自动进入关注：疑似停滞、临近时限、子任务非零退出时提醒，结束时不提醒。留空为关。</span></span>' +
      `<label class="jw-rule-field">运行超过 <input type="number" min="${LONG_RUN_MIN_MINUTES}" max="${LONG_RUN_MAX_MINUTES}" step="1" inputmode="numeric" placeholder="关" data-rule-long="${id}" aria-label="长作业阈值（分钟，留空为关）"${off}> 分钟</label></div>` +
      '<div class="jw-rule jw-rule-names"><span class="jw-rule-text"><span class="jw-rule-title">按名字自动关注</span>' +
      `<span class="jw-note">作业名匹配的开始运行后自动进入关注：疑似停滞、临近时限、子任务非零退出时提醒，这一批全部结束时再提醒一次。* 代表任意一段，? 代表一个字符，区分大小写。最多 ${RULE_PATTERNS_MAX} 条。</span></span>` +
      // 列表与输入行始终在（空了只是藏起来）：增删规则时输入框还是原来那个节点，焦点与正在打的字不丢。
      `<ul class="jw-rule-list"${patterns ? "" : " hidden"}>${patterns}</ul>` +
      `<form class="jw-rule-add" data-rule-add="${id}"${full ? " hidden" : ""}><input type="text" name="pattern" maxlength="${RULE_PATTERN_MAX_LENGTH}" placeholder="例如 xp_*" aria-label="新的名字规则" autocomplete="off" spellcheck="false"${off}>` +
      `<button type="submit" class="btn btn-secondary"${off}>添加</button></form>` +
      (chips && !full ? `<p class="jw-rule-suggest"><span class="jw-note">近 7 天常见的作业名，点一下加入：</span>${chips}</p>` : "") +
      "</div></div>" +
      '<p class="jw-note">自动关注不逐个报开始和结束；合计最多 60 个在跑或刚结束的作业，排队中的不占名额。在服务器页的关注区可以静音或停用某条规则——静音的关注组里的作业，失败时也不再提醒。</p></section>';
  }).join("");
}

// 渲染后把规则输入框的状态按数据设回去（doc.activeElement 正在编辑的那个不动）。root：浮层正文；纯 DOM 属性操作。
export function syncRuleInputs(root, servers, activeElement = null) {
  const byId = new Map((Array.isArray(servers) ? servers : []).map((server) => [server?.serverId, rulesOf(server)]));
  for (const input of root?.querySelectorAll?.("[data-rule-fail]") || []) {
    const rules = byId.get(input.dataset.ruleFail);
    if (rules && input.checked !== rules.failNotify) input.checked = rules.failNotify;
  }
  for (const input of root?.querySelectorAll?.("[data-rule-long]") || []) {
    const rules = byId.get(input.dataset.ruleLong);
    const value = rules?.longRunMinutes ? String(rules.longRunMinutes) : "";
    if (rules && input !== activeElement && input.value !== value) input.value = value;
  }
}

// 点「查看作业」去哪：失败提醒去「我的历史」（原因、日志与脚本都在那里），其余照旧先找关注列表。
export function noticeTarget(notice) {
  return notice?.kind === "failed" ? "history" : null;
}

export function buildNotificationListHtml(data, now = Date.now()) {
  if (data?.disabled) return '<p class="cl-empty">「我的 Slurm 作业」模块已关闭。</p>';
  const notices = Array.isArray(data?.notifications) ? data.notifications : [];
  // 全局收件箱不知道有没有关注（/api/jobs/notifications 不带关注列表），所以说「还没有提醒」而不是「还没有关注」。
  if (!notices.length) {
    // 失败提醒开没开看规则（v2.62）：开着的照实说会自动出现，关着的不许诺。
    const servers = Array.isArray(data?.servers) ? data.servers : [];
    const failOn = servers.some((server) => server?.rules?.failNotify !== false);
    return emptyStateHtml({
      tone: "neutral", icon: "eye", title: "还没有作业提醒",
      body: `${failOn ? "我的作业失败时会自动记录在这里，不用先关注。" : ""}关注作业后，开始、结束、临近时限和疑似停滞会记录在这里。在服务器页的作业队列里点自己作业行上的「关注」${servers.length ? "，或在上面的提醒规则里按名字、运行时长自动关注" : ""}。`,
    });
  }
  return `<ul class="jw-notices">${notices.map((n) => `<li class="jw-notice"${n.readAt ? "" : ' data-unread="true"'}><div class="jw-notice-heading"><strong>${escapeHtml(n.title)}</strong><time>${escapeHtml(formatRelativeTime(n.createdAt, now))}</time></div>` +
    `<p>${escapeHtml(n.body || "")}</p><div class="jw-watch-actions"><button type="button" class="text-btn" data-notice-open="${escapeHtml(n.id)}">查看作业</button>` +
    (!n.readAt ? `<button type="button" class="text-btn" data-notice-read="${escapeHtml(n.id)}">标为已读</button>` : '<span class="jw-note">已读</span>') + '</div></li>').join("")}</ul>`;
}
