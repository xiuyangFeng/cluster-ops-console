import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBaselineEntry, createHistoryStore, formatHistoryDate } from "./history-store.mjs";

// 统一用固定"当前时刻"注入，避免真实时钟跨天导致的用例抖动。
const T0 = new Date("2026-08-30T12:00:00").getTime();

async function withStore(options, fn) {
  const dir = await mkdtemp(join(tmpdir(), "history-store-"));
  const store = createHistoryStore({ dir, flushDelayMs: 5, ...options });
  try {
    await fn(store, dir);
  } finally {
    store.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("history-store: 按天写读回环——不同日期的条目落到各自文件并可完整读回", async () => {
  await withStore({ now: () => T0 }, async (store, dir) => {
    const dayA = T0 - 24 * 3600e3;
    assert.equal(store.record({ type: "transition", ts: dayA, key: "channel", from: "ok", to: "error", reason: "probe fail" }), true);
    assert.equal(store.record({ type: "transition", ts: dayA + 60e3, key: "channel", from: "error", to: "ok", reason: "" }), true);
    assert.equal(store.record({ type: "transition", ts: T0, key: "agent:codex", from: "ok", to: "warn", reason: "" }), true);

    const yesterday = await store.readDay(formatHistoryDate(dayA));
    assert.equal(yesterday.length, 2);
    assert.deepEqual(yesterday.map((e) => `${e.from}>${e.to}`), ["ok>error", "error>ok"]);
    assert.equal(yesterday[0].reason, "probe fail");

    const today = await store.readDay(formatHistoryDate(T0));
    assert.equal(today.length, 1);
    assert.equal(today[0].key, "agent:codex");

    // 文件确实按天分开
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, [`${formatHistoryDate(dayA)}.ndjson`, `${formatHistoryDate(T0)}.ndjson`]);

    // listDays 新日期在前
    assert.deepEqual(await store.listDays(), [formatHistoryDate(T0), formatHistoryDate(dayA)]);
  });
});

test("history-store: 热路径异步批量写——record 后文件不立即存在，flush 周期后才落盘", async () => {
  await withStore({ now: () => T0, flushDelayMs: 20 }, async (store, dir) => {
    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    const file = join(dir, `${formatHistoryDate(T0)}.ndjson`);
    assert.equal(existsSync(file), false, "record 不应同步写盘");
    // 等到落盘为止，最多 5 秒。原来固定睡 60ms：慢的 Windows runner 上定时器加一次异步写盘超过了它（CI 红过）。
    const deadline = Date.now() + 5000;
    while (!existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(file), true, "flush 周期后应已异步落盘");
  });
});

test("history-store: 采样 60s 降采样——窗口内重复样本被丢弃，跨窗口且值变化才写", async () => {
  await withStore({ now: () => T0 }, async (store) => {
    assert.equal(store.record({ type: "sample", ts: T0, key: "server-01", cpu: 10, ram: 40, disk: 55, channelOk: true }), true);
    // 59s 内：无条件丢弃（即使值变了）
    assert.equal(store.record({ type: "sample", ts: T0 + 59e3, key: "server-01", cpu: 99, ram: 40, disk: 55, channelOk: true }), false);
    // 60s 后 + 值变化：写入
    assert.equal(store.record({ type: "sample", ts: T0 + 61e3, key: "server-01", cpu: 20, ram: 40, disk: 55, channelOk: true }), true);
    // 又 60s 后但值未变：跳写
    assert.equal(store.record({ type: "sample", ts: T0 + 122e3, key: "server-01", cpu: 20, ram: 40, disk: 55, channelOk: true }), false);
    // 不同 key 互不影响
    assert.equal(store.record({ type: "sample", ts: T0 + 122e3, key: "server-02", cpu: 5, ram: 30, disk: 60, channelOk: true }), true);
    // 心跳兜底：值未变但距上次落盘超过 heartbeat（默认 5min），强写一条
    assert.equal(store.record({ type: "sample", ts: T0 + 61e3 + 301e3, key: "server-01", cpu: 20, ram: 40, disk: 55, channelOk: true }), true);

    const entries = await store.readDay(formatHistoryDate(T0));
    const s1 = entries.filter((e) => e.key === "server-01");
    assert.deepEqual(s1.map((e) => e.cpu), [10, 20, 20]);
  });
});

test("history-store: 30 天保留——新一天首写触发过期文件异步清理，非历史文件不受影响", async () => {
  await withStore({ now: () => T0, retentionDays: 30 }, async (store, dir) => {
    const expiredDate = formatHistoryDate(T0 - 31 * 24 * 3600e3);
    const keptDate = formatHistoryDate(T0 - 29 * 24 * 3600e3);
    await writeFile(join(dir, `${expiredDate}.ndjson`), `${JSON.stringify({ ts: 1, type: "transition" })}\n`);
    await writeFile(join(dir, `${keptDate}.ndjson`), `${JSON.stringify({ ts: 1, type: "transition" })}\n`);
    await writeFile(join(dir, "not-history.txt"), "keep me\n");

    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    await store.flush(); // 清理挂在 flush 链上，flush 完成即清理完成

    const names = (await readdir(dir)).sort();
    assert.equal(names.includes(`${expiredDate}.ndjson`), false, "过期文件应被清理");
    assert.equal(names.includes(`${keptDate}.ndjson`), true, "保留期内文件不受影响");
    assert.equal(names.includes("not-history.txt"), true, "非历史文件绝不误删");
  });
});

test("history-store: 损坏行容错——半截/垃圾行跳过，其余条目正常返回", async () => {
  await withStore({ now: () => T0 }, async (store, dir) => {
    const date = formatHistoryDate(T0);
    const good1 = JSON.stringify({ ts: T0, type: "transition", key: "channel", from: "ok", to: "error" });
    const good2 = JSON.stringify({ ts: T0 + 1000, type: "transition", key: "channel", from: "error", to: "ok" });
    await writeFile(
      join(dir, `${date}.ndjson`),
      `${good1}\nnot json at all\n{"ts": 123, "type": "trunc\n{"noTs": true}\n${good2}\n`,
    );
    const entries = await store.readDay(date);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.to), ["error", "ok"]);
  });
});

test("history-store: readDay 校验 date 格式，路径穿越与畸形输入一律拒绝", async () => {
  await withStore({ now: () => T0 }, async (store) => {
    for (const bad of ["2026-8-30", "20260830", "../etc/passwd", "2026-08-30/../secret", "2026-08-30\n", "", null, undefined, 20260830]) {
      await assert.rejects(() => store.readDay(bad), (err) => err.code === "EINVALIDDATE", `应拒绝: ${String(bad)}`);
    }
    // 合法但不存在的日期：返回空数组而非抛错
    assert.deepEqual(await store.readDay("1999-01-01"), []);
  });
});

test("history-store: dispose 同步排干缓冲并拒绝后续写入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-store-"));
  try {
    const store = createHistoryStore({ dir, now: () => T0, flushDelayMs: 60e3 }); // 长 flush 周期确保只能靠 dispose 落盘
    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    store.dispose();
    const raw = await readFile(join(dir, `${formatHistoryDate(T0)}.ndjson`), "utf8");
    assert.match(raw, /"to":"error"/);
    assert.equal(store.record({ type: "transition", ts: T0, key: "channel", from: "error", to: "ok" }), false);
    store.dispose(); // 幂等
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("history-store: listDays 忽略无关文件且目录缺失时返回空", async () => {
  await withStore({ now: () => T0 }, async (store, dir) => {
    await writeFile(join(dir, "metrics.json"), "{}");
    await writeFile(join(dir, "2026-08-30.ndjson.bak"), "");
    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "warn" });
    assert.deepEqual(await store.listDays(), [formatHistoryDate(T0)]);
  });
  const ghost = createHistoryStore({ dir: join(tmpdir(), "history-store-definitely-missing"), now: () => T0 });
  assert.deepEqual(await ghost.listDays(), []);
  ghost.dispose();
});

test("formatHistoryDate: 按北京时间归日，与进程的本地时区无关", () => {
  assert.equal(formatHistoryDate(Date.parse("2026-10-02T23:59:59+08:00")), "2026-10-02");
  assert.equal(formatHistoryDate(Date.parse("2026-10-03T00:00:00+08:00")), "2026-10-03");
  assert.equal(formatHistoryDate(Date.parse("2026-10-02T16:00:00Z")), "2026-10-03");
  assert.equal(formatHistoryDate(Date.parse("2026-12-31T15:59:59Z")), "2026-12-31");
  assert.equal(formatHistoryDate(Date.parse("2026-12-31T16:00:00Z")), "2027-01-01");
});

// ---- 状态基线（type: "levels"）----

const LEVELS = { channel: "ok", "agent:codex": "warn", "res:server-01": "ok", "tunnel:server-02": "error" };
const shape = (entries) => entries.map((e) => (e.type === "levels" ? `levels:${e.cause}` : `${e.type}:${e.key}`));

test("history-store 基线: 没注入 provider 时什么都不多记（旧行为不变）", async () => {
  await withStore({ now: () => T0 }, async (store) => {
    assert.equal(store.checkpoint(), false);
    assert.equal(store.recordBaseline({ cause: "view" }), false);
    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    assert.deepEqual(shape(await store.readDay(formatHistoryDate(T0))), ["transition:channel"]);
  });
});

test("history-store 基线: 启动后的第一次写入之前先记 start，同一天不重复；跨天记 day", async () => {
  let clock = T0;
  await withStore({ now: () => clock }, async (store) => {
    store.setBaselineProvider(() => ({ view: "server-01", levels: LEVELS }));
    store.record({ type: "transition", ts: T0, key: "channel", from: "error", to: "ok" });
    store.record({ type: "transition", ts: T0 + 5, key: "agent:codex", from: "ok", to: "warn" });
    const today = await store.readDay(formatHistoryDate(T0));
    assert.deepEqual(shape(today), ["levels:start", "transition:channel", "transition:agent:codex"]);
    assert.deepEqual(today[0], { type: "levels", ts: T0, cause: "start", view: "server-01", levels: LEVELS });

    clock = T0 + 24 * 3600e3;
    store.record({ type: "sample", ts: clock, key: "server-01", cpu: 1 });
    // 零点前后时间戳乱序的迟到条目（仍属前一天）不算跨天，不再补基线
    store.record({ type: "transition", ts: T0 + 10, key: "channel", from: "ok", to: "warn" });
    assert.deepEqual(shape(await store.readDay(formatHistoryDate(clock))), ["levels:day", "sample:server-01"]);
    assert.equal((await store.readDay(formatHistoryDate(T0))).filter((e) => e.type === "levels").length, 1);
  });
});

test("history-store 基线: checkpoint 当天没有基线才补；通道断了一夜没有别的写入也能在跨天后落一份", async () => {
  let clock = T0;
  await withStore({ now: () => clock }, async (store) => {
    store.setBaselineProvider(() => ({ view: "server-01", levels: LEVELS }));
    assert.equal(store.checkpoint(), true);
    assert.equal(store.checkpoint(), false, "同一天第二次不写");
    clock = T0 + 24 * 3600e3;
    assert.equal(store.checkpoint(), true);
    assert.deepEqual(shape(await store.readDay(formatHistoryDate(T0))), ["levels:start"]);
    assert.deepEqual(shape(await store.readDay(formatHistoryDate(clock))), ["levels:day"]);
  });
});

test("history-store 基线: provider 晚注入 / 抛错 / 给不出键时跳过，下一次写入再补", async () => {
  await withStore({ now: () => T0 }, async (store) => {
    store.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    let mode = "throw";
    store.setBaselineProvider(() => {
      if (mode === "throw") throw new Error("boom");
      if (mode === "empty") return { view: "server-01", levels: {} };
      return { view: "server-01", levels: LEVELS };
    });
    assert.equal(store.record({ type: "transition", ts: T0 + 1, key: "channel", from: "error", to: "ok" }), true, "基线取不到不影响正常写入");
    mode = "empty";
    assert.equal(store.checkpoint(), false);
    mode = "ok";
    store.record({ type: "transition", ts: T0 + 2, key: "channel", from: "ok", to: "warn" });
    assert.deepEqual(shape(await store.readDay(formatHistoryDate(T0))), ["transition:channel", "transition:channel", "levels:start", "transition:channel"]);
  });
});

test("history-store 基线: recordBaseline 记 view；恰好是当天第一份时只记一份（start）", async () => {
  await withStore({ now: () => T0 }, async (store) => {
    store.setBaselineProvider(() => ({ view: "server-01", levels: LEVELS }));
    const switched = { channel: "ok", "tunnel:server-01": "ok" };
    assert.equal(store.recordBaseline({ cause: "view", view: "server-02", levels: switched }), true);
    assert.equal(store.recordBaseline({ cause: "view", view: "server-01", levels: LEVELS }), true);
    assert.equal(store.recordBaseline({ cause: "view" }), true, "不带 levels 时向 provider 取");
    const entries = await store.readDay(formatHistoryDate(T0));
    assert.deepEqual(shape(entries), ["levels:start", "levels:view", "levels:view"]);
    assert.deepEqual([entries[0].view, entries[0].levels], ["server-02", switched]);
    assert.equal(entries[1].view, "server-01");
  });
});

test("history-store 基线: 记过基线的进程在 dispose 时留一条 stop 标记，没记过的不留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-store-"));
  try {
    const plain = createHistoryStore({ dir, now: () => T0, flushDelayMs: 5 });
    plain.record({ type: "transition", ts: T0, key: "channel", from: "ok", to: "error" });
    plain.dispose();
    const store = createHistoryStore({ dir, now: () => T0 + 1000, flushDelayMs: 5 });
    store.setBaselineProvider(() => ({ view: "server-01", levels: LEVELS }));
    store.checkpoint();
    store.dispose();
    const reader = createHistoryStore({ dir, now: () => T0 + 2000 });
    const entries = await reader.readDay(formatHistoryDate(T0));
    reader.dispose();
    assert.deepEqual(shape(entries), ["transition:channel", "levels:start", "levels:stop"]);
    assert.deepEqual(entries[2], { type: "levels", ts: T0 + 1000, cause: "stop", view: "", levels: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildBaselineEntry: 只留字符串键值，限键数 / 键长 / 级别名长度；没有可用的键返回 null", () => {
  assert.equal(buildBaselineEntry({ ts: 1, cause: "start", levels: {} }), null);
  assert.equal(buildBaselineEntry({ ts: 1, cause: "start", levels: null }), null);
  assert.equal(buildBaselineEntry({ ts: 1, cause: "start", levels: { channel: 3, "": "ok" } }), null);
  const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`res:s${i}`, "ok"]));
  const entry = buildBaselineEntry({ ts: 7, cause: "bogus", view: 42, levels: { ...many, ["x".repeat(81)]: "ok", channel: "y".repeat(17) } });
  assert.equal(Object.keys(entry.levels).length, 64);
  assert.deepEqual([entry.type, entry.ts, entry.cause, entry.view], ["levels", 7, "view", ""]);
  assert.ok(JSON.stringify(buildBaselineEntry({ ts: T0, cause: "day", view: "server-01", levels: LEVELS })).length < 200, "一条基线只有一两百字节");
});

test("上一次非正常退出（没留停止标记）：本进程第一次落盘前在它最后一条记录的时刻补一条停止标记", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-store-crash-"));
  try {
    const prevTs = Date.UTC(2026, 9, 3, 12, 0);
    const prevDay = formatHistoryDate(prevTs);
    await writeFile(join(dir, `${prevDay}.ndjson`), `${JSON.stringify({ type: "transition", key: "channel", from: "ok", to: "error", ts: prevTs })}\n`);
    const store = createHistoryStore({ dir, flushDelayMs: 5, now: () => prevTs + 3600_000 });
    store.record({ type: "transition", key: "channel", from: "error", to: "ok", ts: prevTs + 3600_000 });
    await store.flush();
    const lines = (await readFile(join(dir, `${prevDay}.ndjson`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const stop = lines.find((entry) => entry.type === "levels" && entry.cause === "stop");
    assert.ok(stop, "补了停止标记");
    assert.equal(stop.ts, prevTs, "时刻取上一个进程的最后一条记录");
    assert.equal(stop.unclean, true);
    assert.ok(lines.indexOf(stop) < lines.findIndex((entry) => entry.ts === prevTs + 3600_000), "排在本进程的记录之前");
    store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("上一次优雅退出（已有停止标记）：不重复补", async () => {
  const dir = await mkdtemp(join(tmpdir(), "history-store-clean-"));
  try {
    const prevTs = Date.UTC(2026, 9, 3, 12, 0);
    const prevDay = formatHistoryDate(prevTs);
    await writeFile(join(dir, `${prevDay}.ndjson`), `${JSON.stringify({ type: "levels", ts: prevTs, cause: "stop", view: "", levels: {} })}\n`);
    const store = createHistoryStore({ dir, flushDelayMs: 5, now: () => prevTs + 60_000 });
    store.record({ type: "transition", key: "channel", from: "ok", to: "error", ts: prevTs + 60_000 });
    await store.flush();
    const raw = await readFile(join(dir, `${prevDay}.ndjson`), "utf8");
    assert.equal((raw.match(/"cause":"stop"/g) || []).length, 1);
    store.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
