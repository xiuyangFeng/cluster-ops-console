// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 这里的 ${…} 是远端 sh 的参数展开（${cur##*/} 等），不是漏写的模板串
// CLI 安装 / 更新 / 回滚的远端命令（第 2 期 P-D）：全是纯函数，产出已经 wrapSh 包好的 `sh -c '…'` 命令串
// （对方登录 shell 可能是 tcsh / csh，见 shell/wrap-sh.mjs），以及远端 key=value 输出的解析。
// 官方下载源、布局与校验方式的核实结论见 ./sources.mjs 文件头；这里按那份结论复刻官方安装器的落盘动作。
//
// 远端工作目录 `~/.cache/cluster-workbench/cli/`（缓存性质，撤销受管配置时不必管它）：
//   jobs/<jobId>/   首选路径的后台任务：job.sh、log、pid（任务自己写的 $$）、spawnpid、started、exit、tmp/
//   upload/         回退路径上传的产物（.part 写完核对字节数与 sha256 才改名）
//   <cli>.previous  切换前的版本（codex 是 release 目录名，Claude 是版本号），回滚默认切回它
//
// 插进脚本的值（版本号、release 名、文件名、sha256、jobId、字节数）一律先过白名单正则，不合法即抛错——
// 远端脚本里没有任何未经校验的外部字符串。远端输出一律当不可信数据：只认 key=value，值去控制字符、截断。
// 失败原因只回 ASCII 代号（fail <code>），中文说明在本机按代号翻译（FAIL_TEXT）。
import { codexReleaseName, isSha256 } from "./sources.mjs";
import { isStrictVersion } from "./versions.mjs";
import { CLAUDE_INSTALL_SCRIPT_URL, CODEX_INSTALL_SCRIPT_URL } from "./sources.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export const REMOTE_CLI_DIR = "$HOME/.cache/cluster-workbench/cli";
export const REMOTE_ENV_FILE = "$HOME/.config/cluster-workbench/env.sh";
// env.sh 末尾 source 的密钥目录（keys/*.env：中转站 API key、CLAUDE_CODE_OAUTH_TOKEN）。
export const REMOTE_KEYS_DIR = "$HOME/.config/cluster-workbench/keys";
// 家目录剩余空间下限（KB）：codex 包 160MB + 解开约 450MB；Claude 上传 250MB + versions 里 250MB。
export const MIN_FREE_KB = Object.freeze({ codex: 800 * 1024, claude: 600 * 1024 });

const JOB_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const RELEASE_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:x86_64|aarch64)-unknown-linux-musl$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,128}$/;

function argError(message) {
  return Object.assign(new Error(message), { code: "EARG" });
}
function assertCli(cli) {
  if (cli !== "codex" && cli !== "claude") throw argError(`未知 CLI: ${cli}`);
}
function assertVersion(v) {
  if (!isStrictVersion(v)) throw argError(`版本号非法: ${v}`);
}
export const isJobId = (v) => typeof v === "string" && JOB_ID.test(v);
function assertJobId(id) {
  if (!isJobId(id)) throw argError(`jobId 非法: ${id}`);
}
export const isReleaseName = (v) => typeof v === "string" && RELEASE_NAME.test(v);

// ---------------------------------------------------------------------------
// 共用 shell 片段（每个元素一行，满足 wrapSh 的续行约束：无整行注释、无 heredoc、case 写在一行里）
// ---------------------------------------------------------------------------

const SHA256_FN = [
  "sha256_of() {",
  "if command -v sha256sum >/dev/null 2>&1; then sha256sum \"$1\" | awk '{print $1}'; else shasum -a 256 \"$1\" | awk '{print $1}'; fi",
  "}",
];

// swap_link <链接> <目标> <临时名>：先建临时软链再 rename 覆盖（同官方安装器 replace_path_with_symlink：
// GNU 的 mv -T、BSD 的 mv -h 都不跟随指向目录的旧软链；都没有时退回删了再挪）。
const SWAP_LINK_FN = [
  "swap_link() {",
  "rm -f \"$3\"",
  "ln -s \"$2\" \"$3\" || return 1",
  "mv -Tf \"$3\" \"$1\" 2>/dev/null || mv -hf \"$3\" \"$1\" 2>/dev/null || { rm -f \"$1\" && mv -f \"$3\" \"$1\"; }",
  "}",
];

// 从任务目录读 pid（v2.57 终审）：read_pid <目录> → 任务自己写的 pid 优先，读不到或不合法时退回启动时记下的
// spawnpid；两个都不合法则 p 置空、返回非零。只认「纯数字、不以 0 开头、大于 1」：pid 文件若被写坏或被改成
// 0 / 1 / -1，`kill -- -$p` 会打到自己所在的进程组、init 乃至本账号的全部进程；多行 / 带空白 / 超长的值
// 同样拒绝（超长时 `[ -gt ]` 报错即非零）。所有「读文件得到 pid 再 kill」的地方都经它。
const READ_PID_FN = [
  "valid_pid() { case \"$1\" in ''|0*|*[!0-9]*) return 1 ;; esac; [ \"$1\" -gt 1 ] 2>/dev/null; }",
  "read_pid() { p=$(cat \"$1/pid\" 2>/dev/null); if valid_pid \"$p\"; then return 0; fi; p=$(cat \"$1/spawnpid\" 2>/dev/null); if valid_pid \"$p\"; then return 0; fi; p=; return 1; }",
];

// 一行版本串：去掉不可打印字符、截断。
const ONE_LINE = "head -n 1 | tr -cd '[:print:]' | cut -c1-120";

function failFn(cleanup = "") {
  return [
    "fail() {",
    ...(cleanup ? [cleanup] : []),
    "echo \"result=failed\"",
    "echo \"detail=$1\"",
    "echo \"end=1\"",
    "exit 0",
    "}",
  ];
}

// 本机给 fail 代号的中文说明。
export const FAIL_TEXT = Object.freeze({
  "upload-missing": "上传到集群的文件不见了",
  checksum: "集群上复核校验和不符",
  mkdir: "集群上建目录失败（权限或磁盘满）",
  locked: "官方安装器正在运行（安装锁被占用），稍后再试",
  unpack: "集群上解包失败（磁盘满或文件损坏）",
  layout: "解包后的目录结构不完整",
  smoke: "新版本在集群上运行 --version 失败",
  move: "集群上移动文件失败",
  "move-restore": "集群上移动文件失败，原来的目录也没能挪回去：它留在 releases 目录下的 .old.<版本>.<数字> 里，需要手动改回原名",
  link: "集群上切换软链失败",
  final: "切换后 PATH 里的命令报的版本不对，已切回原版本",
  "no-target": "没有可回滚的旧版本",
  "bad-target": "要回滚的版本不存在或不完整",
});

// ---------------------------------------------------------------------------
// 预检：架构 / 工具 / 剩余空间 / 受管配置 / 现有安装 / npm 全局安装 / 在跑的首选路径任务（只读）
// ---------------------------------------------------------------------------

function npmScanLines(name) {
  const candidates = [
    `"$HOME"/.local/node*/bin/${name}`,
    `"$HOME"/.nvm/versions/node/*/bin/${name}`,
    `"$HOME"/.npm-global/bin/${name}`,
    `"$HOME"/.local/lib/node_modules/.bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ].join(" ");
  return [
    `for f in ${candidates}; do if [ -e "$f" ]; then t=$(readlink "$f" 2>/dev/null); case "$t" in *node_modules*) echo "npm=$f" ;; *) if head -c 200 "$f" 2>/dev/null | grep -q node; then echo "npm=$f"; fi ;; esac; fi; done`,
  ];
}

// extraLines：调用方追加的只读探测行（如团队缓存列表 team-cache.mjs 的 cacheListLines），放在 end=1 之前。
export function buildPreflightCommand(cli, { extraLines = [] } = {}) {
  assertCli(cli);
  const common = [
    `B="${REMOTE_CLI_DIR}"`,
    "echo \"v=1\"",
    "echo \"arch=$(uname -m | tr -cd 'A-Za-z0-9_-')\"",
    "if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] || ldd /bin/ls 2>&1 | grep -q musl; then echo \"musl=1\"; else echo \"musl=0\"; fi",
    `if [ -f "${REMOTE_ENV_FILE}" ]; then echo "envsh=1"; else echo "envsh=0"; fi`,
    "echo \"freekb=$(df -Pk \"$HOME\" 2>/dev/null | awk 'NR==2 {print $4}' | tr -cd '0-9')\"",
    "for t in curl tar bash setsid flock base64; do if command -v \"$t\" >/dev/null 2>&1; then echo \"has.$t=1\"; else echo \"has.$t=0\"; fi; done",
    ...READ_PID_FN,
    `if [ -d "$B/jobs" ]; then for d in "$B"/jobs/*; do if [ -f "$d/cli" ] && [ "$(cat "$d/cli")" = "${cli}" ] && [ ! -f "$d/exit" ]; then if read_pid "$d" && kill -0 "$p" 2>/dev/null; then echo "running=\${d##*/}"; fi; fi; done; fi`,
  ];
  const layout = cli === "codex"
    ? [
      "R=\"${CODEX_HOME:-$HOME/.codex}/packages/standalone\"",
      "cur=$(readlink \"$R/current\" 2>/dev/null)",
      "if [ -n \"$cur\" ]; then echo \"current=${cur##*/}\"; fi",
      "if [ -d \"$R/releases\" ]; then for d in \"$R\"/releases/*; do if [ -x \"$d/bin/codex\" ] && [ -f \"$d/codex-package.json\" ]; then echo \"release=${d##*/}\"; fi; done; fi",
      "if [ -L \"$HOME/.local/bin/codex\" ]; then echo \"visible=link\"; elif [ -e \"$HOME/.local/bin/codex\" ]; then echo \"visible=file\"; else echo \"visible=none\"; fi",
    ]
    : [
      "V=\"$HOME/.local/share/claude/versions\"",
      "cur=$(readlink \"$HOME/.local/bin/claude\" 2>/dev/null)",
      "case \"$cur\" in \"$V\"/*) echo \"current=${cur##*/}\" ;; esac",
      "if [ -d \"$V\" ]; then for f in \"$V\"/*; do if [ -f \"$f\" ]; then echo \"release=${f##*/} $(wc -c < \"$f\" | tr -d ' ')\"; fi; done; fi",
      "if [ -L \"$HOME/.local/bin/claude\" ]; then echo \"visible=link\"; elif [ -e \"$HOME/.local/bin/claude\" ]; then echo \"visible=file\"; else echo \"visible=none\"; fi",
    ];
  return wrapSh([...common, ...layout, ...npmScanLines(cli), ...extraLines, "echo \"end=1\""]);
}

// ---------------------------------------------------------------------------
// 首选路径：在集群上经隧道跑官方安装器（setsid + nohup 后台，SSH 断开不影响）
// ---------------------------------------------------------------------------

// 安装任务从 env.sh 只该拿到这些：代理变量与 PATH（HOME 本来就在）。即使 keys 文件里出现同名变量也保留。
const JOB_KEEP_ENV = Object.freeze(["PATH", "HOME", "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY"]);

// env.sh 末尾会 source keys/*.env（v2.57 终审）：不清掉的话，刚从网上下载来的 install.sh 连同它的子进程
// 都会继承中转站 API key 与 CLAUDE_CODE_OAUTH_TOKEN。source 之后把 keys 文件里出现过的变量名逐个 unset
// （取名口径比 remote/cli-probe.sh 的 ct_key_names 更宽：先按空白 / 分号拆词，一行写了多个赋值、或先赋值
// 再 export 的也都算——宁可多 unset，不漏）。变量名只认标识符，unset 的参数里不会有别的东西。
// 末尾重新给 J 赋值：keys 文件若恰好有同名变量，source 时已经把它盖掉了。
function scrubKeyEnvLines() {
  return [
    `for __cwb_n in $(cat "${REMOTE_KEYS_DIR}"/*.env 2>/dev/null | tr -s ' \\t;' '\\n\\n\\n' | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' | cut -d= -f1 | sort -u); do`,
    "  case \"$__cwb_n\" in",
    `    ${JOB_KEEP_ENV.join("|")}) ;;`,
    "    *) unset \"$__cwb_n\" ;;",
    "  esac",
    "done",
    "unset __cwb_n",
    "J=\"$1\"",
  ];
}

// 任务脚本本体（落在 jobs/<id>/job.sh，由 sh 执行；不经 wrapSh，所以可以有多行结构）。
// 先 source 受管 env.sh 拿到代理变量与 PATH、清掉它连带引入的密钥，再下载官方安装脚本并执行；
// 退出码写 exit（先写 tmp 再改名）。
export function renderOfficialJobScript(cli) {
  assertCli(cli);
  const lines = [
    "J=\"$1\"",
    "echo $$ > \"$J/pid\"",
    `. "${REMOTE_ENV_FILE}"`,
    ...scrubKeyEnvLines(),
    "export TMPDIR=\"$J/tmp\"",
  ];
  if (cli === "codex") {
    lines.push(
      "export CODEX_NON_INTERACTIVE=1",
      // releases.openai.com 的资产下载有 300 秒上限，慢隧道上必超时（见 sources.mjs 文件头）。
      "export CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false",
    );
  }
  const url = cli === "codex" ? CODEX_INSTALL_SCRIPT_URL : CLAUDE_INSTALL_SCRIPT_URL;
  const runner = cli === "codex" ? "sh" : "bash";
  lines.push(
    "rc=0",
    "echo \"@@cwb phase=fetch-installer\"",
    `curl -fsSL --connect-timeout 30 --retry 3 -o "$J/install.sh" "${url}" || rc=$?`,
    `if [ "$rc" -eq 0 ]; then echo "@@cwb phase=installer"; ${runner} "$J/install.sh" || rc=$?; fi`,
    "echo \"@@cwb exit=$rc\"",
    "echo \"$rc\" > \"$J/exit.tmp\" && mv -f \"$J/exit.tmp\" \"$J/exit\"",
  );
  return `${lines.join("\n")}\n`;
}

export function buildOfficialStartCommand(cli, jobId) {
  assertCli(cli);
  assertJobId(jobId);
  const encoded = Buffer.from(renderOfficialJobScript(cli), "utf8").toString("base64");
  return wrapSh([
    `B="${REMOTE_CLI_DIR}"`,
    `J="$B/jobs/${jobId}"`,
    `if [ ! -f "${REMOTE_ENV_FILE}" ]; then echo "start=noenv"; echo "end=1"; exit 0; fi`,
    "umask 077",
    "mkdir -p \"$J/tmp\" || { echo \"start=mkdir\"; echo \"end=1\"; exit 0; }",
    "find \"$B/jobs\" -mindepth 1 -maxdepth 1 -type d -mtime +7 -exec rm -rf {} + 2>/dev/null",
    `printf '%s' '${encoded}' | base64 -d > "$J/job.sh"`,
    `echo "${cli}" > "$J/cli"`,
    "date +%s > \"$J/started\"",
    "if command -v setsid >/dev/null 2>&1; then setsid nohup sh \"$J/job.sh\" \"$J\" > \"$J/log\" 2>&1 < /dev/null & else nohup sh \"$J/job.sh\" \"$J\" > \"$J/log\" 2>&1 < /dev/null & fi",
    "echo \"$!\" > \"$J/spawnpid\"",
    "echo \"start=ok\"",
    "echo \"end=1\"",
  ]);
}

// 轮询：退出码 / 是否还活着 / 下载中文件的大小 / 日志尾巴。
export function buildOfficialPollCommand(cli, jobId) {
  assertCli(cli);
  assertJobId(jobId);
  // codex：列出安装器临时目录（$TMPDIR 下 mktemp -d 的那一层）里的全部普通文件，本机取最大的当进度，
  // 不按扩展名认。官方 install.sh 是 POSIX sh、变量全是全局的：先下校验清单时 verify_archive_digest 把
  // archive_path 改成了清单的路径，之后 160MB 的包就下载到 tmp.XXXX/codex-package_SHA256SUMS 里
  // （2026-10 真机验收发现；只认 *.tar.gz / *.tgz 的话整个官方阶段没有进度）。
  const downloads = cli === "codex"
    ? "for f in \"$J\"/tmp/*/*; do if [ -f \"$f\" ]; then echo \"dl=$(wc -c < \"$f\" | tr -d ' ') ${f##*/}\"; fi; done"
    : "for f in \"$HOME\"/.claude/downloads/claude-*; do if [ -f \"$f\" ]; then echo \"dl=$(wc -c < \"$f\" | tr -d ' ') ${f##*/}\"; fi; done";
  // 活动量：任务开始后这些目录里新写的字节总数。只用来判断「还在动」（官方安装器下载完之后的落盘 /
  // `claude install` 自己的动作不一定写在 dl 文件里），不当进度。
  const activityDirs = cli === "codex"
    ? "\"$J/tmp\" \"${CODEX_HOME:-$HOME/.codex}/packages/standalone/releases\""
    : "\"$HOME/.claude/downloads\" \"$HOME/.local/share/claude\"";
  return wrapSh([
    `J="${REMOTE_CLI_DIR}/jobs/${jobId}"`,
    "if [ ! -d \"$J\" ]; then echo \"job=missing\"; echo \"end=1\"; exit 0; fi",
    "echo \"job=ok\"",
    ...READ_PID_FN,
    // 先看进程、再读退出码，顺序不能反：任务脚本是先写好 exit（tmp + mv）才退出的，所以「进程已经不在」时
    // exit 一定已经在了。反过来（先读 exit、后看进程），任务恰好在两条命令之间跑完就会得到「没有退出码 +
    // 进程不在」，被当成「官方安装器意外退出」，明明装好了却白白回退到本机下载。
    "if read_pid \"$J\" && kill -0 \"$p\" 2>/dev/null; then echo \"alive=1\"; else echo \"alive=0\"; fi",
    "if [ -f \"$J/exit\" ]; then echo \"exit=$(head -c 8 \"$J/exit\" | tr -cd '0-9')\"; fi",
    "echo \"now=$(date +%s)\"",
    "echo \"started=$(head -c 12 \"$J/started\" 2>/dev/null | tr -cd '0-9')\"",
    downloads,
    `echo "act=$(find ${activityDirs} -newer "$J/started" -type f -exec wc -c {} + 2>/dev/null | awk 'END {print $1+0}')"`,
    "echo \"logsize=$(wc -c < \"$J/log\" 2>/dev/null | tr -d ' ')\"",
    "tail -n 40 \"$J/log\" 2>/dev/null | tr -c '[:print:]\\n' ' ' | cut -c1-240 | sed 's/^/log=/'",
    "echo \"end=1\"",
  ]);
}

// 结束首选路径任务并回报「确认它不在了没有」（卡住 / 超时 / 取消时用）：整个进程组（setsid 起的）+ 逐层
// 子进程兜底，先 TERM，1 秒后还活着（主进程或它的进程组里还有成员）补 KILL，再看一次。输出：
//   job=missing        任务目录不在（读不到 pid，谈不上确认）
//   alive=0            确认不在跑了：本来就已经自己退出（有 exit 文件，这时一个信号都不发——pid 可能已被别的
//                      进程复用），或这次杀掉了（补写退出码 143，不覆盖任务自己刚写下的退出码）
//   alive=1            KILL 之后还在（不写退出码：下次安装的预检会把它当成在跑的任务接管）
//   alive=unknown      读不到合法 pid：不发任何信号，也不写退出码
//   exit=<退出码>      exit 文件里的值
// 调用方（install.mjs）只在 alive=0 时才认为可以回退；命令是幂等的，「再确认一次」就是再发一遍。
// 探活对「已死但还没被父进程回收」的僵尸也回答还在：任务的父进程是早已退出的那条 ssh 会话的 sh，
// 它死后由 init 立刻回收，正常遇不到；真遇到也只是偏保守（多确认一轮，仍不行就不回退）。
// pid 来自文件，先过 read_pid 的校验才拿去 kill（见 READ_PID_FN）。探进程组用 `kill -s 0 -- -pid`：
// dash 的 `kill -0 -- -pid` 不认 `--`。
export function buildOfficialKillCommand(jobId) {
  assertJobId(jobId);
  return wrapSh([
    `J="${REMOTE_CLI_DIR}/jobs/${jobId}"`,
    ...READ_PID_FN,
    "killtree() {",
    "for c in $(pgrep -P \"$2\" 2>/dev/null); do if valid_pid \"$c\"; then killtree \"$1\" \"$c\"; fi; done",
    "kill -s \"$1\" \"$2\" 2>/dev/null",
    "}",
    "still_alive() { kill -0 \"$p\" 2>/dev/null || kill -s 0 -- \"-$p\" 2>/dev/null; }",
    "if [ ! -d \"$J\" ]; then echo \"job=missing\"; echo \"end=1\"; exit 0; fi",
    "echo \"job=ok\"",
    "alive=unknown",
    "if [ -f \"$J/exit\" ]; then alive=0; elif read_pid \"$J\"; then",
    "alive=0",
    "kill -s TERM -- \"-$p\" 2>/dev/null; killtree TERM \"$p\"",
    "sleep 1",
    "if still_alive; then kill -s KILL -- \"-$p\" 2>/dev/null; killtree KILL \"$p\"; sleep 1; if still_alive; then alive=1; fi; fi",
    "fi",
    "if [ \"$alive\" = 0 ] && [ ! -f \"$J/exit\" ]; then echo 143 > \"$J/exit\"; fi",
    "echo \"alive=$alive\"",
    "if [ -f \"$J/exit\" ]; then echo \"exit=$(head -c 8 \"$J/exit\" | tr -cd '0-9')\"; fi",
    "echo \"end=1\"",
  ]);
}

// 装完核对：PATH 里那个命令（~/.local/bin/<cli>）实际报的版本 + 软链指向。
export function buildVerifyCommand(cli) {
  assertCli(cli);
  const lines = cli === "codex"
    ? [
      "R=\"${CODEX_HOME:-$HOME/.codex}/packages/standalone\"",
      "cur=$(readlink \"$R/current\" 2>/dev/null)",
      "if [ -n \"$cur\" ]; then echo \"current=${cur##*/}\"; fi",
    ]
    : [
      "cur=$(readlink \"$HOME/.local/bin/claude\" 2>/dev/null)",
      "case \"$cur\" in \"$HOME/.local/share/claude/versions\"/*) echo \"current=${cur##*/}\" ;; esac",
    ];
  return wrapSh([
    ...lines,
    `if [ -x "$HOME/.local/bin/${cli}" ]; then echo "version=$("$HOME/.local/bin/${cli}" --version 2>/dev/null | ${ONE_LINE})"; fi`,
    "echo \"end=1\"",
  ]);
}

// ---------------------------------------------------------------------------
// 回退路径：上传（stdin）→ 复核 → 解包 / 落盘 → 冒烟 → 切软链
// ---------------------------------------------------------------------------

function assertUpload({ fileName, size, sha256 }) {
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  if (!Number.isSafeInteger(size) || size <= 0) throw argError(`字节数非法: ${size}`);
  if (!isSha256(sha256)) throw argError("sha256 非法");
}

// 远端从 stdin 收文件：写 .part → 核对字节数 → sha256 复核 → 改名。断线时 cat 读到 EOF 会"成功"，
// 所以字节数必须核对（同 shell/remote-file.mjs 的 FromStdin 写法）。
export function buildUploadCommand({ fileName, size, sha256 }) {
  assertUpload({ fileName, size, sha256 });
  const part = `"$U/${fileName}.part"`;
  return wrapSh([
    `U="${REMOTE_CLI_DIR}/upload"`,
    ...SHA256_FN,
    "umask 077",
    "mkdir -p \"$U\" || { echo \"upload=mkdir\"; echo \"end=1\"; exit 0; }",
    `rm -f ${part}`,
    `cat > ${part}`,
    `n=$(wc -c < ${part} | tr -d ' ')`,
    `if [ "$n" != "${size}" ]; then rm -f ${part}; echo "upload=short"; echo "got=$n"; echo "end=1"; exit 0; fi`,
    `if [ "$(sha256_of ${part})" != "${sha256}" ]; then rm -f ${part}; echo "upload=badsum"; echo "end=1"; exit 0; fi`,
    `mv -f ${part} "$U/${fileName}"`,
    "echo \"upload=ok\"",
    "echo \"end=1\"",
  ]);
}

// 取消上传后清掉集群上的半截文件（v2.57 后续）。本机的 ssh 被杀后，上传脚本多半自己会收尾（cat 读到 EOF →
// 字节数不对 → 删 .part），但脚本所在的 sh 若先一步没了，.part 就留在那里，所以总要补这一条。
// 两个 rm 的先后有讲究：上传脚本的最后一步是 `mv .part → 成品名`——先删 .part，它之后就挪不成了；
// 它若抢在前面挪完，紧跟着的第二个 rm 把成品也删掉。不管两边怎么交错，都不会留下文件。
export function buildUploadCleanupCommand({ fileName }) {
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  return wrapSh([
    `U="${REMOTE_CLI_DIR}/upload"`,
    `rm -f "$U/${fileName}.part"`,
    `rm -f "$U/${fileName}"`,
    "echo \"cleanup=ok\"",
    "echo \"end=1\"",
  ]);
}

// codex：tar.gz 解进 releases/.staging.<name>.$$ → chmod / codex 软链 → 冒烟 → mv 成正式目录 → current 与
// ~/.local/bin/codex 换软链 → auto-update-version（与官方装 latest 时一致）→ 最终核对，不对就切回原 current。
// 拿官方同一把 install.lock（flock），不与 codex 自己的更新器并发。
// 正式目录已存在（同版本重装且布局损坏，它还可能正是 current 指着的那个）时不先删：先挪到
// releases/.old.<name>.$$ → staging 挪成正式目录 → 成功才删 old；挪不进去就把 old 挪回原名（连挪回都失败时
// 什么都不删，报 move-restore）。以前是 rm -rf 正式目录再 mv，mv 一失败 staging 又被 fail 清掉，current 就悬空了。
// old 用点开头的名字（同 staging）：预检 / 回滚按 releases/* 扫版本时看不到它。两次 mv 之间没有任何输出，
// SSH 中途断开（下一次 echo 才会 SIGPIPE）不会停在「正式目录不在」的那一瞬间。
export function buildCodexActivateCommand({ version, target, fileName, sha256 }) {
  assertVersion(version);
  const name = codexReleaseName(version, target);
  if (!isReleaseName(name)) throw argError(`release 名非法: ${name}`);
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  if (!isSha256(sha256)) throw argError("sha256 非法");
  const ends = `*" ${version}"`;
  return wrapSh([
    `B="${REMOTE_CLI_DIR}"`,
    `A="$B/upload/${fileName}"`,
    "R=\"${CODEX_HOME:-$HOME/.codex}/packages/standalone\"",
    `N="${name}"`,
    "D=\"$R/releases/$N\"",
    "S=\"$R/releases/.staging.$N.$$\"",
    "O=\"$R/releases/.old.$N.$$\"",
    ...SHA256_FN,
    ...SWAP_LINK_FN,
    ...failFn("rm -rf \"$S\""),
    "if [ ! -f \"$A\" ]; then fail upload-missing; fi",
    `if [ "$(sha256_of "$A")" != "${sha256}" ]; then fail checksum; fi`,
    "mkdir -p \"$R/releases\" || fail mkdir",
    "if command -v flock >/dev/null 2>&1; then exec 9>\"$R/install.lock\"; flock -w 300 9 || fail locked; fi",
    "cur=$(readlink \"$R/current\" 2>/dev/null)",
    "reuse=0",
    `if [ -x "$D/bin/codex" ] && [ -f "$D/codex-package.json" ] && [ -x "$D/codex-path/rg" ] && [ -x "$D/codex-resources/bwrap" ]; then v=$("$D/bin/codex" --version 2>/dev/null | ${ONE_LINE}); case "$v" in ${ends}) reuse=1 ;; esac; fi`,
    "if [ \"$reuse\" = 1 ]; then echo \"unpack=reused\"; else",
    "rm -rf \"$S\"",
    "mkdir -p \"$S\" || fail mkdir",
    "tar -xzf \"$A\" -C \"$S\" || fail unpack",
    "chmod 0755 \"$S/bin/codex\" \"$S/bin/codex-code-mode-host\" \"$S/codex-path/rg\" 2>/dev/null",
    "if [ -f \"$S/codex-resources/bwrap\" ]; then chmod 0755 \"$S/codex-resources/bwrap\"; fi",
    "ln -sf bin/codex \"$S/codex\"",
    "if [ ! -x \"$S/bin/codex\" ] || [ ! -f \"$S/codex-package.json\" ] || [ ! -x \"$S/codex-path/rg\" ] || [ ! -x \"$S/codex-resources/bwrap\" ]; then fail layout; fi",
    `v=$("$S/bin/codex" --version 2>/dev/null | ${ONE_LINE})`,
    `case "$v" in ${ends}) ;; *) fail smoke ;; esac`,
    "if [ -e \"$D\" ] || [ -L \"$D\" ]; then mv \"$D\" \"$O\" || fail move; fi",
    "if mv \"$S\" \"$D\"; then rm -rf \"$O\"; else",
    "if [ -e \"$O\" ] || [ -L \"$O\" ]; then mv \"$O\" \"$D\" || fail move-restore; fi",
    "fail move",
    "fi",
    "echo \"unpack=ok\"",
    "fi",
    `v=$("$D/bin/codex" --version 2>/dev/null | ${ONE_LINE})`,
    `case "$v" in ${ends}) ;; *) fail smoke ;; esac`,
    "echo \"smoke=$v\"",
    "if [ -n \"$cur\" ] && [ \"$cur\" != \"$D\" ]; then echo \"from=${cur##*/}\"; printf '%s\\n' \"${cur##*/}\" > \"$B/codex.previous\"; fi",
    "swap_link \"$R/current\" \"$D\" \"$R/.current.$$\" || fail link",
    "printf '%s' \"$N\" > \"$R/auto-update-version.tmp.$$\" && mv -f \"$R/auto-update-version.tmp.$$\" \"$R/auto-update-version\"",
    "mkdir -p \"$HOME/.local/bin\" || fail mkdir",
    "if [ -e \"$HOME/.local/bin/codex\" ] && [ ! -L \"$HOME/.local/bin/codex\" ]; then cp -p \"$HOME/.local/bin/codex\" \"$HOME/.local/bin/codex.bak.$(date +%s)\" && echo \"visible=backed-up\"; fi",
    "swap_link \"$HOME/.local/bin/codex\" \"$R/current/bin/codex\" \"$HOME/.local/bin/.codex.$$\" || fail link",
    `final=$("$HOME/.local/bin/codex" --version 2>/dev/null | ${ONE_LINE})`,
    `case "$final" in ${ends}) ;; *) if [ -n "$cur" ]; then swap_link "$R/current" "$cur" "$R/.current.$$"; fi; fail final ;; esac`,
    "rm -f \"$A\"",
    "echo \"to=$N\"",
    "echo \"result=ok\"",
    "echo \"end=1\"",
  ]);
}

// Claude：单文件 → versions/.<ver>.tmp.$$ → 冒烟 → rename 成 versions/<ver>（覆盖 0 字节残留）→
// ~/.local/bin/claude 换软链（绝对路径，同原生安装）→ 最终核对，不对就切回。
// 这里没有 codex 那种「先删再挪」的窗口：单文件 rename 直接覆盖，失败时原文件不动。
export function buildClaudeActivateCommand({ version, fileName, sha256 }) {
  assertVersion(version);
  if (!SAFE_FILE.test(String(fileName || ""))) throw argError(`文件名非法: ${fileName}`);
  if (!isSha256(sha256)) throw argError("sha256 非法");
  const starts = `"${version}"*`;
  return wrapSh([
    `B="${REMOTE_CLI_DIR}"`,
    `A="$B/upload/${fileName}"`,
    "V=\"$HOME/.local/share/claude/versions\"",
    `T="$V/${version}"`,
    `P="$V/.${version}.tmp.$$"`,
    "L=\"$HOME/.local/bin/claude\"",
    ...SHA256_FN,
    ...SWAP_LINK_FN,
    ...failFn("rm -f \"$P\""),
    "if [ ! -f \"$A\" ]; then fail upload-missing; fi",
    `if [ "$(sha256_of "$A")" != "${sha256}" ]; then fail checksum; fi`,
    "mkdir -p \"$V\" \"$HOME/.local/bin\" || fail mkdir",
    "mv -f \"$A\" \"$P\" || fail move",
    "chmod 0755 \"$P\"",
    `v=$("$P" --version 2>/dev/null | ${ONE_LINE})`,
    `case "$v" in ${starts}) ;; *) fail smoke ;; esac`,
    "mv -f \"$P\" \"$T\" || fail move",
    "echo \"smoke=$v\"",
    "cur=$(readlink \"$L\" 2>/dev/null)",
    "case \"$cur\" in \"$V\"/*) if [ \"$cur\" != \"$T\" ]; then echo \"from=${cur##*/}\"; printf '%s\\n' \"${cur##*/}\" > \"$B/claude.previous\"; fi ;; esac",
    "if [ -e \"$L\" ] && [ ! -L \"$L\" ]; then cp -p \"$L\" \"$L.bak.$(date +%s)\" && echo \"visible=backed-up\"; fi",
    "swap_link \"$L\" \"$T\" \"$HOME/.local/bin/.claude.$$\" || fail link",
    `final=$("$L" --version 2>/dev/null | ${ONE_LINE})`,
    `case "$final" in ${starts}) ;; *) if [ -n "$cur" ]; then swap_link "$L" "$cur" "$HOME/.local/bin/.claude.$$"; fi; fail final ;; esac`,
    `echo "to=${version}"`,
    "echo \"result=ok\"",
    "echo \"end=1\"",
  ]);
}

// ---------------------------------------------------------------------------
// 回滚：把软链切回保留着的旧版本（不删任何版本）。target 为空时：<cli>.previous → 否则最新的非当前版本。
// ---------------------------------------------------------------------------

export function isRollbackTarget(cli, target) {
  if (cli === "codex") return isReleaseName(target) || isStrictVersion(target);
  return isStrictVersion(target);
}

export function buildRollbackCommand(cli, target = null) {
  assertCli(cli);
  if (target != null && target !== "" && !isRollbackTarget(cli, target)) throw argError(`回滚目标非法: ${target}`);
  const want = target || "";
  if (cli === "codex") {
    // codex 的 target 允许只给版本号：按「<ver>-」前缀在 releases 里找。
    return wrapSh([
      `B="${REMOTE_CLI_DIR}"`,
      "R=\"${CODEX_HOME:-$HOME/.codex}/packages/standalone\"",
      ...SWAP_LINK_FN,
      ...failFn(),
      "ok_rel() { [ -x \"$R/releases/$1/bin/codex\" ] && [ -f \"$R/releases/$1/codex-package.json\" ]; }",
      "cur=$(readlink \"$R/current\" 2>/dev/null)",
      "curn=${cur##*/}",
      "echo \"from=$curn\"",
      `want="${want}"`,
      "if [ -n \"$want\" ]; then if ok_rel \"$want\"; then :; else m=$(ls -1 \"$R/releases\" 2>/dev/null | grep -F \"$want-\" | head -n 1); if [ -n \"$m\" ] && ok_rel \"$m\"; then want=\"$m\"; else fail bad-target; fi; fi; else",
      "want=$(head -c 120 \"$B/codex.previous\" 2>/dev/null | tr -cd 'A-Za-z0-9._-')",
      "if [ -z \"$want\" ] || [ \"$want\" = \"$curn\" ] || ! ok_rel \"$want\"; then want=\"\"; for d in $(ls -1 \"$R/releases\" 2>/dev/null | sort -rV); do if [ \"$d\" != \"$curn\" ] && ok_rel \"$d\"; then want=\"$d\"; break; fi; done; fi",
      "fi",
      "if [ -z \"$want\" ]; then fail no-target; fi",
      `v=$("$R/releases/$want/bin/codex" --version 2>/dev/null | ${ONE_LINE})`,
      "if [ -z \"$v\" ]; then fail smoke; fi",
      "swap_link \"$R/current\" \"$R/releases/$want\" \"$R/.current.$$\" || fail link",
      "if [ -n \"$curn\" ] && [ \"$curn\" != \"$want\" ]; then printf '%s\\n' \"$curn\" > \"$B/codex.previous\"; fi",
      "mkdir -p \"$HOME/.local/bin\"",
      "if [ -L \"$HOME/.local/bin/codex\" ] || [ ! -e \"$HOME/.local/bin/codex\" ]; then swap_link \"$HOME/.local/bin/codex\" \"$R/current/bin/codex\" \"$HOME/.local/bin/.codex.$$\"; else echo \"visible=file\"; fi",
      "echo \"to=$want\"",
      "echo \"smoke=$v\"",
      "echo \"result=ok\"",
      "echo \"end=1\"",
    ]);
  }
  return wrapSh([
    `B="${REMOTE_CLI_DIR}"`,
    "V=\"$HOME/.local/share/claude/versions\"",
    "L=\"$HOME/.local/bin/claude\"",
    ...SWAP_LINK_FN,
    ...failFn(),
    "ok_ver() { [ -f \"$V/$1\" ] && [ -x \"$V/$1\" ] && [ \"$(wc -c < \"$V/$1\" | tr -d ' ')\" -gt 1048576 ]; }",
    "cur=$(readlink \"$L\" 2>/dev/null)",
    "curn=\"\"",
    "case \"$cur\" in \"$V\"/*) curn=${cur##*/} ;; esac",
    "echo \"from=$curn\"",
    `want="${want}"`,
    "if [ -n \"$want\" ]; then if ok_ver \"$want\"; then :; else fail bad-target; fi; else",
    "want=$(head -c 64 \"$B/claude.previous\" 2>/dev/null | tr -cd 'A-Za-z0-9._-')",
    "if [ -z \"$want\" ] || [ \"$want\" = \"$curn\" ] || ! ok_ver \"$want\"; then want=\"\"; for f in $(ls -1 \"$V\" 2>/dev/null | sort -rV); do if [ \"$f\" != \"$curn\" ] && ok_ver \"$f\"; then want=\"$f\"; break; fi; done; fi",
    "fi",
    "if [ -z \"$want\" ]; then fail no-target; fi",
    `v=$("$V/$want" --version 2>/dev/null | ${ONE_LINE})`,
    "if [ -z \"$v\" ]; then fail smoke; fi",
    "swap_link \"$L\" \"$V/$want\" \"$HOME/.local/bin/.claude.$$\" || fail link",
    "if [ -n \"$curn\" ] && [ \"$curn\" != \"$want\" ]; then printf '%s\\n' \"$curn\" > \"$B/claude.previous\"; fi",
    "echo \"to=$want\"",
    "echo \"smoke=$v\"",
    "echo \"result=ok\"",
    "echo \"end=1\"",
  ]);
}

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

const KEY = /^[a-z][a-z0-9.]{0,23}$/;

// key=value 行 → { complete, values: { key: 最后一个值 }, lists: { key: [所有值] } }。
// 值去掉控制字符、截到 300 字符；不认识的行（含非法 key）丢弃。complete = 见到了 end=1。
export function parseRemoteKv(stdout) {
  const values = {};
  const lists = {};
  let complete = false;
  for (const raw of String(stdout ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!KEY.test(key)) continue;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 远端输出去控制字符
    const value = line.slice(eq + 1).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
    if (key === "end" && value === "1") complete = true;
    values[key] = value;
    if (!lists[key]) lists[key] = [];
    lists[key].push(value);
  }
  return { complete, values, lists };
}

const toInt = (v) => (/^\d{1,15}$/.test(String(v ?? "")) ? Number(v) : null);

// 预检输出 → 结构化结果。
export function parsePreflight(cli, stdout) {
  const { complete, values, lists } = parseRemoteKv(stdout);
  const has = {};
  for (const [k, v] of Object.entries(values)) if (k.startsWith("has.")) has[k.slice(4)] = v === "1";
  let releases;
  if (cli === "claude") {
    releases = (lists.release || []).map((entry) => {
      const [name, size] = entry.split(" ");
      return { name, size: toInt(size) };
    }).filter((r) => isStrictVersion(r.name)).map((r) => ({ ...r, broken: !(r.size > 1024 * 1024) }));
  } else {
    releases = (lists.release || []).filter(isReleaseName).map((name) => ({ name, broken: false }));
  }
  const current = values.current && (cli === "claude" ? isStrictVersion(values.current) : isReleaseName(values.current)) ? values.current : null;
  const currentVersion = current ? (cli === "claude" ? current : current.replace(/-(?:x86_64|aarch64)-unknown-linux-musl$/, "")) : null;
  return {
    complete,
    arch: values.arch || null,
    musl: values.musl === "1",
    envSh: values.envsh === "1",
    freeKb: toInt(values.freekb),
    has,
    running: (lists.running || []).filter(isJobId),
    current,
    currentVersion,
    releases,
    visible: ["link", "file", "none"].includes(values.visible) ? values.visible : null,
    npmPaths: (lists.npm || []).slice(0, 8),
  };
}

// 结束命令的输出 → { complete, missing, stopped, state, exitCode }。stopped 只在输出完整且 alive=0 时为真
// （SSH 中途断开、KILL 后还活着、读不到 pid、任务目录不在都不算）；state 是 alive 的原值（"0" | "1" | "unknown"）。
export function parseKill(stdout) {
  const { complete, values } = parseRemoteKv(stdout);
  const missing = values.job === "missing";
  return {
    complete,
    missing,
    stopped: complete && !missing && values.alive === "0",
    state: ["0", "1", "unknown"].includes(values.alive) ? values.alive : null,
    exitCode: values.exit != null && values.exit !== "" ? toInt(values.exit) : null,
  };
}

// 轮询输出 → { complete, missing, exitCode, alive, now, startedAt, downloads: [{ name, bytes }], logSize, activity, log: [] }
export function parsePoll(stdout) {
  const { complete, values, lists } = parseRemoteKv(stdout);
  return {
    complete,
    missing: values.job === "missing",
    exitCode: values.exit != null && values.exit !== "" ? toInt(values.exit) : null,
    alive: values.alive === "1",
    now: toInt(values.now),
    startedAt: toInt(values.started),
    downloads: (lists.dl || []).map((entry) => {
      const sp = entry.indexOf(" ");
      return { bytes: toInt(entry.slice(0, sp)), name: entry.slice(sp + 1) };
    }).filter((d) => d.bytes != null && d.name),
    logSize: toInt(values.logsize),
    activity: toInt(values.act),
    log: lists.log || [],
  };
}
