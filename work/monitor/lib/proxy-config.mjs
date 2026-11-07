// work/monitor/lib/proxy-config.mjs
// reclaude systemd --user 代理 drop-in 的落点（相对 $HOME），由向导（scripts/setup/routing.mjs）写入。
// 控制台不再探测它是否漂移、也不提供远端写回：ReClaude 的配置与重启由用户手动处理。
export const RECLAUDE_PROXY_DROPIN_DIR = ".config/systemd/user/reclaude.service.d";
export const RECLAUDE_PROXY_DROPIN_FILE = "proxy.conf";

export function renderReclaudeProxyDropin(port) {
  const p = `http://127.0.0.1:${port}`;
  return `[Service]
Environment=HTTP_PROXY=${p}
Environment=HTTPS_PROXY=${p}
Environment=http_proxy=${p}
Environment=https_proxy=${p}
Environment=NO_PROXY=localhost,127.0.0.1,::1
`;
}

// 单条远端命令的隧道代理前缀（`ssh host "<前缀>cmd"`）：变量集合与上面的 drop-in 一致。
// 无人值守的 ssh 探测不读 ~/.bashrc 里带交互守卫的代理块，不加这个前缀时 CLI 会直连外网——
// 集群不通外网，codex doctor 的 reachability 因此恒报 fail，而用户交互式终端里的 codex 走隧道
// 一切正常。凡是要"按真实使用环境"诊断联网的远端命令都应带上它。
export function tunnelProxyEnv(port) {
  const p = `http://127.0.0.1:${port}`;
  return `HTTP_PROXY=${p} HTTPS_PROXY=${p} http_proxy=${p} https_proxy=${p} NO_PROXY=localhost,127.0.0.1,::1 `;
}

// zcode-server 的代理配置不走环境变量，而是读它自己的设置文件
// `$HOME/.zcode/v2/setting.json`（schema 顶层键 httpProxy / httpProxyNoProxy）。
// 桌面端 attached-remote 模式下 server 由 sshd 非交互拉起，.bashrc 里带交互守卫的
// 环境变量注入对它不生效（v2.13.0 修复的线上 TLS 拦截问题），必须直接写设置文件。
export function zcodeProxySettingsPatch(port) {
  return {
    httpProxy: `http://127.0.0.1:${port}`,
    httpProxyNoProxy: "localhost,127.0.0.1,::1",
  };
}

// 把补丁浅合并进现有 setting.json 文本，返回格式化后的新文件全文。约定：
// - 文件不存在 / 空白 → 当作空对象起步；
// - 已有合法 JSON 对象 → 其余键原样保留，仅覆盖两个代理键；
// - 非空但解析失败、或顶层不是普通对象 → 返回 null，由调用方告警跳过，
//   绝不把用户已有的设置文件覆盖写坏。
export function mergeZcodeSettings(existingText, patch) {
  const raw = String(existingText ?? "").trim();
  let parsed = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  }
  return `${JSON.stringify({ ...parsed, ...patch }, null, 2)}\n`;
}
