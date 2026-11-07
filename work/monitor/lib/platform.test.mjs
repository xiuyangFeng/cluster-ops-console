import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { archLabel, detectGui, decideLaunchMode, whichCommand, sshMissingHint, isNodeVersionSupported, parseNodeVersion, nodeVersionHint, parseNodeEngineRange, nodeRangeText } from "./platform.mjs";

test("archLabel maps node arch to linux uname strings", () => {
  assert.equal(archLabel("x64"), "x86_64");
  assert.equal(archLabel("arm64"), "aarch64");
  assert.equal(archLabel("ppc64"), "ppc64"); // 未知原样返回
});

test("detectGui: darwin always true, linux depends on DISPLAY", () => {
  assert.equal(detectGui({ platform: "darwin", env: {} }), true);
  assert.equal(detectGui({ platform: "linux", env: {} }), false);
  assert.equal(detectGui({ platform: "linux", env: { DISPLAY: ":0" } }), true);
  assert.equal(detectGui({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }), true);
  assert.equal(detectGui({ platform: "win32", env: {} }), false);
});

test("decideLaunchMode: electron only on macOS GUI with electron present", () => {
  assert.equal(decideLaunchMode({ platform: "darwin", hasGui: true, electronAvailable: true }), "electron");
  assert.equal(decideLaunchMode({ platform: "darwin", hasGui: true, electronAvailable: false }), "web");
  assert.equal(decideLaunchMode({ platform: "darwin", hasGui: false, electronAvailable: true }), "web");
  assert.equal(decideLaunchMode({ platform: "linux", hasGui: true, electronAvailable: true }), "web");
  assert.equal(decideLaunchMode({ platform: "win32", hasGui: true, electronAvailable: true }), "web");
});

test("whichCommand: win32 where else which", () => {
  assert.equal(whichCommand("win32"), "where");
  assert.equal(whichCommand("linux"), "which");
  assert.equal(whichCommand("darwin"), "which");
});

test("sshMissingHint: win32 mentions OpenSSH", () => {
  assert.match(sshMissingHint("win32"), /OpenSSH/);
  assert.ok(sshMissingHint("linux").length > 0);
});

test("isNodeVersionSupported 对齐 engines.node >=22.12 <27", () => {
  assert.equal(isNodeVersionSupported("v22.12.0"), true);
  assert.equal(isNodeVersionSupported("v24.4.1"), true);
  assert.equal(isNodeVersionSupported("v22.11.9"), false);
  assert.equal(isNodeVersionSupported("v21.7.3"), false);
  assert.equal(isNodeVersionSupported("v26.11.0"), true, "Homebrew 当前的 node 就是 26.x");
  assert.equal(isNodeVersionSupported("v27.0.0"), false);
  assert.equal(parseNodeVersion("v24.1.0").major, 24);
  assert.match(nodeVersionHint(), /22\.12.*低于 27/);
});

test("parseNodeEngineRange：只认 engines.node 的固定写法，读不懂 → null；结果直接喂给 isNodeVersionSupported", () => {
  const own = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).engines.node;
  assert.deepEqual(parseNodeEngineRange(own), { min: [22, 12, 0], maxMajor: 27 }, "本仓库自己的 engines 读得懂，且与 isNodeVersionSupported 的默认值一致");
  assert.deepEqual(parseNodeEngineRange(">=24"), { min: [24, 0, 0], maxMajor: Number.POSITIVE_INFINITY });
  assert.deepEqual(parseNodeEngineRange(" >= 24.3  < 28.0.0 "), { min: [24, 3, 0], maxMajor: 28 });
  for (const odd of [undefined, null, 24, "", "*", "^24.0.0", "24.x", ">=22 || >=24", ">=22.12.0 <27.1", "<27", ">=22.12.0 <=26"]) {
    assert.equal(parseNodeEngineRange(odd), null, String(odd));
  }
  const raised = parseNodeEngineRange(">=24.0.0 <27");
  assert.equal(isNodeVersionSupported("22.12.0", raised), false);
  assert.equal(isNodeVersionSupported("v24.0.0", raised), true);
  assert.equal(isNodeVersionSupported("30.1.0", parseNodeEngineRange(">=24")), true, "没写上界就没有上界");
  assert.equal(nodeRangeText(raised), "24.0 及以上、低于 27");
  assert.equal(nodeRangeText(parseNodeEngineRange(">=24.3.1")), "24.3.1 及以上");
});

test("ensureWindowsOpenSshOnPath：运行中装好 OpenSSH 后补进本进程 PATH；其它情况不动", async () => {
  const { ensureWindowsOpenSshOnPath, windowsOpenSshDir } = await import("./platform.mjs");
  const dir = windowsOpenSshDir({ SystemRoot: "C:\\Windows" });
  assert.equal(dir, "C:\\Windows\\System32\\OpenSSH");
  const exists = (p) => p === "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
  const env = { SystemRoot: "C:\\Windows", Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd" };
  assert.equal(ensureWindowsOpenSshOnPath("ssh", { platform: "win32", env, exists }), true);
  assert.equal(env.Path, "C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Windows\\System32\\OpenSSH", "补在末尾，不抢在已有的前面");
  assert.equal(ensureWindowsOpenSshOnPath("ssh.exe", { platform: "win32", env, exists }), false, "已经在 PATH 里");
  const quoted = { SystemRoot: "C:\\Windows", PATH: "\"C:\\Windows\\System32\\OpenSSH\\\";C:\\x" };
  assert.equal(ensureWindowsOpenSshOnPath("ssh", { platform: "win32", env: quoted, exists }), false, "带引号、带结尾斜杠也认得");
  const missing = { SystemRoot: "C:\\Windows", Path: "C:\\x" };
  assert.equal(ensureWindowsOpenSshOnPath("ssh", { platform: "win32", env: missing, exists: () => false }), false, "还没装上");
  assert.equal(missing.Path, "C:\\x");
  assert.equal(ensureWindowsOpenSshOnPath("git", { platform: "win32", env: missing, exists }), false, "不是 ssh 系列命令");
  assert.equal(ensureWindowsOpenSshOnPath("ssh", { platform: "darwin", env: missing, exists }), false);
});
