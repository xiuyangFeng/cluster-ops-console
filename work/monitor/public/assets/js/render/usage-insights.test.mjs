import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUsageSummary } from "../../../../lib/usage/model.mjs";
import { bucketTableHtml, sparkHtml, usageInsightsHtml } from "./usage-insights.js";

test("成本面板：无洞察兼容；空桶不是零命中；维度、会话和时间标签按纯文本转义", () => {
  assert.equal(usageInsightsHtml(null), "");
  const summary = buildUsageSummary({ calls: [], sessions: [], turns: [], compacts: [] }, { nowSec: Date.UTC(2026, 9, 23, 4) / 1000, range: 7 });
  summary.models = [{ model: '<img src=x onerror="alert(1)">', costUsd: 1, total: 100 }];
  const html = usageInsightsHtml(summary);
  assert.ok(html.includes("前期覆盖不足"));
  assert.ok(html.includes("非账单金额"));
  assert.ok(html.includes("周环比"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(!html.includes("<img"));
  // 三项读数各一条迷你柱，外加分段明细表
  assert.equal((html.match(/class="us-spark"/g) || []).length, 3);
  assert.ok(html.includes('data-cost-details="cache"'));
  const buckets = [{ label: "<bad>", input: 0, cacheRead: 0 }, { label: "10.23", input: 100, cacheRead: 0, partial: true }];
  const spark = sparkHtml(buckets, { label: "命中", value: (b) => b.input > 0 ? b.cacheRead / b.input : null, format: (v) => `${(v * 100).toFixed(1)}%`, max: 1 });
  assert.equal((spark.match(/is-empty/g) || []).length, 1);
  assert.ok(spark.includes("&lt;bad&gt;：—"));
  assert.ok(spark.includes("10.23：0.0% · 进行中"));
  assert.ok(!spark.includes("<bad>"));
  const table = bucketTableHtml({ buckets }, new Set(["cache"]));
  assert.ok(table.includes("<details class=\"us-cache-data\" data-cost-details=\"cache\" open>"));
  assert.ok(table.includes("10.23（进行中）"));
});

test("成本面板：占比用条形表示，精确百分比在悬停说明里；不再列最贵会话", () => {
  const summary = buildUsageSummary({ calls: [], sessions: [], turns: [], compacts: [] }, { nowSec: Date.UTC(2026, 9, 23, 4) / 1000, range: 1 });
  summary.kpis.costUsd = 100;
  summary.byAgent = [{ agent: "claude", costUsd: 75, total: 1000 }, { agent: "codex", costUsd: 25, total: 500 }];
  summary.insights.topSessions = [{ key: "k1", serverId: "server-01", sid: "9b8c1c3d-5120-4571", agent: "claude", projectLabel: "GNN", stats: { costUsd: 60, total: 2000 } }];
  const html = usageInsightsHtml(summary, { agent: "claude" });
  assert.ok(html.includes('style="width:75.0%"'));
  assert.ok(html.includes("Claude · $75.00 · 75.0%"));
  assert.ok(html.includes('aria-pressed="true"'));
  assert.ok(!html.includes("data-cost-session"));
  assert.ok(!html.includes("9b8c1c3d"));
});
