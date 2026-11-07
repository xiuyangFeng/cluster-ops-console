import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes as frontendFormatBytes } from "../../public/assets/js/store.js";
import { parseFilesystem } from "../collector.mjs";
import { emptyDirUsageRecord } from "../dir-usage/model.mjs";
import { bus, EVENTS } from "../event-bus.mjs";
import { collectSlowProbeId } from "../probe-ids.mjs";
import { buildResourceUsage } from "../resource-usage.mjs";
import { createStateStore } from "../state-store.mjs";
import {
  briefGrowthClause, buildDiskGrowthView, buildSummary, computeGrowth, diskOf, dueReason, EARLY_MIN_GAP_MS, filesystemFromResources,
  formatBytes, growthSentence, isListableName, KEEP_CHILDREN, NAME_MAX, pickReference, RETRY_AFTER_FAILURE_MS, risePoints,
  SCHEDULE_INTERVAL_MS, spanLabel, summarizeScan, SUMMARY_FRESH_MS, VIEW_ROWS,
} from "./model.mjs";

const HOUR = 3600_000;
const GIB = 2 ** 30;
const TIB = 2 ** 40;
const NOW = Date.UTC(2026, 9, 12, 6, 0);
const OUTPUTS = "Digital_twin/GNN/outputs";
const XP = "Digital_twin/GNN/training_wss_min/experiments";

const result = (root, children, over = {}) => ({ root, jobs: 10, at: NOW, state: "ok", error: null, c: children.map(([name, bytes, partial = 0]) => [name, bytes, partial]), o: [0, 0, 0, 0], ...over });
const measurement = (at, roots, over = {}) => ({ at, startedAt: at - 60_000, trigger: "schedule", complete: roots.every((r) => r.state === "ok"), stop: null, rounds: 5, disk: null, roots, ...over });
const disk = (usedTib) => ({ used: usedTib * TIB, total: 44 * TIB, pct: Math.round((usedTib / 44) * 100) });

test("扫描记录 → 测量结果：最大的 40 个单列，其余与直接文件并成一项；没轮到 / 没扫完 / 被扫描器丢过子目录的都标没量完", () => {
  const record = emptyDirUsageRecord({ root: OUTPUTS, home: "/public/home/kai", now: NOW });
  record.complete = false;
  for (let i = 0; i < KEEP_CHILDREN + 5; i += 1) record.agg1[`batch_${String(i).padStart(2, "0")}`] = [(100 - i) * GIB, 0, 10, 2];
  record.agg1["bad\u0001name"] = [500 * GIB, 0, 1, 0];
  record.agg1["x".repeat(NAME_MAX + 1)] = [7 * GIB, 0, 1, 0];
  record.agg1Over = [3 * GIB, 0, 0, 0];
  record.rootFiles = [2 * GIB, 0, 4];
  record.pending = [["batch_03/units/AD", 12], ["batch_41", 0]];
  const out = summarizeScan(record, { truncated: new Set(["batch_05"]) });
  assert.equal(out.complete, false);
  assert.equal(out.c.length, KEEP_CHILDREN);
  assert.deepEqual(out.c[0], ["batch_00", 100 * GIB, 0]);
  assert.deepEqual(out.c[3], ["batch_03", 97 * GIB, 1], "游标里还有它下面的目录");
  assert.deepEqual(out.c[5], ["batch_05", 95 * GIB, 1], "扫描器丢过它的子目录");
  assert.ok(!out.c.some((child) => child[0].includes("\u0001") || child[0].length > NAME_MAX), "不合格的名字不单列");
  // 其余 = 第 41–45 个 + 两个不能单列的 + 超出扫描器上限的合计 + 直接文件
  const rest = [60, 59, 58, 57, 56].reduce((sum, n) => sum + n * GIB, 0) + 500 * GIB + 7 * GIB;
  assert.deepEqual(out.o, [rest + 3 * GIB + 2 * GIB, 7, 500 * GIB, 1]);

  const done = emptyDirUsageRecord({ root: OUTPUTS, now: NOW });
  done.complete = true;
  done.agg1 = { a: [5, 0, 0, 0], b: [9, 0, 0, 0], c: [9, 0, 0, 0] };
  assert.deepEqual(summarizeScan(done), { complete: true, c: [["b", 9, 0], ["c", 9, 0], ["a", 5, 0]], o: [0, 0, 0, 0] });
  assert.equal(summarizeScan(done, { truncated: new Set(["a"]) }).complete, false);
  // 集合目录这一层还没列完：没列出来的子目录可能还有，「其余」不可信
  done.pending = [["", 2]];
  assert.equal(summarizeScan(done).o[3], 1);
  assert.equal(isListableName("数据 集 'q'"), true);
  assert.equal(isListableName("\ud800"), false);
  assert.equal(isListableName(""), false);
});

test("约 24 小时前的那一次：离 24 小时最近、至少隔 3 小时、至多 48 小时", () => {
  const at = (hours) => measurement(NOW - hours * HOUR, [result(OUTPUTS, [["a", 1]])]);
  const latest = at(0);
  const list = [at(60), at(30), at(20), at(6), at(1), latest];
  assert.equal(pickReference(list, latest).at, NOW - 20 * HOUR);
  assert.equal(pickReference([at(60), at(2), latest], latest), null, "太远和太近的都不算");
  assert.equal(pickReference([at(6), at(1), latest], latest).at, NOW - 6 * HOUR, "第一天只有 6 小时前那次：照用，间隔如实写");
  assert.equal(pickReference([latest], latest), null);
  assert.equal(spanLabel(24 * HOUR), "近 24 小时");
  assert.equal(spanLabel(21.5 * HOUR), "近 24 小时");
  assert.equal(spanLabel(6 * HOUR), "近 6 小时");
  assert.equal(spanLabel(40 * HOUR), "近 40 小时");
  assert.equal(spanLabel(null), "");
});

test("增长：两次都量完的子目录相减；合计、增长最多的目录、占整盘同期增长的比例", () => {
  const ref = measurement(NOW - 24 * HOUR, [
    result(OUTPUTS, [["cfd_auto_ad_repro_20261009", 600 * GIB], ["cfd_auto_ad_repro_20261008", 400 * GIB], ["old_batch", 300 * GIB]]),
    result(XP, [["xp_a", 50 * GIB], ["xp_b", 20 * GIB]]),
  ], { disk: disk(36) });
  const latest = measurement(NOW, [
    result(OUTPUTS, [["cfd_auto_ad_repro_20261009", 1700 * GIB], ["cfd_auto_ad_repro_20261008", 400 * GIB], ["old_batch", 280 * GIB]]),
    result(XP, [["xp_a", 130 * GIB], ["xp_b", 20 * GIB]]),
  ], { disk: disk(38) });
  const growth = computeGrowth(latest, ref);
  assert.equal(growth.spanMs, 24 * HOUR);
  assert.deepEqual(growth.rows.map((row) => [row.name, row.delta]), [
    ["cfd_auto_ad_repro_20261009", 1100 * GIB], ["cfd_auto_ad_repro_20261008", 0], ["old_batch", -20 * GIB], ["xp_a", 80 * GIB], ["xp_b", 0],
  ]);
  assert.deepEqual(growth.roots.map((root) => [root.root, root.bytes, root.delta, root.partial]), [[OUTPUTS, 2380 * GIB, 1080 * GIB, false], [XP, 150 * GIB, 80 * GIB, false]]);
  assert.deepEqual(growth.total, { bytes: 2530 * GIB, delta: 1160 * GIB, partial: false });
  assert.deepEqual(growth.top, { root: OUTPUTS, name: "cfd_auto_ad_repro_20261009", delta: 1100 * GIB, lowerBound: false });
  assert.equal(growth.diskDelta, 2 * TIB);
  assert.ok(Math.abs(growth.share - 1160 / 2048) < 1e-9);

  // 没有上一次：只有大小
  const alone = computeGrowth(latest, null);
  assert.equal(alone.refAt, null);
  assert.ok(alone.rows.every((row) => row.delta === null));
  assert.deepEqual(alone.total, { bytes: 2530 * GIB, delta: null, partial: false });
  assert.equal(alone.share, null);
  // 整盘没涨（别人删得比写得多）或缺整盘用量：不给比例
  assert.equal(computeGrowth({ ...latest, disk: disk(36) }, ref).share, null);
  assert.equal(computeGrowth({ ...latest, disk: null }, ref).share, null);
  assert.equal(computeGrowth({ ...latest, disk: { used: null, total: null, pct: 91 } }, ref).share, null);
});

test("增长：目录新出现 / 消失、上一次没单列、任一边没量完、集合目录换了，都不出错也不乱算", () => {
  const ref = measurement(NOW - 24 * HOUR, [
    result(OUTPUTS, [["kept", 100 * GIB], ["gone", 50 * GIB], ["half_then", 10 * GIB, 1]]),
  ]);
  const latest = measurement(NOW, [
    result(OUTPUTS, [["kept", 130 * GIB], ["fresh", 300 * GIB], ["half_then", 40 * GIB], ["half_now", 5 * GIB, 1]], { state: "partial" }),
    result(XP, [["xp_a", 9 * GIB]]),
  ]);
  const growth = computeGrowth(latest, ref);
  const byName = Object.fromEntries(growth.rows.map((row) => [row.name, row]));
  assert.equal(byName.kept.delta, 30 * GIB);
  assert.deepEqual([byName.fresh.delta, byName.fresh.isNew, byName.fresh.lowerBound], [300 * GIB, true, false], "上一次列全了且没有它：新出现，增长 = 它的大小");
  assert.equal(byName.half_then.delta, null, "上一次没量完");
  assert.equal(byName.half_now.delta, null, "这一次没量完");
  assert.equal(byName.xp_a.delta, null, "上一次没有这个集合目录");
  assert.ok(!("gone" in byName), "消失的目录不出行");
  // 有一边没量完：合计只算两次都量完的子目录，并标出来
  assert.deepEqual(growth.roots.map((root) => [root.delta, root.partial]), [[330 * GIB, true], [null, true]]);
  assert.deepEqual(growth.total, { bytes: 484 * GIB, delta: 330 * GIB, partial: true });

  // 两次都量完：消失的目录让合计变小
  const full = computeGrowth(
    measurement(NOW, [result(OUTPUTS, [["kept", 100 * GIB]])]),
    measurement(NOW - 24 * HOUR, [result(OUTPUTS, [["kept", 100 * GIB], ["gone", 50 * GIB]])]),
  );
  assert.deepEqual(full.total, { bytes: 100 * GIB, delta: -50 * GIB, partial: false });
  assert.equal(full.top, null);

  // 上一次它不在最大的 40 个里：当时不超过「其余」里最大的那个 → 增长按下限算
  const before = measurement(NOW - 24 * HOUR, [result(OUTPUTS, [["big", 900 * GIB]], { o: [30 * GIB, 12, 4 * GIB, 0] })]);
  const after = (bytes) => measurement(NOW, [result(OUTPUTS, [["big", 900 * GIB], ["riser", bytes]], { o: [26 * GIB, 11, 4 * GIB, 0] })]);
  const bounded = computeGrowth(after(304 * GIB), before);
  assert.deepEqual(bounded.rows[1], { root: OUTPUTS, name: "riser", bytes: 304 * GIB, partial: false, at: NOW, delta: 300 * GIB, lowerBound: true, isNew: false });
  assert.equal(bounded.total.delta, 300 * GIB, "两次都量完时合计仍是精确的");
  assert.equal(bounded.top.lowerBound, true);
  assert.equal(computeGrowth(after(3 * GIB), before).rows[1].delta, null, "没超过那个上限：说不出涨了多少");
  // 上一次「其余」里有没量完的：连下限也给不出
  before.roots[0].o[3] = 1;
  assert.equal(computeGrowth(after(304 * GIB), before).rows[1].delta, null);

  // 远端拒绝 / 没轮到的集合目录：只占一行说明，不参与任何数字
  const broken = computeGrowth(measurement(NOW, [result(OUTPUTS, [], { state: "error", error: "outside-home" }), result(XP, [], { state: "skipped" })]), ref);
  assert.deepEqual(broken.rows, []);
  assert.deepEqual(broken.total, { bytes: 0, delta: null, partial: true });
  assert.deepEqual(broken.roots.map((root) => [root.state, root.bytes, root.children]), [["error", null, 0], ["skipped", null, 0]]);
});

test("一句话：事件详情与简报的文案；最近一次太旧或没有可比的测量时不说", () => {
  const entry = (latestRoots, refRoots, { latestDisk = disk(38), refDisk = disk(36), span = 24 } = {}) => ({
    measurements: [measurement(NOW - span * HOUR, refRoots, { disk: refDisk }), measurement(NOW, latestRoots, { disk: latestDisk })],
  });
  const grown = entry(
    [result(OUTPUTS, [["cfd_auto_ad_repro_20261009", 1700 * GIB], ["b", 400 * GIB]])],
    [result(OUTPUTS, [["cfd_auto_ad_repro_20261009", 600 * GIB], ["b", 340 * GIB]])],
  );
  const summary = buildSummary(grown, { nowMs: NOW + HOUR });
  assert.deepEqual([summary.label, summary.total.delta, summary.top.name, summary.complete], ["近 24 小时", 1160 * GIB, "cfd_auto_ad_repro_20261009", true]);
  assert.equal(growthSentence(summary), "近 24 小时你的作业目录增长约 1.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 +1.1 TiB");
  assert.equal(briefGrowthClause(summary), "其中你的 cfd_auto_ad_repro_20261009 近 24 小时 +1.1 TiB");

  // 占比不到 30%：简报不提；事件详情照说
  const minor = buildSummary(entry([result(OUTPUTS, [["a", 150 * GIB]])], [result(OUTPUTS, [["a", 100 * GIB]])]), { nowMs: NOW });
  assert.equal(briefGrowthClause(minor), "");
  assert.equal(growthSentence(minor), "近 24 小时你的作业目录增长约 50 GiB（占整盘同期增长的 2%），其中 a +50 GiB");
  // 增长分散在很多目录里：简报说合计，不点某一个的名
  const spread = buildSummary(entry(
    [result(OUTPUTS, [["a", 400 * GIB], ["b", 400 * GIB], ["c", 400 * GIB]])],
    [result(OUTPUTS, [["a", 100 * GIB], ["b", 100 * GIB], ["c", 100 * GIB]])],
  ), { nowMs: NOW });
  assert.equal(briefGrowthClause(spread), "其中你的作业目录近 24 小时 +900 GiB");
  // 作业目录涨得比整盘净增长还多（别人同期删了东西）
  const over = buildSummary(entry([result(OUTPUTS, [["a", 900 * GIB]])], [result(OUTPUTS, [["a", 100 * GIB]])], { latestDisk: disk(36.5) }), { nowMs: NOW });
  assert.equal(growthSentence(over), "近 24 小时你的作业目录增长约 800 GiB（超过整盘同期的净增长），其中 a +800 GiB");
  assert.match(briefGrowthClause(over), /^其中你的 a 近 24 小时 \+800 GiB$/);
  // 没有整盘用量：不带比例；简报不提
  const blind = buildSummary(entry([result(OUTPUTS, [["a", 900 * GIB]])], [result(OUTPUTS, [["a", 100 * GIB]])], { latestDisk: null }), { nowMs: NOW });
  assert.equal(growthSentence(blind), "近 24 小时你的作业目录增长约 800 GiB，其中 a +800 GiB");
  assert.equal(briefGrowthClause(blind), "");
  // 没涨 / 变小 / 间隔不是 24 小时 / 没量完 / 下限
  const flat = buildSummary(entry([result(OUTPUTS, [["a", 100 * GIB + 5]])], [result(OUTPUTS, [["a", 100 * GIB]])]), { nowMs: NOW });
  assert.equal(growthSentence(flat), "近 24 小时你的作业目录没有明显增长");
  assert.equal(briefGrowthClause(flat), "");
  const shrunk = buildSummary(entry([result(OUTPUTS, [["a", 40 * GIB]])], [result(OUTPUTS, [["a", 100 * GIB]])]), { nowMs: NOW });
  assert.equal(growthSentence(shrunk), "近 24 小时你的作业目录减少了约 60 GiB");
  const early = buildSummary(entry([result(OUTPUTS, [["a", 130 * GIB]])], [result(OUTPUTS, [["a", 100 * GIB]])], { span: 6, latestDisk: null }), { nowMs: NOW });
  assert.equal(growthSentence(early), "近 6 小时你的作业目录增长约 30 GiB，其中 a +30 GiB");
  const partial = buildSummary(entry(
    [result(OUTPUTS, [["a", 130 * GIB], ["b", 9 * GIB, 1]], { state: "partial" })],
    [result(OUTPUTS, [["a", 100 * GIB], ["b", 50 * GIB]])],
    { latestDisk: null },
  ), { nowMs: NOW });
  assert.equal(partial.complete, false);
  assert.equal(growthSentence(partial), "近 24 小时你的作业目录（只算量完的部分）增长约 30 GiB，其中 a +30 GiB");
  const bound = buildSummary(entry(
    [result(OUTPUTS, [["big", 900 * GIB], ["riser", 304 * GIB]], { o: [26 * GIB, 11, 4 * GIB, 0] })],
    [result(OUTPUTS, [["big", 900 * GIB]], { o: [30 * GIB, 12, 4 * GIB, 0] })],
  ), { nowMs: NOW });
  assert.equal(growthSentence(bound), "近 24 小时你的作业目录增长约 300 GiB（占整盘同期增长的 15%），其中 riser 至少 +300 GiB");
  // 目录名太长时截短
  const long = buildSummary(entry([result(OUTPUTS, [["n".repeat(100), 900 * GIB]])], [result(OUTPUTS, [["n".repeat(100), 100 * GIB]])], { latestDisk: null }), { nowMs: NOW });
  assert.match(growthSentence(long), /其中 n{47}… \+800 GiB$/);

  assert.equal(buildSummary(grown, { nowMs: NOW + SUMMARY_FRESH_MS + 1 }), null, "最近一次是 12 小时以前的：不再说「近 24 小时」");
  assert.equal(buildSummary({ measurements: [grown.measurements[1]] }, { nowMs: NOW }), null, "只量过一次");
  assert.equal(buildSummary({ measurements: [] }, { nowMs: NOW }), null);
  assert.equal(buildSummary(null, { nowMs: NOW }), null);
  assert.equal(growthSentence(null), "");
  assert.equal(briefGrowthClause(null), "");
});

test("视图：按增长排序的前 8 个子目录、各集合目录与合计；没推出过集合目录也没量过 → 不显示", () => {
  assert.equal(buildDiskGrowthView(null), null);
  assert.equal(buildDiskGrowthView({ roots: [], measurements: [], attempt: { at: NOW, outcome: "no-roots", error: null } }), null);
  // 推出了集合目录但第一次没量成：给出目录与原因，界面可以让人重试
  const failed = buildDiskGrowthView({ roots: [{ root: OUTPUTS, jobs: 812 }], measurements: [], attempt: { at: NOW, outcome: "error", error: "SSH 在 20 秒内没有返回" } });
  assert.deepEqual([failed.measuredAt, failed.rows.length, failed.roots[0].root, failed.roots[0].jobs, failed.attempt.error], [null, 0, OUTPUTS, 812, "SSH 在 20 秒内没有返回"]);

  const names = Array.from({ length: 12 }, (_, i) => `b${String(i).padStart(2, "0")}`);
  const ref = measurement(NOW - 24 * HOUR, [result(OUTPUTS, names.map((name) => [name, 100 * GIB]))], { disk: disk(36) });
  const latest = measurement(NOW, [
    result(OUTPUTS, names.map((name, i) => [name, (100 + (i === 3 ? 500 : i === 7 ? 200 : i === 9 ? -40 : 0)) * GIB]).concat([["half", 900 * GIB, 1]]), { state: "partial" }),
    result(XP, [], { state: "error", error: "outside-home" }),
  ], { disk: disk(38), complete: false, stop: "deadline", trigger: "disk" });
  const stored = { roots: [{ root: OUTPUTS, jobs: 1 }], measurements: [ref, latest], attempt: { at: NOW, outcome: "partial", error: null } };
  const view = buildDiskGrowthView(stored, { errorText: { "outside-home": "路径上有符号链接" } });
  assert.equal(view.rows.length, VIEW_ROWS);
  assert.equal(view.rowCount, 13);
  assert.deepEqual(view.rows.slice(0, 3).map((row) => [row.name, row.delta]), [["b03", 500 * GIB], ["b07", 200 * GIB], ["b00", 0]]);
  assert.ok(!view.rows.some((row) => row.name === "half" || row.name === "b09"), "没量完的和变小的排在后面，挤不进前 8");
  assert.deepEqual([view.measuredAt, view.complete, view.stop, view.trigger, view.label, view.refAt], [NOW, false, "deadline", "disk", "近 24 小时", NOW - 24 * HOUR]);
  assert.deepEqual(view.roots.map((root) => [root.state, root.error]), [["partial", null], ["error", "路径上有符号链接"]]);
  assert.equal(buildDiskGrowthView(stored).roots[1].error, "远端没有量成", "没登记文案的原因码有兜底");
  assert.deepEqual(view.total, { bytes: 2760 * GIB, delta: 660 * GIB, partial: true });
  assert.ok(Math.abs(view.share - 660 / 2048) < 1e-9);
  // 只量过一次：按大小排
  const first = buildDiskGrowthView({ roots: [], measurements: [latest], attempt: null });
  assert.deepEqual([first.rows[0].name, first.rows[0].delta, first.label, first.refAt], ["half", null, "", null]);
});

test("何时该量：满 6 小时；磁盘涨 1 个百分点且满 1 小时提前量；没量成的 30 分钟后再试", () => {
  assert.equal(dueReason({ nowMs: NOW }), "schedule", "从没量过");
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - SCHEDULE_INTERVAL_MS + 1 }), null);
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - SCHEDULE_INTERVAL_MS }), "schedule");
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW + HOUR }), "schedule", "本机时钟被往回拨过");
  const rose = { lastDisk: disk(38), disk: disk(38.5) }; // 0.5 TiB / 44 TiB ≈ 1.14 个百分点
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - EARLY_MIN_GAP_MS, ...rose }), "disk");
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - EARLY_MIN_GAP_MS + 1, ...rose }), null, "两次之间至少隔 1 小时");
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - 2 * HOUR, lastDisk: disk(38), disk: disk(38.4) }), null, "0.9 个百分点不算");
  assert.equal(dueReason({ nowMs: NOW, lastAt: NOW - 2 * HOUR, lastDisk: null, disk: disk(40) }), null, "上次没记整盘用量：不提前");
  assert.equal(dueReason({ nowMs: NOW, failedAt: NOW - RETRY_AFTER_FAILURE_MS + 1 }), null);
  assert.equal(dueReason({ nowMs: NOW, failedAt: NOW - RETRY_AFTER_FAILURE_MS }), "schedule");
  assert.equal(dueReason({ nowMs: NOW, failedAt: NOW + HOUR }), "schedule", "失败时刻在未来：不拿它拦");

  assert.ok(Math.abs(risePoints(disk(38), disk(38.44)) - 1) < 1e-9);
  assert.equal(risePoints({ used: null, total: null, pct: 90 }, { used: null, total: null, pct: 92 }), 2, "只有百分比时按百分比");
  assert.equal(risePoints(null, disk(38)), null);
  assert.deepEqual(diskOf({ usedBytes: 5, totalBytes: 10, usedPct: 50, checkedAt: 1 }), { used: 5, total: 10, pct: 50 });
  assert.deepEqual(diskOf({ usedPct: 91 }), { used: null, total: null, pct: 91 });
  assert.equal(diskOf({ usedBytes: -1, usedPct: 120 }), null);
  assert.equal(diskOf(null), null);
  const resources = { s1: { usage: { checkedAt: NOW, filesystem: { usedBytes: 5, totalBytes: 10, usedPct: 50 } } }, s2: { usage: { checkedAt: NOW, filesystem: null } }, s3: { usage: null } };
  assert.deepEqual(filesystemFromResources(resources, "s1"), { usedBytes: 5, totalBytes: 10, usedPct: 50, checkedAt: NOW });
  assert.deepEqual(filesystemFromResources(resources, "s2"), { checkedAt: NOW }, "采到了但没有文件系统段：仍说明服务器连得上");
  assert.equal(filesystemFromResources(resources, "s3"), null);
  assert.equal(filesystemFromResources(null, "s1"), null);
});

test("字节文案与前端面板同一规则（store.js formatBytes 的 compact 形式）", () => {
  for (const n of [0, 1, 1023, 1024, 1536, 99.94 * GIB, 99.96 * GIB, 100 * GIB, 251.4 * GIB, 1023.9 * GIB, 1.06 * TIB, 1.7 * TIB, 44 * TIB, 3000 * TIB, 2 ** 60]) {
    assert.equal(formatBytes(n), frontendFormatBytes(n, { compact: true }), String(n));
  }
  assert.equal(formatBytes(1.7 * TIB), "1.7 TiB");
  assert.equal(formatBytes(-1), "—");
  assert.equal(formatBytes(Number.NaN), "—");
});

test("整盘用量取自资源采集已有的那一份：slow 采集的 filesystem 段 → 状态仓资源层 → 这里（不改采集脚本）", () => {
  const store = createStateStore({ config: { activeServerId: "server-01", servers: [{ id: "server-01", name: "主集群", host: "fixture-a.invalid", source: "team" }], agents: [] } });
  assert.equal(filesystemFromResources(store.getLayers().resources, "server-01"), null, "还没采到");
  // 44T 的盘用了 38T（df -P -k 的 1K 块口径）
  const filesystem = parseFilesystem("state=ok\ndevice=/dev/sda1\ntotal_kb=47244640256\nused_kb=40802189312\navail_kb=4080218931\ncapacity_pct=91\nmount=/public\n");
  const usage = buildResourceUsage({ filesystem, sysText: "", checkedAt: NOW });
  bus.emit(EVENTS.PROBE_UPDATED, { id: collectSlowProbeId("server-01"), result: { level: "ok", checkedAt: NOW, data: { load: { ok: true, cpu: 1, ram: 2, disk: 91, output: "" }, usage } } });
  const seen = filesystemFromResources(store.getLayers().resources, "server-01");
  assert.deepEqual([seen.usedBytes, seen.totalBytes, seen.usedPct, seen.checkedAt], [40802189312 * 1024, 47244640256 * 1024, 91, NOW]);
  assert.deepEqual(diskOf(seen), { used: 38 * TIB, total: 44 * TIB, pct: 91 });
  // 涨 0.44T 正好是这块盘的 1 个百分点
  assert.ok(Math.abs(risePoints(diskOf(seen), { ...diskOf(seen), used: 38.44 * TIB }) - 1) < 1e-9);
});
