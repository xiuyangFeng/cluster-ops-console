import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pickPreferences, writePersonalPreferences } from "./preferences-store.mjs";

function tempConfig(content) {
  const path = join(mkdtempSync(join(tmpdir(), "prefs-")), "config.local.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

test("写入只改偏好字段，保留其它个人字段并递增 revision", () => {
  const path = tempConfig(JSON.stringify({ sshUser: "kai", revision: 4, servers: [{ id: "a" }] }));
  writePersonalPreferences({ localConfigPath: path, patch: { disabledModules: ["agent:zcode"] } });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.sshUser, "kai");
  assert.deepEqual(saved.servers, [{ id: "a" }]);
  assert.deepEqual(saved.disabledModules, ["agent:zcode"]);
  assert.equal(saved.revision, 5);
  assert.equal("hiddenPanels" in saved, false);
});

test("空数组照常写入（全部重新打开）；文件不存在时新建", () => {
  const path = tempConfig();
  writePersonalPreferences({ localConfigPath: path, patch: { hiddenPanels: ["view.usage"] } });
  writePersonalPreferences({ localConfigPath: path, patch: { hiddenPanels: [] } });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).hiddenPanels, []);
});

test("非法 id 整体拒绝且原文件不变；损坏的个人配置拒绝写入", () => {
  const original = JSON.stringify({ disabledModules: ["usage"] });
  const path = tempConfig(original);
  assert.throws(() => writePersonalPreferences({ localConfigPath: path, patch: { disabledModules: ["usage", "bad id"] } }));
  assert.equal(readFileSync(path, "utf8"), original);
  const broken = tempConfig("{ not json");
  assert.throws(() => writePersonalPreferences({ localConfigPath: broken, patch: { hiddenPanels: [] } }));
  assert.equal(readFileSync(broken, "utf8"), "{ not json");
});

test("pickPreferences 只认数组，缺省为空；标出旧偏好（写过偏好字段、没有 modulePrefsVersion:2）", () => {
  assert.deepEqual(pickPreferences({ disabledModules: ["usage"], hiddenPanels: "x" }),
    { disabledModules: ["usage"], enabledModules: [], hiddenPanels: [], legacyModuleDefaults: true });
  assert.deepEqual(pickPreferences(null), { disabledModules: [], enabledModules: [], hiddenPanels: [], legacyModuleDefaults: false });
  // kai 生产个人层（v2.56）：旧偏好
  assert.equal(pickPreferences({ disabledModules: ["agent:zcode"], portOverrides: {} }).legacyModuleDefaults, true);
  assert.equal(pickPreferences({ hiddenPanels: [] }).legacyModuleDefaults, true, "只动过面板也算用过旧偏好");
  // 从没碰过偏好（向导刚写的个人层）/ 新版本写过：都不是旧偏好
  assert.equal(pickPreferences({ sshUser: "simple", portOverrides: { "server-01": { remotePort: 7892 } } }).legacyModuleDefaults, false);
  assert.equal(pickPreferences({ disabledModules: [], modulePrefsVersion: 2 }).legacyModuleDefaults, false);
});

test("写入偏好一律打上 modulePrefsVersion:2；enabledModules 同样校验", () => {
  const path = tempConfig(JSON.stringify({ disabledModules: ["agent:zcode"], revision: 1 }));
  writePersonalPreferences({ localConfigPath: path, patch: { enabledModules: ["agent:claude-codewing"], hiddenPanels: [] } });
  const saved = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(saved.modulePrefsVersion, 2);
  assert.deepEqual(saved.enabledModules, ["agent:claude-codewing"]);
  assert.deepEqual(saved.disabledModules, ["agent:zcode"]);
  assert.throws(() => writePersonalPreferences({ localConfigPath: path, patch: { enabledModules: ["bad id"] } }));
});
