// 集群侧受管配置与代理口令（v2.62）：端口同步时保住口令、「把口令写到集群」先预览再写、只读检测回报带的是哪一个。
// 远端命令在临时 HOME 里用本机 sh 真跑；每条交给「ssh」的命令文本都记下来，事后检查里面没有口令。
// 新用例单独成文件，cluster-env-sync.test.mjs 原样不动。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildClusterEnvSteps, buildEnvPortReadCommand, CLAUDE_SETTINGS_READ_COMMAND, credentialFingerprint, parseEnvCredentialRead, parseEnvPortRead, planClaudeSettingsMerge, renderClusterEnv } from "./cluster-env.mjs";
import { createClusterEnvSync } from "./cluster-env-sync.mjs";

const skip = process.platform === "win32" ? "远端脚本用本机 sh 执行，需要 POSIX 环境" : false;
const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const NEW_TOKEN = "NextTokenEEEEffffGGGGhhhh7654321";
const CRED = { user: "cwb", password: TOKEN };
const NEW_CRED = { user: "cwb", password: NEW_TOKEN };
const configWith = (remotePort) => ({ activeServerId: "server-01", servers: [{ id: "server-01", host: "h", source: "team", remotePort }, { id: "mine", host: "p", source: "personal", remotePort: 7999 }] });

function sandbox(t, { fail = () => false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-sync-cred-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = []; // { command, input }
  const sh = (command, input) => spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", input: input ?? "" });
  const runRemote = async (_server, _config, command, options = {}) => {
    calls.push({ command, input: options.input ?? null });
    if (fail(command)) return { code: 255, stdout: "", stderr: "Connection closed by remote host" };
    const res = sh(command, options.input);
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  // 接入时的落地状态：env.sh + 引入块（+ Claude settings 里的代理键）；credential 给了就是带口令的。
  const provision = (port, { credential = null, claude = false } = {}) => {
    const opts = { port, ...(credential ? { credential } : {}) };
    for (const step of buildClusterEnvSteps(opts)) assert.equal(sh(step.command, step.input).status, 0, step.id);
    if (claude) {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude/settings.json"), `${JSON.stringify({ env: { FOO: "1" } }, null, 2)}\n`);
      const plan = planClaudeSettingsMerge(sh(CLAUDE_SETTINGS_READ_COMMAND).stdout, opts);
      assert.equal(sh(plan.command, plan.input).status, 0);
    }
  };
  const envFile = () => fs.readFileSync(path.join(home, ".config/cluster-workbench/env.sh"), "utf8");
  const remoteState = () => {
    const out = sh(buildEnvPortReadCommand()).stdout;
    return { port: parseEnvPortRead(out)?.port ?? null, credential: parseEnvCredentialRead(out) };
  };
  const settingsEnv = () => JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8")).env;
  return { home, runRemote, calls, provision, envFile, remoteState, settingsEnv };
}

function service(box, { port = 7891, credential = CRED, mode } = {}) {
  const state = { config: configWith(port), credential, mode };
  const logs = [];
  const sync = createClusterEnvSync({
    getConfig: async () => state.config,
    getPersonalConfig: () => ({}),
    runRemote: box.runRemote,
    now: () => 1000,
    log: (line) => logs.push(line),
    autoCheck: false,
    getProxyCredential: () => state.credential,
    // 不传 mode 时用缺省（关）：v2.62 的用例照旧。
    ...(mode !== undefined ? { getProxyAuthMode: () => state.mode } : {}),
  });
  sync.onConfigRefreshed(state.config);
  const setPort = (next) => {
    state.config = configWith(next);
    sync.onConfigRefreshed(state.config);
  };
  return { sync, setPort, logs, state };
}

function assertNoSecret(box, logs = []) {
  for (const { command } of box.calls) {
    for (const token of [TOKEN, NEW_TOKEN]) assert.equal(command.includes(token), false, `命令文本里出现了口令: ${command.slice(0, 100)}…`);
  }
  for (const line of logs) for (const token of [TOKEN, NEW_TOKEN]) assert.equal(String(line).includes(token), false, "日志里出现了口令");
}

test("端口变更的自动同步：集群上原来带着口令 → 带着当前口令改到新端口（env.sh 与 settings.json 都是）", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { credential: CRED, claude: true });
  const { sync, setPort, logs } = service(box);
  setPort(7893);
  const state = await sync.check("server-01"); // 排在自动同步之后
  assert.equal(state.state, "in-sync");
  assert.equal(box.envFile(), renderClusterEnv({ port: 7893, credential: CRED }));
  assert.deepEqual(box.remoteState(), { port: 7893, credential: credentialFingerprint(CRED) });
  assert.equal(box.settingsEnv().HTTPS_PROXY, `http://cwb:${TOKEN}@127.0.0.1:7893`);
  assert.equal(box.settingsEnv().FOO, "1");
  assert.deepEqual(state.lastSync.changed, ["~/.config/cluster-workbench/env.sh", "~/.claude/settings.json"]);
  // 带口令的内容全部走标准输入。
  const writes = box.calls.filter((call) => call.input?.includes(TOKEN));
  assert.equal(writes.length, 2);
  assertNoSecret(box, logs);
});

test("端口变更的自动同步：换过口令后，集群上是上一个口令 → 顺手换成当前的", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { credential: CRED });
  const { sync, setPort } = service(box, { credential: NEW_CRED });
  setPort(7893);
  await sync.check("server-01");
  assert.deepEqual(box.remoteState(), { port: 7893, credential: credentialFingerprint(NEW_CRED) });
});

test("端口变更的自动同步：集群上原来不带口令 → 仍不带（第一次放上去只由用户点「把口令写到集群」）", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { claude: true });
  const { sync, setPort } = service(box); // 本机有口令
  setPort(7893);
  await sync.check("server-01");
  assert.equal(box.envFile(), renderClusterEnv({ port: 7893 }), "与没有口令功能时逐字相同");
  assert.equal(box.settingsEnv().HTTPS_PROXY, "http://127.0.0.1:7893");
  assert.equal(box.calls.some((call) => call.input?.includes(TOKEN)), false);
});

test("端口变更的自动同步：集群上带着口令而本机已经没有口令（运行目录重置过）→ 写不带口令的，不留一个谁也对不上的旧口令", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { credential: CRED });
  const { sync, setPort } = service(box, { credential: null });
  setPort(7893);
  await sync.check("server-01");
  assert.deepEqual(box.remoteState(), { port: 7893, credential: "none" });
});

test("getState（进 /api/status 的那一份）形状不变、不含指纹；指纹只从 getCredentialState 出来", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { credential: CRED });
  const { sync } = service(box);
  assert.equal(sync.getCredentialState("server-01"), null, "没查过");
  await sync.check("server-01");
  const state = sync.getState("server-01");
  assert.deepEqual(Object.keys(state).sort(), ["attemptedAt", "checkedAt", "envPort", "error", "expectedPort", "lastSync", "state"]);
  assert.equal(JSON.stringify(state).includes(credentialFingerprint(CRED)), false);
  assert.deepEqual(sync.getCredentialState("server-01"), { fingerprint: credentialFingerprint(CRED), checkedAt: 1000 });
  assert.equal(sync.getCredentialState("mine"), null, "个人服务器不在范围内");
});

test("把口令写到集群：先预览（只读，不写任何东西），确认后才写；再点一次是「已是最新」", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { claude: true });
  const { sync, logs } = service(box);
  const before = box.envFile();

  const preview = await sync.syncCredential("server-01", { preview: true });
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.plan, {
    env: { path: "~/.config/cluster-workbench/env.sh", credential: "add", port: null, action: "write" },
    claude: { path: "~/.claude/settings.json", action: "write", reason: null, changedKeys: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] },
  });
  assert.equal(box.envFile(), before, "预览不写");
  assert.equal(box.settingsEnv().HTTPS_PROXY, "http://127.0.0.1:7891");
  assert.equal(box.calls.every((call) => call.input === null), true, "预览只发只读命令");
  assert.equal(JSON.stringify(preview).includes(TOKEN), false, "预览结果里没有口令，也没有文件内容");

  const done = await sync.syncCredential("server-01");
  assert.equal(done.status, "synced");
  assert.deepEqual(done.changed, ["~/.config/cluster-workbench/env.sh", "~/.claude/settings.json"]);
  assert.equal(done.warning, null);
  assert.equal(box.envFile(), renderClusterEnv({ port: 7891, credential: CRED }));
  assert.equal(box.settingsEnv().HTTPS_PROXY, `http://cwb:${TOKEN}@127.0.0.1:7891`);
  assert.equal(JSON.stringify(done).includes(TOKEN), false);
  assert.equal(sync.getCredentialState("server-01").fingerprint, credentialFingerprint(CRED));
  assert.equal(sync.getState("server-01").lastSync, null, "端口本来就对：不记成一次端口同步");

  const again = await sync.syncCredential("server-01");
  assert.equal(again.status, "up-to-date");
  assert.equal(again.plan.env.action, "unchanged");
  assert.equal(again.plan.env.credential, "keep");
  assert.equal(again.plan.claude.action, "unchanged");
  assertNoSecret(box, logs);
});

test("把口令写到集群：换口令后是「换成当前口令」；env.sh 指向别的端口时一并改过来并记一次同步", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7900, { credential: CRED, claude: true }); // 另一个端口 + 旧口令
  const { sync } = service(box, { port: 7891, credential: NEW_CRED });
  const preview = await sync.syncCredential("server-01", { preview: true });
  assert.deepEqual(preview.plan.env, { path: "~/.config/cluster-workbench/env.sh", credential: "replace", port: { from: 7900, to: 7891 }, action: "write" });
  assert.equal(preview.plan.claude.action, "write", "settings.json 里是我们为 env.sh 原来那个端口写的地址：一起改");
  const done = await sync.syncCredential("server-01");
  assert.equal(done.status, "synced");
  assert.deepEqual(box.remoteState(), { port: 7891, credential: credentialFingerprint(NEW_CRED) });
  assert.equal(box.settingsEnv().HTTPS_PROXY, `http://cwb:${NEW_TOKEN}@127.0.0.1:7891`);
  assert.deepEqual({ from: sync.getState("server-01").lastSync.from, to: sync.getState("server-01").lastSync.to, trigger: sync.getState("server-01").lastSync.trigger }, { from: 7900, to: 7891, trigger: "manual" });
});

test("把口令写到集群：settings.json 不是我们写的地址（reclaude 接管 / 用户自己配的）→ 不动它，只写 env.sh", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891);
  fs.mkdirSync(path.join(box.home, ".claude"));
  const reclaude = `${JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: "/home/u/.reclaude/ca.pem" } }, null, 2)}\n`;
  fs.writeFileSync(path.join(box.home, ".claude/settings.json"), reclaude);
  const { sync } = service(box);
  const done = await sync.syncCredential("server-01");
  assert.equal(done.status, "synced");
  assert.deepEqual(done.changed, ["~/.config/cluster-workbench/env.sh"]);
  assert.deepEqual({ action: done.plan.claude.action, reason: done.plan.claude.reason }, { action: "skip", reason: "not-managed" });
  assert.equal(fs.readFileSync(path.join(box.home, ".claude/settings.json"), "utf8"), reclaude);
});

test("把口令写到集群：各种写不了的情况如实回报，什么都不写", { skip }, async (t) => {
  // 集群上没有受管 env.sh：不凭空建一个（没有配套的引入块）。
  const empty = sandbox(t);
  assert.equal((await service(empty).sync.syncCredential("server-01")).status, "absent");
  assert.equal(fs.existsSync(path.join(empty.home, ".config")), false);

  // 本机还没有口令。
  const noToken = sandbox(t);
  noToken.provision(7891);
  assert.equal((await service(noToken, { credential: null }).sync.syncCredential("server-01")).status, "no-token");
  assert.equal(noToken.calls.length, 0, "连只读命令都不发");

  // 不在范围内的服务器、没有端口。
  const box = sandbox(t);
  box.provision(7891);
  assert.equal((await service(box).sync.syncCredential("mine")).status, "ineligible");
  assert.equal((await service(box, { port: null }).sync.syncCredential("server-01")).status, "no-port");

  // SSH 读不到。
  const down = sandbox(t, { fail: () => true });
  const failed = await service(down).sync.syncCredential("server-01");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /读取集群配置失败/);
});

test("把口令写到集群：env.sh 写成了、settings.json 没写成 → 算成功并带一条提醒；env.sh 写不成 → 失败，原文件不动", { skip }, async (t) => {
  let breakSettings = true;
  const box = sandbox(t, { fail: (command) => breakSettings && /settings\.json\.tmp/.test(command) });
  box.provision(7891, { claude: true });
  const { sync } = service(box);
  const partial = await sync.syncCredential("server-01");
  assert.equal(partial.status, "synced");
  assert.deepEqual(partial.changed, ["~/.config/cluster-workbench/env.sh"]);
  assert.match(partial.warning, /改写 ~\/\.claude\/settings\.json 失败.*原文件未改动/);
  assert.equal(box.settingsEnv().HTTPS_PROXY, "http://127.0.0.1:7891");
  breakSettings = false;
  assert.deepEqual((await sync.syncCredential("server-01")).changed, ["~/.claude/settings.json"], "再点一次只补没写成的那个");

  const broken = sandbox(t, { fail: (command) => /env\.sh\.tmp/.test(command) });
  broken.provision(7891);
  const before = broken.envFile();
  const failed = await service(broken).sync.syncCredential("server-01");
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /改写 ~\/\.config\/cluster-workbench\/env\.sh 失败/);
  assert.equal(broken.envFile(), before);
});

test("credentialForRewrite（别处要整体重写 env.sh 时先问这一句）：现读集群，原来带着就给当前口令，不带就是 null", { skip }, async (t) => {
  const plain = sandbox(t);
  plain.provision(7891);
  assert.equal(await service(plain).sync.credentialForRewrite("server-01"), null);

  const withCred = sandbox(t);
  withCred.provision(7891, { credential: CRED });
  assert.deepEqual(await service(withCred, { credential: NEW_CRED }).sync.credentialForRewrite("server-01"), NEW_CRED);

  const fresh = sandbox(t); // 第一次接入：集群上还没有 env.sh
  assert.equal(await service(fresh).sync.credentialForRewrite("server-01"), null);
  assert.equal(await service(fresh).sync.credentialForRewrite("mine"), null);
  assert.equal(await service(fresh).sync.credentialForRewrite("nope"), null);
});

test("credentialForRewrite（v2.64，接入引导 / 登录引导与命令行向导同一条规则）：口令模式打开着时集群上没带过也带上；关着照旧只保住", { skip }, async (t) => {
  const plain = sandbox(t);
  plain.provision(7891); // 集群上的 env.sh 不带口令
  for (const mode of ["observe", "enforce"]) {
    assert.deepEqual(await service(plain, { mode }).sync.credentialForRewrite("server-01"), CRED, mode);
  }
  assert.equal(await service(plain, { mode: "off" }).sync.credentialForRewrite("server-01"), null, "关：原来不带就不加");
  assert.equal(await service(plain, { mode: "enforce", credential: null }).sync.credentialForRewrite("server-01"), null, "本机没有口令");
  assert.equal(await service(plain, { mode: "enforce" }).sync.credentialForRewrite("mine"), null, "个人服务器没有受管配置");

  const withCred = sandbox(t);
  withCred.provision(7891, { credential: CRED });
  assert.deepEqual(await service(withCred, { mode: "off", credential: NEW_CRED }).sync.credentialForRewrite("server-01"), NEW_CRED, "关但写过：保住（换成本机当前的）");

  // 口令模式读不出来（存储抛错）按关处理，不让整次重写失败。
  const broken = createClusterEnvSync({ getConfig: async () => configWith(7891), runRemote: plain.runRemote, autoCheck: false, getProxyCredential: () => CRED, getProxyAuthMode: () => { throw new Error("EACCES"); } });
  assert.equal(await broken.credentialForRewrite("server-01"), null);

  // 后台的端口同步不跟着加：模式打开着、集群上原来不带 → 改端口时照旧不带（第一次放口令只由人来点）。
  const moved = service(plain, { mode: "enforce" });
  moved.setPort(7895);
  await moved.sync.check("server-01"); // 排在自动同步之后
  assert.match(plain.envFile(), /^export HTTPS_PROXY="http:\/\/127\.0\.0\.1:7895"$/m);
  assertNoSecret(plain, moved.logs);
});
