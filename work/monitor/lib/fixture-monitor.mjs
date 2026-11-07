// lib/fixture-monitor.mjs —— 以 fixture 模式拉起一个隔离的 monitor-server：临时端口 / 临时数据目录 /
// 临时个人层、不连保管库，继承环境里的 CODEX_MONITOR_* / AUTH_TOKEN / PORT 一律丢弃，绝不读写用户真实数据。
// 三处共用：热更新的 staged 包冒烟（scripts/hot-update/smoke.mjs）、浏览器冒烟
// （scripts/browser-smoke-electron.mjs）、自更新应用前对目标版本的自检（lib/self-update/smoke.mjs）。
// stop() 只杀本次 spawn 的子进程：先 SIGTERM，宽限期内没退出再 SIGKILL。
import { spawn } from "node:child_process";

export function spawnFixtureMonitor({ command, script, cwd, port, authToken, dataDir, configPath, localConfigPath }) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CODEX_MONITOR_") || key === "AUTH_TOKEN" || key === "PORT") continue;
    env[key] = value;
  }
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    AUTH_TOKEN: authToken,
    CODEX_MONITOR_FIXTURE_MODE: "1",
    CODEX_MONITOR_VAULT_URL: "",
    CODEX_MONITOR_VAULT_TOKEN: "",
    CODEX_MONITOR_DATA_DIR: dataDir,
    CODEX_MONITOR_LOCAL_CONFIG_PATH: localConfigPath,
  });
  if (configPath) env.CODEX_MONITOR_CONFIG_PATH = configPath;

  const child = spawn(command, [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));

  async function stop({ graceMs = 2000 } = {}) {
    if (child.exitCode != null) return;
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    if (child.exitCode == null) child.kill("SIGKILL");
  }

  return { child, output: () => output, stop };
}
