// 首次运行引导判定（纯函数）：/api/status.onboarding 与 scripts/launch.mjs 首次运行检测的**唯一**数据源。
// 两处必须同一套判定，否则会出现"终端每次 npm start 都说没配置、控制台却说 ready"的矛盾。
//
// assessSetup 返回 { state, reason, host?, sshUser? }：
//   state:
//     "needs-setup" —— 个人层 config.local.json 不存在，且 ~/.ssh/config 也解析不出主服务器的 User：
//                      SSH 用户名/反向端口都还是团队默认值，全红是必然结果。
//     "partial"     —— 主服务器仍启用，但向导没走完：合并配置与 ~/.ssh/config 都给不出 sshUser
//                      （个人层存在时），或者主服务器要建隧道却还没领到反向端口（v2.54 起团队层
//                      不再预烤 remotePort，端口只来自个人层 portOverrides；个人层缺失时也算）。
//     "no-servers"  —— 个人层存在，但没有任何启用的服务器（全被屏蔽/禁用）。
//     "ready"       —— 其余情况。
//   reason（launch.mjs 的终端提示用）：
//     "no-local-config" | "missing-ssh-user" | "missing-port" | "invalid-local-config" |
//     "no-local-config-ssh-ok"（个人层缺失但 ssh 别名能解析出 User → 视为可用，仅提示）| "no-servers" | null
//   missing-port 排在 missing-ssh-user 之后：两样都缺时先补用户名（向导一次会把端口也领了）。
//
// sshUser 解析顺序：主服务器条目 sshUser → 全局 sshUser → ~/.ssh/config 里该服务器 Host 别名的 User
// （ssh 本身就是这么取用户名的；很多老用户只在 ~/.ssh/config 写了 `Host myserver / User kai`）。
// 个人层存在但损坏（_localConfigError / localState:"invalid"）不引导：那是修复场景，已有独立提示。
import { listServersMissingPort } from "./config-loader.mjs";
import { shellSingleQuote } from "./shell/quote.mjs";

export const TEAM_PRIMARY_SERVER_ID = "server-01";

const hasText = (v) => typeof v === "string" && v.trim() !== "";

export function assessSetup({ localState = "ok", merged, resolveSshUser = () => "" } = {}) {
  if (localState === "invalid" || merged?._localConfigError) return { state: "ready", reason: "invalid-local-config" };
  const servers = Array.isArray(merged?.servers) ? merged.servers : [];
  const enabled = servers.filter((s) => s && s.disabled !== true && s.monitorEnabled !== false);
  const primary = servers.find((s) => s && s.id === TEAM_PRIMARY_SERVER_ID && s.disabled !== true) || null;
  let sshUser = "";
  if (primary) {
    if (hasText(primary.sshUser)) sshUser = primary.sshUser.trim();
    else if (hasText(merged?.sshUser)) sshUser = merged.sshUser.trim();
    else {
      try {
        const resolved = resolveSshUser(primary.host || primary.id);
        if (hasText(resolved)) sshUser = resolved.trim();
      } catch {
        sshUser = "";
      }
    }
  }
  // 主服务器启用、要建隧道，却没有可用反向端口（还没领 / 写坏被剔除）：隧道不会建立。
  const primaryMissingPort = Boolean(primary) && primary.monitorEnabled !== false
    && listServersMissingPort(merged).some((s) => s.id === primary.id);
  if (localState === "missing") {
    if (primary && sshUser) {
      if (primaryMissingPort) return { state: "partial", reason: "missing-port", host: primary.host || primary.id, sshUser };
      return { state: "ready", reason: "no-local-config-ssh-ok", host: primary.host || primary.id, sshUser };
    }
    return { state: "needs-setup", reason: "no-local-config" };
  }
  if (merged && servers.length > 0 && enabled.length === 0) return { state: "no-servers", reason: "no-servers" };
  if (primary && !sshUser) return { state: "partial", reason: "missing-ssh-user" };
  if (primaryMissingPort) return { state: "partial", reason: "missing-port", host: primary.host || primary.id, sshUser };
  return { state: "ready", reason: null };
}

// 带 TTL 的缓存包装：/api/status 与 SSE lite 每次都会取 runtime extras，
// 不能每次都同步 stat 一次文件。exists / resolveSshUser 可注入（测试）。
// createOnboardingAssessmentProbe 返回完整判定 { state, reason }（引导卡要按 reason 换文案，
// 如 missing-port）；createOnboardingProbe 是只取 state 的旧接口，返回值逐字不变。
export function createOnboardingAssessmentProbe({ exists, getMerged, resolveSshUser, ttlMs = 5000, now = Date.now } = {}) {
  let cached = null;
  let cachedAt = -Infinity;
  return function getOnboardingAssessment() {
    const t = now();
    if (cached !== null && t - cachedAt < ttlMs) return cached;
    let localConfigExists = true;
    try {
      localConfigExists = exists() === true;
    } catch {
      localConfigExists = true; // 探测失败按"已配置"处理，宁可不引导也不误报
    }
    const assessed = assessSetup({ localState: localConfigExists ? "ok" : "missing", merged: getMerged?.() || null, resolveSshUser });
    cached = { state: assessed.state, reason: assessed.reason ?? null };
    cachedAt = t;
    return cached;
  };
}

export function createOnboardingProbe(options = {}) {
  const getAssessment = createOnboardingAssessmentProbe(options);
  return function getOnboardingState() {
    return getAssessment().state;
  };
}

// 引导卡里给用户复制的向导命令。个人层就在仓库根（源码模式默认）时就是 npm run setup；
// 否则（CODEX_MONITOR_DATA_DIR / LOCAL_CONFIG_PATH 覆盖、打包 .app）必须带上覆盖变量，
// 向导才会写到控制台实际读取的那份 config.local.json。
export function buildSetupCommand({ localConfigPath, appRoot, platform = process.platform } = {}) {
  if (!localConfigPath || !appRoot) return "npm run setup";
  const norm = (p) => {
    const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "win32" ? s.toLowerCase() : s;
  };
  if (norm(localConfigPath) === `${norm(appRoot)}/config.local.json`) return "npm run setup";
  if (platform === "win32") return `$env:CODEX_MONITOR_LOCAL_CONFIG_PATH="${localConfigPath}"; npm run setup`;
  return `CODEX_MONITOR_LOCAL_CONFIG_PATH=${shellSingleQuote(localConfigPath)} npm run setup`;
}
