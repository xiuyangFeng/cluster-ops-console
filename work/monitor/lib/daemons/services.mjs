// 服务直达（v2.62）：本人在集群上监听的服务——远端脚本片段与输出解析（纯函数，零 IO）。
//
// 远端片段是常量（没有任何插值），拼进守护进程状态脚本（commands.mjs 的 PRELUDE）：同一次 SSH、
// 同一个 `bash -s`，不为它多发一次。只读：不写任何远端文件，不碰任何进程。
//
// 口径：`ss -ltnp` 只对本人的进程给出 `users:(("名字",pid=…,fd=…))`（别人的监听那一列是空的），
// 所以「带 pid= 的行」就是「我的监听」——不扫别人的端口，也看不到别人的进程。
//   - 不带 -H：表头行本来就不含 pid=，过滤后结果一样；老版本 ss（CentOS 7）没有这个参数。
//   - 进程名来自内核的 comm，可以带空格（"Paseo Daemon"），一个监听也可能挂着多个进程，
//     所以整行原样交给本机解析，远端只按 `pid=数字` 取进程号去读 /proc。
//   - 再核一道属主：只给 /proc/<pid> 属于当前账号的进程出 proc 记录（[ -O … ]），本机只认至少有一个这种
//     进程的监听。普通账号下这与 ss 的口径重合；以 root 运行时 ss 会连别人的进程一起给，靠这一道挡住。
// 输出（每行一条记录，值里的控制字符在远端已换成空格）：
//   ss=<ss 的一行>                最多 64 行，每行截到 320 字符
//   proc=<pid>\t<工作目录>\t<命令行>  属于本人的进程，最多看 48 个；工作目录截到 200、命令行截到 160 字符
//   age=<pid> <已运行秒数>          ps -o etimes
//   svc.home=<$HOME>              本机把工作目录里的家目录前缀写成 ~
//   svc.state=ok|trunc|unavailable|failed   ok = 列全了；trunc = 超过 64 行或 48 个进程，只给了前面的；
//                                 unavailable = 没有 ss；failed = ss 没跑成。最后才输出——中途断了就没有这一行。
// 远端输出一律当不可信数据：字段逐个校验字符集与长度，命令行再过一遍脱敏；界面上还要 escapeHtml。
//
// 约束：片段内嵌在 String.raw 模板里，不得出现反引号和 "${"。
import { redactSensitive } from "../operation-context.mjs";
import { isPort } from "../validators.mjs";

export const SERVICE_LIST_SCRIPT = String.raw`
service_list() {
  local svc_proc out mine total all npids pids p cwd cmd
  svc_proc=/proc
  if ! command -v ss >/dev/null 2>&1; then
    echo "svc.state=unavailable"
    return 0
  fi
  if ! out=$(with_timeout 6 ss -ltnp 2>/dev/null); then
    echo "svc.state=failed"
    return 0
  fi
  mine=$(printf '%s\n' "$out" | tr -d '\r' | tr '\001-\011\013-\037\177' ' ' | tr -s ' ' | awk 'index($0, "pid=") { print substr($0, 1, 320) }')
  total=$(printf '%s\n' "$mine" | awk 'NF { n++ } END { print n + 0 }')
  printf '%s\n' "$mine" | awk 'NF && n < 64 { n++; print "ss=" $0 }'
  all=$(printf '%s\n' "$mine" | awk 'NF && n < 64 { n++; s = $0; while (match(s, /pid=[0-9]+/)) { print substr(s, RSTART + 4, RLENGTH - 4); s = substr(s, RSTART + RLENGTH) } }' | sort -un)
  npids=$(printf '%s\n' "$all" | awk 'NF { n++ } END { print n + 0 }')
  pids=$(printf '%s\n' "$all" | head -n 48)
  for p in $pids; do
    [ -O "$svc_proc/$p" ] || continue
    cwd=$(readlink "$svc_proc/$p/cwd" 2>/dev/null | tr '\001-\037\177' ' ' | cut -c1-200)
    cmd=$(head -c 1024 "$svc_proc/$p/cmdline" 2>/dev/null | tr '\000-\037\177' ' ' | cut -c1-160)
    printf 'proc=%s\t%s\t%s\n' "$p" "$cwd" "$cmd"
  done
  if [ -n "$pids" ]; then
    ps -o pid=,etimes= -p "$(printf '%s' "$pids" | tr '\n' ',')" 2>/dev/null | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print "age=" $1 " " $2 }'
  fi
  printf 'svc.home=%s\n' "$HOME" | tr '\001-\011\013-\037\177' ' ' | cut -c1-220
  if [ "$total" -gt 64 ] || [ "$npids" -gt 48 ]; then echo "svc.state=trunc"; else echo "svc.state=ok"; fi
}
`;

// 界面上最多列这么多个服务（按端口从小到大）。
export const SERVICE_LIMIT = 24;
// 1024 以下是系统服务的端口，不列。
export const MIN_SERVICE_PORT = 1024;
// 反向隧道在集群上的监听就是 sshd 的：不是「我的服务」。
const HIDDEN_PROCESS_NAMES = new Set(["sshd"]);

const MAX_LISTENERS = 64;
const MAX_PROCS = 48;
const MAX_LINES = 400;
const NAME_MAX = 32;
const CWD_MAX = 200;
const CMDLINE_MAX = 160;
const STATE_RE = /^(ok|trunc|unavailable|failed)$/;
const PID_RE = /^[1-9]\d{0,9}$/;
const ADDRESS_RE = /^[0-9a-f:.*]{1,45}$/;

// 单行化：控制字符与解码失败留下的替换符换成空格，压掉连续空白，截长。
function clean(value, max) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉远端文本里的控制字符
  return String(value ?? "").replace(/[\u0000-\u001f\u007f�]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

// 命令行给人看之前的脱敏：通用规则（Bearer / api_key= / sk- / 带账号密码的 URL）之外，
// 再盖掉「名字里带 token / secret / password / api-key 的参数」的值（--NotebookApp.token=…、--password …）。
// 参数必须顶格或跟在空白后面：my-tokenizer.py 这种文件名不算。
const SECRET_FLAG_RE = /((?:^|\s)--?[\w.-]*(?:token|secret|passw(?:or)?d|api[-_]?key)[\w.-]*(?:=|\s+))(?!-)[^\s"']+/gi;
export function redactCommandLine(text) {
  return redactSensitive(clean(text, CMDLINE_MAX * 2))
    .replace(SECRET_FLAG_RE, "$1[已隐藏]")
    .replaceAll("[REDACTED]", "[已隐藏]")
    .slice(0, CMDLINE_MAX);
}

// 监听地址归类。target = 从集群本机连它该用的回环地址（转发的远端目标只在这两个常量里选，
// 从不取用远端报上来的地址）；null = 只绑在某个具体地址上，经回环连不到。
//   scope: "all" 所有网卡（0.0.0.0 / :: / *）· "loopback" 只有集群本机 · "address" 某个具体地址
export function classifyBind(address) {
  const addr = String(address ?? "").toLowerCase();
  const mapped = addr.startsWith("::ffff:") ? addr.slice(7) : null;
  const v4 = mapped ?? addr;
  if (addr === "*" || v4 === "0.0.0.0") return { scope: "all", target: "127.0.0.1" };
  if (addr === "::") return { scope: "all", target: "[::1]" };
  if (v4 === "127.0.0.1") return { scope: "loopback", target: "127.0.0.1" };
  if (addr === "::1") return { scope: "loopback", target: "[::1]" };
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return { scope: "loopback", target: null };
  return { scope: "address", target: null };
}

// `ss -ltnp` 的一行 → { port, address, procs: [{ name, pid }] }；没有进程信息（不是本人的监听）、
// 不是 LISTEN、地址或端口认不出来 → null。
//   LISTEN 0 128 127.0.0.1:6767 0.0.0.0:* users:(("Paseo Daemon",pid=211354,fd=23))
//   LISTEN 0 511 *:3000 *:* users:(("node",pid=9,fd=20),("node",pid=10,fd=20))
//   LISTEN 0 128 [::1]:5173 [::]:* users:(("node",pid=11,fd=31))
// 进程那一列从 `users:(` 起算（名字里有空格也不影响前面几列按空白切）；本机地址取最后一个冒号之前，
// 所以老版本不带方括号的 `:::8000`、`::1:9000` 也认得。
export function parseListenLine(line) {
  const text = String(line ?? "");
  const at = text.indexOf("users:(");
  if (at < 0) return null;
  const head = text.slice(0, at).trim().split(/\s+/);
  const state = head.indexOf("LISTEN");
  if (state < 0 || state > 1 || head.length < state + 5) return null;
  const local = head[state + 3];
  const colon = local.lastIndexOf(":");
  if (colon <= 0) return null;
  const port = /^\d{1,5}$/.test(local.slice(colon + 1)) ? Number(local.slice(colon + 1)) : null;
  if (!isPort(port)) return null;
  const address = local.slice(0, colon).replace(/^\[(.*)\]$/, "$1").replace(/%[\w.-]+$/, "").toLowerCase();
  if (!ADDRESS_RE.test(address)) return null;
  const procs = [];
  const seen = new Set();
  const add = (name, pidText) => {
    if (!PID_RE.test(pidText) || seen.has(pidText) || procs.length >= 8) return;
    seen.add(pidText);
    procs.push({ name: clean(name, NAME_MAX), pid: Number(pidText) });
  };
  const users = text.slice(at);
  for (const match of users.matchAll(/"([^"]*)",pid=(\d+),fd=\d+/g)) add(match[1], match[2]);
  // 名字里带引号之类的怪形状：上面认不出时退一步，只按 pid= 取进程号（名字留空）。
  if (!procs.length) for (const match of users.matchAll(/pid=(\d+)/g)) add("", match[1]);
  return procs.length ? { port, address, procs } : null;
}

// 远端输出里服务那一段 → { state, home, listeners, procs: Map<pid, { cwd, cmdline }>, ages: Map<pid, 秒> }。
// 认不出的行、字段不合格的行一律丢弃；同一个 pid 只取第一次出现。
export function parseServiceOutput(stdout) {
  const listeners = [];
  const procs = new Map();
  const ages = new Map();
  let state = null;
  let home = "";
  for (const raw of String(stdout ?? "").split("\n").slice(0, MAX_LINES)) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("ss=")) {
      const listener = listeners.length < MAX_LISTENERS ? parseListenLine(line.slice(3)) : null;
      if (listener) listeners.push(listener);
    } else if (line.startsWith("proc=")) {
      const [pid, cwd = "", ...rest] = line.slice(5).split("\t");
      if (PID_RE.test(pid) && !procs.has(Number(pid)) && procs.size < MAX_PROCS) {
        procs.set(Number(pid), { cwd: clean(cwd, CWD_MAX), cmdline: redactCommandLine(rest.join(" ")) });
      }
    } else if (line.startsWith("age=")) {
      const match = /^([1-9]\d{0,9}) (\d{1,10})$/.exec(line.slice(4).trim());
      if (match && !ages.has(Number(match[1])) && ages.size < MAX_PROCS) ages.set(Number(match[1]), Number(match[2]));
    } else if (line.startsWith("svc.home=")) {
      const value = clean(line.slice(9), 220);
      if (!home && value.startsWith("/")) home = value.replace(/\/+$/, "");
    } else if (line.startsWith("svc.state=")) {
      const value = line.slice(10).trim();
      if (state == null && STATE_RE.test(value)) state = value;
    }
  }
  return { state, home, listeners, procs, ages };
}

// 工作目录里的家目录前缀写成 ~（短，也不把家目录的绝对路径带到界面上）。
function shortenHome(cwd, home) {
  if (!home || !cwd) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

// 解析结果 → 服务列表（一个端口一条）。
//   state     ok / trunc / unavailable / failed / unknown（远端没给出状态行）
//   complete  这一轮把本人的监听列全了——只有这时「列表里没有某个端口」才说明它真的没了
//   services  按端口从小到大、最多 SERVICE_LIMIT 个；more = 没列出来的个数
//   ports     过滤后的全部端口（不受条数上限影响）
// 只认「属于本人的进程」的监听：远端只给属主是当前账号的进程出 proc 记录，一个监听里没有任何这种进程就不算。
// 剔除：sshd 的监听（反向隧道）、excludePorts（面板里已经单列的守护进程端口）、1024 以下的端口。
export function buildServices(parsed, { excludePorts = [] } = {}) {
  const state = parsed?.state || "unknown";
  const empty = { state, complete: false, services: [], more: 0, ports: new Set() };
  if (state !== "ok" && state !== "trunc") return empty;
  const skip = new Set(excludePorts);
  const byPort = new Map();
  for (const listener of parsed.listeners || []) {
    if (listener.port < MIN_SERVICE_PORT || skip.has(listener.port)) continue;
    const mine = listener.procs.filter((proc) => parsed.procs?.has(proc.pid));
    if (!mine.length) continue;
    let entry = byPort.get(listener.port);
    if (!entry) {
      entry = { port: listener.port, binds: [], procs: new Map() };
      byPort.set(listener.port, entry);
    }
    if (!entry.binds.includes(listener.address) && entry.binds.length < 4) entry.binds.push(listener.address);
    for (const proc of mine) if (!entry.procs.has(proc.pid)) entry.procs.set(proc.pid, proc);
  }
  const all = [];
  for (const entry of byPort.values()) {
    const procs = [...entry.procs.values()];
    if (procs.every((proc) => HIDDEN_PROCESS_NAMES.has(proc.name))) continue;
    // 一个端口挂着多个进程时取运行最久的那个（多半是主进程）；都没有时长就取第一个。
    const age = (proc) => parsed.ages?.get(proc.pid) ?? -1;
    const main = procs.reduce((best, proc) => (age(proc) > age(best) ? proc : best), procs[0]);
    const detail = parsed.procs.get(main.pid);
    const binds = entry.binds.map(classifyBind);
    all.push({
      port: entry.port,
      name: main.name,
      pid: main.pid,
      procCount: procs.length,
      binds: entry.binds,
      scope: binds.some((b) => b.scope === "all") ? "all" : binds.some((b) => b.scope === "address") ? "address" : "loopback",
      target: binds.find((b) => b.target === "127.0.0.1")?.target ?? binds.find((b) => b.target)?.target ?? null,
      cmdline: detail.cmdline,
      cwd: shortenHome(detail.cwd, parsed.home),
      uptimeSec: parsed.ages?.has(main.pid) ? parsed.ages.get(main.pid) : null,
    });
  }
  all.sort((a, b) => a.port - b.port);
  return {
    state,
    complete: state === "ok",
    services: all.slice(0, SERVICE_LIMIT),
    more: Math.max(0, all.length - SERVICE_LIMIT),
    ports: new Set(all.map((service) => service.port)),
  };
}

const SERVICE_KIND_RULES = [
  { id: "jupyter", label: "Jupyter", re: /\b(?:jupyter(?:[-_](?:lab|notebook|server))?|ipykernel_launcher)\b/i },
  { id: "tensorboard", label: "TensorBoard", re: /\btensorboard\b/i },
  { id: "gradio", label: "Gradio", re: /\bgradio\b/i },
  { id: "streamlit", label: "Streamlit", re: /\bstreamlit\b/i },
  { id: "llm-server", label: "LLM 推理服务", re: /\b(?:vllm|sglang|ollama|text-generation-launcher|llama-server)\b/i },
  { id: "mlflow", label: "MLflow", re: /\bmlflow\b/i },
  { id: "ray", label: "Ray", re: /\bray::|dashboard\.py\b/i },
  { id: "code-server", label: "Code Server", re: /\b(?:code-server|vscode-server|openvscode-server)\b/i },
  { id: "http-server", label: "静态文件服务", re: /\b(?:http\.server|SimpleHTTPServer)\b/ },
  { id: "api-server", label: "Web API", re: /\b(?:uvicorn|gunicorn|fastapi|flask\s+run|hypercorn|daphne)\b/i },
  { id: "dev-server", label: "前端开发服务", re: /\b(?:vite|next-server|webpack(?:-dev-server)?)\b/i },
];

export function detectServiceKind(cmdline, name = "") {
  const hay = `${cmdline || ""} ${name || ""}`;
  for (const rule of SERVICE_KIND_RULES) {
    if (rule.re.test(hay)) return { id: rule.id, label: rule.label };
  }
  return null;
}

// 给接口的形状：转发目标只留在服务端（请求里只收端口，目标由这里的归类决定），对外只说能不能转发。
export function serviceView(service) {
  const { target, ...rest } = service;
  const kind = detectServiceKind(service.cmdline, service.name);
  return { ...rest, forwardable: Boolean(target), ...(kind ? { kind } : {}) };
}
