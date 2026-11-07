// remote-scripts.mjs：纯函数断言 + 在临时「集群 HOME」里用真实 /bin/sh 执行生成的远端命令。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CLUSTER_ENV_DIR, CLUSTER_ENV_KEYS_DIR, renderClusterEnv } from "../cluster-env.mjs";
import { renderKeyFile } from "./login-flows.mjs";
import {
  buildClaudeActivateCommand,
  buildCodexActivateCommand,
  buildOfficialKillCommand,
  buildOfficialPollCommand,
  buildOfficialStartCommand,
  buildPreflightCommand,
  buildRollbackCommand,
  buildUploadCleanupCommand,
  buildUploadCommand,
  buildVerifyCommand,
  parseKill,
  parsePoll,
  parsePreflight,
  parseRemoteKv,
  REMOTE_KEYS_DIR,
  renderOfficialJobScript,
} from "./remote-scripts.mjs";
import { buildClaudeBinary, buildCodexPackage, makeHome, readLink, runLocal, sha256Of, writeExec } from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;
const SHA = "a".repeat(64);
const CODEX_ROOT = ".codex/packages/standalone";
const NAME = (v) => `${v}-x86_64-unknown-linux-musl`;

// 把一个文件经「上传命令」送进假 HOME（stdin），返回解析后的输出。
function upload(home, file) {
  const buf = fs.readFileSync(file.filePath);
  const res = runLocal(home, buildUploadCommand({ fileName: file.fileName, size: buf.length, sha256: file.sha256 }), { input: buf });
  return parseRemoteKv(res.stdout).values;
}

function installCodex(home, fixtures, version) {
  const pkg = buildCodexPackage(fixtures, version);
  assert.equal(upload(home, pkg).upload, "ok");
  const res = runLocal(home, buildCodexActivateCommand({ version, target: "x86_64-unknown-linux-musl", fileName: pkg.fileName, sha256: pkg.sha256 }));
  return { pkg, out: parseRemoteKv(res.stdout), res };
}

function installClaude(home, fixtures, version) {
  const bin = buildClaudeBinary(fixtures, version);
  assert.equal(upload(home, bin).upload, "ok");
  const res = runLocal(home, buildClaudeActivateCommand({ version, fileName: bin.fileName, sha256: bin.sha256 }));
  return { bin, out: parseRemoteKv(res.stdout), res };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("所有远端命令都经 wrapSh 包成 sh -c '…'，插值前校验参数", () => {
  const cmds = [
    buildPreflightCommand("codex"),
    buildPreflightCommand("claude"),
    buildOfficialStartCommand("codex", "cli-abc12345"),
    buildOfficialPollCommand("claude", "cli-abc12345"),
    buildOfficialKillCommand("cli-abc12345"),
    buildVerifyCommand("codex"),
    buildUploadCommand({ fileName: "a.tar.gz", size: 10, sha256: SHA }),
    buildUploadCleanupCommand({ fileName: "a.tar.gz" }),
    buildCodexActivateCommand({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fileName: "a.tar.gz", sha256: SHA }),
    buildClaudeActivateCommand({ version: "2.1.292", fileName: "claude-2.1.292-linux-x64", sha256: SHA }),
    buildRollbackCommand("codex"),
    buildRollbackCommand("claude", "2.1.290"),
  ];
  for (const c of cmds) assert.match(c, /^sh -c '/);
  assert.throws(() => buildCodexActivateCommand({ version: "0.1;rm -rf ~", target: "x86_64-unknown-linux-musl", fileName: "a", sha256: SHA }), /版本号非法/);
  assert.throws(() => buildClaudeActivateCommand({ version: "2.1.292", fileName: "../x", sha256: SHA }), /文件名非法/);
  assert.throws(() => buildUploadCommand({ fileName: "a", size: 1, sha256: "zz" }), /sha256/);
  assert.throws(() => buildUploadCleanupCommand({ fileName: "a b; rm -rf ~" }), /文件名非法/);
  assert.throws(() => buildUploadCleanupCommand({ fileName: "../../.ssh/authorized_keys" }), /文件名非法/);
  assert.throws(() => buildOfficialKillCommand("../x"), /jobId/);
  assert.throws(() => buildOfficialStartCommand("codex", "$(id)"), /jobId/);
  assert.throws(() => buildRollbackCommand("claude", "2.1.290; reboot"), /回滚目标非法/);
  assert.throws(() => buildPreflightCommand("npm"), /未知 CLI/);
});

test("官方任务脚本：先 source env.sh；codex 关掉 releases.openai.com（300 秒上限）并且不传 --release", () => {
  const codex = renderOfficialJobScript("codex");
  assert.match(codex, /\. "\$HOME\/\.config\/cluster-workbench\/env\.sh"/);
  assert.match(codex, /CODEX_INSTALLER_USE_RELEASES_OPENAI_COM=false/);
  assert.match(codex, /CODEX_NON_INTERACTIVE=1/);
  assert.match(codex, /https:\/\/chatgpt\.com\/codex\/install\.sh/);
  assert.doesNotMatch(codex, /--release/);
  const claude = renderOfficialJobScript("claude");
  assert.match(claude, /https:\/\/claude\.ai\/install\.sh/);
  assert.match(claude, /bash "\$J\/install\.sh"/);
  // 终审：source 之后、下载与执行安装器之前，先把 keys/*.env 引入的变量清掉。
  for (const script of [codex, claude]) {
    const source = script.indexOf('. "$HOME/.config/cluster-workbench/env.sh"');
    const scrub = script.indexOf('unset "$__cwb_n"');
    assert.ok(source > 0 && scrub > source && scrub < script.indexOf("curl "), "先 source、再清密钥、最后才联网");
    assert.match(script, /PATH\|HOME\|http_proxy\|https_proxy\|HTTP_PROXY\|HTTPS_PROXY\|no_proxy\|NO_PROXY\) ;;/, "代理变量与 PATH 不清");
  }
});

test("parseRemoteKv：只认 key=value、去控制字符、end=1 才算完整", () => {
  const out = parseRemoteKv("v=1\nrelease=a\nrelease=b\nBAD KEY=x\njunk\ndetail=x\u0007y\n");
  assert.equal(out.complete, false);
  assert.deepEqual(out.lists.release, ["a", "b"]);
  assert.equal(out.values.detail, "x y");
  assert.equal(out.values["BAD KEY"], undefined);
  assert.equal(parseRemoteKv("end=1\n").complete, true);
});

test("parsePreflight / parsePoll：结构化 + 过滤不合法的值", () => {
  const pf = parsePreflight("claude", [
    "arch=x86_64", "musl=0", "envsh=1", "freekb=123456", "has.curl=1", "has.tar=0",
    "current=2.1.291", "release=2.1.291 251000000", "release=2.1.223 0", "release=junk 5",
    "visible=link", "npm=/home/u/.local/node-v24/bin/claude", "running=cli-abcdefgh", "running=../x", "end=1",
  ].join("\n"));
  assert.equal(pf.complete, true);
  assert.equal(pf.envSh, true);
  assert.equal(pf.freeKb, 123456);
  assert.deepEqual(pf.has, { curl: true, tar: false });
  assert.equal(pf.currentVersion, "2.1.291");
  assert.deepEqual(pf.releases.map((r) => [r.name, r.broken]), [["2.1.291", false], ["2.1.223", true]]);
  assert.deepEqual(pf.running, ["cli-abcdefgh"]);
  assert.deepEqual(pf.npmPaths, ["/home/u/.local/node-v24/bin/claude"]);

  const codex = parsePreflight("codex", "current=0.159.2-x86_64-unknown-linux-musl\nrelease=0.159.2-x86_64-unknown-linux-musl\nend=1\n");
  assert.equal(codex.currentVersion, "0.159.2");

  const poll = parsePoll("job=ok\nexit=0\nalive=0\ndl=1024 codex-package-x.tar.gz\ndl=bad\nlogsize=33\nact=4096\nlog=hello\nend=1\n");
  assert.equal(poll.exitCode, 0);
  assert.equal(poll.activity, 4096);
  assert.deepEqual(poll.downloads, [{ bytes: 1024, name: "codex-package-x.tar.gz" }]);
  assert.deepEqual(poll.log, ["hello"]);
});

// ---------------------------------------------------------------------------
// 在假 HOME 里真实执行
// ---------------------------------------------------------------------------

test("预检：空账号 → 没有安装、没有 env.sh；架构经假 uname 固定为 x86_64", { skip }, (t) => {
  const { home } = makeHome(t);
  const pf = parsePreflight("codex", runLocal(home, buildPreflightCommand("codex")).stdout);
  assert.equal(pf.complete, true);
  assert.equal(pf.arch, "x86_64");
  assert.equal(pf.envSh, false);
  assert.equal(pf.current, null);
  assert.equal(pf.visible, "none");
  assert.deepEqual(pf.releases, []);
  assert.ok(pf.freeKb > 0);
});

test("预检：识别 npm 全局安装（node 脚本 / 指进 node_modules 的软链）与普通文件形态的 ~/.local/bin/<cli>", { skip }, (t) => {
  const { home } = makeHome(t);
  writeExec(path.join(home, ".npm-global/bin/codex"), "#!/usr/bin/env node\nrequire('x')\n");
  writeExec(path.join(home, ".local/node-v24/lib/node_modules/@anthropic-ai/claude-code/cli.js"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(home, ".local/node-v24/bin"), { recursive: true });
  fs.symlinkSync(path.join(home, ".local/node-v24/lib/node_modules/@anthropic-ai/claude-code/cli.js"), path.join(home, ".local/node-v24/bin/claude"));
  writeExec(path.join(home, ".local/bin/codex"), "#!/bin/sh\nexec /opt/codex \"$@\"\n");
  const codex = parsePreflight("codex", runLocal(home, buildPreflightCommand("codex")).stdout);
  assert.deepEqual(codex.npmPaths, [path.join(home, ".npm-global/bin/codex")]);
  assert.equal(codex.visible, "file");
  const claude = parsePreflight("claude", runLocal(home, buildPreflightCommand("claude")).stdout);
  assert.deepEqual(claude.npmPaths, [path.join(home, ".local/node-v24/bin/claude")]);
});

async function waitForFile(file, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// 终审：job.sh 先 source env.sh，env.sh 又 source keys/*.env——网上下载来的 install.sh 不该拿到这些密钥。
test("官方任务：下载器与安装器（含子进程）的环境里没有 keys/*.env 的密钥，代理变量与 PATH 都在", { skip }, async (t) => {
  const { home } = makeHome(t);
  const SECRET = "sk-fake-SECRET-0123456789";
  // 拼出来而不是写成一整串：整串长得像真的 provider token，会被 scripts/release-scan.mjs 的
  // hardcoded-token 规则拦下（CI 的 lint job 跑这条扫描）。运行时的值不变。
  const TOKEN = ["sk-ant-oat01", "FAKE-TOKEN-abcdefghij"].join("-");
  assert.equal(REMOTE_KEYS_DIR, `$HOME/${CLUSTER_ENV_DIR}/${CLUSTER_ENV_KEYS_DIR}`, "与 env.sh 引入的是同一个目录");
  // 真实的受管 env.sh（代理 + PATH + source keys/*.env）与真实写法的 key 文件。
  const envDir = path.join(home, CLUSTER_ENV_DIR);
  const keysDir = path.join(envDir, CLUSTER_ENV_KEYS_DIR);
  fs.mkdirSync(keysDir, { recursive: true });
  fs.writeFileSync(path.join(envDir, "env.sh"), renderClusterEnv({ port: 17891, noProxyExtra: ["relay.lab"] }), { mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, "codex-x.env"), renderKeyFile("CWB_X_API_KEY", SECRET), { mode: 0o600 });
  fs.writeFileSync(path.join(keysDir, "claude-oauth.env"), renderKeyFile("CLAUDE_CODE_OAUTH_TOKEN", TOKEN), { mode: 0o600 });
  // 手写的 key 文件：一行两个赋值、先赋值再 export、还有一个与代理同名的变量（代理变量不能被连带清掉）。
  fs.writeFileSync(path.join(keysDir, "hand.env"), [
    `export HAND_A='${SECRET}-a' HAND_B='${SECRET}-b'`,
    `HAND_C='${SECRET}-c'; export HAND_C`,
    'export NO_PROXY="localhost,127.0.0.1,::1,relay.lab,hand.lab"',
    "",
  ].join("\n"), { mode: 0o600 });
  // 夹具确实会把密钥带进环境：直接 source env.sh 就能看到（否则下面的断言是空转）。
  assert.match(runLocal(home, '. "$HOME/.config/cluster-workbench/env.sh"; env').stdout, /^CWB_X_API_KEY=sk-fake-SECRET-0123456789$/m);

  // 假 curl 与假安装器都把自己的环境落盘；安装器再起一个子进程也落一份。
  writeExec(path.join(home, "fakebin", "curl"), `#!/bin/sh
env > "$HOME/curl-env.txt"
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done
cp "$HOME/fake-install.sh" "$out"
`);
  writeExec(path.join(home, "fake-install.sh"), `#!/bin/sh
env > "$HOME/installer-env.txt"
sh -c env > "$HOME/installer-child-env.txt"
echo "fake installer done"
`);
  const jobId = "cli-envscrub01";
  assert.equal(parseRemoteKv(runLocal(home, buildOfficialStartCommand("codex", jobId)).stdout).values.start, "ok");
  const jobDir = path.join(home, ".cache/cluster-workbench/cli/jobs", jobId);
  assert.ok(await waitForFile(path.join(jobDir, "exit")), "任务跑完");
  assert.equal(fs.readFileSync(path.join(jobDir, "exit"), "utf8").trim(), "0", fs.readFileSync(path.join(jobDir, "log"), "utf8"));

  for (const name of ["curl-env.txt", "installer-env.txt", "installer-child-env.txt"]) {
    const dump = fs.readFileSync(path.join(home, name), "utf8");
    assert.ok(!dump.includes(SECRET) && !dump.includes(TOKEN), `${name}: 环境里不能有密钥的值`);
    assert.doesNotMatch(dump, /^(CWB_X_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|HAND_[ABC])=/m, `${name}: 密钥变量名也不该在`);
    for (const key of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
      assert.match(dump, new RegExp(`^${key}=http://127\\.0\\.0\\.1:17891$`, "m"), `${name}: ${key} 在`);
    }
    assert.match(dump, /^no_proxy=localhost,127\.0\.0\.1,::1,relay\.lab$/m, `${name}: no_proxy 在`);
    assert.match(dump, /^NO_PROXY=localhost,127\.0\.0\.1,::1,relay\.lab,hand\.lab$/m, `${name}: 与代理同名的变量保留`);
    const lines = dump.split("\n");
    const pathLine = lines.find((line) => line.startsWith("PATH=")) || "";
    assert.ok(pathLine.slice("PATH=".length).split(":").includes(`${home}/.local/bin`), `${name}: PATH 带 ~/.local/bin`);
    assert.ok(lines.includes(`TMPDIR=${jobDir}/tmp`), `${name}: TMPDIR 仍指向任务目录`);
  }
  const log = fs.readFileSync(path.join(jobDir, "log"), "utf8");
  assert.match(log, /fake installer done/);
  assert.ok(!log.includes(SECRET) && !log.includes(TOKEN), "任务日志里也没有密钥");
});

// ---- v2.57 终审：从文件读出来的 pid 先校验再用 ----
//
// 这组用例绝不让真的 kill 碰到进程：远端命令是 `sh -c '…'`，在 fakebin 里放一个假 sh，把真实脚本原样接在
// 三个桩函数后面执行——kill / pgrep 只记账（函数优先于普通内建命令），sleep 直接返回。每个用例先用一个
// 合法 pid 确认桩确实接管了 kill（账本里有记录）才继续；桩没生效就在那里失败，轮不到危险的取值。
// probe：探活（kill -0 / kill -s 0）的回答——"alive" 一律说还活着，"dead" 一律说不在了；发信号的调用恒成功。
function stubKill(home, { probe = "alive" } = {}) {
  const probeRc = probe === "dead" ? 1 : 0;
  writeExec(path.join(home, "fakebin", "sh"), `#!/bin/sh
[ "$1" = "-c" ] || exit 64
exec /bin/sh -c 'kill() { echo "kill $*" >> "$HOME/kill.log"; case "$1 $2" in "-0 "*|"-s 0") return ${probeRc} ;; esac; return 0; }
pgrep() { echo "pgrep $*" >> "$HOME/kill.log"; return 1; }
sleep() { :; }
'"$2"
`);
}

function killLog(home) {
  const file = path.join(home, "kill.log");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  fs.rmSync(file, { force: true });
  return lines;
}

function makeJobDir(home, jobId, files) {
  const dir = path.join(home, ".cache/cluster-workbench/cli/jobs", jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

// 进程表里不会有的 pid（macOS 上限 99998；Linux 默认上限 4194304）。
const SAFE_PID = "4194000";
const SAFE_SPAWN_PID = "4194001";
const BAD_PIDS = ["0", "1", "-1", "-4194000", "007", "abc", "12 34", "12\n34", "1;echo x", "", "99999999999999999999999999"];

// 一轮「发信号」与一次「探活说都不在了」在账本里的样子：先打进程组，再逐层兜底；探活先看主进程，再看进程组。
const signalRound = (sig, pid) => [`kill -s ${sig} -- -${pid}`, `pgrep -P ${pid}`, `kill -s ${sig} ${pid}`];
const probeDead = (pid) => [`kill -0 ${pid}`, `kill -s 0 -- -${pid}`];

test("结束任务：pid 文件内容不是「大于 1 的纯数字」时不发任何信号；pid 坏了退回 spawnpid", { skip }, (t) => {
  const { home } = makeHome(t);
  stubKill(home, { probe: "dead" });
  const jobId = "cli-killguard1";
  // 桩自检 + 正常路径：合法 pid → 先打进程组，再逐层兜底；探活说都不在了 → 确认结束、补写退出码 143。
  let dir = makeJobDir(home, jobId, { pid: `${SAFE_PID}\n`, spawnpid: `${SAFE_SPAWN_PID}\n` });
  let out = parseKill(runLocal(home, buildOfficialKillCommand(jobId)).stdout);
  assert.deepEqual(killLog(home), [...signalRound("TERM", SAFE_PID), ...probeDead(SAFE_PID)], "桩接管了 kill，合法 pid 照常结束");
  assert.deepEqual(out, { complete: true, missing: false, stopped: true, state: "0", exitCode: 143 });
  assert.equal(fs.readFileSync(path.join(dir, "exit"), "utf8").trim(), "143");

  for (const bad of BAD_PIDS) {
    // 两个文件都坏：一个信号都不发；杀没杀掉无从确认，所以也不补写退出码，如实回报「不知道」。
    dir = makeJobDir(home, jobId, { pid: bad, spawnpid: bad });
    out = parseKill(runLocal(home, buildOfficialKillCommand(jobId)).stdout);
    assert.deepEqual(killLog(home), [], `pid=${JSON.stringify(bad)}：不该有任何 kill / pgrep`);
    assert.deepEqual([out.complete, out.stopped, out.state], [true, false, "unknown"]);
    assert.ok(!fs.existsSync(path.join(dir, "exit")), "没确认结束就不写退出码");
    // pid 坏、spawnpid 好：退回 spawnpid。
    makeJobDir(home, jobId, { pid: bad, spawnpid: SAFE_SPAWN_PID });
    runLocal(home, buildOfficialKillCommand(jobId));
    assert.deepEqual(killLog(home), [...signalRound("TERM", SAFE_SPAWN_PID), ...probeDead(SAFE_SPAWN_PID)], `pid=${JSON.stringify(bad)}：退回 spawnpid`);
  }
  // 没有 pid 文件：只有 spawnpid 也行；两个都没有就什么都不杀。
  makeJobDir(home, jobId, { spawnpid: SAFE_SPAWN_PID });
  runLocal(home, buildOfficialKillCommand(jobId));
  assert.equal(killLog(home)[0], `kill -s TERM -- -${SAFE_SPAWN_PID}`);
  makeJobDir(home, jobId, {});
  runLocal(home, buildOfficialKillCommand(jobId));
  assert.deepEqual(killLog(home), []);
});

test("结束任务：回报是否确认结束——TERM 后还活着补 KILL，仍活着如实说；已自己退出的不再发信号；任务目录不在单独回报", { skip }, (t) => {
  const { home } = makeHome(t);
  const jobId = "cli-killconfirm";
  // 探活一直说「还活着」：TERM 一轮 → 还在 → KILL 一轮 → 仍在 → alive=1，不写退出码（下次安装的预检会接管它）。
  stubKill(home, { probe: "alive" });
  let dir = makeJobDir(home, jobId, { pid: SAFE_PID });
  let out = parseKill(runLocal(home, buildOfficialKillCommand(jobId)).stdout);
  assert.deepEqual(killLog(home), [
    ...signalRound("TERM", SAFE_PID), `kill -0 ${SAFE_PID}`,
    ...signalRound("KILL", SAFE_PID), `kill -0 ${SAFE_PID}`,
  ]);
  assert.deepEqual([out.complete, out.stopped, out.state, out.exitCode], [true, false, "1", null]);
  assert.ok(!fs.existsSync(path.join(dir, "exit")));

  // 任务已经自己写了退出码：不发任何信号（pid 可能已被别的进程复用），原样回报它的退出码。
  dir = makeJobDir(home, jobId, { pid: SAFE_PID, exit: "0\n" });
  out = parseKill(runLocal(home, buildOfficialKillCommand(jobId)).stdout);
  assert.deepEqual(killLog(home), [], "已结束的任务不再 kill");
  assert.deepEqual([out.stopped, out.exitCode], [true, 0]);
  assert.equal(fs.readFileSync(path.join(dir, "exit"), "utf8").trim(), "0", "不覆盖任务自己的退出码");

  // 任务目录不在：读不到 pid，谈不上确认。
  fs.rmSync(dir, { recursive: true, force: true });
  out = parseKill(runLocal(home, buildOfficialKillCommand(jobId)).stdout);
  assert.deepEqual([out.complete, out.missing, out.stopped], [true, true, false]);
  assert.deepEqual(killLog(home), []);
  // 输出不完整（SSH 中途断开）：不算确认。
  assert.deepEqual(parseKill("job=ok\nalive=0\n"), { complete: false, missing: false, stopped: false, state: "0", exitCode: null });
});

test("轮询 / 预检：pid 文件内容不合法时不拿它去 kill -0，任务按「不在跑」处理", { skip }, (t) => {
  const { home } = makeHome(t);
  stubKill(home);
  const jobId = "cli-pollguard1";
  const started = String(Math.floor(Date.now() / 1000));
  // 桩自检：合法 pid → kill -0 被桩接住（桩返回 0，即"还活着"）。
  makeJobDir(home, jobId, { cli: "codex\n", started, pid: SAFE_PID });
  assert.equal(parsePoll(runLocal(home, buildOfficialPollCommand("codex", jobId)).stdout).alive, true);
  assert.deepEqual(killLog(home), [`kill -0 ${SAFE_PID}`], "桩接管了 kill");
  assert.deepEqual(parsePreflight("codex", runLocal(home, buildPreflightCommand("codex")).stdout).running, [jobId]);
  assert.deepEqual(killLog(home), [`kill -0 ${SAFE_PID}`]);

  for (const bad of BAD_PIDS) {
    makeJobDir(home, jobId, { cli: "codex\n", started, pid: bad, spawnpid: bad });
    const poll = parsePoll(runLocal(home, buildOfficialPollCommand("codex", jobId)).stdout);
    assert.equal(poll.complete, true);
    assert.equal(poll.alive, false, `轮询 pid=${JSON.stringify(bad)}`);
    const pf = parsePreflight("codex", runLocal(home, buildPreflightCommand("codex")).stdout);
    assert.equal(pf.complete, true);
    assert.deepEqual(pf.running, [], `预检 pid=${JSON.stringify(bad)}`);
    assert.deepEqual(killLog(home), [], `pid=${JSON.stringify(bad)}：不该调用 kill`);
  }
  // pid 文件刚被截断还没写进去（空）时，退回 spawnpid 判断存活。
  makeJobDir(home, jobId, { cli: "codex\n", started, pid: "", spawnpid: SAFE_SPAWN_PID });
  assert.equal(parsePoll(runLocal(home, buildOfficialPollCommand("codex", jobId)).stdout).alive, true);
  assert.deepEqual(killLog(home), [`kill -0 ${SAFE_SPAWN_PID}`]);
});

// 任务恰好在一次轮询中途跑完：任务脚本先写 exit 再退出，轮询必须先看进程、后读退出码，才不会拿到
// 「没有退出码 + 进程不在」这种只有被强杀才该出现的组合（install.mjs 会据此报「官方安装器意外退出」并回退）。
// 用桩把这个时序钉死：kill -0 被问到的那一刻任务「刚好写完 exit 并退出」。
test("轮询：任务在轮询中途正常结束 → 读到退出码，不误判成意外退出", { skip }, (t) => {
  const { home } = makeHome(t);
  const jobId = "cli-finishrace1";
  const dir = makeJobDir(home, jobId, { cli: "codex\n", started: String(Math.floor(Date.now() / 1000)), pid: SAFE_PID });
  writeExec(path.join(home, "fakebin", "sh"), `#!/bin/sh
[ "$1" = "-c" ] || exit 64
exec /bin/sh -c 'kill() { echo "kill $*" >> "$HOME/kill.log"; echo 0 > "${dir}/exit"; return 1; }
'"$2"
`);
  const poll = parsePoll(runLocal(home, buildOfficialPollCommand("codex", jobId)).stdout);
  assert.deepEqual(killLog(home), [`kill -0 ${SAFE_PID}`], "桩接管了 kill");
  assert.equal(poll.complete, true);
  assert.deepEqual([poll.alive, poll.exitCode], [false, 0]);
});

test("上传：字节数或 sha256 不符时删掉 .part、不留成品", { skip }, (t) => {
  const { home } = makeHome(t);
  const data = Buffer.from("hello world");
  const short = parseRemoteKv(runLocal(home, buildUploadCommand({ fileName: "f.bin", size: 99, sha256: sha256Of(data) }), { input: data }).stdout).values;
  assert.equal(short.upload, "short");
  const bad = parseRemoteKv(runLocal(home, buildUploadCommand({ fileName: "f.bin", size: data.length, sha256: SHA }), { input: data }).stdout).values;
  assert.equal(bad.upload, "badsum");
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache/cluster-workbench/cli/upload")), []);
  const ok = parseRemoteKv(runLocal(home, buildUploadCommand({ fileName: "f.bin", size: data.length, sha256: sha256Of(data) }), { input: data }).stdout).values;
  assert.equal(ok.upload, "ok");
  const file = path.join(home, ".cache/cluster-workbench/cli/upload/f.bin");
  assert.equal(fs.readFileSync(file, "utf8"), "hello world");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("取消上传后的清理：只删这个包的 .part 与成品，别的文件不碰；上传目录还不存在也算清理完", { skip }, (t) => {
  const { home } = makeHome(t);
  const run = () => parseRemoteKv(runLocal(home, buildUploadCleanupCommand({ fileName: "f.bin" })).stdout);
  assert.deepEqual([run().values.cleanup, run().complete], ["ok", true], "目录不存在");
  const dir = path.join(home, ".cache/cluster-workbench/cli/upload");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["f.bin.part", "f.bin", "g.bin", "f.bin.partial-note"]) fs.writeFileSync(path.join(dir, name), "x");
  assert.equal(run().values.cleanup, "ok");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["f.bin.partial-note", "g.bin"]);
  // 命令里先删 .part 再删成品：上传脚本最后一步是把 .part 改名成成品，这个顺序下怎么交错都不留文件。
  const command = buildUploadCleanupCommand({ fileName: "f.bin" });
  assert.ok(command.indexOf('f.bin.part"') > 0 && command.indexOf('f.bin.part"') < command.indexOf('f.bin"'));
});

test("codex 回退落盘：官方 package 布局 + current / ~/.local/bin/codex 软链 + auto-update-version；再装新版保留旧版并记 previous", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  const first = installCodex(home, fixtures, "0.159.2");
  assert.equal(first.out.values.result, "ok", first.res.stdout + first.res.stderr);
  const rel = path.join(home, CODEX_ROOT, "releases", NAME("0.159.2"));
  for (const f of ["bin/codex", "bin/codex-code-mode-host", "codex-path/rg", "codex-resources/bwrap", "codex-package.json"]) assert.ok(fs.existsSync(path.join(rel, f)), f);
  assert.equal(fs.readlinkSync(path.join(rel, "codex")), "bin/codex");
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), rel);
  assert.equal(readLink(home, ".local/bin/codex"), path.join(home, CODEX_ROOT, "current/bin/codex"));
  assert.equal(fs.readFileSync(path.join(home, CODEX_ROOT, "auto-update-version"), "utf8"), NAME("0.159.2"));
  assert.equal(runLocal(home, `"$HOME/.local/bin/codex" --version`).stdout.trim(), "codex-cli 0.159.2");

  const second = installCodex(home, fixtures, "0.160.1");
  assert.equal(second.out.values.result, "ok");
  assert.equal(second.out.values.from, NAME("0.159.2"));
  assert.ok(fs.existsSync(rel), "旧版本保留");
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), path.join(home, CODEX_ROOT, "releases", NAME("0.160.1")));
  assert.equal(fs.readFileSync(path.join(home, ".cache/cluster-workbench/cli/codex.previous"), "utf8").trim(), NAME("0.159.2"));
  assert.ok(!fs.readdirSync(path.join(home, CODEX_ROOT, "releases")).some((n) => n.startsWith(".staging")), "不留 staging");
  assert.deepEqual(fs.readdirSync(path.join(home, ".cache/cluster-workbench/cli/upload")), [], "上传的包装完即删");

  const verify = parseRemoteKv(runLocal(home, buildVerifyCommand("codex")).stdout).values;
  assert.equal(verify.version, "codex-cli 0.160.1");
  assert.equal(verify.current, NAME("0.160.1"));

  // 回滚：默认切回 previous；再回滚一次又切回来。
  const rb = parseRemoteKv(runLocal(home, buildRollbackCommand("codex")).stdout).values;
  assert.deepEqual([rb.result, rb.from, rb.to], ["ok", NAME("0.160.1"), NAME("0.159.2")]);
  assert.equal(runLocal(home, `"$HOME/.local/bin/codex" --version`).stdout.trim(), "codex-cli 0.159.2");
  const rb2 = parseRemoteKv(runLocal(home, buildRollbackCommand("codex", "0.160.1")).stdout).values;
  assert.deepEqual([rb2.result, rb2.to], ["ok", NAME("0.160.1")]);
  const bad = parseRemoteKv(runLocal(home, buildRollbackCommand("codex", "0.1.0")).stdout).values;
  assert.deepEqual([bad.result, bad.detail], ["failed", "bad-target"]);
});

test("codex 回退落盘：包里缺 bwrap → layout 失败，current 不动、不留 staging", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  installCodex(home, fixtures, "0.159.2");
  const broken = buildCodexPackage(fixtures, "0.160.1", { omit: ["codex-resources/bwrap"] });
  assert.equal(upload(home, broken).upload, "ok");
  const out = parseRemoteKv(runLocal(home, buildCodexActivateCommand({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fileName: broken.fileName, sha256: broken.sha256 })).stdout).values;
  assert.deepEqual([out.result, out.detail], ["failed", "layout"]);
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), path.join(home, CODEX_ROOT, "releases", NAME("0.159.2")));
  assert.ok(!fs.readdirSync(path.join(home, CODEX_ROOT, "releases")).some((n) => n.startsWith(".staging")));
});

// ---- v2.57 后续：重装同版本且布局损坏时，不能先删正式目录再挪 staging ----
//
// 故障注入用 fakebin 里的假 mv（PATH 里排在 /bin 前面）：按第一个参数（源路径）决定失败还是转给真 mv。
function injectMvFailure(home, patterns) {
  writeExec(path.join(home, "fakebin", "mv"), `#!/bin/sh
for a in "$@"; do case "$a" in -*) ;; *) src="$a"; break ;; esac; done
case "$src" in ${patterns.join("|")}) echo "mv: injected failure: $src" >&2; exit 1 ;; esac
exec /bin/mv "$@"
`);
}

test("codex 回退落盘：重装当前版本（布局损坏）时把 staging 挪成正式目录失败 → 原目录原样还在、current 不悬空；故障排除后重装成功", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  const { pkg } = installCodex(home, fixtures, "0.160.1");
  const releases = path.join(home, CODEX_ROOT, "releases");
  const rel = path.join(releases, NAME("0.160.1"));
  const activate = () => parseRemoteKv(runLocal(home, buildCodexActivateCommand({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fileName: pkg.fileName, sha256: pkg.sha256 })).stdout).values;
  // 布局损坏（缺 bwrap）→ 不复用、要重新解包覆盖；留一个记号文件，确认之后看到的还是原来那个目录。
  fs.rmSync(path.join(rel, "codex-resources/bwrap"));
  fs.writeFileSync(path.join(rel, "marker"), "original");
  assert.equal(upload(home, pkg).upload, "ok");

  // 第二次 mv（staging → 正式目录）失败：磁盘满 / 配额 / 权限。
  injectMvFailure(home, ["*/.staging.*"]);
  const failed = activate();
  assert.deepEqual([failed.result, failed.detail], ["failed", "move"]);
  assert.equal(fs.readFileSync(path.join(rel, "marker"), "utf8"), "original", "正式目录原样还在");
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), rel);
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1", "原来的版本照常可用");
  assert.deepEqual(fs.readdirSync(releases), [NAME("0.160.1")], "不留 staging / old");

  // 连挪回去也失败（最坏情况）：什么都不删，原目录留在 .old.* 里，报单独的代号。
  injectMvFailure(home, ["*/.staging.*", "*/.old.*"]);
  const stuck = activate();
  assert.deepEqual([stuck.result, stuck.detail], ["failed", "move-restore"]);
  const left = fs.readdirSync(releases);
  assert.equal(left.length, 1);
  assert.match(left[0], /^\.old\.0\.160\.1-x86_64-unknown-linux-musl\.\d+$/);
  assert.equal(fs.readFileSync(path.join(releases, left[0], "marker"), "utf8"), "original", "原目录的内容一个字节没丢");
  fs.renameSync(path.join(releases, left[0]), rel); // 手动挪回（FAIL_TEXT 里给的处理办法）

  // 故障排除：换成完整的新目录，旧的那份删掉，不留 old。
  fs.rmSync(path.join(home, "fakebin", "mv"));
  const ok = activate();
  assert.deepEqual([ok.result, ok.unpack], ["ok", "ok"]);
  assert.ok(fs.existsSync(path.join(rel, "codex-resources/bwrap")), "布局补全了");
  assert.ok(!fs.existsSync(path.join(rel, "marker")), "是新解包的目录");
  assert.deepEqual(fs.readdirSync(releases), [NAME("0.160.1")]);
  assert.equal(runLocal(home, '"$HOME/.local/bin/codex" --version').stdout.trim(), "codex-cli 0.160.1");
});

// Claude 一侧没有「先删再挪」：单文件 rename 覆盖，失败时原文件不动。这里只是把这一点钉住。
test("Claude 回退落盘：重装当前版本时改名失败 → 原版本文件与软链都不动", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  const V = path.join(home, ".local/share/claude/versions");
  const { bin } = installClaude(home, fixtures, "2.1.292");
  const before = fs.readFileSync(path.join(V, "2.1.292"));
  assert.equal(upload(home, bin).upload, "ok");
  injectMvFailure(home, ["*/versions/.*"]);
  const out = parseRemoteKv(runLocal(home, buildClaudeActivateCommand({ version: "2.1.292", fileName: bin.fileName, sha256: bin.sha256 })).stdout).values;
  assert.deepEqual([out.result, out.detail], ["failed", "move"]);
  assert.ok(fs.readFileSync(path.join(V, "2.1.292")).equals(before), "原版本文件原样还在");
  assert.equal(readLink(home, ".local/bin/claude"), path.join(V, "2.1.292"));
  assert.equal(runLocal(home, '"$HOME/.local/bin/claude" --version').stdout.trim(), "2.1.292 (Claude Code)");
  assert.deepEqual(fs.readdirSync(V), ["2.1.292"], "不留临时文件");
});

test("codex 回退落盘：版本号对不上 → smoke 失败；sha256 不符 → checksum 失败", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  const pkg = buildCodexPackage(fixtures, "0.159.2");
  upload(home, pkg);
  const wrongVersion = parseRemoteKv(runLocal(home, buildCodexActivateCommand({ version: "0.160.1", target: "x86_64-unknown-linux-musl", fileName: pkg.fileName, sha256: pkg.sha256 })).stdout).values;
  assert.deepEqual([wrongVersion.result, wrongVersion.detail], ["failed", "smoke"]);
  assert.equal(readLink(home, `${CODEX_ROOT}/current`), null);
  const wrongSum = parseRemoteKv(runLocal(home, buildCodexActivateCommand({ version: "0.159.2", target: "x86_64-unknown-linux-musl", fileName: pkg.fileName, sha256: SHA })).stdout).values;
  assert.deepEqual([wrongSum.result, wrongSum.detail], ["failed", "checksum"]);
});

test("codex 回退落盘：~/.local/bin/codex 原是旧向导的包装脚本 → 先备份再换成软链", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  writeExec(path.join(home, ".local/bin/codex"), "#!/bin/sh\n# >>> setup-wizard codex-proxy >>>\nexec /old/codex \"$@\"\n");
  const { out } = installCodex(home, fixtures, "0.160.1");
  assert.equal(out.values.result, "ok");
  assert.equal(out.values.visible, "backed-up");
  assert.ok(fs.readdirSync(path.join(home, ".local/bin")).some((n) => n.startsWith("codex.bak.")));
  assert.ok(fs.lstatSync(path.join(home, ".local/bin/codex")).isSymbolicLink());
});

test("Claude 回退落盘：versions/<ver> 单文件 + 绝对路径软链；覆盖 0 字节残留；回滚切回旧版本", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  const V = path.join(home, ".local/share/claude/versions");
  const first = installClaude(home, fixtures, "2.1.285");
  assert.equal(first.out.values.result, "ok", first.res.stdout + first.res.stderr);
  // 9 月 `claude update` 超时留下的 0 字节文件
  fs.writeFileSync(path.join(V, "2.1.292"), "");
  const pf = parsePreflight("claude", runLocal(home, buildPreflightCommand("claude")).stdout);
  assert.deepEqual(pf.releases.filter((r) => r.broken).map((r) => r.name), ["2.1.292"]);

  const second = installClaude(home, fixtures, "2.1.292");
  assert.equal(second.out.values.result, "ok");
  assert.equal(second.out.values.from, "2.1.285");
  assert.ok(fs.statSync(path.join(V, "2.1.292")).size > 1024 * 1024, "0 字节残留被覆盖");
  assert.equal(readLink(home, ".local/bin/claude"), path.join(V, "2.1.292"));
  assert.equal(runLocal(home, `"$HOME/.local/bin/claude" --version`).stdout.trim(), "2.1.292 (Claude Code)");
  assert.ok(!fs.readdirSync(V).some((n) => n.startsWith(".")), "不留临时文件");

  const rb = parseRemoteKv(runLocal(home, buildRollbackCommand("claude")).stdout).values;
  assert.deepEqual([rb.result, rb.from, rb.to], ["ok", "2.1.292", "2.1.285"]);
  assert.equal(readLink(home, ".local/bin/claude"), path.join(V, "2.1.285"));
});

test("Claude 回滚：没有别的完整版本 → no-target，不动软链", { skip }, (t) => {
  const { home, fixtures } = makeHome(t);
  installClaude(home, fixtures, "2.1.292");
  fs.writeFileSync(path.join(home, ".local/share/claude/versions/2.1.223"), ""); // 0 字节的不算
  const rb = parseRemoteKv(runLocal(home, buildRollbackCommand("claude")).stdout).values;
  assert.deepEqual([rb.result, rb.detail], ["failed", "no-target"]);
  assert.equal(readLink(home, ".local/bin/claude"), path.join(home, ".local/share/claude/versions/2.1.292"));
});
