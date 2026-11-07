// sidebar-boot.js —— 首帧之前的侧栏形态（经典脚本，<head> 里同步执行；CSP 只允许同源脚本，所以是独立文件）。
// app.js 是模块脚本，要等文档解析完才执行：在那之前浏览器已经按默认的「展开 232px」画出第一帧，
// 随后 sidebar.js 再打上细栏类，侧栏就会当着用户的面收起、内容横跳一下（窗口 <1180 时每次启动都会）。
// 这里在第一次样式计算之前就按窗口宽度与记住的选择打好类，之后 sidebar.js 再打同样的类不会触发过渡。
// 键名与断点必须与 app/sidebar.js 的 SIDEBAR_STORAGE_KEY / WIDE_QUERY 一致（sidebar.test.mjs 校验）。
(() => {
  const root = document.documentElement;
  try {
    const wide = window.matchMedia("(min-width: 1180px)").matches;
    const saved = window.localStorage.getItem("consoleSidebar");
    root.classList.toggle("sidebar-narrow", !wide);
    root.classList.toggle("sidebar-rail", !wide || saved === "rail");
  } catch {}
  // macOS 桌面壳（红绿灯让位、拖拽区）同理提前打上，app.js 里同一行保留作兜底。
  if (window.electronAPI?.platform === "darwin") root.dataset.shell = "mac-desktop";
  // 上次是团队管理员：首帧就留出「团队管理」入口（shell.css 按 html[data-team-admin] 显示），
  // 不等 /api/status 回来再插进侧栏把下面的工具组整体挤下去 33px。状态确认不是管理员时 app.js 撤掉。
  // 键名必须与 app.js 的 TEAM_ADMIN_FLAG_KEY 一致（sidebar.test.mjs 校验）。
  try {
    if (window.localStorage.getItem("consoleTeamAdmin") === "1") {
      root.dataset.teamAdmin = "1";
      bootTeamHeadExtras(JSON.parse(window.localStorage.getItem("consoleTeamHeadExtras") || "[]"));
    }
  } catch {}

  // 团队页头上次显示过的批量按钮（带个数的文案）：解析器一读完按钮就照上次的样子画出来，不等团队模块与数据
  // （不然页头在首帧之后才折成两行，星图与名单整体被挤下 31px）。团队模块拿到概览后按真实数据重写显隐与文案。
  // 只在按钮已完整解析（后面已有兄弟元素）时才改，免得解析器随后再把原文案追加进去。
  // 键名与 team-admin-controller.js 的 TEAM_HEAD_EXTRAS_KEY 一致（sidebar.test.mjs 校验）。
  function bootTeamHeadExtras(pairs) {
    const want = new Map((Array.isArray(pairs) ? pairs : []).filter((p) => Array.isArray(p) && typeof p[0] === "string" && typeof p[1] === "string"));
    if (!want.size) return;
    const apply = (parsed) => {
      for (const [id, label] of want) {
        const el = document.getElementById(id);
        if (!el || (!parsed && !el.nextElementSibling)) continue;
        if (el.hidden) {
          el.textContent = label;
          el.hidden = false;
        }
        want.delete(id);
      }
      return want.size === 0;
    };
    const mo = new MutationObserver(() => {
      if (apply(false)) mo.disconnect();
    });
    mo.observe(root, { childList: true, subtree: true });
    document.addEventListener("DOMContentLoaded", () => {
      mo.disconnect();
      apply(true);
    }, { once: true });
  }

  // 星空 / 纸面版启动才需要的天体舞台模块（~114KB）：默认简洁版不下载；保留这两个偏好时
  // 在首帧前 preload，让 app.js 里的动态 import 直接命中，不把下载推迟到模块执行之后。
  try {
    const skin = window.localStorage.getItem("console-skin");
    if (skin === "starry" || skin === "paper") {
      const link = document.createElement("link");
      link.rel = "modulepreload";
      link.href = "/assets/js/render/galaxy-stage.js";
      document.head.append(link);
    }
  } catch {}

  // 首帧就是上次停留的视图、各面板先占好骨架高度（perf：启动不再跳来跳去）。
  // 此前首帧总是概览、面板按空内容的高度画出来，等 app.js（模块脚本，文档解析完才执行）切到上次的视图、
  // 挂上骨架高度时，整页内容当着用户的面换一遍、往下挤（实测启动布局偏移 CLS 0.23–0.5）。
  // data-boot-view 由 view-tabs.js 接手时撤掉；占位样式由 skeleton.js 挂上骨架后撤掉。
  // 键名、视图名、骨架宿主与默认高度必须与 app/view-tabs.js、app/skeleton.js 一致（sidebar.test.mjs 校验）。
  try {
    const view = window.localStorage.getItem("consoleView");
    if (view === "servers" || view === "events" || view === "usage" || view === "team" || view === "storage") root.dataset.bootView = view;
    if (view === "team") {
      for (const href of [
        "/assets/js/app/team-admin-controller.js",
        "/assets/js/render/team-admin-view.js",
        "/assets/js/render/team-galaxy.js",
        "/assets/js/render/team-galaxy-model.js",
      ]) {
        const link = document.createElement("link");
        link.rel = "modulepreload";
        link.href = href;
        document.head.append(link);
      }
    }
    let saved = {};
    try {
      saved = JSON.parse(window.localStorage.getItem("consoleSkeletonHeights") || "{}") || {};
    } catch {}
    const panels = [
      ["chain", "#chainPanel", 485],
      ["brief", "#briefPanel", 485],
      ["overviewEvents", "#overviewEventsPanel", 52],
      ["serverBriefs", "#serverBriefsPanel", 170],
      ["resources", "#resourcesPanel", 620],
      ["daemons", "#daemonsPanel", 180],
      ["cluster", "#clusterPanel", 1100],
      ["incidents", "#incidentsPanel", 360],
      ["usageMetrics", ".us-metrics", 112],
      ["usageTrend", ".us-trend", 360],
      ["usageCalendar", ".us-calendar", 360],
      ["usageProjects", ".us-projects", 120],
      ["usageSessions", "#usageSessionsPanel", 460],
    ];
    const style = document.createElement("style");
    style.id = "bootSkeletonHeights";
    style.textContent = panels.map(([id, sel, px]) => `${sel}{min-height:${Number(saved[id]) > 40 ? Math.round(saved[id]) : px}px}`).join("");
    document.head.append(style);
  } catch {}
})();
