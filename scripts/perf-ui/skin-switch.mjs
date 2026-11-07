// 皮肤切换（简洁版 ↔ 星空版）开关速度：点按钮到「两帧画完」的耗时 + 切换后 1.5s 主线程任务量。
// 用法：node skin-switch.mjs <源码树> <out.json> [rounds]
import fs from "node:fs";
import { withBench } from "./harness.mjs";

const tree = process.argv[2];
const OUT = process.argv[3] || "/tmp/perf/skin-switch.json";
const ROUNDS = Number(process.argv[4] || 5);
const READY = `Boolean(document.body && document.body.dataset.health && document.querySelector('.view.active') && !document.querySelector('.view.active [data-skeleton="loading"]'))`;

await withBench(tree, null, async ({ send, evaluate, waitFor, url, sleep, metrics }) => {
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await send("Page.navigate", { url }); await sleep(400);
  await evaluate(`localStorage.setItem("console-skin", "classic")`);
  await send("Page.navigate", { url }); await sleep(120);
  await waitFor(READY, 20000); await sleep(1500);

  const clickAndWait = (label) => evaluate(`(async () => {
    const btns = [...document.querySelectorAll("button[data-skin-mode]")];
    const btn = btns.find((b) => b.dataset.skinMode === ${JSON.stringify(label)} && b.offsetParent !== null);
    if (!btn) return { error: "no-button", found: btns.map((b) => b.dataset?.skin || b.textContent?.trim().slice(0, 8)).slice(0, 12) };
    const t0 = performance.now();
    btn.click();
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(performance.now())));
    await frame(); await frame();
    const frames2 = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 600));
    const frame3 = performance.now();
    await frame();
    return { clickTo2Frames: Math.round(frames2 * 10) / 10, clickTo3rdFrame: Math.round((performance.now() - frame3) * 10) / 10 };
  })()`);

  const rows = [];
  for (let i = 0; i < ROUNDS; i++) {
    const before = await metrics();
    const toStarry = await clickAndWait("starry");
    await sleep(1200);
    const mid = await metrics();
    const toClassic = await clickAndWait("classic");
    await sleep(1200);
    const after = await metrics();
    rows.push({
      toStarry,
      starryTaskMs: Math.round((mid.TaskDuration - before.TaskDuration) * 1000),
      toClassic,
      classicTaskMs: Math.round((after.TaskDuration - mid.TaskDuration) * 1000),
    });
  }
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const nums = (sel) => rows.map(sel).filter((n) => typeof n === "number");
  const report = {
    rounds: ROUNDS,
    toStarry2FramesMs: med(nums((r) => r.toStarry.clickTo2Frames)),
    toStarry3rdFrameMs: med(nums((r) => r.toStarry.clickTo3rdFrame)),
    toClassic2FramesMs: med(nums((r) => r.toClassic.clickTo2Frames)),
    starryTaskMs: med(nums((r) => r.starryTaskMs)),
    classicTaskMs: med(nums((r) => r.classicTaskMs)),
    rows,
  };
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
}, { width: 1028, height: 800 });
