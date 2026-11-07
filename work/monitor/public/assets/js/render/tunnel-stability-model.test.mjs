import assert from "node:assert/strict";
import { test } from "node:test";

import {
  availabilityText,
  buildResponseStrip,
  buildStrip,
  shortServerName,
  availabilityTone,
  buildDropRows,
  buildStabilityRows,
  causeLines,
  lastDropText,
  uptimeTicks,
  windowStartOf,
  causeLabel,
  dropsTone,
  formatResponseMs,
  humanDuration,
  latestResponseTs,
  mergeResponseSamples,
  niceMax,
  responseHoverAt,
  responsePaths,
  shortDateTime,
} from "./tunnel-stability-model.js";

const NOW = Date.UTC(2026, 9, 2, 13, 0, 0); // 北京时间 10.2 21:00
const MIN = 60_000;
const DAY = 86_400_000;

test("humanDuration：秒 / 分 / 小时 / 天", () => {
  assert.equal(humanDuration(18_000), "18 秒");
  assert.equal(humanDuration(200_000), "3 分 20 秒");
  assert.equal(humanDuration(7_500_000), "2 小时 5 分");
  assert.equal(humanDuration(3 * 86_400_000 + 4 * 3_600_000), "3 天 4 小时");
  assert.equal(humanDuration(null), "—");
});

test("可用率：数据不足 / 100% / 有断开时不显示成 100.00%", () => {
  assert.equal(availabilityText(null), "数据不足");
  assert.equal(availabilityText(1), "100%");
  assert.equal(availabilityText(0.99999), "99.99%");
  assert.equal(availabilityText(0.9876), "98.76%");
  assert.equal(availabilityTone(0.9995), "ok");
  assert.equal(availabilityTone(0.995), "warn");
  assert.equal(availabilityTone(0.9), "critical");
  assert.equal(dropsTone(0, "24h"), "ok");
  assert.equal(dropsTone(3, "24h"), "warn");
  assert.equal(dropsTone(14, "24h"), "critical");
  assert.equal(dropsTone(14, "7d"), "warn", "7 天窗口按日均折算");
});

test("时刻按北京时间显示", () => {
  assert.equal(shortDateTime(NOW), "10.2 21:00");
  assert.equal(causeLabel("keepalive-timeout"), "心跳超时");
  assert.equal(causeLabel("whatever"), "原因未知");
});

test("每条隧道一行：状态、「N 次断线 · 可用率」与语气，悬停明细带原因 / 断开共计 / 平均恢复 / 最长连续在线", () => {
  const stats = {
    servers: {
      a: {
        serverId: "a", name: "阿里云服务器", host: "vpn-aliyun", state: "up", since: NOW - 3_600_000,
        windows: { "24h": { drops: 5, availability: 0.995, downMs: 400_000, recoveries: 5, meanRecoveryMs: 80_000, maxRecoveryMs: 100_000, longestUpMs: 20_000_000, causes: { "keepalive-timeout": 4, "remote-closed": 1 }, networkChangeDrops: 1 } },
      },
      b: { serverId: "b", state: "down", since: NOW - 60_000, lastDrop: null, windows: { "24h": { drops: 0, availability: null } } },
    },
  };
  const [a, b] = buildStabilityRows(stats, "24h", NOW);
  assert.equal(a.stateText, "在线 1 小时");
  assert.equal(a.stateTone, "ok");
  assert.equal(a.summaryText, "5 次断线 · 99.50%");
  assert.equal(a.summaryTone, "critical", "一天 5 次按断线次数算 critical（比可用率的 warn 更重）");
  assert.equal(a.summaryTitle, "心跳超时 ×4 · 服务器端断开 ×1 · 断开共 6 分 40 秒 · 平均恢复 1 分 20 秒（最长 1 分 40 秒） · 最长连续在线 5 小时 33 分 · 其中 1 次刚换过网");
  assert.equal(b.stateText, "断开中 · 1 分");
  assert.equal(b.name, "b");
  assert.equal(b.summaryText, "0 次断线 · 记录不足");
  assert.equal(b.summaryTone, "ok");
  assert.equal(b.summaryTitle, "近 24 小时没有断线");
});

test("最近一次：所有隧道里最新的那次（不限窗口）；没有断线时写记录起点", () => {
  const stats = {
    since: NOW - 3 * 3_600_000,
    servers: { a: { serverId: "a", name: "阿里云服务器 (vpn-aliyun)" } },
    recentDrops: [{ serverId: "a", at: NOW - 3_700_000, cause: "keepalive-timeout", uptimeMs: 6_000_000, recoveredAt: NOW - 3_600_000, downMs: 100_000, networkChange: true }],
  };
  assert.equal(lastDropText(stats), "10.2 19:58 阿里云 · 心跳超时 · 此前在线 1 小时 40 分 · 1 分 40 秒后恢复 · 断线前刚换过网");
  assert.equal(lastDropText({ ...stats, recentDrops: [{ ...stats.recentDrops[0], recoveredAt: null, uptimeMs: null, networkChange: false }] }), "10.2 19:58 阿里云 · 心跳超时 · 尚未恢复");
  assert.equal(lastDropText({ ...stats, recentDrops: [] }), "记录以来没有断线（自 10.2 18:00）");
  assert.equal(lastDropText({}), "还没有记录");
});

test("原因汇总：只列窗口内有断线的服务器", () => {
  const stats = { servers: {
    a: { serverId: "a", name: "主集群服务器 (myserver)", windows: { "24h": { drops: 0 } } },
    b: { serverId: "b", name: "阿里云服务器 (vpn-aliyun)", windows: { "24h": { drops: 11, recoveries: 11, meanRecoveryMs: 61_000, longestUpMs: 9_082_000, causes: { "process-lost": 3, "remote-closed": 8 } } } },
  } };
  assert.deepEqual(causeLines(stats, "24h"), [{ name: "阿里云", text: "服务器端断开 ×8 · 隧道进程消失 ×3 · 平均恢复 1 分 1 秒 · 最长连续在线 2 小时 31 分" }]);
  assert.deepEqual(causeLines(stats, "7d"), []);
});

test("断线列表：服务器显示名、进行中标记", () => {
  const stats = {
    servers: { a: { serverId: "a", name: "阿里云服务器" } },
    recentDrops: [
      { serverId: "a", at: NOW - 60_000, cause: "closed", uptimeMs: 1000, recoveredAt: null },
      { serverId: "a", at: NOW - 600_000, cause: "remote-closed", uptimeMs: 3_600_000, recoveredAt: NOW - 590_000, downMs: 10_000, networkChange: true },
    ],
  };
  const rows = buildDropRows(stats);
  assert.equal(rows[0].name, "阿里云", "短名");
  assert.equal(rows[0].recovery, "进行中");
  assert.equal(rows[0].ongoing, true);
  assert.equal(rows[1].recovery, "10 秒");
  assert.equal(rows[1].networkChange, true);
});

test("每条隧道一行：名字用短名，带在线条（只保留断开 / 未观测段）", () => {
  const stats = {
    since: NOW - 3 * 3_600_000,
    servers: {
      a: {
        serverId: "a", name: "主集群服务器 (myserver)", host: "myserver", state: "up", since: NOW - 3_600_000, lastDrop: null,
        windows: { "24h": { drops: 0, availability: 1, downMs: 0, recoveries: 0, longestUpMs: 3_600_000, causes: {} } },
        timeline: { start: NOW - 86_400_000, end: NOW, segments: [{ from: NOW - 86_400_000, to: NOW - 3 * 3_600_000, state: "unobserved" }, { from: NOW - 3 * 3_600_000, to: NOW, state: "up" }] },
      },
    },
  };
  const [row] = buildStabilityRows(stats, "24h", NOW);
  assert.equal(row.name, "主集群");
  assert.equal(row.fullName, "主集群服务器 (myserver)");
  assert.equal(row.summaryText, "0 次断线 · 100%");
  assert.equal(row.summaryTitle, "近 24 小时没有断线 · 最长连续在线 1 小时");
  assert.equal(row.strip.kind, "timeline");
  assert.deepEqual(row.strip.segments.map((x) => x.state), ["unobserved"], "只保留断开 / 未观测段");
  assert.equal(shortServerName("阿里云服务器 (vpn-aliyun)"), "阿里云");
});

test("时间轴刻度：整 6 小时按北京时间，0 点单独标出", () => {
  const ticks = uptimeTicks(NOW - DAY, NOW);
  assert.deepEqual(ticks.map((t) => t.label), ["0 点", "06:00", "12:00", "18:00"]);
  assert.equal(ticks.find((t) => t.today).label, "0 点");
});

test("近 7 天在线条：每天一块，按当天断线与可用率定语气，没记录画斜纹", () => {
  const entry = { daily: [
    { day: "2026-09-27", availability: null, drops: 0, observedMs: 0, downMs: 0 },
    { day: "2026-10-02", availability: 1, drops: 0, observedMs: 86_400_000, downMs: 0 },
    { day: "2026-10-03", availability: 0.98, drops: 4, observedMs: 40_000_000, downMs: 800_000 },
  ] };
  const strip = buildStrip(entry, "7d");
  assert.equal(strip.kind, "daily");
  assert.deepEqual(strip.days.map((d) => [d.label, d.tone]), [["9.27", "none"], ["10.2", "ok"], ["10.3", "critical"]]);
  assert.match(strip.days[2].title, /断线 4 次 · 可用率 98\.00%/);
});

// ---- SSH 响应 ----

// 相对「现在」第 minutesAgo 分钟前的一条采集耗时。
const point = (minutesAgo, ms) => ({ ts: NOW - minutesAgo * MIN, ms });

test("SSH 响应：耗时写法与取整上限", () => {
  assert.equal(formatResponseMs(292.4), "292ms");
  assert.equal(formatResponseMs(999.6), "1000ms");
  assert.equal(formatResponseMs(1740), "1.74s");
  assert.equal(formatResponseMs(12_345), "12.35s");
  assert.equal(formatResponseMs(null), "—");
  assert.deepEqual([1, 180, 200, 201, 2328, 2500.1, 4877, 0, -3].map(niceMax), [1, 200, 200, 250, 2500, 5000, 5000, 1, 1]);
});

test("SSH 响应：样本并进缓存——按服务器分开、按时刻升序、去重，丢掉窗口之前的点", () => {
  const first = mergeResponseSamples(new Map(), [
    { ts: 3000, serverId: "a", probeDurationMs: 300 },
    { ts: 1000, serverId: "a", probeDurationMs: 100 },
    { ts: 2000, serverId: "b", probeDurationMs: 200 },
    { ts: 2500, serverId: "a", probeDurationMs: null }, // 没带耗时
    { ts: 2600, serverId: "a" },
    { ts: 2700, probeDurationMs: 5 }, // 没有服务器
    null,
  ]);
  assert.deepEqual(first.get("a"), [{ ts: 1000, ms: 100 }, { ts: 3000, ms: 300 }]);
  assert.deepEqual(first.get("b"), [{ ts: 2000, ms: 200 }]);
  assert.equal(latestResponseTs(first), 3000);
  assert.equal(latestResponseTs(new Map()), null);
  // 增量：新样本接在后面；边界上重复的那条不留两份；cutoff 之前的旧点丢掉，空了的服务器整个去掉
  const next = mergeResponseSamples(first, [
    { ts: 3000, serverId: "a", probeDurationMs: 300 },
    { ts: 4000, serverId: "a", probeDurationMs: 400 },
    { ts: 500, serverId: "a", probeDurationMs: 50 },
  ], 2500);
  assert.deepEqual(next.get("a"), [{ ts: 3000, ms: 300 }, { ts: 4000, ms: 400 }]);
  assert.equal(next.has("b"), false);
  assert.deepEqual(first.get("a").length, 2, "不改入参");
  assert.deepEqual([...mergeResponseSamples(null, undefined)], []);
});

test("SSH 响应条：5 分钟一段取最慢的一次、点画在它发生的时刻；中位 / 最慢按逐条样本；纵轴按 99 分位取整", () => {
  const strip = buildResponseStrip([
    point(60, 200), point(59, 900), point(58, 300), // 20:00–20:05 这一段：最慢 900（发生在 20:01）
    point(54, 250), // 20:05–20:10
    point(44, 400), // 20:15–20:20（中间缺了 20:10–20:15 整段）
    point(29, 5000), // 20:30–20:35（又缺了两段）
  ], NOW - DAY, NOW);
  assert.deepEqual(strip.points.map((p) => [(NOW - p.ts) / MIN, p.ms]), [[59, 900], [54, 250], [44, 400], [29, 5000]]);
  assert.equal(strip.medianText, "350ms", "逐条样本的中位数（200 250 300 | 400 900 5000）");
  assert.equal(strip.slowestText, "5.00s");
  assert.equal(strip.yMax, 5000);
  assert.equal(strip.title, "SSH 响应 · 每 5 分钟取最慢的一次 · 纵轴 0–5.00s");

  // 画成 1440 × 28：横向 1 单位 = 1 分钟；连着的两段连线，孤立的段画成点
  const { line, area } = responsePaths(strip, 1440, 28);
  assert.equal(line, "M1381 22.5 L1386 25.8 M1396 25h0.01 M1411 2h0.01");
  assert.equal(area, "M1381 22.5 L1386 25.8 L1386 28 L1381 28 Z");

  // 悬停：取时刻最近的那个点，数值在前、北京时间在后
  assert.deepEqual(responseHoverAt(strip, 1395 / 1440), { left: 1396 / 1440, text: "400ms · 10.2 20:16" });
  assert.equal(responseHoverAt(strip, -5).text, "900ms · 10.2 20:01");
  assert.equal(responseHoverAt(strip, 9).text, "5.00s · 10.2 20:31");
  assert.equal(responseHoverAt(null, 0.5), null);
});

test("SSH 响应条：偶发的一次极慢不把整条线压扁（超出纵轴的点贴顶）；窗口外的样本不算", () => {
  const samples = [point(25 * 60, 9999)];
  for (let m = 23 * 60; m > 0; m -= 1) samples.push(point(m, m === 600 ? 30_000 : 180));
  const strip = buildResponseStrip(samples, NOW - DAY, NOW);
  assert.equal(strip.yMax, 200, "一次 30 秒的卡顿不影响纵轴");
  assert.equal(strip.slowestText, "30.00s", "但「最慢」如实写");
  assert.equal(strip.medianText, "180ms");
  assert.match(responsePaths(strip, 600, 26).line, / L350 2 /, "超出的点贴在顶边");
  // 不足两条 / 没有时间轴：不画
  assert.equal(buildResponseStrip([point(5, 100)], NOW - DAY, NOW), null);
  assert.equal(buildResponseStrip(undefined, NOW - DAY, NOW), null);
  assert.equal(buildResponseStrip(samples, null, null), null);
});

test("近 24 小时窗口带 SSH 响应线（共用在线条的时间轴），近 7 天窗口与没有样本的服务器不带", () => {
  const timeline = { start: NOW - DAY, end: NOW, segments: [{ from: NOW - DAY, to: NOW, state: "up" }] };
  const stats = {
    servers: {
      a: { serverId: "a", name: "主集群服务器 (myserver)", state: "up", since: NOW - DAY, windows: {}, timeline, daily: [] },
      b: { serverId: "b", name: "阿里云服务器", state: "up", since: NOW - DAY, windows: {}, timeline, daily: [] },
    },
  };
  const responses = new Map([["a", [point(10, 1700), point(9, 1800), point(8, 1750)]]]);
  const [a, b] = buildStabilityRows(stats, "24h", NOW, responses);
  assert.deepEqual([a.response.start, a.response.end], [NOW - DAY, NOW]);
  assert.equal(a.response.medianText, "1.75s");
  assert.equal(b.response, null);
  assert.deepEqual(buildStabilityRows(stats, "7d", NOW, responses).map((row) => row.response), [null, null]);
  assert.deepEqual(buildStabilityRows(stats, "24h", NOW).map((row) => row.response), [null, null], "没给样本：只有在线条");
});

test("断线清单按窗口过滤：近 24 小时只列 24 小时内的；窗口起点从统计生成时刻往回推", () => {
  const stats = {
    generatedAt: NOW,
    servers: { a: { serverId: "a", name: "阿里云服务器" } },
    recentDrops: [
      { serverId: "a", at: NOW - 3_600_000, cause: "closed", recoveredAt: NOW - 3_590_000, downMs: 10_000 },
      { serverId: "a", at: NOW - 2 * DAY, cause: "reset", recoveredAt: NOW - 2 * DAY + 10_000, downMs: 10_000 },
    ],
  };
  assert.equal(windowStartOf(stats, "24h"), NOW - DAY);
  assert.equal(windowStartOf(stats, "7d"), NOW - 7 * DAY);
  assert.deepEqual(buildDropRows(stats, undefined, { since: windowStartOf(stats, "24h") }).map((r) => r.cause), ["连接被关闭"]);
  assert.deepEqual(buildDropRows(stats, undefined, { since: windowStartOf(stats, "7d") }).map((r) => r.cause), ["连接被关闭", "连接被重置"]);
});

test("最近断线分组：连续同一服务器同一原因合并成一组（10 行 → 4 行），展开后逐条跟在组后", async () => {
  const { buildDropRows, dropGroupKeyOf } = await import("./tunnel-stability-model.js");
  const BJ = 8 * 3_600_000;
  const at = (h, m) => Date.UTC(2026, 9, 3, h, m) - BJ;
  const M = 60_000;
  // 截图里的真实序列（新 → 旧）
  const seq = [
    [23, 57, "remote-closed", 21 * M + 24_000, 26_000], [23, 36, "remote-closed", 53 * M, 25_000], [22, 43, "remote-closed", 27 * M, 24_000],
    [22, 15, "remote-closed", 43 * M, 26_000], [21, 31, "remote-closed", 33 * M, 37_000], [20, 58, "remote-closed", 38 * M, 23_000],
    [20, 20, "remote-closed", 91 * M, 34_000], [18, 48, "process-lost", 145 * M, 22_000], [16, 16, "remote-closed", 44 * M, 35_000],
    [15, 25, "process-lost", 123 * M, 400_000],
  ];
  const stats = {
    servers: { a: { serverId: "server-aliyun", name: "阿里云服务器 (vpn-aliyun)" } },
    recentDrops: seq.map(([h, m, cause, uptimeMs, downMs]) => ({ serverId: "server-aliyun", at: at(h, m), cause, uptimeMs, recoveredAt: at(h, m) + downMs, downMs })),
  };
  stats.servers = { "server-aliyun": stats.servers.a };
  const rows = buildDropRows(stats);
  assert.equal(rows.length, 4);
  const [group, ...rest] = rows;
  assert.equal(group.kind, "group");
  assert.equal(group.count, 7);
  assert.equal(group.name, "阿里云");
  assert.equal(group.cause, "服务器端断开");
  assert.equal(group.time, "10.3 20:20 – 23:57", "同一天只写一次日期");
  assert.equal(group.uptime, "21 分 24 秒 – 1 小时 31 分");
  assert.equal(group.recovery, "23 秒 – 37 秒");
  assert.deepEqual(rest.map((r) => [r.kind, r.cause]), [["drop", "隧道进程消失"], ["drop", "服务器端断开"], ["drop", "隧道进程消失"]]);
  const key = dropGroupKeyOf(rows, `server-aliyun:${at(22, 43)}`);
  assert.equal(key, group.key, "组里的某次断线能找到所在的组");
  const open = buildDropRows(stats, undefined, { expanded: new Set([key]) });
  assert.equal(open.length, 4 + 7);
  assert.ok(open.slice(1, 8).every((r) => r.child && r.groupKey === key));
  // 新断线接进同一组：组 key 不变（取组里最早一次），展开状态保持
  const more = { ...stats, recentDrops: [{ serverId: "server-aliyun", at: at(23, 59), cause: "remote-closed", uptimeMs: M, recoveredAt: null }, ...stats.recentDrops] };
  const grown = buildDropRows(more, undefined, { expanded: new Set([key]) })[0];
  assert.equal(grown.key, key);
  assert.equal(grown.count, 8);
  assert.equal(grown.ongoing, true);
  assert.match(grown.recovery, /进行中$/);
});

// ---- 休眠归因（v2.62）：口径在后端 lib/tunnel-ledger-stats.mjs，这里只管怎么写 ----

const HOUR = 3_600_000;
// 北京时间 10.2 17:00 入睡，19:42 之后重新连上；清单里同一段休眠是一条（sleep: true）。
const sleepEntry = (serverId, extra = {}) => ({
  serverId, host: "example", at: NOW - 4 * HOUR, cause: "sleep", detail: "", uptimeMs: null, networkChange: false,
  recoveredAt: NOW - 4 * HOUR + 2 * HOUR + 42 * MIN + 40_000, downMs: 2 * HOUR + 42 * MIN + 40_000, attempts: 1, sleep: true, drops: 3, ...extra,
});

test("原因文案「本机休眠」；窗口里电脑休眠过，每行的悬停明细多一句、数字不变", () => {
  assert.equal(causeLabel("sleep"), "本机休眠");
  const stats = {
    sleep: { "24h": { ms: 2 * HOUR + 42 * MIN + 18_000, count: 1, lastWakeAt: NOW - HOUR }, "7d": { ms: 0, count: 0, lastWakeAt: null } },
    servers: {
      a: { serverId: "a", name: "主集群服务器 (example-cluster)", state: "up", since: NOW - HOUR, windows: { "24h": { drops: 0, availability: 1, downMs: 0, recoveries: 0, longestUpMs: 20 * HOUR, causes: {}, sleepDrops: 3, sleepDownMs: 2 * HOUR + 43 * MIN }, "7d": { drops: 0, availability: 1 } } },
    },
  };
  const [row] = buildStabilityRows(stats, "24h", NOW);
  assert.equal(row.summaryText, "0 次断线 · 100%");
  assert.equal(row.summaryTone, "ok");
  assert.equal(row.summaryTitle, "近 24 小时没有断线 · 最长连续在线 20 小时 · 本机休眠 2 小时 42 分（不计入断线与可用率）");
  assert.equal(buildStabilityRows(stats, "7d", NOW)[0].summaryTitle, "近 7 天没有断线", "这个窗口里没休眠过就不提");
  assert.equal(buildStabilityRows({ ...stats, sleep: undefined }, "24h", NOW)[0].summaryTitle, "近 24 小时没有断线 · 最长连续在线 20 小时", "旧接口没有 sleep 字段");
});

test("唤醒后还在重连（state = sleep）：中性的「唤醒后重连中」，不是标红的「断开中」", () => {
  const stats = { servers: { a: { serverId: "a", name: "主集群", state: "sleep", since: NOW - 30_000, windows: { "24h": { drops: 0, availability: 1 } } } } };
  const [row] = buildStabilityRows(stats, "24h", NOW);
  assert.deepEqual([row.stateText, row.stateTone], ["唤醒后重连中 · 30 秒", "neutral"]);
  assert.equal(buildStabilityRows({ servers: { a: { serverId: "a", state: "sleep" } } }, "24h", NOW)[0].stateText, "唤醒后重连中");
});

test("最近一次：不拿休眠当断线；断着的时候电脑睡了的那次写「持续多久后电脑休眠」", () => {
  const servers = { a: { serverId: "a", name: "主集群服务器 (example-cluster)" } };
  const drop = { serverId: "a", at: NOW - 30 * HOUR, cause: "closed", uptimeMs: 6_000_000, recoveredAt: NOW - 30 * HOUR + 100_000, downMs: 100_000 };
  assert.equal(lastDropText({ since: NOW - 40 * HOUR, servers, recentDrops: [sleepEntry("a"), drop] }), "10.1 15:00 主集群 · 连接被关闭 · 此前在线 1 小时 40 分 · 1 分 40 秒后恢复");
  assert.equal(lastDropText({ since: NOW - 40 * HOUR, servers, recentDrops: [sleepEntry("a")] }), "记录以来没有断线（自 10.1 05:00）");
  const cut = { ...drop, recoveredAt: drop.at + 30 * MIN, downMs: 30 * MIN, endedBy: "sleep" };
  assert.equal(lastDropText({ servers, recentDrops: [cut] }), "10.1 15:00 主集群 · 连接被关闭 · 此前在线 1 小时 40 分 · 持续 30 分后电脑休眠");
});

test("在线条：休眠段留下来画（斜纹）；近 7 天的日色块悬停带上当天休眠了多久", () => {
  const entry = { timeline: { start: NOW - DAY, end: NOW, segments: [
    { from: NOW - DAY, to: NOW - 4 * HOUR, state: "up" },
    { from: NOW - 4 * HOUR, to: NOW - HOUR, state: "sleep" },
    { from: NOW - HOUR, to: NOW, state: "up" },
  ] } };
  assert.deepEqual(buildStrip(entry, "24h").segments.map((x) => x.state), ["sleep"]);
  const daily = buildStrip({ daily: [
    { day: "2026-10-01", availability: 1, drops: 0, observedMs: 20 * HOUR, downMs: 0, sleepMs: 2 * HOUR + 42 * MIN + 18_000 },
    { day: "2026-10-02", availability: null, drops: 0, observedMs: 0, downMs: 0, sleepMs: 23 * HOUR },
    { day: "2026-10-03", availability: 1, drops: 0, observedMs: 20 * HOUR, downMs: 0, sleepMs: 30_000 },
  ] }, "7d");
  assert.deepEqual(daily.days.map((d) => [d.tone, d.title]), [
    ["ok", "10.1 · 断线 0 次 · 可用率 100% · 本机休眠 2 小时 42 分"],
    ["none", "10.2 没有记录 · 本机休眠 23 小时"],
    ["ok", "10.3 · 断线 0 次 · 可用率 100%"],
  ]);
});

test("清单里的休眠行：原因写「本机休眠」、不标红、说明不计入断线；按钮与「只列出」只数真正的断线", async () => {
  const { countDropRows } = await import("./tunnel-stability-model.js");
  const stats = {
    servers: { a: { serverId: "a", name: "主集群服务器 (example-cluster)" }, b: { serverId: "b", name: "云主机服务器 (example-cloud)" } },
    recentDrops: [
      { serverId: "b", at: NOW - HOUR, cause: "closed", uptimeMs: 1000, recoveredAt: NOW - HOUR + 20_000, downMs: 20_000 },
      sleepEntry("a"),
      sleepEntry("b", { recoveredAt: null, downMs: null, attempts: null, drops: 1 }),
    ],
  };
  const rows = buildDropRows(stats);
  assert.deepEqual(rows.map((r) => [r.name, r.cause, r.sleep, r.recovery, r.ongoing]), [
    ["云主机", "连接被关闭", false, "20 秒", false],
    ["主集群", "本机休眠", true, "2 小时 42 分", false],
    ["云主机", "本机休眠", true, "重连中", false],
  ]);
  assert.equal(rows[1].detail, "电脑休眠期间隧道不可用，不计入断线次数与可用率；期间断开 3 次");
  assert.equal(rows[2].detail, "电脑休眠期间隧道不可用，不计入断线次数与可用率");
  assert.equal(rows[1].time, "10.2 17:00", "从入睡那一刻算");
  assert.deepEqual(countDropRows(rows), { drops: 1, sleeps: 2 });

  // 同一条隧道连着两段休眠：照现有规则并成一组，组也带 sleep
  const twice = buildDropRows({ servers: stats.servers, recentDrops: [sleepEntry("a"), sleepEntry("a", { at: NOW - 30 * HOUR, recoveredAt: NOW - 29 * HOUR, downMs: HOUR })] });
  assert.deepEqual(twice.map((r) => [r.kind, r.cause, r.sleep, r.count, r.recovery]), [["group", "本机休眠", true, 2, "1 小时 – 2 小时 42 分"]]);
  assert.deepEqual(countDropRows(twice), { drops: 0, sleeps: 2 });
  // 组里最新那段还没连上：恢复用时如实带上「重连中」，整组仍不标红
  const waking = buildDropRows({ servers: stats.servers, recentDrops: [sleepEntry("a", { recoveredAt: null, downMs: null }), sleepEntry("a", { at: NOW - 30 * HOUR, recoveredAt: NOW - 29 * HOUR, downMs: HOUR })] })[0];
  assert.deepEqual([waking.recovery, waking.ongoing], ["1 小时 · 重连中", false]);
  assert.equal(buildDropRows({ servers: stats.servers, recentDrops: [sleepEntry("a", { recoveredAt: null, downMs: null }), sleepEntry("a", { at: NOW - 30 * HOUR, recoveredAt: null, downMs: null })] })[0].recovery, "重连中");
  assert.deepEqual(countDropRows(buildDropRows({ servers: stats.servers, recentDrops: [sleepEntry("a"), sleepEntry("a", { at: NOW - 30 * HOUR })] }, undefined, { expanded: new Set([twice[0].key]) })), { drops: 0, sleeps: 2 }, "展开后的逐条行不重复计数");
});
