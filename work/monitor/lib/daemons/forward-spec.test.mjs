// 服务直达的转发参数（forward-spec.mjs，纯函数）：要避开的本机端口、ssh 参数、命令行特征、登记名、
// ssh -G 输出里的端口转发。不起任何进程，任何系统都能跑。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseProcessList } from "../../monitor-core.mjs";
import { cmdlineMatches } from "../process-registry.mjs";
import { buildPinnedProbeSshArgs } from "../ssh-args.mjs";
import {
  buildForwardBase, buildForwardSshArgs, collectReservedPorts, findAmbientForwards, FORWARD_RECORD_PREFIX, FORWARD_REMOTE_HOSTS,
  forwardRecordName, forwardSignature, forwardSpec, isForwardRecordName,
} from "./forward-spec.mjs";

const SERVER = { id: "s1", name: "主集群", host: "fixture.invalid" };
// 探针的钉扎参数长这样：复用三件套 + 主机密钥 + 端口 + 身份 + 主机（最后一位）。
const PINNED = [
  "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/cm-1a2b3c4d-%C", "-o", "ControlPersist=5m",
  "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
  "-p", "2222", "-i", "/tmp/fixture keys/id_ed25519_codextunnel", "-o", "IdentitiesOnly=yes", "-l", "tester", "fixture.invalid",
];
const CONFIG = {
  activeServerId: "s1",
  storageBudgetBytes: 52428800,
  egress: { mode: "manual", url: "http://127.0.0.1:7890" },
  proxyAllowedTargets: ["relay.example.com:8443"],
  portOverrides: { s1: { remotePort: 7893, localPort: 8893 } },
  servers: [
    { id: "s1", host: "fixture.invalid", sshPort: 2222, remotePort: 7891, localPort: 8888 },
    { id: "p1", host: "other.invalid", remotePort: "7894", localPort: 8894, source: "personal" },
  ],
};

test("保留端口：8877 / 8888 / 1455 恒在；配置里名字带 port 的字段、portOverrides 整棵、字符串里的 :端口 都算", () => {
  const reserved = collectReservedPorts(CONFIG, [18877, "53000", null, 0, 70000]);
  for (const port of [8877, 8888, 1455, 7891, 2222, 7893, 8893, 7894, 8894, 7890, 8443, 18877, 53000]) assert.ok(reserved.has(port), String(port));
  assert.equal(reserved.has(52428800), false, "不是端口的数字不收");
  assert.equal(reserved.has(0), false);
  assert.deepEqual([...collectReservedPorts(null)].sort((a, b) => a - b), [1455, 8877, 8888]);
  const loop = { remotePort: 7001 };
  loop.self = loop;
  assert.ok(collectReservedPorts(loop).has(7001), "循环引用不死循环");
});

test("ssh 参数：独立连接（-S none、不复用）、转发失败即退出、带心跳、只绑 127.0.0.1；探针的复用参数被剥掉", () => {
  const base = buildForwardBase(PINNED, "fixture.invalid");
  const args = buildForwardSshArgs(base, { localPort: 51234, remotePort: 8814, remoteHost: "127.0.0.1" });
  assert.equal(args[0], "-N");
  assert.deepEqual(args.slice(-3), ["-L", "127.0.0.1:51234:127.0.0.1:8814", "fixture.invalid"], "转发串紧挨在主机之前，主机是最后一个参数（后面没有远端命令）");
  const options = args.filter((_v, i) => args[i - 1] === "-o");
  for (const want of ["ControlMaster=no", "BatchMode=yes", "ExitOnForwardFailure=yes", "GatewayPorts=no", "ServerAliveInterval=20", "ServerAliveCountMax=3", "TCPKeepAlive=yes", "ConnectTimeout=10"]) {
    assert.ok(options.includes(want), want);
  }
  assert.deepEqual(args.slice(1, 3), ["-S", "none"]);
  assert.equal(options.filter((o) => /^Control/.test(o)).join(","), "ControlMaster=no", "ControlMaster=auto / ControlPath / ControlPersist 不能留");
  assert.ok(options.indexOf("ControlMaster=no") < options.indexOf("StrictHostKeyChecking=yes"), "我们的选项排在前面（ssh 对同名选项取第一个）");
  for (const kept of ["StrictHostKeyChecking=yes", "UpdateHostKeys=no", "IdentitiesOnly=yes"]) assert.ok(options.includes(kept), kept);
  assert.deepEqual(args.slice(args.indexOf("-p"), args.indexOf("-p") + 2), ["-p", "2222"]);
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2), ["-i", "/tmp/fixture keys/id_ed25519_codextunnel"]);
  assert.deepEqual(args.slice(args.indexOf("-l"), args.indexOf("-l") + 2), ["-l", "tester"]);
  for (const never of ["-R", "-D", "-f", "-M", "-A", "-X", "-g", "-t", "-tt"]) assert.equal(args.includes(never), false, `不该有 ${never}`);
  assert.equal(args.filter((a) => a === "-L").length, 1, "只有一条转发");

  assert.equal(forwardSpec({ localPort: 51234, remotePort: 5173, remoteHost: "[::1]" }), "127.0.0.1:51234:[::1]:5173");
  assert.deepEqual(FORWARD_REMOTE_HOSTS, ["127.0.0.1", "[::1]"]);
  for (const remoteHost of ["10.0.0.5", "localhost", "example.com", "0.0.0.0", "127.0.0.1 -oProxyCommand=x", ""]) {
    assert.throws(() => forwardSpec({ localPort: 51234, remotePort: 8814, remoteHost }), /回环地址/, remoteHost);
  }
  for (const [localPort, remotePort] of [["51234", 8814], [51234, "8814; reboot"], [0, 8814], [51234, 70000], [51234.5, 8814]]) {
    assert.throws(() => forwardSpec({ localPort, remotePort }), /端口不合法/);
  }
  assert.throws(() => buildForwardBase(PINNED, "another.invalid"), /主机/);
  assert.throws(() => buildForwardBase([...PINNED.slice(0, -1), "-oProxyCommand=evil"]), /unsafe host/);
  assert.throws(() => buildForwardBase([]), /unsafe host/);
});

test("ssh 参数：直接吃生产的钉扎参数（buildPinnedProbeSshArgs），与它实际给出的形状对得上", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "svc-forward-pin-"));
  try {
    const server = { id: "s1", host: "fixture.invalid", sshPort: 2222, sshUser: "tester" };
    const pinned = buildPinnedProbeSshArgs(server, { sshIdentityFile: "/tmp/id_fixture" }, { dataDir });
    const args = buildForwardSshArgs(buildForwardBase(pinned, server.host), { localPort: 51234, remotePort: 8814 });
    assert.deepEqual(args.slice(-3), ["-L", "127.0.0.1:51234:127.0.0.1:8814", "fixture.invalid"]);
    assert.equal(args.some((arg) => /^Control(Path|Persist)=/.test(arg) || arg === "ControlMaster=auto"), false);
    assert.ok(args.includes("/tmp/id_fixture") && args.includes("tester") && args.includes("2222"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("命令行特征：对得上自己那条 ssh（Windows 带引号的形态也行），对不上别的端口、别的主机与反向隧道", () => {
  const base = buildForwardBase(PINNED, "fixture.invalid");
  const target = { localPort: 51234, remotePort: 8814, remoteHost: "127.0.0.1" };
  const args = buildForwardSshArgs(base, target);
  const meta = { command: `ssh ${args.join(" ")}`, args, signature: forwardSignature(base, target) };
  assert.equal(meta.signature, "-N ExitOnForwardFailure=yes -L 127.0.0.1:51234:127.0.0.1:8814 fixture.invalid");
  assert.equal(cmdlineMatches(`/usr/bin/ssh ${args.join(" ")}`, meta), true);
  const quoted = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg)).join(" ");
  assert.equal(cmdlineMatches(`"C:\\Windows\\System32\\OpenSSH\\ssh.exe" ${quoted}`, meta), true, "带空格的参数被加了引号也认得");
  assert.equal(cmdlineMatches(`/usr/bin/ssh ${args.join(" ").replace("51234", "51235")}`, meta), false, "别的本机端口不是这一条");
  assert.equal(cmdlineMatches(`/usr/bin/ssh ${args.join(" ").replaceAll("fixture.invalid", "other.invalid")}`, meta), false);
  assert.equal(cmdlineMatches("ssh -S none -o ExitOnForwardFailure=yes -N -R 127.0.0.1:7891:127.0.0.1:8888 fixture.invalid", meta), false, "现役隧道绝不会被当成转发");
  assert.equal(cmdlineMatches("node /somewhere/else.js", meta), false);
  assert.equal(forwardRecordName("s1", 8814), "service-forward.s1.8814");
  assert.throws(() => forwardRecordName("../x", 8814), /unsafe serverId/);
  assert.equal(FORWARD_RECORD_PREFIX.startsWith("tunnel."), false, "登记名不能落进隧道记录的前缀：退出与热更新按 tunnel.* 找隧道");
});

test("转发的命令行不会被进程探针认成隧道：本机端口不等于任何已配置的端口，-L 的转发串就不可能撞上 -R 的", () => {
  const base = buildForwardBase(PINNED, "fixture.invalid");
  const tunnels = [{ id: "s1", host: "fixture.invalid", remotePort: 7891 }];
  const psLine = (localPort, remotePort) => `tester 4242 1 0 10:00 ?? 0:00.01 /usr/bin/ssh ${buildForwardSshArgs(base, { localPort, remotePort }).join(" ")}`;
  // 最容易撞的情形：集群上的服务正好监听 8888（与本机代理端口同号，比如 Jupyter）。
  const forward = parseProcessList(psLine(51234, 8888), SERVER, { proxyPort: 8888, tunnels });
  assert.deepEqual([forward.reverseTunnel, forward.tunnelsByServer.s1], [[], []]);
  // 反过来说明为什么必须避开已配置的端口：本机端口若等于反向端口，这条 -L 就会被数成隧道。
  const clash = parseProcessList(psLine(7891, 8888), SERVER, { proxyPort: 8888, tunnels });
  assert.equal(clash.reverseTunnel.length, 1);
  assert.ok(collectReservedPorts(CONFIG).has(7891) && collectReservedPorts(CONFIG).has(8888), "这两个端口都在保留集合里，挑不到");
});

test("ssh -G 输出里的端口转发：三种都认；没有就是空", () => {
  const dump = "user tester\nhostname fixture.invalid\nport 22\nRemoteForward 7891 [127.0.0.1]:8888\r\nlocalforward 8080 [127.0.0.1]:80\n  dynamicforward 1080\nforwardagent no\n";
  assert.deepEqual(findAmbientForwards(dump), ["RemoteForward 7891 [127.0.0.1]:8888", "LocalForward 8080 [127.0.0.1]:80", "DynamicForward 1080"]);
  assert.deepEqual(findAmbientForwards("user tester\nexitonforwardfailure yes\ngatewayports no\n"), []);
  assert.deepEqual(findAmbientForwards(null), []);
});

test("登记名：只认 service-forward.<服务器>.<端口> 这一种形状", () => {
  for (const name of ["service-forward.s1.8814", "service-forward.server-01.40161", "service-forward.a.b.1024"]) assert.equal(isForwardRecordName(name), true, name);
  for (const name of ["tunnel.s1", "service-forward", "service-forward.s1", "service-forward.s1.abc", "service-forward..8814", "service-forward.s1.8814.pid.json", "x.service-forward.s1.8814", null, 8814]) {
    assert.equal(isForwardRecordName(name), false, String(name));
  }
});
