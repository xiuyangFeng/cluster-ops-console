import assert from "node:assert/strict";
import test from "node:test";
import { filterGpuVisibility, gpuForAccount } from "./gpu-visibility.mjs";
const cards = [{ index: 0, memUsedMb: 1000, users: [
  { user: "kai", procs: [{ pid: "1", jobId: "11", cmdline: "kai job" }] },
  { user: "user01", procs: [{ pid: "2", jobId: "22", cmdline: "user01 private" }] },
] }];
test("普通账号只留本节点本人 GPU 明细，root 看全部；未知账号不泄漏", () => {
  assert.deepEqual(gpuForAccount(cards, "kai")[0].users.map((u) => u.user), ["kai"]);
  assert.equal(gpuForAccount(cards, "kai")[0].memUsedMb, 1000);
  assert.equal(JSON.stringify(gpuForAccount(cards, "kai")).includes("user01 private"), false);
  assert.equal(gpuForAccount(cards, "root")[0].users.length, 2);
  assert.equal(gpuForAccount(cards, null)[0].users.length, 0);
  assert.equal(cards[0].users.length, 2);
});
test("内网跳转节点使用实际登录账号过滤，不沿用主集群用户名或 UID", () => {
  const data = filterGpuVisibility({ gpu: cards, slurm: { nodes: [{ name: "node04", sshUser: "user01", gpus: { cards } }] } }, "kai");
  assert.equal(data.gpu[0].users[0].user, "kai");
  assert.equal(data.slurm.nodes[0].gpus.cards[0].users[0].user, "user01");
});

test("普通账号的队列与数量只包含本人，root 保留全量", () => {
  const make = () => ({ gpu: [], slurm: { nodes: [], jobs: [{ id: "1", user: "kai", state: "RUNNING" }, { id: "2", user: "user01", state: "PENDING" }], jobsTotal: 2, counts: { running: 1, pending: 1, other: 0 } } });
  const self = filterGpuVisibility(make(), "kai");
  assert.deepEqual(self.slurm.jobs.map((j) => j.id), ["1"]);
  assert.equal(self.slurm.jobsTotal, 1);
  assert.deepEqual(self.slurm.counts, { running: 1, pending: 0, other: 0 });
  assert.equal(filterGpuVisibility(make(), "root").slurm.jobs.length, 2);
});
