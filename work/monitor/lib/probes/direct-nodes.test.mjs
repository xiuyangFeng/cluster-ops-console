import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResourcesLayer, resourceExtrasFrom } from "../state/resource-layers.mjs";
import { createDirectNodeWatch } from "./direct-nodes.mjs";

function snapshot(checkedAt, nodes, state = "ok") {
  return { state, checkedAt, nodes: nodes.map((n) => ({ ...n })) };
}

const slurmNode = { name: "node07", source: "slurm", reachable: true, failure: null };
const up = { name: "node04", source: "direct", reachable: true, failure: null };
const down = (failure = "timeout") => ({ name: "node04", source: "direct", reachable: false, failure });

function recorder() {
  const entries = [];
  return { entries, appendLog: (message, fields) => entries.push({ message, ...fields }) };
}

test("首次可达：info「发现」一条，lastSeenAt=本轮；稳态不再写日志", () => {
  const { entries, appendLog } = recorder();
  const watch = createDirectNodeWatch({ appendLog });
  const s1 = snapshot(1000, [slurmNode, up]);
  watch.observe("server-01", s1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].level, "info");
  assert.equal(entries[0].event, "direct-node-found");
  assert.match(entries[0].message, /node04/);
  assert.equal(s1.nodes[1].lastSeenAt, 1000);
  assert.equal(s1.nodes[0].lastSeenAt, undefined, "Slurm 节点不挂 lastSeenAt");
  const s2 = snapshot(61000, [slurmNode, up]);
  watch.observe("server-01", s2);
  assert.equal(entries.length, 1, "状态没变不写日志");
  assert.equal(s2.nodes[1].lastSeenAt, 61000);
});

test("可达 → 断开：warn 一条（带失败原因），lastSeenAt 沿用上次；持续断开不刷屏；恢复 info 带中断时长", () => {
  const { entries, appendLog } = recorder();
  const watch = createDirectNodeWatch({ appendLog });
  watch.observe("server-01", snapshot(0, [up]));
  const s2 = snapshot(60_000, [down("timeout")]);
  watch.observe("server-01", s2);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, "warn");
  assert.equal(entries[1].event, "direct-node-down");
  assert.equal(entries[1].failure, "timeout");
  assert.equal(entries[1].serverId, "server-01");
  assert.equal(entries[1].node, "node04");
  assert.equal(
    entries[1].message,
    "集群直连节点 node04 无法连接（连接超时）：只影响该节点的监控，Slurm 节点、作业队列与隧道不受影响",
  );
  assert.equal(s2.nodes[0].lastSeenAt, 0);
  for (let i = 2; i < 6; i += 1) watch.observe("server-01", snapshot(i * 60_000, [down("unreachable")]));
  assert.equal(entries.length, 2, "持续断开只记一次");
  watch.observe("server-01", snapshot(7 * 60_000, [up]));
  assert.equal(entries.length, 3);
  assert.equal(entries[2].level, "info");
  assert.equal(entries[2].event, "direct-node-up");
  assert.equal(entries[2].message, "集群直连节点 node04 已恢复连接（中断约 6 分钟）");
});

test("首次就不可达：warn（ssh 连接失败），lastSeenAt=null；恢复时中断时长未知不写括号", () => {
  const { entries, appendLog } = recorder();
  const watch = createDirectNodeWatch({ appendLog });
  const s1 = snapshot(1000, [down("unreachable")]);
  watch.observe("server-01", s1);
  assert.equal(entries[0].level, "warn");
  assert.match(entries[0].message, /ssh 连接失败/);
  assert.equal(s1.nodes[0].lastSeenAt, null);
  watch.observe("server-01", snapshot(2000, [up]));
  assert.equal(entries[1].message, "集群直连节点 node04 已恢复连接");
});

test("slurm 非 ok / 缺失时不观察；按服务器隔离；prune 后重新计为首次", () => {
  const { entries, appendLog } = recorder();
  const watch = createDirectNodeWatch({ appendLog });
  watch.observe("server-01", null);
  watch.observe("server-01", snapshot(0, [up], "error"));
  watch.observe("server-01", { state: "ok" });
  assert.equal(entries.length, 0);
  watch.observe("server-01", snapshot(0, [up]));
  watch.observe("server-02", snapshot(0, [up]));
  assert.equal(entries.length, 2, "两台服务器各自记一次发现");
  watch.prune(["server-02"]);
  watch.observe("server-01", snapshot(1, [up]));
  assert.equal(entries.length, 3);
});

test("appendLog 缺省或抛错都不影响观察（lastSeenAt 照常挂上）", () => {
  const silent = createDirectNodeWatch({});
  const s = snapshot(5, [up]);
  assert.doesNotThrow(() => silent.observe("s", s));
  assert.equal(s.nodes[0].lastSeenAt, 5);
  const throwing = createDirectNodeWatch({ appendLog: () => { throw new Error("disk full"); } });
  const t = snapshot(6, [down()]);
  assert.doesNotThrow(() => throwing.observe("s", t));
  assert.equal(t.nodes[0].lastSeenAt, null);
});

test("直连节点断开不改变资源层级别：slurm 只透传", () => {
  const data = {
    gpu: [],
    agents: null,
    usage: null,
    slurm: { state: "ok", checkedAt: 1, nodes: [{ ...down() }], jobs: [] },
  };
  const layer = buildResourcesLayer({
    servers: [{ id: "server-01" }],
    slowResultFor: () => ({ level: "ok", reason: "负载已更新", checkedAt: 1, data }),
    serversBrief: { "server-01": { ok: true, cpu: 10, ram: 20, disk: 30, output: "x" } },
    resourceExtras: new Map([["server-01", resourceExtrasFrom(data)]]),
  });
  assert.equal(layer["server-01"].level, "ok");
  assert.equal(layer["server-01"].reason, "负载已更新");
  assert.equal(layer["server-01"].slurm.nodes[0].reachable, false);
});
