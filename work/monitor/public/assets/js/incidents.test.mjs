// incidents 渲染模型测试（T06，A24 层级/A27 数据消费契约）。纯函数，无 DOM。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIncidentListModel,
  buildIncidentRenderSignature,
  buildIncidentSummaryModel,
  buildOverviewIncidentSummary,
  coarseDuration,
  incidentListEmptyHtml,
  incidentReasonLabel,
  incidentSummaryHtml,
  incidentSummaryPlaceholderHtml,
  preciseDuration,
} from "./render/incidents.js";

// 北京时间 2026-09-05 10:40:00
const NOW = 1_788_576_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// /api/status 里与名字有关的部分：serverId → 配置里的名字，agentId → 显示名。
const STATUS = {
  serversBrief: { "server-01": { displayName: "主集群服务器 (myserver)" }, aliyun: { name: "阿里云服务器" } },
  agents: [{ id: "codex", name: "Codex" }, { id: "claude-codewing", name: "Claude CodeWing" }],
};

const samplePayload = {
  state: "open",
  total: 3,
  overflow: { count: 2, lastAt: NOW - 1000 },
  incidents: [
    {
      incidentId: "inc-1", severity: "error", component: "channel", reasonCode: "TUNNEL_DOWN",
      serverId: "server-01", occurrences: 12, firstSeenAt: NOW - 3600_000, lastSeenAt: NOW - 60_000,
      attention: { acknowledgedAt: NOW - 30_000, snoozedUntil: null },
      relatedOperationIds: ["op-1", "op-2", "op-3", "op-4"],
      lifecycle: "open",
    },
    {
      incidentId: "inc-2", severity: "weird-severity", component: "agent", agentId: "codex",
      reasonCode: "DEGRADED", serverId: "", occurrences: "not-a-number", firstSeenAt: null, lastSeenAt: NOW,
      attention: { snoozedUntil: NOW + 60_000 }, lifecycle: "open",
    },
    // 畸形条目：无 incidentId → 逐条降级丢弃。
    { severity: "warn" },
    null,
  ],
};

test("模型: 字段映射与逐条降级（畸形 severity/occurrences/缺失 id）", () => {
  const model = buildIncidentListModel(samplePayload, { nowMs: NOW });
  assert.equal(model.state, "open");
  assert.equal(model.total, 3);
  assert.equal(model.overflow.count, 2);
  assert.equal(model.items.length, 2, "无 id / null 条目被丢弃");
  const first = model.items[0];
  assert.equal(first.severityLabel, "严重");
  assert.equal(first.componentLabel, "通道");
  assert.equal(first.occurrences, 12);
  assert.equal(first.acknowledged, true);
  assert.equal(first.snoozed, false, "snoozedUntil 已过期为 false");
  assert.deepEqual(first.relatedOperationIds, ["op-2", "op-3", "op-4"], "关联操作有界：保留最近的 3 个（最后一个是最近一次处置）");
  const second = model.items[1];
  assert.equal(second.severity, "warn", "畸形 severity 回落 warn");
  assert.equal(second.severityLabel, "警告");
  assert.equal(second.occurrences, 1, "畸形 occurrences 回落 1");
  assert.equal(second.serverId, "");
  assert.equal(second.serverLabel, "全局", "空 serverId 显示为全局");
  assert.equal(second.snoozed, true, "未到期的 snooze 生效");
});

test("名字: 标题与服务器用界面用语——Agent 用显示名、其余用组件名，原因码翻成文案；没有状态快照时退回 id", () => {
  const named = buildIncidentListModel(samplePayload, { nowMs: NOW, status: STATUS });
  assert.equal(named.items[0].title, "通道 · 连接断开");
  assert.equal(named.items[0].serverLabel, "主集群", "「主集群服务器 (myserver)」取短名");
  assert.equal(named.items[1].title, "Codex · 降级");
  const bare = buildIncidentListModel(samplePayload, { nowMs: NOW });
  assert.equal(bare.items[0].serverLabel, "server-01", "状态快照还没到：先显示 id，到了再换");
  assert.equal(bare.items[1].title, "codex · 降级");
  const odd = buildIncidentListModel({
    incidents: [
      { incidentId: "a", component: "agent", reasonCode: "AUTH_REQUIRED", serverId: "aliyun" },
      { incidentId: "b", component: "tunnel", agentId: "codex", reasonCode: "TUNNEL_DOWN", serverId: "gone" },
      { incidentId: "c", component: "widget", reasonCode: "SOMETHING_NEW" },
      { incidentId: "d" },
    ],
  }, { nowMs: NOW, status: STATUS });
  assert.deepEqual(odd.items.map((item) => item.title), [
    "Agent · 需要重新登录", // 没带 agentId 的旧事件
    "隧道 · 连接断开", // 非 Agent 组件不拿 agentId 当名字
    "widget · SOMETHING_NEW", // 未登记的组件 / 原因原样显示作兜底
    "组件 · UNKNOWN",
  ]);
  assert.deepEqual(odd.items.map((item) => item.serverLabel), ["阿里云", "gone", "全局", "全局"]);
});

test("原因码: 后端会产生的取值都有文案；几个码用 + 连起来时逐段翻译；未登记的原样显示", () => {
  const known = [
    "TUNNEL_DOWN", "REMOTE_PORT_CLOSED", "LOCAL_PROXY_DOWN", "CHANNEL_ERROR", "TRANSPORT_DATA_PATH_OK", "WAITING_FIRST_PROBE",
    "MANUALLY_STOPPED", "DEGRADED", "AGENT_ATTENTION", "AGENT_MISSING", "AUTH_REQUIRED", "ACCOUNT_REVOKED", "ACCOUNT_BANNED",
    "DISK_THRESHOLD", "FS_SLOW",
  ];
  for (const code of known) {
    const label = incidentReasonLabel(code);
    assert.doesNotMatch(label, /[A-Z_]{3,}/, `${code} 应该有界面文案`);
  }
  assert.equal(incidentReasonLabel("DEGRADED"), "降级");
  assert.equal(incidentReasonLabel("DISK_THRESHOLD"), "用量超过阈值");
  assert.equal(incidentReasonLabel("LOCAL_PROXY_DOWN+TUNNEL_DOWN+REMOTE_PORT_CLOSED"), "本地代理未运行、连接断开、远端端口关闭");
  assert.equal(incidentReasonLabel("TUNNEL_DOWN+BRAND_NEW"), "连接断开、BRAND_NEW");
  assert.equal(incidentReasonLabel("BRAND_NEW"), "BRAND_NEW");
  assert.equal(incidentReasonLabel(""), "UNKNOWN");
  assert.equal(incidentReasonLabel(undefined), "UNKNOWN");
});

test("模型: filesystem 组件显示为「磁盘」；时刻按北京时间，缺失为 —", () => {
  const model = buildIncidentListModel({
    incidents: [
      {
        incidentId: "fs", component: "filesystem", reasonCode: "FS_SLOW",
        firstSeenAt: NOW - 90_000, lastSeenAt: NOW - 30_000, lifecycle: "resolved", resolvedAt: NOW,
      },
      { incidentId: "ch", component: "channel", reasonCode: "X", firstSeenAt: null, lastSeenAt: NOW - 2 * 3600_000 },
      // 昨天恢复的：恢复时刻也带日期（只写时刻会被当成今天）。
      { incidentId: "old", component: "tunnel", reasonCode: "TUNNEL_DOWN", firstSeenAt: NOW - DAY - HOUR, lastSeenAt: NOW - DAY - HOUR, lifecycle: "resolved", resolvedAt: NOW - DAY },
    ],
  }, { nowMs: NOW });
  const [fs, ch, old] = model.items;
  assert.equal(fs.componentLabel, "磁盘");
  assert.doesNotMatch(fs.componentLabel, /共享/);
  assert.equal(fs.title, "磁盘 · 读写缓慢");
  assert.equal(fs.firstSeenText, "10:38:30");
  assert.equal(fs.resolvedAtText, "10:40:00");
  assert.equal(fs.lastSeenText, "刚刚", "不足 1 分钟按分钟粒度显示「刚刚」");
  assert.equal(ch.firstSeenText, "—");
  assert.equal(ch.lastSeenText, "2 小时前");
  assert.equal(old.firstSeenText, "09-04 09:40:00");
  assert.equal(old.resolvedAtText, "09-04 10:40:00");
});

test("模型: 空载荷/混合版本缺字段整层降级，不抛错", () => {
  for (const bad of [null, undefined, {}, { incidents: "junk" }, { incidents: [42] }]) {
    const model = buildIncidentListModel(bad, { nowMs: NOW });
    assert.ok(Array.isArray(model.items));
    assert.equal(typeof model.total, "number");
  }
  const empty = buildIncidentListModel({ incidents: [] });
  assert.equal(empty.empty, true);
});

test("概览摘要: error 优先于 warn、最多 3 条、hidden 与溢出透出", () => {
  const model = buildIncidentListModel({
    incidents: [
      { incidentId: "a", severity: "warn", component: "channel", reasonCode: "X", occurrences: 5 },
      { incidentId: "b", severity: "error", component: "tunnel", reasonCode: "Y", occurrences: 1 },
      { incidentId: "c", severity: "warn", component: "channel", reasonCode: "Z", occurrences: 9 },
      { incidentId: "d", severity: "info", component: "agent", reasonCode: "W", occurrences: 1 },
    ],
    total: 4,
    overflow: { count: 7 },
  });
  const summary = buildOverviewIncidentSummary(model);
  assert.deepEqual(summary.items.map((i) => i.incidentId), ["b", "c", "a"], "error 最先，warn 按次数降序");
  assert.equal(summary.count, 4);
  assert.equal(summary.hidden, 1);
  assert.equal(summary.overflowCount, 7);
  const emptySummary = buildOverviewIncidentSummary({ items: [], total: 0 });
  assert.equal(emptySummary.count, 0);
});

test("概览摘要: 条目带着界面用名（标题 / 服务器短名），名字变了摘要跟着变", () => {
  const payload = { incidents: [{ incidentId: "a", severity: "warn", component: "agent", agentId: "claude-codewing", reasonCode: "DEGRADED", serverId: "server-01", occurrences: 2 }], total: 1 };
  const [named] = buildOverviewIncidentSummary(buildIncidentListModel(payload, { nowMs: NOW, status: STATUS })).items;
  assert.equal(named.title, "Claude CodeWing · 降级");
  assert.equal(named.serverLabel, "主集群");
  const [bare] = buildOverviewIncidentSummary(buildIncidentListModel(payload, { nowMs: NOW })).items;
  assert.equal(bare.title, "claude-codewing · 降级");
  assert.equal(bare.serverLabel, "server-01");
});

test("渲染签名: 新关联一次处置（relatedOperationIds 追加）即重渲——「查看处置日志」按钮跟到最近一次", () => {
  const payload = (ids) => ({ state: "open", total: 1, incidents: [{ incidentId: "inc-1", lastSeenAt: NOW, relatedOperationIds: ids }] });
  const before = buildIncidentRenderSignature(payload(["op-1"]), { nowMs: NOW, withViewOps: true });
  assert.notEqual(buildIncidentRenderSignature(payload(["op-1", "op-2"]), { nowMs: NOW, withViewOps: true }), before);
});

test("渲染签名: 状态快照里的名字到了 / 改了要重渲；还没拿到数据与空列表不是一回事", () => {
  const bare = buildIncidentRenderSignature(samplePayload, { nowMs: NOW });
  const named = buildIncidentRenderSignature(samplePayload, { nowMs: NOW, status: STATUS });
  assert.notEqual(named, bare);
  assert.equal(buildIncidentRenderSignature(samplePayload, { nowMs: NOW, status: structuredClone(STATUS) }), named);
  const renamed = { ...STATUS, agents: [{ id: "codex", name: "Codex CLI" }] };
  assert.notEqual(buildIncidentRenderSignature(samplePayload, { nowMs: NOW, status: renamed }), named);
  assert.notEqual(
    buildIncidentRenderSignature(null, { nowMs: NOW }),
    buildIncidentRenderSignature({ state: "open", total: 0, incidents: [] }, { nowMs: NOW }),
  );
});

test("磁盘事件: 显示友好原因、当前用量与已持续时长（不再显示「发生 N 万次」）", () => {
  const model = buildIncidentListModel({
    state: "open", total: 1,
    incidents: [{
      incidentId: "d", severity: "error", component: "filesystem", reasonCode: "DISK_THRESHOLD", serverId: "server-01",
      occurrences: 34117, firstSeenAt: NOW - 26 * 86400_000, lastSeenAt: NOW,
      evidenceRefs: [{ kind: "disk-usage", usedPct: 95 }, { kind: "disk-usage", usedPct: 92 }],
    }],
  }, { nowMs: NOW });
  const [item] = model.items;
  assert.equal(item.reasonLabel, "用量超过阈值");
  assert.equal(item.continuous, true);
  assert.equal(item.usedPct, 92, "取最近一次证据");
  assert.equal(item.ongoingText, "26 天");
  assert.equal(item.firstSeenText, "08-10 10:40:00", "跨天的首次时间带日期");
});

test("概览摘要: 已确认 / 稍后提醒中的不算待处理，只计入 quiet", () => {
  const model = {
    total: 3,
    items: [
      { incidentId: "a", severity: "error", occurrences: 1, acknowledged: true, snoozed: false },
      { incidentId: "b", severity: "warn", occurrences: 1, acknowledged: false, snoozed: true },
      { incidentId: "c", severity: "warn", occurrences: 1, acknowledged: false, snoozed: false },
    ],
    overflow: { count: 0 },
  };
  const summary = buildOverviewIncidentSummary(model);
  assert.equal(summary.count, 1);
  assert.equal(summary.quiet, 2);
  assert.deepEqual(summary.items.map((i) => i.incidentId), ["c"]);
  assert.equal(summary.hidden, 0);
});

// ---- 已恢复事件按类型汇总 ----

test("时长: 统计量用一个单位的粗粒度；逐条与悬停提示用相邻两个单位", () => {
  assert.deepEqual(
    [400, 45_000, 59_600, 104_000, 59.6 * MIN, 12 * HOUR, 23.6 * HOUR, 28 * DAY + 3 * HOUR].map(coarseDuration),
    ["不到 1 秒", "45 秒", "1 分", "2 分", "1 小时", "12 小时", "1 天", "28 天"],
  );
  assert.deepEqual(
    [0, 45_000, 104_000, 2 * MIN, 12 * HOUR + 5 * MIN, 3 * HOUR, 28 * DAY + 3 * HOUR, 2 * DAY].map(preciseDuration),
    ["0 秒", "45 秒", "1 分 44 秒", "2 分", "12 小时 5 分", "3 小时", "28 天 3 小时", "2 天"],
  );
  for (const bad of [null, undefined, Number.NaN, -1, "x"]) {
    assert.equal(coarseDuration(bad), "—");
    assert.equal(preciseDuration(bad), "—");
  }
});

// 含今天在内的 14 个北京自然日：2026-08-23 … 2026-09-05
const DAYS = Array.from({ length: 14 }, (_, i) => new Date(NOW + 8 * HOUR - (13 - i) * DAY).toISOString().slice(0, 10));
const CLAUDE_KEY = "server-01|agent:claude-codewing|DEGRADED";
const CODEX_KEY = "server-01|agent:codex|DEGRADED";
const recentItem = (incidentId, firstSeenAt, lasting, extra = {}) => ({
  incidentId, firstSeenAt, lastSeenAt: firstSeenAt, resolvedAt: firstSeenAt + lasting, occurrences: 1, operationId: null, ...extra,
});
const summaryPayload = {
  schemaVersion: 1, generatedAt: NOW, days: DAYS, countingSince: NOW - 2 * DAY, keepPerType: 50, retained: 92, total: 91, capped: true,
  types: [
    {
      key: CLAUDE_KEY, serverId: "server-01", agentId: "claude-codewing", component: "agent", reasonCode: "DEGRADED",
      severity: "warn", count: 39, capped: false, coverageStart: null, perDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9, 12, 10, 8],
      lastSeenAt: NOW - 28 * MIN, lastResolvedAt: NOW - 27 * MIN, medianMs: 62_000, longestMs: 18 * MIN + 4000, samples: 39, retained: 39,
      recent: [
        recentItem("r-1", NOW - 28 * MIN, 104_000, { occurrences: 3 }),
        recentItem("r-2", NOW - 11 * HOUR, 30 * MIN, { occurrences: 2, operationId: "op-9" }), // 昨天 23:40 发生，今天 00:10 恢复
      ],
    },
    {
      key: CODEX_KEY, serverId: "server-01", agentId: "codex", component: "agent", reasonCode: "DEGRADED",
      severity: "warn", count: 50, capped: true, coverageStart: "2026-09-03", perDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 18, 12],
      lastSeenAt: NOW - 2 * HOUR, lastResolvedAt: NOW - 2 * HOUR + 54_000, medianMs: 54_000, longestMs: 7 * MIN, samples: 50, retained: 50,
      recent: Array.from({ length: 8 }, (_, i) => recentItem(`c-${i}`, NOW - (2 + i) * HOUR, 54_000)),
    },
    {
      key: "server-01|filesystem|DISK_THRESHOLD", serverId: "server-01", agentId: null, component: "filesystem", reasonCode: "DISK_THRESHOLD",
      severity: "error", count: 1, capped: false, coverageStart: null, perDay: Array(14).fill(1),
      lastSeenAt: NOW - HOUR, lastResolvedAt: NOW - HOUR, medianMs: 28 * DAY + 3 * HOUR, longestMs: 28 * DAY + 3 * HOUR, samples: 1, retained: 1,
      recent: [recentItem("d-1", NOW - HOUR - 28 * DAY - 3 * HOUR, 28 * DAY + 3 * HOUR, { occurrences: 34117 })],
    },
    {
      key: "aliyun|tunnel|TUNNEL_DOWN", serverId: "aliyun", agentId: null, component: "tunnel", reasonCode: "TUNNEL_DOWN",
      severity: "error", count: 1, capped: false, coverageStart: null, perDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0],
      lastSeenAt: NOW - 20 * HOUR, lastResolvedAt: NOW - 20 * HOUR + 11 * MIN, medianMs: 11 * MIN, longestMs: 11 * MIN, samples: 1, retained: 1,
      recent: [recentItem("t-1", NOW - 20 * HOUR, 11 * MIN)],
    },
    {
      // 20 天前发生过、窗口内没有，逐条记录也已清理：只剩类型本身。
      key: "global|proxy|PROXY_DOWN", serverId: null, agentId: null, component: "proxy", reasonCode: "PROXY_DOWN",
      severity: "info", count: 0, capped: false, coverageStart: null, perDay: Array(14).fill(0),
      lastSeenAt: NOW - 20 * DAY, lastResolvedAt: NOW - 20 * DAY, medianMs: null, longestMs: null, samples: 0, retained: 0, recent: [],
    },
    { severity: "warn" }, // 畸形：没有 key
    null,
  ],
};

test("汇总模型: 每类一行——界面用名、次数（含下限标记）、最近一次、典型持续、逐日分布", () => {
  const model = buildIncidentSummaryModel(summaryPayload, { nowMs: NOW, status: STATUS, expanded: new Set([CODEX_KEY]) });
  assert.equal(model.ready, true);
  assert.equal(model.windowDays, 14);
  assert.equal(model.rows.length, 5, "没有 key 的 / null 条目被丢弃");
  assert.equal(model.totalText, "91+", "有一类只是下限，合计也只是下限");
  assert.equal(model.badge, "近 14 天 91+ 次 · 4 类", "窗口内没发生过的那一类不算进徽标");
  assert.equal(model.sinceText, "9.3");
  assert.equal(model.keepPerType, 50);
  assert.deepEqual(model.rows.map((row) => row.expanded), [false, true, false, false, false]);

  const [claude, codex, disk, tunnel, stale] = model.rows;
  assert.equal(claude.title, "Claude CodeWing · 降级");
  assert.equal(claude.serverLabel, "主集群");
  assert.equal(claude.severityLabel, "警告");
  assert.equal(claude.countText, "39");
  assert.equal(claude.countTitle, "");
  assert.equal(claude.lastText, "10:12", "今天的只写时刻");
  assert.equal(claude.lastAgo, "28 分钟前");
  assert.equal(claude.lastTitle, "2026-09-05 10:12:00（北京时间）");
  assert.equal(claude.durationMain, "中位 1 分");
  assert.equal(claude.durationSub, "最长 18 分");
  assert.equal(claude.durationTitle, "中位 1 分 2 秒 · 最长 18 分 4 秒（留存的最近 39 条记录）");
  assert.equal(claude.cells.length, 14);
  assert.deepEqual(claude.cells[0], { day: "2026-08-23", heat: "none", title: "8.23 · 无记录（9.3 起才逐日计数）" }, "计数起点之前又没有记录的日子不画成 0");
  assert.deepEqual(claude.cells.slice(-4).map((cell) => cell.heat), ["4", "4", "4", "4"]);
  assert.equal(claude.cells.at(-1).title, "9.5 · 8 条");
  assert.equal(claude.stripLabel, "近 14 天每天处于发生中的条数：9.2 9 条、9.3 12 条、9.4 10 条、9.5 8 条");
  assert.deepEqual(claude.recent[0], {
    incidentId: "r-1", whenText: "9.5 10:12 – 10:13", durationText: "持续 1 分 44 秒", occurrencesText: "期间检测到 3 次", operationId: "",
  });
  assert.equal(claude.recent[1].whenText, "9.4 23:40 – 9.5 00:10", "跨天的恢复时刻带日期");
  assert.equal(claude.recent[1].operationId, "op-9");
  assert.equal(claude.moreCount, 37);

  assert.equal(codex.countText, "50+");
  assert.equal(codex.countTitle, "9.3 之前的记录已清理（每类只留最近 50 条），实际次数不少于这个数");
  assert.deepEqual(codex.cells[10], { day: "2026-09-02", heat: "none", title: "9.2 · 记录已清理（每类只留最近 50 条）" });
  assert.ok(codex.cells.slice(0, 11).every((cell) => cell.heat === "none"), "边界之前画成已清理，不是 0");
  assert.deepEqual(codex.cells[11], { day: "2026-09-03", heat: "4", title: "9.3 · 至少 20 条（当天更早的记录已清理）" });
  assert.equal(codex.cells[12].title, "9.4 · 18 条");
  assert.equal(codex.stripLabel, "近 14 天每天处于发生中的条数：9.3 20 条、9.4 18 条、9.5 12 条；9.3 之前的记录已清理");
  assert.equal(codex.moreCount, 42);

  assert.equal(disk.title, "磁盘 · 用量超过阈值");
  assert.equal(disk.severityClass, "sev-error");
  assert.equal(disk.durationMain, "持续 28 天", "持续型事件不写中位 / 最长");
  assert.equal(disk.durationSub, "");
  assert.equal(disk.durationTitle, "持续 28 天 3 小时");
  assert.ok(disk.cells.every((cell) => cell.heat === "1"));
  assert.equal(disk.recent[0].occurrencesText, "", "持续型事件的采样次数没有意义，不显示");
  assert.equal(disk.recent[0].whenText, "8.8 06:40 – 9.5 09:40");
  assert.equal(disk.moreCount, 0);

  assert.equal(tunnel.title, "隧道 · 连接断开");
  assert.equal(tunnel.serverLabel, "阿里云");
  assert.equal(tunnel.lastText, "9.4 14:40", "不是今天的带日期");
  assert.equal(tunnel.lastAgo, "20 小时前");
  assert.equal(tunnel.durationMain, "11 分", "只有一条就写它的时长");
  assert.equal(tunnel.durationSub, "");

  assert.equal(stale.title, "proxy · PROXY_DOWN", "未登记的组件 / 原因原样显示");
  assert.equal(stale.serverLabel, "全局");
  assert.equal(stale.countText, "0");
  assert.equal(stale.durationMain, "—");
  assert.equal(stale.stripLabel, "近 14 天每天处于发生中的条数：没有");
  assert.deepEqual(stale.recent, []);
});

test("汇总模型: 持续时长——多条持续型取最长一次；多条普通事件写中位与最长", () => {
  const type = (extra) => ({ key: "k", component: "filesystem", reasonCode: "DISK_THRESHOLD", perDay: [], recent: [], ...extra });
  const [many] = buildIncidentSummaryModel({ days: DAYS, types: [type({ medianMs: 2 * DAY, longestMs: 9 * DAY + 5 * HOUR, samples: 3 })] }, { nowMs: NOW }).rows;
  assert.equal(many.durationMain, "持续 9 天");
  assert.equal(many.durationTitle, "最长一次持续 9 天 5 小时（留存的 3 条记录）");
  // 旧后端没有 samples 字段：有时长就当成一条。
  const [legacy] = buildIncidentSummaryModel({ days: DAYS, types: [type({ reasonCode: "TUNNEL_DOWN", component: "tunnel", medianMs: 90_000, longestMs: 90_000 })] }, { nowMs: NOW }).rows;
  assert.equal(legacy.durationMain, "2 分");
  assert.equal(legacy.durationTitle, "持续 1 分 30 秒");
});

test("汇总模型: 空载荷 / 缺字段 / 畸形日期整层降级，不抛错", () => {
  for (const bad of [null, undefined, {}, { types: "junk" }, { types: [], days: "junk" }, 42]) {
    const model = buildIncidentSummaryModel(bad, { nowMs: NOW });
    assert.equal(model.ready, false);
    assert.deepEqual(model.rows, []);
    assert.equal(model.empty, true);
  }
  const empty = buildIncidentSummaryModel({ days: DAYS, types: [] }, { nowMs: NOW });
  assert.equal(empty.ready, true);
  assert.equal(empty.badge, "已恢复 0");
  const odd = buildIncidentSummaryModel({
    days: [...DAYS.slice(-2), "nonsense", 7],
    keepPerType: "x",
    types: [{ key: "k", component: "tunnel", reasonCode: "TUNNEL_DOWN", count: "many", coverageStart: "bad", capped: true, perDay: ["x", -3], lastSeenAt: "soon", recent: [null, { incidentId: "" }, { incidentId: "ok" }], retained: "lots" }],
  }, { nowMs: NOW, expanded: "not-a-set" });
  assert.equal(odd.windowDays, 2);
  const [row] = odd.rows;
  assert.equal(row.count, 0);
  assert.equal(row.countText, "0+", "后端说只是下限但没给边界：照样标出来");
  assert.equal(row.countTitle, "更早的记录已清理（每类只留最近 50 条），实际次数不少于这个数");
  assert.deepEqual(row.cells.map((cell) => cell.heat), ["0", "0"]);
  assert.equal(row.stripLabel, "近 2 天每天处于发生中的条数：没有");
  assert.equal(row.lastText, "—");
  assert.equal(row.expanded, false);
  assert.deepEqual(row.recent, [{ incidentId: "ok", whenText: "—", durationText: "", occurrencesText: "", operationId: "" }]);
  // 超出日期范围的时间戳当作没有，不画成 NaN。
  const [wild] = buildIncidentSummaryModel({
    days: DAYS, countingSince: 1e20,
    types: [{ key: "k", component: "tunnel", reasonCode: "TUNNEL_DOWN", lastSeenAt: 1e20, recent: [{ incidentId: "x", firstSeenAt: -1e20, resolvedAt: 1e20 }] }],
  }, { nowMs: NOW }).rows;
  assert.equal(wild.lastText, "—");
  assert.equal(wild.recent[0].whenText, "—");
  assert.equal(buildIncidentListModel({ incidents: [{ incidentId: "x", firstSeenAt: 1e20, lifecycle: "resolved", resolvedAt: -1e20 }] }, { nowMs: NOW }).items[0].firstSeenText, "—");
  assert.equal(row.retained, 1);
});

test("汇总表格: 列头、行首展开按钮、逐日分布格、图例；展开的行列出逐条记录与入口", () => {
  const expanded = new Set([CLAUDE_KEY]);
  const model = buildIncidentSummaryModel(summaryPayload, { nowMs: NOW, status: STATUS, expanded });
  const html = incidentSummaryHtml(model, { withViewOps: true });
  assert.deepEqual([...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]), ["类型", "服务器", "次数", "最近一次", "典型持续", "近 14 天"]);
  assert.equal(html.match(/<tr class="ev-row /g).length, 5);
  assert.equal(html.match(/<tr class="ev-child"/g).length, 5);
  assert.equal(html.match(/<i data-heat="[^"]+" title=/g).length, 5 * 14, "每行每天一格");
  assert.match(html, /<span class="ev-strip" role="img" aria-label="近 14 天每天处于发生中的条数：9\.3 20 条、9\.4 18 条、9\.5 12 条；9\.3 之前的记录已清理">/);
  assert.match(html, /<span class="ev-title">Claude CodeWing · 降级<\/span>/);
  assert.match(html, /<td class="ev-num" title="9\.3 之前的记录已清理（每类只留最近 50 条），实际次数不少于这个数">50\+<\/td>/);
  assert.match(html, /<td class="ev-num is-zero">0<\/td>/);
  assert.match(html, /<span class="ev-main">10:12<\/span> <span class="ev-sub">· 28 分钟前<\/span>/, "次要后缀单独成段，窄窗可以整体收起");
  assert.match(html, /<span class="ev-main">中位 1 分<\/span> <span class="ev-sub">· 最长 18 分<\/span>/);
  assert.match(html, /<span class="ev-main">持续 28 天<\/span><\/td>/);

  // 展开的那一行：按钮与行状态一致，子行可见并列出逐条；其余子行隐藏且不带内容。
  const openRow = html.slice(html.indexOf(`data-type-key="${CLAUDE_KEY}"`), html.indexOf(`data-type-key="${CODEX_KEY}"`));
  assert.match(openRow, /data-open="true"/);
  assert.match(openRow, /aria-expanded="true" aria-controls="incidentTypeDetail-0"/);
  assert.match(openRow, /<tr class="ev-child" id="incidentTypeDetail-0">/);
  assert.match(openRow, /<span class="ev-when">9\.5 10:12 – 10:13<\/span><span>持续 1 分 44 秒<\/span><span>期间检测到 3 次<\/span><\/li>/, "没有关联处置的记录不给日志入口");
  assert.match(openRow, /<button type="button" class="text-btn" data-view-ops="op-9">相关日志<\/button>/);
  assert.match(openRow, /还有 37 条更早的记录<\/span><button type="button" class="text-btn" data-view-type="server-01\|agent:claude-codewing\|DEGRADED">查看这一类留存的全部 39 条<\/button>/);
  const closedRow = html.slice(html.indexOf(`data-type-key="${CODEX_KEY}"`));
  assert.match(closedRow, /aria-expanded="false" aria-controls="incidentTypeDetail-1"/);
  assert.match(closedRow, /<tr class="ev-child" id="incidentTypeDetail-1" hidden>\s*<td colspan="6"><\/td>/);

  // 图例：有已清理的日子才出现斜纹说明；口径写在右侧。
  assert.match(html, /<i data-heat="none"><\/i><\/span><span title="每类只留最近 50 条逐条记录，更早的已清理；9\.3 起另记每天的次数，不再受这个上限影响">记录已清理<\/span>/);
  assert.match(html, /次数按近 14 天统计 · 逐条记录每类最多保留最近 50 条/);
  assert.doesNotMatch(html, /…/, "不靠省略号");

  // 没有打开日志的能力时不出按钮；没有已清理的日子时图例不带斜纹。
  assert.doesNotMatch(incidentSummaryHtml(model), /data-view-ops/);
  const exact = buildIncidentSummaryModel({ ...summaryPayload, capped: false, types: [summaryPayload.types[0]] }, { nowMs: NOW, status: STATUS });
  assert.doesNotMatch(incidentSummaryHtml(exact), /记录已清理/);
  assert.equal(exact.badge, "近 14 天 91 次 · 1 类");
});

test("汇总表格: 逐条记录已清理的类型展开后如实说明；没有任何类型时给空态；名字里的特殊字符转义", () => {
  const stale = buildIncidentSummaryModel(summaryPayload, { nowMs: NOW, status: STATUS, expanded: new Set(["global|proxy|PROXY_DOWN"]) });
  assert.match(incidentSummaryHtml(stale), /<p class="ev-more">这一类的逐条记录已清理，只留下每天的次数。<\/p>/);
  // 没有任何类型：空状态写真实的统计窗口与每类留存条数（都来自接口，不写死）。
  const none = incidentSummaryHtml(buildIncidentSummaryModel({ days: DAYS, keepPerType: 50, types: [] }, { nowMs: NOW }));
  assert.match(none, /^<div class="empty-state" data-tone="neutral">/);
  assert.match(none, /<p class="empty-state-title">还没有已恢复的事件<\/p>/);
  assert.match(none, new RegExp(`按类型汇总近 ${DAYS.length} 天的次数、最近一次和典型持续时长；每类保留最近 50 条逐条记录。`));
  assert.doesNotMatch(none, /暂无/);
  const hostile = {
    serversBrief: { "server-01": { displayName: '<img src=x onerror="1">' } },
    agents: [{ id: "codex", name: "<b>Codex</b>" }],
  };
  const html = incidentSummaryHtml(buildIncidentSummaryModel({
    days: DAYS,
    types: [{ ...summaryPayload.types[1], key: 'k"><script>', recent: [recentItem("x", NOW - HOUR, MIN, { operationId: '"><i>' })] }],
  }, { nowMs: NOW, status: hostile, expanded: new Set(['k"><script>']) }), { withViewOps: true });
  assert.doesNotMatch(html, /<script>|<b>|<img|"><i>/);
  assert.match(html, /&lt;b&gt;Codex&lt;\/b&gt; · 降级/);
});

test("事件空状态：未解决为 0 是好消息（绿、无主按钮、给去「已恢复」的入口）；已恢复为空 / 只看一类为空各有说明；汇总取不到给「改看逐条」", () => {
  const open = incidentListEmptyHtml("open");
  assert.match(open, /data-tone="ok"/);
  assert.match(open, /<p class="empty-state-title">没有未解决的事件<\/p>/);
  assert.match(open, /连接链路（隧道、端口、本地代理）、Agent 或磁盘出现异常时/);
  assert.match(open, /<button type="button" class="btn btn-secondary" data-show-resolved="">查看已恢复事件<\/button>/);
  assert.doesNotMatch(open, /btn-primary/, "好消息不放主按钮");

  const resolved = incidentListEmptyHtml("resolved");
  assert.match(resolved, /data-tone="neutral"/);
  assert.match(resolved, /还没有已恢复的事件/);
  assert.match(resolved, /恢复后会归档到这里/);
  assert.doesNotMatch(resolved, /<button/);
  assert.match(incidentListEmptyHtml("resolved", { filtered: true }), /这一类没有留存的逐条记录/);

  assert.equal(incidentSummaryPlaceholderHtml(), '<p class="incidents-empty">正在加载事件…</p>', "还在加载不是空状态");
  const failed = incidentSummaryPlaceholderHtml({ failed: true });
  assert.match(failed, /data-tone="error"/);
  assert.match(failed, /<p class="empty-state-title">暂时取不到按类型汇总<\/p>/);
  assert.match(failed, /<button type="button" class="text-btn" data-show-each="">改看逐条<\/button>/);
});
