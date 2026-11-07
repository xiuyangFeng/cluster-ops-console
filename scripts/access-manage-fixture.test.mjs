// fixture 模式下的接入管理：四个接口在真的监控进程上走一遍，全程一次 ssh 都不发、不写个人配置。
//
// 这几个接口在生产里会发 SSH，其中两个会删集群上的东西；冒烟、界面预览用的 fixture 监控绝不能碰到真实主机。
// lib/onboarding-guide/access.test.mjs 已经在服务这一层证明 fixture 模式不调用执行器；这里再从进程外面验一遍，
// 并且自带一道保险：被测进程的 PATH 最前面是假的 ssh / scp / sftp（只记一行、以 255 退出），启动前先自检
// 它确实排在最前——自检不过就不起监控。断言除了结果对，还要这份记录是空的。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnFixtureMonitor } from "../work/monitor/lib/fixture-monitor.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip = process.platform === "win32" ? "假 ssh 是 sh 脚本，需要 POSIX 环境" : false;
// 现役控制面 / 本机代理 / 反向端口 / codex 登录回调：系统随机分到的概率极低，分到了也不用。
const RESERVED_PORTS = new Set([8877, 8888, 7891, 7892, 7893, 7894, 1455]);
// 起一个 node 子进程在机器很忙时偶尔要十几秒（见 agent.md「时间口径与跨环境验证规范」第 5 条）：时限给足。
const READY_TIMEOUT_MS = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: picked } = server.address();
        server.close(() => resolve(picked));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("拿不到保留端口之外的空闲端口");
}

// 假的 ssh 家族放进 dir/bin，返回 { pathValue, calls() }。日志路径写死在脚本里，不依赖环境变量传递。
function installFakeSsh(dir) {
  const bin = path.join(dir, "bin");
  const logFile = path.join(dir, "fake-ssh.log");
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ["ssh", "scp", "sftp"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${logFile}'\nexit 255\n`, { mode: 0o755 });
  }
  const pathValue = `${bin}${path.delimiter}${process.env.PATH || ""}`;
  const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
  // 自检：按监控服务同样的找法（继承的 PATH）执行 ssh，必须落到假的那个。参数是个无效选项——
  // 万一落到了真的 ssh，也只会打印用法，不会连任何主机。
  const check = spawnSync("ssh", ["--cwb-selfcheck"], { env: { ...process.env, PATH: pathValue }, encoding: "utf8" });
  const ok = check.status === 255 && calls().includes("ssh --cwb-selfcheck");
  fs.rmSync(logFile, { force: true });
  return { ok, pathValue, calls };
}

test("fixture 模式：读端口登记 / 释放端口 / 撤销的预览与执行，在真的监控进程上全程不发 ssh、不写个人配置", { skip }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-access-fixture-"));
  let monitor = null;
  t.after(async () => {
    await monitor?.stop();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  });
  const fake = installFakeSsh(tmp);
  assert.equal(fake.ok, true, "假 ssh 没有排在 PATH 最前面：不起监控");

  const port = await freePort();
  const token = randomBytes(16).toString("hex");
  const localConfigPath = path.join(tmp, "config.local.json");
  // spawnFixtureMonitor 按调用那一刻的 process.env 组子进程环境：只在这一行期间把 PATH 换成带假 ssh 的。
  const originalPath = process.env.PATH;
  process.env.PATH = fake.pathValue;
  try {
    monitor = spawnFixtureMonitor({ command: process.execPath, script: "work/monitor/monitor-server.mjs", cwd: repoRoot, port, authToken: token, dataDir: path.join(tmp, "data"), localConfigPath });
  } finally {
    process.env.PATH = originalPath;
  }

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method,
      headers: { "x-auth-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    assert.equal(monitor.child.exitCode, null, `监控服务启动后退出了：${monitor.output().slice(-600)}`);
    try {
      ready = (await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {}
    if (!ready) await sleep(250);
  }
  assert.equal(ready, true, `监控服务 ${READY_TIMEOUT_MS / 1000} 秒内没有就绪：${monitor.output().slice(-600)}`);

  // 读：先回 pending，后台读完给出名下的端口（假远端上的数据）
  const readAccess = async () => {
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until) {
      const res = await call("GET", "/api/onboarding/access");
      assert.equal(res.status, 200);
      if (!res.json.registry?.pending) return res.json;
      await sleep(200);
    }
    throw new Error("端口登记一直在读");
  };
  const first = await readAccess();
  assert.deepEqual([first.available, first.simulated, first.port], [true, true, 7892]);
  assert.deepEqual(first.registry.ports.map((row) => [row.port, row.current, row.releasable]), [[7892, true, false], [7895, false, true]]);

  // 释放：在用的 409；闲置的放掉
  assert.deepEqual([(await call("POST", "/api/onboarding/access/release-port", { port: 7892 })).status], [409]);
  const released = await call("POST", "/api/onboarding/access/release-port", { port: 7895 });
  assert.deepEqual([released.status, released.json.result, released.json.access.registry.ports.map((row) => row.port)], [200, "ok", [7892]]);

  // 撤销：预览 → 执行（同时释放端口）→ 等它做完
  const previewed = await call("POST", "/api/onboarding/access/undo/preview", {});
  assert.equal(previewed.status, 200);
  assert.deepEqual(previewed.json.preview.steps.map((step) => step.effect), ["change", "change", "change", "change"]);
  const started = await call("POST", "/api/onboarding/access/undo/run", { previewId: previewed.json.preview.previewId, releasePort: true });
  assert.deepEqual([started.status, started.json.access.undo.status], [200, "running"]);
  let finished = null;
  const until = Date.now() + READY_TIMEOUT_MS;
  while (!finished && Date.now() < until) {
    await sleep(200);
    const res = await call("GET", "/api/onboarding/access");
    if (res.json.undo?.status !== "running") finished = res.json;
  }
  assert.ok(finished, "撤销一分钟内没有结束");
  assert.equal(finished.undo.status, "ok");
  assert.deepEqual(finished.undo.steps.map((step) => step.status), ["ok", "ok", "ok", "ok", "ok", "ok"]);
  const after = await readAccess();
  assert.deepEqual([after.port, after.registry.ports], [null, []]);

  // 全程：假 ssh 一次都没被调用，个人配置文件没有被创建
  assert.deepEqual(fake.calls(), [], "fixture 模式下不该有任何 ssh / scp 调用");
  assert.equal(fs.existsSync(localConfigPath), false, "fixture 模式不写个人配置");
});
