// 路由组的组合件。
//
// 约定：每个路由组是 `async (ctx) => boolean` —— true 表示已写出响应，false 表示不归
// 自己管、交给下一组。ctx = { req, res, url, rawPath, operationContext }。

// 精确匹配「方法 + 路径」的路由表，键形如 "GET /api/status"。命中即视为已响应
// （处理器的返回值被忽略）；未命中返回 false。
export function routeTable(handlers) {
  const table = new Map(Object.entries(handlers));
  return async (ctx) => {
    const handler = table.get(`${ctx.req.method} ${ctx.url.pathname}`);
    if (!handler) return false;
    await handler(ctx);
    return true;
  };
}

// 依次尝试各路由，第一个返回 true 的即终止。
export function firstMatch(...routes) {
  return async (ctx) => {
    for (const route of routes) {
      if (await route(ctx)) return true;
    }
    return false;
  };
}
