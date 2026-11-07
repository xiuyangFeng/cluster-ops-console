import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  APP_DISPLAY_NAME,
  bindDesktopActions,
  buildDesktopPathEnv as buildPathEnvFor,
  createDesktopContext,
  DESKTOP_ACTION_NAMES,
  MONITOR_PORT,
  stripDesktopPathEnv as stripPathEnvFor,
} from "./context.mjs";

// 前缀只在 macOS 上加；下面的 PATH 用例都按 macOS 跑（CI 的 Windows 宿主上默认平台是 win32）。
const buildDesktopPathEnv = (value) => buildPathEnvFor(value, "darwin");
const stripDesktopPathEnv = (value) => stripPathEnvFor(value, "darwin");

const ROOT = path.resolve("/tmp/app-root");

function makeCtx(env = {}) {
  return createDesktopContext({ rootDir: ROOT, env, platform: "darwin", homeDir: "/Users/tester" });
}

test("createDesktopContext：常量、路径与随机 token", () => {
  const ctx = makeCtx();
  assert.equal(ctx.rootDir, ROOT);
  assert.equal(ctx.appDisplayName, APP_DISPLAY_NAME);
  assert.equal(ctx.monitorPort, MONITOR_PORT);
  assert.equal(ctx.monitorBaseUrl, "http://127.0.0.1:8877");
  assert.equal(ctx.statusLiteUrl, "http://127.0.0.1:8877/api/status-lite");
  assert.equal(ctx.preloadPath, path.join(ROOT, "preload.js"));
  assert.equal(ctx.islandHtmlPath, path.join(ROOT, "work/monitor/public/island.html"));
  assert.match(ctx.authToken, /^[0-9a-f]{32}$/);
  assert.match(ctx.vaultToken, /^[0-9a-f]{64}$/);
  // 源码模式：数据根是应用根下的 work/
  assert.equal(ctx.runtimePaths.dataRoot, path.join(ROOT, "work"));
  assert.equal(ctx.runtimePaths.runtimeDir, path.join(ROOT, "work", "runtime"));
  // 数据根经 path.resolve：Windows 上 "/data" 会补成当前盘符下的绝对路径。
  assert.equal(makeCtx({ CODEX_MONITOR_DATA_DIR: "/data" }).runtimePaths.runtimeDir, path.join(path.resolve("/data"), "runtime"));
  assert.equal(ctx.windowIconPath, null, "macOS 用 .app 自己的图标");
});

test("createDesktopContext：Windows 安装版的窗口图标在应用根的上一级", () => {
  const ctx = createDesktopContext({ rootDir: ROOT, env: {}, platform: "win32", homeDir: "/Users/tester" });
  assert.equal(ctx.windowIconPath, path.join(ROOT, "..", "app-icon.ico"));
});

test("createDesktopContext：共享状态初始值，且每个上下文互相独立", () => {
  const a = makeCtx();
  const b = makeCtx();
  for (const flag of ["isQuitting", "quitConfirmed", "quitPromptOpen", "cleanupStarted", "controlPlaneRestarting", "startupComplete", "serverExiting"]) {
    assert.equal(a.state[flag], false, flag);
  }
  for (const handle of ["serverProcess", "serverRestartTimer", "mainWindow", "islandWindow", "tray", "statusInterval", "pendingBundleUpdate"]) {
    assert.equal(a.state[handle], null, handle);
  }
  assert.equal(a.state.pendingRestartReason, "");
  a.state.isQuitting = true;
  assert.equal(b.state.isQuitting, false);
  assert.notEqual(a.authToken, b.authToken);
});

test("动作表：未绑定就调用立刻抛错（带动作名），而不是静默 undefined", () => {
  const ctx = makeCtx();
  assert.deepEqual(Object.keys(ctx.actions).sort(), [...DESKTOP_ACTION_NAMES].sort());
  assert.throws(() => ctx.actions.requestQuit(), /desktop action "requestQuit" 尚未绑定/);
});

test("bindDesktopActions：一个不少、一个不多，绑定后按名调用", () => {
  const ctx = makeCtx();
  const impls = Object.fromEntries(DESKTOP_ACTION_NAMES.map((name) => [name, () => name]));
  assert.throws(() => bindDesktopActions(ctx, { ...impls, bogus: () => {} }), /未登记的 desktop action：bogus/);
  const { requestQuit: _omitted, ...missingOne } = impls;
  assert.throws(() => bindDesktopActions(ctx, missingOne), /缺少实现：requestQuit/);
  // 校验失败时不能留下半绑定的动作表
  assert.throws(() => ctx.actions.createMainWindow(), /尚未绑定/);
  const actions = bindDesktopActions(ctx, impls);
  assert.equal(actions, ctx.actions, "绑定的是同一个对象：模块构造时拿到的引用随之生效");
  assert.equal(ctx.actions.restartControlPlane(), "restartControlPlane");
});

test("buildDesktopPathEnv：常见前缀在前，原 PATH 保留在末尾", () => {
  assert.equal(buildDesktopPathEnv("/custom/bin"), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/custom/bin");
  assert.equal(buildDesktopPathEnv(undefined), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:");
});

test("stripDesktopPathEnv：取回加前缀之前的 PATH——重启界面叠了几段就剥几段，顺序一个字都不变", () => {
  const PREFIX = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const nvm = "/Users/t/.nvm/versions/node/v24.11.0/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  // 还没加过前缀（启动器直接起的第一份、或 electron . 起的）：原样。
  assert.equal(stripDesktopPathEnv(nvm), nvm);
  // 加过一次、以及「重启界面」之后又叠了几次：都取回原来那一份。
  let stacked = nvm;
  for (let i = 0; i < 4; i += 1) {
    stacked = buildDesktopPathEnv(stacked);
    assert.equal(stripDesktopPathEnv(stacked), nvm, `叠了 ${i + 1} 段`);
  }
  // 打包的 App 从 Finder 起来时的短 PATH。
  assert.equal(stripDesktopPathEnv("/usr/bin:/bin:/usr/sbin:/sbin"), "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv("/usr/bin:/bin:/usr/sbin:/sbin")), "/usr/bin:/bin:/usr/sbin:/sbin");
  // 用户自己的 PATH 恰好就是这一段、或以这一段开头：不能把它自己的也剥掉。
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv(PREFIX)), PREFIX);
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv(buildDesktopPathEnv(PREFIX))), PREFIX);
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv(`${PREFIX}:/Users/t/bin`)), `${PREFIX}:/Users/t/bin`);
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv(buildDesktopPathEnv(`${PREFIX}:/Users/t/bin`))), `${PREFIX}:/Users/t/bin`);
  // 空的、缺的：给回带系统目录的一段，不返回空串。
  assert.equal(stripDesktopPathEnv(buildDesktopPathEnv("")), `${PREFIX}:`);
  assert.equal(stripDesktopPathEnv(undefined), `${PREFIX}:`);
});

test("Windows：PATH 原样进出（分隔符是 ;，不加 Unix 前缀）", () => {
  const winPath = "C:\\Windows\\system32;C:\\Windows\\System32\\OpenSSH\\";
  assert.equal(buildPathEnvFor(winPath, "win32"), winPath);
  assert.equal(stripPathEnvFor(winPath, "win32"), winPath);
});
