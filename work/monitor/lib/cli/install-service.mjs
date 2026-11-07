// CLI 服务（第 2 期 P-D）：/api/cli 的业务层——概览（已装状态 + 最新版 + 当前任务）、安装 / 更新任务、
// 任务进度、回滚。流程本体在 ./install.mjs，这里负责：
//   - 目标服务器：只对活跃的团队服务器（与远端守护进程同一口径：未禁用、未关监控、不是个人服务器）；
//     请求带 serverId 时必须等于活跃服务器（切服瞬间 409），防止动作打到另一台。
//   - 互斥：每台服务器同一时刻一个任务（./task-lock.mjs，登录 P-E 共用同一个实例）。
//   - 取消（cancelJob，v2.57 后续）：给流程发取消信号并等它收尾（结束集群上的官方任务 / 停下载 / 杀上传并清
//     半截文件，见 ./install.mjs 文件头第 5 条），收尾完锁才释放、接口才返回；落盘 / 切软链期间 409 不可取消。
//     没有这个入口时，卡住的任务最长占锁 3 小时，期间同一台服务器的登录 / 回滚全部 409。
//   - 执行器：远端命令经探针同一套 SSH 参数与执行入口（execCollector，凭证注入、钉住的 known_hosts），
//     占调度器的全局 SSH 槽位；上传是一条长连接，不占槽位（几分钟占着 3 个槽之一会拖慢监控），也不经
//     凭证执行器——密码连接的服务器只走官方路径，回退上传不可用并提前说明（见 PASSWORD_UPLOAD_TEXT）。
//   - 本机下载缓存：<dataDir>/cli-downloads/，成功后删除，取消时也删除（成品与 .part 都不留）；
//     失败留下 .part 供续传，3 天没动的清掉。
//   - 已装状态：来自 `cli:<serverId>` 探测服务的快照（./service.mjs 的 getSnapshot，经 runtime.getCliState 传入，
//     形状 { serverId, checkedAt, clis }；某轮 SSH 失败时快照保留上一份，不会被当成「未安装」）。本服务在安装 /
//     回滚后知道的更新结果作为覆盖层（探测下一轮跑完之前界面就显示新版本）。
//   - 任务结束后 runtime.onCliChanged(serverId, { cli, ok }) 通知装配处刷新（./refresh.mjs：重测 CLI，
//     成功时再补跑 doctor / claude-code 适配器探针）。
//   - updateAvailable 用 catalog 的 compareVersions（经 isUpdateAvailable），与探测 / 向导同一口径。
//   - 团队缓存（v2.89，./team-cache.mjs）：安装任务带上团队共享目录（与团队管理同一个 hubDir），预检顺带列出缓存、
//     能用就集群内拷贝。teamCache() 给界面列出缓存里有哪些版本（60 秒内复用上一次结果）；startPublish() 让
//     管理员（adminUsers）把官方产物发布进缓存（./publish.mjs），与安装共用任务表、锁、取消与进度接口。
//   - 测试对话（v2.89，./smoke-test.mjs）：smokeTest() 在集群上真的发一条很短的请求，占同一把任务锁（kind=smoke）。
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { CLI_IDS, compareVersions, getCli, isCliId, isUpdateAvailable } from "./catalog.mjs";
import { cleanupArtifact, downloadArtifact, hasZstd, sha256OfText } from "./download.mjs";
import { cancelBlockReason, createJobState, runInstallJob, runRollback, uploadViaSsh } from "./install.mjs";
import { contentLength, fetchJson, fetchText, openHttps } from "./net.mjs";
import { isRollbackTarget } from "./remote-scripts.mjs";
import {
  claudePlatformFor,
  codexTargetFor,
  resolveClaudeArtifact,
  resolveCodexArtifact,
  resolveOfficialLatest,
  resolveOfficialSizes,
} from "./sources.mjs";
import { isCliEligible } from "./service.mjs";
import { buildSmokeTestCommand, parseSmokeTest, SMOKE_SSH_TIMEOUT_MS } from "./smoke-test.mjs";
import { createCliTaskLock } from "./task-lock.mjs";
import { runPublishJob } from "./publish.mjs";
import { parseRemoteKv } from "./remote-scripts.mjs";
import { buildCacheListCommand, cliCacheDir, isSafeHubDir, parseCacheEntries } from "./team-cache.mjs";
import { isAdminUser, resolveAgentHubBaseDir, resolveEffectiveSshUser } from "../team-admin/protocol.mjs";

export const MAX_JOBS_KEPT = 20;
// 结束的任务在概览里再挂这么久（界面刷新后还能看到结果）。
export const FINISHED_JOB_VISIBLE_MS = 30 * 60 * 1000;
// 取消接口最多等收尾这么久（正常几秒；见 cancelJob）。前端写请求的超时是 120 秒，留足余量。
export const CANCEL_WAIT_MS = 20000;
const DOWNLOAD_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// 团队缓存列表在这么久之内复用（界面每次打开配置都会问；发布 / 安装结束后作废）。
export const TEAM_CACHE_TTL_MS = 60 * 1000;
const TEAM_CACHE_TIMEOUT_MS = 20000;
const REMOTE_MAX_OUTPUT = 256 * 1024;

const fail = (message, status) => Object.assign(new Error(message), { status });

// 采集 / 安装范围与 cli:<serverId> 探测同一口径（./service.mjs 的 isCliEligible：团队服务器、未禁用、未关监控）。
export { isCliEligible };

export const UNKNOWN_CLI_STATE = Object.freeze({ installed: null, version: null, kind: null, path: null, login: "unknown", loginDetail: null });

// 密码连接的服务器（条目带 authRef）不支持回退上传（v2.57 后续）。远端短命令经 execCollector 走凭证执行器
// （每条命令临时起 askpass 会话，跑完即销毁），上传是 uploadViaSsh 直接 spawn 的一条长连接，不经它——
// 密码服务器上必然 `Permission denied`。不把上传也接进凭证执行器：执行器只有「字符串标准输入、跑完即走」
// 一种形态，250MB 的文件流进不去；让密码会话撑满几十分钟的上传也不合适。所以与登录服务对密码服务器的
// 处理同一口径（./login.mjs：直接说明、请改用密钥）：官方路径只发短命令，照常可用；回退不可用——
// 「直接用本机下载」当场 409，自动模式由流程在预检前提醒、官方失败时说明为什么没回退（install.mjs 的 deps.uploadUnavailable）。
export const PASSWORD_UPLOAD_TEXT = "这台服务器用密码连接，本机下载后上传只支持密钥登录";
export const uploadUnavailableFor = (server) => (server?.authRef ? PASSWORD_UPLOAD_TEXT : null);

export function newJobId() {
  return `cli-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

// 已装状态 = P-G 探针结果（可缺）+ 本服务的覆盖层（更新的那份胜出）。
// 探针一侧按「扫描开始」的时刻比（startedAt；没有这个字段的旧形状回落 checkedAt）：一轮在安装完成之前
// 就开始、完成之后才结束的扫描，读到的是安装前的状态，结束时刻却晚于覆盖层——按结束时刻比，旧版本会
// 压过覆盖层；而安装后的补测又会并进这一轮在途的扫描（调度器对在途探针只复用、不重跑），界面要等到
// 下一轮（10 分钟）才对。
export function mergeCliState(probeState, overlay) {
  const { startedAt, ...state } = probeState || {};
  const base = { ...UNKNOWN_CLI_STATE, ...state };
  if (!overlay) return base;
  const probeAt = Number(startedAt ?? state.checkedAt) || 0;
  if (probeState && probeAt >= overlay.at) return base;
  // 覆盖层说装好了：探测里那句「装在别处、PATH 里找不到」（offPath）是安装之前的事实，一并拿掉。
  const { offPath: _stale, ...rest } = base;
  return { ...rest, installed: overlay.installed, version: overlay.version, kind: overlay.kind, path: overlay.path };
}

// 探测快照里某个 CLI 的状态，带上这一轮扫描的两个时刻（mergeCliState 判新旧用）；快照里没有它 → null。
function probeCliState(probe, cli) {
  const state = probe?.clis?.[cli];
  return state ? { ...state, checkedAt: probe.checkedAt, startedAt: probe.startedAt } : null;
}

// 对外的任务快照（深拷贝，去掉内部字段）。
export function jobSnapshot(job) {
  if (!job) return null;
  const { _release, ...rest } = job;
  return structuredClone(rest);
}

// install.mjs 的 deps（本机侧网络 + 产物解析 + 下载缓存），远端执行与上传由调用方绑好传入。
// 工作台（本服务）与命令行向导（scripts/setup/cli-install.mjs）共用。
export function buildInstallDeps({ remote, upload, uploadUnavailable = null, hubDir = null, getUpstream = async () => null, downloadDir, makeJobId = newJobId, now = Date.now, sleep, log = null }) {
  // 本机侧网络（元数据 / 下载）一律按当次的出网设置绑定上游。
  async function netDeps() {
    let upstream = null;
    try {
      upstream = await getUpstream();
    } catch {
      upstream = null;
    }
    return {
      fetchJson: (url) => fetchJson(url, { upstream }),
      fetchText: (url) => fetchText(url, { upstream }),
      contentLength: (url) => contentLength(url, { upstream }),
      open: (url, opts) => openHttps(url, { ...opts, upstream }),
    };
  }

  // 下载缓存里 3 天没动的残留（失败留下的 .part）清掉。
  async function sweepDownloads() {
    try {
      const names = await fsp.readdir(downloadDir);
      await Promise.all(names.map(async (name) => {
        const file = path.join(downloadDir, name);
        const st = await fsp.stat(file).catch(() => null);
        if (st?.isFile() && now() - st.mtimeMs > DOWNLOAD_MAX_AGE_MS) await fsp.rm(file, { force: true });
      }));
    } catch {
      // 目录还不存在
    }
  }

  return {
    remote,
    upload,
    uploadUnavailable,
    hubDir: isSafeHubDir(hubDir) ? hubDir : null,
    resolveLatest: async (cli) => resolveOfficialLatest(cli, await netDeps()),
    officialSizes: async (cli, { version, arch, musl }) => resolveOfficialSizes(cli, { version, arch, musl, ...(await netDeps()) }),
    resolveArtifact: async (cli, { version, arch, musl }) => {
      const net = await netDeps();
      return cli === "codex"
        ? resolveCodexArtifact({ version, target: codexTargetFor({ arch }), fetchJson: net.fetchJson, fetchText: net.fetchText, sha256OfText })
        : resolveClaudeArtifact({ version, platform: claudePlatformFor({ arch, musl }), fetchJson: net.fetchJson, zstd: hasZstd() });
    },
    download: async (artifact, { onProgress, signal }) => {
      if (!downloadDir) throw new Error("没有可用的本机下载目录");
      await sweepDownloads();
      const net = await netDeps();
      return downloadArtifact(artifact, { dir: downloadDir, onProgress, open: net.open, signal });
    },
    cleanup: (artifact) => cleanupArtifact(artifact, { dir: downloadDir }),
    newRemoteJobId: makeJobId,
    now,
    ...(sleep ? { sleep } : {}),
    log,
  };
}

export function createCliInstallService({
  getConfig,
  getMainServerConfig,
  sshArgsFor,
  execCollector,
  versions,
  getUpstream = async () => null,
  downloadDir,
  taskLock = createCliTaskLock(),
  spawnImpl,
  log = null,
  timeline = null,
  now = Date.now,
  sleep,
  makeJobId = newJobId,
  // 测试注入：整条流程 / 回滚的实现。
  runJob = runInstallJob,
  rollbackImpl = runRollback,
  publishImpl = runPublishJob,
  // 管理员判定读 ~/.ssh/config 里的 User（与团队管理同一口径）；测试注入。
  resolveSshUser = undefined,
}) {
  const jobs = new Map(); // jobId → job
  // 进行中任务的取消句柄：jobId → { controller: AbortController, done: 整条收尾链（含释放锁）的 promise }。
  // 不挂在 job 上：job 要原样 structuredClone 给接口。任务结束即删。
  const controls = new Map();
  const overlay = new Map(); // `${serverId}:${cli}` → { installed, version, kind, path, at }

  async function resolveTarget(serverId) {
    const config = await getConfig();
    const server = getMainServerConfig(config) || null;
    if (serverId != null && serverId !== server?.id) throw fail("只能查看 / 操作当前查看中的服务器，请刷新页面", 409);
    return { config, server };
  }

  function remoteFor(server, config, acquireSshSlot) {
    return async (command, { timeoutMs } = {}) => {
      let release = () => {};
      try {
        if (typeof acquireSshSlot === "function") release = await acquireSshSlot({ hostKey: server.host });
        return (await execCollector({ file: "ssh", args: [...sshArgsFor(server, config), command], input: "", timeoutMs, maxOutputBytes: REMOTE_MAX_OUTPUT }, server))
          || { code: null, stdout: "", stderr: "" };
      } catch (error) {
        return { code: null, stdout: "", stderr: String(error?.message || error) };
      } finally {
        release();
      }
    };
  }

  // 团队共享目录与本人是否管理员（与团队管理 lib/team-admin 同一口径）。
  function teamContext(config, server) {
    const hubDir = resolveAgentHubBaseDir(config);
    const sshUser = resolveEffectiveSshUser(config, server, resolveSshUser ? { resolveSshUser } : {});
    return { hubDir: isSafeHubDir(hubDir) ? hubDir : null, sshUser: sshUser || null, isAdmin: isAdminUser(config, sshUser) };
  }

  function jobDeps(server, config, acquireSshSlot) {
    return buildInstallDeps({
      hubDir: teamContext(config, server).hubDir,
      remote: remoteFor(server, config, acquireSshSlot),
      upload: ({ command, filePath, onProgress, signal }) => uploadViaSsh({
        args: [...sshArgsFor(server, config), command],
        filePath,
        onProgress,
        signal,
        ...(spawnImpl ? { spawnImpl } : {}),
      }),
      uploadUnavailable: uploadUnavailableFor(server),
      getUpstream,
      downloadDir,
      makeJobId,
      now,
      sleep,
      log: log ? (text) => log(text, { level: "info", event: "cli" }) : null,
    });
  }

  function rememberJob(job) {
    jobs.set(job.jobId, job);
    if (jobs.size > MAX_JOBS_KEPT) {
      for (const [id, j] of jobs) {
        if (jobs.size <= MAX_JOBS_KEPT) break;
        if (j.status !== "running") jobs.delete(id);
      }
    }
  }

  function setOverlay(serverId, cli, patch) {
    overlay.set(`${serverId}:${cli}`, { installed: true, kind: cli === "codex" ? "standalone" : "native", path: `~/.local/bin/${cli}`, ...patch, at: now() });
  }

  function latestJobFor(serverId) {
    let best = null;
    for (const job of jobs.values()) {
      if (job.serverId !== serverId) continue;
      if (job.status === "running") return job;
      if (now() - (job.finishedAt || 0) > FINISHED_JOB_VISIBLE_MS) continue;
      if (!best || (job.finishedAt || 0) > (best.finishedAt || 0)) best = job;
    }
    return best;
  }

  // GET /api/cli
  function probeSnapshot(serverId, runtime) {
    try {
      return runtime.getCliState?.(serverId) ?? null;
    } catch {
      return null;
    }
  }

  // 已装（覆盖层与探测快照取较新者）；两者都不知道 → null。
  function knownInstalled(serverId, cli, runtime) {
    const state = mergeCliState(probeCliState(probeSnapshot(serverId, runtime), cli), overlay.get(`${serverId}:${cli}`));
    return state.installed;
  }

  function notifyChanged(runtime, serverId, cli, ok) {
    Promise.resolve().then(() => runtime.onCliChanged?.(serverId, { cli, ok })).catch(() => {});
  }

  async function overview(serverId = null, runtime = {}) {
    const { server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) return { eligible: false, serverId: server?.id ?? null, clis: {}, job: null, busy: null };
    const latest = await versions.getLatest();
    const probe = probeSnapshot(server.id, runtime);
    const clis = {};
    for (const id of CLI_IDS) {
      const state = mergeCliState(probeCliState(probe, id), overlay.get(`${server.id}:${id}`));
      const { checkedAt: _ignored, ...cliState } = state;
      const l = latest[id] || {};
      clis[id] = {
        ...cliState,
        label: getCli(id).label,
        latest: l.latest ?? null,
        latestCheckedAt: l.checkedAt ?? null,
        latestError: l.error ?? null,
        updateAvailable: Boolean(cliState.installed) && isUpdateAvailable(cliState.version, l.latest),
      };
    }
    return {
      eligible: true,
      serverId: server.id,
      serverName: server.name || server.id,
      checkedAt: probe?.checkedAt ?? null,
      clis,
      // 回退上传不可用时的说明（密码连接）；界面据此收起「直接用本机下载」、改确认文案。
      fallbackUnavailable: uploadUnavailableFor(server),
      job: jobSnapshot(latestJobFor(server.id)),
      busy: taskLock.current(server.id),
    };
  }

  // POST /api/cli/:id/install → { jobId, job }。mode: "auto"（首选官方、失败回退）| "local"（直接本机下载）。
  async function startInstall(cli, { serverId = null, mode = "auto" } = {}, runtime = {}) {
    if (!isCliId(cli)) throw fail("未知的 CLI", 400);
    if (mode !== "auto" && mode !== "local") throw fail("mode 只能是 auto / local", 400);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) throw fail("当前查看的服务器不支持安装 CLI（只支持团队集群）", 404);
    const noUpload = uploadUnavailableFor(server);
    if (noUpload && mode === "local") throw fail(`${noUpload}。请直接用集群上的官方安装器（确认安装 / 更新），或先改用密钥登录（npm run setup）。`, 409);
    const release = taskLock.acquire(server.id, { kind: "install", cli, now });
    let job;
    try {
      const latest = (await versions.getLatest())[cli]?.latest ?? null;
      const installed = knownInstalled(server.id, cli, runtime);
      job = createJobState({ jobId: makeJobId(), serverId: server.id, cli, action: installed ? "update" : "install", targetVersion: latest, mode, now });
      rememberJob(job);
    } catch (err) {
      release();
      throw err;
    }
    log?.(`cli install ${cli} on ${server.id}: started (mode=${mode}, target=${job.targetVersion || "latest"})`, { level: "info", event: "cli" });
    launch(job, { runner: runJob, deps: jobDeps(server, config, runtime.acquireSshSlot), release, kind: "install" }, () => {
      if (job.status === "succeeded") setOverlay(server.id, cli, { version: job.installedVersion });
      notifyChanged(runtime, server.id, cli, job.status === "succeeded");
    });
    return { jobId: job.jobId, job: jobSnapshot(job) };
  }

  // 后台跑一个任务（安装 / 发布）：结束时释放锁、记日志与时间线、作废团队缓存列表，再交给 after。
  function launch(job, { runner, deps, release, kind }, after = () => {}) {
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => runner(job, deps, { signal: controller.signal }))
      .catch((err) => {
        Object.assign(job, { status: "failed", error: String(err?.message || err), finishedAt: now() });
      })
      .finally(() => {
        controls.delete(job.jobId);
        Object.assign(job, { cancelling: false, cancellable: false });
        release();
        teamCacheMemo.delete(job.serverId);
        const summary = `cli ${kind} ${job.cli} on ${job.serverId}: ${job.status}${job.installedVersion ? ` → ${job.installedVersion}` : ""}${job.path ? ` via ${job.path}` : ""}${job.error ? ` (${job.error})` : ""}`;
        // 用户自己取消的不算告警。
        const level = job.status === "failed" ? "warn" : "info";
        log?.(summary, { level, event: "cli" });
        timeline?.(level, summary, { event: `cli-${kind}`, serverId: job.serverId, cli: job.cli, status: job.status });
        after();
      });
    controls.set(job.jobId, { controller, done });
  }

  // GET /api/cli/team-cache → { serverId, dir, hub, isAdmin, sshUser, entries: { codex: [{version,size}], claude: [...] },
//                              best: { codex, claude }（缓存里的最高版本或 null）, checkedAt, error }
  // 读不到（SSH 不通）时 entries 为空、error 说明原因；不抛错（只是界面上的一行提示）。
  const teamCacheMemo = new Map(); // serverId → { at, value }
  async function teamCache(serverId = null, runtime = {}, { force = false } = {}) {
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) return { serverId: server?.id ?? null, dir: null, hub: false, isAdmin: false, sshUser: null, entries: { codex: [], claude: [] }, best: { codex: null, claude: null }, checkedAt: null, error: null };
    const team = teamContext(config, server);
    const memo = teamCacheMemo.get(server.id);
    if (!force && memo && now() - memo.at < TEAM_CACHE_TTL_MS) return { ...memo.value, isAdmin: team.isAdmin, sshUser: team.sshUser };
    const base = { serverId: server.id, dir: team.hubDir ? cliCacheDir(team.hubDir) : null, hub: false, isAdmin: team.isAdmin, sshUser: team.sshUser, entries: { codex: [], claude: [] }, best: { codex: null, claude: null }, checkedAt: now(), error: null };
    if (!team.hubDir) return { ...base, error: "没有配置团队共享目录" };
    const res = await remoteFor(server, config, runtime.acquireSshSlot)(buildCacheListCommand(team.hubDir), { timeoutMs: TEAM_CACHE_TIMEOUT_MS });
    const kv = parseRemoteKv(res?.stdout);
    if (!kv.complete) return { ...base, error: "读不到团队缓存（连不上服务器）" };
    // 每个 CLI：缓存里的版本（新 → 旧）与最高版本 best（界面据此说「安装会直接从缓存拷贝」）。
    const strip = (list, cli) => parseCacheEntries(list, cli).map(({ version, size }) => ({ version, size })).sort((a, b) => compareVersions(b.version, a.version) ?? 0);
    const codex = strip(kv.lists["cache.codex"], "codex");
    const claude = strip(kv.lists["cache.claude"], "claude");
    const value = { ...base, hub: kv.values.hub === "1", entries: { codex, claude }, best: { codex: codex[0]?.version ?? null, claude: claude[0]?.version ?? null } };
    teamCacheMemo.set(server.id, { at: now(), value });
    return value;
  }

  // POST /api/cli/:id/publish → 202 { jobId, job }（管理员；把最新版官方产物发布到团队缓存）
  async function startPublish(cli, { serverId = null } = {}, runtime = {}) {
    if (!isCliId(cli)) throw fail("未知的 CLI", 400);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) throw fail("当前查看的服务器不支持（只支持团队集群）", 404);
    const team = teamContext(config, server);
    if (!team.isAdmin) throw Object.assign(fail(`只有团队管理员能发布到团队缓存（当前账号 ${team.sshUser || "未知"} 不在 adminUsers 里）`, 403), { code: "forbidden" });
    if (!team.hubDir) throw fail("没有配置团队共享目录", 409);
    const noUpload = uploadUnavailableFor(server);
    if (noUpload) throw fail(`${noUpload}，发布到团队缓存需要上传。请先改用密钥登录。`, 409);
    const release = taskLock.acquire(server.id, { kind: "publish", cli, now });
    let job;
    try {
      const latest = (await versions.getLatest())[cli]?.latest ?? null;
      job = createJobState({ jobId: makeJobId(), serverId: server.id, cli, action: "publish", targetVersion: latest, mode: "local", now });
      rememberJob(job);
    } catch (err) {
      release();
      throw err;
    }
    log?.(`cli publish ${cli} on ${server.id}: started (target=${job.targetVersion || "latest"})`, { level: "info", event: "cli" });
    launch(job, { runner: publishImpl, deps: jobDeps(server, config, runtime.acquireSshSlot), release, kind: "publish" });
    return { jobId: job.jobId, job: jobSnapshot(job) };
  }

  // POST /api/cli/:id/smoke-test → { ok, code, message, hint, reply, tail, seconds, envSh }（同步，最长约 2.5 分钟）
  async function smokeTest(cli, { serverId = null } = {}, runtime = {}) {
    if (!isCliId(cli)) throw fail("未知的 CLI", 400);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) throw fail("当前查看的服务器不支持（只支持团队集群）", 404);
    const release = taskLock.acquire(server.id, { kind: "smoke", cli, now });
    try {
      const startedAt = now();
      const res = await remoteFor(server, config, runtime.acquireSshSlot)(buildSmokeTestCommand(cli), { timeoutMs: SMOKE_SSH_TIMEOUT_MS });
      const result = parseSmokeTest(cli, res);
      const summary = `cli smoke-test ${cli} on ${server.id}: ${result.code} (${Math.round((now() - startedAt) / 1000)}s)`;
      log?.(summary, { level: result.ok ? "info" : "warn", event: "cli" });
      timeline?.(result.ok ? "info" : "warn", summary, { event: "cli-smoke-test", serverId: server.id, cli, status: result.code });
      return result;
    } finally {
      release();
    }
  }

  function getJob(jobId) {
    return jobSnapshot(jobs.get(jobId) || null);
  }

  // POST /api/cli/jobs/:jobId/cancel → 任务快照。
  //   不存在 → 404；已经结束 → 原样返回（幂等）；临界阶段（落盘 / 切软链）→ 409 code=not-cancellable 并说明。
  //   受理后给流程发取消信号，然后等它收尾：结束集群上的官方任务 / 清半截上传各是一条 SSH，通常几秒。
  //   收尾完才返回——那时任务锁已经释放，登录 / 再次安装可以立刻发起。SSH 不通时收尾可能要一两分钟：
  //   最多等 waitMs，之后返回 cancelling=true 的快照，界面接着轮询；锁仍在收尾完成时释放。
  async function cancelJob(jobId, { waitMs = CANCEL_WAIT_MS } = {}) {
    const job = jobs.get(jobId);
    if (!job) throw fail("任务不存在或已过期", 404);
    const control = controls.get(jobId);
    if (job.status !== "running" || !control) return jobSnapshot(job);
    const blocked = cancelBlockReason(job);
    if (blocked) throw Object.assign(fail(blocked, 409), { code: "not-cancellable" });
    if (!control.controller.signal.aborted) {
      log?.(`cli install ${job.cli} on ${job.serverId}: cancel requested (phase=${job.phase})`, { level: "info", event: "cli" });
      Object.assign(job, { cancelling: true, updatedAt: now() });
      control.controller.abort();
    }
    let timer;
    await Promise.race([control.done, new Promise((resolve) => {
      timer = setTimeout(resolve, waitMs);
    })]);
    clearTimeout(timer);
    return jobSnapshot(job);
  }

  // POST /api/cli/:id/rollback → { ok, result, from, to, error }
  async function rollback(cli, { serverId = null, target = null } = {}, runtime = {}) {
    if (!isCliId(cli)) throw fail("未知的 CLI", 400);
    if (target != null && target !== "" && !isRollbackTarget(cli, target)) throw fail("回滚目标版本格式不对", 400);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isCliEligible(server)) throw fail("当前查看的服务器不支持 CLI 管理（只支持团队集群）", 404);
    const release = taskLock.acquire(server.id, { kind: "rollback", cli, now });
    try {
      const res = await rollbackImpl(cli, { remote: remoteFor(server, config, runtime.acquireSshSlot), target: target || null });
      if (res.ok && res.to) {
        const version = cli === "codex" ? res.to.replace(/-(?:x86_64|aarch64)-unknown-linux-musl$/, "") : res.to;
        setOverlay(server.id, cli, { version });
      }
      const summary = `cli rollback ${cli} on ${server.id}: ${res.result}${res.from ? ` ${res.from}` : ""}${res.to ? ` → ${res.to}` : ""}${res.error ? ` (${res.error})` : ""}`;
      log?.(summary, { level: res.ok ? "info" : "warn", event: "cli" });
      timeline?.(res.ok ? "info" : "warn", summary, { event: "cli-rollback", serverId: server.id, cli, result: res.result });
      notifyChanged(runtime, server.id, cli, Boolean(res.ok));
      return res;
    } finally {
      release();
    }
  }

  return { overview, startInstall, startPublish, teamCache, smokeTest, getJob, cancelJob, rollback, taskLock };
}
