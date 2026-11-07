// UI 性能基准的共用底座：隔离的 fixture 监控服务 + 假 ssh + 无头 Chrome（CDP，Node 自带 WebSocket）。
// 绝不碰现役环境：临时端口（避开 8877/8888/789x）、临时数据目录（dataSrc 只读拷贝）、PATH 最前面放只记录不连接的假 ssh，
// 启动前自检 ssh 确实解析到假的。fn({ send, evaluate, waitFor, url, port, token, metrics, sleep, on }) 里驱动页面。
import { spawn, execFileSync } from "node:child_process"; import { randomBytes } from "node:crypto"; import fs from "node:fs"; import net from "node:net"; import os from "node:os"; import path from "node:path"; import { pathToFileURL } from "node:url";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const srv = net.createServer(); srv.once("error", reject); srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });
const LIVE = [8877, 8888, 7891, 7892, 7893, 7894];
export async function withBench(tree, dataSrc, fn, { width = 1028, height = 800, setupData, teamConfig } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-probe-")); const fakeBin = path.join(tmp, "bin"); fs.mkdirSync(fakeBin);
  for (const b of ["ssh", "scp"]) fs.writeFileSync(path.join(fakeBin, b), `#!/bin/sh\necho "$@" >> "${tmp}/ssh-calls.log"\nexit 255\n`, { mode: 0o755 });
  process.env.PATH = `${fakeBin}:${process.env.PATH}`;
  if (execFileSync("/bin/sh", ["-c", "command -v ssh"]).toString().trim() !== path.join(fakeBin, "ssh")) throw new Error("fake ssh not first");
  const dataDir = path.join(tmp, "data");
  if (dataSrc) fs.cpSync(dataSrc, dataDir, { recursive: true }); else fs.mkdirSync(dataDir);
  setupData?.(dataDir);
  const { spawnFixtureMonitor } = await import(pathToFileURL(path.join(tree, "work/monitor/lib/fixture-monitor.mjs")).href);
  let port, dbgPort; do { port = await freePort(); dbgPort = await freePort(); } while (LIVE.includes(port) || LIVE.includes(dbgPort));
  const token = randomBytes(16).toString("hex");
  // teamConfig：给定时写一份临时团队配置（服务器用解析不了的示例主机），不读仓库里的真实 config.json
  let configPath;
  if (teamConfig) { configPath = path.join(tmp, "team-config.json"); fs.writeFileSync(configPath, JSON.stringify(teamConfig)); }
  const monitor = spawnFixtureMonitor({ command: process.execPath, script: "work/monitor/monitor-server.mjs", cwd: tree, port, authToken: token, dataDir, configPath, localConfigPath: path.join(dataDir, "config.local.json") });
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${path.join(tmp, "chrome")}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let ws; const ctx = { port, token, url: `http://127.0.0.1:${port}/`, sleep, errors: [] };
  try {
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/session`)).ok) break; } catch {} if (monitor.child.exitCode != null) throw new Error(monitor.output().slice(-800)); await sleep(50); }
    let targets; for (let i = 0; i < 100; i++) { try { targets = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json(); if (targets.some((t) => t.type === "page")) break; } catch {} await sleep(150); }
    ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pending = new Map(); const listeners = new Set();
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); return; }
      if (m.method === "Runtime.exceptionThrown") ctx.errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 300)); for (const l of listeners) l(m); };
    ctx.on = (f) => listeners.add(f);
    ctx.send = (method, params = {}) => new Promise((resolve, reject) => { id += 1; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
    ctx.evaluate = async (expression) => { const r = await ctx.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    ctx.waitFor = async (expr, timeoutMs = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeoutMs) { try { if (await ctx.evaluate(`Boolean(${expr})`)) return Date.now() - t0; } catch {} await sleep(20); } return null; };
    ctx.metrics = async () => Object.fromEntries((await ctx.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    await ctx.send("Page.enable"); await ctx.send("Runtime.enable"); await ctx.send("Performance.enable");
    await ctx.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
    await ctx.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { const css = localStorage.getItem('benchCss'); if (css) { const st = document.createElement('style'); st.textContent = css; (document.head || document.documentElement).append(st); document.addEventListener('DOMContentLoaded', () => document.head.append(st)); } } catch {}` });
    await ctx.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__bench = { longtasks: [], shifts: [] };
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__bench.longtasks.push({ t: e.startTime, d: e.duration }); }).observe({ type: "longtask", buffered: true }); } catch {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__bench.shifts.push({ t: Math.round(e.startTime), v: +e.value.toFixed(4), srcs: (e.sources||[]).map(s => { const n = s.node; if (!n) return '?'; const el = n.nodeType === 1 ? n : n.parentElement; return (el?.id ? '#' + el.id : '') + (el?.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '') + ' ' + JSON.stringify([s.previousRect.y, s.currentRect.y, s.previousRect.height, s.currentRect.height]); }) }); }).observe({ type: "layout-shift", buffered: true }); } catch {}` });
    return await fn(ctx);
  } finally {
    try { ws?.close(); } catch {} try { chrome.kill("SIGKILL"); } catch {} await monitor.stop(); await sleep(300);
    const log = path.join(tmp, "ssh-calls.log"); ctx.sshCalls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    if (ctx.sshCalls) console.error(`WARNING: ${ctx.sshCalls} fake ssh calls`);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
