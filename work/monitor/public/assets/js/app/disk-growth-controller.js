// disk-growth-controller.js —— 「查看我的目录占用」面板顶部「作业产出目录」一块的接线层。
// 由目录占用的控制器持有（app/dir-usage-controller.js）：跟着它的服务器与展开状态走，不单独接进 app.js。
// 展开时读一次 GET /api/disk-growth（本机已存的测量，不发 SSH）；点「现在量一次」才 POST /api/disk-growth/scan
// （后端在后台量，见 lib/disk-growth/service.mjs）。后端在量的时候——不管是定时的还是刚点的——面板展开且
// 窗口可见就每 3 秒读一次进度。没有集合目录 / 模块关着 / 后端没有这个接口时整块不显示，也不报错。
import { createElementLookup } from "../dom-utils.js";
import { buildDiskGrowthHtml } from "../render/disk-growth-view.js";

export const DISK_GROWTH_PROGRESS_POLL_MS = 3000;

export function createDiskGrowthController({
  doc, getJson, postJson, showToast, now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const $ = createElementLookup(doc);
  let serverId = null;
  let expanded = false;
  let data = null;
  let busy = false;
  let error = "";
  let seq = 0;
  let pollTimer = null;
  let asked = false; // 这次测量是不是刚才在这里点出来的（定时的那种量完不弹提示）
  let lastHtml = null;

  const running = () => data?.running === true;

  function render() {
    const host = $("resDiskGrowth");
    if (!host) return;
    const html = expanded && serverId ? buildDiskGrowthHtml(data, { busy, error, now: now() }) : "";
    if (host.hidden !== !html) host.hidden = !html;
    if (html !== lastHtml) {
      host.innerHTML = html;
      lastHtml = html;
    }
  }

  function schedulePoll() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    if (running() && expanded && serverId && !doc.hidden) {
      pollTimer = setTimer(() => {
        pollTimer = null;
        load({ quiet: true });
      }, DISK_GROWTH_PROGRESS_POLL_MS);
    }
  }

  // 自己点的那次量完了：说一声结果。
  function announceEnd(before, after) {
    if (!asked || !before?.running || !after || after.running) return;
    asked = false;
    const growth = after.growth;
    const attempt = growth?.attempt;
    if (attempt?.outcome === "error") showToast?.({ type: "warn", title: "作业产出目录没有量成", message: attempt.error || "原因未知" });
    else if (growth && growth.complete === false) showToast?.({ type: "info", title: "作业产出目录", message: "这次没量完，没量完的目录已标出。" });
    else if (growth) showToast?.({ type: "success", title: "作业产出目录", message: "已量完。" });
  }

  // quiet：进度轮询——不清掉已有的报错行。
  async function load({ quiet = false } = {}) {
    if (!serverId || !$("resDiskGrowth")) return;
    const ticket = ++seq;
    if (!quiet) error = "";
    try {
      const next = await getJson(`/api/disk-growth?${new URLSearchParams({ serverId })}`);
      if (ticket !== seq) return;
      announceEnd(data, next);
      data = next;
    } catch {
      // 读不到（后端没有这个接口 / 服务不可用 / 一时超时）：不显示这一块，也不打扰；下次展开再读。
      if (ticket !== seq) return;
      if (!quiet) data = null;
    } finally {
      if (ticket === seq) {
        render();
        schedulePoll();
      }
    }
  }

  async function scan() {
    if (!serverId || busy || running()) return;
    const target = serverId;
    busy = true;
    error = "";
    render();
    try {
      const next = await postJson("/api/disk-growth/scan", { serverId: target });
      if (target !== serverId) return;
      seq += 1; // 进行中的读取不能覆盖这份更新的结果
      data = next;
      asked = true;
    } catch (err) {
      if (target !== serverId) return;
      error = err?.serverMessage || err?.message || "没有量成，请重试。";
      showToast?.({ type: "warn", title: "作业产出目录", message: error });
    } finally {
      busy = false;
      render();
      schedulePoll();
    }
  }

  // 目录占用面板换了服务器（或不再适用：id 为 null）。
  function setServer(id) {
    if (id === serverId) return;
    serverId = id;
    seq += 1;
    data = null;
    error = "";
    asked = false;
    if (expanded && serverId) load();
    else {
      render();
      schedulePoll();
    }
  }

  // 目录占用面板展开 / 收起。每次展开都重读：定时测量可能在收起期间量完了。
  function setExpanded(open) {
    expanded = Boolean(open);
    if (expanded && serverId) load();
    else {
      render();
      schedulePoll();
    }
  }

  // 窗口回到可见：后端可能一直在量，进度要补上。
  function onVisibilityChange() {
    if (!doc.hidden && expanded && serverId && running()) load({ quiet: true });
    else schedulePoll();
  }

  function bind() {
    $("resDiskGrowth")?.addEventListener("click", (event) => {
      if (event.target.closest("[data-dg-scan]")) scan();
    });
  }

  return { bind, setServer, setExpanded, onVisibilityChange };
}
