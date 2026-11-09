import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminKillPortCommand,
  buildAdminReleasePortCommand,
  buildAdminSurveyCommand,
  buildHubAdminInitCommand,
  buildMemberSyncReadCommand,
  buildMemberSyncWriteCommand,
  buildRootGrantScript,
  buildWriteAssignedCommand,
  buildWriteRosterCommand,
  isAdminUser,
  isSafeClusterUser,
  normalizeRosterObject,
  parseAdminSurveyOutput,
  parseMemberSyncReadOutput,
  resolveAgentHubBaseDir,
  resolveEffectiveSshUser,
} from "./protocol.mjs";

test("resolveAgentHubBaseDir 与 resolveEffectiveSshUser / isAdminUser：正确解析目录、生效用户名与管理员权限", () => {
  assert.equal(resolveAgentHubBaseDir({ portRegistry: { dir: "/public/agent-hub/ports" } }), "/public/agent-hub");
  assert.equal(resolveAgentHubBaseDir({ portRegistry: { dir: "/data/cwb/ports" } }), "/data/cwb");
  assert.equal(resolveAgentHubBaseDir({}), "/public/agent-hub");

  const config = {
    activeServerId: "server-01",
    adminUsers: ["kai"],
    servers: [{ id: "server-01", host: "myserver" }],
  };
  const sshUser = resolveEffectiveSshUser(config, null, { resolveSshUser: (h) => (h === "myserver" ? "kai" : "") });
  assert.equal(sshUser, "kai");
  assert.equal(isAdminUser(config, sshUser), true);
  assert.equal(isAdminUser(config, "zhangsan"), false);
  assert.equal(isAdminUser({ adminUsers: [] }, "root"), true);
  assert.equal(isAdminUser({}, " root "), true);
  assert.equal(isAdminUser({}, "ROOT"), false);
  assert.equal(isAdminUser({}, "root-admin"), false);
  assert.equal(isAdminUser({}, ""), false);
  assert.doesNotMatch(buildHubAdminInitCommand("/shared/hub", "root"), /sudo/);
  assert.equal(resolveEffectiveSshUser({ sshUser: "root" }, { host: "h", sshUser: "lin" }), "lin");
  assert.equal(isSafeClusterUser("kai"), true);
  assert.equal(isSafeClusterUser("-bad"), false);
  assert.equal(isSafeClusterUser("a/b"), false);
});

test("parseAdminSurveyOutput：完整解析名册、端口、监听、公钥、下发信封、心跳、冒牌文件、SSH 在线与 Agent 进程", () => {
  const sample = [
    "ME=kai",
    "NOW=1792118400",
    "HUB_BASE=ok",
    "HUB_OWNER=kai",
    "SUDO_READY=1",
    "DIR\tadmin\tok\tkai",
    "DIR\tassigned\tok\tkai",
    "DIR\tports\tok\tkai",
    "DIR\tpubkeys\tok\tkai",
    "DIR\theartbeats\tok\tkai",
    "ROSTER-BEGIN",
    JSON.stringify({
      v: 1,
      updatedAt: "2026-10-16T10:00:00Z",
      updatedBy: "kai",
      members: {
        kai: { displayName: "管理员 (我)", assignedPort: 7891, enabled: true },
        alice: { displayName: "张同学", assignedPort: 7892, enabled: true, note: "A100 课题组" },
      },
    }),
    "ROSTER-END",
    "PORTS-BEGIN",
    "REG\t7891\tkai\tf\t2026-10-01T00:00:00Z",
    "REG\t7892\talice\tf\t2026-10-02T00:00:00Z",
    "PORTS-END",
    "LISTEN-BEGIN",
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port",
    "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*",
    "LISTEN-END",
    "PUBKEYS-BEGIN",
    "PUB\talice\tMCowBQYDK2VuAyEA1111111111111111111111111111111111111111111",
    "SPOOF\tpubkeys/bob.pub\tmalory\tcleaned",
    "PUBKEYS-END",
    "ASSIGNED-BEGIN",
    `ENC\talice\t${JSON.stringify({ v: 1, rev: 2, assignedAt: "2026-10-16T09:00:00Z", summary: { codex: { mode: "relay", keyMask: "sk-1…2345" } } })}`,
    "ASSIGNED-END",
    "HEARTBEATS-BEGIN",
    `HB\talice\t${JSON.stringify({ v: 1, user: "alice", updatedAt: 1792118300000, clientVersion: "2.67.0", channel: "stable", usage: { todayTokens: 125000, todayCalls: 18 } })}`,
    "HEARTBEATS-END",
    "WHO-BEGIN",
    "kai",
    "alice",
    "WHO-END",
    "AGENTS-BEGIN",
    "alice\tcodex\t2",
    "kai\tclaude\t1",
    "AGENTS-END",
    "ROOTSCAN-BEGIN",
    "ROOTSCAN\tbob\t8589934592\t16\t45000\t80\t320000\t1\t0",
    "ROOTSCAN-END",
  ].join("\n");

  const parsed = parseAdminSurveyOutput(sample);
  assert.equal(parsed.me, "kai");
  assert.equal(parsed.nowSec, 1792118400);
  assert.equal(parsed.hubBase, "ok");
  assert.equal(parsed.sudoReady, true);
  assert.equal(parsed.roster.members.alice.displayName, "张同学");
  assert.equal(parsed.roster.members.alice.assignedPort, 7892);
  assert.equal(parsed.ports.length, 2);
  assert.equal(parsed.listening.includes(7891), true);
  assert.equal(parsed.listening.includes(7892), false);
  assert.ok(parsed.pubkeys.alice);
  assert.equal(parsed.spoofs.length, 1);
  assert.equal(parsed.spoofs[0].file, "pubkeys/bob.pub");
  assert.equal(parsed.assigned.alice.rev, 2);
  assert.equal(parsed.heartbeats.alice.usage.todayTokens, 125000);
  assert.deepEqual(parsed.sshUsers, ["kai", "alice"]);
  assert.deepEqual(parsed.agentProcs.alice, { codex: 2 });
  assert.equal(parsed.rootScans.bob.homeDirBytes, 8589934592);
  assert.equal(parsed.rootScans.bob.todayTokens, 45000);
  assert.equal(parsed.rootScans.bob.todayCalls, 16);
  assert.equal(parsed.rootScans.bob.codexInstalled, true);
});

test("parseMemberSyncReadOutput 与远端命令构造：校验参数并正确解析成员侧数据", () => {
  const out = parseMemberSyncReadOutput([
    "ME=alice",
    "HUB=present",
    "BOX_KEY=privKeyBase64UrlString12345678901234567890123456",
    "PUB_KEY=pubKeyBase64UrlString12345678901234567890123456",
    "ROSTER-BEGIN",
    JSON.stringify({ v: 1, members: { alice: { assignedPort: 7892, enabled: true } } }),
    "ROSTER-END",
    "ASSIGNED-BEGIN",
    JSON.stringify({ v: 1, rev: 5, assignedAt: "2026-10-16T10:00:00Z" }),
    "ASSIGNED-END",
  ].join("\n"));

  assert.equal(out.me, "alice");
  assert.equal(out.hub, "present");
  assert.equal(out.roster.members.alice.assignedPort, 7892);
  assert.equal(out.assignedEnvelope.rev, 5);

  assert.match(buildHubAdminInitCommand("/public/agent-hub", "kai"), /sudo install -d -o kai -m 1777/);
  assert.match(buildRootGrantScript("/public/agent-hub", "kai"), /codex-team-admin-helper/);
  assert.match(buildAdminSurveyCommand("/public/agent-hub"), /ROSTER-BEGIN/);
  assert.match(buildWriteRosterCommand("/public/agent-hub"), /WRITE_ROSTER=ok/);
  assert.match(buildWriteAssignedCommand("/public/agent-hub", "alice"), /WRITE_ASSIGNED=ok/);
  assert.match(buildAdminReleasePortCommand("/public/agent-hub", 7892), /RELEASE=ok/);
  assert.match(buildAdminKillPortCommand("/public/agent-hub", 7892), /kill-port/);
  assert.match(buildMemberSyncReadCommand("/public/agent-hub"), /ASSIGNED-BEGIN/);
  assert.match(
    buildMemberSyncWriteCommand("/public/agent-hub", {
      privateKey: "a".repeat(64),
      publicKey: "b".repeat(59),
    }),
    /HB_WRITE=ok/,
  );
  assert.throws(() => buildWriteAssignedCommand("/public/agent-hub", "../evil"));
});

test("normalizeRosterObject：畸形输入回落空名册", () => {
  assert.deepEqual(normalizeRosterObject(null), { v: 1, updatedAt: null, updatedBy: null, members: {} });
  assert.deepEqual(normalizeRosterObject([]), { v: 1, updatedAt: null, updatedBy: null, members: {} });
});
