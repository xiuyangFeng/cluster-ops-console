// 状态变更清单按「一阵」归组：分段、每段的最坏级别与收场、对象首尾变化，以及卡片 / 段落时间轴的 HTML。
import assert from "node:assert/strict";
import test from "node:test";

import { entryTone, episodeHtml, episodesBarText, episodeStripHtml, groupEpisodes } from "./timeline-episodes.js";

const T0 = Date.parse("2026-10-02T09:00:00+08:00");
const S = 1000;
const MIN = 60 * S;
const change = (ts, key, from, to, extra = {}) => ({ ts, key, from, to, reason: "", ...extra });

test("entryTone: 变更看变到了什么，信号看严重度", () => {
  assert.equal(entryTone(change(0, "channel", "ok", "error")), "error");
  assert.equal(entryTone(change(0, "channel", "error", "ok")), "ok");
  assert.equal(entryTone(change(0, "agent:codex", "ok", "skipped")), "idle");
  assert.equal(entryTone({ type: "signal", severity: "warn" }), "warn");
  assert.equal(entryTone({ type: "signal", severity: "error" }), "error");
});

test("groupEpisodes: 相隔不到 5 分钟归一段，最新的段在前、段内也是最新在前", () => {
  const entries = [
    change(T0, "channel", "ok", "error"),
    change(T0 + 40 * S, "channel", "error", "ok"),
    change(T0 + 4 * MIN, "agent:codex", "ok", "warn"), // 距上一条 3 分 20 秒：同一段
    change(T0 + 30 * MIN, "agent:codex", "warn", "ok"), // 断开超过 5 分钟：新的一段
  ];
  const eps = groupEpisodes(entries.slice().reverse()); // 输入顺序无关
  assert.equal(eps.length, 2);
  assert.equal(eps[0].start, T0 + 30 * MIN);
  assert.equal(eps[1].items.length, 3);
  assert.deepEqual(eps[1].items.map((e) => e.ts), [T0 + 4 * MIN, T0 + 40 * S, T0]);
  assert.equal(eps[1].end, T0 + 4 * MIN);
});

test("groupEpisodes: 最坏级别、收场（仍异常 / 已恢复 / 常规）与对象的首尾变化", () => {
  const [bad] = groupEpisodes([change(T0, "channel", "ok", "error"), change(T0 + S, "agent:codex", "ok", "warn"), change(T0 + 2 * S, "agent:codex", "warn", "ok")]);
  assert.equal(bad.tone, "error");
  assert.equal(bad.outcome, "bad", "通道还停在故障");
  const codex = bad.objects.find((o) => o.key === "agent:codex");
  assert.deepEqual([codex.from, codex.to, codex.tone, codex.worst, codex.count], ["ok", "ok", "ok", "warn", 2]);

  const [recovered] = groupEpisodes([change(T0, "channel", "ok", "error", { trigger: "auto" }), change(T0 + S, "channel", "error", "ok")]);
  assert.equal(recovered.outcome, "recovered");
  assert.equal(recovered.autoCount, 1);

  const [calm] = groupEpisodes([change(T0, "agent:codex", "skipped", "ok")]);
  assert.equal(calm.outcome, "calm");
  assert.equal(calm.tone, "ok");

  // 信号不影响「是否仍异常」（它没有恢复这一说），按类别合并计数
  const [signals] = groupEpisodes([{ type: "signal", ts: T0, severity: "warn", category: "gateway" }, { type: "signal", ts: T0 + S, severity: "error", category: "gateway" }]);
  assert.equal(signals.outcome, "recovered");
  assert.equal(signals.objects.length, 1);
  assert.equal(signals.objects[0].count, 2);
  assert.equal(signals.objects[0].tone, "error");
});

test("episodeHtml: 收起时也列出对象的首尾变化；中途坏过的对象标出最坏颜色；超出的写 +N", () => {
  const entries = [change(T0, "agent:codex", "ok", "error"), change(T0 + 50 * S, "agent:codex", "error", "ok")];
  for (let i = 0; i < 7; i += 1) entries.push(change(T0 + i * S, `res:s${i}`, "ok", "warn"));
  const [ep] = groupEpisodes(entries);
  const html = episodeHtml(ep, {
    open: false,
    objectName: (o) => `名-${o.key}`,
    levelLabel: (l) => ({ ok: "正常", error: "故障", warn: "警告" })[l] || l,
    rowHtml: (e) => `<li data-ts="${e.ts}"></li>`,
    maxChips: 3,
  });
  assert.match(html, /<details class="tl-ep-card" data-ep="\d+">/, "未展开不带 open");
  assert.match(html, /data-tone="ok" data-dip="error"[^>]*><i class="tl-chip-dot"><\/i><span class="tl-chip-name">名-agent:codex<\/span>/);
  assert.match(html, /<span class="tl-chip-from">故障<\/span>|<span class="tl-chip-from">正常<\/span>/);
  assert.match(html, /tl-chip-more">\+5</);
  assert.match(html, /9 条 · 历时 50 秒/);
  assert.equal((html.match(/<li data-ts=/g) || []).length, 9, "明细逐条都在卡里");
  assert.match(html, /<b>09:00:00<\/b><span class="tl-ep-dash">–<\/span>09:00:50/, "按北京时间写时刻");
  assert.match(episodeHtml(ep, { open: true }), / open>/);
});

test("episodeHtml: 实时视图附相对时间，跨天时开头带日期", () => {
  const [ep] = groupEpisodes([change(T0, "channel", "ok", "error")]);
  const sameDay = episodeHtml(ep, { live: true, now: T0 + 3 * MIN });
  assert.match(sameDay, /tl-ep-ago">3 分钟前</);
  assert.match(sameDay, /<b>09:00:00<\/b>/);
  const nextDay = episodeHtml(ep, { live: true, now: T0 + 20 * 3600 * S });
  assert.match(nextDay, /<b>10\.2 09:00:00<\/b>/);
});

test("episodesBarText / episodeStripHtml: 概况一行与段落时间轴", () => {
  const eps = groupEpisodes([change(T0, "channel", "ok", "error"), change(T0 + 2 * 3600 * S, "channel", "error", "ok")]);
  assert.equal(episodesBarText(eps), "2 条变更归为 2 段 · 1 段仍有异常");
  assert.equal(episodesBarText(eps, { shown: 1 }), "2 条变更归为 2 段 · 1 段仍有异常 · 显示 1 段");
  const strip = episodeStripHtml(eps, { start: T0, end: T0 + 4 * 3600 * S });
  assert.equal((strip.match(/class="tl-strip-mark"/g) || []).length, 2);
  assert.match(strip, /data-ep-jump="\d+" style="left:50\.000%;width:0\.000%"/);
  assert.match(strip, /<span class="tl-strip-label">09:00<\/span>/);
  assert.match(strip, /<span class="tl-strip-label">13:00<\/span>/, "窗口终点不是现在时写时刻");
  // 窗口外的段不画
  assert.equal((episodeStripHtml(eps, { start: T0 + 3 * 3600 * S, end: T0 + 4 * 3600 * S }).match(/tl-strip-mark"/g) || []).length, 0);
});
