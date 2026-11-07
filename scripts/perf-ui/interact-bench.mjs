// 交互基准：按日常操作（侧栏切页、开关弹窗、用量切范围 / 点彗星、⌘K 搜索、收起侧栏、换皮肤、图表悬停）测
// 「按下去到画面更新」的耗时——Event Timing（与 Chrome 的 INP 同一口径：输入延迟 + 处理 + 呈现），
// 并用 Long Animation Frames 把慢帧归因到具体脚本（文件:函数）。异步取数的动作另记「内容就绪」。
//   node scripts/perf-ui/interact-bench.mjs <源码树> <数据源目录|-> <out.json> [--runs=5] [--throttle=4] [--skin=starry]
//        [--w=1028] [--h=745] [--only=view,dialog,usage,palette,sidebar,skin,hover]
// 隔离同 bench.mjs（fixture 监控 + 假 ssh + 临时数据目录），一切非 GET 请求在浏览器侧拦掉。
import fs from "node:fs";
import { withBench } from "./harness.mjs";

const [tree, dataArg, outFile] = process.argv.slice(2);
const opt = Object.fromEntries(process.argv.slice(5).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const RUNS = Number(opt.runs || 5);
const THROTTLE = Number(opt.throttle || 4);
const SKIN = opt.skin || "starry";
const W = Number(opt.w || 1028);
const H = Number(opt.h || 745);
const only = opt.only ? new Set(opt.only.split(",")) : null;
const want = (k) => !only || only.has(k);
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const stats = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { median: r1(q(0.5)), p90: r1(q(0.9)), max: r1(s.at(-1)), n: s.length };
};

const OBSERVERS = `window.__ix = { events: [], loafs: [] };
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__ix.events.push({ name: e.name, t: e.startTime, d: e.duration, input: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart, pres: e.startTime + e.duration - e.processingEnd }); }).observe({ type: "event", durationThreshold: 16, buffered: true }); } catch {}
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__ix.loafs.push({ t: e.startTime, d: e.duration, block: e.blockingDuration, styleLayout: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0, scripts: (e.scripts || []).map((s) => ({ d: s.duration, forced: s.forcedStyleAndLayoutDuration || 0, inv: s.invokerType + ":" + String(s.invoker || "").slice(0, 60), src: String(s.sourceURL || "").split("/").pop().split("?")[0] + ":" + (s.sourceFunctionName || "?") + "@" + s.sourceCharPosition })) }); }).observe({ type: "long-animation-frame", buffered: true }); } catch {}
window.__paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
window.__until = async (fn, ms = 15000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { try { if (fn()) return performance.now() - t0; } catch {} await new Promise((r) => requestAnimationFrame(r)); } return null; };`;

const report = { tree, at: new Date().toISOString(), runs: RUNS, throttle: THROTTLE, skin: SKIN, size: [W, H], interactions: {}, scripts: {} };

await withBench(tree, dataArg === "-" ? null : dataArg, async (ctx) => {
  const { send, evaluate, waitFor, url, sleep, metrics, on } = ctx;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem('console-skin', ${JSON.stringify(SKIN)}); localStorage.setItem('consoleView', 'overview'); } catch {}` });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVERS });
  // 预览不许写：非 GET 一律拦掉
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (request.method !== "GET") await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    else await send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url });
  await waitFor("document.querySelector('#view-overview.active') && document.body.dataset.skin", 25000);
  await sleep(2500);
  await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  // 目标元素滚到视口中间，并确认那个点上确实是它（不是被吸顶栏 / 浮层挡住）；在计时开始前做完
  const centerOf = async (sel) => {
    const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r0 = el.getBoundingClientRect(); if (r0.top < 90 || r0.bottom > innerHeight - 20) el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); if (!r.width) return null; const x = r.left + r.width / 2; const y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); return hit && (hit === el || el.contains(hit)) ? [x, y] : { blocked: hit ? (hit.id || String(hit.className)) : null }; })()`);
    if (!Array.isArray(p)) throw new Error(`cannot click ${sel}: ${JSON.stringify(p)}`);
    await sleep(250);
    return p;
  };
  const clickAt = async (p) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p[0], y: p[1] });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p[0], y: p[1], button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p[0], y: p[1], button: "left", clickCount: 1 });
  };
  const click = async (sel) => clickAt(await centerOf(sel));
  const key = async (k, code, keyCode, modifiers = 0) => {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, modifiers });
  };
  const type = async (text) => { for (const ch of text) await send("Input.insertText", { text: ch }); };

  // 一次交互：清空记录 → 做动作 →（可选）等内容就绪 → 停 settle 毫秒收尾；返回 INP 式耗时与这段时间的主线程工作
  async function measure(name, act, { ready = null, settle = 700, target = null } = {}) {
    const point = target ? await centerOf(target) : null;
    if (target) act = () => clickAt(point);
    await evaluate("window.__ix.events.length = 0; window.__ix.loafs.length = 0; window.__ixT0 = performance.now(); true");
    const m0 = await metrics();
    await act();
    const readyMs = ready ? await evaluate(`window.__until(() => ${ready}).then((ms) => ms == null ? null : performance.now() - window.__ixT0)`) : null;
    await sleep(settle);
    const m1 = await metrics();
    const { events, loafs } = await evaluate("({ events: window.__ix.events.slice(), loafs: window.__ix.loafs.slice() })");
    const worst = events.reduce((a, e) => (e.d > (a?.d ?? -1) ? e : a), null);
    for (const lf of loafs) for (const s of lf.scripts) {
      const k = `${s.src} ← ${s.inv}`;
      if (!report.scripts[k]) report.scripts[k] = { ms: 0, forced: 0, n: 0, in: new Set() };
      const row = report.scripts[k];
      row.ms += s.d; row.forced += s.forced; row.n += 1; row.in.add(name);
    }
    const row = {
      inp: worst ? worst.d : 0, // <16ms 的交互 Event Timing 不上报，记 0
      input: worst?.input ?? 0, proc: worst?.proc ?? 0, pres: worst?.pres ?? 0,
      ready: readyMs,
      taskMs: (m1.TaskDuration - m0.TaskDuration) * 1000,
      scriptMs: (m1.ScriptDuration - m0.ScriptDuration) * 1000,
      layoutMs: (m1.LayoutDuration - m0.LayoutDuration) * 1000,
      styleMs: (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000,
      loafBlock: loafs.reduce((s, l) => s + l.block, 0),
      loafMax: loafs.reduce((s, l) => Math.max(s, l.d), 0),
    };
    if (!report.interactions[name]) report.interactions[name] = [];
    report.interactions[name].push(row);
    return row;
  }

  for (let run = 0; run < RUNS; run += 1) {
    if (want("view")) {
      for (const view of ["servers", "events", "usage", "team", "overview"]) {
        if (!(await evaluate(`Boolean(document.querySelector('#tab-${view}:not([hidden])'))`))) continue;
        await measure(`view:${view}`, null, { target: `#tab-${view}`, ready: `document.querySelector('#view-${view}.active')` });
      }
    }
    if (want("dialog")) {
      for (const dlg of ["dlgTimeline", "dlgLogs", "dlgEndpoint", "dlgDoctor", "dlgSettings", "dlgControl"]) {
        if (!(await evaluate(`Boolean(document.querySelector('[data-dialog="${dlg}"]'))`))) continue;
        await measure(`open:${dlg}`, null, { target: `[data-dialog="${dlg}"]`, ready: `document.getElementById('${dlg}')?.open`, settle: 1200 });
        await measure(`close:${dlg}`, () => key("Escape", "Escape", 27), { ready: `!document.getElementById('${dlg}')?.open` });
      }
    }
    if (want("usage")) {
      await click("#tab-usage");
      await waitFor("document.querySelector('#view-usage.active .ob-hero:not(.is-empty), #view-usage.active .us-metrics')", 20000);
      await sleep(800);
      for (const range of ["7", "30", "1"]) {
        await measure(`usage:range${range}`, null, { target: `[data-usage-range="${range}"]`, ready: `document.querySelector('[data-usage-range="${range}"][aria-pressed="true"]') && !document.querySelector('#usageGalaxyStage .ob-hero.is-empty')`, settle: 1500 });
      }
      if (await evaluate("Boolean(document.querySelector('.ob-comet'))")) {
        await measure("usage:comet", null, { target: ".ob-comet", settle: 1500 });
        await measure("usage:comet-off", null, { target: ".ob-comet.is-selected", settle: 1500 });
      }
      await click("#tab-overview");
      await sleep(600);
    }
    if (want("palette")) {
      await measure("palette:open", null, { target: "#cmdPaletteBtn", ready: "document.activeElement?.id === 'cmdInput'" });
      await measure("palette:type", () => type("用量"), { settle: 500 });
      await measure("palette:close", () => key("Escape", "Escape", 27));
    }
    if (want("sidebar")) {
      await measure("sidebar:collapse", null, { target: "#sidebarToggle" });
      await measure("sidebar:expand", null, { target: "#sidebarToggle" });
    }
    // 视觉版本只在「配置」里切（v2.87 起页头没有切换器）；切换带约 3.7 秒的过场，settle 要盖住它
    if (want("skin")) {
      await evaluate("document.getElementById('dlgSettings').showModal(); true");
      await sleep(400);
      await measure("skin:classic", null, { target: '#settingsSkinSegmented [data-skin-mode="classic"]', ready: "document.body.dataset.skin === 'classic'", settle: 4000 });
      await measure(`skin:${SKIN}`, null, { target: `#settingsSkinSegmented [data-skin-mode="${SKIN}"]`, ready: `document.body.dataset.skin === '${SKIN}'`, settle: 4000 });
      await evaluate("document.getElementById('dlgSettings').close(); true");
    }
    if (want("hover")) {
      await click("#tab-usage");
      await waitFor("document.querySelector('#view-usage.active svg')", 20000);
      await sleep(800);
      const box = await evaluate(`(() => { const el = document.querySelector('#view-usage .us-trend svg, #view-usage .lc-svg, #view-usage svg'); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`);
      if (box) {
        await measure("hover:usage-trend", async () => {
          for (let i = 0; i <= 24; i += 1) {
            await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box[0] + (box[2] * i) / 24, y: box[1] + box[3] / 2 });
            await sleep(16);
          }
        });
      }
      await click("#tab-overview");
      await sleep(600);
    }
  }

  await send("Emulation.setCPUThrottlingRate", { rate: 1 });
  report.heapMb = r1((await metrics()).JSHeapUsedSize / 1048576);
  report.domNodes = await evaluate("document.getElementsByTagName('*').length");
  report.errors = ctx.errors.slice(0, 10);
}, { width: W, height: H });

// 汇总：每个交互取各项中位数 / p90；第一次（冷）单列
const out = { ...report, interactions: {}, first: {} };
for (const [name, rows] of Object.entries(report.interactions)) {
  out.first[name] = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, r1(v)]));
  const rest = rows.length > 1 ? rows.slice(1) : rows;
  out.interactions[name] = Object.fromEntries(Object.keys(rows[0]).map((k) => [k, stats(rest.map((r) => r[k]))]));
}
out.scripts = Object.entries(report.scripts)
  .map(([k, v]) => ({ script: k, ms: r1(v.ms), forced: r1(v.forced), n: v.n, in: [...v.in].slice(0, 6) }))
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 40);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
const pad = (s, n) => String(s).padEnd(n);
console.log(pad("interaction", 22), pad("inp", 7), pad("input", 7), pad("proc", 7), pad("pres", 7), pad("ready", 8), pad("task", 8), pad("layout", 8), pad("style", 8), "| first: inp/ready/task");
for (const [name, s] of Object.entries(out.interactions)) {
  const f = out.first[name];
  console.log(pad(name, 22), pad(s.inp.median, 7), pad(s.input.median, 7), pad(s.proc.median, 7), pad(s.pres.median, 7), pad(s.ready.median ?? "-", 8), pad(s.taskMs.median, 8), pad(s.layoutMs.median, 8), pad(s.styleMs.median, 8), `| ${f.inp}/${f.ready ?? "-"}/${f.taskMs}`);
}
console.log("\ntop scripts in long animation frames:");
for (const s of out.scripts.slice(0, 15)) console.log(pad(s.ms, 8), pad(s.forced, 6), pad(s.n, 4), s.script.slice(0, 90), "|", s.in.join(","));
if (out.errors?.length) console.log("ERRORS", out.errors);
