// 自更新应用前的自检（v2.59）：把目标版本的源码树以 fixture 模式起一遍 monitor-server
// （临时端口 + 临时数据目录 + 临时个人层，不碰真实配置与现役端口），/api/session 与 /api/status-lite 都回 200
// 才算通过。目标版本连服务都起不来的话，合并进来就是一个打不开的工作台——所以先在旁边试，再动正式目录。
// 运行时没有第三方依赖（package.json 只有 devDependencies），临时工作树不需要 node_modules。
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { spawnFixtureMonitor } from "../fixture-monitor.mjs";

// 现役控制台 / 本地代理的默认端口：系统随机分到它们的概率极低，分到了也绝不使用。
const PROTECTED_PORTS = new Set([8877, 8888]);

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

// → { ok: true } | { ok: false, detail }。永不 reject。
export async function smokeSourceTree(treeRoot, { timeoutMs = 30_000, command = process.execPath, spawnMonitor = spawnFixtureMonitor, fetchImpl = fetch } = {}) {
  let tmp = null;
  let monitor = null;
  try {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cwb-update-smoke-"));
    const port = await getFreePort();
    if (PROTECTED_PORTS.has(port)) return { ok: false, detail: `自检端口 ${port} 与现役端口冲突，请再试一次` };
    monitor = spawnMonitor({
      command,
      script: "work/monitor/monitor-server.mjs",
      cwd: treeRoot,
      port,
      authToken: randomBytes(16).toString("hex"),
      dataDir: path.join(tmp, "data"),
      localConfigPath: path.join(tmp, "config.local.json"),
    });
    const { child } = monitor;
    const tail = () => monitor.output().split("\n").filter(Boolean).slice(-6).join(" | ").slice(0, 600);
    const deadline = Date.now() + timeoutMs;
    let token = "";
    while (Date.now() < deadline) {
      if (child.exitCode != null) return { ok: false, detail: `新版本的监控服务启动后立刻退出了（退出码 ${child.exitCode}）：${tail()}` };
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          token = (await res.json()).token || "";
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!token) return { ok: false, detail: `新版本的监控服务 ${Math.round(timeoutMs / 1000)} 秒内没有就绪：${tail()}` };
    const lite = await fetchImpl(`http://127.0.0.1:${port}/api/status-lite`, { headers: { "x-auth-token": token }, signal: AbortSignal.timeout(3000) });
    if (lite.status !== 200) return { ok: false, detail: `新版本的状态接口返回 ${lite.status}：${tail()}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `自检没能跑完：${String(err?.message || err).slice(0, 300)}` };
  } finally {
    try {
      await monitor?.stop();
    } catch {}
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
