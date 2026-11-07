// 同账号多台 Mac 共用一个反向端口时的接力（v2.88，纯函数，零副作用）。
//
// 场景：同一个集群账号在两台 Mac 上都开着控制台，两台的隧道都配同一个远端端口（集群 env.sh
// 只指向这一个端口，换电脑时集群上的程序不用跟着改代理）。同一时刻只能有一台绑定这个端口：
//   - 承载方（active）：端口在它手里，集群流量从它出网；
//   - 待命方（standby）：发现端口被「本账号另一台 Mac」占着、且对方还活着，就不再重连，
//     每 30 秒看一眼；对方睡眠 / 断网（会话还挂在服务器上，但经端口打不通对方的代理）连续两次，
//     就结束对方的残留会话并接管；用户在待命方点「让这台承载」时同样接管。
//
// 怎么认出「本账号另一台 Mac」：隧道的远端等待进程以会话标记 codex-tunnel:<本机识别码>:<端口> 结尾
// （见 tunnel-spec 的 buildTunnelMarker）。同端口、识别码不同、属于本账号 = 另一台 Mac 的会话。
//
// 让位：接管方先给对方的等待进程发 USR1，等待进程在 trap 里往会话的标准输出写一行
// SIBLING_YIELD_TOKEN 再退出——对方 Mac 的 ssh 读到这一行就知道是被接力了（计划内，进入待命），
// 而不是断线（断线会立刻重连，和接管方抢端口）。1 秒后对方的 sshd 会话还在（对方睡着、收不到）
// 就直接结束它，端口随之释放。
//
// 机器名：每台 Mac 把自己的名字（只留安全字符）写进集群 ~/.cache/cluster-workbench/tunnel-macs/<识别码>，
// 待命方据此显示「由 MacBook-Air 承载」。这是这套功能在集群上唯一的写入，一行文本，可随时删。
//
// 远端脚本整段不含单引号与 `!`（外层 sh -c '…' 包裹，与对方登录 shell 种类无关，csh 也不做历史替换），
// 也不含完整的会话标记前缀（"codex-tunne""l:" 拼接写出），不会把脚本自己当成隧道会话。
import { TUNNEL_MARKER_PREFIX } from "./tunnel-spec.mjs";

export const SIBLING_YIELD_TOKEN = "codex-tunnel-yield";
export const MACHINE_LABEL_MAX = 40;
const MARKER_RE = /^codex-tunnel:([0-9a-f]{8,32}):(\d{1,5})$/;
const OWNER_ID_RE = /^[0-9a-f]{8,32}$/;
const LABEL_SAFE_RE = /[^A-Za-z0-9._-]/g;

// 机器名只留 [A-Za-z0-9._-]（空格换成 -），去掉 .local 后缀，最多 40 个字符；清洗后为空返回 "Mac"。
export function sanitizeMachineLabel(raw) {
  const text = String(raw ?? "")
    .trim()
    .replace(/\.local$/i, "")
    .replace(/\s+/g, "-")
    .replace(LABEL_SAFE_RE, "")
    .slice(0, MACHINE_LABEL_MAX);
  return text || "Mac";
}

function splitMarker(marker) {
  const match = MARKER_RE.exec(String(marker || ""));
  if (!match) throw new Error(`unsafe tunnel marker: ${JSON.stringify(marker)}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`unsafe tunnel marker: ${JSON.stringify(marker)}`);
  return { ownerId: match[1], port };
}

// 公共片段：变量、登记本机机器名、列出同端口的另一台 Mac 的会话（每个一行 SIB <pid> <识别码> <已运行> <机器名>）。
// list 是一个 sh 函数：接管脚本要先拿到 sshd 父进程再发信号（等待进程一退出就查不到父进程了）。
function preamble(marker, label) {
  const { ownerId, port } = splitMarker(marker);
  const split = TUNNEL_MARKER_PREFIX.length - 1;
  const prefix = `${TUNNEL_MARKER_PREFIX}:`;
  const safeLabel = sanitizeMachineLabel(label);
  return [
    `pre="${prefix.slice(0, split)}""${prefix.slice(split)}"`,
    `port=${port}`,
    `me=${ownerId}`,
    "d=\"$HOME/.cache/cluster-workbench/tunnel-macs\"",
    `mkdir -p "$d" 2>/dev/null && printf "%s\\n" "${safeLabel}" > "$d/$me" 2>/dev/null`,
    // 识别码只认十六进制：tr 删掉合法字符后还剩东西就不是（不用 [!…]，csh 会把 ! 当历史替换）。
    "list() { ps -u \"$(id -u)\" -o pid=,etime=,args= | while read -r pid et args; do"
      + " case \"$args\" in (*\" $pre\"*\":$port\") ;; (*) continue;; esac;"
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 远端 sh 的参数展开（取最后一个词 = 会话标记）
      + " t=\"${args##* }\";"
      + " case \"$t\" in (\"$pre\"*\":$port\") ;; (*) continue;; esac;"
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 远端 sh 的参数展开（去掉前缀与端口，剩识别码）
      + " o=\"${t#\"$pre\"}\"; o=\"${o%:*}\";"
      + " [ -n \"$o\" ] && [ -z \"$(printf %s \"$o\" | tr -d 0-9a-f)\" ] || continue;"
      + " [ \"$o\" = \"$me\" ] && continue;"
      + " l=\"\"; [ -f \"$d/$o\" ] && l=\"$(head -n 1 \"$d/$o\" 2>/dev/null | tr -cd A-Za-z0-9._- | cut -c1-40)\";"
      + " echo \"SIB $pid $o $et $l\";"
      + " done; }",
  ];
}

// 查看：列出另一台 Mac 的会话；有的话经端口打一次对方代理的 /proxy-health（4 秒）。
// HEALTH=ok：对方应答了（任何 HTTP 状态码都算活着）；dead：连上端口却没有应答（对方睡着 / 断网 /
// 对方本机代理没起）；unknown：集群上没有 curl，判断不了（调用方按活着处理，绝不因此抢端口）。
// 最后一行 END 用来识别输出是否完整。
export function buildSiblingSurveyCommand({ marker, label }) {
  const script = [
    ...preamble(marker, label),
    "s=$(list)",
    "[ -n \"$s\" ] && printf \"%s\\n\" \"$s\"",
    "h=none",
    "if [ -n \"$s\" ]; then h=unknown; if command -v curl >/dev/null 2>&1; then"
      + " c=$(curl -s -o /dev/null -w \"%{http_code}\" --noproxy \"*\" --max-time 4 \"http://127.0.0.1:$port/proxy-health\" 2>/dev/null);"
      + " case \"$c\" in ([1-5][0-9][0-9]) h=ok;; (*) h=dead;; esac; fi; fi",
    "echo \"HEALTH=$h\"",
    "echo END",
  ].join("; ");
  return `sh -c '${script}'`;
}

// 接管：先记下每个会话的 sshd 父进程，再给等待进程发 USR1（对方写一行让位通知后退出），
// 1 秒后还在的 sshd 会话直接结束（对方睡着时收不到让位通知，会话不会自己走）。输出 TAKEOVER found=N ended=M。
export function buildSiblingTakeoverCommand({ marker, label }) {
  const script = [
    ...preamble(marker, label),
    "f=0; n=0; pairs=\"\"",
    "for p in $(list | while read -r tag pid rest; do echo \"$pid\"; done); do"
      + " f=$((f+1)); q=$p; i=0; sp=\"\";"
      + " while [ \"$i\" -lt 3 ]; do"
      + " q=$(ps -o ppid= -p \"$q\" 2>/dev/null | tr -d \" \");"
      + " case \"$q\" in (\"\"|0|1) break;; esac;"
      + " case \"$(ps -o args= -p \"$q\" 2>/dev/null)\" in (\"sshd: \"*) sp=$q; break;; esac;"
      + " i=$((i+1));"
      + " done;"
      + " kill -USR1 \"$p\" 2>/dev/null;"
      + " [ -n \"$sp\" ] && pairs=\"$pairs $sp\";"
      + " done",
    "[ \"$f\" -gt 0 ] && sleep 1",
    "for q in $pairs; do kill -0 \"$q\" 2>/dev/null && kill \"$q\" 2>/dev/null && n=$((n+1)); done",
    "[ \"$f\" -gt 0 ] && sleep 1",
    "echo \"TAKEOVER found=$f ended=$n\"",
  ].join("; ");
  return `sh -c '${script}'`;
}

// etime：[[dd-]hh:]mm:ss → 秒；认不出返回 null。
export function parseEtime(text) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(text || "").trim());
  if (!match) return null;
  const [, days = "0", hours = "0", minutes, seconds] = match;
  return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

// 查看结果：{ siblings: [{ pid, ownerId, label, heldSec }], health: "none" | "ok" | "dead" | "unknown" }；
// 输出不完整（没有 END）返回 null——调用方按「没查成」处理，不据此接管。
export function parseSiblingSurvey(stdout) {
  const lines = String(stdout || "").split(/\r?\n/);
  if (!lines.some((line) => line.trim() === "END")) return null;
  const siblings = [];
  let health = null;
  for (const line of lines) {
    const trimmed = line.trim();
    const sib = /^SIB (\d+) ([0-9a-f]{8,32}) (\S+)(?: (\S{1,40}))?$/.exec(trimmed);
    if (sib) {
      if (siblings.length < 8 && OWNER_ID_RE.test(sib[2])) {
        siblings.push({ pid: Number(sib[1]), ownerId: sib[2], heldSec: parseEtime(sib[3]), label: sib[4] ? sanitizeMachineLabel(sib[4]) : null });
      }
      continue;
    }
    const h = /^HEALTH=(none|ok|dead|unknown)$/.exec(trimmed);
    if (h) health = h[1];
  }
  if (!health) return null;
  return { siblings, health: siblings.length ? health : "none" };
}

export function parseSiblingTakeover(stdout) {
  const match = /TAKEOVER found=(\d+) ended=(\d+)/.exec(String(stdout || ""));
  return match ? { found: Number(match[1]), ended: Number(match[2]) } : null;
}

// 同一台 Mac 可能有多个会话（理论上只有一个）：显示用取第一个有名字的，识别码取第一个。
export function describeHolder(siblings = []) {
  if (!Array.isArray(siblings) || !siblings.length) return null;
  const named = siblings.find((s) => s.label) || siblings[0];
  return { ownerId: siblings[0].ownerId, label: named.label || null, heldSec: siblings[0].heldSec ?? null };
}
