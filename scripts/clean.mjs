// 磁盘清理：回收可再生的构建/运行产物。
//
// 背景：本仓库入库内容仅约 5MB（无大二进制，全部产物都在 .gitignore 内），但工作目录
// 会长到 3GB 量级——work/codex-cli-offline-build（CLI 离线构建目录，含最终离线包）、
// dist/staging（热更新旁路构建残留）、dist/claude-cli-*/ 与各类 *-offline.tar.gz（离线包）。
//
// 用法：
//   node scripts/clean.mjs --dry-run    只列出将删除什么、能回收多少，不删除
//   node scripts/clean.mjs              删除"安全集"（确定的中间产物与运行日志），删除前确认
//   node scripts/clean.mjs --all        额外删除可重新生成、但重建成本高的离线包产物
//   --yes                               跳过确认（非交互环境必须显式给出）
//   npm run clean:dry / npm run clean / npm run clean -- --all
//
// 绝不动：node-offline/（Linux 离线安装手册用到的 Node 运行时包）、node_modules/、.git/、config.json、
// config.local.json、work/runtime/（由 storage-sweeper 按预算管理）、
// dist/Codex Operations Console.app（旧流程留下的暂存包，现役 .app 在仓库根；删不删由人决定）、
// dist/checksums-*.txt（发布资产）、
// dist/backup/（热更新后数据面可能仍在执行备份里的旧二进制：修剪由 scripts/hot-update/bundle.mjs 的
// pruneBackups 负责，它会用 lsof 跳过仍在运行的备份，查询失败时整次放弃；这里无法做得更安全）、
// work/channel-supervisor.pid（旧版遗留，现已无读写方；不纳入安全集，留给人工处理）。
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./lib/is-main.mjs";
import { confirmYes } from "./lib/prompt.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

// dist/staging 下的条目只有超过这个时长才算残留：更新的可能正被一次进行中的
// `npm run app:update` 使用（构建 → 冒烟 → rename 换包之间）。
export const STAGING_MIN_AGE_MS = 60 * 60 * 1000;

// lstat 而不是 stat：.app 里的 framework 符号链接会被重复计入，循环链接会让遍历卡死。
function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let st;
    try {
      st = lstatSync(current, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (!st) continue;
    if (st.isDirectory()) {
      let entries = [];
      try {
        entries = readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) stack.push(path.join(current, entry));
    } else {
      total += st.size;
    }
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function globTop(rootDir, prefix, { dirsOnly = false, suffix = "" } = {}) {
  const base = path.dirname(path.join(rootDir, prefix));
  const name = path.basename(prefix);
  if (!existsSync(base)) return [];
  let entries = [];
  try {
    entries = readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.name.startsWith(name))
    .filter((entry) => (dirsOnly ? entry.isDirectory() : true))
    .filter((entry) => (suffix ? entry.name.endsWith(suffix) : true))
    .map((entry) => path.join(base, entry.name));
}

// dist/staging 中足够旧的条目（失败或中断的热更新留下的旁路构建）。
function staleStaging(rootDir, now) {
  const stagingRoot = path.join(rootDir, "dist", "staging");
  if (!existsSync(stagingRoot)) return [];
  let entries = [];
  try {
    entries = readdirSync(stagingRoot);
  } catch {
    return [];
  }
  return entries
    .map((name) => path.join(stagingRoot, name))
    .filter((full) => {
      try {
        return now - lstatSync(full).mtimeMs >= STAGING_MIN_AGE_MS;
      } catch {
        return false;
      }
    });
}

// 纯目标收集（不删除）：rootDir / now 可注入，供测试在临时目录里验证分级与越界防护。
export function collectTargets({ all = false, rootDir = DEFAULT_ROOT, now = Date.now() } = {}) {
  const targets = [
    ...globTop(rootDir, "work/channel-supervisor.log"),
    path.join(rootDir, ".playwright-mcp"),
    ...staleStaging(rootDir, now),
  ];
  if (all) {
    targets.push(
      // CLI 离线构建目录：除中间产物外还放着最终的 codex-cli-linux-offline-*.tar.gz 与 npm 包，
      // 重建需经代理重新下载，所以不进默认安全集。
      path.join(rootDir, "work", "codex-cli-offline-build"),
      ...globTop(rootDir, "dist/claude-cli-", { dirsOnly: true }),
      ...globTop(rootDir, "dist/reclaude-linux-offline-latest-amd64.tar.gz"),
      ...globTop(rootDir, "dist/claude-cli-", { suffix: ".tar.gz" }),
      ...globTop(rootDir, "dist/claude-cli-", { suffix: ".tar.gz.sha256" }),
      ...globTop(rootDir, "codex-offline-", { dirsOnly: true }),
      ...globTop(rootDir, "codex-offline-", { suffix: ".tar.gz" }),
    );
  }
  // 去重 + 只保留存在的项；并做越界防护：目标必须位于仓库根目录之下。
  const root = path.resolve(rootDir);
  const seen = new Set();
  const result = [];
  for (const target of targets) {
    const resolved = path.resolve(target);
    if (resolved === root || !resolved.startsWith(root + path.sep)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (existsSync(resolved)) result.push(resolved);
  }
  return result;
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const all = argv.includes("--all");
  const yes = argv.includes("--yes");
  const rootDir = DEFAULT_ROOT;
  const targets = collectTargets({ all, rootDir });

  if (targets.length === 0) {
    console.log("没有需要清理的产物。");
    return;
  }

  let total = 0;
  const rows = [];
  for (const target of targets) {
    const size = dirSize(target);
    total += size;
    rows.push({ target, size });
  }
  rows.sort((a, b) => b.size - a.size);
  for (const { target, size } of rows) {
    console.log(`${dryRun ? "[dry-run] " : ""}${formatBytes(size).padStart(9)}  ${path.relative(rootDir, target)}`);
  }

  if (dryRun) {
    console.log(`\n共可回收 ${formatBytes(total)}（未删除）。去掉 --dry-run 即执行。`);
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.error("\n非交互环境不会直接删除；确认无误后加 --yes 重新运行。");
      process.exitCode = 1;
      return;
    }
    if (!(await confirmYes(`\n删除以上 ${rows.length} 项（${formatBytes(total)}），不可恢复。确认？[y/N] `))) {
      console.log("已取消，未删除任何文件。");
      return;
    }
  }
  for (const { target } of rows) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      console.error(`删除失败 ${path.relative(rootDir, target)}: ${error.message}`);
    }
  }
  console.log(`\n已回收 ${formatBytes(total)}${all ? "" : "（离线包产物需加 --all）"}。`);
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
