import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeSnapshotPoller, usableSnapshotOf } from "./snapshot-poller.mjs";

test("usableSnapshotOf：只有存在、未过期且归属已核实的快照可用", () => {
  const snapshot = { schemaVersion: 1 };
  assert.equal(usableSnapshotOf({ snapshot, stale: false, owned: true }), snapshot);
  assert.equal(usableSnapshotOf({ snapshot, stale: true, owned: true }), null);
  assert.equal(usableSnapshotOf({ snapshot, stale: false, owned: false }), null);
  assert.equal(usableSnapshotOf({ snapshot: null, stale: false, owned: true }), null);
  assert.equal(usableSnapshotOf(undefined), null);
});

test("snapshot poller：无快照文件时降级为 config-only（connectionTargets 标 missing）", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "snapshot-poller-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const poller = createRuntimeSnapshotPoller({
    runtimeDir,
    registry: { read: () => null },
    getMergedConfig: () => ({ servers: [], activeServerId: "" }),
  });
  await poller.poll();
  assert.equal(poller.getUsableSnapshot(), null);
  const fresh = await poller.readFresh();
  assert.equal(fresh.snapshot, null);
  const targets = poller.getConnectionTargets();
  assert.equal(targets.source, "config-only");
  assert.equal(targets.supervisor, null);
});
