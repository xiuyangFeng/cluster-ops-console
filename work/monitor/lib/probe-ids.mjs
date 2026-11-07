// 探针 id 的单一事实源。调度器、状态仓、事件、路由按 id 字符串对接，前缀与固定 id
// 一律从这里取，不再各处手写字面量。
//   - collect:slow:<serverId>  每台未禁用服务器的慢采集（负载 / 磁盘 / GPU / Agent 安装态）
//   - validation:<serverId>    validationProfile 验证探针
//   - log-signals              活跃服务器的快采集（日志尾巴 / state.json / 反向端口）
//   - usage:<serverId>         团队服务器的 Agent 用量增量扫描
//   - jobs:<serverId>          团队服务器上「我的作业」（sacct 近 2 天，只读）

export const PROCESSES_PROBE_ID = "processes";
export const LOG_SIGNALS_PROBE_ID = "log-signals";
// codex（doctor / endpoint）与 reclaude（reclaude / claude-endpoint）的 agent 诊断探针。
// 刻意是封闭清单而不是"所有适配器探针"——新 agent（如 zcode）接入不自动加入。
export const AGENT_PROBE_IDS = ["doctor", "endpoint", "reclaude", "claude-endpoint"];
export const COLLECT_SLOW_PREFIX = "collect:slow:";
export const VALIDATION_PREFIX = "validation:";

export const collectSlowProbeId = (serverId) => `${COLLECT_SLOW_PREFIX}${serverId}`;
// usage:<serverId>  Agent 用量增量扫描（团队服务器；结果只进用量存储，不参与任何判级）
export const USAGE_PREFIX = "usage:";
export const usageProbeId = (serverId) => `${USAGE_PREFIX}${serverId}`;
// jobs:<serverId>  当前用户近 2 天 Slurm 作业（与 usage 同一采集范围；结果只进内存快照，不参与任何判级）
export const JOBS_PREFIX = "jobs:";
export const jobsProbeId = (serverId) => `${JOBS_PREFIX}${serverId}`;
// cli:<serverId>  官方 CLI 探测（lib/cli/；结果只进 CLI 服务的内存快照，不参与任何判级）
export const CLI_PREFIX = "cli:";
export const cliProbeId = (serverId) => `${CLI_PREFIX}${serverId}`;
export const validationProbeId = (serverId) => `${VALIDATION_PREFIX}${serverId}`;

function suffixAfter(prefix, probeId) {
  if (typeof probeId !== "string" || !probeId.startsWith(prefix)) return null;
  return probeId.slice(prefix.length) || null;
}

// "collect:slow:x" → "x"；不是该前缀或后缀为空 → null。
export const serverIdFromCollectSlow = (probeId) => suffixAfter(COLLECT_SLOW_PREFIX, probeId);
export const serverIdFromValidation = (probeId) => suffixAfter(VALIDATION_PREFIX, probeId);
export const serverIdFromUsage = (probeId) => suffixAfter(USAGE_PREFIX, probeId);
export const serverIdFromJobs = (probeId) => suffixAfter(JOBS_PREFIX, probeId);
export const serverIdFromCli = (probeId) => suffixAfter(CLI_PREFIX, probeId);

// 绑定到某台服务器的探针（慢采集 / 验证）→ serverId；其它探针 → null。
export function boundServerIdOf(probeId) {
  return serverIdFromCollectSlow(probeId) ?? serverIdFromValidation(probeId);
}
