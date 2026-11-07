import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SSH_CONTROL_ARGS,
  SSH_NO_MUX_ARGS,
  buildProbeControlArgs,
  assertSafeHost,
  assertSafePort,
  assertSafeSshUser,
  attachPersonalSsh,
  buildPinnedProbeSshArgs,
  buildProbeSshArgs,
  buildRemotePortProbeCommand,
  buildSshIdentityArgs,
  buildSshPortArgs,
  classifySshFailure,
} from "./ssh-args.mjs";
import { buildHostKeyArgs } from "./host-key-policy.mjs";

// 临时目录下的真实 known_hosts 路径在 Windows 上含反斜杠，buildHostKeyArgs 会按 ssh_config 语法
// 加引号转义（同 probes.test.mjs），期望值交给同一个生产函数构造，不自己拼裸路径。
const userKnownHostsArg = (knownHostsPath) => buildHostKeyArgs({ knownHostsPath }).find((arg) => arg.startsWith("UserKnownHostsFile="));

// ---------------------------------------------------------------------------
// 纵深防御：remotePort/host/sshUser 即使绕过 normalizeAgentConfig 也必须被拒。
// ---------------------------------------------------------------------------

test("buildRemotePortProbeCommand: 恶意 remotePort 直接 throw，不进远端 shell 串", () => {
  for (const evil of ["1234; rm -rf /", "$(id)", "`id`", "7891 || curl evil", "7891\nrm -rf /", 0, -1, 65536, 7891.5, null, undefined, NaN, {}]) {
    assert.throws(() => buildRemotePortProbeCommand(evil), /unsafe remotePort/, `应拒绝: ${JSON.stringify(evil)}`);
  }
});

test("buildRemotePortProbeCommand: 合法端口保持既有单层括号命令格式", () => {
  const command = buildRemotePortProbeCommand(7891);
  assert.equal(command, "(ss -lnt | grep -q :7891 || nc -z 127.0.0.1 7891 || lsof -i:7891 -sTCP:LISTEN)");
  assert.ok(!command.startsWith("(("), "不得出现双括号（远端 bash 会当算术表达式）");
  // 数字字符串端口（旧配置常见形态）归一为数字后放行。
  assert.match(buildRemotePortProbeCommand("7893"), /:7893 /);
});

test("assertSafePort: 1-65535 整数放行并归一为 number", () => {
  assert.equal(assertSafePort(1), 1);
  assert.equal(assertSafePort(65535), 65535);
  assert.equal(assertSafePort("8888"), 8888);
});

test("assertSafeHost: 选项注入与 shell 元字符被拒", () => {
  for (const evil of ["-oProxyCommand=evil", "-v", "host;id", "host id", "$(id)", "`id`", "host|id", "host'x", 'host"x', "host{}", "", null, undefined, 42]) {
    assert.throws(() => assertSafeHost(evil), /unsafe host/, `应拒绝: ${JSON.stringify(evil)}`);
  }
});

test("assertSafeHost: 合法 ssh 目标放行（别名/域名/user@host/IPv6）", () => {
  for (const ok of ["myserver", "cluster-01.example.com", "alice@myserver", "10.0.0.2", "[::1]", "fe80::1"]) {
    assert.equal(assertSafeHost(ok), ok);
  }
});

test("assertSafeSshUser: 以 - 开头或含非法字符被拒", () => {
  for (const evil of ["-oProxyCommand=evil", "-x", "bad user", "user;id", "$(id)", "", null]) {
    assert.throws(() => assertSafeSshUser(evil), /unsafe sshUser/, `应拒绝: ${JSON.stringify(evil)}`);
  }
  assert.equal(assertSafeSshUser("cluster-alice"), "cluster-alice");
  assert.equal(assertSafeSshUser("bob.01_x"), "bob.01_x");
});

// ---------------------------------------------------------------------------
// 组装函数内的硬校验。
// ---------------------------------------------------------------------------

test("buildProbeSshArgs: 恶意 host（-oProxyCommand=evil / shell 元字符）throw", () => {
  assert.throws(() => buildProbeSshArgs({ host: "-oProxyCommand=evil" }, {}), /unsafe host/);
  assert.throws(() => buildProbeSshArgs({ host: "myserver; rm -rf /" }, {}), /unsafe host/);
  assert.throws(() => buildProbeSshArgs({ host: "$(id)" }, {}), /unsafe host/);
});

test("buildProbeSshArgs: 正常配置不受影响，host 缺失保持旧的 filter 行为", () => {
  const args = buildProbeSshArgs({ host: "myserver" }, { sshUser: "alice", sshIdentityFile: "/tmp/id" });
  assert.equal(args.at(-1), "myserver");
  assert.ok(args.includes("-l") && args.includes("alice"));
  assert.ok(args.includes("-i") && args.includes("/tmp/id"));
  // host 缺失：不 throw（保持既有行为，让 ssh 自己失败），也不产生空参数。
  const noHost = buildProbeSshArgs({}, {});
  assert.ok(!noHost.includes(undefined) && !noHost.includes(""));
});

test("buildSshIdentityArgs: 恶意 sshUser throw，合法值原样带上 -l", () => {
  assert.throws(() => buildSshIdentityArgs({ sshUser: "-oProxyCommand=evil" }), /unsafe sshUser/);
  assert.throws(() => buildSshIdentityArgs({ sshUser: "u;id" }), /unsafe sshUser/);
  assert.deepEqual(buildSshIdentityArgs({ sshUser: "bob" }), ["-l", "bob"]);
});

test("attachPersonalSsh: 个人层非法 sshUser（含以 - 开头）静默丢弃，不进配置", () => {
  assert.equal(attachPersonalSsh({ host: "myserver" }, { sshUser: "bad user" }).sshUser, undefined);
  assert.equal(attachPersonalSsh({ host: "myserver" }, { sshUser: "-lroot" }).sshUser, undefined);
  assert.equal(attachPersonalSsh({ host: "myserver" }, { sshUser: "alice" }).sshUser, "alice");
});

// ---------------------------------------------------------------------------
// v2.18：Windows OpenSSH 无 ControlMaster 复用连接，带上这三项会直接报错。
// ---------------------------------------------------------------------------

test("buildProbeSshArgs: win32 剔除 ControlMaster 三项，身份参数与 host 照旧", () => {
  const args = buildProbeSshArgs(
    { host: "myserver" },
    { sshUser: "alice", sshIdentityFile: "C:/Users/alice/.ssh/id_ed25519" },
    { platform: "win32" },
  );
  // "-o" 本身仍会因 IdentitiesOnly 出现，只断言三个 Control* 取值不在。
  for (const part of SSH_CONTROL_ARGS.filter((p) => p !== "-o")) {
    assert.ok(!args.includes(part), `win32 不得带 ${part}`);
  }
  assert.ok(!args.some((part) => String(part).startsWith("Control")));
  assert.deepEqual(args, [...buildHostKeyArgs(), "-i", "C:/Users/alice/.ssh/id_ed25519", "-o", "IdentitiesOnly=yes", "-l", "alice", "myserver"]);
});

test("buildProbeSshArgs: 显式非 win32 带严格 host-key，缺省回落 process.platform", () => {
  const expected = [...SSH_CONTROL_ARGS, ...buildHostKeyArgs(), "myserver"];
  for (const platform of ["darwin", "linux", "freebsd"]) {
    assert.deepEqual(buildProbeSshArgs({ host: "myserver" }, {}, { platform }), expected, `platform=${platform}`);
  }
  // 缺省、空 options、显式 undefined 三种写法都回落 process.platform。期望值随宿主平台
  // 切换，win32 CI 上校验的就是"回落到 win32 会剥掉 Control*"——断言强度不变。
  const fallback = process.platform === "win32" ? [...buildHostKeyArgs(), "myserver"] : expected;
  assert.deepEqual(buildProbeSshArgs({ host: "myserver" }, {}), fallback);
  assert.deepEqual(buildProbeSshArgs({ host: "myserver" }, {}, {}), fallback);
  assert.deepEqual(buildProbeSshArgs({ host: "myserver" }, {}, { platform: undefined }), fallback);
});

test("buildProbeSshArgs: 有 known_hosts 文件时带 UserKnownHostsFile 与 GlobalKnownHostsFile=/dev/null", () => {
  const knownHostsPath = "/tmp/ssh/known_hosts-box";
  const args = buildProbeSshArgs({ host: "myserver" }, {}, { knownHostsPath });
  assert.ok(args.includes(`UserKnownHostsFile=${knownHostsPath}`));
  assert.ok(args.includes("GlobalKnownHostsFile=/dev/null"));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.equal(args.includes("accept-new"), false);
});

test("buildProbeSshArgs: win32 上 host 硬校验依然生效", () => {
  assert.throws(() => buildProbeSshArgs({ host: "-oProxyCommand=evil" }, {}, { platform: "win32" }), /unsafe host/);
});

// ---- v2.18 多隧道：server 条目自带的身份优先于全局个人字段 ----

test("attachPersonalSsh: 条目自带的合法 sshUser/sshIdentityFile 压过顶层个人字段", () => {
  const attached = attachPersonalSsh(
    { id: "server-tengxun", host: "tengxunserver", sshUser: " ubuntu ", sshIdentityFile: " /Users/me/.ssh/id_tengxun " },
    { sshUser: "kai", sshIdentityFile: "/Users/me/.ssh/id_codex" },
  );
  assert.equal(attached.sshUser, "ubuntu");
  assert.equal(attached.sshIdentityFile, "/Users/me/.ssh/id_tengxun");
});

test("attachPersonalSsh: 条目没写身份时仍回落顶层个人字段（旧行为）", () => {
  const attached = attachPersonalSsh(
    { id: "server-01", host: "myserver" },
    { sshUser: "kai", sshIdentityFile: " /Users/me/.ssh/id_codex " },
  );
  assert.equal(attached.sshUser, "kai");
  assert.equal(attached.sshIdentityFile, "/Users/me/.ssh/id_codex");
});

test("attachPersonalSsh: 条目自带的非法 sshUser 被丢弃并回落全局，不会顺着展开流到 -l", () => {
  const attached = attachPersonalSsh(
    { id: "server-tengxun", host: "tengxunserver", sshUser: "-oProxyCommand=evil" },
    { sshUser: "kai" },
  );
  assert.equal(attached.sshUser, "kai");
  assert.deepEqual(buildSshIdentityArgs(attached), ["-l", "kai"]);

  // 全局也没有合法值时，非法的条目值必须被删掉（而不是留在对象上让 assertSafeSshUser 抛）。
  const dropped = attachPersonalSsh({ host: "tengxunserver", sshUser: "bad user" }, {});
  assert.equal(dropped.sshUser, undefined);
  assert.deepEqual(buildSshIdentityArgs(dropped), []);
});

test("buildProbeSshArgs: 个人服务器的探针与隧道用同一套身份（条目优先）", () => {
  const args = buildProbeSshArgs(
    { host: "tengxunserver", sshUser: "ubuntu" },
    { sshUser: "kai" },
  );
  assert.ok(args.includes("ubuntu"));
  assert.equal(args.includes("kai"), false);
});

test("buildSshPortArgs / buildProbeSshArgs: sshPort 统一生成 -p", () => {
  assert.deepEqual(buildSshPortArgs(2222), ["-p", "2222"]);
  assert.throws(() => buildSshPortArgs("22; rm"), /unsafe sshPort/);
  const args = buildProbeSshArgs({ host: "10.0.0.8", sshUser: "ubuntu", sshPort: 2222 }, {});
  const portAt = args.indexOf("-p");
  assert.ok(portAt >= 0);
  assert.equal(args[portAt + 1], "2222");
  assert.equal(args.at(-1), "10.0.0.8");
});

test("classifySshFailure: host-key 变化进入 hostkey", () => {
  assert.equal(classifySshFailure("Host key verification failed.").code, "hostkey");
  assert.equal(classifySshFailure("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!").code, "hostkey");
});

// ---------------------------------------------------------------------------
// 钉扎 known_hosts 的探针复用：socket 绑定钉扎修订号 + 身份，短且无空格
// ---------------------------------------------------------------------------

test("buildProbeControlArgs: 钉扎时复用 ~/.ssh/cm-<tag>-%C；修订号/身份/端口变化换 socket", () => {
  const base = { platform: "darwin", knownHostsPath: "/data/ssh/known_hosts-s1", knownHostsRevision: "r1", identity: { host: "box", sshUser: "alice" }, homeDir: "/Users/alice" };
  const args = buildProbeControlArgs(base);
  assert.equal(args[1], "ControlMaster=auto");
  assert.match(args[3], /^ControlPath=~\/\.ssh\/cm-[0-9a-f]{8}-%C$/);
  assert.equal(args[5], "ControlPersist=5m");
  const pathOf = (opts) => buildProbeControlArgs({ ...base, ...opts })[3];
  assert.notEqual(pathOf({ knownHostsRevision: "r2" }), args[3], "钉扎内容变化 → 新 socket（旧 master 绕不过新钉扎）");
  assert.notEqual(pathOf({ identity: { ...base.identity, sshIdentityFile: "/k2" } }), args[3], "换钥匙 → 新 socket");
  assert.notEqual(pathOf({ identity: { ...base.identity, sshPort: 2222 } }), args[3]);
  assert.equal(pathOf({}), args[3], "同一钉扎同一身份复用同一 socket");
  assert.notEqual(args[3], SSH_CONTROL_ARGS[3], "钉扎与未钉扎永不共用 socket");
});

test("buildProbeControlArgs: win32 无复用；取不到修订号/家目录含空格/路径可能超长时保守不复用", () => {
  const base = { platform: "darwin", knownHostsPath: "/data/ssh/known_hosts-s1", knownHostsRevision: "r1", identity: { host: "box" }, homeDir: "/Users/alice" };
  assert.deepEqual(buildProbeControlArgs({ ...base, platform: "win32" }), []);
  assert.deepEqual(buildProbeControlArgs({ ...base, knownHostsPath: undefined }), SSH_CONTROL_ARGS);
  assert.deepEqual(buildProbeControlArgs({ ...base, knownHostsRevision: undefined, knownHostsPath: "/nonexistent/known_hosts-x" }), SSH_NO_MUX_ARGS);
  assert.deepEqual(buildProbeControlArgs({ ...base, homeDir: "/Users/with space" }), SSH_NO_MUX_ARGS);
  assert.deepEqual(buildProbeControlArgs({ ...base, homeDir: `/home/${"x".repeat(40)}` }), SSH_NO_MUX_ARGS);
  assert.deepEqual(buildProbeControlArgs({ ...base, homeDir: "" }), SSH_NO_MUX_ARGS);
});

test("buildProbeControlArgs: 路径长度按 UTF-8 字节计（非 ASCII 家目录不被低估）", () => {
  const base = { platform: "darwin", knownHostsPath: "/data/ssh/known_hosts-s1", knownHostsRevision: "r1", identity: { host: "box" } };
  // 预算：103 - 17(临时后缀) - 40(%C) - 18("/.ssh/cm-xxxxxxxx-") = 28 字节留给家目录。
  const fits = `/Users/${"中".repeat(7)}`; // 7 + 21 = 28 字节（字符串长度 14）
  const over = `/Users/${"中".repeat(8)}`; // 7 + 24 = 31 字节，但字符串长度只有 15
  assert.equal(Buffer.byteLength(over, "utf8"), 31);
  assert.equal(buildProbeControlArgs({ ...base, homeDir: fits })[1], "ControlMaster=auto");
  assert.deepEqual(buildProbeControlArgs({ ...base, homeDir: over }), SSH_NO_MUX_ARGS);
});

test("buildProbeSshArgs: 钉扎文件存在时按内容修订号复用，文件内容变化后 ControlPath 随之变化", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ssh-args-pin-"));
  try {
    const knownHostsPath = join(dir, "known_hosts-box");
    writeFileSync(knownHostsPath, "box ssh-ed25519 AAAA\n");
    const first = buildProbeSshArgs({ host: "box" }, {}, { platform: "linux", knownHostsPath, homeDir: "/home/u" });
    assert.ok(first.includes("ControlMaster=auto"));
    assert.ok(first.includes(userKnownHostsArg(knownHostsPath)));
    writeFileSync(knownHostsPath, "box ssh-ed25519 BBBBBBBB\n");
    const second = buildProbeSshArgs({ host: "box" }, {}, { platform: "linux", knownHostsPath, homeDir: "/home/u" });
    const cp = (args) => args.find((a) => a.startsWith("ControlPath="));
    assert.notEqual(cp(first), cp(second));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("buildPinnedProbeSshArgs: 与 buildProbeSshArgs + resolveKnownHostsIfPresent 逐项一致（含 ControlMaster 组）", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "ssh-args-pinned-"));
  const server = { id: "box", host: "box", sshUser: "alice", sshPort: 2222 };
  try {
    for (const platform of ["darwin", "linux", "win32"]) {
      // 未确认主机密钥：与未钉扎形态完全相同（常规 control-%r@%h:%p 复用）。
      assert.deepEqual(buildPinnedProbeSshArgs(server, {}, { dataDir, platform }), buildProbeSshArgs(server, {}, { platform }), platform);
    }
    assert.deepEqual(buildPinnedProbeSshArgs(server, {}, { dataDir: undefined }), buildProbeSshArgs(server, {}));
    const knownHostsPath = join(dataDir, "ssh", "known_hosts-box");
    mkdirSync(join(dataDir, "ssh"), { recursive: true });
    writeFileSync(knownHostsPath, "box ssh-ed25519 AAAA\n");
    for (const platform of ["darwin", "linux", "win32"]) {
      assert.deepEqual(
        buildPinnedProbeSshArgs(server, {}, { dataDir, platform }),
        buildProbeSshArgs(server, {}, { platform, knownHostsPath }),
        platform,
      );
    }
    const pinned = buildPinnedProbeSshArgs(server, {}, { dataDir, platform: "linux" });
    assert.ok(pinned.includes(userKnownHostsArg(knownHostsPath)));
    assert.equal(pinned.at(-1), "box");
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
