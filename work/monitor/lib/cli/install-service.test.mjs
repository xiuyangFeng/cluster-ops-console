import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createCliInstallService, mergeCliState } from "./install-service.mjs";
import { runInstallJob } from "./install.mjs";
import { createCliService } from "./service.mjs";
import { createCliTaskLock } from "./task-lock.mjs";
import { buildCodexPackage, envFor, fakeRemote, installFakeCurl, makeHome, runLocal, writeEnvSh, writeFakeCodexInstaller } from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;

const TEAM = { id: "server-01", name: "集群", host: "myserver" };
const PERSONAL = { id: "tx", host: "tx", source: "personal" };

function makeService({ server = TEAM, runJob, rollbackImpl, latest = { codex: "0.160.1", claude: "2.1.292" }, taskLock, now } = {}) {
  const logs = [];
  const svc = createCliInstallService({
    getConfig: async () => ({ servers: [server] }),
    getMainServerConfig: () => server,
    sshArgsFor: () => ["-o", "BatchMode=yes", server.host],
    execCollector: async () => ({ code: 0, stdout: "", stderr: "" }),
    versions: { getLatest: async () => ({ codex: { latest: latest.codex, checkedAt: 1, error: null }, claude: { latest: latest.claude, checkedAt: 1, error: null } }) },
    downloadDir: "/nonexistent",
    log: (text) => logs.push(text),
    ...(runJob ? { runJob } : {}),
    ...(rollbackImpl ? { rollbackImpl } : {}),
    ...(taskLock ? { taskLock } : {}),
    ...(now ? { now } : {}),
  });
  return { svc, logs };
}

const tick = () => new Promise((r) => setImmediate(r));

test("mergeCliState：探针结果比覆盖层新就用探针，否则覆盖层的版本胜出（登录字段保留探针的）", () => {
  const probe = { installed: true, version: "0.159.2", kind: "standalone", path: "/x", login: "chatgpt", loginDetail: null, checkedAt: 100 };
  assert.equal(mergeCliState(probe, { installed: true, version: "0.160.1", at: 50 }).version, "0.159.2");
  const merged = mergeCliState(probe, { installed: true, version: "0.160.1", kind: "standalone", path: "~/.local/bin/codex", at: 200 });
  assert.deepEqual([merged.version, merged.login], ["0.160.1", "chatgpt"]);
  assert.equal(mergeCliState(null, null).login, "unknown");
});

test("概览：合并 P-G 探针状态与最新版本 → updateAvailable", async () => {
  const { svc } = makeService();
  const view = await svc.overview(null, {
    getCliState: () => ({ serverId: "server-01", checkedAt: 5, clis: { codex: { installed: true, version: "0.159.2", kind: "standalone", path: "/p", login: "chatgpt", loginDetail: null } } }),
  });
  assert.equal(view.eligible, true);
  assert.equal(view.clis.codex.updateAvailable, true);
  assert.equal(view.clis.codex.latest, "0.160.1");
  assert.equal(view.clis.claude.installed, null, "探针没给 → 未知");
  assert.equal(view.clis.claude.updateAvailable, false);
  assert.equal(view.job, null);
});

test("概览：个人服务器不支持；serverId 与活跃服务器不符 → 409", async () => {
  const personal = makeService({ server: PERSONAL }).svc;
  assert.equal((await personal.overview()).eligible, false);
  await assert.rejects(personal.startInstall("codex"), (err) => err.status === 404);
  const { svc } = makeService();
  await assert.rejects(svc.overview("server-02"), (err) => err.status === 409);
  await assert.rejects(svc.startInstall("npm"), (err) => err.status === 400);
  await assert.rejects(svc.startInstall("codex", { mode: "fast" }), (err) => err.status === 400);
});

test("安装：返回 jobId；同一台服务器同时只允许一个任务（与登录共用锁）；结束后释放、补跑探针、覆盖层显示新版本", async () => {
  let finish;
  const runJob = (job) => new Promise((resolve) => {
    finish = () => {
      Object.assign(job, { status: "succeeded", installedVersion: "0.160.1", path: "official", finishedAt: Date.now() });
      resolve(job);
    };
  });
  const lock = createCliTaskLock();
  const { svc } = makeService({ runJob, taskLock: lock });
  const forced = [];
  const runtime = { onCliChanged: (id, info) => forced.push([id, info]) };
  const { jobId, job } = await svc.startInstall("codex", { serverId: "server-01" }, runtime);
  assert.match(jobId, /^cli-/);
  assert.equal(job.targetVersion, "0.160.1");
  assert.equal(svc.getJob(jobId).status, "running");
  await assert.rejects(svc.startInstall("claude"), (err) => err.status === 409 && /codex/.test(err.message));
  assert.throws(() => lock.acquire("server-01", { kind: "login" }), /安装 \/ 更新/);
  assert.equal((await svc.overview()).busy.kind, "install");

  finish();
  await tick();
  await tick();
  assert.deepEqual(forced, [["server-01", { cli: "codex", ok: true }]]);
  const view = await svc.overview(null, { getCliState: () => null });
  assert.equal(view.busy, null);
  assert.equal(view.job.status, "succeeded");
  assert.equal(view.clis.codex.version, "0.160.1");
  assert.equal(view.clis.codex.updateAvailable, false);
  assert.equal(svc.getJob("nope"), null);
});

// 评审后续（v2.57）：探测快照与覆盖层按「扫描开始」的时刻比新旧。
// 真实的探测服务 + 真实的安装服务，同一只可拨的钟；探测的 SSH 由测试决定何时返回、返回什么。
function probeHarness(now) {
  const pending = [];
  const probe = createCliService({
    getConfig: async () => ({ servers: [TEAM] }),
    dataDir: "/nonexistent-cli",
    now,
    execCollector: () => new Promise((resolve) => { pending.push((stdout) => resolve({ code: 0, stdout, stderr: "" })); }),
  });
  const codexAt = (version) => [
    "__CLI_BEGIN__",
    "codex.installed=1",
    `codex.path=/h/.codex/packages/standalone/releases/${version}-x86_64-unknown-linux-musl/bin/codex`,
    `codex.version=codex-cli ${version}`,
    "claude.installed=0",
    "__CLI_END__",
  ].join("\n");
  return { probe, answer: (version) => pending.shift()(codexAt(version)) };
}

test("探测与安装交错：安装完成前就开始、完成后才结束的一轮探测不压过覆盖层；之后才开始的探测照常为准", async () => {
  let clock = 1000;
  const now = () => clock;
  const { probe, answer } = probeHarness(now);
  let finish;
  const runJob = (job) => new Promise((resolve) => {
    finish = () => {
      Object.assign(job, { status: "succeeded", installedVersion: "0.160.1", path: "official", finishedAt: now() });
      resolve(job);
    };
  });
  const { svc } = makeService({ runJob, now });
  const runtime = { getCliState: (serverId) => probe.getSnapshot(serverId), onCliChanged: () => {} };

  // t=1000 周期探测发出 SSH（远端此刻还是 0.159.2）；t=2000 开始更新；t=3000 更新完成；
  // t=4000 那一轮探测才回来——带着安装之前读到的旧版本。
  const stale = probe.runScan("server-01");
  await tick();
  clock = 2000;
  await svc.startInstall("codex", { serverId: "server-01" }, runtime);
  clock = 3000;
  finish();
  await tick();
  await tick();
  clock = 4000;
  answer("0.159.2");
  assert.equal((await stale).level, "ok");
  assert.deepEqual([probe.getSnapshot("server-01").startedAt, probe.getSnapshot("server-01").checkedAt], [1000, 4000]);

  const view = await svc.overview(null, runtime);
  assert.equal(view.clis.codex.version, "0.160.1", "结束得晚不等于内容新：这一轮读到的是安装之前的状态");
  assert.equal(view.clis.codex.updateAvailable, false);
  assert.equal(view.checkedAt, 4000, "对外的检查时间仍是结果到手的时刻");
  assert.ok(!("startedAt" in view.clis.codex) && !("checkedAt" in view.clis.codex), "每个 CLI 的状态里不带探测时刻");

  // t=5000 下一轮探测在安装之后才开始：以探测到的事实为准（真实路径取代覆盖层的占位路径）
  clock = 5000;
  const fresh = probe.runScan("server-01");
  await tick();
  clock = 5500;
  answer("0.160.1");
  await fresh;
  const after = await svc.overview(null, runtime);
  assert.equal(after.clis.codex.version, "0.160.1");
  assert.match(after.clis.codex.path, /releases\/0\.160\.1-/);
});

test("mergeCliState：有 startedAt 时按它比，没有（旧形状）回落 checkedAt；返回值不带 startedAt", () => {
  const overlay = { installed: true, version: "0.160.1", kind: "standalone", path: "~/.local/bin/codex", at: 300 };
  const probe = { installed: true, version: "0.159.2", kind: "standalone", path: "/x", login: "chatgpt", loginDetail: null };
  const crossed = mergeCliState({ ...probe, startedAt: 100, checkedAt: 400 }, overlay);
  assert.equal(crossed.version, "0.160.1");
  assert.ok(!("startedAt" in crossed));
  assert.equal(mergeCliState({ ...probe, startedAt: 300, checkedAt: 400 }, overlay).version, "0.159.2", "安装完成的同一刻才开始的探测读到的已是新状态");
  assert.equal(mergeCliState({ ...probe, checkedAt: 400 }, overlay).version, "0.159.2");
  assert.equal(mergeCliState({ ...probe, startedAt: undefined, checkedAt: 200 }, overlay).version, "0.160.1");
});

test("offPath（装了但不在非交互 PATH）：概览原样透传；工作台装好之后的覆盖层把这句过时的结论拿掉", async () => {
  const offPath = "~/.nvm/versions/node/v22.11.0/bin/codex";
  const probed = { installed: false, version: null, kind: null, path: null, login: "chatgpt", loginDetail: "ChatGPT 账号", npmGlobal: false, offPath };
  const { svc } = makeService();
  const view = await svc.overview(null, { getCliState: () => ({ serverId: "server-01", checkedAt: 5, startedAt: 4, clis: { codex: probed } }) });
  assert.equal(view.clis.codex.installed, false, "对工作台而言不可用：动作仍是「安装」");
  assert.equal(view.clis.codex.offPath, offPath);
  assert.equal(view.clis.codex.updateAvailable, false);
  const merged = mergeCliState({ ...probed, startedAt: 100, checkedAt: 120 }, { installed: true, version: "0.160.1", kind: "standalone", path: "~/.local/bin/codex", at: 300 });
  assert.deepEqual([merged.installed, merged.version, "offPath" in merged], [true, "0.160.1", false]);
});

test("安装：流程本体抛错也会结束任务并释放锁", async () => {
  const { svc } = makeService({ runJob: async () => { throw new Error("boom"); } });
  const { jobId } = await svc.startInstall("claude");
  await tick();
  await tick();
  assert.equal(svc.getJob(jobId).status, "failed");
  assert.equal(svc.getJob(jobId).error, "boom");
  assert.equal((await svc.overview()).busy, null);
});

// v2.57 后续：回退上传不经凭证执行器（askpass），密码连接的服务器上必然 Permission denied。
test("密码连接的服务器（条目带 authRef）：官方路径照常受理并把「不能回退上传」交给流程；直接用本机下载 409 并说明；概览带同一句说明", async () => {
  const PASSWORD = { ...TEAM, authRef: "vault:server-01" };
  const seen = [];
  const runJob = async (job, deps) => {
    seen.push(deps.uploadUnavailable);
    Object.assign(job, { status: "failed", error: "x", finishedAt: Date.now() });
  };
  const { svc } = makeService({ server: PASSWORD, runJob });
  await assert.rejects(svc.startInstall("codex", { mode: "local" }), (err) => err.status === 409 && /密码连接/.test(err.message) && /官方安装器/.test(err.message) && /密钥登录/.test(err.message));
  assert.equal((await svc.overview()).busy, null, "被拒绝的请求没有占锁");
  assert.equal((await svc.overview()).job, null, "也没有留下任务");

  await svc.startInstall("codex");
  await tick();
  await tick();
  assert.equal(seen.length, 1);
  assert.match(seen[0], /密码连接.*只支持密钥登录/);
  assert.equal((await svc.overview()).fallbackUnavailable, seen[0]);

  // 密钥登录的服务器不受影响。
  const keyed = makeService({ runJob });
  await keyed.svc.startInstall("codex", { mode: "local" });
  await tick();
  await tick();
  assert.equal(seen[1], null);
  assert.equal((await keyed.svc.overview()).fallbackUnavailable, null);
});

// ---- v2.57 后续：取消 ----

// 听取消信号的假流程：信号响了之后做 cleanupMs 的「清理」再以 cancelled 结束。
function cancellableRunJob({ cleanupMs = 20, patch = {} } = {}) {
  const state = { signals: [], aborts: 0, finish: null };
  const runJob = (job, _deps, { signal }) => new Promise((resolve) => {
    state.signals.push(signal);
    Object.assign(job, patch);
    const end = (status, extra = {}) => {
      Object.assign(job, { status, cancelling: false, cancellable: false, finishedAt: Date.now(), ...extra });
      resolve(job);
    };
    state.finish = end;
    signal.addEventListener("abort", () => {
      state.aborts += 1;
      if (cleanupMs != null) setTimeout(() => end("cancelled"), cleanupMs);
    }, { once: true });
  });
  return { runJob, state };
}

test("取消：受理后等清理做完才返回——任务 cancelled、锁已释放，登录与再次安装都能立刻发起", async () => {
  const lock = createCliTaskLock();
  const { runJob } = cancellableRunJob();
  const { svc, logs } = makeService({ runJob, taskLock: lock });
  const changed = [];
  const runtime = { onCliChanged: (id, info) => changed.push([id, info]) };
  const { jobId } = await svc.startInstall("codex", {}, runtime);
  assert.throws(() => lock.acquire("server-01", { kind: "login", cli: "codex" }), (err) => err.status === 409, "进行中：登录被挡在外面");

  const job = await svc.cancelJob(jobId);
  assert.equal(job.status, "cancelled");
  assert.equal((await svc.overview()).busy, null, "接口返回时锁已经释放");
  // 登录服务用的就是这把锁：现在能立刻占到。
  lock.acquire("server-01", { kind: "login", cli: "codex" })();
  // 再次安装也立刻可以。
  const again = await svc.startInstall("codex", {}, runtime);
  assert.notEqual(again.jobId, jobId);
  assert.equal(svc.getJob(again.jobId).status, "running");
  assert.equal((await svc.overview()).job.jobId, again.jobId);
  await tick();
  assert.deepEqual(changed, [["server-01", { cli: "codex", ok: false }]], "取消后重测一次现状");
  assert.ok(logs.some((l) => /cancel requested \(phase=queued\)/.test(l)));
  assert.ok(logs.some((l) => /cli install codex on server-01: cancelled/.test(l)));
});

test("取消：临界阶段（cancellable=false）409 并说明、不发信号；不存在的任务 404；已结束的任务原样返回", async () => {
  const { runJob, state } = cancellableRunJob({ patch: { phase: "activate", cancellable: false } });
  const { svc } = makeService({ runJob });
  const { jobId } = await svc.startInstall("codex");
  await tick();
  await assert.rejects(svc.cancelJob(jobId), (err) => err.status === 409 && err.code === "not-cancellable" && /已经在改正式目录.*不能中途取消/.test(err.message));
  assert.equal(state.signals[0].aborted, false);
  assert.deepEqual([svc.getJob(jobId).status, svc.getJob(jobId).cancelling], ["running", false]);
  await assert.rejects(svc.cancelJob("cli-nope"), (err) => err.status === 404);

  state.finish("succeeded", { installedVersion: "0.160.1" });
  await tick();
  await tick();
  assert.equal((await svc.cancelJob(jobId)).status, "succeeded", "已结束：不报错，原样返回");
  assert.equal(state.aborts, 0);
});

test("取消：清理迟迟做不完（SSH 不通）→ 最多等 waitMs 就返回「正在取消」的快照；重复取消不发第二次信号，只是接着等", async () => {
  const { runJob, state } = cancellableRunJob({ cleanupMs: null });
  const { svc } = makeService({ runJob });
  const { jobId } = await svc.startInstall("codex");
  await tick();
  const first = await svc.cancelJob(jobId, { waitMs: 30 });
  assert.deepEqual([first.status, first.cancelling], ["running", true]);
  assert.equal((await svc.overview()).busy.kind, "install", "还没清理完，锁照旧占着");
  const second = svc.cancelJob(jobId, { waitMs: 5000 });
  state.finish("cancelled");
  assert.equal((await second).status, "cancelled");
  assert.equal(state.aborts, 1);
  assert.equal((await svc.overview()).busy, null);
});

test("取消·端到端：服务 + 真实流程 + 假集群 HOME——官方安装器在跑时取消，锁立刻可用，马上再装一次（本机下载）成功", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=hang"]);
  const lock = createCliTaskLock();
  const remote = fakeRemote(home);
  const svc = createCliInstallService({
    getConfig: async () => ({ servers: [TEAM] }),
    getMainServerConfig: () => TEAM,
    sshArgsFor: () => [],
    // 「ssh 主机 命令」的最后一个参数就是远端命令：在假 HOME 里用本机 sh 执行。
    execCollector: async ({ args }) => remote(args.at(-1)),
    spawnImpl: (_file, args, options) => spawn("/bin/sh", ["-c", args.at(-1)], { ...options, env: envFor(home) }),
    versions: { getLatest: async () => ({ codex: { latest: "0.160.1" }, claude: { latest: "2.1.292" } }) },
    getUpstream: async () => ({ host: "127.0.0.1", port: 9 }), // 本机侧网络指向立即拒绝的端口：拿不到的只是进度条的分母
    downloadDir: path.join(fixtures, "dl"),
    taskLock: lock,
    // 真实流程；只把轮询调快、把「官方清单 + 本机下载」换成夹具（不联网）。
    runJob: (job, deps, options) => runInstallJob(job, {
      ...deps,
      resolveArtifact: async (_cli, { version }) => ({ cli: "codex", version, target: "x86_64-unknown-linux-musl", fileName: codexPkg.fileName, urls: ["https://example.invalid/x"], sha256: codexPkg.sha256, size: codexPkg.size }),
      download: async (_a, { onProgress }) => {
        onProgress({ bytes: codexPkg.size, total: codexPkg.size });
        return { filePath: codexPkg.filePath, size: codexPkg.size, sha256: codexPkg.sha256, reused: false };
      },
      cleanup: async () => {},
    }, { ...options, pollMs: 40 }),
  });
  const waitFor = async (check) => {
    for (let i = 0; i < 1500; i += 1) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };

  const { jobId } = await svc.startInstall("codex");
  assert.ok(await waitFor(() => svc.getJob(jobId).phase === "official" && svc.getJob(jobId).remoteJobId), "官方安装器跑起来了");
  const jobDir = path.join(home, ".cache/cluster-workbench/cli/jobs", svc.getJob(jobId).remoteJobId);
  assert.ok(await waitFor(() => fs.existsSync(path.join(jobDir, "pid"))));
  const pid = Number(fs.readFileSync(path.join(jobDir, "pid"), "utf8"));
  assert.throws(() => lock.acquire("server-01", { kind: "login", cli: "codex" }), (err) => err.status === 409);

  const cancelled = await svc.cancelJob(jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.match(cancelled.events.at(-1).text, /已取消.*官方安装器已停止/);
  assert.throws(() => process.kill(pid, 0), "集群上的官方安装器已结束");
  lock.acquire("server-01", { kind: "login", cli: "codex" })(); // 登录立刻可以发起

  const again = await svc.startInstall("codex", { mode: "local" });
  assert.ok(await waitFor(() => svc.getJob(again.jobId).status !== "running"));
  assert.equal(svc.getJob(again.jobId).status, "succeeded", svc.getJob(again.jobId).error);
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
  assert.equal((await svc.overview()).busy, null);
});

test("回滚：校验目标格式；成功后覆盖层更新版本（codex 的 release 名去掉 target）", async () => {
  const calls = [];
  const rollbackImpl = async (cli, { target }) => {
    calls.push([cli, target]);
    return { ok: true, result: "ok", from: "0.160.1-x86_64-unknown-linux-musl", to: "0.159.2-x86_64-unknown-linux-musl", error: null };
  };
  const { svc } = makeService({ rollbackImpl });
  await assert.rejects(svc.rollback("codex", { target: "1; reboot" }), (err) => err.status === 400);
  const res = await svc.rollback("codex", { serverId: "server-01" }, { onCliChanged: () => {} });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [["codex", null]]);
  const view = await svc.overview();
  assert.equal(view.clis.codex.version, "0.159.2");
  assert.equal(view.clis.codex.updateAvailable, true);
});
