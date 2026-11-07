// 热更新 B 接线测试（源码级）：Electron 主进程不便在 node:test 里真跑，这里锁住
// "重启界面不停数据面、不弹 W5 确认框、不被当成显式退出"等关键接线，防止回归。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 统一成 LF：Windows 检出若是 CRLF，下面按 "\n" 锚定的函数体正则会整体失配。
const read = (rel) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
// 主进程 = 入口 electron-main.mjs + work/monitor/desktop/*.mjs（拆分后各职责一个模块）。
// main 只含入口本身（生命周期接线在这里）；all 含全部主进程源码；函数按定义所在文件查找。
const DESKTOP_FILES = [
  "electron-main.mjs",
  ...readdirSync(path.join(root, "work/monitor/desktop"))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `work/monitor/desktop/${file}`),
];
const SOURCES = new Map(DESKTOP_FILES.map((rel) => [rel, read(rel)]));
const main = SOURCES.get("electron-main.mjs");
const all = [...SOURCES.values()].join("\n");
const fnBody = (name) => {
  const re = new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\1\\}`, "m");
  const hits = [...SOURCES.values()].map((src) => src.match(re)).filter(Boolean);
  assert.equal(hits.length, 1, `${name} 必须存在且只定义一次`);
  return hits[0][2];
};

test("restartControlPlane：保留数据面（preserveDataPlane）、不置 isQuitting/quitConfirmed，relaunch 后 exit", () => {
  const body = fnBody("restartControlPlane");
  // 决策经 currentRestartDecision()（内部调 decideControlPlaneRestart 并带上升级在飞标记）
  assert.match(body, /currentRestartDecision\(\)/);
  assert.match(fnBody("currentRestartDecision"), /decideControlPlaneRestart\(\{[\s\S]*dataPlaneUpgrading: dataPlaneUpgradeInFlight\(\)/);
  assert.match(body, /state\.controlPlaneRestarting = true/);
  assert.match(body, /cleanupBackground\(\{ preserveDataPlane: true(, monitorStopBudgetMs)? \}\)/);
  assert.doesNotMatch(body, /isQuitting\s*=/, "重启界面绝不能置 isQuitting（会停数据面）");
  assert.doesNotMatch(body, /quitConfirmed\s*=/);
  assert.doesNotMatch(body, /app\.quit\(\)/, "走 app.exit，不经 before-quit");
  const relaunchAt = body.indexOf("app.relaunch()");
  const exitAt = body.indexOf("app.exit(0)");
  assert.ok(relaunchAt > 0 && exitAt > relaunchAt, "先 app.relaunch() 再 app.exit(0)");
  assert.ok(body.indexOf("cleanupBackground") < relaunchAt, "先停 monitor-server 释放 8877 再 relaunch");
  assert.match(body, /win\.destroy\(\)/, "窗口用 destroy，避免 close 监听器改为隐藏");
  assert.match(body, /RELAUNCH_MARKER_ENV/);
});

test("cleanupBackground：preserveDataPlane 时即使 isQuitting 也不停 supervisor/proxy/tunnel", () => {
  const body = fnBody("cleanupBackground");
  const guard = body.indexOf("if (preserveDataPlane || !state.isQuitting)");
  assert.ok(guard > 0);
  assert.ok(guard < body.indexOf('"channel-supervisor"'), "数据面停止列表必须在保留判定之后");
});

test("before-quit：经 decideBeforeQuit，重启中 preventDefault 并直接返回", () => {
  assert.match(main, /app\.on\("before-quit", quit\.handleBeforeQuit\)/);
  const beforeQuit = fnBody("handleBeforeQuit");
  // 四个标志都经共享 state 现读（解构布尔值会拿到创建时的快照）。
  assert.match(beforeQuit, /decideBeforeQuit\(\{\s*controlPlaneRestarting: state\.controlPlaneRestarting,\s*cleanupStarted: state\.cleanupStarted,\s*quitConfirmed: state\.quitConfirmed,\s*quitPromptOpen: state\.quitPromptOpen,\s*\}\)/);
  const block = beforeQuit.slice(beforeQuit.indexOf('"block-restarting"'), beforeQuit.indexOf('"pass-through"'));
  assert.match(block, /event\.preventDefault\(\)/);
  assert.match(block, /return;/);
  assert.doesNotMatch(block, /isQuitting\s*=/);
  assert.ok(beforeQuit.indexOf('"block-restarting"') < beforeQuit.indexOf("showQuitConfirmDialog()"), "重启判定先于 W5 确认框");
  assert.match(fnBody("showQuitConfirmDialog"), /dialog\.showMessageBox/);
  // crash-watch.mjs（v2.64）另有一个弹框：界面进程反复退出后给「重新加载」，与退出无关，不计入。
  const withoutCrashPrompt = [...SOURCES].filter(([rel]) => rel !== "work/monitor/desktop/crash-watch.mjs").map(([, src]) => src).join("\n");
  assert.equal((withoutCrashPrompt.match(/dialog\.showMessageBox\(/g) || []).length, 2, "W5 确认框只在 showQuitConfirmDialog 里弹（有/无父窗口两种调用）");
  assert.doesNotMatch(SOURCES.get("work/monitor/desktop/crash-watch.mjs"), /isQuitting\s*=[^=]|quitConfirmed|app\.(quit|exit)\(|requestQuit/, "崩溃提示框不碰退出流程（只读 isQuitting）");
});

test("三个触发入口：SIGUSR2、渲染层 IPC（校验来源）、托盘菜单", () => {
  assert.match(main, /process\.on\("SIGUSR2", \(\) => \{[\s\S]*?restartControlPlane\("signal"\)/);
  const handler = all.match(/ipcMain\.handle\("restart-control-plane",[\s\S]*?\n\s*\}\);/);
  assert.ok(handler);
  assert.match(handler[0], /if \(!trusted\(event\)\) throw/);
  assert.match(fnBody("registerDesktopIpc"), /const trusted = \(event\) => isTrustedAppIpc\(event,/);
  assert.match(handler[0], /actions\.restartFromRenderer\(\)/);
  assert.match(fnBody("restartFromRenderer"), /restartControlPlane\("ipc"\)/);
  assert.match(all, /label: "重启界面（隧道不中断）", click: \(\) => actions\.restartControlPlane\("tray"\)/);
  assert.match(all, /buildUpdateMenuLabel\(state\.pendingBundleUpdate\)/);
  const preload = read("preload.js");
  assert.match(preload, /restartControlPlane: \(\) => ipcRenderer\.invoke\("restart-control-plane"\)/);
  assert.match(preload, /getBundleUpdate: \(\) => ipcRenderer\.invoke\("get-bundle-update"\)/);
});

test("重启期间：显式退出入口 / second-instance / 关机回调都不介入", () => {
  assert.match(fnBody("requestQuit"), /^\s+(?:\/\/.*\n\s+)*if \(state\.controlPlaneRestarting\) return;/);
  assert.match(fnBody("requestQuitWithConfirm"), /state\.controlPlaneRestarting/);
  assert.match(main, /app\.on\("second-instance", \(\) => \{\n\s+if \(state\.controlPlaneRestarting\) return;/);
  assert.match(main, /powerMonitor\.on\("shutdown", quit\.handlePowerShutdown\)/);
  assert.match(fnBody("handlePowerShutdown"), /^\s+if \(state\.controlPlaneRestarting\) return;/);
});

test("单实例锁：带重启标记的新实例重试拿锁；whenReady 在拿到锁前不初始化", () => {
  assert.match(main, /shouldRetrySingleInstanceLock\(\{ gotLock: false, marker: relaunchMarker/);
  assert.match(main, /delete process\.env\[RELAUNCH_MARKER_ENV\]/);
  const ready = main.slice(main.indexOf("app.whenReady().then(async () => {"));
  assert.ok(ready.indexOf("await singleInstanceReady") < ready.indexOf("monitor.startMonitorServer()"));
});

test("desktop-main 登记：command=process.execPath、无脚本参数；退出时只删自己的记录", () => {
  const body = fnBody("recordDesktopMain");
  // pid / execPath 是工厂参数（测试可注入），默认值必须是本进程的真实值。
  const controlPlane = SOURCES.get("work/monitor/desktop/control-plane.mjs");
  assert.match(controlPlane, /^\s+pid = process\.pid,$/m);
  assert.match(controlPlane, /^\s+execPath = process\.execPath,$/m);
  assert.match(controlPlane, /^\s+ppid = process\.ppid,$/m);
  assert.match(body, /registry\.recordProcess\(DESKTOP_MAIN_RECORD, pid,/);
  assert.match(body, /^\s+execPath,$/m);
  assert.match(body, /parentPid: ppid/);
  assert.match(fnBody("removeDesktopMainRecord"), /isOwnDesktopMainRecord\(registry\.readMeta\(DESKTOP_MAIN_RECORD\), pid\)/);
  assert.match(main, /process\.on\("exit", controlPlane\.removeDesktopMainRecord\)/);
  assert.match(fnBody("handleBeforeQuit"), /removeDesktopMainRecord\(\);\n\s+app\.exit\(0\)/);
});

test("更新检测：读 rootDir/build-info.json（只读），周期 unref，不写入 app bundle", () => {
  assert.match(all, /const bundleBuildInfoPath = path\.join\(rootDir, "build-info\.json"\)/);
  assert.match(fnBody("checkBundleUpdate"), /await readFile\(bundleBuildInfoPath/);
  assert.match(SOURCES.get("work/monitor/desktop/control-plane.mjs"), /readFile = fs\.promises\.readFile,/);
  assert.match(fnBody("startBundleUpdateWatch"), /bundleUpdateTimer\.unref/);
  // 主进程里任何写盘都不能以 rootDir / __dirname 为基（打包模式下那是已签名的 .app）
  for (const m of all.matchAll(/(writeFile|appendFile|mkdir|rename|copyFile|unlink|rm)(Sync)?\(([^)\n]*)/g)) {
    assert.doesNotMatch(m[3], /rootDir|__dirname|bundleBuildInfoPath|preloadPath|islandHtmlPath/, `疑似写入 app bundle: ${m[0]}`);
  }
});

test("前端：横幅容器 + modulepreload + app.js 接线", () => {
  const html = read("work/monitor/public/index.html");
  assert.match(html, /id="updateBanner" class="alert-banner update-banner"/);
  assert.match(html, /<link rel="modulepreload" href="\/assets\/js\/render\/update-banner\.js" \/>/);
  const app = read("work/monitor/public/app.js");
  assert.match(app, /initUpdateBanner\(\{/);
  const banner = read("work/monitor/public/assets/js/render/update-banner.js");
  assert.match(banner, /postJson\("\/api\/data-plane\/upgrade", \{ components: \[action\.component\] \}\)/);
  assert.match(banner, /err\?\.status === 404/);
});
