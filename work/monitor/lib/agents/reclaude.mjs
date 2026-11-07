// ReClaude（Claude CodeWing）agent 适配器：reclaude / claude-endpoint 两枚探针
// + agentsStatus 合成。探针命令与解析逻辑自 probes.mjs 原样搬入（v1.5.2 语义），
// 归并逻辑自 state-store.mjs 原样搬入——本文件只是收拢差异点，行为逐字节不变。

import {
  buildClaudeAgentStatus,
  classifyAgentHealth,
  detectAccountFault,
  parseReclaudeCombinedOutput,
  parseReclaudeStatus,
  trimOutput,
} from "../../monitor-core.mjs";
import { parseAgentExpiry } from "../agent-creds.mjs";
import { CURL_STDIN_CONFIG_FLAG, curlProxyAuthInput, remoteProxyEnv } from "../egress/remote-proxy-auth.mjs";
import { isPort } from "../validators.mjs";

// 熔断占位输出：与 v1.5.2 低频轮询跳过时写入 globalStateCache 的字符串逐字一致。
const BREAKER_ENDPOINT_OUTPUT = "通道异常，已熔断跳过检查";
const BREAKER_RECLAUDE_OUTPUT = "通道异常，已熔断跳过 ReClaude 检查";

// Claude Code 的实际 API 站可以是团队代理白名单中的非标准 HTTPS 目标（例如
// close-api:9443）。优先接受 agent.endpointTarget，便于白名单里有多条 API 站时
// 明确选定；否则取 proxyAllowedTargets 的第一条有效 host:port。旧配置没有这些字段时
// 保留 api.anthropic.com:443，确保升级不把既有 ReClaude 端点监控变成未配置。
// 解析结果会被插入远端 shell 命令，故只接受 DNS 主机名或中括号 IPv6 + 合法端口，
// 配置中的任意其它文本都不会进入命令串。
export function resolveClaudeEndpointTarget(config = {}) {
  const claudeAgent = (config.agents || []).find((agent) => agent?.id === "claude-codewing");
  const candidates = [claudeAgent?.endpointTarget];
  if (Array.isArray(config.proxyAllowedTargets)) candidates.push(...config.proxyAllowedTargets);

  for (const raw of candidates) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    const match = value.match(/^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+):(\d{1,5})$/);
    if (!match) continue;
    const port = Number(match[2]);
    if (!isPort(port)) continue;
    return { host: match[1], port, authority: `${match[1]}:${port}`, configured: true };
  }
  return { host: "api.anthropic.com", port: 443, authority: "api.anthropic.com:443", configured: false };
}

// v1.5.2 runReclaudeDiagnostics。
// 代理口令（v2.62）不是关时：口令经标准输入的第一行交给远端 shell、由它拼进环境变量（命令文本里只有变量名）；
// 是关时 proxyEnv.prelude 为空、prefix 就是原来那串，整条命令逐字不变。
async function runReclaudeProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  const proxyEnv = remoteProxyEnv(main.remotePort, { credential: ctx.getProxyCredential?.() ?? null, noProxy: false });
  const remotePrefix = `PATH="$HOME/.local/bin:$PATH" ${proxyEnv.prefix}`;
  const remoteCommand = [
    `${proxyEnv.prelude}echo __RECLAUDE_VERSION_BEGIN__`,
    `${remotePrefix}reclaude version 2>&1 || true`,
    "echo __RECLAUDE_VERSION_END__",
    "echo __RECLAUDE_STATUS_BEGIN__",
    `${remotePrefix}reclaude status 2>&1 || true`,
    "echo __RECLAUDE_STATUS_END__",
    // 设备登录的稳定事实来源：只检查绑定文件是否存在，不回传 device.json 内容，
    // 避免 ReClaude v1.2.x status 不再输出 login 字段时被前端误判为需登录。
    "echo __RECLAUDE_DEVICE_BEGIN__",
    "test -s ~/.reclaude/device.json && echo __RECLAUDE_DEVICE_BOUND__ || echo __RECLAUDE_DEVICE_UNBOUND__",
    "echo __RECLAUDE_DEVICE_END__",
    // gateway test 故意绕过代理裸连，在集群 TLS 拦截网络下必失败（误报源）；
    // 改读 daemon 自报的 state.json，其 gateway.healthy 才是真实网关状态。
    "echo __RECLAUDE_STATE_BEGIN__",
    // B3：同上，state.json 也放宽截断，避免 gateway.healthy/凭证 exp 被截断丢失。
    "cat ~/.reclaude/state.json 2>/dev/null | head -c 16384 || true",
    "echo __RECLAUDE_STATE_END__",
    "echo __RECLAUDE_LOGS_BEGIN__",
    `${remotePrefix}reclaude logs 2>&1 | tail -40 || true`,
    "echo __RECLAUDE_LOGS_END__",
  ].join("; ");
  const combined = await ctx.execFileCmd(
    "ssh",
    [...ctx.sshArgsFor(main, config), remoteCommand],
    { timeoutMs: 30000, server: main, ...(proxyEnv.input !== null ? { input: proxyEnv.input } : {}) },
  );
  const sections = parseReclaudeCombinedOutput(combined.stdout || combined.stderr);
  const parsed = parseReclaudeStatus(sections);
  // B1：账号层故障（device_revoked/account_banned）——零新增 SSH，复用已抓的
  // reclaude logs 与 state.json 原文识别；判到即视为 error 级（红），
  // 此前这类故障期间三层判定全绿，控制台无感。
  const accountFault = detectAccountFault(sections.logsOutput, sections.stateOutput);
  const health = classifyAgentHealth({ ...parsed, accountFault });
  const level = health === "ready"
    ? "ok"
    : (health === "missing" || health === "revoked" || health === "banned" ? "error" : "warn");
  // 凭证过期：复用已抓的 ~/.reclaude/state.json 原文，不额外发起 SSH 请求。
  const expiry = parseAgentExpiry({ kind: "reclaude", raw: sections.stateOutput, now: Date.now() });
  return {
    level,
    reason: `reclaude health=${health}`,
    data: {
      ok: health === "ready",
      health,
      accountFault,
      ...parsed,
      expiry,
      diagnosticLabel: "ReClaude 状态",
      endpointLabel: "Claude API",
      output: trimOutput([
        "$ reclaude version",
        sections.versionOutput,
        "$ reclaude status",
        sections.statusOutput,
        "$ test -s ~/.reclaude/device.json",
        parsed.loggedIn === true ? "device binding: present" : (parsed.loggedIn === false ? "device binding: missing" : "device binding: unknown"),
        "$ cat ~/.reclaude/state.json",
        sections.stateOutput,
        "$ reclaude logs",
        sections.logsOutput,
      ].join("\n")),
    },
  };
}

// Claude 端点探测的远端命令。不带口令时与一直以来的那条逐字相同（代理地址在环境变量里）；带口令（v2.62）时
// 改成 `-x 地址 -K -`，口令作为一行 curl 配置经标准输入送达，不进命令行。→ { command, input }
export function buildClaudeEndpointInvocation(remotePort, authority, credential = null) {
  const tail = `-s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 10 --max-time 15 https://${authority}/v1/models 2>&1`;
  const input = curlProxyAuthInput(credential);
  if (input === null) return { command: `HTTPS_PROXY=http://127.0.0.1:${remotePort} curl ${tail}`, input: null };
  return { command: `curl -x http://127.0.0.1:${remotePort} ${CURL_STDIN_CONFIG_FLAG} ${tail}`, input };
}

// Claude API 端到端连通性：经隧道代理 CONNECT api.anthropic.com。
// 200/401/403 都代表链路可达（401=无密钥，正是要验证的网络连通性）。
async function runClaudeEndpointProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  const target = resolveClaudeEndpointTarget(config);
  // 不带认证请求受 401/403/404/405 仍表示 CONNECT + TLS + 上游 HTTP 都已到达；
  // 这与原 claude-endpoint 的“验证链路而非凭证”语义一致，避免把正常未认证误报为红。
  const { command, input } = buildClaudeEndpointInvocation(main.remotePort, target.authority, ctx.getProxyCredential?.() ?? null);
  const { stdout, stderr, code } = await ctx.execFileCmd(
    "ssh",
    [...ctx.sshArgsFor(main, config), command],
    { timeoutMs: 18000, server: main, ...(input !== null ? { input } : {}) },
  );
  const match = (stdout || "").trim().match(/^(\d{3})\s+([\d.]+)/);
  const httpCode = match ? Number(match[1]) : 0;
  const latencyMs = match ? Math.round(parseFloat(match[2]) * 1000) : null;
  const ok = [200, 401, 403, 404, 405].includes(httpCode);
  return {
    level: ok ? "ok" : "error",
    reason: ok
      ? `Claude API ${target.authority} 可达 (HTTP ${httpCode}, ${latencyMs}ms)`
      : `Claude API ${target.authority} 探测未通过 (HTTP ${httpCode}, ${ctx.probeSshFailureReason(code, stderr, stdout)})`,
    data: {
      ok,
      target: target.authority,
      configuredTarget: target.configured,
      httpCode,
      latencyMs,
      output: trimOutput([
        `$ curl -x http://127.0.0.1:${main.remotePort} https://${target.authority}/v1/models`,
        `HTTP ${httpCode}  RTT ${latencyMs != null ? `${latencyMs}ms` : "n/a"}`,
        (stdout || "").trim(),
      ].join("\n")),
    },
  };
}

// 降级根因文案（前端 degradedReasonText 直接展示，严重优先：
// 端点探测失败 > gatewayOk=false > 兜底）。
function degradedReason(detail) {
  const ce = detail?.claudeEndpoint || null;
  if (ce && ce.ok === false) return "降级：Claude API 端点不可达";
  if (detail?.gatewayOk === false) return "降级：Gateway 探活失败";
  return "降级：ReClaude 链路异常";
}

function buildStatus(state) {
  const entry = buildClaudeAgentStatus(
    state.reclaudeData,
    state.claudeEndpointSkipped ? null : state.claudeEndpoint,
  );
  return {
    ...entry,
    degradedReason: entry.health === "degraded" ? degradedReason(entry) : null,
  };
}

export const reclaudeAdapter = {
  kind: "reclaude",
  agentId: "claude-codewing",
  probeIds: ["reclaude", "claude-endpoint"],
  moduleHint: {
    description: "ReClaude 守护进程、账号状态与 Claude API 端点检测",
    cost: "每 90 秒两次 SSH",
    disableWarning: "关闭后不再检测账号层故障（设备解绑 / 封禁），日志信号也不再扫描 ReClaude 日志",
  },

  // 探针定义（间隔与规格 3.2 表格一致）；layer/usesSsh/熔断门控由注册方统一补齐。
  probeSpecs(ctx) {
    return [
      { id: "reclaude", intervalMs: 90000, timeoutMs: 35000, run: () => runReclaudeProbe(ctx) },
      { id: "claude-endpoint", intervalMs: 90000, timeoutMs: 20000, run: () => runClaudeEndpointProbe(ctx) },
    ];
  },

  createInitialState() {
    return {
      // v2.3：Claude API 端点派生状态（结构对称于 endpoint），ok=null 表示尚未探测/熔断。
      claudeEndpoint: { ok: null, output: "检测中..." },
      claudeEndpointSkipped: false,
      reclaudeData: null, // 最近一次 reclaude 探针原始 data，用于与 claude-endpoint 综合
      reclaudeSkipped: false,
    };
  },

  onProbeResult({ id, result, state, helpers }) {
    const data = result.data || null;
    const patch = {};
    if (id === "reclaude") {
      if (result.level === "skipped") {
        state.reclaudeSkipped = true;
        patch.status = {
          ...helpers.getPreviousStatus(),
          ok: false,
          health: "degraded",
          output: BREAKER_RECLAUDE_OUTPUT,
        };
      } else {
        state.reclaudeSkipped = false;
        state.reclaudeData = data || { ok: false, health: "missing", installed: false, output: result.reason || "" };
        patch.expiry = state.reclaudeData.expiry || null;
        patch.status = buildStatus(state);
      }
    } else if (id === "claude-endpoint") {
      if (result.level === "skipped") {
        state.claudeEndpointSkipped = true;
        state.claudeEndpoint = { ok: null, output: BREAKER_ENDPOINT_OUTPUT };
      } else {
        state.claudeEndpointSkipped = false;
        state.claudeEndpoint = data || { ok: false, output: result.reason || "" };
      }
      if (state.reclaudeData && !state.reclaudeSkipped) patch.status = buildStatus(state);
    }
    return patch;
  },

  buildStatus,

  // claude-endpoint 熔断不计入 agent skipped（通道层问题只遮蔽 reclaude 主诊断）。
  isSkipped(state) {
    return state.reclaudeSkipped;
  },

  legacyFields(state) {
    return { claudeEndpoint: state.claudeEndpoint };
  },

  // B2：单独把 claudeEndpoint 也纳入聚合——此前只吃 codex endpoint，Claude 链路
  // 死时托盘仍绿；classifyHealth 内部已把单/双链路失败都收敛到 degraded，不会
  // 因此触发 down/全局 restart。
  healthInputs(state) {
    return { claudeEndpoint: state.claudeEndpoint };
  },
};
