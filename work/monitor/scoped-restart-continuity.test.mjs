// A18 单隧道重启连续性验收（T04b）——隔离等价装置，不连接真实集群。
//
// 装置（设计 §16.1 第 4 层："双隧道或可证明等价的测试装置，验证字节流连续性"）：
//   - 回显服务（进程内）：TCP echo，代表远端集群侧服务。
//   - 共享代理（独立子进程，有真实 PID）：所有"隧道"的公共汇聚点，等价于本地
//     CONNECT 代理的角色（代理白名单禁止 loopback 目标，故用等价 TCP 汇聚点）。
//   - A/B 两条"隧道"：createTunnelController 真实管理的子进程（spawnImpl 把 ssh
//     换成等价转发器：监听各自的 remotePort，转发到共享代理端口）。生命周期、
//     pid 记录、kill/exit 事件全部真实。
//   - 验收动作：经 A、B 各建立一条长连接持续双向传输；通过真实 operations-runner
//     + 控制信箱 + restartControlled 重启 A。判定：
//       1) B 的字节流全程无缺失、无中断（仅看 B 的 PID 不变不算通过）；
//       2) 共享代理进程 PID 不变、B 隧道进程 PID 不变；
//       3) A 的隧道进程被替换（旧 PID 退出、新 PID 接管）；
//       4) 操作终态 succeeded，证据含远端监听核实。
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTunnelController } from "./lib/supervisor/tunnel-controller.mjs";
import { createOperationsRunner } from "./lib/operations-runner.mjs";
import { createControlMailbox, CONTROL_ACTION_RESTART_TUNNEL } from "./lib/supervisor-control.mjs";
import { buildThreeServerConfig } from "./lib/m1-fixtures.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 等价转发器：监听 FWD_LISTEN，双向管道到 127.0.0.1:FWD_TARGET。
const FORWARDER_SCRIPT = [
  'const net = require("node:net");',
  "const listen = Number(process.env.FWD_LISTEN);",
  "const target = Number(process.env.FWD_TARGET);",
  "const server = net.createServer((client) => {",
  "  const upstream = net.connect(target, '127.0.0.1');",
  "  client.pipe(upstream);",
  "  upstream.pipe(client);",
  "  const bail = () => { client.destroy(); upstream.destroy(); };",
  "  client.on('error', bail);",
  "  upstream.on('error', bail);",
  "});",
  "server.on('error', () => process.exit(1));",
  "server.listen(listen, '127.0.0.1');",
].join("\n");

// 共享代理：等价于本地 CONNECT 代理的 TCP 汇聚角色（监听代理端口，转发到回显端口）。
const SHARED_PROXY_SCRIPT = FORWARDER_SCRIPT;

async function listen(port = 0, socketRegistry = null) {
  const server = net.createServer((socket) => {
    if (socketRegistry) socketRegistry.add(socket);
    socket.on("close", () => socketRegistry?.delete(socket));
    socket.on("data", (chunk) => {
      socket.write(Buffer.from(chunk));
    });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { server, port: server.address().port };
}

function waitUntilTcpOpen(port, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`port ${port} never opened`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

// 真实 TCP 探测替代 ssh 探测：remotePortOpen 的 execFileImpl 注入。
// 探测命令形如 `(ss -lnt | grep -q :PORT || nc -z 127.0.0.1 PORT || ...)`，
// 从中取端口号做真实本机 TCP connect（等价"远端端口监听核实"）。
function makeRemoteProbe() {
  return async (file, args, options = {}) => {
    if (file !== "ssh") throw new Error(`unexpected probe binary ${file}`);
    const command = args.at(-1) || "";
    const match = command.match(/:(\d+)/);
    const remotePort = match ? Number(match[1]) : NaN;
    if (!Number.isInteger(remotePort)) return { code: 1, stdout: "", stderr: "no port", timedOut: false };
    const open = await new Promise((resolve) => {
      const socket = net.connect(remotePort, "127.0.0.1");
      const done = (ok) => {
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
      setTimeout(() => done(false), options.timeoutMs || 2000);
    });
    return { code: open ? 0 : 1, stdout: open ? "__PORT_OPEN__\n" : "", stderr: "", timedOut: false };
  };
}

test("A18: 重启 A 期间 B 持续双向传输——字节流连续、共享代理与 B 进程稳定", { timeout: 45000 }, async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "m1-continuity-"));
  const runtimeDir = path.join(dataRoot, "runtime");
  const echoSockets = new Set();
  const echo = await listen(0, echoSockets);
  const proxyPort = 38000 + Math.floor(Math.random() * 2000);
  const remotePortA = 39000 + Math.floor(Math.random() * 200);
  const remotePortB = 39000 + Math.floor(Math.random() * 200) + 300;
  const allChildren = [];
  const proxyChild = spawn(process.execPath, ["-e", SHARED_PROXY_SCRIPT], {
    env: { ...process.env, FWD_LISTEN: String(proxyPort), FWD_TARGET: String(echo.port) },
    stdio: "ignore",
  });
  allChildren.push(proxyChild);
  // 清理登记：任何退出路径都必须杀光子进程、断光回显连接，否则事件循环排不干，
  // node --test 进程会挂着不退（这正是首版测试挂死的根因）。
  const cleanup = async () => {
    for (const child of allChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
    for (const socket of echoSockets) {
      try { socket.destroy(); } catch {}
    }
    try { echo.server.close(); } catch {}
    bClientRef.destroy?.();
    aClientRef.destroy?.();
    aClient2Ref.destroy?.();
    await a.controller?.stopCurrent().catch(() => {});
    await b.controller?.stopCurrent().catch(() => {});
  };
  let bClientRef = {};
  let aClientRef = {};
  let aClient2Ref = {};
  let a = null;
  let b = null;
  try {
    await waitUntilTcpOpen(proxyPort);

    const spawnedPids = { "fixture-a": [], "fixture-b": [] };
    function makeController(serverId, remotePort) {
      const config = { id: serverId, serverId, host: `${serverId}.invalid`, remotePort, localPort: proxyPort };
      const controller = createTunnelController({
        spawnImpl: (file, args, options) => {
          if (file !== "ssh") throw new Error(`unexpected spawn ${file}`);
          const forward = args[args.indexOf("-R") + 1];
          const rp = Number(forward.split(":")[1]);
          const child = spawn(process.execPath, ["-e", FORWARDER_SCRIPT], {
            ...(options || {}),
            env: { ...(options?.env || process.env), FWD_LISTEN: String(rp), FWD_TARGET: String(proxyPort) },
          });
          allChildren.push(child);
          spawnedPids[serverId].push(child.pid);
          return child;
        },
        execFileImpl: makeRemoteProbe(),
        registry: null,
        name: `tunnel.${serverId}`,
        log: () => {},
        rootDir: dataRoot,
        probeTimeoutMs: 3000,
      });
      return { config, controller };
    }

    a = makeController("fixture-a", remotePortA);
    b = makeController("fixture-b", remotePortB);
    const controllers = new Map([
      ["fixture-a", a],
      ["fixture-b", b],
    ]);

    await a.controller.ensure(a.config, { stopping: () => false });
    await b.controller.ensure(b.config, { stopping: () => false });
    await waitUntilTcpOpen(remotePortA);
    await waitUntilTcpOpen(remotePortB);

    // ---- 双向流：B 的长连接（持续传输贯穿整个重启窗口）----
    const bClient = net.connect(remotePortB, "127.0.0.1");
    bClientRef = bClient;
    let bClosed = false;
    let bError = null;
    let bReceived = Buffer.alloc(0);
    let bSent = Buffer.alloc(0);
    bClient.on("close", () => { bClosed = true; });
    bClient.on("error", (err) => { bError = err; });
    bClient.on("data", (chunk) => { bReceived = Buffer.concat([bReceived, chunk]); });
    const verifyB = () => {
      // echo 保序：收到的必须与发送的前缀逐字节一致（字节无缺失、无错位）。
      if (bReceived.length > bSent.length) return false;
      return bSent.subarray(0, bReceived.length).equals(bReceived);
    };

    // A 的连接：重启期间应被中断（隧道进程被替换）。
    const aClient = net.connect(remotePortA, "127.0.0.1");
    aClientRef = aClient;
    let aClosed = false;
    aClient.on("close", () => { aClosed = true; });
    aClient.on("error", () => {});
    await new Promise((resolve) => aClient.once("connect", resolve));
    aClient.write(Buffer.from("A-payload-1;"));
    await new Promise((resolve) => aClient.once("data", resolve));

    const bOldPid = spawnedPids["fixture-b"].at(-1);
    const proxyOldPid = proxyChild.pid;
    assert.ok(bOldPid, "B 隧道进程必须已存在");

    // ---- 触发 A 的单隧道重启（真实 operations-runner + 控制信箱）----
    const instanceId = "abcdef1234567890";
    const mailbox = createControlMailbox({
      runtimeDir,
      instanceId,
      log: () => {},
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async ({ request }) => {
          const entry = controllers.get(request.serverId);
          if (!entry) return { status: "failed", phase: "queued", reason: `no managed tunnel for ${request.serverId}`, evidence: {} };
          return entry.controller.restartControlled(entry.config, { verifyBudgetMs: 15000, verifyIntervalMs: 200 });
        },
      },
    });
    const snapshot = () => ({
      schemaVersion: 1,
      instanceId,
      pid: 1,
      startedAt: 1,
      observedAt: 2,
      configRevision: "rev-1",
      build: {},
      capabilities: { scopedTunnelRestart: true, controlProtocol: 1 },
      effectiveProxyPort: proxyPort,
      targets: {
        "fixture-a": { host: "fixture-a.invalid", remotePort: remotePortA, localPort: proxyPort, signature: `-R 127.0.0.1:${remotePortA}:127.0.0.1:${proxyPort} fixture-a.invalid` },
      },
      stale: false,
    });
    const runner = createOperationsRunner({
      runtimeDir,
      getConfig: async () => buildThreeServerConfig(),
      getSnapshot: snapshot,
      log: () => {},
      timeline: () => {},
    });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    assert.equal(preview.impact.serverIds.join(","), "fixture-a");
    assert.equal(preview.impact.otherServersAffected, false);
    const runResult = await runner.run({ previewId: preview.previewId, operationId: "aaaaaaaa-0000-4000-8000-000000000018" });
    assert.equal(runResult.state, "queued");

    // ---- 重启窗口内持续向 B 写数据并即时校验回显 ----
    for (let i = 0; i < 40 && !bClosed; i += 1) {
      const chunk = Buffer.from(`B-${String(i).padStart(4, "0")}:${"x".repeat(512)};`);
      bClient.write(chunk);
      bSent = Buffer.concat([bSent, chunk]);
      await sleep(25);
      if (i % 8 === 0) await mailbox.poll(); // 驱动信箱（等价 supervisor 5s 节拍）
    }
    // 排干回显。
    for (let i = 0; i < 30 && bReceived.length < bSent.length && !bClosed; i += 1) await sleep(50);

    // ---- 判定 ----
    assert.equal(bClosed, false, "B 的连接不得被主动关闭");
    assert.equal(bError, null, "B 的连接不得出错");
    assert.equal(bReceived.length, bSent.length, "B 的回显字节必须完整无缺失");
    assert.ok(verifyB(), "B 的回显流必须与发送流逐字节一致（保序、无缺失）");
    assert.ok(bSent.length > 8 * 1024, `B 的持续传输量必须覆盖重启窗口（实际 ${bSent.length} 字节）`);

    // 等操作终态。
    await mailbox.poll();
    let op = null;
    for (let i = 0; i < 40; i += 1) {
      op = await runner.getOperation("aaaaaaaa-0000-4000-8000-000000000018");
      if (op && ["succeeded", "failed", "unknown"].includes(op.state)) break;
      await sleep(250);
      await mailbox.poll();
    }
    assert.ok(op, "操作必须可查询");
    assert.equal(op.state, "succeeded", `操作应成功，实际 ${op.state}（${op.reason}）`);
    assert.equal(op.evidence.remotePortOpen, true);
    assert.equal(op.evidence.endToEndVerified, false, "端到端连通性以探针为准，不冒充已验证");

    // A 进程被替换；共享代理与 B 进程 PID 稳定（PID 稳定只是附加证据，字节流才是主判据）。
    assert.equal(proxyChild.pid, proxyOldPid, "共享代理进程不得被替换");
    assert.equal(spawnedPids["fixture-b"].at(-1), bOldPid, "B 隧道进程不得被替换");
    assert.ok(spawnedPids["fixture-a"].length >= 2, "A 隧道进程应被重启替换");
    assert.ok(aClosed, "A 的旧连接应随隧道重启中断（只有 A 受影响）");

    // A 的新隧道恢复后可重新建立连接并双向传输。
    await waitUntilTcpOpen(remotePortA, { timeoutMs: 8000 });
    const aClient2 = net.connect(remotePortA, "127.0.0.1");
    aClient2Ref = aClient2;
    const echoBack = new Promise((resolve) => aClient2.once("data", resolve));
    await new Promise((resolve) => aClient2.once("connect", resolve));
    aClient2.write(Buffer.from("A-after-restart;"));
    const echoed = await echoBack;
    assert.equal(echoed.toString(), "A-after-restart;");
    aClient2.destroy();

    bClient.destroy();
    aClient.destroy();
  } finally {
    await cleanup();
    // Windows 在 SIGKILL 之后才异步释放子进程持有的句柄，直接 rmdir 会撞 EBUSY。
    // maxRetries/retryDelay 正是 fs.rm 为此提供的重试，用例断言本身不受影响。
    await rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
