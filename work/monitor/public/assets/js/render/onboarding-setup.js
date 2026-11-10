// 接入后的工具准备：复用安装与登录服务，只把下一步和验证范围说清楚。
// v2.89：setupFocus 算出「现在在第几步、下一步该点哪个按钮」，控制器据此给对话框打上 data-ob-focus，
// CSS 给对应按钮加脉冲高亮并在变化时滚过去；最后一步可以真的发一条测试对话（POST /api/cli/:id/smoke-test）。
import { escapeHtml } from "../store.js";
import { guideProgress } from "./onboarding-progress.js";

const CLI_IDS = ["codex", "claude"];
const LABEL = { codex: "Codex", claude: "Claude Code" };
const hasLogin = (tool) => Boolean(tool?.login) && !["none", "unknown"].includes(tool.login);

// → { stage: 1..5, focus: 空格分隔的令牌（CSS 用 ~= 匹配）, cli?, hint }
//   1 连接集群（引导的 8 步）  2 安装工具  3 填 Key / 登录  4 测试对话  5 完成
export function setupFocus({ guide, overview = null, completed = {}, smoke = {} } = {}) {
  const phase = guide?.phase || "idle";
  if (phase !== "done") {
    const hint = guideProgress(guide).next;
    if (phase === "idle") return { stage: 1, focus: "start", hint };
    if (phase === "waiting") return { stage: 1, focus: "prompt", hint };
    if (phase === "failed" || phase === "paused") return { stage: 1, focus: "retry", hint: phase === "paused" ? "上次没走完：点「继续」接着做，已完成的步骤不会重做。" : "这一步没有成功：先看红框里的原因，处理后点「重试」。" };
    return { stage: 1, focus: "", hint };
  }
  if (guide?.form?.mode === "monitor") return { stage: 5, focus: "finish", hint: "SSH 接入已验证：点「进入工作台」查看集群资源。工具通道可以以后再配置。" };
  if (!overview || overview.serverId !== guide?.server?.id) return { stage: 2, focus: "", hint: "正在读取集群上的安装状态…" };
  const job = overview.job?.status === "running" && overview.job.action !== "publish" ? overview.job : null;
  if (job) return { stage: 2, focus: "installing", hint: `正在安装 ${job.label || ""}：在后台进行，可以等它完成，不用关窗口。` };
  const installed = CLI_IDS.filter((id) => overview.clis?.[id]?.installed === true);
  if (!installed.length) return { stage: 2, focus: "install", hint: "第 2 步：点「安装」把 Codex 或 Claude Code 装到集群上（只装你要用的）。" };
  const needLogin = installed.find((id) => !completed[id] && !hasLogin(overview.clis[id]));
  if (needLogin) return { stage: 3, focus: `login login-${needLogin}`, cli: needLogin, hint: `第 3 步：给 ${LABEL[needLogin]} 填 API 地址和 Key——用中转站选「中转站地址 + Key」，用官方 Key 在「官方账号登录」窗口里选 API Key。` };
  const passed = installed.some((id) => smoke[id]?.result?.ok);
  if (!passed && !smoke.skipped) {
    const next = installed.find((id) => !smoke[id]?.result) || installed[0];
    return { stage: 4, focus: `smoke smoke-${next}`, cli: next, hint: "第 4 步：发一条测试对话，确认 Key、额度和模型都能用（只消耗极少额度，也可以跳过）。" };
  }
  return { stage: 5, focus: "finish", hint: "都准备好了：点「进入工作台」。以后在集群终端里直接输入 codex 或 claude 就能用。" };
}

// 高亮令牌 → 变化时滚到哪个元素（取最具体的那个令牌）。
export function focusSelector(focus) {
  const tokens = String(focus || "").split(" ").filter(Boolean);
  const last = tokens.at(-1) || "";
  if (last === "start") return '#onboardingStart';
  if (last === "prompt") return ".ob-prompt";
  if (last === "retry") return "[data-ob-retry]";
  if (last === "install") return '#onboardingCliBody [data-cli-action="install"]';
  if (last === "installing") return "#onboardingCliBody .cli-job";
  if (last.startsWith("login-")) return `[data-cli-login="${last.slice(6)}"]`;
  if (last.startsWith("smoke-")) return `[data-ob-smoke="${last.slice(6)}"]`;
  if (last === "finish") return "#onboardingFinish";
  return null;
}

function smokeResultHtml(entry) {
  if (!entry) return "";
  if (entry.busy) return '<p class="ob-note" aria-live="polite">正在等集群上的回复…通常十几秒，最长约一分半。</p>';
  if (entry.error) return `<p class="ob-error" role="alert">${escapeHtml(entry.error)}</p>`;
  const r = entry.result;
  if (!r) return "";
  if (r.ok) return `<p class="ob-smoke-ok" aria-live="polite">✓ ${escapeHtml(r.message)}${r.seconds != null ? `（用时 ${escapeHtml(String(r.seconds))} 秒）` : ""}</p>`;
  const tail = (r.tail || []).length ? `<details class="ob-manual"><summary>看输出尾巴</summary><pre class="ob-code"><code>${escapeHtml(r.tail.join("\n"))}</code></pre></details>` : "";
  return `<div class="ob-smoke-fail" role="alert"><p><b>${escapeHtml(r.message)}</b></p>${r.hint ? `<p class="ob-note">${escapeHtml(r.hint)}</p>` : ""}${tail}</div>`;
}

// 测试对话：每个已装的工具一块。overview 没回来 / 一个都没装时给一句话。
export function buildSmokeHtml(overview, smoke = {}) {
  const installed = CLI_IDS.filter((id) => overview?.clis?.[id]?.installed === true);
  if (!installed.length) return '<p class="ob-note">装好工具并填好 Key 之后，可以在这里发一条测试对话。</p>';
  const anyBusy = installed.some((id) => smoke[id]?.busy);
  const passed = installed.some((id) => smoke[id]?.result?.ok);
  const blocks = installed.map((id) => {
    const entry = smoke[id];
    const label = entry?.busy ? "正在测试…" : entry?.result ? "再测一次" : `给 ${LABEL[id]} 发一条测试对话`;
    return `<section class="ob-tool ob-smoke"><h4>${LABEL[id]}</h4>
      <div class="ob-actions"><button type="button" class="btn btn-secondary" data-ob-smoke="${id}"${anyBusy ? " disabled" : ""}>${escapeHtml(label)}</button></div>
      ${smokeResultHtml(entry)}</section>`;
  }).join("");
  const skip = passed || smoke.skipped ? "" : '<button type="button" class="text-btn" data-ob-smoke-skip>跳过测试</button>';
  return `<div class="ob-tool-grid">${blocks}</div>
    <p class="ob-note">在集群上用你平时的方式（经你的通道）发一句很短的话，收到回复就说明 Key、额度和模型都没问题。会消耗极少的额度。${skip}</p>`;
}

export const toolStartCommand = (cli) => [". ~/.config/cluster-workbench/env.sh", cli === "claude" ? "claude" : "codex"].join("\n");

export function buildSetupRouteHtml(guide) {
  const port = Number(guide?.result?.remotePort);
  const proxy = Number.isInteger(port) && port > 0 && port <= 65535 ? `http://127.0.0.1:${port}` : "接入时自动分配的个人端口";
  return `<div class="ob-route"><strong>请求从哪里出去</strong>
    <p>集群上的 Claude / Codex → 你的专属通道 → 这台电脑 → 官方服务或中转站</p>
    <dl><dt>集群代理</dt><dd><code>${escapeHtml(proxy)}</code><small>已由接入引导写入；每个人的端口可以不同。</small></dd>
    <dt>中转站地址</dt><dd>填写服务商给的 API 地址<small>例如 https://relay.example.com/v1。这里不能填上面的代理端口。</small></dd></dl>
    <p class="ob-note">使用时让这台电脑保持联网、工作台保持运行。校内中转站可由集群直连，保存时会自动判断并检测。</p></div>`;
}

export function buildSetupLoginHtml(guide, overview, completed = {}) {
  const serverId = guide?.server?.id;
  if (!serverId) return "";
  if (!overview || overview.serverId !== serverId) return '<p class="ob-note">先读取这台集群上的安装状态，或点击下方「检查通道与工具」重试。</p>';
  return `<div class="ob-tool-grid">${["codex", "claude"].map((cli) => {
    const tool = overview.clis?.[cli];
    const installed = tool?.installed === true;
    const done = completed[cli];
    const state = done?.method === "relay" ? "中转站配置已保存" : done?.state === "succeeded" ? "登录流程已完成"
      : !installed ? "请先安装这个工具" : tool.loginDetail || (tool.login && !["none", "unknown"].includes(tool.login) ? "已有登录配置，可保留或更换" : "选择一种方式继续");
    const disabled = !installed || overview.busy ? " disabled" : "";
    const attrs = `data-cli-login="${cli}" data-cli-server-id="${escapeHtml(serverId)}"`;
    return `<section class="ob-tool"><h4>${cli === "codex" ? "Codex" : "Claude Code"}</h4><p class="ob-note">${escapeHtml(state)}</p>
      <div class="ob-actions"><button type="button" class="btn btn-secondary" ${attrs} data-cli-method="account"${disabled}>官方账号登录</button>
      <button type="button" class="btn btn-secondary" ${attrs} data-cli-method="relay"${disabled}>中转站地址 + Key</button></div>
      <p class="ob-note">官方 API Key 也可在登录窗口里选择。</p></section>`;
  }).join("")}</div>`;
}

export function buildSetupCheckHtml({ busy = false, report = null, error = "" } = {}, { overview = null, smoke = {} } = {}) {
  const full = report?.full;
  const rows = [];
  if (full) rows.push(`<li>${full.ok ? "✓" : "!"} ${escapeHtml(full.message || (full.ok ? "集群经通道可达外网" : "集群出网检查未通过"))}</li>`);
  for (const item of report?.results || []) rows.push(`<li>${item.ok ? "✓" : "!"} ${escapeHtml(item.target || "本机出网")}：${escapeHtml(item.ok ? "可达" : item.message || "未通过")}</li>`);
  return `<div class="ob-actions"><button type="button" class="btn btn-primary" data-ob-check${busy ? " disabled" : ""}>${busy ? "正在检查…" : "检查通道与工具"}</button>
    <button type="button" class="text-btn" data-ob-retry-step="clusterEnv"${busy ? " disabled" : ""}>重新同步集群代理配置</button></div>
    ${error ? `<p class="ob-error" role="alert">${escapeHtml(error)}</p>` : ""}
    ${rows.length ? `<ul class="ob-check-results" aria-live="polite">${rows.join("")}</ul>` : ""}
    <p class="ob-note">网络可达不等于 Key、额度或模型权限有效：用下面的测试对话确认。</p>
    ${buildSmokeHtml(overview, smoke)}
    <div class="ob-tool-grid">${["codex", "claude"].map(cli => `<div class="ob-start"><pre class="ob-code"><code>${escapeHtml(toolStartCommand(cli))}</code></pre><button type="button" class="text-btn" data-ob-copy-start="${cli}">复制 ${cli === "codex" ? "Codex" : "Claude Code"} 启动命令</button></div>`).join("")}</div>
    <p class="ob-note">这两行粘贴到集群终端，不是在 Windows 的安装黑窗口里运行；已有的 Claude/Codex 会话需要退出后重新打开。</p>`;
}
