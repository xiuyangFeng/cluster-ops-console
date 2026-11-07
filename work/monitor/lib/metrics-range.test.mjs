import assert from "node:assert/strict";
import test from "node:test";

import { formatHistoryDate } from "./history-store.mjs";
import { aggregateDay, createMetricsRange, METRIC_RANGES, unifiedCpu } from "./metrics-range.mjs";
import { inEveryTimeZone } from "./test-timezones.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 时间一律按北京时间（UTC+8）显式构造——日文件按北京时间的日期分，与跑测试的机器时区无关。
// 此前这里用 new Date(y, m, d, h) 按本机时间构造，被测代码也按本机时区算日历，两边错得一致：
// 开发机（UTC+8）上全绿，CI（UTC）上红。
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
// 固定「现在」：北京时间 2026-10-03 18:30。
const NOW = bj(2026, 10, 3, 18, 30);
const at = (daysAgo, hour, minute = 0) => bj(2026, 10, 3 - daysAgo, hour, minute);
const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;
// 7 天窗口：起点落在 7 天前那一天（09-26 … 10-03，8 个北京时间日期），前后各多读一天。
const DATES_7D = ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
const READS_7D = DATES_7D.length;

const sample = (ts, key, fields) => ({ type: "sample", ts, key, ...fields });

// 假历史存储：与 history-store 一样按北京时间的日期分文件，记录每次 readDay 的日期。
function fakeHistory(entries) {
  const reads = [];
  const byDate = new Map();
  const add = (entry) => {
    const date = formatHistoryDate(entry.ts);
    byDate.set(date, [...(byDate.get(date) || []), entry]);
  };
  for (const entry of entries) add(entry);
  return {
    reads,
    add,
    async readDay(date) {
      reads.push(date);
      return [...(byDate.get(date) || [])];
    },
  };
}

test("unifiedCpu: 利用率 → 归一化负载 → 旧 cpu；空值不当 0", () => {
  assert.equal(unifiedCpu({ cpuBusyPct: 12.5, loadNormalizedPct: 80, cpu: 80 }), 12.5);
  assert.equal(unifiedCpu({ cpuBusyPct: null, loadNormalizedPct: 130, cpu: 100 }), 130);
  assert.equal(unifiedCpu({ cpu: 46 }), 46);
  assert.equal(unifiedCpu({ cpuBusyPct: null, loadNormalizedPct: null, cpu: null }), null);
  assert.equal(unifiedCpu(null), null);
});

test("aggregateDay: 只收 sample，按服务器与小时归桶；畸形条目跳过", () => {
  const byServer = aggregateDay([
    sample(at(0, 9, 5), "s1", { cpu: 10, ram: 20, disk: 80, cpuBusyPct: 4, loadNormalizedPct: 10 }),
    sample(at(0, 9, 45), "s1", { cpu: 30, ram: 40, disk: 80, cpuBusyPct: 8, loadNormalizedPct: 30 }),
    sample(at(0, 10, 0), "s1", { cpu: 50, ram: 60, disk: 81, cpuBusyPct: null, loadNormalizedPct: null }),
    sample(at(0, 9, 30), "s2", { cpu: 1, ram: 2, disk: 3 }),
    { type: "transition", ts: at(0, 9, 10), key: "s1", from: "ok", to: "error" },
    { type: "sample", ts: "bad", key: "s1", cpu: 99 },
    { type: "sample", ts: at(0, 9, 20), cpu: 99 },
    null,
  ]);
  assert.deepEqual([...byServer.keys()].sort(), ["s1", "s2"]);
  const hours = byServer.get("s1");
  assert.equal(hours.size, 2);
  // 三条样本两两相隔都超过断档门槛：各算一个采样周期（60 秒）。
  const nine = hours.get(hourOf(at(0, 9)));
  assert.deepEqual(nine.weight, { cpuBusyPct: 120_000, loadNormalizedPct: 120_000, cpu: 120_000, ram: 120_000, disk: 120_000 });
  assert.equal(nine.sum.ram, (20 + 40) * 60_000);
  assert.deepEqual(nine.min, { cpu: 4, ram: 20, disk: 80 }); // CPU 极值用统一口径（这里是利用率）
  assert.deepEqual(nine.max, { cpu: 8, ram: 40, disk: 80 });
  const ten = hours.get(hourOf(at(0, 10)));
  assert.equal(ten.weight.cpuBusyPct, undefined); // null 不计入
  assert.deepEqual(ten.max, { cpu: 50, ram: 60, disk: 81 }); // 利用率 / 负载都缺 → 回落旧 cpu
});

test("aggregateDay: 均值按时长加权——平稳时段只留下几条心跳样本，不能被波动时段的密集样本压过去", () => {
  const entries = [];
  // 10:00–10:50 读数没变，history-store 每 5 分钟才写一条；10:50 起每分钟一条（读数在跳）。
  for (let m = 0; m < 50; m += 5) entries.push(sample(at(0, 10, m), "s1", { ram: 10 }));
  for (let m = 50; m < 60; m += 1) entries.push(sample(at(0, 10, m), "s1", { ram: 100 }));
  const hours = aggregateDay(entries).get("s1");
  const bucket = hours.get(hourOf(at(0, 10)));
  assert.equal(bucket.weight.ram, 60 * 60_000, "整个小时都有读数管着");
  assert.equal(bucket.sum.ram / bucket.weight.ram, 25, "50 分钟的 10 + 10 分钟的 100（按条数平均会得到 55）");
  assert.deepEqual([bucket.min.ram, bucket.max.ram], [10, 100]);
});

test("aggregateDay: 跨整点的读数按时长分摊到两个小时；断档只算一个采样周期，不拿旧读数去填", () => {
  const hours = aggregateDay([
    sample(at(0, 10, 58), "s1", { ram: 40 }),
    sample(at(0, 11, 3), "s1", { ram: 80 }), // 距上一条 5 分钟：上一条管到这里
    sample(at(0, 14, 0), "s1", { ram: 10 }), // 距上一条近 3 小时：断档
  ]).get("s1");
  const ten = hours.get(hourOf(at(0, 10)));
  const eleven = hours.get(hourOf(at(0, 11)));
  assert.deepEqual([ten.sum.ram / ten.weight.ram, ten.weight.ram], [40, 2 * 60_000]);
  assert.equal(eleven.weight.ram, 4 * 60_000, "40 管 3 分钟 + 80 管 1 分钟");
  assert.equal(eleven.sum.ram / eleven.weight.ram, 50);
  assert.deepEqual([eleven.min.ram, eleven.max.ram], [80, 80], "极值只记在样本自己所在的小时");
  assert.equal(hours.has(hourOf(at(0, 12))), false);
  assert.equal(hours.has(hourOf(at(0, 13))), false);
  assert.equal(hours.get(hourOf(at(0, 14))).weight.ram, 60_000);
});

test("query 7d: 按小时均值、ts 为桶起点升序、窗口外与别的服务器不混入；没有样本的小时不出现", async () => {
  const history = fakeHistory([
    sample(at(8, 12), "s1", { cpu: 99, ram: 99, disk: 99 }), // 8 天前：文件会被读到，但样本在窗口外
    sample(at(2, 3, 10), "s1", { cpu: 10, ram: 20, disk: 90, cpuBusyPct: 5, loadNormalizedPct: 10 }),
    sample(at(2, 3, 50), "s1", { cpu: 20, ram: 30, disk: 91, cpuBusyPct: 6, loadNormalizedPct: 20 }),
    sample(at(0, 17, 0), "s1", { cpu: 40, ram: 50, disk: 86, cpuBusyPct: 7.26, loadNormalizedPct: 40 }),
    sample(at(0, 17, 30), "s2", { cpu: 1, ram: 1, disk: 1 }),
  ]);
  const range = createMetricsRange({ historyStore: history, now: () => NOW });
  const out = await range.query({ serverId: "s1", range: "7d" });
  assert.equal(out.serverId, "s1");
  assert.equal(out.range, "7d");
  assert.equal(out.stepMs, HOUR);
  assert.equal(out.generatedAt, NOW);
  assert.equal(out.since, hourOf(NOW - 7 * DAY));
  assert.deepEqual(out.samples, [
    { ts: hourOf(at(2, 3)), cpuBusyPct: 5.5, loadNormalizedPct: 15, cpu: 15, ram: 25, disk: 90.5 },
    { ts: hourOf(at(0, 17)), cpuBusyPct: 7.3, loadNormalizedPct: 40, cpu: 40, ram: 50, disk: 86 },
  ]);
  assert.deepEqual(out.extremes, { cpu: { min: 5, max: 7.3 }, ram: { min: 20, max: 50 }, disk: { min: 86, max: 91 } });
  assert.deepEqual([...history.reads].sort(), DATES_7D, "7 天窗口跨 8 个北京时间日期，前后各多读一天，每个文件只读一次");
});

test("query 30d: 3 个小时桶并成一个；字段全缺给 null；没有任何样本时 extremes 为 null", async () => {
  const base = Math.floor(at(10, 6) / (3 * HOUR)) * 3 * HOUR; // 对齐到 3 小时桶的起点
  const history = fakeHistory([
    sample(base + 10 * 60_000, "s1", { cpu: 10, ram: 10, disk: 70 }),
    sample(base + HOUR + 10 * 60_000, "s1", { cpu: 20, ram: 20, disk: 70 }),
    sample(base + 2 * HOUR + 10 * 60_000, "s1", { cpu: 60, ram: 30, disk: 73 }),
    sample(base + 3 * HOUR + 10 * 60_000, "s1", { ram: 80 }),
  ]);
  const range = createMetricsRange({ historyStore: history, now: () => NOW });
  const out = await range.query({ serverId: "s1", range: "30d" });
  assert.equal(out.stepMs, METRIC_RANGES["30d"].stepMs);
  assert.deepEqual(out.samples, [
    { ts: base, cpuBusyPct: null, loadNormalizedPct: null, cpu: 30, ram: 20, disk: 71 },
    { ts: base + 3 * HOUR, cpuBusyPct: null, loadNormalizedPct: null, cpu: null, ram: 80, disk: null },
  ]);
  assert.deepEqual(out.extremes, { cpu: { min: 10, max: 60 }, ram: { min: 10, max: 80 }, disk: { min: 70, max: 73 } });

  const empty = await range.query({ serverId: "nobody", range: "30d" });
  assert.deepEqual(empty.samples, []);
  assert.deepEqual(empty.extremes, { cpu: null, ram: null, disk: null });
});

test("query: 换过时区后样本落在相邻日期的文件里也能读到（取舍只看样本自己的 ts）", async () => {
  const reads = [];
  const before = formatHistoryDate(NOW - 8 * DAY); // 窗口起点所在日期的前一天
  const after = formatHistoryDate(NOW + DAY); // 明天
  const files = {
    [before]: [sample(NOW - 6 * DAY, "s1", { ram: 11 })],
    [after]: [sample(NOW - HOUR, "s1", { ram: 22 }), sample(NOW - 9 * DAY, "s1", { ram: 99 })],
  };
  const history = {
    async readDay(date) {
      reads.push(date);
      return files[date] || [];
    },
  };
  const out = await createMetricsRange({ historyStore: history, now: () => NOW }).query({ serverId: "s1", range: "7d" });
  assert.ok(reads.includes(before) && reads.includes(after));
  assert.deepEqual(out.samples.map((s) => [s.ts, s.ram]), [[hourOf(NOW - 6 * DAY), 11], [hourOf(NOW - HOUR), 22]]);
});

test("缓存：过完的日子只读一次；还没过完的日期过了 liveTtl 才重读，新样本随之出现", async () => {
  let nowMs = NOW;
  const history = fakeHistory([
    sample(at(1, 12), "s1", { cpu: 10, ram: 10, disk: 10 }),
    sample(at(0, 12), "s1", { cpu: 20, ram: 20, disk: 20 }),
  ]);
  const range = createMetricsRange({ historyStore: history, now: () => nowMs, liveTtlMs: 60_000 });
  await range.query({ serverId: "s1", range: "7d" });
  assert.equal(history.reads.length, READS_7D);

  // TTL 内：一个文件都不重读。
  nowMs = NOW + 30_000;
  history.add(sample(at(0, 18, 20), "s1", { cpu: 90, ram: 90, disk: 90 }));
  const cached = await range.query({ serverId: "s1", range: "7d" });
  assert.equal(history.reads.length, READS_7D);
  assert.equal(cached.samples.length, 2);

  // 过了 TTL：只重读今天与（多读的）明天，过完的那些天一直用缓存。
  nowMs = NOW + 61_000;
  const fresh = await range.query({ serverId: "s1", range: "7d" });
  assert.deepEqual(history.reads.slice(READS_7D), [formatHistoryDate(NOW), formatHistoryDate(NOW + DAY)]);
  assert.equal(fresh.samples.length, 3);
  assert.equal(fresh.extremes.cpu.max, 90);

  // 30 天范围复用已缓存的那几天，只补读更早的日期。
  const before = history.reads.length;
  await range.query({ serverId: "s1", range: "30d" });
  const extra = history.reads.slice(before);
  assert.equal(extra.length, 23, "31 个北京时间日期 + 前后各一天 = 33，其中 10 个已缓存");
  assert.ok(extra.every((date) => date < formatHistoryDate(NOW - 8 * DAY)));
});

test("日历口径与机器时区无关：读哪些日文件、哪天算过完，只看北京时间", async () => {
  await inEveryTimeZone(async (zone) => {
    // 读的是北京时间的那 10 个日期，不随机器时区多读 / 少读 / 错读
    const week = fakeHistory([sample(at(0, 12), "s1", { ram: 1 })]);
    await createMetricsRange({ historyStore: week, now: () => NOW }).query({ serverId: "s1", range: "7d" });
    assert.deepEqual([...week.reads].sort(), DATES_7D, zone);

    // 北京时间 23:10：今天（10-03）还有 50 分钟没过完，不能当成定稿缓存。
    // 机器时区在 UTC+8 以东（东京 / 奥克兰）时本机的 10-03 已经过完——旧实现按本机零点判，
    // 之后写进 10-03.ndjson 的样本直到进程重启都读不到。
    let nowMs = at(0, 23, 10);
    const history = fakeHistory([sample(at(0, 22, 30), "s1", { ram: 10 })]);
    const range = createMetricsRange({ historyStore: history, now: () => nowMs, liveTtlMs: 60_000 });
    assert.deepEqual((await range.query({ serverId: "s1", range: "7d" })).samples.map((s) => s.ram), [10], zone);
    history.add(sample(at(0, 23, 40), "s1", { ram: 90 }));

    // 刚过北京时间零点 1 分钟：昨天的最后一批缓冲可能还没落盘，仍要重读
    nowMs = at(-1, 0, 1);
    let before = history.reads.length;
    const justAfter = await range.query({ serverId: "s1", range: "7d" });
    assert.ok(history.reads.slice(before).includes("2026-10-03"), `${zone}: 零点后 2 分钟内仍重读昨天`);
    assert.deepEqual(justAfter.samples.map((s) => s.ram), [10, 90], zone);

    // 过了零点 2 分钟再读到的才算定稿：这之后昨天不再读盘，样本一条不少
    nowMs = at(-1, 0, 3);
    await range.query({ serverId: "s1", range: "7d" });
    nowMs = at(-1, 9, 0);
    before = history.reads.length;
    const nextMorning = await range.query({ serverId: "s1", range: "7d" });
    assert.equal(history.reads.slice(before).includes("2026-10-03"), false, `${zone}: 定稿后不再重读`);
    assert.deepEqual(nextMorning.samples.map((s) => s.ram), [10, 90], zone);
  });
});

test("并发的两次查询共用同一轮读盘；非法范围抛错不读盘", async () => {
  const history = fakeHistory([sample(at(0, 12), "s1", { cpu: 1, ram: 1, disk: 1 })]);
  const range = createMetricsRange({ historyStore: history, now: () => NOW });
  const [a, b] = await Promise.all([range.query({ serverId: "s1", range: "7d" }), range.query({ serverId: "s1", range: "7d" })]);
  assert.deepEqual(a.samples, b.samples);
  assert.equal(history.reads.length, READS_7D);
  await assert.rejects(() => range.query({ serverId: "s1", range: "90d" }), /invalid range/);
  assert.equal(history.reads.length, READS_7D);
});
