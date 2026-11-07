// scripts/setup/cli-login.mjs —— 配置向导第 6 步"登录集群上的 codex / Claude Code"（v2.57 第 2 期，可跳过；在第 5 步检测 / 安装之后）。
//
// 命令与流程与 App（work/monitor/lib/cli/login*.mjs）共用：
//   - 账号授权：直接在当前终端里跑 `ssh -tt …`（Codex 带 -L 1455 转发），授权链接就印在终端里，用户自己
//     用浏览器打开；Claude 的授权码直接粘贴回终端。Ctrl-C 经伪终端交给远端 CLI；远端另有 timeout 硬上限。
//   - 长期令牌（claude setup-token）：令牌印在终端里，再用不回显的输入框收回来，经 ssh 标准输入写进 keys/。
//   - API / 中转站：login-api.mjs 的同一套流程；key 用不回显的输入框收、只经 ssh 标准输入送达。
//     白名单与内网直连名单写个人层（personal-config-write 的 writePersonalConfig，与 App 同一校验）。
import { spawnSync } from "node:child_process";
import { LoginError, normalizeApiLoginRequest, runApiLogin, storeClaudeOauthToken, verifyLoginStatus } from "../../work/monitor/lib/cli/login-api.mjs";
import {
  buildAccountSshOptions,
  buildClaudeAccountCommand,
  buildCodexAccountCommand,
  CODEX_CALLBACK_PORT,
  isPlausibleSecret,
  LOGIN_CLIS,
} from "../../work/monitor/lib/cli/login-flows.mjs";
import { checkLocalPortDefault } from "../../work/monitor/lib/cli/login.mjs";
import { noProxyExtraFor } from "../../work/monitor/lib/cluster-env.mjs";
import { writePersonalConfig } from "../../work/monitor/lib/personal-config-write.mjs";
import { parseAllowlistEntry } from "../../work/monitor/lib/proxy/address.mjs";
import { SSH_NO_MUX_ARGS } from "../../work/monitor/lib/ssh-args.mjs";
import { askHidden, confirmYes } from "../lib/prompt.mjs";
import { defaultLocalConfigPath, readLocalConfigObject } from "./local-config.mjs";
import { runSsh } from "./ssh-probe.mjs";
import { askQuestion, bold, DRY_RUN, dryRunLog, logError, logHeader, logInfo, logSuccess, logWarning } from "./ui.mjs";

// 菜单：编号 → 方式（与 App 的登录对话框同一组）。
export const LOGIN_MENU = Object.freeze({
  codex: [
    { method: "account", label: "ChatGPT 账号（浏览器授权）" },
    { method: "api", label: "OpenAI 官方 API key" },
    { method: "relay", label: "中转站（base URL + key）" },
  ],
  claude: [
    { method: "account", label: "Claude 账号（浏览器授权 + 粘贴授权码）" },
    { method: "setup-token", label: "长期令牌（claude setup-token，浏览器授权不通时用）" },
    { method: "api", label: "Anthropic 官方 API key" },
    { method: "relay", label: "中转站（base URL + key）" },
  ],
});

// 编号或空（默认第 1 项）→ 选项；超出范围返回 null。
export function pickOption(answer, options) {
  const text = String(answer ?? "").trim();
  if (!text) return options[0];
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : null;
}

// 个人层的两个写入口（与 App 同一个 writePersonalConfig 校验；乐观并发取当前 revision）。
export function createPersonalWriters(serverId, { localConfigPath = defaultLocalConfigPath(), readLocal = readLocalConfigObject, write = writePersonalConfig } = {}) {
  const read = () => readLocal(localConfigPath);
  return {
    getNoProxyExtra: () => noProxyExtraFor(read(), serverId),
    saveNoProxyExtra: async (list) => {
      const current = read();
      const map = current.noProxyExtra && typeof current.noProxyExtra === "object" && !Array.isArray(current.noProxyExtra) ? current.noProxyExtra : {};
      write({ localConfigPath, patch: { noProxyExtra: { ...map, [serverId]: list } }, expectedRevision: current.revision ?? 0 });
    },
    addAllowlistEntry: async (entry) => {
      const current = read();
      const list = (Array.isArray(current.proxyAllowedTargets) ? current.proxyAllowedTargets : []).map((raw) => parseAllowlistEntry(raw).entry).filter(Boolean);
      if (list.includes(entry)) return { added: false };
      write({ localConfigPath, patch: { proxyAllowedTargets: [...list, entry] }, expectedRevision: current.revision ?? 0 });
      return { added: true };
    },
  };
}

// 在当前终端里跑账号授权（标准输入输出直通）。返回 ssh 的退出码。
function runInteractive(host, { cli, forwardV6, command }, spawnImpl = spawnSync) {
  const args = [...SSH_NO_MUX_ARGS, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", ...buildAccountSshOptions({ cli, forwardV6 }), host, command];
  const res = spawnImpl("ssh", args, { stdio: "inherit" });
  return res.status;
}

// remotePort 可为空（没领端口时只能靠已写好的 env.sh 出网）。返回 { status: "skipped" | "ok" | "failed" | "dry-run", cli?, method? }。
export async function loginStep(server, remotePort, {
  ask = askQuestion,
  askSecret = (query) => askHidden(query),
  dryRun = DRY_RUN,
  ssh = runSsh,
  spawnImpl = spawnSync,
  checkLocalPort = checkLocalPortDefault,
  writers = createPersonalWriters(server.id),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  logHeader("6. 登录集群上的 codex / Claude Code（可跳过）");
  logInfo("登录凭证与 API key 只写进你自己的集群家目录；key 经 SSH 标准输入送达，本机不保存。");
  if (!(await confirmYes("现在登录吗？[y/N] ", ask))) {
    logInfo("已跳过。之后可以在工作台的 Agent 卡片「详情」里点「登录」，或重跑 npm run setup。");
    return { status: "skipped" };
  }
  const cliChoice = pickOption(await ask("登录哪个？ 1) Codex  2) Claude Code [1] "), ["codex", "claude"]);
  if (!cliChoice) {
    logWarning("没有这个选项，已跳过登录。");
    return { status: "skipped" };
  }
  const cli = cliChoice;
  const menu = LOGIN_MENU[cli];
  for (const [i, item] of menu.entries()) console.log(`  ${i + 1}) ${item.label}`);
  const option = pickOption(await ask("方式 [1] "), menu);
  if (!option) {
    logWarning("没有这个选项，已跳过登录。");
    return { status: "skipped" };
  }
  const { method } = option;
  const label = LOGIN_CLIS[cli].label;
  const host = server.host;

  if (method === "account" || method === "setup-token") {
    const command = cli === "codex" ? buildCodexAccountCommand({ port: remotePort }) : buildClaudeAccountCommand({ port: remotePort, variant: method });
    let forwardV6 = false;
    if (cli === "codex" && !dryRun) {
      if ((await checkLocalPort(CODEX_CALLBACK_PORT, "127.0.0.1")) === "busy") {
        logError(`本机 ${CODEX_CALLBACK_PORT} 端口被占用（多半是本机的 Codex 正在登录）。关掉它后重跑 npm run setup。`);
        return { status: "failed", cli, method };
      }
      forwardV6 = (await checkLocalPort(CODEX_CALLBACK_PORT, "::1")) === "free";
    }
    if (dryRun) {
      dryRunLog(`ssh ${buildAccountSshOptions({ cli, forwardV6: true }).join(" ")} ${host}:\n${command}`);
      return { status: "dry-run", cli, method };
    }
    if (cli === "codex") logInfo(`下面会印出授权链接：用本机浏览器打开并登录，回调经本机 ${CODEX_CALLBACK_PORT} 端口转发回集群。看到 ${bold("Successfully logged in")} 即完成。`);
    else logInfo("下面会印出授权链接：用本机浏览器打开并授权，把页面上显示的授权码粘贴回这里，回车。");
    const status = runInteractive(host, { cli, forwardV6, command }, spawnImpl);
    if (status === 75) {
      logError(`集群上的 ${CODEX_CALLBACK_PORT} 端口正被占用——多半有同事正在登录 Codex。过几分钟再重跑这一步。`);
      return { status: "failed", cli, method };
    }
    if (method === "setup-token") {
      const token = String(await askSecret("把上面印出的长期令牌（sk-ant-oat01-…）粘贴到这里（不回显，直接回车跳过）: ")).trim();
      if (!token) {
        logWarning("没有令牌，跳过保存。");
        return { status: "failed", cli, method };
      }
      if (!isPlausibleSecret(token)) {
        logError("令牌格式不对，没有保存。");
        return { status: "failed", cli, method };
      }
      try {
        await storeClaudeOauthToken(token, { runRemote: sshRunner(ssh, host) });
        logSuccess("长期令牌已写进集群 ~/.config/cluster-workbench/keys/claude-oauth.env（600），新开的终端生效。");
      } catch (err) {
        logError(err.message);
        return { status: "failed", cli, method };
      }
    }
    const result = await verifyLoginStatus({ port: remotePort, runRemote: sshRunner(ssh, host) }, cli);
    if (result.loggedIn) {
      logSuccess(`${label} 已登录（${result.detail || result.login}）`);
      return { status: "ok", cli, method };
    }
    logWarning(`没能确认 ${label} 的登录状态${result.detail ? `（${result.detail}）` : ""}。${cli === "claude" && method === "account" ? "浏览器授权走不通时可以改用「长期令牌」。" : ""}`);
    return { status: "failed", cli, method };
  }

  // API / 中转站
  const body = {};
  if (method === "relay") {
    body.baseUrl = (await ask("中转站地址（如 https://relay.example.com/v1）: ")).trim();
    if (cli === "codex") body.providerId = (await ask("给这个中转站起个名字（小写字母、数字、-）[relay] ")).trim();
  }
  body.apiKey = String(await askSecret(`${label} 的 API key（不回显）: `)).trim();
  let request;
  try {
    request = normalizeApiLoginRequest(cli, method, body);
  } catch (err) {
    if (err instanceof LoginError && err.code === "plaintext-confirm") {
      logWarning("中转站是 http:// 明文地址：API key 会以明文经过网络。");
      if (!(await confirmYes("确认中转站可信、继续使用吗？[y/N] ", ask))) {
        logInfo("已取消。");
        return { status: "skipped", cli, method };
      }
      request = normalizeApiLoginRequest(cli, method, { ...body, acknowledgePlaintext: true });
    } else {
      logError(err.message);
      return { status: "failed", cli, method };
    }
  } finally {
    body.apiKey = null;
  }
  if (dryRun) {
    request.apiKey = null;
    dryRunLog(`将经 SSH 标准输入把 key 送到 ${host}（${cli} / ${method}），命令串里不含 key。`);
    return { status: "dry-run", cli, method };
  }
  try {
    const result = await runApiLogin(request, {
      port: remotePort,
      runRemote: sshRunner(ssh, host),
      ...writers,
      sleep,
      phase: (_name, text) => logInfo(text),
    });
    for (const note of result.notes || []) logInfo(note);
    for (const warning of result.warnings || []) logWarning(warning);
    logSuccess(result.message);
    return { status: "ok", cli, method };
  } catch (err) {
    logError(err.message);
    return { status: "failed", cli, method };
  }
}

// runSsh（spawnSync）→ login-api 期望的 { code, stdout, stderr }。
function sshRunner(ssh, host) {
  return async (command, { input, timeoutMs } = {}) => {
    const res = ssh(host, command, { ...(input != null ? { input } : {}), timeoutMs });
    return { code: res?.status ?? 1, stdout: String(res?.stdout ?? ""), stderr: String(res?.stderr ?? res?.error?.message ?? "") };
  };
}
