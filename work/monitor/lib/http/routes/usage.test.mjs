import assert from "node:assert/strict";
import { test } from "node:test";

import { createUsageRoutes, parseSummaryParams } from "./usage.mjs";

test("摘要参数：非法值回落到默认", () => {
  const p = (q) => parseSummaryParams(new URLSearchParams(q));
  assert.deepEqual(p("range=7&agent=codex&project=~/a&date=2026-10-01"), { range: 7, date: "2026-10-01", agent: "codex", project: "~/a" });
  assert.deepEqual(p("range=30&agent=antigravity"), { range: 30, date: null, agent: "antigravity", project: "all" });
  assert.deepEqual(p("range=5&agent=unknown&date=yesterday"), { range: 1, date: null, agent: "all", project: "all" });
});

function fakeRes() {
  return { statusCode: 0, body: "", writeHead(code) { this.statusCode = code; }, setHeader() {}, end(body) { this.body = body; } };
}

test("路由：会话详情找不到给 404，无服务给 503", async () => {
  const route = createUsageRoutes({ usageService: { summary: async () => ({ ok: 1 }), sessionDetail: async () => null } });
  const res = fakeRes();
  assert.equal(await route({ req: { method: "GET" }, res, url: new URL("http://x/api/usage/session?key=a") }), true);
  assert.equal(res.statusCode, 404);
  const ok = fakeRes();
  await route({ req: { method: "GET" }, res: ok, url: new URL("http://x/api/usage/summary?range=30") });
  assert.equal(ok.statusCode, 200);
  const none = fakeRes();
  await createUsageRoutes({ usageService: null })({ req: { method: "GET" }, res: none, url: new URL("http://x/api/usage/summary") });
  assert.equal(none.statusCode, 503);
});


test("摘要模型筛选：保留模型原值，超长输入回退默认", () => {
  assert.equal(parseSummaryParams(new URLSearchParams({ model: "gpt-6.1-sol" })).model, "gpt-6.1-sol");
  assert.equal(parseSummaryParams(new URLSearchParams({ model: "x".repeat(81) })).model, undefined);
});
