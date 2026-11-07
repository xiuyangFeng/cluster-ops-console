// 静态文件：内存缓存 + ETag 协商缓存（sendFile），以及 /assets/* 的安全解析
// （白名单后缀 + 目录逃逸 + 符号链接逃逸防护）。
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { sendJson, sendNotFound } from "./io.mjs";

// 静态文件内存缓存（perf）：key = 绝对路径，按 mtime/ctime/size 失效。此前每个请求
// （含每次 304 协商）都要 readFile + sha1 整个文件；页面冷启动 30+ 个模块就是 30+ 次
// 读盘与哈希。现在每请求只剩一次 stat，文件一改（升级/开发编辑）三者之一必变，立即重读。
// public/ 下文件总量 <1MB，条目数封顶防意外膨胀。
const STATIC_CACHE_MAX_ENTRIES = 256;
const staticFileCache = new Map(); // filePath -> { key, body, etag }

async function loadStaticFile(filePath) {
  const st = await stat(filePath);
  const key = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  const hit = staticFileCache.get(filePath);
  if (hit && hit.key === key) return hit;
  const body = await readFile(filePath);
  const etag = `"${createHash("sha1").update(body).digest("hex").slice(0, 24)}-${body.length.toString(16)}"`;
  const entry = { key, body, etag };
  staticFileCache.delete(filePath);
  if (staticFileCache.size >= STATIC_CACHE_MAX_ENTRIES) staticFileCache.delete(staticFileCache.keys().next().value);
  staticFileCache.set(filePath, entry);
  return entry;
}

// monitor-server.mjs 经 http-router re-export 本函数，供 monitor-server.test.mjs 直测
// ETag/304 协商缓存逻辑（模块本身无副作用，import 不会启动生产实例）。
export async function sendFile(req, res, filePath, contentType) {
  // 静态资源缓存策略（v2.13.0）：no-store → ETag + no-cache。
  // 此前每次刷新都全量重传（styles 48KB + 全部 JS 模块）；改为内容哈希强 ETag +
  // 协商缓存：内容没变回 304 零载荷，变了（升级后）立刻拿到新文件——既省往返字节
  // 又绝无"新版页面配旧模块"的陈旧缓存风险。API 响应维持 no-store 不变。
  const { body, etag } = await loadStaticFile(filePath);
  const ifNoneMatch = req?.headers?.["if-none-match"];
  if (ifNoneMatch && String(ifNoneMatch).split(",").map((s) => s.trim().replace(/^W\//, "")).includes(etag)) {
    res.writeHead(304, { etag, "cache-control": "no-cache" });
    return res.end();
  }
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-cache", etag });
  res.end(body);
}

const ASSET_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

// /assets/* 处理器。rawPath 必须是未经 URL 解析的原始请求路径——URL 解析会折叠 ../，
// 目录逃逸检查必须基于原始路径。public 根的真实路径（解引用符号链接）在创建时解析一次。
export function createAssetHandler(publicDir) {
  let publicRootReal = publicDir;
  try {
    publicRootReal = realpathSync(publicDir);
  } catch {}
  const verifiedRealPaths = new Set();

  return async function handleAsset(req, res, rawPath) {
    let relative;
    try {
      // URL 子路径直接映射到 public/ 下（/assets/js/api.js → public/assets/js/api.js）。
      relative = decodeURIComponent(rawPath.replace(/^\/+/, ""));
    } catch {
      return sendJson(res, { error: "bad path" }, 400);
    }
    const resolved = path.resolve(publicDir, relative);
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
      return sendJson(res, { error: "forbidden" }, 403);
    }
    if (!verifiedRealPaths.has(resolved)) {
      // 符号链接加固：解引用后若真实路径逃出 public 根，拒绝；文件不存在则 404。
      let real;
      try {
        real = realpathSync(resolved);
      } catch {
        return sendNotFound(res);
      }
      if (real !== resolved && real !== publicRootReal && !real.startsWith(publicRootReal + path.sep)) {
        return sendJson(res, { error: "forbidden" }, 403);
      }
    }
    const contentType = ASSET_CONTENT_TYPES[path.extname(resolved).toLowerCase()];
    if (!contentType) {
      return sendJson(res, { error: "forbidden" }, 403);
    }
    try {
      await sendFile(req, res, resolved, contentType);
      if (verifiedRealPaths.size < STATIC_CACHE_MAX_ENTRIES) verifiedRealPaths.add(resolved);
    } catch {
      verifiedRealPaths.delete(resolved);
      return sendNotFound(res);
    }
  };
}
