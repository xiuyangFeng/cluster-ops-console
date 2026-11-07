// ---------------------------------------------------------------------------
// 本地 CONNECT 代理控制器（同样需要 A1 的身份守卫）
// ---------------------------------------------------------------------------
// 全部隧道共用的唯一本地代理：保活 ensure、接管上一任留下的代理、平滑交接（handoff）。
import { spawn } from "node:child_process";

import { computeTunnelBackoffSec } from "../../monitor-core.mjs";
import { ensurePidExited, waitForPidExit } from "../process-registry.mjs";
import { classifyProxyLogLine } from "./log-policy.mjs";
import { createMutationQueue } from "./mutation-queue.mjs";
import { HANDOFF_WAITING_MARKER, PROXY_HANDOFF_ENV } from "../proxy/protocol.mjs";

export const PROXY_DEATH_THRESHOLD = 3;
const PROXY_SPAWN_GRACE_MS = 4000;
// 停旧代理时等它真正让出端口的预算（超时 SIGKILL 升级）。
const RESPAWN_WAIT_BUDGET_MS = 2000;

export function createLocalProxyController({
  spawnImpl = spawn,
  log: logImpl = () => {},
  now = Date.now,
  waitForPidExitImpl = waitForPidExit,
  // 与隧道控制器同名同语义（可注入，便于测试断言 SIGTERM→SIGKILL 升级）。
  killProcess = (pid, signal) => process.kill(pid, signal),
  removeRuntimeRecord: removeRuntimeRecordImpl = async () => {},
  recordRuntimeProcess: recordRuntimeProcessImpl = () => {},
  rootDir: controllerRootDir = process.cwd(),
  emitStage = () => {},
  computeBackoffSec = computeTunnelBackoffSec,
  deathThreshold = PROXY_DEATH_THRESHOLD,
  spawnGraceMs = PROXY_SPAWN_GRACE_MS,
  // 热更新接管：新 supervisor 面对的是上一任留下的健康代理（不是本进程的子进程、
  // 没有 child 句柄）。它照常被保留；只有在它真的不健康时才用到这两个钩子：
  //   verifyAdopted()     注册表校验 local-proxy 记录（进程已不在 → 立即重建，不必等死计数）
  //   stopAdoptedProxy()  按注册表（命令行复核后）停掉卡死的接管代理，再起新的
  verifyAdopted = async () => ({ verified: false }),
  stopAdoptedProxy = async () => ({ stopped: false, reason: "not supported" }),
  sleep: sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let current = null; // { child, pid, startedAt }
  let proxyDeathCount = 0;
  let lastSpawnAt = 0;
  let portConflictCount = 0;
  let proxyNextRetryTime = 0;
  // 上一拍探活判健康、但不是本进程 spawn 的代理（热更新接管 / supervisor 重启后接管）。
  let adoptedHealthy = false;
  // 最近一次健康探活读回的代理身份（pid / 组件指纹 / 交接能力），供运行快照发布。
  let observed = null;

  // ensure（正常保活）与 handoff（平滑交接）共用互斥：交接中途不允许保活逻辑插一脚
  // （它会把"旧代理已释放监听、新代理尚未绑定"的 20ms 窗口误判成死亡而重建）。
  const serializeMutation = createMutationQueue();

  function getCurrentChild() {
    return current ? current.child : null;
  }

  function getState() {
    return {
      hasCurrent: Boolean(current),
      currentPid: current ? current.pid : null,
      proxyDeathCount,
      lastSpawnAt,
      portConflictCount,
      proxyNextRetryTime,
      adoptedHealthy,
      observed: observed ? { ...observed } : null,
    };
  }

  function logProxyOutput(prefix, chunk) {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      const classified = classifyProxyLogLine(text);
      if (!classified.persist) continue;
      logImpl(`${prefix} ${text}`, {
        level: classified.level,
        ...(classified.nextAction ? { nextAction: classified.nextAction } : {}),
      });
    }
  }

  function attachHandlers(record, config) {
    record.child.on("error", (err) => {
      logImpl(`local proxy spawn error: ${err.message}`, { level: "error", event: "proxy-spawn-error" });
      record.markExited();
      if (current === record) {
        current = null;
        removeRuntimeRecordImpl("local-proxy");
      }
    });
    record.child.on("exit", (code, signal) => {
      record.markExited();
      const level = code === 2 || (code && code !== 0) ? "error" : "info";
      logImpl(`local proxy exited code=${code ?? "-"} signal=${signal ?? "-"}`, { level, event: "proxy-exit" });
      // 交接用的新代理抢不到端口属于交接失败（handoff 自己处理），不计入端口冲突退避。
      if (code === 2 && !record.handoffPending) {
        portConflictCount += 1;
        const backoffSec = computeBackoffSec(portConflictCount);
        proxyNextRetryTime = now() + backoffSec * 1000;
        logImpl(`[FATAL ERROR] local proxy port ${config.localPort} is already in use! Please check if another process is using it.`, {
          level: "error",
          event: "proxy-port-in-use",
          nextAction: "检查是否已有另一份控制台在跑，或换端口后重跑 npm run setup",
          backoffSec,
        });
      }
      // A1 修复：同样的身份守卫。
      if (current === record) {
        current = null;
        removeRuntimeRecordImpl("local-proxy");
      }
    });
  }

  async function registerRecord(record) {
    if (!record.pid) return;
    recordRuntimeProcessImpl("local-proxy", record.pid, {
      command: "node work/local_http_connect_proxy.mjs",
      args: ["work/local_http_connect_proxy.mjs"],
      cwd: controllerRootDir,
      parentPid: process.pid,
    });
  }

  // handoff=true：以交接模式启动（端口被占时重试 bind），不立即成为 current、不写登记——
  // 只有确认它接管了端口之后才换登记，失败时旧代理的登记原样保留。
  async function spawnProxy(config, { handoff = false } = {}) {
    const env = { ...process.env, PORT: String(config.localPort) };
    if (handoff) env[PROXY_HANDOFF_ENV] = "1";
    else delete env[PROXY_HANDOFF_ENV];
    const child = spawnImpl(process.execPath, ["work/local_http_connect_proxy.mjs"], {
      cwd: controllerRootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = { child, pid: child.pid, startedAt: now(), handoffPending: handoff, exited: false };
    record.exitedPromise = new Promise((resolve) => {
      record.markExited = () => {
        record.exited = true;
        resolve("exited");
      };
    });
    record.waitingPromise = new Promise((resolve) => {
      record.markWaiting = () => resolve("waiting");
    });
    let stdoutTail = "";
    if (!handoff) {
      current = record;
      lastSpawnAt = record.startedAt;
    }
    attachHandlers(record, config);
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        // 标记行可能被管道切成两块：只保留一小段尾巴拼接判断。
        stdoutTail = `${stdoutTail}${String(chunk)}`.slice(-256);
        if (stdoutTail.includes(HANDOFF_WAITING_MARKER)) record.markWaiting();
        logProxyOutput("[proxy]", chunk);
      });
    }
    if (child.stderr && typeof child.stderr.on === "function") {
      child.stderr.on("data", (chunk) => logProxyOutput("[proxy:err]", chunk));
    }
    if (!handoff) await registerRecord(record);
    return record;
  }

  async function killCurrentAndWait() {
    if (!current) return;
    const pid = current.pid;
    if (current.child && !current.child.killed) current.child.kill("SIGTERM");
    // 同隧道控制器：本地代理若不真正让出端口，新代理必然 EADDRINUSE，而所有隧道的
    // 落点都指向这个端口——表现为"通道重启后全部隧道立刻变红"。
    if (pid) await ensurePidExited(pid, RESPAWN_WAIT_BUDGET_MS, { killImpl: killProcess, waitImpl: waitForPidExitImpl });
  }

  async function stopCurrent() {
    await killCurrentAndWait();
  }

  function ensure(config, options = {}) {
    return serializeMutation(() => ensureImpl(config, options));
  }

  async function ensureImpl(config, { checkHealth, stopping: isStopping = () => false } = {}) {
    if (isStopping()) return { skipped: true };
    const nowMs = now();
    if (nowMs < proxyNextRetryTime) {
      emitStage({ ok: false, durationMs: 0, backoffUntil: proxyNextRetryTime });
      return { skipped: true, reason: "backoff" };
    }

    const health = await checkHealth(config.localPort);
    if (health.ok) {
      proxyDeathCount = 0;
      portConflictCount = 0;
      proxyNextRetryTime = 0;
      // 健康但不是自己的子进程：上一任 supervisor 留下的代理，原样保留、绝不重启。
      adoptedHealthy = !current;
      if (health.proxy) observed = { ...health.proxy };
      emitStage({ ok: true, durationMs: health.durationMs });
      return { ok: true, ...(adoptedHealthy ? { adopted: true } : {}) };
    }

    let adoptedAlive = false;
    if (!current && adoptedHealthy) {
      // 接管来的代理判不健康：进程已不在就立即重建；进程还在则与自有代理同样走死计数，
      // 不能凭一次探活抖动就去抢它的端口。
      try {
        const verification = await verifyAdopted();
        adoptedAlive = Boolean(verification && (verification.verified || verification.indeterminate));
      } catch {
        adoptedAlive = false;
      }
      if (!adoptedAlive) adoptedHealthy = false;
    }

    if (current || adoptedAlive) {
      // 探活超时不杀已有代理：/proxy-health 卡住不等于进程已死。
      if (health.timedOut) {
        return { ok: false, timedOut: true };
      }
      if (current && nowMs - lastSpawnAt < spawnGraceMs) {
        return { ok: false, grace: true };
      }
      proxyDeathCount += 1;
      if (proxyDeathCount < deathThreshold) {
        emitStage({ ok: false, durationMs: health.durationMs || 0 });
        return { ok: false, deathCount: proxyDeathCount };
      }
    }

    emitStage({ ok: false, durationMs: 0, restartDelta: 1 });
    await killCurrentAndWait();
    if (!current && adoptedAlive) {
      const stopped = await stopAdoptedProxy().catch((err) => ({ stopped: false, reason: err.message }));
      logImpl(`stopping unhealthy adopted local proxy: ${stopped?.reason || (stopped?.stopped ? "stopped" : "unknown")}`, {
        level: stopped?.stopped ? "info" : "warn",
        event: "proxy-adopted-stop",
      });
    }
    adoptedHealthy = false;
    observed = null;

    if (isStopping()) return { skipped: true };
    logImpl(`starting local HTTP CONNECT proxy on port ${config.localPort}`, { event: "proxy-start" });
    proxyDeathCount = 0;
    await spawnProxy(config);
    return { ok: false, respawned: true };
  }

  // 平滑交接（仅信箱 proxy-handoff 触发）：
  //   1) 当前代理必须健康且声明支持交接（旧版本代理不认释放请求，强换只能断连，直接拒绝）；
  //   2) 以交接模式起新代理，等它报告"端口被占、正在重试"；
  //   3) requestRelease(oldPid)：旧代理关监听、保留已有连接；新代理 ~20ms 内绑定；
  //   4) 探活直到响应来自新 pid，才把登记换成新 pid。
  // 任何一步失败：新代理若还活着就停掉；若旧代理已经释放了监听，立即普通模式补起一个，
  // 避免端口空窗等到死计数。旧代理（无论是否本进程子进程）一律不杀：它在排空已有连接。
  async function handoffImpl(config, {
    probe,
    requestRelease,
    clearRelease = async () => {},
    // 释放前把旧代理登记为 local-proxy-draining（显式退出可据此停掉排空中的旧代理）；
    // 释放请求没送达（旧代理照常在服务、仍是 local-proxy）则撤销这条登记。
    recordDraining = async () => {},
    clearDraining = async () => {},
    waitingTimeoutMs = 5000,
    bindTimeoutMs = 5000,
    pollMs = 50,
  } = {}) {
    const port = config.localPort;
    const before = await probe(port);
    if (!before?.ok) {
      return { status: "failed", phase: "queued", reason: "current local proxy is not healthy; nothing to hand off", evidence: {} };
    }
    const oldPid = before.proxy?.pid ?? null;
    if (!before.proxy?.handoff || !oldPid) {
      return {
        status: "failed",
        phase: "queued",
        reason: "running local proxy predates graceful handoff; replacing it would drop live connections",
        evidence: { oldPid },
      };
    }
    const record = await spawnProxy(config, { handoff: true });
    const stopNew = async () => {
      if (!record.exited && record.child && !record.child.killed) {
        try {
          record.child.kill("SIGTERM");
        } catch {}
        if (record.pid) await waitForPidExitImpl(record.pid, RESPAWN_WAIT_BUDGET_MS);
      }
    };
    const timeout = (ms) => sleepImpl(ms).then(() => "timeout");
    const state = await Promise.race([record.waitingPromise, record.exitedPromise, timeout(waitingTimeoutMs)]);
    if (state !== "waiting") {
      await stopNew();
      return {
        status: "failed",
        phase: "executing",
        reason: state === "exited" ? "new proxy exited before reaching the handoff wait state" : "new proxy did not reach the handoff wait state in time",
        evidence: { oldPid, newPid: record.pid ?? null },
      };
    }
    let released = false;
    let takeover = null;
    try {
      await Promise.resolve()
        .then(() => recordDraining(oldPid))
        .catch((err) => logImpl(`recording draining proxy pid ${oldPid} failed: ${err.message}`, { level: "warn", event: "proxy-handoff" }));
      await requestRelease(oldPid);
      released = true;
      const deadline = now() + bindTimeoutMs;
      while (now() < deadline && !record.exited) {
        const h = await probe(port).catch(() => null);
        if (h?.ok && h.proxy?.pid === record.pid) {
          takeover = h;
          break;
        }
        await sleepImpl(pollMs);
      }
    } catch (err) {
      logImpl(`proxy handoff release request failed: ${err.message}`, { level: "warn", event: "proxy-handoff" });
    } finally {
      await clearRelease(oldPid).catch(() => {});
      if (!released) await Promise.resolve().then(() => clearDraining(oldPid)).catch(() => {});
    }
    if (!takeover) {
      await stopNew();
      let fallbackPid = null;
      if (released) {
        // 旧代理可能已经关了监听：不等死计数，立刻普通模式补一个（端口空闲则秒起）。
        current = null;
        adoptedHealthy = false;
        const fallback = await spawnProxy(config);
        fallbackPid = fallback.pid ?? null;
      }
      logImpl(`local proxy handoff failed; new proxy did not take over port ${port}`, { level: "error", event: "proxy-handoff" });
      return {
        status: "failed",
        phase: "verifying",
        reason: released ? "new proxy did not take over the port after release; started a fresh proxy" : "release request could not be delivered; old proxy kept serving",
        evidence: { oldPid, newPid: record.pid ?? null, fallbackPid },
      };
    }
    record.handoffPending = false;
    current = record;
    lastSpawnAt = record.startedAt;
    adoptedHealthy = false;
    proxyDeathCount = 0;
    observed = takeover.proxy ? { ...takeover.proxy } : null;
    await registerRecord(record);
    logImpl(`local proxy handed off: pid ${oldPid} -> ${record.pid}; old proxy keeps its live connections until they finish`, {
      event: "proxy-handoff",
    });
    emitStage({ ok: true, durationMs: 0 });
    return {
      status: "succeeded",
      phase: "verified",
      reason: "",
      evidence: { oldPid, newPid: record.pid ?? null },
    };
  }

  function handoff(config, options = {}) {
    return serializeMutation(() => handoffImpl(config, options));
  }

  return { ensure, getCurrentChild, getState, stopCurrent, handoff };
}
