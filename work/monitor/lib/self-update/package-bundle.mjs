// 纯 Node 的小更新包：gzip JSON，显式文件清单；不执行解压命令、不携带 Electron。
import { gzipSync, gunzipSync } from "node:zlib";
import { isPackageFile } from "./package-recovery.mjs";

export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_EXPANDED = 64 * 1024 * 1024;
export const PACKAGE_REQUIRED = ["electron-bootstrap.mjs", "electron-main.mjs", "preload.js", "package.json", "config.json", "build-info.json", "work/monitor/monitor-server.mjs", "work/monitor/channel-supervisor.mjs", "work/local_http_connect_proxy.mjs", "work/monitor/lib/self-update/package-recovery.mjs"];

export function packageAssetName(version, arch = "x64") {
  return `CodexOperationsConsole-${version}-windows-${arch}-update.json.gz`;
}

export function encodePackageBundle(bundle) {
  const bytes = gzipSync(JSON.stringify(bundle), { level: 9 });
  decodePackageBundle(bytes);
  return bytes;
}

export function decodePackageBundle(bytes) {
  if (bytes.length > MAX_PACKAGE_BYTES) throw new Error("更新包超过大小上限");
  const bundle = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_PACKAGE_EXPANDED }));
  if (bundle.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(bundle.version) || !/^\d+\.\d+\.\d+$/.test(bundle.electron)
    || !["win32-x64", "win32-arm64"].includes(bundle.platform) || !Array.isArray(bundle.files) || bundle.files.length > 5000) throw new Error("更新包格式无效");
  const seen = new Set();
  let size = 0;
  for (const file of bundle.files) {
    if (!isPackageFile(file.path) || seen.has(file.path.toLowerCase()) || typeof file.data !== "string" || Buffer.from(file.data, "base64").toString("base64") !== file.data) throw new Error("更新包包含无效或重复路径");
    seen.add(file.path.toLowerCase());
    size += Buffer.byteLength(file.data, "base64");
    if (size > MAX_PACKAGE_EXPANDED) throw new Error("更新包解压后超过大小上限");
  }
  if (PACKAGE_REQUIRED.some((f) => !seen.has(f))) throw new Error("更新包缺少必要文件");
  const pkg = JSON.parse(Buffer.from(bundle.files.find((f) => f.path === "package.json").data, "base64"));
  if (pkg.version !== bundle.version || pkg.main !== "electron-bootstrap.mjs" || pkg.devDependencies?.electron !== bundle.electron) throw new Error("更新包版本或入口不一致");
  const build = JSON.parse(Buffer.from(bundle.files.find((f) => f.path === "build-info.json").data, "base64"));
  if (build.version !== bundle.version || build.platform !== bundle.platform) throw new Error("更新包构建信息不一致");
  return bundle;
}
