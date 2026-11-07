// 服务直达（v2.62）：把本人在集群上监听的服务临时转发到本机——每条转发一个独立的 `ssh -N -L`。
//
// 本文件是管理器：起进程、等就绪、到点收回、关停、清孤儿。ssh 参数、要避开的本机端口、命令行特征这些纯函数
// 在 forward-spec.mjs（与 supervisor 的 tunnel-spec.mjs 同样的分工）。
//
// 与现役隧道（supervisor 的 ssh -R）没有任何关系：
//   - 不复用连接、只有一条 -L、只绑 127.0.0.1（参数见 forward-spec.mjs）；不写任何配置，不碰任何别的进程，
//     只管自己 spawn 出来的子进程。
//   - 本机端口由系统挑（绑一次 127.0.0.1:0 拿一个空闲端口），并避开 8877、本机代理端口、1455 与配置里
//     出现过的所有端口。
//   - 开之前先用 `ssh -G` 看这台主机生效的配置：~/.ssh/config 若给它写了 LocalForward / RemoteForward /
//     DynamicForward，这条 ssh 会连带去绑那些端口（隧道刚好断着时甚至会把反向端口占走），这种配置下不开转发。
//
// 生命周期：同时最多 FORWARD_LIMIT 条；每条最长 FORWARD_TTL_MS，到点收回；可手动关；远端端口从服务列表里
// 消失后由调用方 reconcile 收回；工作台退出时 beginShutdown（同步发 SIGTERM）+ dispose（确认退出、补 SIGKILL）。
// 每条转发在进程注册表里记一条 service-forward.<serverId>.<端口>（pid + 命令行特征）：工作台被强杀时子进程
// 会留下来，下次启动 sweepOrphans 逐条校验——pid 还在、命令行特征对得上才结束它；对不上只删登记，不动进程。
// 特征用「-N / ExitOnForwardFailure=yes / -L 转发串 / 主机」逐段包含，不用整条命令行逐字相等：Windows 上带空格的
// 参数会被加上引号，逐字比对会对不上、孤儿就清不掉；转发串里的本机端口是系统随机挑的，已经足够唯一。
//
// 就绪判定：ssh 以 LogLevel=VERBOSE 运行，认证通过会在 stderr 打一行 "Authenticated to …"，随后立刻建转发；
// 建不成（本机端口被别的程序抢先占了）时 ExitOnForwardFailure 让它马上退出。所以「看到这一行、稍等片刻进程还在、
// 本机端口连得上」才算建好——监听的确实是这条 ssh。只看「端口连得上」不够：端口是先挑后传的，挑完到 ssh 绑上
// 之间若被别的程序占了，连上的是别人的服务。个别 ssh 不打这一行时，等几秒后退回只看端口。
import { spawn } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { isLocalForwardFailure } from "../cli/login-flows.mjs";
import { execFileWithTimeout } from "../exec.mjs";
import { ensureWindowsOpenSshOnPath } from "../platform.mjs";
import { classifySshFailure } from "../ssh-args.mjs";
import { assertSafeServerId, isPort } from "../validators.mjs";
import {
  buildForwardBase, buildForwardSshArgs, collectReservedPorts, findAmbientForwards, FORWARD_RECORD_PREFIX, FORWARD_REMOTE_HOSTS,
  forwardRecordName, forwardSignature, isForwardRecordName, MIN_FORWARD_PORT,
} from "./forward-spec.mjs";

export const FORWARD_LIMIT = 4;
export const FORWARD_TTL_MS = 2 * 60 * 60 * 1000;
const STDERR_TAIL_CHARS = 2000;
const AUTHENTICATED_RE = /(?:^|\n)Authenticated to /;

export const DEFAULT_FORWARD_TIMINGS = Object.freeze({
  readyMs: 25_000, // 起 ssh 后多久还没建好就放弃（ssh 自己的连接超时 10 秒，其余留给认证）
  pollMs: 150, // 就绪轮询间隔
  settleMs: 300, // 看到认证通过后再等这么久：建不成转发的 ssh 这时已经退出了
  noAuthLineMs: 4_000, // 一直没看到认证那一行：过这么久退回只看本机端口
  killGraceMs: 1_500, // SIGTERM 之后多久补 SIGKILL
  disposeGraceMs: 400, // 退出时等子进程自己结束的时间
  disposeKillMs: 200, // 补 SIGKILL 之后再等的时间
  preflightMs: 5_000, // ssh -G 的时限
  orphanStopMs: 1_500, // 清孤儿时 SIGTERM → SIGKILL 的等待
});

const fail = (message, status) => Object.assign(new Error(message), { status });
// 等 promise 结算，最多等 ms 毫秒；promise 先到就把定时器撤掉，不留一个还在走的定时器拖住进程退出。
const settleWithin = (promise, ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  promise.then(() => {
    clearTimeout(timer);
    resolve();
  });
});

// 让系统挑一个空闲的本机端口（只在 127.0.0.1 上绑一下就放开）。
function allocateEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const port = server.address()?.port;
      server.close(() => resolve(port));
    });
  });
}

// 挑到保留端口就再挑：系统给的是临时端口段，与配置里的端口撞上的机会很小，重挑几次足够。
export async function pickFreeLocalPort({ reserved = new Set(), attempts = 20, allocate = allocateEphemeralPort } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const port = await allocate();
    if (isPort(port) && port >= MIN_FORWARD_PORT && !reserved.has(port)) return port;
  }
  throw new Error("没有挑到可用的本机端口");
}

// 本机 127.0.0.1:<port> 连得上吗（连上即断，不发任何数据）。
export function canConnectLocal(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// 运行目录里的转发登记（按文件名认，不读配置：登记描述的才是「上一次真的起了哪些」）。
export function listForwardRecordNames(runtimeDir, readdirImpl = readdirSync) {
  const suffix = ".pid.json";
  try {
    return readdirImpl(runtimeDir)
      .filter((file) => file.startsWith(FORWARD_RECORD_PREFIX) && file.endsWith(suffix))
      .map((file) => file.slice(0, -suffix.length))
      .filter(isForwardRecordName);
  } catch {
    return [];
  }
}

const lastLine = (text) => String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 200) || "";

export function createServiceForwards({
  registry = null, // 进程注册表（recordProcess / verifyProcess / stopProcess / readMeta）；缺省不登记
  runtimeDir = null,
  cwd = undefined,
  sshArgsFor, // (server, config) → 探针的钉扎参数
  getConfig = () => null, // 合并后的配置（挑本机端口时用来排除已配置的端口）
  monitorPort = null,
  sshCommand = "ssh",
  spawnImpl = spawn,
  execImpl = execFileWithTimeout,
  pickPort = pickFreeLocalPort,
  probePort = canConnectLocal,
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  limit = FORWARD_LIMIT,
  ttlMs = FORWARD_TTL_MS,
  timings: timingOverrides = {},
} = {}) {
  const timings = { ...DEFAULT_FORWARD_TIMINGS, ...timingOverrides };
  const active = new Map(); // key → entry：已建好、对外可见
  const preferredPorts = new Map(); // key → localPort：同一服务上次成功转发的本机端口（重开优先复用）
  const launching = new Set(); // 已 spawn、还没就绪
  const dying = new Set(); // 已收回、等进程退出
  const opening = new Map(); // key → Promise：同一个端口并发的打开合并成一次
  let closing = false;

  const keyOf = (serverId, port) => `${serverId}:${port}`;
  const describe = (entry) => `${entry.serverId}:${entry.port} -> 127.0.0.1:${entry.localPort}`;
  const logFields = (entry, level) => ({ ...(level ? { level } : {}), event: "service-forward", serverId: entry.serverId });
  const view = (entry) => ({
    serverId: entry.serverId,
    port: entry.port,
    localPort: entry.localPort,
    url: `http://127.0.0.1:${entry.localPort}/`,
    startedAt: entry.startedAt,
    expiresAt: entry.expiresAt,
  });

  function removeRecord(entry) {
    if (!entry.recorded) return;
    entry.recorded = false;
    try {
      // 只删仍然指向这个 pid 的登记：同名记录已被新一条转发改写时不动它。
      if (registry.readMeta(entry.recordName)?.pid === entry.pid) unlinkSync(path.join(runtimeDir, `${entry.recordName}.pid.json`));
    } catch {}
  }

  function signal(entry, name) {
    if (entry.exited) return;
    try {
      entry.child.kill(name);
    } catch {}
  }

  function onExit(entry, code, signalName) {
    if (entry.exited) return;
    entry.exited = true;
    entry.exitCode = code;
    clearTimer(entry.ttlTimer);
    clearTimeout(entry.killTimer);
    const wasActive = active.get(entry.key) === entry;
    if (wasActive) active.delete(entry.key);
    launching.delete(entry);
    dying.delete(entry);
    removeRecord(entry);
    if (wasActive) {
      // 不是我们收回的：连接断了、心跳超时或进程被别人结束。
      const tail = lastLine(entry.stderr);
      log(`service forward ${describe(entry)} ended: ssh exited (${signalName || `code ${code ?? "?"}`})${tail ? ` ${tail}` : ""}`, logFields(entry, "warn"));
    } else if (entry.closeReason && !entry.quiet) {
      log(`service forward ${describe(entry)} closed (${entry.closeReason})`, logFields(entry));
    }
    entry.resolveExit();
  }

  // 收回一条转发：立刻从对外的列表里拿掉，SIGTERM，宽限后补 SIGKILL；登记在进程真正退出时删。
  function retire(entry, reason) {
    if (active.get(entry.key) === entry) active.delete(entry.key);
    clearTimer(entry.ttlTimer);
    if (entry.exited) return;
    if (!entry.closeReason) entry.closeReason = reason;
    launching.delete(entry);
    dying.add(entry);
    signal(entry, "SIGTERM");
    if (!entry.killTimer) {
      entry.killTimer = setTimeout(() => signal(entry, "SIGKILL"), timings.killGraceMs);
      entry.killTimer.unref?.();
    }
  }

  function sweepExpired() {
    for (const entry of [...active.values()]) if (now() >= entry.expiresAt) retire(entry, "expired");
  }

  async function checkAmbientForwards(base) {
    let res = null;
    try {
      res = await execImpl(sshCommand, ["-G", ...base.options, base.host], { timeoutMs: timings.preflightMs, cwd });
    } catch {}
    if (res?.code !== 0) {
      // 这一步查不了（很老的 ssh 没有 -G、配置本身有错）：不拦，接下来真正的 ssh 会报出问题。
      log(`service forward preflight skipped: ssh -G exited ${res?.code ?? "?"}`, { level: "warn", event: "service-forward" });
      return;
    }
    const found = findAmbientForwards(res.stdout);
    if (found.length) {
      throw fail(`~/.ssh/config 里给 ${base.host} 配了端口转发（${found.slice(0, 2).join("；")}）。从工作台起的 ssh 会连带去绑这些端口，可能影响现役隧道，所以不在这种配置下开转发；去掉这几行后再试`, 409);
    }
  }

  async function waitReady(entry) {
    const startedAt = Date.now();
    for (;;) {
      if (closing) return "closing";
      if (entry.exited) return "exited";
      const t = Date.now();
      const gateOpen = entry.authAt != null ? t - entry.authAt >= timings.settleMs : t - startedAt >= timings.noAuthLineMs;
      if (gateOpen && (await probePort(entry.localPort)) && !entry.exited && !closing) return "ready";
      if (closing) return "closing";
      if (entry.exited) return "exited";
      if (Date.now() - startedAt >= timings.readyMs) return "timeout";
      await settleWithin(entry.exitPromise, timings.pollMs);
    }
  }

  function failureOf(outcome, entry) {
    if (outcome === "closing") return { error: fail("工作台正在退出，不再开新的转发", 503) };
    if (outcome === "timeout") return { error: fail(`等了 ${Math.round(timings.readyMs / 1000)} 秒转发还没建好，已放弃（SSH 连接太慢或卡住了）`, 504) };
    if (entry.spawnError) return { error: fail(`启动 ssh 失败：${String(entry.spawnError?.message || entry.spawnError).slice(0, 200)}`, 500) };
    if (isLocalForwardFailure(entry.stderr)) {
      return { retry: true, error: fail(`本机端口 ${entry.localPort} 刚好被别的程序占了，转发没建起来，请再试一次`, 409) };
    }
    const ssh = classifySshFailure(entry.stderr);
    if (ssh && ssh.code !== "remote-port") return { error: fail(`SSH 连不上服务器：${ssh.nextAction}`, 502) };
    const tail = lastLine(entry.stderr);
    return { error: fail(`转发没建起来：ssh 退出了（退出码 ${entry.exitCode ?? "未知"}）${tail ? `，${tail}` : ""}`, 502) };
  }

  // 起一条 ssh 并等它就绪。返回 { entry } 或 { error, retry }；失败时确保子进程已结束、登记已删。
  async function launch({ serverId, key, remotePort, remoteHost, base, localPort }) {
    const target = { localPort, remotePort, remoteHost };
    const args = buildForwardSshArgs(base, target);
    const entry = {
      key, serverId, port: remotePort, localPort,
      recordName: forwardRecordName(serverId, remotePort),
      baseKey: JSON.stringify(base),
      child: null, pid: null, recorded: false,
      startedAt: now(), expiresAt: null,
      stderr: "", authAt: null, exited: false, exitCode: null, spawnError: null,
      closeReason: null, quiet: false, ttlTimer: null, killTimer: null,
    };
    entry.exitPromise = new Promise((resolve) => {
      entry.resolveExit = resolve;
    });
    ensureWindowsOpenSshOnPath(sshCommand);
    try {
      entry.child = spawnImpl(sshCommand, args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (error) {
      return { error: fail(`启动 ssh 失败：${String(error?.message || error).slice(0, 200)}`, 500) };
    }
    entry.pid = entry.child.pid ?? null;
    // stderr 一直读到进程结束（不读会把 ssh 卡在写管道上），只留一小段尾巴供失败归因。
    entry.child.stderr?.on?.("data", (chunk) => {
      entry.stderr = `${entry.stderr}${chunk}`.slice(-STDERR_TAIL_CHARS);
      if (entry.authAt == null && (AUTHENTICATED_RE.test(String(chunk)) || AUTHENTICATED_RE.test(entry.stderr))) entry.authAt = Date.now();
    });
    entry.child.once("error", (error) => {
      entry.spawnError = error;
      onExit(entry, null, null);
    });
    entry.child.once("exit", (code, signalName) => onExit(entry, code, signalName));
    launching.add(entry);
    // 先登记再等就绪：这期间工作台被强杀，下次启动也清得掉。登记不上就不留这条转发。
    if (registry && runtimeDir && entry.pid) {
      try {
        registry.recordProcess(entry.recordName, entry.pid, {
          command: `${sshCommand} ${args.join(" ")}`,
          args,
          cwd,
          parentPid: process.pid,
          signature: forwardSignature(base, target),
        });
        entry.recorded = true;
      } catch (error) {
        entry.quiet = true;
        retire(entry, "record-failed");
        await settleWithin(entry.exitPromise, timings.killGraceMs + 500);
        log(`service forward ${describe(entry)} abandoned: cannot record process (${String(error?.message || error).slice(0, 160)})`, logFields(entry, "warn"));
        return { error: fail("转发进程登记不上（运行目录写不进去），这次没有开转发", 500) };
      }
    }
    const outcome = await waitReady(entry);
    if (outcome === "ready") {
      launching.delete(entry);
      entry.startedAt = now();
      entry.expiresAt = entry.startedAt + ttlMs;
      entry.ttlTimer = setTimer(() => {
        if (active.get(key) === entry) retire(entry, "expired");
      }, ttlMs);
      entry.ttlTimer?.unref?.();
      active.set(key, entry);
      preferredPorts.set(key, localPort);
      log(`service forward ${describe(entry)} opened (pid ${entry.pid})`, logFields(entry));
      return { entry };
    }
    const failure = failureOf(outcome, entry);
    entry.quiet = true;
    retire(entry, "failed");
    await settleWithin(entry.exitPromise, timings.killGraceMs + 500);
    launching.delete(entry);
    log(`service forward ${describe(entry)} failed: ${failure.error.message}`, logFields(entry, "warn"));
    return failure;
  }

  async function establish({ server, config, serverId, key, remotePort, remoteHost, acquireSshSlot }) {
    let base;
    try {
      base = buildForwardBase(sshArgsFor(server, config), server.host);
    } catch (error) {
      throw fail(`这台服务器的连接参数不可用：${String(error?.message || error).slice(0, 160)}`, 409);
    }
    await checkAmbientForwards(base);
    const inUse = [...active.values(), ...launching].map((entry) => entry.localPort);
    const reserved = collectReservedPorts(await getConfig(), [monitorPort, ...inUse]);
    // 只在建连期间占一个 SSH 槽位（与探针共用并发上限）；建好之后的长连接不占。
    const release = typeof acquireSshSlot === "function" ? await acquireSshSlot({ hostKey: server.host }) : () => {};
    try {
      let last = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (closing) throw fail("工作台正在退出，不再开新的转发", 503);
        let localPort;
        const preferred = attempt === 0 ? preferredPorts.get(key) : null;
        if (preferred && !reserved.has(preferred)) {
          localPort = preferred;
        } else {
          try {
            localPort = await pickPort({ reserved });
          } catch (error) {
            throw fail(`没有挑到可用的本机端口：${String(error?.message || error).slice(0, 160)}`, 500);
          }
        }
        reserved.add(localPort); // 这一次没建成，下一次也不再挑它
        last = await launch({ serverId, key, remotePort, remoteHost, base, localPort });
        if (last.entry) return view(last.entry);
        if (!last.retry) break;
      }
      throw last.error;
    } finally {
      release();
    }
  }

  // 开一条转发（同一台服务器同一个端口已经开着就直接返回那一条）。
  // remoteHost 只能是 FORWARD_REMOTE_HOSTS 之一；remotePort 是否在服务列表里由调用方（service.mjs）把关。
  async function open({ server, config, remotePort, remoteHost = "127.0.0.1", acquireSshSlot = null } = {}) {
    if (closing) throw fail("工作台正在退出，不再开新的转发", 503);
    let serverId;
    try {
      serverId = assertSafeServerId(server?.id);
    } catch {
      throw fail("服务器不合法", 400);
    }
    if (!isPort(remotePort) || remotePort < MIN_FORWARD_PORT) throw fail("端口不合法", 400);
    if (!FORWARD_REMOTE_HOSTS.includes(remoteHost)) throw fail("转发目标只能是集群本机的回环地址", 400);
    // 调用方已经拦过一道；这里再守一次：密码连接要靠 askpass 喂密码，这条长连接不走那条路。
    if (server.authRef) throw fail("密码连接的服务器不支持转发", 409);
    sweepExpired();
    const key = keyOf(serverId, remotePort);
    const existing = active.get(key);
    if (existing) return view(existing);
    if (opening.has(key)) return opening.get(key);
    if (active.size + opening.size >= limit) {
      const elsewhere = [...new Set([...active.values()].map((entry) => entry.serverId).filter((id) => id !== serverId))];
      throw fail(`已经开了 ${limit} 条转发，先关掉一条再打开${elsewhere.length ? `（有的开在 ${elsewhere.join("、")} 上：切过去可以关，或等它满 2 小时自动收回）` : ""}`, 409);
    }
    const promise = establish({ server, config, serverId, key, remotePort, remoteHost, acquireSshSlot }).finally(() => opening.delete(key));
    opening.set(key, promise);
    return promise;
  }

  function close(serverId, port, reason = "manual") {
    const entry = active.get(keyOf(serverId, port));
    if (!entry) return false;
    retire(entry, reason);
    return true;
  }

  // 按条件收回（配置变了、模块关了）：predicate 收到 { serverId, port, localPort, startedAt, baseKey }。
  function closeIf(predicate, reason) {
    let closed = 0;
    for (const entry of [...active.values()]) {
      if (!predicate({ serverId: entry.serverId, port: entry.port, localPort: entry.localPort, startedAt: entry.startedAt, baseKey: entry.baseKey })) continue;
      retire(entry, reason);
      closed += 1;
    }
    return closed;
  }

  // 这台服务器上端口已经不在 ports 里的转发收回（调用方保证 ports 是一份列全了的清单）。
  // asOf = 那份清单发出查询的时刻：之后才开的转发不归它判断。
  function reconcile(serverId, ports, asOf = Number.POSITIVE_INFINITY) {
    return closeIf((entry) => entry.serverId === serverId && entry.startedAt <= asOf && !ports.has(entry.port), "gone");
  }

  function list(serverId = null) {
    sweepExpired();
    return [...active.values()]
      .filter((entry) => serverId == null || entry.serverId === serverId)
      .sort((a, b) => (a.serverId === b.serverId ? a.port - b.port : a.serverId < b.serverId ? -1 : 1))
      .map(view);
  }

  // 同一份连接参数算出来的键：配置热载后与 baseKey 对比，判断一条转发指向的是不是还是原来那台。
  function baseKeyFor(server, config) {
    try {
      return JSON.stringify(buildForwardBase(sshArgsFor(server, config), server?.host));
    } catch {
      return null;
    }
  }

  // 退出第一步（同步）：不再接受新的转发，给现有的全部发 SIGTERM。
  function beginShutdown() {
    if (closing) return;
    closing = true;
    for (const entry of [...active.values()]) retire(entry, "shutdown");
    for (const entry of [...launching]) signal(entry, "SIGTERM");
  }

  // 退出第二步：等子进程结束，宽限过后补 SIGKILL。还没退出的留着登记，下次启动按登记清。
  async function dispose() {
    beginShutdown();
    const pending = () => [...dying, ...launching].filter((entry) => !entry.exited);
    if (pending().length) await settleWithin(Promise.all(pending().map((entry) => entry.exitPromise)), timings.disposeGraceMs);
    const stubborn = pending();
    for (const entry of stubborn) signal(entry, "SIGKILL");
    if (stubborn.length) await settleWithin(Promise.all(stubborn.map((entry) => entry.exitPromise)), timings.disposeKillMs);
  }

  // 上次异常退出留下的转发：逐条校验登记，pid 还在且命令行特征对得上才结束；进程不在了 / 对不上只删登记；
  // 校验不了（Windows 上查询命令失败）就原样留着。只应在确认自己是唯一的监控服务之后调用（监听成功之后）——
  // 否则会把另一个还活着的实例的转发当成孤儿。
  async function sweepOrphans() {
    const summary = { stopped: 0, removed: 0, kept: 0 };
    if (!registry || !runtimeDir) return summary;
    const own = new Set([...active.values(), ...launching, ...dying].map((entry) => entry.recordName));
    for (const name of listForwardRecordNames(runtimeDir)) {
      if (own.has(name)) continue;
      try {
        const check = await registry.verifyProcess(name);
        if (check.verified) {
          const result = await registry.stopProcess(name, { forceAfterMs: timings.orphanStopMs, expectedPid: check.meta.pid });
          if (result.stopped) {
            summary.stopped += 1;
            log(`service forward orphan ${name} (pid ${check.meta.pid}) stopped`, { event: "service-forward" });
          } else {
            summary.kept += 1;
            log(`service forward orphan ${name} (pid ${check.meta.pid}) not stopped: ${result.reason}`, { level: "warn", event: "service-forward" });
          }
        } else if (check.indeterminate) {
          summary.kept += 1;
        } else {
          try {
            unlinkSync(path.join(runtimeDir, `${name}.pid.json`));
          } catch {}
          summary.removed += 1;
        }
      } catch {
        summary.kept += 1;
      }
    }
    return summary;
  }

  return { open, close, closeIf, reconcile, list, baseKeyFor, beginShutdown, dispose, sweepOrphans, limit, ttlMs };
}
