// 悬浮岛（托盘弹出小卡片；「钉在桌面」后常驻、可拖动）。island.html 以 <script type="module"> 加载本文件：
// 资源配色与主窗口共用 thresholds.js 的分档，不再各写一套阈值；集群读数与菜单栏数字共用
// render/glance-model.js（Slurm 计数取自主控制台集群面板的同一个模型）。
import { createErrorReporter } from "./assets/js/error-reporter.js";
import { buildGlanceModel } from "./assets/js/render/glance-model.js";
import { clampPct, colorFor, levelFor } from "./assets/js/thresholds.js";

// 元素引用
const expandedDot = document.getElementById("expandedDot");
const expandedText = document.getElementById("expandedText");

const nodeProxy = document.getElementById("node-proxy");
const nodeTunnel = document.getElementById("node-tunnel");
const nodeRemote = document.getElementById("node-remote");
const nodeEgress = document.getElementById("node-egress");

const cpuBar = document.getElementById("cpuBar");
const cpuVal = document.getElementById("cpuVal");
const ramBar = document.getElementById("ramBar");
const ramVal = document.getElementById("ramVal");

const islandEl = document.getElementById("island");
const pinBtn = document.getElementById("pinBtn");
const serversStrip = document.getElementById("serversStrip");
const serverName = document.getElementById("serverName");
const clusterSection = document.getElementById("clusterSection");
const clusterMeta = document.getElementById("clusterMeta");
const coreBar = document.getElementById("coreBar");
const coreVal = document.getElementById("coreVal");
const gpuRow = document.getElementById("gpuRow");
const gpuSlots = document.getElementById("gpuSlots");
const gpuVal = document.getElementById("gpuVal");
const nodeCells = document.getElementById("nodeCells");
const nodeVal = document.getElementById("nodeVal");
const clusterJobs = document.getElementById("clusterJobs");

const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const stopBtn = document.getElementById("stopBtn");
const openConsoleBtn = document.getElementById("openConsoleBtn");
const quitAppBtn = document.getElementById("quitAppBtn");

const BASE_URL = "http://127.0.0.1:8877";
let authToken = "";

const fetchApi = async (url, options = {}) => {
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (authToken) {
    headers["x-auth-token"] = authToken;
  }
  return fetch(url, { ...options, headers });
};

// 页面脚本错误上报（v2.64，与主页面同一个 error-reporter.js）：拿到令牌后才发，失败不重试。
const errorReporter = createErrorReporter({
  page: "island",
  send: (payload) => fetchApi(`${BASE_URL}/api/diagnostics/client-error`, { method: "POST", body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }),
});
errorReporter.install(window);

if (openConsoleBtn) {
  openConsoleBtn.addEventListener("click", () => {
    if (window.electronAPI) {
      window.electronAPI.openMainWindow();
    }
  });
}

// 钉在桌面：主进程管窗口行为（不随失焦收起、换浮窗层、记位置），页面只同步按钮与拖动区域。
let pinned = false;

function applyPinned(next) {
  pinned = next === true;
  document.body.toggleAttribute("data-pinned", pinned);
  pinBtn.setAttribute("aria-pressed", String(pinned));
  pinBtn.title = pinned ? "取消钉住：回到托盘弹出" : "钉在桌面：常驻、可拖动";
  pinBtn.setAttribute("aria-label", pinned ? "取消钉住" : "钉在桌面");
  syncPolling();
}

pinBtn.addEventListener("click", async () => {
  if (!window.electronAPI?.setIslandPinned) return;
  const result = await window.electronAPI.setIslandPinned(!pinned);
  applyPinned(result?.pinned);
});

if (quitAppBtn) {
  quitAppBtn.addEventListener("click", () => {
    // 走"需确认"的退出通道：主进程弹原生确认框后才停后台（quitApp 会视为已确认直接退出）。
    if (window.electronAPI && typeof window.electronAPI.requestQuit === "function") {
      window.electronAPI.requestQuit();
    }
  });
}

// 绑定按钮事件（T04a：悬浮岛的全局动作同样标注影响范围；重启/停止先确认，取消无副作用）
startBtn.addEventListener("click", () => triggerAction("start"));
restartBtn.addEventListener("click", () => triggerAction("restart"));
stopBtn.addEventListener("click", () => triggerAction("stop"));

// 全局动作影响范围文案（与主窗口/命令面板同一套语义）。
const SCOPE_CONFIRM = {
  restart: "重启所有连接：守护进程、本地代理与全部服务器的 SSH 隧道都会重启，所有连接短暂中断。确定继续？",
  stop: "停止所有连接：守护进程、本地代理与全部服务器的 SSH 隧道都会停止，且不会自动重启。确定继续？",
};

async function triggerAction(name) {
  if (SCOPE_CONFIRM[name] && typeof window.confirm === "function") {
    if (!window.confirm(SCOPE_CONFIRM[name])) return;
  }
  setWaitingState(name === "start" ? "启动中..." : name === "stop" ? "关闭中..." : "修复中...");
  expandedDot.className = "status-dot state-waiting";
  try {
    const res = await fetchApi(`${BASE_URL}/api/${name}`, { method: "POST" });
    const data = await res.json();
    // /api/restart 重入或被单隧道操作 / 热升级挡下时回 409 + { error }，
    // 那不是状态载荷——直接 render 会把整块 UI 画成"未知"。改为显示原因，
    // 下一拍 fetchStatus（可见期每 3s）自然覆盖回真实状态。
    if (!res.ok) {
      setWaitingState(data?.error ? String(data.error).slice(0, 40) : `请求失败 (${res.status})`);
      return;
    }
    render(data);
  } catch (err) {
    console.error("Action failed:", err);
  }
}

function setWaitingState(msg) {
  expandedText.textContent = msg;
}

// 定时拉取状态。
// 注：悬浮岛经 file:// 加载（electron loadFile），跨源直连 BASE_URL，保留上面的极简 fetchApi。
// 链路走 /api/status-lite（3 秒一拍）；集群读数要 layers，走 /api/status，15 秒一次就够
// （资源采集本身 60 秒一轮）。
async function fetchStatus() {
  try {
    const res = await fetchApi(`${BASE_URL}/api/status-lite`);
    const data = await res.json();
    render(data);
  } catch {
    renderOffline();
  }
}

const GLANCE_INTERVAL_MS = 15000;
let lastGlanceAt = 0;
let glanceInFlight = false;

async function fetchGlance() {
  if (glanceInFlight) return;
  glanceInFlight = true;
  lastGlanceAt = Date.now();
  try {
    const res = await fetchApi(`${BASE_URL}/api/status`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderGlance(buildGlanceModel(await res.json()));
  } catch {
    renderGlance(null);
  } finally {
    glanceInFlight = false;
  }
}

function pollOnce() {
  fetchStatus();
  if (Date.now() - lastGlanceAt >= GLANCE_INTERVAL_MS) fetchGlance();
}

// 轮询只在悬浮岛"真正可见"时运行。
// 背景（perf）：悬浮窗以 show:false 创建，Electron 下从未 show 过的窗口 document.hidden
// 恒为 false（paintWhenInitiallyHidden，见 render/visibility.js 注释），此前的
// `if (!document.hidden)` 闸门形同虚设——App 启动后到用户第一次点托盘之前，隐藏的
// 悬浮岛每 3s 打一次 /api/status-lite 并重绘。
// 真实可见性判据：弹出卡片 blur 即 hide（desktop/windows.mjs），show 时必 focus()，
// 因此"未隐藏且持有焦点"≈"用户正看着它"；钉在桌面时不靠焦点，未隐藏即在看。不改用 SSE：/api/events 会把全部日志与
// layers 推给一个绝大多数时间收起的窗口，并占用后端 8 个 SSE 名额之一，反而更贵。
const POLL_INTERVAL_MS = 3000;
let pollTimer = null;

function isIslandActive() {
  return !document.hidden && (pinned || typeof document.hasFocus !== "function" || document.hasFocus());
}

function syncPolling() {
  const active = isIslandActive();
  // 收起期暂停 CSS 动画（island.css 的 data-island-idle 闸）。
  if (document.body) document.body.toggleAttribute("data-island-idle", !active);
  if (active && !pollTimer) {
    pollOnce(); // 弹出瞬间立即补拉，不等下一拍
    pollTimer = setInterval(() => {
      if (isIslandActive()) pollOnce();
      else syncPolling();
    }, POLL_INTERVAL_MS);
  } else if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// 窗口高度跟内容走：面板高度一变就报给主进程（宽度固定，主进程夹在 150–560 之间）。
function watchIslandHeight() {
  if (!window.electronAPI?.resizeIsland || typeof ResizeObserver !== "function") return;
  let lastHeight = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(islandEl.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    window.electronAPI.resizeIsland(height);
  }).observe(islandEl);
}

async function init() {
  if (window.electronAPI?.getAuthToken) {
    authToken = await window.electronAPI.getAuthToken();
  }
  errorReporter.markReady();
  watchIslandHeight();
  window.electronAPI?.onIslandPinned?.(applyPinned);
  if (window.electronAPI?.getIslandState) {
    try {
      applyPinned((await window.electronAPI.getIslandState())?.pinned);
    } catch {}
  }
  window.addEventListener("focus", syncPolling);
  window.addEventListener("blur", syncPolling);
  document.addEventListener("visibilitychange", syncPolling);
  // 收起态预热一次：首次弹出前就有内容，避免"正在获取状态..."闪一下（可见态由 syncPolling 立即拉）。
  if (!isIslandActive()) {
    fetchStatus();
    fetchGlance();
  }
  syncPolling();
}

init();

// 渲染面板数据
function render(status) {
  // T02：transport 与 Agent 能力分离，文案只描述数据通路（status-lite 与全局动作响应恒带 summary）。
  // setup = 还没领反向端口（v2.54）：配置未完成，灰点 +「未领取端口」，不当成连接中断。
  const transportLabels = { connected: "已连接", disconnected: "连接中断", stopped: "已停止", unknown: "待验证", setup: "未领取端口" };
  const transportDotState = { connected: "ready", disconnected: "down", stopped: "stopped", unknown: "waiting", setup: "stopped" };
  const state = status.summary?.transport?.state;
  const egState = status.egressHealth?.state;
  const egError = Boolean(status.localProxyUp) && egState === "error";
  expandedText.textContent = egError ? "本机出网中断" : (transportLabels[state] || "未知");
  expandedDot.className = `status-dot state-${egError ? "degraded" : (transportDotState[state] || "waiting")}`;
  expandedText.title = egError ? (status.egressHealth?.summary || "本机转发出网连续失败") : (status.summary?.headline || "");

  // 更新四个子节点状态
  updateNodeState(nodeRemote, status.shouldBeRunning ? (status.remotePortOpen ? "ok" : "bad") : "stopped");
  updateNodeState(nodeTunnel, status.shouldBeRunning ? (status.tunnelUp ? "ok" : "waiting") : "stopped");
  updateNodeState(nodeProxy, status.shouldBeRunning ? (status.localProxyUp ? "ok" : "waiting") : "stopped");
  if (nodeEgress) {
    const egressNodeState = !status.shouldBeRunning
      ? "stopped"
      : !status.localProxyUp
        ? "waiting"
        : egError
          ? "bad"
          : egState === "warn"
            ? "waiting"
            : "ok";
    updateNodeState(nodeEgress, egressNodeState);
  }

  // 更新服务器资源：改打 status-lite 接口后，直接使用 activeServerLoad 数据
  renderResources(status.activeServerLoad);
}

function renderOffline() {
  expandedText.textContent = "无法连接监控服务";
  expandedDot.className = "status-dot state-down";
  updateNodeState(nodeProxy, "bad");
  updateNodeState(nodeTunnel, "bad");
  updateNodeState(nodeRemote, "bad");
  if (nodeEgress) updateNodeState(nodeEgress, "bad");
  
  updateBar(cpuBar, cpuVal, "cpu", 0);
  updateBar(ramBar, ramVal, "memory", 0);
}

function updateNodeState(element, state) {
  element.className = `node-item state-${state}`;
}

// 渲染资源负载：直接使用后端归一化后的 cpu/ram 百分比（不再本地解析 uptime/Mem 输出）。
function renderResources(res) {
  if (!res || res.cpu === undefined || res.ram === undefined) {
    updateBar(cpuBar, cpuVal, "cpu", 0, "-");
    updateBar(ramBar, ramVal, "memory", 0, "-");
    return;
  }
  updateBar(cpuBar, cpuVal, "cpu", clampPct(res.cpu));
  updateBar(ramBar, ramVal, "memory", clampPct(res.ram));
}

// kind 取 thresholds.js 的资源类别（cpu / memory），配色分档与主窗口服务器卡一致。
function updateBar(barElement, valueElement, kind, percent, overrideText) {
  // scaleX 而非 width：过渡只走合成层（.res-bar 恒 width:100%，见 island.css）。
  barElement.style.transform = `scaleX(${clampPct(percent) / 100})`;
  valueElement.textContent = overrideText !== undefined ? overrideText : `${percent}%`;
  barElement.className = `res-bar color-${colorFor(levelFor(kind, percent))}`;
}

// ---- 服务器列表与集群区（数据：buildGlanceModel(/api/status)；拉不到时收起集群区） ----

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderGlance(glance) {
  serverName.textContent = glance?.active?.name || "服务器";
  renderServersStrip(glance?.servers || []);
  renderCluster(glance?.cluster || null);
}

// 只有一台服务器时它的状态就是上面的链路四格，不再重复。
function renderServersStrip(servers) {
  serversStrip.hidden = servers.length < 2;
  if (serversStrip.hidden) return;
  serversStrip.replaceChildren(...servers.map((server) => {
    const chip = el("span", "server-chip", { "data-link": server.link, title: `${server.name}：${server.linkReason || "等待探测"}` });
    if (server.active) chip.setAttribute("data-active", "");
    const name = el("span");
    name.textContent = server.name;
    chip.append(el("span", "chip-dot"), name);
    return chip;
  }));
}

function renderCluster(cluster) {
  clusterSection.hidden = !cluster;
  if (!cluster) return;

  const freshness = cluster.freshness || {};
  clusterMeta.textContent = [`${cluster.nodeCount} 节点`, freshness.text].filter(Boolean).join(" · ");
  clusterMeta.title = freshness.title || "";
  if (freshness.level === "warn" || freshness.level === "error") clusterMeta.dataset.level = freshness.level;
  else delete clusterMeta.dataset.level;

  // 核分配是「排上了多少活」，不是告警：用强调色，不按资源阈值变红。
  const allocPct = cluster.cpuAllocPct;
  coreBar.style.transform = `scaleX(${allocPct == null ? 0 : clampPct(allocPct) / 100})`;
  coreBar.className = "res-bar color-busy";
  coreVal.textContent = allocPct == null ? "-" : `${Math.round(allocPct)}%`;
  coreVal.title = cluster.cpuTotal == null ? "" : `${cluster.cpuAlloc} / ${cluster.cpuTotal} 核已分配`;

  gpuRow.hidden = !(cluster.gpuTotal > 0);
  if (!gpuRow.hidden) {
    gpuSlots.replaceChildren(...cluster.gpuGroups.map((group) => {
      const box = el("span", "slot-group", { title: group.title || "" });
      box.append(...group.slots.map((slot) => {
        const cell = el("span", "slot", { title: slot.title || "", "data-busy": String(slot.busy === true) });
        const fill = el("span", "slot-fill");
        fill.style.transform = `scaleY(${Math.max(0, Math.min(1, Number(slot.fill) || 0))})`;
        cell.append(fill);
        return cell;
      }));
      return box;
    }));
    gpuVal.textContent = `${cluster.gpuUsed}/${cluster.gpuTotal}`;
  }

  nodeCells.replaceChildren(...cluster.nodes.map((dot) => el("span", "node-cell", { "data-tone": dot.tone || "idle", title: dot.title || "" })));
  nodeVal.textContent = `${cluster.busyNodes}/${cluster.nodeCount}`;
  nodeVal.title = [`${cluster.busyNodes} 占用`, `${cluster.idleNodes} 空闲`, cluster.badNodes ? `${cluster.badNodes} 异常` : ""].filter(Boolean).join(" · ");

  if (cluster.errorText) {
    clusterJobs.dataset.level = "error";
    clusterJobs.textContent = cluster.errorText;
    return;
  }
  delete clusterJobs.dataset.level;
  const parts = [["作业 ", cluster.running, " 运行"], [" · ", cluster.pending, " 排队"]];
  if (cluster.mine) parts.push([" · 我的 ", cluster.mine.running, cluster.mine.pending ? ` 运行 +${cluster.mine.pending} 排队` : " 运行"]);
  clusterJobs.replaceChildren(...parts.flatMap(([before, value, after]) => {
    const strong = el("b");
    strong.textContent = String(value);
    return [before, strong, after];
  }));
}
