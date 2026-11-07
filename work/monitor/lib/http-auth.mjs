import { createHash, timingSafeEqual } from "node:crypto";

// Web 模式鉴权（C3 + 读接口收口）：此前 authToken 仅由 Electron 注入，Web 模式恒为空字符串，
// 鉴权判定 `if (authToken && ...)` 整体短路——变更端点（POST /api/stop 等）对任何人免鉴权放行，
// 恶意网页可 CSRF、同机用户可直接 curl DoS 全队隧道。后续审计又发现读接口完全无防护：
// DNS 重绑定页面（攻击者域名解析到 127.0.0.1）可任意读取 /api/logs、/api/status 等敏感数据。
//
// 现契约：
//   - 非 /api/ 的只读请求（页面本身与静态资源）放行——浏览器首次加载时尚无 token（token 要
//     从 /api/session 或 Electron IPC 才拿得到），且静态文件不含机密。
//   - 所有 /api/*（含读）与全部写方法：Host 必须解析为本机（127.0.0.1 / localhost / ::1），
//     Origin 须满足"缺失 / 字面量 "null" / 本机"三选一——堵 DNS 重绑定读日志的路径。
//     "null" 是 Electron 灵动岛 file:// 文档的不透明源序列化（Chromium 行为），是可信的本地
//     渲染器，必须放行，否则出厂快捷控件静默失效；真正的闸门是 Host 必须本地。
//   - /api/* 只读方法：authToken 已配置时同样要求有效 token（x-auth-token 头或 ?token= 查询
//     参数，由路由层归并进 headers 后传入）。唯一豁免 /api/session——它是浏览器获取 token 的
//     引导端点（鸡生蛋），自身受上面的 Host/Origin 本地校验保护，且跨源脚本因无 CORS 头读不到
//     响应体。authToken 未配置（直接 `node monitor-server.mjs` 本机调试）时只读维持放行，但
//     Host/Origin 校验仍然生效。
//   - 写方法（POST/PUT/DELETE/PATCH）：token 为空 → 一律 401（不放行）；token 非空 →
//     必须与配置的 authToken 精确匹配（哈希后常量时间比较），防跨站 CSRF 与 DNS rebinding。
//   - Electron 兼容：Electron 主进程用 node 内置 http/fetch 直连本机端口，不带 Origin 头，
//     Host 天然是 127.0.0.1:<port>，且所有请求都带 x-auth-token（electron-main.mjs:518 等），
//     行为与改动前一致。
const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

function safeTokenEquals(a, b) {
  const da = createHash("sha256").update(String(a ?? "")).digest();
  const db = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(da, db);
}

// 从 Origin（"http://127.0.0.1:8877"）或 Host（"127.0.0.1:8877" / "[::1]:8877"）取出纯
// hostname，小写、去 scheme、去端口，IPv6 字面量去中括号。
function extractHeaderHostname(value) {
  if (!value) return "";
  let v = String(value).trim();
  const schemeMatch = v.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  if (schemeMatch) v = v.slice(schemeMatch[0].length);
  v = v.split("/")[0];
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end === -1 ? "" : v.slice(1, end).toLowerCase();
  }
  const colonIdx = v.lastIndexOf(":");
  if (colonIdx !== -1 && /^\d+$/.test(v.slice(colonIdx + 1))) v = v.slice(0, colonIdx);
  return v.toLowerCase();
}

export function isLocalHeaderValue(value) {
  return LOCAL_HOSTNAMES.has(extractHeaderHostname(value));
}

export function authorizeRequest({ method, path: reqPath, headers = {}, authToken } = {}) {
  const upperMethod = String(method || "GET").toUpperCase();
  const isWrite = WRITE_METHODS.has(upperMethod);
  const isApi = typeof reqPath === "string" && (reqPath === "/api" || reqPath.startsWith("/api/"));
  const h = headers || {};

  // 非 API 的只读请求（页面 / 静态资源）不设防：首次加载时浏览器尚无 token。
  if (!isApi && !isWrite) {
    return { ok: true };
  }

  // 所有 /api/*（含读）与全部写方法：Origin 缺失 /"null"/ 本地三选一，Host 必须本地。
  // 见文件头契约注释（DNS 重绑定与 Electron file:// 灵动岛的说明）。
  const origin = h.origin || h.Origin;
  if (origin && origin !== "null" && !isLocalHeaderValue(origin)) {
    return { ok: false, status: 403, reason: "origin not local" };
  }
  const host = h.host || h.Host;
  if (!isLocalHeaderValue(host)) {
    return { ok: false, status: 403, reason: "host not local" };
  }

  const reqToken = h["x-auth-token"] || h["X-Auth-Token"] || "";

  if (!isWrite) {
    // /api/* 只读：authToken 已配置时要求有效 token；/api/session 免 token（token 引导端点）；
    // authToken 未配置时维持放行（本机调试场景，Host/Origin 校验已在上面生效）。
    if (!authToken || reqPath === "/api/session") {
      return { ok: true };
    }
    if (!safeTokenEquals(reqToken, authToken)) {
      return { ok: false, status: 401, reason: "invalid auth token" };
    }
    return { ok: true };
  }

  if (!authToken) {
    return { ok: false, status: 401, reason: "auth token not configured" };
  }
  if (!safeTokenEquals(reqToken, authToken)) {
    return { ok: false, status: 401, reason: "invalid auth token" };
  }
  return { ok: true };
}
