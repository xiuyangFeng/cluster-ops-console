import path from "node:path";

const APP_DATA_DIR_NAME = "codex-tunnel-monitor";

export function isPackagedMacApp(appRoot, platform = process.platform) {
  return platform === "darwin" && appRoot.includes(".app/Contents/Resources/");
}

// Windows 安装版（scripts/build-windows-app.mjs）：<安装目录>\resources\app。源码 checkout 的根
// 不会叫 resources\app，按最后两级目录名认（大小写不敏感，Windows 路径本就不区分）。
export function isPackagedWindowsApp(appRoot, platform = process.platform) {
  if (platform !== "win32") return false;
  const parts = String(appRoot ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 && parts.at(-1).toLowerCase() === "app" && parts.at(-2).toLowerCase() === "resources";
}

// 打包的桌面 App（macOS .app 或 Windows 安装版）：可变数据不写安装目录、不走 git 自更新、登录项归桌面壳。
export function isPackagedApp(appRoot, platform = process.platform) {
  return isPackagedMacApp(appRoot, platform) || isPackagedWindowsApp(appRoot, platform);
}

// 打包模式的数据根：macOS ~/Library/Application Support/<名>，Windows %APPDATA%\<名>（取不到 APPDATA 时
// 用 <家目录>\AppData\Roaming，与系统默认一致）。
function packagedDataRoot({ env, platform, homeDir }) {
  if (platform === "win32") return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), APP_DATA_DIR_NAME);
  return path.join(homeDir, "Library", "Application Support", APP_DATA_DIR_NAME);
}

export function resolveRuntimePaths({
  appRoot,
  dataRoot,
  env = process.env,
  platform = process.platform,
  homeDir,
} = {}) {
  const resolvedAppRoot = path.resolve(env.CODEX_MONITOR_APP_ROOT || appRoot);
  const sourceMode = !dataRoot && !env.CODEX_MONITOR_DATA_DIR && !isPackagedApp(resolvedAppRoot, platform);
  const resolvedDataRoot = path.resolve(
    env.CODEX_MONITOR_DATA_DIR
      || dataRoot
      || (sourceMode
        ? path.join(resolvedAppRoot, "work")
        : packagedDataRoot({ env, platform, homeDir })),
  );
  const runtimeDir = path.join(resolvedDataRoot, "runtime");
  const resolvedConfigPath = path.resolve(
    env.CODEX_MONITOR_CONFIG_PATH || path.join(resolvedAppRoot, "config.json"),
  );
  const resolvedLocalConfigPath = path.resolve(
    env.CODEX_MONITOR_LOCAL_CONFIG_PATH
      || (sourceMode
        ? path.join(resolvedAppRoot, "config.local.json")
        : path.join(resolvedDataRoot, "config.local.json")),
  );

  return {
    appRoot: resolvedAppRoot,
    dataRoot: resolvedDataRoot,
    configPath: resolvedConfigPath,
    localConfigPath: resolvedLocalConfigPath,
    runtimeDir,
    logsDir: path.join(runtimeDir, "logs"),
    metricsPath: path.join(runtimeDir, "metrics.json"),
  };
}
