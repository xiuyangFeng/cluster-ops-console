import assert from "node:assert/strict";
import test from "node:test";
// 模块可在 Node 导入本身即是回归验证（惰性 getEl 模式，无顶层 document 引用）。
import {
  REPAIR_STEPS,
  RUNBOOK_TIMEOUT_MS,
  mapLogToStep,
  createRunbookMachine,
  buildRunbookItemHtml,
  buildPreviewStepsHtml,
  parseRunResult,
  buildActionPreviewHtml,
  buildPreviewExpireText,
  requestScopedRestart,
  handleRunbookLog,
  initRepairRunbook,
} from "./render/repair-runbook.js";

// ---- 步骤映射规则 ----

test("mapLogToStep: restart 全链路实际日志按关键词落到对应步骤", () => {
  // stopChannel 阶段（channel-lifecycle.mjs 实际消息）
  assert.equal(mapLogToStep("stop requested"), 0);
  assert.equal(mapLogToStep("stop completed"), 0);
  assert.equal(mapLogToStep("stop tunnel: fallback kill pid 123"), 0);
  // startChannel 阶段
  assert.equal(mapLogToStep("auto starting channel supervisor"), 1);
  assert.equal(mapLogToStep("start: channel supervisor already running, skipping duplicate spawn"), 1);
  // 隧道/代理与探活（supervisor 侧或中文消息）
  assert.equal(mapLogToStep("ssh tunnel reconnected"), 2);
  assert.equal(mapLogToStep("本地代理已拉起"), 2);
  // 旧文案：primary-remote 已在 v2.18 随零残留采集注销，但轮转日志里还留着这类行，
  // 回看历史 operation 时仍要能正确映射，所以这条断言保留。
  assert.equal(mapLogToStep("probe primary-remote forced"), 3);
  assert.equal(mapLogToStep("探活验证通过"), 3);
  // v2.18 现行文案：channel-lifecycle.startChannel 实际写的那一行（整串一条日志），
  // 以及拆开看的三个探针 id 单独出现时也都落在"探活验证"。
  assert.equal(mapLogToStep("probe processes / log-signals / collect:slow:server-01 forced"), 3);
  assert.equal(mapLogToStep("probe log-signals forced"), 3);
  assert.equal(mapLogToStep("probe collect:slow:server-tengxun forced"), 3);
});

test("mapLogToStep: 中文关键词与英文等效", () => {
  assert.equal(mapLogToStep("正在停止残留进程"), 0);
  assert.equal(mapLogToStep("守护进程已拉起"), 1);
  assert.equal(mapLogToStep("重建 SSH 隧道"), 2);
});

test("mapLogToStep: 声明顺序优先——'stop channel-supervisor' 属停止阶段而非守护阶段", () => {
  assert.equal(mapLogToStep("stop channel-supervisor: stopped"), 0);
  assert.equal(mapLogToStep("stop local-proxy: not-found"), 0);
});

test("mapLogToStep: 映射不到返回 -1（含空值）", () => {
  assert.equal(mapLogToStep("start requested"), -1);
  assert.equal(mapLogToStep("config.json changed on disk"), -1);
  assert.equal(mapLogToStep(""), -1);
  assert.equal(mapLogToStep(null), -1);
  assert.equal(mapLogToStep(undefined), -1);
});

// ---- 状态机：preview → running → success / failed / timeout ----

function makeMachine(overrides = {}) {
  let nowMs = 1_000_000;
  const machine = createRunbookMachine({ now: () => nowMs, ...overrides });
  return { machine, advance: (ms) => { nowMs += ms; }, getNow: () => nowMs };
}

test("状态机: idle → preview → 取消回 idle", () => {
  const { machine } = makeMachine();
  assert.equal(machine.getPhase(), "idle");
  assert.equal(machine.openPreview(), true);
  assert.equal(machine.getPhase(), "preview");
  assert.equal(machine.cancelPreview(), true);
  assert.equal(machine.getPhase(), "idle");
  // 非 preview 态取消是 no-op
  assert.equal(machine.cancelPreview(), false);
});

test("状态机: preview → running → success，步骤全勾", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  assert.equal(machine.start("op-1"), true);
  assert.equal(machine.getPhase(), "running");
  assert.equal(machine.finish(true), true);
  assert.equal(machine.getPhase(), "success");
  const snap = machine.snapshot();
  assert.deepEqual(snap.steps, ["done", "done", "done", "done"]);
});

test("状态机: running → failed，当前步骤标错", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  machine.ingest({ operationId: "op-1", message: "stop requested" });
  assert.equal(machine.finish(false), true);
  assert.equal(machine.getPhase(), "failed");
  assert.deepEqual(machine.snapshot().steps, ["error", "pending", "pending", "pending"]);
});

test("状态机: running 期间不可重复 openPreview/start", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  assert.equal(machine.openPreview(), false);
  assert.equal(machine.start("op-2"), false);
  assert.equal(machine.snapshot().operationId, "op-1");
});

test("状态机: 终态(failed)后可重新 openPreview 开启下一轮", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  machine.finish(false);
  assert.equal(machine.openPreview(), true);
  assert.equal(machine.start("op-2"), true);
  assert.equal(machine.snapshot().logCount, 0);
  assert.deepEqual(machine.snapshot().steps, ["active", "pending", "pending", "pending"]);
});

test("状态机: 120s 超时转 timeout，迟到的 finish 被忽略", () => {
  const { machine, advance } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  advance(RUNBOOK_TIMEOUT_MS - 1);
  assert.equal(machine.checkTimeout(), false);
  assert.equal(machine.getPhase(), "running");
  advance(1);
  assert.equal(machine.checkTimeout(), true);
  assert.equal(machine.getPhase(), "timeout");
  // action promise 之后才 resolve：不得改写终态
  assert.equal(machine.finish(true), false);
  assert.equal(machine.getPhase(), "timeout");
});

test("状态机: 非 running 态 checkTimeout 恒 false", () => {
  const { machine, advance } = makeMachine();
  assert.equal(machine.checkTimeout(), false);
  machine.openPreview();
  machine.start("op-1");
  machine.finish(true);
  advance(RUNBOOK_TIMEOUT_MS * 2);
  assert.equal(machine.checkTimeout(), false);
  assert.equal(machine.getPhase(), "success");
});

test("状态机: elapsed 按 startedAt 起算取整秒", () => {
  const { machine, advance } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  advance(4_400);
  assert.equal(machine.snapshot().elapsed, 4);
});

// ---- operationId 匹配过滤与步骤推进 ----

test("ingest: 仅接收 operationId 精确匹配的条目，兜底计数含未映射行", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  assert.equal(machine.ingest({ operationId: "op-2", message: "stop requested" }), false);
  assert.equal(machine.ingest({ message: "stop requested" }), false);
  assert.equal(machine.ingest(null), false);
  assert.equal(machine.snapshot().logCount, 0);
  assert.equal(machine.ingest({ operationId: "op-1", message: "stop requested" }), true);
  assert.equal(machine.ingest({ operationId: "op-1", message: "start requested" }), true); // 未映射也计数
  assert.equal(machine.snapshot().logCount, 2);
});

test("ingest: 非 running 态一律拒绝", () => {
  const { machine } = makeMachine();
  assert.equal(machine.ingest({ operationId: "op-1", message: "stop requested" }), false);
  machine.openPreview();
  machine.start("op-1");
  machine.finish(true);
  assert.equal(machine.ingest({ operationId: "op-1", message: "probe ok"}), false);
});

test("步骤推进: 触达最高步骤高亮、之前打勾、不回退", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  // 未收到日志前默认步骤1高亮
  assert.deepEqual(machine.snapshot().steps, ["active", "pending", "pending", "pending"]);
  machine.ingest({ operationId: "op-1", message: "stop requested" });
  assert.deepEqual(machine.snapshot().steps, ["active", "pending", "pending", "pending"]);
  machine.ingest({ operationId: "op-1", message: "auto starting channel supervisor" });
  assert.deepEqual(machine.snapshot().steps, ["done", "active", "pending", "pending"]);
  // 晚到的低步骤日志不回退当前高亮
  machine.ingest({ operationId: "op-1", message: "stop completed" });
  assert.deepEqual(machine.snapshot().steps, ["done", "active", "pending", "pending"]);
  machine.ingest({ operationId: "op-1", message: "probe primary-remote ok" });
  assert.deepEqual(machine.snapshot().steps, ["done", "done", "done", "active"]);
});

test("createRunbookMachine: v2.18 现行日志序列也能走完四步（探活验证不再停在第三步）", () => {
  const { machine } = makeMachine();
  machine.start("op-9");
  // 一次真实 /api/restart 会依次产出这些带 operationId 的 ops 日志。
  for (const message of [
    "stop requested",
    "stop channel-supervisor: 已停止",
    "stop local-proxy: 已停止",
    "stop tunnel.server-tengxun: 已停止",
    "start requested",
    "auto starting channel supervisor",
    "probe processes / log-signals / collect:slow:server-01 forced",
    "start completed",
  ]) {
    machine.ingest({ operationId: "op-9", message });
  }
  assert.deepEqual(machine.snapshot().steps, ["done", "done", "done", "active"]);
  machine.finish(true);
  assert.deepEqual(machine.snapshot().steps, ["done", "done", "done", "done"]);
});

// ---- HTML 构建（插值转义与兜底行） ----

test("buildRunbookItemHtml: 兜底行展示日志条数与耗时，idle/preview 不产出", () => {
  const { machine, advance } = makeMachine();
  assert.equal(buildRunbookItemHtml(machine.snapshot()), "");
  machine.openPreview();
  assert.equal(buildRunbookItemHtml(machine.snapshot()), "");
  machine.start("op-1");
  machine.ingest({ operationId: "op-1", message: "stop requested" });
  advance(3_000);
  const html = buildRunbookItemHtml(machine.snapshot());
  assert.match(html, /已产生 1 条操作日志 · 已耗时 3s/);
  assert.match(html, /一键修复执行中/);
  assert.doesNotMatch(html, /data-action="view-logs"/); // running 无失败按钮
});

test("buildRunbookItemHtml: 失败/超时驻留并带查看日志按钮，operationId 经转义", () => {
  const { machine } = makeMachine();
  machine.openPreview();
  machine.start('op-"<script>');
  machine.finish(false);
  const html = buildRunbookItemHtml(machine.snapshot());
  assert.match(html, /data-action="view-logs"/);
  assert.match(html, /data-action="dismiss"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("buildRunbookItemHtml: 超时文案说明仍在后台执行", () => {
  const { machine, advance } = makeMachine();
  machine.openPreview();
  machine.start("op-1");
  advance(RUNBOOK_TIMEOUT_MS);
  machine.checkTimeout();
  const html = buildRunbookItemHtml(machine.snapshot());
  assert.match(html, /120 秒/);
  assert.match(html, /仍在后台执行/);
  assert.match(html, /data-action="view-logs"/);
});

test("buildPreviewStepsHtml: 四步序列与 REPAIR_STEPS 一致", () => {
  const html = buildPreviewStepsHtml();
  assert.equal(REPAIR_STEPS.length, 4);
  for (const step of REPAIR_STEPS) {
    assert.match(html, new RegExp(step.label));
  }
  assert.match(html, /停止残留进程/);
  assert.match(html, /探活验证/);
});

// ---- 可配置步骤表（单隧道重启复用同一状态机）/ result= 收尾 / 操作预览 HTML 转义 ----

const SCOPED_TEST_STEPS = [
  { key: "queued", label: "写入控制信箱" },
  { key: "executing", label: "重启该隧道" },
  { key: "verifying", label: "验证监听与归属" },
];

function phaseMapper(message) {
  const m = /(?:^|\s)phase=([A-Za-z0-9_-]+)(?=\s|$)/.exec(String(message || ""));
  return m ? SCOPED_TEST_STEPS.findIndex((s) => s.key === m[1]) : -1;
}

test("默认 start(opId) 行为不变：kind=restart、stepLabels 等于 REPAIR_STEPS 标签", () => {
  const { machine } = makeMachine();
  machine.start("op-1");
  const snap = machine.snapshot();
  assert.equal(snap.kind, "restart");
  assert.deepEqual(snap.stepLabels, REPAIR_STEPS.map((s) => s.label));
  assert.equal(snap.steps.length, 4);
});

test("parseRunResult: result=ok → true，result=fail → false，其余 null", () => {
  assert.equal(parseRunResult("scoped-restart result=ok"), true);
  assert.equal(parseRunResult("scoped-restart result=fail"), false);
  assert.equal(parseRunResult("scoped-restart result=fail (remote listener missing)"), false);
  assert.equal(parseRunResult("operation op phase=verifying"), null);
  assert.equal(parseRunResult("result=okay"), null);
  assert.equal(parseRunResult("myresult=ok"), null);
  assert.equal(parseRunResult(""), null);
  assert.equal(parseRunResult(undefined), null);
});

test("状态机: start(opId, { steps, mapLog, kind:'scoped' }) 用自定义步骤表推进，快照带 kind/stepLabels", () => {
  const { machine } = makeMachine();
  assert.equal(machine.start("op-s", { steps: SCOPED_TEST_STEPS, mapLog: phaseMapper, kind: "scoped" }), true);
  assert.equal(machine.getKind(), "scoped");
  let snap = machine.snapshot();
  assert.equal(snap.kind, "scoped");
  assert.deepEqual(snap.stepLabels, ["写入控制信箱", "重启该隧道", "验证监听与归属"]);
  assert.deepEqual(snap.steps, ["active", "pending", "pending"]);
  machine.ingest({ operationId: "op-s", message: "operation op-s phase=queued" });
  machine.ingest({ operationId: "op-s", message: "operation op-s phase=executing" });
  assert.deepEqual(machine.snapshot().steps, ["done", "active", "pending"]);
  machine.ingest({ operationId: "op-s", message: "operation op-s phase=verifying" });
  machine.ingest({ operationId: "op-s", message: "scoped-restart result=ok" });
  snap = machine.snapshot();
  assert.deepEqual(snap.steps, ["done", "done", "active"]);
  assert.equal(snap.logCount, 4);
  machine.finish(true);
  assert.deepEqual(machine.snapshot().steps, ["done", "done", "done"]);
  // 下一轮不带选项 → 回到通道 runbook 默认（步骤表/映射/种类都不残留）
  machine.start("op-2");
  const next = machine.snapshot();
  assert.equal(next.kind, "restart");
  assert.deepEqual(next.stepLabels, REPAIR_STEPS.map((s) => s.label));
  machine.ingest({ operationId: "op-2", message: "stop requested" });
  assert.deepEqual(machine.snapshot().steps, ["active", "pending", "pending", "pending"]);
});

test("状态机: reset() 后步骤表回默认；非法 kind（含已移除的 remote）归为 restart", () => {
  const { machine } = makeMachine();
  machine.start("op-s", { steps: SCOPED_TEST_STEPS, kind: "scoped" });
  machine.reset();
  assert.equal(machine.snapshot().kind, "restart");
  assert.equal(machine.snapshot().stepLabels.length, REPAIR_STEPS.length);
  machine.start("op-x", { kind: "whatever" });
  assert.equal(machine.getKind(), "restart");
  machine.reset();
  machine.start("op-r", { kind: "remote" });
  assert.equal(machine.getKind(), "restart");
});

test("buildRunbookItemHtml: scoped 快照按自定义标签渲染，标题按种类切换", () => {
  const { machine, advance } = makeMachine();
  machine.start("op-s", { steps: SCOPED_TEST_STEPS, mapLog: phaseMapper, kind: "scoped" });
  advance(2_000);
  let html = buildRunbookItemHtml(machine.snapshot());
  assert.match(html, /单隧道重启执行中/);
  assert.doesNotMatch(html, /一键修复执行中/);
  for (const step of SCOPED_TEST_STEPS) assert.match(html, new RegExp(step.label));
  assert.doesNotMatch(html, /停止残留进程/);
  assert.match(html, /已产生 0 条操作日志 · 已耗时 2s/);
  machine.ingest({ operationId: "op-s", message: "operation op-s phase=verifying" });
  machine.finish(false);
  html = buildRunbookItemHtml(machine.snapshot());
  assert.match(html, /单隧道重启未成功/);
  assert.match(html, /state-error"><span class="runbook-step-mark">✕<\/span>验证监听与归属/);
  assert.match(html, /data-action="view-logs"/);
});

test("buildRunbookItemHtml: scoped 成功标题明示验证口径；超时如实说结果不确定", () => {
  const { machine } = makeMachine();
  machine.start("op-s", { steps: SCOPED_TEST_STEPS, kind: "scoped" });
  machine.finish(true);
  assert.match(buildRunbookItemHtml(machine.snapshot()), /单隧道重启完成（进程与远端监听已核实）/);
  const { machine: m2, advance: adv2 } = makeMachine();
  m2.start("op-t", { steps: SCOPED_TEST_STEPS, kind: "scoped" });
  adv2(RUNBOOK_TIMEOUT_MS);
  m2.checkTimeout();
  assert.match(buildRunbookItemHtml(m2.snapshot()), /单隧道重启结果不确定/);
  assert.match(buildRunbookItemHtml(m2.snapshot()), /仍在后台执行/);
});

test("buildRunbookItemHtml: 无 stepLabels 的老快照回退四步标签", () => {
  const html = buildRunbookItemHtml({ phase: "running", operationId: "op", logCount: 0, elapsed: 0, steps: ["active", "pending", "pending", "pending"] });
  assert.match(html, /停止残留进程/);
  assert.match(html, /探活验证/);
});

test("buildActionPreviewHtml: 影响范围/notes 全部转义，标题与目标行按契约拼接", () => {
  const preview = {
    previewId: "p-1",
    label: "重启此服务器的隧道 <b>x</b>",
    serverId: "server-01",
    host: "myserver",
    commands: ["只重启 7891 这一条反向隧道", "echo '<script>alert(1)</script>'"],
    notes: ["只影响 <script>3</script> 这一台"],
    expiresAt: 1,
  };
  const parts = buildActionPreviewHtml(preview);
  assert.deepEqual(Object.keys(parts).sort(), ["commands", "notes", "target", "title"]);
  assert.equal(parts.title, "重启此服务器的隧道 &lt;b&gt;x&lt;/b&gt;");
  assert.equal(parts.target, "server-01 · myserver");
  assert.equal(parts.commands, "只重启 7891 这一条反向隧道\necho &#039;&lt;script&gt;alert(1)&lt;/script&gt;&#039;");
  assert.match(parts.notes, /^<li>只影响 &lt;script&gt;3&lt;\/script&gt; 这一台<\/li>$/);
  for (const part of Object.values(parts)) {
    assert.doesNotMatch(part, /<script>/);
  }
});

test("buildActionPreviewHtml: 缺字段/畸形载荷不抛错，给占位", () => {
  const parts = buildActionPreviewHtml(null);
  assert.equal(parts.title, "操作确认");
  assert.equal(parts.target, "— · —");
  assert.equal(parts.commands, "");
  assert.equal(parts.notes, "");
  const weird = buildActionPreviewHtml({ serverId: "s", host: "h", commands: "not-array", notes: [1] });
  assert.equal(weird.title, "操作确认");
  assert.equal(weird.target, "s · h");
  assert.equal(weird.commands, "");
  assert.equal(weird.notes, "<li>1</li>");
});

test("buildPreviewExpireText: 倒计时向上取整秒，到点即过期", () => {
  assert.deepEqual(buildPreviewExpireText(10_000, 0), { expired: false, text: "预览 10 秒后过期" });
  assert.deepEqual(buildPreviewExpireText(10_500, 0), { expired: false, text: "预览 11 秒后过期" });
  assert.equal(buildPreviewExpireText(10_000, 10_000).expired, true);
  assert.equal(buildPreviewExpireText(10_000, 10_000).text, "预览已过期，请重新打开");
  assert.equal(buildPreviewExpireText(undefined, 0).expired, true);
  assert.equal(buildPreviewExpireText("x", 0).expired, true);
});

test("Node 环境: 无 document 时 initRepairRunbook / requestScopedRestart / handleRunbookLog 安全空转", async () => {
  const calls = [];
  initRepairRunbook({
    onPreviewScoped: async (id) => {
      calls.push(id);
      throw new Error("boom");
    },
  });
  // 预览失败：静默回收，不抛错（toast 由 app.js 回调负责）
  await assert.doesNotReject(() => requestScopedRestart("server-01"));
  assert.deepEqual(calls, ["server-01"]);
  // 无 previewId 的载荷同样回收
  initRepairRunbook({ onPreviewScoped: async () => ({}) });
  await assert.doesNotReject(() => requestScopedRestart("server-01"));
  // 非 running 态的日志直接忽略
  assert.doesNotThrow(() => handleRunbookLog({ operationId: "nope", message: "scoped-restart result=ok" }));
  // 预览回收后可再次打开（说明 preview 态没有残留）
  let opened = 0;
  initRepairRunbook({
    onPreviewScoped: async () => {
      opened += 1;
      // 短过期：倒计时 interval 到点自清，测试进程不必多挂一分钟
      return { previewId: "p", expiresAt: Date.now() + 1_000, target: { serverId: "server-01", host: "myserver" } };
    },
  });
  await requestScopedRestart("server-01");
  assert.equal(opened, 1);
});

test("已移除的 ReClaude 远端动作不再从 runbook 模块导出", async () => {
  const mod = await import("./render/repair-runbook.js");
  for (const name of [
    "REMOTE_ACTION_STAGE_LABELS",
    "buildRemoteSteps",
    "createRemoteLogMapper",
    "mapRemoteLogToStep",
    "parseRemoteResult",
    "buildRemotePreviewHtml",
    "buildRemoteExpireText",
    "requestRemoteAction",
  ]) {
    assert.equal(name in mod, false, `${name} 应已移除`);
  }
});
