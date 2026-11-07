// API key / 中转站登录流程（login-api.mjs）：假 SSH 按命令内容分派，断言调用顺序、key 只出现在标准输入、
// 测不通时什么都不写、白名单 / NO_PROXY / reclaude 拒绝 / http 明文确认。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildClusterEnvSteps } from "../cluster-env.mjs";
import { LoginError, normalizeApiLoginRequest, runApiLogin } from "./login-api.mjs";
import { upsertCodexProvider } from "./login-flows.mjs";

const KEY = "sk-test-SECRET-1234567890";
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

function inspectOut({ env = true, cli = true, file = null } = {}) {
  return `__CWB_ENV__=${env ? 1 : 0}\n__CWB_CLI__=${cli ? 1 : 0}\n__CWB_FILE__=${file == null ? "-" : b64(file)}\n`;
}

function classify(command) {
  if (command.includes("__CWB_FILE__")) return "inspect";
  if (command.includes("__CWB_HTTP__")) return command.includes("--proxytunnel") ? "reach" : "reach-direct";
  if (command.includes("codex login --with-api-key")) return "codex-api-key";
  if (command.includes("codex login status")) return "codex-status";
  if (command.includes("claude auth status")) return "claude-status";
  if (command.includes("/keys/") && command.includes(".env")) return "write-key";
  if (command.includes(".codex/config.toml")) return "write-config";
  if (command.includes(".claude/settings.json")) return "write-settings";
  if (command.includes(".config/cluster-workbench/env.sh.tmp")) return "write-env";
  return "unknown";
}

// responses: { kind: (call) => result | result }；calls 记录 { kind, command, input }。
function makeDeps({ responses = {}, port = 7892, noProxyExtra = [] } = {}) {
  const calls = [];
  const events = [];
  const state = { noProxyExtra: [...noProxyExtra], allowlist: [] };
  const deps = {
    port,
    runRemote: async (command, { input } = {}) => {
      const kind = classify(command);
      calls.push({ kind, command, input });
      events.push(["remote", kind]);
      const r = responses[kind];
      const value = typeof r === "function" ? r({ command, input, calls }) : r;
      return value ?? { code: 0, stdout: "", stderr: "" };
    },
    getNoProxyExtra: () => [...state.noProxyExtra],
    saveNoProxyExtra: async (list) => {
      events.push(["saveNoProxyExtra", list]);
      state.noProxyExtra = list;
    },
    addAllowlistEntry: async (entry) => {
      events.push(["addAllowlistEntry", entry]);
      if (state.allowlist.includes(entry)) return { added: false };
      state.allowlist.push(entry);
      return { added: true };
    },
    sleep: async (ms) => events.push(["sleep", ms]),
    phase: (name) => events.push(["phase", name]),
  };
  return { deps, calls, events, state };
}

function assertKeyOnlyInInput(calls, secret = KEY) {
  for (const c of calls) assert.ok(!c.command.includes(secret), `${c.kind}: 命令串里不能有 key`);
  assert.ok(calls.some((c) => typeof c.input === "string" && c.input.includes(secret)), "key 经标准输入送达");
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

test("请求校验：key 格式、中转站地址、http 明文必须确认、provider 名称", () => {
  assert.throws(() => normalizeApiLoginRequest("codex", "api", { apiKey: "short" }), (e) => e instanceof LoginError && e.code === "bad-key" && e.field === "apiKey");
  assert.throws(() => normalizeApiLoginRequest("codex", "api", { apiKey: "has space inside" }), /格式不对/);
  assert.throws(() => normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "relay.example.com" }), (e) => e.code === "bad-url");
  assert.throws(() => normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "http://relay.example.com" }), (e) => e.code === "plaintext-confirm");
  const req = normalizeApiLoginRequest("codex", "relay", { apiKey: ` ${KEY} `, baseUrl: "http://relay.example.com", acknowledgePlaintext: true, providerId: "My-Relay" });
  assert.equal(req.apiKey, KEY);
  assert.equal(req.providerId, "my-relay");
  assert.deepEqual(req.relay.warnings, ["plaintext-http"]);
  assert.throws(() => normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://r.example.com", providerId: "openai" }), (e) => e.code === "bad-provider");
});

test("把个人代理端口当成 API 地址时停下，不落 Key 或配置", async () => {
  for (const cli of ["codex", "claude"]) {
    const { deps, calls } = makeDeps({ responses: { inspect: ok(inspectOut()) } });
    const req = normalizeApiLoginRequest(cli, "relay", { apiKey: KEY, baseUrl: "http://127.0.0.1:7892", acknowledgePlaintext: true });
    await assert.rejects(runApiLogin(req, deps), error => error.code === "proxy-as-api" && error.field === "baseUrl");
    assert.deepEqual(calls.map(c => c.kind), ["inspect"]);
    assert.equal(req.apiKey, null);
  }
});

test("Codex 官方 key：codex login --with-api-key 经标准输入；把指向我们中转站的默认 provider 改回官方；核对状态", async () => {
  const config = upsertCodexProvider('model = "gpt-5"\n', { id: "relay", name: "r", baseUrl: "https://r.example.com/v1", envKey: "CWB_RELAY_API_KEY" }).text;
  const { deps, calls } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: config })),
      "codex-status": ok("Logged in using an API key - sk-test-***7890\n__CWB_EXIT__=0\n"),
    },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("codex", "api", { apiKey: KEY }), deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "codex-api-key", "write-config", "codex-status"]);
  assert.equal(calls[1].input, `${KEY}\n`);
  assert.doesNotMatch(calls[2].input, /^model_provider/m, "顶层 model_provider 去掉");
  assert.match(calls[2].input, /\[model_providers\.relay\]/, "provider 表保留");
  assert.equal(result.status.login, "apikey");
  assert.ok(result.notes.some((n) => /改回官方/.test(n)));
  assertKeyOnlyInInput(calls);
  assert.ok(!JSON.stringify(result).includes(KEY), "返回值里没有 key");
});

test("Codex 官方 key：集群上没有 codex → no-cli，什么都不写", async () => {
  const { deps, calls } = makeDeps({ responses: { inspect: ok(inspectOut({ cli: false })) } });
  await assert.rejects(runApiLogin(normalizeApiLoginRequest("codex", "api", { apiKey: KEY }), deps), (e) => e.code === "no-cli");
  assert.deepEqual(calls.map((c) => c.kind), ["inspect"]);
});

test("Codex 中转站（非 443）：先加白名单、等代理热载重测通过，再写 key 文件与 config.toml", async () => {
  let reachCount = 0;
  const { deps, calls, events } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: 'model = "gpt-5"\n' })),
      reach: () => {
        reachCount += 1;
        return ok(reachCount < 3 ? "curl: (56) CONNECT tunnel failed, response 403\n__CWB_HTTP__=000\n__CWB_CURL_EXIT__=56\n" : "__CWB_HTTP__=404\n__CWB_CURL_EXIT__=0\n");
      },
    },
  });
  const req = normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://relay.example.com:9443/v1", providerId: "relay" });
  const result = await runApiLogin(req, deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "reach", "reach", "reach", "write-key", "write-config"]);
  assert.deepEqual(events.filter((e) => e[0] === "addAllowlistEntry"), [["addAllowlistEntry", "relay.example.com:9443"]]);
  assert.equal(events.filter((e) => e[0] === "sleep").length, 2, "新加的白名单：间隔重测");
  assert.match(calls.find((c) => c.kind === "reach").command, /--proxytunnel/);
  const keyCall = calls.find((c) => c.kind === "write-key");
  assert.match(keyCall.command, /keys\/codex-relay\.env/);
  assert.equal(keyCall.input, `export CWB_RELAY_API_KEY='${KEY}'\n`);
  const cfg = calls.find((c) => c.kind === "write-config").input;
  assert.match(cfg, /^model_provider = "relay"$/m);
  assert.match(cfg, /^base_url = "https:\/\/relay\.example\.com:9443\/v1"$/m);
  assert.match(cfg, /^env_key = "CWB_RELAY_API_KEY"$/m);
  assert.ok(!cfg.includes(KEY), "config.toml 里只有变量名，没有 key");
  assert.ok(result.notes.some((n) => /白名单/.test(n)));
  assertKeyOnlyInInput(calls);
  assert.equal(req.apiKey, null, "用完即弃");
});

test("Codex 中转站：经隧道测不通 → 报错，key 与 config.toml 都不写", async () => {
  const { deps, calls } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: "" })),
      reach: ok("curl: (56) Proxy CONNECT aborted\n__CWB_HTTP__=000\n__CWB_CURL_EXIT__=56\n"),
    },
  });
  await assert.rejects(
    runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://relay.example.com/v1" }), deps),
    (e) => e.code === "relay-unreachable" && /没有写入/.test(e.message) && /Proxy CONNECT aborted/.test(e.message),
  );
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "reach"], "443 不加白名单、只测一次");
});

test("Codex 中转站：受管 env.sh 不存在（key 没处引入）→ env-missing；用户手写的同名 provider → provider-taken", async () => {
  const missing = makeDeps({ responses: { inspect: ok(inspectOut({ env: false })) } });
  await assert.rejects(runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://relay.example.com/v1" }), missing.deps), (e) => e.code === "env-missing");
  const { deps, calls } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: '[model_providers.relay]\nbase_url = "x"\n' })),
      reach: ok("__CWB_HTTP__=200\n"),
    },
  });
  await assert.rejects(runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://relay.example.com/v1" }), deps), (e) => e.code === "provider-taken");
  assert.ok(!calls.some((c) => c.kind.startsWith("write")), "什么都不写");
});

test("内网中转站：从集群直连测通 → 存进个人层 noProxyExtra 并重写 env.sh 的 NO_PROXY；直连不通 → 不写", async () => {
  const { deps, calls, events, state } = makeDeps({
    noProxyExtra: ["old.lab"],
    responses: {
      inspect: ok(inspectOut({ file: "" })),
      "reach-direct": ok("__CWB_HTTP__=401\n__CWB_CURL_EXIT__=0\n"),
    },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "http://10.0.0.5:8080/v1", acknowledgePlaintext: true }), deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "reach-direct", "write-env", "write-key", "write-config"]);
  assert.match(calls[1].command, /--noproxy '\\''\*'\\''/);
  assert.ok(!events.some((e) => e[0] === "addAllowlistEntry"), "内网地址不进白名单");
  assert.deepEqual(state.noProxyExtra, ["old.lab", "10.0.0.5"]);
  const expected = buildClusterEnvSteps({ port: 7892, noProxyExtra: ["old.lab", "10.0.0.5"] }).find((s) => s.id === "write-env");
  assert.equal(calls[2].command, expected.command);
  assert.match(expected.preview, /^export NO_PROXY="localhost,127\.0\.0\.1,::1,old\.lab,10\.0\.0\.5"$/m);
  assert.ok(result.warnings.some((w) => /明文/.test(w)), "http 明文警告");

  const failing = makeDeps({ responses: { inspect: ok(inspectOut({ file: "" })), "reach-direct": ok("curl: (7) Failed to connect\n__CWB_HTTP__=000\n") } });
  await assert.rejects(
    runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "http://10.0.0.5:8080/v1", acknowledgePlaintext: true }), failing.deps),
    (e) => e.code === "relay-unreachable" && /直连不到/.test(e.message),
  );
  assert.deepEqual(failing.calls.map((c) => c.kind), ["inspect", "reach-direct"]);
  assert.deepEqual(failing.state.noProxyExtra, [], "测不通不改个人层");
});

// 终审：个人层原先写在远端之前——env.sh 重写失败（或下面"没领端口"直接抛错）时留下"名单里有、集群上没有"的半截状态。
test("内网中转站：先重写集群 env.sh、成功后才记个人层；env.sh 写失败 → 个人层不动", async () => {
  const okRun = makeDeps({ responses: { inspect: ok(inspectOut({ file: "" })), "reach-direct": ok("__CWB_HTTP__=200\n") } });
  await runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://10.0.0.5/v1" }), okRun.deps);
  const order = okRun.events.map((e) => (e[0] === "remote" ? e[1] : e[0]));
  assert.ok(order.indexOf("write-env") !== -1 && order.indexOf("write-env") < order.indexOf("saveNoProxyExtra"), `先远端后本机：${order.join(" → ")}`);

  const failing = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: "" })),
      "reach-direct": ok("__CWB_HTTP__=200\n"),
      "write-env": { code: 1, stdout: "", stderr: "mv: cannot move: Disk quota exceeded" },
    },
  });
  await assert.rejects(
    runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://10.0.0.5/v1" }), failing.deps),
    (e) => e.code === "ssh-failed" && /NO_PROXY/.test(e.message) && /Disk quota exceeded/.test(e.message),
  );
  assert.deepEqual(failing.state.noProxyExtra, [], "远端没写成，个人层不留半截状态");
  assert.ok(!failing.events.some((e) => e[0] === "saveNoProxyExtra"));
  assert.ok(!failing.calls.some((c) => c.kind === "write-key" || c.kind === "write-config"), "key 与配置也不写");
});

// 终审：内网中转站是不需要隧道也能用的场景，没领端口不该在写完个人层之后抛"集群代理端口非法: null"。
test("内网中转站 + 没领端口 + 集群上没有 env.sh（Claude）：不算失败——跳过 env.sh、说明原因、照常写 settings.json 并记个人层", async () => {
  const { deps, calls, state } = makeDeps({
    port: null,
    responses: {
      inspect: ok(inspectOut({ env: false, file: "" })),
      "reach-direct": ok("__CWB_HTTP__=401\n__CWB_CURL_EXIT__=0\n"),
      "claude-status": ok('{"loggedIn": true, "authMethod": "api_key"}\n__CWB_EXIT__=0\n'),
    },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("claude", "relay", { apiKey: KEY, baseUrl: "http://10.0.0.5:8080", acknowledgePlaintext: true }), deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "reach-direct", "write-settings", "claude-status"], "不重写 env.sh");
  assert.deepEqual(state.noProxyExtra, ["10.0.0.5"], "个人层记下，之后做集群侧受管配置时带上");
  assert.ok(result.notes.some((n) => /还没有受管 env\.sh/.test(n) && /10\.0\.0\.5/.test(n) && /npm run setup/.test(n)), result.notes.join("\n"));
  assert.deepEqual(JSON.parse(calls[2].input).env, { ANTHROPIC_BASE_URL: "http://10.0.0.5:8080", ANTHROPIC_AUTH_TOKEN: KEY });
  assertKeyOnlyInInput(calls);
});

test("内网中转站 + 有端口但集群上没有 env.sh（Claude）：不凭空建 env.sh，同样说明并记个人层", async () => {
  const { deps, calls, state } = makeDeps({
    responses: { inspect: ok(inspectOut({ env: false, file: "" })), "reach-direct": ok("__CWB_HTTP__=200\n") },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("claude", "relay", { apiKey: KEY, baseUrl: "https://10.0.0.5" }), deps);
  assert.ok(!calls.some((c) => c.kind === "write-env"), "没有 env.sh 就不写它（只有引入块配套时它才有意义）");
  assert.deepEqual(state.noProxyExtra, ["10.0.0.5"]);
  assert.ok(result.notes.some((n) => /还没有受管 env\.sh/.test(n)));
});

test("内网中转站 + 集群上有 env.sh 但没领端口（Codex）：没法重写 env.sh → 给警告而不是失败；key、config.toml、个人层照写", async () => {
  const { deps, calls, state } = makeDeps({
    port: null,
    responses: { inspect: ok(inspectOut({ env: true, file: "" })), "reach-direct": ok("__CWB_HTTP__=200\n") },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://10.0.0.5/v1" }), deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "reach-direct", "write-key", "write-config"]);
  assert.deepEqual(state.noProxyExtra, ["10.0.0.5"]);
  assert.ok(result.warnings.some((w) => /还没领到反向端口/.test(w) && /NO_PROXY/.test(w) && /10\.0\.0\.5/.test(w)), result.warnings.join("\n"));
});

test("内网中转站已在名单里：不重复保存、不重写 env.sh", async () => {
  const { deps, calls, events } = makeDeps({
    noProxyExtra: ["10.0.0.5"],
    responses: { inspect: ok(inspectOut({ file: "" })), "reach-direct": ok("__CWB_HTTP__=200\n") },
  });
  await runApiLogin(normalizeApiLoginRequest("codex", "relay", { apiKey: KEY, baseUrl: "https://10.0.0.5/v1" }), deps);
  assert.ok(!calls.some((c) => c.kind === "write-env"));
  assert.ok(!events.some((e) => e[0] === "saveNoProxyExtra"));
});

test("Claude 官方 key：settings.json 合并写 ANTHROPIC_API_KEY（经标准输入、chmod 600），其余键保留", async () => {
  const settings = '{\n  "hooks": {"Stop": []},\n  "env": {"ANTHROPIC_BASE_URL": "https://old", "ANTHROPIC_AUTH_TOKEN": "t"}\n}\n';
  const { deps, calls } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: settings })),
      "claude-status": ok('{"loggedIn": true, "authMethod": "api_key"}\n__CWB_EXIT__=0\n'),
    },
  });
  const result = await runApiLogin(normalizeApiLoginRequest("claude", "api", { apiKey: KEY }), deps);
  assert.deepEqual(calls.map((c) => c.kind), ["inspect", "write-settings", "claude-status"]);
  const chmodAt = calls[1].command.indexOf("chmod 600 ~/.claude/settings.json.tmp.$$");
  assert.ok(chmodAt > 0 && chmodAt < calls[1].command.indexOf("cat > ~/.claude/settings.json.tmp.$$"), "临时文件先收紧到 600，再写入含 key 的内容");
  const written = JSON.parse(calls[1].input);
  assert.deepEqual(written.env, { ANTHROPIC_API_KEY: KEY });
  assert.deepEqual(written.hooks, { Stop: [] });
  assert.equal(result.status.login, "api");
  assertKeyOnlyInInput(calls);
});

test("Claude 中转站：BASE_URL + AUTH_TOKEN；非 443 先加白名单", async () => {
  const { deps, calls, events } = makeDeps({
    responses: { inspect: ok(inspectOut({ file: "" })), reach: ok("__CWB_HTTP__=200\n") },
  });
  await runApiLogin(normalizeApiLoginRequest("claude", "relay", { apiKey: KEY, baseUrl: "https://claude-relay.example.com:8443" }), deps);
  assert.deepEqual(events.find((e) => e[0] === "addAllowlistEntry"), ["addAllowlistEntry", "claude-relay.example.com:8443"]);
  const written = JSON.parse(calls.find((c) => c.kind === "write-settings").input);
  assert.deepEqual(written.env, { ANTHROPIC_BASE_URL: "https://claude-relay.example.com:8443", ANTHROPIC_AUTH_TOKEN: KEY });
});

test("Claude API：reclaude 接管时拒绝并说明——不加白名单、不测网、不写任何文件", async () => {
  const reclaude = JSON.stringify({ env: { HTTPS_PROXY: "http://127.0.0.1:40161", NODE_EXTRA_CA_CERTS: "/public/newhome/kai/.reclaude/ca.pem" } });
  const { deps, calls, events } = makeDeps({ port: 7891, responses: { inspect: ok(inspectOut({ file: reclaude })) } });
  await assert.rejects(
    runApiLogin(normalizeApiLoginRequest("claude", "relay", { apiKey: KEY, baseUrl: "https://claude-relay.example.com:8443" }), deps),
    (e) => e.code === "reclaude-managed" && /reclaude/.test(e.message) && e.status === 409,
  );
  assert.deepEqual(calls.map((c) => c.kind), ["inspect"]);
  assert.deepEqual(events.filter((e) => e[0] === "addAllowlistEntry"), []);
});

test("SSH 失败：错误原因里带脱敏后的输出，不带 key", async () => {
  const { deps } = makeDeps({
    responses: {
      inspect: ok(inspectOut({ file: "" })),
      "codex-api-key": { code: 1, stdout: "", stderr: `Error: invalid key ${KEY}` },
    },
  });
  await assert.rejects(runApiLogin(normalizeApiLoginRequest("codex", "api", { apiKey: KEY }), deps), (e) => {
    assert.equal(e.code, "ssh-failed");
    assert.ok(!e.message.includes(KEY), e.message);
    return true;
  });
});
