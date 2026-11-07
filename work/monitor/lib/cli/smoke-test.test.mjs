// smoke-test.mjs：生成的远端命令在假 HOME 里用真实 /bin/sh 执行，假 codex / claude 模拟成功与常见失败。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildSmokeTestCommand, classifySmokeOutput, parseSmokeTest, redactSecrets, SMOKE_TOKEN } from "./smoke-test.mjs";
import { makeHome, runLocal, writeEnvSh, writeExec } from "./test-support.mjs";

const skip = process.platform === "win32" ? "需要 POSIX sh" : false;

function fakeCli(home, name, body) {
  writeExec(path.join(home, ".local", "bin", name), `#!/bin/sh\n${body}\n`);
}

test("codex 回了约定的词 → 通过；只读沙箱参数与提示词都在命令行上；临时目录删掉", { skip }, (t) => {
  const { home } = makeHome(t);
  writeEnvSh(home, ["export MARK_FROM_ENV=1"]);
  fakeCli(home, "codex", `echo "args: $*" > "$HOME/codex-args"; [ "$MARK_FROM_ENV" = 1 ] || exit 3; pwd > "$HOME/codex-cwd"; echo "thinking..." >&2; echo "${SMOKE_TOKEN}"`);
  const r = parseSmokeTest("codex", runLocal(home, buildSmokeTestCommand("codex")));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.envSh, true);
  assert.equal(r.reply, SMOKE_TOKEN);
  const args = fs.readFileSync(path.join(home, "codex-args"), "utf8");
  assert.match(args, /exec --skip-git-repo-check --sandbox read-only --color never This is a connectivity test/);
  const cwd = fs.readFileSync(path.join(home, "codex-cwd"), "utf8").trim();
  assert.equal(fs.existsSync(cwd), false, "临时目录跑完删掉");
});

test("claude 报 401 → auth；Key 片段在输出里被打码", { skip }, (t) => {
  const { home } = makeHome(t);
  writeEnvSh(home);
  // 假密钥运行时拼出来：源码里写整串会被 release-scan 当成硬编码密钥拦下。
  const fakeKey = ["sk", "ant", "api03", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"].join("-");
  fakeCli(home, "claude", `echo "API Error: 401 {\\"error\\":\\"invalid x-api-key ${fakeKey}\\"}" >&2; exit 1`);
  const r = parseSmokeTest("claude", runLocal(home, buildSmokeTestCommand("claude")));
  assert.equal(r.ok, false);
  assert.equal(r.code, "auth");
  assert.ok(r.tail.length > 0);
  assert.ok(!r.tail.join("\n").includes("ABCDEFGHIJKLMNOP"), r.tail.join("\n"));
});

test("没装 → missing；没有 env.sh 时失败提示里说明没经隧道", { skip }, (t) => {
  const { home } = makeHome(t);
  assert.equal(parseSmokeTest("codex", runLocal(home, buildSmokeTestCommand("codex"))).code, "missing");
  fakeCli(home, "codex", 'echo "stream disconnected before completion: error sending request" >&2; exit 1');
  const r = parseSmokeTest("codex", runLocal(home, buildSmokeTestCommand("codex")));
  assert.equal(r.code, "network");
  assert.equal(r.envSh, false);
  assert.match(r.hint, /没有受管 env\.sh/);
});

test("SSH 没回完整输出 → ssh；超时退出码 124 → timeout", () => {
  assert.equal(parseSmokeTest("codex", { stdout: "v=1\n", timedOut: true }).code, "ssh");
  assert.equal(parseSmokeTest("codex", { stdout: "v=1\nenvsh=1\nrc=124\nsmoke=fail\nend=1\n" }).code, "timeout");
});

test("归类：额度 / 模型 / 登录 / 未知", () => {
  assert.equal(classifySmokeOutput("Error: 429 Too Many Requests").code, "quota");
  assert.equal(classifySmokeOutput("insufficient_quota").code, "quota");
  assert.equal(classifySmokeOutput("The model `gpt-x` does not exist").code, "model");
  assert.equal(classifySmokeOutput("Invalid API key · Please run /login").code, "auth");
  assert.equal(classifySmokeOutput("Not logged in · Please run /login").code, "login");
  assert.equal(classifySmokeOutput("hello").code, "unknown");
});

test("打码：sk- 密钥、Bearer 令牌、长串", () => {
  assert.equal(redactSecrets("key sk-proj-abcdefghijklmnop end"), "key sk-proj-… end");
  assert.equal(redactSecrets("Authorization: Bearer abc.def"), "Authorization: Bearer …");
  assert.equal(redactSecrets(`x ${"A".repeat(50)} y`), "x … y");
  assert.throws(() => buildSmokeTestCommand("zcode"), /未知 CLI/);
});
