// ui-labels.js —— 按钮文案常量与快捷键展示（纯数据/纯函数，Node 可 import 测试）。
// 横幅、提示语、命令面板引用按钮时一律用这里的常量，避免"点击「启动通道」"而页面上
// 根本没有这个按钮的错位（W5 审计项）。改按钮文案请同时改 index.html 里对应按钮。

export const BUTTON_LABELS = Object.freeze({
  start: "启动所有连接",
  restart: "重启所有连接",
  stop: "停止所有连接",
  repair: "一键修复（所有连接）",
  control: "控制",
  quit: "退出并停止后台",
  offlineInstall: "离线安装 Agent",
  setupCommand: "npm run setup",
  reassignPort: "重新分配端口…",
  confirmHostKey: "确认主机密钥",
});

export const QUIT_CONFIRM_TEXT = `${BUTTON_LABELS.quit}：将关闭控制台，并停止守护进程、本地代理与全部服务器的 SSH 隧道，集群上的 Agent 将失去网络。确定退出？`;

// 客户端是否为 Apple 平台（决定展示 ⌘ 还是 Ctrl）。键盘属于正在看页面的这台机器，
// 所以看浏览器的 navigator 而不是后端 platform。
export function isApplePlatform(nav = typeof navigator !== "undefined" ? navigator : null) {
  if (!nav) return false;
  const hint = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(String(hint));
}

export function modKeyLabel(apple = isApplePlatform()) {
  return apple ? "⌘" : "Ctrl+";
}

// 命令面板"?"帮助条目列出的快捷键。
export function shortcutList(apple = isApplePlatform()) {
  const mod = modKeyLabel(apple);
  return [
    { keys: `${mod}K`, desc: "打开/关闭命令面板" },
    { keys: "↑ / ↓", desc: "在命令列表中移动" },
    { keys: "Enter", desc: "执行选中的命令" },
    { keys: "Esc", desc: "关闭命令面板或浮层" },
    { keys: "← / →", desc: "在 概览 / 服务器 / 事件 标签之间切换（焦点在标签上时）" },
    { keys: "?", desc: "在命令面板中输入 ? 查看本帮助" },
  ];
}
