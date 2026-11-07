// config.public.json 是公开版的默认配置：scripts/export-public.mjs 导出公开快照时用它替换 config.json
// （公开快照里两份内容相同）。这里守住两件事：不带任何部署信息；除部署信息外与团队配置保持同步。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mergeConfig } from "../work/monitor/lib/config-loader.mjs";
import { assessSetup, TEAM_PRIMARY_SERVER_ID } from "../work/monitor/lib/onboarding.mjs";
import { isPrivateOrDocIp } from "./release-scan.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(readFileSync(path.join(rootDir, name), "utf8"));
const pub = readJson("config.public.json");
const team = readJson("config.json");

test("公开版配置不带部署信息：无地址、无管理员、无强制端口登记、无公网 IP", () => {
  const text = JSON.stringify(pub);
  assert.deepEqual(pub.adminUsers, []);
  assert.equal(pub.portRegistry, undefined, "端口登记目录是团队约定，公开版不要求");
  for (const server of pub.servers) {
    assert.equal(server.sshHostName, undefined, `${server.id} 不能预填地址`);
    assert.equal(server.sshUser, undefined, `${server.id} 不能预填账号`);
    assert.equal(server.remotePort, undefined, `${server.id} 的反向端口由引导领取`);
  }
  const ips = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [];
  assert.deepEqual(ips.filter((ip) => !isPrivateOrDocIp(ip)), []);
});

test("公开版配置有引导要接的那台主服务器，且地址留给用户填", () => {
  const primary = pub.servers.find((s) => s.id === TEAM_PRIMARY_SERVER_ID);
  assert.ok(primary, "引导按 server-01 找要接的服务器");
  assert.equal(pub.activeServerId, TEAM_PRIMARY_SERVER_ID);
  assert.equal(assessSetup({ localState: "missing", merged: mergeConfig(pub, {}) }).state, "needs-setup");
});

test("除部署信息外与团队配置同步：Agent 列表、自动修复与探测命令一致", () => {
  if (team === pub || JSON.stringify(team) === JSON.stringify(pub)) return; // 公开快照：config.json 就是它
  assert.deepEqual(pub.agents, team.agents);
  assert.deepEqual(pub.autoRepair, team.autoRepair);
  const teamPrimary = team.servers.find((s) => s.id === TEAM_PRIMARY_SERVER_ID);
  const pubPrimary = pub.servers.find((s) => s.id === TEAM_PRIMARY_SERVER_ID);
  assert.deepEqual(pubPrimary.validationProfile, teamPrimary.validationProfile);
  assert.equal(pubPrimary.host, teamPrimary.host, "主机别名一致：~/.ssh/config 的 Host 段按它写");
});

test("合并时不产生告警", () => {
  const warnings = [];
  mergeConfig(pub, {}, { warn: (...args) => warnings.push(args.join(" ")) });
  assert.deepEqual(warnings, []);
});
