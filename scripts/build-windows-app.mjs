#!/usr/bin/env node
// build-windows-app.mjs —— 构建 Windows 桌面安装包（与 build-macos-app.sh 产出的 .app 同一套运行文件）。
//
// 用法：
//   node scripts/build-windows-app.mjs                 # 只组装安装目录 dist/windows/Codex Operations Console/
//   node scripts/build-windows-app.mjs --zip           # 另打便携 zip（解压即用，任何系统上都能构建）
//   node scripts/build-windows-app.mjs --installer     # 另编译 Setup.exe（需要 Windows + Inno Setup 6.5+，或设 ISCC）
//   node scripts/build-windows-app.mjs --smoke         # 用组装好的 exe 起一次隔离的监控服务（只能在 Windows 上跑）
//   选项：--arch x64|arm64（默认 x64）  --output <目录>（默认 dist/windows）
//         --electron-dist <目录>（用现成的 Windows 版 Electron 目录，不下载；目录里要有 electron.exe）
//
// 步骤：取 Windows 版 Electron（与 package.json 锁定的版本一致，经 electron 包自带的 checksums.json 校验 SHA-256，
// 下载缓存与 npm install 共用）→ 拷出外壳、改名主程序 → 注入运行文件白名单（与 macOS 构建相同）→
// 图标 → build-info.json → 白名单 / 体积 / node --check 门禁 →（可选）冒烟、zip、Setup.exe，各附 .sha256。
//
// 安装目录布局：
//   Codex Operations Console.exe        主程序（Electron 改名）
//   resources\app\                      electron-main.mjs、work/monitor/ …（runtime-paths 据此认出打包模式）
//   resources\app-icon.ico              窗口 / 任务栏 / 快捷方式图标（desktop/context.mjs 的 windowIconPath）
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { computeComponentHashes } from "../work/monitor/lib/component-version.mjs";
import { smokeBinary } from "./hot-update/smoke.mjs";
import { isMainModule } from "./lib/is-main.mjs";
import { createZip } from "./lib/zip.mjs";
import { scanRelease } from "./release-scan.mjs";

export const APP_NAME = "Codex Operations Console";
export const EXE_NAME = `${APP_NAME}.exe`;
// 解压后的表观体积上限（MB）。Electron 44 的 Windows 版本身约 300 MB；超了多半是混进了不该打包的东西。
export const MAX_APP_SIZE_MB = 450;

const ROOT_DIR = path.resolve(import.meta.dirname, "..");

// 与 build-macos-app.sh 第 3 步同一份白名单：只带运行所需文件；work/monitor 内排除测试、运行状态、日志与 PID。
const TOP_FILES = ["electron-main.mjs", "preload.js", "package.json", "config.json"];
const REQUIRED = [
  "electron-main.mjs",
  "preload.js",
  "package.json",
  "config.json",
  "work/monitor/monitor-server.mjs",
  "work/monitor/remote/collect.sh",
  "work/monitor/remote/usage-scan.py",
  "work/local_http_connect_proxy.mjs",
];
const FORBIDDEN_DIRS = ["work/codex-cli-offline-build", "work/runtime", "work/monitor/runtime"];

export function isExcludedMonitorEntry(name, isDirectory) {
  if (isDirectory) return name === "runtime";
  return name === ".DS_Store" || name.endsWith(".test.mjs") || /\.(?:log|pid)$/.test(name);
}

export function parseArgs(argv) {
  const opts = { zip: false, installer: false, smoke: false, arch: "x64", output: null, electronDist: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} 需要一个值`);
      i += 1;
      return next;
    };
    if (arg === "--zip") opts.zip = true;
    else if (arg === "--installer") opts.installer = true;
    else if (arg === "--smoke") opts.smoke = true;
    else if (arg === "--arch") opts.arch = value();
    else if (arg === "--output") opts.output = value();
    else if (arg === "--electron-dist") opts.electronDist = value();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!["x64", "arm64"].includes(opts.arch)) throw new Error(`--arch 只支持 x64 / arm64：${opts.arch}`);
  return opts;
}

export function artifactNames(version, arch) {
  const base = `CodexOperationsConsole-${version}-windows-${arch}`;
  return { zip: `${base}.zip`, setupBase: `${base}-setup`, setup: `${base}-setup.exe` };
}

// 取 Windows 版 Electron：走 electron 包自己的下载器与校验值（与 npm install 下载 macOS 版同一条路，
// 同一个缓存目录），解压到临时目录。返回解压出的目录。
export async function fetchElectronDist({ rootDir = ROOT_DIR, arch, tmpDir }) {
  const electronPkg = path.join(rootDir, "node_modules", "electron", "package.json");
  if (!fs.existsSync(electronPkg)) throw new Error("找不到 node_modules/electron：先执行 npm ci --ignore-scripts");
  const requireFromElectron = createRequire(electronPkg);
  const { version } = requireFromElectron("./package.json");
  const { downloadArtifact } = requireFromElectron("@electron/get");
  const { extract } = requireFromElectron("@electron-internal/extract-zip");
  console.log(`→ 取 Electron ${version} win32-${arch}（按 electron/checksums.json 校验 SHA-256）`);
  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform: "win32",
    arch,
    checksums: requireFromElectron("./checksums.json"),
    cacheRoot: process.env.electron_config_cache,
  });
  const dest = path.join(tmpDir, "electron-dist");
  await extract(zipPath, { dir: dest });
  return dest;
}

// 拷外壳 + 改名 + 注入运行文件 + 图标 + build-info。返回 { appDir, resourcesApp }。
export async function stageWindowsApp({ rootDir = ROOT_DIR, electronDist, outDir, buildInfo }) {
  if (!fs.existsSync(path.join(electronDist, "electron.exe"))) {
    throw new Error(`不是 Windows 版 Electron 目录（缺 electron.exe）：${electronDist}`);
  }
  const appDir = path.join(outDir, APP_NAME);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // default_app.asar 是 Electron 自带的「把文件拖进来」演示壳：有 resources/app 时用不上，留着只会多一个入口。
  fs.cpSync(electronDist, appDir, {
    recursive: true,
    filter: (src) => path.basename(src) !== "default_app.asar",
  });
  fs.renameSync(path.join(appDir, "electron.exe"), path.join(appDir, EXE_NAME));

  const resourcesApp = path.join(appDir, "resources", "app");
  fs.mkdirSync(resourcesApp, { recursive: true });
  for (const rel of TOP_FILES) fs.copyFileSync(path.join(rootDir, rel), path.join(resourcesApp, rel));
  fs.cpSync(path.join(rootDir, "work", "monitor"), path.join(resourcesApp, "work", "monitor"), {
    recursive: true,
    filter: (src) => {
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(src).isDirectory();
      } catch {}
      return !isExcludedMonitorEntry(path.basename(src), isDirectory);
    },
  });
  fs.copyFileSync(path.join(rootDir, "work", "local_http_connect_proxy.mjs"), path.join(resourcesApp, "work", "local_http_connect_proxy.mjs"));
  fs.copyFileSync(path.join(rootDir, "scripts", "assets", "app-icon.ico"), path.join(appDir, "resources", "app-icon.ico"));

  // components = 数据面组件指纹（与 macOS 构建同一算法），按打包后的资源目录计算；算不出写空串（= 未知）。
  let components = { supervisor: "", proxy: "" };
  try {
    components = await computeComponentHashes(resourcesApp);
  } catch (err) {
    console.warn(`WARNING: 组件指纹计算失败，写空（未知）：${err?.message || err}`);
  }
  fs.writeFileSync(path.join(resourcesApp, "build-info.json"), `${JSON.stringify({ ...buildInfo, components }, null, 2)}\n`);
  return { appDir, resourcesApp };
}

// 与 build-macos-app.sh 的 validate_app_bundle 同一套规则。返回问题列表，空 = 通过。
export function validateAppPayload(resourcesApp) {
  const problems = [];
  for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(resourcesApp, rel))) problems.push(`缺少必需文件：${rel}`);
  }
  for (const rel of FORBIDDEN_DIRS) {
    if (fs.existsSync(path.join(resourcesApp, rel))) problems.push(`混进了不该打包的目录：${rel}`);
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.test\.mjs$|\.log$|\.pid$/.test(entry.name)) problems.push(`混进了不该打包的文件：${path.relative(resourcesApp, full).split(path.sep).join("/")}`);
    }
  };
  walk(resourcesApp);
  return problems;
}

export function dirSizeBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function writeSha256(file) {
  const digest = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  fs.writeFileSync(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`);
  return digest;
}

// 便携 zip：顶层一个「Codex Operations Console」目录，解压后双击里面的 exe 即可。
export function writePortableZip(appDir, zipPath) {
  const folder = path.basename(appDir);
  const entries = listFiles(appDir).map((rel) => ({ name: `${folder}/${rel}`, data: fs.readFileSync(path.join(appDir, ...rel.split("/"))) }));
  fs.writeFileSync(zipPath, createZip(entries));
  return writeSha256(zipPath);
}

// ISCC 的位置：环境变量 ISCC → 常见安装位置下的「Inno Setup <大版本>」（新的大版本优先）→ PATH。
export function findIscc({ env = process.env, exists = fs.existsSync, listDir = safeReadDir, platform = process.platform } = {}) {
  if (env.ISCC) return env.ISCC;
  if (platform !== "win32") return null;
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs")].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    const versions = listDir(root)
      .map((name) => /^Inno Setup (\d+)$/.exec(name))
      .filter(Boolean)
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    for (const match of versions) candidates.push(path.win32.join(root, match[0], "ISCC.exe"));
  }
  return candidates.find((file) => exists(file)) || "ISCC.exe";
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function isccArgs({ issPath, version, sourceDir, outputDir, setupBase, iconFile }) {
  return [
    "/Qp",
    `/DAppVersion=${version}`,
    `/DSourceDir=${sourceDir}`,
    `/DOutputDir=${outputDir}`,
    `/DOutputBaseFilename=${setupBase}`,
    `/DIconFile=${iconFile}`,
    issPath,
  ];
}

function gitCommit(rootDir) {
  const result = spawnSync("git", ["-C", rootDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export async function buildWindowsApp(argv = [], { rootDir = ROOT_DIR, log = console.log } = {}) {
  const opts = parseArgs(argv);
  const version = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")).version;
  const outDir = path.resolve(opts.output || path.join(rootDir, "dist", "windows"));
  const names = artifactNames(version, opts.arch);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-win-build-"));
  try {
    const electronDist = opts.electronDist ? path.resolve(opts.electronDist) : await fetchElectronDist({ rootDir, arch: opts.arch, tmpDir });
    log(`→ 组装 ${APP_NAME} ${version}（${opts.arch}）→ ${outDir}`);
    const { appDir, resourcesApp } = await stageWindowsApp({
      rootDir,
      electronDist,
      outDir,
      buildInfo: { version, gitCommit: gitCommit(rootDir), builtAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), platform: `win32-${opts.arch}` },
    });

    const problems = validateAppPayload(resourcesApp);
    if (problems.length) throw new Error(`打包白名单校验失败：\n  ${problems.join("\n  ")}`);
    const sizeMb = Math.round(dirSizeBytes(appDir) / 1024 / 1024);
    if (sizeMb > MAX_APP_SIZE_MB) throw new Error(`安装目录 ${sizeMb} MB 超过上限 ${MAX_APP_SIZE_MB} MB`);
    log(`  白名单校验通过（${sizeMb} MB ≤ ${MAX_APP_SIZE_MB} MB）`);
    for (const entry of ["electron-main.mjs", "work/monitor/monitor-server.mjs"]) {
      const check = spawnSync(process.execPath, ["--check", path.join(resourcesApp, entry)], { encoding: "utf8" });
      if (check.status !== 0) throw new Error(`node --check 失败：${entry}\n${check.stderr}`);
    }
    const scan = scanRelease({ artifactDir: resourcesApp });
    if (!scan.ok) throw new Error(`包内容扫描失败：${JSON.stringify(scan.findings)}`);
    log("  入口语法检查与包内容扫描通过");

    if (opts.smoke) {
      if (process.platform !== "win32") throw new Error("--smoke 只能在 Windows 上跑（要执行包里的 exe）");
      log("→ 冒烟：用包里的 exe 起一次隔离的监控服务（fixture 模式、临时端口与数据目录）");
      const result = await smokeBinary(path.join(appDir, EXE_NAME), resourcesApp, { log, timeoutMs: 90_000 });
      if (!result.ok) throw new Error(`冒烟失败：${result.detail || ""}`);
      log("  冒烟通过");
    }

    const outputs = [];
    if (opts.zip) {
      const zipPath = path.join(outDir, names.zip);
      log(`→ 便携 zip：${names.zip}`);
      writePortableZip(appDir, zipPath);
      outputs.push(zipPath, `${zipPath}.sha256`);
    }
    if (opts.installer) {
      const iscc = findIscc();
      if (!iscc) throw new Error("编译 Setup.exe 需要 Windows 上的 Inno Setup 6.5+（或用环境变量 ISCC 指向 ISCC.exe）");
      log(`→ 安装器：${names.setup}（${iscc}）`);
      const result = spawnSync(iscc, isccArgs({
        issPath: path.join(rootDir, "scripts", "windows-installer", "codex-operations-console.iss"),
        version,
        sourceDir: appDir,
        outputDir: outDir,
        setupBase: names.setupBase,
        iconFile: path.join(rootDir, "scripts", "assets", "app-icon.ico"),
      }), { stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`ISCC 编译失败（${result.error?.message || `exit ${result.status}`}）`);
      const setupPath = path.join(outDir, names.setup);
      writeSha256(setupPath);
      outputs.push(setupPath, `${setupPath}.sha256`);
    }
    log(`✓ 完成：${appDir}`);
    for (const file of outputs) log(`  ${file}`);
    return { version, appDir, outputs };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  buildWindowsApp(process.argv.slice(2)).catch((err) => {
    console.error(`✗ ${err?.message || err}`);
    process.exitCode = 1;
  });
}
