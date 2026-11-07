// install.mjs：整条安装流程在本机临时「集群 HOME」里端到端演练——远端命令用真实 /bin/sh 执行，
// 上传走真实 uploadViaSsh（ssh 换成本机 sh），官方安装器 / curl 是假的，本机下载用夹具文件代替。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { cleanupArtifact, downloadArtifact } from "./download.mjs";
import { buildOfficialStartCommand, parseRemoteKv } from "./remote-scripts.mjs";
import { cancelBlockReason, createJobState, createProgressMeter, runInstallJob, runRollback, uploadViaSsh } from "./install.mjs";
import {
  buildClaudeBinary,
  buildCodexPackage,
  envFor,
  fakeRemote,
  fakeUpload,
  installFakeCurl,
  makeHome,
  readLink,
  releaseFakeInstaller,
  runLocal,
  writeEnvSh,
  writeExec,
  writeFakeClaudeInstaller,
  writeFakeCodexInstaller,
} from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;
const CODEX_ROOT = ".codex/packages/standalone";
const NAME = (v) => `${v}-x86_64-unknown-linux-musl`;
// stallMs 给足 30 秒：不测「卡住」的用例里，假安装器几十毫秒就跑完；机器很忙时（全量并发 + 别的用例在起
// 真实进程）它可能好几秒都轮不上，5 秒的阈值会把「退出码 1」误判成「没有进展」。要测卡住的用例自己写 400。
const FAST = { pollMs: 40, stallMs: 30000, maxOfficialMs: 60000 };

let seq = 0;
const jobIdGen = () => `cli-test${String(++seq).padStart(4, "0")}`;

// 一套 deps：远端 = 假 HOME 里的 sh；回退产物 = 夹具（codex 包 / Claude 二进制）。
function depsFor(home, { codexPkg = null, claudeBin = null, env, remote, calls = [] } = {}) {
  return {
    remote: remote || fakeRemote(home, { env, onCommand: (c) => calls.push(c) }),
    upload: fakeUpload(home, { env }),
    resolveLatest: async (cli) => (cli === "codex" ? "0.160.1" : "2.1.292"),
    officialSizes: async () => ({ raw: 65536, compressed: null }),
    resolveArtifact: async (cli, { version }) => {
      const f = cli === "codex" ? codexPkg : claudeBin;
      assert.ok(f, `没有给 ${cli} 的夹具`);
      return cli === "codex"
        ? { cli, version, target: "x86_64-unknown-linux-musl", releaseName: NAME(version), fileName: f.fileName, urls: ["https://example.invalid/x"], sha256: f.sha256, size: null }
        : { cli, version, platform: "linux-x64", fileName: f.fileName, urls: ["https://example.invalid/y"], sha256: f.sha256, size: f.size };
    },
    download: async (artifact, { onProgress }) => {
      const f = artifact.cli === "codex" ? codexPkg : claudeBin;
      onProgress({ bytes: f.size, total: f.size });
      return { filePath: f.filePath, size: f.size, sha256: f.sha256, reused: false };
    },
    cleanup: async () => {},
    newRemoteJobId: jobIdGen,
    log: () => {},
  };
}

const newJob = (cli, extra = {}) => createJobState({ jobId: jobIdGen(), serverId: "server-01", cli, targetVersion: cli === "codex" ? "0.160.1" : "2.1.292", ...extra });

test("进度：60 秒窗口算速度与剩余时间；字节回退（换段）时重置窗口", () => {
  let t = 0;
  const meter = createProgressMeter({ now: () => t });
  meter.update(0, 1000);
  t = 1000;
  const p = meter.update(100, 1000);
  assert.deepEqual(p, { bytes: 100, total: 1000, percent: 10, speedBps: 100, etaSec: 9 });
  t = 2000;
  assert.equal(meter.update(50, 1000).speedBps, null, "字节变少 → 新的一段，速度重新算");
  t = 3000;
  assert.equal(meter.update(150, null).percent, null, "不知道总量就不给百分比");
});

test("回退路径（mode=local）：codex 从零装好，PATH 里的命令就是新版本", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  const job = newJob("codex", { mode: "local" });
  await runInstallJob(job, depsFor(home, { codexPkg }), FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "fallback");
  assert.equal(job.action, "install");
  assert.equal(job.installedVersion, "0.160.1");
  assert.equal(job.fallbackReason, "选择了本机下载");
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
  assert.ok(job.events.some((e) => /集群上复核 sha256 一致/.test(e.text)));
});

test("首选路径：集群上有 env.sh → 后台跑官方安装器、轮询到下载进度、核对版本后成功", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  // gate：假安装器写完下载文件后停住，等这边轮询到下载进度再放行。不停的话它几毫秒就跑完并清掉临时
  // 下载目录，一次进度都看不到；固定停 1 秒也不够——全量并发、机器一忙，第一次轮询可能就在 1 秒之后。
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=gate"]);
  const updates = [];
  const job = newJob("codex");
  await runInstallJob(job, depsFor(home), {
    ...FAST,
    onUpdate: (j) => {
      updates.push(structuredClone(j));
      if (j.phase === "official" && j.progress?.bytes === 65536) releaseFakeInstaller(home);
    },
  });
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "official");
  assert.equal(job.fellBack, false);
  assert.equal(job.installedVersion, "0.160.1");
  assert.ok(job.remoteJobId);
  assert.ok(job.remoteLog.some((l) => /installed successfully/.test(l)), "日志尾巴带回来了");
  assert.ok(updates.some((u) => u.phase === "official" && u.progress?.bytes === 65536 && u.progress.total === 65536), "下载进度用官方产物大小当分母");
  const jobDir = path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId);
  assert.equal(fs.readFileSync(path.join(jobDir, "exit"), "utf8").trim(), "0");
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), path.join(home, CODEX_ROOT, "releases", NAME("0.160.1")));
});

test("首选路径失败（安装器退出码 1）→ 自动回退本机下载并成功", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=fail"]);
  const job = newJob("codex");
  await runInstallJob(job, depsFor(home, { codexPkg }), FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "fallback");
  assert.equal(job.fellBack, true);
  assert.match(job.fallbackReason, /退出码 1/);
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
});

test("首选路径卡住（下载不再增长、日志不动）→ 结束远端任务（退出码 143）并回退", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=hang"]);
  const job = newJob("codex");
  await runInstallJob(job, depsFor(home, { codexPkg }), { ...FAST, stallMs: 400 });
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.fellBack, true);
  assert.match(job.fallbackReason, /没有进展，已停止/);
  const jobDir = path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId);
  assert.equal(fs.readFileSync(path.join(jobDir, "exit"), "utf8").trim(), "143");
  const pid = Number(fs.readFileSync(path.join(jobDir, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), "远端任务进程已结束");
});

// ---- v2.57 后续：只有确认远端任务已结束才回退（官方安装器与回退并行会交错改安装目录）----

const isKillCommand = (command) => command.includes("killtree");
const isStartCommand = (command) => command.includes("job.sh") && command.includes("base64");
const SSH_DOWN = { code: 255, stdout: "", stderr: "ssh: connect to host x port 22: Operation timed out\n", timedOut: false };

// 卡住的官方安装器 + 可回退的夹具；remote 可以按命令种类做手脚。返回 { job, deps, downloads, jobDirOf }。
function stalledSetup(t, { wrapRemote }) {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=hang"]);
  const deps = depsFor(home, { codexPkg, remote: wrapRemote(fakeRemote(home), home) });
  const downloads = [];
  const download = deps.download;
  deps.download = async (...args) => {
    downloads.push(Date.now());
    return download(...args);
  };
  const jobDirOf = (job) => path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId);
  return { home, deps, downloads, jobDirOf };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("首选路径卡住但结束远端任务的 SSH 一直不通 → 不回退（官方安装器可能还在跑），失败并说明", { skip }, async (t) => {
  const kills = [];
  const { home, deps, downloads, jobDirOf } = stalledSetup(t, {
    wrapRemote: (real) => async (command, opts) => {
      if (!isKillCommand(command)) return real(command, opts);
      kills.push(command);
      return SSH_DOWN; // 命令根本没送到：远端任务还活着
    },
  });
  const job = newJob("codex");
  await runInstallJob(job, deps, { ...FAST, stallMs: 400 });
  assert.equal(job.status, "failed");
  assert.match(job.error, /没有进展.*没能确认集群上的安装任务已经停止.*Operation timed out/);
  assert.match(job.error, /不自动改用本机下载/);
  assert.equal(job.fellBack, false);
  assert.equal(job.path, "official");
  assert.equal(kills.length, 3, "结束命令重发到上限为止");
  assert.deepEqual(downloads, [], "没有进入回退");
  assert.equal(readLink(home, ".local/bin/codex"), null, "回退的落盘没有发生");
  const pid = Number(fs.readFileSync(path.join(jobDirOf(job), "pid"), "utf8"));
  assert.ok(alive(pid), "夹具自检：远端任务确实还在跑（所以回退才危险）");
});

test("首选路径卡住：结束命令第一次没送到、第二次确认已结束 → 确认之后才回退", { skip }, async (t) => {
  let killCalls = 0;
  let confirmedAt = 0;
  const { deps, downloads, jobDirOf } = stalledSetup(t, {
    wrapRemote: (real) => async (command, opts) => {
      if (!isKillCommand(command)) return real(command, opts);
      killCalls += 1;
      if (killCalls === 1) return SSH_DOWN;
      const res = await real(command, opts);
      confirmedAt = Date.now();
      return res;
    },
  });
  const job = newJob("codex");
  await runInstallJob(job, deps, { ...FAST, stallMs: 400 });
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.fellBack, true);
  assert.match(job.fallbackReason, /没有进展，已停止/);
  assert.equal(killCalls, 2);
  assert.ok(downloads.length === 1 && downloads[0] >= confirmedAt, "回退在确认之后才开始");
  const pid = Number(fs.readFileSync(path.join(jobDirOf(job), "pid"), "utf8"));
  assert.ok(!alive(pid), "回退开始前远端任务已结束");
  assert.equal(fs.readFileSync(path.join(jobDirOf(job), "exit"), "utf8").trim(), "143");
});

test("启动官方安装器时回话丢了（任务其实已经在集群上跑起来）→ 先把它结束并确认，再回退", { skip }, async (t) => {
  let pidAtFallback = null;
  const { home, deps } = stalledSetup(t, {
    wrapRemote: (real) => async (command, opts) => {
      const res = await real(command, opts);
      return isStartCommand(command) ? { code: 255, stdout: "", stderr: "Connection to x closed by remote host.\n", timedOut: false } : res;
    },
  });
  const job = newJob("codex");
  const download = deps.download;
  deps.download = async (...args) => {
    const jobsDir = path.join(home, ".cache/cluster-workbench/cli/jobs");
    const [dir] = fs.readdirSync(jobsDir);
    // spawnpid 是启动命令自己同步写下的（pid 由任务脚本写，结束得早时可能还没来得及写）。
    pidAtFallback = Number(fs.readFileSync(path.join(jobsDir, dir, "spawnpid"), "utf8"));
    assert.ok(!alive(pidAtFallback), "回退开始时那个没人跟踪的官方任务已经结束");
    return download(...args);
  };
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.fellBack, true);
  assert.match(job.fallbackReason, /启动官方安装器失败.*closed by remote host/);
  assert.ok(pidAtFallback > 1, "夹具自检：官方任务确实起来过");
});

test("启动官方安装器时回话丢了、之后也确认不了它在不在 → 不回退", { skip }, async (t) => {
  const { deps, downloads } = stalledSetup(t, {
    wrapRemote: (real) => async (command, opts) => {
      if (isKillCommand(command)) return SSH_DOWN;
      const res = await real(command, opts);
      return isStartCommand(command) ? SSH_DOWN : res;
    },
  });
  const job = newJob("codex");
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "failed");
  assert.match(job.error, /启动官方安装器时连接中断.*没能确认/);
  assert.deepEqual(downloads, []);
});

test("跟踪途中任务目录不见了（读不到进程号，确认不了还在不在跑）→ 不回退", { skip }, async (t) => {
  let polls = 0;
  const { deps, downloads } = stalledSetup(t, {
    wrapRemote: (real, home) => async (command, opts) => {
      // 第一次轮询之前把任务目录删掉（有人清了 ~/.cache）；安装器进程本身还在。
      // 先等假安装器写完下载文件、停住再删：它启动时的 `mkdir -p "$TMPDIR/tmp.fake"` 若排在删除之后，会把
      // 任务目录又建出来（没有 pid 文件），轮询看到的就不是「目录不见了」而是「读不到进程号」——结论同样是
      // 不回退，但说明文字不同。慢机器上第一次轮询可能早于安装器启动（macOS CI 上红过一次）。
      if (command.includes("logsize=") && polls++ === 0) {
        const jobs = path.join(home, ".cache/cluster-workbench/cli/jobs");
        const downloaded = () => fs.readdirSync(jobs).some((id) => {
          try {
            return fs.statSync(path.join(jobs, id, "tmp/tmp.fake/codex-package_SHA256SUMS")).size === 65536;
          } catch {
            return false;
          }
        });
        assert.ok(await waitUntil(downloaded), "夹具自检：假安装器已经跑到停住的位置");
        fs.rmSync(jobs, { recursive: true, force: true });
      }
      return real(command, opts);
    },
  });
  const job = newJob("codex");
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "failed");
  assert.match(job.error, /任务目录不见了.*不自动改用本机下载/);
  assert.deepEqual(downloads, []);
});

test("官方任务的主进程不在了却没留下退出码（被别人杀了）→ 先发结束命令收拾它的进程组并确认，再回退", { skip }, async (t) => {
  let killedMain = null;
  const order = [];
  const { deps, jobDirOf } = stalledSetup(t, {
    wrapRemote: (real, home) => async (command, opts) => {
      // 第一次轮询之前只杀任务脚本本身（SIGKILL，来不及写退出码）；它起的安装器子进程成了孤儿。
      if (command.includes("logsize=") && killedMain == null) {
        const jobsDir = path.join(home, ".cache/cluster-workbench/cli/jobs");
        const pidFile = path.join(jobsDir, fs.readdirSync(jobsDir)[0], "pid");
        for (let i = 0; i < 200 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        killedMain = Number(fs.readFileSync(pidFile, "utf8"));
        process.kill(killedMain, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (isKillCommand(command)) order.push("stop");
      return real(command, opts);
    },
  });
  const download = deps.download;
  deps.download = async (...args) => {
    order.push("download");
    return download(...args);
  };
  const job = newJob("codex");
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.fellBack, true);
  assert.match(job.fallbackReason, /官方安装器意外退出，已停止/);
  assert.deepEqual(order, ["stop", "download"], "先结束并确认，再开始回退");
  assert.ok(killedMain > 1 && !alive(killedMain));
  assert.equal(fs.readFileSync(path.join(jobDirOf(job), "exit"), "utf8").trim(), "143", "任务目录收了尾（下次预检不会把它当成在跑的）");
});

// ---- v2.57 后续：密码连接的服务器没法走回退上传（上传不经凭证执行器），要在动手前说清楚 ----

const NO_UPLOAD = "这台服务器用密码连接，本机下载后上传只支持密钥登录";

test("回退上传不可用（密码连接）：官方路径照常可用并提前提醒；官方失败时不进入回退，说明原因", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  const touched = [];
  const depsNoUpload = () => ({
    ...depsFor(home, { codexPkg }),
    uploadUnavailable: NO_UPLOAD,
    resolveArtifact: async () => { touched.push("resolveArtifact"); throw new Error("不该解析产物"); },
    download: async () => { touched.push("download"); throw new Error("不该下载"); },
    upload: async () => { touched.push("upload"); return { code: 255, stdout: "", stderr: "Permission denied (publickey,password).\n" }; },
  });

  // 官方路径成功：不受影响，只是多一条提醒。
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`]);
  const ok = newJob("codex");
  await runInstallJob(ok, depsNoUpload(), FAST);
  assert.equal(ok.status, "succeeded", ok.error);
  assert.equal(ok.path, "official");
  assert.ok(ok.warnings.some((w) => /密码连接.*不会自动改为本机下载/.test(w)), "动手之前就提醒了");

  // 官方路径失败：不进入回退（不解析、不下载、不上传），错误里有官方失败的原因 + 为什么没回退 + 怎么办。
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=fail"]);
  const failed = newJob("codex");
  await runInstallJob(failed, depsNoUpload(), FAST);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /官方安装器退出码 1/);
  assert.match(failed.error, /密码连接.*只支持密钥登录/);
  assert.match(failed.error, /npm run setup/);
  assert.doesNotMatch(failed.error, /Permission denied/);
  assert.equal(failed.fellBack, false);
  assert.deepEqual(touched, []);
});

test("回退上传不可用（密码连接）+ 选了「直接用本机下载」→ 预检之前就拒绝，一条远端命令都不发", async () => {
  const calls = [];
  const job = newJob("codex", { mode: "local" });
  await runInstallJob(job, { remote: async (c) => { calls.push(c); return { code: 0, stdout: "" }; }, uploadUnavailable: NO_UPLOAD, log: () => {} }, FAST);
  assert.equal(job.status, "failed");
  assert.match(job.error, /密码连接.*只支持密钥登录/);
  assert.match(job.error, /官方安装器/);
  assert.deepEqual(calls, []);
});

// ---- v2.57 后续：取消 ----
//
// 三个可取消的阶段各取消一次（官方安装器在跑 / 本机下载中 / 上传中），外加临界阶段不可取消、
// 取消到达时官方安装器已经跑完。每个用例先用回退路径装一个旧版本，取消之后它必须原样可用。

async function waitUntil(check, { timeoutMs = 15000, stepMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function withOldCodex(t) {
  const made = makeHome(t);
  const oldPkg = buildCodexPackage(made.fixtures, "0.159.2");
  const first = newJob("codex", { mode: "local", targetVersion: "0.159.2" });
  await runInstallJob(first, depsFor(made.home, { codexPkg: oldPkg }), FAST);
  assert.equal(first.status, "succeeded", first.error);
  return made;
}

function assertOldCodexIntact(home) {
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.159.2", "原来的版本原样可用");
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), path.join(home, CODEX_ROOT, "releases", NAME("0.159.2")));
  assert.deepEqual(fs.readdirSync(path.join(home, CODEX_ROOT, "releases")), [NAME("0.159.2")], "releases 里没有多出东西");
}

const uploadDirOf = (home) => path.join(home, ".cache/cluster-workbench/cli/upload");
const lastEvent = (job) => job.events.at(-1)?.text || "";

test("取消·官方阶段：结束集群上的官方安装器并确认，状态 cancelled；不进入回退，原来的版本原样可用", { skip }, async (t) => {
  const { home, fixtures } = await withOldCodex(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=hang"]);
  const calls = [];
  const deps = depsFor(home, { codexPkg, calls });
  let downloads = 0;
  deps.download = async () => { downloads += 1; throw new Error("不该下载"); };
  const controller = new AbortController();
  const job = newJob("codex");
  const running = runInstallJob(job, deps, { ...FAST, signal: controller.signal });
  assert.ok(await waitUntil(() => job.phase === "official" && job.progress?.bytes > 0), "官方安装器在跑，轮询到了进度");
  assert.equal(job.cancellable, true);
  assert.equal(cancelBlockReason(job), null);
  const jobDir = path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId);
  const pid = Number(fs.readFileSync(path.join(jobDir, "pid"), "utf8"));
  assert.ok(alive(pid), "夹具自检：远端任务在跑");

  const at = Date.now();
  controller.abort();
  await running;
  assert.ok(Date.now() - at < 8000, "不等下一轮轮询，也不等停滞检测");
  assert.equal(job.status, "cancelled");
  assert.deepEqual([job.cancelling, job.cancellable, job.error, job.fellBack], [false, false, null, false]);
  assert.ok(job.finishedAt > 0);
  assert.match(lastEvent(job), /已取消.*官方安装器已停止/);
  assert.ok(!alive(pid), "集群上的官方安装器已结束");
  assert.equal(fs.readFileSync(path.join(jobDir, "exit"), "utf8").trim(), "143");
  assert.ok(calls.some(isKillCommand), "复用结束命令");
  assert.equal(downloads, 0, "取消不是失败，不回退");
  assertOldCodexIntact(home);
});

test("取消·下载阶段：AbortSignal 立刻打断本机下载，不留 .part；集群上没有任何改动", { skip }, async (t) => {
  const { home, fixtures } = await withOldCodex(t);
  const dir = path.join(fixtures, "dl-cache");
  const artifact = {
    cli: "codex", version: "0.160.1", target: "x86_64-unknown-linux-musl", releaseName: NAME("0.160.1"),
    fileName: "codex-package-x86_64-unknown-linux-musl.tar.gz", urls: ["https://example.invalid/slow"], sha256: "c".repeat(64), size: 10 * 1024 * 1024,
  };
  // 慢源：每 5ms 吐 4KB，10MB 要下 3 小时——只有 AbortSignal 能让它停。
  const open = async () => {
    const res = Readable.from((async function* gen() {
      for (;;) {
        yield Buffer.alloc(4096, 1);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })());
    res.statusCode = 200;
    res.headers = {};
    return { res, url: artifact.urls[0] };
  };
  const calls = [];
  const deps = depsFor(home, { calls });
  deps.resolveArtifact = async () => artifact;
  deps.download = (a, { onProgress, signal }) => downloadArtifact(a, { dir, onProgress, signal, open });
  deps.cleanup = (a) => cleanupArtifact(a, { dir });
  let uploads = 0;
  deps.upload = async () => { uploads += 1; return { code: 1, stdout: "", stderr: "" }; };
  const controller = new AbortController();
  const job = newJob("codex", { mode: "local" });
  const running = runInstallJob(job, deps, { ...FAST, signal: controller.signal });
  const part = path.join(dir, `${artifact.fileName}.part`);
  assert.ok(await waitUntil(() => job.phase === "download" && job.progress?.bytes > 8192 && fs.existsSync(part)), "下载进行中，本机已有 .part");
  assert.equal(job.cancellable, true);
  const callsBefore = calls.length;

  const at = Date.now();
  controller.abort();
  await running;
  assert.ok(Date.now() - at < 3000, "立刻停下");
  assert.equal(job.status, "cancelled");
  assert.match(lastEvent(job), /已取消.*本机下载的安装包已删除/);
  assert.deepEqual(fs.readdirSync(dir), [], "本机不留下载残留");
  assert.equal(uploads, 0);
  assert.equal(calls.length, callsBefore, "没上传过，不需要再连集群清理");
  assert.ok(!fs.existsSync(uploadDirOf(home)) || fs.readdirSync(uploadDirOf(home)).length === 0);
  assertOldCodexIntact(home);
});

test("取消·上传阶段：杀掉上传的 ssh 子进程，清掉集群上的半截上传文件与本机安装包；原来的版本原样可用", { skip }, async (t) => {
  const { home, fixtures } = await withOldCodex(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  const dir = path.join(fixtures, "dl-cache");
  fs.mkdirSync(dir);
  // 「永远传不完」的安装包：一个命名管道，写端由测试拿着——喂 4KB 之后既不写也不关，上传就停在半截。
  const fifo = path.join(dir, codexPkg.fileName);
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const calls = [];
  const deps = depsFor(home, { codexPkg, calls });
  deps.download = async (_a, { onProgress }) => {
    onProgress({ bytes: 1 << 20, total: 1 << 20 });
    return { filePath: fifo, size: 1 << 20, sha256: codexPkg.sha256, reused: false };
  };
  deps.cleanup = (a) => cleanupArtifact(a, { dir });
  let child = null;
  deps.upload = ({ command, filePath, onProgress, signal }) => uploadViaSsh({
    file: "/bin/sh",
    args: ["-c", command],
    filePath,
    onProgress,
    signal,
    spawnImpl: (file, args, options) => {
      child = spawn(file, args, { ...options, env: envFor(home) });
      return child;
    },
  });
  const controller = new AbortController();
  const job = newJob("codex", { mode: "local" });
  const running = runInstallJob(job, deps, { ...FAST, signal: controller.signal });
  assert.ok(await waitUntil(() => job.phase === "upload" && child), "进入上传");
  const writer = await fsp.open(fifo, "w");
  t.after(() => writer.close().catch(() => {}));
  await writer.write(Buffer.alloc(4096, 7));
  const part = path.join(uploadDirOf(home), `${codexPkg.fileName}.part`);
  assert.ok(await waitUntil(() => fs.existsSync(part) && fs.statSync(part).size > 0), "集群上已经有半截文件");
  assert.equal(job.cancellable, true);

  const at = Date.now();
  controller.abort();
  await running;
  await writer.close();
  assert.ok(Date.now() - at < 8000, "不等上传的空闲超时");
  assert.equal(job.status, "cancelled");
  assert.ok(child.exitCode !== null || child.signalCode !== null, "上传的子进程已结束");
  assert.match(lastEvent(job), /已取消.*本机下载的安装包已删除.*半截上传文件已清理/);
  assert.deepEqual(fs.readdirSync(uploadDirOf(home)), [], "集群上不留半截上传文件");
  assert.ok(calls.some((c) => c.includes("cleanup=ok")), "发了清理命令（不靠上传脚本自己收尾）");
  assert.deepEqual(fs.readdirSync(dir), [], "本机安装包也删了");
  assert.deepEqual(job.warnings, []);
  assertOldCodexIntact(home);
});

test("取消·上传阶段：清理命令连不上集群 → 仍然结束为 cancelled，提醒里说清半截文件留在哪", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  const controller = new AbortController();
  const real = fakeRemote(home);
  const deps = depsFor(home, { codexPkg, remote: async (command, opts) => (command.includes("cleanup=ok") ? SSH_DOWN : real(command, opts)) });
  // 上传一开始就取消：upload 看到信号后按「已中止」返回。
  deps.upload = async ({ signal }) => {
    controller.abort();
    return { code: null, stdout: "", stderr: "", timedOut: false, aborted: signal.aborted };
  };
  const job = newJob("codex", { mode: "local" });
  await runInstallJob(job, deps, { ...FAST, signal: controller.signal });
  assert.equal(job.status, "cancelled");
  assert.ok(job.warnings.some((w) => /没能连上集群清理半截上传文件.*\.cache\/cluster-workbench\/cli\/upload\/codex-package.*Operation timed out/.test(w)));
  assert.doesNotMatch(lastEvent(job), /半截上传文件已清理/);
});

test("取消·临界阶段：落盘 / 切软链期间不可取消——cancellable=false，期间硬发的取消信号不理，任务照常完成", { skip }, async (t) => {
  const { home, fixtures } = await withOldCodex(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  const controller = new AbortController();
  const job = newJob("codex", { mode: "local" });
  const seen = [];
  const real = fakeRemote(home);
  const remote = async (command, opts) => {
    if (command.includes(".staging.")) {
      seen.push({ phase: job.phase, cancellable: job.cancellable, reason: cancelBlockReason(job) });
      controller.abort(); // 落盘命令发出去的同时硬闯
    }
    return real(command, opts);
  };
  await runInstallJob(job, depsFor(home, { codexPkg, remote }), { ...FAST, signal: controller.signal });
  assert.deepEqual(seen.map((s) => [s.phase, s.cancellable]), [["activate", false]]);
  assert.match(seen[0].reason, /已经在改正式目录.*不能中途取消/);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.installedVersion, "0.160.1");
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
  assert.equal(cancelBlockReason(job), "任务已经结束");
});

test("取消·来晚了：取消到达时官方安装器已经跑完 → 不谎报「已取消」，照常核对版本并成功", { skip }, async (t) => {
  const { home, fixtures } = await withOldCodex(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`]);
  const controller = new AbortController();
  const job = newJob("codex");
  // 轮询间隔拉长到 30 秒：安装器跑完到下一次轮询之间的空档里取消。
  const running = runInstallJob(job, depsFor(home, { codexPkg }), { ...FAST, pollMs: 30000, signal: controller.signal });
  assert.ok(await waitUntil(() => job.remoteJobId && fs.existsSync(path.join(home, ".cache/cluster-workbench/cli/jobs", job.remoteJobId, "exit"))), "官方安装器跑完了");
  controller.abort();
  await running;
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.installedVersion, "0.160.1");
  assert.equal(job.path, "official");
  assert.ok(job.events.some((e) => /取消请求到达时官方安装器已经跑完/.test(e.text)));
  assert.equal(job.cancelling, false);
});

test("取消·还没开始：信号已经响了 → 一条远端命令都不发，直接 cancelled", async () => {
  const calls = [];
  const controller = new AbortController();
  controller.abort();
  const job = newJob("codex");
  await runInstallJob(job, { remote: async (c) => { calls.push(c); return { code: 0, stdout: "" }; }, log: () => {} }, { ...FAST, signal: controller.signal });
  assert.equal(job.status, "cancelled");
  assert.deepEqual(calls, []);
});

test("uploadViaSsh：信号中止 → 立刻结束子进程，aborted=true；信号早就响了则根本不起子进程", { skip }, async (t) => {
  const { fixtures } = makeHome(t);
  const file = path.join(fixtures, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const at = Date.now();
  // exec：不管 /bin/sh 是哪种 shell，子进程都只有 sleep 这一个（像真实的 ssh 那样，杀掉它管道就关了）。
  const res = await uploadViaSsh({ file: "/bin/sh", args: ["-c", "exec sleep 20"], filePath: file, signal: controller.signal, spawnImpl: spawn });
  assert.deepEqual([res.aborted, res.timedOut], [true, false]);
  assert.ok(Date.now() - at < 5000);
  let spawned = 0;
  const again = await uploadViaSsh({ file: "/bin/sh", args: ["-c", "true"], filePath: file, signal: controller.signal, spawnImpl: (...a) => { spawned += 1; return spawn(...a); } });
  assert.equal(again.aborted, true);
  assert.equal(spawned, 0);
});

test("预检发现已有在跑的官方任务（上次工作台中途退出）→ 接管它而不是再起一个", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  installFakeCurl(home);
  const installer = writeFakeCodexInstaller(fixtures, { version: "0.160.1", srcDir: codexPkg.srcDir });
  // gate：先前那个任务停在「下载完」，等这边确实接管了它（remoteJobId 指向它）再放行——
  // 靠「它 1 秒内不会跑完」的话，机器一忙预检就赶不上，接管变成了回退。
  writeEnvSh(home, [`export FAKE_INSTALLER_CODEX="${installer}"`, "export FAKE_MODE=gate"]);
  const earlier = "cli-earlier01";
  assert.equal(parseRemoteKv(runLocal(home, buildOfficialStartCommand("codex", earlier)).stdout).values.start, "ok");
  const calls = [];
  const job = newJob("codex", { mode: "local" }); // 即便选了本机下载，也先跟完在跑的那个
  await runInstallJob(job, depsFor(home, { calls }), { ...FAST, onUpdate: (j) => { if (j.remoteJobId === earlier) releaseFakeInstaller(home); } });
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.remoteJobId, earlier);
  assert.equal(job.path, "official");
  assert.ok(!calls.some((c) => c.includes("start=ok")), "没有再启动新的官方任务");
});

test("Claude：首选路径用官方 install.sh 装好；回退路径覆盖 0 字节残留；runRollback 切回旧版本", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const old = buildClaudeBinary(fixtures, "2.1.285");
  installFakeCurl(home);
  const installer = writeFakeClaudeInstaller(fixtures, { version: "2.1.285", binary: old.filePath });
  writeEnvSh(home, [`export FAKE_INSTALLER_CLAUDE="${installer}"`]);
  const first = newJob("claude", { targetVersion: "2.1.285" });
  await runInstallJob(first, depsFor(home), FAST);
  assert.equal(first.status, "succeeded", first.error);
  assert.equal(first.path, "official");

  const V = path.join(home, ".local/share/claude/versions");
  fs.writeFileSync(path.join(V, "2.1.292"), ""); // 以前超时留下的残留
  const claudeBin = buildClaudeBinary(fixtures, "2.1.292");
  const second = newJob("claude", { mode: "local" });
  await runInstallJob(second, depsFor(home, { claudeBin }), FAST);
  assert.equal(second.status, "succeeded", second.error);
  assert.equal(second.action, "update");
  assert.equal(second.fromVersion, "2.1.285");
  assert.ok(second.warnings.some((w) => /损坏的残留（2\.1\.292/.test(w)));
  assert.equal(runLocal(home, '"$HOME/.local/bin/claude" --version').stdout.trim(), "2.1.292 (Claude Code)");

  const rb = await runRollback("claude", { remote: fakeRemote(home) });
  assert.deepEqual([rb.ok, rb.from, rb.to], [true, "2.1.292", "2.1.285"]);
  assert.equal(readLink(home, ".local/bin/claude"), path.join(V, "2.1.285"));
});

test("没有 env.sh → 不尝试首选路径，直接回退并说明原因；npm 全局安装只提示", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  writeExec(path.join(home, ".npm-global/bin/claude"), "#!/usr/bin/env node\n");
  const claudeBin = buildClaudeBinary(fixtures, "2.1.292");
  const calls = [];
  const job = newJob("claude");
  await runInstallJob(job, depsFor(home, { claudeBin, calls }), FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.fellBack, false);
  assert.match(job.fallbackReason, /env\.sh/);
  assert.ok(job.warnings.some((w) => /npm 全局安装的 claude/.test(w)));
  assert.ok(fs.existsSync(path.join(home, ".npm-global/bin/claude")), "不卸载 npm 版");
  assert.ok(!calls.some((c) => c.includes("job.sh")), "没有启动官方任务");
});

test("家目录空间不足 / 连不上服务器 → 失败并给出原因，不动任何东西", { skip }, async (t) => {
  const { home } = makeHome(t);
  const real = fakeRemote(home);
  const lowDisk = async (command, opts) => {
    const res = await real(command, opts);
    return { ...res, stdout: res.stdout.replace(/^freekb=\d+$/m, "freekb=1024") };
  };
  const job = newJob("codex");
  await runInstallJob(job, { ...depsFor(home), remote: lowDisk }, FAST);
  assert.equal(job.status, "failed");
  assert.match(job.error, /剩余空间只有 1MB/);

  const down = newJob("codex");
  await runInstallJob(down, { ...depsFor(home), remote: async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host x port 22: Connection refused\n" }) }, FAST);
  assert.equal(down.status, "failed");
  assert.match(down.error, /Connection refused/);
  assert.equal(readLink(home, ".local/bin/codex"), null);
});

test("回退路径：集群上复核 sha256 不符 → 失败，不重试", { skip }, async (t) => {
  const { home, fixtures } = makeHome(t);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  const tampered = { ...codexPkg, sha256: "b".repeat(64) };
  const job = newJob("codex", { mode: "local" });
  const deps = depsFor(home, { codexPkg });
  deps.download = async (_a, { onProgress }) => {
    onProgress({ bytes: 1, total: 1 });
    return { filePath: tampered.filePath, size: tampered.size, sha256: tampered.sha256 };
  };
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "failed");
  assert.match(job.error, /复核 sha256 不符/);
});

test("uploadViaSsh：远端不收数据超过 idle 上限 → 结束子进程、timedOut", { skip }, async (t) => {
  const { fixtures } = makeHome(t);
  const file = path.join(fixtures, "big.bin");
  fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024));
  const res = await uploadViaSsh({ file: "/bin/sh", args: ["-c", "sleep 5"], filePath: file, idleTimeoutMs: 300, spawnImpl: spawn });
  assert.equal(res.timedOut, true);
});
