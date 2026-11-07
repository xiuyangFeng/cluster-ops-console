// 代理口令的业务层：真实的口令存储（临时目录）+ 注入的使用记录与集群同步。
// 贯穿的断言：给界面的任何返回值里都没有口令，也没有口令的指纹。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { credentialFingerprint } from "../cluster-env.mjs";
import { USAGE_HOUR_MS } from "../proxy/usage.mjs";
import { createProxyAuthService, describeProxyAuthState, PROXY_AUTH_APPLY_GRACE_MS } from "./proxy-auth-service.mjs";
import { createProxyAuthStore } from "./proxy-auth-store.mjs";

const NOW = 500 * USAGE_HOUR_MS + 60_000;
const TEAM = { id: "server-01", name: "主集群", host: "h", source: "team", remotePort: 7891 };

function setup(t, { usage = null, servers = [TEAM], activeServerId = "server-01", cluster = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-auth-service-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "proxy-auth.json");
  const clock = { now: NOW };
  const store = createProxyAuthStore({ filePath, now: () => clock.now });
  const state = { usage, fingerprint: undefined, env: { state: "in-sync", checkedAt: NOW - 5000, error: null }, syncCalls: [], syncResult: null, logs: [] };
  const clusterEnvSync = cluster === null ? null : {
    getState: (serverId) => (serverId === "server-01" ? state.env : null),
    getCredentialState: (serverId) => (serverId === "server-01" && state.fingerprint !== undefined ? { fingerprint: state.fingerprint, checkedAt: NOW - 5000 } : null),
    syncCredential: async (serverId, options) => {
      state.syncCalls.push([serverId, options]);
      return state.syncResult;
    },
  };
  const service = createProxyAuthService({
    store,
    usagePath: "/runtime/proxy-usage.json",
    readUsage: () => state.usage,
    getConfig: async () => ({ activeServerId, servers }),
    getClusterEnvSync: () => clusterEnvSync,
    now: () => clock.now,
    log: (line) => state.logs.push(line),
  });
  const raw = () => JSON.parse(readFileSync(filePath, "utf8"));
  // 任何一个给界面的值：序列化之后不含当前 / 上一个口令，也不含它们的指纹。
  const assertPublic = (value) => {
    const text = JSON.stringify(value);
    const file = (() => { try { return raw(); } catch { return {}; } })();
    for (const token of [file.token, file.previousToken].filter(Boolean)) {
      assert.equal(text.includes(token), false, "响应里出现了口令");
      assert.equal(text.includes(credentialFingerprint({ user: "cwb", password: token })), false, "响应里出现了口令的指纹");
      assert.equal(text.includes(Buffer.from(`cwb:${token}`).toString("base64")), false);
    }
    return value;
  };
  return { service, store, state, clock, raw, assertPublic };
}

// [conn, up, down, lastAt, authed, missing, bad, denied]
const usageWith = (targets, { pid = 4242, mode = "observe" } = {}) => ({
  pid,
  startedAt: 1,
  writtenAt: NOW - 2000,
  auth: { mode, since: NOW - 60_000 },
  hours: [{ t: 500 * USAGE_HOUR_MS, targets: new Map(Object.entries(targets)) }],
});

test("describeProxyAuthState：代理按什么模式在跑，只认「正在监听的那个进程」写的回报", () => {
  const usage = { pid: 4242, auth: { mode: "enforce", since: 77 } };
  const running = { running: true, pid: 4242 };
  assert.deepEqual(describeProxyAuthState({ configuredMode: "enforce", usage, proxy: running }), { state: "applied", mode: "enforce", since: 77 });
  assert.deepEqual(describeProxyAuthState({ configuredMode: "observe", usage, proxy: running }), { state: "pending", mode: "enforce", since: 77 }, "回报的还是另一个模式");
  assert.deepEqual(describeProxyAuthState({ configuredMode: "off", usage, proxy: running }), { state: "pending", mode: "enforce", since: 77 });
  // 没有回报：配置是关时不需要确认（关就是什么都不做）；不是关时说明代理是不认识口令的旧版本。
  assert.deepEqual(describeProxyAuthState({ configuredMode: "off", usage: null, proxy: running }), { state: "applied", mode: null, since: null });
  assert.deepEqual(describeProxyAuthState({ configuredMode: "enforce", usage: null, proxy: running }), { state: "unconfirmed", mode: null, since: null });
  // 刚改完的头几秒：代理还没来得及热载、第一份回报还没写——这不说明它是旧版本，先按「还没生效」报；过了宽限才说旧版本。
  const justChanged = (ms, extra = {}) => describeProxyAuthState({ configuredMode: "observe", usage: null, proxy: running, changedAt: 1_000_000, now: 1_000_000 + ms, ...extra });
  assert.deepEqual(justChanged(0), { state: "pending", mode: null, since: null });
  assert.equal(justChanged(PROXY_AUTH_APPLY_GRACE_MS - 1).state, "pending");
  assert.equal(justChanged(PROXY_AUTH_APPLY_GRACE_MS).state, "unconfirmed");
  assert.equal(justChanged(-5000).state, "unconfirmed", "时钟回拨：不当成刚改完");
  assert.equal(justChanged(100, { changedAt: null }).state, "unconfirmed", "不知道什么时候改的");
  assert.equal(justChanged(100, { configuredMode: "off" }).state, "applied", "关：没有回报也算");
  assert.equal(justChanged(100, { proxy: { running: false, pid: null } }).state, "not-running");
  assert.deepEqual(justChanged(100, { usage }), { state: "pending", mode: "enforce", since: 77 }, "有回报就按回报说");
  assert.ok(PROXY_AUTH_APPLY_GRACE_MS >= 4000, "代理约 2 秒热载一次：宽限至少留出两个周期");
  // 回报是别的进程（上一个代理）写的、或 /proxy-health 没给 pid（旧代理）：不作数。
  assert.equal(describeProxyAuthState({ configuredMode: "enforce", usage, proxy: { running: true, pid: 9999 } }).state, "unconfirmed");
  assert.equal(describeProxyAuthState({ configuredMode: "enforce", usage, proxy: { running: true, pid: null } }).state, "unconfirmed");
  assert.deepEqual(describeProxyAuthState({ configuredMode: "enforce", usage, proxy: { running: false, pid: null } }), { state: "not-running", mode: null, since: null });
  assert.equal(describeProxyAuthState({ configuredMode: "enforce", usage, proxy: null }).state, "not-running");
});

test("getView：从没打开过——关、没有口令、全零；一个字节都不写", async (t) => {
  const { service, raw } = setup(t);
  const view = await service.getView({ proxy: { running: true, pid: 4242 } });
  assert.deepEqual(view, {
    mode: "off",
    hasToken: false,
    updatedAt: null,
    rotation: null,
    issue: null,
    proxy: { state: "applied", mode: null, since: null },
    cluster: { serverId: "server-01", serverName: "主集群", env: "in-sync", credential: "unknown", checkedAt: NOW - 5000, error: null },
    stats: { windowHours: 24, since: null, authed: 0, missing: 0, bad: 0, denied: 0, targets: [], moreTargets: 0, moreRequests: 0 },
    // 现在切到「强制」要先确认的事：界面在切换前列给人看，与 setMode 拦下来的是同一份判断。
    enforceRisks: [{ code: "no-observation" }, { code: "cluster-not-synced", serverName: "主集群", credential: "unknown" }],
    // 已经是强制之后仍在断网的事：不是强制时为 null。
    clusterAlert: null,
  });
  assert.throws(() => raw(), { code: "ENOENT" }, "读状态不会把口令文件建出来");
  assert.equal(service.getCredential(), null);
  assert.equal(service.localAuthorization(), "");
  assert.equal(service.curlInput(), null);
});

test("getView：第一次从关打开——代理的第一份回报到之前先报「还没生效」，过了宽限仍没有才说是旧版本", async (t) => {
  const { service, state, clock } = setup(t);
  const running = { running: true, pid: 4242 };
  await service.setMode({ mode: "observe" });
  assert.deepEqual((await service.getView({ proxy: running })).proxy, { state: "pending", mode: null, since: null });
  clock.now = NOW + PROXY_AUTH_APPLY_GRACE_MS - 1;
  assert.equal((await service.getView({ proxy: running })).proxy.state, "pending");
  // 新版本的代理：约 2 秒后回报到了。
  state.usage = usageWith({});
  assert.deepEqual((await service.getView({ proxy: running })).proxy, { state: "applied", mode: "observe", since: NOW - 60_000 });
  // 旧版本的代理：一直没有回报，过了宽限就这么说。
  state.usage = null;
  clock.now = NOW + PROXY_AUTH_APPLY_GRACE_MS;
  assert.equal((await service.getView({ proxy: running })).proxy.state, "unconfirmed");
  // 之后再改一次设置（换口令）：宽限从这次改动重新算。
  await service.rotate();
  assert.equal((await service.getView({ proxy: running })).proxy.state, "pending");
  assert.equal((await service.getView({ proxy: { running: false, pid: null } })).proxy.state, "not-running");
});

test("getView：只记录中——带对 / 没带的请求数、没带口令的目标、集群上带的是哪一个口令；响应里没有口令", async (t) => {
  const { service, state, raw, assertPublic } = setup(t, {
    usage: usageWith({
      "api.openai.com:443": [5, 100, 900, NOW - 10, 3, 2, 0, 0],
      "chatgpt.com:443": [2, 10, 20, NOW - 20, 0, 4, 1, 0],
      "api.anthropic.com:443": [1, 1, 1, NOW - 30, 6, 0, 0, 0],
    }),
  });
  await service.setMode({ mode: "observe" });
  const token = raw().token;
  const view = assertPublic(await service.getView({ proxy: { running: true, pid: 4242 } }));
  assert.equal(view.mode, "observe");
  assert.equal(view.hasToken, true);
  assert.deepEqual(view.proxy, { state: "applied", mode: "observe", since: NOW - 60_000 });
  assert.deepEqual({ authed: view.stats.authed, missing: view.stats.missing, bad: view.stats.bad, denied: view.stats.denied }, { authed: 9, missing: 6, bad: 1, denied: 0 });
  assert.deepEqual(view.stats.targets.map((item) => [item.target, item.missing + item.bad]), [["chatgpt.com:443", 5], ["api.openai.com:443", 2]]);

  // 集群上那一份的几种情况。
  const credentialOf = async () => (await service.getView({ proxy: null })).cluster.credential;
  state.fingerprint = "none";
  assert.equal(await credentialOf(), "none");
  state.fingerprint = credentialFingerprint({ user: "cwb", password: token });
  assert.equal(await credentialOf(), "current");
  state.fingerprint = "0123456789abcdef";
  assert.equal(await credentialOf(), "other");
  state.fingerprint = "nohash";
  assert.equal(await credentialOf(), "unverified");
  state.fingerprint = null;
  assert.equal(await credentialOf(), "unknown");
  state.env = { state: "absent", checkedAt: NOW, error: null };
  assert.equal(await credentialOf(), "none", "集群上没有受管 env.sh");

  // 给本进程里要带口令的调用方的才是原文。
  assert.deepEqual(service.getCredential(), { user: "cwb", password: token });
  assert.equal(service.localAuthorization(), `Basic ${Buffer.from(`cwb:${token}`).toString("base64")}`);
  assert.equal(service.curlInput(), `proxy-user = "cwb:${token}"\n`);
});

test("换口令后集群上还是上一个口令：识别为 previous；过渡期提示里只有截止时刻", async (t) => {
  const { service, state, raw, assertPublic, clock } = setup(t);
  await service.setMode({ mode: "observe" });
  const first = raw().token;
  state.fingerprint = credentialFingerprint({ user: "cwb", password: first });
  const rotated = assertPublic(service.rotate());
  assert.equal(rotated.previousUntil, clock.now + 24 * 3600_000);
  const view = assertPublic(await service.getView({ proxy: null }));
  assert.equal(view.cluster.credential, "previous");
  assert.deepEqual(view.rotation, { until: rotated.previousUntil });
  assert.throws(() => service.rotate(), { status: 409, code: "rotation-in-progress" });
  service.rotate({ force: true });
  assert.equal((await service.getView({ proxy: null })).cluster.credential, "other", "强行再换一次之后，集群上那个已经不被接受");
  service.retirePrevious();
  assert.equal((await service.getView({ proxy: null })).rotation, null);
});

test("没有团队服务器 / 没有集群同步（fixture）：cluster 为 null；查看中的是个人服务器时取第一台团队服务器", async (t) => {
  const personal = { id: "mine", host: "p", source: "personal", remotePort: 7999 };
  assert.equal((await setup(t, { servers: [personal], activeServerId: "mine" }).service.getView()).cluster, null);
  assert.equal((await setup(t, { cluster: null }).service.getView()).cluster, null);
  assert.equal((await setup(t, { servers: [personal, TEAM], activeServerId: "mine" }).service.getView()).cluster.serverId, "server-01");
  assert.equal((await setup(t, { servers: [{ ...TEAM, disabled: true }] }).service.getView()).cluster, null);
});

test("setMode：关 ↔ 只记录不需要确认；切到强制而有风险时先 409 给出清单，确认后才写", async (t) => {
  const { service, state, raw, assertPublic } = setup(t, { usage: usageWith({ "chatgpt.com:443": [2, 10, 20, NOW - 20, 0, 4, 1, 0] }) });
  assert.deepEqual(await service.setMode({ mode: "observe" }), { created: true, reset: false });
  assert.equal(raw().mode, "observe");
  state.fingerprint = "none";

  let refused = null;
  await service.setMode({ mode: "enforce" }).catch((err) => { refused = err; });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "confirm-required");
  assertPublic(refused.risks);
  assert.deepEqual(refused.risks, [
    { code: "unauthenticated", requests: 5, targets: [{ target: "chatgpt.com:443", missing: 4, bad: 1, denied: 0, lastAt: NOW - 20 }], moreTargets: 0 },
    { code: "cluster-not-synced", serverName: "主集群", credential: "none" },
  ]);
  assert.equal(raw().mode, "observe", "没确认：什么都没改");

  // 界面拿到的风险清单与被拦下来时的是同一份。
  assert.deepEqual((await service.getView()).enforceRisks, refused.risks);
  assert.deepEqual(await service.setMode({ mode: "enforce", confirm: true }), { created: false, reset: false });
  assert.equal(raw().mode, "enforce");
  assert.deepEqual((await service.getView()).enforceRisks, [], "已经是强制：没有要确认的事");
  // 已经是强制：再设一次不用再确认（幂等）。
  await service.setMode({ mode: "enforce" });
  await service.setMode({ mode: "off" });
  assert.equal(raw().mode, "off");
  await assert.rejects(service.setMode({ mode: "strict" }), { status: 400, code: "bad-mode" });
  await assert.rejects(service.setMode({}), { status: 400, code: "bad-mode" });
  for (const line of state.logs) assert.equal(line.includes(raw().token), false, "运维日志里没有口令");
});

test("clusterAlert（v2.64）：已是强制而集群上不是当前口令时仍要警告；查到了才报，只记录 / 关时不报；enforceRisks 语义不变", async (t) => {
  const { service, state, raw, assertPublic } = setup(t, { usage: usageWith({ "api.openai.com:443": [5, 1, 1, NOW - 10, 5, 0, 0, 0] }) });
  await service.setMode({ mode: "observe" });
  const token = raw().token;
  const alertOf = async () => assertPublic(await service.getView({ proxy: null })).clusterAlert;

  // 只记录：集群上没带口令只是切换前的风险，不是警告。
  state.fingerprint = "none";
  assert.equal(await alertOf(), null);
  assert.deepEqual((await service.getView()).enforceRisks, [{ code: "cluster-not-synced", serverName: "主集群", credential: "none" }]);

  await service.setMode({ mode: "enforce", confirm: true });
  const view = assertPublic(await service.getView({ proxy: null }));
  assert.deepEqual(view.enforceRisks, [], "切换前的确认清单：已经是强制时仍为空");
  assert.deepEqual(view.clusterAlert, { code: "cluster-not-synced", serverName: "主集群", credential: "none" });

  // 认不得的（另一台电脑写的、更早的）与还是上一个（过渡期一过就断）都报。
  state.fingerprint = "0123456789abcdef";
  assert.deepEqual(await alertOf(), { code: "cluster-not-synced", serverName: "主集群", credential: "other" });
  state.fingerprint = credentialFingerprint({ user: "cwb", password: token });
  service.rotate();
  assert.deepEqual(await alertOf(), { code: "cluster-not-synced", serverName: "主集群", credential: "previous" });

  // 已写入当前口令：不报。
  state.fingerprint = credentialFingerprint({ user: "cwb", password: raw().token });
  assert.equal(await alertOf(), null);
  // 没查到、核对不了：没有证据，不报（事实行里照常说明）。
  state.fingerprint = null;
  assert.equal(await alertOf(), null);
  state.fingerprint = "nohash";
  assert.equal(await alertOf(), null);
  // 集群上没有受管配置：那是接入没做完，不是口令不同步。
  state.fingerprint = "none";
  state.env = { state: "absent", checkedAt: NOW, error: null };
  assert.equal(await alertOf(), null);
  state.env = { state: "in-sync", checkedAt: NOW, error: null };
  assert.equal((await alertOf())?.credential, "none");

  // 没有团队服务器 / fixture：没有集群可言，不报。
  const noCluster = setup(t, { cluster: null });
  await noCluster.service.setMode({ mode: "enforce", confirm: true });
  assert.equal((await noCluster.service.getView()).clusterAlert, null);

  // 关掉：不报。
  await service.setMode({ mode: "off" });
  assert.equal(await alertOf(), null);
});

test("setMode：没有任何风险（观察过、没人不带口令、集群上已是当前口令）时切强制不用确认；从没观察过要确认", async (t) => {
  const clean = setup(t, { usage: usageWith({ "api.openai.com:443": [5, 1, 1, NOW - 10, 5, 0, 0, 0] }) });
  await clean.service.setMode({ mode: "observe" });
  clean.state.fingerprint = credentialFingerprint({ user: "cwb", password: clean.raw().token });
  await clean.service.setMode({ mode: "enforce" });
  assert.equal(clean.raw().mode, "enforce");

  const blind = setup(t);
  await blind.service.setMode({ mode: "observe" });
  blind.state.fingerprint = credentialFingerprint({ user: "cwb", password: blind.raw().token });
  await assert.rejects(blind.service.setMode({ mode: "enforce" }), (err) => err.code === "confirm-required" && err.risks.length === 1 && err.risks[0].code === "no-observation");
});

test("sync：不带 confirm 只预览；带了才写；各种写不了的情况给出说明", async (t) => {
  const { service, state, assertPublic } = setup(t);
  await service.setMode({ mode: "observe" });
  const plan = { env: { path: "~/.config/cluster-workbench/env.sh", credential: "add", port: null, action: "write" }, claude: { path: "~/.claude/settings.json", action: "skip", reason: "no-claude", changedKeys: [] } };

  state.syncResult = { status: "preview", plan };
  assert.deepEqual(assertPublic(await service.sync({})), { serverId: "server-01", serverName: "主集群", status: "preview", plan, changed: [], warning: null });
  state.syncResult = { status: "synced", plan, changed: ["~/.config/cluster-workbench/env.sh"], warning: null };
  assert.equal((await service.sync({ confirm: true })).status, "synced");
  assert.deepEqual(state.syncCalls, [["server-01", { preview: true }], ["server-01", { preview: false }]]);

  for (const [status, pattern] of [["absent", /还没有工作台的受管配置/], ["no-token", /还没有口令/], ["no-port", /还没有反向端口/], ["ineligible", /没有可以写入的团队服务器/]]) {
    state.syncResult = { status };
    await assert.rejects(service.sync({ confirm: true }), (err) => err.status === 409 && err.code === status && pattern.test(err.message), status);
  }
  state.syncResult = { status: "failed", error: "改写 ~/.config/cluster-workbench/env.sh 失败（Connection closed），原文件未改动" };
  await assert.rejects(service.sync({ confirm: true }), (err) => err.status === 502 && /没有写成：改写/.test(err.message));

  await assert.rejects(setup(t, { cluster: null }).service.sync({}), { status: 503, code: "unavailable" });
  // fixture 模式：直接 409，连集群同步都不去取。
  const fixture = createProxyAuthService({ store: createProxyAuthStore({ filePath: "/nowhere/proxy-auth.json" }), usagePath: null, readUsage: () => null, getConfig: async () => ({ servers: [TEAM] }), getClusterEnvSync: () => { throw new Error("fixture 模式不该取集群同步"); }, fixtureMode: true });
  await assert.rejects(fixture.sync({ confirm: true }), { status: 409, code: "fixture" });
  assert.equal((await fixture.getView()).cluster, null);
  await assert.rejects(setup(t, { servers: [] }).service.sync({}), { status: 409, code: "ineligible" });
});

test("getUsage：近 24 小时流量最多的目标；没有记录时是空表", async (t) => {
  const { service, state } = setup(t);
  assert.deepEqual(service.getUsage(), { windowHours: 24, since: null, updatedAt: null, recording: true, totals: { connections: 0, up: 0, down: 0 }, recent: null, targets: [], other: null });
  state.usage = usageWith({ "api.openai.com:443": [5, 100, 900, NOW - 10, 3, 2, 0, 0], "chatgpt.com:443": [2, 10, 20, NOW - 20, 0, 4, 1, 0], "*": [1, 1, 1, NOW - 5, 0, 0, 0, 0] });
  const quiet = { recentConnections: 0, recentUp: 0, recentDown: 0 };
  assert.deepEqual(service.getUsage(), {
    windowHours: 24,
    since: 500 * USAGE_HOUR_MS,
    updatedAt: NOW - 2000,
    recording: true,
    totals: { connections: 8, up: 111, down: 921 },
    recent: null,
    targets: [
      { target: "api.openai.com:443", connections: 5, up: 100, down: 900, lastAt: NOW - 10, ...quiet },
      { target: "chatgpt.com:443", connections: 2, up: 10, down: 20, lastAt: NOW - 20, ...quiet },
    ],
    other: { targets: 0, connections: 1, up: 1, down: 1, lastAt: NOW - 5, ...quiet },
  });
  // 具名目标超过 12 个时，targets 仍保留前 12 个，同时附带 allTargets / allOther 供去向分组完整归类
  const many = {};
  for (let i = 1; i <= 14; i += 1) many[`cdn-${i}.example.com:443`] = [1, 1000 * (20 - i), 9000 * (20 - i), NOW - i, 1, 0, 0, 0];
  many["api.openai.com:443"] = [50, 100, 200, NOW - 1, 50, 0, 0, 0];
  state.usage = usageWith(many);
  const overflow = service.getUsage();
  assert.equal(overflow.targets.length, 12);
  assert.equal(overflow.other.targets, 3);
  assert.equal(overflow.allTargets.length, 15);
  assert.equal(overflow.allOther, null);
  assert.equal(overflow.allTargets.at(-1).target, "api.openai.com:443");
});

test("getUsage：recording 恒为 true（v2.88 起与口令模式无关）；recent 是这个进程见过的相邻两版之差，空闲 150 秒后为 null", async (t) => {
  const { service, state, clock } = setup(t);
  await service.setMode({ mode: "observe" });
  const at = (writtenAt, targets) => ({ ...usageWith(targets), writtenAt });
  state.usage = at(NOW - 2000, { "api.openai.com:443": [5, 100, 900, NOW - 10, 5, 0, 0, 0], "*": [1, 1, 1, NOW - 5, 0, 0, 0, 0] });
  let usage = service.getUsage();
  assert.equal(usage.recording, true);
  assert.equal(usage.recent, null, "只见过一版");
  // 代理一分钟后重写：增量只算这一分钟的。
  clock.now = NOW + 58_000;
  state.usage = at(NOW + 58_000, { "api.openai.com:443": [6, 150, 2900, NOW + 57_000, 6, 0, 0, 0], "chatgpt.com:443": [1, 5, 5, NOW + 50_000, 1, 0, 0, 0], "*": [1, 1, 1, NOW - 5, 0, 0, 0, 0] });
  usage = service.getUsage();
  assert.deepEqual(usage.recent, { fromAt: NOW - 2000, toAt: NOW + 58_000, connections: 2, up: 55, down: 2005 });
  assert.deepEqual(usage.targets.map(({ target, recentConnections, recentUp, recentDown }) => [target, recentConnections, recentUp, recentDown]), [
    ["api.openai.com:443", 1, 50, 2000],
    ["chatgpt.com:443", 1, 5, 5],
  ]);
  assert.deepEqual([usage.other.recentConnections, usage.other.recentUp, usage.other.recentDown], [0, 0, 0]);
  // 20 秒后轮询读到同一版：增量不变。
  clock.now += 20_000;
  assert.deepEqual(service.getUsage().recent, usage.recent);
  // 之后再没重写（没有变化）：超过 150 秒按空闲。
  clock.now = NOW + 58_000 + 150_001;
  usage = service.getUsage();
  assert.equal(usage.recent, null);
  assert.equal(usage.targets[0].recentUp, 0);
  await service.setMode({ mode: "off" });
  assert.equal(service.getUsage().recording, true);
});

test("sampleUsage：控制面自己定时看一眼文件（修改时刻没变就不读），相邻两版才真的相邻", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "proxy-auth-sample-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reads = [];
  let mtimeMs = 1;
  let usage = null;
  const service = createProxyAuthService({
    store: createProxyAuthStore({ filePath: path.join(dir, "proxy-auth.json"), now: () => NOW }),
    usagePath: "/runtime/proxy-usage.json",
    readUsage: () => { reads.push(usage?.writtenAt); return usage; },
    statUsage: () => ({ mtimeMs }),
    getConfig: async () => ({ servers: [] }),
    now: () => NOW + 61_000,
  });
  usage = { ...usageWith({ "api.openai.com:443": [1, 10, 10, NOW - 10, 1, 0, 0, 0] }), writtenAt: NOW - 60_000 };
  service.sampleUsage();
  service.sampleUsage(); // 修改时刻没变：不读
  assert.equal(reads.length, 1);
  mtimeMs = 2;
  usage = { ...usageWith({ "api.openai.com:443": [2, 30, 40, NOW, 2, 0, 0, 0] }), writtenAt: NOW };
  service.sampleUsage();
  assert.equal(reads.length, 2);
  // 前端很久之后才来拉：拿到的仍是相邻两版之差
  assert.deepEqual(service.getUsage().recent, { fromAt: NOW - 60_000, toAt: NOW, connections: 1, up: 20, down: 30 });
});

test("关着的时候即使文件里留着口令，也不对外带（关 = 一切照旧）", async (t) => {
  const { service } = setup(t);
  await service.setMode({ mode: "observe" });
  await service.setMode({ mode: "off" });
  assert.equal(service.getCredential(), null);
  assert.equal(service.localAuthorization(), "");
  assert.equal(service.curlInput(), null);
  assert.equal((await service.getView()).hasToken, true);
});
