// 官方 CLI 远端探测：调用组装（remote/cli-probe.sh 经 stdin 送 `sh -s`）+ 输出解析 + 登录方式归类。
//
// 远端脚本只回传「键名 / 存在性 / 非密钥的类型字段」，本文件把它们归成 CliState（契约见计划
// docs/superpowers/plans/2026-10-07-team-onboarding-phase2.md「数据契约」）：
//   { installed, version, kind, path, login, loginDetail }  另附 npmGlobal（npm 全局并存）、
//   managedBy（"reclaude" = ~/.claude/settings.json 被 reclaude 接管，登录流程据此拒绝改写）与
//   offPath（只在 installed 为 false 且确实找到时出现，形如 "~/.nvm/versions/node/v22.11.0/bin/codex"）。
// 纯函数部分（parseCliProbeOutput / buildCliState / classify*Login）不碰 IO，Node 可测。
//
// installed 的口径是「工作台用得上」：非交互 SSH 的 PATH（外加 ~/.local/bin）里找得到。只装在交互 shell
// 才看得到的位置（nvm、npm 自定义前缀、conda……）时 installed 仍是 false——doctor / 安装 / 登录都经
// 非交互 SSH 执行，一样用不上——但带上 offPath 说明它装在哪，界面据此说「已安装在 …，但非交互 SSH 的 PATH
// 里找不到」并给处理建议，而不是「未安装」。候选位置的清单只有一份，在 remote/cli-probe.sh 里；
// codex doctor 探针经 buildOffPathLocateCommand 用同一份（见下）。
//
// 为什么不直接跑 `codex login status`：它在 API key 登录时会打印 key 的首尾字符（"sk-proj-***xxxxx"），
// 密钥片段会经 SSH 回传、进探针输出与日志。登录方式一律从凭证文件的存在性 / 键名 / 类型字段推断
// （见 catalog.mjs 的 loginStatusCommand 说明），不要改回执行官方状态命令。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildProbeSshArgs } from "../ssh-args.mjs";
import { toPort } from "../validators.mjs";
import { CLI_IDS, classifyInstallKind, getCli } from "./catalog.mjs";

export const CLI_PROBE_SCRIPT_PATH = fileURLToPath(new URL("../../remote/cli-probe.sh", import.meta.url));
// 首次探测要各跑一次 `--version`（Claude 二进制约 250MB，网络盘冷读可能要十几秒）；之后走缓存，通常 1 秒内。
export const CLI_SCAN_TIMEOUT_MS = 45000;
const CLI_SCAN_MAX_OUT_BYTES = 64 * 1024;

let scriptCache = null;
export function loadCliProbeScript(read = readFileSync) {
  if (scriptCache === null) scriptCache = read(CLI_PROBE_SCRIPT_PATH, "utf8");
  return scriptCache;
}

// ---------------------------------------------------------------------------
// 「装了，但非交互 SSH 的 PATH 里找不到」
// ---------------------------------------------------------------------------

// 候选目录清单（相对 $HOME 的 glob）：远端脚本里两行标记之间的内容，一行一个。清单只在脚本里维护；
// 任何一行不合规（只允许字母、数字和 . _ - / *，不得以 / 开头、不得含 ..）→ 整份作废返回 []，
// 调用方退回「只看 PATH」的旧行为，绝不把来历不明的文本拼进远端命令。
const OFF_PATH_SECTION_RE = /^# __CT_OFF_PATH_DIRS_BEGIN__$([\s\S]*?)^# __CT_OFF_PATH_DIRS_END__$/m;
const OFF_PATH_GLOB_RE = /^[A-Za-z0-9._*-]+(?:\/[A-Za-z0-9._*-]+)*$/;

export function offPathDirGlobs(script = loadCliProbeScript()) {
  const section = OFF_PATH_SECTION_RE.exec(String(script ?? ""));
  if (!section) return [];
  const lines = section[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^ct_off_path_dirs='$/.test(line) && line !== "'");
  const ok = lines.length > 0 && lines.every((line) => OFF_PATH_GLOB_RE.test(line) && !line.split("/").includes(".."));
  return ok ? lines : [];
}

// 单行 POSIX sh：按清单在 $HOME 下找 <name> 的可执行文件，找到输出一行 ~/<相对路径>（与远端脚本的
// ct_off_path 同一算法、同一清单）。包在 sh -c 里：远端登录 shell 可能是 zsh（没匹配到的 glob 会直接报错）。
// 清单读不出来 → null（调用方不做这一步）。
export function buildOffPathLocateCommand(name, { globs = offPathDirGlobs() } = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(name))) throw new Error(`unsafe cli name: ${JSON.stringify(name)}`);
  if (!globs.length) return null;
  return `sh -c 'cd "$HOME" 2>/dev/null || exit 0; for d in ${globs.join(" ")}; do if [ -f "$d/${name}" ] && [ -x "$d/${name}" ]; then printf "~/%s\\n" "$d/${name}"; break; fi; done'`;
}

// 远端回传的 offPath → 展示用的路径；不是 "~/…" 形状（或含控制字符）→ null。
export function normalizeOffPath(value) {
  const text = String(value ?? "").trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要挡掉控制字符
  return /^~\/[^\x00-\x1f\x7f]{1,198}$/.test(text) ? text : null;
}

// 文案（两个适配器的结论 / 诊断输出共用；前端卡片在 render/overview.js 另有同义的一句）。
export function offPathSummary(label, offPath) {
  return `${label} 已安装在 ${offPath}，但非交互 SSH 的 PATH 里找不到`;
}

export const OFF_PATH_ADVICE = "处理：让非交互 SSH 也找得到它——把所在目录加进 PATH 的那一行（或 nvm 的初始化）挪到 ~/.bashrc 最前面（「非交互时直接返回」那一行之前）；或者在 配置 → 命令行工具 安装官方版（装到 ~/.local/bin）。";

// 远端命令：只有 env 前缀里的两个参数，均在本机校验后才拼入（远端脚本再校验一遍）。
// ids 只允许目录里的 CLI id；port 只允许合法端口（缺省不做连通性检查）。
export function buildCliRemoteCommand({ ids = CLI_IDS, endpointPort = null } = {}) {
  const safeIds = (Array.isArray(ids) ? ids : []).filter((id) => getCli(id));
  const port = endpointPort == null ? null : toPort(endpointPort);
  return `env CT_CLI_IDS='${(safeIds.length ? safeIds : CLI_IDS).join(",")}' CT_ENDPOINT_PORT='${port ?? ""}' sh -s`;
}

export function buildCliScanInvocation({ server = {}, parsed = {}, knownHostsPath, platform = process.platform, ids, endpointPort, script = loadCliProbeScript() } = {}) {
  return {
    file: "ssh",
    args: [...buildProbeSshArgs(server, parsed, { platform, knownHostsPath }), buildCliRemoteCommand({ ids, endpointPort })],
    input: script,
    timeoutMs: CLI_SCAN_TIMEOUT_MS,
    maxOutputBytes: CLI_SCAN_MAX_OUT_BYTES,
  };
}

// __CLI_BEGIN__ … __CLI_END__ 之间的 key=value → 扁平对象。没有开始标记（SSH 没到远端）→ null。
// 结束标记缺失（输出被截断）时照常解析已到的行，complete=false。
export function parseCliProbeOutput(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const begin = lines.findIndex((line) => line.trim() === "__CLI_BEGIN__");
  if (begin === -1) return null;
  const fields = {};
  let complete = false;
  for (const raw of lines.slice(begin + 1)) {
    const line = raw.trim();
    if (line === "__CLI_END__") {
      complete = true;
      break;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z][\w.]*$/.test(key)) continue;
    fields[key] = line.slice(eq + 1).slice(0, 200);
  }
  return { fields, complete };
}

const flag = (value) => value === "1";
const nameList = (value) => String(value || "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));

// scheme://host[:port] → "host[:port]"（展示用）；不是这种形状 → null。
export function originHost(url) {
  const match = /^[A-Za-z][\w+.-]*:\/\/([^/?#@\s]+)$/.exec(String(url || "").trim());
  return match ? match[1] : null;
}

// codex 的登录方式。优先级：自定义 provider（config.toml 的 model_provider 不是 openai）→ auth.json
// 的 ChatGPT 令牌 / 官方 API key → 凭证在系统钥匙串（无法只读判断）→ 未登录。
export function classifyCodexLogin(f) {
  const provider = String(f["codex.provider"] || "").trim();
  if (provider && provider !== "openai") {
    const host = originHost(f["codex.providerBaseUrl"]);
    const envKey = String(f["codex.providerEnvKey"] || "").trim();
    const parts = [`中转站 ${provider}`];
    if (host) parts.push(host);
    if (envKey) parts.push(`密钥变量 ${envKey}`);
    return { login: "apikey", loginDetail: parts.join(" · ") };
  }
  if (flag(f["codex.authFile"])) {
    const mode = String(f["codex.authMode"] || "").toLowerCase();
    const tokens = flag(f["codex.authTokens"]);
    const apiKey = flag(f["codex.authApiKey"]);
    if (apiKey && (mode === "apikey" || !tokens)) return { login: "apikey", loginDetail: "官方 API key" };
    if (tokens) return { login: "chatgpt", loginDetail: "ChatGPT 账号" };
  }
  const store = String(f["codex.credStore"] || "").toLowerCase();
  if (store === "keyring") return { login: "unknown", loginDetail: "凭证在系统钥匙串，无法只读判断" };
  return { login: "none", loginDetail: null };
}

const SUBSCRIPTION_LABELS = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Free" };

// Claude Code 的登录方式，按 Claude Code 自身的凭证优先级：环境变量里的 API 凭证
// （ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，settings.json env 或受管 keys/*.env）→ apiKeyHelper →
// 长期令牌 CLAUDE_CODE_OAUTH_TOKEN → 订阅账号 OAuth（.credentials.json）→ Console API key（~/.claude.json）→ 未登录。
export function classifyClaudeLogin(f) {
  const envNames = new Set([...nameList(f["claude.settingsEnv"]), ...nameList(f["keys.env"])]);
  const reclaude = flag(f["claude.reclaude"]);
  const via = reclaude ? " · 经 ReClaude 代理" : "";
  if (envNames.has("ANTHROPIC_AUTH_TOKEN") || envNames.has("ANTHROPIC_API_KEY")) {
    const host = originHost(f["claude.baseUrl"]);
    const relay = host && !/^api\.anthropic\.com(:443)?$/i.test(host);
    return { login: "api", loginDetail: relay ? `中转站 ${host}` : "官方 API key" };
  }
  if (flag(f["claude.apiKeyHelper"])) return { login: "api", loginDetail: "apiKeyHelper 脚本" };
  if (envNames.has("CLAUDE_CODE_OAUTH_TOKEN")) return { login: "subscription", loginDetail: `长期令牌（setup-token）${via}` };
  if (flag(f["claude.oauth"])) {
    const sub = String(f["claude.subscription"] || "").toLowerCase();
    const label = SUBSCRIPTION_LABELS[sub] || (sub ? sub : "");
    return { login: "subscription", loginDetail: `${label ? `${label} 订阅` : "订阅账号"}${via}` };
  }
  if (flag(f["claude.primaryApiKey"])) return { login: "api", loginDetail: "Console API key" };
  return { login: "none", loginDetail: null };
}

// 扁平字段 → 单个 CLI 的 CliState。该 CLI 没被探测（不在 ids 里 / 输出被截断没到它）→ null。
export function buildCliState(id, fields) {
  const f = fields || {};
  if (!Object.hasOwn(f, `${id}.installed`)) return null;
  const cli = getCli(id);
  const installed = flag(f[`${id}.installed`]);
  const path = installed ? (f[`${id}.path`] || f[`${id}.command`] || null) : null;
  const { login, loginDetail } = id === "codex" ? classifyCodexLogin(f) : classifyClaudeLogin(f);
  const state = {
    installed,
    version: installed && cli ? cli.parseVersion(f[`${id}.version`]) : null,
    kind: installed ? classifyInstallKind(id, path) : null,
    path,
    login,
    loginDetail,
    npmGlobal: flag(f[`${id}.npmGlobal`]),
  };
  if (id === "claude") state.managedBy = flag(f["claude.reclaude"]) ? "reclaude" : null;
  // 只在「PATH 里找不到、候选位置里找到了」时才有这个字段（已安装时即使远端多报也不认）。
  const offPath = installed ? null : normalizeOffPath(f[`${id}.offPath`]);
  if (offPath) state.offPath = offPath;
  return state;
}

// 连通性（适配器用）：`<http_code> <秒>` → { httpCode, latencyMs, ok }。没有该行 → null。
// 不带凭证请求得到 401/403/404/405 也说明 CONNECT + TLS + 上游 HTTP 都已到达（与 claude-endpoint 同口径）。
export function parseEndpointField(value) {
  if (value == null) return null;
  const match = /^(\d{3})\s+([\d.]+)/.exec(String(value).trim());
  const httpCode = match ? Number(match[1]) : 0;
  const latencyMs = match ? Math.round(Number.parseFloat(match[2]) * 1000) : null;
  return { httpCode, latencyMs, ok: [200, 401, 403, 404, 405].includes(httpCode) };
}

// 一次完整探测输出 → { clis: { id: CliState }, user, complete }；SSH 没到远端 → null。
export function parseCliScan(text, ids = CLI_IDS) {
  const parsed = parseCliProbeOutput(text);
  if (!parsed) return null;
  const clis = {};
  for (const id of ids) {
    const state = buildCliState(id, parsed.fields);
    if (state) clis[id] = state;
  }
  return {
    clis,
    user: parsed.fields.user || null,
    endpoint: parseEndpointField(parsed.fields.endpoint),
    complete: parsed.complete,
  };
}
