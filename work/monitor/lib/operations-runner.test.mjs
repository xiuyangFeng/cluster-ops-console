// operations-runner 状态机测试（T04b，验收 A19/A20）。临时目录 + 假时钟，无真实进程。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOperationsRunner, buildTargetSignature } from "./operations-runner.mjs";
import { buildControlRequest, createControlMailbox, CONTROL_ACTION_RESTART_TUNNEL } from "./supervisor-control.mjs";
import { buildThreeServerConfig } from "./m1-fixtures.mjs";

const INSTANCE = "abcdef1234567890";
const SIGNATURE = "-R 127.0.0.1:17891:127.0.0.1:28888 fixture-a.invalid";

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "m1-ops-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function snapshotNow() {
  return {
    schemaVersion: 1,
    instanceId: INSTANCE,
    pid: 12345,
    startedAt: 1,
    observedAt: 2,
    configRevision: "rev-1",
    build: {},
    capabilities: { scopedTunnelRestart: true, controlProtocol: 1 },
    effectiveProxyPort: 28888,
    targets: { "fixture-a": { host: "fixture-a.invalid", remotePort: 17891, localPort: 28888, signature: SIGNATURE } },
    stale: false,
  };
}

function makeRunner(dir, overrides = {}) {
  const base = {
    runtimeDir: dir,
    getConfig: async () => buildThreeServerConfig(),
    getSnapshot: () => snapshotNow(),
    now: () => 1000,
    log: () => {},
    timeline: () => {},
    ...overrides,
  };
  return createOperationsRunner(base);
}

test("签名一致性: buildTargetSignature 与 channel-supervisor.buildTunnelSignature 同形", async () => {
  const { buildTunnelSignature } = await import("./supervisor/tunnel-spec.mjs");
  assert.equal(
    buildTargetSignature({ host: "fixture-a.invalid", remotePort: 17891, localPort: 28888 }),
    buildTunnelSignature({ host: "fixture-a.invalid", remotePort: 17891, localPort: 28888 }),
    "monitor 与 supervisor 两侧必须用同一个签名格式",
  );
});

test("能力降级: 无快照 / 能力未声明 → 503，不为旧 supervisor 假装能力", async () => {
  await withTempDir(async (dir) => {
    const runner = makeRunner(dir, { getSnapshot: () => null });
    await assert.rejects(
      () => runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } }),
      (err) => err.status === 503,
    );
    const oldCaps = makeRunner(dir, {
      getSnapshot: () => ({ ...snapshotNow(), capabilities: { scopedTunnelRestart: false, controlProtocol: 0 } }),
    });
    await assert.rejects(
      () => oldCaps.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } }),
      (err) => err.status === 503 && /不支持单隧道操作/.test(err.message),
    );
  });
});

test("A19: 重复 run / 预览单次消费 / 在飞互斥 → 不产生第二次重启", async () => {
  await withTempDir(async (dir) => {
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      now: () => 2000,
      handlers: { [CONTROL_ACTION_RESTART_TUNNEL]: async () => ({ status: "succeeded", phase: "verified", evidence: { pid: 1 } }) },
    });
    const runner = makeRunner(dir);
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    // 影响范围由后端计算。
    assert.deepEqual(preview.impact.serverIds, ["fixture-a"]);
    assert.equal(preview.impact.otherServersAffected, false);
    assert.equal(preview.impact.sharedProxyRestarted, false);

    // 1) 正常 run 消费预览，等终态（mutex 释放）。
    const run1 = await runner.run({ previewId: preview.previewId, operationId: "aaaaaaaa-0000-4000-8000-000000000001" });
    assert.equal(run1.state, "queued");
    await mailbox.poll();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    assert.equal((await runner.getOperation(run1.operationId)).state, "succeeded");
    // 2) 同一 previewId 再 run → 404（单次消费，不产生第二次重启）。
    await assert.rejects(
      () => runner.run({ previewId: preview.previewId, operationId: "aaaaaaaa-0000-4000-8000-000000000002" }),
      (err) => err.status === 404,
    );
    // 3) 在飞时再 run → 409 互斥（第二个操作尚未拿到终态前被拒绝）。
    const p2 = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-b" } });
    await runner.run({ previewId: p2.previewId, operationId: "aaaaaaaa-0000-4000-8000-000000000003" });
    const p3 = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    await assert.rejects(
      () => runner.run({ previewId: p3.previewId, operationId: "aaaaaaaa-0000-4000-8000-000000000004" }),
      (err) => err.status === 409,
    );
    // 收尾清理：让第二个操作到终态，避免泄漏计时器。
    await mailbox.poll();
    await new Promise((resolve) => setTimeout(resolve, 1600));
  });
});

test("A19: 预览过期 → 410；目标签名变化 → 409 且旧预览不改指新目标", async () => {
  await withTempDir(async (dir) => {
    let clock = 1000;
    const runner = makeRunner(dir, { now: () => clock });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    clock += 121_000; // 超过 120s TTL
    await assert.rejects(
      () => runner.run({ previewId: preview.previewId }),
      (err) => err.status === 410,
    );

    // 目标变化（配置里 fixture-a 的 remotePort 改了）：同一 runner、run 时重新核对
    // 签名 → 409，旧预览不会改指新目标。
    let config = buildThreeServerConfig();
    const runner2 = createOperationsRunner({
      runtimeDir: dir,
      getConfig: async () => config,
      getSnapshot: () => snapshotNow(),
      now: () => 1000,
      log: () => {},
      timeline: () => {},
    });
    const preview2 = await runner2.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    config = buildThreeServerConfig();
    config.servers[0] = { ...config.servers[0], remotePort: 19999 };
    await assert.rejects(
      () => runner2.run({ previewId: preview2.previewId, operationId: "aaaaaaaa-0000-4000-8000-00000000000a" }),
      (err) => err.status === 409 && /目标配置已变化/.test(err.message),
    );
  });
});

test("预览表有界: 超上限按插入序淘汰最旧的，过期条目先被清掉", async () => {
  await withTempDir(async (dir) => {
    let clock = 1000;
    const runner = makeRunner(dir, { now: () => clock, maxPreviews: 2 });
    const open = () => runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    const first = await open();
    const second = await open();
    await open(); // 插入第三条前挤掉最旧的 first
    const gone = (err) => err.status === 404;
    await assert.rejects(() => runner.run({ previewId: first.previewId }), gone);
    clock += 121_000; // second 已过期：下一次预览先清过期，run 得到 404 而不是 410
    await open();
    await assert.rejects(() => runner.run({ previewId: second.previewId }), gone);
  });
});

test("互斥: 通道忙 → 409，不发请求", async () => {
  await withTempDir(async (dir) => {
    const runner = makeRunner(dir, { isChannelBusy: () => true });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    await assert.rejects(
      () => runner.run({ previewId: preview.previewId }),
      (err) => err.status === 409 && /通道修复进行中/.test(err.message),
    );
  });
});

test("tunnel:false 服务器拒绝重启；未知服务器 404", async () => {
  await withTempDir(async (dir) => {
    const runner = makeRunner(dir);
    await assert.rejects(
      () => runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-c" } }),
      (err) => err.status === 400 && /tunnel:false/.test(err.message),
    );
    await assert.rejects(
      () => runner.preview({ action: "restart-tunnel", target: { serverId: "ghost" } }),
      (err) => err.status === 404,
    );
  });
});

test("A20: 操作终态由结果文件驱动；unknown 不重放；monitor 重启后可按 operationId 查回", async () => {
  await withTempDir(async (dir) => {
    let outcome = { status: "succeeded", phase: "verified", reason: "", evidence: { pid: 4242, remotePortOpen: true, endToEndVerified: false } };
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      now: () => 2000,
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async () => outcome,
      },
    });
    const runner = makeRunner(dir, { now: () => 1000 });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    const opId = "aaaaaaaa-0000-4000-8000-0000000000aa";
    const runResult = await runner.run({ previewId: preview.previewId, operationId: opId });
    assert.equal(runResult.state, "queued");
    // supervisor 认领并处理（真实信箱侧）。
    await mailbox.poll();
    // 轮询等待监视器吸收结果（1s 间隔）。
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const op = await runner.getOperation(opId);
    assert.equal(op.state, "succeeded");
    assert.equal(op.evidence.remotePortOpen, true);
    assert.equal(op.evidence.endToEndVerified, false, "202/结果都不冒充端到端已验证");
    assert.ok(op.note || op.state === "succeeded");

    // unknown 场景：处理中崩溃（无结果文件）→ 查询超时后 unknown，不重放。
    outcome = { status: "unknown", phase: "verifying", reason: "进程已恢复，端到端待验证", evidence: {} };
    const preview2 = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    await runner.run({ previewId: preview2.previewId, operationId: "aaaaaaaa-0000-4000-8000-0000000000bb" });
    await mailbox.poll();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const op2 = await runner.getOperation("aaaaaaaa-0000-4000-8000-0000000000bb");
    assert.equal(op2.state, "unknown");

    // monitor 重启（内存表清空）后：按 operationId 从结果目录找回。
    const freshRunner = makeRunner(dir);
    const recovered = await freshRunner.getOperation(opId);
    assert.ok(recovered, "重启后应能从信箱结果找回已验证结果");
    assert.equal(recovered.state, "succeeded");
    assert.equal(recovered.recoveredAfterRestart, true);
  });
});

test("请求 TTL: 写入信箱的请求 60s 过期（supervisor 侧拒绝过期执行）", async () => {
  await withTempDir(async (dir) => {
    const runner = makeRunner(dir, { now: () => 1000 });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    await runner.run({ previewId: preview.previewId, operationId: "aaaaaaaa-0000-4000-8000-0000000000cc" });
    const requestsDir = path.join(dir, "control", INSTANCE, "requests");
    const { readdir, readFile } = await import("node:fs/promises");
    const names = await readdir(requestsDir);
    const raw = JSON.parse(await readFile(path.join(requestsDir, names[0]), "utf8"));
    assert.equal(raw.expiresAt - raw.createdAt, 60_000);
    const parsed = buildControlRequest(raw); // 形状可被 supervisor 校验
    assert.equal(parsed.action, CONTROL_ACTION_RESTART_TUNNEL);
  });
});

test("受理回调: 写入信箱后以 { operationId, serverId } 回调一次；被拒绝的 run 不回调；回调抛错不影响受理", async () => {
  await withTempDir(async (dir) => {
    const accepted = [];
    const runner = makeRunner(dir, {
      onAccepted: (operation) => {
        accepted.push(operation);
        throw new Error("link exploded");
      },
    });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    const run = await runner.run({ previewId: preview.previewId, operationId: "aaaaaaaa-0000-4000-8000-0000000000dd" });
    assert.equal(run.state, "queued", "关联失败不得让已受理的操作失败");
    assert.deepEqual(accepted, [{ operationId: "aaaaaaaa-0000-4000-8000-0000000000dd", serverId: "fixture-a" }]);
    const p2 = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-b" } });
    await assert.rejects(() => runner.run({ previewId: p2.previewId }), (err) => err.status === 409);
    assert.equal(accepted.length, 1, "被拒绝（在飞互斥）的 run 没有受理，不回调");
  });
});

test("trigger:auto（v2.64 自动修复只重启坏的那条）：日志与时间线带 trigger/ruleId，流程与查询结果形状不变", async () => {
  await withTempDir(async (dir) => {
    const logs = [];
    const timeline = [];
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      now: () => 2000,
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async () => ({ status: "succeeded", phase: "verified", reason: "", evidence: {} }),
      },
    });
    const runner = makeRunner(dir, {
      log: (message, fields) => logs.push({ message, ...fields }),
      timeline: (level, message, fields) => timeline.push({ level, message, ...fields }),
    });
    const preview = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    const opId = "aaaaaaaa-0000-4000-8000-0000000000cc";
    await runner.run({ previewId: preview.previewId, operationId: opId, trigger: "auto", ruleId: "channel-down-restart" });
    await mailbox.poll();
    const op = await runner.getOperation(opId);
    assert.equal(op.state, "succeeded");
    assert.equal("autoTag" in op, false, "查询接口形状不变");
    assert.equal("trigger" in op, false);
    for (const entry of [...logs, ...timeline].filter((e) => e.operationId === opId && e.event === "scoped-operation")) {
      assert.equal(entry.trigger, "auto", entry.message);
      assert.equal(entry.ruleId, "channel-down-restart");
    }
    assert.ok(logs.some((e) => /queued/.test(e.message)) && logs.some((e) => /result=ok/.test(e.message)));

    // 手动发起的照旧不带 trigger。
    const manualId = "aaaaaaaa-0000-4000-8000-0000000000dd";
    const preview2 = await runner.preview({ action: "restart-tunnel", target: { serverId: "fixture-a" } });
    await runner.run({ previewId: preview2.previewId, operationId: manualId });
    assert.equal("trigger" in logs.find((e) => e.operationId === manualId), false);
    await mailbox.poll();
    await runner.getOperation(manualId);
  });
});
