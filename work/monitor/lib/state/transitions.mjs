// 状态变迁时间线：把整棵 layers 压成扁平的 key → level 快照，diff 出逐 key 的变迁，
// 最近若干条进环形缓冲（status-lite.recentTransitions / STATUS_CHANGED.transitions 共用）。
//
// key 约定：channel / agent:<id> / res:<serverId> / res:validation:<serverId> / tunnel:<serverId>。
// history-store 与前端时间线按这些前缀归类，改名即破坏按天复盘。

export const TRANSITION_RING_MAX = 50;

const AGENT_PREFIX = "agent:";
const RESOURCE_PREFIX = "res:";
const VALIDATION_KEY_PREFIX = "res:validation:";
const TUNNEL_PREFIX = "tunnel:";

// 结构化 level 快照（key -> level），供 diff 出精确的层级变迁。
// activeTunnelId：当前查看视角的服务器 id——它的隧道已由 channel 键覆盖，不再单列。
export function levelMap(layers, activeTunnelId) {
  const map = { channel: layers.channel.level };
  for (const [id, agent] of Object.entries(layers.agents)) map[`${AGENT_PREFIX}${id}`] = agent.level;
  for (const [id, resource] of Object.entries(layers.resources)) map[`${RESOURCE_PREFIX}${id}`] = resource.level;
  if (layers.validation) {
    for (const [id, v] of Object.entries(layers.validation)) {
      map[`${VALIDATION_KEY_PREFIX}${id}`] = v.level;
    }
  }
  // v2.18：次要隧道也要进时间线与 history，否则"腾讯云隧道半夜断了两小时"
  // 在按天复盘里完全查不到。只收非活跃服务器：活跃那台与 layers.channel 同源
  // （buildTunnelsLayer 直接复制 channel 的 level/reason），再建一个 tunnel: 键
  // 只会让同一次断开在时间线里出现两条。tunnel === false 的"仅监控"服务器恒为
  // skipped，没有可观测的变迁，也不进。
  for (const [id, entry] of Object.entries(layers.tunnels || {})) {
    if (id === activeTunnelId) continue;
    if (!entry || entry.tunnel === false) continue;
    map[`${TUNNEL_PREFIX}${id}`] = entry.level;
  }
  return map;
}

function layerOfKey(key) {
  if (key === "channel") return "channel";
  if (key.startsWith(AGENT_PREFIX)) return "agents";
  if (key.startsWith(TUNNEL_PREFIX)) return "tunnels";
  return "resources";
}

function reasonOfKey(key, layer, layers) {
  if (key === "channel") return layers.channel.reason;
  if (layer === "agents") return layers.agents[key.slice(AGENT_PREFIX.length)]?.reason;
  if (layer === "tunnels") return layers.tunnels?.[key.slice(TUNNEL_PREFIX.length)]?.reason;
  if (key.startsWith(VALIDATION_KEY_PREFIX)) return layers.validation[key.slice(VALIDATION_KEY_PREFIX.length)]?.reason;
  return layers.resources[key.slice(RESOURCE_PREFIX.length)]?.reason;
}

// next 中与 prev 不同的每个 key 产出一条 {ts, layer, key, from, to, reason}。
// 只比 next 的键：从快照里消失的 key（服务器被删）不算一次变迁。
export function diffTransitions(prev, next, layers, now) {
  const out = [];
  for (const [key, to] of Object.entries(next)) {
    const from = prev[key];
    if (from === to) continue;
    const layer = layerOfKey(key);
    const reason = reasonOfKey(key, layer, layers);
    out.push({ ts: now(), layer, key, from: from ?? "unknown", to, reason: reason || "" });
  }
  return out;
}

// 查看视角切换不是故障或恢复：channel / agent:* 与上一视角的 tunnel:<previousId>
// 以新视角重新建立基线（不产出变迁、不触发桌面通知）；其余按服务器命名的键照常比较。
export function isViewScopedKey(key, previousId) {
  return key === "channel" || key.startsWith(AGENT_PREFIX) || key === `${TUNNEL_PREFIX}${previousId}`;
}

export function createTransitionRing(max = TRANSITION_RING_MAX) {
  const ring = [];
  return {
    push(transitions) {
      for (const t of transitions) {
        ring.push(t);
        if (ring.length > max) ring.shift();
      }
    },
    recent(limit) {
      return ring.slice(-limit).map((t) => ({ ...t }));
    },
  };
}
