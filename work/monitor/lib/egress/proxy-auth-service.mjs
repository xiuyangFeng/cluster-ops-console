// 代理口令与隧道使用记录的业务层（v2.62，/api/egress 里的 proxyAuth、/api/egress/proxy-auth*、/api/egress/usage）。
//
// 三样东西在这里汇合：
//   口令文件      lib/egress/proxy-auth-store.mjs（唯一的写入方；代理约 2 秒内热载）
//   使用记录      lib/egress/proxy-usage-view.mjs（代理写的 proxy-usage.json，只读）
//   集群侧的口令  lib/cluster-env-sync.mjs（env.sh 里带没带、是哪一个；「把口令写到集群」）
//
// 出这个模块的东西分两类，界限写死在这里：
//   给界面的（getView / getUsage / 各动作的返回值）——只有模式、计数、目标名、时刻这些事实，没有口令，
//   也没有口令的指纹。
//   给本进程里要带口令的调用方的（getCredential / localAuthorization）——口令原文。只有三处用：本机经代理的
//   自测、工作台自己发到集群的探测（经标准输入）、写到集群（经标准输入）。
import { statSync } from "node:fs";

import { isClusterEnvEligible } from "../cluster-env-sync.mjs";
import { credentialFingerprint } from "../cluster-env.mjs";
import { PROXY_AUTH_MODES } from "../proxy/auth.mjs";
import { statusError } from "../status-error.mjs";
import {
  readProxyUsage,
  recentUsage,
  summarizeUsage,
  topByTraffic,
  topUnauthenticated,
  trackUsageVersion,
  USAGE_WINDOW_HOURS,
  withRecentTraffic,
} from "./proxy-usage-view.mjs";
import { curlProxyAuthInput } from "./remote-proxy-auth.mjs";

// 代理此刻按什么口令模式在跑。代理不经 /proxy-health 回报这件事（那个接口节点上谁都读得到），而是写在
// 使用记录文件里；要它作数，写这份文件的进程得是正在监听的那个（pid 对得上）。
//   state  "applied"      已按配置的模式在跑（配置是关时，没有回报也算——关就是不做任何事）
//          "pending"      在跑，但回报的还是另一个模式（刚改完的几秒内；一直不变说明代理没读到新文件）；
//                         或者刚改完、它的第一份回报还没到（mode 为 null）
//          "unconfirmed"  在跑，却没有它的回报：旧版本的代理不认识口令，要平滑交接到新版本才生效
//          "not-running"  本机代理没有运行
// changedAt：口令设置上一次改动的时刻。代理约 2 秒热载一次口令文件，载到了才写第一份回报——第一次从「关」
// 打开时，头几秒里没有回报是正常的，不能就此说它是旧版本；过了 PROXY_AUTH_APPLY_GRACE_MS 还没有才这么说。
export const PROXY_AUTH_APPLY_GRACE_MS = 8000;

export function describeProxyAuthState({ configuredMode, usage, proxy, changedAt = null, now = Date.now() }) {
  if (!proxy?.running) return { state: "not-running", mode: null, since: null };
  const reported = usage?.pid && proxy.pid && usage.pid === proxy.pid ? usage.auth : null;
  if (!reported?.mode) {
    if (configuredMode === "off") return { state: "applied", mode: null, since: null };
    const sinceChange = Number.isFinite(changedAt) && changedAt > 0 ? now - changedAt : Number.POSITIVE_INFINITY;
    return { state: sinceChange >= 0 && sinceChange < PROXY_AUTH_APPLY_GRACE_MS ? "pending" : "unconfirmed", mode: null, since: null };
  }
  return { state: reported.mode === configuredMode ? "applied" : "pending", mode: reported.mode, since: reported.since || null };
}

export function createProxyAuthService({
  store,
  usagePath,
  readUsage = readProxyUsage,
  // 用量文件的 stat（sampleUsage 先看修改时刻，没变就不读）
  statUsage = statSync,
  getConfig,
  // () → lib/cluster-env-sync.mjs 的实例 | null。用取值函数：装配处它晚于出网服务创建；fixture 模式没有它。
  getClusterEnvSync = () => null,
  // fixture 模式（隔离的监控服务）：「把口令写到集群」直接回 409，不读集群也不发 SSH。口令文件与使用记录
  // 照常读写——它们在 fixture 自己的临时运行目录里。
  fixtureMode = false,
  now = Date.now,
  log = () => {},
}) {
  // 有受管 env.sh 可言的那台服务器：查看中的那台（是团队服务器的话），否则第一台团队服务器。
  async function clusterTarget() {
    const config = await getConfig();
    const servers = (config?.servers || []).filter(isClusterEnvEligible);
    return servers.find((server) => server.id === config?.activeServerId) ?? servers[0] ?? null;
  }

  // 集群上那份 env.sh 带的是哪一个口令。指纹只在这里比，比完只留结论。
  //   "current" 当前口令 / "previous" 上一个（换口令的过渡期内）/ "other" 认不得的（另一台电脑写的、更早的）
  //   "none" 没带 / "unverified" 带了但集群上算不出指纹 / "unknown" 还没查到
  function classifyClusterCredential(fingerprint) {
    if (fingerprint == null) return "unknown";
    if (fingerprint === "none") return "none";
    if (fingerprint === "nohash") return "unverified";
    if (fingerprint === credentialFingerprint(store.getStoredCredential())) return "current";
    if (fingerprint === credentialFingerprint(store.getPreviousCredential())) return "previous";
    return "other";
  }

  async function clusterView() {
    const clusterEnvSync = fixtureMode ? null : getClusterEnvSync();
    if (!clusterEnvSync) return null;
    const server = await clusterTarget();
    if (!server) return null;
    // getState 在快照过期时会在后台补查一轮（与 /api/status.clusterEnv 同一份节奏），这里不等它。
    const env = clusterEnvSync.getState(server.id);
    const credential = clusterEnvSync.getCredentialState(server.id);
    return {
      serverId: server.id,
      serverName: server.name || server.id,
      env: env?.state ?? "unknown",
      credential: env?.state === "absent" ? "none" : classifyClusterCredential(credential?.fingerprint),
      checkedAt: credential?.checkedAt ?? env?.checkedAt ?? null,
      error: env?.error ?? null,
    };
  }

  function statsView(usage) {
    const summary = summarizeUsage(usage, { now: now() });
    const unauthenticated = topUnauthenticated(summary);
    const { authed, missing, bad, denied } = summary.totals;
    return { windowHours: USAGE_WINDOW_HOURS, since: summary.since, authed, missing, bad, denied, ...unauthenticated };
  }

  // GET /api/egress 的 proxyAuth。proxy：{ running, pid }，来自本机 /proxy-health。
  // enforceRisks：现在切到「强制」要先确认的事（已经是强制时为空）——界面据此在切换前列给人看，
  // 与 setMode 里拦下来的是同一份判断。
  // clusterAlert（v2.64）：已经是「强制」之后仍在断网的事——集群上那份受管配置带的不是当前口令。界面以警告
  // 显示，补写走同一个「把口令写到集群」。与 enforceRisks 分开：那份是切换前的确认清单，语义不变。
  async function getView({ proxy = null } = {}) {
    const state = store.getPublicState();
    const usage = readUsage(usagePath);
    const stats = statsView(usage);
    const cluster = await clusterView();
    return {
      ...state,
      proxy: describeProxyAuthState({ configuredMode: state.mode, usage, proxy, changedAt: state.updatedAt, now: now() }),
      cluster,
      stats,
      enforceRisks: state.mode === "enforce" ? [] : risksOf(stats, cluster),
      clusterAlert: state.mode === "enforce" ? clusterAlertOf(cluster) : null,
    };
  }

  // 已是「强制」时集群口令不同步：没带（none）、还是上一个（previous，过渡期一过就断）、认不得的（other）。
  // 只报查到了的结论：还没查到（unknown）、核对不了（unverified）不报；集群上没有受管配置（absent）是接入没做完，
  // 不是口令的事（事实行另有说明，「写到集群」也会说先完成接入引导）。形状与 enforceRisks 里的那一条相同。
  function clusterAlertOf(cluster) {
    if (!cluster || cluster.env === "absent" || !["none", "previous", "other"].includes(cluster.credential)) return null;
    return { code: "cluster-not-synced", serverName: cluster.serverName, credential: cluster.credential };
  }

  // 切到「强制」之前要人再看一眼的事。空数组 = 没有已知的风险。
  async function enforceRisks() {
    return risksOf(statsView(readUsage(usagePath)), await clusterView());
  }

  function risksOf(stats, cluster) {
    const risks = [];
    if (stats.missing + stats.bad > 0) {
      risks.push({ code: "unauthenticated", requests: stats.missing + stats.bad, targets: stats.targets, moreTargets: stats.moreTargets });
    }
    if (stats.since === null) risks.push({ code: "no-observation" });
    if (cluster && cluster.credential !== "current") risks.push({ code: "cluster-not-synced", serverName: cluster.serverName, credential: cluster.credential });
    return risks;
  }

  // { mode, confirm? }。切到「强制」而有风险时先回 409（code: "confirm-required"，带上风险清单），
  // 界面把清单给人看、确认后带 confirm: true 再发一次。
  async function setMode({ mode, confirm = false } = {}) {
    if (!PROXY_AUTH_MODES.includes(mode)) throw statusError("口令模式只能是 off / observe / enforce", 400, { code: "bad-mode" });
    if (mode === "enforce" && confirm !== true && store.getPublicState().mode !== "enforce") {
      const risks = await enforceRisks();
      if (risks.length) throw statusError("切到「强制」前请先确认", 409, { code: "confirm-required", risks });
    }
    const result = store.setMode(mode);
    log(`proxy auth mode set to ${mode}${result.created ? " (token generated)" : ""}${result.reset ? " (previous file was unreadable; token regenerated)" : ""}`);
    return { created: result.created, reset: result.reset };
  }

  function rotate({ force = false } = {}) {
    const doc = store.rotate({ force: force === true });
    log(`proxy auth token rotated; previous token accepted until ${new Date(doc.previousUntil).toISOString()}`);
    return { previousUntil: doc.previousUntil };
  }

  function retirePrevious() {
    store.retirePrevious();
    log("proxy auth: previous token retired");
    return {};
  }

  const SYNC_REFUSALS = {
    ineligible: ["没有可以写入的团队服务器（集群侧受管配置只对团队服务器生效）", 409],
    "no-port": ["这台服务器还没有反向端口，先领取端口", 409],
    "no-token": ["还没有口令：先把口令模式打开（「只记录」不拦任何请求）", 409],
    absent: ["集群上还没有工作台的受管配置（~/.config/cluster-workbench/env.sh），先完成接入引导的「写集群侧配置」一步", 409],
  };

  // 「把口令写到集群」。confirm 不为 true 时只预览（两次只读 SSH），回报会改哪几个文件；true 才写。
  async function sync({ confirm = false } = {}) {
    if (fixtureMode) throw statusError("fixture 模式不发起真实 SSH", 409, { code: "fixture" });
    const clusterEnvSync = getClusterEnvSync();
    if (!clusterEnvSync) throw statusError("集群配置同步在当前模式下不可用", 503, { code: "unavailable" });
    const server = await clusterTarget();
    if (!server) throw statusError(SYNC_REFUSALS.ineligible[0], 409, { code: "ineligible" });
    const result = await clusterEnvSync.syncCredential(server.id, { preview: confirm !== true });
    if (SYNC_REFUSALS[result.status]) throw statusError(SYNC_REFUSALS[result.status][0], SYNC_REFUSALS[result.status][1], { code: result.status });
    if (result.status === "failed") throw statusError(`没有写成：${result.error || "SSH 执行失败"}`, 502, { code: "failed" });
    return { serverId: server.id, serverName: server.name || server.id, status: result.status, plan: result.plan ?? null, changed: result.changed ?? [], warning: result.warning ?? null };
  }

  // 这个进程见过的使用记录相邻两版（近一分钟的增量用）。只在内存里，重启后从头看。
  let usageVersions = { previous: null, current: null };
  let usageMtime = null;

  // 控制面每 30 秒调一次（server/start.mjs）：文件修改时刻变了才读，推进相邻两版。只在有人拉 /api/egress/usage
  // 时才看的话，概览藏了很久之后的第一次拉取会拿一个钟头前的版本相减，把一个钟头的量算成一分钟。
  function sampleUsage() {
    let mtime;
    try {
      mtime = statUsage(usagePath).mtimeMs;
    } catch {
      return;
    }
    if (mtime === usageMtime) return;
    usageMtime = mtime;
    usageVersions = trackUsageVersion(usageVersions, readUsage(usagePath));
  }

  // GET /api/egress/usage：近 24 小时流量最多的目标。
  //   recording（v2.65）：用量是否在记（口令模式不是「关」）。
  //   recent（v2.65）：相邻两版之间的增量 { fromAt, toAt, connections, up, down }；只见过一版、或文件超过 150 秒没重写
  //   （空闲）时为 null。targets[] 与 other 每行带同一份增量的 recentConnections / recentUp / recentDown。
  //   allTargets / allOther（v2.66）：当具名目标超过 12 个（other.targets > 0）时附带未截断的全量具名目标，
  //   避免概览「请求之路」去向卡片把排在第 13 名之后的 OpenAI / Claude 等高频小包域名吞进「其它」。
  function getUsage() {
    const usage = readUsage(usagePath);
    usageVersions = trackUsageVersion(usageVersions, usage);
    const delta = usage ? recentUsage(usageVersions, { now: now() }) : null;
    const summary = summarizeUsage(usage, { now: now() });
    const { connections, up, down } = summary.totals;
    const top = topByTraffic(summary);
    const full = top.other?.targets > 0 ? withRecentTraffic(topByTraffic(summary, Infinity), delta) : null;
    return {
      windowHours: USAGE_WINDOW_HOURS,
      since: summary.since,
      updatedAt: usage?.writtenAt || null,
      // v2.88 起代理一直记用量（与口令模式无关）。
      recording: true,
      totals: { connections, up, down },
      recent: delta ? { fromAt: delta.fromAt, toAt: delta.toAt, connections: delta.connections, up: delta.up, down: delta.down } : null,
      ...withRecentTraffic(top, delta),
      ...(full ? { allTargets: full.targets, allOther: full.other } : {}),
    };
  }

  // 本机经代理发请求时带的头（口令模式是关、或没有口令时为空串——照旧不带）。
  function localAuthorization() {
    const credential = store.getCredential();
    return credential ? `Basic ${Buffer.from(`${credential.user}:${credential.password}`, "utf8").toString("base64")}` : "";
  }

  // 发到集群的 curl 从标准输入读的那一行配置（见 remote-proxy-auth.mjs）；不该带口令时为 null。
  const curlInput = () => curlProxyAuthInput(store.getCredential());

  return { getView, setMode, rotate, retirePrevious, sync, getUsage, sampleUsage, localAuthorization, curlInput, getCredential: store.getCredential };
}
