// v2.54 终审：控制台「重新分配端口」改走集群端口登记目录（port-registry.mjs 的 survey + claim），
// 以及个人层写入一律不收 7891（团队基准端口）。全部注入假 SSH / 假读写，零真实 SSH、零写盘。
import assert from "node:assert/strict";
import test from "node:test";

import { ConfigValidationError, validatePersonalServersForWrite, validatePortOverridesForWrite, writePersonalConfig } from "./config-loader.mjs";
import { createServerRegistry } from "./server-registry.mjs";
import { validateServerInput } from "./servers/validate.mjs";

function surveyText({ registry = "ok", me = "alice", entries = [], listening = [] } = {}) {
  return [
    `REGISTRY=${registry}`,
    ...(registry === "absent" ? [] : ["STICKY=1"]),
    ...entries.map(([port, owner]) => `REG\t${port}\t${owner}\tf`),
    `ME=${me}`,
    "LISTEN-BEGIN",
    ...listening.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:*`),
    "LISTEN-END",
  ].join("\n");
}

// 团队服务器 server-01（个人层 servers 覆盖 7893）+ 个人服务器 box。
// ssh：survey（含 LISTEN-BEGIN）回放 survey；领取（含 set -C）默认领第一个候选；释放（含 RELEASE=）记录。
function makeRegistry({ survey = surveyText(), claim, personal, writeImpl, requireRegistry = false } = {}) {
  const calls = [];
  const writes = [];
  let state = personal ?? { revision: 3, servers: [{ id: "server-01", remotePort: 7893 }] };
  const mergedServers = () => [
    { id: "server-01", host: "myserver", source: "team", localPort: 8888, remotePort: state.servers?.find((s) => s.id === "server-01")?.remotePort ?? state.portOverrides?.["server-01"]?.remotePort },
    { id: "box", host: "10.0.0.8", sshUser: "ubuntu", source: "personal", remotePort: 7990, localPort: 8990 },
  ];
  const execFileImpl = async (_cmd, args) => {
    const command = args.at(-1);
    if (command.includes("LISTEN-BEGIN")) {
      calls.push({ kind: "survey" });
      return { code: 0, stdout: survey, stderr: "" };
    }
    if (command.includes("set -C")) {
      const candidates = /for p in ([\d ]+); do/.exec(command)[1].split(" ").map(Number);
      calls.push({ kind: "claim", candidates });
      return { code: 0, stdout: claim ? claim(candidates) : `CLAIMED ${candidates[0]}\n`, stderr: "" };
    }
    if (command.includes("RELEASE=")) {
      calls.push({ kind: "release", command });
      return { code: 0, stdout: "RELEASE=ok\n", stderr: "" };
    }
    throw new Error(`unexpected ssh: ${command}`);
  };
  const registry = createServerRegistry({
    localConfigPath: "/local.json",
    readPersonalConfigImpl: () => state,
    getMergedConfig: () => ({ servers: mergedServers(), ...(requireRegistry ? { portRegistry: { required: true } } : {}) }),
    writePersonalConfigImpl: writeImpl || (async ({ patch }) => {
      writes.push(patch);
      state = { ...patch, revision: (state.revision || 0) + 1 };
      delete state.expectedRevision;
      return state;
    }),
    execFileImpl,
  });
  return { registry, calls, writes, state: () => state };
}

test("suggestPort（登记目录可用）：一次只读 survey；避开 已登记 ∪ 监听 ∪ 本机配置 ∪ 当前端口，7891 永不建议", async () => {
  const h = makeRegistry({ survey: surveyText({ entries: [[7892, "bob"]], listening: [7891, 7894] }) });
  const res = await h.registry.suggestPort("server-01");
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"], "预览不领取");
  assert.equal(res.registry, "ok");
  assert.equal(res.registered, true);
  assert.equal(res.mode, "claim");
  assert.deepEqual(res.suggested, { remotePort: 7895 }, "7891 基准 / 7892 别人登记 / 7893 当前坏端口 / 7894 监听 都避开");
  assert.equal(res.warning, null);
});

test("suggestPort：名下有没在监听的登记端口 → 优先沿用（mode=reused）", async () => {
  const h = makeRegistry({ survey: surveyText({ entries: [[7893, "alice"], [7899, "alice"]], listening: [7893] }) });
  const res = await h.registry.suggestPort("server-01");
  assert.deepEqual(res.suggested, { remotePort: 7899 });
  assert.equal(res.mode, "reused");
});

test("suggestPort：登记目录不存在 → 回落只看监听，返回 registered:false + 「未登记」+ 管理员命令", async () => {
  const h = makeRegistry({ survey: surveyText({ registry: "absent", listening: [7892] }) });
  const res = await h.registry.suggestPort("server-01");
  assert.equal(res.registered, false);
  assert.equal(res.registry, "absent");
  assert.equal(res.mode, "legacy");
  assert.match(res.warning, /未登记/);
  assert.match(res.adminCommand, /install -d -m 1777/);
  assert.notEqual(res.suggested.remotePort, 7891);
  assert.notEqual(res.suggested.remotePort, 7892);
});

test("portRegistry.required：登记目录不存在时建议与领取都 fail closed，不写个人配置", async () => {
  const suggested = makeRegistry({ survey: surveyText({ registry: "absent" }), requireRegistry: true });
  await assert.rejects(() => suggested.registry.suggestPort("server-01"), (err) => err.code === "port-registry-required" && err.status === 503);
  assert.equal(suggested.writes.length, 0);

  const claimed = makeRegistry({ survey: surveyText({ registry: "absent" }), requireRegistry: true });
  await assert.rejects(() => claimed.registry.claimPort("server-01", { remotePort: 7894 }), (err) => err.code === "port-registry-required" && err.status === 503);
  assert.equal(claimed.writes.length, 0);
});

test("suggestPort：survey 输出读不到 REGISTRY 行 → 不给建议（目录可能在，只是没读到）", async () => {
  const h = makeRegistry({ survey: "garbage" });
  const res = await h.registry.suggestPort("server-01");
  assert.equal(res.probed, false);
  assert.equal(res.probeError, "registry-unreadable");
  assert.equal(res.suggested, null);
});

test("claimPort（登记可用）：survey + 原子领取建议值，领到的端口写个人层（团队服务器只写端口覆盖）", async () => {
  const h = makeRegistry({ survey: surveyText({ entries: [[7892, "bob"]] }) });
  const res = await h.registry.claimPort("server-01", { remotePort: 7894, expectedRevision: 3 });
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey", "claim"]);
  assert.equal(h.calls[1].candidates[0], 7894, "选定端口排第一");
  assert.ok(!h.calls[1].candidates.includes(7891) && !h.calls[1].candidates.includes(7892) && !h.calls[1].candidates.includes(7893));
  assert.deepEqual([res.remotePort, res.mode, res.registered], [7894, "claimed", true]);
  assert.deepEqual(h.writes.at(-1).servers.find((s) => s.id === "server-01"), { id: "server-01", remotePort: 7894 });
});

test("portRegistry.required：团队服务器禁止手动 PATCH 反向端口，必须经过登记领取", async () => {
  const h = makeRegistry({ requireRegistry: true });
  await assert.rejects(
    () => h.registry.update("server-01", { remotePort: 7900 }),
    (err) => err.code === "port-registry-required" && err.status === 409,
  );
  assert.equal(h.writes.length, 0);
  // 已完成原子领取的内部路径仍可写入配置。
  const claimed = await h.registry.claimPort("server-01", { remotePort: 7894 });
  assert.equal(claimed.registered, true);
});

test("claimPort：领取前一刻被抢先 → 顺延领到下一个并如实返回；选定端口已被别人登记 → 不领它", async () => {
  const bumped = makeRegistry({ claim: (c) => `CLAIMED ${c[1]}\n` });
  const res = await bumped.registry.claimPort("server-01", { remotePort: 7894 });
  assert.equal(res.requested, 7894);
  assert.equal(res.remotePort, bumped.calls[1].candidates[1]);

  const taken = makeRegistry({ survey: surveyText({ entries: [[7894, "bob"]] }) });
  await taken.registry.claimPort("server-01", { remotePort: 7894 });
  assert.ok(!taken.calls[1].candidates.includes(7894));
});

test("claimPort：名下已登记的端口直接写配置，不再领取", async () => {
  const h = makeRegistry({ survey: surveyText({ entries: [[7899, "alice"]] }) });
  const res = await h.registry.claimPort("server-01", { remotePort: 7899 });
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"]);
  assert.equal(res.mode, "reused");
});

test("claimPort：领到了但写配置失败（revision 冲突）→ 释放刚领的登记文件再抛错", async () => {
  const h = makeRegistry({
    writeImpl: async () => { throw new ConfigValidationError("配置已被修改", [], 409); },
  });
  await assert.rejects(() => h.registry.claimPort("server-01", { remotePort: 7894, expectedRevision: 1 }), (err) => err.status === 409);
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey", "claim", "release"]);
  assert.match(h.calls[2].command, /7894/);
});

test("claimPort：登记目录不存在 → 回落直接写（registered:false、未登记）；端口正被监听则拒绝", async () => {
  const h = makeRegistry({ survey: surveyText({ registry: "absent" }) });
  const res = await h.registry.claimPort("server-01", { remotePort: 7894 });
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"], "目录不存在不发领取命令");
  assert.deepEqual([res.remotePort, res.mode, res.registered], [7894, "legacy", false]);
  assert.match(res.warning, /未登记/);

  const busy = makeRegistry({ survey: surveyText({ registry: "absent", listening: [7894] }) });
  await assert.rejects(() => busy.registry.claimPort("server-01", { remotePort: 7894 }), (err) => err.status === 409 && err.code === "port-in-use");
  assert.equal(busy.writes.length, 0);
});

test("claimPort / update：7891 一律拒绝（不发 SSH、不写盘），个人层原本就是 7891 的才放行", async () => {
  const h = makeRegistry();
  await assert.rejects(() => h.registry.claimPort("server-01", { remotePort: 7891 }), (err) => err.status === 400 && err.code === "reserved-port");
  await assert.rejects(() => h.registry.update("server-01", { remotePort: 7891 }), (err) => err.status === 400 && err.code === "reserved-port");
  assert.equal(h.calls.length, 0);
  assert.equal(h.writes.length, 0);

  // kai：portOverrides 里原本就是 7891 → 沿用不受影响
  const kai = makeRegistry({ personal: { revision: 1, portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } } });
  await kai.registry.update("server-01", { remotePort: 7891 });
  assert.equal(kai.writes.length, 1);
});

// ---- 写盘层（config-loader / servers/validate）的 7891 守卫 ----

test("validatePersonalServersForWrite：团队覆盖与个人服务器写 7891 被拒；原本就是 7891（servers 或 portOverrides）放行", () => {
  const team = { teamServerIds: ["server-01"] };
  const bad = validatePersonalServersForWrite([{ id: "server-01", remotePort: 7891 }], team);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].message, /7891/);
  assert.equal(validatePersonalServersForWrite([{ id: "server-01", remotePort: 7892 }], team).ok, true);
  assert.equal(validatePersonalServersForWrite([{ id: "server-01", remotePort: 7891 }], { ...team, previousServers: [{ id: "server-01", remotePort: 7891 }] }).ok, true);
  assert.equal(validatePersonalServersForWrite([{ id: "server-01", remotePort: 7891 }], { ...team, previousPortOverrides: { "server-01": { remotePort: 7891 } } }).ok, true);
  // 豁免按条目：别的 id 原本是 7891 不算
  assert.equal(validatePersonalServersForWrite([{ id: "server-01", remotePort: 7891 }], { ...team, previousPortOverrides: { "server-02": { remotePort: 7891 } } }).ok, false);

  const personal = { id: "mine", host: "10.0.0.9", sshUser: "me", remotePort: 7891 };
  assert.equal(validatePersonalServersForWrite([personal]).ok, false);
  assert.equal(validatePersonalServersForWrite([personal], { previousServers: [{ ...personal }] }).ok, true);
});

test("validatePortOverridesForWrite：新写 7891 / 非法端口被拒；与原值相同的条目跳过", () => {
  assert.equal(validatePortOverridesForWrite({ "server-01": { remotePort: 7891, localPort: 8888 } }).ok, false);
  assert.equal(validatePortOverridesForWrite({ "server-01": { remotePort: 7891, localPort: 8888 } }, { previous: { portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } } }).ok, true);
  assert.equal(validatePortOverridesForWrite({ "server-01": { remotePort: 70000 } }).ok, false);
  assert.equal(validatePortOverridesForWrite({ "server-01": { remotePort: 7895, localPort: 8895 } }).ok, true);
  assert.equal(validatePortOverridesForWrite([]).ok, false);
});

test("writePersonalConfig：提交 portOverrides 写 7891 整体拒绝、原文件不动；kai 原值 7891 原样带回可保存", () => {
  const files = new Map([["/p.json", JSON.stringify({ revision: 1 })]]);
  const fs = {
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files.get(p);
    },
    writeFileSync: (p, data) => files.set(p, String(data)),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    copyFileSync: () => {},
    chmodSync: () => {},
    mkdirSync: () => {},
    openSync: () => 1, closeSync: () => {}, fsyncSync: () => {}, existsSync: (p) => files.has(p), unlinkSync: (p) => files.delete(p),
  };
  assert.throws(
    () => writePersonalConfig({ localConfigPath: "/p.json", patch: { portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } }, fs }),
    (err) => err instanceof ConfigValidationError && /7891/.test(err.errors[0].message),
  );
  assert.equal(JSON.parse(files.get("/p.json")).portOverrides, undefined);

  files.set("/kai.json", JSON.stringify({ revision: 1, portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } }));
  const saved = writePersonalConfig({ localConfigPath: "/kai.json", patch: { portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } }, activeAgentId: "codex" }, fs });
  assert.equal(saved.portOverrides["server-01"].remotePort, 7891);
});

test("validateServerInput：新增个人服务器写 7891 被拒；编辑原本就是 7891 的条目放行", () => {
  const input = { name: "x", address: "10.0.0.9", sshUser: "me", remotePort: 7891, tunnel: true };
  assert.throws(() => validateServerInput(input), (err) => err instanceof ConfigValidationError && err.errors.some((e) => e.field === "remotePort" && /7891/.test(e.message)));
  assert.equal(validateServerInput(input, { legacy: { ...input } }).remotePort, 7891);
  assert.equal(validateServerInput({ ...input, remotePort: 7892 }).remotePort, 7892);
});
