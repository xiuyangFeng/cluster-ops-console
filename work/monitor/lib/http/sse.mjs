// SSE 推送中心（/api/events）：连接上限、共享心跳、事件总线单一广播订阅、写缓冲背压保护。
import { bus, EVENTS } from "../event-bus.mjs";
import { sendJson } from "./io.mjs";

// SSE 写缓冲阈值：res.write 从不检查返回值，客户端死连接/极慢消费会让缓冲无限膨胀；
// 超过该值视为死连接，直接销毁（EventSource 会自动重连）。
const SSE_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

function formatFrame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// 背压保护：客户端已死/极慢消费时 write 只会往内核外的用户态缓冲堆字节。
// writableLength 超阈值即销毁连接——close 事件会触发监听器清理，客户端自动重连。
function writeGuarded(client, chunk) {
  try {
    if (client.writableLength > SSE_MAX_BUFFERED_BYTES) {
      client.destroy();
      return;
    }
    client.write(chunk);
  } catch {}
}

// statusPayload 来自 status-payload.mjs：statusFrame 给 STATUS_CHANGED 事件补挂旁路字段，
// initialStatusFrame 生成建连首帧。
export function createSseHub({ maxConnections, heartbeatMs, statusPayload }) {
  const clients = new Set();
  let heartbeat = null;

  // 单一广播订阅：一次构造载荷、一次 JSON.stringify，然后写给全部客户端。
  // 此前是"每个连接各注册一组 bus 监听器"（每个监听器只写自己那条连接）：
  // N 个客户端时同一事件触发 N 次监听、构造 N 份完全相同的载荷、做 N 次
  // JSON.stringify —— status 载荷约 20KB，5 个客户端每拍就白烧 80KB 的 CPU 与瞬时内存。
  // 监听器只在有客户端时挂载、最后一个客户端断开即摘除，因此反复创建 router
  // （测试、多次启动）不会累积监听器。
  let busBound = false;

  function broadcast(event, payload) {
    if (clients.size === 0) return;
    let frame;
    try {
      // 序列化失败（循环引用等）不该影响其它事件，也不该让连接停在半写状态。
      frame = formatFrame(event, payload);
    } catch {
      return;
    }
    for (const client of clients) writeGuarded(client, frame);
  }

  function onStatusChanged({ layers, lite }) {
    broadcast("status", statusPayload.statusFrame({ layers, lite }));
  }
  function onProbeUpdated({ id, layer, result }) {
    // 缺 result 时直接返回：监听器抛错会沿 bus.emit 冒泡回探针归并路径。
    if (!result) return;
    broadcast("probe", {
      id,
      layer,
      level: result.level,
      reason: result.reason,
      checkedAt: result.checkedAt,
    });
  }
  function onLogAppended(entry) {
    broadcast("log", entry);
  }

  function bindBus() {
    if (busBound) return;
    busBound = true;
    bus.on(EVENTS.STATUS_CHANGED, onStatusChanged);
    bus.on(EVENTS.PROBE_UPDATED, onProbeUpdated);
    bus.on(EVENTS.LOG_APPENDED, onLogAppended);
  }

  function unbindBus() {
    if (!busBound || clients.size > 0) return;
    busBound = false;
    bus.off(EVENTS.STATUS_CHANGED, onStatusChanged);
    bus.off(EVENTS.PROBE_UPDATED, onProbeUpdated);
    bus.off(EVENTS.LOG_APPENDED, onLogAppended);
  }

  function handle(req, res) {
    if (clients.size >= maxConnections) {
      return sendJson(res, { error: "too many SSE connections" }, 503);
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    clients.add(res);
    bindBus();
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        for (const client of clients) writeGuarded(client, ":hb\n\n");
      }, heartbeatMs);
      heartbeat.unref();
    }

    // 连接即推送一次全量状态，客户端可立即渲染。
    const initial = statusPayload.initialStatusFrame();
    try {
      writeGuarded(res, formatFrame("status", initial));
    } catch {}

    req.on("close", () => {
      clients.delete(res);
      unbindBus();
      if (clients.size === 0 && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      try {
        res.end();
      } catch {}
    });
  }

  return { handle };
}
