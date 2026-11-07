// 关注服务里的子任务链路：游标随同一次 SSH 送达、失败并入作业提醒（合并 / 去重 / 静音）、
// 子任务日志活动不算停滞、父作业结束后的有限收尾读取。
import assert from "node:assert/strict";
import test from "node:test";
import { createJobWatchService } from "./watch-service.mjs";
import { createJobWatchStore } from "./watch-store.mjs";

const NOW = 1791200000000;
const MIN = 60000;
const running = (id) => ({ id, name: `xp_${id}`, state: "RUNNING", startAt: NOW - 3600000, endAt: null });
// 毫秒 → 调度器的 `2026-10-05T12:00:00+0800` 写法。
const stamp = (ms) => `${new Date(ms + 8 * 3600000).toISOString().slice(0, 19)}+0800`;

function harness() {
  let clock = NOW;
  let jobs = [running("1")];
  let response = "";
  const store = createJobWatchStore({ now: () => clock });
  const calls = [];
  const snapshot = () => ({ state: "ok", user: "me", checkedAt: clock, jobs });
  const service = createJobWatchService({
    store, getConfig: async () => ({ servers: [{ id: "s1", host: "cluster" }] }), getSnapshot: () => snapshot(), now: () => clock,
    registry: { lookup: (_s, id) => ({ jobId: id, user: "me", stdout: `/exp/logs/xp_${id}.log`, workDir: "/exp" }) },
    execCollector: async (inv) => { calls.push(JSON.parse(inv.input.split("\n")[1])); return { stdout: typeof response === "function" ? response() : response, code: 0 }; },
  });
  return { store, service, calls, snapshot, time: (v) => { clock = v; }, now: () => clock, jobs: (v) => { jobs = v; }, response: (v) => { response = v; } };
}

let offset = 0;
function lines(h, { from, events, logs = [], kind = "subruns", stdoutSize = 100 }) {
  const rn = h.now() / 1000;
  const ev = events.map(([type, run, phase, code, at], i) => [from + i * 10, stamp(at ?? h.now()), type, run, phase, type === "E" ? code : null]);
  offset = from + events.length * 10;
  const progress = kind === "subruns" ? JSON.stringify({ k: "progress", id: "1", files: [{ p: "/exp/logs/xp_1.log", t: "LAUNCH …", mt: NOW / 1000 - 3600, sz: stdoutSize }], remoteNow: rn }) : "";
  const sub = JSON.stringify({ k: kind, id: "1", p: "/exp/logs/xp_1.log", cid: "5:6", from, off: offset, sz: offset, mt: rn - 3600, gap: null, more: false, ev, logs, rn });
  return `${progress}\n${sub}\n${JSON.stringify({ k: "end", complete: true })}\n`;
}

test("首轮送空游标、次轮送已确认游标；非零退出合并成一条提醒，关注前的失败与重复不提醒", async () => {
  const h = harness();
  await h.service.change("s1", { action: "watch", jobIds: ["1"], label: "wallgate" });
  h.response(lines(h, { from: 0, events: [
    ["L", "OLD_s1", "train", null, NOW - 50 * MIN], ["E", "OLD_s1", "train", 1, NOW - 40 * MIN],
    ["L", "A_s1", "train"], ["L", "B_s1", "train"], ["E", "A_s1", "train", 1], ["E", "B_s1", "train", -9],
  ] }));
  await h.service.scan("s1", h.snapshot());
  assert.deepEqual(h.calls[0].jobs[0].orch, { cur: null, open: [] });
  let v = await h.service.view("s1");
  const notes = v.notifications.filter((n) => n.kind === "subrun-failed");
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /1 · A_s1 train（退出码 1）；1 · B_s1 train（退出码 -9）/);
  assert.doesNotMatch(notes[0].body, /OLD_s1/);
  const sub = v.watches[0].jobs[0].subruns;
  assert.deepEqual([sub.launched, sub.ended, sub.failed, sub.runningCount], [3, 3, 3, 0]);
  h.time(NOW + 5 * MIN);
  h.response(lines(h, { from: offset, events: [] }));
  await h.service.scan("s1", h.snapshot());
  assert.deepEqual(h.calls[1].jobs[0].orch.cur, { cid: "5:6", off: offset });
  v = await h.service.view("s1");
  assert.equal(v.notifications.filter((n) => n.kind === "subrun-failed").length, 1, "已提醒的不重复");
});

test("静音的关注组不产生子任务失败提醒，但视图照常显示", async () => {
  const h = harness();
  const added = await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  await h.service.change("s1", { action: "mute", watchId: added.watches[0].id, muted: true });
  h.response(lines(h, { from: 0, events: [["L", "A_s1", "train"], ["E", "A_s1", "train", 3]] }));
  await h.service.scan("s1", h.snapshot());
  const v = await h.service.view("s1");
  assert.equal(v.notifications.length, 0);
  assert.equal(v.watches[0].jobs[0].subruns.failedRuns[0].code, 3);
});

test("stdout 长时间不变但子任务日志在增长：不报疑似停滞；子任务日志也不动才报", async () => {
  const h = harness();
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  let size = 1000;
  const round = (grow) => {
    if (grow) size += 500;
    return lines(h, { from: offset, events: offset ? [] : [["L", "A_s1", "train"]], logs: [{ r: "A_s1", s: "train", mt: h.now() / 1000 - 30, sz: size, ep: [], last: "running" }] });
  };
  offset = 0;
  for (let i = 0; i <= 7; i += 1) {
    h.time(NOW + i * 5 * MIN);
    h.response(round(true));
    await h.service.scan("s1", h.snapshot());
  }
  let job = (await h.service.view("s1")).watches[0].jobs[0];
  assert.notEqual(job.progress.status, "stalled");
  assert.match(job.progress.detail, /子任务日志/);
  for (let i = 8; i <= 16; i += 1) {
    h.time(NOW + i * 5 * MIN);
    h.response(round(false));
    await h.service.scan("s1", h.snapshot());
  }
  job = (await h.service.view("s1")).watches[0].jobs[0];
  assert.equal(job.progress.status, "stalled");
});

test("父作业结束后做一次收尾读取补上最后的 END；两轮都没有结果则按缺失收尾", async () => {
  const h = harness();
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  offset = 0;
  h.response(lines(h, { from: 0, events: [["L", "A_s1", "train"], ["L", "B_s1", "eval_best"]] }));
  await h.service.scan("s1", h.snapshot());
  h.jobs([{ ...running("1"), state: "COMPLETED", endAt: NOW + MIN }]);
  h.time(NOW + 5 * MIN);
  h.response(lines(h, { from: offset, kind: "subruns-final", events: [["E", "A_s1", "train", 0]] }));
  await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.at(-1).orchFinal[0].id, "1");
  assert.equal(h.calls.at(-1).jobs.length, 0, "已结束的作业不再读运行中进度");
  let sub = (await h.service.view("s1")).watches[0].jobs[0].subruns;
  assert.equal(sub.finalized, true);
  assert.deepEqual(sub.unended.map((r) => r.run), ["B_s1"]);
  const before = h.calls.length;
  await h.service.scan("s1", h.snapshot());
  assert.equal(h.calls.slice(before).some((c) => c.orchFinal?.length), false, "收尾只做一次");

  const g = harness();
  await g.service.change("s1", { action: "watch", jobIds: ["1"] });
  offset = 0;
  g.response(lines(g, { from: 0, events: [["L", "A_s1", "train"]] }));
  await g.service.scan("s1", g.snapshot());
  g.jobs([{ ...running("1"), state: "TIMEOUT", endAt: NOW + MIN }]);
  g.response("");
  await g.service.scan("s1", g.snapshot());
  assert.equal((await g.service.view("s1")).watches[0].jobs[0].subruns.finalized, false);
  await g.service.scan("s1", g.snapshot());
  sub = (await g.service.view("s1")).watches[0].jobs[0].subruns;
  assert.equal(sub.finalized, true);
  assert.match(sub.finalNote, /两轮未成功/);
});

test("没有编排记录的普通作业：视图 subruns 为空，不影响原有进度", async () => {
  const h = harness();
  await h.service.change("s1", { action: "watch", jobIds: ["1"] });
  const rn = NOW / 1000;
  h.response(`${JSON.stringify({ k: "progress", id: "1", files: [{ p: "/exp/logs/xp_1.log", t: "epoch 3 step 9", mt: rn - 10, sz: 20 }], remoteNow: rn })}\n${JSON.stringify({ k: "subruns", id: "1", p: "/exp/logs/xp_1.log", cid: "1:1", from: 0, off: 20, sz: 20, mt: rn - 10, gap: null, more: false, ev: [], logs: [], rn })}\n`);
  await h.service.scan("s1", h.snapshot());
  const job = (await h.service.view("s1")).watches[0].jobs[0];
  assert.equal(job.subruns, null);
  assert.equal(job.progress.epoch, 3);
  assert.equal(h.store.subruns !== undefined, true);
});
