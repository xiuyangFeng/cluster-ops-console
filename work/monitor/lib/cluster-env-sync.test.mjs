// 集群侧受管配置跟随反向端口：端口变更后自动同步、定期只读检测、用户点的强制同步。
// 远端命令一律在临时 HOME 里用本机 sh 真跑（与向导 / 撤销的测试同一做法），不碰真实配置与集群。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildClusterEnvSteps, buildEnvPortReadCommand, CLAUDE_SETTINGS_READ_COMMAND, mergeClaudeSettingsEnv, parseEnvPortRead, planClaudeSettingsMerge, renderClusterEnv } from "./cluster-env.mjs";
import { CLUSTER_ENV_CHECK_INTERVAL_MS, CLUSTER_ENV_RETRY_INTERVAL_MS, createClusterEnvSync, isClusterEnvEligible } from "./cluster-env-sync.mjs";

const skip = process.platform === "win32" ? "远端脚本用本机 sh 执行，需要 POSIX 环境" : false;
const teamServer = (remotePort) => ({ id: "server-01", host: "h", source: "team", remotePort });
const configWith = (remotePort, extra = []) => ({ activeServerId: "server-01", servers: [teamServer(remotePort), ...extra] });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// 临时 HOME + 用本机 sh 执行"远端"命令；calls 记录每条命令，fail(command) 返回真值时模拟 SSH 失败。
function sandbox(t, { fail = () => false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-sync-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const runRemote = async (_server, _config, command, options = {}) => {
    calls.push(command);
    if (fail(command)) return { code: 255, stdout: "", stderr: "Connection closed by remote host" };
    const res = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", input: options.input });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const sh = (command, input) => spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", input });
  const envPort = () => parseEnvPortRead(sh(buildEnvPortReadCommand()).stdout);
  // 向导第 4 步的落地状态：env.sh + 引入块（+ 可选的 Claude settings 代理键）
  const provision = (port, { claude = false } = {}) => {
    for (const step of buildClusterEnvSteps({ port })) assert.equal(sh(step.command).status, 0, step.id);
    if (claude) {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude/settings.json"), `${JSON.stringify({ env: { FOO: "1" } }, null, 2)}\n`);
      const plan = planClaudeSettingsMerge(sh(CLAUDE_SETTINGS_READ_COMMAND).stdout, { port });
      assert.equal(sh(plan.command, plan.input).status, 0);
    }
  };
  const settings = () => JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  return { home, runRemote, calls, envPort, provision, settings };
}

function service(box, { port = 7891, now = () => 1000, personal = {}, autoCheck = false } = {}) {
  const current = { config: configWith(port) };
  const logs = [];
  const sync = createClusterEnvSync({
    getConfig: async () => current.config,
    getPersonalConfig: () => personal,
    runRemote: box.runRemote,
    now,
    log: (line) => logs.push(line),
    autoCheck,
  });
  const setPort = (next) => {
    current.config = configWith(next);
    sync.onConfigRefreshed(current.config);
  };
  sync.onConfigRefreshed(current.config);
  return { sync, setPort, logs, current };
}

test("isClusterEnvEligible: 只认团队服务器、未禁用、建隧道", () => {
  assert.equal(isClusterEnvEligible(teamServer(7891)), true);
  assert.equal(isClusterEnvEligible({ ...teamServer(7891), source: "personal" }), false);
  assert.equal(isClusterEnvEligible({ ...teamServer(7891), disabled: true }), false);
  assert.equal(isClusterEnvEligible({ ...teamServer(7891), tunnel: false }), false);
  assert.equal(isClusterEnvEligible(null), false);
});

test("端口从 7891 改成 7893 → env.sh 与仍指向旧端口的 Claude 代理键自动跟到 7893，其余内容不动", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { claude: true });
  const { sync, setPort } = service(box);
  assert.equal(box.calls.length, 0, "首次登记端口只记不动，不发 SSH");

  setPort(7893);
  const state = await sync.check("server-01"); // 排在自动同步之后
  assert.equal(state.state, "in-sync");
  assert.deepEqual(box.envPort(), { present: true, port: 7893 });
  assert.equal(box.settings().env.HTTPS_PROXY, "http://127.0.0.1:7893");
  assert.equal(box.settings().env.FOO, "1");
  assert.deepEqual(state.lastSync.changed, ["~/.config/cluster-workbench/env.sh", "~/.claude/settings.json"]);
  assert.equal(state.lastSync.ok, true);
  assert.equal(state.lastSync.from, 7891);
  assert.equal(state.lastSync.to, 7893);
  assert.equal(state.lastSync.trigger, "port-change");
});

test("改过去又改回来（7891 → 7893 → 7891）：最终指向 7891", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891);
  const { sync, setPort } = service(box);
  setPort(7893);
  setPort(7891);
  assert.equal((await sync.check("server-01")).state, "in-sync");
  assert.deepEqual(box.envPort(), { present: true, port: 7891 });
});

test("env.sh 指向的不是变更前的端口（另一台电脑 / 手改）→ 自动同步不覆盖，只报不一致；用户强制同步才改", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7900);
  const { sync, setPort } = service(box);
  setPort(7893);
  const state = await sync.check("server-01");
  assert.equal(state.state, "drift");
  assert.equal(state.envPort, 7900);
  assert.equal(state.expectedPort, 7893);
  assert.deepEqual(box.envPort(), { present: true, port: 7900 }, "没有被擅自改写");

  const forced = await sync.sync("server-01", { force: true });
  assert.equal(forced.status, "synced");
  assert.equal(forced.state.lastSync.trigger, "manual");
  assert.deepEqual(box.envPort(), { present: true, port: 7893 });
});

test("集群上没有受管 env.sh（没跑过向导）→ 不凭空创建", { skip }, async (t) => {
  const box = sandbox(t);
  const { sync, setPort } = service(box);
  setPort(7893);
  assert.equal((await sync.check("server-01")).state, "absent");
  assert.equal((await sync.sync("server-01", { force: true })).status, "absent");
  assert.equal(fs.existsSync(path.join(box.home, ".config/cluster-workbench")), false);
});

test("用户改过的 Claude 代理键不动；NO_PROXY 的内网直连名单随 env.sh 一起带上", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7891, { claude: true });
  const edited = box.settings();
  edited.env.HTTPS_PROXY = "http://127.0.0.1:40161";
  fs.writeFileSync(path.join(box.home, ".claude/settings.json"), JSON.stringify(edited));
  const { sync, setPort } = service(box, { personal: { noProxyExtra: { "server-01": ["10.0.0.5"] } } });
  setPort(7893);
  const state = await sync.check("server-01");
  assert.deepEqual(state.lastSync.changed, ["~/.config/cluster-workbench/env.sh"]);
  assert.equal(box.settings().env.HTTPS_PROXY, "http://127.0.0.1:40161");
  assert.match(fs.readFileSync(path.join(box.home, ".config/cluster-workbench/env.sh"), "utf8"), /NO_PROXY="localhost,127\.0\.0\.1,::1,10\.0\.0\.5"/);
});

test("写 env.sh 失败 → 记为失败、文件保持原样、状态仍是不一致；之后可以重试", { skip }, async (t) => {
  let broken = true;
  const box = sandbox(t, { fail: (command) => broken && /env\.sh\.tmp|cluster-workbench\/env\.sh/.test(command) && !/__CWB_ENV_PORT__/.test(command) });
  box.provision(7891);
  const { sync, setPort } = service(box);
  setPort(7893);
  const state = await sync.check("server-01");
  assert.equal(state.state, "drift");
  assert.equal(state.lastSync.ok, false);
  assert.match(state.lastSync.error, /Connection closed by remote host/);
  assert.deepEqual(box.envPort(), { present: true, port: 7891 });

  broken = false;
  assert.equal((await sync.sync("server-01", { force: true })).status, "synced");
  assert.deepEqual(box.envPort(), { present: true, port: 7893 });
});

test("读不到集群（SSH 不通）→ 保留上一次的结论并带上 error，不把通道故障写成不一致", { skip }, async (t) => {
  let down = false;
  const box = sandbox(t, { fail: () => down });
  box.provision(7891);
  const { sync } = service(box);
  assert.equal((await sync.check("server-01")).state, "in-sync");
  down = true;
  const state = await sync.check("server-01");
  assert.equal(state.state, "in-sync");
  assert.match(state.error, /读取集群配置失败/);
  assert.equal((await sync.sync("server-01", { force: true })).status, "failed");
});

test("个人服务器 / 没有端口：不在范围内，不发 SSH", async (t) => {
  const box = sandbox(t);
  const config = { servers: [{ id: "mine", host: "x", source: "personal", remotePort: 7900 }, { id: "server-01", host: "h", source: "team" }] };
  const sync = createClusterEnvSync({ getConfig: async () => config, runRemote: box.runRemote, autoCheck: false });
  sync.onConfigRefreshed(config);
  assert.equal(await sync.check("mine"), null);
  assert.equal((await sync.sync("mine", { force: true })).status, "ineligible");
  assert.equal((await sync.sync("server-01", { force: true })).status, "no-port");
  assert.equal(box.calls.length, 0);
});

test("getState：过期才在后台补查一轮，查不成按较短间隔重试；没登记过的服务器不查", { skip }, async (t) => {
  const box = sandbox(t);
  box.provision(7900);
  let clock = 1_000_000;
  const { sync } = service(box, { port: 7891, now: () => clock, autoCheck: true });
  assert.equal(sync.getState("unknown-server"), null);
  assert.equal(sync.getState("server-01"), null, "第一次只触发检测");
  await sync.check("server-01");
  const reads = () => box.calls.filter((c) => c === buildEnvPortReadCommand()).length;
  const afterFirst = reads();
  assert.equal(sync.getState("server-01").state, "drift");
  assert.equal(sync.getState("server-01").envPort, 7900);
  await settle();
  assert.equal(reads(), afterFirst, "没过期不再发 SSH");
  assert.deepEqual(box.envPort(), { present: true, port: 7900 }, "检测到不一致也绝不自动改写");

  clock += CLUSTER_ENV_CHECK_INTERVAL_MS;
  sync.getState("server-01");
  await sync.check("server-01");
  assert.ok(reads() > afterFirst);
  assert.ok(CLUSTER_ENV_RETRY_INTERVAL_MS < CLUSTER_ENV_CHECK_INTERVAL_MS);
});

test("renderClusterEnv 的输出能被端口读取命令认出来（带代理口令时也一样）", { skip }, (t) => {
  const box = sandbox(t);
  const file = path.join(box.home, ".config/cluster-workbench/env.sh");
  assert.deepEqual(box.envPort(), { present: false, port: null });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderClusterEnv({ port: 7894, credential: { user: "u", password: "p" } }));
  assert.deepEqual(box.envPort(), { present: true, port: 7894 });
  fs.writeFileSync(file, "export HTTPS_PROXY=socks5h://127.0.0.1:1080\n");
  assert.deepEqual(box.envPort(), { present: true, port: null });
  assert.equal(parseEnvPortRead("motd only\n"), null);
  assert.ok(mergeClaudeSettingsEnv("{}", { port: 7894 }).changed);
});
