// 代理策略的加载与热重载（v2.54）：分层配置 → { allowTarget, extraAllowedTargets, egressMode, upstream }。
// 此前白名单只在代理启动时读一次，改了要重启代理（= 集群全部出网断一下）；现在：
//   - 每 2 秒 stat 团队 / 个人配置文件（fileStamp：ino/size/mtime/ctime），戳变了才重读；
//   - 出网方式为 system 时另每 30 秒重新识别系统代理（代理软件切了端口 / 关了系统代理）；
//   - 新策略整体替换，createProxyServer 每个请求现取——已建立的连接不受影响，进程不重启。
// 生命线约束：任何一步读不出来都只告警。首次加载失败回落内置默认（空白名单 + 直连），
// 之后失败（含个人层半写 / 损坏）保留上一份生效策略，绝不把白名单静默清空，也绝不抛到进程级。
//
// 代理口令（v2.62）随同一个 2 秒轮询生效：口令文件 <runtimeDir>/proxy-auth.json 单独记文件戳，它变了只换
// 策略里的 auth，不重读分层配置。三种结局——文件不存在 → 关；读得出且校验通过 → 换上；读不出 / 格式
// 不对 → 保留上一份并告警（首次加载没有上一份，就是关）。也就是说坏文件永远不会让放行变成拒绝。
import { readFileSync, statSync } from "node:fs";

import { loadLayeredConfig, resolveEgressSetting } from "../config-loader.mjs";
import { fileStamp } from "../stat-cache.mjs";
import { formatAuthority } from "./address.mjs";
import { AUTH_OFF, parseProxyAuthFile, PROXY_AUTH_FILE_MAX_BYTES } from "./auth.mjs";
import { createSystemProxyDetector } from "./system-proxy.mjs";
import { EXTRA_ALLOWED_TARGETS, makeDefaultAllowTarget, resolveExtraAllowedTargets } from "./target-policy.mjs";
import { isSelfUpstream } from "./upstream.mjs";

export const CONFIG_POLL_MS = 2000;
export const SYSTEM_PROXY_POLL_MS = 30_000;

const EGRESS_LABELS = { direct: "直连", system: "系统代理", manual: "手动上游" };
const AUTH_LABELS = { off: "关", observe: "只记录", enforce: "强制" };

// 策略对象：server.mjs 每个请求读 allowTarget / upstream / auth；egressMode 经 /proxy-health 头发布
// （auth 不发布：那个接口节点上谁都读得到）。
export function buildPolicy({ extraAllowedTargets = EXTRA_ALLOWED_TARGETS, egressMode = "direct", upstream = null, auth = AUTH_OFF } = {}) {
  return {
    allowTarget: makeDefaultAllowTarget(extraAllowedTargets),
    extraAllowedTargets,
    egressMode,
    upstream,
    auth,
  };
}

// 口令策略的指纹（模式 + 两个摘要 + 过渡期截止）：只在进程内比较，不进日志。
function authSignature(auth) {
  return `${auth.mode}|${auth.current?.toString("hex") ?? "-"}|${auth.previous?.toString("hex") ?? "-"}|${auth.previousUntil}`;
}

// 缺省的口令文件读取：先看大小，不是我们写的大文件不读进内存。
function readAuthFileDefault(file) {
  if (statSync(file).size > PROXY_AUTH_FILE_MAX_BYTES) throw Object.assign(new Error("file too large"), { code: "too-large" });
  return readFileSync(file, "utf8");
}

// 策略指纹：只有它变了才打"已生效"日志（个人层里活跃服务器等无关字段改动不刷屏）。
function policySignature(policy) {
  const upstream = policy.upstream ? formatAuthority(policy.upstream.host, policy.upstream.port) : "-";
  return `${[...policy.extraAllowedTargets].sort().join(",")}|${policy.egressMode}|${upstream}`;
}

function describePolicy(policy, note) {
  const label = EGRESS_LABELS[policy.egressMode] || policy.egressMode;
  const via = policy.upstream ? ` ${policy.upstream.url}` : policy.egressMode === "direct" ? "" : `（${note || "无可用上游"}，暂按直连）`;
  return `白名单 ${policy.extraAllowedTargets.size} 条，出网 ${label}${via}`;
}

export function createPolicyLoader({
  configPath,
  localConfigPath,
  loadConfig = (paths) => loadLayeredConfig({ ...paths, onLocalError: () => {} }),
  stamp = fileStamp,
  detector = createSystemProxyDetector(),
  // 本代理监听端口：上游若指回自己（环回 + 同端口）就丢弃上游、按直连，免得每个请求原地转圈。
  selfPort = null,
  // 口令文件路径（<runtimeDir>/proxy-auth.json）。不给 = 没有这项功能，口令恒为关。
  authPath = null,
  readAuthFile = readAuthFileDefault,
  // 生效的口令策略变了（含首次加载就不是关）时回调一次；入口据此开关使用记录。
  onAuthChange = () => {},
  log = (line) => console.error(line),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  let policy = buildPolicy();
  let settings = null; // 最近一次成功读出的 { extraAllowedTargets, egress }
  let auth = AUTH_OFF; // 生效的口令策略
  let lastStamp = null;
  let lastAuthStamp = null;
  let lastSignature = null;
  let loaded = false;
  let queue = Promise.resolve();
  const timers = [];

  const currentStamp = () => [configPath, localConfigPath].map((p) => stamp(p)).join("|");

  // 口令文件 → 口令策略；null = 读不出或格式不对（调用方保留上一份）。告警里只有固定代号与错误码，
  // 没有文件内容。只在文件戳变化时才读，所以一份坏文件只告警一次，不刷屏。
  function readAuth(authStamp) {
    if (authStamp === "missing") return AUTH_OFF;
    const keep = `口令设置保持「${AUTH_LABELS[auth.mode]}」不变`;
    try {
      if (authStamp.startsWith("err:")) throw Object.assign(new Error("stat failed"), { code: authStamp.slice(4) });
      const parsed = parseProxyAuthFile(readAuthFile(authPath));
      if (parsed.ok) return parsed.policy;
      log(`[proxy-config] 口令文件格式不对（${parsed.reason}），${keep}`);
    } catch (err) {
      log(`[proxy-config] 口令文件读取失败（${err?.code || "error"}），${keep}`);
    }
    return null;
  }

  // 换上新的口令策略。策略对象整体换新（server.mjs 每个请求现取），已建立的连接不受影响。
  function applyAuth(next) {
    const before = auth;
    if (authSignature(next) === authSignature(before)) return;
    auth = next;
    policy = { ...policy, auth };
    const sameToken = (next.current?.toString("hex") ?? "") === (before.current?.toString("hex") ?? "");
    const what = next.mode !== before.mode ? "代理口令已生效" : sameToken ? "代理口令的过渡期已更新" : "代理口令已更换";
    const rotating = next.mode !== "off" && next.previous ? "，过渡期内上一个口令仍接受" : "";
    log(`[proxy-config] ${what}：${AUTH_LABELS[next.mode]}${rotating}`);
    try {
      onAuthChange(next);
    } catch {}
  }

  // 文件戳变了才读；返回是否发生了重读。首次加载与轮询共用。
  function syncAuth() {
    if (!authPath) return false;
    const authStamp = stamp(authPath);
    if (authStamp === lastAuthStamp) return false;
    lastAuthStamp = authStamp;
    const next = readAuth(authStamp);
    if (next) applyAuth(next);
    return true;
  }

  // 读分层配置 → settings；失败返回 null（调用方保留旧策略）。首次加载失败给内置默认。
  function readSettings(initial) {
    try {
      if (!configPath) throw new Error("runtime paths unavailable");
      const config = loadConfig({ configPath, localConfigPath });
      if (config?._localConfigError) {
        if (!initial) {
          log("[proxy-config] 个人配置读取失败（可能正在写入或已损坏），保留当前白名单与出网方式");
          return null;
        }
        // 首次加载没有"上一份"可保留：照旧只用团队层（个人白名单与出网方式本次不生效），但要
        // 说一声——loadConfig 的 onLocalError 被静音了，否则个人层坏掉在启动时毫无痕迹。
        log("[proxy-config] 个人配置读取失败（可能已损坏），本次只按团队配置加载：个人白名单与出网方式暂不生效，修好后约 2 秒内自动热载");
      }
      const extraAllowedTargets = resolveExtraAllowedTargets(config.proxyAllowedTargets, { log });
      const egress = resolveEgressSetting(config.egress);
      if (egress.issue) log(`[proxy-config] ${egress.issue}，出网按直连处理`);
      return { extraAllowedTargets, egress };
    } catch (err) {
      if (!initial) {
        log(`[proxy-config] 重读配置失败，保留当前白名单与出网方式: ${err.message}`);
        return null;
      }
      log(`[proxy-config] 读取配置失败（proxyAllowedTargets 回落内置默认白名单，出网按直连）: ${err.message}`);
      return { extraAllowedTargets: EXTRA_ALLOWED_TARGETS, egress: resolveEgressSetting(undefined) };
    }
  }

  // settings → 生效策略。system 模式要识别系统代理（force：定时复查时绕过 30 秒缓存）。
  async function apply(next, { force = false } = {}) {
    let upstream = null;
    let note = "";
    if (next.egress.mode === "manual") {
      upstream = next.egress.upstream;
    } else if (next.egress.mode === "system") {
      try {
        const detected = await detector.detect({ force });
        upstream = detected?.proxy || null;
        if (!upstream) note = detected?.socks ? "系统只开了 SOCKS 代理，暂不支持" : detected?.pac ? "系统使用 PAC 自动配置，暂不支持" : "未识别到系统 HTTP 代理";
      } catch (err) {
        note = `识别系统代理失败：${err?.message || err}`;
      }
    }
    if (upstream && isSelfUpstream(upstream, selfPort)) {
      note = `上游 ${upstream.url} 就是本代理自己`;
      upstream = null;
    }
    const nextPolicy = buildPolicy({
      extraAllowedTargets: next.extraAllowedTargets,
      egressMode: next.egress.mode,
      upstream: upstream ? { host: upstream.host, port: upstream.port, url: upstream.url } : null,
      auth,
    });
    policy = nextPolicy;
    const signature = `${policySignature(nextPolicy)}|${note}`;
    if (signature !== lastSignature) {
      log(`[proxy-config] ${loaded ? "策略已热重载" : "策略已加载"}：${describePolicy(nextPolicy, note)}`);
      lastSignature = signature;
    }
  }

  // 串行化：配置轮询与系统代理复查都是 async，同时触发时不能交错改 policy。
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  // 首次加载（启动时 await 一次）。之后的变化由 start() 的轮询驱动。
  function load() {
    return serialize(async () => {
      try {
        // 口令先于白名单 / 出网方式就位：后面哪一步出了意外，策略里的口令设置也已经是盘上那一份。
        try {
          syncAuth();
        } catch (err) {
          log(`[proxy-config] 加载代理口令异常，按「关」运行: ${err?.code || "error"}`);
        }
        lastStamp = currentStamp();
        settings = readSettings(true);
        await apply(settings);
      } catch (err) {
        log(`[proxy-config] 加载代理策略异常，按内置默认运行: ${err?.message || err}`);
      } finally {
        loaded = true;
      }
    });
  }

  // 口令文件的戳变化才重读；返回是否发生了重读。任何异常只告警、保留当前口令设置。
  function checkAuth() {
    return serialize(async () => {
      try {
        return syncAuth();
      } catch (err) {
        log(`[proxy-config] 重读代理口令异常，口令设置保持不变: ${err?.code || "error"}`);
        return false;
      }
    });
  }

  // 戳变化才重读；返回是否发生了重读。
  function checkConfig() {
    return serialize(async () => {
      try {
        const s = currentStamp();
        if (s === lastStamp) return false;
        lastStamp = s;
        const next = readSettings(false);
        if (!next) return true;
        settings = next;
        await apply(next);
        return true;
      } catch (err) {
        log(`[proxy-config] 热重载异常，保留当前策略: ${err?.message || err}`);
        return false;
      }
    });
  }

  // system 模式的定时复查：强制重新识别，上游变了就换。
  function refreshSystemProxy() {
    return serialize(async () => {
      if (settings?.egress.mode !== "system") return;
      try {
        await apply(settings, { force: true });
      } catch (err) {
        log(`[proxy-config] 复查系统代理异常，保留当前策略: ${err?.message || err}`);
      }
    });
  }

  function start({ pollMs = CONFIG_POLL_MS, systemPollMs = SYSTEM_PROXY_POLL_MS } = {}) {
    if (timers.length) return;
    // 分层配置与口令文件同一拍查（各看各的文件戳），不为口令另起定时器。
    const pollFiles = () => {
      checkConfig();
      checkAuth();
    };
    for (const [fn, ms] of [[pollFiles, pollMs], [refreshSystemProxy, systemPollMs]]) {
      const timer = setIntervalImpl(() => {
        fn();
      }, ms);
      if (timer && typeof timer.unref === "function") timer.unref();
      timers.push(timer);
    }
  }

  function stop() {
    while (timers.length) clearIntervalImpl(timers.pop());
  }

  return { load, checkConfig, checkAuth, refreshSystemProxy, start, stop, getPolicy: () => policy };
}
