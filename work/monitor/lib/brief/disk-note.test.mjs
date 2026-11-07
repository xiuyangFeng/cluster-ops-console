// 简报磁盘提示的「其中你的 <目录名> 近 24 小时 +Y」（v2.62 磁盘增长归因）与供磁盘事件详情取用的趋势。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { beijingDayStartMs as dayStartMs } from "../beijing-time.mjs";
import { buildBrief } from "./model.mjs";
import { createBriefService } from "./service.mjs";

const HOUR = 3600_000;
const GIB = 2 ** 30;
const DAY = "2026-10-12";
const START = dayStartMs(DAY);
const NOW = START + 9 * HOUR;

const input = (disks) => ({
  day: DAY, dayStart: START, dayEnd: START + 24 * HOUR, nowMs: NOW, isToday: true, ledgerSince: START - 48 * HOUR,
  tunnels: [], incidents: { opened: 0, resolved: 0, pending: [], quiet: 0 }, usage: null, jobs: null, disks, upgrades: [],
});
const growth = (over = {}) => ({
  label: "近 24 小时", total: { delta: 1160 * GIB, partial: false }, top: { name: "cfd_auto_ad_repro_20261009", delta: 1100 * GIB, lowerBound: false }, share: 0.57, ...over,
});
const disk = (over = {}) => ({ serverId: "s1", name: "主集群", usedPct: 91, deltaPct: 5, daysToFull: 4.2, ...over });
const noteText = (disks) => buildBrief(input(disks)).notes.find((n) => n.key === "disk:s1")?.text;

test("磁盘提示：作业目录增长占整盘同期增长三成以上时，在原句后面接上是哪个目录、涨了多少", () => {
  assert.equal(noteText([disk()]), "主集群磁盘 91%；比昨天多 5.0%；按这个速度约 4 天写满", "没有增长摘要：与原来逐字相同");
  assert.equal(
    noteText([disk({ growth: growth() })]),
    "主集群磁盘 91%；比昨天多 5.0%；按这个速度约 4 天写满；其中你的 cfd_auto_ad_repro_20261009 近 24 小时 +1.1 TiB",
  );
  assert.equal(noteText([disk({ growth: growth({ share: 0.29 }) })]), "主集群磁盘 91%；比昨天多 5.0%；按这个速度约 4 天写满", "不到三成：不提");
  assert.equal(noteText([disk({ growth: growth({ share: null }) })]), "主集群磁盘 91%；比昨天多 5.0%；按这个速度约 4 天写满", "没有整盘用量算不出占比：不提");
  assert.equal(
    noteText([disk({ daysToFull: null, growth: growth({ label: "近 30 小时", top: { name: "b1", delta: 200 * GIB, lowerBound: false } }) })]),
    "主集群磁盘 91%；比昨天多 5.0%；其中你的作业目录近 30 小时 +1.1 TiB",
    "最大的那个目录不到一半：说合计；间隔不是 24 小时照实写",
  );
  // 磁盘不到 90%：整条提示都没有，自然也不提作业目录
  assert.equal(noteText([disk({ usedPct: 89, growth: growth() })]), undefined);
  // 语气与排序不受影响：仍是持续性状态（at 为空）
  const note = buildBrief(input([disk({ usedPct: 96, growth: growth() })])).notes[0];
  assert.deepEqual([note.tone, note.at, note.link], ["critical", null, "servers"]);
});

test("服务：磁盘提示从磁盘增长归因取摘要；取不到 / 出错时提示照常；diskTrendFor 给出同一份趋势", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-disk-growth-"));
  try {
    const samples = [];
    for (let h = 72; h >= 0; h -= 1) samples.push({ type: "sample", key: "server-01", disk: 91 - h * (5 / 24), ts: NOW - h * HOUR });
    let reads = 0;
    const asked = [];
    const make = (diskGrowthService) => createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: [{ id: "server-01", name: "主集群服务器 (myserver)", host: "myserver" }, { id: "idle", name: "空闲", host: "h2" }] }),
      tunnelStability: { loadEvents: async () => [] },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      historyStore: { listDays: async () => [DAY], readDay: async () => { reads += 1; return samples; } },
      ...(diskGrowthService ? { diskGrowthService } : {}),
      now: () => NOW,
    });

    const service = make({ summaryFor: async (serverId) => { asked.push(serverId); return growth(); } });
    const brief = await service.get();
    assert.match(brief.notes.find((n) => n.key === "disk:server-01").text, /^主集群磁盘 91%；比昨天多 5\.0%；按这个速度约 \d+ 天写满；其中你的 cfd_auto_ad_repro_20261009 近 24 小时 \+1\.1 TiB$/);
    assert.deepEqual(asked, ["server-01"], "只问有磁盘趋势的服务器");

    const trend = await service.diskTrendFor("server-01");
    assert.deepEqual([trend.serverId, trend.name, Math.round(trend.usedPct), Math.round(trend.deltaPct)], ["server-01", "主集群", 91, 5]);
    assert.ok(trend.daysToFull > 1 && trend.daysToFull < 3, `约 ${trend.daysToFull} 天`);
    assert.equal(await service.diskTrendFor("idle"), null, "没有采样的服务器");
    assert.equal(await service.diskTrendFor("nope"), null);
    assert.equal(reads, 1, "趋势与简报共用 10 分钟缓存，不重读历史");

    const plain = "主集群磁盘 91%；比昨天多 5.0%；按这个速度约 2 天写满";
    for (const broken of [{ summaryFor: async () => { throw new Error("读不到"); } }, { summaryFor: () => { throw new Error("同步抛错"); } }, { summaryFor: async () => null }, null]) {
      assert.equal((await make(broken).get()).notes.find((n) => n.key === "disk:server-01").text, plain);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
