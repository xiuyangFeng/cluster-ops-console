import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fakeDialog, fakeDocument, fakeElement } from "./app/test-support.mjs";
// 模块可在 Node 导入本身即是回归验证（惰性 getEl 模式，无顶层 document 引用）。
import { ALERT_THRESHOLDS } from "./thresholds.js";
import {
  FLAT_LIMIT,
  buildAttentionItems,
  extractDiskCapacity,
  updateCpuStreaks,
  renderAttentionQueue,
  actionHtml,
  initAttentionQueue,
  diskIncidentsByServer,
  itemHtml,
} from "./render/attention.js";

const healthyBrief = { ok: true, cpu: 10, ram: 20, disk: 30, displayName: "myserver", name: "srv", output: "" };

const baseStatus = {
  health: "ready",
  shouldBeRunning: true,
  supervisorUp: true,
  localProxyUp: true,
  tunnelUp: true,
  remotePortOpen: true,
  updatedAt: "2026-08-30T10:00:00.000Z",
  doctor: { summary: { ok: 5, fail: 0, warn: 0, notes: 0, raw: "5 ok" } },
  serversBrief: { "server-01": { ...healthyBrief } },
};

const withBrief = (brief, extra = {}) => ({
  ...baseStatus,
  ...extra,
  serversBrief: { "server-01": { ...healthyBrief, ...brief } },
});

test("全部健康: 无告警条目", () => {
  assert.deepEqual(buildAttentionItems(baseStatus), []);
});

test("磁盘阈值: ≥95 严重 / ≥90 警告 / <90 无", () => {
  assert.equal(buildAttentionItems(withBrief({ disk: 95 }))[0].severity, "critical");
  assert.equal(buildAttentionItems(withBrief({ disk: 90 }))[0].severity, "warn");
  assert.deepEqual(buildAttentionItems(withBrief({ disk: 89 })), []);
});

test("磁盘告警文案: 含服务器名/百分比,容量文本取自 output 的 df 行", () => {
  const items = buildAttentionItems(withBrief({
    disk: 99,
    output: "myserver\n 10:00:00 up 5 days\nMem: 31G 20G\n/dev/sda1  44T  41T  2.2T  95% /home",
  }));
  assert.equal(items[0].text, "myserver 磁盘 99% (41T/44T)");
});

test("extractDiskCapacity: 无 df 行时返回空串", () => {
  assert.equal(extractDiskCapacity("hostname only"), "");
  assert.equal(extractDiskCapacity(""), "");
});

test("内存阈值: ≥92 警告", () => {
  const items = buildAttentionItems(withBrief({ ram: 92 }));
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, "warn");
  assert.match(items[0].text, /内存 92%/);
});

test("CPU 需连续两帧越线才告警(削抖)", () => {
  // 第一帧越线：streak=1，不告警
  assert.deepEqual(buildAttentionItems(withBrief({ cpu: 100 }), { "server-01": 1 }), []);
  // 连续两帧：告警
  const items = buildAttentionItems(withBrief({ cpu: 100 }), { "server-01": 2 });
  assert.equal(items.length, 1);
  assert.match(items[0].text, /CPU 100%/);
});

// v2.62：内存 / CPU 两条带上占用现场那一句（layers.resources[id].procTop，与服务器页资源面板同一份数据）。
test("内存 / CPU 告警：悬停提示里带上占用现场那一句；没采到就不带，条目正文与条数都不变", () => {
  const GiBkb = 1024 * 1024;
  const procTop = {
    sampled: 40,
    slurm: true,
    users: [
      { user: "kai", cpuJobPct: 1449, cpuOtherPct: 0, rssJobKb: 126 * GiBkb, rssOtherKb: 0, procsJob: 12, procsOther: 0 },
      { user: "lin", cpuJobPct: 0, cpuOtherPct: 554, rssJobKb: 0, rssOtherKb: 67 * GiBkb, procsJob: 0, procsOther: 6 },
    ],
  };
  const hot = { ram: ALERT_THRESHOLDS.ramWarn, cpu: ALERT_THRESHOLDS.cpuWarn, disk: ALERT_THRESHOLDS.diskWarn };
  const streaks = { "server-01": ALERT_THRESHOLDS.cpuStreakFrames };
  const plain = buildAttentionItems(withBrief(hot), streaks);
  assert.deepEqual(plain.map((i) => [i.text, "detail" in i]), [
    ["myserver 磁盘 90%", false], ["myserver 内存 92%", false], ["myserver CPU 95% 持续高位", false],
  ], "没有占用数据（旧采集脚本）：与以前一样");

  const items = buildAttentionItems(withBrief(hot, { layers: { resources: { "server-01": { procTop } } } }), streaks);
  assert.deepEqual(items.map((i) => i.text), plain.map((i) => i.text), "正文不变、不多出条目");
  assert.equal(items[0].detail, undefined, "磁盘那条不带");
  // 与服务器页资源面板那一行是同一句（buildOccupancy 一处生成）：按占用从大到小，只给不经 Slurm 的挂标注
  assert.equal(items[1].detail, "占用：kai 126 GiB · lin 67 GiB（不经 Slurm）");
  assert.equal(items[2].detail, "占用：kai 1449% · lin 554%（不经 Slurm）");
  // 别的服务器的占用数据不串到这台
  const other = buildAttentionItems(withBrief(hot, { layers: { resources: { "server-02": { procTop } } } }), streaks);
  assert.equal(other.some((i) => "detail" in i), false);

  const html = itemHtml(items[2]);
  assert.match(html, /<span class="attention-text" title="占用：kai 1449% · lin 554%（不经 Slurm）">myserver CPU 95% 持续高位<\/span>/);
  assert.match(itemHtml(plain[2]), /<span class="attention-text">myserver CPU 95% 持续高位<\/span>/, "没有就不写 title 属性");
  assert.doesNotMatch(itemHtml({ severity: "warn", kind: "metric", text: "x", detail: '"><img src=x>' }), /<img/);
});

test("updateCpuStreaks: 按 updatedAt 去重计帧,回落归零", () => {
  const streaks = {};
  updateCpuStreaks(withBrief({ cpu: 100 }, { updatedAt: "t1" }), streaks);
  assert.equal(streaks["server-01"], 1);
  // 同一帧重复渲染不重复计数
  updateCpuStreaks(withBrief({ cpu: 100 }, { updatedAt: "t1" }), streaks);
  assert.equal(streaks["server-01"], 1);
  updateCpuStreaks(withBrief({ cpu: 100 }, { updatedAt: "t2" }), streaks);
  assert.equal(streaks["server-01"], 2);
  updateCpuStreaks(withBrief({ cpu: 10 }, { updatedAt: "t3" }), streaks);
  assert.equal(streaks["server-01"], 0);
});

test("离线服务器(ok=false)不参与指标推导", () => {
  assert.deepEqual(buildAttentionItems(withBrief({ ok: false, disk: 99 })), []);
});

test("Doctor 告警: 仅 fail 进队列，warn 是建议级不进（避免无害提示常驻黄条）", () => {
  const fail = buildAttentionItems({ ...baseStatus, doctor: { summary: { ok: 3, fail: 2, warn: 0, notes: 0, raw: "x" } } });
  assert.equal(fail[0].severity, "critical");
  assert.match(fail[0].text, /2 项失败/);
  const warn = buildAttentionItems({ ...baseStatus, doctor: { summary: { ok: 3, fail: 0, warn: 1, notes: 0, raw: "x" } } });
  assert.equal(warn.filter((it) => it.kind === "doctor").length, 0);
});

test("按严重度排序: critical 前置,同级保持推导顺序", () => {
  const status = {
    ...baseStatus,
    doctor: { summary: { ok: 0, fail: 1, warn: 0, notes: 0, raw: "x" } },
    serversBrief: {
      "server-01": { ...healthyBrief, displayName: "A", ram: 93 },
      "server-02": { ...healthyBrief, displayName: "B", disk: 96 },
    },
  };
  const items = buildAttentionItems(status);
  assert.deepEqual(items.map((it) => it.severity), ["critical", "critical", "warn"]);
  assert.match(items[0].text, /B 磁盘/); // 推导顺序: server-02 磁盘严重在 doctor 之前
  assert.match(items[1].text, /Doctor/);
  assert.match(items[2].text, /A 内存/);
});

test("告警阈值（thresholds.js ALERT_THRESHOLDS）与平铺上限", () => {
  assert.equal(ALERT_THRESHOLDS.diskWarn, 90);
  assert.equal(ALERT_THRESHOLDS.diskCrit, 95);
  assert.equal(ALERT_THRESHOLDS.ramWarn, 92);
  assert.equal(ALERT_THRESHOLDS.cpuWarn, 95);
  assert.equal(ALERT_THRESHOLDS.cpuStreakFrames, 2);
  assert.equal(FLAT_LIMIT, 3);
});

test("Node 环境: renderAttentionQueue 无 DOM 时安全空转并返回 topItem", () => {
  let out = null;
  assert.doesNotThrow(() => { out = renderAttentionQueue({ ...baseStatus, health: "down", localProxyUp: false }); });
  // 通道 down 时 topItem 为通道条(critical)
  assert.equal(out.topItem.severity, "critical");
  assert.equal(out.topItem.kind, "channel");
});

// ---- v2.18 新增三类条目：次要隧道断开 / 自动修复已达上限 / 反向端口被异己占用 ----

const tunnelDownLayers = (...ids) => ({ tunnels: Object.fromEntries(ids.map((id) => [id, { level: "error", tunnelUp: false }])) });

test("tunnel-secondary: 次要隧道断开 → warn，且明示不影响主链路", () => {
  const items = buildAttentionItems({
    ...baseStatus,
    activeServerId: "server-01",
    layers: tunnelDownLayers("server-02"),
    serversBrief: {
      "server-01": { ...healthyBrief },
      "server-02": { ...healthyBrief, displayName: "腾讯云" },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tunnel-secondary");
  assert.equal(items[0].severity, "warn");
  assert.equal(items[0].serverId, "server-02");
  assert.equal(items[0].text, "腾讯云 隧道断开 · 不影响主链路");
});

test("tunnel-secondary: 无 serversBrief 名字时回落 serverId", () => {
  const items = buildAttentionItems({ ...baseStatus, layers: tunnelDownLayers("server-09") });
  assert.equal(items[0].text, "server-09 隧道断开 · 不影响主链路");
});

test("tunnel-secondary: 字段缺失时按空处理（不产生条目）", () => {
  assert.deepEqual(buildAttentionItems({ ...baseStatus }), []);
  assert.deepEqual(buildAttentionItems({ ...baseStatus, layers: { tunnels: null } }), []);
  assert.deepEqual(buildAttentionItems({ ...baseStatus, layers: { tunnels: "server-02" } }), []);
});

test("tunnel-secondary: 从 layers.tunnels 的 error 项推导（活跃服务器除外）", () => {
  const items = buildAttentionItems({
    ...baseStatus,
    activeServerId: "server-01",
    layers: {
      tunnels: {
        "server-01": { level: "error", tunnelUp: false },
        "server-02": { level: "error", tunnelUp: false },
        "server-03": { level: "ok", tunnelUp: true },
        "server-04": { level: "skipped" },
      },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].serverId, "server-02");
});

test("auto-repair-exhausted: critical 且置顶（排在其它 critical 之前）", () => {
  const items = buildAttentionItems({
    ...baseStatus,
    autoRepairExhausted: true,
    doctor: { summary: { ok: 1, fail: 2, warn: 0, notes: 0, raw: "" } },
    serversBrief: { "server-01": { ...healthyBrief, disk: 99 } },
  });
  assert.equal(items[0].kind, "auto-repair-exhausted");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].text, "自动修复已达上限，需人工处理");
  // 其余 critical 仍在，只是排在后面
  assert.ok(items.slice(1).some((i) => i.kind === "doctor"));
  assert.ok(items.slice(1).some((i) => i.kind === "metric"));
});

test("auto-repair-exhausted: 非 true 一律不出条目", () => {
  assert.deepEqual(buildAttentionItems({ ...baseStatus, autoRepairExhausted: false }), []);
  assert.deepEqual(buildAttentionItems({ ...baseStatus, autoRepairExhausted: 0 }), []);
  assert.deepEqual(buildAttentionItems({ ...baseStatus, autoRepairExhausted: undefined }), []);
});

test("tunnel-port-foreign: 反向端口被异己占用 → warn，文案给出处置方向", () => {
  const items = buildAttentionItems({
    ...baseStatus,
    tunnelPortForeign: ["server-02"],
    serversBrief: {
      "server-01": { ...healthyBrief },
      "server-02": { ...healthyBrief, displayName: "阿里云" },
    },
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "tunnel-port-foreign");
  assert.equal(items[0].severity, "warn");
  assert.equal(items[0].serverId, "server-02");
  assert.equal(items[0].text, "阿里云 反向端口被其他进程占用，可重新分配一个空闲端口");
  // W5：L2 处置按钮「重新分配端口…」带转义后的 serverId，定位按钮保留
  const html = actionHtml(items[0]);
  assert.match(html, /data-action="reassign-port" data-server-id="server-02"/);
  assert.match(html, /重新分配端口…/);
  assert.match(html, /data-action="locate"/);
  assert.match(actionHtml({ kind: "tunnel-port-foreign", serverId: 'x"<y' }), /data-server-id="x&quot;&lt;y"/);
});

test("tunnel-port-foreign: 字段缺失按空处理", () => {
  assert.deepEqual(buildAttentionItems({ ...baseStatus, tunnelPortForeign: undefined }), []);
  assert.deepEqual(buildAttentionItems({ ...baseStatus, tunnelPortForeign: {} }), []);
});

// ---- ReClaude 远端动作已移除：后端即使带了旧字段也不再产生"修复…"条目 ----

test("remoteActions 字段不再产生注意力条目（ReClaude 重启与写配置改为手动）", () => {
  const legacy = { id: "reclaude-dropin-restore", label: "写回 ReClaude 代理 drop-in 并重启", reason: "drop-in 内容漂移" };
  assert.deepEqual(buildAttentionItems({ ...baseStatus, remoteActions: { suggestions: [legacy] } }), []);
  assert.match(actionHtml({ kind: "metric" }), /data-action="locate"/);
  assert.match(actionHtml({ kind: "auto-repair-exhausted" }), /data-action="logs"/);
  assert.match(actionHtml({ kind: "doctor" }), /data-action="doctor"/);
});

test("Node 环境: initAttentionQueue + renderAttentionQueue 无 DOM 时安全空转", () => {
  assert.doesNotThrow(() => initAttentionQueue({ onReassignPort: () => {} }));
  assert.doesNotThrow(() => initAttentionQueue());
  let out = null;
  assert.doesNotThrow(() => {
    out = renderAttentionQueue({ ...baseStatus, autoRepairExhausted: true });
  });
  assert.equal(out.topItem.kind, "auto-repair-exhausted");
  assert.equal(out.items.length, 1);
});

// 回归：「查看详情」「查看日志」曾直接 dlg.showModal()，绕过 app/dialogs.openDialog 的打开钩子
// （dlgDoctor 的补渲、dlgLogs 的拉取都不跑，浮层打开时是旧内容）。现在必须经注入的 onOpenDialog。
test("行动按钮: 查看详情 / 查看日志经 onOpenDialog 打开浮层（走 openDialog 钩子），不直接 showModal", async () => {
  const itemsEl = fakeElement();
  const dlgDoctor = fakeDialog();
  const dlgLogs = fakeDialog();
  const saved = globalThis.document;
  globalThis.document = fakeDocument({ attentionItems: itemsEl, dlgDoctor, dlgLogs });
  try {
    const opened = [];
    initAttentionQueue({ onOpenDialog: (id) => opened.push(id) });
    renderAttentionQueue({ ...baseStatus, autoRepairExhausted: true });
    await itemsEl.dispatch("click", { target: fakeElement({ dataset: { action: "doctor" }, parent: itemsEl }) });
    await itemsEl.dispatch("click", { target: fakeElement({ dataset: { action: "logs" }, parent: itemsEl }) });
    assert.deepEqual(opened, ["dlgDoctor", "dlgLogs"]);
    assert.equal(dlgDoctor.showCount, undefined, "不得绕过 openDialog 直接 showModal");
    assert.equal(dlgLogs.showCount, undefined);
  } finally {
    globalThis.document = saved;
    initAttentionQueue();
  }
});

test("接线: app.js 把 dialogs.openDialog 注入注意力队列", () => {
  const src = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.match(src, /initAttentionQueue\(\{[^}]*onOpenDialog: dialogs\.openDialog/);
});

// ---- 磁盘告警「已知晓」：确认对应事件后不再常驻黄条 ----
const diskIncident = (attention = {}) => ({
  incidentId: "inc-disk", serverId: "server-01", reasonCode: "DISK_THRESHOLD", lifecycle: "open",
  attention: { acknowledgedAt: null, snoozedUntil: null, ...attention },
});

test("磁盘告警: 有未确认事件时条目带 incidentId，按钮含「已知晓」+「定位」", () => {
  const map = diskIncidentsByServer([diskIncident()]);
  const items = buildAttentionItems(withBrief({ disk: 92 }), {}, map);
  assert.equal(items.length, 1);
  assert.equal(items[0].incidentId, "inc-disk");
  const html = actionHtml(items[0]);
  assert.match(html, /data-action="ack-incident" data-incident-id="inc-disk"[^>]*>已知晓</);
  assert.match(html, /data-action="locate"/);
});

test("磁盘告警: 事件已确认或稍后提醒中 → 条目不进队列；没有事件时照常告警（只有定位）", () => {
  const acked = diskIncidentsByServer([diskIncident({ acknowledgedAt: 1 })]);
  assert.deepEqual(buildAttentionItems(withBrief({ disk: 96 }), {}, acked), []);
  const now = Date.now();
  const snoozed = diskIncidentsByServer([diskIncident({ snoozedUntil: now + 60_000 })], now);
  assert.deepEqual(buildAttentionItems(withBrief({ disk: 92 }), {}, snoozed), []);
  const expired = diskIncidentsByServer([diskIncident({ snoozedUntil: now - 1 })], now);
  assert.equal(buildAttentionItems(withBrief({ disk: 92 }), {}, expired).length, 1);
  const none = buildAttentionItems(withBrief({ disk: 92 }), {}, {});
  assert.equal(none.length, 1);
  assert.equal(none[0].incidentId, undefined);
  assert.doesNotMatch(actionHtml(none[0]), /ack-incident/);
});

test("diskIncidentsByServer: 只认未解决的 DISK_THRESHOLD，畸形输入按空处理", () => {
  assert.deepEqual(diskIncidentsByServer(null), {});
  assert.deepEqual(diskIncidentsByServer([{ reasonCode: "TUNNEL_DOWN", serverId: "s", incidentId: "x" }]), {});
  assert.deepEqual(diskIncidentsByServer([{ ...diskIncident(), lifecycle: "resolved" }]), {});
});

test("通道条: 全部正常时隐藏「连接正常」（与页头重复），异常 / 等待时显示", () => {
  const itemsEl = fakeElement();
  const banner = fakeElement();
  const saved = globalThis.document;
  globalThis.document = fakeDocument({ attentionItems: itemsEl, alertBanner: banner });
  try {
    renderAttentionQueue({ ...baseStatus, health: "ready" });
    assert.equal(banner.style.display, "none");
    renderAttentionQueue({ ...baseStatus, health: "degraded", supervisorUp: false });
    assert.equal(banner.style.display, "");
    assert.equal(banner.style.order, "0");
    renderAttentionQueue({ ...baseStatus, health: "waiting" });
    assert.equal(banner.style.display, "");
  } finally {
    globalThis.document = saved;
  }
});

test("接线: 事件列表注入注意力队列，「已知晓」走事件确认", () => {
  const src = readFileSync(new URL("../../app.js", import.meta.url), "utf8");
  assert.match(src, /onOpenIncidents: \(open\) => \{\s*setAttentionIncidents\(open\?\.incidents\);\s*galaxyStage\.updateEvents\(open\);\s*\}/);
  assert.match(src, /onAcknowledgeIncident: \(incidentId\) => incidents\.setAttention\(incidentId, "acknowledge"\)/);
});
