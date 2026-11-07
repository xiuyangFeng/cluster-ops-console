import assert from "node:assert/strict";
import { test } from "node:test";

import { dayKeyOf, offsetDay, secondsOfDay } from "./time.mjs";

test("归日与时刻按北京时间，与本机时区无关", () => {
  const utc = (y, mo, d, h, mi = 0) => Date.UTC(y, mo, d, h, mi) / 1000;
  assert.equal(dayKeyOf(utc(2026, 9, 1, 15, 59)), "2026-10-01"); // 北京 23:59
  assert.equal(dayKeyOf(utc(2026, 9, 1, 16, 0)), "2026-10-02"); // 北京 00:00
  assert.equal(secondsOfDay(utc(2026, 9, 2, 10, 41)), (18 * 60 + 41) * 60); // 北京 18:41
  assert.equal(offsetDay("2026-10-01", 1), "2026-10-02");
  assert.equal(offsetDay("2026-03-01", -1), "2026-02-28");
  assert.equal(offsetDay("2026-12-31", 1), "2027-01-01");
});
