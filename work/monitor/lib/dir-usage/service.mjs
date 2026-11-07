// 本人目录占用服务：只在用户手动点击时扫描（没有任何定时扫描），结果累加进本机存储。
// 每一轮都是有界的（≤ 2 万条目 / 8 秒）。点一次只扫一轮的话，文件多的家目录要点上百次——
// 所以点击后由这里一轮接一轮自动续扫（startAuto），直到扫完、出错、被停止或到时长上限；
// 轮与轮之间让出 SSH 槽位。界面关着、窗口切走都不影响；工作台重启后不会自己接着扫（游标还在，点「继续」）。
//
// 范围：团队配置里的服务器（source !== "personal"），且未禁用 / 未关监控——与用量、作业同一采集范围。
// 个人服务器（腾讯云 / 阿里云）不提供：那是自己独占的机器，du 即可；这里解决的是共享卷快满时
// 「我自己占了多少」的问题。
// SSH 走调度器的全局槽位（acquireSshSlot，并发上限 3）；同一台服务器同一时刻只允许一轮扫描。

import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { buildDirUsageView, mergeDirUsageRun } from "./model.mjs";
import { buildDirUsageInvocation, DIR_USAGE_ERROR_TEXT, isValidRelPath, parseDirUsageOutput } from "./scan.mjs";

// 用户可选的扫描根（相对 $HOME）比游标更严：长度 ≤ 1024。
const MAX_ROOT_LENGTH = 1024;
// 自动续扫：两轮之间歇一会儿（探针与别的 SSH 得以插进来）；连续扫这么久还没完就先停下，等人再点。
export const DIR_USAGE_AUTO_GAP_MS = 2000;
export const DIR_USAGE_AUTO_MAX_MS = 3 * 60 * 60 * 1000;

export function isDirUsageEligible(server) {
  return Boolean(server) && server.disabled !== true && server.monitorEnabled !== false && server.source !== "personal";
}

const fail = (message, status) => Object.assign(new Error(message), { status });

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export function createDirUsageService({ store, getConfig, dataDir, execCollector, probeSshFailureReason, log = null, now = Date.now, sleep = defaultSleep }) {
  const running = new Set();
  // 自动续扫的现状，每台服务器一份：{ root, running, stopping, rounds, startedAt, endedAt, reason, error }。
  // reason：done（扫完）| stopped（被停止）| limit（到时长上限）| error。只在内存里，重启即清空。
  const autoRuns = new Map();

  async function findServer(serverId) {
    const config = await getConfig();
    const server = (config?.servers || []).find((s) => s.id === serverId) || null;
    return { config, server };
  }

  // 读本机已存结果（不发 SSH）。root 缺省 → 该服务器最近一次扫描的根。
  async function get(serverId, root = null) {
    const { server } = await findServer(serverId);
    if (!isDirUsageEligible(server)) return { eligible: false, serverId };
    if (root != null && !isValidRelPath(root, MAX_ROOT_LENGTH)) throw fail("扫描路径无效", 400);
    const saved = await store.list(serverId);
    const pick = root ?? saved[0]?.root ?? "";
    const record = await store.get(serverId, pick);
    return { eligible: true, serverId, root: pick, running: running.has(serverId), auto: autoView(serverId), saved, scan: buildDirUsageView(record) };
  }

  function autoView(serverId) {
    const run = autoRuns.get(serverId);
    return run ? { ...run } : null;
  }

  // mode: "start"（从头扫描该根，替换旧结果）| "continue"（从游标接着扫）。
  async function scan(serverId, { root = "", mode = "start" } = {}, { acquireSshSlot } = {}) {
    if (!["start", "continue"].includes(mode)) throw fail("扫描方式无效", 400);
    if (!isValidRelPath(root, MAX_ROOT_LENGTH)) throw fail("扫描路径无效", 400);
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    const { config, server } = await findServer(serverId);
    if (!isDirUsageEligible(server)) throw fail("该服务器不提供目录占用扫描", 404);
    if (running.has(serverId)) throw fail("这台服务器正在扫描，请稍候", 409);
    running.add(serverId);
    try {
      const prev = await store.get(serverId, root);
      if (mode === "continue" && (!prev || prev.complete || !prev.pending.length)) throw fail("没有可继续的扫描", 409);
      const invocation = buildDirUsageInvocation({
        server,
        parsed: config,
        knownHostsPath: resolveKnownHostsIfPresent(dataDir, server.id),
        root,
        pending: mode === "continue" ? prev.pending : null,
      });
      const release = await acquireSshSlot({ hostKey: server.host });
      let res;
      try {
        res = await execCollector(invocation, server);
      } finally {
        release();
      }
      const parsed = parseDirUsageOutput(res?.stdout, { expectRoot: root });
      if (!parsed.ok) {
        const stderr = res?.stderr || "";
        let reason;
        if (/python3: (command )?not found/.test(stderr)) reason = "服务器上没有 python3，无法扫描";
        else if (DIR_USAGE_ERROR_TEXT[parsed.code]) reason = DIR_USAGE_ERROR_TEXT[parsed.code];
        else if (res?.timedOut) reason = "扫描超时（SSH 未在 25 秒内返回）";
        else reason = `扫描失败 (${probeSshFailureReason(res?.code ?? null, stderr, res?.stdout ?? "")})`;
        log?.(`dir-usage scan failed on ${server.id}: ${reason}`, { level: "warn", event: "dir-usage" });
        // 游标不动：失败的一轮不影响已存结果，可以再点一次。
        throw fail(reason, 502);
      }
      const record = mergeDirUsageRun(mode === "continue" ? prev : null, parsed.run, { now: now() });
      await store.put(serverId, record);
      log?.(`dir-usage scan on ${server.id}: root=${root ? "~/<子目录>" : "~"} entries=${parsed.run.entries} sec=${parsed.run.sec} complete=${parsed.run.complete}`, { level: "info", event: "dir-usage" });
      return { eligible: true, serverId, root, running: false, auto: autoView(serverId), saved: await store.list(serverId), scan: buildDirUsageView(record) };
    } finally {
      running.delete(serverId);
    }
  }

  // 自动续扫：校验后立刻返回，扫描在后台一轮接一轮进行；进度看 get()（界面轮询它）。
  // 参数错 / 服务器不提供 / 已有扫描在跑，在这里就抛；之后某一轮失败则停下并把原因记在 auto.error。
  async function startAuto(serverId, { root = "", mode = "start" } = {}, deps = {}) {
    if (!["start", "continue"].includes(mode)) throw fail("扫描方式无效", 400);
    if (!isValidRelPath(root, MAX_ROOT_LENGTH)) throw fail("扫描路径无效", 400);
    if (typeof deps.acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    const { server } = await findServer(serverId);
    if (!isDirUsageEligible(server)) throw fail("该服务器不提供目录占用扫描", 404);
    if (autoRuns.get(serverId)?.running || running.has(serverId)) throw fail("这台服务器正在扫描，请稍候", 409);
    if (mode === "continue") {
      const prev = await store.get(serverId, root);
      if (!prev || prev.complete || !prev.pending.length) throw fail("没有可继续的扫描", 409);
    }
    const run = { root, running: true, stopping: false, rounds: 0, startedAt: now(), endedAt: null, reason: null, error: null };
    autoRuns.set(serverId, run);
    runAuto(serverId, run, mode, deps);
    return get(serverId, root);
  }

  async function runAuto(serverId, run, firstMode, deps) {
    let mode = firstMode;
    try {
      for (;;) {
        const res = await scan(serverId, { root: run.root, mode }, deps);
        run.rounds += 1;
        if (res.scan?.complete) {
          run.reason = "done";
          break;
        }
        if (run.stopping) {
          run.reason = "stopped";
          break;
        }
        if (now() - run.startedAt >= DIR_USAGE_AUTO_MAX_MS) {
          run.reason = "limit";
          break;
        }
        mode = "continue";
        await sleep(DIR_USAGE_AUTO_GAP_MS);
        if (run.stopping) {
          run.reason = "stopped";
          break;
        }
      }
    } catch (error) {
      run.reason = "error";
      run.error = String(error?.message || error).slice(0, 300);
    } finally {
      run.running = false;
      run.stopping = false;
      run.endedAt = now();
      log?.(`dir-usage auto scan on ${serverId} ended: ${run.reason} after ${run.rounds} round(s)`, { level: run.reason === "error" ? "warn" : "info", event: "dir-usage" });
    }
  }

  // 停止自动续扫：正在跑的这一轮（≤ 8 秒）照常做完并入库，然后不再发下一轮。
  async function stopAuto(serverId) {
    const run = autoRuns.get(serverId);
    if (run?.running) run.stopping = true;
    return get(serverId, run?.root ?? null);
  }

  // 这台服务器现在有没有扫描在跑（单轮或自动续扫）。磁盘增长归因的定时测量据此让路（lib/disk-growth/service.mjs）。
  const isScanning = (serverId) => running.has(serverId) || autoRuns.get(serverId)?.running === true;

  return { get, scan, startAuto, stopAuto, isScanning };
}
