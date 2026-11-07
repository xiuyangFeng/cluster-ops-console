// 强制同步布局 / 样式重算追踪：对指定交互录一段 trace，列出每次在 JS 里同步触发的 Layout / UpdateLayoutTree
//（耗时 + 触发它的调用栈），按调用位置汇总。交互基准（interact-bench.mjs）只能归因到入口，这里找到具体是哪一行读了布局。
//   node scripts/perf-ui/forced-layout-trace.mjs <源码树> <数据源目录|-> [--skin=starry] [--throttle=4] [--steps=view:servers,palette,view:usage,dialog:dlgSettings]
import { withBench } from "./harness.mjs";

const [tree, dataArg] = process.argv.slice(2);
const opt = Object.fromEntries(process.argv.slice(4).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const SKIN = opt.skin || "starry";
const THROTTLE = Number(opt.throttle || 4);
const STEPS = (opt.steps || "view:servers,view:events,palette,view:usage,dialog:dlgSettings,theme").split(",");

const short = (frame) => `${String(frame.url || "").split("/").pop().split("?")[0]}:${frame.lineNumber + 1} ${frame.functionName || "(anon)"}`;

await withBench(tree, dataArg === "-" ? null : dataArg, async (ctx) => {
  const { send, evaluate, waitFor, url, sleep, on } = ctx;
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem('console-skin', ${JSON.stringify(SKIN)}); localStorage.setItem('consoleView', 'overview'); } catch {}` });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  on(async (m) => {
    if (m.method !== "Fetch.requestPaused") return;
    const { requestId, request } = m.params;
    if (request.method !== "GET") await send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    else await send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await send("Emulation.setDeviceMetricsOverride", { width: 1028, height: 745, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url });
  await waitFor("document.querySelector('#view-overview.active') && document.body.dataset.skin", 25000);
  await sleep(2500);
  await send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  const clickSel = async (sel) => {
    const p = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (!p) throw new Error(`no ${sel}`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p[0], y: p[1], button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  };
  const actions = {
    palette: async () => { await clickSel("#cmdPaletteBtn"); await sleep(600); await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }); },
    // 视觉版本在「配置」里切：打开配置，星空 ↔ 纸面各切一次（每次带约 3.7 秒过场）
    theme: async () => {
      await evaluate("document.getElementById('dlgSettings').showModal(); true");
      await sleep(400);
      await clickSel('#settingsSkinSegmented [data-skin-mode="starry"]');
      await sleep(3900);
      await clickSel('#settingsSkinSegmented [data-skin-mode="paper"]');
      await sleep(3900);
      await evaluate("document.getElementById('dlgSettings').close(); true");
    },
  };

  for (const step of STEPS) {
    const events = [];
    const handler = (m) => { if (m.method === "Tracing.dataCollected") events.push(...m.params.value); };
    on(handler);
    let done;
    const finished = new Promise((r) => { done = r; });
    on((m) => { if (m.method === "Tracing.tracingComplete") done(); });
    await send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing", transferMode: "ReportEvents" });
    if (step.startsWith("view:")) await clickSel(`#tab-${step.slice(5)}`);
    else if (step.startsWith("dialog:")) { await clickSel(`[data-dialog="${step.slice(7)}"]`); }
    else await actions[step]();
    await sleep(1500);
    await send("Tracing.end");
    await finished;
    if (step.startsWith("dialog:")) await evaluate(`document.getElementById(${JSON.stringify(step.slice(7))})?.close(); true`);
    // 强制的 = 带 JS 调用栈的 Layout / UpdateLayoutTree（正常帧里的不带栈）
    const forced = [];
    let frameLayout = 0;
    let frameStyle = 0;
    for (const e of events) {
      if (e.ph !== "X" || !["Layout", "UpdateLayoutTree"].includes(e.name)) continue;
      const stack = e.args?.beginData?.stackTrace || e.args?.data?.stackTrace;
      const ms = (e.dur || 0) / 1000;
      if (stack?.length) forced.push({ kind: e.name === "Layout" ? "layout" : "style", ms, where: stack.slice(0, 4).map(short) });
      if (process.env.LAYOUT_DETAIL && e.name === "Layout" && ms > 5) console.log(`  [layout ${ms.toFixed(1)}ms] dirty=${e.args?.beginData?.dirtyObjects} total=${e.args?.beginData?.totalObjects} partial=${e.args?.beginData?.partialLayout}`);
      if (process.env.LAYOUT_DETAIL && e.name === "UpdateLayoutTree" && ms > 5) console.log(`  [style ${ms.toFixed(1)}ms] elements=${e.args?.elementCount ?? e.args?.beginData?.elementCount ?? "?"}`);
      else if (e.name === "Layout") frameLayout += ms;
      else frameStyle += ms;
    }
    const byWhere = new Map();
    for (const f of forced) {
      const k = `${f.kind} ${f.where.join(" < ")}`;
      const row = byWhere.get(k) || { ms: 0, n: 0 };
      row.ms += f.ms; row.n += 1;
      byWhere.set(k, row);
    }
    console.log(`\n=== ${step}: 强制 ${forced.length} 次 ${forced.reduce((s, f) => s + f.ms, 0).toFixed(1)}ms；帧内 layout ${frameLayout.toFixed(1)}ms style ${frameStyle.toFixed(1)}ms`);
    for (const [k, v] of [...byWhere].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)) console.log(`  ${v.ms.toFixed(1).padStart(6)}ms ×${v.n}  ${k.slice(0, 220)}`);
    await sleep(500);
  }
});
