// 工作台发到集群的命令怎么带代理口令：口令只走标准输入，不进任何命令行。
// 行为级断言用本机 sh + 一个假 curl / 假命令真跑——看它们的命令行参数与环境变量里各有什么。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PROXY_AUTH_USER } from "../proxy/auth.mjs";
import { tunnelProxyEnv } from "../proxy-config.mjs";
import { CURL_STDIN_CONFIG_FLAG, curlProxyAuthInput, curlWithProxyAuth, isProxyCredential, remoteProxyEnv, SCRIPT_PROXY_AUTH_VAR, withProxyAuthPrelude } from "./remote-proxy-auth.mjs";

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const CRED = { user: "cwb", password: TOKEN };
const skip = process.platform === "win32" ? "远端命令用本机 sh 执行，需要 POSIX 环境" : false;

test("isProxyCredential：只认固定用户名 + [A-Za-z0-9] 的口令（别的字符拼进命令与配置行都不安全）", () => {
  assert.equal(isProxyCredential(CRED), true);
  assert.equal(PROXY_AUTH_USER, "cwb");
  for (const bad of [null, undefined, {}, { user: "cwb" }, { user: "root", password: TOKEN }, { user: "cwb", password: `${TOKEN}"` }, { user: "cwb", password: "short" }, { user: "cwb", password: `${TOKEN.slice(0, -2)}\n;` }, { user: "cwb", password: 42 }]) {
    assert.equal(isProxyCredential(bad), false, JSON.stringify(bad));
  }
});

test("没有口令（口令是关）：每个函数给出的命令都与以前逐字相同，且不带标准输入", () => {
  assert.equal(curlProxyAuthInput(null), null);
  const command = "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:7891 https://api.openai.com/v1/models";
  assert.deepEqual(curlWithProxyAuth(command, { port: 7891, credential: null }), { command, input: null, applied: false });
  // 与 doctor / 离线向导一直在用的前缀逐字相同（proxy-config.mjs 的测试钉着它）。
  assert.deepEqual(remoteProxyEnv(7891), { prelude: "", prefix: tunnelProxyEnv(7891), input: null });
  assert.deepEqual(remoteProxyEnv(7891, { credential: { user: "cwb", password: "bad token" } }), { prelude: "", prefix: tunnelProxyEnv(7891), input: null }, "不合规的口令当没有");
  assert.equal(remoteProxyEnv(7891, { keys: ["HTTP_PROXY", "HTTPS_PROXY"], noProxy: false }).prefix, "HTTP_PROXY=http://127.0.0.1:7891 HTTPS_PROXY=http://127.0.0.1:7891 ");
  assert.equal(withProxyAuthPrelude("#!/bin/sh\necho hi\n", null), "#!/bin/sh\necho hi\n");
  assert.throws(() => remoteProxyEnv("7891; rm -rf ~"), /invalid proxy port/);
});

test("curlWithProxyAuth：只给认得出的 curl 命令加 -K -，口令在标准输入里；认不出的原样返回", () => {
  const command = "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:7891 https://api.openai.com/v1/models";
  const withAuth = curlWithProxyAuth(command, { port: 7891, credential: CRED });
  assert.equal(withAuth.applied, true);
  assert.equal(withAuth.command, "curl -s -o /dev/null -w '%{http_code}' --max-time 8 -x http://127.0.0.1:7891 -K - https://api.openai.com/v1/models");
  assert.equal(withAuth.input, `proxy-user = "cwb:${TOKEN}"\n`);
  assert.equal(withAuth.command.includes(TOKEN), false);
  assert.equal(CURL_STDIN_CONFIG_FLAG, "-K -");

  for (const other of [
    "wget -e use_proxy=yes https://api.openai.com/v1/models", // 不是 curl
    "curl -s https://api.openai.com/v1/models", // 没有 -x
    "curl -s -x http://127.0.0.1:7999 https://api.openai.com/v1/models", // 别的端口
    "curl -s -x http://127.0.0.1:78910 https://api.openai.com/v1/models", // 端口只是前缀相同
    "curl -s -x http://127.0.0.1:7891 -K /etc/curlrc https://api.openai.com/v1/models", // 已经有自己的 -K
    "FOO=1 curl -s -x http://127.0.0.1:7891 https://x", // 不以 curl 开头
  ]) {
    assert.deepEqual(curlWithProxyAuth(other, { port: 7891, credential: CRED }), { command: other, input: null, applied: false }, other);
  }
});

// 假命令：把自己的命令行参数与看到的代理环境变量写进文件，再把标准输入原样抄一份。
function fakeBin(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "remote-proxy-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, "record.txt");
  for (const name of ["curl", "codex"]) {
    const file = path.join(dir, name);
    writeFileSync(file, `#!/bin/sh\n{ echo "argv: $*"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "http_proxy=$http_proxy"; echo "NO_PROXY=$NO_PROXY"; printf 'stdin: '; cat; echo; } >> "${record}"\n`);
    chmodSync(file, 0o755);
  }
  const run = (command, input) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_proxy$/i.test(key)));
    // 与 ssh 把命令交给对方登录 shell 一样：整条命令文本是 shell 的一个参数。
    const res = spawnSync("sh", ["-c", command], { env: { ...env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8", input: input ?? "" });
    return { ...res, record: (() => { try { return readFileSync(record, "utf8"); } catch { return ""; } })() };
  };
  return { run };
}

test("行为：curl 的命令行里没有口令，口令只从标准输入到达", { skip }, (t) => {
  const { run } = fakeBin(t);
  const { command, input } = curlWithProxyAuth("curl -s -x http://127.0.0.1:7891 https://api.openai.com/v1/models", { port: 7891, credential: CRED });
  const res = run(command, input);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.record, /^argv: -s -x http:\/\/127\.0\.0\.1:7891 -K - https:\/\/api\.openai\.com\/v1\/models$/m);
  assert.match(res.record, new RegExp(`^stdin: proxy-user = "cwb:${TOKEN}"$`, "m"));
  assert.equal(res.record.split("\n").find((line) => line.startsWith("argv:")).includes(TOKEN), false);
  assert.equal(command.includes(TOKEN), false, "交给 ssh 的命令文本里也没有");
});

test("行为：靠环境变量找代理的命令——口令从标准输入读进变量，子进程在环境变量里拿到带口令的地址，命令行里没有", { skip }, (t) => {
  const { run } = fakeBin(t);
  const env = remoteProxyEnv(7891, { credential: CRED });
  const command = `${env.prelude}PATH="$PATH" ${env.prefix}codex doctor --summary --ascii`;
  assert.equal(command.includes(TOKEN), false, "交给 ssh 的命令文本（= 远端 shell 的命令行）里没有口令");
  assert.equal(env.input, `${TOKEN}\n`);
  const res = run(command, env.input);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.record, /^argv: doctor --summary --ascii$/m);
  assert.match(res.record, new RegExp(`^HTTPS_PROXY=http://cwb:${TOKEN}@127\\.0\\.0\\.1:7891$`, "m"));
  assert.match(res.record, new RegExp(`^http_proxy=http://cwb:${TOKEN}@127\\.0\\.0\\.1:7891$`, "m"));
  assert.match(res.record, /^NO_PROXY=localhost,127\.0\.0\.1,::1$/m);
  assert.match(res.record, /^stdin: $/m, "口令那一行已被读走，命令自己的标准输入是空的（与以前不开标准输入时一样）");

  // 标准输入是空的（比如执行入口没把它送到）：不卡住；地址里口令为空，代理按「带错」处理。
  const empty = run(command, "");
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.record, /^HTTPS_PROXY=http:\/\/cwb:@127\.0\.0\.1:7891$/m);
});

test("行为：sh -s 的脚本——口令是脚本正文前面的一行赋值，不在 `env … sh -s` 的命令行里", { skip }, (t) => {
  const { run } = fakeBin(t);
  const script = `#!/bin/sh\ncase "$${SCRIPT_PROXY_AUTH_VAR}" in *[!A-Za-z0-9:]*) ${SCRIPT_PROXY_AUTH_VAR}= ;; esac\necho "got=$${SCRIPT_PROXY_AUTH_VAR}"\n`;
  const input = withProxyAuthPrelude(script, CRED);
  assert.equal(input, `${SCRIPT_PROXY_AUTH_VAR}='cwb:${TOKEN}'\n${script}`);
  const command = "env CT_CLI_IDS='claude' CT_ENDPOINT_PORT='7891' sh -s";
  const res = run(command, input);
  assert.equal(res.stdout.trim(), `got=cwb:${TOKEN}`);
  assert.equal(command.includes(TOKEN), false);
});
