// 本机出网（v2.54，lib/egress/service.mjs）：设置页「出网」一节的读写与自测。
//
//   GET  /api/egress            → { egress: { mode, url }, configIssue, effective, systemProxy,
//                                   allowlist: { personal, team, max }, proxyPort, revision }
//                                   effective 来自本机代理 /proxy-health 的出网头（旧版代理无此头时
//                                   supportsEgress:false）；systemProxy 是本机识别到的系统代理。
//   POST /api/egress            { mode, url? } → 同 GET 的载荷。写个人层 egress，本机代理约 2 秒内热载。
//   POST /api/egress/allowlist  { add } | { remove } → 同 GET 的载荷。add 接受 host:port 或中转站 base URL。
//   POST /api/egress/self-test  { scope?: "local" | "full" } → { results, suggestion, effective, systemCheck, full? }
//
// 代理口令与隧道使用记录（v2.62，lib/egress/proxy-auth-service.mjs）。任何响应里都没有口令本身：
//   GET  /api/egress             多一个 proxyAuth：{ mode: "off" | "observe" | "enforce", hasToken, updatedAt, rotation,
//                                   issue, proxy: { state, mode, since }, cluster: { serverId, serverName, env, credential,
//                                   checkedAt, error } | null, stats: { windowHours, since, authed, missing, bad, denied,
//                                   targets, moreTargets, moreRequests }, enforceRisks: [...],
//                                   clusterAlert: { code: "cluster-not-synced", serverName, credential } | null（v2.64：
//                                   已是强制而集群上不是当前口令） }；未装配时为 null。
//   POST /api/egress/proxy-auth  { mode, confirm? } | { rotate: true, force? } | { retirePrevious: true }
//                                → 同 GET 的载荷 + proxyAuthResult。切到 enforce 而有风险时 409
//                                  { error, code: "confirm-required", risks }，确认后带 confirm: true 重发。
//   POST /api/egress/proxy-auth/sync  { confirm? } → { sync: { serverId, serverName, status, plan, changed, warning }, proxyAuth }
//                                不带 confirm 只预览（只读），带了才把口令写到集群。
//   GET  /api/egress/usage       → { windowHours, since, updatedAt, recording, totals, recent,
//                                   targets: [{ target, connections, up, down, lastAt, recentConnections, recentUp, recentDown }], other }
//                                   recording（v2.65）：口令模式不是「关」（用量在记）。recent（v2.65）：本进程见过的用量文件
//                                   相邻两版之差 { fromAt, toAt, connections, up, down }，只见过一版或 150 秒没重写时为 null；
//                                   other 同样带 recent* 三项。
//
// 写接口沿用全局鉴权（http-auth：写方法必须带有效 token）。校验失败回 400 { error, errors }
// （与 /api/config/personal 同形），并发改动回 409。服务缺席（未装配）时 503。
import { readRequiredBody, respondOrError, sendJson } from "../io.mjs";
import { routeTable } from "../route-kit.mjs";

function sendSaveError(res, err) {
  sendJson(res, { error: err.message || "failed to save egress settings", errors: err.errors || undefined }, err.status || 400);
}

// 代理口令的错误：带上 code，以及「需要确认」时的风险清单 / 过渡期截止时刻（都是不含口令的事实）。
function sendProxyAuthError(res, err) {
  sendJson(res, { error: err.message || "proxy auth request failed", code: err.code || undefined, risks: err.risks || undefined, previousUntil: err.previousUntil || undefined }, err.status || 400);
}

export function createEgressRoutes({ egressService }) {
  const unavailable = (res) => sendJson(res, { error: "egress settings unavailable" }, 503);

  return routeTable({
    "GET /api/egress": async ({ res }) => {
      if (!egressService) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await egressService.getStatus()), (r, err) => sendJson(r, { error: err.message }, 500));
    },
    "POST /api/egress": async ({ req, res, operationContext }) => {
      if (!egressService) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => sendJson(res, await egressService.setMode(data, operationContext)), sendSaveError);
    },
    "POST /api/egress/allowlist": async ({ req, res, operationContext }) => {
      if (!egressService) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => sendJson(res, await egressService.updateAllowlist(data, operationContext)), sendSaveError);
    },
    "POST /api/egress/self-test": async ({ req, res }) => {
      if (!egressService) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      const scope = data.scope === "full" ? "full" : "local";
      await respondOrError(res, async () => sendJson(res, await egressService.runSelfTest({ scope })), (r, err) => sendJson(r, { error: err.message }, 500));
    },
    "POST /api/egress/proxy-auth": async ({ req, res }) => {
      if (!egressService?.setProxyAuth) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => sendJson(res, await egressService.setProxyAuth(data)), sendProxyAuthError);
    },
    "POST /api/egress/proxy-auth/sync": async ({ req, res }) => {
      if (!egressService?.syncProxyAuth) return unavailable(res);
      const data = await readRequiredBody(req, res);
      if (data == null) return;
      await respondOrError(res, async () => sendJson(res, await egressService.syncProxyAuth(data)), sendProxyAuthError);
    },
    "GET /api/egress/usage": async ({ res }) => {
      if (!egressService?.getUsage) return unavailable(res);
      await respondOrError(res, async () => sendJson(res, await egressService.getUsage()), sendProxyAuthError);
    },
  });
}
