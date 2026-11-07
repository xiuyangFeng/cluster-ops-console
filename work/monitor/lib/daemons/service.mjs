// 远端守护进程服务（v2.55）：查看当前活跃服务器上 Paseo / T3 Code 两个守护进程的状态，并在用户确认后启动。
//
// 这是 v2.31.0「控制台不做远端动作」之后唯一的例外，只放开这两条固定的启动命令（lib/daemons/commands.mjs），
// 沿用旧远端动作的安全形状：固定注册表、前端确认、带 token 的 POST、同一时刻只允许一个启动、
// 没有 sudo、没有 stop / kill / restart——端口已在监听时启动是严格的空操作（alreadyRunning）。
//
// 范围：只对活跃服务器（selectMainServer）且是团队配置里的服务器（source !== "personal"、未禁用、未关监控），
// 与目录占用同一口径。SSH 走调度器的全局槽位（acquireSshSlot）。
// 永不因 SSH 失败而 reject：拿不到结果时如实返回 unknown + 原因；只有参数 / 范围不对才抛带 status 的错误。
//
// 服务直达（v2.62）：同一次状态查询顺带列出本人在这台服务器上监听的服务（services.mjs 解析），
// 并可把其中一个临时转发到本机（forwards.mjs 起独立的 ssh -L，本文件只做把关）：
//   - 转发请求只有「服务器 + 端口」；端口必须在最近一次服务列表里（列表超过 90 秒先重查一次），
//     转发的远端目标由列表里的监听地址归类决定（两个回环常量之一），请求里没有主机这一项。
//   - 密码连接的服务器（条目带 authRef）不支持；只对查看中的团队集群开放，与本面板一致。
//   - 一轮列全了的服务列表里已经没有某个端口 → 收回它的转发；这一轮没列出来（SSH 失败、没有 ss、
//     超出条数被截断）不算「没有了」，不收回。
//
// fixture 模式（冒烟 / 自检 / 界面预览用的隔离实例）：状态、启动、服务列表、转发全部走 fixture.mjs 的假数据，
// 绝不发 SSH、绝不起进程。这块面板一可见就会读状态，而 fixture 监控读的可能就是团队配置——不拦就会连到真实集群。

import { isPort } from "../validators.mjs";
import { buildDaemonInvocation, DAEMON_STATUS_TIMEOUT_MS, DAEMONS, daemonDef, daemonView, isDaemonId, parseDaemonOutput } from "./commands.mjs";
import { createDaemonsFixture } from "./fixture.mjs";
import { buildServices, MIN_SERVICE_PORT, parseServiceOutput, serviceView } from "./services.mjs";

// 本账号在这台服务器上的反向端口（合并后配置，含 portOverrides）；没领 / 不合法 → null（v2.56 起不回落 7891）。
export function relayPortOf(server) {
  return isPort(server?.remotePort) ? Number(server.remotePort) : null;
}

// 同一台服务器的状态结果在这段时间内直接复用（多个窗口 / 快速切页不重复发 SSH）。
export const DAEMONS_STATUS_TTL_MS = 10000;
// 开转发时认的「最近一次服务列表」最多这么旧（面板每 60 秒读一次）；更旧就先重查一次再判断。
export const FORWARD_LISTING_MAX_AGE_MS = 90000;

export function isDaemonsEligible(server) {
  return Boolean(server) && server.disabled !== true && server.monitorEnabled !== false && server.source !== "personal";
}

const fail = (message, status) => Object.assign(new Error(message), { status });

const RESULT_OF = Object.freeze({ already: "alreadyRunning", started: "started", missing: "missing", failed: "failed" });
// 面板里已经单列的守护进程端口：不在「我的服务」里再列一遍。
const DAEMON_PORTS = Object.freeze(DAEMONS.map((def) => def.port));
const NO_LISTING = Object.freeze({ state: "unknown", complete: false, services: [], more: 0, ports: new Set() });

export function createDaemonsService({
  getConfig, getMainServerConfig, sshArgsFor, execCollector, probeSshFailureReason,
  // 服务直达的转发管理器（lib/daemons/forwards.mjs）；装配处没给时只列服务、不提供转发。
  forwards: givenForwards = null,
  // fixture 模式：远端这一侧与转发全部换成 fixture.mjs 的假数据。装配处就算给了真的转发管理器也不用。
  fixtureMode = false,
  log = null, timeline = null, now = Date.now,
}) {
  const fixture = fixtureMode ? createDaemonsFixture({ now, log: log || (() => {}) }) : null;
  const forwards = fixture ? fixture.forwards : givenForwards;
  let starting = null; // { daemon, serverId }：同一时刻只允许一个启动
  let cache = null; // { serverId, at, view }
  let inFlight = null; // { serverId, promise }：同一台服务器并发的状态查询合并成一次 SSH
  // 每次启动结束 +1：启动之前发出的状态查询晚到时不得覆盖启动后的结果。
  let generation = 0;
  // 最近一次完整跑完的状态查询带回来的服务列表：{ serverId, at, state, byPort: Map<端口, 服务> }。开转发只认它。
  let listing = null;

  async function resolveTarget(serverId) {
    const config = await getConfig();
    const server = getMainServerConfig(config) || null;
    if (serverId != null && serverId !== server?.id) throw fail("只能查看 / 操作当前查看中的服务器，请刷新页面", 409);
    return { config, server };
  }

  // 发一次 SSH（脚本经 stdin）。永不抛错：组装参数失败、exec 抛错都折成 { code: null, stderr }。
  // fixture 模式在这里就返回：不组装 SSH 参数、不占调度槽位、不调用执行器。
  async function runRemote(server, config, action, acquireSshSlot) {
    if (fixture) return fixture.remote(action);
    let invocation;
    try {
      invocation = buildDaemonInvocation(sshArgsFor(server, config), action, { relayProxyPort: relayPortOf(server) });
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error) };
    }
    const release = await acquireSshSlot({ hostKey: server.host });
    try {
      return (await execCollector(invocation, server)) || { code: null, stdout: "", stderr: "" };
    } catch (error) {
      return { code: null, stdout: "", stderr: String(error?.message || error) };
    } finally {
      release();
    }
  }

  function failureReason(res, timeoutMs) {
    if (res?.timedOut) return `SSH 未在 ${Math.round(timeoutMs / 1000)} 秒内返回`;
    return probeSshFailureReason(res?.code ?? null, res?.stderr || "", res?.stdout || "");
  }

  // 这台服务器为什么不能转发：null = 可以；password = 密码连接；unavailable = 这个进程没有转发管理器。
  function forwardBlockOf(server) {
    if (server?.authRef) return "password";
    return forwards ? null : "unavailable";
  }

  // 脚本完整跑完时才认它带回来的服务列表。
  const readServices = (parsed, stdout) => (parsed?.complete ? buildServices(parseServiceOutput(stdout), { excludePorts: DAEMON_PORTS }) : NO_LISTING);

  // 记下这份列表（开转发只认它），并收回「端口已经不在了」的转发。sentAt = 这次查询发出的时刻：
  // 列表的新旧从发出那一刻算起（它反映的不会比这更新）；一份列表也只能判断发出之前就开着的转发。
  function absorbListing(server, services, sentAt) {
    listing = { serverId: server.id, at: sentAt, state: services.state, byPort: new Map(services.services.map((service) => [service.port, service])) };
    if (services.complete) forwards?.reconcile(server.id, services.ports, sentAt);
  }

  function buildView(server, parsed, error, services = NO_LISTING) {
    return {
      eligible: true,
      serverId: server.id,
      serverName: server.name || server.id,
      checkedAt: now(),
      reachable: Boolean(parsed?.complete),
      error: parsed?.complete ? null : error,
      daemons: DAEMONS.map((def) => daemonView(def, parsed, { expectedRelayPort: relayPortOf(server) })),
      services: services.services.map(serviceView),
      servicesState: services.state,
      servicesMore: services.more,
      forwardBlocked: forwardBlockOf(server),
    };
  }

  // 随时在变的部分不进缓存，每次返回前现取：正在启动的守护进程、这台服务器上开着的转发。
  const decorate = (view) => ({
    ...view,
    starting: starting && starting.serverId === view.serverId ? starting.daemon : null,
    forwards: forwards ? forwards.list(view.serverId) : [],
    forwardLimit: forwards ? forwards.limit : 0,
  });

  async function queryStatus(server, config, acquireSshSlot) {
    const gen = generation;
    const sentAt = now();
    const res = await runRemote(server, config, null, acquireSshSlot);
    const parsed = parseDaemonOutput(res?.stdout);
    const services = readServices(parsed, res?.stdout);
    const view = buildView(server, parsed, parsed.complete ? null : failureReason(res, DAEMON_STATUS_TIMEOUT_MS), services);
    if (!parsed.complete) log?.(`daemons status on ${server.id}: unavailable (${view.error})`, { level: "warn", event: "daemons" });
    if (gen === generation) {
      cache = { serverId: server.id, at: now(), view };
      if (parsed.complete) absorbListing(server, services, sentAt);
    }
    return view;
  }

  // 状态：fresh = true 时跳过短缓存（界面上的「刷新」）。
  async function status(serverId = null, { acquireSshSlot, fresh = false } = {}) {
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isDaemonsEligible(server)) return { eligible: false, serverId: server?.id ?? null, daemons: [], starting: null };
    if (!fresh && cache && cache.serverId === server.id && now() - cache.at < DAEMONS_STATUS_TTL_MS) return decorate(cache.view);
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    if (!inFlight || inFlight.serverId !== server.id) {
      const promise = queryStatus(server, config, acquireSshSlot).finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
      inFlight = { serverId: server.id, promise };
    }
    return decorate(await inFlight.promise);
  }

  // 启动白名单里的一个守护进程。返回 { daemon, result, ok, detail, error, status }：
  //   result: started | alreadyRunning | missing | failed | unknown（SSH 没拿到完整结果，是否已启动不确定）
  async function start(daemon, { serverId = null } = {}, { acquireSshSlot } = {}) {
    if (!isDaemonId(daemon)) throw fail("未知的守护进程", 400);
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    const def = daemonDef(daemon);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isDaemonsEligible(server)) throw fail("当前查看的服务器不提供远端守护进程", 404);
    // Paseo 的中继必须走本账号自己的隧道；没领端口时宁可不启动，也不能让它连到别人的端口。
    if (def.id === "paseo" && relayPortOf(server) == null) throw fail("还没领取反向端口，Paseo 的中继无法走你自己的隧道：先运行 npm run setup 领取端口", 409);
    if (starting) throw fail(`正在启动 ${daemonDef(starting.daemon).label}，请稍候`, 409);
    starting = { daemon, serverId: server.id };
    try {
      log?.(`daemons start ${daemon} on ${server.id}: requested`, { level: "info", event: "daemons" });
      const sentAt = now();
      const res = await runRemote(server, config, daemon, acquireSshSlot);
      const parsed = parseDaemonOutput(res?.stdout);
      const remote = parsed.complete ? RESULT_OF[parsed.values.result] : null;
      const result = remote || "unknown";
      const error = remote ? null : (parsed.complete ? "远端没有给出启动结果" : failureReason(res, def.startTimeoutMs));
      const detail = result === "failed" ? parsed.values.detail || "" : "";
      let view = null;
      generation += 1;
      if (parsed.complete) {
        const services = readServices(parsed, res?.stdout);
        view = buildView(server, parsed, null, services);
        cache = { serverId: server.id, at: now(), view };
        absorbListing(server, services, sentAt);
      } else {
        cache = null; // 结果不确定：下一次查询必须重新问远端
      }
      const ok = result === "started" || result === "alreadyRunning";
      const summary = `daemons start ${daemon} on ${server.id}: ${result}${error ? ` (${error})` : ""}${detail ? ` — ${detail}` : ""}`;
      log?.(summary, { level: ok ? "info" : "warn", event: "daemons" });
      timeline?.(ok ? "info" : "warn", summary, { event: "daemon-start", serverId: server.id, daemon, result });
      starting = null; // 先解除互斥再拼返回值：返回的状态里不再标「正在启动」
      return { daemon, result, ok, detail, error, status: view ? decorate(view) : null };
    } finally {
      starting = null;
    }
  }

  const listingFor = (server) => (listing && listing.serverId === server.id && now() - listing.at <= FORWARD_LISTING_MAX_AGE_MS ? listing : null);

  // 把服务列表里的一个端口转发到本机。返回 { forward: { serverId, port, localPort, url, startedAt, expiresAt }, status }。
  async function forward({ serverId = null, port } = {}, { acquireSshSlot } = {}) {
    if (!forwards) throw fail("这个运行环境不提供服务转发", 503);
    if (!isPort(port) || port < MIN_SERVICE_PORT) throw fail("端口不合法", 400);
    if (typeof acquireSshSlot !== "function") throw fail("SSH 调度不可用", 503);
    const { config, server } = await resolveTarget(serverId);
    if (!server || !isDaemonsEligible(server)) throw fail("当前查看的服务器不提供服务转发", 404);
    if (server.authRef) throw fail("这台服务器用密码连接，转发需要能长时间保持的免密 SSH；改用密钥登录后再试（npm run setup）", 409);
    // 最近一次列表太旧（或还没有）：先重查一次。重查没成功就不转发——不凭过期的列表去连一个可能已经换了主人的端口。
    if (!listingFor(server)) await status(server.id, { acquireSshSlot, fresh: true });
    const current = listingFor(server);
    const name = server.name || server.id;
    if (!current || (current.state !== "ok" && current.state !== "trunc")) throw fail(`这一轮没拿到 ${name} 上的服务列表，暂时不能转发；稍后点「刷新」再试`, 409);
    const service = current.byPort.get(port);
    if (!service) throw fail(`端口 ${port} 不在最近一次的服务列表里（服务可能已经退出），请点「刷新」`, 409);
    if (!service.target) throw fail(`端口 ${port} 的服务只绑定在 ${service.binds.join("、")}，经集群本机的回环地址连不上，不能转发`, 409);
    // fixture 模式下没有真实的建连，不占 SSH 调度槽位。
    const opened = await forwards.open({ server, config, remotePort: port, remoteHost: service.target, acquireSshSlot: fixture ? null : acquireSshSlot });
    return { forward: opened, status: cache && cache.serverId === server.id ? decorate(cache.view) : null };
  }

  // 关掉一条转发（只结束我们自己起的那条 ssh）。没有这条转发时 closed 为 false，不算错误。
  async function closeForward({ serverId = null, port } = {}) {
    if (!forwards) throw fail("这个运行环境不提供服务转发", 503);
    if (typeof serverId !== "string" || !serverId || !isPort(port)) throw fail("参数不合法", 400);
    const closed = forwards.close(serverId, port, "manual");
    return { closed, serverId, port, status: cache && cache.serverId === serverId ? decorate(cache.view) : null };
  }

  // 配置热载之后：模块被关掉、服务器被删 / 停用 / 改成密码连接、连接参数变了——收回它名下的转发。
  function onConfigRefreshed(config) {
    if (!forwards) return 0;
    const servers = Array.isArray(config?.servers) ? config.servers : [];
    const moduleOn = config?.modules?.daemons !== false;
    return forwards.closeIf((entry) => {
      const server = servers.find((item) => item?.id === entry.serverId) || null;
      return !moduleOn || !isDaemonsEligible(server) || Boolean(server.authRef) || forwards.baseKeyFor(server, config) !== entry.baseKey;
    }, "config");
  }

  return { status, start, forward, closeForward, onConfigRefreshed };
}
