// 2026-10-12 独立审查复现的缺陷，每条一例（编号沿用审查清单）。SSH 是桩，但桩按远端脚本的真实行为建模：
// 每个被采样、日志可读的作业都回一条 progress 与一条 subruns（从本机给的游标起读 stdout 里的 LAUNCH / END，每轮至多 300 条）。
import assert from "node:assert/strict";
import test from "node:test";

import { FORENSICS_REMOTE_COMMAND } from "./forensics.mjs";
import { createJobsService } from "./service.mjs";
import * as subrunStore from "./subrun-store.mjs";
import { AUTO_MAX_JOBS } from "./watch-rules.mjs";
import { AUTO_NOTIFY_GAP_MS, createJobWatchService } from "./watch-service.mjs";
import { WATCH_REMOTE_COMMAND } from "./watch-scan.mjs";
import { createJobWatchStore } from "./watch-store.mjs";

const NOW = 1791200000000;
const MIN = 60000;
const FAILED = new Set(["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"]);
const EVENT_BYTES = 40;
const stampOf = (ms) => `${new Date(ms + 8 * 3600000).toISOString().slice(0, 19)}+0800`;

function job(id, state = "RUNNING", { name = `job_${id}`, at = null, elapsedMin = 10, exitCode = state === "FAILED" ? 1 : 0, submitAt = NOW - 3600000 } = {}) {
  return { id, name, state, exitCode, submitAt, startAt: state === "PENDING" ? null : NOW - 3600000, endAt: at, elapsedSec: state === "PENDING" ? 0 : elapsedMin * 60 };
}

function harness({ initial = [], serverId = "s1" } = {}) {
  let clock = NOW;
  let jobs = initial;
  let truncated = false;
  let config = { servers: [{ id: serverId, host: "cluster" }] };
  const logs = new Map(); // 作业号 → { mt, sz }：日志可读的作业
  const stdout = new Map(); // 作业号 → [[L|E, run, 退出码, 时刻]]：编排型作业 stdout 里的事件；没有 = 普通作业
  const cids = new Map(); // 作业号 → stdout 的文件身份（换了 = 文件被替换）
  const bigAtFirst = new Set(); // 首次读取时 stdout 已很大的作业：远端只从末尾读，标 head 缺口
  const bases = new Map(); // 作业号 → 事件之前已有多少字节的普通输出（事件的偏移从这里起算）
  const lostFinals = new Set(); // 收尾读取没回来的作业（远端预算用完之类）
  const calls = [];
  const store = createJobWatchStore({ now: () => clock });
  const snapshot = () => ({ state: "ok", user: "me", checkedAt: clock, truncated, jobs });
  // 远端 job-subruns.py 的行为：游标身份对得上就从偏移续读，否则从头；每轮每个作业至多 300 条事件。
  const subruns = (id, cur) => {
    const events = stdout.get(id) || [];
    const base = bases.get(id) ?? 0;
    const size = events.length ? base + events.length * EVENT_BYTES : logs.get(id).sz;
    const cid = cids.get(id) ?? `7:${id.replace(/\D/g, "")}`;
    const head = !cur && bigAtFirst.has(id);
    const from = head ? size : cur && cur.cid === cid && cur.off <= size ? cur.off : 0;
    const ev = events.map(([type, run, code, at], i) => [base + i * EVENT_BYTES, stampOf(at), type, run, "train", type === "E" ? code : null]).filter((e) => e[0] >= from).slice(0, 300);
    const off = events.length && ev.length === 300 ? ev.at(-1)[0] + EVENT_BYTES : size;
    return JSON.stringify({ k: "subruns", id, p: `/logs/${id}.log`, cid, from, off, sz: size, mt: clock / 1000 - 30, gap: head ? "head" : cur && cur.cid !== cid ? "replaced" : null, more: off < size, ev, logs: [], rn: clock / 1000 });
  };
  const service = createJobWatchService({
    store, getConfig: async () => config, getSnapshot: () => snapshot(), now: () => clock,
    registry: { lookup: (_serverId, id) => ({ jobId: id, user: "me", stdout: `/logs/${id}.log`, workDir: "/logs" }) },
    execCollector: async (inv) => {
      const payload = JSON.parse(inv.input.split("\n")[1]);
      calls.push(payload);
      const lines = [];
      for (const j of payload.jobs) {
        if (!logs.has(j.id)) continue;
        lines.push(JSON.stringify({ k: "progress", id: j.id, remoteNow: clock / 1000, files: [{ p: `/logs/${j.id}.log`, mt: logs.get(j.id).mt / 1000, sz: logs.get(j.id).sz, t: "step 1" }] }));
        if (j.orch) lines.push(subruns(j.id, j.orch.cur));
      }
      for (const f of payload.orchFinal) if (!lostFinals.has(f.id)) lines.push(subruns(f.id, f.cur).replace('"k":"subruns"', '"k":"subruns-final"'));
      for (const id of payload.resourceIds) lines.push(JSON.stringify({ k: "resource", id, rows: [{ id, cpus: "2", elapsed: "100", totalCpu: "00:02:00", maxRss: "1024K" }] }));
      return { code: 0, stdout: lines.join("\n") };
    },
    isFailure: (j) => FAILED.has(j.state) && /^\d+(?:_\d+)?$/.test(j.id),
    // 与 jobs 服务注入的同一个约定：给了结束时刻就只认那一次失败的诊断。
    diagnosisOf: () => null,
  });
  return {
    store, service, calls, logs, stdout, cids, bigAtFirst, bases, lostFinals, snapshot, serverId,
    now: () => clock,
    time: (v) => { clock = v; },
    jobs: (v) => { jobs = v; },
    config: (v) => { config = v; },
    truncated: (v) => { truncated = v; },
    scan: () => service.scan(serverId, snapshot()),
    round: async (minutes, next = null) => { clock = NOW + minutes * MIN; if (next) jobs = next; await service.scan(serverId, snapshot()); },
    notices: async (kind = null) => (await service.view()).notifications.filter((n) => !kind || n.kind === kind),
    watches: async () => (await service.view(serverId)).watches,
    rules: (patch) => service.change(serverId, { action: "rules", ...patch }),
    // 让一批作业的日志「在长」：每轮都有新内容，不会被判成停滞。
    touch: (ids) => { for (const id of ids) logs.set(id, { mt: clock, sz: (logs.get(id)?.sz ?? 0) + 100 }); },
    queue: (entries) => ({ state: "ok", user: "me", jobs: entries.map(([id, name, elapsedSec, timeLimitSec]) => ({ ...job(id, "RUNNING", { name }), user: "me", elapsedSec, timeLimitSec })) }),
  };
}

// ---- 1. 子任务状态存储 ----

test("审查 1a：手动关注的编排作业结束后，子任务明细不被自动关注的普通作业挤掉", async () => {
  const plain = Array.from({ length: 45 }, (_, i) => String(101 + i));
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_manual" }), ...plain.map((id) => job(id, "RUNNING", { name: `plain_${id}` }))] });
  h.stdout.set("1", [["L", "A_s1", null, NOW - 20 * MIN], ["E", "A_s1", 0, NOW - 10 * MIN], ["L", "B_s1", null, NOW - 9 * MIN], ["E", "B_s1", 0, NOW - MIN]]);
  h.touch(["1"]);
  await h.service.change("s1", { action: "watch", jobIds: ["1"], label: "手动" });
  await h.scan();
  assert.equal((await h.watches())[0].jobs[0].subruns.launched, 2);
  // 手动关注的那个结束；之后几轮只有自动关注的普通作业在被采样（它们的 stdout 里没有 LAUNCH / END）。
  await h.rules({ patterns: ["plain_*"], failNotify: false });
  const ended = [job("1", "COMPLETED", { name: "xp_manual", at: NOW + MIN }), ...plain.map((id) => job(id, "RUNNING", { name: `plain_${id}` }))];
  for (let round = 1; round <= 12; round += 1) {
    h.time(NOW + round * 5 * MIN);
    h.touch(plain);
    h.jobs(ended);
    await h.scan();
  }
  const manual = (await h.watches()).find((w) => !w.auto);
  assert.equal(manual.jobs[0].subruns?.launched, 2, "一小时后手动关注那个作业的子任务明细还在");
  const stored = (await h.store.subruns.snapshot()).jobs;
  assert.deepEqual(stored.map((s) => s.jobId), ["1"], "普通作业（stdout 里没有 LAUNCH / END）不留子任务状态");
  // 普通作业的 stdout 游标也留得住：不是每轮从头读。
  assert.ok(h.calls.at(-1).jobs.every((j) => j.orch.cur && j.orch.cur.off > 0), "普通作业续读自己的游标，不是每轮从头读");
});

test("审查 1b：自动关注到 60 个时游标留得住——400 条事件的编排作业能读到第 300 条之后，那里的非零退出照常提醒", async () => {
  const ids = Array.from({ length: AUTO_MAX_JOBS }, (_, i) => String(i + 1));
  const h = harness({ initial: ids.map((id) => job(id, "RUNNING", { name: `xp_${id}` })) });
  // 1 号是编排型：200 个子任务各一条 LAUNCH、一条 END；第 176 个（第 351 条事件）以退出码 1 结束。
  const events = [];
  for (let k = 0; k < 200; k += 1) {
    events.push(["L", `run${k}`, null, NOW + k * 1000], ["E", `run${k}`, k === 175 ? 1 : 0, NOW + k * 1000 + 500]);
  }
  h.stdout.set("1", events);
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  const cursors = [];
  for (let round = 0; round <= 14; round += 1) {
    h.time(NOW + round * 5 * MIN);
    h.touch(ids);
    await h.scan();
    const sampled = h.calls.at(-1).jobs.find((j) => j.id === "1");
    if (sampled) cursors.push(sampled.orch.cur?.off ?? null);
  }
  assert.ok(cursors.length >= 3, `1 号被采样了 ${cursors.length} 次`);
  assert.equal(cursors[0], null, "头一次没有游标");
  assert.deepEqual(cursors.slice(1, 3), [300 * EVENT_BYTES, 400 * EVENT_BYTES], "之后每次从上次读到的地方接着读");
  const failed = await h.notices("subrun-failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].body, /1 · run175 train（退出码 1）/);
  const sub = (await h.watches())[0].jobs.find((j) => j.id === "1").subruns;
  assert.deepEqual([sub.launched, sub.ended, sub.failed], [200, 200, 1]);
  const stored = (await h.store.subruns.snapshot()).jobs;
  assert.deepEqual(stored.map((s) => [s.jobId, s.auto === true]), [["1", true]], "只有真是编排型的作业留状态，并标着是自动关注的");
  assert.ok(subrunStore.SUBRUNS_MAX_AUTO_JOBS >= AUTO_MAX_JOBS && subrunStore.SUBRUNS_MAX_JOBS === 40, "自动关注另有名额，不占手动那 40 份");
});

test("审查 1c：手动关注接管一个自动关注的编排作业后，它的子任务状态改记到手动那 40 份里（不再随自动的名额进出）", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_orch" })] });
  h.stdout.set("1", [["L", "A_s1", null, NOW - 20 * MIN], ["E", "A_s1", 0, NOW - 10 * MIN]]);
  h.touch(["1"]);
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  await h.scan();
  assert.deepEqual((await h.store.subruns.snapshot()).jobs.map((s) => [s.jobId, s.auto === true]), [["1", true]]);
  await h.service.change("s1", { action: "watch", jobIds: ["1"], label: "接管" });
  h.time(NOW + 5 * MIN);
  h.touch(["1"]);
  await h.scan();
  assert.deepEqual((await h.store.subruns.snapshot()).jobs.map((s) => [s.jobId, s.auto === true]), [["1", false]]);
  assert.equal((await h.watches())[0].jobs[0].subruns.launched, 1, "明细接着用，没有从头再来");
  assert.deepEqual(h.calls.at(-1).jobs[0].orch.cur, { cid: "7:1", off: 2 * EVENT_BYTES }, "游标也接着用");

  // 已经结束、收尾读过的也一样：2 号在自动关注期间跑完，之后才被手动关注（它的状态此后不会再被采集改写）。
  h.jobs([job("1", "RUNNING", { name: "xp_orch" }), job("2", "RUNNING", { name: "xp_done" })]);
  h.stdout.set("2", [["L", "B_s1", null, NOW], ["E", "B_s1", 0, NOW + MIN]]);
  h.touch(["2"]);
  await h.round(10);
  await h.round(15, [job("1", "RUNNING", { name: "xp_orch" }), job("2", "COMPLETED", { name: "xp_done", at: NOW + 12 * MIN })]);
  const tagOf = async (id) => (await h.store.subruns.snapshot()).jobs.filter((s) => s.jobId === id).map((s) => [s.finalized, s.auto === true]);
  assert.deepEqual(await tagOf("2"), [[true, true]], "收尾读过，还记在自动的名额里");
  await h.service.change("s1", { action: "watch", jobIds: ["2"], label: "回头看" });
  h.touch(["1"]);
  await h.round(20);
  assert.deepEqual(await tagOf("2"), [[true, false]], "手动关注之后的下一轮采集就改记过去");
});

test("审查 1d：普通作业的 stdout 游标记在关注条目上——首次只读了末尾的缺口留着，等它真出现子任务事件时写进状态；文件被换掉后从头读，旧缺口作废", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_big" }), job("2", "RUNNING", { name: "xp_swap" })] });
  h.bigAtFirst.add("1");
  h.touch(["1", "2"]);
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  await h.scan();
  assert.deepEqual((await h.store.subruns.snapshot()).jobs, [], "两个都还是普通作业：不建状态");
  const items = async () => (await h.store.snapshot()).watches[0].jobs.map((j) => [j.id, j.orch]);
  assert.deepEqual(await items(), [["1", { path: "/logs/1.log", cid: "7:1", off: 100, gap: "head" }], ["2", { path: "/logs/2.log", cid: "7:2", off: 100 }]], "条目上记着读到哪了（路径、文件身份、偏移）与缺口");
  // 1 号在游标之后出现了子任务事件；2 号的 stdout 被换成了另一个文件（从头读到事件）。
  const events = Array.from({ length: 6 }, (_, k) => [k % 2 ? "E" : "L", `run${Math.floor(k / 2)}`, k % 2 ? 0 : null, NOW + k * 1000]);
  h.stdout.set("1", events);
  h.stdout.set("2", events);
  h.cids.set("2", "9:2");
  h.time(NOW + 5 * MIN);
  await h.scan();
  const jobs = (await h.watches())[0].jobs;
  const one = jobs.find((j) => j.id === "1").subruns;
  const two = jobs.find((j) => j.id === "2").subruns;
  assert.deepEqual([one.launched, one.ended, one.gaps.map((g) => g.kind)], [1, 2, ["head"]], "1 号：从游标（第 100 字节）之后读到的事件，并注明更早的没读到");
  assert.deepEqual([two.launched, two.ended, two.gaps], [3, 3, []], "2 号：新文件从头读全了，没有缺口可言");
  assert.deepEqual(await items(), [["1", undefined], ["2", undefined]], "有了状态之后以状态里的游标为准，条目上的拿掉");
});

test("审查 1e：采样时还没出现子任务事件、下一次采样前就结束的编排作业——结束后照旧补一次收尾读取，子任务的非零退出照常提醒；普通作业读完就不再留游标", async () => {
  const running = [job("1", "RUNNING", { name: "xp_fast" }), job("2", "RUNNING", { name: "xp_plain" }), job("3", "RUNNING", { name: "xp_lost" })];
  const h = harness({ initial: running });
  h.touch(["1", "2", "3"]);
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  await h.scan();
  assert.deepEqual((await h.store.subruns.snapshot()).jobs, [], "采样时三个都还没有 LAUNCH / END：不建状态");
  // 1 号随后启动了两个子任务、其中一个以退出码 1 结束，然后整个作业结束——都发生在下一次采样之前。2、3 号是普通作业，也结束了。
  h.bases.set("1", 100);
  h.stdout.set("1", [["L", "A_s1", null, NOW + MIN], ["E", "A_s1", 1, NOW + 2 * MIN], ["L", "B_s1", null, NOW + 2 * MIN], ["E", "B_s1", 0, NOW + 3 * MIN]]);
  h.lostFinals.add("3");
  const ended = running.map((j, i) => ({ ...j, state: "COMPLETED", endAt: NOW + 4 * MIN + i }));
  await h.round(5, ended);
  assert.deepEqual(h.calls.at(-1).orchFinal.map((f) => [f.id, f.p, f.cur]), [["1", "/logs/1.log", { cid: "7:1", off: 100 }], ["2", "/logs/2.log", { cid: "7:2", off: 100 }], ["3", "/logs/3.log", { cid: "7:3", off: 100 }]], "结束后各补一次收尾读取，从上次读到的地方起");
  const failed = await h.notices("subrun-failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].body, /1 · A_s1 train（退出码 1）/);
  const stored = (await h.store.subruns.snapshot()).jobs;
  assert.deepEqual(stored.map((s) => [s.jobId, s.finalized, s.auto === true, s.counts.launched, s.counts.failed]), [["1", true, true, 2, 1]], "只有真出现了子任务事件的那个留下状态（已收尾）");
  const orch = async () => (await h.store.snapshot()).watches[0].jobs.map((j) => [j.id, j.orch?.tries ?? (j.orch ? 0 : null)]);
  assert.deepEqual(await orch(), [["1", null], ["2", null], ["3", 1]], "读回来的不再留游标；没读回来的记一次、下一轮再试");
  await h.round(10);
  assert.deepEqual(h.calls.at(-1).orchFinal.map((f) => f.id), ["3"]);
  assert.deepEqual(await orch(), [["1", null], ["2", null], ["3", null]], "试过两轮就不再试");
  const before = h.calls.length;
  await h.round(15);
  assert.deepEqual(h.calls.slice(before).flatMap((c) => c.orchFinal), [], "之后不再为它们发收尾读取");
  assert.equal((await h.notices("subrun-failed")).length, 1, "不重复提醒");
});

// ---- 2 / 3 / 4：「这一批已全部结束」与名额 ----

test("审查 2：长作业规则不发「这一批已全部结束」（错开的长作业会变成逐个报结束）", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { elapsedMin: 200 }), job("2", "RUNNING", { elapsedMin: 30 })] });
  await h.rules({ longRunMinutes: 120, failNotify: false });
  await h.scan();
  assert.deepEqual((await h.watches()).map((w) => [w.auto.rule, w.jobIds]), [["longRun", ["1"]]]);
  // 1 号结束时 2 号还在跑（还没到阈值）；之后 2 号也成了长作业、也结束。
  await h.round(10, [job("1", "COMPLETED", { elapsedMin: 205, at: NOW + 5 * MIN }), job("2", "RUNNING", { elapsedMin: 40 })]);
  await h.round(20);
  await h.round(120, [job("1", "COMPLETED", { elapsedMin: 205, at: NOW + 5 * MIN }), job("2", "RUNNING", { elapsedMin: 150 })]);
  await h.round(130, [job("1", "COMPLETED", { elapsedMin: 205, at: NOW + 5 * MIN }), job("2", "COMPLETED", { elapsedMin: 155, at: NOW + 125 * MIN })]);
  await h.round(140);
  await h.round(200);
  assert.deepEqual(await h.notices(), [], "长作业组只留停滞、临近时限、子任务非零退出");
});

test("审查 3：排队中的作业不占自动关注的名额，但仍算这一批没结束", async () => {
  const pending = Array.from({ length: 60 }, (_, i) => job(String(i + 1), "PENDING", { name: `cfd_wait_${i}` }));
  const h = harness({ initial: pending });
  await h.rules({ patterns: ["cfd_*"], failNotify: false });
  await h.scan();
  assert.deepEqual(await h.watches(), [], "只有排队的：一个也不收，组不显示");
  const running = ["61", "62", "63", "64", "65"].map((id) => job(id, "RUNNING", { name: `cfd_run_${id}` }));
  await h.round(5, [...pending, ...running]);
  assert.deepEqual((await h.watches())[0].jobIds, ["61", "62", "63", "64", "65"], "在跑的进得来");
  // 在跑的 5 个结束，60 个还排着（上游失败、依赖永远满足不了的那种）：不报这一批结束。
  const done = running.map((j, i) => ({ ...j, state: "COMPLETED", endAt: NOW + 8 * MIN + i }));
  await h.round(10, [...pending, ...done]);
  await h.round(20);
  await h.round(60);
  assert.deepEqual(await h.notices(), []);
  // 排着的被取消之后才算结束：一条带上全部 65 个。
  const cancelled = pending.map((j, i) => ({ ...j, state: "CANCELLED", endAt: NOW + 62 * MIN + i }));
  await h.round(65, [...cancelled, ...done]);
  await h.round(75);
  const list = await h.notices();
  assert.deepEqual(list.map((n) => [n.kind, n.body.split("。")[0]]), [["ended", "65 个作业：5 完成 · 0 失败 · 60 取消"]]);
  // 已经在组里的作业被重排回排队：让出名额，回到运行时再收。
  const g = harness({ initial: [job("1", "RUNNING", { name: "cfd_a" })] });
  await g.rules({ patterns: ["cfd_*"], failNotify: false });
  await g.scan();
  await g.round(5, [job("1", "PENDING", { name: "cfd_a" })]);
  assert.deepEqual(await g.watches(), []);
  await g.round(10, [job("1", "RUNNING", { name: "cfd_a" })]);
  assert.deepEqual((await g.watches())[0].jobIds, ["1"]);
});

test("审查 4：服务器退出采集范围再回来、头一轮又没拿全时，不补发离开期间的「这一批已全部结束」", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "cfd_a" })] });
  await h.rules({ patterns: ["cfd_*"], failNotify: false });
  await h.scan();
  h.config({ servers: [{ id: "s1", host: "cluster", disabled: true }] });
  await h.service.view();
  h.config({ servers: [{ id: "s1", host: "cluster" }] });
  // 离开期间 1 号结束了；回来的头一轮 sacct 没拿全（这一轮里看不到它）。
  h.truncated(true);
  await h.round(30, [job("9", "RUNNING", { name: "other" })]);
  h.truncated(false);
  const back = [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 10 * MIN }), job("9", "RUNNING", { name: "other" })];
  await h.round(35, back);
  await h.round(45);
  await h.round(90);
  assert.deepEqual(await h.notices(), []);
  // 回来之后才结束的照常报。
  await h.round(95, [...back, job("2", "RUNNING", { name: "cfd_b" })]);
  await h.round(100, [...back, job("2", "COMPLETED", { name: "cfd_b", at: NOW + 98 * MIN })]);
  await h.round(110);
  assert.deepEqual((await h.notices()).map((n) => n.jobIds), [["2"]]);
});

// ---- 5 / 6：临近时限 ----

test("审查 5：提醒窗口比 10 分钟短时，第二个作业的「临近时限」不被间隔吞掉", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_a" }), job("2", "RUNNING", { name: "xp_b" })] });
  await h.rules({ patterns: ["xp_*"] });
  await h.service.change("s1", { action: "settings", limitMinutes: 5 });
  await h.scan();
  // 两个作业各 2 小时时限：1 号先进入最后 5 分钟，2 号晚 2 分钟。
  const at = (minute) => h.queue([["1", "xp_a", 7200 - 240 + minute * 60, 7200], ["2", "xp_b", 7200 - 360 + minute * 60, 7200]]);
  await h.service.observeQueue("s1", at(0));
  assert.deepEqual((await h.notices("limit")).map((n) => n.jobIds), [["1"]]);
  for (const minute of [1, 2, 3, 4, 5]) {
    h.time(NOW + minute * MIN);
    await h.service.observeQueue("s1", at(minute));
  }
  // 2 号在第 2 分钟进入最后 5 分钟、第 6 分钟超时：必须在它结束前提醒到。
  assert.deepEqual((await h.notices("limit")).map((n) => n.jobIds), [["2"], ["1"]]);
});

test("审查 6：手动关注接管一个自动关注的作业后，「临近时限」「疑似停滞」不再发第二遍", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_a" })] });
  await h.rules({ patterns: ["xp_*"] });
  await h.service.change("s1", { action: "settings", silenceMinutes: 10 });
  h.logs.set("1", { mt: NOW, sz: 100 });
  for (const minutes of [0, 5, 10]) await h.round(minutes); // 日志一直没变：10 分钟后自动组报疑似停滞
  const near = h.queue([["1", "xp_a", 7200 - 600, 7200]]);
  await h.service.observeQueue("s1", near);
  assert.deepEqual((await h.notices()).map((n) => n.kind).sort(), ["limit", "stalled"]);
  await h.service.change("s1", { action: "watch", jobIds: ["1"], label: "接管" });
  h.time(NOW + 11 * MIN);
  await h.service.observeQueue("s1", near);
  await h.round(15);
  await h.round(20);
  assert.deepEqual((await h.notices()).map((n) => n.kind).sort(), ["limit", "stalled"], "接管时把已经提醒过的记号带过去");
  assert.deepEqual((await h.watches()).map((w) => [w.label, w.jobIds]), [["接管", ["1"]]]);
});

// ---- 7：静音 ----

test("审查 7：自动组被手动关注挤掉再建回来，静音还在", async () => {
  const all = Array.from({ length: 60 }, (_, i) => job(String(i + 1), "RUNNING", { name: i === 0 ? "xp_a" : `m_${i}` }));
  const h = harness({ initial: all });
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  await h.scan();
  const group = (await h.watches())[0];
  await h.service.change("s1", { action: "mute", watchId: group.id, muted: true });
  const manualIds = [];
  for (let i = 2; i <= 41; i += 1) {
    const view = await h.service.change("s1", { action: "watch", jobIds: [String(i)] });
    manualIds.push(view.watches.at(-1).id);
  }
  assert.equal((await h.store.snapshot()).watches.some((w) => w.auto), false, "40 个手动组占满，自动组让位");
  const view = await h.service.view("s1");
  await h.service.change("s1", { action: "unwatch", watchId: view.watches[0].id });
  await h.round(5);
  const rebuilt = (await h.watches()).find((w) => w.auto);
  assert.deepEqual([rebuilt.label, rebuilt.muted, rebuilt.jobIds], ["xp_*", true, ["1"]]);
  // 取消静音同样记得住；规则停用后不留痕迹。
  await h.service.change("s1", { action: "mute", watchId: rebuilt.id, muted: false });
  assert.deepEqual((await h.store.snapshot()).settings.s1.autoMuted ?? [], []);
  await h.service.change("s1", { action: "mute", watchId: rebuilt.id, muted: true });
  await h.service.change("s1", { action: "unwatch", watchId: rebuilt.id });
  assert.deepEqual((await h.store.snapshot()).settings.s1.autoMuted ?? [], []);
  const again = await h.rules({ patterns: ["xp_*"] });
  await h.round(10);
  assert.equal((await h.watches()).find((w) => w.auto).muted, false, "重新加回来的规则是新的，不沿用旧的静音");
  assert.deepEqual(again.rules.patterns, ["xp_*"]);
});

// ---- 8 / 13 / 12：失败提醒 ----

test("审查 8：同一个作业号失败两次（节点故障后重排、再次失败）各提醒一次", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "train" }), job("2", "RUNNING", { name: "keep" })] });
  await h.scan();
  await h.round(5, [job("1", "NODE_FAIL", { name: "train", at: NOW + 3 * MIN }), job("2", "RUNNING", { name: "keep" })]);
  assert.deepEqual((await h.notices("failed")).map((n) => n.jobIds), [["1"]]);
  await h.round(10);
  await h.round(20, [job("1", "RUNNING", { name: "train" }), job("2", "RUNNING", { name: "keep" })]); // 被重排后又跑起来
  await h.round(30, [job("1", "FAILED", { name: "train", at: NOW + 28 * MIN }), job("2", "RUNNING", { name: "keep" })]);
  const list = await h.notices("failed");
  assert.deepEqual(list.map((n) => [n.jobIds, n.createdAt]), [[["1"], NOW + 30 * MIN], [["1"], NOW + 5 * MIN]]);
  await h.round(35);
  await h.round(60);
  assert.equal((await h.notices("failed")).length, 2, "同一次失败之后不再重复");
  // 结束时刻读不出来的失败只按作业号认，不会每轮都当成新的。
  const g = harness({ initial: [job("7")] });
  await g.scan();
  await g.round(5, [job("7", "FAILED", { at: null })]);
  await g.round(20);
  await g.round(40);
  assert.equal((await g.notices("failed")).length, 1);
});

test("审查 13：作业在任何静音的关注组里（手动的，或被静音的规则命中）就不发失败提醒；取消静音也不补发", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "manual_a" }), job("2", "RUNNING", { name: "xp_tracked" }), job("3", "RUNNING", { name: "plain" })] });
  await h.rules({ patterns: ["xp_*"] });
  await h.scan();
  const manual = await h.service.change("s1", { action: "watch", jobIds: ["1"], label: "手动" });
  await h.service.change("s1", { action: "mute", watchId: manual.watches.find((w) => !w.auto).id, muted: true });
  const auto = (await h.watches()).find((w) => w.auto);
  await h.service.change("s1", { action: "mute", watchId: auto.id, muted: true });
  // 4 号命中被静音的规则，但两轮之间就失败了、从没被收进组：同样不提醒。
  const failed = [job("1", "FAILED", { name: "manual_a", at: NOW + MIN }), job("2", "FAILED", { name: "xp_tracked", at: NOW + 2 * MIN }), job("3", "FAILED", { name: "plain", at: NOW + 3 * MIN }), job("4", "FAILED", { name: "xp_quick", at: NOW + 4 * MIN })];
  await h.round(5, failed);
  assert.deepEqual((await h.notices()).map((n) => [n.kind, n.jobIds]), [["failed", ["3"]]]);
  await h.service.change("s1", { action: "mute", watchId: auto.id, muted: false });
  await h.round(20);
  await h.round(40);
  assert.equal((await h.notices()).length, 1, "静音期间的失败已经记过，不补发");
  await h.round(45, [...failed, job("5", "FAILED", { name: "xp_later", at: NOW + 43 * MIN })]);
  assert.deepEqual((await h.notices("failed")).map((n) => n.jobIds), [["5"], ["3"]], "取消静音之后的照常提醒");
});

test("审查 8（续）：第二次失败的提醒不套用第一次失败的诊断（诊断每个作业号只存一份）", async () => {
  const START = Date.UTC(2026, 9, 1, 8, 0, 0); // 2026-10-01 16:00:00 +0800，与下面 sacct 行里的远端本地时间对得上
  let clock = START;
  let rows = ["job=101|train|RUNNING|0:0|2026-10-01T15:21:27|2026-10-01T15:21:27|Unknown|00:38:40|node03|CPU"];
  let forensics = 0;
  const service = createJobsService({
    getConfig: async () => ({ servers: [{ id: "s1", host: "cluster" }] }), probeSshFailureReason: () => "x", now: () => clock,
    watchStore: createJobWatchStore({ now: () => clock }),
    execCollector: async (invocation) => {
      const command = invocation.args.at(-1);
      if (command === WATCH_REMOTE_COMMAND) return { code: 0, stdout: "" };
      if (command === FORENSICS_REMOTE_COMMAND) {
        forensics += 1;
        return { code: 0, stdout: `${JSON.stringify({ k: "job", id: "101", src: "registry", tool: "sbatch", live: true, files: [{ p: "/w/o_101.log", r: "stdout", sz: 10, t: "Traceback (most recent call last):\n  File \"t.py\"\nKeyError: 'arm'\n" }], sc: null, scs: null })}\n${JSON.stringify({ k: "end", n: 1, complete: true })}\n` };
      }
      return { code: 0, stdout: `now=${Math.floor(clock / 1000)}\ntz=+0800\nuser=kai\nstate=ok\n${rows.join("\n")}\n` };
    },
  });
  const failedRow = (end, state = "FAILED") => `job=101|train|${state}|1:0|2026-10-01T15:21:27|2026-10-01T15:21:27|${end}|00:38:40|node03|CPU`;
  await service.runScan("s1");
  clock = START + 5 * MIN;
  rows = [failedRow("2026-10-01T16:03:00")];
  await service.runScan("s1");
  clock = START + 20 * MIN;
  rows = ["job=101|train|RUNNING|0:0|2026-10-01T15:21:27|2026-10-01T16:10:00|Unknown|00:05:00|node03|CPU"];
  await service.runScan("s1");
  clock = START + 30 * MIN;
  rows = [failedRow("2026-10-01T16:28:00")];
  await service.runScan("s1");
  const list = (await service.getWatchView()).notifications;
  assert.equal(forensics, 1, "失败诊断本身没改：每个作业号仍只取证一次");
  assert.deepEqual(list.map((n) => n.body.split("。")[0]), ["退出码 1，原因待查", "KeyError: 'arm'"], "后一次失败不说成前一次的原因");
});

for (const serverId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
  test(`审查 12：服务器 id 是 Object 原型上的属性名（${serverId}）时照常工作，不抛错、不丢手动关注的处理`, async () => {
    const h = harness({ serverId, initial: [job("1", "RUNNING", { name: "xp_a" }), job("2", "RUNNING", { name: "other" })] });
    await h.service.change(serverId, { action: "watch", jobIds: ["2"], label: "手动" });
    await assert.doesNotReject(h.scan());
    const saved = await h.rules({ patterns: ["xp_*"], longRunMinutes: 120 });
    assert.deepEqual(saved.rules, { failNotify: true, longRunMinutes: 120, patterns: ["xp_*"] });
    await h.service.change(serverId, { action: "settings", silenceMinutes: 45 });
    await h.round(5, [job("1", "FAILED", { name: "xp_a", at: NOW + 3 * MIN }), job("2", "COMPLETED", { name: "other", at: NOW + 4 * MIN })]);
    const view = await h.service.view(serverId);
    assert.deepEqual(view.notifications.map((n) => n.kind).sort(), ["ended", "failed"]);
    assert.deepEqual([view.rules.patterns, view.settings.silenceMinutes], [["xp_*"], 45]);
    // 落盘再读回来还在（JSON 往返后仍是自有属性）。
    const data = JSON.parse(JSON.stringify(await h.store.snapshot()));
    assert.ok(Object.hasOwn(data.failures, serverId) && Object.hasOwn(data.settings, serverId));
    assert.deepEqual(Object.keys(data.failures[serverId].seen), ["1"]);
    assert.equal(Object.getPrototypeOf(data.settings), Object.prototype);
  });
}

test("自动组的间隔常量没有被这轮修补改动（防误伤）", () => {
  assert.equal(AUTO_NOTIFY_GAP_MS, 30 * MIN);
});
