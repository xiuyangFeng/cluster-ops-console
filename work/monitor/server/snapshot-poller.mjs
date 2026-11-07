// T01 运行快照（supervisor 单一写者，monitor 只读）。
// 5s 轮询读取 runtime/supervisor-state.json，校验 schema / 大小 / 新鲜度 / 进程归属
// （pid 存活 + 注册表 pid 一致）。不可用（无快照 / 过期 / 归属失败 / 损坏）一律按
// config-only 降级——不把磁盘旧快照或配置端口伪装成已核实的运行事实。

import path from "node:path";

import {
  buildConnectionTargetsProjection,
  readRuntimeSnapshotFile,
  RUNTIME_SNAPSHOT_FILENAME,
  verifySnapshotOwnership,
} from "../lib/runtime-snapshot.mjs";

export const RUNTIME_SNAPSHOT_POLL_MS = 5000;

// "可用快照"判据的唯一实现：存在、未过期、归属已核实。此前在 connectionTargets /
// build-info / 单隧道操作三处各写一遍。
export function usableSnapshotOf(state) {
  const { snapshot, stale, owned } = state || {};
  return snapshot && !stale && owned ? snapshot : null;
}

export function createRuntimeSnapshotPoller({ runtimeDir, registry, getMergedConfig }) {
  const snapshotPath = path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME);
  let state = { snapshot: null, reason: "no-snapshot", stale: false, owned: false };

  async function poll() {
    const { snapshot, reason, stale } = await readRuntimeSnapshotFile(snapshotPath);
    let owned = false;
    if (snapshot && !stale) {
      try {
        owned = verifySnapshotOwnership(snapshot, { registry });
      } catch {
        owned = false;
      }
    }
    state = { snapshot, reason, stale: stale === true, owned };
  }

  function start() {
    setInterval(() => poll().catch(() => {}), RUNTIME_SNAPSHOT_POLL_MS).unref();
    poll().catch(() => {});
  }

  const getUsableSnapshot = () => usableSnapshotOf(state);

  return {
    poll,
    start,
    getUsableSnapshot,
    // 快照现读现判（不走 5s 缓存）：数据面交接期间要看到新 supervisor 的第一份快照。
    readFresh: () => readRuntimeSnapshotFile(snapshotPath),
    getConnectionTargets() {
      const usable = getUsableSnapshot();
      return buildConnectionTargetsProjection({
        snapshot: usable,
        snapshotState: usable ? "ok" : "missing",
        config: getMergedConfig(),
      });
    },
  };
}
