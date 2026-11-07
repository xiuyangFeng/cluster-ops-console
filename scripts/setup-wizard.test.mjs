// 只对配置向导（scripts/setup/*.mjs）里抽出的纯函数做单测：不 ssh、不写真实 ~/.ssh/config 或
// ~/Library/Application Support/，不触碰生产实例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RECLAUDE_PROXY_DROPIN_DIR, RECLAUDE_PROXY_DROPIN_FILE, renderReclaudeProxyDropin } from "../work/monitor/lib/proxy-config.mjs";
import { pickReversePort } from "../work/monitor/lib/reverse-port.mjs";
import { parseSshConfigUser } from "../work/monitor/lib/ssh-config-user.mjs";
import { appendKnownHosts, scanHostKeyLines } from "./setup/host-keys.mjs";
import { buildPersonalIdentityPatch, readSshUserFromLocalConfig } from "./setup/local-config.mjs";
import { assertPortNotTeamReserved } from "./setup/port-assignment.mjs";
import { buildRemoteReplaceFileCommand, buildRemoteUpsertCommand } from "./setup/routing.mjs";
import { upsertSshConfigBlock } from "./setup/ssh-config.mjs";
import { decideKeyAction } from "./setup/ssh-keys.mjs";

test("upsertSshConfigBlock: fresh content with no existing Host just appends a new section", () => {
  const out = upsertSshConfigBlock("", { hostAlias: "codex-tunnel", hostName: "1.2.3.4", port: 22, user: "alice" });
  assert.match(out, /^Host codex-tunnel$/m);
  assert.match(out, /^\s+HostName 1\.2\.3\.4$/m);
  assert.match(out, /^\s+User alice$/m);
  assert.match(out, /^\s+Port 22$/m);
  assert.match(out, /^\s+StrictHostKeyChecking yes$/m);
});

test("upsertSshConfigBlock: strips old same-alias Host section (wrong user) and writes back only one new section", () => {
  const existing = `Host other-host
  HostName 9.9.9.9
  User someone

Host codex-tunnel
  HostName 1.2.3.4
  User wronguser
  Port 22
  StrictHostKeyChecking yes
`;
  const out = upsertSshConfigBlock(existing, { hostAlias: "codex-tunnel", hostName: "1.2.3.4", port: 22, user: "alice" });

  // 旧的错误用户名段被彻底移除
  assert.doesNotMatch(out, /wronguser/);
  // 只剩一个 codex-tunnel 段
  const hostMatches = out.match(/^Host codex-tunnel$/gm) || [];
  assert.equal(hostMatches.length, 1);
  // 新用户名段存在
  assert.match(out, /^\s+User alice$/m);
  // 不相关的 Host 段原样保留
  assert.match(out, /^Host other-host$/m);
  assert.match(out, /^\s+User someone$/m);
});

test("upsertSshConfigBlock: 保留目标 Host 段之后的 Match 块 / 全局指令 / 注释（不静默丢配置）", () => {
  const existing = `Host codex-tunnel
  HostName 1.2.3.4
  User wronguser
Match host *.internal
  ForwardAgent yes
# 我的全局设置
Host *
  ServerAliveInterval 60
`;
  const out = upsertSshConfigBlock(existing, { hostAlias: "codex-tunnel", hostName: "1.2.3.4", port: 22, user: "alice" });
  assert.doesNotMatch(out, /wronguser/, "旧目标段应被剥离");
  assert.match(out, /^Match host \*\.internal$/m, "Match 块必须保留");
  assert.match(out, /^\s+ForwardAgent yes$/m, "Match 块内容必须保留");
  assert.match(out, /^# 我的全局设置$/m, "用户注释必须保留");
  assert.match(out, /^Host \*$/m, "catch-all Host 必须保留");
  assert.match(out, /^\s+ServerAliveInterval 60$/m, "全局 ServerAliveInterval 必须保留");
  assert.match(out, /^\s+User alice$/m, "新段写入");
});

test("upsertSshConfigBlock: idempotent — calling twice with the same args yields identical content", () => {
  const existing = `Host codex-tunnel
  HostName 1.2.3.4
  User wronguser
  Port 22
  StrictHostKeyChecking yes
`;
  const opts = { hostAlias: "codex-tunnel", hostName: "5.6.7.8", port: 2222, user: "bob" };
  const first = upsertSshConfigBlock(existing, opts);
  const second = upsertSshConfigBlock(first, opts);
  assert.equal(second, first);
  // 依然只有一个 codex-tunnel 段
  const hostMatches = (second.match(/^Host codex-tunnel$/gm) || []);
  assert.equal(hostMatches.length, 1);
});

test("upsertSshConfigBlock: repeated upsert against a multi-host file never grows unrelated sections", () => {
  const existing = `Host a
  HostName 1.1.1.1

Host codex-tunnel
  HostName old
  User old
  Port 22

Host b
  HostName 2.2.2.2
`;
  const opts = { hostAlias: "codex-tunnel", hostName: "3.3.3.3", port: 22, user: "carol" };
  const once = upsertSshConfigBlock(existing, opts);
  const twice = upsertSshConfigBlock(once, opts);
  assert.equal(twice, once);
  assert.equal((twice.match(/^Host codex-tunnel$/gm) || []).length, 1);
  assert.equal((twice.match(/^Host a$/gm) || []).length, 1);
  assert.equal((twice.match(/^Host b$/gm) || []).length, 1);
});

test("scanHostKeyLines / appendKnownHosts: 只追加未出现过的行", () => {
  const lines = scanHostKeyLines("box.example", 22, {
    spawnImpl: () => ({ stdout: "# comment\nbox.example ssh-ed25519 AAAA\n" }),
  });
  assert.deepEqual(lines, ["box.example ssh-ed25519 AAAA"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-known-"));
  const filePath = path.join(dir, "known_hosts");
  assert.equal(appendKnownHosts(filePath, lines).added, 1);
  assert.equal(appendKnownHosts(filePath, lines).added, 0);
  assert.match(fs.readFileSync(filePath, "utf8"), /ssh-ed25519 AAAA/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("upsertSshConfigBlock: optional identityFile renders IdentityFile line only when provided", () => {
  const withIdentity = upsertSshConfigBlock("", { hostAlias: "x", hostName: "h", port: 22, user: "u", identityFile: "/home/u/.ssh/id_ed25519_codextunnel" });
  assert.match(withIdentity, /^\s+IdentityFile \/home\/u\/\.ssh\/id_ed25519_codextunnel$/m);
  const withoutIdentity = upsertSshConfigBlock("", { hostAlias: "x", hostName: "h", port: 22, user: "u" });
  assert.doesNotMatch(withoutIdentity, /IdentityFile/);
});

// --- O4: pickReversePort / assertPortNotTeamReserved (E2 碰撞防护) ---

test("pickReversePort: skips both in-use and reserved ports, returns smallest free one", () => {
  const port = pickReversePort({ inUse: [7892], reserved: [7891, 7893] });
  assert.equal(port, 7894);
});

test("pickReversePort: never returns the team base port (7891) even if caller forgets to reserve it", () => {
  const port = pickReversePort({ inUse: [], reserved: [] });
  assert.notEqual(port, 7891);
  assert.equal(port, 7892); // base+1 是第一个候选
});

test("pickReversePort: inUse containing 7891 still never yields 7891 (base+1 is the first candidate)", () => {
  const port = pickReversePort({ inUse: [7891], reserved: [] });
  assert.notEqual(port, 7891);
});

test("pickReversePort: throws when the whole span is exhausted (no infinite loop / no silent bad port)", () => {
  const inUse = [];
  for (let p = 7892; p <= 7891 + 1000; p++) inUse.push(p);
  assert.throws(() => pickReversePort({ inUse, reserved: [], base: 7891, span: 1000 }));
});

test("assertPortNotTeamReserved: throws when port collides with a team remotePort (e.g. production 7891)", () => {
  assert.throws(() => assertPortNotTeamReserved(7891, [7891]));
});

test("assertPortNotTeamReserved: passes silently for a port not in the team list", () => {
  assert.doesNotThrow(() => assertPortNotTeamReserved(7894, [7891, 7893]));
});

// --- O5: buildRemoteUpsertCommand (E4 远端原子写 + 备份 + marker 去重) ---

test("buildRemoteUpsertCommand: contains timestamped .bak. backup and mv-based atomic replace", () => {
  const cmd = buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "export FOO=bar", marker: "codex-proxy" });
  assert.match(cmd, /\.bak\.\$\(date \+%s\)/);
  assert.match(cmd, /\bmv\s+~\/\.bashrc\.tmp\.\$\$\s+~\/\.bashrc\b/);
});

test("buildRemoteUpsertCommand: never emits a bare `cat > <targetFile>` (the E4 truncation hazard)", () => {
  const cmd = buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "export FOO=bar", marker: "codex-proxy" });
  assert.doesNotMatch(cmd, /cat\s*>\s*~\/\.bashrc(?!\.)/);
});

test("buildRemoteUpsertCommand: wraps block with marker and is deterministic across repeated calls", () => {
  const cmd1 = buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "export FOO=bar\n", marker: "codex-proxy" });
  const cmd2 = buildRemoteUpsertCommand({ targetFile: "~/.bashrc", blockContent: "export FOO=bar\n", marker: "codex-proxy" });
  assert.equal(cmd1, cmd2);
  assert.match(cmd1, /awk -v b="# >>> codex-proxy >>>" -v e="# <<< codex-proxy <<</);
});

test("buildRemoteUpsertCommand: executed for real against a scratch tmpdir file actually backs up, dedupes and preserves unrelated content", { skip: process.platform === "win32" }, () => {
  // 只碰 os.tmpdir() 下的临时抓取文件，绝不碰真实 ~/.bashrc 或任何用户配置。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-o5-"));
  const targetFile = path.join(dir, "bashrc");
  fs.writeFileSync(targetFile, "# pre-existing user content\nexport UNRELATED=1\n");

  const cmd1 = buildRemoteUpsertCommand({ targetFile, blockContent: "export HTTP_PROXY=http://127.0.0.1:7892\n", marker: "codex-proxy" });
  execFileSync("bash", ["-c", cmd1]);
  const afterFirst = fs.readFileSync(targetFile, "utf8");
  assert.match(afterFirst, /UNRELATED=1/); // 原有无关内容保留
  assert.match(afterFirst, /7892/);
  assert.equal((afterFirst.match(/# >>> codex-proxy >>>/g) || []).length, 1);

  // 模拟端口重新分配后重跑向导：同一 targetFile 用不同端口再 upsert 一次
  const cmd2 = buildRemoteUpsertCommand({ targetFile, blockContent: "export HTTP_PROXY=http://127.0.0.1:7899\n", marker: "codex-proxy" });
  execFileSync("bash", ["-c", cmd2]);
  const afterSecond = fs.readFileSync(targetFile, "utf8");
  assert.match(afterSecond, /UNRELATED=1/); // 无关内容依旧保留
  assert.doesNotMatch(afterSecond, /7892/); // 旧 block 被剥离，不叠加
  assert.match(afterSecond, /7899/);
  assert.equal((afterSecond.match(/# >>> codex-proxy >>>/g) || []).length, 1);

  // 至少产生一份带时间戳的备份文件
  const files = fs.readdirSync(dir);
  assert.ok(files.some((f) => f.includes(".bak.")));

  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRemoteUpsertCommand after-shebang: 块插在 shebang 之后、exec 之前，wrapper 运行时 export 生效（P2-5 回归）", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-wizard-wrapper-"));
  const targetFile = path.join(dir, "codex");
  // 模拟 codex shell wrapper：shebang + exec 行。exec 会用 replacement 进程替换当前 shell，
  // 追加到 exec 之后的任何行都是死代码——这正是 P2-5。这里把 exec 换成打印 env 以便断言。
  fs.writeFileSync(targetFile, '#!/bin/sh\nexec printf "PROXY=%s\\n" "$HTTP_PROXY"\n');

  const cmd = buildRemoteUpsertCommand({
    targetFile, blockContent: 'export HTTP_PROXY="http://127.0.0.1:7892"\n',
    marker: "codex-proxy", position: "after-shebang",
  });
  execFileSync("bash", ["-c", cmd]);
  const content = fs.readFileSync(targetFile, "utf8");

  const shebangIdx = content.indexOf("#!/bin/sh");
  const blockIdx = content.indexOf("# >>> codex-proxy >>>");
  const execIdx = content.indexOf("exec printf");
  assert.ok(shebangIdx === 0, "shebang 必须仍是第一行");
  assert.ok(blockIdx > shebangIdx && blockIdx < execIdx, "代理块必须在 shebang 之后、exec 之前");

  // 真正运行这个 wrapper：export 生效则打印出代理地址（若像 P2-5 那样追加到 exec 之后则为空）
  fs.chmodSync(targetFile, 0o755);
  const out = execFileSync("sh", [targetFile], { encoding: "utf8" });
  assert.match(out, /PROXY=http:\/\/127\.0\.0\.1:7892/, "wrapper 运行时必须已 export 代理，否则 codex 绕过隧道");

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- O6: decideKeyAction (E6 不覆盖既有私钥) ---

test("decideKeyAction: private key only, .pub missing → regen-pub (never a fresh overwrite of the private key)", () => {
  assert.equal(decideKeyAction({ privateExists: true, publicExists: false }), "regen-pub");
});

test("decideKeyAction: neither exists → create-new (must use a dedicated filename, never the default path)", () => {
  assert.equal(decideKeyAction({ privateExists: false, publicExists: false }), "create-new");
});

test("decideKeyAction: both exist → reuse", () => {
  assert.equal(decideKeyAction({ privateExists: true, publicExists: true }), "reuse");
});

test("decideKeyAction: never returns an action name that implies overwriting an existing private key", () => {
  for (const privateExists of [true, false]) {
    for (const publicExists of [true, false]) {
      const action = decideKeyAction({ privateExists, publicExists });
      assert.ok(["reuse", "regen-pub", "create-new"].includes(action));
      if (privateExists) assert.notEqual(action, "create-new"); // 私钥已存在时绝不会走"新建"分支
    }
  }
});

test("parseSshConfigUser: 精确 Host 段的 User 优先于 Host *，不回落本机用户名", () => {
  const content = `Host other
  User someone

Host myserver alias2
  HostName 1.2.3.4
  User cluster-alice
  Port 22

Host *
  User fallback
`;
  assert.equal(parseSshConfigUser(content, "myserver"), "cluster-alice");
  assert.equal(parseSshConfigUser(content, "alias2"), "cluster-alice");
  assert.equal(parseSshConfigUser(content, "unknown-host"), "fallback");
  assert.equal(parseSshConfigUser("", "myserver"), "");
  assert.equal(parseSshConfigUser("Host myserver\n  Port 22\n", "myserver"), "");
});

test("buildPersonalIdentityPatch: 有用户才写 sshUser，空用户不会塞本机名", () => {
  const withUser = buildPersonalIdentityPatch({ id: "server-01" }, "cluster-alice", "/tmp/id");
  assert.equal(withUser.sshUser, "cluster-alice");
  assert.equal(withUser.activeServerId, "server-01");
  assert.equal(withUser.sshIdentityFile, "/tmp/id");
  const emptyUser = buildPersonalIdentityPatch({ id: "server-01" }, "  ", undefined);
  assert.equal(emptyUser.sshUser, undefined);
  assert.equal(emptyUser.activeServerId, "server-01");
  assert.equal("sshIdentityFile" in emptyUser, false);
});

test("readSshUserFromLocalConfig: 只接受合法 sshUser，拒绝空/非法值", () => {
  assert.equal(readSshUserFromLocalConfig('{"sshUser":"cluster-bob"}'), "cluster-bob");
  assert.equal(readSshUserFromLocalConfig('{"sshUser":"bad user"}'), "");
  assert.equal(readSshUserFromLocalConfig("{}"), "");
  assert.equal(readSshUserFromLocalConfig("not-json"), "");
});

test("buildRemoteReplaceFileCommand: mkdir + backup + base64 tmp+mv, content round-trips", () => {
  const content = `${JSON.stringify({ locale: "zh-CN", httpProxy: "http://127.0.0.1:7891" }, null, 2)}\n`;
  const cmd = buildRemoteReplaceFileCommand({ targetFile: "~/.zcode/v2/setting.json", content });

  assert.match(cmd, /^mkdir -p ~\/\.zcode\/v2/, "第一步建目录");
  assert.match(cmd, /cp -p ~\/\.zcode\/v2\/setting\.json ~\/\.zcode\/v2\/setting\.json\.bak\.\$\(date \+%s\)/, "写前备份旧文件");
  assert.match(cmd, /printf '%s' '[A-Za-z0-9+/=]+' \| base64 -d > ~\/\.zcode\/v2\/setting\.json\.tmp\.\$\$/, "内容 base64 内嵌写临时文件");
  assert.match(cmd, /mv ~\/\.zcode\/v2\/setting\.json\.tmp\.\$\$ ~\/\.zcode\/v2\/setting\.json$/, "mv 原子替换");

  // 内容经 base64 编码后必须能无损还原（模拟远端执行）
  const encoded = cmd.match(/printf '%s' '([A-Za-z0-9+/=]+)'/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), content);
});

test("buildRemoteReplaceFileCommand: reclaude drop-in 一条命令建目录 + 原子替换，临时/备份文件不会被 systemd 当 drop-in 加载", { skip: process.platform === "win32" }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sw-dropin-"));
  try {
    const dropinPath = `${home}/${RECLAUDE_PROXY_DROPIN_DIR}/${RECLAUDE_PROXY_DROPIN_FILE}`;
    const run = (content) => execFileSync("sh", ["-c", buildRemoteReplaceFileCommand({ targetFile: dropinPath, content })]);
    run(renderReclaudeProxyDropin(7891));
    run(renderReclaudeProxyDropin(7892)); // 第二次：旧文件备份后原子替换
    assert.equal(fs.readFileSync(dropinPath, "utf8"), renderReclaudeProxyDropin(7892));
    const names = fs.readdirSync(path.dirname(dropinPath));
    assert.deepEqual(names.filter((n) => n.endsWith(".conf")), [RECLAUDE_PROXY_DROPIN_FILE], "目录里只有一个 *.conf");
    assert.ok(names.some((n) => n.startsWith(`${RECLAUDE_PROXY_DROPIN_FILE}.bak.`)), "旧 drop-in 已备份");
    assert.ok(!names.some((n) => n.includes(".tmp.")), "不留临时文件");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2.18 Task 10：个人服务器层 / 屏蔽团队服务器
// 这些用例只碰纯函数与"全部依赖注入"的向导步骤：不 ssh、不碰真实 ~/.ssh/config，
// 落盘一律指向临时目录。
// ---------------------------------------------------------------------------
import { parseListeningPorts } from "../work/monitor/lib/reverse-port.mjs";
import { disableTeamServer, enableTeamServer, upsertPersonalServer } from "./setup/local-config.mjs";
import { addPersonalServers } from "./setup/personal-servers.mjs";

// --- upsertPersonalServer ---

test("upsertPersonalServer: 追加新条目且不修改入参", () => {
  const local = { activeServerId: "server-01", servers: [{ id: "server-01", disabled: true }] };
  const frozen = JSON.stringify(local);
  const next = upsertPersonalServer(local, { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", remotePort: 7893, localPort: 8893, tunnel: true });

  assert.equal(JSON.stringify(local), frozen, "入参必须原样不动");
  assert.equal(next.activeServerId, "server-01", "其余个人层字段原样保留");
  assert.equal(next.servers.length, 2);
  assert.deepEqual(next.servers[1], { id: "server-tengxun", name: "腾讯云", host: "tengxunserver", remotePort: 7893, localPort: 8893, tunnel: true });
  assert.notEqual(next.servers, local.servers, "servers 必须是新数组");
});

test("upsertPersonalServer: 同 id 覆盖，本次没提供的字段保留原值", () => {
  const local = { servers: [{ id: "server-aliyun", name: "旧名字", host: "vpn-aliyun", remotePort: 7894, localPort: 8894, tunnel: true, description: "阿里云 VPN 专线" }] };
  const next = upsertPersonalServer(local, { id: "server-aliyun", host: "vpn-aliyun", remotePort: 7895, tunnel: false });

  assert.equal(next.servers.length, 1, "同 id 覆盖而不是再追加一条");
  assert.equal(next.servers[0].remotePort, 7895, "本次提供的字段生效");
  assert.equal(next.servers[0].tunnel, false);
  assert.equal(next.servers[0].description, "阿里云 VPN 专线", "本次没问到的字段必须保留");
  assert.equal(next.servers[0].name, "旧名字");
  assert.equal(next.servers[0].localPort, 8894);
});

test("upsertPersonalServer: 缺 servers / 传入非对象 localConfig 都能安全建出数组", () => {
  assert.deepEqual(upsertPersonalServer({}, { id: "a", host: "a", remotePort: 7892 }).servers, [{ id: "a", host: "a", remotePort: 7892 }]);
  assert.deepEqual(upsertPersonalServer(null, { id: "a", host: "a", remotePort: 7892 }).servers, [{ id: "a", host: "a", remotePort: 7892 }]);
});

test("upsertPersonalServer: 非法 id / host / 端口一律抛错（不把脏值写进个人层）", () => {
  assert.throws(() => upsertPersonalServer({}, { id: "bad id", host: "h", remotePort: 7892 }), /id 非法/);
  assert.throws(() => upsertPersonalServer({}, { id: "", host: "h", remotePort: 7892 }), /id 非法/);
  assert.throws(() => upsertPersonalServer({}, { id: "a; rm -rf /", host: "h", remotePort: 7892 }), /id 非法/);
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "h;whoami", remotePort: 7892 }), /unsafe/);
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "-oProxyCommand=x", remotePort: 7892 }), /unsafe/);
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "h" }), /unsafe/); // remotePort 必填
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "h", remotePort: "7891; rm" }), /unsafe/);
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "h", remotePort: 7892, localPort: 99999 }), /unsafe/);
  assert.throws(() => upsertPersonalServer({}, { id: "a", host: "h", remotePort: 7892, sshUser: "bad user" }), /unsafe sshUser/);
});

// --- disableTeamServer / enableTeamServer ---

test("disableTeamServer: 个人层没有该条目时追加最小屏蔽标记", () => {
  const local = { activeServerId: "server-01" };
  const next = disableTeamServer(local, "server-01");
  assert.deepEqual(next.servers, [{ id: "server-01", disabled: true }]);
  assert.equal(local.servers, undefined, "入参不被修改");
});

test("disableTeamServer: 已有同 id 条目时只合并 disabled，其余字段不动", () => {
  const local = { servers: [{ id: "server-01", remotePort: 7892 }, { id: "other", host: "h", remotePort: 7893 }] };
  const next = disableTeamServer(local, "server-01");
  assert.deepEqual(next.servers[0], { id: "server-01", remotePort: 7892, disabled: true });
  assert.deepEqual(next.servers[1], { id: "other", host: "h", remotePort: 7893 }, "其它条目原样保留");
});

test("enableTeamServer: disable→enable 往返后不再有 disabled，纯屏蔽标记被整条移除", () => {
  const local = { activeServerId: "server-01", servers: [] };
  const disabled = disableTeamServer(local, "server-01");
  assert.equal(disabled.servers[0].disabled, true);
  const enabled = enableTeamServer(disabled, "server-01");
  assert.deepEqual(enabled.servers, [], "只剩 id 的空条目不留在个人层");
  assert.equal(enabled.activeServerId, "server-01");
});

test("enableTeamServer: 带其它覆盖字段的条目只去掉 disabled，条目本身保留", () => {
  const local = { servers: [{ id: "server-01", remotePort: 7892, disabled: true }] };
  const enabled = enableTeamServer(local, "server-01");
  assert.deepEqual(enabled.servers, [{ id: "server-01", remotePort: 7892 }]);
  assert.equal(local.servers[0].disabled, true, "入参不被修改");
});

test("enableTeamServer: 对不存在的 id 是空操作；非法 id 抛错", () => {
  assert.deepEqual(enableTeamServer({ servers: [{ id: "a", host: "h", remotePort: 7892 }] }, "zzz").servers, [{ id: "a", host: "h", remotePort: 7892 }]);
  assert.throws(() => disableTeamServer({}, "bad id"), /非法/);
  assert.throws(() => enableTeamServer({}, ""), /非法/);
});

test("parseListeningPorts: 只取 78xx/79xx 段的 LISTEN 端口并去重排序", () => {
  const ss = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port",
    "LISTEN 0      128    127.0.0.1:7891      0.0.0.0:*",
    "LISTEN 0      128    127.0.0.1:7893      0.0.0.0:*",
    "LISTEN 0      128    127.0.0.1:7891      0.0.0.0:*",
    "LISTEN 0      128    0.0.0.0:22          0.0.0.0:*",
    "LISTEN 0      128    127.0.0.1:8888      0.0.0.0:*",
    "ESTAB  0      0      127.0.0.1:7899      127.0.0.1:1234",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(ss), [7891, 7893]);
  assert.deepEqual(parseListeningPorts(""), [], "ss 缺失（空输出）时保留集为空，不报错");
});

// --- addPersonalServers（全依赖注入，dry-run 与真实落盘各一遍）---

function makeAsk(answers) {
  const queue = [...answers];
  const asked = [];
  const ask = async (q) => {
    asked.push(q);
    return queue.length ? queue.shift() : "";
  };
  ask.asked = asked;
  return ask;
}

async function captureConsole(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    const result = await fn();
    return { result, out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("addPersonalServers: --dry-run 只打印预期命令，不落任何盘、不发一条 ssh", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-dry-"));
  const localConfigPath = path.join(dir, "config.local.json");
  const sshConfigTarget = path.join(dir, "ssh-config");
  const ask = makeAsk(["y", "tengxunserver", "1.2.3.4", "", "ubuntu", "腾讯云服务器", "", "", "n"]);
  const ssh = () => { throw new Error("dry-run 下不得发起任何真实 SSH"); };

  const { result, out } = await captureConsole(() => addPersonalServers({
    localConfigPath, sshConfigPath: sshConfigTarget,
    teamRemotePorts: [7891], teamSshUser: "kai",
    dryRun: true, ask, ssh, testSsh: () => { throw new Error("dry-run 下不得探测连通性"); },
  }));

  assert.equal(result, 1);
  // 不落盘
  assert.equal(fs.existsSync(localConfigPath), false, "dry-run 绝不写 config.local.json");
  assert.equal(fs.existsSync(sshConfigTarget), false, "dry-run 绝不写 ssh config");
  assert.deepEqual(fs.readdirSync(dir), [], "临时目录里连临时文件都不该有");
  // 打印了预期命令
  assert.match(out, /\[dry-run\]/);
  assert.match(out, /Host tengxunserver/, "打印将写入的 ssh config 段");
  assert.match(out, /HostName 1\.2\.3\.4/);
  assert.match(out, /Port 22/, "端口留空时默认 22");
  assert.match(out, /atomic write .*config\.local\.json/);
  assert.match(out, /"remotePort": 7892/, "7891 是团队保留端口，建议值落到 7892");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("addPersonalServers: 非 dry-run 写 ssh 别名段 + 个人层 servers，端口避开监听与团队保留", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-real-"));
  const localConfigPath = path.join(dir, "config.local.json");
  const sshConfigTarget = path.join(dir, "ssh-config");
  fs.writeFileSync(localConfigPath, JSON.stringify({ activeServerId: "server-01", sshUser: "kai" }, null, 2));

  const sshCalls = [];
  const ssh = (host, cmd, opts = {}) => {
    sshCalls.push({ host, cmd, input: opts.input });
    if (cmd.includes("ss -ltn")) return { status: 0, stdout: "LISTEN 0 128 127.0.0.1:7891 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:7892 0.0.0.0:*\n" };
    return { status: 0, stdout: "" };
  };
  // 别名 / IP / SSH端口 / 用户名 / 显示名 / 反向端口 / 建隧道? / 继续?
  const ask = makeAsk(["y", "vpn-aliyun", "5.6.7.8", "2222", "ubuntu", "", "", "n", "n"]);

  const { result } = await captureConsole(() => addPersonalServers({
    localConfigPath, sshConfigPath: sshConfigTarget,
    teamRemotePorts: [7891], teamSshUser: "kai",
    dryRun: false, ask, ssh, testSsh: () => true, pinHostKey: async () => true,
  }));
  assert.equal(result, 1);

  const sshConfigText = fs.readFileSync(sshConfigTarget, "utf8");
  assert.match(sshConfigText, /^Host vpn-aliyun$/m);
  assert.match(sshConfigText, /^\s+HostName 5\.6\.7\.8$/m);
  assert.match(sshConfigText, /^\s+Port 2222$/m);
  assert.match(sshConfigText, /^\s+User ubuntu$/m);

  const local = JSON.parse(fs.readFileSync(localConfigPath, "utf8"));
  assert.equal(local.activeServerId, "server-01", "既有个人层字段原样保留");
  assert.equal(local.sshUser, "kai");
  assert.deepEqual(local.servers, [{
    id: "vpn-aliyun", name: "vpn-aliyun", host: "vpn-aliyun",
    // 7891 团队保留 + 7891/7892 正在监听 → 建议值 7893
    remotePort: 7893, localPort: 8893, tunnel: false, sshUser: "ubuntu",
  }], "tunnel:false 只监控不建隧道；账号与团队账号不同才写 sshUser");

  assert.ok(sshCalls.every((c) => !/agent-hub|ports\.tsv/.test(c.cmd)), "不再向服务器写任何端口登记");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("addPersonalServers: 个人层与 ssh config 都以 0600 原子写回（与控制台写个人层同权限），不留临时文件", { skip: process.platform === "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-mode-"));
  const localConfigPath = path.join(dir, "config.local.json");
  const sshConfigTarget = path.join(dir, "ssh", "config");
  fs.writeFileSync(localConfigPath, "{}\n", { mode: 0o644 });
  const ask = makeAsk(["y", "vpn-aliyun", "5.6.7.8", "", "ubuntu", "", "", "", "n"]);

  const { result } = await captureConsole(() => addPersonalServers({
    localConfigPath, sshConfigPath: sshConfigTarget,
    dryRun: false, ask, ssh: () => ({ status: 0, stdout: "" }), testSsh: () => true, pinHostKey: async () => true,
  }));
  assert.equal(result, 1);
  assert.equal(fs.statSync(localConfigPath).mode & 0o777, 0o600, "个人层 0600（此前向导这一路按 umask 落 0644，与控制台写回来回翻转）");
  assert.equal(fs.statSync(sshConfigTarget).mode & 0o777, 0o600, "ssh config 0600");
  assert.equal(fs.statSync(path.dirname(sshConfigTarget)).mode & 0o777, 0o700, "缺失的 ssh 目录按 0700 创建");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["config.local.json", "ssh"], "不留 .tmp 临时文件");
  assert.deepEqual(fs.readdirSync(path.dirname(sshConfigTarget)), ["config"]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("addPersonalServers: 同 id 再次添加会提示覆盖，选 N 则个人层一字不改", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-dup-"));
  const localConfigPath = path.join(dir, "config.local.json");
  const before = JSON.stringify({ servers: [{ id: "tengxunserver", host: "tengxunserver", remotePort: 7893 }] }, null, 2);
  fs.writeFileSync(localConfigPath, before);
  const ask = makeAsk(["y", "tengxunserver", "n", "n"]);

  const { result } = await captureConsole(() => addPersonalServers({
    localConfigPath, sshConfigPath: path.join(dir, "ssh-config"),
    dryRun: false, ask, ssh: () => { throw new Error("不该走到 SSH"); }, testSsh: () => true,
  }));

  assert.equal(result, 0);
  assert.equal(fs.readFileSync(localConfigPath, "utf8"), before, "选择不覆盖时个人层一字不改");
  assert.ok(ask.asked.some((q) => /已存在 id "tengxunserver"/.test(q)), "必须提示覆盖");
  assert.equal(fs.existsSync(path.join(dir, "ssh-config")), false, "放弃时不写 ssh config");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("addPersonalServers: 回答 N 直接跳过整个步骤，零副作用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-skip-"));
  const { result } = await captureConsole(() => addPersonalServers({
    localConfigPath: path.join(dir, "config.local.json"),
    sshConfigPath: path.join(dir, "ssh-config"),
    dryRun: false, ask: makeAsk([""]),
    ssh: () => { throw new Error("不该走到 SSH"); }, testSsh: () => { throw new Error("不该探测"); },
  }));
  assert.equal(result, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("addPersonalServers: 个人层是坏 JSON 时中止写入，绝不覆盖用户手编内容", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-personal-broken-"));
  const localConfigPath = path.join(dir, "config.local.json");
  fs.writeFileSync(localConfigPath, "{ this is not json");
  const { result, out } = await captureConsole(() => addPersonalServers({
    localConfigPath, sshConfigPath: path.join(dir, "ssh-config"),
    dryRun: false, ask: makeAsk(["y", "tengxunserver", "n"]),
    ssh: () => { throw new Error("不该走到 SSH"); }, testSsh: () => true,
  }));
  assert.equal(result, 0);
  assert.match(out, /不是合法 JSON/);
  assert.equal(fs.readFileSync(localConfigPath, "utf8"), "{ this is not json", "损坏的个人层原样保留");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 免密测试失败归因 / 收尾摘要 / 依赖检查（易用性修复）
// ---------------------------------------------------------------------------
import { describeSshTestFailure } from "./setup/ssh-probe.mjs";
import { buildWizardSummary, dependenciesSatisfied, MAC_APP_HINT } from "./setup/summary.mjs";

test("describeSshTestFailure: 连接被拒/超时 → 首因是不在白名单网络", () => {
  for (const probe of [
    { stderr: "ssh: connect to host 1.2.3.4 port 22: Connection refused" },
    { stderr: "ssh: connect to host 1.2.3.4 port 22: Operation timed out" },
    { stderr: "", timedOut: true },
  ]) {
    const info = describeSshTestFailure(probe);
    assert.match(info.primary[0], /白名单/);
    assert.ok(!info.others.some((c) => /白名单/.test(c)), "首因不应在'其他原因'里重复");
    assert.ok(info.others.length >= 2);
  }
});

test("describeSshTestFailure: Permission denied → 公钥未加入 / 密码错误", () => {
  const info = describeSshTestFailure({ stderr: "kai@1.2.3.4: Permission denied (publickey,password).\n" });
  assert.equal(info.code, "auth");
  assert.ok(info.primary.some((c) => /authorized_keys/.test(c)));
  assert.ok(info.primary.some((c) => /密码/.test(c)));
  assert.match(info.detail, /Permission denied/);
});

test("describeSshTestFailure: 无法归因时列出全部三条常见原因", () => {
  const info = describeSshTestFailure({ stderr: "something odd" });
  assert.equal(info.code, "unknown");
  assert.deepEqual(info.primary, []);
  assert.equal(info.others.length, 3);
  assert.match(info.nextAction, /npm run setup/);
});

test("buildWizardSummary: 全部打通 → 配置完成", () => {
  const s = buildWizardSummary({ serverResults: [{ id: "server-01", name: "主集群", host: "myserver", status: "ok" }] });
  assert.equal(s.complete, true);
  assert.equal(s.title, "配置完成！");
  assert.deepEqual(s.skipped, []);
  assert.equal(s.configured, 1);
});

test("buildWizardSummary: 选择'我不在这个集群'不算未完成", () => {
  const s = buildWizardSummary({ serverResults: [{ id: "server-01", host: "myserver", status: "disabled" }] });
  assert.equal(s.complete, true);
  assert.equal(s.disabled, 1);
});

test("buildWizardSummary: server-01 免密失败 → 未完成并列出被跳过的端口分配与路由", () => {
  const s = buildWizardSummary({
    serverResults: [{ id: "server-01", name: "主集群", host: "myserver", status: "failed", reason: "当前网络不在集群 SSH 白名单内" }],
  });
  assert.equal(s.complete, false);
  assert.equal(s.title, "配置未完成");
  const text = s.skipped.join("\n");
  assert.match(text, /myserver/);
  assert.match(text, /白名单/);
  assert.match(text, /反向端口/);
  assert.match(text, /代理路由/);
  assert.match(s.rerunHint, /白名单网络下重跑 npm run setup/);
});

test("buildWizardSummary: 非主服务器失败只列该服务器，不列端口/路由", () => {
  const s = buildWizardSummary({
    serverResults: [
      { id: "server-01", host: "myserver", status: "ok" },
      { id: "server-02", host: "other", status: "skipped", reason: "未输入服务器地址" },
    ],
  });
  assert.equal(s.complete, false);
  assert.equal(s.skipped.length, 1);
  assert.match(s.skipped[0], /other/);
});

test("buildWizardSummary: npm 安装失败/拒绝只作提示，不影响完成度", () => {
  const ok = [{ id: "server-01", host: "myserver", status: "ok" }];
  assert.equal(buildWizardSummary({ serverResults: ok, npm: "failed" }).complete, true);
  assert.match(buildWizardSummary({ serverResults: ok, npm: "failed" }).notes.join(""), /npm install/);
  assert.match(buildWizardSummary({ serverResults: ok, npm: "declined" }).notes.join(""), /网页模式无需依赖/);
  assert.deepEqual(buildWizardSummary({ serverResults: ok, npm: "satisfied" }).notes, []);
});

test("MAC_APP_HINT: 不再让用户'双击根目录下的 .app'", () => {
  assert.doesNotMatch(MAC_APP_HINT, /双击运行根目录/);
  assert.match(MAC_APP_HINT, /build-macos-app\.sh/);
  assert.match(MAC_APP_HINT, /Releases/);
});

test("dependenciesSatisfied: 所有依赖目录都在才算就绪", () => {
  const pkg = { devDependencies: { electron: "1", "@biomejs/biome": "2" } };
  const present = new Set([path.join("/r", "node_modules", "electron", "package.json")]);
  assert.equal(dependenciesSatisfied(pkg, { rootDir: "/r", exists: (p) => present.has(p) }), false);
  present.add(path.join("/r", "node_modules", "@biomejs/biome", "package.json"));
  assert.equal(dependenciesSatisfied(pkg, { rootDir: "/r", exists: (p) => present.has(p) }), true);
  assert.equal(dependenciesSatisfied({}, { rootDir: "/r", exists: () => false }), true);
});
