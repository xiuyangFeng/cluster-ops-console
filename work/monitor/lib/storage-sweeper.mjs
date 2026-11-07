import { lstat as fsLstat, readdir as fsReaddir, rm as fsRm, rmdir as fsRmdir, stat as fsStat } from "node:fs/promises";
import path from "node:path";

import { corruptArchiveKey, isCorruptArchiveName } from "./corrupt-archive.mjs";
import { formatHistoryDate } from "./history-store.mjs";

// 本地数据预算（v2.18 §6.6）：runtime/ 目录整体有一个硬上限（默认 50MB），超限时按
// "最没有信息量的先扔"的顺序淘汰，直到回到预算之内。
//
// 为什么需要它：logs/ 的每个 source 各自 2MB 上限 × 分卷、history/ 每天一个文件保留
// 30 天、metrics.json 每台服务器 5760 个采样——单独看每一项都有界，加起来却能悄悄涨到
// 几百 MB。用户的硬要求是"本地数据必须有总量预算"，所以这里做一层跨组件的总闸。
//
// 设计约束：
//  - 只删"可再生的历史",绝不碰活动文件。保护集：`<source>.ndjson` / `<name>.log`（当前
//    正在写入的句柄）、`metrics.json`（内存镜像的唯一持久化副本）、`*.pid.json` / `*.pid`
//    （进程注册表的真相来源，删掉会让 supervisor 失去对已启动进程的认领能力）、
//    以及今天与昨天的 history 文件（"昨晚断了几次"是最常见的复盘问题）。
//  - 单个文件删除失败（权限/竞态）只跳过，不中断整轮——清理是旁路维护，绝不反噬主流程。
//  - fs 与 now 全部可注入：单测用内存 fake fs，不落真实磁盘、不依赖真实日期。
//  - 无内部定时器。调度（启动后一次 + 每小时）由 monitor-server 持有，便于统一 unref/退出清理。
//
// 坏文件的留档（`<名字>.corrupt-<北京时间>`，lib/corrupt-archive.mjs，v2.64）在哪个子目录都单列为 corrupt：
// 计入总量；每个文件本来就最多留 2 份，所以不看预算，只在超预算时排在多余分卷之后、旧 history 之前清，旧的先清。
//
// 另有两类没人再读、也没人会删的孤儿，不看预算、每轮都清（预算宽裕时它们会永远留着）：
//  - logs 的 `.N`（N ≥ 2）分卷：logger 自 v2.18 起只留一份 `.1`，历史查询也只读 `.1` 与当前文件；
//    升级前留下的 `.2` / `.3` 此前只在超预算时才轮得到删（现役机器上 4.2 MB 放了一个多月）。
//  - 已退出的 supervisor 留下的控制信箱目录（见 removeOrphanControlDirs）。

const DEFAULT_BUDGET_BYTES = 50 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SCAN_DEPTH = 6; // 防御符号链接环 / 意外的深层目录；runtime/ 实际只有两层

// `<something>.ndjson.N` / `<something>.log.N`：logger 的轮转分卷，N 越大越旧。
const ROTATION_RE = /\.(?:ndjson|log)\.(\d+)$/;
// history-store 的按天文件名（与 history-store.mjs 的 FILE_RE 同形）。
const HISTORY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;
// 控制信箱 runtime/control/<instanceId>/{requests,processing,results}（lib/supervisor-control.mjs）。
// 实例号的形状与那边的 INSTANCE_ID_RE 相同——那边没有导出，且在数据面的指纹闭包里，不为这里去改它。
const CONTROL_DIR = "control";
const CONTROL_INSTANCE_RE = /^[0-9a-f]{4,64}$/;
const CONTROL_SUBDIRS = new Set(["requests", "processing", "results"]);
const CONTROL_ORPHAN_MIN_AGE_MS = DAY_MS;

// 文件分类：kind 同时用于 measure() 的分项统计与 sweep() 的淘汰分层。
// segments 是相对 runtimeDir 的路径分段（["logs", "ops.ndjson.2"]）。
function classify(segments) {
  const name = segments[segments.length - 1];
  const top = segments.length > 1 ? segments[0] : null;
  // 先于其它分类：metrics.json.corrupt-… 不能被当成 metrics（那一类永不删）。
  if (isCorruptArchiveName(name)) return { kind: "corrupt", archivedAt: corruptArchiveKey(name) };
  if (top === "logs") {
    const rotation = ROTATION_RE.exec(name);
    if (rotation) return { kind: "logRotations", rotation: Number(rotation[1]) };
    return { kind: "logs" };
  }
  if (top === "history") {
    const day = HISTORY_FILE_RE.exec(name);
    if (day) return { kind: "history", day: day[1] };
    return { kind: "history" };
  }
  if (segments.length === 1 && name.startsWith("metrics.json")) return { kind: "metrics" };
  return { kind: "other" };
}

export function createStorageSweeper({
  runtimeDir,
  budgetBytes = DEFAULT_BUDGET_BYTES,
  now = Date.now,
  fs = { readdir: fsReaddir, stat: fsStat, rm: fsRm, lstat: fsLstat, rmdir: fsRmdir },
  log = () => {},
  // 当前 supervisor 的控制信箱实例号（异步；不知道就返回 null）。缺省 = 不知道 → 信箱目录一棵都不删。
  getLiveControlInstanceId = async () => null,
} = {}) {
  let budget = Number.isFinite(Number(budgetBytes)) && Number(budgetBytes) > 0
    ? Number(budgetBytes)
    : DEFAULT_BUDGET_BYTES;
  let disposed = false;
  let sweeping = false;
  let lastUsedBytes = null; // 上次 measure/sweep 观测到的占用；未跑过为 null
  let lastSweepAt = null;
  let lastEvictedCount = 0; // 上一次 sweep 淘汰的文件数（不累计——getState 描述的是"最近一次清理"）

  // 单个文件的删除：失败一律吞掉并返回 false（调用方据此不扣减 usedBytes）。
  async function removeFile(filePath) {
    try {
      await fs.rm(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // 递归统计 runtimeDir 下的文件。目录不存在 / 不可读一律按 0 处理（新机器首次启动、
  // 或用户手动删了 runtime/ 都是正常场景，不该抛错也不该记噪音日志）。
  async function scan() {
    const files = [];
    const byKind = { logs: 0, logRotations: 0, history: 0, metrics: 0, corrupt: 0, other: 0 };
    let usedBytes = 0;

    async function walk(dir, segments, depth) {
      if (depth > MAX_SCAN_DEPTH) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // 目录不存在或不可读
      }
      for (const entry of entries || []) {
        const name = entry?.name;
        if (!name) continue;
        const childPath = path.join(dir, name);
        const childSegments = [...segments, name];
        if (entry.isDirectory()) {
          await walk(childPath, childSegments, depth + 1);
          continue;
        }
        let info;
        try {
          info = await fs.stat(childPath);
        } catch {
          continue; // 扫描期间被删（轮转/GC 竞态）
        }
        const bytes = Number(info?.size) || 0;
        const { kind, rotation, day, archivedAt } = classify(childSegments);
        byKind[kind] = (byKind[kind] || 0) + bytes;
        usedBytes += bytes;
        // regular：目录项本身是普通文件（符号链接不算）。不看预算的那一层只删普通文件。
        files.push({ path: childPath, name, kind, bytes, rotation, day, archivedAt, mtimeMs: Number(info?.mtimeMs) || 0, regular: entry.isFile?.() === true });
      }
    }

    await walk(runtimeDir, [], 0);
    return { usedBytes, byKind, files };
  }

  async function measure() {
    const { usedBytes, byKind } = await scan();
    lastUsedBytes = usedBytes;
    return { usedBytes, byKind };
  }

  // 淘汰候选的分层排序（越靠前越先扔）：
  //  1. logs 的多余分卷 `.N`（N ≥ 2）——agent.md 明令"严禁保留过多历史冗余分卷"，
  //     createLogger 只保留一份 .1，这层通常只在升级前的遗留文件上命中。
  //     同层内 N 大的（更旧）先扔，N 相同则 mtime 早的先扔。
  //     这一层里的普通文件不等超预算，sweep() 每轮先清掉（isStaleRotation）。
  //  2. 坏文件的留档（corrupt），留档时刻早的先扔——按名字里的时间戳，不看 mtime（改名不改 mtime）。
  //  3. history 的最旧日期文件，但保留今天与昨天（跨天复盘的最小可用集）。
  //  4. logs 的 `.1` 分卷——最近一份轮转历史，只有前几层不够时才动。
  // 活动文件（`.ndjson` / `.log`）、metrics.json、pid 记录不在任何一层，天然免疫。
  function buildTiers(files, ts) {
    const today = formatHistoryDate(ts);
    const yesterday = formatHistoryDate(ts - DAY_MS);

    const extraRotations = files
      .filter((f) => f.kind === "logRotations" && f.rotation >= 2)
      .sort((a, b) => (b.rotation - a.rotation) || (a.mtimeMs - b.mtimeMs));

    const corrupt = files
      .filter((f) => f.kind === "corrupt")
      .sort((a, b) => (a.archivedAt[0] < b.archivedAt[0] ? -1 : a.archivedAt[0] > b.archivedAt[0] ? 1 : a.archivedAt[1] - b.archivedAt[1]));

    const oldHistory = files
      .filter((f) => f.kind === "history" && f.day && f.day !== today && f.day !== yesterday)
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)); // ISO 日期字典序 = 时间序

    const lastRotation = files
      .filter((f) => f.kind === "logRotations" && f.rotation === 1)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    return [...extraRotations, ...corrupt, ...oldHistory, ...lastRotation];
  }

  // 没人再读的旧分卷：不看预算就删。只认目录项本身是普通文件的——符号链接留给超预算时的老路径
  // （rm 只摘掉链接本身，不碰它指向的东西）。
  const isStaleRotation = (file) => file.kind === "logRotations" && file.rotation >= 2 && file.regular;

  // 已退出的 supervisor 留下的控制信箱目录。supervisor 每次启动用一个新的随机实例号建一棵
  // control/<instanceId>/{requests,processing,results}，退出时不删、之后也没有任何人删——现役机器
  // 五周攒了 86 棵。规则故意保守，全部满足才删：
  //   1. 知道当前 supervisor 的实例号，且这一棵不是它的。不知道（没有新鲜的运行快照）就一棵都不删；
  //   2. 目录名是实例号的形状；里面只有那三个子目录，且全是真目录——符号链接、认不得的条目一律不碰；
  //   3. 三个子目录全空。还留着结果文件 / 残留请求的不删（那是别人可能还要查证的东西）；
  //   4. 这一棵与它的子目录的 mtime 全都早于 24 小时。
  // 删除只用 rmdir（非递归）：它删不掉非空目录、也不会顺着符号链接走，判定之后才落进来的文件不会被带走；
  // 路径只由 runtimeDir + 固定名字 + 校验过形状的目录名拼出，不出 runtime/。
  // 任何一步失败（竞态 / 权限）这一棵就留到下一轮。返回删掉的棵数。
  async function removeOrphanControlDirs(ts) {
    let liveId = null;
    try {
      liveId = await getLiveControlInstanceId();
    } catch {}
    if (typeof liveId !== "string" || !CONTROL_INSTANCE_RE.test(liveId)) return 0;
    const root = path.join(runtimeDir, CONTROL_DIR);
    let entries;
    try {
      if (!(await fs.lstat(root)).isDirectory()) return 0; // control 本身是符号链接 / 不是目录
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return 0; // 还没有信箱目录
    }
    let removed = 0;
    for (const entry of entries || []) {
      const name = entry?.name;
      if (!name || name === liveId || !CONTROL_INSTANCE_RE.test(name) || !entry.isDirectory()) continue;
      if (await removeControlDirIfOrphan(path.join(root, name), ts - CONTROL_ORPHAN_MIN_AGE_MS)) removed += 1;
    }
    return removed;
  }

  async function removeControlDirIfOrphan(dir, cutoff) {
    try {
      // mtime 读不出数（NaN）按「不够旧」处理。
      const oldDir = async (target) => {
        const info = await fs.lstat(target);
        return info.isDirectory() && info.mtimeMs < cutoff;
      };
      if (!(await oldDir(dir))) return false;
      const subdirs = [];
      for (const child of await fs.readdir(dir, { withFileTypes: true })) {
        if (!CONTROL_SUBDIRS.has(child.name) || !child.isDirectory()) return false;
        const sub = path.join(dir, child.name);
        if (!(await oldDir(sub))) return false;
        if ((await fs.readdir(sub, { withFileTypes: true })).length > 0) return false;
        subdirs.push(sub);
      }
      for (const sub of subdirs) await fs.rmdir(sub);
      await fs.rmdir(dir);
      return true;
    } catch {
      return false;
    }
  }

  // targetRatio: 目标占用 = budget × ratio。定时清理用 1（回到预算内即可），
  // 手动 prune 用 0.5（一次腾出一半空间，避免刚清完立刻又触顶）。
  async function sweep({ targetRatio = 1 } = {}) {
    // 已 dispose（进程退出中）或上一轮还没扫完（每小时的定时轮 与 手动 prune 撞上）
    // 都直接返回一个空操作结果：并发跑两轮扫描会让第二轮基于过期的文件清单去删，
    // 白白多做一次全目录 stat，而清理本来就允许推迟到下一拍。
    if (disposed || sweeping) {
      return { evicted: [], usedBytes: lastUsedBytes ?? 0, budgetBytes: budget, overBudget: false };
    }
    sweeping = true;
    try {
      const ts = now();
      const ratio = Number.isFinite(Number(targetRatio)) && Number(targetRatio) > 0 ? Number(targetRatio) : 1;
      const targetBytes = budget * Math.min(ratio, 1);
      const { usedBytes, files } = await scan();
      let remaining = usedBytes;
      const evicted = [];
      const gone = new Set();
      const evict = async (file) => {
        if (!(await removeFile(file.path))) return; // 删除失败：不扣字节，继续下一个
        gone.add(file.path);
        remaining -= file.bytes;
        evicted.push({ path: file.path, bytes: file.bytes, kind: file.kind });
      };
      const tiers = buildTiers(files, ts);

      // 不看预算、每轮都清的两类孤儿：没人再读的旧分卷、已退出的 supervisor 留下的空信箱目录。
      for (const file of tiers) if (isStaleRotation(file)) await evict(file);
      const controlDirs = await removeOrphanControlDirs(ts);
      if (controlDirs > 0) {
        log(`storage sweep: 清掉 ${controlDirs} 个已退出的 supervisor 留下的空控制信箱目录`, {
          level: "info", event: "storage-control-orphans", controlDirs,
        });
      }

      if (remaining > targetBytes) {
        for (const file of tiers) {
          if (remaining <= targetBytes) break;
          if (!gone.has(file.path)) await evict(file);
        }
      }

      lastUsedBytes = remaining;
      lastSweepAt = ts;
      lastEvictedCount = evicted.length;
      // overBudget 是"相对本次 sweep 目标"的判定：清空了所有可淘汰层仍到不了目标，
      // 说明活动文件本身就撑满了预算（例如预算配得比 logs 的 2MB×N 还小），这是配置
      // 问题而不是清理逻辑问题，只告警不越界删活动文件。
      const overBudget = remaining > targetBytes;
      if (overBudget) {
        log(
          `storage sweep: runtime 仍超预算（${remaining} / ${budget} bytes，目标 ${Math.round(targetBytes)}），可淘汰文件已清空；活动日志与 metrics.json 不删，请调高 storageBudgetBytes 或收紧日志上限`,
          { level: "warn", event: "storage-over-budget", usedBytes: remaining, budgetBytes: budget, targetBytes: Math.round(targetBytes) },
        );
      }
      return { evicted, usedBytes: remaining, budgetBytes: budget, overBudget };
    } finally {
      sweeping = false;
    }
  }

  // 预算热更新：配置热载后由调用方在下一次 sweep 前灌入（见 monitor-server 的
  // resolveStorageBudgetBytes），避免 sweeper 自己去读配置而多一条依赖。
  function setBudget(bytes) {
    const value = Number(bytes);
    if (Number.isFinite(value) && value > 0) budget = value;
    return budget;
  }

  // 同步、零 IO：/api/status 与每个 SSE 客户端的 status 事件都会调它，不能碰盘。
  // evicted 是"上一次 sweep 淘汰的文件数"（非累计），语义与 lastSweepAt 配套。
  function getState() {
    return { usedBytes: lastUsedBytes, budgetBytes: budget, lastSweepAt, evicted: lastEvictedCount };
  }

  function dispose() {
    disposed = true;
  }

  return { measure, sweep, setBudget, getState, dispose };
}
