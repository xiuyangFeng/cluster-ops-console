// 配置向导"集群侧受管配置"一步（routing.mjs 的 configureClusterEnv）：执行顺序、交互确认、失败中止、
// --dry-run 预览。ssh / ask 全部注入：要么是记录调用的假实现，要么是在临时 HOME 里用本机 bash 执行命令的
// "本地 ssh"——绝不连真实服务器、不碰真实 HOME。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClusterEnvSteps,
  buildStrayScanCommand,
  CLAUDE_SETTINGS_READ_COMMAND,
  STRAY_SCAN_DONE,
} from "../work/monitor/lib/cluster-env.mjs";
import { configureClusterEnv } from "./setup/routing.mjs";

const skip = process.platform === "win32";
const SERVER = { id: "server-01", host: "myserver" };

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

// kai 现场的扫描输出（grep -nH 格式 + 完成哨兵）与 reclaude 接管的 settings.json 回读。
const CY_SCAN_OUTPUT = [
  '.bashrc:145:export HTTP_PROXY="http://127.0.0.1:7891"',
  '.bashrc:146:export HTTPS_PROXY="http://127.0.0.1:7891"',
  '.bashrc:149:export ALL_PROXY="socks5h://127.0.0.1:7891"',
  '.bashrc:150:export all_proxy="socks5h://127.0.0.1:7891"',
  '.bashrc:151:export HTTP_PROXY="socks5h://127.0.0.1:7891"',
  '.bashrc:152:export HTTPS_PROXY="socks5h://127.0.0.1:7891"',
  '.bashrc:153:export http_proxy="socks5h://127.0.0.1:7891"',
  '.bashrc:154:export https_proxy="socks5h://127.0.0.1:7891"',
  ".bashrc:162:# >>> cluster-workbench env >>>",
  ".bashrc:165:# <<< cluster-workbench env <<<",
  '.bash_profile:6:export HTTP_PROXY="http://127.0.0.1:7891"',
  '.bash_profile:7:export HTTPS_PROXY="http://127.0.0.1:7891"',
  STRAY_SCAN_DONE,
  "",
].join("\n");
const CY_CLAUDE_READ = `__CWB_CLAUDE__=1\n${JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: "/public/newhome/kai/.reclaude/ca.pem" }, hooks: {} }, null, 2)}\n`;

// 记录调用的假 ssh：按命令内容分派返回值；writeStatus 可让指定步骤失败。
function fakeSsh({ scan = { status: 0, stdout: CY_SCAN_OUTPUT }, claude = { status: 0, stdout: CY_CLAUDE_READ }, fail = {} } = {}) {
  const steps = buildClusterEnvSteps({ port: 7891 });
  const calls = [];
  const ssh = (host, cmd, opts = {}) => {
    const kind = cmd === buildStrayScanCommand() ? "scan"
      : cmd === CLAUDE_SETTINGS_READ_COMMAND ? "claude-read"
        : steps.find((s) => s.command === cmd)?.id
          ?? (cmd.includes("-v L=") ? "comment-out" : cmd.includes("wc -c") ? "claude-write" : "unknown");
    calls.push({ host, kind, cmd, input: opts.input });
    if (fail[kind]) return { status: 1, stdout: "", stderr: `${kind} boom` };
    if (kind === "scan") return scan;
    if (kind === "claude-read") return claude;
    return { status: 0, stdout: "", stderr: "" };
  };
  ssh.calls = calls;
  ssh.kinds = () => calls.map((c) => c.kind);
  return ssh;
}

test("configureClusterEnv --dry-run：只做两次只读探测，打印每步命令与写入内容、kai 要注释的确切行号，不问不写", async () => {
  const ssh = fakeSsh();
  const ask = makeAsk([]);
  const { result, out } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: true, ssh, ask }));

  assert.deepEqual(ssh.kinds(), ["scan", "claude-read"], "dry-run 只发只读命令");
  assert.equal(ask.asked.length, 0);
  assert.equal(result.status, "dry-run");
  assert.deepEqual(result.steps.map((s) => s.id), ["write-env", "source-bashrc", "source-login", "strip-legacy"]);
  for (const step of buildClusterEnvSteps({ port: 7891 })) {
    assert.ok(out.includes(step.command), `打印 ${step.id} 的完整命令`);
    if (step.preview) assert.ok(out.includes(step.preview), `打印 ${step.id} 的明文内容`);
  }
  assert.match(out, /确认后注释掉 ~\/\.bashrc 第 145、146、149、150、151、152、153、154 行/);
  assert.match(out, /-v L=",145,146,149,150,151,152,153,154,"/);
  assert.match(out, /确认后注释掉 ~\/\.bash_profile 第 6、7 行/);
  assert.match(out, /reclaude 接管/);
  assert.equal(result.strays.status, "dry-run");
  assert.equal(result.strays.items.length, 10);
  assert.deepEqual(result.claude, { action: "skip", reason: "reclaude-managed", changedKeys: undefined });
});

test("configureClusterEnv --dry-run + probeInDryRun:false：零 SSH，只打印模板", async () => {
  const ssh = fakeSsh();
  const { result, out } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: true, ssh, ask: makeAsk([]), probeInDryRun: false }));
  assert.deepEqual(ssh.calls, []);
  assert.ok(out.includes(buildStrayScanCommand()));
  assert.ok(out.includes(CLAUDE_SETTINGS_READ_COMMAND));
  assert.equal(result.strays, null);
});

test("configureClusterEnv：写入四步 → 只读扫描 → 用户确认后才注释 → Claude 设置；顺序固定", async () => {
  const ssh = fakeSsh();
  const ask = makeAsk(["y"]);
  const { result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask }));
  assert.deepEqual(ssh.kinds(), ["write-env", "source-bashrc", "source-login", "strip-legacy", "scan", "comment-out", "comment-out", "claude-read"]);
  assert.ok(ssh.calls.every((c) => c.host === "myserver"));
  assert.ok(ssh.calls.every((c) => /^sh -c '[\s\S]*'$/.test(c.cmd)), "交给 ssh 的每条命令都包成 sh -c（不依赖对方登录 shell）");
  assert.equal(ask.asked.length, 1);
  assert.match(ask.asked[0], /是否注释掉以上 10 行/);
  assert.equal(result.status, "ok");
  assert.equal(result.strays.status, "commented");
  assert.equal(result.claude.reason, "reclaude-managed");
});

test("configureClusterEnv：回车 = 不注释，旧导出原样保留（受管块在末尾仍会覆盖它们）", async () => {
  const ssh = fakeSsh();
  const { result, out } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk([""]) }));
  assert.ok(!ssh.kinds().includes("comment-out"));
  assert.equal(result.strays.status, "declined");
  assert.match(out, /已保留这些行/);
});

test("configureClusterEnv：受管文件写入失败 → 立即中止（不扫描、不注释、不动 Claude），打印可读的手动命令", async () => {
  const ssh = fakeSsh({ fail: { "write-env": true } });
  const { result, out } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk(["y"]) }));
  assert.deepEqual(ssh.kinds(), ["write-env"]);
  assert.equal(result.status, "failed");
  assert.match(out, /write-env boom/);
  assert.match(out, /cat > ~\/\.config\/cluster-workbench\/env\.sh <<'EOF'/);
  assert.match(out, /已中止后续步骤/);
});

test("configureClusterEnv：引入块写入失败同样中止；清理旧块失败只告警、继续", async () => {
  let ssh = fakeSsh({ fail: { "source-login": true } });
  let { result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk(["y"]) }));
  assert.deepEqual(ssh.kinds(), ["write-env", "source-bashrc", "source-login"]);
  assert.equal(result.status, "failed");

  ssh = fakeSsh({ fail: { "strip-legacy": true } });
  ({ result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk(["y"]) })));
  assert.equal(result.status, "ok");
  assert.ok(ssh.kinds().includes("comment-out"));
  assert.deepEqual(result.steps.find((s) => s.id === "strip-legacy"), { id: "strip-legacy", status: "failed" });
});

test("configureClusterEnv：扫描没跑完（无完成哨兵 / SSH 失败）→ 不询问、不注释，Claude 设置照常检查", async () => {
  for (const scan of [{ status: 0, stdout: '.bashrc:145:export HTTP_PROXY="x"\n' }, { status: 255, stdout: "", stderr: "Connection closed" }]) {
    const ssh = fakeSsh({ scan });
    const ask = makeAsk(["y"]);
    const { result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask }));
    assert.equal(result.strays.status, "scan-failed");
    assert.equal(ask.asked.length, 0);
    assert.ok(!ssh.kinds().includes("comment-out"));
    assert.ok(ssh.kinds().includes("claude-read"));
  }
});

test("configureClusterEnv：Claude 设置——无 claude 跳过 / 坏 JSON 跳过并给手动键 / 写回失败如实报告", async () => {
  let ssh = fakeSsh({ claude: { status: 0, stdout: "__CWB_CLAUDE__=0\n" } });
  let { result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk([""]) }));
  assert.equal(result.claude.reason, "no-claude");

  ssh = fakeSsh({ claude: { status: 0, stdout: "__CWB_CLAUDE__=1\n{oops" } });
  const invalid = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk([""]) }));
  result = invalid.result;
  const out = invalid.out;
  assert.equal(result.claude.reason, "invalid-json");
  assert.match(out, /"HTTPS_PROXY": "http:\/\/127\.0\.0\.1:7891"/);
  assert.ok(!ssh.kinds().includes("claude-write"));

  ssh = fakeSsh({ claude: { status: 0, stdout: '__CWB_CLAUDE__=1\n{"hooks":{}}' }, fail: { "claude-write": true } });
  ({ result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk([""]) })));
  assert.equal(result.claude.action, "failed");
  const write = ssh.calls.find((c) => c.kind === "claude-write");
  assert.equal(JSON.parse(write.input).env.HTTPS_PROXY, "http://127.0.0.1:7891", "内容经标准输入送达");
});

// ---------------------------------------------------------------------------
// 端到端：把"ssh"换成在临时 HOME 里执行的本机 bash，跑完整一步再按真实 shell 验证
// ---------------------------------------------------------------------------

function localSsh(home) {
  const calls = [];
  const ssh = (_host, cmd, opts = {}) => {
    calls.push(cmd);
    return spawnSync("bash", ["-c", `umask 0002; ${cmd}`], { encoding: "utf8", input: opts.input, env: { HOME: home, PATH: "/usr/bin:/bin" } });
  };
  ssh.calls = calls;
  return ssh;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的 ${VAR-默认值} 展开，不是 JS 模板
const PROBE = 'printf "%s|%s" "${HTTPS_PROXY-<unset>}" "${ALL_PROXY-<unset>}"';

function shellHttps(home, flag) {
  const res = spawnSync("bash", [flag, PROBE], { encoding: "utf8", input: "", env: { HOME: home, PATH: "/usr/bin:/bin" }, timeout: 15000 });
  return res.stdout;
}

test("端到端（本地 bash 充当 ssh）：一步跑完 → 旧导出被注释、三处生效、Claude 合并；重跑全是空操作", { skip }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-cluster-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bashrc = [
    "case $- in *i*) ;; *) return;; esac",
    'export PATH="/usr/bin:/bin:/public/slurm/bin"',
    'export HTTP_PROXY="http://127.0.0.1:7891"',
    'export ALL_PROXY="socks5h://127.0.0.1:7891"',
    'export HTTPS_PROXY="socks5h://127.0.0.1:7891"',
    "",
  ].join("\n");
  const bashProfile = 'export HTTPS_PROXY="http://127.0.0.1:7891"\n';
  fs.writeFileSync(path.join(home, ".bashrc"), bashrc);
  fs.writeFileSync(path.join(home, ".bash_profile"), bashProfile);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({ hooks: { Stop: [] }, model: "x" }, null, 2));

  assert.equal(shellHttps(home, "-ic"), "socks5h://127.0.0.1:7891|socks5h://127.0.0.1:7891", "复现：bash -i 被 SOCKS 覆盖");

  const ssh = localSsh(home);
  const { result } = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk(["y"]) }));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.strays.items.map((s) => `${s.file}:${s.line}`), [".bashrc:3", ".bashrc:4", ".bashrc:5", ".bash_profile:1"]);
  assert.equal(result.strays.status, "commented");
  assert.deepEqual(result.claude.action, "write");

  const lines = fs.readFileSync(path.join(home, ".bashrc"), "utf8").split("\n");
  assert.equal(lines[1], 'export PATH="/usr/bin:/bin:/public/slurm/bin"', "PATH 行不动");
  assert.match(lines[2], /^# \[cluster-workbench 已停用\] export HTTP_PROXY=/);
  assert.equal(shellHttps(home, "-ic"), "http://127.0.0.1:7891|<unset>");
  assert.equal(shellHttps(home, "-lc"), "http://127.0.0.1:7891|<unset>");
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"));
  assert.deepEqual(settings.hooks, { Stop: [] });
  assert.equal(settings.env.https_proxy, "http://127.0.0.1:7891");

  const backups = () => fs.readdirSync(home).filter((n) => n.includes(".bak.")).length;
  const before = backups();
  const second = await captureConsole(() => configureClusterEnv(SERVER, 7891, { dryRun: false, ssh, ask: makeAsk(["y"]) }));
  assert.equal(second.result.strays.status, "none");
  assert.equal(second.result.claude.action, "unchanged");
  assert.ok(backups() - before <= 2, "重跑只为两处引入块各留一份备份，不再注释、不再改 settings");
  assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8").split("# >>> cluster-workbench env >>>").length - 1, 1);
});
