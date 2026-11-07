// 撤销接入之前的只读查看：命令在临时「集群 HOME」里用真实 /bin/sh 跑（不 ssh、不碰真实 HOME），
// 核对三件事——看到的与撤销命令会动的是同一批东西；确实只读；key 文件只列名字、不读内容。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildClusterEnvSteps, buildCommentOutCommand, buildUndoCommands, CLAUDE_SETTINGS_READ_COMMAND, planClaudeSettingsMerge, STRAY_DISABLED_PREFIX } from "../cluster-env.mjs";
import { buildUndoSurveyCommand, parseUndoSurvey, UNDO_SURVEY_DONE } from "./undo-survey.mjs";

const posix = process.platform !== "win32";
// 对方的登录 shell 可能是 csh / tcsh：命令整体包在 sh -c 里，经它们转一道结果也得一样。
const CSH_SHELLS = posix ? ["/bin/csh", "/bin/tcsh"].filter((shell) => fs.existsSync(shell)) : [];

function makeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cwb-undo-survey-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const run = (home, command, { shell = "/bin/sh", input } = {}) => {
  const res = spawnSync(shell, ["-c", command], { env: { HOME: home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }, encoding: "utf8", input: input ?? "" });
  return { code: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
};

// 目录树的完整快照（相对路径 → 内容 / 类型 / 权限位 / 修改时刻）：用来证明一条命令什么都没改。
function snapshot(dir, base = dir, out = {}) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const stat = fs.lstatSync(full);
    const rel = path.relative(base, full);
    if (stat.isDirectory()) {
      out[`${rel}/`] = `dir ${stat.mode.toString(8)}`;
      snapshot(full, base, out);
    } else {
      out[rel] = `${stat.mode.toString(8)} ${stat.mtimeMs} ${fs.readFileSync(full, "utf8")}`;
    }
  }
  return out;
}

// 接入时写下的东西：受管文件与两处引入块、注释掉的旧导出、两个 key 文件、settings.json 的代理键。
function onboard(home, { port = 7893 } = {}) {
  fs.writeFileSync(path.join(home, ".bashrc"), "# mine\nexport http_proxy=http://alice:s3cret@10.0.0.9:7890\nexport FOO=1\texport ALL_PROXY=socks5h://127.0.0.1:1080\nalias ll='ls -l'\n");
  fs.writeFileSync(path.join(home, ".bash_profile"), "export PATH=$HOME/bin:$PATH\n");
  for (const step of buildClusterEnvSteps({ port })) assert.equal(run(home, step.command).code, 0, step.id);
  assert.equal(run(home, buildCommentOutCommand(".bashrc", [2, 3])).code, 0);
  const keys = path.join(home, ".config/cluster-workbench/keys");
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, "codex-relay.env"), "export RELAY_KEY='sk-do-not-print-me'\n", { mode: 0o600 });
  fs.writeFileSync(path.join(keys, "claude-oauth.env"), "export CLAUDE_CODE_OAUTH_TOKEN='tok-do-not-print-me'\n", { mode: 0o600 });
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude/settings.json"), "{}\n");
  const merge = planClaudeSettingsMerge(run(home, CLAUDE_SETTINGS_READ_COMMAND).stdout, { port });
  assert.equal(run(home, merge.command, { input: merge.input }).code, 0);
}

test("命令是一条 sh -c，没有任何来自外部的插值；判定用的是撤销命令同一个标记与同一个前缀", () => {
  const command = buildUndoSurveyCommand();
  assert.equal(command, buildUndoSurveyCommand(), "常量命令");
  assert.match(command, /^sh -c '/);
  assert.ok(command.includes("# >>> cluster-workbench env >>>"));
  assert.ok(command.includes(STRAY_DISABLED_PREFIX));
  assert.ok(command.includes(".bashrc .bash_profile .bash_login .profile"));
  // 只读：没有删除 / 移动 / 改权限，也没有重定向写文件（标记行本身带 > 号，先拿掉再看）
  assert.doesNotMatch(command, /\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bmkdir\b|\btee\b|\bsed -i\b/);
  assert.doesNotMatch(command.replaceAll("# >>> cluster-workbench env >>>", ""), />/);
  assert.doesNotMatch(command, /\bcat\b/, "不读任何文件的全文（keys/ 只列名字）");
});

test("parseUndoSurvey：没看到哨兵 = 没查完（null）；只认白名单里的启动文件；原行里的制表符不丢", () => {
  assert.equal(parseUndoSurvey(""), null);
  assert.equal(parseUndoSurvey("BLOCK\t.bashrc\nENV=1\n"), null, "输出被截断");
  assert.equal(parseUndoSurvey(`ENV=1\nxx${UNDO_SURVEY_DONE}\n`), null, "哨兵必须独占一行");
  const text = [
    "Last login: motd noise",
    "BLOCK\t.bashrc",
    "BLOCK\t.bashrc",
    "BLOCK\t.zshrc",
    "BLOCK\t../etc/passwd",
    `STRAY\t.bashrc\t145\t${STRAY_DISABLED_PREFIX}export http_proxy=http://127.0.0.1:7890`,
    `STRAY\t.profile\t3\t${STRAY_DISABLED_PREFIX}export A=1\texport all_proxy=socks5://x`,
    `STRAY\t.zshrc\t9\t${STRAY_DISABLED_PREFIX}export http_proxy=x`,
    `STRAY\t.bashrc\tabc\t${STRAY_DISABLED_PREFIX}export http_proxy=x`,
    "STRAY\t.bashrc\t7\texport http_proxy=not-disabled",
    "ENV=1",
    "KEY\tcodex-relay.env",
    "KEY\tcodex-relay.env",
    "KEY\t",
    "KEY\tclaude-oauth.env",
    UNDO_SURVEY_DONE,
    "trailing noise",
  ].join("\r\n");
  assert.deepEqual(parseUndoSurvey(text), {
    blocks: [".bashrc"],
    strays: [
      { file: ".bashrc", line: 145, text: "export http_proxy=http://127.0.0.1:7890" },
      { file: ".profile", line: 3, text: "export A=1\texport all_proxy=socks5://x" },
    ],
    envFile: true,
    keys: ["codex-relay.env", "claude-oauth.env"],
  });
  assert.deepEqual(parseUndoSurvey(`ENV=0\n${UNDO_SURVEY_DONE}\n`), { blocks: [], strays: [], envFile: false, keys: [] });
});

test("parseUndoSurvey：远端塞来成千上万行也只收有限条", () => {
  const lines = [];
  for (let i = 1; i <= 1000; i += 1) lines.push(`STRAY\t.bashrc\t${i}\t${STRAY_DISABLED_PREFIX}export http_proxy=${"x".repeat(2000)}`, `KEY\tk${i}.env`);
  const parsed = parseUndoSurvey(`${lines.join("\n")}\n${UNDO_SURVEY_DONE}\n`);
  assert.equal(parsed.strays.length, 200);
  assert.equal(parsed.keys.length, 200);
  assert.ok(parsed.strays[0].text.length <= 400);
});

test("真实 sh：什么都没写过的家目录 → 查完，什么都没有", { skip: !posix }, (t) => {
  const home = makeHome(t);
  const res = run(home, buildUndoSurveyCommand());
  assert.equal(res.code, 0);
  assert.deepEqual(parseUndoSurvey(res.stdout), { blocks: [], strays: [], envFile: false, keys: [] });
});

test("真实 sh：接入之后 → 列出两处引入块、受管文件、key 文件名、被注释的两行；只读，且不带出 key 的内容", { skip: !posix }, (t) => {
  const home = makeHome(t);
  onboard(home);
  const before = snapshot(home);
  const res = run(home, buildUndoSurveyCommand());
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual(parseUndoSurvey(res.stdout), {
    blocks: [".bashrc", ".bash_profile"],
    strays: [
      { file: ".bashrc", line: 2, text: "export http_proxy=http://alice:s3cret@10.0.0.9:7890" },
      { file: ".bashrc", line: 3, text: "export FOO=1\texport ALL_PROXY=socks5h://127.0.0.1:1080" },
    ],
    envFile: true,
    keys: ["claude-oauth.env", "codex-relay.env"],
  });
  assert.deepEqual(snapshot(home), before, "家目录里一个字节、一个时间戳都没变");
  assert.doesNotMatch(res.stdout, /do-not-print-me/, "key 文件只列名字");
});

test("真实 sh：登录 shell 用的是 ~/.profile（没有 .bash_profile）时引入块记在它名下", { skip: !posix }, (t) => {
  const home = makeHome(t);
  fs.writeFileSync(path.join(home, ".bashrc"), "# mine\n");
  for (const step of buildClusterEnvSteps({ port: 7893 })) assert.equal(run(home, step.command).code, 0, step.id);
  assert.deepEqual(parseUndoSurvey(run(home, buildUndoSurveyCommand()).stdout).blocks, [".bashrc", ".profile"]);
});

test("真实 sh：看到的就是撤销会动的——撤销命令跑完再看，一样都不剩", { skip: !posix }, (t) => {
  const home = makeHome(t);
  onboard(home);
  for (const step of buildUndoCommands({ port: 7893 })) {
    if (step.kind === "remote") {
      assert.equal(run(home, step.command).code, 0, step.id);
      continue;
    }
    const plan = step.plan(run(home, step.readCommand).stdout);
    assert.equal(plan.action, "write");
    assert.equal(run(home, plan.command, { input: plan.input }).code, 0);
  }
  assert.deepEqual(parseUndoSurvey(run(home, buildUndoSurveyCommand()).stdout), { blocks: [], strays: [], envFile: false, keys: [] });
});

test("真实 sh：只有半截状态（向导中途断了：有受管文件、没有引入块）也如实列出", { skip: !posix }, (t) => {
  const home = makeHome(t);
  const [writeEnv] = buildClusterEnvSteps({ port: 7893 });
  assert.equal(run(home, writeEnv.command).code, 0);
  assert.deepEqual(parseUndoSurvey(run(home, buildUndoSurveyCommand()).stdout), { blocks: [], strays: [], envFile: true, keys: [] });
});

test("真实 sh：家目录进不去 → 非零退出、没有哨兵（调用方按没查到处理）", { skip: !posix }, (t) => {
  const home = makeHome(t);
  const res = run(path.join(home, "missing"), buildUndoSurveyCommand());
  assert.notEqual(res.code, 0);
  assert.equal(parseUndoSurvey(res.stdout), null);
});

test("真实 csh / tcsh 登录 shell：结论与 sh 一致", { skip: CSH_SHELLS.length === 0 }, (t) => {
  const home = makeHome(t);
  onboard(home);
  const expected = parseUndoSurvey(run(home, buildUndoSurveyCommand()).stdout);
  for (const shell of CSH_SHELLS) {
    const res = run(home, buildUndoSurveyCommand(), { shell });
    assert.equal(res.code, 0, `${shell}: ${res.stderr}`);
    assert.deepEqual(parseUndoSurvey(res.stdout), expected, shell);
  }
});
