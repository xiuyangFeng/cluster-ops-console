import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaimCommand,
  buildRegistryAdminCommand,
  buildRegistrySurveyCommand,
  buildReleaseCommand,
  DEFAULT_PORT_REGISTRY_DIR,
  MAX_CLAIM_CANDIDATES,
  normalizePortRegistryDir,
  ownRegisteredPorts,
  parseClaimResult,
  parseRegistrySurvey,
  parseReleaseResult,
  pickClaimCandidates,
  registeredOwnerOf,
  resolvePortRegistryDir,
} from "./port-registry.mjs";

// 集群登录节点 2026-10-07 只读采样的 ss -ltn（节选，kai 的 7891 在监听）。
const CLUSTER_SS_SAMPLE = [
  "State   Recv-Q   Send-Q     Local Address:Port      Peer Address:Port  Process  ",
  "LISTEN  0        511            127.0.0.1:42213          0.0.0.0:*              ",
  "LISTEN  0        151            127.0.0.1:3306           0.0.0.0:*              ",
  "LISTEN  0        128            127.0.0.1:7891           0.0.0.0:*              ",
  "LISTEN  0        128                [::1]:7895              [::]:*              ",
  "LISTEN  0        511              0.0.0.0:5555           0.0.0.0:*              ",
  "LISTEN  0        128              0.0.0.0:22             0.0.0.0:*              ",
  "LISTEN  0        5              127.0.0.1:8891           0.0.0.0:*              ",
  "LISTEN  0        5              127.0.0.1:8892           0.0.0.0:*              ",
].join("\n");

// ---- 目录 ----

test("登记目录：只收安全字符的绝对路径，团队层可覆盖，写坏回落默认并告警", () => {
  assert.equal(normalizePortRegistryDir("/public/agent-hub/ports/"), "/public/agent-hub/ports");
  assert.equal(normalizePortRegistryDir("/data/team_1/ports"), "/data/team_1/ports");
  for (const bad of ["ports", "/", "", "/a/../b", "/a//b", "/a/./b", "/a b", "/a;rm -rf ~", "/a/$(id)", "/a'b", null, 7]) {
    assert.equal(normalizePortRegistryDir(bad), null, JSON.stringify(bad));
  }
  assert.equal(resolvePortRegistryDir({}), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(resolvePortRegistryDir(null), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(resolvePortRegistryDir({ portRegistry: { dir: "/srv/ports" } }), "/srv/ports");
  const warnings = [];
  assert.equal(resolvePortRegistryDir({ portRegistry: { dir: "relative/ports" } }, { warn: (m) => warnings.push(m) }), DEFAULT_PORT_REGISTRY_DIR);
  assert.equal(warnings.length, 1);
});

test("管理员命令：默认目录连同上级一起 1777；只读 / 缺粘滞位给 chmod；非法目录直接拒绝", () => {
  assert.equal(buildRegistryAdminCommand(), "sudo install -d -m 1777 /public/agent-hub /public/agent-hub/ports");
  assert.equal(buildRegistryAdminCommand("/srv/ports"), "sudo install -d -m 1777 /srv/ports");
  assert.equal(buildRegistryAdminCommand(DEFAULT_PORT_REGISTRY_DIR, { state: "readonly" }), "sudo chmod 1777 /public/agent-hub/ports");
  assert.equal(buildRegistryAdminCommand(DEFAULT_PORT_REGISTRY_DIR, { state: "no-sticky" }), "sudo chmod 1777 /public/agent-hub/ports");
  assert.throws(() => buildRegistryAdminCommand("/a;b"), /unsafe/);
});

// ---- 远端脚本（快照式断言：结构与关键语义，不比整串） ----

test("survey 脚本：一次 sh -c 输出 REGISTRY / STICKY / REG / ME / ss 段，不依赖 jq", () => {
  const cmd = buildRegistrySurveyCommand();
  assert.match(cmd, /^sh -c '/, "统一交给 sh，不受对方登录 shell 影响");
  assert.ok(cmd.includes("d='\\''/public/agent-hub/ports'\\''"), "目录单引号嵌入");
  for (const piece of ["REGISTRY=ok", "REGISTRY=readonly", "REGISTRY=absent", "STICKY=1", "STICKY=0", "REG\\t%s\\t%s\\t%s", "ME=%s", "id -un", "LISTEN-BEGIN", "ss -ltn", "LISTEN-END", "stat -c %U", "ls -ld"]) {
    assert.ok(cmd.includes(piece), `缺少 ${piece}`);
  }
  assert.ok(!/\bjq\b/.test(cmd));
  assert.ok(!cmd.includes("set -C"), "survey 只读，不创建任何文件");
  assert.throws(() => buildRegistrySurveyCommand("/x/$(reboot)"), /unsafe/);
});

test("claim 脚本：按序 set -C 原子创建、umask 022、复核属主；候选去重、过滤非法、封顶", () => {
  const cmd = buildClaimCommand(DEFAULT_PORT_REGISTRY_DIR, [7893, "7894", 7893, 0, "x", 70000, 7892]);
  assert.match(cmd, /^sh -c '/);
  assert.ok(cmd.includes("for p in 7893 7894 7892; do"), "保序、去重、丢非法值");
  // `!` 经 wrapSh 写成 '\!'（csh 在 -c 下也做历史替换），sh 收到的仍是 [ ! -L "$f" ]。
  for (const piece of ["set -C", "umask 022", "user=%s", "claimedAt=%s", "date -u +%Y-%m-%dT%H:%M:%SZ", "CLAIMED $p", "EXHAUSTED", "chmod 644", "[ '\\!' -L \"$f\" ]"]) {
    assert.ok(cmd.includes(piece), `缺少 ${piece}`);
  }
  assert.ok(cmd.indexOf("REGISTRY=absent") < cmd.indexOf("for p in"), "目录不可用先报，不进循环");
  const many = Array.from({ length: 200 }, (_, i) => 7892 + i);
  const capped = /for p in ([\d ]+); do/.exec(buildClaimCommand(DEFAULT_PORT_REGISTRY_DIR, many))[1].split(" ");
  assert.equal(capped.length, MAX_CLAIM_CANDIDATES);
  assert.throws(() => buildClaimCommand(DEFAULT_PORT_REGISTRY_DIR, []), /候选/);
  assert.throws(() => buildClaimCommand(DEFAULT_PORT_REGISTRY_DIR, ["abc"]), /候选/);
  assert.throws(() => buildClaimCommand("relative", [7892]), /unsafe/);
});

test("release 脚本：只删属主是自己的普通文件；端口非法直接拒绝", () => {
  const cmd = buildReleaseCommand(DEFAULT_PORT_REGISTRY_DIR, 7893);
  assert.ok(cmd.includes("f='\\''/public/agent-hub/ports/7893'\\''"));
  for (const piece of ["RELEASE=absent", "RELEASE=ok", "RELEASE=not-owner", "RELEASE=failed", "rm -f"]) assert.ok(cmd.includes(piece), piece);
  assert.throws(() => buildReleaseCommand(DEFAULT_PORT_REGISTRY_DIR, "7893; rm -rf ~"), /非法端口/);
});

// ---- 解析器 ----

test("parseRegistrySurvey：登记条目 / 当前账号 / 反向端口段监听（含 IPv6），杂行与非法条目忽略", () => {
  const text = [
    "Welcome to cluster",
    "REGISTRY=ok",
    "STICKY=1",
    "REG\t7893\talice\tf",
    "REG\t7891\tkai\tf",
    "REG\t7894\tbob\tx",
    "REG\tabc\tmallory\tf",
    "REG\t99999\tmallory\tf",
    "ME=kai",
    "LISTEN-BEGIN",
    CLUSTER_SS_SAMPLE,
    "LISTEN-END",
  ].join("\n");
  const s = parseRegistrySurvey(text);
  assert.equal(s.registry, "ok");
  assert.equal(s.sticky, true);
  assert.equal(s.me, "kai");
  assert.deepEqual(s.entries, [
    { port: 7891, owner: "kai", regular: true },
    { port: 7893, owner: "alice", regular: true },
    { port: 7894, owner: "bob", regular: false },
  ]);
  assert.deepEqual(s.listening, [7891, 7895, 8891], "只取 7891–8891 段；8892 越界、3306 等无关端口不算");
  assert.deepEqual(ownRegisteredPorts(s), [7891]);
  assert.equal(registeredOwnerOf(s, 7893), "alice");
  assert.equal(registeredOwnerOf(s, 7900), null);
});

test("parseRegistrySurvey：目录缺失 / 只读 / 输出缺失（SSH 失败）三种口径", () => {
  const absent = parseRegistrySurvey("REGISTRY=absent\nME=newbie\nLISTEN-BEGIN\nLISTEN-END\n");
  assert.equal(absent.registry, "absent");
  assert.equal(absent.sticky, null);
  assert.deepEqual(absent.entries, []);
  assert.equal(parseRegistrySurvey("REGISTRY=readonly\nSTICKY=0\n").registry, "readonly");
  assert.equal(parseRegistrySurvey("REGISTRY=readonly\nSTICKY=0\n").sticky, false);
  const failed = parseRegistrySurvey("");
  assert.equal(failed.registry, "unknown", "读不到 ≠ 目录不存在");
  assert.deepEqual(ownRegisteredPorts(failed), []);
  assert.deepEqual(ownRegisteredPorts({ me: "", entries: [{ port: 7892, owner: "", regular: true }] }), [], "没读到用户名不认领任何端口");
});

test("pickClaimCandidates：排除 已登记 ∪ 监听 ∪ 保留，升序，永不含 7891，可封顶", () => {
  assert.deepEqual(pickClaimCandidates({ registered: [7892, { port: 7894 }], listening: [7893], reserved: [7896], limit: 3 }), [7895, 7897, 7898]);
  assert.equal(pickClaimCandidates({})[0], 7892, "区间从 7892 起，7891 永远不是候选");
  assert.ok(!pickClaimCandidates({ limit: 1000 }).includes(7891));
  assert.equal(pickClaimCandidates({ limit: 2000 }).at(-1), 8891);
  const all = Array.from({ length: 1000 }, (_, i) => 7892 + i);
  assert.deepEqual(pickClaimCandidates({ registered: all }), [], "全部登记时给空列表，由调用方报错");
});

test("parseClaimResult / parseReleaseResult：各结论与异常输出", () => {
  assert.deepEqual(parseClaimResult("motd\nCLAIMED 7893\n"), { status: "claimed", port: 7893 });
  assert.deepEqual(parseClaimResult("EXHAUSTED\n"), { status: "exhausted" });
  assert.deepEqual(parseClaimResult("REGISTRY=absent\n"), { status: "absent" });
  assert.deepEqual(parseClaimResult("REGISTRY=readonly\n"), { status: "readonly" });
  assert.deepEqual(parseClaimResult(""), { status: "unknown" });
  assert.deepEqual(parseClaimResult("CLAIMED 99999\n"), { status: "unknown" });
  assert.deepEqual(parseReleaseResult("RELEASE=not-owner\n"), { status: "not-owner" });
  assert.deepEqual(parseReleaseResult("garbage"), { status: "unknown" });
});

// ---- 真跑脚本（本机 sh，临时目录模拟登记目录；Windows 无 POSIX sh，跳过） ----

const posix = process.platform !== "win32";
const runSh = (command) => execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" });
const runShAsync = (command) => new Promise((resolve, reject) => {
  execFile("/bin/sh", ["-c", command], { encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

function withRegistryDir(fn) {
  const root = mkdtempSync(path.join(tmpdir(), "port-registry-"));
  const dir = path.join(root, "ports");
  mkdirSync(dir);
  chmodSync(dir, 0o1777);
  try {
    return fn(dir, root);
  } finally {
    try { chmodSync(dir, 0o1777); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
}

test("真跑：survey → claim → 再 claim 顺延 → 名下端口 → release 只删自己的", { skip: !posix }, () => {
  withRegistryDir((dir) => {
    const before = parseRegistrySurvey(runSh(buildRegistrySurveyCommand(dir)));
    assert.equal(before.registry, "ok");
    assert.equal(before.sticky, true);
    assert.ok(before.me, "读到当前账号");
    assert.deepEqual(before.entries, []);

    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(dir, [7892, 7893]))), { status: "claimed", port: 7892 });
    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(dir, [7892, 7893]))), { status: "claimed", port: 7893 }, "已被占的端口跳过");
    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(dir, [7892, 7893]))), { status: "exhausted" });

    const body = readFileSync(path.join(dir, "7892"), "utf8");
    assert.match(body, new RegExp(`^user=${before.me}\\nclaimedAt=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z\\n$`));
    assert.equal(statSync(path.join(dir, "7892")).mode & 0o777, 0o644);

    const after = parseRegistrySurvey(runSh(buildRegistrySurveyCommand(dir)));
    assert.deepEqual(ownRegisteredPorts(after), [7892, 7893]);

    assert.deepEqual(parseReleaseResult(runSh(buildReleaseCommand(dir, 7893))), { status: "ok" });
    assert.deepEqual(parseReleaseResult(runSh(buildReleaseCommand(dir, 7893))), { status: "absent" });
    assert.deepEqual(ownRegisteredPorts(parseRegistrySurvey(runSh(buildRegistrySurveyCommand(dir)))), [7892]);
  });
});

// 对方登录 shell 是 csh / tcsh 时（ssh 用它解析外层命令串）：结论与 sh 完全一致。
const CSH_SHELLS = ["/bin/csh", "/bin/tcsh"].filter((p) => posix && existsSync(p));
const runVia = (shell, command) => execFileSync(shell, ["-c", command], { encoding: "utf8", env: { HOME: tmpdir(), PATH: "/usr/bin:/bin" } });

test("真跑（csh / tcsh 登录 shell）：survey → claim → release 与 sh 结论一致", { skip: CSH_SHELLS.length === 0 }, () => {
  for (const shell of CSH_SHELLS) {
    withRegistryDir((dir) => {
      writeFileSync(path.join(dir, "README"), "not a port"); // 走到 case 的 *[!0-9]* 分支
      const before = parseRegistrySurvey(runVia(shell, buildRegistrySurveyCommand(dir)));
      assert.equal(before.registry, "ok", shell);
      assert.deepEqual(before.entries, [], shell);
      assert.deepEqual(parseClaimResult(runVia(shell, buildClaimCommand(dir, [7892, 7893]))), { status: "claimed", port: 7892 }, shell);
      assert.deepEqual(ownRegisteredPorts(parseRegistrySurvey(runVia(shell, buildRegistrySurveyCommand(dir)))), [7892], shell);
      assert.deepEqual(parseReleaseResult(runVia(shell, buildReleaseCommand(dir, 7892))), { status: "ok" }, shell);
    });
  }
});

test("真跑：符号链接占位只算占用不算归属，领取跳过它；非数字文件名忽略", { skip: !posix }, () => {
  withRegistryDir((dir, root) => {
    writeFileSync(path.join(root, "target"), "x");
    symlinkSync(path.join(root, "target"), path.join(dir, "7892"));
    symlinkSync("/nonexistent-target", path.join(dir, "7893"));
    writeFileSync(path.join(dir, "README"), "not a port");
    const s = parseRegistrySurvey(runSh(buildRegistrySurveyCommand(dir)));
    assert.deepEqual(s.entries.map((e) => [e.port, e.regular]), [[7892, false], [7893, false]]);
    assert.deepEqual(ownRegisteredPorts(s), [], "链接不是自己的登记");
    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(dir, [7892, 7893, 7894]))), { status: "claimed", port: 7894 });
    assert.equal(readFileSync(path.join(root, "target"), "utf8"), "x", "链接指向的文件没被写");
  });
});

test("真跑：目录缺失 / 不可写时只报状态，不创建任何东西", { skip: !posix || process.getuid?.() === 0 }, () => {
  withRegistryDir((dir) => {
    const missing = path.join(dir, "nope");
    assert.equal(parseRegistrySurvey(runSh(buildRegistrySurveyCommand(missing))).registry, "absent");
    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(missing, [7892]))), { status: "absent" });
    chmodSync(dir, 0o555);
    assert.equal(parseRegistrySurvey(runSh(buildRegistrySurveyCommand(dir))).registry, "readonly");
    assert.deepEqual(parseClaimResult(runSh(buildClaimCommand(dir, [7892]))), { status: "readonly" });
  });
});

test("真跑：多个领取并发抢同一组候选，每人拿到的端口互不相同（O_EXCL）", { skip: !posix }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "port-registry-race-"));
  const dir = path.join(root, "ports");
  mkdirSync(dir);
  try {
    const candidates = [7892, 7893, 7894, 7895, 7896, 7897];
    const outputs = await Promise.all(Array.from({ length: 6 }, () => runShAsync(buildClaimCommand(dir, candidates))));
    const ports = outputs.map((o) => parseClaimResult(o)).map((r) => (r.status === "claimed" ? r.port : r.status));
    assert.equal(new Set(ports).size, 6, `并发领取撞号：${ports.join(",")}`);
    assert.deepEqual([...ports].sort((a, b) => a - b), candidates);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
