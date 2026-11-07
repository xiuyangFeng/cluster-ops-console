// 关注区「进度依据」里的子任务（v2.51）与服务器页排队行的预计开始时间（C3）。
import assert from "node:assert/strict";
import test from "node:test";
import { inEveryTimeZone } from "../../../../lib/test-timezones.mjs";
import { buildClusterPanelModel, describeStartEstimate } from "./cluster-model.js";
import { buildGroupedJobRowsHtml } from "./cluster-view.js";
import { buildSubrunHtml, buildWatchListHtml, sparklineSvg, subrunSummaryText } from "./job-watch-view.js";

const NOW = Date.parse("2026-10-06T14:20:00+08:00");
const subruns = {
  launched: 44, ended: 42, failed: 1, orphanEnds: 0, runningCount: 2, ambiguous: 0, finalized: false, finalNote: null, catchingUp: false, checkedAt: NOW,
  gaps: [{ kind: "head", at: NOW - 3600000, text: "首次读取时 stdout 已很大" }],
  running: [
    { run: "VFG_f0_s1234", phase: "train", attempt: 1, launchAt: NOW - 30 * 60000, status: "running", ambiguous: false,
      log: { format: "text", missing: false, lastLogAt: NOW - 60000, epoch: 206, total: 400, metrics: [["loss", 0.1801], ["norm_mae", 0.2331]], best: true, primary: "loss", history: [0.2, 0.19, 0.185, 0.1801], restarted: false, lastLine: "", eta: { endLo: NOW + 3 * 3600000, endHi: NOW + 3.3 * 3600000, points: 6, secPerEpoch: 55.5 }, etaNote: null } },
    { run: "<b>X</b>", phase: "eval_best", attempt: 2, launchAt: NOW - 60000, status: "running", ambiguous: true,
      log: { format: "unknown", missing: false, lastLogAt: NOW - 5000, epoch: null, metrics: [], history: [], lastLine: "<script>alert(1)</script>", eta: null, etaNote: null } },
  ],
  failedRuns: [{ run: "PFG_f1_s1234", phase: "train", attempt: 1, code: -15, endAt: NOW - 600000, status: "failed", orphan: false }],
  recent: [{ run: "VFB_f3_s1234", phase: "eval_last", endAt: NOW - 240000, status: "ok" }],
  unended: [],
};

test("子任务摘要：已启动 / 已结束 / 失败 / 正在跑，不出现完成率或「还剩」", () => {
  assert.equal(subrunSummaryText(subruns), "子任务 已启动 44 · 已结束 42 · 失败 1 · 正在跑 2");
  const html = buildSubrunHtml(subruns, NOW);
  assert.doesNotMatch(html, /还剩|完成率\s*\d|%/);
  assert.match(html, /总子任务数未知/);
  assert.match(html, /Epoch 206 \/ 400 · loss 0\.1801 · norm_mae 0\.2331 · 本轮最佳/);
  assert.match(html, /粗估 17:20–17:38 训练完（按最近 6 个 epoch/);
  assert.match(html, /退出码 -15/);
  assert.match(html, /覆盖缺口/);
  assert.match(html, /第 2 次/);
  assert.match(html, /无法配对/);
  assert.match(html, /<svg class="jw-spark"/);
});

test("远端文本全部转义；走势少于 3 个点不画", () => {
  const html = buildSubrunHtml(subruns, NOW);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<b>X</b>"), false);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(sparklineSvg([1, 2]), "");
  assert.match(sparklineSvg([3, 2, 1], 'a"b'), /aria-label="a&quot;b 最近 3 个记录/);
  assert.equal(buildSubrunHtml(null), "");
});

test("关注列表：运行中作业行带子任务摘要，展开后并入进度依据；结束后的复盘里也保留", () => {
  const data = { watches: [{ id: "w", label: "wallgate", jobIds: ["18764", "18765"], jobs: [
    { id: "18764", name: "xp_wallgate_vol", state: "RUNNING", outcome: "running", progress: { status: "ok", detail: "d" }, subruns },
    { id: "18765", name: "xp_wallgate_main", state: "COMPLETED", outcome: "completed", progress: {}, resources: null, subruns: { ...subruns, failed: 0, failedRuns: [], running: [], runningCount: 0, finalized: true, unended: [{ run: "M1G_f0_s1234", phase: "train", attempt: 1 }] } },
  ] }] };
  const closed = buildWatchListHtml(data, { now: NOW });
  assert.match(closed, /data-subrun-failed="true"/);
  assert.match(closed, /子任务 已启动 44 · 已结束 42 · 失败 1 · 正在跑 2/);
  assert.doesNotMatch(closed, /jw-subruns/);
  const open = buildWatchListHtml(data, { now: NOW, expanded: new Set(["18764", "18765"]) });
  assert.equal((open.match(/class="jw-subruns"/g) || []).length, 2);
  assert.match(open, /未见结束 1/);
  assert.match(open, /作业结束时仍未见结束记录/);
});

test("子任务与预计开始的时刻按北京时间，与机器时区无关", async () => {
  const sampled = NOW - 30000; // 北京时间 10-06 14:19:30
  await inEveryTimeZone((zone) => {
    const html = buildSubrunHtml(subruns, NOW);
    assert.match(html, /粗估 17:20–17:38 训练完/, zone);
    assert.match(html, /覆盖缺口（13:20）/, zone);
    assert.match(html, /14:10 结束/, zone);
    assert.match(html, /VFB_f3_s1234 eval_last 14:16/, zone);
    // 采样当天 / 次日 / 更远：日期前缀按北京时间的日历算（采样时刻在别的时区可能已是另一天）
    assert.equal(describeStartEstimate(Date.parse("2026-10-06T23:59:00+08:00"), sampled, NOW).text, "预计 23:59 开始 · 14:19 估算", zone);
    const tomorrow = describeStartEstimate(Date.parse("2026-10-07T04:02:28+08:00"), sampled, NOW);
    assert.equal(tomorrow.text, "预计 明天 04:02 开始 · 14:19 估算", zone);
    assert.equal(tomorrow.title, "预计开始 2026-10-07 04:02（Slurm 回填调度估算，14:19 采样，会随队列变化，不是承诺）", zone);
    assert.equal(describeStartEstimate(Date.parse("2026-10-09T00:00:00+08:00"), sampled, NOW).text, "预计 10-09 00:00 开始 · 14:19 估算", zone);
    // 深夜采样、几分钟后跨过北京时间零点：是「明天」
    const lateSampled = Date.parse("2026-10-06T23:58:00+08:00");
    assert.equal(describeStartEstimate(Date.parse("2026-10-07T00:05:00+08:00"), lateSampled, lateSampled).text, "预计 明天 00:05 开始 · 23:58 估算", zone);
  });
});

test("预计开始时间：只给本人排队作业，过去 / 哨兵 / 解析不出的不显示，带采样时刻与估算说明", () => {
  const sampled = NOW - 30000;
  const tomorrow = Date.parse("2026-10-07T04:02:28+08:00");
  const est = describeStartEstimate(tomorrow, sampled, NOW);
  assert.ok(est);
  assert.match(est.title, /Slurm 回填调度估算/);
  assert.equal(est.text, "预计 明天 04:02 开始 · 14:19 估算");
  assert.equal(describeStartEstimate(null, sampled, NOW), null);
  assert.equal(describeStartEstimate(sampled - 1000, sampled, NOW), null);
  assert.equal(describeStartEstimate(Date.parse("2099-01-01T00:00:00Z"), sampled, NOW), null);
  const layer = { slurm: { state: "ok", user: "me", checkedAt: sampled, nodes: [], jobs: [
    { id: "18779", name: "mine", user: "me", state: "PENDING", reason: "Resources", startAt: tomorrow, waitSec: 60 },
    { id: "18780", name: "theirs", user: "other", state: "PENDING", reason: "Priority", startAt: tomorrow, waitSec: 60 },
    { id: "18781", name: "running", user: "me", state: "RUNNING", startAt: NOW - 60000, elapsedSec: 60, nodeList: "node01" },
  ] } };
  const model = buildClusterPanelModel({ layer, now: NOW });
  const html = buildGroupedJobRowsHtml(model.jobRows);
  assert.equal((html.match(/预计 /g) || []).length, 1);
  const mine = model.jobRows.find((r) => r.job?.id === "18779").job;
  assert.match(mine.title, /预计开始 2026-10-07/);
  assert.match(html, /title="预计开始 2026-10-07/);
});
