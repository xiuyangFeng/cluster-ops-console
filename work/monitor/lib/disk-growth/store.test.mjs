import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { KEEP_CHILDREN } from "./model.mjs";
import {
  cleanHomePath, cleanMeasurement, createDiskGrowthStore, DISK_GROWTH_FILE, DISK_GROWTH_MAX_BYTES, DISK_GROWTH_MAX_MEASUREMENTS,
  DISK_GROWTH_RETENTION_MS,
} from "./store.mjs";

const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 12, 6, 0);
const OUTPUTS = "Digital_twin/GNN/outputs";

const measurement = (at, { children = 3, nameLength = 12, root = OUTPUTS } = {}) => ({
  at,
  startedAt: at - 30_000,
  trigger: "schedule",
  complete: true,
  stop: null,
  rounds: 4,
  disk: { used: 38 * 2 ** 40, total: 44 * 2 ** 40, pct: 91 },
  roots: [{
    root, jobs: 20, at, state: "ok", error: null,
    c: Array.from({ length: children }, (_, i) => [`${"b".repeat(nameLength - 3)}${String(i).padStart(3, "0")}`, (children - i) * 2 ** 30, 0]),
    o: [5 * 2 ** 30, 2, 3 * 2 ** 30, 0],
  }],
});

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "disk-growth-store-"));
  return { dir, file: path.join(dir, "rt", DISK_GROWTH_FILE), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("存储：0600 原子写、重启后读回；内容没变不重写；坏文件当空表", async () => {
  const { file, done } = tmp();
  try {
    const store = createDiskGrowthStore({ filePath: file, now: () => NOW });
    assert.equal(await store.get("s1"), null);
    await store.update("s1", (draft) => {
      Object.assign(draft, { home: "/public/home/kai/", homeEnv: "/home/kai", homeAt: NOW - HOUR, roots: [{ root: OUTPUTS, jobs: 812 }], attempt: { at: NOW, outcome: "ok", error: null } });
      draft.measurements.push(measurement(NOW - HOUR), measurement(NOW - 7 * HOUR));
    });
    const saved = await store.get("s1");
    assert.deepEqual([saved.home, saved.homeEnv, saved.homeAt, saved.roots, saved.attempt.outcome], ["/public/home/kai", "/home/kai", NOW - HOUR, [{ root: OUTPUTS, jobs: 812 }], "ok"]);
    assert.deepEqual(saved.measurements.map((m) => m.at), [NOW - 7 * HOUR, NOW - HOUR], "按时刻升序");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    saved.measurements.length = 0;
    assert.equal((await store.get("s1")).measurements.length, 2, "读到的是副本");

    // 内容没变：不产生新文件。原子写是「写临时文件再改名」，重写过 inode 就会变（Windows 的文件系统不保证这一点，只在 POSIX 上看）。
    const inode = () => (process.platform === "win32" ? 0 : statSync(file).ino);
    const before = inode();
    await store.update("s1", (draft) => { draft.attempt = { at: NOW, outcome: "ok", error: null }; });
    assert.equal(inode(), before);
    const reopened = createDiskGrowthStore({ filePath: file, now: () => NOW });
    assert.deepEqual(await reopened.get("s1"), await store.get("s1"));
    await reopened.update("s1", () => {});
    assert.equal(inode(), before, "读回再原样写：仍然不重写");
    await reopened.update("s1", (draft) => { draft.attempt = { at: NOW + 1, outcome: "partial", error: "x" }; });
    if (process.platform !== "win32") assert.notEqual(inode(), before);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).servers.s1.attempt.outcome, "partial");

    await assert.rejects(store.update("s1", () => { throw new Error("boom"); }), /boom/);
    assert.equal((await store.get("s1")).measurements.length, 2, "改到一半抛错：原记录不动，之后照常可用");
    await store.update("../x", (draft) => { draft.home = "/h"; });
    assert.equal(await store.get("../x"), null, "不合格的服务器 id 不落盘");

    writeFileSync(file, "{broken");
    const logs = [];
    assert.equal(await createDiskGrowthStore({ filePath: file, log: (text) => logs.push(text) }).get("s1"), null);
    // 坏文件先留档（<名字>.corrupt-<北京时间>）再当空表，不再被下一次写盘悄悄盖掉。
    assert.match(logs[0], /disk-growth\.json）不是有效的 JSON，原文件已留档为 disk-growth\.json\.corrupt-\d{8}-\d{6}，按空表重建/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 99, servers: { s1: {} } }));
    assert.equal(await createDiskGrowthStore({ filePath: file }).get("s1"), null);
    assert.equal(await createDiskGrowthStore({ filePath: path.join(path.dirname(file), "missing.json") }).get("s1"), null);
    assert.equal(await createDiskGrowthStore().get("s1"), null, "不给路径：只在内存里");
  } finally {
    done();
  }
});

test("保留：14 天以前的清掉；条数超限时删时间上最密的、先动 48 小时以前的，最近一次永远留着", async () => {
  const store = createDiskGrowthStore({ now: () => NOW });
  await store.update("s1", (draft) => {
    draft.measurements.push(measurement(NOW - DISK_GROWTH_RETENTION_MS - HOUR), measurement(NOW - DISK_GROWTH_RETENTION_MS + HOUR), measurement(NOW));
  });
  assert.deepEqual((await store.get("s1")).measurements.map((m) => m.at), [NOW - DISK_GROWTH_RETENTION_MS + HOUR, NOW]);

  // 近 48 小时里每 20 分钟一次（手动点得很密）+ 更早每 6 小时一次：超限后被删的全是 48 小时以前的
  const dense = createDiskGrowthStore({ now: () => NOW });
  const recent = Array.from({ length: 70 }, (_, i) => NOW - i * 20 * 60_000);
  const old = Array.from({ length: 30 }, (_, i) => NOW - 49 * HOUR - i * 6 * HOUR);
  await dense.update("s1", (draft) => { draft.measurements.push(...[...recent, ...old].map((at) => measurement(at))); });
  const kept = (await dense.get("s1")).measurements.map((m) => m.at);
  assert.equal(kept.length, DISK_GROWTH_MAX_MEASUREMENTS);
  assert.equal(kept.at(-1), NOW);
  assert.equal(kept.filter((at) => NOW - at <= 48 * HOUR).length, 70, "近 48 小时的一条没少");
  assert.equal(kept[0], old.at(-1), "最早的一次留着，中间挨得近的先走");
  // 没有 48 小时以前的可删：才动近的，而且是从最密的地方删
  const tight = createDiskGrowthStore({ now: () => NOW });
  const times = [...Array.from({ length: DISK_GROWTH_MAX_MEASUREMENTS }, (_, i) => NOW - (i + 1) * 30 * 60_000), NOW - 31 * 60_000, NOW];
  await tight.update("s1", (draft) => { draft.measurements.push(...times.map((at) => measurement(at))); });
  const left = (await tight.get("s1")).measurements.map((m) => m.at);
  assert.equal(left.length, DISK_GROWTH_MAX_MEASUREMENTS);
  assert.ok(left.includes(NOW) && left.includes(NOW - 80 * 30 * 60_000), "两头都在");
  assert.ok(!left.includes(NOW - 31 * 60_000) || !left.includes(NOW - 30 * 60_000), "挨在一起的两次删掉一次");
});

test("大小上限：整份不超过 256 KB——超了就删最密的一次，哪怕每台只剩最近一次也要放得下", async () => {
  const { file, done } = tmp();
  try {
    const store = createDiskGrowthStore({ filePath: file, now: () => NOW });
    // 4 个集合目录 × 40 个长名字子目录 ≈ 每次 20 KB；60 次远超上限
    const big = (at) => ({ ...measurement(at), roots: ["a", "b", "c", "d"].map((root) => measurement(at, { children: KEEP_CHILDREN, nameLength: 110, root }).roots[0]) });
    await store.update("s1", (draft) => { draft.measurements.push(...Array.from({ length: 60 }, (_, i) => big(NOW - i * 5 * HOUR))); });
    const size = statSync(file).size;
    assert.ok(size <= DISK_GROWTH_MAX_BYTES, `实际 ${size}`);
    const kept = (await store.get("s1")).measurements;
    assert.ok(kept.length >= 8 && kept.length < 60, `留下 ${kept.length} 次`);
    assert.equal(kept.at(-1).at, NOW);
    assert.equal(kept.at(-1).roots.length, 4);
    assert.ok(kept.filter((m) => NOW - m.at <= 48 * HOUR).length >= 8, "先删的是 48 小时以前的");

    const tiny = createDiskGrowthStore({ maxBytes: 600, now: () => NOW });
    await tiny.update("s1", (draft) => { draft.measurements.push(big(NOW)); });
    assert.deepEqual((await tiny.get("s1")).measurements, [], "单次就放不下：宁可不存");
  } finally {
    done();
  }
});

test("读回的内容当不可信数据：字段白名单、条目封顶、坏的整条丢弃", async () => {
  const { file, done } = tmp();
  try {
    const good = measurement(NOW - HOUR);
    const raw = {
      schemaVersion: 1,
      servers: {
        s1: {
          home: "relative/home",
          homeEnv: "/",
          homeAt: NOW,
          roots: [{ root: "../etc", jobs: 1 }, { root: OUTPUTS, jobs: -3 }, { root: OUTPUTS, jobs: 9 }, { root: "a" }, { root: "b" }, { root: "c" }, { root: "d" }],
          attempt: { at: NOW, outcome: "exploded" },
          measurements: [
            good,
            { ...good, at: "yesterday" },
            { ...good, at: NOW - 2 * HOUR, roots: [] },
            { ...good, at: NOW - 3 * HOUR, trigger: "cron", stop: "weird", rounds: -4, disk: { used: -1, pct: 400 }, extra: "<script>", roots: [{
              root: OUTPUTS, jobs: 2.9, at: NOW, state: "partial", error: "<b>", junk: 1,
              c: [["ok", 5, 1], ["ok", 9, 0], ["bad\u0001", 5, 0], ["neg", -1, 0], "junk", ...Array.from({ length: 60 }, (_, i) => [`n${i}`, i, 0])],
              o: [7, "x", 3],
            }, { root: "/abs", at: NOW, state: "ok" }, { root: "x", at: NOW, state: "invented" }] },
          ],
        },
        "../evil": { home: "/h" },
      },
    };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(raw));
    const store = createDiskGrowthStore({ filePath: file, now: () => NOW });
    const entry = await store.get("s1");
    assert.deepEqual([entry.home, entry.homeEnv, entry.homeAt, entry.attempt], [null, null, null, null], "家目录不合格：探到的时刻也不留");
    assert.deepEqual(entry.roots, [{ root: OUTPUTS, jobs: 0 }, { root: "a", jobs: 0 }, { root: "b", jobs: 0 }, { root: "c", jobs: 0 }]);
    assert.deepEqual(entry.measurements.map((m) => m.at), [NOW - 3 * HOUR, NOW - HOUR]);
    const cleaned = entry.measurements[0];
    assert.deepEqual([cleaned.trigger, cleaned.stop, cleaned.rounds, cleaned.disk, "extra" in cleaned], ["schedule", null, 0, null, false]);
    assert.equal(cleaned.roots.length, 1);
    const root = cleaned.roots[0];
    assert.deepEqual([root.jobs, root.state, root.error, "junk" in root, root.o], [2, "partial", null, false, [7, 0, 3, 0]]);
    assert.equal(root.c.length, KEEP_CHILDREN);
    assert.deepEqual(root.c[0], ["ok", 5, 1], "同名只留第一条");
    assert.equal(await store.get("../evil"), null);
    assert.equal(cleanMeasurement(null), null);
    assert.equal(cleanMeasurement({ at: NOW, roots: [{ root: OUTPUTS, at: NOW, state: "error", error: "outside-home" }] }).roots[0].error, "outside-home");
  } finally {
    done();
  }
});

test("家目录路径：绝对路径、不是 /、没有控制字符；结尾的斜杠去掉", () => {
  assert.equal(cleanHomePath("/public/home/kai"), "/public/home/kai");
  assert.equal(cleanHomePath("/public/home/kai//"), "/public/home/kai");
  assert.equal(cleanHomePath("/家 目录/用户"), "/家 目录/用户");
  for (const bad of ["/", "", "home/cy", "/a\nb", "/a\u0000b", `/${"x".repeat(1100)}`, null, 5]) assert.equal(cleanHomePath(bad), null, String(bad));
});
