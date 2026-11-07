// Paseo 中继预加载与代理口令（v2.62）：把预加载源码原样写成 .cjs，起一个真实的 node 子进程去连一个假代理，
// 看它发出的 CONNECT 里带没带口令。假家目录、随机端口，不碰真实的 ~/.paseo 与任何真实代理。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { renderClusterEnv } from "../cluster-env.mjs";
import { RELAY_PROXY_PRELOAD_SOURCE } from "./relay-proxy-preload.mjs";

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const CRED = { user: "cwb", password: TOKEN };

// 假代理：记下收到的第一段请求，回 403 让客户端尽快收尾。
async function fakeProxy(t) {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (buf) => {
      seen.push(String(buf));
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, seen };
}

// 在假家目录里跑一次：预加载之后发起一条到 relay.paseo.sh:443 的 TLS 连接（会被预加载改成经代理的 CONNECT）。
function connectOnce(t, { proxyPort, envSh }) {
  const home = mkdtempSync(path.join(tmpdir(), "relay-preload-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const preload = path.join(home, "relay-proxy.cjs");
  writeFileSync(preload, RELAY_PROXY_PRELOAD_SOURCE);
  if (envSh !== undefined) {
    mkdirSync(path.join(home, ".config", "cluster-workbench"), { recursive: true });
    writeFileSync(path.join(home, ".config", "cluster-workbench", "env.sh"), envSh, { mode: 0o600 });
  }
  // lookup 把这个主机名钉在本机回环：万一预加载没有生效（没有改走代理），这条连接也只会打到本机的 443，
  // 出不了这台电脑——测试绝不真的去连 paseo 的中继。
  const script = 'const tls = require("node:tls"); const s = tls.connect({ host: "relay.paseo.sh", port: 443, servername: "relay.paseo.sh", lookup: (h, o, cb) => cb(null, "127.0.0.1", 4) }); s.on("error", () => process.exit(0)); s.on("close", () => process.exit(0)); setTimeout(() => process.exit(3), 20000);';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--require", preload, "-e", script], {
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, PASEO_RELAY_PROXY_PORT: String(proxyPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

const PLAIN_CONNECT = "CONNECT relay.paseo.sh:443 HTTP/1.1\r\nHost: relay.paseo.sh:443\r\n\r\n";

test("预加载：env.sh 不带口令 / 没有 env.sh 时，CONNECT 与以前逐字相同", { timeout: 180_000 }, async (t) => {
  const proxy = await fakeProxy(t);
  await connectOnce(t, { proxyPort: proxy.port });
  await connectOnce(t, { proxyPort: proxy.port, envSh: renderClusterEnv({ port: proxy.port }) });
  assert.deepEqual(proxy.seen, [PLAIN_CONNECT, PLAIN_CONNECT]);
});

test("预加载：env.sh 带着指向同一个端口的口令 → CONNECT 多一行 Proxy-Authorization（现读文件，换口令后不用重启守护进程）", { timeout: 180_000 }, async (t) => {
  const proxy = await fakeProxy(t);
  await connectOnce(t, { proxyPort: proxy.port, envSh: renderClusterEnv({ port: proxy.port, credential: CRED }) });
  assert.deepEqual(proxy.seen, [
    `CONNECT relay.paseo.sh:443 HTTP/1.1\r\nHost: relay.paseo.sh:443\r\nProxy-Authorization: Basic ${Buffer.from(`cwb:${TOKEN}`).toString("base64")}\r\n\r\n`,
  ]);
});

test("预加载：env.sh 的口令是给另一个端口的（端口重新分配过）→ 不带——那个端口现在可能是别人的隧道", { timeout: 180_000 }, async (t) => {
  const proxy = await fakeProxy(t);
  const otherPort = proxy.port === 7999 ? 7998 : 7999;
  await connectOnce(t, { proxyPort: proxy.port, envSh: renderClusterEnv({ port: otherPort, credential: CRED }) });
  assert.deepEqual(proxy.seen, [PLAIN_CONNECT]);
});
