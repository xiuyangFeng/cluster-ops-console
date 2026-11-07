// data-plane-upgrade.mjs —— 热更新：数据面（supervisor / 本地代理）零断连交接编排（monitor 侧）。
//
// POST /api/data-plane/upgrade { components: ["supervisor"] | ["proxy"] | ["supervisor","proxy"] }
//   1) 快照隧道 pid（注册表 tunnel / tunnel.<serverId>）与代理 pid；
//   2) supervisor 交接：旧 supervisor 经信箱 handoff-exit（POSIX 另发 SIGUSR2 加速）停循环、
//      不杀子进程、只删自己的记录后退出；等它退出 ≤5s；再用与守护巡检同一条 spawn 路径
//      （当前 process.execPath → 新包代码）拉起新 supervisor，等它完成首拍接管；
//   3) 若要求 proxy：向（新）supervisor 发信箱 proxy-handoff，等结果；
//   4) 再快照隧道 pid；任何一条隧道 pid 变化/消失 → ok=false。
// 串行：同一时刻只允许一次（409）。交接窗口内守护巡检被 hold 住，不会抢先拉起第二个 supervisor。
// 旧版 supervisor（快照未声明 handoffExit）没有交接退出逻辑：一律不动它（见 retireSupervisor），
// 返回 ok=false 说明原因——数据面继续跑旧代码，不以断连为代价强行升级。
//
// 幂等（v2.57）：请求的组件若"运行中指纹 == 磁盘新包指纹"（现读快照 + getBundleComponents，双方都已知）
// 就跳过该组件，全部跳过时 body.noop=true。来由：v2.56.0 热更新后约 30 秒又发生过一次多余的 supervisor
// 交接——/api/build-info 用的是 5s 轮询缓存的快照，控制面刚重启时缓存里还是旧 supervisor，渲染层横幅
// 据此显示"平滑升级守护进程"并保持到下一次 60s 刷新，点一下就把刚换上的新 supervisor 又交接了一遍。
// 这里在服务端兜底（任何过期客户端都挡得住），交接结束后再经 afterSettled 立即刷新快照缓存。
// 指纹未知（""）一律按需要交接处理，与 diffComponents 同一保守口径。

import { randomUUID as nodeRandomUUID } from "node:crypto";
import { readdir as fsReaddir, rm as fsRm } from "node:fs/promises";

import {
  buildControlRequest,
  CONTROL_ACTION_HANDOFF_EXIT,
  CONTROL_ACTION_PROXY_HANDOFF,
  controlDir,
  handoffExitSignature,
  HANDOFF_PROXY_SERVER_ID,
  HANDOFF_SUPERVISOR_SERVER_ID,
  proxyHandoffSignature,
  readControlResult as defaultReadControlResult,
  writeControlRequest as defaultWriteControlRequest,
} from "./supervisor-control.mjs";
import { isPidAlive } from "./process-registry.mjs";
import { verifySnapshotOwnership } from "./runtime-snapshot.mjs";
import { StatusError } from "./status-error.mjs";
import { removeUpgradeMarker, writeUpgradeMarker } from "./upgrade-marker.mjs";

const DATA_PLANE_COMPONENTS = Object.freeze(["supervisor", "proxy"]);

const UPGRADE_TIMEOUTS = Object.freeze({
  oldExitMs: 5000,
  newHealthyMs: 20000,
  proxyHandoffMs: 30000,
  pollMs: 200,
});

// new UpgradeRequestError(status, message)：请求体不合法时的 4xx（见 status-error.mjs）。
export class UpgradeRequestError extends StatusError {}

// 请求体校验：components 必须是 supervisor/proxy 的非空子集（去重、按固定顺序）。
export function normalizeUpgradeComponents(body) {
  const raw = body && typeof body === "object" ? body.components : undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > DATA_PLANE_COMPONENTS.length) {
    throw new UpgradeRequestError(400, 'components 必须是 ["supervisor"] / ["proxy"] / ["supervisor","proxy"]');
  }
  for (const item of raw) {
    if (!DATA_PLANE_COMPONENTS.includes(item)) throw new UpgradeRequestError(400, `未知组件: ${String(item).slice(0, 32)}`);
  }
  return DATA_PLANE_COMPONENTS.filter((name) => raw.includes(name));
}

const TUNNEL_RECORD_RE = /^tunnel(?:\.[\w.-]{1,64})?$/;

export function createDataPlaneUpgrader({
  registry,
  runtimeDir,
  // 现读现判的 supervisor 运行快照：async () => ({ snapshot, stale })。
  readSnapshot,
  // 磁盘新包的数据面组件指纹：async () => ({ supervisor, proxy })；取不到 → null（不做幂等跳过）。
  getBundleComponents = async () => null,
  // 交接结束（成功 / 失败）后调用，用来立即刷新别处的快照缓存；失败吞掉。
  afterSettled = async () => {},
  spawnSupervisor,
  holdAutoRepair = () => () => {},
  // 其它互斥动作在飞（通道重启 / 远端动作 / 单隧道操作）时返回原因字符串，否则 ""。
  isBusy = () => "",
  shouldBeRunning = () => true,
  fixtureMode = false,
  writeControlRequest = defaultWriteControlRequest,
  readControlResult = defaultReadControlResult,
  readdir = fsReaddir,
  removeControlDir = (dir) => fsRm(dir, { recursive: true, force: true }),
  randomUUID = nodeRandomUUID,
  signal = (pid, sig) => process.kill(pid, sig),
  pidAlive = isPidAlive,
  platform = process.platform,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  timeouts = UPGRADE_TIMEOUTS,
  // 在飞标记（runtimeDir/data-plane-upgrade.inflight.json）：Electron 据此拒绝中途重启控制面。
  writeInFlightMarker = (components) => writeUpgradeMarker({ runtimeDir, components }),
  removeInFlightMarker = () => removeUpgradeMarker({ runtimeDir }),
} = {}) {
  const t = { ...UPGRADE_TIMEOUTS, ...(timeouts || {}) };
  let inFlight = false;

  async function snapshotTunnels() {
    let names = [];
    try {
      names = (await readdir(runtimeDir))
        .filter((file) => file.endsWith(".pid.json"))
        .map((file) => file.slice(0, -".pid.json".length))
        .filter((name) => TUNNEL_RECORD_RE.test(name));
    } catch {
      names = [];
    }
    const out = {};
    if (names.length === 0) return out;
    const results = await registry.verifyProcesses(names);
    for (const name of names.sort()) {
      const r = results.get(name);
      // indeterminate（win32 查询失败）保守视为仍在：登记的 pid 就是事实。
      if (r && (r.verified || r.indeterminate) && Number.isInteger(r.meta?.pid)) out[name] = r.meta.pid;
    }
    return out;
  }

  function proxyPid() {
    const meta = registry.readMeta("local-proxy");
    return Number.isInteger(meta?.pid) ? meta.pid : null;
  }

  async function usableSnapshot() {
    try {
      const { snapshot, stale } = await readSnapshot();
      return !stale && verifySnapshotOwnership(snapshot, { registry, pidAlive }) ? snapshot : null;
    } catch {
      return null;
    }
  }

  async function waitPidExit(pid, budgetMs) {
    const deadline = now() + budgetMs;
    while (now() < deadline) {
      if (!pidAlive(pid)) return true;
      await sleep(t.pollMs);
    }
    return !pidAlive(pid);
  }

  async function sendControl(snapshot, action, serverId, targetSignature) {
    const request = buildControlRequest({
      requestId: randomUUID(),
      operationId: randomUUID(),
      instanceId: snapshot.instanceId,
      action,
      serverId,
      targetSignature,
    });
    await writeControlRequest({ runtimeDir, request });
    return request;
  }

  // 旧 supervisor 退场。返回 { ok, detail, name }。
  async function retireSupervisor(snapshot) {
    const meta = registry.readMeta("channel-supervisor");
    const verification = meta ? await registry.verifyProcess("channel-supervisor") : null;
    const running = Boolean(meta && verification && (verification.verified || verification.indeterminate) && pidAlive(meta.pid));
    if (!running) return { name: "supervisor-handoff", ok: true, detail: "no running supervisor to hand off", retired: false };
    const oldPid = meta.pid;
    if (snapshot && snapshot.pid === oldPid && snapshot.capabilities?.handoffExit === true) {
      try {
        await sendControl(snapshot, CONTROL_ACTION_HANDOFF_EXIT, HANDOFF_SUPERVISOR_SERVER_ID, handoffExitSignature(snapshot.instanceId));
      } catch (err) {
        return { name: "supervisor-handoff", ok: false, detail: `mailbox request failed: ${err.message}` };
      }
      if (platform !== "win32") {
        // 能力已由快照声明、身份已由注册表命令行复核：SIGUSR2 只是让它立刻开始退场。
        try {
          signal(oldPid, "SIGUSR2");
        } catch {}
      }
      const exited = await waitPidExit(oldPid, t.oldExitMs);
      // 旧实例已退出：它的信箱目录（含 SIGUSR2 抢先后没来得及认领的请求）不会再有人处理，清掉。
      if (exited) await removeControlDir(controlDir(runtimeDir, snapshot.instanceId)).catch(() => {});
      return exited
        ? { name: "supervisor-handoff", ok: true, detail: `old supervisor pid ${oldPid} exited without touching tunnels/proxy`, retired: true, oldPid }
        : { name: "supervisor-handoff", ok: false, detail: `old supervisor pid ${oldPid} did not exit within ${t.oldExitMs}ms` };
    }
    // 旧版 supervisor（或快照不可用、无法确认能力）：它没有交接退出——SIGTERM 会走 shutdown
    // 杀隧道；SIGKILL 虽能保住子进程，但旧版代理在失去父进程管道后会陷入 EPIPE→
    // uncaughtException→console.error 的热循环（实测 CPU 打满）。两条路都比"保持旧代码继续跑"
    // 更糟，所以拒绝：数据面继续运行旧代码、零扰动，等用户方便时重启一次通道后即可平滑升级。
    return {
      name: "supervisor-handoff",
      ok: false,
      detail: snapshot && snapshot.pid === oldPid
        ? `running supervisor pid ${oldPid} predates hot handoff; left untouched (restart the channel once at a convenient time to enable seamless upgrades)`
        : `cannot confirm handoff capability of supervisor pid ${oldPid} (runtime snapshot unavailable); left untouched`,
      legacy: true,
    };
  }

  async function waitSupervisorHealthy(newPid) {
    const deadline = now() + t.newHealthyMs;
    while (now() < deadline) {
      if (!pidAlive(newPid)) return { ok: false, detail: `new supervisor pid ${newPid} exited during startup` };
      const snapshot = await usableSnapshot();
      if (snapshot && snapshot.pid === newPid) {
        if (Number.isFinite(snapshot.firstTickCompletedAt)) return { ok: true, detail: `new supervisor pid ${newPid} completed its first tick`, snapshot };
        // 不认识 firstTickCompletedAt 的旧代码：快照归属即视为健康（没有更强的证据可等）。
        if (snapshot.capabilities?.handoffExit !== true) return { ok: true, detail: `supervisor pid ${newPid} is up (no first-tick marker)`, snapshot };
      }
      await sleep(t.pollMs);
    }
    return { ok: false, detail: `new supervisor pid ${newPid} not healthy within ${t.newHealthyMs}ms` };
  }

  async function handoffProxy(snapshot) {
    if (snapshot?.capabilities?.proxyHandoff !== true || !Number.isInteger(snapshot.effectiveProxyPort)) {
      return { ok: false, detail: "running supervisor cannot perform a proxy handoff" };
    }
    let request;
    try {
      request = await sendControl(snapshot, CONTROL_ACTION_PROXY_HANDOFF, HANDOFF_PROXY_SERVER_ID, proxyHandoffSignature(snapshot.effectiveProxyPort));
    } catch (err) {
      return { ok: false, detail: `mailbox request failed: ${err.message}` };
    }
    const deadline = now() + t.proxyHandoffMs;
    while (now() < deadline) {
      const result = await readControlResult(runtimeDir, snapshot.instanceId, request.requestId);
      if (result) {
        const evidence = result.evidence && typeof result.evidence === "object" ? result.evidence : {};
        const detail = result.status === "succeeded"
          ? `proxy pid ${evidence.oldPid ?? "?"} -> ${evidence.newPid ?? "?"}; old proxy drains its live connections`
          : `${result.status}: ${result.reason || "unknown"}`;
        return { ok: result.status === "succeeded", detail, evidence };
      }
      await sleep(t.pollMs);
    }
    return { ok: false, detail: `no proxy-handoff result within ${t.proxyHandoffMs}ms` };
  }

  async function bundleComponents() {
    try {
      const value = await getBundleComponents();
      return value && typeof value === "object" ? value : null;
    } catch {
      return null;
    }
  }

  // 运行中的该组件已经是磁盘新包的代码（双方指纹都已知且相等）。快照必须是现读且归属已核实的。
  function alreadyCurrent(snapshot, bundle, name) {
    const running = snapshot?.components?.[name];
    const want = bundle?.[name];
    return typeof running === "string" && running !== "" && running === want;
  }

  async function run(components) {
    const steps = [];
    const beforeTunnels = await snapshotTunnels();
    const beforeProxy = proxyPid();
    let snapshot = await usableSnapshot();
    const bundle = snapshot ? await bundleComponents() : null;
    const supervisorCurrent = components.includes("supervisor") && alreadyCurrent(snapshot, bundle, "supervisor");
    const proxyCurrent = components.includes("proxy") && alreadyCurrent(snapshot, bundle, "proxy");
    const wantSupervisor = components.includes("supervisor") && !supervisorCurrent;
    const wantProxy = components.includes("proxy") && !proxyCurrent;
    // 只升级代理但当前 supervisor 不会做代理交接（旧版本）→ 先换 supervisor。
    const needSupervisor = wantSupervisor || (wantProxy && snapshot?.capabilities?.proxyHandoff !== true);
    if (supervisorCurrent && !needSupervisor) {
      steps.push({ name: "supervisor-handoff", ok: true, skipped: true, detail: `running supervisor pid ${snapshot.pid} already runs the bundle code (${bundle.supervisor}); no handoff needed` });
    }
    let aborted = false;

    if (needSupervisor) {
      const retired = await retireSupervisor(snapshot);
      steps.push({ name: retired.name, ok: retired.ok, detail: retired.detail });
      if (!retired.ok) {
        aborted = true;
      } else if (!retired.retired && !shouldBeRunning()) {
        steps.push({ name: "supervisor-start", ok: true, detail: "channel is stopped by the user; not starting a supervisor" });
        snapshot = null;
      } else if (!shouldBeRunning()) {
        // 旧实例退场期间用户点了停止（或停止先于交接落地）：此刻再拉起就会覆盖用户意图。
        // 旧 supervisor 已按交接路径退出、隧道/代理保持原样，由停止流程接手清理。
        steps.push({ name: "stopped-by-user", ok: false, detail: "channel was stopped by the user during the upgrade; not starting a new supervisor" });
        aborted = true;
        snapshot = null;
      } else {
        let spawned = null;
        try {
          spawned = await spawnSupervisor();
        } catch (err) {
          steps.push({ name: "supervisor-start", ok: false, detail: `spawn failed: ${err.message}` });
          aborted = true;
        }
        if (spawned) {
          if (!Number.isInteger(spawned.pid)) {
            steps.push({ name: "supervisor-start", ok: false, detail: "spawn returned no pid" });
            aborted = true;
          } else {
            steps.push({ name: "supervisor-start", ok: true, detail: `spawned supervisor pid ${spawned.pid} (${process.execPath})` });
            const healthy = await waitSupervisorHealthy(spawned.pid);
            steps.push({ name: "supervisor-healthy", ok: healthy.ok, detail: healthy.detail });
            if (healthy.ok) snapshot = healthy.snapshot;
            else aborted = true;
          }
        }
      }
    }

    if (proxyCurrent) {
      steps.push({ name: "proxy-handoff", ok: true, skipped: true, detail: `running local proxy already runs the bundle code (${bundle.proxy}); no handoff needed` });
    } else if (wantProxy) {
      if (aborted) {
        steps.push({ name: "proxy-handoff", ok: false, detail: "skipped: supervisor step failed" });
      } else {
        const result = await handoffProxy(snapshot);
        steps.push({ name: "proxy-handoff", ok: result.ok, detail: result.detail });
      }
    }

    const afterTunnels = await snapshotTunnels();
    const afterProxy = proxyPid();
    const changed = Object.keys(beforeTunnels).filter((name) => afterTunnels[name] !== beforeTunnels[name]);
    // 交接前一条隧道都没有：没有东西可比，不能写成"N 条保持 pid"（会被读成隧道未中断）。
    // 交接本身没有停隧道，所以 ok 仍为 true，但 detail 如实说明无法核对。
    const nothingToCompare = Object.keys(beforeTunnels).length === 0;
    steps.push({
      name: "tunnels-unchanged",
      ok: changed.length === 0,
      detail: nothingToCompare
        ? "no running tunnels before the handoff; continuity could not be verified"
        : changed.length === 0
          ? `${Object.keys(beforeTunnels).length} tunnel(s) kept their pids`
          : `tunnel pid changed or disappeared: ${changed.join(", ")}`,
    });
    return {
      ok: steps.every((step) => step.ok),
      // 请求的组件全部已是新包代码：什么都没动（前端据此提示"已是最新"而不是"已完成升级"）。
      ...(!wantSupervisor && !wantProxy ? { noop: true } : {}),
      steps,
      tunnels: { before: beforeTunnels, after: afterTunnels },
      proxy: { beforePid: beforeProxy, afterPid: afterProxy },
    };
  }

  // 返回 { status, body }：200（含 ok=false 的业务失败）/ 400 / 409。
  async function upgrade(body) {
    let components;
    try {
      components = normalizeUpgradeComponents(body);
    } catch (err) {
      return { status: err.status || 400, body: { error: err.message } };
    }
    if (fixtureMode) return { status: 409, body: { error: "fixture mode: process mutation disabled" } };
    if (inFlight) return { status: 409, body: { error: "another data-plane upgrade is in progress" } };
    let busy = "";
    try {
      busy = isBusy() || "";
    } catch {}
    if (busy) return { status: 409, body: { error: busy } };
    inFlight = true;
    const release = holdAutoRepair();
    try {
      writeInFlightMarker(components);
    } catch {}
    log(`data-plane upgrade started: ${components.join(",")}`, { event: "data-plane-upgrade" });
    try {
      const result = await run(components);
      const verdict = result.noop ? "not needed (already running the bundle code)" : result.ok ? "succeeded" : "failed";
      log(`data-plane upgrade ${verdict}: ${result.steps.map((s) => `${s.name}=${s.skipped ? "skipped" : s.ok ? "ok" : "fail"}`).join(" ")}`, {
        event: "data-plane-upgrade",
        level: result.ok ? "info" : "warn",
      });
      return { status: 200, body: result };
    } finally {
      try {
        removeInFlightMarker();
      } catch {}
      // 先刷新快照缓存再放开互斥：响应返回时 /api/build-info 已经看到新 supervisor。
      try {
        await afterSettled();
      } catch {}
      release();
      inFlight = false;
    }
  }

  return { upgrade, isInFlight: () => inFlight };
}
