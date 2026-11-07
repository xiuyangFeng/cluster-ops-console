import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyInstallKind, cliIdForAgentKind, compareVersions, getCli, isCliId, parseVersionText } from "./catalog.mjs";
import { LOGIN_CLIS } from "./login-flows.mjs";
import {
  buildCliRemoteCommand,
  buildCliScanInvocation,
  buildCliState,
  buildOffPathLocateCommand,
  CLI_PROBE_SCRIPT_PATH,
  classifyClaudeLogin,
  classifyCodexLogin,
  normalizeOffPath,
  offPathDirGlobs,
  parseCliProbeOutput,
  parseCliScan,
  parseEndpointField,
} from "./detect.mjs";

// ---------------------------------------------------------------------------
// 目录（catalog）
// ---------------------------------------------------------------------------

test("catalog: 版本解析覆盖两种 --version 输出，平台包名与安装形态", () => {
  assert.equal(parseVersionText("codex-cli 0.159.2"), "0.159.2");
  assert.equal(parseVersionText("2.1.292 (Claude Code)"), "2.1.292");
  assert.equal(parseVersionText("codex-cli 0.160.0-alpha.3\n"), "0.160.0-alpha.3");
  assert.equal(parseVersionText(""), null);
  assert.equal(parseVersionText("command not found"), null);
  assert.deepEqual(getCli("codex").linuxPackage("0.160.1"), { name: "@openai/codex", version: "0.160.1-linux-x64" });
  assert.deepEqual(getCli("claude").linuxPackage("2.1.291"), { name: "@anthropic-ai/claude-code-linux-x64", version: "2.1.291" });
  assert.equal(getCli("reclaude"), null);
  assert.equal(getCli("__proto__"), null);
  assert.equal(cliIdForAgentKind("codex"), "codex");
  assert.equal(cliIdForAgentKind("claude-code"), "claude");
  assert.equal(cliIdForAgentKind("reclaude"), null);
  assert.equal(isCliId("codex"), true);
  assert.equal(isCliId("claude"), true);
  assert.equal(isCliId("__proto__"), false);
  assert.equal(isCliId(undefined), false);
  // 登录表的 id / 界面名来自目录（不另立一份事实），登录方式留在 login-flows。
  assert.deepEqual(Object.keys(LOGIN_CLIS), ["codex", "claude"]);
  assert.equal(LOGIN_CLIS.claude.label, getCli("claude").label);
  assert.ok(LOGIN_CLIS.claude.methods.includes("setup-token"));

  const home = "/public/newhome/cy";
  assert.equal(classifyInstallKind("codex", `${home}/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex`), "standalone");
  assert.equal(classifyInstallKind("claude", `${home}/.local/share/claude/versions/2.1.292`), "native");
  assert.equal(classifyInstallKind("codex", `${home}/.local/lib/node_modules/@openai/codex/bin/codex.js`), "npm");
  assert.equal(classifyInstallKind("codex", `${home}/.local/share/codex-cli/0.144.1/vendor/x86_64-unknown-linux-musl/bin/codex`), "unknown");
  assert.equal(classifyInstallKind("claude", null), null);
});

test("catalog: compareVersions 数字逐段比较，预发布低于正式版", () => {
  assert.equal(compareVersions("0.159.2", "0.160.1"), -1);
  assert.equal(compareVersions("0.160.1", "0.160.1"), 0);
  assert.equal(compareVersions("2.1.292", "2.1.291"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1, "按数字而不是字典序");
  assert.equal(compareVersions("0.160.0-alpha.3", "0.160.0"), -1);
  assert.equal(compareVersions("x", "0.1.0"), null);
});

// ---------------------------------------------------------------------------
// 调用组装与解析
// ---------------------------------------------------------------------------

test("buildCliRemoteCommand: 只放行目录里的 id 与合法端口", () => {
  assert.equal(buildCliRemoteCommand(), "env CT_CLI_IDS='codex,claude' CT_ENDPOINT_PORT='' sh -s");
  assert.equal(buildCliRemoteCommand({ ids: ["claude"], endpointPort: 7891 }), "env CT_CLI_IDS='claude' CT_ENDPOINT_PORT='7891' sh -s");
  assert.equal(buildCliRemoteCommand({ ids: ["x;rm -rf ~"], endpointPort: "1;id" }), "env CT_CLI_IDS='codex,claude' CT_ENDPOINT_PORT='' sh -s");
  const inv = buildCliScanInvocation({ server: { host: "myserver" }, script: "echo hi" });
  assert.equal(inv.file, "ssh");
  assert.equal(inv.input, "echo hi");
  assert.equal(inv.args.at(-1), "env CT_CLI_IDS='codex,claude' CT_ENDPOINT_PORT='' sh -s");
});

test("parseCliProbeOutput: 没有开始标记 = SSH 没到远端；截断时 complete=false", () => {
  assert.equal(parseCliProbeOutput("ssh: connect to host myserver port 22: Connection refused"), null);
  const partial = parseCliProbeOutput("motd\n__CLI_BEGIN__\nuser=kai\ncodex.installed=1\nbad line\n=x\n");
  assert.deepEqual(partial, { fields: { user: "kai", "codex.installed": "1" }, complete: false });
  assert.equal(parseCliProbeOutput("__CLI_BEGIN__\n__CLI_END__\n").complete, true);
});

test("登录归类 codex：自定义 provider 优先（kai 现状），其次 auth.json 的类型", () => {
  // cy：config.toml model_provider=cpa，没有 auth.json
  assert.deepEqual(classifyCodexLogin({
    "codex.authFile": "0", "codex.provider": "cpa",
    "codex.providerBaseUrl": "https://api.relay-demo.example:9443", "codex.providerEnvKey": "CPA_API_KEY",
  }), { login: "apikey", loginDetail: "中转站 cpa · api.relay-demo.example:9443 · 密钥变量 CPA_API_KEY" });
  assert.deepEqual(classifyCodexLogin({ "codex.authFile": "1", "codex.authTokens": "1", "codex.authApiKey": "0", "codex.authMode": "chatgpt" }),
    { login: "chatgpt", loginDetail: "ChatGPT 账号" });
  assert.deepEqual(classifyCodexLogin({ "codex.authFile": "1", "codex.authTokens": "0", "codex.authApiKey": "1" }),
    { login: "apikey", loginDetail: "官方 API key" });
  assert.deepEqual(classifyCodexLogin({ "codex.authFile": "1", "codex.authTokens": "1", "codex.authApiKey": "1", "codex.authMode": "apikey" }),
    { login: "apikey", loginDetail: "官方 API key" });
  assert.deepEqual(classifyCodexLogin({ "codex.provider": "openai", "codex.authFile": "0" }), { login: "none", loginDetail: null });
  assert.equal(classifyCodexLogin({ "codex.authFile": "0", "codex.credStore": "keyring" }).login, "unknown");
});

test("登录归类 Claude：环境变量 API 凭证 > apiKeyHelper > 长期令牌 > 订阅 OAuth > Console key", () => {
  // cy：订阅 OAuth（Max）+ settings.json 被 reclaude 接管
  assert.deepEqual(classifyClaudeLogin({ "claude.oauth": "1", "claude.subscription": "max", "claude.reclaude": "1", "claude.settingsEnv": "" }),
    { login: "subscription", loginDetail: "Max 订阅 · 经 ReClaude 代理" });
  assert.deepEqual(classifyClaudeLogin({ "claude.oauth": "1", "claude.settingsEnv": "ANTHROPIC_AUTH_TOKEN,ANTHROPIC_BASE_URL", "claude.baseUrl": "https://relay.example.com:8443" }),
    { login: "api", loginDetail: "中转站 relay.example.com:8443" });
  assert.deepEqual(classifyClaudeLogin({ "keys.env": "ANTHROPIC_API_KEY" }), { login: "api", loginDetail: "官方 API key" });
  assert.deepEqual(classifyClaudeLogin({ "claude.settingsEnv": "ANTHROPIC_API_KEY", "claude.baseUrl": "https://api.anthropic.com" }),
    { login: "api", loginDetail: "官方 API key" });
  assert.equal(classifyClaudeLogin({ "claude.apiKeyHelper": "1", "claude.oauth": "1" }).loginDetail, "apiKeyHelper 脚本");
  assert.deepEqual(classifyClaudeLogin({ "keys.env": "CLAUDE_CODE_OAUTH_TOKEN,OTHER" }), { login: "subscription", loginDetail: "长期令牌（setup-token）" });
  assert.deepEqual(classifyClaudeLogin({ "claude.oauth": "1", "claude.subscription": "" }), { login: "subscription", loginDetail: "订阅账号" });
  assert.deepEqual(classifyClaudeLogin({ "claude.primaryApiKey": "1" }), { login: "api", loginDetail: "Console API key" });
  assert.deepEqual(classifyClaudeLogin({}), { login: "none", loginDetail: null });
});

test("buildCliState: 契约字段齐全；未安装时版本/形态/路径为空；没探测到的 CLI 为 null", () => {
  const state = buildCliState("codex", {
    "codex.installed": "1",
    "codex.path": "/h/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex",
    "codex.version": "codex-cli 0.159.2",
    "codex.npmGlobal": "0",
    "codex.authFile": "1", "codex.authTokens": "1",
  });
  assert.deepEqual(state, {
    installed: true, version: "0.159.2", kind: "standalone",
    path: "/h/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex",
    login: "chatgpt", loginDetail: "ChatGPT 账号", npmGlobal: false,
  });
  assert.deepEqual(buildCliState("claude", { "claude.installed": "0" }), {
    installed: false, version: null, kind: null, path: null, login: "none", loginDetail: null, npmGlobal: false, managedBy: null,
  });
  assert.equal(buildCliState("claude", { "codex.installed": "1" }), null);
});

test("parseEndpointField: 401 也算到达；无效行不算", () => {
  assert.deepEqual(parseEndpointField("401 0.532"), { httpCode: 401, latencyMs: 532, ok: true });
  assert.deepEqual(parseEndpointField("000 10.001"), { httpCode: 0, latencyMs: 10001, ok: false });
  assert.deepEqual(parseEndpointField(""), { httpCode: 0, latencyMs: null, ok: false });
  assert.equal(parseEndpointField(undefined), null);
});

// ---------------------------------------------------------------------------
// 远端脚本真跑：假 HOME 里摆出与 myserver 同样的官方布局（2026-10-07 只读核实）
// ---------------------------------------------------------------------------

function writeExec(file, body) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function makeFakeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "cli-probe-"));
  const counter = path.join(home, "version-calls");
  const codexRelease = path.join(home, ".codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex");
  writeExec(codexRelease, `echo codex >> "${counter}"; echo "codex-cli 0.159.2"`);
  symlinkSync(path.join(home, ".codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl"), path.join(home, ".codex/packages/standalone/current"));
  mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  symlinkSync(path.join(home, ".codex/packages/standalone/current/bin/codex"), path.join(home, ".local/bin/codex"));
  const claudeVersion = path.join(home, ".local/share/claude/versions/2.1.292");
  writeExec(claudeVersion, `echo claude >> "${counter}"; echo "2.1.292 (Claude Code)"`);
  symlinkSync(claudeVersion, path.join(home, ".local/bin/claude"));
  // codex：kai 的 config.toml 形状（自定义 provider，无 auth.json）；provider 段里放一个不该被读出的令牌。
  writeFileSync(path.join(home, ".codex/config.toml"), [
    'model = "gpt-5"',
    'model_provider = "cpa"  # 中转',
    "",
    "[model_providers.cpa]",
    'name = "cpa"',
    'base_url = "https://user:pw@api.relay-demo.example:9443/v1?token=SECRET-IN-URL"',
    'env_key = "CPA_API_KEY"',
    'experimental_bearer_token = "SECRET-BEARER"',
    "",
    '[projects."/x"]',
    'trust_level = "trusted"',
  ].join("\n"));
  // Claude：订阅 OAuth（Max）+ settings.json 被 reclaude 接管（env 指向 ~/.reclaude/ca.pem）。
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  writeFileSync(path.join(home, ".claude/.credentials.json"), JSON.stringify({
    claudeAiOauth: { accessToken: "SECRET-ACCESS", refreshToken: "SECRET-REFRESH", expiresAt: 1, scopes: [], subscriptionType: "max" },
  }));
  writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({
    env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: `${home}/.reclaude/ca.pem` },
    hooks: {},
  }, null, 2));
  writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "u" } }));
  mkdirSync(path.join(home, ".config/cluster-workbench/keys"), { recursive: true });
  writeFileSync(path.join(home, ".config/cluster-workbench/keys/relay.env"), "export CPA_API_KEY='SECRET-KEY'\n");
  return { home, counter };
}

// 假 timeout（macOS 没有 coreutils timeout）：保证 `$ct_to "$ct_cmd"` 这条路径在任何平台都被走到——
// 曾因循环里把 IFS 改成逗号，"timeout 20" 拆不开，集群上版本恒为空。
function runProbe(home, env = {}) {
  const sysbin = path.join(home, ".test-sysbin");
  writeExec(path.join(sysbin, "timeout"), 'shift; exec "$@"');
  return spawnSync("/bin/sh", ["-s"], {
    input: readFileSync(CLI_PROBE_SCRIPT_PATH, "utf8"),
    encoding: "utf8",
    env: { PATH: `${sysbin}:/usr/bin:/bin`, HOME: home, ...env },
    timeout: 20000,
  });
}

test("cli-probe.sh 真跑：识别官方布局与登录方式，绝不回显密钥；版本按真实路径+mtime 缓存", { skip: process.platform === "win32" }, () => {
  const { home, counter } = makeFakeHome();
  try {
    const first = runProbe(home);
    assert.equal(first.status, 0, first.stderr);
    for (const secret of ["SECRET", "user:pw", "token="]) {
      assert.ok(!first.stdout.includes(secret), `输出不得含 ${secret}`);
    }
    const scan = parseCliScan(first.stdout);
    assert.equal(scan.complete, true);
    assert.equal(scan.endpoint, null, "没给端口不做连通性检查");
    assert.deepEqual({ ...scan.clis.codex, path: path.basename(path.dirname(path.dirname(scan.clis.codex.path))) }, {
      installed: true, version: "0.159.2", kind: "standalone", path: "0.159.2-x86_64-unknown-linux-musl",
      login: "apikey", loginDetail: "中转站 cpa · api.relay-demo.example:9443 · 密钥变量 CPA_API_KEY", npmGlobal: false,
    });
    assert.equal(scan.clis.claude.version, "2.1.292");
    assert.equal(scan.clis.claude.kind, "native");
    assert.equal(scan.clis.claude.login, "subscription");
    assert.equal(scan.clis.claude.loginDetail, "Max 订阅 · 经 ReClaude 代理");
    assert.equal(scan.clis.claude.managedBy, "reclaude");
    assert.equal(readFileSync(counter, "utf8"), "codex\nclaude\n", "首轮各执行一次 --version");

    // 第二轮：真实路径与 mtime 没变 → 走缓存，不再执行 --version
    const second = parseCliScan(runProbe(home).stdout);
    assert.equal(second.clis.claude.version, "2.1.292");
    assert.equal(readFileSync(counter, "utf8"), "codex\nclaude\n");
    const cache = readFileSync(path.join(home, ".cache/cluster-workbench/versions"), "utf8");
    assert.equal(cache.trim().split("\n").length, 2);

    // Claude 自更新换了版本文件（软链指向新文件）→ 真实路径变了，重新执行一次
    const next = path.join(home, ".local/share/claude/versions/2.1.293");
    writeExec(next, `echo claude >> "${counter}"; echo "2.1.293 (Claude Code)"`);
    rmSync(path.join(home, ".local/bin/claude"));
    symlinkSync(next, path.join(home, ".local/bin/claude"));
    const third = parseCliScan(runProbe(home, { CT_CLI_IDS: "claude" }).stdout);
    assert.equal(third.clis.claude.version, "2.1.293");
    assert.equal(third.clis.codex, undefined, "只探测请求的 CLI");
    // 同一路径被原地覆盖（mtime 变）→ 同样重新执行
    utimesSync(next, new Date(), new Date(Date.now() + 5000));
    parseCliScan(runProbe(home, { CT_CLI_IDS: "claude" }).stdout);
    assert.equal(readFileSync(counter, "utf8"), "codex\nclaude\nclaude\nclaude\n");
    const cacheAfter = readFileSync(path.join(home, ".cache/cluster-workbench/versions"), "utf8").trim().split("\n");
    assert.equal(cacheAfter.length, 2, "每个 CLI 只留一行");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli-probe.sh 真跑：空账号（simple）两个都未安装、未登录；非法参数回落默认", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "cli-probe-empty-"));
  try {
    const res = runProbe(home, { CT_CLI_IDS: "codex;id", CT_ENDPOINT_PORT: "1;id" });
    assert.equal(res.status, 0, res.stderr);
    const scan = parseCliScan(res.stdout);
    assert.deepEqual(scan.clis.codex, { installed: false, version: null, kind: null, path: null, login: "none", loginDetail: null, npmGlobal: false });
    assert.deepEqual(scan.clis.claude, { installed: false, version: null, kind: null, path: null, login: "none", loginDetail: null, npmGlobal: false, managedBy: null });
    assert.equal(scan.endpoint, null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 装了，但非交互 SSH 的 PATH 里找不到（v2.57 评审后续）
// ---------------------------------------------------------------------------

test("offPathDirGlobs：清单只有远端脚本里那一份，本机直接读；任何一行不合规整份作废", () => {
  const globs = offPathDirGlobs();
  assert.ok(globs.length >= 8, `清单读出 ${globs.length} 项`);
  for (const want of [".nvm/versions/node/*/bin", ".npm-global/bin", ".claude/local"]) assert.ok(globs.includes(want), `缺 ${want}`);
  assert.ok(!globs.includes(".local/bin"), "~/.local/bin 探测时已在 PATH 里，不属于「找不到」的位置");
  const wrap = (lines) => `x\n# __CT_OFF_PATH_DIRS_BEGIN__\nct_off_path_dirs='\n${lines.join("\n")}\n'\n# __CT_OFF_PATH_DIRS_END__\ny\n`;
  assert.deepEqual(offPathDirGlobs(wrap([".nvm/versions/node/*/bin", "bin"])), [".nvm/versions/node/*/bin", "bin"]);
  for (const bad of ["a b", "$(id)", "x;y", "../etc", "a/../b", "/usr/bin", "a'b", "`id`", "a|b"]) {
    assert.deepEqual(offPathDirGlobs(wrap(["bin", bad])), [], `不合规的一行 ${JSON.stringify(bad)} → 整份作废`);
  }
  assert.deepEqual(offPathDirGlobs("没有标记的脚本"), []);
});

test("buildOffPathLocateCommand：只接受规矩的命令名；清单读不出来返回 null；normalizeOffPath 只认 ~/ 开头的可见字符", () => {
  const cmd = buildOffPathLocateCommand("codex");
  assert.match(cmd, /^sh -c '/);
  assert.ok(!cmd.slice(7, -1).includes("'"), "片段内没有单引号（整段包在单引号里）");
  for (const glob of offPathDirGlobs()) assert.ok(cmd.includes(` ${glob}`), `命令里有 ${glob}`);
  assert.equal(buildOffPathLocateCommand("codex", { globs: [] }), null);
  for (const bad of ["co dex", "codex;id", "../x", "", "$(id)"]) assert.throws(() => buildOffPathLocateCommand(bad), /unsafe cli name/);
  assert.equal(normalizeOffPath("~/.nvm/versions/node/v22.11.0/bin/codex"), "~/.nvm/versions/node/v22.11.0/bin/codex");
  assert.equal(normalizeOffPath("  ~/bin/codex \n"), "~/bin/codex");
  for (const bad of ["/abs/codex", "", null, "~/a\u0007b", `~/${"x".repeat(300)}`]) assert.equal(normalizeOffPath(bad), null);
});

test("buildCliState：offPath 只在未安装且远端确实找到时出现；已安装时不认", () => {
  assert.equal(buildCliState("codex", { "codex.installed": "0", "codex.offPath": "~/.nvm/versions/node/v22.11.0/bin/codex" }).offPath, "~/.nvm/versions/node/v22.11.0/bin/codex");
  assert.ok(!("offPath" in buildCliState("codex", { "codex.installed": "0" })));
  assert.ok(!("offPath" in buildCliState("codex", { "codex.installed": "0", "codex.offPath": "/etc/passwd" })));
  assert.ok(!("offPath" in buildCliState("codex", { "codex.installed": "1", "codex.path": "/h/.local/bin/codex", "codex.offPath": "~/bin/codex" })));
});

// 假 HOME：codex 装在两个 nvm 版本里，claude 是旧的「本地安装」（~/.claude/local，交互 shell 里靠 alias）。
// 另放几样不该被认的：没有执行权限的同名文件、同名目录。
function makeOffPathHome() {
  const home = mkdtempSync(path.join(tmpdir(), "cli-offpath-"));
  writeExec(path.join(home, ".nvm/versions/node/v18.20.4/bin/codex"), 'echo "codex-cli 0.150.0"');
  writeExec(path.join(home, ".nvm/versions/node/v22.11.0/bin/codex"), 'echo "codex-cli 0.159.2"');
  writeExec(path.join(home, ".claude/local/claude"), 'echo "2.1.292 (Claude Code)"');
  mkdirSync(path.join(home, ".yarn/bin"), { recursive: true });
  writeFileSync(path.join(home, ".yarn/bin/claude"), "not executable\n", { mode: 0o644 });
  mkdirSync(path.join(home, "bin/claude"), { recursive: true });
  return home;
}

// 本机拼给 codex doctor 探针的那条命令，在指定 shell 里真跑（远端登录 shell 可能是 bash / zsh / sh）。
function runLocate(shell, home, name) {
  return spawnSync(shell, ["-c", buildOffPathLocateCommand(name)], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: home }, timeout: 20000 });
}

test("cli-probe.sh 真跑：装在 nvm / ~/.claude/local 里、PATH 里找不到 → installed 仍为假，但带 offPath（不是「未安装」）", { skip: process.platform === "win32" }, () => {
  const home = makeOffPathHome();
  try {
    const res = runProbe(home);
    assert.equal(res.status, 0, res.stderr);
    const scan = parseCliScan(res.stdout);
    assert.equal(scan.complete, true);
    assert.deepEqual(scan.clis.codex, {
      installed: false, version: null, kind: null, path: null, login: "none", loginDetail: null, npmGlobal: false,
      offPath: "~/.nvm/versions/node/v18.20.4/bin/codex",
    });
    assert.equal(scan.clis.claude.installed, false);
    assert.equal(scan.clis.claude.offPath, "~/.claude/local/claude", "没有执行权限的同名文件、同名目录都不算");
    assert.ok(!res.stdout.includes("0.159.2") && !res.stdout.includes("0.150.0"), "找到的文件不执行（不跑它的 --version）");

    // 同一份清单、同一算法：本机给 doctor 探针拼的命令在各种登录 shell 里跑出的结论与脚本逐字相同
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((file) => existsSync(file))) {
      const codex = runLocate(shell, home, "codex");
      assert.equal(codex.status, 0, `${shell}: ${codex.stderr}`);
      assert.equal(codex.stdout, "~/.nvm/versions/node/v18.20.4/bin/codex\n", shell);
      assert.equal(runLocate(shell, home, "claude").stdout, "~/.claude/local/claude\n", shell);
    }

    // 装进 ~/.local/bin 之后（工作台的安装就是装到这里）：探测以 PATH 里的为准，不再报 offPath
    writeExec(path.join(home, ".local/bin/codex"), 'echo "codex-cli 0.160.1"');
    const after = parseCliScan(runProbe(home).stdout).clis.codex;
    assert.equal(after.installed, true);
    assert.equal(after.version, "0.160.1");
    assert.ok(!("offPath" in after));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("定位命令真跑：真没装时什么都不输出（含 zsh——没匹配到的 glob 不报错）；HOME 不存在也安静退出", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "cli-offpath-empty-"));
  try {
    for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((file) => existsSync(file))) {
      const empty = runLocate(shell, home, "codex");
      assert.deepEqual([empty.status, empty.stdout, empty.stderr], [0, "", ""], shell);
      const gone = runLocate(shell, path.join(home, "nope"), "codex");
      assert.deepEqual([gone.status, gone.stdout], [0, ""], shell);
    }
    // 带空格的家目录：路径照样找得到
    const spaced = path.join(home, "my home");
    writeExec(path.join(spaced, ".npm-global/bin/codex"), "true");
    assert.equal(runLocate("/bin/sh", spaced, "codex").stdout, "~/.npm-global/bin/codex\n");
    assert.equal(parseCliScan(runProbe(spaced).stdout).clis.codex.offPath, "~/.npm-global/bin/codex");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
