// 用量星图总览：模型彗星行（只用真实数据、不补位）、标题、HTML（转义、筛选态、失败直达）。
import assert from "node:assert/strict";
import test from "node:test";

import { hitRateOf, observatoryHtml, observatoryModels, observatoryTitle } from "./usage-observatory.js";

const model = (name, agent, total, extra = {}) => ({ model: name, agent, total, calls: 10, errors: 0, fresh: total * 0.1, cacheRead: total * 0.9, output: 1000, costUsd: total / 1e6, ...extra });

const SUMMARY = {
  now: Math.floor(Date.parse("2026-10-22T01:32:00+08:00") / 1000),
  today: "2026-10-22",
  scope: { days: 1, start: "2026-10-22", end: "2026-10-22" },
  kpis: { total: 32.9e6, fresh: 1.35e6, inFresh: 1.31e6, cacheWrite: 36.6e3, cacheRead: 31.3e6, output: 167e3, hitRate: 0.959, costUsd: 24.23, savedUsd: 58.09, calls: 274, errors: 0, codes: {}, causes: {}, sessions: 4, recentSessions: 1, turnCount: 12, avgTurnSec: 210, freshVsAvg: { ratio: 0.29, days: 7, sameTime: true } },
  models: [model("gpt-6-astra", "codex", 21.8e6), model("gpt-6.1-sol", "codex", 10.1e6), model("gemini-4-argon", "antigravity", 877e3), model("claude-sonnet-5-5", "claude", 47.8e3)],
  sessions: [{ model: "gpt-6-astra", status: "recent" }, { model: "gpt-6.1-sol", status: "quiet" }],
};

test("hitRateOf: 缓存读取 / (缓存读取 + 未命中)；都没有为 null", () => {
  assert.equal(hitRateOf(90, 10), 0.9);
  assert.equal(hitRateOf(0, 0), null);
});

test("observatoryModels: 按后端顺序取前 5，其余合并；尾长相对最大值、占比相对总和；活跃按会话主模型", () => {
  const { rows, rest, grand } = observatoryModels(SUMMARY);
  assert.equal(rows.length, 4, "只有 4 个模型就画 4 条，不拿虚构模型补位");
  assert.equal(rest, null);
  assert.equal(rows[0].reach, 1);
  assert.equal(Number(rows[1].reach.toFixed(3)), 0.463);
  assert.equal(Number((rows[0].share).toFixed(3)), Number((21.8e6 / grand).toFixed(3)));
  assert.deepEqual(rows.map((r) => r.live), [true, false, false, false]);
  assert.equal(rows[0].hitRate, 0.9);

  const many = { ...SUMMARY, models: Array.from({ length: 7 }, (_, i) => model(`m${i}`, i % 2 ? "claude" : "mystery-agent", 1000 - i)) };
  const out = observatoryModels(many);
  assert.equal(out.rows.length, 5);
  assert.deepEqual([out.rest.count, out.rest.total, out.rest.names], [2, 995 + 994, ["m5", "m6"]]);
  assert.equal(out.rows[0].agent, "custom", "认不出的 Agent 归到自定义配色");

  assert.deepEqual(observatoryModels({ models: [model("idle", "codex", 0, { calls: 0 })] }).rows, [], "零用量零调用的不画");
  assert.deepEqual(observatoryModels(null).rows, []);
});

test("observatoryTitle: 今天 / 近 7 天 / 近 30 天 / 历史某天", () => {
  assert.deepEqual(observatoryTitle(SUMMARY, { date: null }), { title: "今日星图", caption: "10 月 22 日 · 截至 01:32" });
  assert.equal(observatoryTitle({ ...SUMMARY, scope: { days: 7, start: "2026-10-16", end: "2026-10-22" } }, {}).title, "七日星图");
  assert.equal(observatoryTitle({ ...SUMMARY, scope: { days: 30, start: "2026-09-23", end: "2026-10-22" } }, {}).title, "三十日星图");
  assert.deepEqual(observatoryTitle(SUMMARY, { date: "2026-10-20" }), { title: "10 月 20 日星图", caption: "全天" });
  assert.equal(observatoryTitle(null, {}).caption, "—");
});

test("observatoryHtml: 总量与四项读数、彗星行可点筛选（再点取消）、模型名转义", () => {
  const html = observatoryHtml(SUMMARY, { agent: "all", date: null });
  assert.match(html, /<h2 class="ob-title">今日星图<\/h2>/);
  assert.match(html, /<span class="ob-total-num">32\.9<\/span><span class="ob-total-unit">M<\/span>/);
  assert.match(html, /等效 <b>\$24\.23<\/b>/);
  assert.match(html, /<b>-71%<\/b> 较近 7 日同时段均值/);
  assert.match(html, /95\.9<small>%<\/small>/);
  assert.match(html, /全部成功/);
  assert.match(html, /1 个活跃 · 12 轮 · 每轮 3m30s/);
  assert.equal((html.match(/<button type="button" class="ob-comet/g) || []).length, 4);
  assert.match(html, /data-usage-pick-agent="codex" aria-pressed="false"/);
  assert.match(html, /class="ob-comet is-live"/);

  const filtered = observatoryHtml(SUMMARY, { agent: "codex", date: null });
  assert.match(filtered, /class="ob-comet is-live is-selected" data-agent="codex"/);
  assert.match(filtered, /再点一次取消筛选/);

  const evil = observatoryHtml({ ...SUMMARY, models: [model('<img src=x onerror="1">', "codex", 10)] }, { agent: "all" });
  assert.doesNotMatch(evil, /<img/);
  assert.match(evil, /&lt;img/);
});

test("observatoryHtml: 有失败时给直达按钮；没有调用时不造数；没数据时出同高占位", () => {
  const failed = observatoryHtml({ ...SUMMARY, kpis: { ...SUMMARY.kpis, errors: 20, codes: { error: 15, 502: 5 } } }, { agent: "all" });
  assert.match(failed, /data-usage-jump="errors"/);
  assert.match(failed, /失败 <b>20<\/b> · 502×5<\/button>/, "没有状态码的失败不再重复写成「失败×15」");
  const uncoded = observatoryHtml({ ...SUMMARY, kpis: { ...SUMMARY.kpis, errors: 2, codes: { error: 2 } } }, { agent: "all" });
  assert.match(uncoded, /失败 <b>2<\/b><\/button>/);

  const empty = observatoryHtml({ ...SUMMARY, models: [], kpis: { ...SUMMARY.kpis, total: 0, calls: 0 } }, { agent: "all" });
  assert.match(empty, /这个范围没有模型调用/);
  assert.match(empty, /暂无调用/);

  assert.match(observatoryHtml(null, null), /class="ob-hero is-empty" aria-busy="true"/);
});
