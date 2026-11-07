import { test } from "node:test";
import assert from "node:assert/strict";

import { findSupervisorToYieldTo } from "./bootstrap.mjs";

test("findSupervisorToYieldTo：只在另一个存活且命令行匹配的 supervisor 在册时让位", async () => {
  const registryWith = (meta) => ({ readMeta: (name) => (name === "channel-supervisor" ? meta : null) });
  const cmdlines = [];
  const readCmdline = async (pid) => {
    cmdlines.push(pid);
    return pid === 600 ? "node work/monitor/channel-supervisor.mjs" : "node something-else.mjs";
  };
  assert.equal(await findSupervisorToYieldTo({ registry: registryWith(null), readCmdline, selfPid: 1 }), null);
  assert.equal(await findSupervisorToYieldTo({ registry: registryWith({ pid: 1 }), readCmdline, selfPid: 1 }), null, "记录就是自己");
  assert.equal(await findSupervisorToYieldTo({ registry: registryWith({ pid: 600 }), readCmdline, selfPid: 1, isAlive: () => false }), null);
  assert.deepEqual(cmdlines, [], "进程已死不必读命令行");
  const meta = { pid: 600 };
  assert.equal(await findSupervisorToYieldTo({ registry: registryWith(meta), readCmdline, selfPid: 1, isAlive: () => true }), meta);
  assert.equal(await findSupervisorToYieldTo({ registry: registryWith({ pid: 700 }), readCmdline, selfPid: 1, isAlive: () => true }), null,
    "pid 被别的进程复用时不让位");
});
