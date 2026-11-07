// 接入管理：名下的端口登记、释放闲置端口、撤销接入（预览 → 确认 → 逐步执行）。
// 用一个"假世界"把整条路走通：临时「集群 HOME」+ 临时登记目录里用真实 /bin/sh 执行生成的远端命令
// （假 ss 报监听、假 stat 报别人名下的登记），个人配置是临时文件、经真实的配置管理器（savePersonalConfig）读写。
// 全程不 ssh、不碰真实的个人配置与集群。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCliTaskLock } from "../cli/task-lock.mjs";
import { envFor, writeExec } from "../cli/test-support.mjs";
import { buildClusterEnvSteps, buildCommentOutCommand, CLAUDE_SETTINGS_READ_COMMAND, planClaudeSettingsMerge } from "../cluster-env.mjs";
import { createConfigManager } from "../config-hot-reload.mjs";
import { ConfigValidationError } from "../config-loader.mjs";
import { buildRegistrySurveyCommand, buildReleaseCommand } from "../port-registry.mjs";
import {
  ACCESS_REGISTRY_TTL_MS,
  buildDropPortPatch,
  createAccessManager,
  describeConfigError,
  describeRemoteFailure,
  effectivePersonalPort,
  UNDO_PREVIEW_TTL_MS,
} from "./access.mjs";
import { buildUndoSurveyCommand } from "./undo-survey.mjs";

const skip = process.platform === "win32" ? "远端脚本用本机 sh 执行，需要 POSIX 环境" : false;
const ME = os.userInfo().username;
const SERVER_ID = "server-01";
const BASHRC = "# mine\nexport http_proxy=http://alice:s3cret@10.0.0.9:7890\nalias ll='ls -l'\n";
const BASH_PROFILE = "export PATH=$HOME/bin:$PATH\n";
const SETTINGS = `${JSON.stringify({ env: { FOO: "1" }, hooks: {} }, null, 4)}\n`;

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// personal：个人配置文件的初始内容（null = 文件不存在）；team：并进团队 config.json 的字段。
function createWorld(t, { personal = { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 } } }, team = {}, registry = true, manager = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-access-"));
  const home = path.join(root, "home");
  const registryDir = path.join(root, "ports");
  fs.mkdirSync(path.join(home, "fakebin"), { recursive: true });
  if (registry) fs.mkdirSync(registryDir);

  const configPath = path.join(root, "config.json");
  const localConfigPath = path.join(root, "config.local.json");
  fs.writeFileSync(configPath, JSON.stringify({ activeServerId: SERVER_ID, portRegistry: { dir: registryDir }, servers: [{ id: SERVER_ID, name: "主集群", host: "myserver" }], ...team }));
  if (personal) fs.writeFileSync(localConfigPath, JSON.stringify(personal));
  const configManager = createConfigManager({ configPath, localConfigPath });

  const world = {
    root, home, registryDir, configPath, localConfigPath, configManager,
    calls: [],
    // respond(command) 返回对象 = 这条命令不真跑，直接回这个结果；gate(command) 可以让某条命令等一等。
    respond: null,
    gate: null,
    clock: { t: 1_800_000_000_000 },
    slots: { active: 0, max: 0, taken: 0 },
    refreshes: 0,
    logs: [],
    guide: { busy: false, resets: 0, dismissed: [] },
    taskLock: createCliTaskLock(),
    // 撤销结束后「集群上变了」的通知（生产里接的是 CLI 登录状态重测）
    changed: [],
    ids: 0,
  };
  // 被测代码对这些命令没有自己的时限（时限在真实的 SSH 执行器里），所以这里只防"永远不回来"：给到 5 分钟。
  // 机器很忙时起一个 sh 偶尔要几十秒，时限短了会把一次慢读成"没读到"，用例跟着误报。
  world.sh = (command, { input } = {}) => {
    const res = spawnSync("/bin/sh", ["-c", command], { env: envFor(home), encoding: "utf8", input: input ?? "", timeout: 300000 });
    return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "", timedOut: false };
  };
  world.runRemote = async (server, _config, command, { input, timeoutMs } = {}) => {
    world.calls.push({ command, input, timeoutMs, serverId: server.id });
    const canned = world.respond?.(command);
    if (canned) return { code: 0, stdout: "", stderr: "", timedOut: false, ...canned };
    if (world.gate) await world.gate(command);
    return world.sh(command, { input });
  };
  world.manager = createAccessManager({
    getConfig: configManager.getConfig,
    getPersonalConfig: configManager.getPersonalConfig,
    savePersonalConfig: configManager.savePersonalConfig,
    refreshConfigIntoKernel: async () => {
      world.refreshes += 1;
    },
    runRemote: world.runRemote,
    acquireSshSlot: async () => {
      world.slots.active += 1;
      world.slots.taken += 1;
      world.slots.max = Math.max(world.slots.max, world.slots.active);
      return () => {
        world.slots.active -= 1;
      };
    },
    taskLock: world.taskLock,
    onboardingGuide: {
      getBrief: () => ({ busy: world.guide.busy }),
      reset: () => {
        world.guide.resets += 1;
      },
      setDismissed: (value) => world.guide.dismissed.push(value),
    },
    onClusterChanged: (serverId) => world.changed.push(serverId),
    now: () => world.clock.t,
    newId: () => {
      world.ids += 1;
      return `id-${world.ids}`;
    },
    log: (message, fields) => world.logs.push([message, fields?.level || "info"]),
    ...manager,
  });

  world.register = (port) => fs.writeFileSync(path.join(registryDir, String(port)), `user=${ME}\n`);
  world.registered = (port) => fs.existsSync(path.join(registryDir, String(port)));
  // 假可执行文件用到才写，写完先各跑一次（macOS 对新写出的可执行文件首次执行要做一次安全评估，别算进被测流程里）。
  const fakeBin = (name, script) => {
    const file = path.join(home, "fakebin", name);
    if (fs.existsSync(file)) return;
    writeExec(file, script);
    spawnSync(file, [], { env: envFor(home), encoding: "utf8" });
  };
  // 假 ss：$HOME/listening 里一行一个正在监听的端口。
  world.setListening = (ports) => {
    fakeBin("ss", '#!/bin/sh\necho "State Recv-Q Send-Q Local Address:Port Peer Address:Port"\nif [ -f "$HOME/listening" ]; then while read -r p; do echo "LISTEN 0 128 127.0.0.1:$p 0.0.0.0:*"; done < "$HOME/listening"; fi\n');
    fs.writeFileSync(path.join(home, "listening"), ports.map((p) => `${p}\n`).join(""));
  };
  // 假 stat：只接 `stat -c %U <路径>`。$HOME/owners 里写了「端口 属主」的报那个属主（模拟别人名下的登记），
  // 其余退出 1——登记脚本会退回 `ls -ld`，得到真实属主（跑测试的这个账号）。
  world.setOwners = (map) => {
    fakeBin("stat", '#!/bin/sh\n[ "$1" = "-c" ] && [ "$2" = "%U" ] && [ -f "$HOME/owners" ] || exit 1\nowner=$(awk -v p="$(basename "$3")" \'$1 == p { print $2 }\' "$HOME/owners")\n[ -n "$owner" ] || exit 1\necho "$owner"\n');
    fs.writeFileSync(path.join(home, "owners"), Object.entries(map).map(([port, owner]) => `${port} ${owner}\n`).join(""));
  };
  world.personal = () => JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  world.read = (rel) => fs.readFileSync(path.join(home, rel), "utf8");
  world.exists = (rel) => fs.existsSync(path.join(home, rel));
  world.commands = () => world.calls.map((call) => call.command);
  world.sent = (command) => world.commands().filter((item) => item === command).length;
  // 读端口登记（等后台那一轮读完）。
  world.access = async (options) => {
    await world.manager.getAccess(options);
    await world.manager.whenIdle();
    return world.manager.getAccess();
  };
  // 接入时会写下的东西：受管文件与两处引入块、注释掉的旧导出、key 文件、settings.json 的代理键、端口登记。
  world.onboard = ({ port = 7893 } = {}) => {
    fs.writeFileSync(path.join(home, ".bashrc"), BASHRC);
    fs.writeFileSync(path.join(home, ".bash_profile"), BASH_PROFILE);
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude/settings.json"), SETTINGS);
    for (const step of buildClusterEnvSteps({ port })) assert.equal(world.sh(step.command).code, 0, step.id);
    assert.equal(world.sh(buildCommentOutCommand(".bashrc", [2])).code, 0);
    const keys = path.join(home, ".config/cluster-workbench/keys");
    fs.mkdirSync(keys, { recursive: true });
    fs.writeFileSync(path.join(keys, "codex-relay.env"), "export RELAY_KEY='sk-do-not-print-me'\n", { mode: 0o600 });
    const merge = planClaudeSettingsMerge(world.sh(CLAUDE_SETTINGS_READ_COMMAND).stdout, { port });
    assert.equal(world.sh(merge.command, { input: merge.input }).code, 0);
    world.register(port);
    world.setListening([port]);
  };
  world.undone = () => world.read(".bashrc") === BASHRC && world.read(".bash_profile") === BASH_PROFILE && world.read(".claude/settings.json") === SETTINGS && !world.exists(".config/cluster-workbench");
  // 收尾：先等后台那一轮读完（读接口会在后台发一次 SSH），再删临时目录。
  t.after(async () => {
    await world.manager.whenIdle().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  return world;
}

const surveyCommand = (world) => buildRegistrySurveyCommand(world.registryDir);
const rejectsWith = (promise, status, code) => assert.rejects(promise, (error) => {
  assert.equal(error.status, status, error.message);
  assert.equal(error.code, code, error.message);
  return true;
});
const stepStates = (job) => job.steps.map((step) => `${step.id}=${step.status}`);

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("buildDropPortPatch：两处都拿，只拿 remotePort——localPort 留着，本机代理不换端口", () => {
  // 命令行向导写的 portOverrides
  assert.deepEqual(
    buildDropPortPatch({ sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 }, other: { remotePort: 7900 } } }, SERVER_ID),
    { portOverrides: { [SERVER_ID]: { localPort: 8893 }, other: { remotePort: 7900 } } },
  );
  assert.deepEqual(buildDropPortPatch({ portOverrides: { [SERVER_ID]: { remotePort: 7893 } } }, SERVER_ID), { portOverrides: {} }, "这一项拿空了就去掉这一项");
  // 界面里领的 / 重新分配的：servers 里同 id 的覆盖条目
  assert.deepEqual(
    buildDropPortPatch({ servers: [{ id: SERVER_ID, remotePort: 7893 }, { id: "tx", host: "1.2.3.4", sshUser: "u", remotePort: 7900, password: "x" }] }, SERVER_ID),
    { servers: [{ id: "tx", host: "1.2.3.4", sshUser: "u", remotePort: 7900 }] },
    "只剩 id 的覆盖条目整条去掉；其余条目照登记表的做法剥掉不该落盘的字段",
  );
  assert.deepEqual(
    buildDropPortPatch({ servers: [{ id: SERVER_ID, remotePort: 7893, localPort: 8893, tunnel: true }] }, SERVER_ID),
    { servers: [{ id: SERVER_ID, localPort: 8893, tunnel: true }] },
  );
  // 两处都有
  assert.deepEqual(
    buildDropPortPatch({ portOverrides: { [SERVER_ID]: { remotePort: 7891 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }] }, SERVER_ID),
    { portOverrides: {}, servers: [] },
  );
  // 给了端口：只拿等于它的那一处（释放闲置端口时清旧记录用），生效的那个不动
  const both = { portOverrides: { [SERVER_ID]: { remotePort: 7892, localPort: 8892 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }] };
  assert.deepEqual(buildDropPortPatch(both, SERVER_ID, { port: 7892 }), { portOverrides: { [SERVER_ID]: { localPort: 8892 } } });
  assert.deepEqual(buildDropPortPatch(both, SERVER_ID, { port: 7893 }), { servers: [] });
  assert.equal(buildDropPortPatch(both, SERVER_ID, { port: 7895 }), null);
  assert.deepEqual(buildDropPortPatch({ portOverrides: { [SERVER_ID]: { remotePort: "7892" } } }, SERVER_ID, { port: 7892 }), { portOverrides: {} }, "数字串也认");
  // 没有可拿的
  assert.equal(buildDropPortPatch({ sshUser: "amy" }, SERVER_ID), null);
  assert.equal(buildDropPortPatch({ portOverrides: { [SERVER_ID]: { localPort: 8893 } }, servers: [{ id: SERVER_ID, disabled: true }] }, SERVER_ID), null);
  assert.equal(buildDropPortPatch({ portOverrides: [], servers: "junk" }, SERVER_ID), null);
  assert.equal(buildDropPortPatch(null, SERVER_ID), null);
});

test("effectivePersonalPort：个人层此刻生效的端口——servers 覆盖条目优先，其次 portOverrides", () => {
  assert.equal(effectivePersonalPort({ portOverrides: { [SERVER_ID]: { remotePort: 7892 } } }, SERVER_ID), 7892);
  assert.equal(effectivePersonalPort({ portOverrides: { [SERVER_ID]: { remotePort: 7892 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }] }, SERVER_ID), 7893);
  // 覆盖条目没写端口（只是屏蔽 / 改别的）或写坏了：还是 portOverrides 那个
  assert.equal(effectivePersonalPort({ portOverrides: { [SERVER_ID]: { remotePort: 7892 } }, servers: [{ id: SERVER_ID, tunnel: true }] }, SERVER_ID), 7892);
  assert.equal(effectivePersonalPort({ portOverrides: { [SERVER_ID]: { remotePort: "7892" } }, servers: [{ id: SERVER_ID, remotePort: "abc" }] }, SERVER_ID), 7892);
  // 别的服务器的不算；个人层没记端口 → null
  assert.equal(effectivePersonalPort({ portOverrides: { other: { remotePort: 7900 } }, servers: [{ id: "tx", remotePort: 7901 }] }, SERVER_ID), null);
  for (const personal of [null, {}, { servers: "x", portOverrides: [] }, { portOverrides: { [SERVER_ID]: null } }]) assert.equal(effectivePersonalPort(personal, SERVER_ID), null);
});

test("describeConfigError：校验没过时把是哪个字段、为什么一起带上", () => {
  assert.equal(describeConfigError(new Error("配置已被修改，请重新加载后保存")), "配置已被修改，请重新加载后保存");
  assert.equal(
    describeConfigError(new ConfigValidationError("个人服务器配置未通过校验", [{ field: "servers[0].bogus", message: "团队服务器不允许覆盖该字段" }])),
    "个人服务器配置未通过校验（servers[0].bogus：团队服务器不允许覆盖该字段）",
  );
  const many = new ConfigValidationError("个人服务器配置未通过校验", [1, 2, 3, 4, 5].map((n) => ({ field: `servers[${n}].host`, message: "不对" })));
  assert.equal(describeConfigError(many), "个人服务器配置未通过校验（servers[1].host：不对；servers[2].host：不对；servers[3].host：不对 等 5 处）");
  assert.equal(describeConfigError(null), "个人配置没有写成");
});

test("describeRemoteFailure：认得出的原因说人话，认不出的给 ssh 的最后一行", () => {
  assert.deepEqual(describeRemoteFailure("", { timedOut: true }), { code: "timeout", message: "连接服务器超时，当前网络可能不在集群的 SSH 白名单内" });
  assert.equal(describeRemoteFailure("ssh: connect to host x port 22: Operation timed out").code, "timeout");
  assert.equal(describeRemoteFailure("ssh: connect to host x port 22: Connection refused").code, "refused");
  assert.equal(describeRemoteFailure("amy@x: Permission denied (publickey).").message, "登录服务器失败，用户名或密钥不对");
  assert.deepEqual(describeRemoteFailure("banner line\nmv: cannot move: Disk quota exceeded\n"), { code: "unknown", message: "mv: cannot move: Disk quota exceeded" });
  assert.equal(describeRemoteFailure("", { exitCode: 0 }).message, "服务器没有给出完整的结果");
  assert.equal(describeRemoteFailure("", { exitCode: 3 }).message, "ssh 退出码 3");
  assert.equal(describeRemoteFailure(undefined).message, "ssh 退出码 未知");
  // 原话要显示在界面上、记进日志：控制字符换掉，地址里的账号口令不带出来，只有空白的行不算最后一行
  assert.equal(describeRemoteFailure("curl: (7) Failed to connect via http://amy:s3cret@127.0.0.1:7893\n").message, "curl: (7) Failed to connect via http://***@127.0.0.1:7893");
  assert.equal(describeRemoteFailure("\u001b[31mrm: cannot remove\u001b[0m\n \t \n").message, "[31mrm: cannot remove [0m");
});

// ---------------------------------------------------------------------------
// 读：有没有可管理的、名下的端口登记
// ---------------------------------------------------------------------------

test("还没接入过（没有端口、也没记下集群账号）→ 不可用，一条 SSH 都不发", async (t) => {
  const world = createWorld(t, { personal: null });
  const view = await world.access();
  assert.deepEqual([view.available, view.reason, view.registry, view.port], [false, "not-connected", null, null]);
  assert.equal(world.calls.length, 0);
  await rejectsWith(world.manager.previewUndo(), 409, "not-connected");
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "not-connected");
});

test("不可用的其它情形：团队配置里没有那台服务器 / 选了「我不在这个集群」/ 个人配置读不出来", async (t) => {
  const none = createWorld(t, { team: { servers: [{ id: "server-02", host: "other" }] } });
  assert.equal((await none.access()).reason, "no-team-server");
  const disabled = createWorld(t, { personal: { sshUser: "amy", servers: [{ id: SERVER_ID, disabled: true }] } });
  assert.equal((await disabled.access()).reason, "disabled");
  const broken = createWorld(t);
  await broken.configManager.getConfig();
  fs.writeFileSync(broken.localConfigPath, "{not json");
  assert.equal((await broken.access()).reason, "personal-config");
  assert.equal(none.calls.length + disabled.calls.length + broken.calls.length, 0);
});

test("读端口登记：先回本机已知的（pending），后台读完再给名下的端口——在用 / 被监听 / 闲置", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7894, 7895, 7896]) world.register(port);
  world.setOwners({ 7896: "zhang" });
  world.setListening([7893, 7894]);

  const first = await world.manager.getAccess();
  assert.equal(first.available, true);
  assert.deepEqual(first.server, { id: SERVER_ID, name: "主集群", host: "myserver" });
  assert.equal(first.port, 7893);
  assert.deepEqual([first.registry.pending, first.registry.checkedAt, first.registry.ports.length], [true, null, 0]);

  await world.manager.whenIdle();
  const view = await world.manager.getAccess();
  assert.deepEqual(view.registry.ports, [
    { port: 7893, current: true, listening: true, releasable: false },
    { port: 7894, current: false, listening: true, releasable: false },
    { port: 7895, current: false, listening: false, releasable: true },
  ], "别人名下的 7896 不在表里");
  assert.deepEqual([view.registry.state, view.registry.me, view.registry.dir, view.registry.pending, view.registry.error], ["ok", ME, world.registryDir, false, null]);
  assert.deepEqual(view.registry.current, { port: 7893, owner: "me", name: ME });
  assert.equal(view.registry.checkedAt, world.clock.t);
  assert.equal(world.sent(surveyCommand(world)), 1);
  assert.equal(world.calls[0].timeoutMs, 15000);
  assert.equal(world.slots.taken, 1, "SSH 经调度器槽位");
});

test("读端口登记：一分钟内不重复发 SSH；并发的读合并成一次；fresh 与过期才重读", { skip }, async (t) => {
  const world = createWorld(t);
  world.register(7893);
  await Promise.all([world.manager.getAccess(), world.manager.getAccess(), world.manager.getAccess()]);
  await world.manager.whenIdle();
  assert.equal(world.calls.length, 1, "三个并发的读只发了一次");
  await world.access();
  world.clock.t += ACCESS_REGISTRY_TTL_MS - 1;
  await world.access();
  assert.equal(world.calls.length, 1, "缓存有效期内不再发");
  await world.access({ fresh: true });
  assert.equal(world.calls.length, 2);
  world.clock.t += ACCESS_REGISTRY_TTL_MS;
  await world.access();
  assert.equal(world.calls.length, 3, "过期后重读");
  assert.equal(world.slots.max, 1);
});

test("读端口登记：这台电脑在用的端口不在自己名下 / 没登记 / 登记目录没建", { skip }, async (t) => {
  const other = createWorld(t);
  other.register(7893);
  other.register(7895);
  other.setOwners({ 7893: "simple" });
  const viewOther = await other.access();
  assert.deepEqual(viewOther.registry.current, { port: 7893, owner: "other", name: "simple" });
  assert.deepEqual(viewOther.registry.ports, [{ port: 7895, current: false, listening: false, releasable: true }]);

  const unregistered = createWorld(t);
  assert.deepEqual((await unregistered.access()).registry.current, { port: 7893, owner: "none", name: "" });

  const absent = createWorld(t, { registry: false });
  const viewAbsent = await absent.access();
  assert.deepEqual([viewAbsent.registry.state, viewAbsent.registry.ports, viewAbsent.registry.error], ["absent", [], null]);
});

test("读端口登记：端口记在 servers 覆盖条目里（界面里领的）一样认得出在用；被它盖住的旧端口算闲置", { skip }, async (t) => {
  // 命令行向导领过 7892（记在 portOverrides），后来在界面里「重新分配」到 7893（记在 servers 覆盖条目，生效的是它）
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7892, localPort: 8892 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }] } });
  for (const port of [7892, 7893, 7895]) world.register(port);
  const view = await world.access();
  assert.equal(view.port, 7893, "合并后生效的是 servers 里那个");
  assert.deepEqual(view.registry.ports.map((row) => [row.port, row.current, row.releasable]), [[7892, false, true], [7893, true, false], [7895, false, true]]);
});

test("释放改端口时留下的旧端口：先把个人配置里那条被盖住的旧记录清掉，再放登记；生效的端口与隧道不动", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7892, localPort: 8892 }, other: { remotePort: 7900 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }], revision: 3 } });
  for (const port of [7892, 7893]) world.register(port);
  const result = await world.manager.releasePort({ port: 7892 });
  assert.deepEqual([result.result, result.clearedStaleConfig], ["ok", true]);
  assert.equal(world.registered(7892), false);
  const personal = world.personal();
  assert.deepEqual(personal.portOverrides, { [SERVER_ID]: { localPort: 8892 }, other: { remotePort: 7900 } }, "旧端口从配置里拿掉了，localPort 留着");
  assert.deepEqual(personal.servers, [{ id: SERVER_ID, remotePort: 7893 }], "生效的那个不动");
  assert.equal(personal.revision, 4);
  assert.equal(world.refreshes, 1);
  assert.deepEqual([result.access.port, result.access.registry.ports.map((row) => row.port)], [7893, [7893]]);
  assert.equal((await world.configManager.getConfig()).servers.find((server) => server.id === SERVER_ID).remotePort, 7893, "隧道用的端口没变");
  assert.ok(world.logs.some(([message]) => message.includes("stale record removed from personal config")));
  // 配置里没有旧记录的闲置端口：只放登记，不写个人配置
  world.register(7895);
  const plain = await world.manager.releasePort({ port: 7895 });
  assert.equal(plain.clearedStaleConfig, false);
  assert.equal(world.personal().revision, 4);
});

test("释放时旧记录清不掉（个人配置写不成）→ 停在这里，登记不动", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7892 } }, servers: [{ id: SERVER_ID, remotePort: 7893 }] } });
  for (const port of [7892, 7893]) world.register(port);
  const manager = createAccessManager({
    getConfig: world.configManager.getConfig,
    getPersonalConfig: world.configManager.getPersonalConfig,
    savePersonalConfig: async () => {
      throw Object.assign(new Error("配置已被修改，请重新加载后保存"), { status: 409 });
    },
    runRemote: world.runRemote,
  });
  await assert.rejects(manager.releasePort({ port: 7892 }), (error) => {
    assert.deepEqual([error.status, error.code], [409, "stale-config"]);
    assert.match(error.message, /个人配置里还记着端口 7892，没能把这条旧记录清掉（配置已被修改，请重新加载后保存），登记没有动/);
    return true;
  });
  assert.equal(world.registered(7892), true);
  assert.equal(world.commands().some((command) => /RELEASE=/.test(command)), false, "释放命令没有发出去");
  assert.equal(manager.busyNotice(), null);
  assert.deepEqual(world.personal().portOverrides, { [SERVER_ID]: { remotePort: 7892 } });
});

test("读端口登记：连不上服务器 → 如实给出原因，不当成「没有登记」；之后重试成功即恢复", { skip }, async (t) => {
  const world = createWorld(t);
  world.register(7893);
  world.respond = () => ({ code: 255, stderr: "ssh: connect to host myserver port 22: Operation timed out" });
  const failed = await world.access();
  assert.deepEqual([failed.registry.state, failed.registry.ports.length, failed.registry.error.code], ["unknown", 0, "timeout"]);
  assert.match(failed.registry.error.message, /白名单/);
  // 输出里没有 REGISTRY 行（只回了横幅）同样是"没读到"
  world.respond = () => ({ stdout: "Welcome to the cluster\n" });
  const garbled = await world.access({ fresh: true });
  assert.deepEqual([garbled.registry.state, garbled.registry.error.message], ["unknown", "服务器没有给出完整的结果"]);
  world.respond = null;
  const recovered = await world.access({ fresh: true });
  assert.deepEqual([recovered.registry.state, recovered.registry.error, recovered.registry.ports.length], ["ok", null, 1]);
});

test("读端口登记：执行器抛错也不让读接口失败", async (t) => {
  const world = createWorld(t, { manager: { runRemote: async () => { throw new Error("spawn ssh ENOENT"); } } });
  const view = await world.access();
  assert.equal(view.available, true);
  assert.deepEqual([view.registry.state, view.registry.error.message, view.registry.pending], ["unknown", "spawn ssh ENOENT", false]);
});

// ---------------------------------------------------------------------------
// 释放一个闲置的登记端口
// ---------------------------------------------------------------------------

test("释放闲置端口：登记文件删除，表里少一行，不必再读一遍", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7895]) world.register(port);
  await world.access();
  const before = world.calls.length;
  const result = await world.manager.releasePort({ serverId: SERVER_ID, port: 7895 });
  assert.deepEqual([result.port, result.result], [7895, "ok"]);
  assert.equal(world.registered(7895), false);
  assert.equal(world.registered(7893), true, "别的登记不动");
  assert.deepEqual(result.access.registry.ports.map((row) => row.port), [7893]);
  assert.equal(result.access.busy, null);
  assert.deepEqual(world.commands().slice(before), [surveyCommand(world), buildReleaseCommand(world.registryDir, 7895)], "先重新读一遍，再发释放命令");
  assert.equal((await world.manager.getAccess()).registry.pending, false, "释放之后不另发一轮读");
  assert.ok(world.logs.some(([message]) => message.includes("released registered port 7895")));
  assert.deepEqual(world.personal().portOverrides, { [SERVER_ID]: { remotePort: 7893, localPort: 8893 } }, "个人配置不动");
});

test("在用的端口不能单独释放：这台电脑在用的、正在被监听的、别人名下的、没登记的一律拒绝，登记文件都还在", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7894, 7896]) world.register(port);
  world.setListening([7894]);
  world.setOwners({ 7896: "zhang" });
  await rejectsWith(world.manager.releasePort({ port: 7893 }), 409, "port-in-use");
  await rejectsWith(world.manager.releasePort({ port: 7894 }), 409, "port-listening");
  await rejectsWith(world.manager.releasePort({ port: 7896 }), 409, "not-owner");
  await rejectsWith(world.manager.releasePort({ port: 7897 }), 409, "absent");
  for (const port of [7893, 7894, 7896]) assert.equal(world.registered(port), true, String(port));
  assert.equal(world.commands().some((command) => /RELEASE=/.test(command)), false, "一条释放命令都没发");
  await assert.rejects(world.manager.releasePort({ port: 7893 }), /请用「撤销接入」/);
});

test("个人配置刚在别处改过端口（命令行向导 / 手改，这个进程还没重载）：磁盘上此刻生效的端口同样算在用，不能单独释放", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7892, localPort: 8892 } } } });
  for (const port of [7892, 7895]) world.register(port);
  assert.deepEqual((await world.access()).registry.ports.map((row) => [row.port, row.current, row.releasable]), [[7892, true, false], [7895, false, true]]);
  // 不经过配置管理器直接改盘：合并配置的缓存还停在 7892
  const onDisk = JSON.stringify({ sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7895, localPort: 8892 } } });
  fs.writeFileSync(world.localConfigPath, onDisk);
  assert.equal((await world.configManager.getConfig()).servers.find((server) => server.id === SERVER_ID).remotePort, 7892, "前提：缓存没跟上");

  const view = await world.access({ fresh: true });
  assert.deepEqual(view.registry.ports.map((row) => [row.port, row.current, row.releasable]), [[7892, true, false], [7895, true, false]], "两个都算在用");
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "port-in-use");
  await rejectsWith(world.manager.releasePort({ port: 7892 }), 409, "port-in-use");
  assert.deepEqual([world.registered(7892), world.registered(7895)], [true, true]);
  assert.equal(world.commands().some((command) => /RELEASE=/.test(command)), false);
  assert.equal(fs.readFileSync(world.localConfigPath, "utf8"), onDisk, "个人配置一个字没动");
});

test("读登记的那几秒里端口被别处写进了个人配置（「重新分配端口」沿用了名下这个闲置端口）→ 发释放命令之前再看一遍，拒绝", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7892, localPort: 8892 } } } });
  for (const port of [7892, 7895]) world.register(port);
  await world.access();
  // 读登记的 SSH 还在路上时，配置改成了 7895
  world.gate = async (command) => {
    if (command === surveyCommand(world)) await world.configManager.savePersonalConfig({ portOverrides: { [SERVER_ID]: { remotePort: 7895, localPort: 8892 } } });
  };
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "port-in-use");
  world.gate = null;
  assert.equal(world.registered(7895), true, "刚写进配置的端口，登记没有被放掉");
  assert.equal(world.commands().some((command) => /RELEASE=/.test(command)), false);
  assert.equal(world.personal().portOverrides[SERVER_ID].remotePort, 7895, "刚写进去的记录也没有被当成旧记录清掉");
  assert.equal(world.manager.busyNotice(), null);
});

test("释放前的判断用的是此刻的登记与监听，不是缓存：缓存里闲置、现在在被监听 → 拒绝", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7895]) world.register(port);
  const cached = await world.access();
  assert.equal(cached.registry.ports.find((row) => row.port === 7895).releasable, true);
  world.setListening([7895]);
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "port-listening");
  assert.equal(world.registered(7895), true);
  assert.equal((await world.manager.getAccess()).registry.ports.find((row) => row.port === 7895).listening, true, "表也跟着更新了");
});

test("释放：参数不对 400；不是那台服务器 409；登记目录没建 409；读不到登记 502——都没有改动", { skip }, async (t) => {
  const world = createWorld(t);
  world.register(7895);
  for (const port of [undefined, "abc", 0, 70000, 78.5]) await rejectsWith(world.manager.releasePort({ port }), 400, "form");
  await rejectsWith(world.manager.releasePort({ serverId: "server-02", port: 7895 }), 409, "server-mismatch");
  world.respond = () => ({ code: 255, stderr: "Connection refused" });
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 502, "survey-failed");
  world.respond = null;
  assert.equal(world.registered(7895), true);
  const absent = createWorld(t, { registry: false });
  await rejectsWith(absent.manager.releasePort({ port: 7895 }), 409, "no-registry");
});

test("释放命令没有明确结论（SSH 中途断了）→ 502，下一次读必须重新问远端", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7895]) world.register(port);
  await world.access();
  world.respond = (command) => (/RELEASE=/.test(command) ? { code: 255, stderr: "Connection closed by remote host" } : null);
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 502, "release-failed");
  world.respond = null;
  const before = world.sent(surveyCommand(world));
  const view = await world.access();
  assert.equal(world.sent(surveyCommand(world)), before + 1, "缓存已作废");
  assert.deepEqual(view.registry.ports.map((row) => row.port), [7893, 7895]);
  assert.ok(world.logs.some(([message, level]) => message.includes("did not succeed") && level === "warn"));
});

test("释放：同一时刻只做一个；接入引导正在执行步骤时不做", { skip }, async (t) => {
  const world = createWorld(t);
  for (const port of [7893, 7895, 7896]) world.register(port);
  const hold = deferred();
  world.gate = async (command) => {
    if (/RELEASE=/.test(command)) await hold.promise;
  };
  const first = world.manager.releasePort({ port: 7895 });
  // 等第一个走到释放命令（卡在闸门上）
  while (!world.commands().some((command) => /RELEASE=/.test(command))) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(world.manager.busyNotice(), "正在释放端口");
  assert.deepEqual((await world.manager.getAccess()).busy, { kind: "release", port: 7895 });
  await rejectsWith(world.manager.releasePort({ port: 7896 }), 409, "busy");
  await rejectsWith(world.manager.previewUndo(), 409, "busy");
  const during = world.calls.length;
  await world.manager.getAccess({ fresh: true });
  assert.equal(world.calls.length, during, "动作进行中读接口不另发 SSH");
  hold.resolve();
  assert.equal((await first).result, "ok");
  assert.equal(world.manager.busyNotice(), null);
  assert.equal(world.registered(7896), true);

  world.guide.busy = true;
  await rejectsWith(world.manager.releasePort({ port: 7896 }), 409, "guide-busy");
  await rejectsWith(world.manager.previewUndo(), 409, "guide-busy");
});

// ---------------------------------------------------------------------------
// 撤销：预览
// ---------------------------------------------------------------------------

test("预览：逐条列出会改哪些文件、恢复什么、删什么；只读；key 的内容与代理口令都不带出来", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const snapshotBefore = spawnSync("/bin/sh", ["-c", `cd "${world.root}" && find home ports -type f -exec cksum {} + | sort`], { encoding: "utf8" }).stdout;
  const { preview, access } = await world.manager.previewUndo({ serverId: SERVER_ID });

  assert.deepEqual(preview.steps, [
    { id: "strip-source-blocks", title: "删除 shell 启动文件里引入代理配置的那几行", effect: "change", items: ["~/.bashrc", "~/.bash_profile"], note: "" },
    { id: "remove-env", title: "删除 ~/.config/cluster-workbench/ 里的代理配置与保存的 API key", effect: "change", items: ["~/.config/cluster-workbench/env.sh", "keys/ 里的 1 个文件（codex-relay.env），是登录时保存的 API key"], note: "" },
    { id: "restore-strays", title: "恢复接入时被注释掉的旧代理设置", effect: "change", items: ["~/.bashrc 第 2 行：export http_proxy=http://***@10.0.0.9:7890"], note: "" },
    { id: "claude-settings", title: "从 ~/.claude/settings.json 里删除工作台写入的代理设置", effect: "change", items: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"], note: "" },
  ]);
  assert.deepEqual([preview.serverId, preview.host, preview.port, preview.nothingToUndo, preview.notes], [SERVER_ID, "myserver", 7893, false, []]);
  assert.deepEqual(preview.release, { port: 7893, available: true, owner: "me", note: "登记在你名下。释放后别人可以领走它，这台电脑上的隧道随之停止。" });
  // 确认框里的后果说明：不释放与释放各一段，释放那段写明会断网
  assert.equal(preview.consequences.keep, "撤销后，集群上新开的终端里代理设置回到接入之前的样子，codex / claude 在新终端里不再经这台电脑出网；已经在运行的不受影响。端口 7893 的登记和这台电脑上的隧道保留，之后重新走一遍接入引导即可恢复。");
  assert.equal(preview.consequences.release, "撤销后这台电脑不再为集群上的 codex / claude 提供出网，已经在运行的会断网。端口 7893 从这台电脑的配置里拿掉，隧道随之停止；要再用，重新走接入引导领取端口。");
  assert.match(preview.consequences.release, /撤销后这台电脑不再为集群上的 codex \/ claude 提供出网，已经在运行的会断网。.*隧道随之停止/);
  assert.equal(preview.expiresAt - preview.createdAt, UNDO_PREVIEW_TTL_MS);
  assert.equal(typeof preview.previewId, "string");
  assert.equal(access.busy, null);
  assert.deepEqual(access.registry.ports, [{ port: 7893, current: true, listening: true, releasable: false }], "顺带把登记表读新了");

  // 只读：三条读命令，家目录与登记目录里每个文件的校验和都没变
  assert.deepEqual(world.commands(), [buildUndoSurveyCommand(), CLAUDE_SETTINGS_READ_COMMAND, surveyCommand(world)]);
  assert.equal(spawnSync("/bin/sh", ["-c", `cd "${world.root}" && find home ports -type f -exec cksum {} + | sort`], { encoding: "utf8" }).stdout, snapshotBefore);
  assert.deepEqual(world.personal(), { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 } } });
  const everything = JSON.stringify({ preview, access });
  assert.doesNotMatch(everything, /do-not-print-me/, "key 文件只列名字");
  assert.doesNotMatch(everything, /s3cret/, "旧代理地址里的口令不显示");
});

test("预览：集群上什么都没有 → 每一步都标「不会改动」；有端口时仍可确认（为了放端口），没有端口就没什么可撤销的", { skip }, async (t) => {
  const withPort = createWorld(t);
  const first = (await withPort.manager.previewUndo()).preview;
  assert.deepEqual(first.steps.map((step) => [step.id, step.effect]), [["strip-source-blocks", "none"], ["remove-env", "none"], ["restore-strays", "none"], ["claude-settings", "none"]]);
  assert.equal(first.steps[0].note, "没有发现，这一步不会改动任何东西");
  assert.equal(first.steps[3].note, "集群上没有 Claude Code，无需处理");
  assert.equal(first.nothingToUndo, false);
  assert.deepEqual([first.release.available, first.release.owner], [true, "none"]);
  assert.match(first.release.note, /登记目录里没有这个端口的登记。勾选后只从这台电脑的配置里拿掉它/);

  const noPort = createWorld(t, { personal: { sshUser: "amy" } });
  const second = (await noPort.manager.previewUndo()).preview;
  assert.deepEqual(second.steps.map((step) => step.id), ["strip-source-blocks", "remove-env", "restore-strays"], "没有端口时不碰 settings.json");
  assert.deepEqual([second.nothingToUndo, second.release, second.port, second.consequences.release], [true, null, null, null]);
  assert.match(second.notes[0], /没有配置反向端口.*settings\.json.*不会自动删除/);
  assert.equal(noPort.sent(CLAUDE_SETTINGS_READ_COMMAND), 0);
  assert.equal(noPort.sent(surveyCommand(noPort)), 0, "没有端口就不为释放去读登记");
});

test("预览：settings.json 里没有我们写的键 / 不是合法 JSON → 如实说明，不算要改", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  fs.writeFileSync(path.join(world.home, ".claude/settings.json"), SETTINGS);
  assert.deepEqual((await world.manager.previewUndo()).preview.steps[3], { id: "claude-settings", title: "从 ~/.claude/settings.json 里删除工作台写入的代理设置", effect: "none", items: [], note: "里面没有工作台写入的代理设置，无需改动" });
  fs.writeFileSync(path.join(world.home, ".claude/settings.json"), "{not json");
  assert.equal((await world.manager.previewUndo()).preview.steps[3].note, "文件不是合法的 JSON，保持不动，请自行检查");
});

test("预览：同时释放端口这一项随登记现状变——别人名下 / 目录没建 / 没读到 / 端口写在团队配置里", { skip }, async (t) => {
  const other = createWorld(t);
  other.register(7893);
  other.setOwners({ 7893: "simple" });
  const viaOther = (await other.manager.previewUndo()).preview.release;
  assert.deepEqual([viaOther.available, viaOther.owner], [true, "other"]);
  assert.match(viaOther.note, /登记在 simple 名下，不会动那份登记/);

  const absent = createWorld(t, { registry: false });
  assert.match((await absent.manager.previewUndo()).preview.release.note, /没有可用的端口登记目录/);

  const flaky = createWorld(t);
  flaky.respond = (command) => (command === surveyCommand(flaky) ? { code: 255, stderr: "Connection reset by peer" } : null);
  const viaFlaky = (await flaky.manager.previewUndo()).preview.release;
  assert.deepEqual([viaFlaky.available, viaFlaky.owner], [true, "unknown"]);
  assert.match(viaFlaky.note, /这次没读到端口登记（Connection reset by peer）/);

  // 端口写在团队 config.json 里：个人配置里没有它，拿不掉 → 不给释放（放了登记隧道却还在用）
  const teamPort = createWorld(t, { personal: { sshUser: "amy" }, team: { servers: [{ id: SERVER_ID, name: "主集群", host: "myserver", remotePort: 7893 }] } });
  teamPort.register(7893);
  const viaTeam = (await teamPort.manager.previewUndo()).preview;
  assert.equal(viaTeam.port, 7893);
  assert.equal(viaTeam.release.available, false);
  assert.match(viaTeam.release.note, /写在团队配置里/);
  await assert.rejects(teamPort.manager.runUndo({ previewId: viaTeam.previewId, releasePort: true }), (error) => {
    assert.deepEqual([error.status, error.code], [409, "release-unavailable"]);
    assert.match(error.message, /写在团队配置里/);
    return true;
  });
  assert.equal(teamPort.registered(7893), true);
  // 不勾选释放的撤销照常可以做（预览还在）
  await teamPort.manager.runUndo({ previewId: viaTeam.previewId });
  await teamPort.manager.whenIdle();
  assert.equal((await teamPort.manager.getAccess()).undo.status, "ok");
  assert.equal(teamPort.registered(7893), true);
});

test("团队配置给不出端口登记目录（写坏了又不许回落默认）：登记不读、不放，也不改用默认目录；只撤销照常", { skip }, async (t) => {
  const world = createWorld(t, { manager: { resolveRegistryDir: () => null } });
  world.onboard();
  const view = await world.access();
  assert.deepEqual([view.registry.state, view.registry.ports, view.registry.error.code], ["invalid", [], "invalid-dir"]);
  assert.equal(world.calls.length, 0, "没有目录就不发读登记的 SSH");
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "no-registry");
  const { preview } = await world.manager.previewUndo();
  assert.equal(preview.release.available, false);
  assert.match(preview.release.note, /端口登记目录写得不对/);
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId, releasePort: true }), 409, "release-unavailable");
  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
  assert.equal(world.commands().some((command) => /RELEASE=|REGISTRY=/.test(command)), false, "从头到尾没碰过任何登记目录");
  assert.equal(world.registered(7893), true);
});

test("预览之后团队配置里的登记目录变了（换了一个 / 改坏了）→ 要释放就得重新预览，绝不换个目录去放；不释放的照常", { skip }, async (t) => {
  let dir = null;
  const world = createWorld(t, { manager: { resolveRegistryDir: () => dir } });
  dir = world.registryDir;
  world.onboard();
  const other = path.join(world.root, "ports-other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "7893"), `user=${ME}\n`);

  const first = (await world.manager.previewUndo()).preview;
  assert.equal(first.release.available, true);
  dir = other;
  await rejectsWith(world.manager.runUndo({ previewId: first.previewId, releasePort: true }), 409, "preview-stale");
  dir = null;
  await rejectsWith(world.manager.runUndo({ previewId: first.previewId, releasePort: true }), 409, "preview-stale");
  assert.equal(world.commands().some((command) => /RELEASE=/.test(command)), false, "一条释放命令都没发");
  assert.deepEqual([world.registered(7893), fs.existsSync(path.join(other, "7893"))], [true, true], "两个目录里的登记都没动");
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true, "集群上也一个字没动");
  assert.equal((await world.manager.getAccess()).undo, null);
  assert.equal(world.taskLock.current(SERVER_ID), null);

  // 预览没有作废：目录改回来，或者不释放，都可以接着确认
  dir = other;
  await world.manager.runUndo({ previewId: first.previewId });
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
  assert.deepEqual([world.registered(7893), fs.existsSync(path.join(other, "7893"))], [true, true]);
});

test("团队最早的生产端口（7891）：表里标出来，释放之前写明放掉就拿不回来", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "kai", portOverrides: { [SERVER_ID]: { remotePort: 7891, localPort: 8888 } } } });
  for (const port of [7891, 7893]) world.register(port);
  const view = await world.access();
  assert.deepEqual(view.registry.ports, [
    { port: 7891, current: true, listening: false, releasable: false, base: true },
    { port: 7893, current: false, listening: false, releasable: true },
  ]);
  const { preview } = await world.manager.previewUndo();
  assert.deepEqual([preview.release.available, preview.release.owner], [true, "me"]);
  assert.equal(preview.release.note, "登记在你名下。释放后这台电脑上的隧道随之停止。7891 是团队最早的生产端口：放掉之后工作台不会再把它分给任何人（包括你），重新接入只能领到新的端口。");
  assert.equal(world.calls.some((call) => /RELEASE=/.test(call.command)), false);
  // 别的端口不带这句
  const other = createWorld(t);
  other.register(7893);
  assert.doesNotMatch((await other.manager.previewUndo()).preview.release.note, /生产端口/);
});

test("预览：连不上服务器 → 502、说明原因、不留预览（没法接着确认）；安装 / 登录占着任务锁时 409", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  world.respond = () => ({ code: 255, stderr: "ssh: connect to host myserver port 22: Operation timed out" });
  await assert.rejects(world.manager.previewUndo(), (error) => {
    assert.deepEqual([error.status, error.code], [502, "survey-failed"]);
    assert.match(error.message, /读不到集群上现在的配置（连接服务器超时.*没有做任何改动/);
    return true;
  });
  // 第一条读成了、settings.json 那条断了：同样整个预览作废
  world.respond = (command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { code: 255, stderr: "Connection closed by remote host" } : null);
  await rejectsWith(world.manager.previewUndo(), 502, "survey-failed");
  world.respond = null;
  await rejectsWith(world.manager.runUndo({ previewId: "id-1" }), 409, "preview-required");
  assert.equal(world.manager.busyNotice(), null, "失败后不留占用");

  const unlock = world.taskLock.acquire(SERVER_ID, { kind: "install", cli: "codex" });
  await assert.rejects(world.manager.previewUndo(), (error) => {
    assert.deepEqual([error.status, error.code, error.busy.kind], [409, "busy", "install"]);
    assert.match(error.message, /正在进行 codex 的安装 \/ 更新/);
    return true;
  });
  unlock();
  assert.equal(typeof (await world.manager.previewUndo()).preview.previewId, "string");
});

// ---------------------------------------------------------------------------
// 撤销：执行
// ---------------------------------------------------------------------------

test("撤销必须先预览：没有 / 对不上 / 过期 / 预览之后端口变了 / 已经用过，都要求重新预览，什么都不做", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  await rejectsWith(world.manager.runUndo({}), 409, "preview-required");
  const { preview } = await world.manager.previewUndo();
  await rejectsWith(world.manager.runUndo({ previewId: "someone-elses" }), 409, "preview-required");
  await rejectsWith(world.manager.runUndo({ previewId: 42 }), 409, "preview-required");
  await rejectsWith(world.manager.runUndo({ serverId: "server-02", previewId: preview.previewId }), 409, "server-mismatch");

  world.clock.t += UNDO_PREVIEW_TTL_MS + 1;
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId }), 409, "preview-expired");

  const second = (await world.manager.previewUndo()).preview;
  await world.configManager.savePersonalConfig({ portOverrides: { [SERVER_ID]: { remotePort: 7899, localPort: 8893 } } });
  await rejectsWith(world.manager.runUndo({ previewId: second.previewId }), 409, "preview-stale");
  await world.configManager.savePersonalConfig({ portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 } } });

  const calls = world.calls.length;
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true, "到这里集群上一个字都没动");
  assert.equal((await world.manager.getAccess()).undo, null);

  const third = (await world.manager.previewUndo()).preview;
  await world.manager.runUndo({ previewId: third.previewId });
  await world.manager.whenIdle();
  await rejectsWith(world.manager.runUndo({ previewId: third.previewId }), 409, "preview-required");
  assert.ok(world.calls.length > calls);
});

test("往返（保留端口）：写入 → 预览 → 撤销 → 启动文件与 settings.json 逐字回到原样；端口登记、个人配置、隧道都不动", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const personalBefore = fs.readFileSync(world.localConfigPath, "utf8");
  const { preview } = await world.manager.previewUndo();
  const started = await world.manager.runUndo({ serverId: SERVER_ID, previewId: preview.previewId, releasePort: false });
  assert.deepEqual([started.access.undo.status, started.access.busy], ["running", { kind: "undo" }]);
  assert.deepEqual(started.access.undo.steps.map((step) => step.id), ["strip-source-blocks", "remove-env", "restore-strays", "claude-settings"], "不释放端口时没有那两步");
  await world.manager.whenIdle();

  assert.equal(world.undone(), true);
  assert.equal(world.registered(7893), true);
  assert.equal(fs.readFileSync(world.localConfigPath, "utf8"), personalBefore, "个人配置一个字节都没变");
  assert.equal(world.refreshes, 0);

  const view = await world.manager.getAccess();
  const job = view.undo;
  assert.equal(job.status, "ok");
  assert.deepEqual(stepStates(job), ["strip-source-blocks=ok", "remove-env=ok", "restore-strays=ok", "claude-settings=ok"]);
  assert.equal(job.steps[3].detail, "已删除 HTTP_PROXY、HTTPS_PROXY、http_proxy、https_proxy、NO_PROXY、no_proxy");
  assert.equal(job.summary, "集群上的代理配置已撤销。端口 7893 的登记和这台电脑上的隧道保留。");
  assert.equal(job.leftovers.length, 6, "沿用命令行那份清单");
  assert.match(job.leftovers[0], /authorized_keys/);
  assert.match(job.leftovers[4], /端口 7893 的登记和这台电脑上的隧道都保留着，隧道仍在运行/);
  assert.deepEqual([job.port, job.releasePort, job.finishedAt], [7893, false, world.clock.t]);
  assert.equal(view.port, 7893);
  assert.equal(view.busy, null);
  // 做成之后：引导的进度清掉并记成「稍后再说」；任务锁放开；记了运维日志
  assert.deepEqual([world.guide.resets, world.guide.dismissed], [1, [true]]);
  assert.equal(world.taskLock.current(SERVER_ID), null);
  assert.ok(world.logs.some(([message]) => /undo on server-01 ok \(release=false/.test(message)));
  assert.deepEqual(world.changed, [SERVER_ID], "keys/ 里的 API key 删了：通知一次，让 CLI 的登录状态重测");
});

test("往返（同时释放端口）：登记文件删除，个人配置里的端口拿掉（走 savePersonalConfig：留 .bak、版本号 +1），别的字段原样", { skip }, async (t) => {
  const world = createWorld(t, {
    personal: {
      sshUser: "amy",
      activeServerId: SERVER_ID,
      egress: { mode: "system" },
      noProxyExtra: { [SERVER_ID]: ["10.1.2.3"] },
      portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 }, other: { remotePort: 7900, localPort: 8900 } },
      revision: 4,
    },
  });
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  const started = await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  assert.deepEqual(started.access.undo.steps.map((step) => [step.id, step.title]).slice(-2), [["release-port", "释放端口登记 7893"], ["local-port", "从这台电脑的配置里拿掉端口 7893"]]);
  await world.manager.whenIdle();

  assert.equal(world.undone(), true);
  assert.equal(world.registered(7893), false);
  const personal = world.personal();
  assert.deepEqual(personal.portOverrides, { [SERVER_ID]: { localPort: 8893 }, other: { remotePort: 7900, localPort: 8900 } }, "只拿掉这台的 remotePort");
  assert.deepEqual([personal.sshUser, personal.activeServerId, personal.egress, personal.noProxyExtra, personal.revision], ["amy", SERVER_ID, { mode: "system" }, { [SERVER_ID]: ["10.1.2.3"] }, 5]);
  assert.equal(JSON.parse(fs.readFileSync(`${world.localConfigPath}.bak`, "utf8")).revision, 4, "写前留了备份");
  assert.equal(world.refreshes, 1, "配置重新载入一次（隧道随之停止）");

  const view = await world.access();
  const job = view.undo;
  assert.equal(job.status, "ok");
  assert.deepEqual(stepStates(job), ["strip-source-blocks=ok", "remove-env=ok", "restore-strays=ok", "claude-settings=ok", "release-port=ok", "local-port=ok"]);
  assert.deepEqual([job.steps[4].detail, job.steps[5].detail], ["登记已删除", "隧道会在几秒内停止"]);
  assert.equal(job.summary, "集群上的代理配置已撤销。端口 7893 已从这台电脑的配置里拿掉，隧道会在几秒内停止。");
  assert.match(job.leftovers[4], /隧道会在几秒内自己停止.*grep 7893/);
  assert.deepEqual([view.port, view.registry.ports, view.registry.current], [null, [], null], "首页会回到「未领取端口」");
  assert.deepEqual([world.guide.resets, world.guide.dismissed], [1, [true]]);
  // 发出去的写命令都带 20 秒时限；settings.json 的新内容走标准输入
  const writes = world.calls.filter((call) => call.timeoutMs === 20000);
  assert.equal(writes.length, 5);
  assert.equal(world.calls.find((call) => call.input != null).input, SETTINGS);
});

test("命令行向导接入的电脑（个人配置里只有端口、没记集群账号）：撤销并释放后算「没接入」，这一次的结果照样随读接口给出", { skip }, async (t) => {
  const world = createWorld(t, { personal: { portOverrides: { [SERVER_ID]: { remotePort: 7893, localPort: 8893 } } } });
  world.onboard();
  assert.equal((await world.access()).available, true, "有端口就算接入过");
  const { preview } = await world.manager.previewUndo();
  assert.equal(preview.release.available, true);
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await world.manager.whenIdle();
  assert.equal(world.undone(), true);
  assert.equal(world.registered(7893), false);
  assert.deepEqual(world.personal().portOverrides, { [SERVER_ID]: { localPort: 8893 } });

  const sentBefore = world.calls.length;
  const view = await world.access();
  assert.deepEqual([view.available, view.reason, view.port, view.registry], [false, "not-connected", null, null]);
  assert.equal(world.calls.length, sentBefore, "没接入了：不再为读登记去连服务器");
  // 界面靠这份结果把逐步结论和收尾清单留到用户点「知道了」
  assert.equal(view.undo.status, "ok");
  assert.deepEqual(stepStates(view.undo), ["strip-source-blocks=ok", "remove-env=ok", "restore-strays=ok", "claude-settings=ok", "release-port=ok", "local-port=ok"]);
  assert.equal(view.undo.summary, "集群上的代理配置已撤销。端口 7893 已从这台电脑的配置里拿掉，隧道会在几秒内停止。");
  assert.equal(view.undo.leftovers.length, 6);
  await rejectsWith(world.manager.previewUndo(), 409, "not-connected");
});

test("往返（界面里领的端口：记在 servers 覆盖条目）：释放后覆盖条目去掉，自己加的服务器原样", { skip }, async (t) => {
  const tx = { id: "tx", name: "腾讯云", host: "1.2.3.4", sshUser: "ubuntu", remotePort: 7900, tunnel: true };
  const world = createWorld(t, { personal: { sshUser: "amy", servers: [{ id: SERVER_ID, remotePort: 7893 }, tx] } });
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await world.manager.whenIdle();
  const personal = world.personal();
  assert.equal(personal.servers.length, 1);
  assert.deepEqual([personal.servers[0].id, personal.servers[0].host, personal.servers[0].sshUser, personal.servers[0].remotePort, personal.servers[0].tunnel], ["tx", "1.2.3.4", "ubuntu", 7900, true]);
  assert.equal((await world.manager.getAccess()).port, null);
  assert.equal(world.registered(7893), false);
  assert.equal(world.undone(), true);
});

test("同时释放端口，但登记在别人名下 / 本来就没登记：不动那份登记，本机端口照样拿掉（与命令行一致）", { skip }, async (t) => {
  const other = createWorld(t);
  other.onboard();
  other.setOwners({ 7893: "simple" });
  const first = (await other.manager.previewUndo()).preview;
  await other.manager.runUndo({ previewId: first.previewId, releasePort: true });
  await other.manager.whenIdle();
  const jobOther = (await other.manager.getAccess()).undo;
  assert.deepEqual(stepStates(jobOther).slice(-2), ["release-port=skipped", "local-port=ok"]);
  assert.equal(jobOther.steps.at(-2).detail, "登记在别人名下，没有动那份登记");
  assert.equal(other.registered(7893), true, "别人的登记还在");
  assert.deepEqual(other.personal().portOverrides, { [SERVER_ID]: { localPort: 8893 } });
  assert.equal(jobOther.status, "ok");

  const absent = createWorld(t, { registry: false });
  const second = (await absent.manager.previewUndo()).preview;
  await absent.manager.runUndo({ previewId: second.previewId, releasePort: true });
  await absent.manager.whenIdle();
  const jobAbsent = (await absent.manager.getAccess()).undo;
  assert.deepEqual(stepStates(jobAbsent).slice(-2), ["release-port=skipped", "local-port=ok"]);
  assert.equal(jobAbsent.steps.at(-2).detail, "登记目录里没有这个端口的登记，无需释放");
  assert.deepEqual(absent.personal().portOverrides, { [SERVER_ID]: { localPort: 8893 } });
});

test("某一步没做成 → 停在那里：后面的集群步骤、释放端口、本机端口都不做，如实标出；修好后再撤销一次即可", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const personalBefore = fs.readFileSync(world.localConfigPath, "utf8");
  const { preview } = await world.manager.previewUndo();
  const before = world.calls.length;
  world.respond = (command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { code: 255, stderr: "Warning: banner\nssh: connect to host myserver port 22: Operation timed out" } : null);
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await world.manager.whenIdle();
  assert.equal(world.calls.length - before, 2, "失败之后一条命令都没再发");

  const failedView = await world.manager.getAccess();
  const job = failedView.undo;
  assert.equal(job.status, "failed");
  assert.deepEqual(stepStates(job), ["strip-source-blocks=ok", "remove-env=failed", "restore-strays=not-run", "claude-settings=not-run", "release-port=not-run", "local-port=not-run"]);
  assert.equal(job.steps[1].detail, "连接服务器超时，当前网络可能不在集群的 SSH 白名单内");
  assert.match(job.steps[1].manual, /^sh -c 'rm -f ~\/\.config\/cluster-workbench\/env\.sh/, "带上可以手动执行的命令");
  assert.equal(job.summary, "停在「删除 ~/.config/cluster-workbench/ 里的代理配置与保存的 API key」这一步，后面的没有执行。处理好原因后再撤销一次即可，已经做完的步骤不会重复改动。");
  assert.deepEqual(job.leftovers, []);
  // 现场：第一步做了（引入块没了），其余原封不动
  assert.doesNotMatch(world.read(".bashrc"), /cluster-workbench env/);
  assert.match(world.read(".bashrc"), /已停用/);
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true);
  assert.match(world.read(".claude/settings.json"), /HTTPS_PROXY/);
  assert.equal(world.registered(7893), true);
  assert.equal(fs.readFileSync(world.localConfigPath, "utf8"), personalBefore);
  assert.deepEqual([world.guide.resets, world.refreshes], [0, 0], "没做成不清引导进度");
  assert.deepEqual(world.changed, [SERVER_ID], "半途停下集群上也可能已经变了：照样通知");
  assert.equal(world.taskLock.current(SERVER_ID), null, "任务锁放开了");
  assert.equal(failedView.busy, null);
  // 日志里留下停在哪一步、为什么（进度只在内存里，重启后只剩这一行）
  assert.ok(world.logs.some(([message, level]) => level === "warn"
    && message === "access: undo on server-01 failed (release=true; strip-source-blocks=ok remove-env=failed restore-strays=not-run claude-settings=not-run release-port=not-run local-port=not-run): 连接服务器超时，当前网络可能不在集群的 SSH 白名单内"));

  // 修好之后：重新预览（引入块已经没了）→ 再撤销 → 做完
  world.respond = null;
  const again = (await world.manager.previewUndo()).preview;
  assert.deepEqual(again.steps[0].effect, "none");
  await world.manager.runUndo({ previewId: again.previewId, releasePort: true });
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
  assert.equal(world.registered(7893), false);
});

test("停在 settings.json：读不到 → 没改它，也不放端口", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  world.respond = (command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { code: 255, stderr: "Connection closed by remote host" } : null);
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await world.manager.whenIdle();
  const job = (await world.manager.getAccess()).undo;
  assert.deepEqual(stepStates(job), ["strip-source-blocks=ok", "remove-env=ok", "restore-strays=ok", "claude-settings=failed", "release-port=not-run", "local-port=not-run"]);
  assert.equal(job.steps[3].detail, "Connection closed by remote host");
  assert.match(world.read(".claude/settings.json"), /HTTPS_PROXY/);
  assert.equal(world.registered(7893), true);
});

test("停在释放端口：本机配置不动；没有结论时不说成「登记没有改动」", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  world.respond = (command) => (/RELEASE=/.test(command) ? { code: 255, stderr: "Connection closed by remote host" } : null);
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await world.manager.whenIdle();
  const job = (await world.manager.getAccess()).undo;
  assert.equal(job.status, "failed");
  assert.deepEqual(stepStates(job).slice(-2), ["release-port=failed", "local-port=not-run"]);
  // 连接中途断了：删登记的那条命令可能已经执行了，也可能没有
  assert.equal(job.steps.at(-2).detail, "Connection closed by remote host。登记可能已经删掉，也可能没有；这台电脑的配置没有改动");
  assert.match(job.summary, /^停在「释放端口登记 7893」这一步，后面的没有执行。/);
  assert.equal(world.registered(7893), true);
  assert.deepEqual(world.personal().portOverrides[SERVER_ID], { remotePort: 7893, localPort: 8893 });
  assert.equal(world.guide.resets, 0);
  assert.equal(world.undone(), true, "集群侧的四步已经做完");
});

test("释放端口的三种没成：没看到结果行 / 超时（都没有结论）与服务器明说没删成（登记还在），说法各不相同", { skip }, async (t) => {
  const run = async (canned) => {
    const world = createWorld(t);
    world.onboard();
    const { preview } = await world.manager.previewUndo();
    world.respond = (command) => (/RELEASE=/.test(command) ? canned : null);
    await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
    await world.manager.whenIdle();
    const job = (await world.manager.getAccess()).undo;
    assert.deepEqual(stepStates(job).slice(-2), ["release-port=failed", "local-port=not-run"]);
    assert.equal(world.personal().portOverrides[SERVER_ID].remotePort, 7893, "本机配置不动");
    return job.steps.at(-2).detail;
  };
  assert.equal(await run({ code: 0, stdout: "motd only\n" }), "服务器没有给出明确结论。登记可能已经删掉，也可能没有；这台电脑的配置没有改动");
  assert.equal(await run({ code: null, timedOut: true }), "SSH 未在 20 秒内返回。登记可能已经删掉，也可能没有；这台电脑的配置没有改动");
  assert.equal(await run({ code: 0, stdout: "RELEASE=failed\n" }), "服务器上的登记文件没有删掉，登记还在；这台电脑的配置没有改动");
});

test("命令在服务器上跑了、是它自己失败的（退出码 1）：原因照它的输出说，不把 Permission denied 说成登录失败", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  world.respond = (command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { code: 1, stderr: "rm: cannot remove '/home/amy/.config/cluster-workbench/env.sh': Permission denied" } : null);
  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  const job = (await world.manager.getAccess()).undo;
  assert.deepEqual(stepStates(job).slice(0, 3), ["strip-source-blocks=ok", "remove-env=failed", "restore-strays=not-run"]);
  assert.equal(job.steps[1].detail, "rm: cannot remove '/home/amy/.config/cluster-workbench/env.sh': Permission denied");
  // ssh 自己没登进去（退出码 255）才是登录失败
  assert.equal(describeRemoteFailure("amy@myserver: Permission denied (publickey).", { exitCode: 255 }).message, "登录服务器失败，用户名或密钥不对");
  assert.equal(describeRemoteFailure("cp: cannot create regular file '/home/amy/.bashrc.bak.1': Permission denied", { exitCode: 1 }).message, "cp: cannot create regular file '/home/amy/.bashrc.bak.1': Permission denied");
  assert.equal(describeRemoteFailure("sh: line 3: publickey: command not found", { exitCode: 127 }).code, "unknown");
});

test("登记放掉了、个人配置却没写成 → 如实报：配置里还留着这个端口、隧道还在跑，先停连接；再撤销一次能补上", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  let failing = true;
  const manager = createAccessManager({
    getConfig: world.configManager.getConfig,
    getPersonalConfig: world.configManager.getPersonalConfig,
    savePersonalConfig: async (patch) => {
      if (failing) throw new Error("配置已被修改，请重新加载后保存");
      return world.configManager.savePersonalConfig(patch);
    },
    runRemote: world.runRemote,
    taskLock: world.taskLock,
    now: () => world.clock.t,
  });
  const first = (await manager.previewUndo()).preview;
  await manager.runUndo({ previewId: first.previewId, releasePort: true });
  await manager.whenIdle();
  const job = (await manager.getAccess()).undo;
  assert.equal(job.status, "failed");
  assert.deepEqual(stepStates(job).slice(-2), ["release-port=ok", "local-port=failed"]);
  assert.equal(job.steps.at(-1).detail, "配置已被修改，请重新加载后保存。这台电脑的配置里还留着这个端口，隧道还在往上面建：先在首页「停止所有连接」，修好个人配置后再撤销一次");
  assert.equal(world.registered(7893), false, "登记确实已经放掉了");
  assert.equal(world.personal().portOverrides[SERVER_ID].remotePort, 7893);

  failing = false;
  const second = (await manager.previewUndo()).preview;
  assert.equal(second.release.owner, "none");
  await manager.runUndo({ previewId: second.previewId, releasePort: true });
  await manager.whenIdle();
  const retry = (await manager.getAccess()).undo;
  assert.equal(retry.status, "ok");
  assert.deepEqual(stepStates(retry).slice(-2), ["release-port=skipped", "local-port=ok"]);
  assert.deepEqual(world.personal().portOverrides, { [SERVER_ID]: { localPort: 8893 } });
});

test("个人配置手改过、过不了保存时的校验：预览里就不给释放端口（写明哪个字段），直接要求释放 409；只撤销照常", { skip }, async (t) => {
  // 读的时候多余的键只是被忽略（端口照样生效），保存时却会被拒——登记放掉之后端口就拿不掉了
  const world = createWorld(t, { personal: { sshUser: "amy", servers: [{ id: SERVER_ID, remotePort: 7893, bogus: 1 }] } });
  world.onboard();
  assert.equal((await world.access()).port, 7893);
  const { preview } = await world.manager.previewUndo();
  assert.deepEqual([preview.release.available, preview.release.owner], [false, "unknown"]);
  assert.equal(preview.release.note, "这台电脑的个人配置现在保存不了（servers[0].bogus：团队服务器不允许覆盖该字段），端口拿不掉，所以不能在这里释放。先修好个人配置。");
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId, releasePort: true }), 409, "release-unavailable");
  assert.equal(world.registered(7893), true);
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true, "什么都还没做");

  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
  assert.equal(world.registered(7893), true);
  assert.deepEqual(world.personal().servers, [{ id: SERVER_ID, remotePort: 7893, bogus: 1 }]);
});

test("预览时还保存得了、确认前个人配置被改坏了 → 确认释放时再验一遍，409，什么都不做", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", servers: [{ id: SERVER_ID, remotePort: 7893 }] } });
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  assert.equal(preview.release.available, true);
  fs.writeFileSync(world.localConfigPath, JSON.stringify({ sshUser: "amy", servers: [{ id: SERVER_ID, remotePort: 7893, sshUser: "someone" }] }));
  await assert.rejects(world.manager.runUndo({ previewId: preview.previewId, releasePort: true }), (error) => {
    assert.deepEqual([error.status, error.code], [409, "release-unavailable"]);
    assert.equal(error.message, "这台电脑的个人配置现在保存不了（servers[0].sshUser：团队服务器不允许覆盖该字段），端口拿不掉，所以不能释放。先修好个人配置");
    return true;
  });
  assert.equal(world.registered(7893), true);
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true);
  assert.equal(world.taskLock.current(SERVER_ID), null);
});

test("拿掉本机端口时保存被拒（校验类错误）→ 原因里带上是哪个字段，并说明隧道还在这个端口上、先停连接", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const manager = createAccessManager({
    getConfig: world.configManager.getConfig,
    getPersonalConfig: world.configManager.getPersonalConfig,
    savePersonalConfig: async () => {
      throw new ConfigValidationError("端口覆盖未通过校验", [{ field: "portOverrides.other.remotePort", message: "端口必须是 1-65535 的整数" }]);
    },
    runRemote: world.runRemote,
    now: () => world.clock.t,
  });
  const { preview } = await manager.previewUndo();
  await manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await manager.whenIdle();
  const job = (await manager.getAccess()).undo;
  assert.deepEqual(stepStates(job).slice(-2), ["release-port=ok", "local-port=failed"]);
  assert.equal(job.steps.at(-1).detail, "端口覆盖未通过校验（portOverrides.other.remotePort：端口必须是 1-65535 的整数）。这台电脑的配置里还留着这个端口，隧道还在往上面建：先在首页「停止所有连接」，修好个人配置后再撤销一次");
  assert.equal(job.status, "failed");
});

test("写个人配置时带着读到的版本号：读写之间没有别的写者，照常写成；配置重载出错不影响结论", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy", portOverrides: { [SERVER_ID]: { remotePort: 7893 } }, revision: 9 } });
  world.onboard();
  const patches = [];
  const manager = createAccessManager({
    getConfig: world.configManager.getConfig,
    getPersonalConfig: world.configManager.getPersonalConfig,
    savePersonalConfig: async (patch) => {
      patches.push(patch);
      return world.configManager.savePersonalConfig(patch);
    },
    refreshConfigIntoKernel: async () => {
      throw new Error("reload failed");
    },
    runRemote: world.runRemote,
    log: (message, fields) => world.logs.push([message, fields?.level || "info"]),
  });
  const { preview } = await manager.previewUndo();
  await manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await manager.whenIdle();
  assert.deepEqual(patches, [{ portOverrides: {}, expectedRevision: 9 }], "只交了要改的字段");
  assert.equal((await manager.getAccess()).undo.status, "ok");
  assert.deepEqual([world.personal().portOverrides, world.personal().revision], [{}, 10]);
  assert.ok(world.logs.some(([message, level]) => message.includes("reload failed") && level === "warn"));
});

test("执行期间：占着 CLI 任务锁（安装 / 登录进不来）、别的动作 409、进度逐步可见、读接口不另发 SSH；结束即放开", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  const hold = deferred();
  world.gate = async (command) => {
    if (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command)) await hold.promise;
  };
  await world.manager.runUndo({ previewId: preview.previewId, releasePort: true });
  while (!world.commands().some((command) => /rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command))) await new Promise((resolve) => setImmediate(resolve));

  const during = await world.manager.getAccess({ fresh: true });
  assert.deepEqual(stepStates(during.undo), ["strip-source-blocks=ok", "remove-env=running", "restore-strays=pending", "claude-settings=pending", "release-port=pending", "local-port=pending"]);
  assert.deepEqual([during.undo.status, during.busy, during.registry.pending], ["running", { kind: "undo" }, false]);
  assert.equal(world.manager.busyNotice(), "正在撤销接入");
  const holder = world.taskLock.current(SERVER_ID);
  assert.deepEqual([holder.kind, holder.cli], ["undo", null]);
  assert.throws(() => world.taskLock.acquire(SERVER_ID, { kind: "install", cli: "codex" }), (error) => {
    assert.deepEqual([error.status, error.busy.kind], [409, "undo"]);
    assert.equal(error.message, "这台服务器上正在进行 撤销接入，请等它结束再试");
    return true;
  });
  await rejectsWith(world.manager.previewUndo(), 409, "busy");
  await rejectsWith(world.manager.releasePort({ port: 7895 }), 409, "busy");
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId }), 409, "busy");
  const sentDuring = world.calls.length;
  await world.manager.getAccess();
  assert.equal(world.calls.length, sentDuring);

  hold.resolve();
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.taskLock.current(SERVER_ID), null);
  assert.equal(world.manager.busyNotice(), null);
  assert.equal(world.slots.max, 1, "远端命令一条一条发");
});

test("安装 / 登录占着任务锁 → 撤销 409，预览不作废（等它结束可以直接确认）；接入引导在跑同样不做", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  const unlock = world.taskLock.acquire(SERVER_ID, { kind: "login", cli: "claude" });
  await assert.rejects(world.manager.runUndo({ previewId: preview.previewId }), (error) => {
    assert.deepEqual([error.status, error.code, error.busy.kind], [409, "busy", "login"]);
    return true;
  });
  assert.equal(world.exists(".config/cluster-workbench/env.sh"), true);
  unlock();
  world.guide.busy = true;
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId }), 409, "guide-busy");
  world.guide.busy = false;
  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  assert.equal(world.undone(), true);
});

test("没有端口的撤销（向导中途断了留下的半截状态）：三步照做；要求释放端口 400", { skip }, async (t) => {
  const world = createWorld(t, { personal: { sshUser: "amy" } });
  const [writeEnv] = buildClusterEnvSteps({ port: 7893 });
  assert.equal(world.sh(writeEnv.command).code, 0);
  const { preview } = await world.manager.previewUndo();
  assert.equal(preview.nothingToUndo, false);
  await rejectsWith(world.manager.runUndo({ previewId: preview.previewId, releasePort: true }), 400, "form");
  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  const job = (await world.manager.getAccess()).undo;
  assert.deepEqual(stepStates(job), ["strip-source-blocks=ok", "remove-env=ok", "restore-strays=ok"]);
  assert.equal(job.summary, "集群上的代理配置已撤销。");
  assert.match(job.leftovers[4], /^确认隧道已停：在工作台里停止隧道/);
  assert.equal(world.exists(".config/cluster-workbench"), false);
});

test("做成之后的收尾（清引导进度、通知重测）自己出错，不改变撤销的结论", { skip }, async (t) => {
  const world = createWorld(t, {
    manager: {
      onboardingGuide: { getBrief: () => ({ busy: false }), reset: () => { throw new Error("guide store is read-only"); }, setDismissed: () => {} },
      onClusterChanged: () => { throw new Error("probe registry gone"); },
    },
  });
  world.onboard();
  const { preview } = await world.manager.previewUndo();
  await world.manager.runUndo({ previewId: preview.previewId });
  await world.manager.whenIdle();
  assert.equal((await world.manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
  assert.equal(world.manager.busyNotice(), null);
  assert.equal(world.taskLock.current(SERVER_ID), null);
  assert.ok(world.logs.some(([message, level]) => message.includes("could not reset onboarding guide") && level === "warn"));
});

test("没有任务锁、没有引导也能用（都是可选的注入）", { skip }, async (t) => {
  const world = createWorld(t);
  world.onboard();
  const manager = createAccessManager({
    getConfig: world.configManager.getConfig,
    getPersonalConfig: world.configManager.getPersonalConfig,
    savePersonalConfig: world.configManager.savePersonalConfig,
    runRemote: world.runRemote,
  });
  const { preview } = await manager.previewUndo();
  await manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await manager.whenIdle();
  assert.equal((await manager.getAccess()).undo.status, "ok");
  assert.equal(world.undone(), true);
});

// ---------------------------------------------------------------------------
// fixture 模式
// ---------------------------------------------------------------------------

test("fixture 模式：整条流程跑在假的远端上——不发 SSH、不读写个人配置", async () => {
  const forbidden = (name) => () => {
    throw new Error(`fixture 模式不该调用 ${name}`);
  };
  const guide = { resets: 0 };
  const manager = createAccessManager({
    fixtureMode: true,
    getConfig: async () => ({ servers: [{ id: SERVER_ID, name: "主集群", host: "myserver" }] }),
    getPersonalConfig: forbidden("getPersonalConfig"),
    savePersonalConfig: forbidden("savePersonalConfig"),
    refreshConfigIntoKernel: forbidden("refreshConfigIntoKernel"),
    runRemote: forbidden("runRemote"),
    acquireSshSlot: forbidden("acquireSshSlot"),
    taskLock: createCliTaskLock(),
    onboardingGuide: { getBrief: () => ({ busy: false }), reset: () => { guide.resets += 1; }, setDismissed: () => {} },
    onClusterChanged: forbidden("onClusterChanged"),
    sleep: async () => {},
  });
  const read = async () => {
    await manager.getAccess();
    await manager.whenIdle();
    return manager.getAccess();
  };
  const view = await read();
  assert.deepEqual([view.available, view.simulated, view.port], [true, true, 7892]);
  assert.deepEqual(view.registry.ports, [{ port: 7892, current: true, listening: true, releasable: false }, { port: 7895, current: false, listening: false, releasable: true }]);
  await rejectsWith(manager.releasePort({ port: 7892 }), 409, "port-in-use");
  await rejectsWith(manager.releasePort({ port: 7893 }), 409, "not-owner");
  assert.deepEqual((await manager.releasePort({ port: 7895 })).access.registry.ports.map((row) => row.port), [7892]);

  const { preview } = await manager.previewUndo();
  assert.deepEqual(preview.steps.map((step) => step.effect), ["change", "change", "change", "change"]);
  assert.equal(preview.release.owner, "me");
  await manager.runUndo({ previewId: preview.previewId, releasePort: true });
  await manager.whenIdle();
  const after = await read();
  assert.equal(after.undo.status, "ok");
  assert.deepEqual([after.port, after.registry.ports, guide.resets], [null, [], 1]);
  const again = (await manager.previewUndo()).preview;
  assert.equal(again.nothingToUndo, true, "撤销之后假远端上也没有东西了");
});
