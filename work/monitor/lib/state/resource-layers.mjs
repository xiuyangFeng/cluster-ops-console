// layers.resources / layers.validation / layers.signals 的纯投影。
// 数据源：每台服务器自己的 collect:slow 采集（负载 + 旁路数据）、活跃服务器的
// validation 探针、log-signals（fast 采集）的信号快照。

const EMPTY_BRIEF = { ok: false, cpu: 0, ram: 0, disk: 0, output: "" };

// slow 采集旁路数据（GPU / Agent 安装态 / 新版资源结构 / Slurm 快照 / 占用现场）的归一形状。
// 调用方只在「本轮确有 data」时刷新——60s 一轮的探针偶发超时不该把 GPU 行抹空。
export function resourceExtrasFrom(data) {
  return {
    gpu: data.gpu || [],
    agents: data.agents || null,
    // T03：新版资源结构（busyPct/共享文件系统/quota）。旧采集脚本 data.usage 缺失
    // → null，消费端显示"未知"。
    usage: data.usage ?? null,
    // v2.32：Slurm 节点与队列快照（lib/slurm.mjs）。旧采集脚本 → null；非集群机器 → state:"absent"。
    slurm: data.slurm ?? null,
    // v2.62：占用现场——按账号汇总的 CPU 与常驻内存，分作业内 / 作业外（collector.parseProcTop）。
    // 旧采集脚本 / 远端 ps 不可用 → null。
    procTop: data.procTop ?? null,
    // 经隧道出网的程序（lib/tunnel-egress.mjs）。旧采集脚本 → null。
    tunnelEgress: data.tunnelEgress ?? null,
  };
}

function resourceLevel(result, brief) {
  if (!result) return { level: "waiting", reason: "等待首次探测" };
  if (result.level === "skipped") return { level: "skipped", reason: result.reason || "探针已跳过" };
  if (result.level === "error" || !brief.ok) return { level: "error", reason: result.reason || "负载探测失败" };
  return { level: "ok", reason: "负载已更新" };
}

// servers：已过滤掉屏蔽条目的服务器列表。v2.18：每台服务器（含活跃服务器）的负载
// 都由自己的 collect:slow 探针给出。
export function buildResourcesLayer({ servers, slowResultFor, serversBrief, resourceExtras }) {
  const resources = {};
  for (const server of servers) {
    const result = slowResultFor(server.id);
    const brief = serversBrief[server.id] || EMPTY_BRIEF;
    const extras = resourceExtras.get(server.id) || null;
    const { level, reason } = resourceLevel(result, brief);
    resources[server.id] = {
      level,
      reason,
      checkedAt: result ? result.checkedAt : null,
      cpu: brief.cpu,
      ram: brief.ram,
      disk: brief.disk,
      output: brief.output,
      // 无 nvidia-smi（腾讯云等非 GPU 机器）时为空数组；只展示不告警（设计 §3.7）。
      gpu: extras ? extras.gpu : [],
      // agents 段（codex/reclaude/zcode 装没装 + reclaude 服务活性 + 单元存在性），未采到为 null。
      agentsInstalled: extras ? extras.agents : null,
      // T03：新版资源结构（schemaVersion 1）。旧采集脚本 / 未采到为 null。
      usage: extras ? extras.usage ?? null : null,
      // v2.32：Slurm 节点与队列快照；未采到 / 旧采集脚本为 null。
      slurm: extras ? extras.slurm ?? null : null,
      // v2.62：占用现场（谁在用 CPU 与内存、是不是 Slurm 作业）；未采到 / 旧采集脚本为 null。
      procTop: extras ? extras.procTop ?? null : null,
      // 此刻经隧道出网的程序（连着 127.0.0.1:<remotePort> 的连接按程序名汇总）；未采到 / 旧采集脚本为 null。
      tunnelEgress: extras ? extras.tunnelEgress ?? null : null,
    };
  }
  return resources;
}

// 只透出仍配着 validationProfile 的服务器（档案被删后残留结果不再展示）。
export function buildValidationLayer({ validationByServer, servers }) {
  const validation = {};
  for (const [serverId, result] of validationByServer.entries()) {
    const server = (servers || []).find((s) => s.id === serverId);
    if (server?.validationProfile) {
      validation[serverId] = {
        level: result.level,
        reason: result.reason || "",
        items: result.data ? (result.data.items || []) : [],
        checkedAt: result.checkedAt,
      };
    }
  }
  return validation;
}

// v2.10：卡顿反馈信号层——log-signals 探针结果直通透出，供前端红条与时间线。
// 探针本次结果没有 data（超时/SSH 失败）时回退到最近一次已知信号快照，不清空红条。
export function buildSignalsLayer(signalResult, lastKnownSignalsData) {
  const signalsData = signalResult?.data ? signalResult.data : null;
  return {
    level: signalResult ? signalResult.level : "waiting",
    reason: signalResult ? (signalResult.reason || "") : "等待首次探测",
    checkedAt: signalResult ? signalResult.checkedAt : null,
    active: signalsData ? (signalsData.activeSignals || []) : lastKnownSignalsData.active,
    // 设计要求：只展示日志最近活动时刻，不做"静默=卡死"告警判定。
    lastActivityAt: signalsData ? (signalsData.lastActivityAt ?? null) : lastKnownSignalsData.lastActivityAt,
  };
}
