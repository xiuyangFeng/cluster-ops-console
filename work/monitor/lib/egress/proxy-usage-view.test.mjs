// 隧道使用记录的读取与汇总：纯函数 + 一次真实文件。窗口是相对现在的 24 小时，没有日界——在几个时区下结果相同。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serializeUsage, USAGE_HOUR_MS, USAGE_OTHER_KEY } from "../proxy/usage.mjs";
import { inEveryTimeZone } from "../test-timezones.mjs";
import {
  diffUsage,
  readProxyUsage,
  recentUsage,
  summarizeUsage,
  topByTraffic,
  topUnauthenticated,
  trackUsageVersion,
  USAGE_RECENT_STALE_MS,
  withRecentTraffic,
} from "./proxy-usage-view.mjs";

const HOUR = USAGE_HOUR_MS;
const NOW = 500 * HOUR + 20 * 60_000; // 某个整点过 20 分
const hour = (offset, targets) => ({ t: 500 * HOUR + offset * HOUR, targets: new Map(Object.entries(targets)) });
// [conn, up, down, lastAt, authed, missing, bad, denied]
const usage = (hours) => ({ pid: 1, startedAt: 1, writtenAt: NOW - 1000, auth: { mode: "observe", since: 1 }, hours });

test("summarizeUsage：合并最近 24 小时的小时桶；更早的与未来的不算", () => {
  const data = usage([
    hour(-30, { "old.example.com:443": [9, 9, 9, 1, 9, 9, 9, 9] }),
    hour(-24, { "api.openai.com:443": [1, 10, 100, NOW - 24 * HOUR, 1, 0, 0, 0] }), // 窗口最早的那个桶：整个算
    hour(-2, { "api.openai.com:443": [2, 20, 200, NOW - 2 * HOUR, 1, 1, 0, 0], "chatgpt.com:443": [1, 5, 50, NOW - 2 * HOUR + 5, 0, 1, 0, 0] }),
    hour(0, { "api.openai.com:443": [3, 30, 300, NOW - 60, 0, 2, 1, 3], [USAGE_OTHER_KEY]: [0, 0, 0, NOW - 30, 0, 4, 0, 4] }),
    hour(2, { "future.example.com:443": [9, 9, 9, 9, 9, 9, 9, 9] }),
  ]);
  const summary = summarizeUsage(data, { now: NOW });
  assert.equal(summary.since, 500 * HOUR - 24 * HOUR);
  assert.deepEqual(summary.totals, { connections: 7, up: 65, down: 650, authed: 2, missing: 8, bad: 1, denied: 7 });
  const openai = summary.targets.find((item) => item.target === "api.openai.com:443");
  assert.deepEqual(openai, { target: "api.openai.com:443", connections: 6, up: 60, down: 600, lastAt: NOW - 60, authed: 2, missing: 3, bad: 1, denied: 3 });
  assert.equal(summary.targets.some((item) => /old|future/.test(item.target)), false);
});

test("summarizeUsage：没有记录 / 读不出时是一份全零的空汇总", () => {
  for (const empty of [null, undefined, usage([])]) {
    assert.deepEqual(summarizeUsage(empty, { now: NOW }), { since: null, totals: { connections: 0, up: 0, down: 0, authed: 0, missing: 0, bad: 0, denied: 0 }, targets: [] });
  }
});

test("topUnauthenticated：没带对口令的目标按次数排前 5 个；「其它」不是具体目标，只进合计", () => {
  const targets = {};
  for (let i = 1; i <= 7; i += 1) targets[`t${i}.example.com:443`] = [1, 0, 0, NOW - i, 0, i, 0, 0];
  targets["clean.example.com:443"] = [5, 0, 0, NOW, 5, 0, 0, 0];
  targets[USAGE_OTHER_KEY] = [0, 0, 0, NOW, 0, 3, 2, 5];
  const top = topUnauthenticated(summarizeUsage(usage([hour(0, targets)]), { now: NOW }));
  assert.deepEqual(top.targets.map((item) => item.target), ["t7.example.com:443", "t6.example.com:443", "t5.example.com:443", "t4.example.com:443", "t3.example.com:443"]);
  assert.deepEqual(top.targets[0], { target: "t7.example.com:443", missing: 7, bad: 0, denied: 0, lastAt: NOW - 7 });
  assert.equal(top.moreTargets, 2, "还有 2 个具名目标没列出来");
  assert.equal(top.moreRequests, 1 + 2 + 3 + 2, "没列出来的请求：t1、t2 与「其它」里的");
  assert.deepEqual(topUnauthenticated(summarizeUsage(usage([hour(0, { "clean.example.com:443": [1, 0, 0, NOW, 1, 0, 0, 0] })]), { now: NOW })), { targets: [], moreTargets: 0, moreRequests: 0 });
});

test("topByTraffic：按上下行合计排；排不进前几名的与「其它」并成一行；只有被拒记录的目标不进流量表", () => {
  const targets = {
    "big.example.com:443": [2, 1000, 9000, NOW - 5, 2, 0, 0, 0],
    "mid.example.com:443": [9, 500, 500, NOW - 9, 9, 0, 0, 0],
    "small.example.com:443": [1, 1, 1, NOW - 50, 1, 0, 0, 0],
    "denied-only.example.com:443": [0, 0, 0, NOW - 1, 0, 3, 0, 3],
    [USAGE_OTHER_KEY]: [4, 10, 20, NOW - 2, 0, 0, 0, 0],
  };
  const summary = summarizeUsage(usage([hour(0, targets)]), { now: NOW });
  const top = topByTraffic(summary, 2);
  assert.deepEqual(top.targets, [
    { target: "big.example.com:443", connections: 2, up: 1000, down: 9000, lastAt: NOW - 5 },
    { target: "mid.example.com:443", connections: 9, up: 500, down: 500, lastAt: NOW - 9 },
  ]);
  assert.deepEqual(top.other, { targets: 1, connections: 5, up: 11, down: 21, lastAt: NOW - 2 }, "small 与「其它」并成一行，其中 1 个是具名目标");
  assert.equal(topByTraffic(summary).other.targets, 0);
  assert.equal(topByTraffic(summarizeUsage(usage([hour(0, { "a.example.com:443": [1, 1, 1, NOW, 0, 0, 0, 0] })]), { now: NOW })).other, null);
});

test("同一份记录在各个时区下汇总相同（小时桶按 UTC 整点切，窗口相对现在）", async () => {
  const data = usage([hour(-23, { "a.example.com:443": [1, 1, 1, NOW - 23 * HOUR, 0, 1, 0, 0] }), hour(0, { "a.example.com:443": [1, 1, 1, NOW, 1, 0, 0, 0] })]);
  const expected = JSON.stringify(summarizeUsage(data, { now: NOW }));
  const zones = [];
  await inEveryTimeZone((zone) => {
    zones.push(zone);
    assert.equal(JSON.stringify(summarizeUsage(data, { now: NOW })), expected, zone);
  });
  assert.ok(zones.length >= 6, "原时区 + 五个别的时区都跑到了");
});

test("readProxyUsage：真实文件读得出；没有文件、坏文件、大得不像我们写的 → null", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-usage-view-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "proxy-usage.json");
  assert.equal(readProxyUsage(file), null);
  assert.equal(readProxyUsage(null), null);
  writeFileSync(file, serializeUsage(usage([hour(0, { "a.example.com:443": [1, 2, 3, NOW, 1, 0, 0, 0] })])));
  assert.deepEqual([...readProxyUsage(file).hours[0].targets], [["a.example.com:443", [1, 2, 3, NOW, 1, 0, 0, 0]]]);
  writeFileSync(file, "{ nope");
  assert.equal(readProxyUsage(file), null);
  writeFileSync(file, `{"v":1,"hours":[],"pad":"${"x".repeat(300 * 1024)}"}`);
  assert.equal(readProxyUsage(file), null);
});

// 某一版记录：writtenAt 与小时桶。
const version = (writtenAt, hours) => ({ pid: 1, startedAt: 1, writtenAt, auth: { mode: "observe", since: 1 }, hours });

test("diffUsage：相邻两版逐桶逐目标相减，只计正增量；新目标、「其它」照算", () => {
  const before = version(NOW - 60_000, [hour(0, { "api.openai.com:443": [3, 300, 3000, NOW - 70_000, 3, 0, 0, 0], "chatgpt.com:443": [1, 10, 10, NOW - 80_000, 1, 0, 0, 0] })]);
  const after = version(NOW, [hour(0, {
    "api.openai.com:443": [5, 500, 9000, NOW - 5, 5, 0, 0, 0],
    "chatgpt.com:443": [1, 10, 10, NOW - 80_000, 1, 0, 0, 0], // 没变：不出现在增量里
    "github.com:443": [1, 7, 70, NOW - 9, 0, 1, 0, 0], // 新目标：整行算
    [USAGE_OTHER_KEY]: [2, 2, 2, NOW - 1, 0, 0, 0, 0],
  })]);
  const delta = diffUsage(before, after);
  assert.equal(delta.fromAt, NOW - 60_000);
  assert.equal(delta.toAt, NOW);
  assert.deepEqual([delta.connections, delta.up, delta.down], [2 + 1 + 2, 200 + 7 + 2, 6000 + 70 + 2]);
  assert.deepEqual([...delta.targets], [
    ["api.openai.com:443", { connections: 2, up: 200, down: 6000 }],
    ["github.com:443", { connections: 1, up: 7, down: 70 }],
    [USAGE_OTHER_KEY, { connections: 2, up: 2, down: 2 }],
  ]);
  // 空闲几分钟后的第一版：字节都落在这一版之前的一个写盘周期里，起点按 这一版 − 60 秒 算，速率不被空闲摊薄。
  const idle = diffUsage(version(NOW - 10 * 60_000, before.hours), after);
  assert.deepEqual([idle.fromAt, idle.toAt, idle.up], [NOW - 60_000, NOW, 209]);
  // 计数变小（代理读不进旧文件、从零记起）：只计正增量，不出负数。
  const shrunk = diffUsage(after, version(NOW + 60_000, [hour(0, { "api.openai.com:443": [1, 1, 1, NOW + 1, 1, 0, 0, 0] })]));
  assert.deepEqual([shrunk.connections, shrunk.up, shrunk.down, shrunk.targets.size], [0, 0, 0, 0]);
});

test("diffUsage：跨整点——新桶整桶算、滑出的旧桶不管（不能拿 24 小时合计相减）；文件回退 → null", () => {
  // 上一版在 0 点桶的最后一分钟写出；这一版已经到了下一个小时，最早的桶（-24）滑出了窗口与文件。
  const lastMinute = 500 * HOUR + HOUR - 30_000;
  const before = version(lastMinute, [
    hour(-24, { "old.example.com:443": [50, 5000, 50000, 1, 0, 0, 0, 0] }),
    hour(0, { "api.openai.com:443": [4, 40, 400, lastMinute - 10, 4, 0, 0, 0] }),
  ]);
  const after = version(lastMinute + 60_000, [
    hour(0, { "api.openai.com:443": [5, 50, 500, lastMinute + 1000, 5, 0, 0, 0] }),
    hour(1, { "api.openai.com:443": [1, 1000, 2000, lastMinute + 50_000, 1, 0, 0, 0] }),
  ]);
  const delta = diffUsage(before, after);
  assert.deepEqual([delta.connections, delta.up, delta.down], [1 + 1, 10 + 1000, 100 + 2000]);
  const naive = summarizeUsage(after, { now: after.writtenAt }).totals.down - summarizeUsage(before, { now: before.writtenAt }).totals.down;
  assert.ok(naive < 0, "合计相减会因为旧桶滑出变成负数——所以逐桶算");
  assert.equal(diffUsage(after, before), null, "文件回退");
  assert.equal(diffUsage(before, before), null, "同一版");
  assert.equal(diffUsage(null, after), null);
  assert.equal(diffUsage(version(0, []), after), null);
});

test("diffUsage：上一版写出之前就定型的桶再变多（文件超限压缩前后口径不同）不算新流量", () => {
  const before = version(NOW - 60_000, [
    hour(-3, { [USAGE_OTHER_KEY]: [9, 90, 900, 1, 0, 0, 0, 0] }),
    hour(0, { "a.example.com:443": [1, 1, 1, NOW - 70_000, 0, 0, 0, 0] }),
  ]);
  const after = version(NOW, [
    hour(-3, { "x.example.com:443": [9, 90, 900, 1, 0, 0, 0, 0] }), // 压缩口径换了：具名目标「冒出来」
    hour(0, { "a.example.com:443": [2, 2, 2, NOW - 1, 0, 0, 0, 0] }),
  ]);
  const delta = diffUsage(before, after);
  assert.deepEqual([...delta.targets.keys()], ["a.example.com:443"]);
  assert.deepEqual([delta.connections, delta.up, delta.down], [1, 1, 1]);
});

test("trackUsageVersion / recentUsage：只见过一版 → null；新版顶上来；文件回退重新看；超过 150 秒没重写 → null（空闲）", () => {
  const v1 = version(NOW - 60_000, [hour(0, { "a.example.com:443": [1, 10, 100, NOW - 60_000, 0, 0, 0, 0] })]);
  const v2 = version(NOW, [hour(0, { "a.example.com:443": [2, 30, 300, NOW, 0, 0, 0, 0] })]);
  let seen = trackUsageVersion({ previous: null, current: null }, v1);
  assert.deepEqual(seen, { previous: null, current: v1 });
  assert.equal(recentUsage(seen, { now: NOW }), null, "刚启动只见过一版");
  assert.equal(trackUsageVersion(seen, null), seen, "读不出来：不动");
  assert.equal(trackUsageVersion(seen, version(NOW - 60_000, [])), seen, "同一版：不动");
  seen = trackUsageVersion(seen, v2);
  assert.deepEqual(seen, { previous: v1, current: v2 });
  const recent = recentUsage(seen, { now: NOW + 20_000 });
  assert.deepEqual([recent.fromAt, recent.toAt, recent.connections, recent.up, recent.down], [NOW - 60_000, NOW, 1, 20, 200]);
  assert.equal(trackUsageVersion(seen, v2), seen, "轮询读到同一版：增量不变");
  assert.equal(recentUsage(seen, { now: NOW + USAGE_RECENT_STALE_MS }).up, 20);
  assert.equal(recentUsage(seen, { now: NOW + USAGE_RECENT_STALE_MS + 1 }), null, "超过 150 秒没重写 = 这段时间没变化");
  assert.deepEqual(trackUsageVersion(seen, v1), { previous: null, current: v1 }, "文件被换回旧版：从那一版重新看");
});

test("withRecentTraffic：流量表每行补上增量；「其它」取没单列出来的目标之和；没有增量时为 0", () => {
  const view = {
    targets: [{ target: "big.example.com:443", connections: 2, up: 1000, down: 9000, lastAt: NOW - 5 }, { target: "idle.example.com:443", connections: 9, up: 1, down: 1, lastAt: NOW - 9 }],
    other: { targets: 1, connections: 5, up: 11, down: 21, lastAt: NOW - 2 },
  };
  const recent = {
    targets: new Map([
      ["big.example.com:443", { connections: 1, up: 100, down: 900 }],
      ["small.example.com:443", { connections: 1, up: 1, down: 1 }],
      [USAGE_OTHER_KEY, { connections: 2, up: 3, down: 4 }],
    ]),
  };
  assert.deepEqual(withRecentTraffic(view, recent), {
    targets: [
      { target: "big.example.com:443", connections: 2, up: 1000, down: 9000, lastAt: NOW - 5, recentConnections: 1, recentUp: 100, recentDown: 900 },
      { target: "idle.example.com:443", connections: 9, up: 1, down: 1, lastAt: NOW - 9, recentConnections: 0, recentUp: 0, recentDown: 0 },
    ],
    other: { targets: 1, connections: 5, up: 11, down: 21, lastAt: NOW - 2, recentConnections: 3, recentUp: 4, recentDown: 5 },
  });
  const quiet = withRecentTraffic(view, null);
  assert.deepEqual(quiet.targets.map((item) => [item.recentConnections, item.recentUp, item.recentDown]), [[0, 0, 0], [0, 0, 0]]);
  assert.deepEqual([quiet.other.recentConnections, quiet.other.recentUp, quiet.other.recentDown], [0, 0, 0]);
  assert.equal(withRecentTraffic({ targets: [], other: null }, recent).other, null);
});
