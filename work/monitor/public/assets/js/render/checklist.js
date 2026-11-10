import { createElementLookup } from "../dom-utils.js";
import { buildPersistentDownHint, formatClock } from "../store.js";
import { BUTTON_LABELS } from "../ui-labels.js";
import { createMemoRender } from "./render-skip.js";

// DOM 引用惰性获取（dom-utils.createElementLookup：无 document 时返回 null，纯函数可在 Node 测试中导入）
const getEl = createElementLookup();

// 横幅按钮动作（W5）：不再一律"一键修复"——认证/主机密钥/首次配置这类问题重连多少次都不会好，
// 按钮要把人引向真正的下一步。kind 由 app.js 分派：
//   repair        → 一键修复 runbook 预览（原行为）
//   start         → 启动所有连接（stopped 态）
//   open-guide    → 打开接入引导（app/onboarding-guide.js；v2.60 起取代"复制 npm run setup 回终端运行"）
//   hostkey       → 打开服务器管理并发起主机密钥确认
//   reassign-port → 为活跃服务器重新分配反向端口
//   open-settings / doctor → 打开对应浮层
//   none          → 不显示按钮
export const BANNER_ACTIONS = Object.freeze({
  repair: { kind: "repair", label: BUTTON_LABELS.repair },
  start: { kind: "start", label: BUTTON_LABELS.start },
  guide: { kind: "open-guide", label: "开始配置" },
  reconnect: { kind: "open-guide", label: "重新接入…" },
  hostkey: { kind: "hostkey", label: `${BUTTON_LABELS.confirmHostKey}…` },
  reassignPort: { kind: "reassign-port", label: BUTTON_LABELS.reassignPort },
  openSettings: { kind: "open-settings", label: "打开服务器管理" },
  openEgress: { kind: "open-egress", label: "打开出网设置" },
  syncClusterEnv: { kind: "sync-cluster-env", label: "同步到集群" },
  doctor: { kind: "doctor", label: "查看诊断详情" },
  none: { kind: "none", label: "" },
});

const REPAIR = `「${BUTTON_LABELS.repair}」`;

// 活跃服务器的最近一次 SSH 失败归因（/api/status.tunnelFailures，W5 追加字段）。
export function activeTunnelFailure(status) {
  const map = status?.tunnelFailures;
  if (!map || typeof map !== "object") return null;
  const id = status.activeServerId || status.activeServer?.id;
  const failure = id ? map[id] : null;
  return failure && typeof failure.code === "string" ? failure : null;
}

// SSH 隧道断开时按失败归因给"现象 + 下一步"。没有归因时回落通用文案。
// 接入引导只管团队集群那一台；自己加的服务器（personal）出同类问题时引向「服务器管理」。
function tunnelDownMsg(mainServer, failure) {
  const host = mainServer.host;
  switch (failure?.code) {
    case "auth":
      return mainServer.personal
        ? {
          title: "SSH 隧道断开：认证失败",
          body: `连接 ${host} 时 SSH 认证被拒绝（用户名或密钥不对），自动重试不会自己恢复。请在「配置 → 服务器管理」里核对这台服务器的用户名与密钥。`,
          action: BANNER_ACTIONS.openSettings,
        }
        : {
          title: "SSH 隧道断开：认证失败",
          body: `连接 ${host} 时 SSH 认证被拒绝（用户名或密钥不对），自动重试不会自己恢复。点右侧「${BANNER_ACTIONS.reconnect.label}」，核对用户名并重新装一次公钥。`,
          action: BANNER_ACTIONS.reconnect,
        };
    case "hostkey":
      return {
        title: "SSH 隧道断开：主机密钥未确认",
        body: `${host} 的主机密钥尚未确认或已发生变化，为安全起见不会自动重连。请点击右侧「${BUTTON_LABELS.confirmHostKey}」，与管理员提供的指纹核对后保存。`,
        action: BANNER_ACTIONS.hostkey,
      };
    case "timeout":
    case "refused":
      return {
        title: "SSH 隧道断开：连不上服务器",
        body: `连接 ${host} ${failure.code === "timeout" ? "超时" : "被拒绝"}，最常见的原因是当前网络可能不在服务器的 SSH 白名单内（校外或移动网络）。请切回白名单网络后点击${REPAIR}；短时间回不去可先在「${BUTTON_LABELS.control}」里停止所有连接。`,
        action: BANNER_ACTIONS.repair,
      };
    case "dns":
      return mainServer.personal
        ? {
          title: "SSH 隧道断开：找不到服务器",
          body: `无法解析主机名 ${host}。请在「配置 → 服务器管理」里检查这台服务器的地址。`,
          action: BANNER_ACTIONS.openSettings,
        }
        : {
          title: "SSH 隧道断开：找不到服务器",
          body: `无法解析主机名 ${host}：~/.ssh/config 里缺少这个 Host 别名，或者写错了。点右侧「${BANNER_ACTIONS.reconnect.label}」可以重写这一段。`,
          action: BANNER_ACTIONS.reconnect,
        };
    case "remote-port":
      return {
        title: "SSH 隧道断开：远端端口被占用",
        body: `${host} 上的反向端口${mainServer.remotePort != null ? ` ${mainServer.remotePort}` : ""} 已被其他进程占用，重连会一直失败。请点击右侧「${BUTTON_LABELS.reassignPort}」换一个空闲端口。`,
        action: BANNER_ACTIONS.reassignPort,
      };
    case "rate-limit":
      return {
        title: "SSH 隧道断开：尝试次数过多",
        body: `${host} 暂时拒绝了过多的 SSH 尝试。请等待退避结束后自动重连，不要反复点修复；若持续出现，确认只用了一把专用密钥。`,
        action: BANNER_ACTIONS.none,
      };
    default:
      return {
        title: "SSH 隧道断开",
        body: `本机到 ${host} 的 SSH 隧道没有运行，集群里的请求到不了本机。通常是网络短暂抖动或旧连接残留，请点击${REPAIR}。`,
        action: BANNER_ACTIONS.repair,
      };
  }
}

// 探针退避（/api/status.probeBackoff，v2.61）：查看中的服务器 SSH 连不上、工作台已放慢探测时的条目
// { since, nextProbeAt, failures, probing }；没在退避（或后端没开这项）返回 null。
export function activeProbeBackoff(status) {
  const id = status?.activeServerId || status?.activeServer?.id;
  const entry = id ? status?.probeBackoff?.servers?.[id] : null;
  return entry && typeof entry.nextProbeAt === "number" && Number.isFinite(entry.nextProbeAt) ? entry : null;
}

// 横幅上补的一句：状态不再 10 秒一变是因为探测放慢了，不是界面卡住；恢复不用人管。
export function probeBackoffNote(status) {
  const entry = activeProbeBackoff(status);
  if (!entry) return "";
  const when = formatClock(entry.nextProbeAt, { locale: "zh-CN", hour12: false });
  return `服务器暂时连不上，探测已放慢（下次 ${when}），连上后自动恢复正常节奏。`;
}

const ONBOARDING_SETUP_STATES = new Set(["needs-setup", "partial", "no-servers"]);

// 引导卡只在"需要配置 + 连不上"时出现：down 或已停止，且隧道没起来。
export function shouldShowOnboarding(status) {
  if (!ONBOARDING_SETUP_STATES.has(status?.onboarding)) return false;
  if (status.tunnelUp === true) return false;
  return status.health === "down" || status.shouldBeRunning === false;
}

// 命令行向导的精确命令（个人配置不在仓库根时带 CODEX_MONITOR_LOCAL_CONFIG_PATH），缺省 npm run setup。
// 界面已不再引导去终端（接入引导在页面里做完同样的事）；保留给排障报告与旧入口使用。
export function setupCommandFor(status) {
  const cmd = status?.setupCommand;
  return typeof cmd === "string" && cmd.trim() ? cmd : BUTTON_LABELS.setupCommand;
}

// 还没领取反向端口（/api/status.onboardingReason === "missing-port"，或查看中的服务器根本没有端口）：
// 隧道不会建立，这不是故障。团队集群走接入引导（在集群登记目录里原子领取，不会与别人重复）；
// 自己加的服务器没有登记目录，在「服务器管理」里填。
function missingPortMsg(host, { personal = false } = {}) {
  if (personal) {
    return {
      title: "还没填写反向端口",
      body: `${host} 还没有反向端口，所以隧道不会建立。请在「配置 → 服务器管理」里给它填一个。`,
      action: BANNER_ACTIONS.openSettings,
      onboarding: true,
    };
  }
  return {
    title: "还没领取反向端口",
    body: `这台电脑还没有在 ${host} 上领取专属反向端口，所以隧道不会建立。点右侧「${BANNER_ACTIONS.guide.label}」领取（会在集群上登记，不会与别人重复），隧道随后自动建立。`,
    action: BANNER_ACTIONS.guide,
    onboarding: true,
  };
}

// 集群侧受管配置与隧道端口不一致（/api/status.clusterEnv，只对查看中的这台服务器）。没有不一致返回 null。
export function clusterEnvDrift(status, activeServerId) {
  const env = status?.clusterEnv;
  if (env?.state !== "drift" || !activeServerId || env.serverId !== activeServerId) return null;
  const pointsAt = env.envPort != null ? `还指向端口 ${env.envPort}` : "已被改得认不出来";
  const failed = env.lastSync?.ok === false && env.lastSync.error ? `上次自动同步没成功：${env.lastSync.error}。` : "";
  return {
    title: "集群上的代理配置和隧道端口不一致",
    body: `隧道现在用的是端口 ${env.expectedPort}，但集群上的 ~/.config/cluster-workbench/env.sh ${pointsAt}，新开的终端里 codex / claude 会连不上外网。${failed}点右侧「${BANNER_ACTIONS.syncClusterEnv.label}」把它改到 ${env.expectedPort}（先备份，只对新开的终端生效）。`,
    action: BANNER_ACTIONS.syncClusterEnv,
    attention: true,
  };
}

// 横幅文案：一律"现象一句 + 下一步一句"，不出现"一级守护进程/信道"这类内部术语。
export function getDiagnosticMsg(status) {
  const activeServer = status.activeServer || {};
  const mainServer = {
    name: activeServer.name || "myserver",
    host: activeServer.host || "myserver",
    personal: activeServer.source === "personal",
    localPort: activeServer.localPort ?? 8888,
    // 没领端口时是 null：绝不回落 7891（那是别人的端口），下面的 down 分支单独给"未领取"文案。
    remotePort: activeServer.remotePort ?? null,
  };

  const processDiagnostic = status.layers?.channel?.detail?.processQueryDiagnostic;
  if (processDiagnostic) {
    const retry = processDiagnostic.nextRetryAt ? ` 下次检查：${formatClock(processDiagnostic.nextRetryAt, { locale: "zh-CN", hour12: false })}。` : "";
    return { title: "Windows 进程检测暂不可用", body: `${processDiagnostic.message}${retry}`, action: BANNER_ACTIONS.none };
  }

  if (status.health === "waiting") {
    return {
      title: "正在检测连接…",
      body: "正在检查本机代理、SSH 隧道和远端端口，请稍候几秒。",
      action: BANNER_ACTIONS.none,
    };
  }

  // 首次运行引导（/api/status.onboarding，W5 追加字段）：个人配置不存在/向导没走完时全红是必然的，
  // 与其罗列故障不如直接告诉用户先完成配置。但只在"确实连不上"时出现（down 或已停止，且隧道没起来）：
  // 隧道已通、degraded 等真实故障场景一律让真实诊断优先，引导卡不得盖住它们。
  if (shouldShowOnboarding(status)) {
    if (status.onboarding === "no-servers") {
      return {
        title: "没有启用的服务器",
        body: "所有服务器都已禁用，因此没有可建立的连接。请在「配置 → 服务器管理」中启用或添加一台服务器。",
        action: BANNER_ACTIONS.openSettings,
        onboarding: true,
      };
    }
    if (status.onboardingReason === "missing-port") return missingPortMsg(mainServer.host);
    return {
      title: status.onboarding === "partial" ? "首次配置可能没有走完" : "还没完成首次配置",
      body: `工作台还不知道你的集群账号和专属端口，所以连接无法建立。点右侧「${BANNER_ACTIONS.guide.label}」，填写集群用户名和密码，其余自动完成。`,
      action: BANNER_ACTIONS.guide,
      onboarding: true,
    };
  }

  if (!status.shouldBeRunning) {
    return {
      title: "所有连接已停止",
      body: `本机代理和 SSH 隧道都没有运行，集群上的 Agent 暂时无法联网。点击右侧「${BUTTON_LABELS.start}」即可恢复。`,
      action: BANNER_ACTIONS.start,
    };
  }

  // 隧道是通的，但集群上的受管 env.sh 指向另一个端口（界面改了端口而同步没成 / 文件被改过 / 另一台电脑
  // 写的）：新开的终端里 codex / claude 连不上外网，探针却按隧道端口测、一切正常——必须单独说出来。
  const drift = clusterEnvDrift(status, activeServer.id);
  if (drift && (status.health === "ready" || status.health === "degraded")) return drift;

  // 本机出网中断（egressHealth.state === "error"）：SSH 隧道与本机代理都在线，但本机代理连不上上游代理或直连失败。
  if (status.localProxyUp && status.egressHealth?.state === "error" && (status.health === "ready" || status.health === "degraded")) {
    const eg = status.egressHealth;
    const summary = eg.summary || "上游代理不可达";
    const failures = eg.failures?.total ? `（近 5 分钟 ${eg.failures.total} 次失败）` : "";
    return {
      title: `本机出网中断：${summary}`,
      body: `SSH 隧道和本机代理 :${mainServer.localPort} 都在运行，但本机转发出网连续失败${failures}，集群里的 Codex / Claude 请求会在最后一跳中断。点右侧「${BANNER_ACTIONS.openEgress.label}」检查上游代理或切换为直连。`,
      action: BANNER_ACTIONS.openEgress,
      attention: true,
    };
  }

  if (status.health === "ready") {
    return {
      title: "连接正常",
      body: "本机代理、SSH 隧道和远端端口都已就绪，集群上的 Agent 可以正常访问外部接口，无需操作。",
      action: BANNER_ACTIONS.none,
    };
  }

  if (status.health === "degraded") {
    if (!status.supervisorUp) {
      return {
        title: "连接可用，但断线后不会自动恢复",
        body: `后台守护进程没有运行：当前连接仍可用，但一旦断开不会自动重连。建议点击${REPAIR}重新拉起守护进程。`,
        action: BANNER_ACTIONS.repair,
      };
    }
    const summary = status.doctor?.summary || {};
    if (summary.fail > 0 || summary.warn > 0) {
      return {
        title: "连接可用，但远端诊断发现问题",
        body: `连接已通，但远端诊断报告失败: ${summary.fail} 项、警告: ${summary.warn} 项，部分功能可能受影响。点击右侧「查看诊断详情」了解具体项目。`,
        action: BANNER_ACTIONS.doctor,
      };
    }
    return {
      title: "连接可用，但有非致命告警",
      body: `主链路仍然连通，但存在非致命配置告警。可在「日志」中查看详情，必要时点击${REPAIR}。`,
      action: BANNER_ACTIONS.repair,
    };
  }

  if (status.health === "down") {
    // 查看中的服务器确实存在、要建隧道、却根本没有端口（主服务器以外的团队条目也可能没领）：
    // 隧道不会建，别报"隧道断开 / 端口没监听"。
    const unclaimed = Boolean(activeServer.id) && activeServer.tunnel !== false && mainServer.remotePort == null;
    if (unclaimed && status.tunnelUp !== true) return missingPortMsg(mainServer.host, { personal: mainServer.personal });
    const msg = (() => {
      if (!status.localProxyUp) {
        return {
          title: "本机代理没有运行",
          body: `本机 ${mainServer.localPort} 端口上的代理不可用，集群请求无法转发出去。请确认该端口没有被其他软件占用，然后点击${REPAIR}。`,
          action: BANNER_ACTIONS.repair,
        };
      }
      if (!status.tunnelUp) return tunnelDownMsg(mainServer, activeTunnelFailure(status));
      if (!status.remotePortOpen) {
        return {
          title: "远端端口没有在监听",
          body: `${mainServer.host} 上的${mainServer.remotePort != null ? ` ${mainServer.remotePort} ` : "反向"}端口没有在监听，集群里的 Agent 请求会落空。通常是旧连接残留，请点击${REPAIR}清理并重连。`,
          action: BANNER_ACTIONS.repair,
        };
      }
      if (status.endpoint && status.endpoint.ok === false) {
        return {
          title: "外部 API 测试失败",
          body: "本机代理、SSH 隧道和远端端口都正常，但经由通道访问外部 API 失败。请确认本机当前网络能访问外部接口（例如本机代理或 VPN 已开启）。",
          action: BANNER_ACTIONS.none,
        };
      }
      return {
        title: "连接中断",
        body: `链路没有完整建立，集群暂时无法访问外部接口。请点击${REPAIR}尝试重连。`,
        action: BANNER_ACTIONS.repair,
      };
    })();
    const hint = buildPersistentDownHint(status);
    if (hint) msg.body += ` ${hint}`;
    const backoffNote = probeBackoffNote(status);
    if (backoffNote) {
      msg.body += ` ${backoffNote}`;
      // 正文下方多一个「立即探测」（renderAlertBanner 据此显隐 #alertProbeBtn）。
      msg.probeNow = true;
    }
    return msg;
  }

  return { title: "正在处理中", body: "连接正在自愈或初始化，请稍候更新。", action: BANNER_ACTIONS.none };
}

// 未显式给 action 的调用方（app.js 的鉴权失败/执行失败横幅）保持旧行为：down/degraded 显示一键修复。
export function resolveBannerAction(health, info) {
  if (typeof info?.action?.kind === "string") return info.action;
  return health === "down" || health === "degraded" ? BANNER_ACTIONS.repair : BANNER_ACTIONS.none;
}

// 渲染警报栏样式和动作按钮（签名跳过包装：SSE 高频事件下 title/body 未变不重写 DOM）
function renderAlertBannerImpl(health, info) {
  const banner = getEl("alertBanner");
  const title = getEl("alertTitle");
  const body = getEl("alertBody");
  const btn = getEl("alertActionBtn");
  const probeBtn = getEl("alertProbeBtn");

  if (!banner || !title || !body) return;

  // info.attention：链路本身正常、但有必须处理的事（如集群配置与隧道端口不一致）——按"需注意"展开显示。
  const isCompact = health === "ready" && !info?.attention;
  // 首次配置引导沿用 waiting 的中性配色（不是故障，不刷红）。
  const visualHealth = info?.onboarding ? "waiting" : info?.attention && health === "ready" ? "degraded" : health;
  banner.className = `alert-banner state-${visualHealth} ${isCompact ? "is-compact" : ""}${info?.onboarding ? " is-onboarding" : ""}`;
  title.textContent = info.title;
  body.textContent = info.body;
  if (probeBtn) probeBtn.style.display = info?.probeNow === true ? "" : "none";

  if (btn) {
    const action = resolveBannerAction(health, info);
    const visible = action.kind !== "none";
    btn.style.display = visible ? "block" : "none";
    btn.dataset.bannerAction = action.kind;
    if (visible && btn.textContent !== action.label) btn.textContent = action.label;
    btn.title = action.kind === "repair" ? "重启所有连接（先弹预览）" : action.label;
  }
}

export const renderAlertBanner = createMemoRender(
  renderAlertBannerImpl,
  (health, info) => `${health}|${info?.title ?? ""}|${info?.body ?? ""}|${resolveBannerAction(health, info).kind}|${info?.probeNow === true ? 1 : 0}`,
);

// v2.15：健康清单卡不再独立渲染 DOM（原 renderChecklist/updateChecklistItem 已被
// chain.js 的"活链路 + 详情区"取代），文案与状态判定逻辑原样抽为纯数据模型，
// 供 chain.js 点击节点时渲染详情。状态值沿用 chk-status 体系：ok/bad/waiting/stopped。
// 只产出链路主干 4 个节点对应的卡（v2.18.1 起链路不再画 agent 节点，Agent 诊断看顶部 Agent 卡）。
export function buildChecklistModel(status) {
  const run = status.shouldBeRunning;
  const channel = status.networkChannel || {
    localProxyUrl: "http://127.0.0.1:8888",
    // 不再假设 7891：没有通道信息时远端地址未知，按"未领取"显示。
    remoteProxyUrl: null,
    host: "myserver",
  };
  const remoteUrl = channel.remoteProxyUrl || null;
  const channelLayer = status.layers?.channel ? status.layers.channel : null;
  const channelMeta = channelLayer ? { reason: channelLayer.reason || "", checkedAt: channelLayer.checkedAt ?? null } : null;

  const items = [];

  items.push({
    key: "supervisor",
    title: "后台守护进程",
    state: run ? (status.supervisorUp ? "ok" : "waiting") : "stopped",
    desc: status.supervisorUp ? "监视中，如果后台进程挂掉会自动重启" : run ? "正在拉起守护进程..." : "运维守护未启用，通道已手动停止",
    tag: status.supervisorUp ? "守护活跃" : run ? "自愈中" : "未启用",
    meta: channelMeta,
  });

  items.push({
    key: "proxy",
    title: "本机代理服务",
    state: run ? (status.localProxyUp ? "ok" : "waiting") : "stopped",
    desc: status.localProxyUp
      ? `正在本地提供 ${channel.localProxyUrl} 的 HTTPS CONNECT 转发`
      : run
        ? "检测到本地代理关闭，正在自动拉起中..."
        : "本地代理已随通道彻底停止并退出",
    tag: status.localProxyUp ? `${channel.localProxyUrl.replace("http://127.0.0.1:", "")} 监听` : run ? "修复中" : "未启动",
    meta: null,
  });

  items.push({
    key: "tunnel",
    title: "SSH 反向通道",
    state: run ? (status.tunnelUp ? "ok" : "waiting") : "stopped",
    desc: status.tunnelUp
      ? `本地到 ${channel.host} 间的 SSH 反向链路维持正常`
      : run
        ? "反向链路断开，正在配置 SSH 转发端口中..."
        : "反向链路通道已安全断开下线",
    tag: status.tunnelUp ? "SSH 握手" : run ? "修复中" : "未连接",
    meta: null,
  });

  items.push({
    key: "remote",
    title: "远端代理监听",
    state: run ? (status.remotePortOpen ? "ok" : "bad") : "stopped",
    desc: !remoteUrl
      ? "还没领取反向端口，隧道不会建立"
      : status.remotePortOpen
        ? `远端已正常建立 ${remoteUrl} 监听，接收 Agent 流量`
        : run
          ? `远端 ${remoteUrl} 监听未开启，可能存在端口冲突或隧道未拉通`
          : "远端端口已随通道下线而关闭",
    tag: !remoteUrl ? "未领取" : status.remotePortOpen ? `${remoteUrl.replace("http://127.0.0.1:", "")} 监听` : "未开启",
    meta: null,
  });

  return items;
}
