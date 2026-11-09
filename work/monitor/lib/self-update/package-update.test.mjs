import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { writeFileAtomic } from "../atomic-file.mjs";
import { decodePackageBundle, encodePackageBundle, packageAssetName, PACKAGE_REQUIRED } from "./package-bundle.mjs";
import { beginPackageBoot, confirmPackageUpdate, FIXED_BOOT_FILES, PACKAGE_UPDATE_DIR, readPackageJournal } from "./package-recovery.mjs";
import { createPackageUpdater } from "./package-update.mjs";

const project = path.resolve(import.meta.dirname, "../../../..");
const electron = "44.4.5";
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-package-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rootDir = path.join(dir, "resources", "app");
  const put = (rel, value) => {
    const target = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  const pkg = (version) => JSON.stringify({ version, main: "electron-bootstrap.mjs", devDependencies: { electron } });
  for (const rel of PACKAGE_REQUIRED) put(rel, FIXED_BOOT_FILES.includes(rel) ? fs.readFileSync(path.join(project, rel)) : `// old ${rel}`);
  put("package.json", pkg("1.0.0"));
  put("config.json", '{"privateTeam":true}');
  put("work/monitor/obsolete.js", "old module");
  const files = PACKAGE_REQUIRED.map((rel) => ({ path: rel, data: (FIXED_BOOT_FILES.includes(rel) ? fs.readFileSync(path.join(project, rel)) : Buffer.from(rel === "package.json" ? pkg("1.1.0") : `// new ${rel}`)).toString("base64") }));
  files.find((f) => f.path === "build-info.json").data = Buffer.from(JSON.stringify({ version: "1.1.0", platform: "win32-x64" })).toString("base64");
  files.push({ path: "work/monitor/added.js", data: Buffer.from("new module").toString("base64") });
  const bundle = { schema: 1, version: "1.1.0", electron, platform: "win32-x64", files };
  const bytes = encodePackageBundle(bundle);
  const release = { version: "1.1.0", update: { url: `https://github.com/a/b/releases/download/v1.1.0/${packageAssetName("1.1.0")}`, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
  const runtimeDir = path.join(dir, "data", "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "personal-data"), "keep");
  const updater = createPackageUpdater({ rootDir, runtimeDir, repo: "a/b", platform: "win32", arch: "x64", electronVersion: electron, fetchBytes: async () => bytes, smoke: async () => ({ ok: true }), upgrading: () => false, ...options });
  return { rootDir, runtimeDir, put, updater, release, bundle, bytes };
}

test("下载校验、自检、应用、确认启动：保留配置和个人数据，只保留一份备份", async (t) => {
  const f = fixture(t, { smoke: async (stage) => {
    assert.equal(JSON.parse(fs.readFileSync(path.join(stage, "config.json"))).privateTeam, true);
    return { ok: true };
  } });
  assert.equal(f.updater.start(f.release).pending, true);
  assert.throws(() => f.updater.start(f.release), /正在进行/);
  await f.updater.wait();
  assert.equal(f.updater.status().ready, true, JSON.stringify(f.updater.status()));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.rootDir, "package.json"))).version, "1.1.0");
  assert.equal(fs.existsSync(path.join(f.rootDir, "work/monitor/obsolete.js")), false);
  assert.equal(fs.readFileSync(path.join(f.runtimeDir, "personal-data"), "utf8"), "keep");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.rootDir, "config.json"))).privateTeam, true);
  assert.equal(beginPackageBoot(f.rootDir), true);
  confirmPackageUpdate(f.rootDir);
  assert.equal(readPackageJournal(f.rootDir), null);
  assert.ok(fs.existsSync(path.join(f.rootDir, PACKAGE_UPDATE_DIR, "backup", "package.json")));
});

test("新版本启动后未确认就退出：下次启动恢复旧版及删除文件，新文件被移除", async (t) => {
  const f = fixture(t);
  f.updater.start(f.release);
  await f.updater.wait();
  assert.equal(beginPackageBoot(f.rootDir), true);
  assert.equal(beginPackageBoot(f.rootDir), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.rootDir, "package.json"))).version, "1.0.0");
  assert.equal(fs.readFileSync(path.join(f.rootDir, "work/monitor/obsolete.js"), "utf8"), "old module");
  assert.equal(fs.existsSync(path.join(f.rootDir, "work/monitor/added.js")), false);
});

test("写文件失败：已替换文件全部恢复，当前版本及固定引导保持完整", async (t) => {
  const f = fixture(t, { writeAtomic: async (file, data) => {
    if (file.endsWith(`${path.sep}preload.js`)) throw new Error("disk full");
    return writeFileAtomic(file, data);
  } });
  const before = fs.readFileSync(path.join(f.rootDir, "electron-main.mjs"), "utf8");
  f.updater.start(f.release);
  await f.updater.wait();
  assert.match(f.updater.status().error, /disk full/);
  assert.equal(fs.readFileSync(path.join(f.rootDir, "electron-main.mjs"), "utf8"), before);
  assert.equal(readPackageJournal(f.rootDir), null);
});

test("SHA 不符、自检失败、运行时变化、非本仓库资产均不改现役文件", async (t) => {
  for (const kind of ["hash", "smoke", "electron", "url", "boot"]) {
    let bytes;
    const f = fixture(t, {
      ...(kind === "smoke" ? { smoke: async () => ({ ok: false, detail: "bad startup" }) } : {}),
      ...(kind === "electron" ? { electronVersion: "45.0.0" } : {}),
      ...(kind === "boot" ? { fetchBytes: async () => bytes } : {}),
    });
    if (kind === "hash") f.release.update.sha256 = "0".repeat(64);
    if (kind === "url") f.release.update.url = "https://evil.example/update";
    if (kind === "boot") {
      f.bundle.files.find((x) => x.path === "electron-bootstrap.mjs").data = Buffer.from("changed bootstrap").toString("base64");
      bytes = encodePackageBundle(f.bundle);
      f.release.update.size = bytes.length;
      f.release.update.sha256 = createHash("sha256").update(bytes).digest("hex");
    }
    f.updater.start(f.release);
    await f.updater.wait();
    assert.equal(f.updater.status().phase, "error", kind);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.rootDir, "package.json"))).version, "1.0.0", kind);
    assert.equal(readPackageJournal(f.rootDir), null, kind);
  }
});

test("更新包拒绝路径穿越、Windows 别名、大小写碰撞、缺文件与版本伪装", (t) => {
  const f = fixture(t);
  for (const rel of ["../outside", "work/monitor/../outside", "work/monitor/C:evil", "work/monitor/a\\b", "work/monitor/con.txt", "work/monitor/a."]) {
    const bad = structuredClone(f.bundle);
    bad.files.push({ path: rel, data: "" });
    assert.throws(() => decodePackageBundle(gzipSync(JSON.stringify(bad))), /路径/);
  }
  const duplicate = structuredClone(f.bundle);
  duplicate.files.push({ ...duplicate.files[0], path: duplicate.files[0].path.toUpperCase() });
  assert.throws(() => decodePackageBundle(gzipSync(JSON.stringify(duplicate))));
  const missing = structuredClone(f.bundle);
  missing.files.shift();
  assert.throws(() => encodePackageBundle(missing), /缺少/);
});
