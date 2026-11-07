// 官方 CLI（codex / Claude Code）在 Agent 卡片上的展示投影（纯函数，Node 可测）。
//
// 数据来自 GET /api/cli（app/cli-controller.js 低频拉取）：
//   { serverId, clis: { codex: CliState & { latest, updateAvailable }, claude: … }, job }
//   CliState = { installed, version, kind, path, login, loginDetail, … }（后端 lib/cli/detect.mjs）
// 接口不存在 / 失败 / 不是当前查看的服务器 / 还没探测到（installed 为 null）时一律返回 null，卡片回落到适配器自己的字段。
//
// 三处入口分工（v2.57 第 2 期整合，不重复展示、不多造入口）：
//   - Agent 卡片（render/overview.js）：版本 / 登录方式只读展示；落后时一枚「可更新到 x」chip，没装时详情里一个「安装…」——
//     两者都经 [data-cli-manage] 打开配置浮层「命令行工具」一节并直接进入同一个确认（app/settings-cli.js 的 openFor）；
//   - 配置浮层「命令行工具」（app/settings-cli.js）：安装 / 更新 / 回滚与进度的唯一操作处；
//   - Agent 详情「登录 / 切换账号…」（app/cli-login-dialog.js）：登录的唯一入口（没装时不显示）。

// Agent kind → /api/cli 的 CLI id（与后端 lib/cli/catalog.mjs 的 agentKind 对应）。
const CLI_ID_BY_AGENT_KIND = Object.freeze({ codex: "codex", "claude-code": "claude" });

// 界面名（与后端 catalog 的 label 一致；/api/cli 的每项也带 label，优先用接口给的）。
export const CLI_LABELS = Object.freeze({ codex: "Codex", claude: "Claude Code" });

// Agent 概览条目 → 对应 CLI id（codex / claude）；reclaude、zcode 等没有对应项 → null。
export function cliIdForAgent(agent) {
  return CLI_ID_BY_AGENT_KIND[agent?.kind || agent?.id] || null;
}

const KIND_LABELS = Object.freeze({ standalone: "独立安装", native: "原生安装", npm: "npm 全局", unknown: "非官方布局" });

const LOGIN_LABELS = Object.freeze({
  chatgpt: "ChatGPT 账号",
  apikey: "API key",
  subscription: "订阅账号",
  api: "API key",
  none: "未登录",
  unknown: "无法判断",
});

// 当前查看服务器上该 Agent 对应的 CliState；对不上返回 null。
export function cliStateForAgent(payload, agent, activeServerId) {
  const id = cliIdForAgent(agent);
  if (!id || !payload || typeof payload !== "object") return null;
  if (activeServerId && payload.serverId && payload.serverId !== activeServerId) return null;
  const state = payload.clis?.[id];
  // installed 为 null：探测还没成功过（后端用「状态未知」占位），不拿占位覆盖适配器字段。
  return state && typeof state === "object" && typeof state.installed === "boolean" ? state : null;
}

// 「版本」行：0.159.2 · 独立安装；已知最新且不落后时加「已是最新」（落后时由「可更新到 x」chip 说，不在这里重复）；
// 未安装 → 未安装；装在只有交互 shell 才看得到的位置（后端给 offPath）→ 说它在、但工作台用不上，不说「未安装」。
export function cliVersionText(state) {
  if (!state) return null;
  if (state.installed === false) return typeof state.offPath === "string" && state.offPath ? "已安装（不在非交互 SSH 的 PATH 里）" : "未安装";
  const version = typeof state.version === "string" && state.version ? state.version : "版本未知";
  const parts = [version];
  if (KIND_LABELS[state.kind]) parts.push(KIND_LABELS[state.kind]);
  if (state.updateAvailable !== true && typeof state.latest === "string" && state.latest && state.version) parts.push("已是最新");
  return parts.join(" · ");
}

// 「登录」行：登录方式 + 细节（中转站 / 订阅类型 / 经 ReClaude 代理），只用后端给的非密钥描述。
export function cliLoginText(state) {
  if (!state || typeof state.login !== "string") return null;
  if (state.login === "none") return "未登录";
  const detail = typeof state.loginDetail === "string" && state.loginDetail ? state.loginDetail : "";
  if (!detail) return LOGIN_LABELS[state.login] || state.login;
  return detail;
}

// 「可更新到 x」chip（可点：直达配置浮层「命令行工具」的更新确认）。latest 缺失（版本检测未就绪）/ 不落后 → null。
export function cliUpdateChip(state, cliId = null) {
  if (!state || state.installed === false || state.updateAvailable !== true) return null;
  if (typeof state.latest !== "string" || !state.latest) return null;
  return { text: `可更新到 ${state.latest}`, tone: "info", ...(cliId ? { manage: { cli: cliId, action: "update" } } : {}) };
}
