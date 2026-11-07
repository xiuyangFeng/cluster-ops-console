import { parseRemoteProbeOutput } from "../../monitor-core.mjs";
import {
  buildCollectorInvocation,
  parseAgentsInstalled,
  parseCollectorOutput,
  parseCpuStat,
  parseFilesystem,
  parseGpu,
  parseListeningPorts,
  parseProcTop,
} from "../collector.mjs";
import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { buildResourceUsage } from "../resource-usage.mjs";
import { createDirectNodeWatch } from "./direct-nodes.mjs";
import { parseSlurmSection } from "../slurm.mjs";
import { parseTunnelEgress } from "../tunnel-egress.mjs";
import { toPort } from "../validators.mjs";

// v2.18 零残留采集（设计 §6.4）：一轮探测对每台服务器最多两条 SSH——
//   log-signals（fast, 10s, 仅活跃服务器）：日志尾巴 + state.json + 反向端口监听态
//   collect:slow:<serverId>（60s, 每台未禁用服务器）：负载 + GPU + Agent 安装态 + 端口
// 取代了旧的 primary-remote(15s) 与 load:*(120s) 两组独立 SSH 探针。
export const COLLECT_SLOW_INTERVAL_MS = 60000;
// 采集本身的超时由 collector 的 profile 缺省值给（fast 15s / slow 20s）；
// 调度器整轮超时再留一点余量，避免慢网络下已回来的输出被整轮丢弃。
export const COLLECT_SLOW_TIMEOUT_MS = 25000;
// CPU 差分缓存的有界保护：异常配置下也不允许无限增长（正常规模 = 已配置服务器数）。
const CPU_CACHE_MAX_ENTRIES = 128;

// CT_PORTS = 该服务器自己的 remotePort（下游只看 ports[remotePort] 判定本机隧道在远端落地）。
// 端口只用于远端 `ss -ltn | grep`；非法值在这里就被丢掉，绝不进远端命令串
//（buildCollectorInvocation 里还有一道 assertSafePort 硬校验兜底）。
export function collectorPortsFor(server) {
  const port = toPort(server?.remotePort);
  return port === null ? [] : [port];
}

// slow 结果的 data 形状（v2.18 起逐字不变；usage 为 v2.20、slurm 为 v2.32、procTop 为 v2.62、tunnelEgress 为之后的加法字段）。
function buildSlowData({ server, sections, sysText, parsedSys, listening, usage }) {
  // 段缺失（输出被截断）时给 null 而不是"全都没装"的默认对象——
  // 没采到与真的没装是两回事，前端据此显示"未知"而非误报缺失。
  const agents = sections.agents === undefined ? null : parseAgentsInstalled(sections.agents);
  // v2.32 Slurm 节点与队列快照（lib/slurm.mjs）。段缺失（旧采集脚本 / 输出截断在它之前）
  // 给 null；非集群机器是 { state: "absent" }——没采到与没有 Slurm 是两回事。
  const slurm = sections.slurm === undefined ? null : parseSlurmSection(sections.slurm, { checkedAt: Date.now() });
  return {
    load: parsedSys
      ? {
          name: server.host,
          displayName: server.name,
          ok: true,
          cpu: parsedSys.cpu,
          ram: parsedSys.ram,
          disk: parsedSys.disk,
          output: sysText,
        }
      : null,
    // v2.20 usage：busyPct/loadNormalizedPct/共享文件系统/quota=unknown。旧字段不动。
    usage,
    // v2.62：采集账号自己的 GPU 进程另按 Slurm 作业合并显存（账号名取 agents 段，没有就用 slurm 段的）。
    gpu: parseGpu(sections.gpu || "", { selfUser: agents?.user || slurm?.user || null }),
    agents,
    ports: listening,
    remotePortOpen: listening[Number(server.remotePort)] === true,
    slurm,
    // v2.62 占用现场（按账号汇总的 CPU 与常驻内存，分作业内 / 作业外）。段缺失（旧采集脚本）或
    // 空段（远端 ps 不可用 / 超时）给 null。
    procTop: sections["proc-top"] === undefined ? null : parseProcTop(sections["proc-top"]),
    // 经隧道出网的程序（登录节点上连着 127.0.0.1:<remotePort> 的连接，按程序名汇总，lib/tunnel-egress.mjs）。
    // 段缺失（旧采集脚本）或空段给 null；远端没有 ss / 查询失败是 { state: "absent" | "error" }。
    tunnelEgress: sections["tunnel-egress"] === undefined ? null : parseTunnelEgress(sections["tunnel-egress"]),
  };
}

// onSlurmSection(serverId, text)：slurm 段原文的旁路观察者（v2.49 失败作业诊断的登记，见
// lib/jobs/service.mjs observeSlurmSection）。不等它、它的失败也不影响本探针结果。
export function createCollectProbes({ getConfig, dataDir, execCollector, getMainServerConfig, probeSshFailureReason, appendLog, onSlurmSection = null }) {
  // v2.33：直连节点（不在 Slurm 分区内、经登录节点 ssh 采集）的连通观察——只在状态变化时写日志，
  // 并给节点挂 lastSeenAt；不影响任何层级别。
  const directNodeWatch = createDirectNodeWatch({ appendLog });
  // T03：上一轮 /proc/stat 计数（serverId -> { counters, bootId, at }），用于
  // 相邻 slow 样本差分 CPU busy%。纯内存：monitor 重启后首帧 insufficient，诚实。
  const prevCpuByServer = new Map();

  function invocationFor(server, config, profile, ports) {
    return buildCollectorInvocation({
      server,
      parsed: config,
      profile,
      ports,
      knownHostsPath: resolveKnownHostsIfPresent(dataDir, server?.id),
    });
  }

  // fast profile（10s，仅活跃服务器）：日志尾巴/state.json 交给信号引擎，
  // ports 段顺带承担旧 primary-remote 的远端端口探测（15s → 10s，更快）。
  // logSourcesFor(config)：本轮要扫描的远端日志来源（缺省 = 扫描器默认全部）。reclaude 模块
  // 关闭时由注册方过滤掉 reclaude 两段；脚本与端口段不受影响。
  function createCollectFastRun({ scanSections, logSourcesFor = null }) {
    return async function runCollectFastProbe() {
      const config = await getConfig();
      const main = getMainServerConfig(config);
      if (!main || main.tunnel === false) return { level: "skipped", reason: main ? "仅监控，未启用通道日志探测" : "未配置可用服务器", data: null };
      const ports = collectorPortsFor(main);
      const { stdout, stderr, code } = await execCollector(invocationFor(main, config, "fast", ports), main);
      const { sections } = parseCollectorOutput(stdout);
      // 与旧实现同判据：非零退出且一段都没解析出来才算「远端抓取失败」；
      // 只要有段落回来就照常扫描（部分段缺失按空串处理）。
      const remoteFailed = code !== 0 && Object.keys(sections).length === 0;
      const result = await scanSections(
        {
          "reclaude-logs": sections["reclaude-logs"] || "",
          "reclaude-state": sections["reclaude-state"] || "",
        },
        {
          remoteFailed,
          failureReason: probeSshFailureReason(code, stderr, stdout),
          ...(logSourcesFor ? { sources: logSourcesFor(config) } : {}),
        },
      );
      // SSH 失败（data === null）时不编造端口结论：让 state-store 走「error 轮 →
      // remotePortOpen=false」的既有分支，而不是留一个假的 true。
      if (result.data) {
        const listening = parseListeningPorts(sections.ports || "", ports);
        result.data.ports = listening;
        result.data.remotePortOpen = listening[Number(main.remotePort)] === true;
      }
      return result;
    };
  }

  // T03：新版资源结构。cpu-stat/filesystem 段缺失（旧采集脚本/截断）→ 对应能力
  // null/insufficient；CPU busy 由相邻两轮 slow 样本差分，远端不 sleep 等第二帧。
  function sampleUsage(serverId, sections, sysText) {
    const cpuStat = sections["cpu-stat"] === undefined ? null : parseCpuStat(sections["cpu-stat"]);
    const filesystem = sections.filesystem === undefined ? null : parseFilesystem(sections.filesystem);
    const usage = buildResourceUsage({
      prev: prevCpuByServer.get(serverId) || null,
      cpuStat,
      filesystem,
      sysText,
      checkedAt: Date.now(),
    });
    if (cpuStat?.present && Number.isFinite(cpuStat.idle)) {
      // 保留原始有效计数供下一帧差分；缓存随服务器删除在 pruneCpuCache 里清理。
      prevCpuByServer.set(serverId, { counters: cpuStat, bootId: cpuStat.bootId ?? null, at: Date.now() });
    }
    if (prevCpuByServer.size > CPU_CACHE_MAX_ENTRIES) {
      const oldestKey = prevCpuByServer.keys().next().value;
      prevCpuByServer.delete(oldestKey);
    }
    return usage;
  }

  // slow profile（60s，每台未禁用服务器，含 tunnel:false 的）：负载 / GPU /
  // Agent 安装态 / 端口 / Slurm 快照。
  async function runCollectSlowProbe(serverId) {
    const config = await getConfig();
    const server = (config.servers || []).find((s) => s.id === serverId);
    if (!server) {
      return { level: "error", reason: `未知服务器 ${serverId}`, data: null };
    }
    if (server.disabled === true) return { level: "skipped", reason: "服务器已禁用", data: null };
    const ports = collectorPortsFor(server);
    const { stdout, stderr, code } = await execCollector(invocationFor(server, config, "slow", ports), server);
    const { sections } = parseCollectorOutput(stdout);
    if (Object.keys(sections).length === 0) {
      return { level: "error", reason: `采集失败 (${probeSshFailureReason(code, stderr, stdout)})`, data: null };
    }

    const sysText = (sections.sys || "").trim();
    // sys 段与旧 primary-remote/load 远端命令逐字同形，parseRemoteProbeOutput 零改动可解析；
    // 补 __PORT_OPEN__ 首行只是为了复用它的 ok 判定（端口结论另由 ports 段给出）。
    const parsedSys = sysText ? parseRemoteProbeOutput(`__PORT_OPEN__\n${sysText}`) : null;
    const listening = parseListeningPorts(sections.ports || "", ports);
    const usage = sampleUsage(serverId, sections, sysText);
    const data = buildSlowData({ server, sections, sysText, parsedSys, listening, usage });
    directNodeWatch.observe(server.id, data.slurm);
    if (onSlurmSection && sections.slurm !== undefined) {
      try {
        Promise.resolve(onSlurmSection(server.id, sections.slurm)).catch(() => {});
      } catch {}
    }
    if (!parsedSys) {
      // 负载段没回来但其它段（gpu/agents）回来了：如实报 error，同时把已到手的数据
      // 交出去——面板不该因为一台机器的 uptime 没读到就整块空白。
      return { level: "error", reason: `负载探测失败 (${probeSshFailureReason(code, stderr, stdout)})`, data };
    }
    return { level: "ok", reason: "负载已更新", data };
  }

  // 配置热载移除服务器后清掉它的 CPU 计数缓存，别让下线机器的陈旧计数无限期留在内存里。
  function pruneCpuCache(liveServerIds) {
    const live = new Set(liveServerIds);
    for (const serverId of [...prevCpuByServer.keys()]) {
      if (!live.has(serverId)) prevCpuByServer.delete(serverId);
    }
    directNodeWatch.prune(liveServerIds);
  }

  return { createCollectFastRun, runCollectSlowProbe, pruneCpuCache };
}
