// 官方 CLI 目录（v2.57 第 2 期）：工作台检测 / 安装 / 登录的两种 CLI 的静态事实，
// 探测（detect.mjs）、安装更新（install.mjs / versions.mjs）、登录（login.mjs）与前端共用这一份。
//
// 每项：
//   id                "codex" | "claude"（/api/cli 的键、cli:<serverId> 快照 clis 的键）
//   label             界面名
//   agentKind         对应的 Agent 适配器 kind（codex → "codex"，claude → "claude-code"）
//   npmPackage        dist-tags 查询用的主包名（最新版本检测，versions.mjs）
//   linuxPackage(v)   集群（linux x64）对应的 npm 产物 { name, version }（本机下载回退用）
//   parseVersion(s)   `<cli> --version` 输出 → "x.y.z"（带预发布后缀时保留）| null
//   installDirs       官方安装布局（~ 开头，远端家目录相对路径）
//   statusCommand     版本命令（远端探测按「真实路径 + mtime」缓存，没变不再执行）
//   loginStatusCommand 官方的登录状态命令。探测**不执行**它，以后也不要改回去：
//                      - `codex login status` 在 API key 登录时会打印 key 的首尾字符（形如
//                        "Logged in using an API key - sk-proj-***xxxxx"），执行它等于把密钥片段经 SSH
//                        回传到本机、进探针输出与日志；
//                      - `claude auth status --json` 是否发网络请求无法只读确认（且要冷启动约 250MB 的二进制）。
//                      探测改为只看本地凭证文件的存在性与类型（detect.mjs / remote/cli-probe.sh），
//                      这里只作登录流程（login.mjs）与文档引用。
//
// 现场事实（2026-10-07 只读核实 myserver）：codex 0.159.2 官方独立安装
// ~/.local/bin/codex → ~/.codex/packages/standalone/current/bin/codex
// （current → releases/<ver>-x86_64-unknown-linux-musl），`codex --version` 输出 `codex-cli 0.159.2`；
// Claude 原生安装 ~/.local/bin/claude → ~/.local/share/claude/versions/<ver>（版本文件本身就是可执行体，
// 约 250MB），`claude --version` 输出 `2.1.292 (Claude Code)`。

export const CLI_IDS = Object.freeze(["codex", "claude"]);

// CliState.kind：standalone（codex 官方独立安装）/ native（Claude 原生安装）/ npm（npm 全局）/
// unknown（装了但不是上述布局，如手工解包）/ null（未安装）。
export const INSTALL_KINDS = Object.freeze(["standalone", "native", "npm", "unknown"]);

// CliState.login：codex 用 chatgpt / apikey，Claude 用 subscription / api；两者共用 none / unknown。
export const LOGIN_KINDS = Object.freeze(["chatgpt", "apikey", "subscription", "api", "none", "unknown"]);

// "x.y.z" 或带预发布 / 构建后缀（0.160.0-alpha.3）。只取第一处，避免把路径里的数字当版本。
const VERSION_RE = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/;

export function parseVersionText(stdout) {
  const match = VERSION_RE.exec(String(stdout ?? ""));
  return match ? match[1] : null;
}

const CODEX = Object.freeze({
  id: "codex",
  label: "Codex",
  agentKind: "codex",
  npmPackage: "@openai/codex",
  // codex 的平台产物与主包同名、版本号带平台后缀（@openai/codex@0.160.1-linux-x64）。
  linuxPackage: (version) => ({ name: "@openai/codex", version: `${version}-linux-x64` }),
  // `codex-cli 0.159.2`
  parseVersion: parseVersionText,
  installDirs: Object.freeze({
    bin: "~/.local/bin/codex",
    standaloneRoot: "~/.codex/packages/standalone",
    releases: "~/.codex/packages/standalone/releases",
    current: "~/.codex/packages/standalone/current",
  }),
  statusCommand: "codex --version",
  loginStatusCommand: "codex login status",
});

const CLAUDE = Object.freeze({
  id: "claude",
  label: "Claude Code",
  agentKind: "claude-code",
  npmPackage: "@anthropic-ai/claude-code",
  linuxPackage: (version) => ({ name: "@anthropic-ai/claude-code-linux-x64", version }),
  // `2.1.292 (Claude Code)`
  parseVersion: parseVersionText,
  installDirs: Object.freeze({
    bin: "~/.local/bin/claude",
    versions: "~/.local/share/claude/versions",
    staging: "~/.cache/claude/staging",
  }),
  statusCommand: "claude --version",
  loginStatusCommand: "claude auth status --json",
});

const CLIS = Object.freeze({ codex: CODEX, claude: CLAUDE });

export function getCli(id) {
  return Object.hasOwn(CLIS, id) ? CLIS[id] : null;
}

export function isCliId(id) {
  return typeof id === "string" && Object.hasOwn(CLIS, id);
}

export function listClis() {
  return CLI_IDS.map((id) => CLIS[id]);
}

// Agent kind → CLI id（前端卡片与适配器取 /api/cli 对应项）；没有对应 CLI 的 Agent（reclaude / zcode）→ null。
export function cliIdForAgentKind(kind) {
  return listClis().find((cli) => cli.agentKind === kind)?.id ?? null;
}

// 可执行文件真实路径 → 安装形态。路径来自远端 readlink -f，只做子串判断、不回显。
export function classifyInstallKind(id, realPath) {
  const p = typeof realPath === "string" ? realPath : "";
  if (!p) return null;
  if (/\/node_modules\//.test(p)) return "npm";
  if (id === "codex" && p.includes("/.codex/packages/standalone/")) return "standalone";
  if (id === "claude" && p.includes("/.local/share/claude/versions/")) return "native";
  return "unknown";
}

// 版本比较（全仓唯一一份：探测、安装、/api/cli 的 updateAvailable、向导与前端口径都以这里为准）。
// 入参可以是 `--version` 原文或纯版本号（先经 parseVersionText 取出 x.y.z[-pre]）。
// 数字段逐段比；预发布版低于同号正式版，预发布段逐段比（数字按数值、数字段低于字母段）：
// a<b → -1，a==b → 0，a>b → 1；任一不可解析 → null。
export function compareVersions(a, b) {
  const pa = parseVersionText(a);
  const pb = parseVersionText(b);
  if (!pa || !pb) return null;
  const split = (v) => {
    const [core, pre = ""] = v.split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(pa);
  const y = split(pb);
  for (let i = 0; i < 3; i += 1) {
    if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// 已装版本落后于 latest 才算「可更新」；任一未知 → false。
export function isUpdateAvailable(installed, latest) {
  return compareVersions(installed, latest) === -1;
}
