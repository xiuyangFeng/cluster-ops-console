// scripts/hot-update/layout.mjs —— 热更新的路径布局与构建信息（dist/staging、dist/backup、现役 .app、
// 数据目录）。纯函数 + 只读 ctx.fs 小工具，被其余各步骤共用。
import os from "node:os";
import path from "node:path";
import { resolveRuntimePaths } from "../../work/monitor/lib/runtime-paths.mjs";

export const APP_NAME = "Codex Operations Console";

const rootDirDefault = path.resolve(import.meta.dirname, "../..");

export function resolveLayout({ rootDir = rootDirDefault, env = process.env, homeDir = os.homedir() } = {}) {
  const appDir = path.join(rootDir, `${APP_NAME}.app`);
  const appResources = path.join(appDir, "Contents", "Resources", "app");
  const distDir = path.join(rootDir, "dist");
  const paths = resolveRuntimePaths({ appRoot: appResources, env, platform: "darwin", homeDir });
  return {
    rootDir,
    appDir,
    appResources,
    distDir,
    backupRoot: path.join(distDir, "backup"),
    stagingRoot: path.join(distDir, "staging"),
    buildScript: path.join(rootDir, "scripts", "build-macos-app.sh"),
    runtimeDir: paths.runtimeDir,
    // 生产数据目录与个人层（打包模式在 Application Support 下）：隧道保护预检用它们核对换包后的隧道目标。
    dataRoot: paths.dataRoot,
    localConfigPath: paths.localConfigPath,
  };
}

// --app：换成别处的现役 .app（如 /Applications 下那份）。数据目录与个人层不变——打包模式下
// 它们本就在 Application Support，与 .app 放在哪无关。
export function withAppDir(layout, appDir) {
  return { ...layout, appDir, appResources: path.join(appDir, "Contents", "Resources", "app") };
}

export function makeStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function stagedAppPath(layout, id) {
  return path.join(layout.stagingRoot, id, `${APP_NAME}.app`);
}

export function bundleResources(appPath) {
  return path.join(appPath, "Contents", "Resources", "app");
}

export async function exists(ctx, p) {
  try {
    await ctx.fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readBuildInfoFile(ctx, appPath) {
  try {
    return JSON.parse(await ctx.fs.readFile(path.join(bundleResources(appPath), "build-info.json"), "utf8"));
  } catch {
    return null;
  }
}

export function describeBuild(info) {
  if (!info) return "未知构建";
  return `v${info.version || "?"} (${info.gitCommit || "?"}${info.builtAt ? `, ${info.builtAt}` : ""})`;
}
