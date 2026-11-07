// 磁盘增长归因：从作业登记推出「集合目录」（纯函数，无 IO）。
//
// 集合目录 = 一批作业各自往里写一个子目录的那一层。例：批次都落在 ~/Digital_twin/GNN/outputs/<批次>/…，
// 实验都落在 ~/Digital_twin/GNN/training_wss_min/experiments/<实验>/…——量这两层的每个直接子目录，
// 就知道磁盘是哪个批次 / 哪个实验写满的。
//
// 推导：
//   1. 每个登记作业取一个「输出目录」：StdOut 所在目录（相对路径以 WorkDir 为基准）；没有 StdOut 用 WorkDir。
//      目录里的占位符（%x %u %j %A %a）按登记条目展开；展开不了的那一段及其之后截掉。
//   2. 只认 $HOME 下的路径（homes：家目录的物理路径，以及与它不同时的 $HOME 原值——作业脚本里两种写法都有），
//      换成相对 $HOME 的路径建前缀树。别处的路径一律忽略：不量别人的目录，也量不了（扫描器只进 $HOME）。
//   3. 自顶向下找：一个目录有 ≥ 3 个子目录各自含登记作业，它就是集合目录，不再往下看
//      （所以取到的是 outputs，而不是更深的 units/AD）。$HOME 自己不算——那等于扫整个家目录。
//   4. 按含的作业数取前 4 个。
import path from "node:path";

import { isValidRelPath } from "../dir-usage/scan.mjs";
import { expandLogTemplate } from "../jobs/log-paths.mjs";

export const COLLECTION_WINDOW_MS = 14 * 24 * 3600_000;
export const COLLECTION_MIN_CHILDREN = 3;
export const COLLECTION_MAX = 4;
// 与目录占用的扫描根同一上限（lib/dir-usage/service.mjs）。
const ROOT_MAX_LENGTH = 1024;
const DEPTH_MAX = 32;
const NUMERIC_ID_RE = /^\d{1,12}$/;

// 绝对路径 → 规整后的绝对路径（去掉 . / .. / 重复的斜杠与结尾的斜杠）；不是绝对路径 → null。
function absolute(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const normal = path.posix.normalize(value);
  return normal.length > 1 && normal.endsWith("/") ? normal.slice(0, -1) : normal;
}

// 登记条目 → 这个作业的输出目录（绝对路径）；推不出来 → null。
export function jobOutputDir(entry) {
  const workDir = absolute(entry?.workDir);
  const template = typeof entry?.stdout === "string" && entry.stdout ? entry.stdout : null;
  if (!template) return workDir;
  const full = template.startsWith("/") ? template : workDir ? `${workDir}/${template}` : null;
  if (!full) return null;
  let dir = full.slice(0, Math.max(1, full.lastIndexOf("/")));
  // 排队中的数组整体（48213_[1-10]）不知道任务号与实际作业号：不展开，下面在占位符处截断。
  // 它的各个任务运行起来后会各自登记一条（jobId 是实际编号），到时按那几条算。
  if (NUMERIC_ID_RE.test(String(entry.jobId ?? ""))) {
    dir = expandLogTemplate(dir, { raw: entry.jobId, arr: entry.arrayJobId, task: entry.arrayTaskId, name: entry.name, user: entry.user }) || dir;
  }
  const kept = [];
  for (const part of dir.split("/")) {
    if (part.includes("%")) break;
    kept.push(part);
  }
  return absolute(kept.join("/") || "/");
}

// 绝对路径 → 相对 $HOME 的路径（'' = 家目录本身）；不在任何一个 home 下 → null。
export function relativeToHome(dir, homes) {
  for (const home of Array.isArray(homes) ? homes : []) {
    if (typeof home !== "string" || home.length < 2 || !home.startsWith("/")) continue;
    if (dir === home) return "";
    if (dir.startsWith(`${home}/`)) {
      const rel = dir.slice(home.length + 1);
      return isValidRelPath(rel, ROOT_MAX_LENGTH) ? rel : null;
    }
  }
  return null;
}

// entries：登记表里一台服务器的条目（registry.list(serverId)）。
// 返回 [{ root, jobs, children }]：root 相对 $HOME；jobs = 这棵子树里的登记作业数；children = 含作业的直接子目录数。
export function deriveCollectionDirs(entries, {
  homes = [],
  nowMs = Date.now(),
  windowMs = COLLECTION_WINDOW_MS,
  minChildren = COLLECTION_MIN_CHILDREN,
  limit = COLLECTION_MAX,
} = {}) {
  const tree = { jobs: 0, children: new Map() };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !Number.isFinite(entry.lastSeenAt) || nowMs - entry.lastSeenAt > windowMs) continue;
    const dir = jobOutputDir(entry);
    const rel = dir ? relativeToHome(dir, homes) : null;
    if (rel == null) continue;
    const parts = rel === "" ? [] : rel.split("/");
    if (parts.length > DEPTH_MAX) continue;
    let node = tree;
    node.jobs += 1;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next) {
        next = { jobs: 0, children: new Map() };
        node.children.set(part, next);
      }
      next.jobs += 1;
      node = next;
    }
  }
  // 前缀树里的每个节点都是沿某个作业的输出目录建出来的，所以「子目录含登记作业」就是「有这个子节点」。
  // 若某外层目录（如 Digital_twin）仅因少量临时/worktree 子目录凑够 minChildren，但 >= 85% 的作业都集中在
  // 单一主导子目录（如 Digital_twin/GNN），且子树内能推出分叉数更宽（children > 当前节点）的集合目录（如 GNN/outputs），
  // 则穿过该外层容器目录继续下钻，避免把整棵项目根目录当成集合目录。
  const DOMINANT_CHILD_SHARE = 0.85;
  const collect = (node, parts) => {
    if (parts.length && node.children.size >= minChildren) {
      for (const child of node.children.values()) {
        if (child.jobs >= node.jobs * DOMINANT_CHILD_SHARE) {
          const deeper = [];
          for (const [n, c] of node.children) deeper.push(...collect(c, [...parts, n]));
          if (deeper.some((item) => item.children > node.children.size)) return deeper;
          break;
        }
      }
      return [{ root: parts.join("/"), jobs: node.jobs, children: node.children.size }];
    }
    const res = [];
    for (const [name, child] of node.children) res.push(...collect(child, [...parts, name]));
    return res;
  };
  const found = collect(tree, []);
  return found
    .sort((a, b) => b.jobs - a.jobs || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0))
    .slice(0, Math.max(0, limit));
}
