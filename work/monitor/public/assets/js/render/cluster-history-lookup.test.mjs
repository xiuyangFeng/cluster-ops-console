import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLookupBarHtml,
  buildMoreRowHtml,
  buildSegmentRowHtml,
  createLookupLoader,
  GROUP_PAGE_MAX,
  liveWindowStart,
  nextEarlierSegment,
  parseLookupInput,
} from "./cluster-history-lookup.js";
import { buildHistoryModel } from "./cluster-history-model.js";
import { buildHistoryRowsHtml, buildHistorySummaryHtml } from "./cluster-view.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-06T15:00:00+08:00");
const at = (text) => Date.parse(`${text}+08:00`);

test("查询框解析：作业号 / 单日 / 范围；省略年份取今年（落在今天之后算去年）；最多 7 天、不查未来", () => {
  const p = (text) => parseLookupInput(text, { now: NOW });
  assert.deepEqual(p(""), { kind: "none" });
  assert.deepEqual(p(" 18036 "), { kind: "job", job: "18036", label: "作业 18036" });
  assert.deepEqual(p("13207_5"), { kind: "job", job: "13207_5", label: "作业 13207_5" });
  assert.deepEqual(p("10-01"), { kind: "range", from: "2026-10-01", to: "2026-10-01", label: "10.1（周四）" });
  assert.deepEqual(p("2026.9.28 ~ 10/1"), { kind: "range", from: "2026-09-28", to: "2026-10-01", label: "9.28（周一） – 10.1（周四）" });
  assert.equal(p("09-28至10-01").to, "2026-10-01");
  assert.equal(p("12-30").from, "2025-12-30", "今年的 12-30 还没到：按去年");
  assert.equal(p("12-30").label, "2025.12.30（周二）", "不是今年的带年份");
  assert.equal(p("2025-12-30~01-02").to, "2026-01-02");
  assert.match(p("09-01~09-30").error, /最多查 7 天/);
  assert.match(p("10-03~10-01").error, /晚于/);
  assert.match(p("2026-10-07").error, /今天之后/);
  for (const bad of ["abc", "13207_[1-3]", "2026-02-30", "1;id", "10-01~10-02~10-03", "18036 18037"]) assert.ok(p(bad).error, bad);
});

const live = (extra = {}) => ({ state: "ok", checkedAt: NOW - 2 * MIN, windowHours: 48, snapshotId: `live-${NOW - 2 * MIN}`, summary: { ended: 0 }, rows: [], ...extra });

test("「更早…」的下一段：48 小时视图先补窗口起点那天的前半段，之后每次一整天；日期查询从起始日前一天；作业号没有", () => {
  const start = liveWindowStart(live());
  assert.equal(start, NOW - 2 * MIN - 48 * HOUR);
  const first = nextEarlierSegment({ liveData: live(), now: NOW });
  assert.deepEqual(first.params, { from: "2026-10-04", to: "2026-10-04", endBefore: start });
  assert.equal(first.label, "10.4（周日） 14:58 之前");
  const second = nextEarlierSegment({ liveData: live(), segments: [first], now: NOW });
  assert.deepEqual(second.params, { from: "2026-10-03", to: "2026-10-03", endBefore: null });
  assert.equal(second.label, "10.3（周六）");
  assert.deepEqual(nextEarlierSegment({ query: { kind: "range", from: "2026-09-28", to: "2026-10-01" }, now: NOW }).params.from, "2026-09-27");
  assert.equal(nextEarlierSegment({ query: { kind: "job", job: "1" }, now: NOW }), null);
  assert.equal(nextEarlierSegment({ liveData: { state: "none" }, now: NOW }), null, "还没有 48 小时数据：没有「更早」");
});

function env() {
  const calls = [];
  const pending = [];
  let changes = 0;
  const loader = createLookupLoader({
    getJson: (url) => new Promise((resolve, reject) => { calls.push(url); pending.push({ url, resolve, reject }); }),
    onChange: () => { changes += 1; },
    onLiveExpired: () => { calls.push("live-expired"); },
    now: () => NOW,
  });
  return { loader, calls, pending, changes: () => changes };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const result = (extra = {}) => ({ state: "ok", snapshotId: "qabc0001", summary: { ended: 1, completed: 1, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 }, rows: [{ kind: "job", outcome: "completed", id: "1", state: "COMPLETED", endAt: NOW - 50 * HOUR }], ...extra });

test("加载器：新查询取代在途的旧查询（迟到结果丢弃）；换服务器全部作废", async () => {
  const e = env();
  e.loader.setServer("server-01");
  e.loader.search(parseLookupInput("10-01", { now: NOW }));
  e.loader.search(parseLookupInput("18036", { now: NOW }));
  assert.deepEqual(e.calls, [
    "/api/jobs/lookup?serverId=server-01&from=2026-10-01&to=2026-10-01",
    "/api/jobs/lookup?serverId=server-01&job=18036",
  ]);
  e.pending[1].resolve(result({ snapshotId: "qnew00001" }));
  await flush();
  e.pending[0].resolve(result({ snapshotId: "qold00001" }));
  await flush();
  const state = e.loader.state();
  assert.equal(state.query.kind, "job");
  assert.equal(state.segments.length, 1);
  assert.equal(state.segments[0].data.snapshotId, "qnew00001", "迟到的旧查询没有覆盖新查询");

  e.loader.search(parseLookupInput("10-02", { now: NOW }));
  e.loader.setServer("server-02");
  e.pending[2].resolve(result({ snapshotId: "qsrv10001" }));
  await flush();
  assert.equal(e.loader.state().query, null);
  assert.deepEqual(e.loader.state().segments, []);
});

test("加载器：更早…逐段追加（有段在加载时不叠加）；失败可重试；回到近 48 小时清掉回查", async () => {
  const e = env();
  e.loader.setServer("server-01");
  e.loader.loadEarlier(live());
  e.loader.loadEarlier(live());
  assert.equal(e.calls.length, 1, "上一段还没回来：不叠加");
  assert.match(e.calls[0], /from=2026-10-04&to=2026-10-04&endBefore=\d+$/);
  e.pending[0].reject(Object.assign(new Error("HTTP 429"), { status: 429, serverMessage: "上一次查询还没结束，请稍后再试" }));
  await flush();
  assert.equal(e.loader.state().segments[0].error, "上一次查询还没结束，请稍后再试");
  e.loader.retry(e.loader.state().segments[0].key);
  e.pending[1].resolve(result());
  await flush();
  e.loader.loadEarlier(live());
  assert.match(e.calls[2], /from=2026-10-03&to=2026-10-03$/);
  e.loader.backToLive();
  assert.deepEqual(e.loader.state().segments, []);
});

test("加载器：组内加载更多绑定快照；48 小时快照换代（409）→ 通知重读，并按新快照同样条数重取", async () => {
  const e = env();
  e.loader.setServer("server-01");
  e.loader.loadGroup("live-100", "COMPLETED|cfa-agiter20", 150);
  assert.equal(e.calls[0], "/api/jobs/group?serverId=server-01&snapshot=live-100&key=COMPLETED%7Ccfa-agiter20&limit=150");
  e.pending[0].reject(Object.assign(new Error("HTTP 409"), { status: 409 }));
  await flush();
  assert.equal(e.calls[1], "live-expired");
  const [entry] = [...e.loader.state().extras.values()];
  assert.equal(entry.expired, true);
  e.loader.syncLive("live-200");
  assert.equal(e.calls[2], "/api/jobs/group?serverId=server-01&snapshot=live-200&key=COMPLETED%7Ccfa-agiter20&limit=150");
  e.pending[1].resolve({ snapshotId: "live-200", key: "COMPLETED|cfa-agiter20", total: 600, children: [{ id: "9" }], more: 450 });
  await flush();
  const [fresh] = [...e.loader.state().extras.values()];
  assert.deepEqual([fresh.snapshotId, fresh.more, fresh.children.length, fresh.error], ["live-200", 450, 1, ""]);
  // 回查快照：新查询后迟到的分页结果丢弃
  e.loader.loadGroup("qabc0001", "FAILED|xp", 100);
  e.loader.search(parseLookupInput("10-01", { now: NOW }));
  e.pending[2].resolve({ snapshotId: "qabc0001", key: "FAILED|xp", total: 3, children: [], more: 0 });
  await flush();
  assert.equal([...e.loader.state().extras.keys()].some((k) => k.startsWith("qabc0001")), false);
});

const group = (key, count, children, more) => ({
  kind: "group", outcome: "completed", key, state: "COMPLETED", label: "cfa-agiter20-*", count, stages: [], firstEndAt: NOW - HOUR, lastEndAt: NOW - HOUR,
  elapsedMinSec: 60, elapsedMaxSec: 60, nodeLists: ["node01"], partitions: ["CPU"], exits: [], children, more,
});
const child = (id) => ({ kind: "job", outcome: "completed", id, name: "cfa-agiter20-35607b-cfd1", state: "COMPLETED", exitCode: 0, endAt: NOW - HOUR, elapsedSec: 60, nodes: "node01", partition: "CPU" });

test("模型：组内「再显示 N 个」带快照游标；取回的成员替换组内带回的那几条；到上限后提示用作业号查询", () => {
  const data = live({ summary: { ended: 600, completed: 600, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 }, rows: [group("COMPLETED|cfa-agiter20", 600, [child("1"), child("2")], 598)] });
  const expanded = new Set(["COMPLETED|cfa-agiter20"]);
  const base = buildHistoryModel({ data, now: NOW, view: { expanded } });
  const more = base.rows.at(-1);
  assert.deepEqual([more.kind, more.text, more.action], ["more", "还有 598 个", { snapshot: data.snapshotId, group: "COMPLETED|cfa-agiter20", limit: 102, label: "再显示 100 个" }]);
  const html = buildHistoryRowsHtml(base.rows);
  assert.match(html, /还有 598 个 <button type="button" class="text-btn cl-group-more-btn" data-cl-group-more="live-\d+" data-cl-group-key="COMPLETED\|cfa-agiter20" data-cl-group-limit="102">再显示 100 个<\/button><\/td><\/tr>$/);

  const extras = new Map([[`${data.snapshotId}\u0000COMPLETED|cfa-agiter20`, { snapshotId: data.snapshotId, key: "COMPLETED|cfa-agiter20", children: Array.from({ length: GROUP_PAGE_MAX }, (_, i) => child(String(i + 10))), more: 3 }]]);
  const loaded = buildHistoryModel({ data, now: NOW, view: { expanded }, lookup: { query: null, segments: [], extras } });
  assert.equal(loaded.rows.filter((r) => r.child).length, GROUP_PAGE_MAX);
  assert.equal(loaded.rows.at(-1).action, null);
  assert.match(loaded.rows.at(-1).text, /组内最多显示 1,000 个，其余用作业号查询/);

  const old = buildHistoryModel({ data: { ...data, snapshotId: undefined }, now: NOW, view: { expanded } });
  assert.equal(old.rows.at(-1).text, "还有 598 个…", "旧后端没有快照标识：保持原样");
});

test("模型：查询模式换掉表格与汇总条标签；空结果写明口径；更早的段带段头接在后面", () => {
  const query = parseLookupInput("09-28~10-01", { now: NOW });
  const main = { key: "r:2026-09-28:2026-10-01", params: { from: "2026-09-28", to: "2026-10-01" }, label: query.label, data: result({ fetchedAt: NOW - 3 * MIN, source: "ssh", cached: false, coverage: { keptFrom: null } }), loading: false, error: "" };
  const day = { key: "d:2026-09-27", params: { from: "2026-09-27", to: "2026-09-27", endBefore: null }, label: "9.27（周日）", data: result({ snapshotId: "qday00001", summary: { ended: 3, completed: 1, failed: 2, cancelled: 0, other: 0, running: 0, pending: 0 } }), loading: false, error: "" };
  const m = buildHistoryModel({ data: live(), now: NOW, lookup: { query, segments: [main, day], extras: new Map() } });
  assert.equal(m.summary.label, "9.28（周一） – 10.1（周四）");
  assert.equal(m.summary.fresh, "查询于 今天 14:57");
  assert.match(buildHistorySummaryHtml(m.summary), /^<span class="cl-mine-label">9\.28（周一） – 10\.1（周四）<\/span>/);
  assert.deepEqual(m.rows.map((r) => r.kind), ["job", "segment", "job"]);
  assert.deepEqual([m.rows[1].label, m.rows[1].text], ["9.27（周日）", "3 个已结束 · 2 失败 / 超时"]);
  assert.deepEqual(m.filters.map((f) => f.count), [4, 2, 2], "芯片计数含已加载的段");
  assert.equal(m.lookupBar.text, "按结束时间：9.28（周一） – 10.1（周四） · 已往前加载到 9.27（周日）");
  assert.equal(m.lookupBar.earlier.label, "更早…");
  assert.match(buildLookupBarHtml(m.lookupBar), /data-cl-lookup-earlier="1" title="加载 9\.26（周六） 结束的作业/);
  assert.match(buildHistoryRowsHtml(m.rows), /<tr class="cl-hist-seg" data-segment="d:2026-09-27"><td class="cl-hist-seg-cell" colspan="6"><span class="cl-hist-seg-label">9\.27（周日）<\/span><span class="cl-hist-seg-text">3 个已结束 · 2 失败 \/ 超时<\/span><\/td><\/tr>/);

  const empty = (data, q = query) => buildHistoryModel({ data: live(), now: NOW, lookup: { query: q, segments: [{ ...main, data }], extras: new Map() } }).emptyText;
  assert.match(empty(result({ summary: { ended: 0 }, rows: [] })), /这段日期没有已结束的作业（能查多早取决于集群记账的保留期限）/);
  const jobQ = parseLookupInput("18036", { now: NOW });
  assert.match(empty(result({ summary: { ended: 0 }, rows: [] }), jobQ), /没有查到作业 18036（不是当前用户的作业，或已超出集群记账的保留期限）/);
  assert.match(empty(result({ summary: { ended: 0, running: 1 }, rows: [] }), jobQ), /还在运行或排队/);
  // 查无结果：空状态（搜索图标，标题里写查的是什么）；作业还在队列里仍是一句指路的话。
  const emptyState = (data, q = query) => buildHistoryModel({ data: live(), now: NOW, lookup: { query: q, segments: [{ ...main, data }], extras: new Map() } }).emptyState;
  const rangeState = emptyState(result({ summary: { ended: 0 }, rows: [] }));
  assert.equal(rangeState.icon, "search");
  assert.equal(rangeState.title, "9.28（周一） – 10.1（周四）没有已结束的作业");
  assert.equal(rangeState.body, "能查多早取决于集群记账的保留期限。");
  const jobState = emptyState(result({ summary: { ended: 0 }, rows: [] }), jobQ);
  assert.equal(jobState.title, "没有查到作业 18036");
  assert.match(buildHistoryRowsHtml([], jobState), /<p class="empty-state-title">没有查到作业 18036<\/p>/);
  assert.equal(emptyState(result({ summary: { ended: 0, running: 1 }, rows: [] }), jobQ), null);
  assert.equal(buildHistoryModel({ data: live(), now: NOW, lookup: { query, segments: [{ ...main, data: null, loading: true }], extras: new Map() } }).emptyState, null, "查询中不是空状态");
  assert.equal(buildHistoryModel({ data: live(), now: NOW, lookup: { query, segments: [{ ...main, data: null, loading: true }], extras: new Map() } }).emptyText, "正在查询9.28（周一） – 10.1（周四）…");
  assert.equal(buildHistoryModel({ data: live(), now: NOW, lookup: { query, segments: [{ ...main, data: null, error: "HTTP 500" }], extras: new Map() } }).emptyText, "查询失败：HTTP 500");
});

test("模型：48 小时视图接上更早的段；没取全写明覆盖到哪里；窗口后移给出补齐", () => {
  const data = live({ summary: { ended: 1, completed: 1, failed: 0, cancelled: 0, other: 0, running: 0, pending: 0 }, rows: [child("100")] });
  const first = nextEarlierSegment({ liveData: data, now: NOW });
  const seg = { ...first, data: result({ truncated: true, coverage: { keptFrom: at("2026-10-04T08:00:00") } }), loading: false, error: "" };
  const m = buildHistoryModel({ data, now: NOW, lookup: { query: null, segments: [seg], extras: new Map() } });
  assert.equal(m.summary.label, undefined, "默认视图汇总条仍是「近 48 小时」");
  assert.deepEqual(m.rows.map((r) => r.kind), ["job", "segment", "job"]);
  assert.equal(m.rows[1].text, "1+ 个已结束（记录过多，只取到 10.4 08:00 之后提交的部分）");
  assert.equal(m.lookupBar.gap, "");
  const later = buildHistoryModel({ data: { ...data, checkedAt: data.checkedAt + 6 * MIN }, now: NOW + 6 * MIN, lookup: { query: null, segments: [seg], extras: new Map() } });
  assert.equal(later.lookupBar.gap, "近 48 小时窗口已后移 6 分钟，这段时间结束的作业未列出");
  assert.match(buildLookupBarHtml(later.lookupBar), /data-cl-lookup-refill="1">补齐<\/button>/);
  const noLookup = buildHistoryModel({ data, now: NOW });
  assert.deepEqual(noLookup.lookupBar.earlier, { label: "更早…", disabled: false, title: "加载 10.4（周日） 14:58 之前 结束的作业（每次一天，一次只读 sacct 查询）" });
});

test("HTML：段头的重试、加载中的按钮禁用、错误文字都转义", () => {
  assert.match(buildSegmentRowHtml({ key: "d:x", label: "<b>", text: "查询失败：<x>", retry: "d:x" }, 6), /&lt;b&gt;.*查询失败：&lt;x&gt;.*data-cl-lookup-retry="d:x">重试<\/button>/);
  assert.match(buildMoreRowHtml({ rowKind: "done", parent: "p", text: "还有 3 个", action: { snapshot: "q1", group: "A|<b>", limit: 103, label: "再显示 3 个" }, loading: true, error: "<e>" }, 6), /data-cl-group-key="A\|&lt;b&gt;" data-cl-group-limit="103" disabled>加载中…<\/button> <span class="cl-diag-muted">&lt;e&gt;<\/span>/);
  assert.equal(buildLookupBarHtml({ visible: false }), "");
});
