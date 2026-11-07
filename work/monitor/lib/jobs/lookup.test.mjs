import assert from "node:assert/strict";
import test from "node:test";

import {
  createJobsLookup,
  filterRangeJobs,
  LOOKUP_CACHE_ENTRIES_MAX,
  LOOKUP_CACHE_TTL_MS,
  LOOKUP_KEEP_MS,
  LOOKUP_RECENT_TTL_MS,
  LOOKUP_SNAPSHOT_RE,
  localJobMatch,
  parseLookupQuery,
  remoteDayOf,
} from "./lookup.mjs";
import { createJobsService } from "./service.mjs";

const NOW = Date.UTC(2026, 9, 6, 7, 0, 0); // 北京时间 10.6 15:00
const CONFIG = { servers: [{ id: "server-01", host: "myserver", source: "team" }, { id: "server-02", host: "other", source: "team" }] };
const HEADER = "now=1791270000\ntz=+0800\nuser=kai\n";

const q = (params) => parseLookupQuery(params, { now: NOW });

test("参数校验：作业号 / 日期范围，两类不能混用；范围最多 7 天、不能在未来、日期必须真实", () => {
  assert.deepEqual(q({ job: "18036" }), { query: { kind: "job", job: "18036" } });
  assert.deepEqual(q(new URLSearchParams("job=13207_5")), { query: { kind: "job", job: "13207_5" } });
  assert.deepEqual(q({ from: "2026-09-30", to: "2026-10-06" }), { query: { kind: "range", from: "2026-09-30", to: "2026-10-06", endBefore: null } });
  assert.deepEqual(q({ from: "2026-10-04", to: "2026-10-04", endBefore: "1791100000000" }).query.endBefore, 1791100000000);
  // 远端时区可能比本机靠东：UTC 17:00 时 UTC+14 已是第二天，不误拒。
  assert.equal(parseLookupQuery({ from: "2026-10-07", to: "2026-10-07" }, { now: Date.UTC(2026, 9, 6, 17) }).query.to, "2026-10-07");
  for (const bad of [
    {},
    { job: "18036", from: "2026-10-01", to: "2026-10-01" },
    { job: "abc" },
    { job: "13207_[1-3]" },
    { job: "1".repeat(13) },
    { job: "1;id" },
    { from: "2026-10-01" },
    { from: "2026-02-30", to: "2026-03-01" },
    { from: "2026/10/01", to: "2026-10-01" },
    { from: "2026-10-03", to: "2026-10-01" },
    { from: "2026-09-29", to: "2026-10-06" },
    { from: "1999-12-31", to: "1999-12-31" },
    { from: "2026-10-07", to: "2026-10-07" },
    { from: "2026-10-01", to: "2026-10-01", endBefore: "-1" },
    { from: "2026-10-01", to: "2026-10-01", endBefore: "1e12" },
  ]) assert.ok(q(bad).error, JSON.stringify(bad));
});

const job = (id, { endAt, state = "COMPLETED", name = "cfdauto-run", submitAt = endAt ? endAt - 3_600_000 : NOW, exitCode = 0 } = {}) => ({
  id, name, state, stateRaw: state, exitCode, signal: 0, submitAt, startAt: submitAt, endAt: endAt ?? null, elapsedSec: 3600, nodes: "node01", partition: "CPU",
});
const at = (text) => Date.parse(`${text}+08:00`); // 北京时间

test("范围归段：按远端本地日期的结束日、早于 endBefore；未结束的不列；tz 未知时只按 endBefore 切", () => {
  const jobs = [
    job("1", { endAt: at("2026-10-03T00:10:00") }),
    job("2", { endAt: at("2026-10-02T23:50:00") }), // 前一天结束（sacct 窗口里会带出来）
    job("3", { endAt: at("2026-10-04T01:00:00") }), // 窗口里开始、第二天结束
    job("4", { state: "RUNNING" }),
    job("5", { endAt: at("2026-10-03T20:00:00") }),
  ];
  assert.equal(remoteDayOf(at("2026-10-03T00:10:00"), 480), "2026-10-03");
  assert.deepEqual(filterRangeJobs(jobs, { from: "2026-10-03", to: "2026-10-03" }, 480).map((j) => j.id), ["1", "5"]);
  assert.deepEqual(filterRangeJobs(jobs, { from: "2026-10-03", to: "2026-10-03", endBefore: at("2026-10-03T12:00:00") }, 480).map((j) => j.id), ["1"]);
  assert.deepEqual(filterRangeJobs(jobs, { from: "2026-10-03", to: "2026-10-03" }, null).map((j) => j.id), ["1", "2", "3", "5"]);
});

test("作业号本地命中：快照里正好有它才用本机；查数组本体而快照只有部分任务 → 去远端查全", () => {
  const snapshot = { state: "ok", jobs: [job("18036", { endAt: NOW - 1000 }), job("13207_4", { endAt: NOW - 1000 })] };
  assert.deepEqual(localJobMatch(snapshot, "18036").map((j) => j.id), ["18036"]);
  assert.deepEqual(localJobMatch(snapshot, "13207_4").map((j) => j.id), ["13207_4"]);
  assert.equal(localJobMatch(snapshot, "13207"), null);
  assert.equal(localJobMatch(snapshot, "99"), null);
  assert.equal(localJobMatch({ state: "error", jobs: [] }, "18036"), null);
});

function sacctLine(j) {
  const ts = (ms) => (ms == null ? "Unknown" : new Date(ms + 8 * 3_600_000).toISOString().slice(0, 19));
  return `job=${j.id}|${j.name}|${j.state}|${j.exitCode}:0|${ts(j.submitAt)}|${ts(j.startAt)}|${ts(j.endAt)}|01:00:00|node01|CPU`;
}

function harness({ stdout = null, config = CONFIG, snapshot = null, diagnoses = {}, clock = { t: NOW }, gate = null } = {}) {
  const calls = [];
  const slots = [];
  let cfg = config;
  const lookup = createJobsLookup({
    getConfig: async () => cfg,
    execCollector: async (invocation, server) => {
      calls.push({ invocation, server });
      if (gate) await gate.promise;
      const out = typeof stdout === "function" ? stdout(invocation) : stdout;
      if (out instanceof Error) throw out;
      return { code: 0, stdout: out, stderr: "" };
    },
    probeSshFailureReason: (code) => `ssh-reason ${code}`,
    getSnapshot: () => snapshot,
    diagnosisOf: (serverId, jobId) => diagnoses[`${serverId}/${jobId}`] || null,
    now: () => clock.t,
  });
  const acquireSshSlot = async (options) => {
    slots.push({ ...options, released: false });
    const slot = slots.at(-1);
    return () => { slot.released = true; };
  };
  return { lookup, calls, slots, acquireSshSlot, setConfig: (next) => { cfg = next; } };
}

const DAY_OUT = [
  HEADER,
  "state=ok\nrows=5\n",
  ...[
    job("17001", { endAt: at("2026-10-03T09:00:00"), name: "cfa-agiter20-35607b-cfd1" }),
    job("17002", { endAt: at("2026-10-03T09:10:00"), name: "cfa-agiter20-35608c-cfd1" }),
    job("17003", { endAt: at("2026-10-03T09:20:00"), name: "cfa-agiter20-35609d-cfd1" }),
    job("17004", { endAt: at("2026-10-03T10:00:00"), state: "FAILED", exitCode: 1, name: "xp_train" }),
    job("17005", { endAt: at("2026-10-04T02:00:00") }),
  ].map(sacctLine).join("\n"),
  "\n",
].join("");

test("范围回查：经全局 SSH 槽位发一次、用完释放；结果冻结成 q… 快照；同一查询再来直接用缓存", async () => {
  const h = harness({ stdout: DAY_OUT, diagnoses: { "server-01/17004": { category: "python", headline: "KeyError: 'arm'" } } });
  const query = q({ from: "2026-10-03", to: "2026-10-03" }).query;
  const first = await h.lookup.lookup("server-01", query, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].invocation.input, /-S 2026-10-03T00:00:00 -E 2026-10-03T23:59:59 -o /);
  assert.deepEqual(h.slots.map((s) => [s.hostKey, s.released]), [["myserver", true]]);
  assert.equal(first.state, "ok");
  assert.equal(first.windowHours, null);
  assert.equal(first.source, "ssh");
  assert.equal(first.cached, false);
  assert.match(first.snapshotId, LOOKUP_SNAPSHOT_RE);
  assert.ok(first.snapshotId.startsWith("q"));
  assert.deepEqual(first.summary, { ended: 4, completed: 3, failed: 1, cancelled: 0, other: 0, running: 0, pending: 0 }, "10.4 结束的 17005 不归这一天");
  assert.deepEqual(first.coverage, { kind: "range", from: "2026-10-03", to: "2026-10-03", endBefore: null, keptFrom: null, rowsTotal: 5, tzKnown: true });
  const failedRow = first.rows.find((r) => r.id === "17004");
  assert.deepEqual(failedRow.diagnosis, { category: "python", headline: "KeyError: 'arm'" }, "只读挂上已有诊断");
  const second = await h.lookup.lookup("server-01", query, { acquireSshSlot: h.acquireSshSlot });
  assert.equal(h.calls.length, 1, "缓存命中不再发 SSH");
  assert.equal(second.cached, true);
  assert.equal(second.snapshotId, first.snapshotId);
});

test("缓存期限：全是过去的日期 10 分钟；含今天 / 作业号 1 分钟；过期后重查换新快照，旧快照仍可分页", async () => {
  const clock = { t: NOW };
  const h = harness({ stdout: DAY_OUT, clock });
  const past = q({ from: "2026-10-03", to: "2026-10-03" }).query;
  const today = q({ from: "2026-10-06", to: "2026-10-06" }).query;
  const a = await h.lookup.lookup("server-01", past);
  await h.lookup.lookup("server-01", today);
  clock.t += LOOKUP_RECENT_TTL_MS + 1;
  await h.lookup.lookup("server-01", past);
  await h.lookup.lookup("server-01", today);
  assert.equal(h.calls.length, 3, "含今天的过了 1 分钟重查，过去的还在缓存里");
  clock.t = NOW + LOOKUP_CACHE_TTL_MS + 1;
  const b = await h.lookup.lookup("server-01", past);
  assert.equal(h.calls.length, 4);
  assert.notEqual(b.snapshotId, a.snapshotId);
  const page = await h.lookup.groupPage("server-01", a.snapshotId, "COMPLETED|cfa-agiter20", { limit: 2 });
  assert.equal(page.expired, undefined, "旧快照在保留期内仍能分页");
});

test("组内分页：同一快照里按组取前 limit 条；跨服务器 / 过期 / live 快照换代 → expired", async () => {
  const clock = { t: NOW };
  const live = { state: "ok", checkedAt: NOW - 60_000, user: "kai", jobs: [job("18001", { endAt: NOW - 1000, name: "scr3_1" }), job("18002", { endAt: NOW - 2000, name: "scr3_2" })] };
  const h = harness({ stdout: DAY_OUT, clock, snapshot: live });
  const res = await h.lookup.lookup("server-01", q({ from: "2026-10-03", to: "2026-10-03" }).query);
  const page = await h.lookup.groupPage("server-01", res.snapshotId, "COMPLETED|cfa-agiter20", { limit: 2 });
  assert.deepEqual([page.total, page.more, page.children.map((c) => c.id)], [3, 1, ["17003", "17002"]]);
  assert.deepEqual(await h.lookup.groupPage("server-02", res.snapshotId, "COMPLETED|cfa-agiter20", { limit: 2 }), { expired: true }, "别的服务器拿不到这份快照");
  const livePage = await h.lookup.groupPage("server-01", `live-${NOW - 60_000}`, "COMPLETED|scr3", { limit: 10 });
  assert.deepEqual(livePage.children.map((c) => c.id), ["18001", "18002"]);
  assert.deepEqual(await h.lookup.groupPage("server-01", `live-${NOW - 360_000}`, "COMPLETED|scr3", { limit: 10 }), { expired: true }, "上一轮采集的快照标识已失效");
  clock.t += LOOKUP_KEEP_MS + 1;
  assert.deepEqual(await h.lookup.groupPage("server-01", res.snapshotId, "COMPLETED|cfa-agiter20", { limit: 2 }), { expired: true });
  assert.equal(h.lookup.size(), 0);
});

test("作业号：近 48 小时快照里有 → 0 SSH；数组本体 → 去远端查全部任务", async () => {
  const live = { state: "ok", checkedAt: NOW - 60_000, user: "kai", jobs: [job("18036", { endAt: NOW - 1000 }), job("13207_4", { endAt: NOW - 1000 })] };
  const h = harness({ snapshot: live, stdout: `${HEADER}state=ok\nrows=2\n${sacctLine(job("13207_0", { endAt: at("2026-09-09T11:15:41") }))}\n${sacctLine(job("13207_4", { endAt: at("2026-09-09T11:15:39") }))}\n` });
  const local = await h.lookup.lookup("server-01", { kind: "job", job: "18036" });
  assert.equal(h.calls.length, 0);
  assert.equal(local.source, "local");
  assert.deepEqual(local.rows.map((r) => r.id), ["18036"]);
  const array = await h.lookup.lookup("server-01", { kind: "job", job: "13207" });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].invocation.input, / -j 13207 -o /);
  assert.equal(array.source, "ssh");
  assert.equal(array.summary.ended, 2);
});

test("同一查询并发只发一次；每台服务器最多 2 个在途，再来回 busy", async () => {
  let open;
  const gate = { promise: new Promise((resolve) => { open = resolve; }) };
  const h = harness({ stdout: DAY_OUT, gate });
  const a1 = h.lookup.lookup("server-01", q({ from: "2026-10-01", to: "2026-10-01" }).query);
  const a2 = h.lookup.lookup("server-01", q({ from: "2026-10-01", to: "2026-10-01" }).query);
  const b = h.lookup.lookup("server-01", q({ from: "2026-10-02", to: "2026-10-02" }).query);
  assert.deepEqual(await h.lookup.lookup("server-01", q({ from: "2026-09-30", to: "2026-09-30" }).query), { busy: true });
  const other = h.lookup.lookup("server-02", q({ from: "2026-09-30", to: "2026-09-30" }).query);
  open();
  const [r1, r2] = await Promise.all([a1, a2, b, other]);
  assert.equal(r1.snapshotId, r2.snapshotId);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.calls.map((c) => c.server.id), ["server-01", "server-01", "server-02"]);
});

test("失败不进缓存；查询在途期间关模块 → 结果作废；不在采集范围的服务器不发 SSH", async () => {
  const fail = harness({ stdout: "" });
  const r = await fail.lookup.lookup("server-01", q({ from: "2026-10-01", to: "2026-10-01" }).query);
  assert.deepEqual([r.state, r.snapshotId], ["error", null]);
  assert.match(r.reason, /作业查询失败 \(ssh-reason 0\)/);
  await fail.lookup.lookup("server-01", q({ from: "2026-10-01", to: "2026-10-01" }).query);
  assert.equal(fail.calls.length, 2, "失败结果不缓存");

  let open;
  const gate = { promise: new Promise((resolve) => { open = resolve; }) };
  const late = harness({ stdout: DAY_OUT, gate });
  const pending = late.lookup.lookup("server-01", q({ from: "2026-10-03", to: "2026-10-03" }).query);
  await new Promise((resolve) => setImmediate(resolve));
  late.setConfig({ ...CONFIG, modules: { jobs: false } });
  open();
  const res = await pending;
  assert.equal(res.state, "none");
  assert.equal(late.lookup.size(), 0);

  const personal = harness({ stdout: DAY_OUT, config: { servers: [{ id: "server-me", host: "mine", source: "personal" }] } });
  const none = await personal.lookup.lookup("server-me", q({ from: "2026-10-03", to: "2026-10-03" }).query);
  assert.equal(none.state, "none");
  assert.equal(personal.calls.length, 0);
});

test("超过远端上限：truncated + 实际覆盖到的最早提交时刻", async () => {
  const lines = [job("17010", { endAt: at("2026-10-03T09:00:00") }), job("17011", { endAt: at("2026-10-03T10:00:00") })].map(sacctLine).join("\n");
  const h = harness({ stdout: `${HEADER}state=ok\nrows=9000\n${lines}\n` });
  const res = await h.lookup.lookup("server-01", q({ from: "2026-10-03", to: "2026-10-03" }).query);
  assert.equal(res.truncated, true);
  assert.equal(res.coverage.keptFrom, at("2026-10-03T08:00:00"));
  assert.equal(res.coverage.rowsTotal, 9000);
});

test("缓存有界：条目数封顶，先丢最久没访问的", async () => {
  const clock = { t: NOW };
  const h = harness({ stdout: DAY_OUT, clock });
  for (let i = 0; i < LOOKUP_CACHE_ENTRIES_MAX + 3; i += 1) {
    clock.t += 1;
    const day = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
    await h.lookup.lookup("server-01", q({ from: day, to: day }).query);
  }
  assert.equal(h.lookup.size(), LOOKUP_CACHE_ENTRIES_MAX);
});

test("服务层：回查不进定期快照、不取证（旧失败作业不发取证 SSH）", async () => {
  const calls = [];
  const service = createJobsService({
    getConfig: async () => CONFIG,
    execCollector: async (invocation) => { calls.push(invocation); return { code: 0, stdout: DAY_OUT, stderr: "" }; },
    probeSshFailureReason: () => "x",
    now: () => NOW,
  });
  const res = await service.lookupHistory("server-01", q({ from: "2026-10-03", to: "2026-10-03" }).query, {});
  assert.equal(res.summary.failed, 1);
  assert.equal(calls.length, 1, "只有回查本身这一次 SSH，没有取证");
  assert.equal(service.getSnapshot("server-01"), null, "定期快照不受影响（简报 / 提醒读的是它）");
  assert.deepEqual((await service.listDiagnoses("server-01")).items, []);
  const page = await service.historyGroupPage("server-01", res.snapshotId, "COMPLETED|cfa-agiter20", { limit: 1 });
  assert.deepEqual([page.total, page.children.length, page.more], [3, 1, 2]);
});
