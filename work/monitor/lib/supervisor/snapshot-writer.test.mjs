// 运行快照写者的特征化测试：落盘节流（变化即写 / 无变化 15s 刷新）、写失败限频告警、
// 以及快照 JSON 的逐字节形状（monitor 侧 runtime-snapshot 读者与热更新流程依赖它）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeConfigRevision } from "../runtime-snapshot.mjs";
import { createSnapshotWriter } from "./snapshot-writer.mjs";

const tunnel = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
const config = { proxyPort: 8888, activeServerId: "server-01", tunnels: [tunnel] };

function scene({ fail = false } = {}) {
  let clock = 100_000;
  const writes = [];
  const logs = [];
  const state = { effectiveProxyPort: 8888, firstTickCompletedAt: null };
  let identity = { configApplied: true, configIdentityState: "verified" };
  const controllers = new Map([["server-01", { controller: { getState: () => identity } }]]);
  const proxyController = { getState: () => ({ observed: { pid: 4242, component: "abcabcabcabc", handoff: true } }) };
  const write = createSnapshotWriter({
    snapshotPath: "/runtime/supervisor-state.json",
    state,
    controllers,
    proxyController,
    instanceId: "abcd1234",
    pid: 4321,
    startedAt: 1000,
    build: { version: "", gitCommit: "" },
    componentHash: "0123456789ab",
    log: (message, fields) => logs.push({ message, fields }),
    writeSnapshotFile: async (file, snapshot) => {
      if (fail) throw new Error("disk full");
      writes.push({ file, snapshot });
    },
    now: () => clock,
  });
  return {
    write,
    writes,
    logs,
    state,
    advance: (ms) => { clock += ms; },
    setIdentity: (value) => { identity = value; },
  };
}

test("快照形状：字段与顺序逐字节固定", async () => {
  const s = scene();
  await s.write({ config, tunnels: [tunnel, { host: "no-id" }] });
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].file, "/runtime/supervisor-state.json");
  const revision = computeConfigRevision(config);
  assert.equal(JSON.stringify(s.writes[0].snapshot),
    `{"schemaVersion":1,"instanceId":"abcd1234","pid":4321,"startedAt":1000,"observedAt":100000,"configRevision":"${revision}",`
    + '"build":{"version":"","gitCommit":""},'
    + '"capabilities":{"scopedTunnelRestart":true,"controlProtocol":1,"handoffExit":true,"proxyHandoff":true,"siblingTakeover":true},'
    + '"effectiveProxyPort":8888,'
    + '"targets":{"server-01":{"host":"myserver","remotePort":7891,"localPort":8888,"signature":"-R 127.0.0.1:7891:127.0.0.1:8888 myserver","configApplied":true,"configIdentityState":"verified"}},'
    + '"components":{"supervisor":"0123456789ab","proxy":"abcabcabcabc"},"proxyPid":4242}');

  s.state.firstTickCompletedAt = 123456;
  s.advance(1);
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.writes.length, 2, "首拍完成时间变化即写");
  assert.equal(s.writes[1].snapshot.firstTickCompletedAt, 123456);
  assert.ok(JSON.stringify(s.writes[1].snapshot).endsWith(',"proxyPid":4242,"firstTickCompletedAt":123456}'));
});

test("节流：内容不变 15s 内不重写，到点刷新 observedAt；任何目标/身份变化立即写", async () => {
  const s = scene();
  await s.write({ config, tunnels: [tunnel] });
  s.advance(14_999);
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.writes.length, 1, "15s 内内容不变不写");
  s.advance(1);
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.writes.length, 2, "满 15s 刷新");
  assert.equal(s.writes[1].snapshot.observedAt, 115_000);

  s.advance(10);
  s.setIdentity({ configApplied: false, configIdentityState: "changed" });
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.writes.length, 3, "隧道身份变化立即写");

  s.advance(10);
  s.state.effectiveProxyPort = 8890;
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.writes.length, 4, "共享代理端口变化立即写");
});

test("写失败：不记账（下一拍立即重试），告警每 60s 最多一条", async () => {
  const s = scene({ fail: true });
  await s.write({ config, tunnels: [tunnel] });
  s.advance(1_000);
  await s.write({ config, tunnels: [tunnel] });
  assert.deepEqual(s.logs, [{
    message: "runtime snapshot write failed: disk full",
    fields: { level: "warn", event: "snapshot-write-error" },
  }]);
  s.advance(60_000);
  await s.write({ config, tunnels: [tunnel] });
  assert.equal(s.logs.length, 2);
});
