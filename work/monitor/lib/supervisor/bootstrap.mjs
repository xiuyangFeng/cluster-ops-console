// supervisor 进程启动时的单实例自检（构建元信息与 monitor 共用 lib/build-info.freezeBuildInfo）。
import { isPidAlive, shouldYieldToExisting } from "../process-registry.mjs";

// 单实例自检：注册表里已有存活且命令行匹配的 supervisor 时应立即让位退出，
// 杜绝 autoRepair 巡检可见性窗口或手工重复启动造成的双实例互踩
// （抢本地代理端口、向同一 remotePort 重复建隧道触发退避重试风暴）。
// 返回需要让位的那个 supervisor 的注册表记录；不需要让位返回 null。
export async function findSupervisorToYieldTo({
  registry,
  readCmdline,
  selfPid = process.pid,
  isAlive = isPidAlive,
} = {}) {
  const existingMeta = registry.readMeta("channel-supervisor");
  if (!existingMeta || existingMeta.pid === selfPid) return null;
  const alive = isAlive(existingMeta.pid);
  const cmdline = alive ? await readCmdline(existingMeta.pid) : "";
  const yieldNow = shouldYieldToExisting({
    meta: existingMeta,
    selfPid,
    alive,
    cmdline,
    expect: "channel-supervisor.mjs",
  });
  return yieldNow ? existingMeta : null;
}
