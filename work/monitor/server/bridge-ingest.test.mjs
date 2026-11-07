// bridge 快照摄取：从临时目录里的 supervisor.ndjson 读增量，验证归并 / 旁路集合。
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeIngest } from "./bridge-ingest.mjs";

async function harness(t, { activeServerId = "server-01" } = {}) {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "bridge-ingest-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await mkdir(path.join(runtimeDir, "logs"), { recursive: true });
  const logPath = path.join(runtimeDir, "logs", "supervisor.ndjson");
  const stages = [];
  const samples = [];
  const bridge = createBridgeIngest({
    runtimeDir,
    store: { ingestBridgeStage: (snapshot) => stages.push(snapshot) },
    // 工厂已不收这两项；仍递进去当探子——谁把「镜像进指标环」接回来，下面的断言就红。
    metricsStore: { addSample: (sample) => samples.push(sample) },
    getMergedConfig: () => ({ activeServerId }),
  });
  const write = (entries) => appendFile(logPath, `${entries.map((e) => JSON.stringify({ source: "supervisor", level: "info", ...e })).join("\n")}\n`);
  return { bridge, stages, samples, write };
}

test("bridge ingest：文件不存在时安静返回；快照只归并进 store（不镜像进指标环），只摄取新增行", async (t) => {
  const h = await harness(t);
  await h.bridge.ingest();
  assert.deepEqual(h.stages, []);

  const tunnel = { stage: "ssh-tunnel", ok: false, serverId: "server-02", foreign: true };
  await h.write([
    { ts: 1000, message: "tunnel foreign", bridgeStage: tunnel },
    { ts: 1001, message: "[proxy] connect-deny host=x port=1" },
    { ts: 1002, message: "local proxy", bridgeStage: { stage: "local-proxy", ok: true, channelServerId: "server-03" } },
    { ts: 1003, message: "ssh ready", bridgeStage: { stage: "ssh-ready", ok: true } },
  ]);
  await h.bridge.ingest();
  assert.deepEqual(h.stages.map((s) => s.stage), ["ssh-tunnel", "local-proxy", "ssh-ready"]);
  // 三条快照（含自带 serverId 的 ssh-tunnel——旧实现里它会落进真实服务器 server-02 的环）一条都不进指标环。
  assert.deepEqual(h.samples, []);
  assert.deepEqual(h.bridge.getTunnelPortForeign(), ["server-02"]);
  assert.equal(await h.bridge.readLocalProxyLog(), "tunnel foreign\n[proxy] connect-deny host=x port=1\nlocal proxy\nssh ready");

  // 增量读取：已摄取的行不再归并；ok 快照把服务器移出异己集合。
  await h.write([
    { ts: 1003, message: "adopted", bridgeStage: { stage: "ssh-tunnel", ok: true, adopted: true, serverId: "server-02" } },
  ]);
  await h.bridge.ingest();
  assert.equal(h.stages.length, 4);
  assert.deepEqual(h.bridge.getTunnelPortForeign(), []);
});

test("bridge ingest：SSH 失败归因按服务器维护，并按启用列表修剪", async (t) => {
  const h = await harness(t);
  await h.write([
    { ts: 1, message: "a", bridgeStage: { stage: "ssh-tunnel", ok: false, serverId: "server-01", sshFailure: { code: "auth", nextAction: "重跑 setup", at: 5 } } },
    { ts: 2, message: "b", bridgeStage: { stage: "ssh-tunnel", ok: false, serverId: "gone", sshFailure: { code: "timeout", at: 6 } } },
  ]);
  await h.bridge.ingest();
  assert.deepEqual(h.bridge.getTunnelFailures(["server-01", "gone"]), {
    "server-01": { code: "auth", nextAction: "重跑 setup", at: 5 },
    gone: { code: "timeout", nextAction: "", at: 6 },
  });
  assert.deepEqual(h.bridge.getTunnelFailures(["server-01"]), {
    "server-01": { code: "auth", nextAction: "重跑 setup", at: 5 },
  });
});

test("bridge ingest：onSnapshot 逐条旁路每份快照（探针退避的恢复信号）；它抛错不影响归并", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "bridge-ingest-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await mkdir(path.join(runtimeDir, "logs"), { recursive: true });
  const stages = [];
  const seen = [];
  const bridge = createBridgeIngest({
    runtimeDir,
    store: { ingestBridgeStage: (snapshot) => stages.push(snapshot) },
    onSnapshot: (snapshot) => {
      seen.push(`${snapshot.stage}:${snapshot.ok}`);
      throw new Error("observer bug");
    },
  });
  const lines = [
    { ts: 1, message: "plain line without snapshot" },
    { ts: 2, message: "tunnel", bridgeStage: { stage: "ssh-tunnel", ok: true, serverId: "server-01" } },
    { ts: 3, message: "proxy", bridgeStage: { stage: "local-proxy", ok: false } },
  ];
  await appendFile(path.join(runtimeDir, "logs", "supervisor.ndjson"), `${lines.map((e) => JSON.stringify({ source: "supervisor", level: "info", ...e })).join("\n")}\n`);
  await bridge.ingest();
  assert.deepEqual(seen, ["ssh-tunnel:true", "local-proxy:false"]);
  assert.equal(stages.length, 2);
});

test("bridge ingest：onMessage 逐条旁路带 message 的行（连同行自己的 ts）；它抛错不影响归并与消息尾巴", async (t) => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), "bridge-ingest-"));
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  await mkdir(path.join(runtimeDir, "logs"), { recursive: true });
  const stages = [];
  const seen = [];
  const bridge = createBridgeIngest({
    runtimeDir,
    store: { ingestBridgeStage: (snapshot) => stages.push(snapshot) },
    onMessage: (message, ts) => {
      seen.push([message, ts]);
      throw new Error("observer bug");
    },
  });
  const lines = [
    { ts: 11, message: "[proxy] connect-fail host=api.openai.com port=443 reason=upstream-refused ms=3 via=upstream" },
    { ts: 12, bridgeStage: { stage: "local-proxy", ok: true } },
    { ts: 13, message: "tunnel", bridgeStage: { stage: "ssh-tunnel", ok: true, serverId: "server-01" } },
    { ts: 14, message: "bridge stage snapshot", bridgeStage: { stage: "local-proxy", ok: true } },
  ];
  await appendFile(path.join(runtimeDir, "logs", "supervisor.ndjson"), `${lines.map((e) => JSON.stringify({ source: "supervisor", level: "info", ...e })).join("\n")}\n`);
  await bridge.ingest();
  assert.deepEqual(seen, [
    ["[proxy] connect-fail host=api.openai.com port=443 reason=upstream-refused ms=3 via=upstream", 11],
    ["tunnel", 13],
  ]);
  assert.equal(stages.length, 3, "观察者抛错不影响快照归并，且周期快照正常归并");
  const tailText = await bridge.readLocalProxyLog();
  assert.match(tailText, /connect-fail host=api\.openai\.com/, "也不影响信号引擎的消息尾巴");
  assert.doesNotMatch(tailText, /bridge stage snapshot/, "周期性 bridge stage snapshot 不进消息尾巴，避免冲掉代理告警");
});
