// 集群侧受管配置带代理口令（v2.62）：渲染 → 写入 → 换口令 → 撤销，在临时 HOME 里用本机 sh 真跑一遍。
// 两条贯穿始终的断言：① 交给 ssh 的每一条命令文本里都没有口令（也没有它的 base64）；② 不带口令时
// 一切与以前逐字相同。新用例单独成文件，cluster-env.test.mjs 原样不动。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildClusterEnvSteps,
  buildEnvPortReadCommand,
  buildUndoCommands,
  CLAUDE_SETTINGS_READ_COMMAND,
  claudeSettingsProxyEnv,
  clusterProxyUrl,
  credentialFingerprint,
  credentialForEnvRewrite,
  isManagedProxyUrl,
  MANAGED_PROXY_USER,
  maskProxyCredential,
  mergeClaudeSettingsEnv,
  parseEnvCredentialRead,
  parseEnvPortRead,
  parseManagedProxyUrl,
  planClaudeSettingsMerge,
  removeClaudeSettingsEnv,
  renderClusterEnv,
} from "./cluster-env.mjs";
import { PROXY_AUTH_USER } from "./proxy/auth.mjs";

const skip = process.platform === "win32" ? "远端命令用本机 sh 执行，需要 POSIX 环境" : false;
const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const NEW_TOKEN = "NextTokenEEEEffffGGGGhhhh7654321";
const CRED = { user: "cwb", password: TOKEN };
const NEW_CRED = { user: "cwb", password: NEW_TOKEN };
const PORT = 7891;

const BASHRC = "# ~/.bashrc\ncase $- in *i*) ;; *) return ;; esac\nalias ll='ls -l'\n";
const BASH_PROFILE = "# ~/.bash_profile\nexport EDITOR=vim\n";
const SETTINGS = `${JSON.stringify({ env: { FOO: "1" }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }, null, 2)}\n`;

// 临时 HOME。remote() 记下交给「ssh」的每条命令文本——事后统一检查里面有没有口令。
function sandbox(t, { settings = SETTINGS } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cluster-env-cred-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".bashrc"), BASHRC);
  fs.writeFileSync(path.join(home, ".bash_profile"), BASH_PROFILE);
  if (settings !== null) {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude/settings.json"), settings, { mode: 0o664 });
    fs.chmodSync(path.join(home, ".claude/settings.json"), 0o664);
  }
  const commands = [];
  const remote = (command, input) => {
    commands.push(command);
    const res = spawnSync("sh", ["-c", command], { env: { HOME: home, PATH: process.env.PATH, LC_ALL: "C" }, encoding: "utf8", input: input ?? "" });
    assert.equal(res.status, 0, `${command.slice(0, 120)}…\n${res.stderr}`);
    return res.stdout;
  };
  const read = (rel) => fs.readFileSync(path.join(home, rel), "utf8");
  const mode = (rel) => fs.statSync(path.join(home, rel)).mode & 0o777;
  const applySteps = (opts) => {
    for (const step of buildClusterEnvSteps(opts)) remote(step.command, step.input);
  };
  const mergeSettings = (opts) => {
    const plan = planClaudeSettingsMerge(remote(CLAUDE_SETTINGS_READ_COMMAND), opts);
    if (plan.action === "write") remote(plan.command, plan.input);
    return plan;
  };
  const undo = (opts) => {
    for (const step of buildUndoCommands(opts)) {
      if (step.kind === "remote") remote(step.command);
      else {
        const plan = step.plan(remote(step.readCommand));
        if (plan.action === "write") remote(plan.command, plan.input);
      }
    }
  };
  const envState = () => {
    const out = remote(buildEnvPortReadCommand());
    return { ...parseEnvPortRead(out), credential: parseEnvCredentialRead(out) };
  };
  return { home, remote, commands, read, mode, applySteps, mergeSettings, undo, envState };
}

function assertNoSecretInCommands(commands, tokens) {
  for (const command of commands) {
    for (const token of tokens) {
      assert.equal(command.includes(token), false, `命令文本里出现了口令: ${command.slice(0, 100)}…`);
      // 以前不带口令的 env.sh 是把全文的 base64 内嵌进命令的：带口令时这条路必须不走。三种对齐方式都查。
      for (const pad of ["", "x", "xx"]) {
        const encoded = Buffer.from(`${pad}${token}`).toString("base64").slice(4, -4);
        assert.equal(command.includes(encoded), false, `命令文本里出现了口令的 base64: ${command.slice(0, 100)}…`);
      }
    }
  }
}

test("用户名常量两边一致；代理地址按形状认（不带口令 / 带我们的用户名）", () => {
  assert.equal(MANAGED_PROXY_USER, PROXY_AUTH_USER);
  assert.deepEqual(parseManagedProxyUrl("http://127.0.0.1:7891"), { port: 7891, hasCredential: false, user: null });
  assert.deepEqual(parseManagedProxyUrl(clusterProxyUrl(7891, CRED)), { port: 7891, hasCredential: true, user: "cwb" });
  for (const notOurs of ["https://127.0.0.1:7891", "http://127.0.0.1:7891/", "http://localhost:7891", "socks5h://127.0.0.1:7891", "http://127.0.0.1:99999", "http://127.0.0.1", "", null, 7891]) {
    assert.equal(parseManagedProxyUrl(notOurs), null, String(notOurs));
  }
  assert.equal(isManagedProxyUrl("http://127.0.0.1:7891", 7891), true);
  assert.equal(isManagedProxyUrl(`http://cwb:${TOKEN}@127.0.0.1:7891`, 7891), true);
  assert.equal(isManagedProxyUrl(`http://cwb:${NEW_TOKEN}@127.0.0.1:7891`, 7891), true, "哪一个口令都算——换过口令的旧值也认得");
  assert.equal(isManagedProxyUrl("http://cwb:@127.0.0.1:7891", 7891), true);
  assert.equal(isManagedProxyUrl(`http://cwb:${TOKEN}@127.0.0.1:7893`, 7891), false, "别的端口");
  assert.equal(isManagedProxyUrl(`http://alice:${TOKEN}@127.0.0.1:7891`, 7891), false, "别的用户名 = 用户自己配的认证代理");
  assert.equal(isManagedProxyUrl("http://127.0.0.1:40161", 7891), false, "reclaude 的端口");
});

test("credentialForEnvRewrite（v2.64）：本机没口令不带；模式打开着就带；模式是关时集群上原来带着才带，读不出来宁可带", () => {
  const fp = credentialFingerprint(CRED);
  // 本机没有口令：无论集群上是什么、模式是什么，都不带（与以前逐字相同）。
  for (const stored of [null, undefined, { user: "cwb", password: "" }, { user: "", password: TOKEN }]) {
    for (const mode of ["off", "observe", "enforce", undefined]) {
      for (const clusterCredential of [null, "none", fp, "nohash"]) {
        assert.equal(credentialForEnvRewrite({ stored, mode, clusterCredential }), null, `${JSON.stringify(stored)} ${mode} ${clusterCredential}`);
      }
    }
  }
  assert.equal(credentialForEnvRewrite(), null);
  // 模式打开着：集群上没带过也带上。
  for (const mode of ["observe", "enforce"]) {
    for (const clusterCredential of [null, "none", fp, "nohash", credentialFingerprint(NEW_CRED)]) {
      assert.equal(credentialForEnvRewrite({ stored: CRED, mode, clusterCredential }), CRED, `${mode} ${clusterCredential}`);
    }
  }
  // 模式是关（或不传：后台的端口同步只保住、不新加）：集群上原来带着（哪一个都算、核对不了也算）才带；明确没带不带。
  for (const mode of ["off", undefined, "strict"]) {
    assert.equal(credentialForEnvRewrite({ stored: CRED, mode, clusterCredential: "none" }), null, `${mode} none`);
    for (const clusterCredential of [fp, credentialFingerprint(NEW_CRED), "nohash"]) {
      assert.equal(credentialForEnvRewrite({ stored: CRED, mode, clusterCredential }), CRED, `${mode} ${clusterCredential}`);
    }
    assert.equal(credentialForEnvRewrite({ stored: CRED, mode, clusterCredential: null }), CRED, "读不出来：宁可带上");
  }
});

test("renderClusterEnv 带口令：四个代理变量都是带口令的地址；其余内容与不带口令时逐行相同", () => {
  const plain = renderClusterEnv({ port: PORT }).split("\n");
  const withCred = renderClusterEnv({ port: PORT, credential: CRED }).split("\n");
  assert.equal(withCred.length, plain.length);
  const changed = withCred.map((line, i) => (line === plain[i] ? null : line)).filter(Boolean);
  assert.deepEqual(changed, ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"].map((key) => `export ${key}="http://cwb:${TOKEN}@127.0.0.1:${PORT}"`));
  assert.equal(maskProxyCredential(withCred.join("\n")).includes(TOKEN), false);
  assert.match(maskProxyCredential(withCred.join("\n")), /export HTTPS_PROXY="http:\/\/cwb:••••••@127\.0\.0\.1:7891"/);
  assert.equal(maskProxyCredential("export HTTPS_PROXY=\"http://127.0.0.1:7891\""), "export HTTPS_PROXY=\"http://127.0.0.1:7891\"", "不带口令的原样");
});

test("buildClusterEnvSteps：不带口令时逐字不变（全文 base64 内嵌、没有 input）；带口令时全文走标准输入、给人看的都打码", () => {
  const plain = buildClusterEnvSteps({ port: PORT });
  const writePlain = plain.find((step) => step.id === "write-env");
  assert.equal(Object.hasOwn(writePlain, "input"), false);
  assert.ok(writePlain.command.includes(Buffer.from(renderClusterEnv({ port: PORT })).toString("base64")), "不带口令：还是原来那条内嵌 base64 的命令");
  assert.equal(writePlain.preview, renderClusterEnv({ port: PORT }));

  const steps = buildClusterEnvSteps({ port: PORT, credential: CRED });
  assert.deepEqual(steps.map((step) => step.id), plain.map((step) => step.id));
  const write = steps.find((step) => step.id === "write-env");
  assert.equal(write.input, renderClusterEnv({ port: PORT, credential: CRED }));
  assert.match(write.command, /^sh -c '/);
  assert.match(write.command, /cat > ~\/\.config\/cluster-workbench\/env\.sh\.tmp\.\$\$/);
  assert.match(write.command, new RegExp(`-eq ${Buffer.byteLength(write.input)} \\]`), "按字节数核对，断线不会留下半截文件");
  assert.doesNotMatch(write.command, /\.bak\./, "受管文件不留备份（备份里会是旧口令）");
  for (const text of [write.preview, write.manual, write.title, write.done]) assert.equal(text.includes(TOKEN), false);
  assert.match(write.preview, /cwb:••••••@127\.0\.0\.1:7891/);
  assert.match(write.manual, /请在工作台里重新点「把口令写到集群」/);
  // 其余三步（两处引入块、清理旧块）与不带口令时逐字相同。
  for (const id of ["source-bashrc", "source-login", "strip-legacy"]) {
    assert.deepEqual(steps.find((step) => step.id === id), plain.find((step) => step.id === id), id);
  }
  assertNoSecretInCommands(steps.map((step) => step.command), [TOKEN]);
});

test("mergeClaudeSettingsEnv / removeClaudeSettingsEnv 带口令：只改代理键；撤销不需要知道口令", () => {
  const merged = mergeClaudeSettingsEnv(SETTINGS, { port: PORT, credential: CRED });
  assert.equal(merged.changed, true);
  const env = JSON.parse(merged.text).env;
  assert.equal(env.HTTPS_PROXY, `http://cwb:${TOKEN}@127.0.0.1:${PORT}`);
  assert.equal(env.FOO, "1");
  assert.deepEqual(JSON.parse(merged.text).hooks, JSON.parse(SETTINGS).hooks);
  assert.deepEqual(claudeSettingsProxyEnv({ port: PORT, credential: CRED }).HTTP_PROXY, env.HTTP_PROXY);

  // 换口令：再合并一次，值换成新的。
  const rotated = mergeClaudeSettingsEnv(merged.text, { port: PORT, credential: NEW_CRED });
  assert.deepEqual(rotated.changedKeys, ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]);

  // 撤销：不传口令（命令行 setup:undo 就是这样）、传当前口令、传错的口令——都认得出来，回到原文。
  for (const opts of [{ port: PORT }, { port: PORT, credential: NEW_CRED }, { port: PORT, credential: CRED }]) {
    const removed = removeClaudeSettingsEnv(rotated.text, opts);
    assert.equal(removed.text, SETTINGS, JSON.stringify(opts));
  }
  // 用户把地址改成了别的（别的端口 / 别的用户名）：不动。
  const custom = JSON.stringify({ env: { HTTPS_PROXY: `http://alice:secret@127.0.0.1:${PORT}`, HTTP_PROXY: "http://127.0.0.1:9999" } });
  assert.equal(removeClaudeSettingsEnv(custom, { port: PORT }).changed, false);
});

test("planClaudeSettingsMerge 带口令：写回命令把文件与备份收紧到 600；不带口令时命令逐字不变", () => {
  const readOutput = `__CWB_CLAUDE__=1\n${SETTINGS}`;
  const plain = planClaudeSettingsMerge(readOutput, { port: PORT });
  const withCred = planClaudeSettingsMerge(readOutput, { port: PORT, credential: CRED });
  assert.doesNotMatch(plain.command, /chmod 600/);
  assert.match(withCred.command, /chmod 600 "\$bak"/);
  assert.match(withCred.command, /chmod 600 ~\/\.claude\/settings\.json\.tmp\.\$\$/);
  assert.equal(withCred.command.includes(TOKEN), false);
  assert.ok(withCred.input.includes(TOKEN), "内容在标准输入里");
});

test("credentialFingerprint 与集群上算出来的一致；不带口令 / 没有 env.sh 各有各的回报", { skip }, (t) => {
  const box = sandbox(t);
  assert.deepEqual(box.envState(), { present: false, port: null, credential: null });
  box.applySteps({ port: PORT });
  assert.deepEqual(box.envState(), { present: true, port: PORT, credential: "none" });
  box.applySteps({ port: PORT, credential: CRED });
  assert.deepEqual(box.envState(), { present: true, port: PORT, credential: credentialFingerprint(CRED) });
  assert.match(credentialFingerprint(CRED), /^[0-9a-f]{16}$/);
  assert.notEqual(credentialFingerprint(CRED), credentialFingerprint(NEW_CRED));
  assert.equal(credentialFingerprint(null), null);
  // 读指纹的命令输出里没有口令。
  const out = box.remote(buildEnvPortReadCommand());
  assert.equal(out.includes(TOKEN), false);
  assertNoSecretInCommands(box.commands, [TOKEN]);
});

test("真跑往返：不带口令 → 带口令 → 换口令 → 撤销，各文件回到原样；全程没有一条命令带着口令", { skip }, (t) => {
  const box = sandbox(t);
  // ① 接入时的状态：不带口令。
  box.applySteps({ port: PORT });
  box.mergeSettings({ port: PORT });
  assert.equal(JSON.parse(box.read(".claude/settings.json")).env.HTTPS_PROXY, `http://127.0.0.1:${PORT}`);
  assert.equal(box.mode(".claude/settings.json"), 0o664, "不带口令时沿用原权限");

  // ② 把口令写到集群。
  box.applySteps({ port: PORT, credential: CRED });
  box.mergeSettings({ port: PORT, credential: CRED });
  assert.equal(box.read(".config/cluster-workbench/env.sh"), renderClusterEnv({ port: PORT, credential: CRED }));
  assert.equal(box.mode(".config/cluster-workbench/env.sh"), 0o600);
  assert.equal(box.mode(".config/cluster-workbench"), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(box.home, ".config/cluster-workbench")), ["env.sh"], "没有留下备份或临时文件");
  assert.equal(JSON.parse(box.read(".claude/settings.json")).env.HTTPS_PROXY, `http://cwb:${TOKEN}@127.0.0.1:${PORT}`);
  assert.equal(box.mode(".claude/settings.json"), 0o600, "里面有口令了：收紧到 600");
  // 新开的 shell 读到的就是带口令的地址。
  const sourced = spawnSync("sh", ["-c", '. "$HOME/.config/cluster-workbench/env.sh"; printf "%s|%s" "$https_proxy" "$HTTP_PROXY"'], { env: { HOME: box.home, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(sourced.stdout, `http://cwb:${TOKEN}@127.0.0.1:${PORT}|http://cwb:${TOKEN}@127.0.0.1:${PORT}`);
  // 这次写 settings.json 留下的备份（内容是不带口令的旧版本）也是 600。
  const backups = fs.readdirSync(path.join(box.home, ".claude")).filter((name) => name.includes(".bak."));
  assert.ok(backups.length >= 1);
  for (const name of backups) assert.ok([0o600, 0o664].includes(box.mode(`.claude/${name}`)));
  assert.equal(box.mode(`.claude/${backups.sort().at(-1)}`), 0o600);

  // ③ 换口令后再写一次。
  box.applySteps({ port: PORT, credential: NEW_CRED });
  box.mergeSettings({ port: PORT, credential: NEW_CRED });
  assert.equal(box.envState().credential, credentialFingerprint(NEW_CRED));
  assert.equal(box.read(".config/cluster-workbench/env.sh").includes(TOKEN), false, "旧口令不留在 env.sh 里");

  // ④ 撤销（不知道口令，与命令行 setup:undo 一样）：全部回到原样。
  box.undo({ port: PORT });
  assert.equal(box.read(".bashrc"), BASHRC);
  assert.equal(box.read(".bash_profile"), BASH_PROFILE);
  assert.equal(box.read(".claude/settings.json"), SETTINGS);
  assert.equal(fs.existsSync(path.join(box.home, ".config/cluster-workbench")), false, "受管目录整个删掉了（里面没有留下含口令的备份挡着）");
  box.undo({ port: PORT }); // 再撤一次：空操作
  assert.equal(box.read(".claude/settings.json"), SETTINGS);

  assertNoSecretInCommands(box.commands, [TOKEN, NEW_TOKEN]);
});

test("带口令重写 env.sh 时字节数对不上（连接中断）：原文件不动、不留临时文件", { skip }, (t) => {
  const box = sandbox(t);
  box.applySteps({ port: PORT, credential: CRED });
  const before = box.read(".config/cluster-workbench/env.sh");
  const step = buildClusterEnvSteps({ port: PORT, credential: NEW_CRED }).find((s) => s.id === "write-env");
  const res = spawnSync("sh", ["-c", step.command], { env: { HOME: box.home, PATH: process.env.PATH }, encoding: "utf8", input: step.input.slice(0, 40) });
  assert.notEqual(res.status, 0);
  assert.equal(box.read(".config/cluster-workbench/env.sh"), before);
  assert.deepEqual(fs.readdirSync(path.join(box.home, ".config/cluster-workbench")), ["env.sh"]);
});
