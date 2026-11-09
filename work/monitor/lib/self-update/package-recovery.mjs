// 安装包热更新的固定引导协议。此文件与 electron-bootstrap.mjs 不经热更新替换；
// 先恢复中断的文件事务，再加载主进程，避免半套新文件令应用无法启动。
import fs from "node:fs";
import path from "node:path";

export const PACKAGE_UPDATE_DIR = ".cwb-update";
export const PACKAGE_APP_NAME = "Codex Tunnel Operations Console";
export const PACKAGE_RELAUNCH_ENV = "CODEX_CONSOLE_RELAUNCHED_AT";
export const FIXED_BOOT_FILES = Object.freeze(["electron-bootstrap.mjs", "work/monitor/lib/self-update/package-recovery.mjs"]);

export function isPackageFile(rel) {
  return typeof rel === "string" && rel.length < 240
    && !/[\\:*?"<>|]/.test(rel) && ![...rel].some((c) => c.charCodeAt(0) < 32)
    && !rel.split("/").some((p) => !p || p === "." || p === ".." || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
    && (["electron-bootstrap.mjs", "electron-main.mjs", "preload.js", "package.json", "config.json", "build-info.json"].includes(rel)
      || rel === "work/local_http_connect_proxy.mjs" || rel.startsWith("work/monitor/"))
    && !rel.split("/").some((p) => p === "runtime" || p === ".git" || p === "node_modules" || p.endsWith(".test.mjs"));
}

export function readPackageJournal(rootDir) {
  const base = path.join(rootDir, PACKAGE_UPDATE_DIR);
  for (const rel of [base, path.join(base, "backup"), path.join(base, "journal.json")]) {
    try {
      if (fs.lstatSync(rel).isSymbolicLink()) throw new Error("更新恢复路径不能是链接");
    } catch (err) { if (err.code !== "ENOENT") throw err; }
  }
  const file = path.join(base, "journal.json");
  if (!fs.existsSync(file)) return null;
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!["applying", "pending"].includes(journal.phase) || !Array.isArray(journal.files) || journal.files.length > 5000
    || journal.files.some((f) => !isPackageFile(f.path) || FIXED_BOOT_FILES.includes(f.path) || f.path === "config.json" || typeof f.existed !== "boolean")) {
    throw new Error("更新恢复记录无效，请重新安装完整安装包（个人配置保留）");
  }
  return journal;
}

// 根及路径分量不接受符号链接 / Windows junction，备份与写入不越过安装目录。
export function assertPackagePath(rootDir, rel) {
  if (!isPackageFile(rel)) throw new Error(`更新文件路径无效：${rel}`);
  let current = rootDir;
  for (const part of ["", ...rel.split("/")]) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`更新路径不能是链接：${rel}`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return path.join(rootDir, rel);
}

export function recoverPackageUpdate(rootDir, { includePending = false } = {}) {
  const journal = readPackageJournal(rootDir);
  if (!journal || (journal.phase === "pending" && !includePending)) return false;
  const base = path.join(rootDir, PACKAGE_UPDATE_DIR);
  for (const file of journal.files) {
    const target = assertPackagePath(rootDir, file.path);
    if (file.existed) {
      const source = assertPackagePath(path.join(base, "backup"), file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    } else {
      fs.rmSync(target, { force: true });
    }
  }
  fs.rmSync(path.join(base, "journal.json"));
  fs.rmSync(path.join(base, "boot-attempt"), { force: true });
  return true;
}

export function confirmPackageUpdate(rootDir) {
  if (readPackageJournal(rootDir)?.phase !== "pending") return;
  const base = path.join(rootDir, PACKAGE_UPDATE_DIR);
  fs.rmSync(path.join(base, "journal.json"));
  fs.rmSync(path.join(base, "boot-attempt"), { force: true });
  // 保留一份旧文件备份，下次更新才替换；不会随版本无限增长。
}

export function beginPackageBoot(rootDir) {
  recoverPackageUpdate(rootDir);
  if (!readPackageJournal(rootDir)) return false;
  const marker = path.join(rootDir, PACKAGE_UPDATE_DIR, "boot-attempt");
  if (fs.existsSync(marker)) {
    recoverPackageUpdate(rootDir, { includePending: true });
    return false;
  }
  fs.writeFileSync(marker, "pending\n", { flag: "wx", mode: 0o600 });
  return true;
}
