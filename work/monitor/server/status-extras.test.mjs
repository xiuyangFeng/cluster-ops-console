import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createConfigRefresher } from "./config-refresh.mjs";
import { clusterEnvFor, createPersonalRevisionReader, createRuntimeExtras, egressHealthView } from "./status-extras.mjs";

function tempConfig(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "status-extras-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.local.json");
  // 与生产写法一致：tmp + rename 原子替换（换 inode，文件戳必变）。
  let seq = 0;
  const write = (text) => {
    seq += 1;
    const tmp = `${file}.${seq}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  };
  return { file, write };
}

test("personalRevision：读个人层的 revision；写入后立刻读到新值（按文件戳，不靠定时过期）", (t) => {
  const { file, write } = tempConfig(t);
  const read = createPersonalRevisionReader({ localConfigPath: file });
  assert.equal(read(), null, "个人层不存在");
  write(JSON.stringify({ revision: 5, activeServerId: "server-01" }));
  assert.equal(read(), 5);
  write(JSON.stringify({ revision: 6, activeServerId: "server-aliyun" }));
  assert.equal(read(), 6, "切换查看的服务器后版本号 +1，下一次 status 就能看到");
});

test("personalRevision：没有 revision 字段按 0（与 /api/servers 口径一致）；损坏 / 不是对象为 null", (t) => {
  const { file, write } = tempConfig(t);
  const read = createPersonalRevisionReader({ localConfigPath: file });
  write(JSON.stringify({ sshUser: "me" }));
  assert.equal(read(), 0);
  write(JSON.stringify({ revision: "12" }));
  assert.equal(read(), 12, "字符串数字照常认");
  write(JSON.stringify({ revision: -3 }));
  assert.equal(read(), 0, "非法版本号不外传");
  write("{ not json");
  assert.equal(read(), null);
  write("[1,2]");
  assert.equal(read(), null);
  assert.equal(createPersonalRevisionReader({})(), null, "没给路径");
});

test("personalRevision：文件没变时不重读（每次 status 只多一次 stat）", (t) => {
  const { file, write } = tempConfig(t);
  write(JSON.stringify({ revision: 3 }));
  let reads = 0;
  const read = createPersonalRevisionReader({
    localConfigPath: file,
    readFile: () => { reads += 1; return JSON.stringify({ revision: 3 }); },
  });
  for (let i = 0; i < 5; i += 1) assert.equal(read(), 3);
  assert.equal(reads, 1);
  write(JSON.stringify({ revision: 4 }));
  read();
  assert.equal(reads, 2, "文件换了才重读");
});

test("clusterEnv：只给查看中的服务器；没有服务 / 没查过 / 取值抛错都是 null，不拖垮 /api/status", () => {
  const sync = { getState: (id) => (id === "server-01" ? { state: "drift", envPort: 7891, expectedPort: 7893 } : null) };
  assert.deepEqual(clusterEnvFor(sync, "server-01"), { serverId: "server-01", state: "drift", envPort: 7891, expectedPort: 7893 });
  assert.equal(clusterEnvFor(sync, "other"), null);
  assert.equal(clusterEnvFor(sync, ""), null);
  assert.equal(clusterEnvFor(null, "server-01"), null);
  assert.equal(clusterEnvFor({ getState: () => { throw new Error("boom"); } }, "server-01"), null);
});

test("配置热载：把新配置交给集群配置同步；同步服务缺席或抛错都不影响热载返回", async () => {
  const parsed = { servers: [{ id: "server-01", remotePort: 7893 }] };
  const seen = [];
  const late = {
    configKernel: { refreshConfigIntoKernel: async () => parsed },
    incidentSync: { syncServerLifecycle: async () => {} },
    clusterEnvSync: { onConfigRefreshed: (config) => seen.push(config) },
  };
  const policy = { setConfig: () => {} };
  assert.equal(await createConfigRefresher({ late, autoRepairPolicy: policy })(), parsed);
  assert.deepEqual(seen, [parsed]);
  late.clusterEnvSync = { onConfigRefreshed: () => { throw new Error("boom"); } };
  assert.equal(await createConfigRefresher({ late, autoRepairPolicy: policy })(), parsed);
  delete late.clusterEnvSync;
  assert.equal(await createConfigRefresher({ late, autoRepairPolicy: policy })(), parsed);
});

test("onboardingGuide：/api/status 带上接入引导的摘要；没装配时为 null", (t) => {
  const { file } = tempConfig(t);
  const base = {
    rootDir: path.dirname(file),
    localConfigPath: file,
    getMergedConfig: () => ({ servers: [] }),
    autoRepairPolicy: { getState: () => ({ config: { enabled: false, observeOnly: true }, lastActions: [] }) },
    autoRepair: { isExhausted: () => false },
    bridge: { getTunnelPortForeign: () => null, getTunnelFailures: () => ({}) },
    scheduler: { getMetrics: () => ({}) },
  };
  assert.equal(createRuntimeExtras(base)().onboardingGuide, null);
  const brief = { phase: "waiting", dismissed: false, busy: false };
  assert.deepEqual(createRuntimeExtras({ ...base, onboardingGuide: { getBrief: () => brief } })().onboardingGuide, brief);
});

test("egressHealth：/api/status 带上出网健康的内存快照；没装配 / 取值抛错为 null，不拖垮其它字段", (t) => {
  const { file } = tempConfig(t);
  const base = {
    rootDir: path.dirname(file),
    localConfigPath: file,
    getMergedConfig: () => ({ servers: [] }),
    autoRepairPolicy: { getState: () => ({ config: { enabled: false, observeOnly: true }, lastActions: [] }) },
    autoRepair: { isExhausted: () => false },
    bridge: { getTunnelPortForeign: () => null, getTunnelFailures: () => ({}) },
    scheduler: { getMetrics: () => ({}) },
  };
  assert.equal(createRuntimeExtras(base)().egressHealth, null);
  const snapshot = {
    mode: "manual",
    upstream: "127.0.0.1:7897",
    state: "ok",
    reason: null,
    check: { ok: true, ms: 1, at: 5, error: null },
    failures: { windowMs: 600000, total: 0, refused: 0, timeout: 0, rejected: 0, other: 0, last: null, topHosts: [] },
    checkedAt: 5,
  };
  let calls = 0;
  const egressHealth = { snapshot: () => { calls += 1; return snapshot; } };
  assert.deepEqual(createRuntimeExtras({ ...base, egressHealth })().egressHealth, snapshot);
  assert.equal(calls, 1);
  const broken = createRuntimeExtras({ ...base, egressHealth: { snapshot: () => { throw new Error("boom"); } } })();
  assert.equal(broken.egressHealth, null);
  assert.equal(broken.platform, process.platform, "其它字段照常");
  assert.equal(egressHealthView(null), null);
});
