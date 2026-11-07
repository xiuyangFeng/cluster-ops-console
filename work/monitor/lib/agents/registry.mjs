// Agent 适配器注册表：监控台接入一种 agent CLI（codex / reclaude / zcode / claude-code）
// 所需的全部差异点收敛为一个适配器对象，列入下方 ADAPTERS 即可让
// 探针注册（probes.mjs registerProbes）、状态合成（state-store onProbeUpdated）、
// 三层视图（state-store getLayers）与前端根因展示（detail.degradedReason）全链路生效。
//
// ---------------------------------------------------------------------------
// 适配器接口：
//
//   kind          string  适配器种类，与配置 agents[].kind 一一对应（如 "codex"）。
//   agentId       string  该适配器管理的默认 agent 配置 id（agentsStatus 的键；
//                         配置里存在同 kind 的 agent 条目时以该条目的 id 为准）。
//   probeIds      string[]  本适配器声明的探针 id 列表（静态，不依赖运行时 ctx）。
//                         state-store 用它做「探针 id → 适配器」分派与层级
//                         checkedAt 汇总，顺序即 relatedResults 的取数顺序。
//   probeSpecs(ctx)       返回探针定义数组，每项 { id, intervalMs, timeoutMs, run }。
//                         layer:"agents" / usesSsh:true / 熔断门控 enabled 由
//                         registerProbes 统一补齐（探针自身无需关心通道熔断）。
//                         ctx 由 probes.mjs 提供：
//                           getConfig()            → Promise<config>
//                           getMainServerConfig(config) → 活动服务器条目
//                           execFileCmd(cmd, args, opts) → { stdout, stderr, code }
//                           sshArgsFor(server, config)   → 探针 SSH 参数数组
//                           probeSshFailureReason(code, stderr, stdout) → 失败文案
//   createInitialState()  返回适配器私有的可变归并状态（state-store 每 kind 持有
//                         一份），初始值须与「检测中...」首屏语义一致。
//   onProbeResult({ id, result, state, helpers })
//                         归并一次探针结果（含 level:"skipped" 熔断轮）。可变更
//                         state，并返回 patch 对象：
//                           { status?: agentsStatus 条目, expiry?: 凭证过期信息 }
//                         键不存在表示「本轮不触碰对应存量值」（熔断轮不覆盖
//                         expiry 即靠此语义）。helpers 由 state-store 提供：
//                           getPreviousStatus()      → 当前 agentsStatus 条目
//                           getBridgeStage(stage)    → bridgeStages 快照
//                           ingestBridgeStage(snap)  → 写入桥接阶段
//                           now()                    → 毫秒时钟
//   buildStatus(state)    由归并状态合成 agentsStatus 条目（纯函数）。输出在既有
//                         形状上追加 degradedReason 字段（health!=="degraded" 时为
//                         null），供前端第一行根因直用。
//   isSkipped(state)      该 agent 当前是否处于熔断跳过（决定层级 level:"skipped"）。
//   legacyFields(state)   返回合入 getLegacyStatus 顶层的旧字段片段（如 codex 的
//                         { doctor, endpoint }）。无旧字段的新适配器返回 {}。
//   healthInputs(state)   返回合入 classifyHealth 入参的片段（如 { endpoint }）。
//                         不参与全局健康聚合的新适配器返回 {}。
//   moduleHint    { description, cost, disableWarning? }：设置页「监控模块」开关旁的
//                 说明、采集代价与关闭警示（lib/modules/catalog.mjs 读取）。
//
// 启用门控（agentAdapterEnabled）：当且仅当运行配置 agents[]（已按个人层
// disabledModules 过滤，见 lib/modules/catalog.mjs applyModulePreferences）里有
// 条目映射到该适配器时启用。启用决定 registerAgentProbes 是否注册其探针、
// state-store 是否合成其状态/健康聚合/旧字段。codex/reclaude 由 normalizeAgentConfig
// 默认物化，故默认启用；zcode / claude-code 需团队配置写入条目。v2.57 起团队条目可写
// defaultEnabled:false（团队默认关，个人层 enabledModules 打开），判定仍在 applyModulePreferences。
//
// 列入即生效：probes.mjs 按列表序注册各适配器探针，state-store 按 probeIds
// 反查归并归属，前端无需改动即可获得新 agent 的通用文案与根因行。
// ---------------------------------------------------------------------------

import { claudeCodeAdapter } from "./claude-code.mjs";
import { codexAdapter } from "./codex.mjs";
import { reclaudeAdapter } from "./reclaude.mjs";
import { zcodeAdapter } from "./zcode.mjs";

// 内置适配器：列表序决定探针注册顺序与 getLegacyStatus 旧字段键序
// （doctor/endpoint 在 claudeEndpoint 之前），与 v1.5.2 逐字节一致。
// zcode 追加在末尾且按配置门控（isEnabled），默认配置下探针/状态零足迹。
// claude-code（v2.57，官方 Claude Code）同样追加在末尾：不改动既有探针注册序与旧字段键序；
// 卡片展示顺序跟随配置 agents[] 的顺序，与此无关。
const ADAPTERS = Object.freeze([codexAdapter, reclaudeAdapter, zcodeAdapter, claudeCodeAdapter]);
const adapterByProbeId = new Map(ADAPTERS.flatMap((adapter) => adapter.probeIds.map((id) => [id, adapter])));

export function listAgentAdapters() {
  return ADAPTERS;
}

// 探针 id → 所属适配器（非 agent 探针返回 null）。
export function adapterForProbeId(probeId) {
  return adapterByProbeId.get(probeId) || null;
}

// 适配器在给定配置下是否启用：运行配置 agents[] 中存在映射到它的条目。
// 探针注册（registerAgentProbes）与 state-store（状态合成）共用此判定。
// 配置没有 agents 数组（未经归一化的替身配置）时按 normalizeAgentConfig 的默认物化
// 口径处理：codex / reclaude 启用。
const DEFAULT_AGENTS = Object.freeze([{ id: "codex", kind: "codex" }, { id: "claude-codewing", kind: "reclaude" }]);

function configAgents(config) {
  return Array.isArray(config?.agents) ? config.agents : DEFAULT_AGENTS;
}

export function agentAdapterEnabled(adapter, config) {
  if (!adapter) return false;
  return configAgents(config).some((agent) => adapterForAgent(agent) === adapter);
}

// 启用适配器 → 其配置 agentId（配置条目 id 优先，缺省回落适配器默认 agentId）。
export function agentIdForAdapter(adapter, config) {
  const entry = configAgents(config).find((agent) => adapterForAgent(agent) === adapter);
  return entry?.id || adapter?.agentId || null;
}

// 启用适配器声明的全部探针 id（替代旧的静态 AGENT_PROBE_IDS 封闭清单）。
export function enabledAgentProbeIds(config) {
  return ADAPTERS.filter((adapter) => agentAdapterEnabled(adapter, config)).flatMap((adapter) => adapter.probeIds);
}

// 配置 agent 条目 → 适配器：优先按 kind，其次按默认 agentId 兜底
// （旧配置可能缺 kind 字段，此时沿用 v1.5.2 的按 id 分派语义）。
export function adapterForAgent(agent) {
  if (!agent) return null;
  return (agent.kind && ADAPTERS.find((adapter) => adapter.kind === agent.kind))
    || ADAPTERS.find((adapter) => adapter.agentId === agent.id)
    || null;
}
