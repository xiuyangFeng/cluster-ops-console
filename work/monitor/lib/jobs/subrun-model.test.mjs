import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubrunRecord, estimateEta, finalizeSubruns, parseEpochLines, parseStamp, parseSubrunRecord,
  SUBRUN_MAX_RUNS, subrunActivity, subrunFailures, subrunPayload, subrunView,
} from "./subrun-model.mjs";

const NOW = Date.parse("2026-10-06T14:20:00+08:00");
const ctx = { now: NOW, serverId: "s1", jobId: "18764" };

// 真实 stdout（2026-10-06 wallgate_vol xp_18764.log）裁剪到前 26 条事件并脱敏：GPU UUID → GPU-0、用户名 → user、主机名 → node。
const XP_FIXTURE = `2026-10-05T17:02:29-07:00
node
index, uuid, name, memory.used [MiB], memory.total [MiB]
0, GPU-0, NVIDIA GeForce RTX 4090, 5 MiB, 24564 MiB
MPS daemon on GPU-0 (/tmp/xp_mps_user_18764/GPU-0/pipe)
2026-10-06T08:02:31+0800 LAUNCH PFG_f0_s1234 train GPU-0
2026-10-06T08:03:16+0800 LAUNCH PFG_f1_s1234 train GPU-0
2026-10-06T08:49:59+0800 END PFG_f1_s1234 train 0
2026-10-06T08:49:59+0800 LAUNCH PFG_f1_s1234 eval_best GPU-0
2026-10-06T08:51:04+0800 END PFG_f0_s1234 train 0
2026-10-06T08:51:04+0800 LAUNCH PFG_f0_s1234 eval_best GPU-0
2026-10-06T08:52:59+0800 END PFG_f1_s1234 eval_best 0
2026-10-06T08:52:59+0800 LAUNCH PFG_f1_s1234 eval_last GPU-0
2026-10-06T08:53:39+0800 END PFG_f0_s1234 eval_best 0
2026-10-06T08:53:39+0800 LAUNCH PFG_f0_s1234 eval_last GPU-0
2026-10-06T08:55:54+0800 END PFG_f1_s1234 eval_last 0
2026-10-06T08:55:54+0800 LAUNCH PFG_f2_s1234 train GPU-0
2026-10-06T08:56:14+0800 END PFG_f0_s1234 eval_last 0
2026-10-06T08:56:39+0800 LAUNCH PFG_f3_s1234 train GPU-0
2026-10-06T09:43:37+0800 END PFG_f2_s1234 train 0
2026-10-06T09:43:37+0800 LAUNCH PFG_f2_s1234 eval_best GPU-0
2026-10-06T09:45:07+0800 END PFG_f3_s1234 train 0
2026-10-06T09:45:07+0800 LAUNCH PFG_f3_s1234 eval_best GPU-0
2026-10-06T09:46:02+0800 END PFG_f2_s1234 eval_best 0
2026-10-06T09:46:02+0800 LAUNCH PFG_f2_s1234 eval_last GPU-0
2026-10-06T09:47:27+0800 END PFG_f3_s1234 eval_best 0
2026-10-06T09:47:27+0800 LAUNCH PFG_f3_s1234 eval_last GPU-0
2026-10-06T09:48:23+0800 END PFG_f2_s1234 eval_last 0
2026-10-06T09:48:23+0800 LAUNCH PFG_f4_s1234 train GPU-0
2026-10-06T09:49:48+0800 END PFG_f3_s1234 eval_last 0
2026-10-06T09:49:48+0800 LAUNCH PFGV_f0_s1234 train GPU-0
`;

// 与远端 subrun_scan 同口径的本地模拟：从 from 起只取完整行里的事件，带字节偏移。
function fakeRecord(text, { from = 0, cid = "1:2", path = "/exp/logs/xp_18764.log", gap = null, logs = [], kind = "subruns", rn = NOW / 1000 } = {}) {
  const buf = Buffer.from(text);
  const end = buf.lastIndexOf(10) + 1;
  const ev = [];
  let pos = from;
  while (pos < end) {
    const nl = buf.indexOf(10, pos);
    const line = buf.subarray(pos, nl).toString();
    const m = /^(\S+) (LAUNCH|END) (\S+) (\S+) (\S+)$/.exec(line);
    if (m) ev.push([pos, m[1], m[2] === "LAUNCH" ? "L" : "E", m[3], m[4], m[2] === "END" ? Number(m[5]) : null]);
    pos = nl + 1;
  }
  return parseSubrunRecord({ k: kind, id: "18764", p: path, cid, from, off: Math.max(from, end), sz: buf.length, mt: rn - 30, gap, more: false, ev, logs, rn });
}

test("真实格式回放：按 run+phase 配对，计数与人工一致；不推算总数", () => {
  const state = applySubrunRecord(null, fakeRecord(XP_FIXTURE), ctx);
  const view = subrunView(state, NOW);
  assert.equal(view.launched, 14);
  assert.equal(view.ended, 12);
  assert.equal(view.failed, 0);
  assert.equal(view.orphanEnds, 0);
  assert.deepEqual(view.running.map((r) => `${r.run} ${r.phase}`), ["PFG_f4_s1234 train", "PFGV_f0_s1234 train"]);
  assert.equal(view.runningCount, 2);
  assert.equal(parseStamp("2026-10-06T08:02:31+0800"), Date.parse("2026-10-06T00:02:31Z"));
  assert.equal(parseStamp("2026-10-06 08:02:31"), null);
});

test("增量游标：任意切点逐段读取与一次读完一致；重复投递 / 迟到记录按位置去重", () => {
  const whole = subrunView(applySubrunRecord(null, fakeRecord(XP_FIXTURE), ctx), NOW);
  for (const cut of [1, 333, 700, 1501, 2222]) {
    const first = fakeRecord(XP_FIXTURE.slice(0, cut));
    let state = applySubrunRecord(null, first, ctx);
    state = applySubrunRecord(state, first, ctx); // 重复投递：from 不等于已确认偏移 → 忽略
    const second = fakeRecord(XP_FIXTURE, { from: state.cursor.off });
    state = applySubrunRecord(state, second, ctx);
    state = applySubrunRecord(state, second, ctx);
    const view = subrunView(state, NOW);
    assert.deepEqual([view.launched, view.ended, view.running.length], [whole.launched, whole.ended, whole.running.length], `切点 ${cut}`);
  }
});

test("重试另计、同键重叠标无法配对、找不到启动的 END、非零与负数退出码都算失败", () => {
  const text = [
    "2026-10-06T08:00:00+0800 LAUNCH A train GPU-0",
    "2026-10-06T08:10:00+0800 END A train 1",
    "2026-10-06T08:11:00+0800 LAUNCH A train GPU-0",
    "2026-10-06T08:12:00+0800 LAUNCH B train GPU-0",
    "2026-10-06T08:13:00+0800 LAUNCH B train GPU-0",
    "2026-10-06T08:14:00+0800 END B train -15",
    "2026-10-06T08:15:00+0800 END C eval_best 2",
    "",
  ].join("\n");
  const state = applySubrunRecord(null, fakeRecord(text), ctx);
  const view = subrunView(state, NOW);
  assert.equal(view.launched, 4);
  assert.equal(view.ended, 3);
  assert.equal(view.failed, 3);
  assert.equal(view.orphanEnds, 1);
  assert.equal(view.ambiguous, 2, "B 的两次启动都标无法配对");
  const a2 = state.runs.find((r) => r.run === "A" && r.attempt === 2);
  assert.equal(a2.status, "running");
  assert.deepEqual(view.failedRuns.map((r) => [r.run, r.code, r.orphan]), [["C", 2, true], ["B", -15, false], ["A", 1, false]]);
  assert.equal(subrunFailures(state, Date.parse("2026-10-06T08:12:30+0800")).length, 2, "关注之前结束的失败不进提醒候选");
  assert.deepEqual(subrunPayload(state).open, [["A", "train"]]);
});

test("覆盖缺口：替换 / 截断清空重来，缺开头保留计数并提示；收尾把仍在跑的标为未见结束", () => {
  let state = applySubrunRecord(null, fakeRecord(XP_FIXTURE), ctx);
  state = applySubrunRecord(state, fakeRecord(XP_FIXTURE.slice(0, 600), { gap: "truncated" }), ctx);
  let view = subrunView(state, NOW);
  assert.equal(view.gaps[0].kind, "truncated");
  assert.ok(view.launched < 14);
  state = applySubrunRecord(state, fakeRecord(XP_FIXTURE, { cid: "9:9", gap: "replaced" }), ctx);
  view = subrunView(state, NOW);
  assert.equal(view.launched, 14);
  assert.deepEqual(view.gaps.map((g) => g.kind), ["truncated", "replaced"]);
  const head = applySubrunRecord(null, fakeRecord(XP_FIXTURE, { from: XP_FIXTURE.indexOf("2026-10-06T08:51:04"), gap: "head" }), ctx);
  view = subrunView(head, NOW);
  assert.equal(view.orphanEnds, 2, "开头缺失导致的结束记录只计数");
  assert.match(view.gaps[0].text, /更早的启动/);
  const done = finalizeSubruns(state, { now: NOW });
  view = subrunView(done, NOW);
  assert.equal(view.finalized, true);
  assert.deepEqual(view.unended.map((r) => r.run), ["PFG_f4_s1234", "PFGV_f0_s1234"]);
  // 收尾记录在最后补上 END：结束前再看到的就不是「未见结束」。
  const tail = `${XP_FIXTURE}2026-10-06T10:37:11+0800 END PFG_f4_s1234 train 0\n`;
  const finalRec = fakeRecord(tail, { from: state.cursor.off, cid: "9:9", kind: "subruns-final" });
  view = subrunView(applySubrunRecord(state, finalRec, ctx), NOW);
  assert.deepEqual(view.unended.map((r) => r.run), ["PFGV_f0_s1234"]);
});

test("远端记录不可信：坏 run 名、越界偏移、坏时间与退出码全部丢弃", () => {
  assert.equal(parseSubrunRecord({ k: "subruns", id: "1;rm", p: "/x", cid: "1:2", from: 0, off: 1 }), null);
  assert.equal(parseSubrunRecord({ k: "subruns", id: "1", p: "relative", cid: "1:2", from: 0, off: 1 }), null);
  assert.equal(parseSubrunRecord({ k: "subruns", id: "1", p: "/x", cid: "1:2", from: 5, off: 1 }), null);
  const r = parseSubrunRecord({ k: "subruns", id: "1", p: "/x", cid: "1:2", from: 10, off: 100, ev: [
    [5, "2026-10-06T08:00:00+0800", "L", "A", "train", null],
    [20, "2026-10-06T08:00:00+0800", "L", "../A", "train", null],
    [30, "2026-10-06T08:00:00", "L", "A", "train", null],
    [40, "2026-10-06T08:00:00+0800", "E", "A", "train", "0"],
    [50, "2026-10-06T08:00:00+0800", "L", "A", "train", null],
  ], logs: [{ r: "A", s: "x/y" }, { r: "A", s: "train", ep: ["epoch 1/2", 5], last: "x".repeat(900) }] });
  assert.deepEqual(r.events.map((e) => e.o), [50]);
  assert.equal(r.logs.length, 1);
  assert.equal(r.logs[0].last.length, 300);
  assert.deepEqual(r.logs[0].lines, ["epoch 1/2"]);
});

const TEXT_TAIL = [
  "23:50:58 INFO epoch 168/400 loss=0.1520 norm_mae=0.2270 norm_rmse=0.3380 lr=6.47e-04 | select=train_loss best_loss=0.1515",
  "23:51:53 INFO epoch 169/400 loss=0.1518 norm_mae=0.2268 norm_rmse=0.3377 lr=6.43e-04 | select=train_loss best_loss=0.1515",
  "23:52:48 INFO epoch 170/400 loss=0.1512 norm_mae=0.2262 norm_rmse=0.3371 lr=6.39e-04 | select=train_loss best_loss=0.1512 [best]",
  "23:53:43 INFO epoch 171/400 loss=0.1509 norm_mae=0.2259 norm_rmse=0.3368 lr=6.35e-04 | select=train_loss best_loss=0.1509 [best]",
  "23:54:36 INFO epoch 172/400 loss=0.1505 norm_mae=0.2256 norm_rmse=0.3364 lr=6.31e-04 | select=train_loss best_loss=0.1505 [best]",
];

test("训练日志：文本格式取 epoch/总数/指标，跨午夜展开；ETA 门槛（点数、总数、波动、回退）", () => {
  const { points } = parseEpochLines(["eval 写入: /x", ...TEXT_TAIL]);
  assert.equal(points.length, 5);
  assert.deepEqual(points.at(-1).metrics, { loss: 0.1505, norm_mae: 0.2256, norm_rmse: 0.3364, lr: 0.000631, best_loss: 0.1505 });
  assert.equal(points.at(-1).best, true);
  const eta = estimateEta(points);
  assert.ok(eta.loSec > 3.2 * 3600 && eta.hiSec < 3.8 * 3600 && eta.loSec < eta.hiSec, JSON.stringify(eta));
  assert.match(estimateEta(points.slice(0, 2)).reason, /至少需要 3 个/);
  const wrapped = parseEpochLines(["23:59:00 INFO epoch 1/10 loss=1", "23:59:50 INFO epoch 2/10 loss=1", "00:00:40 INFO epoch 3/10 loss=1"]);
  assert.equal(estimateEta(wrapped.points).secPerEpoch, 50);
  const jumpy = parseEpochLines(["10:00:00 INFO epoch 1/10 loss=1", "10:00:10 INFO epoch 2/10 loss=1", "10:01:10 INFO epoch 3/10 loss=1"]);
  assert.match(estimateEta(jumpy.points).reason, /波动/);
  const restart = parseEpochLines([...TEXT_TAIL.slice(0, 3), "23:55:00 INFO epoch 0/400 loss=2", "23:56:00 INFO epoch 1/400 loss=1.9"]);
  assert.equal(restart.restarted, true);
  assert.equal(restart.points.length, 2);
  assert.match(estimateEta(restart.points).reason, /至少需要 3 个/);
});

test("训练日志：JSONL epoch_complete 没有总数不给 ETA；与 run 精确关联、并行子任务各自新鲜度", () => {
  const jsonl = [1, 2, 3].map((e) => JSON.stringify({ time: `2026-10-05T16:14:${String(10 + e * 12).padStart(2, "0")}-0700`, event: "epoch_complete", epoch: e, step: e * 52, z_mse: 1 / e, seconds: 12.4, peak_cuda_memory_bytes: 1647549440, lr: 0.0002 }));
  const { points } = parseEpochLines(["{\"event\": \"run_start\"}", ...jsonl]);
  assert.equal(points.length, 3);
  assert.equal(points[0].metrics.peak_cuda_memory_bytes, undefined);
  assert.match(estimateEta(points).reason, /总 epoch/);
  const text = "2026-10-06T08:00:00+0800 LAUNCH X5G_f0_s1234 train GPU-0\n2026-10-06T08:00:45+0800 LAUNCH C3b_s1234 train GPU-1\n2026-10-06T08:01:00+0800 LAUNCH X5G_f1_s1234 eval_best GPU-1\n";
  const rn = NOW / 1000;
  const logs = [
    { r: "X5G_f0_s1234", s: "train", mt: rn - 60, sz: 11214, ep: TEXT_TAIL, last: TEXT_TAIL.at(-1) },
    { r: "C3b_s1234", s: "train", mt: rn - 600, sz: 7000, ep: jsonl, last: jsonl.at(-1) },
    { r: "X5G_f1_s1234", s: "eval_best", mt: rn - 5, sz: 400, ep: [], last: "[test] cases=50  R2_casemean=0.8209" },
    { r: "NOPE_s1", s: "train", miss: true },
  ];
  const state = applySubrunRecord(null, fakeRecord(text, { logs, rn }), ctx);
  const view = subrunView(state, NOW);
  const byRun = Object.fromEntries(view.running.map((r) => [r.run, r.log]));
  assert.equal(byRun.X5G_f0_s1234.epoch, 172);
  assert.equal(byRun.X5G_f0_s1234.total, 400);
  assert.ok(byRun.X5G_f0_s1234.eta, "文本格式 + 稳定速度 → 有区间");
  assert.equal(byRun.X5G_f0_s1234.lastLogAt, NOW - 60000);
  assert.equal(byRun.C3b_s1234.eta, null);
  assert.match(byRun.C3b_s1234.etaNote, /总 epoch/);
  assert.equal(byRun.C3b_s1234.lastLogAt, NOW - 600000);
  assert.equal(byRun.X5G_f1_s1234.epoch, null);
  assert.match(byRun.X5G_f1_s1234.lastLine, /R2_casemean/);
  assert.equal(state.runs.some((r) => r.run === "NOPE_s1"), false, "没有对应启动记录的日志不挂到任何子任务上");
  // 下一轮先采样最久没采到的（这里 C3b 与 X5G_f0 同一轮采样，按启动时刻）。
  assert.deepEqual(subrunPayload(state).open[0], ["X5G_f0_s1234", "train"]);
  // 活动指纹：子任务日志变大 → 指纹变；stdout 不变也不算停滞。
  const before = subrunActivity(state).fingerprint;
  const grown = applySubrunRecord(state, fakeRecord(text, { from: state.cursor.off, logs: [{ ...logs[0], sz: 12000, mt: rn }], rn }), ctx);
  assert.notEqual(subrunActivity(grown).fingerprint, before);
  // 指标历史跨轮合并、按 epoch 去重。
  assert.deepEqual(subrunView(grown, NOW).running.find((r) => r.run === "X5G_f0_s1234").log.history, [0.152, 0.1518, 0.1512, 0.1509, 0.1505]);
  // 日志很久没动：不再给 ETA。
  const later = subrunView(grown, NOW + 40 * 60000).running.find((r) => r.run === "X5G_f0_s1234").log;
  assert.equal(later.eta, null);
  assert.match(later.etaNote, /较久未更新/);
});

test("明细有界：裁剪只丢已正常结束的明细，计数不变", () => {
  const lines = [];
  for (let i = 0; i < SUBRUN_MAX_RUNS + 40; i += 1) {
    lines.push(`2026-10-06T08:00:00+0800 LAUNCH R${i} train GPU-0`, `2026-10-06T08:01:00+0800 END R${i} train ${i === 3 ? 1 : 0}`);
  }
  lines.push("2026-10-06T08:02:00+0800 LAUNCH LAST train GPU-0", "");
  const text = lines.join("\n");
  // 每轮最多 300 条事件（与远端同一上限）：分两轮读完。
  let state = applySubrunRecord(null, fakeRecord(text.slice(0, Math.floor(text.length / 2))), ctx);
  state = applySubrunRecord(state, fakeRecord(text, { from: state.cursor.off }), ctx);
  assert.ok(state.runs.length <= SUBRUN_MAX_RUNS);
  const view = subrunView(state, NOW);
  assert.equal(view.launched, SUBRUN_MAX_RUNS + 41);
  assert.equal(view.failedRuns[0].run, "R3");
  assert.equal(view.running[0].run, "LAST");
});
