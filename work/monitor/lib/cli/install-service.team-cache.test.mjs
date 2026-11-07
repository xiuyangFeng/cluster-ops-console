// install-service.mjs 的 v2.89 部分：团队缓存列表（60 秒复用）、管理员发布的门禁与任务、测试对话占锁。
import assert from "node:assert/strict";
import test from "node:test";

import { createCliInstallService, TEAM_CACHE_TTL_MS } from "./install-service.mjs";
import { createCliTaskLock } from "./task-lock.mjs";

const TEAM = { id: "server-01", name: "集群", host: "myserver" };
const CODEX_FILE = "codex-package-x86_64-unknown-linux-musl.tar.gz";

function makeService({ sshUser = "alice", adminUsers = ["kai"], stdout = "", server = TEAM, publishImpl, taskLock = createCliTaskLock(), now } = {}) {
  const commands = [];
  const svc = createCliInstallService({
    getConfig: async () => ({ servers: [server], activeServerId: server.id, sshUser, adminUsers, portRegistry: { dir: "/public/agent-hub/ports" } }),
    getMainServerConfig: () => server,
    sshArgsFor: () => [server.host],
    execCollector: async ({ args }) => {
      commands.push(args.at(-1));
      return { code: 0, stdout: typeof stdout === "function" ? stdout(args.at(-1)) : stdout, stderr: "" };
    },
    versions: { getLatest: async () => ({ codex: { latest: "0.160.1" }, claude: { latest: "2.1.292" } }) },
    downloadDir: "/nonexistent",
    taskLock,
    resolveSshUser: () => "",
    ...(publishImpl ? { publishImpl } : {}),
    ...(now ? { now } : {}),
  });
  return { svc, commands, taskLock };
}

const LIST = [
  "v=1",
  "hub=1",
  `cache.codex=0.159.0/${CODEX_FILE} 100`,
  `cache.codex=0.160.1/${CODEX_FILE} 120`,
  `cache.codex=0.160.1/${CODEX_FILE}.part.77 10`,
  "cache.claude=2.1.290/claude-2.1.290-linux-x64 300",
  "end=1",
].join("\n");

test("团队缓存列表：共享目录跟团队管理同一个（由端口登记目录推出）；按版本新到旧，best 给最高版；60 秒内复用", async () => {
  let t = 1000;
  const { svc, commands } = makeService({ stdout: LIST, now: () => t });
  const view = await svc.teamCache();
  assert.equal(view.dir, "/public/agent-hub/cli-cache");
  assert.equal(view.hub, true);
  assert.equal(view.isAdmin, false);
  assert.deepEqual(view.entries.codex, [{ version: "0.160.1", size: 120 }, { version: "0.159.0", size: 100 }]);
  assert.deepEqual(view.best, { codex: "0.160.1", claude: "2.1.290" });
  assert.match(commands[0], /\/public\/agent-hub\/cli-cache\/codex/);
  await svc.teamCache();
  assert.equal(commands.length, 1, "60 秒内复用");
  t += TEAM_CACHE_TTL_MS + 1;
  await svc.teamCache();
  assert.equal(commands.length, 2);
  await svc.teamCache(null, {}, { force: true });
  assert.equal(commands.length, 3, "force 跳过复用");
});

test("团队缓存列表：SSH 没回完整 → 空列表 + 说明，不抛错", async () => {
  const { svc } = makeService({ stdout: "v=1\n" });
  const view = await svc.teamCache();
  assert.deepEqual(view.entries, { codex: [], claude: [] });
  assert.match(view.error, /读不到团队缓存/);
});

test("发布：非管理员 403；管理员起任务（action=publish，任务锁 kind=publish），结束后作废缓存列表", async () => {
  const denied = makeService();
  await assert.rejects(denied.svc.startPublish("codex"), (err) => err.status === 403 && /adminUsers/.test(err.message));

  let finish;
  const publishImpl = (job, deps) => new Promise((resolve) => {
    assert.equal(deps.hubDir, "/public/agent-hub");
    finish = () => resolve(Object.assign(job, { status: "succeeded", installedVersion: "0.160.1", finishedAt: Date.now() }));
  });
  const { svc, taskLock, commands } = makeService({ sshUser: "kai", stdout: LIST, publishImpl });
  assert.equal((await svc.teamCache()).isAdmin, true);
  const { job } = await svc.startPublish("codex");
  assert.equal(job.action, "publish");
  assert.equal(job.targetVersion, "0.160.1");
  assert.equal(taskLock.current("server-01").kind, "publish");
  await assert.rejects(svc.startInstall("claude"), (err) => err.status === 409, "发布期间不能安装");
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(taskLock.current("server-01"), null);
  await svc.teamCache();
  assert.equal(commands.length, 2, "发布结束后重新列缓存");
});

test("发布：密码连接的服务器（不能上传）→ 409", async () => {
  const { svc } = makeService({ sshUser: "kai", server: { ...TEAM, authRef: "cred-1" } });
  await assert.rejects(svc.startPublish("claude"), (err) => err.status === 409 && /密码连接/.test(err.message));
});

test("测试对话：占任务锁（kind=smoke），结果按远端输出判定；结束释放锁", async () => {
  let seenLock = null;
  const lock = createCliTaskLock();
  const { svc } = makeService({
    taskLock: lock,
    stdout: () => {
      seenLock = lock.current("server-01");
      return "v=1\nenvsh=1\nrc=0\nsecs=4\nsmoke=ok\nreply=WORKBENCH-OK\nend=1\n";
    },
  });
  const result = await svc.smokeTest("claude");
  assert.equal(result.ok, true);
  assert.equal(result.seconds, 4);
  assert.equal(seenLock.kind, "smoke");
  assert.equal(lock.current("server-01"), null);
  await assert.rejects(svc.smokeTest("zcode"), (err) => err.status === 400);
});
