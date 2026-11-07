// scripts/hot-update/api.mjs —— 与本机控制面 HTTP API 的通信（/api/session 取 token、/api/build-info、
// /api/data-plane/upgrade），全部经 ctx.fetch 注入。控制面端口固定为桌面的 MONITOR_PORT。
import { MONITOR_PORT } from "../../work/monitor/desktop/context.mjs";

function apiUrl(pathname) {
  return `http://127.0.0.1:${MONITOR_PORT}${pathname}`;
}

async function fetchJson(ctx, url, init = {}, timeoutMs = 4000) {
  const res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, ok: res.ok, body };
}

// token 只在内存里流转，绝不打印。/api/session 对本机无 Origin 请求返回 token。
async function getToken(ctx) {
  const { ok, body } = await fetchJson(ctx, apiUrl("/api/session"));
  return ok && body && typeof body.token === "string" ? body.token : "";
}

export async function getBuildInfoApi(ctx) {
  try {
    const token = await getToken(ctx);
    const { ok, body } = await fetchJson(ctx, apiUrl("/api/build-info"), { headers: token ? { "x-auth-token": token } : {} });
    return ok ? body : null;
  } catch {
    return null;
  }
}

export async function postDataPlaneUpgrade(ctx, components) {
  const token = await getToken(ctx);
  const { status, body } = await fetchJson(
    ctx,
    apiUrl("/api/data-plane/upgrade"),
    { method: "POST", headers: { "content-type": "application/json", "x-auth-token": token }, body: JSON.stringify({ components }) },
    90_000,
  );
  return { status, body };
}
