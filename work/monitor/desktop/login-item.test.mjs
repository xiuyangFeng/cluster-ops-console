// 登录项控制器：app 是假对象，真实的系统登录项一次都不碰。
import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopContext } from "./context.mjs";
import { createLoginItemController } from "./login-item.mjs";

const PACKAGED_ROOT = "/Applications/Codex Operations Console.app/Contents/Resources/app";
const SOURCE_ROOT = "/Users/t/cluster-workbench";
const quiet = { warn: () => {} };
// 在 Windows 主机上模拟不了 macOS 的 .app 布局：createDesktopContext 会 path.resolve 根目录，把
// /Applications/….app/Contents/Resources/app 改写成带盘符、反斜杠的路径，打包判定就认不出来了。
// 真实的 macOS 打包版只会跑在 macOS 上，这几条在 Windows 主机上跳过。
const macLayout = process.platform === "win32" ? "Windows 主机上 path.resolve 会改写 macOS 路径，模拟不了 .app 布局" : false;

function fakeApp({ openAtLogin = false, status = "not-registered", accept = true } = {}) {
  const state = { openAtLogin, status };
  const calls = [];
  return {
    calls,
    getLoginItemSettings() {
      calls.push(["get"]);
      return { openAtLogin: state.openAtLogin, openAsHidden: false, status: state.status };
    },
    setLoginItemSettings(settings) {
      calls.push(["set", settings]);
      if (!accept) return; // 系统不接受：不抛错，状态也不变
      state.openAtLogin = settings.openAtLogin;
      state.status = settings.openAtLogin ? "enabled" : "not-registered";
    },
  };
}

function make(rootDir, app, platform = "darwin") {
  const ctx = createDesktopContext({ rootDir, env: {}, platform, homeDir: "/Users/t" });
  return createLoginItemController({ ctx, app, platform, logger: quiet });
}

test("打包的 .app：读出登录项现状；开 / 关之后回读系统里的结果", { skip: macLayout }, () => {
  const app = fakeApp();
  const loginItem = make(PACKAGED_ROOT, app);
  assert.deepEqual(loginItem.getAutostart(), { supported: true, enabled: false, status: "not-registered", error: null });
  assert.deepEqual(loginItem.setAutostart(true), { supported: true, enabled: true, status: "enabled", error: null });
  assert.deepEqual(loginItem.setAutostart(false), { supported: true, enabled: false, status: "not-registered", error: null });
  assert.deepEqual(app.calls, [["get"], ["set", { openAtLogin: true }], ["get"], ["set", { openAtLogin: false }], ["get"]]);
  // 只收布尔 true：别的值一律当成关。
  make(PACKAGED_ROOT, app).setAutostart("yes");
  assert.deepEqual(app.calls.at(-2), ["set", { openAtLogin: false }]);
});

test("打包的 .app：系统没有接受（不抛错）→ 回读到的仍是没开；等用户批准时带出 requires-approval", { skip: macLayout }, () => {
  const rejected = make(PACKAGED_ROOT, fakeApp({ accept: false }));
  assert.deepEqual(rejected.setAutostart(true), { supported: true, enabled: false, status: "not-registered", error: null });
  const pending = make(PACKAGED_ROOT, fakeApp({ accept: false, status: "requires-approval" }));
  assert.deepEqual(pending.setAutostart(true), { supported: true, enabled: false, status: "requires-approval", error: null });
});

test("打包的 .app：登录项接口抛错时不把主进程带崩，原因放进 error", { skip: macLayout }, () => {
  const throwing = {
    getLoginItemSettings: () => { throw new Error("SMAppService unavailable"); },
    setLoginItemSettings: () => { throw new Error("Operation not permitted"); },
  };
  const loginItem = make(PACKAGED_ROOT, throwing);
  assert.deepEqual(loginItem.getAutostart(), { supported: true, enabled: false, status: null, error: "SMAppService unavailable" });
  assert.deepEqual(loginItem.setAutostart(true), { supported: true, enabled: false, status: null, error: "Operation not permitted" });
  // 老系统没有 status 字段、返回空对象也不出错。
  const bare = make(PACKAGED_ROOT, { getLoginItemSettings: () => undefined, setLoginItemSettings: () => {} });
  assert.deepEqual(bare.getAutostart(), { supported: true, enabled: false, status: null, error: null });
});

test("源码安装的桌面壳（electron .）与非 macOS：不支持，且绝不调用登录项接口", () => {
  const forbidden = {
    getLoginItemSettings: () => assert.fail("不该读登录项"),
    setLoginItemSettings: () => assert.fail("不该写登录项：登记的会是通用的 Electron"),
  };
  for (const loginItem of [make(SOURCE_ROOT, forbidden), make(PACKAGED_ROOT, forbidden, "linux")]) {
    assert.deepEqual(loginItem.getAutostart(), { supported: false, enabled: false, status: null, error: null });
    assert.deepEqual(loginItem.setAutostart(true), { supported: false, enabled: false, status: null, error: null });
  }
});
