// toast.js —— 轻量全局毛玻璃 Toast 通知组件
import { escapeHtml } from "./store.js";

let toastContainer = null;

// 模态浮层（showModal）画在浏览器的「顶层」：顶层之外的内容——包括挂在 body 下的 toast 容器——
// 一律被遮罩盖住、点不到，z-index 再大也没用。浮层里触发的「已保存」「复制成功」「安装失败」因此
// 只能隔着遮罩看个影子，宽一点的浮层还会把它整个挡住。所以有模态浮层开着时，把容器挂进最上面
// 那个浮层里（它的后代不受遮罩影响），浮层关掉再挪回 body。
// modalStack：按打开顺序记下开着的模态浮层，末尾就是最上面的那个（顶层的叠放顺序 = 打开顺序）。
const modalStack = [];
let watching = false;

function topModal() {
  for (let i = modalStack.length - 1; i >= 0; i -= 1) {
    const dlg = modalStack[i];
    if (dlg.isConnected && dlg.open) return dlg;
    modalStack.splice(i, 1);
  }
  // 开始观察之前就已经开着的浮层没有顺序记录：退而取文档里最后一个。
  try {
    return [...document.querySelectorAll("dialog:modal")].at(-1) || null;
  } catch {
    return null;
  }
}

function rehome() {
  if (!toastContainer) return;
  const host = topModal() || document.body;
  if (host && toastContainer.parentNode !== host) host.appendChild(toastContainer);
}

function watchDialogs() {
  if (watching || typeof MutationObserver === "undefined" || !document.documentElement) return;
  watching = true;
  new MutationObserver((records) => {
    let changed = false;
    for (const { target } of records) {
      if (target.tagName !== "DIALOG") continue;
      const at = modalStack.indexOf(target);
      if (at >= 0) modalStack.splice(at, 1);
      if (target.open && target.matches(":modal")) modalStack.push(target);
      changed = true;
    }
    if (changed) rehome();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["open"], subtree: true });
}

function ensureContainer() {
  if (typeof document === "undefined") return null;
  // isConnected：容器所在的节点被整块重建时它会跟着消失，届时重新建一个。
  if (!toastContainer?.isConnected) {
    toastContainer = document.getElementById("toastContainer");
    if (!toastContainer) {
      toastContainer = document.createElement("div");
      toastContainer.id = "toastContainer";
      toastContainer.className = "toast-container";
      document.body.appendChild(toastContainer);
    }
    // 整个容器是礼貌播报区：先建好再插入内容，读屏才会把随后的 toast 当作「新增状态」读出来。
    // 不用 role="alert"（每个 toast 都打断当前朗读）；错误 / 警告也放同一区域，靠视觉与文案区分。
    // 容器可能来自 index.html 的预置节点，所以每次 ensure 都补齐属性（幂等）。
    if (toastContainer.getAttribute("role") !== "status") toastContainer.setAttribute("role", "status");
    if (toastContainer.getAttribute("aria-live") !== "polite") toastContainer.setAttribute("aria-live", "polite");
    toastContainer.setAttribute("aria-atomic", "false");
    if (!toastContainer.hasAttribute("aria-relevant")) toastContainer.setAttribute("aria-relevant", "additions");
  }
  watchDialogs();
  rehome();
  return toastContainer;
}

/**
 * 弹出一条轻量 Toast 通知
 * @param {Object} options
 * @param {"info"|"success"|"warn"|"error"} [options.type="info"]
 * @param {string} options.message - 提示内容
 * @param {string} [options.title] - 可选标题
 * @param {number} [options.duration=3000] - 显示时长 (ms)
 */
export function showToast({ type = "info", message, title = "", duration = 3000 } = {}) {
  if (typeof document === "undefined") return;
  const container = ensureContainer();
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast-item toast-${type}`;
  // 原子播报：标题与正文一次读完，不拆成两条。
  toast.setAttribute("aria-atomic", "true");

  // title/message 必须转义：err.serverMessage 来自后端 error.message，可能夹带远端命令输出。
  toast.innerHTML = `
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ""}
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" type="button" aria-label="关闭">✕</button>
  `;

  const closeBtn = toast.querySelector(".toast-close");
  const dismiss = () => {
    toast.classList.add("toast-hiding");
    toast.addEventListener(
      "animationend",
      () => {
        toast.remove();
      },
      { once: true }
    );
  };

  closeBtn?.addEventListener("click", dismiss);
  // 入场动画放完就摘掉：容器在浮层与 body 之间挪动时，已经显示着的 toast 不再重放一遍入场。
  toast.addEventListener("animationend", () => toast.classList.add("toast-shown"), { once: true });

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// 模块一加载就开始记浮层的打开顺序（Node 里跑单测时没有 document，跳过）。
// 顺手把播报容器建出来：live region 要在内容插入前就存在，第一次 toast 才不会被漏读。
if (typeof document !== "undefined") {
  watchDialogs();
  if (document.body) ensureContainer();
  else document.addEventListener("DOMContentLoaded", () => ensureContainer(), { once: true });
}
