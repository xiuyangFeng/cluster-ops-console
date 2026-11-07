import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { COMPONENT_ENTRIES, listImportClosure } from "./component-version.mjs";
import { ConfigValidationError } from "./config-loader.mjs";
import { backupPersonalConfig, listPersonalBackups, PERSONAL_BACKUP_DIR, PERSONAL_BACKUP_KEEP, personalBackupDir, sortBackupNames } from "./personal-config-backup.mjs";
import { writePersonalConfig } from "./personal-config-write.mjs";

const APP_ROOT = path.resolve(import.meta.dirname, "../../..");
const posix = process.platform !== "win32";
const T0 = Date.UTC(2026, 9, 14, 1, 5, 7); // 北京时间 09:05:07

function sandbox(t, initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-personal-backup-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  if (initial !== undefined) fs.writeFileSync(localConfigPath, typeof initial === "string" ? initial : JSON.stringify(initial));
  return { dir, localConfigPath, backups: () => (fs.existsSync(path.join(dir, PERSONAL_BACKUP_DIR)) ? fs.readdirSync(path.join(dir, PERSONAL_BACKUP_DIR)).sort() : []) };
}

test("备份放在个人配置旁边的 config-backups/，名字带北京时间，按名字排就是时间顺序", () => {
  assert.equal(personalBackupDir("/data/config.local.json"), path.join("/data", PERSONAL_BACKUP_DIR));
  assert.deepEqual(sortBackupNames("/d/config.local.json", [
    "config.local.20261014-090507-2.json",
    "config.local.20261013-235959.json",
    "config.local.20261014-090507.json",
    "config.local.json",
    "other.20261014-090507.json",
    "config.local.2026.json",
  ]), ["config.local.20261013-235959.json", "config.local.20261014-090507.json", "config.local.20261014-090507-2.json"]);
});

test("backupPersonalConfig：文件不存在不备份；内容与最新一份相同不重复备份；最多留 5 份、旧的先删；0600 / 目录 0700", (t) => {
  const { localConfigPath, backups } = sandbox(t);
  assert.equal(backupPersonalConfig(localConfigPath, { now: () => T0 }), null, "第一次保存：没有可备份的");

  let clock = T0;
  for (let i = 0; i < 7; i += 1) {
    fs.writeFileSync(localConfigPath, JSON.stringify({ revision: i }));
    const made = backupPersonalConfig(localConfigPath, { now: () => clock });
    assert.ok(made, `第 ${i + 1} 份`);
    assert.equal(backupPersonalConfig(localConfigPath, { now: () => clock + 500 }), null, "内容没变：不再备份");
    clock += 1000;
  }
  const names = backups();
  assert.equal(names.length, PERSONAL_BACKUP_KEEP);
  assert.deepEqual(names, [
    "config.local.20261014-090509.json",
    "config.local.20261014-090510.json",
    "config.local.20261014-090511.json",
    "config.local.20261014-090512.json",
    "config.local.20261014-090513.json",
  ]);
  const listed = listPersonalBackups(localConfigPath);
  assert.equal(listed[0].name, "config.local.20261014-090513.json", "新的在前");
  assert.equal(JSON.parse(fs.readFileSync(listed[0].path, "utf8")).revision, 6);
  if (posix) {
    assert.equal(fs.statSync(listed[0].path).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(listed[0].path)).mode & 0o777, 0o700);
  }
});

test("backupPersonalConfig：同一秒两次不同内容各留一份；失败（目录被占成文件）不抛、返回 null 并记警告", (t) => {
  const { dir, localConfigPath, backups } = sandbox(t, { revision: 1 });
  backupPersonalConfig(localConfigPath, { now: () => T0 });
  fs.writeFileSync(localConfigPath, JSON.stringify({ revision: 2 }));
  backupPersonalConfig(localConfigPath, { now: () => T0 });
  assert.deepEqual(backups(), ["config.local.20261014-090507-2.json", "config.local.20261014-090507.json"]);
  assert.equal(listPersonalBackups(localConfigPath)[0].name, "config.local.20261014-090507-2.json");

  fs.rmSync(path.join(dir, PERSONAL_BACKUP_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, PERSONAL_BACKUP_DIR), "not a dir");
  const logs = [];
  assert.equal(backupPersonalConfig(localConfigPath, { now: () => T0, log: (_m, f) => logs.push(f) }), null);
  assert.equal(logs[0]?.event, "personal-config-backup");
});

test("backupPersonalConfig：注入的假 fs 缺方法时直接不备份，绝不退回真实磁盘", () => {
  const files = { "/fake/config.local.json": "{}" };
  const fakeFs = { readFileSync: (file) => files[file], readdirSync: () => [] };
  assert.equal(backupPersonalConfig("/fake/config.local.json", { fs: fakeFs }), null);
  assert.equal(fs.existsSync(path.join("/fake", PERSONAL_BACKUP_DIR)), false);
});

test("writePersonalConfig（控制面入口）：成功的保存在写盘前留一份带时间戳的备份；被拒绝的保存不留；单个 .bak 照旧", (t) => {
  const { dir, localConfigPath, backups } = sandbox(t, { sshUser: "amy", revision: 1 });
  writePersonalConfig({ localConfigPath, patch: { sshUser: "bob" }, expectedRevision: 1 });
  assert.equal(backups().length, 1);
  const first = listPersonalBackups(localConfigPath)[0];
  assert.equal(JSON.parse(fs.readFileSync(first.path, "utf8")).sshUser, "amy", "备份是写入之前的内容");
  assert.equal(JSON.parse(fs.readFileSync(`${localConfigPath}.bak`, "utf8")).sshUser, "amy", "config-loader 的 .bak 照旧");

  assert.throws(() => writePersonalConfig({ localConfigPath, patch: { sshUser: "carol" }, expectedRevision: 1 }), (err) => err instanceof ConfigValidationError && err.status === 409);
  assert.throws(() => writePersonalConfig({ localConfigPath, patch: { portOverrides: { "server-01": { remotePort: "x" } } } }), ConfigValidationError);
  assert.equal(backups().length, 1, "被拒绝的保存不留备份");

  writePersonalConfig({ localConfigPath, patch: { noProxyExtra: { "server-01": ["10.0.0.5"] } } });
  assert.equal(backups().length, 2);
  assert.equal(JSON.parse(fs.readFileSync(listPersonalBackups(localConfigPath)[0].path, "utf8")).sshUser, "bob", "备份读的是盘上的真实文件，不是垫进去的快照");
  assert.ok(fs.readdirSync(dir).includes("config.local.json.bak"));
});

test("数据面闭包守卫：备份逻辑只在控制面，不进 supervisor / 代理的指纹闭包", async () => {
  for (const entry of Object.values(COMPONENT_ENTRIES)) {
    const closure = await listImportClosure(APP_ROOT, entry);
    assert.ok(!closure.includes("work/monitor/lib/personal-config-backup.mjs"));
    assert.ok(!closure.includes("work/monitor/lib/corrupt-archive.mjs"));
  }
});
