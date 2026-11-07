// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 断言里的 ${…} 是远端 sh / sed 的写法（变量展开、地址加命令块），不是漏写的模板串
// 经反向端口出网的探测怎么带代理口令（v2.62）：codex doctor / 端点、Claude Code 连通性、reclaude、验证档案的
// 出网测试，以及 zcode 的代理地址比对。两条贯穿的断言：
//   ① 口令是关（拿不到口令）时，每条远端命令与以前逐字相同、不开标准输入；
//   ② 口令不是关时，口令只在标准输入里——交给 ssh 的命令文本（= 集群上别人用 ps 看得到的命令行）里没有。
// 行为级的几条用本机 sh + 假的 codex / curl 真跑，看它们各自拿到了什么。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadCliProbeScript } from "../cli/detect.mjs";
import { createValidationProbe } from "../probes/validation.mjs";
import { tunnelProxyEnv } from "../proxy-config.mjs";
import { claudeCodeAdapter, CLAUDE_CODE_PROBE_ID } from "./claude-code.mjs";
import { buildEndpointInvocation, codexAdapter } from "./codex.mjs";
import { buildClaudeEndpointInvocation, reclaudeAdapter } from "./reclaude.mjs";
import { evaluateZcodeProxyConfig } from "./zcode.mjs";

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const CRED = { user: "cwb", password: TOKEN };
const SERVER = { id: "server-01", host: "myserver", remotePort: 7891, localPort: 8888 };
const skip = process.platform === "win32" ? "远端命令用本机 sh 执行，需要 POSIX 环境" : false;

// 适配器上下文：记下每次 SSH 的命令文本与标准输入；stdout 由测试给。
function ctxWith({ credential = null, stdout = "" } = {}) {
  const calls = [];
  const exec = async (command, input) => {
    calls.push({ command, input: input ?? null });
    return { code: 0, stdout, stderr: "" };
  };
  return {
    calls,
    ctx: {
      getConfig: async () => ({ servers: [SERVER], agentCatalog: [] }),
      getMainServerConfig: () => SERVER,
      getProxyCredential: () => credential,
      sshArgsFor: () => ["myserver"],
      probeSshFailureReason: (code) => `ssh exit ${code}`,
      execFileCmd: (_file, args, options = {}) => exec(args.at(-1), options.input),
      execCollector: (invocation) => exec(invocation.args.at(-1), invocation.input),
    },
  };
}

const runSpec = (adapter, ctx, id) => adapter.probeSpecs(ctx).find((spec) => spec.id === id).run();
const noSecret = (calls) => {
  for (const { command } of calls) assert.equal(command.includes(TOKEN), false, `命令文本里出现了口令: ${command.slice(0, 120)}`);
};

test("codex doctor：口令是关时命令逐字不变、没有标准输入；不是关时口令在标准输入第一行，命令里只有变量名", async () => {
  const off = ctxWith();
  await runSpec(codexAdapter, off.ctx, "doctor");
  assert.equal(off.calls.length, 1);
  assert.ok(off.calls[0].command.startsWith(`PATH="$HOME/.local/bin:$PATH" ${tunnelProxyEnv(7891)}codex doctor --summary --ascii; __CODEX_DOCTOR_EXIT__=$?; `), off.calls[0].command.slice(0, 200));
  assert.equal(off.calls[0].input, null);

  const on = ctxWith({ credential: CRED });
  await runSpec(codexAdapter, on.ctx, "doctor");
  assert.equal(on.calls[0].input, `${TOKEN}\n`);
  assert.ok(on.calls[0].command.startsWith('IFS= read -r __cwb_t || true; __cwb_p="http://cwb:${__cwb_t}@127.0.0.1:7891"; unset __cwb_t; PATH="$HOME/.local/bin:$PATH" HTTP_PROXY="$__cwb_p" HTTPS_PROXY="$__cwb_p" http_proxy="$__cwb_p" https_proxy="$__cwb_p" NO_PROXY=localhost,127.0.0.1,::1 codex doctor --summary --ascii; '));
  // 除了开头那一段，其余部分（退出码透传、安装态判断、读 auth.json）与关着的时候逐字相同。
  const tail = (command) => command.slice(command.indexOf("codex doctor --summary --ascii"));
  assert.equal(tail(on.calls[0].command), tail(off.calls[0].command));
  noSecret(on.calls);
});

test("codex 端点：关着是原来那条（环境变量里的代理地址）；带口令时 -x 地址 + -K -，口令在标准输入", async () => {
  assert.deepEqual(buildEndpointInvocation(7891), {
    command: "HTTP_PROXY=http://127.0.0.1:7891 HTTPS_PROXY=http://127.0.0.1:7891 curl -I --connect-timeout 10 -w 'rtt=%{time_total}\\n' https://chatgpt.com/backend-api/codex/responses 2>&1 | sed -n -e '1,14p' -e '15,${/^rtt=/p;}'",
    input: null,
  });
  const off = ctxWith();
  await runSpec(codexAdapter, off.ctx, "endpoint");
  assert.deepEqual(off.calls, [{ command: buildEndpointInvocation(7891).command, input: null }]);

  const on = ctxWith({ credential: CRED });
  await runSpec(codexAdapter, on.ctx, "endpoint");
  assert.deepEqual(on.calls, [{
    command: "curl -x http://127.0.0.1:7891 -K - -I --connect-timeout 10 -w 'rtt=%{time_total}\\n' https://chatgpt.com/backend-api/codex/responses 2>&1 | sed -n -e '1,14p' -e '15,${/^rtt=/p;}'",
    input: `proxy-user = "cwb:${TOKEN}"\n`,
  }]);
  noSecret(on.calls);
});

test("Claude Code 探针：口令是脚本正文前面的一行赋值（脚本经标准输入送达），`env … sh -s` 的命令行不变", async () => {
  const stdout = "__CLI_BEGIN__\nclaude.installed=1\nclaude.path=/h/.local/bin/claude\nclaude.version=2.1.291\nclaude.oauth=1\nendpoint=401 0.3\n__CLI_END__";
  const off = ctxWith({ stdout });
  await runSpec(claudeCodeAdapter, off.ctx, CLAUDE_CODE_PROBE_ID);
  assert.equal(off.calls[0].command, "env CT_CLI_IDS='claude' CT_ENDPOINT_PORT='7891' sh -s");
  assert.equal(off.calls[0].input, loadCliProbeScript(), "关着：标准输入就是脚本原文");

  const on = ctxWith({ credential: CRED, stdout });
  await runSpec(claudeCodeAdapter, on.ctx, CLAUDE_CODE_PROBE_ID);
  assert.equal(on.calls[0].command, off.calls[0].command);
  assert.equal(on.calls[0].input, `CT_PROXY_AUTH='cwb:${TOKEN}'\n${loadCliProbeScript()}`);
  noSecret(on.calls);
});

test("reclaude：状态探针与端点探针同样的两种写法", async () => {
  const plainPrefix = 'PATH="$HOME/.local/bin:$PATH" HTTP_PROXY=http://127.0.0.1:7891 HTTPS_PROXY=http://127.0.0.1:7891 http_proxy=http://127.0.0.1:7891 https_proxy=http://127.0.0.1:7891 ';
  const off = ctxWith();
  await runSpec(reclaudeAdapter, off.ctx, "reclaude");
  assert.ok(off.calls[0].command.startsWith(`echo __RECLAUDE_VERSION_BEGIN__; ${plainPrefix}reclaude version 2>&1 || true; `), off.calls[0].command.slice(0, 260));
  assert.ok(off.calls[0].command.includes(`${plainPrefix}reclaude status 2>&1 || true; `));
  assert.ok(off.calls[0].command.includes(`${plainPrefix}reclaude logs 2>&1 | tail -40 || true`));
  assert.equal(off.calls[0].input, null);

  const on = ctxWith({ credential: CRED });
  await runSpec(reclaudeAdapter, on.ctx, "reclaude");
  assert.equal(on.calls[0].input, `${TOKEN}\n`);
  assert.ok(on.calls[0].command.startsWith('IFS= read -r __cwb_t || true; __cwb_p="http://cwb:${__cwb_t}@127.0.0.1:7891"; unset __cwb_t; echo __RECLAUDE_VERSION_BEGIN__; PATH="$HOME/.local/bin:$PATH" HTTP_PROXY="$__cwb_p" HTTPS_PROXY="$__cwb_p" http_proxy="$__cwb_p" https_proxy="$__cwb_p" reclaude version 2>&1 || true; '));
  noSecret(on.calls);

  assert.deepEqual(buildClaudeEndpointInvocation(7891, "api.anthropic.com:443"), {
    command: "HTTPS_PROXY=http://127.0.0.1:7891 curl -s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 10 --max-time 15 https://api.anthropic.com:443/v1/models 2>&1",
    input: null,
  });
  assert.deepEqual(buildClaudeEndpointInvocation(7891, "api.anthropic.com:443", CRED), {
    command: "curl -x http://127.0.0.1:7891 -K - -s -o /dev/null -w '%{http_code} %{time_total}' --connect-timeout 10 --max-time 15 https://api.anthropic.com:443/v1/models 2>&1",
    input: `proxy-user = "cwb:${TOKEN}"\n`,
  });
  const endpoint = ctxWith({ credential: CRED, stdout: "401 0.3" });
  await runSpec(reclaudeAdapter, endpoint.ctx, "claude-endpoint");
  assert.equal(endpoint.calls[0].input, `proxy-user = "cwb:${TOKEN}"\n`);
  noSecret(endpoint.calls);
});

test("验证档案：只有经隧道出网那一项带口令（-K - + 标准输入）；版本命令等其余项不变；关着时全部不变", async () => {
  const profile = {
    remoteProxyTest: "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:{{remotePort}} https://api.openai.com/v1/models",
    agentVersionCommands: { codex: "codex --version" },
    workspaceSmokeCommand: "echo 'workspace ready'",
  };
  const run = async (credential, remoteProxyTest = profile.remoteProxyTest) => {
    const calls = [];
    const probe = createValidationProbe({
      getConfig: async () => ({ servers: [{ ...SERVER, validationProfile: { ...profile, remoteProxyTest } }], agentCatalog: [] }),
      execFileCmd: async (_file, args, options = {}) => {
        calls.push({ command: args.at(-1), input: options.input ?? null });
        return { code: 0, stdout: "200", stderr: "" };
      },
      sshArgsFor: () => ["myserver"],
      getProxyCredential: () => credential,
    });
    const result = await probe.runValidationProbe("server-01");
    return { calls, result };
  };
  const prefix = 'export PATH="$HOME/.local/bin:$PATH"; ';
  const off = await run(null);
  assert.deepEqual(off.calls, [
    { command: `${prefix}curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:7891 https://api.openai.com/v1/models`, input: null },
    { command: `${prefix}codex --version`, input: null },
    { command: `${prefix}echo 'workspace ready'`, input: null },
  ]);
  const on = await run(CRED);
  assert.deepEqual(on.calls, [
    { command: `${prefix}curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:7891 -K - https://api.openai.com/v1/models`, input: `proxy-user = "cwb:${TOKEN}"\n` },
    { command: `${prefix}codex --version`, input: null },
    { command: `${prefix}echo 'workspace ready'`, input: null },
  ]);
  assert.equal(on.result.level, "ok");
  noSecret(on.calls);
  // 团队自己改写过的出网测试（不是那种 curl 写法）：原样执行，不去猜怎么给它带口令。
  const custom = await run(CRED, "wget -q -O /dev/null https://api.openai.com/v1/models");
  assert.deepEqual(custom.calls[0], { command: `${prefix}wget -q -O /dev/null https://api.openai.com/v1/models`, input: null });
});

test("zcode：手动改成带口令的同端口地址不算漂移；展示出去的地址里口令打码（不管是谁的）", () => {
  const check = (httpProxy) => evaluateZcodeProxyConfig({ settingRaw: JSON.stringify({ httpProxy }), settingPresent: true, expected: "http://127.0.0.1:7891" });
  assert.deepEqual(check("http://127.0.0.1:7891"), { state: "ok", expected: "http://127.0.0.1:7891", actual: "http://127.0.0.1:7891" });
  assert.equal(check("http://127.0.0.1:7891/").state, "ok");
  assert.equal(check("HTTP://127.0.0.1:7891").state, "ok", "原来就不区分大小写");
  assert.deepEqual(check(`http://cwb:${TOKEN}@127.0.0.1:7891`), { state: "ok", expected: "http://127.0.0.1:7891", actual: "http://cwb:••••••@127.0.0.1:7891" });
  assert.equal(check(`http://cwb:${TOKEN}@127.0.0.1:7891/`).state, "ok");
  assert.deepEqual(check(`http://cwb:${TOKEN}@127.0.0.1:7893`), { state: "drifted", expected: "http://127.0.0.1:7891", actual: "http://cwb:••••••@127.0.0.1:7893" }, "别的端口照旧算漂移");
  assert.deepEqual(check("http://alice:hunter2@proxy.corp:3128"), { state: "drifted", expected: "http://127.0.0.1:7891", actual: "http://alice:••••••@proxy.corp:3128" });
  assert.equal(check("http://127.0.0.1:7893").state, "drifted");
  for (const value of [`http://cwb:${TOKEN}@127.0.0.1:7891`, `http://cwb:${TOKEN}@127.0.0.1:7893`]) assert.equal(JSON.stringify(check(value)).includes(TOKEN), false);
});

// ---- 行为级：本机 sh + 假的 codex / curl，看命令行参数与环境变量里各有什么 ----

function fakeBin(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-auth-probes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, "record.txt");
  // 假 curl 与真的一样：只有给了 `-K -` 才读标准输入（否则在 `sh -s` 里它会把脚本剩下的部分当输入吃掉）。
  writeFileSync(path.join(dir, "curl"), `#!/bin/sh\nstdin=""\ncase " $* " in *" -K - "*) stdin=$(cat) ;; esac\n{ echo "curl argv: $*"; echo "curl HTTPS_PROXY=$HTTPS_PROXY"; echo "curl stdin: $stdin"; } >> "${record}"\necho "HTTP/1.1 200 Connection Established"\n`);
  // 假 codex 把标准输入抄一份：用来确认口令那一行已被远端 shell 读走。
  writeFileSync(path.join(dir, "codex"), `#!/bin/sh\n{ echo "codex argv: $*"; echo "codex HTTPS_PROXY=$HTTPS_PROXY"; printf 'codex stdin: '; cat; echo; } >> "${record}"\n`);
  for (const name of ["curl", "codex"]) chmodSync(path.join(dir, name), 0o755);
  const run = (command, input) => {
    // PATH 只有假命令与系统目录：不碰这台机器上真装着的 codex / claude，也不带这里现有的代理变量。
    const res = spawnSync("sh", ["-c", command], { env: { HOME: dir, PATH: `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, LC_ALL: "C" }, encoding: "utf8", input: input ?? "" });
    let text = "";
    try {
      text = readFileSync(record, "utf8");
    } catch {}
    return { ...res, record: text };
  };
  return { dir, run };
}

test("行为：codex doctor 的整条远端命令在真实 sh 里跑——codex 的环境变量里是带口令的地址，命令行与远端 shell 的命令文本里都没有", { skip }, async (t) => {
  const { run } = fakeBin(t);
  const on = ctxWith({ credential: CRED });
  await runSpec(codexAdapter, on.ctx, "doctor");
  const { command, input } = on.calls[0];
  const res = run(command, input);
  assert.match(res.record, /^codex argv: doctor --summary --ascii$/m);
  assert.match(res.record, new RegExp(`^codex HTTPS_PROXY=http://cwb:${TOKEN}@127\\.0\\.0\\.1:7891$`, "m"));
  assert.match(res.record, /^codex stdin: $/m, "口令那一行已被读走，codex 自己的标准输入是空的");
  assert.match(res.stdout, /__CODEX_AUTH_BEGIN__/, "后面的几段照常执行");
});

test("行为：端点探针与验证探针的 curl——命令行里只有 -x 地址与 -K -，口令在 curl 的标准输入里", { skip }, async (t) => {
  const { run } = fakeBin(t);
  const endpoint = buildEndpointInvocation(7891, CRED);
  const res = run(endpoint.command, endpoint.input);
  assert.match(res.record, /^curl argv: -x http:\/\/127\.0\.0\.1:7891 -K - -I --connect-timeout 10 /m);
  assert.match(res.record, new RegExp(`^curl stdin: proxy-user = "cwb:${TOKEN}"$`, "m"));
  assert.equal(res.record.split("\n").filter((line) => line.startsWith("curl argv:")).some((line) => line.includes(TOKEN)), false);
  assert.match(res.stdout, /HTTP\/1\.1 200 Connection Established/);
});

test("行为：cli-probe.sh 在真实 sh 里跑——带口令时 curl 多一个 -K -、口令经管道到它的标准输入；不带时那条 curl 与以前一样", { skip }, async (t) => {
  const { dir, run } = fakeBin(t);
  const command = "env CT_CLI_IDS='claude' CT_ENDPOINT_PORT='7891' sh -s";
  const off = run(command, loadCliProbeScript());
  assert.match(off.stdout, /__CLI_BEGIN__[\s\S]*__CLI_END__/);
  const offArgv = off.record.split("\n").filter((line) => line.startsWith("curl argv:"));
  assert.deepEqual(offArgv, ["curl argv: -s -o /dev/null -w %{http_code} %{time_total} --connect-timeout 10 --max-time 15 -x http://127.0.0.1:7891 https://api.anthropic.com/v1/models"]);

  rmSync(path.join(dir, "record.txt"));
  const on = run(command, `CT_PROXY_AUTH='cwb:${TOKEN}'\n${loadCliProbeScript()}`);
  assert.match(on.stdout, /__CLI_END__/, "脚本照常跑完");
  const onArgv = on.record.split("\n").filter((line) => line.startsWith("curl argv:"));
  assert.deepEqual(onArgv, ["curl argv: -s -o /dev/null -w %{http_code} %{time_total} --connect-timeout 10 --max-time 15 -x http://127.0.0.1:7891 -K - https://api.anthropic.com/v1/models"]);
  assert.match(on.record, new RegExp(`^curl stdin: proxy-user = "cwb:${TOKEN}"$`, "m"));
  assert.equal(on.stdout.includes(TOKEN), false, "探测输出里没有口令");

  // 形状不对的值（多一个冒号、带引号、带空格）一律当没有：curl 回到不带 -K 的写法。
  for (const bad of ["cwb:a:b", 'cwb:x"y', "cwb:with space", "nocolon", ":onlypass"]) {
    rmSync(path.join(dir, "record.txt"), { force: true });
    const res = run(command, `CT_PROXY_AUTH='${bad}'\n${loadCliProbeScript()}`);
    assert.deepEqual(res.record.split("\n").filter((line) => line.startsWith("curl argv:")), offArgv, bad);
  }
});
