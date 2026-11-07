// Electron 主进程接线（源码级）：主进程依赖 electron 运行时，不便在 node:test 里真跑，
// 这里锁住关键接线。原先散落在 vault-endpoint-file / upgrade-marker / hot-update-integration
// 的测试里，按「一个测试文件只断言自己归属的源码」收拢到这里。
// 主进程已拆成入口 electron-main.mjs + work/monitor/desktop/*.mjs：断言按"函数定义在哪个文件
// 就去哪个文件找"（且必须只定义一次），行为层面的覆盖在 work/monitor/desktop/*.test.mjs。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// 统一成 LF：Windows 检出若是 CRLF，下面按 "\n" 锚定的函数体正则会整体失配。
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const DESKTOP_FILES = [
  "electron-main.mjs",
  ...readdirSync(new URL("../work/monitor/desktop/", import.meta.url))
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `work/monitor/desktop/${file}`),
];
const SOURCES = new Map(DESKTOP_FILES.map((rel) => [rel, read(rel)]));
const ALL = [...SOURCES.values()].join("\n");
// 取函数体：允许任意缩进（工厂内的闭包函数），以同缩进的 "}" 收尾。
const fnBody = (name) => {
  const re = new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\([^)]*\\) \\{\\n([\\s\\S]*?)\\n\\1\\}`, "m");
  const hits = [...SOURCES.values()].map((src) => src.match(re)).filter(Boolean);
  assert.equal(hits.length, 1, `${name} 必须在主进程源码里恰好定义一次`);
  return hits[0][2];
};

test("Electron 启动写端点文件、仅显式退出删除", () => {
  assert.match(
    fnBody("startCredentialVault"),
    /writeEndpointFile\(\{ runtimeDir: runtimePaths\.runtimeDir, url: vaultHttp\.url, token: vaultToken \}\)/,
  );
  assert.match(read("work/monitor/desktop/vault.mjs"), /writeEndpointFile = writeVaultEndpointFile/);
  assert.match(fnBody("teardownCredentialVault"), /removeEndpointFile\(\{ runtimeDir: runtimePaths\.runtimeDir \}\)/);
  assert.match(read("work/monitor/desktop/vault.mjs"), /removeEndpointFile = removeVaultEndpointFile/);
  const cleanup = fnBody("cleanupBackground");
  const explicitAt = cleanup.indexOf("Explicit quit requested");
  const teardownAt = cleanup.indexOf("actions.teardownCredentialVault()");
  assert.ok(explicitAt > 0 && teardownAt > explicitAt, "端点文件只在显式退出路径删除（重启界面保留）");
  // 保管库拆除只有这一个调用点（其余出现只能是动作表登记/绑定）。
  const calls = ALL.match(/(?<!function )\bteardownCredentialVault\(\)/g) || [];
  assert.equal(calls.length, 1, "teardownCredentialVault 只能在 cleanupBackground 的显式退出段调用");
  assert.doesNotMatch(ALL.replace(read("work/monitor/desktop/vault.mjs"), ""), /removeVaultEndpointFile\(/);
});

test("electron-main：重启界面在升级中拒绝（信号重试 / 用户提示），并放宽 monitor-server 宽限", () => {
  assert.match(fnBody("currentRestartDecision"), /dataPlaneUpgrading: dataPlaneUpgradeInFlight\(\)/);
  const restart = fnBody("restartControlPlane");
  assert.match(restart, /handleUpgradeRefusal\(source\)/);
  assert.match(restart, /UPGRADE_GRACEFUL_STOP_MS/);
  assert.match(restart, /cleanupBackground\(\{ preserveDataPlane: true, monitorStopBudgetMs \}\)/);
  // 渲染层入口：IPC 只做来源校验后转给 restartFromRenderer，决策同样经 currentRestartDecision()。
  const ipc = ALL.slice(ALL.indexOf('ipcMain.handle("restart-control-plane"'), ALL.indexOf('ipcMain.handle("get-bundle-update"'));
  assert.match(ipc, /actions\.restartFromRenderer\(\)/);
  const fromRenderer = fnBody("restartFromRenderer");
  assert.match(fromRenderer, /currentRestartDecision\(\)/);
  assert.match(fromRenderer, /handleUpgradeRefusal\("ipc"\)/);
  assert.match(fnBody("cleanupBackground"), /registry\.stopProcess\("monitor-server", \{ forceAfterMs: monitorStopBudgetMs \}\)/);
});

test("显式退出的停止顺序包含 local-proxy-draining，且排在 local-proxy 之后", () => {
  const cleanup = fnBody("cleanupBackground");
  assert.match(cleanup, /stopOrder = \["channel-supervisor", "local-proxy", "local-proxy-draining"/);
  // 数组字面量只决定"同一段内的相对顺序"。真正保证 channel-supervisor 先停、其余可并发的
  // 是 partitionQuitStopTargets（其行为在 work/monitor/desktop-lifecycle.test.mjs 有单测）。
  // 这里补上接线断言：否则有人删掉分段逻辑后，本条仍会通过，而"先停父进程"的约束已经没了。
  assert.match(cleanup, /const \{ first, rest \} = partitionQuitStopTargets\(stopOrder\)/);
  assert.match(cleanup, /await Promise\.all\(first\.map\(stopOne\)\)/);
  assert.match(cleanup, /await Promise\.all\(rest\.map\(stopOne\)\)/);
  assert.ok(
    cleanup.indexOf("await Promise.all(first.map(stopOne))") < cleanup.indexOf("await Promise.all(rest.map(stopOne))"),
    "父进程段必须先于其余目标",
  );
});

test("拆分约束：desktop 模块不 import electron，入口不顶层 await whenReady", () => {
  for (const [rel, src] of SOURCES) {
    if (rel === "electron-main.mjs") continue;
    assert.doesNotMatch(src, /from\s+["']electron["']|require\(["']electron["']\)|import\(["']electron["']\)/, `${rel} 不得直接依赖 electron`);
  }
  const main = SOURCES.get("electron-main.mjs");
  const code = main.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /await app\.whenReady\(\)/, "入口不得顶层 await app.whenReady()（会死锁）");
  assert.match(code, /app\.whenReady\(\)\.then\(async \(\) => \{/);
  // IPC 必须在模块顶层注册（早于任何窗口加载页面），不能挪进 whenReady 回调。
  const ipcAt = code.indexOf("registerDesktopIpc({ ipcMain, ctx });");
  assert.ok(ipcAt > 0 && ipcAt < code.indexOf("app.whenReady().then("));
  // 所有跨模块动作都已绑定（bindDesktopActions 运行时也会校验一个不少、一个不多）。
  assert.match(main, /bindDesktopActions\(ctx, \{/);
});

// 入口依赖 electron 运行时、跑不起来：这里用假依赖构造全部 desktop 模块，按入口源码里的
// 接线逐条核对——bindDesktopActions 的每一项、入口里每个 `模块.方法` 调用都必须指向
// 工厂真实返回的函数。拆分后改名/漏导出时在这里就失败，而不是打包后点菜单才崩。
test("入口接线：动作表完整、入口调用的模块方法都存在", async () => {
  const { createDesktopContext, bindDesktopActions } = await import("../work/monitor/desktop/context.mjs");
  const { createCredentialVaultService } = await import("../work/monitor/desktop/vault.mjs");
  const { createMonitorProcess } = await import("../work/monitor/desktop/monitor-process.mjs");
  const { createWindowManager } = await import("../work/monitor/desktop/windows.mjs");
  const { createTrayController } = await import("../work/monitor/desktop/tray.mjs");
  const { createTrayGlance } = await import("../work/monitor/desktop/tray-glance.mjs");
  const { createQuitController } = await import("../work/monitor/desktop/quit.mjs");
  const { createControlPlane } = await import("../work/monitor/desktop/control-plane.mjs");
  const { createLoginItemController } = await import("../work/monitor/desktop/login-item.mjs");
  const { createCrashWatch } = await import("../work/monitor/desktop/crash-watch.mjs");
  const { createDiagnosticsSaver } = await import("../work/monitor/desktop/diagnostics-save.mjs");
  const { createExportFileSaver } = await import("../work/monitor/desktop/export-file.mjs");
  const main = SOURCES.get("electron-main.mjs");
  const ctx = createDesktopContext({ rootDir: "/nonexistent-app-root", env: {}, platform: "darwin", homeDir: "/nonexistent-home" });
  const registry = {};
  const modules = {
    vault: createCredentialVaultService({ ctx, safeStorage: {} }),
    monitor: createMonitorProcess({ ctx, registry }),
    windows: createWindowManager({ ctx, app: {}, BrowserWindow: class {}, dialog: {}, shell: {} }),
    tray: createTrayController({ ctx, Tray: class {}, Menu: {}, nativeImage: {}, Notification: class {}, readFileSync: () => "{}" }),
    trayGlance: createTrayGlance({ ctx, prefs: { load: () => ({}), update: () => ({}) } }),
    quit: createQuitController({ ctx, app: {}, dialog: {}, registry }),
    controlPlane: createControlPlane({ ctx, app: {}, registry, Notification: class {}, readFileSync: () => "{}" }),
    loginItem: createLoginItemController({ ctx, app: {} }),
    crashWatch: createCrashWatch({ ctx, dialog: {}, logger: {} }),
    diagnosticsSaver: createDiagnosticsSaver({ ctx, app: {}, dialog: {} }),
    exportFile: createExportFileSaver({ ctx, dialog: {} }),
  };
  // 入口里的构造语句与上面一一对应（变量名 → 工厂）
  for (const [name, factory] of Object.entries({
    vault: "createCredentialVaultService",
    monitor: "createMonitorProcess",
    windows: "createWindowManager",
    tray: "createTrayController",
    trayGlance: "createTrayGlance",
    quit: "createQuitController",
    controlPlane: "createControlPlane",
    loginItem: "createLoginItemController",
    crashWatch: "createCrashWatch",
    diagnosticsSaver: "createDiagnosticsSaver",
    exportFile: "createExportFileSaver",
  })) {
    assert.match(main, new RegExp(`const ${name} = ${factory}\\(\\{ ctx,`), `${name} 必须由 ${factory} 构造`);
  }
  const bindAt = main.indexOf("bindDesktopActions(ctx, {");
  const bindBlock = main.slice(bindAt, main.indexOf("});", bindAt));
  const impls = {};
  for (const m of bindBlock.matchAll(/^\s+(\w+): (\w+)\.(\w+),$/gm)) {
    const [, action, moduleName, method] = m;
    assert.equal(typeof modules[moduleName]?.[method], "function", `${action} → ${moduleName}.${method} 不存在`);
    impls[action] = modules[moduleName][method];
  }
  bindDesktopActions(ctx, impls); // 一个不少、一个不多
  const code = main.replace(/^\s*\/\/.*$/gm, "");
  // (?<![\w/-])：排除 import 路径里的 "./desktop/quit.mjs" 之类。
  for (const m of code.matchAll(/(?<![\w/-])(vault|monitor|windows|tray|trayGlance|quit|controlPlane|loginItem|crashWatch|diagnosticsSaver|exportFile)\.(\w+)/g)) {
    assert.equal(typeof modules[m[1]][m[2]], "function", `入口调用的 ${m[0]} 不存在`);
  }
});

// v2.64：自身故障日志与进程兜底要最先接上——之后任何一步（setName、单实例锁、各模块构造）抛出的未捕获异常
// 都得落进 desktop.ndjson；界面进程与子进程的监听、启动失败与「停止自动重启」也记在这份（本进程是它唯一的写入方）。
test("electron-main：故障日志与进程兜底先于一切；窗口 / 监控服务 / 保存诊断包的接线", () => {
  const code = SOURCES.get("electron-main.mjs").replace(/^\s*\/\/.*$/gm, "");
  const guardsAt = code.indexOf("crashWatch.registerProcessGuards();");
  assert.ok(guardsAt > 0, "注册了主进程兜底");
  for (const later of ["app.setName(", "app.requestSingleInstanceLock()", "createCredentialVaultService(", "registerDesktopIpc("]) {
    assert.ok(guardsAt < code.indexOf(later), `进程兜底要早于 ${later}`);
  }
  assert.match(code, /createLogger\(DESKTOP_LOG_SOURCE, \{ dir: ctx\.runtimePaths\.logsDir \}\)/);
  assert.doesNotMatch(code, /LAUNCHER_LOG_SOURCE|RENDERER_LOG_SOURCE/, "launcher / renderer 两份日志不归主进程写");
  assert.equal((code.match(/createLogger\(/g) || []).length, 1, "主进程只建一个日志器");
  assert.match(code, /crashWatch\.watchApp\(app\);/);
  assert.match(code, /createCrashWatch\(\{ ctx, app, dialog, logger: desktopLog \}\)/, "启动期错误框要知道 app 是否 ready");
  assert.match(code, /createMonitorProcess\(\{ ctx, registry, eventLog: desktopLog \}\)/);
  assert.match(code, /watchWindow: crashWatch\.watchWindow,/);
  assert.match(code, /onStartupFailed: \(info\) => desktopLog\.error\(/);
  assert.match(code, /saveDiagnosticsBundle: diagnosticsSaver\.saveDiagnosticsBundle,/);
});
