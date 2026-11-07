// `npm run setup:undo`：撤销向导在集群上写下的受管配置。命令本身由 lib/cluster-env.test.mjs 覆盖，
// 这里测编排：确认 / dry-run / 没有端口 / 失败如实上报 / 端口登记默认保留。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildClusterEnvSteps, CLAUDE_SETTINGS_READ_COMMAND, mergeClaudeSettingsEnv, planClaudeSettingsMerge } from "../work/monitor/lib/cluster-env.mjs";
import { dropPortOverride, leftoverChecklist, undoClusterSetup } from "./setup-undo.mjs";

const skip = process.platform === "win32" ? "远端脚本用本机 sh 执行，需要 POSIX 环境" : false;
const SERVER = { id: "server-01", host: "h" };

async function captured(fn) {
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...args) => { lines.push(args.map(String).join(" ")); };
  try {
    return { result: await fn(), text: lines.join("\n") };
  } finally {
    Object.assign(console, original);
  }
}

function fakeSsh(respond = () => ({})) {
  const calls = [];
  const ssh = (host, command, options) => {
    calls.push({ host, command, options });
    return { status: 0, stdout: "", stderr: "", ...respond(command) };
  };
  return { ssh, calls };
}

// 依次作答的假提问；问到没准备答案的问题按回车（= 否）。
function answers(...list) {
  const asked = [];
  const ask = async (query) => {
    asked.push(query);
    return list.shift() ?? "";
  };
  return { ask, asked };
}

const settingsWithOurKeys = (port) => `__CWB_CLAUDE__=1\n${mergeClaudeSettingsEnv(JSON.stringify({ env: { FOO: "1" } }), { port }).text}`;

test("回车（不确认）→ 一条 SSH 都不发", async () => {
  const { ssh, calls } = fakeSsh();
  const { ask } = answers("");
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask, dryRun: false }));
  assert.equal(result.status, "declined");
  assert.equal(calls.length, 0);
  assert.match(text, /已取消/);
});

test("确认后按序执行四步，settings.json 的新内容经标准输入送达；端口登记默认保留", async () => {
  const { ssh, calls } = fakeSsh((command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: settingsWithOurKeys(7893) } : {}));
  const { ask, asked } = answers("y", "");
  const { result } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask, dryRun: false }));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.steps.map((s) => [s.id, s.status]), [
    ["strip-source-blocks", "ok"], ["remove-env", "ok"], ["restore-strays", "ok"], ["claude-settings", "ok"],
  ]);
  assert.equal(result.release, "kept");
  assert.equal(asked.length, 2, "先问是否撤销，再问是否释放端口");
  assert.equal(calls.length, 5, "三条远端命令 + 回读 + 写回，没有释放命令");
  const write = calls.at(-1);
  assert.deepEqual(JSON.parse(write.options.input), { env: { FOO: "1" } }, "只删我们写的代理键，别的键保留");
});

// 假写盘：记录被清掉端口的服务器 id。
function fakeClear(outcome = true) {
  const cleared = [];
  const clearLocalPort = (_path, serverId) => {
    cleared.push(serverId);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { clearLocalPort, cleared };
}

const releaseReplies = (reply) => (command) => (/RELEASE=/.test(command) ? reply : { stdout: "__CWB_CLAUDE__=0\n" });

test("释放成功 → 本机个人配置里的端口一并拿掉（否则下次启动仍往这个端口建隧道）", async () => {
  const { ssh, calls } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const { clearLocalPort, cleared } = fakeClear();
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "y").ask, clearLocalPort, dryRun: false }));
  assert.equal(result.status, "ok");
  assert.equal(result.release, "ok");
  assert.equal(result.localPortCleared, true);
  assert.deepEqual(cleared, ["server-01"]);
  assert.match(calls.at(-1).command, /\/public\/agent-hub\/ports\/7893/);
  assert.match(text, /拿掉端口 7893/);
  assert.match(text, /停止隧道或退出工作台/);
});

test("端口登记在别人名下 / 本来就没登记 → 不动登记，但本机同样不再保留这个端口", async () => {
  for (const reply of ["not-owner", "absent"]) {
    const { ssh } = fakeSsh(releaseReplies({ stdout: `RELEASE=${reply}\n` }));
    const { clearLocalPort, cleared } = fakeClear();
    const { result } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "y").ask, clearLocalPort, dryRun: false }));
    assert.equal(result.release, reply);
    assert.equal(result.status, "ok", reply);
    assert.deepEqual(cleared, ["server-01"], reply);
  }
});

test("释放失败（SSH 断了 / 没有明确结论）→ 整体 failed，本机配置不动", async () => {
  for (const reply of [{ status: 255, stderr: "Connection closed" }, { stdout: "motd only\n" }, { stdout: "RELEASE=failed\n" }]) {
    const { ssh } = fakeSsh(releaseReplies(reply));
    const { clearLocalPort, cleared } = fakeClear();
    const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "y").ask, clearLocalPort, dryRun: false }));
    assert.equal(result.status, "failed", JSON.stringify(reply));
    assert.ok(["failed", "unknown"].includes(result.release));
    assert.deepEqual(cleared, [], "登记还在自己名下，配置保持一致");
    assert.equal(result.localPortCleared, false);
    assert.doesNotMatch(text, /受管配置已撤销/);
  }
});

test("保留登记（回车）→ 本机端口也保留", async () => {
  const { ssh } = fakeSsh(releaseReplies({}));
  const { clearLocalPort, cleared } = fakeClear();
  const { result } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "").ask, clearLocalPort, dryRun: false }));
  assert.equal(result.release, "kept");
  assert.deepEqual(cleared, []);
});

test("释放成功但本机配置写不回 → failed，并说明要手动删哪一项", async () => {
  const { ssh } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const { clearLocalPort } = fakeClear(new Error("EACCES"));
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "y").ask, clearLocalPort, localConfigPath: "/x/config.local.json", dryRun: false }));
  assert.equal(result.status, "failed");
  assert.match(text, /手动删除 \/x\/config\.local\.json 里 portOverrides 的 "server-01"/);
});

test("真实写盘：释放后 config.local.json 的 portOverrides 少掉这台服务器，其余字段原样", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-undo-local-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  const before = { sshUser: "amy", portOverrides: { "server-01": { remotePort: 7893, localPort: 8893 }, other: { remotePort: 7900, localPort: 8900 } }, egress: { mode: "system" } };
  fs.writeFileSync(localConfigPath, JSON.stringify(before));
  const { ssh } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const { result } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask: answers("y", "y").ask, localConfigPath, dryRun: false }));
  assert.equal(result.localPortCleared, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(localConfigPath, "utf8")), { sshUser: "amy", portOverrides: { other: before.portOverrides.other }, egress: { mode: "system" } });
});

test("dropPortOverride: 删空则去掉 portOverrides；没有这台服务器的端口返回 null", () => {
  assert.deepEqual(dropPortOverride({ sshUser: "a", portOverrides: { "server-01": { remotePort: 7893 } } }, "server-01"), { sshUser: "a" });
  assert.equal(dropPortOverride({ sshUser: "a" }, "server-01"), null);
  assert.equal(dropPortOverride({ portOverrides: { other: {} } }, "server-01"), null);
  assert.equal(dropPortOverride({ portOverrides: [] }, "server-01"), null);
});

test("dry-run：不提问、不写，只做 settings.json 的只读回读", async () => {
  const { ssh, calls } = fakeSsh((command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: settingsWithOurKeys(7893) } : {}));
  const { ask, asked } = answers();
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask, dryRun: true }));
  assert.equal(result.status, "dry-run");
  assert.equal(result.release, "dry-run");
  assert.equal(asked.length, 0);
  assert.deepEqual(calls.map((c) => c.command), [CLAUDE_SETTINGS_READ_COMMAND]);
  assert.match(text, /\[dry-run\].*HTTPS_PROXY/s);
});

test("个人配置里没有端口 → 跳过 settings.json 与端口释放，其余照做", async () => {
  const { ssh, calls } = fakeSsh();
  const { ask } = answers("y");
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: null, ssh, ask, dryRun: false }));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.steps.map((s) => s.id), ["strip-source-blocks", "remove-env", "restore-strays"]);
  assert.equal(result.release, null);
  assert.equal(calls.length, 3);
  assert.match(text, /没有这台服务器的反向端口/);
});

test("某一步失败 → 状态 failed、打印手动命令，后面的步骤继续做", async () => {
  const { ssh, calls } = fakeSsh((command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { status: 255, stderr: "Connection closed" } : { stdout: "__CWB_CLAUDE__=0\n" }));
  const { ask } = answers("y", "");
  const { result, text } = await captured(() => undoClusterSetup(SERVER, { port: 7893, ssh, ask, dryRun: false }));
  assert.equal(result.status, "failed");
  assert.equal(result.steps.find((s) => s.id === "remove-env").status, "failed");
  assert.equal(result.steps.find((s) => s.id === "restore-strays").status, "ok");
  assert.match(text, /Connection closed/);
  assert.match(text, /请在服务器上手动执行/);
  assert.doesNotMatch(text, /受管配置已撤销/);
  assert.ok(calls.length >= 4);
});

test("真实 sh：向导写入之后撤销 → 启动文件与 settings.json 回到原样，受管目录删除", { skip }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "setup-undo-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const ssh = (_host, command, options = {}) => {
    const res = spawnSync("sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", input: options.input });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const bashrc = "# mine\nalias ll='ls -l'\n";
  const settings = `${JSON.stringify({ env: { FOO: "1" } }, null, 2)}\n`;
  fs.writeFileSync(path.join(home, ".bashrc"), bashrc);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), settings);

  const opts = { port: 7893 };
  for (const step of buildClusterEnvSteps(opts)) assert.equal(ssh("h", step.command).status, 0, step.id);
  const merge = planClaudeSettingsMerge(ssh("h", CLAUDE_SETTINGS_READ_COMMAND).stdout, opts);
  assert.equal(ssh("h", merge.command, { input: merge.input }).status, 0);
  assert.ok(fs.existsSync(path.join(home, ".config/cluster-workbench/env.sh")));

  const { ask } = answers("y", "");
  const { result } = await captured(() => undoClusterSetup(SERVER, { ...opts, ssh, ask, dryRun: false }));
  assert.equal(result.status, "ok");
  assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), bashrc);
  assert.equal(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"), settings);
  assert.equal(fs.existsSync(path.join(home, ".config/cluster-workbench")), false);

  // 再撤一次：全是空操作
  const again = await captured(() => undoClusterSetup(SERVER, { ...opts, ssh, ask: answers("y", "").ask, dryRun: false }));
  assert.equal(again.result.status, "ok");
  assert.equal(again.result.steps.at(-1).status, "unchanged");
});

test("收尾清单：点名公钥、CLI 与凭证、半截下载、备份、端口监听、本机文件", () => {
  const text = leftoverChecklist({ host: "myserver", port: 7893 }).join("\n");
  for (const needle of ["authorized_keys", "~/.codex", "~/.claude", "半截", ".bak.", "grep 7893", "config.local.json"]) {
    assert.ok(text.includes(needle), needle);
  }
});
