// storage-admin-controller.js —— 「存储管理（管理员）」页的接线层，外加服务器页磁盘卡片里的入口。
// 只有 status.teamAdmin.isAdmin 为真时显示（root 或 adminUsers）；非管理员前端隐藏、后端 403。
// 进入存储管理页或服务器页时读一次本机概览（GET /api/storage-admin，不发 SSH）；「刷新 / 检测」才连 root。
// 服务器上有扫描在跑时，存储管理页可见期间每 5 秒重读概览（后端自己在问服务器进度，这里只读本机）。
// 磁盘卡片：管理员看到一行入口摘要（这台服务器那块盘谁占得最多 + 容量构成小条），点卡片或这一行 → onOpen()。
// 图上的悬停提示：元素带 data-tip-name / data-tip-value / data-tip-meta，这里用 textContent 填进 #storageAdminTip。
import { createElementLookup } from "../dom-utils.js";
import { buildBrowserHtml, buildListHtml, buildOverviewHtml } from "../render/storage-admin-view.js";
import { DEFAULT_IDLE_MONTHS, diskEntryHtml, IDLE_MONTHS } from "../render/storage-admin-viz.js";

export const STORAGE_ADMIN_POLL_MS = 5000;
const PREFS_KEY = "storageAdminPrefs";
const SSH_TIMEOUT_MS = 60_000;

export function createStorageAdminController({
  doc, getJson, postJson, showToast, isViewVisible = () => true, isHidden = () => false, onOpen = () => {},
  copyText = (text) => globalThis.navigator?.clipboard?.writeText?.(text),
  now = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  storage = typeof localStorage !== "undefined" ? localStorage : null,
}) {
  const $ = createElementLookup(doc);
  let admin = false;
  let activeServerId = null;
  let data = null;
  let loading = false;
  let error = "";
  const busy = {};
  const installers = {};
  // 浏览区：{ kind: "scan", targetId, jobId, rel, view } | { kind: "list", targetId, path, jobId, list }
  let browser = null;
  let browserBusy = false;
  // 界面偏好（记在本机）：当前看的机器、不活跃时长与「只看不活跃」；展开了哪些列表只在本次会话里记。
  const fold = { open: new Set() };
  const prefs = readPrefs();
  function readPrefs() {
    try {
      const raw = JSON.parse(storage?.getItem(PREFS_KEY) || "{}");
      return {
        target: typeof raw.target === "string" ? raw.target : null,
        targets: Array.isArray(raw.targets) ? raw.targets.filter((id) => typeof id === "string") : null,
        months: IDLE_MONTHS.includes(raw.months) ? raw.months : DEFAULT_IDLE_MONTHS,
        only: raw.only === true,
      };
    } catch {
      return { target: null, months: DEFAULT_IDLE_MONTHS, only: false };
    }
  }
  function savePrefs() {
    try {
      storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }
  let timer = null;
  let seq = 0;
  // 磁盘卡片对应哪块盘：正在看的服务器地址 + 它 $HOME 所在挂载点（来自 /api/status）。
  let diskCtx = { hosts: [], mount: "" };
  let lastEntryHtml = null;

  const shown = (view) => admin && isViewVisible(view) && !isHidden() && !doc.hidden;
  const visible = () => shown("storage") || shown("servers");
  const anyRunning = () => Boolean(data?.targets?.some((t) => t.running));
  const message = (err, fallback) => err?.serverMessage || err?.message || fallback;

  function renderEntry() {
    const entry = $("resDiskStorage");
    if (!entry) return;
    if (entry.hidden === admin) entry.hidden = !admin;
    const tile = $("resDiskTile");
    if (tile?.dataset) {
      if (admin) tile.dataset.saEntry = "1";
      else delete tile.dataset.saEntry;
    }
    if (!admin) return;
    const html = diskEntryHtml(data, diskCtx);
    if (html !== lastEntryHtml) {
      lastEntryHtml = html;
      entry.innerHTML = html;
    }
  }

  function render() {
    renderEntry();
    const panel = $("storageAdminPanel");
    if (!panel || !admin) return;
    const body = $("storageAdminBody");
    if (body) {
      const open = new Set([...body.querySelectorAll("details[open]")].map((d) => d.querySelector("summary")?.textContent));
      const closed = new Set([...body.querySelectorAll("details:not([open])")].map((d) => d.querySelector("summary")?.textContent));
      body.innerHTML = buildOverviewHtml(data, {
        installers, busy, error, loading, now: now(), fold, selected: prefs.targets ?? (prefs.target ? [prefs.target] : null),
        activity: { months: prefs.months, only: prefs.only },
      });
      for (const d of body.querySelectorAll("details")) {
        const key = d.querySelector("summary")?.textContent;
        if (open.has(key)) d.open = true;
        else if (closed.has(key)) d.open = false;
      }
    }
    const box = $("storageAdminBrowser");
    const boxPanel = $("storageAdminBrowserPanel");
    if (boxPanel) boxPanel.hidden = !browser;
    if (box) {
      if (browser) {
        const inner = browser.kind === "scan" ? buildBrowserHtml(browser.view, { now: now(), fold }) : buildListHtml(browser.list, { fold });
        box.innerHTML = browserBusy ? `<p class="sa-note">正在读取…</p>${inner}` : inner;
      }
    }
  }

  function schedule() {
    if (timer) clearTimer(timer);
    timer = null;
    if (shown("storage") && anyRunning()) timer = setTimer(() => { timer = null; load({ quiet: true }); }, STORAGE_ADMIN_POLL_MS);
  }

  async function load({ quiet = false } = {}) {
    if (!admin) return;
    const ticket = ++seq;
    if (!quiet) {
      loading = true;
      render();
    }
    try {
      const next = await getJson("/api/storage-admin");
      if (ticket !== seq) return;
      const wasRunning = new Map((data?.targets || []).map((t) => [t.id, t.running?.id]));
      data = next;
      error = "";
      for (const t of next.targets || []) {
        const before = wasRunning.get(t.id);
        if (before && !t.running) showToast?.({ type: "success", title: `${t.label} 扫描结束`, message: "结果已保存在本机，可在「扫描结果」里逐层浏览。" });
      }
    } catch (err) {
      if (ticket !== seq) return;
      error = message(err, "读取失败，请重试。");
    } finally {
      if (ticket === seq) {
        loading = false;
        render();
        schedule();
      }
    }
  }

  async function act(key, run, { okToast = null } = {}) {
    if (busy[key]) return null;
    busy[key] = true;
    render();
    try {
      const res = await run();
      if (okToast) showToast?.({ type: "success", ...okToast });
      return res;
    } catch (err) {
      showToast?.({ type: "warn", title: "操作没有完成", message: message(err, "请重试") });
      return null;
    } finally {
      delete busy[key];
      render();
    }
  }

  // 刷新 / 开始 / 停止都返回该机器的新视图：就地替换。
  function applyTarget(view) {
    if (!view?.id || !data?.targets) return;
    data = { ...data, targets: data.targets.map((t) => (t.id === view.id ? view : t)) };
    seq += 1;
  }

  async function refreshTarget(id) {
    const view = await act(`ref:${id}`, () => postJson("/api/storage-admin/refresh", { targetId: id }, { timeoutMs: 180_000 }));
    if (view) {
      applyTarget(view);
      if (view.status?.state === "ok") delete installers[id];
      render();
      schedule();
    }
  }

  async function openScan(targetId, jobId, rel = "") {
    browserBusy = true;
    render();
    try {
      const qs = new URLSearchParams({ targetId, jobId, rel });
      const view = await getJson(`/api/storage-admin/view?${qs}`);
      browser = { kind: "scan", targetId, jobId, rel, view };
    } catch (err) {
      showToast?.({ type: "warn", title: "打不开这一层", message: message(err, "请重试") });
    } finally {
      browserBusy = false;
      render();
      $("storageAdminBrowserPanel")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }

  async function openList(targetId, path, jobId = null) {
    browserBusy = true;
    render();
    try {
      const qs = new URLSearchParams({ targetId, path });
      if (jobId) qs.set("jobId", jobId);
      const list = await getJson(`/api/storage-admin/list?${qs}`, { timeoutMs: SSH_TIMEOUT_MS });
      browser = { kind: "list", targetId, path, jobId, list };
    } catch (err) {
      showToast?.({ type: "warn", title: "列目录失败", message: message(err, "请重试") });
    } finally {
      browserBusy = false;
      render();
      $("storageAdminBrowserPanel")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    }
  }

  // 列目录时顺带带上「扫描根覆盖这个路径」的最近一份结果，让子目录显示整树大小。
  function scanFor(targetId, path) {
    const t = data?.targets?.find((x) => x.id === targetId);
    const hit = (t?.scans || []).find((j) => path === j.root || path.startsWith(`${j.root}/`));
    return hit?.id || null;
  }

  function startScan(b) {
    const id = b.dataset.saScan;
    const root = b.dataset.root;
    act(`scan:${id}`, () => postJson("/api/storage-admin/scan", { targetId: id, root }, { timeoutMs: SSH_TIMEOUT_MS }), {
      okToast: { title: "已开始扫描", message: `${root}：在服务器后台运行，可以离开这一页` },
    }).then((view) => {
      if (!view) return;
      applyTarget(view);
      render();
      schedule();
    });
  }

  function startUsage(b) {
    const id = b.dataset.saUsage;
    const mount = b.dataset.mount;
    act(`usage:${id}`, () => postJson("/api/storage-admin/usage", { targetId: id, mount }, { timeoutMs: SSH_TIMEOUT_MS }), {
      okToast: { title: "已开始按用户统计", message: `${mount}：服务器上只读读取 inode 表，可以离开这一页` },
    }).then((view) => {
      if (!view) return;
      applyTarget(view);
      render();
      schedule();
    });
  }

  function stopScan(b) {
    const id = b.dataset.saStop;
    act(`stop:${id}`, () => postJson("/api/storage-admin/stop", { targetId: id, jobId: b.dataset.job }, { timeoutMs: SSH_TIMEOUT_MS }), {
      okToast: { title: "已请求停止", message: "已扫部分会照常出结果" },
    }).then((view) => {
      if (!view) return;
      applyTarget(view);
      render();
      schedule();
    });
  }

  function makeKey() {
    act("key", () => postJson("/api/storage-admin/key", {}), { okToast: { title: "专用密钥已生成", message: "下一步：为每台机器生成安装命令" } }).then((key) => {
      if (!key) return;
      data = { ...data, key };
      render();
    });
  }

  function makeInstaller(b) {
    const id = b.dataset.saInstaller;
    act(`inst:${id}`, () => postJson("/api/storage-admin/installer", { targetId: id })).then((res) => {
      if (!res) return;
      installers[id] = res;
      render();
    });
  }

  function copy(b) {
    Promise.resolve(copyText(b.dataset.saCopy))
      .then(() => showToast?.({ type: "success", title: "已复制", message: "粘贴到本机终端执行", duration: 2500 }))
      .catch(() => {});
  }

  // 面板正文里的按钮：选择器 → 处理函数，第一个命中的处理。
  function toggleFold(b) {
    const key = b.dataset.saFold;
    if (fold.open.has(key)) fold.open.delete(key);
    else fold.open.add(key);
    render();
  }

  async function saveTarget(button) {
    const form = button.closest("[data-sa-target-form]");
    if (!form) return;
    const value = (name) => form.querySelector(`[name="${name}"]`)?.value?.trim() || "";
    const target = { id: value("id"), label: value("label"), host: value("host"), port: Number(value("port")), roots: value("roots").split(/[\s,，]+/).filter(Boolean), ...(value("connectionId") ? { connectionId: value("connectionId") } : {}) };
    data = { ...data, setup: { ...target, roots: target.roots.join(" ") } };
    const saved = await act("target", () => postJson("/api/storage-admin/targets", target), { okToast: { title: "存储服务器已保存", message: "继续按接入步骤配置只读扫描。" } });
    if (saved) {
      delete installers[saved.target.id];
      await load();
    }
  }

  function showTargetForm() {
    const form = $("storageAdminBody")?.querySelector?.("[data-sa-target-form]");
    const details = form?.closest("details");
    if (details) details.open = true;
    form?.querySelector('[name="roots"]')?.focus();
  }

  function configureConnection(id) {
    const connection = data?.connections?.find((item) => item.id === id);
    if (!connection) return;
    data = { ...data, setup: { id: `${connection.id}-storage`, label: `${connection.name} · ${connection.sshUser}`,
      connectionId: connection.id, host: connection.host, port: connection.port || 22, roots: "" } };
    render();
    showTargetForm();
  }

  const BODY_ACTIONS = [
    ["[data-sa-show-setup]", showTargetForm],
    ["[data-sa-configure]", (button) => configureConnection(button.dataset.saConfigure)],
    ["[data-sa-save-target]", saveTarget],
    ["[data-sa-fold]", toggleFold],
    ["[data-sa-target-tab]", (b) => {
      const id = b.dataset.saTargetTab;
      const current = prefs.targets ?? (prefs.target ? [prefs.target] : (data?.targets || []).map((t) => t.id));
      prefs.targets = current.includes(id) ? current.filter((s) => s !== id) : [...current, id];
      savePrefs();
      render();
    }],
    ["[data-sa-idle-months]", (b) => {
      prefs.months = Number(b.dataset.saIdleMonths) || DEFAULT_IDLE_MONTHS;
      savePrefs();
      render();
    }],
    ["[data-sa-idle-only]", () => {
      prefs.only = !prefs.only;
      savePrefs();
      render();
    }],
    ["[data-sa-copy]", copy],
    ["[data-sa-key]", makeKey],
    ["[data-sa-installer]", makeInstaller],
    ["[data-sa-refresh]", (b) => refreshTarget(b.dataset.saRefresh)],
    ["[data-sa-scan]", startScan],
    ["[data-sa-usage]", startUsage],
    ["[data-sa-stop]", stopScan],
    ["[data-sa-view]", (b) => openScan(b.dataset.saView, b.dataset.job, "")],
    ["[data-sa-list]", (b) => openList(b.dataset.saList, b.dataset.path, scanFor(b.dataset.saList, b.dataset.path))],
  ];

  const BROWSER_ACTIONS = [
    ["[data-sa-fold]", toggleFold],
    ["[data-sa-close]", () => {
      browser = null;
      render();
    }],
    ["[data-sa-rel]", (b) => openScan(browser.targetId, browser.jobId, b.dataset.saRel)],
    ["[data-sa-list-here]", (b) => {
      const p = b.dataset.saListHere;
      openList(browser.targetId, p, browser.jobId || scanFor(browser.targetId, p));
    }],
  ];

  function dispatch(event, actions) {
    for (const [selector, run] of actions) {
      const button = event.target.closest(selector);
      if (button) {
        run(button);
        return;
      }
    }
  }

  const onClick = (event) => dispatch(event, BODY_ACTIONS);

  function onBrowserClick(event) {
    if (!browser || browserBusy) return;
    dispatch(event, BROWSER_ACTIONS);
  }

  // ---- 悬停 / 聚焦提示 ----
  function showTip(el, event = null) {
    const box = $("storageAdminTip");
    if (!box || !el?.dataset) return;
    const { tipName, tipValue, tipMeta } = el.dataset;
    box.replaceChildren();
    const value = doc.createElement("b");
    value.textContent = tipValue || "";
    const name = doc.createElement("span");
    name.className = "sa-tip-name";
    name.textContent = tipName || "";
    box.append(value, name);
    if (tipMeta) {
      const meta = doc.createElement("small");
      meta.textContent = tipMeta;
      box.append(meta);
    }
    box.hidden = false;
    const rect = el.getBoundingClientRect?.();
    const x = event?.clientX ?? (rect ? rect.left + rect.width / 2 : 0);
    const y = event?.clientY ?? (rect ? rect.top : 0);
    const bw = box.offsetWidth || 200;
    const bh = box.offsetHeight || 60;
    const vw = globalThis.innerWidth || 1200;
    const left = Math.min(Math.max(8, x + 14), vw - bw - 8);
    const top = y - bh - 12 < 8 ? y + 18 : y - bh - 12;
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
  function hideTip() {
    const box = $("storageAdminTip");
    if (box && !box.hidden) box.hidden = true;
  }
  const tipTarget = (event) => event.target?.closest?.("[data-tip-value]") || null;
  function bindTips(host) {
    if (!host) return;
    host.addEventListener("pointermove", (event) => {
      const el = tipTarget(event);
      if (el) showTip(el, event);
      else hideTip();
    });
    host.addEventListener("pointerleave", hideTip);
    host.addEventListener("focusin", (event) => {
      const el = tipTarget(event);
      if (el) showTip(el);
    });
    host.addEventListener("focusout", hideTip);
  }

  function onStatus(status) {
    const active = status?.activeServer || null;
    const mount = status?.layers?.resources?.[status?.activeServerId]?.usage?.filesystem?.mountpoint;
    const ctx = { hosts: [active?.address, active?.host].filter((h) => typeof h === "string" && h), mount: typeof mount === "string" ? mount : "" };
    if (ctx.hosts.join(" ") !== diskCtx.hosts.join(" ") || ctx.mount !== diskCtx.mount) {
      diskCtx = ctx;
      if (admin) renderEntry();
    }
    const next = Boolean(status?.teamAdmin?.isAdmin);
    const serverChanged = activeServerId !== status?.activeServerId;
    activeServerId = status?.activeServerId;
    if (next === admin && !serverChanged) return;
    seq += 1;
    admin = next;
    data = null;
    browser = null;
    for (const key of Object.keys(installers)) delete installers[key];
    render();
    if (admin && visible()) load();
  }

  // view：进入的是哪一页（servers 只为磁盘卡片的摘要读一次本机概览；storage 才会在扫描时轮询）。
  function enter(view = "storage") {
    if (shown(view)) load({ quiet: Boolean(data) });
    if (view !== "storage") hideTip();
  }

  function bind() {
    $("storageAdminBody")?.addEventListener("click", onClick);
    $("storageAdminBody")?.addEventListener("change", (event) => {
      if (!event.target.matches?.("[data-sa-connection]")) return;
      const connection = data?.connections?.find((s) => s.id === event.target.value);
      if (!connection) return;
      const form = event.target.closest("[data-sa-target-form]");
      for (const [name, value] of Object.entries({ id: `${connection.id}-storage`, label: `${connection.name} · ${connection.sshUser}`, host: connection.host, port: connection.port || 22 })) {
        const input = form?.querySelector(`[name="${name}"]`);
        if (input) input.value = value;
      }
    });
    $("storageAdminBrowser")?.addEventListener("click", onBrowserClick);
    bindTips($("storageAdminBody"));
    bindTips($("storageAdminBrowser"));
    // 磁盘卡片整块可点（管理员）；入口按钮本身给键盘用。卡片里选中文字时不跳。
    $("resDiskTile")?.addEventListener("click", (event) => {
      if (!admin) return;
      if (String(globalThis.getSelection?.() || "")) return;
      if (event.target?.closest?.("a, input, select, textarea")) return;
      onOpen();
    });
    $("storageAdminReload")?.addEventListener("click", () => load());
    doc.addEventListener?.("visibilitychange", () => {
      if (shown("storage") && anyRunning()) load({ quiet: true });
      else schedule();
    });
  }

  return { bind, onStatus, enter };
}
