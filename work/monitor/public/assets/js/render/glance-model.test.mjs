import assert from "node:assert/strict";
import test from "node:test";

import { buildClusterPanelModel } from "./cluster-model.js";
import { buildGlanceModel, DEFAULT_GLANCE_METRIC, glanceTitle, normalizeGlanceMetric } from "./glance-model.js";

const NOW = 1_800_000_000_000;

function slurmNode(name, state, { alloc, total, gpus = null } = {}) {
  return {
    name, source: "slurm", reachable: true, failure: null, state, stateRaw: state, flags: [], partitions: ["GPU"],
    cpus: { alloc, idle: total - alloc, other: 0, total }, load: null, memTotalMb: null, memFreeMb: null, memAllocMb: null,
    busyPct: null, gpus, uptimeSec: null, reason: null,
  };
}

function statusWith({ slurm = null, tunnels = null, resources = null, activeServerId = "s1" } = {}) {
  return {
    activeServerId,
    serversBrief: { s1: { displayName: "主集群服务器 (myserver)" }, s2: { displayName: "备用机" } },
    layers: {
      tunnels: tunnels || { s1: { level: "ok", reason: "通道全链路正常" } },
      resources: resources || {
        s1: { level: "ok", checkedAt: NOW - 1000, cpu: 7, ram: 12, disk: 88, gpu: [], slurm },
      },
    },
  };
}

const SLURM = {
  schemaVersion: 1, state: "ok", reason: null, version: "23.11.8", user: "kai", checkedAt: NOW - 1000, remoteNow: NOW,
  defaultPartition: "GPU", jobsTotal: 3, jobsTruncated: false, counts: { running: 2, pending: 1, other: 0 },
  nodes: [
    slurmNode("node01", "mixed", { alloc: 24, total: 64, gpus: { total: 4, used: 1, model: "4090" } }),
    slurmNode("node02", "allocated", { alloc: 64, total: 64, gpus: { total: 2, used: 2, model: "A100" } }),
    slurmNode("node03", "idle", { alloc: 0, total: 64 }),
  ],
  jobs: [
    { id: "1", user: "kai", state: "RUNNING", partition: "GPU", nodes: 1, cpus: 8, gpus: 1, nodeList: "node01", name: "a" },
    { id: "2", user: "other", state: "RUNNING", partition: "GPU", nodes: 1, cpus: 64, gpus: 2, nodeList: "node02", name: "b" },
    { id: "3", user: "kai", state: "PENDING", partition: "GPU", nodes: 1, cpus: 8, gpus: 1, nodeList: null, name: "c", reason: "Resources" },
  ],
};

test("集群读数与集群面板 KPI 同一口径：核分配、GPU、节点、作业、我的作业", () => {
  const glance = buildGlanceModel(statusWith({ slurm: SLURM }), { now: NOW });
  const panel = buildClusterPanelModel({ layer: { level: "ok", checkedAt: NOW - 1000, slurm: SLURM }, now: NOW });
  assert.deepEqual(panel.glance, {
    cpuAlloc: 88, cpuTotal: 192, cpuAllocPct: (88 / 192) * 100, nodeCount: 3, busyNodes: 2, idleNodes: 1, badNodes: 0,
    gpuUsed: 3, gpuTotal: 6, running: 2, pending: 1,
  });
  const { nodes, gpuGroups, freshness, mine, errorText, ...counts } = glance.cluster;
  assert.deepEqual(counts, panel.glance);
  assert.deepEqual(nodes.map((n) => [n.key, n.tone]), [["node01", "busy"], ["node02", "busy"], ["node03", "idle"]]);
  assert.deepEqual(gpuGroups.map((g) => g.slots.map((s) => s.fill)), [[1, 0, 0, 0], [1, 1]]);
  assert.deepEqual(mine, { user: "kai", running: 1, pending: 1 });
  assert.equal(freshness.level, "ok");
  assert.equal(errorText, "");
});

test("服务器：短名、查看中的那台、链路点；只监控 / 未领端口的不计入隧道总数", () => {
  const glance = buildGlanceModel(statusWith({
    tunnels: { s1: { level: "ok", reason: "通道全链路正常" }, s2: { level: "error", reason: "隧道断开" }, s3: { level: "skipped", reason: "仅监控" } },
    resources: { s1: { level: "ok", cpu: 7, ram: 12 }, s2: { level: "error", cpu: 0, ram: 0 }, s3: { level: "waiting" } },
    activeServerId: "s2",
  }), { now: NOW });
  assert.deepEqual(glance.servers.map((s) => [s.id, s.name, s.active, s.link]), [
    ["s1", "主集群", false, "ok"],
    ["s2", "备用机", true, "down"],
    ["s3", "s3", false, "off"],
  ]);
  assert.equal(glance.active.id, "s2");
  assert.deepEqual(glance.links, { up: 1, total: 2 });
  assert.equal(glance.cluster, null, "非 Slurm 机器没有集群区");
  assert.deepEqual(buildGlanceModel(null), { servers: [], active: null, links: { up: 0, total: 0 }, cluster: null });
});

test("菜单栏数字：GPU / CPU / 我的作业 / 不显示；没有 GPU 或不是 Slurm 时退到 CPU", () => {
  const glance = buildGlanceModel(statusWith({ slurm: SLURM }), { now: NOW });
  assert.equal(glanceTitle(glance, "gpu"), "GPU 3/6");
  assert.equal(glanceTitle(glance, "cpu"), "CPU 46%");
  assert.equal(glanceTitle(glance, "mine"), "作业 1+1");
  assert.equal(glanceTitle(glance, "off"), "");
  assert.equal(glanceTitle(glance, "bogus"), "GPU 3/6", "未知选项按默认");

  const cpuOnly = { ...SLURM, nodes: SLURM.nodes.map((n) => ({ ...n, gpus: null })) };
  assert.equal(glanceTitle(buildGlanceModel(statusWith({ slurm: cpuOnly }), { now: NOW }), "gpu"), "CPU 46%");
  const plain = buildGlanceModel(statusWith(), { now: NOW });
  assert.equal(glanceTitle(plain, "gpu"), "CPU 7%", "非 Slurm：查看中服务器的 CPU 使用率");
  assert.equal(glanceTitle(plain, "mine"), "", "没有调度器就没有我的作业");
  assert.equal(glanceTitle(null, "gpu"), "");
});

test("菜单栏数字：调度器查询失败 / 采集失败时不挂过期读数", () => {
  const failed = buildGlanceModel(statusWith({ slurm: { ...SLURM, state: "error", reason: "squeue 超时" } }), { now: NOW });
  assert.equal(failed.cluster.errorText, "squeue 超时");
  assert.equal(glanceTitle(failed, "gpu"), "CPU 7%", "集群读数不可信时退到服务器负载");
  // 最近一次尝试（层的 checkedAt）比手上的数据晚一轮以上：这一轮没采到。
  const lagging = { ...SLURM, checkedAt: NOW - 60_000 };
  const down = buildGlanceModel(statusWith({
    resources: { s1: { level: "error", reason: "SSH 失败", checkedAt: NOW, cpu: 7, ram: 12, slurm: lagging } },
  }), { now: NOW });
  assert.equal(down.cluster.freshness.level, "error");
  assert.equal(glanceTitle(down, "gpu"), "");
});

test("normalizeGlanceMetric：只认四个选项", () => {
  assert.equal(DEFAULT_GLANCE_METRIC, "gpu");
  for (const key of ["gpu", "cpu", "mine", "off"]) assert.equal(normalizeGlanceMetric(key), key);
  assert.equal(normalizeGlanceMetric(undefined), "gpu");
  assert.equal(normalizeGlanceMetric("ram"), "gpu");
});
