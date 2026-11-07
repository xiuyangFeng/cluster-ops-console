// repair-runbook.js —— v2.15 "一键修复"可视 runbook：
// 预览确认浮层（列出实际修复序列）→ 注意力队列内联进度条目（SSE 日志按
// operationId 过滤 + 关键词映射步骤）→ 成功淡出 / 失败驻留可跳转日志。
// 只有 #alertActionBtn 与 #sidebarRepairBtn 两个"一键修复"入口走本流程；
// 命令面板 / dlgControl 的 restart 仍是直接 action("restart") 路径。
//
// 步骤描述如实对应 lib/channel-lifecycle.mjs 的 /api/restart 序列：
//   stopChannel: 先停 channel-supervisor（否则保活会拉回子进程），再并行停
//   本地代理与 SSH 隧道 → startChannel: autoRepairChannel(force) 拉起
//   supervisor（其自动重建本地代理与 SSH 反向隧道）→ forceRun
//   processes / log-signals / collect:slow:<活跃服务器> 探针探活验证
//   （v2.18：primary-remote 已随零残留采集注销，那一步的日志文案随之改成
//   "probe processes / log-signals / collect:slow:<id> forced"，仍由下面的
//   /probe|探活|验证/ 规则命中步骤 4）。
//
// 同一个状态机泛化为可配置步骤表——单隧道重启（T04b，operations-runner）复用这条
// "预览 → operationId → 进度 → 结果驻留"链路，不新建第二个状态机。start(opId,
// { steps, mapLog, kind }) 传入本次的步骤表与日志映射；不传即默认 REPAIR_STEPS +
// mapLogToStep。单隧道重启的确认层是 #dlgActionPreview：展示影响范围与过期倒计时，
// 确认后才有任何副作用。
//
// 纯逻辑（步骤映射 / 状态机 / HTML 构建）与 DOM 层分离；DOM 引用走惰性 getEl
// （dom-utils.createElementLookup），Node 可直接 import 测试。
import { createElementLookup, morphInnerHtml } from "../dom-utils.js";
import { escapeHtml } from "../store.js";

// ---- 纯逻辑：修复序列与步骤映射 ----

export const REPAIR_STEPS = [
  { key: "stop", label: "停止残留进程", desc: "先停守护进程（避免保活回拉），再并行停止本地代理与 SSH 隧道" },
  { key: "supervisor", label: "拉起守护进程", desc: "重新启动 channel-supervisor 单实例守护" },
  { key: "chain", label: "重建代理与隧道", desc: "守护进程自动拉起本地 HTTP 代理与 SSH 反向隧道" },
  { key: "probe", label: "探活验证", desc: "强制刷新进程 / 远端探针，确认链路重新连通" },
];

export const RUNBOOK_TIMEOUT_MS = 120_000;
const SUCCESS_LINGER_MS = 6_000;
const FADE_MS = 600;
const TICK_MS = 1_000;

// 日志消息 → 步骤下标（-1 = 映射不到，计入"执行中"总数）。
// 按声明顺序优先匹配：如 "stop channel-supervisor" 同时含 stop 与 supervisor，
// 属停止残留阶段（步骤1）而非拉起守护阶段。
const STEP_PATTERNS = [
  /stop|停止/i,
  /supervisor|守护/i,
  /tunnel|proxy|隧道|代理/i,
  /probe|探活|验证/i,
];

export function mapLogToStep(message) {
  const text = String(message || "");
  if (!text) return -1;
  for (let i = 0; i < STEP_PATTERNS.length; i += 1) {
    if (STEP_PATTERNS[i].test(text)) return i;
  }
  return -1;
}

// 收尾判定：`… result=ok|fail` 行（单隧道重启由结果轮询合成这一行）。
// HTTP 202 只表示"已受理"，完成与否只能从这一行得知。返回 true / false / null。
export function parseRunResult(message) {
  const m = /(?:^|\s)result=(ok|fail)(?=\s|$)/.exec(String(message || ""));
  if (!m) return null;
  return m[1] === "ok";
}

// ---- 纯逻辑：状态机 preview → running → success / failed / timeout ----

const DEFAULT_KIND = "restart";

export function createRunbookMachine({ now = Date.now, timeoutMs = RUNBOOK_TIMEOUT_MS } = {}) {
  let phase = "idle"; // idle | preview | running | success | failed | timeout
  let operationId = "";
  let startedAt = 0;
  let logCount = 0;
  let reachedStep = -1; // 已触达的最高步骤下标
  // 本轮步骤表 / 日志映射 / 种类：start() 可覆盖，reset() 回到通道 runbook 默认值。
  let stepDefs = REPAIR_STEPS;
  let mapLog = mapLogToStep;
  let kind = DEFAULT_KIND;

  function openPreview() {
    if (phase === "running") return false;
    phase = "preview";
    return true;
  }

  function cancelPreview() {
    if (phase !== "preview") return false;
    phase = "idle";
    return true;
  }

  function start(opId, { steps, mapLog: mapper, kind: runKind } = {}) {
    if (phase === "running") return false;
    phase = "running";
    operationId = String(opId || "");
    startedAt = now();
    logCount = 0;
    reachedStep = -1;
    stepDefs = Array.isArray(steps) && steps.length ? steps : REPAIR_STEPS;
    mapLog = typeof mapper === "function" ? mapper : mapLogToStep;
    kind = runKind === "scoped" ? "scoped" : DEFAULT_KIND;
    return true;
  }

  // SSE 日志条目进入：仅接收 running 期间、operationId 精确匹配的条目。
  function ingest(entry) {
    if (phase !== "running") return false;
    if (!entry || !operationId || entry.operationId !== operationId) return false;
    logCount += 1;
    const step = mapLog(entry.message);
    if (step > reachedStep) reachedStep = step;
    return true;
  }

  function finish(ok) {
    if (phase !== "running") return false;
    phase = ok ? "success" : "failed";
    return true;
  }

  // 超时保护：120s 未收尾转入 timeout（终态；之后 finish 会被忽略）。
  function checkTimeout(ts = now()) {
    if (phase !== "running") return false;
    if (ts - startedAt < timeoutMs) return false;
    phase = "timeout";
    return true;
  }

  function reset() {
    phase = "idle";
    operationId = "";
    startedAt = 0;
    logCount = 0;
    reachedStep = -1;
    stepDefs = REPAIR_STEPS;
    mapLog = mapLogToStep;
    kind = DEFAULT_KIND;
  }

  // 步骤视图：running 时已触达的最高步骤高亮（未收到日志前默认步骤1）、
  // 之前的打勾；success 全勾；failed/timeout 当前步骤标错。
  // stepLabels / kind 随快照一起给出：HTML 构建只认快照，不回头查状态机。
  function snapshot(ts = now()) {
    const active = Math.max(reachedStep, 0);
    const steps = stepDefs.map((_, i) => {
      if (phase === "success") return "done";
      if (i < active) return "done";
      if (i === active) {
        if (phase === "failed" || phase === "timeout") return "error";
        return "active";
      }
      return "pending";
    });
    return {
      phase,
      kind,
      operationId,
      logCount,
      elapsed: startedAt ? Math.max(0, Math.round((ts - startedAt) / 1000)) : 0,
      steps,
      stepLabels: stepDefs.map((step) => step.label),
    };
  }

  return {
    openPreview,
    cancelPreview,
    start,
    ingest,
    finish,
    checkTimeout,
    reset,
    snapshot,
    getPhase: () => phase,
    getKind: () => kind,
  };
}

// ---- 纯逻辑：HTML 构建（全插值 escapeHtml）----

const PHASE_META = {
  running: { icon: "⟳", title: "一键修复执行中…", cls: "is-running" },
  success: { icon: "✓", title: "修复完成，通道链路已重新拉起", cls: "is-success" },
  failed: { icon: "✕", title: "修复未成功完成", cls: "is-failed" },
  timeout: { icon: "⏱", title: "修复超过 120 秒未收尾", cls: "is-failed" },
};

// T04b 单隧道重启（scoped）：只影响目标服务器，完成文案明示验证口径。
const SCOPED_PHASE_META = {
  running: { icon: "⟳", title: "单隧道重启执行中…", cls: "is-running" },
  success: { icon: "✓", title: "单隧道重启完成（进程与远端监听已核实）", cls: "is-success" },
  failed: { icon: "✕", title: "单隧道重启未成功", cls: "is-failed" },
  timeout: { icon: "⏱", title: "单隧道重启结果不确定（未收到终态），请核实后决定是否重试", cls: "is-failed" },
};

function phaseMetaFor(snap) {
  const table = snap?.kind === "scoped" ? SCOPED_PHASE_META : PHASE_META;
  return table[snap?.phase] || null;
}

export function buildPreviewStepsHtml() {
  return REPAIR_STEPS.map(
    (step) =>
      `<li><span class="step-label">${escapeHtml(step.label)}</span>` +
      `<span class="step-desc">${escapeHtml(step.desc)}</span></li>`,
  ).join("");
}

export function buildRunbookItemHtml(snap) {
  const meta = phaseMetaFor(snap);
  if (!meta) return "";
  const marks = { done: "✓", active: "▸", error: "✕", pending: "·" };
  // 老快照（无 stepLabels）回退到通道 runbook 的四步标签。
  const labels = Array.isArray(snap.stepLabels) && snap.stepLabels.length
    ? snap.stepLabels
    : REPAIR_STEPS.map((step) => step.label);
  const stepsHtml = labels.map((label, i) => {
    const state = snap.steps?.[i] || "pending";
    return (
      `<li class="runbook-step state-${escapeHtml(state)}">` +
      `<span class="runbook-step-mark">${marks[state] || "·"}</span>${escapeHtml(label)}</li>`
    );
  }).join("");
  // 兜底行：无论关键词映射成功与否都能看到操作在推进。
  const metaLine = `已产生 ${escapeHtml(String(snap.logCount))} 条操作日志 · 已耗时 ${escapeHtml(String(snap.elapsed))}s`;
  const note =
    snap.phase === "timeout"
      ? '<p class="runbook-note">操作仍在后台执行，可查看本次操作日志确认进展。</p>'
      : snap.phase === "failed"
        ? '<p class="runbook-note">可查看本次操作日志定位失败原因。</p>'
        : "";
  const actions =
    snap.phase === "failed" || snap.phase === "timeout"
      ? `<div class="runbook-actions" data-op="${escapeHtml(snap.operationId)}">` +
        '<button type="button" class="text-btn" data-action="view-logs">查看本次操作日志</button>' +
        '<button type="button" class="text-btn" data-action="dismiss">关闭</button></div>'
      : "";
  return (
    `<div class="runbook-head"><span class="runbook-state-icon">${meta.icon}</span>` +
    `<span class="runbook-title">${escapeHtml(meta.title)}</span>` +
    // 耗时行每秒变化：对读屏隐藏，否则 #repairRunbook（aria-live + aria-atomic）会每秒整段重播。
    `<span class="runbook-meta" aria-hidden="true">${metaLine}</span></div>` +
    `<ol class="runbook-steps">${stepsHtml}</ol>${note}${actions}`
  );
}

// 操作预览载荷 → 确认层各区块的 HTML/文本（纯函数；影响范围与说明全部来自后端，
// 逐字展示但一律转义——预览层是"看清楚再点"的最后一道闸）。
export function buildActionPreviewHtml(preview) {
  const p = preview && typeof preview === "object" ? preview : {};
  const title = escapeHtml(p.label || "操作确认");
  const target = escapeHtml(`${p.serverId || "—"} · ${p.host || "—"}`);
  const commands = (Array.isArray(p.commands) ? p.commands : [])
    .map((c) => escapeHtml(String(c)))
    .join("\n");
  const notes = (Array.isArray(p.notes) ? p.notes : [])
    .map((n) => `<li>${escapeHtml(String(n))}</li>`)
    .join("");
  return { title, target, commands, notes };
}

// 过期倒计时文案：过期后确认按钮禁用，只能重新打开预览取新的 previewId。
export function buildPreviewExpireText(expiresAt, nowMs = Date.now()) {
  const remainMs = Number(expiresAt) - nowMs;
  if (!Number.isFinite(remainMs) || remainMs <= 0) return { expired: true, text: "预览已过期，请重新打开" };
  return { expired: false, text: `预览 ${Math.ceil(remainMs / 1000)} 秒后过期` };
}

// ---- DOM 层：惰性 getEl（Node import 时无 document 也安全）----

const getEl = createElementLookup();

const machine = createRunbookMachine();
let callbacks = {};
let tickTimer = null;
let fadeTimer = null;
let removeTimer = null;
// 过期倒计时（当前打开的预览见 scopedPreview）。
let expireTimer = null;

function clearTicker() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function clearFadeTimers() {
  if (fadeTimer) {
    clearTimeout(fadeTimer);
    fadeTimer = null;
  }
  if (removeTimer) {
    clearTimeout(removeTimer);
    removeTimer = null;
  }
}

function clearExpireTimer() {
  if (expireTimer) {
    clearInterval(expireTimer);
    expireTimer = null;
  }
}

function hideItem() {
  const el = getEl("repairRunbook");
  if (el) {
    el.style.display = "none";
    el.classList.remove("fade-out");
    el.innerHTML = "";
  }
}

function renderItem() {
  const el = getEl("repairRunbook");
  if (!el) return;
  const snap = machine.snapshot();
  const html = buildRunbookItemHtml(snap);
  if (!html) {
    hideItem();
    return;
  }
  const meta = phaseMetaFor(snap);
  el.className = `repair-runbook ${meta ? meta.cls : ""}`;
  // 就地修补：ticker 每秒刷新"已耗时"，整块 innerHTML 会把转圈/脉冲动画每秒重置
  //（1.2s 一圈的图标永远转不完），失败态按钮也会丢焦点。
  morphInnerHtml(el, html);
  el.style.display = "";
}

// 成功绿色收尾：驻留几秒后淡出移除。
function scheduleFadeOut() {
  clearFadeTimers();
  fadeTimer = setTimeout(() => {
    fadeTimer = null;
    const el = getEl("repairRunbook");
    if (el) el.classList.add("fade-out");
    removeTimer = setTimeout(() => {
      removeTimer = null;
      hideItem();
      if (machine.getPhase() === "success") machine.reset();
    }, FADE_MS);
  }, SUCCESS_LINGER_MS);
}

function settle(ok) {
  // 已 timeout（终态）时 finish 返回 false：忽略迟到的 promise 结果。
  const kind = machine.getKind();
  if (!machine.finish(ok)) return;
  clearTicker();
  stopScopedPolling(); // SSE 日志先到终态时，单隧道重启的结果轮询也要一并收掉
  renderItem();
  if (ok) scheduleFadeOut();
  // 收尾钩子（app.js 用它在单隧道重启成功后补一次全量刷新，让新隧道状态尽快上卡片）。
  if (typeof callbacks.onSettled === "function") {
    try {
      callbacks.onSettled(kind, ok);
    } catch {}
  }
}

function startTicker() {
  clearTicker();
  tickTimer = setInterval(() => {
    if (machine.checkTimeout()) {
      clearTicker();
      // 超时是终态（迟到结果会被忽略）：操作记录若一直查不到终态（404/被淘汰），
      // 不停掉的话 2s 轮询会永远跑下去，窗口隐藏时也不停。
      stopScopedPolling();
      renderItem();
      return;
    }
    if (machine.getPhase() !== "running") {
      clearTicker();
      return;
    }
    renderItem(); // 刷新"已耗时 Xs"兜底行
  }, TICK_MS);
}

function closeDialog(id) {
  const dlg = getEl(id);
  if (dlg?.open) dlg.close();
}

function openDialog(id) {
  const dlg = getEl(id);
  if (dlg && !dlg.open) dlg.showModal();
}

function scrollToItem() {
  const el = getEl("repairRunbook");
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// 兜底 UUIDv4：后端 normalizeOperationId 只放行 UUID 格式（非 UUID 会被替换成
// 服务端新生成的 id，SSE 日志将无法与本次 runbook 关联），降级路径也必须产 UUID 形状。
function fallbackUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function newOperationId() {
  return (
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function" && globalThis.crypto.randomUUID()) ||
    fallbackUuid()
  );
}

function confirmExecute() {
  // 先 start 再关浮层：dialog close 事件会触发 cancelPreview，其只在 preview
  // 态生效——此时已是 running 态，确认路径不会被 close 回调误回收。
  const operationId = newOperationId();
  if (!machine.start(operationId)) return;
  closeDialog("dlgRepairPreview");
  clearFadeTimers();
  renderItem();
  startTicker();
  Promise.resolve()
    .then(() => (typeof callbacks.onExecute === "function" ? callbacks.onExecute(operationId) : false))
    .then((ok) => settle(ok !== false))
    .catch(() => settle(false));
}

// 两个"一键修复"入口共用：弹修复计划预览确认层。执行中则滚动到进度条目。
export function requestRepair() {
  if (!machine.openPreview()) {
    scrollToItem();
    return;
  }
  const stepsEl = getEl("repairPreviewSteps");
  if (stepsEl) stepsEl.innerHTML = buildPreviewStepsHtml();
  openDialog("dlgRepairPreview");
}

// ---- 操作确认层（#dlgActionPreview）：展示影响范围与过期倒计时 ----

function renderPreviewExpire() {
  const el = getEl("actionPreviewExpire");
  const btn = getEl("actionPreviewConfirmBtn");
  if (!scopedPreview) return;
  const { expired, text } = buildPreviewExpireText(scopedPreview.expiresAt);
  if (el) {
    el.textContent = text;
    el.classList.toggle("is-expired", expired);
  }
  if (btn) btn.disabled = expired;
  if (expired) clearExpireTimer();
}

function renderActionPreview(preview) {
  const parts = buildActionPreviewHtml(preview);
  const titleEl = getEl("actionPreviewTitle");
  const targetEl = getEl("actionPreviewTarget");
  const cmdEl = getEl("actionPreviewCommands");
  const notesEl = getEl("actionPreviewNotes");
  if (titleEl) titleEl.innerHTML = parts.title;
  if (targetEl) targetEl.innerHTML = parts.target;
  if (cmdEl) cmdEl.innerHTML = parts.commands;
  if (notesEl) {
    notesEl.innerHTML = parts.notes;
    notesEl.style.display = parts.notes ? "" : "none";
  }
  const btn = getEl("actionPreviewConfirmBtn");
  if (btn) btn.disabled = false;
  renderPreviewExpire();
  clearExpireTimer();
  expireTimer = setInterval(renderPreviewExpire, TICK_MS);
}

// app.js 的 SSE onLog 转发入口：匹配本次 operationId 的条目推进步骤流。
// 单隧道重启的 result=ok|fail 收尾行在此直接 settle（通道 runbook 由 action() 的返回值收尾）。
export function handleRunbookLog(entry) {
  if (!machine.ingest(entry)) return;
  renderItem();
  if (machine.getKind() === "scoped") {
    const verdict = parseRunResult(entry.message);
    if (verdict != null) settle(verdict);
  }
}

// ---- T04b：单隧道重启（scoped）——预览确认层 → run(202) → 轮询操作结果 ----

// 单隧道重启步骤表：与 operations-runner preview.steps 的 key 逐字对应。
const SCOPED_STEPS = [
  { key: "queued", label: "写入控制信箱" },
  { key: "executing", label: "重启该隧道" },
  { key: "verifying", label: "验证监听与归属" },
];

// 进度日志 → 步骤下标：`phase=<name>` 令牌精确匹配；monitor 的 queued 收尾行
// 含 "queued" 字样命中第 0 步；result= 行不映射（由 parseRunResult 收尾）。
function createScopedLogMapper(stepKeys) {
  const keys = (Array.isArray(stepKeys) ? stepKeys : []).map((s) => (typeof s === "string" ? s : s?.key));
  return (message) => {
    const text = String(message || "");
    if (!text) return -1;
    const m = /(?:^|\s)phase=([A-Za-z0-9_-]+)(?=\s|$)/.exec(text);
    if (m) return keys.indexOf(m[1]);
    if (/\bqueued\b/.test(text)) return keys.indexOf("queued");
    return -1;
  };
}

const SCOPED_POLL_MS = 2000;
let scopedPreview = null;
let scopedPollTimer = null;

function stopScopedPolling() {
  if (scopedPollTimer) {
    clearInterval(scopedPollTimer);
    scopedPollTimer = null;
  }
}

// action：restart-tunnel（单隧道重启，默认）| takeover-tunnel（同账号多台 Mac 接力：让这台承载，v2.88）。
// 两者走同一套 preview → run → 轮询流程，只是预览标题与后端影响说明不同。
export async function requestScopedRestart(serverId, { action = "restart-tunnel", label = "" } = {}) {
  if (!machine.openPreview()) {
    scrollToItem();
    return;
  }
  let preview = null;
  try {
    preview = typeof callbacks.onPreviewScoped === "function" ? await callbacks.onPreviewScoped(serverId, action) : null;
  } catch {
    preview = null;
  }
  if (!preview || typeof preview !== "object" || !preview.previewId) {
    machine.cancelPreview();
    return;
  }
  // 预览浮层是通用形状（label/target/commands/notes）：把 runner 的 target/impact
  // 扁平化进去，逐字展示后端计算的影响范围。
  scopedPreview = {
    ...preview,
    label: preview.label || label || "重启此服务器的隧道",
    serverId: preview.target?.serverId || "",
    host: preview.target?.host || "",
    commands: preview.impact?.description ? [preview.impact.description] : [],
  };
  renderActionPreview(scopedPreview);
  openDialog("dlgActionPreview");
}

export function requestTunnelTakeover(serverId) {
  return requestScopedRestart(serverId, { action: "takeover-tunnel", label: "让这台电脑承载隧道" });
}

async function pollScopedOperation(operationId) {
  try {
    const op = typeof callbacks.onPollScoped === "function" ? await callbacks.onPollScoped(operationId) : null;
    if (!op || typeof op !== "object") return;
    if (op.phase) {
      // 以合成日志条目推进步骤流（machine.ingest 按 operationId 精确匹配）。
      handleRunbookLog({ operationId, message: `operation ${operationId} phase=${op.phase}` });
    }
    if (op.state === "succeeded" || op.state === "failed" || op.state === "unknown") {
      stopScopedPolling();
      // unknown 也是终态：不重放。runbook 以 fail 收尾，原因见操作日志（result= 行的 reason）。
      const verdictToken = op.state === "succeeded" ? "ok" : "fail";
      handleRunbookLog({ operationId, message: `scoped-restart result=${verdictToken}${op.reason ? ` (${op.reason})` : ""}` });
    }
  } catch {
    // 单次轮询失败忽略：120s 超时兜底会把状态如实显示为"结果不确定"。
  }
}

function confirmExecuteScoped() {
  const preview = scopedPreview;
  if (!preview) return;
  if (buildPreviewExpireText(preview.expiresAt).expired) {
    renderPreviewExpire();
    return;
  }
  const steps = (Array.isArray(preview.steps) && preview.steps.length ? preview.steps : SCOPED_STEPS)
    .map((s) => ({ key: s.key || s, label: s.label || String(s.key || s) }));
  const mapLog = createScopedLogMapper(steps.map((s) => s.key));
  const operationId = newOperationId();
  if (!machine.start(operationId, { steps, mapLog, kind: "scoped" })) return;
  clearExpireTimer();
  scopedPreview = null;
  closeDialog("dlgActionPreview");
  clearFadeTimers();
  renderItem();
  startTicker();
  Promise.resolve()
    .then(() => {
      if (typeof callbacks.onExecuteScoped !== "function") throw new Error("onExecuteScoped not wired");
      return callbacks.onExecuteScoped(preview.previewId, operationId);
    })
    .then((result) => {
      // 202 只表示已受理：终态来自操作结果轮询（succeeded/failed/unknown），
      // 120s 超时兜底。失败时 catch 分支 settle(false)。
      stopScopedPolling();
      scopedPollTimer = setInterval(() => pollScopedOperation(operationId), SCOPED_POLL_MS);
      return result;
    })
    .catch(() => {
      stopScopedPolling();
      settle(false);
    });
}

export function initRepairRunbook({ onExecute, onViewLogs, onPreviewScoped, onExecuteScoped, onPollScoped, onSettled } = {}) {
  callbacks = { onExecute, onViewLogs, onPreviewScoped, onExecuteScoped, onPollScoped, onSettled };
  if (typeof document === "undefined") return;

  getEl("repairConfirmBtn")?.addEventListener("click", confirmExecute);
  // 取消/Esc/点遮罩关闭统一走 dialog close 事件回收 preview 态。
  getEl("dlgRepairPreview")?.addEventListener("close", () => machine.cancelPreview());

  getEl("actionPreviewConfirmBtn")?.addEventListener("click", confirmExecuteScoped);
  getEl("dlgActionPreview")?.addEventListener("close", () => {
    clearExpireTimer();
    scopedPreview = null;
    stopScopedPolling();
    machine.cancelPreview();
  });

  // 失败态按钮：容器级委托（条目 DOM 会被整体重建）。
  getEl("repairRunbook")?.addEventListener("click", (e) => {
    const btn = e.target?.closest ? e.target.closest("[data-action]") : null;
    if (!btn) return;
    if (btn.dataset.action === "view-logs") {
      const holder = btn.closest("[data-op]");
      const op = holder?.getAttribute("data-op") || "";
      if (op && typeof callbacks.onViewLogs === "function") callbacks.onViewLogs(op);
    } else if (btn.dataset.action === "dismiss") {
      clearFadeTimers();
      hideItem();
      if (machine.getPhase() !== "running") machine.reset();
    }
  });
}
