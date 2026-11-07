// Codex 客户端（桌面端 / IDE 远程模式）在集群上的常驻 app-server：读它的代理端口、判断是否漂移，
// 以及重启它所需的固定远端命令。
//
// 为什么需要这块：桌面端经 SSH 连到集群后，消息不是由新开的 codex 进程处理，而是交给一个常驻的
// `codex app-server --listen …` 守护进程。它在启动时就把 HTTPS_PROXY 定住了；之后再重跑接入向导、
// 换反向端口（例如 7891 → 7893），它仍走旧端口，于是桌面端每条消息都连不上代理、一直重试，
// 界面上看起来就是「发出去了但没有回复」；而终端里新开的 codex 读到新的 env.sh，一切正常。
// 这里把守护进程的代理端口读回来，和当前 remotePort 比对；不一致就由 doctor 探针转成告警。
//
// 只读：远端脚本只遍历**本人**的 codex 进程，从 /proc/<pid>/environ 里取 HTTPS_PROXY 的端口号，
// 不输出整条代理地址（可能带口令）。重启命令是常量（不拼任何请求里的字符串），并且先用
// `bash -lc` 进入登录 shell，才能拿到 env.sh 里的新端口与 keys/*.env 里的凭证。
import { wrapSh } from "../shell/wrap-sh.mjs";
import { isPort } from "../validators.mjs";

export const APP_SERVER_BEGIN_MARKER = "__CODEX_APP_SERVER_BEGIN__";
export const APP_SERVER_END_MARKER = "__CODEX_APP_SERVER_END__";
export const APP_SERVER_RESTART_TIMEOUT_MS = 90000;

// 远端只读脚本：输出 `pid=<数字> proxy=<数字|none>`，每个 app-server 守护进程一行。
// - pgrep -x codex 只找进程名是 codex 的（`codex app-server proxy` 的 cmdline 不含 --listen，
//   会在下一行被筛掉）；-u 限定本人，读不到别人的 /proc。
// - 代理地址可能带 `user:pass@`，这里只回传最后一个冒号后的端口，口令不出集群。
// - 行数封顶 16：正常每个账号最多一两个守护进程，异常情况也不回一屏。
const READ_SCRIPT = [
  'for p in $(pgrep -u "$(id -u)" -x codex 2>/dev/null); do',
  '  c=$(tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null) || continue',
  '  printf "%s" "$c" | grep -q "app-server --listen" || continue',
  '  if [ -r "/proc/$p/environ" ]; then',
  '    v=$(tr "\\0" "\\n" < "/proc/$p/environ" 2>/dev/null | sed -n "s|^[Hh][Tt][Tt][Pp][Ss]_[Pp][Rr][Oo][Xx][Yy]=[A-Za-z0-9+.-]*://.*:\\([0-9][0-9]*\\)/*$|\\1|p" | head -n 1)',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是远端 sh 的变量默认值，不是漏写的 JS 模板串
  '    echo "pid=$p proxy=${v:-none}"',
  '  fi',
  'done | head -n 16',
];

// 交给 ssh 的命令：整段脚本经 sh -c 执行（远端登录 shell 可能是 tcsh / csh）。
export const APP_SERVER_READ_COMMAND = wrapSh(READ_SCRIPT);

// 官方托管 daemon 的重启：进入登录 shell 再执行，让新进程继承 env.sh（新端口）与 keys/*.env（凭证）。
export const APP_SERVER_RESTART_COMMAND = wrapSh(["bash -lc 'codex app-server daemon restart'"]);

// 旧版本 / 非托管 daemon 会拒绝 `daemon restart`（"not managed by codex app-server daemon"）。
// 这时按固定步骤收尾：停掉本人所有 app-server 守护进程 → 删掉旧控制 socket → 用登录 shell 起托管 daemon。
// 只认 cmdline 里同时有 app-server 与 --listen 的 codex 进程；proxy 进程与 TUI 不动。
const RECOVERY_SCRIPT = [
  'for p in $(pgrep -u "$(id -u)" -x codex 2>/dev/null); do',
  '  c=$(tr "\\0" " " < "/proc/$p/cmdline" 2>/dev/null) || continue',
  '  printf "%s" "$c" | grep -q "app-server --listen" || continue',
  '  kill "$p" 2>/dev/null && echo "stopped=$p"',
  'done',
  'sleep 1',
  's="$HOME/.codex/app-server-control/app-server-control.sock"',
  'if [ -L "$s" ]; then t=$(readlink "$s" 2>/dev/null); case "$t" in /tmp/codex-daemon-*) rm -f "$t" ;; esac; fi',
  'rm -f "$s"',
  "bash -lc 'codex app-server daemon start'",
];

export const APP_SERVER_RECOVERY_COMMAND = wrapSh(RECOVERY_SCRIPT);

// 标记段 → [{ pid, proxyPort }]；没见到开始标记（SSH 没到远端 / 被截断）返回 null，
// 见到标记但没有进程返回 []。只认严格形状，其余行一律丢弃。
export function parseAppServerSection(text) {
  if (text == null) return null;
  const seen = new Set();
  const instances = [];
  for (const raw of String(text).split("\n").slice(0, 32)) {
    const match = /^pid=(\d{1,10}) proxy=(\d{1,5}|none)$/.exec(raw.trim());
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    const proxyPort = match[2] === "none" ? null : Number(match[2]);
    if (proxyPort !== null && !isPort(proxyPort)) continue;
    seen.add(pid);
    instances.push({ pid, proxyPort });
  }
  return instances;
}

// 把进程列表和当前配置到的 remotePort 比成一份状态。running=null 表示这一轮没读到。
export function summarizeAppServer(instances, expectedPort) {
  const expected = isPort(expectedPort) ? expectedPort : null;
  if (instances == null) return { running: null, expectedPort: expected, instances: [], mismatch: false, noProxy: false };
  if (!instances.length) return { running: false, expectedPort: expected, instances: [], mismatch: false, noProxy: false };
  const stale = expected != null && instances.some((item) => item.proxyPort != null && item.proxyPort !== expected);
  const noProxy = expected != null && instances.some((item) => item.proxyPort == null);
  return { running: true, expectedPort: expected, instances, mismatch: stale, noProxy };
}

// 状态里那一句告警；没有漂移 / 没运行 / 没配置端口时返回 null。
// 只暴露端口与 PID，不带代理地址（可能带口令）。
export function appServerWarning(appServer) {
  if (appServer?.running !== true || !isPort(appServer.expectedPort)) return null;
  const expected = appServer.expectedPort;
  if (appServer.mismatch) {
    const actual = [...new Set(appServer.instances.filter((item) => item.proxyPort != null).map((item) => String(item.proxyPort)))].join(" / ");
    return `降级：Codex 客户端守护进程仍走旧代理端口 ${actual || "旧的未知端口"}（当前应为 ${expected}），桌面端发消息会没有回复`;
  }
  if (appServer.noProxy) {
    return `降级：Codex 客户端守护进程没有走隧道代理（当前应为 ${expected}），桌面端发消息可能没有回复`;
  }
  return null;
}

// 重启失败是不是「daemon 不是 CLI 托管的」——只有这种情况才走收尾步骤。
export function isUnmanagedRestartFailure(output) {
  return /not managed by codex app-server daemon|is not managed/i.test(String(output ?? ""));
}

// 重启结果的文字（toast / 时间线共用），不含远端输出原文。
export function describeRestartResult(result) {
  if (result === "restarted") return "已重启 Codex 客户端守护进程，桌面端重连后会使用当前隧道端口";
  if (result === "recovered") return "已停掉旧的守护进程并重新启动，桌面端重连后会使用当前隧道端口";
  return "重启 Codex 客户端守护进程没有成功";
}
