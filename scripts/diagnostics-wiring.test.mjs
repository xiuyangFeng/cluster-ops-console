// 工作台自身故障可见与诊断包（v2.64 W1）的跨模块接线。各模块自己的行为在各自目录的测试里，这里钉的是：
//   - 界面上导出前列出的内容与服务端诊断包的 summary 逐字一致；
//   - 页面脚本错误上报：主页面与悬浮岛都挂上、拿到令牌后才发；
//   - 起一个真实的 fixture 监控服务（临时端口、临时数据目录、假 ssh 排在 PATH 最前）：诊断包能导出、各块都在、
//     鉴权令牌不出现在包里；页面脚本错误写进临时运行目录的 logs/renderer.ndjson，重复的被挡下。全程不碰真实环境；
//   - 每份自身故障日志只有一个写入方（desktop / launcher / renderer 各归一个进程）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DIAGNOSTICS_CONTENTS, DIAGNOSTICS_PRIVACY_NOTE } from "../work/monitor/lib/diagnostics/bundle.mjs";
import { spawnFixtureMonitor } from "../work/monitor/lib/fixture-monitor.mjs";
import { DIAGNOSTICS_EXPORT_CONTENTS, DIAGNOSTICS_EXPORT_PRIVACY } from "../work/monitor/public/assets/js/app/diagnostics-export.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("导出前列出的内容与诊断包 summary 逐字一致", () => {
  assert.deepEqual([...DIAGNOSTICS_EXPORT_CONTENTS], [...DIAGNOSTICS_CONTENTS]);
  assert.equal(DIAGNOSTICS_EXPORT_PRIVACY, DIAGNOSTICS_PRIVACY_NOTE);
});

// logger 的轮转按本进程记的大小判断：两个进程追加同一份会超过 2 MB、互相盖掉 .1 分卷（agent.md 日志规范）。
test("每份自身故障日志只有一个写入方：desktop 归 Electron 主进程、launcher 归启动器、renderer 归监控服务", () => {
  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!["node_modules", "runtime"].includes(entry.name)) walk(rel, out);
      } else if (/\.(mjs|js)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) out.push(rel);
    }
    return out;
  };
  const sources = [...walk("work"), ...walk("scripts"), "electron-main.mjs"];
  const creators = (pattern) => sources.filter((rel) => pattern.test(read(rel))).sort();
  assert.deepEqual(creators(/createLogger\(\s*(?:DESKTOP_LOG_SOURCE|"desktop")/), ["electron-main.mjs"]);
  assert.deepEqual(creators(/createLogger\(\s*(?:LAUNCHER_LOG_SOURCE|"launcher")/), ["scripts/launch.mjs"]);
  assert.deepEqual(creators(/createLogger\(\s*(?:RENDERER_LOG_SOURCE|"renderer")/), ["work/monitor/lib/diagnostics/service.mjs"]);
});

test("页面脚本错误上报：主页面在启动最早处挂上、initSession 之后放行；悬浮岛拿到令牌后放行", () => {
  const app = read("work/monitor/public/app.js");
  const installAt = app.indexOf("errorReporter.install(window);");
  assert.ok(installAt > 0 && installAt < app.indexOf("initConsoleVisibility();"), "在任何控制器创建之前挂上");
  const sessionAt = app.indexOf("await initSession(");
  assert.ok(sessionAt > 0 && app.indexOf("errorReporter.markReady();", sessionAt) > sessionAt, "拿到令牌后才发");
  assert.match(app, /fetchApi\("\/api\/diagnostics\/client-error", \{ method: "POST"/);
  assert.match(app, /bootstrap\(\)\.finally\(\(\) => errorReporter\.markReady\(\)\);/);
  const island = read("work/monitor/public/island.js");
  assert.match(island, /createErrorReporter\(\{\s*page: "island"/);
  const tokenAt = island.indexOf("authToken = await window.electronAPI.getAuthToken();");
  assert.ok(tokenAt > 0 && island.indexOf("errorReporter.markReady();") > tokenAt);
  // 不往 CSP 里加例外：上报走同源（主页面）/ 已放行的 127.0.0.1:8877（悬浮岛）。
  assert.match(read("work/monitor/public/index.html"), /connect-src 'self'/);
  assert.match(read("work/monitor/public/island.html"), /connect-src http:\/\/127\.0\.0\.1:8877/);
});

test("诊断包入口并在「版本与更新」面板头，不新增卡片；桌面壳经 preload 的保存通道", () => {
  const html = read("work/monitor/public/index.html");
  const section = html.slice(html.indexOf('<article class="panel panel-settings-version">'), html.indexOf("</article>", html.indexOf('<article class="panel panel-settings-version">')));
  assert.match(section, /id="diagExportOpenBtn"/);
  assert.match(section, /id="diagExportPanel" hidden/);
  assert.equal((html.match(/id="diagExportOpenBtn"/g) || []).length, 1, "只有一个入口");
  assert.match(read("preload.js"), /saveDiagnosticsBundle: \(payload\) => ipcRenderer\.invoke\("save-diagnostics"/);
  assert.match(read("work/monitor/desktop/ipc.mjs"), /ipcMain\.handle\("save-diagnostics",[\s\S]*?actions\.saveDiagnosticsBundle\(payload\)/);
});

// ---- 真实的 fixture 监控服务（做法同 scripts/proxy-auth-wiring.test.mjs）----
const skipFixture = process.platform === "win32" ? "假 ssh 是 sh 脚本" : false;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function safePort() {
  for (let i = 0; i < 20; i += 1) {
    const port = await freePort();
    if (![8877, 8888, 1455].includes(port) && !(port >= 7890 && port <= 7899)) return port;
  }
  throw new Error("no usable free port");
}

test("fixture 监控：诊断包导出各块齐全、不含鉴权令牌；页面脚本错误写进临时运行目录的 renderer.ndjson，不碰 desktop.ndjson", { skip: skipFixture, timeout: 240_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-fixture-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
  const fakeBin = path.join(tmp, "bin");
  const sshLog = path.join(tmp, "fake-ssh.log");
  fs.mkdirSync(fakeBin);
  for (const name of ["ssh", "scp", "sftp"]) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${sshLog}"\nexit 255\n`, { mode: 0o755 });
  }
  const guardedPath = `${fakeBin}${path.delimiter}${process.env.PATH}`;
  const check = spawnSync("ssh", ["--diagnostics-selfcheck"], { env: { ...process.env, PATH: guardedPath }, encoding: "utf8" });
  if (check.status !== 255 || !fs.readFileSync(sshLog, "utf8").includes("ssh --diagnostics-selfcheck")) {
    t.skip("假 ssh 没有排在 PATH 最前面：不启动 fixture 监控");
    return;
  }
  fs.writeFileSync(sshLog, "");
  const port = await safePort();
  // 本机代理端口指向一个没人监听的随机端口（不是真实的 8888）。
  const deadProxyPort = await safePort();
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [{ id: "codex", name: "Codex", command: "codex", kind: "codex" }],
    servers: [{ id: "server-01", name: "fixture", host: "fixture-host.invalid", sshUser: "fixture-user", localPort: deadProxyPort, remotePort: 7999 }],
  }));
  const dataDir = path.join(tmp, "data");
  const authToken = randomBytes(16).toString("hex");
  const originalPath = process.env.PATH;
  let monitor;
  try {
    process.env.PATH = guardedPath;
    monitor = spawnFixtureMonitor({
      command: process.execPath,
      script: "work/monitor/monitor-server.mjs",
      cwd: ROOT,
      port,
      authToken,
      dataDir,
      configPath,
      localConfigPath: path.join(tmp, "config.local.json"),
    });
  } finally {
    process.env.PATH = originalPath;
  }
  t.after(() => monitor.stop());

  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-auth-token": authToken, "content-type": "application/json" };
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    assert.equal(monitor.child.exitCode, null, `监控服务提前退出: ${monitor.output().slice(-600)}`);
    try {
      ready = (await fetch(`${base}/api/status-lite`, { headers, signal: AbortSignal.timeout(2000) })).ok;
    } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `监控服务没有就绪: ${monitor.output().slice(-600)}`);

  // 没带令牌：读接口也拒绝。
  assert.equal((await fetch(`${base}/api/diagnostics/bundle`, { signal: AbortSignal.timeout(20_000) })).status, 401);

  const post = (body) => fetch(`${base}/api/diagnostics/client-error`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const report = { kind: "error", message: "TypeError: fixture boom", source: `${base}/app.js?token=${authToken}`, line: 7, column: 3, stack: `TypeError: fixture boom\n    at ${base}/app.js:7:3`, page: "main" };
  assert.equal((await post(report)).status, 202);
  assert.equal((await post(report)).status, 429, "同一条一分钟内重复：挡下");
  assert.equal((await post({ kind: "nope" })).status, 400);

  // 日志是异步批量落盘的（约 50 毫秒一批）：读到 desktop 那份之前多等几轮，只断言最终结果。
  let text = "";
  let parsed = null;
  for (let i = 0; i < 40; i += 1) {
    const res = await fetch(`${base}/api/diagnostics/bundle`, { headers, signal: AbortSignal.timeout(60_000) });
    assert.equal(res.status, 200);
    text = await res.text();
    parsed = JSON.parse(text);
    if (parsed.bundle.logs?.renderer) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const { filename, bundle, bytes } = parsed;
  assert.match(filename, /^cluster-workbench-diagnostics-\d{8}-\d{6}\.json$/);
  assert.ok(bytes > 0);
  for (const key of ["app", "platform", "runtime", "config", "status", "openIncidents", "logs", "tunnelLedger", "processes", "storage"]) {
    assert.ok(key in bundle, key);
  }
  assert.equal(bundle.app.fixtureMode, true);
  assert.equal(bundle.runtime.node, process.versions.node);
  assert.equal(bundle.config.servers.find((s) => s.id === "server-01")?.host, "fixture-host.invalid", "主机名保留");
  assert.equal(bundle.config.servers.find((s) => s.id === "server-01")?.sshUser, "fixture-user", "账号名保留");
  assert.ok(Array.isArray(bundle.logs.renderer?.entries), "页面脚本错误已在 renderer 日志里");
  assert.equal(bundle.logs.desktop, undefined, "监控服务不写 desktop 日志");
  const rendererRow = bundle.logs.renderer.entries.find((e) => e.event === "renderer-error");
  assert.equal(rendererRow.source, "renderer");
  assert.equal(rendererRow.script, `${base}/app.js`, "位置不带查询串");
  assert.equal(text.includes(authToken), false, "鉴权令牌不出现在诊断包里");

  await monitor.stop();
  const logsDir = path.join(dataDir, "runtime", "logs");
  const rendererLog = path.join(logsDir, "renderer.ndjson");
  const rows = fs.readFileSync(rendererLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => [r.source, r.event, r.kind]), [["renderer", "renderer-error", "error"]]);
  assert.equal(fs.statSync(rendererLog).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(rendererLog, "utf8").includes(authToken), false);
  assert.equal(fs.existsSync(path.join(logsDir, "desktop.ndjson")), false, "desktop.ndjson 只归 Electron 主进程");
  assert.equal(fs.existsSync(path.join(logsDir, "launcher.ndjson")), false, "launcher.ndjson 只归启动器");
  assert.equal(fs.readFileSync(sshLog, "utf8"), "", "整个过程没有任何 ssh / scp 调用");
});
