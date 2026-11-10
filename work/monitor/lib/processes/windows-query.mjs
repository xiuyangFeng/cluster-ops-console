import path from "node:path";

// 系统工具不能依赖桌面应用继承的 PATH。与 OpenSSH 目录解析使用同一环境口径。
export function windowsSystemTool(name, env = process.env) {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  return path.win32.join(root, "System32", ...(name === "powershell" ? ["WindowsPowerShell", "v1.0", "powershell.exe"] : [`${name}.exe`]));
}

const states = new WeakMap();
// 三次系统调用各有 10s 时限及子进程退出宽限，外层探针必须覆盖完整降级流程。
export const WINDOWS_PROCESS_QUERY_BUDGET_MS = 40000;
const missingTool = (result) => /ENOENT|EACCES|EPERM|powershell(?:\.exe)?.{0,30}(?:not found|not recognized)|(?:找不到|不存在).{0,100}powershell/i.test(`${result?.stderr || ""} ${result?.code || ""}`);

// CIM 不可用时尝试 Windows PowerShell 的 WMI 接口；tasklist 只能提供存活证据，
// 绝不能据此判断命令行归属。失败状态按执行器隔离、并发合流，避免各调用者重复轰炸系统。
export async function runWindowsProcessQuery(exec, script, { now = Date.now, env = process.env, validate = () => {} } = {}) {
  let state = states.get(exec);
  if (!state) { state = { failures: 0, error: null, pending: null }; states.set(exec, state); }
  if (state.pending && state.script === script) {
    const result = await state.pending;
    validate(result.stdout);
    return result;
  }
  if (state.pending) {
    try { await state.pending; } catch {}
  }
  if (state.error && now() < state.error.nextRetryAt) throw state.error;
  const run = async () => {
    const command = windowsSystemTool("powershell", env);
    const options = { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024, ...(env === process.env ? {} : { env }) };
    let result;
    for (const query of [script, script.replaceAll("Get-CimInstance", "Get-WmiObject")]) {
      result = null;
      try {
        result = await exec(command, ["-NoProfile", "-NonInteractive", "-Command", query], options);
        if (result?.code !== 0 || result.timedOut || result.truncated) throw new Error("query failed");
        validate(result.stdout);
        state.failures = 0;
        state.error = null;
        return result;
      } catch (error) {
        if (!result || result.code === 0) result = { code: error.code, stderr: error.message };
        if (missingTool(result)) break;
      }
    }
    let pidCount = null;
    try {
      const fallback = await exec(windowsSystemTool("tasklist", env), ["/FO", "CSV", "/NH"], options);
      if (fallback?.code === 0 && !fallback.truncated && !fallback.timedOut) {
        pidCount = String(fallback.stdout || "").split(/\r?\n/).filter((line) => /^"[^"]+","\d+"/.test(line)).length;
      }
    } catch {}
    state.failures++;
    const permanent = missingTool(result);
    const retryMs = permanent ? 300000 : Math.min(300000, 15000 * 2 ** Math.min(state.failures - 1, 5));
    state.error = Object.assign(new Error(permanent
      ? "Windows 系统进程查询工具不可用，请检查系统目录中的 PowerShell 及访问权限。保留现有连接，5 分钟后自动重试。"
      : "Windows 进程命令行暂时无法读取，已降低重试频率并保留现有连接。请检查 PowerShell / WMI 服务。"), {
      code: "windows-process-query-unavailable", permanent, failures: state.failures,
      nextRetryAt: now() + retryMs, pidCount, toolPath: command,
    });
    throw state.error;
  };
  const pending = run();
  state.pending = pending;
  state.script = script;
  try { return await pending; } finally { if (state.pending === pending) state.pending = null; }
}
