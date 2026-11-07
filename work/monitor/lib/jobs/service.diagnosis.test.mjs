// v2.49 失败作业诊断在 jobs 服务里的触发与读接口：取证只一次、每轮上限与数组代表、重试、
// 模块关闭、登记模板随请求送出、作业消失后的提前复核。
import assert from "node:assert/strict";
import test from "node:test";

import { FORENSICS_REMOTE_COMMAND } from "./forensics.mjs";
import { createJobsService } from "./service.mjs";

const CONFIG = {
  servers: [
    { id: "server-01", host: "myserver", source: "team" },
    { id: "server-me", host: "mine", source: "personal" },
  ],
};
const NOW = 1791014400000;
const HEADER = "now=1791014400\ntz=+0800\nuser=kai\n";

const jobLine = (id, state, exit = "1:0", end = "2026-10-01T16:00:07") => `job=${id}|train|${state}|${exit}|2026-10-01T15:21:27|2026-10-01T15:21:27|${end}|00:38:40|node03|CPU`;
const sacctReply = (lines) => ({ code: 0, stderr: "", stdout: `${HEADER}state=ok\n${lines.join("\n")}\n` });
const forensicsJob = (id) => JSON.stringify({
  k: "job", id, src: "registry", tool: "sbatch", live: true,
  files: [{ p: `/w/o_${id}.log`, r: "stdout", sz: 10, t: "Traceback (most recent call last):\n  File \"t.py\"\nKeyError: 'arm'\n" }],
  sc: "#!/bin/bash\necho hi\n", scs: "scontrol",
});

function harness({ sacct, forensics = (ids) => ids.map(forensicsJob), config = CONFIG } = {}) {
  const calls = { sacct: 0, forensics: [] };
  const service = createJobsService({
    getConfig: async () => config,
    execCollector: async (invocation) => {
      if (invocation.args.at(-1) === FORENSICS_REMOTE_COMMAND) {
        const payload = JSON.parse(invocation.input.split("\n")[1]);
        const ids = payload.jobs.map((j) => j.id);
        calls.forensics.push(payload.jobs);
        const out = forensics(ids);
        if (out instanceof Error) throw out;
        return { code: 0, stderr: "", stdout: `${out.join("\n")}\n${JSON.stringify({ k: "end", n: out.length, complete: true })}\n` };
      }
      calls.sacct += 1;
      return sacctReply(typeof sacct === "function" ? sacct() : sacct);
    },
    probeSshFailureReason: () => "x",
    now: () => NOW,
  });
  return { service, calls };
}

test("新失败（FAILED / TIMEOUT / OOM / NODE_FAIL）同一轮取证一次并入库；诊断过的不再取证", async () => {
  const { service, calls } = harness({ sacct: [jobLine("101", "FAILED"), jobLine("102", "TIMEOUT"), jobLine("103", "COMPLETED", "0:0"), jobLine("104", "CANCELLED", "0:0"), jobLine("105", "PREEMPTED")] });
  const first = await service.runScan("server-01");
  assert.deepEqual(first.data.forensics, { requested: 2, diagnosed: 2, badLines: 0 });
  assert.deepEqual(calls.forensics[0].map((j) => j.id).sort(), ["101", "102"]);
  assert.deepEqual(service.diagnosisOf("server-01", "101"), { category: "python", headline: "KeyError: 'arm'" });
  assert.equal(service.diagnosisOf("server-01", "102").category, "timeout", "sacct 状态优先于日志");
  assert.equal(service.diagnosisOf("server-02", "101"), null);

  const second = await service.runScan("server-01");
  assert.equal(second.data.forensics, undefined, "没有新失败 → 不发取证 SSH");
  assert.deepEqual([calls.forensics.length, calls.sacct], [1, 2]);

  const list = await service.listDiagnoses("server-01");
  assert.deepEqual(Object.keys(list.items[0]).sort(), ["category", "endedAtMs", "evidence", "exitCode", "files", "hasScript", "headline", "jobId", "name", "serverId", "source", "state"]);
  const item = list.items.find((i) => i.jobId === "101");
  assert.deepEqual([item.hasScript, item.source, item.files[0].path, item.state, item.exitCode, item.name], [true, "registry", "/w/o_101.log", "FAILED", 1, "train"]);
  assert.deepEqual([item.files[0].role, item.files[0].size], ["stdout", 10], "v2.51：记下文件角色与取证时的大小（按段向前读取据此衔接）");
  assert.equal(item.endedAtMs, Date.UTC(2026, 9, 1, 8, 0, 7));
  assert.ok(item.evidence.includes("KeyError: 'arm'"));
  assert.deepEqual(list.groups.map((g) => [g.category, g.count]).sort(), [["python", 1], ["timeout", 1]]);
  assert.equal(await service.getDiagnosisScript("server-01", "101"), "#!/bin/bash\necho hi\n");
  assert.equal(await service.getDiagnosisScript("server-01", "999"), null);
  assert.deepEqual(await service.listDiagnoses("server-02"), { items: [], groups: [] });
});

test("每轮最多 20 个、新失败优先；超过时每个数组作业先取 1 个代表，其余下一轮补", async () => {
  const lines = [];
  for (let i = 0; i < 30; i += 1) lines.push(jobLine(`500_${i}`, "FAILED", "1:0", `2026-10-01T16:${String(10 + i).padStart(2, "0")}:00`));
  for (let i = 0; i < 5; i += 1) lines.push(jobLine(String(600 + i), "FAILED"));
  lines.push(jobLine("700_1", "FAILED"));
  const { service, calls } = harness({ sacct: lines });
  await service.runScan("server-01");
  const ids = calls.forensics[0].map((j) => j.id);
  assert.equal(ids.length, 20);
  assert.equal(ids[0], "500_29", "最新结束的在前");
  assert.ok(["600", "601", "602", "603", "604", "700_1"].every((id) => ids.includes(id)), "每个数组 / 单个作业先各占一个名额");
  assert.equal(ids.filter((id) => id.startsWith("500_")).length, 14);
  await service.runScan("server-01");
  assert.equal(calls.forensics[1].length, 16);
});

test("没取回来的作业下一轮重试、最多 3 轮；远端少回的同样计次", async () => {
  const { service, calls } = harness({ sacct: [jobLine("101", "FAILED"), jobLine("102", "FAILED")], forensics: () => new Error("ssh down") });
  for (let i = 0; i < 4; i += 1) await service.runScan("server-01");
  assert.equal(calls.forensics.length, 3, "3 轮后放弃");
  const partial = harness({ sacct: [jobLine("101", "FAILED"), jobLine("102", "FAILED")], forensics: (ids) => ids.slice(0, 1).map(forensicsJob) });
  await partial.service.runScan("server-01");
  await partial.service.runScan("server-01");
  assert.deepEqual(partial.calls.forensics.map((batch) => batch.map((j) => j.id)), [["102", "101"], ["101"]]);
});

test("jobs 模块关闭 → 不取证、不登记、不催", async () => {
  const { service, calls } = harness({ sacct: [jobLine("101", "FAILED")], config: { ...CONFIG, modules: { jobs: false } } });
  await service.runScan("server-01");
  assert.equal(calls.forensics.length, 0);
  let early = 0;
  service.bindEarlyScan(() => {
    early += 1;
  });
  const obs = await service.observeSlurmSection("server-01", "jobreg_total=1\njobreg=1|1|N/A|a|/w|/o|/e|/c");
  assert.deepEqual([obs.observed, early], [false, 0]);
});

test("登记表里的路径模板随取证请求送出（数组任务退到整体登记）", async () => {
  const { service, calls } = harness({ sacct: [jobLine("18006_4", "FAILED")] });
  await service.observeSlurmSection("server-01", "user=kai\njobreg_total=1\njobreg=18006_[1-9]|18006|1-9|vp|/w|/w/train_%A_%a.log|(null)|/w/run.sh");
  await service.runScan("server-01");
  assert.deepEqual(calls.forensics[0][0], { id: "18006_4", reg: { workDir: "/w", stdout: "/w/train_%A_%a.log", stderr: null, command: "/w/run.sh", name: "vp", user: "kai" } });
});

test("提前复核：作业从队列消失 → 催 jobs 探针；50s 冷却；sacct 看到结束后不再催；最多催 3 次", async () => {
  let clock = NOW;
  let sacct = [jobLine("1", "RUNNING", "0:0", "Unknown")];
  const service = createJobsService({
    getConfig: async () => CONFIG,
    execCollector: async () => sacctReply(sacct),
    probeSshFailureReason: () => "x",
    now: () => clock,
  });
  const early = [];
  service.bindEarlyScan((id) => early.push(id));
  const reg = (ids) => `user=kai\njobreg_total=${ids.length}\n${ids.map((id) => `jobreg=${id}|${id}|N/A|a|/w|/o|/e|/c`).join("\n")}`;
  await service.observeSlurmSection("server-01", reg(["1", "2"]));
  assert.deepEqual(early, [], "第一轮只建基线");
  const obs = await service.observeSlurmSection("server-01", reg(["2"]));
  assert.deepEqual([obs.disappeared, obs.early, early], [["1"], true, ["server-01"]]);
  clock += 10_000;
  assert.equal((await service.observeSlurmSection("server-01", reg(["2"]))).early, false, "冷却中");
  // sacct 还没看到它结束（仍 RUNNING）→ 下一轮 slow 再催；看到结束之后不再催。
  await service.runScan("server-01");
  clock += 60_000;
  assert.equal((await service.observeSlurmSection("server-01", reg(["2"]))).early, true);
  sacct = [jobLine("1", "FAILED")];
  await service.runScan("server-01");
  clock += 60_000;
  assert.equal((await service.observeSlurmSection("server-01", reg(["2"]))).early, false);
  // 一直没在 sacct 里结束的，最多催 3 次。
  sacct = [];
  await service.observeSlurmSection("server-01", reg([]));
  for (let i = 0; i < 5; i += 1) {
    clock += 60_000;
    await service.observeSlurmSection("server-01", reg([]));
  }
  assert.equal(early.length, 2 + 3);
  assert.equal((await service.observeSlurmSection("server-me", reg(["9"]))).observed, false, "不在采集范围的服务器不登记");
  assert.equal((await service.observeSlurmSection("server-01", "state=ok")).observed, false, "没有 jobreg_total → 本轮不算观察");
});
