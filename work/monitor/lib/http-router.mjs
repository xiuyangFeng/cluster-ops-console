// HTTP 层门面：鉴权接线 + operation 上下文 + 按序分派到各路由组 + 404 / 500 兜底。
// 具体路由在 lib/http/routes/<组>.mjs（每组一个文件，互不依赖），读写基础件在
// lib/http/{io,static,status-payload,sse}.mjs。所有内核组件与通道操作经依赖注入传入，
// 模块顶层无副作用；组装入口（monitor-server.mjs）创建后把 handleHttpRequest 挂到
// node:http server 上。
import { createDiskDetailProvider } from "./disk-growth/detail.mjs";
import { authorizeRequest } from "./http-auth.mjs";
import { sendJson, sendNotFound } from "./http/io.mjs";
import { firstMatch } from "./http/route-kit.mjs";
import { createAutostartRoutes } from "./http/routes/autostart.mjs";
import { createBootstrapRoutes } from "./http/routes/bootstrap.mjs";
import { createBriefRoutes } from "./http/routes/brief.mjs";
import { createChannelRoutes } from "./http/routes/channel.mjs";
import { createCliRoutes } from "./http/routes/cli.mjs";
import { createCliLoginRoutes } from "./http/routes/cli-login.mjs";
import { createCodexAppServerRoutes } from "./http/routes/codex-app-server.mjs";
import { createConfigRoutes } from "./http/routes/config.mjs";
import { createConfigTransferRoutes } from "./http/routes/config-transfer.mjs";
import { createDaemonsRoutes } from "./http/routes/daemons.mjs";
import { createDataPlaneRoutes } from "./http/routes/data-plane.mjs";
import { createDiagnosticsRoutes } from "./http/routes/diagnostics.mjs";
import { createSelfUpdateRoutes } from "./http/routes/self-update.mjs";
import { createDirUsageRoutes } from "./http/routes/dir-usage.mjs";
import { createDiskGrowthRoutes } from "./http/routes/disk-growth.mjs";
import { createEgressRoutes } from "./http/routes/egress.mjs";
import { createHistoryRoutes } from "./http/routes/history.mjs";
import { createIncidentRoutes } from "./http/routes/incidents.mjs";
import { queryLogs } from "./logger.mjs";
import { createJobsRoutes } from "./http/routes/jobs.mjs";
import { createJobsLookupRoutes } from "./http/routes/jobs-lookup.mjs";
import { createLocalResourceRoutes } from "./http/routes/local-resources.mjs";
import { createLogRoutes } from "./http/routes/logs.mjs";
import { createMetricsRoutes } from "./http/routes/metrics.mjs";
import { createOnboardingRoutes } from "./http/routes/onboarding.mjs";
import { createOnboardingAccessRoutes } from "./http/routes/onboarding-access.mjs";
import { createOperationRoutes } from "./http/routes/operations.mjs";
import { createProbeRoutes } from "./http/routes/probes.mjs";
import { createReportRoutes } from "./http/routes/reports.mjs";
import { createServerRoutes } from "./http/routes/servers.mjs";
import { createStaticRoutes } from "./http/routes/static.mjs";
import { createStatusRoutes } from "./http/routes/status.mjs";
import { createStorageRoutes } from "./http/routes/storage.mjs";
import { createStorageAdminRoutes } from "./http/routes/storage-admin.mjs";
import { createTeamAdminRoutes } from "./http/routes/team-admin.mjs";
import { createTunnelRoutes } from "./http/routes/tunnels.mjs";
import { createUsageRoutes } from "./http/routes/usage.mjs";
import { createSseHub } from "./http/sse.mjs";
import { createStatusPayload } from "./http/status-payload.mjs";
import { normalizeOperationId } from "./operation-context.mjs";

export function createHttpRouter({
  authToken,
  version,
  publicDir,
  logsDir,
  ndjsonTailLines,
  maxSseConnections,
  sseHeartbeatMs,
  store,
  scheduler,
  metricsStore,
  historyStore,
  storageSweeper,
  getRuntimeExtras,
  bootstrapRunner,
  toolkit,
  appendLog,
  operationStorage,
  getConfig,
  setActiveServerConfig,
  setActiveAgentConfig,
  setModuleEnabled,
  setHiddenPanels,
  savePersonalConfig,
  refreshConfigIntoKernel,
  startChannel,
  stopChannel,
  // v2.18：手动重启也走 lifecycle 的 restartChannel。
  restartChannel,
  // 以下依赖由唯一的生产装配处（server/start.mjs）全部注入：operationsRunner（T04b 单隧道
  // 操作）、incidentStore（T07 事件）、getBuildInfo（T05）、dataPlaneUpgrader（热更新数据面
  // 交接）、getPersonalConfig（GET 个人层）、serverRegistry、localResourceProbe；
  // getConnectionTargets（T01）/ getRuntimeExtras / storageSweeper 取值失败时 /api/status
  // 不含对应字段。
  getConnectionTargets,
  operationsRunner,
  incidentStore,
  getBuildInfo,
  dataPlaneUpgrader,
  getPersonalConfig,
  serverRegistry,
  localResourceProbe,
  // 断线账本统计（GET /api/tunnel-stability）；缺失时该接口 503。
  tunnelStability = null,
  // 今日简报（GET /api/brief、/api/brief/days）；缺失时 503。
  briefService = null,
  // 本机出网（GET/POST /api/egress*，v2.54）；缺失时 503。
  egressService = null,
  // 集群 CLI 登录（/api/cli/:cli/login*、/api/cli/login/*，v2.57）；缺失时 503。
  cliLoginService = null,
  // 集群侧受管配置同步（POST /api/servers/:id/sync-cluster-env）；缺失时该动作 503。
  clusterEnvSync = null,
  // CLI 安装 / 回滚结束后的刷新（lib/cli/refresh.mjs，与登录服务的 onLoginChanged 同一个函数）；
  // 缺省时 routes/cli.mjs 只补跑 cli:<serverId> 探针。
  onCliChanged = null,
  // 自更新（/api/self-update*，v2.59）；缺失时 503。requestRestart：网页模式下让监控服务以约定退出码结束。
  selfUpdate = null,
  requestRestart = null,
  // 登录电脑后自动启动（GET / POST /api/autostart，v2.62）；缺失时 503。
  autostart = null,
  // App 内接入引导（/api/onboarding*）；缺失时 503。
  onboardingGuide = null,
  // 接入管理（/api/onboarding/access*：名下的端口登记、撤销接入）；缺失时 503。
  accessManager = null,
  // 工作台自己的诊断（/api/diagnostics/*，v2.64：导出诊断包、页面脚本错误上报）；缺失时 503。
  diagnostics = null,
  // 配置的备份与迁移（/api/config/transfer、/api/config/export、/api/config/import*，v2.64）；缺失时 503。
  configTransfer = null,
  // 团队管理与成员同步（/api/team/*）；缺失时 503。
  teamAdminService = null,
  memberSync = null,
  // 管理员存储视图（/api/storage-admin*）；缺失时 503。
  storageAdmin = null,
}) {
  const statusPayload = createStatusPayload({ store, version, storageSweeper, getRuntimeExtras, getConnectionTargets });
  const { getStatusPayload } = statusPayload;
  const sseHub = createSseHub({ maxConnections: maxSseConnections, heartbeatMs: sseHeartbeatMs, statusPayload });
  // 磁盘告警处的那句话（作业目录的增长 + 简报同一份「几天写满」）：/api/disk-growth 与未解决的磁盘事件共用。
  const describeDisk = createDiskDetailProvider({ diskGrowthService: toolkit?.diskGrowth ?? null, briefService });

  // 路由组按此顺序逐个尝试，第一个接住的组写响应。各组路径互不重叠，顺序沿用拆分前
  // routeRequest 的 if 链（仅把同一组的路由挪到了一起）。注意 /api/servers/:id 会先读完
  // 正文再判定方法/动作是否存在，落空时正文已被消费——其后没有任何组处理这些路径。
  const routes = firstMatch(
    createStaticRoutes({ publicDir }),
    createStatusRoutes({ authToken, store, getBuildInfo, getStatusPayload, sseHub }),
    createLogRoutes({ logsDir, ndjsonTailLines }),
    createMetricsRoutes({ metricsStore, historyStore }),
    createHistoryRoutes({ historyStore }),
    createProbeRoutes({ scheduler, appendLog }),
    createBootstrapRoutes({ bootstrapRunner, appendLog }),
    createConfigRoutes({
      getConfig,
      getPersonalConfig,
      savePersonalConfig,
      setActiveServerConfig,
      setActiveAgentConfig,
      setModuleEnabled,
      setHiddenPanels,
      refreshConfigIntoKernel,
      scheduler,
      toolkit,
    }),
    createConfigTransferRoutes({ configTransfer }),
    createEgressRoutes({ egressService }),
    createOnboardingRoutes({ onboardingGuide, accessManager }),
    createOnboardingAccessRoutes({ accessManager }),
    createTeamAdminRoutes({ teamAdminService, memberSync }),
    createStorageAdminRoutes({ storageAdmin }),
    // /api/cli*：登录组必须先于安装组（/api/cli/:cli/login*、/api/cli/login/* 先被认领），安装组只认
    // GET /api/cli、install / rollback / jobs；两组路径互不重叠（routes.cli-order 测试锁死）。
    createCliLoginRoutes({ cliLoginService }),
    createCliRoutes({ cliService: toolkit?.cliInstall ?? null, cliProbe: toolkit?.cli ?? null, scheduler, onCliChanged }),
    createServerRoutes({ serverRegistry, scheduler, clusterEnvSync }),
    createLocalResourceRoutes({ localResourceProbe }),
    createStorageRoutes({ storageSweeper, appendLog }),
    createUsageRoutes({ usageService: toolkit?.usage ?? null, getConfig }),
    createJobsRoutes({ jobsService: toolkit?.jobs ?? null, getConfig, acquireSshSlot: scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null }),
    createDirUsageRoutes({ dirUsageService: toolkit?.dirUsage ?? null, scheduler }),
    createDiskGrowthRoutes({ diskGrowthService: toolkit?.diskGrowth ?? null, describeDisk, scheduler }),
    createDaemonsRoutes({ daemonsService: toolkit?.daemons ?? null, getConfig, scheduler }),
    createCodexAppServerRoutes({ codexAppServer: toolkit?.codexAppServer ?? null, scheduler }),
    createJobsLookupRoutes({ jobsService: toolkit?.jobs ?? null, getConfig, acquireSshSlot: scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null }),
    createReportRoutes({ jobsService: toolkit?.jobs ?? null, getConfig, incidentStore, tunnelStability, logsDir, version }),
    createDiagnosticsRoutes({ diagnostics, getStatusPayload }),
    createTunnelRoutes({ tunnelStability }),
    createBriefRoutes({ briefService }),
    createDataPlaneRoutes({ dataPlaneUpgrader, appendLog }),
    createSelfUpdateRoutes({ selfUpdate, requestRestart, appendLog }),
    createAutostartRoutes({ autostart, appendLog }),
    createChannelRoutes({ startChannel, stopChannel, restartChannel, dataPlaneUpgrader, getStatusPayload }),
    createOperationRoutes({ operationsRunner }),
    createIncidentRoutes({
      incidentStore, describeDisk, queryLogs,
      loadLedger: tunnelStability ? () => tunnelStability.loadEvents() : null,
      readHistoryDay: historyStore ? (day) => historyStore.readDay(day) : null,
    }),
  );

  // 鉴权 + Origin/Host 校验（C3 + 读接口收口，详见 authorizeRequest 契约注释）：
  // 所有 /api/*（含读）强制 Host 本地、Origin 缺失/"null"/本地；authToken 已配置时除
  // /api/session 外的 /api/* 读接口也要求有效 token。token 除了 x-auth-token 头，
  // 也接受 ?token= 查询参数（供 EventSource 等无法自定义 header 的场景使用）。
  function authorize({ req, res, url }) {
    const reqToken = req.headers["x-auth-token"] || url.searchParams.get("token") || "";
    const authResult = authorizeRequest({
      method: req.method,
      path: url.pathname,
      headers: { ...req.headers, "x-auth-token": reqToken },
      authToken,
    });
    if (authResult.ok) return true;
    appendLog(`unauthorized API block: ${req.method} ${url.pathname} (${authResult.reason})`);
    sendJson(res, { error: "Unauthorized" }, authResult.status || 401);
    return false;
  }

  async function routeRequest(ctx) {
    try {
      if (!authorize(ctx)) return;
      if (!(await routes(ctx))) sendNotFound(ctx.res);
    } catch (error) {
      appendLog(`error: ${error.message}`, ctx.operationContext);
      sendJson(ctx.res, { error: error.message }, 500);
    }
  }

  // E2：此前用 operationStorage.enterWith(ctx) 在共享的请求回调帧上写入上下文——enterWith
  // 会污染当前执行帧及同帧后续回调的异步上下文（上一请求的 operationId 可能渗漏到下一请求）。
  // 改为 operationStorage.run(ctx, ...) 把路由处理整体包住：上下文严格随本请求的异步链传播。
  async function handleHttpRequest(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    // 原始路径：URL 解析会折叠 ../，目录逃逸检查必须基于原始请求路径。
    const rawPath = (req.url || "/").split("?")[0];
    const operationId = req.method === "POST" ? normalizeOperationId(req.headers["x-operation-id"]) : undefined;
    const operationContext = operationId ? { operationId } : undefined;
    if (operationId) res.setHeader("x-operation-id", operationId);
    // 人工排查用的可读 JSON：?pretty=1。前端从不带这个参数，走紧凑输出。
    res.prettyJson = url.searchParams.get("pretty") === "1";
    const ctx = { req, res, url, rawPath, operationContext };
    if (operationContext) return operationStorage.run(operationContext, () => routeRequest(ctx));
    return routeRequest(ctx);
  }

  return { handleHttpRequest };
}
