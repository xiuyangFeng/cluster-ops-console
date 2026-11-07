// 管理员存储视图：本机存储。目录 <runtime>/storage-admin/（0700），文件一律 0600 原子写。
//   state.json                  每台机器最近一次 info / 各挂载点的配额 / 最近一次出错 / 扫描任务简表
//   scans/<机器 id>/<任务号>.json  完整扫描结果（每台最多保留 SCANS_PER_TARGET 份，超出删最旧）
// 只存目录名、用户名与数字，不存任何文件内容。
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { isBoundedServerId } from "../validators.mjs";
import { isJobId } from "./protocol.mjs";

export const STORAGE_ADMIN_DIR = "storage-admin";
export const SCANS_PER_TARGET = 6;
const STATE_MAX_BYTES = 8 * 1024 * 1024;
const SCAN_MAX_BYTES = 32 * 1024 * 1024;
const SCHEMA = 1;

const fresh = () => ({ schemaVersion: SCHEMA, targets: {} });

export function createStorageAdminStore({ dir = null } = {}) {
  let state = fresh();
  let loaded = null;
  let writing = Promise.resolve();
  const statePath = dir ? path.join(dir, "state.json") : null;
  const scanDir = (targetId) => path.join(dir, "scans", targetId);

  function load() {
    loaded ??= (async () => {
      if (!statePath) return;
      try {
        if ((await stat(statePath)).size > STATE_MAX_BYTES) return;
        const value = JSON.parse(await readFile(statePath, "utf8"));
        if (value?.schemaVersion === SCHEMA && value.targets && typeof value.targets === "object") {
          for (const [id, t] of Object.entries(value.targets)) {
            if (isBoundedServerId(id) && t && typeof t === "object") state.targets[id] = t;
          }
        }
      } catch {
        state = fresh();
      }
    })();
    return loaded;
  }

  function persist() {
    const next = writing.catch(() => {}).then(async () => {
      if (!statePath) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFileAtomic(statePath, JSON.stringify(state));
    });
    writing = next;
    return next;
  }

  async function getTarget(id) {
    await load();
    return structuredClone(state.targets[id] || {});
  }

  // patch：浅合并到该机器的状态（info / infoAt / error / quota / jobs）。
  async function patchTarget(id, patch) {
    if (!isBoundedServerId(id)) throw new Error("bad target id");
    await load();
    state.targets[id] = { ...(state.targets[id] || {}), ...structuredClone(patch) };
    await persist();
    return structuredClone(state.targets[id]);
  }

  async function putScan(targetId, entry) {
    if (!isBoundedServerId(targetId) || !isJobId(entry?.job?.id)) throw new Error("bad scan entry");
    if (!dir) return;
    const d = scanDir(targetId);
    await mkdir(d, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path.join(d, `${entry.job.id}.json`), JSON.stringify(entry));
    const names = (await readdir(d)).filter((n) => n.endsWith(".json") && isJobId(n.slice(0, -5))).sort().reverse();
    for (const name of names.slice(SCANS_PER_TARGET)) await rm(path.join(d, name), { force: true });
    return names.slice(0, SCANS_PER_TARGET).map((n) => n.slice(0, -5));
  }

  async function getScan(targetId, jobId) {
    if (!dir || !isBoundedServerId(targetId) || !isJobId(jobId)) return null;
    try {
      const file = path.join(scanDir(targetId), `${jobId}.json`);
      if ((await stat(file)).size > SCAN_MAX_BYTES) return null;
      const value = JSON.parse(await readFile(file, "utf8"));
      return value?.job?.id === jobId && value.result ? value : null;
    } catch {
      return null;
    }
  }

  return { load, getTarget, patchTarget, putScan, getScan, flush: () => writing };
}
