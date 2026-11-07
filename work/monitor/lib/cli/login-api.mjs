// API key / 中转站登录的执行流程（v2.57 第 2 期 P-E）：Codex 官方 key、Codex 中转站、Claude 官方 key、
// Claude 中转站。几次短 SSH 完成，App（login.mjs 的任务）与命令行向导（scripts/setup/cli-login.mjs）共用。
//
// 顺序是"先测通、再写入"：中转站先按 relay-url 归类（非 443 → 个人白名单；内网 → 集群直连测试，通了才
// 写 NO_PROXY），从集群实测能连上之后才落 key 与配置——测不通时集群上什么都不改（白名单条目除外）。
// 内网中转站的 NO_PROXY 是"先远端、后本机"：集群 env.sh 重写成功才把主机记进个人层；没领端口或集群上
// 没有 env.sh 时跳过重写并说明原因（不算失败——内网中转站本来就不靠隧道），个人层照记，之后做集群侧
// 受管配置时自动带上。
// key 只出现在 runRemote 的 input（ssh 标准输入）里：不进命令串、不进日志、不进返回值；本机不落盘。
//
// deps（全部可注入，测试用假实现）：
//   runRemote(command, { input?, timeoutMs }) → { code, stdout, stderr }   一次 SSH
//   port                     本人反向隧道端口（可为空：没领端口时只能用已写好的 env.sh）
//   getNoProxyExtra()        → string[]  这台服务器在个人层的内网直连名单
//   saveNoProxyExtra(list)   写回个人层（personal-config-write 校验）
//   addAllowlistEntry(entry) → { added }  个人代理白名单追加（已存在时 added:false）
//   sleep(ms)                白名单热载等待
//   phase(name, text)        进度回调
import { buildClusterEnvSteps } from "../cluster-env.mjs";
import {
  buildInspectCommand,
  buildReachabilityCommand,
  buildReplaceFileCommand,
  buildStatusCommand,
  buildWriteKeyFileCommand,
  CLAUDE_OAUTH_KEY_FILE,
  CLAUDE_SETTINGS_FILE,
  clearManagedDefaultProvider,
  CODEX_CONFIG_FILE,
  codexKeyFileName,
  describeRelay,
  isPlausibleSecret,
  normalizeProviderId,
  outputTail,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  parseInspectOutput,
  parseReachabilityOutput,
  planClaudeApiSettings,
  providerEnvKey,
  remotePreludeLines,
  renderKeyFile,
  upsertCodexProvider,
} from "./login-flows.mjs";
import { wrapSh } from "../shell/wrap-sh.mjs";

export class LoginError extends Error {
  constructor(code, message, { status = 400, field } = {}) {
    super(message);
    this.name = "LoginError";
    this.code = code;
    this.status = status;
    if (field) this.field = field;
  }
}

const SSH_READ_TIMEOUT_MS = 20000;
const SSH_WRITE_TIMEOUT_MS = 25000;
const REACH_TIMEOUT_MS = 30000;
// 新加的白名单条目要等本机代理热载（约 2 秒）：最多测 4 次、间隔 1.5 秒。
const ALLOWLIST_RETRIES = 4;
const ALLOWLIST_RETRY_DELAY_MS = 1500;

// 请求体 → 归一化参数（不发任何 SSH）。校验不过抛 LoginError(400)。
// 返回值含 apiKey：调用方用完即弃，不要放进任务视图。
export function normalizeApiLoginRequest(cli, method, body = {}) {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!isPlausibleSecret(apiKey)) throw new LoginError("bad-key", "API key 格式不对（应为 8 位以上、不含空格的一串字符）", { field: "apiKey" });
  const out = { cli, method, apiKey, relay: null, providerId: null, providerName: null };
  if (method === "relay") {
    const relay = describeRelay(body.baseUrl);
    if (!relay.ok) throw new LoginError("bad-url", relay.error, { field: "baseUrl" });
    if (relay.warnings.includes("plaintext-http") && body.acknowledgePlaintext !== true) {
      throw new LoginError("plaintext-confirm", "中转站是 http:// 明文地址：API key 会以明文经过网络。确认中转站可信后勾选「我知道是明文」再提交。", { field: "acknowledgePlaintext" });
    }
    out.relay = { ...relay, baseUrl: String(body.baseUrl).trim() };
    if (cli === "codex") {
      const id = normalizeProviderId(body.providerId);
      if (!id) throw new LoginError("bad-provider", "名称只能用小写字母、数字和 -（字母开头，最多 31 位），且不能与 codex 内置的 openai / ollama 等重名", { field: "providerId" });
      out.providerId = id;
      const name = typeof body.providerName === "string" ? body.providerName.trim().slice(0, 64) : "";
      out.providerName = name || id;
    }
  }
  return out;
}

function sshFailure(res, what) {
  const detail = outputTail(`${res?.stderr || ""}\n${res?.stdout || ""}`, { maxChars: 300 });
  return new LoginError("ssh-failed", `${what}失败${detail ? `：${detail}` : `（退出码 ${res?.code ?? "未知"}）`}`, { status: 502 });
}

async function inspect(deps, cli, file) {
  const res = await deps.runRemote(buildInspectCommand({ cli, port: deps.port, file }), { timeoutMs: SSH_READ_TIMEOUT_MS });
  const parsed = res?.code === 0 ? parseInspectOutput(res.stdout) : null;
  if (!parsed) throw sshFailure(res, "读取集群上的配置");
  if (!parsed.cliPresent) {
    throw new LoginError("no-cli", `集群上没有找到 ${cli === "claude" ? "Claude Code（claude）" : "codex"}，请先安装`, { status: 409 });
  }
  return parsed;
}

// 中转站的出网准备 + 从集群实测连通。envPresent：集群上有没有受管 env.sh（inspect 的结论）。
// → { direct, noProxyExtra|null, warnings, notes }
async function prepareRelay(relay, deps, { envPresent = false } = {}) {
  if (["127.0.0.1", "localhost", "::1"].includes(relay.host) && relay.port === deps.port) {
    throw new LoginError("proxy-as-api", "这里填的是集群通道的代理端口，不是中转站 API 地址。请填服务商提供的 https://… 地址，通道代理由工作台自动配置。", { field: "baseUrl" });
  }
  const warnings = [];
  const notes = [];
  if (relay.warnings.includes("plaintext-http")) warnings.push("中转站是 http:// 明文地址：API key 不加密传输");
  const direct = relay.action === "direct-candidate";
  let retries = 1;
  if (relay.action === "allowlist") {
    deps.phase?.("allowlist", `把 ${relay.entry} 加进个人代理白名单`);
    const { added } = await deps.addAllowlistEntry(relay.entry);
    notes.push(added ? `已把 ${relay.entry} 加进个人代理白名单` : `${relay.entry} 已在代理白名单里`);
    if (added) retries = ALLOWLIST_RETRIES;
  }
  if (!direct && !deps.port) {
    throw new LoginError("no-port", "这台服务器还没领到反向端口，集群没法经隧道访问中转站；先在设置里领取端口", { status: 409 });
  }
  deps.phase?.("reachability", direct ? `从集群直连测试 ${relay.host}` : `经隧道从集群测试 ${relay.host}`);
  let reach = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (attempt > 0) await deps.sleep(ALLOWLIST_RETRY_DELAY_MS);
    const res = await deps.runRemote(buildReachabilityCommand({ port: deps.port, url: relay.baseUrl, direct }), { timeoutMs: REACH_TIMEOUT_MS });
    reach = parseReachabilityOutput(res?.stdout);
    if (reach.reachable || !reach.tested) break;
  }
  if (!reach.tested) {
    warnings.push(reach.detail);
  } else if (!reach.reachable) {
    const why = reach.detail ? `（${reach.detail}）` : "";
    if (direct) {
      throw new LoginError("relay-unreachable", `集群直连不到 ${relay.host}${why}。内网地址不经本机代理转发，集群连不上就无法使用；请确认地址，或换成公网地址。没有写入任何东西。`, { status: 422 });
    }
    throw new LoginError("relay-unreachable", `集群经隧道访问不到 ${relay.host}${why}。请确认隧道在线、本机能打开这个地址。没有写入 key 与配置。`, { status: 422 });
  } else {
    notes.push(`集群${direct ? "直连" : "经隧道"}能连上 ${relay.host}（HTTP ${reach.httpCode}）`);
  }

  let noProxyExtra = null;
  if (direct) {
    const current = deps.getNoProxyExtra();
    noProxyExtra = current.includes(relay.host) ? current : [...current, relay.host];
    if (noProxyExtra !== current) {
      // 先远端、后本机（v2.57 终审）：env.sh 写不成就抛错、个人层不动，不留"名单里有、集群上没有"的半截状态。
      // env.sh 整体由端口渲染，没领端口就没法重写；集群上没有 env.sh 时也不凭空建一个（没有配套的引入块）。
      if (deps.port && envPresent) {
        deps.phase?.("no-proxy", `把 ${relay.host} 写进集群 env.sh 的 NO_PROXY`);
        // env.sh 是整体重写：集群上原来带着代理口令（v2.62）时照着带上，别为了加一条 NO_PROXY 把口令写没了。
        // 带口令的那一步多一个 input（全文经标准输入送达）；不带时与以前逐字相同。
        const credential = (await deps.getEnvCredential?.()) ?? null;
        const step = buildClusterEnvSteps({ port: deps.port, noProxyExtra, ...(credential ? { credential } : {}) }).find((s) => s.id === "write-env");
        const res = await deps.runRemote(step.command, { timeoutMs: SSH_WRITE_TIMEOUT_MS, ...(step.input != null ? { input: step.input } : {}) });
        if (res?.code !== 0) throw sshFailure(res, "更新集群 env.sh 的 NO_PROXY ");
        notes.push(`已把 ${relay.host} 写进集群 env.sh 的 NO_PROXY（直连，不走隧道）`);
      } else if (!envPresent) {
        notes.push(`集群上还没有受管 env.sh，这次没有改 NO_PROXY；${relay.host} 已记进个人配置，之后做集群侧受管配置（npm run setup 第 4 步）时会一并写进去`);
      } else {
        warnings.push(`这台服务器还没领到反向端口，没法重写集群 env.sh 的 NO_PROXY：从载入了 env.sh 的终端访问 ${relay.host} 仍会被送进隧道代理（本机代理不转发内网地址）。领到端口后重跑集群侧受管配置（npm run setup 第 4 步）即可——${relay.host} 已记进个人配置，届时自动带上`);
      }
      await deps.saveNoProxyExtra(noProxyExtra);
    }
  }
  return { direct, noProxyExtra, warnings, notes };
}

async function verifyStatus(deps, cli) {
  const res = await deps.runRemote(buildStatusCommand({ cli, port: deps.port }), { timeoutMs: SSH_READ_TIMEOUT_MS });
  const parsed = cli === "claude" ? parseClaudeAuthStatus(res?.stdout) : parseCodexLoginStatus(res?.stdout);
  return parsed;
}

// 改回官方登录后：config.toml 的顶层 model_provider 若指向我们写的中转站，删掉这一行（provider 表保留）。
export async function resetCodexDefaultProvider(deps, configText) {
  if (configText == null) return null;
  const cleared = clearManagedDefaultProvider(configText);
  if (!cleared.changed) return null;
  const res = await deps.runRemote(buildReplaceFileCommand(CODEX_CONFIG_FILE, Buffer.byteLength(cleared.text, "utf8")), { input: cleared.text, timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (res?.code !== 0) return `config.toml 里默认的中转站「${cleared.providerId}」没能去掉，请手动删掉顶层的 model_provider 行`;
  return `已把 codex 默认 provider 从中转站「${cleared.providerId}」改回官方`;
}

async function codexOfficialKey(req, deps) {
  const state = await inspect(deps, "codex", CODEX_CONFIG_FILE);
  deps.phase?.("writing", "codex login --with-api-key（key 经标准输入）");
  const command = wrapSh([...remotePreludeLines(deps.port), "codex login --with-api-key"]);
  const res = await deps.runRemote(command, { input: `${req.apiKey}\n`, timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (res?.code !== 0) throw sshFailure(res, "codex login --with-api-key ");
  const notes = [];
  const reset = await resetCodexDefaultProvider(deps, state.file);
  if (reset) notes.push(reset);
  deps.phase?.("verifying", "核对登录状态");
  const status = await verifyStatus(deps, "codex");
  return { message: "codex 已用官方 API key 登录", status, notes, warnings: [] };
}

async function codexRelay(req, deps) {
  const state = await inspect(deps, "codex", CODEX_CONFIG_FILE);
  if (!state.envPresent) {
    throw new LoginError("env-missing", "集群上还没有工作台的受管配置（~/.config/cluster-workbench/env.sh），中转站的 key 没处引入；请先完成集群侧受管配置（npm run setup 第 4 步）", { status: 409 });
  }
  const prep = await prepareRelay(req.relay, deps, { envPresent: state.envPresent });
  const envKey = providerEnvKey(req.providerId);
  const planned = upsertCodexProvider(state.file ?? "", {
    id: req.providerId,
    name: req.providerName,
    baseUrl: req.relay.baseUrl,
    envKey,
    makeDefault: true,
  });
  if (planned.skipped === "id-taken") {
    throw new LoginError("provider-taken", `~/.codex/config.toml 里已有你自己写的 provider「${req.providerId}」，没有覆盖；换个名称再试`, { status: 409, field: "providerId" });
  }
  if (planned.skipped) {
    throw new LoginError("toml-layout", "~/.codex/config.toml 里的 model_providers 用了点号键或内联表写法，没法自动改；请改成 [model_providers.<名称>] 表写法后重试", { status: 409 });
  }
  deps.phase?.("writing", `写 key 文件 keys/${codexKeyFileName(req.providerId)}.env（600，经标准输入）`);
  const keyText = renderKeyFile(envKey, req.apiKey);
  const keyRes = await deps.runRemote(buildWriteKeyFileCommand(codexKeyFileName(req.providerId), Buffer.byteLength(keyText, "utf8")), { input: keyText, timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (keyRes?.code !== 0) throw sshFailure(keyRes, "写 key 文件");
  if (planned.changed) {
    deps.phase?.("writing", "写 ~/.codex/config.toml（保留原有内容，已备份）");
    const res = await deps.runRemote(buildReplaceFileCommand(CODEX_CONFIG_FILE, Buffer.byteLength(planned.text, "utf8")), { input: planned.text, timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.code !== 0) throw sshFailure(res, "写 ~/.codex/config.toml ");
  }
  return {
    message: `codex 默认改走中转站「${req.providerId}」（${req.relay.host}）；新开的终端生效，已在运行的 codex 需重开`,
    status: null,
    notes: [...prep.notes, `config.toml：[model_providers.${req.providerId}]，env_key = ${envKey}`],
    warnings: prep.warnings,
  };
}

async function claudeApi(req, deps) {
  const state = await inspect(deps, "claude", CLAUDE_SETTINGS_FILE);
  // 先在本地判定 reclaude 接管 / JSON 合法（不发任何写），再去动网络与白名单。
  const precheck = planClaudeApiSettings(state.file ?? "", { port: deps.port, mode: req.method, apiKey: req.apiKey, baseUrl: req.relay?.baseUrl });
  if (precheck.error) throw new LoginError(precheck.error.code, precheck.error.message, { status: 409 });
  let prep = { noProxyExtra: null, notes: [], warnings: [] };
  if (req.method === "relay") prep = await prepareRelay(req.relay, deps, { envPresent: state.envPresent });
  const plan = planClaudeApiSettings(state.file ?? "", {
    port: deps.port,
    mode: req.method,
    apiKey: req.apiKey,
    baseUrl: req.relay?.baseUrl,
    noProxyExtra: prep.noProxyExtra,
  });
  if (plan.error) throw new LoginError(plan.error.code, plan.error.message, { status: 409 });
  if (plan.action === "write") {
    deps.phase?.("writing", `写 ~/${CLAUDE_SETTINGS_FILE} 的 env（只改 ${plan.changedKeys.join(" / ")}，已备份，权限 600）`);
    const res = await deps.runRemote(buildReplaceFileCommand(CLAUDE_SETTINGS_FILE, Buffer.byteLength(plan.text, "utf8"), { chmod600: true }), { input: plan.text, timeoutMs: SSH_WRITE_TIMEOUT_MS });
    if (res?.code !== 0) throw sshFailure(res, `写 ~/${CLAUDE_SETTINGS_FILE} `);
  }
  deps.phase?.("verifying", "核对登录状态");
  const status = await verifyStatus(deps, "claude");
  const where = req.method === "relay" ? `中转站 ${req.relay.host}` : "官方 API key";
  return {
    message: `Claude Code 已改用${where}；新开的 claude 会话生效`,
    status,
    notes: prep.notes,
    warnings: prep.warnings,
  };
}

// 入口：req 来自 normalizeApiLoginRequest。返回 { message, status, notes, warnings }。
export async function runApiLogin(req, deps) {
  try {
    if (req.cli === "codex" && req.method === "api") return await codexOfficialKey(req, deps);
    if (req.cli === "codex" && req.method === "relay") return await codexRelay(req, deps);
    if (req.cli === "claude" && (req.method === "api" || req.method === "relay")) return await claudeApi(req, deps);
    throw new LoginError("bad-method", `不支持的登录方式: ${req.cli}/${req.method}`);
  } finally {
    // 尽力而为：JS 字符串无法真正清零，至少不让 req 继续引用 key。
    req.apiKey = null;
  }
}

// Claude 长期令牌（setup-token 输出）落 keys/claude-oauth.env，由 env.sh 引入为 CLAUDE_CODE_OAUTH_TOKEN。
export async function storeClaudeOauthToken(token, deps) {
  const text = renderKeyFile("CLAUDE_CODE_OAUTH_TOKEN", token);
  const res = await deps.runRemote(buildWriteKeyFileCommand(CLAUDE_OAUTH_KEY_FILE, Buffer.byteLength(text, "utf8")), { input: text, timeoutMs: SSH_WRITE_TIMEOUT_MS });
  if (res?.code !== 0) throw sshFailure(res, "写长期令牌文件");
}

export { verifyStatus as verifyLoginStatus };
