import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { COLLECTOR_SCRIPT_PATH, parseCollectorOutput } from "./collector.mjs";
import {
  cpuBusyFromFrames,
  parseJobGpus,
  parseNodeState,
  parseSlurmDuration,
  parseSlurmSection,
  parseSlurmTimestamp,
  parseTzOffset,
  SLURM_MAX_DIRECT_NODES,
  SLURM_MAX_JOBS,
} from "./slurm.mjs";

// 2026-09-30 在集群（Slurm 23.11.8）上真跑 collect.sh slow 拿到的 slurm 段原文。
const REAL_SECTION = [
  "state=ok",
  "version=23.11.8",
  "now=1790743943",
  "tz=+0800",
  "user=kai",
  "jobs_total=3",
  "count=RUNNING=3",
  "node=master|idle|0/192/0/192|2.44|93419|380000|0|gpu:4090:4|gpu:4090:0(IDX:N/A)|GPU|none",
  "node=node01|idle|0/192/0/192|26.22|365026|350000|0|(null)|gpu:0|CPU*|none",
  "node=node02|mixed|56/136/0/192|24.94|351380|350000|0|(null)|gpu:0|CPU*|none",
  "node=node03|mixed|56/136/0/192|32.18|322223|350000|0|(null)|gpu:0|CPU*|none",
  "node=node05|idle|0/192/0/192|0.00|366255|350000|0|(null)|gpu:0|CPU*|none",
  "node=node06|idle|0/192/0/192|1.92|256752|350000|0|(null)|gpu:0|CPU*|none",
  "node=node07|mixed|92/100/0/192|93.07|310887|350000|0|(null)|gpu:0|CPU*|none",
  "job=16326|kai|CPU|RUNNING|50:05|UNLIMITED|1|92|cpu=92,node=1,billing=92|N/A|0|2026-09-30T11:53:47|2026-09-30T12:02:18|None|node07|cfa-labelfix-bd1d7c-cfd1",
  "job=15527|Liaaaaa|CPU|RUNNING|20:12:22|UNLIMITED|1|56|cpu=56,node=1,billing=56|N/A|0|2026-09-29T16:15:53|2026-09-29T16:40:01|None|node02|pysr_joint_potential",
  "job=15550|Liaaaaa|CPU|RUNNING|20:12:22|UNLIMITED|1|56|cpu=56,node=1,billing=56|N/A|0|2026-09-29T16:15:53|2026-09-29T16:40:01|None|node03|pysr_joint_potential",
].join("\n");

test("真实集群输出：节点、作业、默认分区、计数", () => {
  const snap = parseSlurmSection(REAL_SECTION, { checkedAt: 123 });
  assert.equal(snap.schemaVersion, 1);
  assert.equal(snap.state, "ok");
  assert.equal(snap.reason, null);
  assert.equal(snap.version, "23.11.8");
  assert.equal(snap.user, "kai");
  assert.equal(snap.checkedAt, 123);
  assert.equal(snap.remoteNow, 1790743943000);
  assert.equal(snap.defaultPartition, "CPU");
  assert.equal(snap.nodes.length, 7);
  assert.deepEqual(snap.counts, { running: 3, pending: 0, other: 0 });
  assert.equal(snap.jobsTotal, 3);
  assert.equal(snap.jobsTruncated, false);

  const master = snap.nodes[0];
  assert.deepEqual(master, {
    name: "master",
    source: "slurm",
    reachable: true,
    failure: null,
    state: "idle",
    stateRaw: "idle",
    flags: [],
    partitions: ["GPU"],
    cpus: { alloc: 0, idle: 192, other: 0, total: 192 },
    load: 2.44,
    memTotalMb: 380000,
    memFreeMb: 93419,
    memAllocMb: 0,
    busyPct: null,
    gpus: { total: 4, used: 0, model: "4090" },
    uptimeSec: null,
    reason: null,
  });
  const node07 = snap.nodes.find((n) => n.name === "node07");
  assert.equal(node07.state, "mixed");
  assert.deepEqual(node07.cpus, { alloc: 92, idle: 100, other: 0, total: 192 });
  assert.equal(node07.gpus, null, "gpu:0 的 GresUsed 与 (null) Gres → 无 GPU");
  assert.deepEqual(node07.partitions, ["CPU"], "分区名去掉默认标记 *");

  const job = snap.jobs[0];
  assert.deepEqual(job, {
    id: "16326",
    user: "kai",
    partition: "CPU",
    state: "RUNNING",
    elapsedSec: 50 * 60 + 5,
    timeLimitSec: null,
    nodes: 1,
    cpus: 92,
    gpus: 0,
    memory: null,
    // 2026-09-30T11:53:47+08:00
    submitAt: Date.UTC(2026, 8, 30, 3, 53, 47),
    startAt: Date.UTC(2026, 8, 30, 4, 2, 18),
    waitSec: null,
    reason: null,
    nodeList: "node07",
    name: "cfa-labelfix-bd1d7c-cfd1",
  });
  assert.equal(snap.jobs[1].elapsedSec, 20 * 3600 + 12 * 60 + 22);
});

test("-o 回退格式：AllocMem / GresUsed / tres-alloc 为空也能解析", () => {
  const text = [
    "state=ok",
    "tz=+0800",
    "now=1790743943",
    "node=master|idle|0/192/0/192|2.44|93419|380000||gpu:4090:4||GPU|none",
    "job=16343|kai|CPU|RUNNING|0:06|1:00:00|1|4||N/A|0|2026-09-30T12:50:45|2026-09-30T12:50:45|None|node06|cfdauto_smoke",
    "job=16341|kai|CPU|RUNNING|2:52|8:00:00|1|4||N/A|48G|2026-09-30T12:47:59|2026-09-30T12:47:59|None|node06|cfa-labelfix-92660a-prepare2",
  ].join("\n");
  const snap = parseSlurmSection(text);
  assert.equal(snap.nodes[0].memAllocMb, null);
  assert.deepEqual(snap.nodes[0].gpus, { total: 4, used: null, model: "4090" }, "无 GresUsed → used 未知");
  assert.equal(snap.jobs[0].elapsedSec, 6);
  assert.equal(snap.jobs[0].timeLimitSec, 3600);
  assert.equal(snap.jobs[0].gpus, 0);
  assert.equal(snap.jobs[1].memory, "48G");
  assert.equal(snap.jobs[1].timeLimitSec, 8 * 3600);
  // 缺 count= / jobs_total= 行时按数组统计。
  assert.deepEqual(snap.counts, { running: 2, pending: 0, other: 0 });
  assert.equal(snap.jobsTotal, 2);
});

test("多分区节点合并为一条；默认分区取带 * 的那个", () => {
  const text = [
    "node=gpu01|mixed|8/56/0/64|7.5|1000|2000|500|gpu:a100:8(S:0-1)|gpu:a100:3(IDX:0-2)|gpu|none",
    "node=gpu01|mixed|8/56/0/64|7.5|1000|2000|500|gpu:a100:8(S:0-1)|gpu:a100:3(IDX:0-2)|long*|none",
    "node=cpu01|allocated|64/0/0/64|64.0|10|2000|2000|(null)|gpu:0|long*|none",
  ].join("\n");
  const snap = parseSlurmSection(text);
  assert.equal(snap.state, "ok", "state 行缺失但有数据 → ok");
  assert.equal(snap.nodes.length, 2);
  assert.deepEqual(snap.nodes.map((n) => n.name), ["cpu01", "gpu01"], "按名字自然序");
  const gpu01 = snap.nodes.find((n) => n.name === "gpu01");
  assert.deepEqual(gpu01.partitions, ["gpu", "long"]);
  assert.deepEqual(gpu01.gpus, { total: 8, used: 3, model: "a100" });
  assert.equal(snap.defaultPartition, "long");
});

test("节点状态：后缀符号与 +复合标志", () => {
  assert.deepEqual(parseNodeState("idle"), { state: "idle", flags: [] });
  assert.deepEqual(parseNodeState("down*"), { state: "down", flags: ["not_responding"] });
  assert.deepEqual(parseNodeState("mixed+drain"), { state: "mixed", flags: ["drain"] });
  assert.deepEqual(parseNodeState("idle~"), { state: "idle", flags: ["powered_off"] });
  assert.deepEqual(parseNodeState("drained*"), { state: "drained", flags: ["not_responding"] });
  assert.deepEqual(parseNodeState("allocated+drain*"), { state: "allocated", flags: ["not_responding", "drain"] });
  assert.deepEqual(parseNodeState("MIXED-"), { state: "mixed", flags: ["planned"] });
  assert.deepEqual(parseNodeState(""), { state: "unknown", flags: [] });
  assert.deepEqual(parseNodeState("???"), { state: "unknown", flags: [] });

  const snap = parseSlurmSection("node=n1|down*|0/0/64/64|N/A|N/A|2000|0|(null)|gpu:0|CPU*|Not responding|since 3pm");
  const node = snap.nodes[0];
  assert.equal(node.state, "down");
  assert.equal(node.stateRaw, "down*");
  assert.equal(node.load, null);
  assert.equal(node.memFreeMb, null);
  assert.equal(node.reason, "Not responding|since 3pm", "Reason 里的 | 拼回");
});

test("GPU：作业 tres-alloc 优先，其次 tres-per-node × 节点数", () => {
  assert.equal(parseJobGpus("cpu=8,mem=64G,node=1,billing=8,gres/gpu=2", "gres/gpu:2", 1), 2);
  // 有无型号项并存：取无型号总数，不重复相加。
  assert.equal(parseJobGpus("cpu=8,gres/gpu=2,gres/gpu:4090=2", "N/A", 1), 2);
  assert.equal(parseJobGpus("cpu=8,gres/gpu:4090=1,gres/gpu:a100=2", "N/A", 1), 3);
  assert.equal(parseJobGpus("", "gres/gpu:4090:2", 2), 4);
  assert.equal(parseJobGpus("", "gres:gpu:1", 3), 3);
  assert.equal(parseJobGpus("", "gpu:1", null), 1);
  assert.equal(parseJobGpus("cpu=4,node=1", "N/A", 1), 0);
  assert.equal(parseJobGpus("", "gres/gpu:weird", 1), null, "请求了 GPU 但数量解析不了 → null");
});

test("时长：Slurm 各种写法与不限时", () => {
  assert.equal(parseSlurmDuration("0:00"), 0);
  assert.equal(parseSlurmDuration("0:06"), 6);
  assert.equal(parseSlurmDuration("44:04"), 44 * 60 + 4);
  assert.equal(parseSlurmDuration("20:06:21"), 20 * 3600 + 6 * 60 + 21);
  assert.equal(parseSlurmDuration("1-02:03:04"), 86400 + 2 * 3600 + 3 * 60 + 4);
  assert.equal(parseSlurmDuration("2-12"), 2 * 86400 + 12 * 3600);
  assert.equal(parseSlurmDuration("1-00:30"), 86400 + 30 * 60);
  assert.equal(parseSlurmDuration("90"), 90 * 60, "纯数字按分钟");
  for (const v of ["UNLIMITED", "INVALID", "NOT_SET", "N/A", "Partition_Limit", "", null, undefined]) {
    assert.equal(parseSlurmDuration(v), null, String(v));
  }
});

test("时区与时间戳：远端本地时间按 tz 换算，缺 tz 不猜", () => {
  assert.equal(parseTzOffset("+0800"), 480);
  assert.equal(parseTzOffset("-0530"), -330);
  assert.equal(parseTzOffset("+2500"), null);
  assert.equal(parseTzOffset("CST"), null);
  assert.equal(parseSlurmTimestamp("2026-09-30T11:53:47", 480), Date.UTC(2026, 8, 30, 3, 53, 47));
  assert.equal(parseSlurmTimestamp("2026-09-30T11:53:47", -330), Date.UTC(2026, 8, 30, 17, 23, 47));
  assert.equal(parseSlurmTimestamp("2026-09-30T11:53:47", null), null);
  for (const v of ["N/A", "Unknown", "None", ""]) assert.equal(parseSlurmTimestamp(v, 480), null);
});

test("排队作业：等待时长用远端 now 减提交时刻；reason / nodeList 占位符归 null", () => {
  const text = [
    "state=ok",
    "now=1790743943", // 2026-09-30T12:52:23+08:00
    "tz=+0800",
    "job=16400|alice|GPU|PENDING|0:00|2-00:00:00|1|16||gres/gpu:2|64G|2026-09-30T12:22:23|N/A|Resources||train|v2|final",
    "job=16401_[1-10]|bob|CPU|PENDING|0:00|30:00|1|1|||0|2026-09-30T13:00:00|2026-09-30T14:00:00|Priority|(null)|sweep",
  ].join("\n");
  const snap = parseSlurmSection(text);
  const [a, b] = snap.jobs;
  assert.equal(a.state, "PENDING");
  assert.equal(a.waitSec, 30 * 60);
  assert.equal(a.startAt, null);
  assert.equal(a.reason, "Resources");
  assert.equal(a.nodeList, null);
  assert.equal(a.gpus, 2);
  assert.equal(a.timeLimitSec, 2 * 86400);
  assert.equal(a.name, "train|v2|final", "Name 里的 | 拼回");
  assert.equal(b.id, "16401_[1-10]");
  assert.equal(b.waitSec, 0, "提交时刻晚于远端 now（时钟抖动）钳到 0");
  assert.equal(b.nodeList, null);
  assert.equal(b.reason, "Priority");
  assert.deepEqual(snap.counts, { running: 0, pending: 2, other: 0 });
});

test("计数：count= 行（截断前全量）优先于数组统计；截断标记", () => {
  const jobs = [];
  for (let i = 0; i < SLURM_MAX_JOBS + 5; i += 1) {
    jobs.push(`job=${1000 + i}|u|CPU|PENDING|0:00|1:00|1|1|||0|N/A|N/A|Priority||j${i}`);
  }
  const text = ["state=ok", "jobs_total=412", "count=RUNNING=100", "count=PENDING=300", "count=COMPLETING=10", "count=SUSPENDED=2", ...jobs].join("\n");
  const snap = parseSlurmSection(text);
  assert.equal(snap.jobs.length, SLURM_MAX_JOBS);
  assert.equal(snap.jobsTotal, 412);
  assert.equal(snap.jobsTruncated, true);
  assert.deepEqual(snap.counts, { running: 100, pending: 300, other: 12 });
});

test("absent / error / 空输入：形状完整", () => {
  for (const input of [undefined, null, "", "   \n"]) {
    const snap = parseSlurmSection(input, { checkedAt: 5 });
    assert.equal(snap.state, "absent");
    assert.equal(snap.checkedAt, 5);
    assert.deepEqual(snap.nodes, []);
    assert.deepEqual(snap.jobs, []);
    assert.deepEqual(snap.counts, { running: 0, pending: 0, other: 0 });
    assert.equal(snap.jobsTotal, 0);
    assert.equal(snap.jobsTruncated, false);
  }
  assert.equal(parseSlurmSection("state=absent").state, "absent");

  const timeout = parseSlurmSection("state=error\nversion=23.11.8\nuser=kai\nerror=sinfo-timeout\njobs_total=0");
  assert.equal(timeout.state, "error");
  assert.equal(timeout.reason, "sinfo 超时（slurmctld 无响应）");
  assert.equal(timeout.version, "23.11.8");

  // sinfo 成功、squeue 失败：节点照常给出，整体标 error。
  const partial = parseSlurmSection("state=error\nerror=squeue-failed\nnode=n1|idle|0/8/0/8|0.1|100|200|0|(null)|gpu:0|CPU*|none");
  assert.equal(partial.state, "error");
  assert.equal(partial.reason, "squeue 执行失败");
  assert.equal(partial.nodes.length, 1);
});

test("防御：畸形行丢弃、数字非法 → null、长字段截断、未知键忽略", () => {
  const longName = "x".repeat(500);
  const text = [
    "state=ok",
    "user=bad user; rm -rf",
    "version=$(id)",
    "tz=garbage",
    "junk line without equals",
    "unknown=1",
    "node=too|few|fields",
    "node=n1|idle|a/b/c/d|high|-5|1e9|x|(null)|gpu:0|CPU*|none",
    "job=|nobody|CPU|RUNNING|1:00|1:00|1|1|||0|N/A|N/A|None|n1|empty-id",
    `job=7|u|CPU|weird state|1:00|1:00|x|y|||0|2026-09-30T11:53:47|N/A|None|n1|${longName}`,
  ].join("\n");
  const snap = parseSlurmSection(text);
  assert.equal(snap.user, null);
  assert.equal(snap.version, null);
  assert.equal(snap.nodes.length, 1);
  assert.deepEqual(snap.nodes[0].cpus, { alloc: null, idle: null, other: null, total: null });
  assert.equal(snap.nodes[0].load, null);
  assert.equal(snap.nodes[0].memFreeMb, null);
  assert.equal(snap.nodes[0].memTotalMb, null);
  assert.equal(snap.jobs.length, 1, "空作业 ID 的行丢弃");
  const job = snap.jobs[0];
  assert.equal(job.state, "UNKNOWN");
  assert.equal(job.nodes, null);
  assert.equal(job.cpus, null);
  assert.equal(job.submitAt, null, "tz 非法 → 不换算");
  assert.equal(job.name.length, 200);
});

// ---------------------------------------------------------------------------
// 直连节点（不在任何分区、经登录节点 ssh 采集）：hop= / hopkv= 行。
// 2026-09-30 真集群 node04 实测原文（2×A100，远端默认中文 locale，脚本已 LC_ALL=C）。
// ---------------------------------------------------------------------------

const HOP_NODE04 = [
  "hop=node04|ok|DOWN+NOT_RESPONDING",
  "hopkv=node04|nproc=192",
  "hopkv=node04|load=0.01 0.01 0.00",
  "hopkv=node04|uptime=8453",
  "hopkv=node04|cpu1=cpu  29171 4 39934 162191690 7916 0 97 0 0 0",
  "hopkv=node04|cpu2=cpu  29172 4 39936 162210975 7916 0 97 0 0 0",
  "hopkv=node04|mem_total_kb=395748968",
  "hopkv=node04|mem_avail_kb=388630396",
  "hopkv=node04|gpu=0, GPU-e5c48469-8122-adf2-62f0-44d68a46fc22, NVIDIA A100-PCIE-40GB, 14, 40960, 0",
  "hopkv=node04|gpu=1, GPU-d0c62ff2-6402-879c-49a1-d231608df543, NVIDIA A100-PCIE-40GB, 14, 40960, 0",
];

test("直连节点：真实 node04 输出并入 nodes，Slurm 节点补齐 source 等字段，按名字自然序", () => {
  const snap = parseSlurmSection([REAL_SECTION, ...HOP_NODE04].join("\n"));
  assert.deepEqual(snap.nodes.map((n) => n.name), ["master", "node01", "node02", "node03", "node04", "node05", "node06", "node07"]);
  const master = snap.nodes[0];
  assert.equal(master.source, "slurm");
  assert.equal(master.reachable, true);
  assert.equal(master.failure, null);
  assert.equal(master.busyPct, null);
  assert.equal(master.uptimeSec, null);
  const node04 = snap.nodes.find((n) => n.name === "node04");
  assert.deepEqual(node04, {
    name: "node04",
    source: "direct",
    reachable: true,
    failure: null,
    state: "direct",
    stateRaw: "DOWN+NOT_RESPONDING",
    flags: [],
    partitions: [],
    cpus: { alloc: null, idle: null, other: null, total: 192 },
    busyPct: 0,
    load: 0.01,
    memTotalMb: 386474,
    memFreeMb: 379522,
    memAllocMb: null,
    gpus: {
      total: 2,
      used: 0,
      model: "A100-PCIE-40GB",
      cards: [
        // 这份样本是 v2.33 的 6 段格式（没有温度与功耗）：照旧能读，两项为 null
        { index: 0, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, tempC: null, powerW: null, users: [] },
        { index: 1, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, tempC: null, powerW: null, users: [] },
      ],
    },
    uptimeSec: 8453,
    reason: null,
  });
  // 直连节点不影响 Slurm 统计口径：作业、计数照旧。
  assert.equal(snap.jobs.length, 3);
  assert.equal(snap.state, "ok");
});

test("直连节点：timeout / unreachable → 指标全 null；未知状态按 unreachable", () => {
  const snap = parseSlurmSection([
    "state=ok",
    "hop=node04|timeout|DOWN+NOT_RESPONDING",
    "hop=node08|unreachable|",
    "hop=node09|weird|IDLE",
    "hopkv=node04|nproc=192", // 不可达节点的 kv 行一律忽略
  ].join("\n"));
  const [n4, n8, n9] = snap.nodes;
  assert.equal(n4.reachable, false);
  assert.equal(n4.failure, "timeout");
  assert.equal(n4.state, "unreachable");
  assert.equal(n4.stateRaw, "DOWN+NOT_RESPONDING");
  assert.equal(n4.cpus.total, null);
  assert.equal(n4.busyPct, null);
  assert.equal(n4.load, null);
  assert.equal(n4.memTotalMb, null);
  assert.equal(n4.gpus, null);
  assert.equal(n8.failure, "unreachable");
  assert.equal(n8.stateRaw, null);
  assert.equal(n9.failure, "unreachable");
});

test("直连节点：多卡 GPU 的占用用户按 uuid 归卡、同用户合并显存；name 含逗号拼回", () => {
  const snap = parseSlurmSection([
    "state=ok",
    "hop=gpu10|ok|",
    "hopkv=gpu10|nproc=64",
    "hopkv=gpu10|gpu=1, GPU-b, NVIDIA H100 80GB HBM3, 72000, 81559, 97, 71, 402.56",
    "hopkv=gpu10|gpu=0, GPU-a, Weird, Name, Inc, 100, 81559, 3, 40, 71.2",
    "hopkv=gpu10|gpu=2, GPU-c, NVIDIA H100 80GB HBM3, [N/A], 81559, [N/A], [N/A], [N/A]",
    "hopkv=gpu10|gpuapp=GPU-b|kai|30000|python",
    "hopkv=gpu10|gpuapp=GPU-b|kai|12000|python",
    "hopkv=gpu10|gpuapp=GPU-b|alice|30000|python",
    "hopkv=gpu10|gpuapp=GPU-b|kai|28|nvidia-cuda-mps", // MPS 守护进程不算占用者
    "hopkv=gpu10|gpuapp=GPU-a||90|", // v2.33 的三段格式（没有进程名）照旧能读
    "hopkv=gpu10|gpuapp=GPU-zzz|bob|1|python",
  ].join("\n"));
  const { gpus } = snap.nodes[0];
  assert.equal(gpus.total, 3);
  assert.equal(gpus.used, 1, "只有 1 号卡 util≥5 或显存≥10%");
  assert.equal(gpus.model, "", "型号不全相同 → 空串");
  assert.deepEqual(gpus.cards.map((c) => c.index), [0, 1, 2]);
  assert.equal(gpus.cards[0].name, "Weird, Name, Inc");
  assert.deepEqual(gpus.cards[0].users, [{ user: "未知", memMb: 90 }]);
  assert.deepEqual(gpus.cards[1].users, [{ user: "kai", memMb: 42000 }, { user: "alice", memMb: 30000 }]);
  assert.equal(gpus.cards[2].util, null);
  assert.equal(gpus.cards[2].memUsedMb, null);
  assert.deepEqual(gpus.cards.map((c) => [c.tempC, c.powerW]), [[40, 71.2], [71, 402.6], [null, null]]);
  assert.ok(!("uuid" in gpus.cards[0]), "uuid 只用于归卡，不外露");
});

test("直连节点：与 Slurm 节点重名跳过、非法名字丢弃、数量封顶、畸形 kv 忽略", () => {
  const lines = ["state=ok", "node=node07|idle|0/192/0/192|1.00|1|2|0|(null)|gpu:0|CPU*|none", "hop=node07|ok|IDLE", "hop=-evil|ok|", "hop=bad;name|ok|"];
  for (let i = 0; i < SLURM_MAX_DIRECT_NODES + 3; i += 1) lines.push(`hop=n${i}|ok|`);
  lines.push("hopkv=n0|nproc=abc", "hopkv=n0|cpu1=garbage", "hopkv=n0|cpu2=cpu 1 2", "hopkv=n0|load=", "hopkv=n0|gpu=0, only, three", "hopkv=n0|=x", "hopkv=nosuch|nproc=4");
  const snap = parseSlurmSection(lines.join("\n"));
  const direct = snap.nodes.filter((n) => n.source === "direct");
  assert.equal(direct.length, SLURM_MAX_DIRECT_NODES);
  assert.equal(snap.nodes.filter((n) => n.name === "node07").length, 1);
  assert.equal(snap.nodes.find((n) => n.name === "node07").source, "slurm");
  const n0 = direct.find((n) => n.name === "n0");
  assert.equal(n0.cpus.total, null);
  assert.equal(n0.busyPct, null);
  assert.equal(n0.load, null);
  assert.equal(n0.gpus, null);
  // 自然序：n2 在 n10 之前。
  const names = direct.map((n) => n.name);
  assert.ok(names.indexOf("n2") < names.indexOf("n7"));
});

test("cpuBusyFromFrames：两帧差分（iowait 计入空闲），Δtotal≤0 → null", () => {
  assert.equal(cpuBusyFromFrames("cpu 100 0 100 700 100 0 0 0 0 0", "cpu 150 0 150 800 100 0 0 0 0 0"), 50);
  assert.equal(cpuBusyFromFrames("cpu 0 0 0 0 0 0 0 0", "cpu 0 0 0 0 0 0 0 0"), null);
  assert.equal(cpuBusyFromFrames("cpu 1 2 3", "cpu 1 2 3"), null);
  assert.equal(cpuBusyFromFrames(undefined, "cpu 0 0 0 0 0 0 0 0"), null);
});

// ---------------------------------------------------------------------------
// 真跑 collect.sh（slow）：用假 sinfo / squeue 覆盖 -O 成功、-O 失败回退 -o、超时三条路径，
// 以及本机没有 Slurm 时的 absent。/bin/sh 与 dash（若有）各跑一遍。Windows 无 POSIX sh，跳过。
// ---------------------------------------------------------------------------

const FAKE_SINFO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "slurm 23.11.8"; exit 0; fi
case "$*" in
  *" -O "*)
    case "$FAKE_MODE" in
      fallback) exit 1 ;;
      timeout) exit 124 ;;
    esac
    printf '%s\\n' 'master|idle|0/192/0/192|1.73|93948|380000|0|gpu:4090:4|gpu:4090:0(IDX:N/A)|GPU|none|'
    printf '%s\\n' 'node07|mixed|92/100/0/192|93.44|310892|350000|0|(null)|gpu:0|CPU*|none|'
    ;;
  *)
    printf '%s\\n' 'master|idle|0/192/0/192|1.73|93948|380000||gpu:4090:4||GPU|none'
    ;;
esac
`;

const FAKE_SQUEUE = `#!/bin/sh
case "$*" in
  *" -O "*)
    [ "$FAKE_MODE" = fallback ] && exit 1
    printf '%s\\n' '16326|kai|CPU|RUNNING|44:19|UNLIMITED|1|92|cpu=92,node=1,billing=92|N/A|0|2026-09-30T11:53:47|2026-09-30T12:02:18|None|node07|job|with|pipes|'
    printf '%s\\n' '16400|alice|GPU|PENDING|0:00|1:00:00|1|8||gres/gpu:2|0|2026-09-30T12:00:00|N/A|Resources||train|'
    ;;
  *)
    printf '%s\\n' '16326|kai|CPU|RUNNING|44:19|UNLIMITED|1|92||N/A|0|2026-09-30T11:53:47|2026-09-30T12:02:18|None|node07|fallback-job'
    ;;
esac
`;

// scontrol：未设 FAKE_SCONTROL 时失败（不产生直连节点，既有用例不受影响）。
// 清单里 master / node07 在 sinfo 结果中；node04 / node08 / node09 / node10 是直连候选，
// bad;name 被名字白名单挡掉，node10 超出 3 个上限不应被 ssh。
const FAKE_SCONTROL = `#!/bin/sh
[ "$FAKE_SCONTROL" = 1 ] || exit 1
printf '%s\\n' 'NodeName=master Arch=x86_64 CoresPerSocket=96 CPUAlloc=0 State=IDLE ThreadsPerCore=1'
printf '%s\\n' 'NodeName=bad;name Arch=x86_64 State=IDLE'
printf '%s\\n' 'NodeName=node04 Arch=x86_64 CoresPerSocket=96 State=DOWN+NOT_RESPONDING ThreadsPerCore=1'
printf '%s\\n' 'NodeName=node07 Arch=x86_64 State=MIXED'
printf '%s\\n' 'NodeName=node08 Arch=x86_64 State=DOWN'
printf '%s\\n' 'NodeName=node09 Arch=x86_64 State=IDLE+DRAIN'
printf '%s\\n' 'NodeName=node10 Arch=x86_64 State=IDLE'
`;

// ssh：记录每次调用的参数；没带 -n 时像真 ssh 一样把 stdin 读光（会吞掉经 stdin 送达的脚本剩余部分）。
// node04 → 正常输出；node08 → 124（timeout 杀掉）；node09 → 255（连不上）。
// 注意：最后一个参数是远端脚本本体（里面就有 "sed -n"），判断 -n 与记录日志都只看它之前的参数。
const FAKE_SSH = `#!/bin/sh
opts=
has_n=0
host=
last=
for a in "$@"; do
  if [ -n "$last" ]; then opts="$opts $last"; host=$last; fi
  [ "$a" = "-n" ] && has_n=1
  last=$a
done
[ "$last" = "-n" ] && has_n=0
printf '%s\\n' "$opts" >> "$FAKE_SSH_LOG"
[ "$has_n" = 1 ] || cat >/dev/null
case "$host" in
  node04)
    printf '%s\\n' 'nproc=192' 'load=0.50 0.40 0.30' 'uptime=100' 'cpu1=cpu  100 0 100 700 100 0 0 0 0 0' 'cpu2=cpu  150 0 150 800 100 0 0 0 0 0' 'mem_total_kb=1048576' 'mem_avail_kb=524288'
    printf '%s\\n' 'gpu=0, GPU-a, NVIDIA A100-PCIE-40GB, 30000, 40960, 88' 'gpuapp=GPU-a|kai|30000'
    ;;
  node08) exit 124 ;;
  *) exit 255 ;;
esac
`;

function withFakeSlurm(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-slurm-"));
  try {
    for (const [name, body] of [["sinfo", FAKE_SINFO], ["squeue", FAKE_SQUEUE], ["scontrol", FAKE_SCONTROL], ["ssh", FAKE_SSH]]) {
      const file = path.join(dir, name);
      writeFileSync(file, body);
      chmodSync(file, 0o755);
      // 先执行一次：macOS 对新写出的可执行文件第一次执行要做安全评估（机器忙时能卡上几十秒），
      // 别让它吃掉采集脚本给每条 Slurm 命令的 8 秒时限。假 ssh 这一趟的调用记录丢掉。
      spawnSync(file, [], { env: { ...process.env, FAKE_SSH_LOG: "/dev/null" }, timeout: 60000 });
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// collect.sh slow profile 的段（顺序即输出顺序）。
const SLOW_SECTIONS = ["sys", "cpu-stat", "filesystem", "gpu", "agents", "ports", "proc-top", "tunnel-egress", "slurm"];
const SHELLS = ["/bin/sh", "/bin/dash"].filter((sh) => spawnSync(sh, ["-c", "exit 0"]).status === 0);

function runSlow(shell, env) {
  const res = spawnSync(shell, [COLLECTOR_SCRIPT_PATH], {
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, CT_PROFILE: "slow", CT_PORTS: "7891", ...env },
  });
  assert.equal(res.status, 0, res.stderr);
  const { sections } = parseCollectorOutput(res.stdout);
  assert.deepEqual(Object.keys(sections), SLOW_SECTIONS, "slow 各段必须齐全");
  return sections.slurm;
}

for (const shell of SHELLS) {
  test(`collect.sh（${shell}）：-O 成功 → 行尾 | 剥掉、Name 含 | 拼回、计数截断前统计`, { skip: process.platform === "win32" }, () => {
    withFakeSlurm((dir) => {
      const section = runSlow(shell, { PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: "ok" });
      const snap = parseSlurmSection(section);
      assert.equal(snap.state, "ok");
      assert.equal(snap.version, "23.11.8");
      assert.ok(snap.user, "user 行来自 id -un");
      assert.ok(snap.remoteNow > 0);
      assert.equal(snap.nodes.length, 2);
      assert.equal(snap.nodes[1].reason, null, "行尾 | 已剥掉，Reason=none → null");
      assert.equal(snap.jobs[0].name, "job|with|pipes");
      assert.equal(snap.jobs[1].reason, "Resources");
      assert.equal(snap.jobs[1].gpus, 2);
      assert.deepEqual(snap.counts, { running: 1, pending: 1, other: 0 });
      assert.equal(snap.jobsTotal, 2);
      // 汇总行在数据行之前：截断时只丢尾部。
      const lines = section.split("\n");
      assert.ok(lines.findIndex((l) => l.startsWith("jobs_total=")) < lines.findIndex((l) => l.startsWith("node=")));
    });
  });

  test(`collect.sh（${shell}）：-O 失败回退 -o 格式`, { skip: process.platform === "win32" }, () => {
    withFakeSlurm((dir) => {
      const snap = parseSlurmSection(runSlow(shell, { PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: "fallback" }));
      assert.equal(snap.state, "ok");
      assert.equal(snap.nodes.length, 1);
      assert.equal(snap.nodes[0].memAllocMb, null);
      assert.equal(snap.jobs[0].name, "fallback-job");
    });
  });

  test(`collect.sh（${shell}）：sinfo 超时 → state=error，不再跑回退与 squeue`, { skip: process.platform === "win32" }, () => {
    withFakeSlurm((dir) => {
      const section = runSlow(shell, { PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: "timeout" });
      const snap = parseSlurmSection(section);
      assert.equal(snap.state, "error");
      assert.equal(snap.reason, "sinfo 超时（slurmctld 无响应）");
      assert.deepEqual(snap.nodes, []);
      assert.deepEqual(snap.jobs, []);
      assert.doesNotMatch(section, /^node=/m);
    });
  });
}

// 经 stdin 送达（与生产 `ssh host sh -s` 同形）：内层 ssh 若没带 -n 会读 stdin，吞掉脚本剩余部分。
// 末尾追加一个哨兵段，缺了就说明 stdin 被吃掉了。
function runSlowViaStdin(shell, env) {
  const script = readFileSync(COLLECTOR_SCRIPT_PATH, "utf8").replace(/\nexit 0\s*$/, "\nprintf '__TAIL_OK__\\n'\nexit 0\n");
  const res = spawnSync(shell, ["-s"], {
    input: script,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, CT_PROFILE: "slow", CT_PORTS: "7891", ...env },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

for (const shell of SHELLS) {
  test(`collect.sh（${shell}，stdin 送达）：直连节点 ok / timeout / 255 三路径，ssh 必带 -n，不吞脚本`, { skip: process.platform === "win32" }, () => {
    withFakeSlurm((dir) => {
      const log = path.join(dir, "ssh.log");
      const stdout = runSlowViaStdin(shell, { PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: "ok", FAKE_SCONTROL: "1", FAKE_SSH_LOG: log });
      assert.match(stdout, /__TAIL_OK__/, "脚本尾部必须被 sh 读到（内层 ssh 没有吞 stdin）");
      const { sections } = parseCollectorOutput(stdout);
      assert.deepEqual(Object.keys(sections), SLOW_SECTIONS);
      const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
      assert.equal(calls.length, 3, "最多 3 个直连节点；node10 不应被 ssh");
      for (const call of calls) {
        assert.match(call, /(?:^|\s)-n(?:\s|$)/, "内层 ssh 必须带 -n");
        assert.doesNotMatch(call, /sed|nproc/, "日志只记选项与主机，不含远端脚本");
        assert.match(call, /BatchMode=yes/);
        assert.match(call, /UpdateHostKeys=no/);
        assert.match(call, /ControlPath=none/);
        assert.doesNotMatch(call, /accept-new/);
      }
      assert.doesNotMatch(calls.join("\n"), /node10|bad;name|master|node07/);
      const snap = parseSlurmSection(sections.slurm);
      const byName = Object.fromEntries(snap.nodes.map((n) => [n.name, n]));
      assert.equal(byName.node04.source, "direct");
      assert.equal(byName.node04.reachable, true);
      assert.equal(byName.node04.stateRaw, "DOWN+NOT_RESPONDING");
      assert.equal(byName.node04.busyPct, 50);
      assert.equal(byName.node04.cpus.total, 192);
      assert.equal(byName.node04.memTotalMb, 1024);
      assert.equal(byName.node04.gpus.used, 1);
      assert.deepEqual(byName.node04.gpus.cards[0].users, [{ user: "kai", memMb: 30000 }]);
      assert.equal(byName.node08.failure, "timeout");
      assert.equal(byName.node09.failure, "unreachable");
      assert.equal(byName.node09.stateRaw, "IDLE+DRAIN");
      assert.equal(byName.master.source, "slurm");
      assert.equal(snap.jobs.length, 2, "作业不受直连节点影响");
      // 直连节点行在 node= 之后、job= 之前：队列触到段上限时先截掉的是作业行。
      const lines = sections.slurm.split("\n");
      const lastNode = lines.map((l) => l.startsWith("node=")).lastIndexOf(true);
      const firstHop = lines.findIndex((l) => l.startsWith("hop="));
      const firstJob = lines.findIndex((l) => l.startsWith("job="));
      assert.ok(lastNode < firstHop && firstHop < firstJob);
    });
  });

  test(`collect.sh（${shell}）：sinfo 超时 → 不查 scontrol、不 ssh 任何节点`, { skip: process.platform === "win32" }, () => {
    withFakeSlurm((dir) => {
      const log = path.join(dir, "ssh.log");
      const section = runSlow(shell, { PATH: `${dir}:${process.env.PATH}`, FAKE_MODE: "timeout", FAKE_SCONTROL: "1", FAKE_SSH_LOG: log });
      assert.doesNotMatch(section, /^hop=/m);
      assert.equal(existsSync(log), false);
    });
  });
}

test("collect.sh：本机没有 Slurm → state=absent", { skip: process.platform === "win32" }, () => {
  const probe = spawnSync("/bin/sh", ["-c", "PATH=\"$PATH:/public/slurm/bin:/opt/slurm/bin:/usr/local/slurm/bin\"; command -v sinfo"], { encoding: "utf8" });
  if (probe.status === 0) return; // 在装了 Slurm 的机器上跑测试：本条不适用。
  const snap = parseSlurmSection(runSlow("/bin/sh", {}));
  assert.equal(snap.state, "absent");
});

// ---------------------------------------------------------------------------
// 直连节点上执行的那段脚本（ct_hop_script）本身：从 collect.sh 里取出原文，用假 nvidia-smi / ps
// 在本机 sh / dash 下真跑。脚本在远端节点的登录 shell 里执行，平时的测试用假 ssh 顶替了它，
// 语法错误或引号问题只有在集群上才会暴露。
// ---------------------------------------------------------------------------

const HOP_SCRIPT = /\nct_hop_script='([\s\S]*?)'\n/.exec(readFileSync(COLLECTOR_SCRIPT_PATH, "utf8"))?.[1] ?? "";
const HOP_FAKE_NVIDIA_SMI = `#!/bin/sh
case "$*" in
  *temperature.gpu*)
    [ "$FAKE_GPU_MODE" = "old-driver" ] && exit 2
    printf '0, GPU-a, NVIDIA A100-PCIE-40GB, 30000, 40960, 88, 61, 245.3\\n1, GPU-b, NVIDIA A100-PCIE-40GB, 14, 40960, 0, 33, 52.31\\n' ;;
  *query-gpu=*) printf '0, GPU-a, NVIDIA A100-PCIE-40GB, 30000, 40960, 88\\n1, GPU-b, NVIDIA A100-PCIE-40GB, 14, 40960, 0\\n' ;;
  *query-compute-apps*) printf 'GPU-a, 4242, 29900\\nGPU-a, 77, 28\\n' ;;
esac
`;
// v2.76 起直连节点也一次取「属主 / 已运行秒数 / 命令行」三列；进程名由本机从命令行第一个词的 basename 推，
// 77 的 args 是 nvidia-cuda-mps-control → 本机仍认得出它是 MPS 守护进程（不算占用者）。
// FAKE_PS_NO_ETIMES=1 模拟老 ps（BusyBox）：带 etimes 的调用失败，只有不带 etimes 的两次有输出。
const HOP_FAKE_PS = `#!/bin/sh
for last; do :; done
case "$*" in
  *user:32=,etimes=,args=*)
    [ "$FAKE_PS_NO_ETIMES" = "1" ] && exit 1
    [ "$last" = 4242 ] && echo "kai 7200 python train.py --config a.yaml" ;
    [ "$last" = 77 ] && echo "root 999 nvidia-cuda-mps-control -d" ;;
  *user:32=,args=*)
    [ "$FAKE_PS_NO_ETIMES" = "1" ] || exit 0
    case "$last" in
      4242) echo "kai python train.py --config a.yaml" ;;
      77) echo "root nvidia-cuda-mps-control -d" ;;
    esac ;;
esac
exit 0
`;

// cgroups：pid → /proc/<pid>/cgroup 的内容，建在临时目录里的假文件系统中，经只给测试用的 CT_FS_ROOT 指过去。
// 没给时假文件系统是空的：不管测试跑在哪台机器上，都读不到这几个假 pid 的 cgroup。
function runHopScript(shell, mode, cgroups = null, extraEnv = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-hop-"));
  try {
    for (const [name, body] of [["nvidia-smi", HOP_FAKE_NVIDIA_SMI], ["ps", HOP_FAKE_PS], ["sleep", "#!/bin/sh\nexit 0\n"]]) {
      writeFileSync(path.join(dir, name), body);
      chmodSync(path.join(dir, name), 0o755);
    }
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GPU_MODE: mode, CT_FS_ROOT: path.join(dir, "root"), ...extraEnv };
    for (const [pid, text] of Object.entries(cgroups || {})) {
      mkdirSync(path.join(dir, "root/proc", pid), { recursive: true });
      writeFileSync(path.join(dir, "root/proc", pid, "cgroup"), text);
    }
    // 假命令先各执行一次：macOS 对新写出的可执行文件第一次执行要做安全评估（机器忙时能卡上几十秒），放在计时之外。
    // 这一趟慢得不正常（正常约 1 秒）就重跑，最多三趟——脚本只读，同样的输入重跑结果相同，断言不变。
    for (const name of ["nvidia-smi", "ps", "sleep"]) spawnSync(path.join(dir, name), [], { env, timeout: 60000 });
    const once = () => {
      const startedAt = Date.now();
      const spawned = spawnSync(shell, ["-c", HOP_SCRIPT], { encoding: "utf8", timeout: 15000, env });
      return { spawned, ms: Date.now() - startedAt };
    };
    let attempt = once();
    for (let i = 0; i < 2 && attempt.ms > 4000; i += 1) attempt = once();
    const res = attempt.spawned;
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.split("\n").filter((line) => /^gpu(proc|app)?=/.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ct_hop_script：能从 collect.sh 里取出，且不含单引号（它整段包在单引号里送去远端）", () => {
  assert.ok(HOP_SCRIPT.includes("nvidia-smi"), "取到了直连节点脚本");
  assert.ok(!HOP_SCRIPT.includes("'"));
});

for (const shell of SHELLS) {
  test(`ct_hop_script（${shell}）：GPU 行带温度 / 功耗，进程行带属主、已运行秒数与命令行，解析后并入直连节点`, { skip: process.platform === "win32" }, () => {
    const lines = runHopScript(shell, "full");
    assert.deepEqual(lines, [
      "gpu=0, GPU-a, NVIDIA A100-PCIE-40GB, 30000, 40960, 88, 61, 245.3",
      "gpu=1, GPU-b, NVIDIA A100-PCIE-40GB, 14, 40960, 0, 33, 52.31",
      // 第 6 段是 v2.62 追加的作业号（假文件系统里没有这两个 pid，读不到 cgroup → 留空）；第 7 段是命令行
      "gpuproc=GPU-a|4242|29900|kai|7200||python train.py --config a.yaml",
      "gpuproc=GPU-a|77|28|root|999||nvidia-cuda-mps-control -d",
    ]);
    const snap = parseSlurmSection(["state=ok", "hop=node04|ok|", ...lines.map((line) => `hopkv=node04|${line}`)].join("\n"));
    assert.deepEqual(snap.nodes[0].gpus.cards, [
      {
        index: 0, name: "NVIDIA A100-PCIE-40GB", util: 88, memUsedMb: 30000, memTotalMb: 40960, tempC: 61, powerW: 245.3,
        users: [{
          user: "kai", memMb: 29900,
          procs: [{ pid: "4242", memMb: 29900, etimes: 7200, jobId: null, comm: "python", cmdline: "python train.py --config a.yaml" }],
        }],
      },
      { index: 1, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, tempC: 33, powerW: 52.3, users: [] },
    ]);
  });

  test(`ct_hop_script（${shell}）：进程行尾带 Slurm 作业号（与主采集同一取法）；同段的 user 是采集账号，它的进程另按作业合并`, { skip: process.platform === "win32" }, () => {
    const lines = runHopScript(shell, "full", {
      4242: "11:freezer:/slurm/uid_1003/job_555/step_batch\n1:name=systemd:/user.slice/user-1003.slice/session-7.scope\n",
      77: "0::/system.slice/nvidia-mps.service\n",
    });
    assert.deepEqual(lines.filter((line) => line.startsWith("gpuproc=")), [
      "gpuproc=GPU-a|4242|29900|kai|7200|555|python train.py --config a.yaml",
      "gpuproc=GPU-a|77|28|root|999||nvidia-cuda-mps-control -d",
    ]);
    const section = (user) => ["state=ok", `user=${user}`, "hop=node04|ok|", ...lines.map((line) => `hopkv=node04|${line}`)].join("\n");
    const proc = { pid: "4242", memMb: 29900, etimes: 7200, jobId: "555", comm: "python", cmdline: "python train.py --config a.yaml" };
    assert.deepEqual(parseSlurmSection(section("kai")).nodes[0].gpus.cards[0].users, [
      { user: "kai", memMb: 29900, procs: [proc], jobs: [{ id: "555", memMb: 29900 }] },
    ]);
    assert.deepEqual(parseSlurmSection(section("lin")).nodes[0].gpus.cards[0].users, [
      { user: "kai", memMb: 29900, procs: [proc] },
    ], "别人的进程只到属主（逐进程明细照样保留）");
  });

  test(`ct_hop_script（${shell}）：老 ps 不认 etimes → 退回两列，秒数留空、属主与命令行照旧`, { skip: process.platform === "win32" }, () => {
    const lines = runHopScript(shell, "full", null, { FAKE_PS_NO_ETIMES: "1" });
    assert.deepEqual(lines.filter((line) => line.startsWith("gpuproc=")), [
      "gpuproc=GPU-a|4242|29900|kai|||python train.py --config a.yaml",
      "gpuproc=GPU-a|77|28|root|||nvidia-cuda-mps-control -d",
    ]);
    const snap = parseSlurmSection(["state=ok", "hop=node04|ok|", ...lines.map((line) => `hopkv=node04|${line}`)].join("\n"));
    assert.deepEqual(snap.nodes[0].gpus.cards[0].users, [{
      user: "kai", memMb: 29900,
      procs: [{ pid: "4242", memMb: 29900, etimes: null, jobId: null, comm: "python", cmdline: "python train.py --config a.yaml" }],
    }], "MPS 守护进程照旧不算占用者，时长取不到不算回归");
  });

  test(`ct_hop_script（${shell}）：老驱动回退基础查询，温度 / 功耗留空`, { skip: process.platform === "win32" }, () => {
    const lines = runHopScript(shell, "old-driver");
    assert.equal(lines[0], "gpu=0, GPU-a, NVIDIA A100-PCIE-40GB, 30000, 40960, 88, , ");
    const snap = parseSlurmSection(["state=ok", "hop=node04|ok|", ...lines.map((line) => `hopkv=node04|${line}`)].join("\n"));
    assert.deepEqual(snap.nodes[0].gpus.cards.map((c) => [c.util, c.tempC, c.powerW, c.users.length]), [[88, null, null, 1], [0, null, null, 0]]);
  });
}
