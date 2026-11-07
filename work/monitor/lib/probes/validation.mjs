import { applyValidationPort } from "../config-loader.mjs";
import { curlWithProxyAuth } from "../egress/remote-proxy-auth.mjs";
import { toPort } from "../validators.mjs";

// validationProfile 验证探针：对活跃服务器串行跑团队档案里声明的几项远端命令
// （remoteProxyTest / agentVersionCommands 各项 / workspaceSmokeCommand）。

// 验证探针串行执行多项测试：单项超时须远小于探针整体超时，
// 否则一项挂起会连累整轮结果被调度器以 timeout 丢弃。
export const VALIDATION_ITEM_TIMEOUT_MS = 10000;
export const VALIDATION_INTERVAL_MS = 300000;
const VALIDATION_OUTPUT_LIMIT = 512;

// 整体超时 = 串行单项预算之和 + 调度余量，保证慢网络下已完成项不被整轮 timeout 丢弃。
export function validationTimeoutMs(profile) {
  return validationSteps(profile || {}).length * VALIDATION_ITEM_TIMEOUT_MS + 5000;
}

// 只给活跃服务器注册；禁用 / 仅监控 / 无档案 / 个人服务器（档案是团队下发的远端命令，
// 不得套到个人机器上）一律不注册。
export function shouldRegisterValidation(server, activeServerId) {
  return !(server.disabled === true || server.tunnel === false || server.id !== activeServerId
    || !server.validationProfile || server.source === "personal");
}

// 项目按档案声明顺序展开成 [key, 命令] 列表。
function validationSteps(profile) {
  const steps = [];
  if (profile.remoteProxyTest) steps.push(["remoteProxyTest", profile.remoteProxyTest]);
  if (profile.agentVersionCommands) {
    for (const [agentId, cmd] of Object.entries(profile.agentVersionCommands)) steps.push([`agentVersion:${agentId}`, cmd]);
  }
  if (profile.workspaceSmokeCommand) steps.push(["workspaceSmokeCommand", profile.workspaceSmokeCommand]);
  return steps;
}

// 跳过项（如没领端口时的 remoteProxyTest）：ok 为 null、带 skipped 原因，不算通过也不算失败。
export const VALIDATION_SKIP_MISSING_PORT = "missing-port";
export const VALIDATION_SKIP_AGENT_DISABLED = "agent-disabled";

function summarizeItems(items) {
  const executed = items.filter((i) => !i.skipped);
  const skippedCount = items.length - executed.length;
  const skippedText = skippedCount > 0 ? `，跳过 ${skippedCount} 项` : "";
  if (executed.length === 0) {
    return { level: "ok", reason: `未执行任何验证项${skippedText}`, data: { items } };
  }
  const failedCount = executed.filter((i) => !i.ok).length;
  let level = "ok";
  if (failedCount === executed.length) {
    level = "error";
  } else if (failedCount > 0) {
    level = "warn";
  }
  return {
    level,
    reason: `已验证 ${executed.length} 项，失败 ${failedCount} 项${skippedText}`,
    data: { items },
  };
}

// getProxyCredential（v2.62 代理口令）：() → { user, password } | null。口令不是关时，经隧道出网的那一项
// （remoteProxyTest）要带上口令——命令行照旧只有 `-x http://127.0.0.1:<端口>`，另加 `-K -`，口令经标准输入
// 交给 curl（集群上别人用 ps 看得到命令行）。只认团队档案里那种 curl 写法；认不出的命令原样执行。
// 口令是关（缺省）时每一条命令都与以前逐字相同、不开标准输入。
export function createValidationProbe({ getConfig, execFileCmd, sshArgsFor, getProxyCredential = () => null }) {
  async function runSingleTest(server, config, key, cmd) {
    const start = Date.now();
    const authed = key === "remoteProxyTest"
      ? curlWithProxyAuth(cmd, { port: server.remotePort, credential: getProxyCredential() })
      : { command: cmd, input: null };
    // 非交互 SSH 不加载登录 shell，默认 PATH 缺 ~/.local/bin（codex/reclaude 安装位置），
    // 与 doctor/reclaude 探针的 PATH 前缀保持一致。
    const remoteCmd = `export PATH="$HOME/.local/bin:$PATH"; ${authed.command}`;
    const res = await execFileCmd("ssh", [...sshArgsFor(server, config), remoteCmd], { timeoutMs: VALIDATION_ITEM_TIMEOUT_MS, server, ...(authed.input !== null ? { input: authed.input } : {}) });
    const durationMs = Date.now() - start;
    const output = (res.stdout || res.stderr || "").trim();
    const truncatedOutput = output.length > VALIDATION_OUTPUT_LIMIT ? `${output.slice(0, VALIDATION_OUTPUT_LIMIT)}...` : output;
    return { key, ok: res.code === 0, durationMs, output: truncatedOutput };
  }

  async function runValidationProbe(serverId) {
    const config = await getConfig();
    const server = (config.servers || []).find((s) => s.id === serverId);
    if (!server?.validationProfile) {
      return { level: "error", reason: "未配置验证档案", data: null };
    }
    if (server.disabled === true || server.tunnel === false) return { level: "skipped", reason: "服务器未启用通道验证", data: null };
    if (server.source === "personal") {
      return { level: "ok", reason: "个人服务器不执行自定义验证档案", data: { items: [], skipped: "personal-profile-blocked" } };
    }
    // 校验档案里的 remoteProxyTest 端口占位符 {{remotePort}}，替换为本用户合并后的
    // server.remotePort（portOverrides 里登记领到的个人端口）。还没领端口时这一项不跑：
    // 占位符替换不了，跑出去就是 `-x http://127.0.0.1:{{remotePort}}`；标"未领取端口"而不是失败。
    const hasPort = toPort(server.remotePort) !== null;
    const profile = applyValidationPort(server.validationProfile, server.remotePort);
    const items = [];
    // v2.57：reclaude / zcode 团队默认关——设置页关着的 Agent 不跑它的版本命令（没装就会恒失败）。
    // 只认 agentCatalog 里明确关着的 id；档案里对不上任何 Agent 的键照旧执行。
    const disabledAgentIds = new Set((config.agentCatalog || []).filter((agent) => agent?.enabled === false).map((agent) => agent.id));
    for (const [key, cmd] of validationSteps(profile)) {
      if (key === "remoteProxyTest" && !hasPort) {
        items.push({ key, ok: null, skipped: VALIDATION_SKIP_MISSING_PORT, durationMs: 0, output: "未领取反向端口，跳过经隧道出网测试" });
        continue;
      }
      if (key.startsWith("agentVersion:") && disabledAgentIds.has(key.slice("agentVersion:".length))) {
        items.push({ key, ok: null, skipped: VALIDATION_SKIP_AGENT_DISABLED, durationMs: 0, output: "该 Agent 的监控模块未开启，跳过版本检查" });
        continue;
      }
      items.push(await runSingleTest(server, config, key, cmd));
    }
    return summarizeItems(items);
  }

  return { runValidationProbe };
}
