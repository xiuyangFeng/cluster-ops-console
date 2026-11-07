// 运行时 JSON 存储读到坏文件时的留档（v2.64）：先把坏文件改名留下来，再由调用方按空表重建。
//
// 以前各存储读到解析不了的文件（半截、手改坏、磁盘出错）就当空表重来，下一次写盘把它盖掉——
// 关注规则、作业登记、事件记录这些只存在本机的东西就这么没了，事后也查不出是什么坏了。现在统一走这里：
//   1. 原文件改名为 `<名字>.corrupt-<北京时间 YYYYMMDD-HHMMSS>`（同一秒撞名再加 -2、-3 …），改名后权限收紧到 0600；
//   2. 同一个文件的留档最多留 2 份，多出来的从最旧的删；
//   3. 经调用方自己的 logger 写一条 ops 警告（event: "store-corrupt"）；
//   4. 调用方照旧按空表重建（或像代理口令那样重新生成）。
// 留档放在原文件旁边（runtime/ 里），计入存储预算：storage-sweeper 把它们单列为 corrupt，超预算时排在多余日志分卷之后先清。
//
// 各存储只在「解析失败」（JSON.parse 抛 SyntaxError，isParseFailure）时调用；形状不对、版本不认识、超大的文件照旧处理。
// 例外是代理口令：那份文件认不出（任何原因）就要重新生成口令、整份盖掉，所以盖掉之前一律先留档。
// 日志里不带解析错误的原文：V8 的 JSON 报错会摘一段文件内容（代理口令文件里就是口令）。
// 改名失败（文件已经不在、没权限）只记警告、返回 archived: null，不影响调用方继续。
//
// 不放进 atomic-file.mjs：那个文件在 supervisor 与本机代理的热更新指纹闭包里；用到这里的都是控制面的存储，
// 放这里改动不会让数据面多一次交接。
import nodeFs from "node:fs";
import nodeFsPromises from "node:fs/promises";
import path from "node:path";

import { BEIJING_OFFSET_MS } from "./beijing-time.mjs";

export const CORRUPT_ARCHIVE_KEEP = 2;
export const CORRUPT_EVENT = "store-corrupt";
const ARCHIVE_MARK = ".corrupt-";
// <名字>.corrupt-YYYYMMDD-HHMMSS[-N]
const ARCHIVE_SUFFIX_RE = /\.corrupt-(\d{8}-\d{6})(?:-(\d{1,4}))?$/;

const pad = (n) => String(n).padStart(2, "0");

// epoch 毫秒 → 北京时间 YYYYMMDD-HHMMSS（与本机时区无关）。
export function corruptStamp(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

// 文件名是不是某个文件的留档（任何文件的）。
export function isCorruptArchiveName(name) {
  return ARCHIVE_SUFFIX_RE.test(String(name || ""));
}

// 留档名里的排序键：[时间戳, 序号]；不是留档 → null。
export function corruptArchiveKey(name) {
  const match = ARCHIVE_SUFFIX_RE.exec(String(name || ""));
  return match ? [match[1], match[2] ? Number(match[2]) : 1] : null;
}

// 这个错误是不是「内容解析不了」（区别于不存在 / 没权限这类读错误）。
export function isParseFailure(error) {
  return error instanceof SyntaxError;
}

// 纯函数：这次的留档名（同一秒已有同名留档就加 -2、-3 …）。
export function archiveNameFor(baseName, stamp, existingNames = []) {
  const taken = new Set(existingNames);
  const first = `${baseName}${ARCHIVE_MARK}${stamp}`;
  if (!taken.has(first)) return first;
  for (let n = 2; n < 10000; n += 1) {
    const name = `${first}-${n}`;
    if (!taken.has(name)) return name;
  }
  return `${first}-${Date.now()}`;
}

// 纯函数：baseName 的留档里，保留最新 keep 份之外的那些（旧 → 新）。
export function staleArchives(baseName, names, keep = CORRUPT_ARCHIVE_KEEP) {
  const prefix = `${baseName}${ARCHIVE_MARK}`;
  const mine = names
    .map((name) => ({ name, key: name.startsWith(prefix) ? corruptArchiveKey(name) : null }))
    // 只认 <名字>.corrupt-<时间戳>[-N] 本身：别的文件的留档（名字恰好以它开头）不算。
    .filter(({ name, key }) => key && /^\d{8}-\d{6}(?:-\d{1,4})?$/.test(name.slice(prefix.length)))
    .sort((a, b) => (a.key[0] < b.key[0] ? -1 : a.key[0] > b.key[0] ? 1 : a.key[1] - b.key[1]));
  return mine.slice(0, Math.max(0, mine.length - Math.max(0, keep))).map((item) => item.name);
}

function describe(baseName, archiveName, { label, problem, action }) {
  const what = label ? `${label}（${baseName}）` : baseName;
  return archiveName
    ? `${what}${problem}，原文件已留档为 ${archiveName}，${action}`
    : `${what}${problem}，留档没有成功，${action}`;
}

// 共同的收尾：日志与返回值。
function report(log, filePath, archiveName, removed, options, error = null) {
  const baseName = path.basename(filePath);
  try {
    log(describe(baseName, archiveName, options), {
      level: "warn",
      event: CORRUPT_EVENT,
      file: baseName,
      archive: archiveName,
      removed: removed.length,
      ...(error ? { error: error.code || "error" } : {}),
    });
  } catch {}
  return { archived: archiveName ? path.join(path.dirname(filePath), archiveName) : null, removed };
}

// 异步版（node:fs/promises 的形状）。fs 可以只给一部分方法，缺的用 node 自带的。
//   label   日志里这份文件叫什么（如「作业关注」），缺省只写文件名
//   problem 坏在哪，缺省「不是有效的 JSON」（只放固定说法与代号，不放文件内容）
//   action  之后会怎么做，缺省「按空表重建」
// → { archived: 留档的完整路径 | null, removed: [删掉的旧留档名] }
export async function archiveCorruptFile(filePath, {
  fs = nodeFsPromises,
  now = Date.now,
  keep = CORRUPT_ARCHIVE_KEEP,
  log = () => {},
  label = "",
  problem = "不是有效的 JSON",
  action = "按空表重建",
} = {}) {
  const io = { ...nodeFsPromises, ...fs };
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  let names = [];
  try { names = (await io.readdir(dir)).map(String); } catch {}
  const archiveName = archiveNameFor(baseName, corruptStamp(now()), names);
  try {
    await io.rename(filePath, path.join(dir, archiveName));
  } catch (error) {
    return report(log, filePath, null, [], { label, problem, action }, error);
  }
  try { await io.chmod(path.join(dir, archiveName), 0o600); } catch {}
  const removed = [];
  for (const name of staleArchives(baseName, [...names, archiveName], keep)) {
    try {
      await io.unlink(path.join(dir, name));
      removed.push(name);
    } catch {}
  }
  return report(log, filePath, archiveName, removed, { label, problem, action });
}

// 同步版（node:fs 的形状），给同步读盘的存储用（指标、接入引导进度、代理口令）。
export function archiveCorruptFileSync(filePath, {
  fs = nodeFs,
  now = Date.now,
  keep = CORRUPT_ARCHIVE_KEEP,
  log = () => {},
  label = "",
  problem = "不是有效的 JSON",
  action = "按空表重建",
} = {}) {
  const io = {
    readdirSync: fs.readdirSync ?? nodeFs.readdirSync,
    renameSync: fs.renameSync ?? nodeFs.renameSync,
    chmodSync: fs.chmodSync ?? nodeFs.chmodSync,
    unlinkSync: fs.unlinkSync ?? nodeFs.unlinkSync,
  };
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  let names = [];
  try { names = io.readdirSync(dir).map(String); } catch {}
  const archiveName = archiveNameFor(baseName, corruptStamp(now()), names);
  try {
    io.renameSync(filePath, path.join(dir, archiveName));
  } catch (error) {
    return report(log, filePath, null, [], { label, problem, action }, error);
  }
  try { io.chmodSync(path.join(dir, archiveName), 0o600); } catch {}
  const removed = [];
  for (const name of staleArchives(baseName, [...names, archiveName], keep)) {
    try {
      io.unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {}
  }
  return report(log, filePath, archiveName, removed, { label, problem, action });
}
