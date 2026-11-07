import assert from "node:assert/strict";
import test from "node:test";

import { mergeBridgeSnapshot, createBridgeStages, copyBridgeStages } from "./bridge-stages.mjs";
import { deriveChannelFlags, deriveChannelLevel, remotePortFromFastResult, selectPortEvidence } from "./channel-layer.mjs";
import { earliestNextCheckAt, latestCheckedAt } from "./probe-results.mjs";
import { createTransitionRing, diffTransitions, isViewScopedKey, levelMap } from "./transitions.mjs";
import { buildTunnelsLayer } from "./tunnels-layer.mjs";

test("probe-results: 最近 checkedAt / 最早 nextCheckAt，缺席探针与缺字段不参与，全缺为 null", () => {
  const results = [undefined, { checkedAt: 5, nextCheckAt: 30 }, { checkedAt: 9, nextCheckAt: 20 }, { nextCheckAt: 10 }];
  assert.equal(latestCheckedAt(results), 9);
  assert.equal(earliestNextCheckAt(results), 10);
  assert.equal(latestCheckedAt([undefined, null]), null);
  assert.equal(earliestNextCheckAt([]), null);
});

test("channel-layer: 端口证据取 fast / slow 中较新者，slow 未采到该端口视为无证据", () => {
  const slow = { checkedAt: 100, data: { ports: { 7891: false } } };
  assert.deepEqual(selectPortEvidence(null, slow, 7891), { open: false, checkedAt: 100 });
  assert.deepEqual(selectPortEvidence({ open: true, checkedAt: 100 }, slow, 7891), { open: true, checkedAt: 100 });
  assert.deepEqual(selectPortEvidence({ open: true, checkedAt: 99 }, slow, 7891), { open: false, checkedAt: 100 });
  assert.equal(selectPortEvidence(undefined, slow, 7893), null);
});

test("channel-layer: 旗标与 level——仅监控 / 手动停止 / 首轮 / 断开原因拼接", () => {
  const processes = { localProxy: [1], reverseTunnel: [1], supervisor: [], tunnelsByServer: { a: [] } };
  const monitorOnly = deriveChannelFlags({ main: { id: "a", tunnel: false }, shouldBeRunning: true, processes, remotePortOpen: true });
  assert.deepEqual(monitorOnly, { supervisorUp: false, localProxyUp: null, tunnelUp: null, remotePortOpen: null });
  const flags = deriveChannelFlags({ main: { id: "a" }, shouldBeRunning: true, processes, remotePortOpen: false });
  assert.deepEqual(flags, { supervisorUp: false, localProxyUp: true, tunnelUp: false, remotePortOpen: false }, "有分桶时按活跃服务器那格判，不看并集");
  assert.deepEqual(
    deriveChannelLevel({ main: { id: "a", remotePort: 7892 }, shouldBeRunning: true, hasProcessesResult: true, flags }),
    { level: "error", reason: "SSH 隧道未开启；远端端口未开放" },
  );
  assert.equal(deriveChannelLevel({ main: {}, shouldBeRunning: true, hasProcessesResult: true, flags }).reason, "未配置可用服务器");
  assert.equal(deriveChannelLevel({ main: { id: "a", remotePort: 7892 }, shouldBeRunning: false, hasProcessesResult: true, flags }).reason, "通道已手动停止");
  assert.equal(deriveChannelLevel({ main: { id: "a", remotePort: 7892 }, shouldBeRunning: true, hasProcessesResult: false, flags }).level, "waiting");
  assert.deepEqual(
    deriveChannelLevel({ main: { id: "a", remotePort: 7892 }, shouldBeRunning: true, hasProcessesResult: true, flags: { supervisorUp: false, localProxyUp: true, tunnelUp: true, remotePortOpen: true } }),
    { level: "warn", reason: "守护进程未运行" },
  );
});

test("channel-layer: 远端端口尚无证据——本地两段都在保持 waiting，本地任一段缺失照常判 error", () => {
  const localUp = { supervisorUp: true, localProxyUp: true, tunnelUp: true, remotePortOpen: false };
  const base = { main: { id: "a", remotePort: 7892 }, shouldBeRunning: true, hasProcessesResult: true };
  assert.deepEqual(
    deriveChannelLevel({ ...base, hasPortEvidence: false, flags: localUp }),
    { level: "waiting", reason: "等待远端端口探测" },
    "未知 ≠ 未开放：热启动 fast 采集首轮未回时不制造 error",
  );
  assert.deepEqual(
    deriveChannelLevel({ ...base, hasPortEvidence: true, flags: localUp }),
    { level: "error", reason: "远端端口未开放" },
    "有证据说端口未开放才判 error",
  );
  assert.deepEqual(
    deriveChannelLevel({ ...base, hasPortEvidence: false, flags: { ...localUp, localProxyUp: false, tunnelUp: false } }),
    { level: "error", reason: "本地代理未运行；SSH 隧道未开启；远端端口未开放" },
    "冷启动真故障不被等待端口证据压成 waiting",
  );
  assert.equal(deriveChannelLevel({ ...base, flags: localUp }).level, "error", "缺省 hasPortEvidence=true：旧调用方语义不变");
});

test("channel-layer: fast 结果 → 旧 remotePort 字段；skipped/无结论不动，error 轮判不通", () => {
  assert.equal(remotePortFromFastResult({ level: "skipped", data: { remotePortOpen: true } }), null);
  assert.equal(remotePortFromFastResult({ level: "ok", data: {} }), null);
  assert.deepEqual(remotePortFromFastResult({ level: "ok", data: { remotePortOpen: true } }), { open: true, remotePort: { ok: true, code: 0, output: "open" } });
  assert.deepEqual(remotePortFromFastResult({ level: "warn", data: { remotePortOpen: false } }), { open: false, remotePort: { ok: false, code: 1, output: "closed" } });
  assert.deepEqual(remotePortFromFastResult({ level: "error", reason: "timeout" }), { open: false, remotePort: { ok: false, code: -1, output: "timeout" } });
  assert.equal(remotePortFromFastResult({ level: "error" }).remotePort.output, "远端探测失败");
});

test("tunnels-layer: 次要隧道按分桶 + 端口证据分类，活跃服务器复制 channel 结论", () => {
  const servers = [{ id: "main" }, { id: "b", remotePort: 7893 }, { id: "c", remotePort: 7894 }, { id: "d", remotePort: 7895 }, { id: "m", tunnel: false, source: "personal" }, { id: "n" }];
  const evidence = { b: { open: true, checkedAt: 7 }, c: { open: false, checkedAt: 8 } };
  const layer = buildTunnelsLayer({
    servers,
    mainId: "main",
    channel: { level: "ok", reason: "通道全链路正常", checkedAt: 1 },
    flags: { tunnelUp: true, remotePortOpen: true },
    shouldBeRunning: true,
    tunnelsByServer: { main: [1], b: [1], c: [1], d: [], n: [] },
    evidenceFor: (server) => evidence[server.id] || null,
    slowResultFor: () => undefined,
  });
  assert.deepEqual(Object.keys(layer), ["main", "b", "c", "d", "m", "n"]);
  assert.equal(layer.main.level, "ok");
  assert.equal(layer.main.checkedAt, 1);
  assert.deepEqual([layer.b.level, layer.b.reason], ["ok", "隧道正常"]);
  assert.deepEqual([layer.c.level, layer.c.reason], ["error", "远端端口未开放"]);
  assert.deepEqual([layer.d.level, layer.d.reason], ["error", "SSH 隧道未开启"]);
  assert.deepEqual([layer.m.level, layer.m.source, layer.m.tunnelUp], ["skipped", "personal", null]);
  // v2.54：次要服务器还没领反向端口 → 不建隧道、不算断开（不进"次要隧道断开"）
  assert.deepEqual([layer.n.level, layer.n.reason, layer.n.tunnelUp, layer.n.remotePortOpen], ["skipped", "未领取反向端口", null, null]);

  const unknown = buildTunnelsLayer({
    servers: [{ id: "x", remotePort: 7896 }], mainId: "main", channel: {}, flags: {}, shouldBeRunning: true, tunnelsByServer: null,
    evidenceFor: () => null, slowResultFor: () => ({ checkedAt: 3 }),
  });
  assert.deepEqual(unknown.x, { level: "waiting", reason: "等待首次探测", tunnelUp: null, remotePortOpen: null, checkedAt: 3, source: "team", tunnel: true });
});

test("transitions: levelMap 不重复活跃服务器的 tunnel 键，diff 只报变化并带各层 reason", () => {
  const layers = {
    channel: { level: "error", reason: "SSH 隧道未开启" },
    agents: { codex: { level: "ok", reason: "ready" } },
    resources: { a: { level: "ok", reason: "负载已更新" } },
    validation: { a: { level: "warn", reason: "已验证 1 项，失败 1 项" } },
    tunnels: { a: { level: "error", tunnel: true }, b: { level: "error", reason: "远端端口未开放", tunnel: true }, m: { level: "skipped", tunnel: false } },
  };
  const next = levelMap(layers, "a");
  assert.deepEqual(next, { channel: "error", "agent:codex": "ok", "res:a": "ok", "res:validation:a": "warn", "tunnel:b": "error" });
  let ts = 100;
  const out = diffTransitions({ channel: "ok", "agent:codex": "ok" }, next, layers, () => ts++);
  assert.deepEqual(out.map((t) => [t.ts, t.layer, t.key, t.from, t.to, t.reason]), [
    [100, "channel", "channel", "ok", "error", "SSH 隧道未开启"],
    [101, "resources", "res:a", "unknown", "ok", "负载已更新"],
    [102, "resources", "res:validation:a", "unknown", "warn", "已验证 1 项，失败 1 项"],
    [103, "tunnels", "tunnel:b", "unknown", "error", "远端端口未开放"],
  ]);
  assert.equal(isViewScopedKey("channel", "a"), true);
  assert.equal(isViewScopedKey("agent:codex", "a"), true);
  assert.equal(isViewScopedKey("tunnel:a", "a"), true);
  assert.equal(isViewScopedKey("tunnel:b", "a"), false);
  assert.equal(isViewScopedKey("res:a", "a"), false);
});

test("transitions: 环形缓冲有界且对外给副本", () => {
  const ring = createTransitionRing(3);
  ring.push([{ n: 1 }, { n: 2 }]);
  ring.push([{ n: 3 }, { n: 4 }]);
  assert.deepEqual(ring.recent(10), [{ n: 2 }, { n: 3 }, { n: 4 }]);
  const copy = ring.recent(1);
  copy[0].n = 99;
  assert.deepEqual(ring.recent(1), [{ n: 4 }]);
});

test("bridge-stages: 未知阶段拒收、合并保留旧字段、输出副本", () => {
  const stages = createBridgeStages();
  assert.deepEqual(Object.keys(stages), ["local-proxy", "ssh-tunnel", "remote-port", "agent-endpoint"]);
  assert.equal(mergeBridgeSnapshot(stages, { stage: "ssh-tunnel", ok: true, reconnects: 2 }), true);
  assert.deepEqual(stages["ssh-tunnel"], { stage: "ssh-tunnel", ok: true, durationMs: 0, consecutiveFailures: 0, lastSuccessAt: null, reconnects: 2 });
  assert.equal(mergeBridgeSnapshot(stages, { stage: "bogus" }), false);
  assert.equal(mergeBridgeSnapshot(stages, { stage: "" }), false);
  assert.equal(mergeBridgeSnapshot(stages, null), false);
  const copy = copyBridgeStages(stages);
  copy["local-proxy"].ok = true;
  assert.equal(stages["local-proxy"].ok, false);
});
