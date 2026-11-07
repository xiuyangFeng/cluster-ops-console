// 接入引导的进度（runtime/onboarding-guide.json，0600）：中途关掉工作台再开，从断点继续。
//
// 只存"走到哪一步、每步什么结果"和表单里的用户名 / 地址——密码、扫描到的主机密钥原文、公钥内容
// 都只在内存里，不写进这个文件。重启后正在跑 / 正在等回答的步骤一律回到"已暂停"，由用户点继续
// （每一步都是幂等的，重跑不会多写东西）。
import nodeFs from "node:fs";
import { writePrivateFileAtomicSync } from "../atomic-file.mjs";
import { archiveCorruptFileSync, isParseFailure } from "../corrupt-archive.mjs";

export const GUIDE_STATE_VERSION = 1;
const STEP_STATUSES = new Set(["pending", "running", "waiting", "done", "skipped", "warn", "failed"]);
const PHASES = new Set(["idle", "running", "waiting", "failed", "paused", "done"]);

const text = (value, max = 600) => (typeof value === "string" ? value.slice(0, max) : "");

function sanitizeError(error) {
  if (!error || typeof error !== "object") return null;
  return { code: text(error.code, 60) || "unknown", message: text(error.message), hint: text(error.hint), detail: text(error.detail), manual: text(error.manual, 4000) };
}

// 读盘结果 → 可信的内存状态。stepIds 是当前版本的步骤清单：多出来的旧步骤丢弃，缺的补 pending。
export function reviveGuideState(raw, stepIds) {
  const base = emptyGuideState(stepIds);
  if (!raw || typeof raw !== "object" || raw.version !== GUIDE_STATE_VERSION) return base;
  const phase = PHASES.has(raw.phase) ? raw.phase : "idle";
  const steps = {};
  for (const id of stepIds) {
    const saved = raw.steps?.[id];
    const status = STEP_STATUSES.has(saved?.status) ? saved.status : "pending";
    // 进程没了，"正在跑 / 正在等回答"就不成立了：回到待执行，由继续按钮重跑这一步。
    const interrupted = status === "running" || status === "waiting";
    steps[id] = {
      status: interrupted ? "pending" : status,
      detail: interrupted ? "" : text(saved?.detail),
      error: interrupted ? null : sanitizeError(saved?.error),
    };
  }
  const form = raw.form && typeof raw.form === "object" ? raw.form : {};
  const result = raw.result && typeof raw.result === "object" ? raw.result : {};
  return {
    ...base,
    phase: phase === "running" || phase === "waiting" ? "paused" : phase,
    dismissed: raw.dismissed === true,
    form: { sshUser: text(form.sshUser, 64), hostName: text(form.hostName, 255), sshPort: Number.isInteger(form.sshPort) ? form.sshPort : null },
    steps,
    result: {
      sshUser: text(result.sshUser, 64),
      remotePort: Number.isInteger(result.remotePort) ? result.remotePort : null,
      registered: typeof result.registered === "boolean" ? result.registered : null,
      warnings: Array.isArray(result.warnings)
        ? result.warnings.slice(0, 8).map((w) => ({ code: text(w?.code, 60), text: text(w?.text), command: text(w?.command, 2000) }))
        : [],
    },
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : null,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : null,
    completedAt: Number.isFinite(raw.completedAt) ? raw.completedAt : null,
  };
}

export function emptyGuideState(stepIds) {
  return {
    version: GUIDE_STATE_VERSION,
    phase: "idle",
    dismissed: false,
    form: { sshUser: "", hostName: "", sshPort: null },
    steps: Object.fromEntries(stepIds.map((id) => [id, { status: "pending", detail: "", error: null }])),
    // 等用户回答的问题（指纹 / 密码 / 是否覆盖 Host 段 …）。不落盘：重启后由对应步骤重新提出。
    prompt: null,
    result: { sshUser: "", remotePort: null, registered: null, warnings: [] },
    startedAt: null,
    updatedAt: null,
    completedAt: null,
  };
}

export function createGuideStore({ filePath, stepIds, fs = nodeFs, log = () => {}, now = Date.now }) {
  function load() {
    if (!filePath) return emptyGuideState(stepIds);
    try {
      return reviveGuideState(JSON.parse(fs.readFileSync(filePath, "utf8")), stepIds);
    } catch (error) {
      // 内容坏了：先留档（<名字>.corrupt-<北京时间>）再按没开始处理；日志里不带解析错误原文。
      if (isParseFailure(error)) archiveCorruptFileSync(filePath, { fs, now, log, label: "接入引导进度", action: "按没开始处理" });
      else if (error?.code !== "ENOENT") log(`onboarding guide: 进度文件读不出来，按没开始处理（${error.message}）`);
      return emptyGuideState(stepIds);
    }
  }

  function save(state) {
    if (!filePath) return;
    const { prompt: _prompt, ...persisted } = state;
    try {
      writePrivateFileAtomicSync(filePath, `${JSON.stringify(persisted, null, 2)}\n`, { fs, chmodDir: false });
    } catch (error) {
      // 存不下来只影响"断点继续"，不该让正在跑的引导失败。
      log(`onboarding guide: 进度保存失败（${error.message}）`);
    }
  }

  function clear() {
    if (!filePath) return;
    try { fs.unlinkSync(filePath); } catch {}
  }

  return { load, save, clear };
}
