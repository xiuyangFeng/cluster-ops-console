// 发布到团队缓存（v2.89，管理员）：本机按官方清单下载同款产物（download.mjs，可续传、核 sha256）→
// 经 ssh 标准输入写进集群共享目录 `<hubDir>/cli-cache/<cli>/<版本>/`（team-cache.mjs 的发布命令再核一次）→
// 删掉更旧的版本（每个 CLI 留 2 个）。之后同事安装时直接在集群内拷贝（install.mjs 的团队缓存路径）。
//
// 与安装任务共用任务快照形状（createJobState，action="publish"、path="publish"）、任务表、取消接口与前端进度块；
// 不碰任何人的安装目录。取消：下载 / 上传各自接 AbortSignal 停下，再删本机安装包、清集群上自己的半截文件。
//
// deps：remote / upload / hubDir / resolveLatest / resolveArtifact / download / cleanup / now / log
//      （与 install.mjs 同名同形，由 install-service 的 buildInstallDeps 产出）
import { createProgressMeter } from "./install.mjs";
import { buildPreflightCommand, parsePreflight, parseRemoteKv } from "./remote-scripts.mjs";
import { claudePlatformFor, codexTargetFor } from "./sources.mjs";
import {
  buildCachePruneCommand,
  buildCachePublishCleanupCommand,
  buildCachePublishCommand,
  CACHE_PUBLISH_TEXT,
  cacheFileName,
  cacheListLines,
  isSafeHubDir,
  parseCacheEntries,
  versionsToPrune,
} from "./team-cache.mjs";
import { isStrictVersion } from "./versions.mjs";

export const PUBLISH_PHASE_TEXT = Object.freeze({
  queued: "排队中",
  preflight: "查看集群架构与团队缓存",
  resolve: "读取官方版本清单",
  download: "本机下载官方安装包",
  upload: "上传到团队缓存",
  prune: "清理更旧的缓存版本",
  done: "完成",
});

const PREFLIGHT_TIMEOUT_MS = 60000;
const SHORT_TIMEOUT_MS = 30000;
const MAX_EVENTS = 60;

const cancelError = () => Object.assign(new Error("已取消"), { code: "ECANCELLED" });
const isCancel = (err) => err?.code === "ECANCELLED";
const jobError = (message) => Object.assign(new Error(message), { code: "EJOB" });

function sshReason(res) {
  if (res?.timedOut) return "SSH 超时";
  const text = String(res?.stderr || "").trim().split("\n").filter(Boolean).pop();
  return text ? text.slice(0, 200) : `ssh 退出码 ${res?.code ?? "未知"}`;
}

export async function runPublishJob(job, deps, { signal = null, onUpdate = () => {} } = {}) {
  const now = deps.now || Date.now;
  const cli = job.cli;
  const meter = createProgressMeter({ now });
  const touch = (patch = {}) => {
    Object.assign(job, patch, { updatedAt: now() });
    onUpdate(job);
  };
  const event = (text) => {
    job.events.push({ at: now(), text });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    deps.log?.(`cli ${job.jobId} publish ${cli}: ${text}`);
    touch();
  };
  const phase = (name) => {
    meter.reset();
    touch({ phase: name, phaseText: PUBLISH_PHASE_TEXT[name] || name, path: "publish", progress: null });
  };
  const checkpoint = () => {
    if (signal?.aborted) throw cancelError();
  };
  const progress = (bytes, total) => {
    if (job.status === "running") touch({ progress: meter.update(bytes, total) });
  };

  let artifact = null;
  let version = null;
  let uploadTouched = false;
  const hubDir = deps.hubDir;

  try {
    checkpoint();
    if (!isSafeHubDir(hubDir)) throw jobError("没有可用的团队共享目录");
    if (!deps.upload) throw jobError("这台服务器不支持上传（密码连接），请先改用密钥登录");

    phase("preflight");
    const pfRes = await deps.remote(buildPreflightCommand(cli, { extraLines: cacheListLines(cli, hubDir) }), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    checkpoint();
    const pf = parsePreflight(cli, pfRes?.stdout);
    if (!pf.complete) throw jobError(`连不上服务器（${sshReason(pfRes)}）`);
    const target = cli === "codex" ? codexTargetFor(pf) : claudePlatformFor(pf);
    if (!target) throw jobError(`服务器架构 ${pf.arch || "未知"} 不在官方支持范围内`);
    const entries = parseCacheEntries(parseRemoteKv(pfRes?.stdout).lists.cache, cli);

    phase("resolve");
    version = job.targetVersion;
    if (!isStrictVersion(version)) {
      version = await deps.resolveLatest(cli);
      checkpoint();
      if (!isStrictVersion(version)) throw jobError("拿不到最新版本号，请检查本机出网设置");
      touch({ targetVersion: version });
    }
    const fileName = cacheFileName(cli, version, target);
    if (entries.some((e) => e.version === version && e.fileName === fileName)) {
      event(`团队缓存里已经有 ${job.label} ${version}，不用重复发布`);
      return finish(version);
    }
    artifact = await deps.resolveArtifact(cli, { version, arch: pf.arch, musl: pf.musl });
    checkpoint();
    if (artifact?.fileName !== fileName) throw jobError("官方产物文件名与缓存约定不一致");
    event(`官方清单：${artifact.fileName}（sha256 ${artifact.sha256.slice(0, 12)}…）`);

    phase("download");
    const dl = await deps.download(artifact, { onProgress: ({ bytes, total }) => progress(bytes, total), signal });
    checkpoint();
    event(dl.reused ? "本机已有校验通过的安装包，直接复用" : "本机下载完成，校验和与官方清单一致");

    phase("upload");
    uploadTouched = true;
    const res = await deps.upload({
      command: buildCachePublishCommand({ hubDir, cli, version, fileName, size: dl.size, sha256: dl.sha256 }),
      filePath: dl.filePath,
      size: dl.size,
      onProgress: (bytes) => progress(bytes, dl.size),
      signal,
    });
    checkpoint();
    const out = parseRemoteKv(res?.stdout).values.publish;
    if (out !== "ok") throw jobError(CACHE_PUBLISH_TEXT[out] || `上传没有完成（${sshReason(res)}）`);
    uploadTouched = false;
    event("已写入团队缓存，集群上复核 sha256 一致");
    await deps.cleanup?.(artifact);

    const stale = versionsToPrune([...entries, { version, fileName, size: dl.size }]);
    const prune = buildCachePruneCommand({ hubDir, cli, versions: stale });
    if (prune) {
      phase("prune");
      const pr = parseRemoteKv((await deps.remote(prune, { timeoutMs: SHORT_TIMEOUT_MS }))?.stdout);
      const pruned = pr.lists.pruned || [];
      if (pruned.length) event(`已删除更旧的缓存版本：${pruned.join("、")}`);
      if (pruned.length < stale.length) job.warnings.push(`有 ${stale.length - pruned.length} 个旧版本不是你发布的，没有删除`);
    }
    return finish(version);
  } catch (err) {
    if (isCancel(err) || signal?.aborted) return finishCancelled();
    if (uploadTouched) await cleanupRemote();
    touch({ status: "failed", cancellable: false, error: String(err?.message || err), finishedAt: now(), phaseText: "失败" });
    event(`失败：${job.error}`);
    return job;
  }

  function finish(v) {
    touch({ status: "succeeded", cancellable: false, installedVersion: v, phase: "done", phaseText: PUBLISH_PHASE_TEXT.done, finishedAt: now() });
    event(`${job.label} ${v} 已在团队缓存，同事安装时会直接在集群内拷贝`);
    return job;
  }

  async function cleanupRemote() {
    if (!artifact || !version) return;
    try {
      await deps.remote(buildCachePublishCleanupCommand({ hubDir, cli, version, fileName: artifact.fileName }), { timeoutMs: SHORT_TIMEOUT_MS });
    } catch {
      // 半截文件只有发布者自己能删，下次发布同版本时也会覆盖
    }
  }

  async function finishCancelled() {
    touch({ cancelling: true, cancellable: false, phaseText: "正在取消", progress: null });
    if (artifact) {
      try {
        await deps.cleanup?.(artifact);
      } catch {
        // 留给下载目录的 3 天清理
      }
    }
    if (uploadTouched) await cleanupRemote();
    touch({ status: "cancelled", cancelling: false, error: null, finishedAt: now(), phaseText: "已取消" });
    event("已取消，团队缓存里原有的版本没有动");
    return job;
  }
}
