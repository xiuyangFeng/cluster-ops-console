// supervisor 的落盘簿记：注册表记录（runtimeDir/*.pid.json）、ps 读命令行，
// 以及代理平滑交接用的释放请求文件与 draining 登记。
// 任何落盘失败都吞掉（或只记日志）：簿记绝不允许影响保活主循环。
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { execFileWithTimeout } from "../exec.mjs";
import { utf8LocaleEnv } from "../process-registry.mjs";
import { readWindowsProcesses } from "../processes/query.mjs";
import { DRAINING_PROXY_RECORD_NAME, proxyReleaseRequestPath } from "../proxy/protocol.mjs";

// rootDir：应用根（子进程 cwd）；runtimeDir：注册表与控制文件目录。
export function createRuntimeIo({ rootDir, runtimeDir, registry } = {}) {
  function recordRuntimeProcess(name, pid, meta) {
    try {
      registry.recordProcess(name, pid, meta);
    } catch (err) {
      console.log(`${new Date().toISOString()} record process ${name} failed: ${err.message}`);
    }
  }

  async function removeRuntimeRecord(name) {
    try {
      await unlink(path.join(runtimeDir, `${name}.pid.json`));
    } catch {
      // 忽略
    }
  }

  async function readPidCommand(pid) {
    if (process.platform === "win32") return (await readWindowsProcesses()).find((p) => p.pid === pid)?.command || "";
    const result = await execFileWithTimeout("ps", ["-o", "command=", "-p", String(pid)], { timeoutMs: 3000, cwd: rootDir, env: utf8LocaleEnv() });
    return result.code === 0 ? result.stdout.trim() : "";
  }

  // 平滑交接里"请旧代理释放监听"的投递：写 runtime/proxy-control/release-<pid>（0700 目录）。
  // 跨平台（win32 没有 SIGUSR2），且旧版代理根本不看这个文件——能力判断失误时最坏结果是
  // 新代理等不到端口、交接失败、旧代理照常服务，而不是误杀。
  async function requestProxyRelease(oldPid) {
    const file = proxyReleaseRequestPath(runtimeDir, oldPid);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, String(Date.now()), { mode: 0o600 });
  }

  async function clearProxyRelease(oldPid) {
    try {
      await unlink(proxyReleaseRequestPath(runtimeDir, oldPid));
    } catch {}
  }

  // 交接后排空中的旧代理（≤15 分钟）：登记为 local-proxy-draining，沿用它原 local-proxy 记录的
  // 命令行/工作目录，以便 registry.stopProcess 做 pid + 命令行复核。旧代理排空退出时自己删掉
  // 这条记录（local_http_connect_proxy.mjs removeOwnDrainingRecord）；残留的死记录由注册表 GC 回收。
  // 同一时刻只保留最近一个排空中的旧代理（连续两次交接间隔很短时，更早的那个不在册）。
  async function recordDrainingProxy(oldPid) {
    const meta = registry.readMeta("local-proxy");
    const same = meta && Number(meta.pid) === Number(oldPid);
    registry.recordProcess(DRAINING_PROXY_RECORD_NAME, oldPid, {
      command: same && meta.command ? meta.command : "node work/local_http_connect_proxy.mjs",
      args: same && Array.isArray(meta.args) && meta.args.length ? meta.args : ["work/local_http_connect_proxy.mjs"],
      cwd: same && meta.cwd ? meta.cwd : rootDir,
      parentPid: same && meta.parentPid ? meta.parentPid : process.pid,
    });
  }

  async function clearDrainingProxy(oldPid) {
    const meta = registry.readMeta(DRAINING_PROXY_RECORD_NAME);
    if (meta && Number(meta.pid) === Number(oldPid)) await removeRuntimeRecord(DRAINING_PROXY_RECORD_NAME);
  }

  return {
    recordRuntimeProcess,
    removeRuntimeRecord,
    readPidCommand,
    requestProxyRelease,
    clearProxyRelease,
    recordDrainingProxy,
    clearDrainingProxy,
  };
}
