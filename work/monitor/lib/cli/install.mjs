// CLI 安装 / 更新 / 回滚的流程编排（第 2 期 P-D，设计稿 §5.D）。
//
// 一次安装任务（runInstallJob）：
//   1. 预检（只读）：架构、工具、家目录剩余空间、受管 env.sh、现有安装、npm 全局安装、是否已有在跑的任务。
//      已有在跑的首选路径任务（比如上次工作台中途退出）→ 直接接管它的进度，不再起第二个。
//   2. 首选：集群上经隧道跑官方安装器（remote-scripts 的 job.sh，setsid + nohup 后台，SSH 断开不影响），
//      本机每 pollMs 轮询一次：退出码、下载中文件的大小（→ 进度 / 速度 / 剩余时间）、日志尾巴。
//      装完核对 PATH 里命令报的版本 ≥ 目标版本才算成功。
//      卡住 / 超时 / 任务脚本没留退出码就不在了，都先结束远端任务（连同它的进程组）；只有确认它已经结束
//      （结束命令回了确认）才回退——确认不了（SSH 不通、启动时回话丢了、任务目录不见了）就失败并说明，
//      不回退：官方安装器与回退并行会交错改安装目录。
//   3. 回退（首选失败 / 卡住 stallMs 没进展 / 总时长超 maxOfficialMs / 没有 env.sh / 用户点了「本机下载」）：
//      本机按官方清单下载同款产物（可续传、校验 sha256）→ 经 `ssh 'cat > …'` 标准输入上传（Windows 也不需要
//      scp）→ 远端核对字节数 + sha256 → 解包 / 落盘到官方同样的目录 → `--version` 冒烟 → 原子切软链 →
//      最终核对（不对就切回原版本）。
//   4. 旧版本一律保留（codex 的 releases/、Claude 的 versions/），切换前的版本记在 <cli>.previous，
//      回滚（runRollback）就是把软链切回去，同样先冒烟。
//   检测到 npm 全局安装与独立安装并存时只提示（warnings），不卸载（设计稿 §9）。
//   5. 取消（options.signal，一个 AbortSignal；工作台的取消接口与向导的 Ctrl+C 走同一条路）：
//        预检 / 读清单    只读命令与本机网络请求直接放弃等待，什么都不用清
//        官方阶段        用结束命令停掉集群上的安装任务并确认（同卡住时那条）；确认不了照样结束本任务，
//                        但在提醒里说明它可能还在跑。取消到达时它已经自己跑完（退出码 0）→ 新版本已经装上，
//                        不谎报「已取消」，照常核对版本
//        下载            信号传给 download，立刻停；本机的安装包与 .part 一并删掉（不留给 3 天清理）
//        上传            信号传给 upload（杀 ssh 子进程），再发一条命令清掉集群上的半截文件，本机安装包删掉
//        落盘 / 切软链    已经在改正式目录，不可取消：job.cancellable=false，这期间信号再响也不理
//                        （cancelBlockReason 给出原因，调用方据此拒绝），等它跑完
//      取消后 status="cancelled"，不回退，集群上原来的版本没有动过（官方安装器自己的切换是原子的）。
//      job.cancellable 表示「此刻能不能取消」，job.cancelling 表示「已受理、正在清理」。
//
// 本文件不直接发 SSH、不碰网络：远端执行（remote）、上传（upload）、产物解析（resolveArtifact）、
// 下载（download）全部注入；单测可用本机 sh 在临时 HOME 里端到端演练。uploadViaSsh 是 upload 的生产实现。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { ensureWindowsOpenSshOnPath } from "../platform.mjs";
import { compareVersions, getCli, parseVersionText } from "./catalog.mjs";
import {
  buildClaudeActivateCommand,
  buildCodexActivateCommand,
  buildOfficialKillCommand,
  buildOfficialPollCommand,
  buildOfficialStartCommand,
  buildPreflightCommand,
  buildRollbackCommand,
  buildUploadCleanupCommand,
  buildUploadCommand,
  buildVerifyCommand,
  FAIL_TEXT,
  MIN_FREE_KB,
  parseKill,
  parsePoll,
  parsePreflight,
  parseRemoteKv,
} from "./remote-scripts.mjs";
import { claudePlatformFor, codexTargetFor } from "./sources.mjs";
import {
  buildCacheCopyCommand,
  CACHE_COPY_TEXT,
  CACHE_SKIP_TEXT,
  cacheListLines,
  chooseCacheEntry,
  isSafeHubDir,
  parseCacheEntries,
} from "./team-cache.mjs";
import { isStrictVersion } from "./versions.mjs";

export const POLL_MS = 10000;
// 下载中文件大小、日志与相关目录的新写入都这么久没变化 → 判定卡住，结束首选路径任务、改走回退。
export const STALL_MS = 10 * 60 * 1000;
// 首选路径总时长上限（250MB / 114KB/s ≈ 37 分钟，留足余量）。
export const MAX_OFFICIAL_MS = 3 * 60 * 60 * 1000;
// 轮询连续失败这么多次（≈ 5 分钟连不上服务器）就放弃跟踪：远端安装器可能还在跑，回退也传不上去。
export const MAX_POLL_FAILURES = 30;
// 结束首选路径任务后没拿到「已结束」的确认时，结束命令最多发这么多次（每次间隔一个轮询周期）。
export const STOP_ATTEMPTS = 3;
// 取消时结束命令最多发这么多次（用户在等，比卡住时少一次；确认不了就带着提醒结束）。
export const CANCEL_STOP_ATTEMPTS = 2;
// 上传被取消 / 超时后，SIGTERM 之后这么久子进程还没退就补 SIGKILL。
export const UPLOAD_KILL_GRACE_MS = 2000;
// 确认不了远端任务是否结束时不回退的统一说明。
const NO_FALLBACK_TEXT = "为避免官方安装器和本机上传同时改动安装目录，这次不自动改用本机下载；稍后刷新查看版本，需要的话再点一次安装（会接着跟踪还在跑的任务）。";
export const PREFLIGHT_TIMEOUT_MS = 60000;
export const POLL_TIMEOUT_MS = 30000;
export const ACTIVATE_TIMEOUT_MS = 8 * 60 * 1000;
// 团队缓存 → 私有上传目录的集群内拷贝（250MB 在共享盘上通常十几秒，留足余量）。
export const CACHE_COPY_TIMEOUT_MS = 5 * 60 * 1000;
export const UPLOAD_IDLE_TIMEOUT_MS = 120000;
const SPEED_WINDOW_MS = 60000;
const MAX_EVENTS = 60;

export const PHASE_TEXT = Object.freeze({
  queued: "排队中",
  preflight: "检查服务器环境",
  cache: "从团队缓存拷贝（集群内，不走外网）",
  official: "集群上运行官方安装器（经隧道下载）",
  resolve: "读取官方版本清单",
  download: "本机下载官方安装包",
  upload: "上传到集群",
  activate: "集群上解包、冒烟并切换",
  rollback: "切回旧版本",
  done: "完成",
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

// 进了这些阶段就不可取消：已经在改正式目录（解包落盘、切软链、最终核对不过时切回）。
const UNCANCELLABLE_PHASES = new Set(["activate", "rollback", "done"]);
const NOT_CANCELLABLE_TEXT = Object.freeze({
  activate: "集群上正在解包、冒烟并切换版本（已经在改正式目录），这一步不能中途取消；通常一两分钟内结束，请等它跑完",
  official: "官方安装器已经跑完，正在核对版本，马上结束",
});

// 这个任务此刻能不能取消：null = 能（已在取消中的重复请求也算能）；否则是给用户看的原因。
// 工作台的取消接口（install-service.mjs）与向导的 Ctrl+C 共用。
export function cancelBlockReason(job) {
  if (job?.status !== "running") return "任务已经结束";
  if (job.cancelling) return null;
  if (job.cancellable === false) return NOT_CANCELLABLE_TEXT[job.phase] || "这一步不能中途取消，请等它跑完";
  return null;
}

const cancelError = () => Object.assign(new Error("已取消"), { code: "ECANCELLED" });
const isCancel = (err) => err?.code === "ECANCELLED";

// 等 promise，信号一响立刻以 ECANCELLED 结束等待；原来的 promise 留在后台自己结束（结果丢弃）。
// 只能用在「放弃了也无妨」的等待上：只读的远端命令、本机网络请求、sleep。
function raceAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelError());
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// 默认的 sleep：到点或信号响了就醒（顺手清掉定时器，不留悬挂的 timer）。信号早就响过的话照常睡满。
function delay(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// ---------------------------------------------------------------------------
// 进度：最近 60 秒滑动窗口算速度，剩余时间 = 剩余字节 / 速度。
// ---------------------------------------------------------------------------
export function createProgressMeter({ now = Date.now, windowMs = SPEED_WINDOW_MS } = {}) {
  let samples = [];
  let last = null;
  function update(bytes, total) {
    const t = now();
    if (last && bytes < last.bytes) samples = []; // 换源从头下 / 换了一段（下载 → 上传）
    samples.push({ t, bytes });
    while (samples.length > 2 && t - samples[0].t > windowMs) samples.shift();
    last = { bytes, total: Number.isFinite(total) && total > 0 ? total : null };
    return snapshot();
  }
  function snapshot() {
    if (!last) return null;
    let speedBps = null;
    if (samples.length >= 2) {
      const a = samples[0];
      const b = samples[samples.length - 1];
      if (b.t > a.t) speedBps = Math.max(0, Math.round(((b.bytes - a.bytes) * 1000) / (b.t - a.t)));
    }
    const total = last.total;
    const percent = total ? Math.min(100, Math.floor((last.bytes / total) * 100)) : null;
    const etaSec = total && speedBps ? Math.max(0, Math.round((total - last.bytes) / speedBps)) : null;
    return { bytes: last.bytes, total, percent, speedBps, etaSec };
  }
  function reset() {
    samples = [];
    last = null;
  }
  return { update, snapshot, reset };
}

// ---------------------------------------------------------------------------
// 上传：ssh 的标准输入直接接本机文件流（不进内存），按读出的字节报进度。
// 远端长时间不收（idleTimeoutMs 内没有一个块被读走）→ 结束 ssh，按失败返回。永不 reject。
// signal（取消）：响了就停止喂数据、关掉标准输入、SIGTERM 子进程（killGraceMs 后还在就 SIGKILL），
// 结果带 aborted: true；信号早就响了则根本不起子进程。远端的半截文件由调用方另发命令清理。
// → { code, stdout, stderr, timedOut, aborted }
// ---------------------------------------------------------------------------
export function uploadViaSsh({ file = "ssh", args, filePath, onProgress, signal = null, spawnImpl = spawn, idleTimeoutMs = UPLOAD_IDLE_TIMEOUT_MS, killGraceMs = UPLOAD_KILL_GRACE_MS, maxOutputBytes = 64 * 1024 }) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }
    let child;
    ensureWindowsOpenSshOnPath(file);
    try {
      child = spawnImpl(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err?.message || err), timedOut: false, aborted: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const collect = (which) => (chunk) => {
      const text = chunk.toString("utf8");
      if (which === "out" && stdout.length < maxOutputBytes) stdout += text;
      if (which === "err" && stderr.length < maxOutputBytes) stderr += text;
    };
    child.stdout?.on("data", collect("out"));
    child.stderr?.on("data", collect("err"));
    let idle;
    const arm = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, idleTimeoutMs);
    };
    arm();
    const source = fs.createReadStream(filePath);
    let killTimer;
    const onAbort = () => {
      aborted = true;
      clearTimeout(idle);
      // 先断数据源与标准输入：子进程（或它留下的子孙）读到 EOF 才会放开管道，close 事件才来得了。
      source.destroy();
      child.stdin?.destroy();
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, killGraceMs);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };
    child.on("error", (err) => {
      stderr += String(err?.message || err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => {}); // 远端提前退出 → EPIPE，结果由 close 结算
    let bytes = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        if (!aborted) arm();
        onProgress?.(bytes);
        cb(null, chunk);
      },
    });
    pipeline(source, counter, child.stdin).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// 任务状态
// ---------------------------------------------------------------------------

// 新任务的初始快照（对外 GET /api/cli/jobs/:jobId 就是它的拷贝）。
export function createJobState({ jobId, serverId, cli, action = "install", targetVersion = null, mode = "auto", now = Date.now }) {
  const t = now();
  return {
    jobId,
    serverId,
    cli,
    label: getCli(cli)?.label || cli,
    action,
    mode,
    // running → succeeded | failed | cancelled
    status: "running",
    // 此刻能不能取消（进了落盘 / 切软链就不能）；已受理取消、正在清理时 cancelling 为真。
    cancellable: true,
    cancelling: false,
    path: null,
    phase: "queued",
    phaseText: PHASE_TEXT.queued,
    progress: null,
    targetVersion,
    fromVersion: null,
    installedVersion: null,
    fellBack: false,
    fallbackReason: null,
    remoteJobId: null,
    warnings: [],
    events: [],
    remoteLog: [],
    error: null,
    startedAt: t,
    updatedAt: t,
    finishedAt: null,
  };
}

function jobError(message, extra = {}) {
  return Object.assign(new Error(message), { code: "EJOB", ...extra });
}

function sshReason(res) {
  if (res?.timedOut) return "SSH 超时";
  const text = String(res?.stderr || "").trim().split("\n").filter(Boolean).pop();
  return text ? text.slice(0, 200) : `ssh 退出码 ${res?.code ?? "未知"}`;
}

// 首选路径里下载中文件 → 期望总字节（best-effort，拿不到就只显示已下多少）。
function officialTotalFor(cli, name, sizes) {
  if (!sizes) return null;
  if (cli === "claude") return name.endsWith(".zst") ? sizes.compressed ?? null : sizes.raw ?? null;
  return sizes.raw ?? null;
}

// deps：
//   remote(command, { timeoutMs }) → { code, stdout, stderr, timedOut }
//   upload({ command, filePath, size, onProgress, signal }) → 同上，另带 aborted
//   resolveArtifact(cli, { version, arch, musl }) → sources.mjs 的 artifact
//   resolveLatest(cli) → 版本号（目标版本未知时问官方源）
//   officialSizes(cli, { version, arch, musl }) → { raw, compressed }（首选路径进度的分母，可缺）
//   download(artifact, { onProgress, signal }) → { filePath, size, sha256 }
//   cleanup(artifact)
//   uploadUnavailable：回退上传不可用时的说明文字（密码连接的服务器），可缺；有它时只走首选路径
//   hubDir：团队共享目录（team-cache.mjs），可缺；有它时预检顺带列出团队缓存，能用就先从缓存集群内拷贝
//   newRemoteJobId() / now() / sleep(ms) / log(text)
// job：createJobState 的对象，本函数原地更新；onUpdate(job) 每次变化后调用。
// options.signal：取消信号（AbortSignal，见文件头第 5 条）。
export async function runInstallJob(job, deps, {
  pollMs = POLL_MS,
  stallMs = STALL_MS,
  maxOfficialMs = MAX_OFFICIAL_MS,
  maxPollFailures = MAX_POLL_FAILURES,
  stopAttempts = STOP_ATTEMPTS,
  cancelStopAttempts = CANCEL_STOP_ATTEMPTS,
  signal = null,
  onUpdate = () => {},
} = {}) {
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => delay(ms, signal));
  const meter = createProgressMeter({ now });
  const cli = job.cli;

  const touch = (patch = {}) => {
    Object.assign(job, patch, { updatedAt: now() });
    onUpdate(job);
  };
  const event = (text) => {
    job.events.push({ at: now(), text });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    deps.log?.(`cli ${job.jobId} ${cli}: ${text}`);
    touch();
  };

  // ---- 取消的配合点 ----
  // cancelOpen：此刻接不接受取消，与 job.cancellable 同步。关着的时候信号响了也不理——调用方按
  // cancelBlockReason 拒绝请求，这里是第二道保险。「关上」总是与它前面的检查点在同一段同步代码里，
  // 中间没有 await：不会出现「请求被受理了、流程却已经走进不可取消的阶段」的空档。
  let cancelOpen = true;
  const setCancelOpen = (open) => {
    cancelOpen = open;
    if (job.cancellable !== open) touch({ cancellable: open });
  };
  const cancelRequested = () => cancelOpen && Boolean(signal?.aborted);
  // 检查点：取消已受理就从这里跳出（ECANCELLED），由最外层统一收尾。
  const checkpoint = () => {
    if (cancelRequested()) throw cancelError();
  };
  // 可放弃的等待（只读远端命令 / 本机网络 / sleep）：信号一响立刻跳出，不等它返回。
  // 会改动集群的命令（启动官方任务、结束任务、落盘）不能包进来——必须等到回话。
  const abandonable = (promise) => (cancelOpen ? raceAbort(promise, signal) : Promise.resolve(promise));
  // 取消收尾时要用到的现场。
  let artifact = null; // 回退路径解析出的产物
  let downloadTouched = false; // 下载开始过 → 删本机缓存里的安装包与 .part
  let uploadTouched = false; // 上传开始过 → 清集群上的半截文件
  let officialStop = null; // 官方阶段取消时结束命令的结果（stopRemoteJob 的返回值）
  let officialUncertain = false; // 确认不了集群上的官方安装器是否已停
  let officialCompleted = false; // 取消到达时官方安装器已经自己跑完（退出码 0）

  const phase = (name, path = job.path) => {
    meter.reset();
    cancelOpen = !UNCANCELLABLE_PHASES.has(name);
    touch({ phase: name, phaseText: PHASE_TEXT[name] || name, path, progress: null, cancellable: cancelOpen });
  };
  // 任务结束后迟到的进度回调（被放弃的下载 / 上传）不再改快照。
  const progress = (bytes, total) => {
    if (job.status === "running") touch({ progress: meter.update(bytes, total) });
  };

  try {
    checkpoint();
    // ---- 0. 回退上传可不可用（预检之前就定下来）----
    // 密码连接的服务器：远端短命令经凭证执行器（askpass）能跑，上传那条长连接不经它，必然 Permission denied
    // （见 install-service.mjs 的 PASSWORD_UPLOAD_TEXT）。官方路径照常走；回退不可用要在动手前说清楚，
    // 别等官方路径折腾半小时失败后再甩一句裸的 Permission denied。
    const noUpload = deps.uploadUnavailable || null;
    if (noUpload && job.mode === "local") throw jobError(`${noUpload}。请改用集群上的官方安装器（直接点安装 / 更新），或先改用密钥登录（npm run setup）。`);
    if (noUpload) job.warnings.push(`${noUpload}：这次只走集群上的官方安装器，它失败或卡住时不会自动改为本机下载后上传。`);

    // ---- 1. 预检 ----
    phase("preflight");
    const hubDir = isSafeHubDir(deps.hubDir) ? deps.hubDir : null;
    const extraLines = hubDir ? cacheListLines(cli, hubDir) : [];
    const pfRes = await abandonable(deps.remote(buildPreflightCommand(cli, { extraLines }), { timeoutMs: PREFLIGHT_TIMEOUT_MS }));
    const pf = parsePreflight(cli, pfRes?.stdout);
    const cacheEntries = hubDir ? parseCacheEntries(parseRemoteKv(pfRes?.stdout).lists.cache, cli) : [];
    if (!pf.complete) throw jobError(`连不上服务器或预检没有完成（${sshReason(pfRes)}）`);
    touch({ fromVersion: pf.currentVersion, action: pf.currentVersion ? "update" : "install" });
    const target = cli === "codex" ? codexTargetFor(pf) : claudePlatformFor(pf);
    if (!target) throw jobError(`服务器架构 ${pf.arch || "未知"} 不在官方支持范围内`);
    if (pf.freeKb != null && pf.freeKb < MIN_FREE_KB[cli]) {
      throw jobError(`家目录剩余空间只有 ${Math.round(pf.freeKb / 1024)}MB，至少需要 ${Math.round(MIN_FREE_KB[cli] / 1024)}MB`);
    }
    for (const p of pf.npmPaths) job.warnings.push(`检测到 npm 全局安装的 ${cli}：${p}。与独立安装并存时，PATH 里排在前面的那个生效；工作台不会自动卸载。`);
    if (pf.visible === "file") job.warnings.push(`~/.local/bin/${cli} 是普通文件（可能是旧向导的包装脚本），切换时会先备份成 ${cli}.bak.<时间戳> 再换成软链。`);
    const broken = pf.releases.filter((r) => r.broken).map((r) => r.name);
    if (broken.length) job.warnings.push(`versions 目录里有损坏的残留（${broken.join("、")}，多半是以前更新超时留下的 0 字节文件），本次安装会覆盖同版本的残留。`);
    touch();

    const attached = pf.running[0] || null;

    // ---- 1.5 团队缓存：集群内拷贝，不走外网（team-cache.mjs 文件头的信任模型）----
    // 已有在跑的官方任务时不碰（两边会同时改安装目录）；用户点了「本机下载」时也不用。
    if (hubDir && !attached && job.mode !== "local" && cacheEntries.length) {
      const pick = chooseCacheEntry({ cli, entries: cacheEntries, target, currentVersion: pf.currentVersion, targetVersion: job.targetVersion });
      if (pick.entry && cli === "codex" && pf.has.tar === false) {
        event("团队缓存里有安装包，但集群上没有 tar，无法解包，跳过缓存");
      } else if (pick.entry) {
        const viaCache = await runFromCache(pick, pf);
        if (viaCache.ok) return finishOk(viaCache.installed);
        event(`团队缓存没用上：${viaCache.reason}；改走其他方式`);
      } else if (CACHE_SKIP_TEXT[pick.reason]) {
        event(`${CACHE_SKIP_TEXT[pick.reason]}，不用缓存`);
      }
    }

    // ---- 2. 首选：官方安装器 ----
    let reason = null;
    const officialOk = pf.envSh && pf.has.curl !== false && (cli !== "claude" || pf.has.bash !== false);
    if (attached) {
      event(`服务器上已有一个进行中的官方安装任务（${attached}），接着跟踪它`);
    }
    if (attached || (job.mode !== "local" && officialOk)) {
      const result = await runOfficial({ attached, pf });
      if (result.ok) return finishOk(result.installed);
      if (result.abort) {
        // 确认不了远端任务的去向，而用户恰好也点了取消：按取消收尾，原因留在提醒里。
        if (cancelRequested()) {
          officialUncertain = true;
          job.warnings.push(result.reason);
          throw cancelError();
        }
        throw jobError(result.reason);
      }
      reason = result.reason;
    } else if (job.mode === "local") {
      reason = "选择了本机下载";
    } else if (!pf.envSh) {
      reason = "集群上还没有受管代理配置（~/.config/cluster-workbench/env.sh），无法经隧道下载";
    } else {
      reason = "集群上缺少 curl / bash，无法运行官方安装器";
    }

    // ---- 3. 回退：本机下载 → 上传 → 落盘 ----
    checkpoint();
    if (noUpload) throw jobError(`${reason}。${noUpload}，所以没有改用本机下载；可以稍后重试，或先改用密钥登录（npm run setup）再装。`);
    touch({ fellBack: job.path === "official", fallbackReason: reason });
    event(`改用本机下载：${reason}`);
    if (cli === "codex" && pf.has.tar === false) throw jobError("集群上没有 tar，无法解包");
    let version = job.targetVersion;
    phase("resolve", "fallback");
    checkpoint();
    if (!isStrictVersion(version)) {
      version = await abandonable(deps.resolveLatest(cli));
      if (!isStrictVersion(version)) throw jobError("拿不到最新版本号，请检查本机出网设置");
      touch({ targetVersion: version });
    }
    artifact = await abandonable(deps.resolveArtifact(cli, { version, arch: pf.arch, musl: pf.musl }));
    event(`官方清单：${artifact.fileName}（sha256 ${artifact.sha256.slice(0, 12)}…）`);

    // 下载不包进 abandonable：信号交给它自己停（停稳了才返回），收尾删文件时不会有还在写的句柄。
    phase("download");
    downloadTouched = true;
    let dl;
    try {
      dl = await deps.download(artifact, { onProgress: ({ bytes, total }) => progress(bytes, total), signal });
    } catch (err) {
      checkpoint(); // 被取消信号打断的下载：按取消收尾
      throw err;
    }
    checkpoint();
    event(dl.reused ? "本机已有校验通过的安装包，直接复用" : "本机下载完成，校验和与官方清单一致");

    phase("upload");
    let up = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      checkpoint();
      uploadTouched = true;
      const res = await deps.upload({
        command: buildUploadCommand({ fileName: artifact.fileName, size: dl.size, sha256: dl.sha256 }),
        filePath: dl.filePath,
        size: dl.size,
        onProgress: (bytes) => progress(bytes, dl.size),
        signal,
      });
      checkpoint();
      up = parseRemoteKv(res?.stdout).values.upload || null;
      if (up === "ok") break;
      if (up === "badsum") throw jobError("上传后集群上复核 sha256 不符（传输被篡改？）");
      event(`上传没有完成（${up === "short" ? "字节数不对" : sshReason(res)}），${attempt < 2 ? "重试一次" : "放弃"}`);
    }
    if (up !== "ok") throw jobError("上传到集群失败");
    event("已上传，集群上复核 sha256 一致");

    await activateUploaded(version, artifact, dl.sha256);
    await deps.cleanup?.(artifact);
    return finishOk(version);
  } catch (err) {
    // 取消已受理（从检查点跳出来的，或恰好同时出了别的错）：按取消收尾。
    if (isCancel(err) || cancelRequested()) return finishCancelled();
    touch({ status: "failed", cancellable: false, cancelling: false, error: String(err?.message || err), finishedAt: now(), phaseText: "失败" });
    event(`失败：${job.error}`);
    return job;
  }

  // 上传目录里已有核过 sha256 的产物（本机上传回退或团队缓存拷贝）→ 解包 / 落盘 / 冒烟 / 切软链。失败抛 jobError。
  async function activateUploaded(version, art, sha256) {
    // 最后一个取消点。过了它就开始改正式目录：phase("activate") 同步把取消关上，两句之间没有 await。
    checkpoint();
    phase("activate");
    const command = cli === "codex"
      ? buildCodexActivateCommand({ version, target: art.target, fileName: art.fileName, sha256 })
      : buildClaudeActivateCommand({ version, fileName: art.fileName, sha256 });
    const actRes = await deps.remote(command, { timeoutMs: ACTIVATE_TIMEOUT_MS });
    const act = parseRemoteKv(actRes?.stdout);
    if (act.values.result !== "ok") {
      const code = act.values.detail;
      throw jobError(code ? FAIL_TEXT[code] || `集群上落盘失败（${code}）` : `集群上落盘没有完成（${sshReason(actRes)}）`);
    }
    if (act.values.visible === "backed-up") event(`~/.local/bin/${cli} 原来的普通文件已备份`);
  }

  // 团队缓存路径：本机取官方 sha256 → 集群内拷进私有上传目录并核对 → 落盘。
  // 拷贝之前的任何失败都只返回原因（调用方改走官方安装器 / 本机下载）；落盘失败与回退路径一样直接抛错。
  async function runFromCache(pick, pf) {
    const { entry } = pick;
    phase("cache", "cache");
    event(`团队缓存里有 ${job.label} ${entry.version}${pick.olderThanTarget ? `（最新版是 ${job.targetVersion}，先装缓存里的，之后可再点更新）` : ""}，在集群内拷贝`);
    let art;
    try {
      art = await abandonable(deps.resolveArtifact(cli, { version: entry.version, arch: pf.arch, musl: pf.musl }));
    } catch (err) {
      if (isCancel(err)) throw err;
      return { ok: false, reason: `取不到 ${entry.version} 的官方校验和（${err?.message || err}）` };
    }
    if (!art || art.fileName !== entry.fileName) return { ok: false, reason: "缓存文件名与官方产物不一致" };
    if (art.size && art.size !== entry.size) return { ok: false, reason: "缓存文件大小与官方清单不一致" };
    checkpoint();
    artifact = art;
    uploadTouched = true;
    const res = await deps.remote(buildCacheCopyCommand({ hubDir: deps.hubDir, cli, version: entry.version, fileName: entry.fileName, sha256: art.sha256 }), { timeoutMs: CACHE_COPY_TIMEOUT_MS });
    checkpoint();
    const copy = parseRemoteKv(res?.stdout).values.copy;
    if (copy !== "ok") return { ok: false, reason: CACHE_COPY_TEXT[copy] || `拷贝没有完成（${sshReason(res)}）` };
    event("已从团队缓存拷贝，sha256 与官方清单一致");
    if (!job.targetVersion) touch({ targetVersion: entry.version });
    await activateUploaded(entry.version, art, art.sha256);
    return { ok: true, installed: entry.version };
  }

  function finishOk(installed) {
    cancelOpen = false;
    touch({ status: "succeeded", cancellable: false, cancelling: false, installedVersion: installed, phase: "done", phaseText: PHASE_TEXT.done, finishedAt: now() });
    event(`${job.label} ${installed} 已就绪${job.fromVersion && job.fromVersion !== installed ? `（原版本 ${job.fromVersion} 保留，可回滚）` : ""}`);
    return job;
  }

  // 取消的统一收尾（官方任务已经在 runOfficial 里结束过了）：删本机的安装包与 .part，上传开始过就再发
  // 一条命令清掉集群上的半截文件。清理失败不改变结局（照样 cancelled），只在提醒里说明留下了什么。永不抛错。
  async function finishCancelled() {
    cancelOpen = false;
    touch({ cancelling: true, cancellable: false, phaseText: "正在取消", progress: null });
    const did = [];
    if (officialStop?.stopped) did.push("集群上的官方安装器已停止");
    if (downloadTouched && artifact && deps.cleanup) {
      try {
        await deps.cleanup(artifact);
        did.push("本机下载的安装包已删除");
      } catch {
        // 删不掉的留给下次下载前的 3 天清理（install-service 的 sweepDownloads）
      }
    }
    if (uploadTouched && artifact) {
      let res;
      try {
        res = await deps.remote(buildUploadCleanupCommand({ fileName: artifact.fileName }), { timeoutMs: POLL_TIMEOUT_MS });
      } catch (err) {
        res = { code: null, stdout: "", stderr: String(err?.message || err) };
      }
      if (parseRemoteKv(res?.stdout).values.cleanup === "ok") did.push("集群上的半截上传文件已清理");
      else job.warnings.push(`没能连上集群清理半截上传文件（~/.cache/cluster-workbench/cli/upload/${artifact.fileName}*）：${sshReason(res)}。它只占缓存目录，下次安装同一个包时会被覆盖。`);
    }
    let tail = "集群上现有的安装没有动。";
    if (officialUncertain) tail = "集群上的官方安装器可能还在运行，稍后刷新查看版本。";
    else if (officialCompleted) tail = "官方安装器在取消之前已经跑完，集群上的版本以刷新后看到的为准。";
    touch({ status: "cancelled", cancelling: false, error: null, finishedAt: now(), phaseText: "已取消" });
    event(`已取消${did.length ? `：${did.join("，")}` : ""}。${tail}`);
    return job;
  }

  // 结束首选路径任务，并确认它确实不在了。结束命令是幂等的（把还活着的再杀一遍，回报是否都不在了），
  // 所以没拿到确认时「再确认一次」就是隔一个轮询间隔再发一遍，最多 attempts 次。永不抛错。
  // → { stopped, missing, exitCode, detail }：stopped = 确认不在跑了（exitCode 是它留下的退出码，我们杀掉的是 143）；
  //   missing = 任务目录不在；detail = 没确认时的原因（给用户看）。
  async function stopRemoteJob(remoteJobId, attempts = stopAttempts) {
    let detail = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(pollMs);
      let res;
      try {
        res = await deps.remote(buildOfficialKillCommand(remoteJobId), { timeoutMs: POLL_TIMEOUT_MS });
      } catch (err) {
        res = { code: null, stdout: "", stderr: String(err?.message || err) };
      }
      const kill = parseKill(res?.stdout);
      if (kill.stopped) return { stopped: true, missing: false, exitCode: kill.exitCode, detail: "" };
      if (kill.missing) return { stopped: false, missing: true, exitCode: null, detail: "任务目录不见了" };
      if (kill.complete && kill.state === "unknown") return { stopped: false, missing: false, exitCode: null, detail: "读不到任务的进程号" };
      detail = kill.complete ? "进程结束不掉" : sshReason(res);
    }
    return { stopped: false, missing: false, exitCode: null, detail };
  }

  // 首选路径：启动（或接管）→ 轮询 → 核对。→ { ok, installed } | { ok:false, reason, abort? }
  // 回退之前必须确认远端任务已经结束（v2.57 后续）：codex 有官方的 install.lock，Claude 没有锁——
  // 官方安装器还在跑时回退，`claude install` 与我们的 mv / 换软链会交错。所以凡是「不知道它还在不在」
  // （结束命令没回确认、启动时回话丢了、任务目录不见了、长时间连不上）一律 abort：失败并说明，不回退。
  async function runOfficial({ attached, pf }) {
    phase("official", "official");
    let remoteJobId = attached;
    if (!remoteJobId) {
      checkpoint(); // 还没起任务：直接取消，什么都不用清
      remoteJobId = deps.newRemoteJobId();
      // 启动命令不可放弃：它会在集群上起后台任务，必须等到回话才知道之后要不要结束它。
      const res = await deps.remote(buildOfficialStartCommand(cli, remoteJobId), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      const started = parseRemoteKv(res?.stdout);
      const start = started.values.start;
      if (start === "noenv") return { ok: false, reason: "集群上还没有受管代理配置（env.sh）" };
      if (start === "mkdir") return { ok: false, reason: "启动官方安装器失败（集群上建任务目录失败：权限或磁盘满）" };
      if (start !== "ok") {
        // 没等到回话（SSH 超时 / 中途断开）：任务也许已经在集群上跑起来了。任务目录不在 = 根本没起来；
        // 在的话把它结束掉并确认，之后才能回退。
        const stop = await stopRemoteJob(remoteJobId);
        if (stop.stopped || stop.missing) return { ok: false, reason: `启动官方安装器失败（${sshReason(res)}）` };
        return { ok: false, abort: true, reason: `启动官方安装器时连接中断（${sshReason(res)}），没能确认它有没有在集群上跑起来（${stop.detail}）。${NO_FALLBACK_TEXT}` };
      }
      event("已在集群上后台启动官方安装器（经隧道下载，SSH 断开不影响）");
    }
    touch({ remoteJobId });
    // 任务已结束、退出码已知 → 给出结论（退出码 0 时核对版本）。
    const conclude = async (exitCode) => {
      if (exitCode !== 0) return { ok: false, reason: `官方安装器退出码 ${exitCode}` };
      // 官方安装器已经成功跑完，新版本在位，取消已无意义：关上取消，只剩核对版本。
      setCancelOpen(false);
      const v = await deps.remote(buildVerifyCommand(cli), { timeoutMs: POLL_TIMEOUT_MS });
      const installed = parseVersionText(parseRemoteKv(v?.stdout).values.version);
      const want = job.targetVersion;
      const newEnough = installed && (!isStrictVersion(want) || (compareVersions(installed, want) ?? -1) >= 0);
      if (newEnough) return { ok: true, installed };
      return { ok: false, reason: `官方安装器结束了，但 PATH 里的版本是 ${installed || "未知"}${want ? `（目标 ${want}）` : ""}` };
    };
    // 卡住 / 超时 / 主进程不明不白没了：结束远端任务；确认结束了才回退，确认不了就 abort。
    const stopThenFallBack = async (why) => {
      const stop = await stopRemoteJob(remoteJobId);
      if (!stop.stopped) return { ok: false, abort: true, reason: `${why}，但没能确认集群上的安装任务已经停止（${stop.detail}）。${NO_FALLBACK_TEXT}` };
      // 恰好在我们动手之前自己跑完了：照常核对版本。
      if (stop.exitCode === 0) return conclude(0);
      return { ok: false, reason: `${why}，已停止` };
    };
    // 轮询到结束。等待都是可放弃的（sleep、只读的轮询命令）：取消时从这里以 ECANCELLED 跳出。
    const track = async () => {
      let sizes = null;
      try {
        sizes = await abandonable(deps.officialSizes?.(cli, { version: job.targetVersion, arch: pf.arch, musl: pf.musl }));
      } catch (err) {
        if (isCancel(err)) throw err;
        sizes = null;
      }
      const startedAt = now();
      let lastActivityAt = now();
      let lastSignature = null;
      let failures = 0;
      for (;;) {
        await abandonable(sleep(pollMs));
        const res = await abandonable(deps.remote(buildOfficialPollCommand(cli, remoteJobId), { timeoutMs: POLL_TIMEOUT_MS }));
        const poll = parsePoll(res?.stdout);
        if (!poll.complete) {
          failures += 1;
          if (failures >= maxPollFailures) {
            return { ok: false, abort: true, reason: `连续 ${failures} 次连不上服务器，停止跟踪（集群上的官方安装器可能仍在运行，稍后刷新查看版本）` };
          }
          continue;
        }
        failures = 0;
        if (poll.missing) return { ok: false, abort: true, reason: `集群上的安装任务目录不见了，无法确认官方安装器是否还在运行。${NO_FALLBACK_TEXT}` };
        if (poll.log.length) touch({ remoteLog: poll.log.slice(-40) });
        const dl = poll.downloads.reduce((best, d) => (!best || d.bytes > best.bytes ? d : best), null);
        if (dl) progress(dl.bytes, officialTotalFor(cli, dl.name, sizes));
        const signature = `${poll.downloads.map((d) => `${d.name}:${d.bytes}`).join(",")}|${poll.logSize}|${poll.activity}`;
        if (signature !== lastSignature) {
          lastSignature = signature;
          lastActivityAt = now();
        }
        if (poll.exitCode != null) return conclude(poll.exitCode);
        // 主进程不在了却没留下退出码（任务脚本被别人杀了）：它起的安装器可能还活着（setsid 起的整组）。
        // 同样先用结束命令把整组收拾掉并确认，再谈回退。
        if (!poll.alive) return stopThenFallBack("官方安装器意外退出");
        if (now() - lastActivityAt >= stallMs) return stopThenFallBack(`官方安装 ${Math.round(stallMs / 60000)} 分钟没有进展`);
        if (now() - startedAt >= maxOfficialMs) return stopThenFallBack(`官方安装超过 ${Math.round(maxOfficialMs / 60000)} 分钟`);
      }
    };
    try {
      return await track();
    } catch (err) {
      if (!isCancel(err)) throw err;
      // 取消：结束集群上的安装任务并确认（同卡住时那条幂等的结束命令）。
      touch({ cancelling: true, phaseText: "正在取消" });
      officialStop = await stopRemoteJob(remoteJobId, cancelStopAttempts);
      if (officialStop.stopped && officialStop.exitCode === 0) {
        // 来晚了：它已经自己跑完，新版本装上了。不谎报「已取消」，照常核对版本。
        officialStop = null;
        officialCompleted = true;
        touch({ cancelling: false, phaseText: PHASE_TEXT.official });
        event("取消请求到达时官方安装器已经跑完，照常核对版本");
        return conclude(0);
      }
      if (!officialStop.stopped) {
        officialUncertain = true;
        job.warnings.push(`没能确认集群上的官方安装器已经停止（${officialStop.detail}），它可能仍在运行；稍后刷新查看版本，再点一次安装会接着跟踪它。`);
      }
      throw err;
    }
  }
}

// 回滚：同步执行（几秒），→ { ok, result: "ok"|"failed", from, to, error }。
export async function runRollback(cli, { remote, target = null }) {
  const res = await remote(buildRollbackCommand(cli, target), { timeoutMs: POLL_TIMEOUT_MS * 2 });
  const { complete, values } = parseRemoteKv(res?.stdout);
  if (!complete) return { ok: false, result: "unknown", from: values.from || null, to: null, error: `回滚结果不确定（${sshReason(res)}），请刷新查看当前版本` };
  if (values.result !== "ok") {
    const code = values.detail;
    return { ok: false, result: "failed", from: values.from || null, to: null, error: FAIL_TEXT[code] || `回滚失败（${code || "未知原因"}）` };
  }
  return { ok: true, result: "ok", from: values.from || null, to: values.to || null, smoke: values.smoke || null, error: null };
}
