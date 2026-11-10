// render/onboarding-view.js —— 接入引导（#dlgOnboarding）的纯渲染：状态 → HTML 字符串，不碰 DOM（Node 可测）。
// 状态来自 GET /api/onboarding（lib/onboarding-guide/service.mjs）；交互接线在 app/onboarding-guide.js。
//
// 三种画面：还没开始 → 表单（用户名 + 密码）；进行中 / 失败 / 暂停 → 步骤清单，要人回答的问题就嵌在
// 提问的那一步下面；走完 → 结果摘要 + 折叠的步骤清单（装 CLI 与登录两段是 index.html 里的静态块，
// 由控制器显隐）。
import { escapeHtml } from "../store.js";
import { buildGuideProgressHtml } from "./onboarding-progress.js";

const SETUP_STATES = new Set(["needs-setup", "partial"]);
const IN_PROGRESS = new Set(["running", "waiting", "failed", "paused"]);

// 要不要自动弹出引导：还没配置好、或者上次走到一半；点过「稍后再说」或已经走完就不再自动弹。
// 入口始终还在（首页横幅的按钮、配置里的「接入引导」）。
export function shouldAutoOpenGuide(status) {
  const guide = status?.onboardingGuide;
  if (!guide || guide.dismissed) return false;
  if (guide.needsLocalSetup) return true;
  if (guide.phase === "done") return false;
  if (IN_PROGRESS.has(guide.phase)) return true;
  return SETUP_STATES.has(status.onboarding);
}

const STATUS_TEXT = { pending: "等待", running: "进行中", waiting: "等你确认", done: "完成", skipped: "已跳过", warn: "需要留意", failed: "没有成功" };

const actions = (html) => `<div class="ob-actions">${html}</div>`;
const note = (text) => (text ? `<p class="ob-note">${escapeHtml(text)}</p>` : "");

function hostKeyPrompt(prompt) {
  const rows = (prompt.fingerprints || [])
    .map((fp) => `<li><span>${escapeHtml(String(fp.type || "").replace(/^ssh-/, "").toUpperCase())}</span><code>${escapeHtml(fp.sha256 || "")}</code></li>`)
    .join("");
  return `<div class="ob-prompt">
    <p>第一次连接 <b>${escapeHtml(prompt.host || "")}</b>，请核对这台服务器的指纹：</p>
    <ul class="ob-fp">${rows}</ul>
    ${note("和管理员给你的指纹一致再继续；不确定就先问一下。")}
    ${actions('<button type="button" class="btn btn-primary" data-ob-answer="hostkey-accept">指纹一致，继续</button><button type="button" class="text-btn" data-ob-answer="hostkey-decline">不一致或不确定</button>')}
  </div>`;
}

const PASSWORD_ERRORS = {
  "wrong-password": (prompt) => `密码不对，请重新输入。${prompt.attempts >= 2 ? `已经连续输错 ${prompt.attempts} 次，再错可能被服务器暂时锁定。` : ""}`,
  channel: () => "这台电脑的 ssh 没法在页面里接收密码（常见于旧版 Windows）。请改用下面的终端方式。",
  "still-missing": () => "还没检测到公钥。确认下面的命令执行成功、没有报错之后，再点一次「我已完成」。",
};

function passwordPrompt(prompt) {
  const error = PASSWORD_ERRORS[prompt.error]?.(prompt) || "";
  // 密码通道走不通时页面里的输入框没有意义：只留终端方式，并直接展开。
  const manualOnly = prompt.error === "channel" || prompt.error === "still-missing";
  const manual = prompt.manualCommand
    ? `<details class="ob-manual"${manualOnly ? " open" : ""}>
        <summary>改在终端里输入密码</summary>
        <p>在这台电脑的${prompt.manualShell === "cmd" ? "「命令提示符（cmd）」中" : "终端里"}运行下面这一行（会提示输入集群密码），${prompt.manualShell === "cmd" ? "不要粘贴到 PowerShell 或集群终端。" : "不要粘贴到集群终端。"}完成后点「我已完成」，工作台会重新验证：</p>
        <pre class="ob-code"><code>${escapeHtml(prompt.manualCommand)}</code></pre>
        ${actions('<button type="button" class="btn btn-secondary" data-ob-copy="manual">复制命令</button><button type="button" class="btn btn-secondary" data-ob-answer="password-manual">我已完成</button>')}
      </details>`
    : "";
  const field = manualOnly
    ? ""
    : `<label class="ob-field"><span>${escapeHtml(prompt.user || "")} 的集群密码</span><input type="password" name="password" autocomplete="off" required></label>
       ${note("只用这一次：把这台电脑的公钥装到服务器上，之后都用密钥登录。不会保存。")}
       ${actions('<button type="submit" class="btn btn-primary">继续</button>')}`;
  return `<form class="ob-prompt" data-ob-form="password" novalidate>
    ${error ? `<p class="ob-error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${field}
    ${manual}
  </form>`;
}

function sshConfigPrompt(prompt) {
  return `<div class="ob-prompt">
    <p>你的 <code>~/.ssh/config</code> 里已经有 <code>Host ${escapeHtml(prompt.alias || "")}</code>，内容和这次要写的不一样：</p>
    <div class="ob-diff">
      <div><h4>现在的</h4><pre class="ob-code"><code>${escapeHtml(prompt.existing || "")}</code></pre></div>
      <div><h4>要写成</h4><pre class="ob-code"><code>${escapeHtml(prompt.proposed || "")}</code></pre></div>
    </div>
    ${note("覆盖之前会先备份整个文件。如果现在这段里有你需要的设置（比如跳板机），选保留。")}
    ${actions('<button type="button" class="btn btn-primary" data-ob-answer="ssh-overwrite">覆盖</button><button type="button" class="btn btn-secondary" data-ob-answer="ssh-keep">保留我的</button>')}
  </div>`;
}

function egressPrompt(prompt) {
  const rows = (prompt.failures || []).map((f) => `<li>${escapeHtml(f.target || "")}：${escapeHtml(f.message || "")}</li>`).join("");
  return `<div class="ob-prompt">
    <p>${escapeHtml(prompt.text || "这台电脑直连外网不通。")}</p>
    ${rows ? `<ul class="ob-list">${rows}</ul>` : ""}
    ${actions('<button type="button" class="btn btn-primary" data-ob-answer="egress-system">改用系统代理</button><button type="button" class="text-btn" data-ob-answer="egress-skip">先跳过</button>')}
  </div>`;
}

function straysPrompt(prompt) {
  const items = prompt.items || [];
  const rows = items.map((s) => `<li><span>~/${escapeHtml(s.file || "")}:${escapeHtml(String(s.line ?? ""))}</span><code>${escapeHtml(s.text || "")}</code></li>`).join("");
  return `<div class="ob-prompt">
    <p>集群上你的启动文件里有 ${items.length} 行旧的代理设置，会和新配置互相覆盖：</p>
    <ul class="ob-list ob-list-code">${rows}</ul>
    ${note("注释之前会备份原文件。不处理也可以：新配置写在文件末尾，以它为准。")}
    ${actions('<button type="button" class="btn btn-primary" data-ob-answer="strays-comment">注释掉这些行</button><button type="button" class="btn btn-secondary" data-ob-answer="strays-keep">保留</button>')}
  </div>`;
}

const PROMPTS = { hostkey: hostKeyPrompt, password: passwordPrompt, "ssh-config": sshConfigPrompt, egress: egressPrompt, strays: straysPrompt };

// Windows 上「没有 ssh 命令」：一键安装系统自带的 OpenSSH 客户端（后台进行，弹一次 UAC，装好后自动继续）。
function openSshBlock(openSsh, busy) {
  if (!openSsh) return "";
  if (openSsh.installing) return `<p class="ob-note" role="status">正在安装 OpenSSH 客户端：请在弹出的「用户账户控制」窗口里选「是」。安装要一两分钟，装好后自动继续。</p>`;
  return `${openSsh.error ? `<p class="ob-error" role="alert">${escapeHtml(openSsh.error)}</p>` : ""}
    ${actions(`<button type="button" class="btn btn-primary" data-ob-install-openssh${busy ? " disabled" : ""}>安装 OpenSSH 客户端</button>`)}`;
}

function failureBlock(error, { busy, openSsh = null }) {
  const sshTool = error.code === "ssh-missing" ? openSshBlock(openSsh, busy) : "";
  const manual = error.manual
    ? `<details class="ob-manual"><summary>手动执行的内容</summary><pre class="ob-code"><code>${escapeHtml(error.manual)}</code></pre>${actions('<button type="button" class="btn btn-secondary" data-ob-copy="error-manual">复制</button>')}</details>`
    : "";
  return `<div class="ob-fail" role="alert">
    <p class="ob-fail-msg">${escapeHtml(error.message || "这一步没有成功")}</p>
    ${note(error.hint)}
    ${error.detail ? `<pre class="ob-code"><code>${escapeHtml(error.detail)}</code></pre>` : ""}
    ${manual}
    ${sshTool}
    ${actions(`<button type="button" class="btn ${sshTool ? "btn-secondary" : "btn-primary"}" data-ob-retry${busy ? " disabled" : ""}>重试</button><button type="button" class="text-btn" data-ob-restart${busy ? " disabled" : ""}>重新填写账号</button>`)}
  </div>`;
}

function stepHtml(step, state) {
  const prompt = state.prompt?.step === step.id ? state.prompt : null;
  let extra = "";
  if (step.status === "waiting" && prompt && PROMPTS[prompt.kind]) extra = PROMPTS[prompt.kind](prompt);
  else if (step.status === "failed" && step.error) extra = failureBlock(step.error, state);
  // 走完之后还带提醒的步骤（目前只有出网自测）可以单独重跑。
  else if (step.status === "warn" && state.phase === "done") extra = actions(`<button type="button" class="text-btn" data-ob-retry-step="${escapeHtml(step.id)}"${state.busy ? " disabled" : ""}>重新测试</button>`);
  const detail = step.detail ? `<p class="ob-step-detail">${escapeHtml(step.detail)}</p>` : "";
  return `<li class="ob-step is-${escapeHtml(step.status)}">
    <span class="ob-mark" aria-hidden="true"></span>
    <div class="ob-step-main">
      <p class="ob-step-title">${escapeHtml(step.title)}<span class="ob-sr">（${STATUS_TEXT[step.status] || ""}）</span></p>
      ${detail}${extra}
    </div>
  </li>`;
}

const stepsHtml = (state) => `<ol class="ob-steps">${(state.steps || []).map((step) => stepHtml(step, state)).join("")}</ol>`;

function formHtml(state, ui) {
  // draft：上一次提交时填的值（校验没过重画表单时不丢）；密码从不回填。
  const form = { ...(state.form || {}), ...(ui.draft || {}) };
  const fieldError = (name) => (ui.formError?.field === name ? ' aria-invalid="true"' : "");
  const address = form.hostNameLocked
    ? ""
    : `<div class="ob-field-row">
        <label class="ob-field"><span>集群地址</span><input name="hostName" value="${escapeHtml(form.hostName || "")}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="IP 或域名" required${fieldError("hostName")}></label>
        <label class="ob-field ob-field-port"><span>SSH 端口</span><input name="sshPort" type="number" min="1" max="65535" value="${escapeHtml(String(form.sshPort || 22))}"></label>
      </div>`;
  return `<form class="ob-form" id="onboardingStartForm" data-ob-form="start" novalidate>
    <p class="ob-lead">填写自己的集群账号，密钥准备和公钥授权会自动完成。需要你确认时，流程会停下来提示。</p>
    ${address}
    <label class="ob-field"><span>这次要完成什么</span><select name="mode"><option value="monitor"${form.mode !== "full" ? " selected" : ""}>快速接入：先连接并查看集群资源</option><option value="full"${form.mode === "full" ? " selected" : ""}>完整接入：同时准备 AI 工具的通道与代理</option></select></label>
    ${note("同一内网下先选快速接入即可：验证 SSH 后进入工作台。需要让集群工具经本机出网时，再选择完整接入；已有通道会保留。")}
    <label class="ob-field"><span>集群用户名</span><input name="sshUser" value="${escapeHtml(form.sshUser || "")}" autocomplete="username" autocapitalize="off" spellcheck="false" required${fieldError("sshUser")}></label>
    <label class="ob-field"><span>集群密码</span><input name="password" type="password" autocomplete="off"${fieldError("password")}></label>
    ${note("密码只用一次：把这台电脑的公钥装到服务器上，之后都用密钥登录。不会保存在这台电脑或集群上；已经能免密登录的可以留空。")}
    ${note("开始之前确认本机能连到服务器的 SSH：服务器只允许内网访问时，先连上单位内网 / 校园网 / VPN。")}
    ${ui.formError ? `<p class="ob-error" role="alert">${escapeHtml(ui.formError.message)}</p>` : ""}
    ${ui.submitting ? '<p class="ob-note" role="status">正在开始…</p>' : ""}
  </form>`;
}

function doneHtml(state) {
  const quick = state.form?.mode === "monitor";
  const result = state.result || {};
  const facts = [
    result.sshUser && state.server ? `${result.sshUser}@${state.server.alias}` : "",
    result.remotePort ? `专属端口 ${result.remotePort}` : "",
  ].filter(Boolean).join(" · ");
  const warnings = (result.warnings || []).map((w) => `<li>${escapeHtml(w.text || "")}${w.command ? `<pre class="ob-code"><code>${escapeHtml(w.command)}</code></pre>` : ""}</li>`).join("");
  const flagged = (state.steps || []).filter((step) => step.status === "warn");
  return `<div class="ob-done">
    <p class="ob-done-title">1 · 已接入集群</p>
    <p class="ob-note">${quick ? "SSH 登录和本机公钥授权已验证，可以直接进入工作台查看资源。以后需要 AI 工具通道时，重新接入并选择完整模式即可。" : "通道和代理配置已准备。下面继续安装工具、选择登录方式，再检查并开始使用。"}</p>
    ${facts ? `<p class="ob-done-facts">${escapeHtml(facts)}</p>` : ""}
    ${warnings ? `<ul class="ob-warnings">${warnings}</ul>` : ""}
  </div>
  <details class="ob-fold"${flagged.length ? " open" : ""}>
    <summary>接入过程${flagged.length ? `（${flagged.length} 项需要留意）` : ""}</summary>
    ${stepsHtml(state)}
  </details>
  <p class="ob-note ob-again">换了账号，或者连接出了问题？<button type="button" class="text-btn" data-ob-restart${state.busy ? " disabled" : ""}>重新接入</button></p>`;
}

// ui: { submitting, formError: { field, message } | null, draft: { sshUser, hostName, sshPort } | null }
export function buildGuideHtml(state, ui = {}) {
  if (!state) return '<p class="incidents-empty">正在读取…</p>';
  if (!state.available) {
    return '<p class="incidents-empty">团队配置里没有可以接入的集群服务器。自己的服务器可以在「配置 → 服务器管理」里添加。</p>';
  }
  const progress = buildGuideProgressHtml(state);
  if (state.phase === "idle") return progress + formHtml(state, ui);
  if (state.phase === "done") return progress + doneHtml(state);
  const paused = state.phase === "paused"
    ? `<div class="ob-paused"><p>上次进行到一半就关掉了。已完成的步骤不会重做。</p>${actions(`<button type="button" class="btn btn-primary" data-ob-retry${state.busy ? " disabled" : ""}>继续</button><button type="button" class="text-btn" data-ob-restart${state.busy ? " disabled" : ""}>重新填写账号</button>`)}</div>`
    : "";
  return `${progress}${paused}${stepsHtml(state)}`;
}

// 页头副标题：接的是哪台、用哪个账号。
export function guideSubtitle(state) {
  if (!state?.server) return "";
  const who = state.phase !== "idle" && state.form?.sshUser ? `${state.form.sshUser}@` : "";
  return `${state.server.name}${state.form?.hostName ? ` · ${who}${state.form.hostName}` : ""}`;
}

// [data-ob-answer] 的取值 → POST /api/onboarding/answer 的正文。
export function answerBody(kind, state) {
  switch (kind) {
    case "hostkey-accept": return { kind: "hostkey", accept: true, linesHash: state?.prompt?.linesHash };
    case "hostkey-decline": return { kind: "hostkey", accept: false };
    case "password-manual": return { kind: "password", manualDone: true };
    case "ssh-overwrite": return { kind: "ssh-config", action: "overwrite" };
    case "ssh-keep": return { kind: "ssh-config", action: "keep" };
    case "egress-system": return { kind: "egress", action: "use-system" };
    case "egress-skip": return { kind: "egress", action: "skip" };
    case "strays-comment": return { kind: "strays", action: "comment" };
    case "strays-keep": return { kind: "strays", action: "keep" };
    default: return null;
  }
}
