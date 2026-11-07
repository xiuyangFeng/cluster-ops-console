import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDeadlockChain,
  buildClusterPanelModel,
  buildIdleComputeRadar,
  computeDurationBaselines,
  computeQueueAhead,
  describeNodeState,
  describeReason,
  detectJobGpuHazard,
  evaluateDurationAnomaly,
  expandNodeList,
  formatDuration,
  groupJobRows,
  isDeadlockReason,
  jobBaseName,
  nodeRangeOf,
  progressTone,
} from "./cluster-model.js";
import { buildFiltersHtml, buildGroupedJobRowsHtml, buildIdleRadarHtml, buildJobRowsHtml, buildKpisHtml, buildMineSummaryHtml, buildNodesHtml, buildUsersHtml } from "./cluster-view.js";

const NOW = 1_790_000_000_000;

function node(name, state, alloc, total, load, extra = {}) {
  return {
    name,
    state,
    stateRaw: state,
    flags: [],
    partitions: ["CPU"],
    cpus: { alloc, idle: total - alloc, other: 0, total },
    load,
    memTotalMb: 350000,
    memFreeMb: 300000,
    memAllocMb: 0,
    gpus: null,
    reason: null,
    ...extra,
  };
}

function job(id, user, state, extra = {}) {
  return {
    id,
    user,
    partition: "CPU",
    state,
    elapsedSec: state === "RUNNING" ? 2644 : 0,
    timeLimitSec: null,
    nodes: 1,
    cpus: 56,
    gpus: 0,
    memory: null,
    submitAt: NOW - 3_600_000,
    startAt: state === "RUNNING" ? NOW - 2_644_000 : null,
    waitSec: state === "PENDING" ? 720 : null,
    reason: state === "PENDING" ? "Priority" : null,
    nodeList: state === "RUNNING" ? "node02" : null,
    name: `job-${id}`,
    ...extra,
  };
}

// 形状对齐 2026-09-30 集群实测（7 节点、3 个运行作业）。
function layerFixture(overrides = {}) {
  return {
    level: "ok",
    checkedAt: NOW - 10_000,
    slurm: {
      schemaVersion: 1,
      state: "ok",
      reason: null,
      version: "23.11.8",
      user: "kai",
      checkedAt: NOW - 10_000,
      remoteNow: NOW - 10_000,
      defaultPartition: "CPU",
      nodes: [
        node("master", "idle", 0, 192, 1.73, { partitions: ["GPU"], memTotalMb: 380000, memFreeMb: 93948, gpus: { total: 4, used: 0, model: "4090" } }),
        node("node01", "idle", 0, 192, 52.11),
        node("node02", "mixed", 56, 192, 32.7),
        node("node03", "mixed", 56, 192, 42.74),
        node("node07", "mixed", 92, 192, 93.44),
      ],
      jobs: [
        job("15527", "Liaaaaa", "RUNNING", { nodeList: "node02", elapsedSec: 72381 }),
        job("16326", "kai", "RUNNING", { nodeList: "node07", cpus: 92, name: "cfa-labelfix" }),
        job("15550", "Liaaaaa", "RUNNING", { nodeList: "node03", elapsedSec: 72381 }),
        job("16400", "kai", "PENDING", { waitSec: 90, reason: "Resources" }),
        job("16401", "bob", "PENDING", { waitSec: 3000 }),
      ],
      jobsTotal: 5,
      jobsTruncated: false,
      counts: { running: 3, pending: 2, other: 0 },
      ...overrides,
    },
  };
}

test("没有 Slurm（absent / 旧后端无字段 / 无层）→ 面板隐藏", () => {
  assert.equal(buildClusterPanelModel({ layer: null }).visible, false);
  assert.equal(buildClusterPanelModel({ layer: { level: "ok" } }).visible, false);
  assert.equal(buildClusterPanelModel({ layer: { slurm: { state: "absent", nodes: [], jobs: [] } } }).visible, false);
});

test("KPI：核分配按节点求和，作业计数优先用后端全量 counts", () => {
  const m = buildClusterPanelModel({ layer: layerFixture(), now: NOW });
  assert.equal(m.visible, true);
  const cpu = m.kpis.find((k) => k.key === "cpu");
  // 204 / 960 = 21.25%
  assert.equal(cpu.value, "21%");
  assert.equal(cpu.sub, "204 / 960 核已分配");
  assert.equal(cpu.visual.kind, "ring");
  assert.equal(cpu.visual.pct, 21.3);
  assert.equal(m.kpis.find((k) => k.key === "nodes").visual.dots.length, 5);
  assert.deepEqual(m.kpis.find((k) => k.key === "jobs").visual.segments.map((seg) => seg.key), ["running", "pending"]);
  const jobs = m.kpis.find((k) => k.key === "jobs");
  assert.equal(jobs.value, "3");
  assert.match(jobs.sub, /2 排队/);
  assert.match(jobs.sub, /3 位用户/);
  const mine = m.kpis.find((k) => k.key === "mine");
  assert.equal(mine.label, "我的作业（kai）");
  assert.equal(mine.value, "1");
  assert.match(mine.sub, /1 排队 · 占 92 核/);
  // 92 / 960 = 9.58%：占比单独一行 + 底部细条
  assert.equal(mine.sub2, "占全集群 10% 的核");
  assert.deepEqual(mine.visual, { kind: "share", pct: 9.6, title: "我占用的核数 / Slurm 节点总核数" });
  assert.equal(mine.emphasis, true);
  const gpu = m.kpis.find((k) => k.key === "gpu");
  assert.equal(gpu.value, "0");
  assert.equal(gpu.unit, "/ 4 卡在用");
  assert.equal(gpu.sub, "Slurm 已分配 0/4");
  assert.equal(gpu.sub2, "", "只有一种来源时不占第二行");
  assert.equal(gpu.visual.groups[0].slots.length, 4);
  assert.equal(m.badge, "5 节点 · 2 分区 · Slurm 23.11.8");
});

test("后端 counts 缺失时按作业数组统计；截断时给出提示", () => {
  const layer = layerFixture({ counts: undefined, jobsTotal: 900, jobsTruncated: true });
  const m = buildClusterPanelModel({ layer, now: NOW });
  assert.equal(m.kpis.find((k) => k.key === "jobs").value, "3");
  assert.equal(m.truncatedText, "仅列出前 5 个作业（队列共 900 个）");
});

test("节点：分配 / 负载 / 内存口径与 Slurm 之外负载提示", () => {
  const m = buildClusterPanelModel({ layer: layerFixture(), now: NOW });
  const byName = Object.fromEntries(m.nodes.map((n) => [n.name, n]));
  assert.equal(byName.node07.stats[0].value, "92 / 192 核");
  assert.equal(byName.node07.stats[1].value, "93.4（49%）");
  assert.deepEqual(byName.node07.ring, { outer: 47.9, inner: 48.7, center: "48%", caption: "分配" });
  // 首行说明写短（版式不动）；完整说法在悬停提示里
  assert.equal(byName.node07.meta, "CPU · 1 作业");
  assert.match(byName.node07.title, /CPU 分区 · 1 个作业在运行/);
  assert.equal(byName.node01.meta, "CPU · 无作业");
  assert.equal(byName.node07.state.label, "部分占用");
  assert.equal(byName.node07.state.tone, "busy");
  // node01：0 核分配却有 52 负载 → Slurm 之外有进程
  assert.equal(byName.node01.offSlurm, true);
  assert.equal(byName.node02.offSlurm, false);
  // master 内存：380000 - 93948 = 286052 MB ≈ 75%
  assert.equal(byName.master.memPct, 75);
  assert.equal(byName.master.memLevel, "warn");
  assert.equal(byName.master.gpu.text, "0 / 4 已分配 · 4090");
  assert.equal(byName.master.gpu.slots.filter((s) => s.busy).length, 0);
  assert.equal(m.offSlurmCount, 1);
});

test("节点内存：空闲超过 Slurm 配置总量时改报空闲量，不出现负数", () => {
  const layer = layerFixture();
  layer.slurm.nodes = [node("node02", "mixed", 56, 192, 24.9, { memTotalMb: 350000, memFreeMb: 351380 })];
  const [n] = buildClusterPanelModel({ layer, now: NOW }).nodes;
  assert.equal(n.memPct, 0);
  assert.equal(n.memText, "空闲 343 GiB");
  assert.match(n.title, /配置偏小/);
});

test("节点状态：后缀 flag 升级级别，标签可读", () => {
  assert.deepEqual(describeNodeState("idle", []), { label: "空闲", level: "ok", tone: "idle" });
  assert.deepEqual(describeNodeState("down", ["not_responding"]), { label: "宕机 · 无响应", level: "critical", tone: "critical" });
  assert.deepEqual(describeNodeState("mixed", ["drain"]), { label: "部分占用 · 排空中", level: "warn", tone: "warn" });
  assert.equal(describeNodeState("idle", ["powered_off"]).label, "空闲 · 已休眠");
  assert.equal(describeNodeState("weird", []).label, "weird");
  assert.equal(describeNodeState(null, []).label, "未知");
});

test("异常节点计入 KPI，并按最坏级别着色", () => {
  const layer = layerFixture();
  layer.slurm.nodes.push(node("node05", "down", 0, 192, null, { flags: ["not_responding"], reason: "Not responding" }));
  const m = buildClusterPanelModel({ layer, now: NOW });
  const nodesKpi = m.kpis.find((k) => k.key === "nodes");
  assert.match(nodesKpi.sub, /1 异常/);
  assert.equal(nodesKpi.level, "critical");
  const html = buildNodesHtml(m.nodes);
  assert.match(html, /data-level="critical"/);
  assert.match(html, /原因：Not responding/);
});

test("作业排序：我的在前；各自运行（久的在前）→ 排队（等得久的在前）；排队原因译成中文", () => {
  const m = buildClusterPanelModel({ layer: layerFixture(), now: NOW });
  assert.deepEqual(m.jobs.map((j) => j.id), ["16326", "16400", "15527", "15550", "16401"]);
  const pending = m.jobs.find((j) => j.id === "16400");
  assert.equal(pending.durationText, "已等 1 分");
  assert.equal(pending.where, "等待资源");
  assert.equal(pending.whereIsReason, true);
  assert.equal(pending.mine, true);
  const running = m.jobs.find((j) => j.id === "16326");
  assert.equal(running.durationText, "44 分");
  assert.match(running.title, /不限时/);
  assert.equal(running.limitShort, "");
  assert.equal(running.resourceText, "92 核");
  assert.equal(running.where, "node07");
});

test("过滤：运行 / 排队 / 我的 / 按节点；失效节点过滤自动丢弃", () => {
  const layer = layerFixture();
  const count = (view) => buildClusterPanelModel({ layer, now: NOW, view }).jobs.length;
  assert.equal(count({ filter: "running" }), 3);
  assert.equal(count({ filter: "pending" }), 2);
  assert.equal(count({ filter: "mine" }), 2);
  assert.equal(count({ node: "node07" }), 1);
  assert.equal(count({ filter: "pending", node: "node07" }), 0);
  const gone = buildClusterPanelModel({ layer, now: NOW, view: { node: "node99", filter: "bogus" } });
  assert.equal(gone.node, null);
  assert.equal(gone.filter, "all");
  const empty = buildClusterPanelModel({ layer, now: NOW, view: { filter: "pending", node: "node07" } });
  assert.equal(empty.emptyText, "没有符合筛选的作业");
  assert.equal(empty.emptyState.body, "当前筛选：排队中 · 节点 node07。");
  assert.deepEqual(empty.emptyState.actions, [{ label: "清除筛选", kind: "text", attrs: { "data-cl-clear-filter": "" } }]);
  assert.equal(buildClusterPanelModel({ layer, now: NOW }).emptyState, null, "有作业时没有空状态");
});

test("作业表空状态：队列本身为空（与筛选无关，写 squeue 的真实节奏）vs 筛选没命中（搜索图标 + 当前筛选 + 清除筛选）", () => {
  const layer = layerFixture();
  layer.slurm.jobs = [];
  layer.slurm.counts = { running: 0, pending: 0, other: 0 };
  for (const filter of ["all", "pending"]) {
    const m = buildClusterPanelModel({ layer, now: NOW, view: { filter } });
    assert.equal(m.emptyText, "队列是空的");
    assert.equal(m.emptyState.icon, "inbox");
    assert.match(m.emptyState.body, /数据来自 squeue，每分钟刷新一次。/);
    assert.equal(m.emptyState.actions, undefined, "队列是空的：没有可清除的东西");
  }
  const mine = buildClusterPanelModel({ layer: layerFixture(), now: NOW, view: { filter: "mine", node: "node02" } });
  assert.equal(mine.emptyState.icon, "search");
  assert.equal(mine.emptyState.body, "当前筛选：我的作业 · 节点 node02。");
  const html = buildGroupedJobRowsHtml(mine.jobRows, mine.emptyState);
  assert.match(html, /^<tr class="cl-job-empty"><td colspan="6"><div class="empty-state" data-tone="neutral">/);
  assert.match(html, /<p class="empty-state-title">没有符合筛选的作业<\/p>/);
  assert.match(html, /<button type="button" class="text-btn" data-cl-clear-filter="">清除筛选<\/button>/);
});

test("按用户占用：按核数降序，自己打标，超出上限折叠为「其他」", () => {
  const layer = layerFixture();
  for (let i = 0; i < 8; i += 1) layer.slurm.jobs.push(job(`2000${i}`, `u${i}`, "RUNNING", { cpus: 1, nodeList: "node05" }));
  const m = buildClusterPanelModel({ layer, now: NOW });
  assert.equal(m.users[0].user, "Liaaaaa");
  assert.equal(m.users[0].cores, 112);
  assert.equal(m.users[1].user, "kai");
  assert.equal(m.users[1].mine, true);
  assert.equal(m.users.length, 7);
  assert.equal(m.users.at(-1).other, true);
  assert.equal(m.userCount, 11);
  assert.match(buildUsersHtml(m.users), /data-mine="true"/);
});

test("新鲜度：正常 / 较旧 / 调度器失败 / 采集失败保留旧数据", () => {
  assert.equal(buildClusterPanelModel({ layer: layerFixture(), now: NOW }).freshness.text, "采样于 10 秒前");
  const stale = buildClusterPanelModel({ layer: layerFixture(), now: NOW + 10 * 60_000 });
  assert.equal(stale.freshness.level, "warn");
  const err = buildClusterPanelModel({ layer: layerFixture({ state: "error", reason: "slurm_load_jobs error: Socket timed out", nodes: [], jobs: [] }), now: NOW });
  assert.equal(err.visible, true);
  assert.equal(err.freshness.level, "error");
  assert.match(err.errorText, /Socket timed out/);
  const failed = layerFixture();
  failed.level = "error";
  failed.checkedAt = NOW;
  failed.reason = "采集失败 (ssh exit 255)";
  const f = buildClusterPanelModel({ layer: failed, now: NOW });
  assert.equal(f.freshness.level, "error");
  assert.match(f.freshness.text, /^采集失败/);
  assert.equal(f.nodes.length, 5, "失败时仍展示上次数据");
});

test("格式化与节点表达式展开", () => {
  assert.equal(formatDuration(45), "45 秒");
  assert.equal(formatDuration(2644), "44 分");
  assert.equal(formatDuration(72381), "20 小时 6 分");
  assert.equal(formatDuration(7200), "2 小时");
  assert.equal(formatDuration(93784), "1 天 2 小时");
  assert.equal(formatDuration(null), "");
  assert.deepEqual(expandNodeList("node[02-03,07]"), ["node02", "node03", "node07"]);
  assert.deepEqual(expandNodeList("master,node[1-2]"), ["master", "node1", "node2"]);
  assert.deepEqual(expandNodeList("(null)"), []);
  assert.deepEqual(expandNodeList(""), []);
  assert.deepEqual(describeReason("Priority"), { text: "优先级靠后", raw: "Priority" });
  assert.equal(describeReason("ReqNodeNotAvail, UnavailableNodes:node04").text, "所需节点不可用");
  assert.equal(describeReason("QOSMaxCpuPerUserLimit").text, "超出配额限制");
  assert.equal(describeReason("AssocGrpCpuLimit").text, "超出配额限制");
  assert.equal(describeReason("None").text, "");
  assert.equal(describeReason("SomethingNew").text, "SomethingNew");
});

test("视图片段：动态文案全部转义；过滤芯片带计数与按节点芯片", () => {
  const layer = layerFixture();
  layer.slurm.jobs[0].name = '<img src=x onerror="alert(1)">';
  layer.slurm.jobs[0].user = "<b>";
  const m = buildClusterPanelModel({ layer, now: NOW, view: { node: "node02" } });
  const rows = buildJobRowsHtml(m.jobs, m.emptyText);
  assert.doesNotMatch(rows, /<img/);
  assert.match(rows, /&lt;img/);
  assert.doesNotMatch(rows, /<b>/);
  const filters = buildFiltersHtml(m.filters, m.node);
  assert.match(filters, /data-cl-filter="all" aria-pressed="true">全部<span class="cl-filter-count">5<\/span>/);
  assert.match(filters, /节点 node02/);
  assert.match(buildJobRowsHtml([], "没有排队的作业"), /colspan="6">没有排队的作业/);
  const kpis = buildKpisHtml(m.kpis);
  assert.match(kpis, /data-key="cpu"/);
  assert.match(kpis, /data-kind="kpi"><span class="res-meter-fill" style="transform: scaleX\(0\.213\)"/, "核分配在汇总带里画成细进度条");
  assert.doesNotMatch(kpis, /cl-ring/, "汇总带不再画环形仪表（数值已在大字里）");
  const nodes = buildNodesHtml(m.nodes, "node02");
  assert.match(nodes, /data-cl-node="node02" aria-pressed="true"/);
  assert.match(nodes, /负载高于分配（有 Slurm 外进程）/);
});

function directNode(name, extra = {}) {
  return {
    name,
    source: "direct",
    reachable: true,
    failure: null,
    state: "direct",
    stateRaw: "DOWN+NOT_RESPONDING",
    flags: [],
    partitions: [],
    cpus: { alloc: null, idle: null, other: null, total: 192 },
    busyPct: 37.4,
    load: 70.2,
    memTotalMb: 377415,
    memFreeMb: 370000,
    memAllocMb: null,
    gpus: {
      total: 2,
      used: 1,
      model: "A100-PCIE-40GB",
      cards: [
        { index: 0, name: "NVIDIA A100-PCIE-40GB", util: 88, memUsedMb: 20480, memTotalMb: 40960, users: [{ user: "kai", memMb: 20466 }] },
        { index: 1, name: "NVIDIA A100-PCIE-40GB", util: 0, memUsedMb: 14, memTotalMb: 40960, users: [] },
      ],
    },
    uptimeSec: 7920,
    reason: null,
    lastSeenAt: NOW - 10_000,
    ...extra,
  };
}

test("直连节点：利用率外环、GPU 逐卡柱高与使用者；不计入 Slurm 核分配", () => {
  const layer = layerFixture();
  layer.slurm.nodes.push(directNode("node04"));
  const m = buildClusterPanelModel({ layer, now: NOW });
  const n = m.nodes.find((x) => x.name === "node04");
  assert.equal(n.direct, true);
  assert.equal(n.state.label, "直连在线");
  assert.equal(n.state.tone, "busy");
  assert.equal(n.meta, "192 核", "已有「直连」徽标，说明只留核数");
  assert.match(n.title, /不在任何 Slurm 分区，由登录节点 ssh 直连采集/);
  assert.deepEqual(n.ring, { outer: 37.4, inner: 36.6, center: "37%", caption: "利用率" });
  assert.equal(n.stats[0].value, "37%");
  assert.equal(n.gpu.text, "1 / 2 在用 · A100-PCIE-40GB");
  assert.equal(n.gpu.userText, "kai 20 GB");
  assert.deepEqual(n.gpu.slots.map((s) => [s.fill, s.busy]), [[0.88, true], [0, false]]);
  assert.equal(n.offSlurm, false, "直连节点没有分配，不做 Slurm 外进程判断");
  assert.match(n.title, /Slurm：DOWN\+NOT_RESPONDING/);
  // CPU 分配仍只算 Slurm 节点：204 / 960
  const cpu = m.kpis.find((k) => k.key === "cpu");
  assert.equal(cpu.sub, "204 / 960 核 · Slurm 节点");
  assert.equal(cpu.sub2, "node04 直连 · 利用率 37%");
  const gpu = m.kpis.find((k) => k.key === "gpu");
  assert.equal(gpu.value, "1");
  assert.equal(gpu.unit, "/ 6 卡在用");
  assert.equal(gpu.sub, "Slurm 已分配 0/4");
  assert.equal(gpu.sub2, "直连在用 1/2", "两种来源拆成两行，不挤在一行里被省略");
  assert.equal(gpu.visual.groups.length, 2);
  const html = buildNodesHtml(m.nodes);
  assert.match(html, /data-direct="true"/);
  assert.match(html, />直连</);
  assert.match(html, /scaleY\(0\.88\)/);
});

test("直连节点中断：卡片换成说明（上次连接时间），标黄但不影响其它节点", () => {
  const layer = layerFixture();
  layer.slurm.nodes.push(directNode("node04", {
    reachable: false, failure: "timeout", state: "unreachable", busyPct: null, load: null,
    cpus: { alloc: null, idle: null, other: null, total: null }, memTotalMb: null, memFreeMb: null, gpus: null,
    lastSeenAt: NOW - 12 * 60_000,
  }));
  const m = buildClusterPanelModel({ layer, now: NOW });
  const n = m.nodes.find((x) => x.name === "node04");
  assert.equal(n.state.label, "无法连接");
  assert.equal(n.state.level, "warn");
  assert.equal(n.offline.text, "连接超时 · 上次连接 12 分钟前");
  assert.equal(n.meta, "", "连不上时拿不到核数：首行说明留空，原因在卡片正文");
  assert.equal(n.gpu, null);
  assert.equal(m.kpis.find((k) => k.key === "cpu").sub2, "node04 直连中断");
  assert.match(m.kpis.find((k) => k.key === "nodes").sub, /1 异常/);
  const html = buildNodesHtml(m.nodes);
  assert.match(html, /data-offline="true"/);
  assert.match(html, /只影响该节点的监控/);
  // 其它节点照常渲染
  assert.equal(m.nodes.filter((x) => !x.direct).every((x) => x.ring.outer != null), true);
});

test("作业单行：有时限才挂上限与进度细线、多节点才写节点数、资源列不带分区名", () => {
  const layer = layerFixture();
  layer.slurm.jobs = [job("17000", "kai", "RUNNING", { nodes: 2, cpus: 128, gpus: 2, timeLimitSec: 86400, partition: "GPU", nodeList: "node[02-03]" })];
  const m = buildClusterPanelModel({ layer, now: NOW });
  const [j] = m.jobs;
  assert.equal(j.resourceText, "2 节点 · 128 核 · 2 GPU");
  assert.equal(j.limitShort, "1 天");
  const row = buildJobRowsHtml(m.jobs);
  // 2644 / 86400 = 3.06%：时长后面是「/ 上限」，单元格底边一条进度细线
  assert.equal(j.progress, 2644 / 86400);
  assert.equal(j.progressTone, "ok");
  assert.match(row, /44 分<span class="cl-job-sub"> \/ 1 天<\/span><span class="cl-job-progress" data-tone="ok" title="已用时限的 3%"><i style="width: 3\.1%"><\/i><\/span><\/td>/);
  assert.match(row, /<td class="cl-job-res">2 节点 · 128 核 · 2 GPU<\/td>/, "分区名不再重复出现在资源列");
  assert.match(j.title, /分区 GPU/, "分区仍在悬停提示里");
  assert.match(j.title, /上限 1 天（已用 3%）/);
  assert.doesNotMatch(row, /overflow-x/);
});

test("时限进度：已用 / 时限，80% 转黄、95% 转红；没有时限、排队中的不画", () => {
  assert.deepEqual([0, 0.5, 0.799, 0.8, 0.949, 0.95, 1].map(progressTone), ["ok", "ok", "ok", "warn", "warn", "critical", "critical"]);
  assert.equal(progressTone(null), null);
  const layer = layerFixture();
  layer.slurm.jobs = [
    job("1", "kai", "RUNNING", { elapsedSec: 1800, timeLimitSec: 3600 }),
    job("2", "kai", "RUNNING", { elapsedSec: 2880, timeLimitSec: 3600 }),
    job("3", "kai", "RUNNING", { elapsedSec: 3420, timeLimitSec: 3600 }),
    job("4", "kai", "RUNNING", { elapsedSec: 4000, timeLimitSec: 3600 }),
    job("5", "kai", "RUNNING", { elapsedSec: 1800, timeLimitSec: null }),
    job("6", "kai", "RUNNING", { elapsedSec: 1800, timeLimitSec: 0 }),
    job("7", "kai", "PENDING", { timeLimitSec: 3600 }),
  ];
  const m = buildClusterPanelModel({ layer, now: NOW });
  const byId = Object.fromEntries(m.jobs.map((j) => [j.id, j]));
  assert.deepEqual(["1", "2", "3", "4"].map((id) => [byId[id].progress, byId[id].progressTone]), [[0.5, "ok"], [0.8, "warn"], [0.95, "critical"], [1, "critical"]]);
  assert.deepEqual(["5", "6", "7"].map((id) => byId[id].progress), [null, null, null]);
  const html = buildJobRowsHtml(m.jobs);
  assert.equal((html.match(/class="cl-job-progress"/g) || []).length, 4);
  assert.match(html, /data-tone="warn" title="已用时限的 80%"><i style="width: 80%">/);
  assert.match(html, /data-tone="critical" title="已用时限的 100%"><i style="width: 100%">/);
});

test("同名实验组的时限进度：画组内最小–最大那一段，颜色看最接近时限的那个", () => {
  const layer = layerFixture();
  layer.slurm.jobs = [0.1, 0.3, 0.5].map((ratio, i) => job(`5${i}`, "kai", "RUNNING", { name: `cfa-agiter20-${(0xabc000 + i).toString(16)}-cfd1`, elapsedSec: 600 * ratio, timeLimitSec: 600 }));
  const [group] = buildClusterPanelModel({ layer, now: NOW }).jobRows;
  assert.deepEqual(group.progress, { lo: 0.1, hi: 0.5, tone: "ok" });
  const html = buildGroupedJobRowsHtml([group]);
  assert.match(html, /<span class="cl-job-progress" data-tone="ok" title="组内进度 10%–50%（已用 \/ 时限）"><i style="left: min\(10%, calc\(100% - 3px\)\); width: max\(3px, 40%\)"><\/i><\/span><\/td>/);

  layer.slurm.jobs = [0.2, 0.9, 0.97].map((ratio, i) => job(`6${i}`, "kai", "RUNNING", { name: `sweep_lr_${i}`, elapsedSec: 1000 * ratio, timeLimitSec: 1000 }));
  assert.equal(buildClusterPanelModel({ layer, now: NOW }).jobRows[0].progress.tone, "critical");

  // 组里没有带时限的运行作业：不画
  layer.slurm.jobs = [0, 1, 2].map((i) => job(`7${i}`, "kai", "RUNNING", { name: `sweep_lr_${i}` }));
  const plain = buildClusterPanelModel({ layer, now: NOW }).jobRows[0];
  assert.equal(plain.progress, null);
  assert.doesNotMatch(buildGroupedJobRowsHtml([plain]), /cl-job-progress/);
});

test("指标带：我的作业第二行 + 占比细条；我没有作业在跑时不画；GPU 说明拆两行", () => {
  const html = buildKpisHtml(buildClusterPanelModel({ layer: layerFixture(), now: NOW }).kpis);
  assert.match(html, /data-key="mine"[\s\S]*?<div class="cl-kpi-sub cl-kpi-sub2">占全集群 10% 的核<\/div><\/div><div class="cl-kpi-visual" data-kind="share" title="我占用的核数 \/ Slurm 节点总核数"><span class="res-meter cl-meter" data-kind="kpi"><span class="res-meter-fill" style="transform: scaleX\(0\.096\)"/);

  const idle = layerFixture();
  idle.slurm.jobs = idle.slurm.jobs.filter((j) => j.user !== "kai");
  const mine = buildClusterPanelModel({ layer: idle, now: NOW }).kpis.find((k) => k.key === "mine");
  assert.deepEqual([mine.sub, mine.sub2, mine.visual], ["0 排队", "", null]);

  const both = layerFixture();
  both.slurm.nodes.push(directNode("node04"));
  const gpuHtml = buildKpisHtml(buildClusterPanelModel({ layer: both, now: NOW }).kpis.filter((k) => k.key === "gpu"));
  assert.match(gpuHtml, /<div class="cl-kpi-sub">Slurm 已分配 0\/4<\/div><div class="cl-kpi-sub cl-kpi-sub2">直连在用 1\/2<\/div>/);
});

test("nodeRangeOf：若干 nodeList 合并成范围；withCount=false 不带台数", () => {
  assert.equal(nodeRangeOf(["node01", "node[03-05]", "node07"]), "node01–07 · 5 台");
  assert.equal(nodeRangeOf(["node01", "node[03-05]", "node07"], { withCount: false }), "node01–07");
  assert.equal(nodeRangeOf(["master"], { withCount: false }), "master");
  assert.equal(nodeRangeOf(["node02", "master"]), "node02 · master · 2 台");
  assert.equal(nodeRangeOf([]), "");
  assert.equal(nodeRangeOf(null), "");
});

// ---- 同名实验分组 ----

test("jobBaseName：去掉末尾哈希（连同阶段后缀）与序号", () => {
  assert.equal(jobBaseName("cfa-agiter20-35607b-cfd1"), "cfa-agiter20");
  assert.equal(jobBaseName("cfa-agiter20-025781-prepare1"), "cfa-agiter20");
  assert.equal(jobBaseName("sweep_lr_12"), "sweep_lr");
  assert.equal(jobBaseName("m1cap_v52dcv_speed2"), "m1cap_v52dcv_speed2", "普通名字原样");
  assert.equal(jobBaseName(""), "");
});

function experimentLayer() {
  const jobs = [];
  for (let i = 0; i < 5; i += 1) jobs.push(job(`2${i}`, "kai", "RUNNING", { name: `cfa-agiter20-${(0xabc000 + i).toString(16)}-${i % 2 ? "cfd1" : "prepare1"}`, elapsedSec: 60 * (i + 1), cpus: i % 2 ? 64 : 4, nodeList: `node0${i + 1}` }));
  for (let i = 0; i < 3; i += 1) jobs.push(job(`3${i}`, "kai", "PENDING", { name: `sweep_lr_${i}`, waitSec: 300 + i * 60, reason: "Resources" }));
  jobs.push(job("40", "kai", "RUNNING", { name: "cfdauto_smoke" }));
  jobs.push(job("41", "alice", "RUNNING", { name: "sweep_lr_1" }), job("42", "alice", "RUNNING", { name: "sweep_lr_2" }));
  return layerFixture({ jobs, jobsTotal: jobs.length, counts: null });
}

test("分组：同一用户同前缀 ≥3 个折叠成一行，别人同名不混入，少于 3 个不分组", () => {
  const model = buildClusterPanelModel({ layer: experimentLayer(), now: NOW, view: {} });
  const groups = model.jobRows.filter((r) => r.kind === "group");
  assert.deepEqual(groups.map((g) => [g.label, g.count, g.user]), [["cfa-agiter20-*", 5, "kai"], ["sweep_lr-*", 3, "kai"]]);
  const cfa = groups[0];
  assert.equal(cfa.running, 5);
  assert.equal(cfa.stagesText, "prepare1 ×3 · cfd1 ×2");
  assert.equal(cfa.timeText, "1 分 – 5 分");
  assert.equal(cfa.resText, "4 核 ×3 · 64 核 ×2");
  assert.equal(cfa.where, "node01–05 · 5 台");
  const sweep = groups[1];
  assert.equal(sweep.pending, 3);
  assert.match(sweep.timeText, /^已等 5 分 – 7 分$/);
  assert.equal(sweep.whereIsReason, true);
  assert.equal(model.jobRows.filter((r) => r.kind === "job" && r.job.user === "alice").length, 2, "别人的两个同名作业不分组");
  assert.equal(model.jobRows.length, 2 + 1 + 2, "2 组 + 1 个单独作业 + alice 2 个");
  assert.equal(model.mine.count, 9);
  assert.equal(model.mine.groups, 2);
  assert.equal(model.mine.collapsed, 2);
});

test("展开：组内作业紧跟组行（child），全部展开时按钮变为全部折叠", () => {
  const layer = experimentLayer();
  const keys = buildClusterPanelModel({ layer, now: NOW, view: {} }).groupKeys;
  const model = buildClusterPanelModel({ layer, now: NOW, view: { expanded: new Set(keys) } });
  const idx = model.jobRows.findIndex((r) => r.kind === "group" && r.label === "cfa-agiter20-*");
  assert.equal(model.jobRows[idx].expanded, true);
  assert.ok(model.jobRows.slice(idx + 1, idx + 6).every((r) => r.kind === "job" && r.child && r.groupKey === keys[0]));
  assert.equal(model.mine.allExpanded, true);
  const html = buildGroupedJobRowsHtml(model.jobRows);
  assert.equal((html.match(/class="cl-group-child"/g) || []).length, 8);
  assert.match(html, /data-cl-group="kai\|cfa-agiter20"[^>]*aria-expanded="true" tabindex="0"/);
  assert.match(buildMineSummaryHtml(model.mine), /data-cl-expand-all="collapse">全部折叠/);
});

test("分组跟随筛选：只看排队时只剩排队的组", () => {
  const model = buildClusterPanelModel({ layer: experimentLayer(), now: NOW, view: { filter: "pending" } });
  assert.deepEqual(model.jobRows.map((r) => (r.kind === "group" ? r.label : r.job.id)), ["sweep_lr-*"]);
  assert.equal(groupJobRows([], {}).rows.length, 0);
  assert.match(buildGroupedJobRowsHtml([], "没有排队的作业"), /没有排队的作业/);
});

test("「我的」汇总条：没有我的作业也没有组时不显示", () => {
  assert.equal(buildMineSummaryHtml({ visible: false }), "");
  const html = buildMineSummaryHtml({ visible: true, count: 71, running: 19, pending: 52, cores: 1068, gpus: 4, groups: 3, collapsed: 3, allExpanded: false });
  assert.match(html, /<b>71<\/b> 个作业/);
  assert.match(html, /占用 <b>1,068<\/b> 核 · <b>4<\/b> 卡/);
  assert.match(html, /3 组实验已折叠/);
  assert.match(html, /data-cl-expand-all="expand">全部展开/);
});

test("我的作业固定在最上方：我的单独作业与实验组都排在别人之前，内部保持原排序", () => {
  const model = buildClusterPanelModel({ layer: experimentLayer(), now: NOW, view: {} });
  const owners = model.jobRows.map((r) => (r.kind === "group" ? r.user : r.job.user));
  const firstOther = owners.indexOf("alice");
  assert.ok(firstOther > 0);
  assert.ok(owners.slice(0, firstOther).every((u) => u === "kai"), "别人的行之前全是我的");
  assert.ok(owners.slice(firstOther).every((u) => u !== "kai"), "我的行之后没有再出现我的");
  assert.deepEqual(model.jobRows.slice(0, 3).map((r) => (r.kind === "group" ? r.label : r.job.name)), ["cfdauto_smoke", "cfa-agiter20-*", "sweep_lr-*"], "运行最久在前、排队在后");
});

test("排队前序透视与死锁识别：统计同分区等待更久的作业数及核/GPU 需求，DependencyNeverSatisfied 提示 scancel", () => {
  assert.equal(isDeadlockReason("DependencyNeverSatisfied"), true);
  assert.equal(isDeadlockReason("Dependency"), false);
  assert.equal(computeQueueAhead([], null), null);
  const layer = layerFixture();
  layer.slurm.jobs.push(
    job("16402", "alice", "PENDING", { waitSec: 1200, cpus: 64, gpus: 2, reason: "Priority" }),
    job("16405", "kai", "PENDING", { waitSec: 400, cpus: 16, reason: "DependencyNeverSatisfied", name: "eval-deadlock" }),
  );
  const m = buildClusterPanelModel({ layer, now: NOW });
  const myPending = m.jobs.find((j) => j.id === "16400");
  // 同在 CPU 分区且比 16400（wait=90s）等得更久的有 16401（3000s, 56 核）、16402（1200s, 64 核 2 GPU）、16405（400s, 16 核）
  assert.deepEqual(myPending.queueAhead, {
    jobs: 3,
    cpus: 136,
    gpus: 2,
    text: "前序 3 作业（136 核 · 2 GPU）",
  });
  assert.match(myPending.title, /前序 3 作业（136 核 · 2 GPU）/);

  const dead = m.jobs.find((j) => j.id === "16405");
  assert.equal(dead.deadlock, true);
  assert.equal(dead.queueAhead, null, "死锁作业不算前序资源等待");
  assert.match(dead.title, /建议执行 scancel 16405 清理/);
  const html = buildJobRowsHtml([dead]);
  assert.match(html, /data-deadlock="true"/);
  assert.match(html, /建议 scancel 16405/);
});

test("GPU 作业实时早筛：同卡显存 ≥95% 濒危告警与运行 ≥15m 的 GPU 空转提示", () => {
  const vramJob = { id: "101", mine: true, group: "running", gpus: 1, elapsed: 300, user: "kai", nodeList: "gpu01" };
  const vramCard = { index: 0, memUsedMb: 79000, memTotalMb: 80000, util: 85, users: [{ user: "kai", jobs: [{ id: "101" }] }, { user: "bob", jobs: [{ id: "102" }] }] };
  const h1 = detectJobGpuHazard(vramJob, { allCards: [vramCard], nodeCards: [vramCard], viewer: "kai" });
  assert.equal(h1.kind, "vram-critical");
  assert.equal(h1.tone, "critical");
  assert.match(h1.text, /显存 99%（同卡叠跑濒危）/);

  const idleJob = { id: "103", mine: true, group: "running", gpus: 2, elapsed: 1200, user: "kai", nodeList: "gpu01" };
  const idleCard = { index: 1, memUsedMb: 2048, memTotalMb: 80000, util: 0, users: [{ user: "kai", jobs: [{ id: "103" }] }] };
  const h2 = detectJobGpuHazard(idleJob, { allCards: [idleCard], nodeCards: [idleCard], viewer: "kai" });
  assert.equal(h2.kind, "gpu-idle");
  assert.equal(h2.tone, "warn");
  assert.match(h2.text, /GPU 0%（疑似空转）/);

  // 刚跑不久（<15m）不误报空转
  const freshJob = { id: "103", mine: true, group: "running", gpus: 1, elapsed: 600, user: "kai", nodeList: "gpu01" };
  assert.equal(detectJobGpuHazard(freshJob, { allCards: [idleCard], nodeCards: [idleCard], viewer: "kai" }), null);
});

test("流水线死锁整链清理：串联 DependencyNeverSatisfied 与同流水线 Dependency 等待作业，生成整链 scancel", () => {
  const layer = layerFixture();
  layer.slurm.jobs.push(
    job("17001", "kai", "PENDING", { waitSec: 500, reason: "DependencyNeverSatisfied", name: "pipe_step1" }),
    job("17002", "kai", "PENDING", { waitSec: 480, reason: "Dependency", name: "pipe_step2" }),
    job("17003", "kai", "PENDING", { waitSec: 460, reason: "Dependency", name: "pipe_step3" }),
  );
  const m = buildClusterPanelModel({ layer, now: NOW });
  assert.ok(m.mine.deadlockChain);
  assert.deepEqual(m.mine.deadlockChain.allIds, ["17001", "17002", "17003"]);
  assert.equal(m.mine.deadlockChain.command, "scancel 17001 17002 17003");
  const step2 = m.jobs.find((j) => j.id === "17002");
  assert.equal(step2.cascadeDeadlock, true);
  assert.match(buildJobRowsHtml([step2]), /前序死锁/);
  assert.match(buildMineSummaryHtml(m.mine), /data-cl-diag-copy="scancel 17001 17002 17003"/);
});

test("耗时历史基线对比：对超出同名历史完成作业中位数 ≥2x 且多出 ≥10m 的慢作业打标", () => {
  const historyRows = [
    { kind: "job", outcome: "completed", name: "cfa-labelfix_1", elapsedSec: 600 },
    { kind: "job", outcome: "completed", name: "cfa-labelfix_2", elapsedSec: 620 },
    { kind: "job", outcome: "completed", name: "cfa-labelfix_3", elapsedSec: 580 },
  ];
  const baselines = computeDurationBaselines(historyRows);
  assert.ok(baselines.has("cfa-labelfix"));
  assert.equal(baselines.get("cfa-labelfix").medianSec, 600);
  const anomaly = evaluateDurationAnomaly("cfa-labelfix_4", 1800, baselines);
  assert.ok(anomaly);
  assert.equal(anomaly.ratio, 3);
  assert.match(anomaly.text, /慢 3×/);

  const m = buildClusterPanelModel({ layer: layerFixture(), now: NOW, historyRows });
  const running = m.jobs.find((j) => j.id === "16326"); // cfa-labelfix, elapsedSec=2644
  assert.ok(running.slowAnomaly);
  assert.match(buildJobRowsHtml([running]), /慢 4\.4×/);
});

test("空闲算力雷达：综合节点状态、剩余 GPU 卡数与剩余核数推荐最佳节点，并生成 srun 与 #SBATCH 命令", () => {
  const m = buildClusterPanelModel({ layer: layerFixture(), now: NOW });
  assert.ok(m.idleRadar.visible);
  assert.ok(m.idleRadar.bestCpu);
  assert.equal(m.idleRadar.bestCpu.node, "node02", "node02 剩余 136 核且无 Slurm 外高负载，排第一");
  assert.match(m.idleRadar.bestCpu.srunCmd, /srun -p CPU -w node02 -c 16 --pty bash/);

  // 构造带空闲 GPU 的节点与 drain 节点，验证 drain 被排除且最佳 GPU 节点被选中
  const layer = layerFixture();
  layer.slurm.nodes.push(
    node("gpu02", "mixed", 16, 64, 8, { partitions: ["GPU*"], gpus: { total: 4, used: 1, model: "A100" } }),
    node("gpu03", "drained", 0, 64, 0, { partitions: ["GPU*"], gpus: { total: 8, used: 0, model: "A100" } }),
  );
  const m2 = buildClusterPanelModel({ layer, now: NOW });
  assert.ok(m2.idleRadar.bestGpu);
  assert.equal(m2.idleRadar.bestGpu.node, "gpu02", "drained 的 gpu03 不参与推荐");
  assert.equal(m2.idleRadar.bestGpu.freeGpus, 3);
  assert.equal(m2.idleRadar.bestGpu.srunCmd, "srun -p GPU -w gpu02 --gres=gpu:1 -c 8 --pty bash");
  assert.equal(m2.idleRadar.bestGpu.sbatchSnippet, "#SBATCH -p GPU -w gpu02 --gres=gpu:1 -c 8");
  const radarHtml = buildIdleRadarHtml(m2.idleRadar);
  assert.match(radarHtml, /GPU 最佳 <b>gpu02<\/b>/);
  assert.match(radarHtml, /复制 srun/);
  assert.match(radarHtml, /复制 #SBATCH/);
  assert.equal(buildIdleComputeRadar([]).visible, false);
});

