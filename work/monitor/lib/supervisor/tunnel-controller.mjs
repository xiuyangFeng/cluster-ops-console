// ---------------------------------------------------------------------------
// SSH 反向隧道控制器（A1/A2/A3(部分)/A5/A6 均落在这里）
// ---------------------------------------------------------------------------
// 每台服务器一个实例：保活 ensure、受控重启、孤儿隧道接管（L2）、热更新交接释放。
// 孤儿判定/认领会改写本控制器的闭包状态（adoptedPid / 退避），因此留在控制器内部。
import { spawn } from "node:child_process";
import path from "node:path";

import { computeTunnelBackoffSec } from "../../monitor-core.mjs";
import { createRateLimiter, isRuleEnabled, normalizeAutoRepairConfig } from "../auto-repair-policy.mjs";
import { execFileWithTimeout } from "../exec.mjs";
import { ensurePidExited, waitForPidExit } from "../process-registry.mjs";
import { classifySshFailure } from "../ssh-args.mjs";
import { createPasswordSshSession } from "../ssh-askpass.mjs";
import { ensureWindowsOpenSshOnPath } from "../platform.mjs";
import { classifyForwardFailure, FORWARD_FAILED_RE, ORPHAN_RULE_ID, parseSshProcessList } from "../tunnel-orphan.mjs";
import { readWindowsProcesses } from "../processes/query.mjs";
import { isSshStderrNoise } from "./log-policy.mjs";
import { createMutationQueue } from "./mutation-queue.mjs";
import { readTunnelPassword, remotePortOpen, runRemoteCommand } from "./remote-probe.mjs";
import { createSiblingHandover } from "./sibling-handover.mjs";
import { SIBLING_YIELD_TOKEN } from "./sibling-tunnel.mjs";
import {
  buildStaleSessionReclaimCommand,
  buildTunnelArgs,
  buildTunnelIdentity,
  buildTunnelMarker,
  buildTunnelSignature,
  parseStaleSessionReclaimOutput,
} from "./tunnel-spec.mjs";

// A2：探测判定隧道"死"需要连续 N 次确认（而非单次抖动即杀），避免瞬时网络毛刺
// 把健康隧道杀成孤儿制造链的起点。
// S6：新 spawn 后的建立宽限期——ssh 握手/端口转发就绪需要几秒，宽限期内探测失败不判死。
// S6：睡眠/唤醒自愈——相邻两次 ensure() 间隔超过此值视为 Mac 睡眠后唤醒，强制立即复检+重置退避。
export const TUNNEL_DEATH_THRESHOLD = 3;
export const SPAWN_GRACE_MS = 12000;
export const WAKE_GAP_MS = 90000;
// 停旧 ssh 时等它真正退出的预算（超时 SIGKILL 升级）；交接退出的 tickBudgetMs 按它算。
const RESPAWN_WAIT_BUDGET_MS = 2000;
// 会话"已建立"的判据：ssh 存活满这么久。ConnectTimeout=10s 内连不上会退出，带
// ExitOnForwardFailure 的转发失败在认证后立刻退出——活过 20s 即说明连接与 -R 都已就绪。
// 此前只要进程活着（还在握手）就当健康并清零退避，退避因此永远停在"第 1 次 / 5 秒"。
export const TUNNEL_ESTABLISHED_MS = 20000;
// 连不上时的退避上限（秒）。共用的 computeTunnelBackoffSec 上限是 300s；隧道这里收紧到 120s：
// 网络恢复但本机地址没变（代理 TUN 恢复、服务器重启完）时不必干等 5 分钟。地址一变仍立即重试。
export const TUNNEL_MAX_BACKOFF_S = 120;
// 连续快速失败达到这个次数时记一条"当前网络连不上"的日志（只记一次，恢复后重新计）。
const UNREACHABLE_LOG_AFTER = 3;
// 断线前这么久内发生过本机网络切换，断线原因附带 networkChange 标记。
const NETWORK_CHANGE_ATTRIBUTION_MS = 120000;
// 休眠归因：挂钟跳变（见 WAKE_GAP_MS）期间、或醒来后这么久内发现的断线，账本的 down 行带 sleep 标记——
// 电脑合盖 / 休眠时隧道本来就不可能在，读侧（lib/tunnel-ledger-stats.mjs）不把它算成断线。与 networkChange
// 的归因窗口同长。只是记账：重连、退避、残留会话回收都不看它。
export const SLEEP_ATTRIBUTION_MS = 120000;
// 计划内的停止（不算断线）：用户受控重启 / 配置变更重建 / 停止通道与退出。
// handover：同账号另一台 Mac 接管了端口（本机读到让位通知），见 sibling-handover.mjs。
const PLANNED_STOP_REASONS = new Set(["restart", "config-change", "stopped", "handover"]);

// 已建立会话异常结束时，按 ssh 最后一行 stderr 归因（断线账本的 cause 字段）。
// 握手阶段就被对端断开（"Connection closed by 1.2.3.4 port 22" / kex_exchange_identification）：服务器不接
// 这条连接，与 Connection refused 同归 refused。已建立的会话被断开是另一句
// （"Connection to 1.2.3.4 closed by remote host."），不在此列。
// 只在隧道这一侧补认，不改 ssh-args 的 classifySshFailure：那个文件在本机代理的依赖闭包里，
// 动它会改变代理指纹、升级时多做一次代理交接。
const HANDSHAKE_CLOSED_RE = /kex_exchange_identification|Connection (?:closed|reset) by \S+ port \d+/i;
const HANDSHAKE_CLOSED_ACTION = "服务器在握手阶段断开了连接：确认当前网络是否在 SSH 白名单内（本机开着全局代理 / TUN 时，服务器看到的是代理的出口地址）";

export function classifyTunnelSshFailure(text) {
  return classifySshFailure(text)
    || (HANDSHAKE_CLOSED_RE.test(String(text || "")) ? { code: "refused", nextAction: HANDSHAKE_CLOSED_ACTION } : null);
}

export function classifyTunnelDrop(stderr) {
  const s = String(stderr || "");
  if (/Timeout, server .* not responding/i.test(s)) return "keepalive-timeout";
  if (/closed by remote host/i.test(s)) return "remote-closed";
  if (/reset by peer|Connection reset/i.test(s)) return "reset";
  if (/Broken pipe/i.test(s)) return "broken-pipe";
  if (/Connection closed by/i.test(s)) return "closed";
  return "unknown";
}

// 孤儿隧道接管（L2，设计 §6.2 末尾 / §6.7）的三个数：
// 每服务器 5 分钟最多认领 1 次——认领是有副作用的动作（改注册表 + 让 supervisor
// 从此把一个非子进程当成自己的隧道），判错一次的代价远大于晚修几分钟。
const ORPHAN_ADOPT_COOLDOWN_MS = 300_000;
const ORPHAN_ADOPT_WINDOW_MS = 300_000;
// 端口被异己占用时的长退避：这不是重试能解决的问题（对方不会自己让开），
// 5 秒一拍地空打只会刷屏并浪费 SSH 配额，交给人换端口或联系占用者。
const TUNNEL_FOREIGN_BACKOFF_MS = 300_000;

// 残留会话回收（换网后服务器端 sshd 残留、占着反向端口；见 tunnel-spec 的会话标记）。
// 规则 id 与 auto-repair-policy 的 DEFAULT_AUTO_REPAIR_CONFIG.rules 同名，可单独关闭。
export const STALE_SESSION_RECLAIM_RULE_ID = "stale-session-reclaim";
// 回收是有副作用的远端动作（结束本账号的残留 sshd 会话）：两次之间至少 30 秒、10 分钟内最多 4 次。
const RECLAIM_COOLDOWN_MS = 30_000;
const RECLAIM_WINDOW_MS = 600_000;
const RECLAIM_MAX_PER_WINDOW = 4;
// 回收没能给出结论（查询那次 SSH 自己失败了，或刚查过还在冷却里）时，过了冷却就再来一次，
// 不能凭一次没查成就按"别人占着"退避 5 分钟：2026-10-08 的两次掉线都是这样多等出来的——集群先把
// 连接关掉，断线后的预回收恰好撞上（ssh 255），10 秒后重连发现端口被占时回收还在冷却里。
const RECLAIM_RECHECK_MS = RECLAIM_COOLDOWN_MS + 5000;
// 结束残留会话后给服务器一点时间释放端口，再重建隧道。
const RECLAIM_SETTLE_MS = 2000;
const RECLAIM_TIMEOUT_MS = 10000;
// 远端等待进程起不来（服务器强制命令 / 没有 sh 等）时 ssh 会很快以非 255 退出：
// 这个窗口内出现一次就回落到 -N（该服务器不再支持残留会话回收，但隧道照常工作）。
const HOLD_COMMAND_FAST_EXIT_MS = 15000;

// lsof -Fn 的一行形如 "n10.0.4.21:51606->203.0.113.10:22"（IPv6 带方括号）。
export function parseLsofLocalAddresses(stdout) {
  const out = new Set();
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("n") || !line.includes("->")) continue;
    const local = line.slice(1, line.indexOf("->"));
    const bracket = /^\[([^\]]+)\]:\d+$/.exec(local);
    const plain = /^([^:]+):\d+$/.exec(local);
    const address = bracket ? bracket[1] : plain ? plain[1] : null;
    if (address) out.add(address);
  }
  return [...out];
}

// runtimeDir：supervisor 运行时目录（密码隧道的 vault 端点文件与 askpass helper 目录都在它下面）。
export function createTunnelController({
  spawnImpl = spawn,
  execFileImpl = execFileWithTimeout,
  credentialVault,
  runtimeDir,
  askpassDir = runtimeDir ? path.join(runtimeDir, "askpass") : undefined,
  createPasswordSshSessionImpl = createPasswordSshSession,
  registry: registryImpl,
  // 注册表记录名，必填：monitor-core.tunnelRecordName(serverId)。
  name,
  log: logImpl = () => {},
  now = Date.now,
  waitForPidExitImpl = waitForPidExit,
  computeBackoffSec = computeTunnelBackoffSec,
  removeRuntimeRecord: removeRuntimeRecordImpl = async () => {},
  recordRuntimeProcess: recordRuntimeProcessImpl = () => {},
  isLocalProxyHealthy = async () => true,
  rootDir: controllerRootDir = process.cwd(),
  emitStage: emitStageRaw = () => {},
  probeTimeoutMs = 6000,
  deathThreshold = TUNNEL_DEATH_THRESHOLD,
  spawnGraceMs = SPAWN_GRACE_MS,
  // 认领来的隧道不是子进程，停它只能按 pid 发信号；做成可注入是为了测试不真杀进程。
  killProcess = (pid, signal) => process.kill(pid, signal),
  // ---- 孤儿隧道接管（L2）----
  // 本机全部 ssh 进程清单。默认走注入的 execFileImpl，测试里既不会真的 fork ps，
  // 生产里也与探测 SSH 共用同一套超时/输出上限封装。用 `ps -axo pid=,command=` 一次取全，
  // 而不是 pgrep ssh：pgrep 的匹配语义各平台不一致，且本来就要拿完整命令行做签名比对。
  listSshProcesses = async () => {
    if (platform === "win32") return parseSshProcessList((await readWindowsProcesses(execFileImpl)).map((p) => `${p.pid} ${p.command}`).join("\n"));
    const result = await execFileImpl("ps", ["-axo", "pid=,command="], { timeoutMs: 3000, cwd: controllerRootDir });
    return result.code === 0 ? parseSshProcessList(result.stdout) : [];
  },
  // 最近一次 loadConfig 合并出的 autoRepair 配置。做成 getter 而不是快照：
  // 配置热改（config.local.json）后不必重建 controller 就能生效，也不会把一份
  // 陈旧配置钉死在进程生命周期上。
  getAutoRepair = () => null,
  // 与 auto-repair-policy 同一套限频语义（同一份实现），保证"每服务器 5 分钟 1 次"
  // 与策略层的口径逐字一致。生产里所有 controller 共用一个实例，见 createTunnelControllerFor。
  rateLimiter = createRateLimiter({ now }),
  selfPid = process.pid,
  // POSIX 用 ps，Windows 用 CIM；两端使用相同的命令行归属与签名复核。
  // 与本模块其它依赖一样做成可注入，测试才能在任一宿主上覆盖两侧行为。
  platform = process.platform,
  // 本机识别码（每台 Mac 一个，持久化在 runtimeDir）。有它才给隧道挂会话标记、才能回收残留会话；
  // win32 的进程命令行会给带空格的参数加引号，与登记的命令行对不上，一律不挂标记（保持 -N）。
  tunnelOwnerId = null,
  runRemoteCommandImpl = runRemoteCommand,
  // 本机 ssh 进程当前 TCP 连接的本端地址（网络切换时判断隧道连接是否已随旧地址失效）。
  readTcpLocalAddresses = async (pid) => {
    const result = await execFileImpl("lsof", ["-a", "-nP", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { timeoutMs: 3000, cwd: controllerRootDir });
    if (result.code !== 0 && !result.stdout) return null;
    return parseLsofLocalAddresses(result.stdout);
  },
  // 断线账本：会话建立（up）/ 结束（down）时回调一次，supervisor 追加写 tunnel-ledger.ndjson。
  onSessionEvent = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // 本机机器名（只留安全字符，见 sibling-tunnel 的 sanitizeMachineLabel）：同账号另一台 Mac 待命时显示「由谁承载」。
  machineLabel = "Mac",
} = {}) {
  let current = null; // { child, pid, startedAt, config, forwardFailed }
  let tunnelRetryCount = 0;
  let tunnelNextRetryTime = 0;
  // A2：连续"ssh 通但端口关"的次数（探测超时不计入），达到 deathThreshold 才判隧道死。
  let tunnelDeathCount = 0;
  let lastSpawnAt = 0;
  // 新增：睡眠/唤醒自愈——记录上一次 ensure() 的挂钟时间，用于检测跳变。
  let lastEnsureAt = null;
  // 认领来的 ssh 的 pid。它不是本进程的子进程（没有 child 对象、拿不到 exit 事件），
  // 之后完全靠注册表校验来判活——ensure() 的 verifyProcess 分支会把它当健康隧道。
  let adoptedPid = null;
  let adoptedCommand = null; // 认领时的命令行原文：停它之前用来复核 pid 没被复用
  let configIdentityState = "unverified";
  let configApplied = false;
  let identityWarning = null;
  // 最近一次 ssh stderr 的失败归因（auth/hostkey/timeout/...）。失败快照随它上报，
  // 前端据此给出"为什么断 + 下一步"，而不是一律建议一键修复；隧道恢复即清空。
  let lastSshFailure = null;
  // handover 在下面创建（它要用 remoteOpts）；emitStage 只在之后的异步路径里调用。
  let handover = null;
  const emitStage = (event) => {
    if (event && event.ok === true) lastSshFailure = null;
    else if (event && event.ok === false && lastSshFailure && !event.sshFailure) event = { ...event, sshFailure: lastSshFailure };
    // 待命状态（同账号另一台 Mac 在承载）随每一拍上报：bridge-stage 粘住它，ok 即清除。
    if (event && handover) event = { ...event, standby: event.ok === true ? null : handover.getStandby() };
    return emitStageRaw(event);
  };
  // 正在进行中的孤儿判定（远端复核 + 本机进程扫描都是异步的）。ensure() 会先等它落地，
  // 否则同一拍里可能一边在认领、一边又 spawn 一条注定同样失败的 ssh。
  let pendingOrphanTask = null;
  // 远端不支持挂等待进程（见 HOLD_COMMAND_FAST_EXIT_MS）后置位，此后本控制器回落 -N。
  let holdCommandUnsupported = false;
  // 最近一次 ensure / 受控重启的目标配置：网络切换时按它的 serverId 清限频桶。
  let lastConfig = null;
  // 远端短命令（端口探测 / 残留会话回收）共用的连接参数。
  const remoteOpts = { execFileImpl, timeoutMs: probeTimeoutMs, cwd: controllerRootDir, credentialVault, runtimeDir, askpassDir };
  handover = createSiblingHandover({
    runRemote: (config, command, { timeoutMs }) => runRemoteCommandImpl(config, command, { ...remoteOpts, timeoutMs }),
    log: logImpl,
    now,
    onEvent: (event) => emitSession(event),
    rateLimiter,
    machineLabel,
    name,
  });

  // ---- 会话账本（断线记录）----
  // session：当前已建立的会话 { pid, upAt }；没有已建立会话时为 null。
  // downSince：上一条会话异常结束的时刻（计划内停止不记，首次建立前为 null）。
  let session = null;
  let downSince = null;
  let attemptsSinceDown = 0;
  let lastNetworkChangeAt = null;
  // 最近一次挂钟跳变（电脑休眠）的起止：{ from: 睡前最后一次 ensure, to: 醒来后发现跳变的那次 ensure }。
  let lastSleepGap = null;
  // 已建立会话异常断开后置位：下次重建前先回收服务器上的残留会话，省掉"连上 → 端口被占 →
  // 回收 → 再连"这一轮（服务器端 sshd 通常察觉不到客户端已死，残留会话仍占着反向端口）。
  let pendingReclaim = false;
  let unreachableLogged = false;

  function emitSession(event) {
    try {
      onSessionEvent(event);
    } catch {}
  }

  // 会话建立：清零退避（B1——只有真正建立才清零），上报 up（带本次断线时长与尝试次数）。
  function markEstablished(config, { pid, via, startedAt = null }) {
    resetBackoff();
    pendingReclaim = false;
    handover.leave();
    unreachableLogged = false;
    if (current && current.pid === pid) current.established = true;
    if (session && session.pid === pid) return;
    const at = now();
    const upAt = Number.isFinite(startedAt) ? startedAt : at;
    emitSession({
      type: "up",
      serverId: config?.id ?? null,
      host: config?.host ?? null,
      at,
      pid: pid ?? null,
      via,
      downMs: downSince != null ? Math.max(0, upAt - downSince) : null,
      attempts: attemptsSinceDown,
    });
    session = { pid: pid ?? null, upAt };
    downSince = null;
    attemptsSinceDown = 0;
  }

  // 这次断线是不是电脑休眠造成的（只用于账本的 sleep 标记）。两种情形：
  //   - 跳变期间：挂钟已经跳过去了，本控制器的 ensure 还没轮到——醒来后子进程的 exit 事件、换网复核，
  //     或睡前卡在半路、醒来才接着跑完的那次 ensure 先走到这里；
  //   - 醒来后 SLEEP_ATTRIBUTION_MS 内（取绝对值：醒来后系统对时把挂钟往回拨一点也照样算）。
  function sleepAttributed(at) {
    if (lastEnsureAt != null && at - lastEnsureAt > WAKE_GAP_MS) return true;
    return lastSleepGap != null && Math.abs(at - lastSleepGap.to) <= SLEEP_ATTRIBUTION_MS;
  }

  // 会话结束：planned（受控重启 / 停止）不计断线；异常结束记下原因并准备先回收残留会话。
  function markDown(config, { cause, detail = "", code = null, signal = null, planned = false }) {
    if (!session) return;
    const at = now();
    const networkChange = lastNetworkChangeAt != null && at - lastNetworkChangeAt <= NETWORK_CHANGE_ATTRIBUTION_MS;
    emitSession({
      type: "down",
      serverId: config?.id ?? null,
      host: config?.host ?? null,
      at,
      pid: session.pid,
      uptimeMs: Math.max(0, at - session.upAt),
      cause,
      detail: String(detail || "").slice(0, 200),
      code,
      signal,
      planned,
      networkChange,
      // 计划内的停止本来就不算断线，不做休眠归因。
      sleep: !planned && sleepAttributed(at),
    });
    session = null;
    downSince = planned ? null : at;
    attemptsSinceDown = 0;
    if (!planned && withSessionMarker(config || {}).reclaimMarker) pendingReclaim = true;
  }

  // 给本次 spawn 的配置挂上会话标记。标记不进 buildTunnelIdentity：升级后已有的 -N 隧道
  // 不会因此被判"配置变化"而重建，等它下次自然重连时换成带标记的形态。
  function withSessionMarker(config) {
    if (!tunnelOwnerId || platform === "win32" || holdCommandUnsupported) return config;
    try {
      return { ...config, reclaimMarker: buildTunnelMarker(tunnelOwnerId, config.remotePort) };
    } catch {
      return config;
    }
  }

  // T04b：ensure（正常保活）与 restartControlled（信箱触发的受控重启）共用一把
  // 互斥锁——否则一边 stop 一边被正常循环重复 spawn。串行队列而非布尔旗标：
  // 重启中的 ensure 顺延执行而不是被丢掉（下一拍保活照常收敛）。
  const serializeMutation = createMutationQueue();

  function getCurrentChild() {
    return current ? current.child : null;
  }

  function getState() {
    return {
      name,
      tunnelRetryCount,
      tunnelNextRetryTime,
      tunnelDeathCount,
      lastSpawnAt,
      lastEnsureAt,
      adoptedPid,
      hasCurrent: Boolean(current),
      currentPid: current ? current.pid : null,
      configIdentityState,
      configApplied,
      lastSshFailure,
      sessionUp: Boolean(session),
      sessionUpAt: session ? session.upAt : null,
      downSince,
      pendingReclaim,
      lastWakeAt: lastSleepGap ? lastSleepGap.to : null,
      standby: handover.getStandby(),
    };
  }

  // 测试与调用方等待孤儿判定落地用；没有进行中的判定时返回已决议的 Promise。
  function whenOrphanSettled() {
    return pendingOrphanTask ?? Promise.resolve(null);
  }

  function resetBackoff() {
    tunnelRetryCount = 0;
    tunnelNextRetryTime = 0;
    tunnelDeathCount = 0;
  }

  function attachHandlers(record) {
    record.child.on("error", (err) => {
      void record.passwordSession?.dispose();
      logImpl(`ssh tunnel spawn error: ${err.message}`, { level: "error", event: "tunnel-spawn-error" });
      if (current === record) {
        current = null;
        removeRuntimeRecordImpl(name);
      }
    });
    record.child.on("exit", (code, signal) => {
      void record.passwordSession?.dispose();
      const duration = now() - record.startedAt;
      const wasKilled = signal === "SIGTERM" || signal === "SIGKILL";
      logImpl(`ssh tunnel to ${record.config?.host ?? "?"} exited code=${code ?? "-"} signal=${signal ?? "-"} after ${Math.round(duration / 1000)}s`, {
        level: code && code !== 0 ? "error" : "info",
        event: "tunnel-exit",
        serverId: record.config?.id ?? null,
        host: record.config?.host ?? null,
        uptimeMs: duration,
        established: Boolean(record.established),
        ...(record.stopReason ? { stopReason: record.stopReason } : {}),
        ...(record.lastStderr ? { stderr: record.lastStderr } : {}),
      });
      // 已建立会话结束 → 账本记一笔 down。supervisor 自己停的看 stopReason；没有 stopReason
      // 的停止来自退出清理（runShutdown 直接对子进程 child.kill），也算计划内。
      // ssh 收到 SIGTERM 会自己收尾、以 255 退出（signal 为 null），只看 signal 会把停止通道 /
      // 重启通道（手动或自动修复）记成原因 unknown 的异常断线（2026-10 账本 33 次 unknown 里 13 次
      // 正落在 supervisor 重启那一秒）。child.killed 是 Node 在本进程经 child.kill() 成功发出信号时
      // 置的位——"是我们停的"。只用于账本口径，不改下面退避 / 死计数 / 回落的判据。
      const stoppedByUs = wasKilled || record.child?.killed === true;
      if (record.established && session && session.pid === record.pid) {
        // 读到让位通知 = 另一台 Mac 接管了端口：计划内交接，不算断线。
        if (record.yielded && !record.stopReason) record.stopReason = "handover";
        const planned = record.stopReason ? PLANNED_STOP_REASONS.has(record.stopReason) : stoppedByUs;
        const cause = record.stopReason || (stoppedByUs ? "stopped" : classifyTunnelDrop(record.lastStderr));
        markDown(record.config, { cause, detail: record.lastStderr || "", code: code ?? null, signal: signal ?? null, planned });
      }
      // 归因按"每次尝试"算：当前 child 退出时，本次 stderr 没归类出原因就清空，
      // 不让上一次的归因（如 auth）粘到这次无法归类的断线上。
      if (current === record && !wasKilled) lastSshFailure = record.sshFailure || null;
      // 带标记的隧道很快以非 255 退出 = 远端没让等待进程跑起来（强制命令 / 没有 sh）。
      // 回落 -N：隧道照常工作，只是这台服务器不再支持残留会话回收。
      if (record.config?.reclaimMarker && !record.yielded && !wasKilled && code !== null && code !== 255 && duration < HOLD_COMMAND_FAST_EXIT_MS && !holdCommandUnsupported) {
        holdCommandUnsupported = true;
        logImpl(`remote hold command exited early (code ${code}); falling back to ssh -N for ${record.config.host} (stale-session reclaim unavailable on this server)`, {
          level: "warn",
          event: "tunnel-hold-unsupported",
          code,
        });
      }
      if (code !== 0 && code !== null && !wasKilled && duration < 15000) {
        tunnelRetryCount += 1;
        const backoffSec = Math.min(computeBackoffSec(tunnelRetryCount), TUNNEL_MAX_BACKOFF_S);
        tunnelNextRetryTime = now() + backoffSec * 1000;
        emitStage({ ok: false, durationMs: duration, fastFailureDelta: 1, backoffUntil: tunnelNextRetryTime, sshFailure: lastSshFailure });
        logImpl(`ssh tunnel failed quickly, next retry in ${backoffSec}s (retry count: ${tunnelRetryCount})`, {
          level: "warn",
          event: "tunnel-retry",
          retryCount: tunnelRetryCount,
          backoffSec,
          serverId: record.config?.id ?? null,
        });
        if (tunnelRetryCount >= UNREACHABLE_LOG_AFTER && !unreachableLogged) {
          unreachableLogged = true;
          logImpl(`${record.config?.host ?? "server"} unreachable from the current network after ${tunnelRetryCount} attempts; retrying with backoff up to ${TUNNEL_MAX_BACKOFF_S}s, immediately on network change`, {
            level: "warn",
            event: "tunnel-unreachable",
            serverId: record.config?.id ?? null,
            sshFailure: lastSshFailure?.code ?? null,
            nextAction: lastSshFailure?.nextAction || "检查当前网络能否连到服务器；换网后会立即重连",
          });
        }
      }
      // A2 修复：退避只在 ensure() 确认隧道真正健康（remote.ok 且本地受管进程校验通过）
      // 时才清零——supervisor 主动 SIGTERM（自杀式重建/shutdown）绝不清零，
      // 否则连续快速失败积累的退避会被每一次自杀式重建自己清空，形同虚设。
      // A1 修复：身份守卫——只有仍是"当前 child"才清空指针/删注册表记录，
      // 避免旧 child 迟到的 exit 事件误删刚 spawn 的新 child 的状态（孤儿化根因之一）。
      const wasCurrent = current === record;
      // 被接力：进入待命，过一会儿看接管方是否接上（没接上就自己连回去），期间不重连、不抢端口。
      if (record.yielded && wasCurrent) {
        resetBackoff();
        tunnelNextRetryTime = now() + handover.noteYielded(record.config);
        emitStage({ ok: false, durationMs: 0, backoffUntil: tunnelNextRetryTime });
      }
      if (wasCurrent) {
        current = null;
        // 句柄留给下面的孤儿认领：认领要写的正是同一条注册表记录，
        // 不等这个 unlink 落地就写，理论上会被迟到的删除反手抹掉（静默失去认领）。
        record.cleanup = Promise.allSettled([removeRuntimeRecordImpl(name)]);
      }
      // L2 孤儿接管：ssh 带 ExitOnForwardFailure=yes，远端端口被占时它会立刻退出，
      // 退出码（255）与"连不上主机"一模一样——只有上面 stderr 记下的那一行能区分。
      // 这条路径上退避已经在前面建立好了；判定结果只会**收紧或放松**它，不会绕过它。
      // 迟到的旧 child（wasCurrent 为假）不参与：它的失败早已被新 child 取代。
      if (record.forwardFailed && !wasKilled && wasCurrent) {
        pendingOrphanTask = handleForwardFailure(record)
          .catch((err) => {
            logImpl(`orphan tunnel adoption failed: ${err.message}`, { level: "warn", event: "tunnel-orphan-error" });
            return null;
          })
          .finally(() => {
            pendingOrphanTask = null;
          });
      }
    });
  }

  // 远端端口被占时的处置：认领 / 回收本机残留会话 / 判异己长退避 / 交回既有退避重试。
  // 绝不杀本机进程，也绝不碰别人的会话（设计 §8）；唯一的远端动作是结束带本机标记、
  // 且本机已没有对应 ssh 的残留会话（见 maybeReclaimStaleSession）。
  async function handleForwardFailure(record) {
    const config = record.config || {};
    const serverId = config.id ?? config.serverId ?? null;

    // 规则开关（团队 config.json / 个人 config.local.json 的 autoRepair）。
    // 关掉时逐字回到本次改动前的行为：只退避、不扫描、不记日志。
    const autoRepair = normalizeAutoRepairConfig(getAutoRepair());
    if (!isRuleEnabled(autoRepair, ORPHAN_RULE_ID)) return { verdict: "disabled" };

    const limitKey = `orphan:${serverId ?? name}`;
    const allowed = rateLimiter.allow(limitKey, {
      cooldownMs: ORPHAN_ADOPT_COOLDOWN_MS,
      maxPerWindow: 1,
      windowMs: ORPHAN_ADOPT_WINDOW_MS,
    });
    if (!allowed.ok) {
      logImpl(`remote port ${config.remotePort} forwarding failed again, but orphan adoption is rate limited (${allowed.reason}); keeping the existing backoff`, {
        level: "warn",
        event: "tunnel-orphan-ratelimited",
        serverId,
        reason: allowed.reason,
      });
      return { verdict: "ratelimited" };
    }

    const signature = buildTunnelSignature(config);
    // 远端复核只用来分辨"端口被别人占着"与"端口其实是空的"，失败一律按"没在监听"，
    // 宁可少判一次 foreign（回到普通重试）也不要凭一次探测超时就宣布端口被占。
    let remoteListening = false;
    try {
      const remote = await remotePortOpen(config, remoteOpts);
      remoteListening = remote.ok;
    } catch {
      remoteListening = false;
    }
    let localSshProcesses = [];
    try {
      localSshProcesses = await listSshProcesses();
    } catch {
      localSshProcesses = [];
    }

    const decision = classifyForwardFailure({
      stderr: record.forwardFailedText || "remote port forwarding failed",
      remoteListening,
      localSshProcesses,
      signature,
      ownerId: tunnelOwnerId,
      supervisorPid: selfPid,
      platform,
    });

    if (decision.verdict === "adopt") {
      // 观察模式：把"会认领谁"完整写进日志，但一个字节都不落盘。记账照记
      // （与 auto-repair-policy 同策略），否则观察一天得到的节奏与真执行时对不上。
      if (autoRepair.observeOnly) {
        rateLimiter.record(limitKey);
        logImpl(`would adopt orphan reverse tunnel pid=${decision.pid} for ${serverId} (${decision.reason}), observe mode only`, {
          level: "warn",
          event: "tunnel-orphan-adopt",
          mode: "observe",
          pid: decision.pid,
          serverId,
        });
        return { verdict: "adopt", mode: "observe", pid: decision.pid };
      }

      // exit 处理器的 unlink 必须先落地，再写认领记录（顺序反了就等于没认领）。
      if (record.cleanup) await record.cleanup;
      adoptedPid = decision.pid;
      adoptedCommand = decision.command || null;
      // meta 形状与 spawnTunnel 登记时一致（signature 是关键：cmdlineMatches 优先用它，
      // 没有它 verifyProcess 会退回宽松匹配）。parentPid 不填——孤儿的父进程是 launchd，
      // 编一个假的比缺一个更糟。adopted 标记留给未来的注册表读侧，当前会被 recordProcess 丢弃。
      recordRuntimeProcessImpl(name, decision.pid, {
        command: decision.command,
        args: [],
        cwd: controllerRootDir,
        signature,
        adopted: true,
      });
      // Command-line matching proves the forwarding tuple, not the password/key
      // or pinned host key with which this older SSH connection authenticated.
      configIdentityState = "unverified";
      configApplied = false;
      // 认领成功 = 隧道其实一直是健康的（数据面从没断过），退避与死计数全部清零。
      markEstablished(config, { pid: decision.pid, via: "adopted" });
      emitStage({ ok: true, durationMs: 0, adopted: true, backoffUntil: 0, configIdentityState, configApplied });
      logImpl(`adopted orphan reverse tunnel pid=${decision.pid} for ${serverId}: ${decision.reason}`, {
        event: "tunnel-orphan-adopted",
        pid: decision.pid,
        serverId,
        mode: "execute",
      });
      rateLimiter.record(limitKey);
      return { verdict: "adopt", mode: "execute", pid: decision.pid };
    }

    if (decision.verdict === "foreign") {
      // 先看占着端口的是不是本机自己的残留会话（换网后服务器端没察觉的旧隧道）：是就结束它、
      // 马上重建；不是（没有本机标记 / 远端查不到）才按异己占用长退避。
      const reclaim = await maybeReclaimStaleSession(record, { autoRepair, serverId, localSshProcesses });
      if (reclaim.verdict === "reclaimed") return reclaim;
      // 查过、不是本机的残留会话（或回收规则关着 / 观察模式）：看看是不是同账号另一台 Mac 在承载（是就待命，
      // 不按异己占用退避 5 分钟；查看是只读的，观察模式照样做，只是不自动接管）。回收没查成 / 冷却中 /
      // 本机会话还活着时不多发这一趟 SSH——交给下面原有的复查与退避。
      if (reclaim.verdict === "none" || reclaim.verdict === "disabled" || reclaim.verdict === "observe") {
        const holder = await resolveSiblingHolder(config, autoRepair);
        if (holder) return holder;
      }
      // 没查成 ≠ 查过不是自己的：不记孤儿判定的限频（否则 5 分钟内不会再走到这里），等冷却一过再判一次。
      // 回收自己的预算（10 分钟 4 次）照常记账，耗尽后落回下面的长退避，不会无限空打。
      if (reclaim.verdict === "error" || (reclaim.verdict === "ratelimited" && reclaim.reason === "cooldown")) {
        tunnelNextRetryTime = now() + RECLAIM_RECHECK_MS;
        logImpl(`remote port ${config.remotePort} on ${config.host} is held, but the stale-session check was inconclusive (${reclaim.reason || reclaim.verdict}); rechecking in ${RECLAIM_RECHECK_MS / 1000}s`, {
          level: "warn",
          event: "tunnel-port-held-recheck",
          serverId,
          reason: reclaim.reason || reclaim.verdict,
        });
        emitStage({ ok: false, durationMs: 0, backoffUntil: tunnelNextRetryTime });
        return { verdict: "recheck" };
      }
      tunnelNextRetryTime = now() + TUNNEL_FOREIGN_BACKOFF_MS;
      rateLimiter.record(limitKey);
      logImpl(`remote port ${config.remotePort} on ${config.host} is held by a process we do not manage (${decision.reason}); backing off ${TUNNEL_FOREIGN_BACKOFF_MS / 1000}s without killing anything`, {
        level: "warn",
        event: "tunnel-port-foreign",
        serverId,
        nextAction: "换端口或联系占用者",
      });
      emitStage({ ok: false, durationMs: 0, foreign: true, backoffUntil: tunnelNextRetryTime });
      return { verdict: "foreign" };
    }

    // retry：没有任何可执行的修复动作，不消耗限频预算，交回 exit 处理器已建立的退避。
    return { verdict: "retry", reason: decision.reason };
  }

  // 结束本账号在服务器上的残留隧道会话（只认带本机标记、且本机已没有对应 ssh 的会话）。
  // 返回 { verdict: "reclaimed" | "none" | "no-marker" | "disabled" | "ratelimited" | "local-alive" | "observe" | "error" }。
  async function maybeReclaimStaleSession(record, { autoRepair, serverId, localSshProcesses = [] }) {
    const config = record.config || {};
    const marker = config.reclaimMarker;
    if (!marker) return { verdict: "no-marker" };
    if (!isRuleEnabled(autoRepair, STALE_SESSION_RECLAIM_RULE_ID)) return { verdict: "disabled" };
    // 本机还有一条挂着同一标记的 ssh：会话是活的（只是没被认出来），绝不去结束它。
    if (localSshProcesses.some((proc) => typeof proc?.command === "string" && proc.command.includes(marker))) {
      return { verdict: "local-alive" };
    }
    const limitKey = `reclaim:${serverId ?? name}`;
    const allowed = rateLimiter.allow(limitKey, { cooldownMs: RECLAIM_COOLDOWN_MS, maxPerWindow: RECLAIM_MAX_PER_WINDOW, windowMs: RECLAIM_WINDOW_MS });
    if (!allowed.ok) return { verdict: "ratelimited", reason: allowed.reason };
    if (autoRepair.observeOnly) {
      rateLimiter.record(limitKey);
      logImpl(`would reclaim stale tunnel session for ${serverId} on ${config.host}:${config.remotePort}, observe mode only`, {
        level: "warn", event: "tunnel-stale-session-reclaim", mode: "observe", serverId,
      });
      return { verdict: "observe" };
    }
    let result;
    try {
      result = await runRemoteCommandImpl(config, buildStaleSessionReclaimCommand(marker), { ...remoteOpts, timeoutMs: RECLAIM_TIMEOUT_MS });
    } catch (error) {
      return { verdict: "error", reason: error.message };
    }
    rateLimiter.record(limitKey);
    const parsed = result && result.code === 0 && !result.timedOut ? parseStaleSessionReclaimOutput(result.stdout) : null;
    if (!parsed) {
      const reason = `ssh code ${result?.code ?? "?"}${result?.timedOut ? ", timed out" : ""}`;
      logImpl(`stale tunnel session check on ${config.host} failed (${reason.replace(/^ssh /, "")})`, {
        level: "warn", event: "tunnel-stale-session-reclaim", serverId, result: "error",
      });
      return { verdict: "error", reason };
    }
    if (parsed.reclaimed === 0) {
      if (parsed.found > 0) {
        logImpl(`found ${parsed.found} marked tunnel session(s) on ${config.host} but could not end them`, {
          level: "warn", event: "tunnel-stale-session-reclaim", serverId, result: "not-killed",
        });
      }
      return { verdict: "none", found: parsed.found };
    }
    // 端口随残留会话一起释放：清零退避，稍等片刻就重建（不走异己占用的 5 分钟长退避）。
    resetBackoff();
    tunnelNextRetryTime = now() + RECLAIM_SETTLE_MS;
    emitStage({ ok: false, durationMs: 0, reclaimed: parsed.reclaimed, backoffUntil: tunnelNextRetryTime });
    logImpl(`ended ${parsed.reclaimed} stale tunnel session(s) of this Mac on ${config.host} holding remote port ${config.remotePort}; reconnecting`, {
      event: "tunnel-stale-session-reclaimed",
      serverId,
      found: parsed.found,
      reclaimed: parsed.reclaimed,
    });
    return { verdict: "reclaimed", count: parsed.reclaimed };
  }

  // 端口有人在听、本机没有自己的隧道：问 handover 是不是同账号另一台 Mac。
  // 待命 → 落退避并上报、返回判定；对方已被接管 → 清退避、返回判定（调用方立刻建隧道）；其它 → null，交回原有流程。
  async function resolveSiblingHolder(config, autoRepair = normalizeAutoRepairConfig(getAutoRepair())) {
    const marker = withSessionMarker(config).reclaimMarker;
    if (!marker) return null;
    const result = await handover.resolve(config, marker, { autoRepair });
    if (result.verdict === "standby") {
      tunnelNextRetryTime = now() + result.recheckMs;
      emitStage({ ok: false, durationMs: 0, backoffUntil: tunnelNextRetryTime });
      return { verdict: "standby", holder: result.holder ?? null };
    }
    if (result.verdict === "took-over") {
      resetBackoff();
      return { verdict: "took-over", holder: result.holder ?? null };
    }
    return null;
  }

  async function spawnTunnel(rawConfig) {
    const config = withSessionMarker(rawConfig);
    const baseArgs = buildTunnelArgs(config);
    const passwordSession = config.authRef
      ? await createPasswordSshSessionImpl({ password: await readTunnelPassword(config.authRef, credentialVault, runtimeDir), helperDir: askpassDir, allowWindows: true }) : null;
    const tunnelArgs = passwordSession ? [...passwordSession.args, ...baseArgs] : baseArgs;
    let child;
    ensureWindowsOpenSshOnPath("ssh");
    if (passwordSession?.env) ensureWindowsOpenSshOnPath("ssh", { env: passwordSession.env });
    try {
      child = spawnImpl("ssh", tunnelArgs, { cwd: controllerRootDir, stdio: ["ignore", "pipe", "pipe"], ...(passwordSession ? { env: passwordSession.env } : {}) });
    } catch (error) {
      await passwordSession?.dispose();
      throw error;
    }
    // config 随 record 走（不是控制器闭包）：exit 处理器要用它算签名，而那时
    // ensure() 早已返回，闭包里的"当前配置"可能已经是下一拍的另一份了。
    const record = { child, pid: child.pid, startedAt: now(), config, passwordSession, forwardFailed: false, forwardFailedText: "" };
    current = record;
    configIdentityState = "verified";
    configApplied = true;
    identityWarning = null;
    lastSpawnAt = record.startedAt;
    // 自己建了一条新隧道，之前认领的那条（若有）已不再是本控制器的代表。
    adoptedPid = null;
    adoptedCommand = null;
    attachHandlers(record);
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        const text = String(chunk).trim();
        // 远端等待进程的让位通知（另一台 Mac 接管了端口），见 tunnel-spec 的 buildTunnelHoldCommand。
        if (text.split(/\r?\n/).some((line) => line.trim() === SIBLING_YIELD_TOKEN)) {
          record.yielded = true;
          return;
        }
        logImpl(`[ssh] ${text}`);
      });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (isSshStderrNoise(text)) return;
        // 最后一行有效 stderr：断线归因（classifyTunnelDrop）与账本 detail 用。
        record.lastStderr = text.split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 200) || record.lastStderr;
        // 记在 record 上而不是控制器闭包上：迟到的旧 child 的 stderr 绝不能污染
        // 新 child 的判定。这一行是"远端端口被占"与"连不上主机"的唯一区分依据。
        if (FORWARD_FAILED_RE.test(text)) {
          record.forwardFailed = true;
          record.forwardFailedText = text;
        }
        const failure = classifyTunnelSshFailure(text);
        if (failure) {
          record.sshFailure = { code: failure.code, nextAction: failure.nextAction, at: now() };
          if (current === record || !current) lastSshFailure = record.sshFailure;
          logImpl(`ssh ${failure.code}: ${text}`, { level: "error", reason: failure.code, nextAction: failure.nextAction, event: "ssh-fail" });
          return;
        }
        logImpl(`[ssh:err] ${text}`, { level: "warn" });
      });
    }
    if (record.pid) {
      recordRuntimeProcessImpl(name, record.pid, {
        command: `ssh ${tunnelArgs.join(" ")}`,
        args: tunnelArgs,
        cwd: controllerRootDir,
        parentPid: process.pid,
        signature: buildTunnelSignature(config),
        configIdentity: buildTunnelIdentity(config),
      });
    }
    return record;
  }

  async function killCurrentAndWait(reason = "stopped") {
    if (!current) return;
    if (!current.stopReason) current.stopReason = reason;
    await current.passwordSession?.dispose();
    const pid = current.pid;
    if (current.child && !current.child.killed) current.child.kill("SIGTERM");
    // 必须确认真正退出（含 SIGKILL 升级）再返回：调用方紧接着就 spawn 新隧道抢同一个
    // 远端端口，旧 ssh 若扛住 SIGTERM 就会让新隧道报 remote port forwarding failed。
    if (pid) await ensurePidExited(pid, RESPAWN_WAIT_BUDGET_MS, { killImpl: killProcess, waitImpl: waitForPidExitImpl });
  }

  // 认领来的隧道没有 child 对象，得按 pid 发信号。杀之前必须复核这个 pid 的命令行
  // 仍是认领时那一条（pid 复用会让同一个数字指向别的进程），复核不过就只放掉认领状态。
  // 不这么做的后果（Task 3 交付时留下的坑）：服务器从配置删除 → reconcile 删掉
  // 注册表记录，但 ssh 还活着 → 它又变回孤儿，下次同端口重建时再次 remote port forwarding failed。
  async function stopAdopted(reason = "stopped") {
    if (!adoptedPid) return;
    const pid = adoptedPid;
    const expected = adoptedCommand;
    adoptedPid = null;
    adoptedCommand = null;
    // 认领来的会话没有 exit 事件可等：停它即在账本里结束这条会话。
    if (session && session.pid === pid) {
      markDown(lastConfig, { cause: reason, planned: PLANNED_STOP_REASONS.has(reason) });
    }
    try {
      const procs = await listSshProcesses();
      const alive = procs.find((p) => Number(p.pid) === Number(pid));
      if (!alive) return;
      if (expected && alive.command !== expected) {
        logImpl(`adopted tunnel pid=${pid} now runs a different command line; refusing to kill (pid reuse guard)`, {
          level: "warn",
          event: "tunnel-adopted-skip-kill",
          pid,
        });
        return;
      }
      killProcess(pid, "SIGTERM");
      await ensurePidExited(pid, RESPAWN_WAIT_BUDGET_MS, { killImpl: killProcess, waitImpl: waitForPidExitImpl });
      logImpl(`stopped adopted reverse tunnel pid=${pid}`, { event: "tunnel-adopted-stopped", pid });
    } catch (error) {
      logImpl(`failed to stop adopted reverse tunnel pid=${pid}: ${error.message}`, {
        level: "warn",
        event: "tunnel-adopted-stop-error",
        pid,
      });
    }
  }

  async function stopCurrent() {
    await killCurrentAndWait("stopped");
    await stopAdopted("stopped");
  }

  async function ensure(config, { stopping: isStopping = () => false } = {}) {
    // T04b：与受控重启共用互斥（见 serializeMutation）。
    return serializeMutation(() => ensureImpl(config, { stopping: isStopping }));
  }

  async function ensureImpl(config, { stopping: isStopping = () => false } = {}) {
    lastConfig = config;
    if (isStopping()) return { skipped: true };
    // 先等孤儿判定落地：否则本拍可能一边在认领、一边又 spawn 一条注定同样被顶回来的 ssh。
    if (pendingOrphanTask) await pendingOrphanTask;
    if (isStopping()) return { skipped: true };
    const nowMs = now();

    // 睡眠/唤醒自愈：相邻两次 ensure() 的挂钟间隔远超过正常 tick 间隔（默认 90s），
    // 判定为 Mac 睡眠后唤醒（而非单纯的退避等待）——网络/ssh 连接在睡眠期间大概率
    // 已经失效，旧的死计数/退避数据也已过时。立即强制本次复检，不等常规轮询间隔，
    // 直击"长程工作"场景下唤醒后迟迟不重连的问题。
    if (lastEnsureAt != null && nowMs - lastEnsureAt > WAKE_GAP_MS) {
      logImpl(`detected sleep/wake gap of ${nowMs - lastEnsureAt}ms (last ensure at ${lastEnsureAt}), forcing immediate tunnel recheck`);
      resetBackoff();
      // 休眠归因：记下这次跳变的起止，账本留一行 wake（读侧据此知道电脑睡了多久）。纯记账，不影响上面的自愈。
      // 这一行不带 serverId：休眠是整台电脑的事；旧版读侧按服务器筛事件，也就根本看不到它。
      lastSleepGap = { from: lastEnsureAt, to: nowMs };
      emitSession({ type: "wake", at: nowMs, sleptMs: nowMs - lastEnsureAt });
    }
    lastEnsureAt = nowMs;

    if (nowMs < tunnelNextRetryTime) {
      emitStage({ ok: false, durationMs: 0, backoffUntil: tunnelNextRetryTime });
      return { skipped: true, reason: "backoff" };
    }

    if (!(await isLocalProxyHealthy(config))) {
      return { skipped: true, reason: "local-proxy-unhealthy" };
    }

    // 本地隧道进程已通过注册表校验时，不必每 5 秒再开一条探测 SSH；
    // 远端端口交给 15s 的 primary-remote 探针。反向隧道本身不加 ControlMaster。
    if (registryImpl) {
      const localTunnel = await registryImpl.verifyProcess(name);
      if (localTunnel?.verified) {
        const meta = localTunnel.meta;
        const desiredIdentity = buildTunnelIdentity(config);
        const actualIdentity = current && current.pid === meta?.pid
          ? buildTunnelIdentity(current.config) : meta?.configIdentity;
        if (actualIdentity && actualIdentity !== desiredIdentity) {
          configIdentityState = "changed";
          configApplied = false;
          // Only a scoped record owned by this checkout can be automatically
          // replaced. The registry rechecks PID + identity immediately before kill.
          const owned = meta?.name === name && Number.isInteger(meta?.pid)
            && (meta.rootDir || meta.cwd) === controllerRootDir;
          if (!owned || typeof registryImpl.stopProcess !== "function") {
            configIdentityState = "blocked";
            emitStage({ ok: true, durationMs: 0, configIdentityState, configApplied });
            return { ok: true, configApplied: false, reason: "config-identity-owner-unverified", skippedRemoteProbe: true };
          }
          // Validate the new authentication prerequisites while preserving the old link.
          try { buildTunnelArgs(config); if (config.authRef) await readTunnelPassword(config.authRef, credentialVault, runtimeDir); }
          catch {
            configIdentityState = "blocked";
            emitStage({ ok: true, durationMs: 0, configIdentityState, configApplied });
            return { ok: true, configApplied: false, reason: "config-auth-unavailable", skippedRemoteProbe: true };
          }
          const replacedRecord = current;
          if (replacedRecord && !replacedRecord.stopReason) replacedRecord.stopReason = "config-change";
          const stopped = await registryImpl.stopProcess(name, { forceAfterMs: RESPAWN_WAIT_BUDGET_MS,
            expectedPid: meta.pid, expectedConfigIdentity: meta.configIdentity });
          if (!stopped?.stopped) {
            configIdentityState = "blocked";
            emitStage({ ok: true, durationMs: 0, configIdentityState, configApplied });
            return { ok: true, configApplied: false, reason: "config-identity-stop-refused", skippedRemoteProbe: true };
          }
          current = null;
          if (replacedRecord?.cleanup) await replacedRecord.cleanup;
          await replacedRecord?.passwordSession?.dispose();
          // 认领来的旧会话没有 exit 事件：在这里结束账本里的会话（子进程的由 exit 处理器记）。
          if (session && session.pid === meta.pid && replacedRecord?.pid !== meta.pid) {
            markDown(config, { cause: "config-change", planned: true });
          }
          adoptedPid = null;
          adoptedCommand = null;
          if (isStopping()) return { skipped: true };
          resetBackoff();
          attemptsSinceDown += 1;
          await spawnTunnel(config);
          emitStage({ ok: false, durationMs: 0, reconnectDelta: 1, configIdentityState, configApplied });
          return { ok: false, respawned: true, reason: "config-identity-changed", configApplied: true };
        }
        configIdentityState = actualIdentity === desiredIdentity ? "verified" : "unverified";
        configApplied = configIdentityState === "verified";
        if (!current && meta?.name === name && Number.isInteger(meta.pid)
          && (meta.rootDir || meta.cwd) === controllerRootDir) {
          // A cold controller must also retain the handle needed by later scoped
          // restart/removal, without upgrading unknown authentication identity.
          adoptedPid = meta.pid;
          adoptedCommand = meta.command || null;
        }
        if (!configApplied && identityWarning !== desiredIdentity) {
          identityWarning = desiredIdentity;
          logImpl("existing tunnel retained; its authentication configuration cannot be verified, use a scoped restart to apply the new configuration", {
            level: "warn", event: "tunnel-config-unverified", configApplied: false,
          });
        }
        // B1：自己刚起的 ssh 还在握手（进程活着 ≠ 隧道已建立）时不宣布健康、不清退避——
        // 否则连不上的服务器每次尝试都会把退避清零，永远 5 秒一拍地空打。
        // 认领 / 交接来的进程（不是当前子进程）早已在跑，直接按已建立处理。
        const ownChild = current && current.pid === meta?.pid;
        if (ownChild && !current.established && nowMs - current.startedAt < TUNNEL_ESTABLISHED_MS) {
          return { ok: false, connecting: true, skippedRemoteProbe: true };
        }
        markEstablished(config, {
          pid: meta?.pid ?? null,
          via: ownChild ? "spawned" : "adopted",
          startedAt: ownChild ? current.startedAt : null,
        });
        emitStage({ ok: true, durationMs: 0, backoffUntil: 0, configIdentityState, configApplied });
        return { ok: true, skippedRemoteProbe: true, configIdentityState, configApplied };
      }
    }

    const remote = await remotePortOpen(config, remoteOpts);
    // 待命期间端口开着是另一台 Mac 的隧道，不是本机的：不报 ok（否则快照每 30 秒在 ok / 待命之间来回翻）。
    emitStage({ ok: remote.ok && !handover.isStandby(), durationMs: remote.durationMs, checkDelta: 1 });

    // A6：remote.ok 只证明"某个进程在监听远端转发端口"，不证明那是我们的隧道——
    // pid 复用/端口被异己抢占时 nc -z 照样通。追加"本地存在受管 ssh 隧道进程"这道
    // 与门（经 process-registry 校验），缺失就不能信任 remote.ok，落入下面的死计数/重建路径。
    let healthy = false;
    if (remote.ok) {
      if (registryImpl) {
        const verification = await registryImpl.verifyProcess(name);
        healthy = Boolean(verification?.verified);
        if (!healthy) {
          logImpl(`remote port open but no verified local tunnel process (${(verification?.reason) || "n/a"}); treating tunnel as dead`, {
            level: "warn",
            event: "tunnel-unverified",
            nextAction: "等待下一拍复核；若持续出现，检查是否有异己 ssh 占用了反向端口",
          });
        }
      } else {
        healthy = true;
      }
    }

    if (healthy) {
      // 远端端口开着且本地受管进程校验通过，表明隧道良好：清零死计数与退避。
      const pid = current?.pid ?? adoptedPid ?? null;
      markEstablished(config, { pid, via: current ? "spawned" : "adopted", startedAt: current ? current.startedAt : null });
      emitStage({ ok: true, durationMs: remote.durationMs, backoffUntil: 0 });
      return { ok: true };
    }

    if (current) {
      // A5：探测本身超时（ssh 没跑通，非"端口确认关闭"）不计入死计数、不采取任何动作——
      // 留给下个 tick 重新判断，避免把网络抖动误判成隧道真死。这道判断只保护"已有受管
      // 进程"的场景；冷启动（current 为空）时探测超时不该拦住第一次建立隧道的尝试
      // （否则网络稍一抖动就永远无法建立第一条隧道，隧道自身的 ExitOnForwardFailure/
      // ConnectTimeout + exit 处理器的快速失败退避才是应对持续不可达的正确机制）。
      if (remote.timedOut) {
        return { ok: false, timedOut: true };
      }
      // A2：建立宽限期——刚 spawn 的新进程可能还没握手完，宽限期内探测失败不判死、不杀。
      if (nowMs - lastSpawnAt < spawnGraceMs) {
        return { ok: false, grace: true };
      }
      // A2：连续失败达到阈值才判隧道死，单次抖动不足以触发杀+重建。
      tunnelDeathCount += 1;
      if (tunnelDeathCount < deathThreshold) {
        emitStage({ ok: false, durationMs: remote.durationMs, backoffUntil: tunnelNextRetryTime });
        return { ok: false, deathCount: tunnelDeathCount };
      }
    }

    // 达到重建条件（或本来就没有受管进程，视作冷启动）：杀旧、等真正退出、起新。
    // A1 修复：kill 旧进程后等待其真正退出，再 spawn 新的，缩小竞态窗口。
    await killCurrentAndWait("port-closed");
    // 已建立的会话不是经 exit 事件结束的（认领来的进程消失 / 远端端口连续确认关闭后被杀之前
    // 已无子进程）：在这里结束账本里的会话。
    if (session) markDown(config, { cause: current ? "port-closed" : "process-lost" });

    if (isStopping()) return { skipped: true };
    // 待命中（同账号另一台 Mac 在承载）的复查：端口还开着就先看对方，不去撞端口——否则每次复查都会
    // spawn 一条注定「端口被占」的 ssh，而孤儿判定 5 分钟只放一次，之后只剩快速重试空打。
    // 端口确认空着（不是探测超时）就离开待命，照常建隧道。冷启动撞上对方由端口被占的流程认出（handleForwardFailure）。
    if (remote.ok && handover.isStandby()) {
      const holder = await resolveSiblingHolder(config);
      if (holder?.verdict === "standby") return { ok: false, standby: true };
      if (isStopping()) return { skipped: true };
    } else if (!remote.timedOut) {
      handover.leave();
    }
    // B3：已建立的会话刚异常断开，服务器端多半还留着残留会话占着反向端口——先回收再连，
    // 省掉一次注定被"remote port forwarding failed"顶回来的尝试（及随后的退避）。
    if (pendingReclaim) {
      pendingReclaim = false;
      await reclaimBeforeReconnect(config);
      if (isStopping()) return { skipped: true };
    }
    logImpl(`starting SSH reverse tunnel to ${config.host} (remote:${config.remotePort} -> local:${config.localPort})`, {
      event: "tunnel-start",
      channelId: config.id,
      serverId: config.id,
    });
    emitStage({ ok: false, durationMs: 0, reconnectDelta: 1, backoffUntil: tunnelNextRetryTime });
    tunnelDeathCount = 0;
    attemptsSinceDown += 1;
    await spawnTunnel(config);
    return { ok: false, respawned: true };
  }

  // 断线后的预回收：与端口被占时的回收同一实现（同一限频桶、同一规则开关、同样只结束带本机
  // 标记且本机已无对应 ssh 的会话）。失败或无事可做都不拦重连。
  async function reclaimBeforeReconnect(config) {
    const marked = withSessionMarker(config);
    if (!marked.reclaimMarker) return { verdict: "no-marker" };
    const autoRepair = normalizeAutoRepairConfig(getAutoRepair());
    let localSshProcesses = [];
    try {
      localSshProcesses = await listSshProcesses();
    } catch {
      localSshProcesses = [];
    }
    let result;
    try {
      result = await maybeReclaimStaleSession({ config: marked }, { autoRepair, serverId: config.id ?? null, localSshProcesses });
    } catch {
      return { verdict: "error" };
    }
    if (result.verdict === "reclaimed") {
      // 端口随会话释放需要片刻；本拍内等完再连，不再多等一个 5 秒节拍。
      await sleep(RECLAIM_SETTLE_MS);
      tunnelNextRetryTime = 0;
    }
    return result;
  }

  // T04b 受控重启（仅信箱触发）：只重建本 controller 的隧道，不动 shouldBeRunning、
  // 不停 supervisor/代理、不碰其它 controller。步骤：等孤儿判定落地 → 清退避与死
  // 计数（resetTransientState 语义）→ 停当前（含认领）→ 冷启动重建 → 有界验证
  // （受管 pid + 远端监听）。验证证据不足时如实 unknown（"进程已恢复，端到端连通性
  // 待验证"），绝不宣称 success。
  async function restartControlledImpl(config, { verifyBudgetMs = 20000, verifyIntervalMs = 1500 } = {}) {
    lastConfig = config;
    if (pendingOrphanTask) await pendingOrphanTask.catch(() => {});
    resetBackoff();
    const adoptedBefore = adoptedPid;
    await killCurrentAndWait("restart");
    if (adoptedBefore) await stopAdopted("restart");
    const startedAt = now();
    emitStage({ ok: false, durationMs: 0, reconnectDelta: 1, backoffUntil: 0 });
    const record = await spawnTunnel(config);
    // 有界验证：受管进程存活（注册表校验）+ 远端端口监听。远端探测使用真实 ssh
    //（与 ensure 同一实现）；超时/失败不杀新进程——它有自己的退避与死计数机制。
    const deadline = startedAt + verifyBudgetMs;
    let remoteVerified = false;
    let localVerified = false;
    let lastRemote = { ok: false, timedOut: false };
    while (now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, verifyIntervalMs));
      if (current !== record) {
        // 新进程已退出并被 exit 处理器清场（快速失败）。
        return { status: "failed", phase: "executing", reason: "tunnel process exited during verification", evidence: { pid: record.pid ?? null } };
      }
      if (registryImpl) {
        try {
          const verification = await registryImpl.verifyProcess(name);
          localVerified = Boolean(verification?.verified);
        } catch {}
      } else {
        localVerified = true;
      }
      try {
        lastRemote = await remotePortOpen(config, remoteOpts);
        remoteVerified = lastRemote.ok;
      } catch {}
      if (localVerified && remoteVerified) {
        markEstablished(config, { pid: record.pid ?? null, via: "restart", startedAt: record.startedAt });
        emitStage({ ok: true, durationMs: 0, backoffUntil: 0 });
        return {
          status: "succeeded",
          phase: "verified",
          reason: "",
          evidence: { pid: record.pid ?? null, managedProcessVerified: true, remotePortOpen: true, endToEndVerified: false },
        };
      }
    }
    const processAlive = current === record;
    return {
      status: processAlive ? "unknown" : "failed",
      phase: "verifying",
      reason: processAlive
        ? "进程已恢复，但验证窗口内未确认远端监听；端到端连通性待验证"
        : "tunnel process exited during verification",
      evidence: { pid: record.pid ?? null, managedProcessVerified: localVerified, remotePortOpen: remoteVerified, lastRemoteTimedOut: Boolean(lastRemote.timedOut), endToEndVerified: false },
    };
  }

  function restartControlled(config, options = {}) {
    return serializeMutation(() => restartControlledImpl(config, options));
  }

  // 「让这台承载」（仅信箱触发）：结束同账号另一台 Mac 在这个端口上的会话（对方读到让位通知后待命），
  // 再按受控重启的同一流程在本机建隧道并有界验证。本机已在承载且端口上没有别的 Mac 时直接报成功。
  async function takeOverControlledImpl(config, options = {}) {
    lastConfig = config;
    const marker = withSessionMarker(config).reclaimMarker;
    if (!marker) {
      return { status: "failed", phase: "queued", reason: "这台电脑的隧道没有会话标记（Windows 或服务器不支持远端等待进程），无法接力", evidence: {} };
    }
    if (pendingOrphanTask) await pendingOrphanTask.catch(() => {});
    const taken = await handover.takeOver(config, marker, { reason: "manual" });
    if (!taken.ok) {
      return { status: "failed", phase: "executing", reason: `没能结束另一台 Mac 的会话（${taken.reason}）`, evidence: {} };
    }
    const evidence = { takenFrom: taken.peer || null, sessionsFound: taken.found, sessionsEnded: taken.ended };
    if (taken.found === 0 && session && (current?.established || adoptedPid)) {
      return { status: "succeeded", phase: "verified", reason: "这台电脑已经在承载隧道", evidence: { ...evidence, alreadyActive: true } };
    }
    const result = await restartControlledImpl(config, options);
    return { ...result, evidence: { ...(result.evidence || {}), ...evidence } };
  }

  function takeOverControlled(config, options = {}) {
    return serializeMutation(() => takeOverControlledImpl(config, options));
  }

  // 网络切换（本机地址变化，例如换校园网账号 / 换 Wi-Fi / 休眠唤醒）：
  //   - 清零退避与死计数，本拍立即复核，不再等异己占用的 5 分钟长退避；
  //   - 若当前隧道 ssh 的 TCP 连接用的本端地址已经消失，这条连接必死无疑（服务器的回包
  //     送不到了），立刻重建，不等 ServerAlive 超时（约 1 分钟）。
  // 查不到连接地址（没有 lsof / 查询失败）时只清退避，交给 ServerAlive 兜底。
  async function handleNetworkChangeImpl(change = {}) {
    lastNetworkChangeAt = now();
    unreachableLogged = false;
    resetBackoff();
    // 网络切换是新的事实：此前的孤儿判定 / 残留回收限频不该拦住这一次复核。
    const serverKey = lastConfig?.id ?? lastConfig?.serverId ?? name;
    for (const prefix of ["orphan", "reclaim"]) rateLimiter.reset(`${prefix}:${serverKey}`);
    const removed = Array.isArray(change.removed) ? change.removed : [];
    const pid = current?.pid ?? adoptedPid;
    if (!removed.length || !pid) return { action: "backoff-reset" };
    let local = null;
    try {
      local = await readTcpLocalAddresses(pid);
    } catch {
      local = null;
    }
    if (!Array.isArray(local) || !local.length || !local.some((address) => removed.includes(address))) {
      return { action: "backoff-reset" };
    }
    logImpl(`network changed: tunnel ssh pid=${pid} was bound to ${local.join(", ")}, which is gone; reconnecting now`, {
      event: "tunnel-network-changed",
      pid,
      removed,
    });
    if (current?.pid === pid) await killCurrentAndWait("network-change");
    else await stopAdopted("network-change");
    return { action: "restarted", pid };
  }

  function handleNetworkChange(change) {
    return serializeMutation(() => handleNetworkChangeImpl(change));
  }

  // 热更新交接退出：只释放本进程内的附属资源（密码 broker 的 helper 文件），
  // 绝不 kill ssh、不删注册表记录——新 supervisor 按注册表原样接管这条隧道。
  async function releaseForHandoff() {
    const session = current?.passwordSession;
    if (session) await session.dispose().catch(() => {});
  }

  return { name, ensure, getCurrentChild, getState, resetBackoff, stopCurrent, restartControlled, takeOverControlled, whenOrphanSettled, releaseForHandoff, handleNetworkChange };
}
