import assert from "node:assert/strict";
import test from "node:test";

import { EMPTY_ICONS, emptyStateHtml } from "./empty-state.js";

test("emptyStateHtml：语气、图标、标题 / 正文 / 说明，文字一律转义", () => {
  const html = emptyStateHtml({ tone: "ok", icon: "check", title: "没有未解决的事件", body: "<b>x</b> & y", meta: "上次同步 · 1 分钟前" });
  assert.match(html, /^<div class="empty-state" data-tone="ok">/);
  assert.ok(html.includes(EMPTY_ICONS.check));
  assert.match(html, /<p class="empty-state-title">没有未解决的事件<\/p>/);
  assert.match(html, /<p class="empty-state-body">&lt;b&gt;x&lt;\/b&gt; &amp; y<\/p>/);
  assert.match(html, /<p class="empty-state-meta">上次同步 · 1 分钟前<\/p>/);
  assert.doesNotMatch(html, /empty-state-actions/, "没有动作就不出动作行");
});

test("emptyStateHtml：未知语气回落 neutral，未知图标回落 inbox", () => {
  const html = emptyStateHtml({ tone: "bogus", icon: "nope", title: "t" });
  assert.match(html, /data-tone="neutral"/);
  assert.ok(html.includes(EMPTY_ICONS.inbox));
});

test("emptyStateHtml：动作最多两个；主按钮 / 次按钮 / 文字按钮；属性名白名单、属性值转义", () => {
  const html = emptyStateHtml({
    title: "t",
    actions: [
      { label: "添加服务器", kind: "primary", attrs: { "data-dialog": "dlgSettings" } },
      { label: "清除筛选", kind: "text", attrs: { "data-x": '"><script>', "on click": "bad", onclick: "alert(1)" } },
      { label: "第三个", kind: "secondary" },
    ],
  });
  assert.match(html, /<button type="button" class="btn btn-primary" data-dialog="dlgSettings">添加服务器<\/button>/);
  assert.match(html, /<button type="button" class="text-btn" data-x="&quot;&gt;&lt;script&gt;">清除筛选<\/button>/);
  assert.doesNotMatch(html, /on click|onclick/, "非法属性名与内联事件属性一律丢弃");
  assert.doesNotMatch(html, /第三个/);
});

test("emptyStateHtml：紧凑型把标题与正文包进 .empty-state-text（一行排开）", () => {
  const html = emptyStateHtml({ compact: true, title: "没有需要处理的事件", body: "链路和 Agent 出问题时会排在这里。" });
  assert.match(html, /^<div class="empty-state is-compact"/);
  assert.match(html, /<div class="empty-state-text"><p class="empty-state-title">没有需要处理的事件<\/p><p class="empty-state-body">/);
});

test("emptyStateHtml：等待态 / 错误态带读屏播报语义，空与好消息不打断朗读", () => {
  assert.match(emptyStateHtml({ tone: "wait", title: "正在读取…" }), /data-tone="wait" role="status" aria-live="polite"/);
  assert.match(emptyStateHtml({ tone: "error", title: "读取失败" }), /data-tone="error" role="alert"/);
  assert.doesNotMatch(emptyStateHtml({ tone: "neutral", title: "还没有事件" }), /role="(status|alert)"/);
  assert.doesNotMatch(emptyStateHtml({ tone: "ok", title: "没有未解决的事件" }), /role="(status|alert)"/);
});
