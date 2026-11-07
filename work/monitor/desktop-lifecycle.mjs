// 告警确认延迟队列（纯函数，便于单测）：→error 先挂起 confirmMs，期间恢复则静默丢弃；
// 到期未恢复才告警。恢复通知仅在真的发过告警（或无 pending 记录，如进程重启后）时才发，
// 避免用户收到从未告警过的"已恢复"。pending 由调用方持有，函数原地维护。
export function updateAlertQueue({ pending, transitions = [], now, confirmMs = 30000 }) {
  const toNotify = [];
  const toRecover = [];
  for (const t of transitions) {
    if (t.to === "error") {
      if (!pending.has(t.key)) {
        pending.set(t.key, { transition: t, dueAt: now + confirmMs, notified: false });
      }
    } else if (t.from === "error") {
      const item = pending.get(t.key);
      if (item && !item.notified) {
        pending.delete(t.key); // 瞬时抖动，静默
      } else {
        toRecover.push(t);
        pending.delete(t.key);
      }
    }
  }
  for (const item of pending.values()) {
    if (!item.notified && now >= item.dueAt) {
      item.notified = true;
      toNotify.push(item.transition);
    }
  }
  return { toNotify, toRecover };
}

// serverProcess 退出后的重启决策（纯函数，便于单测）。
// consecutiveFailures：连续失败次数（就绪探测成功后由调用方清零）。
// 达到 maxRetries 次连续失败即放弃并让托盘变红；否则按 base*2^(n-1) 指数退避、capMs 封顶。
export function computeServerRestartPolicy({
  consecutiveFailures,
  maxRetries = 5,
  baseDelayMs = 1000,
  capMs = 30000,
} = {}) {
  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  if (failures >= maxRetries) {
    return { shouldRestart: false, delayMs: 0 };
  }
  const exponent = Math.max(0, failures - 1);
  const delayMs = Math.min(capMs, baseDelayMs * 2 ** exponent);
  return { shouldRestart: true, delayMs };
}

// 轮询后端就绪探测：注入 fetchImpl / sleepImpl 使其可单测（测试里无需真实等待）。
// 首个返回 200 即 resolve(true)；累计等待超过 timeoutMs 仍未就绪则 resolve(false)。
// 用累计 intervalMs 计时（而非真实时钟），确保注入 fake sleep 时超时路径可被确定性触发。
export async function waitForServerReady({
  url,
  token,
  intervalMs = 250,
  timeoutMs = 15000,
  fetchImpl = fetch,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let elapsed = 0;
  // 至少探测一次；随后每隔 intervalMs 重试，直至累计耗时会超过 timeoutMs。
  for (;;) {
    try {
      const res = await fetchImpl(url, {
        headers: token ? { "x-auth-token": token } : {},
        // 半死后端（TCP accept 但不响应）下无超时的 fetch 会永久挂起，
        // 就绪探测既不返回 true 也走不到超时分支。5s 上限：宽于冷启动重负载下的
        // 慢响应（2-4s 仍算就绪），只拦截真正挂死的请求。
        signal: AbortSignal.timeout(5000),
      });
      if (res && (res.status === 200 || res.ok === true)) {
        return true;
      }
    } catch {
      // 连接被拒/服务尚未监听——继续重试直到超时。
    }
    if (elapsed + intervalMs > timeoutMs) {
      return false;
    }
    await sleepImpl(intervalMs);
    elapsed += intervalMs;
  }
}

// ---------------------------------------------------------------------------
// 窗口导航策略：preload 暴露了 getAuthToken，任何被导航到的页面都会继承它。
// 因此"允许哪些 origin"必须是白名单，且 file: 必须按具体文件放行。
// ---------------------------------------------------------------------------

// 允许的 file: 目标只有确切的那一个文件（island.html），不做整个 scheme 放行。
// 此前 `protocol === "file:"` 就放行：只要 island 窗口被导航到任意本地 HTML
//（下载目录里被投毒的文件、临时目录里的页面），该页面就继承了 preload，
// 其脚本可直接调用 window.desktop.getAuthToken() 并把 Token 外发。
function sameFileTarget(a, b) {
  if (a.protocol !== "file:" || b.protocol !== "file:") return false;
  let aPath;
  let bPath;
  try {
    aPath = decodeURIComponent(a.pathname);
    bPath = decodeURIComponent(b.pathname);
  } catch {
    return false; // 非法百分号编码
  }
  return aPath === bPath && a.search === b.search && a.hash === b.hash;
}

export function isNavigationAllowed(url, allowedOrigins) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const allowed = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  if (parsed.protocol === "file:") {
    return allowed.some((entry) => {
      try {
        return sameFileTarget(new URL(entry), parsed);
      } catch {
        return false;
      }
    });
  }
  // 必须按解析后的 URL.origin 比较而非字符串前缀：
  // "http://127.0.0.1:8877@evil.com/" 以允许前缀开头，但实际 host 是 evil.com（userinfo 绕过）。
  return allowed.includes(parsed.origin);
}

// ---------------------------------------------------------------------------
// 显式退出的停止编排
// ---------------------------------------------------------------------------

export const QUIT_PARENT_RECORD_NAME = "channel-supervisor";

// 把停止目标切成"必须独占第一段的父进程"与"可并发停止的其余目标"。
// 顺序约束不能省：channel-supervisor 在清理期间会重生 local-proxy / tunnel，
// 与它并发停止子进程等于"停了又被拉起来"，留下还在跑的后台。
// 它一停，其余目标（本地代理、排空中的旧代理、各服务器隧道）互不相关，可并发停。
// 此前的串行 await 在 N 台服务器时最坏 (N+2)×1.5s 以上，直接撞上 before-quit 的
// 8s 死线，app.exit(0) 在清理中途落下：用户点了"退出并停止后台"却仍有进程存活。
export function partitionQuitStopTargets(stopOrder) {
  const all = (Array.isArray(stopOrder) ? stopOrder : []).filter((name) => typeof name === "string" && name.length > 0);
  return {
    first: all.filter((name) => name === QUIT_PARENT_RECORD_NAME),
    rest: all.filter((name) => name !== QUIT_PARENT_RECORD_NAME),
  };
}
