// 撤销接入的编排（命令行与界面共用）。命令本身由 lib/cluster-env.test.mjs 与 lib/port-registry.test.mjs 覆盖，
// 命令行那一侧的行为由 scripts/setup-undo.test.mjs 原样守着；这里测编排自己：
// 日志出口的顺序与文字、界面用的三个开关（已确认 / 已选好是否释放 / 没做成就停）、进度回调与结果里的明细。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildClusterEnvSteps, buildCommentOutCommand, buildUndoCommands, CLAUDE_SETTINGS_READ_COMMAND, mergeClaudeSettingsEnv, planClaudeSettingsMerge } from "../cluster-env.mjs";
import { buildClaimCommand, parseClaimResult } from "../port-registry.mjs";
import { dropPortOverride, leftoverChecklist, leftoverItems, planUndoSteps, undoClusterSetup } from "./undo.mjs";

const posix = process.platform !== "win32";
const SERVER = { id: "server-01", host: "h" };
const settingsWithOurKeys = (port) => `__CWB_CLAUDE__=1\n${mergeClaudeSettingsEnv(JSON.stringify({ env: { FOO: "1" } }), { port }).text}`;

function fakeSsh(respond = () => ({})) {
  const calls = [];
  const ssh = (host, command, options) => {
    calls.push({ host, command, options });
    return { status: 0, stdout: "", stderr: "", ...respond(command) };
  };
  return { ssh, calls };
}

// 记下每一次日志调用（出口名 + 文字），顺序即终端上的顺序。
function recordingUi() {
  const lines = [];
  const ui = Object.fromEntries(["header", "line", "info", "success", "warning", "error", "dryRun", "manual"].map((kind) => [kind, (text) => lines.push([kind, text])]));
  return { ui, lines };
}

const releaseReplies = (reply) => (command) => (/RELEASE=/.test(command) ? reply : command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: settingsWithOurKeys(7893) } : {});

test("命令行口径（三个开关都不给）：先列步骤 → 问两次 → 逐步结果 → 收尾清单，顺序与文字固定", async () => {
  const { ssh } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const { ui, lines } = recordingUi();
  const asked = [];
  const result = await undoClusterSetup(SERVER, {
    port: 7893,
    ssh,
    ui,
    confirm: async (question) => {
      asked.push(question);
      lines.push(["confirm", question]);
      return true;
    },
    clearLocalPort: () => true,
    localConfigPath: "/x/config.local.json",
  });
  const titles = buildUndoCommands({ port: 7893 }).map((step) => step.title);
  assert.deepEqual(lines, [
    ["header", "撤销 h 上的集群侧受管配置"],
    ...titles.map((title) => ["line", `  · ${title}`]),
    ["info", "只影响新开的 shell；已在运行的 codex / claude 与 Slurm 作业不受影响。装好的命令行工具、登录凭证与公钥不会动。"],
    ["confirm", "确认撤销以上内容？(y/N): "],
    ["success", titles[0]],
    ["success", titles[1]],
    ["success", titles[2]],
    ["success", "已从 ~/.claude/settings.json 的 env 删除 HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, NO_PROXY, no_proxy（其余键保留，旧文件已备份）"],
    ["confirm", "是否同时释放端口登记 7893？释放后别人可以领走它，本机配置里的这个端口也会一并拿掉；释放前请先停掉本机隧道。(y/N): "],
    ["success", "已释放端口登记 7893。"],
    ["success", "已从本机个人配置里拿掉端口 7893：下次启动不会再往这个端口建隧道，引导卡会提示重新领取（npm run setup）。"],
    ["warning", "工作台如果还开着，请现在停止隧道或退出工作台——正在运行的隧道仍占着这个端口。"],
    ["success", "集群侧受管配置已撤销（~/.config/cluster-workbench 已删除）。想恢复：重跑 npm run setup。"],
    ["info", "以下内容不会自动处理，按需自查："],
    ...leftoverChecklist({ host: "h", port: 7893 }).map((text) => ["line", `  · ${text}`]),
  ]);
  assert.equal(asked.length, 2);
  assert.equal(result.status, "ok");
  assert.equal(result.release, "ok");
  assert.equal(result.localPortCleared, true);
  assert.equal(result.stoppedAt, null);
});

test("不给日志出口与确认函数：静默，且默认不确认——什么都不做", async () => {
  const { ssh, calls } = fakeSsh();
  const result = await undoClusterSetup(SERVER, { port: 7893, ssh });
  assert.equal(result.status, "declined");
  assert.equal(calls.length, 0);
});

test("界面口径：已确认、已选好不释放 → 一次都不问，端口登记保留", async () => {
  const { ssh, calls } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  let asked = 0;
  const cleared = [];
  const result = await undoClusterSetup(SERVER, {
    port: 7893, ssh, assumeYes: true, releasePort: false, stopOnFailure: true,
    confirm: async () => { asked += 1; return true; },
    clearLocalPort: (...args) => { cleared.push(args); return true; },
  });
  assert.equal(asked, 0);
  assert.equal(result.status, "ok");
  assert.equal(result.release, "kept");
  assert.equal(calls.some((call) => /RELEASE=/.test(call.command)), false, "没有发释放命令");
  assert.deepEqual(cleared, []);
  assert.equal(result.localPortCleared, false);
});

test("界面口径：已选好释放 → 不问直接放，随后拿掉本机端口（clearLocalPort 可以是异步的）", async () => {
  const { ssh, calls } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const result = await undoClusterSetup(SERVER, {
    port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true, registryDir: "/public/other/ports", localConfigPath: "/x/local.json",
    confirm: async () => { throw new Error("不该提问"); },
    clearLocalPort: async (localConfigPath, serverId) => {
      assert.deepEqual([localConfigPath, serverId], ["/x/local.json", "server-01"]);
      return true;
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.release, "ok");
  assert.equal(result.localPortCleared, true);
  assert.match(calls.at(-1).command, /\/public\/other\/ports\/7893/);
});

test("没做成就停：一条远端命令失败 → 后面的集群步骤、释放端口、清本机端口都不做", async () => {
  const { ssh, calls } = fakeSsh((command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { status: 255, stderr: "banner\nConnection closed by remote host" } : { stdout: "RELEASE=ok\n" }));
  let cleared = 0;
  const result = await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true, clearLocalPort: () => { cleared += 1; return true; } });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAt, "remove-env");
  assert.deepEqual(result.steps.map((step) => [step.id, step.status]), [["strip-source-blocks", "ok"], ["remove-env", "failed"]]);
  assert.equal(calls.length, 2, "第三步起一条命令都没发");
  assert.equal(result.release, null);
  assert.equal(cleared, 0);
  // 失败的那一步带上原因原文、那条命令的退出码与可以手动执行的命令
  const failed = result.steps[1];
  assert.equal(failed.error, "banner\nConnection closed by remote host");
  assert.equal(failed.exitCode, 255, "255 = ssh 自己没连上；界面据此区分「连不上」与「命令在服务器上失败了」");
  assert.equal(failed.manual, buildUndoCommands({ port: 7893 })[1].command);
});

test("失败时带上退出码：释放端口的进度事件也带（没有结论与服务器明说没删成要分得开）", async () => {
  for (const [reply, expected] of [
    [{ status: 255, stderr: "Connection closed" }, { status: "failed", error: "Connection closed", exitCode: 255 }],
    [{ status: null, stderr: "SSH 未在 20 秒内返回" }, { status: "failed", error: "SSH 未在 20 秒内返回", exitCode: null }],
    [{ stdout: "motd only\n" }, { status: "unknown", error: "服务器没有给出明确结论", exitCode: 0 }],
    [{ stdout: "RELEASE=failed\n" }, { status: "failed", error: "服务器没有给出明确结论", exitCode: 0 }],
  ]) {
    const { ssh } = fakeSsh(releaseReplies(reply));
    const events = [];
    const result = await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true, onProgress: (event) => events.push(event) });
    assert.deepEqual(events.at(-1), { phase: "release", ...expected });
    assert.deepEqual([result.status, result.stoppedAt, result.localPortCleared], ["failed", "release-port", false]);
  }
  // 命令在服务器上跑了、是它自己失败的：退出码原样带上
  const { ssh } = fakeSsh((command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { status: 1, stderr: "rm: Permission denied" } : {}));
  const result = await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: false, stopOnFailure: true });
  assert.deepEqual([result.steps[1].status, result.steps[1].error, result.steps[1].exitCode], ["failed", "rm: Permission denied", 1]);
});

test("没做成就停：settings.json 没读到 / 没写成同样停，端口登记不动", async () => {
  for (const [respond, expected] of [
    [(command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { status: 255, stderr: "Connection reset" } : {}), { error: "Connection reset", reason: "unreadable" }],
    [(command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: "motd without sentinel\n" } : {}), { error: "退出码 0", reason: "unreadable" }],
    [(command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: settingsWithOurKeys(7893) } : /settings\.json/.test(command) ? { status: 1, stderr: "No space left on device" } : {}), { error: "No space left on device", reason: undefined }],
  ]) {
    const { ssh, calls } = fakeSsh(respond);
    const result = await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true });
    assert.equal(result.status, "failed");
    assert.equal(result.stoppedAt, "claude-settings");
    const step = result.steps.at(-1);
    assert.deepEqual([step.id, step.status, step.error, step.reason], ["claude-settings", "failed", expected.error, expected.reason]);
    assert.equal(typeof step.exitCode, "number", "读 / 写 settings.json 没成同样带退出码");
    assert.equal(result.release, null);
    assert.equal(calls.some((call) => /RELEASE=/.test(call.command)), false);
  }
});

test("没做成就停：释放没有明确结论 → 停在 release-port，本机端口不动；原因带回来", async () => {
  for (const [reply, error] of [[{ status: 255, stderr: "Connection closed" }, "Connection closed"], [{ stdout: "motd only\n" }, "服务器没有给出明确结论"], [{ stdout: "RELEASE=failed\n" }, "服务器没有给出明确结论"]]) {
    const { ssh } = fakeSsh(releaseReplies(reply));
    let cleared = 0;
    const result = await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true, clearLocalPort: () => { cleared += 1; return true; } });
    assert.equal(result.status, "failed");
    assert.equal(result.stoppedAt, "release-port");
    assert.equal(result.releaseError, error);
    assert.equal(cleared, 0);
  }
});

test("命令行沿用原行为（不给 stopOnFailure）：一步失败后面的照做，stoppedAt 为空", async () => {
  const { ssh } = fakeSsh((command) => (/rm -f ~\/\.config\/cluster-workbench\/env\.sh/.test(command) ? { status: 255, stderr: "Connection closed" } : { stdout: "__CWB_CLAUDE__=0\n" }));
  const result = await undoClusterSetup(SERVER, { port: 7893, ssh, confirm: async () => true, clearLocalPort: () => true });
  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAt, null);
  assert.deepEqual(result.steps.map((step) => step.status), ["ok", "failed", "ok", "skipped"]);
  assert.ok(["failed", "unknown"].includes(result.release), "释放也照常去试了（假 SSH 没给 RELEASE 行）");
});

test("本机端口没拿掉（写盘抛错）→ failed，原因带回来；集群上的登记已经放了", async () => {
  const { ssh } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const result = await undoClusterSetup(SERVER, {
    port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true,
    clearLocalPort: async () => { throw new Error("配置已被修改，请重新加载后保存"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.release, "ok");
  assert.equal(result.localPortCleared, false);
  assert.equal(result.localPortError, "配置已被修改，请重新加载后保存");
});

test("结果里的明细：删了哪些键、为什么跳过、没有可改的", async () => {
  const run = async (stdout) => {
    const { ssh } = fakeSsh((command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout } : {}));
    return (await undoClusterSetup(SERVER, { port: 7893, ssh, assumeYes: true, releasePort: false })).steps.at(-1);
  };
  assert.deepEqual(await run(settingsWithOurKeys(7893)), { id: "claude-settings", status: "ok", changedKeys: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] });
  assert.deepEqual(await run("__CWB_CLAUDE__=0\n"), { id: "claude-settings", status: "skipped", reason: "no-claude" });
  // reclaude 接管的 env 里没有我们写的键：撤销不需要专门跳过它，按"无需改动"处理
  assert.deepEqual(await run(`__CWB_CLAUDE__=1\n${JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: "/home/a/.reclaude/ca.pem" } })}`), { id: "claude-settings", status: "unchanged" });
  assert.deepEqual(await run("__CWB_CLAUDE__=1\n{not json"), { id: "claude-settings", status: "skipped", reason: "invalid-json" });
  assert.deepEqual(await run(`__CWB_CLAUDE__=1\n${JSON.stringify({ env: { FOO: "1" } })}`), { id: "claude-settings", status: "unchanged" });
});

test("进度回调：每一步开始与结束各一次，释放与清本机端口也有；回调自己抛错不打断撤销", async () => {
  const { ssh } = fakeSsh(releaseReplies({ stdout: "RELEASE=ok\n" }));
  const events = [];
  const result = await undoClusterSetup(SERVER, {
    port: 7893, ssh, assumeYes: true, releasePort: true, stopOnFailure: true, clearLocalPort: () => true,
    onProgress: (event) => {
      events.push(event.phase === "step" ? `${event.id}:${event.status}` : `${event.phase}:${event.status}`);
      throw new Error("界面那头出错了");
    },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(events, [
    "strip-source-blocks:running", "strip-source-blocks:ok",
    "remove-env:running", "remove-env:ok",
    "restore-strays:running", "restore-strays:ok",
    "claude-settings:running", "claude-settings:ok",
    "release:running", "release:ok",
    "local-port:ok",
  ]);
});

test("dry-run：不提问、不写、不报进度中的「running」；只做 settings.json 的只读回读并给出要删的键", async () => {
  const { ssh, calls } = fakeSsh((command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { stdout: settingsWithOurKeys(7893) } : {}));
  const events = [];
  const result = await undoClusterSetup(SERVER, { port: 7893, ssh, dryRun: true, onProgress: (event) => events.push(event.status) });
  assert.equal(result.status, "dry-run");
  assert.equal(result.release, "dry-run");
  assert.deepEqual(calls.map((call) => call.command), [CLAUDE_SETTINGS_READ_COMMAND]);
  assert.deepEqual(result.steps.map((step) => step.status), ["dry-run", "dry-run", "dry-run", "dry-run"]);
  assert.deepEqual(result.steps.at(-1).changedKeys, ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]);
  assert.equal(events.includes("running"), false);
  // 回读失败在 dry-run 下只标出来，不算整体失败（还没开始做任何事）
  const down = fakeSsh((command) => (command === CLAUDE_SETTINGS_READ_COMMAND ? { status: 255, stderr: "Operation timed out" } : {}));
  const failedRead = await undoClusterSetup(SERVER, { port: 7893, ssh: down.ssh, dryRun: true, stopOnFailure: true });
  assert.equal(failedRead.status, "dry-run");
  assert.deepEqual([failedRead.steps.at(-1).status, failedRead.steps.at(-1).error], ["failed", "Operation timed out"]);
  assert.equal(failedRead.stoppedAt, null);
});

test("planUndoSteps：没有端口时不含 settings.json 那一步（无从比对哪些键是我们写的）", () => {
  assert.deepEqual(planUndoSteps({ port: 7893 }).map((step) => step.id), ["strip-source-blocks", "remove-env", "restore-strays", "claude-settings"]);
  assert.deepEqual(planUndoSteps({ port: null }).map((step) => step.id), ["strip-source-blocks", "remove-env", "restore-strays"]);
  assert.deepEqual(planUndoSteps().map((step) => step.kind), ["remote", "remote", "remote"]);
});

test("收尾清单：带 id 的条目与只要文字的清单是同一份；没有端口时隧道那一条换说法", () => {
  const items = leftoverItems({ host: "myserver", port: 7893 });
  assert.deepEqual(items.map((item) => item.id), ["authorized-keys", "cli", "downloads", "backups", "tunnel", "local"]);
  assert.deepEqual(leftoverChecklist({ host: "myserver", port: 7893 }), items.map((item) => item.text));
  assert.match(items.find((item) => item.id === "tunnel").text, /ss -ltn \| grep 7893/);
  assert.equal(leftoverItems({ host: "myserver" }).find((item) => item.id === "tunnel").text, "确认隧道已停：在工作台里停止隧道，或退出工作台");
});

test("dropPortOverride：只拿这台服务器的；删空则去掉 portOverrides；没有可删的返回 null", () => {
  const before = { sshUser: "a", portOverrides: { "server-01": { remotePort: 7893, localPort: 8893 }, other: { remotePort: 7900 } } };
  assert.deepEqual(dropPortOverride(before, "server-01"), { sshUser: "a", portOverrides: { other: { remotePort: 7900 } } });
  assert.deepEqual(before.portOverrides["server-01"], { remotePort: 7893, localPort: 8893 }, "不改入参");
  assert.deepEqual(dropPortOverride({ sshUser: "a", portOverrides: { "server-01": {} } }, "server-01"), { sshUser: "a" });
  assert.equal(dropPortOverride({ sshUser: "a" }, "server-01"), null);
  assert.equal(dropPortOverride({ portOverrides: [] }, "server-01"), null);
});

test("真实 sh（界面口径）：写入 → 撤销并释放 → 启动文件与 settings.json 逐字回到原样，登记文件删除", { skip: !posix }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-undo-core-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const registryDir = path.join(root, "ports");
  fs.mkdirSync(home);
  fs.mkdirSync(registryDir, { mode: 0o755 });
  const ssh = (_host, command, options = {}) => {
    const res = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8", input: options.input });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const bashrc = "# mine\nexport http_proxy=http://127.0.0.1:7890\nalias ll='ls -l'\n";
  const profile = "export PATH=$HOME/bin:$PATH\n";
  const settings = `${JSON.stringify({ env: { FOO: "1" }, hooks: {} }, null, 4)}\n`;
  fs.writeFileSync(path.join(home, ".bashrc"), bashrc);
  fs.writeFileSync(path.join(home, ".bash_profile"), profile);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), settings);

  // 接入时写下的东西：受管文件与引入块、注释掉的旧导出、settings.json 的代理键、登记文件。
  const opts = { port: 7893 };
  for (const step of buildClusterEnvSteps(opts)) assert.equal(ssh("h", step.command).status, 0, step.id);
  assert.equal(ssh("h", buildCommentOutCommand(".bashrc", [2])).status, 0);
  const merge = planClaudeSettingsMerge(ssh("h", CLAUDE_SETTINGS_READ_COMMAND).stdout, opts);
  assert.equal(ssh("h", merge.command, { input: merge.input }).status, 0);
  assert.equal(parseClaimResult(ssh("h", buildClaimCommand(registryDir, [7893])).stdout).status, "claimed");
  assert.notEqual(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), bashrc);

  const result = await undoClusterSetup(SERVER, { ...opts, ssh, registryDir, assumeYes: true, releasePort: true, stopOnFailure: true, clearLocalPort: () => true });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.steps.map((step) => step.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(result.release, "ok");
  assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), bashrc);
  assert.equal(fs.readFileSync(path.join(home, ".bash_profile"), "utf8"), profile);
  assert.equal(fs.readFileSync(path.join(home, ".claude/settings.json"), "utf8"), settings);
  assert.equal(fs.existsSync(path.join(home, ".config/cluster-workbench")), false);
  assert.equal(fs.existsSync(path.join(registryDir, "7893")), false);

  // 再来一次：全是空操作，登记已经不在
  const again = await undoClusterSetup(SERVER, { ...opts, ssh, registryDir, assumeYes: true, releasePort: true, stopOnFailure: true, clearLocalPort: () => false });
  assert.equal(again.status, "ok");
  assert.equal(again.steps.at(-1).status, "unchanged");
  assert.equal(again.release, "absent");
  assert.equal(fs.readFileSync(path.join(home, ".bashrc"), "utf8"), bashrc);
});
