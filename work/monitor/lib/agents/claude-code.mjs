// 官方 Claude Code agent 适配器（v2.57 第 2 期）：claude-code 单探针（一次 SSH）+ agentsStatus 合成。
//
// 一次 SSH 跑 remote/cli-probe.sh 的 Claude 部分（CT_CLI_IDS=claude）：
//   安装    command -v claude（PATH 补 ~/.local/bin）→ 真实路径 → 安装形态（原生 / npm / 其它）；
//           PATH 里找不到时按固定清单再看几个只有交互 shell 才加进 PATH 的位置（nvm、npm 前缀、~/.claude/local……）
//   版本    按「真实路径 + mtime」读远端缓存，没变不再执行 `claude --version`（二进制约 250MB）
//   登录    只看本地凭证文件的存在性与类型（订阅 OAuth / API 凭证变量名 / apiKeyHelper），不读出密钥、
//           不执行 `claude auth status`（是否联网无法只读确认）
//   连通性  经本人反向端口 `curl -x http://127.0.0.1:<端口>` 打 api.anthropic.com（401/403/404/405 也算到达）
// 没领端口时 probes/register.mjs 统一跳过 Agent 探针（level:"skipped"，界面显示「未领取反向端口」），
// 不会拼出 :undefined 或借用别人的端口。
//
// 与 ReClaude 适配器的分工：reclaude 看 ReClaude 守护进程与账号层故障；本适配器看官方 Claude Code 本身。
// kai 的 Claude Code 由 reclaude 接管（settings.json 的 env 指向 ~/.reclaude/ca.pem），这里只在登录方式里
// 注明「经 ReClaude 代理」，不判降级。
//
// 判级：未安装 → not-installed（中性灰：组里很多人只用 codex 或只用 Claude，没装不是故障——探针结果
// level:"ok"、层级 skipped，不立案、不计入注意力 / 整体健康、不触发自动修复与通知）；装了但非交互 SSH 的
// PATH 里找不到（cli.offPath）→ degraded（黄，根因行说出装在哪——不是「未安装」，与 codex doctor 同一口径）；
// 已安装但未登录 → auth-required（黄）；已安装但端点不可达 → degraded（黄）；其余 ready。
// 不参与全局健康聚合（healthInputs 返回 {}）：与 codex endpoint 走同一条隧道，链路断了由通道层与
// codex 端点负责，不重复拉低全局状态、也绝不触发 down / 全局 restart。

import { trimOutput } from "../../monitor-core.mjs";
import { buildCliRemoteCommand, loadCliProbeScript, OFF_PATH_ADVICE, offPathSummary, parseCliScan } from "../cli/detect.mjs";
import { withProxyAuthPrelude } from "../egress/remote-proxy-auth.mjs";
import { toPort } from "../validators.mjs";
import { createSteadyInterval } from "./steady-interval.mjs";

export const CLAUDE_CODE_PROBE_ID = "claude-code";

const BREAKER_OUTPUT = "通道异常，已熔断跳过 Claude Code 检查";
export const NOT_INSTALLED_TEXT = "Claude Code 未安装（可在 配置 → 命令行工具 安装）";

const KIND_LABELS = { native: "原生安装", npm: "npm 全局", unknown: "非官方布局" };

function loggedInOf(login) {
  if (login === "none") return false;
  if (!login || login === "unknown") return null;
  return true;
}

function degradedReason(data) {
  if (data?.cli?.offPath) return `降级：已安装在 ${data.cli.offPath}，但非交互 SSH 的 PATH 里找不到`;
  if (data?.endpoint && data.endpoint.ok === false) return "降级：Anthropic API 经隧道不可达";
  return "降级：Claude Code 链路异常";
}

function buildStatus(state) {
  const data = state.last;
  if (!data) return { ok: false, health: "waiting", output: "检测中...", degradedReason: null };
  const cli = data.cli;
  let health = "ready";
  // 没装是中性的；装在只有交互 shell 才看得到的位置则要说出来（工作台的检查 / 安装 / 登录都用不上它）。
  if (!cli.installed) health = cli.offPath ? "degraded" : "not-installed";
  else if (cli.login === "none") health = "auth-required";
  else if (data.endpoint && data.endpoint.ok === false) health = "degraded";
  return {
    ok: health === "ready",
    health,
    installed: cli.installed,
    version: cli.version,
    kind: cli.kind,
    login: cli.login,
    loginDetail: cli.loginDetail,
    loggedIn: loggedInOf(cli.login),
    managedBy: cli.managedBy ?? null,
    // 只在「装了但不在非交互 PATH」时有值（前端详情据此给处理建议）。
    ...(!cli.installed && cli.offPath ? { offPath: cli.offPath } : {}),
    diagnosticLabel: "Claude Code 状态",
    endpointLabel: "Anthropic API",
    // 通用端点语义（前端 agentEndpointOk / agentLatencyMs 的 agentsStatus[id].endpoint 路径）。
    endpoint: data.endpoint
      ? { ok: data.endpoint.ok, latencyMs: data.endpoint.ok ? data.endpoint.latencyMs : null, httpCode: data.endpoint.httpCode, output: `HTTP ${data.endpoint.httpCode}` }
      : { ok: null, output: "" },
    output: data.output,
    degradedReason: health === "degraded" ? degradedReason(data) : null,
  };
}

function describe(cli, endpoint, port) {
  const install = cli.installed
    ? `${cli.version ? `Claude Code ${cli.version}` : "Claude Code（版本未知）"}${cli.kind ? ` · ${KIND_LABELS[cli.kind] || cli.kind}` : ""}`
    : cli.offPath
      ? `${offPathSummary("Claude Code", cli.offPath)}。\n${OFF_PATH_ADVICE}`
      : "未安装（~/.local/bin/claude 不存在；不是故障，可在 配置 → 命令行工具 安装）";
  const login = cli.login === "none" ? "未登录" : (cli.loginDetail || cli.login);
  return trimOutput([
    "$ command -v claude && claude --version  # 版本按真实路径+mtime 远端缓存",
    install,
    cli.installed && cli.path ? `路径: ${cli.path}` : "",
    cli.npmGlobal ? "注意：同时存在 npm 全局安装（Claude Code 会提示双安装）" : "",
    "$ 凭证文件存在性与类型（不读取密钥内容）",
    `登录: ${login}`,
    cli.managedBy === "reclaude" ? "settings.json 由 ReClaude 接管" : "",
    `$ curl -x http://127.0.0.1:${port} https://api.anthropic.com/v1/models`,
    endpoint ? `HTTP ${endpoint.httpCode}  RTT ${endpoint.latencyMs != null ? `${endpoint.latencyMs}ms` : "n/a"}` : "(未执行)",
  ].filter(Boolean).join("\n"));
}

async function runClaudeCodeProbe(ctx) {
  const config = await ctx.getConfig();
  const main = ctx.getMainServerConfig(config);
  const port = toPort(main.remotePort);
  const command = buildCliRemoteCommand({ ids: ["claude"], endpointPort: port });
  // 代理口令（v2.62）不是关时，口令作为脚本正文前面的一行赋值带过去（脚本经标准输入送达，命令行里没有它）；
  // 是关时标准输入就是脚本原文。
  const script = withProxyAuthPrelude(loadCliProbeScript(), ctx.getProxyCredential?.() ?? null);
  const invocation = { file: "ssh", args: [...ctx.sshArgsFor(main, config), command], input: script, timeoutMs: 40000 };
  const { stdout, stderr, code } = ctx.execCollector
    ? await ctx.execCollector(invocation, main)
    : await ctx.execFileCmd("ssh", invocation.args, { input: invocation.input, timeoutMs: invocation.timeoutMs, server: main });
  const scan = parseCliScan(stdout, ["claude"]);
  const cli = scan?.clis.claude;
  if (!cli) {
    // SSH 没到远端：data 置空，onProbeResult 保留上一轮事实（不把通道故障写成「未安装」）。
    return { level: "error", reason: `Claude Code 探测未完成 (${ctx.probeSshFailureReason(code, stderr, stdout)})`, data: null };
  }
  // 真没装才不报连通性；装在别处的人是在用 Claude Code 的，端点照常展示。
  const endpoint = cli.installed || cli.offPath ? scan.endpoint : null;
  const data = { cli, endpoint, output: describe(cli, endpoint, port) };
  const status = buildStatus({ last: data });
  // 未安装是中性事实：探针本身成功（level ok），不产生任何告警事实。
  const level = status.health === "ready" || status.health === "not-installed" ? "ok" : "warn";
  const reason = status.health === "not-installed"
    ? NOT_INSTALLED_TEXT
    : status.health === "auth-required"
      ? "Claude Code 未登录"
      : status.health === "degraded"
        ? (cli.offPath && !cli.installed ? offPathSummary("Claude Code", cli.offPath) : `Anthropic API 经隧道不可达（HTTP ${endpoint?.httpCode ?? 0}）`)
        : `Claude Code ${cli.version || "版本未知"} 就绪（${cli.loginDetail || cli.login}）`;
  return { level, reason, data };
}

export const claudeCodeAdapter = {
  kind: "claude-code",
  agentId: "claude-code",
  probeIds: [CLAUDE_CODE_PROBE_ID],
  moduleHint: {
    description: "官方 Claude Code 的安装、版本、登录方式与 Anthropic API 连通性",
    cost: "每 90 秒一次 SSH（稳态降到 5 分钟；版本走远端缓存）",
  },

  // 节奏与 codex doctor 同一套（steady-interval.mjs）：连续 3 轮 ok（就绪，或没装这种中性事实）后 5 分钟
  // 一轮；未登录 / 端点不可达 / SSH 失败 / 通道熔断都立即回 90 秒。本探针不参与全局健康聚合，链路断了有
  // 通道层与 codex 端点探针盯着，稳态下不必 90 秒问一次。
  probeSpecs(ctx) {
    return [
      { id: CLAUDE_CODE_PROBE_ID, intervalMs: createSteadyInterval(), timeoutMs: 45000, run: () => runClaudeCodeProbe(ctx) },
    ];
  },

  createInitialState() {
    return { last: null, skipped: false };
  },

  onProbeResult({ id, result, state, helpers }) {
    if (id !== CLAUDE_CODE_PROBE_ID) return {};
    if (result.level === "skipped") {
      state.skipped = true;
      return { status: { ...helpers.getPreviousStatus(), output: BREAKER_OUTPUT } };
    }
    state.skipped = false;
    if (!result.data) return {};
    state.last = result.data;
    return { status: buildStatus(state) };
  },

  buildStatus,

  isSkipped(state) {
    return state.skipped;
  },

  legacyFields() {
    return {};
  },

  healthInputs() {
    return {};
  },
};
