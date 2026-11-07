// 编排型作业的子任务游标与累计状态（v2.51）：单文件有界存储，0600 原子写，整次更新串行。
// 与 job-watch.json 分开存放：子任务明细与指标历史体积较大，不能挤掉关注列表与提醒。
// 游标与配对结果必须在同一次写入里落盘，否则重启后会按旧游标重读、重复计数。
import * as nodeFsPromises from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { FORENSICS_JOB_ID_RE } from "./forensics.mjs";

export const SUBRUNS_FILE = "job-subruns.json";
export const SUBRUNS_MAX_BYTES = 1536 * 1024;
export const SUBRUNS_MAX_JOBS = 40;
// 自动关注（v2.62，状态上带 auto: true）的作业另有名额，与自动关注的作业数上限（watch-rules.mjs AUTO_MAX_JOBS）一致：
// 每个自动关注的编排作业都留得住游标，又不占、也挤不掉手动关注那 40 份。合计最多 100 份，字节上限不变。
export const SUBRUNS_MAX_AUTO_JOBS = 60;
const RETENTION_MS = 7 * 86400_000;
const fresh = () => ({ schemaVersion: 1, jobs: [] });
const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (s) => s && typeof s.serverId === "string" && FORENSICS_JOB_ID_RE.test(s.jobId || "") && Number.isFinite(s.updatedAt)
  && s.counts && typeof s.counts === "object" && Array.isArray(s.runs) && Array.isArray(s.gaps) && s.attempts && typeof s.attempts === "object";

const isAuto = (s) => s.auto === true;

function prune(data, now, maxBytes) {
  const live = data.jobs.filter((s) => s.updatedAt >= now - RETENTION_MS).sort((a, b) => a.updatedAt - b.updatedAt);
  const autos = live.filter(isAuto);
  // 自动关注的名额满了先丢已经收尾的（父作业结束、不会再读），还在跑的留到最后：它们的游标丢了下一轮就得从头读。
  const keptAutos = [...autos.filter((s) => s.finalized === true), ...autos.filter((s) => s.finalized !== true)].slice(-SUBRUNS_MAX_AUTO_JOBS);
  // 自动关注的排在前面：下面超字节时从前往后动，先轮到它们。
  data.jobs = [...keptAutos, ...live.filter((s) => !isAuto(s)).slice(-SUBRUNS_MAX_JOBS)];
  while (data.jobs.length && Buffer.byteLength(JSON.stringify(data)) > maxBytes) {
    // 自动关注的先让：它们全都瘦身、丢完之前，不动手动关注的那些。
    const pool = isAuto(data.jobs[0]) ? data.jobs.filter(isAuto) : data.jobs;
    // 先瘦身最久没更新的作业（丢指标历史与已正常结束的明细），仍超限再整条丢掉。
    const slim = pool.find((s) => s.runs.some((r) => r.log?.history?.length || r.status === "ok"));
    if (slim) {
      slim.runs = slim.runs.filter((r) => r.status !== "ok").map((r) => (r.log ? { ...r, log: { ...r.log, history: [] } } : r));
      continue;
    }
    data.jobs.shift();
  }
}

// fs 可注入（node:fs/promises 的形状；测试用它数写盘次数）。log：ops 日志，文件损坏时记一条警告。
export function createSubrunStore({ filePath = null, now = Date.now, maxBytes = SUBRUNS_MAX_BYTES, fs = nodeFsPromises, log = () => {} } = {}) {
  let data = fresh();
  let loaded = null;
  let writing = Promise.resolve();
  // 盘上那份文件的原文（最近一次读到的或写成的）：远端没回传新记录的一轮，候选内容与它逐字节相同，
  // 不重写。与 watch-store 同一个做法——只在读到 / 写成之后更新，写失败不动它。
  let onDisk = null;
  function load() {
    loaded ??= (async () => {
      if (!filePath) return;
      try {
        if ((await fs.stat(filePath)).size > maxBytes) return;
        const raw = await fs.readFile(filePath, "utf8");
        let value;
        try {
          value = JSON.parse(raw);
        } catch (err) {
          // 解析不了：先留档再按空表重来（游标丢了只是下一轮从头读）。
          if (!isParseFailure(err)) throw err;
          await archiveCorruptFile(filePath, { fs, now, log, label: "编排作业子任务游标" });
          return;
        }
        onDisk = raw;
        if (value?.schemaVersion !== 1 || !Array.isArray(value.jobs)) return;
        data = { ...fresh(), jobs: value.jobs.filter(valid) };
        prune(data, now(), maxBytes);
      } catch { data = fresh(); }
    })();
    return loaded;
  }
  async function snapshot() { await load(); await writing.catch(() => {}); return clone(data); }
  // fn 收到可修改的副本；返回值原样传回。持久化失败不替换内存状态（不谎报已推进游标）。
  function update(fn) {
    const next = writing.catch(() => {}).then(async () => {
      await load();
      const candidate = clone(data);
      const result = await fn(candidate);
      prune(candidate, now(), maxBytes);
      const body = filePath ? JSON.stringify(candidate) : null;
      if (filePath && body !== onDisk) {
        await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
        await writeFileAtomic(filePath, body, { fs });
        onDisk = body;
      }
      data = candidate;
      return result;
    });
    writing = next;
    return next;
  }
  return { load, snapshot, update, flush: () => writing };
}
