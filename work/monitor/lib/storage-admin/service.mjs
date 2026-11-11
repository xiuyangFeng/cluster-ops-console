// 管理员存储视图服务：root 或 adminUsers 里的账号可用；远端以 root 经专用受限密钥执行只读脚本。
//
//   overview()                    读本机已存的一切（不发 SSH）：每台机器的挂载点容量、按用户占用、扫描任务、安装状态
//   refresh(targetId)             发 SSH：info + 开了配额的挂载点各一次 repquota
//   ensureKey()                   本机还没有专用密钥就生成一把（ssh-keygen ed25519，无口令，0600）
//   installer(targetId)           生成该机器的安装脚本（写到本机 0600 文件）并给出在终端执行的那一行
//   startUsage(targetId, mount)   服务器上后台按用户统计整块 ext 盘（读 inode 表，几分钟到十几分钟，只给每人合计）
//   startScan / stopScan          服务器上后台整树扫描（同一台机器同一时刻只有一个）；运行期间这里每 5 秒问一次进度，
//                                 结束后取回完整结果存本机
//   scanView(targetId, jobId, rel) 从本机结果里取某一层（不发 SSH）
//   list(targetId, path, jobId)   发 SSH 列一层目录（即时、有界），有扫描结果时并上整树大小
// SSH 走调度器的全局槽位（acquireSshSlot），与探针共用并发上限。
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "../atomic-file.mjs";
import { activityServer, observeUserActivity } from "./activity.mjs";
import { isSafeRoot, MAX_TARGETS, resolveIdentityFile, resolveTargets, storageTargetDraft } from "./config.mjs";
import { buildInstallCommand, buildInstallScript, buildUninstallScript, parsePublicKey, scriptVersion, REMOTE_SCRIPT_PATH } from "./install.mjs";
import { attachPersonalSsh, buildPinnedProbeSshArgs } from "../ssh-args.mjs";
import { createHash } from "node:crypto";
import { buildScanView, buildUsersView, mergeListWithScan, pickMounts } from "./model.mjs";
import {
  buildRootSshArgs, isAbsNormal, isJobId, isRelPath, MAX_OUT_BYTES, parseInfo, parseJobReply, parseList,
  parseQuota, parseScanResult, REMOTE_ERROR_TEXT, RESULT_TIMEOUT_MS, SSH_TIMEOUT_MS,
} from "./protocol.mjs";

export const REMOTE_SCRIPT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "remote", "storage-admin.py");
export const POLL_MS = 5000;
const OWNERS_KEEP = 300;

const fail = (message, status, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const under = (p, root) => p === root || p.startsWith(`${root}/`);

// ssh 失败 → { code, message }（给界面一句能照着做的话）。
export function classifySshFailure(res, target) {
  const stderr = String(res?.stderr || "");
  const where = `${target.sshUser || "root"}@${target.host}`;
  if (/auth-required|password-unsupported|config-changed|route-invalid/.test(stderr)) return { code: "auth", message: `连接 ${where} 的凭据或路径不可用，请在服务器管理中检查并重新输入密码` };
  if (res?.timedOut) return { code: "timeout", message: `连接 ${where} 超时` };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|No .* host key is known/i.test(stderr)) {
    return { code: "host-key", message: `本机还没有记下 ${target.host} 的主机指纹（或指纹变了）：在终端运行一次安装命令，按提示核对并确认指纹` };
  }
  if (/Permission denied/i.test(stderr)) return { code: "auth", message: `专用密钥还没有装到 ${where}：按「接入步骤」在终端运行安装命令` };
  if (/Identity file .* not accessible|no such identity|Load key .*: No such file/i.test(stderr)) {
    return { code: "no-key", message: "本机还没有专用密钥：先点「生成密钥」" };
  }
  if (/Connection refused|No route to host|Could not resolve|Network is unreachable|Connection timed out|Operation timed out/i.test(stderr)) {
    return { code: "unreachable", message: `连不上 ${target.host}:${target.port}` };
  }
  const line = stderr.split("\n").map((l) => l.trim()).filter(Boolean).pop() || `退出码 ${res?.code ?? "?"}`;
  return { code: "ssh-failed", message: `SSH 失败：${line.slice(0, 200)}` };
}

export function createStorageAdminService({
  getConfig, isAdmin, store, exec, acquireSshSlot = null, dir, dataDir, log = null, platform = process.platform,
  savePersonalConfig = null,
  getActivityFacts = () => null,
  now = Date.now, homeDir, scriptFile = REMOTE_SCRIPT_FILE,
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer = (t) => clearTimeout(t),
}) {
  const pollers = new Map(); // targetId → timer
  const busy = new Set();    // 正在 refresh 的机器
  let scriptCache = null;
  let viewCache = null;      // { key, entry } 最近一次打开的扫描结果

  async function context() {
    const config = (await getConfig()) || {};
    if (!isAdmin(config)) throw fail("只有 root 或团队管理员（adminUsers）可以使用存储管理", 403, "forbidden");
    return { config, targets: resolveTargets(config), identityFile: resolveIdentityFile(config, homeDir ? { homeDir } : {}) };
  }

  async function findTarget(targetId) {
    const ctx = await context();
    const target = ctx.targets.find((t) => t.id === targetId);
    if (!target) throw fail("没有这台机器（检查 config.local.json 的 storageAdmin.targets）", 404);
    if (!ctx.identityFile) throw fail("专用密钥路径无效（storageAdmin.identityFile）", 400);
    const bindingKey = targetBinding(target, ctx.config);
    const saved = await store.getTarget(target.id);
    if (saved.bindingKey !== bindingKey && (saved.bindingKey || target.connectionId)) {
      await store.patchTarget(target.id, { bindingKey, info: null, error: null, checkedAt: null, scans: [], jobs: [], quota: {}, activity: {} });
      viewCache = null;
    } else if (!saved.bindingKey) await store.patchTarget(target.id, { bindingKey });
    return { ...ctx, target };
  }

  function targetBinding(target, config) {
    const connection = config.servers?.find((s) => s.id === target.connectionId);
    const jump = config.servers?.find((s) => s.id === connection?.sshJumpServerId);
    const route = connection ? [jump, connection].filter(Boolean).map((s) => attachPersonalSsh(s, config)) : [];
    return createHash("sha256").update(JSON.stringify([target.host, target.port, target.roots, target.connectionId || "", route])).digest("hex");
  }

  async function script() {
    scriptCache ??= await readFile(scriptFile, "utf8");
    return scriptCache;
  }

  async function ssh(target, identityFile, command, { input = "", timeoutMs = SSH_TIMEOUT_MS } = {}) {
    const config = await getConfig();
    const binding = targetBinding(target, config);
    const connection = config.servers?.find((s) => s.id === target.connectionId && !s.disabled);
    if (target.connectionId && !connection) throw fail("连接已变更或停用，请重新选择节点账号", 409);
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: `${target.sshUser || "root"}@${target.host}` }) : () => {};
    try {
      const args = connection
        ? [...buildPinnedProbeSshArgs(connection, config, { dataDir, platform }), `python3 ${REMOTE_SCRIPT_PATH} ${command}`]
        : buildRootSshArgs(target, identityFile, command, { platform });
      const result = await exec("ssh", args, { input, timeoutMs, maxOutputBytes: MAX_OUT_BYTES, ...(connection ? { server: connection } : {}) });
      if (targetBinding(target, await getConfig()) !== binding) throw fail("连接已变更，已丢弃本次结果，请重新检测", 409);
      return result;
    } finally {
      release();
    }
  }

  // 远端回了 err 或输出不可解析 → 抛出带界面文案的错误。
  function remoteFailure(res, parsed, target) {
    if (parsed?.code && parsed.code !== "no-output" && parsed.code !== "bad-output") {
      return fail(REMOTE_ERROR_TEXT[parsed.code] || "服务器端脚本报错", parsed.code === "busy" ? 409 : 502, parsed.code);
    }
    if (res?.code !== 0 || !String(res?.stdout || "").trim()) {
      const f = classifySshFailure(res, target);
      return fail(f.message, 502, f.code);
    }
    return fail("服务器端脚本的输出无法识别（版本不一致？请重新安装）", 502, "bad-output");
  }

  async function keyStatus(identityFile) {
    if (!identityFile) return { identityFile: null, exists: false, publicKey: null };
    const exists = existsSync(identityFile);
    let publicKey = null;
    try {
      publicKey = parsePublicKey(await readFile(`${identityFile}.pub`, "utf8"));
    } catch {}
    return { identityFile, exists, publicKey };
  }

  async function targetView(target) {
    let saved = await store.getTarget(target.id);
    const config = await getConfig();
    const bindingKey = targetBinding(target, config);
    if (saved.bindingKey !== bindingKey && (saved.bindingKey || target.connectionId)) saved = {};
    const expected = scriptVersion(await script());
    const remoteRoots = saved.info?.roots || [];
    const roots = target.roots.flatMap((root) => {
      const exact = remoteRoots.find((r) => r.path === root);
      return exact ? [exact] : remoteRoots.some((r) => under(root, r.path)) ? [{ path: root, children: null }] : [];
    });
    const info = saved.info ? { ...saved.info, roots, mounts: pickMounts(saved.info.mounts, target.roots) } : null;
    let status = saved.error ? { state: "error", ...saved.error } : info ? { state: "ok" } : { state: "unknown" };
    if (info && info.version !== expected && !saved.error) status = { state: "outdated", message: `服务器端脚本是版本 ${info.version}，本机是 ${expected}：重新运行安装命令升级` };
    if (info && !saved.error && target.roots.some((root) => !remoteRoots.some((r) => under(root, r.path)))) {
      status = { state: "outdated", code: "roots-update", message: "目录范围已保存，服务器授权尚未同步：重新生成并运行安装命令，再点检测。原有扫描结果保留。" };
    }
    const scans = Array.isArray(saved.scans) ? saved.scans : [];
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    const server = activityServer(target, config);
    const facts = server ? getActivityFacts(server.id, config) : null;
    const activity = observeUserActivity({ users: info?.users, infoHost: info?.host, ...facts, previous: saved.activity || {}, now: now() });
    if (JSON.stringify(activity.records) !== JSON.stringify(saved.activity || {})) await store.patchTarget(target.id, { activity: activity.records });
    return {
      id: target.id, label: target.label, host: target.host, port: target.port, roots: target.roots,
      ...(target.connectionId ? { connectionId: target.connectionId, sshUser: target.sshUser, sshJumpServerId: target.sshJumpServerId } : {}),
      status, checkedAt: saved.checkedAt ?? null, info,
      users: buildUsersView({ info, quota: saved.quota || {}, scans, activity: activity.byUid }),
      running: jobs.find((j) => j.state === "running") || null,
      jobs,
      scans: scans.map((s) => s.job),
      refreshing: busy.has(target.id),
    };
  }

  async function overview() {
    const { config, targets, identityFile } = await context();
    return {
      key: await keyStatus(identityFile),
      expectedVersion: scriptVersion(await script()),
      targets: await Promise.all(targets.map(targetView)),
      setup: typeof savePersonalConfig === "function" ? storageTargetDraft(config) : null,
      connections: (config.servers || []).filter((s) => !s.disabled && s.monitorEnabled !== false).map((s) => ({ id: s.id, name: s.name || s.host, host: s.sshHostName || s.host, port: s.sshPort || 22, sshUser: attachPersonalSsh(s, config).sshUser || "", sshJumpServerId: s.sshJumpServerId || "" })),
    };
  }

  async function configureTarget(input) {
    const { config, targets } = await context();
    if (typeof savePersonalConfig !== "function") throw fail("当前环境不支持保存存储配置", 503);
    if (!input || !Array.isArray(input.roots) || !input.roots.length || input.roots.length > 8 || !input.roots.every(isSafeRoot)) throw fail("请输入 1 至 8 个允许查看的绝对目录，例如 /home、/public；不支持根目录 /", 400);
    const target = resolveTargets({ ...config, storageAdmin: { targets: [input] } })[0];
    if (!target) throw fail("服务器标识、地址或 SSH 端口无效", 400);
    const rest = targets.filter((t) => t.id !== target.id);
    const previous = targets.find((t) => t.id === target.id);
    if (previous && targetBinding({ ...previous, roots: target.roots }, config) !== targetBinding(target, config)) throw fail("请使用新的服务器标识保存另一个节点或账号，避免混用历史扫描数据", 400);
    const scopeChanged = Boolean(previous && JSON.stringify([...previous.roots].sort()) !== JSON.stringify([...target.roots].sort()));
    if (previous && !scopeChanged) target.roots = previous.roots;
    let retained = null;
    if (scopeChanged) {
      const saved = await store.getTarget(target.id);
      if (busy.has(target.id) || saved.jobs?.some((job) => job.state === "running")) throw fail("正在检测或扫描这个节点，请结束后再修改目录范围", 409);
      // 仅改变目录范围时保留同一连接的扫描；账号或路由已变的缓存不能借此重新绑定。
      const sameBinding = saved.bindingKey === targetBinding(previous, config) || (!saved.bindingKey && !previous.connectionId);
      retained = sameBinding ? saved : { info: null, checkedAt: null, quota: {}, activity: {} };
      retained = { ...retained, error: null, bindingKey: targetBinding(target, config),
        scans: (sameBinding ? saved.scans || [] : []).filter((s) => target.roots.some((root) => under(s.job?.root || "", root))),
        jobs: (sameBinding ? saved.jobs || [] : []).filter((job) => target.roots.some((root) => under(job.root || "", root))) };
    }
    if (rest.length >= MAX_TARGETS) throw fail(`最多配置 ${MAX_TARGETS} 台存储服务器`, 400);
    await savePersonalConfig({ storageAdmin: { ...config.storageAdmin, targets: [...rest, target] } });
    if (retained) { await store.patchTarget(target.id, retained); viewCache = null; }
    return { saved: true, target, scopeChanged };
  }

  async function refresh(targetId) {
    const { target, identityFile } = await findTarget(targetId);
    if (busy.has(targetId)) throw fail("正在刷新，请稍候", 409);
    busy.add(targetId);
    try {
      const res = await ssh(target, identityFile, "info");
      const parsed = parseInfo(res?.stdout);
      if (!parsed.ok) {
        const error = remoteFailure(res, parsed, target);
        await store.patchTarget(targetId, { error: { code: error.code || "error", message: error.message }, checkedAt: now() });
        log?.(`storage-admin refresh ${targetId} failed: ${error.message}`, { level: "warn", event: "storage-admin" });
        return targetView(target);
      }
      const info = parsed.info;
      const quota = {};
      if (info.repquota) {
        for (const m of info.mounts.filter((x) => x.quota)) {
          const qr = await ssh(target, identityFile, "quota", { input: JSON.stringify({ mount: m.mount }), timeoutMs: RESULT_TIMEOUT_MS });
          const q = parseQuota(qr?.stdout, { mount: m.mount });
          if (q.ok) quota[m.mount] = q.quota;
        }
      }
      await store.patchTarget(targetId, { info, quota, error: null, checkedAt: now(), jobs: info.jobs });
      if (info.jobs.some((j) => j.state === "running")) schedulePoll(targetId, 0);
      else await collectFinished(target, identityFile, info.jobs);
      return targetView(target);
    } finally {
      busy.delete(targetId);
    }
  }

  // 服务器上已结束、本机还没取回的任务：取回结果（例如工作台关着的时候扫完了）。
  async function collectFinished(target, identityFile, jobs) {
    const saved = await store.getTarget(target.id);
    const have = new Set((saved.scans || []).map((s) => s.job.id));
    for (const job of jobs) {
      if (["done", "stopped"].includes(job.state) && !have.has(job.id)) {
        await fetchResult(target, identityFile, job.id).catch(() => {});
        break; // 一次只补一份，其余下次刷新再补
      }
    }
  }

  async function fetchResult(target, identityFile, jobId) {
    const res = await ssh(target, identityFile, "scan-result", { input: JSON.stringify({ job: jobId }), timeoutMs: RESULT_TIMEOUT_MS });
    const parsed = parseScanResult(res?.stdout, { job: jobId });
    if (!parsed.ok) throw remoteFailure(res, parsed, target);
    if (!parsed.result) return null;
    const entry = { job: parsed.job, result: parsed.result, fetchedAt: now() };
    const kept = await store.putScan(target.id, entry);
    const saved = await store.getTarget(target.id);
    const names = parsed.result.names;
    const summary = {
      job: parsed.job,
      owners: parsed.result.owners.slice(0, OWNERS_KEEP).map(([uid, bytes, files, lastWrite]) => ({
        uid, name: names[String(uid)] ?? null, bytes, files, lastWrite: lastWrite ?? null, share: parsed.job.bytes > 0 ? bytes / parsed.job.bytes : 0,
      })),
    };
    const scans = [summary, ...(saved.scans || []).filter((s) => s.job.id !== jobId)].filter((s) => !kept || kept.includes(s.job.id));
    await store.patchTarget(target.id, { scans });
    log?.(`storage-admin scan ${target.id} ${jobId} ${parsed.job.state}: ${parsed.job.entries} entries, ${parsed.result.records.length} dirs kept`, { level: "info", event: "storage-admin" });
    return entry;
  }

  async function updateJob(targetId, job) {
    const saved = await store.getTarget(targetId);
    const jobs = [job, ...(saved.jobs || []).filter((j) => j.id !== job.id)].slice(0, 20);
    await store.patchTarget(targetId, { jobs });
  }

  function schedulePoll(targetId, delay = POLL_MS) {
    if (pollers.has(targetId)) return;
    pollers.set(targetId, setTimer(() => {
      pollers.delete(targetId);
      poll(targetId).catch(() => {});
    }, delay));
  }

  async function poll(targetId) {
    let ctx;
    try {
      ctx = await findTarget(targetId);
    } catch {
      return; // 不再是管理员 / 机器从配置里删了：停止轮询
    }
    const { target, identityFile } = ctx;
    const saved = await store.getTarget(targetId);
    const running = (saved.jobs || []).find((j) => j.state === "running");
    if (!running) return;
    const res = await ssh(target, identityFile, "scan-status", { input: JSON.stringify({ job: running.id }) });
    const parsed = parseJobReply(res?.stdout);
    if (!parsed.ok) {
      // 暂时连不上：过一会儿再问；任务不在了：标成丢失。
      if (parsed.code === "no-job") await updateJob(targetId, { ...running, state: "lost" });
      else schedulePoll(targetId, POLL_MS * 3);
      return;
    }
    await updateJob(targetId, parsed.job);
    if (parsed.job.state === "running") {
      schedulePoll(targetId);
      return;
    }
    if (["done", "stopped"].includes(parsed.job.state)) {
      try {
        await fetchResult(target, identityFile, parsed.job.id);
      } catch (error) {
        log?.(`storage-admin fetch result ${targetId} failed: ${error.message}`, { level: "warn", event: "storage-admin" });
      }
    }
  }

  async function startScan(targetId, root) {
    const { target, identityFile } = await findTarget(targetId);
    if (!isAbsNormal(root) || !target.roots.some((r) => under(root, r))) throw fail("只能扫描允许范围内的目录", 400);
    const res = await ssh(target, identityFile, "scan-start", { input: JSON.stringify({ root }) });
    const parsed = parseJobReply(res?.stdout);
    if (!parsed.ok) {
      if (parsed.job) await updateJob(targetId, parsed.job);
      throw remoteFailure(res, parsed, target);
    }
    await updateJob(targetId, parsed.job);
    log?.(`storage-admin scan started on ${targetId}: ${root} (${parsed.job.id})`, { level: "info", event: "storage-admin" });
    if (parsed.job.state === "running") schedulePoll(targetId);
    else await fetchResult(target, identityFile, parsed.job.id).catch(() => {});
    return targetView(target);
  }

  // 按用户统计整块 ext 盘：服务器上只读、顺序、限速地读 inode 表（v2 脚本的 usage-start）。
  async function startUsage(targetId, mount) {
    const { target, identityFile } = await findTarget(targetId);
    const saved = await store.getTarget(targetId);
    const m = pickMounts(saved.info?.mounts || [], target.roots).find((x) => x.mount === mount);
    if (!m) throw fail("没有这块盘（先点「刷新」）", 400);
    if (!m.inodeScan?.ok) throw fail(m.inodeScan ? REMOTE_ERROR_TEXT[m.inodeScan.code] || "这块盘不能按 inode 表统计" : "服务器端脚本版本过旧：重新运行安装命令升级", 409);
    const res = await ssh(target, identityFile, "usage-start", { input: JSON.stringify({ mount }) });
    const parsed = parseJobReply(res?.stdout);
    if (!parsed.ok) {
      if (parsed.job) await updateJob(targetId, parsed.job);
      throw remoteFailure(res, parsed, target);
    }
    await updateJob(targetId, parsed.job);
    log?.(`storage-admin inode usage started on ${targetId}: ${mount} (${parsed.job.id})`, { level: "info", event: "storage-admin" });
    if (parsed.job.state === "running") schedulePoll(targetId);
    else await fetchResult(target, identityFile, parsed.job.id).catch(() => {});
    return targetView(target);
  }

  async function stopScan(targetId, jobId) {
    const { target, identityFile } = await findTarget(targetId);
    if (!isJobId(jobId)) throw fail("扫描任务号无效", 400);
    const res = await ssh(target, identityFile, "scan-stop", { input: JSON.stringify({ job: jobId }) });
    const parsed = parseJobReply(res?.stdout);
    if (!parsed.ok) throw remoteFailure(res, parsed, target);
    await updateJob(targetId, parsed.job);
    schedulePoll(targetId, 1500);
    return targetView(target);
  }

  async function loadScan(targetId, jobId) {
    const saved = await store.getTarget(targetId);
    if (saved.bindingKey && !(saved.scans || []).some((s) => s.job?.id === jobId)) return null;
    const key = `${targetId}/${jobId}`;
    if (viewCache?.key === key) return viewCache.entry;
    const entry = await store.getScan(targetId, jobId);
    if (entry) viewCache = { key, entry };
    return entry;
  }

  async function scanView(targetId, jobId, rel = "") {
    await findTarget(targetId);
    if (!isJobId(jobId) || !isRelPath(rel)) throw fail("参数无效", 400);
    const entry = await loadScan(targetId, jobId);
    if (!entry) throw fail("本机没有这份扫描结果", 404);
    const view = buildScanView(entry, rel);
    if (!view) throw fail("这一层不在扫描结果里（可能小于阈值）", 404);
    return view;
  }

  async function list(targetId, dirPath, jobId = null) {
    const { target, identityFile } = await findTarget(targetId);
    if (!isAbsNormal(dirPath) || !target.roots.some((r) => under(dirPath, r))) throw fail("只能查看允许范围内的目录", 400);
    const res = await ssh(target, identityFile, "list", { input: JSON.stringify({ path: dirPath }) });
    const parsed = parseList(res?.stdout, { path: dirPath });
    if (!parsed.ok) throw remoteFailure(res, parsed, target);
    let entry = null;
    let rel = null;
    if (isJobId(jobId)) {
      entry = await loadScan(targetId, jobId);
      if (entry && under(dirPath, entry.job.root)) rel = dirPath === entry.job.root ? "" : dirPath.slice(entry.job.root.length + 1);
      else entry = null;
    }
    return mergeListWithScan(parsed.list, entry, rel ?? "");
  }

  async function ensureKey() {
    const { identityFile } = await context();
    if (!identityFile) throw fail("专用密钥路径无效（storageAdmin.identityFile）", 400);
    if (!existsSync(identityFile)) {
      await mkdir(path.dirname(identityFile), { recursive: true, mode: 0o700 });
      const res = await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "codex-storage-admin", "-f", identityFile], { timeoutMs: 20_000 });
      if (res?.code !== 0) throw fail(`生成密钥失败：${String(res?.stderr || "").trim().slice(0, 200) || `退出码 ${res?.code}`}`, 500);
      log?.(`storage-admin generated key ${identityFile}`, { level: "info", event: "storage-admin" });
    }
    return keyStatus(identityFile);
  }

  async function installer(targetId) {
    const { target, identityFile } = await findTarget(targetId);
    const key = await keyStatus(identityFile);
    if (!key.exists || !key.publicKey) throw fail("本机还没有专用密钥：先点「生成密钥」", 409, "no-key");
    const body = buildInstallScript({ publicKey: key.publicKey, roots: target.roots, source: await script() });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `install-${target.id}.sh`);
    const undo = path.join(dir, "uninstall.sh");
    await writeFileAtomic(file, body);
    await writeFileAtomic(undo, buildUninstallScript(key.publicKey));
    return {
      targetId: target.id,
      scriptPath: file,
      command: buildInstallCommand(target, file, { platform }),
      uninstallCommand: buildInstallCommand(target, undo, { platform }),
      shell: platform === "win32" ? "cmd" : "sh",
      version: scriptVersion(await script()),
    };
  }

  // 启动后：有记录在跑的任务就接着问进度（工作台重启前开始的扫描）。
  async function resume() {
    try {
      const { targets } = await context();
      for (const t of targets) {
        const saved = await store.getTarget(t.id);
        if ((saved.jobs || []).some((j) => j.state === "running")) schedulePoll(t.id, POLL_MS);
      }
    } catch {}
  }

  function stop() {
    for (const t of pollers.values()) clearTimer(t);
    pollers.clear();
  }

  return { overview, configureTarget, refresh, ensureKey, installer, startScan, startUsage, stopScan, scanView, list, resume, stop };
}
