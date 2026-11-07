// tray-glance.mjs —— 菜单栏托盘图标旁的数字（「GPU 1/6」「CPU 32%」「作业 2」），macOS 专有（Tray.setTitle）。
//
// 托盘状态点走 SSE 的 status 事件，但那只在层级变化时推送，负载与 Slurm 计数变了不会来；
// 这里另起 30 秒一次的 /api/status 拉取（资源采集本身 60 秒一轮，再快也没有新数据）。
// 读数由 public/assets/js/render/glance-model.js 算——与悬浮岛、主控制台集群面板同一口径。
// 「菜单栏显示：不显示」时不拉取、标题清空。

import { buildGlanceModel, glanceTitle } from "../public/assets/js/render/glance-model.js";

export const TRAY_GLANCE_POLL_MS = 30000;
export const TRAY_GLANCE_FIRST_MS = 3000; // 与托盘首次订阅同一时机：monitor 冷启动期间不白打一枪
const FETCH_TIMEOUT_MS = 8000;

export function createTrayGlance({
  ctx,
  prefs,
  fetchImpl = fetch,
  timers = globalThis,
  now = Date.now,
  platform = process.platform,
}) {
  const { state, monitorBaseUrl, authToken } = ctx;
  let pollTimer = null;
  let inFlight = false;
  let lastGlance = null;
  let lastTitle = ""; // 托盘刚建好时没有标题

  const metric = () => prefs.load().trayMetric;

  function render() {
    if (!state.tray || typeof state.tray.setTitle !== "function") return;
    const title = glanceTitle(lastGlance, metric());
    if (title === lastTitle) return;
    lastTitle = title;
    // 前置空格与图标隔开；等宽数字，读数跳动时菜单栏不左右抖。
    state.tray.setTitle(title ? ` ${title}` : "", { fontType: "monospacedDigit" });
  }

  async function refresh() {
    if (inFlight) return;
    if (metric() === "off") {
      render();
      return;
    }
    inFlight = true;
    try {
      const response = await fetchImpl(`${monitorBaseUrl}/api/status`, {
        headers: { "x-auth-token": authToken },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastGlance = buildGlanceModel(await response.json(), { now: now() });
    } catch {
      lastGlance = null; // 监控服务不可达：清空数字（图标已变红），不挂过期读数
    } finally {
      inFlight = false;
    }
    render();
  }

  function stop() {
    if (pollTimer) timers.clearInterval(pollTimer);
    pollTimer = null;
  }

  function start() {
    if (platform !== "darwin" || pollTimer) return;
    pollTimer = timers.setInterval(() => {
      if (state.serverExiting) {
        stop();
        return;
      }
      refresh();
    }, TRAY_GLANCE_POLL_MS);
    const first = timers.setTimeout(() => {
      if (pollTimer && !state.serverExiting) refresh();
    }, TRAY_GLANCE_FIRST_MS);
    if (typeof first.unref === "function") first.unref();
  }

  function setMetric(value) {
    prefs.update({ trayMetric: value });
    // 已有读数时立刻换显示；不显示 → 清空；从「不显示」切回来时之前没拉过，补拉一次。
    render();
    if (metric() !== "off" && !lastGlance) refresh();
  }

  return { start, stop, refresh, getMetric: metric, setMetric };
}
