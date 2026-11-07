// 本人目录占用：多轮扫描结果的累加与视图组装（纯函数，无 IO）。
//
// 口径（界面文案同此）：
//   - 每轮远端只回传本轮增量；同一扫描根的各轮按条目恰好处理一次累加（续扫从游标处接着走）。
//   - 「实际占用」= st_blocks × 512（稀疏文件 / 压缩可让它小于逻辑大小）；「逻辑大小」= 文件长度之和。
//   - 未扫完时所有数字只代表「已扫描部分」，不是目录总量，更不是个人配额（这台集群没有配额工具）。
//   - 硬链接只在单轮内去重；扫描期间目录有改动时，续扫可能有少量重复或遗漏。
import { AGG1_CAP, AGG2_CAP, TOP_N } from "./scan.mjs";

export const DIR_USAGE_SCHEMA_VERSION = 1;
const VIEW_CHILDREN = 60;
const VIEW_SUB = 8;
const VIEW_TOP_FILES = 20;
const OTHER_FS_CAP = 20;

const addInto = (target, source) => {
  for (let i = 0; i < target.length; i += 1) target[i] += source[i] || 0;
  return target;
};

export function emptyDirUsageRecord({ root = "", home = null, now = Date.now() } = {}) {
  return {
    root,
    home,
    startedAt: now,
    updatedAt: now,
    runs: 0,
    complete: false,
    stop: null,
    entries: 0,
    dirsDone: 0,
    denied: 0,
    errors: 0,
    otherFs: 0,
    otherFsNames: [],
    dropped: 0,
    hardlinks: 0,
    agg1: {},
    agg1Over: [0, 0, 0, 0],
    agg2: {},
    rootFiles: [0, 0, 0],
    top: [],
    pending: [],
    lastRun: null,
  };
}

// prev 为空或扫描根不同 → 从新记录开始（重新扫描 / 换目录）。
export function mergeDirUsageRun(prev, run, { now = Date.now() } = {}) {
  const base = prev && prev.root === run.root
    ? structuredClone(prev)
    : emptyDirUsageRecord({ root: run.root, home: run.home, now });
  base.home = run.home || base.home;
  base.updatedAt = now;
  base.runs += 1;
  base.complete = run.complete;
  base.stop = run.stop;
  for (const key of ["entries", "dirsDone", "denied", "errors", "otherFs", "dropped", "hardlinks"]) base[key] += run[key] || 0;
  base.otherFsNames = [...new Set([...base.otherFsNames, ...run.otherFsNames])].slice(0, OTHER_FS_CAP);
  for (const [key, value] of Object.entries(run.agg1)) {
    if (base.agg1[key]) addInto(base.agg1[key], value);
    else if (Object.keys(base.agg1).length < AGG1_CAP) base.agg1[key] = [...value];
    else addInto(base.agg1Over, value);
  }
  addInto(base.agg1Over, run.agg1Over);
  for (const [key, value] of Object.entries(run.agg2)) {
    // 第二层放不下的新键只是不单列：它的量已经计在第一层里（界面显示为「其余」）。
    if (base.agg2[key]) addInto(base.agg2[key], value);
    else if (Object.keys(base.agg2).length < AGG2_CAP) base.agg2[key] = [...value];
  }
  addInto(base.rootFiles, run.rootFiles);
  const byPath = new Map(base.top.map((f) => [f.path, f]));
  for (const f of run.top) {
    const old = byPath.get(f.path);
    if (!old || f.blocks >= old.blocks) byPath.set(f.path, f);
  }
  base.top = [...byPath.values()].sort((a, b) => b.blocks - a.blocks || a.path.localeCompare(b.path)).slice(0, TOP_N);
  base.pending = run.pending;
  base.lastRun = { at: now, sec: run.sec, entries: run.entries, stop: run.stop };
  return base;
}

// 相对 $HOME 的显示名：'' → ~，其余 → ~/rel。
export function rootLabel(root) {
  return root ? `~/${root}` : "~";
}

export function joinRel(root, name) {
  return root ? `${root}/${name}` : name;
}

export function parentRel(root) {
  if (!root) return null;
  const i = root.lastIndexOf("/");
  return i < 0 ? "" : root.slice(0, i);
}

const item = ([blocks, size, files, dirs]) => ({ blocks, size, files, dirs });
const byBlocks = (a, b) => b.blocks - a.blocks || a.name.localeCompare(b.name);

export const HIGH_FILE_COUNT_THRESHOLD = 50000;

const KNOWN_CACHE_SPECS = [
  { rel: ".cache/huggingface", label: "HuggingFace 模型与数据集缓存", hint: "可用 hf cache 或手工清理不再使用的模型快照", cleanCmd: "huggingface-cli delete-cache" },
  { rel: ".cache/pip", label: "pip 轮子与源码包缓存", hint: "可用 pip cache purge 释放", cleanCmd: "pip cache purge" },
  { rel: ".cache/torch", label: "PyTorch 预训练权重与扩展缓存", hint: "清理后下次加载会自动重下或重编", cleanCmd: "rm -rf ~/.cache/torch/hub/checkpoints/*" },
  { rel: ".cache/uv", label: "uv 包缓存", hint: "可用 uv cache clean 释放", cleanCmd: "uv cache clean" },
  { rel: ".cache/wandb", label: "Weights & Biases 本地缓存", hint: "可用 wandb artifact cache cleanup 释放", cleanCmd: "wandb artifact cache cleanup 1GB" },
  { rel: ".conda", label: "Conda 环境与包缓存", hint: "可用 conda clean -a 清理未使用的包与压缩包", cleanCmd: "conda clean -a -y" },
  { rel: ".npm", label: "npm 缓存", hint: "可用 npm cache clean --force 释放", cleanCmd: "npm cache clean --force" },
  { rel: ".vscode-server", label: "VS Code 远端服务端与扩展", hint: "旧版本 commit 目录可清理", cleanCmd: "ls -dt ~/.vscode-server/bin/* | tail -n +3 | xargs rm -rf" },
  { rel: ".cursor-server", label: "Cursor 远端服务端与扩展", hint: "旧版本服务端目录可清理", cleanCmd: "ls -dt ~/.cursor-server/bin/* | tail -n +3 | xargs rm -rf" },
];

export function extractKnownCaches(record) {
  if (!record || record.root !== "") return [];
  const out = [];
  let matchedSubCacheBlocks = 0;
  for (const spec of KNOWN_CACHE_SPECS) {
    const raw = spec.rel.includes("/") ? record.agg2?.[spec.rel] : record.agg1?.[spec.rel];
    if (!raw || !(raw[0] > 0)) continue;
    if (spec.rel.startsWith(".cache/")) matchedSubCacheBlocks += raw[0];
    const parsed = item(raw);
    out.push({
      rel: spec.rel,
      label: spec.label,
      hint: spec.hint,
      cleanCmd: spec.cleanCmd || null,
      ...parsed,
      highFileDensity: parsed.files >= HIGH_FILE_COUNT_THRESHOLD,
    });
  }
  const cacheTop = record.agg1?.[".cache"];
  if (cacheTop && cacheTop[0] > 0 && matchedSubCacheBlocks === 0) {
    const parsed = item(cacheTop);
    out.push({
      rel: ".cache",
      label: "通用缓存目录 (~/.cache)",
      hint: "含 pip / HuggingFace / PyTorch 等工具缓存，可点「单独查看」下钻",
      cleanCmd: null,
      ...parsed,
      highFileDensity: parsed.files >= HIGH_FILE_COUNT_THRESHOLD,
    });
  }
  return out.sort((a, b) => b.blocks - a.blocks || a.rel.localeCompare(b.rel));
}

// 视图：第一层目录按实际占用排序（最多 60 个，其余并成一行），每个附最大的第二层子目录（最多 8 个）。
// partial 标注「这一项下面还有没扫到的目录」——它的数字只是已扫描部分；
// queued 是其中还没轮到的（游标里只有它自己、一条都没处理过），数字只是目录项本身的 4 KB。
export function buildDirUsageView(record) {
  if (!record) return null;
  const pendingTop = new Set();
  const startedTop = new Set();
  let rootPartial = false;
  for (const [rel, skip] of record.pending) {
    if (rel === "") rootPartial = true;
    else {
      const name = rel.split("/", 1)[0];
      pendingTop.add(name);
      if (rel !== name || skip > 0) startedTop.add(name);
    }
  }
  const subsByParent = new Map();
  for (const [key, value] of Object.entries(record.agg2)) {
    const [parent, name] = key.split("/");
    if (!subsByParent.has(parent)) subsByParent.set(parent, []);
    const parsed = item(value);
    subsByParent.get(parent).push({
      name,
      rel: joinRel(record.root, key),
      ...parsed,
      highFileDensity: parsed.files >= HIGH_FILE_COUNT_THRESHOLD,
    });
  }
  const all = Object.entries(record.agg1).map(([name, value]) => {
    const subsAll = (subsByParent.get(name) || []).sort(byBlocks);
    const shown = subsAll.slice(0, VIEW_SUB);
    const shownBlocks = shown.reduce((n, s) => n + s.blocks, 0);
    const shownSize = shown.reduce((n, s) => n + s.size, 0);
    const self = item(value);
    return {
      name,
      rel: joinRel(record.root, name),
      ...self,
      highFileDensity: self.files >= HIGH_FILE_COUNT_THRESHOLD,
      partial: pendingTop.has(name),
      queued: pendingTop.has(name) && !startedTop.has(name),
      sub: shown,
      // 「其余」= 父目录 − 已列出的子目录：直接位于父目录的文件 + 没列出的子目录。
      subRest: {
        blocks: Math.max(0, self.blocks - shownBlocks),
        size: Math.max(0, self.size - shownSize),
        dirs: Math.max(0, subsAll.length - shown.length),
      },
    };
  }).sort(byBlocks);
  const children = all.slice(0, VIEW_CHILDREN);
  const rest = all.slice(VIEW_CHILDREN);
  const childrenRest = {
    count: rest.length,
    blocks: rest.reduce((n, c) => n + c.blocks, 0) + record.agg1Over[0],
    size: rest.reduce((n, c) => n + c.size, 0) + record.agg1Over[1],
    overflow: record.agg1Over[0] > 0 || record.agg1Over[2] > 0 || record.agg1Over[3] > 0,
  };
  const totals = addInto(addInto([0, 0, 0, 0], record.agg1Over), [...record.rootFiles, 0]);
  for (const value of Object.values(record.agg1)) addInto(totals, value);
  // 第一层目录自身也是一个条目：「子目录数」统计里把它们加回来。
  totals[3] += Object.keys(record.agg1).length;
  return {
    root: record.root,
    label: rootLabel(record.root),
    parent: parentRel(record.root),
    home: record.home,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    runs: record.runs,
    complete: record.complete,
    stop: record.stop,
    lastRun: record.lastRun,
    scanned: {
      entries: record.entries,
      dirsDone: record.dirsDone,
      pendingDirs: record.pending.length,
      rootPartial,
      denied: record.denied,
      errors: record.errors,
      otherFs: record.otherFs,
      otherFsNames: record.otherFsNames,
      dropped: record.dropped,
      hardlinks: record.hardlinks,
    },
    totals: item(totals),
    rootFiles: { blocks: record.rootFiles[0], size: record.rootFiles[1], files: record.rootFiles[2] },
    children,
    childrenRest,
    knownCaches: extractKnownCaches(record),
    topFiles: record.top.slice(0, VIEW_TOP_FILES).map((f) => ({ ...f, rel: joinRel(record.root, f.path) })),
  };
}
