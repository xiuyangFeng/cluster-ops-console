// 冒烟夹具的静态接线检查：这些断言不需要 Electron，留在默认 npm test 里当廉价护栏。
// 真正拉起 Electron 的冒烟是 `npm run test:browser`（CI 的 browser-smoke job 显式运行）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronRunnerSource = fs.readFileSync(path.join(rootDir, "scripts/browser-smoke-electron.mjs"), "utf8");
// 实现在 work/monitor/lib/fixture-monitor.mjs（自更新的自检也用它），scripts/lib/fixture-monitor.mjs 只是转出口。
const fixtureMonitorSource = fs.readFileSync(path.join(rootDir, "work/monitor/lib/fixture-monitor.mjs"), "utf8");
// 主进程 = 入口 electron-main.mjs + work/monitor/desktop/*.mjs（窗口在 desktop/windows.mjs）。
const electronMainSource = [
  "electron-main.mjs",
  ...fs.readdirSync(path.join(rootDir, "work/monitor/desktop"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => `work/monitor/desktop/${file}`),
].map((rel) => fs.readFileSync(path.join(rootDir, rel), "utf8")).join("\n");
const indexHtml = fs.readFileSync(path.join(rootDir, "work/monitor/public/index.html"), "utf8");
const islandHtml = fs.readFileSync(path.join(rootDir, "work/monitor/public/island.html"), "utf8");

test("browser smoke points the real server at the isolated data directory", () => {
  assert.match(electronRunnerSource, /spawnFixtureMonitor\(\{/);
  assert.match(electronRunnerSource, /^\s+dataDir,$/m);
  assert.match(electronRunnerSource, /configPath:\s*path\.join\(dataDir, "config\.json"\)/);
  assert.match(electronRunnerSource, /localConfigPath:\s*path\.join\(dataDir, "config\.local\.json"\)/);
  // 路径经共享的 fixture 启动器落成 monitor-server 读取的覆盖变量。
  assert.match(fixtureMonitorSource, /CODEX_MONITOR_DATA_DIR:\s*dataDir/);
  assert.match(fixtureMonitorSource, /CODEX_MONITOR_LOCAL_CONFIG_PATH:\s*localConfigPath/);
  assert.match(fixtureMonitorSource, /env\.CODEX_MONITOR_CONFIG_PATH = configPath/);
  assert.doesNotMatch(fixtureMonitorSource, /CODEX_MONITOR_DATA_ROOT/);
});

test("production Electron windows enable sandbox and both pages declare CSP", () => {
  assert.equal((electronMainSource.match(/sandbox:\s*true/g) || []).length, 2);
  assert.equal((electronMainSource.match(/new BrowserWindow\(/g) || []).length, 2, "每个生产窗口都必须声明 sandbox");
  assert.doesNotMatch(electronMainSource, /sandbox:\s*false|nodeIntegration:\s*true|contextIsolation:\s*false/);
  assert.match(indexHtml, /Content-Security-Policy/);
  assert.match(islandHtml, /Content-Security-Policy/);
});

// 回归：spawn Electron 前必须清掉 ELECTRON_RUN_AS_NODE。该变量会让 Electron 二进制
// 退化成纯 Node，于是 electron 模块只导出路径字符串，冒烟测试以一个与真实原因无关的
// `does not provide an export named 'BrowserWindow'` 失败。此变量在本项目打包运行时里
// 是常态（electron-main.mjs 用它拉起受管子进程），从打包好的 app 终端启动开发即继承。
test("browser smoke scrubs ELECTRON_RUN_AS_NODE before spawning Electron", () => {
  const smokeSource = fs.readFileSync(path.join(rootDir, "scripts/browser-smoke.mjs"), "utf8");
  assert.match(smokeSource, /delete childEnv\.ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(smokeSource, /env:\s*process\.env,/);
});

// 回归：v2.42 给事件加了打开门槛后，夹具直接 observe 隧道事件拿到 null，入口模块加载期抛错；
// Electron 这时不退出，`npm run test:browser` 会一直挂着。夹具必须关掉门槛，启动器必须有兜底。
test("browser smoke fixture opens incidents without the pending gate, and the launcher cannot hang", () => {
  assert.match(electronRunnerSource, /createIncidentStore\(\{ openGate: \{\} \}\)/);
  const smokeSource = fs.readFileSync(path.join(rootDir, "scripts/browser-smoke.mjs"), "utf8");
  assert.match(smokeSource, /App threw an error during load/);
  assert.match(smokeSource, /SMOKE_TIMEOUT_MS/);
  assert.match(smokeSource, /child\.kill\("SIGKILL"\)/);
});
