import assert from "node:assert/strict";
import test from "node:test";

import { buildTeamOverviewModel } from "./model.mjs";

test("buildTeamOverviewModel：融合名册、端口监听、心跳、下发状态与集群算力（Slurm + GPU + procTop）", () => {
  const survey = {
    me: "kai",
    nowSec: 1792118400,
    hubBase: "ok",
    hubOwner: "kai",
    dirs: {
      admin: { state: "ok", owner: "kai" },
      assigned: { state: "ok", owner: "kai" },
      ports: { state: "ok", owner: "kai" },
      pubkeys: { state: "ok", owner: "kai" },
      heartbeats: { state: "ok", owner: "kai" },
    },
    roster: {
      v: 1,
      members: {
        kai: { displayName: "管理员", assignedPort: 7891, enabled: true },
        alice: { displayName: "张同学", assignedPort: 7892, enabled: true },
        bob: { displayName: "李同学", assignedPort: 7893, enabled: true },
      },
    },
    ports: [
      { port: 7891, owner: "kai", regular: true },
      { port: 7892, owner: "alice", regular: true },
    ],
    listening: [7891],
    pubkeys: {
      alice: "pub-alice",
    },
    assigned: {
      alice: {
        v: 1,
        rev: 2,
        assignedAt: "2026-10-16T09:00:00Z",
        summary: { codex: { mode: "relay", baseUrl: "https://relay.example.com/v1", keyMask: "sk-1…2345" } },
      },
    },
    heartbeats: {
      alice: {
        v: 1,
        user: "alice",
        updatedAt: 1792118300000,
        clientVersion: "2.66.0",
        channel: "stable",
        egress: { mode: "system", state: "ok", reason: null, failuresTotal: 0 },
        usage: { todayCalls: 25, todayTokens: 350000, todayErrors: 1, weekCalls: 120, weekTokens: 2100000, topModel: "gpt-5" },
        disk: { scannedDirBytes: 50 * 1024 * 1024 * 1024 },
        assignedAck: { rev: 2, status: "ok", appliedAt: "2026-10-16T09:02:00Z", message: "已生效" },
      },
    },
    spoofs: [],
    sshUsers: ["kai", "alice", "root"],
    agentProcs: {
      alice: { codex: 2 },
    },
  };

  const resources = {
    slurm: {
      jobs: [
        { id: "1001", user: "alice", state: "RUNNING", gpus: 2, cpus: 16, name: "train-llm" },
        { id: "1002", user: "alice", state: "PENDING", gpus: 1, cpus: 8, name: "eval-llm" },
      ],
      nodes: [
        {
          name: "node04",
          gpus: {
            cards: [
              { index: 0, users: [{ user: "alice", memMb: 32000 }] },
              { index: 1, users: [{ user: "alice", memMb: 30000 }] },
            ],
          },
        },
      ],
    },
    procTop: {
      users: [
        { user: "alice", cpuJobPct: 420.5, cpuOtherPct: 12.0, rssJobKb: 16000000, rssOtherKb: 500000 },
      ],
    },
  };

  const pendingAssignments = {
    bob: {
      rev: 1,
      assignedAt: "2026-10-16T10:00:00Z",
      summary: { claude: { mode: "official", keyMask: "sk-a…9999" } },
    },
  };

  const overview = buildTeamOverviewModel({
    survey,
    resources,
    pendingAssignments,
    adminVersion: "2.67.0",
    serverId: "server-01",
    serverName: "主集群服务器",
  });

  assert.equal(overview.hub.ready, true);
  assert.equal(overview.kpis.totalMembers, 3, "系统账号 root 被自动过滤，保留 cy / alice / bob");
  assert.equal(overview.kpis.tunnelOnlineCount, 1);
  assert.equal(overview.kpis.sshOnlyCount, 1);
  assert.equal(overview.kpis.totalTodayTokens, 350000);
  assert.equal(overview.kpis.totalRunningJobs, 1);
  assert.equal(overview.kpis.totalGpusUsed, 2);

  const cy = overview.members.find((m) => m.user === "kai");
  const alice = overview.members.find((m) => m.user === "alice");
  const bob = overview.members.find((m) => m.user === "bob");

  assert.equal(cy.onlineState, "tunnel-online");
  assert.equal(alice.onlineState, "ssh-only");
  assert.equal(alice.versionOutdated, true, "2.66.0 < 2.67.0 标出版本落后");
  assert.equal(alice.assignment.state, "applied");
  assert.equal(alice.compute.runningJobs, 1);
  assert.equal(alice.compute.pendingJobs, 1);
  assert.equal(alice.compute.gpuCount, 2);
  assert.equal(alice.compute.gpuMemMiB, 62000);
  assert.equal(alice.compute.cpuPct, 432.5);
  assert.equal(bob.onlineState, "offline");
  assert.equal(bob.assignment.state, "pending-pubkey");
});

test("expandSlurmNodeList：展开压缩主机列表，畸形输入不抛错", async () => {
  const { expandSlurmNodeList } = await import("./model.mjs");
  assert.deepEqual(expandSlurmNodeList("node[01-03,07],gpu5"), ["node01", "node02", "node03", "node07", "gpu5"]);
  assert.deepEqual(expandSlurmNodeList("node04"), ["node04"]);
  assert.deepEqual(expandSlurmNodeList(""), []);
  assert.deepEqual(expandSlurmNodeList(null), []);
  assert.equal(expandSlurmNodeList("n[1-500]").length, 16, "单个作业最多取 16 个节点");
  assert.deepEqual(expandSlurmNodeList("x[ab"), ["x[ab"]);
});

test("buildAssignmentGroup：同一份公开摘要得到同一指纹，标签不含明文", async () => {
  const { buildAssignmentGroup } = await import("./model.mjs");
  const a = buildAssignmentGroup({ codex: { mode: "relay", baseUrl: "https://relay.team.example/v1", providerId: "team-relay", keyMask: "sk-t…99a1" } });
  const b = buildAssignmentGroup({ codex: { mode: "relay", baseUrl: "https://relay.team.example/v1", providerId: "team-relay", keyMask: "sk-t…99a1" } });
  const c = buildAssignmentGroup({ codex: { mode: "relay", baseUrl: "https://relay.team.example/v1", providerId: "team-relay", keyMask: "sk-t…0000" } });
  assert.equal(a.groupKey, b.groupKey);
  assert.notEqual(a.groupKey, c.groupKey, "不同的 key 预览视为不同的配置");
  assert.equal(a.groupLabel, "Codex · team-relay");
  assert.equal(buildAssignmentGroup({ claude: { mode: "official", keyMask: "sk-a…1" } }).groupLabel, "Claude 官方");
  assert.equal(buildAssignmentGroup({ codex: { mode: "revoke" } }).groupKey, null);
  assert.equal(buildAssignmentGroup(null).groupKey, null);
});

test("buildTeamOverviewModel：成员带出所在节点（作业 NodeList + GPU 卡）与配置分组", () => {
  const overview = buildTeamOverviewModel({
    survey: {
      me: "kai", hubBase: "ok", dirs: {}, roster: { v: 1, members: { kai: {}, alice: {} } },
      ports: [], listening: [], pubkeys: {}, heartbeats: {}, spoofs: [], sshUsers: ["alice"], agentProcs: {},
      assigned: {
        kai: { rev: 1, summary: { codex: { mode: "relay", baseUrl: "https://r.example/v1", providerId: "team", keyMask: "sk-…1" } } },
        alice: { rev: 3, summary: { codex: { mode: "relay", baseUrl: "https://r.example/v1", providerId: "team", keyMask: "sk-…1" } } },
      },
    },
    resources: {
      slurm: {
        jobs: [{ id: "1", user: "alice", state: "RUNNING", gpus: 1, nodeList: "node[02-03]" }],
        nodes: [{ name: "node04", gpus: { cards: [{ index: 0, users: [{ user: "alice", memMb: 1000 }] }] } }],
      },
    },
  });
  const alice = overview.members.find((m) => m.user === "alice");
  const cy = overview.members.find((m) => m.user === "kai");
  assert.deepEqual(alice.compute.nodes, ["node02", "node03", "node04"]);
  assert.deepEqual(cy.compute.nodes, []);
  assert.ok(alice.assignment.groupKey);
  assert.equal(alice.assignment.groupKey, cy.assignment.groupKey, "两人信封摘要相同 → 同一配置星座");
  assert.equal(alice.assignment.groupLabel, "Codex · team");
});

test("buildTeamOverviewModel：算力卫生识别（登录节点占卡 / 非 Slurm 占卡 / 0% 空占）与配置星座限流预警", () => {
  const overview = buildTeamOverviewModel({
    survey: {
      me: "kai",
      hubBase: "ok",
      dirs: {},
      roster: { v: 1, members: { kai: {}, alice: {}, bob: {} } },
      notice: { v: 1, title: "维护通知", text: "g02 今晚升级驱动", level: "warn", author: "kai" },
      ports: [],
      listening: [],
      pubkeys: {},
      heartbeats: {
        alice: { usage: { todayTokens: 500000, todayCalls: 10, todayErrors: 6, todayCostUsd: 1.5, topModel: "claude-sonnet-4-6" } },
        bob: { usage: { todayTokens: 200000, todayCalls: 4, todayErrors: 2, todayCostUsd: 0.6, topModel: "claude-sonnet-4-6" } },
      },
      spoofs: [],
      sshUsers: ["alice", "bob"],
      agentProcs: {},
      assigned: {
        alice: { rev: 1, summary: { claude: { mode: "relay", baseUrl: "https://r.example", keyMask: "sk-…9" } } },
        bob: { rev: 1, summary: { claude: { mode: "relay", baseUrl: "https://r.example", keyMask: "sk-…9" } } },
      },
    },
    resources: {
      gpu: {
        cards: [{ index: 0, util: 50, users: [{ user: "bob", memMb: 4096 }] }],
      },
      slurm: {
        jobs: [],
        nodes: [
          {
            name: "gpu01",
            gpus: {
              cards: [{ index: 0, util: 0, users: [{ user: "alice", memMb: 8192, jobs: [] }] }],
            },
          },
        ],
      },
    },
  });
  const alice = overview.members.find((m) => m.user === "alice");
  const bob = overview.members.find((m) => m.user === "bob");
  assert.equal(bob.compute.loginGpuCount, 1, "登录节点 host gpu 卡计入 loginGpuCount");
  assert.equal(alice.compute.unmanagedGpuCount, 1, "计算节点占卡但无运行中 Slurm 作业且无 jobs 标记 → 非 Slurm 裸跑占卡");
  assert.equal(alice.compute.idleGpuCount, 1, "显存 ≥1GiB 但所在卡 util=0% → 空占显存");
  assert.equal(overview.notice?.title, "维护通知");
  assert.equal(overview.configGroups.length, 1);
  assert.equal(overview.configGroups[0].highErrorRate, true, "同配置星座 14 次调用 8 次失败触发限流预警");
  assert.ok(Math.abs(overview.kpis.totalTodayCostUsd - 2.1) < 1e-6);
});

