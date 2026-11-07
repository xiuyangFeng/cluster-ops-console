import assert from "node:assert/strict";
import test from "node:test";

import { JOBS_MAX, jobsErrorReason, normalizeJobState, parseExitCode, parseJobLine, parseJobsOutput } from "./parse.mjs";

const HEADER = "now=1791014400\ntz=+0800\nuser=kai\n";
// 2026-10-01T15:21:27 +0800 = 2026-10-01T07:21:27Z
const T_1521 = Date.UTC(2026, 9, 1, 7, 21, 27);

test("ok：表头 + 作业行，远端本地时间按 tz 换算成 epoch 毫秒", () => {
  const out = parseJobsOutput(`${HEADER}state=ok\njob=16446|lib_audit_d|COMPLETED|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T16:00:07|00:38:40|node06|CPU\n`);
  assert.equal(out.state, "ok");
  assert.equal(out.user, "kai");
  assert.equal(out.tzOffsetMin, 480);
  assert.equal(out.remoteNow, 1791014400000);
  assert.deepEqual(out.jobs, [{
    id: "16446",
    name: "lib_audit_d",
    state: "COMPLETED",
    stateRaw: "COMPLETED",
    exitCode: 0,
    signal: 0,
    submitAt: T_1521,
    startAt: T_1521,
    endAt: Date.UTC(2026, 9, 1, 8, 0, 7),
    elapsedSec: 38 * 60 + 40,
    nodes: "node06",
    partition: "CPU",
  }]);
  assert.equal(out.badLines, 0);
});

test("负时区偏移与缺 tz：-0530 正确换算；没有 tz 行时间一律 null", () => {
  const line = "job=1|a|RUNNING|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|Unknown|00:01:00|node01|GPU";
  const neg = parseJobsOutput(`tz=-0530\nstate=ok\n${line}\n`);
  assert.equal(neg.jobs[0].submitAt, Date.UTC(2026, 9, 1, 20, 51, 27));
  const none = parseJobsOutput(`state=ok\n${line}\n`);
  assert.equal(none.jobs[0].submitAt, null);
  assert.equal(none.jobs[0].elapsedSec, 60, "时长不依赖 tz");
});

test("排队作业：Unknown / None assigned / 空 → null", () => {
  const job = parseJobLine("16500|train|PENDING|0:0|2026-10-02T10:00:00|Unknown|Unknown|00:00:00|None assigned|", 480);
  assert.equal(job.startAt, null);
  assert.equal(job.endAt, null);
  assert.equal(job.nodes, null);
  assert.equal(job.partition, null);
  assert.equal(job.elapsedSec, 0);
  const noneTimes = parseJobLine("16501||PENDING|0:0|None|None||00:00:00|None|GPU", 480);
  assert.equal(noneTimes.name, null);
  assert.equal(noneTimes.submitAt, null);
});

test("状态归一：CANCELLED by 1234 → CANCELLED、CANCELLED+ 去尾、小写转大写，原文保留", () => {
  const job = parseJobLine("7|x|CANCELLED by 1234|0:15|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T15:22:27|00:01:00|node01|CPU", 480);
  assert.equal(job.state, "CANCELLED");
  assert.equal(job.stateRaw, "CANCELLED by 1234");
  assert.equal(job.signal, 15);
  assert.equal(normalizeJobState("CANCELLED+"), "CANCELLED");
  assert.equal(normalizeJobState("out_of_memory"), "OUT_OF_MEMORY");
  assert.equal(normalizeJobState("???"), null);
  assert.equal(normalizeJobState(""), null);
});

test("退出码拆分：137:0 → 137 / 0；非法 → null", () => {
  assert.deepEqual(parseExitCode("137:0"), { exitCode: 137, signal: 0 });
  assert.deepEqual(parseExitCode("0:9"), { exitCode: 0, signal: 9 });
  assert.deepEqual(parseExitCode(""), { exitCode: null, signal: null });
  assert.deepEqual(parseExitCode("x:1"), { exitCode: null, signal: null });
});

test("时长：带天数 D-HH:MM:SS 与 HH:MM:SS", () => {
  const job = parseJobLine("8|x|RUNNING|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|Unknown|2-03:04:05|node01|CPU", 480);
  assert.equal(job.elapsedSec, 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseJobLine("9|x|RUNNING|0:0||||20:38:36||", 480).elapsedSec, 20 * 3600 + 38 * 60 + 36);
});

test("作业号：数组 / 排队数组 / 异构分量合法；其它整行丢弃", () => {
  const row = (id) => `${id}|x|COMPLETED|0:0|||||node01|CPU`;
  for (const id of ["48213", "48213_7", "48213_[1-10%2]", "48213+1"]) assert.equal(parseJobLine(row(id), 0)?.id, id);
  for (const id of ["", "abc", "48213.batch", "1".repeat(70), "48213;rm"]) assert.equal(parseJobLine(row(id), 0), null, id);
});

test("名字含 | 时拼回；超长名字截到 120 字", () => {
  const job = parseJobLine("10|a|b|c|FAILED|1:0|||||node01|CPU", 0);
  assert.equal(job.name, "a|b|c");
  assert.equal(job.state, "FAILED");
  assert.equal(job.exitCode, 1);
  assert.equal(parseJobLine(`11|${"n".repeat(500)}|FAILED|1:0|||||node01|CPU`, 0).name.length, 120);
});

test("畸形行计入 badLines 不影响其它行；stderr 告警行（无 job= 前缀）直接忽略", () => {
  const out = parseJobsOutput([
    HEADER,
    "state=ok",
    "sacct: warning: something",
    "job=sacct: error: half line",
    "job=12|x|COMPLETED|0:0",
    "job=13|x|??? STATE|0:0|||||n|p",
    "job=14|ok|COMPLETED|0:0|||||node01|CPU",
    "",
  ].join("\n"));
  assert.deepEqual(out.jobs.map((j) => j.id), ["14"]);
  assert.equal(out.badLines, 3);
});

test("排序与封顶：按提交时刻倒序，只留最新 JOBS_MAX 条，并标出被截断", () => {
  const pad = (n) => String(n).padStart(2, "0");
  const rows = [];
  for (let i = 0; i < JOBS_MAX + 50; i += 1) {
    rows.push(`job=${1000 + i}|j|COMPLETED|0:0|2026-10-01T${pad(10 + Math.floor(i / 3600))}:${pad(Math.floor(i / 60) % 60)}:${pad(i % 60)}|||00:00:01|n|p`);
  }
  const out = parseJobsOutput(`${HEADER}state=ok\n${rows.join("\n")}\n`);
  assert.equal(JOBS_MAX, 6000);
  assert.equal(out.jobs.length, JOBS_MAX);
  assert.equal(out.jobs[0].id, String(1000 + JOBS_MAX + 49));
  assert.equal(out.jobs.at(-1).id, "1050");
  assert.equal(out.truncated, true, "本机按 JOBS_MAX 截了一刀也算没拿全");
});

test("rows=：远端总行数；收到的作业行比它少 → truncated；没有 rows 行（旧脚本）不误报", () => {
  const job = (id) => `job=${id}|j|COMPLETED|0:0|2026-10-01T10:00:00|||00:00:01|n|p`;
  const full = parseJobsOutput(`${HEADER}state=ok\nrows=2\n${job(1)}\n${job(2)}\n`);
  assert.equal(full.rowsTotal, 2);
  assert.equal(full.truncated, false);

  // 实测形态：sacct 输出 1137 行，远端只回传了最新的一部分。
  const cut = parseJobsOutput(`${HEADER}state=ok\nrows=1137\n${job(1)}\n${job(2)}\n`);
  assert.equal(cut.rowsTotal, 1137);
  assert.equal(cut.jobs.length, 2);
  assert.equal(cut.truncated, true);

  const legacy = parseJobsOutput(`${HEADER}state=ok\n${job(1)}\n`);
  assert.equal(legacy.rowsTotal, null);
  assert.equal(legacy.truncated, false);

  // 先到先得、非法取值忽略：作业原文伪造不了总数。
  const spoof = parseJobsOutput(`${HEADER}state=ok\nrows=abc\nrows=3\nrows=999\n${job(1)}\n${job(2)}\n${job(3)}\n`);
  assert.equal(spoof.rowsTotal, 3);
  assert.equal(spoof.truncated, false);

  // 畸形行占了名额但没解析出来：不算截断（由 badLines 记账）。
  const bad = parseJobsOutput(`${HEADER}state=ok\nrows=2\n${job(1)}\njob=garbage\n`);
  assert.equal(bad.jobs.length, 1);
  assert.equal(bad.badLines, 1);
  assert.equal(bad.truncated, false);
});

test("absent / error / 无 state 行：不解析作业行", () => {
  const absent = parseJobsOutput(`${HEADER}state=absent\n`);
  assert.equal(absent.state, "absent");
  assert.deepEqual(absent.jobs, []);

  const err = parseJobsOutput(`${HEADER}state=error\nerror=sacct-failed\ndetail=sacct: error: Slurm accounting storage is disabled\njob=1|x|COMPLETED|0:0|||||n|p\n`);
  assert.equal(err.state, "error");
  assert.equal(err.error, "sacct-failed");
  assert.deepEqual(err.jobs, []);
  assert.equal(jobsErrorReason(err), "集群未启用作业记账，sacct 不可用");
  assert.equal(jobsErrorReason({ error: "sacct-timeout" }), "sacct 超时（slurmdbd 无响应）");
  assert.equal(jobsErrorReason({ error: "sacct-failed", detail: "sacct: error: Problem talking to the database" }), "sacct 执行失败：sacct: error: Problem talking to the database");
  assert.equal(jobsErrorReason({ error: "sacct-failed" }), "sacct 执行失败");

  const none = parseJobsOutput("ssh: connect to host x port 22: Connection refused\n");
  assert.equal(none.state, null);
  assert.equal(parseJobsOutput("").state, null);
  assert.equal(parseJobsOutput(null).state, null);
});

test("state 先到先得、非法取值忽略", () => {
  assert.equal(parseJobsOutput("state=weird\nstate=absent\nstate=ok\n").state, "absent");
});
