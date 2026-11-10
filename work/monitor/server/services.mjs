// 路由背后的业务服务：配置审计、主机指纹库、服务器登记、本机资源探针、离线安装向导。
// 均为纯构造 + 注入；唯一的副作用是把 local-resource 探针登记进调度器。

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { createBootstrapRunner } from "../lib/bootstrap-steps.mjs";
import { createConfigAudit } from "../lib/config-audit.mjs";
import { execFileWithInput, execFileWithTimeout } from "../lib/exec.mjs";
import { createHostKeyStore } from "../lib/host-key-store.mjs";
import { createLocalResourceProbe } from "../lib/local-resource-probe.mjs";
import { createLogger } from "../lib/logger.mjs";
import { createServerRegistry } from "../lib/server-registry.mjs";

const execFileAsync = promisify(execFile);

// Bootstrap 的 exec 适配：ssh/scp 走 SSH 运行时（askpass / vault / 超时与输出上限），
// 其余命令原样 execFile。运行时的非零退出/超时翻译成 execFile 风格的异常，向导步骤据此判失败。
export function createBootstrapExec({ executeRuntime, execFileImpl = execFileAsync }) {
  return async (cmd, args, options = {}) => {
    if (cmd !== "ssh" && cmd !== "scp") return execFileImpl(cmd, args, options);
    const { timeout, maxBuffer, ...rest } = options;
    const result = await executeRuntime(cmd, args, { ...rest, timeoutMs: timeout, maxOutputBytes: maxBuffer });
    if (result.code !== 0 || result.timedOut) throw Object.assign(new Error(result.stderr || "SSH bootstrap failed"), { stderr: result.stderr, stdout: result.stdout, code: result.code });
    return result;
  };
}

export function createServices({
  runtimeDir,
  dataDir,
  localConfigPath,
  fixtureMode,
  appendLog,
  configManager,
  getMergedConfig,
  refreshConfigIntoKernel,
  credentialVault,
  executeRuntime,
  scheduler,
}) {
  const configAudit = createConfigAudit({
    filePath: path.join(runtimeDir, "logs", "config-audit.ndjson"),
    appendLog,
  });
  const hostKeyStore = createHostKeyStore({
    dataDir,
    fixtureMode,
    execFileImpl: (cmd, args, options = {}) => (
      options.input != null
        ? execFileWithInput(cmd, args, options)
        : execFileWithTimeout(cmd, args, options)
    ),
  });
  const serverRegistry = createServerRegistry({
    localConfigPath,
    writePersonalConfigImpl: (args) => configManager.savePersonalConfig(args.patch || args, args),
    readPersonalConfigImpl: () => configManager.getPersonalConfig(),
    getMergedConfig,
    refreshConfigIntoKernel,
    audit: (event) => configAudit.record(event),
    fixtureMode,
    hostKeyStore,
    credentialVault,
    askpassDir: path.join(runtimeDir, "askpass"),
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
  });
  const localResourceProbe = createLocalResourceProbe({});
  scheduler.registerProbe({
    id: "local-resource",
    layer: "resources",
    intervalMs: 15000,
    timeoutMs: 4000,
    usesSsh: false,
    run: async () => {
      const data = await localResourceProbe.sample();
      return { level: data.quality === "ok" ? "ok" : "warn", reason: data.quality, data: localResourceProbe.getSummary() };
    },
  });

  // Bootstrap 离线安装向导：与探针共享 ssh 并发上限（acquireSshSlot），source=bootstrap 日志
  // 自动进 /api/logs 与 SSE。config 传 getter 以反映活跃 server 切换。状态存内存，重启归零。
  const bootstrapLogger = createLogger("bootstrap", { dir: path.join(runtimeDir, "logs") });
  const bootstrapRunner = createBootstrapRunner({
    config: getMergedConfig,
    dataDir,
    execFileImpl: createBootstrapExec({ executeRuntime }),
    logger: bootstrapLogger,
    acquireSshSlot: (options) => scheduler.acquireSshSlot(options),
  });

  return { serverRegistry, localResourceProbe, bootstrapRunner };
}
