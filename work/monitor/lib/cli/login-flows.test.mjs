// 登录流程纯函数（login-flows.mjs）：命令生成在临时 HOME 里用真实 sh / bash / csh 执行（假 codex / curl 垫片），
// 输出解析用贴近真机的样本（含 ANSI / OSC 8 超链接），config.toml 与 settings.json 的保格式改写。
// 只碰 os.tmpdir()，不 ssh、不碰真实 HOME。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildAccountSshOptions,
  buildClaudeAccountCommand,
  buildCodexAccountCommand,
  buildInspectCommand,
  buildReachabilityCommand,
  buildRemoteKillCommand,
  buildReplaceFileCommand,
  buildStatusCommand,
  buildWriteKeyFileCommand,
  clearManagedDefaultProvider,
  describeRelay,
  extractAuthUrl,
  isAllowedAuthUrl,
  isLocalForwardFailure,
  MANAGED_PROVIDER_MARK,
  normalizeAuthCode,
  normalizeProviderId,
  outputTail,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  parseInspectOutput,
  parseReachabilityOutput,
  planClaudeApiSettings,
  providerEnvKey,
  redactSecrets,
  renderKeyFile,
  scanLoginOutput,
  stripAnsi,
  upsertCodexProvider,
} from "./login-flows.mjs";

const skip = process.platform === "win32";
const CSH = ["/bin/tcsh", "/bin/csh"].find((p) => !skip && fs.existsSync(p)) || null;

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-login-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, "bin"));
  return home;
}

function stub(home, name, body) {
  const file = path.join(home, "bin", name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// 模拟 sshd：`<登录 shell> -c <命令串>`，PATH 只含垫片目录与系统目录。
function run(home, command, { input, outer = "bash" } = {}) {
  return spawnSync(outer, ["-c", command], {
    encoding: "utf8",
    input,
    env: { HOME: home, PATH: `${home}/bin:/usr/bin:/bin`, LC_ALL: "C" },
  });
}

// ---------------------------------------------------------------------------
// 命令：语法与在真实 shell 里的行为
// ---------------------------------------------------------------------------

const ALL_COMMANDS = () => [
  ["codex-account", buildCodexAccountCommand({ port: 7892 })],
  ["codex-account-noport", buildCodexAccountCommand({ port: null })],
  ["claude-account", buildClaudeAccountCommand({ port: 7892 })],
  ["claude-setup-token", buildClaudeAccountCommand({ port: 7892, variant: "setup-token" })],
  ["kill", buildRemoteKillCommand(12345, "codex")],
  ["inspect", buildInspectCommand({ cli: "codex", port: 7892, file: ".codex/config.toml" })],
  ["reach", buildReachabilityCommand({ port: 7892, url: "https://relay.example.com:9443/v1?x='1'&y=!", direct: false })],
  ["reach-direct", buildReachabilityCommand({ port: 7892, url: "http://10.0.0.5:8080", direct: true })],
  ["status", buildStatusCommand({ cli: "claude", port: 7892 })],
  ["key-file", buildWriteKeyFileCommand("codex-relay", 42)],
  ["replace", buildReplaceFileCommand(".claude/settings.json", 10, { chmod600: true })],
];

test("所有远端命令都是 sh -c '…'，在 bash / sh / dash 下语法成立；登录 shell 是 csh 时同样能解析", { skip }, () => {
  for (const [id, cmd] of ALL_COMMANDS()) {
    assert.match(cmd, /^sh -c '/, id);
    const inner = spawnSync("bash", ["-c", `printf '%s' ${cmd.slice("sh -c ".length)}`], { encoding: "utf8" }).stdout;
    for (const checker of ["bash", "/bin/sh", fs.existsSync("/bin/dash") ? "/bin/dash" : null].filter(Boolean)) {
      const res = spawnSync(checker, ["-n", "-c", inner], { encoding: "utf8" });
      assert.equal(res.status, 0, `${id} 在 ${checker} 下语法错误: ${res.stderr}`);
    }
    if (CSH) {
      // csh 只负责把参数交给 sh：它把 `\`+换行还原成换行（bash 原样保留、由 sh 当续行删掉），
      // 两种解读对 sh 是同一段程序——去掉续行后逐字相同，且 sh 下语法成立。
      const viaCsh = spawnSync(CSH, ["-c", `printf '%s' ${cmd.slice("sh -c ".length)}`], { encoding: "utf8" });
      assert.equal(viaCsh.status, 0, `${id} csh: ${viaCsh.stderr}`);
      assert.equal(viaCsh.stdout, inner.replaceAll("\\\n", "\n"), `${id}: csh 与 bash 交给 sh 的脚本等价`);
      assert.equal(spawnSync("/bin/sh", ["-n", "-c", viaCsh.stdout], { encoding: "utf8" }).status, 0, `${id}: csh 解读后的脚本语法成立`);
    }
  }
});

test("账号命令：先 source env.sh（没有时用本人端口兜底代理），打印 pid 后 exec；集群 1455 被占直接退出不启动", { skip }, (t) => {
  const home = tmpHome(t);
  stub(home, "codex", 'echo "ARGS=$*"; echo "PROXY=$HTTPS_PROXY"');
  stub(home, "ss", "printf 'State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 128 127.0.0.1:22 0.0.0.0:*\\n'");
  stub(home, "timeout", 'while [ "$1" != codex ] && [ "$1" != claude ]; do shift; done; exec "$@"');
  let res = run(home, buildCodexAccountCommand({ port: 7892 }));
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^__CWB_PID__=\d+$/m);
  assert.match(res.stdout, /^ARGS=login$/m);
  assert.match(res.stdout, /^PROXY=http:\/\/127\.0\.0\.1:7892$/m, "没有 env.sh 时用端口兜底");

  // 有 env.sh 时以它为准
  fs.mkdirSync(path.join(home, ".config/cluster-workbench"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/cluster-workbench/env.sh"), 'export HTTPS_PROXY="http://127.0.0.1:9999"\n');
  res = run(home, buildCodexAccountCommand({ port: 7892 }));
  assert.match(res.stdout, /^PROXY=http:\/\/127\.0\.0\.1:9999$/m);

  // 1455 被占（v4 / v6 两种写法）
  for (const addr of ["127.0.0.1:1455", "[::1]:1455"]) {
    stub(home, "ss", `printf 'State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 128 ${addr} 0.0.0.0:*\\n'`);
    res = run(home, buildCodexAccountCommand({ port: 7892 }));
    assert.equal(res.status, 75);
    assert.match(res.stdout, /__CWB_PORT_BUSY__/);
    assert.doesNotMatch(res.stdout, /ARGS=/, "被占时不启动 codex login");
  }
  // 14550 不算
  stub(home, "ss", "printf 'h\\nLISTEN 0 128 127.0.0.1:14550 0.0.0.0:*\\n'");
  assert.equal(run(home, buildCodexAccountCommand({ port: 7892 })).status, 0);

  // 没装 codex
  fs.rmSync(path.join(home, "bin", "codex"));
  res = run(home, buildCodexAccountCommand({ port: 7892 }));
  assert.equal(res.status, 127);
  assert.match(res.stdout, /__CWB_NO_CLI__/);
});

test("Claude 账号命令：auth login --claudeai / setup-token，经 timeout --foreground 硬上限", { skip }, (t) => {
  const home = tmpHome(t);
  stub(home, "claude", 'echo "ARGS=$*"');
  stub(home, "timeout", 'echo "TIMEOUT=$1 $2 $3 $4"; shift 4; exec "$@"');
  let res = run(home, buildClaudeAccountCommand({ port: 7892 }));
  assert.match(res.stdout, /^TIMEOUT=--foreground -k 10 660$/m);
  assert.match(res.stdout, /^ARGS=auth login --claudeai$/m);
  res = run(home, buildClaudeAccountCommand({ port: 7892, variant: "setup-token" }));
  assert.match(res.stdout, /^ARGS=setup-token$/m);
});

test("ssh 选项：-tt；Codex 带 ExitOnForwardFailure 与 v4（可选 v6）两条 -L", () => {
  assert.deepEqual(buildAccountSshOptions({ cli: "claude" }), ["-tt", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]);
  const codex = buildAccountSshOptions({ cli: "codex", forwardV6: true });
  assert.ok(codex.includes("ExitOnForwardFailure=yes"));
  assert.deepEqual(codex.filter((_, i) => codex[i - 1] === "-L"), ["127.0.0.1:1455:127.0.0.1:1455", "[::1]:1455:127.0.0.1:1455"]);
  const v4 = buildAccountSshOptions({ cli: "codex", forwardV6: false });
  assert.deepEqual(v4.filter((_, i) => v4[i - 1] === "-L"), ["127.0.0.1:1455:127.0.0.1:1455"]);
});

test("远端清理：只杀命令行仍含 CLI 名的那个 pid；pid 非法直接抛错", { skip }, (t) => {
  const home = tmpHome(t);
  const sleeper = spawnSync("bash", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const pid = Number(sleeper.stdout.trim());
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  });
  // 命令行是 sleep，不含 codex：不能杀
  assert.equal(run(home, buildRemoteKillCommand(pid, "codex")).status, 0);
  assert.doesNotThrow(() => process.kill(pid, 0), "不是 codex 的进程不被误杀");
  assert.throws(() => buildRemoteKillCommand("1; rm -rf ~", "codex"));
  assert.throws(() => buildRemoteKillCommand(1, "codex"));
});

test("只读探测：env.sh / CLI 是否存在 + 文件原样字节（base64 往返，含中文与无末尾换行）", { skip }, (t) => {
  const home = tmpHome(t);
  stub(home, "codex", "true");
  let res = run(home, buildInspectCommand({ cli: "codex", port: 7892, file: ".codex/config.toml" }));
  assert.deepEqual(parseInspectOutput(res.stdout), { envPresent: false, cliPresent: true, file: null });
  fs.mkdirSync(path.join(home, ".codex"));
  const text = 'model = "gpt-5"\n# 中文注释\n[profiles.a]\nx = 1';
  fs.writeFileSync(path.join(home, ".codex/config.toml"), text);
  fs.mkdirSync(path.join(home, ".config/cluster-workbench"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/cluster-workbench/env.sh"), "");
  res = run(home, buildInspectCommand({ cli: "codex", port: 7892, file: ".codex/config.toml" }));
  assert.deepEqual(parseInspectOutput(res.stdout), { envPresent: true, cliPresent: true, file: text });
  assert.equal(parseInspectOutput("ssh: connect timed out"), null, "哨兵不全 → null");
});

test("连通测试：经隧道用 --proxytunnel、内网用 --noproxy '*'；URL 里的引号 / ! 原样传给 curl；不带任何 key", { skip }, (t) => {
  const home = tmpHome(t);
  stub(home, "curl", 'for a in "$@"; do echo "ARG=$a"; done; printf "__CWB_HTTP__=401\\n"');
  const url = "https://relay.example.com:9443/v1?x='1'&y=!";
  let res = run(home, buildReachabilityCommand({ port: 7892, url, direct: false }));
  assert.match(res.stdout, /^ARG=--proxytunnel$/m);
  assert.match(res.stdout, /ARG=--noproxy\nARG=\n/, "清空 NO_PROXY，不能绕过通道后误报测试通过");
  assert.ok(res.stdout.includes(`ARG=${url}\n`), res.stdout);
  assert.deepEqual(parseReachabilityOutput(res.stdout), { tested: true, reachable: true, httpCode: 401, detail: "" });
  res = run(home, buildReachabilityCommand({ port: 7892, url: "http://10.0.0.5:8080", direct: true }));
  assert.match(res.stdout, /^ARG=--noproxy$/m);
  assert.match(res.stdout, /^ARG=\*$/m);
  assert.doesNotMatch(res.stdout, /proxytunnel/);
  assert.deepEqual(
    parseReachabilityOutput("curl: (7) Failed to connect to 10.0.0.5 port 8080: Connection refused\n__CWB_HTTP__=000\n__CWB_CURL_EXIT__=7\n"),
    { tested: true, reachable: false, httpCode: 0, detail: "curl: (7) Failed to connect to 10.0.0.5 port 8080: Connection refused" },
  );
  assert.equal(parseReachabilityOutput("__CWB_HTTP__=nocurl\n").tested, false);
});

test("key 文件：经标准输入写入，目录 700 / 文件 600，不留备份；字节数不符时目标不变", { skip }, (t) => {
  const home = tmpHome(t);
  const key = "sk-abc'def\"$HOME`x`";
  const text = renderKeyFile("CWB_RELAY_API_KEY", key);
  const cmd = buildWriteKeyFileCommand("codex-relay", Buffer.byteLength(text));
  assert.doesNotMatch(cmd, /sk-abc/, "命令串里没有 key");
  let res = run(home, cmd, { input: text });
  assert.equal(res.status, 0, res.stderr);
  const dir = path.join(home, ".config/cluster-workbench/keys");
  const file = path.join(dir, "codex-relay.env");
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ["codex-relay.env"], "没有备份 / 临时文件残留");
  const sourced = spawnSync("sh", ["-c", `. "${file}"; printf %s "$CWB_RELAY_API_KEY"`], { encoding: "utf8" });
  assert.equal(sourced.stdout, key, "source 后原样还原");
  // 截断（断线）：长度对不上 → 失败，原文件不动
  res = run(home, buildWriteKeyFileCommand("codex-relay", Buffer.byteLength(text) + 5), { input: "export X=1\n" });
  assert.notEqual(res.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), text);
  assert.deepEqual(fs.readdirSync(dir), ["codex-relay.env"]);
});

test("整文件替换：chmod600 时把原本 644 的 settings.json 收紧为 600，并留备份", { skip }, (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const target = path.join(home, ".claude/settings.json");
  fs.writeFileSync(target, "{}\n", { mode: 0o644 });
  const next = '{\n  "env": {}\n}\n';
  const res = run(home, buildReplaceFileCommand(".claude/settings.json", Buffer.byteLength(next), { chmod600: true }), { input: next });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), next);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.ok(fs.readdirSync(path.join(home, ".claude")).some((f) => f.startsWith("settings.json.bak.")));
});

// 终审：tmp 原先 cp -p 继承原文件权限（集群 umask 0002 下常是 664），含 key 的内容以 664 落盘、mv 之后才 chmod 600。
test("整文件替换：chmod600 时备份名只求值一次——两条命令之间跨了秒也不会找错文件", { skip }, (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const target = path.join(home, ".claude/settings.json");
  fs.writeFileSync(target, '{"old":true}\n');
  fs.chmodSync(target, 0o664);
  // 假 date：每调用一次往后走一秒。备份名里的 $(date +%s) 若在 cp 与 chmod 两处各求值一次，
  // chmod 找的就是另一个名字（CI 上偶发的「chmod: cannot access …bak.…」正是真实时钟恰好跨秒）。
  stub(home, "date", `n=$(cat "$HOME/date-calls" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$HOME/date-calls"; echo $((1791700000 + n))`);
  const next = '{"new":true}\n';
  const res = run(home, `umask 0002; ${buildReplaceFileCommand(".claude/settings.json", Buffer.byteLength(next), { chmod600: true })}`, { input: next });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), next);
  const backups = fs.readdirSync(path.dirname(target)).filter((n) => n.startsWith("settings.json.bak."));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(target), backups[0]), "utf8"), '{"old":true}\n');
  assert.equal(fs.statSync(path.join(path.dirname(target), backups[0])).mode & 0o777, 0o600, "备份同样收紧到 600");
});

test("整文件替换：chmod600 时含 key 的内容从落盘那一刻起就是 600（原文件 664）", { skip }, (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const target = path.join(home, ".claude/settings.json");
  fs.writeFileSync(target, "{}\n");
  fs.chmodSync(target, 0o664);
  // 假 cat：读标准输入之前记下 tmp 此刻的权限（重定向已经把它建好了），再交给真 cat。
  stub(home, "cat", `for f in "$HOME"/.claude/settings.json.tmp.*; do
  if [ -f "$f" ]; then stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f"; fi
done >> "$HOME/tmp-modes.log"
exec /bin/cat "$@"`);
  const next = '{\n  "env": {\n    "ANTHROPIC_API_KEY": "sk-ant-api03-FAKE-12345678"\n  }\n}\n';
  const cmd = buildReplaceFileCommand(".claude/settings.json", Buffer.byteLength(next), { chmod600: true });
  assert.doesNotMatch(cmd, /sk-ant/, "命令串里没有 key");
  const res = run(home, `umask 0002; ${cmd}`, { input: next });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readFileSync(path.join(home, "tmp-modes.log"), "utf8").split("\n").filter(Boolean), ["600"], "写入期间 tmp 是 600");
  assert.equal(fs.readFileSync(target, "utf8"), next);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.ok(!fs.readdirSync(path.join(home, ".claude")).some((f) => f.includes(".tmp.")));
});

// ---------------------------------------------------------------------------
// 输出解析
// ---------------------------------------------------------------------------

const CODEX_URL = "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid&state=abc";
const CODEX_OUTPUT = [
  "__CWB_PID__=4242\r\n",
  "\x1b[2mStarting local login server on http://localhost:1455.\x1b[0m\r\n",
  "If your browser did not open, navigate to this URL to authenticate:\r\n\r\n",
  `\x1b]8;;${CODEX_URL}\x07\x1b[4m${CODEX_URL}\x1b[0m\x1b]8;;\x07\r\n`,
].join("");

test("Codex 输出：去 ANSI / OSC 8 后取到授权链接与 pid；成功提示只认 'Successfully logged in.'（不认 MCP 那句）", () => {
  assert.equal(stripAnsi("\x1b[1mA\x1b[0m\r\n"), "A\n");
  const scan = scanLoginOutput("codex", { full: CODEX_OUTPUT });
  assert.equal(scan.url, CODEX_URL);
  assert.equal(scan.pid, 4242);
  assert.equal(scan.success, false);
  assert.equal(scan.portBusy, false);
  assert.equal(scanLoginOutput("codex", { full: `${CODEX_OUTPUT}Successfully logged in.\r\n` }).success, true);
  assert.equal(scanLoginOutput("codex", { full: "Successfully logged in to MCP server 'x'\n" }).success, false);
  assert.equal(scanLoginOutput("codex", { full: "Error logging in: token exchange failed\n" }).failure, true);
});

test("1455 被占：远端哨兵 / codex 自报算集群侧；本机 ssh 转发失败不算（另行归因）", () => {
  assert.equal(scanLoginOutput("codex", { full: "__CWB_PORT_BUSY__\r\n" }).portBusy, true);
  assert.equal(scanLoginOutput("codex", { full: "Port 127.0.0.1:1455 is already in use\n" }).portBusy, true);
  const local = "bind [127.0.0.1]:1455: Address already in use\r\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 1455\r\nCould not request local forwarding.\r\n";
  assert.equal(scanLoginOutput("codex", { full: local }).portBusy, false);
  assert.equal(isLocalForwardFailure(local), true);
});

const CLAUDE_URL = "https://claude.ai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=xyz";

test("Claude 输出：取链接；成功 / 失败只看提交授权码之后的那段；setup-token 取出令牌", () => {
  const full = `\x1b[?25l__CWB_PID__=77\r\nBrowser didn't open? Use the url below to sign in:\r\n\r\n${CLAUDE_URL}\r\n\r\nPaste code here if prompted > `;
  const scan = scanLoginOutput("claude", { full });
  assert.equal(scan.url, CLAUDE_URL);
  assert.equal(scan.pid, 77);
  assert.equal(scan.success, false);
  const after = "abc#def\r\nLogin successful. Press Enter to continue";
  assert.equal(scanLoginOutput("claude", { full: full + after, recent: after }).success, true);
  assert.equal(scanLoginOutput("claude", { full: full + after, recent: "" }).success, false, "只看 recent 段");
  assert.equal(scanLoginOutput("claude", { full, recent: "OAuth error: Invalid code" }).failure, true);
  const token = `sk-ant-oat01-${"A".repeat(40)}_-x`;
  const st = scanLoginOutput("claude", { full: `${full}\r\nYour OAuth token (valid for 1 year):\r\n\r\n${token}\r\n`, variant: "setup-token" });
  assert.equal(st.token, token);
  assert.equal(st.success, true);
});

test("授权链接只认官方域名、https、无端口 / 账号、路径含 oauth 或 authorize", () => {
  assert.equal(isAllowedAuthUrl("codex", CODEX_URL), true);
  assert.equal(isAllowedAuthUrl("claude", CLAUDE_URL), true);
  assert.equal(isAllowedAuthUrl("claude", "https://console.anthropic.com/oauth/authorize?x=1"), true);
  for (const bad of [
    "http://auth.openai.com/oauth/authorize",
    "https://auth.openai.com.evil.com/oauth/authorize",
    "https://evil.com/?r=auth.openai.com/oauth/authorize",
    "https://user@auth.openai.com/oauth/authorize",
    "https://auth.openai.com:8443/oauth/authorize",
    "https://auth.openai.com/",
  ]) {
    assert.equal(isAllowedAuthUrl("codex", bad), false, bad);
  }
  assert.equal(isAllowedAuthUrl("codex", CLAUDE_URL), false, "Codex 不认 Claude 的域名");
  assert.equal(extractAuthUrl("codex", "visit https://evil.com/oauth/authorize now"), null);
  assert.equal(extractAuthUrl("codex", `(${CODEX_URL}).`), CODEX_URL, "去掉尾随标点");
});

test("脱敏与输出尾巴：key、Bearer、链接参数、显式秘密都隐藏；哨兵行去掉", () => {
  const text = "using sk-proj-ABCDEFGHIJKL and Authorization: Bearer abcdefghijkl\nopen https://x.com/a?code=SECRET#frag\nmycode#123";
  const out = redactSecrets(text, ["mycode#123"]);
  assert.doesNotMatch(out, /ABCDEFGHIJKL|abcdefghijkl|SECRET|mycode#123/);
  assert.match(out, /https:\/\/x\.com\/a\?\[参数已隐藏\]/);
  const tail = outputTail("__CWB_PID__=1\r\nline1\r\n\x1b[31mline2 sk-ABCDEFGHIJ\x1b[0m\r\n", { maxChars: 1000 });
  assert.equal(tail, "line1\nline2 sk-[已隐藏]");
  assert.match(outputTail("x".repeat(50), { maxChars: 10 }), /^…x{10}$/);
});

test("登录状态解析：codex login status / claude auth status --json", () => {
  assert.deepEqual(parseCodexLoginStatus("Logged in using ChatGPT\n__CWB_EXIT__=0"), { loggedIn: true, login: "chatgpt", detail: "ChatGPT 账号" });
  assert.equal(parseCodexLoginStatus("Logged in using an API key - sk-xxx***abcd").login, "apikey");
  assert.equal(parseCodexLoginStatus("Not logged in\n").loggedIn, false);
  assert.equal(parseCodexLoginStatus("bash: codex: not found").loggedIn, null);
  const json = '{\n  "loggedIn": true,\n  "authMethod": "claude.ai",\n  "apiProvider": "firstParty",\n  "email": "a@b.c"\n}\n__CWB_EXIT__=0';
  assert.deepEqual(parseClaudeAuthStatus(json), { loggedIn: true, login: "subscription", detail: "Claude 账号" });
  // 真机（2.1.292）：settings.json 里是 ANTHROPIC_AUTH_TOKEN（中转站）或 CLAUDE_CODE_OAUTH_TOKEN 时报 oauth_token。
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"oauth_token"}').detail, "令牌（中转站令牌或长期令牌）");
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"bedrock"}').detail, "bedrock", "不认识的原样");
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"api_key"}').login, "api");
  assert.equal(parseClaudeAuthStatus('{"loggedIn":false}').login, "none");
  assert.equal(parseClaudeAuthStatus("not json").loggedIn, null);
});

test("输入校验：授权码、provider id、env_key 名", () => {
  assert.equal(normalizeAuthCode("  abc_DEF-123#state.xyz  "), "abc_DEF-123#state.xyz");
  assert.equal(normalizeAuthCode("has space"), null);
  assert.equal(normalizeAuthCode("x\ny"), null);
  assert.equal(normalizeProviderId(""), "relay");
  assert.equal(normalizeProviderId("My-Relay"), "my-relay");
  assert.equal(normalizeProviderId("openai"), null);
  assert.equal(normalizeProviderId("1abc"), null);
  assert.equal(normalizeProviderId("a b"), null);
  assert.equal(providerEnvKey("my-relay"), "CWB_MY_RELAY_API_KEY");
  assert.throws(() => renderKeyFile("CWB_X", "short"));
  assert.throws(() => renderKeyFile("bad name", "sk-1234567890"));
});

// ---------------------------------------------------------------------------
// codex config.toml
// ---------------------------------------------------------------------------

const PROVIDER = { id: "relay", name: "我的中转", baseUrl: "https://relay.example.com:9443/v1", envKey: "CWB_RELAY_API_KEY" };

test("config.toml：空文件 → 顶层 model_provider + provider 表", () => {
  const { text, changed } = upsertCodexProvider("", PROVIDER);
  assert.equal(changed, true);
  assert.equal(text, [
    'model_provider = "relay"',
    "",
    "[model_providers.relay]",
    `${MANAGED_PROVIDER_MARK}（key 在 ~/.config/cluster-workbench/keys/codex-relay.env）`,
    'name = "我的中转"',
    'base_url = "https://relay.example.com:9443/v1"',
    'env_key = "CWB_RELAY_API_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
});

test("config.toml：保留原有顶层键、注释、其它表与顺序；已有 model_provider 被替换；重复执行幂等", () => {
  const original = [
    "# 我的配置",
    'model = "gpt-5"',
    'model_provider = "openai"  # 旧的',
    "",
    "[profiles.fast]",
    'model = "o4-mini"',
    "",
    "[mcp_servers.x]",
    'command = "x"',
    "",
  ].join("\n");
  const first = upsertCodexProvider(original, PROVIDER);
  const lines = first.text.split("\n");
  assert.equal(lines[0], "# 我的配置");
  assert.equal(lines[2], 'model_provider = "relay"');
  assert.ok(first.text.includes('[profiles.fast]\nmodel = "o4-mini"\n\n[mcp_servers.x]\ncommand = "x"\n\n[model_providers.relay]\n'));
  const second = upsertCodexProvider(first.text, PROVIDER);
  assert.equal(second.text, first.text);
  assert.equal(second.changed, false);
  // 换地址：只替换我们那一节，后面的表照旧
  const withTail = `${first.text}\n[tools]\nweb_search = true\n`;
  const updated = upsertCodexProvider(withTail, { ...PROVIDER, baseUrl: "https://relay2.example.com/v1" });
  assert.ok(updated.text.includes('base_url = "https://relay2.example.com/v1"\nenv_key = "CWB_RELAY_API_KEY"\nwire_api = "responses"\n\n[tools]\nweb_search = true\n'));
  assert.equal((updated.text.match(/\[model_providers\.relay\]/g) || []).length, 1);
});

test("config.toml：顶层没有键、第一行就是表 → model_provider 插到最前；CRLF 保持", () => {
  const { text } = upsertCodexProvider("[profiles.a]\r\nx = 1\r\n", PROVIDER);
  assert.ok(text.startsWith('model_provider = "relay"\r\n\r\n[profiles.a]\r\nx = 1\r\n\r\n[model_providers.relay]\r\n'));
  assert.doesNotMatch(text.replaceAll("\r\n", ""), /\n/, "全文都是 CRLF");
});

test("config.toml：用户手写的同名 provider 不覆盖；点号键 / 内联表写法拒绝", () => {
  assert.deepEqual(upsertCodexProvider('[model_providers.relay]\nbase_url = "x"\n', PROVIDER), { skipped: "id-taken" });
  assert.deepEqual(upsertCodexProvider('model_providers.relay.base_url = "x"\n', PROVIDER), { skipped: "unsupported-layout" });
  assert.deepEqual(upsertCodexProvider('[model_providers]\nrelay = { base_url = "x" }\n', PROVIDER), { skipped: "unsupported-layout" });
  assert.deepEqual(upsertCodexProvider('[model_providers.relay.http_headers]\nx = "y"\n', PROVIDER), { skipped: "unsupported-layout" });
  // 别的 provider 不受影响
  assert.ok(upsertCodexProvider('[model_providers]\nother = { base_url = "x" }\n', PROVIDER).text);
});

test("改回官方：只删指向我们写的 provider 的顶层 model_provider，表保留；用户自己的不动", () => {
  const ours = upsertCodexProvider('model = "gpt-5"\n', PROVIDER).text;
  const cleared = clearManagedDefaultProvider(ours);
  assert.equal(cleared.changed, true);
  assert.equal(cleared.providerId, "relay");
  assert.doesNotMatch(cleared.text, /^model_provider/m);
  assert.match(cleared.text, /\[model_providers\.relay\]/);
  assert.equal(clearManagedDefaultProvider('model_provider = "mine"\n[model_providers.mine]\nbase_url="x"\n').changed, false);
  assert.equal(clearManagedDefaultProvider('model = "x"\n').changed, false);
});

// ---------------------------------------------------------------------------
// Claude settings.json
// ---------------------------------------------------------------------------

const SETTINGS = '{\n    "hooks": { "Stop": [] },\n    "env": {\n        "HTTPS_PROXY": "http://127.0.0.1:7892",\n        "NO_PROXY": "localhost,127.0.0.1,::1",\n        "ANTHROPIC_API_KEY": "old"\n    }\n}\n';

test("Claude API：官方写 ANTHROPIC_API_KEY 并去掉中转站键；中转站写 BASE_URL + AUTH_TOKEN 并去掉 API_KEY；缩进沿用", () => {
  const official = planClaudeApiSettings(SETTINGS, { port: 7892, mode: "api", apiKey: "sk-ant-api-NEW" });
  assert.equal(official.action, "write");
  assert.deepEqual(JSON.parse(official.text).env.ANTHROPIC_API_KEY, "sk-ant-api-NEW");
  assert.match(official.text, /^ {4}"hooks"/m, "4 空格缩进保留");
  const relay = planClaudeApiSettings(SETTINGS, { port: 7892, mode: "relay", apiKey: "tok-123456789", baseUrl: "https://r.example.com" });
  const env = JSON.parse(relay.text).env;
  assert.equal(env.ANTHROPIC_BASE_URL, "https://r.example.com");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "tok-123456789");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7892", "代理键不动");
  assert.deepEqual(JSON.parse(relay.text).hooks, { Stop: [] });
  // 已是目标值 → unchanged
  assert.equal(planClaudeApiSettings(relay.text, { port: 7892, mode: "relay", apiKey: "tok-123456789", baseUrl: "https://r.example.com" }).action, "unchanged");
});

test("Claude API：内网中转站把 NO_PROXY 一并更新（只改我们写的那种）；reclaude 接管与非法 JSON 拒绝", () => {
  const plan = planClaudeApiSettings(SETTINGS, { port: 7892, mode: "relay", apiKey: "tok-123456789", baseUrl: "http://10.0.0.5:8080", noProxyExtra: ["10.0.0.5"] });
  assert.equal(JSON.parse(plan.text).env.NO_PROXY, "localhost,127.0.0.1,::1,10.0.0.5");
  const userNoProxy = SETTINGS.replace('"localhost,127.0.0.1,::1"', '"corp.local"');
  assert.equal(JSON.parse(planClaudeApiSettings(userNoProxy, { port: 7892, mode: "api", apiKey: "sk-x-12345678", noProxyExtra: ["10.0.0.5"] }).text).env.NO_PROXY, "corp.local");
  const reclaude = '{"env":{"HTTPS_PROXY":"http://127.0.0.1:40161","NODE_EXTRA_CA_CERTS":"/home/kai/.reclaude/ca.pem"}}';
  const refused = planClaudeApiSettings(reclaude, { port: 7891, mode: "api", apiKey: "sk-x-12345678" });
  assert.equal(refused.error.code, "reclaude-managed");
  assert.match(refused.error.message, /reclaude/);
  assert.equal(planClaudeApiSettings("{ not json", { port: 7892, mode: "api", apiKey: "sk-x-12345678" }).error.code, "invalid-json");
  assert.equal(planClaudeApiSettings("", { port: 7892, mode: "api", apiKey: "sk-x-12345678" }).action, "write", "文件不存在 / 空 → 新建");
});

// ---------------------------------------------------------------------------
// 中转站判定
// ---------------------------------------------------------------------------

test("中转站地址：443 零配置 / 非 443 加白名单 / 内网直连 / http 明文提示 / 非法", () => {
  assert.equal(describeRelay("https://relay.example.com/v1").action, "none");
  const allow = describeRelay("https://relay.example.com:9443/v1");
  assert.equal(allow.action, "allowlist");
  assert.equal(allow.entry, "relay.example.com:9443");
  const direct = describeRelay("http://10.0.0.5:8080/v1");
  assert.equal(direct.action, "direct-candidate");
  assert.deepEqual(direct.warnings, ["plaintext-http"]);
  assert.ok(direct.notes.some((n) => /明文/.test(n)));
  assert.ok(direct.notes.some((n) => /NO_PROXY/.test(n)));
  const bad = describeRelay("ftp://x");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /http/);
});
