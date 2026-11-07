// visibility.js —— 主窗口后台省电：可见性单一状态源 + 渲染闸门（v2.17）。
//
// 背景：主窗口 7×24 挂着时，最小化/被遮挡状态下 styles.css 的 CSS 动画照跑、
// SSE 驱动的渲染照刷，GPU 辅助进程 6 天累计吃掉 ~4.5 CPU 小时。本模块提供：
// 1) createVisibilityTracker —— 监听 document.visibilitychange，隐藏时给 body 打
//    data-console-hidden 属性（styles.css 里的全局闸靠它暂停所有动画/过渡），
//    恢复可见时移除；并向订阅者广播状态翻转。
// 2) createRenderGate —— "隐藏期只缓存最新 status、恢复时冲刷一次" 的小状态机，
//    app.js 用它把隐藏期的 DOM 渲染整体短路，避免逐模块特判。
// 两者均为可注入工厂（Node 可 import 测试）；模块级再包一层接真实 document 的
// 单例（initConsoleVisibility / isConsoleHidden / onVisibilityChange）供 app.js 接线。
//
// 注意：Electron 下 show:false 创建且从未 show 过的窗口，visibilityState 报
// "visible"（paintWhenInitiallyHidden 默认行为）——初始态按可见处理是符合实测的；
// 只有真正 hide()/最小化/整窗遮挡才会触发 visibilitychange。

export const HIDDEN_ATTR = "data-console-hidden";

// 可注入工厂：doc 需提供 hidden、addEventListener/removeEventListener，body 可选。
export function createVisibilityTracker(doc) {
  const listeners = new Set();
  let hidden = false;
  let handler = null;

  function syncBodyAttr() {
    const body = doc?.body;
    if (!body || typeof body.setAttribute !== "function") return;
    if (hidden) body.setAttribute(HIDDEN_ATTR, "");
    else body.removeAttribute(HIDDEN_ATTR);
  }

  function applyHidden(next) {
    const value = !!next;
    if (value === hidden) return;
    hidden = value;
    syncBodyAttr();
    // 快照后遍历：回调内退订不影响本轮广播；单个回调抛错不阻断其余订阅者。
    for (const cb of [...listeners]) {
      try {
        cb(hidden);
      } catch {}
    }
  }

  if (doc && typeof doc.addEventListener === "function") {
    handler = () => applyHidden(!!doc.hidden);
    doc.addEventListener("visibilitychange", handler);
    // 同步初始态：若加载时即隐藏（例如恢复会话），立刻进入省电（打属性但不广播——
    // 此刻还没有订阅者，订阅方应以 isHidden() 读初值）。
    hidden = !!doc.hidden;
    syncBodyAttr();
  }

  return {
    isHidden: () => hidden,
    onChange(cb) {
      if (typeof cb !== "function") return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (handler && doc && typeof doc.removeEventListener === "function") {
        doc.removeEventListener("visibilitychange", handler);
      }
      handler = null;
      listeners.clear();
    },
  };
}

// 渲染闸门（纯状态机，可单测）：可见时直通 render；隐藏时只记住最新一份 status
// （旧的直接丢弃——恢复时全量渲染一次即可对齐所有面板，无需回放中间态）。
export function createRenderGate({ isHidden, render }) {
  let pending = null;
  let hasPending = false;
  return {
    // 返回是否真正执行了渲染。
    push(status) {
      if (isHidden?.()) {
        pending = status;
        hasPending = true;
        return false;
      }
      pending = null;
      hasPending = false;
      render(status);
      return true;
    },
    // 恢复可见时调用：冲刷隐藏期缓存的最新 status（若有），返回是否渲染了。
    flush() {
      if (!hasPending) return false;
      const status = pending;
      pending = null;
      hasPending = false;
      render(status);
      return true;
    },
    hasPending: () => hasPending,
  };
}

// ---- 模块级单例：接真实 document，供 app.js 接线 ----

let tracker = null;

export function initConsoleVisibility(doc = typeof document === "undefined" ? null : document) {
  if (tracker) return tracker;
  tracker = createVisibilityTracker(doc);
  return tracker;
}

export function isConsoleHidden() {
  return tracker ? tracker.isHidden() : false;
}

export function onVisibilityChange(cb) {
  // 未 init 时先建一个空 doc 追踪器兜底（Node 导入安全；浏览器侧 app.js 会先 init）。
  if (!tracker) initConsoleVisibility();
  return tracker.onChange(cb);
}
