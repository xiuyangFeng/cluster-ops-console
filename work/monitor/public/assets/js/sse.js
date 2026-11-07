// sse.js —— EventSource 连接管理：指数退避重连（1s→30s），
// 并通过 onFallbackChange(active) 通知外部启停轮询兜底。

// 指数退避计算：首次 1s，之后翻倍，封顶 30s。纯函数，便于测试。
export function computeBackoff(current, { base = 1000, max = 30000 } = {}) {
  if (!current || current < base) return base;
  return Math.min(current * 2, max);
}

// 退避加 ±20% 随机抖动：多个客户端（主窗口/多标签）同时掉线时错峰重连，
// 避免同一时刻挤兑后端 SSE 连接上限。纯函数，随机源可注入便于测试。
export function applyJitter(ms, rand = Math.random) {
  const delta = (rand() * 2 - 1) * 0.2 * ms;
  return Math.max(0, Math.round(ms + delta));
}

// createSseClient：url 可为字符串或返回字符串的函数（便于每次重连附带最新 token）。
export function createSseClient({
  url,
  onStatus,
  onProbe,
  onLog,
  onOpen,
  onFallbackChange,
  EventSourceImpl,
} = {}) {
  const ESImpl = EventSourceImpl || (typeof EventSource !== "undefined" ? EventSource : null);
  let es = null;
  let backoff = 0;
  let reconnectTimer = null;
  let connected = false;
  let stopped = false;
  let fallbackActive = null;

  const resolveUrl = () => (typeof url === "function" ? url() : url);

  function setFallback(active) {
    if (fallbackActive === active) return;
    fallbackActive = active;
    if (onFallbackChange) {
      try {
        onFallbackChange(active);
      } catch {}
    }
  }

  function parse(ev, handler) {
    if (!handler) return;
    try {
      handler(JSON.parse(ev.data));
    } catch {
      // 单条事件解析失败不影响连接。
    }
  }

  function cleanup() {
    if (es) {
      try {
        es.close();
      } catch {}
      es = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    backoff = computeBackoff(backoff);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, applyJitter(backoff));
  }

  function connect() {
    if (stopped) return;
    if (!ESImpl) {
      // 环境不支持 EventSource：唯一的数据通道是轮询，必须显式激活兜底。
      setFallback(true);
      return;
    }
    cleanup();
    try {
      es = new ESImpl(resolveUrl());
    } catch {
      setFallback(true);
      scheduleReconnect();
      return;
    }

    es.addEventListener("open", () => {
      connected = true;
      backoff = 0;
      setFallback(false); // SSE 已连通 → 停止轮询。
      if (onOpen) {
        try {
          onOpen();
        } catch {}
      }
    });
    es.addEventListener("status", (ev) => parse(ev, onStatus));
    es.addEventListener("probe", (ev) => parse(ev, onProbe));
    es.addEventListener("log", (ev) => parse(ev, onLog));
    es.addEventListener("error", () => {
      connected = false;
      setFallback(true); // SSE 断开 → 立即恢复轮询兜底。
      cleanup();
      scheduleReconnect();
    });
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    cleanup();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  return { start, stop, isConnected: () => connected };
}
