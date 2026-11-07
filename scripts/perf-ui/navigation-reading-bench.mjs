// Isolated browser checks for navigation work, scroll restoration and sustained log reading.
// node scripts/perf-ui/navigation-reading-bench.mjs <tree> <out.json> [runs=5] [navigation|logs]
import assert from "node:assert/strict";
import fs from "node:fs";
import { withBench } from "./harness.mjs";
import { enableHeavyStatus } from "./inject.mjs";

const [tree, out, count = "5", only] = process.argv.slice(2);
const report = { tree, runs: Number(count), throttle: 4, navigation: [], logs: [] };
const diff = (a, b) => Object.fromEntries(["ScriptDuration", "LayoutDuration", "TaskDuration"].map(k => [k, (b[k] - a[k]) * 1000]));
await withBench(tree, null, async ({ send, on, evaluate, waitFor, url, sleep, metrics, errors }) => {
  await enableHeavyStatus(send, on);
  await send("Page.navigate", { url });
  assert.notEqual(await waitFor("document.body.dataset.health && !document.documentElement.dataset.bootView"), null);
  await sleep(1600);
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await evaluate(`window.__paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  if (!only || only === "navigation") for (let run = 0; run < Number(count); run++) {
    await evaluate(`document.getElementById('tab-servers').click()`);
    await sleep(1600);
    const before = await metrics();
    const row = await evaluate(`(async () => {
      const click = v => document.getElementById('tab-' + v).click();
      const sc = document.scrollingElement;
      sc.scrollTop = 900; await __paint();
      const saved = sc.scrollTop;
      click('events'); await __paint();
      const firstVisitTop = sc.scrollTop;
      sc.scrollTop = 0;
      click('servers'); await __paint();
      const returnDriftPx = Math.abs(sc.scrollTop - saved);
      let mutations = 0;
      const mo = new MutationObserver(rs => mutations += rs.length);
      for (const el of document.querySelectorAll('.view-tab, .view')) mo.observe(el, { attributes: true });
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) click('servers');
      const repeatClickMs = performance.now() - t0;
      await __paint(); mo.disconnect();
      return { saved, firstVisitTop, returnDriftPx, repeatClickMs, repeatedMutations: mutations };
    })()`);
    Object.assign(row, diff(before, await metrics()));
    await evaluate(`document.getElementById('tab-usage').click()`);
    await sleep(800);
    let requests = 0;
    const listener = m => { if (m.method === "Network.requestWillBeSent" && m.params.request.url.includes("/api/usage/summary?")) requests++; };
    await send("Network.enable"); on(listener);
    const usageBefore = await metrics();
    await evaluate(`(async () => {
      for (let i = 0; i < 6; i++) {
        document.getElementById('tab-overview').click(); await __paint();
        document.getElementById('tab-usage').click(); await __paint();
        await new Promise(r => setTimeout(r, 150));
      }
    })()`);
    row.usageRequests = requests;
    row.usageWork = diff(usageBefore, await metrics());
    report.navigation.push(row);
    console.log("navigation", run + 1, JSON.stringify(row));
  }
  if (!only || only === "logs") for (let run = 0; run < Number(count); run++) {
    await evaluate(`(async () => {
      document.getElementById('tab-overview').click();
      const { createLogsPanel } = await import('/assets/js/logs-panel.js');
      const realLog = document.getElementById('log'); realLog.id = 'log__orig';
      const realBox = document.getElementById('logBox'); realBox.id = 'logBox__orig';
      const box = document.createElement('div'); box.id = 'logBox'; box.className = 'console-box';
      box.style.cssText = 'position:fixed;left:100px;top:60px;width:800px;height:560px;overflow:auto;z-index:99999;background:var(--panel)';
      const pre = document.createElement('pre'); pre.id = 'log'; box.append(pre); document.body.append(box);
      const entry = i => ({ ts: 1792224000000 + i * 1000, source: 'ops', level: 'info', message: 'reading bench ' + i, ...(i >= 300 && i % 50 === 0 ? { operationId: 'op-' + i } : {}) });
      const panel = createLogsPanel({ logEl: pre, logBox: box, isActive: () => true });
      for (let i = 0; i < 300; i++) panel.appendEntry(entry(i));
      await new Promise(r => setTimeout(r, 350));
      box.scrollTop = Math.round((box.scrollHeight - box.clientHeight) * 0.4); await __paint();
      const anchor = [...pre.querySelectorAll('.log-line')].find(el => el.getBoundingClientRect().bottom > box.getBoundingClientRect().top + 1);
      window.__reading = { box, pre, panel, entry, anchor, text: anchor.textContent, y: anchor.getBoundingClientRect().top, realLog, realBox };
    })()`);
    const before = await metrics();
    const row = await evaluate(`(async () => {
      const { box, pre, panel, entry, anchor, text, y } = __reading;
      let drift = 0, lost = 0, replacements = 0, maxLines = 0;
      for (let tick = 0; tick < 12; tick++) {
        for (let i = 300 + tick * 50; i < 350 + tick * 50; i++) panel.appendEntry(entry(i));
        await new Promise(r => setTimeout(r, 270));
        const el = [...pre.querySelectorAll('.log-line')].find(el => el.textContent === text);
        if (!el) lost++; else drift = Math.max(drift, Math.abs(el.getBoundingClientRect().top - y));
        if (!anchor.isConnected) replacements++;
        maxLines = Math.max(maxLines, pre.querySelectorAll('.log-line').length);
      }
      return { maxDriftPx: drift, lostChecks: lost, replacedChecks: replacements, maxLines };
    })()`);
    Object.assign(row, diff(before, await metrics()));
    Object.assign(row, await evaluate(`(async () => {
      const { box, pre, panel, entry, anchor, realLog, realBox } = __reading;
      const originalFetch = window.fetch;
      window.fetch = async () => new Response(JSON.stringify({ entries: Array.from({length:500}, (_, i) => entry(400 + i)) }), { headers: { 'content-type': 'application/json' } });
      await panel.refresh();
      const refreshPreserved = anchor.isConnected;
      box.scrollTop = box.scrollHeight; box.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 350)); await __paint();
      const latest = pre.textContent.includes('reading bench 899');
      const endLines = pre.querySelectorAll('.log-line').length;
      window.fetch = originalFetch;
      box.remove(); realLog.id = 'log'; realBox.id = 'logBox';
      return { refreshPreserved, latest, endLines };
    })()`));
    report.logs.push(row);
    console.log("logs", run + 1, JSON.stringify(row));
  }
  report.errors = errors;
  assert.deepEqual(errors, []);
});
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
if (process.argv.includes("--verify")) {
  for (const r of report.navigation) {
    assert.equal(r.returnDriftPx, 0);
    assert.equal(r.repeatedMutations, 0);
    assert.equal(r.usageRequests, 0);
  }
  for (const r of report.logs) {
    assert.equal(r.maxDriftPx, 0); assert.equal(r.lostChecks, 0); assert.equal(r.replacedChecks, 0);
    assert.equal(r.refreshPreserved, true); assert.equal(r.latest, true); assert.ok(r.endLines <= 300);
  }
}
