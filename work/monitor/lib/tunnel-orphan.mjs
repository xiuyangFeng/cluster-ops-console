// 孤儿反向隧道的判定（纯函数、无 IO、无计时器、无副作用）。
// 设计：docs/superpowers/specs/2026-09-02-multi-tunnel-team-hub-design.md §6.2 末尾 / §6.7 / §8
//
// 真实故障（生产 Mac，2026-08）：一条比 supervisor 还老的 `ssh -R` 进程占着远端 7891，
// supervisor 每次重建都被 ssh 以 `remote port forwarding failed` 顶回来并退避重试。
// 但数据面其实一直由那条孤儿在服务——集群上的 reclaude/codex 从没断过。
// 所以这不是故障，是"记账丢了"：正确动作是**认领**（把它登记进注册表，当自己的隧道），
// 而不是反复重建、也绝不是把它杀掉（杀了才会真断网）。
//
// 本模块只回答"该认领谁"，一律不执行任何动作（不写注册表、不杀进程）——
// 副作用全部留在 channel-supervisor 的控制器里，见 §0 的 L2 边界：
// 自动修复最多做到"本机有副作用"，且必须可关闭、可只观察。
//
// 判定材料刻意只用命令行：反向隧道进程的 argv 里带着精确的 -R 转发串与 host，
// 这是唯一跨 macOS/Linux 都拿得到、又不需要额外权限的强特征。

import { matchesManagedProcess } from "./channel-lifecycle.mjs";
import { cmdlineMatches, parseCmdlineRows } from "./process-registry.mjs";
import { tunnelMarkerOwnerId } from "./supervisor/tunnel-spec.mjs";

// 规则 id 与 auto-repair-policy 的 DEFAULT_AUTO_REPAIR_CONFIG.rules 同名。
// 规则本身在 supervisor 内实现（判定材料只在 supervisor 进程里），
// 但开关归属同一份 autoRepair 配置，所以 id 必须逐字一致。
export const ORPHAN_RULE_ID = "orphan-tunnel-adopt";

// OpenSSH 在 ExitOnForwardFailure=yes 下的原话：
//   "Warning: remote port forwarding failed for listen port 7891"
// 退出码与"连不上主机"完全一样（255），只有这一行 stderr 能证明"端口被占"。
export const FORWARD_FAILED_RE = /remote port forwarding failed/i;

// buildTunnelSignature 的逆向：`-R 127.0.0.1:<remote>:127.0.0.1:<local> <host>`。
// 之所以从签名反解而不是让调用方再传一份 config：签名就是 buildTunnelSignature(config)
// 的产物，两者若各传各的就有"签名匹配 A、受管校验按 B"的错位空间。
const SIGNATURE_RE = /^-R\s+127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)\s+(\S+)$/;

function parseTunnelSignature(signature) {
  const match = SIGNATURE_RE.exec(String(signature || "").trim());
  if (!match) return null;
  return { remotePort: Number(match[1]), localPort: Number(match[2]), host: match[3] };
}

// 只认领我们自己的隧道（设计 §8）。`ps -axo pid=,command=` 拿不到 cwd，归属只能看命令行：
// v2.30 起本实例建的隧道带会话标记 codex-tunnel:<本机识别码>:<端口>。标记里的识别码与
// ownerId 不同 → 另一个 checkout / 运行时建的隧道，对本实例就是异己，既不认领也不杀。
// 不带标记的（旧 -N 隧道、回落 -N 的服务器）无从区分归属，沿用签名判定。
function isOwnedOrUnmarked(command, ownerId) {
  const owner = tunnelMarkerOwnerId(command);
  return owner === null || owner === ownerId;
}

// stderr 命中 → 三选一：
//   adopt  本机有一条跑着同一条 -R 的受管 ssh：登记它，当健康隧道（数据面本来就归它）
//   foreign 远端端口确实在监听，但本机没有对应进程：端口被异己占用，长退避 + 提示人工，不杀
//   retry  其它（没命中正则 / 远端也没监听 / win32）：交给既有的快速失败退避
//
// 注意 adopt 不要求 remoteListening：远端探测要再开一条 SSH，可能超时；
// "本机有一条跑着同一条 -R 的 ssh 进程"这件事本身已经比远端探测更硬。
export function classifyForwardFailure({
  stderr = "",
  remoteListening = false,
  localSshProcesses = [],
  signature = "",
  // 本机识别码（owner-id.mjs）；为空时任何带标记的候选都不是自己的。
  ownerId = null,
  supervisorPid = null,
  platform = process.platform,
} = {}) {
  if (!FORWARD_FAILED_RE.test(String(stderr || ""))) {
    return { verdict: "retry", reason: "stderr 未出现 remote port forwarding failed，不是远端端口被占" };
  }
  // Windows 没有 POSIX 的 ps，扫不出本机 ssh 进程清单就没有认领的依据；
  // 猜着认领比不认领危险得多（会把异己进程登记成自己的隧道），本期一律退回重试。
  if (platform === "win32") {
    return { verdict: "retry", reason: "win32 没有 ps，本期不做孤儿认领，按普通失败退避" };
  }

  const config = parseTunnelSignature(signature);

  const candidates = (Array.isArray(localSshProcesses) ? localSshProcesses : [])
    .filter((proc) => Number.isInteger(proc?.pid) && proc.pid > 0)
    .filter((proc) => typeof proc.command === "string" && proc.command !== "")
    // supervisor 自己绝不可能是那条 ssh；显式排除，杜绝"把自己登记成隧道"的自噬。
    .filter((proc) => proc.pid !== supervisorPid)
    // 与注册表校验同一把尺子：签名按空白切成强特征片段，每一段都必须出现在命令行里。
    .filter((proc) => cmdlineMatches(proc.command, { signature }))
    .filter((proc) => matchesManagedProcess(proc.command, { role: "tunnel", config }))
    .filter((proc) => isOwnedOrUnmarked(proc.command, ownerId))
    // pid 最小 = 最老（同一次开机内 pid 单调递增）。多条同签名并存时，
    // 还在服务数据面的是最先建立的那条——后来的都已经被 ssh 顶回去了。
    .sort((a, b) => a.pid - b.pid);

  if (candidates.length > 0) {
    const winner = candidates[0];
    return {
      verdict: "adopt",
      pid: winner.pid,
      command: winner.command,
      reason: `本机 pid=${winner.pid} 的 ssh 正在跑同一条 ${signature}，认领它而不是反复重建`,
    };
  }

  if (remoteListening === true) {
    return {
      verdict: "foreign",
      reason: `远端 ${config?.host ?? "?"}:${config?.remotePort ?? "?"} 有进程在监听，但本机没有任何与之对应的受管 ssh`,
    };
  }

  return { verdict: "retry", reason: "远端端口没在监听、本机也没有可认领的 ssh，按普通失败退避重试" };
}

// 只保留 ssh 客户端进程：命令以 `ssh ` 开头（PATH 里的 ssh）或含 `/ssh `（绝对路径调用）。
// 这条过滤同时挡掉 sshd（`sshd: user@notty`）与恰好把 "ssh" 写进参数的无关进程
// （`grep ssh`）——它们进不了候选集，签名比对也就不必替它们兜底。
function isSshCommand(command) {
  return command.startsWith("ssh ") || command.includes("/ssh ");
}

// 输入是 `ps -axo pid=,command=` 的输出（行解析与注册表批量校验共用 parseCmdlineRows）。
export function parseSshProcessList(stdout) {
  return [...parseCmdlineRows(stdout)]
    .filter(([pid, command]) => pid > 0 && isSshCommand(command))
    .map(([pid, command]) => ({ pid, command }));
}
