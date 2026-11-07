import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile as readFixtureFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync as readFileSyncForTest } from "node:fs";

import { execFileWithTimeout } from "./lib/exec.mjs";
import { attachPersonalSsh, classifySshFailure } from "./lib/ssh-args.mjs";
import { tunnelRecordName } from "./monitor-core.mjs";
import { reduceBridgeStage, shouldLogBridgeSnapshot } from "./lib/supervisor/bridge-stage.mjs";
import { createLayeredConfigReader, resolveSupervisorConfig, selectActiveServer } from "./lib/supervisor/config.mjs";
import { createCrashGuard } from "./lib/supervisor/crash-guard.mjs";
import { buildShutdownPlan, performHandoffExit } from "./lib/supervisor/handoff.mjs";
import { classifyProxyLogLine, inferSupervisorLogLevel } from "./lib/supervisor/log-policy.mjs";
import { createLocalProxyController, PROXY_DEATH_THRESHOLD } from "./lib/supervisor/proxy-controller.mjs";
import { createTickProxyHealth } from "./lib/supervisor/proxy-health.mjs";
import { diffTunnelTargets, reconcileTunnels } from "./lib/supervisor/reconcile.mjs";
import { remotePortOpen } from "./lib/supervisor/remote-probe.mjs";
import { classifyTunnelSshFailure, createTunnelController, SPAWN_GRACE_MS, TUNNEL_DEATH_THRESHOLD, WAKE_GAP_MS } from "./lib/supervisor/tunnel-controller.mjs";
import { buildTunnelArgs, buildTunnelIdentity, buildTunnelSignature } from "./lib/supervisor/tunnel-spec.mjs";
import { createProcessRegistry } from "./lib/process-registry.mjs";

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

const cfg = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };

test("密码远端探针：通过一次性 broker 认证，凭据失效时不执行 SSH", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supervisor-auth-"));
  let calls = 0;
  try {
    const result = await remotePortOpen({ ...cfg, authRef: "mem:test", knownHostsPath: "/tmp/known host" }, {
      askpassDir: dir,
      credentialVault: { get: async () => "probe-secret" },
      execFileImpl: async (_cmd, args, options) => {
        calls += 1;
        assert.equal(args[1], "BatchMode=no");
        assert.ok(args.includes("ControlPath=none"));
        assert.equal(JSON.stringify({ args, env: options.env }).includes("probe-secret"), false);
        assert.equal((await readFixtureFile(options.env.SSH_ASKPASS, "utf8")).includes("probe-secret"), false);
        const response = await fetch(`${options.env.CODEX_ASKPASS_URL}/password`, { method: "POST", headers: { "x-askpass-token": options.env.CODEX_ASKPASS_TOKEN } });
        assert.equal((await response.json()).password, "probe-secret");
        return { code: 0, timedOut: false };
      },
    });
    assert.equal(result.ok, true);
    await assert.rejects(() => remotePortOpen({ ...cfg, authRef: "mem:expired" }, {
      askpassDir: dir, credentialVault: { get: async () => null }, execFileImpl: async () => { calls += 1; },
    }), (error) => error.code === "auth-missing");
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("密码隧道：spawn 使用 broker；exit/error/同步异常清理且日志参数不含凭据", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "supervisor-spawn-auth-"));
  const secret = "tunnel-password";
  const sessions = [];
  try {
    for (const finish of ["exit", "error", "throw"]) {
      const child = makeFakeChild(7123);
      let disposed = 0;
      let recorded;
      const controller = createTunnelController({
        name: tunnelRecordName(cfg.id),
        credentialVault: { get: async () => secret }, askpassDir: dir,
        createPasswordSshSessionImpl: async ({ password }) => {
          assert.equal(password, secret);
          const session = { args: ["-o", "BatchMode=no"], env: { CODEX_ASKPASS_TOKEN: "one-shot" }, dispose: async () => { disposed += 1; } };
          sessions.push(session);
          return session;
        },
        spawnImpl: (_command, args, opts) => {
          assert.equal(args[1], "BatchMode=no");
          assert.equal(JSON.stringify({ args, env: opts.env }).includes(secret), false);
          if (finish === "throw") throw new Error("spawn failed");
          return child;
        },
        recordRuntimeProcess: (_name, _pid, meta) => { recorded = meta; },
      });
      if (finish === "throw") {
        await assert.rejects(() => controller.restartControlled({ ...cfg, authRef: "mem:test" }, { verifyBudgetMs: 0 }), /spawn failed/);
      } else {
        await controller.restartControlled({ ...cfg, authRef: "mem:test" }, { verifyBudgetMs: 0 });
        assert.equal(JSON.stringify(recorded).includes("one-shot"), false);
        if (finish === "exit") child.emit("exit", 0, null);
        else child.emit("error", new Error("spawn failed"));
      }
      assert.equal(disposed, 1, finish);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("隧道身份变更：端口/用户/密钥/凭据引用/固定主机密钥均须重建", () => {
  const original = { ...cfg, sshPort: 22, sshUser: "tester", sshIdentityFile: "/tmp/key", authRef: "mem:first", knownHostsPath: "/tmp/pin", knownHostsRevision: "old" };
  for (const patch of [{ sshPort: 2222 }, { sshUser: "another" }, { sshIdentityFile: "/tmp/new-key" }, { authRef: "mem:second" }, { knownHostsPath: "/tmp/new-pin" }, { knownHostsRevision: "new" }]) {
    const diff = diffTunnelTargets(new Map([[cfg.id, { config: original }]]), [{ ...original, ...patch }]);
    assert.deepEqual(diff.removed, [cfg.id]);
    assert.equal(diff.added.length, 1);
  }
  const resolved = resolveSupervisorConfig({ servers: [{ ...cfg, authRef: "mem:test" }] });
  assert.equal(resolved.tunnels[0].authRef, "mem:test");
});

test("supervisor 选择 activeServerId 对应的通道配置，不再硬编码 server-01", () => {
  const config = {
    activeServerId: "server-tengxun",
    servers: [
      cfg,
      { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890 },
    ],
  };
  assert.deepEqual(selectActiveServer(config), config.servers[1]);
});

test("bridge snapshot 仅在状态/重连计数变化或心跳到期时记录", () => {
  const previous = {
    snapshot: { stage: "ssh-tunnel", ok: true, reconnects: 2, fastFailures: 1 },
    loggedAt: 1000,
  };
  assert.equal(shouldLogBridgeSnapshot(previous, {
    stage: "ssh-tunnel", ok: true, reconnects: 2, fastFailures: 1, durationMs: 900,
  }, 20_000, 60_000), false);
  assert.equal(shouldLogBridgeSnapshot(previous, {
    stage: "ssh-tunnel", ok: false, reconnects: 2, fastFailures: 1,
  }, 20_000, 60_000), true);
  assert.equal(shouldLogBridgeSnapshot(previous, {
    stage: "ssh-tunnel", ok: true, reconnects: 3, fastFailures: 1,
  }, 20_000, 60_000), true);
  assert.equal(shouldLogBridgeSnapshot(previous, {
    stage: "ssh-tunnel", ok: true, reconnects: 2, fastFailures: 1,
  }, 61_001, 60_000), true);
});

// ---------------------------------------------------------------------------
// S1: exit 处理器身份守卫 + 重建前等旧进程退出（A1）
// ---------------------------------------------------------------------------

test("S1: 旧 child 迟到的 exit 回调不得清空新 child 的模块状态/pid记录", async () => {
  const children = [];
  const spawnImpl = () => {
    const child = makeFakeChild(9000 + children.length);
    children.push(child);
    return child;
  };
  const recorded = new Map();
  const removedRegistryRecords = [];

  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl,
    // 端口始终探测为"ssh 通但端口关"，每个 tick 都会触发重建路径
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    // 模拟 waitForPidExit 立即"确认"旧进程已退出——不依赖 fake child 是否真的已经 emit 'exit'，
    // 这正是复现该 finding 的关键：制造"新 child 已经 spawn，旧 child 的 exit 事件才姗姗来迟"的竞态窗口。
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async (name) => removedRegistryRecords.push(name),
    recordRuntimeProcess: (name, pid) => recorded.set(name, pid),
    log: () => {},
    // 本用例只关心身份守卫，不关心 S2 引入的死计数阈值/宽限期，把两者都调到最敏感即可单次触发重建。
    deathThreshold: 1,
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg);
  const childA = children[0];
  assert.equal(controller.getCurrentChild(), childA, "首次 ensure 应 spawn 出 child A 并成为当前 child");

  await controller.ensure(cfg);
  const childB = children[1];
  assert.equal(children.length, 2, "第二次 ensure 应再次触发重建 spawn 出 child B");
  assert.equal(controller.getCurrentChild(), childB, "第二次 ensure 后当前 child 应已切换为 child B");
  assert.equal(recorded.get(tunnelRecordName(cfg.id)), childB.pid, "注册表应记录 child B 的 pid");

  // 复现竞态：child A 早已被 kill()，但它的 'exit' 事件此刻才触发（在 child B 已成为 current 之后）。
  assert.equal(childA.killed, true, "child A 应已被 kill");
  childA.emit("exit", 1, null);

  assert.equal(controller.getCurrentChild(), childB, "child A 迟到的 exit 不得把当前指针清回 null/清丢 child B");
  assert.equal(
    removedRegistryRecords.filter((n) => n === tunnelRecordName(cfg.id)).length,
    0,
    "child A 迟到的 exit 不得删除 child B 刚写入的注册表记录",
  );
});

test("S1: 冷启动（无历史进程）时 remote 探测失败应直接 spawn，不等待任何旧 pid", async () => {
  let waited = false;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => makeFakeChild(1234),
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => {
      waited = true;
      return true;
    },
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });

  const result = await controller.ensure(cfg);
  assert.equal(result.respawned, true);
  assert.equal(waited, false, "冷启动没有旧 pid 可等，不应调用 waitForPidExit");
  assert.equal(controller.getCurrentChild().pid, 1234);
});

test("S1: remote 探测成功时重置退避且不触碰当前 child", async () => {
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => makeFakeChild(1),
    execFileImpl: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });

  const result = await controller.ensure(cfg);
  assert.equal(result.ok, true);
  assert.equal(controller.getCurrentChild(), null, "探测成功场景下从未 spawn 过任何 child");
  assert.deepEqual(controller.getState().tunnelRetryCount, 0);
});

// ---------------------------------------------------------------------------
// S2: 连续失败阈值 + 退避不被自杀清零 + 建立宽限期（A2）
// ---------------------------------------------------------------------------

test("S2a: remotePortOpen 单次失败不触发重建，连续达到 TUNNEL_DEATH_THRESHOLD 次才重建", async () => {
  const children = [];
  let clock = 0;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const child = makeFakeChild(7000 + children.length);
      children.push(child);
      return child;
    },
    // "ssh 通但端口关"：code=1, timedOut=false —— 计入死计数的场景
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    spawnGraceMs: 0, // 本用例只关心死计数阈值，跳过宽限期干扰
  });

  // 冷启动：第一次直接 spawn（无历史进程可保护）
  await controller.ensure(cfg);
  assert.equal(children.length, 1, "冷启动应立即 spawn 出第一个隧道");
  const firstChild = children[0];

  // 之后连续探测失败：TUNNEL_DEATH_THRESHOLD - 1 次不应触发重建
  for (let i = 0; i < TUNNEL_DEATH_THRESHOLD - 1; i += 1) {
    clock += 1000;
    await controller.ensure(cfg);
    assert.equal(children.length, 1, `第 ${i + 1} 次连续失败不应重建（阈值 ${TUNNEL_DEATH_THRESHOLD}）`);
    assert.equal(controller.getCurrentChild(), firstChild, "未达阈值时当前 child 不变");
  }

  // 第 TUNNEL_DEATH_THRESHOLD 次失败才触发重建
  clock += 1000;
  await controller.ensure(cfg);
  assert.equal(children.length, 2, "达到死计数阈值应触发一次重建");
  assert.notEqual(controller.getCurrentChild(), firstChild);
});

test("S2b: supervisor 主动 SIGTERM（wasKilled）路径不得清零已经累积的 tunnelRetryCount/退避", async () => {
  let clock = 0;
  const children = [];
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(6000 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg); // 冷启动 spawn child A
  const childA = children[0];

  // 制造一次"快速失败退出"（非 supervisor 主动杀）：code!=0、signal=null、duration<15000
  childA.emit("exit", 1, null);
  const afterFail = controller.getState();
  assert.ok(afterFail.tunnelRetryCount >= 1, "快速失败退出应递增 tunnelRetryCount");
  assert.ok(afterFail.tunnelNextRetryTime > clock, "快速失败退出应设置退避截止时间");

  // 越过退避窗口，让 ensure() 得以继续推进——此时 current 已是 null（上面的 exit 清空），
  // 视为冷启动直接重建，拿到一个新的"当前 child"以便下面模拟 self-kill。
  clock = afterFail.tunnelNextRetryTime + 1;
  await controller.ensure(cfg);
  assert.equal(children.length, 2, "越过退避窗口后应重新 spawn 出新隧道");
  const childB = children[1];
  assert.equal(controller.getCurrentChild(), childB);

  const beforeSelfKill = controller.getState();

  // 模拟 supervisor 主动 SIGTERM 杀掉 child B（例如下一轮重建）——
  // exit 事件里 code=null, signal="SIGTERM" → wasKilled=true。
  childB.emit("exit", null, "SIGTERM");

  const afterSelfKill = controller.getState();
  assert.equal(
    afterSelfKill.tunnelRetryCount,
    beforeSelfKill.tunnelRetryCount,
    "supervisor 主动 SIGTERM 不得清零 tunnelRetryCount",
  );
  assert.equal(
    afterSelfKill.tunnelNextRetryTime,
    beforeSelfKill.tunnelNextRetryTime,
    "supervisor 主动 SIGTERM 不得清零退避截止时间",
  );
});

test("S2c: spawn 后 SPAWN_GRACE_MS 建立宽限期内探测失败不触发杀进程", async () => {
  const children = [];
  let clock = 1_000_000;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const child = makeFakeChild(8000 + children.length);
      children.push(child);
      return child;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });

  await controller.ensure(cfg); // 冷启动 spawn，lastSpawnAt = clock
  assert.equal(children.length, 1);

  // 宽限期内（< SPAWN_GRACE_MS）反复探测失败：即使次数很多也不该杀
  for (let i = 0; i < TUNNEL_DEATH_THRESHOLD + 5; i += 1) {
    clock += 500; // 每次只推进 500ms，累计仍 < SPAWN_GRACE_MS
    await controller.ensure(cfg);
  }
  assert.ok(clock - 1_000_000 < SPAWN_GRACE_MS, "测试前提：累计推进仍在宽限期内");
  assert.equal(children.length, 1, "宽限期内无论探测失败多少次都不应重建");

  // 宽限期结束后再失败，才允许进入死计数并最终触发重建
  clock = 1_000_000 + SPAWN_GRACE_MS + 1000;
  for (let i = 0; i < TUNNEL_DEATH_THRESHOLD; i += 1) {
    clock += 1000;
    await controller.ensure(cfg);
  }
  assert.equal(children.length, 2, "宽限期结束后累计满阈值应触发重建");
});

// ---------------------------------------------------------------------------
// S3: 探测 ssh 参数对齐 + 超时/端口关区分 + ControlMaster 复用（A5/A4）
// ---------------------------------------------------------------------------

test("S3: execFileWithTimeout 超时时 SIGTERM，约 2 秒后补 SIGKILL", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const killed = [];
  child.kill = (sig) => {
    killed.push(sig);
  };
  const pending = execFileWithTimeout("ssh", ["somehost", "nc -z 127.0.0.1 7891"], {
    timeoutMs: 6000,
    spawnImpl: () => child,
  });
  t.mock.timers.tick(6000);
  assert.equal(killed[0], "SIGTERM", "超时应对子进程发送 SIGTERM");
  t.mock.timers.tick(2000);
  assert.equal(killed[1], "SIGKILL", "SIGTERM 后约 2 秒应补 SIGKILL");
  child.emit("close", null);
  const result = await pending;
  assert.equal(result.timedOut, true);
  t.mock.timers.reset();
});

test("S3: execFileWithTimeout 未超时的正常退出 timedOut=false", async () => {
  const child = new EventEmitter();
  child.pid = 43;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const pending = execFileWithTimeout("ssh", ["somehost", "nc -z 127.0.0.1 7891"], {
    timeoutMs: 6000,
    spawnImpl: () => child,
  });
  child.emit("close", 1); // ssh 通但 nc -z 判端口关：exit 1，非超时
  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.code, 1);
});

test("S3: remotePortOpen 区分'探测超时'与'ssh通但端口关'", async () => {
  const timedOutResult = await remotePortOpen(cfg, {
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }),
  });
  assert.equal(timedOutResult.timedOut, true);
  assert.equal(timedOutResult.ok, false);

  const portClosedResult = await remotePortOpen(cfg, {
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
  });
  assert.equal(portClosedResult.timedOut, false);
  assert.equal(portClosedResult.ok, false);

  const okResult = await remotePortOpen(cfg, {
    execFileImpl: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  });
  assert.equal(okResult.ok, true);
});

test("S3: remotePortOpen 探测 SSH 复用探针 ControlMaster（家目录）与 ss/nc/lsof，反向隧道本身不加 mux", async () => {
  let capturedArgs = null;
  await remotePortOpen(cfg, {
    execFileImpl: async (_cmd, args) => {
      capturedArgs = args;
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  const joined = capturedArgs.join(" ");
  assert.ok(joined.includes("BatchMode=yes"), "应与隧道一致设 BatchMode");
  assert.ok(joined.includes("ConnectTimeout=10"), "应与隧道一致设 ConnectTimeout");
  assert.ok(joined.includes("StrictHostKeyChecking=yes"), "生产默认必须是 yes，不得 accept-new");
  assert.equal(joined.includes("accept-new"), false, "探测不得再使用 accept-new");
  assert.ok(joined.includes("ControlMaster=auto"), "探测 SSH 应复用探针 ControlMaster");
  assert.ok(joined.includes("ControlPath=~/.ssh/control-%r@%h:%p"), "ControlPath 必须是家目录，不是 runtimeDir");
  assert.ok(!joined.includes("Application Support"), "探测 mux 不得落到 Application Support");
  assert.ok(joined.includes("ss -lnt"), "远端探活应含 ss");
  assert.ok(joined.includes("nc -z 127.0.0.1"), "远端探活应含 nc -z");
  assert.ok(joined.includes("lsof -i:"), "远端探活应含 lsof");
  const tunnelJoined = buildTunnelArgs(cfg).join(" ");
  assert.ok(tunnelJoined.includes("StrictHostKeyChecking=yes"), "隧道生产默认必须是 yes");
  assert.equal(tunnelJoined.includes("accept-new"), false, "隧道不得再使用 accept-new");
  assert.ok(!tunnelJoined.includes("ControlMaster"), "反向隧道本身绝不能带 ControlMaster");
  assert.ok(!tunnelJoined.includes("ControlPath"), "反向隧道本身绝不能带 ControlPath");
});

test("S3: ensure() 中探测超时——已有受管进程时不计死数不杀；冷启动时仍应正常起步", async () => {
  let clock = 0;
  const children = [];
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(5000 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: true }), // 始终"探测超时"
    waitForPidExitImpl: async () => true,
    now: () => clock,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 1, // 阈值即使极低也不该被"超时"触发——超时根本不计死数
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg);
  assert.equal(children.length, 1, "冷启动没有可保护的现有进程，探测超时不应阻止首次建立隧道");

  for (let i = 0; i < 10; i += 1) {
    clock += 1000;
    await controller.ensure(cfg);
  }
  assert.equal(children.length, 1, "已有受管进程时，持续的探测超时既不计死数也不触发重建");
});

// ---------------------------------------------------------------------------
// S4: remote.ok 补"本地受管隧道进程存在"与门（A6）
// ---------------------------------------------------------------------------

test("S4: remote.ok=true 但本地受管进程未通过 registry 校验时，判隧道死并按阈值重建", async () => {
  let clock = 0;
  const children = [];
  let portOk = false; // 阶段1：端口关，先冷启动出一个 current
  let verifyResult = { verified: false, reason: "无记录" };
  const registryStub = { verifyProcess: async () => verifyResult };
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(3000 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: portOk ? 0 : 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    registry: registryStub,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 2,
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg); // 冷启动：端口关 → 直接 spawn child A
  assert.equal(children.length, 1);
  const childA = children[0];

  // 阶段2：远端端口探测转为"开"，但本地 registry 校验判定不是我们登记的隧道进程
  // （例如端口被 pid 复用的无关进程占用）——不得盲信 remote.ok。
  portOk = true;
  verifyResult = { verified: false, reason: "命令行不匹配" };

  clock += 1000;
  const r1 = await controller.ensure(cfg);
  assert.equal(children.length, 1, "第一次校验失败只计死数，未达阈值不重建");
  assert.equal(controller.getCurrentChild(), childA);
  assert.equal(r1.ok, false);

  clock += 1000;
  const r2 = await controller.ensure(cfg);
  assert.equal(children.length, 2, "达到死计数阈值后即便 remote.ok=true 也应重建（本地进程校验失败）");
  assert.notEqual(controller.getCurrentChild(), childA);
  assert.equal(r2.respawned, true);

  // 对照组：registry 校验通过时，remote.ok=true 应视为健康，不重建、清零死计数。
  verifyResult = { verified: true, reason: "ok" };
  clock += 1000;
  const r3 = await controller.ensure(cfg);
  assert.equal(r3.ok, true);
  assert.equal(children.length, 2, "校验通过时应保持现状，不触发任何重建");
  assert.equal(controller.getState().tunnelDeathCount, 0);
});

// ---------------------------------------------------------------------------
// S5: spawn error 监听 + 进程级兜底（A7）
// ---------------------------------------------------------------------------

test("S5: 隧道 child 的 'error' 事件不得抛出未捕获异常，且视同该进程已死可在下次 tick 重建", async () => {
  const children = [];
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(4000 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 1,
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg);
  const childA = children[0];

  assert.doesNotThrow(
    () => childA.emit("error", Object.assign(new Error("spawn EACCES"), { code: "EACCES" })),
    "spawn 'error' 事件必须有监听者兜底，否则 EventEmitter 会同步抛出打崩 supervisor",
  );
  assert.equal(controller.getCurrentChild(), null, "'error' 事件后应视同该进程已死，清空当前指针");

  await controller.ensure(cfg);
  assert.equal(children.length, 2, "下一次 tick 应能正常重建，未被未捕获异常打断主循环");
});

test("S5: 本地代理 child 的 'error' 事件同样不得抛出未捕获异常", async () => {
  const children = [];
  const controller = createLocalProxyController({
    spawnImpl: () => {
      const c = makeFakeChild(4500 + children.length);
      children.push(c);
      return c;
    },
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });

  await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 0 }) });
  const childA = children[0];

  assert.doesNotThrow(() => childA.emit("error", Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })));
  assert.equal(controller.getCurrentChild(), null);
});

test("S5: createCrashGuard 在致命错误前先同步 kill 已登记子进程，再决定退出", () => {
  const killedSignals = [];
  const fakeChildAlive = { pid: 111, killed: false, kill: (sig) => killedSignals.push(["alive", sig]) };
  const fakeChildDead = { pid: 222, killed: true, kill: (sig) => killedSignals.push(["dead", sig]) };
  const logs = [];
  let exitCode = null;
  const guard = createCrashGuard({
    getChildren: () => [fakeChildAlive, fakeChildDead, null],
    log: (msg) => logs.push(msg),
    exitImpl: (code) => {
      exitCode = code;
    },
  });

  guard("uncaughtException", new Error("boom"));

  assert.deepEqual(killedSignals, [["alive", "SIGTERM"]], "只 kill 仍存活的已登记子进程；已死的/空的安全跳过");
  assert.equal(exitCode, 1, "兜底最终应以非零码退出，避免带病继续运行");
  assert.ok(logs.some((m) => m.includes("uncaughtException") && m.includes("boom")), "应记录致命错误信息");
});

test("S5: createCrashGuard 即使 getChildren 本身抛异常也不得二次崩溃", () => {
  let exitCode = null;
  const guard = createCrashGuard({
    getChildren: () => {
      throw new Error("getChildren boom");
    },
    log: () => {},
    exitImpl: (code) => {
      exitCode = code;
    },
  });
  assert.doesNotThrow(() => guard("uncaughtException", new Error("x")));
  assert.equal(exitCode, 1);
});

// 未处理的 rejection 与未捕获异常必须区别对待：前者只说明"某个没人接的 promise 失败了"，
// 不足以证明进程不可继续；而旧行为会在此时 SIGTERM 掉全部子进程再 exit(1)，把 SSH 隧道
// 与本地代理一起拆掉（整段中断），与 performHandoffExit/startAdoption 的交接设计相反。
test("S5: createCrashGuard 对单次 unhandledRejection 只记日志，不杀子进程也不退出", () => {
  const killed = [];
  let exitCode = null;
  const logs = [];
  const guard = createCrashGuard({
    getChildren: () => [{ pid: 333, killed: false, kill: (sig) => killed.push(sig) }],
    log: (msg) => logs.push(msg),
    exitImpl: (code) => {
      exitCode = code;
    },
  });

  guard("unhandledRejection", new Error("stray rejection"));

  assert.deepEqual(killed, [], "不得因单次 rejection 杀掉隧道/代理子进程");
  assert.equal(exitCode, null, "不得因单次 rejection 退出进程");
  assert.ok(logs.some((m) => m.includes("stray rejection")), "仍必须留下完整错误信息");
  assert.ok(logs.some((m) => m.includes("未处理的 rejection") || m.includes("已记录并忽略")), "应说明为何忽略");
});

test("S5: createCrashGuard 对 rejection 风暴仍按致命处理（系统性损坏的兜底）", () => {
  const killed = [];
  let exitCode = null;
  const clock = 1000;
  const guard = createCrashGuard({
    getChildren: () => [{ pid: 444, killed: false, kill: (sig) => killed.push(sig) }],
    log: () => {},
    exitImpl: (code) => {
      exitCode = code;
    },
    now: () => clock,
    rejectionStormWindowMs: 1000,
    rejectionStormThreshold: 3,
  });

  guard("unhandledRejection", new Error("1"));
  guard("unhandledRejection", new Error("2"));
  assert.deepEqual(killed, [], "阈值内的 rejection 一律不动子进程");
  assert.equal(exitCode, null);

  guard("unhandledRejection", new Error("3"));
  assert.deepEqual(killed, ["SIGTERM"], "达到阈值即按致命处理，先杀子进程");
  assert.equal(exitCode, 1);
});

test("S5: createCrashGuard 的 rejection 计数按窗口滑动清零，不会跨窗口累积", () => {
  const killed = [];
  let exitCode = null;
  let clock = 0;
  const guard = createCrashGuard({
    getChildren: () => [{ pid: 555, killed: false, kill: (sig) => killed.push(sig) }],
    log: () => {},
    exitImpl: (code) => {
      exitCode = code;
    },
    now: () => clock,
    rejectionStormWindowMs: 1000,
    rejectionStormThreshold: 2,
  });

  guard("unhandledRejection", new Error("a"));
  clock = 5000; // 新窗口，计数清零
  guard("unhandledRejection", new Error("b"));
  assert.deepEqual(killed, [], "跨窗口的两次 rejection 不应累加成风暴");
  assert.equal(exitCode, null);
});

// ---------------------------------------------------------------------------
// 交接退出：必须等在飞的"单隧道受控重启"收尾
// 信箱里的 restartControlled 是"停旧 ssh → 起新 ssh"的复合动作，它不在 tick 的
// promise 里。只等 waitForTick 就 exit(0) 会把它截断在中间：旧进程已停、新进程没起、
// 注册表记录还在，下一任 supervisor 会看到一条"存在但已死"的记录。
// ---------------------------------------------------------------------------
test("performHandoffExit 在 exit(0) 之前等待信箱在飞动作收尾", async () => {
  const order = [];
  let releaseMailbox;
  const mailboxGate = new Promise((resolve) => {
    releaseMailbox = resolve;
  });

  const running = performHandoffExit({
    trigger: "mailbox",
    setStopping: () => order.push("stopping"),
    waitForTick: async () => order.push("tick-done"),
    waitForMailboxIdle: async () => {
      order.push("mailbox-wait-start");
      await mailboxGate;
      order.push("mailbox-idle");
    },
    releaseResources: async () => order.push("release"),
    removeOwnRecord: async () => order.push("remove-record"),
    flushLogs: async () => order.push("flush"),
    exit: (code) => order.push(`exit:${code}`),
    log: () => {},
    sleep: () => new Promise(() => {}), // 不触发超时分支，锁定"真的等待"
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(order.includes("tick-done"));
  assert.ok(order.includes("mailbox-wait-start"), "必须开始等待信箱");
  assert.ok(!order.includes("exit:0"), "信箱动作未收尾前不得退出");

  releaseMailbox();
  await running;
  assert.deepEqual(order.slice(-5), ["mailbox-idle", "release", "remove-record", "flush", "exit:0"]);
  assert.ok(order.includes("flush"), "退出前仍要刷日志");
});

test("performHandoffExit 的信箱等待与 tick 等待共用同一预算（有界，不会挂死）", async () => {
  const order = [];
  await performHandoffExit({
    trigger: "mailbox",
    waitForTick: () => new Promise(() => {}), // 永不结算
    waitForMailboxIdle: () => new Promise(() => {}),
    releaseResources: async () => order.push("release"),
    removeOwnRecord: async () => order.push("remove"),
    flushLogs: async () => order.push("flush"),
    exit: (code) => order.push(`exit:${code}`),
    log: () => {},
    tickBudgetMs: 20,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(order.slice(0, 1), ["release"], "超时后仍继续走完释放流程");
  assert.ok(order.includes("exit:0"), "预算耗尽必须继续退出，绝不能无限等待");
});

test("performHandoffExit 的任一等待步骤抛错都不得阻断退出", async () => {
  const order = [];
  await performHandoffExit({
    trigger: "SIGUSR2",
    waitForTick: async () => {
      throw new Error("tick boom");
    },
    waitForMailboxIdle: async () => {
      throw new Error("mailbox boom");
    },
    releaseResources: async () => {
      throw new Error("release boom");
    },
    removeOwnRecord: async () => {
      throw new Error("remove boom");
    },
    flushLogs: async () => {
      throw new Error("flush boom");
    },
    exit: (code) => order.push(`exit:${code}`),
    log: () => {},
    tickBudgetMs: 20,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  assert.deepEqual(order, ["exit:0"], "交接途中的任何失败都不能让 supervisor 卡住不退出");
});

// ---------------------------------------------------------------------------
// S6: 睡眠/唤醒自愈（新增）
// ---------------------------------------------------------------------------

test("S6: 相邻两次 ensure 间隔超过 WAKE_GAP_MS 判定睡眠唤醒，强制立即复检并重置退避", async () => {
  let clock = 0;
  const children = [];
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => {
      const c = makeFakeChild(2000 + children.length);
      children.push(c);
      return c;
    },
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    waitForPidExitImpl: async () => true,
    now: () => clock,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 1,
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg); // 建立基线：冷启动 spawn child A（同时把 lastEnsureAt 设为 clock=0）
  const childA = children[0];
  childA.emit("exit", 1, null); // 快速失败退出，建立退避
  const afterFail = controller.getState();
  assert.ok(afterFail.tunnelNextRetryTime > clock, "应建立退避窗口");

  // 相邻 tick 间隔正常（< WAKE_GAP_MS）：退避期内应仍被跳过，不是唤醒
  clock += 1000;
  const normalTickResult = await controller.ensure(cfg);
  assert.equal(normalTickResult.skipped, true, "退避期内的正常间隔 tick 应仍被跳过");
  assert.equal(
    controller.getState().tunnelNextRetryTime,
    afterFail.tunnelNextRetryTime,
    "正常间隔不应触碰退避状态",
  );

  // 模拟 Mac 睡眠后唤醒：下一次 ensure 距离上一次间隔超过 WAKE_GAP_MS
  clock += WAKE_GAP_MS + 1000;
  const wakeResult = await controller.ensure(cfg);
  assert.equal(controller.getState().tunnelNextRetryTime, 0, "唤醒应立即重置退避截止时间");
  assert.equal(controller.getState().tunnelDeathCount, 0, "唤醒应一并重置死计数（旧数据在长时间睡眠后已不可信）");
  assert.notEqual(wakeResult.skipped, true, "唤醒后本 tick 不应因退避被跳过，须立即强制复检，不等常规间隔");
});

test("S6: 首次调用 ensure 不应被误判为唤醒（没有历史基线可比较）", async () => {
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => makeFakeChild(1),
    execFileImpl: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    now: () => 10_000_000, // 首次调用时钟值本身很大，不应被误当成"跳变"
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });
  const result = await controller.ensure(cfg);
  assert.equal(result.ok, true, "首次调用应正常走通探测成功路径，不应被判定为唤醒事件");
});

test("attachPersonalSsh 把个人层密钥与用户名接到活跃服务器配置", () => {
  const attached = attachPersonalSsh(
    { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 },
    { sshIdentityFile: " ~/.ssh/id_ed25519_codextunnel ", sshUser: "alice" },
  );
  assert.equal(attached.sshIdentityFile, "~/.ssh/id_ed25519_codextunnel");
  assert.equal(attached.sshUser, "alice");
  assert.equal(attachPersonalSsh({ host: "myserver" }, { sshUser: "bad user" }).sshUser, undefined);
});

test("buildTunnelArgs 仅在配置了个人密钥时加 -i 与 IdentitiesOnly", () => {
  const base = buildTunnelArgs(cfg);
  assert.equal(base.includes("-i"), false);
  const withIdentity = buildTunnelArgs({ ...cfg, sshIdentityFile: "/tmp/id", sshUser: "bob" });
  assert.equal(withIdentity.includes("-i"), true);
  assert.equal(withIdentity.includes("IdentitiesOnly=yes"), true);
  assert.equal(withIdentity.includes("-l"), true);
  assert.equal(withIdentity.includes("bob"), true);
  assert.ok(withIdentity.includes("-R"));
  assert.equal(withIdentity.includes("ControlMaster"), false, "反向隧道不加 ControlMaster");
});

test("buildTunnelArgs / remotePortOpen: sshPort 生成 -p，与探针一致", () => {
  const args = buildTunnelArgs({ ...cfg, sshPort: 2222 });
  const portAt = args.indexOf("-p");
  assert.ok(portAt >= 0);
  assert.equal(args[portAt + 1], "2222");
});

test("本地 tunnel 已 verify 时 ensure() 不再发探测 SSH", async () => {
  let sshCalls = 0;
  const controller = createTunnelController({
    name: tunnelRecordName(cfg.id),
    spawnImpl: () => makeFakeChild(9001),
    execFileImpl: async () => {
      sshCalls += 1;
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    },
    registry: { verifyProcess: async () => ({ verified: true, reason: "ok" }) },
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
  });
  const result = await controller.ensure(cfg);
  assert.equal(result.ok, true);
  assert.equal(result.skippedRemoteProbe, true);
  assert.equal(sshCalls, 0, "已校验的本地隧道不应再开探测 SSH");
});

test("classifySshFailure 把认证/端口冲突映射成可行动原因", () => {
  assert.equal(classifySshFailure("Permission denied (publickey).").code, "auth");
  assert.equal(classifySshFailure("bind: Address already in use").code, "remote-port");
  assert.equal(classifySshFailure("Connection refused").code, "refused");
  // 2026-10-10 主集群 3.3 小时连不上、重试 96 次，每次都是握手阶段被断开，此前归因不出来、界面没有任何提示。
  assert.equal(classifyTunnelSshFailure("Connection closed by 203.0.113.10 port 22").code, "refused");
  assert.equal(classifyTunnelSshFailure("kex_exchange_identification: read: Connection reset by peer").code, "refused");
  assert.equal(classifyTunnelSshFailure("Connection to 203.0.113.10 closed by remote host."), null, "已建立的会话被断开不是连接被拒");
  assert.equal(classifyTunnelSshFailure("Permission denied (publickey).").code, "auth", "原有归因照旧优先");
  assert.equal(classifySshFailure("hello from motd"), null);
  assert.equal(inferSupervisorLogLevel("ssh tunnel exited code=255 signal=-"), "error");
  assert.equal(inferSupervisorLogLevel("ssh tunnel failed quickly, next retry in 10s"), "warn");
  assert.equal(inferSupervisorLogLevel("supervisor started"), "info");
});

test("classifyProxyLogLine: connect 成功不写 ndjson，deny/fail/FATAL 全量且带 nextAction", () => {
  const ok = classifyProxyLogLine("connect host=api.openai.com port=443 dnsMs=1 tcpMs=2 cached=0");
  assert.equal(ok.persist, false);
  const deny = classifyProxyLogLine("connect-deny host=evil.example port=443");
  assert.equal(deny.persist, true);
  assert.equal(deny.level, "warn");
  assert.ok(deny.nextAction);
  const fail = classifyProxyLogLine("connect-fail host=api.openai.com port=443 reason=timeout ms=10");
  assert.equal(fail.persist, true);
  assert.equal(fail.level, "error");
  const fatal = classifyProxyLogLine("[FATAL ERROR] local proxy port 8888 is already in use!");
  assert.equal(fatal.persist, true);
  assert.equal(fatal.level, "error");
});

test("本地代理单次探活超时不杀已有进程，连续失败才重建", async () => {
  const children = [];
  const controller = createLocalProxyController({
    spawnImpl: () => {
      const c = makeFakeChild(8000 + children.length);
      children.push(c);
      return c;
    },
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 3,
    spawnGraceMs: 0,
  });

  await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 0 }) });
  assert.equal(children.length, 1, "冷启动应立即拉起代理");
  assert.equal(PROXY_DEATH_THRESHOLD, 3);
  const childA = children[0];

  const timedOut = await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, timedOut: true, durationMs: 30 }) });
  assert.equal(timedOut.timedOut, true);
  assert.equal(controller.getCurrentChild(), childA, "超时不得杀掉健康代理");
  assert.equal(children.length, 1);

  await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 1 }) });
  await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 1 }) });
  const third = await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 1 }) });
  assert.equal(third.respawned, true);
  assert.equal(children.length, 2);
  assert.equal(childA.killed, true);
});

test("本地代理 EADDRINUSE 后进入退避，不立即再 spawn", async () => {
  let clock = 1000;
  const children = [];
  const controller = createLocalProxyController({
    spawnImpl: () => {
      const c = makeFakeChild(9100 + children.length);
      children.push(c);
      return c;
    },
    now: () => clock,
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: () => {},
    log: () => {},
    deathThreshold: 1,
    spawnGraceMs: 0,
    computeBackoffSec: () => 30,
  });

  await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 0 }) });
  children[0].emit("exit", 2, null);
  clock += 1;
  const skipped = await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 0 }) });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "backoff");
  assert.equal(children.length, 1, "端口占用期间不得雪崩重启");

  clock += 30_000;
  const after = await controller.ensure(cfg, { checkHealth: async () => ({ ok: false, durationMs: 0 }) });
  assert.equal(after.respawned, true);
  assert.equal(children.length, 2);
});


// ---------------------------------------------------------------------------
// 配置注入面收口：supervisor 配置加载必须经 normalizeAgentConfig（与 monitor-server
// 同一条归一化路径），恶意 portOverrides/host 回落默认；buildTunnelArgs/remotePortOpen
// 内部另有 ssh-args 硬校验兜底（绕过归一化直接调用时 throw）。
// ---------------------------------------------------------------------------

test("resolveSupervisorConfig: 恶意 host/localPort 回落默认，恶意 remotePort 剔除且不建隧道（绝不回落 7891）", () => {
  const logs = [];
  const resolved = resolveSupervisorConfig({
    activeServerId: "server-01",
    sshUser: "alice",
    sshIdentityFile: "/tmp/id",
    servers: [{
      id: "server-01",
      name: "主集群服务器",
      host: "-oProxyCommand=evil",
      remotePort: "1234; rm -rf /", // loadLayeredConfig 已把 portOverrides 合并进 server 条目
      localPort: "$(id)",
    }],
  }, { log: (message, fields) => logs.push({ message, fields }) });
  assert.equal(resolved.host, "myserver", "恶意 host 应回落默认");
  assert.equal(Object.hasOwn(resolved, "remotePort"), false, "恶意 remotePort 剔除，不回落 7891");
  assert.equal(resolved.localPort, 8888, "恶意 localPort 应回落默认");
  assert.deepEqual(resolved.tunnels, [], "没有合法端口就不建任何隧道");
  assert.ok(logs.some((l) => l.fields?.event === "tunnel-target-invalid" && /remotePort/.test(l.message)), "非法端口要告警");
  // 换成合法端口后归一化配置可安全生成隧道参数（硬校验不 throw）。
  assert.ok(buildTunnelArgs({ ...resolved, remotePort: 7892 }).includes("myserver"));
});

test("resolveSupervisorConfig: 正常配置字段无一丢失（id/host/端口/个人 ssh 字段/server 附加字段）", () => {
  const resolved = resolveSupervisorConfig({
    activeServerId: "server-tengxun",
    sshUser: "cluster-alice",
    sshIdentityFile: " /tmp/id_ed25519 ",
    servers: [
      { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 },
      { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", remotePort: 7893, localPort: 8890, validationProfile: { remoteProxyTest: "x" } },
    ],
  });
  assert.equal(resolved.id, "server-tengxun");
  assert.equal(resolved.name, "腾讯云");
  assert.equal(resolved.host, "tengxunserver");
  assert.equal(resolved.remotePort, 7893);
  assert.equal(resolved.localPort, 8890);
  assert.equal(resolved.sshUser, "cluster-alice");
  assert.equal(resolved.sshIdentityFile, "/tmp/id_ed25519");
  assert.deepEqual(resolved.validationProfile, { remoteProxyTest: "x" }, "server 附加字段（如 validationProfile）不得被归一化丢弃");
});

test("resolveSupervisorConfig: 字符串端口归一为数字，供 -R 转发串/远端命令安全插值", () => {
  const resolved = resolveSupervisorConfig({
    servers: [{ id: "server-01", host: "myserver", remotePort: "7891", localPort: "8888" }],
  });
  assert.equal(resolved.remotePort, 7891);
  assert.equal(resolved.localPort, 8888);
});

test("resolveSupervisorConfig: 共享代理端口与控制面端口相同则暂停全部隧道，避免代理/HTTP 串线", () => {
  const logs = [];
  const resolved = resolveSupervisorConfig({
    activeServerId: "server-01",
    servers: [{ id: "server-01", host: "myserver", remotePort: 7901, localPort: 8877 }],
  }, { log: (message, fields) => logs.push({ message, fields }) });
  assert.equal(resolved.proxyPort, 8877);
  assert.equal(resolved.proxyPortConflict, true);
  assert.deepEqual(resolved.tunnels, []);
  assert.ok(logs.some((entry) => entry.fields?.event === "tunnel-target-invalid" && /控制面 HTTP 端口/.test(entry.message)));
});

test("buildTunnelArgs: 绕过归一化直接传恶意 host/port 时硬校验 throw（纵深防御）", () => {
  assert.throws(() => buildTunnelArgs({ ...cfg, host: "-oProxyCommand=evil" }), /unsafe host/);
  assert.throws(() => buildTunnelArgs({ ...cfg, remotePort: "1234; rm -rf /" }), /unsafe remotePort/);
  assert.throws(() => buildTunnelArgs({ ...cfg, localPort: "$(id)" }), /unsafe localPort/);
});

test("remotePortOpen: 恶意 host/remotePort 不会进入 ssh 参数（硬校验先 throw）", async () => {
  let called = false;
  const execFileImpl = async () => {
    called = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(() => remotePortOpen({ ...cfg, host: "-oProxyCommand=evil" }, { execFileImpl }), /unsafe host/);
  await assert.rejects(() => remotePortOpen({ ...cfg, remotePort: "$(id)" }, { execFileImpl }), /unsafe remotePort/);
  assert.equal(called, false, "硬校验必须发生在发起 ssh 之前");
});

// ---------------------------------------------------------------------------
// v2.18 多隧道：每台服务器各自常驻一条 -R，活跃服务器只决定"看哪台"。
// 2026-08-02 实锤的唯一真实断网缺陷（切到腾讯云 → myserver 的 7891 消失）在这里被修掉。
// ---------------------------------------------------------------------------

const multiServerConfig = {
  activeServerId: "server-01",
  sshUser: "kai",
  servers: [
    { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888, source: "team", disabled: false, tunnel: true },
    { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8890, source: "personal", disabled: false, tunnel: true },
    { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7894, localPort: 8891, source: "personal", disabled: false, tunnel: false },
    { id: "server-gone", host: "otherserver", remotePort: 7895, localPort: 8892, source: "personal", disabled: true, tunnel: true },
  ],
};

test("多隧道: resolveSupervisorConfig 产出 proxyPort/activeServerId/tunnels，tunnel:false 与 disabled 都不建隧道", () => {
  const resolved = resolveSupervisorConfig(multiServerConfig);
  assert.equal(resolved.proxyPort, 8888, "代理端口 = 活跃服务器 localPort（kai 现网仍是 8888）");
  assert.equal(resolved.activeServerId, "server-01");
  assert.deepEqual(resolved.tunnels.map((t) => t.id), ["server-01", "server-tengxun"]);
  // 所有 -R 都指向同一个本地代理；各服务器自己的 localPort 只作展示。
  assert.deepEqual(resolved.tunnels.map((t) => t.localPort), [8888, 8888]);
  assert.deepEqual(resolved.tunnels.map((t) => t.source), ["team", "personal"]);
  assert.equal(resolved.tunnels[1].sshUser, "kai");
  // 每条 TunnelConfig 都是旧的单隧道 config 形状：三个既有函数签名一个不用改。
  assert.ok(buildTunnelArgs(resolved.tunnels[1]).includes("tengxunserver"));
  assert.equal(buildTunnelSignature(resolved.tunnels[1]), "-R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver");
});

test("多隧道: resolveSupervisorConfig 仍把活跃服务器条目展开在顶层（旧的单隧道调用方零回归）", () => {
  const resolved = resolveSupervisorConfig({ ...multiServerConfig, activeServerId: "server-tengxun" });
  assert.equal(resolved.id, "server-tengxun");
  assert.equal(resolved.host, "tengxunserver");
  assert.equal(resolved.remotePort, 7893);
  assert.equal(resolved.localPort, 8890);
  assert.equal(resolved.proxyPort, 8890, "活跃换成腾讯云 → 代理端口取它的 localPort");
  // 切了活跃服务器，隧道清单一条不少（这正是 2026-08-02 断网缺陷的修复点）。
  assert.deepEqual(resolved.tunnels.map((t) => t.id), ["server-01", "server-tengxun"]);
});

test("多隧道: 活跃服务器变化不影响隧道集合本身（tunnels 与 activeServerId 无关）", () => {
  const a = resolveSupervisorConfig({ ...multiServerConfig, activeServerId: "server-01" });
  const b = resolveSupervisorConfig({ ...multiServerConfig, activeServerId: "server-tengxun" });
  assert.deepEqual(a.tunnels.map((t) => t.id), b.tunnels.map((t) => t.id));
});

test("多隧道: 同一远端 host + remotePort 即使 localPort 不同也只保留一条，避免探针把别人的隧道认成自己的", () => {
  const logs = [];
  const resolved = resolveSupervisorConfig({
    activeServerId: "a",
    servers: [
      { id: "a", host: "same-host", remotePort: 7901, localPort: 8901, tunnel: true },
      { id: "b", host: "same-host", remotePort: 7901, localPort: 8902, tunnel: true },
      { id: "c", host: "same-host", remotePort: 7902, localPort: 8903, tunnel: true },
    ],
  }, { log: (message, fields) => logs.push({ message, fields }) });
  assert.deepEqual(resolved.tunnels.map((t) => t.id), ["a", "c"]);
  assert.equal(logs.filter((entry) => entry.fields?.event === "tunnel-remote-port-duplicate").length, 1);
});

test("多隧道: tunnelRecordName 命名契约", () => {
  assert.equal(tunnelRecordName("server-01"), "tunnel.server-01");
});

test("diffTunnelTargets: 新增 / 移除 / 签名变化三种情况", () => {
  const a = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
  const b = { id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8888 };
  const prev = new Map([["server-01", { config: a }]]);

  const grow = diffTunnelTargets(prev, [a, b]);
  assert.deepEqual(grow.added.map((t) => t.id), ["server-tengxun"]);
  assert.deepEqual(grow.removed, []);
  assert.deepEqual(grow.kept.map((t) => t.id), ["server-01"]);

  const shrink = diffTunnelTargets(new Map([["server-01", { config: a }], ["server-tengxun", { config: b }]]), [a]);
  assert.deepEqual(shrink.removed, ["server-tengxun"]);
  assert.deepEqual(shrink.added, []);

  // 签名变化（换了 remotePort）= 先停再建：现有 ssh 进程建的是另一条转发。
  const rekeyed = { ...a, remotePort: 7899 };
  const changed = diffTunnelTargets(prev, [rekeyed]);
  assert.deepEqual(changed.removed, ["server-01"]);
  assert.deepEqual(changed.added.map((t) => t.remotePort), [7899]);
  assert.deepEqual(changed.kept, []);
});

function fakeTunnelControllerFactory(events) {
  return (serverId) => ({
    name: tunnelRecordName(serverId),
    ensure: async (config) => {
      events.push({ type: "ensure", serverId, remotePort: config.remotePort });
      return { ok: true };
    },
    stopCurrent: async () => events.push({ type: "stop", serverId }),
    getCurrentChild: () => null,
    getState: () => ({}),
    resetBackoff: () => {},
  });
}

test("reconcileTunnels: 活跃服务器从 A 切到 B 时，A 的 controller 绝不被 stopCurrent", async () => {
  const events = [];
  const controllers = new Map();
  const targets = resolveSupervisorConfig(multiServerConfig).tunnels;

  await reconcileTunnels({ controllers, targets, createController: fakeTunnelControllerFactory(events) });
  assert.deepEqual([...controllers.keys()], ["server-01", "server-tengxun"]);

  // 第二拍：用户把活跃服务器切到腾讯云。隧道集合本身不变 → 只 ensure，不 stop。
  const afterSwitch = resolveSupervisorConfig({ ...multiServerConfig, activeServerId: "server-tengxun" }).tunnels;
  // 代理端口在主循环里被钉死为首拍的 8888，这里同样把 localPort 归一到 8888。
  const pinned = afterSwitch.map((t) => ({ ...t, localPort: 8888 }));
  await reconcileTunnels({ controllers, targets: pinned, createController: fakeTunnelControllerFactory(events) });

  assert.equal(events.filter((e) => e.type === "stop").length, 0, "切换活跃服务器不得停任何隧道");
  assert.deepEqual([...controllers.keys()], ["server-01", "server-tengxun"], "两条隧道都还在 Map 里");
  assert.equal(events.filter((e) => e.type === "ensure" && e.serverId === "server-01").length, 2, "myserver 的 7891 每拍照常保活");
});

test("reconcileTunnels: 配置里删掉某台服务器时它被 stopCurrent 并从 Map 移除（含 pid/注册表清理）", async () => {
  const events = [];
  const removedCleanups = [];
  const controllers = new Map();
  const targets = resolveSupervisorConfig(multiServerConfig).tunnels;
  await reconcileTunnels({ controllers, targets, createController: fakeTunnelControllerFactory(events) });

  await reconcileTunnels({
    controllers,
    targets: targets.filter((t) => t.id === "server-01"),
    createController: fakeTunnelControllerFactory(events),
    onRemoved: async (serverId) => removedCleanups.push(serverId),
  });

  assert.deepEqual(events.filter((e) => e.type === "stop"), [{ type: "stop", serverId: "server-tengxun" }]);
  assert.deepEqual([...controllers.keys()], ["server-01"]);
  assert.deepEqual(removedCleanups, ["server-tengxun"]);
});

test("reconcileTunnels: 单台 ensure 抛异常不影响其余隧道的这一拍", async () => {
  const events = [];
  const controllers = new Map();
  const targets = resolveSupervisorConfig(multiServerConfig).tunnels;
  const factory = (serverId) => ({
    ensure: async (config) => {
      if (serverId === "server-01") throw new Error("boom");
      events.push({ type: "ensure", serverId, remotePort: config.remotePort });
    },
    stopCurrent: async () => {},
    getCurrentChild: () => null,
  });
  await reconcileTunnels({ controllers, targets, createController: factory });
  assert.deepEqual(events.map((e) => e.serverId), ["server-tengxun"]);
  assert.equal(controllers.size, 2, "抛异常的那台仍留在 Map 里，下一拍继续重试");
});

test("buildShutdownPlan: 遍历全部 controller 的子进程，并列出每台的注册表名", () => {
  const childA = makeFakeChild(7001);
  const childB = makeFakeChild(7002);
  const proxyChild = makeFakeChild(7003);
  const controllers = new Map([
    ["server-01", { controller: { getCurrentChild: () => childA } }],
    ["server-tengxun", { controller: { getCurrentChild: () => childB } }],
  ]);
  const plan = buildShutdownPlan({ getCurrentChild: () => proxyChild }, controllers);
  assert.deepEqual(plan.children.map((c) => c.pid), [7003, 7001, 7002]);
  assert.deepEqual(plan.recordNames, [
    "channel-supervisor", "local-proxy", "tunnel.server-01", "tunnel.server-tengxun",
  ]);
  // 已经被 kill 掉的 child 不重复下手。
  childA.kill();
  assert.deepEqual(buildShutdownPlan({ getCurrentChild: () => proxyChild }, controllers).children.map((c) => c.pid), [7003, 7002]);
});

test("createTunnelController(name): 注册表名按服务器隔离，两条隧道互不覆盖", async () => {
  const recorded = new Map();
  const verified = [];
  const controller = createTunnelController({
    name: tunnelRecordName("server-tengxun"),
    spawnImpl: () => makeFakeChild(4321),
    execFileImpl: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false }),
    registry: {
      verifyProcess: async (name) => {
        verified.push(name);
        return { verified: false, reason: "缺少 pid 元数据" };
      },
    },
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: (name, pid) => recorded.set(name, pid),
    log: () => {},
    deathThreshold: 1,
    spawnGraceMs: 0,
  });

  await controller.ensure({ id: "server-tengxun", host: "tengxunserver", remotePort: 7893, localPort: 8888 });
  assert.equal(recorded.get("tunnel.server-tengxun"), 4321);
  assert.deepEqual([...recorded.keys()], ["tunnel.server-tengxun"], "只按传入的服务器记录名登记");
  assert.ok(verified.every((name) => name === "tunnel.server-tengxun"), "校验也必须按服务器名查");
  assert.equal(controller.getState().name, "tunnel.server-tengxun");
});

test("多隧道: 两条服务器归一化后落到同一条 -R 时只保留第一条（避免 remote port forwarding failed 退避风暴）", () => {
  const resolved = resolveSupervisorConfig({
    activeServerId: "server-01",
    servers: [
      { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 },
      // host 写坏 → normalizeAgentConfig 回落成 myserver，端口又恰好相同 → 与上一条撞签名。
      { id: "server-broken", host: "-oProxyCommand=evil", remotePort: 7891, localPort: 8890 },
      // 端口写坏 → 剔除端口、不建隧道（不再回落 7891 去撞别人）。
      { id: "server-bad-port", host: "myserver", remotePort: "nope", localPort: 8891 },
    ],
  });
  assert.deepEqual(resolved.tunnels.map((t) => t.id), ["server-01"]);
});

// ---------------------------------------------------------------------------
// 孤儿隧道接管（L2）：远端端口被本项目自己的旧 ssh 占着时认领它，而不是反复重建
// ---------------------------------------------------------------------------

const orphanSignature = "-R 127.0.0.1:7891:127.0.0.1:8888 myserver";
const orphanCommand = `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -N ${orphanSignature}`;
const FORWARD_FAILED_LINE = "Warning: remote port forwarding failed for listen port 7891";
const ORPHAN_ROOT_DIR = "/repo/codex-tunnel";

function makeOrphanScenario({
  autoRepair,
  sshProcesses = [{ pid: 5150, command: orphanCommand }],
  remoteListening = false,
  rateLimiter,
  tunnelOwnerId = null,
  // 孤儿认领只在 POSIX 成立（win32 没有 ps，一律退回重试）。默认按 linux 跑，
  // 让这组用例在任何 CI 宿主上断言同一套行为；win32 侧由下方专门的用例覆盖。
  platform = "linux",
} = {}) {
  const children = [];
  const recorded = [];
  const logs = [];
  const stages = [];
  const scanned = [];
  const kills = [];
  let probeCalls = 0;
  let clock = 1_000_000;

  const controller = createTunnelController({
    name: tunnelRecordName("server-01"),
    spawnImpl: () => {
      const child = makeFakeChild(9000 + children.length);
      children.push(child);
      return child;
    },
    // 第一次是冷启动的远端端口探测（必须失败才会走到 spawn）；之后每一次都是
    // 孤儿判定或下一拍 ensure 的复核，由 remoteListening 决定。
    execFileImpl: async () => {
      probeCalls += 1;
      const failed = probeCalls === 1 || !remoteListening;
      return { code: failed ? 1 : 0, stdout: "", stderr: "", timedOut: false };
    },
    listSshProcesses: async () => {
      scanned.push(true);
      // 允许按调用次序给不同清单：认领后再扫一次时模拟 pid 被复用 / 进程已退出。
      return typeof sshProcesses === "function" ? sshProcesses(scanned.length) : sshProcesses;
    },
    killProcess: (pid, signal) => kills.push({ pid, signal }),
    getAutoRepair: () => autoRepair,
    ...(rateLimiter ? { rateLimiter } : {}),
    now: () => clock,
    waitForPidExitImpl: async () => true,
    removeRuntimeRecord: async () => {},
    recordRuntimeProcess: (name, pid, meta) => recorded.push({ name, pid, meta }),
    emitStage: (partial) => stages.push(partial),
    log: (message, fields) => logs.push({ message, fields: fields || {} }),
    rootDir: ORPHAN_ROOT_DIR,
    selfPid: 4242,
    deathThreshold: 1,
    spawnGraceMs: 0,
    platform,
    tunnelOwnerId,
    // 带识别码时端口被异己占用会先试残留会话回收；这里固定"远端没有本机标记的会话"。
    runRemoteCommandImpl: async () => ({ code: 0, stdout: "found=0 reclaimed=0\n", stderr: "", timedOut: false }),
  });

  // 一次完整的"建隧道 → ssh 报端口被占 → 退出"，再等孤儿判定跑完。
  async function failForwardOnce() {
    await controller.ensure(cfg);
    const child = children[children.length - 1];
    child.stderr.emit("data", FORWARD_FAILED_LINE);
    child.emit("exit", 255, null);
    await controller.whenOrphanSettled();
    return child;
  }

  return {
    controller,
    children,
    recorded,
    logs,
    stages,
    scanned,
    kills,
    failForwardOnce,
    tick: (ms) => {
      clock += ms;
    },
    now: () => clock,
    // spawnTunnel 本来就会为自己 spawn 的 child 写一条注册表记录；
    // 认领产生的是"不属于任何 child 的 pid"那一条，按 pid 归属区分，
    // 不靠 meta.adopted 标记（那样就成了拿实现自证实现）。
    adoptions: () => recorded.filter((entry) => !children.some((child) => child.pid === entry.pid)),
    hasEvent: (event) => logs.some((entry) => entry.fields.event === event),
    eventFields: (event) => logs.find((entry) => entry.fields.event === event)?.fields ?? null,
  };
}

test("孤儿接管: 本机旧 ssh 占着远端端口时认领它——写注册表、清退避、stage 报 adopted", async () => {
  const scene = makeOrphanScenario();
  await scene.failForwardOnce();

  assert.deepEqual(
    scene.adoptions().map(({ name, pid }) => ({ name, pid })),
    [{ name: "tunnel.server-01", pid: 5150 }],
    "认领 = 把那条孤儿 pid 登记成本服务器的隧道记录",
  );
  const meta = scene.adoptions()[0].meta;
  assert.equal(meta.signature, orphanSignature, "meta 必须带签名，否则 verifyProcess 会退回宽松匹配");
  assert.equal(meta.command, orphanCommand);
  assert.equal(meta.cwd, ORPHAN_ROOT_DIR);
  assert.equal(meta.adopted, true);
  assert.equal(meta.configIdentity, undefined, "orphan argv cannot prove authentication identity");

  const state = scene.controller.getState();
  assert.equal(state.tunnelNextRetryTime, 0, "认领成功等于隧道健康，退避必须清零");
  assert.equal(state.tunnelRetryCount, 0);
  assert.equal(state.tunnelDeathCount, 0);
  assert.equal(state.adoptedPid, 5150);
  assert.equal(state.configApplied, false);
  assert.equal(state.configIdentityState, "unverified");
  assert.equal(scene.controller.getCurrentChild(), null, "认领的进程不是我们的子进程，getCurrentChild 必须是 null");

  const adopted = scene.eventFields("tunnel-orphan-adopted");
  assert.ok(adopted, "必须有 tunnel-orphan-adopted 事件");
  assert.equal(adopted.pid, 5150);
  assert.equal(adopted.serverId, "server-01");
  assert.equal(adopted.mode, "execute");
  assert.ok(scene.stages.some((s) => s.ok === true && s.adopted === true), "bridge stage 必须报一次 ok+adopted");
});

test("孤儿接管: 认领后 crashGuard / buildShutdownPlan 不因没有 child 对象而崩", async () => {
  const scene = makeOrphanScenario();
  await scene.failForwardOnce();

  const controllers = new Map([["server-01", { config: cfg, controller: scene.controller }]]);
  const plan = buildShutdownPlan({ getCurrentChild: () => null }, controllers);
  assert.deepEqual(plan.children, [], "认领态没有可 kill 的 child，绝不能把 null 塞进 children");
  assert.ok(plan.recordNames.includes("tunnel.server-01"), "记录名仍要留给 stopChannel 按注册表精准处理");

  let exited = null;
  const guard = createCrashGuard({ getChildren: () => plan.children, log: () => {}, exitImpl: (code) => { exited = code; } });
  assert.doesNotThrow(() => guard("uncaughtException", new Error("boom")));
  assert.equal(exited, 1);
});

test("孤儿接管: observeOnly 只写观察日志，不动注册表、不清退避", async () => {
  const scene = makeOrphanScenario({ autoRepair: { enabled: true, observeOnly: true } });
  await scene.failForwardOnce();

  assert.deepEqual(scene.adoptions(), [], "观察模式绝不写注册表");
  assert.ok(scene.controller.getState().tunnelNextRetryTime > scene.now(), "观察模式保留既有退避（行为与关掉规则一致）");
  assert.equal(scene.controller.getState().adoptedPid, null);
  const observed = scene.eventFields("tunnel-orphan-adopt");
  assert.ok(observed, "观察模式仍要留下可核对的日志");
  assert.equal(observed.mode, "observe");
  assert.equal(observed.pid, 5150);
  assert.equal(scene.hasEvent("tunnel-orphan-adopted"), false);
});

test("孤儿接管: 规则关闭时行为与本次改动前完全一致（不扫描进程、只退避）", async () => {
  const scene = makeOrphanScenario({ autoRepair: { enabled: true, observeOnly: false, rules: { "orphan-tunnel-adopt": false } } });
  await scene.failForwardOnce();

  assert.deepEqual(scene.scanned, [], "规则关闭时连本机进程扫描都不该发生");
  assert.deepEqual(scene.adoptions(), []);
  assert.ok(scene.controller.getState().tunnelNextRetryTime > scene.now(), "退避照旧建立");
  assert.equal(scene.hasEvent("tunnel-orphan-adopted"), false);
  assert.equal(scene.hasEvent("tunnel-orphan-ratelimited"), false);

  // 总开关 enabled:false 同理。
  const off = makeOrphanScenario({ autoRepair: { enabled: false } });
  await off.failForwardOnce();
  assert.deepEqual(off.scanned, []);
  assert.deepEqual(off.adoptions(), []);
});

test("孤儿接管: 每服务器 5 分钟 1 次——第二次转发失败只记限频日志，不再认领", async () => {
  const scene = makeOrphanScenario();
  await scene.failForwardOnce();
  assert.equal(scene.adoptions().length, 1);

  scene.tick(60_000); // 仍在 5 分钟冷却内
  await scene.failForwardOnce();

  assert.equal(scene.adoptions().length, 1, "冷却期内不得重复认领");
  const limited = scene.eventFields("tunnel-orphan-ratelimited");
  assert.ok(limited, "被限频要有可观察的日志，否则用户看不到为什么没修");
  assert.equal(limited.serverId, "server-01");
  assert.ok(scene.controller.getState().tunnelNextRetryTime > scene.now(), "限频时回到既有退避");
});

test("孤儿接管: 远端端口被异己占用 → 长退避 5 分钟、提示换端口、绝不杀任何进程", async () => {
  const scene = makeOrphanScenario({ sshProcesses: [], remoteListening: true });
  const child = await scene.failForwardOnce();

  assert.deepEqual(scene.adoptions(), [], "异己占用绝不登记");
  assert.equal(child.killed, false, "异己占用绝不杀任何进程（杀了很可能是同事的隧道）");
  assert.equal(scene.controller.getState().adoptedPid, null);
  assert.equal(
    scene.controller.getState().tunnelNextRetryTime,
    scene.now() + 300_000,
    "异己占用不是重试能解决的，退避拉到 5 分钟",
  );
  const foreign = scene.eventFields("tunnel-port-foreign");
  assert.ok(foreign);
  assert.equal(foreign.serverId, "server-01");
  assert.equal(foreign.nextAction, "换端口或联系占用者");
  assert.ok(scene.stages.some((s) => s.ok === false && s.foreign === true));
});

test("孤儿接管: 本机同签名进程带的是另一个实例的会话标记时按异己处理", async () => {
  const scene = makeOrphanScenario({
    sshProcesses: [{ pid: 5150, command: `${orphanCommand} codex-tunnel:ffffffffffffffff:7891` }],
    remoteListening: true,
    tunnelOwnerId: "0123456789abcdef",
  });
  await scene.failForwardOnce();
  assert.deepEqual(scene.adoptions(), []);
  assert.ok(scene.hasEvent("tunnel-port-foreign"));
});

test("孤儿接管: 本机同签名进程带本实例的会话标记 → 认领（控制器把识别码交给判定）", async () => {
  const command = `${orphanCommand} codex-tunnel:0123456789abcdef:7891`;
  const scene = makeOrphanScenario({ sshProcesses: [{ pid: 5150, command }], tunnelOwnerId: "0123456789abcdef" });
  await scene.failForwardOnce();
  assert.deepEqual(scene.adoptions().map(({ name, pid }) => ({ name, pid })), [{ name: "tunnel.server-01", pid: 5150 }]);
  assert.equal(scene.adoptions()[0].meta.command, command);
});

test("孤儿接管: adopted/foreign 透传进 bridge stage 快照（state-store / 前端要读）", () => {
  let snapshot = reduceBridgeStage(undefined, { stage: "ssh-tunnel", ok: true, durationMs: 0, adopted: true }, 1000);
  assert.equal(snapshot.adopted, true);

  snapshot = reduceBridgeStage(snapshot, { stage: "ssh-tunnel", ok: false, durationMs: 0, foreign: true, backoffUntil: 301_000 }, 1000);
  assert.equal(snapshot.foreign, true);
  assert.equal(
    snapshot.adopted,
    false,
    "adopted 是一次性事件，下一拍必须显式落回 false——state-store 是合并语义，省略字段等于永远为 true",
  );

  // 退避期的每一拍 emitStage 都不带 foreign，但占用还在——必须粘住，否则 1s 轮询的前端看不到。
  snapshot = reduceBridgeStage(snapshot, { stage: "ssh-tunnel", ok: false, durationMs: 0, backoffUntil: 300_000 }, 2000);
  assert.equal(snapshot.foreign, true);

  snapshot = reduceBridgeStage(snapshot, { stage: "ssh-tunnel", ok: true, durationMs: 40, backoffUntil: 0 }, 3000);
  assert.equal(snapshot.foreign, false, "隧道恢复即清除异己占用标记");
});

test("孤儿接管: 服务器被移除时 stopCurrent 会按 pid 停掉认领的隧道（先复核命令行）", async () => {
  const scene = makeOrphanScenario();
  await scene.failForwardOnce();
  assert.equal(scene.controller.getState().adoptedPid, 5150);

  await scene.controller.stopCurrent();
  assert.deepEqual(scene.kills, [{ pid: 5150, signal: "SIGTERM" }], "认领的进程必须被 SIGTERM，否则删配置后又变孤儿");
  assert.equal(scene.controller.getState().adoptedPid, null);
  assert.ok(scene.hasEvent("tunnel-adopted-stopped"));
});

test("孤儿接管: 认领的 pid 已被别的进程复用时拒绝杀（只放掉认领状态）", async () => {
  const scene = makeOrphanScenario({
    sshProcesses: (call) => (call === 1
      ? [{ pid: 5150, command: orphanCommand }]
      : [{ pid: 5150, command: "ssh someone-else@otherhost -N -R 127.0.0.1:9999:127.0.0.1:1 otherhost" }]),
  });
  await scene.failForwardOnce();
  assert.equal(scene.controller.getState().adoptedPid, 5150);

  await scene.controller.stopCurrent();
  assert.deepEqual(scene.kills, [], "命令行不一致就是 pid 复用，绝不能杀");
  assert.equal(scene.controller.getState().adoptedPid, null);
  assert.ok(scene.hasEvent("tunnel-adopted-skip-kill"));
});

test("孤儿接管: win32 一律不认领——没有 ps 就没有认领依据，猜着认比不认危险", async () => {
  // 同一份"本机确实有一条签名完全吻合的孤儿 ssh"的场景，只把平台换成 win32：
  // 必须退回普通失败退避，绝不写注册表、不发任何信号。
  const scene = makeOrphanScenario({ platform: "win32" });
  await scene.failForwardOnce();

  assert.deepEqual(scene.adoptions(), [], "win32 不得把任何 pid 登记成自己的隧道");
  assert.deepEqual(scene.kills, []);
  assert.equal(scene.controller.getState().adoptedPid, null);
  assert.ok(scene.controller.getState().tunnelNextRetryTime > 0, "认领不成立时必须照常退避");
});

async function coldIdentityFixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "cold-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const live = new Map();
  const signals = [];
  const stages = [];
  const spawned = [];
  let seq = 7000;
  const registry = createProcessRegistry({ runtimeDir: dir, platform: "linux",
    execFileImpl: async (_cmd, args) => {
      const pid = Number(args.at(-1));
      return { stdout: live.has(pid) ? `${pid} ${live.get(pid)}` : "" };
    },
    killProcess: (pid, signal) => { signals.push({ pid, signal }); live.delete(pid); },
    waitForPidExitImpl: async (pid) => !live.has(pid),
  });
  const make = () => createTunnelController({ name: tunnelRecordName(cfg.id), rootDir: dir, registry,
    execFileImpl: async () => { throw new Error("cold identity path must not run SSH/ps"); },
    spawnImpl: (_cmd, args) => { const child = makeFakeChild(++seq); live.set(child.pid, `ssh ${args.join(" ")}`); spawned.push(child.pid); return child; },
    recordRuntimeProcess: registry.recordProcess,
    emitStage: (stage) => stages.push(stage),
    credentialVault: { get: async () => "fixture-password" },
    createPasswordSshSessionImpl: async () => ({ args: ["-o", "BatchMode=no"], env: {}, dispose: async () => {} }),
    waitForPidExitImpl: async (pid) => !live.has(pid),
  });
  return { dir, live, signals, stages, spawned, registry, make };
}

test("cold takeover persists config identity across controllers and keeps an unchanged connection", async (t) => {
  const h = await coldIdentityFixture(t);
  await h.make().restartControlled(cfg, { verifyBudgetMs: 0 });
  const oldPid = h.spawned[0];
  assert.equal(h.registry.readMeta(tunnelRecordName(cfg.id)).configIdentity, buildTunnelIdentity(cfg));
  const restartedSupervisor = h.make();
  const result = await restartedSupervisor.ensure(cfg);
  assert.equal(result.configApplied, true);
  assert.equal(result.configIdentityState, "verified");
  assert.deepEqual(h.spawned, [oldPid]);
  assert.deepEqual(h.signals, []);
  assert.equal(restartedSupervisor.getState().adoptedPid, oldPid);
});

test("cold takeover applies changed port/user/key/auth/pin only to the scoped owned tunnel", async (t) => {
  const original = { ...cfg, sshPort: 22, sshUser: "user-one", sshIdentityFile: "/tmp/key-one", authRef: "mem:one", knownHostsPath: "/tmp/pin", knownHostsRevision: "first" };
  for (const patch of [{ sshPort: 2222 }, { sshUser: "user-two" }, { sshIdentityFile: "/tmp/key-two" }, { authRef: "mem:two" }, { knownHostsRevision: "second" }]) {
    const h = await coldIdentityFixture(t);
    await h.make().restartControlled(original, { verifyBudgetMs: 0 });
    const oldPid = h.spawned[0];
    h.live.set(9999, "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 other-host");
    h.registry.recordProcess("tunnel.other", 9999, { command: h.live.get(9999), cwd: h.dir, signature: "other-host", configIdentity: "other-identity" });
    const desired = { ...original, ...patch };
    const result = await h.make().ensure(desired);
    assert.equal(result.reason, "config-identity-changed");
    assert.equal(result.respawned, true);
    assert.deepEqual(h.signals, [{ pid: oldPid, signal: "SIGTERM" }]);
    assert.equal(h.spawned.length, 2);
    assert.equal(h.registry.readMeta(tunnelRecordName(cfg.id)).configIdentity, buildTunnelIdentity(desired));
    assert.equal(h.live.has(9999), true);
    assert.equal(h.registry.readMeta("tunnel.other").pid, 9999);
  }
});

test("cold takeover keeps legacy identity unknown and publishes unapplied state", async (t) => {
  const h = await coldIdentityFixture(t);
  await h.make().restartControlled(cfg, { verifyBudgetMs: 0 });
  const { configIdentity, ...legacy } = h.registry.readMeta(tunnelRecordName(cfg.id));
  h.registry.recordProcess(tunnelRecordName(cfg.id), legacy.pid, legacy);
  const controller = h.make();
  const result = await controller.ensure({ ...cfg, sshUser: "new-user" });
  assert.equal(result.ok, true, "old transport remains usable");
  assert.equal(result.configApplied, false);
  assert.equal(controller.getState().configIdentityState, "unverified");
  assert.equal(h.stages.at(-1).configApplied, false);
  assert.equal(h.registry.readMeta(tunnelRecordName(cfg.id)).configIdentity, undefined);
  assert.deepEqual(h.signals, []);
  assert.equal(h.spawned.length, 1);
  const reduced = reduceBridgeStage({}, { stage: "ssh-tunnel", ...h.stages.at(-1) }, 1000);
  assert.equal(reduced.configIdentityState, "unverified");
  assert.equal(reduced.configApplied, false);
});

test("cold takeover refuses to replace a record belonging to another checkout", async (t) => {
  const h = await coldIdentityFixture(t);
  await h.make().restartControlled(cfg, { verifyBudgetMs: 0 });
  const meta = h.registry.readMeta(tunnelRecordName(cfg.id));
  h.registry.recordProcess(meta.name, meta.pid, { ...meta, cwd: "/another-checkout" });
  const result = await h.make().ensure({ ...cfg, sshUser: "changed" });
  assert.equal(result.reason, "config-identity-owner-unverified");
  assert.equal(result.configApplied, false);
  assert.deepEqual(h.signals, []);
  assert.equal(h.spawned.length, 1);
});

// ---------------------------------------------------------------------------
// 性能：每拍共享代理探活 / 分层配置按文件戳缓存 / 钉扎探针复用
// ---------------------------------------------------------------------------

test("createTickProxyHealth: 代理本拍判健康后 N 条隧道零额外探活；判不健康时隧道共享一次复探", async () => {
  const checks = [];
  let healthy = true;
  const health = createTickProxyHealth({ check: async (port) => { checks.push(port); return { ok: healthy }; } });
  health.beginTick();
  await health.checkHealth(8888);
  const results = await Promise.all([health.isHealthy(8888), health.isHealthy(8888), health.isHealthy(8888)]);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(checks.length, 1, "1+N 次探活收敛为 1 次");

  health.beginTick();
  healthy = false;
  await health.checkHealth(8888);
  healthy = true; // 代理刚被重建：隧道侧需要一次新鲜结果
  const again = await Promise.all([health.isHealthy(8888), health.isHealthy(8888)]);
  assert.deepEqual(again, [true, true]);
  assert.equal(checks.length, 3, "不健康时所有隧道只共享一次复探");

  // 代理处于退避（本拍没探）：隧道共享一次探活。
  health.beginTick();
  await Promise.all([health.isHealthy(8888), health.isHealthy(8888)]);
  assert.equal(checks.length, 4);
});

test("createTickProxyHealth: 结果过期或端口不同不复用；check 抛错按不健康", async () => {
  let clock = 0;
  let calls = 0;
  const health = createTickProxyHealth({ now: () => clock, maxAgeMs: 5000, check: async () => { calls += 1; return { ok: true }; } });
  health.beginTick();
  await health.checkHealth(8888);
  clock = 6000;
  assert.equal(await health.isHealthy(8888), true);
  assert.equal(calls, 2, "过期结果不能复用");
  assert.equal(await health.isHealthy(9999), true);
  assert.equal(calls, 3, "端口不同不能复用");
  const broken = createTickProxyHealth({ check: async () => { throw new Error("boom"); } });
  broken.beginTick();
  assert.equal(await broken.isHealthy(8888), false);
});

test("createLayeredConfigReader: 文件戳不变不重读，改写即重读，读失败不缓存，返回值互不污染", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = await mkdtemp(path.join(tmpdir(), "supervisor-cfg-cache-"));
  try {
    const team = path.join(dir, "config.json");
    const local = path.join(dir, "config.local.json");
    writeFileSync(team, JSON.stringify({ servers: [{ id: "server-01", host: "myserver" }] }));
    let loads = 0;
    let fail = false;
    const read = createLayeredConfigReader({
      load: ({ configPath: teamPath }) => {
        loads += 1;
        if (fail) throw new Error("broken json");
        return JSON.parse(String(readFileSyncForTest(teamPath)));
      },
    });
    const first = read({ configPath: team, localConfigPath: local });
    first.servers[0].host = "mutated";
    const second = read({ configPath: team, localConfigPath: local });
    assert.equal(loads, 1, "戳不变不重读");
    assert.equal(second.servers[0].host, "myserver", "调用方修改不能污染缓存");

    writeFileSync(local, JSON.stringify({ sshUser: "alice" }));
    read({ configPath: team, localConfigPath: local });
    assert.equal(loads, 2, "个人层出现/变化即重读");

    writeFileSync(team, JSON.stringify({ servers: [], x: 1 }));
    fail = true;
    assert.throws(() => read({ configPath: team, localConfigPath: local }), /broken json/);
    fail = false;
    assert.deepEqual(read({ configPath: team, localConfigPath: local }).servers, []);
    assert.equal(loads, 4, "失败不缓存，下一拍重读");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("remotePortOpen: 钉扎 known_hosts 时复用绑定修订号的独立 socket，修订号变化换 socket；隧道参数仍 -S none", async () => {
  if (process.platform === "win32") return;
  const seen = [];
  const execFileImpl = async (_cmd, args) => { seen.push(args); return { code: 0, timedOut: false }; };
  const pinned = { ...cfg, knownHostsPath: "/tmp/ssh/known_hosts-server-01", knownHostsRevision: "rev-a" };
  await remotePortOpen(pinned, { execFileImpl, platform: "darwin" });
  await remotePortOpen({ ...pinned, knownHostsRevision: "rev-b" }, { execFileImpl, platform: "darwin" });
  const controlPath = (args) => args.find((a) => String(a).startsWith("ControlPath="));
  assert.ok(seen[0].includes("ControlMaster=auto"));
  assert.match(controlPath(seen[0]), /^ControlPath=~\/\.ssh\/cm-[0-9a-f]{8}-%C$/);
  assert.notEqual(controlPath(seen[0]), controlPath(seen[1]), "钉扎内容变化必须换 socket");
  assert.equal(controlPath(seen[0]).includes(" "), false);
  // 常驻隧道进程绝不复用（P0 教训）。
  const tunnelArgs = buildTunnelArgs(pinned);
  assert.deepEqual(tunnelArgs.slice(0, 2), ["-S", "none"]);
  assert.equal(tunnelArgs.some((a) => String(a).startsWith("ControlMaster") || String(a).startsWith("ControlPath")), false);
});
