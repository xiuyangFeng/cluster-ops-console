// command-palette.js —— 极客全局命令面板 (⌘K / Ctrl+K)
import { emptyStateHtml } from "./empty-state.js";
import { hasDoctorAgent } from "./render/overview.js";
import { escapeHtml } from "./store.js";
import { showToast } from "./toast.js";
import { copyText } from "./dom-utils.js";
import { BUTTON_LABELS, shortcutList } from "./ui-labels.js";
import {
  buildProxyEnvCommand,
  canScopedRestart,
  formatConnectionTargetLine,
  LOCAL_SHELLS,
  REASON_CODE,
  resolveConnectionTarget,
  resolveCurrentTarget,
} from "./connection-target.js";

/**
 * 创建全局命令面板控制器
 * @param {Object} options
 * @param {HTMLDialogElement} options.dialogEl - 命令面板 Dialog 元素
 * @param {HTMLInputElement} options.inputEl - 搜索输入框
 * @param {HTMLElement} options.listEl - 结果列表容器
 * @param {Function} options.onAction - 通道动作触发 (action: "start"|"restart"|"stop"|"refresh")
 * @param {Function} options.onRepair - 打开"重启所有连接"的 runbook 预览（T04a：restart 统一走预览）
 * @param {Function} options.onScopedRestart - 单隧道重启 (serverId)，仅能力声明时显示（T04b）
 * @param {Function} options.onSwitchServer - 服务器切换 (serverId: string)
 * @param {Function} options.onSwitchAgent - Agent 切换 (agentId: string)
 * @param {Function} options.onOpenDialog - 打开指定 Dialog (dialogId: string)
 * @param {Function} options.onSetTheme - 切换外观 (pref: "light"|"system"|"dark"，强调色固定霓虹青)
 * @param {Function} options.getStatus - 获取最新 status 对象
 * @param {Function} options.getConfig - 获取最新 config 对象
 */
export function createCommandPalette({
  dialogEl,
  inputEl,
  listEl,
  onAction,
  onRepair,
  onScopedRestart,
  onSwitchServer,
  onSwitchAgent,
  onOpenDialog,
  onSetTheme,
  onTeamCommand,
  getStatus,
  getConfig,
}) {
  let selectedIndex = 0;
  let filteredCommands = [];
  // 关闭后把焦点送回打开前的元素：⌘K 常在读代码 / 停在某个按钮上时按下，
  // 关掉面板后焦点若掉到 body，键盘用户要从头 Tab 一遍。
  const doc = dialogEl?.ownerDocument || listEl?.ownerDocument || (typeof document !== "undefined" ? document : null);
  let returnFocus = null;

  function restoreFocus() {
    const target = returnFocus;
    returnFocus = null;
    if (!target || target === doc?.body || target.isConnected === false || typeof target.focus !== "function") return;
    // 执行命令后又打开了别的模态浮层（如「通道控制」）：焦点归那个浮层，不要抢回来。
    const modal = doc?.querySelector?.("dialog:modal");
    if (modal && modal !== dialogEl) return;
    target.focus({ preventScroll: true });
  }

  // 可访问性：结果列表为 listbox，活动项经 aria-activedescendant 挂在持焦的输入框上
  //（renderList 每次重建列表与方向键移动时都会同步）。
  listEl?.setAttribute("role", "listbox");
  listEl?.setAttribute("aria-label", "命令搜索结果");

  // 补全标准 combobox 组合：持焦元素是输入框，展开态与"列表归属"都声明在它上面。
  // 此前只设了 aria-activedescendant，读屏不知道输入框控制着哪个列表、当前是否展开；
  // 同时选项还带 tabindex="0"，Tab 会把真实焦点移进列表，与 activedescendant 冲突
  // （两者同时生效时读屏会同时播报"列表项"和"输入框的虚拟活动项"）。
  if (listEl && !listEl.id) listEl.id = "cmdList";
  if (inputEl) {
    inputEl.setAttribute("role", "combobox");
    inputEl.setAttribute("aria-autocomplete", "list");
    inputEl.setAttribute("aria-haspopup", "listbox");
    inputEl.setAttribute("aria-expanded", "false");
    if (listEl?.id) inputEl.setAttribute("aria-controls", listEl.id);
  }

  function setExpanded(expanded) {
    inputEl?.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  function syncActiveDescendant() {
    if (!inputEl) return;
    if (filteredCommands.length > 0) {
      inputEl.setAttribute("aria-activedescendant", `cmd-opt-${selectedIndex}`);
    } else {
      inputEl.removeAttribute("aria-activedescendant");
    }
  }

  function buildAllCommands() {
    const status = getStatus ? getStatus() : null;
    const config = getConfig ? getConfig() : null;
    const commands = [];

    // 通道控制动作（T04a：全局动作统一标注影响范围；restart 走 runbook 预览层，
    // 与控制面板/粘性条同一确认流程，命令面板绕不过预览）。
    commands.push(
      {
        id: "action-start",
        title: BUTTON_LABELS.start,
        aliases: "start all connections control",
        category: "通道控制",
        // action() 自己负责"正在执行/已完成/失败"的 toast，面板不再重复提示。
        run: () => onAction?.("start"),
      },
      {
        id: "action-restart",
        title: `${BUTTON_LABELS.restart} / 一键修复（先弹预览）`,
        aliases: "restart all repair fix control",
        category: "通道控制",
        run: () => {
          if (typeof onRepair === "function") {
            onRepair();
            return;
          }
          // 未接 runbook 回调（旧调用方/测试）时保持旧直连行为（toast 由 action() 负责）。
          onAction?.("restart");
        },
      },
      {
        id: "action-stop",
        title: BUTTON_LABELS.stop,
        aliases: "stop all connections danger",
        category: "通道控制",
        // 取消确认框时 action() 返回 false 且不发请求——面板不得再报"已发出"。
        run: () => onAction?.("stop"),
      },
      {
        id: "action-refresh",
        title: "立即刷新监控状态",
        aliases: "refresh now sync",
        category: "通道控制",
        run: async () => {
          const ok = await onAction?.("refresh");
          if (ok !== false) showToast({ type: "success", message: "状态已刷新", title: "实时同步" });
        },
      }
    );

    // 诊断与浮层入口
    commands.push(
      {
        id: "dialog-control",
        title: "打开通道控制面板",
        aliases: "control panel dialog",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgControl"),
      },
      {
        id: "dialog-timeline",
        title: "查看状态变更时间线",
        aliases: "timeline dialog",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgTimeline"),
      },
      {
        id: "dialog-bootstrap",
        title: `打开${BUTTON_LABELS.offlineInstall}（7 步）`,
        aliases: "bootstrap offline install wizard reclaude",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgBootstrap"),
      },
      {
        id: "dialog-logs",
        title: "查看运维与修复操作日志",
        aliases: "logs dialog",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgLogs"),
      },
      {
        id: "dialog-endpoint",
        title: "查看 API 端点检测响应报文",
        aliases: "endpoint api dialog",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgEndpoint"),
      },
      // Doctor 浮层：Codex 监控关闭时不列（与页头「Doctor」按钮同一规则）。
      ...(hasDoctorAgent(status) ? [{
        id: "dialog-doctor",
        title: "查看 Codex Doctor 详细检查输出",
        aliases: "doctor dialog",
        category: "诊断浮层",
        run: () => onOpenDialog?.("dlgDoctor"),
      }] : []),
      {
        id: "dialog-changelog",
        title: "查看系统更新日志与版本历史",
        aliases: "changelog version help",
        category: "帮助与版本",
        run: () => onOpenDialog?.("changelogModal"),
      },
      {
        id: "help-shortcuts",
        title: "键盘快捷键帮助（也可直接输入 ?）",
        aliases: "? help shortcuts keyboard hotkey",
        category: "帮助与版本",
        keepOpen: true,
        run: () => showHelp(),
      }
    );

    // 服务器快速切换
    if (config?.servers && config.servers.length > 0) {
      config.servers.forEach((srv) => {
        const isCurrent = status?.activeServerId === srv.id;
        commands.push({
          id: `server-${srv.id}`,
          title: `切换监控服务器: ${srv.name || srv.id} (${srv.host})${isCurrent ? " [当前活动]" : ""}`,
          category: "服务器切换",
          aliases: isCurrent ? "active" : "server",
          run: () => {
            if (!isCurrent) {
              onSwitchServer?.(srv.id);
              showToast({ type: "info", message: `已切换至服务器 ${srv.name || srv.id}`, title: "服务器切换" });
            }
          },
        });
      });
    }

    // Agent 视角切换：只列启用的 Agent（status.agents 已按监控模块过滤；状态未到时退到配置）。
    const agents = Array.isArray(status?.agents) ? status.agents : (Array.isArray(config?.agents) ? config.agents : []);
    if (agents.length > 0) {
      agents.forEach((agent) => {
        const isCurrent = status?.activeAgentId === agent.id;
        commands.push({
          id: `agent-${agent.id}`,
          title: `切换诊断视角: ${agent.name} (${agent.kind === "reclaude" ? "ReClaude" : "Doctor"})${isCurrent ? " [当前活动]" : ""}`,
          category: "Agent 视角",
          aliases: isCurrent ? "active" : "agent",
          run: () => {
            if (!isCurrent) {
              onSwitchAgent?.(agent.id);
              showToast({ type: "info", message: `已切换视角为 ${agent.name}`, title: "Agent 诊断" });
            }
          },
        });
      });
    }

    // T01 连接目标与命令复制：全项目唯一入口是 connection-target.js 的纯函数。
    // 端口只从已校验的连接目标取（优先 supervisor 运行快照，缺失降级配置值），
    // 绝不读取 status.remotePort 探针对象当端口（A01 [object Object] 根因）。
    const activeServerId = status?.activeServerId || config?.activeServerId || "";
    const resolvedTarget = resolveConnectionTarget({ status, config, serverId: activeServerId });
    const configServers = Array.isArray(config?.servers) ? config.servers : [];
    const activeServerName = configServers.find((s) => s?.id === activeServerId)?.name || activeServerId;

    // 执行时的上下文绑定（A05）：面板打开后服务器被切换（如托盘切服）→ 拒绝复制旧目标。
    // 复核按"此刻"的查看选择解析（resolveCurrentTarget），并按此刻的目标重建命令。
    // 剪贴板不可用时 copyText 弹可全选输入框兜底，此时不报"已复制"。
    const copyEnvCommand = async (options, { failText, successToast }) => {
      const current = resolveCurrentTarget({ status: getStatus?.() || status, config: getConfig?.() || config, expectedServerId: activeServerId });
      if (!current.ok) {
        showToast({ type: "warn", message: "已切换查看的服务器，本次复制已取消；请重新打开命令面板", title: "复制取消" });
        return;
      }
      const built = buildProxyEnvCommand({ target: current.target, ...options });
      if (!built.ok) {
        if (failText) showToast({ type: "warn", message: failText(built), title: "剪贴板" });
        return;
      }
      if (await copyText(built.command)) showToast(successToast(built, current.target));
    };

    if (resolvedTarget.target) {
      const remote = buildProxyEnvCommand({ target: resolvedTarget.target, scope: "remote" });
      if (remote.ok) {
        commands.push({
          id: "copy-remote-env",
          title: `复制集群远端代理环境变量（远端 POSIX sh）— ${formatConnectionTargetLine({ target: resolvedTarget.target, scope: "remote", serverName: activeServerName })}`,
          category: "极客工具",
          aliases: "copy",
          run: () => copyEnvCommand({ scope: "remote" }, {
            failText: (built) => `远端端口未确认（${built.reasonCode}），未复制`,
            successToast: (built, target) => ({
              type: "success",
              message: `已复制远端代理变量（${built.sourceLabel}，端口 ${target.remotePort?.value ?? "?"}）`,
              title: "剪贴板",
            }),
          }),
        });
      }
      // 本机命令：M1 支持 bash/zsh（未实现的 shell 不显示入口）。
      for (const shell of LOCAL_SHELLS) {
        const local = buildProxyEnvCommand({ target: resolvedTarget.target, scope: "local", shell });
        const portLabel = resolvedTarget.target.localPort?.value != null
          ? `:${resolvedTarget.target.localPort.value}`
          : "（运行端口尚未确认）";
        if (local.ok) {
          commands.push({
            id: `copy-local-env-${shell}`,
            title: `复制本机代理环境变量（${shell}）— ${formatConnectionTargetLine({ target: resolvedTarget.target, scope: "local", serverName: activeServerName })}`,
            category: "极客工具",
            aliases: "copy",
            run: () => copyEnvCommand({ scope: "local", shell }, {
              failText: (built) => `本机运行端口尚未确认（${built.reasonCode}），未复制`,
              successToast: (built, target) => ({
                type: "success",
                message: `已复制本机代理变量（${shell}，${built.sourceLabel}，端口 ${target.localPort?.value ?? "?"}）`,
                title: "剪贴板",
              }),
            }),
          });
        } else if (local.reasonCode === REASON_CODE.ERR_LOCAL_PORT_UNCONFIRMED) {
          // 配置值不冒充运行端口：本地复制禁用，但保留一条说明性条目（不可复制）。
          commands.push({
            id: `copy-local-env-${shell}-unconfirmed`,
            title: `本机代理环境变量（${shell}）— ${activeServerName} · 本机 ${portLabel} · 需启动通道后重试`,
            category: "极客工具",
            aliases: "不可用",
            run: () => {
              showToast({ type: "warn", message: "本地代理运行端口尚未经运行快照确认（旧版守护进程或未启动），不提供复制", title: "运行端口未确认" });
            },
          });
        }
      }
      if (resolvedTarget.target.tunnelEnabled === false) {
        commands.push({
          id: "copy-remote-env-example",
          title: `远端代理变量（配置示例）— ${formatConnectionTargetLine({ target: resolvedTarget.target, scope: "remote", serverName: activeServerName })}（该服务器为仅监控，不建隧道）`,
          category: "极客工具",
          aliases: "示例",
          run: () => copyEnvCommand({ scope: "remote" }, {
            successToast: () => ({ type: "info", message: "已复制配置示例（该服务器 tunnel:false，非当前可用连接）", title: "剪贴板" }),
          }),
        });
      }

      // T04b 单隧道重启：只有运行快照明确声明能力才显示（判据见 canScopedRestart，
      // 与服务器页按钮、端口重分配后的收尾同一处）；旧 supervisor 不出条目。
      if (typeof onScopedRestart === "function" && resolvedTarget.target.tunnelEnabled && canScopedRestart(status)) {
        commands.push({
          id: "operation-restart-tunnel",
          title: `重启此服务器的隧道 — ${activeServerName}（仅影响该服务器，其它连接不受影响）`,
          category: "通道控制",
          aliases: "scoped",
          run: () => onScopedRestart(resolvedTarget.target.serverId),
        });
      }
    }

    // 团队管理快捷指令（仅当当前账号为团队管理员时展示）
    if (status?.teamAdmin?.isAdmin && typeof onTeamCommand === "function") {
      commands.push(
        {
          id: "team-view",
          title: "打开团队管理视图（团队星图与成员名单）",
          category: "团队管理",
          aliases: "team admin galaxy member 团队 星图 成员",
          run: () => onTeamCommand("view"),
        },
        {
          id: "storage-view",
          title: "打开存储管理（各盘按用户占用与目录树，root 只读）",
          category: "团队管理",
          aliases: "storage disk quota du 存储 磁盘 占用 目录",
          run: () => onTeamCommand("storage-view"),
        },
        {
          id: "team-add-member",
          title: "团队管理：添加 / 预分配团队成员",
          category: "团队管理",
          aliases: "team add member port 添加 成员 端口",
          run: () => onTeamCommand("add-member"),
        },
        {
          id: "team-batch-assign",
          title: "团队管理：批量下发 AI 配置与子密钥",
          category: "团队管理",
          aliases: "team assign config key relay 下发 配置 密钥",
          run: () => onTeamCommand("batch-assign"),
        },
        {
          id: "team-notice",
          title: "团队管理：发布或编辑团队置顶公告",
          category: "团队管理",
          aliases: "team notice broadcast 公告 通知",
          run: () => onTeamCommand("notice"),
        },
        {
          id: "team-root-guide",
          title: "团队管理：查看集群 Root 一次性赋权指南",
          category: "团队管理",
          aliases: "team root sudo grant 赋权",
          run: () => onTeamCommand("root-guide"),
        },
        {
          id: "team-sync",
          title: "团队管理：立即同步全员状态与加密信封",
          category: "团队管理",
          aliases: "team sync refresh 同步",
          run: () => onTeamCommand("sync"),
        }
      );
    }

    // 外观切换：浅色 / 跟随系统 / 深色
    commands.push(
      {
        id: "theme-light",
        title: "切换外观: 浅色",
        category: "外观",
        aliases: "theme",
        run: () => {
          onSetTheme?.("light");
          showToast({ type: "info", message: "已切换为浅色外观", title: "外观切换" });
        },
      },
      {
        id: "theme-system",
        title: "切换外观: 跟随系统",
        category: "外观",
        aliases: "theme",
        run: () => {
          onSetTheme?.("system");
          showToast({ type: "info", message: "外观已跟随系统深浅色", title: "外观切换" });
        },
      },
      {
        id: "theme-dark",
        title: "切换外观: 深色",
        category: "外观",
        aliases: "theme",
        run: () => {
          onSetTheme?.("dark");
          showToast({ type: "info", message: "已切换为深色外观", title: "外观切换" });
        },
      }
    );

    return commands;
  }

  function renderList() {
    if (!listEl) return;
    if (filteredCommands.length === 0) {
      listEl.innerHTML = renderNoMatchHtml(inputEl?.value || "");
      setExpanded(false);
      syncActiveDescendant();
      return;
    }
    setExpanded(true);

    let lastCategory = "";
    let html = "";
    filteredCommands.forEach((cmd, idx) => {
      if (cmd.category !== lastCategory) {
        lastCategory = cmd.category;
        html += `<div class="cmd-category-header" role="presentation">${escapeHtml(cmd.category)}</div>`;
      }
      const isActive = idx === selectedIndex;
      html += `
        <div class="cmd-item ${isActive ? "active" : ""}" id="cmd-opt-${idx}" data-index="${idx}" role="option" aria-selected="${isActive}" tabindex="-1">
          <div class="cmd-item-info">
            <span class="cmd-item-title">${escapeHtml(cmd.title)}</span>
          </div>
        </div>
      `;
    });
    listEl.innerHTML = html;
    syncActiveDescendant();

    // 确保选中项在视野内（选中第一项时直接回到顶部：只写不读，打开面板时不为它强制重排）
    if (selectedIndex === 0) {
      listEl.scrollTop = 0;
    } else {
      listEl.querySelector(".cmd-item.active")?.scrollIntoView({ block: "nearest" });
    }
  }

  // 快捷键帮助：输入框为 "?" 时列表区换成只读的快捷键说明（不可执行）。
  function renderHelp() {
    filteredCommands = [];
    if (!listEl) return;
    listEl.innerHTML = renderShortcutHelpHtml(shortcutList());
    setExpanded(false);
    syncActiveDescendant();
  }

  function showHelp() {
    if (inputEl) {
      inputEl.value = "?";
      inputEl.focus();
    }
    renderHelp();
  }

  function filter(query = "") {
    if (query.trim() === "?") {
      renderHelp();
      return;
    }
    filteredCommands = filterCommands(buildAllCommands(), query);
    selectedIndex = 0;
    renderList();
  }

  function executeSelected() {
    const cmd = filteredCommands[selectedIndex];
    if (cmd && typeof cmd.run === "function") {
      if (!cmd.keepOpen) close();
      cmd.run();
    }
  }

  // 先在关着的面板里把列表画好（不显示时写 DOM 不用排版），再弹出、聚焦：整个打开过程只排一次版
  function open() {
    if (!dialogEl) return;
    const active = doc?.activeElement;
    returnFocus = active && active !== doc?.body ? active : null;
    if (inputEl) inputEl.value = "";
    filter("");
    dialogEl.showModal();
    inputEl?.focus({ preventScroll: true });
  }

  function close() {
    if (!dialogEl) return;
    setExpanded(false);
    dialogEl.close();
    restoreFocus();
  }

  // 原生 dialog 的 Esc / 外部 close() 也要走同一套焦点归还（关闭按钮、命令执行都由 close() 覆盖）。
  dialogEl?.addEventListener("close", restoreFocus);

  // 绑定事件
  inputEl?.addEventListener("input", (e) => {
    filter(e.target.value);
  });

  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = (selectedIndex + 1) % filteredCommands.length;
        renderList();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = (selectedIndex - 1 + filteredCommands.length) % filteredCommands.length;
        renderList();
      }
    } else if (e.key === "Home") {
      e.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = 0;
        renderList();
      }
    } else if (e.key === "End") {
      e.preventDefault();
      if (filteredCommands.length > 0) {
        selectedIndex = filteredCommands.length - 1;
        renderList();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeSelected();
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  listEl?.addEventListener("click", (e) => {
    const item = e.target.closest(".cmd-item");
    if (item && item.dataset.index != null) {
      selectedIndex = parseInt(item.dataset.index, 10);
      executeSelected();
    }
  });

  dialogEl?.querySelector("[data-close]")?.addEventListener("click", close);

  // 全局快捷键 ⌘K / Ctrl+K
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dialogEl?.open) {
        close();
      } else {
        open();
      }
    }
  });

  return {
    open,
    close,
    refresh: () => {
      if (dialogEl?.open) filter(inputEl?.value || "");
    },
  };
}

// 纯函数：按标题/分类/隐藏英文别名匹配（W5：标题只显示中文，英文作为搜索别名保留）。
export function filterCommands(all, query = "") {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return all;
  return all.filter((cmd) => [cmd.title, cmd.category, cmd.aliases]
    .some((field) => typeof field === "string" && field.toLowerCase().includes(q)));
}

// 纯函数：没有匹配的命令时的空状态（紧凑型）。举例的英文别名都真实存在：
// 「重启所有连接」带 restart、「日志」浮层带 logs（见 buildAllCommands 的 aliases）。
export function renderNoMatchHtml(query = "") {
  const q = String(query || "").trim();
  const shown = q.length > 24 ? `${q.slice(0, 24)}…` : q;
  return `<div class="cmd-empty">${emptyStateHtml({
    compact: true, tone: "neutral", icon: "search",
    title: shown ? `没有匹配「${shown}」的命令` : "没有匹配的命令",
    body: "试试更短的关键词，或用英文别名（restart、logs）。",
  })}</div>`;
}

// 纯函数：快捷键帮助列表 HTML（沿用命令列表样式，条目为只读展示）。
export function renderShortcutHelpHtml(list) {
  const rows = (Array.isArray(list) ? list : []).map((item) => `
        <div class="cmd-item" role="presentation">
          <div class="cmd-item-info"><span class="cmd-item-title">${escapeHtml(item.desc)}</span></div>
          <span class="cmd-item-badge">${escapeHtml(item.keys)}</span>
        </div>`).join("");
  return `<div class="cmd-category-header" role="presentation">键盘快捷键</div>${rows}`;
}
