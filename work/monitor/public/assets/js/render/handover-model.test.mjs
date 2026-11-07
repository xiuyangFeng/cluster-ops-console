import assert from "node:assert/strict";
import test from "node:test";

import { buildChainModel, buildChainDetail } from "./chain-model.js";
import { canTakeOver, handoverDetail, handoverNote, handoverStandbyOf, holderName } from "./handover-model.js";
import { buildHandoverRows } from "./tunnel-stability-model.js";

const handover = { role: "standby", since: 1, reason: "holder-active", health: "ok", holder: { label: "Mac-mini", ownerId: "fedcba9876543210", heldSec: 7200 } };

function status(extra = {}) {
  return {
    shouldBeRunning: true,
    health: "ready",
    supervisorUp: true,
    localProxyUp: true,
    tunnelUp: false,
    remotePortOpen: true,
    activeServerId: "server-01",
    activeServer: { id: "server-01", host: "myserver", localPort: 8888, remotePort: 7893 },
    connectionTargets: {
      source: "supervisor-snapshot",
      capabilities: { scopedTunnelRestart: true, controlProtocol: 1, siblingTakeover: true },
      machine: { label: "MacBook-Air", ownerId: "0123456789abcdef" },
      servers: { "server-01": { host: "myserver", remotePort: { configured: 7893, effective: 7893 }, handover } },
    },
    ...extra,
  };
}

test("待命事实与按钮门控：要有能力声明 + 本机待命", () => {
  const s = status();
  assert.equal(handoverStandbyOf(s).holderLabel, "Mac-mini");
  assert.equal(canTakeOver(s), true);
  assert.equal(canTakeOver({ ...s, connectionTargets: { ...s.connectionTargets, capabilities: { scopedTunnelRestart: true } } }), false);
  assert.equal(handoverStandbyOf(status({ connectionTargets: { servers: {} } })), null);
});

test("称呼：两台主机名一样时带识别码前 4 位；没名字退回「另一台 Mac」", () => {
  const sb = handoverStandbyOf(status());
  assert.equal(holderName(sb, { label: "MacBook-Air" }), "Mac-mini");
  assert.equal(holderName(sb, { label: "Mac-mini" }), "Mac-mini（fedc）");
  assert.equal(holderName({ ...sb, holderLabel: null }), "另一台 Mac（fedc）");
  assert.equal(handoverNote(sb), "由 Mac-mini 承载 · 本机待命");
  const detail = handoverDetail(sb, { label: "MacBook-Air" });
  assert.ok(detail.desc.includes("Mac-mini 正在承载"));
  assert.deepEqual(detail.facts.find((f) => f.label === "已承载"), { label: "已承载", value: "2 小时" });
});

test("链路图：待命时隧道节点是通的（不标红、不算断点），详情给「让这台承载」", () => {
  const s = status();
  const model = buildChainModel(s);
  const tunnel = model.nodes.find((n) => n.key === "tunnel");
  assert.equal(tunnel.state, "ok");
  assert.equal(model.phase, "live");
  assert.equal(tunnel.standby.holderLabel, "Mac-mini");
  const detail = buildChainDetail(s, model, "tunnel@server-01", { nowMs: 10_000 });
  assert.equal(detail.takeover, "server-01");
  assert.ok(!detail.facts.some((f) => f.label === "进程"), "待命时不报「未找到隧道进程」");
});

test("承载切换记录：新 → 旧，方向与原因写成人话", () => {
  const rows = buildHandoverRows({
    servers: { "server-01": { serverId: "server-01", name: "主集群服务器 (myserver)" } },
    recentHandovers: [
      { serverId: "server-01", at: 2_000, role: "active", reason: "manual", peer: "Mac-mini" },
      { serverId: "server-01", at: 1_000, role: "standby", reason: "yielded", peer: "Mac-mini" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.text), ["接到本机（自 Mac-mini） · 手动接管", "本机待命（Mac-mini 承载） · 对方接管了"]);
});
