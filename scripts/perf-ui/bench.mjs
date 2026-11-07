// UI 性能基准（v2.63 那一轮性能优化用它做每项修复前后的对比）。
//   node scripts/perf-ui/bench.mjs <源码树> <数据源目录|-> <out.json> [--runs=5] [--throttle=4] [--only=api,startup,switch,scroll,idle,oldlogs]
// 数据源目录 = 含 runtime/ 与 config.local.json 的目录（可以是生产数据目录去掉 *.pid*、control、vault-endpoint 等之后的只读拷贝）；
// 「-」= 空数据。服务器页的集群面板会注入一份确定性的重数据（inject.mjs：20 节点 / 300 作业 / 8 卡）。
// --skin=starry|classic|paper：固定视觉皮肤（不给就是页面默认的简洁版）；--inject=0：不注入重集群层（见下）。
// 测：接口耗时、启动（FCP / 内容就绪 / 布局偏移 CLS / 主线程工作量）、切页、整页滚动、各页停留的常驻开销、
// 翻旧日志（日志浮层往上翻着读、新日志持续进来时阅读位置漂移多少）。对比两份结果：node scripts/perf-ui/compare.mjs a.json b.json
import fs from "node:fs";
import { withBench } from "./harness.mjs";
import { enableHeavyStatus } from "./inject.mjs";

const [tree, dataArg, outFile] = process.argv.slice(2);
const dataSrc = dataArg && dataArg !== "-" ? dataArg : null;
const opt = Object.fromEntries(process.argv.slice(5).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const RUNS = Number(opt.runs || 5);
const THROTTLE = Number(opt.throttle || 4);
const only = opt.only ? new Set(opt.only.split(",")) : null;
const want = (k) => !only || only.has(k);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const stats = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { median: r1(q(0.5)), p90: r1(q(0.9)), min: r1(s[0]), max: r1(s.at(-1)), n: s.length };
};
const agg = (rows) => Object.fromEntries(Object.keys(rows[0] || {}).filter((k) => typeof rows[0][k] === "number").map((k) => [k, stats(rows.map((r) => r[k]))]));
const delta = (a, b) => ({
  scriptMs: (b.ScriptDuration - a.ScriptDuration) * 1000, layoutMs: (b.LayoutDuration - a.LayoutDuration) * 1000,
  styleMs: (b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000, taskMs: (b.TaskDuration - a.TaskDuration) * 1000,
  layouts: b.LayoutCount - a.LayoutCount, styles: b.RecalcStyleCount - a.RecalcStyleCount,
});
const ZERO = { ScriptDuration: 0, LayoutDuration: 0, RecalcStyleDuration: 0, TaskDuration: 0, LayoutCount: 0, RecalcStyleCount: 0 };

const report = { tree, at: new Date().toISOString(), runs: RUNS, throttle: THROTTLE, skin: opt.skin || null };

// ---- API 内容加载（每个视图首屏要等的接口） ----
await withBench(tree, dataSrc, async ({ port, token, sleep }) => {
  const api = async (u) => { const t = performance.now(); const r = await fetch(`http://127.0.0.1:${port}${u}`, { headers: { "x-auth-token": token } }); const b = await r.arrayBuffer(); return { ms: performance.now() - t, bytes: b.byteLength }; };
  await sleep(1500);
  report.api = {};
  report.api.briefCold = r1((await api("/api/brief")).ms);
  for (const u of ["/api/status", "/api/brief", "/api/usage/summary", "/api/usage/summary?range=30", "/api/incidents?state=open&limit=50", "/api/tunnel-stability", "/api/metrics", "/api/logs?limit=500"]) {
    const rows = []; for (let i = 0; i < RUNS; i++) rows.push(await api(u));
    report.api[u] = { ms: stats(rows.map((r) => r.ms)).median, bytes: rows[0].bytes };
  }
});

await withBench(tree, dataSrc, async (ctx) => {
  const { send, evaluate, waitFor, url, sleep, metrics, on } = ctx;
  // --inject=0：不注入重集群层。注入只改 /api/status，SSE 推来的 layers 仍是 fixture 的空集群层，两者交替渲染时
  // 服务器页高度会来回跳——比较「启动时少一次全量刷新」这类改动时要关掉注入，否则测到的是注入假象。
  if (opt.inject !== "0") await enableHeavyStatus(send, on);
  if (opt.skin) await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem('console-skin', ${JSON.stringify(opt.skin)}); } catch {}` });
  let bytes = 0; let requests = 0;
  await send("Network.enable");
  on((m) => { if (m.method === "Network.loadingFinished") { bytes += m.params.encodedDataLength; requests += 1; } });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `(function poll(){ let want = 'overview'; try { want = localStorage.getItem('consoleView') || 'overview'; } catch {} const v = document.querySelector('.view.active'); if (document.body && document.body.dataset.health && v && v.id === 'view-' + want && !v.querySelector('[data-skeleton="loading"]')) { window.__readyAt = performance.now(); return; } requestAnimationFrame(poll); })();` });
  await send("Page.navigate", { url });
  await waitFor("window.__readyAt"); await sleep(1500);

  // ---- 1) 启动 ----
  if (want("startup")) {
    report.startup = {};
    for (const view of ["overview", "servers"]) for (const mode of ["cold", "warm"]) {
      await send("Network.setCacheDisabled", { cacheDisabled: mode === "cold" });
      const rows = [];
      for (let i = 0; i < RUNS; i++) {
        await evaluate(`localStorage.setItem("consoleView", "${view}")`);
        bytes = 0; requests = 0;
        await send("Page.navigate", { url });
        await sleep(100);
        await waitFor("window.__readyAt", 20000);
        await sleep(1200);
        const nav = await evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; const fcp = performance.getEntriesByName('first-contentful-paint')[0];
          return { fcp: fcp ? fcp.startTime : null, dcl: n.domContentLoadedEventEnd, ready: window.__readyAt, cls: window.__bench.shifts.reduce((a,b)=>a+b.v,0), longtaskMs: window.__bench.longtasks.reduce((a,b)=>a+b.d,0) }; })()`);
        const m = await metrics();
        rows.push({ ...nav, bytes, requests, ...delta(ZERO, m) });
      }
      report.startup[`${view}.${mode}`] = agg(rows);
    }
    await send("Network.setCacheDisabled", { cacheDisabled: false });
    await evaluate(`localStorage.setItem("consoleView", "overview")`);
    await send("Page.navigate", { url }); await waitFor("window.__readyAt"); await sleep(1500);
  }

  await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const views = ["overview", "servers", "events", "usage"];

  // ---- 2) 切页 ----
  if (want("switch")) {
    const sw = Object.fromEntries(views.map((v) => [v, []]));
    for (let round = 0; round < RUNS; round++) for (const v of views) {
      const m0 = await metrics();
      const r = await evaluate(`new Promise((resolve) => { const t0 = performance.now(); document.getElementById('tab-${v}').click();
        requestAnimationFrame(() => requestAnimationFrame(() => { const frame = performance.now() - t0;
          (function poll(){ if (!document.querySelector('#view-${v} [data-skeleton="loading"]') || performance.now() - t0 > 15000) resolve({ frameMs: frame, readyMs: performance.now() - t0 }); else requestAnimationFrame(poll); })(); })); })`);
      await sleep(900);
      sw[v].push({ ...r, ...delta(m0, await metrics()) });
    }
    report.switch = Object.fromEntries(views.map((v) => [v, agg(sw[v])]));
  }

  // ---- 3) 滚动（整页） ----
  if (want("scroll")) {
    report.scroll = {};
    for (const v of views) {
      await evaluate(`document.getElementById('tab-${v}').click()`); await sleep(2000);
      const rows = [];
      for (let i = 0; i < 3; i++) {
        const m0 = await metrics();
        const r = await evaluate(`new Promise((resolve) => { let sc = document.getElementById('view-${v}'); while (sc && !(sc.scrollHeight > sc.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement; sc = sc || document.scrollingElement; sc.scrollTop = 0;
          const s0 = window.__bench.shifts.length; const f = []; let last = performance.now(); let dir = 1; const heights = new Set([sc.scrollHeight]);
          function step(now) { f.push(now - last); last = now; sc.scrollTop += dir * 40; heights.add(sc.scrollHeight); const max = sc.scrollHeight - sc.clientHeight;
            if (dir === 1 && sc.scrollTop >= max - 1) dir = -1; else if ((dir === -1 && sc.scrollTop <= 0) || f.length > 3000) { resolve({ h: sc.scrollHeight, f: f.slice(1), cls: window.__bench.shifts.slice(s0).reduce((a,b)=>a+b.v,0), hc: heights.size - 1 }); return; } requestAnimationFrame(step); }
          requestAnimationFrame(step); })`);
        const d = delta(m0, await metrics());
        const s = [...r.f].sort((a, b) => a - b);
        rows.push({ height: r.h, heightChanges: r.hc, frames: s.length, p95: s[Math.floor(s.length * 0.95)], jank: r.f.filter((x) => x > 25).length, cls: r.cls, ...d, taskPerFrame: d.taskMs / Math.max(1, s.length) });
        await sleep(300);
      }
      report.scroll[v] = agg(rows);
    }
  }

  // ---- 4) 常驻：各视图停留 20s 的主线程开销（定时刷新 + 动效） ----
  if (want("idle")) {
    await send("Emulation.setCPUThrottlingRate", { rate: 1 });
    report.idle = {};
    for (const v of views) {
      await evaluate(`document.getElementById('tab-${v}').click()`); await sleep(2500);
      const m0 = await metrics(); await sleep(Number(opt.idle || 20000));
      report.idle[v] = Object.fromEntries(Object.entries(delta(m0, await metrics())).map(([k, x]) => [k, r1(x)]));
    }
    await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  }

  // ---- 5) 翻旧消息：日志查看器里往上翻着看，新日志持续进来 ----
  if (want("oldlogs")) {
    const rows = [];
    for (let i = 0; i < RUNS; i++) {
      const m0 = await metrics();
      const r = await evaluate(`(async () => {
        const { createLogsPanel } = await import('/assets/js/logs-panel.js');
        document.getElementById('benchLogBox')?.remove();
        // 用真实 #log / #logBox 的样式（<pre> 内行内排版）：临时把页面里那一份改名
        const realLog = document.getElementById('log'); realLog.id = 'log__orig'; const realBox = document.getElementById('logBox'); realBox.id = 'logBox__orig';
        const box = document.createElement('div'); box.id = 'logBox'; box.className = 'console-box';
        box.style.cssText = 'position:fixed;left:100px;top:60px;width:800px;height:560px;overflow:auto;z-index:99999;background:var(--panel)';
        const pre = document.createElement('pre'); pre.id = 'log'; box.append(pre); document.body.append(box);
        const panel = createLogsPanel({ logEl: pre, logBox: box, isActive: () => true });
        const base = Date.now() - 3600e3; let n = 0;
        const mk = (op) => ({ ts: base + (n++) * 1000, source: ['timeline','probe','signal','ops'][n % 4], level: n % 13 === 0 ? 'warn' : 'info', message: 'line ' + n + ' channel: waiting -> ok reason=probe latency ' + (n * 7 % 300) + 'ms', ...(op ? { operationId: 'op-' + op } : {}) });
        for (let k = 0; k < 300; k++) panel.appendEntry(mk());
        await new Promise((r) => setTimeout(r, 400));
        // 往上翻到中间读旧消息
        box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) * 0.4);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const topLine = () => { const br = box.getBoundingClientRect(); for (const el of pre.querySelectorAll('.log-line')) { const rc = el.getBoundingClientRect(); if (rc.bottom > br.top + 1) return el; } return null; };
        const anchor = topLine(); const anchorText = anchor.textContent; const y0 = anchor.getBoundingClientRect().top;
        let maxDrift = 0; let lost = 0; const t0 = performance.now(); const frames = []; let last = performance.now(); let alive = true;
        (function fr(now) { frames.push(now - last); last = now; if (alive) requestAnimationFrame(fr); })(performance.now());
        // 5 秒：每 250ms 进来 8 行，第 2 秒来一次操作日志（带 operationId，会走整块重绘）
        for (let tick = 0; tick < 20; tick++) {
          for (let k = 0; k < 8; k++) panel.appendEntry(mk(tick === 8 && k === 0 ? 'x' : null));
          await new Promise((r) => setTimeout(r, 260));
          const el = [...pre.querySelectorAll('.log-line')].find((e) => e.textContent === anchorText);
          if (!el) { lost++; continue; }
          maxDrift = Math.max(maxDrift, Math.abs(el.getBoundingClientRect().top - y0));
        }
        alive = false; box.remove(); realLog.id = 'log'; realBox.id = 'logBox';
        const s = frames.slice(2).sort((a, b) => a - b);
        return { maxDriftPx: maxDrift, lostChecks: lost, p95Frame: s[Math.floor(s.length * 0.95)], jank: frames.filter((x) => x > 25).length };
      })()`);
      rows.push({ ...r, ...delta(m0, await metrics()) });
    }
    report.oldLogs = agg(rows);
  }

  report.heapMb = r1((await metrics()).JSHeapUsedSize / 1048576);
  report.domNodes = (await metrics()).Nodes;
  report.errors = ctx.errors.slice(0, 10);
});

fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log("written", outFile);
