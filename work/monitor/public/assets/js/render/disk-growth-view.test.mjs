import assert from "node:assert/strict";
import { test } from "node:test";

import { inEveryTimeZone } from "../../../../lib/test-timezones.mjs";
import { buildDiskGrowthHtml, caveatTexts, deltaText, totalText } from "./disk-growth-view.js";

const GIB = 2 ** 30;
const HOUR = 3600_000;
const NOW = Date.UTC(2026, 9, 12, 6, 30); // 北京时间 10-12 14:30
const OUTPUTS = "Digital_twin/GNN/outputs";
const XP = "Digital_twin/GNN/training_wss_min/experiments";

const row = (name, bytes, delta, over = {}) => ({ root: OUTPUTS, name, bytes, partial: false, at: NOW - 10 * 60_000, delta, lowerBound: false, isNew: false, ...over });
const growth = (over = {}) => ({
  measuredAt: NOW - 10 * 60_000, complete: true, stop: null, trigger: "schedule", refAt: NOW - 24 * HOUR, spanMs: 24 * HOUR, label: "近 24 小时",
  roots: [
    { root: OUTPUTS, jobs: 812, state: "ok", error: null, at: NOW - 12 * 60_000, children: 103, bytes: 2380 * GIB, delta: 1080 * GIB, partial: false },
    { root: XP, jobs: 301, state: "ok", error: null, at: NOW - 10 * 60_000, children: 179, bytes: 150 * GIB, delta: 80 * GIB, partial: false },
  ],
  rows: [
    row("cfd_auto_ad_repro_20261009", 1700 * GIB, 1100 * GIB),
    row("xp_wss_min_base", 130 * GIB, 80 * GIB, { root: XP }),
    row("cfd_auto_ad_repro_20261008", 400 * GIB, 0),
    row("old_batch", 280 * GIB, -20 * GIB),
  ],
  rowCount: 4,
  total: { bytes: 2530 * GIB, delta: 1160 * GIB, partial: false },
  share: 0.566,
  attempt: { at: NOW - 10 * 60_000, outcome: "ok", error: null },
  ...over,
});
const data = (over = {}) => ({ eligible: true, serverId: "s1", running: false, run: null, growth: growth(), ...over });

test("量完且有上一次可比：合计、占整盘的比例、按增长排好的行、量的时刻、从哪些目录找来的", () => {
  const html = buildDiskGrowthHtml(data(), { now: NOW });
  assert.match(html, /<span class="du-root">作业产出目录<\/span>/);
  assert.match(html, /量于 14:20（10 分钟前）/);
  assert.match(html, /data-dg-scan>现在量一次</);
  assert.match(html, /<p class="du-coverage" data-complete="true">近 24 小时合计 \+1\.1 TiB，占整盘同期增长的 57%。<\/p>/);
  assert.match(html, /目录（按近 24 小时增长）<\/span><span class="du-num">实际占用<\/span><span class="du-num">近 24 小时<\/span><span class="du-num du-wide">量于</);
  // 行：集合目录的末段 / 子目录名，悬停是完整路径；大小、增长、时刻
  assert.match(html, /title="~\/Digital_twin\/GNN\/outputs\/cfd_auto_ad_repro_20261009">outputs\/cfd_auto_ad_repro_20261009<\/span><span class="du-num">1\.7 TiB<\/span><span class="du-num dg-delta" data-sign="up">\+1\.1 TiB<\/span><span class="du-num du-wide">14:20</);
  assert.match(html, />experiments\/xp_wss_min_base</);
  assert.match(html, /data-sign="flat">0</);
  assert.match(html, /data-sign="flat">−20 GiB</);
  assert.ok(html.indexOf("cfd_auto_ad_repro_20261009") < html.indexOf("xp_wss_min_base"), "顺序照后端给的");
  assert.match(html, /按登记的作业输出路径找到 ~\/Digital_twin\/GNN\/outputs（812 个作业）、~\/Digital_twin\/GNN\/training_wss_min\/experiments（301 个作业）。每 6 小时自动量一次/);
  assert.ok(!html.includes('data-level="warn"'), "量全了就没有黄字");
  assert.ok(!html.includes("只列前"));
});

test("整块不显示：没有数据、不是团队集群、模块关着、没有集合目录", () => {
  assert.equal(buildDiskGrowthHtml(null), "");
  assert.equal(buildDiskGrowthHtml({ eligible: false, serverId: "me" }), "");
  assert.equal(buildDiskGrowthHtml({ eligible: true, serverId: "s1", disabled: true }), "");
  assert.equal(buildDiskGrowthHtml({ eligible: true, serverId: "s1", running: false, run: null, growth: null }), "");
  assert.equal(buildDiskGrowthHtml({ eligible: true, serverId: "s1", running: true, run: { rounds: 0 }, growth: null }), "", "还没推出集合目录时不闪一下");
});

test("正在量：给进度、按钮不可点；自己发起中的那一下也不可点；报错行如实显示", () => {
  const html = buildDiskGrowthHtml(data({ running: true, run: { trigger: "schedule", startedAt: NOW - 20_000, rounds: 6, rootIndex: 1, rootCount: 2 } }), { now: NOW });
  assert.match(html, /<span class="du-busy">正在量 · 第 7 轮，第 2 \/ 2 个目录<\/span>/);
  assert.match(html, /data-dg-scan disabled>/);
  assert.match(buildDiskGrowthHtml(data({ running: true, run: { rounds: 0, rootIndex: 0, rootCount: 1 } }), { now: NOW }), /正在量 · 第 1 轮</);
  assert.match(buildDiskGrowthHtml(data(), { busy: true, now: NOW }), /data-dg-scan disabled>/);
  assert.match(buildDiskGrowthHtml(data(), { error: "这台服务器正在扫描目录占用，等它结束再量", now: NOW }), /<p class="du-note" data-level="warn">这台服务器正在扫描目录占用，等它结束再量<\/p>/);
});

test("没量全的都说出来：到时限、中途失败、没轮到、远端拒绝、子目录太多；没量完的行标出来", () => {
  const partial = growth({
    complete: false,
    stop: "deadline",
    roots: [
      { root: OUTPUTS, jobs: 812, state: "partial", error: null, at: NOW, children: 60, bytes: 900 * GIB, delta: 300 * GIB, partial: true },
      { root: XP, jobs: 301, state: "skipped", error: null, at: NOW, children: 0, bytes: null, delta: null, partial: false },
      { root: "old/runs", jobs: 9, state: "error", error: "路径不在 $HOME 内或包含符号链接，未扫描", at: NOW, children: 0, bytes: null, delta: null, partial: false },
    ],
    rows: [row("b1", 600 * GIB, 300 * GIB), row("b2", 300 * GIB, null, { partial: true })],
    rowCount: 2,
    total: { bytes: 900 * GIB, delta: 300 * GIB, partial: true },
    share: null,
  });
  const html = buildDiskGrowthHtml(data({ growth: partial }), { now: NOW });
  assert.match(html, /<p class="du-coverage" data-complete="false">近 24 小时两次都量完的目录合计 \+300 GiB。<\/p>/);
  assert.match(html, /这次到 10 分钟上限先停了，没量完的目录标了「未量完」；~\/Digital_twin\/GNN\/training_wss_min\/experiments 这次没轮到；~\/old\/runs 没有量：路径不在 \$HOME 内或包含符号链接，未扫描。/);
  // 说明性的小字在增长那一格（目录名那格会被省略号截断）
  assert.match(html, />outputs\/b2<\/span><span class="du-num">300 GiB<\/span><span class="du-num dg-delta" data-sign="flat"><span class="dg-tag" title="这个目录只量了一部分，左边的实际占用偏小，不参与增长">未量完<\/span><\/span>/);

  assert.deepEqual(caveatTexts(growth({ stop: "error", complete: false, attempt: { at: NOW, outcome: "partial", error: "SSH 没有成功 (ssh exit 255)" } }), NOW), ["这次中途停了：SSH 没有成功 (ssh exit 255)；已经量到的照实记着，没量完的标了「未量完」"]);
  const cut = growth({ complete: false, roots: [{ ...growth().roots[0], state: "partial" }] });
  assert.deepEqual(caveatTexts(cut, NOW), ["~/Digital_twin/GNN/outputs 有子目录没量全（子目录太多、超出扫描器一次能排的数量，或量到一半目录变了）"]);
  assert.deepEqual(caveatTexts(growth(), NOW), []);
  // 很久以前量的（之后一直没再量成）：照样显示，但说明这些数字和增长都是当时的
  const old = growth({ measuredAt: NOW - 3 * 24 * HOUR });
  assert.deepEqual(caveatTexts(old, NOW), ["这是 3 天前量的，之后没有再量成，增长一栏也是当时的"]);
  assert.deepEqual(caveatTexts(growth({ measuredAt: NOW - 11 * HOUR }), NOW), [], "两个定时周期以内不算旧");
  assert.match(buildDiskGrowthHtml(data({ growth: old }), { now: NOW }), /量于 10-09 14:30（3 天前）[\s\S]*data-level="warn">这是 3 天前量的，之后没有再量成，增长一栏也是当时的。</);
});

test("只量过一次 / 一次都没量成：不编增长，说明现状；新出现与下限照实标", () => {
  const first = growth({ refAt: null, spanMs: null, label: "", rows: [row("b1", 400 * GIB, null), row("b2", 150 * GIB, null)], total: { bytes: 617 * GIB, delta: null, partial: false }, share: null });
  const html = buildDiskGrowthHtml(data({ growth: first }), { now: NOW });
  assert.match(html, /合计 617 GiB。增长要和至少 3 小时前的一次测量比，现在还没有。/);
  assert.match(html, /目录（按实际占用）<\/span><span class="du-num">实际占用<\/span><span class="du-num">增长</);
  assert.equal(totalText(first), "合计 617 GiB。增长要和至少 3 小时前的一次测量比，现在还没有。");
  // 有上一次，但两次没有一个目录都量完
  assert.equal(totalText(growth({ total: { bytes: 617 * GIB, delta: null, partial: true }, share: null })), "合计 617 GiB。这次与上一次没有都量完的目录可比，算不出增长。");

  const never = growth({ measuredAt: null, complete: false, rows: [], rowCount: 0, refAt: null, label: "", total: { bytes: 0, delta: null, partial: false }, share: null, attempt: { at: NOW, outcome: "error", error: "服务器上没有 python3，量不了" } });
  const blank = buildDiskGrowthHtml(data({ growth: never }), { now: NOW });
  assert.match(blank, /还没有量成：服务器上没有 python3，量不了。/);
  assert.ok(!blank.includes("du-table") && !blank.includes("du-coverage") && !blank.includes("量于"), "没有数字就不画表");
  assert.match(blank, /data-dg-scan>现在量一次</, "可以再试一次");

  const marks = buildDiskGrowthHtml(data({ growth: growth({ rows: [row("fresh", 300 * GIB, 300 * GIB, { isNew: true }), row("riser", 304 * GIB, 300 * GIB, { lowerBound: true })], rowCount: 12 }) }), { now: NOW });
  assert.match(marks, />outputs\/fresh<\/span><span class="du-num">300 GiB<\/span><span class="du-num dg-delta" data-sign="up"><span title="上一次量的时候还没有这个目录"><span class="dg-tag">新出现<\/span> \+300 GiB<\/span>/);
  assert.match(marks, /<span title="上一次它不在最大的 40 个里，没有单独的数字：增长按下限算"><span class="dg-tag">至少<\/span> \+300 GiB<\/span>/);
  assert.match(marks, /只列前 2 个，另有 10 个子目录单独记了数。按登记的作业输出路径找到/);

  assert.equal(totalText(growth({ total: { bytes: 5, delta: -60 * GIB, partial: false }, share: null })), "近 24 小时合计 −60 GiB。");
  assert.equal(totalText(growth({ share: 1.4 })), "近 24 小时合计 +1.1 TiB，超过整盘同期的净增长。");
  assert.equal(totalText(growth({ share: 0.004 })), "近 24 小时合计 +1.1 TiB，占整盘同期增长不到 1%。");
  assert.equal(totalText(growth({ label: "近 6 小时", share: null })), "近 6 小时合计 +1.1 TiB。");
  assert.deepEqual([deltaText(0), deltaText(null), deltaText(1536), deltaText(-1024)], ["0", "—", "+1.5 KiB", "−1 KiB"]);
});

test("目录名一律转义（中文、空格、引号、尖括号）", () => {
  // 目录名里什么字符都可能有，唯独没有斜杠
  const root = "数据 集/<b>out<i>";
  const nasty = growth({
    roots: [{ ...growth().roots[0], root }],
    rows: [row('it\'s "q" <img src=x onerror=1>', 5 * GIB, GIB, { root })],
    rowCount: 1,
  });
  const html = buildDiskGrowthHtml(data({ growth: nasty }), { error: "<script>x</script>", now: NOW });
  assert.ok(!html.includes("<img") && !html.includes("<b>out") && !html.includes("<script>"));
  assert.match(html, /title="~\/数据 集\/&lt;b&gt;out&lt;i&gt;\/it&#039;s &quot;q&quot; &lt;img src=x onerror=1&gt;">&lt;b&gt;out&lt;i&gt;\/it&#039;s &quot;q&quot; &lt;img src=x onerror=1&gt;<\/span>/);
  assert.match(html, /找到 ~\/数据 集\/&lt;b&gt;out&lt;i&gt;（812 个作业）/);
});

test("量的时刻按北京时间，与机器时区无关；不是今天的带上日期", async () => {
  await inEveryTimeZone((zone) => {
    assert.match(buildDiskGrowthHtml(data(), { now: NOW }), /量于 14:20（10 分钟前）/, zone);
    // 北京时间凌晨 00:05 量的，现在是 00:30：在 UTC / 美洲时区还是前一天，照样算「今天」
    const midnight = Date.UTC(2026, 9, 12, 16, 30);
    const early = growth({ measuredAt: midnight - 25 * 60_000, rows: [row("b1", GIB, 5, { at: midnight - 25 * 60_000 })] });
    assert.match(buildDiskGrowthHtml(data({ growth: early }), { now: midnight }), /量于 00:05（25 分钟前）/, zone);
    // 昨天 23:50 量的
    const late = growth({ measuredAt: midnight - 40 * 60_000, rows: [row("b1", GIB, 5, { at: midnight - 40 * 60_000 })] });
    const html = buildDiskGrowthHtml(data({ growth: late }), { now: midnight });
    assert.match(html, /量于 10-12 23:50（40 分钟前）/, zone);
    assert.match(html, /<span class="du-num du-wide">10-12 23:50<\/span>/, zone);
  });
});
