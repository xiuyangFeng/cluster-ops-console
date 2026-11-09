import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { supervisorPipeName } from "./singleton.mjs";

test("Windows 单实例锁作用域按运行目录隔离，路径大小写和分隔符不造成双锁", () => {
  assert.equal(supervisorPipeName('C:\\用户\\Data\\runtime'), supervisorPipeName('c:/用户/Data/runtime'));
  assert.notEqual(supervisorPipeName('C:\\first'), supervisorPipeName('C:\\second'));
});

test("Windows 原生命名管道：4 进程并发只有一个获锁，持有者被强杀后可重新取得", { skip: process.platform !== "win32", timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "supervisor-lease-"));
  const children = [];
  const source = `import { acquireSupervisorLease } from ${JSON.stringify(new URL("./singleton.mjs", import.meta.url).href)}; const lease = await acquireSupervisorLease(process.argv[1]); process.send({ acquired: Boolean(lease) }); if (!lease) process.exit(3); process.on('message', () => process.exit(0));`;
  const start = () => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, dir], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    return child;
  };
  try {
    const contenders = Array.from({ length: 4 }, start);
    const replies = await Promise.all(contenders.map(async (child) => {
      const [message] = await once(child, "message");
      return { child, acquired: message.acquired };
    }));
    assert.equal(replies.filter((r) => r.acquired).length, 1);
    const winner = replies.find((r) => r.acquired).child;
    const exited = once(winner, "exit");
    winner.kill("SIGKILL");
    await exited;
    const replacement = start();
    assert.equal((await once(replacement, "message"))[0].acquired, true);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }));
    await rm(dir, { recursive: true, force: true });
  }
});
