// usage-view.js 的空状态判定（纯函数）：页面级说明与会话表空态各说什么、给哪些动作。
import assert from "node:assert/strict";
import test from "node:test";

import { emptyStateHtml } from "../empty-state.js";
import { USAGE_DISABLED_STATE, usagePageEmptyState, usageSessionEmptyState } from "./usage-view.js";

const ready = (extra = {}) => ({ sources: [{ id: "s1", name: "主集群" }], coverageStart: "2026-09-01", sessions: [], ...extra });
const base = { range: 1, date: null, agent: "all", project: "all", projectLabel: "" };

test("usagePageEmptyState：没有团队服务器 / 首次扫描中 / 一直取不到（带服务器名与原因 +「重试」）/ 有数据时不出", () => {
  const none = usagePageEmptyState({ sources: [] });
  assert.equal(none.tone, "neutral");
  assert.equal(none.icon, "server");
  assert.equal(none.title, "没有可统计用量的团队服务器");
  assert.match(none.body, /个人服务器不统计/);
  assert.equal(usagePageEmptyState(null).title, "没有可统计用量的团队服务器");

  const scanning = usagePageEmptyState({ sources: [{ id: "s1", name: "主集群" }], coverageStart: null });
  assert.equal(scanning.tone, "wait");
  assert.equal(scanning.title, "正在首次扫描会话日志");
  assert.match(scanning.body, /按文件偏移增量读取，服务器上不落任何文件/);

  const failing = usagePageEmptyState({ sources: [{ id: "s1", name: "主集群", lastError: "<b>ssh 超时</b>" }], coverageStart: null });
  assert.equal(failing.tone, "error");
  assert.equal(failing.title, "暂时取不到用量数据");
  assert.equal(failing.body, "主集群：<b>ssh 超时</b>。会话日志每分钟同步一次，下一轮会再试。");
  assert.match(emptyStateHtml(failing), /&lt;b&gt;ssh 超时&lt;\/b&gt;/, "原因原样进 spec，渲染时转义");
  assert.deepEqual(failing.actions, [{ label: "重试", kind: "secondary", attrs: { "data-usage-sync": "" } }]);

  assert.equal(usagePageEmptyState(ready()), null, "有覆盖起点就不出页面级说明（旧数据照常显示）");
  assert.equal(usagePageEmptyState(ready({ sources: [{ id: "s1", lastError: "x" }] })), null, "采到过数据后的失败由数据源条说明");
  assert.equal(USAGE_DISABLED_STATE.title, "用量模块已关闭");
});

test("usageSessionEmptyState：本地筛选没命中 / Agent·项目筛选没命中 / 时间段里真的没有会话（同步 + 换更长范围）", () => {
  assert.equal(usageSessionEmptyState(ready({ sessions: [{ key: "a" }] }), base, 1), null);

  const unmatched = usageSessionEmptyState(ready({ sessions: [{ key: "a" }] }), base, 0);
  assert.equal(unmatched.icon, "search");
  assert.equal(unmatched.title, "没有匹配的会话");
  assert.deepEqual(unmatched.actions, [{ label: "清除会话筛选", kind: "text", attrs: { id: "usageResetSessions" } }], "沿用原来的按钮 id");

  const filtered = usageSessionEmptyState(ready(), { ...base, agent: "claude", project: "/x", projectLabel: "x" }, 0);
  assert.equal(filtered.title, "没有符合筛选的会话");
  assert.equal(filtered.body, "当前筛选：Claude · 项目 x。");
  assert.deepEqual(filtered.actions, [{ label: "清除筛选", kind: "text", attrs: { "data-usage-clear-filter": "" } }]);

  const today = usageSessionEmptyState(ready(), base, 0);
  assert.equal(today.tone, "neutral");
  assert.equal(today.icon, "calendar");
  assert.equal(today.title, "这个时间段没有 Agent 会话");
  assert.match(today.body, /会话日志每分钟从团队服务器同步一次（个人服务器不统计）/);
  assert.deepEqual(today.actions.map((a) => [a.label, a.kind, a.attrs]), [
    ["立即同步", "secondary", { "data-usage-sync": "" }],
    ["看近 7 天", "text", { "data-usage-jump-range": "7" }],
  ]);
  assert.equal(usageSessionEmptyState(ready(), { ...base, date: "2026-10-03" }, 0).actions[1].label, "看近 7 天", "看某一天时也给近 7 天");
  assert.equal(usageSessionEmptyState(ready(), { ...base, range: 7 }, 0).actions[1].label, "看近 30 天");
  assert.equal(usageSessionEmptyState(ready(), { ...base, range: 30 }, 0).actions.length, 1, "已经是最长范围：只留同步");

  // 顶部已有页面级说明（没有团队服务器 / 首次扫描）：会话表只留一句标题，不重复说明与动作。
  assert.deepEqual(usageSessionEmptyState({ sources: [] }, base, 0), { tone: "neutral", icon: "calendar", title: "这个时间段没有 Agent 会话" });
});
