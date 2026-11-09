import { assertSafeServerId } from "./lib/validators.mjs";
import { normalizeProcessCommand } from "./lib/processes/query.mjs";

// v2.18 多隧道命名收口。放在 monitor-core（零副作用模块）：channel-lifecycle / supervisor /
// 桌面退出路径都要用这个名字。前缀单独导出：退出路径按 pid 文件名反推记录名要用它。
export const TUNNEL_RECORD_PREFIX = "tunnel.";

// 注册表记录名 tunnel.<serverId>。serverId 会拼进注册表文件名（<name>.pid.json），
// 拼接前过 validators 的 assertSafeServerId（config-loader 对个人层 id 已同规则过滤，
// 这里是最后一道闸）。分隔符用 "." 而不是 ":"——冒号在 Windows 文件名里非法，同事有 Windows 机器。
export function tunnelRecordName(serverId) {
  return `${TUNNEL_RECORD_PREFIX}${assertSafeServerId(serverId)}`;
}

// options.tunnels 存在时：按每台服务器的 -R 转发串把 ssh 进程归类进 tunnelsByServer，
// reverseTunnel 变成"全部隧道的并集"（活跃服务器不再是唯一被识别的那条）。
// 不传第三参时输出形状逐字不变——连 tunnelsByServer 这个键都不出现，
// 旧调用方（probes.getProcesses / isActiveTunnelUp）与既有断言零回归。
// 没有活跃服务器（也没有隧道清单）时不识别任何隧道：绝不凭空假设连的是某台内置服务器
// （与 supervisor/config.mjs 读配置失败时的口径一致）。
export function parseProcessList(output, activeServerConfig, options) {
  const result = {
    localProxy: [],
    reverseTunnel: [],
    supervisor: [],
  };

  const config = activeServerConfig || null;

  // 条目缺 host/remotePort 无从匹配，直接剔除（宁可少报也不能把无关 ssh 归到某台服务器名下）。
  const tunnels = Array.isArray(options?.tunnels)
    ? options.tunnels.filter((t) => t?.host && t.remotePort && (t.id ?? t.serverId))
    : null;
  if (tunnels) {
    result.tunnelsByServer = {};
    // 预置空数组：下游据此区分"配了隧道但没起来"与"根本没配这台"。
    for (const t of tunnels) result.tunnelsByServer[t.id ?? t.serverId] = [];
  }

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.includes("grep ")) continue;

    const parts = line.split(/\s+/);
    const pid = parts[1];
    const command = extractCommand(line);
    if (!pid || !command) continue;

    if (command.includes("local_http_connect_proxy.mjs")) {
      result.localProxy.push({ pid, command });
    }

    if (tunnels) {
      let counted = false;
      for (const t of tunnels) {
        // 所有 -R 都指向同一个本地代理端口（proxyPort）；t.localPort 只是兼容回落。
        const localPort = options?.proxyPort ?? t.localPort ?? config?.localPort;
        if (
          !localPort ||
          !command.includes(`127.0.0.1:${t.remotePort}:127.0.0.1:${localPort}`) ||
          !command.includes(t.host)
        ) continue;
        result.tunnelsByServer[t.id ?? t.serverId].push({ pid, command });
        // 同一条 ssh 只可能服务一台服务器；两台配置撞车时也只并入并集一次。
        if (!counted) {
          counted = true;
          result.reverseTunnel.push({ pid, command });
        }
      }
    } else if (
      config &&
      command.includes(`127.0.0.1:${config.remotePort}:127.0.0.1:${config.localPort}`) &&
      command.includes(config.host)
    ) {
      result.reverseTunnel.push({ pid, command });
    }

    if (normalizeProcessCommand(command).includes("work/monitor/channel-supervisor.mjs")) {
      result.supervisor.push({ pid, command });
    }
  }

  return result;
}

export function normalizeAgentConfig(config = {}, { warn = () => {} } = {}) {
  // switchLabel：前端 agent 详情切换按钮的小字（renderAgentDetailSwitch）。
  // v2.17 起从配置取值以支持第三个 agent（此前 kind==="reclaude"?"ReClaude":"Doctor"
  // 硬编码）；默认物化保证无 agents 配置的场景显示文字与旧版逐字一致。
  const defaultAgents = [
    {
      id: "codex",
      name: "Codex",
      command: "codex",
      diagnosticLabel: "Codex Doctor",
      endpointLabel: "ChatGPT Codex API",
      switchLabel: "Doctor",
      kind: "codex",
    },
    {
      id: "claude-codewing",
      name: "Claude CodeWing",
      command: "reclaude",
      diagnosticLabel: "ReClaude 状态",
      endpointLabel: "Claude API",
      switchLabel: "ReClaude",
      kind: "reclaude",
    },
  ];

  const byId = new Map(defaultAgents.map((agent) => [agent.id, agent]));
  for (const agent of config.agents || []) {
    if (!agent?.id) continue;
    byId.set(agent.id, { ...(byId.get(agent.id) || {}), ...agent });
  }

  const agents = Array.from(byId.values());
  const activeAgentId = agents.some((agent) => agent.id === config.activeAgentId)
    ? config.activeAgentId
    : "codex";

  // 服务器字段收口校验：port/host 会被插值进下发到远端 shell 的命令串，
  // 非法值（非整数端口、含 shell 元字符的 host）一律回落默认，堵住注入面。
  // remotePort 例外：没有默认值。v2.54 起团队层不再预烤 remotePort，端口只来自个人层的登记结果；
  // 回落成 7891 会让没领端口的人直接 `ssh -R 7891`——主人在线时撞车，主人离线时抢走端口，
  // 把主人的集群流量引到自己电脑上出网。所以缺失 → 保持缺失（不建隧道，界面显示"未领取"），
  // 写了但非法 → 同样剔除并告警（warn 由调用方注入，缺省静默）。
  const servers = (config.servers || []).map((server) => {
    const remotePort = normalizePort(server?.remotePort, undefined);
    const raw = server?.remotePort;
    if (remotePort === undefined && raw !== undefined && raw !== null && raw !== "") {
      warn(`[config] 服务器 "${server?.id ?? "?"}" 的 remotePort ${JSON.stringify(raw)} 非法（须为 1-65535 的整数），已按"未领取端口"处理，不建隧道`);
    }
    const out = {
      ...server,
      localPort: normalizePort(server?.localPort, 8888),
      remotePort,
      host: normalizeHost(server?.host, "myserver"),
    };
    // 键位保持原样（合法端口时与旧版逐字一致）；没有端口就干脆没有这个键，下游统一按缺失处理。
    if (remotePort === undefined) delete out.remotePort;
    return out;
  });

  return {
    ...config,
    activeAgentId,
    agents,
    servers,
  };
}

// 隧道重试退避（秒）：前几次快速重试（5s 起翻倍，临时故障秒级恢复），
// 持续失败逐步拉长到 5 分钟上限——用户经常在 SSH 白名单网络之外，
// 旧的 60s 上限会对服务器形成长期连接轰炸（也曾疑似触发服务端限速）。
// 上限取 300s 而非更长：退避窗口内不做任何探测，网络自行恢复后的
// 自动重连延迟最长即为当前档位，5 分钟是轰炸削减与自愈时效的平衡点。
export function computeTunnelBackoffSec(retryCount) {
  const n = Math.max(1, Number(retryCount) || 1);
  return Math.min(300, 5 * 2 ** (n - 1));
}

// 一级守护拉起 supervisor 的退避（毫秒）：首次立即，随后 5s/10s/20s/40s，上限 60s。
// 避免 supervisor 启动即崩时每 5s 巡检制造双实例或日志雪崩；上限短于隧道退避，
// 因为这是本机进程拉起，不是打集群。
export function computeRepairBackoffMs(consecutiveFailures) {
  const n = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(60_000, 5_000 * 2 ** (n - 1));
}

export function normalizePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

export function normalizeHost(value, fallback) {
  // 只拦 shell 元字符（空格、;、|、$、引号等），放行合法 ssh 目标：
  // 别名、域名、user@host、IPv6 冒号/方括号形式。
  return typeof value === "string" && /^[\w.@:[\]-]+$/.test(value) ? value : fallback;
}

export function parseReclaudeStatus({ statusOutput = "", versionOutput = "", gatewayOutput = "", deviceOutput = "", stateOutput = "", logsOutput = "" } = {}) {
  const combined = `${statusOutput}\n${versionOutput}`.toLowerCase();
  // ReClaude v1.2.x 的 status 输出已从 "daemon: running / login: ok" 改成
  // snake_case 字段，且不再直接输出登录字段。统一归一化后兼容两代格式。
  const normalizedStatus = statusOutput.replaceAll("_", " ");
  const claudePath = valueAfterLabel(statusOutput, "claude_path")
    || valueAfterLabel(normalizedStatus, "claude path")
    || valueAfterLabel(statusOutput, "claude");
  const versionMatch = versionOutput.match(/\bv?\d+\.\d+\.\d+\b/i);

  const daemonFlag = valueAfterLabel(statusOutput, "daemon_running")
    || valueAfterLabel(normalizedStatus, "daemon running");
  const daemonReachableFlag = valueAfterLabel(statusOutput, "daemon_reachable")
    || valueAfterLabel(normalizedStatus, "daemon reachable");
  const daemonRunning = /^(true|yes|1)$/i.test(daemonFlag)
    || /^(true|yes|1)$/i.test(daemonReachableFlag)
    || (!daemonFlag && !daemonReachableFlag && /\bdaemon\b.*\b(running|started|ok)\b/i.test(normalizedStatus));

  // device.json 是设备授权完成后的本地绑定凭据。探针只输出存在性标记，
  // 不读取任何密钥或账户内容；显式的 status 登录失败仍拥有更高优先级。
  const deviceBound = /__RECLAUDE_DEVICE_BOUND__/i.test(deviceOutput);
  const deviceMissing = /__RECLAUDE_DEVICE_UNBOUND__/i.test(deviceOutput);
  const loginValue = valueAfterLabel(normalizedStatus, "login")
    || valueAfterLabel(normalizedStatus, "auth")
    || valueAfterLabel(normalizedStatus, "session");
  const explicitLoginOk = /^(ok|valid|active|success|true|logged)$/i.test(loginValue)
    || /\b(login|auth|session)\b.*\b(ok|valid|active|success|logged in)\b/i.test(normalizedStatus)
    || /\b(current org|organization|account)\b\s*[:=]\s*\S+/i.test(normalizedStatus);
  const explicitLoginMissing = /^(false|missing|invalid|expired|required|none|no)$/i.test(loginValue)
    || /\b(login|auth|session)\b.*\b(required|missing|invalid|expired|not logged in|failed)\b/i.test(normalizedStatus);
  const loggedIn = explicitLoginMissing ? false : (explicitLoginOk || deviceBound ? true : (deviceMissing ? false : null));

  // gatewayOk 三态：优先 ~/.reclaude/state.json 的 gateway.healthy（daemon 自报的真实网关状态）；
  // 旧 gateway test 输出仅作回落（该命令绕过代理裸连，在 TLS 拦截网络下必失败）；
  // 二者皆无 → null（未知，不参与降级判定）。
  let gatewayOk = null;
  if (stateOutput.trim()) {
    try {
      const healthy = JSON.parse(stateOutput)?.gateway?.healthy;
      if (typeof healthy === "boolean") gatewayOk = healthy;
    } catch {}
  }
  if (gatewayOk === null && gatewayOutput.trim()) {
    gatewayOk = /\b(ok|success|reachable|connected)\b/i.test(gatewayOutput) && !/\b(fail|error|timeout|refused)\b/i.test(gatewayOutput);
  }
  if (gatewayOk === null) {
    const statusGatewayFlag = valueAfterLabel(statusOutput, "gateway_healthy")
      || valueAfterLabel(normalizedStatus, "gateway healthy");
    if (/^(true|yes|1)$/i.test(statusGatewayFlag)) gatewayOk = true;
    else if (/^(false|no|0)$/i.test(statusGatewayFlag)) gatewayOk = false;
  }

  return {
    installed: !/\b(command not found|not found|no such file|not installed)\b/i.test(combined) && Boolean(versionMatch || statusOutput.trim()),
    daemonRunning,
    loggedIn,
    claudePath,
    version: versionMatch ? versionMatch[0] : "",
    gatewayOk,
    gatewayOutput: gatewayOutput.trim(),
    stateOutput: stateOutput.trim(),
    logsOutput: logsOutput.trim(),
  };
}

export function parseReclaudeCombinedOutput(output = "") {
  return {
    versionOutput: sectionBetween(output, "RECLAUDE_VERSION"),
    statusOutput: sectionBetween(output, "RECLAUDE_STATUS"),
    gatewayOutput: sectionBetween(output, "RECLAUDE_GATEWAY"),
    deviceOutput: sectionBetween(output, "RECLAUDE_DEVICE"),
    stateOutput: sectionBetween(output, "RECLAUDE_STATE"),
    logsOutput: sectionBetween(output, "RECLAUDE_LOGS"),
  };
}

// B1：账号层故障探针——从 reclaude logs / state.json 原文识别设备解绑(401)/账号封禁(403)。
// 要求"故障 code 字段"与"对应 status 数字"同时出现才判定，避免把无关的裸 401/403
// （比如别的探针输出恰好含 "status 401"）或代码里提及故障名字符串误判为真实账号层故障
// （宁可漏报不可误报）。真实脱敏样本：
//   401: unexpected status 401: {"error":{"code":"device_revoked","status":401,"message":"此设备已被解绑..."}}
//   403: unexpected status 403: {"error":{"code":"account_banned","status":403,"message":"当前绑定账号暂不可用"}}
//
// B1：账号层故障检测已迁入统一信号规则表（v2.10 日志信号检测重构），
// 此处 re-export 保持既有调用方（probes.mjs / 测试）导入路径不变。
// 语义不变：要求"故障 code 字段"与"对应 status 数字"同时出现才判定（宁可漏报不可误报）。
export { detectAccountFault } from "./lib/log-signals.mjs";

export function classifyAgentHealth(status = {}) {
  if (!status.installed) return "missing";
  if (status.accountFault === "revoked") return "revoked";
  if (status.accountFault === "banned") return "banned";
  if (status.loggedIn === false) return "auth-required";
  if (status.gatewayOk === false) return "degraded";
  return "ready";
}

export function buildNetworkChannel({
  shouldBeRunning,
  localProxyUp,
  tunnelUp,
  remotePortOpen,
  server,
}) {
  const localPort = server?.localPort || 8888;
  // 没领端口时远端代理地址是 null（界面显示"未领取"），绝不回落 7891——那会把别人的隧道
  // 当成自己的：远端端口检查/展示都会对着别人的 7891。
  const remotePort = normalizePort(server?.remotePort, null);
  return {
    shouldBeRunning,
    localProxyUp,
    tunnelUp,
    remotePortOpen,
    host: server?.host || "myserver",
    localProxyUrl: `http://127.0.0.1:${localPort}`,
    remoteProxyUrl: remotePort ? `http://127.0.0.1:${remotePort}` : null,
    topology: "HTTP_CONNECT_REVERSE_TUNNEL",
  };
}

export function buildAgentOverview(agents = [], statuses = {}, activeAgentId = "codex") {
  return agents.map((agent) => {
    const status = statuses[agent.id] || {};
    const health = status.health || "waiting";
    return {
      id: agent.id,
      name: agent.name,
      kind: agent.kind,
      health,
      selected: agent.id === activeAgentId,
      tag: agentHealthTag(health),
      summary: agentSummary(agent, status),
    };
  });
}

export function getSupervisorCommand(rootDir, { dataRoot, runtimeDir, configPath, localConfigPath } = {}) {
  const env = { CODEX_MONITOR_APP_ROOT: rootDir };
  if (dataRoot) env.CODEX_MONITOR_DATA_DIR = dataRoot;
  if (configPath) env.CODEX_MONITOR_CONFIG_PATH = configPath;
  if (localConfigPath) env.CODEX_MONITOR_LOCAL_CONFIG_PATH = localConfigPath;
  return {
    execPath: process.execPath,
    args: ["work/monitor/channel-supervisor.mjs"],
    cwd: rootDir,
    env,
    mkdir: [dataRoot, runtimeDir].filter(Boolean),
  };
}

export function parseDoctorSummary(output) {
  const summaryLine =
    output
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /\d+\s+ok\b.*\d+\s+fail\b/.test(line)) || "";

  return {
    ok: numberBefore(summaryLine, "ok"),
    notes: numberBefore(summaryLine, "notes"),
    warn: numberBefore(summaryLine, "warn"),
    fail: numberBefore(summaryLine, "fail"),
    raw: summaryLine,
    warnItems: parseDoctorWarnItems(output),
  };
}

// 提取 doctor 输出里的警告项明细（codex doctor 用 [!!] 标记警告行）。
// 此前 summary 只带计数，前端任何地方都看不到"到底是哪项在警告"——用户只能
// 面对一个常驻的"1 warn"。输出的 Notes 汇总区会把正文里的 [!!] 行重复一遍，
// 按 name+text 去重。fail 项不在此提取：fail 会直接降级并引导用户看完整输出。
export function parseDoctorWarnItems(output = "") {
  const seen = new Set();
  const items = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\[!!\]\s+(\S+)\s+(.*\S)\s*$/);
    if (!match) continue;
    const key = `${match[1]}|${match[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name: match[1], text: match[2] });
  }
  return items;
}

// B2：codex endpoint 与 claude endpoint 是应用层可达性探测，不是通道存活信号。
// 通道层（本地代理/SSH 隧道/远端端口）才是唯一能判 down 的信号——down 会触发
// supervisor 全局 restart，杀掉本来健康的隧道，对应用层故障（上游 API 抖动/改版）
// 毫无帮助，反而制造孤儿隧道（曾因反向 chatgpt 405→404 的字面量误判触发过）。
// 任一/两个端点失败都只降到 degraded，绝不再拖累到 down。
export function classifyHealth({ shouldBeRunning, supervisorUp, localProxyUp, tunnelUp, remotePortOpen, endpoint, claudeEndpoint, doctor }) {
  if (shouldBeRunning === false) {
    if (!supervisorUp && !localProxyUp && !tunnelUp) {
      return "stopped";
    }
    return "waiting";
  }
  if (!localProxyUp || !tunnelUp || !remotePortOpen) {
    return "down";
  }
  if (supervisorUp === false) return "degraded";
  const endpointBad = endpoint && endpoint.ok === false;
  const claudeEndpointBad = claudeEndpoint && claudeEndpoint.ok === false;
  if (endpointBad || claudeEndpointBad) return "degraded";
  // doctor warn 是建议级提示（如 codex CLI 的 "rollout files missing"、可更新提醒），
  // 不影响通道使用——只有 fail 才降级。此前 warn>0 也拖成 degraded，导致一条无害
  // 提示让整个控制台常年黄条"服务降级"。warn 明细经 summary.warnItems 透出到前端展示。
  if (doctor && doctor.fail > 0) return "degraded";
  return "ready";
}

// codex 端点可达性：只要求"CONNECT 隧道已建立 且 上游至少返回过一次 HTTP 状态行"，
// 不再绑死字面量 HTTP/2 405——上游/反向代理把 405 换成 404 等其它状态码时，
// 旧的严格匹配会把仍然可达的端点误判为 down 并触发无谓 restart。
export function isEndpointReachable(stdout = "") {
  if (!stdout.includes("Connection Established")) return false;
  // 必须剥掉 CONNECT 握手应答行（"HTTP/1.1 200 Connection Established" 自身即含状态行，
  // 会让下面的正则被隧道建立这一步自满足），再要求剩余输出里有真正的上游状态行——
  // 否则上游 TLS 被 RST/超时、curl 只剩 CONNECT 行时会把故障端点误判为可达。
  const upstream = stdout
    .split("\n")
    .filter((line) => !line.includes("Connection Established"))
    .join("\n");
  return /HTTP\/[12](\.\d)?\s+\d{3}/.test(upstream);
}

// 输出截断：保留前 80 行，避免超长诊断刷爆前端（v2 起从 monitor-server 上移为共享导出）。
export function trimOutput(output = "") {
  return output.trim().split("\n").slice(0, 80).join("\n");
}

// 由 doctor + endpoint 结果合成 Codex Agent 的展示状态（v1.5.2 语义原样保留）。
export function buildCodexAgentStatus(doctor, endpoint) {
  const fail = doctor?.summary?.fail || 0;
  // warn 不再降级（与 classifyHealth 同一决策）：warn-only 时卡片保持 ready，
  // 提醒内容由前端经 summary.warnItems 在卡片抽屉/诊断浮层展示。
  const health = endpoint?.ok === false || fail > 0 ? "degraded" : "ready";
  return {
    ok: endpoint?.ok !== false && fail === 0,
    health,
    installed: Boolean(doctor?.summary?.raw || doctor?.ok),
    diagnosticLabel: "Codex Doctor",
    endpointLabel: "ChatGPT Codex API",
    summary: doctor?.summary || { ok: 0, fail: 0, warn: 0, notes: 0, raw: "" },
    endpoint,
    output: trimOutput([doctor?.output, endpoint?.output].filter(Boolean).join("\n\n--- endpoint ---\n")),
  };
}

// 由 reclaude daemon 状态 + Claude API 端点探测合成 Claude CodeWing Agent 的展示状态。
// endpoint.ok 为 null/undefined 表示尚未探测（或熔断跳过），不参与降级判定。
// 健康阶梯与 classifyAgentHealth 同一份，端点失败只在其判 ready 时降为 degraded。
export function buildClaudeAgentStatus(reclaudeData = {}, claudeEndpoint = null) {
  const endpointBad = claudeEndpoint ? claudeEndpoint.ok === false : false;
  const base = classifyAgentHealth(reclaudeData);
  const health = base === "ready" && endpointBad ? "degraded" : base;
  return {
    ...reclaudeData,
    ok: health === "ready",
    health,
    diagnosticLabel: "ReClaude 状态",
    endpointLabel: "Claude API",
    claudeEndpoint: claudeEndpoint || { ok: null, output: "" },
  };
}

// 主链路（查看视角那台）的隧道是否在——processes 探针结论与 layers.channel 共用这一条判据。
// v2.18 起 reverseTunnel 是"全部隧道的并集"，光靠它会让"腾讯云隧道在、myserver 隧道断"
// 也被判成在。parseProcessList 按多隧道模式解析（有 tunnelsByServer）且给出
// activeServerId 时只看活跃服务器那一格；否则（旧形状/首轮/无活跃服务器）沿用并集判据。
export function isActiveTunnelUp(processes, activeServerId) {
  return activeServerId && processes.tunnelsByServer
    ? (processes.tunnelsByServer[activeServerId]?.length ?? 0) > 0
    : processes.reverseTunnel.length > 0;
}

export function parseRemoteProbeOutput(output) {
  const trimmed = output.trim();
  const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
  const remotePortOpen = lines.includes("__PORT_OPEN__");
  const host = lines.find((line) => line !== "__PORT_OPEN__") || "";
  const uptimeLine = lines.find((line) => line.includes("up") && line.includes("load average"));
  const memLine = lines.find((line) => line.startsWith("Mem:"));
  const diskLine = lines.find((line) => line.includes("%") && !line.startsWith("Mem:"));
  const nprocLine = lines.find((line) => /^nproc:\s*\d+$/.test(line));
  const cores = nprocLine ? parseInt(nprocLine.split(":")[1], 10) : null;

  return {
    ok: remotePortOpen && Boolean(host),
    remotePortOpen,
    host,
    cpu: parseCpuFromUptime(uptimeLine, cores),
    ram: parseRamFromMem(memLine),
    disk: parseDisk(diskLine),
    cores,
    output: trimmed,
  };
}

export function parseCpuFromUptime(uptimeLine, cores = null) {
  if (!uptimeLine) return 0;
  const match = uptimeLine.match(/load average:\s*([0-9.]+)/i);
  if (!match) return 0;
  const load1 = parseFloat(match[1]);
  // 有核数时按 load1/核数 归一化（与前端 load-panel 的实时展示同单位），
  // 老输出（无 nproc 行）维持 load1×100 封顶的历史语义。
  if (Number.isInteger(cores) && cores > 0) {
    return Math.min(Math.round((load1 / cores) * 100), 100);
  }
  return Math.min(Math.round(load1 * 100), 100);
}

export function parseRamFromMem(memLine) {
  if (!memLine) return 0;
  const parts = memLine.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return 0;

  const totalStr = parts[1];
  const usedStr = parts[2];
  const totalNum = parseFloat(totalStr);
  const usedNum = parseFloat(usedStr);
  if (!(totalNum > 0)) return 0;

  let totalVal = totalNum;
  let usedVal = usedNum;
  if (totalStr.toLowerCase().includes("g") && usedStr.toLowerCase().includes("m")) {
    usedVal = usedNum / 1024;
  } else if (totalStr.toLowerCase().includes("m") && usedStr.toLowerCase().includes("g")) {
    totalVal = totalNum / 1024;
  }
  return Math.min(Math.round((usedVal / totalVal) * 100), 100);
}

export function parseDisk(diskLine) {
  if (!diskLine) return 0;
  const percentMatch = diskLine.match(/(\d+)%/);
  return percentMatch ? parseInt(percentMatch[1], 10) : 0;
}

function numberBefore(line, label) {
  const match = line.match(new RegExp(`(\\d+)\\s+${label}\\b`));
  return match ? Number(match[1]) : 0;
}

function valueAfterLabel(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = output.match(new RegExp(`${escaped}\\s*[:=]\\s*(\\S+)`, "i"));
  return match ? match[1] : "";
}

function sectionBetween(output, key) {
  const pattern = new RegExp(`__${key}_BEGIN__\\n?([\\s\\S]*?)\\n?__${key}_END__`, "m");
  const match = output.match(pattern);
  return match ? match[1].trim() : "";
}

function agentHealthTag(health) {
  const tags = {
    ready: "Ready",
    degraded: "降级",
    missing: "未安装",
    "auth-required": "需登录",
    revoked: "账号被解绑",
    banned: "账号被封",
    waiting: "检测中",
    stopped: "已停止",
  };
  return tags[health] || "未知";
}

function agentSummary(agent, status) {
  if (agent.id === "codex") {
    const summary = status.summary || {};
    if (typeof summary.ok === "number" || typeof summary.fail === "number") {
      return `${summary.ok || 0} 项通过，${summary.fail || 0} 项失败`;
    }
    return "等待 Codex Doctor 诊断";
  }

  if (agent.id === "claude-codewing") {
    if (status.health === "ready") return `ReClaude ${status.version || ""} 已就绪`;
    if (status.health === "auth-required") return "ReClaude 已安装，等待 CodeWing 设备登录";
    if (status.health === "missing") return "远端未检测到 reclaude";
    // B1：账号层故障（device_revoked/account_banned）——三层判定此前全绿的盲区，
    // 明确给出需要在集群终端重新执行 reclaude 完成登录的指引。
    if (status.health === "revoked") return "此设备已被解绑，需在集群终端重新运行 reclaude 完成登录";
    if (status.health === "banned") return "当前绑定账号暂不可用，需在集群终端重新运行 reclaude 完成登录";
    if (status.health === "degraded") return "ReClaude 或 Claude API 链路异常";
    return "等待 ReClaude 诊断";
  }

  return status.output || "等待诊断";
}

function extractCommand(line) {
  const windows = /^\S+\s+\d+\s+((?:"[A-Za-z]:\\|[A-Za-z]:\\).*)$/.exec(line);
  if (windows) return windows[1];
  const markers = ["node ", "node.exe ", "ssh ", "ssh.exe ", '"ssh.exe" ', "/bin/sh ", "bash "];
  const index = markers
    .map((marker) => line.indexOf(marker))
    .filter((value) => value >= 0)
    .sort((a, b) => a - b)[0];
  if (index !== undefined) return line.slice(index).trim();
  // 打包运行时下受管进程经 ELECTRON_RUN_AS_NODE 由 Electron 主二进制拉起
  // （argv0 形如 ".../MacOS/Codex Operations Console"），不含上述解释器标记；
  // ps -ef 的命令列对绝对路径命令始于行内首个 " /"，从那里切出命令。
  const absIndex = line.indexOf(" /");
  return absIndex >= 0 ? line.slice(absIndex + 1).trim() : "";
}
