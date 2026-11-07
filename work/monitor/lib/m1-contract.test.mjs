// M1 数据契约冻结测试（T00 交付）。
// 用真实消费者（config-loader / runtime-snapshot / readiness-view / connection-target）
// 校验 fixture 形状，而不是为每个字段复刻实现。契约要点（docs/reviews/2026-09-05/
// implementation/01 §3）：
//   - 新结构都带 schemaVersion: 1；时间字段一律 Unix 毫秒。
//   - freshness 枚举 fresh/stale/unknown；能力 state 枚举 pass/fail/attention/unknown/unsupported。
//   - transport.state 枚举 connected/disconnected/stopped/unknown。
//   - 操作状态枚举 queued/executing/verifying/succeeded/failed/unknown。
//   - 旧字段（health/cpu/remotePort 探针对象）语义保留，不被原地改类型。
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildLegacyMetricSamples,
  buildLegacyRemotePortProbe,
  buildRuntimeSnapshot,
  buildThreeServerConfig,
  FIXTURE_HOSTS,
} from "./m1-fixtures.mjs";
import { resolveTunnelTargets } from "./config-loader.mjs";
import { normalizeAgentConfig } from "../monitor-core.mjs";

test("契约: fixture 配置经真实合并/归一化消费后，三服务器端口映射成立", () => {
  const config = normalizeAgentConfig(buildThreeServerConfig());
  assert.equal(config.servers.length, 3);
  assert.deepEqual(
    config.servers.map((s) => [s.id, s.remotePort, s.localPort]),
    [
      ["fixture-a", 17891, 28801],
      ["fixture-b", 17892, 28802],
      ["fixture-c", 17893, 28803],
    ],
  );
  // 隧道目标：fixture-c 是 tunnel:false，不建隧道。
  const targets = resolveTunnelTargets(config, { warn: () => {} });
  assert.deepEqual(targets.map((t) => t.serverId).sort(), ["fixture-a", "fixture-b"]);
  for (const target of targets) {
    assert.ok(FIXTURE_HOSTS.includes(target.host), `隧道主机必须是 fixture.invalid 形态: ${target.host}`);
  }
});

test("契约: 运行快照 schemaVersion=1、时间均为 Unix 毫秒、capabilities 枚举可校验", () => {
  const snapshot = buildRuntimeSnapshot();
  assert.equal(snapshot.schemaVersion, 1);
  for (const key of ["startedAt", "observedAt"]) {
    assert.ok(Number.isInteger(snapshot[key]) && snapshot[key] > 1e12, `${key} 必须是 Unix 毫秒`);
  }
  assert.equal(typeof snapshot.capabilities.scopedTunnelRestart, "boolean");
  assert.equal(snapshot.capabilities.controlProtocol, 1);
  // 共享代理端口与各服务器 configured localPort 不同（A02 的事实基础）。
  assert.equal(snapshot.effectiveProxyPort, 28888);
  assert.equal(snapshot.targets["fixture-a"].localPort, 28888);
  assert.equal(snapshot.targets["fixture-b"].localPort, 28888);
});

test("契约: 旧字段语义保留——remotePort 探针对象与旧 metrics 样本不被改类型", () => {
  const probe = buildLegacyRemotePortProbe({ open: true });
  assert.equal(typeof probe, "object");
  assert.equal(probe.ok, true);
  assert.equal(typeof probe.output, "string");
  const samples = buildLegacyMetricSamples({ count: 2 });
  for (const sample of samples) {
    // 旧 cpu 是归一化负载（load1/核数），不是 CPU busy%——旧历史不得被重新解释。
    assert.ok(Number.isFinite(sample.cpu) && sample.cpu >= 0 && sample.cpu <= 100);
    assert.equal(sample.kind, "resource");
    assert.equal(sample.cpuBusyPct, undefined, "旧样本不得携带新字段");
  }
});
