// 简报归档：每天一份定稿快照 runtime/briefs/<YYYY-MM-DD>.json（北京时间日期，单份约 2–4KB）。
// 只保留最近 BRIEF_RETENTION_DAYS 天：每次写入与启动时清理更早的文件，总量上限约 31 × 4KB。
// 今天的简报不落盘（实时生成）；跨过 0 点后由 service 把昨天定稿写进来。
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { offsetDay } from "../usage/time.mjs";

export const BRIEF_RETENTION_DAYS = 31;
// 单份快照的硬上限：正常不到 4KB，超限说明内容异常，拒绝落盘而不是撑大目录。
export const BRIEF_SNAPSHOT_MAX_BYTES = 32 * 1024;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

// log：ops 日志，某天的快照解析不了时记一条警告（先留档为 <日期>.json.corrupt-<北京时间>，再按没有这一天处理）。
export function createBriefStore({ dir, retentionDays = BRIEF_RETENTION_DAYS, now = Date.now, log = () => {} }) {
  async function listDays() {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    return names.map((name) => FILE_RE.exec(name)?.[1]).filter(Boolean).sort().reverse();
  }

  async function read(day) {
    if (!DAY_RE.test(String(day || ""))) return null;
    const file = path.join(dir, `${day}.json`);
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && parsed.day === day ? parsed : null;
    } catch (err) {
      if (isParseFailure(err)) await archiveCorruptFile(file, { now, log, label: `${day} 的简报`, action: "按没有这一天的简报处理" });
      return null;
    }
  }

  // 保留 [today - retentionDays + 1, today] 之内、且按日期最新的 retentionDays 份；其余删除。
  async function prune(today) {
    const days = await listDays();
    const oldestKept = offsetDay(today, 1 - retentionDays);
    const removed = [];
    for (const [index, day] of days.entries()) {
      if (index < retentionDays && day >= oldestKept) continue;
      try {
        await unlink(path.join(dir, `${day}.json`));
        removed.push(day);
      } catch {}
    }
    return removed;
  }

  async function write(brief, { today }) {
    if (!brief || !DAY_RE.test(String(brief.day || ""))) return false;
    const body = JSON.stringify(brief);
    if (Buffer.byteLength(body) > BRIEF_SNAPSHOT_MAX_BYTES) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(path.join(dir, `${brief.day}.json`), body);
    await prune(today);
    return true;
  }

  return { listDays, read, write, prune };
}
