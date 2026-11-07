// supervisor-control 信箱协议测试（T04b，验收 A19/A20/A22 的协议层）。
// 全部使用临时目录，无真实集群、无真实进程操作。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONTROL_ACTION_RESTART_TUNNEL,
  CONTROL_MAX_PENDING_REQUESTS,
  CONTROL_PROCESSING_STALE_MS,
  ControlProtocolError,
  buildControlRequest,
  createControlMailbox,
  findControlResultByOperationId,
  readControlResult,
  validateControlRequest,
  writeControlRequest,
} from "./supervisor-control.mjs";

import { StatusError } from "./status-error.mjs";

const INSTANCE = "abcdef1234567890";

test("ControlProtocolError: 继承 StatusError，保留 (status, message) 签名与类名", () => {
  const err = new ControlProtocolError(503, "mailbox full");
  assert.ok(err instanceof ControlProtocolError);
  assert.ok(err instanceof StatusError);
  assert.equal(err.name, "ControlProtocolError");
  assert.equal(err.status, 503);
  assert.equal(err.message, "mailbox full");
});

async function withTempDir(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "m1-mailbox-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeRequest(overrides = {}) {
  return buildControlRequest({
    requestId: "11111111-1111-4111-8111-111111111111",
    operationId: "22222222-2222-4222-8222-222222222222",
    instanceId: INSTANCE,
    action: CONTROL_ACTION_RESTART_TUNNEL,
    serverId: "fixture-a",
    targetSignature: "-R 127.0.0.1:17891:127.0.0.1:28888 fixture-a.invalid",
    createdAt: 1000,
    expiresAt: 1000 + 60000,
    ...overrides,
  });
}

test("协议: 请求校验拒绝命令字符串/任意 PID/额外字段（协议封闭）", () => {
  assert.throws(() => makeRequest({ requestId: "not-a-uuid" }), ControlProtocolError);
  assert.throws(() => makeRequest({ serverId: "../escape" }), ControlProtocolError);
  assert.throws(() => makeRequest({ targetSignature: "bad\nnewline" }), ControlProtocolError);
  const withExtra = { ...makeRequest(), pid: 12345, command: "kill -9 1" };
  assert.throws(() => validateControlRequest(withExtra), /意外的请求字段/);
});

test("协议: monitor 原子写入请求，supervisor 认领→处理→写结果→清理", async () => {
  await withTempDir(async (dir) => {
    const handled = [];
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async ({ request }) => {
          handled.push(request.serverId);
          return { status: "succeeded", phase: "verified", reason: "", evidence: { pid: 4242, remotePortOpen: true } };
        },
      },
      now: () => 2000,
    });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest() });
    await mailbox.poll();
    assert.deepEqual(handled, ["fixture-a"]);
    const result = await readControlResult(dir, INSTANCE, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.status, "succeeded");
    assert.equal(result.evidence.remotePortOpen, true);
    assert.equal(result.operationId, "22222222-2222-4222-8222-222222222222");
    // processing 目录应已清理。
    const processingLeft = await readdirSafe(path.join(dir, "control", INSTANCE, "processing"));
    assert.equal(processingLeft.length, 0);
  });
});

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir).catch(() => []);
}

test("协议: 不写给本实例的请求绝不执行（跨实例隔离）", async () => {
  await withTempDir(async (dir) => {
    let handled = 0;
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: { [CONTROL_ACTION_RESTART_TUNNEL]: async () => { handled += 1; return { status: "succeeded", phase: "verified" }; } },
    });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest({ instanceId: "ffffffffffff" }) });
    await mailbox.poll();
    assert.equal(handled, 0, "他实例请求不得执行");
    // 请求被移除（不堆积）。
    const pending = await readdirSafe(path.join(dir, "control", INSTANCE, "requests"));
    assert.equal(pending.filter((n) => n.endsWith(".json")).length, 0);
  });
});

test("协议: 无 handler 的合法 action → failed 结果（可见错误，不静默）；伪造字段被校验拒绝", async () => {
  await withTempDir(async (dir) => {
    // 合法 schema 但没有注册 handler：处理路径给出明确 failed。
    const mailbox = createControlMailbox({ runtimeDir: dir, instanceId: INSTANCE, handlers: {}, now: () => 2000 });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest() });
    await mailbox.poll();
    const result = await readControlResult(dir, INSTANCE, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.status, "failed");
    assert.match(result.reason, /unsupported action/);
    // schema 校验拒绝未知 action（写入方与读回校验共用同一把尺子）。
    assert.throws(() => makeRequest({ action: "rm-rf" }), ControlProtocolError);
  });
});

test("A20: processing 残留超时 → status=unknown（不盲目重放副作用）", async () => {
  await withTempDir(async (dir) => {
    const processingDir = path.join(dir, "control", INSTANCE, "processing");
    await mkdir(processingDir, { recursive: true });
    const request = makeRequest();
    await writeFile(path.join(processingDir, `${request.requestId}.json`), JSON.stringify(request), "utf8");
    // 把 mtime 推到过去（超过 processingStaleMs）。
    const past = (Date.now() - CONTROL_PROCESSING_STALE_MS - 5000) / 1000;
    const { utimes } = await import("node:fs/promises");
    await utimes(path.join(processingDir, `${request.requestId}.json`), past, past);
    let handled = 0;
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: { [CONTROL_ACTION_RESTART_TUNNEL]: async () => { handled += 1; return { status: "succeeded", phase: "verified" }; } },
    });
    await mailbox.poll();
    assert.equal(handled, 0, "残留请求不得重放");
    const result = await readControlResult(dir, INSTANCE, request.requestId);
    assert.equal(result.status, "unknown");
    assert.match(result.reason, /restarted while processing|unverified/);
  });
});

test("协议: 符号链接/非普通文件被拒并隔离，不抛出", async () => {
  await withTempDir(async (dir) => {
    const requestsDir = path.join(dir, "control", INSTANCE, "requests");
    await mkdir(requestsDir, { recursive: true });
    const outside = path.join(dir, "outside.json");
    await writeFile(outside, "{}", "utf8");
    await symlink(outside, path.join(requestsDir, "11111111-1111-4111-8111-111111111111.json"));
    const mailbox = createControlMailbox({ runtimeDir: dir, instanceId: INSTANCE, handlers: {} });
    await mailbox.poll();
    // 链接被移除并留下 failed 结果，外部文件本身不动。
    const pending = await readdirSafe(requestsDir);
    assert.equal(pending.filter((n) => n.endsWith(".json")).length, 0);
    const result = await readControlResult(dir, INSTANCE, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.status, "failed");
    const outsideStillThere = await readFile(outside, "utf8");
    assert.equal(outsideStillThere, "{}");
  });
});

test("协议: 待处理请求满 16 条 → 写入方收到 503（满载可见错误）", async () => {
  await withTempDir(async (dir) => {
    for (let i = 0; i < CONTROL_MAX_PENDING_REQUESTS; i += 1) {
      await writeControlRequest({
        runtimeDir: dir,
        request: makeRequest({
          requestId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
          operationId: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
        }),
      });
    }
    await assert.rejects(
      () => writeControlRequest({ runtimeDir: dir, request: makeRequest({ requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }) }),
      /控制信箱已满/,
    );
  });
});

test("A20: monitor 重启后按 operationId 从结果目录找回已验证结果", async () => {
  await withTempDir(async (dir) => {
    const opId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: { [CONTROL_ACTION_RESTART_TUNNEL]: async () => ({ status: "succeeded", phase: "verified", evidence: { pid: 7 } }) },
      now: () => 2000,
    });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest({ operationId: opId }) });
    await mailbox.poll();
    const recovered = await findControlResultByOperationId(dir, INSTANCE, opId);
    assert.ok(recovered);
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.evidence.pid, 7);
    assert.equal(await findControlResultByOperationId(dir, INSTANCE, "99999999-9999-4999-8999-999999999999"), null);
  });
});

test("协议: 结果目录修剪到 ≤100 份且过期清理（预算有界）", async () => {
  await withTempDir(async (dir) => {
    const resultsDir = path.join(dir, "control", INSTANCE, "results");
    await mkdir(resultsDir, { recursive: true });
    for (let i = 0; i < 130; i += 1) {
      const name = `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}.json`;
      await writeFile(path.join(resultsDir, name), JSON.stringify({ requestId: name }), "utf8");
    }
    const mailbox = createControlMailbox({ runtimeDir: dir, instanceId: INSTANCE, handlers: {} });
    await mailbox.poll();
    const kept = (await readdirSafe(resultsDir)).filter((n) => n.endsWith(".json"));
    assert.ok(kept.length <= 100, `结果目录应修剪到 100 以内，实际 ${kept.length}`);
  });
});

// ---------------------------------------------------------------------------
// whenIdle / isPolling：交接退出需要"等在飞动作收尾"的可观测句柄
// 信箱里跑的受控重启是"停旧 ssh → 起新 ssh"的复合动作，不在主循环 tick 的 promise 里。
// supervisor 交接退出若只等 tick 就 exit(0)，会把它截断成"旧进程已停、新进程没起、
// 注册表记录还在"，下一任 supervisor 看到一条存在但已死的记录。
// ---------------------------------------------------------------------------

test("whenIdle: 没有在飞轮次时立即结算，且 isPolling 为 false", async () => {
  await withTempDir(async (dir) => {
    const mailbox = createControlMailbox({ runtimeDir: dir, instanceId: INSTANCE, handlers: {} });
    assert.equal(mailbox.isPolling(), false);
    assert.equal(await mailbox.whenIdle(), undefined, "空闲时必须立即结算，不能挂住交接退出");
  });
});

test("whenIdle: 等待在飞的 poll 真正收尾后才结算", async () => {
  await withTempDir(async (dir) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = [];
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async ({ request }) => {
          started.push(request.serverId);
          await gate; // 模拟慢动作：停旧 ssh 与起新 ssh 之间的等待
          return { status: "succeeded", phase: "verified" };
        },
      },
      now: () => 2000,
    });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest() });

    const pollRun = mailbox.poll();
    // 等 poll 进入 handler：轮询条件而不是固定睡 10ms（Windows CI 上读写请求文件更慢，曾间歇失败）。
    for (let i = 0; i < 200 && started.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(started, ["fixture-a"]);
    assert.equal(mailbox.isPolling(), true, "动作执行期间必须报告在飞");

    let settled = false;
    const idle = mailbox.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, "动作未收尾时 whenIdle 不得结算");

    release();
    await idle;
    await pollRun;
    assert.equal(mailbox.isPolling(), false);
    const result = await readControlResult(dir, INSTANCE, "11111111-1111-4111-8111-111111111111");
    assert.equal(result.status, "succeeded", "等到的必须是已写出结果的那一轮");
  });
});

test("whenIdle: 已被 stopping 拦下的重入 poll 不改变在飞状态", async () => {
  await withTempDir(async (dir) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const mailbox = createControlMailbox({
      runtimeDir: dir,
      instanceId: INSTANCE,
      handlers: {
        [CONTROL_ACTION_RESTART_TUNNEL]: async () => {
          await gate;
          return { status: "succeeded", phase: "verified" };
        },
      },
      now: () => 2000,
    });
    await writeControlRequest({ runtimeDir: dir, request: makeRequest() });
    const pollRun = mailbox.poll();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 重入：内部互斥应当直接返回，不能把 pollPromise 覆盖成 undefined。
    await mailbox.poll();
    assert.equal(mailbox.isPolling(), true, "重入不得清掉在飞标记");
    let settled = false;
    mailbox.whenIdle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, "重入不得让 whenIdle 误判为空闲");

    release();
    await pollRun;
    assert.equal(mailbox.isPolling(), false);
  });
});
