import assert from "node:assert/strict";
import test from "node:test";

import { buildLogReaderHtml, captureLogScroll, diagnosisLogOptions, restoreLogScroll, WATCH_LOG_OPTIONS } from "./log-readback-view.js";

const reader = (extra = {}) => ({
  segments: [{ start: 100, end: 600, text: "<b>early</b>\n", dropped: 7, noBreak: false }],
  next: { before: 100 }, atStart: false, loading: false, error: "", code: null, stopped: false, capped: false, fresh: false,
  path: "/w/o.log", size: 2048, anchorText: "", anchorCheckedAt: 1000, continuous: true, sameFile: false, notes: [], ...extra,
});
const state = (log, r) => ({ log, readers: new Map([[log, r]]) });

test("诊断文件选项：序号沿用诊断记录，stdout / stderr / 同号日志按角色，旧记录不猜角色", () => {
  const options = diagnosisLogOptions([
    { path: "/w/o.out", role: "stdout", index: 0 },
    { path: "/w/arm_1.log", role: "sibling", index: 2 },
    { path: "/w/legacy.log", role: null, index: 3 },
    { path: "/w/x.log", role: null, index: 7 },
  ]);
  assert.deepEqual(options.map((o) => [o.value, o.label]), [["0", "stdout"], ["2", "同号日志 arm_1.log"], ["3", "日志 1"]]);
});

test("未读：只有选项与「读取前一段」，写明口径；没有原文框", () => {
  const html = buildLogReaderHtml({ from: "watch", jobId: "18765", options: WATCH_LOG_OPTIONS, state: null });
  assert.match(html, /data-lr-action="pick"[^>]*data-lr-log="stdout"[^>]*aria-pressed="true"/);
  assert.match(html, /data-lr-action="read"[^>]*>读取前一段</);
  assert.match(html, /至多 32 KB/);
  assert.doesNotMatch(html, /<pre/);
});

test("已读：原文转义、字节范围、首行舍去说明、继续向前读取；诊断入口附取证时保存的末尾", () => {
  const html = buildLogReaderHtml({ from: "diagnosis", jobId: "9", options: diagnosisLogOptions([{ path: "/w/o.log", role: "stdout", index: 0 }]), state: state("0", reader({ anchorText: "TAIL<x>" })) });
  assert.match(html, /&lt;b&gt;early&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>early/);
  assert.match(html, /字节 100–600/);
  assert.match(html, /开头不完整的一行已舍去/);
  assert.match(html, />继续向前读取</);
  assert.match(html, /取证时保存的末尾<\/p><pre class="cl-diag-pre lr-anchor">TAIL&lt;x&gt;/);
  assert.match(html, /data-lr-scroll="diagnosis\|9\|0"/);
});

test("状态文案：停用 → 从当前末尾重新读取；到开头；关注入口末尾已刷新时提示可能有间隔；不衔接的文件写明", () => {
  const stopped = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stdout", reader({ stopped: true, error: "日志文件已被替换" })) });
  assert.match(stopped, /data-lr-action="restart"[^>]*>从当前末尾重新读取</);
  assert.match(stopped, /data-level="warn">日志文件已被替换/);
  const done = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stdout", reader({ atStart: true, next: null })) });
  assert.match(done, /已到文件开头/);
  assert.doesNotMatch(done, /data-lr-action="read"/);
  const moved = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stdout", reader()), progressCheckedAt: 2000 });
  assert.match(moved, /之后的采集中更新/);
  const same = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stdout", reader()), progressCheckedAt: 1000 });
  assert.doesNotMatch(same, /之后的采集中更新/);
  const other = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stderr", reader({ continuous: false, sameFile: true })) });
  assert.match(other, /不是「进度依据」采样的那个文件/);
  assert.match(other, /写在同一个文件/);
  const loading = buildLogReaderHtml({ from: "watch", jobId: "1", options: WATCH_LOG_OPTIONS, state: state("stdout", reader({ loading: true })) });
  assert.match(loading, /disabled>读取中…/);
});

test("阅读位置：按距底部的距离恢复（顶部插入不跳），新出现的原文框滚到底", () => {
  const el = (key, scrollHeight, scrollTop) => ({ key, scrollHeight, scrollTop, getAttribute: () => key });
  const old = el("a", 1000, 300);
  const saved = captureLogScroll({ querySelectorAll: () => [old] });
  assert.equal(saved.get("a"), 700);
  const grown = el("a", 1500, 300);
  const fresh = el("b", 800, 0);
  restoreLogScroll({ querySelectorAll: () => [grown, fresh] }, saved);
  assert.deepEqual([grown.scrollTop, fresh.scrollTop], [800, 800]);
});
