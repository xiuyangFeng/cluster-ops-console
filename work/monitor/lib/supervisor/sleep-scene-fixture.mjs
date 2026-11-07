// 测试夹具（只给 *.test.mjs 用）：2026-10-11 那次「电池供电下合盖 2 小时 42 分、约每 17 分钟短暂唤醒一次」。
// 19:03:39 合盖，21:45:50 开盖；当天的简报把它写成了三条标红的断线。
//
// 同一件事的两份记法：
//   - RECORDED_ROWS：断线账本当时记下的原始行（旧格式，没有 sleep / wake）。主机名与 IP 换成了示例值，
//     其余照录——时刻到秒，uptimeMs / downMs 到毫秒，原因、尝试次数、networkChange 都是实际值。
//   - replaySleepScene()：按同一条时间线用假时钟驱动两个真实的隧道控制器，得到「现在的 supervisor 会
//     怎么记」：同样的 up / down，外加 down 行的 sleep 标记与每次醒来的 wake 行。
// tunnel-sleep.test.mjs 断言后者去掉新增的字段与行之后，与前者逐行逐字段一致——既说明这段回放忠实于
// 记录，也说明休眠归因没有动任何既有字段。读侧（统计 / 简报 / 界面）的测试用回放出来的账本。
//
// 回放里凡是账本上查得到的数都对得上；账本上没有的（每次短暂唤醒里跑了几拍、回收残留会话花了多久）
// 是按记录倒推出来的：例如「20:11:19 up downMs=2642」说明 19:55:33 断开后 2.642 秒就起了新的 ssh，
// 只是下一次醒来（20:11:19）才满 20 秒、才被记成建立。
import { EventEmitter } from "node:events";

import { createRateLimiter } from "../auto-repair-policy.mjs";
import { createTunnelController } from "./tunnel-controller.mjs";
import { sanitizeLedgerEvent } from "./tunnel-ledger.mjs";

// 2026-10-11 北京时间 "HH:MM:SS" 或 "HH:MM:SS.mmm" → 毫秒时间戳（显式 UTC+8，与机器时区无关）。
export function sceneTime(clock) {
  const match = /^(\d\d):(\d\d):(\d\d)(?:\.(\d{3}))?$/.exec(clock);
  if (!match) throw new Error(`bad scene clock: ${clock}`);
  return Date.UTC(2026, 9, 11, Number(match[1]) - 8, Number(match[2]), Number(match[3]), Number(match[4] || 0));
}

export const SCENE_DAY = "2026-10-11";
export const LID_CLOSED_AT = sceneTime("19:03:39");
export const LID_OPENED_AT = sceneTime("21:45:50");

const MAIN = Object.freeze({ id: "server-01", name: "主集群服务器 (example-cluster)", host: "example-cluster", ip: "192.0.2.10", remotePort: 7891, source: "team" });
const CLOUD = Object.freeze({ id: "server-02", name: "云主机服务器 (example-cloud)", host: "example-cloud", ip: "192.0.2.20", remotePort: 7894, source: "personal" });
export const SCENE_SERVERS = Object.freeze({ main: MAIN, cloud: CLOUD });

// 监控侧服务（隧道稳定性 / 简报）要的合并配置。
export function sceneConfig() {
  return { servers: [MAIN, CLOUD].map(({ id, name, host }) => ({ id, name, host })) };
}

const closedBy = (server) => `Connection closed by ${server.ip} port 22`;
const closedByRemote = (server) => `Connection to ${server.ip} closed by remote host.`;

const alive = { type: "alive" };
const up = (server, fields) => ({ type: "up", serverId: server.id, host: server.host, via: "spawned", ...fields });
const down = (server, cause, fields) => ({ type: "down", serverId: server.id, host: server.host, cause, planned: false, ...fields });

// 账本这一段的原始记录。process-lost 是接管来的 ssh 进程不见了（没有退出码与 stderr）；
// 其余几次是子进程自己退出，detail 是 ssh 的最后一行 stderr。
export const RECORDED_ROWS = Object.freeze([
  ["19:00:10", alive],
  ["19:21:20", alive],
  ["19:38:12", alive],
  ["19:55:27", alive],
  ["19:55:33", down(MAIN, "process-lost", { uptimeMs: 6630046, networkChange: true })],
  ["20:11:19", up(MAIN, { downMs: 2642, attempts: 1 })],
  ["20:11:19", alive],
  ["20:29:09", down(CLOUD, "process-lost", { uptimeMs: 8646583, networkChange: false })],
  ["20:29:13", alive],
  ["20:46:03", up(CLOUD, { downMs: 3825, attempts: 1 })],
  ["20:46:03", alive],
  ["20:46:04", down(CLOUD, "closed", { detail: closedBy(CLOUD), uptimeMs: 1011219, code: 255, networkChange: true })],
  ["20:46:09", down(MAIN, "remote-closed", { detail: closedByRemote(MAIN), uptimeMs: 3033413, code: 255, networkChange: true })],
  ["21:03:07", up(CLOUD, { downMs: 5585, attempts: 1 })],
  ["21:03:07", down(CLOUD, "closed", { detail: closedBy(CLOUD), uptimeMs: 1017464, code: 255, networkChange: true })],
  ["21:20:19", alive],
  ["21:36:30", up(MAIN, { downMs: 2050146, attempts: 1 })],
  ["21:36:31", down(MAIN, "closed", { detail: closedBy(MAIN), uptimeMs: 972434, code: 255, networkChange: true })],
  ["21:45:50", alive],
  ["21:46:19", up(MAIN, { downMs: 567463, attempts: 1 })],
  ["21:46:19", up(CLOUD, { downMs: 2570018, attempts: 2 })],
  ["21:47:33", down(CLOUD, "remote-closed", { detail: closedByRemote(CLOUD), uptimeMs: 95597, code: 255, networkChange: true })],
  ["21:48:51", up(CLOUD, { downMs: 57868, attempts: 1 })],
  ["21:50:51", alive],
].map(([clock, row]) => Object.freeze({ v: 1, ...row, at: sceneTime(clock) })));

// 这一段之前的上下文（摘录里没有，由摘录倒推）：18:05 supervisor 启动并原样接管两条已在跑的隧道——
// 两条隧道第一次断开时的 uptimeMs（6630046 / 8646583）都指回 18:05:02；此后每 5 分钟一条心跳。
const STARTED_AT = sceneTime("18:05:02.800");
const ADOPTED_AT = Object.freeze({ [CLOUD.id]: sceneTime("18:05:02.917"), [MAIN.id]: sceneTime("18:05:02.954") });
const CONTEXT_ALIVE = ["18:10:10", "18:15:10", "18:20:10", "18:25:10", "18:30:10", "18:35:10", "18:40:10", "18:45:10", "18:50:10", "18:55:10"];

const byTime = (rows) => rows.map((row, index) => ({ row, index })).sort((a, b) => (a.row.at - b.row.at) || (a.index - b.index)).map(({ row }) => row);

// 旧版 supervisor 记下的整段账本：上下文 + 原始记录。没有任何一行带 sleep，也没有 wake 行。
export function recordedLedger() {
  return byTime([
    { v: 1, type: "start", at: STARTED_AT },
    ...[CLOUD, MAIN].map((server) => ({ v: 1, type: "up", at: ADOPTED_AT[server.id], serverId: server.id, host: server.host, via: "adopted", attempts: 0 })),
    ...CONTEXT_ALIVE.map((clock) => ({ v: 1, type: "alive", at: sceneTime(clock) })),
    ...RECORDED_ROWS,
  ]);
}

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killed = true;
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  };
  return child;
}

// 用假时钟把这一晚重放一遍。返回：
//   rows  —— 按时间排好的账本行（与 supervisor 落盘的形状相同）；
//   trace —— 控制器对外做的每一件事（起 ssh、探测远端端口、回收残留会话、写日志）及其时刻，
//            用来核对「同一场景下重连行为没有变」。
// createController 可替换：把别的版本的隧道控制器放进同一场景里比对。
export async function replaySleepScene({ createController = createTunnelController } = {}) {
  let clock = 0;
  const rows = [];
  const trace = [];
  // 假时钟只在这两处被拨动：脚本显式拨到某个时刻，或某次远端操作「花掉」一段时间。
  const at = (text) => {
    clock = sceneTime(text);
  };
  const writeAlive = () => rows.push({ v: 1, type: "alive", at: clock });

  function makeTunnel(server, { adoptedPid, firstChildPid }) {
    const name = `tunnel.${server.id}`;
    const config = { id: server.id, serverId: server.id, host: server.host, remotePort: server.remotePort, localPort: 8888, source: server.source };
    const children = [];
    // alivePid：注册表里校验得过的隧道进程——先是上一任 supervisor 留下的，之后是自己起的子进程。
    // reclaim / probe：下一次「回收残留会话」「探测远端端口」这两种远端操作期间发生的事（拨动时钟、
    // 另一条隧道的 ssh 退出、电脑又睡过去）；proxyHealthy 为假时本控制器每拍只空转。
    const tunnel = { server, config, children, alivePid: adoptedPid, reclaim: null, probe: null, proxyHealthy: true };
    const takeHook = async (key) => {
      const hook = tunnel[key];
      tunnel[key] = null;
      if (hook) await hook();
    };
    tunnel.controller = createController({
      name,
      spawnImpl: (command, args) => {
        trace.push({ at: clock, server: server.id, what: "spawn", detail: `${command} ${args.join(" ")}` });
        const child = makeFakeChild(firstChildPid + children.length);
        children.push(child);
        tunnel.alivePid = child.pid;
        child.on("exit", () => {
          if (tunnel.alivePid === child.pid) tunnel.alivePid = null;
        });
        return child;
      },
      // 远端端口探测一律「没在监听」；lsof 查不到连接地址（换网时只清退避，不重建）。
      execFileImpl: async (command, args) => {
        trace.push({ at: clock, server: server.id, what: "exec", detail: `${command} ${args.join(" ")}` });
        if (command === "ssh") await takeHook("probe");
        return { code: 1, stdout: "", stderr: "", timedOut: false };
      },
      listSshProcesses: async () => [],
      runRemoteCommandImpl: async (_config, command) => {
        trace.push({ at: clock, server: server.id, what: "reclaim", detail: command });
        await takeHook("reclaim");
        return { code: 0, stdout: "found=0 reclaimed=0\n", stderr: "", timedOut: false };
      },
      registry: {
        verifyProcess: async () => (tunnel.alivePid
          ? { verified: true, meta: { pid: tunnel.alivePid, name, rootDir: "/repo" } }
          : { verified: false, reason: "process gone" }),
      },
      isLocalProxyHealthy: async () => tunnel.proxyHealthy,
      rateLimiter: createRateLimiter({ now: () => clock }),
      now: () => clock,
      waitForPidExitImpl: async () => true,
      killProcess: (pid, signal) => trace.push({ at: clock, server: server.id, what: "kill", detail: `${pid} ${signal}` }),
      log: (message, fields) => trace.push({ at: clock, server: server.id, what: "log", detail: `${fields?.event || "-"} ${message}` }),
      rootDir: "/repo",
      platform: "darwin",
      tunnelOwnerId: "0123456789abcdef",
      onSessionEvent: (event) => rows.push(sanitizeLedgerEvent(event)),
      sleep: async () => {},
    });
    tunnel.ensure = () => tunnel.controller.ensure(config);
    // 当前这条 ssh 以给定的最后一行 stderr 退出（退出码 255）。
    tunnel.exit = async (stderr) => {
      const child = children.at(-1);
      child.stderr.emit("data", stderr);
      child.emit("exit", 255, null);
      await tunnel.controller.whenOrphanSettled();
    };
    // 回收残留会话花掉这么多毫秒（之后才起新的 ssh）。
    tunnel.reclaimTakes = (ms) => {
      tunnel.reclaim = () => {
        clock += ms;
      };
    };
    return tunnel;
  }

  const main = makeTunnel(MAIN, { adoptedPid: 501, firstChildPid: 7100 });
  const cloud = makeTunnel(CLOUD, { adoptedPid: 502, firstChildPid: 7200 });
  const tick = async (...tunnels) => {
    for (const tunnel of tunnels) await tunnel.ensure();
  };
  // 醒着的一段：两条隧道 5 秒一拍，从 from 到 to（含）。
  const awake = async (from, to) => {
    for (let t = sceneTime(from); t <= sceneTime(to); t += 5000) {
      clock = t;
      await tick(main, cloud);
    }
  };
  // 醒来时网卡重新关联：主循环先通知每条隧道（之后 120 秒内的断线带 networkChange）。
  const networkChanged = async () => {
    for (const tunnel of [main, cloud]) await tunnel.controller.handleNetworkChange({ removed: ["192.0.2.101"], added: [] });
  };

  // ── 18:05 supervisor 启动，原样接管两条已在跑的隧道；之后一个小时正常运行 ──
  rows.push({ v: 1, type: "start", at: STARTED_AT });
  clock = ADOPTED_AT[CLOUD.id];
  await cloud.ensure();
  clock = ADOPTED_AT[MAIN.id];
  await main.ensure();
  for (const text of CONTEXT_ALIVE) rows.push({ v: 1, type: "alive", at: sceneTime(text) });
  rows.push({ v: 1, type: "alive", at: sceneTime("19:00:10") });
  await awake("18:05:07.954", "19:03:34.000");

  // ── 19:03:39 合盖：睡前最后一拍 ──
  at("19:03:39.000");
  await tick(main, cloud);

  // ── 合盖期间：约每 17 分钟短暂唤醒一次，supervisor 每次只跑得到一两拍 ──
  at("19:21:20.000");
  await tick(main, cloud);
  writeAlive();

  at("19:38:12.000");
  await tick(main, cloud);
  writeAlive();

  // 19:55 这次醒来网卡重新关联；第二拍发现主集群那条（接管来的）ssh 进程没了，回收残留会话后起了新的。
  at("19:55:27.000");
  await networkChanged();
  await tick(main, cloud);
  writeAlive();
  main.alivePid = null;
  main.reclaimTakes(2642);
  at("19:55:33.000");
  await tick(cloud, main);

  // 20:11 醒来：19:55 起的那条 ssh 进程还在，挂钟上早满 20 秒 → 记成「建立」（其实握手没做完就睡过去了）。
  at("20:11:19.000");
  await tick(main, cloud);
  writeAlive();

  // 20:29 醒来：云主机那条（接管来的）ssh 进程没了。这次醒来没有换网。
  cloud.alivePid = null;
  cloud.reclaimTakes(3825);
  at("20:29:09.500");
  await tick(main, cloud);
  writeAlive();

  // 20:46 醒来：云主机 20:29 起的那条被记成建立，一秒多后它自己退出（握手阶段被对端关掉）；
  // 第二拍给云主机重起，期间主集群 19:55 起的那条也退出了（服务器端早已关掉连接）。
  at("20:46:03.000");
  await networkChanged();
  await tick(main, cloud);
  writeAlive();
  at("20:46:04.544");
  await cloud.exit(closedBy(CLOUD));
  cloud.reclaim = async () => {
    at("20:46:09.055");
    await main.exit(closedByRemote(MAIN));
    at("20:46:10.129");
  };
  at("20:46:08.500");
  await tick(main, cloud);

  // 21:03 醒来只有两秒：云主机「建立」随即又断；主集群那一拍卡在远端端口探测上就睡过去了，
  // 21:20 醒来才接着跑完（回收、起新的 ssh），所以 21:03 没有心跳、21:20 才有。
  at("21:03:07.000");
  await networkChanged();
  await cloud.ensure();
  main.probe = async () => {
    at("21:03:07.593");
    await cloud.exit(closedBy(CLOUD));
    at("21:20:19.000");
  };
  main.reclaimTakes(201);
  await main.ensure();
  writeAlive();

  // 21:36 醒来：主集群 21:20 起的那条被记成建立、一秒多后退出；云主机这一拍同样卡在探测上，
  // 21:45:50 开盖才接着跑完，起的 ssh 赶上网络还没通、一秒后失败（没建立过，不记账）。
  at("21:36:30.000");
  await networkChanged();
  await main.ensure();
  cloud.probe = async () => {
    at("21:36:31.635");
    await main.exit(closedBy(MAIN));
    at("21:45:50.000");
  };
  cloud.reclaimTakes(300);
  await cloud.ensure();
  writeAlive();
  at("21:45:51.300");
  await cloud.exit(`ssh: connect to host ${CLOUD.ip} port 22: Network is unreachable`);

  // ── 21:45:50 开盖。下一拍两条隧道各自发现挂钟跳变并重建，约 20 秒后都建立 ──
  at("21:45:57.611");
  await networkChanged();
  await cloud.ensure();
  main.reclaimTakes(1487);
  await main.ensure();
  for (const text of ["21:46:03.000", "21:46:08.400", "21:46:13.800"]) {
    at(text);
    await tick(main, cloud);
  }
  at("21:46:19.200");
  await tick(main, cloud);
  await awake("21:46:24.200", "21:47:29.200");

  // 21:47:33 云主机这条又被服务器端关掉（开盖后 1 分 43 秒，距控制器发现跳变 95.6 秒）。
  at("21:47:33.208");
  await cloud.exit(closedByRemote(CLOUD));
  // 记录里它在断开 57.9 秒后才重建（只起了一次），账本没有记原因；这里用「本机代理暂不健康」让控制器
  // 在这段时间每拍空转，不代表真实原因。
  cloud.proxyHealthy = false;
  await awake("21:47:34.200", "21:48:29.200");
  cloud.proxyHealthy = true;
  cloud.reclaimTakes(1000);
  at("21:48:30.076");
  await tick(main, cloud);
  for (const text of ["21:48:36.000", "21:48:41.100", "21:48:46.200"]) {
    at(text);
    await tick(main, cloud);
  }
  at("21:48:51.300");
  await tick(main, cloud);
  await awake("21:48:56.300", "21:50:46.300");
  at("21:50:51.300");
  await tick(main, cloud);
  writeAlive();

  return { rows: byTime(rows), trace };
}
