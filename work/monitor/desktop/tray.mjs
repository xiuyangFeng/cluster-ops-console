// tray.mjs —— 菜单栏托盘：状态圆点 + 提示、右键菜单、状态变迁的原生通知（确认延迟）。
//
// 托盘状态：订阅 SSE /api/events 的 status 事件（payload.lite 与 /api/status-lite 同构，
// 仅在层级变化时推送），空闲时零请求；此前每 3s 轮询一次 /api/status-lite。
// 兜底：SSE 掉线/被拒（如连接数上限 503）时立即轮询一次（不可达即刻变红，与旧行为同），
// 并保留 30s 低频轮询——SSE 未连上或 30s 内没收到 status 事件时拉一次，覆盖 headline 等
// 非层级变化与假死连接。待确认告警由定时器按 dueAt 冲刷，不再依赖 3s 轮询顺带推进。

import fs from "node:fs";

import { updateAlertQueue } from "../desktop-lifecycle.mjs";
import { loadLayeredConfig } from "../lib/config-loader.mjs";
import { buildUpdateMenuLabel } from "../lib/control-plane-restart.mjs";
import { createSseSubscription } from "../lib/sse-client.mjs";
import { GLANCE_METRIC_LABELS, GLANCE_METRICS } from "../public/assets/js/render/glance-model.js";
import { renderTrayIconBitmap, TRAY_ICON_PX } from "./tray-icon.mjs";

const TRAY_COLORS = { idle: "#9ca3af", ready: "#34d399", warn: "#fbbf24", down: "#f87171" };
const DEFAULT_ALERT_CONFIRM_MS = 30000;
const NOTIFY_DEBOUNCE_MS = 60000; // per-key 60s 抖动抑制
const TRAY_POLL_MS = 30000;
const TRAY_FIRST_CONNECT_MS = 3000;

export function healthLabel(health) {
  const labels = {
    ready: "正常",
    degraded: "降级",
    down: "异常",
    stopped: "已停止",
    waiting: "检测中",
    setup: "未领取端口",
  };
  return labels[health] || "未知";
}

// T02：transport 与 Agent 能力分离——托盘颜色/提示只描述数据通路 + 摘要
// headline；旧后端无 summary 时回落 legacy health 映射。
export function trayHealthFromStatus(status) {
  const summary = status.summary && status.summary.schemaVersion === 1 ? status.summary : null;
  // setup = 还没领反向端口（配置未完成，不是断线）：图标灰色、提示「未领取端口」，不按异常刷红。
  const transportToHealth = { connected: "ready", disconnected: "down", stopped: "stopped", unknown: "waiting", setup: "setup" };
  const health = summary
    ? (transportToHealth[summary.transport.state] || "waiting")
    : (status.health || "down");
  return { summary, health };
}

export function trayIconColor(health, summary) {
  let iconColor = TRAY_COLORS.idle;
  if (health === "ready") iconColor = TRAY_COLORS.ready;
  else if (health === "degraded") iconColor = TRAY_COLORS.warn;
  else if (health === "unknown" || health === "waiting") iconColor = TRAY_COLORS.warn;
  else if (health === "down") iconColor = TRAY_COLORS.down;
  // transport 已连接但存在待处理检查（Agent attention / 其它服务器隧道断开）：
  // 数据通路是好的，图标回 amber 提醒，headline 说明具体是什么。
  if (health === "ready" && summary && Number(summary.incidentCount) > 0) iconColor = TRAY_COLORS.warn;
  return iconColor;
}

// v2.3 告警确认延迟：→error 先挂起 confirmMs（默认 30s，可经 config.json alerting.confirmMs 覆盖），
// 期间自愈则静默，避免瞬时抖动打扰。
export function readAlertConfirmMs(configPath, readFileSync = fs.readFileSync) {
  try {
    const cfgRaw = JSON.parse(readFileSync(configPath, "utf8"));
    if (Number(cfgRaw?.alerting?.confirmMs) > 0) return Number(cfgRaw.alerting.confirmMs);
  } catch {}
  return DEFAULT_ALERT_CONFIRM_MS;
}

// 界面上的服务器简称：去掉括号里的主机别名与「服务器」后缀（与前端 display-names.js 同一规则）。
function shortServerName(name) {
  const text = String(name || "");
  return text.replace(/\s*\(.*\)\s*$/, "").replace(/服务器$/, "") || text;
}

// 状态变迁 → 通知文案（纯函数）。此前正文是内部键与级别原文（"tunnel:server-aliyun: ok → error"），
// 这里写成界面用语：哪台服务器的隧道 / 哪个 Agent / 当前查看的数据通道，出了什么事。
// names = { servers: { id: 名称 }, agents: { id: 名称 }, activeServerId }；查不到名称时退回 id。
export function describeTransitionNotice(transition, kind, names = {}) {
  const key = String(transition?.key || "");
  const reason = transition?.reason ? String(transition.reason) : "";
  const serverName = (id) => (names.servers?.[id] ? shortServerName(names.servers[id]) : id);
  let subject = key;
  let failed = "异常";
  let title = "连接告警";
  if (key === "channel") {
    subject = names.activeServerId ? `${serverName(names.activeServerId)}的数据通道` : "数据通道";
    failed = "中断";
  } else if (key.startsWith("tunnel:")) {
    subject = `${serverName(key.slice("tunnel:".length))}的隧道`;
    failed = "断开";
  } else if (key.startsWith("agent:")) {
    const id = key.slice("agent:".length);
    subject = names.agents?.[id] || id;
    failed = " 不可用";
    title = "Agent 告警";
  }
  if (kind === "recovery") return { title: "已恢复", body: `${subject}${key.startsWith("agent:") ? " " : ""}已恢复` };
  return { title, body: `${subject}${failed}${reason ? `：${reason}` : ""}` };
}

export function createTrayController({
  ctx,
  Tray,
  Menu,
  nativeImage,
  Notification,
  nativeTheme = null,
  fetchImpl = fetch,
  subscribe = createSseSubscription,
  readFileSync = fs.readFileSync,
  existsSync = fs.existsSync,
  loadConfig = loadLayeredConfig,
  now = Date.now,
  timers = globalThis,
  logger = console,
  platform = process.platform,
}) {
  const { state, actions, runtimePaths, monitorBaseUrl, statusLiteUrl, authToken } = ctx;
  const trayIcons = new Map();
  let lastKnownHealth = "waiting";
  let lastRenderedTrayHealth = "";
  // 状态变迁的原生通知：per-key 60s 抖动抑制；仅在启动后发生的变迁才提醒（不回放历史）。
  const notifiedAt = new Map(); // key -> 上次通知时间戳
  let lastTransitionTs = now();
  const pendingAlerts = new Map(); // key -> { transition, dueAt, notified }
  const alertConfirmMs = readAlertConfirmMs(runtimePaths.configPath, readFileSync);
  let trayPollInFlight = false;
  let lastTrayStatusAt = 0;
  let alertFlushTimer = null;

  // 托盘图标：与 Dock 图标同造型的单色字形 + 右下角状态色点（像素位图，见 tray-icon.mjs）。
  // 字形颜色跟随系统外观（深色白 / 浅色黑），外观切换时按当前状态色重绘。
  let currentTrayColor = TRAY_COLORS.idle;
  function getTrayIcon(color) {
    currentTrayColor = color;
    const dark = nativeTheme ? nativeTheme.shouldUseDarkColors !== false : true;
    const key = `${color}|${dark ? "dark" : "light"}`;
    if (trayIcons.has(key)) return trayIcons.get(key);
    const icon = nativeImage.createFromBitmap(renderTrayIconBitmap(color, { dark }), { width: TRAY_ICON_PX, height: TRAY_ICON_PX, scaleFactor: 2 });
    trayIcons.set(key, icon);
    return icon;
  }

  // 把托盘置为红色异常态（monitor-server 反复崩溃 / 状态拉取失败）
  function markTrayDown(tooltip = "监控服务不可达") {
    lastKnownHealth = "down";
    if (state.tray && lastRenderedTrayHealth !== "down") {
      state.tray.setImage(getTrayIcon(TRAY_COLORS.down));
      state.tray.setToolTip(`集群运维工作台 · ${tooltip}`);
      lastRenderedTrayHealth = "down";
    }
  }

  // 通知文案用的名称表：读分层配置里的服务器 / Agent 名称（读不到就退回 id，不影响通知发出）。
  function loadNoticeNames() {
    try {
      if (!existsSync(runtimePaths.configPath)) return {};
      const parsed = loadConfig({ configPath: runtimePaths.configPath, localConfigPath: runtimePaths.localConfigPath });
      const byId = (list) => Object.fromEntries((Array.isArray(list) ? list : []).filter((item) => item?.id).map((item) => [item.id, item.name || item.id]));
      return { servers: byId(parsed.servers), agents: byId(parsed.agents), activeServerId: parsed.activeServerId || "" };
    } catch {
      return {};
    }
  }

  function showTrayNotifications(toNotify, toRecover) {
    const outgoing = [
      ...toNotify.map((t) => ({ ...t, kind: "alert" })),
      ...toRecover.map((t) => ({ ...t, kind: "recovery" })),
    ];
    let names = null; // 确有通知要发时才读一次配置
    for (const t of outgoing) {
      const last = notifiedAt.get(t.key) || 0;
      if (now() - last < NOTIFY_DEBOUNCE_MS) continue; // per-key 60s 抖动抑制（保留）
      notifiedAt.set(t.key, now());
      names ??= loadNoticeNames();
      const n = new Notification(describeTransitionNotice(t, t.kind, names));
      n.on("click", () => {
        const win = state.mainWindow;
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
        }
      });
      n.show();
    }
  }

  // 确认期到点冲刷：旧实现靠 3s 轮询顺带推进 updateAlertQueue；改推送后状态不变就没有
  // 下一次调用，这里按最早 dueAt 定时补一次（transitions 为空，只做到期确认）。
  function scheduleAlertFlush() {
    if (alertFlushTimer) {
      timers.clearTimeout(alertFlushTimer);
      alertFlushTimer = null;
    }
    let earliest = Infinity;
    for (const item of pendingAlerts.values()) {
      if (!item.notified && item.dueAt < earliest) earliest = item.dueAt;
    }
    if (!Number.isFinite(earliest)) return;
    alertFlushTimer = timers.setTimeout(() => {
      alertFlushTimer = null;
      if (!state.statusInterval) return; // 应用正在退出
      const { toNotify, toRecover } = updateAlertQueue({ pending: pendingAlerts, transitions: [], now: now(), confirmMs: alertConfirmMs });
      showTrayNotifications(toNotify, toRecover);
      scheduleAlertFlush();
    }, Math.max(0, earliest - now()) + 50);
    if (typeof alertFlushTimer.unref === "function") alertFlushTimer.unref();
  }

  function applyTrayStatus(status) {
    if (!status || typeof status !== "object") return;
    lastTrayStatusAt = now();
    const { summary, health } = trayHealthFromStatus(status);
    lastKnownHealth = health;

    if (lastRenderedTrayHealth !== health) {
      state.tray.setImage(getTrayIcon(trayIconColor(health, summary)));
      const tooltipText = summary?.headline ? summary.headline : healthLabel(health);
      state.tray.setToolTip(`集群运维工作台 · ${tooltipText}`);
      lastRenderedTrayHealth = health;
    }

    // 状态变迁 → 确认延迟队列（resources 层负载波动不打扰；确认期内自愈则静默）。
    const transitions = (status.recentTransitions || []).filter(
      (t) => t.ts > lastTransitionTs && t.layer !== "resources",
    );
    const { toNotify, toRecover } = updateAlertQueue({
      pending: pendingAlerts,
      transitions,
      now: now(),
      confirmMs: alertConfirmMs,
    });
    showTrayNotifications(toNotify, toRecover);
    if (transitions.length) {
      lastTransitionTs = Math.max(lastTransitionTs, ...transitions.map((t) => t.ts));
    }
    scheduleAlertFlush();
  }

  async function pollTrayStatusOnce() {
    if (trayPollInFlight) return; // 上一次仍在途则跳过，避免慢响应下并发堆积
    trayPollInFlight = true;
    try {
      const response = await fetchImpl(statusLiteUrl, {
        headers: { "x-auth-token": authToken },
        // 超时要显著宽于正常响应（后端轮转大日志/重探针时可能 >3s），
        // 只拦截真正挂死的请求；过紧会把"慢但健康"误判成红色不可达。
        signal: AbortSignal.timeout(8000),
      });
      applyTrayStatus(await response.json());
    } catch {
      markTrayDown();
    } finally {
      trayPollInFlight = false;
    }
  }

  // 创建顶部状态栏托盘 (Tray)
  function createTray() {
    if (state.tray) return;
    state.tray = new Tray(getTrayIcon(TRAY_COLORS.idle));
    state.tray.setToolTip("集群运维工作台");
    // 系统外观切换（浅色 / 深色）：按当前状态色重绘字形
    nativeTheme?.on?.("updated", () => state.tray?.setImage(getTrayIcon(currentTrayColor)));

    // 点击托盘图标，交替弹出/隐藏我们的状态卡片
    state.tray.on("click", () => {
      actions.toggleIslandWindow();
    });

    // 右键点击时弹出原生上下文菜单，防冲突
    state.tray.on("right-click", () => {
      state.tray.popUpContextMenu(buildTrayMenu());
    });

    const traySse = subscribe({
      url: `${monitorBaseUrl}/api/events`,
      headers: { "x-auth-token": authToken },
      // cleanupBackground 置空 statusInterval / serverExiting 即视为退出中：停止重连。
      shouldRun: () => state.statusInterval !== null && !state.serverExiting,
      onEvent: ({ event, data }) => {
        if (event !== "status") return;
        try {
          applyTrayStatus(JSON.parse(data)?.lite);
        } catch {}
      },
      onDown: () => {
        if (state.statusInterval !== null && !state.serverExiting) pollTrayStatusOnce();
      },
      // 回环地址上的重连尝试几乎零成本；封顶 5s 保证 monitor 重启后托盘 ≤5s 复绿
      //（旧 3s 轮询的恢复时延量级），而不是退避到 30s 还红着。
      backoffBaseMs: 1000,
      backoffMaxMs: 5000,
    });

    state.statusInterval = timers.setInterval(() => {
      if (state.serverExiting) {
        traySse.stop();
        return;
      }
      if (!traySse.isConnected()) traySse.start();
      if (!traySse.isConnected() || now() - lastTrayStatusAt >= TRAY_POLL_MS) pollTrayStatusOnce();
    }, TRAY_POLL_MS);
    // 首次订阅延后 3s：与旧实现首拍时机一致，monitor 冷启动期间托盘保持灰色"等待"，
    // 而不是因连接被拒闪一下红。
    const firstConnect = timers.setTimeout(() => {
      if (state.statusInterval !== null && !state.serverExiting) traySse.start();
    }, TRAY_FIRST_CONNECT_MS);
    if (typeof firstConnect.unref === "function") firstConnect.unref();
  }

  function loadServerSubmenu() {
    try {
      if (!existsSync(runtimePaths.configPath)) return [];
      const parsed = loadConfig({
        configPath: runtimePaths.configPath,
        localConfigPath: runtimePaths.localConfigPath,
      });
      if (!parsed.servers || !Array.isArray(parsed.servers)) return [];
      return parsed.servers.map((s) => ({
        label: s.name,
        type: "checkbox",
        checked: s.id === parsed.activeServerId,
        click: () => {
          triggerActiveServerChange(s.id);
        },
      }));
    } catch (err) {
      logger.error("Failed to load server submenu:", err.message);
      return [];
    }
  }

  function buildTrayMenu() {
    const serverSubmenu = loadServerSubmenu();
    const template = [
      { label: `状态：${healthLabel(lastKnownHealth)}`, enabled: false },
    ];
    if (state.pendingBundleUpdate) {
      template.push({ label: buildUpdateMenuLabel(state.pendingBundleUpdate), click: () => actions.restartControlPlane("tray-update") });
    }
    template.push(
      { type: "separator" },
      { label: "打开主控制台", click: () => actions.createMainWindow() },
      {
        label: "隐藏主控制台",
        enabled: Boolean(state.mainWindow),
        click: () => state.mainWindow?.hide(),
      },
      { label: "显示状态面板", click: () => actions.toggleIslandWindow() },
    );
    // 钉在桌面：常驻、可拖动、记住位置（windows.mjs）。勾选值取菜单打开那一刻的状态。
    const pinned = actions.isIslandPinned() === true;
    template.push({ label: "状态面板钉在桌面", type: "checkbox", checked: pinned, click: () => actions.setIslandPinned(!pinned) });
    // 托盘图标旁的数字（tray-glance.mjs）只有 macOS 菜单栏能显示。
    if (platform === "darwin") {
      const metric = actions.getTrayMetric();
      template.push({
        label: "菜单栏显示",
        submenu: GLANCE_METRICS.map((key) => ({
          label: GLANCE_METRIC_LABELS[key],
          type: "radio",
          checked: key === metric,
          click: () => actions.setTrayMetric(key),
        })),
      });
    }

    if (serverSubmenu.length > 0) {
      template.push({
        label: "选择活动服务器",
        submenu: serverSubmenu,
      });
    }

    template.push(
      { type: "separator" },
      // T04a：托盘的一键修复 = 重启所有连接（守护 + 代理 + 全部隧道），文案与主窗口一致。
      { label: "重启所有连接（完整通道自愈）", click: () => triggerApiAction("restart") },
      // 热更新 B：只重启界面与 monitor-server，supervisor/代理/隧道保持运行。
      { label: "重启界面（隧道不中断）", click: () => actions.restartControlPlane("tray") },
      { type: "separator" },
      { label: "退出并停止后台", click: () => actions.requestQuit() },
    );

    return Menu.buildFromTemplate(template);
  }

  async function triggerActiveServerChange(serverId) {
    try {
      await fetchImpl(`${monitorBaseUrl}/api/config/active`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-token": authToken,
        },
        body: JSON.stringify({ activeServerId: serverId }),
      });
      // POST /api/config/active 会触发后端 refreshConfigIntoKernel 并通过 SSE 实时推送最新状态，
      // 主窗口与托盘均走增量更新，无需调用 win.loadURL 整页刷新。
    } catch (err) {
      logger.error("Failed to switch active server via tray:", err.message);
    }
  }

  // 辅助函数：通过 HTTP 调用后端 API
  async function triggerApiAction(action) {
    try {
      await fetchImpl(`${monitorBaseUrl}/api/${action}`, {
        method: "POST",
        headers: { "x-auth-token": authToken },
      });
    } catch (err) {
      logger.error(`Failed to trigger ${action}:`, err.message);
    }
  }

  return { createTray, markTrayDown, applyTrayStatus, buildTrayMenu };
}
