// app/settings-egress.js —— 配置浮层「出网」一节（v2.54）：本机代理连外网的方式（直连 / 系统代理 / 手动）、
// 连通测试（本机 / 集群全链路）与个人端口白名单。
//
// 打开配置时读 GET /api/egress；方式与白名单逐项即时保存（POST /api/egress、/api/egress/allowlist），
// 写进个人层后本机代理约 2 秒内自行热载，不重启连接。骨架在 index.html（#settingsEgress），这里只改
// 动态部分：分段按钮的按下态、说明文字、事实行、测试结果与白名单列表——两个输入框从不重建，焦点不丢。
import { escapeHtml } from "../store.js";

export const EGRESS_MODES = [
  { mode: "direct", label: "直连", hint: "本机能直接上网时用（包括代理软件开了 TUN / 增强模式）" },
  { mode: "system", label: "系统代理", hint: "代理软件只开了「系统代理」时用，自动跟随系统设置" },
  { mode: "manual", label: "手动", hint: "填代理软件的 HTTP 或混合端口，如 http://127.0.0.1:7890" },
];

const modeLabel = (mode) => EGRESS_MODES.find((m) => m.mode === mode)?.label || mode;

// 纯函数：系统代理识别结果的一句话。
export function describeSystemProxy(sp) {
  if (!sp) return "—";
  if (sp.proxy) return sp.proxy.url.replace(/^http:\/\//, "");
  if (sp.socks) return `只有 SOCKS 代理 ${sp.socks.host}:${sp.socks.port}（暂不支持）`;
  if (sp.pac) return "PAC 自动配置（暂不支持）";
  if (sp.error) return "读取失败";
  return "未检测到";
}

// 纯函数：本机代理此刻实际怎么出网。mode 来自 /proxy-health 的出网头；upstream 由控制面在本机按个人配置
// 与系统代理识别结果算出（代理不再经 /proxy-health 发布上游地址，见 egress/service.mjs）。
export function describeEffective(status) {
  const eff = status?.effective;
  if (!eff?.running) return "本机代理没有运行";
  if (!eff.supportsEgress) return "本机代理是旧版本，更新后才支持出网设置";
  let text = eff.upstream ? `经 ${eff.upstream}` : eff.mode === "direct" ? "直连" : `${modeLabel(eff.mode)}不可用，暂按直连`;
  if (status.egress?.mode && eff.mode && status.egress.mode !== eff.mode) text += "（新设置几秒内生效）";
  return text;
}

// 纯函数：事实行（系统代理 / 当前生效 / 配置问题）。
export function buildEgressFactsHtml(status) {
  const rows = [
    ["系统代理", describeSystemProxy(status?.systemProxy)],
    ["当前生效", describeEffective(status)],
  ];
  if (status?.configIssue) rows.push(["配置问题", `${status.configIssue}，已按直连处理`]);
  return rows.map(([label, value]) => `<div class="eg-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
}

// 纯函数：白名单列表（个人条目可删；团队条目只读）。
export function buildAllowlistHtml(allowlist) {
  const personal = Array.isArray(allowlist?.personal) ? allowlist.personal : [];
  const team = Array.isArray(allowlist?.team) ? allowlist.team : [];
  if (!personal.length && !team.length) return '<li class="eg-empty">还没有条目</li>';
  return [
    ...personal.map((entry) => `<li class="eg-entry"><code>${escapeHtml(entry)}</code><button type="button" class="text-btn" data-egress-remove="${escapeHtml(entry)}" aria-label="${escapeHtml(`删除 ${entry}`)}">删除</button></li>`),
    ...team.map((entry) => `<li class="eg-entry"><code>${escapeHtml(entry)}</code><span class="eg-note">团队配置</span></li>`),
  ].join("");
}

// 纯函数：自测结果（逐项通 / 不通原因 + 建议 + 全链路）。
export function buildSelfTestHtml(report) {
  if (!report) return "";
  const items = (report.results || []).map((r) => `
    <li class="eg-result ${r.ok ? "is-ok" : "is-fail"}"><span class="eg-target">${escapeHtml(r.target)}</span><span class="eg-outcome">${escapeHtml(r.ok ? `通 · ${r.ms} ms` : r.message || "不通")}</span></li>`).join("");
  const suggestion = report.suggestion
    ? `<p class="eg-suggestion">${escapeHtml(report.suggestion.text)}${report.suggestion.action === "use-system" ? ' <button type="button" class="text-btn" data-egress-mode="system">改用系统代理</button>' : ""}</p>`
    : "";
  const full = report.full
    ? `<p class="eg-full ${report.full.ok ? "is-ok" : "is-fail"}"><span class="eg-target">集群全链路</span><span class="eg-outcome">${escapeHtml(report.full.message || (report.full.ok ? "通" : "不通"))}</span></p>`
    : "";
  return `<ul class="eg-results">${items}</ul>${suggestion}${full}`;
}

// 保存后重读最终生效状态：本机代理约 2 秒内热载，保存回显里的 effective 往往还是旧的。
export const EGRESS_SETTLE_MS = 2500;
export const EGRESS_SETTLE_TRIES = 3;

// 纯函数：本机代理是否已按配置生效（不在运行 / 旧版代理无从对齐，视为已定）。
export function egressSettled(status) {
  const eff = status?.effective;
  if (!eff?.running || !eff.supportsEgress) return true;
  return !status.egress?.mode || eff.mode === status.egress.mode;
}

// onSaved()：方式 / 白名单写入成功后回调（配置浮层据此重读个人配置 JSON 编辑器）。
// onStatus(status)：每次按一份 /api/egress 的状态重渲时回调（v2.62：同一节里的「代理口令」用这份数据，
// 见 ./settings-proxy-auth.js——不为它另发一次请求）。
//
// 过期响应：GET、保存与自测都是异步的，旧读取可能晚于保存返回、旧自测可能晚于改方式返回。
// 每个请求发出时取一个序号；回显按个人层 revision 比新旧（较旧的 revision 一律丢弃），revision 相同
// （或回包没有 revision）时按发出序号——更早发出的不覆盖已采用的。自测回包没有 revision，只在发出之后
// 没有采用过任何新状态时才回写 effective。
export function createSettingsEgress({
  doc, getJson, postJson, showToast, onSaved = () => {}, onStatus = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const getEl = (id) => doc.getElementById(id);
  let status = null;
  let requestSeq = 0; // 读 / 写 / 自测的发出序号
  let appliedSeq = 0; // 已采用的状态来自哪个序号
  let settleTimer = null;
  let pending = false; // 方式 / 白名单写入在飞：按钮禁用，避免连点交错
  let testing = false;
  let urlDirty = false; // 手动地址输入框有未提交的编辑：刷新时不覆盖

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";

  function renderMode() {
    const mode = status?.egress?.mode || "direct";
    for (const btn of getEl("egressModes")?.querySelectorAll?.("[data-egress-mode]") || []) {
      btn.setAttribute("aria-pressed", String(btn.dataset.egressMode === mode));
      btn.disabled = pending;
    }
    const hint = getEl("egressModeHint");
    if (hint) hint.textContent = EGRESS_MODES.find((m) => m.mode === mode)?.hint || "";
    const form = getEl("egressManualForm");
    if (form) form.hidden = mode !== "manual";
    const input = getEl("egressManualUrl");
    if (input && !urlDirty) input.value = status?.egress?.url || "";
  }

  function render() {
    renderMode();
    const facts = getEl("egressFacts");
    if (facts) facts.innerHTML = status ? buildEgressFactsHtml(status) : "";
    const list = getEl("egressAllowList");
    if (list) list.innerHTML = status ? buildAllowlistHtml(status.allowlist) : "";
    try {
      onStatus(status);
    } catch {}
  }

  // 采用一份状态回显；过期的丢弃（返回 false）。
  function adopt(next, seq) {
    const nextRev = next?.revision;
    const curRev = status?.revision;
    if (Number.isFinite(nextRev) && Number.isFinite(curRev) && nextRev !== curRev) {
      if (nextRev < curRev) return false;
    } else if (seq < appliedSeq) {
      return false;
    }
    status = next;
    appliedSeq = Math.max(appliedSeq, seq);
    return true;
  }

  async function load() {
    const seq = ++requestSeq;
    try {
      const next = await getJson("/api/egress");
      if (adopt(next, seq)) render();
    } catch (err) {
      if (seq < appliedSeq) return; // 已有更晚发出的状态落地：旧读取失败不盖掉它
      const facts = getEl("egressFacts");
      if (facts) facts.innerHTML = `<div class="eg-fact"><dt>出网设置</dt><dd>${escapeHtml(`读取失败：${errText(err)}；重新打开配置可重试`)}</dd></div>`;
    }
  }

  // 写入共用：在飞期间禁用，成功用服务端回显重渲，失败提示并按原状态重渲。
  async function save(path, body, successText) {
    if (pending) return false;
    pending = true;
    renderMode();
    const seq = ++requestSeq;
    try {
      adopt(await postJson(path, body), seq);
      scheduleSettle();
      showToast({ type: "success", title: "出网", message: successText });
      try {
        onSaved();
      } catch {}
      return true;
    } catch (err) {
      showToast({ type: "error", title: "出网", message: `保存失败：${errText(err)}` });
      return false;
    } finally {
      pending = false;
      render();
    }
  }

  // 保存成功后隔几秒重读，直到代理按新设置生效（最多 EGRESS_SETTLE_TRIES 次）。
  function scheduleSettle(attempt = 1) {
    if (settleTimer != null) clearTimer(settleTimer);
    settleTimer = setTimer(async () => {
      settleTimer = null;
      await load();
      if (!egressSettled(status) && attempt < EGRESS_SETTLE_TRIES) scheduleSettle(attempt + 1);
    }, EGRESS_SETTLE_MS);
  }

  async function setMode(mode) {
    if (!EGRESS_MODES.some((m) => m.mode === mode)) return;
    // 「手动」还没有地址时先展开输入框，等用户填完再保存。
    if (mode === "manual" && !status?.egress?.url) {
      const form = getEl("egressManualForm");
      if (form) form.hidden = false;
      getEl("egressManualUrl")?.focus?.();
      return;
    }
    if (mode === status?.egress?.mode) return;
    await save("/api/egress", { mode }, `已改为「${modeLabel(mode)}」，本机代理几秒内生效`);
  }

  async function saveManualUrl() {
    const url = String(getEl("egressManualUrl")?.value || "").trim();
    if (!url) return;
    if (await save("/api/egress", { mode: "manual", url }, "已改为经手动地址出网，本机代理几秒内生效")) urlDirty = false;
  }

  async function addEntry() {
    const input = getEl("egressAllowInput");
    const text = String(input?.value || "").trim();
    if (!text) return;
    if (await save("/api/egress/allowlist", { add: text }, "已加入白名单，几秒内生效") && input) input.value = "";
  }

  function removeEntry(entry) {
    return save("/api/egress/allowlist", { remove: entry }, `已从白名单删除 ${entry}`);
  }

  async function runTest(scope) {
    if (testing) return;
    testing = true;
    const box = getEl("egressTestResult");
    const buttons = [getEl("egressTestBtn"), getEl("egressFullTestBtn")];
    for (const btn of buttons) if (btn) btn.disabled = true;
    if (box) box.innerHTML = `<p class="eg-testing">${scope === "full" ? "正在测试本机出网与集群全链路…" : "正在测试本机出网…"}</p>`;
    const seq = ++requestSeq;
    try {
      const report = await postJson("/api/egress/self-test", { scope });
      if (box) box.innerHTML = buildSelfTestHtml(report);
      // 测试发出之后若已采用过新状态（期间改了方式 / 白名单、或重读过），测得的 effective 已过期
      if (report?.effective && status && seq > appliedSeq) {
        status = { ...status, effective: report.effective };
        appliedSeq = seq;
        render();
      }
    } catch (err) {
      if (box) box.innerHTML = `<p class="eg-suggestion">${escapeHtml(`测试没有完成：${errText(err)}`)}</p>`;
    } finally {
      testing = false;
      for (const btn of buttons) if (btn) btn.disabled = false;
    }
  }

  function bind() {
    getEl("egressModes")?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-egress-mode]");
      if (btn && !btn.disabled) return setMode(btn.dataset.egressMode);
    });
    getEl("egressManualForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      return saveManualUrl();
    });
    getEl("egressManualUrl")?.addEventListener("input", () => {
      urlDirty = true;
    });
    getEl("egressAllowForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      return addEntry();
    });
    getEl("egressAllowList")?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-egress-remove]");
      if (btn && !pending) return removeEntry(btn.dataset.egressRemove);
    });
    getEl("egressTestBtn")?.addEventListener("click", () => runTest("local"));
    getEl("egressFullTestBtn")?.addEventListener("click", () => runTest("full"));
    // 测试结果里的「改用系统代理」建议按钮。
    getEl("egressTestResult")?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-egress-mode]");
      if (btn) return setMode(btn.dataset.egressMode);
    });
  }

  function onOpen() {
    load();
  }

  bind();
  return { onOpen, load, setMode, saveManualUrl, addEntry, removeEntry, runTest, getRevision: () => status?.revision ?? null };
}
