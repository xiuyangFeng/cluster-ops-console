import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { generateMemberKeyPair, openAssignedEnvelope, sealAssignedPayload } from "./crypto-box.mjs";
import { createTeamMemberSync, extractCliForHeartbeat, extractDiskForHeartbeat, extractUsageForHeartbeat } from "./member-sync.mjs";
import { createTeamAdminService } from "./service.mjs";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "team-admin-svc-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

test("member-sync 纯函数提取：usage / cli / disk 字段与 model.mjs 完全对齐", () => {
  const usage = extractUsageForHeartbeat({
    today: "2026-10-16",
    kpis: { total: 500_000, calls: 25, errors: 1 },
    trend: {
      buckets: [
        { key: "2026-10-15", codex: 200_000, claude: 100_000, calls: 15, errors: 0 },
        { key: "2026-10-16", codex: 120_000, claude: 80_000, calls: 10, errors: 1 },
      ],
    },
    sessions: [
      { model: "gpt-5.4", stats: { total: 320_000 }, lastAt: 1_760_000_000 },
      { model: "claude-sonnet-4-6", stats: { total: 180_000 }, lastAt: 1_760_000_500 },
    ],
  });
  assert.deepEqual(usage, {
    todayCalls: 10,
    todayTokens: 200_000,
    todayErrors: 1,
    todayCostUsd: 0,
    weekCalls: 25,
    weekTokens: 500_000,
    weekErrors: 1,
    weekCostUsd: 0,
    codexTokens7d: 320_000,
    claudeTokens7d: 180_000,
    topModel: "gpt-5.4",
    lastActiveAt: 1_760_000_500_000,
  });

  const cli = extractCliForHeartbeat({
    clis: {
      codex: { installed: true, version: "0.42.0", login: "relay", loginDetail: "team-relay" },
      claude: { installed: false, version: null, login: null, loginDetail: null },
    },
  });
  assert.deepEqual(cli, {
    codex: { installed: true, version: "0.42.0", login: "relay", loginDetail: "team-relay" },
    claude: { installed: false, version: null, login: null, loginDetail: null },
  });

  const disk = extractDiskForHeartbeat({ filesystem: { usedKb: 2048, capacityPct: 32 } }, 1024 * 1024);
  assert.deepEqual(disk, {
    scannedDirBytes: 1024 * 1024,
    homeUsedKb: 2048,
    homeCapacityPct: 32,
  });
});

test("member-sync：首次同步生成密钥对，收到加密信封自动解密应用并上报心跳", async () => {
  await withTempDir(async (dir) => {
    const aliceKeys = generateMemberKeyPair();
    const envelope = sealAssignedPayload(
      {
        codex: {
          mode: "official",
          apiKey: "EXAMPLE_codex_key_1234",
        },
      },
      aliceKeys.publicKey,
      { rev: 3, assignedAt: "2026-10-16T02:00:00.000Z" },
    );

    const remoteCalls = [];
    const sync = createTeamMemberSync({
      getConfig: async () => ({
        servers: [{ id: "server-01", host: "myserver", remotePort: 7892 }],
      }),
      runRemote: async (_server, _config, command, opts = {}) => {
        remoteCalls.push({ command, input: opts.input || null });
        if (command.includes("ASSIGNED-BEGIN")) {
          return {
            code: 0,
            stdout: [
              "ME=alice",
              "HUB=present",
              `BOX_KEY=${aliceKeys.privateKey}`,
              `PUB_KEY=${aliceKeys.publicKey}`,
              "ROSTER-BEGIN",
              "{\"v\":1,\"members\":{}}",
              "ROSTER-END",
              "ASSIGNED-BEGIN",
              JSON.stringify(envelope),
              "ASSIGNED-END",
            ].join("\n"),
          };
        }
        if (command.includes("__CWB_CLI__=")) {
          return { code: 0, stdout: "__CWB_ENV__=1\n__CWB_CLI__=1\n__CWB_FILE__=-\n" };
        }
        if (command.includes("codex login --with-api-key")) {
          assert.equal(opts.input, "EXAMPLE_codex_key_1234\n");
          return { code: 0, stdout: "Logged in" };
        }
        if (command.includes("codex login status")) {
          return { code: 0, stdout: "Logged in using an API key\n__CWB_EXIT__=0\n" };
        }
        if (command.includes("HB_WRITE=ok")) {
          return { code: 0, stdout: "HB_WRITE=ok\n" };
        }
        return { code: 0, stdout: "" };
      },
      getStatus: () => ({ overall: "healthy" }),
      getLayers: () => ({ resources: { "server-01": { filesystem: { usedKb: 4096, capacityPct: 12 } } } }),
      version: "2.67.0",
      statePath: path.join(dir, "member-state.json"),
      now: () => 1_760_000_000_000,
    });

    const out = await sync.syncNow();
    assert.equal(out.ok, true);
    assert.equal(out.results["server-01"].ok, true);
    assert.equal(out.results["server-01"].ack.rev, 3);
    assert.equal(out.results["server-01"].ack.status, "applied");

    const hbWriteCall = remoteCalls.find((c) => c.command.includes("HB_WRITE=ok"));
    assert.ok(hbWriteCall, "应发送心跳写入命令");
    const hbPayload = JSON.parse(hbWriteCall.input);
    assert.equal(hbPayload.user, "alice");
    assert.equal(hbPayload.clientVersion, "2.67.0");
    assert.equal(hbPayload.assignedAck.rev, 3);
    assert.equal(hbPayload.assignedAck.status, "applied");
  });
});

test("team-admin service：权限门禁、名册维护、无公钥暂存与公钥就绪后自动加密投递", async () => {
  await withTempDir(async (dir) => {
    const bobKeys = generateMemberKeyPair();
    let clusterRoster = { v: 1, members: { kai: { displayName: "管理员", assignedPort: 7891 } } };
    let clusterPubkeys = {};
    const clusterAssigned = {};

    const buildSurveyStdout = () => {
      const lines = [
        "ME=kai",
        "NOW=1760000000",
        "HUB_BASE=ok",
        "HUB_OWNER=kai",
        "DIR\tadmin\tok\t0",
        "DIR\tassigned\tok\t0",
        "DIR\tports\tok\t1",
        "DIR\tpubkeys\tok\t1",
        "DIR\theartbeats\tok\t1",
        "ROSTER-BEGIN",
        JSON.stringify(clusterRoster),
        "ROSTER-END",
        "PORTS-BEGIN",
        "REG\t7891\tkai\tf",
        "PORTS-END",
        "LISTEN-BEGIN",
        "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*",
        "LISTEN-END",
        "PUBKEYS-BEGIN",
        ...Object.entries(clusterPubkeys).map(([u, k]) => `PUB\t${u}\t${k}`),
        "PUBKEYS-END",
        "ASSIGNED-BEGIN",
        ...Object.entries(clusterAssigned).map(([u, enc]) => `ENC\t${u}\t${JSON.stringify(enc)}`),
        "ASSIGNED-END",
        "HEARTBEATS-BEGIN",
        "HEARTBEATS-END",
        "SPOOF-BEGIN",
        "SPOOF-END",
        "WHO-BEGIN",
        "kai",
        "WHO-END",
        "PROCS-BEGIN",
        "PROC\tkai\tcodex",
        "PROCS-END",
      ];
      return lines.join("\n");
    };

    let currentUser = "kai";
    const service = createTeamAdminService({
      getConfig: async () => ({
        activeServerId: "server-01",
        adminUsers: ["kai"],
        servers: [{ id: "server-01", name: "主集群", host: "myserver", sshUser: currentUser }],
      }),
      getMergedConfig: () => ({
        activeServerId: "server-01",
        adminUsers: ["kai"],
        servers: [{ id: "server-01", name: "主集群", host: "myserver", sshUser: currentUser }],
      }),
      runRemote: async (_server, _config, command, opts = {}) => {
        if (command.includes("WRITE_ROSTER=ok")) {
          clusterRoster = JSON.parse(opts.input);
          return { code: 0, stdout: "WRITE_ROSTER=ok\n" };
        }
        if (command.includes("WRITE_ASSIGNED=ok")) {
          const m = /u='\\''([A-Za-z0-9._-]+)'\\''/.exec(command);
          clusterAssigned[m[1]] = JSON.parse(opts.input);
          return { code: 0, stdout: "WRITE_ASSIGNED=ok\n" };
        }
        return { code: 0, stdout: buildSurveyStdout() };
      },
      pendingPath: path.join(dir, "pending.json"),
      version: "2.67.0",
      now: () => 1_760_000_000_000,
    });

    // 1. 管理员角色检查
    assert.equal(service.getAdminRole().isAdmin, true);
    currentUser = "bob";
    assert.equal(service.getAdminRole().isAdmin, false);
    await assert.rejects(() => service.getOverview(), /不在团队管理员名单/);
    currentUser = "root";
    assert.equal(service.getAdminRole({ activeServerId: "s", adminUsers: [], servers: [{ id: "s", host: "cluster", sshUser: "root" }] }).isAdmin, true);
    await service.getOverview();
    currentUser = "kai";

    // 2. 添加新成员 bob 并预分配端口 7892
    const afterUpsert = await service.upsertMember({
      user: "bob",
      displayName: "Bob 同学",
      note: "NLP 组",
      assignedPort: 7892,
    });
    const bobRow1 = afterUpsert.members.find((m) => m.user === "bob");
    assert.ok(bobRow1);
    assert.equal(bobRow1.displayName, "Bob 同学");
    assert.equal(bobRow1.assignedPort, 7892);

    // 3. 给尚未上报公钥的 bob 下发中转站配置 -> 进入本机暂存队列 (pending-pubkey)
    const assign1 = await service.assignAiConfig({
      user: "bob",
      codex: {
        mode: "relay",
        baseUrl: "https://relay.example.com/v1",
        providerId: "team-relay",
        apiKey: "key-team-demo-bob-001",
      },
    });
    assert.equal(assign1.delivery, "pending-pubkey");
    const bobRow2 = assign1.overview.members.find((m) => m.user === "bob");
    assert.equal(bobRow2.assignment.state, "pending-pubkey");

    // 4. 当 bob 首次启动工作台把公钥发布到 pubkeys/bob.pub 后，管理员刷新大盘自动完成加密投递！
    clusterPubkeys = { bob: bobKeys.publicKey };
    const overviewAfterPub = await service.getOverview({ force: true });
    const bobRow3 = overviewAfterPub.members.find((m) => m.user === "bob");
    assert.equal(bobRow3.assignment.state, "pending-sync");
    assert.ok(clusterAssigned.bob, "集群上应已生成加密信封 assigned/bob.enc");

    // 验证 bob 用自己的私钥能成功解开自动投递的信封
    const opened = openAssignedEnvelope(clusterAssigned.bob, bobKeys.privateKey);
    assert.equal(opened.codex.mode, "relay");
    assert.equal(opened.codex.apiKey, "key-team-demo-bob-001");
    assert.equal(opened.codex.baseUrl, "https://relay.example.com/v1");

    // 5. 批量纳管多位成员（members 数组）与端口冲突拦截
    const batchOut = await service.upsertMember({
      members: [
        { user: "charlie", displayName: "Charlie", assignedPort: 7893 },
        { user: "dave", displayName: "Dave", assignedPort: 7894 },
      ],
    });
    assert.equal(batchOut.members.find((m) => m.user === "charlie")?.assignedPort, 7893);
    assert.equal(batchOut.members.find((m) => m.user === "dave")?.assignedPort, 7894);

    await assert.rejects(
      () =>
        service.upsertMember({
          members: [{ user: "erin", assignedPort: 7893 }],
        }),
      /端口 7893 已在名册中预分配给 charlie/,
    );

    // 6. 批量上限：超过 32 位必须显式报错，而不是静默只写前 32 位（前端会据此如实报数）
    const tooMany = Array.from({ length: 33 }, (_, i) => ({ user: `bulk${i}`, assignedPort: 8000 + i }));
    const rosterBefore = JSON.stringify(clusterRoster);
    await assert.rejects(() => service.upsertMember({ members: tooMany }), /单次最多批量纳管 32 位成员/);
    assert.equal(JSON.stringify(clusterRoster), rosterBefore, "被拒的批量请求不得改动名册");

    // 7. 批内重复账号必须报错，不能静默丢弃后一条
    await assert.rejects(() => service.upsertMember({ members: [{ user: "dup" }, { user: "dup", assignedPort: 8210 }] }), /重复出现/);

    // 8. 「A 沿用名册旧端口 + B 显式抢同一端口」必须被拦住。
    //    旧实现会漏：A 没带端口所以不进 seenPorts，B 又因为 A 在批内而被 seenUsers 豁免。
    await service.upsertMember({ members: [{ user: "keeper", assignedPort: 8300 }] });
    const beforeClash = JSON.stringify(clusterRoster);
    await assert.rejects(
      () => service.upsertMember({ members: [{ user: "keeper" }, { user: "taker", assignedPort: 8300 }] }),
      /端口 8300 已在名册中预分配/,
    );
    assert.equal(JSON.stringify(clusterRoster), beforeClash, "端口冲突被拒后名册必须保持原样");

    // 9. 省略字段 = 保留原值；显式 null = 清空（两种语义都可达成）
    const kept = await service.upsertMember({ members: [{ user: "keeper", note: "A100 课题组" }] });
    const keeperAfter = kept.members.find((m) => m.user === "keeper");
    assert.equal(keeperAfter?.note, "A100 课题组");
    assert.equal(keeperAfter?.assignedPort, 8300, "批量项没带端口时应沿用名册里的旧端口");
    const keptAgain = await service.upsertMember({ members: [{ user: "keeper" }] });
    assert.equal(keptAgain.members.find((m) => m.user === "keeper")?.note, "A100 课题组", "省略 note 不得清空");
    await service.upsertMember({ members: [{ user: "keeper", assignedPort: null }] });
    assert.equal(clusterRoster.members.keeper.assignedPort, null, "显式 null 才清空端口");

    // 10. 省略 enabled 时必须保留原值，不得把已停用成员重新启用
    await service.upsertMember({ members: [{ user: "keeper", enabled: false }] });
    await service.upsertMember({ members: [{ user: "keeper" }] });
    assert.equal(clusterRoster.members.keeper.enabled, false, "省略 enabled 应保留停用状态");

    // 11. 集群登记冲突：kai 的预分配端口清掉后，7891 分给他人必须被集群登记拦住
    await service.upsertMember({ members: [{ user: "kai", assignedPort: null }] });
    await assert.rejects(() => service.upsertMember({ members: [{ user: "ghost", assignedPort: 7891 }] }), /已被 kai 在集群登记占用/);
    await service.upsertMember({ members: [{ user: "kai", assignedPort: 7891 }] });
  });
});

test("team-admin service：概览的集群采集过期后先回旧数据、后台再采；同时只跑一次；强制刷新现等", async () => {
  await withTempDir(async (dir) => {
    let clock = 1_800_000_000_000;
    let surveys = 0;
    let release = null;
    let me = "kai";
    const config = { activeServerId: "server-01", adminUsers: ["kai"], servers: [{ id: "server-01", name: "主集群", host: "myserver", sshUser: "kai" }] };
    const stdout = () => ["ME=" + me, "NOW=1760000000", "HUB_BASE=ok", "HUB_OWNER=kai", "ROSTER-BEGIN", JSON.stringify({ v: 1, members: { kai: {} } }), "ROSTER-END"].join("\n");
    const service = createTeamAdminService({
      getConfig: async () => config,
      getMergedConfig: () => config,
      runRemote: async () => {
        surveys += 1;
        if (release === "hold") await new Promise((r) => { release = r; });
        return { code: 0, stdout: stdout() };
      },
      pendingPath: path.join(dir, "pending.json"),
      version: "2.69.0",
      now: () => clock,
    });
    const first = await service.getOverview({ serverId: "server-01" });
    assert.equal(surveys, 1);
    assert.equal(first.checkedAt, clock);

    clock += 5_000; // 新鲜期内：不采
    await service.getOverview({ serverId: "server-01" });
    assert.equal(surveys, 1);

    clock += 20_000; // 过期但不太旧：立刻回旧数据（checkedAt 是旧的采集时间），后台再采
    const t0 = clock - 25_000;
    release = "hold";
    const stale = await service.getOverview({ serverId: "server-01" });
    assert.equal(stale.checkedAt, t0, "先回旧数据，更新时间如实写旧的");
    assert.equal(surveys, 2, "后台已经起了一次采集");
    await service.getOverview({ serverId: "server-01" });
    assert.equal(surveys, 2, "后台采集还没结束：不再起第二次");
    me = "kai";
    release();
    release = null;
    await new Promise((r) => setImmediate(r));
    const fresh = await service.getOverview({ serverId: "server-01" });
    assert.equal(fresh.checkedAt, clock, "后台采完，下一次拿到新的");

    clock += 6 * 60_000; // 太旧：现等
    await service.getOverview({ serverId: "server-01" });
    assert.equal(surveys, 3);
    await service.getOverview({ serverId: "server-01", force: true });
    assert.equal(surveys, 4, "强制刷新总是现采");
  });
});
