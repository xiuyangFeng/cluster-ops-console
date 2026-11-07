// 接入引导「写集群侧受管配置」：命令行向导 scripts/setup/routing.mjs#configureClusterEnv 的非交互版。
// 步骤与命令全部来自 lib/cluster-env.mjs 的纯函数（两条路写出来的东西逐字相同），这里只负责
// 经 App 的 SSH 入口执行、把结果整理成界面能直接展示的形状；要不要注释散落的旧导出由调用方问用户。
//
// 顺序与向导一致：env.sh 与两处引入块都落地之后，才去碰散落的旧导出——反过来的话中途失败，
// 新开的 shell 会一个代理变量都没有。
import {
  buildClusterEnvSteps,
  buildCommentOutCommand,
  buildStrayScanCommand,
  CLAUDE_SETTINGS_READ_COMMAND,
  groupStraysByFile,
  parseStrayProxyExports,
  planClaudeSettingsMerge,
  STRAY_SCAN_DONE,
} from "../cluster-env.mjs";

const SSH_WRITE_TIMEOUT_MS = 20000;
const SSH_READ_TIMEOUT_MS = 15000;

const sshDetail = (res) => String(res?.stderr || "").trim().split("\n").at(-1) || `退出码 ${res?.code ?? "未知"}`;

// runRemote(command, { timeoutMs, input }) → { code, stdout, stderr }；调用方已绑定服务器并处理 SSH 槽位。
export function createClusterEnvApplier({ runRemote }) {
  const remote = async (command, options) => {
    try {
      return await runRemote(command, options);
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error) };
    }
  };

  // 写 env.sh + 两处引入块 + 清理旧向导的块。→ { ok, steps: [{ id, ok }], failed: { id, title, detail, manual } | null }
  // credential（v2.62 代理口令）：集群上原来的 env.sh 带着口令时由调用方传入，重写时照着带上——带口令的那一步
  // 多一个 input（全文经标准输入送达，口令不进命令行）。不传时与以前逐字相同。
  async function write({ port, noProxyExtra = [], credential = null }) {
    const steps = [];
    for (const step of buildClusterEnvSteps({ port, noProxyExtra, ...(credential ? { credential } : {}) })) {
      const res = await remote(step.command, { timeoutMs: SSH_WRITE_TIMEOUT_MS, ...(step.input != null ? { input: step.input } : {}) });
      const ok = res?.code === 0;
      steps.push({ id: step.id, ok });
      if (!ok && step.required) {
        return { ok: false, steps, failed: { id: step.id, title: step.title, detail: sshDetail(res), manual: step.manual } };
      }
    }
    return { ok: true, steps, failed: null };
  }

  // 只读：受管块以外的 *_proxy 导出。→ { status: "none" | "found" | "scan-failed", items: [{ file, line, text }] }
  async function scanStrays() {
    const scan = await remote(buildStrayScanCommand(), { timeoutMs: SSH_READ_TIMEOUT_MS });
    if (scan?.code !== 0 || !String(scan.stdout || "").includes(STRAY_SCAN_DONE)) return { status: "scan-failed", items: [] };
    const items = parseStrayProxyExports(scan.stdout);
    return { status: items.length ? "found" : "none", items };
  }

  // 逐文件注释掉（先备份）。→ { status: "commented" | "partial", failedFiles: string[] }
  async function commentStrays(items) {
    const failedFiles = [];
    for (const group of groupStraysByFile(items)) {
      const res = await remote(buildCommentOutCommand(group.file, group.lines), { timeoutMs: SSH_WRITE_TIMEOUT_MS });
      if (res?.code !== 0) failedFiles.push(group.file);
    }
    return { status: failedFiles.length ? "partial" : "commented", failedFiles };
  }

  // Claude Code：集群上有 claude 且不是 reclaude 接管时，把代理键合并进 ~/.claude/settings.json 的 env。
  // → { action: "written" | "unchanged" | "skip" | "failed", reason, changedKeys }
  async function syncClaudeSettings({ port, noProxyExtra = [], credential = null }) {
    const read = await remote(CLAUDE_SETTINGS_READ_COMMAND, { timeoutMs: SSH_READ_TIMEOUT_MS });
    if (read?.code !== 0) return { action: "failed", reason: "unreadable", changedKeys: [] };
    const plan = planClaudeSettingsMerge(read.stdout, { port, noProxyExtra, ...(credential ? { credential } : {}) });
    if (plan.action === "error") return { action: "failed", reason: plan.reason ?? "unreadable", changedKeys: [] };
    if (plan.action === "skip" || plan.action === "unchanged") return { action: plan.action, reason: plan.reason ?? null, changedKeys: [] };
    const res = await remote(plan.command, { input: plan.input, timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.code !== 0) return { action: "failed", reason: sshDetail(res), changedKeys: plan.changedKeys || [] };
    return { action: "written", reason: null, changedKeys: plan.changedKeys || [] };
  }

  return { write, scanStrays, commentStrays, syncClaudeSettings };
}
