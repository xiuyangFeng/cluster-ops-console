import { isActiveTunnelUp, parseProcessList } from "../../monitor-core.mjs";
import { resolveProxyPort, resolveTunnelTargets } from "../config-loader.mjs";
import { queryCmdlines } from "../process-registry.mjs";
import { readWindowsProcesses } from "../processes/query.mjs";
import { WINDOWS_PROCESS_QUERY_BUDGET_MS } from "../processes/windows-query.mjs";
import { isPort } from "../validators.mjs";
import { probeProxyHealth } from "../supervisor/proxy-health.mjs";

// 本机受管进程探针（supervisor / 本地代理 / 各服务器隧道），processes 探针与
// channel-lifecycle 的守护巡检共用 getProcesses。
//
// 进程识别快慢路径（性能）：`ps -ef` 在 ~700 进程的机器上每次 ~70ms CPU，5s 一拍比
// monitor-server 自身还费。5s 节拍不能放宽（lifecycle 6s 新鲜度约束，v2.25.2 回退过 15s），
// 所以改为：
//   - 全量扫描（`ps -ef`，与旧实现逐字同源同解析）：首轮、距上次全量 ≥60s（发现孤儿/
//     重复进程）、配置/隧道目标变化、上次结果不完整（任一角色缺席——此时要尽快发现
//     新拉起的进程，与旧行为一致）、或快路径校验发现任何变化；
//   - 快路径：只按 pid 查询上次全量识别出的受管进程（supervisor/代理/各隧道）的 cmdline，
//     拼成与 ps -ef 同形的行交给同一个 parseProcessList 复判；pid 全在且每个 pid 的
//     识别结果（角色 + 抽取出的命令）与上次逐字一致才复用上次结果，否则立刻全量。
// 打包模式（ELECTRON_RUN_AS_NODE，argv0 是 ".../MacOS/Codex Operations Console"）的
// 识别走同一个 extractCommand 的 " /" 回落分支——快路径的合成行 "- <pid> <command>" 前缀
// 不含任何解释器标记与 " /"，抽取结果与 ps -ef 行一致（v2.12 的全红误报不会回归）。
// win32 没有 ps：不走快路径，行为与旧实现完全一致。

// 快路径最长复用窗口：到点必做一次全量 ps，兜住孤儿/重复进程等"新增而非消失"的变化。
const FULL_PROCESS_SCAN_INTERVAL_MS = 60000;

// 受管进程指纹：`<角色>#<pid>` → 抽取出的命令。快路径复判与上次全量逐项比对。
function managedProcessEntries(value) {
  const entries = new Map();
  const add = (role, list) => {
    for (const proc of list || []) entries.set(`${role}#${proc.pid}`, proc.command);
  };
  add("proxy", value.localProxy);
  add("tunnel", value.reverseTunnel);
  add("supervisor", value.supervisor);
  for (const [serverId, list] of Object.entries(value.tunnelsByServer || {})) add(`tunnel:${serverId}`, list);
  return entries;
}

function isProcessSetComplete(value) {
  if (!value.supervisor.length || !value.localProxy.length) return false;
  if (value.tunnelsByServer) return Object.values(value.tunnelsByServer).every((list) => list.length > 0);
  return value.reverseTunnel.length > 0;
}

function sameEntries(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, command] of a) if (b.get(key) !== command) return false;
  return true;
}

export function createProcessProbe({ getConfig, execFileCmd, getMainServerConfig, getConnectionTargets, platform, now, readProxyHealth = probeProxyHealth }) {
  let processParseCache = { key: "", value: null };
  let processScanState = null; // { at, configKey, value, known: Map<pid, command> }

  async function verifyKnownProcesses(state, parse) {
    const pids = [...new Set([...state.known.keys()].map((key) => Number(key.slice(key.indexOf("#") + 1))))];
    if (pids.length === 0) return false;
    const found = await queryCmdlines(platform, pids, async (command, args) => {
      const res = await execFileCmd(command, args, { timeoutMs: 5000 });
      return { stdout: res?.stdout ? String(res.stdout) : "", failed: res?.code !== 0 };
    });
    if (pids.some((pid) => !found.has(pid))) return false;
    const lines = pids.map((pid) => `- ${pid} ${found.get(pid)}`).join("\n");
    return sameEntries(managedProcessEntries(parse(lines)), state.known);
  }

  // v2.18 多隧道：把整份隧道清单交给 parseProcessList，让它按每台服务器的
  // -R 转发串把 ssh 进程分类进 tunnelsByServer（layers.tunnels 与活跃隧道判定都读这份）。
  // 所有 -R 都落在同一个本地代理端口上，所以 localPort 统一取 resolveProxyPort——条目自带的
  // localPort 只作展示，拿它去匹配命令行会对非活跃服务器全部失配。
  // parseProcessList 接受 `id ?? serverId`，这里显式映射成 id，让"注册表/层级用
  // 哪个字段当键"在调用处一眼可见，而不是靠被调方的兜底。
  // 查看视角不能改变运行端口：supervisor 的共享代理在启动时固定，
  // 切服后的配置端口可能不同。优先使用已核实运行快照。
  function resolveParsePlan(parsed) {
    const targets = getConnectionTargets?.();
    const runtimePort = targets?.source === "supervisor-snapshot" && targets.freshness === "fresh"
      ? targets.effectiveProxyPort?.value : null;
    const proxyPort = isPort(runtimePort) ? runtimePort : resolveProxyPort(parsed);
    const tunnels = resolveTunnelTargets(parsed, { warn: () => {} }).map((target) => ({
      id: target.serverId,
      host: target.host,
      remotePort: target.remotePort,
      localPort: proxyPort,
    }));
    // 一条隧道都解析不出来（servers 为空 / 全是 tunnel:false / 参数全非法）时不传
    // tunnels：让 parseProcessList 退回旧形状（连 tunnelsByServer 这个键都不出现），
    // 下游活跃隧道判定与 state-store.channelFlags 随之回落到并集判据，
    // 与升级前逐字一致。传一个空数组是不行的——那会建出一个空的 tunnelsByServer，
    // 被下游当成"多隧道模式已生效但没有任何隧道"，把通道判成永久断开。
    const main = getMainServerConfig(parsed);
    const legacy = tunnels.length === 0;
    return {
      proxyPort,
      parse: (text) => (legacy ? parseProcessList(text, main) : parseProcessList(text, main, { proxyPort, tunnels })),
      configKey: legacy
        ? `legacy\n${JSON.stringify([main?.host, main?.remotePort, main?.localPort])}`
        : `${proxyPort}\n${JSON.stringify(tunnels)}`,
      cacheKeyFor: (stdout) => (legacy ? `legacy\n${stdout}` : `${stdout}\n${proxyPort}\n${JSON.stringify(tunnels)}`),
    };
  }

  async function getProcesses() {
    const parsed = await getConfig();
    const { parse, configKey, cacheKeyFor, proxyPort } = resolveParsePlan(parsed);

    const state = processScanState;
    if (platform !== "win32" && state && state.configKey === configKey
      && now() - state.at < FULL_PROCESS_SCAN_INTERVAL_MS && isProcessSetComplete(state.value)) {
      try {
        if (await verifyKnownProcesses(state, parse)) return state.value;
      } catch {
        // 快路径任何意外都回落全量扫描。
      }
    }

    const { stdout } = platform === "win32"
      ? { stdout: (await readWindowsProcesses(execFileCmd, { now })).map((p) => `- ${p.pid} ${p.command}`).join("\n") }
      : await execFileCmd("ps", ["-ef"]);
    const cacheKey = cacheKeyFor(stdout);
    const value = platform !== "win32" && processParseCache.key === cacheKey ? processParseCache.value : parse(stdout);
    if (platform === "win32" && value.localProxy.length === 0) {
      const health = await readProxyHealth(proxyPort);
      if (health?.ok && health.proxy?.pid) value.localProxy.push({ pid: String(health.proxy.pid), command: "local_http_connect_proxy.mjs [verified /proxy-health]" });
    }
    processParseCache = { key: cacheKey, value };
    processScanState = { at: now(), configKey, value, known: managedProcessEntries(value) };
    return value;
  }

  async function runProcessesProbe() {
    let processes;
    try { processes = await getProcesses(); }
    catch (error) {
      if (platform !== "win32") throw error;
      return { level: "waiting", reason: error.message, data: { processQueryIndeterminate: true,
        processQueryDiagnostic: { message: error.message, nextRetryAt: error.nextRetryAt, permanent: error.permanent === true, toolPath: error.toolPath, pidCount: error.pidCount } } };
    }
    const supervisorUp = processes.supervisor.length > 0;
    const localProxyUp = processes.localProxy.length > 0;
    // 探针自身的结论描述的是**主链路**，与 layers.channel 同口径：reverseTunnel 现在是
    // 所有隧道的并集，拿它判会在"活跃服务器断了、腾讯云还在"时报 ok，与面板上的红色
    // 主链路自相矛盾。判据与 state-store 的 channel 旗标同一条（isActiveTunnelUp）。
    const tunnelUp = isActiveTunnelUp(processes, getMainServerConfig(await getConfig())?.id);
    const upCount = [supervisorUp, localProxyUp, tunnelUp].filter(Boolean).length;
    const level = upCount === 3 ? "ok" : (upCount === 0 ? "error" : "warn");
    return {
      level,
      reason: `supervisor=${supervisorUp} proxy=${localProxyUp} tunnel=${tunnelUp}`,
      data: { processes },
    };
  }

  return { getProcesses, runProcessesProbe, queryTimeoutMs: platform === "win32" ? WINDOWS_PROCESS_QUERY_BUDGET_MS : 10000 };
}
