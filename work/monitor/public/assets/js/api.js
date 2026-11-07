// api.js —— fetch 封装 + token 注入。
// 页面由 monitor 自己提供（主窗口以 http://127.0.0.1:8877 加载），一律使用相对路径。

let authToken = "";

export function configure({ token } = {}) {
  if (token != null) authToken = token || "";
}

export function getAuthToken() {
  return authToken;
}

// 每个请求都必须有超时。此前 fetch 不带 signal：一次挂起的请求（macOS 睡眠唤醒、
// VPN 切换留下的半开连接、后端事件循环阻塞）会让调用方的 inFlight 永不清空，
// 之后所有刷新都只是返回同一个 pending promise —— 连 data-stale 都不会加上，
// 表现为"没有任何错误提示的假死数据"。对 24×7 运维台这是最危险的失效模式。
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
// 写操作另给上限：/api/start、/api/restart、测试连接、数据面平滑升级都要等后台动作
// 做完才返回，常见 10~30 秒。沿用读请求的 10 秒会在动作还在执行时就判失败（修复
// runbook 收到 reject 直接 settle(false)），界面报错而后台其实正常完成。
// 120 秒与 runbook 的超时兜底一致。
const MUTATION_TIMEOUT_MS = 120000;

function combineSignals(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return signal;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeoutSignal]);
  return signal; // AbortSignal.any 不可用时至少保留调用方的取消能力
}

export async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (authToken) headers["x-auth-token"] = authToken;
  const method = String(options.method || "GET").toUpperCase();
  if (method === "POST" && !headers["x-operation-id"]) {
    headers["x-operation-id"] = globalThis.crypto.randomUUID();
  }
  const { timeoutMs = method === "GET" ? DEFAULT_REQUEST_TIMEOUT_MS : MUTATION_TIMEOUT_MS, signal, ...rest } = options;
  try {
    return await fetch(path, { ...rest, headers, signal: combineSignals(signal, timeoutMs) });
  } catch (err) {
    // 把"超时"与"调用方主动取消"归一成同一个标记，上层不必区分 AbortError 的来源：
    // AbortSignal.timeout 抛 TimeoutError，AbortSignal.any 因调用方取消时抛 AbortError。
    // 另包一层中文 message：上层 toast 等直接展示 err.message，原生的
    // "signal timed out" 用户看不懂（DOMException 的 message 只读，不能原地改）。
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      const wrapped = new Error(
        err.name === "TimeoutError" ? `请求超时（${Math.round(timeoutMs / 1000)} 秒未响应）` : "请求已取消",
        { cause: err },
      );
      wrapped.name = err.name;
      wrapped.timeout = true;
      throw wrapped;
    }
    throw err;
  }
}

export const fetchApi = request;

// 非 2xx 抛带 status 的错误：401 的 {error:"Unauthorized"} 若被当正常 JSON 返回，
// 会被前端渲染成"系统故障"，掩盖真实原因（Token 失效应提示重启 App）。
// 后端 500 携带的 {error: 具体信息} 挂到 err.serverMessage，上层展示而非丢弃。
async function fetchJson(path, options) {
  const res = await fetchApi(path, options);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      const body = await res.json();
      if (body && typeof body.error === "string") err.serverMessage = body.error;
      if (body && typeof body.code === "string") err.code = body.code;
      if (body && Array.isArray(body.errors)) err.errors = body.errors;
      if (body && typeof body.field === "string") err.field = body.field;
    } catch {}
    throw err;
  }
  const value = await res.json();
  const operationId = res.headers?.get("x-operation-id");
  if (operationId && value && typeof value === "object" && !Array.isArray(value)) {
    return { ...value, operationId };
  }
  return value;
}

// 为 EventSource 构造带 token 的 URL（EventSource 无法设置请求头）。
export function eventsUrl(path = "/api/events") {
  if (!authToken) return path;
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(authToken)}`;
}

function buildQuery(params) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null || value === "") continue;
    sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export const getStatus = () => fetchJson("/api/status");
export const getConfig = () => fetchJson("/api/config");
export const getLogs = ({ source, level, since, until, q, operationId, limit } = {}) =>
  fetchJson(`/api/logs${buildQuery({ source, level, since, until, q, operationId, limit })}`);
export const getLogsSummary = () => fetchJson("/api/logs/summary");
export const getMetrics = ({ serverId, since } = {}) =>
  fetchJson(`/api/metrics${buildQuery({ serverId, since })}`);
// 资源趋势的 7 天 / 30 天（range = "7d" | "30d"）：服务端按小时 / 3 小时降采样后的均值。
export const getMetricsRange = ({ serverId, range } = {}) =>
  fetchJson(`/api/metrics/range${buildQuery({ serverId, range })}`);
export const getProbeHistory = ({ id, since } = {}) =>
  fetchJson(`/api/probes/history${buildQuery({ id, since })}`);
export const getTimeline = ({ since, limit } = {}) =>
  fetchJson(`/api/timeline${buildQuery({ since, limit })}`);
// 通用 GET（T04b 单隧道操作结果轮询等）。options 可带 timeoutMs 覆盖读请求默认超时
//（要排 SSH 槽位再跑远端命令的慢接口，10 秒可能不够）。
export const getJson = (path, options) => fetchJson(path, options);
// v2.16 历史复盘：可复盘日期列表 + 指定日期的全部历史条目（迁移/采样/信号/状态基线）。
// types 可选（逗号分隔的条目类型，如 "transition,levels"）：只要这几类，省掉逐分钟的采样。
export const getHistoryDays = () => fetchJson("/api/history/days");
export const getHistoryDay = (date, { types } = {}) => fetchJson(`/api/history${buildQuery({ date, types })}`);
// operationId 可选：调用方（修复 runbook）预生成后传入，SSE 日志即可在响应
// 返回前按同一 id 关联；不传时 request() 会自动生成（原行为不变）。
export const postAction = (name, { operationId } = {}) =>
  fetchJson(`/api/${name}`, {
    method: "POST",
    ...(operationId ? { headers: { "x-operation-id": operationId } } : {}),
  });
// operationId 同 postAction：单隧道重启 runbook 先 machine.start(operationId) 再发
// /api/operations/run，进度日志就不会早于订阅；不传时 request() 自动生成。
// timeoutMs 可选：同步跑远端长命令的接口（如集群上的测试对话，最长约 2 分钟）覆盖写请求默认超时。
export const postJson = (path, body, { operationId, timeoutMs } = {}) =>
  fetchJson(path, {
    method: "POST",
    body: JSON.stringify(body || {}),
    ...(operationId ? { headers: { "x-operation-id": operationId } } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
export const patchJson = (path, body) =>
  fetchJson(path, { method: "PATCH", body: JSON.stringify(body || {}) });
export const deleteJson = (path, body) =>
  fetchJson(path, { method: "DELETE", body: JSON.stringify(body || {}) });
