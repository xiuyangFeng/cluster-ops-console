// incidents/persister.mjs —— 事件存储的落盘调度（修订号门控 + 拆分文件）。
//
// 只做 I/O 与节奏：什么时候写、写哪份文件、崩溃窗口怎么收敛；事件本身的合并/恢复/
// 序列化规则都在 store.mjs，这里只调用 store 暴露的 serialize* / loadSnapshot / 修订号。

import { readFile as fsReadFile, rename as fsRename, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";

import { writeFileAtomic } from "../atomic-file.mjs";
import { archiveCorruptFile, isParseFailure } from "../corrupt-archive.mjs";
import { INCIDENT_SCHEMA_VERSION } from "./store.mjs";

// 保存节奏：结构性变化（打开/升级/关闭/提醒偏好）2s 内落盘；
// 仅次数/lastSeenAt/证据累加的变化合并到较长的去抖窗口。
export const INCIDENT_SAVE_URGENT_DELAY_MS = 2000;
export const INCIDENT_SAVE_MINOR_DELAY_MS = 45000;

// ---- 落盘调度（修订号门控 + 拆分文件）----
//
// 只在 store 的持久化修订号变化时写盘：
//   - urgentRevision / closedRevision 变化 → urgentDelayMs（默认 2s）内保存；
//   - 仅 revision 变化（次数/lastSeenAt/证据累加）→ minorDelayMs（默认 45s）内保存；
//   - closedRevision 变化才重写已关闭文件，否则只写主文件。
// 写入顺序：先已关闭文件、后主文件——两者在同一同步点序列化，崩溃窗口里最多
// 出现"已关闭文件已含、主文件仍把它列为活跃"，加载时以已关闭版本去重。
function incidentClosedPathFor(filePath) {
  return filePath.endsWith(".json") ? `${filePath.slice(0, -".json".length)}-closed.json` : `${filePath}.closed`;
}

export function createIncidentPersister({
  store,
  filePath,
  closedFilePath = filePath ? incidentClosedPathFor(filePath) : null,
  urgentDelayMs = INCIDENT_SAVE_URGENT_DELAY_MS,
  minorDelayMs = INCIDENT_SAVE_MINOR_DELAY_MS,
  io = { readFile: fsReadFile, writeFile: fsWriteFile, rename: fsRename, unlink: fsUnlink },
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
} = {}) {
  if (!store || !filePath) throw new TypeError("incident persister requires store and filePath");
  let saved = store.getPersistRevisions();
  let timer = null;
  let timerDue = Infinity;
  let queue = Promise.resolve();
  let closing = false;
  const stats = { mainWrites: 0, closedWrites: 0, skipped: 0, errors: 0 };

  const isDirty = () => {
    const cur = store.getPersistRevisions();
    return cur.revision !== saved.revision || cur.closedRevision !== saved.closedRevision;
  };
  const isUrgentDirty = () => {
    const cur = store.getPersistRevisions();
    return cur.urgentRevision !== saved.urgentRevision || cur.closedRevision !== saved.closedRevision;
  };

  function cancelTimer() {
    if (timer) clearTimer(timer);
    timer = null;
    timerDue = Infinity;
  }

  function schedule() {
    if (closing || !isDirty()) return;
    const delay = isUrgentDirty() ? urgentDelayMs : minorDelayMs;
    const due = now() + delay;
    // 已有更早的定时器就沿用；更紧急的变化把长去抖提前。
    if (timer && timerDue <= due) return;
    cancelTimer();
    timerDue = due;
    timer = setTimer(() => {
      timer = null;
      timerDue = Infinity;
      flush().catch(() => {});
    }, delay);
    timer?.unref?.();
  }

  // 串行化保存；干净时不写。解析为 true 表示本次确有写盘，失败时 reject。
  function flush() {
    cancelTimer();
    const pending = queue.then(async () => {
      if (!isDirty()) {
        stats.skipped += 1;
        return false;
      }
      // 同一同步点捕获修订号并序列化两份文件，保证彼此一致。
      const cur = store.getPersistRevisions();
      const closedJson = cur.closedRevision !== saved.closedRevision ? store.serializeClosedForSave() : null;
      const mainJson = store.serializeMainForSave();
      if (closedJson != null) {
        await writeFileAtomic(closedFilePath, closedJson, { fs: io });
        stats.closedWrites += 1;
        saved = { ...saved, closedRevision: cur.closedRevision };
      }
      await writeFileAtomic(filePath, mainJson, { fs: io });
      stats.mainWrites += 1;
      saved = cur;
      return true;
    });
    queue = pending.catch((err) => {
      stats.errors += 1;
      log(`incident save failed: ${err.message}`);
    }).then(() => {
      // 写盘期间又有变化（或本次失败）→ 按变化类型重新排期。
      if (!closing && isDirty()) schedule();
    });
    return pending;
  }

  // 读主文件 + 已关闭文件；任一缺失/损坏按空处理（与旧行为一致：不抛）。损坏（解析不了）的先留档
  //（<名字>.corrupt-<北京时间>，corrupt-archive.mjs）并记一条警告，再按空处理——下一次保存不再把它悄悄盖掉。
  // 旧版单文件（内嵌 closed）读入后标记脏，下一次保存迁移为拆分格式。
  async function load() {
    const readJson = async (target) => {
      let text;
      try { text = await io.readFile(target, "utf8"); } catch { return null; }
      try {
        return JSON.parse(text);
      } catch (err) {
        if (isParseFailure(err)) await archiveCorruptFile(target, { fs: io, now, log, label: "事件记录" });
        return null;
      }
    };
    const main = await readJson(filePath);
    const closedRaw = await readJson(closedFilePath);
    const info = store.loadSnapshot(main || { schemaVersion: INCIDENT_SCHEMA_VERSION }, { closed: closedRaw });
    saved = store.getPersistRevisions();
    if (info.legacyClosed) {
      saved = { revision: -1, urgentRevision: -1, closedRevision: -1 };
      schedule();
    } else if (info.closedTrimmed || info.dayCountsBackfilled) {
      // 读回的已关闭集合超额（按指纹限额/全局上限裁剪过），或已关闭文件是旧版本写的、没有逐日计数
      //（刚按留存记录回填过）：尽快把结果写回两份文件。回填不落盘的话，下次启动又要重新回填，
      // 而那时留存记录可能已被新事件挤掉，「逐日计数开始时刻」也会跟着后移。
      saved = { ...saved, closedRevision: -1 };
      schedule();
    }
    return info;
  }

  // 优雅退出：停止排期，排在所有在途保存之后做最后一次（仅在脏时）落盘。
  function close() {
    closing = true;
    return flush();
  }

  const unsubscribe = store.onPersistChange(schedule);

  return {
    load,
    schedule,
    flush,
    close,
    isDirty,
    isUrgentDirty,
    dispose: () => { closing = true; cancelTimer(); unsubscribe(); },
    stats: () => ({ ...stats, pendingTimer: Boolean(timer) }),
    closedFilePath,
  };
}
