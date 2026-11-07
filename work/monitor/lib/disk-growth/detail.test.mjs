import assert from "node:assert/strict";
import { test } from "node:test";

import { daysToFullText } from "../brief/model.mjs";
import { createDiskDetailProvider, diskDetailText } from "./detail.mjs";

const GIB = 2 ** 30;
const summary = { label: "近 24 小时", total: { delta: 1160 * GIB, partial: false }, top: { name: "cfd_auto_ad_repro_20261009", delta: 1100 * GIB, lowerBound: false }, share: 0.57 };

test("那句话：增长与几天写满各自可缺，都没有就是空串；几天写满用简报的同一句", () => {
  assert.equal(
    diskDetailText({ summary, trend: { daysToFull: 4.4 } }),
    "近 24 小时你的作业目录增长约 1.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 +1.1 TiB；按这个速度约 4 天写满。",
  );
  assert.equal(diskDetailText({ summary: null, trend: { daysToFull: 4.4 } }), `${daysToFullText(4.4)}。`);
  assert.equal(diskDetailText({ summary, trend: null }), "近 24 小时你的作业目录增长约 1.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 +1.1 TiB。");
  assert.equal(diskDetailText({ summary, trend: { daysToFull: 400 } }).includes("写满"), false, "超过 90 天不提");
  assert.equal(diskDetailText({ summary: null, trend: { daysToFull: null } }), "");
  assert.equal(diskDetailText(), "");
  assert.equal(daysToFullText(0.2), "按这个速度约 1 天写满");
  assert.equal(daysToFullText(90), "按这个速度约 90 天写满");
  assert.equal(daysToFullText(90.1), "");
  assert.equal(daysToFullText(undefined), "");
});

test("取数：增长来自磁盘增长归因、趋势来自简报；任何一边缺席或出错都只是少半句", async () => {
  const asked = [];
  const diskGrowthService = { summaryFor: async (serverId) => { asked.push(["growth", serverId]); return summary; } };
  const briefService = { diskTrendFor: async (serverId) => { asked.push(["trend", serverId]); return { serverId, name: "主集群", usedPct: 91, deltaPct: 5, daysToFull: 3.6 }; } };
  const full = await createDiskDetailProvider({ diskGrowthService, briefService })("s1");
  assert.match(full.text, /^近 24 小时你的作业目录增长约 1\.1 TiB.*；按这个速度约 4 天写满。$/);
  assert.deepEqual(full.trend, { usedPct: 91, deltaPct: 5, daysToFull: 3.6 }, "只带数字，不带服务器名");
  assert.deepEqual(asked, [["growth", "s1"], ["trend", "s1"]]);

  const broken = { summaryFor: async () => { throw new Error("存储读不到"); } };
  assert.deepEqual(await createDiskDetailProvider({ diskGrowthService: broken, briefService })("s1"), { text: "按这个速度约 4 天写满。", trend: { usedPct: 91, deltaPct: 5, daysToFull: 3.6 } });
  const noTrend = { diskTrendFor: async () => null };
  assert.deepEqual(await createDiskDetailProvider({ diskGrowthService, briefService: noTrend })("s1"), { text: "近 24 小时你的作业目录增长约 1.1 TiB（占整盘同期增长的 57%），其中 cfd_auto_ad_repro_20261009 +1.1 TiB。", trend: null });
  const throwing = { diskTrendFor: () => { throw new Error("同步抛错"); } };
  assert.equal((await createDiskDetailProvider({ diskGrowthService: null, briefService: throwing })("s1")).text, "");
  assert.deepEqual(await createDiskDetailProvider()("s1"), { text: "", trend: null });
  assert.deepEqual(await createDiskDetailProvider({ briefService: {} })("s1"), { text: "", trend: null }, "旧的简报服务没有这个方法");
});
