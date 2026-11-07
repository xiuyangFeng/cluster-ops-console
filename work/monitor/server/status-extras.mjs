// /api/status 与 SSE lite 的顶层旁路字段（设计 §6.7）。
// 这些字段与 storage 同层合成、不进 state-store 的层级模型——它们都不参与任何健康推导，
// 塞进 layers 只会把探针状态机和"自动修复记了什么账"耦在一起。

import { existsSync, readFileSync } from "node:fs";

import { listEnabledServers } from "../lib/config-loader.mjs";
import { buildSetupCommand, createOnboardingAssessmentProbe } from "../lib/onboarding.mjs";
import { isPackagedApp } from "../lib/runtime-paths.mjs";
import { readSshConfigUser } from "../lib/ssh-config-user.mjs";
import { createStampedCache } from "../lib/stat-cache.mjs";

const AUTO_REPAIR_LAST_ACTIONS_IN_PAYLOAD = 5; // /api/status 里回显的最近自动动作条数

// 个人层 config.local.json 的 revision（文件不存在 / 读不出来 / 不是对象 → null；没有 revision 字段 → 0，
// 与 /api/servers、/api/config/personal 回显的口径一致）。按文件戳缓存：每次 status 只多一次 stat，
// 内容只在有人写个人层时才重读（原子写换 inode，戳必变）。
export function createPersonalRevisionReader({ localConfigPath, readFile = readFileSync, cache = createStampedCache() } = {}) {
  return function getPersonalRevision() {
    if (!localConfigPath) return null;
    try {
      return cache.get(`personal-revision:${localConfigPath}`, [localConfigPath], () => {
        try {
          const parsed = JSON.parse(readFile(localConfigPath, "utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
          const revision = Number(parsed.revision);
          return Number.isInteger(revision) && revision >= 0 ? revision : 0;
        } catch {
          return null;
        }
      });
    } catch {
      return null;
    }
  };
}

// router 的 getRuntimeExtras。W5 起的追加字段（旧字段不动）：
//   tunnelFailures —— { serverId: { code, nextAction, at } } 最近一次 SSH 失败归因；
//   onboarding     —— "needs-setup" | "partial" | "no-servers" | "ready"（首次运行引导卡）；
//   onboardingReason —— 引导判定的原因（v2.54：如 "missing-port" = 还没领反向端口），ready 时为 null；
//   platform       —— 后端进程平台（前端据此隐藏 win32 不支持的密码 SSH 等）；
//   packaged       —— 是否打包 .app（引导卡改指「服务器管理」）；
//   setupCommand   —— 能写到控制台实际个人层的向导命令；
//   clusterEnv     —— 查看中的团队服务器在集群上的受管 env.sh 指向哪个端口（lib/cluster-env-sync.mjs）：
//                     { serverId, state: "in-sync" | "drift" | "absent" | "unknown", envPort, expectedPort,
//                       checkedAt, error, lastSync }；不在检测范围（个人服务器等）或还没查过时为 null；
//   onboardingGuide —— App 内接入引导的摘要 { phase, dismissed, busy }（lib/onboarding-guide/service.mjs）；
//                     界面据此决定要不要自动打开引导页。未装配时为 null；
//   probeBackoff   —— 探针退避（v2.61，server/probe-backoff.mjs）：{ enabled, servers: { serverId:
//                     { since, nextProbeAt, failures, probing } } }，只列 SSH 连不上、探测已放慢的服务器；
//   personalRevision —— 个人层配置的版本号（v2.57）。切换查看的服务器 / Agent、开关监控模块、另一个窗口、
//                     命令行向导……都会让它 +1；配置浮层据此自动重读手里带版本号的数据，
//                     免得下一次保存撞上「配置已被修改」。
//   egressHealth   —— 出网健康（v2.65，lib/egress/egress-health.mjs）：{ mode, upstream, state, reason, check,
//                     failures: { windowMs, total, refused, timeout, rejected, other, last, topHosts }, checkedAt }。
//                     只读内存快照，请求里不发连接；未装配或取值抛错时为 null。
export function clusterEnvFor(clusterEnvSync, serverId) {
  if (!clusterEnvSync || !serverId) return null;
  try {
    const state = clusterEnvSync.getState(serverId);
    return state ? { serverId, ...state } : null;
  } catch {
    return null;
  }
}

export function egressHealthView(egressHealth) {
  if (!egressHealth) return null;
  try {
    return egressHealth.snapshot();
  } catch {
    return null;
  }
}

export function createRuntimeExtras({
  rootDir,
  localConfigPath,
  getMergedConfig,
  autoRepairPolicy,
  autoRepair,
  bridge,
  scheduler,
  clusterEnvSync = null,
  onboardingGuide = null,
  probeBackoff = null,
  egressHealth = null,
  teamAdminService = null,
}) {
  // W5 首次运行引导：个人层不存在 → onboarding:"needs-setup"（5s TTL，避免每次 status 都 stat）。
  const getOnboardingAssessment = createOnboardingAssessmentProbe({
    exists: () => existsSync(localConfigPath),
    getMerged: getMergedConfig,
    // 个人层没写 sshUser 时按 ~/.ssh/config 的 Host 别名解析 User（与 launch.mjs 同一判定）。
    resolveSshUser: (hostAlias) => readSshConfigUser(hostAlias),
  });
  // 引导卡文案用：打包 .app 引导去界面「服务器管理」；源码模式给出能写到正确个人层的向导命令。
  const packagedApp = isPackagedApp(rootDir);
  const setupCommand = buildSetupCommand({ localConfigPath, appRoot: rootDir });
  const getPersonalRevision = createPersonalRevisionReader({ localConfigPath });

  return function getRuntimeExtras() {
    const state = autoRepairPolicy.getState();
    const merged = getMergedConfig();
    const onboarding = getOnboardingAssessment();
    return {
      autoRepairExhausted: autoRepair.isExhausted(),
      tunnelPortForeign: bridge.getTunnelPortForeign(),
      tunnelFailures: bridge.getTunnelFailures(listEnabledServers(merged).map((srv) => srv?.id)),
      onboarding: onboarding.state,
      onboardingReason: onboarding.reason,
      onboardingGuide: onboardingGuide ? onboardingGuide.getBrief() : null,
      platform: process.platform,
      packaged: packagedApp,
      setupCommand,
      personalRevision: getPersonalRevision(),
      clusterEnv: clusterEnvFor(clusterEnvSync, merged?.activeServerId),
      probeBackoff: probeBackoff ? probeBackoff.getView() : null,
      egressHealth: egressHealthView(egressHealth),
      teamAdmin: teamAdminService ? teamAdminService.getAdminRole(merged) : null,
      autoRepair: {
        enabled: state.config.enabled,
        observeOnly: state.config.observeOnly,
        lastActions: state.lastActions.slice(-AUTO_REPAIR_LAST_ACTIONS_IN_PAYLOAD),
      },
      // T08 探针调度插桩：全局/每主机占用、排队、合并计数（有界聚合，无高基数标签）。
      schedulerMetrics: scheduler.getMetrics(),
    };
  };
}
