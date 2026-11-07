// 多隧道收敛：按 serverId + 隧道身份比较上一拍与本拍的目标集合，新增建、移除停、保留 ensure。
import { buildTunnelIdentity } from "./tunnel-spec.mjs";

// prevMap: Map<serverId, { config, controller }>。
// 按 serverId 取差集，再按 buildTunnelSignature 比较——签名变化（换了 host / remotePort /
// 代理端口）意味着现有 ssh 进程建的是另一条转发，必须先停再建，因此记成 removed + added。
export function diffTunnelTargets(prev, nextList = []) {
  const next = new Map();
  for (const target of nextList) {
    const id = target?.id ?? target?.serverId;
    if (id) next.set(id, target);
  }
  const added = [];
  const removed = [];
  const kept = [];
  for (const [id, entry] of prev) {
    const target = next.get(id);
    if (!target) {
      removed.push(id);
      continue;
    }
    if (buildTunnelIdentity(entry.config) !== buildTunnelIdentity(target)) {
      removed.push(id);
      added.push(target);
    } else {
      kept.push(target);
    }
  }
  for (const [id, target] of next) {
    if (!prev.has(id)) added.push(target);
  }
  return { added, removed, kept };
}

// 每一拍的隧道收敛：新增建、移除停、保留 ensure。controllers 是
// Map<serverId, { config, controller }>，就地增删——调用方（主循环 / shutdown）
// 始终看到最新一份。activeServerId 完全不参与本函数：切换活跃服务器不再停任何隧道。
export async function reconcileTunnels({
  controllers,
  targets = [],
  createController,
  stopping = () => false,
  log: logImpl = () => {},
  onRemoved = async () => {},
} = {}) {
  const { added, removed, kept } = diffTunnelTargets(controllers, targets);
  for (const serverId of removed) {
    const entry = controllers.get(serverId);
    controllers.delete(serverId);
    if (!entry) continue;
    logImpl(`tunnel target ${serverId} is gone from config (or its signature changed), stopping its tunnel`, {
      event: "tunnel-target-removed",
    });
    await entry.controller.stopCurrent();
    await onRemoved(serverId);
  }
  for (const target of added) {
    controllers.set(target.id, { config: target, controller: createController(target.id) });
  }
  // 并发 ensure：一台服务器不可达（探测最长 6s）不该拖住其余隧道的保活节拍。
  await Promise.all([...kept, ...added].map(async (target) => {
    const entry = controllers.get(target.id);
    if (!entry) return;
    entry.config = target;
    try {
      await entry.controller.ensure(target, { stopping });
    } catch (err) {
      logImpl(`tunnel ${target.id} ensure failed: ${err.message}`, { level: "error", event: "tunnel-ensure-error" });
    }
  }));
  return { added, removed, kept };
}
