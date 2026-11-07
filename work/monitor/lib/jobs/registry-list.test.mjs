// registry.list(serverId)：磁盘增长归因（lib/disk-growth/）按它推「集合目录」。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createJobRegistry, REGISTRY_RETENTION_MS } from "./registry.mjs";

const entry = (jobId, over = {}) => ({ jobId, arrayJobId: null, arrayTaskId: null, name: "train", workDir: `/home/kai/proj`, stdout: `/home/kai/proj/runs/${jobId}/o_%j.log`, stderr: null, command: null, ...over });
const seen = (entries, user = "kai") => ({ user, total: entries.length, complete: true, entries });

test("list：只给这台服务器的条目，带路径与见到的时刻；给的是副本；过期的不在其中", async () => {
  let clock = 1_000_000;
  const registry = createJobRegistry({ now: () => clock });
  assert.deepEqual(registry.list("s1"), [], "还没登记过");
  await registry.observe("s1", seen([entry("101"), entry("102", { stdout: null })]));
  await registry.observe("s2", seen([entry("201")], "other"));
  const mine = registry.list("s1");
  assert.deepEqual(mine.map((item) => [item.serverId, item.jobId, item.user, item.workDir, item.stdout, item.firstSeenAt, item.lastSeenAt]), [
    ["s1", "101", "kai", "/home/kai/proj", "/home/kai/proj/runs/101/o_%j.log", clock, clock],
    ["s1", "102", "kai", "/home/kai/proj", null, clock, clock],
  ]);
  assert.deepEqual(registry.list("s2").map((item) => item.jobId), ["201"]);
  assert.deepEqual(registry.list("nope"), []);

  // 改返回值不影响登记
  mine[0].stdout = "/tampered";
  mine.length = 0;
  assert.equal(registry.list("s1")[0].stdout, "/home/kai/proj/runs/101/o_%j.log");
  assert.equal(registry.lookup("s1", "101").stdout, "/home/kai/proj/runs/101/o_%j.log");

  // 还在队里的作业每轮刷新见到的时刻；超过保留期没再见到的，下一次有新作业登记时清掉
  clock += 3600_000;
  await registry.observe("s1", seen([entry("101")]));
  assert.deepEqual(registry.list("s1").map((item) => [item.jobId, item.lastSeenAt - item.firstSeenAt]), [["101", 3600_000], ["102", 0]]);
  clock += REGISTRY_RETENTION_MS;
  await registry.observe("s1", seen([entry("103")]));
  assert.deepEqual(registry.list("s1").map((item) => item.jobId), ["101", "103"], "101 一小时后还见过，刚好在保留期内；102 过期");
});
