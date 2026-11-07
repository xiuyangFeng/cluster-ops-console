// 集群侧受管配置（cluster-env.mjs）：纯函数断言 + 在临时 HOME 里用真实 bash / sh 执行生成的远端命令，
// 再按 bash -i / bash -lc / 非交互 source 三种方式起 shell 看实际生效的变量。只碰 os.tmpdir()，
// 不 ssh、不碰真实 HOME。样本按 kai 账号 2026-10-07 只读核实的文件结构复刻，不含任何密钥。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildClusterEnvSteps,
  buildCommentOutCommand,
  buildLegacyToolProxyScanCommand,
  buildStrayScanCommand,
  buildUndoCommands,
  CLAUDE_SETTINGS_READ_COMMAND,
  claudeSettingsProxyEnv,
  clusterProxyUrl,
  groupStraysByFile,
  isReclaudeManagedClaudeEnv,
  mergeClaudeSettingsEnv,
  parseClaudeSettingsRead,
  parseLegacyToolProxies,
  parseStrayProxyExports,
  planClaudeSettingsMerge,
  removeClaudeSettingsEnv,
  renderClusterEnv,
  renderNoProxy,
  renderSourceBlock,
  STRAY_DISABLED_PREFIX,
  STRAY_SCAN_DONE,
  TOOL_PROXY_SCAN_DONE,
} from "./cluster-env.mjs";

const skip = process.platform === "win32";

// ---------------------------------------------------------------------------
// 样本
// ---------------------------------------------------------------------------

const CY_SLURM_PATH = 'export PATH="/public/newhome/kai/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin:/public/slurm/bin:/public/slurm/sbin"';

// kai 的 ~/.bashrc（161 行）：第 12–15 行"非交互即 return"守卫；第 144 行含 /public/slurm/bin 的 PATH（绝不能动）；
// 145–146 行 http 代理；148 行注释；149–154 行 socks5h:// 覆盖；155–160 行 reclaude PATH 标记块。
// 16–142 行（Ubuntu 默认内容 + conda init）用占位注释补齐，保证行号与真实文件一致。
function cyBashrc() {
  const lines = [
    "# ~/.bashrc: executed by bash(1) for non-login shells.",
    "# see /usr/share/doc/bash/examples/startup-files (in the package bash-doc)",
    "# for examples",
    "",
    'export PATH="$HOME/.local/bin:$PATH" # orca-nonlogin-path: 非交互 SSH(Orca relay)需要找到 node',
    "# Load the Codex CPA credential before the non-interactive shell guard.",
    'if [ -r "$HOME/.config/codex/cpa.env" ]; then',
    '  . "$HOME/.config/codex/cpa.env"',
    "fi",
    "",
    "# If not running interactively, don't do anything",
    "case $- in",
    "    *i*) ;;",
    "      *) return;;",
    "esac",
  ];
  while (lines.length < 140) lines.push(`# ubuntu default / conda init 占位第 ${lines.length + 1} 行`);
  lines.push(
    'export PATH="$HOME/.local/bin:$PATH"', // 141
    "", // 142
    "# Codex App SSH proxy", // 143
    CY_SLURM_PATH, // 144
    'export HTTP_PROXY="http://127.0.0.1:7891"', // 145
    'export HTTPS_PROXY="http://127.0.0.1:7891"', // 146
    "", // 147
    "# Codex SOCKS SSH proxy", // 148
    'export ALL_PROXY="socks5h://127.0.0.1:7891"', // 149
    'export all_proxy="socks5h://127.0.0.1:7891"',
    'export HTTP_PROXY="socks5h://127.0.0.1:7891"',
    'export HTTPS_PROXY="socks5h://127.0.0.1:7891"',
    'export http_proxy="socks5h://127.0.0.1:7891"',
    'export https_proxy="socks5h://127.0.0.1:7891"', // 154
    "# >>> reclaude PATH >>>", // 155
    'case ":$PATH:" in',
    '  *":$HOME/.local/bin:"*) ;;',
    '  *) export PATH="$HOME/.local/bin:$PATH" ;;',
    "esac",
    "# <<< reclaude PATH <<<", // 160
    "", // 161
  );
  assert.equal(lines.length, 161);
  assert.equal(lines[143], CY_SLURM_PATH);
  return `${lines.join("\n")}\n`;
}

// kai 的 ~/.bash_profile（不 source .bashrc）：第 6–7 行 http 代理。
const CY_BASH_PROFILE = [
  "",
  'export PATH="$HOME/.local/bin:$PATH"',
  "",
  "# Codex App SSH proxy",
  'export PATH="/public/newhome/kai/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"',
  'export HTTP_PROXY="http://127.0.0.1:7891"',
  'export HTTPS_PROXY="http://127.0.0.1:7891"',
  "",
  "# Codex CPA provider credential (stored separately with mode 0600)",
  '. "$HOME/.config/codex/cpa.env"',
  "",
].join("\n");

// Ubuntu 默认 ~/.profile 的要点：bash 时 source .bashrc。
const UBUNTU_PROFILE = [
  "# ~/.profile: executed by the command interpreter for login shells.",
  'if [ -n "$BASH_VERSION" ]; then',
  '    if [ -f "$HOME/.bashrc" ]; then',
  '\t. "$HOME/.bashrc"',
  "    fi",
  "fi",
  "",
].join("\n");

// P2 旧向导在 .bashrc 末尾追加的块（renderCodexProxyEnv 默认带交互守卫）。
const LEGACY_BLOCK = [
  "# >>> setup-wizard codex-proxy >>>",
  "[[ $- == *i* ]] || return 0",
  'export HTTP_PROXY="http://127.0.0.1:7999"',
  'export HTTPS_PROXY="http://127.0.0.1:7999"',
  'export http_proxy="http://127.0.0.1:7999"',
  'export https_proxy="http://127.0.0.1:7999"',
  'export NO_PROXY="localhost,127.0.0.1,::1"',
  "# <<< setup-wizard codex-proxy <<<",
  "",
].join("\n");

// kai 的 ~/.claude/settings.json 形状（键名与真实一致，值为占位；hooks 是一长串命令）：reclaude 接管。
function cySettings() {
  return {
    env: {
      HTTPS_PROXY: "http://127.0.0.1:40161",
      HTTP_PROXY: "http://127.0.0.1:40161",
      NODE_EXTRA_CA_CERTS: "/public/newhome/kai/.reclaude/ca.pem",
      NO_PROXY: "localhost,127.0.0.1,::1",
      http_proxy: "http://127.0.0.1:40161",
      https_proxy: "http://127.0.0.1:40161",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    model: "opus",
    hooks: longHooks(),
    enabledPlugins: { "example@market": true },
    effortLevel: "high",
    modelSettings: {},
    showThinkingSummaries: true,
    skipDangerousModePermissionPrompt: true,
    autoMode: {},
  };
}

function longHooks() {
  const command = `bash -c 'set -euo pipefail; ${"echo \"中文与 \\\"引号\\\" $HOME;\" ".repeat(400)}'`;
  return {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }],
    Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
  };
}

// ---------------------------------------------------------------------------
// 执行器：在临时 HOME 里跑远端命令 / 起 shell
// ---------------------------------------------------------------------------

function makeHome(t, { bashrc = cyBashrc(), bashProfile = CY_BASH_PROFILE, profile = UBUNTU_PROFILE } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (rel, text, mode = 0o644) => {
    if (text == null) return;
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), text);
    fs.chmodSync(path.join(home, rel), mode);
  };
  write(".bashrc", bashrc);
  write(".bash_profile", bashProfile);
  write(".profile", profile);
  write(".config/codex/cpa.env", "", 0o600);
  return home;
}

const BASE_ENV = (home) => ({ HOME: home, PATH: "/usr/bin:/bin", LC_ALL: "C" });

// 模拟 sshd：`<登录 shell> -c <命令串>`。outer 是对方的登录 shell；shDir 非空时放在 PATH 最前，
// 用来把命令串里的 `sh` 换成别的实现（如 dash——Ubuntu 集群上的 /bin/sh）。
function remote(home, command, input, { outer = "bash", shDir } = {}) {
  const env = BASE_ENV(home);
  if (shDir) env.PATH = `${shDir}:${env.PATH}`;
  const res = spawnSync(outer, ["-c", `umask 0002; ${command}`], { encoding: "utf8", input, env });
  assert.equal(res.status, 0, `远端命令失败（${outer}${shDir ? ` / ${shDir}` : ""}）: ${res.stderr}\n${command.slice(0, 300)}`);
  return res.stdout;
}

function applySteps(home, steps, via) {
  for (const step of steps) remote(home, step.command, undefined, via);
}

// 在指定方式起的 shell 里读变量；ALL_PROXY 未设置时打印 <unset>。
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell 的 ${VAR-默认值} 展开，不是 JS 模板
const PROBE = 'printf "%s|%s|%s|%s" "${HTTPS_PROXY-<unset>}" "${http_proxy-<unset>}" "${ALL_PROXY-<unset>}" "$PATH"';
function shellVars(home, mode, extraEnv = {}) {
  const args = { interactive: ["-ic", PROBE], login: ["-lc", PROBE], sourced: ["-c", `. "$HOME/.bashrc"; ${PROBE}`] }[mode];
  const res = spawnSync("bash", args, { encoding: "utf8", env: { ...BASE_ENV(home), ...extraEnv }, input: "", timeout: 15000 });
  const [https, http, all, pathValue] = res.stdout.split("|");
  return { https, http, all, path: pathValue };
}

const read = (home, rel) => fs.readFileSync(path.join(home, rel), "utf8");
const fileMode = (home, rel) => fs.statSync(path.join(home, rel)).mode & 0o777;
const count = (text, needle) => text.split(needle).length - 1;

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

test("renderClusterEnv: 大小写四个 http:// 代理变量 + NO_PROXY + unset ALL_PROXY，绝不出现 SOCKS", () => {
  const text = renderClusterEnv({ port: 7892 });
  for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"]) {
    assert.match(text, new RegExp(`^export ${name}="http://127\\.0\\.0\\.1:7892"$`, "m"));
  }
  assert.match(text, /^export no_proxy="localhost,127\.0\.0\.1,::1"$/m);
  assert.match(text, /^export NO_PROXY="localhost,127\.0\.0\.1,::1"$/m);
  assert.match(text, /^unset ALL_PROXY all_proxy$/m);
  assert.doesNotMatch(text, /socks5h?:\/\//i);
  assert.doesNotMatch(text.replace(/^#.*$/gm, ""), /socks/i, "非注释行里不出现任何 SOCKS 设置");
  assert.match(text, /\*":\$HOME\/\.local\/bin:"\*\) ;;/, "PATH 里已有 ~/.local/bin 时不重复加");
  assert.match(text, /"\$HOME\/\.config\/cluster-workbench\/keys"\/\*\.env/);
  assert.equal(renderClusterEnv({ port: 7892 }), text, "确定性输出（不含时间戳）");
});

test("renderClusterEnv: noProxyExtra 去重追加，非法条目抛错（不会写进双引号里）", () => {
  assert.equal(renderNoProxy(["10.0.0.5", ".lab.internal", "127.0.0.1", " 10.0.0.5 ", ""]), "localhost,127.0.0.1,::1,10.0.0.5,.lab.internal");
  assert.match(renderClusterEnv({ port: 7892, noProxyExtra: ["relay.lab:9443"] }), /^export NO_PROXY="localhost,127\.0\.0\.1,::1,relay\.lab:9443"$/m);
  for (const bad of ["a,b", "a b", 'a"b', "$HOME", "a;b", "`id`"]) {
    assert.throws(() => renderNoProxy([bad]), /NO_PROXY 条目非法/, bad);
  }
  assert.throws(() => renderNoProxy(Array.from({ length: 33 }, (_, i) => `h${i}`)), /过多/);
});

test("clusterProxyUrl: 端口校验 + 预留的代理口令按 RFC 3986 编码（第 4 期才传）", () => {
  assert.equal(clusterProxyUrl(7891), "http://127.0.0.1:7891");
  assert.equal(clusterProxyUrl(7892, { user: "cwb", password: "p@ss:w/rd!'*" }), "http://cwb:p%40ss%3Aw%2Frd%21%27%2A@127.0.0.1:7892");
  assert.match(renderClusterEnv({ port: 7892, credential: { user: "u", password: "x y" } }), /^export HTTPS_PROXY="http:\/\/u:x%20y@127\.0\.0\.1:7892"$/m);
  for (const bad of [0, 70000, 7891.5, "7891", null, undefined]) assert.throws(() => clusterProxyUrl(bad), /端口非法/, String(bad));
  assert.throws(() => clusterProxyUrl(7891, { password: "x" }), /用户名/);
});

test("renderSourceBlock: if/fi 引入；interactiveOnly 时整行包在交互守卫里", () => {
  const plain = renderSourceBlock();
  assert.match(plain, /^if \[ -f "\$HOME\/\.config\/cluster-workbench\/env\.sh" \]; then \. "\$HOME\/\.config\/cluster-workbench\/env\.sh"; fi$/m);
  assert.doesNotMatch(plain, /\$-/);
  assert.match(renderSourceBlock({ interactiveOnly: true }), /^case \$- in \*i\*\) if \[ -f .+; fi ;; esac$/m);
});

test("env.sh: POSIX sh 与 bash（含 set -eu）都能 source；可重复 source；先前的 SOCKS 被清掉；keys/*.env 被读入", { skip }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-sh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const envFile = path.join(home, "env.sh");
  fs.writeFileSync(envFile, renderClusterEnv({ port: 7892 }));
  const probe = `. "${envFile}"; . "${envFile}"; printf "%s|%s|%s" "$HTTPS_PROXY" "\${ALL_PROXY-<unset>}" "$PATH"`;
  for (const [shell, prefix] of [["sh", ""], ["bash", "set -eu; "]]) {
    const res = spawnSync(shell, ["-c", `${prefix}${probe}`], { encoding: "utf8", env: { ...BASE_ENV(home), ALL_PROXY: "socks5h://127.0.0.1:7891" } });
    assert.equal(res.status, 0, `${shell}: ${res.stderr}`);
    const [https, all, pathValue] = res.stdout.split("|");
    assert.equal(https, "http://127.0.0.1:7892", shell);
    assert.equal(all, "<unset>", shell);
    assert.equal(count(`:${pathValue}:`, `:${home}/.local/bin:`), 1, `${shell}: ~/.local/bin 只加一次`);
  }
  fs.mkdirSync(path.join(home, ".config/cluster-workbench/keys"), { recursive: true });
  fs.writeFileSync(path.join(home, ".config/cluster-workbench/keys/relay.env"), 'export RELAY_KEY="k-test"\n');
  const res = spawnSync("sh", ["-c", `. "${envFile}"; printf %s "$RELAY_KEY"`], { encoding: "utf8", env: BASE_ENV(home) });
  assert.equal(res.stdout, "k-test");
});

// ---------------------------------------------------------------------------
// 写入步骤：在 kai 样本上真实执行
// ---------------------------------------------------------------------------

test("buildClusterEnvSteps: 步骤顺序与 required 标记（受管文件与两处引入块是硬前提）", () => {
  const steps = buildClusterEnvSteps({ port: 7891 });
  assert.deepEqual(steps.map((s) => [s.id, s.required]), [["write-env", true], ["source-bashrc", true], ["source-login", true], ["strip-legacy", false]]);
  for (const s of steps) {
    assert.ok(s.title && s.done && s.manual && s.command, s.id);
    assert.doesNotMatch(s.command, /cat\s*>\s*~\/\.(bashrc|bash_profile|profile)(?!\.)/, `${s.id}: 不得裸 cat > rc 文件`);
  }
  assert.equal(steps[0].preview, renderClusterEnv({ port: 7891 }));
  assert.match(steps[0].manual, /cat > ~\/\.config\/cluster-workbench\/env\.sh <<'EOF'/);
});

test("kai 样本：执行全部步骤 → env.sh 600 / 目录 700，.bashrc 与 .bash_profile 末尾各一块，.profile 不动，第 144 行原样", { skip }, (t) => {
  const home = makeHome(t);
  const steps = buildClusterEnvSteps({ port: 7891 });
  applySteps(home, steps);
  applySteps(home, steps); // 重跑幂等

  assert.equal(read(home, ".config/cluster-workbench/env.sh"), renderClusterEnv({ port: 7891 }));
  assert.equal(fileMode(home, ".config/cluster-workbench/env.sh"), 0o600);
  assert.equal(fileMode(home, ".config/cluster-workbench"), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(home, ".config/cluster-workbench")), ["env.sh"], "受管文件不留备份 / 临时文件");

  const bashrc = read(home, ".bashrc");
  assert.ok(bashrc.startsWith(cyBashrc()), "原有内容一字不改，块追加在末尾");
  assert.equal(count(bashrc, "# >>> cluster-workbench env >>>"), 1);
  assert.match(bashrc, /# <<< cluster-workbench env <<<\n$/);
  assert.equal(bashrc.split("\n")[143], CY_SLURM_PATH, "第 144 行 slurm PATH 保留");
  assert.equal(fileMode(home, ".bashrc"), 0o644, "umask 0002 下权限仍是 644");

  const profile = read(home, ".bash_profile");
  assert.ok(profile.startsWith(CY_BASH_PROFILE));
  assert.equal(count(profile, "# >>> cluster-workbench env >>>"), 1);
  assert.doesNotMatch(profile, /\$- in/, "登录 shell 的块不带交互守卫（bash -lc 也要生效）");
  assert.equal(read(home, ".profile"), UBUNTU_PROFILE, ".bash_profile 存在时不写 .profile");
});

test("kai 样本：迁移前 bash -i 里是 socks5h；写入后（注释旧导出之前）三种 shell 都已是 http://", { skip }, (t) => {
  const home = makeHome(t);
  const before = shellVars(home, "interactive");
  assert.equal(before.https, "socks5h://127.0.0.1:7891", "复现现状：bash -i 被 SOCKS 覆盖");

  applySteps(home, buildClusterEnvSteps({ port: 7891 }));
  for (const mode of ["interactive", "login"]) {
    const v = shellVars(home, mode);
    assert.equal(v.https, "http://127.0.0.1:7891", mode);
    assert.equal(v.http, "http://127.0.0.1:7891", mode);
    assert.equal(v.all, "<unset>", `${mode}: ALL_PROXY 被清掉`);
  }
  // 非交互 source（ssh 主机 命令 的情形）：kai 的 .bashrc 顶部守卫先 return，不继承代理。
  assert.equal(shellVars(home, "sourced").https, "<unset>");
});

test("没有交互守卫的 .bashrc（CentOS 默认 / 新账号）：引入块自带守卫，非交互 source 不继承代理", { skip }, (t) => {
  const home = makeHome(t, { bashrc: "# centos default\nalias ll='ls -l'\n", bashProfile: null, profile: null });
  applySteps(home, buildClusterEnvSteps({ port: 7893 }));
  assert.equal(shellVars(home, "sourced").https, "<unset>");
  assert.equal(shellVars(home, "interactive").https, "http://127.0.0.1:7893");
  // 没有 .bash_profile / .bash_login：建 .profile；bash -lc 读它。
  assert.match(read(home, ".profile"), /# >>> cluster-workbench env >>>/);
  assert.equal(fs.existsSync(path.join(home, ".bash_profile")), false);
  assert.equal(shellVars(home, "login").https, "http://127.0.0.1:7893");
});

test("登录 shell 配置按 bash 的查找顺序选：只有 .bash_login 时写它，不写 .profile", { skip }, (t) => {
  const home = makeHome(t, { bashProfile: null });
  fs.writeFileSync(path.join(home, ".bash_login"), "# login\n");
  applySteps(home, buildClusterEnvSteps({ port: 7894 }));
  assert.match(read(home, ".bash_login"), /# >>> cluster-workbench env >>>/);
  assert.equal(read(home, ".profile"), UBUNTU_PROFILE);
  assert.equal(shellVars(home, "login").https, "http://127.0.0.1:7894");
});

test("端口变更后重跑：env.sh 整体替换，引入块不叠加", { skip }, (t) => {
  const home = makeHome(t);
  applySteps(home, buildClusterEnvSteps({ port: 7891 }));
  applySteps(home, buildClusterEnvSteps({ port: 7895 }));
  assert.match(read(home, ".config/cluster-workbench/env.sh"), /127\.0\.0\.1:7895/);
  assert.doesNotMatch(read(home, ".config/cluster-workbench/env.sh"), /7891/);
  assert.equal(count(read(home, ".bashrc"), "# >>> cluster-workbench env >>>"), 1);
  assert.equal(shellVars(home, "interactive").https, "http://127.0.0.1:7895");
});

test("strip-legacy：剥离 P2 旧块（.bashrc 与 shell 包装脚本），独立安装版 codex（ELF）原样不动", { skip }, (t) => {
  const home = makeHome(t, { bashrc: `${cyBashrc()}${LEGACY_BLOCK}` });
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  const wrapper = path.join(home, ".local/bin/codex");
  fs.writeFileSync(wrapper, `#!/bin/sh\n${LEGACY_BLOCK}exec /opt/codex "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  applySteps(home, buildClusterEnvSteps({ port: 7891 }));

  const bashrc = read(home, ".bashrc");
  assert.doesNotMatch(bashrc, /setup-wizard codex-proxy|7999/);
  assert.ok(bashrc.startsWith(cyBashrc()));
  // 同一秒内 .bashrc 被改了两次（追加引入块、剥离旧块）：最初的原文备份不能被第二次备份覆盖。
  const backups = fs.readdirSync(home).filter((n) => n.startsWith(".bashrc.bak."));
  assert.equal(backups.length, 2);
  assert.ok(backups.some((n) => read(home, n) === `${cyBashrc()}${LEGACY_BLOCK}`), "保留了迁移前的原文");
  assert.equal(read(home, ".local/bin/codex"), '#!/bin/sh\nexec /opt/codex "$@"\n');
  assert.equal(fs.statSync(wrapper).mode & 0o777, 0o755);

  const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(`\n${LEGACY_BLOCK}`)]);
  fs.writeFileSync(wrapper, elf);
  applySteps(home, buildClusterEnvSteps({ port: 7891 }));
  assert.deepEqual(fs.readFileSync(wrapper), elf);
});

// ---------------------------------------------------------------------------
// 散落的旧导出
// ---------------------------------------------------------------------------

test("kai 样本：扫描只列出 .bashrc 145–146、149–154 与 .bash_profile 6–7（148 注释、144 PATH、受管块与 P2 旧块都不算）", { skip }, (t) => {
  const home = makeHome(t, { bashrc: `${cyBashrc()}${LEGACY_BLOCK}` });
  applySteps(home, buildClusterEnvSteps({ port: 7891 }).slice(0, 3)); // 先不剥旧块：解析侧也得把它排除
  const out = remote(home, buildStrayScanCommand());
  assert.ok(out.trimEnd().endsWith(STRAY_SCAN_DONE));
  const strays = parseStrayProxyExports(out);
  assert.deepEqual(strays.map((s) => `${s.file}:${s.line}`), [
    ".bashrc:145", ".bashrc:146", ".bashrc:149", ".bashrc:150", ".bashrc:151", ".bashrc:152", ".bashrc:153", ".bashrc:154",
    ".bash_profile:6", ".bash_profile:7",
  ]);
  assert.equal(strays[2].text, 'export ALL_PROXY="socks5h://127.0.0.1:7891"');
  assert.deepEqual(groupStraysByFile(strays), [
    { file: ".bashrc", lines: [145, 146, 149, 150, 151, 152, 153, 154] },
    { file: ".bash_profile", lines: [6, 7] },
  ]);
});

test("parseStrayProxyExports: 注释 / no_proxy / 行尾注释 / 白名单外文件 / 受管块按文件分别跟踪", () => {
  const grep = [
    ".bashrc:3:export HTTPS_PROXY=http://x:1",
    ".bashrc:4:# export http_proxy=http://old",
    ".bashrc:5:export NO_PROXY=localhost",
    ".bashrc:6:export PATH=/bin # 以前这里写过 http_proxy=foo",
    ".bashrc:7:  export FOO=1 https_proxy=http://y:2",
    ".bashrc:8:# >>> cluster-workbench env >>>",
    ".bashrc:9:export HTTP_PROXY=inside-managed-block",
    ".bash_profile:2:export all_proxy=socks5h://z:3",
    ".bashrc:10:# <<< cluster-workbench env <<<",
    ".bashrc:11:export Http_Proxy=http://after:4\r",
    "/etc/profile:1:export http_proxy=http://system",
    ".ssh/config:1:export http_proxy=nope",
    "garbage line",
    STRAY_SCAN_DONE,
  ].join("\n");
  assert.deepEqual(parseStrayProxyExports(grep).map((s) => `${s.file}:${s.line}`), [".bashrc:3", ".bashrc:7", ".bash_profile:2", ".bashrc:11"]);
  assert.deepEqual(parseStrayProxyExports(""), []);
  assert.deepEqual(parseStrayProxyExports("~/.profile:9:export https_proxy=x").map((s) => s.file), [".profile"]);
});

test("buildCommentOutCommand: kai 样本注释掉 10 行、第 144 行与其余内容原样、备份 + 权限保留、重跑幂等", { skip }, (t) => {
  const home = makeHome(t);
  applySteps(home, buildClusterEnvSteps({ port: 7891 }));
  const strays = parseStrayProxyExports(remote(home, buildStrayScanCommand()));
  const beforeBashrc = read(home, ".bashrc");
  for (const { file, lines } of groupStraysByFile(strays)) {
    remote(home, buildCommentOutCommand(file, lines));
    remote(home, buildCommentOutCommand(file, lines)); // 已注释的行不再匹配，不会叠前缀
  }
  const after = read(home, ".bashrc").split("\n");
  const original = beforeBashrc.split("\n");
  assert.equal(after.length, original.length);
  const commented = new Set([145, 146, 149, 150, 151, 152, 153, 154]);
  for (let i = 0; i < original.length; i += 1) {
    const expected = commented.has(i + 1) ? `${STRAY_DISABLED_PREFIX}${original[i]}` : original[i];
    assert.equal(after[i], expected, `第 ${i + 1} 行`);
  }
  assert.equal(after[143], CY_SLURM_PATH);
  assert.match(read(home, ".bash_profile"), /^# \[cluster-workbench 已停用\] export HTTP_PROXY="http:\/\/127\.0\.0\.1:7891"$/m);
  assert.equal(fileMode(home, ".bashrc"), 0o644);
  assert.ok(fs.readdirSync(home).some((n) => n.startsWith(".bashrc.bak.")));
  assert.ok(!fs.readdirSync(home).some((n) => n.includes(".tmp.")));
  assert.deepEqual(parseStrayProxyExports(remote(home, buildStrayScanCommand())), [], "再扫一遍已干净");
  for (const mode of ["interactive", "login"]) assert.equal(shellVars(home, mode).https, "http://127.0.0.1:7891", mode);
});

test("buildCommentOutCommand: 行号错位到非代理导出行（如第 144 行 PATH）时不注释", { skip }, (t) => {
  const home = makeHome(t);
  remote(home, buildCommentOutCommand(".bashrc", [143, 144, 145]));
  const lines = read(home, ".bashrc").split("\n");
  assert.equal(lines[142], "# Codex App SSH proxy");
  assert.equal(lines[143], CY_SLURM_PATH);
  assert.equal(lines[144], `${STRAY_DISABLED_PREFIX}export HTTP_PROXY="http://127.0.0.1:7891"`);
});

test("buildCommentOutCommand: 只接受 shell 启动文件与正整数行号", () => {
  for (const file of ["/etc/passwd", ".ssh/authorized_keys", "../.bashrc", ".bashrc; rm -rf ~", ".zshrc", ""]) {
    assert.throws(() => buildCommentOutCommand(file, [1]), /只处理 shell 启动文件/, file);
  }
  for (const lines of [[], [0], [-1], [1.5], ["145"], null]) {
    assert.throws(() => buildCommentOutCommand(".bashrc", lines), /行号非法/, JSON.stringify(lines));
  }
  assert.match(buildCommentOutCommand("~/.bash_profile", [7, 6, 7]), /-v L=",6,7,"/);
});

// ---------------------------------------------------------------------------
// Claude Code settings.json
// ---------------------------------------------------------------------------

test("mergeClaudeSettingsEnv: kai 的 settings（reclaude 40161 + .reclaude 证书）→ 跳过", () => {
  const text = JSON.stringify(cySettings(), null, 2);
  assert.deepEqual(mergeClaudeSettingsEnv(text, { port: 7891 }), { skipped: "reclaude-managed" });
  assert.equal(isReclaudeManagedClaudeEnv(cySettings().env, 7891), true);
  // 只有证书、没有代理 / 代理已指向本隧道端口：不算 reclaude 接管
  assert.equal(isReclaudeManagedClaudeEnv({ NODE_EXTRA_CA_CERTS: "/h/.reclaude/ca.pem" }, 7891), false);
  assert.equal(isReclaudeManagedClaudeEnv({ ...cySettings().env, HTTPS_PROXY: "http://127.0.0.1:7891" }, 7891), false);
  assert.equal(isReclaudeManagedClaudeEnv({ ...cySettings().env, HTTPS_PROXY: "not a url" }, 7891), true, "解析不出端口从严当作别人的");
  assert.equal(isReclaudeManagedClaudeEnv({ HTTPS_PROXY: "http://127.0.0.1:40161" }, 7891), false);
});

test("mergeClaudeSettingsEnv: 只改代理键，hooks 等其余键与顺序原样保留；再合并一次不再变化", () => {
  const original = { ...cySettings(), env: { FOO: "1", HTTPS_PROXY: "socks5h://127.0.0.1:7891", NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem" } };
  const text = JSON.stringify(original, null, 2);
  const merged = mergeClaudeSettingsEnv(text, { port: 7892 });
  assert.equal(merged.changed, true);
  assert.deepEqual(merged.changedKeys, ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]);
  const parsed = JSON.parse(merged.text);
  assert.deepEqual(Object.keys(parsed), Object.keys(original), "顶层键顺序不变");
  assert.deepEqual(parsed.hooks, original.hooks, "超长 hooks 命令逐字保留");
  assert.equal(parsed.env.FOO, "1");
  assert.equal(parsed.env.NODE_EXTRA_CA_CERTS, "/etc/ssl/corp.pem");
  assert.deepEqual({ ...parsed.env, FOO: undefined, NODE_EXTRA_CA_CERTS: undefined }, { ...claudeSettingsProxyEnv({ port: 7892 }), FOO: undefined, NODE_EXTRA_CA_CERTS: undefined });

  const again = mergeClaudeSettingsEnv(merged.text, { port: 7892 });
  assert.equal(again.changed, false);
  assert.equal(again.text, merged.text);
});

test("mergeClaudeSettingsEnv: 空文件起步；坏 JSON / 顶层非对象 / env 非对象一律跳过", () => {
  for (const blank of ["", "  \n", null, undefined]) {
    assert.deepEqual(JSON.parse(mergeClaudeSettingsEnv(blank, { port: 7892 }).text), { env: claudeSettingsProxyEnv({ port: 7892 }) });
  }
  for (const bad of ["{not json", "[1]", '"s"', "null", '{"env":"x"}', '{"env":[1]}']) {
    assert.deepEqual(mergeClaudeSettingsEnv(bad, { port: 7892 }), { skipped: "invalid-json" }, bad);
  }
});

test("removeClaudeSettingsEnv: 合并后撤销回到原样；用户改过的值保留；env 删空则去掉", () => {
  const original = { hooks: longHooks(), env: { FOO: "1" }, model: "x" };
  const text = `${JSON.stringify(original, null, 2)}\n`;
  const merged = mergeClaudeSettingsEnv(text, { port: 7892, noProxyExtra: ["10.0.0.5"] });
  // 登录引导后来又加了一个内网站：写入时的 NO_PROXY 是当前名单的子集，照样认得出是我们写的
  const undone = removeClaudeSettingsEnv(merged.text, { port: 7892, noProxyExtra: ["10.0.0.5", "10.0.0.6"] });
  assert.equal(undone.changed, true);
  assert.equal(undone.text, text);

  // 用户自己往 NO_PROXY 里追加过条目：整个键原样保留，代理地址键照删
  const appended = JSON.parse(mergeClaudeSettingsEnv(text, { port: 7892 }).text);
  appended.env.NO_PROXY = `${appended.env.NO_PROXY},corp.example.com`;
  const kept = removeClaudeSettingsEnv(JSON.stringify(appended), { port: 7892 });
  assert.equal(JSON.parse(kept.text).env.NO_PROXY, "localhost,127.0.0.1,::1,corp.example.com");
  assert.equal(JSON.parse(kept.text).env.no_proxy, undefined, "没改过的那个照删");
  assert.equal(JSON.parse(kept.text).env.HTTPS_PROXY, undefined);
  assert.ok(!kept.removedKeys.includes("NO_PROXY"));

  const edited = JSON.parse(merged.text);
  edited.env.HTTPS_PROXY = "http://127.0.0.1:40161";
  const partial = JSON.parse(removeClaudeSettingsEnv(JSON.stringify(edited), { port: 7892 }).text);
  assert.equal(partial.env.HTTPS_PROXY, "http://127.0.0.1:40161", "用户事后改过的键不动");
  assert.equal(partial.env.HTTP_PROXY, undefined);

  const onlyOurs = mergeClaudeSettingsEnv("{}", { port: 7892 }).text;
  assert.deepEqual(JSON.parse(removeClaudeSettingsEnv(onlyOurs, { port: 7892 }).text), {});
  assert.equal(removeClaudeSettingsEnv(JSON.stringify(cySettings()), { port: 7891 }).changed, false, "reclaude 的值不是我们写的");
  assert.deepEqual(removeClaudeSettingsEnv("{bad", { port: 7891 }), { skipped: "invalid-json" });
});

test("mergeClaudeSettingsEnv / removeClaudeSettingsEnv: 沿用原文件的缩进、换行符与末尾换行（不整体改成 2 空格）", () => {
  const original = { model: "opus", env: { FOO: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };
  const cases = [
    ["4 空格 + 末尾换行", `${JSON.stringify(original, null, 4)}\n`, 4],
    ["制表符 + 末尾换行", `${JSON.stringify(original, null, "\t")}\n`, "\t"],
    ["2 空格、无末尾换行", JSON.stringify(original, null, 2), 2],
    ["单行紧凑 + 末尾换行", `${JSON.stringify(original)}\n`, ""],
    ["CRLF + 3 空格", `${JSON.stringify(original, null, 3).replaceAll("\n", "\r\n")}\r\n`, 3],
  ];
  for (const [label, text, indent] of cases) {
    const merged = mergeClaudeSettingsEnv(text, { port: 7892 });
    const expected = { ...original, env: { ...original.env, ...claudeSettingsProxyEnv({ port: 7892 }) } };
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const tail = /\n$/.test(text) ? eol : "";
    assert.equal(merged.text, `${JSON.stringify(expected, null, indent).replaceAll("\n", eol)}${tail}`, label);
    // 撤销回到逐字原文：缩进、换行符、末尾换行全部一致。
    assert.equal(removeClaudeSettingsEnv(merged.text, { port: 7892 }).text, text, `${label}: 撤销逐字还原`);
  }
  // 首个缩进取第一处行首空白（深层更宽的缩进不影响）；空文件 / {} 起步用 2 空格（Claude Code 自己的写法）。
  // 末尾换行：空文件新建时带；{} 跟原文。
  const fourFirst = '{\n    "env": {\n        "FOO": "1"\n    }\n}\n';
  assert.match(mergeClaudeSettingsEnv(fourFirst, { port: 7892 }).text, /^\{\n {4}"env": \{\n {8}"FOO": "1",\n/);
  for (const [blank, tail] of [["", "}\n"], ["  \n", "}\n"], ["{}\n", "}\n"], ["{}", "\n}"]]) {
    const text = mergeClaudeSettingsEnv(blank, { port: 7892 }).text;
    assert.match(text, /^\{\n {2}"env": \{\n {4}"HTTP_PROXY"/, JSON.stringify(blank));
    assert.ok(text.endsWith(tail), JSON.stringify(blank));
  }
});

test("parseClaudeSettingsRead / planClaudeSettingsMerge: 回读输出 → 动作", () => {
  assert.equal(parseClaudeSettingsRead(""), null);
  assert.deepEqual(parseClaudeSettingsRead("__CWB_CLAUDE__=0\n"), { present: false, text: "" });
  assert.deepEqual(parseClaudeSettingsRead('motd noise\n__CWB_CLAUDE__=1\n{"a":1}\n'), { present: true, text: '{"a":1}\n' });

  assert.deepEqual(planClaudeSettingsMerge("ssh: connect timeout", { port: 7892 }), { action: "error", reason: "unreadable" });
  assert.deepEqual(planClaudeSettingsMerge("__CWB_CLAUDE__=0\n", { port: 7892 }), { action: "skip", reason: "no-claude" });
  assert.deepEqual(planClaudeSettingsMerge(`__CWB_CLAUDE__=1\n${JSON.stringify(cySettings())}`, { port: 7891 }), { action: "skip", reason: "reclaude-managed" });
  assert.deepEqual(planClaudeSettingsMerge("__CWB_CLAUDE__=1\n{bad", { port: 7892 }), { action: "skip", reason: "invalid-json" });
  const done = mergeClaudeSettingsEnv("{}", { port: 7892 }).text;
  assert.deepEqual(planClaudeSettingsMerge(`__CWB_CLAUDE__=1\n${done}`, { port: 7892 }), { action: "unchanged" });

  const source = JSON.stringify({ hooks: longHooks() });
  const plan = planClaudeSettingsMerge(`__CWB_CLAUDE__=1\n${source}`, { port: 7892 });
  assert.equal(plan.action, "write");
  assert.equal(JSON.parse(plan.input).hooks.PreToolUse[0].hooks[0].command, longHooks().PreToolUse[0].hooks[0].command);
  assert.ok(plan.command.includes(`-eq ${Buffer.byteLength(plan.input, "utf8")} ]`), "按 UTF-8 字节数核对（hooks 里有中文）");
  assert.doesNotMatch(plan.command, /set -euo pipefail/, "文件内容不进命令串");
  assert.ok(plan.command.length < 1000);
});

test("Claude 回读命令 + 写回命令在临时 HOME 里真实往返：hooks 保留、权限 600 保留", { skip }, (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const original = `${JSON.stringify({ env: { FOO: "1" }, hooks: longHooks() }, null, 2)}\n`;
  fs.writeFileSync(path.join(home, ".claude/settings.json"), original, { mode: 0o600 });
  fs.chmodSync(path.join(home, ".claude/settings.json"), 0o600);

  const plan = planClaudeSettingsMerge(remote(home, CLAUDE_SETTINGS_READ_COMMAND), { port: 7892 });
  assert.equal(plan.action, "write");
  remote(home, plan.command, plan.input);
  const written = JSON.parse(read(home, ".claude/settings.json"));
  assert.deepEqual(written.hooks, longHooks());
  assert.equal(written.env.HTTPS_PROXY, "http://127.0.0.1:7892");
  assert.equal(fileMode(home, ".claude/settings.json"), 0o600);
  assert.deepEqual(planClaudeSettingsMerge(remote(home, CLAUDE_SETTINGS_READ_COMMAND), { port: 7892 }), { action: "unchanged" });
});

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

function runUndo(home, steps, via) {
  for (const step of steps) {
    if (step.kind === "remote") {
      remote(home, step.command, undefined, via);
      continue;
    }
    const plan = step.plan(remote(home, step.readCommand, undefined, via));
    if (plan.action === "write") remote(home, plan.command, plan.input, via);
  }
}

test("buildUndoCommands: 配置 + 注释旧导出 + 合并 settings 之后撤销 → 各文件回到原样、受管目录删除", { skip }, (t) => {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const settings = `${JSON.stringify({ env: { FOO: "1" }, hooks: longHooks() }, null, 2)}\n`;
  fs.writeFileSync(path.join(home, ".claude/settings.json"), settings);
  const opts = { port: 7891 };

  applySteps(home, buildClusterEnvSteps(opts));
  for (const { file, lines } of groupStraysByFile(parseStrayProxyExports(remote(home, buildStrayScanCommand())))) {
    remote(home, buildCommentOutCommand(file, lines));
  }
  const plan = planClaudeSettingsMerge(remote(home, CLAUDE_SETTINGS_READ_COMMAND), opts);
  remote(home, plan.command, plan.input);
  fs.mkdirSync(path.join(home, ".config/cluster-workbench/keys"));
  fs.writeFileSync(path.join(home, ".config/cluster-workbench/keys/relay.env"), "export K=1\n");

  const undo = buildUndoCommands(opts);
  assert.deepEqual(undo.map((s) => s.id), ["strip-source-blocks", "remove-env", "restore-strays", "claude-settings"]);
  runUndo(home, undo);
  assert.equal(read(home, ".bashrc"), cyBashrc());
  assert.equal(read(home, ".bash_profile"), CY_BASH_PROFILE);
  assert.equal(read(home, ".profile"), UBUNTU_PROFILE);
  assert.equal(read(home, ".claude/settings.json"), settings);
  assert.equal(fs.existsSync(path.join(home, ".config/cluster-workbench")), false);
  assert.ok(fs.existsSync(path.join(home, ".config/codex/cpa.env")), "别的工具的文件不动");

  runUndo(home, buildUndoCommands(opts)); // 再撤一次：全是空操作
  assert.equal(read(home, ".bashrc"), cyBashrc());
});

// ---------------------------------------------------------------------------
// sh -c 包裹（v2.54 终审）：交给 ssh 的每条命令都是 `sh -c '<脚本>'`，不依赖对方登录 shell 是 bash / sh
// ---------------------------------------------------------------------------

// 一轮完整生命周期里交给 ssh 的全部命令：写入四步、扫描、注释、settings 回读 / 写回、撤销。
function allRemoteCommands(opts = { port: 7891 }) {
  const settingsWrite = planClaudeSettingsMerge(`__CWB_CLAUDE__=1\n${JSON.stringify({ env: { FOO: "1" } })}`, opts);
  const settingsRemove = buildUndoCommands(opts).find((s) => s.kind === "settings-edit").plan(`__CWB_CLAUDE__=1\n${mergeClaudeSettingsEnv("{}", opts).text}`);
  return [
    ...buildClusterEnvSteps(opts).map((s) => [s.id, s.command]),
    ["scan", buildStrayScanCommand()],
    ["comment-out", buildCommentOutCommand(".bashrc", [145, 146])],
    ["claude-read", CLAUDE_SETTINGS_READ_COMMAND],
    ["claude-write", settingsWrite.command],
    ["claude-remove", settingsRemove.command],
    ...buildUndoCommands(opts).filter((s) => s.kind === "remote").map((s) => [s.id, s.command]),
  ];
}

test("所有远端命令都包成 sh -c '…'：内部单引号写成 '\\''，换行前都有续行符，$$ / ~ / $HOME 原样留给远端 sh", () => {
  const commands = allRemoteCommands();
  assert.equal(commands.length, 12);
  for (const [id, cmd] of commands) {
    assert.match(cmd, /^sh -c '[\s\S]*'$/, id);
    assert.ok(cmd.split("\n").slice(0, -1).every((line) => line.endsWith("\\")), `${id}: 没有裸换行（csh 单引号里不允许）`);
    // 去掉 '\'' 与 '\!' 两种转义后，剩下的单引号只剩首尾一对：外层引号没有被提前闭合。
    assert.equal(cmd.replaceAll("'\\''", "").replaceAll("'\\!'", "").split("'").length - 1, 2, `${id}: 单引号转义完整`);
  }
  const byId = Object.fromEntries(commands);
  assert.ok(byId["write-env"].includes("~/.config/cluster-workbench/env.sh.tmp.$$"), "临时文件名里的 $$ 由远端 sh 展开");
  assert.ok(byId["source-bashrc"].includes("~/.bashrc.bak.$(date +%s).$$"), "备份名带 $$");
  assert.ok(byId["claude-read"].includes('"$HOME/.claude/settings.json"'));
  assert.ok(byId["claude-write"].includes("wc -c < ~/.claude/settings.json.tmp.$$"), "stdin 写 settings.json 那步也包");
  assert.ok(byId["strip-legacy"].includes(`[ "$(head -c 2 ~/.local/bin/codex)" = '\\''#'\\!''\\'' ]`), "#! 里的 ! 放到引号外转义");
});

// 记录 sh 实际收到的脚本：PATH 最前放一个名为 sh 的垫片，把 -c 的脚本参数写进文件。垫片整个测试只建一次
// （macOS 首次执行新建的脚本要过一遍系统检查，每条命令新建一个会慢上十倍）。
function makeScriptCapture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-sh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, "script");
  fs.writeFileSync(path.join(dir, "sh"), `#!/bin/sh\n[ "$1" = -c ] || exit 97\nprintf '%s' "$2" > '${out}'\n`, { mode: 0o755 });
  return (outer, command) => {
    fs.rmSync(out, { force: true });
    const res = spawnSync(outer, ["-c", command], { encoding: "utf8", env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin` } });
    assert.equal(res.status, 0, `${outer}: ${res.stderr}`);
    return fs.readFileSync(out, "utf8");
  };
}

const DASH = !skip && fs.existsSync("/bin/dash") ? "/bin/dash" : null;
const CSH_SHELLS = ["/bin/csh", "/bin/tcsh"].filter((p) => !skip && fs.existsSync(p));

test("包裹后的命令：登录 shell 是 bash 或 /bin/sh 时 sh 收到逐字相同的脚本，且该脚本在 bash / sh（/ dash）下语法成立", { skip }, (t) => {
  const captureInnerScript = makeScriptCapture(t);
  for (const [id, cmd] of allRemoteCommands()) {
    const viaBash = captureInnerScript("bash", cmd);
    assert.equal(captureInnerScript("/bin/sh", cmd), viaBash, `${id}: /bin/sh 与 bash 解读一致`);
    assert.ok(viaBash.includes("$$") || id === "scan" || id === "claude-read" || id === "remove-env", `${id}: $$ 没被登录 shell 提前展开`);
    assert.doesNotMatch(viaBash, new RegExp(os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${id}: ~ / $HOME 没被登录 shell 提前展开`);
    for (const checker of ["bash", "/bin/sh", DASH].filter(Boolean)) {
      const res = spawnSync(checker, ["-n", "-c", viaBash], { encoding: "utf8" });
      assert.equal(res.status, 0, `${id} 在 ${checker} 下语法错误: ${res.stderr}`);
    }
  }
});

// 完整生命周期：配置（跑两遍）→ 扫描 → 注释旧导出 → 合并 settings → 撤销，经不同"登录 shell"与不同 sh 实现。
function lifecycle(t, via) {
  const home = makeHome(t);
  fs.mkdirSync(path.join(home, ".claude"));
  const settings = `${JSON.stringify({ env: { FOO: "1" }, hooks: longHooks() }, null, 4)}\n`;
  fs.writeFileSync(path.join(home, ".claude/settings.json"), settings, { mode: 0o600 });
  const opts = { port: 7891 };
  const label = `${via.outer}${via.shDir ? " + dash" : ""}`;

  applySteps(home, buildClusterEnvSteps(opts), via);
  applySteps(home, buildClusterEnvSteps(opts), via);
  assert.equal(read(home, ".config/cluster-workbench/env.sh"), renderClusterEnv(opts), label);
  assert.equal(fileMode(home, ".config/cluster-workbench/env.sh"), 0o600, label);
  assert.equal(count(read(home, ".bashrc"), "# >>> cluster-workbench env >>>"), 1, label);
  assert.equal(count(read(home, ".bash_profile"), "# >>> cluster-workbench env >>>"), 1, label);

  const strays = parseStrayProxyExports(remote(home, buildStrayScanCommand(), undefined, via));
  assert.equal(strays.length, 10, label);
  for (const { file, lines } of groupStraysByFile(strays)) remote(home, buildCommentOutCommand(file, lines), undefined, via);
  assert.equal(parseStrayProxyExports(remote(home, buildStrayScanCommand(), undefined, via)).length, 0, label);

  const plan = planClaudeSettingsMerge(remote(home, CLAUDE_SETTINGS_READ_COMMAND, undefined, via), opts);
  assert.equal(plan.action, "write", label);
  remote(home, plan.command, plan.input, via);
  const written = read(home, ".claude/settings.json");
  assert.equal(JSON.parse(written).env.HTTPS_PROXY, "http://127.0.0.1:7891", label);
  assert.match(written, /^\{\n {4}"env"/, `${label}: 保持 4 空格缩进`);
  assert.equal(fileMode(home, ".claude/settings.json"), 0o600, label);
  assert.equal(shellVars(home, "interactive").https, "http://127.0.0.1:7891", label);
  assert.ok(!fs.readdirSync(home).some((n) => n.includes(".tmp.")), `${label}: 不留临时文件`);

  runUndo(home, buildUndoCommands(opts), via);
  assert.equal(read(home, ".bashrc"), cyBashrc(), label);
  assert.equal(read(home, ".bash_profile"), CY_BASH_PROFILE, label);
  assert.equal(read(home, ".profile"), UBUNTU_PROFILE, label);
  assert.equal(read(home, ".claude/settings.json"), settings, `${label}: settings.json 逐字还原`);
  assert.equal(fs.existsSync(path.join(home, ".config/cluster-workbench")), false, label);
}

test("真跑：登录 shell 为 bash / /bin/sh / csh / tcsh 时完整生命周期结论一致", { skip }, (t) => {
  for (const outer of ["bash", "/bin/sh", ...CSH_SHELLS]) lifecycle(t, { outer });
});

test("真跑：远端 sh 是 dash（Ubuntu 的 /bin/sh）时完整生命周期同样成立", { skip: !DASH }, (t) => {
  const shDir = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-dash-"));
  t.after(() => fs.rmSync(shDir, { recursive: true, force: true }));
  fs.symlinkSync(DASH, path.join(shDir, "sh"));
  for (const outer of ["bash", "/bin/sh"]) lifecycle(t, { outer, shDir });
});

test("buildLegacyToolProxyScanCommand & parseLegacyToolProxies: 扫描 .npmrc / .gitconfig / .curlrc 中的 127.0.0.1 旧代理并过滤同端口一致项", { skip }, (t) => {
  const home = makeHome(t);
  fs.writeFileSync(path.join(home, ".npmrc"), "registry=https://registry.npmjs.org/\nproxy=http://127.0.0.1:7891\nhttps-proxy=http://127.0.0.1:7890\n# proxy=http://127.0.0.1:9999\n");
  fs.writeFileSync(path.join(home, ".gitconfig"), "[http]\n\tproxy = socks5h://127.0.0.1:7891\n");
  fs.writeFileSync(path.join(home, ".curlrc"), 'proxy = "http://127.0.0.1:1080"\n');

  const out = remote(home, buildLegacyToolProxyScanCommand());
  assert.ok(out.includes(TOOL_PROXY_SCAN_DONE));
  const all = parseLegacyToolProxies(out);
  assert.deepEqual(
    all.map((x) => [x.file, x.line, x.scheme, x.port]),
    [
      [".npmrc", 2, "http", 7891],
      [".npmrc", 3, "http", 7890],
      [".gitconfig", 2, "socks5h", 7891],
      [".curlrc", 1, "http", 1080],
    ],
  );
  // 传入 expectedPort: 7891 时，http://127.0.0.1:7891 视为一致不报，但 socks5h://127.0.0.1:7891 仍报出
  const conflicts = parseLegacyToolProxies(out, { expectedPort: 7891 });
  assert.deepEqual(
    conflicts.map((x) => [x.file, x.scheme, x.port]),
    [
      [".npmrc", "http", 7890],
      [".gitconfig", "socks5h", 7891],
      [".curlrc", "http", 1080],
    ],
  );
});

