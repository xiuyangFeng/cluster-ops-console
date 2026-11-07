// 页面与静态资源：/、/styles.css、/app.js 与 /assets/*（只读 GET）。
// 服务器只在根上暴露这三个文件，其余前端文件必须放在 public/assets/ 下。
import path from "node:path";

import { createAssetHandler, sendFile } from "../static.mjs";

const ROOT_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

export function createStaticRoutes({ publicDir }) {
  const handleAsset = createAssetHandler(publicDir);
  return async ({ req, res, url, rawPath }) => {
    if (req.method !== "GET") return false;
    if (rawPath.startsWith("/assets/")) {
      await handleAsset(req, res, rawPath);
      return true;
    }
    const file = ROOT_FILES.get(url.pathname);
    if (!file) return false;
    await sendFile(req, res, path.join(publicDir, file[0]), file[1]);
    return true;
  };
}
