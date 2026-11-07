// 代理口令的跨模块守卫（v2.62）：口令只该待在哪、不该出现在哪。各模块自己的规则在各自目录的测试里，
// 这里钉的是它们之间的接线：
//   - 存储清理不删口令文件与使用记录；
//   - 排障报告带不出口令；
//   - 能碰口令原文的模块只有清单里那几个；
//   - 起一个真实的 fixture 监控服务走一遍接口：响应、日志、运行目录里别的文件都没有口令，
//     口令文件只在它自己的临时数据目录里，「写到集群」在 fixture 下不发 SSH。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { listImportClosure } from "../work/monitor/lib/component-version.mjs";
import { spawnFixtureMonitor } from "../work/monitor/lib/fixture-monitor.mjs";
import { PROXY_AUTH_FILE } from "../work/monitor/lib/proxy/auth.mjs";
import { PROXY_USAGE_FILE } from "../work/monitor/lib/proxy/usage.mjs";
import { redactReport } from "../work/monitor/lib/reports/model.mjs";
import { createStorageSweeper } from "../work/monitor/lib/storage-sweeper.mjs";
import { resolveServerLocations } from "../work/monitor/server/runtime-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "runtime") walk(rel, out);
    } else if (/\.(mjs|js|sh|py)$/.test(entry.name) && !/\.test\.mjs$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

test("存储清理：runtime 远超预算时，口令文件与使用记录也不在淘汰之列", async (t) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-sweep-"));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(runtimeDir, "logs"));
  fs.mkdirSync(path.join(runtimeDir, "history"));
  const authFile = path.join(runtimeDir, PROXY_AUTH_FILE);
  const usageFile = path.join(runtimeDir, PROXY_USAGE_FILE);
  fs.writeFileSync(authFile, JSON.stringify({ v: 1, mode: "enforce", user: "cwb", token: TOKEN }), { mode: 0o600 });
  fs.writeFileSync(usageFile, "x".repeat(100 * 1024));
  // 一堆可淘汰的东西：旧分卷、很久以前的 history。
  for (const n of [1, 2, 3]) fs.writeFileSync(path.join(runtimeDir, "logs", `ops.ndjson.${n}`), "y".repeat(64 * 1024));
  for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) fs.writeFileSync(path.join(runtimeDir, "history", `${day}.ndjson`), "z".repeat(64 * 1024));

  const sweeper = createStorageSweeper({ runtimeDir, budgetBytes: 1024 }); // 预算 1 KB：能删的都会被删
  const result = await sweeper.sweep({ targetRatio: 0.5 });
  assert.ok(result.evicted.length >= 5, `应淘汰了分卷与旧 history，实际 ${result.evicted.length}`);
  assert.equal(result.overBudget, true, "清空可淘汰层仍超预算：只告警，不越界");
  assert.equal(result.evicted.some((file) => /proxy-(auth|usage)\.json/.test(file.path)), false);
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).token, TOKEN, "口令文件原样还在");
  assert.equal(fs.statSync(usageFile).size, 100 * 1024);
});

test("排障报告：导出的内容不取运行目录里的文件；万一证据里混进了带口令的代理地址或认证头，也会被打码", () => {
  for (const file of ["work/monitor/lib/reports/model.mjs", "work/monitor/lib/reports/service.mjs"]) {
    assert.doesNotMatch(read(file), /proxy-auth|proxy-usage|PROXY_AUTH|runtimeDir|readFileSync|readFile\(/, `${file} 不直接读运行目录`);
  }
  const basic = Buffer.from(`cwb:${TOKEN}`).toString("base64");
  const text = [
    `export HTTPS_PROXY="http://cwb:${TOKEN}@127.0.0.1:7891"`,
    `curl: (56) Received HTTP code 407 from proxy after CONNECT; Proxy-Authorization: Basic ${basic}`,
    `proxy-user = "cwb:${TOKEN}"`,
  ].join("\n");
  const redacted = redactReport(text).text;
  assert.equal(redacted.includes(TOKEN), false, redacted);
  assert.equal(redacted.includes(basic), false, redacted);
});

test("能碰口令文件与口令原文的模块只有这几个", () => {
  const sources = [...walk("work"), ...walk("scripts"), "electron-main.mjs", "preload.js"].filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const touching = (pattern) => sources.filter((rel) => pattern.test(read(rel))).sort();
  // 口令文件的路径：代理（只读）、控制面的存储（读写）、两处装配，以及命令行向导（v2.64，经同一个存储模块只读，
  // 重写集群 env.sh 时带上口令，不让重跑 setup 把它冲掉）。
  assert.deepEqual(touching(/PROXY_AUTH_FILE\b|proxy-auth\.json/), [
    "scripts/setup/proxy-credential.mjs",
    "work/local_http_connect_proxy.mjs",
    "work/monitor/lib/cluster-env-sync.mjs", // 只在注释里提到，不读这个文件
    "work/monitor/lib/egress/proxy-auth-store.mjs",
    "work/monitor/lib/proxy/auth.mjs",
    "work/monitor/lib/proxy/policy-reload.mjs",
    "work/monitor/lib/proxy/usage.mjs", // 只在注释里提到
    "work/monitor/server/start.mjs",
  ].filter((rel) => /PROXY_AUTH_FILE\b|proxy-auth\.json/.test(read(rel))));
  // 读文件内容的只有代理的热重载与控制面的存储。
  assert.match(read("work/monitor/lib/proxy/policy-reload.mjs"), /readAuthFile\(authPath\)/);
  assert.doesNotMatch(read("work/monitor/lib/cluster-env-sync.mjs"), /readFileSync|proxy-auth-store/);
  // 取口令原文的三个出口（store 的方法）：只有业务层、装配处用到，外加命令行向导读本机口令的那个模块
  // （v2.64：只交给 cluster-env.mjs 渲染、经 ssh 标准输入送到集群；不打印、不进命令行）。
  assert.deepEqual(touching(/\.(getCredential|getStoredCredential|getPreviousCredential)\b/), [
    "scripts/setup/proxy-credential.mjs",
    "work/monitor/lib/egress/proxy-auth-service.mjs",
    "work/monitor/server/start.mjs",
  ]);
  // 「用户:口令」拼成 curl 配置行 / 脚本赋值的只有那一个模块；别处要带口令都经它。
  assert.deepEqual(touching(/proxy-user\s*=/), ["work/monitor/lib/egress/remote-proxy-auth.mjs", "work/monitor/remote/cli-probe.sh"]);
  // 往代理地址里放口令的只有集群侧受管配置的渲染（写进 600 文件、经标准输入送达）。
  assert.deepEqual(touching(/clusterProxyUrl\([^)]*,\s*credential\)/), ["work/monitor/lib/cluster-env.mjs"]);
});

test("指纹闭包：控制面的口令模块不进数据面闭包（改它们不该让代理 / 守护进程交接）；supervisor 闭包里没有口令与使用记录", async () => {
  const proxy = await listImportClosure(ROOT, "work/local_http_connect_proxy.mjs");
  const supervisor = await listImportClosure(ROOT, "work/monitor/channel-supervisor.mjs");
  for (const rel of ["proxy-auth-store", "proxy-auth-service", "proxy-usage-view", "remote-proxy-auth"].map((name) => `work/monitor/lib/egress/${name}.mjs`)) {
    assert.equal(proxy.includes(rel), false, rel);
    assert.equal(supervisor.includes(rel), false, rel);
  }
  for (const rel of ["work/monitor/lib/proxy/auth.mjs", "work/monitor/lib/proxy/usage.mjs"]) {
    assert.equal(proxy.includes(rel), true, rel);
    assert.equal(supervisor.includes(rel), false, rel);
  }
  assert.equal(supervisor.includes("work/monitor/lib/cluster-env.mjs"), false);
});

test("fixture 模式的运行目录来自调用方给的数据目录：口令文件落在那里，不是真实的运行目录", () => {
  const dataDir = path.join(os.tmpdir(), "cwb-fixture-example");
  const { runtimeDir } = resolveServerLocations({ CODEX_MONITOR_DATA_DIR: dataDir, CODEX_MONITOR_FIXTURE_MODE: "1" });
  assert.equal(runtimeDir, path.join(dataDir, "runtime"));
  const start = read("work/monitor/server/start.mjs");
  assert.match(start, /createProxyAuthStore\(\{ filePath: path\.join\(runtimeDir, PROXY_AUTH_FILE\)(?:, log: appendLog)? \}\)/);
  assert.match(start, /usagePath: path\.join\(runtimeDir, PROXY_USAGE_FILE\)/);
  // fixture 监控不继承这台机器上的 CODEX_MONITOR_*，数据目录只认传进去的那个。
  const launcher = read("work/monitor/lib/fixture-monitor.mjs");
  assert.match(launcher, /key\.startsWith\("CODEX_MONITOR_"\)[\s\S]*continue;/);
  assert.match(launcher, /CODEX_MONITOR_DATA_DIR: dataDir/);
});

// ---- 真实的 fixture 监控服务 ----
// 两道保险写在用例自己身上（谁跑这套测试都一样）：
//   ① 监控进程的 PATH 最前面是假的 ssh / scp / sftp（只记一行、以 255 退出），启动前自检确实解析到假的；
//   ② 团队配置换成临时的一份：服务器是不存在的主机名，「本机代理端口」指向用例自己起的一个监听——
//      打不到真实的 8888，而且谁连了它都数得出来（fixture 模式下应该一次都没有）。
// 全程只访问这个临时监控服务自己的端口。
const skipFixture = process.platform === "win32" ? "假 ssh 是 sh 脚本" : false;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function safePort(avoid = []) {
  for (let i = 0; i < 20; i += 1) {
    const port = await freePort();
    if (![8877, 8888, 1455, ...avoid].includes(port) && !(port >= 7890 && port <= 7899)) return port;
  }
  throw new Error("no usable free port");
}

test("fixture 监控：代理口令的接口、日志、运行目录里别的文件都没有口令；「写到集群」不发 SSH", { skip: skipFixture, timeout: 240_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-auth-fixture-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));
  const fakeBin = path.join(tmp, "bin");
  const sshLog = path.join(tmp, "fake-ssh.log");
  fs.mkdirSync(fakeBin);
  for (const name of ["ssh", "scp", "sftp"]) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${sshLog}"\nexit 255\n`, { mode: 0o755 });
  }
  const guardedPath = `${fakeBin}${path.delimiter}${process.env.PATH}`;
  const check = spawnSync("ssh", ["--proxy-auth-selfcheck"], { env: { ...process.env, PATH: guardedPath }, encoding: "utf8" });
  if (check.status !== 255 || !fs.existsSync(sshLog) || !fs.readFileSync(sshLog, "utf8").includes("ssh --proxy-auth-selfcheck")) {
    t.skip("假 ssh 没有排在 PATH 最前面：不启动 fixture 监控");
    return;
  }
  fs.writeFileSync(sshLog, "");

  const port = await safePort();
  // 冒充「本机代理」的监听：只数有没有人连上来，连上来就立刻断开。
  let proxyPortConnections = 0;
  const decoy = net.createServer((socket) => {
    proxyPortConnections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => decoy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => decoy.close(resolve)));
  const deadProxyPort = decoy.address().port;
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    activeServerId: "server-01",
    activeAgentId: "codex",
    agents: [{ id: "codex", name: "Codex", command: "codex", kind: "codex" }],
    servers: [{ id: "server-01", name: "fixture", host: "fixture-host.invalid", localPort: deadProxyPort, remotePort: 7999 }],
  }));
  const dataDir = path.join(tmp, "data");
  const authFile = path.join(dataDir, "runtime", PROXY_AUTH_FILE);

  const originalPath = process.env.PATH;
  let monitor;
  try {
    process.env.PATH = guardedPath; // spawnFixtureMonitor 在调用那一刻抄一份环境
    monitor = spawnFixtureMonitor({
      command: process.execPath,
      script: "work/monitor/monitor-server.mjs",
      cwd: ROOT,
      port,
      authToken: randomBytes(16).toString("hex"),
      dataDir,
      configPath,
      localConfigPath: path.join(tmp, "config.local.json"),
    });
  } finally {
    process.env.PATH = originalPath;
  }
  t.after(() => monitor.stop());

  const base = `http://127.0.0.1:${port}`;
  let token = "";
  const deadline = Date.now() + 90_000;
  while (!token && Date.now() < deadline) {
    assert.equal(monitor.child.exitCode, null, `监控服务提前退出: ${monitor.output().slice(-600)}`);
    try {
      const res = await fetch(`${base}/api/session`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) token = (await res.json()).token || "";
    } catch {}
    if (!token) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(token, `监控服务没有就绪: ${monitor.output().slice(-600)}`);
  const headers = { "x-auth-token": token, "content-type": "application/json" };
  const get = (pathname) => fetch(`${base}${pathname}`, { headers, signal: AbortSignal.timeout(20_000) });
  const post = (pathname, body) => fetch(`${base}${pathname}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });

  // 默认：关，没有口令文件，状态里有这一节。
  const initial = await (await get("/api/egress")).json();
  assert.equal(initial.proxyAuth.mode, "off");
  assert.equal(initial.proxyAuth.hasToken, false);
  assert.equal(initial.proxyAuth.cluster, null, "fixture 下没有集群同步");
  assert.deepEqual(initial.effective, { running: false, supportsEgress: false, mode: null, upstream: null }, "代理状态是夹具值，不是探出来的");
  assert.equal(initial.systemProxy.source, "fixture");
  assert.equal(initial.proxyPort, deadProxyPort);
  assert.equal(fs.existsSync(authFile), false, "读状态不建文件");

  // 打开「只记录」：口令文件出现在这个监控服务自己的临时数据目录里，0600。
  const savedRes = await post("/api/egress/proxy-auth", { mode: "observe" });
  assert.equal(savedRes.status, 200, await savedRes.clone().text());
  const saved = await savedRes.json();
  assert.equal(saved.proxyAuth.mode, "observe");
  assert.deepEqual(saved.proxyAuthResult, { action: "mode", created: true, reset: false });
  const secret = JSON.parse(fs.readFileSync(authFile, "utf8")).token;
  assert.match(secret, /^[A-Za-z0-9]{32}$/);
  assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);

  // 换口令（两个口令都不能漏）；切强制在没有任何观察数据时要先确认。
  assert.equal((await post("/api/egress/proxy-auth", { rotate: true })).status, 200);
  const doc = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const secrets = [secret, doc.token, doc.previousToken].flatMap((value) => [value, Buffer.from(`cwb:${value}`).toString("base64")]);
  assert.equal(new Set([secret, doc.token]).size, 2);
  const refused = await post("/api/egress/proxy-auth", { mode: "enforce" });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "confirm-required");
  assert.equal(JSON.parse(fs.readFileSync(authFile, "utf8")).mode, "observe", "没确认就没改");

  // 「写到集群」：fixture 下直接 409，一条 SSH 都不发。
  for (const body of [{}, { confirm: true }]) {
    const sync = await post("/api/egress/proxy-auth/sync", body);
    assert.equal(sync.status, 409, await sync.clone().text());
    assert.equal((await sync.json()).code, "fixture");
  }
  // 出网自测（本机段与全链路）：夹具结果，不经「本机代理」发任何连接。口令已经打开，照样不带着口令去连。
  for (const scope of ["local", "full"]) {
    const report = await (await post("/api/egress/self-test", { scope })).json();
    assert.equal(report.fixture, true);
    assert.deepEqual(report.results, []);
  }

  // 各个读接口的响应里都没有口令。
  const bodies = [];
  // /api/diagnostics/bundle（v2.64）：诊断包汇集日志、配置、状态与运行目录里的登记，口令同样不能出现。
  for (const pathname of ["/api/egress", "/api/egress/usage", "/api/status", "/api/status-lite", "/api/logs?limit=500", "/api/config/personal", "/api/session", "/api/diagnostics/bundle"]) {
    const res = await get(pathname);
    bodies.push(`${pathname} → ${res.status}\n${await res.text()}`);
  }
  assert.match(bodies[0], /"proxyAuth":\{"mode":"observe","hasToken":true/);
  assert.match(bodies[4], /proxy auth mode set to observe \(token generated\)/, "运维日志记了这件事（不带口令）");
  await monitor.stop();
  const everything = `${bodies.join("\n")}\n${monitor.output()}`;
  for (const value of secrets) assert.equal(everything.includes(value), false, "接口响应或进程输出里出现了口令");

  // 运行目录里除了口令文件自己，别的文件（日志、状态、快照……）都没有口令。
  const leaked = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (full !== authFile && secrets.some((value) => fs.readFileSync(full, "latin1").includes(value))) leaked.push(path.relative(tmp, full));
    }
  };
  scan(dataDir);
  assert.deepEqual(leaked, []);
  assert.equal(fs.readFileSync(sshLog, "utf8"), "", "整个过程没有任何 ssh / scp 调用");
  assert.equal(proxyPortConnections, 0, "fixture 监控没有连过配置里的本机代理端口（读状态、自测都没有）");
});
