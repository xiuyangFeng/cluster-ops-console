// publish.mjs：管理员发布到团队缓存，在假 HOME + 临时共享目录里端到端演练。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { createJobState } from "./install.mjs";
import { runPublishJob } from "./publish.mjs";
import { buildCodexPackage, fakeRemote, fakeUpload, makeHome } from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;
const FILE = "codex-package-x86_64-unknown-linux-musl.tar.gz";

function depsFor(home, hubDir, pkgs) {
  const downloads = [];
  const cleaned = [];
  return {
    downloads,
    cleaned,
    remote: fakeRemote(home),
    upload: fakeUpload(home),
    hubDir,
    resolveLatest: async () => "0.160.1",
    resolveArtifact: async (cli, { version }) => ({ cli, version, target: "x86_64-unknown-linux-musl", fileName: FILE, urls: [], sha256: pkgs[version].sha256, size: null }),
    download: async (artifact, { onProgress }) => {
      downloads.push(artifact.version);
      const f = pkgs[artifact.version];
      onProgress({ bytes: f.size, total: f.size });
      return { filePath: f.filePath, size: f.size, sha256: f.sha256 };
    },
    cleanup: async (artifact) => cleaned.push(artifact.version),
    log: () => {},
  };
}

const newJob = (targetVersion = null) => createJobState({ jobId: `pub-${Math.random().toString(36).slice(2, 10)}`, serverId: "server-01", cli: "codex", action: "publish", targetVersion });

test("发布：下载 → 写入共享目录 → 再发同版本直接成功不重下；超过 2 个版本删最旧的", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  fs.mkdirSync(hubDir);
  const pkgs = {};
  for (const v of ["0.158.0", "0.159.0", "0.160.1"]) {
    const dir = path.join(fixtures, v);
    fs.mkdirSync(dir);
    pkgs[v] = buildCodexPackage(dir, v);
  }
  const deps = depsFor(home, hubDir, pkgs);
  for (const v of ["0.158.0", "0.159.0"]) {
    const job = await runPublishJob(newJob(v), deps);
    assert.equal(job.status, "succeeded", job.error);
  }
  const job = await runPublishJob(newJob(), deps);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal(job.installedVersion, "0.160.1");
  assert.equal(job.path, "publish");
  assert.ok(job.events.some((e) => /已删除更旧的缓存版本：0\.158\.0/.test(e.text)), JSON.stringify(job.events));
  assert.deepEqual(fs.readdirSync(path.join(hubDir, "cli-cache", "codex")).sort(), ["0.159.0", "0.160.1"]);
  assert.deepEqual(deps.cleaned, ["0.158.0", "0.159.0", "0.160.1"], "本机安装包发布后删掉");

  const again = await runPublishJob(newJob("0.160.1"), deps);
  assert.equal(again.status, "succeeded");
  assert.ok(again.events.some((e) => /已经有 Codex 0\.160\.1/.test(e.text)));
  assert.deepEqual(deps.downloads, ["0.158.0", "0.159.0", "0.160.1"], "已在缓存里就不再下载");
});

test("发布：共享目录不存在 → 失败并说明，不建目录；信号早就响了 → cancelled，一条命令都不发", { skip }, async (t) => {
  const { root, home, fixtures } = makeHome(t);
  const hubDir = path.join(root, "hub");
  const pkgs = { "0.160.1": buildCodexPackage(fixtures, "0.160.1") };
  const job = await runPublishJob(newJob("0.160.1"), depsFor(home, hubDir, pkgs));
  assert.equal(job.status, "failed");
  assert.match(job.error, /还没有团队共享目录/);
  assert.equal(fs.existsSync(hubDir), false);

  const calls = [];
  const deps = { ...depsFor(home, hubDir, pkgs), remote: async (c) => { calls.push(c); return { stdout: "" }; } };
  const controller = new AbortController();
  controller.abort();
  const cancelled = await runPublishJob(newJob("0.160.1"), deps, { signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(calls, []);
});
