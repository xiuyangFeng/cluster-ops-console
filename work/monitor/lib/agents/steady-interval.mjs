// Agent 诊断探针的自适应节奏：健康稳态降频，一有情况立即回快节奏。
//
// 这类探针每轮都是一次 SSH 加一段远端脚本（codex 的 `codex doctor` 全量自检；Claude Code 的安装 /
// 登录探测 + 经隧道的一次 curl），而工作台是每人一份、各自轮询同一个登录节点——稳态下没必要 90 秒一轮。
// 口径（v2.16 起 doctor 在用，v2.57 评审后 claude-code 并入同一套，不另立规则）：
//   · 连续 STEADY_AFTER_OK_STREAK 轮 ok → 之后每 STEADY_IDLE_INTERVAL_MS 一轮；
//   · 任何非 ok（warn / error / 超时 / 被通道熔断跳过的 skipped）→ 连击清零，立即回 STEADY_ACTIVE_INTERVAL_MS。
// 降频期间不会错过恢复：通道回到 ok 时 server/telemetry.mjs 的 registerRerunOnRecovery 对这些探针
// 插队补跑一次（STEADY_PROBE_IDS），安装 / 登录之后由 lib/cli/refresh.mjs 补跑，切换查看的 Agent 时
// routes/config.mjs 补跑。
//
// 用法：probeSpecs() 里 `intervalMs: createSteadyInterval()`。调度器每记录一次结果（周期轮、插队轮、
// 熔断跳过轮）调用一次，返回下一次的间隔；每次 createSteadyInterval() 是一份独立的连击计数，所以
// 已在册的适配器不能重复注册（probes/register.mjs 的 alreadyRegistered 就是为此）。

export const STEADY_ACTIVE_INTERVAL_MS = 90000;
export const STEADY_IDLE_INTERVAL_MS = 300000;
export const STEADY_AFTER_OK_STREAK = 3;

// 走这套节奏的探针 id（通道恢复时要插队补跑的那几枚）。新探针用了 createSteadyInterval 就登记在这里。
export const STEADY_PROBE_IDS = Object.freeze(["doctor", "claude-code"]);

export function createSteadyInterval() {
  let okStreak = 0;
  return (result) => {
    okStreak = result?.level === "ok" ? okStreak + 1 : 0;
    return okStreak >= STEADY_AFTER_OK_STREAK ? STEADY_IDLE_INTERVAL_MS : STEADY_ACTIVE_INTERVAL_MS;
  };
}
