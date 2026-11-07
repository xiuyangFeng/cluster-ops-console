// 服务器注册表：/api/servers（列表 / 新增）与 /api/servers/:id[/action]。
// 错误载荷是注册表形状 { error, code, errors }（冲突码与逐字段校验结果）。
import { isJsonObject, readJsonBody, respondOrError, sendJson, sendRegistryError } from "../io.mjs";

const SERVER_ITEM_RE = /^\/api\/servers\/([^/]+)(?:\/(test|disable|enable|restore|credentials|hostkey|suggest-port|claim-port|sync-cluster-env))?$/;
const BODY_METHODS = new Set(["POST", "PATCH", "DELETE"]);

export function createServerRoutes({ serverRegistry, scheduler, clusterEnvSync = null }) {
  // 单台服务器的动作分派。返回 true = 已响应；false = 方法/动作组合不存在，交给后续路由（最终 404）。
  async function dispatch(res, method, action, id, data) {
    const reply = (payload, status) => {
      sendJson(res, payload, status);
      return true;
    };
    if (method === "POST" && action === "test") return reply(await serverRegistry.testConnection(id));
    // W5：端口被占 → 重新分配前的只读建议（远端 ss 探测 + 本机配置保留集）。控制台发起的
    // SSH 一律走调度器槽位（并发上限 3 是硬约束），这里把槽位交给 registry。
    if (method === "GET" && action === "suggest-port") {
      return reply(await serverRegistry.suggestPort(id, { acquireSshSlot: (options) => scheduler.acquireSshSlot(options) }));
    }
    // v2.54 终审：确认后的"重新分配"——在该服务器的端口登记目录里原子领取，再写个人配置（同样占 SSH 槽位）。
    if (method === "POST" && action === "claim-port") {
      return reply(await serverRegistry.claimPort(id, {
        remotePort: data.remotePort,
        expectedRevision: data.expectedRevision,
        acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
      }));
    }
    // 用户点的「同步到集群」：把集群上的受管 env.sh（及仍指向旧端口的 Claude 代理键）改到当前反向端口。
    // 端口变更后的自动同步不走这里（server/config-refresh.mjs 在配置热载时触发）。
    if (method === "POST" && action === "sync-cluster-env") {
      if (!clusterEnvSync) return reply({ error: "集群配置同步不可用" }, 503);
      const result = await clusterEnvSync.sync(id, { force: true });
      if (result.status === "ineligible") return reply({ error: "这台服务器没有集群侧受管配置（只对团队服务器生效）", code: "ineligible" }, 409);
      return reply({ serverId: id, ...result });
    }
    if (method === "POST" && action === "disable") return reply(await serverRegistry.disable(id, data));
    if (method === "POST" && action === "enable") return reply(await serverRegistry.enable(id, data));
    if (method === "POST" && action === "restore") return reply(await serverRegistry.restore(id, data));
    if (method === "POST" && action === "credentials") return reply(await serverRegistry.putCredentials(id, data));
    if (method === "POST" && action === "hostkey") {
      if (Object.hasOwn(data, "lines")) return reply({ error: "确认主机密钥不得提交原始密钥行，请重新预览" }, 400);
      if (data.confirm === true || data.linesHash) return reply(serverRegistry.confirmHostKey(id, { linesHash: data.linesHash }));
      return reply(await serverRegistry.previewHostKey(id));
    }
    if (method === "PATCH" && !action) return reply(await serverRegistry.update(id, data));
    if (method === "DELETE" && !action) return reply(await serverRegistry.remove(id, data));
    return false;
  }

  async function handleItem(req, res, match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    return respondOrError(res, async () => {
      // 正文先于动作分派读取并校验：写方法（test 除外）的正文必须是 JSON 对象，
      // 即便随后发现方法/动作组合不存在（落到 404）。
      const hasBody = BODY_METHODS.has(req.method) && action !== "test";
      const data = hasBody ? await readJsonBody(req) : {};
      if (hasBody && !isJsonObject(data)) {
        sendJson(res, { error: "请求正文必须是 JSON 对象" }, 400);
        return true;
      }
      return dispatch(res, req.method, action, id, data);
    }, sendRegistryError);
  }

  return async ({ req, res, url }) => {
    if (url.pathname === "/api/servers" && req.method === "GET") {
      sendJson(res, serverRegistry.list({ includeDisabled: url.searchParams.get("includeDisabled") !== "0" }));
      return true;
    }
    if (url.pathname === "/api/servers" && req.method === "POST") {
      const data = await readJsonBody(req);
      if (!isJsonObject(data)) sendJson(res, { error: "invalid server" }, 400);
      else await respondOrError(res, async () => sendJson(res, await serverRegistry.add(data), 201), sendRegistryError);
      return true;
    }
    const match = url.pathname.match(SERVER_ITEM_RE);
    return match ? handleItem(req, res, match) : false;
  };
}
