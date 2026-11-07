import assert from "node:assert/strict";
import test from "node:test";

import { JOB_GROUP_MIN as FRONT_GROUP_MIN, jobBaseName as frontBaseName } from "../../public/assets/js/render/cluster-model.js";
import {
  buildHistoryGroupPage,
  buildJobsHistory,
  HISTORY_GROUP_PAGE_MAX,
  HISTORY_CHILDREN_MAX,
  HISTORY_PROBLEM_CHILDREN_MAX,
  JOB_GROUP_MIN,
  jobBaseName,
  jobOutcome,
  jobStage,
  liveSnapshotId,
  matchJobToSession,
} from "./model.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 3, 4, 0, 0); // 北京时间 10.3 12:00

let seq = 16000;
function job(name, state, { endAgo = HOUR, elapsedSec = 2400, exitCode = 0, signal = 0, nodes = "node01", partition = "CPU", stateRaw } = {}) {
  seq += 1;
  const ended = !(state === "RUNNING" || state === "PENDING");
  const endAt = ended ? NOW - endAgo : null;
  return {
    id: String(seq), name, state, stateRaw: stateRaw || state, exitCode, signal,
    submitAt: (endAt ?? NOW) - elapsedSec * 1000 - MIN,
    startAt: state === "PENDING" ? null : (endAt ?? NOW) - elapsedSec * 1000,
    endAt, elapsedSec: state === "PENDING" ? 0 : elapsedSec, nodes: state === "PENDING" ? "None assigned" : nodes, partition,
  };
}
const hex = (i) => (0x35607b + i * 7919).toString(16).padStart(6, "0").slice(-6);
const snapshot = (jobs, extra = {}) => ({ state: "ok", checkedAt: NOW, user: "kai", reason: null, total: jobs.length, truncated: false, jobs, ...extra });

test("归类：完成 / 失败（含超时、内存不足、节点故障）/ 取消 / 进行中", () => {
  const outcome = (state, extra = {}) => jobOutcome({ state, endAt: NOW, exitCode: 0, ...extra });
  assert.equal(outcome("COMPLETED"), "completed");
  for (const state of ["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "BOOT_FAIL", "DEADLINE", "PREEMPTED"]) assert.equal(outcome(state), "failed", state);
  assert.equal(outcome("CANCELLED"), "cancelled");
  assert.equal(outcome("RUNNING", { endAt: null }), "running");
  assert.equal(outcome("PENDING", { endAt: null }), "pending");
  assert.equal(outcome("COMPLETING", { endAt: null }), "active", "没有结束时刻的其它状态算进行中");
  assert.equal(outcome("REVOKED", { exitCode: 1 }), "failed", "少见终态：退出码非零算失败");
  assert.equal(outcome("REVOKED"), "other");
  assert.equal(outcome("completed"), "completed", "大小写不敏感");
  assert.equal(jobOutcome(null), "active");
});

test("同名实验口径：与前端作业队列的 jobBaseName / JOB_GROUP_MIN 一致（两份实现对拍）", () => {
  assert.equal(JOB_GROUP_MIN, FRONT_GROUP_MIN);
  const names = [
    "cfa-agiter20-35607b-cfd1", "cfa-agiter20-025781-prepare1", "cfa-agiter19-a3f9c1-cfd1", "sweep_lr_12", "sweep_lr_3",
    "m1cap_v51dcv", "m1cap_v51dcv_post", "gen_meshrules_census", "train", "a-1", "x_deadbeef", "", "job-12345", "abcdef-123456-s2",
  ];
  for (const name of names) assert.equal(jobBaseName(name), frontBaseName(name), name);
  assert.equal(jobBaseName("cfa-agiter20-35607b-cfd1"), "cfa-agiter20");
  assert.equal(jobBaseName("sweep_lr_12"), "sweep_lr");
  assert.equal(jobStage("cfa-agiter20-35607b-cfd1", "cfa-agiter20"), "cfd1");
  assert.equal(jobStage("m1cap_v51dcv", "m1cap_v51dcv"), null);
});

test("没有可用快照：none / absent / error 原样带回，行与合计为空", () => {
  const none = buildJobsHistory(null, { serverId: "server-01" });
  assert.deepEqual(
    [none.schemaVersion, none.serverId, none.windowHours, none.state, none.checkedAt, none.total, none.rows.length, none.truncated],
    [1, "server-01", 48, "none", null, 0, 0, false],
  );
  assert.deepEqual(none.summary, { ended: 0, completed: 0, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 });
  const absent = buildJobsHistory({ state: "absent", checkedAt: NOW, user: "kai", reason: "集群没有 sacct（未启用作业记账）", total: 0, truncated: false, jobs: [] });
  assert.equal(absent.state, "absent");
  assert.match(absent.reason, /sacct/);
  assert.equal(absent.checkedAt, NOW);
  const error = buildJobsHistory({ state: "error", checkedAt: NOW, user: null, reason: "sacct 超时（slurmdbd 无响应）", total: 0, truncated: false, jobs: [] });
  assert.equal(error.state, "error");
  assert.deepEqual(error.rows, []);
});

// 实测量级（2026-10-03）：近 48 小时 1137 条 = 1091 完成 / 7 失败 / 20 取消 / 19 运行中。
test("实测量级：合计按完整作业表算；有问题的排最前（先失败后取消），同名实验折成组", () => {
  const jobs = [];
  for (let i = 0; i < 600; i += 1) jobs.push(job(`cfa-agiter20-${hex(i)}-${i % 30 === 0 ? "prepare1" : "cfd1"}`, "COMPLETED", { endAgo: MIN + i * 90_000, elapsedSec: 2280 + (i % 23) * 60, nodes: `node0${1 + (i % 7)}` }));
  for (let i = 0; i < 484; i += 1) jobs.push(job(`cfa-agiter19-${hex(1000 + i)}-cfd1`, "COMPLETED", { endAgo: 19 * HOUR + i * 170_000, elapsedSec: 2220 + (i % 26) * 60, nodes: `node0${1 + (i % 7)}` }));
  jobs.push(job("m1cap_v51dcv", "COMPLETED", { endAgo: 12.5 * HOUR, elapsedSec: 22320, nodes: "master", partition: "GPU" }));
  jobs.push(job("m1cap_v51dcv_post", "COMPLETED", { endAgo: 11.8 * HOUR, elapsedSec: 2268, nodes: "node03" }));
  for (let i = 0; i < 5; i += 1) jobs.push(job("gen_meshrules_census", "COMPLETED", { endAgo: (13 + i * 6) * HOUR, elapsedSec: 1800 + i * 60, nodes: "node06" }));
  for (let i = 0; i < 4; i += 1) jobs.push(job(`cfa-agiter19-${hex(5000 + i)}-cfd1`, "FAILED", { endAgo: (21 + i) * HOUR, elapsedSec: 1100, exitCode: i === 3 ? 137 : 1, nodes: "node05" }));
  jobs.push(job("train_lora", "OUT_OF_MEMORY", { endAgo: 3 * HOUR, elapsedSec: 640, exitCode: 0, signal: 9, nodes: "master", partition: "GPU" }));
  jobs.push(job("gen_meshrules_census", "TIMEOUT", { endAgo: 33 * HOUR, elapsedSec: 10800, nodes: "node06" }));
  jobs.push(job("m1cap_v50dcv", "FAILED", { endAgo: 30 * HOUR, elapsedSec: 720, exitCode: 2, nodes: "master", partition: "GPU" }));
  for (let i = 0; i < 20; i += 1) jobs.push(job(`cfa-agiter18-${hex(7000 + i)}-cfd1`, "CANCELLED", { endAgo: 40 * HOUR + i * 1000, elapsedSec: 300, stateRaw: "CANCELLED by 1001", nodes: `node0${1 + (i % 7)}` }));
  for (let i = 0; i < 19; i += 1) jobs.push(job(`cfa-agiter21-${hex(9000 + i)}-cfd1`, "RUNNING", { elapsedSec: 900 }));
  assert.equal(jobs.length, 1137);

  const out = buildJobsHistory(snapshot(jobs), { serverId: "server-01" });
  assert.deepEqual(out.summary, { ended: 1118, completed: 1091, failed: 7, cancelled: 20, other: 0, running: 19, pending: 0 });
  assert.deepEqual([out.total, out.kept, out.truncated, out.rowsOmitted, out.user], [1137, 1137, false, 0, "kai"]);

  // 行序：失败（组 + 单条，新 → 旧）→ 取消 → 完成。
  assert.deepEqual(out.rows.map((r) => `${r.kind}:${r.outcome}:${r.kind === "group" ? `${r.label}×${r.count}` : r.name}`), [
    "job:failed:train_lora",
    "group:failed:cfa-agiter19-*×4",
    "job:failed:m1cap_v50dcv",
    "job:failed:gen_meshrules_census",
    "group:cancelled:cfa-agiter18-*×20",
    "group:completed:cfa-agiter20-*×600",
    "job:completed:m1cap_v51dcv_post",
    "job:completed:m1cap_v51dcv",
    "group:completed:gen_meshrules_census×5",
    "group:completed:cfa-agiter19-*×484",
  ]);

  const failedGroup = out.rows[1];
  assert.equal(failedGroup.key, "FAILED|cfa-agiter19");
  assert.equal(failedGroup.children.length, 4, "有问题的组把作业带全");
  assert.equal(failedGroup.more, 0);
  assert.deepEqual(failedGroup.exits, [{ exitCode: 1, signal: 0, count: 3 }, { exitCode: 137, signal: 0, count: 1 }]);

  const cancelled = out.rows[4];
  assert.equal(cancelled.children.length, 20);
  assert.equal(cancelled.children[0].cancelledBy, "1001");

  const big = out.rows[5];
  assert.deepEqual(big.stages, [{ name: "cfd1", count: 580 }, { name: "prepare1", count: 20 }]);
  assert.equal(big.children.length, HISTORY_CHILDREN_MAX, "完成的组只带最近几条");
  assert.equal(big.more, 600 - HISTORY_CHILDREN_MAX);
  assert.equal(big.lastEndAt, NOW - MIN);
  assert.equal(big.firstEndAt, NOW - MIN - 599 * 90_000);
  assert.deepEqual([big.elapsedMinSec, big.elapsedMaxSec], [2280, 2280 + 22 * 60]);
  assert.deepEqual(big.partitions, ["CPU"]);
  assert.equal(big.nodeLists.length, 7);
  assert.ok(big.children.every((c, i, list) => i === 0 || list[i - 1].endAt >= c.endAt), "组内按结束时刻新 → 旧");

  const same = out.rows[8];
  assert.equal(same.label, "gen_meshrules_census", "名字完全相同的组不加 -* 后缀");
  assert.deepEqual(same.stages, []);

  const single = out.rows[0];
  assert.deepEqual(
    [single.state, single.exitCode, single.signal, single.elapsedSec, single.nodes, single.partition, single.endAt],
    ["OUT_OF_MEMORY", 0, 9, 640, "master", "GPU", NOW - 3 * HOUR],
  );

  // 聚合后的响应体远小于原始作业表（上千条不原样发给前端）。
  const sent = out.rows.reduce((n, r) => n + (r.kind === "group" ? r.children.length : 1), 0);
  assert.ok(sent <= 70, `实际带回 ${sent} 条作业`);
  assert.ok(JSON.stringify(out).length < 40_000);
});

test("有问题的组最多带回 HISTORY_PROBLEM_CHILDREN_MAX 条，其余计入 more", () => {
  const jobs = Array.from({ length: 80 }, (_, i) => job(`sweep_lr_${i}`, "FAILED", { endAgo: HOUR + i * MIN, exitCode: 1 }));
  const [group] = buildJobsHistory(snapshot(jobs)).rows;
  assert.equal(group.count, 80);
  assert.equal(group.children.length, HISTORY_PROBLEM_CHILDREN_MAX);
  assert.equal(group.more, 80 - HISTORY_PROBLEM_CHILDREN_MAX);
});

test("组内加载更多（v2.51）：与历史表组内同一次序，前缀一致；诊断只读挂上；快照标识绑定采集时刻", () => {
  const jobs = Array.from({ length: 80 }, (_, i) => job(`sweep_lr_${i}`, "FAILED", { endAgo: HOUR + (i % 7) * MIN, exitCode: 1 }));
  jobs.push(job("other", "COMPLETED"));
  const snap = snapshot(jobs);
  const diagnosisOf = (id) => (id === jobs[3].id ? { category: "oom", headline: "Killed" } : null);
  const history = buildJobsHistory(snap, { diagnosisOf });
  const group = history.rows.find((r) => r.kind === "group");
  assert.equal(history.snapshotId, `live-${NOW}`);
  assert.equal(liveSnapshotId(snap), `live-${NOW}`);
  const page = buildHistoryGroupPage(snap, group.key, { limit: 70, diagnosisOf });
  assert.deepEqual([page.total, page.children.length, page.more], [80, 70, 10]);
  assert.deepEqual(page.children.slice(0, group.children.length), group.children, "前 50 条与历史表组内完全一致");
  assert.deepEqual(page.children.find((c) => c.id === jobs[3].id).diagnosis, { category: "oom", headline: "Killed" });
  assert.equal(buildHistoryGroupPage(snap, group.key, { limit: 99999 }).children.length, 80);
  assert.ok(HISTORY_GROUP_PAGE_MAX >= 1000);
  assert.deepEqual(buildHistoryGroupPage(snap, "COMPLETED|nope").children, []);
  assert.equal(buildJobsHistory({ state: "error", checkedAt: NOW, jobs: [] }).snapshotId, null);
  assert.equal(buildJobsHistory(snap, { snapshotId: "qabc0001" }).snapshotId, "qabc0001");
});

test("没拿全：truncated 与远端总数原样带回；行数封顶时 rowsOmitted 记账", () => {
  const jobs = Array.from({ length: 10 }, (_, i) => job(`solo${String.fromCharCode(97 + i)}`, "COMPLETED", { endAgo: HOUR + i * MIN }));
  const cut = buildJobsHistory(snapshot(jobs, { total: 7000, truncated: true }));
  assert.deepEqual([cut.total, cut.kept, cut.truncated], [7000, 10, true]);
  const capped = buildJobsHistory(snapshot(jobs), { rowsMax: 4 });
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.rowsOmitted, 6);
  assert.equal(capped.summary.completed, 10, "合计不受行数封顶影响");
});

test("防御：畸形条目跳过；缺结束时刻的终态按开始 / 提交时刻排序", () => {
  const a = job("a", "COMPLETED", { endAgo: 2 * HOUR });
  const b = { ...job("b", "FAILED", { exitCode: 1 }), endAt: null, startAt: NOW - HOUR };
  const out = buildJobsHistory(snapshot([null, "x", { name: "no-id" }, a, b]));
  assert.equal(out.summary.ended, 2);
  assert.deepEqual(out.rows.map((r) => r.name), ["b", "a"]);
  assert.equal(out.rows[0].endAt, null);
});

test("Agent 会话归属：按工作目录前缀与时间窗口匹配发起作业的 Agent 会话，并通过 sessionOf 挂载", () => {
  const sessions = [
    { serverId: "server-01", agent: "claude", sid: "abcd1234efgh", cwd: "/home/kai/proj", firstSec: (NOW - 3 * HOUR) / 1000, lastSec: (NOW - HOUR) / 1000 },
  ];
  const matched = matchJobToSession({ workDir: "/home/kai/proj/runs", firstSeenAt: NOW - 2 * HOUR }, { submitAt: NOW - 2 * HOUR }, sessions);
  assert.deepEqual(matched, {
    key: "server-01|claude|abcd1234efgh",
    agent: "claude",
    sid: "abcd1234efgh",
    label: "Claude abcd1234",
  });
  assert.equal(matchJobToSession({ workDir: "/home/kai/other", firstSeenAt: NOW - 2 * HOUR }, {}, sessions), null);

  const j = job("train_a", "FAILED", { exitCode: 1 });
  const out = buildJobsHistory(snapshot([j]), { sessionOf: (id) => (id === j.id ? matched : null) });
  assert.deepEqual(out.rows[0].session, matched);
});
