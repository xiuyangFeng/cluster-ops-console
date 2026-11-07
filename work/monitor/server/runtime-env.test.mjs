import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_SSE_CONNECTIONS,
  DEFAULT_PORT,
  DEFAULT_SSE_HEARTBEAT_MS,
  envNumber,
  envIntegerInRange,
  readPackageVersion,
  resolveRuntimeEnv,
  resolveServerLocations,
} from "./runtime-env.mjs";

const MONITOR_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("envNumber: 缺省 / 空串 / 非数字一律回退默认值，合法数字（含 0）照用", () => {
  assert.equal(envNumber({}, "PORT", 8877), 8877);
  assert.equal(envNumber({ PORT: "" }, "PORT", 8877), 8877);
  assert.equal(envNumber({ PORT: "abc" }, "PORT", 8877), 8877, "NaN 端口不得漏进 listen");
  assert.equal(envNumber({ PORT: "Infinity" }, "PORT", 8877), 8877);
  assert.equal(envNumber({ PORT: "0" }, "PORT", 8877), 0, "PORT=0 是冒烟用的临时端口");
  assert.equal(envNumber({ PORT: "9001" }, "PORT", 8877), 9001);
});

test("envIntegerInRange: 启动参数拒绝小数/越界/负数，但端口 0 仍可用于冒烟", () => {
  assert.equal(envIntegerInRange({ PORT: "0" }, "PORT", 8877, { min: 0, max: 65535 }), 0);
  assert.equal(envIntegerInRange({ PORT: "65535" }, "PORT", 8877, { min: 0, max: 65535 }), 65535);
  for (const raw of ["-1", "65536", "1.5", "NaN", "Infinity", "   "]) {
    assert.equal(envIntegerInRange({ PORT: raw }, "PORT", 8877, { min: 0, max: 65535 }), 8877, raw);
  }
  assert.equal(envIntegerInRange({ SSE_HEARTBEAT_MS: "99" }, "SSE_HEARTBEAT_MS", 15000, { min: 100, max: 3_600_000 }), 15000);
  assert.equal(envIntegerInRange({ SSE_HEARTBEAT_MS: "100" }, "SSE_HEARTBEAT_MS", 15000, { min: 100, max: 3_600_000 }), 100);
});

test("resolveRuntimeEnv: 默认值与历史常量一致；fixture 只认字面量 \"1\"", () => {
  assert.deepEqual(resolveRuntimeEnv({}), {
    port: DEFAULT_PORT,
    fixtureMode: false,
    authToken: "",
    maxSseConnections: DEFAULT_MAX_SSE_CONNECTIONS,
    sseHeartbeatMs: DEFAULT_SSE_HEARTBEAT_MS,
  });
  assert.equal(DEFAULT_PORT, 8877);
  assert.equal(DEFAULT_MAX_SSE_CONNECTIONS, 8);
  assert.equal(DEFAULT_SSE_HEARTBEAT_MS, 15000);
  const env = resolveRuntimeEnv({
    PORT: "0",
    CODEX_MONITOR_FIXTURE_MODE: "1",
    AUTH_TOKEN: "tok",
    MAX_SSE_CONNECTIONS: "3",
    SSE_HEARTBEAT_MS: "500",
  });
  assert.deepEqual(env, { port: 0, fixtureMode: true, authToken: "tok", maxSseConnections: 3, sseHeartbeatMs: 500 });
  assert.equal(resolveRuntimeEnv({ CODEX_MONITOR_FIXTURE_MODE: "true" }).fixtureMode, false);
  assert.deepEqual(resolveRuntimeEnv({ PORT: "-1", MAX_SSE_CONNECTIONS: "0", SSE_HEARTBEAT_MS: "1.5" }), {
    port: DEFAULT_PORT,
    fixtureMode: false,
    authToken: "",
    maxSseConnections: DEFAULT_MAX_SSE_CONNECTIONS,
    sseHeartbeatMs: DEFAULT_SSE_HEARTBEAT_MS,
  });
});

test("resolveServerLocations: appRoot 为源码根、publicDir 为 work/monitor/public，数据目录随环境变量", () => {
  const dataDir = path.join(tmpdir(), "monitor-env-test-data");
  const loc = resolveServerLocations({ CODEX_MONITOR_DATA_DIR: dataDir });
  assert.equal(loc.rootDir, path.resolve(MONITOR_DIR, "../.."));
  assert.equal(loc.publicDir, path.join(MONITOR_DIR, "public"));
  assert.equal(loc.runtimeDir, path.join(dataDir, "runtime"));
  assert.equal(loc.paths.dataRoot, dataDir);
});

test("readPackageVersion: 读 package.json 的 version；缺文件 / 坏 JSON / 缺字段回落 0.0.0", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-version-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await readPackageVersion(dir), "0.0.0");
  await writeFile(path.join(dir, "package.json"), "{ broken");
  assert.equal(await readPackageVersion(dir), "0.0.0");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  assert.equal(await readPackageVersion(dir), "0.0.0");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
  assert.equal(await readPackageVersion(dir), "9.9.9");
});
