// app/onboarding-guide.js —— 接入引导浮层（#dlgOnboarding）的接线。画面在 render/onboarding-view.js。
//
// 读：打开时 GET /api/onboarding；后端正在执行步骤（busy）期间每秒取一次，停下来（等回答 / 失败 / 走完）就不再轮询。
// 写：表单 → POST /start；提问的回答 → /answer；重试 → /retry；重新填写 → /reset；「稍后再说」→ /dismiss。
//     每个写接口都回最新状态，直接采用。密码输入框一提交就清空，页面不留。
// 自动弹出：首包状态说"还没配置好 / 上次走到一半"且没点过「稍后再说」时弹一次（每次页面加载至多一次）。
// 走完之后的「安装命令行工具」是配置浮层那一节的同一套界面（createSettingsCli 的第二个实例，由 app.js 传入），
// 「登录」直接用 [data-cli-login] 打开现成的登录浮层（叠在引导之上，关掉回到引导）。
// 下一步高亮（v2.89）：每次重画后按 setupFocus 给对话框打 data-ob-focus（CSS 给对应按钮加高亮）、更新顶部的
// 「下一步」提示与 2/3/4 段标题的进行中 / 已完成状态；下一步变了就把对应按钮滚到视野中间（找不到元素就下次再滚）。
// 测试对话：[data-ob-smoke] → POST /api/cli/:id/smoke-test（同步，最长约 2 分钟，请求超时放宽到 3 分钟）。
import { answerBody, buildGuideHtml, guideSubtitle, shouldAutoOpenGuide } from "../render/onboarding-view.js";
import { buildSetupRouteHtml, buildSetupLoginHtml, buildSetupCheckHtml, focusSelector, setupFocus, toolStartCommand } from "../render/onboarding-setup.js";

export const GUIDE_POLL_MS = 1000;
export const SMOKE_REQUEST_TIMEOUT_MS = 180000;

export function createOnboardingGuideUi({
  doc, getJson, postJson, showToast, copyText,
  // 一轮步骤告一段落后让背后的工作台跟上（个人配置、隧道状态都变了）。
  refresh = () => {},
  cliSection = null,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const $ = (id) => doc.getElementById(id);
  let guide = null;
  let ui = { submitting: false, formError: null, draft: null };
  let lastHtml = null;
  let timer = null;
  // 每次发写请求或新一轮轮询都 +1：先发后到的旧响应不采用。
  let seq = 0;
  let autoOpened = false;
  let overview = null;
  let completed = {};
  let check = { busy: false, report: null, error: "" };
  let checkSeq = 0;
  // 测试对话：{ codex: { busy, result, error }, claude: …, skipped }
  let smoke = {};
  let smokeSeq = 0;
  // 引导里那一节的安装任务（settings-cli 的 onJobChange）：概览里的 job 要等下一次重读才更新。
  let cliJob = null;
  let lastFocus = null;

  function renderSetup() {
    if (guide?.phase !== "done" || guide.form?.mode === "monitor") return applyFocus();
    for (const [id, html] of [
      ["onboardingRoute", buildSetupRouteHtml(guide)],
      ["onboardingLogin", buildSetupLoginHtml(guide, overview, completed)],
      ["onboardingCheck", buildSetupCheckHtml(check, { overview, smoke })],
    ]) {
      const el = $(id);
      if (el && el.innerHTML !== html) el.innerHTML = html;
    }
    applyFocus();
  }

  function currentFocus() {
    const running = cliJob?.status === "running" && cliJob.action !== "publish" && cliJob.serverId === guide?.server?.id;
    const view = running && overview ? { ...overview, job: cliJob } : overview;
    return setupFocus({ guide, overview: view, completed, smoke });
  }

  function applyFocus() {
    const dlg = $("dlgOnboarding");
    if (!dlg) return;
    const f = currentFocus();
    if (dlg.dataset) dlg.dataset.obFocus = f.focus;
    const hint = $("onboardingHint");
    if (hint && hint.textContent !== f.hint) hint.textContent = f.hint;
    if (hint) hint.hidden = guide?.phase !== "idle" && (guide?.phase !== "done" || guide.form?.mode === "monitor");
    for (const n of [2, 3, 4]) {
      const h = $(`onboardingStage${n}`);
      h?.classList?.toggle?.("is-active", f.stage === n);
      h?.classList?.toggle?.("is-done", f.stage > n);
    }
    if (f.focus === lastFocus || !isOpen()) return;
    const selector = focusSelector(f.focus);
    const target = selector ? dlg.querySelector?.(selector) : null;
    if (selector && !target) return; // 那一块还没画出来：下次重画再滚
    lastFocus = f.focus;
    const reduce = doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    target?.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
  }

  async function runSmoke(cli) {
    if (guide?.phase !== "done" || !guide.server?.id || Object.values(smoke).some((e) => e?.busy)) return;
    const mine = ++smokeSeq;
    smoke = { ...smoke, [cli]: { busy: true, result: null, error: "" } };
    renderSetup();
    try {
      const result = await postJson(`/api/cli/${encodeURIComponent(cli)}/smoke-test`, { serverId: guide.server.id }, { timeoutMs: SMOKE_REQUEST_TIMEOUT_MS });
      if (mine === smokeSeq) smoke = { ...smoke, [cli]: { busy: false, result, error: "" } };
    } catch (err) {
      if (mine === smokeSeq) smoke = { ...smoke, [cli]: { busy: false, result: null, error: errText(err) } };
    } finally {
      if (mine === smokeSeq) renderSetup();
    }
  }

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";
  const isOpen = () => Boolean($("dlgOnboarding")?.open);

  function stopPolling() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedulePoll() {
    stopPolling();
    timer = setTimer(poll, GUIDE_POLL_MS);
  }

  function focusField(main) {
    // 表单：用户名已经预填时直接落在密码框；提问：落在密码框。
    const user = main.querySelector?.('[data-ob-form="start"] input[name="sshUser"]');
    const host = main.querySelector?.('[data-ob-form="start"] input[name="hostName"]');
    const target = host && !host.value ? host : user && !user.value ? user : main.querySelector?.('input[name="password"]');
    target?.focus?.();
  }

  function render() {
    const main = $("onboardingMain");
    if (!main) return;
    const html = buildGuideHtml(guide, ui);
    // 整块重写会丢输入框里正在打的字：内容没变就不动（等回答期间也不轮询，所以输入中途不会重画）。
    if (html !== lastHtml) {
      main.innerHTML = html;
      lastHtml = html;
      focusField(main);
    }
    const sub = $("onboardingSub");
    if (sub) sub.textContent = guideSubtitle(guide);
    const done = guide?.phase === "done";
    const idle = guide?.available && guide.phase === "idle";
    for (const [id, hidden] of [["onboardingNext", !done || guide.form?.mode === "monitor"], ["onboardingFooter", !done && !idle],
      ["onboardingStart", !idle], ["onboardingFinish", !done], ["onboardingAddConnection", !done], ["onboardingLater", done]]) {
      const el = $(id);
      if (el) el.hidden = hidden;
    }
    renderSetup();
  }

  function adopt(next, { loadTools = true } = {}) {
    const before = guide ? `${guide.phase}:${guide.busy}` : null;
    if (next.phase !== "done" || next.server?.id !== guide?.server?.id) {
      checkSeq += 1;
      check = { busy: false, report: null, error: "" };
      overview = null;
      completed = {};
      smokeSeq += 1;
      smoke = {};
      cliJob = null;
    }
    guide = next;
    ui.formError = null;
    if (next.phase !== "idle") ui.draft = null;
    render();
    const settled = !next.busy;
    if (settled && before !== `${next.phase}:${next.busy}`) {
      Promise.resolve(refresh({ force: true })).catch(() => {});
      if (loadTools && next.phase === "done" && next.form?.mode !== "monitor") cliSection?.load?.();
    }
    if (next.busy && isOpen()) schedulePoll();
    else stopPolling();
  }

  async function poll() {
    timer = null;
    const mine = ++seq;
    try {
      const next = await getJson("/api/onboarding");
      if (mine === seq) adopt(next);
    } catch {
      // 一次取不到不算数：后端可能正忙着起隧道，下一拍再试。
      if (mine === seq && isOpen()) schedulePoll();
    }
  }

  // 写请求：成功采用返回的状态；失败时表单类错误留在表单上，其余弹提示并重新对一次状态。
  async function send(path, body, { form = false } = {}) {
    stopPolling();
    const mine = ++seq;
    try {
      const next = await postJson(path, body);
      if (mine === seq) adopt(next);
      return true;
    } catch (err) {
      if (mine !== seq) return false;
      if (form && err?.status === 400) {
        ui.formError = { field: err.field || null, message: errText(err) };
        render();
      } else {
        showToast({ type: "error", title: "接入引导", message: errText(err) });
        poll();
      }
      return false;
    }
  }

  async function submitStart(form) {
    if (ui.submitting) return;
    const fields = form.elements || {};
    const password = fields.password?.value || "";
    if (fields.password) fields.password.value = "";
    const body = { sshUser: (fields.sshUser?.value || "").trim() };
    if (fields.mode?.value) body.mode = fields.mode.value;
    if (fields.hostName) body.hostName = fields.hostName.value.trim();
    if (fields.sshPort?.value) body.sshPort = Number(fields.sshPort.value);
    if (password) body.password = password;
    ui = { submitting: true, formError: null, draft: { sshUser: body.sshUser, ...(body.mode ? { mode: body.mode } : {}), ...(body.hostName != null ? { hostName: body.hostName } : {}), ...(body.sshPort ? { sshPort: body.sshPort } : {}) } };
    // 不重画表单（重画会清掉刚填的用户名）：只把按钮按住。
    const button = form.querySelector?.('button[type="submit"]') || $("onboardingStart");
    if (button) button.disabled = true;
    await send("/api/onboarding/start", body, { form: true });
    ui.submitting = false;
    if (button) button.disabled = false;
    if (ui.formError) render();
  }

  async function submitPassword(form) {
    const field = form.elements?.password;
    const password = field?.value || "";
    if (field) field.value = "";
    if (!password) return;
    await send("/api/onboarding/answer", { kind: "password", password });
  }

  async function copy(which) {
    const failed = (guide?.steps || []).find((step) => step.status === "failed");
    const text = which === "manual" ? guide?.prompt?.manualCommand : failed?.error?.manual;
    if (text && await copyText(text)) showToast({ type: "info", title: "接入引导", message: "已复制，粘贴到终端里运行" });
  }

  async function checkSetup() {
    if (check.busy || guide?.phase !== "done" || !guide.server?.id) return;
    const mine = ++checkSeq;
    const serverId = guide.server.id;
    check = { busy: true, report: null, error: "" };
    renderSetup();
    try {
      const status = await getJson("/api/status");
      if (mine !== checkSeq) return;
      if (status.activeServerId !== serverId) throw new Error("当前查看的服务器已改变。请先切回接入的集群，再重新打开引导检查。");
      const [network, probe] = await Promise.allSettled([
        postJson("/api/egress/self-test", { scope: "full" }),
        postJson(`/api/probe/${encodeURIComponent(`cli:${serverId}`)}/run`, {}),
      ]);
      if (mine !== checkSeq) return;
      if (network.status === "rejected") throw network.reason;
      if (network.value.full?.serverId && network.value.full.serverId !== serverId) throw new Error("检查期间服务器已切换，请切回集群后重试。");
      check.report = network.value;
      if (probe.status === "rejected") check.error = `工具状态未刷新：${errText(probe.reason)}`;
      await cliSection?.load?.();
    } catch (error) {
      if (mine === checkSeq) check.error = errText(error);
    } finally {
      if (mine === checkSeq) { check.busy = false; renderSetup(); }
    }
  }

  function onClick(event) {
    const t = event.target;
    const hit = (selector) => {
      const el = t?.closest?.(selector);
      return el && !el.disabled ? el : null;
    };
    const answer = hit("[data-ob-answer]");
    if (answer) {
      const body = answerBody(answer.dataset.obAnswer, guide);
      return body ? send("/api/onboarding/answer", body) : undefined;
    }
    const retryStep = hit("[data-ob-retry-step]");
    if (retryStep) return send("/api/onboarding/retry", { step: retryStep.dataset.obRetryStep });
    if (hit("[data-ob-retry]")) return send("/api/onboarding/retry", {});
    if (hit("[data-ob-install-openssh]")) return send("/api/onboarding/install-openssh", {});
    if (hit("[data-ob-restart]")) return send("/api/onboarding/reset", {});
    if (hit("[data-ob-check]")) return checkSetup();
    const smokeBtn = hit("[data-ob-smoke]");
    if (smokeBtn) return runSmoke(smokeBtn.dataset.obSmoke);
    if (hit("[data-ob-smoke-skip]")) {
      smoke = { ...smoke, skipped: true };
      return renderSetup();
    }
    const start = hit("[data-ob-copy-start]");
    if (start) return Promise.resolve(copyText(toolStartCommand(start.dataset.obCopyStart))).then(ok => {
      if (ok) showToast({ type: "info", title: "启动命令", message: "已复制，粘贴到集群终端运行" });
    });
    const copyBtn = hit("[data-ob-copy]");
    if (copyBtn) return copy(copyBtn.dataset.obCopy);
    return undefined;
  }

  function onSubmit(event) {
    const form = event.target?.closest?.("[data-ob-form]");
    if (!form) return undefined;
    event.preventDefault();
    return form.dataset.obForm === "start" ? submitStart(form) : submitPassword(form);
  }

  async function open({ recheck = false } = {}) {
    const dlg = $("dlgOnboarding");
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    render();
    const mine = ++seq;
    try {
      let next = await getJson("/api/onboarding");
      if (mine !== seq) return;
      if (recheck && !next.busy) next = await postJson("/api/onboarding/reset", {});
      if (mine !== seq) return;
      if (recheck && !next.busy) ui = { submitting: false, formError: null, draft: null };
      adopt(next, { loadTools: false });
      if (next.phase === "done" && next.form?.mode !== "monitor") cliSection?.load?.();
    } catch (err) {
      if (mine === seq) showToast({ type: "error", title: "接入引导", message: `读取失败：${errText(err)}` });
    }
  }

  // 「稍后再说」/ Esc：记下来，之后不再自动弹（走完之后的关闭不算稍后）。
  function later() {
    if (guide && guide.phase !== "done" && !guide.dismissed) {
      guide = { ...guide, dismissed: true };
      postJson("/api/onboarding/dismiss", { dismissed: true }).catch(() => {});
    }
  }

  function init() {
    const dlg = $("dlgOnboarding");
    const main = $("onboardingMain");
    main?.addEventListener("click", onClick);
    main?.addEventListener("submit", onSubmit);
    $("onboardingNext")?.addEventListener("click", onClick);
    $("onboardingLater")?.addEventListener("click", () => {
      later();
      dlg?.close();
    });
    $("onboardingFinish")?.addEventListener("click", () => dlg?.close());
    dlg?.addEventListener("cancel", later);
    dlg?.addEventListener("close", () => {
      stopPolling();
      seq += 1;
      Promise.resolve(refresh({ force: true })).catch(() => {});
    });
    // 别处的入口（首页横幅「开始配置」之外的，如配置里的「接入引导」）：整页委托。
    doc.addEventListener?.("click", (event) => {
      const opener = event.target?.closest?.("[data-onboarding-open]");
      if (!opener) return;
      // 入口在别的浮层里（配置）：先关掉它，两个大浮层不叠在一起。
      opener.closest?.("dialog")?.close?.();
      open({ recheck: opener.dataset?.onboardingRecheck != null });
    });
  }

  // 每轮状态都会经过这里；只在首次判断出"该引导"时弹一次。
  function onStatus(status) {
    if (autoOpened || isOpen() || !shouldAutoOpenGuide(status)) return;
    autoOpened = true;
    open({ recheck: status.onboardingGuide?.needsLocalSetup === true });
  }

  function onCliOverview(data) {
    if (data?.serverId !== guide?.server?.id) return;
    overview = data;
    renderSetup();
  }

  function onCliJob(job) {
    const before = cliJob ? `${cliJob.jobId}:${cliJob.status}` : "";
    cliJob = job || null;
    if ((cliJob ? `${cliJob.jobId}:${cliJob.status}` : "") !== before && guide?.phase === "done") applyFocus();
  }

  function onCliChanged(job) {
    if (job?.serverId === guide?.server?.id && job.state === "succeeded") completed[job.cli] = { state: job.state, method: job.method };
    if (isOpen() && guide?.phase === "done") cliSection?.load?.();
  }

  return { init, open, onStatus, onCliOverview, onCliChanged, onCliJob, getState: () => ({ guide, ui, polling: timer !== null, smoke, focus: currentFocus() }) };
}
