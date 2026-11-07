// Codex 客户端守护进程的「重启」动作（v2.85）：只在用户点按钮时发 SSH，不注册探针。
//
// 安全形状沿用远端守护进程面板（lib/daemons/）：
//   - 只对当前查看中的服务器（serverId 给了就必须等于活跃服务器）；
//   - 只对启用了 Codex 适配器的配置；请求里除了 serverId 没有别的字段能到远端；
//   - 同一时刻只允许一个重启；
//   - 远端命令是常量（app-server.mjs），不拼任何请求字符串；
//   - SSH 占调度器全局槽位。
// 与「启动」不同，这里真的会停掉旧的 Codex 守护进程：它持有的代理端口已经过期，正在跑的远程
// 会话本来就收不到回复。界面先让用户确认，并说明会中断当前远程会话；桌面端重连后会拉起新的
// 守护进程（或由这里的 daemon start 起一个托管的）。
import { trimOutput } from "../../monitor-core.mjs";
import { agentAdapterEnabled } from "./registry.mjs";
import { codexAdapter } from "./codex.mjs";
import {
  APP_SERVER_RECOVERY_COMMAND,
  APP_SERVER_RESTART_COMMAND,
  APP_SERVER_RESTART_TIMEOUT_MS,
  describeRestartResult,
  isUnmanagedRestartFailure,
} from "./app-server.mjs";
import { toPort } from "../validators.mjs";

const fail = (message, status) => Object.assign(new Error(message), { status });

export function createCodexAppServerService({
  getConfig,
  getMainServerConfig,
  sshArgsFor,
  execFileCmd,
  probeSshFailureReason,
  log = null,
  timeline = null,
  now = Date.now,
}) {
  let restarting = false;

  // 一次 SSH。永不 reject：组装参数 / exec 抛错都折成 { code: null, stderr }，由上面的失败归因处理。
  async function runRemote(server, config, command) {
    try {
      return (await execFileCmd("ssh", [...sshArgsFor(server, config), command], {
        timeoutMs: APP_SERVER_RESTART_TIMEOUT_MS,
        server,
      })) || { code: null, stdout: "", stderr: "" };
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error) };
    }
  }

  function failureReason(res) {
    if (res?.timedOut) return `SSH 未在 ${Math.round(APP_SERVER_RESTART_TIMEOUT_MS / 1000)} 秒内返回`;
    return probeSshFailureReason?.(res?.code ?? null, res?.stderr || "", res?.stdout || "") || `ssh exit ${res?.code ?? "未知"}`;
  }

  async function resolveTarget(serverId) {
    const config = await getConfig();
    const server = getMainServerConfig(config) || null;
    if (serverId != null && serverId !== server?.id) throw fail("只能操作当前查看中的服务器，请刷新页面", 409);
    if (!server || server.disabled === true || server.monitorEnabled === false) throw fail("当前查看的服务器不可操作", 404);
    if (!agentAdapterEnabled(codexAdapter, config)) throw fail("Codex 监控已关闭，不重启它的守护进程", 409);
    if (toPort(server.remotePort) === null) throw fail("还没领取反向端口：先运行 npm run setup 领取端口", 409);
    return { config, server };
  }

  // 返回 { ok, serverId, result: "restarted" | "recovered" | "failed", message, error, output, checkedAt }。
  async function restart({ serverId = null } = {}, { acquireSshSlot } = {}) {
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    if (restarting) throw fail("正在重启 Codex 客户端守护进程，请稍候", 409);
    const { config, server } = await resolveTarget(serverId);
    restarting = true;
    try {
      log?.(`codex app-server restart on ${server.id}: requested`, { level: "info", event: "codex-app-server" });
      const release = await acquireSshSlot({ hostKey: server.host });
      let first;
      let second = null;
      try {
        first = await runRemote(server, config, APP_SERVER_RESTART_COMMAND);
        const firstOutput = `${first?.stdout || ""}\n${first?.stderr || ""}`;
        if (first?.code !== 0 && isUnmanagedRestartFailure(firstOutput)) {
          second = await runRemote(server, config, APP_SERVER_RECOVERY_COMMAND);
        }
      } finally {
        release();
      }
      const last = second || first;
      const ok = last?.code === 0;
      const result = ok ? (second ? "recovered" : "restarted") : "failed";
      const error = ok ? null : failureReason(last);
      const message = ok ? describeRestartResult(result) : `${describeRestartResult(result)}：${error}`;
      const output = trimOutput(`${first?.stdout || ""}\n${first?.stderr || ""}${second ? `\n--- recovery ---\n${second.stdout || ""}\n${second.stderr || ""}` : ""}`.trim());
      const summary = `codex app-server restart on ${server.id}: ${result}${ok ? "" : ` (${error})`}`;
      log?.(summary, { level: ok ? "info" : "warn", event: "codex-app-server" });
      timeline?.(ok ? "info" : "warn", summary, { event: "codex-app-server-restart", serverId: server.id, result });
      return { ok, serverId: server.id, result, message, error, output, checkedAt: now() };
    } finally {
      restarting = false;
    }
  }

  return { restart, isRestarting: () => restarting };
}
