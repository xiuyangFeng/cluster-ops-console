// upgrade-marker.mjs —— 数据面升级"在飞"标记（runtimeDir/data-plane-upgrade.inflight.json）。
//
// data-plane-upgrade 编排开始时写入、结束时删除（只删自己写的）。Electron 的"重启界面"
// 据此拒绝在升级中途重启控制面（旧 monitor 被停会丢掉守护巡检 hold，交接半途而废），
// 并在确有标记时给 monitor-server 更长的优雅退出预算，让在飞的升级请求跑完。
// 可信判定：pid 仍存活 且 写入时间在 60s 内（升级最坏 ≈ 5s+20s+30s）；崩溃残留的旧标记自然失效。
// 本模块除显式传入的 fs 实现外零副作用。

import { existsSync as fsExists, readFileSync as fsRead, unlinkSync as fsUnlink } from "node:fs";
import path from "node:path";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { isPidAlive } from "./process-registry.mjs";

const DATA_PLANE_UPGRADE_MARKER_FILENAME = "data-plane-upgrade.inflight.json";
export const UPGRADE_MARKER_FRESH_MS = 60_000;
// 控制面重启时，若升级在飞，给 monitor-server 的 SIGTERM→SIGKILL 宽限（覆盖一次完整升级）。
export const UPGRADE_GRACEFUL_STOP_MS = 65_000;

export function upgradeMarkerPath(runtimeDir) {
  return path.join(runtimeDir, DATA_PLANE_UPGRADE_MARKER_FILENAME);
}

// 原子写（0600）。runtimeDir 不存在时不创建（生产中它必然存在；测试里的假路径不应被落盘）。
export function writeUpgradeMarker({
  runtimeDir,
  pid = process.pid,
  components = [],
  now = Date.now,
  existsSync = fsExists,
} = {}) {
  if (!runtimeDir || !existsSync(runtimeDir)) return false;
  const startedAt = now();
  const body = `${JSON.stringify({ version: 1, pid, startedAt, components: Array.isArray(components) ? components : [] })}\n`;
  writePrivateFileAtomicSync(upgradeMarkerPath(runtimeDir), body, { chmodDir: false });
  return true;
}

export function readUpgradeMarker({ runtimeDir, readFileSync = fsRead } = {}) {
  if (!runtimeDir) return null;
  try {
    const parsed = JSON.parse(readFileSync(upgradeMarkerPath(runtimeDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// 只删自己写的（pid 一致）。
export function removeUpgradeMarker({ runtimeDir, pid = process.pid, readFileSync = fsRead, unlinkSync = fsUnlink } = {}) {
  const marker = readUpgradeMarker({ runtimeDir, readFileSync });
  if (!marker || Number(marker.pid) !== Number(pid)) return false;
  try {
    unlinkSync(upgradeMarkerPath(runtimeDir));
    return true;
  } catch {
    return false;
  }
}

// 纯判定：标记存在、pid 存活、写入时间新鲜（允许 5s 时钟前跳）。
export function isUpgradeMarkerActive(marker, { now = Date.now(), pidAlive = isPidAlive, freshMs = UPGRADE_MARKER_FRESH_MS } = {}) {
  if (!marker || typeof marker !== "object") return false;
  const pid = Number(marker.pid);
  const startedAt = Number(marker.startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) return false;
  const age = now - startedAt;
  if (age < -5_000 || age >= freshMs) return false;
  return Boolean(pidAlive(pid));
}

export function isDataPlaneUpgradeInFlight({ runtimeDir, now = Date.now(), pidAlive = isPidAlive, readFileSync = fsRead } = {}) {
  return isUpgradeMarkerActive(readUpgradeMarker({ runtimeDir, readFileSync }), { now, pidAlive });
}
