// scripts/hot-update/smoke.mjs —— staged 包冒烟：以 fixture 模式跑一遍包内 monitor-server
// （临时端口 + 临时数据目录 + 临时个人层），/api/session 与 /api/status-lite 均 200 才算通过。
// 只杀本次 spawn 的冒烟子进程；端口若撞上生产端口直接拒绝。
// 也是 CLI：Release CI 对最终产物跑同一套隔离冒烟（见 runSmokeCli）。
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnFixtureMonitor } from "../lib/fixture-monitor.mjs";
import { isMainModule } from "../lib/is-main.mjs";
import { APP_NAME, bundleResources } from "./layout.mjs";

const PROTECTED_PORTS = new Set([8877, 8888]);

export async function defaultSmoke(stagedApp, options = {}) {
  return smokeBinary(path.join(stagedApp, "Contents", "MacOS", APP_NAME), bundleResources(stagedApp), options);
}

// 与平台无关的那一段：bin 是包内的 Electron 主程序，cwd 是包内的应用资源目录（electron-main.mjs 所在）。
// Windows 安装版的构建（scripts/build-windows-app.mjs --smoke）也用它。
export async function smokeBinary(bin, cwd, { log = () => {}, timeoutMs = 25_000 } = {}) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "codex-hot-update-smoke-"));
  const port = await getFreePort();
  if (PROTECTED_PORTS.has(port)) throw new Error(`冒烟端口 ${port} 与生产端口冲突`);
  const monitor = spawnFixtureMonitor({
    command: bin,
    script: "work/monitor/monitor-server.mjs",
    cwd,
    port,
    authToken: randomBytes(16).toString("hex"),
    dataDir: path.join(tmp, "data"),
    localConfigPath: path.join(tmp, "config.local.json"),
  });
  const { child } = monitor;
  const tail = () => monitor.output().split("\n").slice(-12).join("\n");
  try {
    const deadline = Date.now() + timeoutMs;
    let sessionToken = "";
    while (Date.now() < deadline) {
      if (child.exitCode != null) return { ok: false, detail: `staged monitor 提前退出 (code=${child.exitCode})\n${tail()}` };
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          sessionToken = (await res.json()).token || "";
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!sessionToken) return { ok: false, detail: `staged monitor 未在 ${timeoutMs}ms 内就绪或未返回 token\n${tail()}` };
    const lite = await fetch(`http://127.0.0.1:${port}/api/status-lite`, { headers: { "x-auth-token": sessionToken }, signal: AbortSignal.timeout(3000) });
    if (lite.status !== 200) return { ok: false, detail: `/api/status-lite 返回 ${lite.status}\n${tail()}` };
    log(`  冒烟端口 ${port}，/api/session + /api/status-lite 均 200`);
    return { ok: true };
  } finally {
    await monitor.stop(); // 只杀本次 spawn 的冒烟子进程
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// CLI：node scripts/hot-update/smoke.mjs "<.app 路径>" [--timeout-ms N]
// Release CI 构建完用它冒烟最终产物（源码树的浏览器冒烟替代不了"包内二进制真能起服务"）。
// 退出码：0 通过 / 1 冒烟失败 / 2 用法错误或非 macOS。CI 首次冷启动较慢，缺省给 60s。
export async function runSmokeCli(argv = [], { smoke = defaultSmoke, log = (line) => console.log(line), platform = process.platform } = {}) {
  const args = [...argv];
  let timeoutMs = 60_000;
  const flag = args.indexOf("--timeout-ms");
  if (flag !== -1) {
    timeoutMs = Number(args[flag + 1]);
    args.splice(flag, 2);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      log("--timeout-ms 需要正整数毫秒");
      return 2;
    }
  }
  if (args.length !== 1 || !args[0].endsWith(".app")) {
    log("用法: node scripts/hot-update/smoke.mjs \"<路径>/Codex Operations Console.app\" [--timeout-ms N]");
    return 2;
  }
  if (platform !== "darwin") {
    log("产物冒烟只适用于 macOS .app");
    return 2;
  }
  const app = path.resolve(args[0]);
  log(`→ 产物冒烟：${app}（fixture 模式、临时端口与数据目录）`);
  const result = await smoke(app, { log, timeoutMs });
  if (!result.ok) {
    log(`✗ 冒烟失败：${result.detail || ""}`);
    return 1;
  }
  log("✓ 产物冒烟通过");
  return 0;
}

if (isMainModule(import.meta.url)) {
  runSmokeCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`产物冒烟异常中止: ${err.stack || err.message}`);
      process.exitCode = 1;
    });
}
