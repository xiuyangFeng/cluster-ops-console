// 集群 CLI 登录的纯函数部分（v2.57 第 2 期 P-E，设计稿 §5.E / §5.F）：远端命令生成、输出解析、
// codex config.toml 与 Claude settings.json 的保格式改写、中转站地址判定后的动作、脱敏。
// 不发 SSH、不碰本机文件；执行在 login-api.mjs（API / 中转站）与 login.mjs（任务、伪终端会话）。
// 命令行向导（scripts/setup/cli-login.mjs）与 App 共用这里的命令与解析。
//
// 四种登录方式：
//   Codex 账号      ssh -L 1455 转发 + `ssh -tt` 跑 `codex login`（只有浏览器回调，无设备码），解析授权链接
//   Codex API       官方 key：`codex login --with-api-key`，key 经标准输入；
//                   中转站：config.toml 写 model_providers.<id>（base_url + env_key），key 落 keys/codex-<id>.env
//   Claude 账号     `ssh -tt` 跑 `claude auth login --claudeai`，解析链接，授权码写回伪终端；
//                   不通时改用 `claude setup-token`（长期令牌落 keys/claude-oauth.env）
//   Claude API      settings.json 的 env：官方 ANTHROPIC_API_KEY；中转站 ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
//                   （reclaude 接管时拒绝）
// 密钥只经 ssh 标准输入送达，命令串里永远没有 key（预览 / 日志 / ps 里都看不到）。
import {
  BASE_NO_PROXY,
  CLUSTER_ENV_DIR,
  CLUSTER_ENV_KEYS_DIR,
  CLUSTER_ENV_PATH,
  CLAUDE_SETTINGS_FILE,
  isReclaudeManagedClaudeEnv,
  patchClaudeSettingsEnv,
  readClaudeSettingsEnv,
  renderNoProxy,
} from "../cluster-env.mjs";
import { classifyRelayBaseUrl } from "../egress/relay-url.mjs";
import { shellSingleQuote } from "../shell/quote.mjs";
import { buildRemoteReplaceFileFromStdinCommand } from "../shell/remote-file.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";
import { isPort } from "../validators.mjs";
import { CLI_IDS, getCli } from "./catalog.mjs";

// 每种 CLI 支持的登录方式（登录专属，留在本模块）；id / 界面名以 lib/cli/catalog.mjs 为准。
const LOGIN_METHODS = Object.freeze({
  codex: Object.freeze(["account", "api", "relay"]),
  claude: Object.freeze(["account", "setup-token", "api", "relay"]),
});
export const LOGIN_CLIS = Object.freeze(Object.fromEntries(CLI_IDS.map((id) => [
  id,
  Object.freeze({ id, label: getCli(id).label, methods: LOGIN_METHODS[id] }),
])));

export function isLoginMethod(cli, method) {
  return Boolean(LOGIN_CLIS[cli]?.methods.includes(method));
}

// codex login 的回调端口（固定，codex 不支持改）。集群上全节点共享：两人同时登录会撞。
export const CODEX_CALLBACK_PORT = 1455;
// 远端硬上限（秒）：本机进程意外死掉、ssh 没断干净时，集群上的 codex login / claude 也会自己退出。
// 比本机总超时（10 分钟）略长，正常流程总是本机先收尾。
export const ACCOUNT_REMOTE_CAP_SEC = 660;

// 远端输出哨兵。
export const MARK = Object.freeze({
  portBusy: "__CWB_PORT_BUSY__",
  noCli: "__CWB_NO_CLI__",
  pid: "__CWB_PID__=",
  env: "__CWB_ENV__=",
  cli: "__CWB_CLI__=",
  file: "__CWB_FILE__=",
  http: "__CWB_HTTP__=",
  curlExit: "__CWB_CURL_EXIT__=",
  exit: "__CWB_EXIT__=",
});

const KEYS_DIR = `${CLUSTER_ENV_DIR}/${CLUSTER_ENV_KEYS_DIR}`;
export const CLAUDE_OAUTH_KEY_FILE = "claude-oauth";
export const CODEX_CONFIG_FILE = ".codex/config.toml";

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------

// API key / 令牌：可见 ASCII、无空白，8–1024 字符。引号等特殊字符照样允许（写进文件时单引号转义）。
const SECRET_RE = /^[\x21-\x7e]{8,1024}$/;
export function isPlausibleSecret(value) {
  return typeof value === "string" && SECRET_RE.test(value);
}

// 授权码（Claude 页面上显示的 code#state）：不含空白与控制字符，最多 2048 字符。
const AUTH_CODE_RE = /^[A-Za-z0-9._~#%+/=-]{4,2048}$/;
export function normalizeAuthCode(value) {
  const code = typeof value === "string" ? value.trim() : "";
  return AUTH_CODE_RE.test(code) ? code : null;
}

// codex 中转站 provider id：小写字母开头，字母数字与 -，最多 31 位；不与 codex 内置 provider 重名。
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED_PROVIDER_IDS = new Set(["openai", "oss", "ollama", "lmstudio", "azure", CLAUDE_OAUTH_KEY_FILE]);
export const DEFAULT_PROVIDER_ID = "relay";
export function normalizeProviderId(value) {
  const id = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : DEFAULT_PROVIDER_ID;
  return PROVIDER_ID_RE.test(id) && !RESERVED_PROVIDER_IDS.has(id) ? id : null;
}

export function providerEnvKey(id) {
  return `CWB_${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

export const codexKeyFileName = (id) => `codex-${id}`;

// ---------------------------------------------------------------------------
// 远端命令片段
// ---------------------------------------------------------------------------

// 远端命令的公共开头：有受管 env.sh 就 source（代理 + keys/*.env + ~/.local/bin）；没有时（还没跑过
// 集群侧受管配置）用本人隧道端口兜底设代理。sh -c 不读 rc 文件，所以必须显式做。
export function remotePreludeLines(port) {
  const envFile = `"$HOME/${CLUSTER_ENV_PATH}"`;
  let fallback = "";
  if (isPort(port)) {
    const p = `http://127.0.0.1:${port}`;
    const np = BASE_NO_PROXY.join(",");
    fallback = ` else export http_proxy=${p} https_proxy=${p} HTTP_PROXY=${p} HTTPS_PROXY=${p} no_proxy=${np} NO_PROXY=${np}; unset ALL_PROXY all_proxy;`;
  }
  return [
    `if [ -f ${envFile} ]; then . ${envFile};${fallback} fi`,
    `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH"; export PATH ;; esac`,
  ];
}

const binOf = (cli) => (cli === "claude" ? "claude" : "codex");

function requireCliLine(cli) {
  return `if ! command -v ${binOf(cli)} >/dev/null 2>&1; then echo ${MARK.noCli}; exit 127; fi`;
}

// 伪终端里的交互命令：先把终端拉宽（Ink / 终端换行会把长链接折成几行），打出这一层 sh 的 pid
// （exec 之后就是 timeout / CLI 本身，取消时据此精确清理），再在远端硬上限下 exec。
// timeout 用 --foreground：留在前台进程组才能读终端（Claude 要从终端读授权码）。
function interactiveTailLines(cliCommand, capSec) {
  return [
    "stty cols 4000 rows 50 2>/dev/null",
    `echo ${MARK.pid}$$`,
    `if command -v timeout >/dev/null 2>&1; then exec timeout --foreground -k 10 ${capSec} ${cliCommand}; else exec ${cliCommand}; fi`,
  ];
}

// Codex 账号登录：集群 1455 已被占用（多半是同事正在登录）就不启动——codex login 启动时会先请求
// 占着 1455 的旧登录服务 /cancel，等于把别人的登录打断。
export function buildCodexAccountCommand({ port, capSec = ACCOUNT_REMOTE_CAP_SEC } = {}) {
  return wrapSh([
    ...remotePreludeLines(port),
    requireCliLine("codex"),
    `if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk 'NR>1 {print $4}' | grep -Eq '[:.]${CODEX_CALLBACK_PORT}$'; then echo ${MARK.portBusy}; exit 75; fi`,
    ...interactiveTailLines("codex login", capSec),
  ]);
}

// Claude 账号登录（variant "account"）或长期令牌（variant "setup-token"）。
export function buildClaudeAccountCommand({ port, variant = "account", capSec = ACCOUNT_REMOTE_CAP_SEC } = {}) {
  const cmd = variant === "setup-token" ? "claude setup-token" : "claude auth login --claudeai";
  return wrapSh([...remotePreludeLines(port), requireCliLine("claude"), ...interactiveTailLines(cmd, capSec)]);
}

// 本机侧 ssh 选项（不含身份 / 主机，那部分沿用探针的钉扎参数）。-tt：本机标准输入是管道也强制分配远端伪终端。
// Codex 还要本机端口转发：浏览器把 localhost 解析成 ::1 时也要接得住，所以 v6 能绑就一起绑。
// ExitOnForwardFailure：本机 1455 被占时 ssh 直接失败，而不是"连上了但回调到不了"。
export function buildAccountSshOptions({ cli, forwardV6 = true } = {}) {
  const opts = ["-tt", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
  if (cli === "codex") {
    const p = CODEX_CALLBACK_PORT;
    opts.push("-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${p}:127.0.0.1:${p}`);
    if (forwardV6) opts.push("-L", `[::1]:${p}:127.0.0.1:${p}`);
  }
  return opts;
}

// 取消 / 超时后清理远端：只杀我们记下的那个 pid，且核对它的命令行仍是这次的 CLI（pid 复用时不误杀）。
export function buildRemoteKillCommand(pid, cli) {
  const n = Number(pid);
  if (!Number.isSafeInteger(n) || n <= 1) throw new Error(`pid 非法: ${pid}`);
  const bin = binOf(cli);
  return wrapSh([
    `if ps -o args= -p ${n} 2>/dev/null | grep -q '${bin}'; then kill ${n} 2>/dev/null; sleep 2; if ps -o args= -p ${n} 2>/dev/null | grep -q '${bin}'; then kill -9 ${n} 2>/dev/null; fi; fi`,
    "true",
  ]);
}

// 一次只读 SSH：受管 env.sh 在不在、CLI 在不在、目标文件全文（base64，原样字节；不存在写 "-"）。
export function buildInspectCommand({ cli, port, file }) {
  const target = `"$HOME/${file}"`;
  return wrapSh([
    ...remotePreludeLines(port),
    `if [ -f "$HOME/${CLUSTER_ENV_PATH}" ]; then echo ${MARK.env}1; else echo ${MARK.env}0; fi`,
    `if command -v ${binOf(cli)} >/dev/null 2>&1; then echo ${MARK.cli}1; else echo ${MARK.cli}0; fi`,
    `if [ -f ${target} ]; then printf '${MARK.file}'; base64 < ${target} | tr -d '\\n'; echo; else echo ${MARK.file}-; fi`,
  ]);
}

const markerValue = (text, marker) => {
  const m = String(text ?? "").match(new RegExp(`^${marker}(\\S*)\\r?$`, "m"));
  return m ? m[1] : null;
};

// → { envPresent, cliPresent, file: string | null }；哨兵不全（SSH 没到远端 / 输出截断）→ null。
export function parseInspectOutput(stdout) {
  const env = markerValue(stdout, MARK.env);
  const cli = markerValue(stdout, MARK.cli);
  const file = markerValue(stdout, MARK.file);
  if (env === null || cli === null || file === null) return null;
  return {
    envPresent: env === "1",
    cliPresent: cli === "1",
    file: file === "-" ? null : Buffer.from(file, "base64").toString("utf8"),
  };
}

// 从集群测中转站通不通。direct：绕过隧道直连（内网中转站）；否则经本人隧道，并用 --proxytunnel
// 让 http:// 也走 CONNECT——被本机代理拒绝时表现为连不上，而不是把代理的 403 当成"通了"。
// 不带任何 key：只看网络层（拿到任何 HTTP 状态码即算通）。
export function buildReachabilityCommand({ port, url, direct = false }) {
  // 明确清空 NO_PROXY 才能证明经过隧道；否则旧 NO_PROXY 可能使公网中转站绕过代理而被误报为通道可用。
  const via = direct ? "--noproxy '*'" : "--noproxy '' --proxytunnel";
  return wrapSh([
    ...remotePreludeLines(port),
    `if ! command -v curl >/dev/null 2>&1; then echo ${MARK.http}nocurl; exit 0; fi`,
    `curl ${via} -sS -o /dev/null -w '${MARK.http}%{http_code}\\n' --connect-timeout 8 -m 15 ${shellSingleQuote(url)} 2>&1`,
    `echo ${MARK.curlExit}$?`,
  ]);
}

// → { tested, reachable, httpCode, detail }。detail 是 curl 的错误行（不含 key，本来也没发 key）。
export function parseReachabilityOutput(stdout) {
  const http = markerValue(stdout, MARK.http);
  if (http === null) return { tested: false, reachable: false, httpCode: null, detail: "没有拿到测试结果" };
  if (http === "nocurl") return { tested: false, reachable: false, httpCode: null, detail: "集群上没有 curl，跳过连通测试" };
  const code = /^\d{3}$/.test(http) ? Number(http) : 0;
  const detail = String(stdout).split(/\r?\n/).find((line) => /^curl: \(\d+\)/.test(line)) || "";
  return { tested: true, reachable: code > 0, httpCode: code, detail: redactSecrets(detail) };
}

// 登录状态（核对用，不读凭证内容）：
export function buildStatusCommand({ cli, port }) {
  const cmd = cli === "claude" ? "claude auth status --json" : "codex login status";
  return wrapSh([...remotePreludeLines(port), `${cmd} 2>&1`, `echo ${MARK.exit}$?`]);
}

// codex login status → { loggedIn, login: "chatgpt" | "apikey" | "none" | "unknown", detail }
export function parseCodexLoginStatus(stdout) {
  const text = stripAnsi(stdout);
  if (/Logged in using ChatGPT/i.test(text)) return { loggedIn: true, login: "chatgpt", detail: "ChatGPT 账号" };
  if (/Logged in using an API key/i.test(text)) return { loggedIn: true, login: "apikey", detail: "API key" };
  if (/Logged in using/i.test(text)) return { loggedIn: true, login: "unknown", detail: "已登录" };
  if (/Not logged in/i.test(text)) return { loggedIn: false, login: "none", detail: "未登录" };
  return { loggedIn: null, login: "unknown", detail: null };
}

// authMethod 的原值给人看不知所云（真机上中转站 / 长期令牌报的是 "oauth_token"）；认识的换成中文，不认识的原样。
const CLAUDE_AUTH_METHOD_TEXT = Object.freeze({
  "claude.ai": "Claude 账号",
  oauth_token: "令牌（中转站令牌或长期令牌）",
  api_key: "API key",
});

// claude auth status --json → { loggedIn, login: "subscription" | "api" | "none" | "unknown", detail }
export function parseClaudeAuthStatus(stdout) {
  const text = stripAnsi(stdout);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let data = null;
  if (start !== -1 && end > start) {
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  if (!data || typeof data !== "object") return { loggedIn: null, login: "unknown", detail: null };
  const loggedIn = data.loggedIn === true;
  const method = String(data.authMethod ?? data.method ?? "").toLowerCase();
  let login = loggedIn ? "unknown" : "none";
  if (loggedIn && /claude|oauth|subscription|pro|max/.test(method)) login = "subscription";
  else if (loggedIn && /api|key|token/.test(method)) login = "api";
  return { loggedIn, login, detail: CLAUDE_AUTH_METHOD_TEXT[method] || method || (loggedIn ? "已登录" : "未登录") };
}

// ---------------------------------------------------------------------------
// 伪终端输出：去控制序列、找授权链接、判定成功 / 失败
// ---------------------------------------------------------------------------

// CSI / OSC（含 OSC 8 超链接）/ 单字符转义，以及回车。保留换行。
// biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要去掉终端控制序列
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;
export function stripAnsi(text) {
  return String(text ?? "").replace(ANSI_RE, "");
}

// 授权链接只认官方域名：链接要交给本机浏览器打开，不能让远端输出（或被篡改的 CLI）把用户引到别处。
const AUTH_URL_HOSTS = Object.freeze({
  codex: ["auth.openai.com"],
  claude: ["claude.ai", "claude.com", "anthropic.com"],
});

export function isAllowedAuthUrl(cli, value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  if (!(AUTH_URL_HOSTS[cli] || []).some((h) => host === h || host.endsWith(`.${h}`))) return false;
  return /oauth|authorize/i.test(`${url.pathname}${url.search}`);
}

export function extractAuthUrl(cli, text) {
  for (const m of stripAnsi(text).matchAll(/https:\/\/[^\s"'<>`]+/g)) {
    const url = m[0].replace(/[).,;:]+$/, "");
    if (isAllowedAuthUrl(cli, url)) return url;
  }
  return null;
}

const SUCCESS_RE = {
  codex: /Successfully logged in\.?\s*$/m,
  claude: /Login successful|Successfully logged in|Logged in as|You(?:'re| are) (?:now )?logged in|Authentication successful/i,
};
const FAILURE_RE = {
  codex: /Error logging in|Login server error|failed to start login server|Login (?:failed|error)/i,
  claude: /OAuth error|Login failed|Invalid (?:authorization )?code|Authentication failed|Failed to (?:exchange|authenticate|log ?in)|Error: .*(?:token|auth)/i,
};
const CLAUDE_OAUTH_TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;

// 对一段累积输出做判定。success / failure 由调用方传入"提交授权码之后的那一段"（避免旧输出被重复判定）。
// → { url, pid, portBusy, noCli, success, failure, token }
export function scanLoginOutput(cli, { full = "", recent = full, variant = "account" } = {}) {
  const text = stripAnsi(full);
  const tail = stripAnsi(recent);
  const pidMatch = text.match(/__CWB_PID__=(\d+)/);
  const token = cli === "claude" && variant === "setup-token" ? tail.match(CLAUDE_OAUTH_TOKEN_RE)?.[0] || null : null;
  // codex 自己报端口被占（"Port 127.0.0.1:1455 is already in use"）也算集群侧被占；本机 ssh 的转发失败
  // （"bind [127.0.0.1]:1455: Address already in use"）不算——那是本机端口，由 isLocalForwardFailure 归因。
  const portBusy = text.includes(MARK.portBusy)
    || (cli === "codex" && !isLocalForwardFailure(text) && new RegExp(`${CODEX_CALLBACK_PORT}\\S*\\s+is already in use`, "i").test(text));
  return {
    url: extractAuthUrl(cli, text),
    pid: pidMatch ? Number(pidMatch[1]) : null,
    portBusy,
    noCli: text.includes(MARK.noCli),
    success: variant === "setup-token" ? Boolean(token) : SUCCESS_RE[cli].test(tail),
    failure: FAILURE_RE[cli].test(tail),
    token,
  };
}

// 本机 ssh 的端口转发失败（本机 1455 被占且检查后被抢）：
export function isLocalForwardFailure(text) {
  return /Could not request local forwarding|bind \[?[0-9a-f:.]*\]?:\d+: Address already in use|cannot listen to port/i.test(String(text ?? ""));
}

// ---------------------------------------------------------------------------
// 脱敏：任务里留存、返回前端的输出尾巴都先过这里
// ---------------------------------------------------------------------------
export function redactSecrets(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) out = out.split(secret).join("[已隐藏]");
  }
  return out
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[已隐藏]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/g, "$1?[参数已隐藏]");
}

// 输出尾巴（失败时给人看）：去控制序列、去我们的哨兵行、脱敏、截最后 maxChars。
export function outputTail(text, { secrets = [], maxChars = 1200 } = {}) {
  const lines = stripAnsi(text)
    .split("\n")
    .filter((line) => line.trim() && !line.includes("__CWB_"));
  const joined = redactSecrets(lines.join("\n"), secrets);
  return joined.length > maxChars ? `…${joined.slice(-maxChars)}` : joined;
}

// ---------------------------------------------------------------------------
// 写文件命令（内容一律经标准输入）
// ---------------------------------------------------------------------------

// keys/<name>.env：只有一行 `export 变量='值'`。不留备份（备份里会是旧 key）；tmp 名不以 .env 结尾，
// 写到一半时不会被 env.sh 的 keys/*.env 循环 source。umask 077 + 显式 chmod：目录 700、文件 600。
export function renderKeyFile(varName, secret) {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(varName)) throw new Error(`变量名非法: ${varName}`);
  if (!isPlausibleSecret(secret)) throw new Error("密钥格式不对");
  return `export ${varName}=${shellSingleQuote(secret)}\n`;
}

export function buildWriteKeyFileCommand(name, byteLength) {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) throw new Error(`key 文件名非法: ${name}`);
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new Error(`byteLength 非法: ${byteLength}`);
  const dir = `~/${KEYS_DIR}`;
  const file = `${dir}/${name}.env`;
  const tmp = `${dir}/.${name}.tmp.$$`;
  return wrapSh(
    `{ umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && cat > ${tmp} && [ "$(wc -c < ${tmp})" -eq ${byteLength} ] && chmod 600 ${tmp} && mv ${tmp} ${file}; } || { rm -f ${tmp}; false; }`,
  );
}

// 整文件替换（config.toml / settings.json）：留时间戳备份。chmod600（settings.json 里要放 key）时临时文件
// 在写入内容之前就是 600，原文件是 644 / 664 也一样——不是写完、mv 之后才收紧（v2.57 终审）。
export function buildReplaceFileCommand(file, byteLength, { chmod600 = false } = {}) {
  return wrapSh(buildRemoteReplaceFileFromStdinCommand({ targetFile: `~/${file}`, byteLength, ...(chmod600 ? { mode: "600" } : {}) }));
}

// ---------------------------------------------------------------------------
// codex config.toml：model_providers.<id> 的保格式 upsert
// ---------------------------------------------------------------------------

export const MANAGED_PROVIDER_MARK = "# cluster-workbench: managed relay provider";

// 表头行 → 归一化表名（去空白与引号）；不是表头返回 null。数组表 [[x]] 带 array 标记。
function tableHeader(line) {
  const m = line.match(/^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
  if (!m) return null;
  const name = m[2]
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .join(".");
  return { name, array: m[1] === "[[" };
}

function splitLines(text) {
  const raw = String(text ?? "");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol };
}

const joinLines = (lines, eol) => (lines.length ? `${lines.join(eol)}${eol}` : "");

// 各表的 [起, 止) 行区间；top = 第一个表头之前。
function sectionsOf(lines) {
  const sections = [];
  lines.forEach((line, index) => {
    const header = tableHeader(line);
    if (header) sections.push({ ...header, start: index });
  });
  sections.forEach((s, i) => {
    s.end = i + 1 < sections.length ? sections[i + 1].start : lines.length;
  });
  return { sections, topEnd: sections.length ? sections[0].start : lines.length };
}

const tomlString = (value) => JSON.stringify(String(value));

export function renderProviderBlock({ id, name, baseUrl, envKey }) {
  return [
    `[model_providers.${id}]`,
    `${MANAGED_PROVIDER_MARK}（key 在 ~/${KEYS_DIR}/${codexKeyFileName(id)}.env）`,
    `name = ${tomlString(name || id)}`,
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    'wire_api = "responses"',
  ];
}

function isManagedSection(lines, section) {
  return lines.slice(section.start, section.end).some((line) => line.startsWith(MANAGED_PROVIDER_MARK));
}

// → { text, changed } | { skipped: "id-taken" | "unsupported-layout" }
//   id-taken：已有同名 provider 且不是我们写的（不覆盖用户手写的配置）；
//   unsupported-layout：provider 写成了点号键 / 内联表，没法保格式改，交给用户手动处理。
export function upsertCodexProvider(text, { id, name, baseUrl, envKey, makeDefault = true }) {
  const { lines, eol } = splitLines(text);
  const { sections, topEnd } = sectionsOf(lines);
  const target = `model_providers.${id}`;
  const idKey = new RegExp(`^\\s*["']?${id}["']?\\s*[.=]`);
  if (lines.slice(0, topEnd).some((line) => /^\s*model_providers\s*[.=]/.test(line))) return { skipped: "unsupported-layout" };
  const parent = sections.find((s) => s.name === "model_providers" && !s.array);
  if (parent && lines.slice(parent.start + 1, parent.end).some((line) => idKey.test(line))) return { skipped: "unsupported-layout" };
  if (sections.some((s) => s.name.startsWith(`${target}.`))) return { skipped: "unsupported-layout" };

  const block = renderProviderBlock({ id, name, baseUrl, envKey });
  const existing = sections.find((s) => s.name === target && !s.array);
  let next;
  if (existing) {
    if (!isManagedSection(lines, existing)) return { skipped: "id-taken" };
    // 保留区间末尾的空行（与下一个表之间的间隔）。
    let bodyEnd = existing.end;
    while (bodyEnd > existing.start + 1 && !lines[bodyEnd - 1].trim()) bodyEnd -= 1;
    next = [...lines.slice(0, existing.start), ...block, ...lines.slice(bodyEnd)];
  } else {
    next = [...lines];
    while (next.length && !next[next.length - 1].trim()) next.pop();
    if (next.length) next.push("");
    next.push(...block);
  }
  if (makeDefault) next = setTopLevelModelProvider(next, id);
  const out = joinLines(next, eol);
  return { text: out, changed: out !== String(text ?? "") };
}

function setTopLevelModelProvider(lines, id) {
  const { topEnd } = sectionsOf(lines);
  const line = `model_provider = ${tomlString(id)}`;
  const index = lines.slice(0, topEnd).findIndex((l) => /^\s*model_provider\s*=/.test(l));
  if (index !== -1) return lines.map((l, i) => (i === index ? line : l));
  // 插在顶层最后一个非空行之后（顶层为空时放在文件开头，并与第一个表隔一空行）。
  let insertAt = topEnd;
  while (insertAt > 0 && !lines[insertAt - 1].trim()) insertAt -= 1;
  const extra = insertAt === 0 && lines.length ? [line, ""] : [line];
  return [...lines.slice(0, insertAt), ...extra, ...lines.slice(insertAt)];
}

// 改回官方登录（账号 / 官方 key）时：顶层 model_provider 指向我们写的中转站 provider 才删掉这一行，
// provider 表本身保留（下次可再切回）。用户自己写的 model_provider 不动。→ { text, changed, providerId }
export function clearManagedDefaultProvider(text) {
  const { lines, eol } = splitLines(text);
  const { sections, topEnd } = sectionsOf(lines);
  const index = lines.slice(0, topEnd).findIndex((l) => /^\s*model_provider\s*=/.test(l));
  if (index === -1) return { text: String(text ?? ""), changed: false, providerId: null };
  const value = lines[index].replace(/^\s*model_provider\s*=\s*/, "").replace(/\s+#.*$/, "").trim().replace(/^["'](.*)["']$/, "$1");
  const section = sections.find((s) => s.name === `model_providers.${value}` && !s.array);
  if (!section || !isManagedSection(lines, section)) return { text: String(text ?? ""), changed: false, providerId: null };
  const next = lines.filter((_, i) => i !== index);
  return { text: joinLines(next, eol), changed: true, providerId: value };
}

// ---------------------------------------------------------------------------
// Claude settings.json：API / 中转站
// ---------------------------------------------------------------------------

export const CLAUDE_API_ENV_KEYS = Object.freeze(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
export { CLAUDE_SETTINGS_FILE };

// → { action: "write", text, changedKeys } | { action: "unchanged" } | { error: { code, message } }
// noProxyExtra 给出（内网中转站直连）且 env 里已有我们写的 NO_PROXY（以本机回环三项开头）时一并更新。
export function planClaudeApiSettings(text, { port, mode, apiKey, baseUrl, noProxyExtra = null }) {
  const env = readClaudeSettingsEnv(text);
  if (!env) return { error: { code: "invalid-json", message: `~/${CLAUDE_SETTINGS_FILE} 不是合法 JSON（或 env 不是对象），没有改动；请先修好它` } };
  if (isReclaudeManagedClaudeEnv(env, port)) {
    return {
      error: {
        code: "reclaude-managed",
        message: "这台服务器上的 Claude Code 由 reclaude 接管（settings.json 的代理指向 reclaude）。写入 API key 会绕开 reclaude，所以没有改动；要改用 API，请先在 reclaude 那边停用接管，再回来设置。",
      },
    };
  }
  const set = mode === "relay"
    ? { ANTHROPIC_BASE_URL: String(baseUrl), ANTHROPIC_AUTH_TOKEN: String(apiKey) }
    : { ANTHROPIC_API_KEY: String(apiKey) };
  const unset = mode === "relay" ? ["ANTHROPIC_API_KEY"] : ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"];
  if (Array.isArray(noProxyExtra)) {
    const base = BASE_NO_PROXY.join(",");
    const value = renderNoProxy(noProxyExtra);
    for (const key of ["NO_PROXY", "no_proxy"]) {
      if (typeof env[key] === "string" && env[key].startsWith(base)) set[key] = value;
    }
  }
  const result = patchClaudeSettingsEnv(text, { set, unset });
  if (result.skipped) return { error: { code: "invalid-json", message: `~/${CLAUDE_SETTINGS_FILE} 不是合法 JSON，没有改动` } };
  if (!result.changed) return { action: "unchanged" };
  return { action: "write", text: result.text, changedKeys: result.changedKeys };
}

// ---------------------------------------------------------------------------
// 中转站地址：判定后要做什么（纯函数，供预检接口与执行共用）
// ---------------------------------------------------------------------------

// → { ok, action, entry?, host, port, scheme, warnings, notes: [string], error? }
export function describeRelay(baseUrl) {
  const relay = classifyRelayBaseUrl(baseUrl);
  if (relay.action === "invalid") {
    const reasons = {
      empty: "请填中转站地址",
      "not-a-url": "不是完整的地址，应形如 https://relay.example.com/v1",
      "unsupported-scheme": "只支持 http:// 或 https://",
      "bad-host": "主机名不对",
    };
    return { ok: false, action: "invalid", warnings: [], notes: [], error: reasons[relay.reason] || "地址无法识别" };
  }
  const notes = [];
  if (relay.action === "none") notes.push("https 的 443 端口：经隧道直接可用，不需要改白名单");
  if (relay.action === "allowlist") notes.push(`非 443 端口：会把 ${relay.entry} 加进你的个人代理白名单（本机代理约 2 秒内生效）`);
  if (relay.action === "direct-candidate") notes.push("内网 / 校内地址：本机代理不转发内网目标，会先从集群直连测试，通了才写进集群 env.sh 的 NO_PROXY（不走隧道）");
  if (relay.warnings.includes("plaintext-http")) notes.push("http:// 是明文：这一段（含 API key）不加密，只在你确认中转站可信时使用");
  return { ok: true, ...relay, notes };
}
