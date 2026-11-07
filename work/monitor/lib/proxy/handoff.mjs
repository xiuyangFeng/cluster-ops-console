// ---- 热更新：平滑交接（graceful handoff）----
// 新代理以 CODEX_PROXY_HANDOFF=1 启动：端口被占（旧代理仍在监听）时不立即退出，
// 每 ~20ms 重试 bind、最多 ~10s；旧代理收到"释放监听"请求后立刻关掉 listener，
// 但已建立的连接（集群侧长连接的 CONNECT 流）继续在旧进程里跑完，最多 15 分钟后退出。
// 释放请求的载体：<runtimeDir>/proxy-control/release-<pid> 文件（跨平台，win32 没有
// SIGUSR2）；POSIX 另接受 SIGUSR2。不新增任何网络管理面（不开 HTTP admin 接口）。
// 非交接模式（普通启动）撞上端口占用仍立即 exit(2)，双开照旧快速失败。
// 与 supervisor 共享的字面量约定在 ./protocol.mjs；这里是代理进程自己这一侧的时序与动作。
import path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";

import { DRAINING_PROXY_RECORD_NAME } from "./protocol.mjs";

export const HANDOFF_RETRY_MS = 20;
export const HANDOFF_BIND_TIMEOUT_MS = 10_000;
export const HANDOFF_DRAIN_MAX_MS = 15 * 60 * 1000;
const RELEASE_POLL_MS = 250;

// 只删仍指向本进程的排空记录：supervisor 可能已为更晚一次交接的旧代理覆写了这条记录。
export function removeOwnDrainingRecord({
  runtimeDir,
  pid = process.pid,
  readFile = (file) => readFileSync(file, "utf8"),
  unlink = unlinkSync,
} = {}) {
  if (!runtimeDir) return false;
  const file = path.join(runtimeDir, `${DRAINING_PROXY_RECORD_NAME}.pid.json`);
  let meta = null;
  try {
    meta = JSON.parse(readFile(file));
  } catch {
    return false;
  }
  if (!meta || Number(meta.pid) !== Number(pid)) return false;
  try {
    unlink(file);
    return true;
  } catch {
    return false;
  }
}

// 轮询释放请求文件（只 stat，不读内容；命中即删除并回调一次）。
export function watchReleaseRequest({
  file,
  intervalMs = RELEASE_POLL_MS,
  onRelease,
  exists = existsSync,
  unlink = unlinkSync,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let fired = false;
  const timer = setIntervalImpl(() => {
    if (fired) return;
    let present = false;
    try {
      present = exists(file);
    } catch {}
    if (!present) return;
    fired = true;
    clearIntervalImpl(timer);
    try {
      unlink(file);
    } catch {}
    onRelease();
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return {
    stop() {
      fired = true;
      clearIntervalImpl(timer);
    },
  };
}
