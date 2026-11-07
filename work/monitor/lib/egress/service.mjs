// 出网设置的控制面服务（v2.54，/api/egress* 的业务层）：读当前出网方式与个人白名单、改出网方式、
// 增删个人白名单、跑出网自测。写入一律经 savePersonalConfig（config-loader 的 writePersonalConfig
// 校验口径 + 乐观并发），本机代理约 2 秒内自行热载——这里不碰代理进程。
//
// fixture 模式（冒烟 / 界面预览用的隔离监控服务，v2.62）：这里不发任何本机或远端的网络请求，也不执行
// 系统命令——不识别系统代理、不读本机代理的 /proxy-health（那个端口上跑着的是用户正在用的代理）、
// 自测不经代理发任何连接、不发 SSH。状态里的代理与系统代理是固定的夹具值，自测回一份夹具结果。
// 读写仍然落在 fixture 自己的临时个人配置与临时运行目录里。
import http from "node:http";

import { ConfigValidationError, PERSONAL_ALLOWLIST_MAX, resolveEgressSetting, resolveProxyPort, selectMainServer } from "../config-loader.mjs";
import { formatAuthority, parseAllowlistEntry } from "../proxy/address.mjs";
import { parseProxyHealthHeaders } from "../proxy/protocol.mjs";
import { createSystemProxyDetector } from "../proxy/system-proxy.mjs";
import { isSelfUpstream } from "../proxy/upstream.mjs";
import { classifySshFailure } from "../ssh-args.mjs";
import { isPort } from "../validators.mjs";
import { classifyRelayBaseUrl } from "./relay-url.mjs";
import { buildFullChainCommand, buildSuggestion, parseFullChainOutput, probeTargetVia, runLocalSelfTest } from "./self-test.mjs";

const HEALTH_TIMEOUT_MS = 2000;

// GET 127.0.0.1:<端口>/proxy-health → { running, supportsEgress, mode }。
// 旧版代理（热更新前）没有出网头：supportsEgress=false，界面提示"更新后生效"。
// 代理只发布出网方式、不发布上游地址（v2.54 终审：节点上任何账号都能经反向端口读到这个头）；
// "经哪个上游"由 resolveEffectiveUpstream 在本机按同一份个人配置与系统代理识别结果算出。
function defaultReadProxyHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/proxy-health", timeout: HEALTH_TIMEOUT_MS }, (res) => {
      res.resume();
      const mode = res.headers["x-codex-proxy-egress"];
      resolve({
        running: res.statusCode === 200 && res.headers["x-codex-proxy"] === "active",
        supportsEgress: typeof mode === "string",
        mode: typeof mode === "string" ? mode : null,
        pid: parseProxyHealthHeaders(res.headers).pid,
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve({ running: false, supportsEgress: false, mode: null }));
  });
}

// 代理实际生效的出网方式（health.mode）→ 它此刻经哪个上游（"host:port" 或 null），与
// policy-reload.mjs 的 apply 同口径：manual 用个人层填写的地址，system 用系统代理识别结果，
// 指回本代理自己的上游被代理丢弃（按直连）。按 health.mode 而不是配置里的 mode 算：刚改完设置、
// 代理还没热载时，显示的仍是代理此刻真实的走法。system 模式下代理约 30 秒复查一次系统代理，
// 与这里的识别结果可能短暂不一致——只影响显示，不影响转发。
export function resolveEffectiveUpstream({ health, egress, systemProxy, proxyPort }) {
  if (!health?.running || !health.supportsEgress) return null;
  let upstream = null;
  if (health.mode === "manual") upstream = resolveEgressSetting({ mode: "manual", url: egress?.url }).upstream;
  else if (health.mode === "system") upstream = systemProxy?.proxy || null;
  if (!upstream || isSelfUpstream(upstream, proxyPort)) return null;
  return formatAuthority(upstream.host, upstream.port);
}

// 读 /proxy-health 并补上本机算出的 upstream：{ running, supportsEgress, mode, upstream }。
function withEffectiveUpstream(health, context) {
  const { running = false, supportsEgress = false, mode = null } = health || {};
  const base = { running, supportsEgress, mode };
  return { ...base, upstream: resolveEffectiveUpstream({ health: base, ...context }) };
}

const errorOf = (field, message) => new ConfigValidationError(message, [{ field, message }]);

// fixture 模式下的固定回答：没有数据面在跑（fixture 本来就不拉起通道），系统里没有识别到代理。
const FIXTURE_SYSTEM_PROXY = Object.freeze({ source: "fixture", proxy: null, socks: null, pac: null, error: null });
const FIXTURE_HEALTH = Object.freeze({ running: false, supportsEgress: false, mode: null, pid: null });
const FIXTURE_NOTE = "fixture 模式不做出网自测：不经本机代理发连接，也不发 SSH。";

// 合并配置里的白名单 → 归一化条目数组（无效条目跳过；代理侧同样会跳过它们）。
function normalizedEntries(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const parsed = parseAllowlistEntry(raw);
    if (parsed.entry && !out.includes(parsed.entry)) out.push(parsed.entry);
  }
  return out;
}

export function createEgressService({
  getConfig,
  // supervisor 首拍会把共享代理端口钉死；切换 activeServer 后配置里的
  // localPort 可能已经变化，但实际代理仍在旧端口。优先读新鲜运行快照，
  // 避免状态页/自测打到错误端口。
  getConnectionTargets = null,
  getPersonalConfig,
  savePersonalConfig,
  refreshConfigIntoKernel = async () => {},
  detector = createSystemProxyDetector(),
  readProxyHealth = defaultReadProxyHealth,
  runLocal: runLocalImpl = runLocalSelfTest,
  probe = probeTargetVia,
  // (server, config, command, { timeoutMs }) → { code, stdout, stderr }；缺省时全链路自测不可用。
  runRemote = null,
  acquireSshSlot = null,
  // 代理口令与使用记录（v2.62，lib/egress/proxy-auth-service.mjs）。缺省时没有这一节：状态里 proxyAuth 为 null，
  // 自测照旧不带口令。
  proxyAuth = null,
  // fixture 模式：见文件头。为真时下面注入的 detector / readProxyHealth / runLocal / probe / runRemote 一个都不调用。
  fixtureMode = false,
}) {
  const selfTestInFlight = new Map(); // scope → 在途 Promise

  function resolveEffectiveProxyPort(config) {
    const runtime = typeof getConnectionTargets === "function" ? getConnectionTargets() : null;
    const runtimePort = runtime?.source === "supervisor-snapshot" && runtime.freshness === "fresh"
      ? runtime.effectiveProxyPort?.value
      : null;
    return isPort(runtimePort) ? runtimePort : resolveProxyPort(config);
  }

  async function getStatus() {
    const [config, personal] = await Promise.all([getConfig(), Promise.resolve(getPersonalConfig())]);
    const proxyPort = resolveEffectiveProxyPort(config);
    const egress = resolveEgressSetting(personal?.egress);
    const personalEntries = normalizedEntries(personal?.proxyAllowedTargets);
    const teamEntries = normalizedEntries(config?.proxyAllowedTargets).filter((entry) => !personalEntries.includes(entry));
    const [systemProxy, health] = fixtureMode
      ? [FIXTURE_SYSTEM_PROXY, FIXTURE_HEALTH]
      : await Promise.all([detector.detect(), readProxyHealth(proxyPort)]);
    const proxyAuthView = proxyAuth ? await proxyAuth.getView({ proxy: { running: health?.running === true, pid: health?.pid ?? null } }) : null;
    return {
      egress: { mode: egress.mode, url: egress.url },
      configIssue: egress.issue,
      effective: withEffectiveUpstream(health, { egress, systemProxy, proxyPort }),
      systemProxy,
      allowlist: { personal: personalEntries, team: teamEntries, max: PERSONAL_ALLOWLIST_MAX },
      proxyPort,
      revision: personal?.revision ?? 0,
      // 代理口令：模式、是否已写到集群、近 24 小时带 / 没带口令的请求数（不含口令本身）。
      proxyAuth: proxyAuthView,
    };
  }

  // 只要 getStatus().effective 那一项（v2.65，出网健康的主动探测用，lib/egress/egress-health.mjs）：
  // 同一口径，但不读口令与使用记录、不碰集群；系统代理只在代理生效的方式是 system 时才识别（别的方式用不上它）。
  // fixture 模式回夹具值，不读 /proxy-health。
  async function getEffective() {
    const [config, personal] = await Promise.all([getConfig(), Promise.resolve(getPersonalConfig())]);
    const proxyPort = resolveEffectiveProxyPort(config);
    const egress = resolveEgressSetting(personal?.egress);
    if (fixtureMode) return withEffectiveUpstream(FIXTURE_HEALTH, { egress, systemProxy: FIXTURE_SYSTEM_PROXY, proxyPort });
    const health = await readProxyHealth(proxyPort);
    const systemProxy = health?.running && health.mode === "system" ? await detector.detect() : null;
    return withEffectiveUpstream(health, { egress, systemProxy, proxyPort });
  }

  // 写个人层：乐观并发——以刚读到的 revision 为准，期间被别处改过就 409（前端提示重新打开）。
  async function savePatch(patch, context) {
    const personal = getPersonalConfig() || {};
    await savePersonalConfig({ ...patch, expectedRevision: personal.revision ?? 0 }, context);
    await refreshConfigIntoKernel();
  }

  // { mode, url? }：manual 的地址不能指回本代理自己（会原地转圈）。
  async function setMode(input, context) {
    const mode = input?.mode;
    const url = typeof input?.url === "string" ? input.url.trim() : undefined;
    if (mode === "manual" && url) {
      const parsed = resolveEgressSetting({ mode, url });
      const proxyPort = resolveEffectiveProxyPort(await getConfig());
      if (parsed.upstream && isSelfUpstream(parsed.upstream, proxyPort)) {
        throw errorOf("egress.url", `手动地址不能是本机代理自己（127.0.0.1:${proxyPort}），请填代理软件的 HTTP 端口`);
      }
    }
    // 没给地址时沿用之前填过的手动地址：切到直连 / 系统代理再切回「手动」不必重填。
    const keepUrl = url || resolveEgressSetting(getPersonalConfig()?.egress).url;
    await savePatch({ egress: { mode, ...(keepUrl ? { url: keepUrl } : {}) } }, context);
    return getStatus();
  }

  // { add } 接受 "host:port" 或中转站 base URL；{ remove } 只接受 "host:port"。
  async function updateAllowlist(input, context) {
    const personal = getPersonalConfig() || {};
    const current = normalizedEntries(personal.proxyAllowedTargets);
    let next = current;
    if (typeof input?.add === "string" && input.add.trim()) {
      const text = input.add.trim();
      let entry = parseAllowlistEntry(text).entry;
      if (!entry && /^[a-z]+:\/\//i.test(text)) {
        const relay = classifyRelayBaseUrl(text);
        if (relay.action === "none") throw errorOf("add", "https 的 443 端口默认放行，不需要加白名单");
        if (relay.action === "direct-candidate") throw errorOf("add", "内网 / 校内地址不经本机代理，请让集群直连它（不需要加白名单）");
        if (relay.action !== "allowlist") throw errorOf("add", "无法识别这个地址，请填 主机名:端口 或完整的 https:// 地址");
        entry = relay.entry;
      }
      // 其余格式问题（缺端口 / 443 / 私网）交给 writePersonalConfig 的写入校验统一给原因。
      next = current.includes(entry || text) ? current : [...current, entry || text];
    } else if (typeof input?.remove === "string" && input.remove.trim()) {
      const target = parseAllowlistEntry(input.remove.trim()).entry || input.remove.trim();
      next = current.filter((entry) => entry !== target);
    } else {
      throw errorOf("allowlist", "请提供要添加（add）或删除（remove）的条目");
    }
    if (next !== current) await savePatch({ proxyAllowedTargets: next }, context);
    return getStatus();
  }

  // 自测：同一范围同一时刻只跑一轮（重复点击复用在途结果）。scope:"full" 再走一次集群全链路。
  function runSelfTest({ scope = "local" } = {}) {
    const key = scope === "full" ? "full" : "local";
    if (fixtureMode) return fixtureSelfTest(key);
    if (selfTestInFlight.has(key)) return selfTestInFlight.get(key);
    const run = (async () => {
      const config = await getConfig();
      const proxyPort = resolveEffectiveProxyPort(config);
      const [results, systemProxy, health] = await Promise.all([
        runLocal({ proxyPort }),
        detector.detect({ force: true }),
        readProxyHealth(proxyPort),
      ]);
      const egress = resolveEgressSetting(getPersonalConfig()?.egress);
      const effective = withEffectiveUpstream(health, { egress, systemProxy, proxyPort });
      // 直连全挂且识别到系统 HTTP 代理：绕过本机代理直测一次系统代理，给"改用系统代理"的底气。
      let systemCheck = null;
      const allDown = results.length > 0 && results.every((r) => !r.ok && r.stage !== "local-proxy");
      if (allDown && !effective?.upstream && systemProxy?.proxy) {
        systemCheck = await probe({ proxy: systemProxy.proxy, target: results[0].target, viaLocalProxy: false });
      }
      const report = {
        scope: key,
        proxyPort,
        effective,
        results,
        systemCheck,
        suggestion: buildSuggestion({ results, effective, systemProxy, systemCheck }),
      };
      if (key === "full") report.full = await runFullChain(config);
      return report;
    })().finally(() => {
      selfTestInFlight.delete(key);
    });
    selfTestInFlight.set(key, run);
    return run;
  }

  async function runFullChain(config) {
    const server = selectMainServer(config);
    if (!server) return { ok: false, stage: "config", message: "没有可用的服务器" };
    if (!server.remotePort) return { ok: false, stage: "config", message: `服务器 ${server.id} 还没有反向端口` };
    if (typeof runRemote !== "function") return { ok: false, stage: "config", message: "全链路自测在当前模式下不可用" };
    const release = acquireSshSlot ? await acquireSshSlot({ hostKey: server.host }) : () => {};
    try {
      const curlInput = proxyAuth?.curlInput?.() ?? null;
      const command = buildFullChainCommand(server.remotePort, { withProxyAuth: curlInput !== null });
      const { stdout, stderr } = await runRemote(server, config, command, { timeoutMs: 25000, ...(curlInput !== null ? { input: curlInput } : {}) });
      const output = `${stdout || ""}\n${stderr || ""}`;
      const parsed = parseFullChainOutput(output, { remotePort: server.remotePort });
      if (parsed.stage === "ssh") {
        const failure = classifySshFailure(output);
        if (failure) parsed.message = `SSH 连不上服务器（${failure.nextAction}）`;
      }
      return { serverId: server.id, remotePort: server.remotePort, ...parsed };
    } catch (err) {
      return { serverId: server.id, ok: false, stage: "ssh", message: `SSH 执行失败：${err?.message || err}` };
    } finally {
      release();
    }
  }

  // fixture 模式的自测结果：形状与真的一样（界面照常渲染），但一个连接都没发。
  async function fixtureSelfTest(key) {
    const report = {
      scope: key,
      fixture: true,
      proxyPort: resolveProxyPort(await getConfig()),
      effective: withEffectiveUpstream(FIXTURE_HEALTH, { egress: resolveEgressSetting(getPersonalConfig()?.egress), systemProxy: FIXTURE_SYSTEM_PROXY, proxyPort: null }),
      results: [],
      systemCheck: null,
      suggestion: { kind: "fixture", text: FIXTURE_NOTE },
    };
    if (key === "full") report.full = { ok: false, stage: "fixture", message: "fixture 模式不发起真实 SSH" };
    return report;
  }

  // 本机段自测：口令不是关时带上 Proxy-Authorization（否则「强制」下自测自己先被 407 拦住）。
  function runLocal(options) {
    const proxyAuthorization = proxyAuth?.localAuthorization?.() || "";
    return runLocalImpl(proxyAuthorization ? { ...options, proxyAuthorization } : options);
  }

  // ---- 代理口令（POST /api/egress/proxy-auth*）与使用记录（GET /api/egress/usage）----
  const requireProxyAuth = () => {
    if (!proxyAuth) throw Object.assign(new Error("代理口令在当前模式下不可用"), { status: 503 });
    return proxyAuth;
  };

  // { mode, confirm? } | { rotate: true, force? } | { retirePrevious: true } → 同 GET 的载荷，另带这次动作的结果。
  async function setProxyAuth(input) {
    const service = requireProxyAuth();
    let result;
    if (input?.rotate === true) result = { action: "rotate", ...service.rotate({ force: input.force === true }) };
    else if (input?.retirePrevious === true) result = { action: "retire-previous", ...service.retirePrevious() };
    else result = { action: "mode", ...(await service.setMode({ mode: input?.mode, confirm: input?.confirm === true })) };
    return { ...(await getStatus()), proxyAuthResult: result };
  }

  // { confirm? }：不带 confirm 只预览要改哪几个文件；带了才写。→ { sync, proxyAuth }
  async function syncProxyAuth(input) {
    const service = requireProxyAuth();
    const sync = await service.sync({ confirm: input?.confirm === true });
    return { sync, proxyAuth: (await getStatus()).proxyAuth };
  }

  async function getUsage() {
    return requireProxyAuth().getUsage();
  }

  return { getStatus, getEffective, setMode, updateAllowlist, runSelfTest, setProxyAuth, syncProxyAuth, getUsage };
}
