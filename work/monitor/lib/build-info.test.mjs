// build-info 版本矩阵测试（T05，验收 A23/A32）。纯函数，无 IO。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assembleBuildInfoPayload,
  computeBuildCompatibility,
  computeDataPlaneView,
  createBundleComponentsResolver,
  freezeBuildInfo,
  parseSourceVersion,
  parseBuildInfo,
  readBundleBuildInfo,
  sanitizeComponents,
} from "./build-info.mjs";
import { buildRuntimeSnapshot as fixtureSnapshot } from "./m1-fixtures.mjs";

test("A23: 磁盘已更新但进程未重启 → restart-monitor", () => {
  const compat = computeBuildCompatibility({
    monitorBuild: { version: "2.19.0", gitCommit: "aaa", builtAt: "d1" },
    bundleBuild: { version: "2.20.0", gitCommit: "bbb", builtAt: "d2" },
    supervisorBuild: { version: "2.19.0", gitCommit: "aaa" },
    supervisorCapabilities: { controlProtocol: 1 },
  });
  assert.ok(compat.reasons.includes("restart-monitor"));
  assert.equal(compat.state, "restart-monitor");
});

test("A23: 前端旧而后端新 → reload-ui 原因；不影响 monitor/supervisor 状态判定", () => {
  const compat = computeBuildCompatibility({
    monitorBuild: { version: "2.20.0", gitCommit: "aaa" },
    bundleBuild: { version: "2.20.0", gitCommit: "aaa" },
    supervisorBuild: { version: "2.20.0", gitCommit: "aaa" },
    supervisorCapabilities: { controlProtocol: 1 },
    clientBuild: "2.19.0",
  });
  assert.deepEqual(compat.reasons, ["reload-ui"]);
  assert.equal(compat.state, "unknown", "reload-ui 是客户端建议，不改写服务端状态枚举");
});

test("A23: 新 monitor 接管旧 supervisor → supervisor-older（构建差 + 协议差两条理由并存）", () => {
  const compat = computeBuildCompatibility({
    monitorBuild: { version: "2.20.0", gitCommit: "new" },
    bundleBuild: { version: "2.20.0", gitCommit: "new" },
    supervisorBuild: { version: "2.19.0", gitCommit: "old" },
    supervisorCapabilities: { controlProtocol: 0 },
  });
  assert.ok(compat.reasons.length >= 2, "构建差异与协议差异都应给出理由");
  assert.ok(compat.reasons.every((r) => r === "supervisor-older"), "理由都指向 supervisor-older");
  assert.equal(compat.state, "supervisor-older");
});

test("A32: 混合组合的诚实降级——缺快照 / 缺构建信息", () => {
  // 无快照（旧 supervisor 未运行或无快照）：supervisor-unknown，状态 unknown。
  const noSupervisor = computeBuildCompatibility({
    monitorBuild: { version: "2.20.0", gitCommit: "new" },
    bundleBuild: { version: "2.20.0", gitCommit: "new" },
    supervisorBuild: null,
  });
  assert.deepEqual(noSupervisor.reasons, ["supervisor-unknown"]);
  assert.equal(noSupervisor.state, "unknown");
  // 源代码开发模式：全部无构建信息 → versions-unknown（正常状态）。
  const devMode = computeBuildCompatibility({
    monitorBuild: { version: "", gitCommit: "" },
    bundleBuild: { version: "", gitCommit: "" },
    supervisorBuild: null,
  });
  assert.ok(devMode.reasons.includes("versions-unknown"));
  // 对齐：一切一致。
  const aligned = computeBuildCompatibility({
    monitorBuild: { version: "2.20.0", gitCommit: "same" },
    bundleBuild: { version: "2.20.0", gitCommit: "same" },
    supervisorBuild: { version: "2.20.0", gitCommit: "same" },
    supervisorCapabilities: { controlProtocol: 1 },
  });
  assert.deepEqual(aligned.reasons, []);
  assert.equal(aligned.state, "aligned");
});

test("assemble: 快照不可用 → supervisorRunning=null，不用磁盘版本顶替", () => {
  const payload = assembleBuildInfoPayload({
    monitorBuild: { version: "2.20.0", gitCommit: "c", builtAt: "t", mode: "packaged" },
    startedAt: 1000,
    bundleBuild: { version: "2.20.0", gitCommit: "c", builtAt: "t" },
    supervisorSnapshot: null,
  });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.monitorRunning.mode, "packaged");
  assert.equal(payload.monitorRunning.startedAt, 1000);
  assert.equal(payload.supervisorRunning, null);
  assert.ok(payload.bundleOnDisk.version);
  assert.equal(payload.compatibility.reasons.includes("supervisor-unknown"), true);
});

test("assemble: 客户端自报 clientBuild 仅用于本次响应比较", () => {
  const payload = assembleBuildInfoPayload({
    monitorBuild: { version: "2.20.0", gitCommit: "c", mode: "source" },
    startedAt: 1,
    bundleBuild: { version: "2.21.0", gitCommit: "" },
    supervisorSnapshot: null,
    clientBuild: "x".repeat(500).slice(0, 128),
  });
  assert.ok(JSON.stringify(payload).length < 4096);
  assert.equal(payload.monitorRunning.mode, "source");
});

test("parseBuildInfo：容错解析，非字符串字段置空", () => {
  assert.deepEqual(parseBuildInfo('{"version":"2.26.0","gitCommit":"abc","builtAt":"t"}'), { version: "2.26.0", gitCommit: "abc", builtAt: "t" });
  assert.deepEqual(parseBuildInfo({ version: 3, gitCommit: "x" }), { version: "", gitCommit: "x", builtAt: "" });
  assert.equal(parseBuildInfo("not json"), null);
  assert.equal(parseBuildInfo(null), null);
  assert.equal(parseBuildInfo(`{"version":"${"v".repeat(500)}"}`).version.length, 128);
});

test("freeze/read: 文件缺失 → source 模式（正常），读取失败 → unknown", async () => {
  const missing = await freezeBuildInfo("/nonexistent-root", { readFileImpl: async () => { throw new Error("ENOENT"); } });
  assert.equal(missing.mode, "source");
  assert.equal(missing.version, "");
  const noBundle = await readBundleBuildInfo("/nonexistent-root", { readFileImpl: async () => { throw new Error("ENOENT"); } });
  assert.equal(noBundle.version, "");
  assert.equal(noBundle.gitCommit, "");
  const frozen = await freezeBuildInfo("/fake", {
    readFileImpl: async () => JSON.stringify({ version: "2.20.0", gitCommit: "c", builtAt: "t", evil: "x".repeat(500) }),
  });
  assert.equal(frozen.mode, "packaged");
  assert.equal(frozen.version, "2.20.0");
  assert.equal(frozen.evil, undefined, "多余字段不得透传");
});

// v2.59：源码安装没有 build-info.json，版本取 app 根的 package.json（只取版本号，不取提交号）。
test("源码运行：版本取 package.json；之后磁盘上的版本号变了 → restart-monitor", async () => {
  const filesOf = (version) => async (file) => {
    if (file.endsWith("package.json")) return JSON.stringify({ name: "x", version });
    throw new Error("ENOENT");
  };
  const frozen = await freezeBuildInfo("/src", { readFileImpl: filesOf("2.58.1") });
  assert.deepEqual(frozen, { version: "2.58.1", gitCommit: "", builtAt: "", mode: "source" });
  const same = await readBundleBuildInfo("/src", { readFileImpl: filesOf("2.58.1") });
  assert.deepEqual(same, { version: "2.58.1", gitCommit: "", builtAt: "" });
  assert.deepEqual(computeBuildCompatibility({ monitorBuild: frozen, bundleBuild: same, supervisorBuild: { version: "2.58.1", gitCommit: "" }, supervisorCapabilities: { controlProtocol: 1 } }), { state: "aligned", reasons: [] });
  const pulled = await readBundleBuildInfo("/src", { readFileImpl: filesOf("2.59.0") });
  assert.ok(computeBuildCompatibility({ monitorBuild: frozen, bundleBuild: pulled }).reasons.includes("restart-monitor"));
  // 坏的 package.json / 奇怪的版本串 → 空（按未知处理，不当成更新）。
  assert.equal((await freezeBuildInfo("/src", { readFileImpl: filesOf("not a version; rm -rf") })).version, "");
  assert.equal(parseSourceVersion("{broken"), "");
  assert.equal(parseSourceVersion('{"version":"2.59.0-rc.1"}'), "2.59.0-rc.1");
  // 有 build-info.json 的打包安装不受影响：不去读 package.json。
  const packaged = await readBundleBuildInfo("/app", { readFileImpl: async (file) => (file.endsWith("build-info.json") ? JSON.stringify({ version: "", gitCommit: "", builtAt: "" }) : JSON.stringify({ version: "9.9.9" })) });
  assert.equal(packaged.version, "", "build-info.json 在但没有版本：如实报未知，不拿 package.json 顶替");
});

// ---- 热更新：数据面组件指纹（dataPlane）----

test("build-info.json 的 components 被净化保留；非法值按未知处理", async () => {
  const bundle = await readBundleBuildInfo("/fake", {
    readFileImpl: async () => JSON.stringify({
      version: "2.26.0", gitCommit: "c", builtAt: "t",
      components: { supervisor: "0123456789ab", proxy: "../../etc", extra: "ffffffffffff" },
    }),
  });
  assert.deepEqual(bundle.components, { supervisor: "0123456789ab", proxy: "" });
  assert.deepEqual(sanitizeComponents(null), null);
});

test("assemble: dataPlane 对照运行快照与磁盘新包，列出待交接组件；原有字段不变", () => {
  const snapshot = {
    ...fixtureSnapshot({ build: { version: "2.25.0", gitCommit: "aaa" } }),
    components: { supervisor: "111111111111", proxy: "222222222222" },
    capabilities: { scopedTunnelRestart: true, controlProtocol: 1, handoffExit: true, proxyHandoff: true },
    proxyPid: 4242,
  };
  const payload = assembleBuildInfoPayload({
    monitorBuild: { version: "2.25.0", gitCommit: "aaa", builtAt: "", mode: "packaged" },
    startedAt: 1,
    bundleBuild: { version: "2.26.0", gitCommit: "bbb", builtAt: "" },
    supervisorSnapshot: snapshot,
    bundleComponents: { supervisor: "333333333333", proxy: "222222222222" },
  });
  assert.ok(payload.monitorRunning && payload.bundleOnDisk && payload.compatibility, "既有字段保留");
  assert.deepEqual(payload.dataPlane.running, { supervisor: "111111111111", proxy: "222222222222" });
  assert.deepEqual(payload.dataPlane.bundle, { supervisor: "333333333333", proxy: "222222222222" });
  assert.deepEqual(payload.dataPlane.pending, ["supervisor"]);
  assert.equal(payload.dataPlane.handoffSupported, true);
  assert.equal(payload.dataPlane.proxyPid, 4242);
});

test("dataPlane: 快照不可用/旧 supervisor 无指纹 → 运行值未知 → 两个组件都待交接", () => {
  const none = computeDataPlaneView({ supervisorSnapshot: null, bundleComponents: { supervisor: "a1", proxy: "b2" } });
  assert.deepEqual(none.pending, ["supervisor", "proxy"]);
  assert.equal(none.handoffSupported, false);
  const legacy = computeDataPlaneView({ supervisorSnapshot: { capabilities: { controlProtocol: 1 } }, bundleComponents: { supervisor: "a1", proxy: "b2" } });
  assert.deepEqual(legacy.running, { supervisor: "", proxy: "" });
  assert.deepEqual(legacy.pending, ["supervisor", "proxy"]);
  const stale = computeDataPlaneView({ supervisorSnapshot: { stale: true, components: { supervisor: "a1", proxy: "b2" } }, bundleComponents: { supervisor: "a1", proxy: "b2" } });
  assert.deepEqual(stale.pending, ["supervisor", "proxy"]);
});

test("bundle 指纹：build-info.json 有 components 用它；否则（源代码模式）现场计算并按 TTL 缓存", async () => {
  let computed = 0;
  let clock = 0;
  const resolve = createBundleComponentsResolver({
    appRoot: "/repo",
    compute: async (root) => {
      computed += 1;
      assert.equal(root, "/repo");
      return { supervisor: "aaaaaaaaaaaa", proxy: "bbbbbbbbbbbb" };
    },
    now: () => clock,
    ttlMs: 1000,
  });
  const fromFile = await resolve({ components: { supervisor: "111111111111", proxy: "222222222222" } });
  assert.deepEqual(fromFile, { supervisor: "111111111111", proxy: "222222222222", source: "build-info" });
  assert.equal(computed, 0);
  assert.equal((await resolve({ version: "" })).source, "computed");
  await resolve({});
  assert.equal(computed, 1, "TTL 内复用");
  clock += 2000;
  await resolve({});
  assert.equal(computed, 2);
});

test("dataPlane: snapshotAvailable / channelRunning 区分未知与真有旧代码；旧代理（无指纹）不支持代理交接", () => {
  const caps = { controlProtocol: 1, handoffExit: true, proxyHandoff: true };
  const none = computeDataPlaneView({ supervisorSnapshot: null, bundleComponents: { supervisor: "a1", proxy: "b2" }, channelRunning: false });
  assert.equal(none.snapshotAvailable, false);
  assert.equal(none.channelRunning, false);
  const stale = computeDataPlaneView({ supervisorSnapshot: { stale: true, capabilities: caps, components: { supervisor: "a1", proxy: "b2" } } });
  assert.equal(stale.snapshotAvailable, false);
  assert.equal(stale.proxyHandoffSupported, false);
  assert.equal("channelRunning" in stale, false, "未传入时不臆造");
  const oldProxy = computeDataPlaneView({ supervisorSnapshot: { capabilities: caps, components: { supervisor: "a1", proxy: "" } }, bundleComponents: { supervisor: "a1", proxy: "b2" }, channelRunning: true });
  assert.equal(oldProxy.snapshotAvailable, true);
  assert.equal(oldProxy.handoffSupported, true);
  assert.equal(oldProxy.proxyHandoffSupported, false);
  assert.deepEqual(oldProxy.pending, ["proxy"]);
  const fresh = computeDataPlaneView({ supervisorSnapshot: { capabilities: caps, components: { supervisor: "a1", proxy: "b1" } }, bundleComponents: { supervisor: "a1", proxy: "b2" } });
  assert.equal(fresh.proxyHandoffSupported, true);
});
