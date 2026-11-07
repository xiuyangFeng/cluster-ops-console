// 磁盘增长归因：测量结果的整理、增长计算、何时该量与文案（纯函数，无 IO、不碰时钟）。
//
// 一次测量（存进 runtime/disk-growth.json 的形状，见 store.mjs）：
//   { at, startedAt, trigger: "schedule"|"disk"|"manual", complete, stop, rounds,
//     disk: { used, total, pct } | null,          量完那一刻整盘（$HOME 所在文件系统）的用量，取自资源采集
//     roots: [{ root, jobs, at, state, error,     state: ok 量完 | partial 没量完 | skipped 没轮到 | error 远端拒绝
//               c: [[子目录名, 字节, 是否没量完]],  最大的 40 个，按字节降序
//               o: [字节, 个数, 其中最大的一个, 是否有没量完的] }] }   其余子目录与直接放在集合目录里的文件
//
// 口径：
//   - 大小 = 实际占用（st_blocks × 512），与目录占用面板的「实际占用」同一个数。
//   - 增长 = 这一次减去「约 24 小时前」那一次：取与 24 小时前最接近的一次（至少隔 3 小时、至多 48 小时），
//     实际间隔如实写出来（不是 24 小时左右就写「近 N 小时」），不按速度折算。
//   - 没量完的子目录数字只是已扫到的部分，不参与增长；两次都量完的才相减。
//   - 上一次没单列的子目录（当时不在最大的 40 个里）：它当时不超过「其余」里最大的那个，增长按下限算。
//
// 本模块不 import 任何东西：简报的纯模型（lib/brief/model.mjs）也引它拼文案。

const HOUR = 3600_000;
export const KEEP_CHILDREN = 40;
export const VIEW_ROWS = 8;
export const NAME_MAX = 120;
export const REF_TARGET_MS = 24 * HOUR;
export const REF_MIN_MS = 3 * HOUR;
export const REF_MAX_MS = 48 * HOUR;
// 每 6 小时量一次；磁盘占用比上次量完时涨了 ≥ 1 个百分点就提前量（两次至少隔 1 小时）；没量成的 30 分钟后再试。
export const SCHEDULE_INTERVAL_MS = 6 * HOUR;
export const EARLY_MIN_GAP_MS = HOUR;
export const EARLY_RISE_POINTS = 1;
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
// 一句话摘要只在最近一次测量不超过这么久时给（两个定时周期）。
export const SUMMARY_FRESH_MS = 12 * HOUR;
// 小于这个量的变化算「没有明显增长」（共享盘按 TB 计，1 GiB 以内是噪声）。
export const NOTABLE_BYTES = 2 ** 30;
// 简报只在「作业目录增长占整盘同期增长」达到这个比例时才提。
export const BRIEF_SHARE_MIN = 0.3;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符就是要挡掉的
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const finite = (value) => typeof value === "number" && Number.isFinite(value);

// 能单列的子目录名：不超长、没有控制字符、是合法的 Unicode（非 UTF-8 文件名经远端转义后是孤立代理项）。
// 不合格的并进「其余」，数字照算。
export function isListableName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= NAME_MAX && !CONTROL_RE.test(name) && name.isWellFormed();
}

// 目录占用扫描器累加出的一条记录（lib/dir-usage/model.mjs mergeDirUsageRun）→ 一个集合目录的测量结果。
// truncated：扫描器待扫列表放不下、有子目录被丢掉的那几轮里碰过的一级子目录——它们的数字偏小，同样按没量完算。
export function summarizeScan(record, { keep = KEEP_CHILDREN, truncated = new Set() } = {}) {
  const pendingTop = new Set();
  let rootPartial = false;
  for (const [rel] of record.pending) {
    if (rel === "") rootPartial = true;
    else pendingTop.add(rel.split("/", 1)[0]);
  }
  const all = Object.entries(record.agg1).map(([name, value]) => ({ name, bytes: value[0], partial: pendingTop.has(name) || truncated.has(name) }));
  const named = all.filter((child) => isListableName(child.name))
    .sort((a, b) => b.bytes - a.bytes || (a.name < b.name ? -1 : 1))
    .slice(0, keep);
  const listed = new Set(named.map((child) => child.name));
  const rest = all.filter((child) => !listed.has(child.name));
  // 超出扫描器单列上限的子目录只有合计：其中任何一个都不会超过这个合计。
  const overflow = record.agg1Over[0];
  return {
    complete: record.complete === true && truncated.size === 0,
    c: named.map((child) => [child.name, child.bytes, child.partial ? 1 : 0]),
    o: [
      rest.reduce((sum, child) => sum + child.bytes, 0) + overflow + record.rootFiles[0],
      rest.length,
      rest.reduce((max, child) => Math.max(max, child.bytes), overflow),
      rootPartial || rest.some((child) => child.partial) ? 1 : 0,
    ],
  };
}

const usable = (root) => Boolean(root) && (root.state === "ok" || root.state === "partial");
const rootBytes = (root) => root.c.reduce((sum, child) => sum + child[1], 0) + root.o[0];

// 「约 24 小时前」的那一次；没有合适的 → null。
export function pickReference(measurements, latest) {
  let best = null;
  for (const item of measurements) {
    const span = latest.at - item.at;
    if (item === latest || span < REF_MIN_MS || span > REF_MAX_MS) continue;
    if (!best || Math.abs(span - REF_TARGET_MS) < Math.abs(latest.at - best.at - REF_TARGET_MS)) best = item;
  }
  return best;
}

// 一个子目录相对上一次的增长：{ delta, lowerBound?, isNew? }；算不出来 delta 为 null。
function childDelta(name, bytes, partial, refRoot) {
  if (partial || !usable(refRoot)) return { delta: null };
  const prev = refRoot.c.find((child) => child[0] === name);
  if (prev) return prev[2] ? { delta: null } : { delta: bytes - prev[1] };
  const [, count, max, otherPartial] = refRoot.o;
  if (otherPartial) return { delta: null };
  if (count === 0) return { delta: bytes, isNew: true };
  return bytes > max ? { delta: bytes - max, lowerBound: true } : { delta: null };
}

// 最近一次测量（相对 ref）的各子目录、各集合目录与合计。ref 为 null → 只有大小，没有增长。
export function computeGrowth(latest, ref = null) {
  const rows = [];
  const roots = [];
  let totalBytes = 0;
  let totalDelta = null;
  let partial = false;
  for (const root of latest.roots) {
    const refRoot = ref ? ref.roots.find((item) => item.root === root.root) : null;
    const entry = { root: root.root, jobs: root.jobs, state: root.state, error: root.error ?? null, at: root.at, children: 0, bytes: null, delta: null, partial: false };
    roots.push(entry);
    if (!usable(root)) {
      partial = true;
      continue;
    }
    entry.children = root.c.length + root.o[1];
    entry.bytes = rootBytes(root);
    totalBytes += entry.bytes;
    let sum = null;
    for (const [name, bytes, isPartial] of root.c) {
      const change = ref ? childDelta(name, bytes, Boolean(isPartial), refRoot) : { delta: null };
      if (change.delta != null) sum = (sum ?? 0) + change.delta;
      rows.push({ root: root.root, name, bytes, partial: Boolean(isPartial), at: root.at, delta: change.delta, lowerBound: change.lowerBound === true, isNew: change.isNew === true });
    }
    if (ref && root.state === "ok" && refRoot?.state === "ok") entry.delta = entry.bytes - rootBytes(refRoot);
    else {
      // 有一边没量完：只把两次都量完的子目录加起来。
      entry.delta = sum;
      entry.partial = ref != null;
    }
    if (entry.delta != null) totalDelta = (totalDelta ?? 0) + entry.delta;
    if (entry.partial || entry.delta == null) partial = true;
  }
  let top = null;
  for (const row of rows) if (row.delta > 0 && (!top || row.delta > top.delta)) top = row;
  const diskDelta = finite(latest.disk?.used) && finite(ref?.disk?.used) ? latest.disk.used - ref.disk.used : null;
  return {
    refAt: ref ? ref.at : null,
    spanMs: ref ? latest.at - ref.at : null,
    rows,
    roots,
    total: { bytes: totalBytes, delta: totalDelta, partial: ref != null && partial },
    top: top ? { root: top.root, name: top.name, delta: top.delta, lowerBound: top.lowerBound } : null,
    // 整盘同期的净增长与作业目录所占的比例；整盘没涨（别人删得比写得多）或缺用量 → 不给比例。
    diskDelta,
    share: totalDelta > 0 && diskDelta > 0 ? totalDelta / diskDelta : null,
  };
}

// 「近 24 小时」；间隔离 24 小时超过 3 小时就照实写。
export function spanLabel(spanMs) {
  if (!finite(spanMs)) return "";
  if (Math.abs(spanMs - REF_TARGET_MS) <= 3 * HOUR) return "近 24 小时";
  return `近 ${Math.max(1, Math.round(spanMs / HOUR))} 小时`;
}

const latestOf = (entry) => (Array.isArray(entry?.measurements) && entry.measurements.length ? entry.measurements.at(-1) : null);

// 一句话摘要用的事实（磁盘事件详情与简报共用）。还没有可比的两次测量 → null；最近一次已经是
// 12 小时以前的（工作台关了几天刚打开）也 → null：那不是「近 24 小时」，等新的一次量完再说。
export function buildSummary(entry, { nowMs = Date.now() } = {}) {
  const latest = latestOf(entry);
  if (!latest || nowMs - latest.at > SUMMARY_FRESH_MS) return null;
  const ref = pickReference(entry.measurements, latest);
  if (!ref) return null;
  const growth = computeGrowth(latest, ref);
  if (growth.total.delta == null) return null;
  return { measuredAt: latest.at, complete: latest.complete === true, spanMs: growth.spanMs, label: spanLabel(growth.spanMs), total: growth.total, top: growth.top, share: growth.share };
}

function compareRows(a, b) {
  if ((a.delta == null) !== (b.delta == null)) return a.delta == null ? 1 : -1;
  if (a.delta != null && a.delta !== b.delta) return b.delta - a.delta;
  return b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// GET /api/disk-growth 的主体：最近一次测量的各集合目录、按增长排序的前 8 个子目录与合计。
// 从没推出过集合目录、也没量过 → null（界面整块不显示）。errorText：远端拒绝原因码 → 界面文案
// （扫描器的那张表，由调用方给）。
export function buildDiskGrowthView(entry, { errorText = {} } = {}) {
  const latest = latestOf(entry);
  const found = Array.isArray(entry?.roots) ? entry.roots : [];
  if (!latest && !found.length) return null;
  const attempt = entry.attempt ? { at: entry.attempt.at, outcome: entry.attempt.outcome, error: entry.attempt.error ?? null } : null;
  if (!latest) {
    return {
      measuredAt: null, complete: false, stop: null, trigger: null, refAt: null, spanMs: null, label: "",
      roots: found.map((item) => ({ root: item.root, jobs: item.jobs, state: "skipped", error: null, at: null, children: 0, bytes: null, delta: null, partial: false })),
      rows: [], rowCount: 0, total: { bytes: 0, delta: null, partial: false }, share: null, attempt,
    };
  }
  const growth = computeGrowth(latest, pickReference(entry.measurements, latest));
  return {
    measuredAt: latest.at,
    complete: latest.complete === true,
    stop: latest.stop ?? null,
    trigger: latest.trigger,
    refAt: growth.refAt,
    spanMs: growth.spanMs,
    label: spanLabel(growth.spanMs),
    roots: growth.roots.map((root) => ({ ...root, error: root.error ? errorText[root.error] || "远端没有量成" : null })),
    rows: [...growth.rows].sort(compareRows).slice(0, VIEW_ROWS),
    rowCount: growth.rows.length,
    total: growth.total,
    share: growth.share,
    attempt,
  };
}

// ---- 何时该量 ----

// 状态仓的资源层（layers.resources）→ 这台服务器最近一次采到的整盘用量，带采样时刻；没采到过 → null。
// 采集里已经有 $HOME 所在文件系统的 used_kb / total_kb（remote/collect.sh 的 filesystem 段），这里只取用。
export function filesystemFromResources(resources, serverId) {
  const usage = resources?.[serverId]?.usage;
  if (!usage || !finite(usage.checkedAt)) return null;
  return { ...(usage.filesystem || {}), checkedAt: usage.checkedAt };
}

// 资源采集的文件系统用量 → 存进测量的 { used, total, pct }；没有可用的数 → null。
export function diskOf(filesystem) {
  if (!filesystem || typeof filesystem !== "object") return null;
  const used = finite(filesystem.usedBytes) && filesystem.usedBytes >= 0 ? filesystem.usedBytes : null;
  const total = finite(filesystem.totalBytes) && filesystem.totalBytes > 0 ? filesystem.totalBytes : null;
  const pct = finite(filesystem.usedPct) && filesystem.usedPct >= 0 && filesystem.usedPct <= 100 ? filesystem.usedPct : null;
  return used == null && pct == null ? null : { used, total, pct };
}

// 磁盘占用比上一次量完时涨了多少个百分点：有字节数按字节数算（df 的百分比是整数，太粗），否则按百分比。
export function risePoints(last, current) {
  if (!last || !current) return null;
  if (finite(last.used) && finite(current.used) && finite(current.total) && current.total > 0) return ((current.used - last.used) / current.total) * 100;
  if (finite(last.pct) && finite(current.pct)) return current.pct - last.pct;
  return null;
}

// 现在要不要量：{ lastAt 上一次量完（或确认没有集合目录）的时刻, lastDisk 当时的整盘用量, disk 现在的, failedAt 上一次没量成的时刻 }
// → "schedule"（到 6 小时了 / 从没量过）| "disk"（磁盘涨了 1 个百分点）| null。
export function dueReason({ nowMs, lastAt = null, lastDisk = null, disk = null, failedAt = null }) {
  if (finite(failedAt) && nowMs >= failedAt && nowMs - failedAt < RETRY_AFTER_FAILURE_MS) return null;
  if (!finite(lastAt)) return "schedule";
  const since = nowMs - lastAt;
  // since < 0：本机时钟被往回拨过，上次的时刻不可信，按到点处理。
  if (since < 0 || since >= SCHEDULE_INTERVAL_MS) return "schedule";
  if (since >= EARLY_MIN_GAP_MS && (risePoints(lastDisk, disk) ?? 0) >= EARLY_RISE_POINTS) return "disk";
  return null;
}

// ---- 文案 ----

// 与前端 store.js 的 formatBytes(n, { compact: true }) 同一规则（1024 进制、1 位小数、≥ 100 取整），
// 简报与事件详情里的数字才和面板上的对得上（model.test.mjs 逐值对照）。
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "—";
  let unit = 0;
  for (let value = n; value >= 1024 && unit < BYTE_UNITS.length - 1; value /= 1024) unit += 1;
  const scaled = n / 1024 ** unit;
  return `${unit === 0 || scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

const SENTENCE_NAME_MAX = 48;
const shorten = (name) => (name.length > SENTENCE_NAME_MAX ? `${name.slice(0, SENTENCE_NAME_MAX - 1)}…` : name);

function sharePhrase(share) {
  if (share >= 1) return "超过整盘同期的净增长";
  if (share < 0.01) return "占整盘同期增长不到 1%";
  return `占整盘同期增长的 ${Math.round(share * 100)}%`;
}

// 磁盘事件详情里的那一句：「近 24 小时你的作业目录增长约 X（占整盘同期增长的 N%），其中 <目录名> +Y」。
// 没有可比的测量 → ""。句末不带标点（调用方再接「按这个速度约 N 天写满」）。
export function growthSentence(summary) {
  if (!summary || !finite(summary.total?.delta)) return "";
  const { label, total, top, share } = summary;
  const subject = `${label}你的作业目录${total.partial ? "（只算量完的部分）" : ""}`;
  if (Math.abs(total.delta) < NOTABLE_BYTES) return `${subject}没有明显增长`;
  if (total.delta < 0) return `${subject}减少了约 ${formatBytes(-total.delta)}`;
  let text = `${subject}增长约 ${formatBytes(total.delta)}`;
  if (finite(share)) text += `（${sharePhrase(share)}）`;
  if (top) text += `，其中 ${shorten(top.name)} ${top.lowerBound ? "至少 " : ""}+${formatBytes(top.delta)}`;
  return text;
}

// 简报磁盘提示后面接的那半句：「其中你的 <目录名> 近 24 小时 +Y」。只在作业目录增长占整盘同期增长
// ≥ 30% 时给；最大的那个子目录占了一半以上就点它的名，否则说作业目录合计。不该提 → ""。
export function briefGrowthClause(summary) {
  if (!summary || !finite(summary.share) || summary.share < BRIEF_SHARE_MIN || !(summary.total?.delta >= NOTABLE_BYTES)) return "";
  const { label, total, top } = summary;
  if (top && top.delta * 2 >= total.delta) return `其中你的 ${shorten(top.name)} ${label} ${top.lowerBound ? "至少 " : ""}+${formatBytes(top.delta)}`;
  return `其中你的作业目录${label} +${formatBytes(total.delta)}`;
}
