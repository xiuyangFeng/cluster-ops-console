// 隧道 ssh 参数 / 精确签名 / 配置身份（纯函数，零副作用）。
//
// 签名供 process-registry 的 pid 复用校验使用（见 D2），身份（签名 + 认证/钉扎要素）决定
// "现有 ssh 进程是否仍代表期望的配置"。本模块只 import 零副作用模块，monitor 侧
// （channel-lifecycle / operations-runner 目前各有一份签名构造副本）可以直接复用。
import { buildHostKeyArgs } from "../host-key-policy.mjs";
import { assertSafeHost, assertSafePort, buildSshIdentityArgs, buildSshPortArgs } from "../ssh-args.mjs";

// ---- 隧道会话标记（残留会话回收用）----
// 网络切换（换 IP / 换校园网账号）后，本机 ssh 已死，但服务器端 sshd 察觉不到（客户端旧 IP
// 已不存在，收不到 RST），残留会话会一直占着反向端口：有待发数据时要重传约 15 分钟，空闲时
// 要等 TCP keepalive（常见 2 小时）。普通账号本可以结束自己的 sshd 会话进程，但 sshd 把自己设为
// non-dumpable，普通用户看不到哪个会话持有端口。
// 做法：隧道不再用 -N，而是在远端挂一个带标记的等待进程——它的父进程正是这条会话的 sshd；
// 端口被占时就能按标记精确找到并结束自己的残留会话。会话结束后等待进程 30 秒内自行退出，
// 远端不写任何文件。标记 = codex-tunnel:<本机识别码>:<远端端口>，识别码每台 Mac 一个。
export const TUNNEL_MARKER_PREFIX = "codex-tunnel";
const TUNNEL_OWNER_ID_RE = /^[0-9a-f]{8,32}$/;
const TUNNEL_MARKER_RE = /^codex-tunnel:[0-9a-f]{8,32}:\d{1,5}$/;

export function buildTunnelMarker(ownerId, remotePort) {
  if (!TUNNEL_OWNER_ID_RE.test(String(ownerId || ""))) {
    throw new Error(`unsafe tunnel owner id: ${JSON.stringify(ownerId)}`);
  }
  return `${TUNNEL_MARKER_PREFIX}:${ownerId}:${assertSafePort(remotePort, "remotePort")}`;
}

function assertTunnelMarker(marker) {
  const value = String(marker || "");
  if (!TUNNEL_MARKER_RE.test(value)) throw new Error(`unsafe tunnel marker: ${JSON.stringify(marker)}`);
  return value;
}

// 命令行里会话标记的本机识别码（标记是远端等待命令的最后一个参数）；不带标记（-N 隧道）返回 null。
export function tunnelMarkerOwnerId(cmdline) {
  const marker = String(cmdline || "").split(/\s+/).find((token) => TUNNEL_MARKER_RE.test(token));
  return marker ? marker.split(":")[1] : null;
}

// 远端等待进程：经登录 shell 执行（exec 替换掉登录 shell，于是 sh 的父进程就是会话的 sshd）。
// 只用 bash / zsh / sh / fish 都认得的写法：exec + 单引号字面量；$PPID 由内层 sh 展开。
// v2.88：USR1 = 同账号另一台 Mac 接管了这个端口（见 sibling-tunnel.mjs）——先往会话标准输出写一行
// 让位通知（本机 ssh 读到后按计划内交接处理、进入待命，不去抢回端口）再退出。sleep 放到后台再 wait：
// 前台 sleep 期间 sh 不处理信号，要等满 30 秒；wait 会被信号打断，trap 立刻执行。后台 sleep 的输入输出
// 一律重定向：否则它继承会话的标准输出，等待进程退出后 sshd 还要等它睡完（最多 30 秒）才关会话。
// 让位通知的字面量与 sibling-tunnel.mjs 的 SIBLING_YIELD_TOKEN 一致（sibling-tunnel.test.mjs 守着）。
export function buildTunnelHoldCommand(marker) {
  return `exec sh -c 'trap "echo codex-tunnel-yield; exit 0" USR1; while kill -0 "$PPID" 2>/dev/null; do sleep 30 </dev/null >/dev/null 2>&1 & wait; done' ${assertTunnelMarker(marker)}`;
}

// 远端回收脚本：找出本账号下以「 <标记>」结尾的等待进程，沿父进程向上找到第一个
// `sshd: ` 进程（会话的用户侧 sshd，属于本账号，无需 root）并结束它，端口随会话一起释放。
// 标记用拼接写出（"codex-tunne""l:…"），脚本自身的命令行里不出现完整标记，不会匹配到自己。
// 整段不含单引号，外层用 sh -c '...' 包住，与登录 shell 种类无关。输出 "found=N reclaimed=M"。
export function buildStaleSessionReclaimCommand(marker) {
  const value = assertTunnelMarker(marker);
  const split = TUNNEL_MARKER_PREFIX.length - 1;
  const script = [
    `m="${value.slice(0, split)}""${value.slice(split)}"`,
    "f=0; n=0",
    // case 分支一律写成 "(模式)"：模式后的 ")" 出现在 $( ) 里时，bash 会把它当成命令替换的结尾。
    `for p in $(ps -u "$(id -u)" -o pid=,args= | while read -r pid args; do case "$args" in (*" $m") echo "$pid";; esac; done); do`,
    "f=$((f+1)); q=$p; i=0",
    "while [ \"$i\" -lt 3 ]; do",
    "q=$(ps -o ppid= -p \"$q\" 2>/dev/null | tr -d \" \")",
    "case \"$q\" in (\"\"|0|1) break;; esac",
    "case \"$(ps -o args= -p \"$q\" 2>/dev/null)\" in (\"sshd: \"*) kill \"$q\" 2>/dev/null && n=$((n+1)); break;; esac",
    "i=$((i+1))",
    "done",
    "done",
    "echo \"found=$f reclaimed=$n\"",
  ].join("; ").replace(/; do;/g, "; do").replace(/do; /g, "do ");
  return `sh -c '${script}'`;
}

export function parseStaleSessionReclaimOutput(stdout) {
  const match = /found=(\d+) reclaimed=(\d+)/.exec(String(stdout || ""));
  return match ? { found: Number(match[1]), reclaimed: Number(match[2]) } : null;
}

// 心跳容忍（ServerAliveInterval × CountMax）：多久收不到服务器回应就判定连接已死、退出重连。
// - 团队集群（source=team，校园网内、链路稳）：20s × 2 = 40s，唤醒 / 断线后尽快重建；
// - 个人服务器（source=personal，多为公网云主机）：20s × 5 = 100s。实测阿里云跨公网链路
//   偶有 40–50s 的短暂丢包，40s 门槛会把隧道和走它的长连接一起掐断（之后几秒内就能重连上），
//   放宽后 ssh 扛过抖动、连接不断。
// 心跳参数不在 buildTunnelIdentity 里：改动不触发现有隧道重启，下次重连时生效。
export const TUNNEL_ALIVE_INTERVAL_S = 20;
export function tunnelAliveCountMax(config) {
  return config?.source === "personal" ? 5 : 2;
}

export function buildTunnelArgs(config) {
  // 注意：不要在这里加 ControlMaster/ControlPath/ControlPersist 复用 mux。
  // 打包 .app 的 runtimeDir 落在 "~/Library/Application Support/..."，路径含空格会让
  // ssh 的 -o ControlPath 解析失败(exit 255) 使隧道永不建立；且 ControlPersist 会把 -R
  // 转发后台化到一个 supervisor 追踪不到的 master，破坏 A1/A3 的进程管理契约(假死+孤儿)。
  // 纵深防御：host 做 ssh 位置参数、端口进 -R 转发串——即使调用方绕过
  // normalizeAgentConfig，这里也拒绝选项注入形态（"-o..." host）与非法端口。
  const host = assertSafeHost(config.host);
  const remotePort = assertSafePort(config.remotePort, "remotePort");
  const localPort = assertSafePort(config.localPort, "localPort");
  const args = [
    // Ignore any ambient ssh_config ControlMaster socket for managed tunnels.
    "-S", "none",
    "-o", "ExitOnForwardFailure=yes",
    "-o", `ServerAliveInterval=${TUNNEL_ALIVE_INTERVAL_S}`,
    "-o", `ServerAliveCountMax=${tunnelAliveCountMax(config)}`,
    "-o", "TCPKeepAlive=yes",
    "-o", "BatchMode=yes",
    ...buildHostKeyArgs({ knownHostsPath: config.knownHostsPath }),
    "-o", "ConnectTimeout=10",
  ];
  args.push(...buildSshPortArgs(config.sshPort));
  args.push(...buildSshIdentityArgs(config));
  // 带会话标记时用 -T + 远端等待进程（见 buildTunnelHoldCommand）；没有标记（win32 / 远端不支持
  // 执行命令时的回落）保持 -N。-R 转发串与 host 在两种形态下位置相同，签名匹配不受影响。
  if (config.reclaimMarker) {
    args.push("-T", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host, buildTunnelHoldCommand(config.reclaimMarker));
  } else {
    args.push("-N", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${localPort}`, host);
  }
  return args;
}

export function buildTunnelSignature(config) {
  return `-R 127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort} ${config.host}`;
}

export function buildTunnelIdentity(config) {
  return JSON.stringify([buildTunnelSignature(config), config.sshPort || 22, config.sshUser || "", config.sshIdentityFile || "", config.authRef || "", config.knownHostsPath || "", config.knownHostsRevision || ""]);
}
