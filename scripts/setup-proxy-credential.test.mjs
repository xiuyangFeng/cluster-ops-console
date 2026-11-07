// 配置向导重写集群 env.sh 时带上工作台的代理口令（v2.64，W3）：重跑 `npm run setup` 不再把「把口令写到集群」
// 写进去的口令冲掉。ssh 全部注入：记录调用的假实现，或在临时 HOME 里用本机 bash / sh 执行命令的「本地 ssh」；
// 口令文件在 os.tmpdir() 下的临时数据目录里，由与工作台同一个存储模块写出——绝不碰真实 HOME、真实数据目录。
// 贯穿的断言：交给 ssh 的命令文本、终端输出里都没有口令（也没有它的 base64）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildClusterEnvSteps,
  buildEnvPortReadCommand,
  buildStrayScanCommand,
  CLAUDE_SETTINGS_READ_COMMAND,
  credentialFingerprint,
  parseEnvCredentialRead,
  renderClusterEnv,
  STRAY_SCAN_DONE,
} from "../work/monitor/lib/cluster-env.mjs";
import { createClusterEnvSync } from "../work/monitor/lib/cluster-env-sync.mjs";
import { createProxyAuthStore } from "../work/monitor/lib/egress/proxy-auth-store.mjs";
import { PROXY_AUTH_FILE } from "../work/monitor/lib/proxy/auth.mjs";
import { resolveServerLocations } from "../work/monitor/server/runtime-env.mjs";
import { defaultProxyAuthPath, readLocalProxyAuth } from "./setup/proxy-credential.mjs";
import { configureClusterEnv } from "./setup/routing.mjs";

const skip = process.platform === "win32" ? "远端命令用本机 sh 执行，需要 POSIX 环境" : false;
const SERVER = { id: "server-01", host: "myserver" };
const PORT = 7891;
const SCAN_NONE = `${STRAY_SCAN_DONE}\n`;
const SCAN_ONE = `.bashrc:145:export HTTP_PROXY="http://127.0.0.1:7891"\n${STRAY_SCAN_DONE}\n`;
const CLAUDE_PLAIN = '__CWB_CLAUDE__=1\n{"hooks":{}}';

// 一个临时数据目录，口令文件由工作台同一个存储模块写出。mode 为 null 时不建文件；thenMode 再改一次模式（口令留着）。
function dataDir(t, { mode = null, thenMode = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-proxy-cred-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { CODEX_MONITOR_DATA_DIR: dir };
  const filePath = defaultProxyAuthPath(env);
  if (mode) {
    const store = createProxyAuthStore({ filePath });
    store.setMode(mode);
    if (thenMode) store.setMode(thenMode);
  }
  const doc = () => JSON.parse(fs.readFileSync(filePath, "utf8"));
  const token = () => doc().token;
  return { dir, env, filePath, doc, token, read: () => readLocalProxyAuth({ env }) };
}

const secretsOf = (token) => [token, Buffer.from(`cwb:${token}`).toString("base64")];

async function captureConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

const askWith = (answers = []) => {
  const queue = [...answers];
  return async () => (queue.length ? queue.shift() : "");
};

// 记录调用的假 ssh：按命令内容分派；envRead 是集群上 env.sh 的只读检测回报。
function fakeSsh({ scan = SCAN_ONE, claude = { status: 0, stdout: CLAUDE_PLAIN }, envRead = { status: 0, stdout: "__CWB_ENV_PORT__=7891\n__CWB_ENV_CRED__=none\n" }, fail = {} } = {}) {
  const calls = [];
  const ssh = (host, cmd, opts = {}) => {
    const kind = cmd === buildStrayScanCommand() ? "scan"
      : cmd === CLAUDE_SETTINGS_READ_COMMAND ? "claude-read"
        : cmd === buildEnvPortReadCommand() ? "env-read"
          : cmd.includes("env.sh.tmp") ? "write-env"
            : cmd.includes("-v L=") ? "comment-out"
              : cmd.includes("settings.json") ? "claude-write" : "other";
    calls.push({ host, kind, cmd, input: opts.input ?? null, timeoutMs: opts.timeoutMs ?? null });
    if (fail[kind]) return { status: 1, stdout: "", stderr: `${kind} boom` };
    if (kind === "scan") return { status: 0, stdout: scan };
    if (kind === "claude-read") return claude;
    if (kind === "env-read") return envRead;
    return { status: 0, stdout: "", stderr: "" };
  };
  ssh.calls = calls;
  ssh.kinds = () => calls.map((c) => c.kind);
  return ssh;
}

function assertNoSecret(token, ssh, out) {
  for (const secret of secretsOf(token)) {
    for (const call of ssh?.calls ?? []) assert.equal(call.cmd.includes(secret), false, `命令文本里出现了口令: ${call.cmd.slice(0, 120)}…`);
    assert.equal(out.includes(secret), false, "终端输出里出现了口令");
  }
}

const run = (opts) => captureConsole(() => configureClusterEnv(SERVER, PORT, opts));

test("readLocalProxyAuth：与工作台同一个存储模块、同一套数据目录解析；只读，不建文件", (t) => {
  // 数据目录覆盖：与监控服务（server/start.mjs）同一个路径。
  const dir = path.join(os.tmpdir(), "cwb-setup-example");
  const env = { CODEX_MONITOR_DATA_DIR: dir };
  assert.equal(defaultProxyAuthPath(env), path.join(resolveServerLocations(env).runtimeDir, PROXY_AUTH_FILE));
  assert.equal(defaultProxyAuthPath(env), path.join(dir, "runtime", PROXY_AUTH_FILE));
  // 源码模式（没有覆盖）：仓库里的 work/runtime/——只算路径，不读。
  assert.match(defaultProxyAuthPath({}), /[\\/]work[\\/]runtime[\\/]proxy-auth\.json$/);

  const none = dataDir(t);
  assert.deepEqual(none.read(), { mode: "off", credential: null, issue: null });
  assert.equal(fs.existsSync(none.filePath), false, "读不建文件");

  const observe = dataDir(t, { mode: "observe" });
  assert.deepEqual(observe.read(), { mode: "observe", credential: { user: "cwb", password: observe.token() }, issue: null });
  // 关掉之后口令留着：「曾写到过集群」时要照带，所以模式是关也给。
  const off = dataDir(t, { mode: "enforce", thenMode: "off" });
  assert.deepEqual(off.read(), { mode: "off", credential: { user: "cwb", password: off.token() }, issue: null });

  const broken = dataDir(t);
  fs.mkdirSync(path.dirname(broken.filePath), { recursive: true });
  fs.writeFileSync(broken.filePath, "{oops");
  assert.deepEqual(broken.read(), { mode: "off", credential: null, issue: { state: "invalid", reason: "not-json" } });
});

test("本机没有口令（没有口令文件 / 有文件但没生成过口令）：输出与 SSH 调用和不传 proxyAuth 时逐字节相同", async (t) => {
  const missing = dataDir(t);
  const tokenless = dataDir(t);
  fs.mkdirSync(path.dirname(tokenless.filePath), { recursive: true });
  fs.writeFileSync(tokenless.filePath, JSON.stringify({ v: 1, mode: "off", user: "cwb", updatedAt: 1 }));
  assert.equal(tokenless.read().credential, null);

  const scenarios = [
    { dryRun: true },
    { dryRun: true, probeInDryRun: false },
    { dryRun: false, answers: ["y"] },
    { dryRun: false, fail: { "write-env": true } },
    { dryRun: false, claude: { status: 0, stdout: "__CWB_CLAUDE__=1\n{oops" } },
    { dryRun: false, fail: { "claude-write": true } },
  ];
  for (const s of scenarios) {
    const baseOpts = () => ({ dryRun: s.dryRun, ask: askWith(s.answers), noProxyExtra: ["10.0.0.5"], ...(s.probeInDryRun === false ? { probeInDryRun: false } : {}) });
    const baseSsh = fakeSsh(s);
    const base = await run({ ...baseOpts(), ssh: baseSsh });
    for (const proxyAuth of [missing.read(), tokenless.read(), null]) {
      const ssh = fakeSsh(s);
      const got = await run({ ...baseOpts(), ssh, proxyAuth });
      assert.equal(got.out, base.out, `终端输出逐字节相同：${JSON.stringify(s)}`);
      assert.deepEqual(ssh.calls, baseSsh.calls, `SSH 调用逐字节相同：${JSON.stringify(s)}`);
      assert.equal(got.result.proxyCredential, null);
    }
    // 没有多出探测口令的只读 SSH；写 env.sh 的命令就是不带口令的那一条（base64 内嵌、没有标准输入）。
    assert.equal(baseSsh.kinds().includes("env-read"), false);
    const write = baseSsh.calls.find((c) => c.kind === "write-env");
    if (write) {
      assert.equal(write.cmd, buildClusterEnvSteps({ port: PORT, noProxyExtra: ["10.0.0.5"] })[0].command);
      assert.equal(write.input, null);
    }
  }
});

test("口令模式打开着（只记录 / 强制）：env.sh 与 App「把口令写到集群」同一份内容，全文经标准输入；命令与终端里都没有口令", async (t) => {
  for (const mode of ["observe", "enforce"]) {
    const data = dataDir(t, { mode });
    const credential = { user: "cwb", password: data.token() };
    const ssh = fakeSsh({ claude: { status: 0, stdout: '__CWB_CLAUDE__=1\n{"env":{"FOO":"1"}}' } });
    const { result, out } = await run({ dryRun: false, ssh, ask: askWith(["y"]), noProxyExtra: ["10.0.0.5"], proxyAuth: data.read() });
    assert.equal(result.status, "ok");
    assert.equal(result.proxyCredential, "enabled");
    assert.deepEqual(ssh.kinds(), ["write-env", "other", "other", "other", "scan", "comment-out", "claude-read", "claude-write"], "模式打开着：不多发探测");
    // 与 App 同一个构造函数、同一组参数（cluster-env-sync 的 writeEnv：buildClusterEnvSteps({ port, noProxyExtra, credential })）。
    const expected = buildClusterEnvSteps({ port: PORT, noProxyExtra: ["10.0.0.5"], credential }).find((s) => s.id === "write-env");
    const write = ssh.calls.find((c) => c.kind === "write-env");
    assert.equal(write.cmd, expected.command);
    assert.equal(write.input, expected.input);
    assert.equal(write.input, renderClusterEnv({ port: PORT, noProxyExtra: ["10.0.0.5"], credential }));
    assert.match(write.input, new RegExp(`^export HTTPS_PROXY="http://cwb:${credential.password}@127\\.0\\.0\\.1:${PORT}"$`, "m"));
    // 其余三步与不带口令时逐字相同。
    const plainSteps = buildClusterEnvSteps({ port: PORT, noProxyExtra: ["10.0.0.5"] });
    assert.deepEqual(ssh.calls.filter((c) => c.kind === "other").map((c) => c.cmd), plainSteps.slice(1).map((s) => s.command));
    // Claude 设置：带口令的地址经标准输入写进去。
    const claudeWrite = ssh.calls.find((c) => c.kind === "claude-write");
    assert.equal(JSON.parse(claudeWrite.input).env.HTTPS_PROXY, `http://cwb:${credential.password}@127.0.0.1:${PORT}`);
    assert.match(out, new RegExp(`一并写入本机的代理口令（工作台的口令模式是「${mode === "observe" ? "只记录" : "强制"}」）：内容经 ssh 的标准输入送达，不进命令行，终端里也不显示。`));
    assert.match(out, /已写入 ~\/\.config\/cluster-workbench\/env\.sh（反向端口 7891），带本机当前的代理口令/);
    assert.match(out, /自检：ssh myserver 'bash -lc "echo \\\$\{HTTPS_PROXY##\*@\}"'（应为 127\.0\.0\.1:7891；这样查不会把口令显示出来）/);
    assertNoSecret(credential.password, ssh, out);
  }
});

test("口令模式是关、但本机存着口令：集群上原来带着才带（只读探测一次）；明确没带 / 没有 env.sh 不带；探测失败宁可带上", async (t) => {
  const data = dataDir(t, { mode: "observe", thenMode: "off" });
  const credential = { user: "cwb", password: data.token() };
  const read = (cred) => ({ status: 0, stdout: `__CWB_ENV_PORT__=7891\n__CWB_ENV_CRED__=${cred}\n` });

  // 曾写到过集群（哪一个口令都算，换过口令的旧值也算）→ 照带当前的。
  for (const fp of [credentialFingerprint(credential), credentialFingerprint({ user: "cwb", password: "OldTokenAAAAbbbbCCCCdddd01234567" }), "nohash"]) {
    const ssh = fakeSsh({ scan: SCAN_NONE, envRead: read(fp) });
    const { result, out } = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: data.read() });
    assert.equal(result.proxyCredential, "kept", fp);
    assert.equal(ssh.kinds()[0], "env-read", "先只读探测，再写");
    assert.equal(ssh.calls.find((c) => c.kind === "write-env").input, renderClusterEnv({ port: PORT, credential }));
    assert.match(out, /口令模式是「关」，集群上那份原来带着口令：照带/);
    assertNoSecret(credential.password, ssh, out);
  }

  // 集群上明确没带，或还没有 env.sh：不带，写出来的与没有口令时逐字相同（只多一次只读探测）。
  for (const envRead of [read("none"), { status: 0, stdout: "__CWB_ENV_PORT__=absent\n" }]) {
    const ssh = fakeSsh({ scan: SCAN_NONE, envRead });
    const plain = fakeSsh({ scan: SCAN_NONE });
    const { result, out } = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: data.read() });
    const base = await run({ dryRun: false, ssh: plain, ask: askWith() });
    assert.equal(result.proxyCredential, null);
    assert.equal(out, base.out, "终端输出与没有口令时相同");
    assert.deepEqual(ssh.calls.slice(1), plain.calls, "除了开头那次只读探测，SSH 调用与没有口令时相同");
  }

  // 探测失败 / 输出被截断：宁可带上（多带一个口令在「关」下不影响出网）。
  for (const envRead of [{ status: 255, stdout: "", stderr: "Connection closed" }, { status: 0, stdout: "garbage\n" }]) {
    const ssh = fakeSsh({ scan: SCAN_NONE, envRead });
    const { result, out } = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: data.read() });
    assert.equal(result.proxyCredential, "unknown");
    assert.match(out, /没查到集群上那份带没带口令：照带/);
    assertNoSecret(credential.password, ssh, out);
  }
});

test("--dry-run 预览：说明会写入口令，写入内容里口令打码；只发只读命令；终端里没有口令", async (t) => {
  const data = dataDir(t, { mode: "enforce" });
  const token = data.token();
  const ssh = fakeSsh({ claude: { status: 0, stdout: '__CWB_CLAUDE__=1\n{"hooks":{}}' } });
  const { result, out } = await run({ dryRun: true, ssh, ask: askWith(), proxyAuth: data.read() });
  assert.equal(result.status, "dry-run");
  assert.equal(result.proxyCredential, "enabled");
  assert.deepEqual(ssh.kinds(), ["scan", "claude-read"], "dry-run 只发只读命令");
  assert.match(out, /\[dry-run\] 一并写入本机的代理口令（工作台的口令模式是「强制」）：内容经 ssh 的标准输入送达，不进命令行；下面预览里的口令已打码。/);
  assert.match(out, /export HTTPS_PROXY="http:\/\/cwb:••••••@127\.0\.0\.1:7891"/, "预览里口令打码");
  assert.match(out, /带口令，文件与备份的权限收到 600/);
  assertNoSecret(token, ssh, out);

  // 口令模式是关、预览不探测（probeInDryRun:false）：零 SSH，按「读不出来，宁可带上」预览。
  const off = dataDir(t, { mode: "observe", thenMode: "off" });
  const quiet = fakeSsh();
  const preview = await run({ dryRun: true, ssh: quiet, ask: askWith(), probeInDryRun: false, proxyAuth: off.read() });
  assert.deepEqual(quiet.calls, []);
  assert.equal(preview.result.proxyCredential, "unknown");
  assert.match(preview.out, /••••••/);
  assertNoSecret(off.token(), quiet, preview.out);
});

test("带口令时的失败路径：给人复制的手动命令与 Claude 键一律打码，不出现口令", async (t) => {
  const data = dataDir(t, { mode: "observe" });
  const token = data.token();
  const cases = [
    { fail: { "write-env": true }, expect: /上面的口令已打码：手动写不了带口令的版本，请在工作台里重新点「把口令写到集群」/ },
    { claude: { status: 0, stdout: "__CWB_CLAUDE__=1\n{oops" }, expect: /"HTTPS_PROXY": "http:\/\/cwb:••••••@127\.0\.0\.1:7891"[\s\S]*口令已打码：完整的地址与集群上 ~\/\.config\/cluster-workbench\/env\.sh 里 HTTPS_PROXY 的值相同/ },
    { fail: { "claude-write": true }, expect: /"HTTPS_PROXY": "http:\/\/cwb:••••••@127\.0\.0\.1:7891"/ },
  ];
  for (const c of cases) {
    const ssh = fakeSsh({ scan: SCAN_NONE, ...c });
    const { out } = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: data.read() });
    assert.match(out, c.expect);
    assertNoSecret(token, ssh, out);
  }
});

test("口令文件坏了：提醒一句，这次不带口令（其余与没有口令时相同）", async (t) => {
  const broken = dataDir(t);
  fs.mkdirSync(path.dirname(broken.filePath), { recursive: true });
  fs.writeFileSync(broken.filePath, "{oops");
  const ssh = fakeSsh({ scan: SCAN_NONE });
  const { result, out } = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: broken.read() });
  assert.equal(result.proxyCredential, null);
  assert.match(out, /本机的代理口令文件内容损坏（not-json），这次写入不带口令/);
  assert.equal(ssh.kinds().includes("env-read"), false);
});

// ---------------------------------------------------------------------------
// 端到端：「ssh」换成在临时 HOME 里执行的本机 bash；App 的「把口令写到集群」用 cluster-env-sync 在另一个 HOME 里真跑
// ---------------------------------------------------------------------------

function localSsh(home) {
  const calls = [];
  const ssh = (_host, cmd, opts = {}) => {
    calls.push({ cmd, input: opts.input ?? null });
    return spawnSync("bash", ["-c", `umask 0002; ${cmd}`], { encoding: "utf8", input: opts.input ?? "", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  };
  ssh.calls = calls;
  return ssh;
}

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-proxy-cred-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".bashrc"), "# ~/.bashrc\n");
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`);
  return home;
}

const envFile = (home) => fs.readFileSync(path.join(home, ".config/cluster-workbench/env.sh"), "utf8");
const settingsFile = (home) => fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8");
const clusterFingerprint = (home) => parseEnvCredentialRead(spawnSync("bash", ["-c", buildEnvPortReadCommand()], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } }).stdout);

test("端到端：App 把口令写到集群之后重跑向导，口令还在、内容与 App 写的逐字节相同，集群回报的指纹就是本机当前口令（「已写入当前口令」）", { skip }, async (t) => {
  const data = dataDir(t, { mode: "enforce" });
  const credential = { user: "cwb", password: data.token() };

  // A：向导第一次（还没口令时）→ App「把口令写到集群」。
  const homeA = tempHome(t);
  const first = await run({ dryRun: false, ssh: localSsh(homeA), ask: askWith() });
  assert.equal(first.result.status, "ok");
  assert.equal(clusterFingerprint(homeA), "none");
  const appCalls = [];
  const app = createClusterEnvSync({
    getConfig: async () => ({ activeServerId: "server-01", servers: [{ id: "server-01", host: "h", source: "team", remotePort: PORT }] }),
    runRemote: async (_server, _config, command, options = {}) => {
      appCalls.push({ cmd: command, input: options.input ?? null });
      const res = spawnSync("sh", ["-c", command], { encoding: "utf8", input: options.input ?? "", env: { HOME: homeA, PATH: "/usr/bin:/bin" } });
      return { code: res.status, stdout: res.stdout, stderr: res.stderr };
    },
    autoCheck: false,
    getProxyCredential: () => credential,
  });
  const synced = await app.syncCredential("server-01", { preview: false });
  assert.equal(synced.status, "synced");
  assert.equal(clusterFingerprint(homeA), credentialFingerprint(credential));
  const appEnv = envFile(homeA);
  const appSettings = settingsFile(homeA);

  // 重跑向导（口令模式是强制）：口令没被冲掉，文件一个字节都没变。
  const ssh = localSsh(homeA);
  const rerun = await run({ dryRun: false, ssh, ask: askWith(), proxyAuth: data.read() });
  assert.equal(rerun.result.status, "ok");
  assert.equal(envFile(homeA), appEnv);
  assert.equal(settingsFile(homeA), appSettings);
  assert.equal(fs.statSync(path.join(homeA, ".config/cluster-workbench/env.sh")).mode & 0o777, 0o600);
  // App 判断「集群上是哪一个口令」用的就是这份指纹：current。
  assert.equal(clusterFingerprint(homeA), credentialFingerprint(credential));
  await app.check("server-01");
  assert.equal(app.getCredentialState("server-01").fingerprint, credentialFingerprint(credential));
  assertNoSecret(credential.password, ssh, rerun.out);
  assertNoSecret(credential.password, { calls: appCalls }, "");

  // B：从没点过「写到集群」，直接重跑向导（口令模式是强制）——写出来的与 App 写的逐字节相同。
  const homeB = tempHome(t);
  await run({ dryRun: false, ssh: localSsh(homeB), ask: askWith() });
  await run({ dryRun: false, ssh: localSsh(homeB), ask: askWith(), proxyAuth: data.read() });
  assert.equal(envFile(homeB), appEnv);
  assert.equal(settingsFile(homeB), appSettings);

  // 旧的调用方式（不传 proxyAuth）就是以前的行为：口令被冲掉——这正是这次修的问题。
  await run({ dryRun: false, ssh: localSsh(homeB), ask: askWith() });
  assert.equal(clusterFingerprint(homeB), "none");
});
