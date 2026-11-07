// CLI 安装 / 更新 / 回滚 / 登录之后的「立即刷新」（v2.57 第 2 期）：安装业务层（经 routes/cli.mjs 的 runtime）
// 与登录服务（onLoginChanged）共用这一个入口，server/start.mjs 创建一次、两边注入。
//
// 刷什么：
//   - cli:<serverId> 探测（toolkit.cli.refresh：探针已注册走 scheduler.forceRun，否则直接扫一轮）——
//     Agent 卡片的版本 / 登录 / 「可更新到 x」与设置页「命令行工具」都读它；
//   - 成功时再补跑对应 Agent 适配器的探针：codex → doctor（codex 从未安装变已安装要靠 doctor 补跑，卡片才会
//     立刻离开「未安装」），Claude Code → claude-code。这两枚探针只看当前查看的服务器；没注册（Agent 被关掉）就跳过。
// 全部吞错：刷新失败不影响任务本身的结果，下一轮周期探测会补上。
import { CLAUDE_CODE_PROBE_ID } from "../agents/claude-code.mjs";

export const AGENT_PROBES_AFTER_CLI_CHANGE = Object.freeze({
  codex: Object.freeze(["doctor"]),
  claude: Object.freeze([CLAUDE_CODE_PROBE_ID]),
});

// cliProbe：toolkit.cli（{ refresh(serverId) }）；scheduler：{ isRegistered, forceRun }。
export function createCliChangeRefresher({ cliProbe = null, scheduler = null, log = null } = {}) {
  // ok=false（任务失败 / 取消）只重测 CLI 现状（可能已经装了一半或换了登录方式），不打扰 Agent 探针。
  return async function refreshAfterCliChange(serverId, { cli = null, ok = true } = {}) {
    const tasks = [];
    if (serverId && cliProbe?.refresh) tasks.push(Promise.resolve().then(() => cliProbe.refresh(serverId)));
    if (ok) {
      const probeIds = cli ? (AGENT_PROBES_AFTER_CLI_CHANGE[cli] || []) : Object.values(AGENT_PROBES_AFTER_CLI_CHANGE).flat();
      for (const probeId of probeIds) {
        if (scheduler?.isRegistered?.(probeId)) tasks.push(Promise.resolve().then(() => scheduler.forceRun(probeId)));
      }
    }
    const results = await Promise.allSettled(tasks);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed && log) log(`cli refresh after change on ${serverId}: ${failed} 项刷新失败（等下一轮周期探测）`, { level: "warn", event: "cli" });
  };
}
