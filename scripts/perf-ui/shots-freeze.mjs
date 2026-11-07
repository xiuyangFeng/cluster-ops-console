// 动效视觉回归截图（确定性帧）：把 requestAnimationFrame 的时间戳固定在同一相位、CSS 动画播放速率设为 0，
// 这样两次截图（优化前 / 优化后）在画布上画出的是同一时刻的同一帧，可以直接逐像素比对。
//
// 用法：node shots-freeze.mjs <源码树> <输出目录> [starry|classic]
import fs from "node:fs";
import path from "node:path";
import { withBench } from "./harness.mjs";

const tree = process.argv[2];
const outDir = process.argv[3];
const skin = process.argv[4] || "starry";
const FREEZE_MS = Number(process.env.FREEZE_MS || 6000);
const READY = `Boolean(document.body && document.body.dataset.health && document.querySelector('.view.active') && !document.querySelector('.view.active [data-skeleton="loading"]'))`;
fs.mkdirSync(outDir, { recursive: true });

await withBench(tree, null, async ({ send, evaluate, waitFor, url, sleep }) => {
  // 固定 rAF 时间戳：所有画布循环每帧都拿到同一个 timeMs → 画出同一帧
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(function(){ const orig = window.requestAnimationFrame.bind(window); const T = ${FREEZE_MS};
      window.requestAnimationFrame = function(cb){ return orig(function(){ try { cb(T); } catch (e) { setTimeout(() => { throw e; }); } }); }; })();`,
  });
  await send("Page.navigate", { url }); await sleep(500);
  await evaluate(`localStorage.setItem("console-skin", ${JSON.stringify(skin)})`);
  for (const view of ["overview", "events", "usage"]) {
    await evaluate(`localStorage.setItem("consoleView", ${JSON.stringify(view)})`);
    await send("Page.navigate", { url }); await sleep(120);
    await waitFor(READY, 20000);
    // 关掉接入引导/任何弹窗，避免遮罩虚化盖住要对比的舞台
    await evaluate(`(async () => { document.getElementById("dlgOnboarding")?.close?.(); document.getElementById("dlgLogs")?.close?.(); document.getElementById("dlgTimeline")?.close?.(); await new Promise((r) => setTimeout(r, 120)); })()`);
    await sleep(2600);
    // CSS 动画：全部暂停并拨到固定相位（画布已由固定 rAF 时间戳定帧）
    await send("Animation.enable");
    await send("Animation.setPlaybackRate", { playbackRate: 0 });
    await evaluate(`for (const a of (document.getAnimations ? document.getAnimations() : [])) { try { a.pause(); a.currentTime = 1200; } catch {} }; new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    await sleep(300);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const file = path.join(outDir, `${skin}-${view}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log("saved", file);
    await send("Animation.setPlaybackRate", { playbackRate: 1 });
  }
}, { width: 1280, height: 860 });
