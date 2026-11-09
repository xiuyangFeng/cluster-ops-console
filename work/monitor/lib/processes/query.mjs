// Windows 原生进程查询：CIM JSON 保留中文、空格及完整参数，不依赖 ps/WMIC。
import { execFileWithTimeout } from "../exec.mjs";

export const WINDOWS_PROCESS_QUERY = [
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "$ErrorActionPreference = 'Stop'",
  "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine)",
].join("; ");

export async function readWindowsProcesses(exec = execFileWithTimeout) {
  const result = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_QUERY], { timeoutMs: 10000, maxOutputBytes: 4 * 1024 * 1024 });
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error("无法读取 Windows 进程清单；保留现有进程，稍后重试");
  const rows = JSON.parse(String(result.stdout || "").replace(/^\uFEFF/, ""));
  if (!Array.isArray(rows)) throw new Error("Windows 进程清单格式无效");
  return rows.filter((p) => Number.isInteger(p.ProcessId) && p.ProcessId > 0 && typeof p.CommandLine === "string" && p.CommandLine)
    .map((p) => ({ pid: p.ProcessId, parentPid: p.ParentProcessId, command: p.CommandLine }));
}

export const normalizeProcessCommand = (value) => String(value || "").replace(/\\/g, "/");

// Windows CommandLineToArgvW 的引号/反斜杠规则，用于精确复核 spawn 时的 argv。
export function windowsCommandArgs(command) {
  const args = [];
  let value = "", quoted = false, active = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (/\s/.test(c) && !quoted) {
      if (active) { args.push(value); value = ""; active = false; }
      continue;
    }
    active = true;
    if (c === "\\") {
      let count = 1;
      while (command[i + 1] === "\\") { count++; i++; }
      if (command[i + 1] === '"') {
        value += "\\".repeat(Math.floor(count / 2));
        if (count % 2) { value += '"'; i++; }
        else { quoted = !quoted; i++; }
      } else value += "\\".repeat(count);
    } else if (c === '"') quoted = !quoted;
    else value += c;
  }
  if (active) args.push(value);
  return args;
}
