// 向导"领取专属反向端口"一步（scripts/setup/port-assignment.mjs）：注入假 SSH / 假提问 / 假写盘，
// 覆盖 复用名下登记 / 新领取 / 登记目录缺失回落 三条主路径与各失败分支。零真实 SSH、零写盘。
import assert from "node:assert/strict";
import test from "node:test";

import { mergeConfig } from "../work/monitor/lib/config-loader.mjs";
import { DEFAULT_PORT_REGISTRY_DIR, parseClaimResult } from "../work/monitor/lib/port-registry.mjs";
import { detectSetupState, setupHintLines } from "./launch.mjs";
import { assignReversePort, buildReservedPorts, checkManualPort, pickPreferredPort, readCurrentPortOverride, readTeamPortRegistryDir } from "./setup/port-assignment.mjs";

const SERVER = { id: "server-01", host: "myserver" };

function surveyText({ registry = "ok", sticky = 1, me = "alice", entries = [], listening = [] } = {}) {
  return [
    `REGISTRY=${registry}`,
    ...(registry === "absent" ? [] : [`STICKY=${sticky}`]),
    ...entries.map(([port, owner, kind = "f"]) => `REG\t${port}\t${owner}\t${kind}`),
    `ME=${me}`,
    "LISTEN-BEGIN",
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port",
    ...listening.map((p) => `LISTEN 0 128 127.0.0.1:${p} 0.0.0.0:*`),
    "LISTEN-END",
  ].join("\n");
}

// 假 SSH：survey 命令（含 LISTEN-BEGIN）回放 survey 输出；领取命令（含 set -C）按 claim 回调作答。
// claim(candidates) 缺省领第一个候选。记录每次调用，供断言"领取时的候选顺序"。
function harness({ survey = surveyText(), surveyStatus = 0, claim, claimStatus = 0, answers = [""], local = {} } = {}) {
  const calls = [];
  const writes = [];
  const messages = [];
  const asked = [];
  const ssh = (host, command) => {
    if (command.includes("LISTEN-BEGIN")) {
      calls.push({ kind: "survey", host, command });
      return { status: surveyStatus, stdout: surveyStatus === 0 ? survey : "", stderr: surveyStatus === 0 ? "" : "ssh: connect to host myserver port 22: Connection refused" };
    }
    if (command.includes("set -C")) {
      const candidates = /for p in ([\d ]+); do/.exec(command)[1].split(" ").map(Number);
      calls.push({ kind: "claim", host, command, candidates });
      const stdout = claim ? claim(candidates) : `CLAIMED ${candidates[0]}\n`;
      return { status: claimStatus, stdout: claimStatus === 0 ? stdout : "", stderr: claimStatus === 0 ? "" : "Connection timed out" };
    }
    throw new Error(`unexpected ssh command: ${command}`);
  };
  const queue = [...answers];
  const ask = async (question) => {
    asked.push(question);
    return queue.length ? queue.shift() : "";
  };
  const record = (level) => (msg) => messages.push({ level, msg: String(msg) });
  const deps = {
    ssh,
    ask,
    dryRun: false,
    localConfigPath: "/tmp/config.local.json",
    registryDir: DEFAULT_PORT_REGISTRY_DIR,
    writeConfig: (args) => writes.push(args),
    readLocal: () => local,
    ui: {
      logHeader: () => {},
      logInfo: record("info"),
      logSuccess: record("success"),
      logWarning: record("warn"),
      printManualCommand: record("command"),
      dryRunLog: record("dry-run"),
    },
  };
  return { deps, calls, writes, messages, asked, text: () => messages.map((m) => m.msg).join("\n") };
}

// ---- 三条主路径 ----

test("复用：登记目录里已有我名下的端口 → 直接沿用，不提问、不再领取", async () => {
  const h = harness({ survey: surveyText({ me: "alice", entries: [[7892, "bob"], [7895, "alice"]] }) });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.deepEqual(res, { remotePort: 7895, localPort: 8895, registry: "ok", mode: "reused" });
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"]);
  assert.equal(h.asked.length, 0);
  assert.deepEqual(h.writes, [{ localConfigPath: "/tmp/config.local.json", patch: { portOverrides: { "server-01": { remotePort: 7895, localPort: 8895 } } } }]);
});

test("复用：名下端口正在监听而本机配置里没有它 → 提示可能是另一台电脑在用", async () => {
  const h = harness({ survey: surveyText({ me: "alice", entries: [[7895, "alice"]], listening: [7895] }) });
  await assignReversePort(SERVER, [], h.deps);
  assert.match(h.text(), /另一台电脑/);
  // 本机配置里本来就是它（自己的隧道在跑）→ 不提示
  const same = harness({ survey: surveyText({ me: "alice", entries: [[7895, "alice"]], listening: [7895] }), local: { portOverrides: { "server-01": { remotePort: 7895, localPort: 8895 } } } });
  await assignReversePort(SERVER, [], same.deps);
  assert.doesNotMatch(same.text(), /另一台电脑/);
});

test("复用：名下有多个登记时优先本机配置里在用的那个", async () => {
  const h = harness({ survey: surveyText({ me: "alice", entries: [[7893, "alice"], [7897, "alice"]] }), local: { portOverrides: { "server-01": { remotePort: 7897 } } } });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7897);
  assert.match(h.text(), /7893, 7897/);
});

test("新领：避开 已登记 ∪ 监听 ∪ 团队保留，回车登记建议值；领取命令按序带上兜底候选", async () => {
  const h = harness({ survey: surveyText({ me: "alice", entries: [[7892, "bob"]], listening: [7891, 7893] }) });
  const res = await assignReversePort(SERVER, [7894], h.deps);
  assert.deepEqual(res, { remotePort: 7895, localPort: 8895, registry: "ok", mode: "claimed" });
  const claim = h.calls.find((c) => c.kind === "claim");
  assert.deepEqual(claim.candidates.slice(0, 3), [7895, 7896, 7897]);
  assert.ok(!claim.candidates.includes(7891) && !claim.candidates.includes(7892) && !claim.candidates.includes(7893) && !claim.candidates.includes(7894));
  assert.match(h.asked[0], /登记建议值 7895/);
  assert.deepEqual(h.writes[0].patch, { portOverrides: { "server-01": { remotePort: 7895, localPort: 8895 } } });
});

test("新领：选定端口在领取前一刻被别人抢先 → 自动顺延并告知", async () => {
  const h = harness({ claim: (c) => `CLAIMED ${c[1]}\n` });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7893);
  assert.match(h.text(), /7892 刚被别人抢先登记，已改领 7893/);
});

test("新领：个人层原有端口（旧向导分配、未登记、没在监听）默认登记下来", async () => {
  const h = harness({ survey: surveyText({ me: "alice" }), local: { portOverrides: { "server-01": { remotePort: 7896, localPort: 8896 }, "server-02": { remotePort: 7990, localPort: 8990 } } } });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7896);
  assert.match(h.asked[0], /沿用你当前配置的 7896/);
  assert.equal(h.calls.find((c) => c.kind === "claim").candidates[0], 7896);
  assert.deepEqual(h.writes[0].patch.portOverrides, {
    "server-02": { remotePort: 7990, localPort: 8990 },
    "server-01": { remotePort: 7896, localPort: 8896 },
  }, "别的服务器的端口覆盖原样保留");
});

test("新领（v2.54 终审）：个人层原有端口正在被监听 → 不默认沿用（分不清是不是自己的隧道），提示后回车登记新端口；手动输入原端口仍可沿用", async () => {
  const local = { portOverrides: { "server-01": { remotePort: 7896, localPort: 8896 } } };
  const h = harness({ survey: surveyText({ me: "alice", listening: [7896] }), local });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7892);
  assert.match(h.text(), /7896 还没登记，且此刻正在被监听/);
  assert.match(h.asked[0], /登记建议值 7892/);
  assert.ok(!h.calls.find((c) => c.kind === "claim").candidates.includes(7896), "监听中的端口不进兜底候选");

  const mine = harness({ survey: surveyText({ me: "alice", listening: [7896] }), local, answers: ["7896"] });
  assert.equal((await assignReversePort(SERVER, [], mine.deps)).remotePort, 7896, "确认是自己的隧道 → 输入原端口沿用并登记");
});

test("新领（v2.54 终审）：7891 只有个人层原本就是它的人（kai）能沿用；团队层没 remotePort 时保留集仍含 7891", async () => {
  const kai = { portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } };
  const idle = harness({ survey: surveyText({ me: "kai" }), local: kai });
  assert.equal((await assignReversePort(SERVER, [], idle.deps)).remotePort, 7891, "没在监听 → 默认沿用并登记");
  const live = harness({ survey: surveyText({ me: "kai", listening: [7891] }), local: kai, answers: ["7891"] });
  assert.equal((await assignReversePort(SERVER, [], live.deps)).remotePort, 7891, "隧道在跑 → 提示后输入 7891 沿用");
  assert.match(live.text(), /7891 还没登记，且此刻正在被监听/);
  // 别人：7891 既不是默认值，也进不了候选，手动输入同样被拒
  const other = harness({ survey: surveyText({ me: "alice" }), answers: ["7891"] });
  const res = await assignReversePort(SERVER, [], other.deps);
  assert.equal(res.remotePort, 7892);
  assert.ok(!other.calls.find((c) => c.kind === "claim").candidates.includes(7891));
  assert.match(other.text(), /团队最早的生产端口/);
});

test("pickPreferredPort / buildReservedPorts：纯函数口径", () => {
  const survey = { me: "alice", entries: [{ port: 7893, owner: "bob", regular: true }], listening: [7894] };
  assert.equal(pickPreferredPort({ existing: 7895, survey }), 7895);
  assert.equal(pickPreferredPort({ existing: 7893, survey }), null, "别人登记的不沿用");
  assert.equal(pickPreferredPort({ existing: 7894, survey }), null, "监听中的不默认沿用");
  assert.equal(pickPreferredPort({ existing: 7895, survey, teamRemotePorts: [7895] }), null);
  assert.equal(pickPreferredPort({ existing: null, survey }), null);
  assert.deepEqual(buildReservedPorts([], null), [7891]);
  assert.deepEqual(buildReservedPorts([], 7891), [], "kai 本人不把 7891 算进保留集");
  assert.deepEqual(buildReservedPorts([7900], 7895), [7900, 7891]);
});

test("新领：个人层原有端口已被别人登记 → 不沿用，改给新建议值", async () => {
  const h = harness({ survey: surveyText({ me: "alice", entries: [[7896, "bob"]] }), local: { portOverrides: { "server-01": { remotePort: 7896 } } } });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7892);
});

test("新领：手动输入合法端口 → 领它；输入别人登记的 / 7891 / 非法值 → 回退建议值", async () => {
  const ok = harness({ answers: ["7950"] });
  assert.equal((await assignReversePort(SERVER, [], ok.deps)).remotePort, 7950);
  assert.equal(ok.calls.find((c) => c.kind === "claim").candidates[0], 7950);

  for (const [answer, why] of [["7893", /已被 bob 登记/], ["7891", /团队最早的生产端口/], ["abc", /无效/], ["7894", /正被服务器监听/]]) {
    const h = harness({ survey: surveyText({ me: "alice", entries: [[7893, "bob"]], listening: [7894] }), answers: [answer] });
    const res = await assignReversePort(SERVER, [], h.deps);
    assert.equal(res.remotePort, 7892, answer);
    assert.match(h.text(), why, answer);
  }
});

test("回落：登记目录不存在 → 按监听分配，醒目提示管理员建目录命令，不发领取命令", async () => {
  const h = harness({ survey: surveyText({ registry: "absent", me: "alice", listening: [7891, 7892] }) });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.deepEqual(res, { remotePort: 7893, localPort: 8893, registry: "absent", mode: "legacy" });
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"]);
  assert.match(h.text(), /未启用端口登记/);
  assert.match(h.text(), /可能与他人分到同一个端口/);
  assert.ok(h.messages.some((m) => m.level === "command" && m.msg.includes("sudo install -d -m 1777 /public/agent-hub /public/agent-hub/ports")));
  assert.equal(h.writes.length, 1);
});

test("强制登记：登记目录不存在时停止向导，不写入一个可能撞车的端口", async () => {
  const h = harness({ survey: surveyText({ registry: "absent", me: "alice", listening: [7891, 7892] }) });
  h.deps.requireRegistry = true;
  await assert.rejects(
    () => assignReversePort(SERVER, [], h.deps),
    /已停止分配以避免与离线同事撞端口/,
  );
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.calls.map((c) => c.kind), ["survey"]);
});

test("回落：目录只读 → 给 chmod 命令；回落路径同样不收手动 7891", async () => {
  const h = harness({ survey: surveyText({ registry: "readonly", sticky: 1, me: "alice" }), answers: ["7891"] });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.mode, "legacy");
  assert.equal(res.registry, "readonly");
  assert.equal(res.remotePort, 7892);
  assert.ok(h.messages.some((m) => m.level === "command" && m.msg.includes("sudo chmod 1777 /public/agent-hub/ports")));
  assert.match(h.text(), /团队最早的生产端口/);
});

test("回落：survey 时目录在、领取时目录没了 → 转回落分配", async () => {
  const h = harness({ claim: () => "REGISTRY=absent\n" });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.mode, "legacy");
  assert.equal(res.registry, "absent");
  assert.match(h.text(), /未启用端口登记/);
});

test("登记目录缺粘滞位 → 照常领取，但提示管理员补 chmod", async () => {
  const h = harness({ survey: surveyText({ sticky: 0 }) });
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.mode, "claimed");
  assert.match(h.text(), /没有粘滞位/);
});

// ---- 失败分支：读不到 / 领不到就不写个人层 ----

test("survey 的 SSH 失败 → 抛错且不写个人层（读不到 ≠ 目录不存在，绝不回落旧分配）", async () => {
  const h = harness({ surveyStatus: 255 });
  await assert.rejects(assignReversePort(SERVER, [], h.deps), /无法读取 myserver 上的端口登记信息（ssh: connect to host myserver port 22: Connection refused）/);
  assert.equal(h.writes.length, 0);
});

test("领取的 SSH 失败 / 候选全被抢 → 抛错且不写个人层", async () => {
  const failed = harness({ claimStatus: 255 });
  await assert.rejects(assignReversePort(SERVER, [], failed.deps), /登记端口失败（Connection timed out）/);
  assert.equal(failed.writes.length, 0);
  const exhausted = harness({ claim: () => "EXHAUSTED\n" });
  await assert.rejects(assignReversePort(SERVER, [], exhausted.deps), /全部被别人抢先登记/);
  assert.equal(exhausted.writes.length, 0);
});

test("区间全部被登记 → 抛错并指向登记目录", async () => {
  const entries = Array.from({ length: 1000 }, (_, i) => [7892 + i, "someone"]);
  const h = harness({ survey: surveyText({ entries }) });
  await assert.rejects(assignReversePort(SERVER, [], h.deps), /已全部被登记或占用/);
});

test("dry-run：不发 SSH、不写盘，只打印将执行的动作", async () => {
  const h = harness();
  h.deps.dryRun = true;
  h.deps.ssh = () => { throw new Error("dry-run 不得 SSH"); };
  h.deps.writeConfig = () => { throw new Error("dry-run 不得写盘"); };
  const res = await assignReversePort(SERVER, [], h.deps);
  assert.equal(res.remotePort, 7892);
  assert.equal(res.registry, "unknown");
  assert.ok(h.messages.filter((m) => m.level === "dry-run").length >= 3);
});

// ---- 纯函数与读取小件 ----

test("checkManualPort：别人登记 / 自己登记 / 监听中 / 团队保留 / 7891", () => {
  const survey = { me: "alice", entries: [{ port: 7893, owner: "bob", regular: true }, { port: 7895, owner: "alice", regular: true }], listening: [7894, 7895] };
  assert.deepEqual(checkManualPort("7900", { survey }), { ok: true, port: 7900 });
  assert.equal(checkManualPort("7893", { survey }).ok, false);
  assert.deepEqual(checkManualPort("7895", { survey }), { ok: true, port: 7895 }, "自己登记的端口在监听属正常");
  assert.equal(checkManualPort("7894", { survey }).ok, false);
  assert.deepEqual(checkManualPort("7894", { survey, existing: 7894 }), { ok: true, port: 7894 }, "本机原本就用它（自己的隧道）");
  assert.equal(checkManualPort("7896", { survey, teamRemotePorts: [7896] }).ok, false);
  assert.equal(checkManualPort("7891", { survey }).ok, false);
  assert.deepEqual(checkManualPort("7891", { survey, existing: 7891 }), { ok: true, port: 7891 }, "7891 只有原本就用它的人能沿用");
  assert.equal(checkManualPort(" 70000 ", { survey }).ok, false);
  assert.equal(checkManualPort("78a9", { survey }).ok, false);
});

test("readTeamPortRegistryDir / readCurrentPortOverride：读不到、写坏都安全回落；强制登记的坏路径 fail closed", () => {
  assert.equal(readTeamPortRegistryDir({ readFile: () => JSON.stringify({ portRegistry: { dir: "/srv/ports" } }) }), "/srv/ports");
  assert.equal(readTeamPortRegistryDir({ readFile: () => "{}" }), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(readTeamPortRegistryDir({ readFile: () => { throw new Error("ENOENT"); } }), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(readTeamPortRegistryDir({ readFile: () => JSON.stringify({ portRegistry: { dir: "../x" } }), warn: () => {} }), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(readTeamPortRegistryDir({ readFile: () => JSON.stringify({ portRegistry: { dir: "../x", required: true } }), warn: () => {} }), null);
  assert.equal(readCurrentPortOverride("/l.json", "server-01", { readLocal: () => ({ portOverrides: { "server-01": { remotePort: "7896" } } }) }), 7896);
  assert.equal(readCurrentPortOverride("/l.json", "server-01", { readLocal: () => ({}) }), null);
  assert.equal(readCurrentPortOverride("/l.json", "server-01", { readLocal: () => { throw new Error("bad json"); } }), null);
  assert.equal(readCurrentPortOverride("/l.json", "server-01", { readLocal: () => ({ portOverrides: { "server-01": { remotePort: "x" } } }) }), null);
});

test("真实领取输出样本可被解析（与 port-registry 同一口径）", () => {
  assert.deepEqual(parseClaimResult("CLAIMED 7892\n"), { status: "claimed", port: 7892 });
});

// ---- 首次运行检测：团队层不再预烤 remotePort 后，没领端口 = 向导没走完 ----

const TEAM_WITHOUT_PORT = { activeServerId: "server-01", servers: [{ id: "server-01", host: "myserver", localPort: 8888 }] };

test("launch 首次运行检测：团队层无 remotePort、个人层无 portOverrides → missing-port（提示去页面里领取）", () => {
  const state = detectSetupState({ team: TEAM_WITHOUT_PORT, local: { sshUser: "alice" } });
  assert.deepEqual(state, { needsSetup: true, reason: "missing-port" });
  assert.match(setupHintLines(state).join("\n"), /反向端口[\s\S]*接入引导/);
  // 个人层缺失但 ssh 别名能解析出用户：以前算 ready，现在没端口仍要引导
  const missingLocal = detectSetupState({ team: TEAM_WITHOUT_PORT, localState: "missing", resolveSshUser: () => "alice" });
  assert.deepEqual(missingLocal, { needsSetup: true, reason: "missing-port" });
  // 领了端口（portOverrides）就 ready
  const merged = mergeConfig(TEAM_WITHOUT_PORT, { sshUser: "alice", portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } }, { warn: () => {} });
  assert.equal(merged.servers[0].remotePort, 7892);
  assert.deepEqual(detectSetupState({ team: TEAM_WITHOUT_PORT, local: { sshUser: "alice", portOverrides: { "server-01": { remotePort: 7892, localPort: 8892 } } } }), { needsSetup: false, reason: null });
});
