// 个人层写入里只属于控制面的部分（v2.57）：noProxyExtra（登录引导测通的内网中转站）的写入校验与落盘，
// 与 cluster-env.mjs 的 NO_PROXY 条目口径一致，以及"这些都不进数据面热更新指纹闭包"的守卫。
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { isNoProxyEntry, noProxyExtraFor, renderClusterEnv } from "./cluster-env.mjs";
import { COMPONENT_ENTRIES, listImportClosure } from "./component-version.mjs";
import { ConfigValidationError, mergeConfig, PERSONAL_FIELDS, writePersonalConfig as baseWritePersonalConfig } from "./config-loader.mjs";
import { NO_PROXY_EXTRA_MAX, validateNoProxyExtraForWrite, writePersonalConfig } from "./personal-config-write.mjs";

const APP_ROOT = path.resolve(import.meta.dirname, "../../..");

function sandbox(t, initial) {
  const dir = mkdtempSync(path.join(tmpdir(), "personal-write-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  if (initial !== undefined) writeFileSync(localConfigPath, typeof initial === "string" ? initial : JSON.stringify(initial));
  return { dir, localConfigPath, read: () => JSON.parse(readFileSync(localConfigPath, "utf8")), raw: () => readFileSync(localConfigPath, "utf8") };
}

// 终审：写校验原先放在 config-loader.mjs——它在 supervisor 与本地代理的 import 闭包里，一改就让两个数据面
// 组件的指纹都变，升级时多出一次代理交接。
test("数据面闭包守卫：noProxyExtra 的读、写、校验都不在 supervisor / 代理的指纹闭包里", async () => {
  for (const [name, entry] of Object.entries(COMPONENT_ENTRIES)) {
    const closure = await listImportClosure(APP_ROOT, entry);
    assert.ok(closure.includes("work/monitor/lib/config-loader.mjs"), `${name}: config-loader 在闭包里（守卫有效）`);
    for (const file of ["work/monitor/lib/personal-config-write.mjs", "work/monitor/lib/cluster-env.mjs"]) {
      assert.ok(!closure.includes(file), `${name}: ${file} 是控制面模块，不该进数据面闭包`);
    }
    const mentions = closure.filter((file) => readFileSync(path.join(APP_ROOT, file), "utf8").includes("noProxyExtra"));
    assert.deepEqual(mentions, [], `${name}: 数据面文件里不该出现 noProxyExtra`);
  }
  assert.ok(!PERSONAL_FIELDS.includes("noProxyExtra"), "不走 mergeConfig 的字段白名单");
});

test("noProxyExtra 只从个人层原始对象读：按服务器取出（形状不对按没有）；合并后的运行配置里没有它", () => {
  const personal = { noProxyExtra: { "server-01": ["10.0.0.5"] } };
  assert.deepEqual(noProxyExtraFor(personal, "server-01"), ["10.0.0.5"]);
  assert.deepEqual(noProxyExtraFor(personal, "server-02"), []);
  assert.deepEqual(noProxyExtraFor({ noProxyExtra: ["10.0.0.5"] }, "server-01"), []);
  assert.deepEqual(noProxyExtraFor({ noProxyExtra: { "server-01": ["ok.lab", "bad,entry", 3] } }, "server-01"), ["ok.lab"]);
  const merged = mergeConfig({ servers: [{ id: "server-01" }] }, personal);
  assert.equal(Object.hasOwn(merged, "noProxyExtra"), false, "supervisor / 代理读到的合并配置不带它");
});

test("validateNoProxyExtraForWrite：去重去空白、空数组删掉、非法条目 / id / 形状逐项报错", () => {
  assert.deepEqual(validateNoProxyExtraForWrite({ "server-01": [" 10.0.0.5 ", "10.0.0.5", "relay.lab:8080"], "server-02": [] }), {
    ok: true,
    value: { "server-01": ["10.0.0.5", "relay.lab:8080"] },
    errors: [],
  });
  const bad = validateNoProxyExtraForWrite({ "server-01": ["a b", 'x"y', "$(id)"], "../x": ["a"], s3: "a" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors.map((e) => e.field), ["noProxyExtra.server-01", "noProxyExtra.server-01", "noProxyExtra.server-01", "noProxyExtra.../x", "noProxyExtra.s3"]);
  assert.equal(validateNoProxyExtraForWrite(["a"]).ok, false);
  assert.equal(validateNoProxyExtraForWrite(null).ok, false);
  const full = Array.from({ length: NO_PROXY_EXTRA_MAX }, (_, i) => `h${i}.lab`);
  assert.equal(validateNoProxyExtraForWrite({ s: full }).ok, true);
  assert.doesNotThrow(() => renderClusterEnv({ port: 7892, noProxyExtra: full }), "写入放行的条数，渲染 env.sh 时也放行");
  assert.equal(validateNoProxyExtraForWrite({ s: [...full, "one-more.lab"] }).ok, false);
});

test("与 cluster-env 的 NO_PROXY 条目口径一致：写入放行的都能写进 env.sh", () => {
  const samples = ["10.0.0.5", "relay.lab", ".corp.local", "10.0.0.0/8", "[fd00::1]", "relay.lab:8080", "*.lab", "a b", "a,b", 'a"b', "$x", "a;b", ""];
  for (const s of samples) {
    const accepted = validateNoProxyExtraForWrite({ s: [s] }).ok && s.trim() !== "";
    assert.equal(accepted, isNoProxyEntry(s), s);
    if (accepted) assert.doesNotThrow(() => renderClusterEnv({ port: 7892, noProxyExtra: [s] }), s);
  }
});

test("writePersonalConfig：noProxyExtra 校验后落盘（一次写、revision 只加 1）；其余字段与不认识的字段原样保留", (t) => {
  const { dir, localConfigPath, read } = sandbox(t, { sshUser: "kai", enabledModules: ["agent:codex"], revision: 1 });
  const before = readFileSync(localConfigPath, "utf8");
  const saved = writePersonalConfig({ localConfigPath, patch: { noProxyExtra: { "server-01": ["10.0.0.5", " 10.0.0.5 "], "server-02": [] } }, expectedRevision: 1 });
  assert.deepEqual(saved.noProxyExtra, { "server-01": ["10.0.0.5"] });
  const onDisk = read();
  assert.deepEqual(onDisk.noProxyExtra, { "server-01": ["10.0.0.5"] });
  assert.equal(onDisk.revision, 2);
  assert.equal(onDisk.sshUser, "kai");
  assert.deepEqual(onDisk.enabledModules, ["agent:codex"]);
  assert.equal(readFileSync(`${localConfigPath}.bak`, "utf8"), before, "备份是写入前的原文");
  // v2.64 起另有带时间戳的写前备份（config-backups/，personal-config-backup.mjs），其余不留临时文件。
  assert.deepEqual(readdirSync(dir).sort(), ["config-backups", "config.local.json", "config.local.json.bak"], "不留临时文件");
  assert.deepEqual(readdirSync(path.join(dir, "config-backups")).map((name) => readFileSync(path.join(dir, "config-backups", name), "utf8")), [before]);
});

test("writePersonalConfig：noProxyExtra 不合法 → 整体拒绝，原文件不动、不留备份", (t) => {
  const { dir, localConfigPath, raw } = sandbox(t, { sshUser: "kai", revision: 1 });
  const snapshot = raw();
  assert.throws(
    () => writePersonalConfig({ localConfigPath, patch: { noProxyExtra: { "server-01": ['evil"; rm -rf ~'] }, egress: { mode: "system" } } }),
    (err) => err instanceof ConfigValidationError && err.errors[0].field === "noProxyExtra.server-01",
  );
  assert.equal(raw(), snapshot);
  assert.deepEqual(readdirSync(dir), ["config.local.json"]);
});

test("writePersonalConfig：与其它个人字段同一次原子写——一起成功，或（别的字段不合法时）一起不写", (t) => {
  const { localConfigPath, read, raw } = sandbox(t, { sshUser: "kai", revision: 4 });
  const saved = writePersonalConfig({
    localConfigPath,
    patch: { noProxyExtra: { "server-01": ["relay.lab"] }, egress: { mode: "manual", url: "http://127.0.0.1:7890/" }, proxyAllowedTargets: ["Relay.Example.com:9443"], expectedRevision: 4 },
    expectedRevision: 4,
  });
  assert.equal(saved.revision, 5, "只写一次");
  assert.deepEqual(read().noProxyExtra, { "server-01": ["relay.lab"] });
  assert.deepEqual(read().egress, { mode: "manual", url: "http://127.0.0.1:7890" });
  assert.deepEqual(read().proxyAllowedTargets, ["relay.example.com:9443"]);

  const snapshot = raw();
  assert.throws(
    () => writePersonalConfig({ localConfigPath, patch: { noProxyExtra: { "server-01": ["relay.lab", "second.lab"] }, egress: { mode: "manual", url: "socks5://127.0.0.1:1080" } } }),
    (err) => err instanceof ConfigValidationError && err.errors[0].field === "egress.url",
  );
  assert.equal(raw(), snapshot, "egress 没过校验，noProxyExtra 也不落盘");
});

test("writePersonalConfig：expectedRevision 冲突 → 409 且不写；个人层文件不存在 → 新建；文件损坏 → 报原因、不覆盖", (t) => {
  const conflict = sandbox(t, { revision: 3 });
  const snapshot = conflict.raw();
  assert.throws(
    () => writePersonalConfig({ localConfigPath: conflict.localConfigPath, patch: { noProxyExtra: { "server-01": ["10.0.0.5"] } }, expectedRevision: 2 }),
    (err) => err instanceof ConfigValidationError && err.status === 409,
  );
  assert.equal(conflict.raw(), snapshot);

  const fresh = sandbox(t);
  const saved = writePersonalConfig({ localConfigPath: fresh.localConfigPath, patch: { noProxyExtra: { "server-01": ["10.0.0.5"] } }, expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.deepEqual(fresh.read().noProxyExtra, { "server-01": ["10.0.0.5"] });

  const broken = sandbox(t, "{ not json");
  assert.throws(() => writePersonalConfig({ localConfigPath: broken.localConfigPath, patch: { noProxyExtra: { "server-01": ["10.0.0.5"] } } }), /原文件未改动/);
  assert.equal(broken.raw(), "{ not json");
});

// 设置页 JSON 编辑器与服务器注册表都是把整份个人层原样带回来再改别的字段：没动 noProxyExtra 的保存，
// 不该因为里面有一条手写的旧条目而全部失败（与 portOverrides 的写入校验同一取舍）。
test("writePersonalConfig：原样带回的 noProxyExtra 不算改动——不重新校验、文件里的值原样保留；没带这个字段时同样保留", (t) => {
  const handWritten = { "server-01": ["ok.lab", "bad entry"] };
  const { localConfigPath, read } = sandbox(t, { sshUser: "kai", noProxyExtra: handWritten, revision: 1 });
  let saved = writePersonalConfig({ localConfigPath, patch: { ...read(), sshUser: "cy2" }, expectedRevision: 1 });
  assert.equal(saved.sshUser, "cy2");
  assert.deepEqual(read().noProxyExtra, handWritten);
  saved = writePersonalConfig({ localConfigPath, patch: { sshUser: "cy3" }, expectedRevision: 2 });
  assert.deepEqual(read().noProxyExtra, handWritten, "没带 noProxyExtra 的补丁不会把它清掉");
  assert.equal(read().revision, 3);
  // 真的改了它，就要整份过校验。
  assert.throws(
    () => writePersonalConfig({ localConfigPath, patch: { noProxyExtra: { ...handWritten, "server-02": ["x.lab"] } }, expectedRevision: 3 }),
    (err) => err instanceof ConfigValidationError && err.errors[0].field === "noProxyExtra.server-01",
  );
  assert.deepEqual(read().noProxyExtra, handWritten);
});

test("writePersonalConfig：注入的 fs（对象字面量、方法不依赖 this）照常可用；数据面那份 writePersonalConfig 不认识这个字段", () => {
  const files = { "/p/local.json": JSON.stringify({ revision: 1 }) };
  const fs = {
    readFileSync: (file) => {
      if (!(file in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[file];
    },
    writeFileSync: (file, body) => { files[file] = String(body); },
    renameSync: (from, to) => { files[to] = files[from]; delete files[from]; },
    mkdirSync: () => {},
    chmodSync: () => {},
    copyFileSync: (from, to) => { if (from in files) files[to] = files[from]; },
    unlinkSync: (file) => { delete files[file]; },
  };
  writePersonalConfig({ localConfigPath: "/p/local.json", patch: { noProxyExtra: { "server-01": ["10.0.0.5"] } }, expectedRevision: 1, fs });
  assert.deepEqual(JSON.parse(files["/p/local.json"]).noProxyExtra, { "server-01": ["10.0.0.5"] });
  assert.equal(JSON.parse(files["/p/local.json.bak"]).revision, 1, "备份取自真实文件，不是垫进去的快照");
  // 对照：config-loader 里那份（数据面闭包内）恢复成不处理 noProxyExtra——补丁里的值被忽略、文件里已有的保留。
  baseWritePersonalConfig({ localConfigPath: "/p/local.json", patch: { noProxyExtra: { "server-01": ["other.lab"] } }, fs });
  assert.deepEqual(JSON.parse(files["/p/local.json"]).noProxyExtra, { "server-01": ["10.0.0.5"] });
});
