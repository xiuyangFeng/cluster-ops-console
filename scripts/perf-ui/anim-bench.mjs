// 动效皮肤（星空版 / 纸面天台版 / 简洁版）的常驻开销基准：停在各视图上的主线程工作量、
// 逐帧回调节奏、canvas 后台像素内存、CSS 动画与样式重算、JS 堆与 DOM。
//
// 与 bench.mjs 的分工：bench.mjs 测「启动 / 切页 / 滚动 / 翻旧日志」等一次性的交互成本；
// 这里测「什么都不做、只是停在这一页」时动效持续烧掉的 CPU 与内存——也就是 .app 常驻开销。
//
// 用法：
//   node scripts/perf-ui/anim-bench.mjs <源码树> <数据源目录|-> <out.json> \
//     [--runs=2] [--idle=12000] [--skins=starry,classic] [--views=overview,servers,events,usage] [--profile]
// 数据源目录 = 含 runtime/ 与 config.local.json 的目录（可用 git archive 出来的只读树自带空数据）；
// 「-」= 空数据。隔离 fixture 服务 + 假 ssh + 无头 Chrome，不碰现役环境（见 harness.mjs）。
//
// 对比两次结果：node scripts/perf-ui/compare.mjs a.json b.json 只看 api/startup/switch 时用；
// 这里的数据结构不同，直接看 out.json 的 views[skin][view] 字段。
import fs from "node:fs";
import { withBench } from "./harness.mjs";

const [tree, dataArg, outFile] = process.argv.slice(2);
const dataSrc = dataArg && dataArg !== "-" ? dataArg : null;
const opt = Object.fromEntries(process.argv.slice(5).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const RUNS = Number(opt.runs || 2);
const IDLE_MS = Number(opt.idle || 12000);
const skins = (opt.skins || "starry,classic").split(",");
const views = (opt.views || "overview,servers,events,usage").split(",");
const r1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const READY = `Boolean(document.body && document.body.dataset.health && document.querySelector('.view.active') && !document.querySelector('.view.active [data-skeleton="loading"]'))`;

if (!tree || !outFile) {
  console.error("用法：node scripts/perf-ui/anim-bench.mjs <源码树> <数据源目录|-> <out.json> [--runs=2] [--idle=12000] [--skins=starry,classic] [--views=...] [--profile]");
  process.exit(2);
}

const report = { tree, at: new Date().toISOString(), runs: RUNS, idleMs: IDLE_MS, views: {} };

await withBench(tree, dataSrc, async ({ send, evaluate, waitFor, url, sleep, metrics }) => {
  // 首帧前写入皮肤与视图偏好：避免先按默认皮肤渲染再切换（切换会触发天际线过渡，污染测量）
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { window.__skin = new URLSearchParams(location.search).get("benchSkin"); if (window.__skin) localStorage.setItem("console-skin", window.__skin); } catch {}
      window.__raf = { byName: {} };
      (function(){ const orig = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = function(cb) { const n = (cb && cb.name) || "anon"; window.__raf.byName[n] = (window.__raf.byName[n] || 0) + 1; return orig(cb); };
      })();`,
  });
  // 让页面按「窗口有焦点」测量：真实桌面应用里窗口几乎总是聚焦的，无头 Chrome 默认可能自认未聚焦，
  // 会让「失焦降帧」策略把帧率压到 13fps，测出来的省 CPU 会不真实。
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Page.navigate", { url }); await sleep(500); // localStorage 在 about:blank 不可读

  for (const skin of skins) {
    report.views[skin] = {};
    for (const view of views) {
      const rows = [];
      for (let run = 0; run < RUNS; run++) {
        await evaluate(`localStorage.setItem("console-skin", ${JSON.stringify(skin)}); localStorage.setItem("consoleView", ${JSON.stringify(view)})`);
        await send("Page.navigate", { url }); await sleep(120);
        await waitFor(READY, 20000);
        await sleep(1800); // 过渡动效（天际线 1.05s）与首轮补渲先结束
        const struct = await evaluate(`(() => {
          const seg = (el) => { const r = el.getBoundingClientRect(); return (el.id ? "#" + el.id : el.tagName.toLowerCase()) + " " + Math.round(r.width) + "x" + Math.round(r.height); };
          const canvases = [...document.querySelectorAll("canvas")].map((c) => ({ seg: seg(c), w: c.width, h: c.height, bytes: c.width * c.height * 4, visible: !!(c.offsetWidth && c.offsetHeight) }));
          const anims = (document.getAnimations ? document.getAnimations() : []).map((a) => ({ name: a.animationName || a.transitionProperty || "?", state: a.playState }));
          return {
            canvasCount: canvases.length,
            canvasBytes: canvases.reduce((a, c) => a + c.bytes, 0),
            canvases: canvases.slice(0, 8),
            cssAnimations: anims.filter((a) => a.state === "running").length,
            cssAnimationNames: [...new Set(anims.map((a) => a.name))].slice(0, 20),
            domNodes: document.getElementsByTagName("*").length,
            activeView: (document.querySelector(".view.active") || {}).id,
            focused: document.hasFocus(),
          };
        })()`);
        const m0 = await metrics();
        const t0 = await evaluate("performance.now()");
        const raf0 = JSON.parse(await evaluate("JSON.stringify(window.__raf)"));
        const long0 = await evaluate("window.__bench.longtasks.length");
        await sleep(IDLE_MS);
        const m1 = await metrics();
        const t1 = await evaluate("performance.now()");
        const raf1 = JSON.parse(await evaluate("JSON.stringify(window.__raf)"));
        const elapsedSec = (t1 - t0) / 1000;
        const rafPerSec = {};
        for (const [n, c] of Object.entries(raf1.byName)) {
          const d = c - (raf0.byName[n] || 0);
          if (d > 0) rafPerSec[n] = Math.round((d / elapsedSec) * 10) / 10;
        }
        rows.push({
          ...struct,
          taskMs: r1((m1.TaskDuration - m0.TaskDuration) * 1000),
          scriptMs: r1((m1.ScriptDuration - m0.ScriptDuration) * 1000),
          styleMs: r1((m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000),
          layoutMs: r1((m1.LayoutDuration - m0.LayoutDuration) * 1000),
          taskPctOfCore: r1(((m1.TaskDuration - m0.TaskDuration) * 1000) / IDLE_MS * 100),
          styles: m1.RecalcStyleCount - m0.RecalcStyleCount,
          layouts: m1.LayoutCount - m0.LayoutCount,
          heapMb: r1(m1.JSHeapUsedSize / 1048576),
          heapDeltaMb: r1((m1.JSHeapUsedSize - m0.JSHeapUsedSize) / 1048576),
          nodes: m1.Nodes,
          rafPerSec,
          longtasks: await evaluate(`window.__bench.longtasks.slice(${long0}).map((t) => Math.round(t.d))`),
        });
      }
      const med = (k) => {
        const xs = rows.map((r) => r[k]).filter((x) => typeof x === "number").sort((a, b) => a - b);
        return xs.length ? xs[Math.floor(xs.length / 2)] : null;
      };
      const rafPeak = {};
      for (const r of rows) for (const [n, v] of Object.entries(r.rafPerSec || {})) rafPeak[n] = Math.max(rafPeak[n] || 0, v);
      report.views[skin][view] = {
        taskMs: med("taskMs"), taskPctOfCore: med("taskPctOfCore"), scriptMs: med("scriptMs"), styleMs: med("styleMs"),
        layoutMs: med("layoutMs"), styles: med("styles"), layouts: med("layouts"),
        cssAnimations: med("cssAnimations"), cssAnimationNames: rows[0].cssAnimationNames,
        canvasCount: med("canvasCount"), canvasMb: r1(med("canvasBytes") / 1048576), canvases: rows[0].canvases,
        heapMb: med("heapMb"), heapDeltaMb: med("heapDeltaMb"), nodes: med("nodes"),
        rafPerSec: rafPeak, longtasks: rows[0].longtasks, activeView: rows[0].activeView, focused: rows[0].focused, runs: rows.length,
      };
      console.log(skin, view, JSON.stringify(report.views[skin][view]));
    }
  }

  if (opt.profile) {
    // CPU profile：停在各视图 6 秒，按函数自耗时排序（找真正烧 CPU 的那几行）
    report.profile = {};
    for (const view of views) {
      await evaluate(`localStorage.setItem("console-skin", ${JSON.stringify(skins[0])}); localStorage.setItem("consoleView", ${JSON.stringify(view)})`);
      await send("Page.navigate", { url }); await sleep(120); await waitFor(READY, 20000); await sleep(1800);
      await send("Profiler.enable"); await send("Profiler.start"); await sleep(6000);
      const { profile } = await send("Profiler.stop");
      const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      for (let i = 0; i < profile.samples.length; i++) {
        const n = byId.get(profile.samples[i]); if (!n) continue;
        const cf = n.callFrame; const key = `${cf.functionName || "(anon)"} @ ${(cf.url || "").split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`;
        self.set(key, (self.get(key) || 0) + (profile.timeDeltas[i] || 0));
      }
      report.profile[view] = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([fn, us]) => ({ fn, ms: r1(us / 1000) }));
      await send("Profiler.disable");
      console.log("profile", view, JSON.stringify(report.profile[view].slice(0, 6)));
    }
  }
}, { width: 1028, height: 800 });

report.errors = [];
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log("written", outFile);
