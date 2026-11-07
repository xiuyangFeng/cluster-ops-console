import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";

import { installWindowsHide, shouldHideChildWindows, withWindowsHide } from "./windows-hide-children.mjs";

const HIDE = { windowsHide: true };

test("只在 Windows 的 Electron 里生效：网页模式（node.exe）与 macOS 不动", () => {
  assert.equal(shouldHideChildWindows({ platform: "win32", versions: { electron: "44.4.5" } }), true);
  assert.equal(shouldHideChildWindows({ platform: "win32", versions: { node: "24.21.0" } }), false);
  assert.equal(shouldHideChildWindows({ platform: "darwin", versions: { electron: "44.4.5" } }), false);
});

test("spawn / execFile 一族：各种参数形态都补上 windowsHide，选项与回调位置不乱", () => {
  const cb = () => {};
  const argv = { argvSlot: true };
  assert.deepEqual(withWindowsHide(["ssh"], argv), ["ssh", HIDE]);
  assert.deepEqual(withWindowsHide(["ssh", ["-V"]], argv), ["ssh", ["-V"], HIDE]);
  assert.deepEqual(withWindowsHide(["ssh", ["-V"], { cwd: "/" }], argv), ["ssh", ["-V"], { cwd: "/", windowsHide: true }]);
  assert.deepEqual(withWindowsHide(["ssh", { cwd: "/" }], argv), ["ssh", { cwd: "/", windowsHide: true }]);
  assert.deepEqual(withWindowsHide(["ssh", ["-V"], cb], argv), ["ssh", ["-V"], HIDE, cb]);
  assert.deepEqual(withWindowsHide(["ssh", cb], argv), ["ssh", HIDE, cb]);
  assert.deepEqual(withWindowsHide(["ssh", null, null, cb], argv), ["ssh", null, HIDE, cb]);
  assert.deepEqual(withWindowsHide(["ssh", undefined, { env: {} }], argv), ["ssh", undefined, { env: {}, windowsHide: true }]);
});

test("exec 一族：第二个参数就是选项", () => {
  const cb = () => {};
  assert.deepEqual(withWindowsHide(["dir"], { argvSlot: false }), ["dir", HIDE]);
  assert.deepEqual(withWindowsHide(["dir", cb], { argvSlot: false }), ["dir", HIDE, cb]);
  assert.deepEqual(withWindowsHide(["dir", { cwd: "C:\\" }, cb], { argvSlot: false }), ["dir", { cwd: "C:\\", windowsHide: true }, cb]);
});

test("调用方明确写了 windowsHide（含 false）就原样尊重，也不改调用方的对象", () => {
  const opts = { windowsHide: false };
  assert.equal(withWindowsHide(["x", [], opts], { argvSlot: true })[2], opts);
  const mine = { cwd: "/" };
  withWindowsHide(["x", [], mine], { argvSlot: true });
  assert.deepEqual(mine, { cwd: "/" });
});

test("installWindowsHide：包住各方法，只装一次，promisify(execFile) 仍 resolve 成 { stdout, stderr }", async () => {
  const seen = [];
  const execFile = (...args) => seen.push(["execFile", ...args]);
  execFile[promisify.custom] = async (...args) => {
    seen.push(["execFile.custom", ...args]);
    return { stdout: "out", stderr: "err" };
  };
  const cp = { spawn: (...args) => seen.push(["spawn", ...args]), execFile, exec: (...args) => seen.push(["exec", ...args]) };
  assert.equal(installWindowsHide(cp), true);
  assert.equal(installWindowsHide(cp), false, "第二次不再包一层");

  cp.spawn("ssh", ["host"]);
  cp.exec("dir");
  assert.deepEqual(seen[0], ["spawn", "ssh", ["host"], HIDE]);
  assert.deepEqual(seen[1], ["exec", "dir", HIDE]);

  const result = await promisify(cp.execFile)("powershell", ["-NoProfile"]);
  assert.deepEqual(result, { stdout: "out", stderr: "err" });
  assert.deepEqual(seen[2], ["execFile.custom", "powershell", ["-NoProfile"], HIDE]);
});
