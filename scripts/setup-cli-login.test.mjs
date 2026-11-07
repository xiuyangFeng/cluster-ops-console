// 配置向导"登录"一步（scripts/setup/cli-login.mjs）：可跳过、账号授权在当前终端直通、长期令牌与 API key
// 只经 ssh 标准输入、http 明文要确认、个人层写入。全部用假 ask / ssh / spawn，零真实 SSH。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createPersonalWriters, loginStep, pickOption } from "./setup/cli-login.mjs";

const SERVER = { id: "server-01", host: "hpc" };
const KEY = "sk-test-SECRET-1234567890";

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

function fakeSsh(handler = () => ({ status: 0, stdout: "", stderr: "" })) {
  const calls = [];
  const ssh = (host, command, opts = {}) => {
    calls.push({ host, command, input: opts.input });
    return handler(command, opts);
  };
  ssh.calls = calls;
  return ssh;
}

async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: await fn(), out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

const noWriters = { getNoProxyExtra: () => [], saveNoProxyExtra: async () => {}, addAllowlistEntry: async () => ({ added: false }) };

test("pickOption：回车取第 1 项，编号越界为 null", () => {
  assert.equal(pickOption("", ["a", "b"]), "a");
  assert.equal(pickOption(" 2 ", ["a", "b"]), "b");
  assert.equal(pickOption("3", ["a", "b"]), null);
  assert.equal(pickOption("x", ["a", "b"]), null);
});

test("默认跳过：直接回车不登录、不发任何 SSH", async () => {
  const ssh = fakeSsh();
  const { result, out } = await quiet(() => loginStep(SERVER, 7892, { ask: makeAsk([""]), ssh, dryRun: false, writers: noWriters }));
  assert.equal(result.status, "skipped");
  assert.equal(ssh.calls.length, 0);
  assert.match(out, /Agent 卡片/);
});

test("Codex 账号：本机 1455 空闲 → 当前终端直通 ssh -tt + 两条 -L；之后核对登录状态", async () => {
  const spawned = [];
  const ssh = fakeSsh((command) => ({ status: 0, stdout: /codex login status/.test(command) ? "Logged in using ChatGPT\n" : "", stderr: "" }));
  const { result } = await quiet(() => loginStep(SERVER, 7892, {
    ask: makeAsk(["y", "1", "1"]),
    ssh,
    dryRun: false,
    writers: noWriters,
    checkLocalPort: async () => "free",
    spawnImpl: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { status: 0 };
    },
  }));
  assert.equal(result.status, "ok");
  assert.equal(spawned[0].cmd, "ssh");
  assert.equal(spawned[0].opts.stdio, "inherit");
  const args = spawned[0].args;
  assert.ok(args.includes("-tt") && args.includes("ControlPath=none") && args.includes("BatchMode=yes"));
  assert.deepEqual(args.filter((_, i) => args[i - 1] === "-L"), ["127.0.0.1:1455:127.0.0.1:1455", "[::1]:1455:127.0.0.1:1455"]);
  assert.equal(args.at(-2), "hpc");
  assert.match(args.at(-1), /codex login/);
  assert.equal(ssh.calls.length, 1, "只多一次状态核对");
});

test("Codex 账号：本机 1455 被占 → 不起 ssh；集群 1455 被占（退出码 75）→ 提示稍后重试", async () => {
  let spawned = 0;
  let res = await quiet(() => loginStep(SERVER, 7892, { ask: makeAsk(["y", "1", "1"]), ssh: fakeSsh(), dryRun: false, writers: noWriters, checkLocalPort: async () => "busy", spawnImpl: () => { spawned += 1; return { status: 0 }; } }));
  assert.equal(res.result.status, "failed");
  assert.equal(spawned, 0);
  assert.match(res.out, /本机 1455/);
  res = await quiet(() => loginStep(SERVER, 7892, { ask: makeAsk(["y", "1", "1"]), ssh: fakeSsh(), dryRun: false, writers: noWriters, checkLocalPort: async () => "free", spawnImpl: () => ({ status: 75 }) }));
  assert.equal(res.result.status, "failed");
  assert.match(res.out, /同事正在登录/);
});

test("Claude 长期令牌：终端里跑 setup-token，令牌经不回显输入收回、只走 ssh 标准输入写进 keys/", async () => {
  const token = `sk-ant-oat01-${"Q".repeat(50)}`;
  const ssh = fakeSsh((command) => ({ status: 0, stdout: /claude auth status/.test(command) ? '{"loggedIn": true, "authMethod": "oauth_token"}' : "", stderr: "" }));
  const { result } = await quiet(() => loginStep(SERVER, 7892, {
    ask: makeAsk(["y", "2", "2"]),
    askSecret: async () => ` ${token} `,
    ssh,
    dryRun: false,
    writers: noWriters,
    spawnImpl: (_cmd, args) => {
      assert.match(args.at(-1), /claude setup-token/);
      assert.ok(!args.includes("-L"));
      return { status: 0 };
    },
  }));
  assert.equal(result.status, "ok");
  const write = ssh.calls.find((c) => /claude-oauth\.env/.test(c.command));
  assert.equal(write.input, `export CLAUDE_CODE_OAUTH_TOKEN='${token}'\n`);
  for (const c of ssh.calls) assert.ok(!c.command.includes(token));
});

test("Codex 中转站 http://：先确认明文；key 只在标准输入；内网地址写个人层 noProxyExtra", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wizard-login-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const localConfigPath = path.join(dir, "config.local.json");
  writeFileSync(localConfigPath, JSON.stringify({ sshUser: "simple", revision: 2 }));
  const ssh = fakeSsh((command) => {
    if (command.includes("__CWB_FILE__")) return { status: 0, stdout: "__CWB_ENV__=1\n__CWB_CLI__=1\n__CWB_FILE__=-\n", stderr: "" };
    if (command.includes("__CWB_HTTP__")) return { status: 0, stdout: "__CWB_HTTP__=200\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
  const ask = makeAsk(["y", "1", "3", "http://10.0.0.5:8080/v1", "lab", "y"]);
  const { result, out } = await quiet(() => loginStep(SERVER, 7892, {
    ask,
    askSecret: async () => KEY,
    ssh,
    dryRun: false,
    writers: createPersonalWriters("server-01", { localConfigPath }),
    sleep: async () => {},
  }));
  assert.equal(result.status, "ok", out);
  assert.ok(ask.asked.some((q) => /明文|可信/.test(q)), "问过明文确认");
  for (const c of ssh.calls) assert.ok(!c.command.includes(KEY), "命令串里没有 key");
  assert.equal(ssh.calls.find((c) => /keys\/codex-lab\.env/.test(c.command)).input, `export CWB_LAB_API_KEY='${KEY}'\n`);
  const personal = JSON.parse(readFileSync(localConfigPath, "utf8"));
  assert.deepEqual(personal.noProxyExtra, { "server-01": ["10.0.0.5"] });
  assert.equal(personal.revision, 3);
  assert.ok(!out.includes(KEY));
});

test("明文不确认 → 取消；dry-run 不发 SSH", async () => {
  let ssh = fakeSsh();
  let res = await quiet(() => loginStep(SERVER, 7892, { ask: makeAsk(["y", "2", "4", "http://r.example.com", ""]), askSecret: async () => KEY, ssh, dryRun: false, writers: noWriters }));
  assert.equal(res.result.status, "skipped");
  assert.equal(ssh.calls.length, 0);
  ssh = fakeSsh();
  res = await quiet(() => loginStep(SERVER, 7892, { ask: makeAsk(["y", "2", "3"]), askSecret: async () => KEY, ssh, dryRun: true, writers: noWriters }));
  assert.equal(res.result.status, "dry-run");
  assert.equal(ssh.calls.length, 0);
  assert.ok(!res.out.includes(KEY));
});
