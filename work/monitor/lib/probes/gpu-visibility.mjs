import { isAdminUser } from "../team-admin/protocol.mjs";

// 账号名只在该节点的采集结果内比较；不同节点上相同 UID 不代表同一个人。
// 卡的总体负载可见，普通账号的进程、命令行和作业明细只保留本人；root 或 adminUsers 保留全量。
export function gpuForAccount(cards, user, { adminUsers = [] } = {}) {
  if (!Array.isArray(cards)) return cards;
  const full = isAdminUser({ adminUsers }, user);
  return cards.map((card) => Array.isArray(card.users)
    ? { ...card, users: card.users.filter((owner) => full || (user && owner.user === user)) }
    : card);
}

export function filterGpuVisibility(data, user, { adminUsers = [] } = {}) {
  const opts = { adminUsers };
  data.gpu = gpuForAccount(data.gpu, user, opts);
  if (data.slurm?.nodes) {
    data.slurm.nodes = data.slurm.nodes.map((node) => node.gpus?.cards
      ? { ...node, gpus: { ...node.gpus, cards: gpuForAccount(node.gpus.cards, node.sshUser || user, opts) } } : node);
  }
  if (data.slurm?.jobs && !isAdminUser(opts, user)) {
    data.slurm.jobs = data.slurm.jobs.filter((job) => user && job.user === user);
    data.slurm.jobsTotal = data.slurm.jobs.length;
    data.slurm.counts = { running: 0, pending: 0, other: 0 };
    for (const job of data.slurm.jobs) data.slurm.counts[job.state === "RUNNING" ? "running" : job.state === "PENDING" ? "pending" : "other"]++;
  }
  return data;
}
