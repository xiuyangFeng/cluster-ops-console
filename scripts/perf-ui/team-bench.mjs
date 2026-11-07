// 团队管理页性能基准（v2.70 那一轮团队页提速用它做每项修复前后的对比）。
//   node scripts/perf-ui/team-bench.mjs <源码树> <out.json> [--runs=5] [--throttle=4] [--members=40] [--delay=1500] [--only=startup,latency,switch,scroll,interact,idle,memory]
// 隔离：fixture 监控 + 假 ssh + 临时团队配置（fixture.invalid）；/api/team/overview 由 CDP 拦截返回确定性示例数据
//（--delay 模拟集群上 ssh 采集的耗时），/api/team/* 的写请求一律拦掉。
// 测：启动直落团队页（首帧 / 名单就绪 / 星图就绪 / 长任务 / 布局偏移）、ssh 慢时的内容加载（首次 vs 再次启动）、
// 从概览切进团队页（首次 / 再次）、整页滚动帧时间、展开 / 筛选 / 搜索 / 切卡片 / 悬停的响应、停留开销、DOM 与内存。
import fs from "node:fs";
import { withBench } from "./harness.mjs";
import { TEAM_BENCH_CONFIG, teamOverview } from "./team-fixture.mjs";

const [tree, outFile] = process.argv.slice(2);
const opt = Object.fromEntries(process.argv.slice(4).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const RUNS = Number(opt.runs || 5);
const THROTTLE = Number(opt.throttle || 4);
const MEMBERS = Number(opt.members || 40);
const DELAY = Number(opt.delay || 1500);
const only = opt.only ? new Set(opt.only.split(",")) : null;
const want = (k) => !only || only.has(k);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const stats = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { median: r1(q(0.5)), p90: r1(q(0.9)), min: r1(s[0]), max: r1(s.at(-1)), n: s.length };
};
const agg = (rows) => Object.fromEntries(Object.keys(rows[0] || {}).filter((k) => rows.some((r) => typeof r[k] === "number")).map((k) => [k, stats(rows.map((r) => r[k]))]));

const MARKS = `window.__tm = { marks: {} };
(() => {
  const mark = (k) => { if (window.__tm.marks[k] == null) window.__tm.marks[k] = performance.now(); };
  const paint = (k) => requestAnimationFrame(() => requestAnimationFrame(() => mark(k)));
  const check = () => {
    const m = window.__tm.marks;
    if (m.list == null && document.querySelector('#teamAdminList [data-tm-member], #teamAdminList [data-tm-chip]')) { mark('list'); paint('listPaint'); }
    if (m.sky == null && document.querySelector('#teamSky .tm-planet')) { mark('sky'); paint('skyPaint'); }
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true });
})();`;

// 页面里用的小工具：等条件成立（逐帧查）、等两帧（下一次绘制之后）
const PAGE_UTILS = `window.__until = async (fn, ms = 15000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise((r) => requestAnimationFrame(r)); } return false; };
window.__paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));`;

const report = { tree, at: new Date().toISOString(), runs: RUNS, throttle: THROTTLE, members: MEMBERS, delay: DELAY };

await withBench(tree, null, async (ctx) => {
  const { send, evaluate, waitFor, url, sleep, metrics, on } = ctx;
  // —— 拦截团队接口 ——
  let delay = 0;
  let calls = 0;
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/api/team/*", requestStage: "Request" }] });
  on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (request.method !== "GET") { await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }); return; }
    if (request.url.includes("/api/team/overview")) {
      calls += 1;
      const body = Buffer.from(JSON.stringify(teamOverview(MEMBERS, { now: Date.now() + calls }))).toString("base64");
      const wait = delay;
      setTimeout(() => send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body }).catch(() => {}), wait);
      return;
    }
    await send("Fetch.continueRequest", { requestId });
  });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: MARKS });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_UTILS });
  const throttle = (rate) => send("Emulation.setCPUThrottlingRate", { rate });
  // --css=…：注入一段样式做对照实验（例如关掉某条 CSS 优化），走 harness 的 benchCss 机制
  const benchCss = opt.css ? decodeURIComponent(opt.css) : "";
  const nav = async (view) => {
    await evaluate(`(() => { try { localStorage.setItem("consoleView", ${JSON.stringify(view)}); localStorage.setItem("benchCss", ${JSON.stringify(benchCss)}); } catch {} return 1; })()`).catch(() => {});
    await send("Page.navigate", { url });
  };
  const ready = () => waitFor(`window.__tm && window.__tm.marks.listPaint != null && window.__tm.marks.skyPaint != null`, 30000);

  // 预热：建立浏览器缓存、骨架高度记忆，确认团队页可达
  await send("Page.navigate", { url });
  await waitFor(`document.getElementById("tab-team") && !document.getElementById("tab-team").hidden`, 30000);
  await nav("team");
  if ((await ready()) == null) throw new Error("团队页没有就绪（tab 未解锁或接口未拦截）");
  await sleep(1800); // 让 skeleton.rememberShown 记下高度

  // —— 启动：直落团队页 ——
  if (want("startup")) {
    await throttle(THROTTLE);
    const rows = [];
    for (let i = 0; i < RUNS; i += 1) {
      await nav("team");
      await ready();
      await sleep(400);
      const r = await evaluate(`(() => {
        const m = window.__tm.marks;
        const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null;
        const lt = (window.__bench?.longtasks || []).filter((t) => t.t < m.skyPaint + 200);
        const cls = (window.__bench?.shifts || []).reduce((s, x) => s + x.v, 0);
        return { fcp, listPaint: m.listPaint, skyPaint: m.skyPaint, longTaskMs: lt.reduce((s, t) => s + t.d, 0), tbt: lt.reduce((s, t) => s + Math.max(0, t.d - 50), 0), cls: Math.round(cls * 1000) / 1000, longest: Math.max(0, ...lt.map((t) => t.d)) };
      })()`);
      rows.push(r);
    }
    await throttle(1);
    report.startup = agg(rows);
  }

  // —— ssh 慢时的内容加载：首次（无本地旧数据）vs 再次启动 ——
  if (want("latency")) {
    delay = DELAY;
    const cold = [];
    const warm = [];
    for (let i = 0; i < RUNS; i += 1) {
      await evaluate(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("team-admin-overview")) localStorage.removeItem(k); return 1; })()`);
      await nav("team");
      await ready();
      cold.push(await evaluate("window.__tm.marks.listPaint"));
      await sleep(300);
      await nav("team");
      await ready();
      warm.push(await evaluate("window.__tm.marks.listPaint"));
      await sleep(300);
    }
    delay = 0;
    report.latency = { coldListPaint: stats(cold), warmListPaint: stats(warm) };
  }

  // —— 从概览切进团队页（首次 / 再次） ——
  if (want("switch")) {
    await throttle(THROTTLE);
    const rows = [];
    for (let i = 0; i < RUNS; i += 1) {
      await nav("overview");
      await waitFor(`document.getElementById("tab-team") && !document.getElementById("tab-team").hidden && document.querySelector("#view-overview.active")`, 30000);
      await sleep(1200);
      const switchOnce = () => evaluate(`(async () => {
        const t0 = performance.now();
        document.getElementById("tab-team").click();
        await window.__until(() => !document.getElementById("view-team").hidden && document.querySelector("#teamAdminList [data-tm-member]") && document.querySelector("#teamSky .tm-planet"));
        await window.__paint();
        return performance.now() - t0;
      })()`);
      const first = await switchOnce();
      await sleep(600);
      await evaluate(`(async () => { document.getElementById("tab-overview").click(); await window.__paint(); return 1; })()`);
      await sleep(600);
      const again = await switchOnce();
      rows.push({ first, again });
    }
    await throttle(1);
    report.switch = agg(rows);
  }

  // —— 整页滚动（星图在动） ——
  if (want("scroll")) {
    await nav("team");
    await ready();
    await sleep(1500);
    await throttle(THROTTLE);
    const rows = [];
    for (let i = 0; i < Math.max(3, Math.ceil(RUNS / 2)); i += 1) {
      const m0 = await metrics();
      const r = await evaluate(`(async () => {
        const se = document.scrollingElement; se.scrollTop = 0; await window.__paint();
        const iv = []; let last = performance.now(); let dir = 1; let y = 0; const end = last + 3000;
        while (performance.now() < end) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now(); iv.push(now - last); last = now;
          const max = se.scrollHeight - se.clientHeight; y += dir * 48;
          if (y >= max) { y = max; dir = -1; } if (y <= 0) { y = 0; dir = 1; }
          se.scrollTop = y;
        }
        se.scrollTop = 0;
        iv.sort((a, b) => a - b);
        return { frames: iv.length, meanMs: iv.reduce((s, x) => s + x, 0) / iv.length, p95Ms: iv[Math.floor(iv.length * 0.95)], maxMs: iv.at(-1), jank: iv.filter((x) => x > 34).length };
      })()`);
      const m1 = await metrics();
      rows.push({ ...r, scriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000, layoutMs: (m1.LayoutDuration - m0.LayoutDuration) * 1000, styleMs: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000 });
      await sleep(500);
    }
    await throttle(1);
    report.scroll = agg(rows);
  }

  // —— 交互响应 ——
  if (want("interact")) {
    await nav("team");
    await ready();
    await sleep(1500);
    await throttle(THROTTLE);
    const rows = [];
    for (let i = 0; i < RUNS; i += 1) {
      const r = await evaluate(`(async () => {
        const out = {};
        const time = async (act, cond) => { const t0 = performance.now(); act(); await window.__until(cond); await window.__paint(); return performance.now() - t0; };
        const chev = document.querySelectorAll("#teamAdminList .tm-row .tm-chev")[3];
        const row = chev.closest(".tm-row");
        out.expand = await time(() => chev.click(), () => row.classList.contains("is-open") || document.querySelector('#teamAdminList .tm-row.is-open'));
        await new Promise((r) => setTimeout(r, 400));
        const chev2 = document.querySelector('#teamAdminList .tm-row.is-open .tm-chev');
        out.collapse = await time(() => chev2.click(), () => !document.querySelector('#teamAdminList .tm-row.is-open'));
        await new Promise((r) => setTimeout(r, 400));
        out.filter = await time(() => document.querySelector('[data-tm-filter="attention"]').click(), () => document.querySelector('[data-tm-filter="attention"]').getAttribute("aria-pressed") === "true");
        out.filterBack = await time(() => document.querySelector('[data-tm-filter="all"]').click(), () => document.querySelector('[data-tm-filter="all"]').getAttribute("aria-pressed") === "true");
        const input = document.getElementById("teamAdminSearchInput");
        let typeSync = 0;
        const t0 = performance.now();
        for (const ch of "node0") { const s = performance.now(); input.value += ch; input.dispatchEvent(new Event("input", { bubbles: true })); typeSync += performance.now() - s; await new Promise((r) => requestAnimationFrame(r)); }
        await window.__paint();
        out.typeTotal = performance.now() - t0; out.typePerKey = typeSync / 5;
        input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); await window.__paint();
        out.cards = await time(() => document.querySelector('[data-tm-layout="cards"]').click(), () => document.querySelector("#teamAdminList .tm-cards"));
        out.listBack = await time(() => document.querySelector('[data-tm-layout="list"]').click(), () => !document.querySelector("#teamAdminList .tm-cards"));
        const planet = document.querySelectorAll("#teamSky .tm-planet")[2];
        out.hover = await time(() => planet.dispatchEvent(new PointerEvent("pointerenter")), () => document.getElementById("teamSky").classList.contains("is-focusing"));
        planet.dispatchEvent(new PointerEvent("pointerleave", { clientX: -999, clientY: -999 }));
        await window.__paint();
        out.refresh = await time(() => document.getElementById("teamAdminRefreshBtn").click(), () => !document.getElementById("teamAdminRefreshBtn").disabled && document.getElementById("teamAdminUpdatedBadge").textContent.startsWith("更新于"));
        return out;
      })()`);
      rows.push(r);
      await sleep(600);
    }
    await throttle(1);
    report.interact = agg(rows);
  }

  // —— 停留开销（不降速，看常驻主线程占用） ——
  if (want("idle")) {
    await nav("team");
    await ready();
    await sleep(2000);
    const m0 = await metrics();
    await sleep(8000);
    const m1 = await metrics();
    const wall = m1.Timestamp - m0.Timestamp;
    report.idle = {
      mainPct: r1((100 * (m1.TaskDuration - m0.TaskDuration)) / wall),
      scriptPct: r1((100 * (m1.ScriptDuration - m0.ScriptDuration)) / wall),
      layoutPct: r1((100 * (m1.LayoutDuration - m0.LayoutDuration)) / wall),
      stylePct: r1((100 * (m1.RecalcStyleDuration - m0.RecalcStyleDuration)) / wall),
    };
  }

  // —— DOM 与内存 ——
  if (want("memory")) {
    await nav("team");
    await ready();
    await sleep(1500);
    await send("HeapProfiler.enable");
    await send("HeapProfiler.collectGarbage");
    const m = await metrics();
    report.memory = {
      domNodes: m.Nodes,
      teamNodes: await evaluate(`document.getElementById("view-team").getElementsByTagName("*").length`),
      jsHeapMB: r1(m.JSHeapUsedSize / 1048576),
      listHtmlKB: r1((await evaluate(`document.getElementById("teamAdminList").innerHTML.length`)) / 1024),
    };
  }
  report.errors = ctx.errors;
}, { width: 1028, height: 800, teamConfig: TEAM_BENCH_CONFIG });

fs.writeFileSync(outFile, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
