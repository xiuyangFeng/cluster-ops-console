// 账号名只在该节点的采集结果内比较；不同节点上相同 UID 不代表同一个人。
// 卡的总体负载可见，普通账号的进程、命令行和作业明细只保留本人。
export function gpuForAccount(cards, user) {
  if (!Array.isArray(cards)) return cards;
  return cards.map((card) => Array.isArray(card.users) ? { ...card, users: card.users.filter((owner) => user === "root" || (user && owner.user === user)) } : card);
}

export function filterGpuVisibility(data, user) {
  data.gpu = gpuForAccount(data.gpu, user);
  if (data.slurm?.nodes) {
    data.slurm.nodes = data.slurm.nodes.map((node) => node.gpus?.cards
      ? { ...node, gpus: { ...node.gpus, cards: gpuForAccount(node.gpus.cards, node.sshUser || user) } } : node);
  }
  if (data.slurm?.jobs && user !== "root") {
    data.slurm.jobs = data.slurm.jobs.filter((job) => user && job.user === user);
    data.slurm.jobsTotal = data.slurm.jobs.length;
    data.slurm.counts = { running: 0, pending: 0, other: 0 };
    for (const job of data.slurm.jobs) data.slurm.counts[job.state === "RUNNING" ? "running" : job.state === "PENDING" ? "pending" : "other"]++;
  }
  return data;
}
