import assert from "node:assert/strict";
import { test } from "node:test";

import { briefBodyHtml, briefCaption, briefErrorHtml, briefMissingHtml, isNewNote, previousDay, relativeDayTime } from "./brief-view.js";

const BJ = 8 * 3600_000;
const NOW = Date.UTC(2026, 9, 3, 8, 40) - BJ; // 北京时间 10.3 08:40

test("表头说明：今天带截至与上次查看；归档写全天", () => {
  const brief = { day: "2026-10-03", final: false, generatedAt: NOW };
  assert.equal(briefCaption(brief, { nowMs: NOW, lastViewedAt: Date.UTC(2026, 9, 2, 23, 10) - BJ }), "截至 08:40 · 上次查看 昨天 23:10");
  assert.equal(briefCaption(brief, { nowMs: NOW, lastViewedAt: null }), "截至 08:40");
  assert.equal(briefCaption({ day: "2026-10-01", final: true }, { nowMs: NOW }), "10 月 1 日全天 · 已归档");
  assert.equal(relativeDayTime(Date.UTC(2026, 8, 30, 9, 5) - BJ, NOW), "9 月 30 日 09:05");
  assert.equal(previousDay("2026-10-01"), "2026-09-30");
});

test("「新」只标上次查看之后发生的；持续性状态不标；归档不标", () => {
  const last = NOW - 3600_000;
  assert.equal(isNewNote({ at: NOW - 60_000 }, last), true);
  assert.equal(isNewNote({ at: NOW - 7200_000 }, last), false);
  assert.equal(isNewNote({ at: null }, last), false);
  assert.equal(isNewNote({ at: NOW }, null), false, "第一次打开不标");
  const brief = {
    final: false,
    headline: { tone: "critical", lead: "需要留意。", text: "<script>x</script>" },
    stats: [{ label: "隧道", value: "9", unit: " 次断线", sub: "可用率 97.1%", tone: "critical", view: "stability" }],
    notes: [{ key: "a", tone: "critical", at: NOW - 60_000, link: "stability", text: "阿里云断开中" }, { key: "b", tone: "warn", at: null, link: "servers", text: "磁盘 94%" }],
  };
  const html = briefBodyHtml(brief, { lastViewedAt: last });
  assert.equal((html.match(/bf-new/g) || []).length, 1);
  assert.match(html, /&lt;script&gt;/, "文案转义");
  assert.match(html, /data-brief-goto="stability"/);
  assert.equal((briefBodyHtml({ ...brief, final: true }, { lastViewedAt: last }).match(/bf-new/g) || []).length, 0);
  assert.match(briefBodyHtml({ ...brief, notes: [] }), /没有需要留意的事/);
});


test("指标格随模块增减：只出现后端给的格子，一格都没有时不留空卡（v2.47）", () => {
  const two = briefBodyHtml({ stats: [{ label: "隧道", value: "2" }, { label: "事件", value: "0" }], notes: [] });
  assert.equal((two.match(/class="bf-stat"/g) || []).length, 2);
  assert.doesNotMatch(briefBodyHtml({ stats: [], notes: [] }), /bf-stats/);
});

test("这一天没有简报：标题写日期；说明归档何时生成与保留天数（来自接口）；今天缺简报不给「回到今天」", () => {
  const html = briefMissingHtml({ day: "2026-09-20", today: "2026-10-03", retentionDays: 31 });
  assert.match(html, /data-tone="neutral"/);
  assert.match(html, /<p class="empty-state-title">9 月 20 日没有简报<\/p>/);
  assert.match(html, /每天的简报在第二天由运行中的工作台定稿归档；第二天工作台没有运行，这一天就不会有归档。归档保留最近 31 天。/);
  assert.match(html, /<button type="button" class="text-btn" data-brief-back="">回到今天<\/button>/);
  assert.doesNotMatch(html, /每 5 分钟/, "归档不是每 5 分钟生成的");
  assert.doesNotMatch(briefMissingHtml({ day: "2026-09-20", today: "2026-10-03" }), /归档保留/, "不知道保留天数就不写");
  const today = briefMissingHtml({ day: "2026-10-03", today: "2026-10-03" });
  assert.match(today, /今天没有简报/);
  assert.doesNotMatch(today, /回到今天/);
  assert.equal(briefBodyHtml(null, { day: "2026-09-20", today: "2026-10-03", retentionDays: 31 }), html);
  assert.match(briefErrorHtml("简报加载失败：<b>x</b>"), /简报加载失败：&lt;b&gt;x&lt;\/b&gt;；每分钟会自动重试。/);
});
