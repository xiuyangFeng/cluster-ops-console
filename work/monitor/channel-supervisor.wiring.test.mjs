// supervisor 接线（源码级）：从 vault-endpoint-file.test.mjs 迁来，只断言 supervisor 自己的源码
// （取密码的实现已迁到 lib/supervisor/remote-probe.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveCheckInterval } from "./channel-supervisor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("CHECK_INTERVAL_MS 非法值回退，避免 supervisor 忙循环或过慢", () => {
  assert.equal(resolveCheckInterval(undefined), 5000);
  assert.equal(resolveCheckInterval("250"), 250);
  assert.equal(resolveCheckInterval("300000"), 300000);
  for (const raw of ["-1", "249", "1.5", "300001", "NaN", "Infinity"]) {
    assert.equal(resolveCheckInterval(raw), 5000, raw);
  }
});

test("supervisor 取密码走现读端点，不再只认启动时 env", () => {
  const src = readFileSync(path.join(here, "lib/supervisor/remote-probe.mjs"), "utf8");
  const fn = src.slice(src.indexOf("async function readTunnelPassword"), src.indexOf("export async function remotePortOpen"));
  assert.match(fn, /readPasswordFromVaultEndpoints\(\{ authRef, runtimeDir/);
  assert.doesNotMatch(fn, /process\.env\.CODEX_MONITOR_VAULT_URL/);
});

// 被 import（测试 / 未来 monitor 侧复用纯函数）时不得起一份 supervisor 的家当：
// 不建 runtime/logs、不写日志文件、不挂信号与致命错误处理器。子进程里测，避免污染本进程。
test("channel-supervisor.mjs 被 import 时零副作用", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "sup-import-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const entry = pathToFileURL(path.join(here, "channel-supervisor.mjs")).href;
  const script = [
    `await import(${JSON.stringify(entry)});`,
    "console.log(JSON.stringify({",
    '  listeners: ["SIGTERM", "SIGINT", "SIGUSR2", "uncaughtException", "unhandledRejection"].map((e) => process.listenerCount(e)),',
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CODEX_MONITOR_DATA_DIR: dataDir },
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  const info = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.deepEqual(info.listeners, [0, 0, 0, 0, 0]);
  assert.deepEqual(await readdir(dataDir), [], "数据目录下不得出现 runtime/ 或日志");
});
