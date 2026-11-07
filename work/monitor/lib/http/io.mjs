// HTTP 读写基础件：JSON 响应、JSON 正文读取、错误响应形状、查询参数解析。
// 各路由文件只经这里写响应，载荷形状与响应头因此只有一处定义。

// JSON 响应默认紧凑输出。此前一律 `JSON.stringify(value, null, 2)` 美化，
// /api/status 单次就要多传约 2.7KB（18.6KB → 21.3KB）纯缩进，而它的消费者是前端 JS，
// 不是人眼。人工排查需要可读输出时加 ?pretty=1（如 curl '…/api/status?pretty=1'）。
// 美化开关挂在 res 上（由请求处理器按 ?pretty=1 置位），避免给 40 余处 sendJson 调用点
// 逐个加参数。未置位（含单测直接构造的假 res）一律紧凑输出。
export function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(res.prettyJson ? JSON.stringify(value, null, 2) : JSON.stringify(value));
}

// 没有任何路由组接住（或静态文件不存在）：纯文本 404、不带响应头。前端与测试据
// "not found" 纯文本区分"路由不存在"与路由自己回的 JSON 404。
export function sendNotFound(res) {
  res.writeHead(404);
  res.end("not found");
}

// 读取并解析 POST JSON 体：超过 maxBytes 停止读取并返回 null（无界累积是本地 DoS 面），
// 解析失败同样返回 null（调用方回 400 而非落到外层 500）。
// 注意不能在此 req.destroy()：response 与 request 共用 socket，先销毁会让 400 响应写失败。
//
// 必须收集 Buffer 后一次性解码，不能 `body += chunk`：chunk 是 Buffer，`+=` 会按分段边界各自
// toString("utf8")，拼接点落在多字节字符（中文本项目大量使用）中间时产生 U+FFFD。它是合法 JSON
// 字符，JSON.parse 不报错——写接口会把「服务器甲」静默持久化成「服务器���」到 config.local.json。
// 顺带把上限按字节统计：body.length 数的是 UTF-16 码元，中文下 1MB 上限实际可放到约 3MB。
//
// 字符串 chunk 兼容：Node 的 IncomingMessage 默认给 Buffer，但一旦有代码调用过
// req.setEncoding()（或测试替身直接 yield 字符串）就会给 string。此类 chunk 按 utf8
// 重新编码为 Buffer 后走同一条路径，既保住"按字节"的上限语义，也避免 Buffer.concat
// 因类型不符直接抛错（抛错会被 catch 吞成 null → 全部写接口静默 400）。
export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      bytes += buf.length;
      if (bytes > maxBytes) return null;
      chunks.push(buf);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

// 必填正文：readJsonBody 给 null（空体 / 坏 JSON / 超限 / 字面量 null）时直接回
// 400 "invalid request body" 并返回 null，调用方见 null 即结束。只挡 null——数组等
// 非对象正文照样放行，由业务方自己判定（既有协议如此）。
export async function readRequiredBody(req, res) {
  const data = await readJsonBody(req);
  if (data == null) sendJson(res, { error: "invalid request body" }, 400);
  return data;
}

// 正文必须是 JSON 对象（排除 null / 数组 / 原始值）。
export function isJsonObject(data) {
  return Boolean(data) && typeof data === "object" && !Array.isArray(data);
}

// ---- 业务错误 → JSON 错误响应 ----
// 两种载荷形状都是既有协议，前端按各自形状读取，不能合并：
//   - 运行器（远端动作 / 单隧道操作 / 事件）：只有 { error }；
//   - 服务器注册表：{ error, code, errors }（冲突码 + 逐字段校验结果）。
// 状态码缺省取 error.status，再缺省 400。

export function sendErrorMessage(res, error, status = error.status || 400) {
  sendJson(res, { error: error.message }, status);
}

export function sendRegistryError(res, error) {
  sendJson(res, { error: error.message, code: error.code, errors: error.errors || undefined }, error.status || 400);
}

// 路由内业务调用的统一错误出口：work 抛错时用 onError 按该路由组的形状回 JSON，
// 而不是落到外层 500。返回 work 的返回值（路由据此决定是否继续往下匹配）；抛错时返回
// true（错误响应已写出）。
export async function respondOrError(res, work, onError = sendErrorMessage) {
  try {
    return await work();
  } catch (error) {
    onError(res, error);
    return true;
  }
}

// 可选数字查询参数：缺失或空串 → fallback；否则 Number(raw)（可能是 NaN，由调用方的
// 过滤语义自行处理——与拆分前逐处手写的 `raw != null && raw !== "" ? Number(raw) : x` 等价）。
export function numberParam(searchParams, name, fallback = undefined) {
  const raw = searchParams.get(name);
  return raw != null && raw !== "" ? Number(raw) : fallback;
}
