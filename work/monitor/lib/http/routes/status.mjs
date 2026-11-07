// 状态读接口：session（token 引导）、status 全量 / lite、构建信息、时间线、SSE 事件流。
import { isLocalHeaderValue } from "../../http-auth.mjs";
import { numberParam, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

// 时间线：从最近 200 条状态迁移里筛选，limit 夹在 [1,200]、缺省 50。
const TIMELINE_SOURCE_SIZE = 200;
const TIMELINE_DEFAULT_LIMIT = 50;

export function createStatusRoutes({ authToken, store, getBuildInfo, getStatusPayload, sseHub }) {
  return routeTable({
    // Web 模式 token 交付：Electron 走 IPC(getAuthToken) 拿 token，浏览器无此通道。
    // 同源页面可读本响应、跨源 JS 因无 CORS 头读不到响应体——CSRF 防护不被削弱。
    // 仅对同源/本地请求（Origin 缺失或本地、Host 本地）返回 token，多一道防御。
    "GET /api/session": ({ req, res }) => {
      const origin = req.headers.origin || req.headers.Origin;
      const sameOrigin = (!origin || isLocalHeaderValue(origin)) && isLocalHeaderValue(req.headers.host || req.headers.Host);
      sendJson(res, { token: sameOrigin ? authToken : "" });
    },
    "GET /api/status": ({ res }) => sendJson(res, getStatusPayload()),
    // T05：运行/磁盘/前端/supervisor 四个构建来源的区分视图（同样经鉴权）。
    // clientBuild 是客户端自报的已加载版本（长度受限），只用于本次响应的 reload-ui
    // 比较，不当成可信运行事实、不写入任何共享状态。
    "GET /api/build-info": async ({ res, url }) => {
      const clientBuild = (url.searchParams.get("clientBuild") || "").slice(0, 128);
      sendJson(res, await getBuildInfo({ clientBuild }));
    },
    "GET /api/status-lite": ({ res }) => sendJson(res, store.getLiteStatus()),
    "GET /api/timeline": ({ res, url }) => {
      const since = numberParam(url.searchParams, "since", null);
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || TIMELINE_DEFAULT_LIMIT, 1), TIMELINE_SOURCE_SIZE);
      const events = store.getRecentTransitions(TIMELINE_SOURCE_SIZE)
        .filter((t) => (since != null ? t.ts >= since : true))
        .slice(-limit)
        .reverse();
      sendJson(res, { events });
    },
    "GET /api/events": ({ req, res }) => sseHub.handle(req, res),
  });
}
