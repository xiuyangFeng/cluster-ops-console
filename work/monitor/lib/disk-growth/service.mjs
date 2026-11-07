// 磁盘增长归因服务：按作业登记找出「集合目录」，定时量它们各个直接子目录的大小，结果存本机。
// 磁盘事件详情、目录占用面板顶部的「作业产出目录」与简报的磁盘提示都读这里。
//
// 调度（不注册探针：探针 id 在数据面的指纹闭包里；像目录占用的自动续扫那样由服务自己按时间表发起）：
//   - start() 之后每 5 分钟看一次：某台团队服务器距上次量完满 6 小时就量；磁盘占用比上次量完时涨了
//     ≥ 1 个百分点（且距上次满 1 小时）提前量；没量成的 30 分钟后再试。同一时刻只量一台。
//   - 只在这台服务器的资源采样够新时才定时发起（采样旧 = 连不上或刚启动，量也是白发 SSH）。
//   - 设置页关掉「我的 Slurm 作业」就不量；个人服务器不量（与目录占用同一范围）。
//   - fixture 模式（冒烟 / 界面预览）由装配处调 disable()：不定时量，按需的也不量，一条 SSH 都不发。
// 一次测量：
//   探家目录（只在不知道时，1 次 SSH）→ 从登记表推集合目录（本机）→ 逐个集合目录一轮接一轮扫
//   （每轮一次 SSH：远端自限 2 万条目 / 8 秒，本机 20 秒超时），轮与轮之间歇 2 秒并让出槽位；
//   从开始算满 10 分钟还没量完就停下，如实标「未量完」。用户正在扫目录占用时等它扫完，不同时压同一块盘。
// SSH 一律经调度器的全局槽位（acquireSshSlot，并发上限 3）。全程只读，不改、不删服务器上的任何东西。

import { mergeDirUsageRun } from "../dir-usage/model.mjs";
import { DIR_USAGE_ERROR_TEXT, parseDirUsageOutput } from "../dir-usage/scan.mjs";
import { isDirUsageEligible } from "../dir-usage/service.mjs";
import { resolveKnownHostsIfPresent } from "../host-key-policy.mjs";
import { isDataModuleEnabled } from "../modules/catalog.mjs";
import { COLLECTION_MIN_CHILDREN, deriveCollectionDirs } from "./collections.mjs";
import { buildDiskGrowthView, buildSummary, diskOf, dueReason, summarizeScan } from "./model.mjs";
import { buildHomeProbeInvocation, buildMeasureInvocation, parseHomeProbe } from "./scan.mjs";

export const DISK_GROWTH_TICK_MS = 5 * 60_000;
// 启动后先等一会儿：登记表、资源采样、别的探针的首轮都排在前面。
export const DISK_GROWTH_FIRST_TICK_MS = 2 * 60_000;
export const DISK_GROWTH_GAP_MS = 2000;
export const DISK_GROWTH_MAX_MS = 10 * 60_000;
// 定时发起的门槛：资源采样不超过这么旧。
export const DISK_GROWTH_SAMPLE_FRESH_MS = 5 * 60_000;
// 记进测量的整盘用量最多这么旧（更旧就不记，占比那一项不显示）。
export const DISK_GROWTH_DISK_STALE_MS = 15 * 60_000;
// 家目录探一次就一直用；只有它推不出任何集合目录、且距上次探满一周时才重探。
export const DISK_GROWTH_HOME_RECHECK_MS = 7 * 24 * 3600_000;

export const isDiskGrowthEligible = isDirUsageEligible;

const fail = (message, status) => Object.assign(new Error(message), { status });
const EMPTY_OTHER = [0, 0, 0, 0];

const defaultSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

export function createDiskGrowthService({
  store,
  registry,
  getConfig,
  dataDir,
  execCollector,
  probeSshFailureReason,
  // 用户是否正在这台服务器上扫目录占用（lib/dir-usage/service.mjs 的 isScanning）。
  isDirUsageBusy = () => false,
  log = null,
  now = Date.now,
  sleep = defaultSleep,
}) {
  // 进行中的测量，每台服务器至多一份：{ trigger, startedAt, rounds（发过几次 SSH）, entries（扫过的条目数）, rootIndex, rootCount, stopping, done }。
  const runs = new Map();
  // start() 给的：定时测量用的 SSH 槽位与整盘用量。
  let scheduled = { acquireSshSlot: null, getFilesystem: null };
  let firstTimer = null;
  let timer = null;
  let stopped = false;
  // 整个停用的原因（fixture 模式，见 disable）；null = 正常。
  let disabled = null;

  async function findServer(serverId) {
    const config = await getConfig();
    const server = (config?.servers || []).find((s) => s.id === serverId) || null;
    return { config, server };
  }

  // 这台服务器的整盘用量（资源采集的最新一份）；比 maxAgeMs 旧 → null。
  function filesystemOf(serverId, maxAgeMs) {
    let fs = null;
    try {
      fs = scheduled.getFilesystem?.(serverId) ?? null;
    } catch {}
    if (!fs || !Number.isFinite(fs.checkedAt) || now() - fs.checkedAt > maxAgeMs) return null;
    return fs;
  }

  function runView(serverId) {
    const run = runs.get(serverId);
    return run ? { trigger: run.trigger, startedAt: run.startedAt, rounds: run.rounds, rootIndex: run.rootIndex, rootCount: run.rootCount } : null;
  }

  // 读本机已存结果（不发 SSH）。
  async function get(serverId) {
    const { config, server } = await findServer(serverId);
    if (!isDiskGrowthEligible(server)) return { eligible: false, serverId };
    if (!isDataModuleEnabled(config, "jobs")) return { eligible: true, serverId, disabled: true };
    const growth = buildDiskGrowthView(await store.get(serverId), { errorText: DIR_USAGE_ERROR_TEXT });
    return { eligible: true, serverId, running: runs.has(serverId), run: runView(serverId), growth };
  }

  // 磁盘事件详情与简报用的一句话事实（见 model.mjs buildSummary）；不在范围、模块关着、没有可比的测量 → null。
  async function summaryFor(serverId) {
    const { config, server } = await findServer(serverId);
    if (!isDiskGrowthEligible(server) || !isDataModuleEnabled(config, "jobs")) return null;
    return buildSummary(await store.get(serverId), { nowMs: now() });
  }

  function failureReason(res) {
    const stderr = res?.stderr || "";
    if (/python3: (command )?not found/.test(stderr)) return "服务器上没有 python3，量不了";
    if (res?.timedOut) return "SSH 在 20 秒内没有返回";
    return `SSH 没有成功 (${probeSshFailureReason(res?.code ?? null, stderr, res?.stdout ?? "")})`;
  }

  // 一次测量。结果只经 store 与日志出去，本函数不抛错。结束时写一条运维日志（不含目录名）：结果、轮数、
  // 扫过的条目数与用时——量不完的集群上，这几个数就是判断「10 分钟够不够」的依据。
  async function measure(serverId, run, acquireSshSlot) {
    const deadline = run.startedAt + DISK_GROWTH_MAX_MS;
    let attempt = { outcome: "error", error: null };
    let rootCount = 0;
    try {
      const { config, server } = await findServer(serverId);
      if (!isDiskGrowthEligible(server) || !isDataModuleEnabled(config, "jobs")) throw fail("这台服务器不在测量范围");
      const knownHostsPath = resolveKnownHostsIfPresent(dataDir, server.id);
      // 每次 SSH 之前：轮与轮之间歇 2 秒；用户在扫目录占用就等；到时限 / 被停止 / 中途关了模块或停用了服务器就不再发。
      const ssh = async (invocation) => {
        if (run.rounds > 0) await sleep(DISK_GROWTH_GAP_MS);
        while (isDirUsageBusy(serverId) && !run.stopping && now() < deadline) await sleep(DISK_GROWTH_GAP_MS);
        if (run.rounds > 0) {
          const current = await findServer(serverId);
          if (!isDiskGrowthEligible(current.server) || !isDataModuleEnabled(current.config, "jobs")) run.stopping = true;
        }
        if (run.stopping) return { halt: "stopped" };
        if (now() >= deadline) return { halt: "deadline" };
        const release = await acquireSshSlot({ hostKey: server.host });
        try {
          // 排队等槽位也算在时限里。
          if (run.stopping) return { halt: "stopped" };
          if (now() >= deadline) return { halt: "deadline" };
          run.rounds += 1;
          return { res: await execCollector(invocation, server) };
        } catch (error) {
          return { res: { code: null, stdout: "", stderr: String(error?.message || error) } };
        } finally {
          release();
        }
      };

      await registry.load();
      const entries = registry.list(serverId);
      let { home = null, homeEnv = null, homeAt = null } = (await store.get(serverId)) || {};
      const probeHome = async () => {
        const { res, halt } = await ssh(buildHomeProbeInvocation({ server, parsed: config, knownHostsPath }));
        if (halt) throw fail(halt === "stopped" ? "已停止" : "没轮到就到时限了");
        const answer = parseHomeProbe(res?.stdout);
        if (!answer) throw fail(`读不到家目录：${failureReason(res)}`);
        ({ home, homeEnv } = answer);
        homeAt = now();
        await store.update(serverId, (draft) => Object.assign(draft, { home, homeEnv, homeAt }));
      };
      const derive = () => (home ? deriveCollectionDirs(entries, { homes: [home, homeEnv].filter(Boolean), nowMs: now() }) : []);
      // 登记的作业不足 3 个时凑不出集合目录，连家目录都不必探。
      const enough = entries.length >= COLLECTION_MIN_CHILDREN;
      if (!home && enough) await probeHome();
      let found = derive();
      // 记着的家目录推不出任何集合目录，而且已经是一周前探的：可能是家目录挪过地方（登记的路径已经是新的），重探一次再推。
      if (!found.length && enough && now() - (homeAt ?? 0) >= DISK_GROWTH_HOME_RECHECK_MS) {
        await probeHome();
        found = derive();
      }
      rootCount = found.length;
      run.rootCount = found.length;
      await store.update(serverId, (draft) => { draft.roots = found.map(({ root, jobs }) => ({ root, jobs })); });
      if (!found.length) {
        attempt = { outcome: "no-roots", error: null };
        return;
      }

      const results = [];
      let stop = null;
      let error = null;
      for (const [index, item] of found.entries()) {
        run.rootIndex = index;
        const base = { root: item.root, jobs: item.jobs };
        if (stop) {
          results.push({ ...base, at: now(), state: "skipped", error: null, c: [], o: EMPTY_OTHER });
          continue;
        }
        let record = null;
        let pending = null;
        let refused = null;
        const truncated = new Set();
        for (;;) {
          const { res, halt } = await ssh(buildMeasureInvocation({ server, parsed: config, knownHostsPath, root: item.root, pending }));
          const parsed = halt ? null : parseDirUsageOutput(res?.stdout, { expectRoot: item.root });
          if (parsed?.ok) {
            // 扫描器的待扫列表放不下、丢了子目录：这一轮碰过的一级子目录数字偏小，记下来按没量完算。
            if (parsed.run.dropped > 0) for (const name of Object.keys(parsed.run.agg1)) truncated.add(name);
            run.entries += parsed.run.entries;
            record = mergeDirUsageRun(record, parsed.run, { now: now() });
            // 家目录挪过地方：下一次测量按新的重新推集合目录。
            if (parsed.run.home !== home) {
              home = parsed.run.home;
              homeAt = now();
              await store.update(serverId, (draft) => Object.assign(draft, { home, homeEnv: null, homeAt }));
            }
            if (parsed.run.complete) break;
            pending = parsed.run.pending;
            continue;
          }
          if (parsed && Object.hasOwn(DIR_USAGE_ERROR_TEXT, parsed.code)) {
            // 远端不肯扫这个目录（不存在了 / 路径上有符号链接 / 在另一个文件系统）：记下原因，接着量下一个。
            refused = parsed.code;
            break;
          }
          // 到时限、被停止、SSH 失败、输出读不懂：这次测量到此为止，已经量到的照实记成没量完。
          stop = halt || "error";
          if (!halt) error = failureReason(res);
          break;
        }
        if (record) {
          const summary = summarizeScan(record, { truncated });
          results.push({ ...base, at: now(), state: summary.complete ? "ok" : "partial", error: null, c: summary.c, o: summary.o });
        } else {
          results.push({ ...base, at: now(), state: refused ? "error" : "skipped", error: refused, c: [], o: EMPTY_OTHER });
        }
      }

      if (stop === "stopped") {
        attempt = null; // 工作台正在退出，或中途关了模块 / 停用了服务器：什么都不记，之后按时间表重来
        return;
      }
      if (!results.some((item) => item.state === "ok" || item.state === "partial")) {
        const refusal = results.find((item) => item.error)?.error;
        attempt = { outcome: "error", error: error || (refusal ? `集合目录量不了：${DIR_USAGE_ERROR_TEXT[refusal]}` : "没轮到就到时限了") };
        return;
      }
      const complete = results.every((item) => item.state === "ok");
      const measurement = {
        at: now(),
        startedAt: run.startedAt,
        trigger: run.trigger,
        complete,
        stop: complete ? null : stop,
        rounds: run.rounds,
        disk: diskOf(filesystemOf(serverId, DISK_GROWTH_DISK_STALE_MS)),
        roots: results,
      };
      await store.update(serverId, (draft) => { draft.measurements.push(measurement); });
      attempt = { outcome: complete ? "ok" : "partial", error };
    } catch (err) {
      attempt = run.stopping ? null : { outcome: "error", error: String(err?.message || err).slice(0, 300) };
    } finally {
      if (attempt) {
        const at = now();
        await store.update(serverId, (draft) => { draft.attempt = { at, ...attempt }; }).catch(() => {});
        log?.(
          `disk growth on ${serverId}: ${attempt.outcome} trigger=${run.trigger} roots=${rootCount} rounds=${run.rounds} entries=${run.entries} sec=${Math.round((at - run.startedAt) / 1000)}${attempt.error ? ` (${attempt.error})` : ""}`,
          { level: attempt.outcome === "error" ? "warn" : "info", event: "disk-growth" },
        );
      }
      runs.delete(serverId);
    }
  }

  function begin(serverId, trigger, acquireSshSlot) {
    const run = { trigger, startedAt: now(), rounds: 0, entries: 0, rootIndex: 0, rootCount: 0, stopping: false, done: null };
    runs.set(serverId, run);
    run.done = measure(serverId, run, acquireSshSlot);
    return run;
  }

  // 按需量一次（界面上的「现在量一次」）：校验后立刻返回，测量在后台进行；进度与结果看 get()。
  async function scanNow(serverId, { acquireSshSlot = scheduled.acquireSshSlot } = {}) {
    if (disabled) throw fail(disabled, 409);
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    const { config, server } = await findServer(serverId);
    if (!isDiskGrowthEligible(server)) throw fail("这台服务器不量作业产出目录（只对团队集群开放）", 404);
    if (!isDataModuleEnabled(config, "jobs")) throw fail("「我的 Slurm 作业」模块已关闭，打开后才会量", 409);
    if (stopped) throw fail("工作台正在退出", 503);
    if (runs.has(serverId)) throw fail("这台服务器正在量，请稍候", 409);
    if (isDirUsageBusy(serverId)) throw fail("这台服务器正在扫描目录占用，等它结束再量", 409);
    begin(serverId, "manual", acquireSshSlot);
    return get(serverId);
  }

  // 定时检查：到点的服务器发起一次测量（一次只量一台，其余等下一拍）。
  async function tick() {
    if (disabled || stopped || runs.size || typeof scheduled.acquireSshSlot !== "function") return null;
    const config = await getConfig();
    if (!isDataModuleEnabled(config, "jobs")) return null;
    for (const server of (config?.servers || []).filter(isDiskGrowthEligible)) {
      if (isDirUsageBusy(server.id)) continue;
      const filesystem = filesystemOf(server.id, DISK_GROWTH_SAMPLE_FRESH_MS);
      if (!filesystem) continue;
      const entry = await store.get(server.id);
      const latest = entry?.measurements.at(-1) ?? null;
      const attempt = entry?.attempt ?? null;
      const settledAt = attempt && attempt.outcome !== "error" ? attempt.at : null;
      const reason = dueReason({
        nowMs: now(),
        lastAt: latest || settledAt != null ? Math.max(latest?.at ?? 0, settledAt ?? 0) : null,
        lastDisk: latest?.disk ?? null,
        disk: diskOf(filesystem),
        failedAt: attempt?.outcome === "error" ? attempt.at : null,
      });
      if (!reason || stopped || runs.size) continue;
      begin(server.id, reason, scheduled.acquireSshSlot);
      return server.id;
    }
    return null;
  }

  // acquireSshSlot：调度器的全局槽位；getFilesystem(serverId) → 资源采集最新的 { usedBytes, totalBytes, usedPct, checkedAt } | null。
  function start({ acquireSshSlot, getFilesystem = null, firstTickMs = DISK_GROWTH_FIRST_TICK_MS, tickMs = DISK_GROWTH_TICK_MS } = {}) {
    if (disabled) return;
    scheduled = { acquireSshSlot, getFilesystem };
    stopped = false;
    clearTimeout(firstTimer);
    clearInterval(timer);
    const run = () => tick().catch((err) => log?.(`disk growth tick failed: ${err.message}`, { level: "warn", event: "disk-growth" }));
    firstTimer = setTimeout(run, firstTickMs);
    firstTimer.unref?.();
    timer = setInterval(run, tickMs);
    timer.unref?.();
  }

  // 退出：不再发起新的测量；进行中的那次发完手上这一轮就停，不落盘。
  function stop() {
    stopped = true;
    clearTimeout(firstTimer);
    clearInterval(timer);
    for (const run of runs.values()) run.stopping = true;
  }

  // 整个停用：不定时量，「现在量一次」回 409，之后 start() 也不生效——任何路径都不再发 SSH；已存的结果照常可读。
  // fixture 模式（冒烟 / 界面预览用的隔离监控服务）用它：那里的服务器条目可能就是真实主机，点到按钮也不能连出去。
  function disable(reason) {
    disabled = String(reason || "已停用");
    stop();
  }

  return {
    get,
    summaryFor,
    scanNow,
    tick,
    start,
    stop,
    disable,
    // 等进行中的测量结束（测试用）。
    idle: () => Promise.allSettled([...runs.values()].map((run) => run.done)),
    flush: () => store.flush(),
  };
}
