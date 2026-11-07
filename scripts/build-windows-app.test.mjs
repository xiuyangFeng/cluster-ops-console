import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_NAME,
  artifactNames,
  EXE_NAME,
  findIscc,
  isccArgs,
  isExcludedMonitorEntry,
  parseArgs,
  stageWindowsApp,
  validateAppPayload,
} from "./build-windows-app.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "win-build-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("参数：默认只组装 x64；未知参数与缺值直接报错", () => {
  assert.deepEqual(parseArgs([]), { zip: false, installer: false, smoke: false, arch: "x64", output: null, electronDist: null });
  assert.deepEqual(parseArgs(["--zip", "--installer", "--smoke", "--arch", "arm64", "--output", "out", "--electron-dist", "e"]),
    { zip: true, installer: true, smoke: true, arch: "arm64", output: "out", electronDist: "e" });
  assert.throws(() => parseArgs(["--bogus"]), /未知参数/);
  assert.throws(() => parseArgs(["--output"]), /需要一个值/);
  assert.throws(() => parseArgs(["--arch", "ia32"]), /只支持/);
});

test("产物命名：版本 + 平台 + 架构", () => {
  assert.deepEqual(artifactNames("2.85.0", "x64"), {
    zip: "CodexOperationsConsole-2.85.0-windows-x64.zip",
    setupBase: "CodexOperationsConsole-2.85.0-windows-x64-setup",
    setup: "CodexOperationsConsole-2.85.0-windows-x64-setup.exe",
  });
});

test("work/monitor 的排除规则与 macOS 构建（rsync --exclude）一致", () => {
  assert.equal(isExcludedMonitorEntry("runtime", true), true);
  assert.equal(isExcludedMonitorEntry("runtime", false), false);
  for (const name of [".DS_Store", "foo.test.mjs", "x.log", "x.pid", ".codex-operations-console.log"]) {
    assert.equal(isExcludedMonitorEntry(name, false), true, name);
  }
  assert.equal(isExcludedMonitorEntry("monitor-server.mjs", false), false);
});

test("组装：外壳改名、去掉 default_app.asar、只注入白名单、带图标与 build-info，并通过白名单校验", async (t) => {
  const dir = tmp(t);
  const electronDist = path.join(dir, "electron");
  fs.mkdirSync(path.join(electronDist, "resources"), { recursive: true });
  fs.writeFileSync(path.join(electronDist, "electron.exe"), "exe");
  fs.writeFileSync(path.join(electronDist, "ffmpeg.dll"), "dll");
  fs.writeFileSync(path.join(electronDist, "resources", "default_app.asar"), "demo");
  const outDir = path.join(dir, "out");

  const { appDir, resourcesApp } = await stageWindowsApp({ rootDir: ROOT, electronDist, outDir, buildInfo: { version: "9.9.9" } });
  assert.equal(appDir, path.join(outDir, APP_NAME));
  assert.ok(fs.existsSync(path.join(appDir, EXE_NAME)));
  assert.ok(!fs.existsSync(path.join(appDir, "electron.exe")));
  assert.ok(fs.existsSync(path.join(appDir, "ffmpeg.dll")));
  assert.ok(!fs.existsSync(path.join(appDir, "resources", "default_app.asar")));
  assert.ok(fs.existsSync(path.join(appDir, "resources", "app-icon.ico")));
  assert.equal(resourcesApp, path.join(appDir, "resources", "app"));
  for (const rel of ["electron-main.mjs", "preload.js", "package.json", "config.json", "work/local_http_connect_proxy.mjs", "work/monitor/monitor-server.mjs"]) {
    assert.ok(fs.existsSync(path.join(resourcesApp, rel)), rel);
  }
  // 不带测试、不带 scripts/、不带个人配置。
  assert.ok(!fs.existsSync(path.join(resourcesApp, "work", "monitor", "monitor-server.test.mjs")));
  assert.ok(!fs.existsSync(path.join(resourcesApp, "scripts")));
  assert.ok(!fs.existsSync(path.join(resourcesApp, "config.local.json")));
  const info = JSON.parse(fs.readFileSync(path.join(resourcesApp, "build-info.json"), "utf8"));
  assert.equal(info.version, "9.9.9");
  assert.match(info.components.supervisor, /^[0-9a-f]+$/);
  assert.deepEqual(validateAppPayload(resourcesApp), []);

  // 混进测试文件 / 运行目录、缺了入口：都要报出来。
  fs.writeFileSync(path.join(resourcesApp, "work", "monitor", "x.test.mjs"), "");
  fs.mkdirSync(path.join(resourcesApp, "work", "runtime"));
  fs.rmSync(path.join(resourcesApp, "preload.js"));
  const problems = validateAppPayload(resourcesApp);
  assert.ok(problems.some((p) => p.includes("preload.js")));
  assert.ok(problems.some((p) => p.includes("work/runtime")));
  assert.ok(problems.some((p) => p.includes("x.test.mjs")));
});

test("组装：给的不是 Windows 版 Electron（没有 electron.exe）就停下", async (t) => {
  const dir = tmp(t);
  await assert.rejects(stageWindowsApp({ rootDir: ROOT, electronDist: dir, outDir: path.join(dir, "out"), buildInfo: {} }), /缺 electron\.exe/);
});

test("ISCC：环境变量优先；非 Windows 没有就返回 null；Windows 上找常见安装位置", () => {
  assert.equal(findIscc({ env: { ISCC: "/opt/iscc" }, platform: "darwin" }), "/opt/iscc");
  assert.equal(findIscc({ env: {}, platform: "darwin" }), null);
  const pf86 = "C:\\Program Files (x86)";
  const listDir = (dir) => (dir === pf86 ? ["Inno Setup 6", "Inno Setup 7", "Other"] : []);
  const v7 = path.win32.join(pf86, "Inno Setup 7", "ISCC.exe");
  const v6 = path.win32.join(pf86, "Inno Setup 6", "ISCC.exe");
  assert.equal(findIscc({ env: { "ProgramFiles(x86)": pf86 }, platform: "win32", listDir, exists: () => true }), v7, "新的大版本优先");
  assert.equal(findIscc({ env: { "ProgramFiles(x86)": pf86 }, platform: "win32", listDir, exists: (f) => f === v6 }), v6);
  assert.equal(findIscc({ env: {}, platform: "win32", listDir: () => [], exists: () => false }), "ISCC.exe", "最后交给 PATH");
});

test("ISCC 参数：.iss 需要的 /D 定义一个不少", () => {
  const args = isccArgs({ issPath: "a.iss", version: "1.2.3", sourceDir: "S", outputDir: "O", setupBase: "B", iconFile: "I.ico" });
  assert.equal(args.at(-1), "a.iss");
  for (const define of ["/DAppVersion=1.2.3", "/DSourceDir=S", "/DOutputDir=O", "/DOutputBaseFilename=B", "/DIconFile=I.ico"]) {
    assert.ok(args.includes(define), define);
  }
  const iss = fs.readFileSync(path.join(ROOT, "scripts", "windows-installer", "codex-operations-console.iss"), "utf8");
  for (const name of ["AppVersion", "SourceDir", "OutputDir", "OutputBaseFilename", "IconFile"]) {
    assert.match(iss, new RegExp(`\\{#${name}\\}`), `.iss 用到了 ${name}`);
  }
});

test("安装器与桌面壳的 AppUserModelID 一致（Windows 原生通知靠它认发送方）", async () => {
  const { APP_USER_MODEL_ID } = await import("../work/monitor/desktop/context.mjs");
  const iss = fs.readFileSync(path.join(ROOT, "scripts", "windows-installer", "codex-operations-console.iss"), "utf8");
  assert.match(iss, new RegExp(`#define AppUserModelID "${APP_USER_MODEL_ID.replace(/\./g, "\\.")}"`));
  assert.match(iss, /AppUserModelID: "\{#AppUserModelID\}"/);
  // 按当前用户安装，不要管理员；安装目录名与 exe 名和构建脚本一致。
  assert.match(iss, /^PrivilegesRequired=lowest$/m);
  assert.match(iss, new RegExp(`#define AppExeName "${EXE_NAME}"`));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "windows-installer", "ChineseSimplified.isl")));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "assets", "app-icon.ico")));
});

test("发布流水线：Windows 包在 macOS 之后构建、冒烟、上传，最后才把草稿转为正式发布", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8").replace(/\r\n/g, "\n");
  const mac = workflow.indexOf("\n  release:\n");
  const win = workflow.indexOf("\n  release-windows:\n");
  assert.ok(mac > 0 && win > mac, "两个 job 都在");
  const winJob = workflow.slice(win);
  assert.match(winJob, /needs: release\n/);
  assert.match(winJob, /runs-on: windows-latest/);
  // 新建的 Release 先是草稿：Windows 失败时同事看不到只有一半资产的版本。
  assert.match(workflow.slice(mac, win), /gh release create "\$GITHUB_REF_NAME" \\\n\s+--draft \\/);
  const build = winJob.indexOf("node scripts/build-windows-app.mjs --smoke --zip --installer");
  const upload = winJob.indexOf('gh release upload "$GITHUB_REF_NAME" --clobber');
  const publish = winJob.indexOf("--draft=false");
  assert.ok(build > 0 && upload > build && publish > upload, "构建（含冒烟）→ 上传 → 转正式");
});

test("安装器：没有 OpenSSH 客户端时多一个默认勾选的安装任务，以管理员身份装 64 位系统组件", () => {
  const iss = fs.readFileSync(path.join(ROOT, "scripts", "windows-installer", "codex-operations-console.iss"), "utf8");
  assert.match(iss, /^Name: "installopenssh";.*Check: OpenSshMissing$/m);
  assert.doesNotMatch(iss.match(/^Name: "installopenssh".*$/m)[0], /unchecked/, "缺的时候默认勾上");
  assert.match(iss, /OpenSshCapability = 'OpenSSH\.Client~~~~0\.0\.1\.0'/);
  assert.match(iss, /ShellExec\('runas', NativePowerShell,/);
  assert.match(iss, /\{win\}\\Sysnative\\OpenSSH\\ssh\.exe/, "32 位安装程序要绕过 System32 重定向");
  assert.match(iss, /WizardIsTaskSelected\('installopenssh'\)/);
});
