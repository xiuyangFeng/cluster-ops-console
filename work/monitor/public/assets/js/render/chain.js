// chain.js —— 数据链路「请求之路」（v2.65）：集群 ══SSH 隧道══ 本机代理 ── 出网 → 去向。
// 方向按请求真实的走向画：集群上的 codex / claude 经 :7891 → 反向隧道 → 本机代理 → 出网（上游代理或直连）→ 互联网。
// 此前（v2.35–v2.64）画的是 Mac → 代理 → 隧道 → 远端，没有出网段：上游代理退出时链路全绿、集群其实断网。
// 隧道是一条边（双线管子 + 锁），不是节点；Mac 并进本机代理（守护进程没运行时代理圆上出黄角标）。
// 出网之后按去向分叉到最多 4 张卡（曲线粗细 = 流量占比）；其余建了隧道的服务器在路径下方一行小标签。
// 动效全部绑真实数据：近一分钟有流量才有光点（密度 = 流量档位，隧道段速度 = 探针延迟档位）；远端端口探针每返回
// 一次沿隧道送一个回声；链路不畅通时曲线区换成一句断点原因。只动 transform / opacity，在 reduced-motion 守卫内，
// 窗口隐藏时被 styles.css 的省电闸整体暂停。数据模型与详情模型是纯函数，在 chain-model.js。
import { createElementLookup, morphInnerHtml } from "../dom-utils.js";
import { escapeHtml, formatBytes } from "../store.js";
import { buildChainDetail, buildChainModel, buildRoadModel, formatRate, ROAD_MAX_DESTINATIONS, tripSamples, tripSpark } from "./chain-model.js";
import { createMemoRender, timeBucket } from "./render-skip.js";

const getEl = createElementLookup();

// ---- 渲染 ----

let selectedId = null;
let bound = false;
let lastStatus = null; // 供点击后立即重绘详情
let stabilityStats = null; // /api/tunnel-stability，由概览的稳定性轮询顺带送来（setChainStability）
let usageData = null; // /api/egress/usage（app/chain-traffic-controller.js 送来）
let tripsData = []; // 环境校验的端到端往返样本 [{ ts, ms }]
let tripsServer = null; // 这份往返样本是哪台服务器的（切换查看后旧的不再显示）
let tripsAsked = null; // 已经为哪台服务器请求过往返样本（每台只催一次）
let usageSig = ""; // 上一份 /api/egress/usage 的序列化，没变就不重绘
const tunnelSamples = []; // 最近几次远端端口探测耗时，取中位数定隧道段光点的速度档
const TUNNEL_SAMPLES = 7;
let dataVersion = 0; // 上面三份旁路数据每变一次 +1，进渲染签名
let handlers = { onNavigate: null, onSwitchServer: null, onOpenEgress: null, onNeedTrips: null };

// 节点图标（24 网格，描边随 currentColor）：集群 / 本机代理 / 出网；隧道管子中间的锁
const ICONS = {
  remote: '<rect x="4" y="4" width="16" height="7" rx="1.6"/><rect x="4" y="13" width="16" height="7" rx="1.6"/><path d="M7.8 7.5h.01M7.8 16.5h.01"/>',
  proxy: '<path d="M4 8.5h13.5M14.5 5.5l3 3-3 3M20 15.5H6.5M9.5 12.5l-3 3 3 3"/>',
  egress: '<circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4M12 3.8c2.3 2.4 3.4 5.1 3.4 8.2s-1.1 5.8-3.4 8.2c-2.3-2.4-3.4-5.1-3.4-8.2s1.1-5.8 3.4-8.2z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
};
const icon = (name, cls) => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const STATE_TEXT = { ok: "正常", warn: "降级", error: "中断", unknown: "未知", stopped: "已断开", setup: "未领取端口" };
const stateText = (state, phase) => (state === "unknown" && phase === "probing" ? "检测中" : STATE_TEXT[state] || state);

function nodeHtml(node, iconName, phase, { badge = "" } = {}) {
  const label = node.label;
  return `
    <button type="button" class="road-node state-${node.state}" data-node="${escapeHtml(node.key)}" data-select="${escapeHtml(node.select)}" aria-pressed="${selectedId === node.select}" title="${escapeHtml(`${label} · ${stateText(node.state, phase)}`)}">
      <span class="road-orb-wrap" aria-hidden="true"><span class="road-aura"></span><span class="road-blip"></span><span class="road-orb">${icon(iconName, "road-orb-icon")}</span>${badge}</span>
      <span class="road-name">${escapeHtml(label)}</span>
      <span class="road-sub">${escapeHtml(node.sub)}</span>
    </button>`;
}

// 连线：光点（3 个，CSS 按流量档位显隐）、探针回声、断点 ×、标注都常驻 DOM，morph 只改类名与文本，进行中的动画不重启。
function linkHtml(key, state, { dur, top = "", note = "", pipe = false, select = "" } = {}) {
  const pk = '<span class="road-pk"></span>'.repeat(3);
  const topHtml = pipe
    ? `<button type="button" class="road-pipe-label" data-select="${escapeHtml(select)}" aria-pressed="${selectedId === select}" title="到集群的 SSH 往返（远端端口探测，每次探测一次完整的 SSH 执行）"><b class="road-pipe-name">SSH 隧道</b><span class="road-ms">${top === "—" ? "" : escapeHtml(top)}</span></button>`
    : `<span class="road-ms">${top === "—" ? "" : escapeHtml(top)}</span>`;
  return `
    <div class="road-link${pipe ? " road-pipe" : ""} state-${state}" data-link="${key}" style="--dur:${dur}s">
      <span class="road-link-top">${topHtml}</span>
      <span class="road-line"><span class="road-flow">${pk}</span><span class="road-ping"></span></span>
      ${pipe ? `<span class="road-lock" aria-hidden="true">${icon("lock", "road-lock-icon")}</span>` : ""}
      <span class="road-break" aria-hidden="true"></span>
      <span class="road-link-note">${escapeHtml(note)}</span>
    </div>`;
}

const fmtB = (n) => formatBytes(n, { compact: true });
const clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

function destinationsHtml(dest) {
  if (dest.recording === false) {
    return '<p class="road-dests-empty">打开 配置 → 出网 → 代理口令「只记录」后，这里显示集群经这条链路去了哪</p>'
      + '<button type="button" class="text-btn road-dests-open" data-chain-goto="enable-observe">一键开启只记录</button>'
      + '<button type="button" class="text-btn road-dests-open" data-chain-goto="egress">打开出网设置 →</button>';
  }
  if (dest.recording === null) return "";
  if (!dest.groups.length) return '<p class="road-dests-empty">近 24 小时还没有经这条链路的连接</p>';
  return dest.groups.slice(0, ROAD_MAX_DESTINATIONS).map((g) => {
    const id = `dest:${g.key}`;
    return `<button type="button" class="road-dest${g.active ? " is-active" : ""}" data-select="${escapeHtml(id)}" data-dest="${escapeHtml(g.key)}" aria-pressed="${selectedId === id}" title="${escapeHtml(`${g.name} · ${g.connections} 次连接${g.active ? " · 正在传输" : ""}`)}">
      <span class="road-dest-name"><i class="road-dest-dot" aria-hidden="true"></i>${escapeHtml(g.name)}</span>
      <span class="road-dest-num"><b class="road-dest-count">${g.connections}</b> 次 · ${escapeHtml(fmtB(g.up + g.down))}</span>
      <span class="road-dest-bar" aria-hidden="true"><i class="road-dest-fill" style="transform:scaleX(${Math.max(0.03, g.share).toFixed(3)})"></i></span>
    </button>`;
  }).join("");
}

function footHtml(road, nowMs) {
  const spark = tripSpark(road.trips, { nowMs, w: 120, h: 20 });
  const last = spark.last;
  const tripTitle = `集群经整条链路访问外网的一次往返（环境校验每 5 分钟一次）${spark.median != null ? ` · 近 24 小时中位 ${spark.median}ms` : ""}`;
  const dest = road.destinations;
  let since = "";
  if (dest.recording && dest.totals) {
    const young = Number.isFinite(dest.since) && nowMs - dest.since < 23 * 3600_000;
    since = `${young ? `去向 · 自 ${clock(dest.since)} 起` : "去向 · 近 24 小时"} ${dest.totals.connections} 次连接`;
  }
  const live = dest.recording
    ? `<span class="road-live" data-traffic="${road.traffic.level}" title="近一分钟经这条链路的流量"><i class="road-live-dot" aria-hidden="true"></i>${escapeHtml(road.traffic.level === "idle" ? "空闲" : formatRate(road.traffic.bps))}</span>`
    : "";
  return `
    <span class="road-trip" title="${escapeHtml(tripTitle)}"><span class="road-trip-label">端到端往返</span><b class="road-trip-ms">${last ? `${last.ms}<small class="road-trip-unit">ms</small>` : "—"}</b>${spark.line ? `<svg class="road-trip-spark" viewBox="0 0 120 20" preserveAspectRatio="none" aria-hidden="true"><path class="a" d="${spark.area}"/><path class="l" d="${spark.line}"/></svg>` : ""}</span>
    <span class="road-since">${escapeHtml(since)}</span>
    ${live}`;
}

function othersHtml(others) {
  if (!others.length) return "";
  return `<span class="road-others-label">其余隧道</span>${others.map((o) => `<button type="button" class="road-other state-${o.state}" data-select="${escapeHtml(o.select)}" aria-pressed="${selectedId === o.select}"><i class="road-other-dot" aria-hidden="true"></i>${escapeHtml(o.name)}<span class="road-other-state">${escapeHtml(STATE_TEXT[o.state] || o.state)}</span></button>`).join("")}`;
}

export function chainTrackHtml(road, nowMs = Date.now()) {
  const badge = road.supervisorDown ? '<span class="road-badge" title="守护进程没有在运行：断线后不会自动恢复">!</span>' : "";
  const fan = Math.max(1, Math.min(ROAD_MAX_DESTINATIONS, road.destinations.groups.length));
  return `
    <div class="road-path">
      ${nodeHtml(road.cluster, "remote", road.phase)}
      ${linkHtml("tunnel", road.tunnel.state, { dur: road.tunnel.dur, top: road.tunnel.latency, note: road.tunnel.note, pipe: true, select: road.tunnel.select })}
      ${nodeHtml(road.proxy, "proxy", road.phase, { badge })}
      ${linkHtml("egress", road.egressLink.state, { dur: 1.3, top: road.egressLink.latency })}
      ${nodeHtml(road.egress, "egress", road.phase)}
    </div>
    <div class="road-others"${road.others.length ? "" : " hidden"}>${othersHtml(road.others)}</div>
    <div class="road-mid"><p class="road-cause" data-tone="${road.cause?.tone || ""}">${road.cause ? escapeHtml(road.cause.text) : ""}</p></div>
    <div class="road-dests" style="--fan:${fan}">${destinationsHtml(road.destinations)}</div>
    <div class="road-foot">${footHtml(road, nowMs)}</div>`;
}

// ---- 分叉曲线（.road-fan：不进 morph，只在签名或尺寸变化时重画） ----
// 曲线竖直出、竖直进：x 按 cubic-bezier(.5,0,.5,1) 缓动、y 匀速。光点 = 外层 translateY 匀速 + 内层 translateX
// 走同一条缓动，两段都是 transform；曲线按同一缓动采样画出，光点正好落在线上。
const FAN_EASE = [0.5, 0, 0.5, 1];
export function cubicBezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x;
  const bx = 3 * (p2x - p1x) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * p1y;
  const by = 3 * (p2y - p1y) - cy;
  const ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    let t = x;
    for (let i = 0; i < 8; i += 1) {
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    return sy(Math.min(1, Math.max(0, t)));
  };
}
const fanEase = cubicBezier(...FAN_EASE);

// 纯函数：起点 (x0,y0) → 终点 (x1,y1) 的曲线路径（33 个采样点）。
export function fanPath(x0, y0, x1, y1, steps = 32) {
  const pts = [];
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    pts.push(`${s ? "L" : "M"}${(x0 + (x1 - x0) * fanEase(t)).toFixed(1)} ${(y0 + (y1 - y0) * t).toFixed(1)}`);
  }
  return pts.join("");
}

// 光点数随占比（Kiali：密度 = 流量）：大头 3 个、中等 2 个、其余 1 个。
export const fanParticles = (share) => (share > 0.35 ? 3 : share > 0.08 ? 2 : 1);
// 曲线粗细与光点数按 5% 一档的占比算：流量平稳时占比每轮微动，不必每 20 秒重建一次曲线层（光点会从头跑）。
export const quantizeShare = (share) => Math.round(Math.max(0, Math.min(1, share)) * 20) / 20;

let fanSig = "";
let fanDirty = true;
function layoutFan(road) {
  const scroller = getEl("chainTrack")?.parentElement;
  const layer = scroller?.querySelector(".road-fan");
  if (!layer) return;
  layer.dataset.phase = road.phase;
  layer.dataset.traffic = road.traffic.level;
  const groups = road.destinations.groups.slice(0, ROAD_MAX_DESTINATIONS);
  const contentSig = JSON.stringify(groups.map((g) => [g.key, quantizeShare(g.share), g.active]));
  if (!fanDirty && contentSig === fanSig) return;
  const chips = [...scroller.querySelectorAll(".road-dest")];
  const egressNode = scroller.querySelector('.road-node[data-node="egress"]');
  const egressOrb = egressNode?.querySelector(".road-orb");
  if (!egressOrb || !chips.length || chips.length !== groups.length) {
    layer.innerHTML = "";
    fanSig = contentSig;
    fanDirty = false;
    return;
  }
  const lr = layer.getBoundingClientRect();
  const nr = egressNode.getBoundingClientRect();
  const or = egressOrb.getBoundingClientRect();
  const x0 = or.left + or.width / 2 - lr.left;
  const y0 = nr.bottom - lr.top + 2;
  const paths = [];
  const dots = [];
  chips.forEach((chip, i) => {
    const g = groups[i];
    const cr = chip.getBoundingClientRect();
    const x1 = cr.left + 15 - lr.left;
    const y1 = cr.top - lr.top - 1;
    const share = quantizeShare(g.share);
    const width = (1.2 + Math.sqrt(share) * 3.2).toFixed(2);
    paths.push(`<path class="road-fan-path${g.active ? " is-active" : ""}" d="${fanPath(x0, y0, x1, y1)}" style="stroke-width:${width}px"/>`);
    if (!g.active) return;
    const n = fanParticles(share);
    for (let k = 0; k < n; k += 1) {
      dots.push(`<span class="road-fp" style="left:${x0.toFixed(1)}px;top:${y0.toFixed(1)}px;--dx:${(x1 - x0).toFixed(1)}px;--dy:${(y1 - y0).toFixed(1)}px;--k:${k};--n:${n};--i:${i}"><i class="road-fp-dot"></i></span>`);
    }
  });
  layer.innerHTML = `<svg class="road-fan-svg" width="${lr.width.toFixed(0)}" height="${lr.height.toFixed(0)}" aria-hidden="true">${paths.join("")}</svg>${dots.join("")}`;
  fanSig = contentSig;
  fanDirty = false;
}

// ---- 探针心跳：远端端口探针每返回一次（lastSuccessAt 变了），沿隧道从本机往集群送一个回声，到站的圆亮一圈；
// 本地代理探针返回时代理圆亮一圈。WAAPI 一次性播放、fill 不保留；减弱动画 / 窗口隐藏 / 首次渲染不播。
const beats = { remote: undefined, proxy: undefined };
const reduceMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function blip(track, nodeKey) {
  const ring = track.querySelector(`.road-node[data-node="${nodeKey}"] .road-blip`); // 模板里常驻，morph 不会删掉它
  if (!ring?.animate) return;
  ring.animate([{ transform: "scale(0.9)", opacity: 0.7 }, { transform: "scale(1.45)", opacity: 0 }], { duration: 900, easing: "cubic-bezier(0.2, 0.6, 0.3, 1)" });
}
function heartbeat(track, status, road) {
  const stages = status.bridgeStages || {};
  const remoteAt = stages["remote-port"]?.lastSuccessAt ?? null;
  const proxyAt = stages["local-proxy"]?.lastSuccessAt ?? null;
  const first = beats.remote === undefined;
  const remoteBeat = remoteAt !== beats.remote;
  const proxyBeat = proxyAt !== beats.proxy;
  beats.remote = remoteAt;
  beats.proxy = proxyAt;
  if (first || reduceMotion() || track.ownerDocument?.body?.hasAttribute("data-console-hidden")) return;
  if (proxyBeat && road.proxy.state === "ok") blip(track, "proxy");
  if (!remoteBeat || road.tunnel.state !== "ok" || road.cluster.state !== "ok") return;
  const ping = track.querySelector('.road-link[data-link="tunnel"] .road-ping');
  const line = ping?.parentElement;
  if (!ping?.animate || !line) return;
  const w = line.getBoundingClientRect().width;
  ping.animate(
    [{ transform: "translateX(0)", opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { transform: `translateX(${-w}px)`, opacity: 0 }],
    { duration: 760, easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
  ).finished.then(() => blip(track, "remote")).catch(() => {});
}

// ---- 详情 ----

// 链路状态 → 详情区 chk-status 芯片类名
function chipStateOf(state) {
  if (state === "ok") return "ok";
  if (state === "error" || state === "bad") return "bad";
  if (state === "stopped" || state === "setup") return "stopped";
  return "waiting";
}

const factValueHtml = (value) => value
  .map((part) => (part && typeof part === "object" ? `<b>${escapeHtml(part.b)}</b>` : escapeHtml(part)))
  .join("");

export function chainDetailHtml(detail) {
  if (!detail) return "";
  const facts = detail.facts
    .map((item) => `<div class="chain-fact"${item.tone ? ` data-tone="${escapeHtml(item.tone)}"` : ""}><dt>${escapeHtml(item.label)}</dt><dd>${factValueHtml(item.value)}</dd></div>`)
    .join("");
  // 日志联动是显式按钮：节点点击只展开详情，避免每次点选都弹出日志对话框。
  const actions = [
    // 同账号另一台 Mac 在承载、本机待命（v2.88）：把隧道接到这台
    detail.takeover ? `<button type="button" class="text-btn chain-takeover" data-chain-takeover="${escapeHtml(detail.takeover)}" title="让另一台 Mac 让位，这台电脑接管隧道（集群上正在经隧道的连接会断开一次后重连）">让这台承载</button>` : "",
    detail.switchTo ? `<button type="button" class="text-btn" data-chain-switch="${escapeHtml(detail.switchTo)}">切到这台查看</button>` : "",
    detail.navigate === "stability" ? '<button type="button" class="text-btn" data-chain-goto="stability">稳定性统计 →</button>' : "",
    detail.navigate === "servers" ? '<button type="button" class="text-btn" data-chain-goto="servers">资源与负载 →</button>' : "",
    detail.navigate === "egress" ? '<button type="button" class="text-btn" data-chain-goto="egress">出网设置 →</button>' : "",
    `<button type="button" class="text-btn chain-log-link" data-log-source="${escapeHtml(detail.logSource)}">相关日志 →</button>`,
  ].join("");
  const diag = detail.diag
    ? `<div class="chain-detail-diag"><strong>${escapeHtml(detail.diag.title)}</strong><p>${escapeHtml(detail.diag.body)}</p></div>`
    : "";
  // 环境校验逐项：一项一枚（✓ / ✗ + 名称 + 耗时），失败项置顶、下面附报错输出；
  // 跳过项（如没领端口时的经隧道出网测试）画成灰色「–」，耗时位写跳过原因。
  const checks = Array.isArray(detail.checks) && detail.checks.length
    ? `<ul class="chain-checks" aria-label="环境校验逐项">${detail.checks.map((c) => (c.skipped
      ? `<li class="chain-check" data-ok="skip"><span class="chain-check-icon" aria-hidden="true">–</span>`
        + `<span class="chain-check-key">${escapeHtml(c.key)}</span><span class="chain-check-ms">${escapeHtml(c.output || "已跳过")}</span>`
        + `<span class="sr-only">跳过</span></li>`
      : `<li class="chain-check" data-ok="${c.ok ? "true" : "false"}"><span class="chain-check-icon" aria-hidden="true">${c.ok ? "✓" : "✗"}</span>`
      + `<span class="chain-check-key">${escapeHtml(c.key)}</span><span class="chain-check-ms">${escapeHtml(String(c.durationMs))}ms</span>`
      + `<span class="sr-only">${c.ok ? "通过" : "失败"}</span>`
      + `${c.output ? `<pre class="chain-check-output">${escapeHtml(c.output)}</pre>` : ""}</li>`
    )).join("")}</ul>`
    : "";
  return `
    <div class="chain-detail-head">
      <span class="chk-status chk-status-${chipStateOf(detail.state)}"></span>
      <span class="chk-title">${escapeHtml(detail.title)}</span>
      <span class="chk-desc">${escapeHtml(detail.desc)}</span>
      <span class="chain-detail-actions">${actions}</span>
    </div>
    <dl class="chain-facts">${facts}</dl>
    ${checks}
    ${diag}`;
}

function renderDetail(model = lastStatus ? buildChainModel(lastStatus) : null) {
  const detail = getEl("chainDetail");
  if (!detail || !lastStatus || !model) return;
  const data = selectedId ? buildChainDetail(lastStatus, model, selectedId, { stability: stabilityStats, usage: usageData }) : null;
  if (!data) {
    selectedId = null; // 选中的那台服务器 / 那一组去向已不在链路里
    detail.hidden = true;
    detail.innerHTML = "";
    return;
  }
  detail.hidden = false;
  // 就地修补：详情区的按钮在重绘后仍保有焦点。
  morphInnerHtml(detail, chainDetailHtml(data));
}

function applySelectionClasses(track) {
  track.querySelectorAll("[data-select]").forEach((el) => {
    const on = el.dataset.select === selectedId;
    el.classList.toggle("selected", on);
    if (el.getAttribute("aria-pressed") !== String(on)) el.setAttribute("aria-pressed", String(on));
  });
}

function goto(target) {
  if (target === "egress") return void handlers.onOpenEgress?.();
  if (target === "enable-observe") {
    return void (handlers.onEnableObserve ? handlers.onEnableObserve() : handlers.onOpenEgress?.());
  }
  handlers.onNavigate?.(target);
}

function bindEvents() {
  if (bound || typeof document === "undefined") return;
  const track = getEl("chainTrack");
  if (!track) return;
  const scroller = track.parentElement;
  if (scroller && !scroller.querySelector(".road-fan")) {
    const layer = document.createElement("div");
    layer.className = "road-fan";
    layer.setAttribute("aria-hidden", "true");
    scroller.appendChild(layer);
    // 宽度变化（窗口缩放、侧栏开合、简报显隐）后曲线端点跟着卡片走
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(() => {
        fanDirty = true;
        if (lastStatus) layoutFan(buildRoadModel(lastStatus, roadInputs()));
      }).observe(scroller);
    }
  }
  track.addEventListener("click", (e) => {
    const gotoBtn = e.target.closest("[data-chain-goto]");
    if (gotoBtn) return void goto(gotoBtn.dataset.chainGoto);
    const nodeEl = e.target.closest("[data-select]");
    if (!nodeEl) return;
    const id = nodeEl.dataset.select;
    selectedId = selectedId === id ? null : id;
    renderDetail();
    applySelectionClasses(track);
  });
  const detail = getEl("chainDetail");
  if (detail) {
    detail.addEventListener("click", (e) => {
      const logBtn = e.target.closest("[data-log-source]");
      if (logBtn) {
        // 联动日志过滤（日志面板监听此事件并打开/滚动到日志面板；source 与后端 entry.source 对齐）
        document.dispatchEvent(new CustomEvent("console:filter-logs", {
          detail: { source: logBtn.dataset.logSource || "ops" },
        }));
        return;
      }
      const gotoBtn = e.target.closest("[data-chain-goto]");
      if (gotoBtn) return void goto(gotoBtn.dataset.chainGoto);
      const takeoverBtn = e.target.closest("[data-chain-takeover]");
      if (takeoverBtn) return void handlers.onTakeover?.(takeoverBtn.dataset.chainTakeover);
      const switchBtn = e.target.closest("[data-chain-switch]");
      if (switchBtn) handlers.onSwitchServer?.(switchBtn.dataset.chainSwitch);
    });
  }
  bound = true;
}

// 入口接线：详情里的「稳定性统计 / 资源与负载」跳转、「切到这台查看」、「出网设置」（打开配置并展开出网一节）。
// onNeedTrips：查看中的服务器换了（或首次拿到）而手上的往返样本不是这台的——催控制器马上拉一次。
// onTakeover(serverId)：隧道详情里的「让这台承载」（同账号另一台 Mac 在承载时才出现）。
export function initChain({ onNavigate = null, onSwitchServer = null, onOpenEgress = null, onEnableObserve = null, onNeedTrips = null, onTakeover = null } = {}) {
  handlers = { onNavigate, onSwitchServer, onOpenEgress, onEnableObserve, onNeedTrips, onTakeover };
}

const rerender = () => {
  dataVersion += 1;
  if (lastStatus) renderChain(lastStatus);
};

// 概览的稳定性轮询每次拿到 /api/tunnel-stability 就送一份过来：隧道的在线时长、断线原因与详情里的断线统计。
export function setChainStability(stats) {
  stabilityStats = stats && typeof stats === "object" ? stats : null;
  rerender();
}

// app/chain-traffic-controller.js：/api/egress/usage（去向与近一分钟流量）。
export function setChainTraffic(usage) {
  const next = usage && typeof usage === "object" ? usage : null;
  const sig = JSON.stringify(next);
  if (sig === usageSig) return; // 20 秒一轮，文件最多一分钟变一次：没变就不重绘
  usageSig = sig;
  usageData = next;
  rerender();
}

// app/chain-traffic-controller.js：/api/metrics?kind=validation 的样本（端到端往返历史）与它属于哪台服务器。
export function setChainTrips(samples, serverId = null) {
  tripsData = tripSamples(samples);
  tripsServer = serverId;
  rerender();
}

// 最近几次远端端口探测耗时的中位数（只在探针真的返回了新结果时记一笔）。
function noteTunnelSample(status) {
  const stage = status.bridgeStages?.["remote-port"];
  if (!stage?.ok || !Number.isFinite(Number(stage.durationMs)) || stage.lastSuccessAt === tunnelSamples.lastAt) return;
  tunnelSamples.lastAt = stage.lastSuccessAt;
  tunnelSamples.push(Number(stage.durationMs));
  if (tunnelSamples.length > TUNNEL_SAMPLES) tunnelSamples.shift();
}
function tunnelMedian() {
  if (!tunnelSamples.length) return null;
  return [...tunnelSamples].sort((a, b) => a - b)[Math.floor(tunnelSamples.length / 2)];
}

// 往返样本只给它所属的那台用；不是这台的先不显示，并催一次拉取。
function tripsFor(status) {
  const active = status?.activeServerId || null;
  if (active && tripsServer === active) return tripsData;
  if (active && tripsAsked !== active) {
    tripsAsked = active;
    handlers.onNeedTrips?.();
  }
  return [];
}

const roadInputs = (status = lastStatus) => ({ usage: usageData, trips: tripsFor(status), stability: stabilityStats, nowMs: Date.now(), tunnelMs: tunnelMedian() });

function renderChainImpl(status) {
  const track = getEl("chainTrack");
  if (!track) return;
  lastStatus = status;
  bindEvents();

  const model = buildChainModel(status);
  const nowMs = Date.now();
  noteTunnelSample(status);
  const road = buildRoadModel(status, { ...roadInputs(status), nowMs });
  // 结构固定、就地修补：只改变化的文本 / 状态类，节点按钮保留（键盘焦点不丢），动画不因每轮重绘而重启。
  if (track.dataset.phase !== road.phase) track.dataset.phase = road.phase;
  if (track.dataset.traffic !== road.traffic.level) track.dataset.traffic = road.traffic.level;
  morphInnerHtml(track, chainTrackHtml(road, nowMs));
  applySelectionClasses(track);
  layoutFan(road);
  heartbeat(track, status, road);
  const hint = getEl("chainHint");
  if (hint) {
    const text = road.others.length ? `${road.others.length + 1} 条隧道 · 点击节点查看详情` : "点击节点查看详情";
    if (hint.textContent !== text) hint.textContent = text;
  }
  renderDetail(model);
}

// 详情区读的状态切片（只在选中节点时入签）：进程、连接目标、环境校验、资源、本地代理探针。
function detailSignature(status) {
  if (!selectedId) return null;
  return [
    status.processes ? [status.processes.tunnelsByServer || null, status.processes.supervisor?.[0]?.pid ?? null, status.processes.localProxy?.[0]?.pid ?? null] : null,
    status.connectionTargets?.servers || null,
    status.layers?.validation || null,
    Object.entries(status.serversBrief || {}).map(([id, brief]) => [id, brief?.ok ?? null, brief?.cpu ?? null, brief?.ram ?? null, brief?.disk ?? null]),
    status.bridgeStages?.["local-proxy"] || null,
    status.supervisorUp,
    status.localProxyUp,
    status.egressHealth || null,
    // 整链诊断文案（getDiagnosticMsg）的输入
    status.networkChannel || null,
    status.doctor?.summary ? status.doctor.summary : null,
    status.onboarding ?? null,
    status.onboardingReason ?? null,
  ];
}

// 签名减重：只取影响渲染输出的字段。路模型由这些输入决定（往返样本数组不入签，靠 dataVersion）；
// 探针的 lastSuccessAt 入签，心跳才能每次探针返回都播。选中态与时间桶（相对时间文案）一并入签。
export const renderChain = createMemoRender(
  renderChainImpl,
  (status) => {
    const road = buildRoadModel(status, { usage: usageData, trips: [], stability: stabilityStats, nowMs: Date.now(), tunnelMs: tunnelMedian() });
    return JSON.stringify([
      timeBucket(),
      selectedId,
      dataVersion,
      road,
      status.health,
      status.bridgeStages?.["remote-port"]?.lastSuccessAt ?? null,
      status.bridgeStages?.["local-proxy"]?.lastSuccessAt ?? null,
      detailSignature(status),
    ]);
  },
);
