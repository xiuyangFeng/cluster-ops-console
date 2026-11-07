// 自更新的自检：真的把一份源码树以 fixture 模式起一遍（临时端口 + 临时数据目录），不碰真实配置与现役端口。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { spawnFixtureMonitor } from "../fixture-monitor.mjs";
import { smokeSourceTree } from "./smoke.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function fakeTree(t, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "self-update-smoke-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(path.join(dir, "work", "monitor"), { recursive: true });
  fs.writeFileSync(path.join(dir, "work", "monitor", "monitor-server.mjs"), script);
  return dir;
}

test("自检：当前这份源码的监控服务能在隔离环境里起来并应答", async () => {
  const result = await smokeSourceTree(repoRoot, { timeoutMs: 60_000 });
  assert.deepEqual(result, { ok: true });
});

test("自检：监控服务一启动就退出 → 不通过，带上它的输出", async (t) => {
  const tree = fakeTree(t, 'console.error("SyntaxError: boom from new version"); process.exit(3);\n');
  // 断言的是「看得出它退出了」，不是它退得多快：全量并发、机器很忙时起一个 node 子进程偶尔要十几秒
  //（15 秒的时限红过一次，输出为空——子进程还没跑到第一行），时限放到与上一条用例相同。
  const result = await smokeSourceTree(tree, { timeoutMs: 60_000 });
  assert.equal(result.ok, false);
  assert.match(result.detail, /立刻退出了（退出码 3）/);
  assert.match(result.detail, /boom from new version/);
});

test("自检：迟迟不应答 → 不通过；子进程被收掉、临时目录不留", async (t) => {
  const tree = fakeTree(t, "setInterval(() => {}, 1000);\n");
  // 包一层真实的启动器，记下它起的进程与数据目录（不靠子进程自己落文件，机器忙的时候它可能还没跑到那一步）。
  let spawned = null;
  const result = await smokeSourceTree(tree, {
    timeoutMs: 1500,
    spawnMonitor: (options) => {
      const monitor = spawnFixtureMonitor(options);
      spawned = { pid: monitor.child.pid, dataDir: options.dataDir, port: options.port };
      return monitor;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /没有就绪/);
  assert.ok(spawned.dataDir.startsWith(os.tmpdir()), `数据目录在临时目录下: ${spawned.dataDir}`);
  assert.ok(![8877, 8888].includes(spawned.port), "不用现役端口");
  assert.equal(fs.existsSync(path.dirname(spawned.dataDir)), false, "自检的临时目录已删除");
  const gone = () => {
    try {
      process.kill(spawned.pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  for (let i = 0; i < 100 && !gone(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(gone(), true, "自检起的子进程已结束");
});

test("自检：起不了进程也只是不通过，不抛错", async () => {
  const result = await smokeSourceTree(repoRoot, { spawnMonitor: () => { throw new Error("spawn EACCES"); } });
  assert.equal(result.ok, false);
  assert.match(result.detail, /spawn EACCES/);
});
