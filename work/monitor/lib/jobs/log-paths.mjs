// 日志按段向前读取（v2.51）的路径解析：在本机把登记表里的 StdOut / StdErr 模板展开成绝对路径。
//
// 与 remote/job-forensics.py 的 expand / absolute / resolve_pair 同一规则（%% %j %J %A %a %x %u，可带补零宽度；
// 含反斜杠的模板整串不展开；相对路径以 WorkDir 为基准；没有 StdErr 时与 StdOut 同一文件），
// 区别只在于：展开不了的占位符（数组子作业的 %j 不知道实际编号、%N 之类）不猜，整条路径作废并说明。
// 前端永远不传路径；这里的输入只来自本机登记表，输出仍按不可信文本校验（绝对路径、无控制字符、长度上限）。

const PATTERN_RE = /%(\d{0,2})([%jJAaxu])/g;
const NO_VAL_TASK = "4294967294"; // 非数组作业的 %a（Slurm 的 NO_VAL）
export const LOG_PATH_MAX = 1024;
const ID_RE = /^\d{1,12}$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 控制字符就是要挡掉的
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

// 本机可用的绝对日志路径：以 / 开头、没有未展开的 %、没有控制字符、不超长。
export function isUsableLogPath(value) {
  return typeof value === "string" && value.startsWith("/") && value.length <= LOG_PATH_MAX && !value.includes("%") && !CONTROL_RE.test(value);
}

// info：{ raw, arr, task, name, user }（raw = 实际作业号；数组子作业不知道时为 null → %j 不展开）。
export function expandLogTemplate(template, info = {}) {
  if (typeof template !== "string" || !template) return null;
  if (template.includes("\\")) return template.replaceAll("\\", "");
  const values = {
    j: info.raw ?? null,
    J: info.raw ?? null,
    A: info.arr ?? info.raw ?? null,
    a: info.task ?? NO_VAL_TASK,
    x: info.name ?? null,
    u: info.user ?? null,
  };
  return template.replace(PATTERN_RE, (match, pad, key) => {
    if (key === "%") return "%";
    let value = values[key];
    if (value == null) return match;
    value = String(value);
    if (pad && "jJAa".includes(key) && /^\d+$/.test(value)) value = value.padStart(Math.min(Number(pad), 10), "0");
    return value;
  });
}

function absolute(value, workDir) {
  if (!value) return null;
  if (value.startsWith("/")) return value;
  if (typeof workDir !== "string" || !workDir.startsWith("/")) return null;
  return workDir.endsWith("/") ? `${workDir}${value}` : `${workDir}/${value}`;
}

// 作业号 + 登记条目 → { stdout, stderr, sameFile, reason }。路径不可用的流为 null，reason 写明为什么。
// rawId：数组子作业的实际编号（登记表里另有一条 jobId = 实际编号的记录时由调用方查出）。
export function resolveRegisteredLogs(jobId, reg, { rawId = null } = {}) {
  const empty = { stdout: null, stderr: null, sameFile: false, reason: "没有登记到此作业的日志路径" };
  if (!reg || typeof reg !== "object" || (!reg.stdout && !reg.stderr)) return empty;
  const match = /^(\d+)_(\d+)$/.exec(String(jobId || ""));
  const info = {
    raw: match ? (ID_RE.test(String(rawId || "")) ? String(rawId) : null) : String(jobId),
    arr: match ? match[1] : null,
    task: match ? match[2] : null,
    name: typeof reg.name === "string" && reg.name ? reg.name : null,
    user: typeof reg.user === "string" && reg.user ? reg.user : null,
  };
  const outTpl = reg.stdout || null;
  const errTpl = reg.stderr || outTpl;
  const out = absolute(expandLogTemplate(outTpl, info), reg.workDir);
  const err = absolute(expandLogTemplate(errTpl, info), reg.workDir);
  const stdout = isUsableLogPath(out) ? out : null;
  const stderr = isUsableLogPath(err) ? err : null;
  let reason = null;
  if (!stdout || !stderr) {
    const unresolved = [out, err].some((p) => typeof p === "string" && p.includes("%"));
    reason = unresolved
      ? match && /%\d{0,2}[jJ]/.test(`${outTpl || ""}${errTpl || ""}`) && !info.raw
        ? "数组子作业的日志模板含 %j，本机不知道它的实际作业号"
        : "日志模板含本机无法展开的占位符"
      : "登记的日志路径不可用";
  }
  return { stdout, stderr, sameFile: Boolean(stdout && stdout === stderr), reason };
}
