import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./lib/is-main.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

export function electronBinaryPath(projectRoot, platform = process.platform) {
  const base = path.join(projectRoot, "node_modules", "electron", "dist");
  if (platform === "darwin") return path.join(base, "Electron.app", "Contents", "MacOS", "Electron");
  if (platform === "win32") return path.join(base, "electron.exe");
  return path.join(base, "electron");
}

export function shouldInstallElectronRuntime({ platform = process.platform, binaryExists = false } = {}) {
  return platform === "darwin" && !binaryExists;
}

// 传给 install.js 的环境：清掉"跳过二进制下载"的两个开关。
// 为什么仍需清：electron 44.4.5 自己没有 postinstall（其 package.json 无 scripts 段），
// 所以 install.js 只会被本脚本调用；但 .npmrc 的 electron_skip_binary_download 会被 npm
// 透传成 npm_config_electron_skip_binary_download，而 install.js 历史上读这两个环境变量
// 后直接空跑退出。升级 electron 后若它重新带上 postinstall / 恢复该判断，不清就会让
// "真正需要装桌面壳"的这一路静默空跑，用户看到的是"装完了但打不开"。
export function electronInstallEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  delete env.npm_config_electron_skip_binary_download;
  return env;
}

export function installElectronRuntime({
  projectRoot = rootDir,
  platform = process.platform,
  exists = existsSync,
  spawn = spawnSync,
  execPath = process.execPath,
  log = console.log,
  error = console.error,
} = {}) {
  const binaryPath = electronBinaryPath(projectRoot, platform);
  if (!shouldInstallElectronRuntime({ platform, binaryExists: exists(binaryPath) })) {
    log(platform === "darwin"
      ? "Electron runtime already installed."
      : "Electron runtime skipped: browser-first mode is used outside macOS.");
    return { ok: true, skipped: true };
  }

  const installer = path.join(projectRoot, "node_modules", "electron", "install.js");
  if (!exists(installer)) {
    error(`Electron installer not found: ${installer}`);
    error("桌面壳暂不可用。请先确认 npm install 已完成，或直接 npm run start 使用网页控制台 http://127.0.0.1:8877");
    return { ok: true, skipped: true, reason: "installer-missing" };
  }
  const result = spawn(execPath, [installer], {
    cwd: projectRoot,
    stdio: "inherit",
    env: electronInstallEnv(),
  });
  if (result.status !== 0 || !exists(binaryPath)) {
    error("Electron runtime installation failed; npm run start will fall back to Web mode.");
    error("可稍后执行 npm run electron:install，或忽略桌面壳直接使用网页控制台。");
    // 不失败 npm install：Electron 只是 macOS 加分项，网页模式仍可用。
    return { ok: true, skipped: false, failed: true, status: result.status || 1 };
  }
  return { ok: true, skipped: false, installed: true };
}

function main() {
  installElectronRuntime();
}

if (isMainModule(import.meta.url)) main();
