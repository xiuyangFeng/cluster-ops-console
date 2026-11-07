import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DAEMON_STATUS_SCRIPT, DAEMONS, parseDaemonOutput } from "./commands.mjs";
import {
  buildServices, classifyBind, detectServiceKind, MIN_SERVICE_PORT, parseListenLine, parseServiceOutput, redactCommandLine, SERVICE_LIMIT, SERVICE_LIST_SCRIPT, serviceView,
} from "./services.mjs";

// 集群上 `ss -ltnp` 的形状（2026-10-12 实测的端口与进程名，pid 是编的）：本人的监听带 users:(…)，别人的没有。
const SS_LINES = [
  'LISTEN 0      128        127.0.0.1:6767       0.0.0.0:*    users:(("Paseo Daemon",pid=211354,fd=23))',
  'LISTEN 0      5          127.0.0.1:8814       0.0.0.0:*    users:(("python",pid=3301234,fd=3))',
  'LISTEN 0      5          127.0.0.1:8815       0.0.0.0:*    users:(("python",pid=3301240,fd=3))',
  'LISTEN 0      5            0.0.0.0:8765       0.0.0.0:*    users:(("python",pid=2200001,fd=4))',
  'LISTEN 0      128        127.0.0.1:8780       0.0.0.0:*    users:(("python3",pid=2200002,fd=6))',
  'LISTEN 0      511        127.0.0.1:3773       0.0.0.0:*    users:(("t3",pid=1500001,fd=30))',
  'LISTEN 0      511        127.0.0.1:3774       0.0.0.0:*    users:(("t3",pid=1500002,fd=31))',
  'LISTEN 0      128        127.0.0.1:40161      0.0.0.0:*    users:(("reclaude",pid=900001,fd=12))',
  'LISTEN 0      128        127.0.0.1:7891       0.0.0.0:*    users:(("sshd",pid=800001,fd=9))',
  'LISTEN 0      128            [::1]:7891          [::]:*    users:(("sshd",pid=800001,fd=8))',
  "LISTEN 0      128          0.0.0.0:22         0.0.0.0:*",
  "LISTEN 0      128             [::]:22            [::]:*",
  "LISTEN 0      128        127.0.0.1:7892       0.0.0.0:*",
];

// 远端脚本对上面那些行的输出（只有带 pid= 的行会被送回来）。own = 哪些进程属于本人（远端只给它们出 proc 记录）：
// 缺省是行里出现的全部进程；procs 里写了详情的用详情，其余只有空的工作目录与命令行。
function remoteOutput({ lines = SS_LINES, procs = [], ages = [], home = "/public/home/kai", state = "ok", own = null } = {}) {
  const mine = lines.filter((line) => line.includes("pid="));
  const detailed = new Map(procs.map(([pid, cwd, cmd]) => [Number(pid), [cwd, cmd]]));
  const owned = own ?? [...new Set(mine.flatMap((line) => [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))))];
  return [
    ...mine.map((line) => `ss=${line.replace(/ +/g, " ")}`),
    ...owned.map((pid) => `proc=${pid}\t${detailed.get(pid)?.[0] ?? ""}\t${detailed.get(pid)?.[1] ?? ""}`),
    ...ages.map(([pid, sec]) => `age=${pid} ${sec}`),
    ...(home ? [`svc.home=${home}`] : []),
    ...(state ? [`svc.state=${state}`] : []),
    "",
  ].join("\n");
}

const DAEMON_PORTS = DAEMONS.map((def) => def.port);

test("远端片段：常量、可内嵌、只读；状态脚本与两个启动脚本都在 end=1 之前跑它", () => {
  assert.doesNotMatch(SERVICE_LIST_SCRIPT, /`|\$\{/, "内嵌在 String.raw 模板里：不能有反引号和 ${");
  assert.doesNotMatch(SERVICE_LIST_SCRIPT, /\b(kill|pkill|killall|sudo|restart|rm|mv|tee)\b/);
  assert.doesNotMatch(SERVICE_LIST_SCRIPT.replace(/2?>\/dev\/null/g, "").replace(/2>&1/g, ""), />/, "不写任何远端文件：重定向只有丢到 /dev/null 的");
  assert.match(SERVICE_LIST_SCRIPT, /ss -ltnp/);
  assert.doesNotMatch(SERVICE_LIST_SCRIPT, /ss -H/, "老版本 ss 没有 -H；表头行不含 pid=，本来就会被滤掉");
  assert.match(SERVICE_LIST_SCRIPT, /index\(\$0, "pid="\)/, "只留带 pid= 的行——ss 只对本人的进程给出进程信息");
  for (const script of [DAEMON_STATUS_SCRIPT, ...DAEMONS.map((d) => d.script)]) {
    assert.ok(script.includes(SERVICE_LIST_SCRIPT), "片段原样内嵌");
    const call = script.lastIndexOf("\nservice_list\n");
    assert.ok(call > script.lastIndexOf("\ndaemon_status\n") && call < script.lastIndexOf('\necho "end=1"\n'), "daemon_status → service_list → end=1");
  }
});

test("ss 一行的解析：带空格的进程名、一个监听挂多个进程、IPv6 的各种写法、没有进程信息的行", () => {
  assert.deepEqual(parseListenLine(SS_LINES[0]), { port: 6767, address: "127.0.0.1", procs: [{ name: "Paseo Daemon", pid: 211354 }] });
  assert.deepEqual(
    parseListenLine('LISTEN 0 511 *:3000 *:* users:(("node",pid=9,fd=20),("node",pid=10,fd=20),("node",pid=9,fd=21))'),
    { port: 3000, address: "*", procs: [{ name: "node", pid: 9 }, { name: "node", pid: 10 }] },
    "同一个进程的多个 fd 只算一次",
  );
  const v6 = (local) => parseListenLine(`LISTEN 0 128 ${local} [::]:* users:(("node",pid=11,fd=31))`);
  assert.deepEqual([v6("[::1]:5173").address, v6("[::1]:5173").port], ["::1", 5173]);
  assert.equal(v6("[::]:8000").address, "::");
  assert.equal(v6(":::8000").address, "::", "老版本 ss 不带方括号");
  assert.deepEqual([v6("::1:9000").address, v6("::1:9000").port], ["::1", 9000]);
  assert.equal(v6("[::ffff:127.0.0.1]:8080").address, "::ffff:127.0.0.1");
  assert.equal(v6("[fe80::1%eth0]:9000").address, "fe80::1", "接口后缀去掉");
  assert.equal(v6("127.0.0.53%lo:5353").address, "127.0.0.53");
  assert.equal(parseListenLine('tcp LISTEN 0 5 0.0.0.0:8765 0.0.0.0:* users:(("python",pid=7,fd=3))').port, 8765, "带 Netid 列也认得");
  // 进程名里有括号、逗号、等号都不影响；带引号时退一步只取 pid。
  assert.deepEqual(parseListenLine('LISTEN 0 5 127.0.0.1:9100 0.0.0.0:* users:(("my (app), v=2",pid=42,fd=3))').procs, [{ name: "my (app), v=2", pid: 42 }]);
  assert.deepEqual(parseListenLine('LISTEN 0 5 127.0.0.1:9101 0.0.0.0:* users:((weird"name,pid=43,fd=3))').procs, [{ name: "", pid: 43 }]);

  for (const line of [SS_LINES[10], SS_LINES[11], SS_LINES[12]]) assert.equal(parseListenLine(line), null, "别人的监听没有进程信息");
  for (const bad of [
    "",
    "State Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    'ESTAB 0 0 127.0.0.1:8814 127.0.0.1:5000 users:(("python",pid=1,fd=3))',
    'LISTEN 0 5 127.0.0.1:99999 0.0.0.0:* users:(("python",pid=1,fd=3))',
    'LISTEN 0 5 127.0.0.1:abc 0.0.0.0:* users:(("python",pid=1,fd=3))',
    'LISTEN 0 5 $(reboot):8814 0.0.0.0:* users:(("python",pid=1,fd=3))',
    'LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("python",pid=0,fd=3))',
    'LISTEN 0 5 users:(("python",pid=1,fd=3))',
    null,
  ]) assert.equal(parseListenLine(bad), null, String(bad));
});

test("监听地址归类：所有网卡 / 只有本机 / 具体地址；转发目标只在两个回环常量里选", () => {
  assert.deepEqual(classifyBind("0.0.0.0"), { scope: "all", target: "127.0.0.1" });
  assert.deepEqual(classifyBind("*"), { scope: "all", target: "127.0.0.1" });
  assert.deepEqual(classifyBind("::"), { scope: "all", target: "[::1]" });
  assert.deepEqual(classifyBind("::ffff:0.0.0.0"), { scope: "all", target: "127.0.0.1" });
  assert.deepEqual(classifyBind("127.0.0.1"), { scope: "loopback", target: "127.0.0.1" });
  assert.deepEqual(classifyBind("::ffff:127.0.0.1"), { scope: "loopback", target: "127.0.0.1" });
  assert.deepEqual(classifyBind("::1"), { scope: "loopback", target: "[::1]" });
  assert.deepEqual(classifyBind("127.0.0.53"), { scope: "loopback", target: null }, "别的回环地址：经 127.0.0.1 连不上");
  assert.deepEqual(classifyBind("10.1.2.3"), { scope: "address", target: null });
  assert.deepEqual(classifyBind("fe80::1"), { scope: "address", target: null });
  const targets = new Set(["0.0.0.0", "*", "::", "127.0.0.1", "::1", "10.1.2.3", "evil.example", "$(id)"].map((a) => classifyBind(a).target));
  assert.deepEqual([...targets].sort(), ["127.0.0.1", "[::1]", null].sort(), "远端报上来的地址永远不会成为转发目标");
});

test("服务列表：剔除 sshd 的监听、已单列的 Paseo / T3 端口与 1024 以下的端口；按端口排序；带上目录与时长", () => {
  const parsed = parseServiceOutput(remoteOutput({
    lines: [...SS_LINES, 'LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=77,fd=6))'],
    procs: [
      [3301234, "/public/home/kai/Digital_twin/GNN/outputs/cfd_auto_ad_repro_20261009/report", "python -m http.server 8814 --bind 127.0.0.1 "],
      [3301240, "/public/home/kai", "python -m http.server 8815 --bind 127.0.0.1"],
      [2200001, "/tmp/work", "python serve.py --host 0.0.0.0"],
    ],
    ages: [[3301234, 11520], [3301240, 60], [2200001, 190000]],
  }));
  assert.equal(parsed.state, "ok");
  const result = buildServices(parsed, { excludePorts: DAEMON_PORTS });
  assert.equal(result.complete, true);
  assert.deepEqual(result.services.map((s) => [s.port, s.name]), [[3774, "t3"], [8765, "python"], [8780, "python3"], [8814, "python"], [8815, "python"], [40161, "reclaude"]]);
  assert.deepEqual([...result.ports], [3774, 8765, 8780, 8814, 8815, 40161]);
  const report = result.services.find((s) => s.port === 8814);
  assert.deepEqual(report, {
    port: 8814, name: "python", pid: 3301234, procCount: 1, binds: ["127.0.0.1"], scope: "loopback", target: "127.0.0.1",
    cmdline: "python -m http.server 8814 --bind 127.0.0.1", cwd: "~/Digital_twin/GNN/outputs/cfd_auto_ad_repro_20261009/report", uptimeSec: 11520,
  });
  assert.equal(result.services.find((s) => s.port === 8815).cwd, "~", "就在家目录");
  const open = result.services.find((s) => s.port === 8765);
  assert.deepEqual([open.scope, open.target, open.cwd], ["all", "127.0.0.1", "/tmp/work"], "0.0.0.0 标成对所有网卡开放；家目录之外的路径原样");
  const bare = result.services.find((s) => s.port === 8780);
  assert.deepEqual([bare.cmdline, bare.cwd, bare.uptimeSec], ["", "", null], "工作目录 / 命令行 / 时长读不到时留空，不编");
  assert.deepEqual(serviceView(report).forwardable, true);
  assert.deepEqual(serviceView(report).kind, { id: "http-server", label: "静态文件服务" });
  assert.deepEqual(detectServiceKind("jupyter-lab --port 8888", "python"), { id: "jupyter", label: "Jupyter" });
  assert.deepEqual(detectServiceKind("tensorboard --logdir runs", "tensorboard"), { id: "tensorboard", label: "TensorBoard" });
  assert.deepEqual(detectServiceKind("python -m vllm.entrypoints.openai.api_server", "python"), { id: "llm-server", label: "LLM 推理服务" });
  assert.equal(detectServiceKind("python train.py", "python"), null);
  assert.equal("target" in serviceView(report), false, "转发目标不出接口");
  assert.equal(MIN_SERVICE_PORT, 1024);
});

test("服务列表：同一端口的多个监听合并成一条；多个进程取运行最久的；只绑在具体地址上的不能转发", () => {
  const parsed = parseServiceOutput(remoteOutput({
    lines: [
      'LISTEN 0 128 0.0.0.0:9000 0.0.0.0:* users:(("gunicorn",pid=501,fd=5),("gunicorn",pid=502,fd=5))',
      'LISTEN 0 128 [::]:9000 [::]:* users:(("gunicorn",pid=500,fd=6))',
      'LISTEN 0 128 [::1]:5173 [::]:* users:(("node",pid=600,fd=20))',
      'LISTEN 0 128 10.1.2.3:7000 0.0.0.0:* users:(("java",pid=700,fd=9))',
      'LISTEN 0 128 127.0.0.1:7000 0.0.0.0:* users:(("java",pid=700,fd=10))',
      'LISTEN 0 128 10.1.2.3:7100 0.0.0.0:* users:(("java",pid=701,fd=9))',
    ],
    procs: [[500, "/srv/app", "gunicorn: master [app]"], [501, "/srv/app", "gunicorn: worker [app]"]],
    ages: [[500, 9000], [501, 30], [502, 30]],
  }));
  const byPort = new Map(buildServices(parsed).services.map((s) => [s.port, s]));
  const web = byPort.get(9000);
  assert.deepEqual([web.pid, web.procCount, web.binds, web.scope, web.target, web.cmdline, web.uptimeSec], [500, 3, ["0.0.0.0", "::"], "all", "127.0.0.1", "gunicorn: master [app]", 9000]);
  assert.deepEqual([byPort.get(5173).scope, byPort.get(5173).target], ["loopback", "[::1]"], "只绑 ::1 的服务从 [::1] 转发");
  assert.deepEqual([byPort.get(7000).scope, byPort.get(7000).target], ["address", "127.0.0.1"], "同时绑了回环就能转发");
  assert.deepEqual([byPort.get(7100).scope, byPort.get(7100).target, serviceView(byPort.get(7100)).forwardable], ["address", null, false]);
});

test("服务列表：只认属于本人的进程——没有 proc 记录的进程不算数，整条监听都没有本人进程的不列", () => {
  const lines = [
    'LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("python",pid=10,fd=3))',
    'LISTEN 0 5 127.0.0.1:8900 0.0.0.0:* users:(("postgres",pid=20,fd=3))',
    'LISTEN 0 5 0.0.0.0:9000 0.0.0.0:* users:(("nginx",pid=30,fd=6),("nginx",pid=31,fd=6))',
    'LISTEN 0 5 127.0.0.1:9100 0.0.0.0:* users:(("mine",pid=40,fd=3))',
    'LISTEN 0 5 0.0.0.0:9100 0.0.0.0:* users:(("theirs",pid=41,fd=3))',
  ];
  // 以 root 运行时 ss 会把别人的进程也给出来：远端只给属主是当前账号的 10 / 31 / 40 出 proc 记录。
  const result = buildServices(parseServiceOutput(remoteOutput({ lines, own: [10, 31, 40], ages: [[30, 9999], [31, 5]] })));
  assert.deepEqual(result.services.map((s) => [s.port, s.name, s.pid, s.procCount, s.binds, s.scope]), [
    [8814, "python", 10, 1, ["127.0.0.1"], "loopback"],
    [9000, "nginx", 31, 1, ["0.0.0.0"], "all"],
    [9100, "mine", 40, 1, ["127.0.0.1"], "loopback"],
  ], "别人的进程不参与：不算个数、不当主进程、它的监听地址也不并进来");
  assert.deepEqual([...result.ports], [8814, 9000, 9100]);
  assert.deepEqual(buildServices(parseServiceOutput(remoteOutput({ lines, own: [] }))).services, [], "一个本人的进程都没有 → 空列表");
});

test(`服务列表：最多 ${SERVICE_LIMIT} 个，其余计数；ports 不受条数上限影响`, () => {
  const lines = Array.from({ length: 30 }, (_v, i) => `LISTEN 0 5 127.0.0.1:${9000 + i} 0.0.0.0:* users:(("python",pid=${4000 + i},fd=3))`).reverse();
  const result = buildServices(parseServiceOutput(remoteOutput({ lines })));
  assert.equal(result.services.length, SERVICE_LIMIT);
  assert.deepEqual([result.services[0].port, result.services.at(-1).port, result.more, result.ports.size], [9000, 9023, 6, 30]);
});

test("列表状态：只有 ok 才算列全了；trunc 可以用但不能据此说「没有了」；没有 ss / 没跑成 / 没给状态行 → 不认", () => {
  const trunc = buildServices(parseServiceOutput(remoteOutput({ state: "trunc" })), { excludePorts: DAEMON_PORTS });
  assert.deepEqual([trunc.state, trunc.complete, trunc.services.length > 0], ["trunc", false, true]);
  for (const [state, expected] of [["unavailable", "unavailable"], ["failed", "failed"], [null, "unknown"], ["bogus", "unknown"]]) {
    const result = buildServices(parseServiceOutput(remoteOutput({ state })));
    assert.deepEqual([result.state, result.complete, result.services, result.ports.size], [expected, false, [], 0], String(state));
  }
  assert.deepEqual(buildServices(null).state, "unknown");
});

test("远端输出当不可信数据：控制字符、超长字段、坏 pid、重复记录、注入形状都不会带进结果", () => {
  const long = "x".repeat(500);
  const parsed = parseServiceOutput([
    `ss=LISTEN 0 5 127.0.0.1:8814 0.0.0.0:* users:(("py\u0007thon${long}",pid=5,fd=3))`,
    `proc=5\t/home/u/${long}\tpython ${long}`,
    "proc=5\t/second\tsecond",
    "proc=abc\t/x\tx",
    "proc=0\t/x\tx",
    "age=5 12\u0000",
    "age=5 99",
    "age=6 -1",
    "age=7 1e9",
    "svc.home=relative/path",
    "svc.home=/home/u/",
    "svc.home=/other",
    "svc.state=ok",
    "svc.state=failed",
    "end=1",
    "random noise",
  ].join("\r\n"));
  assert.equal(parsed.state, "ok", "同一项只取第一次出现");
  assert.equal(parsed.home, "/home/u");
  assert.deepEqual([...parsed.ages], [[5, 99]], "带控制字符的那行不合格，取后面合格的");
  const [svc] = buildServices(parsed).services;
  assert.equal(svc.name.length, 32);
  assert.equal([...svc.name].some((ch) => ch.charCodeAt(0) < 32), false, "控制字符换成了空格");
  assert.equal(svc.cmdline.length, 160);
  assert.ok(svc.cwd.startsWith("~/") && svc.cwd.length <= 200);
  assert.equal(parsed.procs.size, 1);
  // 行数与条数都有上限。
  const flood = parseServiceOutput(Array.from({ length: 2000 }, (_v, i) => `ss=LISTEN 0 5 127.0.0.1:${2000 + i} 0.0.0.0:* users:(("p",pid=${i + 2},fd=3))`).join("\n"));
  assert.equal(flood.listeners.length, 64);
  assert.equal(parseServiceOutput(Array.from({ length: 300 }, (_v, i) => `proc=${i + 2}\t/x\tx`).join("\n")).procs.size, 48);
});

test("命令行脱敏：名字里带 token / secret / password / api-key 的参数值盖掉，其余原样", () => {
  assert.equal(redactCommandLine("python -m http.server 8814 --bind 127.0.0.1"), "python -m http.server 8814 --bind 127.0.0.1");
  assert.equal(redactCommandLine("jupyter-lab --NotebookApp.token=abc123 --port 8888"), "jupyter-lab --NotebookApp.token=[已隐藏] --port 8888");
  assert.equal(redactCommandLine("serve --password hunter2 --port 9000"), "serve --password [已隐藏] --port 9000");
  assert.equal(redactCommandLine("serve --api-key=k1 --secret-key k2 --access-token k3"), "serve --api-key=[已隐藏] --secret-key [已隐藏] --access-token [已隐藏]");
  assert.equal(redactCommandLine("serve --password --verbose"), "serve --password --verbose", "后面跟的是另一个参数，不是值");
  assert.equal(redactCommandLine("python my-tokenizer.py corpus.txt"), "python my-tokenizer.py corpus.txt", "文件名不算参数");
  assert.equal(redactCommandLine("curl -H 'Authorization: Bearer abcdefgh' http://u:pw@127.0.0.1:8000/"), "curl -H 'Authorization: Bearer [已隐藏]' http://[已隐藏]@127.0.0.1:8000/");
  assert.equal(redactCommandLine("a\tb\nc   d"), "a b c d");
});

// 本机真跑一遍状态脚本：ss / ps 用 shell 函数顶替（不新写可执行文件——macOS 对新写出的可执行文件第一次执行
// 要做安全评估，机器忙的时候能卡上几十秒），/proc 指到临时目录里的假进程目录。readlink / head / tr / cut /
// awk / sort 都是系统自带的真家伙。
test("远端片段在 bash 下可执行：只送回本人的监听，逐个进程带上工作目录、命令行与运行时长", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "daemons-svc-"));
  try {
    const home = path.join(root, "home");
    const proc = path.join(root, "proc");
    const reportDir = path.join(home, "outputs", "报告 目录");
    mkdirSync(reportDir, { recursive: true });
    // 假 /proc：这些进程目录存在（属主是跑测试的账号）；reclaude 的 900001 与 sshd 的 800001 故意不建——
    // 对脚本来说就是「不属于本人」（真实环境里 sshd 的会话进程属主是 root）。
    for (const pid of [211354, 3301234, 3301240, 2200001, 2200002, 1500001, 1500002]) mkdirSync(path.join(proc, String(pid)), { recursive: true });
    writeFileSync(path.join(proc, "3301234", "cmdline"), "python\0-m\0http.server\x008814\0--bind\x00127.0.0.1\0");
    symlinkSync(reportDir, path.join(proc, "3301234", "cwd"));
    writeFileSync(path.join(proc, "211354", "cmdline"), `node\0/opt/paseo/daemon.js\0--token=abc123\0${"y".repeat(400)}\0`);
    symlinkSync(home, path.join(proc, "211354", "cwd"));
    writeFileSync(path.join(root, "ss.txt"), `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n${SS_LINES.join("\n")}\n`);
    writeFileSync(path.join(root, "ps.txt"), " 211354   86400\n3301234   11520\n2200001  190000\n  noise\n");
    const shim = `ss() { cat "${root}/ss.txt"; }\nps() { cat "${root}/ps.txt"; }\ntimeout() { shift; "$@"; }\n`;
    assert.ok(DAEMON_STATUS_SCRIPT.includes("svc_proc=/proc"));
    const script = shim + DAEMON_STATUS_SCRIPT.replace("svc_proc=/proc", `svc_proc='${proc}'`);
    const run = spawnSync("bash", ["-s"], { input: script, env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 60000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(parseDaemonOutput(run.stdout).complete, true, "服务这一段排在 end=1 之前，不影响原有的完整性判断");
    const lines = run.stdout.split("\n");
    assert.equal(lines.filter((line) => line.startsWith("ss=")).length, 10, "13 行里只有 10 行带 pid=");
    assert.ok(lines.every((line) => !line.includes(":22 ")), "别人的监听不送回来");
    assert.ok(lines.indexOf("svc.state=ok") === lines.indexOf("end=1") - 1, "状态行最后才输出");
    const parsed = parseServiceOutput(run.stdout);
    assert.equal(parsed.home, home);
    const result = buildServices(parsed, { excludePorts: DAEMON_PORTS });
    assert.deepEqual(result.services.map((s) => s.port), [3774, 8765, 8780, 8814, 8815], "40161 的进程不属于本人，不列");
    assert.deepEqual([...parsed.procs.keys()].sort((a, b) => a - b), [211354, 1500001, 1500002, 2200001, 2200002, 3301234, 3301240], "只有属主是本人的进程才有 proc 记录");
    const report = result.services.find((s) => s.port === 8814);
    assert.deepEqual([report.cmdline, report.cwd, report.uptimeSec], ["python -m http.server 8814 --bind 127.0.0.1", "~/outputs/报告 目录", 11520]);
    assert.equal(result.services.find((s) => s.port === 8765).uptimeSec, 190000);
    const paseo = parsed.procs.get(211354);
    assert.equal(paseo.cwd, home);
    // 远端截到 160 字符（abc123 占 6 个），本机把值换成 5 个字符的「[已隐藏]」：剩 159。
    assert.ok(paseo.cmdline.startsWith("node /opt/paseo/daemon.js --token=[已隐藏] yyy"), paseo.cmdline);
    assert.equal(paseo.cmdline.length, 159, "命令行远端截到 160 字符，本机再脱敏");

    // 没有 ss：如实报 unavailable，其余输出照常完整。
    const none = spawnSync("bash", ["-s"], {
      input: `command() { if [ "$2" = ss ]; then return 1; fi; builtin command "$@"; }\n${DAEMON_STATUS_SCRIPT}`,
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(parseDaemonOutput(none.stdout).complete, true, none.stderr);
    assert.equal(parseServiceOutput(none.stdout).state, "unavailable");
    // ss 跑不成：failed。
    const broken = spawnSync("bash", ["-s"], {
      input: `ss() { return 2; }\ntimeout() { shift; "$@"; }\n${DAEMON_STATUS_SCRIPT}`,
      env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 60000,
    });
    assert.equal(parseServiceOutput(broken.stdout).state, "failed");
    assert.equal(parseDaemonOutput(broken.stdout).complete, true, broken.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("远端片段在 bash 下：超过 64 行或 48 个进程如实报 trunc，只送回前面的", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "daemons-svc-many-"));
  try {
    const runWith = (count) => {
      const many = Array.from({ length: count }, (_v, i) => `LISTEN 0 5 127.0.0.1:${9000 + i} 0.0.0.0:* users:(("python",pid=${4000 + i},fd=3))`).join("\n");
      for (let i = 0; i < count; i += 1) mkdirSync(path.join(root, "proc", String(4000 + i)), { recursive: true });
      writeFileSync(path.join(root, "ss.txt"), `${many}\n`);
      const shim = `ss() { cat "${root}/ss.txt"; }\nps() { return 1; }\ntimeout() { shift; "$@"; }\n`;
      const run = spawnSync("bash", ["-s"], {
        input: shim + DAEMON_STATUS_SCRIPT.replace("svc_proc=/proc", `svc_proc='${root}/proc'`),
        env: { HOME: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, encoding: "utf8", timeout: 60000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(parseDaemonOutput(run.stdout).complete, true, `${count} 个监听时 end=1 仍在行数上限之内`);
      return parseServiceOutput(run.stdout);
    };
    const parsed = runWith(70);
    assert.deepEqual([parsed.state, parsed.listeners.length, parsed.procs.size, parsed.ages.size], ["trunc", 64, 48, 0]);
    const result = buildServices(parsed);
    assert.deepEqual([result.complete, result.services.length, result.more], [false, SERVICE_LIMIT, 24], "只有拿到 proc 记录的 48 个算数");
    // 行数没超、进程数超了：同样不算列全（排在 48 个之后的进程没被核过属主）。
    const manyProcs = runWith(50);
    assert.deepEqual([manyProcs.state, manyProcs.listeners.length, manyProcs.procs.size], ["trunc", 50, 48]);
    const exact = runWith(48);
    assert.deepEqual([exact.state, exact.listeners.length, exact.procs.size], ["ok", 48, 48], "正好 48 个算列全了");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
