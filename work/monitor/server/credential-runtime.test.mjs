import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCredentialRuntime, FIXTURE_SSH_BLOCKED, guardFixtureSsh } from "./credential-runtime.mjs";

test("guardFixtureSsh: ssh / scp 不进执行器，按「没发出去」合成结果；其它命令照常执行", async () => {
  const calls = [];
  const execute = guardFixtureSsh(async (command, args, options) => {
    calls.push([command, args, options]);
    return { code: 0, stdout: "real", stderr: "", timedOut: false, truncated: false };
  });

  for (const command of ["ssh", "scp"]) {
    const result = await execute(command, ["example-cluster", "true"], { serverId: "server-01", input: "echo hi" });
    assert.deepEqual(result, { code: 255, stdout: "", stderr: FIXTURE_SSH_BLOCKED, timedOut: false, truncated: false });
  }
  assert.equal(calls.length, 0, "ssh / scp 没有碰到真正的执行器");

  const other = await execute("uname", ["-s"], { timeoutMs: 1000 });
  assert.equal(other.stdout, "real");
  assert.deepEqual(calls, [["uname", ["-s"], { timeoutMs: 1000 }]]);
});

// 用一份带真实形状服务器条目的配置起整套凭证运行时：fixture 模式下 ssh 连进程都不起（不依赖 PATH 里有没有 ssh），
// 也不把这次「执行」报给探针退避。
test("createCredentialRuntime: fixtureMode 下执行器对 ssh 不起进程、不回调 onSshResult", async () => {
  const runtimeDir = await mkdtemp(path.join(os.tmpdir(), "cwb-cred-fixture-"));
  const env = { PATH: path.join(runtimeDir, "empty-bin") };
  const reported = [];
  const runtime = await createCredentialRuntime({
    env,
    getConfig: async () => ({ servers: [{ id: "server-01", host: "example-cluster" }] }),
    runtimeDir,
    rootDir: runtimeDir,
    onSshResult: (event) => reported.push(event),
    fixtureMode: true,
  });
  try {
    const result = await runtime.executeRuntime("ssh", ["example-cluster", "true"], { serverId: "server-01", timeoutMs: 2000 });
    assert.equal(result.code, 255);
    assert.equal(result.stderr, FIXTURE_SSH_BLOCKED);
    assert.equal(reported.length, 0);
  } finally {
    runtime.closeOwnedVault();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test("start.mjs 把 fixtureMode 交给凭证运行时（源码级接线守卫）", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./start.mjs", import.meta.url), "utf8");
  assert.match(source, /createCredentialRuntime\(\{[^}]*\bfixtureMode\b[^}]*\}\)/);
});
