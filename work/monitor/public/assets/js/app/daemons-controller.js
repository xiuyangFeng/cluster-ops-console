// daemons-controller.js —— 服务器页「远端守护进程」面板（#daemonsPanel）的接线层。
// 读：GET /api/daemons?serverId=<查看中的服务器>（后端一次只读 SSH，10 秒短缓存）。只在服务器页可见、
// 窗口没被隐藏、面板没被隐藏、模块开着、且查看的是团队集群时轮询（60 秒一轮）；任一条件不满足即停表。
// 写：只有「未运行」的守护进程有「启动」按钮，点了先行内确认，确认后 POST /api/daemons/start（带 serverId，
// 切服瞬间后端会 409 拒绝），进行中按钮全部禁用；结果用 toast 说明并以返回的最新状态重绘。
// 面板显隐：模块关闭由 app/panels.js 统一隐藏（selfHidden）；不是团队集群时这里自己藏起来。
// 服务直达（v2.62）：同一个响应里的 services / forwards 画成「我在这台服务器上的服务」一组。「打开」POST
// /api/daemons/forward（只带 serverId 与端口），成功后在浏览器打开返回的本机地址；「关闭」POST
// /api/daemons/forward/close。两个动作都以返回的最新状态重绘；没有返回状态时强制重读一次。
// 这一组可以收起（点组名）：默认收起，只留转发中的行；选择记在本机 localStorage，不发请求。
import { morphInnerHtml } from "../dom-utils.js";
import { buildDaemonsHtml, localForwardUrl } from "../render/daemons-view.js";

export const DAEMONS_POLL_MS = 60000;
export const SERVICES_OPEN_STORAGE_KEY = "daemonsServicesOpen";

// 与后端 isDaemonsEligible 同一口径；配置还没加载到时不显示。
export function daemonsEligible(server) {
  return Boolean(server) && server.disabled !== true && server.monitorEnabled !== false && server.source !== "personal";
}

// 启动结果 → toast。
export function startToast(res, label) {
  const name = label || res?.daemon || "守护进程";
  switch (res?.result) {
    case "started":
      return { type: "success", title: "远端守护进程", message: `${name} 已启动。` };
    case "alreadyRunning":
      return { type: "info", title: "远端守护进程", message: `${name} 已在运行，没有做任何改动。` };
    case "missing":
      return { type: "warn", title: "远端守护进程", message: `服务器上没找到 ${name} 的程序，需先安装。` };
    case "failed":
      return { type: "warn", title: `${name} 没有起来`, message: res.detail ? `等了一会儿端口仍未监听。远端日志：${res.detail}` : "等了一会儿端口仍未监听，可到服务器上查看启动日志。" };
    default:
      return { type: "warn", title: "启动结果不确定", message: `${res?.error || "没有拿到远端结果"}。稍后刷新看看 ${name} 是否已在运行。` };
  }
}

// 转发成功 → toast。浏览器可能拦下不是紧跟点击弹出的新标签页，所以同时说明本机地址在哪儿点。
export function forwardToast(port, forward) {
  return {
    type: "success",
    title: "已转发到这台电脑",
    message: `:${port} → 127.0.0.1:${forward.localPort}。浏览器没有自动打开时，点这一行的本机地址；最长 2 小时，到点自动收回。`,
    duration: 6000,
  };
}

const defaultWrite = (el, html) => {
  if (el.ownerDocument) morphInnerHtml(el, html);
  else el.innerHTML = html;
};

// 在新标签页打开外部地址（桌面壳里窗口加固会把它交给系统浏览器）；noopener：被打开的页面拿不到本页的句柄。
const defaultOpenUrl = (doc) => (url) => doc?.defaultView?.open?.(url, "_blank", "noopener,noreferrer");

export function createDaemonsController({
  doc, getJson, postJson, showToast, getConfig, isViewVisible, isHidden = () => false, onVisibilityChange,
  isPanelHidden = () => false, writeHtml = defaultWrite, openUrl = defaultOpenUrl(doc),
  copyText = (text) => globalThis.navigator?.clipboard?.writeText?.(text),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  storage,
}) {
  let serverId = null;
  let serverName = "";
  let moduleOn = true;
  let lastKey = "";
  let data = null;
  let loading = false;
  let error = "";
  let busyId = null;
  let confirmId = null;
  let timer = null;
  let seq = 0;
  let lastHtml = null;
  const pending = new Map(); // 端口 → "open" | "close"：本窗口正在进行的转发动作
  // 服务一多就是十几行，默认收起；展开过就记住。取 localStorage 本身就可能抛错（隐私模式、Node 下没给
  // 存储文件），所以连同读写一起容错；没有存储时只是不记住。
  let store = null;
  let servicesCollapsed = true;
  try {
    store = storage === undefined ? globalThis.localStorage : storage;
    servicesCollapsed = store?.getItem(SERVICES_OPEN_STORAGE_KEY) !== "1";
  } catch {}

  const $ = (id) => doc.getElementById(id);
  const visible = () => Boolean(serverId) && moduleOn && isViewVisible("servers") && !isHidden() && !isPanelHidden();

  function render() {
    const badge = $("daemonsServer");
    if (badge && badge.textContent !== (serverName || "-")) badge.textContent = serverName || "-";
    const refreshBtn = $("daemonsRefreshBtn");
    if (refreshBtn) refreshBtn.disabled = loading || Boolean(busyId);
    const body = $("daemonsBody");
    if (!body) return;
    const html = buildDaemonsHtml(data, { busyId, confirmId, loading, error, pending, servicesCollapsed });
    if (html === lastHtml) return;
    lastHtml = html;
    writeHtml(body, html);
  }

  async function refresh({ fresh = false } = {}) {
    if (!serverId) return;
    const target = serverId;
    const ticket = ++seq;
    loading = true;
    render();
    try {
      const qs = new URLSearchParams({ serverId: target });
      if (fresh) qs.set("fresh", "1");
      const next = await getJson(`/api/daemons?${qs}`);
      if (ticket !== seq || target !== serverId) return;
      data = next?.eligible === false ? null : next;
      error = "";
    } catch (err) {
      if (ticket !== seq || target !== serverId) return;
      error = err?.status === 409 ? "查看的服务器刚切换过，正在重新读取" : (err?.serverMessage || "读取守护进程状态失败，稍后自动重试");
    } finally {
      if (ticket === seq) {
        loading = false;
        render();
      }
    }
  }

  function schedule() {
    if (timer != null) clearTimer(timer);
    timer = null;
    if (!visible()) return;
    timer = setTimer(async () => {
      timer = null;
      if (visible()) await refresh();
      schedule();
    }, DAEMONS_POLL_MS);
  }

  async function start(id) {
    if (!serverId || busyId) return;
    const target = serverId;
    const label = data?.daemons?.find((d) => d.id === id)?.label || id;
    busyId = id;
    confirmId = null;
    render();
    let res = null;
    try {
      res = await postJson("/api/daemons/start", { daemon: id, serverId: target });
      showToast?.(startToast(res, label));
    } catch (err) {
      showToast?.({ type: "warn", title: "远端守护进程", message: err?.serverMessage || err?.message || "启动请求失败，请重试。" });
    } finally {
      busyId = null;
      if (target === serverId && res?.status) {
        seq += 1; // 进行中的读取不能覆盖刚拿到的启动后状态
        data = res.status;
        loading = false;
        error = "";
        render();
      } else if (target === serverId) {
        render();
        refresh({ fresh: true });
      }
    }
  }

  // 转发动作收尾：返回里带最新状态就直接用（进行中的读取不能覆盖它），否则强制重读一次。
  function settleForward(target, port, status) {
    // 途中已经切到另一台：这边的标记在切换时清过了，同号端口在新服务器上的标记不归这次请求管。
    if (target !== serverId) return;
    pending.delete(port);
    if (status) {
      seq += 1;
      data = status;
      loading = false;
      error = "";
      render();
    } else {
      render();
      refresh({ fresh: true });
    }
  }

  // 「打开」：把这个端口转发到本机，成功后在浏览器打开本机地址。
  async function openService(port) {
    if (!serverId || pending.has(port)) return;
    const target = serverId;
    pending.set(port, "open");
    render();
    let res = null;
    try {
      res = await postJson("/api/daemons/forward", { serverId: target, port });
      const url = localForwardUrl(res?.forward?.localPort);
      if (!url) throw new Error("没有拿到本机地址");
      // 打不开新标签页不算转发失败：地址就在这一行上，toast 里也说了。
      try {
        openUrl(url);
      } catch {}
      showToast?.(forwardToast(port, res.forward));
    } catch (err) {
      showToast?.({ type: "warn", title: "没有转发成功", message: err?.serverMessage || err?.message || "转发请求失败，请重试。", duration: 6000 });
    } finally {
      settleForward(target, port, res?.status);
    }
  }

  async function closeForward(port) {
    if (!serverId || pending.has(port)) return;
    const target = serverId;
    pending.set(port, "close");
    render();
    let res = null;
    try {
      res = await postJson("/api/daemons/forward/close", { serverId: target, port });
    } catch (err) {
      showToast?.({ type: "warn", title: "转发没有关掉", message: err?.serverMessage || err?.message || "关闭请求失败，请重试。" });
    } finally {
      settleForward(target, port, res?.status);
    }
  }

  // 每次渲染 status 时调用：切换服务器、模块开关、团队 / 个人之间切换时更新面板。
  function onStatus(status) {
    const id = status?.activeServerId || null;
    const server = (getConfig?.()?.servers || []).find((s) => s.id === id) || null;
    const eligible = daemonsEligible(server);
    const wasOn = moduleOn;
    moduleOn = status?.modules?.daemons !== false;
    const panel = $("daemonsPanel");
    // 被「界面面板」或模块开关隐藏时由 panels.js 管显隐，这里不碰。
    if (panel && !isPanelHidden() && panel.hidden === eligible) panel.hidden = !eligible;
    const key = `${id}|${eligible}|${moduleOn}`;
    if (key === lastKey) return;
    lastKey = key;
    const changedServer = (eligible ? id : null) !== serverId;
    serverId = eligible ? id : null;
    serverName = eligible ? (server.name || id) : "";
    const willRefresh = visible() && (changedServer || !data || !wasOn);
    if (changedServer) {
      seq += 1;
      data = null;
      error = "";
      loading = false;
      confirmId = null;
      pending.clear();
      lastHtml = null;
      if (!willRefresh) render();
    }
    // 换了服务器 / 还没数据 / 模块刚重新打开：立即读一次（其余交给 60 秒一轮）。
    if (willRefresh) refresh();
    schedule();
  }

  function bind() {
    $("daemonsRefreshBtn")?.addEventListener("click", () => {
      if (!loading && !busyId) refresh({ fresh: true });
    });
    $("daemonsBody")?.addEventListener("click", (event) => {
      const target = event.target;
      const startBtn = target?.closest?.("[data-dm-start]");
      if (startBtn) {
        if (busyId) return;
        confirmId = startBtn.dataset.dmStart;
        render();
        return;
      }
      const confirmBtn = target?.closest?.("[data-dm-confirm]");
      if (confirmBtn) {
        start(confirmBtn.dataset.dmConfirm);
        return;
      }
      if (target?.closest?.("[data-dm-cancel]")) {
        confirmId = null;
        render();
        return;
      }
      if (target?.closest?.("[data-dm-toggle]")) {
        servicesCollapsed = !servicesCollapsed;
        try {
          store?.setItem(SERVICES_OPEN_STORAGE_KEY, servicesCollapsed ? "0" : "1");
        } catch {}
        render();
        return;
      }
      const copyBtn = target?.closest?.("[data-dm-copy]");
      if (copyBtn) {
        const text = copyBtn.dataset.dmCopy;
        if (text) {
          Promise.resolve(copyText(text)).then(() => {
            showToast?.({ type: "success", title: "已复制本机地址", message: `${text}（可直接粘贴到 VS Code / 浏览器）`, duration: 3000 });
          }).catch(() => {});
        }
        return;
      }
      const openBtn = target?.closest?.("[data-dm-open]");
      const closeBtn = openBtn ? null : target?.closest?.("[data-dm-close]");
      const port = Number(openBtn ? openBtn.dataset.dmOpen : closeBtn?.dataset.dmClose);
      if (!Number.isInteger(port) || port < 1) return;
      if (openBtn) openService(port);
      else if (closeBtn) closeForward(port);
    });
    onVisibilityChange?.(() => {
      if (visible()) refresh();
      schedule();
    });
  }

  function enter() {
    if (visible()) refresh();
    schedule();
  }

  function leave() {
    confirmId = null;
    schedule();
  }

  return { bind, enter, leave, onStatus, refresh };
}
