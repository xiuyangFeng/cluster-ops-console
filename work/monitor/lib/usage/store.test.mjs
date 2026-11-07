import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import nodeFsPromises, { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createUsageStore, dayKeyOf } from "./store.mjs";

const NOW = Date.UTC(2026, 9, 2, 15 - 8, 0, 0); // 北京时间 15:00
const sec = (ms) => ms / 1000;
const at = (hour, minute = 0, dayOffset = 0) => sec(Date.UTC(2026, 9, 2 + dayOffset, hour - 8, minute)); // 北京时间

const call = (rid, t, patch = {}) => ({ agent: "claude", sid: "s1", rid, t, model: "claude-opus-5-5", ok: true, code: null, inFresh: 1, cacheWrite: 10, cacheRead: 100, output: 5, prompt: 111, turnId: null, sidechain: false, ...patch });

function withStore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "usage-store-"));
  const make = () => createUsageStore({ rootDir: dir, now: () => NOW });
  return Promise.resolve(fn({ dir, make })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("同一调用重复到达以最后一次为准；按调用时间归日落盘", () => withStore(async ({ dir, make }) => {
  const store = make();
  await store.ingest("server-01", {
    sessions: [{ agent: "claude", sid: "s1", cwd: "/home/u/p", window: null }],
    calls: [call("r1", at(10)), call("r2", at(23, 59, -1))],
    cursors: { "/f.jsonl": { i: "1", o: 10, mt: sec(NOW), s: {} } },
    end: { complete: true, files: 1, pending: 1, sec: 0.1 },
  });
  const second = await store.ingest("server-01", { calls: [call("r1", at(10), { output: 50 }), call("r2", at(23, 59, -1))], cursors: {} });
  assert.deepEqual(second, { added: 0, updated: 1 });

  const days = readdirSync(path.join(dir, "server-01", "days")).sort();
  assert.deepEqual(days, ["2026-10-01.json", "2026-10-02.json"]);
  const today = JSON.parse(readFileSync(path.join(dir, "server-01", "days", "2026-10-02.json"), "utf8"));
  assert.equal(today.calls.length, 1);
  assert.equal(today.calls[0][9], 50);

  // 重新加载（模拟控制台重启）：数据、会话、游标、扫描状态都在
  const reloaded = make();
  const snap = await reloaded.snapshot(["server-01"]);
  assert.equal(snap.calls.length, 2);
  assert.equal(snap.calls.find((c) => c.rid === "r1").output, 50);
  assert.equal(snap.sessions[0].cwd, "/home/u/p");
  assert.equal(snap.sessions[0].lastT, at(10));
  assert.deepEqual(Object.keys(await reloaded.getCursors("server-01")), ["/f.jsonl"]);
  assert.equal((await reloaded.getScanStatus("server-01")).complete, true);
  assert.equal(await reloaded.coverageStart(["server-01"]), "2026-10-01");
}));

test("同一调用的多份记录取用量最大的一份，与到达顺序无关", () => withStore(async ({ make }) => {
  const store = make();
  await store.ingest("server-01", { calls: [call("r1", at(10), { output: 4717 })] });
  // 后到的分叉副本（全 0）与子 Agent 副本（中间值）都不应覆盖
  await store.ingest("server-01", { calls: [call("r1", at(10), { sid: "fork", inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0 })] });
  await store.ingest("server-01", { calls: [call("r1", at(10), { output: 3, sidechain: true })] });
  const [rec] = (await make().snapshot(["server-01"])).calls;
  assert.deepEqual([rec.output, rec.sid, rec.sidechain], [4717, "s1", false]);
  // 用量相同的副本：取时间更早的（恢复会话复制的副本时间戳更晚），不论先后到达
  await store.ingest("server-01", { calls: [call("r2", at(10, 30, 1), { sid: "resumed" })] });
  await store.ingest("server-01", { calls: [call("r2", at(10, 30), { sid: "original" })] });
  await store.ingest("server-01", { calls: [call("r2", at(10, 30, 2), { sid: "resumed-again" })] });
  const r2 = (await make().snapshot(["server-01"])).calls.find((c) => c.rid === "r2");
  assert.deepEqual([r2.sid, r2.day], ["original", "2026-10-02"]);
}));

test("Codex 轮次的开始与结束分两次到达时合并", () => withStore(async ({ make }) => {
  const store = make();
  await store.ingest("server-01", { turns: [{ agent: "codex", sid: "c1", tid: "t1", t0: at(9), t1: null }] });
  await store.ingest("server-01", { turns: [{ agent: "codex", sid: "c1", tid: "t1", t0: null, t1: at(9, 5) }] });
  const snap = await make().snapshot(["server-01"]);
  assert.deepEqual(snap.turns.map((t) => [t.t0, t.t1]), [[at(9), at(9, 5)]]);
}));

test("快照不复制记录：两次快照交出的是表里同一批对象，已带 serverId / day（重新加载后同样如此）", () => withStore(async ({ make }) => {
  const store = make();
  await store.ingest("server-01", {
    sessions: [{ agent: "claude", sid: "s1", cwd: "/home/u/p", window: null }],
    calls: [call("r1", at(10))],
    turns: [{ agent: "codex", sid: "c1", tid: "t1", t0: at(9), t1: null }],
    compacts: [{ agent: "claude", sid: "s1", t: at(10, 5) }],
  });
  for (const s of [store, make()]) {
    const a = await s.snapshot(["server-01"]);
    const b = await s.snapshot(["server-01"]);
    for (const kind of ["calls", "turns", "compacts", "sessions"]) assert.equal(a[kind][0], b[kind][0], kind);
    assert.deepEqual([a.calls[0].serverId, a.calls[0].day], ["server-01", "2026-10-02"]);
    assert.deepEqual([a.turns[0].serverId, a.compacts[0].serverId, a.sessions[0].serverId], ["server-01", "server-01", "server-01"]);
  }
}));

test("保留期外的调用不入库；旧日文件与旧游标被淘汰", () => withStore(async ({ dir, make }) => {
  const store = make();
  const old = sec(NOW) - 100 * 86400;
  await store.ingest("server-01", {
    calls: [call("old", old), call("new", at(8))],
    cursors: { "/old.jsonl": { i: "1", o: 1, mt: old, s: {} }, "/new.jsonl": { i: "2", o: 1, mt: sec(NOW), s: {} } },
  });
  const snap = await store.snapshot(["server-01"]);
  assert.deepEqual(snap.calls.map((c) => c.rid), ["new"]);
  assert.deepEqual(Object.keys(await store.getCursors("server-01")), ["/new.jsonl"]);
  assert.ok(!existsSync(path.join(dir, "server-01", "days", `${dayKeyOf(old)}.json`)));
}));

test("扫描失败只记录原因，不清空已有数据", () => withStore(async ({ make }) => {
  const store = make();
  await store.ingest("server-01", { calls: [call("r1", at(8))] });
  await store.recordError("server-01", "ssh exit 255");
  const status = await make().getScanStatus("server-01");
  assert.equal(status.lastError, "ssh exit 255");
  assert.equal((await make().snapshot(["server-01"])).calls.length, 1);
}));

test("旧版按本机时区写的日文件：加载时按北京时间重新归日，下次写盘改写并删掉空文件", () => withStore(async ({ dir, make }) => {
  const days = path.join(dir, "server-01", "days");
  mkdirSync(days, { recursive: true });
  // 北京时间 10-02 08:00 的调用，被旧版（美西时区）记在了 10-01 的文件里
  writeFileSync(path.join(days, "2026-10-01.json"), JSON.stringify({ v: 1, calls: [["claude", "r-old", "s1", at(8), 1, null, 1, 10, 100, 5, 111, "m", null, 0]], turns: [], compacts: [] }));
  const store = make();
  const snap = await store.snapshot(["server-01"]);
  assert.equal(snap.calls[0].day, "2026-10-02");
  await store.flush("server-01");
  assert.deepEqual(readdirSync(days).sort(), ["2026-10-02.json"]);
}));

test("serverId 只接受安全的目录名", () => withStore(async ({ make }) => {
  await assert.rejects(() => make().getCursors("../etc"), /invalid usage serverId/);
}));

const failCall = (rid, t, errorText) => call(rid, t, { ok: false, code: null, inFresh: 0, cacheWrite: 0, cacheRead: 0, output: 0, prompt: 0, model: null, errorText, errorDropped: false });

test("错误原文：只随失败调用落盘（第 15 位），旧记录没有这一位读作「未采集」", () => withStore(async ({ dir, make }) => {
  const days = path.join(dir, "server-01", "days");
  mkdirSync(days, { recursive: true });
  // v2.51 之前写的失败调用：14 位，没有原文
  writeFileSync(path.join(days, "2026-10-02.json"), JSON.stringify({ v: 1, calls: [["claude", "err:old", "s1", at(7), 0, null, 0, 0, 0, 0, 0, null, null, 0]], turns: [], compacts: [] }));
  const store = make();
  await store.ingest("server-01", { calls: [call("ok1", at(8), { errorText: null, errorDropped: false }), failCall("err:a", at(9), "API Error: Connection lost mid-response."), failCall("err:b", at(10), "")] });
  const raw = JSON.parse(readFileSync(path.join(days, "2026-10-02.json"), "utf8")).calls;
  const byRid = Object.fromEntries(raw.map((row) => [row[1], row]));
  assert.equal(byRid.ok1.length, 14);
  assert.equal(byRid["err:old"].length, 14);
  assert.equal(byRid["err:a"][14], "API Error: Connection lost mid-response.");
  assert.equal(byRid["err:b"][14], "");

  const snap = Object.fromEntries((await make().snapshot(["server-01"])).calls.map((c) => [c.rid, c]));
  assert.deepEqual([snap["err:old"].errorText, snap["err:old"].errorDropped], [null, false]);
  assert.equal(snap["err:a"].errorText, "API Error: Connection lost mid-response.");
  assert.equal(snap["err:b"].errorText, "");
  assert.equal(snap.ok1.errorText, null);
}));

test("错误原文有总字节上限：放不下的只记「未保存」，不挤掉已有原文；重读同一调用不重复计", () => withStore(async ({ dir }) => {
  const store = createUsageStore({ rootDir: dir, now: () => NOW, errorTextBudgetBytes: 50 });
  await store.ingest("server-01", { calls: [failCall("err:1", at(8), "a".repeat(30))] });
  await store.ingest("server-01", { calls: [failCall("err:1", at(8), "a".repeat(30)), failCall("err:2", at(9), "b".repeat(30))] });
  const snap = Object.fromEntries((await store.snapshot(["server-01"])).calls.map((c) => [c.rid, c]));
  assert.equal(snap["err:1"].errorText, "a".repeat(30));
  assert.deepEqual([snap["err:2"].errorText, snap["err:2"].errorDropped], [null, true]);
  // 落盘为 0，重新加载后仍是「超出上限未保存」
  const reloaded = Object.fromEntries((await createUsageStore({ rootDir: dir, now: () => NOW }).snapshot(["server-01"])).calls.map((c) => [c.rid, c]));
  assert.equal(reloaded["err:2"].errorDropped, true);
}));

// ── 冷启动（评审 #4）：并发的首次读取共享同一次加载；失败可重试 ──

test("冷启动：并发的 getCursors 与 snapshot 等同一次加载，都看到落盘数据", () => withStore(async ({ make }) => {
  await make().ingest("server-01", { calls: [call("r1", at(8))], cursors: { "/f.jsonl": { i: "1", o: 9, mt: sec(NOW), s: {} } } });
  const store = make();
  const before = store.revision();
  const [cursors, snap, coverage] = await Promise.all([store.getCursors("server-01"), store.snapshot(["server-01"]), store.coverageStart(["server-01"])]);
  assert.deepEqual(Object.keys(cursors), ["/f.jsonl"]);
  assert.deepEqual(snap.calls.map((c) => c.rid), ["r1"]);
  assert.equal(coverage, "2026-10-02");
  // 加载完成推进数据版本（摘要缓存据此失效）
  assert.ok(store.revision() > before);
}));

test("冷启动：读盘失败不标记已加载，下次访问重试成功", () => withStore(async ({ dir, make }) => {
  // days 被占成普通文件：readdir 报 ENOTDIR（非「目录不存在」），这一次加载失败
  mkdirSync(path.join(dir, "server-01"), { recursive: true });
  writeFileSync(path.join(dir, "server-01", "days"), "not a dir");
  const store = make();
  const results = await Promise.allSettled([store.getCursors("server-01"), store.snapshot(["server-01"])]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  // 修好目录后，同一个 store 再访问会重新加载（不会停留在「已加载的空数据」）
  rmSync(path.join(dir, "server-01", "days"));
  await make().ingest("server-01", { calls: [call("r1", at(8))] });
  assert.deepEqual((await store.snapshot(["server-01"])).calls.map((c) => c.rid), ["r1"]);
}));

// ── 90 天保留（评审 #5）：常驻进程跨日持续清理 ──

test("保留期：时钟前进 91 天后，内存与日文件里的旧数据被清掉、coverageStart 前移、错误原文额度释放", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const store = createUsageStore({ rootDir: dir, now: () => clock, errorTextBudgetBytes: 50 });
  await store.ingest("server-01", {
    sessions: [{ agent: "claude", sid: "s1", cwd: "/home/u/p", window: null }],
    calls: [call("old", at(8)), failCall("err:old", at(9), "a".repeat(40))],
    turns: [{ agent: "codex", sid: "c1", tid: "t1", t0: at(9), t1: at(9, 5) }],
    compacts: [{ agent: "claude", sid: "s1", t: at(10) }],
    cursors: { "/old.jsonl": { i: "1", o: 1, mt: sec(NOW), s: {} } },
  });
  assert.equal(await store.coverageStart(["server-01"]), "2026-10-02");
  const days = path.join(dir, "server-01", "days");
  assert.deepEqual(readdirSync(days), ["2026-10-02.json"]);

  // 同一个 store（不重建，模拟常驻进程）：时钟前进 91 天，没有任何新扫描也要清掉
  clock = NOW + 91 * 86400 * 1000;
  const revision = store.revision();
  const empty = await store.snapshot(["server-01"]);
  assert.deepEqual([empty.calls.length, empty.turns.length, empty.compacts.length, empty.sessions.length], [0, 0, 0, 0]);
  assert.equal(await store.coverageStart(["server-01"]), null);
  assert.deepEqual(await store.getCursors("server-01"), {});
  assert.deepEqual(readdirSync(days), []);
  assert.ok(store.revision() > revision, "清理推进数据版本");

  // 新调用照常入库；旧错误原文占的额度已释放，新原文能保存（预算 50 字节，旧的 40 + 新的 40 本放不下）
  const today = sec(clock) - 3600;
  await store.ingest("server-01", { calls: [call("new", today), failCall("err:new", today + 1, "b".repeat(40))] });
  const snap = Object.fromEntries((await store.snapshot(["server-01"])).calls.map((c) => [c.rid, c]));
  assert.deepEqual(Object.keys(snap).sort(), ["err:new", "new"]);
  assert.equal(snap["err:new"].errorText, "b".repeat(40));
  assert.equal(await store.coverageStart(["server-01"]), dayKeyOf(today));
  assert.deepEqual(readdirSync(days), [`${dayKeyOf(today)}.json`]);
  // 会话与游标的落盘也同步了：重启后不会把过期会话的旧时间读回来
  const reloaded = (await createUsageStore({ rootDir: dir, now: () => clock }).snapshot(["server-01"])).sessions;
  assert.deepEqual(reloaded.map((s) => [s.sid, s.firstT]), [["s1", today]]);
}));

test("保留期：同一北京日内只清理一次，跨日再清（按每条记录自己的日期）", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const store = createUsageStore({ rootDir: dir, now: () => clock });
  // 两天的数据：10-01 与 10-02（北京时间）
  await store.ingest("server-01", { calls: [call("d1", at(12, 0, -1)), call("d2", at(12))] });
  // 前进到「10-01 刚好过期、10-02 还在保留期」的那一天
  clock = NOW + 90 * 86400 * 1000;
  const revision = store.revision();
  assert.deepEqual((await store.snapshot(["server-01"])).calls.map((c) => c.rid), ["d2"]);
  const afterFirst = store.revision();
  assert.ok(afterFirst > revision);
  // 同一天再访问：不重复清理（数据版本不变）
  await store.snapshot(["server-01"]);
  assert.equal(store.revision(), afterFirst);
  // 再跨一天：10-02 也过期
  clock += 86400 * 1000;
  assert.deepEqual((await store.snapshot(["server-01"])).calls, []);
  assert.deepEqual(readdirSync(path.join(dir, "server-01", "days")), []);
}));

// ── 落盘并发（v2.57 评审后续）：写盘按服务器串行，游标不先于数据 ──

// 可编排的 fs：包住真实的 node:fs/promises，按「操作 + 路径」拦住或弄坏某一次调用，由测试决定先后。
const REAL_FS = { mkdir, readdir, readFile, rename, unlink, writeFile };

function gatedFs() {
  const rules = [];
  let inFlight = 0;
  const wrap = (op) => async (file, ...rest) => {
    const rule = rules.find((r) => !r.hit && r.match(op, String(file)));
    if (rule) {
      rule.hit = true;
      rule.onEnter();
      await rule.released;
      if (rule.error) throw rule.error;
    }
    inFlight += 1;
    try {
      return await REAL_FS[op](file, ...rest);
    } finally {
      inFlight -= 1;
    }
  };
  const fs = { ...REAL_FS, mkdir: wrap("mkdir"), unlink: wrap("unlink"), writeFile: wrap("writeFile"), rename: wrap("rename") };
  const add = (match, error = null) => {
    let onEnter;
    let release;
    const entered = new Promise((resolve) => { onEnter = resolve; });
    const released = error ? Promise.resolve() : new Promise((resolve) => { release = resolve; });
    rules.push({ match, hit: false, onEnter, released, error });
    return { entered, release };
  };
  return {
    fs,
    // 拦住第一次满足 match 的调用：entered 在它被拦住时兑现，release() 放行。
    hold: (match) => add(match),
    // 让第一次满足 match 的调用失败。
    fail: (match, message = "EIO: injected") => add(match, Object.assign(new Error(message), { code: "EIO" })),
    // 等到除了被拦住的那一步之外没有在途的 fs 调用（连续三拍）：其余写盘要么已做完、要么在排队。
    async idle() {
      for (let quiet = 0; quiet < 3;) {
        await new Promise((resolve) => setImmediate(resolve));
        quiet = inFlight === 0 ? quiet + 1 : 0;
      }
    },
  };
}

const diskCalls = (dir, day) => {
  const file = path.join(dir, "server-01", "days", `${day}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).calls.map((row) => row[1]).sort() : [];
};
const diskCursor = (dir) => JSON.parse(readFileSync(path.join(dir, "server-01", "cursors.json"), "utf8")).cursors["/f.jsonl"]?.o ?? null;
const cursorAt = (o) => ({ "/f.jsonl": { i: "1", o, mt: sec(NOW) + 365 * 86400, s: {} } });

test("落盘并发：跨日清理的 flush 写盘途中来了一轮 ingest——刚标脏的日照样落盘，游标不先于数据", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const gate = gatedFs();
  const store = createUsageStore({ rootDir: dir, now: () => clock, fs: gate.fs });
  await store.ingest("server-01", { calls: [call("d1", at(12, 0, -1)), call("d2", at(12))], cursors: cursorAt(10) });

  // 跨日，10-01 过期：任何一次访问（这里是首页摘要取扫描状态）都会触发清理并落盘。
  // 把这一轮 flush 拦在它的日文件操作上（建好 days 目录之后的第一次 unlink）。
  clock = NOW + 90 * 86400 * 1000;
  let flushing = false;
  const pruneFlush = gate.hold((op, file) => {
    if (op === "mkdir" && file.endsWith("days")) flushing = true;
    return flushing && op === "unlink" && file.endsWith("2026-10-01.json");
  });
  const access = store.getScanStatus("server-01");
  await pruneFlush.entered;

  // 清理的 flush 还没写完：探针 ingest 带着今天的新调用与前进了的游标进来（它自己的 flush 拦在建目录上）
  const today = sec(clock) - 3600;
  const ingestFlush = gate.hold((op, file) => op === "mkdir" && file.endsWith("days"));
  const ingest = store.ingest("server-01", { calls: [call("new", today)], cursors: cursorAt(99) });
  await gate.idle();
  pruneFlush.release();
  await access;

  // 清理那一轮写完的这一刻，盘上必须自洽：游标要是已经到了 99，「new」就得已经在日文件里
  const offset = diskCursor(dir);
  assert.ok(offset === 10 || diskCalls(dir, dayKeyOf(today)).includes("new"), `游标已写到 ${offset}，对应的调用却还没落盘`);

  ingestFlush.release();
  await ingest;
  // 全部落定后从盘上重建（模拟重启）：新调用在，游标到 99
  const reloaded = createUsageStore({ rootDir: dir, now: () => clock });
  assert.deepEqual((await reloaded.snapshot(["server-01"])).calls.map((c) => c.rid).sort(), ["d2", "new"]);
  assert.equal((await reloaded.getCursors("server-01"))["/f.jsonl"].o, 99);
}));

test("落盘并发：一个日文件正在写时同一天又进来新调用——旧内容不会后写、盖掉新内容", () => withStore(async ({ dir }) => {
  const gate = gatedFs();
  const store = createUsageStore({ rootDir: dir, now: () => NOW, fs: gate.fs });
  // 第一轮：10-02 的日文件内容已经取好（只有 r1），拦在写临时文件之前
  const firstWrite = gate.hold((op, file) => op === "writeFile" && file.includes("2026-10-02.json.tmp."));
  const first = store.ingest("server-01", { calls: [call("r1", at(10))], cursors: cursorAt(10) });
  await firstWrite.entered;
  // 第二轮：同一天再来一条，游标继续前进
  const second = store.ingest("server-01", { calls: [call("r2", at(11))], cursors: cursorAt(20) });
  await gate.idle();
  firstWrite.release();
  await Promise.all([first, second]);

  assert.deepEqual(diskCalls(dir, "2026-10-02"), ["r1", "r2"]);
  assert.equal(diskCursor(dir), 20);
  const reloaded = createUsageStore({ rootDir: dir, now: () => NOW });
  assert.deepEqual((await reloaded.snapshot(["server-01"])).calls.map((c) => c.rid).sort(), ["r1", "r2"]);
}));

test("落盘失败：日文件没写成就不写游标，脏标记留着，下一轮补写（会话文件同理）", () => withStore(async ({ dir }) => {
  const gate = gatedFs();
  const store = createUsageStore({ rootDir: dir, now: () => NOW, fs: gate.fs });
  await store.ingest("server-01", { calls: [call("r0", at(9, 0, -1))], cursors: cursorAt(5) });

  gate.fail((op, file) => op === "writeFile" && file.includes("2026-10-02.json.tmp."));
  await assert.rejects(store.ingest("server-01", { calls: [call("r1", at(10))], cursors: cursorAt(10) }), /EIO/);
  assert.deepEqual(diskCalls(dir, "2026-10-02"), []);
  assert.equal(diskCursor(dir), 5, "数据没落盘，游标不能前进");

  gate.fail((op, file) => op === "writeFile" && file.includes("sessions.json.tmp."));
  await assert.rejects(store.ingest("server-01", { sessions: [{ agent: "claude", sid: "s1", cwd: "/home/u/p", window: null }], calls: [], cursors: cursorAt(15) }), /EIO/);
  assert.deepEqual(diskCalls(dir, "2026-10-02"), ["r1"], "上一轮没写成的日这一轮补上了");
  assert.equal(diskCursor(dir), 5, "会话文件没写成，游标仍不前进");

  await store.flush("server-01");
  assert.equal(diskCursor(dir), 15);
  const reloaded = createUsageStore({ rootDir: dir, now: () => NOW });
  const snap = await reloaded.snapshot(["server-01"]);
  assert.deepEqual(snap.calls.map((c) => c.rid).sort(), ["r0", "r1"]);
  assert.equal(snap.sessions.find((s) => s.sid === "s1").cwd, "/home/u/p");
}));

// CI（Linux、慢盘）上红过一次：首次访问时负责保留期清理的那次 ingest 在等 readdir，后到的都改完了，
// 它醒来把自己那份较旧的游标写了回去——盘上游标是 1 而不是 120（数据一条没丢）。
test("落盘并发：首次访问的保留期清理读目录很慢时，并发入库仍按到达顺序生效（旧游标不盖新游标）", () => withStore(async ({ dir }) => {
  let slowed = false;
  const slowFs = {
    ...nodeFsPromises,
    readdir: async (...args) => {
      if (!slowed) {
        slowed = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return nodeFsPromises.readdir(...args);
    },
  };
  const store = createUsageStore({ rootDir: dir, now: () => NOW, fs: slowFs });
  const pending = [];
  for (let i = 0; i < 40; i += 1) {
    pending.push(store.ingest("server-01", { calls: [call(`r${i}`, at(8, i))], cursors: cursorAt(i + 1) }));
    if (i % 4 === 1) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
  assert.equal(slowed, true, "夹具自检：慢的那次 readdir 确实发生了");
  assert.equal((await store.getCursors("server-01"))["/f.jsonl"].o, 40);
  const reloaded = createUsageStore({ rootDir: dir, now: () => NOW });
  assert.equal((await reloaded.getCursors("server-01"))["/f.jsonl"].o, 40);
  assert.equal((await reloaded.snapshot(["server-01"])).calls.length, 40);
}));

test("落盘并发：入库 / 读取 / 失败记录在真实磁盘上错开交织，落定后盘上与内存一致", () => withStore(async ({ make }) => {
  const store = make();
  const pending = [];
  for (let i = 0; i < 120; i += 1) {
    // 三天轮着写，游标逐次前进；每隔几次让出一拍，让前面的写盘走到不同的进度
    pending.push(store.ingest("server-01", { calls: [call(`r${i}`, at(8, i % 60, -(i % 3)))], cursors: cursorAt(i + 1) }));
    if (i % 7 === 3) pending.push(store.getScanStatus("server-01"));
    if (i % 11 === 5) pending.push(store.recordError("server-01", "ssh exit 255"));
    if (i % 4 === 1) await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
  const want = Array.from({ length: 120 }, (_, i) => `r${i}`).sort();
  assert.deepEqual((await store.snapshot(["server-01"])).calls.map((c) => c.rid).sort(), want);
  const reloaded = make();
  assert.deepEqual((await reloaded.snapshot(["server-01"])).calls.map((c) => c.rid).sort(), want);
  assert.equal((await reloaded.getCursors("server-01"))["/f.jsonl"].o, 120);
}));

// ── 空转不写盘：没有新数据、游标也没动的一轮不重写游标文件，也不推进数据版本 ──

// 记账的 fs：包住真实的 node:fs/promises，记下每次 rename 落定的文件名（原子写的最后一步 = 一次整份重写）
// 与 fs 调用的总次数。
function countingFs() {
  const writes = [];
  let calls = 0;
  const fs = Object.fromEntries(Object.keys(REAL_FS).map((op) => [op, async (...args) => {
    calls += 1;
    if (op === "rename") writes.push(path.basename(String(args[1])));
    return REAL_FS[op](...args);
  }]));
  return { fs, writes, calls: () => calls, cursorWrites: () => writes.filter((name) => name === "cursors.json").length };
}

const scanEnd = (patch = {}) => ({ complete: true, files: 0, pending: 0, sec: 0.01, roots: { codex: false, claude: true }, home: "/home/u", ...patch });
const idleScan = (patch = {}) => ({ calls: [], sessions: [], turns: [], compacts: [], cursors: {}, end: scanEnd(), ...patch });
const diskScan = (dir) => JSON.parse(readFileSync(path.join(dir, "server-01", "cursors.json"), "utf8")).scan;

test("空转的一轮不重写 cursors.json、不推进数据版本；扫描时刻最多 5 分钟落一次盘，游标或扫描事实一变立刻写", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const disk = countingFs();
  const store = createUsageStore({ rootDir: dir, now: () => clock, fs: disk.fs });
  await store.ingest("server-01", {
    sessions: [{ agent: "claude", sid: "s1", cwd: "/home/u/p", window: null }],
    calls: [call("r1", at(10))],
    cursors: cursorAt(10),
    end: scanEnd({ files: 1, pending: 1 }),
  });
  assert.deepEqual(disk.writes, ["2026-10-02.json", "sessions.json", "cursors.json"]);
  const revision = store.revision();

  // 稳态：每分钟一轮、远端什么都没回传。14 轮里只有第 5、10 分钟各落一次扫描时刻（旧实现 14 次整份重写）。
  for (let minute = 1; minute <= 14; minute += 1) {
    clock = NOW + minute * 60_000;
    const before = disk.calls();
    assert.deepEqual(await store.ingest("server-01", idleScan()), { added: 0, updated: 0 });
    if (minute % 5) assert.equal(disk.calls(), before, `第 ${minute} 分钟的空转一轮不该有任何 fs 调用`);
    // 内存里的扫描状态照旧每轮更新
    assert.equal((await store.getScanStatus("server-01")).lastScanAt, clock);
  }
  assert.equal(disk.cursorWrites(), 1 + 2);
  assert.deepEqual(disk.writes.slice(3), ["cursors.json", "cursors.json"], "空转不碰日文件与会话文件");
  assert.equal(store.revision(), revision, "空转不推进数据版本（摘要缓存不失效）");
  // 此刻重启：读回的是第 10 分钟那一轮的时刻——一次真实的扫描，离现在不超过 5 分钟
  assert.equal((await createUsageStore({ rootDir: dir, now: () => clock }).getScanStatus("server-01")).lastScanAt, NOW + 10 * 60_000);

  // 显式 flush：攒着没写的时刻立刻落盘；内容已与盘上逐字节相同时再 flush 不重写
  await store.flush("server-01");
  assert.equal(disk.cursorWrites(), 4);
  assert.equal(diskScan(dir).lastScanAt, clock);
  await store.flush("server-01");
  assert.equal(disk.cursorWrites(), 4);

  // 末行没写完的文件：远端每轮原样回传同一份游标——没动，照样算空转
  clock += 60_000;
  await store.ingest("server-01", idleScan({ cursors: cursorAt(10) }));
  assert.equal(disk.cursorWrites(), 4);
  assert.equal(store.revision(), revision);

  // 游标动了（读到的新行里没有用量记录）：立刻写，不等间隔
  clock += 60_000;
  await store.ingest("server-01", idleScan({ cursors: cursorAt(20) }));
  assert.equal(disk.cursorWrites(), 5);
  assert.equal(diskCursor(dir), 20);
  assert.ok(store.revision() > revision);

  // 扫描事实变了（回填没扫完）：立刻写；数据与游标没变，数据版本不动
  const afterCursor = store.revision();
  clock += 60_000;
  await store.ingest("server-01", idleScan({ end: scanEnd({ complete: false, pending: 3 }) }));
  assert.equal(disk.cursorWrites(), 6);
  assert.deepEqual([diskScan(dir).complete, diskScan(dir).pending, diskScan(dir).lastScanAt], [false, 3, clock]);
  assert.equal(store.revision(), afterCursor);

  // 失败原因同理：第一次出现立刻写，之后每分钟同一个原因只按间隔落盘
  clock += 60_000;
  await store.recordError("server-01", "ssh exit 255");
  assert.equal(disk.cursorWrites(), 7);
  assert.equal(diskScan(dir).lastError, "ssh exit 255");
  clock += 60_000;
  await store.recordError("server-01", "ssh exit 255");
  assert.equal(disk.cursorWrites(), 7);
  assert.equal((await store.getScanStatus("server-01")).lastScanAt, clock);
}));

test("空转不写盘：游标文件上一轮没写成时，下一轮哪怕什么都没变也要补写（不等 5 分钟）", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const gate = gatedFs();
  const store = createUsageStore({ rootDir: dir, now: () => clock, fs: gate.fs });
  await store.ingest("server-01", { calls: [call("r0", at(9))], cursors: cursorAt(5), end: scanEnd({ files: 1, pending: 1 }) });

  gate.fail((op, file) => op === "writeFile" && file.includes("cursors.json.tmp."));
  await assert.rejects(store.ingest("server-01", { calls: [call("r1", at(10))], cursors: cursorAt(10), end: scanEnd({ files: 1, pending: 1 }) }), /EIO/);
  assert.deepEqual(diskCalls(dir, "2026-10-02"), ["r0", "r1"], "数据已落盘");
  assert.equal(diskCursor(dir), 5, "游标没写成");

  // 一分钟后的空转一轮：内存里游标早就是 10、这一轮什么都没变——但盘上还是 5，必须补上
  clock += 60_000;
  await store.ingest("server-01", idleScan());
  assert.equal(diskCursor(dir), 10);
  assert.equal(diskScan(dir).lastScanAt, clock);
}));

test("空转不写盘：本机时钟被往回拨时扫描时刻照常落盘，不会一直等到时钟追上来", () => withStore(async ({ dir }) => {
  let clock = NOW;
  const disk = countingFs();
  const store = createUsageStore({ rootDir: dir, now: () => clock, fs: disk.fs });
  await store.ingest("server-01", idleScan());
  clock = NOW - 3600_000;
  await store.ingest("server-01", idleScan());
  assert.equal(disk.cursorWrites(), 2);
  assert.equal(diskScan(dir).lastScanAt, clock);
}));
