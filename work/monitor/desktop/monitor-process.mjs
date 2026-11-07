// monitor-process.mjs —— monitor-server 子进程：端口回收、启动、崩溃自愈（指数退避）。
//
// monitor-server 是控制面（HTTP + SSE），随 Electron 主进程启停；数据面（supervisor / 代理 /
// 隧道）是 detached 进程，不归这里管。停止 monitor-server 的编排在 quit.mjs 的 cleanupBackground。
//
// v2.64：拉起失败、异常退出、按退避重启、「连续 N 次异常退出，停止自动重启」另写一份结构化事件到
// runtime/logs/desktop.ndjson（eventLog，入口注入的主进程日志器；origin desktop-shell）——开机自启时标准输出被丢弃，
// 只走 console 的话谁也看不见。console 输出照旧。

import { execFile, spawn as defaultSpawn } from "node:child_process";
import { promisify } from "node:util";

import { computeServerRestartPolicy, waitForServerReady } from "../desktop-lifecycle.mjs";
import { utf8LocaleEnv } from "../lib/process-registry.mjs";

const MONITOR_SERVER_SCRIPT = "work/monitor/monitor-server.mjs";

export function createMonitorProcess({
  ctx,
  registry,
  spawn = defaultSpawn,
  execFileAsync = promisify(execFile),
  waitForReady = waitForServerReady,
  fetchImpl = fetch,
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
  pid = process.pid,
  killProcess = (target, signal) => process.kill(target, signal),
  timers = globalThis,
  logger = console,
  eventLog = null,
}) {
  const { state, actions, rootDir, runtimePaths, monitorPort, statusLiteUrl, authToken, vaultToken } = ctx;
  let serverRestartFailures = 0; // 连续失败次数，就绪探测成功后清零
  const event = (level, message, fields) => {
    try { eventLog?.[level](message, { origin: "desktop-shell", ...fields }); } catch {}
  };

  // 检查端口是否被占用（异步，避免 execSync 阻塞主进程）
  async function isPortInUse(port) {
    try {
      await execFileAsync("lsof", [`-i:${port}`]);
      return true;
    } catch {
      return false;
    }
  }

  // pkill 兜底：pgrep -f 列出候选，逐个 pid 用 ps 复核命令行必须包含本项目 rootDir
  // 才允许 kill，绝不按模式盲杀（防止误伤其他 checkout 或无关 ssh 进程）。win32 自带 OpenSSH
  // 没有 pgrep/ps，模糊兜底不可用：跳过并记日志，依赖 process-registry 的 pid.json 路径。
  async function pkillScopedByPattern(pattern) {
    if (platform === "win32") {
      logger.log("[pkill-fallback] skipped on this platform; relying on process registry");
      return;
    }
    let pids = [];
    try {
      const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
      pids = stdout.split(/\s+/).filter(Boolean);
    } catch {
      return; // pgrep 无匹配时退出非零
    }
    for (const raw of pids) {
      const target = Number(raw);
      if (!Number.isInteger(target) || target === pid) continue;
      let cmdline = "";
      try {
        // UTF-8 区域：rootDir 含中文时，C 区域下 macOS ps 会把它转义成 M-...，includes 永假。
        const { stdout } = await execFileAsync("ps", ["-o", "command=", "-p", String(target)], { env: utf8LocaleEnv() });
        cmdline = stdout.trim();
      } catch {
        continue; // 进程已消失
      }
      if (!cmdline.includes(rootDir)) continue; // 命令行不含本 rootDir → 不属于本 checkout，跳过
      try {
        killProcess(target, "SIGTERM");
        logger.log(`[pkill-fallback] SIGTERM ${target} (${pattern})`);
      } catch {}
    }
  }

  // 若 8877 被占用，优先用注册表按 pid 校验后停止本会话记录的 monitor-server，再做 rootDir 兜底。
  async function reclaimMonitorPortIfNeeded() {
    if (!(await isPortInUse(monitorPort))) return;
    logger.log(`Port ${monitorPort} already in use. Attempting scoped reclaim of a stale monitor-server.`);
    if (registry.readMeta("monitor-server")) {
      const result = await registry.stopProcess("monitor-server").catch((err) => ({ stopped: false, reason: err.message }));
      logger.log("[reclaim] stopProcess monitor-server:", result);
    }
    await pkillScopedByPattern(MONITOR_SERVER_SCRIPT);
  }

  // 启动 Node 运维监控后端服务
  async function startMonitorServer() {
    const vaultHttp = await actions.startCredentialVault();
    await reclaimMonitorPortIfNeeded();
    // 退出清理可能在上面的 await 期间开始：此后绝不能再 spawn（新进程会被 app.exit
    // 孤儿化并占住 8877），也绝不能把 serverExiting 复位而破坏清理逻辑的抑制标志。
    //（保管库只在显式退出清理里关闭，那时 isQuitting 已为 true，走不到下面用 vaultHttp 的地方。）
    if (state.isQuitting || state.serverExiting) return;
    logger.log("Starting backend Node service...");
    const child = spawn(execPath, [MONITOR_SERVER_SCRIPT], {
      cwd: rootDir,
      stdio: "inherit",
      env: {
        ...env,
        // 打包后 process.execPath 是 Electron 主二进制而非 node；不设此标志，spawn 会拉起
        // 第二个 Electron GUI 实例而不是把 .mjs 当 node 脚本跑，monitor-server 永远绑不上
        // 8877，窗口白屏。设为 "1" 让该子进程（及其后代 supervisor/proxy，经 env 继承）以
        // 纯 node 运行。dev 模式下 execPath 是 node_modules 的 electron，同样需要此标志。
        ELECTRON_RUN_AS_NODE: "1",
        PORT: String(monitorPort),
        CODEX_MONITOR_APP_ROOT: runtimePaths.appRoot,
        CODEX_MONITOR_DATA_DIR: runtimePaths.dataRoot,
        CODEX_MONITOR_CONFIG_PATH: runtimePaths.configPath,
        CODEX_MONITOR_LOCAL_CONFIG_PATH: runtimePaths.localConfigPath,
        CODEX_MONITOR_VAULT_URL: vaultHttp?.url || "",
        CODEX_MONITOR_VAULT_TOKEN: vaultToken,
      },
    });
    state.serverProcess = child;
    if (child.pid) {
      // 登记 monitor-server，退出/重占端口时可按 pid 校验后安全停止。
      registry.recordProcess("monitor-server", child.pid, {
        command: `node ${MONITOR_SERVER_SCRIPT}`,
        args: [MONITOR_SERVER_SCRIPT],
        cwd: rootDir,
        parentPid: pid,
      });
    }
    // 拉起本身失败（找不到可执行文件、资源不够）时 ChildProcess 发 error；不接住会变成主进程的未捕获异常。
    child.on("error", (err) => {
      logger.error(`monitor-server 拉起失败：${err?.message || err}`);
      event("error", `监控服务拉起失败：${err?.message || err}`, { event: "monitor-spawn-failed", code: err?.code ?? null });
    });
    child.on("exit", (code, signal) => handleServerExit(code, signal));
  }

  // serverProcess 退出监听：显式退出/主动清理不重启；否则按纯函数策略指数退避重启，超上限则托盘变红。
  function handleServerExit(code, signal) {
    state.serverProcess = null;
    if (state.isQuitting || state.serverExiting) return;
    serverRestartFailures += 1;
    const policy = computeServerRestartPolicy({ consecutiveFailures: serverRestartFailures });
    if (!policy.shouldRestart) {
      logger.error(`monitor-server 连续 ${serverRestartFailures} 次异常退出（code=${code}, signal=${signal}），停止自动重启。`);
      event("error", `监控服务连续 ${serverRestartFailures} 次异常退出，已停止自动重启`, { event: "monitor-restart-give-up", failures: serverRestartFailures, code: code ?? null, signal: signal ?? null });
      actions.markTrayDown("监控服务反复崩溃，已停止自愈");
      return;
    }
    logger.warn(`monitor-server 退出(code=${code}, signal=${signal})，${policy.delayMs}ms 后第 ${serverRestartFailures} 次重启。`);
    event("warn", `监控服务异常退出，${Math.round(policy.delayMs / 1000)} 秒后第 ${serverRestartFailures} 次重启`, { event: "monitor-exited", failures: serverRestartFailures, code: code ?? null, signal: signal ?? null, delayMs: policy.delayMs });
    state.serverRestartTimer = timers.setTimeout(async () => {
      state.serverRestartTimer = null;
      if (state.isQuitting || state.serverExiting) return;
      await startMonitorServer();
      const ready = await waitForReady({
        url: statusLiteUrl,
        token: authToken,
        intervalMs: 250,
        timeoutMs: 15000,
        fetchImpl,
      });
      if (ready) {
        serverRestartFailures = 0; // 就绪探测成功后清零失败计数
        logger.log("monitor-server 重启后已就绪，重置失败计数。");
        event("info", "监控服务重启后已就绪", { event: "monitor-restarted" });
      }
    }, policy.delayMs);
  }

  return { pkillScopedByPattern, reclaimMonitorPortIfNeeded, startMonitorServer };
}
