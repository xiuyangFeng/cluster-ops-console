// 概览「隧道稳定性」HTML 片段的测试（纯字符串，无 DOM）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResponseStrip, buildStrip } from "./tunnel-stability-model.js";
import { responseHtml, stabilityHtml, stripHtml } from "./tunnel-stability-view.js";

const NOW = Date.UTC(2026, 9, 2, 13, 0, 0); // 北京时间 10.2 21:00
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const timeline = {
  start: NOW - DAY,
  end: NOW,
  segments: [
    { from: NOW - DAY, to: NOW - 12 * HOUR, state: "unobserved" },
    { from: NOW - 12 * HOUR, to: NOW - HOUR, state: "up" },
    { from: NOW - HOUR, to: NOW - HOUR + 5 * MIN, state: "down", cause: "remote-closed", at: NOW - HOUR },
    { from: NOW - HOUR + 5 * MIN, to: NOW, state: "up" },
  ],
};
const response = buildResponseStrip([
  { ts: NOW - 30 * MIN, ms: 1700 }, { ts: NOW - 29 * MIN, ms: 2640 }, { ts: NOW - 24 * MIN, ms: 1740 },
], timeline.start, timeline.end);

const stats = {
  since: NOW - 12 * HOUR,
  generatedAt: NOW,
  servers: {
    "server-01": {
      serverId: "server-01", name: "主集群服务器 (myserver)", state: "up", since: NOW - 12 * HOUR,
      windows: { "24h": { drops: 0, availability: 1, longestUpMs: 12 * HOUR, causes: {} }, "7d": { drops: 0, availability: 1 } },
      timeline: { ...timeline, segments: timeline.segments.filter((s) => s.state === "unobserved") },
      daily: [{ day: "2026-10-01", availability: null, drops: 0, observedMs: 0, downMs: 0 }, { day: "2026-10-02", availability: 1, drops: 0, observedMs: 12 * HOUR, downMs: 0 }],
    },
    "server-aliyun": {
      serverId: "server-aliyun", name: "阿里云服务器 (vpn-aliyun)", state: "up", since: NOW - HOUR + 5 * MIN,
      windows: { "24h": { drops: 1, availability: 0.993, downMs: 5 * MIN, recoveries: 1, meanRecoveryMs: 5 * MIN, longestUpMs: 11 * HOUR, causes: { "remote-closed": 1 } }, "7d": { drops: 1, availability: 0.993 } },
      timeline,
      daily: [{ day: "2026-10-01", availability: null, drops: 0, observedMs: 0, downMs: 0 }, { day: "2026-10-02", availability: 0.993, drops: 1, observedMs: 12 * HOUR, downMs: 5 * MIN }],
    },
  },
  recentDrops: [
    { serverId: "server-aliyun", at: NOW - HOUR, cause: "remote-closed", uptimeMs: 11 * HOUR, recoveredAt: NOW - HOUR + 5 * MIN, downMs: 5 * MIN, detail: "Connection closed by remote host." },
  ],
};

test("在线条（近 24 小时）：分段条可点（带断线 key），斜纹为未观测，0 点竖线；没给响应数据就没有响应线", () => {
  const html = stripHtml(buildStrip({ timeline }, "24h"), { serverId: "server-aliyun", midnight: { left: "12.500%" } });
  assert.match(html, /^<div class="cu-track"><span class="cu-bar"><span class="cu-midnight" style="left:12\.500%"><\/span>/);
  assert.match(html, /class="cu-unobserved"/);
  assert.match(html, /<button type="button" class="cu-drop"[^>]*title="10\.2 20:00 服务器端断开 · 断开 5 分（点击查看）"[^>]*data-drop-key="server-aliyun:\d+"/);
  assert.doesNotMatch(html, /ts-resp/);
});

test("SSH 响应线：紧跟在线条下面，中位 / 最慢在悬停提示里；线与面积各一条 path；有十字线与气泡", () => {
  const html = stripHtml(buildStrip({ timeline }, "24h"), { response, serverId: "server-01" });
  assert.ok(html.indexOf('class="cu-bar"') < html.indexOf('class="trend-chart-container ts-resp cu-resp"'), "条在上、响应线在下");
  assert.match(html, /data-server="server-01" title="SSH 响应 · 中位 1\.74s · 最慢 2\.64s（每 5 分钟取最慢的一次 · 纵轴 0–5\.00s）"/);
  assert.match(html, /<svg viewBox="0 0 600 14" preserveAspectRatio="none" role="img" aria-label="近 24 小时 SSH 响应耗时，中位 1\.74s">/);
  assert.equal((html.match(/<path /g) || []).length, 2, "断成几段也只有两条 path（就地修补时结构不变）");
  assert.match(html, /<div class="trend-crosshair"><\/div><div class="trend-value-bubble"><\/div><\/div><\/div>$/);
});

test("SSH 响应线：没有数据不出；服务器 id 转义；近 7 天是日色块，日期只在要求时写", () => {
  assert.equal(responseHtml(null, "a"), "");
  assert.match(responseHtml(response, '"><img src=x>'), /data-server="&quot;&gt;&lt;img src=x&gt;"/);
  const daily = buildStrip({ daily: [{ day: "2026-10-02", availability: 1, drops: 0, observedMs: DAY, downMs: 0 }] }, "7d");
  assert.match(stripHtml(daily, { response, serverId: "a" }), /^<div class="ts-strip-daily cu-daily"[^>]*><span class="ts-day" data-tone="ok"[^>]*><i><\/i><b>10\.2<\/b><\/span><\/div>$/);
  assert.doesNotMatch(stripHtml(daily, { labels: false }), /<b>/);
});

test("整块（近 24 小时）：表头窗口切换、每条隧道一行、时间轴、最近一次；清单默认收起", () => {
  const { html, rows } = stabilityHtml(stats, { windowKey: "24h", nowMs: NOW });
  assert.equal(rows.length, 2);
  assert.match(html, /<b title="记录始于 10\.2 09:00（北京时间）">隧道稳定性<\/b>/);
  assert.match(html, /data-stability-window="24h" aria-pressed="true">24 小时<\/button><button type="button" data-stability-window="7d" aria-pressed="false">7 天/);
  assert.match(html, /<span class="cu-name" title="主集群服务器 \(myserver\)">主集群<\/span>/);
  assert.match(html, /<span class="cu-state" data-tone="ok"><span>在线 12 小时<\/span><small class="cu-summary" data-tone="ok"[^>]*>0 次断线 · 100%<\/small>/);
  assert.match(html, /<small class="cu-summary" data-tone="warn" title="服务器端断开 ×1 · 断开共 5 分 · 平均恢复 5 分 · 最长连续在线 11 小时">1 次断线 · 99\.30%<\/small>/);
  assert.match(html, /class="cu-row cu-axis-row"/);
  assert.match(html, /<span class="cu-last" title="[^"]+"><span class="cu-label">最近一次<\/span>10\.2 20:00 阿里云 · 服务器端断开 · 此前在线 11 小时 · 5 分后恢复/);
  assert.match(html, /data-stability-drops aria-expanded="false" aria-controls="stabilityDrops">全部 1 次/);
  assert.doesNotMatch(html, /id="stabilityDrops"/);
});

test("整块：展开清单 = 原因汇总 + 四列表格（此前在线与原始报错在整行悬停提示里）", () => {
  const { html, dropRows } = stabilityHtml(stats, { windowKey: "24h", nowMs: NOW, dropsOpen: true });
  assert.equal(dropRows.length, 1);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<div class="cu-drops" id="stabilityDrops"><p class="cu-causes"><span><b>阿里云<\/b>服务器端断开 ×1 · 平均恢复 5 分 · 最长连续在线 11 小时<\/span><\/p>/);
  assert.match(html, /<th scope="col">时间<\/th><th scope="col">服务器<\/th><th scope="col">原因<\/th><th scope="col">恢复用时<\/th>/);
  assert.match(html, /<tr data-ongoing="false" data-key="server-aliyun:\d+" title="此前在线 11 小时 · Connection closed by remote host\.">/);
});

test("整块（近 7 天）：没有时间轴与响应线；没断线时不出「全部 N 次」；没有隧道整块为空", () => {
  const { html } = stabilityHtml(stats, { windowKey: "7d", nowMs: NOW });
  assert.match(html, /cu-daily/);
  assert.doesNotMatch(html, /cu-axis-row|ts-resp/);
  assert.equal((html.match(/<b>10\.2<\/b>/g) || []).length, 1, "日期只在最后一行写");
  const calm = { ...stats, servers: { "server-01": stats.servers["server-01"] }, recentDrops: [] };
  assert.doesNotMatch(stabilityHtml(calm, { windowKey: "24h", nowMs: NOW }).html, /data-stability-drops/);
  assert.match(stabilityHtml(calm, { windowKey: "24h", nowMs: NOW }).html, /记录以来没有断线（自 10\.2 09:00）/);
  assert.equal(stabilityHtml({ servers: {} }, { nowMs: NOW }).html, "");
});

// ---- 休眠归因（v2.62）----

// 主集群 17:00 入睡、19:42 重新连上（北京时间 10.2）；云主机多一次真正的断线。
const slept = { from: NOW - 4 * HOUR, to: NOW - 4 * HOUR + 2 * HOUR + 42 * MIN + 40_000 };
const sleepRow = { serverId: "server-01", at: slept.from, cause: "sleep", detail: "", uptimeMs: null, networkChange: false, recoveredAt: slept.to, downMs: slept.to - slept.from, attempts: 1, sleep: true, drops: 3 };
const sleepStats = {
  ...stats,
  sleep: { "24h": { ms: 2 * HOUR + 42 * MIN + 18_000, count: 1, lastWakeAt: slept.to - 22_000 }, "7d": { ms: 2 * HOUR + 42 * MIN + 18_000, count: 1, lastWakeAt: slept.to - 22_000 } },
  servers: {
    ...stats.servers,
    "server-01": {
      ...stats.servers["server-01"],
      timeline: { start: NOW - DAY, end: NOW, segments: [{ from: NOW - DAY, to: slept.from, state: "up" }, { from: slept.from, to: slept.to, state: "sleep" }, { from: slept.to, to: NOW, state: "up" }] },
    },
  },
  recentDrops: [...stats.recentDrops, sleepRow],
};

test("在线条上的休眠段：与「没有记录」同样的斜纹，悬停写明是休眠、多久；不是红的、也不可点", () => {
  const html = stripHtml(buildStrip(sleepStats.servers["server-01"], "24h"), { serverId: "server-01" });
  assert.match(html, /<span class="cu-unobserved" style="left:83\.333%;width:max\(2px, 11\.296%\)" title="10\.2 17:00 本机休眠 · 2 小时 42 分（期间隧道不可用，不计入断线与可用率）"><\/span>/);
  assert.doesNotMatch(html, /cu-drop|data-drop-key/);
});

test("整块：有断线也有休眠——「全部 N 次」只数断线；展开后休眠是一行中性的「本机休眠」", () => {
  const closed = stabilityHtml(sleepStats, { windowKey: "24h", nowMs: NOW });
  assert.match(closed.html, /data-stability-drops aria-expanded="false" aria-controls="stabilityDrops">全部 1 次/);
  assert.match(closed.html, /<span class="cu-label">最近一次<\/span>10\.2 20:00 阿里云 · 服务器端断开/, "最近一次说的是断线");
  assert.match(closed.html, /title="近 24 小时没有断线 · 最长连续在线 12 小时 · 本机休眠 2 小时 42 分（不计入断线与可用率）">0 次断线 · 100%<\/small>/);

  const { html, dropRows } = stabilityHtml(sleepStats, { windowKey: "24h", nowMs: NOW, dropsOpen: true });
  assert.deepEqual(dropRows.map((r) => r.cause), ["服务器端断开", "本机休眠"]);
  assert.match(html, /<tr data-ongoing="false" data-key="server-01:\d+" title="电脑休眠期间隧道不可用，不计入断线次数与可用率；期间断开 3 次"><td class="ts-num">10\.2 17:00<\/td><td>主集群<\/td><td>本机休眠<\/td><td class="ts-num">2 小时 42 分<\/td><\/tr>/);
  assert.doesNotMatch(html, /只列出最近/);
});

test("整块：窗口里只有休眠、没有断线——按钮写「休眠 N 次」（按电脑休眠的次数），最近一次仍说没有断线", () => {
  const onlySleep = { ...sleepStats, recentDrops: [sleepRow, { ...sleepRow, serverId: "server-aliyun" }], servers: { ...sleepStats.servers, "server-aliyun": { ...sleepStats.servers["server-aliyun"], windows: { "24h": { drops: 0, availability: 1 }, "7d": { drops: 0, availability: 1 } } } } };
  const closed = stabilityHtml(onlySleep, { windowKey: "24h", nowMs: NOW });
  assert.match(closed.html, /data-stability-drops aria-expanded="false" aria-controls="stabilityDrops">休眠 1 次/, "一次休眠、两条隧道各一行：按钮说 1 次");
  assert.match(closed.html, /<span class="cu-label">最近一次<\/span>记录以来没有断线（自 10\.2 09:00）/);
  const open = stabilityHtml(onlySleep, { windowKey: "24h", nowMs: NOW, dropsOpen: true });
  assert.match(open.html, /aria-expanded="true"/);
  assert.equal((open.html.match(/<td>本机休眠<\/td>/g) || []).length, 2);
  assert.doesNotMatch(open.html, /cu-causes|只列出最近|data-ongoing="true"/);

  // 后端没给休眠次数（旧接口 / 账本里只有 sleep 标记没有 wake 行）：按清单里的行数说
  assert.match(stabilityHtml({ ...onlySleep, sleep: undefined }, { windowKey: "24h", nowMs: NOW }).html, /休眠 2 次/);
  // 什么都没有：照旧不出按钮
  assert.doesNotMatch(stabilityHtml({ ...onlySleep, recentDrops: [] }, { windowKey: "24h", nowMs: NOW }).html, /data-stability-drops/);
});
