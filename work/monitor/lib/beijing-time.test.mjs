import assert from "node:assert/strict";
import { test } from "node:test";

import { dayKeyOf as frontendDayKeyOf, TZ_OFFSET_SEC } from "../public/assets/js/render/usage-model.js";
import { BEIJING_OFFSET_MS, beijingDayEndMs, beijingDayKey, beijingDayStartMs, beijingDaysBetween, offsetDay } from "./beijing-time.mjs";
import { formatHistoryDate } from "./history-store.mjs";
import { inEveryTimeZone, TEST_TIME_ZONES } from "./test-timezones.mjs";
import { dayKeyOf, USAGE_TZ_OFFSET_SEC } from "./usage/time.mjs";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 北京时间的某个时刻（显式 UTC+8，与跑测试的机器时区无关）。
const bj = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);

test("偏移量只有一份：用量（秒级）、历史日文件与前端取的都是它", () => {
  assert.equal(BEIJING_OFFSET_MS, 8 * HOUR);
  assert.equal(USAGE_TZ_OFFSET_SEC * 1000, BEIJING_OFFSET_MS);
  assert.equal(TZ_OFFSET_SEC * 1000, BEIJING_OFFSET_MS, "前端 usage-model.js 的偏移量必须与后端一致");
  for (const ms of [bj(2026, 10, 1, 23, 59), bj(2026, 10, 2, 0, 0), bj(2026, 12, 31, 23, 59), bj(2027, 1, 1, 0, 0)]) {
    assert.equal(formatHistoryDate(ms), beijingDayKey(ms));
    assert.equal(dayKeyOf(ms / 1000), beijingDayKey(ms));
    assert.equal(frontendDayKeyOf(ms / 1000), beijingDayKey(ms));
  }
});

test("inEveryTimeZone: 逐个切到别的时区执行，结束后还原", async () => {
  const before = { env: process.env.TZ, offset: new Date(bj(2026, 10, 3, 12)).getTimezoneOffset() };
  const seen = [];
  await inEveryTimeZone((zone) => {
    seen.push([zone, new Date(bj(2026, 10, 3, 12)).getTimezoneOffset()]);
  });
  assert.deepEqual(seen.slice(1).map(([zone]) => zone), [...TEST_TIME_ZONES]);
  // 切换确实生效（否则下面那些「与机器时区无关」的用例什么都没测到）：UTC 偏移 0、加尔各答 -330、东京 -540。
  // 运行期改 TZ 在 Windows 上没有实机验证过：那里只验证「跑完能还原」，不拿没验证过的平台行为当断言。
  const offsets = Object.fromEntries(seen.slice(1));
  if (process.platform !== "win32") assert.deepEqual([offsets.UTC, offsets["Asia/Kolkata"], offsets["Asia/Tokyo"]], [0, -330, -540]);
  assert.deepEqual({ env: process.env.TZ, offset: new Date(bj(2026, 10, 3, 12)).getTimezoneOffset() }, before);
  await assert.rejects(() => inEveryTimeZone(() => { throw new Error("boom"); }), /boom/);
  assert.equal(process.env.TZ, before.env, "抛错也要还原");
});

test("日界按北京时间 0 点，与机器时区无关", async () => {
  await inEveryTimeZone((zone) => {
    assert.equal(beijingDayKey(Date.UTC(2026, 9, 1, 15, 59, 59, 999)), "2026-10-01", zone); // 北京 23:59:59.999
    assert.equal(beijingDayKey(Date.UTC(2026, 9, 1, 16, 0)), "2026-10-02", zone); // 北京 00:00
    assert.equal(new Date(beijingDayStartMs("2026-10-03")).toISOString(), "2026-10-02T16:00:00.000Z", zone);
    assert.equal(new Date(beijingDayEndMs("2026-10-03")).toISOString(), "2026-10-03T16:00:00.000Z", zone);
    assert.equal(beijingDayEndMs("2026-10-03"), beijingDayStartMs("2026-10-04"), zone);
    // 任意时刻都落在自己那一天的 [起点, 终点) 里——含别处夏令时切换的那些日子（北京时间没有夏令时）。
    for (const ms of [bj(2026, 3, 8, 2, 30), bj(2026, 4, 5, 3, 0), bj(2026, 9, 27, 2, 30), bj(2026, 11, 1, 1, 30), bj(2026, 2, 28, 23, 59)]) {
      const day = beijingDayKey(ms);
      assert.ok(beijingDayStartMs(day) <= ms && ms < beijingDayEndMs(day), `${zone} ${day}`);
      assert.equal(beijingDayEndMs(day) - beijingDayStartMs(day), DAY, `${zone} ${day}`);
    }
  });
});

test("offsetDay: 纯日历运算，跨月 / 跨年 / 闰日", async () => {
  await inEveryTimeZone((zone) => {
    assert.equal(offsetDay("2026-10-01", 1), "2026-10-02", zone);
    assert.equal(offsetDay("2026-03-01", -1), "2026-02-28", zone);
    assert.equal(offsetDay("2028-03-01", -1), "2028-02-29", zone);
    assert.equal(offsetDay("2026-12-31", 1), "2027-01-01", zone);
    assert.equal(offsetDay("2026-10-03", 0), "2026-10-03", zone);
  });
});

test("beijingDaysBetween: 两端所在的日期都算，逐日不重不漏", async () => {
  await inEveryTimeZone((zone) => {
    const now = bj(2026, 10, 3, 18, 30);
    const week = beijingDaysBetween(bj(2026, 9, 26, 18, 0), now);
    assert.deepEqual(week, ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"], zone);
    assert.deepEqual(beijingDaysBetween(now - HOUR, now), ["2026-10-03"], zone);
    // 两端贴着日界：23:59 与次日 00:00 是两天；00:00 到当天 23:59 是一天
    assert.deepEqual(beijingDaysBetween(bj(2026, 10, 2, 23, 59), bj(2026, 10, 3, 0, 0)), ["2026-10-02", "2026-10-03"], zone);
    assert.deepEqual(beijingDaysBetween(bj(2026, 10, 3, 0, 0), bj(2026, 10, 3, 23, 59)), ["2026-10-03"], zone);
    // 起点晚于终点：只给起点那一天，不倒着走
    assert.deepEqual(beijingDaysBetween(now, now - 3 * DAY), ["2026-10-03"], zone);
    // 过长的区间在上限处截断
    assert.equal(beijingDaysBetween(bj(2020, 1, 1), now).length, 400, zone);
    assert.deepEqual(beijingDaysBetween(bj(2020, 1, 1), now, 3), ["2020-01-01", "2020-01-02", "2020-01-03"], zone);
  });
});
