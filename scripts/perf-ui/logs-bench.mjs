// node scripts/perf-ui/logs-bench.mjs <tree> <out.json> [runs=5]
// 隔离 fixture；固定时间/消息；CPU 4×。测 500 行构建、常驻流满窗后翻旧日志与突发更新。
import assert from "node:assert/strict";
import fs from "node:fs";
import { withBench } from "./harness.mjs";

const [tree, out, count = "5"] = process.argv.slice(2);
const rows = [];
await withBench(tree, null, async ({ send, evaluate, waitFor, url, errors }) => {
  await send("Page.navigate", { url });
  assert.notEqual(await waitFor("document.body.dataset.health"), null, "application ready");
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  for (let run = 0; run < Number(count); run += 1) {
    rows.push(await evaluate(`(async () => {
      const { buildLogRowsHtml } = await import('/assets/js/logs-panel.js');
      const { createLogStream } = await import('/assets/js/render/log-stream.js');
      const base = 1792224000000;
      const entry = (i) => ({ ts: base + i * 1000, source: 'probe', level: 'info', message: 'bench line ' + i });
      const entries = Array.from({length: 500}, (_, i) => entry(i));
      buildLogRowsHtml(entries);
      const build = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        const html = buildLogRowsHtml(entries).rows.join('\\n');
        if (!html.includes('bench line 499')) throw new Error('missing lines');
        build.push(performance.now() - t0);
      }
      build.sort((a,b) => a-b);
      const box = document.createElement('div');
      box.className = 'log-stream';
      box.style.cssText = 'position:fixed;top:50px;left:80px;width:750px;height:320px;z-index:99999;background:var(--panel)';
      document.body.append(box);
      const stream = createLogStream({ streamEl: box, flushDelayMs: 0 });
      // 快照也用同一份确定性消息，避免 fixture 的真实当前时间与固定测试时间混用。
      const originalFetch = window.fetch;
      let newest = 79;
      window.fetch = (input, init) => {
        const target = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (target.pathname === '/api/logs' && target.searchParams.get('limit') === '50') {
          return Promise.resolve(new Response(JSON.stringify({ entries: Array.from({length: 50}, (_, i) => entry(newest - 49 + i)) }), { headers: {'content-type': 'application/json'} }));
        }
        return originalFetch(input, init);
      };
      const tick = () => new Promise(r => setTimeout(r, 30));
      const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (let i = 0; i < 80; i++) stream.append(entry(i));
      await tick(); await paint();
      box.scrollTop = (box.scrollHeight - box.clientHeight) * 0.4;
      await paint();
      const top = box.getBoundingClientRect().top;
      const anchor = [...box.querySelectorAll('.log-line')].find(el => el.getBoundingClientRect().bottom > top + 1);
      if (!anchor) throw new Error('no reading anchor');
      const anchorY = anchor.getBoundingClientRect().top;
      let drift = 0; let lost = 0; let maxNodes = box.children.length;
      const t0 = performance.now();
      // 300 新行足以穿过原 80 行窗口；阅读中不能淘汰正在看的行。
      for (let i = 80; i < 380; i += 10) {
        for (let n = i; n < i + 10; n++) stream.append(entry(n));
        newest = i + 9;
        await tick();
        maxNodes = Math.max(maxNodes, box.children.length);
        if (!anchor.isConnected) lost++;
        else drift = Math.max(drift, Math.abs(anchor.getBoundingClientRect().top - anchorY));
      }
      const streamMs = performance.now() - t0;
      await stream.refresh();
      const refreshPreserved = anchor.isConnected;
      // 回到底部后恢复有限 DOM，积压的新日志仍能看到。
      box.scrollTop = box.scrollHeight;
      box.dispatchEvent(new Event('scroll'));
      stream.append(entry(380));
      newest = 380;
      await tick(); await paint();
      const latest = box.lastElementChild?.textContent.includes('bench line 380');
      const endNodes = box.children.length;
      window.fetch = originalFetch;
      box.remove();
      return { build500Ms: build[7], maxDriftPx: drift, lostChecks: lost, maxNodes, endNodes, latest, refreshPreserved, streamMs };
    })()`));
  }
  assert.deepEqual(errors, [], "browser exceptions");
});
const median = (key) => rows.map(r => r[key]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const summary = Object.fromEntries(Object.keys(rows[0]).filter(k => typeof rows[0][k] === "number").map(k => [k, median(k)]));
fs.writeFileSync(out, `${JSON.stringify({ tree, runs: Number(count), throttle: 4, rows, summary }, null, 2)}\n`);
console.log(JSON.stringify(summary));
if (process.argv.includes("--verify")) {
  for (const row of rows) {
    assert.equal(row.lostChecks, 0, "正在读的旧行始终保留");
    assert.equal(row.maxDriftPx, 0, "阅读位置没有漂移");
    assert.equal(row.refreshPreserved, true, "重连不替换旧行");
    assert.equal(row.latest, true, "回到底部能看到最新行");
    assert.ok(row.maxNodes <= 80 && row.endNodes <= 80, "DOM 不增长");
  }
}
