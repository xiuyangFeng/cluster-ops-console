// ---- keyed 列表增量：按 data-key 复用节点，仅内容签名变化时重写该节点 ----
export function reconcileList(container, items, { keyFn, sigFn, createEl, updateEl }) {
  if (!container) return;
  const existing = new Map();
  for (const child of Array.from(container.children)) {
    if (child.dataset && child.dataset.key != null) existing.set(child.dataset.key, child);
  }
  const used = new Set();
  let prev = null;
  for (const item of items) {
    const key = String(keyFn(item));
    let el = existing.get(key);
    if (!el) {
      el = createEl(item);
      el.dataset.key = key;
    }
    const sig = sigFn(item);
    if (el.dataset.sig !== sig) {
      updateEl(el, item);
      el.dataset.sig = sig;
    }
    used.add(key);
    const anchor = prev ? prev.nextSibling : container.firstChild;
    if (anchor !== el) container.insertBefore(el, anchor);
    prev = el;
  }
  for (const [key, el] of existing) {
    if (!used.has(key)) el.remove();
  }
}

// ---- 就地修补：html 解析后按位置与现有子树比对，只改变化的文本与属性 ----
// 与整块 innerHTML 相比，同位置同标签的节点原样保留：键盘焦点、文本选区、进行中的
// CSS 动画都不被打断，数据没变时零 DOM 写入。适用于"结构基本固定、文案频繁变化"的
// 区域（Agent 卡、链路条、runbook 条目）。
// 限制：按位置而非 key 对齐，中间插删会让其后节点逐个改写（结果仍正确，只是不省）；
// 只同步 attribute，不同步 value/checked 这类"属性≠状态"的表单字段，别用在含输入框的区域。
const lastMorphedHtml = new WeakMap();

export function invalidateMorphCache(el) {
  for (let cur = el; cur; cur = cur.parentElement) lastMorphedHtml.delete(cur);
}

export function morphInnerHtml(el, html) {
  if (!el) return;
  if (lastMorphedHtml.get(el) === html && el.childNodes?.length > 0) return;
  lastMorphedHtml.set(el, html);
  const tpl = el.ownerDocument.createElement("template");
  tpl.innerHTML = html;
  morphChildren(el, tpl.content);
}

// 纯 DOM 接口（childNodes/nodeType/nodeName/attributes），不依赖解析器，Node 下可用假节点测。
export function morphChildren(fromParent, toParent) {
  const fromNodes = Array.from(fromParent.childNodes);
  if (
    toParent.nodeType === 11 &&
    typeof fromParent.appendChild === "function" &&
    (fromNodes.length === 0 || (fromNodes.length === 1 && fromNodes[0].nodeType === 3 && !fromNodes[0].nodeValue?.trim()))
  ) {
    if (fromNodes.length === 1) fromNodes[0].remove?.();
    fromParent.appendChild(toParent);
    return;
  }
  const toNodes = Array.from(toParent.childNodes);
  for (let i = 0; i < toNodes.length; i += 1) {
    const next = toNodes[i];
    const cur = fromNodes[i];
    if (!cur) {
      fromParent.appendChild(next);
    } else if (cur.nodeType !== next.nodeType || cur.nodeName !== next.nodeName) {
      fromParent.replaceChild(next, cur);
    } else if (cur.nodeType === 1) {
      if (typeof cur.isEqualNode === "function" && cur.isEqualNode(next)) continue;
      syncAttributes(cur, next);
      morphChildren(cur, next);
    } else if (cur.nodeValue !== next.nodeValue) {
      cur.nodeValue = next.nodeValue;
    }
  }
  for (let i = toNodes.length; i < fromNodes.length; i += 1) fromNodes[i].remove();
}

function syncAttributes(cur, next) {
  const curAttrs = cur.attributes;
  for (let i = curAttrs.length - 1; i >= 0; i -= 1) {
    const attr = curAttrs[i];
    if (!next.hasAttribute(attr.name)) cur.removeAttribute(attr.name);
  }
  const nextAttrs = next.attributes;
  for (let i = 0; i < nextAttrs.length; i += 1) {
    const attr = nextAttrs[i];
    if (cur.getAttribute(attr.name) !== attr.value) cur.setAttribute(attr.name, attr.value);
  }
}

// ---- 值没变就不写：高频渲染路径上的文本/属性更新（元素缺失时安全忽略）----
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export function setAttr(el, name, value) {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// ---- 惰性、带缓存的 getElementById ----
// 渲染模块在 Node 测试里也会被 import：没有 document 时返回 null，不抛错。
// 每个模块在顶层各建一份 lookup（const getEl = createElementLookup()），缓存互不干扰；
// 元素被移除后自动重查。不传 doc 时每次调用才解析全局 document（而非建 lookup 那一刻）：
// 模块顶层求值早于测试挂假 document，也早于任何 DOM 就绪；换了 document 缓存整体作废。
// 显式传 null 表示"没有文档"。
export function createElementLookup(doc) {
  const cache = new Map();
  let cachedDoc = null;
  return function getEl(id) {
    const d = doc !== undefined ? doc : typeof document !== "undefined" ? document : null;
    if (!d) return null;
    if (d !== cachedDoc) {
      cache.clear();
      cachedDoc = d;
    }
    const hit = cache.get(id);
    if (hit?.isConnected) return hit;
    const el = d.getElementById(id);
    if (el) cache.set(id, el);
    else cache.delete(id);
    return el || null;
  };
}

// ---- 剪贴板复制：失败时弹可全选的输入框兜底 ----
// 返回 true 表示已写入剪贴板；false 表示走了兜底（或兜底也不可用），调用方不要提示"已复制"。
export async function copyText(text, { fallbackMessage = "剪贴板不可用，请手动全选复制：" } = {}) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try { window.prompt(fallbackMessage, text); } catch {}
    return false;
  }
}
