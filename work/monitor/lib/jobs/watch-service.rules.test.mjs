// v2.62 提醒规则在关注服务里的行为：失败提醒（合并 / 去重 / 重启不重发）、规则命中的作业自动进组与名额、
// 自动组只发合并后的几类提醒、手动关注不被挤占、规则校验。SSH 一律是桩，时钟手动推进。
import assert from "node:assert/strict";
import * as nodeFsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTO_LIMIT_GAP_MS, AUTO_NOTIFY_GAP_MS, AUTO_SETTLE_MS, createJobWatchService, FAIL_NOTIFY_GAP_MS } from "./watch-service.mjs";
import { createJobWatchStore, FAIL_SEEN_MAX, JOB_WATCH_FILE } from "./watch-store.mjs";

const NOW = 1791200000000;
const MIN = 60000;
const FAILED = new Set(["FAILED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL"]);

// sacct 快照里的一条作业。at：结束时刻（终态才有）；elapsedMin：已运行分钟数。
function job(id, state = "RUNNING", { name = `job_${id}`, at = null, elapsedMin = 10, exitCode = state === "FAILED" ? 1 : 0, submitAt = NOW - 3600000 } = {}) {
  return { id, name, state, exitCode, submitAt, startAt: state === "PENDING" ? null : NOW - 3600000, endAt: at, elapsedSec: state === "PENDING" ? 0 : elapsedMin * 60 };
}

function harness({ initial = [], store = null, config = { servers: [{ id: "s1", host: "cluster", name: "主集群服务器 (cluster)" }] }, clockAt = NOW } = {}) {
  let clock = clockAt;
  let jobs = initial;
  let currentConfig = config;
  let truncated = false;
  const diagnoses = new Map();
  const logs = new Map(); // 作业号 → { mt, sz }：没有的作业这一轮读不到日志
  const names = [];
  const extra = []; // 这一轮远端另外输出的行（子任务记录等），用一次就清
  const calls = [];
  const st = store ?? createJobWatchStore({ now: () => clock });
  const snapshot = () => ({ state: "ok", user: "me", checkedAt: clock, truncated, jobs });
  const service = createJobWatchService({
    store: st, getConfig: async () => currentConfig, getSnapshot: () => snapshot(), now: () => clock,
    registry: { lookup: (_serverId, id) => ({ jobId: id, user: "me", stdout: `/logs/${id}.log`, workDir: "/logs" }), names: () => names },
    execCollector: async (inv) => {
      const payload = JSON.parse(inv.input.split("\n")[1]);
      calls.push(payload);
      // 日志进度只回 logs 里有的作业；已结束作业的资源记账（与关注无关的既有采集）有问必答，头一轮就落定。
      const progress = payload.jobs.filter((j) => logs.has(j.id)).map((j) => JSON.stringify({ k: "progress", id: j.id, remoteNow: clock / 1000, files: [{ p: `/logs/${j.id}.log`, mt: logs.get(j.id).mt / 1000, sz: logs.get(j.id).sz, t: "step 1" }] }));
      const resources = payload.resourceIds.map((id) => JSON.stringify({ k: "resource", id, rows: [{ id, cpus: "2", elapsed: "100", totalCpu: "00:02:00", maxRss: "1024K" }] }));
      return { code: 0, stdout: [...progress, ...resources, ...extra.splice(0)].join("\n") };
    },
    isFailure: (j) => FAILED.has(j.state) && /^\d+(?:_\d+)?$/.test(j.id),
    diagnosisOf: (_serverId, jobId) => diagnoses.get(jobId) ?? null,
  });
  const h = {
    store: st, service, calls, diagnoses, logs, names, extra, snapshot,
    now: () => clock,
    time: (v) => { clock = v; },
    jobs: (v) => { jobs = v; },
    config: (v) => { currentConfig = v; },
    truncated: (v) => { truncated = v; },
    scan: () => service.scan("s1", snapshot()),
    // 推进到 NOW + minutes 分钟、可选换一批作业，再跑一轮。
    round: async (minutes, next = null) => { clock = NOW + minutes * MIN; if (next) jobs = next; await service.scan("s1", snapshot()); },
    notices: async (kind = null) => (await service.view()).notifications.filter((n) => !kind || n.kind === kind),
    watches: async () => (await service.view("s1")).watches,
    rules: (patch) => service.change("s1", { action: "rules", ...patch }),
  };
  return h;
}

// ---- 失败提醒 ----

test("失败提醒：头一轮只建基线；之后新失败的作业同一轮合成一条（原因汇总 + 作业号），不属于任何关注组；重启后不重发", async () => {
  const h = harness({ initial: [job("90", "FAILED", { at: NOW - 3600000 }), job("91", "TIMEOUT", { at: NOW - 600000 }), job("101"), job("102"), job("103")] });
  await h.scan();
  assert.deepEqual(await h.notices(), [], "升级 / 新装后的头一轮：近两天里已有的失败不算新的");

  h.diagnoses.set("101", { category: "python", headline: "KeyError: 'arm'" }).set("102", { category: "python", headline: "KeyError: 'arm'" }).set("103", { category: "timeout", headline: "超出时限（已运行 2 小时）" });
  const failedNow = [job("90", "FAILED", { at: NOW - 3600000 }), job("91", "TIMEOUT", { at: NOW - 600000 }),
    job("101", "FAILED", { at: NOW + 1 * MIN, name: "train_a" }), job("102", "FAILED", { at: NOW + 3 * MIN, name: "train_b" }), job("103", "TIMEOUT", { at: NOW + 2 * MIN, name: "train_c" })];
  await h.round(5, failedNow);
  let list = await h.notices();
  assert.equal(list.length, 1);
  const [first] = list;
  assert.deepEqual([first.kind, first.watchId, first.serverId, first.readAt, first.createdAt], ["failed", null, "s1", null, NOW + 5 * MIN]);
  assert.equal(first.title, "3 个作业失败");
  assert.equal(first.body, "2 个 KeyError: 'arm'，1 个超出时限。作业号 102、103、101。详情见「我的历史」。");
  assert.deepEqual(first.jobIds, ["102", "103", "101"], "新失败的在前，点开定位到最近的那个");
  assert.equal(first.intro, true, "没动过规则的人收到的头一条带说明标记");
  assert.ok(h.calls.every((call) => call.jobs.length === 0), "失败提醒不读任何日志（原因来自取证）；这里的调用只有既有的资源记账");

  await h.round(10);
  assert.equal((await h.notices()).length, 1, "同一批失败下一轮不再提");

  // 重启：新的存储实例读同一份数据（这里直接复用内存里的存储，相当于读回落盘内容），新的服务实例。
  const restarted = harness({ initial: failedNow, store: h.store, clockAt: NOW + 15 * MIN });
  await restarted.scan();
  assert.deepEqual((await restarted.notices()).map((n) => n.id), [first.id], "重启后不重发");

  restarted.jobs([...failedNow, job("104", "OUT_OF_MEMORY", { at: NOW + 18 * MIN, name: "train_d" })]);
  restarted.time(NOW + 20 * MIN);
  await restarted.scan();
  list = await restarted.notices();
  assert.equal(list.length, 2);
  assert.deepEqual([list[0].title, list[0].body, list[0].jobIds], ["作业失败：train_d", "内存不足被系统终止。作业号 104。详情见「我的历史」。", ["104"]]);
  assert.equal("intro" in list[0], false, "说明只跟头一条");
});

test("失败提醒：关掉后不发；再打开也不补发关着期间的失败；动过规则的人头一条不带说明标记", async () => {
  const h = harness({ initial: [job("1"), job("2"), job("3")] });
  await h.scan();
  const off = await h.rules({ failNotify: false });
  assert.deepEqual(off.rules, { failNotify: false, longRunMinutes: null, patterns: [] });
  await h.round(5, [job("1", "FAILED", { at: NOW + 2 * MIN }), job("2"), job("3")]);
  assert.deepEqual(await h.notices(), []);
  await h.rules({ failNotify: true });
  await h.round(10);
  assert.deepEqual(await h.notices(), [], "关着的时候也照记「见过」，打开后不一股脑补发");
  await h.round(15, [job("1", "FAILED", { at: NOW + 2 * MIN }), job("2", "NODE_FAIL", { at: NOW + 12 * MIN }), job("3")]);
  const list = await h.notices("failed");
  assert.deepEqual(list.map((n) => n.jobIds), [["2"]]);
  assert.equal("intro" in list[0], false);
});

test("失败提醒：同一轮里已由关注组提醒过的失败作业不重复提；静音的关注组里的作业失败也不提（用户把那一组静音了）", async () => {
  const h = harness({ initial: [job("1"), job("2"), job("3"), job("4")] });
  await h.scan();
  await h.service.change("s1", { action: "watch", jobIds: ["1", "2"], label: "实验组" });
  const quiet = await h.service.change("s1", { action: "watch", jobIds: ["4"], label: "静音的" });
  await h.service.change("s1", { action: "mute", watchId: quiet.watches.find((w) => w.label === "静音的").id, muted: true });
  await h.round(5, [job("1", "FAILED", { at: NOW + 1 * MIN }), job("2", "COMPLETED", { at: NOW + 2 * MIN }), job("3", "FAILED", { at: NOW + 3 * MIN }), job("4", "FAILED", { at: NOW + 4 * MIN })]);
  const list = await h.notices();
  assert.deepEqual(list.map((n) => [n.kind, n.jobIds]).sort(), [["ended", ["1", "2"]], ["failed", ["3"]]]);
  assert.match(list.find((n) => n.kind === "ended").body, /1 完成 · 1 失败/);
  assert.equal(typeof list.find((n) => n.kind === "ended").watchId, "string");
  await h.round(10);
  assert.equal((await h.notices()).length, 2, "作业 1、4 已记为见过，下一轮也不补成失败提醒");
});

test("失败提醒：模块关闭 / 服务器退出采集范围期间的失败，回来后不补发（重新建基线）", async () => {
  const h = harness({ initial: [job("1"), job("2")] });
  await h.scan();
  h.config({ servers: [{ id: "s1", host: "cluster" }], modules: { jobs: false } });
  assert.deepEqual(await h.service.view(), { disabled: true });
  h.jobs([job("1", "FAILED", { at: NOW + 1 * MIN }), job("2")]);
  h.config({ servers: [{ id: "s1", host: "cluster" }] });
  await h.round(5);
  assert.deepEqual(await h.notices(), []);
  await h.round(10, [job("1", "FAILED", { at: NOW + 1 * MIN }), job("2", "FAILED", { at: NOW + 8 * MIN })]);
  assert.deepEqual((await h.notices()).map((n) => n.jobIds), [["2"]], "回来之后的新失败照常提醒");

  // 换一台不在范围里的服务器：扫描直接不处理。
  await h.service.scan("other", h.snapshot());
  assert.equal((await h.notices()).length, 1);
});

test("失败提醒：一轮里上千个失败也只有一条；「见过」的记录有界，丢掉的不会回头再提醒", async () => {
  const h = harness({ initial: [job("7")] });
  await h.scan();
  const burst = Array.from({ length: 3000 }, (_, i) => job(`9000_${i}`, "FAILED", { at: NOW + MIN + i, name: "sweep" }));
  await h.round(5, burst);
  const list = await h.notices();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "3000 个作业失败");
  assert.equal(list[0].jobIds.length, 50, "提醒里只带最近的 50 个作业号");
  assert.ok(list[0].body.length < 300);
  const saved = (await h.store.snapshot()).failures.s1;
  assert.equal(Object.keys(saved.seen).length, FAIL_SEEN_MAX);
  assert.ok(saved.since >= NOW + MIN + 999, "超出的部分丢最早结束的，并把起算点抬到那里");
  await h.round(10);
  await h.round(15);
  assert.equal((await h.notices()).length, 1, "被丢掉的那 1000 个仍在快照里，但不再当新的");
  assert.ok(Buffer.byteLength(JSON.stringify(await h.store.snapshot())) < 200 * 1024);
});

test("失败提醒：晚到的旧失败（头一轮没拿全、结束在基线之前）不算新的", async () => {
  const h = harness({ initial: [job("1")] });
  await h.scan();
  await h.round(5, [job("1"), job("50", "FAILED", { at: NOW - 6 * 3600000 }), job("51", "FAILED", { at: NOW + 2 * MIN })]);
  assert.deepEqual((await h.notices()).map((n) => n.jobIds), [["51"]]);
});

test("失败提醒：「默认开启」的说明标记只跟头一条；用户自己存过规则之后，还挂在提醒上的标记也拿掉", async () => {
  const h = harness({ initial: [job("1"), job("2")] });
  await h.scan();
  await h.round(5, [job("1", "FAILED", { at: NOW + 2 * MIN }), job("2")]);
  await h.round(20, [job("1", "FAILED", { at: NOW + 2 * MIN }), job("2", "FAILED", { at: NOW + 18 * MIN })]);
  assert.deepEqual((await h.notices()).map((n) => [n.jobIds, n.intro === true]), [[["2"], false], [["1"], true]]);
  // 改规则（哪怕只是确认现状）= 用户已经知道这回事了。
  const saved = await h.rules({ failNotify: true });
  assert.ok(saved.notifications.every((n) => !("intro" in n)));
  assert.ok((await h.notices()).every((n) => !("intro" in n)));
  assert.deepEqual((await h.store.snapshot()).settings.s1.rules, { failNotify: true, longRunMinutes: null, patterns: [] }, "规则从此算用户自己定的");
});

test("失败提醒：两条之间至少隔 10 分钟——头一个失败立刻提醒，紧接着失败的攒到下一条；攒着的重启不丢，关掉规则就不要了", async () => {
  const ids = ["1", "2", "3", "4", "5"];
  const state = (failedAt) => ids.map((id) => (failedAt[id] ? job(id, "FAILED", { at: failedAt[id], name: `stage_${id}` }) : job(id, "RUNNING", { name: `stage_${id}` })));
  const h = harness({ initial: state({}) });
  await h.scan();
  const failedAt = { 1: NOW + 4 * MIN };
  await h.round(5, state(failedAt));
  assert.deepEqual((await h.notices()).map((n) => n.jobIds), [["1"]], "头一个失败不等");
  // 作业一结束探针会被提前催一轮：一批作业接连失败时一分钟就是一轮。
  failedAt[2] = NOW + 5.5 * MIN;
  await h.round(6, state(failedAt));
  failedAt[3] = NOW + 6.5 * MIN;
  await h.round(7, state(failedAt));
  await h.round(10);
  assert.equal((await h.notices()).length, 1, "十分钟内不追发");
  assert.deepEqual((await h.store.snapshot()).failures.s1.pending, ["2", "3"]);

  const restarted = harness({ initial: state(failedAt), store: h.store, clockAt: NOW + 12 * MIN });
  await restarted.scan();
  assert.equal((await restarted.notices()).length, 1);
  restarted.time(NOW + 5 * MIN + FAIL_NOTIFY_GAP_MS);
  await restarted.scan();
  let list = await restarted.notices();
  assert.deepEqual(list.map((n) => [n.title, n.jobIds]), [["2 个作业失败", ["3", "2"]], ["作业失败：stage_1", ["1"]]]);
  assert.equal((await restarted.store.snapshot()).failures.s1.pending, undefined);

  // 又一个紧接着失败、还攒着的时候把失败提醒关了：不再提醒，重新打开也不补。
  failedAt[4] = NOW + 16 * MIN;
  restarted.jobs(state(failedAt));
  restarted.time(NOW + 17 * MIN);
  await restarted.scan();
  assert.deepEqual((await restarted.store.snapshot()).failures.s1.pending, ["4"]);
  await restarted.rules({ failNotify: false });
  restarted.time(NOW + 30 * MIN);
  await restarted.scan();
  await restarted.rules({ failNotify: true });
  restarted.time(NOW + 40 * MIN);
  await restarted.scan();
  list = await restarted.notices();
  assert.equal(list.length, 2);
  assert.equal((await restarted.store.snapshot()).failures.s1.pending, undefined);
});

// ---- 规则与接口 ----

test("规则：默认值、保存、非法输入被拒且不留半截；视图带 rules 与建议前缀，全局视图按服务器列出", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "cfdauto_setup_0001" }), job("2", "COMPLETED", { name: "cfdauto_setup_0002", at: NOW - MIN }), job("3", "RUNNING", { name: "xp_wallgate_7" })] });
  h.names.push({ id: "1", name: "cfdauto_setup_0001" }, { id: "800", name: "cfdauto_setup_0800" }, { id: "801", name: "cfa-agiter20-35607b-cfd1" });
  let v = await h.service.view("s1");
  assert.deepEqual(v.rules, { failNotify: true, longRunMinutes: null, patterns: [] });
  assert.deepEqual(v.suggestions, [
    { prefix: "cfdauto_setup", pattern: "cfdauto_setup*", count: 3 },
    { prefix: "cfa-agiter20", pattern: "cfa-agiter20*", count: 1 },
    { prefix: "xp_wallgate", pattern: "xp_wallgate*", count: 1 },
  ]);
  assert.deepEqual(Object.keys(v.settings).sort(), ["limitMinutes", "quietUntil", "silenceMinutes"], "规则不混在 settings 里");

  const global = await h.service.view();
  assert.deepEqual(global.servers.map((s) => [s.serverId, s.name, s.rules.failNotify, s.suggestions.length]), [["s1", "主集群服务器 (cluster)", true, 3]]);

  for (const [body, message] of [
    [{ action: "rules" }, /未指定/],
    [{ action: "rules", failNotify: "on" }, /开或关/],
    [{ action: "rules", longRunMinutes: 5 }, /10–10080/],
    [{ action: "rules", patterns: ["ok_*", ""] }, /不能为空/],
    [{ action: "rules", patterns: ["x".repeat(65)] }, /最多 64 个字符/],
    [{ action: "rules", patterns: Array.from({ length: 13 }, (_, i) => `p${i}`) }, /最多 12 条/],
    [{ action: "rules", patterns: ["a", "a"] }, /重复/],
    [{ action: "rules", failNotify: false, patterns: "nope" }, /必须是列表/],
  ]) {
    await assert.rejects(h.service.change("s1", body), (error) => error.status === 400 && message.test(error.message), JSON.stringify(body));
  }
  await assert.rejects(h.service.change(null, { action: "rules", failNotify: false }), /需要 serverId/);
  await assert.rejects(h.service.change("nope", { action: "rules", failNotify: false }), (error) => error.status === 404);
  assert.deepEqual((await h.service.view("s1")).rules, { failNotify: true, longRunMinutes: null, patterns: [] }, "被拒的请求什么都没改");
  assert.equal((await h.store.snapshot()).settings.s1, undefined);

  v = await h.rules({ patterns: ["cfdauto_*"], longRunMinutes: 120 });
  assert.deepEqual(v.rules, { failNotify: true, longRunMinutes: 120, patterns: ["cfdauto_*"] });
  assert.deepEqual(v.suggestions.map((s) => s.prefix), ["cfa-agiter20", "xp_wallgate"], "已有规则管着的名字不再建议");
  // 进度提醒设置与规则各存各的，互不覆盖。
  await h.service.change("s1", { action: "settings", silenceMinutes: 45 });
  v = await h.service.view("s1");
  assert.deepEqual([v.settings.silenceMinutes, v.rules.patterns], [45, ["cfdauto_*"]]);
  await h.rules({ failNotify: false });
  assert.equal((await h.service.view("s1")).settings.silenceMinutes, 45);
});

// ---- 自动关注 ----

test("自动关注：名字规则命中的在跑作业进组，每条规则一组并带 auto 标记；排队的、已结束的、手动关注着的不收；每个作业只进一个组", async () => {
  const h = harness({ initial: [
    job("1", "RUNNING", { name: "cfa-a-1f2e3d-cfd1" }), job("2", "PENDING", { name: "cfa-b-4a5b6c-mesh" }), job("3", "RUNNING", { name: "xp_wallgate" }),
    job("4", "COMPLETED", { name: "xp_done", at: NOW - MIN }), job("5", "RUNNING", { name: "other" }), job("6", "RUNNING", { name: "xp_manual" }), job("7_[1-9]", "PENDING", { name: "xp_array" }),
  ] });
  await h.service.change("s1", { action: "watch", jobIds: ["6"], label: "手动" });
  const saved = await h.rules({ patterns: ["cfa-*-cfd1", "cfa-*", "xp_*"] });
  assert.deepEqual(saved.watches.map((w) => w.label), ["手动"], "还没收进作业的自动组不显示");
  h.logs.set("1", { mt: NOW, sz: 100 });
  await h.scan();
  const watches = await h.watches();
  assert.deepEqual(watches.map((w) => [w.label, w.auto?.rule ?? null, w.jobIds]), [
    ["手动", null, ["6"]],
    ["cfa-*-cfd1", "name:cfa-*-cfd1", ["1"]],
    ["xp_*", "name:xp_*", ["3"]],
  ], "2 号还在排队：不占名额，cfa-* 那一组暂时是空的、不显示");
  assert.deepEqual(h.calls.at(-1).jobs.map((j) => j.id), ["6", "1", "3"], "进组的同一轮就读日志（同一次 SSH），手动关注的排在前面");
  assert.equal(watches[1].jobs[0].progress.status, "ok", "与手动关注同一套采集");
  assert.deepEqual(await h.notices(), [], "进组本身不提醒");
  await h.scan();
  assert.deepEqual((await h.watches()).map((w) => w.jobIds), [["6"], ["1"], ["3"]], "重复扫描不重复收");
  // 2 号开始跑了才进组（归它先命中的 cfa-*，而不是后面的规则）。
  const started = [
    job("1", "RUNNING", { name: "cfa-a-1f2e3d-cfd1" }), job("2", "RUNNING", { name: "cfa-b-4a5b6c-mesh" }), job("3", "RUNNING", { name: "xp_wallgate" }),
    job("4", "COMPLETED", { name: "xp_done", at: NOW - MIN }), job("5", "RUNNING", { name: "other" }), job("6", "RUNNING", { name: "xp_manual" }), job("7_[1-9]", "PENDING", { name: "xp_array" }),
  ];
  await h.round(5, started);
  assert.deepEqual((await h.watches()).map((w) => [w.label, w.jobIds]), [["手动", ["6"]], ["cfa-*-cfd1", ["1"]], ["cfa-*", ["2"]], ["xp_*", ["3"]]]);

  // 手动关注一个已被自动关注的作业：由手动组接管，自动组里拿掉。
  await h.service.change("s1", { action: "watch", jobIds: ["3"], label: "接管" });
  assert.deepEqual((await h.watches()).map((w) => [w.label, w.jobIds]), [["手动", ["6"]], ["接管", ["3"]], ["cfa-*-cfd1", ["1"]], ["cfa-*", ["2"]]]);
  await h.scan();
  assert.equal((await h.watches()).some((w) => w.auto && w.jobIds.includes("3")), false, "手动关注着的不再被自动组收回去");
});

test("自动关注：长作业阈值——运行超过 N 分钟才进组；改阈值只改组名", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { elapsedMin: 119 }), job("2", "RUNNING", { elapsedMin: 121 }), job("3", "PENDING")] });
  await h.rules({ longRunMinutes: 120 });
  await h.scan();
  assert.deepEqual((await h.watches()).map((w) => [w.label, w.auto.rule, w.jobIds]), [["运行超过 120 分钟的作业", "longRun", ["2"]]]);
  await h.round(5, [job("1", "RUNNING", { elapsedMin: 124 }), job("2", "RUNNING", { elapsedMin: 126 }), job("3", "PENDING")]);
  assert.deepEqual((await h.watches())[0].jobIds, ["2", "1"]);
  const renamed = await h.rules({ longRunMinutes: 60 });
  assert.deepEqual(renamed.watches.map((w) => [w.label, w.jobIds]), [["运行超过 60 分钟的作业", ["2", "1"]]]);
  const cleared = await h.rules({ longRunMinutes: null });
  assert.deepEqual(cleared.watches, []);
});

test("自动组不报开始运行与单个结束；规则名下没有在跑 / 排队的作业并安静 5 分钟后，这一批合成一条，且两批之间有最短间隔", async () => {
  const h = harness({ initial: [job("1", "PENDING", { name: "cfd_a" }), job("2", "RUNNING", { name: "cfd_b" }), job("9", "RUNNING", { name: "plain" })] });
  await h.rules({ patterns: ["cfd_*"], failNotify: false });
  await h.scan();
  await h.round(5, [job("1", "RUNNING", { name: "cfd_a" }), job("2", "RUNNING", { name: "cfd_b" }), job("9", "RUNNING", { name: "plain" })]);
  await h.service.observeQueue("s1", { state: "ok", user: "me", jobs: [{ ...job("1", "RUNNING", { name: "cfd_a" }), user: "me" }] });
  assert.deepEqual(await h.notices(), [], "排队转运行不提醒");
  await h.round(10, [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 8 * MIN }), job("2", "RUNNING", { name: "cfd_b" }), job("9", "RUNNING", { name: "plain" })]);
  assert.deepEqual(await h.notices(), [], "组里还有在跑的：单个结束不提醒");
  // 快结束的短作业两轮之间跑完，从没被收进组，也算这一批的。
  const done = [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 8 * MIN }), job("2", "FAILED", { name: "cfd_b", at: NOW + 13 * MIN }), job("3", "CANCELLED", { name: "cfd_quick", at: NOW + 14 * MIN }), job("9", "RUNNING", { name: "plain" })];
  await h.round(15, done);
  assert.deepEqual(await h.notices(), [], "刚安静下来，先等一等（流水线两段之间的空当不算结束）");
  h.time(NOW + 15 * MIN + AUTO_SETTLE_MS - 1000);
  await h.scan();
  assert.deepEqual(await h.notices(), []);
  await h.round(20);
  let list = await h.notices();
  assert.deepEqual(list.map((n) => [n.kind, n.title, n.body]), [["ended", "cfd_* 这一批已全部结束", "3 个作业：1 完成 · 1 失败 · 1 取消。可在作业历史查看原因与资源复盘。"]]);
  assert.deepEqual(list[0].jobIds, ["3", "2", "1"]);
  assert.equal(list[0].watchId, (await h.watches())[0].id);
  await h.round(25);
  assert.equal((await h.notices()).length, 1, "报过的不再报");

  // 下一批很快也结束了：还在最短间隔内，先不发；到点后一条带上。
  await h.round(26, [...done, job("4", "RUNNING", { name: "cfd_c" })]);
  await h.round(30, [...done, job("4", "COMPLETED", { name: "cfd_c", at: NOW + 28 * MIN })]);
  await h.round(36);
  assert.equal((await h.notices()).length, 1, "安静够了，但离上一条不到半小时");
  h.time(NOW + 20 * MIN + AUTO_NOTIFY_GAP_MS);
  await h.scan();
  list = await h.notices();
  assert.deepEqual(list.map((n) => n.body.slice(0, 12)), ["1 个作业：1 完成 ·", "3 个作业：1 完成 ·"]);
});

test("自动组的「这一批结束」已经带到的失败作业，失败提醒不再单独提（同一轮的、攒着还没发的都是）", async () => {
  // 同一轮：安静等待期间又有一个命中规则的作业跑完并失败了，这一轮「这一批结束」把它带上。
  const h = harness({ initial: [job("1", "RUNNING", { name: "cfd_a" }), job("2", "RUNNING", { name: "cfd_b" })] });
  await h.rules({ patterns: ["cfd_*"] });
  await h.scan();
  const done = [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 3 * MIN }), job("2", "COMPLETED", { name: "cfd_b", at: NOW + 8 * MIN })];
  await h.round(10, done);
  await h.round(16, [...done, job("3", "FAILED", { name: "cfd_quick", at: NOW + 14 * MIN })]);
  let list = await h.notices();
  assert.deepEqual(list.map((n) => [n.kind, n.body.split("。")[0]]), [["ended", "3 个作业：2 完成 · 1 失败 · 0 取消"]]);
  await h.round(30);
  assert.equal((await h.notices()).length, 1, "之后也不补一条失败提醒");
  assert.ok(Object.hasOwn((await h.store.snapshot()).failures.s1.seen, "3"));

  // 攒着的：先有一条失败提醒，十分钟内规则名下的作业也失败了（攒着），随后「这一批结束」把它带到 → 不再单独发。
  const g = harness({ initial: [job("1", "RUNNING", { name: "other" }), job("2", "RUNNING", { name: "cfd_a" })] });
  await g.rules({ patterns: ["cfd_*"] });
  await g.scan();
  await g.round(5, [job("1", "FAILED", { name: "other", at: NOW + 4 * MIN }), job("2", "RUNNING", { name: "cfd_a" })]);
  const both = [job("1", "FAILED", { name: "other", at: NOW + 4 * MIN }), job("2", "FAILED", { name: "cfd_a", at: NOW + 6 * MIN })];
  await g.round(7, both);
  assert.deepEqual((await g.store.snapshot()).failures.s1.pending, ["2"]);
  await g.round(13);
  list = await g.notices();
  assert.deepEqual(list.map((n) => [n.kind, n.jobIds]), [["ended", ["2"]], ["failed", ["1"]]]);
  assert.equal((await g.store.snapshot()).failures.s1.pending, undefined);
  await g.round(30);
  assert.equal((await g.notices()).length, 2);
});

test("自动组的「这一批结束」：还有排队的不算结束；快照没拿全时不下结论；静音时不发也不攒到以后", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "cfd_a" }), job("2_[1-4]", "PENDING", { name: "cfd_array" })] });
  await h.rules({ patterns: ["cfd_*"], failNotify: false });
  await h.scan();
  const waiting = [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 2 * MIN }), job("2_[1-4]", "PENDING", { name: "cfd_array" })];
  await h.round(5, waiting);
  await h.round(15);
  assert.deepEqual(await h.notices(), [], "数组作业还在排队（没有具体作业号、进不了组），但这条规则名下并没有结束");

  const drained = [job("1", "COMPLETED", { name: "cfd_a", at: NOW + 2 * MIN }), job("2_1", "COMPLETED", { name: "cfd_array", at: NOW + 18 * MIN })];
  h.truncated(true);
  await h.round(20, drained);
  await h.round(30);
  assert.deepEqual(await h.notices(), [], "这一轮 sacct 没拿全");
  h.truncated(false);
  const group = (await h.watches())[0];
  await h.service.change("s1", { action: "mute", watchId: group.id, muted: true });
  await h.round(35);
  await h.round(45);
  assert.deepEqual(await h.notices(), []);
  await h.service.change("s1", { action: "mute", watchId: group.id, muted: false });
  await h.round(50);
  await h.round(60);
  assert.deepEqual(await h.notices(), [], "静音期间结束的那一批不会在取消静音后补发");
});

test("自动组的疑似停滞：同一轮合成一条；半小时内再有新的先不发，到点后连同之后的合成一条", async () => {
  const running = ["1", "2", "3"].map((id) => job(id, "RUNNING", { name: `xp_${id}` }));
  const h = harness({ initial: running });
  await h.rules({ patterns: ["xp_*"] });
  await h.service.change("s1", { action: "settings", silenceMinutes: 10 });
  const touch = (...ids) => { for (const id of ids) h.logs.set(id, { mt: h.now(), sz: (h.logs.get(id)?.sz ?? 0) + 100 }); };
  h.time(NOW); touch("1", "2", "3");
  await h.scan();
  // 作业 1 从一开始就不动；2、3 的日志一直在长。
  for (const minutes of [5, 10]) { h.time(NOW + minutes * MIN); touch("2", "3"); await h.scan(); }
  let list = await h.notices("stalled");
  assert.deepEqual(list.map((n) => [n.title, n.jobIds]), [["xp_* 日志长时间未更新", ["1"]]]);
  // 作业 2 也停了（10 分钟后判出），这时离上一条才 15 分钟。
  for (const minutes of [15, 20, 25]) { h.time(NOW + minutes * MIN); touch("3"); await h.scan(); }
  assert.equal((await h.notices("stalled")).length, 1, "间隔内不追发");
  assert.equal((await h.watches())[0].jobs.find((j) => j.id === "2").progress.status, "stalled", "界面上照常显示疑似停滞");
  // 作业 3 也停了；到了间隔，2 和 3 合成一条。
  for (const minutes of [30, 35]) { h.time(NOW + minutes * MIN); await h.scan(); }
  h.time(NOW + 10 * MIN + AUTO_NOTIFY_GAP_MS);
  await h.scan();
  list = await h.notices("stalled");
  assert.deepEqual(list.map((n) => n.jobIds), [["2", "3"], ["1"]]);
  assert.match(list[0].body, /^2 个运行中的作业连续 10 分钟没有日志变化/);
  h.time(NOW + 45 * MIN + AUTO_NOTIFY_GAP_MS);
  await h.scan();
  assert.equal((await h.notices("stalled")).length, 2, "提醒过的不再提");
});

test("自动组的子任务非零退出：进组之后的才提醒，同一轮合成一条，半小时内再有新的并到下一条", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_orch" })] });
  await h.rules({ patterns: ["xp_*"] });
  // 调度器 stdout 里的时间写法；偏移量按行累加，模拟远端按游标增量读。
  const at = (ms) => `${new Date(ms + 8 * 3600000).toISOString().slice(0, 19)}+0800`;
  let offset = 0;
  const feed = (events) => {
    const from = offset;
    const ev = events.map(([type, run, code, when], i) => [from + i * 10, at(when), type, run, "train", type === "E" ? code : null]);
    offset = from + events.length * 10;
    h.logs.set("1", { mt: h.now(), sz: 100 + offset });
    h.extra.push(JSON.stringify({ k: "subruns", id: "1", p: "/logs/1.log", cid: "5:6", from, off: offset, sz: offset, mt: h.now() / 1000 - 60, gap: null, more: false, ev, logs: [], rn: h.now() / 1000 }));
  };
  // 进组那一轮（NOW）：stdout 里已有一个早先失败的子任务（进组 10 分钟前）——只显示，不提醒。
  feed([["L", "OLD_s1", null, NOW - 30 * MIN], ["E", "OLD_s1", 1, NOW - 10 * MIN], ["L", "A_s1", null, NOW - MIN]]);
  await h.scan();
  assert.deepEqual(await h.notices(), []);
  h.time(NOW + 5 * MIN);
  feed([["E", "A_s1", 1, NOW + 3 * MIN], ["L", "B_s1", null, NOW + 3 * MIN]]);
  await h.scan();
  let list = await h.notices("subrun-failed");
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "xp_* 有子任务失败");
  assert.match(list[0].body, /^1 · A_s1 train（退出码 1）。/);
  assert.doesNotMatch(list[0].body, /OLD_s1/);
  assert.equal((await h.watches())[0].jobs[0].subruns.failed, 2, "界面上的失败数照实是两个");

  h.time(NOW + 10 * MIN);
  feed([["E", "B_s1", 2, NOW + 8 * MIN], ["L", "C_s1", null, NOW + 8 * MIN]]);
  await h.scan();
  h.time(NOW + 20 * MIN);
  feed([["E", "C_s1", -9, NOW + 18 * MIN]]);
  await h.scan();
  assert.equal((await h.notices("subrun-failed")).length, 1, "半小时内不追发");
  h.time(NOW + 5 * MIN + AUTO_NOTIFY_GAP_MS);
  feed([]);
  await h.scan();
  list = await h.notices("subrun-failed");
  assert.equal(list.length, 2);
  assert.match(list[0].body, /1 · B_s1 train（退出码 2）；1 · C_s1 train（退出码 -9）/);
  h.time(NOW + 10 * MIN + 2 * AUTO_NOTIFY_GAP_MS);
  feed([]);
  await h.scan();
  assert.equal((await h.notices("subrun-failed")).length, 2, "提醒过的不再提");
});

test("自动组的临近时限：同一轮合成一条，十分钟内再有新的并到下一条", async () => {
  const h = harness({ initial: ["1", "2", "3"].map((id) => job(id, "RUNNING", { name: `xp_${id}` })) });
  await h.rules({ patterns: ["xp_*"] });
  await h.scan();
  const queue = (elapsed) => ({ state: "ok", user: "me", jobs: Object.entries(elapsed).map(([id, sec]) => ({ ...job(id, "RUNNING", { name: `xp_${id}` }), user: "me", timeLimitSec: 7200, elapsedSec: sec })) });
  await h.service.observeQueue("s1", queue({ 1: 5500, 2: 5000, 3: 5000 }));
  assert.deepEqual((await h.notices("limit")).map((n) => [n.title, n.jobIds]), [["xp_* 接近作业时限", ["1"]]]);
  h.time(NOW + 2 * MIN);
  await h.service.observeQueue("s1", queue({ 1: 5620, 2: 5500, 3: 5120 }));
  h.time(NOW + 6 * MIN);
  await h.service.observeQueue("s1", queue({ 1: 5860, 2: 5740, 3: 5450 }));
  assert.equal((await h.notices("limit")).length, 1, "十分钟内不追发");
  h.time(NOW + AUTO_LIMIT_GAP_MS);
  await h.service.observeQueue("s1", queue({ 1: 6000, 2: 5980, 3: 5690 }));
  const list = await h.notices("limit");
  assert.deepEqual(list.map((n) => n.jobIds), [["2", "3"], ["1"]]);
  h.time(NOW + 2 * AUTO_LIMIT_GAP_MS);
  await h.service.observeQueue("s1", queue({ 1: 6600, 2: 6580, 3: 6290 }));
  assert.equal((await h.notices("limit")).length, 2);
});

test("名额：自动关注合计 60 个，在跑的先进；结束的腾出位置后新的才进来，结束最久的先走", async () => {
  const many = (states) => states.map(([id, state, at]) => job(String(id), state, { name: `job_${id}`, at: at ?? null, submitAt: NOW - 3600000 + id }));
  const all = Array.from({ length: 70 }, (_, i) => [i + 1, i < 65 ? "RUNNING" : "PENDING"]);
  const h = harness({ initial: [...many(all.slice(65)), ...many(all.slice(0, 65))] });
  await h.rules({ patterns: ["job_*"], failNotify: false });
  await h.scan();
  let ids = (await h.watches())[0].jobIds;
  assert.equal(ids.length, 60);
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 60 }, (_, i) => String(i + 1)), "在跑的按提交先后收满，排队的等名额");
  await h.round(5);
  assert.equal((await h.watches())[0].jobIds.length, 60, "没有结束的可挤，就不再收");

  // 1–5 号结束（3 号结束得最早），66–70 号开始跑。
  const next = all.map(([id]) => (id <= 5 ? [id, "COMPLETED", NOW + (id === 3 ? 6 : 7) * MIN + id] : [id, "RUNNING"]));
  await h.round(10, many(next));
  ids = (await h.watches())[0].jobIds;
  assert.equal(ids.length, 60);
  assert.deepEqual(ids.filter((id) => Number(id) > 60).sort(), ["61", "62", "63", "64", "65"]);
  assert.deepEqual(ids.filter((id) => Number(id) <= 5), [], "刚结束的 5 个被 5 个在跑的挤掉了");
  assert.equal(ids.length - new Set(ids).size, 0);

  // 结束的那些腾出来之后，66–70 才陆续进来。
  const later = all.map(([id]) => (id <= 10 ? [id, "COMPLETED", NOW + 12 * MIN + id] : [id, "RUNNING"]));
  await h.round(15, many(later));
  ids = (await h.watches())[0].jobIds;
  assert.deepEqual(ids.filter((id) => Number(id) > 65).sort(), ["66", "67", "68", "69", "70"]);
  assert.equal(ids.length, 60);
  assert.deepEqual(await h.notices(), []);
});

test("名额：手动关注不被自动关注挤占——自动只用手动剩下的名额；手动撞上限时先腾自动的（组与作业都是）", async () => {
  const all = Array.from({ length: 260 }, (_, i) => job(String(i + 1), "RUNNING", { name: `job_${i + 1}`, submitAt: NOW - 3600000 + i }));
  const h = harness({ initial: all });
  const ids = (from, count) => Array.from({ length: count }, (_, i) => String(from + i));
  await h.rules({ patterns: ["job_*"], failNotify: false });
  await h.scan();
  const autoIds = async () => (await h.watches()).find((w) => w.auto)?.jobIds ?? [];
  assert.equal((await autoIds()).length, 60);

  // 手动关注 61–160 号（100 个）：加上自动的 60 个没超 200，谁也不用让。
  await h.service.change("s1", { action: "watch", jobIds: ids(61, 100), label: "手动一" });
  assert.equal((await autoIds()).length, 60);
  // 再手动关注 161–240 号（80 个）：总数会到 240，自动的让出 40 个。
  await h.service.change("s1", { action: "watch", jobIds: ids(161, 80), label: "手动二" });
  let watches = await h.watches();
  assert.deepEqual(watches.filter((w) => !w.auto).map((w) => w.jobIds.length), [100, 80]);
  assert.equal((await autoIds()).length, 20);
  await h.scan();
  assert.equal((await autoIds()).length, 20, "之后也只用剩下的 20 个名额");
  // 手动占满 200：自动关注一个不留；再多一个才报上限。
  await h.service.change("s1", { action: "watch", jobIds: ids(241, 20), label: "手动三" });
  assert.equal((await autoIds()).length, 0);
  await h.scan();
  assert.equal((await autoIds()).length, 0);
  await assert.rejects(h.service.change("s1", { action: "watch", jobIds: ["1"] }), (error) => error.status === 409 && /40 组 \/ 200 个作业/.test(error.message));
  assert.equal(jobTotal(await h.store.snapshot()), 200);

  // 组数：39 个手动组 + 1 个自动组时再加一个手动组，撤掉的是自动组。
  const g = harness({ initial: all });
  await g.rules({ patterns: ["job_2*"], failNotify: false });
  await g.scan();
  for (let i = 1; i <= 39; i += 1) await g.service.change("s1", { action: "watch", jobIds: [String(100 + i)] });
  assert.equal((await g.store.snapshot()).watches.length, 40);
  await g.service.change("s1", { action: "watch", jobIds: ["150"] });
  watches = (await g.store.snapshot()).watches;
  assert.deepEqual([watches.length, watches.filter((w) => w.auto).length], [40, 0]);
  await g.scan();
  assert.equal((await g.store.snapshot()).watches.filter((w) => w.auto).length, 0, "组数满着的时候自动组不会再挤回来");
  await assert.rejects(g.service.change("s1", { action: "watch", jobIds: ["151"] }), (error) => error.status === 409);
  assert.deepEqual((await g.service.view("s1")).rules.patterns, ["job_2*"], "规则还在，等手动关注少了会重新落组");
});

function jobTotal(data) {
  return data.watches.reduce((sum, w) => sum + w.jobs.length, 0);
}

test("自动组可静音；「取消关注」对自动组是停用这条规则；删掉规则组也跟着撤", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_a" }), job("2", "RUNNING", { name: "cfd_b", elapsedMin: 300 })] });
  await h.rules({ patterns: ["xp_*", "cfd_*"], longRunMinutes: 60 });
  await h.scan();
  let watches = await h.watches();
  assert.deepEqual(watches.map((w) => w.auto.rule), ["name:xp_*", "name:cfd_*"], "长作业规则名下没有别的作业（2 号已归名字规则），空组不显示");
  const muted = await h.service.change("s1", { action: "mute", watchId: watches[0].id, muted: true });
  assert.equal(muted.watches[0].muted, true);
  await h.round(5);
  assert.equal((await h.watches())[0].muted, true, "静音记在组上，之后的扫描不动它");

  const stopped = await h.service.change("s1", { action: "unwatch", watchId: watches[1].id });
  assert.deepEqual(stopped.rules.patterns, ["xp_*"]);
  // 名字规则没了，2 号（已运行 300 分钟）改由长作业规则收。
  await h.round(10);
  watches = await h.watches();
  assert.deepEqual(watches.map((w) => [w.auto.rule, w.jobIds]), [["name:xp_*", ["1"]], ["longRun", ["2"]]]);
  const noLong = await h.service.change("s1", { action: "unwatch", watchId: watches[1].id });
  assert.equal(noLong.rules.longRunMinutes, null);
  const none = await h.rules({ patterns: [] });
  assert.deepEqual(none.watches, []);
  await h.round(15);
  assert.deepEqual(await h.watches(), []);
  assert.deepEqual((await h.store.snapshot()).watches, []);
});

test("自动组里结束超过两天的作业不再留着；作业记录里两天没见到的也放掉", async () => {
  const h = harness({ initial: [job("1", "RUNNING", { name: "xp_a" }), job("2", "RUNNING", { name: "xp_b" }), job("3", "RUNNING", { name: "xp_c" })] });
  await h.rules({ patterns: ["xp_*"], failNotify: false });
  await h.scan();
  // 1 号结束；2 号从作业记录里消失（比如电脑关了几天，回来时它早已不在两天的窗口里）；3 号一直在跑。
  const HOUR = 60 * MIN;
  await h.round(60, [job("1", "COMPLETED", { name: "xp_a", at: NOW + 30 * MIN }), job("3", "RUNNING", { name: "xp_c" })]);
  h.time(NOW + 47 * HOUR);
  await h.scan();
  assert.deepEqual((await h.watches())[0].jobIds, ["2", "3", "1"]);
  h.time(NOW + 49 * HOUR);
  await h.scan();
  assert.deepEqual((await h.watches())[0].jobIds, ["3"]);
});

test("日志采样：手动关注的先读；自动关注的轮着读，窗口随轮转放宽，照样判得出疑似停滞", async () => {
  // 5 个手动 + 50 个自动在跑：一轮读 20 个 = 5 个手动 + 15 个自动，自动的 4 轮轮一遍（20 分钟一次）。
  const all = Array.from({ length: 55 }, (_, i) => job(String(i + 1), "RUNNING", { name: i < 5 ? `manual_${i + 1}` : `xp_${i + 1}` }));
  const h = harness({ initial: all });
  await h.service.change("s1", { action: "watch", jobIds: ["1", "2", "3", "4", "5"], label: "手动" });
  await h.rules({ patterns: ["xp_*"] });
  await h.service.change("s1", { action: "settings", silenceMinutes: 30 });
  for (const j of all) h.logs.set(j.id, { mt: NOW, sz: 100 }); // 所有日志从头到尾都不变
  const sampled = [];
  for (let round = 0; round <= 8; round += 1) {
    h.time(NOW + round * 5 * MIN);
    await h.scan();
    sampled.push(h.calls.at(-1).jobs.map((j) => Number(j.id)));
  }
  for (const ids of sampled) {
    assert.equal(ids.length, 20);
    assert.deepEqual(ids.slice(0, 5).sort((a, b) => a - b), [1, 2, 3, 4, 5], "手动关注的每轮都读");
  }
  assert.equal(new Set(sampled.slice(0, 4).flatMap((ids) => ids.slice(5))).size, 50, "四轮把自动关注的轮一遍");
  const watches = await h.watches();
  const manual = watches.find((w) => !w.auto).jobs;
  const auto = watches.find((w) => w.auto).jobs;
  assert.ok(manual.every((j) => j.progress.status === "stalled"));
  // 每个自动关注的作业隔 15–20 分钟读到一次：这样也算连得上。9 轮共读 135 次，读到第三次的 35 个已满 30 分钟。
  assert.equal(auto.filter((j) => j.progress.status === "stalled").length, 35);
  assert.equal(auto.filter((j) => j.progress.status === "stale").length, 0, "没轮到的不算采样过期");
  let stalled = await h.notices("stalled");
  // 最先判出的那一轮发了一条；之后几轮判出的还在半小时间隔内，先攒着。
  assert.deepEqual(stalled.map((n) => n.title).sort(), ["xp_* 日志长时间未更新", "手动 日志长时间未更新"]);
  assert.equal(stalled.find((n) => n.title.startsWith("手动")).jobIds.length, 5);
  const first = stalled.find((n) => n.title.startsWith("xp_*"));
  assert.ok(first.jobIds.length > 0 && first.jobIds.length < 35, `头一条带了 ${first.jobIds.length} 个`);

  // 到了间隔：这一轮把组里所有还没提过的一起带上，而不是只带这一轮读到的 15 个。
  for (let round = 9; round <= 12; round += 1) {
    h.time(NOW + round * 5 * MIN);
    await h.scan();
  }
  stalled = (await h.notices("stalled")).filter((n) => n.title.startsWith("xp_*"));
  assert.equal(stalled.length, 2);
  const second = stalled.find((n) => n.id !== first.id);
  const stalledNow = (await h.watches()).find((w) => w.auto).jobs.filter((j) => j.progress.status === "stalled").map((j) => j.id);
  assert.equal(stalledNow.length, 50, "一小时后 50 个都判出来了");
  assert.deepEqual([...first.jobIds, ...second.jobIds].sort(), [...stalledNow].sort(), "两条合起来正好是全部，谁也没提两遍");
});

test("稳态不写盘：规则在、作业状态没变、没有在跑的要读日志时，每轮扫描与每分钟的队列观察都不重写文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-rules-idle-"));
  const writes = [];
  const fs = { ...nodeFsPromises, rename: async (from, to) => { await nodeFsPromises.rename(from, to); writes.push(path.basename(String(to))); } };
  const count = () => writes.filter((name) => name === JOB_WATCH_FILE).length;
  try {
    let clock = NOW;
    const store = createJobWatchStore({ filePath: path.join(dir, JOB_WATCH_FILE), now: () => clock, fs });
    const pending = [job("1", "PENDING", { name: "xp_a" }), job("2", "PENDING", { name: "xp_b" }), job("3", "FAILED", { name: "old", at: NOW - 3600000 })];
    const h = harness({ initial: pending, store });
    await h.rules({ patterns: ["xp_*"], longRunMinutes: 120 });
    await h.scan();
    const settled = count();
    assert.ok(settled >= 1);
    for (let minute = 1; minute <= 30; minute += 1) {
      clock = NOW + minute * MIN;
      h.time(clock);
      await h.service.observeQueue("s1", { state: "ok", user: "me", jobs: pending.slice(0, 2).map((j) => ({ ...j, user: "me", timeLimitSec: 7200 })) });
      if (minute % 5 === 0) await h.scan();
    }
    assert.equal(count(), settled, "30 分钟里什么都没变（规则在、命中的作业都还排着），一次也不该写");
    // 作业开始跑、被收进组才写；之后每分钟的队列观察状态没变，照样不写。
    clock = NOW + 31 * MIN;
    h.time(clock);
    h.jobs([job("1", "RUNNING", { name: "xp_a" }), pending[1], pending[2]]);
    await h.scan();
    const admitted = count();
    assert.ok(admitted > settled);
    for (let minute = 32; minute <= 34; minute += 1) {
      clock = NOW + minute * MIN;
      h.time(clock);
      await h.service.observeQueue("s1", { state: "ok", user: "me", jobs: [{ ...job("1", "RUNNING", { name: "xp_a" }), user: "me", timeLimitSec: 7200 }, { ...pending[1], user: "me", timeLimitSec: 7200 }] });
    }
    assert.equal(count(), admitted);
    // 重启后读回来的内容与内存一致：规则、自动组、失败基线都在。
    const reloaded = await createJobWatchStore({ filePath: path.join(dir, JOB_WATCH_FILE), now: () => clock }).snapshot();
    assert.deepEqual(reloaded.settings.s1.rules, { failNotify: true, longRunMinutes: 120, patterns: ["xp_*"] });
    assert.deepEqual(reloaded.watches.map((w) => [w.auto.rule, w.jobs.map((j) => [j.id, j.state])]), [["name:xp_*", [["1", "RUNNING"]]], ["longRun", []]]);
    assert.deepEqual(Object.keys(reloaded.failures.s1.seen), ["3"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
