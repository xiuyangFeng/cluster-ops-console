// dir-usage-controller.js —— 资源与负载面板「查看我的目录占用」的接线层。
// 只在查看团队集群时显示入口（个人服务器不提供，与用量 / 作业同一范围）。
// 展开只读本机已存结果（GET /api/dir-usage，不发 SSH）；只有点「开始扫描 / 继续扫描 / 重新扫描」
// 才 POST /api/dir-usage/scan（auto：后端一轮接一轮自动续扫到完成，见 lib/dir-usage/service.mjs）。
// 没有任何定时扫描。后端在扫的时候，这里每 2 秒读一次本机结果来更新进度（只在面板展开且窗口可见时）；
// 「停止」POST /api/dir-usage/stop。
// 面板顶部另有一块「作业产出目录」（v2.62 磁盘增长归因，#resDiskGrowth）：那是后端按时间表自己量的，
// 由 app/disk-growth-controller.js 管；这里只把查看的服务器与展开状态告诉它。
import { createElementLookup } from "../dom-utils.js";
import { buildDirUsageHtml } from "../render/dir-usage-view.js";
import { createDiskGrowthController } from "./disk-growth-controller.js";

// 与后端 isDirUsageEligible 同一口径；配置还没加载到时不显示入口。
export function dirUsageEligible(server) {
  return Boolean(server) && server.disabled !== true && server.monitorEnabled !== false && server.source !== "personal";
}

export const DIR_USAGE_PROGRESS_POLL_MS = 2000;

export function createDirUsageController({
  doc, getJson, postJson, showToast, getConfig, now = Date.now,
  copyText = (text) => globalThis.navigator?.clipboard?.writeText?.(text),
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
}) {
  const $ = createElementLookup(doc);
  let serverId = null;
  let lastKey = "";
  let expanded = false;
  let data = null;
  let root = null; // null = 让后端选该服务器最近一次扫描的根
  let loading = false;
  let busy = false;
  let error = "";
  let seq = 0;
  let pollTimer = null;
  const growth = createDiskGrowthController({ doc, getJson, postJson, showToast, now, setTimer, clearTimer });

  const autoRunning = () => Boolean(data?.auto?.running);

  // 后端在自动续扫：面板展开且窗口可见时每 2 秒读一次进度；扫完 / 停下后说一声。
  function schedulePoll() {
    if (pollTimer) clearTimer(pollTimer);
    pollTimer = null;
    if (autoRunning() && expanded && serverId && !doc.hidden) pollTimer = setTimer(pollProgress, DIR_USAGE_PROGRESS_POLL_MS);
  }

  async function pollProgress() {
    pollTimer = null;
    if (!autoRunning() || !serverId) return;
    await load({ quiet: true });
  }

  function announceEnd(before, after) {
    if (!before?.running || !after || after.running) return;
    if (after.reason === "done") showToast?.({ type: "success", title: "目录占用", message: "已扫完。" });
    else if (after.reason === "error") showToast?.({ type: "warn", title: "目录占用扫描停下了", message: after.error || "原因未知" });
    else if (after.reason === "limit") showToast?.({ type: "info", title: "目录占用", message: "已连续扫描 3 小时，先停下了，可以点「继续扫描」。" });
  }

  function render() {
    const body = $("resDirUsageBody");
    const toggle = $("resDirUsageToggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.textContent = expanded ? "收起我的目录占用" : "查看我的目录占用";
    }
    if (!body) return;
    body.hidden = !expanded;
    if (!expanded) return;
    // 重绘前后保留各目录行的展开态。
    const open = new Set([...body.querySelectorAll("details[open][data-du-rel]")].map((d) => d.dataset.duRel));
    body.innerHTML = buildDirUsageHtml(data, { busy, loading, error, now: now() });
    for (const d of body.querySelectorAll("details[data-du-rel]")) if (open.has(d.dataset.duRel)) d.open = true;
  }

  // quiet：进度轮询——不显示「读取中」、不清掉已有的报错行。
  async function load({ quiet = false } = {}) {
    if (!serverId) return;
    const ticket = ++seq;
    if (!quiet) {
      loading = true;
      error = "";
      render();
    }
    try {
      const qs = new URLSearchParams({ serverId });
      if (root != null) qs.set("root", root);
      const next = await getJson(`/api/dir-usage?${qs}`);
      if (ticket !== seq) return;
      announceEnd(data?.auto, next?.auto);
      data = next;
      root = next?.root ?? root;
    } catch (err) {
      if (ticket !== seq) return;
      error = err?.serverMessage || "读取本机结果失败，请重试。";
    } finally {
      if (ticket === seq) {
        loading = false;
        render();
        schedulePoll();
      }
    }
  }

  // mode：start（从头）| continue（从游标接着）→ 后端开始自动续扫；stop → 让它扫完这一轮就停。
  async function scan(mode) {
    if (!serverId || busy) return;
    const target = serverId;
    busy = true;
    error = "";
    render();
    try {
      const next = mode === "stop"
        ? await postJson("/api/dir-usage/stop", { serverId: target })
        : await postJson("/api/dir-usage/scan", { serverId: target, root: root ?? "", mode, auto: true });
      if (target !== serverId) return;
      seq += 1; // 进行中的读取不能覆盖这份更新的结果
      data = next;
      root = next?.root ?? root;
    } catch (err) {
      // 期间切到了别的服务器：这份报错不属于现在看的这台。
      if (target !== serverId) return;
      error = err?.serverMessage || err?.message || "扫描失败，请重试。";
      showToast?.({ type: "warn", title: mode === "stop" ? "没有停下" : "目录占用扫描失败", message: error });
    } finally {
      busy = false;
      render();
      schedulePoll();
    }
  }

  // 每次渲染 status 时调用：切换服务器 / 团队与个人之间切换时更新入口；展开着就重读新服务器的本机结果。
  function onStatus(status) {
    const section = $("resDirUsage");
    if (!section) return;
    const id = status?.activeServerId || null;
    const server = (getConfig?.()?.servers || []).find((s) => s.id === id) || null;
    const eligible = dirUsageEligible(server);
    if (section.hidden === eligible) section.hidden = !eligible;
    const key = `${id}|${eligible}`;
    if (key === lastKey) return;
    lastKey = key;
    serverId = eligible ? id : null;
    data = null;
    root = null;
    error = "";
    growth.setServer(serverId);
    if (expanded && serverId) load();
    else {
      render();
      schedulePoll();
    }
  }

  function bind() {
    growth.bind();
    $("resDirUsageToggle")?.addEventListener("click", () => {
      expanded = !expanded;
      growth.setExpanded(expanded);
      // 展开时后端可能正在扫（上次点的，或者刚才收起了面板）：重读一次才知道现状。
      if (expanded && serverId && (!data || autoRunning())) load();
      else {
        render();
        schedulePoll();
      }
    });
    // 窗口回到可见：后端一直在扫，进度要补上。
    doc.addEventListener?.("visibilitychange", () => {
      growth.onVisibilityChange();
      if (!doc.hidden && expanded && serverId && autoRunning()) load({ quiet: true });
      else schedulePoll();
    });
    $("resDirUsageBody")?.addEventListener("click", (event) => {
      const copyBtn = event.target.closest("[data-du-copy-cmd]");
      if (copyBtn) {
        const cmd = copyBtn.dataset.duCopyCmd;
        if (cmd) {
          Promise.resolve(copyText(cmd)).then(() => {
            showToast?.({ type: "success", title: "已复制清理命令", message: `${cmd}（可在集群终端粘贴执行）`, duration: 3500 });
          }).catch(() => {});
        }
        return;
      }
      const scanBtn = event.target.closest("[data-du-scan]");
      if (scanBtn) {
        scan(scanBtn.dataset.duScan);
        return;
      }
      const open = event.target.closest("[data-du-root]");
      if (open && !busy) {
        // summary 里的按钮：不要顺带切换 <details> 的展开态。
        event.preventDefault();
        root = open.dataset.duRoot;
        load();
      }
    });
  }

  return { bind, onStatus };
}
