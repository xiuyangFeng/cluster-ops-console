import assert from "node:assert/strict";
import test from "node:test";
// 模块可在 Node 导入本身即是回归验证（惰性 getEl 模式，无顶层 document 引用）。
import {
  chainDetailHtml, chainTrackHtml, cubicBezier, fanParticles, fanPath, initChain, quantizeShare, renderChain, setChainStability, setChainTraffic, setChainTrips,
} from "./render/chain.js";
import {
  buildChainDetail, buildChainModel, buildRoadModel, chainRows, failureReasonClass, formatLatency, formatRate, groupDestinations, hopDuration,
  nodeSelectionId, NODE_LOG_SOURCE, parseForward, parseKeepalive, roadCause, trafficOf, tripSamples, tripSpark, validationRoundTrip,
} from "./render/chain-model.js";

const baseStages = {
  "local-proxy": { stage: "local-proxy", ok: true, durationMs: 12, consecutiveFailures: 0, lastSuccessAt: 1 },
  "ssh-tunnel": { stage: "ssh-tunnel", ok: true, durationMs: 230, consecutiveFailures: 0, lastSuccessAt: 1 },
  "remote-port": { stage: "remote-port", ok: true, durationMs: 480, consecutiveFailures: 0, lastSuccessAt: 1 },
  "agent-endpoint": { stage: "agent-endpoint", ok: true, durationMs: 890, consecutiveFailures: 0, lastSuccessAt: 1 },
};

const baseStatus = {
  health: "ready",
  shouldBeRunning: true,
  supervisorUp: true,
  localProxyUp: true,
  tunnelUp: true,
  remotePortOpen: true,
  activeServer: { host: "myserver", localPort: 8888, remotePort: 7891 },
  bridgeStages: baseStages,
  endpoint: { ok: true, latencyMs: 850 },
  claudeEndpoint: { ok: true, latencyMs: 620 },
  agents: [
    { id: "codex", name: "Codex", endpointLabel: "ChatGPT Codex API" },
    { id: "claude-codewing", name: "Claude CodeWing", endpointLabel: "Claude API" },
  ],
  layers: {
    agents: {
      codex: { level: "ok", reason: "ready", summary: "全部通过", checkedAt: 1 },
      "claude-codewing": { level: "ok", reason: "ready", summary: "Ready", checkedAt: 1 },
    },
  },
};

test("全通态: 主干 4 节点全 ok，3 段连线 ok 且带延迟标注；v2.18.1 起模型不再含 agent 分叉", () => {
  const model = buildChainModel(baseStatus);
  assert.equal("branches" in model, false);
  assert.deepEqual(model.nodes.map((n) => n.key), ["mac", "proxy", "tunnel", "remote"]);
  assert.ok(model.nodes.every((n) => n.state === "ok"));
  assert.deepEqual(model.links.map((l) => l.key), ["local-proxy", "ssh-tunnel", "remote-port"]);
  assert.ok(model.links.every((l) => l.state === "ok"));
  // 第三段（隧道 → 远端）标的是环境校验里的经隧道往返耗时；这份状态没有环境校验，所以不标
  assert.deepEqual(model.links.map((l) => l.latency), ["12ms", "230ms", "—"]);
  assert.equal(model.phase, "live");
  assert.deepEqual(model.otherTunnels, [], "只有一台服务器时没有分叉行");
});

test("隧道断: 首断节点标红，下游节点/连线置灰(级联)", () => {
  const model = buildChainModel({ ...baseStatus, health: "down", tunnelUp: false });
  const states = Object.fromEntries(model.nodes.map((n) => [n.key, n.state]));
  assert.equal(states.mac, "ok");
  assert.equal(states.proxy, "ok");
  assert.equal(states.tunnel, "error");
  assert.equal(states.remote, "unknown");
  assert.deepEqual(model.links.map((l) => l.state), ["ok", "error", "unknown"]);
  assert.equal(model.phase, "broken");
});

test("守护未启: mac 节点降级为 warn(黄)，不阻断下游", () => {
  const model = buildChainModel({ ...baseStatus, health: "degraded", supervisorUp: false });
  assert.equal(model.nodes[0].state, "warn");
  assert.equal(model.nodes[1].state, "ok");
  assert.ok(model.links.every((l) => l.state === "ok"));
  assert.equal(model.phase, "live", "Mac 降级不算中断，光点照常接力");
});

test("手动停止: 所有节点/连线置为 stopped", () => {
  const model = buildChainModel({ ...baseStatus, health: "stopped", shouldBeRunning: false });
  assert.ok(model.nodes.every((n) => n.state === "stopped"));
  assert.ok(model.links.every((l) => l.state === "stopped"));
  assert.equal(model.phase, "stopped");
});

test("waiting: 首轮探测前节点/连线为 unknown(灰)", () => {
  const model = buildChainModel({ ...baseStatus, health: "waiting" });
  assert.ok(model.nodes.every((n) => n.state === "unknown"));
  assert.ok(model.links.every((l) => l.state === "unknown"));
  assert.equal(model.phase, "probing", "同为 unknown，检测中与被上游挡住靠 phase 区分画法");
});

test("formatLatency: ok 带毫秒 / 失败带连败次数 / 无数据为占位符", () => {
  assert.equal(formatLatency({ ok: true, durationMs: 42 }), "42ms");
  assert.equal(formatLatency({ ok: false, consecutiveFailures: 3 }), "失败×3");
  assert.equal(formatLatency({ ok: false, consecutiveFailures: 0 }), "—");
  assert.equal(formatLatency(null), "—");
});

test("日志源映射: 节点 source 与后端 createLogger 真实值一致", () => {
  assert.equal(NODE_LOG_SOURCE.mac, "supervisor");
  assert.equal(NODE_LOG_SOURCE.proxy, "ops");
  assert.equal(NODE_LOG_SOURCE.tunnel, "ops");
  assert.equal(NODE_LOG_SOURCE.remote, "ops");
  const model = buildChainModel(baseStatus);
  assert.ok(model.nodes.every((n) => ["ops", "supervisor"].includes(n.source)));
});

test("Node 环境: renderChain 无 DOM 时安全空转", () => {
  assert.doesNotThrow(() => renderChain(baseStatus));
});

// ---- v2.45：按隧道分叉 + 节点详情的事实数据 ----

const NOW = 1_791_035_000_000;
const SSH = (count, port, host) => `ssh -S none -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=${count} -T -R 127.0.0.1:${port}:127.0.0.1:8888 ${host} exec sh -c 'sleep 30'`;

// 两台都建了隧道：主集群（查看中、有环境校验）+ 阿里云（个人服务器、无环境校验）
const multiStatus = {
  ...baseStatus,
  activeServerId: "server-01",
  activeServer: { id: "server-01", name: "主集群服务器 (myserver)", host: "myserver", localPort: 8888, remotePort: 7891 },
  supervisorUp: true,
  bridgeStages: {
    ...baseStages,
    "local-proxy": { ...baseStages["local-proxy"], durationMs: 1, checks: 3938 },
    // 各隧道共用一个槽位，最后上报的是阿里云那条
    "ssh-tunnel": { ...baseStages["ssh-tunnel"], durationMs: 230, serverId: "server-aliyun" },
    "remote-port": { stage: "remote-port", ok: true, durationMs: 410, consecutiveFailures: 0, lastSuccessAt: NOW },
  },
  serversBrief: {
    "server-01": { name: "myserver", displayName: "主集群服务器 (myserver)", ok: true, cpu: 11, ram: 24, disk: 87 },
    "server-aliyun": { name: "vpn-aliyun", displayName: "阿里云服务器 (vpn-aliyun)", ok: true, cpu: 0, ram: 42, disk: 29 },
  },
  connectionTargets: {
    servers: {
      "server-01": { host: "myserver", tunnelEnabled: true, remotePort: { configured: 7891, effective: 7891 }, signature: "-R 127.0.0.1:7891:127.0.0.1:8888 myserver" },
      "server-aliyun": { host: "vpn-aliyun", tunnelEnabled: true, remotePort: { configured: 7894, effective: 7894 }, signature: "-R 127.0.0.1:7894:127.0.0.1:8888 vpn-aliyun" },
    },
  },
  processes: {
    supervisor: [{ pid: "19938", command: "node channel-supervisor.mjs" }],
    localProxy: [{ pid: "22180", command: "node local_http_connect_proxy.mjs" }],
    tunnelsByServer: {
      "server-01": [{ pid: "5248", command: SSH(2, 7891, "myserver") }],
      "server-aliyun": [{ pid: "80612", command: SSH(5, 7894, "vpn-aliyun") }],
    },
  },
  layers: {
    ...baseStatus.layers,
    tunnels: {
      "server-01": { level: "ok", tunnelUp: true, remotePortOpen: true, tunnel: true },
      "server-aliyun": { level: "ok", tunnelUp: true, remotePortOpen: true, tunnel: true },
    },
    validation: {
      "server-01": {
        level: "ok", reason: "已验证 4 项，失败 0 项", checkedAt: NOW - 4 * 60_000,
        items: [{ key: "remoteProxyTest", ok: true, durationMs: 767 }, { key: "agentVersion:codex", ok: true, durationMs: 77 }],
      },
    },
  },
};

const stability = {
  since: NOW - 8 * 3600_000,
  servers: {
    "server-01": {
      serverId: "server-01", state: "up", since: NOW - 8 * 3600_000, lastDrop: null,
      windows: { "24h": { drops: 0, availability: 1 } },
    },
    "server-aliyun": {
      serverId: "server-aliyun", state: "up", since: NOW - 20 * 60_000,
      lastDrop: { at: NOW - 21 * 60_000, cause: "remote-closed", recoveredAt: NOW - 20 * 60_000, downMs: 37_000 },
      windows: { "24h": { drops: 6, availability: 0.982 } },
    },
  },
};

// /api/egress/usage（v2.65 起带 recording / recent / 每行 recent*）：Claude 流量最大且近一分钟在传
const USAGE = {
  windowHours: 24, since: NOW - 3 * 3600_000, updatedAt: NOW - 20_000, recording: true,
  totals: { connections: 200, up: 400_000_000, down: 120_000_000 },
  recent: { fromAt: NOW - 80_000, toAt: NOW - 20_000, connections: 4, up: 30_000_000, down: 3_000_000 },
  targets: [
    { target: "www.reclaude.ai:443", connections: 80, up: 300_000_000, down: 10_000_000, lastAt: NOW - 20_000, recentConnections: 3, recentUp: 30_000_000, recentDown: 2_000_000 },
    { target: "files.pythonhosted.org:443", connections: 10, up: 90_000, down: 100_000_000, lastAt: NOW - 3600_000, recentConnections: 0, recentUp: 0, recentDown: 0 },
    { target: "chatgpt.com:443", connections: 40, up: 60_000, down: 200_000, lastAt: NOW - 60_000, recentConnections: 1, recentUp: 0, recentDown: 1_000_000 },
    { target: "api.openai.com:443", connections: 9, up: 4000, down: 20_000, lastAt: NOW - 600_000 },
    { target: "close-api.example.xyz:9443", connections: 17, up: 19_000, down: 77_000, lastAt: NOW - 120_000 },
  ],
  other: { targets: 2, connections: 2, up: 11_000, down: 10_000, lastAt: NOW - 900_000 },
};

const withTunnel = (id, patch) => ({
  ...multiStatus,
  layers: { ...multiStatus.layers, tunnels: { ...multiStatus.layers.tunnels, [id]: { ...multiStatus.layers.tunnels[id], ...patch } } },
});
const textOf = (value) => value.map((part) => (typeof part === "object" ? part.b : part)).join("");
const factOf = (detail, label) => detail.facts.find((item) => item.label === label);

test("分叉: 查看中的服务器是主干，其余建了隧道的服务器各一行；远端节点写服务器名", () => {
  const model = buildChainModel(multiStatus);
  assert.deepEqual(model.nodes.map((n) => n.label), ["Mac", "代理", "隧道", "主集群"]);
  assert.equal(model.otherTunnels.length, 1);
  const rows = chainRows(model);
  assert.deepEqual(rows.map((row) => row.serverId), ["server-01", "server-aliyun"]);
  assert.deepEqual(rows[1].nodes.map((n) => [n.key, n.label, n.sub, n.state]), [
    ["tunnel", "隧道", "SSH 反向通道", "ok"],
    ["remote", "阿里云", "vpn-aliyun:7894", "ok"],
  ]);
  assert.deepEqual(rows[1].links.map((l) => [l.key, l.state]), [["ssh-tunnel", "ok"], ["remote-port", "ok"]]);
  // 选中标识带服务器 id：两行的「隧道」互不串
  assert.deepEqual(rows.map((row) => nodeSelectionId(row.nodes[0])), ["tunnel@server-01", "tunnel@server-aliyun"]);
  assert.equal(nodeSelectionId(model.nodes[0]), "mac");
});

test("分叉: 没建隧道的服务器（只监控）不进链路；切换查看对象后主干换成那台", () => {
  const monitorOnly = withTunnel("server-aliyun", { tunnel: false });
  assert.deepEqual(buildChainModel(monitorOnly).otherTunnels, []);
  const swapped = buildChainModel({
    ...multiStatus,
    activeServerId: "server-aliyun",
    activeServer: { id: "server-aliyun", host: "vpn-aliyun", localPort: 8888, remotePort: 7894 },
  });
  assert.deepEqual(chainRows(swapped).map((row) => row.serverId), ["server-aliyun", "server-01"]);
  assert.equal(swapped.nodes[3].label, "阿里云");
});

test("连线标注: 往返耗时来自环境校验；隧道探针不是这台报的就不标", () => {
  const model = buildChainModel(multiStatus);
  // 主干：ssh-tunnel 槽位里是阿里云那条的数据 → 不标；隧道 → 远端标经隧道往返
  assert.deepEqual(model.links.map((l) => l.latency), ["1ms", "—", "往返 767ms"]);
  assert.equal(model.links[2].roundTripAt, NOW - 4 * 60_000);
  // 阿里云这行：槽位正是它的 → 标探针延迟；没有环境校验 → 往返不标
  assert.deepEqual(model.otherTunnels[0].links.map((l) => l.latency), ["230ms", "—"]);
  assert.deepEqual(validationRoundTrip(multiStatus, "server-01"), { ok: true, durationMs: 767, checkedAt: NOW - 4 * 60_000 });
  assert.equal(validationRoundTrip(multiStatus, "server-aliyun"), null);
});

test("连线标注: 远端端口探测连败时优先标失败次数", () => {
  const failing = {
    ...multiStatus,
    health: "down",
    remotePortOpen: false,
    bridgeStages: { ...multiStatus.bridgeStages, "remote-port": { stage: "remote-port", ok: false, durationMs: 0, consecutiveFailures: 3, lastSuccessAt: 1 } },
  };
  const model = buildChainModel(failing);
  assert.equal(model.links[2].state, "error");
  assert.equal(model.links[2].latency, "失败×3");
});

test("分叉行的状态: 隧道断 → 红 + 远端未知；端口不通 → 远端红；没有结论 → 未知", () => {
  const down = buildChainModel(withTunnel("server-aliyun", { tunnelUp: false, remotePortOpen: false })).otherTunnels[0];
  assert.deepEqual(down.nodes.map((n) => n.state), ["error", "unknown"]);
  assert.deepEqual(down.links.map((l) => l.state), ["error", "unknown"]);
  const portClosed = buildChainModel(withTunnel("server-aliyun", { remotePortOpen: false })).otherTunnels[0];
  assert.deepEqual(portClosed.nodes.map((n) => n.state), ["ok", "error"]);
  assert.deepEqual(portClosed.links.map((l) => l.state), ["ok", "error"]);
  const noEvidence = buildChainModel(withTunnel("server-aliyun", { tunnelUp: null, remotePortOpen: null })).otherTunnels[0];
  assert.deepEqual(noEvidence.nodes.map((n) => n.state), ["unknown", "unknown"]);
  // 主干断了不连累别的行：主集群隧道断，阿里云那行仍是绿的
  const trunkDown = buildChainModel({ ...multiStatus, health: "down", tunnelUp: false });
  assert.equal(trunkDown.phase, "broken");
  assert.deepEqual(trunkDown.otherTunnels[0].nodes.map((n) => n.state), ["ok", "ok"]);
});

test("分叉行的状态: 本地代理没起来时各行都被上游挡住；手动停止 / 首轮探测与主干一致", () => {
  const proxyDown = buildChainModel({ ...multiStatus, health: "down", localProxyUp: false });
  assert.equal(proxyDown.nodes[1].state, "error");
  assert.deepEqual(proxyDown.otherTunnels[0].nodes.map((n) => n.state), ["unknown", "unknown"]);
  const stopped = buildChainModel({ ...multiStatus, health: "stopped", shouldBeRunning: false });
  assert.deepEqual(stopped.otherTunnels[0].nodes.map((n) => n.state), ["stopped", "stopped"]);
  assert.deepEqual(stopped.otherTunnels[0].links.map((l) => l.state), ["stopped", "stopped"]);
  const waiting = buildChainModel({ ...multiStatus, health: "waiting" });
  assert.deepEqual(waiting.otherTunnels[0].nodes.map((n) => n.state), ["unknown", "unknown"]);
});

test("parseForward / parseKeepalive: 读 -R 签名与隧道进程命令行", () => {
  assert.deepEqual(parseForward("-R 127.0.0.1:7891:127.0.0.1:8888 myserver"), { bind: "127.0.0.1", remotePort: 7891, localPort: 8888 });
  assert.deepEqual(parseForward("ssh -T -R 7894:127.0.0.1:8891 host"), { bind: "", remotePort: 7894, localPort: 8891 });
  assert.equal(parseForward("ssh host"), null);
  assert.equal(parseForward(undefined), null);
  assert.deepEqual(parseKeepalive(SSH(5, 7894, "vpn-aliyun")), { interval: 20, count: 5 });
  assert.equal(parseKeepalive("ssh host"), null);
});

test("隧道详情: 在线时长、断线统计、端口映射、心跳、进程", () => {
  const model = buildChainModel(multiStatus);
  const detail = buildChainDetail(multiStatus, model, "tunnel@server-aliyun", { stability, nowMs: NOW });
  assert.equal(detail.title, "隧道 · 阿里云");
  assert.equal(detail.desc, "SSH 反向通道在线 20 分");
  assert.equal(detail.state, "ok");
  assert.equal(detail.switchTo, "server-aliyun", "不是查看中的那台 → 给出「切到这台查看」");
  assert.equal(detail.navigate, "stability");
  assert.equal(detail.logSource, "ops");
  assert.equal(detail.diag, null);
  // 账本不满 24 小时：标「自 … 起」而不是「近 24 小时」
  const drops = detail.facts[0];
  assert.match(drops.label, /^自 .+ 起$/);
  assert.equal(textOf(drops.value), "6 次断线 · 可用率 98.20%");
  assert.equal(drops.tone, "warn");
  assert.match(textOf(factOf(detail, "最近一次断线").value), /服务器端断开 · 37 秒后恢复$/);
  assert.equal(textOf(factOf(detail, "端口映射").value), "远端 :7894 → 本机 :8888");
  assert.equal(textOf(factOf(detail, "心跳").value), "每 20 秒，连续 5 次无响应判定断线（约 100 秒）");
  assert.equal(textOf(factOf(detail, "进程").value), "ssh · pid 80612");

  const trunk = buildChainDetail(multiStatus, model, "tunnel@server-01", { stability: { ...stability, since: NOW - 3 * 86_400_000 }, nowMs: NOW });
  assert.equal(trunk.switchTo, null, "查看中的那台不给切换");
  assert.equal(trunk.facts[0].label, "近 24 小时");
  assert.equal(trunk.facts[0].tone, "");
  assert.equal(textOf(factOf(trunk, "最近一次断线").value), "记录以来没有断线");
  assert.equal(textOf(factOf(trunk, "心跳").value), "每 20 秒，连续 2 次无响应判定断线（约 40 秒）");
});

test("隧道详情: 稳定性数据还没到时只少两条断线统计；断开时说明已断多久、进程缺失标红", () => {
  const model = buildChainModel(multiStatus);
  const bare = buildChainDetail(multiStatus, model, "tunnel@server-aliyun", { nowMs: NOW });
  assert.equal(bare.desc, "SSH 反向通道在线");
  assert.deepEqual(bare.facts.map((item) => item.label), ["端口映射", "心跳", "进程"]);

  const downStatus = {
    ...withTunnel("server-aliyun", { tunnelUp: false, remotePortOpen: false }),
    processes: { ...multiStatus.processes, tunnelsByServer: { "server-01": multiStatus.processes.tunnelsByServer["server-01"] } },
  };
  const downStability = { ...stability, servers: { ...stability.servers, "server-aliyun": { ...stability.servers["server-aliyun"], state: "down", since: NOW - 3 * 60_000 } } };
  const down = buildChainDetail(downStatus, buildChainModel(downStatus), "tunnel@server-aliyun", { stability: downStability, nowMs: NOW });
  assert.equal(down.state, "error");
  assert.equal(down.desc, "断开中，已 3 分，正在自动重连");
  assert.deepEqual([textOf(factOf(down, "进程").value), factOf(down, "进程").tone], ["未找到隧道进程", "critical"]);
  assert.equal(factOf(down, "心跳"), undefined, "没有进程就读不到心跳参数，不编造");
});

test("远端详情: 监听端口、经隧道往返、环境校验、资源；没有环境校验的服务器如实说明", () => {
  const model = buildChainModel(multiStatus);
  const main = buildChainDetail(multiStatus, model, "remote@server-01", { stability, nowMs: NOW });
  assert.equal(main.title, "主集群 · myserver");
  assert.equal(main.desc, "远端 :7891 监听中，服务器上的程序经它出网");
  assert.equal(main.navigate, "servers");
  assert.equal(textOf(factOf(main, "远端监听").value), "127.0.0.1:7891（只对服务器本机开放）");
  assert.equal(textOf(factOf(main, "经隧道往返").value), "767ms · 4 分钟前校验");
  assert.equal(textOf(factOf(main, "环境校验").value), "2/2 通过 · 最慢 remoteProxyTest 767ms · 4 分钟前");
  assert.deepEqual(main.checks, [
    { key: "remoteProxyTest", ok: true, durationMs: 767, output: "" },
    { key: "agentVersion:codex", ok: true, durationMs: 77, output: "" },
  ], "逐项清单（详情下方）");
  assert.equal(textOf(factOf(main, "资源").value), "CPU 11% · 内存 24% · 磁盘 87%");

  const aliyun = buildChainDetail(multiStatus, model, "remote@server-aliyun", { stability, nowMs: NOW });
  assert.equal(aliyun.title, "阿里云 · vpn-aliyun");
  assert.equal(textOf(factOf(aliyun, "经隧道往返").value), "这台没有配置环境校验");
  assert.equal(factOf(aliyun, "环境校验"), undefined);

  const failed = {
    ...multiStatus,
    layers: {
      ...multiStatus.layers,
      validation: { "server-01": { level: "critical", reason: "已验证 4 项，失败 1 项", checkedAt: NOW - 60_000, items: [{ key: "remoteProxyTest", ok: false, durationMs: 8000 }] } },
    },
  };
  const bad = buildChainDetail(failed, buildChainModel(failed), "remote@server-01", { nowMs: NOW });
  assert.deepEqual([textOf(factOf(bad, "经隧道往返").value), factOf(bad, "经隧道往返").tone], ["没有走通 · 1 分钟前校验", "critical"]);
  assert.equal(factOf(bad, "环境校验").tone, "critical");

  // 有失败：失败项置顶并只给失败项附输出；没有逐项结果（只有一句结论）时退回原文
  const mixed = {
    ...multiStatus,
    layers: {
      ...multiStatus.layers,
      validation: { "server-01": { level: "critical", checkedAt: NOW - 60_000, items: [
        { key: "agentVersion:codex", ok: true, durationMs: 77, output: "codex 0.141.0" },
        { key: "remoteProxyTest", ok: false, durationMs: 8000, output: "curl: (28) timed out" },
      ] } },
    },
  };
  const m = buildChainDetail(mixed, buildChainModel(mixed), "remote@server-01", { nowMs: NOW });
  assert.equal(textOf(factOf(m, "环境校验").value), "1/2 失败 · 最慢 remoteProxyTest 8000ms · 1 分钟前");
  assert.deepEqual(m.checks.map((c) => [c.key, c.ok, c.output]), [["remoteProxyTest", false, "curl: (28) timed out"], ["agentVersion:codex", true, ""]]);
  const reasonOnly = { ...multiStatus, layers: { ...multiStatus.layers, validation: { "server-01": { level: "warn", reason: "校验超时" } } } };
  const r = buildChainDetail(reasonOnly, buildChainModel(reasonOnly), "remote@server-01", { nowMs: NOW });
  assert.deepEqual([textOf(factOf(r, "环境校验").value), factOf(r, "环境校验").tone, r.checks], ["校验超时", "warn", null]);
  assert.equal(buildChainModel(failed).links[2].latency, "—", "往返没走通时连线上不标耗时");
});

test("本机代理详情（v2.65 起并入 Mac）: 监听、探测、守护进程、服务的隧道与在线数", () => {
  const model = buildChainModel(multiStatus);
  const proxy = buildChainDetail(multiStatus, model, "proxy", { stability, nowMs: NOW });
  assert.equal(proxy.title, "本机代理");
  assert.equal(textOf(factOf(proxy, "监听").value), "127.0.0.1:8888");
  assert.equal(textOf(factOf(proxy, "探测").value), "1ms · 累计探测 3,938 次");
  assert.equal(textOf(factOf(proxy, "守护进程").value), "运行中 · pid 19938");
  assert.deepEqual([textOf(factOf(proxy, "服务的隧道").value), factOf(proxy, "服务的隧道").tone], ["2 / 2 条在线 · 主集群、阿里云", ""]);
  assert.equal(textOf(factOf(proxy, "进程").value), "pid 22180");
  assert.equal(proxy.switchTo, null);

  // 旧的选中 id "mac"（升级前选着的）落到本机代理详情
  const mac = buildChainDetail(multiStatus, model, "mac", { stability, nowMs: NOW });
  assert.equal(mac.title, "本机代理");
  assert.equal(mac.logSource, "supervisor");

  const oneDown = withTunnel("server-aliyun", { tunnelUp: false, remotePortOpen: false });
  const down = buildChainDetail(oneDown, buildChainModel(oneDown), "proxy", { nowMs: NOW });
  assert.deepEqual([textOf(factOf(down, "服务的隧道").value), factOf(down, "服务的隧道").tone], ["1 / 2 条在线 · 主集群、阿里云", "warn"]);

  const noSupervisor = { ...multiStatus, supervisorUp: false };
  const warn = buildChainDetail(noSupervisor, buildChainModel(noSupervisor), "proxy", { nowMs: NOW });
  assert.deepEqual([textOf(factOf(warn, "守护进程").value), factOf(warn, "守护进程").tone], ["未运行", "warn"]);
  assert.match(warn.desc, /断线后不会自动恢复/);
});

test("详情: 查看中的链路不正常时附整链诊断，其余服务器的行不附；选中的服务器不在了返回 null", () => {
  const down = { ...multiStatus, health: "down", tunnelUp: false };
  const model = buildChainModel(down);
  const trunk = buildChainDetail(down, model, "tunnel@server-01", { stability, nowMs: NOW });
  assert.ok(trunk.diag?.title, "主干节点带诊断标题");
  assert.ok(trunk.diag.body.length > 0);
  assert.equal(buildChainDetail(down, model, "tunnel@server-aliyun", { stability, nowMs: NOW }).diag, null);
  assert.equal(buildChainDetail(multiStatus, buildChainModel(multiStatus), "mac", { nowMs: NOW }).diag, null, "链路正常时不附诊断");
  assert.equal(buildChainDetail(multiStatus, buildChainModel(multiStatus), "tunnel@server-gone", { nowMs: NOW }), null);
});

test("链路 HTML: 集群 / 本机代理 / 出网三个节点 + 隧道管子；结构固定（光点、回声、断点常驻）；其余隧道是小标签", () => {
  const road = buildRoadModel(multiStatus, { usage: USAGE, stability, nowMs: NOW });
  const html = chainTrackHtml(road, NOW);
  assert.equal((html.match(/class="road-node /g) || []).length, 3);
  assert.match(html, /class="road-node state-ok" data-node="remote" data-select="remote@server-01"/);
  assert.match(html, /class="road-node state-ok" data-node="proxy" data-select="proxy"/);
  assert.match(html, /class="road-node state-unknown" data-node="egress" data-select="egress"/, "没有出网健康数据：未知，不冒充正常");
  assert.match(html, /class="road-link road-pipe state-ok" data-link="tunnel" style="--dur:2\.8s"/, "410ms 落在慢档");
  assert.match(html, /data-select="tunnel@server-01"[^>]*><b class="road-pipe-name">SSH 隧道<\/b><span class="road-ms">410ms<\/span>/);
  assert.match(html, /<span class="road-link-note">在线 8 小时<\/span>/);
  assert.equal((html.match(/class="road-pk"/g) || []).length, 6, "两段连线各 3 个光点，由 CSS 按流量档位显隐");
  assert.equal((html.match(/road-ping/g) || []).length, 2);
  assert.equal((html.match(/road-break/g) || []).length, 2);
  assert.match(html, /<div class="road-others">.*data-select="tunnel@server-aliyun"[^>]*><i class="road-other-dot" aria-hidden="true"><\/i>阿里云<span class="road-other-state">正常<\/span>/s);
  assert.equal((html.match(/class="road-dest(?: is-active)?"/g) || []).length, 4);
  assert.match(html, /data-select="dest:claude" data-dest="claude"/);

  const single = chainTrackHtml(buildRoadModel(baseStatus, { nowMs: NOW }), NOW);
  assert.match(single, /<div class="road-others" hidden><\/div>/);
  assert.doesNotMatch(single, /class="road-dest[ "]/, "用量还没拉到：不画去向卡");
});

test("详情 HTML: 加重片段包 <b>，动态文案一律转义，动作按钮按模型出", () => {
  const model = buildChainModel(multiStatus);
  const html = chainDetailHtml(buildChainDetail(multiStatus, model, "tunnel@server-aliyun", { stability, nowMs: NOW }));
  assert.match(html, /<dd><b>6<\/b> 次断线 · 可用率 <b>98\.20%<\/b><\/dd>/);
  assert.match(html, /class="chain-fact" data-tone="warn"/);
  assert.match(html, /data-chain-switch="server-aliyun">切到这台查看</);
  assert.match(html, /data-chain-goto="stability">稳定性统计 →</);
  assert.match(html, /data-log-source="ops">相关日志 →</);
  assert.match(html, /chk-status chk-status-ok/);
  assert.doesNotMatch(html, /chain-detail-diag/);

  const evil = chainDetailHtml({
    title: "<img src=x>", desc: "a & b", state: "error", logSource: "ops", switchTo: null, navigate: null,
    facts: [{ label: "<i>", value: ["x<y", { b: "<script>" }], tone: "" }],
    checks: [{ key: "<svg onload=1>", ok: false, durationMs: 5, output: "</pre><img src=y>" }, { key: "ok-check", ok: true, durationMs: 9, output: "" }],
    diag: { title: "<b>t</b>", body: "\"q\"" },
  });
  assert.doesNotMatch(evil, /<img|<script>|<i>|<b>t<\/b>|<svg onload/);
  assert.match(evil, /<li class="chain-check" data-ok="false">.*&lt;svg onload=1&gt;.*<pre class="chain-check-output">&lt;\/pre&gt;&lt;img src=y&gt;<\/pre><\/li>/, "失败项附输出，全部转义");
  assert.match(evil, /<li class="chain-check" data-ok="true">.*ok-check.*9ms/);
  assert.match(evil, /&lt;img src=x&gt;/);
  assert.match(evil, /chk-status-bad/);
  assert.match(evil, /chain-detail-diag/);
  assert.equal(chainDetailHtml(null), "");
});

test("Node 环境: initChain / setChainStability / setChainTraffic / setChainTrips 无 DOM 时安全空转", () => {
  assert.doesNotThrow(() => initChain({ onNavigate() {}, onSwitchServer() {}, onOpenEgress() {} }));
  assert.doesNotThrow(() => setChainStability(stability));
  assert.doesNotThrow(() => setChainStability(null));
  assert.doesNotThrow(() => setChainTraffic(USAGE));
  assert.doesNotThrow(() => setChainTraffic(null));
  assert.doesNotThrow(() => setChainTrips([{ ts: Date.now(), proxyLatencyMs: 300 }], "server-01"));
  assert.doesNotThrow(() => renderChain(multiStatus));
});

// ---- v2.65 请求之路：去向分组、流量档位、端到端往返、出网与断点原因 ----

const HEALTH_OK = {
  mode: "manual", upstream: "127.0.0.1:7897", state: "ok", reason: null,
  check: { ok: true, ms: 2, at: NOW - 10_000, error: null },
  failures: { windowMs: 600_000, total: 0, refused: 0, timeout: 0, rejected: 0, other: 0, last: null, topHosts: [] },
  checkedAt: NOW - 10_000,
};
const roadStatus = (patch = {}) => ({ ...multiStatus, egressHealth: HEALTH_OK, ...patch });

test("去向分组: 按域名后缀归类、按流量排、算占比与「正在传输」；口令为关时不记录", () => {
  const { recording, since, totals, groups } = groupDestinations(USAGE);
  assert.equal(recording, true);
  assert.equal(since, NOW - 3 * 3600_000);
  assert.deepEqual(totals, { connections: 200, up: 400_000_000, down: 120_000_000 });
  assert.deepEqual(groups.map((g) => g.key), ["claude", "deps", "openai", "other"]);
  const [claude, deps, openai, other] = groups;
  assert.deepEqual([claude.connections, claude.active, deps.active, openai.active, other.active], [80, true, false, true, false]);
  assert.equal(openai.connections, 49, "chatgpt.com + api.openai.com");
  assert.equal(other.connections, 19, "不认识的域名 + 用量记录里的「其它」行");
  assert.ok(Math.abs(groups.reduce((a, g) => a + g.share, 0) - 1) < 1e-9);
  assert.ok(claude.share > 0.7);

  assert.deepEqual(groupDestinations({ ...USAGE, recording: false }).groups, [], "不记录时不出卡（空状态另说）");
  assert.equal(groupDestinations({ ...USAGE, recording: false }).recording, false);
  assert.equal(groupDestinations(null).recording, null, "还没拉到");
  // 不可信的目标名照样只进分组、不抛错
  assert.equal(groupDestinations({ recording: true, targets: [{ target: "<x>", connections: 1 }, null, { connections: 2 }] }).groups[0].key, "other");
  // 当 Top 12 截断了低字节高频的 OpenAI 目标时，groupDestinations 使用 allTargets / allOther 完整归类
  const truncated = groupDestinations({
    recording: true,
    targets: [{ target: "files.pythonhosted.org:443", connections: 10, up: 1000, down: 90_000_000 }],
    other: { targets: 1, connections: 800, up: 500_000, down: 2_000_000 },
    allTargets: [
      { target: "files.pythonhosted.org:443", connections: 10, up: 1000, down: 90_000_000 },
      { target: "chatgpt.com:443", connections: 800, up: 500_000, down: 2_000_000, recentConnections: 2 },
    ],
    allOther: null,
  });
  assert.deepEqual(truncated.groups.map((g) => [g.key, g.connections, g.active]), [["deps", 10, false], ["openai", 800, true]]);
});

test("流量档位: 用量文件相邻两版之差 → 繁忙 / 有流量 / 空闲；速率文案", () => {
  assert.deepEqual(trafficOf(USAGE), { level: "busy", bps: 550_000 });
  assert.equal(trafficOf({ recent: { fromAt: 0, toAt: 60_000, connections: 1, up: 0, down: 0 } }).level, "low");
  assert.equal(trafficOf({ recent: { fromAt: 0, toAt: 60_000, connections: 0, up: 0, down: 0 } }).level, "idle");
  assert.equal(trafficOf({ recent: null }).level, "idle", "文件 150 秒没重写 = 空闲");
  assert.equal(trafficOf(null).level, "idle");
  assert.equal(trafficOf({ recent: { fromAt: 10, toAt: 10, up: 5 } }).level, "idle", "时间段非法不算");
  assert.deepEqual([formatRate(550_000), formatRate(1_830_000), formatRate(512)], ["550 KB/s", "1.8 MB/s", "512 B/s"]);
  assert.deepEqual([hopDuration("12ms"), hopDuration("88ms"), hopDuration("250ms"), hopDuration("410ms"), hopDuration("失败×3"), hopDuration("—")], [1.3, 1.3, 1.9, 2.8, 1.9, 1.9]);
});

test("端到端往返: 只留近 24 小时的正数样本；走势按 30 分钟分桶取中位、空桶断开", () => {
  const samples = [
    { ts: NOW - 25 * 3600_000, proxyLatencyMs: 999 },
    { ts: NOW - 3600_000, proxyLatencyMs: 300 },
    { ts: NOW - 3500_000, proxyLatencyMs: 500 },
    { ts: NOW - 3400_000, proxyLatencyMs: 400 },
    { ts: NOW - 600_000, proxyLatencyMs: 350 },
    { ts: NOW - 300_000, proxyLatencyMs: 0 },
    { ts: NOW - 60_000, proxyLatencyMs: 342.4 },
  ];
  const trips = tripSamples(samples, NOW);
  assert.deepEqual(trips.map((t) => t.ms), [300, 500, 400, 350, 342]);
  const spark = tripSpark(trips, { nowMs: NOW, w: 120, h: 20 });
  assert.deepEqual(spark.last, { ts: NOW - 60_000, ms: 342 });
  assert.equal(spark.median, 350);
  assert.match(spark.line, /^M[\d.]+ [\d.]+L/);
  assert.equal((spark.area.match(/Z/g) || []).length, 1, "最后一小时连续的两个桶连成一段");
  assert.deepEqual(tripSpark([{ ts: NOW - 1000, ms: 300 }], { nowMs: NOW }).line, "", "不足两个桶不画线");
});

test("请求之路模型: 状态取自探针模型；隧道管子取隧道与远端两段里更坏的；出网读 egressHealth", () => {
  const road = buildRoadModel(roadStatus(), { usage: USAGE, stability, nowMs: NOW });
  assert.equal(road.phase, "live");
  assert.equal(road.traffic.level, "busy");
  assert.deepEqual([road.cluster.state, road.tunnel.state, road.proxy.state, road.egress.state], ["ok", "ok", "ok", "ok"]);
  assert.deepEqual([road.egress.sub, road.egressLink.latency, road.egressLink.state], ["上游 :7897", "2ms", "ok"]);
  assert.equal(road.cause, null);
  assert.equal(road.supervisorDown, false);
  assert.deepEqual(road.others, [{ serverId: "server-aliyun", name: "阿里云", state: "ok", select: "tunnel@server-aliyun" }]);

  const portDown = buildRoadModel(roadStatus({ health: "down", remotePortOpen: false }), { usage: USAGE, nowMs: NOW });
  assert.deepEqual([portDown.phase, portDown.cluster.state, portDown.tunnel.state, portDown.traffic.level], ["broken", "error", "error", "idle"]);
  assert.equal(portDown.tunnel.latency, "—", "不通时不留上一次的毫秒数");
  const failing = buildRoadModel(roadStatus({ health: "down", tunnelUp: false, bridgeStages: { ...multiStatus.bridgeStages, "remote-port": { stage: "remote-port", ok: false, consecutiveFailures: 3 } } }), { nowMs: NOW });
  assert.equal(failing.tunnel.latency, "失败×3");
  assert.ok(portDown.destinations.groups.every((g) => !g.active), "不通时不报「正在传输」");

  const egressDown = buildRoadModel(roadStatus({ egressHealth: { ...HEALTH_OK, state: "error", reason: "upstream-refused", check: { ok: false, ms: null, at: NOW, error: "refused" } } }), { usage: USAGE, nowMs: NOW });
  assert.deepEqual([egressDown.phase, egressDown.egress.state, egressDown.egressLink.state, egressDown.egressLink.latency], ["broken", "error", "error", "—"]);

  const direct = buildRoadModel(roadStatus({ egressHealth: { ...HEALTH_OK, mode: "direct", upstream: null, check: null } }), { nowMs: NOW });
  assert.equal(direct.egress.sub, "直连");

  const proxyDown = buildRoadModel(roadStatus({ health: "down", localProxyUp: false }), { nowMs: NOW });
  assert.deepEqual([proxyDown.proxy.state, proxyDown.egress.state, proxyDown.egressLink.state], ["error", "unknown", "unknown"], "代理没起来：出网被挡住，不各自报错");

  const stopped = buildRoadModel(roadStatus({ shouldBeRunning: false }), { nowMs: NOW });
  assert.deepEqual([stopped.phase, stopped.egress.state, stopped.tunnel.state], ["stopped", "stopped", "stopped"]);

  const noSupervisor = buildRoadModel(roadStatus({ supervisorUp: false }), { nowMs: NOW });
  assert.deepEqual([noSupervisor.proxy.state, noSupervisor.supervisorDown, noSupervisor.cause.tone], ["ok", true, "warn"], "守护进程没运行：代理不变色，只出角标与原因");
  assert.match(chainTrackHtml(noSupervisor, NOW), /class="road-badge"/);
});

test("断点原因: 优先级 停止 > 检测中 > 没领端口 > 本机代理 > 隧道 > 集群端口 > 出网中断 > 出网失败 > 守护进程", () => {
  const cause = (patch, opts = {}) => buildRoadModel(roadStatus(patch), { nowMs: NOW, ...opts }).cause;
  assert.match(cause({ shouldBeRunning: false }).text, /手动停止/);
  assert.match(cause({ health: "waiting" }).text, /^正在检查/);
  assert.match(cause({ health: "down", localProxyUp: false, tunnelUp: false }).text, /本机代理 :8888 没有在监听，正在自动拉起/);
  const downStability = { servers: { "server-01": { state: "down", since: NOW - 83_000 } } };
  const tunnel = cause({ health: "down", tunnelUp: false, egressHealth: { ...HEALTH_OK, state: "error" } }, { stability: downStability });
  assert.equal(tunnel.tone, "critical");
  assert.match(tunnel.text, /^SSH 隧道断开 1 分，正在自动重连；期间集群上的 codex \/ claude 无法出网$/, "写到分钟：不让每帧状态都改文案");
  assert.match(cause({ health: "down", remotePortOpen: false }).text, /集群端口 :7891 没有在监听/);
  const egress = cause({ egressHealth: { ...HEALTH_OK, state: "error", reason: "upstream-refused" } });
  assert.equal(egress.text, "出网中断：上游 :7897 拒绝连接（上游代理可能没在运行），集群此刻访问不了外网");
  const failures = { ...HEALTH_OK.failures, total: 5, timeout: 5, last: { host: "chatgpt.com", port: 443, reason: "upstream-timeout", at: NOW }, topHosts: [{ host: "chatgpt.com", count: 4 }] };
  const warn = cause({ egressHealth: { ...HEALTH_OK, state: "warn", reason: "target-failures", failures } });
  assert.deepEqual([warn.tone, warn.text], ["warn", "近 10 分钟有 5 次出网失败，最多的是 chatgpt.com（最近一次：超时）"]);
  assert.match(cause({ supervisorUp: false }).text, /守护进程没有在运行/);
  const rateLimited = cause({ layers: { ...multiStatus.layers, signals: { active: [{ id: "rate-limited" }] } } });
  assert.equal(rateLimited.tone, "warn");
  assert.match(rateLimited.text, /触发上游 API 限流（429 \/ 配额限制），稍后自行恢复，无需重启隧道/);
  const revoked = cause({ layers: { ...multiStatus.layers, signals: { active: [{ id: "account-revoked" }] } } });
  assert.equal(revoked.tone, "warn");
  assert.match(revoked.text, /账号或凭证异常.*重启隧道无效/);
  assert.equal(roadCause(buildRoadModel(roadStatus(), { nowMs: NOW }), roadStatus(), { nowMs: NOW }), null);
  assert.deepEqual(["upstream-refused", "ECONNREFUSED", "upstream-timeout", "timeout", "ETIMEDOUT", "upstream-rejected-502", "ENOTFOUND"].map(failureReasonClass), ["refused", "refused", "timeout", "timeout", "timeout", "rejected", "other"]);
});

test("出网 / 去向详情: 方式与上游、上游探测、近 10 分钟失败；去向明细按流量排", () => {
  const failures = { ...HEALTH_OK.failures, total: 3, timeout: 2, rejected: 1, last: { host: "chatgpt.com", port: 443, reason: "upstream-timeout", at: NOW - 60_000 }, topHosts: [{ host: "chatgpt.com", count: 2 }, { host: "api.openai.com", count: 1 }] };
  const status = roadStatus({ egressHealth: { ...HEALTH_OK, state: "warn", reason: "target-failures", failures } });
  const egress = buildChainDetail(status, buildChainModel(status), "egress", { usage: USAGE, nowMs: NOW });
  assert.equal(egress.title, "出网");
  assert.equal(egress.navigate, "egress");
  assert.equal(egress.logSource, "supervisor");
  assert.equal(textOf(factOf(egress, "出网方式").value), "手动指定的上游代理 · 127.0.0.1:7897");
  assert.match(textOf(factOf(egress, "上游探测").value), /^2ms · 10 秒前/);
  assert.deepEqual([textOf(factOf(egress, "近 10 分钟建连失败").value), factOf(egress, "近 10 分钟建连失败").tone], ["3 次 · 超时 2 · 上游回绝 1", "warn"]);
  assert.equal(textOf(factOf(egress, "失败最多的目标").value), "chatgpt.com ×2、api.openai.com ×1");
  assert.equal(textOf(factOf(egress, "近一分钟").value), "550 KB/s");

  const dest = buildChainDetail(status, buildChainModel(status), "dest:openai", { usage: USAGE, nowMs: NOW });
  assert.equal(dest.title, "去向 · OpenAI");
  assert.deepEqual(dest.facts.map((f) => f.label), ["chatgpt.com", "api.openai.com"]);
  assert.match(dest.desc, /^49 次连接 · /);
  assert.equal(buildChainDetail(status, buildChainModel(status), "dest:nope", { usage: USAGE, nowMs: NOW }), null);
  assert.match(chainDetailHtml(egress), /data-chain-goto="egress">出网设置 →</);
});

test("去向不记录 / 还没有记录时的空状态；动态文案一律转义", () => {
  const off = chainTrackHtml(buildRoadModel(roadStatus(), { usage: { ...USAGE, recording: false }, nowMs: NOW }), NOW);
  assert.match(off, /代理口令「只记录」后，这里显示集群经这条链路去了哪/);
  assert.match(off, /data-chain-goto="egress">打开出网设置 →</);
  assert.doesNotMatch(off, /road-live/, "不记录时不写「空闲」冒充没流量");
  const none = chainTrackHtml(buildRoadModel(roadStatus(), { usage: { recording: true, targets: [], totals: { connections: 0, up: 0, down: 0 } }, nowMs: NOW }), NOW);
  assert.match(none, /近 24 小时还没有经这条链路的连接/);

  const evilStatus = roadStatus({
    activeServer: { ...multiStatus.activeServer, host: "<img src=x>" },
    serversBrief: { ...multiStatus.serversBrief, "server-01": { ...multiStatus.serversBrief["server-01"], displayName: "<b>坏名字</b>" } },
  });
  const html = chainTrackHtml(buildRoadModel(evilStatus, { usage: USAGE, nowMs: NOW }), NOW);
  assert.doesNotMatch(html, /<img|<b>坏/);
});

test("隧道说明: 在线写到分钟；集群端口不通时写明；守护进程没运行时不说「重连中」；速度档用中位数", () => {
  const minutes = { servers: { "server-01": { state: "up", since: NOW - 3 * 60_000 - 25_000 } } };
  assert.equal(buildRoadModel(roadStatus(), { stability: minutes, nowMs: NOW }).tunnel.note, "在线 3 分");
  const young = { servers: { "server-01": { state: "up", since: NOW - 20_000 } } };
  assert.equal(buildRoadModel(roadStatus(), { stability: young, nowMs: NOW }).tunnel.note, "刚上线");
  assert.equal(buildRoadModel(roadStatus({ health: "down", remotePortOpen: false }), { nowMs: NOW }).tunnel.note, "隧道在线 · 集群端口不通");
  assert.equal(buildRoadModel(roadStatus({ health: "down", tunnelUp: false }), { nowMs: NOW }).tunnel.note, "断开 · 重连中");
  assert.equal(buildRoadModel(roadStatus({ health: "down", tunnelUp: false, supervisorUp: false }), { nowMs: NOW }).tunnel.note, "断开");
  assert.equal(buildRoadModel(roadStatus(), { nowMs: NOW, tunnelMs: 90 }).tunnel.dur, 1.3, "这一次 410ms，但最近几次的中位数是 90ms");
});

test("分叉曲线: 缓动曲线过端点；曲线首尾就是起止点；光点数按占比", () => {
  const ease = cubicBezier(0.5, 0, 0.5, 1);
  assert.ok(Math.abs(ease(0)) < 1e-9 && Math.abs(ease(1) - 1) < 1e-9 && Math.abs(ease(0.5) - 0.5) < 1e-6);
  const d = fanPath(400, 10, 20, 90);
  assert.match(d, /^M400\.0 10\.0L/);
  assert.match(d, /L20\.0 90\.0$/);
  assert.equal((d.match(/L/g) || []).length, 32);
  assert.deepEqual([fanParticles(0.6), fanParticles(0.2), fanParticles(0.01)], [3, 2, 1]);
  assert.deepEqual([quantizeShare(0.612), quantizeShare(0.638), quantizeShare(0.01), quantizeShare(1.2)], [0.6, 0.65, 0, 1]);
});
