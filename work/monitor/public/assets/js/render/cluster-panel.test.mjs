// cluster-panel.js 的空状态接线：调度器从没查到数据时整块换成「暂时取不到」（重试 = 面板头「立即刷新」）、
// 作业表「清除筛选」、「我的历史」空状态里的「按作业号或日期查」。纯 Node，假 DOM 只实现用到的接口。
import assert from "node:assert/strict";
import test from "node:test";

import { fakeElement, spy } from "../app/test-support.mjs";
import { clusterErrorHtml, focusClusterJob, initClusterPanel, renderClusterPanel, resetClusterPanelState } from "./cluster-panel.js";

const NOW = 1_800_000_000_000;

// morphInnerHtml 经 ownerDocument 的 <template> 解析：这里把写进去的 HTML 记在元素的 html 上。
function morphable(props = {}) {
  const el = fakeElement({ childNodes: [], isConnected: true, ...props });
  el.ownerDocument = {
    createElement: () => {
      const tpl = { content: { childNodes: [] } };
      Object.defineProperty(tpl, "innerHTML", { set: (value) => { el.html = value; } });
      return tpl;
    },
  };
  return el;
}

function setupDom(t) {
  const body = fakeElement({ isConnected: true });
  const elements = {
    clusterPanel: fakeElement({ isConnected: true, querySelector: (selector) => (selector === ".cl-body" ? body : null) }),
    clusterError: morphable({ hidden: true }),
    clusterJobsBody: morphable(),
    clusterRefreshBtn: fakeElement({ tag: "button", textContent: "立即刷新", isConnected: true }),
    clusterHistoryQuery: fakeElement({ tag: "input", isConnected: true }),
  };
  const saved = { document: globalThis.document, Element: globalThis.Element };
  globalThis.document = { getElementById: (id) => elements[id] || null };
  globalThis.Element = { [Symbol.hasInstance]: (value) => typeof value?.closest === "function" };
  resetClusterPanelState();
  t.after(() => {
    resetClusterPanelState();
    globalThis.document = saved.document;
    globalThis.Element = saved.Element;
  });
  return { elements, body };
}

// 点击目标：只认一个属性（按选择器列表逐项精确匹配），getAttribute 取它的值。
function target(attr, value = "") {
  const el = {
    closest: (selector) => (selector.split(",").map((part) => part.trim()).includes(`[${attr}]`) ? el : null),
    getAttribute: (name) => (name === attr ? value : null),
    dataset: {},
  };
  return el;
}

const slurmJob = (id, state, nodeList = null) => ({
  id, user: "kai", partition: "CPU", state, elapsedSec: state === "RUNNING" ? 600 : 0, timeLimitSec: null, nodes: 1, cpus: 8, gpus: 0,
  memory: null, submitAt: NOW - 3_600_000, startAt: state === "RUNNING" ? NOW - 600_000 : null, waitSec: null, reason: state === "PENDING" ? "Priority" : null,
  nodeList, name: `job-${id}`,
});

function layerWith({ state = "ok", reason = null, nodes = null, jobs = [] } = {}) {
  return {
    level: "ok",
    checkedAt: NOW - 5_000,
    slurm: {
      schemaVersion: 1, state, reason, version: "23.11.8", user: "kai", checkedAt: NOW - 5_000, remoteNow: NOW - 5_000, defaultPartition: "CPU",
      nodes: nodes ?? [{ name: "node01", state: "mixed", stateRaw: "mixed", flags: [], partitions: ["CPU"], cpus: { alloc: 8, idle: 184, other: 0, total: 192 }, load: 8, memTotalMb: 1000, memFreeMb: 500, memAllocMb: 0, gpus: null, reason: null }],
      jobs,
    },
  };
}

test("clusterErrorHtml：只在调度器失败且从没拿到过数据时给整块空状态（带原因与「重试」）", () => {
  assert.equal(clusterErrorHtml({ errorText: "", hasData: false }), "");
  assert.equal(clusterErrorHtml({ errorText: "sinfo 超时", hasData: true }), "", "有旧数据：保持顶部红条 + 旧数据");
  const html = clusterErrorHtml({ errorText: "sinfo 超时", hasData: false });
  assert.match(html, /data-tone="error"/);
  assert.match(html, /<p class="empty-state-title">暂时取不到集群状态<\/p>/);
  assert.match(html, /调度器查询失败：sinfo 超时。随资源采集每 60 秒自动重试一次。/);
  assert.match(html, /<button type="button" class="btn btn-secondary" data-cl-refresh="">重试<\/button>/);
});

test("调度器从没查到数据：#clusterError 换成空状态、其余区块收起；「重试」走面板头「立即刷新」；有了旧数据回到红条", async (t) => {
  const { elements, body } = setupDom(t);
  const onRefresh = spy(async () => {});
  initClusterPanel({ onRefresh });
  renderClusterPanel(layerWith({ state: "error", reason: "sinfo 超时", nodes: [] }), { id: "s1" }, NOW);
  assert.equal(elements.clusterError.hidden, false);
  assert.equal(elements.clusterError.getAttribute("data-empty"), "true");
  assert.equal(body.getAttribute("data-no-data"), "true");
  assert.match(elements.clusterError.html, /暂时取不到集群状态/);

  await elements.clusterPanel.dispatch("click", { target: target("data-cl-refresh") });
  assert.deepEqual(onRefresh.calls, [["s1"]], "与面板头「立即刷新」同一条路径");

  renderClusterPanel(layerWith({ state: "error", reason: "sinfo 超时" }), { id: "s1" }, NOW + 1);
  assert.equal(elements.clusterError.getAttribute("data-empty"), "false");
  assert.equal(body.getAttribute("data-no-data"), "false");
  assert.equal(elements.clusterError.textContent, "调度器查询失败：sinfo 超时（下方为上次成功采集的数据）");
});

test("作业表「清除筛选」：回到全部作业、不按节点过滤（与点「全部」芯片同一份视图状态）", async (t) => {
  const { elements } = setupDom(t);
  initClusterPanel({});
  renderClusterPanel(layerWith({ jobs: [slurmJob("101", "RUNNING", "node01")] }), { id: "s1" }, NOW);
  assert.match(elements.clusterJobsBody.html, /job-101/);

  await elements.clusterPanel.dispatch("click", { target: target("data-cl-filter", "pending") });
  assert.match(elements.clusterJobsBody.html, /没有符合筛选的作业/);
  assert.match(elements.clusterJobsBody.html, /当前筛选：排队中。/);

  await elements.clusterPanel.dispatch("click", { target: target("data-cl-clear-filter") });
  assert.match(elements.clusterJobsBody.html, /job-101/);
  assert.doesNotMatch(elements.clusterJobsBody.html, /没有符合筛选的作业/);
});

test("「按作业号或日期查」：把焦点交给查询框", async (t) => {
  const { elements } = setupDom(t);
  initClusterPanel({});
  await elements.clusterPanel.dispatch("click", { target: target("data-cl-lookup-focus") });
  assert.equal(elements.clusterHistoryQuery.focused, true);
});

// ---- v2.62：失败提醒点开直接去「我的历史」 ----

test("通知定位：失败提醒（history）直接到我的历史并展开那一行的诊断，即使作业也在关注列表里；其余提醒照旧先找关注列表", async (t) => {
  const { elements } = setupDom(t);
  const focusable = () => fakeElement({ scrollIntoView() {} });
  const watchNode = focusable();
  const historyNode = focusable();
  elements.clusterJobWatch = fakeElement({ isConnected: true, querySelector: (selector) => (selector === '[data-watch-job-id="12"]' ? watchNode : null) });
  elements.clusterHistoryBody = morphable({ querySelector: (selector) => (selector === '[data-history-job-id="12"]' ? historyNode : null) });
  const diagnosis = { category: "python", headline: "KeyError: 'arm'" };
  const getJson = async (url) => {
    if (url.startsWith("/api/jobs/watch")) return { serverId: "s1", watches: [{ id: "a", label: "xp_*", auto: { rule: "name:xp_*" }, jobIds: ["12"], jobs: [] }], resources: [] };
    if (url.startsWith("/api/jobs/diagnoses")) return { items: [{ jobId: "12", serverId: "s1", name: "xp_a", state: "FAILED", exitCode: 1, endedAtMs: NOW, ...diagnosis, evidence: ["KeyError: 'arm'"], files: [], hasScript: false, source: "registry" }], groups: [{ key: "python|KeyError: 'arm'", ...diagnosis, count: 1, jobIds: ["12"] }] };
    return { state: "ok", serverId: "s1", checkedAt: NOW, snapshotId: `live-${NOW}`, summary: { ended: 1, failed: 1, completed: 0 }, rows: [{ kind: "job", id: "12", name: "xp_a", outcome: "failed", state: "FAILED", exitCode: 1, endAt: NOW, elapsedSec: 60, diagnosis }] };
  };
  const toasts = [];
  initClusterPanel({ getJson, postJson: async () => ({}), showToast: (item) => toasts.push(item), isVisible: () => true });
  renderClusterPanel(layerWith({ jobs: [slurmJob("101", "RUNNING", "node01")] }), { id: "s1" }, NOW);

  assert.equal(await focusClusterJob("12", "history"), true);
  assert.deepEqual([historyNode.focused, watchNode.focused], [true, undefined], "失败提醒不停在关注列表");
  assert.match(elements.clusterHistoryBody.html, /data-cl-diag="12" aria-expanded="true"/, "那一行的失败诊断已展开");
  assert.doesNotMatch(elements.clusterHistoryBody.html, /jw-review-row/, "不顺手打开资源复盘");
  assert.match(elements.clusterHistoryBody.html, /KeyError: &#039;arm&#039;/);

  historyNode.focused = undefined;
  assert.equal(await focusClusterJob("12"), true);
  assert.deepEqual([watchNode.focused, historyNode.focused], [true, undefined], "关注组的提醒照旧先定位到关注列表");

  // 历史里没有这条（已出 48 小时）但关注列表里有：失败提醒退回关注列表，不至于无处可去。
  elements.clusterHistoryBody.querySelector = () => null;
  watchNode.focused = undefined;
  assert.equal(await focusClusterJob("12", "history"), true);
  assert.equal(watchNode.focused, true);
  assert.equal(await focusClusterJob("999", "history"), false);
  assert.equal(toasts.at(-1).title, "作业定位");
  assert.equal(await focusClusterJob("12; rm", "history"), false, "作业号照样先过白名单");
});
