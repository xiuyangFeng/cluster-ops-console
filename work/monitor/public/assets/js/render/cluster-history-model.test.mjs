import assert from "node:assert/strict";
import test from "node:test";

import { buildHistoryModel, endTextOf, formatDurationRange, HISTORY_SCAN_INTERVAL_MS, nextHistoryDelay } from "./cluster-history-model.js";
import { buildHistoryFiltersHtml, buildHistoryRowsHtml, buildHistorySummaryHtml, HISTORY_COLUMNS } from "./cluster-view.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
// 北京时间 2026-10-03 12:00
const NOW = Date.UTC(2026, 9, 3, 4, 0, 0);

const done = (id, name, endAgo, elapsedSec, nodes = "node01", partition = "CPU") => (
  { kind: "job", outcome: "completed", id, name, state: "COMPLETED", exitCode: 0, signal: 0, cancelledBy: null, endAt: NOW - endAgo, elapsedSec, nodes, partition }
);

// 形状对齐 GET /api/jobs 的响应（lib/jobs/model.mjs buildJobsHistory），数量取自 2026-10-03 集群实测。
function response(overrides = {}) {
  return {
    schemaVersion: 1,
    serverId: "server-01",
    windowHours: 48,
    state: "ok",
    reason: null,
    user: "kai",
    checkedAt: NOW - 3 * MIN,
    total: 1137,
    kept: 1137,
    truncated: false,
    summary: { ended: 1118, completed: 1091, failed: 7, cancelled: 20, other: 0, running: 19, pending: 0 },
    rows: [
      { kind: "job", outcome: "failed", id: "16921", name: "train_lora", state: "OUT_OF_MEMORY", exitCode: 0, signal: 125, cancelledBy: null, endAt: NOW - 3 * HOUR, elapsedSec: 640, nodes: "master", partition: "GPU" },
      {
        kind: "group", outcome: "failed", key: "FAILED|cfa-agiter19", state: "FAILED", label: "cfa-agiter19-*", count: 4, stages: [{ name: "cfd1", count: 4 }],
        firstEndAt: NOW - 24 * HOUR, lastEndAt: NOW - 21 * HOUR, elapsedMinSec: 1100, elapsedMaxSec: 1100, nodeLists: ["node05"], partitions: ["CPU"],
        exits: [{ exitCode: 1, signal: 0, count: 3 }, { exitCode: 137, signal: 0, count: 1 }],
        children: [
          { kind: "job", outcome: "failed", id: "16804", name: "cfa-agiter19-a3f9c1-cfd1", state: "FAILED", exitCode: 137, signal: 0, cancelledBy: null, endAt: NOW - 21 * HOUR, elapsedSec: 1100, nodes: "node05", partition: "CPU" },
          { kind: "job", outcome: "failed", id: "16803", name: "cfa-agiter19-b01d22-cfd1", state: "FAILED", exitCode: 1, signal: 0, cancelledBy: null, endAt: NOW - 22 * HOUR, elapsedSec: 1100, nodes: "node05", partition: "CPU" },
        ],
        more: 2,
      },
      { kind: "job", outcome: "failed", id: "16655", name: "gen_meshrules_census", state: "TIMEOUT", exitCode: 0, signal: 0, cancelledBy: null, endAt: NOW - 33 * HOUR, elapsedSec: 10800, nodes: "node06", partition: "CPU" },
      {
        kind: "group", outcome: "cancelled", key: "CANCELLED|cfa-agiter18", state: "CANCELLED", label: "cfa-agiter18-*", count: 20, stages: [{ name: "cfd1", count: 20 }],
        firstEndAt: NOW - 40 * HOUR - 19_000, lastEndAt: NOW - 40 * HOUR, elapsedMinSec: 300, elapsedMaxSec: 300, nodeLists: ["node01", "node02"], partitions: ["CPU"],
        exits: [{ exitCode: 0, signal: 15, count: 20 }],
        children: [
          { kind: "job", outcome: "cancelled", id: "16101", name: "cfa-agiter18-0a0a0a-cfd1", state: "CANCELLED", exitCode: 0, signal: 15, cancelledBy: "1001", endAt: NOW - 40 * HOUR, elapsedSec: 300, nodes: "node01", partition: "CPU" },
          { kind: "job", outcome: "cancelled", id: "16100", name: "cfa-agiter18-0b0b0b-cfd1", state: "CANCELLED", exitCode: 0, signal: 0, cancelledBy: "1001", endAt: NOW - 40 * HOUR - 1000, elapsedSec: 0, nodes: "None assigned", partition: "CPU" },
        ],
        more: 0,
      },
      {
        kind: "group", outcome: "completed", key: "COMPLETED|cfa-agiter20", state: "COMPLETED", label: "cfa-agiter20-*", count: 600,
        stages: [{ name: "cfd1", count: 580 }, { name: "prepare1", count: 20 }],
        firstEndAt: NOW - 15 * HOUR, lastEndAt: NOW - MIN, elapsedMinSec: 2280, elapsedMaxSec: 3600,
        nodeLists: ["node01", "node02", "node03", "node04", "node05", "node06", "node07"], partitions: ["CPU"],
        exits: [{ exitCode: 0, signal: 0, count: 600 }],
        children: [done("17500", "cfa-agiter20-35607b-cfd1", MIN, 2400, "node02"), done("17499", "cfa-agiter20-025781-prepare1", 3 * MIN, 2280, "node07")],
        more: 598,
      },
      done("17431", "m1cap_v51dcv_post", 11.8 * HOUR, 2268, "node03"),
      done("17430", "m1cap_v51dcv", 12.5 * HOUR, 22320, "master", "GPU"),
    ],
    rowsOmitted: 0,
    ...overrides,
  };
}

test("结束时刻按北京时间：今天 / 昨天 / 更早写月.日", () => {
  assert.equal(endTextOf(NOW - 3 * HOUR, NOW), "今天 09:00");
  assert.equal(endTextOf(NOW - 12.5 * HOUR, NOW), "昨天 23:30");
  assert.equal(endTextOf(NOW - 40 * HOUR, NOW), "10.1 20:00");
  assert.equal(endTextOf(null, NOW), "—");
  // 北京时间 0 点前后（UTC 16:00）分属两天，与本机时区无关
  const midnight = Date.UTC(2026, 9, 2, 16, 0, 0);
  assert.equal(endTextOf(midnight, NOW), "今天 00:00");
  assert.equal(endTextOf(midnight - MIN, NOW), "昨天 23:59");
});

test("耗时范围：同一单位写一次，两端相同只写一个", () => {
  assert.equal(formatDurationRange(2280, 3660), "38 – 61 分");
  assert.equal(formatDurationRange(2280, 2290), "38 分");
  assert.equal(formatDurationRange(20, 45), "20 – 45 秒");
  assert.equal(formatDurationRange(45, 1800), "0 – 30 分");
  assert.equal(formatDurationRange(2160, 22320), "0.6 – 6.2 小时");
  assert.equal(formatDurationRange(86400, 86400 * 3), "1 – 3 天");
  assert.equal(formatDurationRange(null, 600), "10 分");
  assert.equal(formatDurationRange(null, null), "—");
  assert.equal(formatDurationRange(0, 0), "0 秒");
});

test("轮询节奏：跟随 5 分钟一轮的采集；没有快照 / 采集迟到时每分钟看一次", () => {
  assert.equal(HISTORY_SCAN_INTERVAL_MS, 5 * MIN);
  assert.equal(nextHistoryDelay(NOW - 10_000, NOW), 5 * MIN + 5_000, "刚采集过：等到下一轮采集之后");
  assert.equal(nextHistoryDelay(NOW - 3 * MIN, NOW), 2 * MIN + 15_000);
  assert.equal(nextHistoryDelay(NOW - 4.9 * MIN, NOW), MIN, "不比每分钟更勤");
  assert.equal(nextHistoryDelay(NOW - 20 * MIN, NOW), MIN, "采集迟到：每分钟看一次");
  assert.equal(nextHistoryDelay(null, NOW), MIN);
  assert.equal(nextHistoryDelay(NOW + HOUR, NOW), 5 * MIN + 15_000, "时钟不一致也不会等超过一轮");
});

test("汇总与筛选：合计直接用服务端的数；有问题的才上色", () => {
  const m = buildHistoryModel({ data: response(), now: NOW });
  assert.equal(m.state, "ok");
  assert.deepEqual(m.filters.map((f) => [f.key, f.label, f.count, f.active]), [["all", "全部", 1118, true], ["problem", "有问题", 27, false], ["done", "完成", 1091, false]]);
  assert.deepEqual(m.summary.items, [
    { key: "ended", value: "1,118", label: "个已结束" },
    { key: "completed", value: "1,091", label: "完成", tone: "ok" },
    { key: "failed", value: "7", label: "失败 / 超时", tone: "critical" },
    { key: "cancelled", value: "20", label: "取消", tone: "warn" },
  ]);
  assert.equal(m.summary.hint, "有问题的排在最前");
  assert.equal(m.summary.fresh, "3 分钟前采集");
  assert.equal(m.noteText, "");
  assert.equal(m.emptyText, "");

  const html = buildHistorySummaryHtml(m.summary);
  assert.match(html, /^<span class="cl-mine-label">近 48 小时<\/span><span class="cl-mine-item"><b>1,118<\/b> 个已结束<\/span>/);
  assert.match(html, /<span class="cl-mine-item" data-tone="critical"><b>7<\/b> 失败 \/ 超时<\/span>/);
  assert.match(html, /<span class="cl-mine-item cl-hist-fresh" title="作业记录每 5 分钟采集一次（sacct，只读）">3 分钟前采集<\/span>$/);
  assert.match(buildHistoryFiltersHtml(m.filters), /data-cl-hist-filter="problem" aria-pressed="false">有问题<span class="cl-filter-count">27<\/span>/);
  assert.match(buildHistoryFiltersHtml(m.filters), /aria-pressed="true">全部<span class="cl-filter-count">1,118<\/span>/, "计数与汇总条同一写法（千分位）");

  // 一切正常的两天：没有问题的数字不上色，也不提「排在最前」
  const calm = buildHistoryModel({ data: response({ summary: { ended: 5, completed: 5, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 }, rows: [] }), now: NOW });
  assert.deepEqual(calm.summary.items.map((it) => it.tone || ""), ["", "ok", "", ""]);
  assert.equal(calm.summary.hint, "");
  assert.equal(buildHistorySummaryHtml({ visible: false }), "");
});

test("行：状态 / 结束时刻 / 耗时 / 节点 · 分区 / 退出原因；有问题的带级别", () => {
  const { rows } = buildHistoryModel({ data: response(), now: NOW });
  assert.deepEqual(rows.map((r) => r.kind), ["job", "group", "job", "group", "group", "job", "job"]);
  const pick = (r) => [r.rowKind, r.level, r.state.label, r.state.tone, r.endText, r.elapsedText, r.where, r.exitText];

  assert.deepEqual(pick(rows[0]), ["problem", "critical", "内存不足", "critical", "今天 09:00", "10 分", "master · GPU", "超出申请内存"]);
  assert.deepEqual(pick(rows[1]), ["problem", "critical", "4 失败", "critical", "昨天 12:00 – 15:00", "18 分", "node05 · CPU", "退出码 1 等 2 种"]);
  assert.deepEqual(pick(rows[2]), ["problem", "critical", "超时", "critical", "昨天 03:00", "3 小时", "node06 · CPU", "到达时限"]);
  assert.deepEqual(pick(rows[3]), ["problem", "warn", "20 已取消", "warn", "10.1 19:59 – 20:00", "5 分", "node01–02 · CPU", "手动取消"]);
  // 一批作业落在同一分钟结束：只写一个时刻，不写「17:11 – 17:11」
  const sameMinute = response();
  sameMinute.rows[3].firstEndAt = NOW - 40 * HOUR + 5_000;
  sameMinute.rows[3].lastEndAt = NOW - 40 * HOUR + 30_000;
  assert.equal(buildHistoryModel({ data: sameMinute, now: NOW }).rows[3].endText, "10.1 20:00");
  assert.deepEqual(pick(rows[4]), ["done", "", "600 完成", "ok", "昨天 21:00 – 今天 11:59", "38 – 60 分", "node01–07 · CPU", "—"]);
  assert.deepEqual(pick(rows[5]), ["done", "", "完成", "ok", "今天 00:12", "37 分", "node03 · CPU", "0"]);
  assert.deepEqual(pick(rows[6]), ["done", "", "完成", "ok", "昨天 23:30", "6 小时 12 分", "master · GPU", "0"]);

  assert.deepEqual([rows[4].label, rows[4].count, rows[4].stagesText, rows[4].expanded], ["cfa-agiter20-*", 600, "cfd1 ×580 · prepare1 ×20", false]);
  assert.match(rows[4].title, /^cfa-agiter20-\* · 600 个作业（点击展开）\n完成\n结束于 昨天 21:00 – 今天 11:59 · 耗时 38 – 60 分\n阶段 cfd1 ×580 · prepare1 ×20$/);
  assert.equal(rows[0].title, "作业 16921 · train_lora\n内存不足 · 超出申请内存\n结束于 今天 09:00 · 耗时 10 分\nmaster · GPU");
});

test("筛选与展开：只看有问题 / 只看完成；展开后组内作业紧跟组行，带不全的写「还有 N 个」", () => {
  const data = response();
  const problem = buildHistoryModel({ data, now: NOW, view: { filter: "problem" } });
  assert.equal(problem.rows.length, 4);
  assert.ok(problem.rows.every((r) => r.rowKind === "problem"));
  assert.deepEqual(problem.filters.map((f) => f.active), [false, true, false]);
  const finished = buildHistoryModel({ data, now: NOW, view: { filter: "done" } });
  assert.deepEqual(finished.rows.map((r) => (r.kind === "group" ? r.label : r.name)), ["cfa-agiter20-*", "m1cap_v51dcv_post", "m1cap_v51dcv"]);
  assert.equal(buildHistoryModel({ data, now: NOW, view: { filter: "nope" } }).filter, "all", "非法筛选回落到全部");

  const open = buildHistoryModel({ data, now: NOW, view: { expanded: new Set(["FAILED|cfa-agiter19", "COMPLETED|cfa-agiter20", "CANCELLED|cfa-agiter18"]) } });
  assert.deepEqual(open.rows.map((r) => (r.kind === "more" ? r.text : r.kind === "group" ? `${r.label}${r.expanded ? " ▾" : ""}` : r.id)), [
    "16921",
    "cfa-agiter19-* ▾", "16804", "16803", "还有 2 个…",
    "16655",
    "cfa-agiter18-* ▾", "16101", "16100",
    "cfa-agiter20-* ▾", "17500", "17499", "还有 598 个…",
    "17431", "17430",
  ]);
  const child = open.rows[2];
  assert.deepEqual([child.child, child.parent, child.level, child.exitText], [true, "FAILED|cfa-agiter19", "critical", "退出码 137"]);
  assert.match(child.title, /失败 · 退出码 137，疑似内存不足/);
  const neverStarted = open.rows[8];
  assert.deepEqual([neverStarted.where, neverStarted.elapsedText, neverStarted.exitText], ["未分配 · CPU", "0 秒", "手动取消"]);

  const html = buildHistoryRowsHtml(open.rows);
  assert.match(html, /<tr class="cl-group" data-cl-hist-group="FAILED\|cfa-agiter19" data-kind="problem" data-level="critical" aria-expanded="true" tabindex="0"/);
  assert.match(html, /<tr data-kind="problem" data-level="critical" class="cl-group-child" data-parent="FAILED\|cfa-agiter19"/);
  assert.match(html, /<tr class="cl-group-child cl-group-more" data-kind="done" data-parent="COMPLETED\|cfa-agiter20"><td class="cl-group-more-cell" colspan="6">还有 598 个…<\/td><\/tr>/);
  assert.match(html, /<span class="cl-group-caret" aria-hidden="true">▾<\/span><span class="cl-job-name">cfa-agiter20-\*<\/span><span class="cl-group-count">×600<\/span><span class="cl-job-sub cl-group-stages">cfd1 ×580 · prepare1 ×20<\/span>/);
  assert.match(html, /<td class="cl-job-end">今天 00:12<\/td><td class="cl-job-time">37 分<\/td><td class="cl-job-where">node03 · CPU<\/td><td class="cl-job-exit">0<\/td>/);
  assert.equal(HISTORY_COLUMNS.length, 6);
});

test("没拿全：数字挂「+」并在表格下方说明，不默默少算", () => {
  const cut = buildHistoryModel({ data: response({ truncated: true, total: 7000, kept: 6000 }), now: NOW });
  assert.deepEqual(cut.summary.items.map((it) => it.value), ["1,118+", "1,091+", "7+", "20+"]);
  assert.equal(cut.noteText, "作业太多：近 48 小时共 7,000 个，只取到最新的 6,000 个，上面的数字偏少。");
  // SSH 输出被本机接收上限截断：不知道差多少，也要说
  const unknown = buildHistoryModel({ data: response({ truncated: true, total: 1137, kept: 1137 }), now: NOW });
  assert.equal(unknown.noteText, "作业记录没有取全（输出过大），上面的数字偏少。");
  const omitted = buildHistoryModel({ data: response({ rowsOmitted: 12 }), now: NOW });
  assert.equal(omitted.noteText, "另有 12 行没有列出。");
  const stale = buildHistoryModel({ data: response(), error: "HTTP 503", now: NOW });
  assert.equal(stale.noteText, "刷新失败（HTTP 503），显示的是上次取到的数据。");
  assert.equal(stale.rows.length, 7, "刷新失败时保留上次的列表");
});

test("空态：加载中 / 加载失败 / 尚未采集 / 没有记账 / 读取失败 / 筛选后为空", () => {
  const empty = (input) => buildHistoryModel({ now: NOW, ...input });
  assert.equal(empty({ loading: true }).emptyText, "正在读取作业记录…");
  assert.equal(empty({ error: "网络错误" }).emptyText, "作业历史加载失败：网络错误");
  assert.equal(empty({ error: "网络错误" }).state, "error");
  assert.equal(empty({ data: response({ state: "none", summary: {}, rows: [] }) }).emptyText, "还没有采集到这台服务器的作业记录（每 5 分钟采集一次，稍后再看）");
  assert.equal(empty({ data: response({ state: "absent", rows: [] }) }).emptyText, "这个集群没有作业记账（sacct），看不了作业历史");
  assert.equal(empty({ data: response({ state: "error", reason: "sacct 超时（slurmdbd 无响应）", rows: [] }) }).emptyText, "作业记录读取失败：sacct 超时（slurmdbd 无响应）");
  // 从没取到数据：红色「暂时取不到」+ 原有的具体原因；加载中 / 尚未采集 / 没有记账仍是一句话。
  const failedState = empty({ error: "网络错误" }).emptyState;
  assert.equal(failedState.tone, "error");
  assert.equal(failedState.title, "暂时取不到作业历史");
  assert.equal(failedState.body, "网络错误；稍后会自动重试。");
  const sacctFailed = empty({ data: response({ state: "error", reason: "sacct 超时（slurmdbd 无响应）", rows: [] }) }).emptyState;
  assert.equal(sacctFailed.tone, "error");
  assert.match(sacctFailed.body, /^作业记录读取失败：sacct 超时（slurmdbd 无响应）。/);
  for (const input of [{ loading: true }, { data: response({ state: "none", summary: {}, rows: [] }) }, { data: response({ state: "absent", rows: [] }) }]) {
    assert.equal(empty(input).emptyState, null);
  }

  const noProblem = empty({ data: response({ rows: [done("1", "a", HOUR, 60)], summary: { ended: 1, completed: 1, failed: 0, cancelled: 0, other: 0 } }), view: { filter: "problem" } });
  assert.equal(noProblem.emptyText, "近 48 小时没有失败或取消的作业");
  assert.match(buildHistoryRowsHtml(noProblem.rows, noProblem.emptyText), /<tr class="cl-job-empty"><td colspan="6">近 48 小时没有失败或取消的作业<\/td><\/tr>/);
  const nothing = empty({ data: response({ rows: [], summary: { ended: 0, completed: 0, failed: 0, cancelled: 0, other: 0 } }) });
  assert.equal(nothing.emptyText, "近 48 小时没有结束的作业");
  // 全部为空：完整空状态（sacct 每 5 分钟同步 + 按作业号或日期查）；有问题筛选为空仍是一句话。
  assert.equal(nothing.emptyState.title, "近 48 小时没有结束的作业");
  assert.match(nothing.emptyState.body, /sacct 每 5 分钟同步/);
  assert.deepEqual(nothing.emptyState.actions, [{ label: "按作业号或日期查", kind: "secondary", attrs: { "data-cl-lookup-focus": "" } }]);
  const nothingHtml = buildHistoryRowsHtml(nothing.rows, nothing.emptyState);
  assert.match(nothingHtml, /^<tr class="cl-job-empty"><td colspan="6"><div class="empty-state" data-tone="neutral">/);
  assert.match(nothingHtml, /data-cl-lookup-focus="">按作业号或日期查<\/button>/);
  assert.equal(noProblem.emptyState, null);

  // 非 ok 状态不出汇总条，筛选计数为 0
  const none = empty({ data: response({ state: "none", rows: [] }) });
  assert.equal(none.summary.visible, false);
  assert.deepEqual(none.filters.map((f) => f.count), [0, 0, 0]);
});

test("防御：少见终态、缺字段与畸形行不抛错；动态文案全部转义", () => {
  const data = response({
    summary: { ended: 3, completed: 0, failed: 1, cancelled: 0, other: 2 },
    rows: [
      null,
      "x",
      { kind: "job", outcome: "failed", id: "9", name: "<img src=x>", state: "REVOKED", exitCode: 3, signal: 0, endAt: null, elapsedSec: null, nodes: null, partition: null },
      { kind: "job", outcome: "other", id: "8", name: null, state: "SPECIAL_EXIT", exitCode: 0, signal: 0, endAt: NOW - HOUR, elapsedSec: 5, nodes: "node[01-03]", partition: "CPU" },
      { kind: "group", outcome: "failed", key: "NODE_FAIL|x", state: "NODE_FAIL", label: "x-*", count: 3, firstEndAt: null, lastEndAt: null },
    ],
  });
  const m = buildHistoryModel({ data, now: NOW, view: { expanded: new Set(["NODE_FAIL|x"]) } });
  assert.deepEqual(m.rows.map((r) => [r.state.label, r.endText, r.elapsedText, r.where, r.exitText]), [
    ["失败", "—", "—", "—", "退出码 3"],
    ["SPECIAL_EXIT", "今天 11:00", "5 秒", "node01–03 · CPU", "—"],
    ["3 节点故障", "—", "—", "—", "—"],
  ]);
  assert.equal(m.summary.items.at(-1).label, "其它");
  assert.deepEqual(m.filters.map((f) => f.count), [3, 1, 2]);
  const html = buildHistoryRowsHtml(m.rows);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x&gt;/);
});
