import assert from "node:assert/strict";
import test from "node:test";

import { agentDisplayName, serverShortName, shortServerName } from "./display-names.js";
import { shortServerName as reexported } from "./render/tunnel-stability-model.js";

const status = {
  serversBrief: {
    "server-01": { name: "myserver", displayName: "主集群服务器 (myserver)" },
    "server-aliyun": { name: "vpn-aliyun", displayName: "阿里云服务器 (vpn-aliyun)" },
    "server-bare": { name: "box" },
  },
  agents: [{ id: "codex", name: "Codex" }, { id: "claude-codewing", name: "Claude CodeWing" }, { id: "broken" }],
};

test("shortServerName: 去掉括号里的主机名与末尾的「服务器」，去完为空时保留原文", () => {
  assert.equal(shortServerName("主集群服务器 (myserver)"), "主集群");
  assert.equal(shortServerName("阿里云服务器"), "阿里云");
  assert.equal(shortServerName("lab-box"), "lab-box");
  assert.equal(shortServerName("服务器"), "服务器");
  assert.equal(shortServerName(null), "");
});

test("serverShortName: 按 id 取显示名的短名；没有 displayName 用主机别名；查不到返回 id", () => {
  assert.equal(serverShortName(status, "server-01"), "主集群");
  assert.equal(serverShortName(status, "server-aliyun"), "阿里云");
  assert.equal(serverShortName(status, "server-bare"), "box");
  assert.equal(serverShortName(status, "server-gone"), "server-gone");
  assert.equal(serverShortName(null, "server-01"), "server-01");
  assert.equal(serverShortName(status, null), "");
});

test("agentDisplayName: 取 agents[].name；缺名字或查不到时返回 id", () => {
  assert.equal(agentDisplayName(status, "claude-codewing"), "Claude CodeWing");
  assert.equal(agentDisplayName(status, "codex"), "Codex");
  assert.equal(agentDisplayName(status, "broken"), "broken");
  assert.equal(agentDisplayName(status, "zcode"), "zcode");
  assert.equal(agentDisplayName({}, "codex"), "codex");
});

test("tunnel-stability-model 仍导出 shortServerName（同一实现，不是另一份）", () => {
  assert.equal(reexported, shortServerName);
});
