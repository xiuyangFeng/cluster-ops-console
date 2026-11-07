import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { RUNTIME_SNAPSHOT_FILENAME, SNAPSHOT_STALE_AFTER_MS } from "../lib/runtime-snapshot.mjs";
import { createStorageMaintenance, DEFAULT_STORAGE_BUDGET_BYTES, readLiveControlInstanceId, resolveStorageBudgetBytes } from "./storage-maintenance.mjs";

test("resolveStorageBudgetBytes：合法正数照用，缺省 / 非法 / 非正回落 50MB", () => {
  assert.equal(DEFAULT_STORAGE_BUDGET_BYTES, 50 * 1024 * 1024);
  assert.equal(resolveStorageBudgetBytes({ storageBudgetBytes: 1024 }), 1024);
  assert.equal(resolveStorageBudgetBytes({ storageBudgetBytes: "2048" }), 2048);
  for (const bad of [undefined, null, 0, -1, "abc", Number.POSITIVE_INFINITY]) {
    assert.equal(resolveStorageBudgetBytes({ storageBudgetBytes: bad }), DEFAULT_STORAGE_BUDGET_BYTES, String(bad));
  }
  assert.equal(resolveStorageBudgetBytes(null), DEFAULT_STORAGE_BUDGET_BYTES);
});

// 真实临时目录：信箱清理的判定全靠 lstat / rmdir / 目录项类型的真实语义，内存 fake 证明不了这些。
async function tempRuntime(t) {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "storage-maint-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

// supervisor 运行快照（lib/runtime-snapshot.mjs 读取侧要求的最小形状）。
const writeSnapshot = (runtimeDir, { instanceId, observedAt }) => writeFile(
  path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME),
  JSON.stringify({ schemaVersion: 1, instanceId, pid: process.pid, startedAt: observedAt, observedAt, targets: {}, capabilities: {} }),
);

const DAY_MS = 24 * 60 * 60 * 1000;
const SUBDIRS = ["requests", "processing", "results"];

// 建一棵信箱目录并把整棵的 mtime 拨到 ageMs 之前（先建完再拨：往目录里加东西会刷新它的 mtime）。
async function controlTree(root, id, { ageMs = 3 * DAY_MS, resultFile = false } = {}) {
  const dir = path.join(root, id);
  for (const sub of SUBDIRS) await mkdir(path.join(dir, sub), { recursive: true });
  if (resultFile) await writeFile(path.join(dir, "results", "6fe02ade-659f-45d5-8af9-0625a095368b.json"), "{}");
  const when = new Date(Date.now() - ageMs);
  for (const target of [...SUBDIRS.map((sub) => path.join(dir, sub)), dir]) await utimes(target, when, when);
  return dir;
}

test("readLiveControlInstanceId：只认新鲜的运行快照；没有 / 过期 / 损坏一律 null", async (t) => {
  const runtimeDir = await tempRuntime(t);
  const now = Date.now();
  assert.equal(await readLiveControlInstanceId(runtimeDir), null, "还没有快照");

  await writeSnapshot(runtimeDir, { instanceId: "4ce822ca", observedAt: now });
  assert.equal(await readLiveControlInstanceId(runtimeDir, { nowMs: now }), "4ce822ca");
  assert.equal(await readLiveControlInstanceId(runtimeDir, { nowMs: now + SNAPSHOT_STALE_AFTER_MS + 1 }), null, "supervisor 超过 30 秒没刷新快照");

  await writeFile(path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME), "{broken");
  assert.equal(await readLiveControlInstanceId(runtimeDir, { nowMs: now }), null);
  await writeFile(path.join(runtimeDir, RUNTIME_SNAPSHOT_FILENAME), JSON.stringify({ schemaVersion: 1, pid: 1, observedAt: now, targets: {}, capabilities: {} }));
  assert.equal(await readLiveControlInstanceId(runtimeDir, { nowMs: now }), null, "快照里没有实例号");
});

test("装配：一轮清理在真实目录上清掉孤儿信箱目录与没人再读的旧分卷；当前实例、带结果文件的、不满 24 小时的、符号链接都原样留着", async (t) => {
  const runtimeDir = await tempRuntime(t);
  const outside = await mkdtemp(path.join(tmpdir(), "storage-maint-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const control = path.join(runtimeDir, "control");
  const logs = [];

  await writeSnapshot(runtimeDir, { instanceId: "4ce822ca", observedAt: Date.now() });
  await controlTree(control, "4ce822ca"); // 当前 supervisor 的：三天没有过请求，照样不动
  await controlTree(control, "044c1e27"); // 孤儿
  await controlTree(control, "053a0b35"); // 孤儿
  await controlTree(control, "6a398d5a", { resultFile: true }); // 还留着一份结果
  await controlTree(control, "0dfe0794", { ageMs: 60 * 60 * 1000 }); // 一小时前才建
  // runtime 之外的一棵「看起来像孤儿」的目录，经符号链接挂进来：不得顺着链接删到外面去。
  const outsideTree = await controlTree(outside, "7b64dd06");
  let linked = true;
  try {
    await symlink(outsideTree, path.join(control, "7b64dd06"), "dir");
  } catch {
    linked = false; // Windows 上没有建符号链接的权限：这一条不测，其余照测
  }

  const logsDir = path.join(runtimeDir, "logs");
  await mkdir(logsDir, { recursive: true });
  for (const name of ["supervisor.ndjson", "supervisor.ndjson.1", "supervisor.ndjson.2", "supervisor.ndjson.3", "timeline.ndjson.1"]) {
    await writeFile(path.join(logsDir, name), "x".repeat(64));
  }

  const storage = createStorageMaintenance({ runtimeDir, getMergedConfig: () => ({}), appendLog: (message, fields) => logs.push({ message, ...fields }) });
  const result = await storage.sweeperForRouter.sweep();

  assert.deepEqual((await readdir(control)).sort(), ["0dfe0794", "4ce822ca", "6a398d5a", ...(linked ? ["7b64dd06"] : [])].sort());
  assert.deepEqual((await readdir(path.join(control, "4ce822ca"))).sort(), [...SUBDIRS].sort(), "当前实例的三个子目录都在");
  assert.ok(existsSync(path.join(control, "6a398d5a", "results", "6fe02ade-659f-45d5-8af9-0625a095368b.json")));
  assert.deepEqual((await readdir(outsideTree)).sort(), [...SUBDIRS].sort(), "runtime 之外的目录原样");

  assert.deepEqual((await readdir(logsDir)).sort(), ["supervisor.ndjson", "supervisor.ndjson.1", "timeline.ndjson.1"]);
  assert.deepEqual(result.evicted.map((e) => [path.basename(e.path), e.bytes, e.kind]).sort(), [
    ["supervisor.ndjson.2", 64, "logRotations"],
    ["supervisor.ndjson.3", 64, "logRotations"],
  ]);
  assert.deepEqual(logs.map((entry) => [entry.event, entry.controlDirs]), [["storage-control-orphans", 2]]);
});

test("装配：没有新鲜的运行快照（通道停着 / supervisor 刚退出）时，信箱目录一棵都不删", async (t) => {
  const runtimeDir = await tempRuntime(t);
  const control = path.join(runtimeDir, "control");
  await controlTree(control, "044c1e27");
  await controlTree(control, "4ce822ca");
  const storage = createStorageMaintenance({ runtimeDir, getMergedConfig: () => ({}), appendLog: () => {} });

  await storage.sweeperForRouter.sweep(); // 没有快照
  assert.deepEqual((await readdir(control)).sort(), ["044c1e27", "4ce822ca"]);

  await writeSnapshot(runtimeDir, { instanceId: "4ce822ca", observedAt: Date.now() - 10 * 60 * 1000 }); // 十分钟前的快照
  await storage.sweeperForRouter.sweep();
  assert.deepEqual((await readdir(control)).sort(), ["044c1e27", "4ce822ca"]);

  await writeSnapshot(runtimeDir, { instanceId: "4ce822ca", observedAt: Date.now() }); // supervisor 活着
  await storage.sweeperForRouter.sweep();
  assert.deepEqual(await readdir(control), ["4ce822ca"]);
});
