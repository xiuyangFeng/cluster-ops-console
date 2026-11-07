// 磁盘增长归因：测量结果的本机存储 runtime/disk-growth.json。单文件有界（≤ 256 KB）、0600 原子写、
// 整次更新串行、内容没变不重写。只存目录名与数字，不存文件内容。
//
// 形状：{ schemaVersion: 1, servers: { <serverId>: {
//   home, homeEnv, homeAt,        家目录的物理路径、与它不同时的 $HOME 原值、探到的时刻（探一次，之后复用）
//   roots: [{ root, jobs }],      最近一次从作业登记推出的集合目录（相对 $HOME）
//   attempt: { at, outcome, error },   最近一次尝试：ok | partial（没量完）| error | no-roots（没有集合目录）
//   measurements: [<测量>] } } }   按时刻升序，形状见 model.mjs
//
// 保留：每台服务器最近 14 天、最多 80 次。超出条数或整份超过 256 KB 时删「时间上最密」的那一次
// （它前后两次挨得最近，删了丢的信息最少），优先动 48 小时以前的——近 48 小时的要拿来算「近 24 小时增长」。
// 配置里已经删掉的服务器不主动清：测量 14 天后自己过期，剩下的家目录与集合目录只有几百字节
// （不拿「这次读到的配置里没有它」当删除指令——配置读取降级时会误删）。
// 读回的文件一律当不可信数据：字段白名单、字符串截断、条目数封顶，坏的整条丢弃；整份解析不了的先留档（corrupt-archive.mjs）。
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { isValidRelPath } from "../dir-usage/scan.mjs";
import { isBoundedServerId } from "../validators.mjs";
import { COLLECTION_MAX } from "./collections.mjs";
import { isListableName, KEEP_CHILDREN } from "./model.mjs";

export const DISK_GROWTH_FILE = "disk-growth.json";
export const DISK_GROWTH_SCHEMA_VERSION = 1;
export const DISK_GROWTH_MAX_BYTES = 256 * 1024;
export const DISK_GROWTH_RETENTION_MS = 14 * 24 * 3600_000;
export const DISK_GROWTH_MAX_MEASUREMENTS = 80;
const RECENT_MS = 48 * 3600_000;
const MAX_SERVERS = 32;
const ROOT_MAX_LENGTH = 1024;
const TRIGGERS = new Set(["schedule", "disk", "manual"]);
const STOPS = new Set(["deadline", "error", "stopped"]);
const STATES = new Set(["ok", "partial", "skipped", "error"]);
const OUTCOMES = new Set(["ok", "partial", "error", "no-roots"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符就是要挡掉的
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const time = (value) => (Number.isFinite(value) && value > 0 && value < 8.64e15 ? value : null);
const count = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0);

// 家目录路径：绝对路径、不是 /、没有控制字符；结尾的斜杠去掉。
export function cleanHomePath(value) {
  if (typeof value !== "string" || value.length > 1024 || CONTROL_RE.test(value)) return null;
  const trimmed = value.replace(/\/+$/, "");
  return trimmed.startsWith("/") && trimmed.length > 1 ? trimmed : null;
}

const cleanRoot = (value) => (typeof value === "string" && value !== "" && isValidRelPath(value, ROOT_MAX_LENGTH) && !CONTROL_RE.test(value) ? value : null);

function cleanFound(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const root = cleanRoot(item?.root);
    if (!root || out.some((seen) => seen.root === root)) continue;
    out.push({ root, jobs: count(item.jobs) });
    if (out.length >= COLLECTION_MAX) break;
  }
  return out;
}

function cleanResult(raw) {
  const root = cleanRoot(raw?.root);
  const at = time(raw?.at);
  if (!root || at == null || !STATES.has(raw.state)) return null;
  const c = [];
  for (const child of Array.isArray(raw.c) ? raw.c : []) {
    if (!Array.isArray(child) || !isListableName(child[0]) || !Number.isFinite(child[1]) || child[1] < 0) continue;
    if (c.some((seen) => seen[0] === child[0])) continue;
    c.push([child[0], count(child[1]), child[2] ? 1 : 0]);
    if (c.length >= KEEP_CHILDREN) break;
  }
  const o = Array.isArray(raw.o) ? raw.o : [];
  return {
    root,
    jobs: count(raw.jobs),
    at,
    state: raw.state,
    error: typeof raw.error === "string" && /^[a-z-]{1,32}$/.test(raw.error) ? raw.error : null,
    c,
    o: [count(o[0]), count(o[1]), count(o[2]), o[3] ? 1 : 0],
  };
}

function cleanDisk(raw) {
  if (!raw || typeof raw !== "object") return null;
  const used = Number.isFinite(raw.used) && raw.used >= 0 ? raw.used : null;
  const total = Number.isFinite(raw.total) && raw.total > 0 ? raw.total : null;
  const pct = Number.isFinite(raw.pct) && raw.pct >= 0 && raw.pct <= 100 ? raw.pct : null;
  return used == null && pct == null ? null : { used, total, pct };
}

export function cleanMeasurement(raw) {
  const at = time(raw?.at);
  if (at == null) return null;
  const roots = [];
  for (const item of Array.isArray(raw.roots) ? raw.roots : []) {
    const result = cleanResult(item);
    if (!result || roots.some((seen) => seen.root === result.root)) continue;
    roots.push(result);
    if (roots.length >= COLLECTION_MAX) break;
  }
  if (!roots.length) return null;
  return {
    at,
    startedAt: time(raw.startedAt) ?? at,
    trigger: TRIGGERS.has(raw.trigger) ? raw.trigger : "schedule",
    complete: raw.complete === true,
    stop: STOPS.has(raw.stop) ? raw.stop : null,
    rounds: count(raw.rounds),
    disk: cleanDisk(raw.disk),
    roots,
  };
}

function cleanAttempt(raw) {
  const at = time(raw?.at);
  if (at == null || !OUTCOMES.has(raw.outcome)) return null;
  return { at, outcome: raw.outcome, error: typeof raw.error === "string" && raw.error ? raw.error.slice(0, 300) : null };
}

function cleanServer(raw) {
  const home = cleanHomePath(raw?.home);
  const homeEnv = cleanHomePath(raw?.homeEnv);
  const measurements = (Array.isArray(raw?.measurements) ? raw.measurements : []).map(cleanMeasurement).filter(Boolean).sort((a, b) => a.at - b.at);
  return { home, homeEnv: homeEnv && homeEnv !== home ? homeEnv : null, homeAt: home ? time(raw?.homeAt) : null, roots: cleanFound(raw?.roots), attempt: cleanAttempt(raw?.attempt), measurements };
}

// 删掉一次测量；删不动（只剩最近那一次）→ false。最近的一次永远留着。
function thin(list) {
  if (list.length <= 1) return false;
  const latestAt = list.at(-1).at;
  const candidates = list.map((_, index) => index).slice(0, -1);
  const old = candidates.filter((index) => latestAt - list[index].at > RECENT_MS);
  const pool = (old.length ? old : candidates).filter((index) => index > 0);
  let pick = 0;
  let gap = Infinity;
  for (const index of pool) {
    const span = list[index + 1].at - list[index - 1].at;
    if (span < gap) {
      gap = span;
      pick = index;
    }
  }
  list.splice(pick, 1);
  return true;
}

function prune(data, { nowMs, maxBytes }) {
  for (const [serverId, entry] of Object.entries(data.servers)) {
    entry.measurements = entry.measurements.filter((item) => nowMs - item.at <= DISK_GROWTH_RETENTION_MS);
    while (entry.measurements.length > DISK_GROWTH_MAX_MEASUREMENTS) thin(entry.measurements);
    if (!entry.home && !entry.roots.length && !entry.attempt && !entry.measurements.length) delete data.servers[serverId];
  }
  while (Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
    const busiest = Object.values(data.servers).sort((a, b) => b.measurements.length - a.measurements.length)[0];
    if (!busiest?.measurements.length) break;
    // 每台都只剩一次还放不下（目录名极长的病态情况）：连最近的一次也删。
    if (!thin(busiest.measurements)) busiest.measurements.length = 0;
  }
}

const fresh = () => ({ schemaVersion: DISK_GROWTH_SCHEMA_VERSION, servers: {} });
const emptyServer = () => ({ home: null, homeEnv: null, homeAt: null, roots: [], attempt: null, measurements: [] });

// filePath 为 null：只在内存里（测试 / 未接存储的装配）。
export function createDiskGrowthStore({ filePath = null, maxBytes = DISK_GROWTH_MAX_BYTES, now = Date.now, log = () => {} } = {}) {
  let data = fresh();
  let written = null; // 磁盘上现在的内容；与要写的一样就不写
  let loaded = null;
  let writing = Promise.resolve();

  function load() {
    loaded ??= (async () => {
      if (!filePath) return;
      try {
        if ((await stat(filePath)).size > maxBytes * 2) return;
        const text = await readFile(filePath, "utf8");
        let value;
        try {
          value = JSON.parse(text);
        } catch (err) {
          // 内容坏了：先留档再按空表重来（下次写盘写新文件）。
          if (!isParseFailure(err)) throw err;
          await archiveCorruptFile(filePath, { now, log, label: "磁盘增长归因" });
          return;
        }
        if (value?.schemaVersion !== DISK_GROWTH_SCHEMA_VERSION || !value.servers || typeof value.servers !== "object" || Array.isArray(value.servers)) return;
        const next = fresh();
        for (const [serverId, raw] of Object.entries(value.servers).slice(0, MAX_SERVERS)) {
          if (isBoundedServerId(serverId)) next.servers[serverId] = cleanServer(raw);
        }
        prune(next, { nowMs: now(), maxBytes });
        data = next;
        written = text;
      } catch (err) {
        // 不存在是常态；读不出（权限等）当空表重来（下次写盘覆盖）。
        if (err?.code !== "ENOENT") log(`disk growth store unreadable, starting empty: ${err.message}`, { level: "warn", event: "disk-growth" });
      }
    })();
    return loaded;
  }

  // 一台服务器的记录（副本）；没有 → null。
  async function get(serverId) {
    await load();
    await writing;
    const entry = data.servers[serverId];
    return entry ? structuredClone(entry) : null;
  }

  // 改一台服务器的记录：mutate(draft) 就地改（draft 是副本，没有记录时是一条空的）。
  // 改完重新清洗、按保留规则裁剪；内容与磁盘上的一样就不写。内存里的状态先行——写盘失败只记日志，
  // 不让调用方以为没量过又去量一遍。
  function update(serverId, mutate) {
    const next = writing.then(async () => {
      await load();
      if (!isBoundedServerId(serverId)) return;
      const draft = structuredClone(data.servers[serverId] || emptyServer());
      mutate(draft);
      const candidate = { ...data, servers: { ...data.servers, [serverId]: cleanServer(draft) } };
      if (Object.keys(candidate.servers).length > MAX_SERVERS) return;
      prune(candidate, { nowMs: now(), maxBytes });
      data = candidate;
      await persist();
    });
    writing = next.catch(() => {});
    return next;
  }

  async function persist() {
    if (!filePath) return;
    const body = JSON.stringify(data);
    if (body === written) return;
    try {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await writeFileAtomic(filePath, body);
      written = body;
    } catch (err) {
      log(`disk growth store write failed: ${err.message}`, { level: "warn", event: "disk-growth" });
    }
  }

  return { load, get, update, flush: () => writing };
}
