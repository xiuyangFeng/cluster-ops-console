// channel-supervisor —— 数据面守护进程入口：拉起本地 CONNECT 代理与每台服务器一条 ssh -R，
// 崩溃恢复、孤儿接管、热更新零中断交接。实现分布在 lib/supervisor/（见 service.mjs）；
// 本文件只做两件事：
//   1) 作为进程入口（isMain）按固定顺序启动：构建元信息 → 组件指纹 → 单实例自检 →
//      pid 登记 + 信号处理 → 主循环；
//   2) 被 import 时零副作用：不创建日志、不建目录、不起任何进程（本文件没有导出，
//      测试与 monitor 侧直接从 lib/supervisor/*.mjs 取实现）。
// 注意：数据面热更新指纹 = 本文件的静态相对 import 闭包（lib/component-version.mjs），
// 新增依赖一律用静态相对 import。
// 第一个 import：Windows 安装版的子进程（ssh）不弹命令行窗口（见该文件说明）。
import "./lib/windows-hide-children.mjs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { freezeBuildInfo } from "./lib/build-info.mjs";
import { computeComponentHashes } from "./lib/component-version.mjs";
import { createLogger } from "./lib/logger.mjs";
import { createProcessRegistry } from "./lib/process-registry.mjs";
import { resolveRuntimePaths } from "./lib/runtime-paths.mjs";
import { findSupervisorToYieldTo } from "./lib/supervisor/bootstrap.mjs";
import { createConfigLoader } from "./lib/supervisor/config.mjs";
import { createSupervisorLog } from "./lib/supervisor/log-policy.mjs";
import { createRuntimeIo } from "./lib/supervisor/runtime-io.mjs";
import { loadOrCreateTunnelOwnerId } from "./lib/supervisor/owner-id.mjs";
import { sanitizeMachineLabel } from "./lib/supervisor/sibling-tunnel.mjs";
import { createSupervisorService } from "./lib/supervisor/service.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(__dirname, "../..");
// homeDir 必传：打包模式下若没有 CODEX_MONITOR_DATA_DIR（例如手工启动），dataRoot 必须落到
// ~/Library/Application Support 而不是抛错或写进签名的 .app 包内。
const paths = resolveRuntimePaths({ appRoot: sourceRoot, env: process.env, homeDir: os.homedir() });
const rootDir = paths.appRoot;
const runtimeDir = paths.runtimeDir;

// CHECK_INTERVAL_MS 主要用于冒烟/故障排查时调快巡检；它来自继承的环境，
// 不能把负数/小数传给 sleep（会形成忙循环，持续打 SSH），也不能让极大值
// 把隧道修复推迟到几小时后。保留合理的 250ms 下限和 5 分钟上限。
export function resolveCheckInterval(raw, fallback = 5000) {
  const value = raw == null || raw === "" ? fallback : Number(raw);
  return Number.isInteger(value) && value >= 250 && value <= 300_000 ? value : fallback;
}

const checkIntervalMs = resolveCheckInterval(process.env.CHECK_INTERVAL_MS);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

// 结构化日志（runtime/logs/supervisor.ndjson）只在作为 supervisor 进程运行时创建；
// 创建失败时 log() 只写 stdout。活跃服务器取自运行中的服务状态。
let fileLogger = null;
let service = null;
const log = createSupervisorLog({
  getFileLogger: () => fileLogger,
  getChannelId: () => service?.state.currentServerId ?? null,
});

if (isMain) {
  // 构建元信息：启动时读入一次并冻结（运行快照只取 version / gitCommit）。
  const supervisorBuildInfo = await freezeBuildInfo(sourceRoot);

  // 热更新：本进程代码的组件指纹，启动时算一次并冻结（运行中磁盘被新包覆盖也不变），
  // 经运行快照发布给 monitor 与磁盘新包比较。算不出来 → ""（按"未知 ⇒ 需要交接"处理）。
  let supervisorComponentHash = "";
  try {
    supervisorComponentHash = (await computeComponentHashes(sourceRoot)).supervisor || "";
  } catch {}

  const sessionId = randomBytes(4).toString("hex");
  const supervisorStartedAt = Date.now();

  // 进程注册表（work/runtime/*.pid.json）与结构化日志。
  // 两者都不允许影响保活主循环：任何落盘失败都吞掉。
  const registry = createProcessRegistry({ runtimeDir });
  try {
    fileLogger = createLogger("supervisor", { dir: path.join(runtimeDir, "logs"), defaultFields: { sessionId } });
  } catch {
    fileLogger = null;
  }
  const io = createRuntimeIo({ rootDir, runtimeDir, registry });

  const existing = await findSupervisorToYieldTo({ registry, readCmdline: io.readPidCommand });
  if (existing) {
    log(`another channel-supervisor (pid=${existing.pid}) is alive, yielding and exiting`);
    process.exit(3);
  }

  log("supervisor started");
  io.recordRuntimeProcess("channel-supervisor", process.pid, {
    command: "node work/monitor/channel-supervisor.mjs",
    args: ["work/monitor/channel-supervisor.mjs"],
    cwd: rootDir,
    parentPid: process.ppid,
  });

  const configLoader = createConfigLoader({
    configPath: paths.configPath,
    localConfigPath: paths.localConfigPath,
    dataRoot: paths.dataRoot,
    log,
  });
  service = createSupervisorService({
    rootDir,
    runtimeDir,
    instanceId: sessionId,
    tunnelOwnerId: loadOrCreateTunnelOwnerId(runtimeDir),
    machineLabel: sanitizeMachineLabel(os.hostname()),
    startedAt: supervisorStartedAt,
    build: supervisorBuildInfo,
    componentHash: supervisorComponentHash,
    checkIntervalMs,
    registry,
    io,
    log,
    loadConfig: configLoader.loadConfig,
    getAutoRepair: configLoader.getAutoRepair,
  });

  process.on("SIGINT", service.shutdown);
  process.on("SIGTERM", service.shutdown);
  // 热更新交接退出的 POSIX 加速器（win32 没有 SIGUSR2，走信箱 handoff-exit）。
  // 注意：旧版 supervisor 没有这个监听，SIGUSR2 的默认动作是直接终止——monitor 只在
  // 运行快照声明 capabilities.handoffExit 时才发它。
  if (process.platform !== "win32") process.on("SIGUSR2", () => service.startHandoffExit("SIGUSR2"));
  process.on("uncaughtException", (err) => service.crashGuard("uncaughtException", err));
  process.on("unhandledRejection", (err) => service.crashGuard("unhandledRejection", err));

  // 核心循环
  service.run();
}
