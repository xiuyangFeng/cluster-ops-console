// 同账号多台 Mac 接力（v2.88）：本机待命（另一台 Mac 在承载）在状态层、运行快照与账本统计里的口径。
import assert from "node:assert/strict";
import test from "node:test";

import { deriveTransportState } from "../readiness-view.mjs";
import { buildConnectionTargetsProjection, buildRuntimeSnapshot, sanitizeHandover } from "../runtime-snapshot.mjs";
import { deriveTriageView } from "../signal-triage.mjs";
import { computeTunnelStability } from "../tunnel-ledger-stats.mjs";
import { sanitizeLedgerEvent } from "../supervisor/tunnel-ledger.mjs";
import { buildChannelLayer, deriveChannelFlags, deriveChannelLevel, HANDOVER_STANDBY_REASON, tunnelSatisfied } from "./channel-layer.mjs";
import { buildTunnelsLayer } from "./tunnels-layer.mjs";

const processes = { localProxy: [1], reverseTunnel: [], supervisor: [1], tunnelsByServer: { a: [], b: [] } };
const standbyFact = { role: "standby", since: 100, reason: "holder-active", health: "ok", holder: { label: "Mac-mini", ownerId: "fedcba9876543210", heldSec: 60 } };

test("通道层：待命且端口开着 → ok + handoverStandby；端口不通照常判断开（对方的隧道也断了）", () => {
  const main = { id: "a", remotePort: 7893 };
  const flags = deriveChannelFlags({ main, shouldBeRunning: true, processes, remotePortOpen: true, handoverStandby: true });
  assert.equal(flags.tunnelUp, false, "本机没有隧道进程，如实为 false");
  assert.equal(flags.handoverStandby, true);
  assert.equal(tunnelSatisfied(flags), true);
  const level = deriveChannelLevel({ main, shouldBeRunning: true, hasProcessesResult: true, flags });
  assert.deepEqual(level, { level: "ok", reason: HANDOVER_STANDBY_REASON, handoverStandby: true });
  const layer = buildChannelLayer({ main, levelInfo: level, flags, procResult: null, remoteResult: null });
  assert.equal(layer.handoverStandby, true);
  assert.equal(layer.detail.handoverStandby, true);

  const closed = deriveChannelFlags({ main, shouldBeRunning: true, processes, remotePortOpen: false, handoverStandby: true });
  assert.equal(closed.handoverStandby, undefined);
  assert.equal(deriveChannelLevel({ main, shouldBeRunning: true, hasProcessesResult: true, flags: closed }).level, "error");
});

test("次要隧道：待命 → ok（不进「次要隧道断开」），带上待命事实", () => {
  const out = buildTunnelsLayer({
    servers: [{ id: "a", remotePort: 7893 }, { id: "b", remotePort: 7894 }],
    mainId: "a",
    channel: { level: "ok", reason: "x", checkedAt: 1 },
    flags: { tunnelUp: true, remotePortOpen: true },
    shouldBeRunning: true,
    tunnelsByServer: { a: [{ pid: 1 }], b: [] },
    evidenceFor: () => ({ open: true, checkedAt: 1 }),
    slowResultFor: () => null,
    standbyFor: (id) => (id === "b" ? standbyFact : null),
  });
  assert.equal(out.b.level, "ok");
  assert.equal(out.b.handoverStandby, true);
  assert.equal(out.b.handover.holder.label, "Mac-mini");
});

test("readiness / 分诊：待命算已连接（reasonCode 单列），不算通道断开", () => {
  const transport = deriveTransportState({ shouldBeRunning: true, localProxyUp: true, tunnelUp: false, remotePortOpen: true, handoverStandby: true, nowMs: 0 });
  assert.equal(transport.state, "connected");
  assert.equal(transport.reasonCode, "HANDOVER_STANDBY");
  assert.equal(deriveTransportState({ shouldBeRunning: true, localProxyUp: true, tunnelUp: false, remotePortOpen: true, nowMs: 0 }).state, "disconnected");
  const view = deriveTriageView({ id: "x" }, { layers: { channel: { level: "ok", handoverStandby: true, detail: { localProxyUp: true, tunnelUp: false, remotePortOpen: true, handoverStandby: true } } } });
  assert.equal(view.channelDown, false);
});

test("运行快照：待命事实白名单清洗；投影只认新鲜快照", () => {
  assert.equal(sanitizeHandover({ role: "active" }), null);
  assert.deepEqual(sanitizeHandover({ ...standbyFact, holder: { label: "a b;rm", ownerId: "xyz", heldSec: -1 }, reason: "evil" }), {
    role: "standby", since: 100, reason: null, health: "ok", holder: { label: null, ownerId: null, heldSec: null },
  });
  const snapshot = buildRuntimeSnapshot({
    instanceId: "abcd1234", pid: 10, capabilities: { scopedTunnelRestart: true, controlProtocol: 1, siblingTakeover: true },
    targets: { a: { host: "h", remotePort: 7893, localPort: 8888, signature: "s", handover: standbyFact } },
    machine: { label: "MacBook-Air", ownerId: "0123456789abcdef" },
  });
  assert.equal(snapshot.capabilities.siblingTakeover, true);
  assert.deepEqual(snapshot.machine, { label: "MacBook-Air", ownerId: "0123456789abcdef" });
  const config = { servers: [{ id: "a", host: "h", remotePort: 7893 }] };
  const fresh = buildConnectionTargetsProjection({ snapshot, snapshotState: "ok", config });
  assert.equal(fresh.servers.a.handover.holder.label, "Mac-mini");
  assert.equal(fresh.machine.label, "MacBook-Air");
  const stale = buildConnectionTargetsProjection({ snapshot, snapshotState: "stale", config });
  assert.equal(stale.servers.a.handover, undefined);
});

test("账本：handover 行落白名单字段；待命时段单独成段、不算断线不算在线，切换记录新 → 旧", () => {
  assert.deepEqual(sanitizeLedgerEvent({ type: "handover", serverId: "a", at: 5, role: "standby", reason: "yielded", peer: "Mac-mini", junk: 1 }), {
    v: 1, type: "handover", at: 5, serverId: "a", role: "standby", reason: "yielded", peer: "Mac-mini",
  });
  const H = 3600_000;
  const t0 = 100 * H;
  const events = [{ type: "start", at: t0 }, { type: "up", serverId: "a", at: t0 }];
  for (let t = t0 + 4 * 60_000; t < t0 + 3 * H; t += 4 * 60_000) events.push({ type: "alive", at: t });
  events.push({ type: "down", serverId: "a", at: t0 + H, cause: "handover", planned: true, uptimeMs: H });
  events.push({ type: "handover", serverId: "a", at: t0 + H, role: "standby", reason: "yielded", peer: "Mac-mini" });
  events.push({ type: "handover", serverId: "a", at: t0 + 2 * H, role: "active", reason: "manual", peer: "Mac-mini" });
  events.push({ type: "up", serverId: "a", at: t0 + 2 * H });
  const mid = computeTunnelStability({ events, nowMs: t0 + 1.5 * H, serverIds: ["a"] });
  assert.equal(mid.servers.a.state, "standby");
  assert.equal(mid.servers.a.standbyPeer, "Mac-mini");
  const stats = computeTunnelStability({ events, nowMs: t0 + 3 * H, serverIds: ["a"] });
  assert.equal(stats.servers.a.windows["24h"].drops, 0, "交接不算断线");
  assert.equal(stats.servers.a.windows["24h"].downMs, 0);
  assert.ok(stats.servers.a.timeline.segments.some((s) => s.state === "standby" && s.to - s.from === H));
  assert.deepEqual(stats.recentHandovers.map((h) => [h.role, h.reason]), [["active", "manual"], ["standby", "yielded"]]);
});
