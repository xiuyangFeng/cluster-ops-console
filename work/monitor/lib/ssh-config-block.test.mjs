import assert from "node:assert/strict";
import test from "node:test";

import { findSshHostSection, MANAGED_HOST_COMMENT, upsertSshConfigBlock } from "./ssh-config-block.mjs";

test("findSshHostSection：读出别名段的各字段；区分本工具写的段与用户手写的段", () => {
  const own = "Host bastion\n  HostName b.example\n\nHost myserver\n  HostName 10.0.0.8\n  User amy\n  Port 2222\n  IdentityFile \"~/.ssh/my key\"\n  ProxyJump bastion\n\nHost *\n  ServerAliveInterval 30\n";
  const found = findSshHostSection(own, "myserver");
  assert.deepEqual({ ...found, text: undefined }, { text: undefined, managed: false, hostName: "10.0.0.8", user: "amy", port: 2222, identityFile: "~/.ssh/my key" });
  assert.equal(found.text, "Host myserver\n  HostName 10.0.0.8\n  User amy\n  Port 2222\n  IdentityFile \"~/.ssh/my key\"\n  ProxyJump bastion");

  const written = upsertSshConfigBlock("", { hostAlias: "myserver", hostName: "10.0.0.8", port: 22, user: "amy", identityFile: "~/.ssh/id_ed25519_codextunnel" });
  assert.ok(written.startsWith(MANAGED_HOST_COMMENT));
  assert.deepEqual({ ...findSshHostSection(written, "myserver"), text: undefined }, { text: undefined, managed: true, hostName: "10.0.0.8", user: "amy", port: 22, identityFile: "~/.ssh/id_ed25519_codextunnel" });
});

test("findSshHostSection：没有这个别名 / 只在多别名行或通配里出现 → null；缺的字段给空值", () => {
  assert.equal(findSshHostSection("", "myserver"), null);
  assert.equal(findSshHostSection("Host other\n  User amy\n", "myserver"), null);
  assert.equal(findSshHostSection("Host *\n  User amy\n", "myserver"), null);
  assert.deepEqual(findSshHostSection("Host myserver\n", "myserver"), { text: "Host myserver", managed: false, hostName: "", user: "", port: null, identityFile: "" });
});
