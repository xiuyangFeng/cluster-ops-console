// connection-target 行为测试（T01，验收 A01–A05）。纯函数、无 IO、无真实集群。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assertSameContext,
  buildProxyEnvCommand,
  canScopedRestart,
  formatConnectionTargetLine,
  LOCAL_SHELLS,
  normalizePortValue,
  PROXY_ENV_VAR_NAMES,
  REASON_CODE,
  resolveConnectionTarget,
  resolveCurrentTarget,
} from "./connection-target.js";
import { buildRuntimeSnapshot, buildThreeServerConfig } from "../../../lib/m1-fixtures.mjs";
import { buildConnectionTargetsProjection } from "../../../lib/runtime-snapshot.mjs";

function statusWithSnapshot({ stale } = {}) {
  const config = buildThreeServerConfig();
  const snapshot = buildRuntimeSnapshot();
  const connectionTargets = buildConnectionTargetsProjection({
    snapshot,
    snapshotState: stale ? "stale" : "ok",
    config,
  });
  return { status: { activeServerId: config.activeServerId, connectionTargets }, config };
}

// ---- A04 端口校验 ----

test("A04: 端口校验接受整数与规范十进制字符串，拒绝对象/浮点/空串/越界", () => {
  assert.deepEqual(normalizePortValue(8888), { ok: true, port: 8888 });
  assert.deepEqual(normalizePortValue("8888"), { ok: true, port: 8888 });
  assert.deepEqual(normalizePortValue(" 8888 "), { ok: true, port: 8888 }, "首尾空白不影响规范数字串");
  assert.deepEqual(normalizePortValue(1), { ok: true, port: 1 });
  assert.deepEqual(normalizePortValue(65535), { ok: true, port: 65535 });
  // 拒绝面：
  for (const bad of [0, 65536, -1, 8888.5, NaN, Infinity, "", "12a", "0x10", "+8888", {}, null, undefined, true, [8888]]) {
    assert.equal(normalizePortValue(bad).ok, false, `必须拒绝 ${JSON.stringify(String(bad))}`);
  }
  // 关键回归：探针结论对象绝不能被当作端口（A01 [object Object] 根因）。
  assert.equal(normalizePortValue({ ok: true, code: 0, output: "open" }).ok, false);
});

// ---- A01/A02: 三服务器自定义反向端口 + 共享本地代理端口 ----

test("A01/A02: 快照模式下三台服务器逐台解析，远端口各不相同，本机一律用运行共享端口", () => {
  const { status, config } = statusWithSnapshot();
  for (const serverId of ["fixture-a", "fixture-b"]) {
    const resolved = resolveConnectionTarget({ status, config, serverId });
    assert.equal(resolved.ok, true, `${serverId} 应可解析`);
    assert.equal(resolved.reasonCode, REASON_CODE.OK);
    assert.equal(resolved.source, "supervisor-snapshot");
    assert.equal(resolved.target.remotePort.value, serverId === "fixture-a" ? 17891 : 17892);
    assert.equal(resolved.target.remotePort.source, "runtime");
    assert.equal(resolved.target.localPort.value, 28888, "本机端口必须是运行事实 28888");
    assert.equal(resolved.target.localPort.source, "runtime");
    // 配置差异保留在 configured 字段，不被运行值覆盖（A02 的"差异有标签"）。
    assert.equal(resolved.target.localPort.configured, serverId === "fixture-a" ? 28801 : 28802);
  }
});

test("A01: 配置端口不同不得覆盖实际共享端口（local 命令始终使用运行端口）", () => {
  const { status, config } = statusWithSnapshot();
  const resolved = resolveConnectionTarget({ status, config, serverId: "fixture-b" });
  const local = buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "bash" });
  assert.ok(local.ok);
  assert.ok(local.command.includes("http://127.0.0.1:28888"), local.command);
  assert.ok(!local.command.includes("28802"), "configured localPort 不得混进运行命令");
  const remote = buildProxyEnvCommand({ target: resolved.target, scope: "remote" });
  assert.ok(remote.command.includes("http://127.0.0.1:17892"));
  assert.ok(!/\[object Object\]/.test(local.command + remote.command));
});

test("A01: 变量集合行为锁定（ALL_PROXY/HTTP_PROXY/HTTPS_PROXY + 小写兼容），不写 NO_PROXY", () => {
  const { status, config } = statusWithSnapshot();
  const resolved = resolveConnectionTarget({ status, config, serverId: "fixture-a" });
  const cmd = buildProxyEnvCommand({ target: resolved.target, scope: "remote" }).command;
  for (const name of PROXY_ENV_VAR_NAMES) {
    assert.ok(cmd.includes(`export ${name}=http://127.0.0.1:17891`), `${name} 必须存在`);
  }
  assert.ok(!cmd.includes("NO_PROXY"), "不得无提示覆盖用户已有 NO_PROXY");
});

// ---- A03: 旧 supervisor / 无快照 / 快照过期 / 归属失败 ----

test("A03: 无 connectionTargets（旧后端）→ config-only：远端可用且标配置值，本机禁用", () => {
  const config = buildThreeServerConfig();
  const resolved = resolveConnectionTarget({ status: { activeServerId: "fixture-a" }, config, serverId: "fixture-a" });
  assert.equal(resolved.source, "config-only");
  assert.equal(resolved.reasonCode, REASON_CODE.OK_CONFIG_ONLY);
  assert.equal(resolved.target.remotePort.value, 17891);
  assert.equal(resolved.target.remotePort.source, "config");
  assert.equal(resolved.target.localPort.value, null, "运行端口不得假装已确认");
  const local = buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "bash" });
  assert.equal(local.ok, false);
  assert.equal(local.reasonCode, REASON_CODE.ERR_LOCAL_PORT_UNCONFIRMED);
  const remote = buildProxyEnvCommand({ target: resolved.target, scope: "remote" });
  assert.ok(remote.ok, "远端配置命令保留（标注配置值）");
  assert.equal(remote.sourceLabel, "配置值");
});

test("A03: 快照过期（stale）→ 连接目标 freshness=stale，运行端口不再作为已确认事实", () => {
  const config = buildThreeServerConfig();
  const connectionTargets = buildConnectionTargetsProjection({ snapshot: null, snapshotState: "missing", config });
  // monitor 侧对 stale/归属失败传 null（不把旧快照当运行事实）→ 投影 config-only。
  const resolved = resolveConnectionTarget({ status: { activeServerId: "fixture-a", connectionTargets }, config, serverId: "fixture-a" });
  assert.equal(resolved.source, "config-only");
  assert.equal(resolved.target.localPort.value, null);
  assert.equal(resolved.freshness, "unknown");
});

test("A03: tunnel:false 服务器 → 配置示例可复制，但永不描述为当前可用连接", () => {
  const { status, config } = statusWithSnapshot();
  const resolved = resolveConnectionTarget({ status, config, serverId: "fixture-c" });
  assert.equal(resolved.reasonCode, REASON_CODE.OK_TUNNEL_DISABLED);
  assert.equal(resolved.target.tunnelEnabled, false);
  const remote = buildProxyEnvCommand({ target: resolved.target, scope: "remote" });
  assert.ok(remote.ok, "配置示例允许复制");
  const local = buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "bash" });
  assert.equal(local.ok, false);
  assert.equal(local.reasonCode, REASON_CODE.OK_TUNNEL_DISABLED);
});

// ---- A05: 面板打开后切服，复制拒绝 ----

test("A05: 执行时选择已变化 → assertSameContext 拒绝并给 reasonCode", () => {
  const { status, config } = statusWithSnapshot();
  const resolvedForA = resolveConnectionTarget({ status, config, serverId: "fixture-a" });
  const mismatch = assertSameContext(resolvedForA, "fixture-b");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reasonCode, REASON_CODE.ERR_CONTEXT_CHANGED);
  const match = assertSameContext(resolvedForA, "fixture-a");
  assert.equal(match.ok, true);
});

test("A05: 未知 serverId / 未选择 → 明确拒绝，不回落到任何默认端口", () => {
  const { status, config } = statusWithSnapshot();
  const unknown = resolveConnectionTarget({ status, config, serverId: "ghost-server" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reasonCode, REASON_CODE.ERR_NO_SERVER);
  const none = resolveConnectionTarget({ status, config, serverId: "" });
  assert.equal(none.reasonCode, REASON_CODE.ERR_NO_TARGET_SELECTED);
});

test("A05: resolveCurrentTarget 按此刻的查看选择复核——切换过服务器即拒绝，未切换放行", () => {
  const { status, config } = statusWithSnapshot();
  const same = resolveCurrentTarget({ status, config, expectedServerId: status.activeServerId });
  assert.equal(same.ok, true);
  assert.equal(same.target.serverId, status.activeServerId);
  // 发起时记下的是 fixture-b，此刻查看的仍是 activeServerId → 必须拒绝（旧写法按记下的 id
  // 解析永远"一致"，拦不住切换）。
  const switched = resolveCurrentTarget({ status, config, expectedServerId: "fixture-b" });
  assert.equal(switched.ok, false);
  assert.equal(switched.reasonCode, REASON_CODE.ERR_CONTEXT_CHANGED);
  assert.equal(switched.target, null);
  // 状态未到：回落配置里的选择。
  const configOnly = resolveCurrentTarget({ status: null, config, expectedServerId: config.activeServerId });
  assert.equal(configOnly.ok, true);
  // 什么都没有：拒绝而不是抛错。
  assert.equal(resolveCurrentTarget({ expectedServerId: "fixture-a" }).ok, false);
  assert.equal(resolveCurrentTarget().ok, false);
});

test("T04b: canScopedRestart 只认运行快照声明的能力（scopedTunnelRestart && controlProtocol>=1）", () => {
  const { status, config } = statusWithSnapshot();
  assert.equal(canScopedRestart(status), true, "fixture 快照声明了能力");
  const withCaps = (caps, source = "supervisor-snapshot") => ({ connectionTargets: { ...status.connectionTargets, source, capabilities: caps } });
  assert.equal(canScopedRestart(withCaps({ scopedTunnelRestart: true, controlProtocol: 0 })), false, "旧控制协议");
  assert.equal(canScopedRestart(withCaps({ scopedTunnelRestart: false, controlProtocol: 1 })), false, "未声明能力");
  assert.equal(canScopedRestart(withCaps({ scopedTunnelRestart: "true", controlProtocol: 1 })), false, "只认布尔 true");
  assert.equal(canScopedRestart(withCaps({ scopedTunnelRestart: true, controlProtocol: 2 }, "config-only")), false, "config-only 投影不可用");
  const configOnly = buildConnectionTargetsProjection({ snapshot: null, snapshotState: "missing", config });
  assert.equal(canScopedRestart({ connectionTargets: configOnly }), false);
  for (const bad of [null, undefined, {}, { connectionTargets: null }]) assert.equal(canScopedRestart(bad), false);
});

// ---- shell 支持面 ----

test("M1 shell 支持面：bash/zsh 可用；PowerShell/cmd 未实现不返回命令", () => {
  assert.deepEqual([...LOCAL_SHELLS], ["bash", "zsh"]);
  const { status, config } = statusWithSnapshot();
  const resolved = resolveConnectionTarget({ status, config, serverId: "fixture-a" });
  assert.equal(buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "powershell" }).ok, false);
  assert.equal(buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "cmd" }).ok, false);
  assert.ok(buildProxyEnvCommand({ target: resolved.target, scope: "local", shell: "zsh" }).ok);
});

test("预览行：包含服务器名、方向、端口与数据来源", () => {
  const { status, config } = statusWithSnapshot();
  const resolved = resolveConnectionTarget({ status, config, serverId: "fixture-a" });
  assert.equal(
    formatConnectionTargetLine({ target: resolved.target, scope: "remote", serverName: "Fixture A" }),
    "Fixture A · 远端 :17891 · 运行值",
  );
  assert.equal(
    formatConnectionTargetLine({ target: resolved.target, scope: "local", serverName: "Fixture A" }),
    "Fixture A · 本机 :28888 · 运行值",
  );
});
