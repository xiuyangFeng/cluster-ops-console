// team-cache.mjs：纯函数 + 在本机临时「集群 HOME」里用真实 /bin/sh 演练缓存列表 / 拷贝 / 发布 / 清理，
// 以及 install.mjs 的团队缓存路径端到端（缓存命中、缓存被篡改时退回别的方式）。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createJobState, runInstallJob } from "./install.mjs";
import { parseRemoteKv } from "./remote-scripts.mjs";
import {
  buildCacheCopyCommand,
  buildCacheListCommand,
  buildCachePruneCommand,
  buildCachePublishCleanupCommand,
  buildCachePublishCommand,
  cacheFileName,
  chooseCacheEntry,
  cliCacheDir,
  isSafeHubDir,
  parseCacheEntries,
  versionsToPrune,
} from "./team-cache.mjs";
import { buildClaudeBinary, buildCodexPackage, fakeRemote, fakeUpload, makeHome, readLink, runLocal } from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;
const CODEX_TARGET = "x86_64-unknown-linux-musl";
const CODEX_FILE = `codex-package-${CODEX_TARGET}.tar.gz`;
const SHA = "a".repeat(64);

test("共享目录校验：只认绝对路径、白名单字符，拒绝 .. / 结尾斜杠 / 引号与空白", () => {
  assert.equal(isSafeHubDir("/public/agent-hub"), true);
  for (const bad of ["public/agent-hub", "/public/agent-hub/", "/public/../etc", "/a/./b", "/a b", "/a\"b", "/a$b", "", null]) {
    assert.equal(isSafeHubDir(bad), false, String(bad));
  }
  assert.equal(cliCacheDir("/public/agent-hub"), "/public/agent-hub/cli-cache");
  assert.throws(() => cliCacheDir("/x/../y"), /共享目录非法/);
});

test("缓存文件名与官方产物同名；版本 / 平台非法时为 null", () => {
  assert.equal(cacheFileName("codex", "0.160.1", CODEX_TARGET), CODEX_FILE);
  assert.equal(cacheFileName("claude", "2.1.292", "linux-x64"), "claude-2.1.292-linux-x64");
  assert.equal(cacheFileName("claude", "2.1.292;rm", "linux-x64"), null);
  assert.equal(cacheFileName("codex", "0.160.1", ""), null);
});

test("解析缓存列表：丢掉非法版本、0 字节与重复项；指定 CLI 时只留官方产物文件名（.part / 杂物 / 版本对不上的不算）", () => {
  const entries = parseCacheEntries([
    `0.160.1/${CODEX_FILE} 1000`,
    `0.160.1/${CODEX_FILE}.part.123 500`,
    `0.160.1/${CODEX_FILE} 1000`,
    `latest/${CODEX_FILE} 1000`,
    `0.159.0/${CODEX_FILE} 0`,
    "0.161.0/a b 10",
    "garbage",
  ]);
  assert.deepEqual(entries, [
    { version: "0.160.1", fileName: CODEX_FILE, size: 1000 },
    { version: "0.160.1", fileName: `${CODEX_FILE}.part.123`, size: 500 },
  ]);
  assert.deepEqual(parseCacheEntries([`0.160.1/${CODEX_FILE} 1000`, `0.160.1/${CODEX_FILE}.part.123 500`, "0.160.1/evil.sh 9"], "codex"), [{ version: "0.160.1", fileName: CODEX_FILE, size: 1000 }]);
  assert.deepEqual(parseCacheEntries(["2.1.290/claude-2.1.290-linux-x64 9", "2.1.290/claude-2.1.291-linux-x64 9", "2.1.290/claude-2.1.290-linux-arm64-musl 9"], "claude").map((e) => e.fileName), ["claude-2.1.290-linux-x64", "claude-2.1.290-linux-arm64-musl"]);
});

test("用不用缓存：首次安装用最新的缓存版本（比 latest 旧也用）；更新时缓存旧于 latest 或不比现装的新就不用", () => {
  const entries = [
    { version: "0.159.0", fileName: CODEX_FILE, size: 10 },
    { version: "0.160.1", fileName: CODEX_FILE, size: 10 },
    { version: "0.161.0", fileName: "codex-package-aarch64-unknown-linux-musl.tar.gz", size: 10 },
  ];
  const fresh = chooseCacheEntry({ cli: "codex", entries, target: CODEX_TARGET, targetVersion: "0.162.0" });
  assert.equal(fresh.entry.version, "0.160.1", "别的架构的包不算");
  assert.equal(fresh.olderThanTarget, true);
  assert.equal(chooseCacheEntry({ cli: "codex", entries, target: CODEX_TARGET, currentVersion: "0.159.0", targetVersion: "0.162.0" }).reason, "older-than-target");
  assert.equal(chooseCacheEntry({ cli: "codex", entries, target: CODEX_TARGET, currentVersion: "0.160.1", targetVersion: "0.160.1" }).reason, "not-newer");
  const update = chooseCacheEntry({ cli: "codex", entries, target: CODEX_TARGET, currentVersion: "0.159.0", targetVersion: "0.160.1" });
  assert.equal(update.entry.version, "0.160.1");
  assert.equal(update.olderThanTarget, false);
  assert.equal(chooseCacheEntry({ cli: "codex", entries: [], target: CODEX_TARGET }).reason, "none");
});

test("发布后清理：按版本从新到旧保留 2 个", () => {
  const e = (version) => ({ version, fileName: "x", size: 1 });
  assert.deepEqual(versionsToPrune([e("0.158.0"), e("0.160.1"), e("0.159.0"), e("0.157.2"), e("0.160.1")]), ["0.158.0", "0.157.2"]);
  assert.deepEqual(versionsToPrune([e("1.0.0")]), []);
  assert.equal(buildCachePruneCommand({ hubDir: "/h", cli: "codex", versions: [] }), null);
});

test("命令参数一律过白名单：文件名 / 版本 / sha256 / 共享目录不合法即抛错", () => {
  assert.throws(() => buildCacheCopyCommand({ hubDir: "/h", cli: "codex", version: "0.1.0", fileName: "a/b", sha256: SHA }), /文件名非法/);
  assert.throws(() => buildCacheCopyCommand({ hubDir: "/h", cli: "codex", version: "x", fileName: "a", sha256: SHA }), /版本号非法/);
  assert.throws(() => buildCachePublishCommand({ hubDir: "/h", cli: "codex", version: "0.1.0", fileName: "a", size: 1, sha256: "zz" }), /sha256 非法/);
  assert.throws(() => buildCachePublishCommand({ hubDir: "/h'", cli: "codex", version: "0.1.0", fileName: "a", size: 1, sha256: SHA }), /共享目录非法/);
  assert.throws(() => buildCacheListCommand("relative"), /共享目录非法/);
});

// 在假 HOME 旁边建一个「共享目录」并把产物发布进去（走真实的发布命令 + uploadViaSsh 的本机替身）。
async function publish(home, hubDir, cli, version, file) {
  const upload = fakeUpload(home);
  const res = await upload({ command: buildCachePublishCommand({ hubDir, cli, version, fileName: file.fileName, size: file.size, sha256: file.sha256 }), filePath: file.filePath, onProgress: () => {} });
  return parseRemoteKv(res.stdout).values;
}

test("发布：共享目录不存在时拒绝（不替它建成 0755）；存在时写入 0644 文件、0755 目录，列表能看到", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  const pkg = buildCodexPackage(fixtures, "0.160.1");
  assert.equal((await publish(home, hubDir, "codex", "0.160.1", pkg)).publish, "nohub");
  assert.equal(fs.existsSync(hubDir), false);

  fs.mkdirSync(hubDir, { mode: 0o1777 });
  assert.equal((await publish(home, hubDir, "codex", "0.160.1", pkg)).publish, "ok");
  const file = path.join(hubDir, "cli-cache", "codex", "0.160.1", CODEX_FILE);
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [CODEX_FILE], "不留 .part");

  const list = parseRemoteKv(runLocal(home, buildCacheListCommand(hubDir)).stdout);
  assert.equal(list.values.hub, "1");
  assert.deepEqual(parseCacheEntries(list.lists["cache.codex"]), [{ version: "0.160.1", fileName: CODEX_FILE, size: pkg.size }]);
  assert.equal(list.lists["cache.claude"], undefined);
});

test("发布：sha256 对不上 → badsum，不留任何文件；清理命令只删自己的 .part", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const pkg = buildCodexPackage(fixtures, "0.160.1");
  const values = await publish(home, hubDir, "codex", "0.160.1", { ...pkg, sha256: SHA });
  assert.equal(values.publish, "badsum");
  const dir = path.join(hubDir, "cli-cache", "codex", "0.160.1");
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.writeFileSync(path.join(dir, `${CODEX_FILE}.part.999`), "half");
  assert.equal(parseRemoteKv(runLocal(home, buildCachePublishCleanupCommand({ hubDir, cli: "codex", version: "0.160.1", fileName: CODEX_FILE })).stdout).values.cleanup, "ok");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("清理旧版本：只删列出的版本目录", { skip }, (t) => {
  const { root, home } = makeHome(t);
  const hubDir = path.join(root, "hub");
  for (const v of ["0.158.0", "0.159.0", "0.160.1"]) fs.mkdirSync(path.join(hubDir, "cli-cache", "codex", v), { recursive: true });
  const out = parseRemoteKv(runLocal(home, buildCachePruneCommand({ hubDir, cli: "codex", versions: ["0.158.0"] })).stdout);
  assert.deepEqual(out.lists.pruned, ["0.158.0"]);
  assert.deepEqual(fs.readdirSync(path.join(hubDir, "cli-cache", "codex")).sort(), ["0.159.0", "0.160.1"]);
});

test("拷贝：缓存文件 sha256 与官方不符 → badsum，私有上传目录里不留东西；文件不在 → missing", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const pkg = buildCodexPackage(fixtures, "0.160.1");
  await publish(home, hubDir, "codex", "0.160.1", pkg);
  const copy = (sha256, version = "0.160.1") => parseRemoteKv(runLocal(home, buildCacheCopyCommand({ hubDir, cli: "codex", version, fileName: CODEX_FILE, sha256 })).stdout).values;
  assert.equal(copy(SHA).copy, "badsum");
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache/cluster-workbench/cli/upload")), []);
  assert.equal(copy(pkg.sha256, "0.159.0").copy, "missing");
  const ok = copy(pkg.sha256);
  assert.equal(ok.copy, "ok");
  assert.equal(Number(ok.size), pkg.size);
  assert.equal(fs.statSync(path.join(home, ".cache/cluster-workbench/cli/upload", CODEX_FILE)).mode & 0o077, 0, "私有副本只有本人可读");
});

// install.mjs 的 deps：没有 env.sh（官方路径走不了），本机下载只在缓存没用上时才会被调用（记下来断言）。
function depsFor(home, hubDir, { codexPkg = null, claudeBin = null, officialSha = null } = {}) {
  const downloads = [];
  return {
    downloads,
    remote: fakeRemote(home),
    upload: fakeUpload(home),
    hubDir,
    resolveLatest: async (cli) => (cli === "codex" ? "0.160.1" : "2.1.292"),
    officialSizes: async () => null,
    resolveArtifact: async (cli, { version }) => {
      const f = cli === "codex" ? codexPkg : claudeBin;
      const sha256 = officialSha || f.sha256;
      return cli === "codex"
        ? { cli, version, target: CODEX_TARGET, fileName: f.fileName, urls: [], sha256, size: null }
        : { cli, version, platform: "linux-x64", fileName: f.fileName, urls: [], sha256, size: f.size };
    },
    download: async (artifact) => {
      downloads.push(artifact.fileName);
      const f = artifact.cli === "codex" ? codexPkg : claudeBin;
      return { filePath: f.filePath, size: f.size, sha256: f.sha256, reused: false };
    },
    cleanup: async () => {},
    newRemoteJobId: () => "cli-cachetest01",
    log: () => {},
  };
}

const FAST = { pollMs: 40, stallMs: 30000, maxOfficialMs: 60000 };

test("安装走团队缓存：codex 从零装好，不经本机下载、不起官方安装器，私有上传目录清空", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  await publish(home, hubDir, "codex", "0.160.1", codexPkg);
  const deps = depsFor(home, hubDir, { codexPkg });
  const job = createJobState({ jobId: "j-cache-1", serverId: "server-01", cli: "codex", targetVersion: "0.160.1" });
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "cache");
  assert.equal(job.installedVersion, "0.160.1");
  assert.deepEqual(deps.downloads, []);
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
  assert.ok(job.events.some((e) => /已从团队缓存拷贝/.test(e.text)));
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache/cluster-workbench/cli/upload")), []);
});

test("安装走团队缓存：Claude 首次安装，缓存比最新版旧也先装上并说明", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const claudeBin = buildClaudeBinary(fixtures, "2.1.290");
  await publish(home, hubDir, "claude", "2.1.290", claudeBin);
  const deps = depsFor(home, hubDir, { claudeBin });
  const job = createJobState({ jobId: "j-cache-2", serverId: "server-01", cli: "claude", targetVersion: "2.1.292" });
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "cache");
  assert.equal(job.installedVersion, "2.1.290");
  assert.ok(job.events.some((e) => /最新版是 2\.1\.292/.test(e.text)));
  assert.equal(readLink(home, ".local/bin/claude"), path.join(home, ".local/share/claude/versions/2.1.290"));
});

test("团队缓存被篡改（与官方 sha256 不符）→ 不用缓存，改走本机下载上传，装的是官方那份", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const good = buildCodexPackage(fixtures, "0.160.1");
  const evilFixtures = path.join(root, "evil");
  fs.mkdirSync(evilFixtures);
  const evil = buildCodexPackage(evilFixtures, "0.160.1", { omit: ["codex-path/rg"] });
  // 共享目录里放的是被换掉的包，用它自己的 sha256 写进去（模拟别人直接往 1777 目录里塞文件）。
  await publish(home, hubDir, "codex", "0.160.1", evil);
  const deps = depsFor(home, hubDir, { codexPkg: good });
  const job = createJobState({ jobId: "j-cache-3", serverId: "server-01", cli: "codex", targetVersion: "0.160.1" });
  await runInstallJob(job, deps, FAST);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.path, "fallback");
  assert.deepEqual(deps.downloads, [CODEX_FILE]);
  assert.ok(job.events.some((e) => /团队缓存没用上：团队缓存里的文件和官方校验和不一致/.test(e.text)));
});

test("mode=local（用户点了本机下载）时不碰缓存；缓存版本不比现装的新就跳过并说明", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const codexPkg = buildCodexPackage(fixtures, "0.160.1");
  await publish(home, hubDir, "codex", "0.160.1", codexPkg);
  const local = depsFor(home, hubDir, { codexPkg });
  const job = createJobState({ jobId: "j-cache-4", serverId: "server-01", cli: "codex", targetVersion: "0.160.1", mode: "local" });
  await runInstallJob(job, local, FAST);
  assert.equal(job.path, "fallback");
  assert.deepEqual(local.downloads, [CODEX_FILE]);

  // 现在已经装着 0.160.1：再点一次（比如想重装）不会拿同版本缓存「更新」。
  const again = depsFor(home, hubDir, { codexPkg });
  const job2 = createJobState({ jobId: "j-cache-5", serverId: "server-01", cli: "codex", targetVersion: "0.160.1" });
  await runInstallJob(job2, again, FAST);
  assert.ok(job2.events.some((e) => /不比集群上现在装的新/.test(e.text)), JSON.stringify(job2.events));
  assert.notEqual(job2.path, "cache");
});
