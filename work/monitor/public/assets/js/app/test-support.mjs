// app/*.test.mjs 共用的最小假 DOM 与手动计时器（仅测试使用，不在 app.js 的模块图里）。
// 只实现控制器实际用到的接口：事件、dataset、classList、属性、closest、
// getElementById / querySelector(All)。不是通用 DOM 实现。

const toCamel = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

function matches(el, selector) {
  const attr = selector.match(/^\[([\w-]+)\]$/);
  if (!attr) return el.tagName === selector.toUpperCase();
  const name = attr[1];
  return name.startsWith("data-") ? el.dataset[toCamel(name.slice(5))] != null : el.hasAttribute(name);
}

export function fakeElement({ tag = "div", dataset = {}, parent = null, ...props } = {}) {
  const listeners = new Map();
  const classes = new Set();
  const attrs = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    dataset: { ...dataset },
    style: {},
    parent,
    disabled: false,
    hidden: false,
    open: false,
    textContent: "",
    title: "",
    value: "",
    innerHTML: "",
    tabIndex: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle(c, force) {
        const on = force ?? !classes.has(c);
        if (on) classes.add(c);
        else classes.delete(c);
        return on;
      },
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    listenerCount: (type) => listeners.get(type)?.length || 0,
    // 依次调用监听器并等待其返回的 promise（控制器的 click 处理多为 async）。
    async dispatch(type, init = {}) {
      const event = { type, target: el, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
      for (const fn of listeners.get(type) || []) await fn(event);
      return event;
    },
    closest(selector) {
      for (let node = el; node; node = node.parent) if (matches(node, selector)) return node;
      return null;
    },
    focus() {
      el.focused = true;
    },
    ...props,
  };
  return el;
}

export function fakeDialog(props = {}) {
  const dlg = fakeElement({
    tag: "dialog",
    showModal() {
      dlg.open = true;
      dlg.showCount = (dlg.showCount || 0) + 1;
    },
    close() {
      dlg.open = false;
      dlg.dispatch("close");
    },
    ...props,
  });
  return dlg;
}

export function fakeDocument(elements = {}, selectors = {}) {
  return {
    body: fakeElement({ tag: "body" }),
    elements,
    getElementById: (id) => elements[id] || null,
    querySelector: (selector) => (selectors[selector] || [])[0] || null,
    querySelectorAll: (selector) => selectors[selector] || [],
  };
}

// 手动推进的计时器：测试决定何时触发，结果确定、不依赖真实时间。
export function fakeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  const frames = [];
  return {
    timeouts,
    intervals,
    frames,
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    requestAnimationFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    runTimeouts() {
      for (const [id, t] of [...timeouts]) {
        timeouts.delete(id);
        t.fn();
      }
    },
    runFrames() {
      for (const fn of frames.splice(0)) fn();
    },
    tickIntervals() {
      for (const t of [...intervals.values()]) t.fn();
    },
  };
}

// 记录调用参数的桩函数：calls 保存每次调用的实参数组。
export function spy(impl = () => {}) {
  const fn = (...args) => {
    fn.calls.push(args);
    return impl(...args);
  };
  fn.calls = [];
  return fn;
}

// 手动结算的 promise（模拟"先发后到"的请求）。
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const flush = () => new Promise((resolve) => setImmediate(resolve));
