// 管理员存储视图：root SSH 调用的组装与远端输出解析（纯函数，无 IO）。
//
// 远端命令串只有一个白名单子命令词（info / quota / list / scan-*），参数一律走 stdin JSON；
// 服务器上 authorized_keys 的 command= 会无视客户端命令、只把它放进 SSH_ORIGINAL_COMMAND 给脚本挑子命令。
// 远端输出一律当不可信数据：只认最后一行 JSON，字段白名单、字符串截断、数值钳位、条目数封顶。
import path from "node:path";

export const STORAGE_ADMIN_COMMANDS = Object.freeze(["info", "quota", "list", "scan-start", "scan-status", "scan-result", "scan-stop", "scan-list", "usage-start"]);
export const SSH_TIMEOUT_MS = 30_000;
export const RESULT_TIMEOUT_MS = 90_000;
export const MAX_OUT_BYTES = 16 * 1024 * 1024;

const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_NAME = 1024;
const MAX_REL = 4096;
const RECORDS_CAP = 40_000;
const OWNERS_CAP = 5000;
const TOP_CAP = 300;
const LIST_CAP = 3000;
const USERS_CAP = 3000;
const CHILDREN_CAP = 500;
const MOUNTS_CAP = 64;
const JOBS_CAP = 20;

// Windows 自带的 OpenSSH 不支持连接复用：ControlMaster / ControlPath 两项在 win32 上整组不传（与 ssh-args.mjs 同一做法）。
export function buildRootSshArgs(target, identityFile, command, { platform = process.platform } = {}) {
  if (!STORAGE_ADMIN_COMMANDS.includes(command)) throw new Error(`unknown storage-admin command: ${command}`);
  return [
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    ...(platform === "win32" ? [] : ["-o", "ControlMaster=no", "-o", "ControlPath=none"]),
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-T",
    "-i", identityFile,
    "-p", String(target.port || 22),
    "-l", "root",
    target.host,
    command,
  ];
}

const count = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), MAX_NUMBER) : 0);
const intOrNull = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_NUMBER ? v : null);
const ts = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 4e9 ? Math.floor(v) : null);
const str = (v, max = MAX_NAME) => (typeof v === "string" && !v.includes("\0") ? v.slice(0, max) : null);

export function isAbsNormal(p) {
  return typeof p === "string" && p.startsWith("/") && p.length <= MAX_REL && !p.includes("\0") &&
    (p === "/" || (path.posix.normalize(p) === p && !p.endsWith("/")));
}

export function isRelPath(rel) {
  if (typeof rel !== "string" || rel.length > MAX_REL || rel.includes("\0")) return false;
  if (rel === "") return true;
  if (rel.startsWith("/") || rel.endsWith("/")) return false;
  return rel.split("/").every((p) => p !== "" && p !== "." && p !== "..");
}

export const isJobId = (job) => typeof job === "string" && /^[A-Za-z0-9-]{8,40}$/.test(job);

export const REMOTE_ERROR_TEXT = Object.freeze({
  "bad-command": "服务器端脚本不认这个操作（版本过旧？请重新安装）",
  "bad-args": "参数无效",
  "no-roots": "服务器端没有配置允许扫描的目录（请重新安装）",
  "bad-path": "路径无效",
  "outside-roots": "路径不在允许扫描的目录内",
  symlink: "路径上有符号链接，未处理",
  "not-found": "目录不存在",
  "not-dir": "不是目录",
  denied: "没有权限读取",
  "bad-mount": "挂载点无效",
  "quota-off": "这个挂载点没有开启配额统计",
  "no-repquota": "服务器上没有 repquota（apt install quota）",
  "repquota-failed": "repquota 执行失败",
  "state-dir": "服务器端状态目录不可写",
  busy: "这台机器已有一个扫描在进行",
  "not-ext": "不是 ext2/3/4 文件系统，不能按 inode 表统计",
  "no-device": "找不到这块盘对应的块设备",
  "unsupported-feature": "文件系统用了暂不支持的特性，为安全起见不读",
  "bad-super": "超级块参数异常，为安全起见不读",
  mismatch: "块设备与挂载点对不上，为安全起见不读",
  "short-read": "读块设备时提前结束",
  "probe-failed": "检查文件系统时出错",
  "bad-job": "扫描任务号无效",
  "no-job": "扫描任务不存在（可能已被清理）",
});

// 最后一行 JSON → { ok, raw } | { ok: false, code }。
export function parseLine(stdout) {
  const lines = String(stdout ?? "").split("\n").filter((l) => l.trim());
  const line = lines[lines.length - 1];
  if (!line || line.length > MAX_OUT_BYTES) return { ok: false, code: "no-output" };
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, code: "bad-output" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "bad-output" };
  if (raw.k === "err") {
    return {
      ok: false,
      code: Object.hasOwn(REMOTE_ERROR_TEXT, raw.code) ? raw.code : "remote-error",
      version: intOrNull(raw.v),
      job: raw.job ? parseJobSummary(raw.job) : null,
    };
  }
  return { ok: true, raw };
}

const JOB_STATES = new Set(["running", "done", "stopped", "error", "lost"]);

export function parseJobSummary(raw) {
  if (!raw || typeof raw !== "object" || !isJobId(raw.id) || !isAbsNormal(raw.root)) return null;
  return {
    id: raw.id,
    kind: raw.kind === "inode" ? "inode" : "tree",
    root: raw.root,
    state: JOB_STATES.has(raw.state) ? raw.state : "error",
    startedAt: ts(raw.startedAt),
    endedAt: ts(raw.endedAt),
    entries: count(raw.entries),
    dirs: count(raw.dirs),
    bytes: count(raw.bytes),
    denied: count(raw.denied),
    errors: count(raw.errors),
    otherFs: count(raw.otherFs),
    estTotal: intOrNull(raw.estTotal),
    current: str(raw.current, 300) ?? "",
    partial: raw.partial === true,
    threshold: count(raw.threshold),
  };
}

function parseJobs(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, JOBS_CAP).map(parseJobSummary).filter(Boolean);
}

function parseMount(m) {
  if (!m || typeof m !== "object" || !isAbsNormal(m.mount)) return null;
  return {
    mount: m.mount,
    device: str(m.device, 256) ?? "",
    fs: str(m.fs, 32) ?? "",
    quota: m.quota === true,
    size: count(m.size),
    used: count(m.used),
    avail: count(m.avail),
    inodes: count(m.inodes),
    iused: count(m.iused),
    error: m.error ? "statvfs" : null,
    inodeScan: parseInodeScan(m.inodeScan),
  };
}

// 能否按 inode 表统计（v2 起 info 附带）：{ ok, fs: { blockSize, inodeSize, … } } | { ok: false, code, detail }。
function parseInodeScan(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.ok !== true) {
    return { ok: false, code: typeof raw.code === "string" && /^[a-z-]{1,32}$/.test(raw.code) ? raw.code : "probe-failed", detail: str(raw.detail, 200) ?? "" };
  }
  const fs = raw.fs && typeof raw.fs === "object" ? raw.fs : {};
  return {
    ok: true,
    fs: {
      blockSize: count(fs.blockSize), inodeSize: count(fs.inodeSize), inodesPerGroup: count(fs.inodesPerGroup),
      groups: count(fs.groups), inodes: count(fs.inodes), logGroupsPerFlex: count(fs.logGroupsPerFlex),
      features: Array.isArray(fs.features) ? fs.features.filter((f) => typeof f === "string" && /^[\w-]{1,32}$/.test(f)).slice(0, 40) : [],
    },
  };
}

function parseChild(c) {
  const name = str(c?.name, 512);
  if (!name || name.includes("/") || name === "." || name === "..") return null;
  return { name, uid: intOrNull(c.uid), owner: str(c.owner, 64), mtime: ts(c.mtime), mount: c.mount === true };
}

export function parseInfo(stdout) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  const r = res.raw;
  if (r.k !== "info") return { ok: false, code: "bad-output" };
  return {
    ok: true,
    info: {
      version: intOrNull(r.v),
      host: str(r.host, 128) ?? "",
      now: ts(r.now),
      roots: (Array.isArray(r.roots) ? r.roots : []).slice(0, 16).filter((x) => isAbsNormal(x?.path)).map((x) => ({
        path: x.path,
        children: Array.isArray(x.children) ? x.children.slice(0, CHILDREN_CAP).map(parseChild).filter(Boolean) : null,
      })),
      mounts: (Array.isArray(r.mounts) ? r.mounts : []).slice(0, MOUNTS_CAP).map(parseMount).filter(Boolean),
      users: (Array.isArray(r.users) ? r.users : []).slice(0, USERS_CAP)
        .filter((u) => str(u?.name, 64) && intOrNull(u.uid) != null)
        // lastLogin：SSH 最后登录（秒）；0 = 从没登录过；null = 服务器端读不到 lastlog 或版本 < 3。
        .map((u) => ({ name: u.name.slice(0, 64), uid: u.uid, home: str(u.home, 512) ?? "", lastLogin: u.lastLogin === 0 ? 0 : ts(u.lastLogin) })),
      repquota: r.repquota === true,
      jobs: parseJobs(r.jobs),
    },
  };
}

export function parseQuota(stdout, { mount }) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  const r = res.raw;
  if (r.k !== "quota" || r.mount !== mount || !Array.isArray(r.rows)) return { ok: false, code: "bad-output" };
  const rows = [];
  for (const row of r.rows.slice(0, USERS_CAP)) {
    if (!Array.isArray(row) || row.length !== 4 || intOrNull(row[0]) == null) continue;
    rows.push({ uid: row[0], name: str(row[1], 64), bytes: count(row[2]), files: count(row[3]) });
  }
  return { ok: true, quota: { mount, at: ts(r.now), rows } };
}

export function parseList(stdout, { path: expect }) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  const r = res.raw;
  if (r.k !== "list" || r.path !== expect || !Array.isArray(r.entries)) return { ok: false, code: "bad-output" };
  const entries = [];
  for (const e of r.entries.slice(0, LIST_CAP)) {
    if (!Array.isArray(e) || e.length !== 8) continue;
    const name = str(e[0]);
    if (!name || name.includes("/") || name === "." || name === "..") continue;
    entries.push({
      name,
      kind: ["d", "f", "l", "o"].includes(e[1]) ? e[1] : "o",
      blocks: count(e[2]),
      size: count(e[3]),
      uid: intOrNull(e[4]),
      owner: str(e[5], 64),
      mtime: ts(e[6]),
      mount: e[7] === 1,
    });
  }
  return { ok: true, list: { path: expect, entries, truncated: r.truncated === true } };
}

export function parseJobReply(stdout) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  const r = res.raw;
  if (!["started", "status"].includes(r.k)) return { ok: false, code: "bad-output" };
  const job = parseJobSummary(r.job);
  return job ? { ok: true, job } : { ok: false, code: "bad-output" };
}

export function parseJobList(stdout) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  return res.raw.k === "jobs" ? { ok: true, jobs: parseJobs(res.raw.jobs) } : { ok: false, code: "bad-output" };
}

// 完整结果：records [[rel, 占用, 逻辑大小, 文件数, 目录数, uid, mtime]]；
// owners [[uid, 占用, 文件数]]；top [[rel, 占用, 逻辑大小, uid, mtime]]；names { uid: 用户名 }。
export function parseScanResult(stdout, { job: expectJob }) {
  const res = parseLine(stdout);
  if (!res.ok) return res;
  const r = res.raw;
  if (r.k !== "result") return { ok: false, code: "bad-output" };
  const job = parseJobSummary(r);
  if (!job || job.id !== expectJob) return { ok: false, code: "bad-output" };
  if (job.state === "running") return { ok: true, job, result: null };
  const records = [];
  for (const rec of (Array.isArray(r.records) ? r.records : []).slice(0, RECORDS_CAP)) {
    if (!Array.isArray(rec) || rec.length !== 7 || !isRelPath(rec[0]) || rec[0] === "") continue;
    records.push([rec[0], count(rec[1]), count(rec[2]), count(rec[3]), count(rec[4]), intOrNull(rec[5]), ts(rec[6])]);
  }
  const owners = [];
  for (const o of (Array.isArray(r.owners) ? r.owners : []).slice(0, OWNERS_CAP)) {
    // [uid, 占用, 文件数, 最新修改时间]；版本 < 3 的结果没有第 4 项（修改时间未知 = null）。
    if (!Array.isArray(o) || (o.length !== 3 && o.length !== 4) || intOrNull(o[0]) == null) continue;
    owners.push([o[0], count(o[1]), count(o[2]), o.length === 4 ? ts(o[3]) ?? 0 : null]);
  }
  const top = [];
  for (const t of (Array.isArray(r.top) ? r.top : []).slice(0, TOP_CAP)) {
    if (!Array.isArray(t) || t.length !== 5 || !isRelPath(t[0]) || t[0] === "") continue;
    top.push([t[0], count(t[1]), count(t[2]), intOrNull(t[3]), ts(t[4])]);
  }
  const names = {};
  if (r.names && typeof r.names === "object" && !Array.isArray(r.names)) {
    for (const [uid, name] of Object.entries(r.names).slice(0, OWNERS_CAP)) {
      if (/^\d{1,10}$/.test(uid) && str(name, 64)) names[uid] = name.slice(0, 64);
    }
  }
  const over = Array.isArray(r.ownersOver) && r.ownersOver.length === 2 ? [count(r.ownersOver[0]), count(r.ownersOver[1])] : [0, 0];
  const rt = Array.isArray(r.rootTotals) && r.rootTotals.length === 4 ? r.rootTotals.map(count) : [job.bytes, 0, 0, 0];
  return { ok: true, job, result: { rootTotals: rt, records, owners, ownersOver: over, top, names } };
}
