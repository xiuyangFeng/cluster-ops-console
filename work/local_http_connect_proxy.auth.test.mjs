// 代理口令的真实进程端到端（v2.62）：起真实的代理子进程（随机端口、临时运行目录，绝不碰 8888 与生产目录），
// 按控制面的写法改口令文件，看运行中的代理约 2 秒内跟上；外加真实 curl / Node 带口令走代理的兼容性。
// 起子进程的用例按 agent.md 的约定给足时限：这台机器吃紧时起一个进程会卡上几十秒。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAuthPolicy, CONNECT_AUTH_REQUIRED_RESPONSE, validateProxyAuthDocument } from "./monitor/lib/proxy/auth.mjs";
import { createProxyServer } from "./monitor/lib/proxy/server.mjs";
import { parseUsageDocument } from "./monitor/lib/proxy/usage.mjs";

const proxyScript = fileURLToPath(new URL("./local_http_connect_proxy.mjs", import.meta.url));
const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const NEW_TOKEN = "NextTokenEEEEffffGGGGhhhh7654321";
const WRONG = "WrongTokenQQQQrrrrSSSStttt555555";
const SPAWN_TIMEOUT_MS = 60_000;
const basic = (token) => `Basic ${Buffer.from(`cwb:${token}`).toString("base64")}`;
const authDoc = (extra = {}) => JSON.stringify({ v: 1, mode: "enforce", user: "cwb", token: TOKEN, updatedAt: Date.now(), ...extra });

function rawExchange(port, text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, "127.0.0.1", () => socket.write(text));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.on("error", reject);
  });
}

// 探针：CONNECT 一个默认策略必拒的目标（回环）。没有口令这一关时是 403；强制且没带对口令时是 407，
// 带对了又回到 403——不需要任何能真连上的外网目标，就能分清口令这一关开没开。
const probe = (port, token) => rawExchange(port, ["CONNECT 127.0.0.1:9 HTTP/1.1", "Host: 127.0.0.1:9", ...(token ? [`Proxy-Authorization: ${basic(token)}`] : []), "", ""].join("\r\n"));
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\n\r\n";

async function waitFor(check, { timeoutMs = 15_000, stepMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

async function tempRuntime(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, "{}");
  const runtimeDir = path.join(dir, "data", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  const authPath = path.join(runtimeDir, "proxy-auth.json");
  let seq = 0;
  // 与控制面一样：临时文件 + 改名（原子替换，文件戳必变）。
  const writeAuth = async (text) => {
    seq += 1;
    const tmp = `${authPath}.tmp.${seq}`;
    await writeFile(tmp, text, { mode: 0o600 });
    await rename(tmp, authPath);
  };
  const env = {
    ...process.env,
    PORT: "0",
    CODEX_MONITOR_CONFIG_PATH: configPath,
    CODEX_MONITOR_LOCAL_CONFIG_PATH: path.join(dir, "config.local.json"),
    CODEX_MONITOR_DATA_DIR: path.join(dir, "data"),
  };
  return { dir, runtimeDir, authPath, usagePath: path.join(runtimeDir, "proxy-usage.json"), writeAuth, env };
}

async function spawnProxy(t, env) {
  const child = spawn(process.execPath, [proxyScript], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { child.kill("SIGKILL"); } catch {} });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => { output.stdout += chunk; });
  child.stderr.on("data", (chunk) => { output.stderr += chunk; });
  const port = await waitFor(() => {
    const match = output.stdout.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
    return match ? Number(match[1]) : null;
  }, { timeoutMs: SPAWN_TIMEOUT_MS, stepMs: 50 });
  assert.ok(port, `代理没有起来: ${JSON.stringify(output)}`);
  return { child, port, output, all: () => `${output.stdout}\n${output.stderr}` };
}

test("e2e：运行中的代理跟着口令文件走——没有文件 → 强制 → 换口令 → 改坏 → 修成只记录 → 删掉；全程同一个进程", { timeout: 180_000 }, async (t) => {
  const rt = await tempRuntime(t, "proxy-auth-e2e-");
  const { child, port, output, all } = await spawnProxy(t, rt.env);
  const pid = child.pid;

  // ① 没有口令文件：与以前一样，不带任何口令也只看放行策略；启动日志里没有口令相关的行。
  //    使用记录（去向与流量）v2.88 起与口令模式无关，一直记、一直写。
  assert.equal(await probe(port), FORBIDDEN);
  assert.equal(await probe(port, WRONG), FORBIDDEN, "关着的时候不看这个头");
  assert.doesNotMatch(all(), /口令|auth-deny/);
  assert.ok(await waitFor(async () => stat(rt.usagePath).then(() => true, () => false)), "口令关着也写使用记录");

  // ② 写入「强制」：约 2 秒内，没带 / 带错 → 407，带对 → 回到放行策略的 403。
  await rt.writeAuth(authDoc());
  assert.ok(await waitFor(async () => (await probe(port)) === CONNECT_AUTH_REQUIRED_RESPONSE), `强制应热载生效: ${all()}`);
  assert.equal(await probe(port, WRONG), CONNECT_AUTH_REQUIRED_RESPONSE);
  assert.equal(await probe(port, TOKEN), FORBIDDEN);
  assert.match(output.stderr, /\[proxy-config\] 代理口令已生效：强制/);
  // /proxy-health 不受影响。
  assert.match(await rawExchange(port, "GET /proxy-health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 200 OK\r\n/);

  // ③ 换口令：新口令立即可用，旧口令在过渡期内继续可用。
  await rt.writeAuth(authDoc({ token: NEW_TOKEN, previousToken: TOKEN, previousUntil: Date.now() + 60_000 }));
  assert.ok(await waitFor(async () => (await probe(port, NEW_TOKEN)) === FORBIDDEN), `新口令应生效: ${all()}`);
  assert.equal(await probe(port, TOKEN), FORBIDDEN, "过渡期内旧口令仍接受");
  assert.equal(await probe(port), CONNECT_AUTH_REQUIRED_RESPONSE);

  // ④ 文件被改坏：保留上一份（仍强制、两个口令都认），只告警一次。
  await rt.writeAuth('{ "v": 1, "mode": "enfor');
  assert.ok(await waitFor(() => /口令文件格式不对（not-json），口令设置保持「强制」不变/.test(output.stderr)), `应有坏文件告警: ${all()}`);
  assert.equal(await probe(port), CONNECT_AUTH_REQUIRED_RESPONSE);
  assert.equal(await probe(port, NEW_TOKEN), FORBIDDEN);

  // ⑤ 修成「只记录」：不再拦任何请求。
  await rt.writeAuth(authDoc({ mode: "observe", token: NEW_TOKEN }));
  assert.ok(await waitFor(async () => (await probe(port)) === FORBIDDEN), `只记录应放行: ${all()}`);

  // ⑥ 删掉文件：回到关。
  await unlink(rt.authPath);
  assert.ok(await waitFor(() => /代理口令已生效：关/.test(output.stderr)), `删掉文件应回到关: ${all()}`);
  assert.equal(await probe(port), FORBIDDEN);

  assert.equal(child.pid, pid);
  assert.equal(child.exitCode, null, "全程同一个代理进程，没有重启");

  // 使用记录：模式一变就落盘（控制面据此确认代理已按新设置在跑）；0600；里面是目标与计数，没有口令。
  const usageText = await waitFor(async () => {
    try {
      const text = await readFile(rt.usagePath, "utf8");
      return parseUsageDocument(text)?.auth.mode === "off" ? text : null;
    } catch {
      return null;
    }
  });
  assert.ok(usageText, "切回关之后写了最后一次");
  const usage = parseUsageDocument(usageText);
  assert.equal(usage.pid, pid);
  if (process.platform !== "win32") assert.equal((await stat(rt.usagePath)).mode & 0o777, 0o600);
  const denied = usage.hours.flatMap((hour) => [...hour.targets.values()]).reduce((sum, row) => sum + row[7], 0);
  assert.ok(denied >= 3, `被拒次数应记下来，实际 ${denied}`);

  // 口令（及其 base64）不出现在代理的任何输出与它写的文件里。
  const secrets = [TOKEN, NEW_TOKEN, WRONG].flatMap((token) => [token, Buffer.from(`cwb:${token}`).toString("base64")]);
  for (const secret of secrets) {
    assert.equal(all().includes(secret), false, "stdout / stderr 里不该有口令");
    assert.equal(usageText.includes(secret), false, "使用记录里不该有口令");
  }
  // auth-deny 有限频：这么多次被拒，日志里只有一两行。
  const denyLines = output.stdout.split("\n").filter((line) => line.startsWith("auth-deny "));
  assert.ok(denyLines.length >= 1 && denyLines.length <= 3, JSON.stringify(denyLines));
});

test("e2e：启动时口令文件就是坏的——照常起来，按关运行（放行着的不会变成拒绝），告警一行", { timeout: 120_000 }, async (t) => {
  const rt = await tempRuntime(t, "proxy-auth-broken-");
  await rt.writeAuth("{ not json at all");
  const { child, port, output } = await spawnProxy(t, rt.env);
  assert.equal(await probe(port), FORBIDDEN, "不带口令也没有被 407 拦下");
  assert.match(output.stderr, /口令文件格式不对（not-json），口令设置保持「关」不变/);
  assert.equal(child.exitCode, null);
  // 修好之后照常热载。
  await rt.writeAuth(authDoc());
  assert.ok(await waitFor(async () => (await probe(port)) === CONNECT_AUTH_REQUIRED_RESPONSE), output.stderr);
});

// ---- 真实客户端的兼容性：带口令的代理地址、curl 从标准输入读 proxy-user ----

const curlPath = process.platform === "win32" ? null : spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim() || null;

async function startEnforcingProxy(t) {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("origin-ok");
  });
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const lines = [];
  const auth = buildAuthPolicy(validateProxyAuthDocument(JSON.parse(authDoc())).doc);
  const proxy = createProxyServer({ port: 0, log: (line) => lines.push(line), getPolicy: () => ({ allowTarget: () => true, upstream: null, egressMode: "direct", auth }) });
  await new Promise((resolve) => proxy.listen(resolve));
  t.after(async () => {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => origin.close(resolve));
  });
  return { proxyPort: proxy.server.address().port, originUrl: `http://127.0.0.1:${origin.address().port}/`, lines };
}

function run(command, args, { env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    // 把这台机器上现有的代理 / 免代理变量清掉：测的是我们给的那一份。
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:(?:https?|all|no)_proxy|curl_home)$/i.test(key)));
    const child = spawn(command, args, { env: { ...clean, ...env }, stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), SPAWN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(err?.message || err) });
    });
    if (input !== null) child.stdin.end(input);
  });
}

test("真实 curl：代理地址里带口令、环境变量里带口令、从标准输入读 proxy-user 三种写法都能过强制；不带的 407", { skip: curlPath ? false : "没有 curl", timeout: 240_000 }, async (t) => {
  const { proxyPort, originUrl } = await startEnforcingProxy(t);
  // -q：不读这台机器上的 ~/.curlrc；--proxytunnel：http 目标也走 CONNECT（与 https 同一条路）。
  const base = ["-q", "-sS", "-o", "/dev/null", "-w", "%{http_connect} %{http_code}", "--max-time", "20", "--proxytunnel"];
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const authedUrl = `http://cwb:${TOKEN}@127.0.0.1:${proxyPort}`;

  const inUrl = await run(curlPath, [...base, "-x", authedUrl, originUrl]);
  assert.equal(inUrl.stdout, "200 200", `代理地址带口令: ${JSON.stringify(inUrl)}`);

  // 集群上 env.sh 写的就是这种环境变量；curl 对 http 目标只认小写的 http_proxy。
  const inEnv = await run(curlPath, [...base, originUrl], { env: { http_proxy: authedUrl } });
  assert.equal(inEnv.stdout, "200 200", `环境变量带口令: ${JSON.stringify(inEnv)}`);

  // 工作台自己发到集群的探测就是这么带口令的：-x 里没有口令，口令经标准输入交给 curl，不进任何命令行。
  const fromStdin = await run(curlPath, [...base, "-x", proxyUrl, "-K", "-", originUrl], { input: `proxy-user = "cwb:${TOKEN}"\n` });
  assert.equal(fromStdin.stdout, "200 200", `标准输入给 proxy-user: ${JSON.stringify(fromStdin)}`);
  // 没有标准输入内容（关着的时候就是这样）时 -K - 读到空文件，等于没写。
  const emptyStdin = await run(curlPath, [...base, "-x", proxyUrl, "-K", "-", originUrl], { input: "" });
  assert.match(emptyStdin.stdout, /^407 /, `空的标准输入: ${JSON.stringify(emptyStdin)}`);

  const none = await run(curlPath, [...base, "-x", proxyUrl, originUrl]);
  assert.match(none.stdout, /^407 /, `不带口令: ${JSON.stringify(none)}`);
  const wrong = await run(curlPath, [...base, "-x", `http://cwb:${WRONG}@127.0.0.1:${proxyPort}`, originUrl]);
  assert.match(wrong.stdout, /^407 /, `带错口令: ${JSON.stringify(wrong)}`);

  // 明文转发（不走 CONNECT）同样的判定。
  const plain = ["-q", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20"];
  assert.equal((await run(curlPath, [...plain, "-x", authedUrl, originUrl])).stdout, "200");
  assert.equal((await run(curlPath, [...plain, "-x", proxyUrl, originUrl])).stdout, "407");
});

test("真实 Node（fetch 读环境变量里的代理地址）：带口令的地址能过强制", { timeout: 180_000 }, async (t) => {
  const { proxyPort, originUrl, lines } = await startEnforcingProxy(t);
  const script = `fetch(${JSON.stringify(originUrl)}).then(async (r) => console.log(r.status, await r.text())).catch((e) => console.log("ERR", e?.cause?.message || e?.message))`;
  const result = await run(process.execPath, ["-e", script], { env: { NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://cwb:${TOKEN}@127.0.0.1:${proxyPort}`, http_proxy: `http://cwb:${TOKEN}@127.0.0.1:${proxyPort}` } });
  // 这个版本的 Node 不认 NODE_USE_ENV_PROXY 时请求不经代理（代理一行日志都没有）：那就测不了，如实跳过。
  if (lines.length === 0) {
    t.skip(`这个 Node（${process.version}）的 fetch 不读环境变量里的代理`);
    return;
  }
  assert.equal(result.stdout.trim(), "200 origin-ok", JSON.stringify({ result, lines }));
  assert.equal(lines.some((line) => line.startsWith("auth-deny")), false, JSON.stringify(lines));
});
