import assert from "node:assert/strict";
import * as nodeFsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SUBRUNS_FILE } from "./subrun-store.mjs";
import { createJobWatchStore, FAIL_SEEN_MAX, JOB_WATCH_FILE } from "./watch-store.mjs";

const NOW = 1791200000000;

// 记账的 fs：包住真实的 node:fs/promises，记下每次 rename 落定的文件名（原子写的最后一步 = 一次整份重写）。
// failNextRename() 让下一次 rename 失败一次（临时文件已写好、正式文件没换上）。
function countingFs() {
  const writes = [];
  let failing = false;
  const fs = {
    ...nodeFsPromises,
    rename: async (from, to) => {
      if (failing) {
        failing = false;
        throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
      }
      await nodeFsPromises.rename(from, to);
      writes.push(path.basename(String(to)));
    },
  };
  return { fs, writes, count: (name) => writes.filter((n) => n === name).length, failNextRename: () => { failing = true; } };
}

test("内容没变的 update 不重写文件（包括重启后读到的那份）；内容一变照写；返回值与内存语义不变", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-idle-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  try {
    const disk = countingFs();
    const store = createJobWatchStore({ filePath, now: () => NOW, fs: disk.fs });
    assert.equal(await store.update((d) => { d.resources.push({ serverId: "s1", jobId: "1", checkedAt: NOW, name: "作业" }); return "first"; }), "first");
    assert.equal(disk.count(JOB_WATCH_FILE), 1);
    const saved = await readFile(filePath, "utf8");

    // 作业采集每轮的样子：照例过一遍 update()，但什么都没改（旧实现每次都整份重写）
    for (let i = 0; i < 5; i += 1) {
      assert.equal(await store.update((d) => { d.notifications = d.notifications.filter((n) => n.serverId === "s1"); return i; }), i);
    }
    assert.equal(disk.count(JOB_WATCH_FILE), 1);
    assert.equal((await store.snapshot()).resources.length, 1);

    // 重启：读到的那份就是盘上的内容，头一轮没变化的 update 同样不写
    const again = createJobWatchStore({ filePath, now: () => NOW, fs: disk.fs });
    await again.update(() => {});
    assert.equal(disk.count(JOB_WATCH_FILE), 1);
    assert.equal(await readFile(filePath, "utf8"), saved);

    // 改了就写；再改回最初的内容也要写——比的是盘上现在那份，不是头一次读到的那份
    await again.update((d) => { d.quietUntil = NOW + 1000; });
    assert.equal(disk.count(JOB_WATCH_FILE), 2);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).quietUntil, NOW + 1000);
    await again.update((d) => { d.quietUntil = 0; });
    assert.equal(disk.count(JOB_WATCH_FILE), 3);
    assert.equal(await readFile(filePath, "utf8"), saved);

    // 加载时被清掉东西（这里是过期 31 天的复盘）：候选内容与盘上不同，头一次 update 就把清理结果写回去
    await writeFile(filePath, JSON.stringify({ ...JSON.parse(saved), resources: [{ serverId: "s1", jobId: "9", checkedAt: NOW - 31 * 86400_000 }] }));
    const pruned = createJobWatchStore({ filePath, now: () => NOW, fs: disk.fs });
    await pruned.update(() => {});
    assert.equal(disk.count(JOB_WATCH_FILE), 4);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")).resources, []);

    // 子任务游标文件随同一个 fs：头一次 update 建文件，之后没变化不重写
    await store.subruns.update(() => {});
    await store.subruns.update(() => {});
    assert.equal(disk.count(SUBRUNS_FILE), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("写盘失败不污染「盘上那份」的记忆：内存不前进，同样的改动再来一次照样写出去", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-fail-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  try {
    const disk = countingFs();
    const store = createJobWatchStore({ filePath, now: () => NOW, fs: disk.fs });
    await store.update((d) => { d.quietUntil = 1; });
    disk.failNextRename();
    await assert.rejects(store.update((d) => { d.quietUntil = 5; }), /EIO/);
    assert.equal((await store.snapshot()).quietUntil, 1, "没写成，内存不前进");
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).quietUntil, 1);
    // 同样的改动重试：候选内容与失败的那次逐字节相同，但盘上还是旧的——必须写
    await store.update((d) => { d.quietUntil = 5; });
    assert.equal(disk.count(JOB_WATCH_FILE), 2);
    assert.equal(JSON.parse(await readFile(filePath, "utf8")).quietUntil, 5);
    assert.equal((await createJobWatchStore({ filePath, now: () => NOW }).snapshot()).quietUntil, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("并发确认串行落盘、0600、重启不丢已读、损坏文件可恢复", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  try {
    const store = createJobWatchStore({ filePath, now: () => NOW });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.update((d) => d.notifications.push({ id: String(i), serverId: "s1", createdAt: NOW, readAt: i % 2 ? NOW : null }))));
    await store.flush();
    const loaded = createJobWatchStore({ filePath, now: () => NOW });
    const snap = await loaded.snapshot();
    assert.equal(snap.notifications.length, 20);
    assert.equal(snap.notifications[1].readAt, NOW);
    if (process.platform !== "win32") assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    snap.notifications.length = 0;
    assert.equal((await loaded.snapshot()).notifications.length, 20, "调用方不能修改存储");
    await writeFile(filePath, "broken");
    assert.deepEqual((await createJobWatchStore({ filePath }).snapshot()).notifications, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- v2.62 提醒规则带来的两样新数据：failures（失败提醒的去重记录）与带 auto 的自动组 ----

test("升级前的文件（没有 failures）照常读回：头一次 update 补上字段写一次，之后不再重写", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-upgrade-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  try {
    const old = { schemaVersion: 1, quietUntil: 0, settings: { s1: { silenceMinutes: 45, limitMinutes: 30 } }, watches: [], notifications: [{ id: "n", serverId: "s1", watchId: "w", kind: "ended", createdAt: NOW, readAt: null }], resources: [] };
    await writeFile(filePath, JSON.stringify(old));
    const disk = countingFs();
    const store = createJobWatchStore({ filePath, now: () => NOW, fs: disk.fs });
    const snap = await store.snapshot();
    assert.deepEqual(snap.failures, {});
    assert.deepEqual([snap.settings.s1.silenceMinutes, snap.notifications[0].watchId], [45, "w"], "原有的设置与提醒原样保留");
    await store.update(() => {});
    await store.update(() => {});
    assert.equal(disk.count(JOB_WATCH_FILE), 1);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { ...old, failures: {} });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("失败提醒的去重记录：读盘时形状不对的丢掉；到期的清掉（成批，见审查 10 那一例）；超出条数丢最早结束的并抬高起算点", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-failures-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  const HOUR = 3600_000;
  try {
    await writeFile(filePath, JSON.stringify({
      schemaVersion: 1, quietUntil: 0, settings: {}, watches: [], notifications: [], resources: [],
      failures: {
        s1: { since: NOW - 50 * HOUR, introduced: true, notifiedAt: NOW - HOUR, pending: ["12", "../x", 7, "13_4"], seen: { 10: NOW - 100 * HOUR, 11: NOW - 10 * HOUR, "12": NOW - HOUR, "13_4": NOW - 2 * HOUR, "bad id": NOW, 14: "soon" } },
        s2: { since: "x", seen: { 20: NOW } },
        s3: { seen: [1, 2] },
        s4: "junk",
      },
    }));
    const store = createJobWatchStore({ filePath, now: () => NOW });
    const { failures } = await store.snapshot();
    assert.deepEqual(failures, {
      s1: { since: NOW - 50 * HOUR, seen: { 11: NOW - 10 * HOUR, 12: NOW - HOUR, "13_4": NOW - 2 * HOUR }, introduced: true, notifiedAt: NOW - HOUR, pending: ["12", "13_4"] },
      s2: { since: 0, seen: { 20: NOW } },
    });
    assert.deepEqual((await createJobWatchStore({ filePath: path.join(dir, "missing.json") }).snapshot()).failures, {});
  } finally { await rm(dir, { recursive: true, force: true }); }

  const store = createJobWatchStore({ now: () => NOW });
  await store.update((d) => { d.failures.s1 = { since: NOW - 60 * HOUR, seen: Object.fromEntries(Array.from({ length: FAIL_SEEN_MAX + 300 }, (_, i) => [String(1000 + i), NOW - HOUR + i])) }; });
  const { s1 } = (await store.snapshot()).failures;
  assert.equal(Object.keys(s1.seen).length, FAIL_SEEN_MAX);
  assert.equal(s1.seen["1299"], undefined, "丢的是最早结束的 300 个");
  assert.equal(s1.seen["1300"], NOW - HOUR + 300);
  assert.equal(s1.since, NOW - HOUR + 299, "起算点抬到被丢掉的最晚那个：它们不会再被当成新的失败");
});

test("审查 10：见过的失败作业到期后成批清理——不为每一个的到期各重写一次文件", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-sweep-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  const HOUR = 3600_000;
  try {
    const disk = countingFs();
    let clock = NOW;
    const store = createJobWatchStore({ filePath, now: () => clock, fs: disk.fs });
    // 五个作业在五个小时里先后失败。
    await store.update((d) => { d.failures.s1 = { since: 0, seen: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [String(i), NOW - (5 - i) * HOUR])) }; });
    assert.equal(disk.count(JOB_WATCH_FILE), 1);
    // 之后五天每小时过一遍（作业采集每轮都会走 update）：它们陆续到期，但文件只因清理重写一次。
    for (let hour = 1; hour <= 120; hour += 1) {
      clock = NOW + hour * HOUR;
      await store.update(() => {});
    }
    assert.equal(disk.count(JOB_WATCH_FILE), 2, "五个作业的到期合成一次清理");
    assert.deepEqual((await store.snapshot()).failures.s1.seen, {});
    // 没到期的不受牵连：到期的那一批清掉时，新近的留着。
    await store.update((d) => { d.failures.s1.seen = { 10: clock - 100 * HOUR, 11: clock - 80 * HOUR, 12: clock - 10 * HOUR }; });
    assert.deepEqual(Object.keys((await store.snapshot()).failures.s1.seen), ["12"]);
    // 刚过 72 小时、还不到成批清理的时候：先留着（多留一天不碍事，仍在「见过」里只会少提醒不会多提醒）。
    await store.update((d) => { d.failures.s1.seen = { 20: clock - 80 * HOUR, 21: clock - HOUR }; });
    assert.deepEqual(Object.keys((await store.snapshot()).failures.s1.seen), ["20", "21"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("审查 12：服务器 id 是 __proto__ / constructor 这类名字时，读盘规整不丢数据、不改原型", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-proto-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  try {
    // 直接写 JSON 文本：JSON.parse 会把 "__proto__" 读成一个自有属性。
    await writeFile(filePath, `{"schemaVersion":1,"quietUntil":0,"settings":{"__proto__":{"rules":{"failNotify":false,"longRunMinutes":null,"patterns":["xp_*"]}}},"watches":[],"notifications":[],"resources":[],` +
      `"failures":{"__proto__":{"since":5,"seen":{"7":${NOW}}},"constructor":{"since":6,"seen":{"8":${NOW}}}}}`);
    const store = createJobWatchStore({ filePath, now: () => NOW });
    const snap = await store.snapshot();
    assert.deepEqual(Object.keys(snap.failures).sort(), ["__proto__", "constructor"]);
    assert.ok(Object.hasOwn(snap.failures, "__proto__") && Object.hasOwn(snap.settings, "__proto__"));
    assert.deepEqual(Object.getOwnPropertyDescriptor(snap.failures, "__proto__").value, { since: 5, seen: { 7: NOW } });
    assert.deepEqual(Object.getOwnPropertyDescriptor(snap.failures, "constructor").value, { since: 6, seen: { 8: NOW } });
    assert.equal(Object.getPrototypeOf(snap.failures), Object.prototype);
    await store.update((d) => { d.quietUntil = 1; });
    const again = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(Object.getOwnPropertyDescriptor(again.failures, "__proto__").value, { since: 5, seen: { 7: NOW } });
    assert.deepEqual(Object.getOwnPropertyDescriptor(again.settings, "__proto__").value.rules.patterns, ["xp_*"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("总上限里手动关注优先：超出组数 / 作业数时先放掉自动组；auto 形状不对的整组丢弃；自动组不按 30 天清理、服务器退出范围后才清", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "job-watch-auto-"));
  const filePath = path.join(dir, JOB_WATCH_FILE);
  const item = (id, state = "RUNNING") => ({ id: String(id), name: `job_${id}`, state, outcome: state === "RUNNING" ? "running" : "completed", checkedAt: NOW });
  const manual = (id, jobs, createdAt = NOW) => ({ id: `m${id}`, serverId: "s1", label: `手动 ${id}`, muted: false, createdAt, jobs });
  const auto = (id, jobs, extra = {}) => ({ id: `a${id}`, serverId: "s1", label: `rule_${id}_*`, muted: false, createdAt: NOW, jobs, auto: { rule: `name:rule_${id}_*`, doneAt: NOW, idleSince: null, notifiedAt: {} }, ...extra });
  const base = { schemaVersion: 1, quietUntil: 0, settings: {}, notifications: [], resources: [], failures: {} };
  try {
    // 作业数超限：自动组先走（哪怕它排在前面、建得更早），手动的一个不少。
    let n = 0;
    const ids = (count) => Array.from({ length: count }, () => { n += 1; return item(n); });
    await writeFile(filePath, JSON.stringify({ ...base, watches: [auto(1, ids(30)), manual(1, ids(100)), auto(2, ids(30)), manual(2, ids(90)), auto(3, ids(5), { auto: { rule: 5 } }), auto(4, ids(5), { auto: "yes" })] }));
    let snap = await createJobWatchStore({ filePath, now: () => NOW }).snapshot();
    assert.deepEqual(snap.watches.map((w) => [w.id, w.jobs.length]), [["m1", 100], ["m2", 90]], "190 个手动的全留；两个 30 的自动组放不下，形状不对的两个直接丢");

    // 组数超限：41 组里有一个自动组，丢的是它而不是最早的手动组。
    await writeFile(filePath, JSON.stringify({ ...base, watches: [...Array.from({ length: 20 }, (_, i) => manual(i, [item(1000 + i)])), auto(9, [item(5000)]), ...Array.from({ length: 20 }, (_, i) => manual(20 + i, [item(2000 + i)]))] }));
    snap = await createJobWatchStore({ filePath, now: () => NOW }).snapshot();
    assert.deepEqual([snap.watches.length, snap.watches.some((w) => w.auto), snap.watches[0].id], [40, false, "m0"]);
  } finally { await rm(dir, { recursive: true, force: true }); }

  // 30 天清理：手动组照旧（建了 30 天以上且没有在跑的就清）；自动组跟着规则走，留着；服务器退出采集范围（suspended）后同样清掉。
  const old = NOW - 31 * 86400_000;
  const store = createJobWatchStore({ now: () => NOW });
  await store.update((d) => {
    d.watches = [manual("old", [item(1, "COMPLETED")], old), manual("busy", [item(2)], old), { ...auto("kept", [item(3, "COMPLETED")]), createdAt: old }, { ...auto("empty", []), createdAt: old }, { ...auto("gone", [item(4, "COMPLETED")]), createdAt: old, suspended: true }];
  });
  assert.deepEqual((await store.snapshot()).watches.map((w) => w.id), ["mbusy", "akept", "aempty"]);

  // 字节上限兜底：提醒、复盘都清空后先放自动组，再放手动组，最后才是去重记录与设置。
  const tight = createJobWatchStore({ now: () => NOW, maxBytes: 900 });
  await tight.update((d) => {
    d.settings.s1 = { rules: { failNotify: false, longRunMinutes: null, patterns: ["x_*"] } };
    d.failures.s1 = { since: 0, seen: { 1: NOW } };
    d.watches = [manual(1, [{ ...item(1), progress: { tail: "x".repeat(300) } }]), auto(1, [{ ...item(2), progress: { tail: "y".repeat(600) } }])];
  });
  const left = await tight.snapshot();
  assert.deepEqual(left.watches.map((w) => w.id), ["m1"]);
  assert.deepEqual([left.settings.s1.rules.patterns, Object.keys(left.failures.s1.seen)], [["x_*"], ["1"]]);
});

test("30天清理、条数与字节三重有界；失败变更不破坏已保存状态", async () => {
  const store = createJobWatchStore({ now: () => NOW, maxBytes: 4000 });
  await store.update((d) => {
    d.notifications = Array.from({ length: 400 }, (_, i) => ({ id: String(i), serverId: "s1", createdAt: i < 100 ? NOW - 31 * 86400_000 : NOW, body: "x".repeat(200) }));
  });
  const snap = await store.snapshot();
  assert.ok(snap.notifications.length < 20);
  assert.ok(Buffer.byteLength(JSON.stringify(snap)) <= 4000);
  assert.equal(snap.notifications.at(-1).id, "399");
  await assert.rejects(store.update((d) => { d.quietUntil = 123; throw Error("failed"); }));
  assert.equal((await store.snapshot()).quietUntil, 0);
});
