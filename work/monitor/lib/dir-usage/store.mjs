// 本人目录占用：扫描游标与部分结果的本机存储。单文件有界、0600 原子写、整次更新串行。
//
// 每条记录 = 一台服务器 × 一个扫描根（相对 $HOME）。每台最多保留 6 个扫描根、全部最多 24 条，
// 超出按最近更新时间淘汰；整份超过 8MB 时继续淘汰最旧的记录。只存目录名与数字，不存文件内容。
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { isBoundedServerId } from "../validators.mjs";
import { DIR_USAGE_SCHEMA_VERSION } from "./model.mjs";
import { isValidRelPath } from "./scan.mjs";

export const DIR_USAGE_FILE = "dir-usage.json";
export const DIR_USAGE_MAX_BYTES = 8 * 1024 * 1024;
export const DIR_USAGE_MAX_ROOTS_PER_SERVER = 6;
export const DIR_USAGE_MAX_RECORDS = 24;

const fresh = () => ({ schemaVersion: DIR_USAGE_SCHEMA_VERSION, records: [] });

function isRecord(r) {
  return Boolean(r) && typeof r === "object" && isBoundedServerId(r.serverId) && isValidRelPath(r.root) &&
    Number.isFinite(r.updatedAt) && Array.isArray(r.pending) && r.agg1 && typeof r.agg1 === "object" &&
    r.agg2 && typeof r.agg2 === "object" && Array.isArray(r.top) && Array.isArray(r.agg1Over) && Array.isArray(r.rootFiles);
}

function prune(data, maxBytes) {
  data.records.sort((a, b) => b.updatedAt - a.updatedAt);
  const perServer = new Map();
  data.records = data.records.filter((r) => {
    const n = (perServer.get(r.serverId) || 0) + 1;
    perServer.set(r.serverId, n);
    return n <= DIR_USAGE_MAX_ROOTS_PER_SERVER;
  }).slice(0, DIR_USAGE_MAX_RECORDS);
  // 最新一条始终保留（单条本身已由各项上限约束在约 2MB 内）。
  while (data.records.length > 1 && Buffer.byteLength(JSON.stringify(data)) > maxBytes) data.records.pop();
}

// log：ops 日志，文件损坏时记一条警告。
export function createDirUsageStore({ filePath = null, maxBytes = DIR_USAGE_MAX_BYTES, now = Date.now, log = () => {} } = {}) {
  let data = fresh();
  let loaded = null;
  let writing = Promise.resolve();

  function load() {
    loaded ??= (async () => {
      if (!filePath) return;
      try {
        if ((await stat(filePath)).size > maxBytes) return;
        let value;
        try {
          value = JSON.parse(await readFile(filePath, "utf8"));
        } catch (err) {
          // 解析不了：先留档再按空表重来（扫描结果可以重扫）；读不出照旧当空表。
          if (!isParseFailure(err)) throw err;
          await archiveCorruptFile(filePath, { now, log, label: "目录占用扫描" });
          return;
        }
        if (value?.schemaVersion !== DIR_USAGE_SCHEMA_VERSION || !Array.isArray(value.records)) return;
        data = { ...fresh(), records: value.records.filter(isRecord) };
        prune(data, maxBytes);
      } catch { data = fresh(); }
    })();
    return loaded;
  }

  async function get(serverId, root) {
    await load();
    await writing.catch(() => {});
    const r = data.records.find((x) => x.serverId === serverId && x.root === root);
    return r ? structuredClone(r) : null;
  }

  // 该服务器最近更新的记录（展开时默认显示它）与全部已存扫描根的简表。
  async function list(serverId) {
    await load();
    await writing.catch(() => {});
    return data.records
      .filter((r) => r.serverId === serverId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => ({ root: r.root, updatedAt: r.updatedAt, complete: r.complete === true }));
  }

  function put(serverId, record) {
    const next = writing.catch(() => {}).then(async () => {
      await load();
      const candidate = { ...data, records: data.records.filter((r) => !(r.serverId === serverId && r.root === record.root)) };
      candidate.records.push({ ...structuredClone(record), serverId });
      prune(candidate, maxBytes);
      if (filePath) {
        await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFileAtomic(filePath, JSON.stringify(candidate));
      }
      data = candidate; // 持久化失败不谎报成功
    });
    writing = next;
    return next;
  }

  return { load, get, list, put, flush: () => writing };
}
