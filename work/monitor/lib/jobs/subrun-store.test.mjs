import assert from "node:assert/strict";
import * as nodeFsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { emptySubrunState } from "./subrun-model.mjs";
import { createSubrunStore, SUBRUNS_FILE, SUBRUNS_MAX_AUTO_JOBS, SUBRUNS_MAX_JOBS } from "./subrun-store.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "./watch-store.mjs";

const NOW = 1791200000000;
const state = (jobId, extra = {}) => ({ ...emptySubrunState({ serverId: "s1", jobId, now: NOW }), ...extra });

test("随关注存储创建在同目录：0600 原子写、重启可读、损坏文件可恢复、写失败不推进游标", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-subruns-"));
  try {
    const watch = createJobWatchStore({ filePath: path.join(dir, JOB_WATCH_FILE), now: () => NOW });
    await watch.subruns.update((d) => { d.jobs.push(state("1", { cursor: { path: "/x", cid: "1:2", off: 10 } })); });
    await watch.flush();
    const file = path.join(dir, SUBRUNS_FILE);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const again = createSubrunStore({ filePath: file, now: () => NOW });
    assert.equal((await again.snapshot()).jobs[0].cursor.off, 10);
    await assert.rejects(again.update((d) => { d.jobs[0].cursor.off = 99; throw Error("boom"); }));
    assert.equal((await again.snapshot()).jobs[0].cursor.off, 10);
    await writeFile(file, "{broken");
    assert.deepEqual((await createSubrunStore({ filePath: file }).snapshot()).jobs, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("没有新记录的一轮不重写游标文件（包括重启后读到的那份）；游标一动照写；写失败后同样的改动仍会写出去", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-subruns-idle-"));
  const file = path.join(dir, SUBRUNS_FILE);
  // 记账的 fs：数 rename 落定到正式文件的次数（原子写的最后一步 = 一次整份重写）；failNext 让下一次失败。
  let writes = 0;
  let failNext = false;
  const fs = {
    ...nodeFsPromises,
    rename: async (from, to) => {
      if (failNext) {
        failNext = false;
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
      await nodeFsPromises.rename(from, to);
      writes += 1;
    },
  };
  const offsetOnDisk = async () => JSON.parse(await readFile(file, "utf8")).jobs[0].cursor.off;
  try {
    const store = createSubrunStore({ filePath: file, now: () => NOW, fs });
    await store.update((d) => { d.jobs.push(state("1", { cursor: { path: "/x", cid: "1:2", off: 10 } })); });
    assert.equal(writes, 1);

    // 关注采集每轮都走一遍 update()；远端没回传记录时什么都没改，返回值照常传回
    for (let i = 0; i < 5; i += 1) assert.equal(await store.update((d) => d.jobs.length), 1);
    assert.equal(writes, 1);
    const again = createSubrunStore({ filePath: file, now: () => NOW, fs });
    await again.update(() => {});
    assert.equal(writes, 1, "重启后读到的那份就是盘上的内容");

    await again.update((d) => { d.jobs[0].cursor.off = 20; });
    assert.equal(writes, 2);
    assert.equal(await offsetOnDisk(), 20);

    failNext = true;
    await assert.rejects(again.update((d) => { d.jobs[0].cursor.off = 30; }), /EIO/);
    assert.equal((await again.snapshot()).jobs[0].cursor.off, 20, "没写成，内存里的游标不前进");
    assert.equal(await offsetOnDisk(), 20);
    await again.update((d) => { d.jobs[0].cursor.off = 30; });
    assert.equal(writes, 3);
    assert.equal(await offsetOnDisk(), 30);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("条数、期限与字节有界：先瘦身最久未更新的指标历史与正常结束明细，再整条丢弃", async () => {
  const store = createSubrunStore({ now: () => NOW, maxBytes: 20000 });
  await store.update((d) => {
    for (let i = 0; i < SUBRUNS_MAX_JOBS + 10; i += 1) d.jobs.push(state(String(i), { updatedAt: NOW - (i === 0 ? 8 * 86400_000 : i) }));
  });
  let snap = await store.snapshot();
  assert.equal(snap.jobs.length, SUBRUNS_MAX_JOBS);
  assert.equal(snap.jobs.some((s) => s.jobId === "0"), false, "超过 7 天的丢掉");
  await store.update((d) => {
    d.jobs = [state("big", { updatedAt: NOW - 10, runs: Array.from({ length: 120 }, (_, i) => ({ run: `R${i}`, phase: "train", attempt: 1, status: i < 100 ? "ok" : "failed", log: { history: Array.from({ length: 30 }, (_, k) => ({ e: k, v: k })) } })) })];
  });
  snap = await store.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 20000);
  assert.equal(snap.jobs[0].runs.length, 20, "只留失败明细");
  assert.equal(snap.jobs[0].runs[0].log.history.length, 0);
});

// ---- v2.62：自动关注的作业另算名额（2026-10-12 独立审查第 1 条）----

test("审查 1：自动关注的状态另有 60 个名额，不占、也挤不掉手动关注的 40 份；自己的名额满了先丢已经收尾的，还在跑的留到最后", async () => {
  const store = createSubrunStore({ now: () => NOW });
  await store.update((d) => {
    // 手动关注的 40 份都比自动的旧——按「最近更新的留下」混着排的话它们会被整批挤掉。
    for (let i = 0; i < SUBRUNS_MAX_JOBS; i += 1) d.jobs.push(state(String(1000 + i), { updatedAt: NOW - 100000 - i }));
    for (let i = 0; i < SUBRUNS_MAX_AUTO_JOBS + 15; i += 1) d.jobs.push(state(String(2000 + i), { auto: true, updatedAt: NOW - i }));
  });
  let snap = await store.snapshot();
  assert.equal(snap.jobs.filter((s) => !s.auto).length, SUBRUNS_MAX_JOBS, "手动关注的一份没少");
  assert.deepEqual(snap.jobs.filter((s) => s.auto).map((s) => s.jobId).sort(), Array.from({ length: SUBRUNS_MAX_AUTO_JOBS }, (_, i) => String(2000 + i)), "自动的留最近更新的 60 份");
  assert.equal(snap.jobs.length, SUBRUNS_MAX_JOBS + SUBRUNS_MAX_AUTO_JOBS, "总量仍然有界");

  // 60 份刚收尾的（更新得更晚）+ 20 份还在跑、有一阵没轮到采样的：在跑的游标不能丢，丢了下一轮又得从头读。
  await store.update((d) => {
    d.jobs = d.jobs.filter((s) => !s.auto);
    for (let i = 0; i < SUBRUNS_MAX_AUTO_JOBS; i += 1) d.jobs.push(state(String(3000 + i), { auto: true, finalized: true, updatedAt: NOW - i }));
    for (let i = 0; i < 20; i += 1) d.jobs.push(state(String(4000 + i), { auto: true, updatedAt: NOW - 5000 - i }));
  });
  snap = await store.snapshot();
  assert.equal(snap.jobs.filter((s) => s.auto && !s.finalized).length, 20, "还在跑的 20 份都在");
  assert.deepEqual(snap.jobs.filter((s) => s.auto && s.finalized).map((s) => s.jobId).sort(), Array.from({ length: 40 }, (_, i) => String(3000 + i)), "让出来的是收尾最久的那 20 份");
  assert.equal(snap.jobs.filter((s) => !s.auto).length, SUBRUNS_MAX_JOBS);
});

test("审查 1：超字节时自动关注的先让——它们瘦身、丢完之前不动手动关注的明细", async () => {
  const okRuns = () => Array.from({ length: 40 }, (_, i) => ({ run: `R${i}`, phase: "train", attempt: 1, status: "ok", log: { history: Array.from({ length: 30 }, (_, k) => ({ e: k, v: k })) } }));
  const failedRuns = () => Array.from({ length: 100 }, (_, i) => ({ run: `F${i}`, phase: "train", attempt: 1, status: "failed", code: 1, log: null }));
  const store = createSubrunStore({ now: () => NOW, maxBytes: 40000 });
  await store.update((d) => {
    // 手动关注的一份：最久没更新、而且瘦得动（正常结束的明细 + 指标历史）。自动的五份全是失败明细，瘦不动。
    d.jobs.push(state("1", { updatedAt: NOW - 9000, runs: okRuns() }));
    for (let i = 0; i < 5; i += 1) d.jobs.push(state(String(200 + i), { auto: true, updatedAt: NOW - i, runs: failedRuns() }));
  });
  const snap = await store.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 40000);
  const manual = snap.jobs.find((s) => s.jobId === "1");
  assert.deepEqual([manual.runs.length, manual.runs[0].log.history.length], [40, 30], "手动关注的明细与指标历史原样留着");
  const autos = snap.jobs.filter((s) => s.auto).map((s) => s.jobId);
  assert.ok(autos.length >= 1 && autos.length < 5, `自动的让出了一部分（还剩 ${autos.length} 份）`);
  assert.equal(autos.includes("204"), false, "先丢最久没更新的");
  // 只剩手动的还超：照原来的办法先瘦身再丢。
  await store.update((d) => { d.jobs = [state("1", { updatedAt: NOW - 9000, runs: [...okRuns(), ...okRuns(), ...okRuns()] })]; });
  assert.equal((await store.snapshot()).jobs[0].runs.length, 0, "没有自动的可让时，手动的照旧瘦身");
});
