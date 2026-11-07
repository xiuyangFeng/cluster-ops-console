// 直连节点的连通性观察（v2.33）：不在 Slurm 分区内、经登录节点 ssh 采集的节点（本集群 node04）
// 时常因各种原因断开，但断开只影响它自己的监控——Slurm 节点、作业队列与隧道照常。
// 因此这里只做两件事：
//   1. 给每个直连节点原地挂 lastSeenAt（最近一次连上的时刻；从未连上 = null），前端显示
//      「上次连接 N 分钟前」；
//   2. 连通状态**变化时**写一条运维日志（断开 warn / 恢复 info / 首次发现 info），不刷屏。
// 刻意不碰任何层级别、事件与注意力队列：slurm 快照本身不参与判级（resource-layers 只透传）。

const FAILURE_TEXT = { timeout: "连接超时", unreachable: "ssh 连接失败" };
// 每台服务器最多记这么多节点（正常规模 = 直连节点数 ≤3），异常输出下也不无限增长。
const MAX_NODES_PER_SERVER = 64;

export function createDirectNodeWatch({ appendLog, now = Date.now } = {}) {
  // serverId -> Map(nodeName -> { reachable, lastSeenAt, downSince })
  const byServer = new Map();

  function log(message, fields) {
    if (typeof appendLog !== "function") return;
    try {
      appendLog(message, fields);
    } catch {
      // 日志失败绝不影响采集。
    }
  }

  function downMessage(name, failure) {
    const why = FAILURE_TEXT[failure] || "无法连接";
    return `集群直连节点 ${name} 无法连接（${why}）：只影响该节点的监控，Slurm 节点、作业队列与隧道不受影响`;
  }

  function observe(serverId, slurm) {
    if (slurm?.state !== "ok" || !Array.isArray(slurm.nodes)) return;
    const at = Number.isFinite(slurm.checkedAt) ? slurm.checkedAt : now();
    let known = byServer.get(serverId);
    if (!known) {
      known = new Map();
      byServer.set(serverId, known);
    }
    for (const node of slurm.nodes) {
      if (node?.source !== "direct" || typeof node.name !== "string") continue;
      const name = node.name;
      const reachable = node.reachable === true;
      const prev = known.get(name);
      const lastSeenAt = reachable ? at : (prev?.lastSeenAt ?? null);
      node.lastSeenAt = lastSeenAt;
      const base = { serverId, node: name };

      if (!prev) {
        if (known.size >= MAX_NODES_PER_SERVER) continue;
        if (reachable) {
          log(`发现不在 Slurm 分区内的节点 ${name}，改为经登录节点直连采集`, { level: "info", event: "direct-node-found", ...base });
        } else {
          log(downMessage(name, node.failure), { level: "warn", event: "direct-node-down", ...base, failure: node.failure ?? null });
        }
        // 首次就连不上：真正的断开时刻未知，恢复时不报中断时长。
        known.set(name, { reachable, lastSeenAt, downSince: null });
        continue;
      }

      if (prev.reachable && !reachable) {
        log(downMessage(name, node.failure), { level: "warn", event: "direct-node-down", ...base, failure: node.failure ?? null });
        known.set(name, { reachable, lastSeenAt, downSince: at });
      } else if (!prev.reachable && reachable) {
        const minutes = prev.downSince != null ? Math.max(1, Math.round((at - prev.downSince) / 60000)) : null;
        const span = minutes != null ? `（中断约 ${minutes} 分钟）` : "";
        log(`集群直连节点 ${name} 已恢复连接${span}`, { level: "info", event: "direct-node-up", ...base });
        known.set(name, { reachable, lastSeenAt, downSince: null });
      } else {
        known.set(name, { ...prev, lastSeenAt });
      }
    }
  }

  // 配置热载移除服务器后丢掉它的记录。
  function prune(liveServerIds) {
    const live = new Set(liveServerIds || []);
    for (const serverId of [...byServer.keys()]) {
      if (!live.has(serverId)) byServer.delete(serverId);
    }
  }

  return { observe, prune };
}
