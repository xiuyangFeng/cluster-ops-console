// 同账号多台 Mac 接力的远端脚本（v2.88）：纯函数 + 用真 sh、假 ps / curl 实跑。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildSiblingSurveyCommand,
  buildSiblingTakeoverCommand,
  describeHolder,
  parseEtime,
  parseSiblingSurvey,
  parseSiblingTakeover,
  SIBLING_YIELD_TOKEN,
  sanitizeMachineLabel,
} from "./sibling-tunnel.mjs";
import { buildTunnelHoldCommand, buildTunnelMarker } from "./tunnel-spec.mjs";

const ME = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const MARKER = buildTunnelMarker(ME, 7893);
const posixOnly = { skip: process.platform === "win32" };

const innerOf = (command) => {
  assert.ok(command.startsWith("sh -c '") && command.endsWith("'"));
  return command.slice("sh -c '".length, -1);
};

test("机器名：只留安全字符、去 .local、空格换 -、最长 40；清洗后为空回落 Mac", () => {
  assert.equal(sanitizeMachineLabel("MacBook-Air.local"), "MacBook-Air");
  assert.equal(sanitizeMachineLabel("Xiu's Mac mini"), "Xius-Mac-mini");
  assert.equal(sanitizeMachineLabel("$(rm -rf ~)"), "rm--rf-");
  assert.equal(sanitizeMachineLabel("中文名"), "Mac");
  assert.equal(sanitizeMachineLabel("a".repeat(80)).length, 40);
});

test("远端脚本：不含单引号与 !（外层 sh -c 包裹、csh 不做历史替换），不含完整标记前缀（不会匹配到自己）", () => {
  for (const command of [buildSiblingSurveyCommand({ marker: MARKER, label: "MacBook-Air" }), buildSiblingTakeoverCommand({ marker: MARKER, label: "x" })]) {
    const inner = innerOf(command);
    assert.ok(!inner.includes("'"));
    assert.ok(!inner.includes("!"));
    assert.ok(!command.includes("codex-tunnel:"), "命令行里出现完整前缀就会把脚本自己当成隧道会话");
  }
  assert.throws(() => buildSiblingSurveyCommand({ marker: "codex-tunnel:$(id):7893", label: "x" }), /unsafe tunnel marker/);
  assert.throws(() => buildSiblingTakeoverCommand({ marker: "codex-tunnel:0123456789abcdef:99999", label: "x" }), /unsafe tunnel marker/);
});

test("解析：没有 END 视为没查成；没有另一台 Mac 时 health 一律 none；etime 各种写法", () => {
  assert.equal(parseSiblingSurvey("SIB 1 fedcba9876543210 01:02 Mac\nHEALTH=ok\n"), null);
  assert.deepEqual(parseSiblingSurvey("HEALTH=none\nEND\n"), { siblings: [], health: "none" });
  const parsed = parseSiblingSurvey(`SIB 201 ${OTHER} 2-03:04:05 Mac-mini\nHEALTH=dead\nEND\n`);
  assert.deepEqual(parsed, { siblings: [{ pid: 201, ownerId: OTHER, heldSec: 2 * 86400 + 3 * 3600 + 4 * 60 + 5, label: "Mac-mini" }], health: "dead" });
  assert.deepEqual(describeHolder(parsed.siblings), { ownerId: OTHER, label: "Mac-mini", heldSec: parsed.siblings[0].heldSec });
  assert.equal(parseEtime("05:09"), 309);
  assert.equal(parseEtime("1:00:00"), 3600);
  assert.equal(parseEtime("garbage"), null);
  assert.deepEqual(parseSiblingTakeover("TAKEOVER found=1 ended=1\n"), { found: 1, ended: 1 });
  assert.equal(parseSiblingTakeover(""), null);
});

// 假进程表：100/101 = 本机自己的会话；200/201 = 另一台 Mac（同端口）；300/301 = 另一台 Mac 但别的端口；
// 400/401 = 别的用户程序；500 = 回收脚本这类命令行里只有拆开写的前缀。
function makeFakeBin(dir, { curlCode = "200", curlMissing = false } = {}) {
  const table = [
    ["100", "1", "10:00", "sshd: kai@notty"],
    ["101", "100", "10:00", `sh -c while kill -0 "$PPID" 2>/dev/null; do sleep 30 & wait; done ${MARKER}`],
    ["200", "1", "03:00:00", "sshd: kai@notty"],
    ["201", "200", "03:00:00", `sh -c while kill -0 "$PPID" 2>/dev/null; do sleep 30; done codex-tunnel:${OTHER}:7893`],
    ["300", "1", "05:00", "sshd: kai@notty"],
    ["301", "300", "05:00", "sh -c while true; do sleep 30; done codex-tunnel:aaaaaaaaaaaaaaaa:17893"],
    ["401", "1", "01:00", "python train.py --tag codex-tunnel"],
    ["500", "1", "00:01", 'sh -c pre="codex-tunne""l:"; port=7893'],
  ];
  const ps = [
    "#!/bin/sh",
    `table='${table.map((row) => row.join("\t")).join("\n")}'`,
    "for a in \"$@\"; do p=\"$a\"; done",
    "case \"$*\" in",
    "  *\"-o pid=,etime=,args=\"*) printf \"%s\\n\" \"$table\" | while IFS=\"$(printf \"\\t\")\" read -r pid ppid et args; do echo \" $pid $et $args\"; done ;;",
    "  *\"-o ppid= -p \"*) printf \"%s\\n\" \"$table\" | while IFS=\"$(printf \"\\t\")\" read -r pid ppid et args; do [ \"$pid\" = \"$p\" ] && echo \" $ppid\"; done ;;",
    "  *\"-o args= -p \"*) printf \"%s\\n\" \"$table\" | while IFS=\"$(printf \"\\t\")\" read -r pid ppid et args; do [ \"$pid\" = \"$p\" ] && echo \"$args\"; done ;;",
    "esac",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "ps"), `${ps}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "id"), "#!/bin/sh\necho 1006\n", { mode: 0o755 });
  if (!curlMissing) fs.writeFileSync(path.join(dir, "curl"), `#!/bin/sh\necho "$*" >> "${dir}/curl.args"\nprintf "%s" "${curlCode}"\n`, { mode: 0o755 });
}

function runScript(command, dir, { pathOnly = false } = {}) {
  const killsFile = path.join(dir, "kills");
  // kill / sleep 是内建或会拖慢：函数替身只记录目标。kill -0 一律当作还活着。
  const prelude = `kill() { echo "$*" >> "${killsFile}"; return 0; }; sleep() { :; };`;
  // pathOnly：PATH 只有假命令目录（用例自己把需要的基础工具软链进去），确保真的找不到 curl。
  // 不能再带 /bin：Ubuntu 等 usrmerge 发行版的 /bin 就是 /usr/bin，里面有真 curl（只在 Linux CI 上失败）。
  const basePath = pathOnly ? dir : `${dir}:${process.env.PATH}`;
  const out = execFileSync("/bin/sh", ["-c", `${prelude} ${innerOf(command)}`], {
    encoding: "utf8",
    env: { PATH: basePath, HOME: dir },
  });
  const kills = fs.existsSync(killsFile) ? fs.readFileSync(killsFile, "utf8").trim().split("\n").filter(Boolean) : [];
  return { out, kills };
}

test("查看脚本真跑：只认同端口、识别码不同的本账号会话；写下本机机器名；经端口打 /proxy-health", posixOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
  try {
    makeFakeBin(dir);
    fs.mkdirSync(path.join(dir, ".cache/cluster-workbench/tunnel-macs"), { recursive: true });
    fs.writeFileSync(path.join(dir, `.cache/cluster-workbench/tunnel-macs/${OTHER}`), "Mac-mini;rm\n");
    const { out, kills } = runScript(buildSiblingSurveyCommand({ marker: MARKER, label: "MacBook Air" }), dir);
    const parsed = parseSiblingSurvey(out);
    assert.deepEqual(parsed.siblings, [{ pid: 201, ownerId: OTHER, heldSec: 3 * 3600, label: "Mac-minirm" }]);
    assert.equal(parsed.health, "ok");
    assert.deepEqual(kills, [], "查看不发任何信号");
    assert.equal(fs.readFileSync(path.join(dir, `.cache/cluster-workbench/tunnel-macs/${ME}`), "utf8"), "MacBook-Air\n");
    const curlArgs = fs.readFileSync(path.join(dir, "curl.args"), "utf8");
    assert.match(curlArgs, /--noproxy \* --max-time 4 http:\/\/127\.0\.0\.1:7893\/proxy-health/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("查看脚本真跑：打不通（000）→ dead；集群没有 curl → unknown", posixOnly, () => {
  const dead = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
  const nocurl = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
  try {
    makeFakeBin(dead, { curlCode: "000" });
    assert.equal(parseSiblingSurvey(runScript(buildSiblingSurveyCommand({ marker: MARKER, label: "x" }), dead).out).health, "dead");
    makeFakeBin(nocurl, { curlMissing: true });
    for (const tool of ["tr", "head", "cut", "mkdir", "cat"]) {
      const real = ["/usr/bin", "/bin"].map((d) => path.join(d, tool)).find((p) => fs.existsSync(p));
      if (real) fs.symlinkSync(real, path.join(nocurl, tool));
    }
    assert.equal(parseSiblingSurvey(runScript(buildSiblingSurveyCommand({ marker: MARKER, label: "x" }), nocurl, { pathOnly: true }).out).health, "unknown");
  } finally {
    fs.rmSync(dead, { recursive: true, force: true });
    fs.rmSync(nocurl, { recursive: true, force: true });
  }
});

test("接管脚本真跑：先给对方等待进程发 USR1（让位通知），再结束它还在的 sshd；本机与别的端口的会话不碰", posixOnly, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sibling-"));
  try {
    makeFakeBin(dir);
    const { out, kills } = runScript(buildSiblingTakeoverCommand({ marker: MARKER, label: "x" }), dir);
    assert.deepEqual(parseSiblingTakeover(out), { found: 1, ended: 1 });
    assert.deepEqual(kills, ["-USR1 201", "-0 200", "200"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("等待进程真跑：收到 USR1 立刻写一行让位通知并以 0 退出（不用等满 30 秒的 sleep）", posixOnly, async () => {
  const hold = buildTunnelHoldCommand(MARKER);
  assert.ok(hold.includes(`echo ${SIBLING_YIELD_TOKEN};`), "让位通知字面量与 SIBLING_YIELD_TOKEN 一致");
  // 取出单引号里的脚本，在本机 sh 里起一个等价的等待进程（$0 = 标记；父进程就是这个测试，kill -0 $PPID 一直成立）。
  const script = hold.slice(hold.indexOf("'") + 1, hold.lastIndexOf("'"));
  const child = spawn("/bin/sh", ["-c", script, MARKER], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  // 等 sh 装好 trap、进入 wait。
  await new Promise((resolve) => setTimeout(resolve, 400));
  const startedAt = Date.now();
  child.kill("SIGUSR1");
  const result = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000))]);
  if (result.timeout) child.kill("SIGKILL");
  assert.equal(result.code, 0);
  assert.ok(!result.timeout, "收到 USR1 后应在几秒内退出");
  assert.ok(Date.now() - startedAt < 5000);
  assert.match(stdout, new RegExp(`^${SIBLING_YIELD_TOKEN}$`, "m"));
});
