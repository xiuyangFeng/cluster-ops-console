// 管理员存储视图：把存下来的扫描结果 / 配额 / 挂载信息组装成界面要的形状（纯函数，无 IO）。
//
// 口径（界面文案同此）：
//   - 「占用」= 磁盘块（st_blocks × 512），硬链接在一次扫描内只计一次，不跟随符号链接、不跨文件系统。
//   - 扫描结果只保留：扫描根下第一层的全部目录 + 更深处占用 ≥ 阈值（64 MB）的最大 3 万个目录。
//     所以某层显示的子目录之和可能小于该目录，差额记为「其余（较小的子目录与直接文件）」。
//   - 按用户：开了配额的挂载点用 repquota（按文件属主，实时、全盘）；否则用最近一次「读 inode 表」的按用户统计
//     或扫描根正好是该盘的整盘扫描的属主合计（两者都是全盘、按属主）。
import { isRelPath } from "./protocol.mjs";

const CHILDREN_SHOW = 200;
const TOP_SHOW = 15;

const parentOf = (rel) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");

// 扫描结果 + 当前所在的相对路径 → 这一层的视图。
export function buildScanView(entry, rel = "") {
  if (!entry?.result || !isRelPath(rel)) return null;
  const { job, result } = entry;
  const records = result.records;
  const names = result.names || {};
  const ownerName = (uid) => (uid == null ? null : names[String(uid)] ?? `uid ${uid}`);
  let node;
  if (rel === "") {
    const [blocks, size, files, dirs] = result.rootTotals;
    node = { rel: "", blocks, size, files, dirs, uid: null, owner: null, mtime: null };
  } else {
    const rec = records.find((r) => r[0] === rel);
    if (!rec) return null;
    node = { rel, blocks: rec[1], size: rec[2], files: rec[3], dirs: rec[4], uid: rec[5], owner: ownerName(rec[5]), mtime: rec[6] };
  }
  const prefix = rel === "" ? "" : `${rel}/`;
  const hasKids = new Set();
  const kids = [];
  for (const r of records) {
    if (prefix && !r[0].startsWith(prefix)) continue;
    const rest = r[0].slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) kids.push(r);
    else hasKids.add(prefix + rest.slice(0, slash));
  }
  kids.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const children = kids.slice(0, CHILDREN_SHOW).map((r) => ({
    rel: r[0],
    name: r[0].slice(prefix.length),
    blocks: r[1], size: r[2], files: r[3], dirs: r[4], uid: r[5], owner: ownerName(r[5]), mtime: r[6],
    share: node.blocks > 0 ? r[1] / node.blocks : 0,
    deeper: hasKids.has(r[0]),
  }));
  const shownBlocks = kids.reduce((sum, r) => sum + r[1], 0);
  const top = result.top
    .filter((t) => !prefix || t[0].startsWith(prefix))
    .slice(0, TOP_SHOW)
    .map((t) => ({ rel: t[0], name: t[0].slice(prefix.length), blocks: t[1], size: t[2], uid: t[3], owner: ownerName(t[3]), mtime: t[4] }));
  const crumbs = [{ rel: "", name: job.root }];
  if (rel) {
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i += 1) crumbs.push({ rel: parts.slice(0, i + 1).join("/"), name: parts[i] });
  }
  return {
    job,
    rel,
    path: rel ? `${job.root}/${rel}` : job.root,
    parent: rel ? parentOf(rel) : null,
    crumbs,
    node,
    children,
    hiddenChildren: Math.max(0, kids.length - children.length),
    rest: Math.max(0, node.blocks - shownBlocks),
    top,
    owners: rel === "" ? ownersView(result, node.blocks) : null,
    threshold: job.threshold,
  };
}

function ownersView(result, total) {
  const names = result.names || {};
  return result.owners.slice(0, 200).map(([uid, blocks, files]) => ({
    uid, name: names[String(uid)] ?? null, bytes: blocks, files, share: total > 0 ? blocks / total : 0,
  }));
}

const under = (p, root) => root === "/" || p === root || p.startsWith(`${root}/`);

// 要显示的挂载点：允许的根本身或其下的挂载点；某个根下一块独立挂载都没有时，才显示它所在的那块盘
// （例如 node04 的 /mnt 下是 data1 / data2 / sda2 三块盘，就不再带出 /mnt 所在的系统盘 /）。
export function pickMounts(mounts = [], roots = []) {
  const keep = new Set();
  for (const r of roots) {
    const inside = mounts.filter((m) => under(m.mount, r));
    if (inside.length) for (const m of inside) keep.add(m.mount);
    else {
      const containing = mounts.filter((m) => under(r, m.mount)).sort((a, b) => b.mount.length - a.mount.length)[0];
      if (containing) keep.add(containing.mount);
    }
  }
  return mounts.filter((m) => keep.has(m.mount));
}

// 账号与活跃信息：account = user（本机账号，uid 1000–59999）| system（uid < 1000，如 root）| none（没有对应账号，多半是已删的人）；
// lastLogin 取自 info.users（SSH 最后登录，0 = 从没登录，null = 未知）。不活跃的判定按界面所选时长在前端做。
const SYSTEM_UID_MAX = 999;

function withActivity(row, users) {
  const u = users.get(row.uid);
  const account = u ? "user" : row.uid <= SYSTEM_UID_MAX || (row.uid >= 60000 && row.uid < 65536) ? "system" : "none";
  return { ...row, account, lastLogin: u ? (u.lastLogin ?? null) : null };
}

// 「按用户」表：每个挂载点一份。来源优先级：repquota（按属主、全盘、实时）> 扫描根正好是该挂载点的最近一次完整扫描。
export function buildUsersView({ info, quota = {}, scans = [] } = {}) {
  const mounts = info?.mounts || [];
  const users = new Map((info?.users || []).map((u) => [u.uid, u]));
  return mounts.map((m) => {
    const q = quota[m.mount];
    if (q && Array.isArray(q.rows)) {
      const total = q.rows.reduce((s, r) => s + r.bytes, 0);
      return {
        mount: m.mount, source: "quota", at: q.at, used: m.used, size: m.size, iused: m.iused, inodeScan: m.inodeScan ?? null,
        rows: q.rows.map((r) => withActivity({ uid: r.uid, name: r.name ?? users.get(r.uid)?.name ?? null, bytes: r.bytes, files: r.files, lastWrite: null, share: m.used > 0 ? r.bytes / m.used : (total > 0 ? r.bytes / total : 0) }, users))
          .sort((a, b) => b.bytes - a.bytes),
      };
    }
    // 扫描根正好是这块盘的最近一次完整结果：读 inode 表的按用户统计，或整盘目录扫描（scans 已按新→旧排列）。
    const scan = scans.find((s) => s.job.root === m.mount && s.job.state === "done" && s.owners);
    if (scan) {
      return {
        mount: m.mount, source: scan.job.kind === "inode" ? "inode" : "scan", at: scan.job.endedAt, jobId: scan.job.id, used: m.used, size: m.size, iused: m.iused, inodeScan: m.inodeScan ?? null,
        rows: scan.owners.map((o) => withActivity({ ...o, name: o.name ?? users.get(o.uid)?.name ?? null, lastWrite: o.lastWrite ?? null, share: m.used > 0 ? o.bytes / m.used : o.share }, users)),
      };
    }
    return { mount: m.mount, source: null, quota: m.quota, used: m.used, size: m.size, iused: m.iused, inodeScan: m.inodeScan ?? null, rows: [] };
  });
}

// 按需列目录（live list）与扫描结果合并：有扫描数据的子目录带上整树大小。
export function mergeListWithScan(list, entry, rel) {
  if (!list) return null;
  const sizes = new Map();
  if (entry?.result) {
    const prefix = rel === "" ? "" : `${rel}/`;
    for (const r of entry.result.records) {
      if (prefix && !r[0].startsWith(prefix)) continue;
      const rest = r[0].slice(prefix.length);
      if (rest && !rest.includes("/")) sizes.set(rest, r);
    }
  }
  const entries = list.entries.map((e) => {
    const rec = e.kind === "d" ? sizes.get(e.name) : null;
    return { ...e, treeBlocks: rec ? rec[1] : null, treeFiles: rec ? rec[3] : null };
  });
  // 有整树大小的目录按它排，其余按条目自身大小；同大小按名字。
  const key = (e) => e.treeBlocks ?? e.blocks;
  entries.sort((a, b) => key(b) - key(a) || (a.name < b.name ? -1 : 1));
  return { ...list, entries };
}
