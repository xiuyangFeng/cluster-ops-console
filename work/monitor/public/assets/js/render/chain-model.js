// chain-model.js —— 数据链路的纯数据模型（无 DOM，Node 可直接 import 测试；渲染在 chain.js）。
// buildChainModel：探针级状态——主干 Mac / 代理 / 隧道 / 远端 4 节点 + 3 段连线（查看中的服务器，状态与
// layers.channel 同源，首个断点之后级联为未知），外加其余建了隧道的服务器各一行（otherTunnels，取 layers.tunnels）。
// buildRoadModel（v2.65「请求之路」）：按请求真实的走向重排——集群 ══SSH 隧道══ 本机代理 ── 出网 → 去向。
// 节点状态取自 buildChainModel；出网取 /api/status.egressHealth，去向与近一分钟流量取 /api/egress/usage，
// 端到端往返取环境校验的 proxyLatencyMs 历史；链路不畅通时给一句断点原因（roadCause）。
// buildChainDetail：选中节点的详情 = 一句结论 + 几条事实（在线时长、断线统计、端口映射、心跳、
// 进程、往返耗时、资源、出网与去向），数据来自 /api/status、/api/tunnel-stability 与 /api/egress/usage；
// 查看中的链路不正常时附整链诊断文案（checklist.js 的 getDiagnosticMsg）。
import { serverShortName } from "../display-names.js";
import { formatBytes, formatRelativeTime } from "../store.js";
import { getDiagnosticMsg } from "./checklist.js";
import { canTakeOver, handoverDetail, handoverNote, handoverStandbyOf } from "./handover-model.js";
import { availabilityText, causeLabel, humanDuration, shortDateTime } from "./tunnel-stability-model.js";
import { buildValidationSummary, buildValidationSummaryLabel, sortValidationItems } from "./validation-model.js";

// 节点 → 日志源映射。source 值必须与后端 createLogger() 的真实 source 一致：
// 守护进程独立落 "supervisor"（channel-supervisor.mjs），代理/隧道/远端/端点的
// 探测与修复动作全部经 appendLog → opsLogger 落 "ops"（monitor-server.mjs）。
export const NODE_LOG_SOURCE = {
  mac: "supervisor",
  proxy: "ops",
  tunnel: "ops",
  remote: "ops",
};

// bridgeStages 段延迟 → 连线标注文本
export function formatLatency(stage) {
  if (!stage) return "—";
  if (stage.ok && Number(stage.durationMs) > 0) return `${Number(stage.durationMs)}ms`;
  if (!stage.ok && Number(stage.consecutiveFailures) > 0) return `失败×${Number(stage.consecutiveFailures)}`;
  return "—";
}

// bridgeStages["ssh-tunnel"] 只有一份，描述的是查看中的那台（快照带 serverId）：只在它确实来自
// 这台服务器时才标到这一行，别的行不标。
function stageLatencyFor(stage, serverId) {
  if (stage?.serverId && serverId && stage.serverId !== serverId) return "—";
  return formatLatency(stage);
}

// 环境校验里的 remoteProxyTest：远端经隧道访问外网的一次往返（每 5 分钟一轮），没有配置校验的服务器返回 null。
// 这一项被跳过（没领端口）时同样返回 null：没跑过就没有往返可言。
export function validationRoundTrip(status, serverId) {
  const entry = serverId ? status.layers?.validation?.[serverId] : null;
  const item = Array.isArray(entry?.items) ? entry.items.find((it) => it?.key === "remoteProxyTest") : null;
  if (!item || item.skipped) return null;
  return { ok: item.ok !== false, durationMs: Number(item.durationMs) || 0, checkedAt: entry.checkedAt ?? null };
}

// 「隧道 → 远端」这一段的标注：远端端口探测在连败时标「失败×N」，否则标经隧道的往返耗时；都没有就不标。
function roundTripLabel(status, serverId, stage = null) {
  if (stage && !stage.ok && Number(stage.consecutiveFailures) > 0) return { latency: formatLatency(stage) };
  const trip = validationRoundTrip(status, serverId);
  if (trip?.ok && trip.durationMs > 0) return { latency: `往返 ${trip.durationMs}ms`, roundTripAt: trip.checkedAt };
  return { latency: "—" };
}

// 远端节点的副标题：有端口写「主机:端口」，没领端口写「主机 · 未领取端口」——绝不补一个默认端口号
//（旧版回落 7891，会让没领端口的人看到别人的端口像是自己的）。
export const UNCLAIMED_PORT_TEXT = "未领取端口";
function remoteSub(host, port) {
  return port != null ? `${host}:${port}` : `${host} · ${UNCLAIMED_PORT_TEXT}`;
}

// 连线状态跟随它下游的节点：下游中断 → 中断；下游未知 → 未知；下游未领端口（setup）→ 与手动断开同样画淡灰实线。
function linkStateOf(downstreamState, { run, waiting }) {
  if (!run) return "stopped";
  if (waiting) return "unknown";
  if (downstreamState === "setup") return "stopped";
  if (downstreamState === "error") return "error";
  if (downstreamState === "unknown") return "unknown";
  return "ok";
}

// 其余建了隧道的服务器（非查看中的那台）：每台一行「隧道 → 远端」。数据取 layers.tunnels[id]
//（tunnelUp / remotePortOpen 各为 true / false / null=未知）与 connectionTargets（主机与远端端口）。
// 本地代理没起来时，它们与主干一样被上游挡住（unknown），不各自报错。
function buildOtherTunnels(status, { run, waiting, proxyOk }) {
  const stages = status.bridgeStages || {};
  const tunnels = status.layers?.tunnels || {};
  const targets = status.connectionTargets?.servers || {};
  const activeId = status.activeServerId || null;
  const rows = [];
  for (const [serverId, entry] of Object.entries(tunnels)) {
    if (serverId === activeId || !entry || entry.tunnel === false) continue;
    let tunnelState;
    let remoteState;
    if (!run) {
      tunnelState = "stopped";
      remoteState = "stopped";
    } else if (waiting || !proxyOk) {
      tunnelState = "unknown";
      remoteState = "unknown";
    } else if (entry.setupPending === true) {
      // 这台还没领反向端口：隧道不会建，灰色「未领取端口」（layers.tunnels 的结构化标记）
      tunnelState = "setup";
      remoteState = "setup";
    } else if (entry.handoverStandby === true) {
      // 同账号另一台 Mac 在承载这台的端口、本机待命：集群照样出网，不是断开（v2.88）
      tunnelState = "ok";
      remoteState = entry.remotePortOpen === true ? "ok" : "unknown";
    } else {
      tunnelState = entry.tunnelUp === true ? "ok" : entry.tunnelUp === false ? "error" : "unknown";
      if (tunnelState !== "ok") remoteState = "unknown";
      else remoteState = entry.remotePortOpen === true ? "ok" : entry.remotePortOpen === false ? "error" : "unknown";
    }
    const target = targets[serverId] || {};
    const port = target.remotePort?.effective ?? target.remotePort?.configured ?? null;
    const serverName = serverShortName(status, serverId);
    rows.push({
      serverId,
      nodes: [
        { key: "tunnel", serverId, serverName, label: "隧道", sub: "SSH 反向通道", state: tunnelState, source: NODE_LOG_SOURCE.tunnel },
        { key: "remote", serverId, serverName, label: serverName, sub: remoteSub(target.host || serverId, port), state: remoteState, source: NODE_LOG_SOURCE.remote },
      ],
      links: [
        // bridgeStages 只有查看中那台的一份，不是这台报上来的就不标
        { key: "ssh-tunnel", state: linkStateOf(tunnelState, { run, waiting }), latency: stageLatencyFor(stages["ssh-tunnel"], serverId) },
        { key: "remote-port", state: linkStateOf(remoteState, { run, waiting }), ...roundTripLabel(status, serverId) },
      ],
    });
  }
  return rows;
}

// 构建链路模型（纯函数）。状态值：ok=绿 warn=黄 error=红 unknown=灰 stopped=灰(手动停止)
// setup=灰(还没领反向端口：隧道不会建，不是中断——v2.54 起这是同事装好后的正常初始状态)。
// nodes / links 是主干（查看中的服务器）；级联规则沿用原 topology.js：主干首个断点标红，其下游
// 节点/连线置灰(unknown)。otherTunnels 是其余服务器的隧道行（见 buildOtherTunnels）。
// phase 是主干的形态：stopped=手动断开 / probing=首轮探测中 / broken=某处中断 / setup=没领端口 / live=畅通。
// 节点的 unknown 在 probing 与 broken 下含义不同（等结果 vs 被上游挡住），靠 phase 区分画法。
export function buildChainModel(status) {
  const run = !!status.shouldBeRunning;
  const waiting = status.health === "waiting";
  const stages = status.bridgeStages || {};
  const server = status.activeServer || {};
  const localPort = server.localPort ?? 8888;
  const remotePort = server.remotePort ?? null;
  const host = server.host || "myserver";
  const activeId = status.activeServerId || server.id || null;
  // 远端节点写服务器的名字（多台并排时要分得清是哪台）；状态里还没有这台的名字时退回「远端」。
  const remoteLabel = activeId && status.serversBrief?.[activeId] ? serverShortName(status, activeId) : "远端";
  // 没领反向端口：后端 summary.transport.state === "setup"（通道层 setupPending）；旧载荷没有 summary 时
  // 按"要建隧道却没有端口、隧道也没起来"推断（与 checklist.js 横幅的判据一致）。
  const setup = run && !waiting && (status.summary?.transport?.state === "setup"
    || (Boolean(activeId) && server.tunnel !== false && remotePort == null && status.tunnelUp !== true));
  const standby = status.tunnelUp === true ? null : handoverStandbyOf(status, activeId);

  const trunkDefs = [
    { key: "mac", label: "Mac", sub: "本机客户端", up: run },
    { key: "proxy", label: "代理", sub: `本地代理 :${localPort}`, up: run && !!status.localProxyUp },
    // 本机待命（另一台 Mac 在承载，v2.88）：本机没有隧道进程，但这一段对集群来说是通的
    { key: "tunnel", label: "隧道", sub: "SSH 反向通道", up: run && (!!status.tunnelUp || Boolean(standby)), serverId: activeId },
    { key: "remote", label: remoteLabel, sub: remoteSub(host, remotePort), up: run && !!status.remotePortOpen, serverId: activeId },
  ];

  let broken = false;
  const nodes = trunkDefs.map((def, i) => {
    let state;
    if (!run) {
      state = "stopped";
    } else if (waiting) {
      state = "unknown";
    } else if (i === 0) {
      // Mac 节点自身不阻断链路；守护进程未开 = 降级(黄)
      state = status.supervisorUp ? "ok" : "warn";
    } else if (broken) {
      state = "unknown";
    } else if (setup && (def.key === "tunnel" || def.key === "remote")) {
      // 隧道与远端：没有端口就不会建，画成灰色「未领取端口」，不标红、不算断点
      state = "setup";
    } else if (def.up) {
      state = "ok";
    } else {
      state = "error";
      broken = true;
    }
    const node = { key: def.key, label: def.label, sub: def.sub, state, source: NODE_LOG_SOURCE[def.key] };
    if (def.key === "tunnel" && standby && state === "ok") node.standby = standby;
    if (def.serverId) {
      node.serverId = def.serverId;
      node.serverName = remoteLabel;
    }
    return node;
  });

  const linkLabels = [
    { latency: formatLatency(stages["local-proxy"]) },
    { latency: stageLatencyFor(stages["ssh-tunnel"], activeId) },
    roundTripLabel(status, activeId, stages["remote-port"]),
  ];
  const links = ["local-proxy", "ssh-tunnel", "remote-port"].map((stageKey, i) => ({
    key: stageKey,
    state: linkStateOf(nodes[i + 1].state, { run, waiting }),
    ...linkLabels[i],
  }));

  const phase = !run ? "stopped" : waiting ? "probing" : broken ? "broken" : setup ? "setup" : "live";
  const otherTunnels = buildOtherTunnels(status, { run, waiting, proxyOk: nodes[1].state === "ok" });
  return { nodes, links, phase, otherTunnels };
}

// 节点的选中标识：Mac / 代理只有一个，隧道 / 远端带上服务器 id（多行并存）。
export function nodeSelectionId(node) {
  return node.serverId ? `${node.key}@${node.serverId}` : node.key;
}

// 一行 = 一台服务器的「隧道 → 远端」。第一行是主干（查看中的那台）。
export function chainRows(model) {
  const trunk = { serverId: model.nodes[2]?.serverId || null, nodes: model.nodes.slice(2), links: model.links.slice(1) };
  return [trunk, ...(model.otherTunnels || [])];
}

function findNode(model, selectionId) {
  if (!selectionId) return null;
  const all = [...model.nodes, ...(model.otherTunnels || []).flatMap((row) => row.nodes)];
  return all.find((node) => nodeSelectionId(node) === selectionId) || null;
}

// ---- 请求之路（v2.65）：集群 ══SSH 隧道══ 本机代理 ── 出网 → 去向 ----

// 去向分组：按域名后缀归到三类，其余（含用量记录里的「其它」行）归「其它」。顺序只决定匹配先后，显示按流量排。
export const DESTINATION_GROUPS = Object.freeze([
  { key: "claude", name: "Claude", test: /(^|\.)(reclaude\.ai|anthropic\.com|claude\.ai)(:\d+)?$/ },
  { key: "openai", name: "OpenAI", test: /(^|\.)(openai\.com|chatgpt\.com|oaistatic\.com|oaiusercontent\.com)(:\d+)?$/ },
  {
    key: "deps",
    name: "代码与依赖",
    test: /(^|\.)(github\.com|githubusercontent\.com|pypi\.org|pythonhosted\.org|gitlab\.com|gitlab\.[a-z0-9.-]+|vtk\.org|npmjs\.org|npmjs\.com|huggingface\.co|hf\.co|anaconda\.org|anaconda\.com|conda\.io|pytorch\.org|nvidia\.com)(:\d+)?$/,
  },
]);
export const DESTINATION_OTHER = Object.freeze({ key: "other", name: "其它" });
export const ROAD_MAX_DESTINATIONS = 4;
const ACTIVE_RECENT_BYTES = 1; // 近一分钟有字节或新连接即算「正在传输」

const numOr0 = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

// /api/egress/usage → 去向分组（按上下行合计排，同量按连接数）。recording=false（口令模式为「关」不记录）时 groups 为空。
//   share：这一组占全部去向流量的比例；active：近一分钟（usage.recent 那一段）有新连接或字节。
export function groupDestinations(usage) {
  if (!usage || typeof usage !== "object") return { recording: null, since: null, totals: null, groups: [] };
  const recording = usage.recording !== false;
  const groups = new Map([...DESTINATION_GROUPS, DESTINATION_OTHER].map((g) => [g.key, { key: g.key, name: g.name, hosts: [] }]));
  const rawTargets = Array.isArray(usage.allTargets) ? usage.allTargets : usage.targets;
  const rawOther = usage.allOther !== undefined ? usage.allOther : usage.other;
  const rows = Array.isArray(rawTargets) ? rawTargets.filter((t) => t && typeof t.target === "string") : [];
  for (const row of rows) {
    const group = DESTINATION_GROUPS.find((g) => g.test.test(row.target.toLowerCase())) || DESTINATION_OTHER;
    groups.get(group.key).hosts.push(row);
  }
  if (rawOther && numOr0(rawOther.connections) + numOr0(rawOther.up) + numOr0(rawOther.down) > 0) {
    groups.get(DESTINATION_OTHER.key).hosts.push({ ...rawOther, target: null, targets: numOr0(rawOther.targets) });
  }
  const list = [...groups.values()].map((g) => {
    const sum = (k) => g.hosts.reduce((acc, h) => acc + numOr0(h[k]), 0);
    const recent = sum("recentConnections") + sum("recentUp") + sum("recentDown");
    return {
      key: g.key,
      name: g.name,
      hosts: g.hosts,
      connections: sum("connections"),
      up: sum("up"),
      down: sum("down"),
      lastAt: Math.max(0, ...g.hosts.map((h) => numOr0(h.lastAt))),
      active: recent >= ACTIVE_RECENT_BYTES,
    };
  }).filter((g) => g.connections > 0 || g.up + g.down > 0);
  const total = list.reduce((acc, g) => acc + g.up + g.down, 0);
  for (const g of list) g.share = total > 0 ? (g.up + g.down) / total : 0;
  list.sort((a, b) => (b.up + b.down) - (a.up + a.down) || b.connections - a.connections);
  const totals = usage.totals && typeof usage.totals === "object"
    ? { connections: numOr0(usage.totals.connections), up: numOr0(usage.totals.up), down: numOr0(usage.totals.down) }
    : null;
  return { recording, since: Number.isFinite(usage.since) ? usage.since : null, totals, groups: recording ? list : [] };
}

// 近一分钟流量档位：usage.recent 是控制面看到的用量文件相邻两版之差（文件 150 秒没重写 = 空闲 = null）。
//   busy：> 400 KB/s；low：有新连接或字节；idle：其余。档位决定每段光点数（Kiali：密度 = 流量）。
export const TRAFFIC_BUSY_BPS = 400_000;
export function trafficOf(usage) {
  const recent = usage?.recent;
  if (!recent || !Number.isFinite(recent.fromAt) || !Number.isFinite(recent.toAt) || recent.toAt <= recent.fromAt) {
    return { level: "idle", bps: 0 };
  }
  const bytes = numOr0(recent.up) + numOr0(recent.down);
  const bps = bytes / ((recent.toAt - recent.fromAt) / 1000);
  const level = bps > TRAFFIC_BUSY_BPS ? "busy" : bytes > 0 || numOr0(recent.connections) > 0 ? "low" : "idle";
  return { level, bps };
}

export function formatRate(bps) {
  const v = numOr0(bps);
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB/s`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} KB/s`;
  return `${Math.round(v)} B/s`;
}

// 端到端往返：环境校验每 5 分钟一次的 proxyLatencyMs（集群经整条链路访问外网的一次往返）。
// /api/metrics?kind=validation 的样本 → [{ ts, ms }]（只留近 24 小时、正数）。
export const TRIP_WINDOW_MS = 86_400_000;
export function tripSamples(samples, nowMs = Date.now()) {
  const from = nowMs - TRIP_WINDOW_MS;
  return (Array.isArray(samples) ? samples : [])
    .filter((s) => s && Number.isFinite(s.ts) && s.ts > from && Number(s.proxyLatencyMs) > 0)
    .map((s) => ({ ts: s.ts, ms: Math.round(Number(s.proxyLatencyMs)) }))
    .sort((a, b) => a.ts - b.ts);
}

// 走势线：近 24 小时按 30 分钟分桶取中位（原始 5 分钟一个点，直接连线太毛）；空桶处断开（电脑休眠 / 隧道断）。
// 坐标系 w×h（preserveAspectRatio="none" 拉伸），纵轴从 0 到 max(200ms, 最高桶 × 1.1)。
export const TRIP_BINS = 48;
export function tripSpark(trips, { nowMs = Date.now(), w = 120, h = 20 } = {}) {
  const start = nowMs - TRIP_WINDOW_MS;
  const binMs = TRIP_WINDOW_MS / TRIP_BINS;
  const bins = Array.from({ length: TRIP_BINS }, () => []);
  for (const t of trips || []) {
    if (t.ts < start || t.ts > nowMs) continue;
    bins[Math.min(TRIP_BINS - 1, Math.floor((t.ts - start) / binMs))].push(t.ms);
  }
  const median = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null);
  const meds = bins.map(median);
  const all = (trips || []).filter((t) => t.ts >= start).map((t) => t.ms);
  const last = trips?.length ? trips[trips.length - 1] : null;
  const vals = meds.filter((v) => v != null);
  if (vals.length < 2) return { line: "", area: "", median: median(all), last };
  const max = Math.max(200, ...vals) * 1.1;
  let line = "";
  let area = "";
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const d = run.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
      line += d;
      area += `${d}L${run[run.length - 1][0].toFixed(1)} ${h}L${run[0][0].toFixed(1)} ${h}Z`;
    }
    run = [];
  };
  meds.forEach((v, i) => {
    if (v == null) flush();
    else run.push([((i + 0.5) / TRIP_BINS) * w, h - 1 - (v / max) * (h - 3)]);
  });
  flush();
  return { line, area, median: median(all), last };
}

// 隧道段光点的周期按到集群的 SSH 往返分三档（Kiali：越快的段跑得越快）。远端端口探测是一次完整的 SSH 执行，
// 平时在 80–400ms；分档、并由 chain.js 用最近几次的中位数喂进来，免得一两次抖动就改时长让光点跳位。
export function hopDuration(latencyText) {
  const ms = Number.parseInt(latencyText, 10);
  if (!Number.isFinite(ms)) return 1.9;
  return ms < 150 ? 1.3 : ms < 400 ? 1.9 : 2.8;
}

// 在线 / 断开时长写到分钟（一小时内写秒的话，每帧状态都会让文案跳一下）；不到一分钟返回 null，由调用处写「刚…」。
function coarseDuration(ms) {
  return ms < 60_000 ? null : humanDuration(Math.floor(ms / 60_000) * 60_000);
}

const shortHost = (upstream) => String(upstream || "").replace(/^(127\.0\.0\.1|localhost)(?=:)/, "");

// 出网节点：/api/status.egressHealth（控制面每 30 秒连一次上游 + 统计代理的 connect-fail）。
// 上游被挡住（通道停 / 首轮探测 / 本地代理没起来）时与主干一样不各自报错。
function egressNodeOf(status, { run, waiting, proxyState }) {
  const health = status.egressHealth && typeof status.egressHealth === "object" ? status.egressHealth : null;
  const mode = health?.mode || null;
  const upstream = health?.upstream || null;
  let state;
  if (!run) state = "stopped";
  else if (waiting || proxyState !== "ok" || !health) state = "unknown";
  else state = { ok: "ok", warn: "warn", error: "error" }[health.state] || "unknown";
  const sub = mode === "manual" || mode === "system"
    ? (upstream ? `上游 ${shortHost(upstream)}` : mode === "system" ? "系统代理" : "上游代理")
    : mode === "direct" ? "直连" : "—";
  return { key: "egress", label: "出网", sub, state, mode, upstream, health, select: "egress" };
}

const REASON_TEXT = { refused: "拒绝连接", timeout: "超时", rejected: "上游回绝", other: "失败" };
export function failureReasonClass(reason) {
  const r = String(reason || "");
  if (/refused/i.test(r)) return "refused";
  if (/timed?out/i.test(r)) return "timeout"; // upstream-timeout / timeout / ETIMEDOUT
  if (/rejected/i.test(r)) return "rejected";
  return "other";
}

// 断点原因（参照阿里云 NIS：断点处直接写一句为什么、影响什么）。优先级：停止 > 检测中 > 没领端口 > 本机代理 >
// 隧道 > 集群端口 > 出网中断 > 出网目标失败 > 守护进程。没有要说的返回 null。
export function roadCause(road, status, { nowMs = Date.now(), stability = null } = {}) {
  const { phase, cluster, tunnel, proxy, egress } = road;
  const localPort = status.activeServer?.localPort ?? 8888;
  if (phase === "stopped") return { tone: "neutral", text: "通道已手动停止：集群上的程序现在不能经这条链路出网" };
  if (phase === "probing") return { tone: "neutral", text: "正在检查  本机代理 → SSH 隧道 → 集群端口 → 出网" };
  if (phase === "setup") return { tone: "neutral", text: "这台还没领取反向端口，隧道不会建立；在终端运行配置向导领取后再启动" };
  if (proxy.state === "error") return { tone: "critical", text: `本机代理 :${localPort} 没有在监听${status.supervisorUp ? "，正在自动拉起" : ""}；集群此刻无法出网` };
  if (tunnel.nodeState === "error") {
    const entry = stability?.servers?.[cluster.serverId];
    const down = entry?.state === "down" && entry.since ? coarseDuration(nowMs - entry.since) : undefined;
    const head = down === undefined ? "SSH 隧道断开" : down === null ? "SSH 隧道刚断开" : `SSH 隧道断开 ${down}`;
    return { tone: "critical", text: `${head}${status.supervisorUp ? "，正在自动重连" : ""}；期间集群上的 codex / claude 无法出网` };
  }
  if (cluster.state === "error") {
    const port = status.activeServer?.remotePort;
    return { tone: "critical", text: `集群端口${port != null ? ` :${port}` : ""} 没有在监听，可能被占用或隧道没有拉通` };
  }
  const health = egress.health;
  if (egress.state === "error") {
    const target = egress.upstream ? `上游 ${shortHost(egress.upstream)}` : "出网";
    const why = health?.reason === "upstream-timeout" ? "连接超时" : health?.reason === "upstream-refused" ? "拒绝连接" : "连不上";
    return { tone: "critical", text: `出网中断：${target} ${why}（上游代理可能没在运行），集群此刻访问不了外网` };
  }
  if (egress.state === "warn") {
    const f = health?.failures || {};
    const top = Array.isArray(f.topHosts) && f.topHosts[0]?.host ? f.topHosts[0].host : "";
    const last = f.last ? REASON_TEXT[failureReasonClass(f.last.reason)] : "";
    return { tone: "warn", text: `近 10 分钟有 ${numOr0(f.total)} 次出网失败${top ? `，最多的是 ${top}` : ""}${last ? `（最近一次：${last}）` : ""}` };
  }
  if (road.supervisorDown) return { tone: "warn", text: "守护进程没有在运行：现在还能用，但断线后不会自动恢复" };
  if (phase === "live") {
    const activeSignals = Array.isArray(status.layers?.signals?.active) ? status.layers.signals.active : [];
    const agents = [
      ...Object.values(status.agentsStatus && typeof status.agentsStatus === "object" ? status.agentsStatus : {}),
      ...Object.values(status.layers?.agents && typeof status.layers.agents === "object" ? status.layers.agents : {}),
    ];
    const hasAccountFault = agents.some((a) => a && (a.accountFault === "revoked" || a.accountFault === "banned" || a.health === "revoked" || a.health === "banned" || a.expiry?.level === "expired"))
      || activeSignals.some((s) => s && (s.id === "account-revoked" || s.id === "account-banned"));
    if (hasAccountFault) {
      return { tone: "warn", text: "链路与出网畅通，但检测到账号或凭证异常（需在服务器重新登录或更换账号，重启隧道无效）" };
    }
    const rateSig = activeSignals.find((s) => s && s.id === "rate-limited");
    if (rateSig) {
      return { tone: "warn", text: "链路与出网畅通，但近期触发上游 API 限流（429 / 配额限制），稍后自行恢复，无需重启隧道" };
    }
    const sig5xx = activeSignals.find((s) => s && s.id === "http-5xx");
    if (sig5xx) {
      return { tone: "warn", text: "链路与出网畅通，但近期上游 API 返回 5xx 服务端错误（服务端抖动），无需重启隧道" };
    }
  }
  return null;
}

// 请求之路的整份模型（纯函数）。usage = /api/egress/usage（没拉到为 null）；trips = tripSamples() 的结果。
// tunnelMs：最近几次远端端口探测耗时的中位数（chain.js 维护），只用来定隧道段光点的速度档；没有时按这一次的。
export function buildRoadModel(status, { usage = null, trips = [], stability = null, nowMs = Date.now(), tunnelMs = null } = {}) {
  const chain = buildChainModel(status);
  const [mac, proxyNode, tunnelNode, remoteNode] = chain.nodes;
  const run = !!status.shouldBeRunning;
  const waiting = status.health === "waiting";
  const sid = remoteNode.serverId || null;
  const stages = status.bridgeStages || {};
  const server = status.activeServer || {};
  const entry = stability?.servers?.[sid] || null;

  const tunnelLatency = stageLatencyFor(stages["remote-port"], sid);
  const reconnecting = status.supervisorUp ? " · 重连中" : "";
  let note;
  if (tunnelNode.state === "ok" && remoteNode.state === "error") note = "隧道在线 · 集群端口不通";
  else if (tunnelNode.standby) note = handoverNote(tunnelNode.standby, status.connectionTargets?.machine);
  else if (tunnelNode.state === "ok") {
    const up = entry?.state === "up" && entry.since ? coarseDuration(nowMs - entry.since) : undefined;
    note = up === undefined ? "在线" : up === null ? "刚上线" : `在线 ${up}`;
  } else if (tunnelNode.state === "error") {
    const down = entry?.state === "down" && entry.since ? coarseDuration(nowMs - entry.since) : undefined;
    note = `${down === undefined ? "断开" : down === null ? "刚断开" : `断开 ${down}`}${reconnecting}`;
  } else if (tunnelNode.state === "stopped") note = "已停止";
  else if (tunnelNode.state === "setup") note = UNCLAIMED_PORT_TEXT;
  else note = chain.phase === "probing" ? "检测中…" : "等待上游";
  // 管子的状态 = 隧道与远端端口两段里更坏的那段（任一中断即中断）
  const [, toTunnel, toRemote] = chain.links;
  const pair = [toTunnel.state, toRemote.state];
  const pipeState = pair.includes("error") ? "error" : pair.every((s) => s === "ok") ? "ok" : pair.includes("unknown") ? "unknown" : "stopped";

  const egress = egressNodeOf(status, { run, waiting, proxyState: proxyNode.state });
  const egressLinkState = egress.state === "error" ? "error"
    : proxyNode.state === "ok" ? (egress.state === "unknown" ? "unknown" : "ok")
      : proxyNode.state === "stopped" ? "stopped" : "unknown";
  const checkMs = egress.health?.check?.ok && Number.isFinite(egress.health.check.ms) ? `${egress.health.check.ms}ms` : "—";

  const broken = chain.phase === "broken" || (chain.phase === "live" && egress.state === "error");
  const phase = chain.phase === "live" && broken ? "broken" : chain.phase;
  const destinations = groupDestinations(usage);
  // 流量只在整条路通着时才算数：断开期间用量文件可能还在报上一分钟的增量
  const traffic = phase === "live" && egress.state !== "error" ? trafficOf(usage) : { level: "idle", bps: 0 };
  if (traffic.level === "idle") for (const g of destinations.groups) g.active = false;

  const road = {
    phase,
    traffic,
    supervisorDown: run && !waiting && mac.state === "warn",
    cluster: {
      key: "remote",
      serverId: sid,
      label: remoteNode.label,
      sub: remoteNode.sub,
      state: remoteNode.state,
      select: sid ? `remote@${sid}` : "remote",
    },
    tunnel: {
      key: "tunnel",
      serverId: sid,
      state: pipeState,
      nodeState: tunnelNode.state,
      // 不通时不留上一次的毫秒数（读起来像还通着）；探针连败时照样写「失败×N」
      latency: pipeState === "ok" || tunnelLatency.startsWith("失败") ? tunnelLatency : "—",
      note,
      dur: hopDuration(Number.isFinite(tunnelMs) ? `${tunnelMs}ms` : tunnelLatency),
      select: sid ? `tunnel@${sid}` : "tunnel",
    },
    proxy: {
      key: "proxy",
      label: "本机代理",
      sub: `127.0.0.1:${server.localPort ?? 8888}`,
      state: proxyNode.state, // 守护进程没运行不改代理的颜色，只出角标 + 原因行（supervisorDown）
      select: "proxy",
    },
    egressLink: { state: egressLinkState, latency: checkMs },
    egress,
    destinations,
    trips,
    others: (chain.otherTunnels || []).map((row) => {
      const [t, r] = row.nodes;
      const state = t.state === "ok" && r.state === "ok" ? "ok" : t.state === "error" || r.state === "error" ? "error"
        : [t.state, r.state].includes("stopped") ? "stopped" : [t.state, r.state].includes("setup") ? "setup" : "unknown";
      return { serverId: row.serverId, name: r.label, state, select: `tunnel@${row.serverId}` };
    }),
  };
  road.cause = roadCause(road, status, { nowMs, stability });
  return road;
}

// ---- 节点详情（纯函数）：一句结论 + 几条事实 ----

const DAY_MS = 86_400_000;

// 一条事实。value 是片段数组：字符串原样显示，{ b } 加重（次数 / 端口 / 耗时这类要一眼看到的值）。
const fact = (label, value, tone = "") => ({ label, value: Array.isArray(value) ? value : [value], tone });

// 端口映射：-R [bind:]远端端口:本机地址:本机端口（连接目标里的签名或隧道进程命令行）。
export function parseForward(text) {
  const m = /-R\s+(?:([\d.]+):)?(\d+):[^:\s]+:(\d+)/.exec(String(text || ""));
  return m ? { bind: m[1] || "", remotePort: Number(m[2]), localPort: Number(m[3]) } : null;
}

// 心跳参数取自隧道进程的实际命令行（团队隧道与个人服务器的次数不同）。
export function parseKeepalive(command) {
  const interval = Number(/ServerAliveInterval=(\d+)/.exec(String(command || ""))?.[1]);
  const count = Number(/ServerAliveCountMax=(\d+)/.exec(String(command || ""))?.[1]);
  return interval > 0 && count > 0 ? { interval, count } : null;
}

function forwardOf(status, serverId) {
  const target = status.connectionTargets?.servers?.[serverId];
  const proc = status.processes?.tunnelsByServer?.[serverId]?.[0];
  return parseForward(target?.signature) || parseForward(proc?.command);
}

function unknownDesc(phase, blockedText) {
  return phase === "probing" ? "正在检测…" : blockedText;
}

function tunnelDetail(status, node, context) {
  const standby = node.state === "ok" ? (node.standby || handoverStandbyOf(status, node.serverId)) : null;
  if (standby) return standbyTunnelDetail(status, node, standby);
  return activeTunnelDetail(status, node, context);
}

// 本机待命（另一台 Mac 在承载）的隧道详情：说清楚由谁承载，给「让这台承载」。
function standbyTunnelDetail(status, node, standby) {
  const sid = node.serverId;
  const view = handoverDetail(standby, status.connectionTargets?.machine);
  const facts = view.facts.map((item) => fact(item.label, item.value, item.tone || ""));
  if (view.reason) facts.push(fact("说明", view.reason));
  const forward = forwardOf(status, sid);
  const port = forward?.remotePort ?? status.connectionTargets?.servers?.[sid]?.remotePort?.configured ?? null;
  if (port != null) facts.push(fact("共用端口", [{ b: `:${port}` }, "（两台 Mac 都配这个端口，集群 env.sh 不用改）"]));
  return {
    title: `隧道 · ${node.serverName || sid}`,
    desc: view.desc,
    facts,
    navigate: "stability",
    takeover: canTakeOver(status, sid) ? sid : null,
  };
}

function activeTunnelDetail(status, node, { stability, nowMs, phase }) {
  const sid = node.serverId;
  const entry = stability?.servers?.[sid] || null;
  const proc = status.processes?.tunnelsByServer?.[sid]?.[0] || null;
  const sinceText = entry?.since ? humanDuration(nowMs - entry.since) : "";
  const desc = {
    ok: entry?.state === "up" && sinceText ? `SSH 反向通道在线 ${sinceText}` : "SSH 反向通道在线",
    error: `断开中${entry?.state === "down" && sinceText ? `，已 ${sinceText}` : ""}${status.supervisorUp ? "，正在自动重连" : ""}`,
    stopped: "通道已手动停止",
    setup: "还没领取反向端口，这台的隧道不会建立；在终端运行配置向导领取后再启动",
  }[node.state] || unknownDesc(phase, "上游没有就绪，隧道状态未知");

  const facts = [];
  const window24 = entry?.windows?.["24h"];
  if (window24) {
    const young = Number.isFinite(stability.since) && nowMs - stability.since < DAY_MS;
    facts.push(fact(
      young ? `自 ${shortDateTime(stability.since)} 起` : "近 24 小时",
      [{ b: String(Number(window24.drops) || 0) }, " 次断线 · 可用率 ", { b: availabilityText(window24.availability) }],
      window24.drops > 0 ? "warn" : "",
    ));
    const last = entry.lastDrop;
    facts.push(fact("最近一次断线", last
      ? `${shortDateTime(last.at)} ${causeLabel(last.cause)} · ${last.recoveredAt ? `${humanDuration(last.downMs)}后恢复` : "尚未恢复"}`
      : "记录以来没有断线"));
  }
  const forward = forwardOf(status, sid);
  if (forward) facts.push(fact("端口映射", ["远端 ", { b: `:${forward.remotePort}` }, " → 本机 ", { b: `:${forward.localPort}` }]));
  const keepalive = parseKeepalive(proc?.command);
  if (keepalive) facts.push(fact("心跳", `每 ${keepalive.interval} 秒，连续 ${keepalive.count} 次无响应判定断线（约 ${keepalive.interval * keepalive.count} 秒）`));
  if (proc) facts.push(fact("进程", `ssh · pid ${proc.pid}`));
  else if (node.state !== "stopped" && node.state !== "setup") facts.push(fact("进程", [{ b: "未找到隧道进程" }], "critical"));
  return { title: `隧道 · ${node.serverName || sid}`, desc, facts, navigate: "stability" };
}

function remoteDetail(status, node, { nowMs, phase }) {
  const sid = node.serverId;
  const target = status.connectionTargets?.servers?.[sid] || {};
  const forward = forwardOf(status, sid);
  const port = forward?.remotePort ?? target.remotePort?.effective ?? target.remotePort?.configured ?? (sid === status.activeServerId ? status.activeServer?.remotePort ?? null : null);
  const portText = port != null ? ` :${port}` : "端口";
  // 没有任何端口（运行快照、配置都给不出）= 还没领取反向端口：隧道根本不会建，单独说清楚。
  const desc = port == null && node.state !== "stopped"
    ? "还没领取反向端口，这台的隧道不会建立；在终端运行配置向导领取后再启动"
    : {
      ok: `远端${portText} 监听中，服务器上的程序经它出网`,
      error: `远端${portText} 没有在监听，可能端口被占用或隧道没有拉通`,
      stopped: "通道已手动停止",
    }[node.state] || unknownDesc(phase, "隧道没有就绪，远端端口状态未知");

  const facts = [];
  if (port != null) {
    const bind = forward?.bind || "";
    facts.push(fact("远端监听", [bind ? `${bind}` : "", { b: `:${port}` }, bind === "127.0.0.1" ? "（只对服务器本机开放）" : ""]));
  } else {
    facts.push(fact("远端监听", [{ b: UNCLAIMED_PORT_TEXT }], "warn"));
  }
  const trip = validationRoundTrip(status, sid);
  const validation = status.layers?.validation?.[sid] || null;
  if (trip) {
    const when = trip.checkedAt ? ` · ${formatRelativeTime(trip.checkedAt, nowMs)}校验` : "";
    facts.push(trip.ok
      ? fact("经隧道往返", [{ b: `${trip.durationMs}ms` }, when])
      : fact("经隧道往返", [{ b: "没有走通" }, when], "critical"));
  } else {
    facts.push(fact("经隧道往返", port == null ? "未领取端口，没有经隧道的出网测试" : "这台没有配置环境校验"));
  }
  // 环境校验：汇总一格（失败时标红），逐项清单在详情下方（chain.js 的 chain-checks，失败项置顶并附输出）
  const items = Array.isArray(validation?.items) ? validation.items.filter((it) => it && typeof it.key === "string") : [];
  let checks = null;
  if (items.length) {
    const summary = buildValidationSummary(items);
    const when = validation.checkedAt ? ` · ${formatRelativeTime(validation.checkedAt, nowMs)}` : "";
    facts.push(fact("环境校验", [{ b: buildValidationSummaryLabel(summary) }, when], summary.allOk ? "" : "critical"));
    checks = sortValidationItems(items).map((it) => (it.skipped
      ? { key: it.key, ok: true, skipped: true, durationMs: 0, output: it.skipped === "missing-port" ? UNCLAIMED_PORT_TEXT : "已跳过" }
      : { key: it.key, ok: it.ok !== false, durationMs: Number(it.durationMs) || 0, output: it.ok === false ? String(it.output || "") : "" }));
  } else if (validation?.reason) {
    facts.push(fact("环境校验", String(validation.reason), validation.level === "critical" ? "critical" : validation.level === "warn" ? "warn" : ""));
  }
  const brief = status.serversBrief?.[sid];
  if (brief && brief.ok !== false && [brief.cpu, brief.ram, brief.disk].some((v) => Number.isFinite(Number(v)) && v != null)) {
    const pctOf = (v) => (v == null || !Number.isFinite(Number(v)) ? "—" : `${Number(v)}%`);
    facts.push(fact("资源", `CPU ${pctOf(brief.cpu)} · 内存 ${pctOf(brief.ram)} · 磁盘 ${pctOf(brief.disk)}`));
  }
  const host = target.host || (sid === status.activeServerId ? status.activeServer?.host : "") || "";
  return { title: [node.serverName || node.label, host].filter(Boolean).join(" · "), desc, facts, checks, navigate: "servers" };
}

// 本机代理（v2.65 起 Mac 节点并进来）：代理自身的监听与探测 + 守护进程 + 服务的隧道。
function proxyDetail(status, node, { model, phase }) {
  const run = !!status.shouldBeRunning;
  const stage = status.bridgeStages?.["local-proxy"] || null;
  const localPort = status.activeServer?.localPort ?? 8888;
  const desc = !status.supervisorUp && run && node.state === "ok"
    ? "守护进程没有在运行：现有连接还能用，但断线后不会自动恢复"
    : {
      ok: "集群发出的请求经隧道到这里，再由它送上互联网",
      error: `本机 :${localPort} 上的代理没有在监听${status.supervisorUp ? "，正在自动拉起" : ""}`,
      stopped: "通道已手动停止，守护进程不再拉起代理和隧道",
    }[node.state] || unknownDesc(phase, "正在等待本地代理的探测结果");
  const facts = [fact("监听", ["127.0.0.1", { b: `:${localPort}` }])];
  if (stage && (stage.lastSuccessAt != null || Number(stage.consecutiveFailures) > 0)) {
    const total = Number(stage.checks) > 0 ? ` · 累计探测 ${Number(stage.checks).toLocaleString("en-US")} 次` : "";
    facts.push(stage.ok
      ? fact("探测", [{ b: `${Number(stage.durationMs) || 0}ms` }, total])
      : fact("探测", [{ b: `连续失败 ${Number(stage.consecutiveFailures) || 0} 次` }, total], "critical"));
  }
  const supervisor = status.processes?.supervisor?.[0];
  facts.push(status.supervisorUp
    ? fact("守护进程", `运行中${supervisor?.pid ? ` · pid ${supervisor.pid}` : ""}`)
    : fact("守护进程", [{ b: "未运行" }], run ? "warn" : ""));
  const rows = chainRows(model).filter((row) => row.serverId);
  if (rows.length) {
    const online = rows.filter((row) => row.nodes[0].state === "ok").length;
    const names = rows.map((row) => row.nodes[0].serverName || row.serverId);
    facts.push(fact("服务的隧道", [{ b: `${online} / ${rows.length}` }, ` 条在线 · ${names.join("、")}`], run && online < rows.length ? "warn" : ""));
  }
  const proc = status.processes?.localProxy?.[0];
  if (proc?.pid) facts.push(fact("进程", `pid ${proc.pid}`));
  return { title: "本机代理", desc, facts, navigate: null };
}

const fmtBytes = (n) => formatBytes(numOr0(n), { compact: true });
const MODE_TEXT = { manual: "手动指定的上游代理", system: "跟随系统代理", direct: "直连（不经上游代理）" };

// 出网详情：方式与上游、上游探测、近 10 分钟建连失败（按原因 / 目标）。
function egressDetail(road, { nowMs }) {
  const { egress } = road;
  const health = egress.health;
  const upstream = egress.upstream ? shortHost(egress.upstream) || egress.upstream : "";
  const desc = {
    ok: "本机代理把集群的请求经这里送上互联网",
    warn: "上游在，但去部分目标的连接在失败",
    error: road.cause?.tone === "critical" ? road.cause.text : "出网中断，集群此刻访问不了外网",
    stopped: "通道已手动停止",
  }[egress.state] || (health ? "上游没有就绪，出网状态未知" : "还没有出网探测结果");
  const facts = [];
  facts.push(fact("出网方式", [MODE_TEXT[egress.mode] || "未知", upstream ? " · " : "", upstream ? { b: egress.upstream } : ""]));
  const check = health?.check;
  if (check) {
    const when = Number.isFinite(check.at) ? ` · ${formatRelativeTime(check.at, nowMs)}` : "";
    facts.push(check.ok
      ? fact("上游探测", [{ b: Number.isFinite(check.ms) ? `${check.ms}ms` : "通" }, when, " · 每 30 秒连一次上游端口"])
      : fact("上游探测", [{ b: REASON_TEXT[failureReasonClass(check.error)] || "连不上" }, when], "critical"));
  } else if (egress.mode === "direct") {
    facts.push(fact("上游探测", "直连没有上游，按实际建连失败判断"));
  }
  const f = health?.failures;
  if (f) {
    const total = numOr0(f.total);
    const parts = ["refused", "timeout", "rejected", "other"].filter((k) => numOr0(f[k]) > 0).map((k) => `${REASON_TEXT[k]} ${numOr0(f[k])}`);
    facts.push(fact("近 10 分钟建连失败", total ? [{ b: String(total) }, ` 次 · ${parts.join(" · ")}`] : "没有", total >= 3 ? "warn" : ""));
    if (Array.isArray(f.topHosts) && f.topHosts.length) {
      facts.push(fact("失败最多的目标", f.topHosts.slice(0, 3).map((h) => `${h.host} ×${numOr0(h.count)}`).join("、")));
    }
    if (f.last) {
      facts.push(fact("最近一次失败", `${f.last.host || "（目标名不合规）"}${f.last.port ? `:${f.last.port}` : ""} · ${REASON_TEXT[failureReasonClass(f.last.reason)]} · ${formatRelativeTime(f.last.at, nowMs)}`));
    }
  }
  const { traffic } = road;
  if (road.destinations.recording) facts.push(fact("近一分钟", traffic.level === "idle" ? "空闲" : [{ b: formatRate(traffic.bps) }]));
  return { title: "出网", desc, facts, state: egress.state, navigate: "egress" };
}

// 去向详情：这一组里流量最多的几个目标（连接数 / 上下行 / 最近一次）。
function destinationDetail(road, key, { nowMs }) {
  const group = road.destinations.groups.find((g) => g.key === key);
  if (!group) return null;
  const pct = group.share < 0.1 ? (group.share * 100).toFixed(1) : Math.round(group.share * 100);
  const facts = [...group.hosts]
    .sort((a, b) => (numOr0(b.up) + numOr0(b.down)) - (numOr0(a.up) + numOr0(a.down)))
    .slice(0, 8)
    .map((h) => fact(
      h.target ? String(h.target).replace(/:443$/, "") : `另 ${numOr0(h.targets)} 个目标`,
      [{ b: `${numOr0(h.connections)} 次` }, ` · ↑${fmtBytes(h.up)} ↓${fmtBytes(h.down)}${h.lastAt ? ` · ${formatRelativeTime(h.lastAt, nowMs)}` : ""}`],
    ));
  const desc = `${group.connections} 次连接 · ↑${fmtBytes(group.up)} ↓${fmtBytes(group.down)} · 占去向流量的 ${pct}%${group.active ? " · 正在传输" : ""}`;
  return { title: `去向 · ${group.name}`, desc, facts, state: "ok", navigate: "egress" };
}

// 选中节点的详情模型。stability = /api/tunnel-stability（没拉到时隧道详情只是少两条断线统计）。
// diag = 查看中的这条链不正常时的整链诊断（现象 + 下一步）；其余服务器的行不附。
export function buildChainDetail(status, model, selectionId, { stability = null, nowMs = Date.now(), usage = null } = {}) {
  if (selectionId === "egress" || String(selectionId || "").startsWith("dest:")) {
    const road = buildRoadModel(status, { usage, stability, nowMs });
    const body = selectionId === "egress" ? egressDetail(road, { nowMs }) : destinationDetail(road, selectionId.slice(5), { nowMs });
    if (!body) return null;
    return { ...body, logSource: "supervisor", switchTo: null, diag: null }; // 代理的建连失败落在 supervisor 日志
  }
  const node = findNode(model, selectionId);
  if (!node) return null;
  const onTrunk = model.nodes.includes(node);
  const phase = onTrunk ? model.phase : status.health === "waiting" ? "probing" : "live";
  const context = { stability, nowMs, phase, model };
  const body = node.key === "tunnel" ? tunnelDetail(status, node, context)
    : node.key === "remote" ? remoteDetail(status, node, context)
      : proxyDetail(status, model.nodes[1], context); // Mac 节点已并进本机代理（旧的选中 id "mac" 也落到这里）
  const needsDiag = onTrunk && status.health !== "ready" && status.health !== "waiting";
  const diag = needsDiag ? getDiagnosticMsg(status) : null;
  return {
    ...body,
    state: node.key === "mac" ? model.nodes[1].state : node.state,
    logSource: node.source || "ops",
    switchTo: node.serverId && status.activeServerId && node.serverId !== status.activeServerId ? node.serverId : null,
    diag: diag ? { title: diag.title, body: diag.body } : null,
  };
}
