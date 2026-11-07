// app/cli-login-dialog.js —— 集群 CLI 登录对话框（v2.57 第 2 期 P-E）：从 Agent 详情里的「登录」进入。
//
// 四种方式：账号授权（Codex 浏览器回调经本机 1455 转发；Claude 浏览器授权后回贴授权码）、长期令牌（仅 Claude）、
// 官方 API key、中转站。登录在集群上进行，凭证只写进本人集群家目录；这里不保存任何 key——key 输入框
// 提交时先取值、立即清空，再发请求。
//
// 骨架在 index.html（#dlgCliLogin），这里只改动态部分：方式列表、字段显隐、中转站说明、进度与结果。输入框
// 从不重建（焦点与已填内容不丢）。任务在后端跑：关掉对话框不打断登录，重新打开时接着显示进度。
import { CLI_LABELS, cliIdForAgent } from "../render/cli-model.js";
import { escapeHtml } from "../store.js";

export const LOGIN_METHODS = Object.freeze({
  codex: [
    { method: "account", label: "ChatGPT 账号", hint: "在浏览器里登录，授权回调经本机 1455 端口转发回集群" },
    { method: "api", label: "API key", hint: "OpenAI 官方 API key" },
    { method: "relay", label: "中转站", hint: "填中转站地址与 key；写进集群上 codex 的 config.toml" },
  ],
  claude: [
    { method: "account", label: "Claude 账号", hint: "在浏览器里授权，再把页面上的授权码粘贴回来" },
    { method: "setup-token", label: "长期令牌", hint: "浏览器授权走不通时用：同样授权一次，生成一年有效的令牌" },
    { method: "api", label: "API key", hint: "Anthropic 官方 API key" },
    { method: "relay", label: "中转站", hint: "填中转站地址与 key；写进集群上 Claude Code 的 settings.json" },
  ],
});

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "timeout"]);
const POLL_MS = 1000;
// 对话框关着、后端的登录还在进行：放慢接着盯。停表的话，在浏览器里授权完回来看不到任何结果，
// Agent 卡片上的「登录」也要等下一次 5 分钟一轮的 /api/cli 才变。
export const POLL_CLOSED_MS = 3000;
const RELAY_CHECK_DELAY_MS = 350;

export const isTerminalState = (state) => TERMINAL.has(state);
export const needsKey = (method) => method === "api" || method === "relay";

// Agent 概览条目 → 能登录的 CLI（codex / claude）；与卡片同一份映射（render/cli-model.js）。
export { cliIdForAgent };

export function buildMethodsHtml(cli, selected) {
  return (LOGIN_METHODS[cli] || [])
    .map((m) => `<button type="button" class="cl-method" role="radio" aria-checked="${m.method === selected}" data-cl-method="${escapeHtml(m.method)}"><span class="cl-method-label">${escapeHtml(m.label)}</span><span class="cl-method-hint">${escapeHtml(m.hint)}</span></button>`)
    .join("");
}

// 中转站预检结果 → 说明行（只有说明，没有错误时也安静显示）。
export function buildRelayNotesHtml(check) {
  if (!check) return "";
  if (!check.ok) return `<span class="cl-note is-warn">${escapeHtml(check.error || "地址无法识别")}</span>`;
  return (check.notes || []).map((note) => `<span class="cl-note${/明文/.test(note) ? " is-warn" : ""}">${escapeHtml(note)}</span>`).join("");
}

// 任务 → 进度行文字。
export function describePhase(job) {
  if (!job) return "";
  if (job.state === "running") return job.phaseText || "进行中…";
  if (job.state === "succeeded") return "完成";
  if (job.state === "cancelled") return "已取消";
  if (job.state === "timeout") return "已超时";
  return "没有成功";
}

// 任务 → 结果区（成功信息 / 说明 / 提醒 / 错误）。运行中只显示提醒与"授权码没通过"之类的可恢复错误。
export function buildResultHtml(job) {
  if (!job) return "";
  const parts = [];
  if (job.state === "succeeded" && job.message) parts.push(`<p class="cl-message is-ok">${escapeHtml(job.message)}</p>`);
  if (job.state !== "succeeded" && job.error?.message) parts.push(`<p class="cl-message is-fail">${escapeHtml(job.error.message)}</p>`);
  const lines = [...(job.warnings || []).map((w) => ["is-warn", w]), ...(job.notes || []).map((n) => ["", n])];
  if (job.state === "succeeded" && job.status?.detail) lines.push(["", `当前登录：${job.status.detail}`]);
  if (lines.length) parts.push(`<ul class="cl-lines">${lines.map(([cls, text]) => `<li class="${cls}">${escapeHtml(text)}</li>`).join("")}</ul>`);
  return parts.join("");
}

// onCliChanged：登录成功后通知 Agent 卡片重新拉 /api/cli（app/cli-controller.js），登录方式不用等下一轮。
export function createCliLoginDialog({ doc, getJson, postJson, showToast, copyText, openDialog, getActiveServerId = () => null, onCliChanged = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const getEl = (id) => doc.getElementById(id);
  const state = { cli: "codex", method: "account", serverId: null, job: null, starting: false, relayCheck: null };
  let pollTimer = null;
  let relayTimer = null;
  let relaySeq = 0;

  const errText = (err) => err?.serverMessage || err?.message || "未知错误";
  const dialogOpen = () => Boolean(getEl("dlgCliLogin")?.open);

  // ---- 表单 ----
  function renderForm() {
    for (const btn of getEl("cliLoginCli")?.querySelectorAll?.("[data-cli]") || []) {
      btn.setAttribute("aria-pressed", String(btn.dataset.cli === state.cli));
    }
    const methods = getEl("cliLoginMethods");
    if (methods) methods.innerHTML = buildMethodsHtml(state.cli, state.method);
    const relay = state.method === "relay";
    const fields = getEl("cliLoginFields");
    if (fields) fields.hidden = !needsKey(state.method);
    for (const [id, show] of [
      ["cliLoginUrlField", relay],
      ["cliLoginProviderField", relay && state.cli === "codex"],
    ]) {
      const el = getEl(id);
      if (el) el.hidden = !show;
    }
    renderRelayNotes();
    const baseUrl = getEl("cliLoginBaseUrl");
    if (baseUrl) baseUrl.placeholder = state.cli === "codex" ? "https://relay.example.com/v1" : "https://relay.example.com";
    const routeHint = getEl("cliLoginRouteHint");
    if (routeHint) routeHint.textContent = relay
      ? `填服务商提供的 API 基础地址，不填通道的 127.0.0.1 代理端口。${state.cli === "codex" ? "Codex 需要兼容 Responses API" : "Claude Code 需要兼容 Anthropic Messages API"}；工作台先从集群检查网络，再保存配置。`
      : "登录和凭证保存在你自己的集群账号下；集群的出网通道由工作台自动配置。";
    const keyLabel = getEl("cliLoginKeyLabel");
    if (keyLabel) keyLabel.textContent = relay ? "中转站 key" : `${state.cli === "codex" ? "OpenAI" : "Anthropic"} API key`;
    const start = getEl("cliLoginStart");
    if (start) {
      start.disabled = state.starting;
      start.textContent = state.starting ? "正在开始…" : needsKey(state.method) ? "保存到集群" : "开始登录";
    }
  }

  function renderRelayNotes() {
    const notes = getEl("cliLoginRelayNotes");
    const relay = state.method === "relay";
    if (notes) notes.innerHTML = relay ? buildRelayNotesHtml(state.relayCheck) : "";
    const plain = getEl("cliLoginPlainField");
    const plaintext = relay && Boolean(state.relayCheck?.warnings?.includes("plaintext-http"));
    if (plain) plain.hidden = !plaintext;
    if (!plaintext && getEl("cliLoginPlain")) getEl("cliLoginPlain").checked = false;
  }

  // ---- 进度 ----
  function renderProgress() {
    const job = state.job;
    const form = getEl("cliLoginForm");
    const progress = getEl("cliLoginProgress");
    if (form) form.hidden = Boolean(job);
    if (progress) progress.hidden = !job;
    if (!job) return;
    const title = getEl("cliLoginTitle");
    if (title) title.textContent = `登录 ${CLI_LABELS[job.cli] || job.cli}`;
    const phase = getEl("cliLoginPhase");
    if (phase) {
      phase.textContent = describePhase(job);
      phase.dataset.state = job.state;
    }
    const link = getEl("cliLoginLink");
    const anchor = getEl("cliLoginUrl");
    const showLink = job.state === "running" && Boolean(job.url);
    if (link) link.hidden = !showLink;
    if (anchor && showLink && anchor.getAttribute("href") !== job.url) anchor.setAttribute("href", job.url);
    const codeForm = getEl("cliLoginCodeForm");
    if (codeForm) codeForm.hidden = !(job.state === "running" && job.needsCode);
    const result = getEl("cliLoginResult");
    if (result) result.innerHTML = buildResultHtml(job);
    const cancel = getEl("cliLoginCancel");
    if (cancel) cancel.hidden = job.state !== "running" || needsKey(job.method);
    const again = getEl("cliLoginAgain");
    if (again) again.hidden = job.state === "running";
  }

  function render() {
    renderForm();
    renderProgress();
  }

  function stopPolling() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
  }

  function schedulePoll() {
    stopPolling();
    if (!state.job || isTerminalState(state.job.state)) return;
    pollTimer = setTimer(poll, dialogOpen() ? POLL_MS : POLL_CLOSED_MS);
  }

  async function poll() {
    pollTimer = null;
    const jobId = state.job?.jobId;
    if (!jobId) return;
    try {
      const { job } = await getJson(`/api/cli/login/jobs/${encodeURIComponent(jobId)}`);
      if (state.job?.jobId !== jobId) return; // 期间换了任务：丢弃过期响应
      const wasRunning = state.job.state === "running";
      state.job = job;
      renderProgress();
      if (wasRunning && job.state === "succeeded") {
        showToast({ type: "success", title: "登录", message: job.message || "完成" });
        onCliChanged(job);
      } else if (wasRunning && isTerminalState(job.state)) {
        onCliChanged(job); // 失败/取消也要解除引导里根据 busy 显示的禁用状态。
        if (!dialogOpen()) {
          // 对话框开着时结果就写在里面；关着就得另外说一声，否则登录失败 / 超时了也没人知道。
          showToast({ type: job.state === "cancelled" ? "info" : "warn", title: job.state === "cancelled" ? "登录已取消" : "登录没有完成", message: job.message || "可以在 Agent 详情里重新登录。" });
        }
      }
    } catch (err) {
      if (err?.status === 404) {
        state.job = null;
        render();
        return;
      }
    }
    schedulePoll();
  }

  function adoptJob(job) {
    const wasTerminal = state.job?.jobId === job?.jobId && isTerminalState(state.job?.state);
    state.job = job;
    render();
    schedulePoll();
    if (job && isTerminalState(job.state) && !wasTerminal) onCliChanged(job);
  }

  // ---- 动作 ----
  async function start(event) {
    event?.preventDefault?.();
    if (state.starting) return;
    const body = { method: state.method };
    if (state.serverId) body.serverId = state.serverId;
    if (needsKey(state.method)) {
      const keyInput = getEl("cliLoginKey");
      // 先取值、立即清空：key 不在输入框里多停留，也不进任何本地状态。
      body.apiKey = keyInput ? keyInput.value.trim() : "";
      if (keyInput) keyInput.value = "";
      if (state.method === "relay") {
        body.baseUrl = getEl("cliLoginBaseUrl")?.value.trim() || "";
        body.acknowledgePlaintext = Boolean(getEl("cliLoginPlain")?.checked);
        if (state.cli === "codex") body.providerId = getEl("cliLoginProvider")?.value.trim() || "";
      }
      if (!body.apiKey) {
        setHint("请填写 key", true);
        getEl("cliLoginKey")?.focus?.();
        return;
      }
    }
    state.starting = true;
    setHint("");
    renderForm();
    try {
      const res = await postJson(`/api/cli/${encodeURIComponent(state.cli)}/login`, body);
      adoptJob(res.job);
    } catch (err) {
      if (err?.status === 409 && err.code === "busy" && err.serverMessage) setHint(err.serverMessage, true);
      else setHint(errText(err), true);
      const field = { apiKey: "cliLoginKey", baseUrl: "cliLoginBaseUrl", providerId: "cliLoginProvider", acknowledgePlaintext: "cliLoginPlain" }[err?.field];
      if (field) getEl(field)?.focus?.();
    } finally {
      body.apiKey = null;
      state.starting = false;
      renderForm();
    }
  }

  function setHint(text, isError = false) {
    const hint = getEl("cliLoginHint");
    if (!hint) return;
    hint.textContent = text;
    hint.classList.toggle("is-fail", Boolean(isError && text));
  }

  async function submitCode(event) {
    event?.preventDefault?.();
    const input = getEl("cliLoginCode");
    const code = input ? input.value.trim() : "";
    if (input) input.value = "";
    if (!code || !state.job) return;
    try {
      const { job } = await postJson(`/api/cli/login/jobs/${encodeURIComponent(state.job.jobId)}/code`, { code });
      adoptJob(job);
    } catch (err) {
      showToast({ type: "error", title: "登录", message: errText(err) });
    }
  }

  async function cancel() {
    if (!state.job) return;
    const btn = getEl("cliLoginCancel");
    if (btn) btn.disabled = true;
    try {
      const { job } = await postJson(`/api/cli/login/jobs/${encodeURIComponent(state.job.jobId)}/cancel`, {});
      adoptJob(job);
    } catch (err) {
      showToast({ type: "error", title: "登录", message: `取消失败：${errText(err)}` });
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function backToForm() {
    stopPolling();
    state.job = null;
    const title = getEl("cliLoginTitle");
    if (title) title.textContent = "登录";
    render();
  }

  // 中转站地址：停顿后预检（只做本地归类，不发 SSH）；按序号丢弃过期响应。
  function onRelayInput() {
    const seq = ++relaySeq; // 输入一变就使旧响应失效（包括清空和下一次 debounce 期间）。
    if (relayTimer) clearTimer(relayTimer);
    const value = getEl("cliLoginBaseUrl")?.value.trim() || "";
    if (!value) {
      state.relayCheck = null;
      renderRelayNotes();
      return;
    }
    relayTimer = setTimer(async () => {
      try {
        const check = await postJson("/api/cli/login/relay-check", { baseUrl: value });
        if (seq !== relaySeq) return;
        state.relayCheck = check;
      } catch {
        if (seq !== relaySeq) return;
        state.relayCheck = null;
      }
      renderRelayNotes();
    }, RELAY_CHECK_DELAY_MS);
  }

  // 打开：cli 预选；先看这台服务器上有没有正在进行的登录，有就接着显示进度。
  let openSeq = 0;
  async function open({ cli = "codex", serverId = null, method = "account" } = {}) {
    const mine = ++openSeq;
    relaySeq += 1;
    if (relayTimer) clearTimer(relayTimer);
    relayTimer = null;
    stopPolling();
    state.cli = LOGIN_METHODS[cli] ? cli : "codex";
    state.method = LOGIN_METHODS[state.cli].some(m => m.method === method) ? method : "account";
    state.serverId = serverId || getActiveServerId() || null;
    state.job = null;
    state.relayCheck = null;
    for (const id of ["cliLoginKey", "cliLoginCode", "cliLoginBaseUrl", "cliLoginProvider"]) {
      const el = getEl(id);
      if (el) el.value = "";
    }
    setHint("");
    const server = getEl("cliLoginServer");
    if (server) server.textContent = state.serverId ? `服务器 ${state.serverId}` : "";
    const title = getEl("cliLoginTitle");
    if (title) title.textContent = "登录";
    render();
    if (openDialog) openDialog("dlgCliLogin");
    else getEl("dlgCliLogin")?.showModal?.();
    try {
      const qs = state.serverId ? `?serverId=${encodeURIComponent(state.serverId)}` : "";
      const { job } = await getJson(`/api/cli/login/current${qs}`);
      if (mine !== openSeq) return;
      if (job?.state === "running") {
        state.cli = job.cli;
        adoptJob(job);
      }
    } catch {}
  }

  function init() {
    // Agent 详情里的「登录」（[data-cli-login]）：整页委托，详情区每轮重画也不丢。
    doc.addEventListener("click", (e) => {
      const btn = e.target?.closest?.("[data-cli-login]");
      if (btn && !btn.disabled) open({ cli: btn.dataset.cliLogin, serverId: btn.dataset.cliServerId, method: btn.dataset.cliMethod });
    });
    getEl("cliLoginCli")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cli]");
      if (!btn || btn.dataset.cli === state.cli) return;
      state.cli = btn.dataset.cli;
      if (!LOGIN_METHODS[state.cli].some((m) => m.method === state.method)) state.method = "account";
      setHint("");
      renderForm();
    });
    getEl("cliLoginMethods")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cl-method]");
      if (!btn) return;
      state.method = btn.dataset.clMethod;
      setHint("");
      renderForm();
    });
    getEl("cliLoginForm")?.addEventListener("submit", start);
    getEl("cliLoginCodeForm")?.addEventListener("submit", submitCode);
    getEl("cliLoginCancel")?.addEventListener("click", cancel);
    getEl("cliLoginAgain")?.addEventListener("click", backToForm);
    getEl("cliLoginBaseUrl")?.addEventListener("input", onRelayInput);
    getEl("cliLoginCopy")?.addEventListener("click", async () => {
      if (!state.job?.url) return;
      if (await copyText(state.job.url)) showToast({ type: "success", title: "登录", message: "授权链接已复制" });
    });
    const dlg = getEl("dlgCliLogin");
    dlg?.addEventListener("close", () => {
      // 关掉对话框不打断后端的登录；清掉输入框，轮询换成慢速接着盯到有结果（见 POLL_CLOSED_MS）。
      schedulePoll();
      for (const id of ["cliLoginKey", "cliLoginCode"]) {
        const el = getEl(id);
        if (el) el.value = "";
      }
    });
  }

  return { init, open, _state: state };
}
