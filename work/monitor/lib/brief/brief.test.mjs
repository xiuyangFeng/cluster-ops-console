import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { beijingDayStartMs as dayStartMs } from "../beijing-time.mjs";
import { recordedLedger, replaySleepScene, sceneConfig, sceneTime, SCENE_DAY } from "../supervisor/sleep-scene-fixture.mjs";
import { buildBrief, noteCategoryOf, rankNotes, rankNotesWithOverflow, tokensText } from "./model.mjs";
import { createBriefService, diskTrend, parseDoctorUpgrade, shortName } from "./service.mjs";
import { BRIEF_RETENTION_DAYS, createBriefStore } from "./store.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = "2026-10-03";
const START = dayStartMs(DAY); // 北京时间 10.3 00:00
const NOW = START + 8 * HOUR + 40 * MIN; // 08:40

function baseInput(overrides = {}) {
  return {
    day: DAY, dayStart: START, dayEnd: START + 24 * HOUR, nowMs: NOW, isToday: true,
    ledgerSince: START - 2 * HOUR,
    tunnels: [
      { serverId: "s1", name: "主集群", state: "up", since: START, window: { drops: 0, upMs: 8 * HOUR, downMs: 0, maxRecoveryMs: null, causes: {} }, drops: [] },
    ],
    incidents: { opened: 0, resolved: 0, pending: [], quiet: 1 },
    usage: { total: 124_000_000, calls: 900, errors: 3, freshRatio: 1.18 },
    jobs: { state: "ok", jobs: [
      { id: "1", name: "a", state: "COMPLETED", exitCode: 0, endAt: START + HOUR },
      { id: "2", name: "b", state: "COMPLETED", exitCode: 0, endAt: START + 2 * HOUR },
      { id: "3", name: "old", state: "FAILED", exitCode: 1, endAt: START - HOUR },
      { id: "4", name: "q", state: "PENDING", submitAt: NOW - 3 * HOUR },
    ] },
    disks: [],
    upgrades: [],
    ...overrides,
  };
}

test("北京时间日界：dayStartMs = 当天 0 点（UTC+8）", () => {
  assert.equal(new Date(START).toISOString(), "2026-10-02T16:00:00.000Z");
});

test("平稳的一天：结论、四格指标、作业只算当天结束的", () => {
  const brief = buildBrief(baseInput());
  assert.equal(brief.headline.tone, "ok");
  assert.equal(brief.headline.lead, "整体平稳。");
  assert.match(brief.headline.text, /隧道今天没有断线；没有新的事件；你的 2 个作业已完成。/);
  const [tunnel, events, usage, jobs] = brief.stats;
  assert.deepEqual([tunnel.value, tunnel.tone], ["0", "ok"]);
  assert.equal(events.sub, "0 条已恢复 · 待处理 0 · 1 条已确认");
  assert.deepEqual([usage.value, usage.unit], ["1.24", " 亿 Token"]);
  assert.match(usage.sub, /未命中输入较近 7 日 \+18%/);
  assert.deepEqual([jobs.value, jobs.unit], ["2", " 完成"]);
  assert.match(jobs.sub, /0 失败 · 1 个排队中（最久 3 小时）/);
  assert.equal(brief.final, false);
});

test("有异常：断开中 / 长时间断开 / 作业失败排进值得留意，结论改为需要留意", () => {
  const brief = buildBrief(baseInput({
    tunnels: [{
      serverId: "s2", name: "阿里云", state: "down", since: NOW - 3 * MIN, lastDropAt: NOW - 3 * MIN,
      window: { drops: 4, upMs: 7 * HOUR, downMs: 45 * MIN, maxRecoveryMs: 42 * MIN, causes: { "keepalive-timeout": 3, closed: 1 } },
      drops: [{ at: START + 2 * HOUR + 10 * MIN, cause: "closed", recoveredAt: START + 2 * HOUR + 52 * MIN }],
    }],
    jobs: { state: "ok", jobs: [{ id: "48213", name: "train_lora", state: "FAILED", exitCode: 137, endAt: START + 3 * HOUR, nodes: "node02" }] },
  }));
  assert.equal(brief.headline.tone, "critical");
  assert.equal(brief.headline.lead, "需要留意。");
  assert.equal(brief.notes.length, 3);
  assert.ok(brief.notes.every((n) => n.tone === "critical"));
  assert.equal(brief.notes[0].text, "阿里云断开中 · 已 3 分", "同级按时间新 → 旧");
  assert.ok(brief.notes.some((n) => n.text === "阿里云 02:10–02:52 断开 42 分（连接被关闭）"));
  assert.ok(brief.notes.some((n) => /作业 #48213 train_lora 失败：退出码 137，疑似内存不足（node02）/.test(n.text)));
  assert.deepEqual([brief.stats[3].value, brief.stats[3].unit, brief.stats[3].tone], ["1", " 失败", "critical"]);
});

// 回归（2026-10-03 实测）：今天结束 741 完成 / 3 失败 / 20 取消，旧实现只拿到最新 300 条，
// 简报显示「282 完成 · 0 失败」——失败的 3 个被截掉了。合计必须按完整作业表算。
test("作业量大的一天：完成 / 失败 / 取消按完整作业表计数，失败显示在大字上并进值得留意", () => {
  const jobs = [];
  for (let i = 0; i < 741; i += 1) jobs.push({ id: String(17000 + i), name: `cfa-agiter20-${i}`, state: "COMPLETED", exitCode: 0, endAt: START + MIN + i * 600 });
  for (let i = 0; i < 20; i += 1) jobs.push({ id: String(16000 + i), name: `cfa-agiter18-${i}`, state: "CANCELLED", exitCode: 0, endAt: START + 10 * MIN + i * 1000 });
  jobs.push({ id: "16921", name: "cfa-agiter19-a3f9c1-cfd1", state: "FAILED", exitCode: 1, endAt: START + 30 * MIN, nodes: "node05" });
  jobs.push({ id: "16655", name: "gen_meshrules_census", state: "TIMEOUT", exitCode: 0, endAt: START + 2 * HOUR, nodes: "node06" });
  jobs.push({ id: "16710", name: "train_lora", state: "OUT_OF_MEMORY", exitCode: 0, endAt: START + 5 * HOUR, nodes: "master" });
  for (let i = 0; i < 19; i += 1) jobs.push({ id: String(18000 + i), name: `cfa-agiter21-${i}`, state: "RUNNING", exitCode: 0, endAt: null });
  // 昨天结束的不算今天的。
  for (let i = 0; i < 350; i += 1) jobs.push({ id: String(15000 + i), name: `cfa-agiter19-${i}`, state: "COMPLETED", exitCode: 0, endAt: START - HOUR - i * 1000 });
  jobs.push({ id: "14999", name: "old_fail", state: "FAILED", exitCode: 1, endAt: START - 2 * HOUR });

  const brief = buildBrief(baseInput({ jobs: { state: "ok", jobs, truncated: false } }));
  const stat = brief.stats[3];
  assert.deepEqual([stat.value, stat.unit, stat.tone], ["3", " 失败", "critical"]);
  assert.equal(stat.sub, "741 完成 · 20 取消 · 19 运行中");
  // v2.49：多个失败合成一条、按原因归组（还没诊断的按 sacct 状态 / 退出码兜底），链接到「我的历史」。
  const jobNotes = brief.notes.filter((n) => n.key.startsWith("job:"));
  assert.deepEqual(jobNotes.map((n) => [n.key, n.at, n.link]), [["job:failed", START + 5 * HOUR, "cluster-history"]]);
  assert.equal(jobNotes[0].text, "今天 3 个作业失败：1 个内存不足，1 个超时，1 个原因待查");
  assert.equal(brief.headline.tone, "critical");
});

test("v2.49 失败作业按诊断原因归组：同因合并、Python 报错按原文（数字 / 路径归一化）分组", () => {
  const fail = (id, hour, diagnosis, extra = {}) => ({ id, name: `cfa-${id}`, state: "FAILED", exitCode: 1, endAt: START + hour * HOUR, diagnosis, ...extra });
  const key = { category: "python", headline: "KeyError: 'arm'" };
  const jobs = [
    ...Array.from({ length: 10 }, (_, i) => fail(String(100 + i), 1 + i * 0.1, key)),
    fail("200", 2, { category: "timeout", headline: "超出时限（已运行 12 小时）" }, { state: "TIMEOUT" }),
    fail("201", 2.5, null, { state: "TIMEOUT" }),
  ];
  const note = buildBrief(baseInput({ jobs: { state: "ok", jobs } })).notes.find((n) => n.key === "job:failed");
  assert.equal(note.text, "今天 12 个作业失败：10 个 KeyError: 'arm'，2 个超时");
  assert.equal(note.link, "cluster-history");
  assert.equal(note.at, START + 2.5 * HOUR);

  // 同一个报错、只是路径与数字不同 → 一组；只有一组时说「都是」；超过 3 种原因收成「其余」。
  const same = [
    fail("1", 1, { category: "python", headline: "FileNotFoundError: …/trial_1/case_7.json" }),
    fail("2", 2, { category: "python", headline: "FileNotFoundError: …/trial_2/case_12.json" }),
  ];
  assert.equal(buildBrief(baseInput({ jobs: { state: "ok", jobs: same } })).notes.find((n) => n.key === "job:failed").text, "今天 2 个作业失败，都是 FileNotFoundError: …/trial_2/case_12.json");
  const many = ["oom", "nan", "gpu-oom", "node", "no-log"].map((category, i) => fail(String(i), i + 1, { category, headline: "x" }));
  assert.equal(buildBrief(baseInput({ jobs: { state: "ok", jobs: many } })).notes.find((n) => n.key === "job:failed").text, "今天 5 个作业失败：1 个日志已不可得，1 个节点故障，1 个显存不足，其余 2 个");

  // 单个失败仍点名，原因用诊断（太长截短）。
  const long = { category: "python", headline: `ValueError: ${"x".repeat(80)}` };
  const single = buildBrief(baseInput({ jobs: { state: "ok", jobs: [fail("9", 1, long, { nodes: "node05" })] } })).notes.find((n) => n.key === "job:9");
  assert.match(single.text, /^作业 #9 cfa-9 失败：ValueError: x+…（node05）$/);
  assert.equal(single.link, "cluster-history");
});

test("作业没拿全（超过采集上限）：数字标成下限并说明，不把少算的数字当成完整的", () => {
  const jobs = Array.from({ length: 5 }, (_, i) => ({ id: String(i), name: "x", state: "COMPLETED", exitCode: 0, endAt: START + HOUR + i }));
  const stat = buildBrief(baseInput({ jobs: { state: "ok", jobs, truncated: true } })).stats[3];
  assert.deepEqual([stat.value, stat.unit], ["5+", " 完成"]);
  assert.equal(stat.sub, "作业太多，只统计了最新 5 个 · 未见失败");
  const brief = buildBrief(baseInput({ jobs: { state: "ok", jobs, truncated: true } }));
  assert.match(brief.headline.text, /你的 5\+ 个作业已完成/);

  const failed = buildBrief(baseInput({ jobs: { state: "ok", truncated: true, jobs: [...jobs, { id: "9", name: "y", state: "FAILED", exitCode: 1, endAt: START + 2 * HOUR }] } })).stats[3];
  assert.deepEqual([failed.value, failed.unit], ["1+", " 失败"]);
  assert.equal(failed.sub, "作业太多，只统计了最新 6 个 · 5+ 完成");
});

test("数据积累中：账本晚于当天起点开始记录", () => {
  const brief = buildBrief(baseInput({ ledgerSince: START + 2 * HOUR + 21 * MIN }));
  assert.equal(brief.warming, true);
  assert.equal(brief.headline.lead, "数据积累中。");
  assert.match(brief.headline.text, /断线账本从 10 月 3 日 02:21 开始记录，已覆盖今天 6 小时 19 分/);
});

test("今天的隧道按近 24 小时滚动：标签、结论、积累判断都跟窗口走；跨到昨天的断开写明「昨天」", () => {
  const range = [NOW - 24 * HOUR, NOW];
  const calm = buildBrief(baseInput({ tunnelRange: range, ledgerSince: NOW - 30 * HOUR }));
  assert.equal(calm.stats[0].label, "隧道 · 近 24 小时");
  assert.equal(calm.warming, false);
  assert.match(calm.headline.text, /隧道近 24 小时没有断线；/);

  const drops = buildBrief(baseInput({
    tunnelRange: range,
    ledgerSince: NOW - 30 * HOUR,
    tunnels: [{
      serverId: "s2", name: "阿里云", state: "up", since: NOW - HOUR,
      window: { drops: 2, upMs: 23 * HOUR, downMs: 30 * MIN, maxRecoveryMs: 25 * MIN, causes: { "remote-closed": 2 } },
      drops: [{ at: START - 2 * HOUR, cause: "remote-closed", recoveredAt: START - 2 * HOUR + 25 * MIN }],
    }],
  }));
  assert.ok(drops.notes.some((n) => n.text === "阿里云 昨天 22:00–22:25 断开 25 分（服务器端断开）"));

  // 账本只覆盖了 24 小时窗口的一部分（即使已经覆盖了今天 0 点起的全部）：仍算积累中
  const warming = buildBrief(baseInput({ tunnelRange: range, ledgerSince: START - 2 * HOUR }));
  assert.equal(warming.warming, true);
  assert.match(warming.headline.text, /已覆盖近 24 小时中的 10 小时 40 分；满 24 小时后隧道可用率才完整。/);

  // 定稿的过去某天不传窗口：按自然日，标签不变
  assert.equal(buildBrief(baseInput({ isToday: false })).stats[0].label, "隧道");
});

test("作业：没采集 / 没记账 / 失败时都降级为「—」并说明", () => {
  assert.equal(buildBrief(baseInput({ jobs: { state: "none" } })).stats[3].sub, "尚未采集到作业记录");
  assert.equal(buildBrief(baseInput({ jobs: { state: "absent", jobs: [] } })).stats[3].sub, "集群没有作业记账（sacct）");
  assert.equal(buildBrief(baseInput({ jobs: null })).stats[3].value, "—");
});

test("v2.47 模块关闭：用量 / 我的作业整格不出现（连同留意项与结论片段），不是显示「—」", () => {
  const failing = { state: "ok", jobs: [{ id: "9", name: "boom", state: "FAILED", exitCode: 1, endAt: START + HOUR }] };
  const noisyUsage = { total: 1000, calls: 100, errors: 40, freshRatio: null };
  const on = buildBrief(baseInput({ jobs: failing, usage: noisyUsage }));
  assert.deepEqual(on.stats.map((s) => s.key), ["tunnel", "events", "usage", "jobs"]);
  assert.ok(on.notes.some((n) => n.key === "job:9") && on.notes.some((n) => n.key === "usage-errors"));

  const usageOff = buildBrief(baseInput({ jobs: failing, usage: noisyUsage, modules: { usage: false, jobs: true } }));
  assert.deepEqual(usageOff.stats.map((s) => s.key), ["tunnel", "events", "jobs"]);
  assert.equal(usageOff.notes.some((n) => n.key === "usage-errors"), false);

  const jobsOff = buildBrief(baseInput({ jobs: failing, usage: noisyUsage, modules: { usage: true, jobs: false } }));
  assert.deepEqual(jobsOff.stats.map((s) => s.key), ["tunnel", "events", "usage"]);
  assert.equal(jobsOff.notes.some((n) => n.key.startsWith("job:")), false);

  const bothOff = buildBrief(baseInput({ modules: { usage: false, jobs: false } }));
  assert.deepEqual(bothOff.stats.map((s) => s.key), ["tunnel", "events"]);
  assert.equal(bothOff.headline.lead, "整体平稳。");
  assert.doesNotMatch(bothOff.headline.text, /作业/, "结论不再提作业");
});

test("持续性状态（磁盘 / 可升级）at 为空，排在有时间的同级之后", () => {
  const brief = buildBrief(baseInput({
    disks: [{ serverId: "s1", name: "主集群", usedPct: 94, deltaPct: 0.4, daysToFull: 18 }],
    upgrades: [{ agent: "Codex", latest: "0.160.0", current: "0.159.2" }],
  }));
  assert.deepEqual(brief.notes.map((n) => n.text), ["主集群磁盘 94%；比昨天多 0.4%；按这个速度约 18 天写满", "Codex 0.160.0 可升级（当前 0.159.2）"]);
  assert.ok(brief.notes.every((n) => n.at === null));
  assert.equal(brief.headline.lead, "整体平稳。", "只有持续性的留意项不改结论");
  assert.equal(brief.headline.tone, "warn");
});

test("rankNotes 去重、按严重度与时间排序并截断，且同类别刷屏时保底让出槽位给异类重要告警", () => {
  const ranked = rankNotes([
    { key: "a", tone: "info", at: 5 }, { key: "b", tone: "warn", at: 1 }, { key: "c", tone: "critical", at: 2 },
    { key: "d", tone: "critical", at: 9 }, { key: "d", tone: "critical", at: 9 },
  ]);
  assert.deepEqual(ranked.map((n) => n.key), ["d", "c", "b"]);
  assert.deepEqual(tokensText(86_000_000), { value: "8600", unit: " 万 Token" });

  // 3 条隧道 critical + 1 条作业失败 critical（时间略早）→ 保底保留作业失败，不被 3 条隧道独占
  const diverse = rankNotesWithOverflow([
    { key: "tunnel-outage:s1:30", tone: "critical", at: 30 },
    { key: "tunnel-outage:s1:20", tone: "critical", at: 20 },
    { key: "tunnel-outage:s1:10", tone: "critical", at: 10 },
    { key: "job:failed", tone: "critical", at: 5 },
    { key: "upgrade:Codex:1.0", tone: "info", at: null },
  ]);
  assert.equal(noteCategoryOf("tunnel-outage:s1:30"), "tunnel");
  assert.equal(noteCategoryOf("job:failed"), "job");
  assert.deepEqual(diverse.notes.map((n) => n.key), ["tunnel-outage:s1:30", "tunnel-outage:s1:20", "job:failed"]);
  assert.equal(diverse.hiddenCount, 2);
});

test("辅助：doctor 可升级解析、磁盘趋势、短名", () => {
  assert.deepEqual(parseDoctorUpgrade("   [up] updates      0.160.0 available (current 0.159.2)\n"), { agent: "Codex", latest: "0.160.0", current: "0.159.2" });
  assert.equal(parseDoctorUpgrade("all good"), null);
  const now = 1_000_000_000_000;
  const samples = [];
  for (let h = 72; h >= 0; h -= 1) samples.push({ ts: now - h * HOUR, disk: 92 + (72 - h) * (0.5 / 24) });
  const trend = diskTrend(samples, now);
  assert.ok(Math.abs(trend.deltaPct - 0.5) < 0.05);
  assert.ok(trend.daysToFull > 10 && trend.daysToFull < 13);
  assert.equal(diskTrend([{ ts: now - 2 * HOUR, disk: 90 }], now), null, "采样过旧不出趋势");
  assert.equal(shortName({ name: "阿里云服务器 (vpn-aliyun)" }), "阿里云");
  assert.equal(shortName({ name: "主集群服务器 (myserver)" }), "主集群");
});

test("归档：只保留最近 31 天，超限与过期都清理；坏文件读回 null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "briefs-"));
  try {
    const store = createBriefStore({ dir });
    const today = "2026-10-03";
    // 40 天前到昨天，每天一份
    for (let i = 40; i >= 1; i -= 1) {
      const d = new Date(Date.UTC(2026, 9, 3 - i)).toISOString().slice(0, 10);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify({ day: d }));
    }
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
    await store.write({ day: "2026-10-02", headline: {} }, { today });
    const days = await store.listDays();
    assert.equal(days.length, BRIEF_RETENTION_DAYS - 1, "今天不落盘：保留期内最多 30 份过去的日子");
    assert.equal(days[0], "2026-10-02");
    assert.equal(days.at(-1), "2026-09-03");
    assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "只删简报快照");
    fs.writeFileSync(path.join(dir, "2026-10-01.json"), "{broken");
    assert.equal(await store.read("2026-10-01"), null);
    assert.equal(await store.read("../etc/passwd"), null);
    assert.equal(await store.write({ day: "2026-10-01", junk: "x".repeat(40_000) }, { today }), false, "超大快照拒绝落盘");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("服务：今天实时生成并缓存；昨天缺快照时现算定稿；更早无快照返回 null", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-svc-"));
  try {
    let clock = NOW;
    let computeCount = 0;
    const service = createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: [{ id: "server-01", name: "主集群服务器 (myserver)", host: "myserver" }] }),
      tunnelStability: { loadEvents: async () => { computeCount += 1; return [{ type: "start", at: START - 26 * HOUR }, { type: "up", serverId: "server-01", at: START - 26 * HOUR }]; } },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      now: () => clock,
    });
    const today = await service.get();
    assert.equal(today.day, DAY);
    assert.equal(today.stats[0].label, "隧道 · 近 24 小时", "今天的隧道格按近 24 小时滚动");
    assert.equal(today.warming, false, "账本早于 24 小时窗口起点");
    await service.get();
    assert.equal(computeCount, 1, "60 秒内复用缓存");
    clock += 61_000;
    await service.get();
    assert.equal(computeCount, 2);

    const yesterday = await service.get("2026-10-02");
    assert.equal(yesterday.final, true);
    assert.equal(yesterday.stats[0].label, "隧道", "定稿的过去某天按自然日");
    assert.ok(fs.existsSync(path.join(dir, "briefs", "2026-10-02.json")), "昨天定稿落盘");
    assert.equal(await service.get("2026-09-01"), null);
    assert.equal(await service.get("2026-10-04"), null, "未来日期");
    const { days, retentionDays } = await service.listDays();
    assert.deepEqual(days, [DAY, "2026-10-02"]);
    assert.equal(retentionDays, 31);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("服务：作业快照按服务器合并；任一台没拿全 → 简报数字标成下限", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-jobs-"));
  try {
    const snaps = {
      "server-01": { state: "ok", truncated: false, jobs: [{ id: "1", name: "a", state: "COMPLETED", exitCode: 0, endAt: START + HOUR }] },
      "server-02": { state: "ok", truncated: true, jobs: [{ id: "2", name: "b", state: "COMPLETED", exitCode: 0, endAt: START + 2 * HOUR }] },
    };
    const make = (ids) => createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: ids.map((id) => ({ id, name: id, host: id })) }),
      tunnelStability: { loadEvents: async () => [] },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      jobsService: { getSnapshot: (id) => snaps[id] || null },
      now: () => NOW,
    });
    const both = (await make(["server-01", "server-02"]).get()).stats[3];
    assert.deepEqual([both.value, both.unit], ["2+", " 完成"]);
    assert.match(both.sub, /^作业太多，只统计了最新 2 个/);
    const one = (await make(["server-01"]).get()).stats[3];
    assert.deepEqual([one.value, one.sub], ["1", "0 失败"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("服务：失败作业按服务器挂上诊断摘要，值得留意按原因归组", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-diag-"));
  try {
    const fail = (id) => ({ id, name: "t", state: "FAILED", exitCode: 1, endAt: START + HOUR });
    const snaps = { "server-01": { state: "ok", jobs: [fail("1"), fail("2")] }, "server-02": { state: "ok", jobs: [fail("1")] } };
    const asked = [];
    const service = createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: ["server-01", "server-02"].map((id) => ({ id, name: id, host: id })) }),
      tunnelStability: { loadEvents: async () => [] },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      jobsService: {
        getSnapshot: (id) => snaps[id] || null,
        diagnosisOf: (serverId, jobId) => {
          asked.push(`${serverId}/${jobId}`);
          return serverId === "server-01" ? { category: "python", headline: "KeyError: 'arm'" } : null;
        },
      },
      now: () => NOW,
    });
    const note = (await service.get()).notes.find((n) => n.key === "job:failed");
    assert.equal(note.text, "今天 3 个作业失败：2 个 KeyError: 'arm'，1 个原因待查");
    assert.deepEqual(asked.sort(), ["server-01/1", "server-01/2", "server-02/1"], "同一作业号在不同服务器各查各的");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("服务：磁盘趋势读最近的历史文件（listDays 新 → 旧），高位时进值得留意", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-disk-"));
  try {
    const clock = NOW;
    const files = {};
    for (let d = 0; d < 10; d += 1) files[`2026-09-${String(20 + d).padStart(2, "0")}`] = [];
    // 只有最新的几天有样本：读错（取最旧的）就拿不到
    const recent = [];
    for (let h = 72; h >= 0; h -= 1) recent.push({ type: "sample", key: "server-01", disk: 93 + (72 - h) * (0.4 / 24), ts: clock - h * HOUR });
    files["2026-10-03"] = recent;
    const service = createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: [{ id: "server-01", name: "主集群服务器 (myserver)", host: "myserver" }] }),
      tunnelStability: { loadEvents: async () => [] },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      historyStore: { listDays: async () => Object.keys(files).sort().reverse(), readDay: async (d) => files[d] || [] },
      now: () => clock,
    });
    const brief = await service.get();
    const disk = brief.notes.find((n) => n.key === "disk:server-01");
    assert.ok(disk, "高位磁盘进值得留意");
    assert.match(disk.text, /^主集群磁盘 94%；比昨天多 0\.4%；按这个速度约 \d+ 天写满$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("组合原因码逐段翻译", async () => {
  const { reasonText } = await import("./model.mjs");
  assert.equal(reasonText("TUNNEL_DOWN+REMOTE_PORT_CLOSED"), "隧道断开、远端端口未开放");
  assert.equal(reasonText("DEGRADED"), "降级");
  assert.equal(reasonText("WHATEVER"), "WHATEVER");
});

test("服务：模块关闭时不取用量 / 作业数据，对应格子不出现；开关一变缓存即失效", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-modules-"));
  try {
    let modules = { usage: true, jobs: true };
    let usageCalls = 0;
    let jobsCalls = 0;
    const service = createBriefService({
      runtimeDir: dir,
      getMergedConfig: () => ({ servers: [{ id: "server-01", name: "主集群", host: "myserver" }], modules }),
      tunnelStability: { loadEvents: async () => [] },
      incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
      usageService: { summary: async () => { usageCalls += 1; return { kpis: { total: 10, calls: 1, errors: 0 } }; } },
      jobsService: { getSnapshot: () => { jobsCalls += 1; return { state: "ok", jobs: [] }; } },
      now: () => NOW,
    });
    assert.deepEqual((await service.get()).stats.map((s) => s.key), ["tunnel", "events", "usage", "jobs"]);
    modules = { usage: false, jobs: false };
    const before = { usageCalls, jobsCalls };
    const off = await service.get();
    assert.deepEqual(off.stats.map((s) => s.key), ["tunnel", "events"], "开关变化不等 60 秒缓存过期");
    assert.deepEqual({ usageCalls, jobsCalls }, before, "关闭的模块不取数");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 休眠归因（v2.62）----

test("电脑休眠：只多一条中性的说明，不出断线提示、不标红；结论与隧道那一格照旧", () => {
  const sleep = { ms: 2 * HOUR + 42 * MIN + 18_611, count: 1, lastWakeAt: START + 7 * HOUR };
  const brief = buildBrief(baseInput({ sleep }));
  assert.deepEqual(brief.notes, [{ key: `sleep:${sleep.lastWakeAt}`, tone: "neutral", at: sleep.lastWakeAt, link: "stability", text: "电脑休眠 2 小时 42 分，期间隧道不可用" }]);
  assert.deepEqual([brief.headline.tone, brief.headline.lead], ["ok", "整体平稳。"]);
  assert.match(brief.headline.text, /^隧道今天没有断线；/);
  assert.deepEqual([brief.stats[0].value, brief.stats[0].unit, brief.stats[0].tone, brief.stats[0].sub], ["0", " 次断线", "ok", "可用率 100%"]);

  // 一天睡了几回：合成一条，写明次数
  assert.equal(buildBrief(baseInput({ sleep: { ms: 3 * HOUR + 22 * MIN, count: 2, lastWakeAt: NOW - HOUR } })).notes[0].text, "电脑休眠 2 次共 3 小时 22 分，期间隧道不可用");
  // 不足 10 分钟不提；没有休眠 / 旧数据没有这一项也不提
  for (const none of [{ ms: 10 * MIN - 1, count: 1, lastWakeAt: NOW }, { ms: 0, count: 0, lastWakeAt: null }, null, undefined]) {
    assert.deepEqual(buildBrief(baseInput({ sleep: none })).notes, []);
  }
  assert.equal(buildBrief(baseInput({ sleep: { ms: 10 * MIN, count: 1, lastWakeAt: NOW } })).notes.length, 1);
});

test("电脑休眠的说明排在最后：有三条更要紧的就不出；醒来后还在重连（state=sleep）不当成断开中", () => {
  const sleep = { ms: 3 * HOUR, count: 1, lastWakeAt: NOW - MIN };
  const busy = buildBrief(baseInput({
    sleep,
    disks: [{ serverId: "s1", name: "主集群", usedPct: 94, deltaPct: 0.4, daysToFull: 18 }],
    upgrades: [{ agent: "Codex", latest: "0.160.0", current: "0.159.2" }],
    jobs: { state: "ok", jobs: [{ id: "9", name: "boom", state: "FAILED", exitCode: 1, endAt: START + HOUR }] },
  }));
  assert.deepEqual(busy.notes.map((n) => n.tone), ["critical", "warn", "info"]);
  const two = buildBrief(baseInput({ sleep, upgrades: [{ agent: "Codex", latest: "0.160.0", current: "0.159.2" }] }));
  assert.deepEqual(two.notes.map((n) => n.tone), ["info", "neutral"], "比「可升级」这类提示还靠后");

  const waking = buildBrief(baseInput({
    sleep,
    tunnels: [{ serverId: "s1", name: "主集群", state: "sleep", since: NOW - 30_000, window: { drops: 0, upMs: 5 * HOUR, downMs: 0, maxRecoveryMs: null, causes: {}, sleepDrops: 2 }, drops: [] }],
  }));
  assert.deepEqual(waking.notes.map((n) => n.key), [`sleep:${sleep.lastWakeAt}`]);
  assert.deepEqual([waking.headline.tone, waking.stats[0].tone, waking.stats[0].value], ["ok", "ok", "0"]);
});

// 2026-10-11 现场（lib/supervisor/sleep-scene-fixture.mjs）：合盖 19:03:39 – 21:45:50。
function sceneBriefService(t, events, clock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brief-sleep-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createBriefService({
    runtimeDir: dir,
    getMergedConfig: sceneConfig,
    tunnelStability: { loadEvents: async () => events },
    incidentStore: { query: () => ({ incidents: [], nextCursor: null }) },
    now: clock,
  });
}

// 夹具只截了当晚；账本本身早就在记了（否则简报会停在「数据积累中」）。
const LEDGER_BEGAN = { v: 1, type: "alive", at: sceneTime("00:00:00") - 30 * HOUR };

test("现场 · 现在的 supervisor 记下的账本：一条中性的「电脑休眠 2 小时 42 分」，不是三条断线", async (t) => {
  const { rows } = await replaySleepScene();
  let clock = sceneTime("23:00:00");
  const service = sceneBriefService(t, [LEDGER_BEGAN, ...rows], () => clock);
  const today = await service.get();
  assert.equal(today.day, SCENE_DAY);
  assert.deepEqual(today.notes, [{ key: `sleep:${sceneTime("21:45:57.611")}`, tone: "neutral", at: sceneTime("21:45:57.611"), link: "stability", text: "电脑休眠 2 小时 42 分，期间隧道不可用" }]);
  assert.deepEqual(today.headline, { tone: "ok", lead: "整体平稳。", text: "隧道近 24 小时没有断线；没有新的事件。" });
  assert.deepEqual(
    { label: today.stats[0].label, value: today.stats[0].value, unit: today.stats[0].unit, sub: today.stats[0].sub, tone: today.stats[0].tone },
    { label: "隧道 · 近 24 小时", value: "0", unit: " 次断线", sub: "可用率 100%", tone: "ok" },
  );

  // 第二天定稿这一天（按自然日）：还是这一条
  clock = sceneTime("23:00:00") + 10 * HOUR;
  const final = await service.get(SCENE_DAY);
  assert.equal(final.final, true);
  assert.deepEqual(final.notes.map((n) => [n.tone, n.text]), [["neutral", "电脑休眠 2 小时 42 分，期间隧道不可用"]]);
  assert.deepEqual(final.headline, { tone: "ok", lead: "整体平稳。", text: "隧道全天没有断线；没有新的事件。" });
  assert.deepEqual([final.stats[0].label, final.stats[0].value, final.stats[0].sub, final.stats[0].tone], ["隧道", "0", "可用率 100%", "ok"]);
});

test("现场 · 旧版记下的同一晚（没有 sleep / wake）：简报照旧是三条标红的断线——旧账本的口径没有被改写", async (t) => {
  const service = sceneBriefService(t, [LEDGER_BEGAN, ...recordedLedger()], () => sceneTime("23:00:00"));
  const brief = await service.get();
  assert.deepEqual(brief.notes.map((n) => [n.tone, n.text]), [
    ["critical", "云主机 21:03–21:46 断开 43 分（连接被关闭）"],
    ["critical", "主集群 20:46–21:36 断开 50 分（服务器端断开）"],
    ["critical", "云主机 20:46–21:03 断开 17 分（连接被关闭）"],
  ]);
  assert.deepEqual([brief.headline.tone, brief.headline.lead], ["critical", "需要留意。"]);
  assert.equal(brief.headline.text, "云主机 21:03–21:46 断开 43 分（连接被关闭）；主集群 20:46–21:36 断开 50 分（服务器端断开）。");
  assert.deepEqual([brief.stats[0].value, brief.stats[0].tone], ["7", "critical"]);
});
