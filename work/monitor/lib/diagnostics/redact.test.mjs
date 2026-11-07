// 诊断包脱敏：每一类凭据都用假数据走一遍；主机名、账号名、路径与普通数字 / 布尔原样保留。
// 假密钥一律拆开拼写（"sk-" + "proj-…"），免得仓库的发布扫描把测试夹具当成泄露。
import assert from "node:assert/strict";
import test from "node:test";

import { createRedactor, isSecretKey, REDACTED, redactDiagnostics, secretVariants } from "./redact.mjs";

const FAKE = {
  openai: `${"sk-"}${"proj-"}AbCdEfGhIjKlMnOpQrStUvWx0123456789`,
  anthropic: `${"sk-"}${"ant-"}api03-AbCdEfGhIjKlMnOpQrStUv`,
  github: `${"gh"}p_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`,
  githubPat: `${"github_"}pat_${"11ABCDEFG0123456789_abcdefghijklmnop"}`,
  slack: `${"xox"}b-1234567890-abcdefghij`,
  aws: `${"AK"}IA${"ABCDEFGHIJKLMNOP"}`,
  hf: `${"hf_"}${"AbCdEfGhIjKlMnOpQrStUvWx"}`,
  jwt: `${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36P`,
  relay: `${"cr_"}${"0123456789abcdef".repeat(4)}`,
};

test("isSecretKey：按键名结尾判定，计数类字段不算", () => {
  for (const key of ["token", "authToken", "auth-token", "x-auth-token", "AUTH_TOKEN", "accessToken", "previousToken", "apiKey", "api_key",
    "secret", "clientSecret", "password", "sshPassword", "passwd", "passphrase", "privateKey", "cookie", "Set-Cookie", "authorization",
    "Proxy-Authorization", "credential", "credentials", "vault", "vaultToken", "vaultUrl", "pwd", "proxyUser"]) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ["maxTokens", "inputTokens", "tokenCount", "host", "sshUser", "user", "authRef", "proxyAuth", "name", "remotePort", ""]) {
    assert.equal(isSecretKey(key), false, key);
  }
});

test("对象：凭据字段整个换掉；数字与布尔保留；主机名、账号、路径原样留着", () => {
  const input = {
    activeServerId: "server-01",
    sshUser: "alice",
    servers: [{ id: "server-01", host: "login.cluster.example", sshUser: "alice", identityFile: "/Users/alice/.ssh/id_ed25519_codextunnel", password: "hunter2-hunter2", authRef: "vault:server-01" }],
    vault: { url: "http://127.0.0.1:50123", token: "v".repeat(40) },
    proxyAuth: { mode: "observe", hasToken: true, token: "p".repeat(32) },
    usage: { maxTokens: 4096, inputTokens: 12 },
    headers: { Authorization: "Bearer abcdefghijkl", Cookie: "a=1; b=2", "x-auth-token": "0123456789abcdef0123456789abcdef" },
    emptyPassword: "",
    nested: [{ apiKey: { value: "x" } }],
  };
  const { value, count } = redactDiagnostics(input);
  assert.equal(value.servers[0].host, "login.cluster.example");
  assert.equal(value.servers[0].sshUser, "alice");
  assert.equal(value.sshUser, "alice");
  assert.equal(value.servers[0].identityFile, "/Users/alice/.ssh/id_ed25519_codextunnel");
  assert.equal(value.servers[0].authRef, "vault:server-01");
  assert.equal(value.servers[0].password, REDACTED);
  assert.equal(value.vault, REDACTED);
  assert.deepEqual(value.proxyAuth, { mode: "observe", hasToken: true, token: REDACTED });
  assert.deepEqual(value.usage, { maxTokens: 4096, inputTokens: 12 });
  assert.deepEqual(value.headers, { Authorization: REDACTED, Cookie: REDACTED, "x-auth-token": REDACTED });
  assert.equal(value.emptyPassword, "", "空串没有可隐藏的");
  assert.deepEqual(value.nested, [{ apiKey: REDACTED }]);
  assert.equal(count, 7);
  assert.equal(input.servers[0].password, "hunter2-hunter2", "不改原对象");
});

test("文本：请求头、Bearer / Basic、URL 口令、命令行参数、键值对都隐藏", () => {
  const r = createRedactor();
  const basic = Buffer.from("cwb:TopSecretProxyToken123").toString("base64");
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop", "Authorization: [已隐藏]"],
    [`proxy-authorization: Basic ${basic}`, "proxy-authorization: [已隐藏]"],
    ["Cookie: sid=abc123; theme=dark", "Cookie: [已隐藏]"],
    ["set-cookie: sid=abc123; Path=/", "set-cookie: [已隐藏]"],
    ['{"authorization":"Bearer zzzzzzzzzzzz","host":"node04"}', '{"authorization":"[已隐藏]","host":"node04"}'],
    ["x-auth-token: 0123456789abcdef0123456789abcdef", "x-auth-token: [已隐藏]"],
    ["curl -H 'X-Trace: 1' --proxy-user cwb:TopSecretProxyToken123 https://api.example", "curl -H 'X-Trace: 1' --proxy-user [已隐藏] https://api.example"],
    ["ssh --password=hunter2hunter2 host", "ssh --password=[已隐藏] host"],
    ["export HTTPS_PROXY=http://cwb:TopSecretProxyToken123@127.0.0.1:7891", "export HTTPS_PROXY=http://cwb:[已隐藏]@127.0.0.1:7891"],
    ["GET /api/events?token=0123456789abcdef&x=1", "GET /api/events?token=[已隐藏]&x=1"],
    ['{"token":"abcdef0123456789","mode":"enforce"}', '{"token":"[已隐藏]","mode":"enforce"}'],
    ["AUTH_TOKEN=abcdef0123456789abcdef", "AUTH_TOKEN=[已隐藏]"],
    ["client_secret: 's3cr3t-value'", "client_secret: '[已隐藏]'"],
    ["proxy_user = \"cwb:abc12345\"", "proxy_user = \"[已隐藏]\""],
    ["CODEX_MONITOR_VAULT_TOKEN=feedfacefeedfacefeed", "CODEX_MONITOR_VAULT_TOKEN=[已隐藏]"],
  ];
  for (const [input, expected] of cases) assert.equal(r.text(input), expected, input);
});

test("文本：常见服务商密钥前缀都隐藏，别的单词不误伤", () => {
  const r = createRedactor();
  for (const [name, secret] of Object.entries(FAKE)) {
    const out = r.text(`key in log: ${secret} (end)`);
    assert.equal(out.includes(secret), false, `${name}: ${out}`);
    assert.match(out, /\[已隐藏\]/, name);
  }
  const plain = "task-abcdefghijklmnopqrstuvwxyz finished; tokens: 1234; hasToken: true; Basic auth; 主机 node04 用户 alice";
  assert.equal(r.text(plain), plain);
});

test("文本：私钥块整块隐藏（没有 END 也到结尾）", () => {
  const r = createRedactor();
  const header = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`;
  const footer = `-----END ${"OPENSSH"} PRIVATE KEY-----`;
  assert.equal(r.text(`before\n${header}\nAAAAB3NzaC1yc2E\n${footer}\nafter`), "before\n[私钥已隐藏]\nafter");
  assert.equal(r.text(`x ${header}\nAAAA`), "x [私钥已隐藏]");
});

test("已知秘密：原文、URL 编码与 user:口令 的 Basic 编码出现在任何字段都换掉", () => {
  const authToken = "0123456789abcdef0123456789abcdef";
  const proxyToken = "Prx+Tok/en=0123456789AB";
  const secrets = secretVariants([authToken, proxyToken, "short"], { users: ["cwb"] });
  assert.ok(secrets.includes(encodeURIComponent(proxyToken)));
  assert.ok(secrets.includes(Buffer.from(`cwb:${proxyToken}`).toString("base64")));
  assert.equal(secrets.includes("short"), false, "太短的不当秘密");
  const input = {
    message: `request with ${authToken} failed`,
    detail: `proxy ${encodeURIComponent(proxyToken)} / ${Buffer.from(`cwb:${proxyToken}`).toString("base64")}`,
    list: [`raw ${proxyToken}`],
  };
  const { value } = redactDiagnostics(input, { secrets });
  const text = JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  assert.match(value.message, /^request with \[已隐藏\] failed$/);
});

test("占位不会被再换一次（不出现 [已隐藏]]）", () => {
  const r = createRedactor({ secrets: ["abcdefghijklmnop"] });
  const out = r.text("token=abcdefghijklmnop x-auth-token: abcdefghijklmnop");
  assert.equal(out, "token=[已隐藏] x-auth-token: [已隐藏]");
});

test("键名：含 secret / token / password / passwd / auth 都算（secretKey、AWS_SECRET_ACCESS_KEY、auth、oauth_token）；允许名单与用量计数照留", () => {
  for (const key of ["secretKey", "AWS_SECRET_ACCESS_KEY", "auth", "basicAuth", "oauth_token", "tokenValue", "passwordHash", "accessKey", "refresh_token", "client_secret_value", "vaultUrl"]) {
    assert.equal(isSecretKey(key), true, key);
  }
  for (const key of ["authRef", "authMethod", "auth_method", "authMode", "authPath", "authed", "authorized", "author", "proxyAuth", "proxyAuthResult",
    "input_tokens", "cache_read_input_tokens", "total_token_usage", "tokenCount", "maxTokens", "key", "keyPath"]) {
    assert.equal(isSecretKey(key), false, key);
  }
  const { value } = redactDiagnostics({
    AWS_SECRET_ACCESS_KEY: "abc123abc123abc123",
    secretKey: "abcdefgh12345678",
    auth: "user:pass12345678",
    authRef: "vault:server-01",
    authMethod: "oauth",
    proxyAuth: { mode: "observe", hasToken: true },
    total_token_usage: { input_tokens: 10, output_tokens: 2 },
  });
  assert.deepEqual(value, {
    AWS_SECRET_ACCESS_KEY: REDACTED,
    secretKey: REDACTED,
    auth: REDACTED,
    authRef: "vault:server-01",
    authMethod: "oauth",
    proxyAuth: { mode: "observe", hasToken: true },
    total_token_usage: { input_tokens: 10, output_tokens: 2 },
  });
  const r = createRedactor();
  assert.equal(r.text("AWS_SECRET_ACCESS_KEY=abc123abc123 auth: user:pw12345 authMethod: oauth input_tokens=12"), "AWS_SECRET_ACCESS_KEY=[已隐藏] auth: [已隐藏] authMethod: oauth input_tokens=12");
  assert.equal(r.text('{"secretKey":"abcdefgh12345678","authRef":"vault:x"}'), '{"secretKey":"[已隐藏]","authRef":"vault:x"}');
});

test("文本：值的引号没有收尾（截断过的文本）也隐藏到行尾", () => {
  const r = createRedactor();
  assert.equal(r.text('xxx "token":"abcdefghijklmnopqrstu'), 'xxx "token":"[已隐藏]"');
  assert.equal(r.text("a password='hunter2hunter2\nnext line"), "a password='[已隐藏]'\nnext line");
});

test("文本：curl -u / -U / --user 的 user:pass 只隐藏口令；只给用户名、别的命令的 -u 不动", () => {
  const r = createRedactor();
  const pass = `Zx9QwErTy7${"UiOpAsDfGh"}`;
  assert.equal(r.text(`curl -sS -U codex:${pass} -x http://127.0.0.1:7890 https://x`), "curl -sS -U codex:[已隐藏] -x http://127.0.0.1:7890 https://x");
  assert.equal(r.text(`curl -u alice:${pass} https://x`), "curl -u alice:[已隐藏] https://x");
  assert.equal(r.text(`curl -ualice:${pass} https://x`), "curl -ualice:[已隐藏] https://x");
  assert.equal(r.text(`curl --user "alice:${pass}" https://x`), 'curl --user "alice:[已隐藏]" https://x');
  assert.equal(r.text(`curl --user=alice:${pass} https://x`), "curl --user=alice:[已隐藏] https://x");
  for (const plain of ["curl -u alice https://x", "ps -u alice", "sort -u list.txt"]) assert.equal(r.text(plain), plain);
});

test("文本：http(s) 地址里只有令牌的 TOKEN@ 整段隐藏；user:pass@ 留用户名；ssh:// 的账号名不动", () => {
  const r = createRedactor();
  const token = `Zx9QwErTy7${"UiOpAsDfGh"}`;
  assert.equal(r.text(`git clone https://${token}@git.example.com/repo`), "git clone https://[已隐藏]@git.example.com/repo");
  assert.equal(r.text(`wss://${token}@relay.example/ws`), "wss://[已隐藏]@relay.example/ws");
  assert.equal(r.text(`https://alice:${token}@git.example.com`), "https://alice:[已隐藏]@git.example.com");
  assert.equal(r.text("ssh://alice@login.cluster.example:22"), "ssh://alice@login.cluster.example:22");
  assert.equal(r.text("see https://example.com/a@b and mail a@b.com"), "see https://example.com/a@b and mail a@b.com");
});
