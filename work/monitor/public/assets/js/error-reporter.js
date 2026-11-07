// error-reporter.js —— 页面脚本错误上报（v2.64）。
//
// window 的 error（未捕获异常）与 unhandledrejection（没人接的 Promise 拒绝）交给监控服务
// POST /api/diagnostics/client-error，由监控服务写进 runtime/logs/renderer.ndjson；导出诊断包时与桌面壳的 desktop.ndjson 一起带上。
//   - 按「消息 + 位置」去重：同一条 10 分钟内只报一次，期间又出现的次数记在下一次上报的 occurrences 里；
//   - 每分钟最多 10 条；消息、位置、栈都截断（服务端还会再限一遍）；
//   - 还没拿到令牌之前出的错先攒着（最多 10 条），拿到后一并补报；
//   - 上报失败不重试、不提示——这是给排障留痕，不打扰用户。
// 不碰 DOM、不 import 别的模块：主页面（app.js）与悬浮岛（island.js）共用，Node 里可测。

export const REPORT_LIMITS = Object.freeze({ perMinute: 10, message: 500, stack: 4000, source: 300, dedupeMs: 10 * 60_000, pending: 10 });

const clip = (value, max) => {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

// 位置只留路径：查询串与锚点里可能带令牌（EventSource 的 ?token=）。
const cleanSource = (value) => clip(String(value ?? "").replace(/[?#].*$/, ""), REPORT_LIMITS.source);

const toLine = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

function describeReason(reason) {
  if (reason && typeof reason === "object" && typeof reason.message === "string") {
    return { message: reason.name && reason.name !== "Error" ? `${reason.name}: ${reason.message}` : reason.message, stack: typeof reason.stack === "string" ? reason.stack : "" };
  }
  let message;
  try {
    message = typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    message = String(reason);
  }
  return { message: message ?? String(reason), stack: "" };
}

// window 的 error 事件 → 一条上报；没有消息时返回 null。
export function describeErrorEvent(event) {
  const fromError = event?.error ? describeReason(event.error) : null;
  const message = clip(fromError?.message || event?.message || "", REPORT_LIMITS.message).trim();
  if (!message) return null;
  return {
    kind: "error",
    message,
    source: cleanSource(event?.filename),
    line: toLine(event?.lineno),
    column: toLine(event?.colno),
    stack: clip(fromError?.stack || "", REPORT_LIMITS.stack),
  };
}

// unhandledrejection 事件 → 一条上报。
export function describeRejectionEvent(event) {
  const { message, stack } = describeReason(event?.reason);
  const text = clip(message, REPORT_LIMITS.message).trim() || "（没有原因）";
  // 位置取栈里第一处 http(s) 地址，去重用。
  const at = /(https?:\/\/[^\s)]+?):(\d+):(\d+)/.exec(stack || "");
  return {
    kind: "unhandledrejection",
    message: text,
    source: cleanSource(at?.[1] || ""),
    line: at ? Number(at[2]) : null,
    column: at ? Number(at[3]) : null,
    stack: clip(stack, REPORT_LIMITS.stack),
  };
}

// 不值得报的：浏览器扩展注入的脚本、跨源脚本被浏览器抹掉细节的「Script error.」、ResizeObserver 的良性告警。
export function shouldIgnoreReport(report) {
  if (!report) return true;
  if (/^(?:chrome|moz|safari(?:-web)?)-extension:/i.test(report.source || "")) return true;
  if (/^Script error\.?$/i.test(report.message)) return true;
  if (/ResizeObserver loop/i.test(report.message)) return true;
  return false;
}

export function createErrorReporter({ send, now = Date.now, page = "main", limits = REPORT_LIMITS } = {}) {
  const seen = new Map(); // 签名 → { at, suppressed }
  const sentAt = [];
  const pending = [];
  let ready = false;
  let reporting = false;

  function dispatch(payload) {
    try {
      Promise.resolve(send(payload)).catch(() => {});
    } catch {}
  }

  // → "sent" | "queued" | "duplicate" | "rate-limited" | "ignored"
  function capture(report) {
    if (reporting || shouldIgnoreReport(report)) return "ignored";
    reporting = true;
    try {
      const ts = now();
      const signature = [report.kind, report.message, report.source, report.line ?? "", report.column ?? ""].join("\u0001");
      const prior = seen.get(signature);
      if (prior && ts - prior.at < limits.dedupeMs) {
        prior.suppressed += 1;
        return "duplicate";
      }
      while (sentAt.length && ts - sentAt[0] >= 60_000) sentAt.shift();
      if (sentAt.length >= limits.perMinute) return "rate-limited";
      const occurrences = (prior?.suppressed ?? 0) + 1;
      seen.delete(signature);
      seen.set(signature, { at: ts, suppressed: 0 });
      while (seen.size > 200) seen.delete(seen.keys().next().value);
      sentAt.push(ts);
      const payload = { ...report, page, ...(occurrences > 1 ? { occurrences } : {}) };
      if (!ready) {
        if (pending.length < limits.pending) pending.push(payload);
        return "queued";
      }
      dispatch(payload);
      return "sent";
    } catch {
      return "ignored";
    } finally {
      reporting = false;
    }
  }

  function install(win) {
    win.addEventListener("error", (event) => {
      try { capture(describeErrorEvent(event)); } catch {}
    });
    win.addEventListener("unhandledrejection", (event) => {
      try { capture(describeRejectionEvent(event)); } catch {}
    });
  }

  // 拿到令牌之后调用：补报之前攒下的。
  function markReady() {
    if (ready) return;
    ready = true;
    for (const payload of pending.splice(0)) dispatch(payload);
  }

  return { capture, install, markReady };
}
