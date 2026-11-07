// T01 运行快照（runtime/supervisor-state.json）的单一写者。配置/目标变化即写；无变化时
// 每 3 拍（约 15s，须明显短于读取侧 30s 的 stale 窗口）刷新 observedAt。
// 写失败只限频告警，绝不断隧道。
import { buildRuntimeSnapshot, computeConfigRevision, writeRuntimeSnapshotFile } from "../runtime-snapshot.mjs";
import { buildTunnelSignature } from "./tunnel-spec.mjs";

const SNAPSHOT_REFRESH_MS = 15000;

// state：supervisor 共享状态（effectiveProxyPort / firstTickCompletedAt 在写入时现读）；
// controllers / proxyController：读每条隧道的配置身份与代理回报的身份。
export function createSnapshotWriter({
  snapshotPath,
  state,
  controllers,
  proxyController,
  instanceId,
  pid = process.pid,
  startedAt,
  build,
  componentHash,
  log = () => {},
  writeSnapshotFile = writeRuntimeSnapshotFile,
  now = Date.now,
  // 本机身份：{ label, ownerId }（同账号多台 Mac 接力的显示用）。
  machine = null,
} = {}) {
  let lastSnapshotKey = null;
  let lastSnapshotWriteAt = 0;
  let lastSnapshotWarnAt = 0;

  return async function writeSnapshot({ config, tunnels }) {
    const nowMs = now();
    const targets = {};
    for (const target of tunnels) {
      if (!target?.id) continue;
      const identity = controllers.get(target.id)?.controller?.getState();
      targets[target.id] = {
        host: target.host,
        remotePort: target.remotePort,
        localPort: target.localPort,
        signature: buildTunnelSignature(target),
        ...(identity ? { configApplied: identity.configApplied, configIdentityState: identity.configIdentityState } : {}),
        // 待命（同账号另一台 Mac 在承载）。checkedAt 不进快照：它每 30 秒变一次，会让快照每拍重写。
        ...(identity?.standby ? { handover: { role: "standby", since: identity.standby.since, reason: identity.standby.reason, health: identity.standby.health, holder: identity.standby.holder } } : {}),
      };
    }
    const snapshot = buildRuntimeSnapshot({
      instanceId,
      pid,
      startedAt,
      observedAt: nowMs,
      configRevision: computeConfigRevision(config),
      build,
      capabilities: { scopedTunnelRestart: true, controlProtocol: 1, handoffExit: true, proxyHandoff: true, siblingTakeover: true },
      effectiveProxyPort: state.effectiveProxyPort,
      targets,
      components: {
        supervisor: componentHash,
        proxy: proxyController.getState().observed?.component || "",
      },
      proxyPid: proxyController.getState().observed?.pid ?? undefined,
      firstTickCompletedAt: state.firstTickCompletedAt ?? undefined,
      machine,
    });
    const key = JSON.stringify([snapshot.configRevision, state.effectiveProxyPort, targets, snapshot.build.gitCommit,
      snapshot.components, snapshot.proxyPid, snapshot.firstTickCompletedAt]);
    const changed = key !== lastSnapshotKey;
    if (!changed && nowMs - lastSnapshotWriteAt < SNAPSHOT_REFRESH_MS) return;
    try {
      await writeSnapshotFile(snapshotPath, snapshot);
      lastSnapshotKey = key;
      lastSnapshotWriteAt = nowMs;
    } catch (err) {
      if (nowMs - lastSnapshotWarnAt > 60000) {
        lastSnapshotWarnAt = nowMs;
        log(`runtime snapshot write failed: ${err.message}`, { level: "warn", event: "snapshot-write-error" });
      }
    }
  };
}
