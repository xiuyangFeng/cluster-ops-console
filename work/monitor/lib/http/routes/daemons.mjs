// 远端守护进程（v2.55，lib/daemons/）：
//   GET  /api/daemons[?serverId=<id>][&fresh=1]  当前活跃服务器上 Paseo / T3 Code 的状态（会发一次只读 SSH，10 秒短缓存；fresh=1 跳过缓存）
//   POST /api/daemons/start  { daemon: "paseo"|"t3code", serverId? }  启动白名单里的一个守护进程（已在运行则什么都不做）
// serverId 可选；给了就必须等于当前活跃服务器（格式不对 400，不是活跃服务器 409）——防止界面切服的瞬间把动作打到另一台。
// 「远端守护进程」模块关闭或服务缺失时一律 503。鉴权 / CSRF 与其它 /api/* 相同（POST 必须带 token）。
// SSH 占调度器全局槽位；不进 /api/status。
//
// 服务直达（v2.62）：GET /api/daemons 的响应多出 services（本人在这台服务器上监听的服务）与 forwards（开着的转发）。
//   POST /api/daemons/forward        { serverId, port }  把服务列表里的一个端口临时转发到本机，返回本机地址
//   POST /api/daemons/forward/close  { serverId, port }  关掉这条转发
// 正文只接受 serverId 与 port 两个键：多带任何别的键（host、localPort……）一律 400——请求里没有「转发到哪台主机、
// 用哪个本机端口」这回事，目标由服务列表决定，本机端口由系统挑。端口是否在列表里由服务层把关（不在 → 409）。
import { isDaemonId } from "../../daemons/commands.mjs";
import { isDataModuleEnabled } from "../../modules/catalog.mjs";
import { isBoundedServerId } from "../../validators.mjs";
import { isJsonObject, readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

const sendError = (res, error) => sendJson(res, { error: String(error?.message || error) }, error?.status || 500);

const FORWARD_KEYS = new Set(["serverId", "port"]);

// 转发 / 关闭请求的正文 → { serverId, port } 或 { error }。端口必须是 1024–65535 的整数（字符串不算）。
function readForwardTarget(data) {
  if (!isJsonObject(data) || !Object.keys(data).every((key) => FORWARD_KEYS.has(key))) return { error: "只接受 serverId 与 port" };
  if (!isBoundedServerId(data.serverId)) return { error: "invalid serverId" };
  if (!Number.isInteger(data.port) || data.port < 1024 || data.port > 65535) return { error: "端口不合法" };
  return { serverId: data.serverId, port: data.port };
}

export function createDaemonsRoutes({ daemonsService, getConfig = async () => null, scheduler = null }) {
  const acquireSshSlot = scheduler?.acquireSshSlot ? (options) => scheduler.acquireSshSlot(options) : null;

  // 服务在不在 → 模块开关。返回 true 表示可以继续（否则已写出 503）。
  async function precheck(res) {
    if (!daemonsService) {
      sendJson(res, { error: "daemons unavailable" }, 503);
      return false;
    }
    if (!isDataModuleEnabled(await getConfig(), "daemons")) {
      sendJson(res, { error: "远端守护进程模块已关闭", disabled: true }, 503);
      return false;
    }
    return true;
  }

  // 两个转发动作共用：模块开关 → 读正文 → 校验 → 交给服务层。
  async function forwardAction(req, res, run) {
    if (!(await precheck(res))) return;
    const data = await readRequiredBody(req, res);
    if (data == null) return;
    const target = readForwardTarget(data);
    if (target.error) return sendJson(res, { error: target.error }, 400);
    await respondOrError(res, async () => sendJson(res, await run(target)), sendError);
  }

  return routeTable({
    "GET /api/daemons": async ({ res, url }) => {
      if (!(await precheck(res))) return;
      const serverId = url.searchParams.has("serverId") ? url.searchParams.get("serverId") : null;
      if (serverId !== null && !isBoundedServerId(serverId)) return sendJson(res, { error: "invalid serverId" }, 400);
      const fresh = url.searchParams.get("fresh") === "1";
      await respondOrError(res, async () => sendJson(res, await daemonsService.status(serverId, { acquireSshSlot, fresh })), sendError);
    },
    "POST /api/daemons/start": async ({ req, res }) => {
      if (!(await precheck(res))) return;
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      if (!isJsonObject(data) || !isDaemonId(data.daemon)) return sendJson(res, { error: "未知的守护进程" }, 400);
      if (data.serverId != null && !isBoundedServerId(data.serverId)) return sendJson(res, { error: "invalid serverId" }, 400);
      await respondOrError(res, async () => sendJson(res, await daemonsService.start(
        data.daemon,
        { serverId: data.serverId ?? null },
        { acquireSshSlot },
      )), sendError);
    },
    "POST /api/daemons/forward": ({ req, res }) => forwardAction(req, res, (target) => daemonsService.forward(target, { acquireSshSlot })),
    "POST /api/daemons/forward/close": ({ req, res }) => forwardAction(req, res, (target) => daemonsService.closeForward(target)),
  });
}
