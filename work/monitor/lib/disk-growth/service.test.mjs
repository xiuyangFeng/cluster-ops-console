import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DIR_USAGE_REMOTE_COMMAND, DIR_USAGE_SCRIPT_PATH } from "../dir-usage/scan.mjs";
import { createJobRegistry } from "../jobs/registry.mjs";
import { RETRY_AFTER_FAILURE_MS, SCHEDULE_INTERVAL_MS } from "./model.mjs";
import { DISK_GROWTH_SSH_TIMEOUT_MS, HOME_PROBE_COMMAND } from "./scan.mjs";
import {
  createDiskGrowthService, DISK_GROWTH_GAP_MS, DISK_GROWTH_HOME_RECHECK_MS, DISK_GROWTH_MAX_MS, DISK_GROWTH_SAMPLE_FRESH_MS, isDiskGrowthEligible,
} from "./service.mjs";
import { createDiskGrowthStore } from "./store.mjs";

const HOUR = 3600_000;
const GIB = 2 ** 30;
const TIB = 2 ** 40;
const T0 = Date.UTC(2026, 9, 12, 6, 0);
const HOME = "/public/home/kai";
const GNN = `${HOME}/Digital_twin/GNN`;
const OUTPUTS = "Digital_twin/GNN/outputs";
const XP = "Digital_twin/GNN/training_wss_min/experiments";
const S2 = { id: "s2", host: "other", source: "team" };
const CONFIG = { servers: [{ id: "s1", host: "myserver", source: "team" }, { id: "me", host: "box", source: "personal" }] };

// 设计稿里的路径形状：4 个批次写 outputs/<批次>/…，3 个实验写 experiments/<实验>/…。
const JOBS = [
  ...["b1", "b2", "b3", "b4"].flatMap((batch) => ["case_1", "case_2"].map((c) => ({ stdout: `${GNN}/outputs/${batch}/units/AD/${c}/logs/mesh_%j.out` }))),
  ...["xp_a", "xp_b", "xp_c"].map((xp) => ({ stdout: `${GNN}/training_wss_min/experiments/${xp}/logs/xp_%j.log` })),
  { stdout: null },
];

async function seedRegistry(registry, serverId, jobs = JOBS) {
  await registry.observe(serverId, {
    user: "kai",
    total: jobs.length,
    complete: true,
    entries: jobs.map((job, index) => ({ jobId: String(48000 + index), arrayJobId: null, arrayTaskId: null, name: "job", workDir: GNN, stdout: null, stderr: null, command: null, ...job })),
  });
}

const end = (root, over = {}) => JSON.stringify({
  k: "end", v: 1, home: HOME, root, complete: true, stop: "done", entries: 100, dirsDone: 10, denied: 0, errors: 0, otherFs: 0, otherFsNames: [],
  dropped: 0, hardlinks: 0, sec: 0.4, agg1: {}, agg1Over: [0, 0, 0, 0], agg2: {}, rootFiles: [0, 0, 0], top: [], pending: [], ...over,
});
const sizes = (map) => Object.fromEntries(Object.entries(map).map(([name, gib]) => [name, [gib * GIB, gib * GIB, 10, 2]]));
const ok = (stdout) => ({ code: 0, stdout, stderr: "" });
const HOME_OK = ok(`env=${HOME}\nreal=${HOME}\n`);

// 假时钟 + 假 SSH：sleep 推进时钟，exec 按「家目录探测 / 哪个集合目录」分派给脚本化的回答。
async function makeService({ config = CONFIG, jobs = JOBS, respond, busy = () => false, registryServer = "s1", filesystem = null } = {}) {
  let clock = T0;
  const calls = [];
  const slots = [];
  const sleeps = [];
  const logs = [];
  const registry = createJobRegistry({ now: () => clock });
  if (jobs) await seedRegistry(registry, registryServer, jobs);
  const store = createDiskGrowthStore({ now: () => clock });
  const state = { config, filesystem };
  const service = createDiskGrowthService({
    store,
    registry,
    getConfig: async () => state.config,
    dataDir: os.tmpdir(),
    execCollector: async (inv, server) => {
      const probe = inv.args.at(-1) === HOME_PROBE_COMMAND;
      const payload = probe ? null : JSON.parse(inv.input.split("\n")[1]);
      const call = { kind: probe ? "home" : "scan", serverId: server.id, root: payload?.root, pending: payload?.pending ?? null, timeoutMs: inv.timeoutMs, at: clock };
      calls.push(call);
      return respond(call, calls.filter((item) => item.kind === call.kind && item.root === call.root).length - 1);
    },
    probeSshFailureReason: (code) => `ssh exit ${code}`,
    isDirUsageBusy: (serverId) => busy(serverId, clock),
    log: (text, meta) => logs.push([text, meta?.level]),
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  const acquireSshSlot = async (opts) => {
    slots.push(opts.hostKey);
    return () => slots.push("release");
  };
  const deps = { acquireSshSlot, getFilesystem: () => (typeof state.filesystem === "function" ? state.filesystem(clock) : state.filesystem) };
  return { service, store, registry, calls, slots, sleeps, logs, state, deps, acquireSshSlot, advance: (ms) => { clock += ms; }, clock: () => clock };
}

// 不启动定时器，只把定时测量要的依赖接上（等价于 start() 之后的状态）。
function arm(ctx) {
  ctx.service.start({ ...ctx.deps, firstTickMs: 2 ** 30, tickMs: 2 ** 30 });
  return ctx;
}

test("范围：只量团队服务器；模块关着不量；按需量一次的各种拒绝", async () => {
  assert.equal(isDiskGrowthEligible(CONFIG.servers[1]), false);
  const ctx = await makeService({ respond: () => HOME_OK });
  const { service, acquireSshSlot, state, calls } = ctx;
  assert.deepEqual(await service.get("me"), { eligible: false, serverId: "me" });
  assert.deepEqual(await service.get("nope"), { eligible: false, serverId: "nope" });
  assert.deepEqual(await service.get("s1"), { eligible: true, serverId: "s1", running: false, run: null, growth: null });
  await assert.rejects(service.scanNow("me", { acquireSshSlot }), { status: 404 });
  await assert.rejects(service.scanNow("s1", {}), { status: 503 }, "没有 SSH 调度");
  state.config = { ...CONFIG, modules: { jobs: false } };
  assert.deepEqual(await service.get("s1"), { eligible: true, serverId: "s1", disabled: true });
  assert.equal(await service.summaryFor("s1"), null);
  await assert.rejects(service.scanNow("s1", { acquireSshSlot }), { status: 409, message: /模块已关闭/ });
  arm(ctx);
  assert.equal(await service.tick(), null, "模块关着：定时也不量");
  service.stop();
  state.config = CONFIG;
  await assert.rejects(service.scanNow("s1", { acquireSshSlot }), { status: 503, message: /正在退出/ });
  assert.equal(calls.length, 0, "以上都没有发过 SSH");
});

test("一次测量：探家目录 → 从登记推出集合目录 → 一轮接一轮量完；每轮占一次槽位、轮间歇 2 秒、游标续扫", async () => {
  const ctx = await makeService({
    filesystem: (clock) => ({ usedBytes: 38 * TIB, totalBytes: 44 * TIB, usedPct: 91, checkedAt: clock - 30_000 }),
    respond: (call, nth) => {
      if (call.kind === "home") return ok(`env=/home/kai\nreal=${HOME}\n`);
      if (call.root === OUTPUTS) {
        return nth === 0
          ? ok(end(OUTPUTS, { complete: false, stop: "entries", agg1: sizes({ b1: 400, b2: 100 }), rootFiles: [GIB, GIB, 2], pending: [["b2/units/AD", 7], ["b3", 0]] }))
          : ok(end(OUTPUTS, { agg1: sizes({ b2: 50, b3: 20, b4: 5 }) }));
      }
      return ok(end(XP, { agg1: sizes({ xp_a: 30, xp_b: 10, xp_c: 1 }) }));
    },
  });
  const { service, calls, slots, sleeps, logs, acquireSshSlot } = arm(ctx);
  const started = await service.scanNow("s1", { acquireSshSlot });
  assert.deepEqual([started.running, started.run.trigger, started.growth], [true, "manual", null], "立刻返回，测量在后台");
  await assert.rejects(service.scanNow("s1", { acquireSshSlot }), { status: 409, message: /正在量/ });
  await service.idle();

  assert.deepEqual(calls.map((c) => [c.kind, c.root ?? null]), [["home", null], ["scan", OUTPUTS], ["scan", OUTPUTS], ["scan", XP]]);
  assert.ok(calls.every((c) => c.timeoutMs === DISK_GROWTH_SSH_TIMEOUT_MS && c.serverId === "s1"));
  assert.equal(calls[1].pending, null);
  assert.deepEqual(calls[2].pending, [["b2/units/AD", 7], ["b3", 0]], "第二轮带着上一轮的游标");
  assert.deepEqual(slots, ["myserver", "release", "myserver", "release", "myserver", "release", "myserver", "release"]);
  assert.deepEqual(sleeps, [DISK_GROWTH_GAP_MS, DISK_GROWTH_GAP_MS, DISK_GROWTH_GAP_MS], "每两次 SSH 之间歇 2 秒");

  const entry = await ctx.store.get("s1");
  assert.deepEqual([entry.home, entry.homeEnv], [HOME, "/home/kai"]);
  assert.deepEqual(entry.roots, [{ root: OUTPUTS, jobs: 8 }, { root: XP, jobs: 3 }]);
  assert.equal(entry.attempt.outcome, "ok");
  const [m] = entry.measurements;
  assert.deepEqual([m.trigger, m.complete, m.stop, m.rounds, m.startedAt], ["manual", true, null, 4, T0]);
  assert.deepEqual(m.disk, { used: 38 * TIB, total: 44 * TIB, pct: 91 });
  assert.deepEqual(m.roots.map((r) => [r.root, r.state, r.jobs]), [[OUTPUTS, "ok", 8], [XP, "ok", 3]]);
  assert.deepEqual(m.roots[0].c, [["b1", 400 * GIB, 0], ["b2", 150 * GIB, 0], ["b3", 20 * GIB, 0], ["b4", 5 * GIB, 0]], "两轮的增量相加");
  assert.deepEqual(m.roots[0].o, [GIB, 0, 0, 0], "直接放在集合目录里的文件");

  const view = await service.get("s1");
  assert.deepEqual([view.running, view.run, view.growth.complete, view.growth.rows[0].name, view.growth.rows[0].delta], [false, null, true, "b1", null]);
  assert.equal(view.growth.total.bytes, 617 * GIB);
  assert.equal(await service.summaryFor("s1"), null, "只量过一次，还没有增长可说");
  assert.match(logs.at(-1)[0], /^disk growth on s1: ok trigger=manual roots=2 rounds=4 entries=300 sec=6$/);
  assert.ok(!logs.some(([text]) => text.includes("outputs")), "日志里不写目录名");

  // 家目录已经知道：下一次测量不再探
  ctx.advance(SCHEDULE_INTERVAL_MS);
  calls.length = 0;
  await service.scanNow("s1", { acquireSshSlot });
  await service.idle();
  assert.deepEqual(calls.map((c) => c.kind), ["scan", "scan", "scan"]);
  assert.equal((await ctx.store.get("s1")).measurements.length, 2);
});

test("两次测量之后：视图给出增长，事件详情 / 简报用的摘要可用", async () => {
  let round = 0;
  const ctx = await makeService({
    filesystem: (clock) => ({ usedBytes: (36 + round * 2) * TIB, totalBytes: 44 * TIB, usedPct: 82 + round * 5, checkedAt: clock }),
    respond: (call) => {
      if (call.kind === "home") return HOME_OK;
      if (call.root === OUTPUTS) return ok(end(OUTPUTS, { agg1: sizes(round === 0 ? { b1: 600, b2: 300 } : { b1: 1700, b2: 300, b5: 40 }) }));
      return ok(end(XP, { agg1: sizes({ xp_a: 30 }) }));
    },
  });
  const { service, acquireSshSlot } = arm(ctx);
  await service.scanNow("s1", { acquireSshSlot });
  await service.idle();
  round = 1;
  ctx.advance(24 * HOUR);
  await service.scanNow("s1", { acquireSshSlot });
  await service.idle();
  const { growth } = await service.get("s1");
  assert.deepEqual(growth.rows.slice(0, 3).map((row) => [row.name, row.delta, row.isNew]), [["b1", 1100 * GIB, false], ["b5", 40 * GIB, true], ["b2", 0, false]]);
  assert.deepEqual([growth.label, growth.total.delta, growth.total.partial], ["近 24 小时", 1140 * GIB, false]);
  assert.ok(Math.abs(growth.share - 1140 / 2048) < 1e-9);
  const summary = await service.summaryFor("s1");
  assert.deepEqual([summary.top.name, summary.top.delta, summary.total.delta, summary.label], ["b1", 1100 * GIB, 1140 * GIB, "近 24 小时"]);
  ctx.advance(13 * HOUR);
  assert.equal(await service.summaryFor("s1"), null, "最近一次太旧：不再给摘要");
});

test("登记不够 / 没有集合目录：不发 SSH 或只探一次家目录，记成 no-roots，6 小时后才再看", async () => {
  const few = arm(await makeService({ jobs: JOBS.slice(0, 2), filesystem: (clock) => ({ checkedAt: clock }), respond: () => HOME_OK }));
  assert.equal(await few.service.tick(), "s1");
  await few.service.idle();
  assert.equal(few.calls.length, 0, "登记的作业不足 3 个：连家目录都不探");
  assert.deepEqual([(await few.store.get("s1")).attempt.outcome, (await few.service.get("s1")).growth], ["no-roots", null]);
  assert.equal(await few.service.tick(), null, "刚看过，不到 6 小时不再看");
  few.advance(SCHEDULE_INTERVAL_MS);
  assert.equal(await few.service.tick(), "s1");
  await few.service.idle();

  // 作业都在同一个目录里：探到家目录后推不出集合目录
  const flat = arm(await makeService({ jobs: Array.from({ length: 5 }, () => ({ stdout: null })), filesystem: (clock) => ({ checkedAt: clock }), respond: () => HOME_OK }));
  await flat.service.tick();
  await flat.service.idle();
  assert.deepEqual(flat.calls.map((c) => c.kind), ["home"]);
  const entry = await flat.store.get("s1");
  assert.deepEqual([entry.home, entry.homeAt, entry.roots, entry.attempt.outcome, entry.measurements], [HOME, T0, [], "no-roots", []]);
  // 之后每 6 小时只在本机重推一遍，不再发 SSH；满一周才重探一次家目录
  flat.advance(SCHEDULE_INTERVAL_MS);
  await flat.service.tick();
  await flat.service.idle();
  assert.equal(flat.calls.length, 1);
  flat.advance(DISK_GROWTH_HOME_RECHECK_MS);
  await flat.service.tick();
  await flat.service.idle();
  assert.deepEqual(flat.calls.map((c) => c.kind), ["home", "home"]);
});

test("家目录挪过地方：记着的旧家目录推不出集合目录，满一周重探后按新的重新推并量", async () => {
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call) => (call.kind === "home" ? HOME_OK : ok(end(call.root, { agg1: sizes({ b1: 5 }) }))),
  }));
  await ctx.store.update("s1", (draft) => Object.assign(draft, { home: "/public/oldhome/cy", homeEnv: null, homeAt: T0 - DISK_GROWTH_HOME_RECHECK_MS + HOUR }));
  await ctx.service.tick();
  await ctx.service.idle();
  assert.equal(ctx.calls.length, 0, "探了还不到一周：先不重探");
  assert.equal((await ctx.store.get("s1")).attempt.outcome, "no-roots");
  ctx.advance(SCHEDULE_INTERVAL_MS);
  await ctx.service.tick();
  await ctx.service.idle();
  assert.deepEqual(ctx.calls.map((c) => [c.kind, c.root ?? null]), [["home", null], ["scan", OUTPUTS], ["scan", XP]]);
  const entry = await ctx.store.get("s1");
  assert.deepEqual([entry.home, entry.roots.map((r) => r.root), entry.measurements.length, entry.attempt.outcome], [HOME, [OUTPUTS, XP], 1, "ok"]);
});

test("量不完：满 10 分钟停下，量到一半的标没量完、没轮到的标没轮到；下一次仍按 6 小时来", async () => {
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call, nth) => {
      if (call.kind === "home") return HOME_OK;
      // outputs 永远扫不完：每轮只多出一点，游标一直不空
      return ok(end(OUTPUTS, { complete: false, stop: "time", agg1: nth === 0 ? sizes({ b1: 400, b2: 1 }) : sizes({ b2: 1 }), pending: [["b2/units", nth], ["b3", 0]] }));
    },
  }));
  const { service, calls, sleeps } = ctx;
  assert.equal(await service.tick(), "s1");
  await service.idle();
  const elapsed = ctx.clock() - T0;
  assert.ok(elapsed >= DISK_GROWTH_MAX_MS && elapsed < DISK_GROWTH_MAX_MS + DISK_GROWTH_GAP_MS, `用时 ${elapsed}`);
  assert.equal(calls.filter((c) => c.kind === "scan").length, sleeps.length - 1, "时限一到不再发下一轮");
  assert.ok(calls.every((c) => c.root !== XP), "第二个集合目录没轮到");
  const entry = await ctx.store.get("s1");
  const [m] = entry.measurements;
  assert.deepEqual([m.complete, m.stop, m.trigger, entry.attempt.outcome], [false, "deadline", "schedule", "partial"]);
  assert.deepEqual(m.roots.map((r) => [r.root, r.state]), [[OUTPUTS, "partial"], [XP, "skipped"]]);
  assert.deepEqual(m.roots[0].c.map((child) => [child[0], child[2]]), [["b1", 0], ["b2", 1]], "b1 量完了，b2 还在游标里");
  assert.equal(m.roots[0].o[3], 0);
  const { growth } = await service.get("s1");
  assert.deepEqual([growth.complete, growth.stop, growth.roots[1].state, growth.rows.find((row) => row.name === "b2").partial], [false, "deadline", "skipped", true]);
  assert.equal(await service.tick(), null, "没量完也算量过：不马上重来");
  ctx.advance(SCHEDULE_INTERVAL_MS);
  assert.equal(await service.tick(), "s1");
  await service.idle();
});

test("SSH 中途失败：已经量到的照实存成没量完；一开始就失败则什么都不存，30 分钟后才重试", async () => {
  const mid = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call, nth) => {
      if (call.kind === "home") return HOME_OK;
      if (call.root === OUTPUTS && nth === 0) return ok(end(OUTPUTS, { complete: false, agg1: sizes({ b1: 400 }), pending: [["b2", 0]] }));
      return { code: 255, stdout: "", stderr: "ssh: connect to host myserver port 22: Operation timed out" };
    },
  }));
  await mid.service.tick();
  await mid.service.idle();
  const saved = await mid.store.get("s1");
  assert.deepEqual([saved.measurements[0].stop, saved.measurements[0].roots.map((r) => r.state), saved.attempt.outcome], ["error", ["partial", "skipped"], "partial"]);
  assert.match(saved.attempt.error, /SSH 没有成功 \(ssh exit 255\)/);
  assert.equal(mid.calls.filter((c) => c.kind === "scan").length, 2, "失败后不再发下一轮");

  const dead = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: () => ({ code: null, stdout: "", stderr: "", timedOut: true }),
  }));
  assert.equal(await dead.service.tick(), "s1");
  await dead.service.idle();
  const entry = await dead.store.get("s1");
  assert.deepEqual([entry.measurements, entry.attempt.outcome, entry.home], [[], "error", null]);
  assert.match(entry.attempt.error, /读不到家目录：SSH 在 20 秒内没有返回/);
  assert.equal(dead.logs.at(-1)[1], "warn");
  assert.equal((await dead.service.get("s1")).growth, null, "连集合目录都没推出来：界面不显示");
  dead.advance(RETRY_AFTER_FAILURE_MS - 1);
  assert.equal(await dead.service.tick(), null);
  dead.advance(1);
  assert.equal(await dead.service.tick(), "s1");
  await dead.service.idle();

  // 家目录探到了、集合目录也推出来了，但第一轮扫描就失败：界面能看到目录与原因
  const first = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call) => (call.kind === "home" ? HOME_OK : { code: 127, stdout: "", stderr: "sh: python3: command not found" }),
  }));
  await first.service.tick();
  await first.service.idle();
  const view = await first.service.get("s1");
  assert.deepEqual([view.growth.measuredAt, view.growth.roots.map((r) => r.root), view.growth.attempt.outcome], [null, [OUTPUTS, XP], "error"]);
  assert.match(view.growth.attempt.error, /没有 python3/);
});

test("远端不肯扫的集合目录（经过符号链接 / 不存在）：记下原因，其余照量", async () => {
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call) => {
      if (call.kind === "home") return HOME_OK;
      if (call.root === OUTPUTS) return ok(JSON.stringify({ k: "err", code: "outside-home", home: HOME }));
      return ok(end(XP, { agg1: sizes({ xp_a: 30 }) }));
    },
  }));
  await ctx.service.tick();
  await ctx.service.idle();
  const entry = await ctx.store.get("s1");
  assert.deepEqual(entry.measurements[0].roots.map((r) => [r.state, r.error]), [["error", "outside-home"], ["ok", null]]);
  assert.deepEqual([entry.measurements[0].complete, entry.measurements[0].stop, entry.attempt.outcome], [false, null, "partial"]);
  assert.equal((await ctx.service.get("s1")).growth.roots[0].error, "路径不在 $HOME 内或包含符号链接，未扫描");

  const all = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call) => (call.kind === "home" ? HOME_OK : ok(JSON.stringify({ k: "err", code: "not-found", home: HOME }))),
  }));
  await all.service.tick();
  await all.service.idle();
  const none = await all.store.get("s1");
  assert.deepEqual([none.measurements, none.attempt.outcome, none.attempt.error], [[], "error", "集合目录量不了：目录不存在或无权访问"]);
});

test("扫描器丢过子目录的那几轮碰过的目录按没量完算；扫描器报的家目录变了就记下新的", async () => {
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: (call, nth) => {
      if (call.kind === "home") return HOME_OK;
      if (call.root === XP) return ok(end(XP, { home: "/public/newhome/cy", agg1: sizes({ xp_a: 30 }) }));
      return nth === 0
        ? ok(end(OUTPUTS, { complete: false, dropped: 12, agg1: sizes({ b1: 400, b2: 9 }), pending: [["b2/x", 0]] }))
        : ok(end(OUTPUTS, { agg1: sizes({ b2: 1, b3: 5 }) }));
    },
  }));
  await ctx.service.tick();
  await ctx.service.idle();
  const entry = await ctx.store.get("s1");
  assert.deepEqual(entry.measurements[0].roots[0].c, [["b1", 400 * GIB, 1], ["b2", 10 * GIB, 1], ["b3", 5 * GIB, 0]]);
  assert.deepEqual([entry.measurements[0].roots[0].state, entry.measurements[0].complete], ["partial", false]);
  assert.deepEqual([entry.home, entry.homeEnv], ["/public/newhome/cy", null]);
});

test("让路：用户在扫目录占用时定时不发起、按需拒绝；量到一半遇上就等它，等到时限为止", async () => {
  let busyUntil = Infinity;
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    busy: (_serverId, clock) => clock < busyUntil,
    respond: (call) => (call.kind === "home" ? HOME_OK : ok(end(call.root, { agg1: sizes({ a: 1 }) }))),
  }));
  const { service, acquireSshSlot, calls } = ctx;
  assert.equal(await service.tick(), null);
  await assert.rejects(service.scanNow("s1", { acquireSshSlot }), { status: 409, message: /正在扫描目录占用/ });
  assert.equal(calls.length, 0);

  // 开始之后用户才点了目录占用：歇着等，30 秒后它扫完，接着量
  busyUntil = T0;
  await service.scanNow("s1", { acquireSshSlot });
  busyUntil = T0 + 30_000;
  await service.idle();
  const entry = await ctx.store.get("s1");
  assert.equal(entry.measurements[0].complete, true);
  assert.ok(calls.filter((c) => c.kind === "scan").every((c) => c.at >= T0 + 30_000), "它扫着的时候没有发扫描");

  // 一直不结束：等到时限，什么都没量到
  busyUntil = Infinity;
  ctx.advance(SCHEDULE_INTERVAL_MS);
  busyUntil = ctx.clock();
  await service.scanNow("s1", { acquireSshSlot });
  busyUntil = Infinity;
  const before = calls.length;
  await service.idle();
  assert.equal(calls.length, before, "没有发 SSH");
  assert.deepEqual([(await ctx.store.get("s1")).measurements.length, (await ctx.store.get("s1")).attempt.error], [1, "没轮到就到时限了"]);
});

test("定时：采样够新才量；满 6 小时再量；磁盘涨 1 个百分点且满 1 小时提前量；一次只量一台", async () => {
  let used = 38 * TIB;
  let sampleAge = DISK_GROWTH_SAMPLE_FRESH_MS + 1;
  const ctx = await makeService({
    filesystem: (clock) => ({ usedBytes: used, totalBytes: 44 * TIB, usedPct: Math.round((used / (44 * TIB)) * 100), checkedAt: clock - sampleAge }),
    respond: (call) => (call.kind === "home" ? HOME_OK : ok(end(call.root, { agg1: sizes({ b1: 1 }) }))),
  });
  const { service, state } = ctx;
  assert.equal(await service.tick(), null, "还没 start()：没有 SSH 槽位，不量");
  arm(ctx);
  assert.equal(await service.tick(), null, "资源采样太旧（连不上或刚启动）：不量");
  sampleAge = 10_000;
  assert.equal(await service.tick(), "s1");
  assert.equal(await service.tick(), null, "正在量：不叠加");
  await service.idle();
  assert.equal((await ctx.store.get("s1")).measurements[0].trigger, "schedule");

  ctx.advance(HOUR + 60_000);
  used += 0.3 * TIB; // 约 0.68 个百分点
  assert.equal(await service.tick(), null);
  used += 0.2 * TIB; // 累计约 1.14 个百分点
  assert.equal(await service.tick(), "s1");
  await service.idle();
  const second = (await ctx.store.get("s1")).measurements[1];
  assert.deepEqual([second.trigger, second.disk.used], ["disk", used]);
  // 刚提前量过：再涨也要等满 1 小时
  ctx.advance(30 * 60_000);
  used += TIB;
  assert.equal(await service.tick(), null);
  ctx.advance(31 * 60_000);
  assert.equal(await service.tick(), "s1");
  await service.idle();

  // 两台团队服务器都到点：一拍只发起一台，另一台等下一拍
  await seedRegistry(ctx.registry, "s2");
  state.config = { servers: [S2, ...CONFIG.servers] };
  ctx.advance(SCHEDULE_INTERVAL_MS);
  assert.equal(await service.tick(), "s2");
  assert.equal(await service.tick(), null);
  await service.idle();
  assert.equal(await service.tick(), "s1");
  await service.idle();
  assert.equal(await service.tick(), null);
  assert.equal((await ctx.store.get("s2")).measurements.length, 1);
  assert.equal(await ctx.store.get("me"), null, "个人服务器从不量");
});

test("退出：进行中的测量发完手上这一轮就停，不落盘；之后不再发起", async () => {
  let release;
  const ctx = arm(await makeService({
    filesystem: (clock) => ({ checkedAt: clock }),
    respond: async (call) => {
      if (call.kind === "home") return HOME_OK;
      await new Promise((resolve) => { release = resolve; });
      return ok(end(call.root, { complete: false, agg1: sizes({ b1: 1 }), pending: [["b1/x", 0]] }));
    },
  }));
  const { service, calls } = ctx;
  await service.tick();
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  service.stop();
  release();
  await service.idle();
  await service.flush();
  assert.equal(calls.filter((c) => c.kind === "scan").length, 1);
  const entry = await ctx.store.get("s1");
  assert.deepEqual([entry.measurements, entry.attempt], [[], null], "只留下家目录与集合目录");
  assert.equal(await service.tick(), null);

  // 还没发出第一条 SSH 就退出：同样什么都不记（不留一条「没量成」拖住下次启动后的重试）
  const early = arm(await makeService({ filesystem: (clock) => ({ checkedAt: clock }), respond: () => HOME_OK }));
  const slot = Promise.withResolvers();
  early.service.start({ ...early.deps, acquireSshSlot: async () => { await slot.promise; return () => {}; }, firstTickMs: 2 ** 30, tickMs: 2 ** 30 });
  await early.service.tick();
  early.service.stop();
  slot.resolve();
  await early.service.idle();
  assert.deepEqual([early.calls.length, await early.store.get("s1")], [0, null]);
});

test("量到一半关掉「我的 Slurm 作业」模块（或停用了服务器）：下一轮就不发了，这次什么都不记", async () => {
  for (const change of [(config) => ({ ...config, modules: { jobs: false } }), (config) => ({ servers: config.servers.map((s) => ({ ...s, disabled: true })) })]) {
    const ctx = arm(await makeService({
      filesystem: (clock) => ({ checkedAt: clock }),
      respond: (call, nth) => {
        if (call.kind === "home") return HOME_OK;
        if (nth === 1) ctx.state.config = change(CONFIG);
        return ok(end(call.root, { complete: false, agg1: sizes({ b1: 1 }), pending: [["b1/x", nth]] }));
      },
    }));
    await ctx.service.tick();
    await ctx.service.idle();
    assert.equal(ctx.calls.filter((c) => c.kind === "scan").length, 2, "改配置之后没有再发");
    const entry = await ctx.store.get("s1");
    assert.deepEqual([entry.measurements, entry.attempt], [[], null]);
    assert.ok(!ctx.logs.some(([text]) => text.startsWith("disk growth on")), "没有结果就不写日志");
  }
});

test("整个停用（fixture 模式）：定时不量、按需回 409、之后 start() 也不生效，一条 SSH 都不发；已存结果照常可读", async () => {
  const ctx = await makeService({
    filesystem: (clock) => ({ usedBytes: 38 * TIB, totalBytes: 44 * TIB, usedPct: 91, checkedAt: clock }),
    respond: (call) => (call.kind === "home" ? HOME_OK : ok(end(call.root, { agg1: sizes({ b1: 5 }) }))),
  });
  const { service, acquireSshSlot, calls, slots } = ctx;
  // 先存一份量好的结果（等价于预览时种进数据目录的夹具）
  await ctx.store.update("s1", (draft) => {
    draft.roots = [{ root: OUTPUTS, jobs: 8 }];
    draft.measurements.push({ at: T0 - HOUR, startedAt: T0 - HOUR, trigger: "schedule", complete: true, stop: null, rounds: 2, disk: null, roots: [{ root: OUTPUTS, jobs: 8, at: T0 - HOUR, state: "ok", error: null, c: [["b1", 5 * GIB, 0]], o: [0, 0, 0, 0] }] });
  });

  service.disable("fixture 模式不发起真实 SSH");
  await assert.rejects(service.scanNow("s1", { acquireSshSlot }), { status: 409, message: "fixture 模式不发起真实 SSH" });
  await assert.rejects(service.scanNow("s1"), { status: 409 }, "不带槽位也是同一个拒绝，而不是「SSH 调度不可用」");
  // 装配处即使照常调了 start()，也不会开始定时
  arm(ctx);
  ctx.advance(SCHEDULE_INTERVAL_MS * 3);
  assert.equal(await service.tick(), null);
  await service.idle();
  assert.deepEqual([calls.length, slots.length], [0, 0], "没有占过 SSH 槽位，也没有执行过任何远端命令");
  const view = await service.get("s1");
  assert.deepEqual([view.running, view.growth.rows[0].name, view.growth.measuredAt], [false, "b1", T0 - HOUR], "读接口不受影响");
  assert.equal((await ctx.store.get("s1")).attempt, null, "没有留下任何尝试记录");
});

// 真实远端脚本：在临时「集群 HOME」上跑一整次测量（家目录探测用真实 sh，扫描用真实 python3），
// 每轮条目数压到很小逼出多轮续扫，核对量出来的大小与目录里实际的磁盘块一致。
const python = process.platform !== "win32" && spawnSync("python3", ["--version"]).status === 0;

function diskBlocks(dir) {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = lstatSync(full);
    total += st.blocks * 512;
    if (st.isDirectory()) total += diskBlocks(full);
  }
  return total;
}

test("真实脚本：临时目录树上多轮量出的各子目录大小 = 实际磁盘块；带空格 / 中文 / 引号的目录名、符号链接都不出错", { skip: !python }, async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "disk-growth-e2e-")));
  const home = path.join(base, "home", "kai");
  const outside = path.join(base, "outside");
  try {
    const outputs = path.join(home, "Digital twin", "GNN", "outputs");
    const batches = ["cfd_auto_ad_repro_20261009", "批次 二", "it's \"q\"", "empty_batch"];
    for (const [index, batch] of batches.entries()) {
      for (let c = 0; c < index * 2; c += 1) {
        const dir = path.join(outputs, batch, "units", "AD", `case_${c}`, "logs");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "mesh.out"), Buffer.alloc(3000 * (index + 1) * (c + 1), 1));
      }
      mkdirSync(path.join(outputs, batch), { recursive: true });
    }
    writeFileSync(path.join(outputs, "README.txt"), "x".repeat(9000));
    mkdirSync(outside);
    writeFileSync(path.join(outside, "huge.bin"), Buffer.alloc(900_000, 1));
    symlinkSync(outside, path.join(outputs, "批次 二", "escape"));

    const registry = createJobRegistry({ now: () => T0 });
    await seedRegistry(registry, "s1", batches.map((batch) => ({ workDir: path.join(home, "Digital twin", "GNN"), stdout: path.join(outputs, batch, "units", "AD", "case_0", "logs", "mesh_%j.out") })));
    const store = createDiskGrowthStore({ now: () => T0 });
    let clock = T0;
    let rounds = 0;
    const perRound = [];
    const scanner = DIR_USAGE_REMOTE_COMMAND.replace(/^python3 -c '/, "").replace(/'$/, "");
    const service = createDiskGrowthService({
      store,
      registry,
      getConfig: async () => CONFIG,
      dataDir: os.tmpdir(),
      // 假 SSH：把同一条远端命令、同一份 stdin 原样交给本机的 sh / python3，HOME 指向临时目录。
      execCollector: async (inv) => {
        const env = { PATH: process.env.PATH, HOME: home };
        if (inv.args.at(-1) === HOME_PROBE_COMMAND) {
          const res = spawnSync("/bin/sh", ["-c", HOME_PROBE_COMMAND], { env, encoding: "utf8", timeout: 60_000 });
          return { code: res.status, stdout: res.stdout, stderr: res.stderr };
        }
        assert.equal(inv.args.at(-1), DIR_USAGE_REMOTE_COMMAND);
        const [script, payload] = inv.input.split("\n");
        assert.equal(JSON.parse(script), readFileSync(DIR_USAGE_SCRIPT_PATH, "utf8"));
        rounds += 1;
        const res = spawnSync("python3", ["-c", scanner], { input: `${script}\n${JSON.stringify({ ...JSON.parse(payload), maxEntries: 5 })}`, env, encoding: "utf8", timeout: 60_000 });
        perRound.push(JSON.parse(res.stdout.trim().split("\n").at(-1)).entries);
        return { code: res.status, stdout: res.stdout, stderr: res.stderr };
      },
      probeSshFailureReason: (code) => `exit ${code}`,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    });
    await service.scanNow("s1", { acquireSshSlot: async () => () => {} });
    await service.idle();

    const entry = await store.get("s1");
    assert.equal(entry.attempt.outcome, "ok", entry.attempt.error || "");
    assert.equal(entry.home, home);
    assert.deepEqual(entry.roots, [{ root: "Digital twin/GNN/outputs", jobs: 4 }]);
    const [m] = entry.measurements;
    assert.equal(m.complete, true);
    assert.ok(rounds > 5, `每轮 5 个条目，应该分很多轮（实际 ${rounds} 轮）`);
    assert.ok(perRound.every((entries) => entries <= 5), `远端每轮的条目数真正受限：${perRound.join(",")}`);
    assert.equal(m.rounds, rounds + 1, "外加一次家目录探测");
    const measured = Object.fromEntries(m.roots[0].c.map(([name, bytes, partial]) => [name, [bytes, partial]]));
    for (const batch of batches) {
      const dir = path.join(outputs, batch);
      assert.deepEqual(measured[batch], [lstatSync(dir).blocks * 512 + diskBlocks(dir), 0], batch);
    }
    assert.ok(measured["批次 二"][0] < 900_000, "符号链接指向的外部文件没有算进来");
    assert.deepEqual(m.roots[0].o, [lstatSync(path.join(outputs, "README.txt")).blocks * 512, 0, 0, 0]);
    assert.ok(clock - T0 >= rounds * DISK_GROWTH_GAP_MS, "轮与轮之间都歇过");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
