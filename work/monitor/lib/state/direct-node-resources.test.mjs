import assert from "node:assert/strict";
import test from "node:test";
import { buildResourcesLayer, resourceExtrasFrom } from "./resource-layers.mjs";
import { DIRECT_RESOURCE_MAX_AGE_MS } from "./direct-node-resources.mjs";
import { parseSlurmSection } from "../slurm.mjs";

const NOW = 1_800_000_000_000;
function fixture({ user = "root", nodeUser = user } = {}) {
  const servers = [{ id: "master", host: "master", sshUser: user },
    { id: "node04", name: "node04", host: "203.0.113.4", sshUser: nodeUser, tunnel: false }];
  const slurm = parseSlurmSection(`state=ok\nuser=${user}\nhop=node04|unreachable|DOWN+NOT_RESPONDING`);
  const gpu = [{ index: 0, uuid: "GPU-1", name: "NVIDIA A100", util: 50, memUsedMb: 100, memTotalMb: 200,
    users: [{ user: nodeUser, memMb: 80 }, { user: "someone-else", memMb: 20 }] }];
  const resourceExtras = new Map([
    ["master", resourceExtrasFrom({ slurm })],
    ["node04", resourceExtrasFrom({ gpu, agents: { user: nodeUser },
      usage: { cpu: { logicalCores: 192, load1: 2, busyPct: 15 }, memory: { totalBytes: 256 * 1024 ** 3 } } })],
  ]);
  const results = new Map(servers.map((s) => [s.id, { level: "ok", checkedAt: NOW - 1000 }]));
  const serversBrief = { master: { ok: true, output: "master\n" },
    node04: { ok: true, output: "node04\nMem: 256Gi 64Gi 1Gi 0Gi 191Gi 192Gi\n" } };
  const args = { servers, serversBrief, resourceExtras, config: { servers }, now: NOW, slowResultFor: (id) => results.get(id) };
  return { args, results, gpu, slurm, node: () => buildResourcesLayer(args).master.slurm.nodes[0] };
}

test("失败跳采复用独立 IP 连接的真实 hostname 与资源，原始采集快照保持不变", () => {
  const f = fixture();
  const before = structuredClone({ slurm: f.slurm, gpu: f.gpu });
  const node = f.node();
  assert.equal(node.reachable, true);
  assert.equal(node.failure, null);
  assert.equal(node.state, "direct");
  assert.equal(node.stateRaw, "DOWN+NOT_RESPONDING");
  assert.equal(node.connectionId, "node04");
  assert.equal(node.sshUser, "root");
  assert.equal(node.lastSeenAt, NOW - 1000);
  assert.equal(node.cpus.total, 192);
  assert.equal(node.busyPct, 15);
  assert.equal(node.memTotalMb, 256 * 1024);
  assert.equal(node.memFreeMb, 192 * 1024);
  assert.equal(node.gpus.total, 1);
  assert.equal(node.gpus.used, 1);
  assert.equal(node.gpus.model, "A100");
  assert.deepEqual({ slurm: f.slurm, gpu: f.gpu }, before);
});

test("独立采样失败、跳过、过期、停用、hostname 不符或连接有歧义时保留真实失败", () => {
  const cases = [
    (f) => f.results.set("node04", { level: "error", checkedAt: NOW }),
    (f) => f.results.set("node04", { level: "skipped", checkedAt: NOW }),
    (f) => f.results.set("node04", { level: "ok", checkedAt: NOW - DIRECT_RESOURCE_MAX_AGE_MS - 1 }),
    (f) => { f.args.servers[1].monitorEnabled = false; },
    (f) => { f.args.serversBrief.node04.output = "other-host\n"; },
    (f) => { f.args.servers[1].sshJumpServerId = "other-cluster"; },
    (f) => {
      f.args.servers.push({ ...f.args.servers[1], id: "duplicate" });
      f.args.serversBrief.duplicate = f.args.serversBrief.node04;
      f.args.resourceExtras.set("duplicate", f.args.resourceExtras.get("node04"));
      f.results.set("duplicate", f.results.get("node04"));
    },
  ];
  for (const mutate of cases) {
    const f = fixture();
    mutate(f);
    assert.equal(f.node().reachable, false);
  }
});

test("普通账号不能借 root 或其它账号采集结果，GPU 明细仍只保留当前账号", () => {
  assert.equal(fixture({ user: "alice", nodeUser: "root" }).node().reachable, false);
  const f = fixture({ user: "alice" });
  assert.deepEqual(f.node().gpus.cards[0].users.map((u) => u.user), ["alice"]);
  assert.equal(f.gpu[0].users.length, 2);
});

test("成功跳采与 Slurm 分区节点不被独立连接覆盖", () => {
  const f = fixture();
  f.slurm.nodes[0].reachable = true;
  assert.equal(f.node().connectionId, undefined);
  f.slurm.nodes[0].reachable = false;
  f.slurm.nodes[0].source = "slurm";
  assert.equal(f.node().connectionId, undefined);
});
