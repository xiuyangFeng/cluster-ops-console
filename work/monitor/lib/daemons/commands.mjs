// 远端守护进程（v2.55）：固定命令注册表 + 远端输出解析。
//
// 只认两个守护进程（DAEMONS 白名单）：
//   paseo   Paseo 守护进程（npm 全局包，~/.local/bin/paseo），监听 127.0.0.1:6767
//   t3code  T3 Code 服务（~/.t3/runtime/versions/<版本>/t3），监听 127.0.0.1:3773
// 远端命令串是常量 "bash -s"，脚本经 stdin 送达（与 collect.sh 同一零残留原则）；脚本本身也是常量，
// 没有任何插值——请求只能在白名单里选一个 id，界面 / 请求里的字符串到不了远端 shell。
// 启动严格幂等：端口已在监听就什么都不做（回 already），绝不 kill / restart——正在跑的守护进程上
// 可能有用户的活会话。没有 sudo、没有 stop。
// 远端输出一律当不可信数据：只认白名单里的 key=value 行，值按字符集截断。

// 非交互 SSH 不加载登录 shell：~/.local/bin（paseo 软链）与 ~/.local/node-*/bin（node）都不在 PATH 里。
// 端口探测：ss → nc → bash /dev/tcp 依次回落（端口号是脚本里的常量）。
// 整个脚本包在 { } 里：bash 先读完整个复合命令再执行，远端命令读 stdin 也读不到脚本本身。
//
// 远端日志容量上限（评审 #9；本机 logger / runtime sweeper 管不到集群上的文件）：
//   cap_log FILE —— 超过 1 MiB 就只保留末尾 256 KiB（启动失败的诊断都在末尾），并记一行说明。
//   取舍：就地截断（tail 到临时文件再写回原文件，inode 不变）而不是 rename 轮转——T3 常驻进程以
//   O_APPEND（>>）长期打开着 console-launch.log，rename 后它会继续写进改名后的旧文件，新文件永远是空的、
//   旧文件照样无限长；就地截断后它的下一次写入直接落在新的文件末尾（O_APPEND 每次写都定位到当前末尾，
//   不会出现空洞）。代价是 tail 与写回之间常驻进程写入的几行会丢，对诊断日志可以接受。
//   不保留 .1 历史：要的只是"最近的启动诊断"，留一份旧文件等于把上限翻倍。
//   Paseo：控制台只记启动阶段输出（paseo daemon start 就绪即返回，守护进程自己的日志在 ~/.paseo 下由它
//   自己管），启动前 cap_log 一次即有上限。
//   T3：常驻 stdout/stderr 一直追加到这个文件，启动前 cap_log 管不住运行期增长，所以启动成功后再留一个
//   轻量守护子 shell，每 5 分钟 cap_log 一次，端口不再监听（T3 已退出）就自行结束；只认最新一个守护
//   （pid 文件里是守护子 shell 自己的进程号——不是 $$，子 shell 里的 $$ 仍是外层 bash -s 的；文件内容只用来
//   与自己的进程号比对，从不拿去发信号），重复启动不会叠加。它不在 T3 的输出管道上：守护没了 T3 照常运行，最坏只是回到
//   "下次启动时再截断"。没有改成"T3 输出经管道过一个限额写入器"：那样写入器一退出 T3 就会 SIGPIPE。
//
// 服务直达（v2.62）：每个脚本在 daemon_status 之后再跑一段 service_list（services.mjs 的常量片段），
// 列出本人在这台机器上监听的端口——并进同一次 SSH，不为它多发一次。只读，输出由 services.mjs 解析。
// 启动脚本也带这一段：启动结果直接进状态缓存，缓存里的服务列表不能因此缺一块。
import { isPort } from "../validators.mjs";
import { RELAY_PROXY_PRELOAD_SOURCE } from "./relay-proxy-preload.mjs";
import { SERVICE_LIST_SCRIPT } from "./services.mjs";
const PRELUDE = String.raw`
export PATH="$HOME/.local/bin:$(ls -d "$HOME"/.local/node*/bin 2>/dev/null | tr '\n' ':')$PATH"
port_up() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":$1" '{ a = $4; n = length(p); if (length(a) > n && substr(a, length(a) - n + 1) == p) f = 1 } END { exit f ? 0 : 1 }'
    return
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" </dev/null >/dev/null 2>&1
    return
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}
with_timeout() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi
}
one_line() {
  tr -c '[:print:]' ' ' | cut -c1-300
}
cap_log() {
  local s
  s=$(wc -c <"$1" 2>/dev/null | tr -cd '0-9')
  if [ -n "$s" ] && [ "$s" -gt 1048576 ]; then
    tail -c 262144 "$1" >"$1.cap" 2>/dev/null && cat "$1.cap" >"$1" 2>/dev/null
    rm -f "$1.cap"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] console: log exceeded 1 MiB, kept the last 256 KiB" >>"$1"
  fi
}
t3_pick() {
  for d in $(ls -1 "$HOME/.t3/runtime/versions" 2>/dev/null | sort -rV); do
    case "$d" in *[!A-Za-z0-9._-]*) continue ;; esac
    if [ -x "$HOME/.t3/runtime/versions/$d/t3" ] && [ -f "$HOME/.t3/runtime/versions/$d/.install-complete" ]; then
      echo "$d"
      return 0
    fi
  done
  return 1
}
daemon_status() {
  if command -v paseo >/dev/null 2>&1; then
    echo "paseo.bin=1"
    with_timeout 10 paseo daemon status </dev/null 2>/dev/null | awk -F': *' '$1 == "localDaemon" { print "paseo.daemon=" $2 } $1 == "daemonVersion" { print "paseo.version=" $2 }'
  else
    echo "paseo.bin=0"
  fi
  if port_up 6767; then echo "paseo.port=1"; else echo "paseo.port=0"; fi
  echo "paseo.relayport=$(head -c 6 "$HOME/.paseo/relay-proxy.port" 2>/dev/null | tr -cd '0-9')"
  if v=$(t3_pick); then echo "t3code.bin=1"; echo "t3code.binver=$v"; else echo "t3code.bin=0"; fi
  if port_up 3773; then echo "t3code.port=1"; else echo "t3code.port=0"; fi
  p=$(pgrep -u "$(id -u)" -af '/t3 serve --host 127.0.0.1 --port 3773' 2>/dev/null | head -n 1)
  if [ -n "$p" ]; then
    echo "t3code.proc=1"
    echo "$p" | sed -n 's#.*/\.t3/runtime/versions/\([A-Za-z0-9._-]*\)/t3 serve.*#t3code.version=\1#p'
  else
    echo "t3code.proc=0"
  fi
}
`;

// paseo daemon start 自带就绪等待（--timeout 90，就绪即返回、守护进程自行脱离）；输出写文件而不是管道——
// 守护进程若继承了管道写端，$(...) 会一直等到 SSH 超时。
const START_PASEO = `
if port_up 6767; then
  echo "result=already"
elif ! command -v paseo >/dev/null 2>&1; then
  echo "result=missing"
else
  mkdir -p "$HOME/.paseo"
  cap_log "$HOME/.paseo/console-launch.log"
  # 中继走代理的预加载（校园网拦截 relay.paseo.sh 的 TLS，见 daemons/relay-proxy-preload.mjs）：
  # 内容有变才覆盖；写不出来就不预加载，守护进程照常启动（只是中继可能连不上）。
  cat >"$HOME/.paseo/relay-proxy.cjs.new" <<'PRELOAD_EOF' 2>/dev/null
${RELAY_PROXY_PRELOAD_SOURCE}PRELOAD_EOF
  if [ -s "$HOME/.paseo/relay-proxy.cjs.new" ]; then
    cmp -s "$HOME/.paseo/relay-proxy.cjs.new" "$HOME/.paseo/relay-proxy.cjs" 2>/dev/null || mv -f "$HOME/.paseo/relay-proxy.cjs.new" "$HOME/.paseo/relay-proxy.cjs"
    rm -f "$HOME/.paseo/relay-proxy.cjs.new"
  fi
  if [ -s "$HOME/.paseo/relay-proxy.cjs" ]; then
    export NODE_OPTIONS="--require $HOME/.paseo/relay-proxy.cjs \${NODE_OPTIONS:-}"
  fi
  # 记下这次启动用的中继代理端口：状态里据此提示「已在运行、但用的不是你现在的端口」。
  printf '%s\n' "\${PASEO_RELAY_PROXY_PORT:-}" >"$HOME/.paseo/relay-proxy.port" 2>/dev/null
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] console: paseo daemon start (relay proxy port \${PASEO_RELAY_PROXY_PORT:-none})" >>"$HOME/.paseo/console-launch.log"
  paseo daemon start --timeout 90 </dev/null >>"$HOME/.paseo/console-launch.log" 2>&1
  i=0
  while [ "$i" -lt 20 ] && ! port_up 6767; do sleep 0.5; i=$((i + 1)); done
  if port_up 6767; then
    echo "result=started"
  else
    echo "result=failed"
    echo "detail=$(tail -n 3 "$HOME/.paseo/console-launch.log" 2>/dev/null | one_line)"
  fi
fi
`;

// T3 Code 没有自带守护模式：setsid + nohup 脱离 SSH 会话，标准输入输出全部重定向（SSH 才能立刻返回），
// 之后轮询端口至多 15 秒。输出必须保持 >>（O_APPEND）：日志守护的就地截断依赖它（见文件头）。
// 日志守护子 shell 忽略 SIGHUP、标准输入输出全指向 /dev/null，不拖住 SSH 会话。
const START_T3CODE = `
if port_up 3773; then
  echo "result=already"
elif ! v=$(t3_pick); then
  echo "result=missing"
else
  mkdir -p "$HOME/.t3"
  cap_log "$HOME/.t3/console-launch.log"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] console: t3 serve ($v)" >>"$HOME/.t3/console-launch.log"
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup "$HOME/.t3/runtime/versions/$v/t3" serve --host 127.0.0.1 --port 3773 --base-dir "$HOME/.t3" >>"$HOME/.t3/console-launch.log" 2>&1 </dev/null &
  else
    nohup "$HOME/.t3/runtime/versions/$v/t3" serve --host 127.0.0.1 --port 3773 --base-dir "$HOME/.t3" >>"$HOME/.t3/console-launch.log" 2>&1 </dev/null &
  fi
  i=0
  while [ "$i" -lt 30 ] && ! port_up 3773; do sleep 0.5; i=$((i + 1)); done
  if port_up 3773; then
    echo "result=started"
    # 日志守护：每 5 分钟就地截断一次；T3 退出（端口不再监听）或被更新一次启动的守护取代即结束。
    (
      trap '' HUP
      # 要的是守护自己的进程号：子 shell 里 $$ 仍是外层 bash -s 的（它几秒后就退出，号码会被复用）。
      # bash 4+ 直接有 BASHPID；更老的 bash 让命令替换的子进程 exec 成 sh，再读它的 PPID（正是本子 shell）。
      me=\${BASHPID:-$(exec sh -c 'echo "$PPID"')}
      echo "$me" >"$HOME/.t3/console-log-guard.pid"
      while sleep 300 && port_up 3773 && [ "$(cat "$HOME/.t3/console-log-guard.pid" 2>/dev/null)" = "$me" ]; do
        cap_log "$HOME/.t3/console-launch.log"
      done
    ) </dev/null >/dev/null 2>&1 &
  else
    echo "result=failed"
    echo "detail=$(tail -n 3 "$HOME/.t3/console-launch.log" 2>/dev/null | one_line)"
  fi
fi
`;

const wrap = (body) => `{\n${PRELUDE}${SERVICE_LIST_SCRIPT}\necho "v=1"\n${body}\ndaemon_status\nservice_list\necho "end=1"\n}\n`;

export const DAEMON_REMOTE_COMMAND = "bash -s";
export const DAEMON_STATUS_SCRIPT = wrap("");

export const DAEMONS = Object.freeze([
  Object.freeze({
    id: "paseo",
    label: "Paseo",
    port: 6767,
    description: "Paseo 守护进程（paseo daemon）",
    script: wrap(START_PASEO),
    // paseo 自带 90 秒就绪等待 + 本脚本 10 秒端口轮询 + SSH 握手余量。
    startTimeoutMs: 115000,
  }),
  Object.freeze({
    id: "t3code",
    label: "T3 Code",
    port: 3773,
    description: "T3 Code 服务（t3 serve）",
    script: wrap(START_T3CODE),
    // 端口轮询 15 秒 + 状态采集 + SSH 握手余量。
    startTimeoutMs: 45000,
  }),
]);

export const DAEMON_IDS = Object.freeze(DAEMONS.map((d) => d.id));
export const DAEMON_STATUS_TIMEOUT_MS = 25000;
const DAEMON_MAX_OUT_BYTES = 64 * 1024;

export function isDaemonId(value) {
  return typeof value === "string" && DAEMON_IDS.includes(value);
}

export function daemonDef(id) {
  return DAEMONS.find((d) => d.id === id) || null;
}

// action：null = 只查状态；否则是白名单里的守护进程 id（启动它）。sshArgs 由调用方按服务器组装。
// relayProxyPort：启动 paseo 时中继走的本账号反向端口（合并后配置的 remotePort）。脚本里唯一的变量，
// 只接受过了 isPort 的整数，以单独一行 export 前置在常量脚本之前——请求里的字符串仍到不了远端 shell。
export function buildDaemonInvocation(sshArgs, action = null, { relayProxyPort = null } = {}) {
  const def = action == null ? null : daemonDef(action);
  if (action != null && !def) throw new Error(`unknown daemon: ${action}`);
  if (relayProxyPort != null && !isPort(relayProxyPort)) throw new Error(`invalid relay proxy port: ${relayProxyPort}`);
  const portLine = def?.id === "paseo" && relayProxyPort != null ? `export PASEO_RELAY_PROXY_PORT=${Number(relayProxyPort)}\n` : "";
  return {
    file: "ssh",
    args: [...sshArgs, DAEMON_REMOTE_COMMAND],
    input: def ? portLine + def.script : DAEMON_STATUS_SCRIPT,
    timeoutMs: def ? def.startTimeoutMs : DAEMON_STATUS_TIMEOUT_MS,
    maxOutputBytes: DAEMON_MAX_OUT_BYTES,
  };
}

// 白名单 key → 值的字符集 / 长度。
const VERSION_RE = /^[\w.+-]{1,40}$/;
const KEYS = Object.freeze({
  v: /^1$/,
  end: /^1$/,
  result: /^(already|started|missing|failed)$/,
  detail: /^[\x20-\x7e]{0,300}$/,
  "paseo.bin": /^[01]$/,
  "paseo.port": /^[01]$/,
  "paseo.daemon": /^[\w-]{1,24}$/,
  "paseo.version": VERSION_RE,
  "paseo.relayport": /^\d{0,5}$/,
  "t3code.bin": /^[01]$/,
  "t3code.binver": VERSION_RE,
  "t3code.port": /^[01]$/,
  "t3code.proc": /^[01]$/,
  "t3code.version": VERSION_RE,
});

// 解析远端输出：{ complete, values }。complete = 同时见到 v=1 与 end=1（脚本完整跑完）；
// 不认识的行、值不合格的行一律丢弃（同一 key 只取第一次出现）。
// 行数上限 400：end=1 排在服务那一段（ss / proc / age 记录，远端封顶约 160 行）之后，要留够余量。
export function parseDaemonOutput(stdout) {
  const values = {};
  for (const raw of String(stdout ?? "").split("\n").slice(0, 400)) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (!Object.hasOwn(KEYS, key) || Object.hasOwn(values, key) || !KEYS[key].test(value)) continue;
    values[key] = value;
  }
  return { complete: values.v === "1" && values.end === "1", values };
}

// 单个守护进程的状态视图。state：
//   running  端口在监听
//   stopped  端口没在监听、程序在
//   missing  端口没在监听、服务器上找不到程序（不提供启动）
//   unknown  这一轮没拿到完整结果（SSH 失败 / 超时 / 输出不完整）
// expectedRelayPort：本账号当前的反向端口（没有则 null）。paseo 已在运行、但启动时用的中继端口与它不同
// （例如端口重新分配过、或是 v2.56 之前按 7891 启动的）时给出提示——不自动重启，用户的会话可能还在上面。
export function daemonView(def, parsed, { expectedRelayPort = null } = {}) {
  const base = { id: def.id, label: def.label, port: def.port, description: def.description };
  if (!parsed?.complete) return { ...base, state: "unknown", installed: null, version: null, note: "" };
  const v = parsed.values;
  const up = v[`${def.id}.port`] === "1";
  const installed = v[`${def.id}.bin`] === "1";
  let state = "stopped";
  if (up) state = "running";
  else if (!installed) state = "missing";
  let version = null;
  let note = "";
  if (def.id === "paseo") {
    version = v["paseo.version"] || null;
    if (up && v["paseo.daemon"] && v["paseo.daemon"] !== "running") note = `端口 ${def.port} 在监听，但 paseo 报告守护进程状态为 ${v["paseo.daemon"]}`;
    else if (up && expectedRelayPort != null && v["paseo.relayport"] && Number(v["paseo.relayport"]) !== Number(expectedRelayPort)) {
      note = `守护进程启动时中继走的是端口 ${v["paseo.relayport"]}，你现在的端口是 ${expectedRelayPort}；需要时请在集群上手动 paseo daemon stop 后再从这里启动`;
    }
  } else {
    version = v["t3code.version"] || null;
    if (up && v["t3code.proc"] === "0") note = `端口 ${def.port} 在监听，但没找到本人的 t3 serve 进程（可能被其它程序占用）`;
    else if (!up && installed && v["t3code.binver"]) note = `将使用 ~/.t3/runtime/versions/${v["t3code.binver"]}`;
  }
  return { ...base, state, installed, version, note };
}
