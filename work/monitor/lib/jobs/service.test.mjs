import assert from "node:assert/strict";
import test from "node:test";

import { JOBS_REMOTE_SCRIPT } from "./scan.mjs";
import { createJobsService, isJobsEligible, JOBS_SCAN_INTERVAL_MS } from "./service.mjs";

const CONFIG = {
  servers: [
    { id: "server-01", host: "myserver", source: "team" },
    { id: "server-me", host: "mine", source: "personal" },
  ],
};
const NOW = 1791014400000;
const HEADER = "now=1791014400\ntz=+0800\nuser=kai\n";

function harness(reply) {
  const calls = [];
  const service = createJobsService({
    getConfig: async () => CONFIG,
    execCollector: async (invocation, server) => {
      calls.push({ invocation, server });
      if (reply instanceof Error) throw reply;
      return reply;
    },
    probeSshFailureReason: (code, stderr) => `ssh-reason ${code} ${String(stderr).trim()}`,
    now: () => NOW,
  });
  return { service, calls };
}

test("采集范围与用量一致；5 分钟一轮", () => {
  assert.equal(JOBS_SCAN_INTERVAL_MS, 300000);
  assert.equal(isJobsEligible(CONFIG.servers[0]), true);
  assert.equal(isJobsEligible(CONFIG.servers[1]), false);
  assert.equal(isJobsEligible({ id: "x", disabled: true }), false);
  assert.equal(isJobsEligible({ id: "x", monitorEnabled: false }), false);
});

test("ok：level ok，快照符合契约（时间为 epoch 毫秒，按提交倒序）", async () => {
  const { service, calls } = harness({
    code: 0,
    stderr: "",
    stdout: `${HEADER}state=ok\n`
      + "job=16446|lib_audit_d|COMPLETED|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T16:00:07|00:38:40|node06|CPU\n"
      + "job=16460|wss_q|FAILED|137:0|2026-10-01T16:30:39|2026-10-01T16:33:45|2026-10-02T13:12:21|20:38:36|master|GPU\n",
  });
  assert.equal(service.getSnapshot("server-01"), null, "从未扫描过 → null");
  const result = await service.runScan("server-01");
  assert.equal(result.level, "ok");
  assert.match(result.reason, /2 个/);
  // 第二条是 v2.49 对失败作业 16460 的取证（假 SSH 回的不是取证输出 → 记一次未取回，下轮再试）。
  assert.equal(calls.length, 2);
  assert.deepEqual(result.data.forensics, { requested: 1, diagnosed: 0, badLines: 6 });
  assert.equal(calls[0].invocation.input, JOBS_REMOTE_SCRIPT);
  assert.equal(calls[0].server.id, "server-01");

  const snap = service.getSnapshot("server-01");
  assert.deepEqual(Object.keys(snap).sort(), ["checkedAt", "jobs", "reason", "state", "total", "truncated", "user"]);
  assert.equal(snap.total, 2);
  assert.equal(snap.truncated, false);
  assert.equal(snap.state, "ok");
  assert.equal(snap.checkedAt, NOW);
  assert.equal(snap.user, "kai");
  assert.equal(snap.reason, null);
  assert.deepEqual(snap.jobs[0], {
    id: "16460",
    name: "wss_q",
    state: "FAILED",
    stateRaw: "FAILED",
    exitCode: 137,
    signal: 0,
    submitAt: Date.UTC(2026, 9, 1, 8, 30, 39),
    startAt: Date.UTC(2026, 9, 1, 8, 33, 45),
    endAt: Date.UTC(2026, 9, 2, 5, 12, 21),
    elapsedSec: 20 * 3600 + 38 * 60 + 36,
    nodes: "master",
    partition: "GPU",
  });
  assert.equal(snap.jobs[1].id, "16446");

  // 返回副本：调用方改动不回写内存快照。
  snap.jobs[0].state = "MUTATED";
  snap.jobs.length = 0;
  assert.equal(service.getSnapshot("server-01").jobs[0].state, "FAILED");
});

// 回归：实测近 48 小时 1137 条，旧实现只留 300 条且不声张。
test("没拿全：远端总行数多于收到的作业行 → 快照 truncated + total，探针原因写明", async () => {
  const { service } = harness({
    code: 0,
    stderr: "",
    stdout: `${HEADER}state=ok\nrows=7000\njob=1|a|COMPLETED|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T16:00:07|00:38:40|node06|CPU\n`,
  });
  const result = await service.runScan("server-01");
  assert.equal(result.level, "ok");
  assert.equal(result.reason, "作业已同步（近 2 天共 7000 个，只取到最新 1 个）");
  assert.deepEqual(result.data, { state: "ok", count: 1, total: 7000, truncated: true, badLines: 0 });
  const snap = service.getSnapshot("server-01");
  assert.equal(snap.truncated, true);
  assert.equal(snap.total, 7000);
});

test("没拿全：SSH 输出撞到本机接收上限（exec 标 truncated）同样算数", async () => {
  const { service } = harness({
    code: 0,
    stderr: "",
    truncated: true,
    stdout: `${HEADER}state=ok\nrows=1\njob=1|a|COMPLETED|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|2026-10-01T16:00:07|00:38:40|node06|CPU\n`,
  });
  await service.runScan("server-01");
  assert.equal(service.getSnapshot("server-01").truncated, true);
});

test("非 ok 快照：total 为 0、truncated 为 false（键齐全，调用方不用判空）", async () => {
  const { service } = harness({ code: 255, stderr: "Connection refused", stdout: "" });
  await service.runScan("server-01");
  const snap = service.getSnapshot("server-01");
  assert.equal(snap.total, 0);
  assert.equal(snap.truncated, false);
});

test("absent：level ok，快照 state=absent、带原因、作业为空", async () => {
  const { service } = harness({ code: 0, stderr: "", stdout: `${HEADER}state=absent\n` });
  const result = await service.runScan("server-01");
  assert.equal(result.level, "ok");
  const snap = service.getSnapshot("server-01");
  assert.equal(snap.state, "absent");
  assert.match(snap.reason, /sacct/);
  assert.deepEqual(snap.jobs, []);
});

test("SSH 失败（无 state 行）：level error，原因带 SSH 归因", async () => {
  const { service } = harness({ code: 255, stderr: "Connection refused", stdout: "" });
  const result = await service.runScan("server-01");
  assert.equal(result.level, "error");
  assert.equal(result.reason, "作业查询失败 (ssh-reason 255 Connection refused)");
  const snap = service.getSnapshot("server-01");
  assert.equal(snap.state, "error");
  assert.equal(snap.reason, result.reason);
  assert.equal(snap.user, null);
  assert.deepEqual(snap.jobs, []);
});

test("execCollector 抛错也归为 error 快照，不向调度器冒泡", async () => {
  const { service } = harness(new Error("spawn ssh ENOENT"));
  const result = await service.runScan("server-01");
  assert.equal(result.level, "error");
  assert.match(result.reason, /spawn ssh ENOENT/);
  assert.equal(service.getSnapshot("server-01").state, "error");
});

test("state=error：level error，中文原因（记账未启用）", async () => {
  const { service } = harness({
    code: 0,
    stderr: "",
    stdout: `${HEADER}state=error\nerror=sacct-failed\ndetail=sacct: error: Slurm accounting storage is disabled\n`,
  });
  const result = await service.runScan("server-01");
  assert.equal(result.level, "error");
  assert.equal(result.reason, "集群未启用作业记账，sacct 不可用");
  const snap = service.getSnapshot("server-01");
  assert.equal(snap.state, "error");
  assert.equal(snap.user, "kai");
  assert.equal(snap.reason, result.reason);
});

test("一轮失败覆盖上一轮成功（每轮即全量 48h 视图）；不在范围的服务器跳过且不发 SSH", async () => {
  let reply = { code: 0, stderr: "", stdout: `${HEADER}state=ok\njob=1|x|RUNNING|0:0|||Unknown|00:01:00|n|p\n` };
  const calls = [];
  const service = createJobsService({
    getConfig: async () => CONFIG,
    execCollector: async (invocation) => {
      calls.push(invocation);
      return reply;
    },
    probeSshFailureReason: () => "x",
  });
  await service.runScan("server-01");
  assert.equal(service.getSnapshot("server-01").jobs.length, 1);
  reply = { code: 255, stderr: "", stdout: "" };
  await service.runScan("server-01");
  assert.equal(service.getSnapshot("server-01").state, "error");
  assert.deepEqual(service.getSnapshot("server-01").jobs, []);

  const skipped = await service.runScan("server-me");
  assert.equal(skipped.level, "skipped");
  assert.equal(service.getSnapshot("server-me"), null);
  assert.equal((await service.runScan("ghost")).level, "skipped");
  assert.equal(calls.length, 2);
});
