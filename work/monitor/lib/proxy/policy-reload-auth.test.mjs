// 代理口令的加载与热重载（v2.62）。核心是一条：口令文件读不出、格式不对，绝不能让放行变成拒绝。
// 新用例单独成文件，policy-reload.test.mjs 原样不动——它是「关着的时候行为不变」的对照。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTH_OFF, classifyProxyAuthorization } from "./auth.mjs";
import { buildPolicy, createPolicyLoader } from "./policy-reload.mjs";

const TOKEN = "TestTokenAAAAbbbbCCCCdddd0123456";
const NEW_TOKEN = "NextTokenEEEEffffGGGGhhhh7654321";
const AUTH_PATH = "/runtime/proxy-auth.json";
const basic = (token) => `Basic ${Buffer.from(`cwb:${token}`).toString("base64")}`;
const authFile = (extra = {}) => JSON.stringify({ v: 1, mode: "enforce", user: "cwb", token: TOKEN, updatedAt: 1, ...extra });

// 注入版装配：分层配置固定为空；口令文件的内容与文件戳由测试推进。
//   file: 字符串 = 文件全文；null = 文件不存在；Error = 读的时候抛这个错。
function harness({ file = null, config = {}, withAuthPath = true } = {}) {
  const state = { file, authStamp: 1, configStamp: 1, config, reads: 0, changes: [] };
  const lines = [];
  const intervals = [];
  const loader = createPolicyLoader({
    configPath: "/team/config.json",
    localConfigPath: "/me/config.local.json",
    loadConfig: () => state.config,
    stamp: (p) => {
      if (p !== AUTH_PATH) return `${p}#${state.configStamp}`;
      return state.file === null ? "missing" : `auth#${state.authStamp}`;
    },
    detector: { detect: async () => ({ proxy: null }) },
    ...(withAuthPath ? { authPath: AUTH_PATH } : {}),
    readAuthFile: () => {
      state.reads += 1;
      if (state.file instanceof Error) throw state.file;
      return state.file;
    },
    onAuthChange: (auth) => state.changes.push(auth.mode),
    log: (line) => lines.push(line),
    setIntervalImpl: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearIntervalImpl: () => {},
  });
  const write = (next) => {
    state.file = next;
    state.authStamp += 1;
  };
  return { loader, state, lines, intervals, write, authLines: () => lines.filter((line) => /口令/.test(line)) };
}

const verdict = (loader, token) => classifyProxyAuthorization(loader.getPolicy().auth, token ? basic(token) : undefined, 1000);

test("没有口令文件（升级后没人打开过）：口令是关，日志与回调都没有任何新动静", async () => {
  const h = harness({ file: null });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().auth, AUTH_OFF);
  assert.deepEqual(h.authLines(), []);
  assert.deepEqual(h.state.changes, []);
  assert.equal(h.state.reads, 0, "文件不存在就不去读");
  // 与没有这项功能时同一行启动日志。
  assert.deepEqual(h.lines, ["[proxy-config] 策略已加载：白名单 0 条，出网 直连"]);
  assert.equal(await h.loader.checkAuth(), false, "戳没变不重读");
});

test("没给口令文件路径（运行目录解析不出来 / 旧的调用方式）：恒为关，轮询什么都不做", async () => {
  const h = harness({ file: authFile(), withAuthPath: false });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().auth, AUTH_OFF);
  assert.equal(await h.loader.checkAuth(), false);
  assert.equal(h.state.reads, 0);
  assert.equal(buildPolicy().auth, AUTH_OFF, "buildPolicy 缺省就是关");
});

test("首次加载就有口令文件：按文件里的模式生效，回调一次，日志不含口令", async () => {
  const h = harness({ file: authFile({ mode: "observe" }) });
  await h.loader.load();
  assert.equal(h.loader.getPolicy().auth.mode, "observe");
  assert.equal(verdict(h.loader, TOKEN), "ok");
  assert.deepEqual(h.state.changes, ["observe"]);
  assert.deepEqual(h.authLines(), ["[proxy-config] 代理口令已生效：只记录"]);
  assert.equal(h.lines.join("\n").includes(TOKEN), false);
});

test("热重载：关 → 只记录 → 强制 → 换口令 → 关，每一步约 2 秒内生效；策略对象整体换新", async () => {
  const h = harness({ file: null });
  await h.loader.load();
  const first = h.loader.getPolicy();

  h.write(authFile({ mode: "observe" }));
  assert.equal(await h.loader.checkAuth(), true);
  assert.equal(h.loader.getPolicy().auth.mode, "observe");
  assert.notEqual(h.loader.getPolicy(), first, "新策略是新对象");
  assert.equal(h.loader.getPolicy().allowTarget, first.allowTarget, "白名单 / 出网方式那一半原样带着");

  h.write(authFile({ mode: "enforce" }));
  await h.loader.checkAuth();
  assert.equal(h.loader.getPolicy().auth.mode, "enforce");

  // 换口令：新口令生效，旧口令在过渡期内继续接受。
  h.write(authFile({ token: NEW_TOKEN, previousToken: TOKEN, previousUntil: 5000 }));
  await h.loader.checkAuth();
  assert.equal(verdict(h.loader, NEW_TOKEN), "ok");
  assert.equal(verdict(h.loader, TOKEN), "ok");
  assert.equal(classifyProxyAuthorization(h.loader.getPolicy().auth, basic(TOKEN), 5000), "bad", "过渡期一过旧口令失效，不需要再改文件");

  // 过渡期结束，控制面把上一个口令拿掉。
  h.write(authFile({ token: NEW_TOKEN }));
  await h.loader.checkAuth();
  assert.equal(verdict(h.loader, TOKEN), "bad");

  h.write(authFile({ mode: "off", token: NEW_TOKEN }));
  await h.loader.checkAuth();
  assert.equal(h.loader.getPolicy().auth, AUTH_OFF);

  assert.deepEqual(h.state.changes, ["observe", "enforce", "enforce", "enforce", "off"]);
  assert.deepEqual(h.authLines(), [
    "[proxy-config] 代理口令已生效：只记录",
    "[proxy-config] 代理口令已生效：强制",
    "[proxy-config] 代理口令已更换：强制，过渡期内上一个口令仍接受",
    "[proxy-config] 代理口令的过渡期已更新：强制",
    "[proxy-config] 代理口令已生效：关",
  ]);
  for (const secret of [TOKEN, NEW_TOKEN]) assert.equal(h.lines.join("\n").includes(secret), false, "日志里没有口令");
});

test("文件重写但内容等价（同样的模式与口令）：不换策略、不打日志、不回调", async () => {
  const h = harness({ file: authFile() });
  await h.loader.load();
  const policy = h.loader.getPolicy();
  h.write(authFile({ updatedAt: 999 }));
  assert.equal(await h.loader.checkAuth(), true, "戳变了，读过一次");
  assert.equal(h.loader.getPolicy(), policy);
  assert.equal(h.authLines().length, 1);
  assert.deepEqual(h.state.changes, ["enforce"]);
});

const BROKEN = [
  ["半截 JSON", "{ \"v\": 1, \"mode\": \"enf", /格式不对（not-json）/],
  ["空文件", "", /格式不对（not-json）/],
  ["模式写错", authFile({ mode: "strict" }), /格式不对（bad-mode）/],
  ["口令形状不对", authFile({ token: "short" }), /格式不对（bad-token）/],
  ["打开了却没有口令", JSON.stringify({ v: 1, mode: "enforce", user: "cwb" }), /格式不对（bad-token）/],
  ["版本号不认识", authFile({ v: 9 }), /格式不对（bad-version）/],
  ["不是对象", "[1,2,3]", /格式不对（not-object）/],
  ["读不出（权限）", Object.assign(new Error("EACCES: permission denied, open '/runtime/proxy-auth.json'"), { code: "EACCES" }), /读取失败（EACCES）/],
];

for (const [name, content, pattern] of BROKEN) {
  test(`坏文件（${name}）：放行着的继续放行——首次加载按关；运行中从关 / 只记录变坏，仍不拦任何请求`, async () => {
    // ① 启动时文件就是坏的：没有上一份可保留，按关。
    const cold = harness({ file: content });
    await cold.loader.load();
    assert.equal(cold.loader.getPolicy().auth, AUTH_OFF);
    assert.match(cold.authLines().at(-1), pattern);
    assert.match(cold.authLines().at(-1), /口令设置保持「关」不变/);
    assert.deepEqual(cold.state.changes, []);

    // ② 运行中：关 → 坏文件，还是关。
    const fromOff = harness({ file: null });
    await fromOff.loader.load();
    fromOff.write(content);
    await fromOff.loader.checkAuth();
    assert.equal(fromOff.loader.getPolicy().auth, AUTH_OFF);

    // ③ 运行中：只记录 → 坏文件，还是只记录（全部放行）。
    const fromObserve = harness({ file: authFile({ mode: "observe" }) });
    await fromObserve.loader.load();
    const kept = fromObserve.loader.getPolicy();
    fromObserve.write(content);
    await fromObserve.loader.checkAuth();
    assert.equal(fromObserve.loader.getPolicy(), kept, "保留上一份，策略对象都没换");
    assert.match(fromObserve.authLines().at(-1), /口令设置保持「只记录」不变/);
    assert.deepEqual(fromObserve.state.changes, ["observe"], "没有多余的回调");

    // 同一份坏文件只告警一次：之后的轮询戳没变，不重读、不刷屏。
    const lineCount = fromObserve.lines.length;
    for (let i = 0; i < 5; i += 1) await fromObserve.loader.checkAuth();
    assert.equal(fromObserve.lines.length, lineCount);

    // 告警里没有文件内容。
    for (const h of [cold, fromOff, fromObserve]) assert.equal(h.lines.join("\n").includes(TOKEN), false);
  });
}

test("坏文件不会放松强制：强制 → 坏文件，仍按上一份强制（带对口令的照常放行）；修好后立即跟上", async () => {
  const h = harness({ file: authFile() });
  await h.loader.load();
  h.write("{ broken");
  await h.loader.checkAuth();
  assert.equal(h.loader.getPolicy().auth.mode, "enforce");
  assert.equal(verdict(h.loader, TOKEN), "ok");
  assert.equal(verdict(h.loader, null), "missing");
  assert.match(h.authLines().at(-1), /口令设置保持「强制」不变/);

  h.write(authFile({ mode: "observe" }));
  await h.loader.checkAuth();
  assert.equal(h.loader.getPolicy().auth.mode, "observe");
});

test("口令文件被删掉：回到关（唯一的口令副本没了，继续强制只会把所有人锁在外面）", async () => {
  const h = harness({ file: authFile() });
  await h.loader.load();
  h.write(null);
  assert.equal(await h.loader.checkAuth(), true);
  assert.equal(h.loader.getPolicy().auth, AUTH_OFF);
  assert.deepEqual(h.state.changes, ["enforce", "off"]);
  assert.equal(h.authLines().at(-1), "[proxy-config] 代理口令已生效：关");
});

test("口令与白名单 / 出网方式互不牵连：改配置不重读口令、不丢口令；改口令不重读配置", async () => {
  let configLoads = 0;
  const h = harness({ file: authFile({ mode: "observe" }) });
  const original = h.state.config;
  Object.defineProperty(h.state, "config", { get: () => { configLoads += 1; return original; }, configurable: true });
  await h.loader.load();
  const loadsAfterStart = configLoads;
  const readsAfterStart = h.state.reads;

  h.write(authFile({ mode: "enforce" }));
  await h.loader.checkAuth();
  assert.equal(configLoads, loadsAfterStart, "口令变了不重读分层配置");

  Object.defineProperty(h.state, "config", { value: { proxyAllowedTargets: ["relay.example.com:9443"] }, writable: true });
  h.state.configStamp += 1;
  assert.equal(await h.loader.checkConfig(), true);
  assert.equal(h.state.reads, readsAfterStart + 1, "配置变了不重读口令文件");
  assert.equal(h.loader.getPolicy().auth.mode, "enforce", "新策略带着当前的口令设置");
  assert.equal(h.loader.getPolicy().allowTarget("relay.example.com", 9443), true);
});

test("回调抛错不影响口令生效；同一个 2 秒定时器既查配置也查口令（不多起定时器）", async () => {
  const h = harness({ file: null });
  const loader = createPolicyLoader({
    configPath: "/team/config.json",
    loadConfig: () => ({}),
    stamp: () => "auth#1",
    detector: { detect: async () => ({ proxy: null }) },
    authPath: AUTH_PATH,
    readAuthFile: () => authFile(),
    onAuthChange: () => { throw new Error("recorder exploded"); },
    log: () => {},
    setIntervalImpl: h.intervals.push.bind(h.intervals),
    clearIntervalImpl: () => {},
  });
  await loader.load();
  assert.equal(loader.getPolicy().auth.mode, "enforce");

  await h.loader.load();
  h.loader.start();
  assert.deepEqual(h.intervals.map((i) => i.ms), [2000, 30_000]);
  h.write(authFile({ mode: "observe" }));
  h.intervals[0].fn(); // 2 秒那一拍
  await h.loader.checkAuth(); // 排在同一个串行队列后面：等它跑完
  assert.equal(h.loader.getPolicy().auth.mode, "observe");
});

test("真实文件：写入、改坏、删除三种情况各读一次真盘", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "policy-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "config.json");
  const authPath = path.join(dir, "runtime", "proxy-auth.json");
  writeFileSync(configPath, "{}");
  const lines = [];
  const loader = createPolicyLoader({ configPath, localConfigPath: path.join(dir, "config.local.json"), authPath, log: (line) => lines.push(line), detector: { detect: async () => ({ proxy: null }) } });
  await loader.load();
  assert.equal(loader.getPolicy().auth, AUTH_OFF, "目录都不存在：关");

  // 与控制面一样先写临时文件再改名：换 inode，文件戳必变。
  mkdirSync(path.dirname(authPath), { recursive: true });
  let seq = 0;
  const replace = (text) => {
    seq += 1;
    const tmp = `${authPath}.tmp.${seq}`;
    writeFileSync(tmp, text);
    renameSync(tmp, authPath);
  };

  replace(authFile());
  assert.equal(await loader.checkAuth(), true);
  assert.equal(loader.getPolicy().auth.mode, "enforce");

  replace("{ definitely broken");
  await loader.checkAuth();
  assert.equal(loader.getPolicy().auth.mode, "enforce", "改坏：保留上一份");
  assert.match(lines.at(-1), /口令文件格式不对（not-json），口令设置保持「强制」不变/);

  replace(JSON.stringify({ pad: "x".repeat(8192) }));
  await loader.checkAuth();
  assert.equal(loader.getPolicy().auth.mode, "enforce", "不是我们写的大文件不读");
  assert.match(lines.at(-1), /口令文件读取失败（too-large）/);

  unlinkSync(authPath);
  await loader.checkAuth();
  assert.equal(loader.getPolicy().auth, AUTH_OFF, "删掉：关");
  assert.equal(lines.join("\n").includes(TOKEN), false);
});
