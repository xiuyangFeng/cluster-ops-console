// Windows 安装版的小包更新：下载校验 → 隔离自检 → 备份事务 → 沿用现有控制面重启。
// 原 exe 与数据面进程不替换；固定引导在下次启动时恢复中断事务。
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { fetchBuffer } from "../cli/net.mjs";
import { isDataPlaneUpgradeInFlight, removeUpgradeMarker, writeUpgradeMarker } from "../upgrade-marker.mjs";
import { decodePackageBundle, MAX_PACKAGE_BYTES, packageAssetName } from "./package-bundle.mjs";
import { assertPackagePath, FIXED_BOOT_FILES, isPackageFile, PACKAGE_UPDATE_DIR, readPackageJournal, recoverPackageUpdate } from "./package-recovery.mjs";
import { isNewerVersion } from "./release-check.mjs";
import { smokeSourceTree } from "./smoke.mjs";

const fail = (message, code = "package-update-failed") => Object.assign(new Error(message), { status: 409, code });

async function listFiles(dir, prefix = "") {
  const files = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== "runtime" && (rel === "work" || rel === "work/monitor" || rel.startsWith("work/monitor/"))) files.push(...await listFiles(path.join(dir, e.name), rel));
    } else if (isPackageFile(rel)) {
      if (e.isSymbolicLink()) throw fail(`更新路径不能是链接：${rel}`);
      files.push(rel);
    }
  }
  return files;
}

export function createPackageUpdater({
  rootDir, runtimeDir, repo, platform = process.platform, arch = process.arch,
  electronVersion = process.versions.electron, getUpstream = async () => null,
  fetchBytes = fetchBuffer, smoke = smokeSourceTree,
  writeAtomic = writeFileAtomic,
  upgrading = () => isDataPlaneUpgradeInFlight({ runtimeDir }),
  busy = () => false,
  log = () => {},
} = {}) {
  const supported = platform === "win32" && Boolean(electronVersion);
  let job = null;
  let task = null;
  let controller = null;
  const status = () => job ? { ...job } : null;

  async function install(release) {
    let stage = null;
    let transaction = false;
    let marked = false;
    const base = path.join(rootDir, PACKAGE_UPDATE_DIR);
    const phase = (value) => { job.phase = value; };
    try {
      if (upgrading() || busy()) throw fail("后台正在执行操作，请完成后再更新工作台");
      if (readPackageJournal(rootDir)) throw fail("上次更新已就绪，请先重启工作台");
      const pkg = JSON.parse(await fsp.readFile(path.join(rootDir, "package.json"), "utf8"));
      job.fromVersion = pkg.version;
      if (!isNewerVersion(release.version, pkg.version)) throw fail("目标版本没有比当前版本更新");
      const asset = release.update;
      const expected = `https://github.com/${repo}/releases/download/v${release.version}/${packageAssetName(release.version, arch)}`;
      if (!asset || asset.url !== expected || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE_BYTES) throw fail("发布版本没有可校验的更新包，请下载完整安装包");
      phase("download");
      const bytes = await fetchBytes(asset.url, { maxBytes: MAX_PACKAGE_BYTES, upstream: await getUpstream(), signal: controller.signal });
      if (bytes.length !== asset.size || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw fail("更新包 SHA-256 校验失败，当前版本未改动");
      phase("verify");
      const bundle = decodePackageBundle(bytes);
      if (bundle.version !== release.version || bundle.platform !== `win32-${arch}`) throw fail("更新包版本或架构不匹配");
      if (bundle.electron !== electronVersion) throw fail("此版本升级了底层运行时，请下载完整安装包", "runtime-upgrade-required");
      for (const rel of FIXED_BOOT_FILES) {
        const entry = bundle.files.find((f) => f.path === rel);
        if (!(await fsp.readFile(assertPackagePath(rootDir, rel))).equals(Buffer.from(entry.data, "base64"))) throw fail("此版本升级了更新引导，请下载完整安装包", "runtime-upgrade-required");
      }
      stage = await fsp.mkdtemp(path.join(os.tmpdir(), "cwb-package-stage-"));
      for (const file of bundle.files) {
        const target = assertPackagePath(stage, file.path);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, Buffer.from(file.data, "base64"));
      }
      // 团队配置由安装者管理，既不覆盖，也不让自检触碰真实用户数据。
      await fsp.copyFile(path.join(rootDir, "config.json"), path.join(stage, "config.json"));
      phase("smoke");
      const tested = await smoke(stage);
      if (!tested.ok) throw fail(`新版本自检未通过，当前版本未改动：${tested.detail}`);
      if (controller.signal.aborted) throw fail("更新已停止");
      phase("backup");
      if (upgrading() || busy()) throw fail("后台正在执行操作，请完成后再更新工作台");
      // 这一拍开始互斥：阻止中途重启控制面，文件事务结束后立即解除。
      marked = writeUpgradeMarker({ runtimeDir, components: ["app"] });
      // 安装目录下只保留一份备份，个人配置与 runtime 不在该事务中。
      try {
        if ((await fsp.lstat(base)).isSymbolicLink()) throw fail("更新备份目录不能是链接");
      } catch (err) { if (err.code !== "ENOENT") throw err; }
      await fsp.rm(base, { recursive: true, force: true });
      const next = new Set(bundle.files.map((f) => f.path));
      const paths = [...new Set([...next, ...await listFiles(rootDir)])].filter((p) => p !== "config.json" && !FIXED_BOOT_FILES.includes(p));
      const files = [];
      for (const rel of paths) {
        const source = assertPackagePath(rootDir, rel);
        let existed = false;
        try { existed = (await fsp.stat(source)).isFile(); } catch (err) { if (err.code !== "ENOENT") throw err; }
        if (existed) {
          const dest = path.join(base, "backup", rel);
          await fsp.mkdir(path.dirname(dest), { recursive: true });
          await fsp.copyFile(source, dest);
        }
        files.push({ path: rel, existed });
      }
      const journal = { phase: "applying", fromVersion: pkg.version, toVersion: bundle.version, files };
      await fsp.mkdir(base, { recursive: true });
      await writeAtomic(path.join(base, "journal.json"), JSON.stringify(journal));
      transaction = true;
      phase("install");
      // 构建标识最后写，避免界面在事务中途提示重启。
      paths.sort((a, b) => Number(a === "build-info.json") - Number(b === "build-info.json"));
      for (const rel of paths) {
        const target = assertPackagePath(rootDir, rel);
        if (next.has(rel)) {
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await writeAtomic(target, await fsp.readFile(path.join(stage, rel)));
        } else {
          await fsp.rm(target, { force: true });
        }
      }
      journal.phase = "pending";
      await writeAtomic(path.join(base, "journal.json"), JSON.stringify(journal));
      transaction = false;
      if (marked) { removeUpgradeMarker({ runtimeDir }); marked = false; }
      Object.assign(job, { running: false, ready: true, phase: "ready" });
      log(`package-update: v${pkg.version} -> v${bundle.version} ready`, { event: "self-update" });
    } catch (err) {
      if (transaction) recoverPackageUpdate(rootDir, { includePending: true });
      Object.assign(job, { running: false, ready: false, phase: "error", error: String(err.message || err).slice(0, 500) });
      log(`package-update failed: ${job.error}`, { event: "self-update", level: "warn" });
    } finally {
      if (marked) removeUpgradeMarker({ runtimeDir });
      if (stage) await fsp.rm(stage, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      controller = null;
    }
  }

  function start(release) {
    if (!supported) throw fail("当前安装方式不支持热更新");
    if (job?.running || job?.ready) throw fail("更新正在进行或等待重启");
    controller = new AbortController();
    job = { running: true, ready: false, phase: "download", toVersion: release.version, error: null };
    task = install(release).catch((err) => {
      Object.assign(job, { running: false, ready: false, phase: "error", error: `恢复失败，请重新安装：${err.message}` });
    });
    return { ok: true, pending: true, toVersion: release.version };
  }

  return { supported, start, status, wait: () => task, stop: () => controller?.abort() };
}
