// supervisor 的配置读取与解析：分层配置（团队 config.json + 个人 config.local.json）→
// "活跃服务器条目 + 多隧道三件套"，以及每拍的 loadConfig（读坏时保留上一份有效配置）。
import { normalizeAgentConfig } from "../../monitor-core.mjs";
import { normalizeAutoRepairConfig } from "../auto-repair-policy.mjs";
import { loadLayeredConfig, resolveProxyPort, resolveTunnelTargets } from "../config-loader.mjs";
import { resolveHostKeyPath } from "../host-key-policy.mjs";
import { attachPersonalSsh } from "../ssh-args.mjs";
import { createStampedCache, knownHostsRevision as knownHostsRevisionFor } from "../stat-cache.mjs";
import { buildTunnelSignature } from "./tunnel-spec.mjs";

const DEFAULT_CONTROL_PLANE_PORT = 8877;

function resolveControlPlanePort(env = process.env) {
  const raw = env?.PORT;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_CONTROL_PLANE_PORT;
  const port = Number(raw);
  // PORT=0 asks node:http to choose an ephemeral port; the actual bound port is
  // not knowable in the detached supervisor, so do not falsely reject a proxy
  // configured on 8877 in smoke/fixture launches.
  if (port === 0) return null;
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_CONTROL_PLANE_PORT;
}

// 分层配置按文件戳缓存：每 5s 一拍同步重读两份 JSON（团队 + 个人）换成两次 stat。
// 戳变化（含 tmp+rename 原子写换 inode）即重读；createStampedCache 的 maxAgeMs 兜底
// 定期强制重读。读失败不缓存、原样抛出——loadConfig 的"保留上一份有效配置"路径不变。
// 返回深拷贝：调用方拿到的对象可以随意改，不会污染缓存。
export function createLayeredConfigReader({ load = loadLayeredConfig, cache = createStampedCache() } = {}) {
  return function readLayeredConfig({ configPath: teamPath, localConfigPath: personalPath }) {
    const parsed = cache.get(`layered:${teamPath}|${personalPath}`, [teamPath, personalPath],
      () => load({ configPath: teamPath, localConfigPath: personalPath }));
    return structuredClone(parsed);
  };
}

// 动态读取分层配置（团队 config.json + 个人 config.local.json）获取主连接服务器 (myserver) 的配置
export function selectActiveServer(parsed = {}) {
  const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
  return servers.find((server) => server.id === parsed.activeServerId)
    || servers.find((server) => server.id === "server-01")
    || servers[0];
}

// 配置注入面收口：与 monitor-server 同一条路——loadLayeredConfig 合并出的配置
// （含入库共享的 config.json / config.local.json 的 portOverrides、host）必须先经
// normalizeAgentConfig 归一化（非法 port/host 回落默认），才能进入隧道参数与远端
// shell 命令拼接。normalizeAgentConfig 用 `...config` 保留全部顶层字段
// （sshUser/sshIdentityFile/activeServerId/portOverrides 等），servers 条目也是
// `...server` 展开只覆写 host/localPort/remotePort——supervisor 用到的字段无一丢失。
// v2.18：返回值是"活跃服务器条目 + 多隧道三件套"的超集。
//   - 展开活跃服务器条目（host/remotePort/localPort/name/validationProfile…）：
//     旧调用方与既有断言把返回值直接当单隧道 config 用，形状逐字不变；
//   - proxyPort：唯一的本地代理端口（活跃服务器 localPort，kai 现网仍是 8888）；
//   - activeServerId：只决定"看哪台"，不再决定"连哪台"；
//   - tunnels：每台需要常驻隧道的服务器一条 TunnelConfig，localPort 一律等于 proxyPort
//     （所有 -R 都指向同一个本地代理；各服务器自己的 localPort 只作展示）。
// TunnelConfig 形如旧的单隧道 config，因此 buildTunnelArgs / buildTunnelSignature /
// remotePortOpen 三个函数的签名一个都不用改。
// dataRoot：钉扎 known_hosts 所在的数据根；log：配置告警的去处（supervisor 的 log）。
// 没有 remotePort 的服务器（还没领端口 / 端口写坏被剔除）不产出隧道：normalizeAgentConfig 不再
// 回落 7891，resolveTunnelTargets 对缺端口条目静默跳过——没领端口的人绝不会去 `ssh -R` 别人的端口。
export function resolveSupervisorConfig(parsed = {}, { dataRoot, log = () => {} } = {}) {
  const warnInvalidTarget = (message) => log(message, { level: "warn", event: "tunnel-target-invalid" });
  const normalized = normalizeAgentConfig(parsed, { warn: warnInvalidTarget });
  const active = selectActiveServer(normalized) || {};
  const proxyPort = resolveProxyPort(normalized);
  const controlPlanePort = resolveControlPlanePort();
  const proxyPortConflict = controlPlanePort != null && proxyPort === controlPlanePort;
  if (proxyPortConflict) {
    warnInvalidTarget(`本地共享代理端口 ${proxyPort} 与控制面 HTTP 端口 ${controlPlanePort} 冲突，已暂停所有隧道以避免端口串线`);
  }
  const rawTunnels = resolveTunnelTargets(normalized, {
    warn: warnInvalidTarget,
  // 无 id 的条目没法进 Map、没法命名注册表记录，直接不建隧道（前端仍会显示这台）。
  }).filter((target) => Boolean(target.serverId)).map((target) => ({
    id: target.serverId,
    // serverId 别名：设计文档 §6.2 用 serverId、交付契约用 id，两个名字都留着，
    // 下游按哪个读都对（值恒等）。
    serverId: target.serverId,
    host: target.host,
    remotePort: target.remotePort,
    localPort: proxyPort,
    ...(target.sshUser ? { sshUser: target.sshUser } : {}),
    ...(target.sshIdentityFile ? { sshIdentityFile: target.sshIdentityFile } : {}),
    ...(target.sshPort ? { sshPort: target.sshPort } : {}),
    ...(target.authRef ? { authRef: target.authRef } : {}),
    source: target.source,
    ...(() => {
      try {
        // 修订号按文件戳缓存（stat-cache）：每拍只 stat，不再对每台服务器 readFileSync+sha256。
        const knownHostsPath = resolveHostKeyPath(dataRoot, target.serverId);
        const knownHostsRevision = knownHostsRevisionFor(knownHostsPath);
        return knownHostsRevision ? { knownHostsPath, knownHostsRevision } : {};
      } catch {
        return {};
      }
    })(),
  }));
  // 远端反向转发的监听点是「这台服务器上的 127.0.0.1:remotePort」，与本机
  // 的 SSH 用户、localPort 无关。同一台服务器上若两条配置用了相同 remotePort，
  // 第二条 ssh 即使使用不同 localPort 也只能失败；更危险的是它的远端端口探针
  // 只看到端口已打开，可能把第一条隧道误认成自己的隧道，造成流量串到另一台电脑。
  // 因此先按 host + remotePort 去重，再做完整 -R 签名去重。host 是 SSH 的实际
  // 目标字符串；不同别名即使最终解析到同一 IP 也应在团队配置里统一命名，无法在
  // 本地无副作用地可靠判断 DNS 别名是否相同。
  const seenRemoteBinds = new Set();
  const seenSignatures = new Set();
  const tunnels = [];
  for (const target of proxyPortConflict ? [] : rawTunnels) {
    // SSH 允许 user@host 写在 host 字段里；反向端口实际绑在 host 去掉用户
    // 前缀后的远端机器上。大小写也不应制造一个看似不同的监听点。
    const remoteHost = target.host.replace(/^[^@]+@/, "").toLowerCase();
    const remoteBind = `${remoteHost}\u0000${target.remotePort}`;
    if (seenRemoteBinds.has(remoteBind)) {
      log(`server "${target.id}" reuses remote reverse port ${target.host}:${target.remotePort} already assigned to an earlier tunnel; skipping it`, {
        level: "warn",
        event: "tunnel-remote-port-duplicate",
        nextAction: "为同一台服务器上的每条隧道分配不同的 remotePort，或删除重复服务器条目",
      });
      continue;
    }
    seenRemoteBinds.add(remoteBind);
    const signature = buildTunnelSignature(target);
    if (seenSignatures.has(signature)) {
      log(`server "${target.id}" resolves to the same reverse tunnel as an earlier one (${signature}), skipping it`, {
        level: "warn",
        event: "tunnel-target-duplicate",
        nextAction: "检查 config.json / config.local.json 里是否有 host 或 remotePort 写错的服务器条目",
      });
      continue;
    }
    seenSignatures.add(signature);
    tunnels.push(target);
  }
  return {
    ...attachPersonalSsh(active, normalized),
    proxyPort,
    proxyPortConflict,
    activeServerId: active.id ?? normalized.activeServerId ?? null,
    tunnels,
  };
}

// 每拍一次的配置读取。除了解析结果，还截留最近一次读到的自动修复配置：
// resolveSupervisorConfig 的返回值不含 autoRepair 这种顶层字段，
// 隧道控制器的 getAutoRepair 从这里读（热改配置下一拍即生效）。
export function createConfigLoader({
  configPath,
  localConfigPath,
  dataRoot,
  log = () => {},
  readLayeredConfig = createLayeredConfigReader(),
} = {}) {
  let latestAutoRepair = normalizeAutoRepairConfig(null);
  let lastGoodSupervisorConfig = null;
  // 配置告警（端口非法 / 隧道参数非法 / 同签名重复）每拍都会重新算一遍：同一条告警只在它
  // 第一次出现时落日志，配置修好后消失、再次写坏会重新告警——否则一条写坏的端口每 5 秒刷一行。
  let previousConfigWarnings = new Set();

  async function loadConfig() {
    try {
      const parsed = readLayeredConfig({ configPath, localConfigPath });
      latestAutoRepair = normalizeAutoRepairConfig(parsed?.autoRepair);
      const currentWarnings = new Set();
      const logOnce = (message, fields) => {
        if (fields?.level === "warn") {
          currentWarnings.add(message);
          if (previousConfigWarnings.has(message)) return;
        }
        log(message, fields);
      };
      lastGoodSupervisorConfig = resolveSupervisorConfig(parsed, { dataRoot, log: logOnce });
      previousConfigWarnings = currentWarnings;
      return lastGoodSupervisorConfig;
    } catch (err) {
      log(`load config failed: ${err.message}; retaining last validated targets`);
      // A damaged/missing config must never invent a connection to a built-in
      // server. Keep already validated tunnels during transient file errors;
      // first startup without valid config has no remote targets.
      return lastGoodSupervisorConfig || { proxyPort: 8888, activeServerId: null, tunnels: [] };
    }
  }

  return { loadConfig, getAutoRepair: () => latestAutoRepair };
}
