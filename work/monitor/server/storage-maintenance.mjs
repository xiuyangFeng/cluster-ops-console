// 本地数据维护：runtime/ 总预算清理（lib/storage-sweeper.mjs，设计 §6.6）。
// logs 分卷、history 按天文件、metrics.json 各自有界，加总却能悄悄涨到几百 MB。
// 这里给 runtime/ 一个总闸：启动 10 秒后扫一次，之后每小时一次，超预算就从最没有
// 信息量的文件（多余日志分卷 → 最旧 history → 最后一份分卷）开始淘汰。
// 同一轮里另清两类不看预算的孤儿：没人再读的 `.2` 及更早的日志分卷、已退出的 supervisor 留下的
// 空控制信箱目录——后者要先知道「当前 supervisor 是哪一个」，由这里读运行快照告诉清理器。

import path from "node:path";

import { readRuntimeSnapshotFile, RUNTIME_SNAPSHOT_FILENAME } from "../lib/runtime-snapshot.mjs";
import { createStorageSweeper } from "../lib/storage-sweeper.mjs";

export const DEFAULT_STORAGE_BUDGET_BYTES = 50 * 1024 * 1024; // runtime/ 本地数据总预算
const STORAGE_SWEEP_INTERVAL_MS = 3600000; // 常规清理周期（1 小时）
const STORAGE_SWEEP_START_DELAY_MS = 10000; // 启动后首扫延迟：让首轮探针/热启动先跑完再碰盘

// 预算取合并配置的 storageBudgetBytes（团队层可调、个人层可覆盖），非法/缺省时 50MB。
export function resolveStorageBudgetBytes(config) {
  const raw = Number(config?.storageBudgetBytes);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STORAGE_BUDGET_BYTES;
}

// 当前 supervisor 的控制信箱实例号：取自它自己写的运行快照 runtime/supervisor-state.json
// （channel-supervisor.pid.json 里只有 pid，没有实例号）。只认新鲜的快照——supervisor 约 15 秒刷新一次，
// 30 秒内写过才算它此刻活着、这个实例号此刻有主。没有快照 / 读不出 / 已过期（通道停着、supervisor 刚退出、
// 电脑刚唤醒）一律返回 null：这一轮信箱目录一棵都不删，等下一个整点。
export async function readLiveControlInstanceId(runtimeDir, { nowMs = Date.now() } = {}) {
  const { snapshot, reason } = await readRuntimeSnapshotFile(path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME), { nowMs });
  return snapshot && reason === "ok" ? snapshot.instanceId : null;
}

export function createStorageMaintenance({ runtimeDir, getMergedConfig, appendLog }) {
  const sweeper = createStorageSweeper({
    runtimeDir,
    budgetBytes: resolveStorageBudgetBytes(getMergedConfig()),
    log: appendLog,
    getLiveControlInstanceId: () => readLiveControlInstanceId(runtimeDir),
  });
  let sweepStartTimer = null;
  let sweepIntervalTimer = null;

  // 配置热载后新预算要立刻生效，但 sweeper 不该自己去读配置（多一条依赖、多一处解析）：
  // 每次真正要扫之前灌一次即可，这就是"重新读取"路线里最省事的那半。
  async function runSweep(options) {
    sweeper.setBudget(resolveStorageBudgetBytes(getMergedConfig()));
    return sweeper.sweep(options);
  }

  // unref：磁盘清理不应成为进程存活的理由（listen 的句柄才是）。
  function startSweepSchedule() {
    sweepStartTimer = setTimeout(() => {
      runSweep().catch(() => {});
      sweepIntervalTimer = setInterval(() => runSweep().catch(() => {}), STORAGE_SWEEP_INTERVAL_MS);
      sweepIntervalTimer.unref();
    }, STORAGE_SWEEP_START_DELAY_MS);
    sweepStartTimer.unref();
  }

  return {
    // 路由拿到的是同一个 sweeper，只是 sweep 走上面的预算刷新包装。
    sweeperForRouter: {
      measure: sweeper.measure,
      getState: sweeper.getState,
      sweep: runSweep,
    },
    startSweepSchedule,
    // 退出途中不再启动新的删除轮次。
    stopSweeper() {
      clearTimeout(sweepStartTimer);
      if (sweepIntervalTimer) clearInterval(sweepIntervalTimer);
      sweeper.dispose();
    },
  };
}
