import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTunnelHoldCommand, buildTunnelMarker } from "./supervisor/tunnel-spec.mjs";
import {
  FORWARD_FAILED_RE,
  ORPHAN_RULE_ID,
  classifyForwardFailure,
  parseSshProcessList,
} from "./tunnel-orphan.mjs";

// kai 现网那条：7891 反向端口 → 本机 8888 代理。
const signature = "-R 127.0.0.1:7891:127.0.0.1:8888 myserver";
const orphanCommand = `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -N ${signature}`;
const forwardFailedStderr = "Warning: remote port forwarding failed for listen port 7891";
const ownerId = "0123456789abcdef";
// v2.30 起带会话标记的隧道：-T + 远端等待命令，标记是 argv 的最后一段（ps 按空格拼接 argv）。
const markedCommand = (owner) => `ssh -o ExitOnForwardFailure=yes -o BatchMode=yes -T ${signature} ${buildTunnelHoldCommand(buildTunnelMarker(owner, 7891))}`;

function classify(overrides = {}) {
  return classifyForwardFailure({
    stderr: forwardFailedStderr,
    remoteListening: true,
    localSshProcesses: [],
    signature,
    ownerId,
    supervisorPid: 4242,
    platform: "darwin",
    ...overrides,
  });
}

test("tunnel-orphan: 规则 id 与 stderr 正则是对外契约（auto-repair 配置与 supervisor 共用同一份）", () => {
  assert.equal(ORPHAN_RULE_ID, "orphan-tunnel-adopt");
  assert.equal(FORWARD_FAILED_RE.test(forwardFailedStderr), true);
  assert.equal(FORWARD_FAILED_RE.test("Error: REMOTE PORT FORWARDING FAILED for listen port 7891"), true);
  assert.equal(FORWARD_FAILED_RE.test("bind: Address already in use"), false);
});

test("tunnel-orphan: 本机存在同签名的受管 ssh 进程 → adopt 并带上它的 pid", () => {
  const verdict = classify({
    localSshProcesses: [
      { pid: 321, command: "ssh -N -L 9000:127.0.0.1:9000 otherhost" },
      { pid: 5150, command: orphanCommand },
    ],
  });
  assert.equal(verdict.verdict, "adopt");
  assert.equal(verdict.pid, 5150);
  assert.equal(verdict.command, orphanCommand);
  assert.ok(verdict.reason.includes("5150"));
});

test("tunnel-orphan: 远端在监听但本机没有对应进程 → foreign（端口被异己占用）", () => {
  const verdict = classify({ localSshProcesses: [{ pid: 321, command: "ssh -N -R 127.0.0.1:7999:127.0.0.1:8888 myserver" }] });
  assert.equal(verdict.verdict, "foreign");
  assert.ok(verdict.reason.includes("7891"));
});

test("tunnel-orphan: 未命中 stderr 正则、或远端也没监听 → retry（普通失败，交给既有退避）", () => {
  assert.equal(classify({ stderr: "ssh: connect to host myserver port 22: Connection refused" }).verdict, "retry");
  assert.equal(classify({ stderr: "" }).verdict, "retry");
  // 命中正则但远端没监听、本机也没进程：端口其实是空的，重试才对。
  assert.equal(classify({ remoteListening: false }).verdict, "retry");
});

test("tunnel-orphan: 签名相同但会话标记的识别码不是本机的 → 不认领（另一个 checkout / 运行时的隧道）", () => {
  const foreign = markedCommand("ffffffffffffffff");
  const verdict = classify({ localSshProcesses: [{ pid: 5150, command: foreign }] });
  assert.equal(verdict.verdict, "foreign", "别的实例建的隧道对本实例而言就是异己占用，绝不认领、绝不杀");
  // 本实例没有识别码时，任何带标记的候选都不是自己的。
  assert.equal(classify({ ownerId: null, localSshProcesses: [{ pid: 5150, command: markedCommand(ownerId) }] }).verdict, "foreign");
  // 异己标记的候选被剔除后，同签名的自有候选照常胜出（即使它 pid 更大）。
  const mixed = classify({ localSshProcesses: [{ pid: 5150, command: foreign }, { pid: 6000, command: markedCommand(ownerId) }] });
  assert.equal(mixed.verdict, "adopt");
  assert.equal(mixed.pid, 6000);
});

test("tunnel-orphan: 会话标记是本机识别码 → 认领", () => {
  const command = markedCommand(ownerId);
  const verdict = classify({ localSshProcesses: [{ pid: 5150, command }] });
  assert.equal(verdict.verdict, "adopt");
  assert.equal(verdict.pid, 5150);
  assert.equal(verdict.command, command);
});

test("tunnel-orphan: 不带标记的旧 -N 隧道无从区分归属，照旧按签名认领", () => {
  assert.equal(classify({ localSshProcesses: [{ pid: 5150, command: orphanCommand }] }).verdict, "adopt");
  assert.equal(classify({ ownerId: null, localSshProcesses: [{ pid: 5150, command: orphanCommand }] }).verdict, "adopt");
});

test("tunnel-orphan: 多个候选取 pid 最小（最老）的那个", () => {
  const verdict = classify({
    localSshProcesses: [
      { pid: 9100, command: orphanCommand },
      { pid: 5150, command: orphanCommand },
      { pid: 7000, command: orphanCommand },
    ],
  });
  assert.equal(verdict.pid, 5150, "最老的那条才是真正在服务数据面的孤儿");
});

test("tunnel-orphan: supervisor 自己的 pid 与坏条目一律排除", () => {
  assert.equal(classify({ localSshProcesses: [{ pid: 4242, command: orphanCommand }] }).verdict, "foreign");
  assert.equal(
    classify({ localSshProcesses: [{ pid: 0, command: orphanCommand }, { command: orphanCommand }, { pid: 5150 }, null] }).verdict,
    "foreign",
  );
});

test("tunnel-orphan: 签名为空或形状不对时不认领（不能凭空匹配任意 ssh）", () => {
  assert.equal(classify({ signature: "", localSshProcesses: [{ pid: 5150, command: orphanCommand }] }).verdict, "foreign");
  assert.equal(
    classify({ signature: "not-a-signature", localSshProcesses: [{ pid: 5150, command: "ssh not-a-signature" }] }).verdict,
    "foreign",
  );
});

test("tunnel-orphan: win32 有明确命令行依据时可认领", () => {
  const verdict = classify({ platform: "win32", localSshProcesses: [{ pid: 5150, command: orphanCommand }] });
  assert.equal(verdict.verdict, "adopt");
  assert.equal(verdict.pid, 5150);
});

test("tunnel-orphan: parseSshProcessList 只留 ssh 进程，丢掉非 ssh 行与坏行", () => {
  const stdout = [
    "  501 /usr/bin/ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver",
    " 1234 ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver",
    " 2345 node work/monitor/channel-supervisor.mjs",
    " 3456 sshd: kai@notty",
    " 4567 grep ssh",
    "garbage line without pid",
    "",
    "   -1 ssh -N myserver",
  ].join("\n");
  assert.deepEqual(parseSshProcessList(stdout), [
    { pid: 501, command: "/usr/bin/ssh -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver" },
    { pid: 1234, command: "ssh -N -R 127.0.0.1:7893:127.0.0.1:8888 tengxunserver" },
  ]);
  assert.deepEqual(parseSshProcessList(""), []);
  assert.deepEqual(parseSshProcessList(undefined), []);
});


test("Windows 孤儿 SSH 清单接受 ssh.exe 的绝对路径与引号，不把 PowerShell/sshd 当 SSH", () => {
  const command = '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -R 127.0.0.1:7891:127.0.0.1:8888 myserver';
  const rows = parseSshProcessList(`42 ${command}\n43 powershell -Command ${command}\n44 sshd.exe user`);
  assert.deepEqual(rows, [{ pid: 42, command }]);
  assert.equal(classify({ platform: "win32", localSshProcesses: rows }).verdict, "adopt");
});
