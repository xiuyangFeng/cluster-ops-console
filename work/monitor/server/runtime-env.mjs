// 入口运行参数：环境变量解析 + 路径 / 版本定位。
// 纯函数为主（readPackageVersion 只读一次 package.json），模块顶层无副作用，
// start.mjs 装配与单测都直接调用。

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveRuntimePaths } from "../lib/runtime-paths.mjs";
import { githubRepoOf } from "../lib/self-update/release-check.mjs";

// ---- 命名常量（值与历史行为一致，集中于此消除散落魔数）----
export const DEFAULT_PORT = 8877;
export const DEFAULT_MAX_SSE_CONNECTIONS = 8;
export const DEFAULT_SSE_HEARTBEAT_MS = 15000;
export const NDJSON_TAIL_LINES = 2000; // 磁盘 NDJSON 深回溯的解析行数上限（bridge 摄取与 /api/logs 共用）

// 本文件位于 work/monitor/server/，控制面根目录（public/ 所在）在上一级。
const MONITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 环境变量数值解析：非法值（Number → NaN）回退默认值，避免 NaN 端口 / NaN 定时器间隔
// 这类静默怪异行为。
export function envNumber(env, name, fallback) {
  const raw = env?.[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// 环境变量来自启动脚本/宿主机，不能把任意有限数直接交给 node:http 或定时器：
// 小数、负数和超出端口范围的值会在 listen 时抛异常，负的 SSE 值还可能形成忙循环。
// 端口保留 0（冒烟测试/临时监听端口），其它调用方按各自的安全下限传入。
export function envIntegerInRange(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env?.[name];
  if (raw == null || raw === "" || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function resolveRuntimeEnv(env = process.env) {
  return {
    port: envIntegerInRange(env, "PORT", DEFAULT_PORT, { min: 0, max: 65535 }),
    fixtureMode: env.CODEX_MONITOR_FIXTURE_MODE === "1",
    authToken: env.AUTH_TOKEN || "", // Electron 注入，或 scripts/launch.mjs 为 Web 模式生成
    maxSseConnections: envIntegerInRange(env, "MAX_SSE_CONNECTIONS", DEFAULT_MAX_SSE_CONNECTIONS, { min: 1, max: 1024 }),
    sseHeartbeatMs: envIntegerInRange(env, "SSE_HEARTBEAT_MS", DEFAULT_SSE_HEARTBEAT_MS, { min: 100, max: 3_600_000 }),
  };
}

// C3 + 读接口收口：空 token 下写操作一律 401；/api/* 只读接口在 token 未配置时仍放行
//（便于直接 `node monitor-server.mjs` 本机调试），但 Host/Origin 本地校验始终生效
//（防 DNS 重绑定页面读取状态/日志）。详见 authorizeRequest 的契约注释。
export const MISSING_AUTH_TOKEN_WARNING = "[WARN] AUTH_TOKEN 未设置：写操作(POST/PUT/DELETE)将全部返回 401；只读接口仍可访问（仅限本机调试场景，Host/Origin 仍须为本机）。建议经 scripts/launch.mjs 启动以自动生成 token。";

// 源码树 / 数据目录 / 配置路径。appRoot 默认取源码根（work/monitor 的上两级），
// CODEX_MONITOR_APP_ROOT / CODEX_MONITOR_DATA_DIR 等覆盖由 resolveRuntimePaths 统一处理。
export function resolveServerLocations(env = process.env) {
  // monitor-server 也可能被直接执行（例如安装后的故障排查），这时没有
  // Electron 主进程预先注入 CODEX_MONITOR_DATA_DIR；必须显式传 homeDir，
  // 否则打包 macOS .app 的回落路径会对 undefined 调 path.join 而启动即崩。
  const paths = resolveRuntimePaths({ appRoot: path.resolve(MONITOR_DIR, "../.."), env, homeDir: os.homedir() });
  return {
    paths,
    rootDir: paths.appRoot,
    runtimeDir: paths.runtimeDir,
    publicDir: path.join(MONITOR_DIR, "public"),
  };
}

// 打包版查新版本用的 GitHub 仓库（package.json 的 repository → "owner/name"）；读不到 → null。
export async function readPackageRepo(rootDir) {
  try {
    return githubRepoOf(JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")));
  } catch {
    return null;
  }
}

// 版本号：启动时读一次 package.json；读不到按 0.0.0。
export async function readPackageVersion(rootDir) {
  try {
    return JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
