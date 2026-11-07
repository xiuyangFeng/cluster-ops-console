// scripts/hot-update/bundle.mjs —— 包的原子换入/换回与备份修剪。
// 同卷 rename 不改 inode：正在运行的旧 supervisor/proxy 二进制在备份目录里继续有效，
// 所以修剪备份前必须用 lsof 确认没有进程仍在执行其中的二进制。
import path from "node:path";
import { exists } from "./layout.mjs";

export const BACKUP_KEEP = 2;

// lsof -Fn 输出：以 "n" 开头的行是文件路径。
export function parseLsofTxtPaths(stdout = "") {
  return String(stdout)
    .split("\n")
    .filter((line) => line.startsWith("n") && line.length > 1)
    .map((line) => line.slice(1));
}

function isUnder(filePath, dir) {
  return filePath === dir || filePath.startsWith(`${dir.replace(/\/+$/, "")}/`);
}

// 备份修剪决策（纯函数）：backups 已按新→旧排序；保留前 keep 份；其余若仍有进程在执行
// 其中的二进制（busyPaths 命中该目录）或在 protect 名单中则跳过。
export function selectPrunable(backups = [], { keep = BACKUP_KEEP, busyPaths = [], protect = [] } = {}) {
  const remove = [];
  const skippedBusy = [];
  backups.slice(keep).forEach((backup) => {
    const dirs = [backup.path, backup.realPath].filter(Boolean);
    if (protect.some((p) => dirs.includes(p))) return;
    if (busyPaths.some((p) => dirs.some((d) => isUnder(p, d)))) {
      skippedBusy.push(backup);
      return;
    }
    remove.push(backup);
  });
  return { remove, skippedBusy };
}

export async function listBackups(ctx, layout) {
  let names = [];
  try {
    names = await ctx.fs.readdir(layout.backupRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const p = path.join(layout.backupRoot, name);
    try {
      const st = await ctx.fs.stat(p);
      if (!st.isDirectory()) continue;
      let realPath = p;
      try {
        realPath = await ctx.fs.realpath(p);
      } catch {}
      out.push({ name, path: p, realPath, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// 仍在执行的 .app 二进制路径（lsof txt 反映 rename 后的真实路径）。lsof 无匹配时退出码 1 且
// 无输出，视为"没人占用"；其他失败返回 null，调用方据此放弃修剪（宁可多留不可误删）。
async function busyExecutablePaths(ctx) {
  const res = await ctx.run("lsof", ["-a", "-d", "txt", "-c", "Codex", "-Fn"]);
  if (res.code === 0) return parseLsofTxtPaths(res.stdout);
  if (res.code === 1 && !String(res.stdout || "").trim()) return [];
  return null;
}

export async function pruneBackups(ctx, layout, { keep = BACKUP_KEEP, protect = [] } = {}) {
  const backups = await listBackups(ctx, layout);
  if (backups.length <= keep) return { removed: [], skippedBusy: [] };
  const busyPaths = await busyExecutablePaths(ctx);
  if (busyPaths === null) {
    ctx.log("  ! lsof 查询失败，本次不修剪备份（避免删掉仍在运行的旧二进制）");
    return { removed: [], skippedBusy: [], aborted: true };
  }
  const { remove, skippedBusy } = selectPrunable(backups, { keep, busyPaths, protect });
  for (const b of skippedBusy) ctx.log(`  - 保留 ${b.name}：仍有进程在执行其中的二进制（旧 supervisor/proxy）`);
  for (const b of remove) {
    ctx.log(`  - 删除旧备份 ${b.name}`);
    await ctx.fs.rm(b.path);
  }
  return { removed: remove.map((b) => b.name), skippedBusy: skippedBusy.map((b) => b.name) };
}

export async function uniqueDir(ctx, base) {
  let candidate = base;
  for (let i = 1; await exists(ctx, candidate); i += 1) candidate = `${base}-${i}`;
  return candidate;
}

async function assertSameVolume(ctx, a, b) {
  const [sa, sb] = await Promise.all([ctx.fs.stat(a), ctx.fs.stat(b)]);
  if (sa.dev !== sb.dev) throw new Error(`${a} 与 ${b} 不在同一卷上，无法原子 rename`);
}

// 原子换包：live → backupDir，incoming → live；第二步失败立即把 backupDir 换回 live。
export async function swapIn(ctx, layout, { incoming, backupDir }) {
  await ctx.fs.mkdir(layout.backupRoot);
  const hadLive = await exists(ctx, layout.appDir);
  await assertSameVolume(ctx, path.dirname(incoming), layout.backupRoot);
  if (hadLive) await assertSameVolume(ctx, layout.appDir, layout.backupRoot);
  if (hadLive) await ctx.fs.rename(layout.appDir, backupDir);
  try {
    await ctx.fs.rename(incoming, layout.appDir);
  } catch (err) {
    if (hadLive) await ctx.fs.rename(backupDir, layout.appDir);
    throw err;
  }
  return { hadLive, backupDir: hadLive ? backupDir : null, incoming };
}

// 反向换包：live（新包）→ parkDir，backupDir → live。
// 第二步失败必须把 parkDir 换回 live：否则 appDir 位置变空，用户既没有新包也没有旧包，
// 桌面上只剩一个打不开的 .app（内容已经躺在 parkDir 里）——比"换回失败"严重得多。
// swapIn 一直有这个回滚，swapBack 之前漏了。
export async function swapBack(ctx, layout, swap, parkDir) {
  if (!swap.backupDir) throw new Error("没有旧包可换回（首次安装）");
  await ctx.fs.mkdir(path.dirname(parkDir));
  await ctx.fs.rename(layout.appDir, parkDir);
  try {
    await ctx.fs.rename(swap.backupDir, layout.appDir);
  } catch (err) {
    try {
      await ctx.fs.rename(parkDir, layout.appDir);
    } catch (rollbackError) {
      // 回滚也失败：把两个包的实际位置写进错误里，否则现场无从恢复。
      throw new Error(
        `换回旧包失败，且把新包放回原位也失败：新包在 ${parkDir}，旧包在 ${swap.backupDir}；` +
          `原始错误：${err.message}；回滚错误：${rollbackError.message}`,
      );
    }
    throw err;
  }
}
