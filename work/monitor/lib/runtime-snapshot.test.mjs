// runtime-snapshot 契约与降级测试（T01，验收 A01/A02/A03）。
// 隔离：全部使用临时目录与 fixture.invalid，不触真实集群。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildConnectionTargetsProjection,
  buildRuntimeSnapshot,
  computeConfigRevision,
  readRuntimeSnapshotFile,
  verifySnapshotOwnership,
  writeRuntimeSnapshotFile,
  SNAPSHOT_MAX_BYTES,
} from "./runtime-snapshot.mjs";
import { buildRuntimeSnapshot as fixtureSnapshot, buildThreeServerConfig } from "./m1-fixtures.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "m1-snapshot-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("快照: 原子写入后可读回，schemaVersion=1", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "supervisor-state.json");
    const snapshot = buildRuntimeSnapshot({
      instanceId: "inst-1",
      pid: 4242,
      startedAt: 1000,
      observedAt: 2000,
      configRevision: "rev",
      capabilities: { scopedTunnelRestart: true, controlProtocol: 1 },
      effectiveProxyPort: 28888,
      targets: { a: { host: "fixture-a.invalid", remotePort: 17891, localPort: 28888, signature: "sig" } },
    });
    await writeRuntimeSnapshotFile(file, snapshot);
    const { snapshot: read, reason } = await readRuntimeSnapshotFile(file, { nowMs: 2000 });
    assert.equal(reason, "ok");
    assert.equal(read.schemaVersion, 1);
    assert.equal(read.effectiveProxyPort, 28888);
    assert.equal(read.targets.a.remotePort, 17891);
  });
});

test("快照降级: 文件不存在 / JSON 损坏 / 超限 / 形状不符 → snapshot=null 且 reason 明确", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(
      await readRuntimeSnapshotFile(path.join(dir, "missing.json")),
      { snapshot: null, reason: "no-snapshot" },
    );
    const broken = path.join(dir, "broken.json");
    await writeFile(broken, '{"schemaVersion":1,"instanceId":"x",', "utf8");
    assert.equal((await readRuntimeSnapshotFile(broken)).reason, "invalid-json");

    const oversized = path.join(dir, "oversized.json");
    await writeFile(oversized, "x".repeat(SNAPSHOT_MAX_BYTES + 1), "utf8");
    assert.equal((await readRuntimeSnapshotFile(oversized)).reason, "oversized");

    const wrongShape = path.join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ schemaVersion: 2 }), "utf8");
    assert.equal((await readRuntimeSnapshotFile(wrongShape)).reason, "invalid-schema");
  });
});

test("快照过期: observedAt 超过 staleAfterMs 判 stale，不把磁盘旧快照当仍在运行", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "stale.json");
    await writeRuntimeSnapshotFile(file, buildRuntimeSnapshot({
      instanceId: "inst-1", pid: 4242, startedAt: 0, observedAt: 0, configRevision: "rev",
      effectiveProxyPort: 28888, targets: {},
    }));
    const { snapshot, reason, stale } = await readRuntimeSnapshotFile(file, { nowMs: 60_000 });
    assert.equal(reason, "stale");
    assert.equal(stale, true);
    assert.ok(snapshot, "过期快照仍返回内容，由调用方决定如何展示");
  });
});

test("归属核实: pid 不存活或注册表不匹配 → false（mtime 不能独自证明有效）", () => {
  const snapshot = fixtureSnapshot();
  assert.equal(
    verifySnapshotOwnership(snapshot, { registry: { readMeta: () => ({ pid: 12345 }) }, pidAlive: () => true }),
    true,
  );
  assert.equal(
    verifySnapshotOwnership(snapshot, { registry: { readMeta: () => ({ pid: 12345 }) }, pidAlive: () => false }),
    false,
    "pid 已死必须拒绝",
  );
  assert.equal(
    verifySnapshotOwnership(snapshot, { registry: { readMeta: () => ({ pid: 999 }) }, pidAlive: () => true }),
    false,
    "注册表 pid 与快照不一致（pid 复用）必须拒绝",
  );
  assert.equal(
    verifySnapshotOwnership(snapshot, { registry: { readMeta: () => null }, pidAlive: () => true }),
    false,
  );
});

test("configRevision: 同一配置稳定，服务器/端口/选择变化即变化", () => {
  const config = buildThreeServerConfig();
  const a = computeConfigRevision(config);
  assert.equal(a, computeConfigRevision(buildThreeServerConfig()));
  assert.notEqual(a, computeConfigRevision({ ...config, activeServerId: "fixture-b" }));
  const mutated = buildThreeServerConfig();
  mutated.servers[0] = { ...mutated.servers[0], remotePort: 19999 };
  assert.notEqual(a, computeConfigRevision(mutated));
});

test("投影 A01/A02: 三服务器 configured 端口不同，effective 来自快照共享端口；tunnel:false 不进快照", () => {
  const config = buildThreeServerConfig();
  const snapshot = fixtureSnapshot();
  const projection = buildConnectionTargetsProjection({ snapshot, snapshotState: "ok", config });
  assert.equal(projection.source, "supervisor-snapshot");
  assert.equal(projection.effectiveProxyPort.value, 28888);
  assert.equal(projection.servers["fixture-a"].remotePort.configured, 17891);
  assert.equal(projection.servers["fixture-a"].remotePort.effective, 17891);
  assert.equal(projection.servers["fixture-a"].localPort.configured, 28801);
  assert.equal(projection.servers["fixture-b"].remotePort.effective, 17892);
  assert.equal(projection.servers["fixture-b"].localPort.configured, 28802);
  assert.equal(projection.servers["fixture-c"].tunnelEnabled, false);
  assert.equal(projection.capabilities.scopedTunnelRestart, true);
});

test("投影 A03: 无快照 → config-only 降级，effectiveProxyPort unknown，远端 effective 为 null", () => {
  const projection = buildConnectionTargetsProjection({ snapshot: null, snapshotState: "missing", config: buildThreeServerConfig() });
  assert.equal(projection.source, "config-only");
  assert.equal(projection.freshness, "unknown");
  assert.equal(projection.effectiveProxyPort.value, null);
  assert.equal(projection.effectiveProxyPort.source, "unknown");
  assert.equal(projection.servers["fixture-a"].remotePort.effective, null);
  assert.equal(projection.servers["fixture-a"].remotePort.configured, 17891);
  assert.equal(projection.capabilities.scopedTunnelRestart, false);
});

test("投影: 目录不存在时写入路径自建目录", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "nested", "runtime", "supervisor-state.json");
    await mkdir(path.join(dir, "nested"), { recursive: true });
    await writeRuntimeSnapshotFile(file, buildRuntimeSnapshot({
      instanceId: "i", pid: 1, startedAt: 1, observedAt: 1, configRevision: "r", targets: {},
    }));
    const { snapshot } = await readRuntimeSnapshotFile(file);
    assert.equal(snapshot.instanceId, "i");
  });
});

test("unverified authentication identity is queryable and does not claim configured port as effective", () => {
  const config = { servers: [{ id: "s1", host: "fixture.invalid", localPort: 8888, remotePort: 7891 }] };
  const snapshot = buildRuntimeSnapshot({ targets: { s1: { host: "fixture.invalid", remotePort: 7891, localPort: 8888,
    signature: "-R fixture", configApplied: false, configIdentityState: "unverified" } } });
  const projection = buildConnectionTargetsProjection({ config, snapshot });
  assert.equal(snapshot.targets.s1.configApplied, false);
  assert.equal(projection.servers.s1.configIdentityState, "unverified");
  assert.equal(projection.servers.s1.configApplied, false);
  assert.equal(projection.servers.s1.remotePort.configured, 7891);
  assert.equal(projection.servers.s1.remotePort.effective, null);
});
