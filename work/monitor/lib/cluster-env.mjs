// 集群侧受管配置（v2.54 第 1 期 W-C，设计稿 §5.C）：把散落在 ~/.bashrc / ~/.bash_profile / codex 包装脚本里、
// 互相覆盖的代理变量收敛成"一个受管文件 + 几处标记块"，并能检测、注释掉受管块以外的旧导出。
//
// 本文件全是纯函数：只产出"远端命令步骤列表"与解析/合并结果，不发 SSH、不碰本机文件。
// 命令行向导（scripts/setup/routing.mjs 的 configureClusterEnv）负责执行与交互；第 3 期 App 内引导
// 复用同一份步骤，只换执行器。远端写文件一律走 shell/remote-file.mjs 的单条原子命令（备份 + tmp + mv）。
// 交给 ssh 的每条命令（写入步骤、扫描、注释、回读 / 写回 settings.json、撤销）都经 shell/wrap-sh.mjs 包成
// `sh -c '<脚本>'`：对方登录 shell 是 tcsh / csh 时 if/elif/fi、2>/dev/null 都不是合法语法（v2.54 终审）。
//
// 引入位置（沿用 P2 的既定取舍）：
//   - ~/.bashrc 末尾：块内自带交互守卫，只对交互 shell 生效。无人值守的 `ssh 主机 命令`、cron 不继承
//     代理——隧道离线时那是一个死端口，会把 pip/git 等非交互命令全拖进超时。不少发行版的 .bashrc 顶部
//     没有"非交互即 return"（CentOS 默认就没有，新账号甚至没有 .bashrc），所以守卫放进块里，不依赖文件本身。
//   - 登录 shell（交互登录与 `bash -lc`，Codex App 远程靠这一路）：bash 只读 ~/.bash_profile、~/.bash_login、
//     ~/.profile 中第一个存在的，写进那一个（都不存在时建 ~/.profile）。kai 的 .bash_profile 不 source .bashrc，
//     所以两处都要写；两处都 source 时 env.sh 被读两次，内容幂等无副作用。
// 工作台自己的远端命令不靠这些块：显式 `. env.sh` 或带 tunnelProxyEnv 前缀。
//
// 代理口令（v2.62，credential = { user, password }）：给了它，env.sh 与 settings.json 里的代理地址写成
// http://用户:口令@127.0.0.1:<端口>。口令不得出现在任何命令行里（集群的 /proc 对所有账号可见），所以：
//   - 带口令的 env.sh 全文经标准输入送达（不带口令时照旧把 base64 内嵌进命令——那条路的输出逐字不变）；
//   - 预览、失败时给人复制的手动命令里，口令一律打码（maskProxyCredential）；
//   - 「这个地址是不是我们写的」按形状认（isManagedProxyUrl：不带口令，或用户名是我们固定的那个），
//     不拿具体口令去比——撤销与端口同步都不需要知道口令，换过口令的旧值也认得出来。
import { createHash } from "node:crypto";

import { isPort } from "./validators.mjs";
import {
  backupPath,
  buildRemoteReplaceFileCommand,
  buildRemoteReplaceFileFromStdinCommand,
  buildRemoteStripBlockCommand,
  buildRemoteUpsertCommand,
  markerLines,
} from "./shell/remote-file.mjs";
import { wrapSh } from "./shell/wrap-sh.mjs";

// 路径一律相对 $HOME；命令里写成 `~/…`（与 routing.mjs 既有写法一致，由远端 sh 做 tilde 展开，展开结果不再分词）。
export const CLUSTER_ENV_DIR = ".config/cluster-workbench";
export const CLUSTER_ENV_FILE = "env.sh";
export const CLUSTER_ENV_KEYS_DIR = "keys";
export const CLUSTER_ENV_PATH = `${CLUSTER_ENV_DIR}/${CLUSTER_ENV_FILE}`;
export const CLUSTER_ENV_MARKER = "cluster-workbench env";
// P2 旧向导（configureCodexRouting）写在 ~/.bashrc 与 codex 包装脚本里的代理块标记。
export const LEGACY_CODEX_PROXY_MARKER = "setup-wizard codex-proxy";
export const LEGACY_CODEX_WRAPPER = ".local/bin/codex";
// 注释掉散落导出时加的行首前缀；撤销时按它原样恢复，所以必须唯一、不能改。
export const STRAY_DISABLED_PREFIX = "# [cluster-workbench 已停用] ";
export const BASE_NO_PROXY = Object.freeze(["localhost", "127.0.0.1", "::1"]);
// 扫描 / 撤销覆盖的 shell 启动文件；LOGIN_RC_FILES 按 bash 登录 shell 的查找顺序排列。
export const SHELL_RC_FILES = Object.freeze([".bashrc", ".bash_profile", ".bash_login", ".profile"]);
export const LOGIN_RC_FILES = Object.freeze([".bash_profile", ".bash_login", ".profile"]);
export const CLAUDE_SETTINGS_FILE = ".claude/settings.json";
// settings.json 的 env 里归我们管的键：与 env.sh 同一组（大小写两套 + NO_PROXY）。
export const CLAUDE_PROXY_ENV_KEYS = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]);
const PROXY_URL_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
const NO_PROXY_KEYS = ["NO_PROXY", "no_proxy"];

// 远端只读探测的输出哨兵：区分"扫描完成但没找到"与"SSH 中途断了"。
export const STRAY_SCAN_DONE = "__CWB_STRAY_SCAN_DONE__";
const CLAUDE_PRESENCE = "__CWB_CLAUDE__=";

const MAX_NO_PROXY_EXTRA = 32;
// NO_PROXY 条目：主机名 / .域名 / IPv4 / [IPv6] / CIDR / host:port。逗号、引号、空白、$ 一律拒绝——
// 它会被原样写进 env.sh 的双引号里。
const NO_PROXY_ENTRY = /^[A-Za-z0-9.*:[\]/_-]{1,253}$/;

const home = (rel) => `~/${rel}`;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

// 代理口令（第 4 期加固才传）：userinfo 按 RFC 3986 百分号编码，结果只含 [A-Za-z0-9._~%-]，
// 放进 env.sh 的双引号、settings.json 的字符串都无需再转义。
function encodeUserinfo(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function clusterProxyUrl(port, credential) {
  if (!isPort(port)) throw new Error(`集群代理端口非法: ${port}`);
  let userinfo = "";
  if (credential != null) {
    const user = String(credential.user ?? "");
    if (!user) throw new Error("代理口令缺少用户名");
    userinfo = `${encodeUserinfo(user)}:${encodeUserinfo(credential.password ?? "")}@`;
  }
  return `http://${userinfo}127.0.0.1:${port}`;
}

// 受管的代理口令用户名（与 lib/proxy/auth.mjs 的 PROXY_AUTH_USER 同值；这里不 import 它——cluster-env 是
// 纯字符串模块，命令行向导与撤销脚本也在用，不该为一个常量把代理实现拖进来。两边的一致由测试钉住）。
export const MANAGED_PROXY_USER = "cwb";
// 我们会写出来的代理地址：http://127.0.0.1:<端口>，或 http://<用户>:<口令>@127.0.0.1:<端口>。
const MANAGED_PROXY_URL = /^http:\/\/(?:([A-Za-z0-9._~%-]+):([A-Za-z0-9._~%-]*)@)?127\.0\.0\.1:(\d{1,5})$/;

// → { port, hasCredential, user } | null（不是这个形状）。
export function parseManagedProxyUrl(value) {
  const m = typeof value === "string" ? MANAGED_PROXY_URL.exec(value) : null;
  if (!m) return null;
  const port = Number(m[3]);
  if (!isPort(port)) return null;
  return { port, hasCredential: m[1] !== undefined, user: m[1] ?? null };
}

// 这个值是不是我们为这个端口写的代理地址：不带口令的，或带着我们那个用户名的（口令是哪一个都算）。
// 别的用户名 = 用户自己配的认证代理，不是我们的。
export function isManagedProxyUrl(value, port) {
  const parsed = parseManagedProxyUrl(value);
  return Boolean(parsed) && parsed.port === Number(port) && (!parsed.hasCredential || parsed.user === MANAGED_PROXY_USER);
}

// 给人看的文本（预览、手动命令、日志）里把代理地址中的口令打码。
export function maskProxyCredential(text) {
  return String(text ?? "").replace(/(http:\/\/[A-Za-z0-9._~%-]+:)[A-Za-z0-9._~%-]*(@127\.0\.0\.1:\d{1,5})/g, "$1••••••$2");
}

// 「用户:口令」的指纹（sha256 的前 16 个十六进制字符）。集群侧的只读检测回报 env.sh 里那一份的同一种指纹
// （见 buildEnvPortReadCommand），本机拿当前 / 上一个口令各算一遍来对——整个过程口令不离开各自所在的机器。
export function credentialFingerprint(credential) {
  if (!credential?.user) return null;
  return createHash("sha256").update(`${encodeUserinfo(credential.user)}:${encodeUserinfo(credential.password ?? "")}`, "utf8").digest("hex").slice(0, 16);
}

// 整体重写 env.sh 时带不带代理口令（v2.64）。命令行向导（scripts/setup/routing.mjs）、App 内接入引导与登录引导
// （都经 cluster-env-sync 的 credentialForRewrite）、端口变更的自动同步共用这一条：
//   stored             本机存着的口令 { user, password } | null（没有口令文件、从没生成过、读不出来）
//   mode               本机的口令模式 "off" | "observe" | "enforce"；不传 = 只保住集群上已有的，不新加
//   clusterCredential  集群上那份 env.sh 带的口令：指纹 | "nohash" | "none"（没带，或没有这份文件）| null（不知道）
// 规则：本机没有口令 → 不带（与以前逐字相同）；口令模式打开着（只记录 / 强制）→ 带；模式是关 → 集群上原来带着
// 才带（曾经写过，留着，以后再打开不用重写）。集群上带没带读不出来时宁可带上：多带一个口令在任何模式下都不影响
// 出网，少带一个在「强制」下会让集群上新开的终端全部断网。
export function credentialForEnvRewrite({ stored = null, mode = "off", clusterCredential = null } = {}) {
  if (!stored?.user || !stored?.password) return null;
  if (mode === "observe" || mode === "enforce") return stored;
  return clusterCredential === "none" ? null : stored;
}

// 单条 NO_PROXY 条目是否合法（个人层 noProxyExtra 写入校验与登录引导共用同一把尺子）。
export function isNoProxyEntry(value) {
  return typeof value === "string" && NO_PROXY_ENTRY.test(value.trim());
}

// 个人层 noProxyExtra（{ [serverId]: string[] }，v2.57 第 2 期登录引导写入）→ 这台服务器的额外条目。
// 重跑 configureClusterEnv / 改写 env.sh 时都要带上，否则内网中转站会被重新塞回隧道（本机代理拒私网）。
// 形状不对时按"没有"处理：读取口径宽松，写入校验在 personal-config-write.mjs（控制面；它不进数据面指纹闭包，
// 所以这个字段不在 config-loader 的 PERSONAL_FIELDS 里——config 必须是个人层原始对象，不是合并后的运行配置）。
export function noProxyExtraFor(config, serverId) {
  const map = config?.noProxyExtra;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const list = map[serverId];
  return Array.isArray(list) ? list.filter(isNoProxyEntry).map((entry) => entry.trim()) : [];
}

// NO_PROXY = 本机回环三项 + 可直连的内网中转站（第 2 期登录引导经 relay-url 判定后传入）；去重保序。
export function renderNoProxy(noProxyExtra = []) {
  const list = [...BASE_NO_PROXY];
  const extra = Array.isArray(noProxyExtra) ? noProxyExtra : [];
  if (extra.length > MAX_NO_PROXY_EXTRA) throw new Error(`NO_PROXY 额外条目过多（${extra.length} > ${MAX_NO_PROXY_EXTRA}）`);
  for (const raw of extra) {
    const entry = String(raw ?? "").trim();
    if (!entry) continue;
    if (!NO_PROXY_ENTRY.test(entry)) throw new Error(`NO_PROXY 条目非法: ${entry}`);
    if (!list.includes(entry)) list.push(entry);
  }
  return list.join(",");
}

// 受管文件全文。POSIX sh 写法（~/.profile 可能被 dash 读），可被重复 source（幂等），
// 不依赖 set -e / set -u 的状态。只写 http://——本机代理不支持 SOCKS，kai 的 socks5h:// 覆盖
// 正是 `bash -i` 里 curl 全挂的原因，所以还要 unset ALL_PROXY / all_proxy。
export function renderClusterEnv({ port, noProxyExtra = [], credential } = {}) {
  const proxy = clusterProxyUrl(port, credential);
  const noProxy = renderNoProxy(noProxyExtra);
  return `# ~/${CLUSTER_ENV_PATH} —— 集群运维工作台受管文件：重跑配置向导会整体覆盖，请勿手改。
# 由 ~/.bashrc 末尾（交互 shell）与登录 shell 配置里的「${CLUSTER_ENV_MARKER}」标记块引入；
# 撤销：工作台设置页一键撤销，或删掉本目录与这两处标记块。
# 出网只走本账号专属反向隧道（端口 ${port}）；只用 http://，本机代理不支持 SOCKS。
export http_proxy="${proxy}"
export https_proxy="${proxy}"
export HTTP_PROXY="${proxy}"
export HTTPS_PROXY="${proxy}"
export no_proxy="${noProxy}"
export NO_PROXY="${noProxy}"
unset ALL_PROXY all_proxy
# 独立安装版 codex / claude 在 ~/.local/bin。
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# 登录凭证与 API key（每个文件 600、用 export 写法）；目录不存在或为空时 glob 不展开，[ -f ] 跳过。
for __cwb_env_file in "$HOME/${CLUSTER_ENV_DIR}/${CLUSTER_ENV_KEYS_DIR}"/*.env; do
  if [ -f "$__cwb_env_file" ]; then . "$__cwb_env_file"; fi
done
unset __cwb_env_file
`;
}

// 引入块（不含 marker 行，marker 由 buildRemoteUpsertCommand 包裹）。用 if/fi 而不是 `[ -f ] && .`：
// 放在文件末尾时后者在 env.sh 缺失时留下非零 $?，会被显示退出码的提示符当成"上一条命令失败"。
// interactiveOnly：~/.bashrc 用（见文件头"引入位置"）；登录 shell 配置不加，`bash -lc` 也要生效。
export function renderSourceBlock({ interactiveOnly = false } = {}) {
  const source = `if [ -f "$HOME/${CLUSTER_ENV_PATH}" ]; then . "$HOME/${CLUSTER_ENV_PATH}"; fi`;
  const line = interactiveOnly ? `case $- in *i*) ${source} ;; esac` : source;
  return `# 集群运维工作台：出网代理等受管设置（撤销见工作台设置页）\n${line}\n`;
}

// ---------------------------------------------------------------------------
// 写入步骤（configureClusterEnv 依次执行；任一 required 步骤失败即中止，绝不在受管配置
// 落地之前去注释旧导出——否则用户会在两者之间失去全部代理设置）。
// 每步 { id, required, title, done, command, manual, preview? }：command 已包成 `sh -c '…'`，直接交给 ssh；
// manual 是失败时给人复制的可读版本；preview 是写入内容的明文（command 里是 base64），供预览 / 界面展示。
// ---------------------------------------------------------------------------

function manualAppendBlock(file, block) {
  const { begin, end } = markerLines(CLUSTER_ENV_MARKER);
  return `# 追加到 ~/${file} 末尾（已有同名标记块时先删掉旧块）：\n${begin}\n${block.replace(/\n$/, "")}\n${end}`;
}

export function buildClusterEnvSteps({ port, noProxyExtra = [], credential } = {}) {
  const envContent = renderClusterEnv({ port, noProxyExtra, credential });
  const bashrcBlock = renderSourceBlock({ interactiveOnly: true });
  const loginBlock = renderSourceBlock();
  const upsert = (file, block) => buildRemoteUpsertCommand({ targetFile: home(file), blockContent: block, marker: CLUSTER_ENV_MARKER });
  // 登录 shell 配置在远端判定（与写入同一条命令，没有"先探测再写"的窗口）。
  const [first, second, fallback] = LOGIN_RC_FILES;
  const loginCommand = wrapSh([
    `if [ -f ${home(first)} ]; then`,
    upsert(first, loginBlock),
    `elif [ -f ${home(second)} ]; then`,
    upsert(second, loginBlock),
    "else",
    upsert(fallback, loginBlock),
    "fi",
  ]);
  const stripLegacy = wrapSh([
    buildRemoteStripBlockCommand({ targetFile: home(".bashrc"), marker: LEGACY_CODEX_PROXY_MARKER }),
    // 独立安装版 codex 是 ELF（或指向 ELF 的软链）：只处理 "#!" 开头的旧包装脚本。
    buildRemoteStripBlockCommand({ targetFile: home(LEGACY_CODEX_WRAPPER), marker: LEGACY_CODEX_PROXY_MARKER, requireShebang: true }),
  ].join(" && \\\n"));
  const { begin: legacyBegin, end: legacyEnd } = markerLines(LEGACY_CODEX_PROXY_MARKER);
  // 带口令时全文经标准输入送达（步骤多一个 input，执行方要把它交给 ssh 的标准输入）：命令文本里只有路径与
  // 字节数。权限从一开始就是 600（先建空的临时文件、收紧权限，再写内容）。给人看的 preview / manual 里口令打码。
  const shown = credential ? maskProxyCredential(envContent) : envContent;
  const writeEnv = credential
    ? {
        command: wrapSh(buildRemoteReplaceFileFromStdinCommand({ targetFile: home(CLUSTER_ENV_PATH), byteLength: Buffer.byteLength(envContent, "utf8"), mode: "600", dirMode: "700", backup: false })),
        input: envContent,
      }
    : { command: wrapSh(buildRemoteReplaceFileCommand({ targetFile: home(CLUSTER_ENV_PATH), content: envContent, mode: "600", dirMode: "700", backup: false })) };

  return [
    {
      id: "write-env",
      required: true,
      title: `写受管文件 ~/${CLUSTER_ENV_PATH}（目录 700、文件 600，原子替换）`,
      done: `已写入 ~/${CLUSTER_ENV_PATH}（反向端口 ${port}）`,
      preview: shown,
      ...writeEnv,
      manual: [
        `mkdir -p ~/${CLUSTER_ENV_DIR} && chmod 700 ~/${CLUSTER_ENV_DIR}`,
        `cat > ~/${CLUSTER_ENV_PATH} <<'EOF'`,
        shown.replace(/\n$/, ""),
        "EOF",
        `chmod 600 ~/${CLUSTER_ENV_PATH}`,
        ...(credential ? ["# 上面的口令已打码：手动写不了带口令的版本，请在工作台里重新点「把口令写到集群」。"] : []),
      ].join("\n"),
    },
    {
      id: "source-bashrc",
      required: true,
      title: "在 ~/.bashrc 末尾引入受管文件（块内带交互守卫，只对交互 shell 生效）",
      done: "已在 ~/.bashrc 末尾写入引入块（旧文件已备份）",
      preview: bashrcBlock,
      command: wrapSh(upsert(".bashrc", bashrcBlock)),
      manual: manualAppendBlock(".bashrc", bashrcBlock),
    },
    {
      id: "source-login",
      required: true,
      title: `在登录 shell 配置里引入受管文件（~/${first} → ~/${second} → ~/${fallback}，取第一个存在的）`,
      done: `已在登录 shell 配置（~/${first} / ~/${second} / ~/${fallback} 中第一个存在的）末尾写入引入块`,
      preview: loginBlock,
      command: loginCommand,
      manual: manualAppendBlock(`${first}（没有时用 ~/${fallback}）`, loginBlock),
    },
    {
      id: "strip-legacy",
      required: false,
      title: `剥离 P2 旧向导写在 ~/.bashrc 与 ~/${LEGACY_CODEX_WRAPPER}（仅 shell 包装脚本）里的「${LEGACY_CODEX_PROXY_MARKER}」块`,
      done: "已清理旧向导的代理块（没有则不动、不备份）",
      command: stripLegacy,
      manual: `删掉 ~/.bashrc 与 ~/${LEGACY_CODEX_WRAPPER} 里从「${legacyBegin}」到「${legacyEnd}」的行（含这两行）。`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 散落的旧代理导出：只读扫描 → 解析 → 用户确认后按文件注释掉
// ---------------------------------------------------------------------------

// 一次 grep 同时取出"导出行"与两种受管标记行，parseStrayProxyExports 据标记行排除块内的行。
// 文件名用相对 $HOME 的短名（cd 之后再 grep），解析侧只认 SHELL_RC_FILES 白名单。
const STRAY_GREP_PATTERN = `^[[:space:]]*export[[:space:]].*(http|https|all)_proxy=|^# (>>>|<<<) (${CLUSTER_ENV_MARKER}|${LEGACY_CODEX_PROXY_MARKER}) (>>>|<<<)$`;
const STRAY_EXPORT = /^\s*export\s+(?:.*\s)?(?:http|https|all)_proxy=/i;

export function buildStrayScanCommand() {
  return wrapSh(`cd "$HOME" && for f in ${SHELL_RC_FILES.join(" ")}; do if [ -f "$f" ]; then grep -nHiE '${STRAY_GREP_PATTERN}' "$f"; fi; done; echo ${STRAY_SCAN_DONE}`);
}

// 接受 ".bashrc" / "~/.bashrc" / "./.bashrc"，只放行白名单里的启动文件，其余返回 null。
function normalizeRcFile(file) {
  const name = String(file ?? "").trim().replace(/^~\//, "").replace(/^\.\//, "");
  return SHELL_RC_FILES.includes(name) ? name : null;
}

// grep -nH 输出（`文件:行号:原文`）→ 受管块以外、真正生效的 http/https/all 代理导出：
// [{ file, line, text }]。注释行、受管块（含 P2 旧块——它会被同一轮剥离）内的行、白名单外的
// 文件一律不算；行尾注释先去掉再判断，避免 `export FOO=1 # 旧 http_proxy=…` 误报。
export function parseStrayProxyExports(grepText) {
  const managed = new Set([CLUSTER_ENV_MARKER, LEGACY_CODEX_PROXY_MARKER]);
  const inBlock = new Map();
  const strays = [];
  for (const raw of String(grepText ?? "").split(/\r?\n/)) {
    const m = raw.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const file = normalizeRcFile(m[1]);
    if (!file) continue;
    const text = m[3];
    const marker = text.match(/^# (>>>|<<<) (.+) \1$/);
    if (marker && managed.has(marker[2])) {
      inBlock.set(file, marker[1] === ">>>");
      continue;
    }
    if (inBlock.get(file)) continue;
    if (!STRAY_EXPORT.test(text.replace(/\s#.*$/, ""))) continue;
    strays.push({ file, line: Number(m[2]), text });
  }
  return strays;
}

// 按文件分组（保序），供逐文件生成注释命令。
export function groupStraysByFile(strays = []) {
  const groups = new Map();
  for (const s of strays) {
    if (!groups.has(s.file)) groups.set(s.file, []);
    groups.get(s.file).push(s.line);
  }
  return [...groups].map(([file, lines]) => ({ file, lines }));
}

// ---------------------------------------------------------------------------
// 工具级私有配置（.npmrc / .gitconfig / .curlrc）遗留 127.0.0.1:<port> 代理只读扫描
// ---------------------------------------------------------------------------

export const TOOL_PROXY_FILES = Object.freeze([".npmrc", ".gitconfig", ".curlrc"]);
export const TOOL_PROXY_SCAN_DONE = "__CWB_TOOL_PROXY_SCAN_DONE__";
const TOOL_PROXY_GREP_PATTERN = `^[[:space:]]*(https?-proxy|proxy)[[:space:]]*[:=[:space:]].*(http|https|socks5h?)://([^@/[[:space:]]]+@)?127\\.0\\.0\\.1:[0-9]+`;
const TOOL_PROXY_LINE = /^\s*(?:https?-proxy|proxy)\s*(?:[:=]|\s)\s*["']?(https?|socks5h?):\/\/(?:[^@/\s"']+@)?127\.0\.0\.1:(\d{1,5})\b/i;

export function buildLegacyToolProxyScanCommand() {
  return wrapSh(
    `cd "$HOME" && for f in ${TOOL_PROXY_FILES.join(" ")}; do if [ -f "$f" ]; then grep -nHiE '${TOOL_PROXY_GREP_PATTERN}' "$f" || true; fi; done; echo ${TOOL_PROXY_SCAN_DONE}`,
  );
}

// 解析 grep -nH 输出 → [{ file, line, scheme, port, text }]。
// 传了 expectedPort 时，若已是 http://<127.0.0.1>:<expectedPort> 则视为同端口一致，不列入遗留冲突；
// 凡是 socks5/socks5h 或端口不等于 expectedPort 的一律报出。
export function parseLegacyToolProxies(grepText, { expectedPort = null } = {}) {
  const results = [];
  const targetPort = isPort(expectedPort) ? Number(expectedPort) : null;
  for (const raw of String(grepText ?? "").split(/\r?\n/)) {
    const m = raw.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    const file = String(m[1] ?? "").trim().replace(/^~\//, "").replace(/^\.\//, "");
    if (!TOOL_PROXY_FILES.includes(file)) continue;
    const text = m[3];
    if (/^\s*[#;]/.test(text) || /^\s*\/\//.test(text)) continue;
    const hit = text.match(TOOL_PROXY_LINE);
    if (!hit) continue;
    const scheme = hit[1].toLowerCase();
    const port = Number(hit[2]);
    if (!isPort(port)) continue;
    if (targetPort !== null && scheme === "http" && port === targetPort) continue;
    results.push({ file, line: Number(m[2]), scheme, port, text });
  }
  return results;
}

// 给指定行加 STRAY_DISABLED_PREFIX 前缀（先备份；tmp 继承原权限后 mv）。awk 里再核对一次该行
// 仍是代理导出：扫描与执行之间文件若被改动、行号错位，错位到的非导出行原样保留，不会误注释
// （kai 的 .bashrc 第 144 行是含 /public/slurm/bin 的 PATH，紧挨着要注释的 145 行）。已注释的行
// 以 # 开头、不再匹配，所以重复执行幂等。
export function buildCommentOutCommand(file, lines) {
  const name = normalizeRcFile(file);
  if (!name) throw new Error(`只处理 shell 启动文件（${SHELL_RC_FILES.join(" / ")}）: ${file}`);
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length || !list.every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error(`行号非法: ${JSON.stringify(lines)}`);
  const nums = [...new Set(list)].sort((a, b) => a - b);
  const target = home(name);
  const tmp = `${target}.tmp.$$`;
  const program = `index(L, "," FNR ",") && tolower($0) ~ /^[ \\t]*export[ \\t].*(http|https|all)_proxy=/ { print p $0; next } { print }`;
  return wrapSh(
    [
      `cp -p ${target} ${backupPath(target)}`,
      `cp -p ${target} ${tmp}`,
      `awk -v L=",${nums.join(",")}," -v p="${STRAY_DISABLED_PREFIX}" '${program}' ${target} > ${tmp}`,
      `mv ${tmp} ${target}`,
    ].join(" && \\\n"),
  );
}

// 撤销用：去掉 STRAY_DISABLED_PREFIX，恢复被注释的原行（只动行首正好是该前缀的行）。返回 sh 片段，
// 由 buildUndoCommands 拼好后统一 wrapSh。
function buildRestoreStrayCommand(file) {
  const target = home(file);
  const tmp = `${target}.tmp.$$`;
  const bre = `^${STRAY_DISABLED_PREFIX.replace(/[.[\]*^$\\/]/g, "\\$&")}`;
  return `if [ -f ${target} ] && grep -q '${bre}' ${target}; then cp -p ${target} ${backupPath(target)} && cp -p ${target} ${tmp} && sed 's/${bre}//' ${target} > ${tmp} && mv ${tmp} ${target}; fi`;
}

// ---------------------------------------------------------------------------
// Claude Code：~/.claude/settings.json 的 env 合并
// ---------------------------------------------------------------------------

// 一次只读 SSH：集群上有 claude（独立安装 / PATH 里 / 有 ~/.claude 目录）才回读 settings.json。
export const CLAUDE_SETTINGS_READ_COMMAND = wrapSh(
  `if [ -e "$HOME/.local/bin/claude" ] || command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; then echo ${CLAUDE_PRESENCE}1; if [ -f "$HOME/${CLAUDE_SETTINGS_FILE}" ]; then cat "$HOME/${CLAUDE_SETTINGS_FILE}"; fi; else echo ${CLAUDE_PRESENCE}0; fi`,
);

// → { present, text } | null（没看到哨兵行：SSH 没到远端或输出被截断）。哨兵前若有 rc 文件打印的杂音一并忽略。
export function parseClaudeSettingsRead(stdout) {
  const s = String(stdout ?? "");
  const m = s.match(new RegExp(`^${CLAUDE_PRESENCE}([01])\\r?$`, "m"));
  if (!m) return null;
  if (m[1] === "0") return { present: false, text: "" };
  const rest = s.slice(m.index + m[0].length);
  return { present: true, text: rest.startsWith("\n") ? rest.slice(1) : rest };
}

export function claudeSettingsProxyEnv({ port, noProxyExtra = [], credential } = {}) {
  const proxy = clusterProxyUrl(port, credential);
  const noProxy = renderNoProxy(noProxyExtra);
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy };
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// 写回时沿用原文件的排版（v2.54 终审）：合并 / 撤销只改几个键，不该把用户手写的 4 空格 / 制表符缩进
// 整体改成 2 空格。缩进取原文第一处行首缩进（JSON 字符串里不会有裸换行，行首空白必是排版）；原文是单行
// 紧凑 JSON 时仍写单行；探测不到（空文件 / `{}`）用 2 空格——Claude Code 自己的写法。换行符（LF / CRLF）
// 与末尾是否带换行都跟原文一致；空文件新建时带末尾换行。
function detectJsonIndent(raw) {
  const m = raw.match(/\n([ \t]+)\S/);
  if (m) return m[1];
  const trimmed = raw.trim();
  if (trimmed && !trimmed.includes("\n") && !/^\{\s*\}$/.test(trimmed)) return "";
  return 2;
}

function stringifyLike(original, value) {
  const raw = String(original ?? "");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, detectJsonIndent(raw));
  const trailing = !raw.trim() || /\n[ \t]*$/.test(raw) ? eol : "";
  return `${eol === "\n" ? body : body.replaceAll("\n", eol)}${trailing}`;
}

// 空白 / 不存在 → 空对象起步；非法 JSON、顶层不是对象、env 存在但不是对象 → null（调用方跳过，绝不覆盖写坏）。
function parseSettings(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.env !== undefined && !isPlainObject(parsed.env)) return null;
  return parsed;
}

function proxyPortOf(value) {
  try {
    const port = new URL(String(value)).port;
    return port ? Number(port) : null;
  } catch {
    return null;
  }
}

// reclaude 接管判据（kai 现状：HTTPS_PROXY=http://127.0.0.1:40161 + NODE_EXTRA_CA_CERTS=…/.reclaude/ca.pem）：
// NODE_EXTRA_CA_CERTS 含 .reclaude，且 HTTPS_PROXY（或小写）指向别的端口（含解析不出端口——从严当作别人的）。
// 这时 Claude 的流量本就该进 reclaude，改成隧道端口会绕过它、证书也对不上。
export function isReclaudeManagedClaudeEnv(env, port) {
  if (!isPlainObject(env)) return false;
  const ca = env.NODE_EXTRA_CA_CERTS;
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  if (typeof ca !== "string" || !ca.includes(".reclaude")) return false;
  if (typeof https !== "string" || !https.trim()) return false;
  return proxyPortOf(https) !== port;
}

// settings.json 全文 → { text, changed, changedKeys } | { skipped: "reclaude-managed" | "invalid-json" }。
// 只覆盖 CLAUDE_PROXY_ENV_KEYS，其余顶层键（hooks、enabledPlugins…）与 env 里的其它键原样保留、顺序不变，
// 缩进与换行沿用原文（stringifyLike）；
// 已是目标值时 changed=false 且原文返回（调用方据此不写、不留无谓的备份）。
export function mergeClaudeSettingsEnv(text, { port, noProxyExtra = [], credential } = {}) {
  const parsed = parseSettings(text);
  if (!parsed) return { skipped: "invalid-json" };
  if (isReclaudeManagedClaudeEnv(parsed.env, port)) return { skipped: "reclaude-managed" };
  const patch = claudeSettingsProxyEnv({ port, noProxyExtra, credential });
  const env = isPlainObject(parsed.env) ? parsed.env : {};
  const changedKeys = CLAUDE_PROXY_ENV_KEYS.filter((k) => env[k] !== patch[k]);
  if (!changedKeys.length) return { text: String(text ?? ""), changed: false, changedKeys };
  const next = { ...parsed, env: { ...env, ...patch } };
  return { text: stringifyLike(text, next), changed: true, changedKeys };
}

// 通用 env 补丁（v2.57 第 2 期 Claude API 登录用）：set 里的键覆盖写入、unset 里的键删除，其余键与顶层
// 字段原样保留，排版沿用原文（与 mergeClaudeSettingsEnv 同一套 stringifyLike）。reclaude 接管判定由调用方
// 先做（它需要端口与"拒绝并说明"的措辞）；这里只管合并。值必须是字符串。
// → { text, changed, changedKeys } | { skipped: "invalid-json" }
export function patchClaudeSettingsEnv(text, { set = {}, unset = [] } = {}) {
  const parsed = parseSettings(text);
  if (!parsed) return { skipped: "invalid-json" };
  const env = isPlainObject(parsed.env) ? { ...parsed.env } : {};
  const changedKeys = [];
  for (const [key, value] of Object.entries(set)) {
    if (typeof value !== "string") throw new Error(`settings.json env 值必须是字符串: ${key}`);
    if (env[key] !== value) {
      env[key] = value;
      changedKeys.push(key);
    }
  }
  for (const key of unset) {
    if (Object.hasOwn(env, key) && !Object.hasOwn(set, key)) {
      delete env[key];
      changedKeys.push(key);
    }
  }
  if (!changedKeys.length) return { text: String(text ?? ""), changed: false, changedKeys };
  const next = { ...parsed, env };
  if (!Object.keys(env).length) delete next.env;
  return { text: stringifyLike(text, next), changed: true, changedKeys };
}

// 解析 settings.json 全文 → env 对象（无 env 时 {}）；非法 JSON / 形状不对 → null。供登录引导先做 reclaude 判定。
export function readClaudeSettingsEnv(text) {
  const parsed = parseSettings(text);
  if (!parsed) return null;
  return isPlainObject(parsed.env) ? parsed.env : {};
}

// 撤销：只删值仍等于我们写入值的代理键（用户事后改过的不动）。NO_PROXY 在至少删掉一个代理地址键时才连带删，
// 且它的每一项都得是我们会写的（本机回环三项 + 当前 noProxyExtra 的任意子集——登录引导会往里加，写入时可能
// 比现在少）；出现我们不认识的条目 = 用户自己追加过，整个键原样保留。env 删空则去掉 env 本身。
export function removeClaudeSettingsEnv(text, { port, noProxyExtra = [], credential } = {}) {
  const parsed = parseSettings(text);
  if (!parsed) return { skipped: "invalid-json" };
  const env = isPlainObject(parsed.env) ? { ...parsed.env } : null;
  if (!env) return { text: String(text ?? ""), changed: false, removedKeys: [] };
  const ours = claudeSettingsProxyEnv({ port, noProxyExtra, credential });
  // 代理地址按形状认（v2.62）：不带口令的、带我们那个用户名的（无论哪一个口令——换过口令、或撤销方根本
  // 不知道口令，都认得出来）都是我们写的；端口对不上、用户名是别的 = 用户改过，不动。
  const removedKeys = PROXY_URL_KEYS.filter((k) => isManagedProxyUrl(env[k], port));
  if (removedKeys.length) {
    const known = new Set([...BASE_NO_PROXY, ...(Array.isArray(noProxyExtra) ? noProxyExtra : [])]);
    const allOurs = (value) => typeof value === "string" && value.split(",").every((entry) => known.has(entry.trim()));
    for (const k of NO_PROXY_KEYS) {
      if (env[k] === ours[k] || allOurs(env[k])) removedKeys.push(k);
    }
  }
  if (!removedKeys.length) return { text: String(text ?? ""), changed: false, removedKeys };
  for (const k of removedKeys) delete env[k];
  const next = { ...parsed, env };
  if (!Object.keys(env).length) delete next.env;
  return { text: stringifyLike(text, next), changed: true, removedKeys };
}

// 回读输出 → 下一步动作（向导与 App 共用）：
//   { action: "skip", reason: "no-claude" | "reclaude-managed" | "invalid-json" }
//   { action: "unchanged" } | { action: "error", reason: "unreadable" }
//   { action: "write", command, input, changedKeys }——内容经标准输入送达（见 buildRemoteReplaceFileFromStdinCommand；
//   包进 sh -c 后标准输入照样由 sh 继承给其中的 cat）。
// secret：写进去的内容带代理口令——文件与这次留下的备份都收紧到 600（集群 umask 是 0002，settings.json
// 可能是 664；不带口令时照旧沿用原权限，命令逐字不变）。
function planSettingsEdit(readStdout, edit, { secret = false } = {}) {
  const read = parseClaudeSettingsRead(readStdout);
  if (!read) return { action: "error", reason: "unreadable" };
  if (!read.present) return { action: "skip", reason: "no-claude" };
  const result = edit(read.text);
  if (result.skipped) return { action: "skip", reason: result.skipped };
  if (!result.changed) return { action: "unchanged" };
  return {
    action: "write",
    command: wrapSh(buildRemoteReplaceFileFromStdinCommand({ targetFile: home(CLAUDE_SETTINGS_FILE), byteLength: Buffer.byteLength(result.text, "utf8"), ...(secret ? { mode: "600" } : {}) })),
    input: result.text,
    changedKeys: result.changedKeys ?? result.removedKeys,
  };
}

export function planClaudeSettingsMerge(readStdout, opts = {}) {
  return planSettingsEdit(readStdout, (text) => mergeClaudeSettingsEnv(text, opts), { secret: Boolean(opts.credential) });
}

export function planClaudeSettingsRemoval(readStdout, opts = {}) {
  return planSettingsEdit(readStdout, (text) => removeClaudeSettingsEnv(text, opts));
}

// ---------------------------------------------------------------------------
// env.sh 现在指向哪个端口（只读；改端口后的同步与"集群配置和隧道端口不一致"的检测共用）
// ---------------------------------------------------------------------------

const ENV_PORT_MARK = "__CWB_ENV_PORT__=";
const ENV_CRED_MARK = "__CWB_ENV_CRED__=";

// 输出一行 __CWB_ENV_PORT__=<端口> | absent（没有受管 env.sh）| unknown（文件在，但没有我们写的那一行）。
// 只认我们自己渲染的形状（renderClusterEnv：export HTTPS_PROXY="http://[口令@]127.0.0.1:<端口>"）。
// 文件在时再输出一行 __CWB_ENV_CRED__=none | <16 位十六进制> | nohash（v2.62）：那一行带没带口令；带了就报
// 「用户:口令」的 sha256 前 16 位（与本机 credentialFingerprint 同一算法），没有 sha256sum / shasum 时报 nohash。
// 口令从 sed 经管道直接进哈希程序，不进变量、不进任何命令的参数——节点上别人用 ps 看不到它。
export function buildEnvPortReadCommand() {
  const file = `"$HOME/${CLUSTER_ENV_PATH}"`;
  return wrapSh([
    `if [ ! -f ${file} ]; then echo ${ENV_PORT_MARK}absent; exit 0; fi`,
    String.raw`p=$(sed -n 's/^export HTTPS_PROXY="http:\/\/\([^"@]*@\)\{0,1\}127\.0\.0\.1:\([0-9][0-9]*\)"$/\2/p' ${file} | head -n 1)`,
    `echo ${ENV_PORT_MARK}"\${p:-unknown}"`,
    String.raw`if grep -q '^export HTTPS_PROXY="http://[^"@]*@127\.0\.0\.1:[0-9][0-9]*"$' ${file}; then`,
    String.raw`h=$(sed -n 's/^export HTTPS_PROXY="http:\/\/\([^"@]*\)@127\.0\.0\.1:[0-9][0-9]*"$/\1/p' ${file} | head -n 1 | tr -d '\n' | { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | cut -c1-16)`,
    `echo ${ENV_CRED_MARK}"\${h:-nohash}"`,
    `else echo ${ENV_CRED_MARK}none`,
    "fi",
  ]);
}

// → "none"（没带口令）| 16 位十六进制指纹 | "nohash"（带了，但集群上算不出指纹）| null（没有这一行：
// env.sh 不存在、输出被截断，或对面是还没有这一行的旧版本）。
export function parseEnvCredentialRead(stdout) {
  const m = String(stdout ?? "").match(new RegExp(`^${ENV_CRED_MARK}(\\S+)\\r?$`, "m"));
  if (!m) return null;
  if (m[1] === "none" || m[1] === "nohash") return m[1];
  return /^[0-9a-f]{16}$/.test(m[1]) ? m[1] : null;
}

// → { present, port } | null（没看到哨兵行：SSH 没到远端或输出被截断）。present 且 port 为 null = 文件被改得认不出来。
export function parseEnvPortRead(stdout) {
  const m = String(stdout ?? "").match(new RegExp(`^${ENV_PORT_MARK}(\\S+)\\r?$`, "m"));
  if (!m) return null;
  if (m[1] === "absent") return { present: false, port: null };
  const port = /^\d{1,5}$/.test(m[1]) ? Number(m[1]) : null;
  return { present: true, port: port !== null && port >= 1 && port <= 65535 ? port : null };
}

// ---------------------------------------------------------------------------
// 撤销（编排在 onboarding-guide/undo.mjs：命令行 `npm run setup:undo` 与配置 →「接入引导」下面的「撤销接入」共用同一份步骤）
// ---------------------------------------------------------------------------

// 删 env.sh、keys/、各标记块、settings.json 里我们写的键，并恢复被注释掉的旧导出。
// kind "remote"：直接执行 command；kind "settings-edit"：先执行 readCommand，把输出交给 plan(stdout)
// 得到与 planClaudeSettingsMerge 同形的动作（write 时带 command + input）。
export function buildUndoCommands({ port, noProxyExtra = [], credential } = {}) {
  const opts = { port, noProxyExtra, credential };
  const stripBlocks = wrapSh(
    SHELL_RC_FILES.map((file) => buildRemoteStripBlockCommand({ targetFile: home(file), marker: CLUSTER_ENV_MARKER })).join(" && \\\n"),
  );
  const restore = wrapSh(SHELL_RC_FILES.map(buildRestoreStrayCommand).join(" && \\\n"));
  const removeFiles = wrapSh(`rm -f ~/${CLUSTER_ENV_PATH} && rm -rf ~/${CLUSTER_ENV_DIR}/${CLUSTER_ENV_KEYS_DIR} && { rmdir ~/${CLUSTER_ENV_DIR} 2>/dev/null || true; }`);
  return [
    { id: "strip-source-blocks", kind: "remote", title: `删除各 shell 启动文件里的「${CLUSTER_ENV_MARKER}」引入块`, command: stripBlocks },
    { id: "remove-env", kind: "remote", title: `删除 ~/${CLUSTER_ENV_PATH} 与 keys/（含其中的 API key）`, command: removeFiles },
    { id: "restore-strays", kind: "remote", title: `恢复当初被注释掉的旧代理导出（去掉行首「${STRAY_DISABLED_PREFIX.trim()}」）`, command: restore },
    {
      id: "claude-settings",
      kind: "settings-edit",
      title: `从 ~/${CLAUDE_SETTINGS_FILE} 的 env 里删除我们写入的代理键（值被改过的保留）`,
      readCommand: CLAUDE_SETTINGS_READ_COMMAND,
      plan: (stdout) => planClaudeSettingsRemoval(stdout, opts),
    },
  ];
}
