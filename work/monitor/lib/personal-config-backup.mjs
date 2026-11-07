// 个人配置 config.local.json 的写前备份（v2.64）：保留最近 5 份带时间戳的备份。
//
// 放在哪：个人配置所在目录下的 config-backups/（打包的 App 是数据目录，源码运行是仓库根，测试 / fixture 跟着
// 注入的个人配置路径走）。不放数据目录已有的 backups/：那里还有别的东西，按「只留 5 份」清理时不该碰别人的文件；
// 放在被备份文件旁边也最好找。目录 0700、文件 0600。
//
// 文件名：config.local.<北京时间 YYYYMMDD-HHMMSS>.json（同一秒撞名加 -2、-3 …），按名字排序就是时间顺序。
// 规则：
//   - 个人配置还不存在（第一次保存）不备份；
//   - 内容与最新一份备份逐字节相同就不再备份——保存被校验 / 版本冲突拒绝后重试、或连续保存同样的内容，
//     都不会把更早的备份挤掉；备份记录的是「每一个曾经存在过的不同版本」里最近的 5 个；
//   - 备份失败（磁盘满、权限）不挡住写入，返回 null（与 config-loader 原来那份单个 .bak 一样）。
//   - 只用调用方给的 fs（测试注入的假 fs 缺方法时直接不备份），绝不退回真实磁盘。
//
// 谁来调：控制面写个人配置的入口 personal-config-write.writePersonalConfig（设置页、服务器管理、出网、登录引导、
// 命令行向导都经它）与配置导入。config-loader.writePersonalConfig 自己仍留单份 `.bak`：那个文件在 supervisor /
// 本机代理的热更新指纹闭包里，不为这里去改它，两者并存。切换活跃服务器 / 模块开关这类单字段写入不备份（以前也没有）。
import * as nodeFs from "node:fs";
import path from "node:path";

import { writePrivateFileAtomicSync } from "./atomic-file.mjs";
import { corruptStamp as beijingStamp } from "./corrupt-archive.mjs";

export const PERSONAL_BACKUP_DIR = "config-backups";
export const PERSONAL_BACKUP_KEEP = 5;

const STAMP_RE = /^\d{8}-\d{6}(?:-\d{1,4})?$/;

export function personalBackupDir(localConfigPath) {
  return path.join(path.dirname(localConfigPath), PERSONAL_BACKUP_DIR);
}

// config.local.json → ["config.local.", ".json"]；没有 .json 后缀的 → ["名字.", ""]。
function nameParts(localConfigPath) {
  const base = path.basename(localConfigPath);
  return base.endsWith(".json") ? [`${base.slice(0, -".json".length)}.`, ".json"] : [`${base}.`, ""];
}

// 纯函数：目录里属于这份配置的备份名，旧 → 新。
export function sortBackupNames(localConfigPath, names) {
  const [prefix, suffix] = nameParts(localConfigPath);
  const key = (name) => {
    const stamp = name.slice(prefix.length, name.length - suffix.length);
    const [main, seq] = [stamp.slice(0, 15), Number(stamp.slice(16)) || 1];
    return { main, seq };
  };
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && STAMP_RE.test(name.slice(prefix.length, name.length - suffix.length)))
    .sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return ka.main < kb.main ? -1 : ka.main > kb.main ? 1 : ka.seq - kb.seq;
    });
}

// 现有备份（新 → 旧）：[{ name, path, stamp, size, mtimeMs }]。目录不存在 → []。
export function listPersonalBackups(localConfigPath, { fs = nodeFs } = {}) {
  const dir = personalBackupDir(localConfigPath);
  let names = [];
  try { names = fs.readdirSync(dir).map(String); } catch { return []; }
  const [prefix, suffix] = nameParts(localConfigPath);
  return sortBackupNames(localConfigPath, names).reverse().map((name) => {
    const full = path.join(dir, name);
    let info = null;
    try { info = fs.statSync(full); } catch {}
    return { name, path: full, stamp: name.slice(prefix.length, name.length - suffix.length), size: info ? Number(info.size) || 0 : null, mtimeMs: info ? Number(info.mtimeMs) || 0 : null };
  });
}

// 写前调用：把现在的个人配置存一份。→ { name, path, removed } | null（没备份：文件不存在 / 与最新一份相同 / 失败）。
export function backupPersonalConfig(localConfigPath, { fs = nodeFs, now = Date.now, keep = PERSONAL_BACKUP_KEEP, log = () => {} } = {}) {
  let current;
  try {
    current = fs.readFileSync(localConfigPath);
  } catch {
    return null; // 不存在（第一次保存）或读不出：没有可备份的
  }
  const dir = personalBackupDir(localConfigPath);
  try {
    const names = (() => { try { return fs.readdirSync(dir).map(String); } catch { return []; } })();
    const ordered = sortBackupNames(localConfigPath, names);
    const newest = ordered.at(-1);
    if (newest) {
      try {
        if (Buffer.compare(Buffer.from(fs.readFileSync(path.join(dir, newest))), Buffer.from(current)) === 0) return null;
      } catch {}
    }
    const [prefix, suffix] = nameParts(localConfigPath);
    const stamp = beijingStamp(now());
    let name = `${prefix}${stamp}${suffix}`;
    for (let n = 2; names.includes(name); n += 1) name = `${prefix}${stamp}-${n}${suffix}`;
    const target = path.join(dir, name);
    writePrivateFileAtomicSync(target, current, { fs, now });
    const removed = [];
    const all = sortBackupNames(localConfigPath, [...names, name]);
    for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) {
      try {
        fs.unlinkSync(path.join(dir, old));
        removed.push(old);
      } catch {}
    }
    return { name, path: target, removed };
  } catch (error) {
    try { log(`个人配置写前备份失败（${error?.code || "error"}），照常保存`, { level: "warn", event: "personal-config-backup" }); } catch {}
    return null;
  }
}
