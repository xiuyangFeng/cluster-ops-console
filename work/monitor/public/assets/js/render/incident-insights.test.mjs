import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildClusterModel, buildIncidentCopyText, clusterCardHtml, contextEntryView, dispositionView, incidentContextHtml, incidentRemedy, latestDisposition,
  recurrenceText, spanText,
} from "./incident-insights.js";
import { buildIncidentListModel, incidentCardHtml } from "./incidents.js";

const MIN = 60_000;
// 北京时间 2026-10-23 10:00:00
const NOW = Date.UTC(2026, 9, 23, 2, 0, 0);

test("建议处置：隧道 → 单隧道重启（不支持时退回一键修复并说明会断全部连接）；通道 → 一键修复；账号 / 磁盘 → 只给下一步", () => {
  const tunnel = { component: "tunnel", serverId: "s1", reasonCode: "TUNNEL_DOWN", lifecycle: "open" };
  assert.equal(incidentRemedy(tunnel, { canScoped: true }).action, "restart-tunnel");
  assert.match(incidentRemedy(tunnel, { canScoped: true }).expect, /其它连接不受影响/);
  const fallback = incidentRemedy(tunnel, { canScoped: false });
  assert.equal(fallback.action, "restart-channel");
  assert.match(fallback.expect, /所有连接会中断/);
  assert.equal(incidentRemedy({ component: "channel", reasonCode: "TUNNEL_DOWN+REMOTE_PORT_CLOSED", lifecycle: "open" }).action, "restart-channel");
  assert.equal(incidentRemedy({ component: "channel", reasonCode: "MANUALLY_STOPPED", lifecycle: "open" }).action, null);
  for (const code of ["AUTH_REQUIRED", "ACCOUNT_REVOKED", "ACCOUNT_BANNED", "AGENT_MISSING"]) {
    const r = incidentRemedy({ component: "agent", agentId: "codex", reasonCode: code, lifecycle: "open" });
    assert.equal(r.action, null, code);
    assert.match(r.advice, /重启连接解决不了/, code);
  }
  assert.match(incidentRemedy({ component: "filesystem", reasonCode: "DISK_THRESHOLD", lifecycle: "open" }).advice, /88%/);
  assert.equal(incidentRemedy({ ...tunnel, lifecycle: "resolved" }), null, "已恢复不给处置");
  assert.equal(incidentRemedy(null), null);
});

test("处置记录文案：手动 / 自动、单隧道 / 全部；恢复带用时，未恢复如实说，之后才恢复单独说", () => {
  const at = NOW - 5 * MIN;
  assert.deepEqual(dispositionView({ at, action: "restart-tunnel", trigger: "manual", outcome: "recovered", afterMs: 38_000 }, { nowMs: NOW }),
    { text: "09:55 手动重启这条隧道 → 38 秒后恢复", tone: "ok", outcome: "recovered" });
  assert.equal(dispositionView({ at, action: "restart-channel", trigger: "auto", outcome: "not-recovered" }, { nowMs: NOW }).text, "09:55 自动修复重启所有连接 → 3 分钟后仍未恢复");
  assert.equal(dispositionView({ at, action: "restart-channel", trigger: "manual", outcome: "recovered-late", afterMs: 7 * MIN }, { nowMs: NOW }).text, "09:55 手动重启所有连接 → 当时未见效，7 分钟后才恢复");
  assert.equal(dispositionView({ at, action: "restart-tunnel", outcome: null }, { nowMs: NOW }).tone, "pending");
  assert.equal(dispositionView({ at: "x" }), null);
  assert.equal(latestDisposition({ dispositions: [{ at, outcome: "recovered", afterMs: 1000 }, { at: at + MIN, outcome: null }] }, { nowMs: NOW }).outcome, null, "取最近一条");
  assert.equal(latestDisposition({}), null);
});

test("短时间内第几次：「25 分钟内第 8 次（之前 7 次累计 14 分钟）」；持续型不说累计；一次的不显示", () => {
  assert.equal(recurrenceText({ count: 8, sinceAt: NOW - 25 * MIN, downMs: 14 * MIN }, { nowMs: NOW }), "25 分钟内第 8 次（之前 7 次累计 14 分钟）");
  assert.equal(recurrenceText({ count: 3, sinceAt: NOW - 3 * 3600_000, downMs: 0 }, { nowMs: NOW }), "180 分钟内第 3 次".replace("180 分钟", "3 小时"));
  assert.equal(recurrenceText({ count: 2, sinceAt: NOW - MIN, downMs: 5000 }, { nowMs: NOW, continuous: true }), "1 分钟内第 2 次");
  assert.equal(recurrenceText({ count: 1, sinceAt: NOW }), "");
  assert.equal(recurrenceText(null), "");
  assert.equal(spanText(125_000), "2 分 5 秒");
  assert.equal(spanText(3 * 3600_000 + 60_000), "3 小时 1 分");
});

test("前后经过：每类条目的文案与语气；其它事件用调用方给的名字；时间轴 HTML 转义、标出省略段与「本机 / 当时查看的服务器」", () => {
  const titleOf = (e) => `${e.component}<${e.serverId}>`;
  const view = (entry) => contextEntryView({ at: NOW - MIN, ...entry }, { nowMs: NOW, titleOf });
  assert.deepEqual([view({ kind: "incident-open", self: true }).text, view({ kind: "incident-open", self: true }).tone], ["本事件开始（首次检测到）", "bad"]);
  assert.equal(view({ kind: "incident-open", component: "channel", serverId: "s1" }).text, "channel<s1> 开始");
  assert.equal(view({ kind: "tunnel-down", cause: "process-lost", sleep: true }).text, "隧道断开 · 隧道进程消失（休眠期间）");
  assert.equal(view({ kind: "tunnel-down", cause: "port-closed" }).tone, "bad");
  assert.equal(view({ kind: "tunnel-up", downMs: 95_000, attempts: 3, via: "restart" }).text, "隧道重连（断开 1 分 35 秒，第 3 次尝试，重启后）");
  assert.equal(view({ kind: "sleep", sleptMs: 4 * MIN, wokeAt: NOW }).text, "电脑休眠 4 分钟，10:00 醒来");
  assert.equal(view({ kind: "config" }).text, "配置变更，隧道按计划重连");
  assert.equal(view({ kind: "config", scope: "local" }).text, "配置文件改动，已热载");
  assert.equal(view({ kind: "signal", scope: "view", title: "账号限流（429）", severity: "warn" }).note, "当时查看的服务器");
  assert.equal(view({ kind: "disposition", action: "restart-tunnel", trigger: "manual", outcome: "recovered", afterMs: 38_000 }).text, "手动重启这条隧道 → 38 秒后恢复");
  assert.equal(view({ kind: "handoff", scope: "local" }).text, "后台组件热更新交接");
  assert.equal(view({ kind: "monitor-start", unclean: true }).tone, "warn");
  assert.equal(view({ kind: "nope" }), null);

  const html = incidentContextHtml({
    from: NOW - 70 * MIN, to: NOW, gap: { from: NOW - 30 * MIN, to: NOW - 20 * MIN }, truncated: 2,
    entries: [
      { at: NOW - 60 * MIN, kind: "incident-open", self: true },
      { at: NOW - 10 * MIN, kind: "signal", scope: "view", title: "<b>x</b>", severity: "error" },
    ],
  }, { nowMs: NOW, titleOf });
  assert.match(html, /<li data-tone="bad" data-self="true"><time>09:00:00<\/time><span>本事件开始/);
  assert.match(html, /<li class="ev-ctx-gap">中间 10 分钟 省略<\/li>[\s\S]*卡顿信号：&lt;b&gt;x&lt;\/b&gt; <em>· 当时查看的服务器<\/em>/);
  assert.match(html, /另有 2 条/);
  assert.match(incidentContextHtml({ entries: [{ at: NOW, kind: "incident-open", self: true }] }, { nowMs: NOW }), /这段时间没有别的相关记录/);
  assert.match(incidentContextHtml(null), /正在整理/);
  assert.match(incidentContextHtml(null, { failed: true }), /暂时取不到/);
});

test("事件卡片：建议处置按钮带动作与服务器，复核中禁用；处置结果与「未恢复 → 复制排障信息」的引导；短时间内第几次", () => {
  const raw = {
    incidentId: "i1", serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", lifecycle: "open",
    firstSeenAt: NOW - 40 * MIN, lastSeenAt: NOW - MIN, occurrences: 14, attention: {},
    recurrence: { count: 8, sinceAt: NOW - 50 * MIN, downMs: 14 * MIN },
    dispositions: [{ operationId: "op", at: NOW - 5 * MIN, action: "restart-tunnel", trigger: "manual", outcome: "not-recovered" }],
  };
  const [item] = buildIncidentListModel({ state: "open", incidents: [raw] }, { nowMs: NOW, canScoped: true }).items;
  const html = incidentCardHtml(item, { withRemedy: true });
  assert.match(html, /<span class="incident-when">已持续 40 分钟<\/span>/);
  assert.match(html, /<span>检测 14 次<\/span>/);
  assert.match(html, /50 分钟内第 8 次（之前 7 次累计 14 分钟）/);
  assert.match(html, /data-remedy="restart-tunnel" data-server-id="s1">重启这条隧道<\/button>/);
  assert.match(html, /data-tone="warn"><b>处置<\/b>09:55 手动重启这条隧道 → 3 分钟后仍未恢复：重启解决不了，建议「复制排障信息」/);
  assert.doesNotMatch(incidentCardHtml(item, { withRemedy: false }), /data-remedy/, "没接 runbook 时不出按钮");
  const pending = buildIncidentListModel({ state: "open", incidents: [{ ...raw, dispositions: [{ ...raw.dispositions[0], outcome: null }] }] }, { nowMs: NOW, canScoped: true }).items[0];
  assert.match(incidentCardHtml(pending, { withRemedy: true }), /disabled>处置复核中…<\/button>/);
  assert.match(incidentCardHtml(item, { contextHtml: "<div>CTX</div>" }), /aria-expanded="true">收起前后经过<\/button>[\s\S]*<div>CTX<\/div>\s*<\/div>$/);
});

test("复制排障信息：是什么 / 多久 / 近况 / 处置 / 建议 / 证据 / 前后经过 / 事件 ID，北京时间", () => {
  const raw = {
    incidentId: "i1", serverId: "s1", component: "agent", agentId: "codex", reasonCode: "AUTH_REQUIRED", severity: "error", lifecycle: "open",
    firstSeenAt: NOW - 40 * MIN, lastSeenAt: NOW - MIN, occurrences: 5, attention: {},
    evidenceRefs: [{ kind: "probe", probeId: "codex-doctor" }],
  };
  const [item] = buildIncidentListModel({ state: "open", incidents: [raw] }, { nowMs: NOW }).items;
  const text = buildIncidentCopyText(item, { nowMs: NOW, context: { entries: [{ at: NOW - 41 * MIN, kind: "sleep", sleptMs: MIN, scope: "local" }] } });
  assert.match(text, /^【事件】codex · 需要重新登录（AUTH_REQUIRED）\n服务器：s1（s1）\n状态：未解决 · 已持续 40 分钟 · 严重\n首次：2026-10-23 09:20/);
  assert.match(text, /检测 5 次（北京时间）/);
  assert.match(text, /建议：需要在集群上重新登录/);
  assert.match(text, /证据：probe · codex-doctor/);
  assert.match(text, /前后经过：\n {2}09:19:00 电脑休眠 1 分钟/);
  assert.match(text, /事件 ID：i1$/);
});

test("事件簇卡片：多次的合成一张（×7、时间段、累计故障时长），展开列出逐次；单次的直接给前后经过", () => {
  const payload = {
    total: 2, incidentTotal: 8,
    clusters: [
      {
        clusterId: "c1", serverId: "s1", component: "tunnel", reasonCode: "TUNNEL_DOWN", severity: "error", count: 7, occurrences: 14, open: false,
        firstSeenAt: NOW - 130 * MIN, lastSeenAt: NOW - 105 * MIN, resolvedAt: NOW - 105 * MIN, downMs: 14 * MIN, spanMs: 25 * MIN, operationIds: [],
        members: [{ incidentId: "m7", firstSeenAt: NOW - 106 * MIN, resolvedAt: NOW - 105 * MIN, occurrences: 2, relatedOperationIds: ["op-9"], dispositions: [] }],
      },
      { clusterId: "c2", serverId: "s1", component: "agent", agentId: "codex", reasonCode: "AUTH_REQUIRED", severity: "error", count: 1, occurrences: 3, firstSeenAt: NOW - 20 * 60 * MIN, lastSeenAt: NOW - 19 * 60 * MIN, downMs: 60 * MIN, members: [{ incidentId: "solo", firstSeenAt: NOW - 20 * 60 * MIN }] },
      { clusterId: "", firstSeenAt: NOW },
    ],
  };
  const model = buildClusterModel(payload, { nowMs: NOW, titleOf: (c) => `T:${c.reasonCode}`, serverLabelOf: (id) => `S:${id}`, expanded: new Set(["c1"]) });
  assert.equal(model.clusters.length, 2);
  const [flap, solo] = model.clusters;
  assert.equal(flap.rangeText, "07:50 – 08:15");
  assert.equal(flap.spanText, "25 分钟");
  assert.equal(flap.summaryText, "7 次 · 累计故障 14 分钟");
  assert.equal(flap.moreCount, 6);
  const html = clusterCardHtml(flap, { withViewOps: true });
  assert.match(html, /<span class="ev-count"[^>]*>×7<\/span>/);
  assert.match(html, /data-cluster-toggle="c1" aria-expanded="true" aria-controls="incidentCluster-c1">收起逐次/);
  assert.match(html, /08:14:00 – 08:15:00<\/span><span>持续 1 分钟<\/span><span>检测 2 次<\/span>[\s\S]*data-incident-context="m7"[\s\S]*data-view-ops="op-9"/);
  assert.match(html, /另有 6 次更早的记录未列出/);
  assert.equal(solo.summaryText, "持续 1 小时 · 检测 3 次");
  const soloHtml = clusterCardHtml(solo);
  assert.doesNotMatch(soloHtml, /ev-count|data-cluster-toggle/);
  assert.match(soloHtml, /data-incident-context="solo">前后经过/);
  assert.equal(buildClusterModel(null).empty, true);
});
