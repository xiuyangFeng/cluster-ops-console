import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "build-macos-app.sh",
);
// 统一成 LF：Windows 检出若是 CRLF，按 "\n" 锚定的静态断言会失配。
const script = fs.readFileSync(scriptPath, "utf8").replace(/\r\n/g, "\n");

// build-macos-app.sh 是 macOS 专用构建脚本，只能由 POSIX shell 执行。脚本正文的静态检查
// 各平台照跑；真正 spawn 它的用例在 win32 跳过——Windows 同事走网页模式，从不构建 .app。

const requiredPaths = [
  "electron-bootstrap.mjs",
  "electron-main.mjs",
  "preload.js",
  "package.json",
  "config.json",
  "work/monitor/monitor-server.mjs",
  // 零残留采集脚本：随 work/monitor/ 整目录拷进包，缺了它 slow/fast 探测直接哑火。
  "work/monitor/remote/collect.sh",
  // Agent 用量扫描脚本：缺了它用量页永远停在「等待首次同步」。
  "work/monitor/remote/usage-scan.py",
  "work/local_http_connect_proxy.mjs",
];

function makeStagedBundle() {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-bundle-"));
  for (const relativePath of requiredPaths) {
    const target = path.join(bundle, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "staged test file\n");
  }
  return bundle;
}

function validateBundle(bundle) {
  return spawnSync(scriptPath, ["--validate-bundle", bundle], {
    encoding: "utf8",
  });
}

test("copies only the runtime whitelist", () => {
  assert.doesNotMatch(
    script,
    /^\s*["']?\$ROOT_DIR\/work["']?\s*\\?\s*$/m,
    "build must not copy the whole work directory",
  );

  for (const source of [
    "$ROOT_DIR/electron-main.mjs",
    "$ROOT_DIR/preload.js",
    "$ROOT_DIR/package.json",
    "$ROOT_DIR/config.json",
    "$ROOT_DIR/work/monitor/",
    "$ROOT_DIR/work/local_http_connect_proxy.mjs",
  ]) {
    assert.match(script, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing whitelisted copy source: ${source}`);
  }
});

test("validates required and forbidden bundle paths", () => {
  assert.match(script, /validate_app_bundle\s*\(\)/, "missing reusable bundle validation function");
  assert.match(
    script,
    /validate_app_bundle\s+["']?\$APP_RESOURCES["']?/,
    "bundle validation must run against the staged app resources",
  );

  for (const required of [
    "electron-main.mjs",
    "preload.js",
    "package.json",
    "config.json",
    "work/monitor/monitor-server.mjs",
    "work/monitor/remote/collect.sh",
    "work/monitor/remote/usage-scan.py",
    "work/local_http_connect_proxy.mjs",
  ]) {
    assert.match(script, new RegExp(`required[^\\n]*${required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), `missing required-file check: ${required}`);
  }

  for (const forbidden of [
    "work/codex-cli-offline-build",
    "work/runtime",
    "*.test.mjs",
    "*.log",
    "*.pid",
  ]) {
    assert.match(script, new RegExp(`forbidden[^\\n]*${forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), `missing forbidden-path check: ${forbidden}`);
  }
});

test("executes bundle validation against a valid temporary stage", { skip: process.platform === "win32" }, (t) => {
  const bundle = makeStagedBundle();
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));

  const result = validateBundle(bundle);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bundle path validation passed/);
});

test("executed bundle validation rejects a missing required file", { skip: process.platform === "win32" }, (t) => {
  const bundle = makeStagedBundle();
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.rmSync(path.join(bundle, "preload.js"));

  const result = validateBundle(bundle);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Required bundle path missing: preload\.js/);
});

test("executed bundle validation rejects a forbidden path", { skip: process.platform === "win32" }, (t) => {
  const bundle = makeStagedBundle();
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.mkdirSync(path.join(bundle, "work/codex-cli-offline-build"), {
    recursive: true,
  });

  const result = validateBundle(bundle);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Forbidden bundle path found: work\/codex-cli-offline-build/);
});

test("enforces a 350 MB default apparent-size gate", () => {
  assert.match(
    script,
    /MAX_APP_SIZE_MB=["']?\$\{MAX_APP_SIZE_MB:-350\}["']?/,
    "MAX_APP_SIZE_MB must default to 350",
  );
  assert.match(script, /du\s+-sm\s+["']?\$APP_DIR["']?/, "app size gate must use du -sm");
  assert.match(
    script,
    /APP_SIZE_MB[^\n]*-gt[^\n]*MAX_APP_SIZE_MB/,
    "app size gate must reject bundles over MAX_APP_SIZE_MB",
  );
});

test("MAX_APP_SIZE_MB cannot raise the hard 350 MB ceiling", { skip: process.platform === "win32" }, () => {
  const result = spawnSync(scriptPath, ["--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, MAX_APP_SIZE_MB: "999" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MAX_APP_SIZE_MB=350/);
  assert.doesNotMatch(result.stdout, /MAX_APP_SIZE_MB=999/);
});

test("real builds refuse to replace a bundle used by a running desktop process", () => {
  assert.match(script, /pgrep[^\n]+APP_DIR[^\n]+APP_NAME/, "build must detect a running packaged desktop process");
  assert.match(script, /Stop the stale desktop process before rebuild/i, "failure must instruct maintainers to stop the stale desktop process before rebuilding");
});

// prune_backups 的 lsof 占用保护：只把函数本体抽出来在临时目录里跑（假 lsof 放在 PATH 最前），
// 不跑构建。与 scripts/hot-update/bundle.mjs 的 pruneBackups 同一判定。
function runPruneBackups(t, { lsofOutput = "", lsofExit = 1, backups = ["n1", "n2", "n3", "n4"] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-prune-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backupRoot = path.join(root, "backup");
  backups.forEach((name, i) => {
    const dir = path.join(backupRoot, name, "Contents/MacOS");
    fs.mkdirSync(dir, { recursive: true });
    const time = new Date(Date.UTC(2026, 0, 10 - i)); // n1 最新
    fs.utimesSync(path.join(backupRoot, name), time, time);
  });
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "lsof"), `#!/bin/sh\nprintf '%s' '${lsofOutput.replaceAll("{root}", backupRoot)}'\nexit ${lsofExit}\n`, { mode: 0o755 });
  const fn = script.match(/^prune_backups\(\) \{\n[\s\S]*?\n\}\n/m)[0];
  const result = spawnSync("bash", ["-c", `set -euo pipefail\nBACKUP_ROOT="$1"\n${fn}\nprune_backups`, "prune", backupRoot], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
  });
  return { result, left: fs.readdirSync(backupRoot).sort() };
}

test("prune_backups keeps a backup a running process still executes from", { skip: process.platform === "win32" }, (t) => {
  assert.match(script, /prune_backups\(\) \{[\s\S]*?lsof -a -d txt -c Codex -Fn/, "构建脚本的备份修剪必须带 lsof 占用保护");
  const { result, left } = runPruneBackups(t, {
    lsofExit: 0,
    lsofOutput: "p77\nftxt\nn{root}/n3/Contents/MacOS/Codex Operations Console\np9\nn/usr/lib/dyld\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(left, ["n1", "n2", "n3"], "最新 2 份保留；n3 仍在执行保留；n4 删除");
  assert.match(result.stdout, /Keeping backup still in use by a running process: .*n3/);
});

test("prune_backups with no lsof match prunes to 2; lsof failure prunes nothing", { skip: process.platform === "win32" }, (t) => {
  const idle = runPruneBackups(t, { lsofExit: 1, lsofOutput: "" });
  assert.equal(idle.result.status, 0, idle.result.stderr);
  assert.deepEqual(idle.left, ["n1", "n2"]);
  // 前缀相同但不同目录不能误判为占用
  const sibling = runPruneBackups(t, { lsofExit: 0, lsofOutput: "p1\nn{root}/n3x/bin\n", backups: ["n1", "n2", "n3"] });
  assert.deepEqual(sibling.left, ["n1", "n2"]);
  const failed = runPruneBackups(t, { lsofExit: 2, lsofOutput: "" });
  assert.equal(failed.result.status, 0, failed.result.stderr);
  assert.deepEqual(failed.left, ["n1", "n2", "n3", "n4"], "lsof 失败时宁可多留不可误删");
  assert.match(failed.result.stderr, /skipping backup pruning/);
});

test("checksums cover build-info and runtime entry files", () => {
  assert.match(script, /printf ['"]\.\/build-info\.json\\0['"]/, "build-info must be included in checksum inputs");
  assert.match(script, /find \. .*name '\*\.mjs'.*name '\*\.js'/, "all JavaScript runtime entries must remain checksum inputs");
});

test("--output builds into a staging location without refusing, backing up or touching the live app", { skip: process.platform === "win32" }, (t) => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "codex-staging-"));
  t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
  const output = path.join(stage, "Codex Operations Console.app");
  const result = spawnSync(scriptPath, ["--output", output, "--dry-run"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Staging build -> .*codex-staging-.*Codex Operations Console\.app/);
  assert.match(result.stdout, /skipping backup\/prune/);
  assert.doesNotMatch(result.stdout, /Backing up existing app/);
  assert.equal(fs.readdirSync(stage).length, 0, "dry-run must not create the staged bundle");
});

test("--output validates its argument", { skip: process.platform === "win32" }, () => {
  const bad = spawnSync(scriptPath, ["--output", path.join(os.tmpdir(), "not-an-app"), "--dry-run"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /must end in \.app/);
  const missing = spawnSync(scriptPath, ["--output"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const combo = spawnSync(scriptPath, ["--rollback", "--output", path.join(os.tmpdir(), "x.app")], { encoding: "utf8" });
  assert.equal(combo.status, 2);
});

test("staging builds skip the running-desktop refusal and backups; build-info carries component hashes", () => {
  assert.match(script, /"\$DRY_RUN" = 0 \] && \[ "\$STAGING_BUILD" = 0 \][^\n]*\n\s*RUNNING_DESKTOP_PIDS/, "running-desktop refusal must be skipped for staging builds only");
  assert.match(script, /if \[ "\$STAGING_BUILD" = 1 \]; then\n\s*echo "Staging build: skipping backup/);
  assert.match(script, /computeComponentHashes\(process\.env\.COMPONENTS_APP_ROOT\)/);
  assert.match(script, /COMPONENTS_APP_ROOT="\$APP_RESOURCES"/, "hashes must be computed on the staged resources");
  assert.match(script, /"components": \$COMPONENTS_JSON/);
});

// ---------------------------------------------------------------------------
// 构建失败必须把备份换回现役位置（否则一次失败的构建会删掉用户能用的桌面应用）
//
// 这一段只能端到端验证：失败点在"已经 rm -rf 掉现役 .app"之后，靠静态断言看不出来。
// 做法是在临时目录里搭一个完整可跑的假构建根（假 Electron 运行时 + 假源码 + 已安装的
// 假 .app + 真脚本副本），再让第 7 步 node --check 失败——那是替换之后、签名之前的
// 位置，正好落在需要回滚的窗口里。
// ---------------------------------------------------------------------------

const MINIMAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>fixture</string></dict></plist>
`;

const STAGED_SOURCES = {
  // 故意不是合法 JS：脚本第 7 步 `node --check` 会在这里失败。
  "electron-main.mjs": "const = deliberately broken;\n",
  "preload.js": "// fixture\n",
  "package.json": '{"name":"build-rollback-fixture","version":"9.9.9"}\n',
  "config.json": "{}\n",
  "work/monitor/monitor-server.mjs": "// fixture\n",
  "work/monitor/remote/collect.sh": "#!/bin/sh\n",
  "work/monitor/remote/usage-scan.py": "# fixture\n",
  "work/local_http_connect_proxy.mjs": "// fixture\n",
};

function makeFakeBuildRoot({ validSources = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-root-"));
  const write = (relative, body) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };

  write("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "#!/bin/sh\n");
  write("node_modules/electron/dist/Electron.app/Contents/Info.plist", MINIMAL_PLIST);
  for (const [relative, body] of Object.entries(STAGED_SOURCES)) write(relative, body);
  if (validSources) {
    // 能一路走到签名步骤：入口语法合法 + 图标在位（组件指纹算不出来只告警、写空串）。
    write("electron-bootstrap.mjs", "// fixture\n");
    write("electron-main.mjs", "// fixture\n");
    write("scripts/assets/app-icon.icns", "icns-fixture\n");
    write("node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns", "electron-icns-fixture\n");
  }

  // 现役"已安装"应用：只需能被备份与恢复（本用例验证的是回滚）。
  write("Codex Operations Console.app/ORIGINAL.txt", "original-live-app\n");
  write("Codex Operations Console.app/Contents/Info.plist", MINIMAL_PLIST);

  // ROOT_DIR 由脚本自身位置推导，所以必须把真脚本复制进假根（先建目录）。
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(root, "scripts/build-macos-app.sh"));
  return root;
}

const liveAppRoot = (root) => path.join(root, "Codex Operations Console.app");

test("failed build restores the previous app instead of leaving it deleted", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeBuildRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync("bash", [path.join(root, "scripts/build-macos-app.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
  });

  assert.notEqual(result.status, 0, `构建本应失败：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /构建失败/, "失败时必须打印回滚提示");
  assert.match(result.stderr, /恢复原有应用|恢复失败/, "失败时必须尝试恢复");
  assert.equal(
    fs.existsSync(path.join(liveAppRoot(root), "ORIGINAL.txt")),
    true,
    "回滚后原来的 app 必须回到现役位置（否则用户的应用被一次失败的构建删掉了）",
  );
  // 恢复出来的必须是旧包，而不是被替换进去的半成品。
  assert.equal(
    fs.existsSync(path.join(liveAppRoot(root), "Contents/Resources/app/electron-main.mjs")),
    false,
    "现役位置不应残留失败构建的半成品",
  );
  const backups = fs.readdirSync(path.join(root, "dist", "backup"));
  assert.equal(backups.length, 1, "备份应保留下来供人工排查");
});

test("failed build keeps the original exit code so CI still fails", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeBuildRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("bash", [path.join(root, "scripts/build-macos-app.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
  });
  // trap 里若写了 exit 0（或吞掉状态），CI 会把失败当成功。
  assert.equal(result.status, 1, `trap 不得吞掉失败退出码，实际 ${result.status}`);
});

test("staging build failure never touches the live app and reports it", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeBuildRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stagingApp = path.join(root, "dist/staging/fixture/Codex Operations Console.app");

  const result = spawnSync("bash", [
    path.join(root, "scripts/build-macos-app.sh"),
    "--output", stagingApp,
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    },
  });

  assert.notEqual(result.status, 0);
  // 这条断言检查的是面向操作者的输出契约：旁路构建失败时，人必须能立刻知道
  // "现役应用没被动过"，否则会去排查一个根本没受影响的安装。
  assert.match(result.stderr, /live app was never touched/, "旁路构建失败时应说明现役应用未被动过");
  assert.equal(
    fs.existsSync(path.join(liveAppRoot(root), "ORIGINAL.txt")),
    true,
    "旁路构建失败不得影响现役 app",
  );
  assert.equal(
    fs.existsSync(path.join(liveAppRoot(root), "Contents/Resources/app")),
    false,
    "旁路构建不得往现役 app 里写东西",
  );
});

// ---------------------------------------------------------------------------
// #7 验签失败必须让构建失败：非 0 退出、不写校验和、现役位置换回旧包。
// 假 codesign 放在 PATH 最前：--force 签名照常"成功"，--verify 返回失败。
// ---------------------------------------------------------------------------

function fakeBin(t, scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fake-bin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

function runFakeBuild(root, binDir, args = []) {
  return spawnSync("bash", [path.join(root, "scripts/build-macos-app.sh"), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}` },
  });
}

const FAKE_CODESIGN_VERIFY_FAILS = 'for a in "$@"; do [ "$a" = "--verify" ] && { echo "fake codesign: a sealed resource is missing or invalid" >&2; exit 1; }; done\nexit 0';

test("signature verification failure fails the build, writes no checksums and restores the previous app", { skip: process.platform !== "darwin" }, (t) => {
  assert.doesNotMatch(script, /WARNING: ad-hoc code signature verification failed/, "验签失败不得只打警告");
  const root = makeFakeBuildRoot({ validSources: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runFakeBuild(root, fakeBin(t, { codesign: FAKE_CODESIGN_VERIFY_FAILS }));
  assert.equal(result.status, 1, `验签失败必须非 0 退出：\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /signature verification failed/);
  assert.match(result.stderr, /sealed resource is missing or invalid/, "codesign 的原始诊断要透出来");
  assert.doesNotMatch(result.stdout, /^Built /m, "不得标记构建成功");
  assert.equal(fs.existsSync(path.join(root, "dist/checksums-9.9.9.txt")), false, "验签失败不产出校验和");
  assert.equal(fs.existsSync(path.join(liveAppRoot(root), "ORIGINAL.txt")), true, "现役位置换回旧包");
});

test("control: the same fake build succeeds when verification passes (the failure above is the signature, not the fixture)", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeBuildRoot({ validSources: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = runFakeBuild(root, fakeBin(t, { codesign: "exit 0" }));
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /signature applied and verified/);
  assert.match(result.stdout, /^Built /m);
  assert.equal(fs.existsSync(path.join(liveAppRoot(root), "ORIGINAL.txt")), false, "现役位置是新包");
  assert.equal(fs.existsSync(path.join(root, "dist/checksums-9.9.9.txt")), true);
});

test("staging build with a failed verification exits non-zero and leaves the live app alone", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeBuildRoot({ validSources: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stagingApp = path.join(root, "dist/staging/fixture/Codex Operations Console.app");
  const result = runFakeBuild(root, fakeBin(t, { codesign: FAKE_CODESIGN_VERIFY_FAILS }), ["--output", stagingApp]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /live app was never touched/);
  assert.equal(fs.existsSync(path.join(liveAppRoot(root), "ORIGINAL.txt")), true);
});

// ---------------------------------------------------------------------------
// #8 --rollback：旁路 staging + 原子 rename + 失败恢复。临时假项目里做故障注入：
// ditto（staging 拷贝）失败、最后一次 rename 失败、桌面仍在运行——现役 .app 都不得消失。
// ---------------------------------------------------------------------------

const BACKUP_ID = "1.0.0-20260101000000";

function makeFakeRollbackRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-rollback-root-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, body) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  write("package.json", '{"name":"rollback-fixture","version":"9.9.9"}\n');
  write("Codex Operations Console.app/ORIGINAL.txt", "original-live-app\n");
  write(`dist/backup/${BACKUP_ID}/BACKUP.txt`, "backup-app\n");
  write(`dist/backup/${BACKUP_ID}/Contents/Resources/app/build-info.json`, '{"version":"1.0.0"}\n');
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(scriptPath, path.join(root, "scripts/build-macos-app.sh"));
  return root;
}

// 现役 .app 的内容标记 + dist/backup 与 dist/staging 的现状。
function rollbackState(root) {
  const live = liveAppRoot(root);
  const list = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readdirSync(path.join(root, rel)).sort() : []);
  let liveState = "missing";
  if (fs.existsSync(path.join(live, "ORIGINAL.txt"))) liveState = "original";
  else if (fs.existsSync(path.join(live, "BACKUP.txt"))) liveState = "backup";
  else if (fs.existsSync(live)) liveState = "other";
  return { live: liveState, backups: list("dist/backup"), staging: list("dist/staging") };
}

const NO_DESKTOP = { pgrep: "exit 1" };

test("--rollback: ditto failing while staging the backup never removes the live app", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeRollbackRoot(t);
  const result = runFakeBuild(root, fakeBin(t, { ...NO_DESKTOP, ditto: "echo 'ditto: fake disk full' >&2\nexit 73" }), ["--rollback"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /live app was not touched/);
  const state = rollbackState(root);
  assert.equal(state.live, "original", "现役 .app 必须原样在位");
  assert.deepEqual(state.backups, [BACKUP_ID], "备份原样保留，也不产生半截安全备份");
  assert.deepEqual(state.staging, [], "staging 残留要清掉");
});

test("--rollback: the final rename failing puts the previous app back", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeRollbackRoot(t);
  // 只让"staged → 现役"这一次 rename 失败，其余 mv 照常（包括把安全备份换回去）。
  const mv = 'case "$1" in */dist/staging/*) echo "mv: fake EIO" >&2; exit 1 ;; esac\nexec /bin/mv "$@"';
  const result = runFakeBuild(root, fakeBin(t, { ...NO_DESKTOP, mv }), ["--rollback", BACKUP_ID]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /previous app is back/);
  const state = rollbackState(root);
  assert.equal(state.live, "original");
  assert.deepEqual(state.backups, [BACKUP_ID]);
  assert.deepEqual(state.staging, []);
});

test("--rollback: refuses while the packaged desktop is running and points to the hot rollback", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeRollbackRoot(t);
  const result = runFakeBuild(root, fakeBin(t, { pgrep: "echo 4242" }), ["--rollback"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still running \(PID\(s\): 4242/);
  assert.match(result.stderr, new RegExp(`npm run app:update -- --rollback ${BACKUP_ID}`));
  assert.equal(rollbackState(root).live, "original");
});

test("--rollback: success restores the backup and keeps the replaced app as a safety backup", { skip: process.platform !== "darwin" }, (t) => {
  const root = makeFakeRollbackRoot(t);
  const result = runFakeBuild(root, fakeBin(t, NO_DESKTOP), ["--rollback"]);
  assert.equal(result.status, 0, result.stderr);
  const state = rollbackState(root);
  assert.equal(state.live, "backup");
  assert.equal(state.backups.length, 2, state.backups.join(","));
  const safety = state.backups.find((name) => name.startsWith("9.9.9-"));
  assert.ok(safety, "当前版本被换下来成为安全备份");
  assert.equal(fs.existsSync(path.join(root, "dist/backup", safety, "ORIGINAL.txt")), true);
  assert.deepEqual(state.staging, []);
  assert.match(result.stdout, /Rollback complete/);
});

test("--rollback --dry-run plans staging + rename and changes nothing; bad backup ids are rejected", { skip: process.platform === "win32" }, (t) => {
  const root = makeFakeRollbackRoot(t);
  const dry = runFakeBuild(root, fakeBin(t, NO_DESKTOP), ["--rollback", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would ditto .*dist\/staging\/rollback-/);
  assert.match(dry.stdout, /renamed back on failure/);
  assert.doesNotMatch(dry.stdout, /rm -rf/);
  assert.deepEqual(rollbackState(root), { live: "original", backups: [BACKUP_ID], staging: [] });
  for (const bad of ["../x", "a/b", ".."]) {
    const res = runFakeBuild(root, fakeBin(t, NO_DESKTOP), ["--rollback", bad]);
    assert.equal(res.status, 2, bad);
    assert.match(res.stderr, /Invalid backup id/);
  }
});

test("rollback never deletes the live app before the restore copy is staged", () => {
  const body = script.match(/^do_rollback\(\) \{\n[\s\S]*?\n\}\n/m)[0];
  assert.doesNotMatch(body, /rm -rf "\$APP_DIR"/, "回滚路径不得先删现役 .app");
  assert.ok(body.indexOf('ditto "$target_dir" "$staged_app"') < body.indexOf('mv "$staged_app" "$APP_DIR"'), "先旁路 staging，再 rename 换入");
});

test("release workflow smoke-tests the final packaged app with the hot-update smoke", () => {
  const workflow = fs.readFileSync(path.join(path.dirname(scriptPath), "..", ".github/workflows/release.yml"), "utf8").replace(/\r\n/g, "\n");
  const build = workflow.indexOf("bash scripts/build-macos-app.sh");
  const smoke = workflow.indexOf('node scripts/hot-update/smoke.mjs "Codex Operations Console.app"');
  const zip = workflow.indexOf("ditto -c -k --keepParent");
  assert.ok(build > 0 && smoke > build && zip > smoke, "冒烟必须在构建之后、打包发布之前");
  assert.match(workflow, /if: runner\.os == 'macOS'\n\s+run: \|\n\s+codesign --verify --deep --strict "Codex Operations Console\.app"/);
});
