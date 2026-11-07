import { createElementLookup, morphInnerHtml, reconcileList } from "../dom-utils.js";
import { doctorAttentionCount, doctorAdviceText } from "../doctor-advisories.js";
import { emptyStateHtml } from "../empty-state.js";
import { formatRelativeTime, escapeHtml } from "../store.js";
import { colorFor, levelFor } from "../thresholds.js";
import { cliIdForAgent, cliLoginText, cliStateForAgent, cliUpdateChip, cliVersionText } from "./cli-model.js";
import { progressScale } from "./load-panel.js";
import { buildServerCardExtrasHtml, buildServerCardModel } from "./server-card-model.js";
import { createMemoRender } from "./render-skip.js";

// DOM 引用惰性获取（dom-utils.createElementLookup：无 document 时返回 null，纯函数可在 Node 测试中导入）
const getEl = createElementLookup();

// v2.18.1：agent 切换标签组（renderAgentDetailSwitch）已删除——与顶部 Agent 卡（可点切换）重复。
// 配置里的 switchLabel 字段保留读取兼容，界面不再使用。

// 凭证过期徽标：agent.expiry 来自 layers.agents[id].expiry（state-store 归并的
// parseAgentExpiry() 结果）。unknown（解析不出）不展示，沿用既有 .chip 芯片配色
// （warn 黄 / expired 红），不新造样式。
function agentExpiryOf(status, agentId) {
  const layer = status.layers?.agents ? status.layers.agents[agentId] : null;
  return layer ? layer.expiry : null;
}

function agentExpiryBadgeHtml(expiry) {
  if (!expiry || expiry.level === "unknown") return "";
  if (expiry.level === "expired") {
    return '<span class="chip chip-error">凭证已过期</span>';
  }
  if (expiry.level === "warn") {
    const remainingDays = expiry.remainingMs != null ? Math.max(0, Math.ceil(expiry.remainingMs / 864e5)) : null;
    const label = remainingDays != null ? `凭证 ${remainingDays} 天后过期` : "凭证即将过期";
    return `<span class="chip chip-warn">${escapeHtml(label)}</span>`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Agent 状态带：结论 + 渐进披露（v2.15 的三张卡在 v2.45 收成一条分栏带）
//   每栏一行：状态点 / 名称 / 凭证徽标 / 一句话根因（buildAgentHeadline）/ 2 个主 chips
//  （端点语义、最后检查）/ 端点延迟（只此一处）/「详情」开关。
//   其余信息在状态带下方的通栏详情里（#agentStripDrawer，一次只展开一个 Agent）。
//   各 agent 共用同一模板，缺数据的字段显示占位「—」而非整块消失。
// ---------------------------------------------------------------------------

// 详情展开状态（agentId → bool）：模块内存态，rerender 间保持，刷新页面归零。
// 详情是状态带下方的同一块区域，所以展开一个会收起其它的。
const agentDrawerExpanded = {};

export function setAgentDrawerExpanded(agentId, expanded) {
  if (expanded === true) {
    for (const id of Object.keys(agentDrawerExpanded)) agentDrawerExpanded[id] = false;
  }
  agentDrawerExpanded[agentId] = expanded === true;
}

export function isAgentDrawerExpanded(agentId) {
  return agentDrawerExpanded[agentId] === true;
}

// ---- 官方 CLI 版本 / 登录 / 可更新（v2.57）----
// /api/cli 的最近一份结果（app/cli-controller.js 低频拉取后经 setAgentCliPayload 送入）。
// 只用于展示：为 null（接口未就绪 / 失败 / 还没拉到）时卡片回落到适配器自己的字段。
let agentCliPayload = null;

// 「可更新到 x」chip 与详情里的「安装…」（[data-cli-manage]）的处理者：app.js 注入 settings-cli.openFor，
// 打开配置浮层「命令行工具」并直接进入同一个确认（不另造更新流程）。
let cliManageHandler = null;

export function setCliManageHandler(fn) {
  cliManageHandler = typeof fn === "function" ? fn : null;
}

// chip 在整栏 div[role=button] 里：自己处理点击并阻止冒泡（不触发外层的 Agent 切换委托）。
function bindCliManageButtons(root) {
  for (const btn of root.querySelectorAll?.("[data-cli-manage]") || []) {
    btn.onclick = (e) => {
      e.stopPropagation();
      cliManageHandler?.({ cli: btn.dataset.cliManage, action: btn.dataset.cliManageAction || "install" });
    };
  }
}

const NOT_INSTALLED_HINT = "可在 配置 → 命令行工具 安装";

// 装了，但非交互 SSH 的 PATH 里找不到（后端适配器给出 detail.offPath，形如 "~/.nvm/versions/node/v22/bin/codex"）：
// 不是「未安装」。第一行根因由后端的 degradedReason 说（装在哪），详情里再给处理建议。
const OFF_PATH_HINT = "工作台的检查、安装与登录都经非交互 SSH 执行，看不到它。处理：把所在目录加进 PATH 的那一行（或 nvm 的初始化）挪到 ~/.bashrc 最前面；或点下方「安装…」装官方版到 ~/.local/bin";

export function agentOffPath(detail) {
  return typeof detail?.offPath === "string" && detail.offPath ? detail.offPath : null;
}

export function setAgentCliPayload(payload) {
  agentCliPayload = payload && typeof payload === "object" ? payload : null;
  // 不等下一轮状态推送：按最新数据重画一次（签名含 CLI 字段，没变化时 reconcile 不动 DOM）。
  if (lastOverviewArgs) renderAgentOverview(...lastOverviewArgs);
}

// ---- 累计计数器窗口化 ----
// bridgeStages.ssh-tunnel 的 reconnects/fastFailures 是无时间窗口的历史累计值
//（"重连 641"看不出趋势）。这里在模块内按 agentId 采样近 1 小时的计数值，
// ≥2 个样本后展示窗口差值（"1h 内重连 N 次"），样本不足回退累计值并带「累计」字样。
// 纯内存态：切服务器/supervisor 重启会让计数器回退，检测到回退即清空该 agent 的
// 历史（自愈）；超窗样本每次采样自然过期。

const BRIDGE_WINDOW_MS = 3600e3; // 1 小时
const BRIDGE_SAMPLE_MIN_GAP_MS = 30e3; // 计数不变时的最小采样间隔，防止渲染频率灌爆样本数

const bridgeCounterHistory = new Map(); // agentId → [{ t, reconnects, fastFails }]

// 纯函数（historyMap 可注入，便于测试）：记录一次采样并返回该 agent 的窗口内样本。
export function recordBridgeSample(historyMap, agentId, tunnelStage, nowMs = Date.now(), windowMs = BRIDGE_WINDOW_MS) {
  const existing = historyMap.get(agentId) || [];
  if (!tunnelStage || tunnelStage.reconnects == null) return existing;
  const reconnects = Number(tunnelStage.reconnects) || 0;
  const fastFails = Number(tunnelStage.fastFailures) || 0;
  let samples = existing;
  const last = samples[samples.length - 1];
  // 计数器回退 = 换了服务器或计数源重置，旧样本已无意义 → 清空自愈。
  if (last && (reconnects < last.reconnects || fastFails < last.fastFails)) samples = [];
  const tail = samples[samples.length - 1];
  const changed = !tail || tail.reconnects !== reconnects || tail.fastFails !== fastFails;
  if (changed || nowMs - tail.t >= BRIDGE_SAMPLE_MIN_GAP_MS) {
    samples = [...samples, { t: nowMs, reconnects, fastFails }];
  }
  const pruned = samples.filter((s) => nowMs - s.t <= windowMs);
  historyMap.set(agentId, pruned);
  return pruned;
}

// 纯函数：窗口内差值。样本不足（<2）或计数回退（负差）返回 null → 调用方回退累计展示。
export function computeBridgeWindowDelta(samples, nowMs = Date.now(), windowMs = BRIDGE_WINDOW_MS) {
  const inWindow = (samples || []).filter((s) => nowMs - s.t <= windowMs);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const reconnects = last.reconnects - first.reconnects;
  const fastFails = last.fastFails - first.fastFails;
  if (reconnects < 0 || fastFails < 0) return null;
  return { reconnects, fastFails, spanMs: last.t - first.t };
}

// ---- 根因/延迟取数 ----

// 关键延迟：claude 走 claude-endpoint 探针的真实 API 延迟；codex 走 bridgeStages
// 的 agent-endpoint 阶段（该阶段只由 codex endpoint 探针写入，不会与 claude 串数）。
// 其余 agent（zcode 等）走通用路径 agentsStatus[id].endpoint.latencyMs——
// v2.17 前的兜底是 bridgeStages，会把 codex 的延迟串显到第三个 agent 卡片上。
// 探测失败时的 duration 是超时值，会误导 → 只在 ok 时给延迟。
export function agentLatencyMs(status, agentId) {
  if (agentId === "claude-codewing") {
    const ce = status.claudeEndpoint;
    return ce && ce.ok === true && ce.latencyMs != null ? Number(ce.latencyMs) : null;
  }
  if (agentId === "codex") {
    const stage = status.bridgeStages ? status.bridgeStages["agent-endpoint"] : null;
    return stage?.ok && stage.durationMs != null ? Number(stage.durationMs) : null;
  }
  const ep = status.agentsStatus?.[agentId] ? status.agentsStatus[agentId].endpoint : null;
  return ep && ep.ok === true && ep.latencyMs != null ? Number(ep.latencyMs) : null;
}

// 端点语义（统一为三态：可达 / 不可达 / 待探测），两个 agent 同一套标签。
function agentEndpointOk(status, agentId) {
  if (agentId === "claude-codewing") {
    const ce = status.claudeEndpoint;
    return ce && ce.ok != null ? ce.ok === true : null;
  }
  const ep = status.agentsStatus?.[agentId] ? status.agentsStatus[agentId].endpoint : null;
  return ep && ep.ok != null ? ep.ok === true : null;
}

// 降级根因：后端适配器随 agentsStatus 算好的 detail.degradedReason（lib/agents/ 各适配器
// 在 buildStatus 输出，严重优先；新 agent 无需改前端即有正确根因行）。适配器推不出
// （null）时用层级原因兜底。
function degradedReasonText(status, agent, detail) {
  if (typeof detail.degradedReason === "string" && detail.degradedReason) {
    return detail.degradedReason;
  }
  const layer = status.layers?.agents ? status.layers.agents[agent.id] : null;
  const reason = layer?.reason && layer.reason !== "degraded" ? layer.reason : "";
  return reason ? `降级：${reason}` : "降级：原因待定位（展开详情）";
}

// 一句话根因/状态（卡片第一行）。规则自上而下短路：
//   1. 层级 skipped（通道熔断）→「检测暂停」——此时 health 是熔断前的旧值，不可信；
//   2. 凭证已过期 → 直接判故障（layers 也会把该 agent 押到 error）；
//   3. 按 health 分派：ready（带延迟）/ degraded（逆推降级根因）/ auth-required /
//      missing / revoked / banned（error 家族即「down」态）/ waiting；
//   4. 未知 health 兜底为 warn，文案透出原始值便于排查。
export function buildAgentHeadline(status, agent) {
  const layer = status.layers?.agents ? status.layers.agents[agent.id] : null;
  const detail = (status.agentsStatus?.[agent.id]) || {};
  const expiry = layer ? layer.expiry : null;

  // 官方 CLI 没装（v2.57）是中性状态：层级同样是 skipped（不立案、不计入健康），文案要说清是没装、不是熔断。
  if (agent.health === "not-installed") return { text: `未安装（${NOT_INSTALLED_HINT}）`, tone: "idle" };
  if (layer && layer.level === "skipped") return { text: "检测暂停：通道异常，熔断跳过", tone: "idle" };
  if (expiry && expiry.level === "expired") return { text: "故障：凭证已过期，需在服务器重新登录", tone: "error" };

  const health = agent.health || "waiting";
  if (health === "ready") {
    // warn 不再降级（后端已改判级），但提醒计数仍在根因行透出——具体内容见抽屉"Doctor 提醒"行。
    // 端点延迟/可达已分别在标题行与 chips 展示，根因行只给结论。
    const warnCount = doctorAttentionCount(detail.summary);
    return { text: warnCount > 0 ? `就绪 · Doctor ${warnCount} 项提醒` : "就绪", tone: "ok" };
  }
  if (health === "degraded") return { text: degradedReasonText(status, agent, detail), tone: "warn" };
  // 官方 CLI（Claude Code 适配器）给出 login:"none"：集群上还没登录；reclaude 是设备登录流程。
  if (health === "auth-required") {
    return { text: detail.login === "none" ? "需登录：集群上尚未登录（账号授权或 API key）" : "需登录：等待设备完成登录", tone: "warn" };
  }
  if (health === "missing") return { text: "故障：远端未检测到运行环境（未安装）", tone: "error" };
  if (health === "revoked") return { text: "故障：设备已被解绑，需重新登录", tone: "error" };
  if (health === "banned") return { text: "故障：绑定账号被封禁", tone: "error" };
  if (health === "waiting") return { text: "检测中 · 等待首次探针结果", tone: "idle" };
  return { text: `状态未知（${health}）`, tone: "warn" };
}

// 每栏的视图模型（纯函数，Node 可测）：延迟 + headline + 2 主 chips + 详情行。
// 两个 agent 完全同构——缺数据字段给「—」占位；渲染签名直接 JSON.stringify(model)，
// 保证任何新增展示字段天然进签名（相对时间文案也在其中，随渲染自刷新）。
export function buildAgentCardModel(status, agent, nowMs = Date.now(), bridgeWindow = null, cliPayload = agentCliPayload) {
  const detail = (status.agentsStatus?.[agent.id]) || {};
  // 官方 CLI 的版本 / 登录 / 最新版（/api/cli）：只认当前查看服务器的结果，缺失时回落到适配器字段。
  const cli = cliStateForAgent(cliPayload, agent, status.activeServerId);
  const layer = status.layers?.agents ? status.layers.agents[agent.id] : null;
  const endpointOk = agentEndpointOk(status, agent.id);
  const latency = agentLatencyMs(status, agent.id);
  const checkedAt = layer && layer.checkedAt != null ? layer.checkedAt : null;

  const notInstalled = agent.health === "not-installed";
  const offPath = agentOffPath(detail);
  const chips = [
    notInstalled
      ? { text: "未安装", tone: "idle" }
      : endpointOk === true
      ? { text: "端点可达", tone: "ok" }
      : endpointOk === false
        ? { text: "端点不可达", tone: "error" }
        : { text: "端点待探测", tone: "idle" },
    { text: checkedAt != null ? `检查 · ${formatRelativeTime(checkedAt, nowMs)}` : "未检查", tone: "plain" },
  ];
  const updateChip = cliUpdateChip(cli, cliIdForAgent(agent));
  if (updateChip) chips.push(updateChip);

  const summary = detail.summary || null;
  const doctorCounts = summary && (typeof summary.ok === "number" || typeof summary.fail === "number")
    ? `${summary.ok || 0} ok / ${summary.warn || 0} warn / ${summary.fail || 0} fail / ${summary.notes || 0} notes`
    : "—";
  // 警告项明细（summary.warnItems 由后端 parseDoctorWarnItems 提取）：此前用户只能
  // 看到"1 warn"计数，点遍日志也找不到内容——现在抽屉里直接列出每一项。
  const warnItemsText = doctorAdviceText(summary?.warnItems);
  const rows = [
    {
      label: "诊断摘要",
      value: notInstalled
        ? `未安装（不计入健康，${NOT_INSTALLED_HINT}）`
        : offPath
          ? `已安装在 ${offPath}，但非交互 SSH 的 PATH 里找不到。${OFF_PATH_HINT}`
          : (agent.summary || "—"),
    },
    // 版本行带「已是最新」；落后时由「可更新到 x」chip 说（不再单列「最新版本」行，避免同一信息两处显示）。
    { label: "版本", value: cliVersionText(cli) || detail.version || "—" },
    { label: "Gateway", value: detail.gatewayOk === true ? "OK" : detail.gatewayOk === false ? "失败" : "—" },
    {
      label: "登录",
      value: cliLoginText(cli)
        || (typeof detail.loginDetail === "string" && detail.loginDetail ? detail.loginDetail : null)
        || (detail.loggedIn === true ? "已登录" : detail.loggedIn === false ? "未登录" : "—"),
    },
    { label: "Doctor 计数", value: doctorCounts },
    // 常驻行（无内容给占位）：保持两 agent 模板行标签集合完全同构
    { label: "Doctor 提醒", value: warnItemsText || "—" },
    {
      label: "层级结论",
      value: layer
        ? `${layer.reason || "—"}${checkedAt != null ? ` · ${formatRelativeTime(checkedAt, nowMs)}` : ""}`
        : "—",
    },
  ];

  const expiry = agentExpiryOf(status, agent.id);
  return {
    id: agent.id,
    name: agent.name || agent.id,
    health: agent.health || "waiting",
    latency,
    headline: buildAgentHeadline(status, agent),
    chips,
    drawer: { rows },
    expiry: expiry && expiry.level !== "unknown" ? { level: expiry.level, remainingMs: expiry.remainingMs ?? null } : null,
    bridgeWindow,
  };
}

// 栏内右侧的端点延迟；无数据时给淡色「—」占位，各栏对齐。
function latencyMetricHtml(latency) {
  if (latency == null) return '<span class="agent-card-metric is-empty" title="端点延迟：暂无数据">—</span>';
  return `<span class="agent-card-metric" title="端点延迟">${escapeHtml(String(latency))}<span class="agent-card-metric-unit">ms</span></span>`;
}

function chipToneClass(tone) {
  if (tone === "info") return "chip chip-info";
  if (tone === "ok") return "chip chip-ok";
  if (tone === "error") return "chip chip-error";
  if (tone === "warn") return "chip chip-warn";
  if (tone === "idle") return "chip chip-idle";
  return "";
}

// 最近一次渲染的入参：点「详情」后立即按最新数据重画（不等下一轮状态推送）。
let lastOverviewArgs = null;

export function renderAgentOverview(status, agentView) {
  const overview = status.agentsOverview || [];
  const container = getEl("agentOverviewGrid");
  if (!container) return;
  // v2.47：Agent 全部关闭（监控模块）→ 整条状态带连同展开的详情一起隐藏；重新开启后照常渲染。
  const strip = container.parentElement?.classList?.contains("pagebar-agents") ? container.parentElement : container;
  if (!overview.length) {
    strip.hidden = true;
    const drawer = getEl("agentStripDrawer");
    if (drawer && !drawer.hidden) drawer.hidden = true;
    lastDrawerSig = "";
    lastOverviewArgs = null;
    return;
  }
  if (strip.hidden) strip.hidden = false;
  lastOverviewArgs = [status, agentView];
  const selectedId = agentView?.agent?.id ?? null;

  const nowMs = Date.now();
  // bridgeStages 全量序列化一次入签：详情里的桥接明细逐字段受其保护（宁多不可漏）。
  const bridgeStagesSig = JSON.stringify(status.bridgeStages || {});
  const tunnelStage = status.bridgeStages ? status.bridgeStages["ssh-tunnel"] : null;

  // 每次 render 先采样计数器 + 生成视图模型（sigFn/updateEl 共用，避免重复推导）。
  const models = new Map();
  for (const agent of overview) {
    const samples = recordBridgeSample(bridgeCounterHistory, agent.id, tunnelStage, nowMs);
    models.set(agent.id, buildAgentCardModel(status, agent, nowMs, computeBridgeWindowDelta(samples, nowMs)));
  }

  reconcileList(container, overview, {
    keyFn: (agent) => agent.id,
    sigFn: (agent) => [
      agent.id === selectedId ? 1 : 0,
      isAgentDrawerExpanded(agent.id) ? 1 : 0,
      JSON.stringify(models.get(agent.id)),
    ].join("|"),
    createEl: () => {
      // 每栏是 div[role=button]：里面还有一个真正的 <button>（「详情」），button 套 button 是非法 HTML。
      // 键盘可达性由 tabindex+keydown 补齐，点击切换仍走 app.js 在 #agentOverviewGrid 上的
      // [data-agent-id] 事件委托。
      const pill = document.createElement("div");
      pill.setAttribute("role", "button");
      pill.tabIndex = 0;
      pill.addEventListener("keydown", (e) => {
        if (e.target !== pill) return; // 「详情」按钮自己的 Enter/Space 不在此处理
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pill.click();
        }
      });
      return pill;
    },
    updateEl: (pill, agent) => {
      const model = models.get(agent.id);
      const isSelected = agent.id === selectedId;
      const expanded = isAgentDrawerExpanded(agent.id);

      pill.className = `agent-pill state-${model.health}${isSelected ? " selected" : ""}`;
      pill.dataset.agentId = agent.id;
      // 结论放不下会省略：完整内容在整栏的悬停提示里。
      pill.title = `${model.name} · ${model.headline.text}`;

      const chipsHtml = model.chips
        .map((chip) => (chip.manage
          ? `<button type="button" class="${chipToneClass(chip.tone)} chip-action" data-cli-manage="${escapeHtml(chip.manage.cli)}" data-cli-manage-action="${escapeHtml(chip.manage.action)}" title="打开 配置 → 命令行工具，确认后更新">${escapeHtml(chip.text)}</button>`
          : `<span class="${chipToneClass(chip.tone)}">${escapeHtml(chip.text)}</span>`))
        .join("");

      // 就地修补而非整栏 innerHTML：签名里有"检查 · N 秒前"，几乎每轮都变；
      // 整栏重建会让「详情」按钮丢键盘焦点。
      morphInnerHtml(pill, `
        <span class="agent-health-dot"></span>
        <span class="agent-pill-name">${escapeHtml(model.name)}</span>
        ${agentExpiryBadgeHtml(agentExpiryOf(status, agent.id))}
        <span class="agent-pill-headline agent-tone-${escapeHtml(model.headline.tone)}">${escapeHtml(model.headline.text)}</span>
        <span class="agent-card-meta agent-chip-row">${chipsHtml}</span>
        ${latencyMetricHtml(model.latency)}
        <button type="button" class="text-btn agent-drawer-toggle" aria-expanded="${expanded ? "true" : "false"}" aria-controls="agentStripDrawer">详情<span class="drawer-arrow">▶</span></button>
      `);

      bindCliManageButtons(pill);
      pill.querySelector(".agent-drawer-toggle").onclick = (e) => {
        e.stopPropagation(); // 不触发外层 [data-agent-id] 委托的 agent 切换
        setAgentDrawerExpanded(agent.id, !isAgentDrawerExpanded(agent.id));
        // 展开一个会收起其它的：整条状态带与详情一起按最新数据重画。
        if (lastOverviewArgs) renderAgentOverview(...lastOverviewArgs);
      };
    },
  });

  renderAgentStripDrawer(status, overview, models, bridgeStagesSig);
}

// 详情里的动作（codex / Claude Code）：没装 → 「安装…」（直达命令行工具的安装确认）；装了 / 未知 → 「登录 / 切换账号…」
// （app/cli-login-dialog.js 整页委托 [data-cli-login]）。更新入口只在 chip 上，这里不重复。
export function buildAgentDrawerActionsHtml(agent, cli) {
  const cliId = cliIdForAgent(agent);
  if (!cliId) return "";
  const notInstalled = cli?.installed === false || agent?.health === "not-installed";
  const btn = notInstalled
    ? `<button type="button" class="text-btn" data-cli-manage="${cliId}" data-cli-manage-action="install">安装…</button>`
    : `<button type="button" class="text-btn" data-cli-login="${cliId}">登录 / 切换账号…</button>`;
  return `<div class="agent-drawer-actions">${btn}</div>`;
}

// Codex 客户端（桌面端 / IDE 远程模式）常驻 app-server 的代理端口（v2.85）：
// 后端 doctor 探针顺带读了 /proc/<pid>/environ，这里只说结论；漂移时给「重启守护进程…」。
// 没有守护进程（桌面端没连）时不显示，保持详情干净。
export function buildAppServerNotice(agent, detail) {
  if (agent?.kind !== "codex") return null;
  const info = detail?.appServer;
  if (info?.running !== true) return null;
  const instances = Array.isArray(info.instances) ? info.instances : [];
  const pids = instances.map((item) => item.pid).filter((pid) => Number.isSafeInteger(pid) && pid > 0).join("、") || "—";
  const ports = [...new Set(instances.map((item) => (item.proxyPort == null ? "未设置" : String(item.proxyPort))))].join(" / ") || "—";
  const expected = Number.isInteger(info.expectedPort) ? info.expectedPort : null;
  if (info.mismatch !== true && info.noProxy !== true) {
    return { tone: "ok", text: `PID ${pids} · 代理端口 ${ports}，与当前隧道一致`, restart: false };
  }
  if (info.mismatch === true) {
    return {
      tone: "warn",
      text: `PID ${pids} · 仍走旧代理端口 ${ports}（当前应为 ${expected}）。桌面端发消息会没有回复，重启后恢复。`,
      restart: true,
    };
  }
  return {
    tone: "warn",
    text: `PID ${pids} · 没有走隧道代理（当前应为 ${expected}）。桌面端发消息可能没有回复，重启后恢复。`,
    restart: true,
  };
}

// 状态带下方的通栏详情：展示当前展开的那个 Agent（没有展开的就隐藏）。
let lastDrawerSig = "";

function renderAgentStripDrawer(status, overview, models, bridgeStagesSig) {
  const drawer = getEl("agentStripDrawer");
  if (!drawer) return;
  const agent = overview.find((item) => isAgentDrawerExpanded(item.id));
  if (!agent) {
    if (!drawer.hidden) drawer.hidden = true;
    lastDrawerSig = "";
    return;
  }
  const model = models.get(agent.id);
  const appServerNotice = buildAppServerNotice(agent, status.agentsStatus?.[agent.id]);
  const appServerSig = JSON.stringify(status.agentsStatus?.[agent.id]?.appServer ?? null);
  const sig = `${JSON.stringify(model)}|${bridgeStagesSig}|${appServerSig}`;
  if (sig === lastDrawerSig && !drawer.hidden) return;
  lastDrawerSig = sig;
  const rowsHtml = model.drawer.rows
    .map((row) => `<div class="agent-drawer-row"><span class="agent-drawer-label">${escapeHtml(row.label)}</span><span class="agent-drawer-value">${escapeHtml(row.value)}</span></div>`)
    .join("");
  const appServerHtml = appServerNotice
    ? `<div class="agent-drawer-row" data-level="${appServerNotice.tone}"><span class="agent-drawer-label">Codex 客户端</span><span class="agent-drawer-value">${escapeHtml(appServerNotice.text)}</span></div>` +
      (appServerNotice.restart
        ? `<div class="agent-drawer-actions"><button type="button" class="text-btn" data-codex-app-server-restart="${escapeHtml(status.activeServerId || "")}">重启守护进程…</button></div>`
        : "")
    : "";
  const bridgeHtml = buildBridgeStabilityHtml(status.bridgeStages, model.bridgeWindow)
    || '<div class="agent-drawer-row"><span class="agent-drawer-label">桥接稳定性</span><span class="agent-drawer-value">—</span></div>';
  // v2.57：codex / Claude Code 的详情里给「登录」或「安装」入口。
  const actionsHtml = buildAgentDrawerActionsHtml(agent, cliStateForAgent(agentCliPayload, agent, status.activeServerId));
  // 就地修补：详情里选中的文字、滚动位置不被每轮刷新清掉。
  morphInnerHtml(drawer, `<h3>${escapeHtml(model.name)}</h3>${rowsHtml}${appServerHtml}${bridgeHtml}${actionsHtml}`);
  bindCliManageButtons(drawer);
  drawer.hidden = false;
}

// 桥接稳定性明细（详情内）：数据通路四段各自的探测结论。bridgeWindow 非空时 SSH 隧道一段展示
// 窗口化差值（"1h 内重连 N 次"），否则回退累计值并带「累计」字样。
// 还没有任何一轮结果的段写「尚无数据」（不写成「失败×0」）；耗时为 0 的不写「0ms」。
const BRIDGE_STAGE_LABELS = Object.freeze({
  "local-proxy": "本地代理",
  "ssh-tunnel": "SSH 隧道",
  "remote-port": "远端端口",
  "agent-endpoint": "Agent 端点",
});

export function buildBridgeStabilityHtml(bridgeStages = {}, bridgeWindow = null) {
  const order = Object.keys(BRIDGE_STAGE_LABELS);
  const stages = order.map((stage) => bridgeStages?.[stage]).filter(Boolean);
  if (!stages.length) return "";
  const rows = stages.map((item) => {
    const label = BRIDGE_STAGE_LABELS[item.stage];
    const failures = Number(item.consecutiveFailures) || 0;
    const reported = item.ok === true || item.lastSuccessAt != null || failures > 0;
    if (!reported) return `<span>${label} 尚无数据</span>`;
    const parts = [`${label} ${item.ok ? "稳定" : `失败×${failures}`}`];
    if (Number(item.durationMs) > 0) parts.push(`${Number(item.durationMs)}ms`);
    const windowed = bridgeWindow && item.stage === "ssh-tunnel" ? bridgeWindow : null;
    if (windowed) {
      parts.push(`1h 内重连 ${Number(windowed.reconnects) || 0} 次`);
      parts.push(`1h 内快失败 ${Number(windowed.fastFails) || 0} 次`);
    } else {
      if (item.reconnects != null) parts.push(`累计重连 ${Number(item.reconnects) || 0}`);
      if (item.fastFailures != null) parts.push(`累计快失败 ${Number(item.fastFailures) || 0}`);
    }
    if (item.backoffRemainingMs > 0) parts.push(`退避 ${Math.ceil(item.backoffRemainingMs / 1000)}s`);
    return `<span>${escapeHtml(parts.join(" · "))}</span>`;
  }).join("");
  return `<div class="agent-card-meta bridge-stability"><span>桥接稳定性</span>${rows}</div>`;
}

// 服务器卡的单项指标行（纯函数）。配色走 thresholds.js 的全界面统一分档；条本体与资源面板
// 同一套 .bar-progress.color-* + scaleX（width 恒 100%），不再内联 width/background。
// pct 为 null（离线/未采样）→ 空条 + "-"。
// 简报卡的一栏指标：标签 / 大字 / 细条（条色按阈值分档，写在 bar-progress 的 color-* 类上）。
export function briefMetricRowHtml(label, kind, pct) {
  const known = pct != null && Number.isFinite(Number(pct));
  const color = colorFor(levelFor(kind, known ? pct : null));
  return `<div class="brief-stat" data-color="${color}">` +
    `<span class="brief-metric-label">${escapeHtml(label)}</span>` +
    `<span class="brief-metric-value">${known ? `${escapeHtml(pct)}<small>%</small>` : "-"}</span>` +
    '<div class="brief-metric-bar-container">' +
    `<div class="bar-progress color-${color}" style="width: 100%; transform: ${progressScale(known ? pct : 0)}"></div>` +
    "</div></div>";
}

// 渲染多服务器同屏监控卡片（keyed 增量）。
// v2.18：卡上多了 团队/个人 徽标、隧道胶囊、GPU 行，以及把"切换"正名为"查看"的按钮
// —— 所有隧道常驻，切服务器只改变查看视角（设计稿 §0/§6.8）。
// serverConfigs 是 /api/config 的 servers 数组（带 source/tunnel/disabled）；
// 拿不到时全部字段从 layers.tunnels 回退，两条路都缺就走模型的默认降级。
// probeBackoff = /api/status.probeBackoff.servers（探测已放慢的服务器，见 server-card-model.js 的 slowed）。
export function renderServerBriefs(serversBrief, activeServerId, layers = null, serverConfigs = null, probeBackoff = null) {
  const container = document.getElementById("serverBriefsContainer");
  if (!container) return;
  const briefs = serversBrief && typeof serversBrief === "object" ? serversBrief : {};

  const configById = {};
  for (const s of Array.isArray(serverConfigs) ? serverConfigs : []) {
    if (s && s.id != null) configById[s.id] = s;
  }

  // Config is authoritative after deletion/restoration, even if an older status
  // response is still in flight. New servers get a pending card before sampling.
  const serverIds = Array.isArray(serverConfigs)
    ? Object.values(configById).filter(s => s.disabled !== true && s.monitorEnabled !== false).map(s => s.id)
    : Object.keys(briefs);
  const items = serverIds.map(id => ({
    name: configById[id]?.name || configById[id]?.host || id,
    ...briefs[id], id, config: configById[id] || null,
  }));
  // 空状态节点跨刷新保留（不每轮重建）：键盘焦点停在「添加服务器」上时，状态刷新不会把它弄丢。
  const emptyEl = container.querySelector(".server-briefs-empty");
  if (items.length) emptyEl?.remove();
  reconcileList(container, items, {
    keyFn: (s) => s.id,
    sigFn: (s) => {
      const model = buildServerCardModel({ id: s.id, ...(s.config || {}) }, layers, probeBackoff?.[s.id]);
      return [
        s.id === activeServerId ? 1 : 0,
        s.ok ? 1 : 0,
        s.cpu,
        s.ram,
        s.displayName || s.name,
        model.badge,
        model.tunnelPill,
        model.gpu.map((g) => `${g.label}:${g.memPercent}:${g.util}`).join(","),
        model.slowed?.title ?? "",
      ].join("|");
    },
    createEl: () => document.createElement("div"),
    updateEl: (el, s) => {
      const isActive = s.id === activeServerId;
      const model = buildServerCardModel({ id: s.id, ...(s.config || {}) }, layers, probeBackoff?.[s.id]);
      const extras = buildServerCardExtrasHtml(model);
      el.className = `server-brief-card ${isActive ? "active" : ""}`;
      el.dataset.id = s.id;
      // 版式：首行 名称 + 团队/个人 + 隧道 + 查看；其下一条指标带（CPU / 内存 / GPU 并排，等高）。
      el.innerHTML = `
        <div class="server-brief-header">
          <span class="brief-dot ${s.ok ? "online" : ""}"></span>
          <span class="server-brief-name" title="${escapeHtml(s.displayName || s.name)}">${escapeHtml(s.displayName || s.name)}</span>
          <span class="server-brief-tags">${extras.head}</span>
          <button type="button" class="text-btn server-view-btn" data-view-id="${escapeHtml(s.id)}"${isActive ? " disabled" : ""}
            title="只切换查看视角（重探针与 Agent 视角），隧道不受影响">${isActive ? "查看中" : "查看"}</button>
        </div>
        <div class="server-brief-metrics">
          ${briefMetricRowHtml("CPU", "cpu", s.ok ? s.cpu : null)}
          ${briefMetricRowHtml("内存", "memory", s.ok ? s.ram : null)}
          ${extras.gpu}
        </div>
      `;
    },
  });
  if (!items.length) {
    let empty = emptyEl;
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "server-briefs-empty";
      container.appendChild(empty);
    }
    const kind = Array.isArray(serverConfigs) && serverConfigs.length > 0 ? "off" : "none";
    if (empty.dataset.kind !== kind) {
      empty.dataset.kind = kind;
      empty.innerHTML = serverBriefsEmptyHtml(serverConfigs);
    }
  }
}

// 概览没有服务器卡时的空状态（纯函数）。配置里一台都没有 → 引导添加；有但全部停用 / 关了监控 → 引导去启用。
// 新加的服务器默认「只监控」（设置里的「建隧道」要手动勾选），所以这里不承诺建隧道。
export function serverBriefsEmptyHtml(serverConfigs = null) {
  const configured = Array.isArray(serverConfigs) && serverConfigs.length > 0;
  return emptyStateHtml(configured
    ? {
      tone: "neutral", icon: "server", title: "没有在监控的服务器",
      body: "已添加的服务器都停用了或关闭了监控；在设置里重新启用后，它的简报卡会回到这里。",
      actions: [{ label: "打开设置", kind: "primary", attrs: { "data-dialog": "dlgSettings" } }],
    }
    : {
      tone: "neutral", icon: "serverPlus", title: "还没有添加服务器",
      body: "添加一台能用 SSH 登录的服务器后，工作台每分钟经 SSH 采一次资源（需要隧道时可在设置里勾选），并在这里给出简报卡。",
      actions: [{ label: "添加服务器", kind: "primary", attrs: { "data-dialog": "dlgSettings" } }],
    });
}

// ---- v2.18 本地数据 tile（顶层 storage = { usedBytes, budgetBytes, lastSweepAt, evicted }）----

const BYTES_PER_MB = 1024 * 1024;

// 本地数据 tile 模型（纯函数，便于测试）。
// 分档：≤80% 绿、>80% 黄、超预算红（红同时置 critical，大字转红与磁盘 tile 同口径）。
// percent 供进度条使用，封顶 100——超预算的语义由红色而非溢出的条表达。
export function buildStorageTileModel(storage, { now = Date.now() } = {}) {
  const s = storage && typeof storage === "object" ? storage : {};
  const used = Number(s.usedBytes);
  const budget = Number(s.budgetBytes);
  const available = Number.isFinite(used) && used >= 0 && Number.isFinite(budget) && budget > 0;
  if (!available) {
    return {
      available: false, usedMB: 0, budgetMB: 0, percent: 0,
      colorClass: "green", critical: false, value: "-", sub: "未获取到本地占用",
    };
  }
  const usedMB = Math.round(used / BYTES_PER_MB);
  const budgetMB = Math.round(budget / BYTES_PER_MB);
  const ratio = (used / budget) * 100;
  const colorClass = ratio > 100 ? "red" : ratio > 80 ? "yellow" : "green";
  const parts = [];
  const sweptAt = Number(s.lastSweepAt);
  if (Number.isFinite(sweptAt) && sweptAt > 0) parts.push(`上次清理 ${formatRelativeTime(sweptAt, now)}`);
  const evicted = Number(s.evicted);
  if (Number.isFinite(evicted) && evicted > 0) parts.push(`已淘汰 ${evicted} 项`);
  return {
    available: true,
    usedMB,
    budgetMB,
    percent: Math.max(0, Math.min(100, Math.round(ratio))),
    colorClass,
    critical: colorClass === "red",
    value: `${usedMB}MB / ${budgetMB}MB`,
    sub: parts.join(" · "),
  };
}

// 渲染本地数据 tile。值区/进度条复用 stat tile 与 .bar-progress 既有样式类。
// perf：每轮 render 都会走到这里；以模型本身为签名（含"上次清理 X 分钟前"文案，
// 相对时间变化时自然重渲），模型不变则完全不碰 DOM。
const applyStorageTileModel = createMemoRender((m) => {
  const valEl = getEl("storageVal");
  const barEl = getEl("storageBar");
  const btnEl = getEl("storagePruneBtn");
  if (valEl) {
    valEl.classList.add("stat-cell");
    valEl.innerHTML =
      `<span class="stat-value${m.critical ? " stat-value-crit" : ""}">${escapeHtml(m.value)}</span>` +
      (m.sub ? `<span class="stat-sub">${escapeHtml(m.sub)}</span>` : "");
  }
  if (barEl) {
    barEl.style.width = "100%";
    barEl.style.transform = progressScale(m.percent);
    barEl.className = `bar-progress storage-bar color-${m.colorClass}`;
  }
  if (btnEl) btnEl.disabled = !m.available;
}, (m) => JSON.stringify(m));

export function renderStorageTile(storage, options = {}) {
  if (!getEl("storageVal") && !getEl("storageBar")) return;
  applyStorageTileModel(buildStorageTileModel(storage, options));
}

// 是否启用了带 Doctor 的 Codex（status.agents 只含启用的 Agent；旧配置可能缺 kind，按 id 兜底）。
export function hasDoctorAgent(status) {
  const agents = Array.isArray(status?.agents) ? status.agents : [];
  return agents.some((agent) => agent && (agent.kind === "codex" || (!agent.kind && agent.id === "codex")));
}

// 以活跃 Agent 为视角的诊断数据。status.agents 只含启用的 Agent（v2.47 监控模块）：
// 活跃 id 不在其中时（切换瞬间的旧帧）取第一个启用的；一个都没有时返回 null，调用方显示空态。
// 不再伪造一个 codex 对象——那会让关掉 Codex 后的端点 / Doctor 浮层继续显示 Codex 的旧结论。
export function getActiveAgentView(status) {
  const agents = Array.isArray(status?.agents) ? status.agents : [];
  const agent = agents.find((item) => item && item.id === status.activeAgentId) || agents[0] || null;
  if (!agent) return null;
  const agentStatus = (status.agentsStatus?.[agent.id]) || {};

  if (agent.id === "claude-codewing") {
    // v2.3：端点状态优先取 claude-endpoint 探针的真实 Claude API 探测结果；
    // 尚未探测（首轮/熔断）时回落 daemon 自报的网关状态。
    const ce = status.claudeEndpoint || null;
    const probed = ce && ce.ok != null;
    const endpoint = probed
      ? { ok: ce.ok === true, output: ce.output || "" }
      : {
          ok: agentStatus.gatewayOk === true,
          output: agentStatus.gatewayOutput || agentStatus.output || "Claude API 尚未探测",
        };
    // B1：revoked/banned（账号层故障）与 missing/degraded 同属"失败"，否则详情面板
    // 会显示 0 失败/0 警告，与旁边红色卡片 tag 自相矛盾。
    const diagnosticSummary = {
      ok: agentStatus.health === "ready" ? 1 : 0,
      fail: ["missing", "degraded", "revoked", "banned"].includes(agentStatus.health) ? 1 : 0,
      warn: agentStatus.health === "auth-required" ? 1 : 0,
      notes: 0,
      raw: agentStatus.health || "",
    };
    return {
      agent,
      agentStatus,
      endpoint,
      diagnostic: {
        summary: diagnosticSummary,
        output: agentStatus.output || "ReClaude 状态尚未检测",
      },
      endpointBadge: probed
        ? (ce.ok === true
          ? `Claude API ${ce.target || ""} 可达${ce.latencyMs != null ? ` · ${ce.latencyMs}ms` : ""}`.replace(/\s+/g, " ").trim()
          : `Claude API ${ce.target || ""} 不可达`.replace(/\s+/g, " ").trim())
        : "Claude API 待探测",
      diagnosticBadge: agentStatus.health === "ready"
        ? "ReClaude Ready"
        : agentStatus.health === "revoked"
          ? "设备已解绑"
          : agentStatus.health === "banned"
            ? "账号被封"
            : agentStatus.health || "未运行",
    };
  }

  return {
    agent,
    agentStatus,
    endpoint: status.endpoint || { ok: false, output: "" },
    diagnostic: status.doctor || { summary: { ok: 0, fail: 0, warn: 0, notes: 0, raw: "" }, output: "" },
    endpointBadge: status.endpoint?.ok ? "200 Connection Established" : "测试未通过",
    diagnosticBadge: status.doctor?.summary?.raw
      ? `${status.doctor.summary.ok}通过 | ${status.doctor.summary.fail}失败`
      : "未运行",
  };
}
