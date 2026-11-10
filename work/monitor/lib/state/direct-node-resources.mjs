import { directNodeFromResource } from "../slurm.mjs";
import { attachPersonalSsh } from "../ssh-args.mjs";
import { gpuForAccount } from "../probes/gpu-visibility.mjs";

export const DIRECT_RESOURCE_MAX_AGE_MS = 150_000;
const host = (value) => String(value || "").trim().toLowerCase().replace(/\.$/, "");

// 只补失败的登录节点跳采，不改变 Slurm 自己的调度状态。
// 必须同时匹配配置中的节点标识与实际 hostname；同名多连接有歧义时不猜。
export function reconcileDirectNodeResources(resources, servers, config, now) {
  for (const parent of servers) {
    const layer = resources[parent.id];
    if (layer?.slurm?.state !== "ok" || !Array.isArray(layer.slurm.nodes)) continue;
    const viewer = layer.slurm.user || layer.agentsInstalled?.user || attachPersonalSsh(parent, config).sshUser;
    const nodes = layer.slurm.nodes.map((node) => {
      if (node.source !== "direct" || node.reachable !== false) return node;
      const name = host(node.name);
      const candidates = servers.filter((server) => {
        if (server.id === parent.id || server.disabled || server.monitorEnabled === false) return false;
        if (server.sshJumpServerId && server.sshJumpServerId !== parent.id) return false;
        const sample = resources[server.id];
        if (sample?.level !== "ok" || !Number.isFinite(sample.checkedAt)
          || now - sample.checkedAt > DIRECT_RESOURCE_MAX_AGE_MS || sample.checkedAt > now) return false;
        const user = sample.agentsInstalled?.user || attachPersonalSsh(server, config).sshUser;
        if (!viewer || !user || (viewer !== "root" && user !== viewer)) return false;
        if (![server.id, server.name, server.host, server.sshHostName].some((value) => host(value) === name)) return false;
        const hostname = host(String(sample.output || "").split("\n")[0]);
        return hostname === name;
      });
      if (candidates.length !== 1) return node;
      const connection = candidates[0];
      const sample = resources[connection.id];
      const sshUser = sample.agentsInstalled?.user || attachPersonalSsh(connection, config).sshUser;
      return directNodeFromResource(node, { ...sample, gpu: gpuForAccount(sample.gpu, viewer) }, { connectionId: connection.id, sshUser });
    });
    layer.slurm = { ...layer.slurm, nodes };
  }
  return resources;
}
