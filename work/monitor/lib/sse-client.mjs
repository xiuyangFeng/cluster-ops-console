import { request as httpRequest } from "node:http";

// 极简 SSE 客户端（Node 内置 http，零依赖），供 Electron 主进程的托盘订阅 /api/events。
// 托盘此前每 3s 轮询一次 /api/status-lite；状态变化其实已由 SSE 的 status 事件推送
// （payload.lite 与 /api/status-lite 同构），订阅后只在变化时处理，空闲时零请求。

const MAX_BUFFER_CHARS = 1024 * 1024; // 单条事件异常巨大时丢弃，防止无界累积

// 增量解析 text/event-stream：按空行切事件，支持 event/data 字段与 ":" 注释（心跳）。
export function createSseParser(onEvent) {
  let buffer = "";
  let eventName = "message";
  let dataLines = [];
  return function feed(chunk) {
    buffer += String(chunk);
    if (buffer.length > MAX_BUFFER_CHARS) {
      buffer = "";
      eventName = "message";
      dataLines = [];
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (dataLines.length) onEvent({ event: eventName, data: dataLines.join("\n") });
        eventName = "message";
        dataLines = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon >= 0 ? line.slice(0, colon) : line;
        let value = colon >= 0 ? line.slice(colon + 1) : "";
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") eventName = value || "message";
        else if (field === "data") dataLines.push(value);
      }
      newline = buffer.indexOf("\n");
    }
  };
}

// 订阅一个 SSE 端点，断线指数退避重连。
//   onEvent({event, data})：每个完整事件；
//   onDown(reason)：连接失败/断开/空闲超时（每次掉线一次），调用方可借机走一次兜底轮询；
//   shouldRun()：返回 false 时停止重连（例如应用正在退出）。
// idleTimeoutMs：服务端每 15s 发一次 ":hb" 心跳，超过该时长无任何字节视为假死连接。
export function createSseSubscription({
  url,
  headers = {},
  onEvent = () => {},
  onDown = () => {},
  shouldRun = () => true,
  request = httpRequest,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  idleTimeoutMs = 45000,
  backoffBaseMs = 1000,
  backoffMaxMs = 30000,
} = {}) {
  let req = null;
  let reconnectTimer = null;
  let idleTimer = null;
  let failures = 0;
  let connected = false;
  let stopped = false;
  let generation = 0;

  function clearIdle() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = null;
  }

  function armIdle(gen) {
    clearIdle();
    idleTimer = setTimer(() => {
      if (gen === generation) teardown("idle-timeout");
    }, idleTimeoutMs);
    if (idleTimer && typeof idleTimer.unref === "function") idleTimer.unref();
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || !shouldRun()) return;
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(failures, 10));
    failures += 1;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  }

  // 结束当前连接（幂等，按 generation 去重），通知一次 onDown 并排队重连。
  function teardown(reason) {
    const current = req;
    req = null;
    connected = false;
    clearIdle();
    generation += 1;
    if (current) {
      try { current.destroy(); } catch {}
    }
    if (stopped) return;
    try { onDown(reason); } catch {}
    scheduleReconnect();
  }

  function connect() {
    if (stopped || req || !shouldRun()) return;
    const gen = ++generation;
    let settled = false;
    const fail = (reason) => {
      if (settled || gen !== generation) return;
      settled = true;
      teardown(reason);
    };
    let outgoing;
    try {
      outgoing = request(url, { method: "GET", headers: { accept: "text/event-stream", ...headers } }, (res) => {
        if (gen !== generation) {
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(`http-${res.statusCode}`);
          return;
        }
        connected = true;
        armIdle(gen);
        res.setEncoding("utf8");
        const feed = createSseParser((evt) => {
          failures = 0; // 真正收到事件才算连接健康，避免"连上即断"绕过退避
          try { onEvent(evt); } catch {}
        });
        res.on("data", (chunk) => {
          if (gen !== generation) return;
          armIdle(gen);
          feed(chunk);
        });
        res.on("end", () => fail("closed"));
        res.on("close", () => fail("closed"));
        res.on("error", () => fail("stream-error"));
      });
    } catch {
      req = null;
      fail("request-error");
      return;
    }
    req = outgoing;
    outgoing.on("error", () => fail("request-error"));
    outgoing.end();
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      teardown("stopped"); // stopped 已置位：teardown 不回调 onDown、不排重连
    },
    isConnected: () => connected,
  };
}
