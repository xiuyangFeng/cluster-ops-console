// app/refresh-loop.js —— 数据刷新循环：SSE 推送 + 全量 /api/status 刷新 + 兜底轮询 +
// rAF 合并渲染 + 后台省电（可见性）接线。
//
// 数据通路：SSE status 事件带概览级 lite 数据 → scheduleRender 即时合并渲染；全量刷新
// 只为补齐重输出字段（3s 防抖合并连锁变化）。SSE 断开时 onFallbackChange 打开兜底轮询
// （间隔取 #refreshSelect）；隐藏期轮询降频到 60s、防抖刷新直接跳过，恢复可见时先冲刷
// 渲染闸门缓存的最新 status，再全量刷新一次对齐。
import { createRefreshQueue } from "../refresh-queue.js";
import { createSseClient } from "../sse.js";
import { shouldRefreshOnProbe } from "../store.js";

// 隐藏期兜底轮询降频到 60s：SSE 掉线时数据不至于彻底停摆，又不空烧后台。
export const HIDDEN_POLL_INTERVAL_MS = 60000;
export const REFRESH_DEBOUNCE_MS = 3000;
// 启动后这么久还没拿到任何 status（SSE 迟迟连不上）→ 主动拉一次。
export const FIRST_LOAD_FALLBACK_MS = 1500;
// 启动时刚拿过全量 status（markFresh）后这么久内 SSE 首次连上：不再整页重拉一遍（见 startSse 的 onOpen）。
export const BOOT_FRESH_MS = 2000;

export function createRefreshLoop({
  loadStatus, render, getStatus, reportError, setStale, fetchIncidents,
  logsPanel, logStream, handleRunbookLog, eventsUrl, pollSelect,
  isHidden, onVisibilityChange, flushRender,
  createSse = createSseClient,
  timers = {},
  now = () => Date.now(),
}) {
  const setTimeoutFn = timers.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const setIntervalFn = timers.setInterval || ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = timers.clearInterval || ((id) => clearInterval(id));
  const raf = timers.requestAnimationFrame || ((fn) => requestAnimationFrame(fn));

  let pollTimer = null;
  let fallbackActive = true;
  let refreshDebounce = null;
  let pendingRenderStatus = null;
  let renderQueued = false;
  let freshAt = 0; // 启动时那次全量 status 落地的时刻（markFresh）
  let sseOpened = false;
  const lastProbeLevels = Object.create(null);

  const refreshQueue = createRefreshQueue({
    load: loadStatus,
    commit: (data) => {
      setStale(false);
      // 全量结果比任何排队中的 rAF 渲染都新：丢掉排队项，免得下一帧用旧 lite 合并值覆盖。
      pendingRenderStatus = null;
      render(data);
      if (fallbackActive) logsPanel.refresh();
      // T06：事件数据随刷新周期更新（轻量接口；失败静默，事件视图有独立空态）。
      fetchIncidents();
    },
    onError: (err) => {
      reportError(err, "refresh");
      console.error(`监控连接失败: ${err?.message}`);
    },
  });
  const refresh = (options) => refreshQueue(options);

  // 状态 + 日志面板 + 实时日志流一起对齐（SSE 重连、首载兜底、恢复可见共用）。
  function refreshAll() {
    refresh();
    logsPanel.refresh();
    logStream.refresh();
  }

  function applyPolling() {
    if (pollTimer) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
    const interval = Number.parseInt(pollSelect?.value, 10);
    if (!fallbackActive || !(interval > 0)) return;
    pollTimer = setIntervalFn(() => refresh(), isHidden() ? Math.max(interval, HIDDEN_POLL_INTERVAL_MS) : interval);
  }

  // SSE status 事件已带概览级数据（scheduleRender 即时渲染），这里的全量 /api/status
  // 只为补齐重输出字段；防抖把连锁 level 变化合并成一次往返。
  // 隐藏期直接跳过：恢复可见的接线里会触发一次全量 refresh 对齐。
  function scheduleRefresh() {
    if (isHidden() || refreshDebounce) return;
    refreshDebounce = setTimeoutFn(() => {
      refreshDebounce = null;
      refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  // rAF 渲染合并：SSE 事件密集到达时同帧只渲染一次（保留最新 status）。
  function scheduleRender(status) {
    if (isHidden()) {
      // 隐藏期无帧可合并（rAF 被挂起）：直接走 render 完成数据提交 + 闸门缓存
      // （无 DOM 写入），并清空 rAF 挂起项，避免恢复可见后一次陈旧的 rAF 回调
      // 用隐藏前的旧 status 覆盖闸门冲刷出的新状态。
      pendingRenderStatus = null;
      render(status);
      return;
    }
    pendingRenderStatus = status;
    if (renderQueued) return;
    renderQueued = true;
    raf(() => {
      renderQueued = false;
      const next = pendingRenderStatus;
      pendingRenderStatus = null;
      if (next) render(next);
    });
  }

  function startSse() {
    const client = createSse({
      url: () => eventsUrl("/api/events"),
      onOpen: () => {
        // 首次连上时启动那次全量 status 才落地几十毫秒（perf）：不再整页重拉、重渲一遍——建连首帧的 status 事件
        // 会立即合并渲染，并经防抖补一次全量。日志与事件照常对齐（原来由那次全量刷新的提交带出来）。
        const bootFresh = !sseOpened && freshAt > 0 && now() - freshAt < BOOT_FRESH_MS;
        sseOpened = true;
        if (!bootFresh) {
          refreshAll();
          return;
        }
        logsPanel.refresh();
        logStream.refresh();
        fetchIncidents();
      },
      onStatus: ({ lite, layers }) => {
        const last = getStatus();
        if (last) scheduleRender({ ...last, ...(lite || {}), layers: layers || last.layers });
        scheduleRefresh();
      },
      onProbe: (probe) => {
        if (shouldRefreshOnProbe(probe, lastProbeLevels)) scheduleRefresh();
        if (probe && probe.id != null) lastProbeLevels[probe.id] = probe.level;
      },
      onLog: (entry) => {
        // 隐藏期跳过日志的 DOM 写入（不做本地缓冲——恢复可见时 logsPanel/logStream
        // 各自 refresh() 从服务端重播种，与 SSE onOpen 同路径，结果一致且更省）。
        // runbook 状态机必须照常推进：隐藏期进行/结束的一键修复，恢复后进度条目才正确。
        if (!isHidden()) {
          logsPanel.appendEntry(entry);
          logStream.append(entry);
        }
        handleRunbookLog(entry);
      },
      onFallbackChange: (active) => {
        fallbackActive = active;
        applyPolling();
        if (active) refresh();
      },
    });
    client.start();
    return client;
  }

  pollSelect?.addEventListener("change", applyPolling);
  // 后台省电接线（v2.17）：隐藏时 SSE 保持连接（断开再重连成本更高，且丢事件）；
  // 只是渲染进闸门缓存、兜底轮询降频、CSS 动画由 body[data-console-hidden] 全局闸暂停。
  onVisibilityChange?.((hidden) => {
    applyPolling(); // 隐藏 → 兜底轮询降频 60s；恢复 → 回到用户所选间隔
    if (hidden) return;
    // 恢复可见：先用隐藏期缓存的最新 status 立即渲染一帧（所有面板对齐到当前状态，
    // 不显示隐藏期间的旧数据），再全量刷新补齐重输出字段；隐藏期日志跳过了 DOM 写入，
    // 一并从服务端重播种。
    flushRender();
    refreshAll();
  });

  function start() {
    startSse();
    setTimeoutFn(() => {
      if (!getStatus()) refreshAll();
    }, FIRST_LOAD_FALLBACK_MS);
    applyPolling();
  }

  // app.js 启动时直接拉了首包 status 并渲染（不经刷新队列）：告诉这里那份数据是刚拿的。
  function markFresh() {
    freshAt = now();
  }

  return { refresh, scheduleRefresh, scheduleRender, start, markFresh };
}
