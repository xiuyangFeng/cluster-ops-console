// Bootstrap exec 适配：ssh/scp 走 SSH 运行时，其余命令原样 execFile。
import assert from "node:assert/strict";
import test from "node:test";

import { createBootstrapExec } from "./services.mjs";

test("createBootstrapExec：非 ssh/scp 原样转 execFile", async () => {
  const seen = [];
  const exec = createBootstrapExec({
    executeRuntime: () => assert.fail("本地命令不应走 SSH 运行时"),
    execFileImpl: async (cmd, args, options) => {
      seen.push({ cmd, args, options });
      return { stdout: "ok" };
    },
  });
  assert.deepEqual(await exec("tar", ["-czf", "x"], { timeout: 5 }), { stdout: "ok" });
  assert.deepEqual(seen, [{ cmd: "tar", args: ["-czf", "x"], options: { timeout: 5 } }]);
});

test("createBootstrapExec：ssh 映射 timeout/maxBuffer 并把非零退出翻译成 execFile 风格异常", async () => {
  const calls = [];
  let result = { code: 0, stdout: "done", stderr: "" };
  const exec = createBootstrapExec({
    executeRuntime: async (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return result;
    },
    execFileImpl: () => assert.fail("ssh 不应直接 execFile"),
  });
  assert.equal((await exec("ssh", ["host", "true"], { timeout: 10, maxBuffer: 20, cwd: "/x" })).stdout, "done");
  assert.deepEqual(calls[0].options, { cwd: "/x", timeoutMs: 10, maxOutputBytes: 20 });

  result = { code: 255, stdout: "", stderr: "Permission denied" };
  await assert.rejects(exec("scp", ["a", "b"]), (error) => error.message === "Permission denied" && error.code === 255);
  result = { code: 0, timedOut: true, stdout: "", stderr: "" };
  await assert.rejects(exec("ssh", ["h"]), /SSH bootstrap failed/);
});
