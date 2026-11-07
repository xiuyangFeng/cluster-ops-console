// 日志按段向前读取（v2.51）的前端状态：关注区「进度依据」与「我的历史」失败诊断各持一份（无 DOM，Node 可直接测）。
//
// 每个（入口, 作业号）记住选中的流（stdout / stderr，或诊断记录里的文件序号），每个流一份读取器：
//   segments（旧 → 新，新读到的更早一段插在最前面）、next（后端回传的游标，原样带回）、atStart、错误与停用状态。
// 游标只由后端给出；前端不拼路径。文件轮转 / 截断 / 改写 / 删除（409 + code）→ 停用旧游标，只提供「从当前末尾重新读取」。
// 换服务器整份清空；迟到响应按代次丢弃。单个读取器最多保留 READBACK_SEGMENTS_MAX 段（内存与页面高度有界）。

export const LOG_READBACK_TIMEOUT_MS = 45000; // 后端要排调度器的 SSH 槽位再跑远端，读接口默认 10 秒不够
export const READBACK_SEGMENTS_MAX = 16; // 16 × 32KB = 512KB
export const CURSOR_INVALID_CODES = Object.freeze(["missing", "rotated", "truncated", "rewritten"]);
const INVALID = new Set(CURSOR_INVALID_CODES);
const LOG_RE = /^(?:stdout|stderr|[0-5])$/;
const JOB_RE = /^\d{1,12}(?:_\d{1,9})?$/;

const offset = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const str = (v) => (typeof v === "string" ? v : "");

function emptyReader(fresh = false) {
  return {
    segments: [], next: null, atStart: false, loading: false, error: "", code: null, stopped: false, capped: false,
    fresh, path: "", size: null, anchorText: "", anchorCheckedAt: null, continuous: true, sameFile: false, notes: [],
  };
}

export function createLogReadback({ getJson, onChange = () => {} } = {}) {
  let serverId = null;
  let generation = 0;
  let entries = new Map(); // `${from}|${jobId}` -> { log, readers: Map(log -> reader) }
  let revision = 0; // 每次状态变化 +1：供面板的跳过重绘判断（memo key）
  const changed = () => { revision += 1; onChange(); };

  const keyOf = (from, jobId) => `${from}|${jobId}`;
  function entry(from, jobId, create = false) {
    const key = keyOf(from, jobId);
    let e = entries.get(key);
    if (!e && create) {
      e = { log: null, readers: new Map() };
      entries.set(key, e);
    }
    return e || null;
  }

  // 渲染用：{ log, readers }（没读过 → log null、readers 空）。
  function view(from, jobId) {
    const e = entry(from, jobId);
    return { log: e?.log ?? null, readers: e?.readers ?? new Map() };
  }

  function apply(reader, res) {
    const start = offset(res?.start);
    const end = offset(res?.end);
    if (start === null || end === null || start > end) throw new Error("响应格式不对");
    reader.segments.unshift({ start, end, text: str(res.text), dropped: offset(res.dropped) ?? 0, noBreak: res.noBreak === true });
    const next = res.next && typeof res.next === "object" ? res.next : null;
    reader.next = next && offset(next.before) ? { before: next.before, ino: str(next.ino), size: offset(next.size), mtimeMs: offset(next.mtimeMs), sig: str(next.sig) || null } : null;
    reader.atStart = res.atStart === true || !reader.next;
    reader.path = str(res.path) || reader.path;
    reader.size = offset(res.size) ?? reader.size;
    reader.sameFile = res.sameFile === true;
    if (reader.segments.length === 1) {
      reader.anchorText = str(res.anchorText);
      reader.anchorCheckedAt = offset(res.anchorCheckedAt);
      reader.continuous = res.continuous === true;
      reader.notes = Array.isArray(res.notes) ? res.notes.filter((n) => typeof n === "string").slice(0, 4) : [];
    }
    reader.capped = !reader.atStart && reader.segments.length >= READBACK_SEGMENTS_MAX;
  }

  async function read(from, jobId, log, { fresh = false } = {}) {
    if (!serverId || typeof getJson !== "function" || !JOB_RE.test(String(jobId)) || !LOG_RE.test(String(log))) return;
    const e = entry(from, jobId, true);
    e.log = log;
    let reader = e.readers.get(log);
    if (!reader || fresh) {
      if (reader?.loading) return;
      reader = emptyReader(fresh);
      e.readers.set(log, reader);
    }
    if (reader.loading || reader.atStart || reader.stopped || reader.capped) return;
    reader.loading = true;
    reader.error = "";
    changed();
    const mine = generation;
    const params = new URLSearchParams({ serverId, jobId: String(jobId), from, log: String(log) });
    if (reader.next) {
      for (const [k, v] of Object.entries(reader.next)) if (v !== null && v !== "") params.set(k, String(v));
    } else if (reader.fresh) params.set("fresh", "1");
    try {
      const res = await getJson(`/api/jobs/log-segment?${params}`, { timeoutMs: LOG_READBACK_TIMEOUT_MS });
      if (mine !== generation) return;
      apply(reader, res);
    } catch (err) {
      if (mine !== generation) return;
      reader.error = err?.serverMessage || err?.message || "读取失败";
      reader.code = typeof err?.code === "string" ? err.code : null;
      // 文件身份变了：旧游标作废，不再沿用（只能从当前末尾重新读取）。
      if (err?.status === 409 && INVALID.has(reader.code)) reader.stopped = true;
    } finally {
      if (mine === generation) {
        reader.loading = false;
        changed();
      }
    }
  }

  function pick(from, jobId, log) {
    if (!LOG_RE.test(String(log))) return;
    const e = entry(from, jobId, true);
    if (e.log === log) return;
    e.log = log;
    changed();
  }

  // 按钮上的 data-lr-*：action = pick | read | restart。
  function handleAction(data = {}) {
    const { lrAction: action, lrFrom: from, lrJob: jobId, lrLog: log } = data;
    if (from !== "watch" && from !== "diagnosis") return;
    if (action === "pick") pick(from, jobId, log);
    else if (action === "read") read(from, jobId, log);
    else if (action === "restart") read(from, jobId, log, { fresh: true });
  }

  function setServer(id) {
    const next = id || null;
    if (next === serverId) return;
    serverId = next;
    generation += 1;
    entries = new Map();
    revision += 1;
  }

  return { view, read, pick, handleAction, setServer, revision: () => revision };
}
