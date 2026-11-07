// 配置读写：/api/config、个人层 /api/config/personal、活跃服务器 / 活跃 Agent 切换、
// 监控模块开关 /api/modules、界面面板显隐 /api/ui-prefs。
import { adapterForAgent, enabledAgentProbeIds } from "../../agents/registry.mjs";
import { buildModuleCatalog } from "../../modules/catalog.mjs";
import { collectSlowProbeId, LOG_SIGNALS_PROBE_ID } from "../../probe-ids.mjs";
import { computeConfigRevision } from "../../runtime-snapshot.mjs";
import { isJsonObject, readJsonBody, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 个人层保存失败的载荷形状：{ error, errors }（逐字段校验结果），没有 code。
function sendSaveError(res, err) {
  sendJson(res, { error: err.message || "failed to save config", errors: err.errors || undefined }, err.status || 400);
}

export function createConfigRoutes({
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
}) {
  // 配置已变：刷新内核，并按新上下文立即 forceRun 给定探针，使界面秒级展现新数据。
  // T02（A09）：forceRun 防抖缓存按 contextKey 区分，旧上下文缓存不得吞掉新上下文的真实检查。
  async function refreshAndForceRun(probeIdsFor) {
    const parsed = await refreshConfigIntoKernel();
    const contextKey = computeConfigRevision(parsed);
    for (const probeId of probeIdsFor(parsed)) {
      scheduler.forceRun(probeId, { contextKey }).catch(() => {});
    }
  }

  return routeTable({
    "GET /api/config": async ({ res }) => sendJson(res, await getConfig()),
    "GET /api/config/personal": async ({ res }) => sendJson(res, { config: await getPersonalConfig() }),
    "POST /api/config/personal": async ({ req, res, operationContext }) => {
      const data = await readJsonBody(req);
      if (!isJsonObject(data)) return sendJson(res, { error: "invalid personal config" }, 400);
      await respondOrError(res, async () => {
        await savePersonalConfig(data, operationContext);
        await refreshConfigIntoKernel();
        sendJson(res, { success: true, restartRequired: true });
      }, sendSaveError);
    },
    "POST /api/config/active": async ({ req, res, operationContext }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!(await setActiveServerConfig(data.activeServerId, operationContext))) {
        return sendJson(res, { error: "invalid server id" }, 400);
      }
      // v2.18：要刷新的是新活跃服务器的 slow 采集（负载/GPU）与 fast 采集
      // （日志信号与远端端口结论跟着活跃服务器走）。getMainServerConfig 与
      // state-store 的 mainServer() 同一套回落规则，保证两边指向同一台机器。
      await refreshAndForceRun((parsed) => {
        const activeId = toolkit.getMainServerConfig(parsed)?.id || parsed.activeServerId;
        return [LOG_SIGNALS_PROBE_ID, collectSlowProbeId(activeId)];
      });
      sendJson(res, { success: true });
    },
    "POST /api/config/agent-active": async ({ req, res, operationContext }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!(await setActiveAgentConfig(data.activeAgentId, operationContext))) {
        return sendJson(res, { error: "invalid agent id" }, 400);
      }
      // 切换活跃 Agent 后立即复核 agents 诊断探针（旧版此处触发一次低频轮询）。
      // 只跑启用适配器的探针：被关掉的 Agent 探针已注销，forceRun 只会空转报错。
      await refreshAndForceRun((parsed) => enabledAgentProbeIds(parsed));
      sendJson(res, { success: true });
    },
    "GET /api/modules": async ({ res }) => sendJson(res, { modules: buildModuleCatalog(await getConfig()) }),
    "POST /api/modules": async ({ req, res, operationContext }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (typeof data.id !== "string" || typeof data.enabled !== "boolean") {
        return sendJson(res, { error: "invalid module toggle" }, 400);
      }
      await respondOrError(res, async () => {
        if (!(await setModuleEnabled(data.id, data.enabled, operationContext))) {
          return sendJson(res, { error: "unknown or locked module" }, 400);
        }
        // 热载：按新配置注册/注销探针并清理状态；重新打开的 Agent 立即复核，不等完整周期。
        await refreshAndForceRun((parsed) => {
          if (!data.enabled || !data.id.startsWith("agent:")) return [];
          const agent = parsed.agents.find((item) => `agent:${item.id}` === data.id);
          return adapterForAgent(agent)?.probeIds || [];
        });
        sendJson(res, { success: true, modules: buildModuleCatalog(await getConfig()) });
      }, sendSaveError);
    },
    "POST /api/ui-prefs": async ({ req, res, operationContext }) => {
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || !Array.isArray(data.hiddenPanels)) return sendJson(res, { error: "invalid ui preferences" }, 400);
      await respondOrError(res, async () => {
        await setHiddenPanels(data.hiddenPanels, operationContext);
        const parsed = await refreshConfigIntoKernel();
        sendJson(res, { success: true, hiddenPanels: parsed.hiddenPanels });
      }, sendSaveError);
    },
  });
}
