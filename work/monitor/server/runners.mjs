// 两个执行器（T04b 单隧道操作 / 数据面热升级）及其与通道生命周期的互斥。
// 互斥是双向的：执行器在飞挡下通道重启（channel.isBlocked），通道修复/重启在飞挡下执行器
// （isChannelBusy / isBusy）。执行器晚于通道创建，通道侧只经 start.mjs 的 late 槽位读取它们
// （槽位由 start.mjs 统一填写，本模块只读）。

import { createDataPlaneUpgrader } from "../lib/data-plane-upgrade.mjs";
import { createOperationsRunner } from "../lib/operations-runner.mjs";

// 通道重启闸门：任一执行器在飞即挡（首拍之前槽位为空，恒为 false）。
// T04b：单隧道操作在飞时同样挡下通道重启（保守串行化，M1 不扩大并发）。
export function isAnyRunnerInFlight(late) {
  return late.operationsRunner?.isInFlight() === true
    || late.dataPlaneUpgrader?.isInFlight() === true
    || ["backup", "install"].includes(late.packageUpdater?.status()?.phase);
}

// 数据面升级的拒绝原因（空串 = 可以升级）。
export function dataPlaneBusyReason({ channel, operationsRunner }) {
  if (channel.getRepairInFlight()) return "channel repair/restart in progress";
  if (operationsRunner.isInFlight()) return "tunnel operation in progress";
  return "";
}

export function createRunners({
  channel,
  getConfig,
  runtimeDir,
  registry,
  fixtureMode,
  appendLog,
  writeTimeline,
  snapshots,
  // 磁盘新包的数据面组件指纹（与 /api/build-info 的 dataPlane.bundle 同源）：数据面升级的幂等判据。
  getBundleComponents = async () => null,
  // 单隧道操作受理回调（start.mjs 接到事件关联：「查看处置日志」）。
  onOperationAccepted,
  isPackageUpdating = () => false,
}) {
  // ---- T04b 单隧道操作（preview → run → query；结果经本机控制信箱）----
  const operationsRunner = createOperationsRunner({
    runtimeDir,
    getConfig,
    // 可用运行快照（已验证归属且未过期）；不可用时返回 null → 503 诚实降级。
    getSnapshot: snapshots.getUsableSnapshot,
    log: appendLog,
    timeline: writeTimeline,
    isChannelBusy: () => isPackageUpdating() || channel.getRepairInFlight(),
    onAccepted: onOperationAccepted,
  });

  // ---- 热更新：数据面（supervisor / 本地代理）零断连交接 ----
  // 快照现读现判（不用 5s 轮询缓存：交接期间要看到新 supervisor 的第一份快照）。
  // 交接窗口内 hold 住守护巡检，避免它抢先拉起第二个 supervisor；新 supervisor 走与巡检
  // 同一条 spawn 路径（当前 process.execPath + appRoot 下的新代码）。
  // 幂等：运行中的组件已是新包代码就跳过（过期横幅 / 重复请求不再白白交接一次）；交接结束立即
  // 重读一次快照进 5s 缓存，/api/build-info 马上看到新 supervisor（见 lib/data-plane-upgrade.mjs 文件头）。
  const dataPlaneUpgrader = createDataPlaneUpgrader({
    registry,
    runtimeDir,
    readSnapshot: snapshots.readFresh,
    getBundleComponents,
    afterSettled: () => snapshots.poll(),
    spawnSupervisor: (options) => channel.spawnSupervisor(options),
    holdAutoRepair: () => channel.holdAutoRepair(),
    shouldBeRunning: () => channel.getShouldBeRunning(),
    fixtureMode,
    isBusy: () => isPackageUpdating() ? "workbench update in progress" : dataPlaneBusyReason({ channel, operationsRunner }),
    log: appendLog,
  });

  return { operationsRunner, dataPlaneUpgrader };
}
