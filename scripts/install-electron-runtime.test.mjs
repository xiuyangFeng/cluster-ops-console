import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { electronBinaryPath, shouldInstallElectronRuntime, electronInstallEnv, installElectronRuntime } from "./install-electron-runtime.mjs";

test("Electron runtime installer only downloads a missing macOS binary", () => {
  assert.equal(shouldInstallElectronRuntime({ platform: "darwin", binaryExists: false }), true);
  assert.equal(shouldInstallElectronRuntime({ platform: "darwin", binaryExists: true }), false);
  assert.equal(shouldInstallElectronRuntime({ platform: "linux", binaryExists: false }), false);
  assert.equal(shouldInstallElectronRuntime({ platform: "win32", binaryExists: false }), false);
});

// electronBinaryPath 用 path.join 拼接，分隔符随宿主平台走；断言同样经 path.join 构造，
// 免得在 Windows 上把反斜杠当成失败。
test("electronBinaryPath resolves platform-specific runtime executables", () => {
  const dist = (...segments) => path.join("/app", "node_modules", "electron", "dist", ...segments);
  assert.equal(electronBinaryPath("/app", "darwin"), dist("Electron.app", "Contents", "MacOS", "Electron"));
  assert.equal(electronBinaryPath("/app", "linux"), dist("electron"));
  assert.match(electronBinaryPath("/app", "win32"), /electron\.exe$/);
});

test("electronInstallEnv 清掉 skip 开关，真正安装 macOS 二进制", () => {
  const env = electronInstallEnv({
    PATH: "/usr/bin",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    npm_config_electron_skip_binary_download: "true",
  });
  assert.equal("ELECTRON_SKIP_BINARY_DOWNLOAD" in env, false);
  assert.equal("npm_config_electron_skip_binary_download" in env, false);
  assert.equal(env.PATH, "/usr/bin");
});

test("installElectronRuntime 失败不得让 npm install 失败", () => {
  const result = installElectronRuntime({
    projectRoot: "/app",
    platform: "darwin",
    exists: (p) => p.endsWith("install.js"),
    spawn: () => ({ status: 1 }),
    error: () => {},
    log: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.failed, true);
});
