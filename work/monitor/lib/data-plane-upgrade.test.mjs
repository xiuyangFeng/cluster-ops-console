// 热更新数据面交接编排（monitor 侧）：全部 fake——注册表、快照、信箱、进程表。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { createDataPlaneUpgrader, normalizeUpgradeComponents, UpgradeRequestError } from "./data-plane-upgrade.mjs";
import { StatusError } from "./status-error.mjs";

test("UpgradeRequestError: 继承 StatusError，保留 (status, message) 签名与类名", () => {
  assert.throws(() => normalizeUpgradeComponents({ components: [] }), (err) => (
    err instanceof UpgradeRequestError
    && err instanceof StatusError
    && err.name === "UpgradeRequestError"
    && err.status === 400
  ));
});

// 一个假世界：进程表 live、注册表 metas、supervisor 快照、信箱结果。
function world({ legacy = false, oldExits = true, newHealthy = true, proxyResult = "succeeded", tunnelChanges = null, shouldBeRunning = () => true, running = null, bundle = null, afterSettled } = {}) {
  const live = new Set([100, 7001, 7002, 4242]);
  const metas = {
    "channel-supervisor": { pid: 100 },
    "tunnel.server-01": { pid: 7001 },
    "tunnel.server-02": { pid: 7002 },
    "local-proxy": { pid: 4242 },
  };
  let snapshot = {
    pid: 100,
    instanceId: "aaaa1111",
    effectiveProxyPort: 8888,
    capabilities: legacy ? { controlProtocol: 1 } : { controlProtocol: 1, handoffExit: true, proxyHandoff: true },
    firstTickCompletedAt: 1,
    // running：运行中 supervisor 冻结的自身指纹 + 它读回的代理指纹（缺省不带 = 旧快照 / 未知）。
    ...(running ? { components: { ...running } } : {}),
  };
  const signals = [];
  const requests = [];
  const events = [];
  const removedDirs = [];
  let holds = 0;
  let maxHolds = 0;
  let spawnCount = 0;
  let newPid = null;

  const registry = {
    readMeta: (name) => (metas[name] ? { ...metas[name] } : null),
    verifyProcess: async (name) => {
      const meta = metas[name];
      return meta && live.has(meta.pid) ? { verified: true, meta: { ...meta } } : { verified: false, meta: meta || null };
    },
    verifyProcesses: async (names) => new Map(names.map((name) => {
      const meta = metas[name];
      return [name, meta && live.has(meta.pid) ? { verified: true, meta: { ...meta } } : { verified: false, meta: meta || null }];
    })),
  };

  const upgrader = createDataPlaneUpgrader({
    registry,
    runtimeDir: "/fake/runtime",
    readdir: async () => Object.keys(metas).map((name) => `${name}.pid.json`).concat(["supervisor-state.json"]),
    removeControlDir: async (dir) => removedDirs.push(dir),
    readSnapshot: async () => ({ snapshot, stale: false }),
    ...(bundle ? { getBundleComponents: async () => ({ ...bundle }) } : {}),
    ...(afterSettled ? { afterSettled } : {}),
    shouldBeRunning,
    spawnSupervisor: async () => {
      spawnCount += 1;
      events.push("spawn");
      newPid = 200 + spawnCount;
      live.add(newPid);
      metas["channel-supervisor"] = { pid: newPid };
      if (newHealthy) {
        snapshot = { ...snapshot, pid: newPid, instanceId: "bbbb2222", firstTickCompletedAt: 2, capabilities: { controlProtocol: 1, handoffExit: true, proxyHandoff: true } };
        // 新 supervisor 跑的是磁盘新包的代码。
        if (bundle && snapshot.components) snapshot.components = { ...snapshot.components, supervisor: bundle.supervisor };
      }
      if (tunnelChanges) tunnelChanges(metas, live);
      return { pid: newPid };
    },
    holdAutoRepair: () => {
      holds += 1;
      maxHolds = Math.max(maxHolds, holds);
      events.push("hold");
      return () => {
        holds -= 1;
        events.push("release");
      };
    },
    writeControlRequest: async ({ request }) => {
      requests.push(request);
      events.push(`mailbox:${request.action}@${request.instanceId}`);
      if (request.action === "handoff-exit" && oldExits) {
        live.delete(100);
        delete metas["channel-supervisor"];
      }
      return request;
    },
    readControlResult: async (_dir, instanceId, requestId) => {
      const request = requests.find((r) => r.requestId === requestId);
      if (request?.action !== "proxy-handoff") return null;
      if (proxyResult === "succeeded") {
        metas["local-proxy"] = { pid: 5555 };
        if (bundle && snapshot.components) snapshot = { ...snapshot, components: { ...snapshot.components, proxy: bundle.proxy } };
        return { status: "succeeded", reason: "", evidence: { oldPid: 4242, newPid: 5555 }, instanceId };
      }
      return { status: "failed", reason: "running local proxy predates graceful handoff", evidence: {} };
    },
    signal: (pid, sig) => {
      signals.push({ pid, sig });
      events.push(`signal:${sig}:${pid}`);
    },
    pidAlive: (pid) => live.has(pid),
    platform: "darwin",
    sleep: async () => {},
    timeouts: { oldExitMs: 50, newHealthyMs: 50, proxyHandoffMs: 50, pollMs: 1 },
    now: (() => {
      let t = 0;
      return () => (t += 5);
    })(),
  });
  return { upgrader, live, metas, signals, requests, events, removedDirs, get holds() { return holds; }, get maxHolds() { return maxHolds; }, get spawnCount() { return spawnCount; } };
}

test("components 校验：只接受 supervisor/proxy 的非空子集", () => {
  assert.deepEqual(normalizeUpgradeComponents({ components: ["proxy", "supervisor"] }), ["supervisor", "proxy"]);
  assert.deepEqual(normalizeUpgradeComponents({ components: ["proxy"] }), ["proxy"]);
  for (const bad of [null, {}, { components: [] }, { components: ["tunnel"] }, { components: "supervisor" }, { components: ["supervisor", "proxy", "x"] }]) {
    assert.throws(() => normalizeUpgradeComponents(bad), (err) => err.status === 400);
  }
});

test("supervisor+proxy 全流程：信箱交接退出 → 新 supervisor 首拍接管 → 代理交接；隧道 pid 全程不变", async () => {
  const w = world();
  const { status, body } = await w.upgrader.upgrade({ components: ["supervisor", "proxy"] });
  assert.equal(status, 200);
  assert.equal(body.ok, true, JSON.stringify(body.steps));
  assert.deepEqual(body.steps.map((s) => [s.name, s.ok]), [
    ["supervisor-handoff", true],
    ["supervisor-start", true],
    ["supervisor-healthy", true],
    ["proxy-handoff", true],
    ["tunnels-unchanged", true],
  ]);
  assert.deepEqual(body.tunnels.before, { "tunnel.server-01": 7001, "tunnel.server-02": 7002 });
  assert.deepEqual(body.tunnels.after, body.tunnels.before);
  assert.deepEqual(body.proxy, { beforePid: 4242, afterPid: 5555 });
  // 顺序：先 hold 守护巡检 → 旧实例信箱 → SIGUSR2 → spawn → 新实例信箱 → release。
  assert.deepEqual(w.events, [
    "hold",
    "mailbox:handoff-exit@aaaa1111",
    "signal:SIGUSR2:100",
    "spawn",
    "mailbox:proxy-handoff@bbbb2222",
    "release",
  ]);
  assert.deepEqual(w.signals, [{ pid: 100, sig: "SIGUSR2" }], "只给声明了交接能力的旧 supervisor 发 SIGUSR2，隧道/代理零信号");
  assert.deepEqual(w.removedDirs, [path.join("/fake/runtime", "control", "aaaa1111")], "旧实例的信箱目录随之清理");
  assert.equal(w.holds, 0);
});

test("win32：不发 SIGUSR2，只走信箱", async () => {
  const signals = [];
  let alive = true;
  const upgrader = createDataPlaneUpgrader({
    registry: {
      readMeta: (name) => (name === "channel-supervisor" && alive ? { pid: 100 } : null),
      verifyProcess: async () => ({ verified: alive, meta: { pid: 100 } }),
      verifyProcesses: async () => new Map(),
    },
    runtimeDir: "C:\\fake",
    readdir: async () => [],
    removeControlDir: async () => {},
    readSnapshot: async () => ({ snapshot: { pid: 100, instanceId: "cccc3333", capabilities: { handoffExit: true, proxyHandoff: true }, firstTickCompletedAt: 1 } }),
    spawnSupervisor: async () => ({ pid: null }),
    writeControlRequest: async ({ request }) => {
      alive = false;
      return request;
    },
    signal: (pid, sig) => signals.push({ pid, sig }),
    pidAlive: (pid) => pid === 100 && alive,
    platform: "win32",
    sleep: async () => {},
    timeouts: { oldExitMs: 20, newHealthyMs: 20, proxyHandoffMs: 20, pollMs: 1 },
  });
  const { body } = await upgrader.upgrade({ components: ["supervisor"] });
  assert.deepEqual(signals, []);
  assert.deepEqual(body.steps[0], { name: "supervisor-handoff", ok: true, detail: "old supervisor pid 100 exited without touching tunnels/proxy" });
});

test("旧版 supervisor（无 handoffExit 能力）：一概不动它——不发信号、不 spawn，ok=false 说明原因", async () => {
  const w = world({ legacy: true });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(body.ok, false);
  assert.equal(body.steps[0].name, "supervisor-handoff");
  assert.match(body.steps[0].detail, /predates hot handoff/);
  assert.deepEqual(w.signals, []);
  assert.equal(w.spawnCount, 0);
  assert.equal(w.live.has(100), true);
  assert.equal(body.steps.at(-1).ok, true, "隧道没动");
});

test("旧 supervisor 5s 内没退出：中止，不 spawn 第二个；hold 释放后守护巡检照常兜底", async () => {
  const w = world({ oldExits: false });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor", "proxy"] });
  assert.equal(body.ok, false);
  assert.equal(w.spawnCount, 0, "旧的还活着时绝不拉起第二个");
  assert.deepEqual(body.steps.map((s) => [s.name, s.ok]), [
    ["supervisor-handoff", false],
    ["proxy-handoff", false],
    ["tunnels-unchanged", true],
  ]);
  assert.equal(w.holds, 0);
});

test("新 supervisor 未在期限内完成首拍：ok=false，且不再发代理交接", async () => {
  const w = world({ newHealthy: false });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor", "proxy"] });
  assert.equal(body.ok, false);
  const healthy = body.steps.find((s) => s.name === "supervisor-healthy");
  assert.equal(healthy.ok, false);
  assert.equal(body.steps.find((s) => s.name === "proxy-handoff").detail, "skipped: supervisor step failed");
  assert.equal(w.requests.filter((r) => r.action === "proxy-handoff").length, 0);
});

test("隧道 pid 变化或消失 → ok=false，并指出是哪一条", async () => {
  const w = world({
    tunnelChanges: (metas, live) => {
      live.delete(7002);
      metas["tunnel.server-01"] = { pid: 7101 };
      live.add(7101);
    },
  });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(body.ok, false);
  const verdict = body.steps.at(-1);
  assert.equal(verdict.name, "tunnels-unchanged");
  assert.equal(verdict.ok, false);
  assert.match(verdict.detail, /tunnel\.server-01/);
  assert.match(verdict.detail, /tunnel\.server-02/);
  assert.deepEqual(body.tunnels.after, { "tunnel.server-01": 7101 });
});

test("只升级代理且当前 supervisor 已支持代理交接：不重启 supervisor", async () => {
  const w = world();
  const { body } = await w.upgrader.upgrade({ components: ["proxy"] });
  assert.equal(body.ok, true);
  assert.deepEqual(body.steps.map((s) => s.name), ["proxy-handoff", "tunnels-unchanged"]);
  assert.equal(w.spawnCount, 0);
  assert.deepEqual(w.signals, []);
});

test("代理交接被 supervisor 拒绝（旧版代理）→ ok=false 并透传原因", async () => {
  const w = world({ proxyResult: "failed" });
  const { body } = await w.upgrader.upgrade({ components: ["proxy"] });
  assert.equal(body.ok, false);
  assert.match(body.steps[0].detail, /predates graceful handoff/);
  assert.deepEqual(body.proxy, { beforePid: 4242, afterPid: 4242 });
});

test("串行：进行中再来一次 → 409；其它互斥动作在飞 → 409；fixture 模式 → 409；参数错 → 400", async () => {
  const w = world();
  const first = w.upgrader.upgrade({ components: ["supervisor"] });
  const second = await w.upgrader.upgrade({ components: ["proxy"] });
  assert.equal(second.status, 409);
  await first;
  assert.equal(w.upgrader.isInFlight(), false);

  const busy = createDataPlaneUpgrader({ registry: {}, isBusy: () => "restart already in flight" });
  assert.deepEqual(await busy.upgrade({ components: ["proxy"] }), { status: 409, body: { error: "restart already in flight" } });
  const fixture = createDataPlaneUpgrader({ registry: {}, fixtureMode: true });
  assert.equal((await fixture.upgrade({ components: ["proxy"] })).status, 409);
  assert.equal((await fixture.upgrade({ components: [] })).status, 400);
});

test("用户已停止通道且没有 supervisor 在跑：不擅自拉起", async () => {
  const upgrader = createDataPlaneUpgrader({
    registry: { readMeta: () => null, verifyProcess: async () => ({ verified: false }), verifyProcesses: async () => new Map() },
    runtimeDir: "/fake",
    readdir: async () => [],
    readSnapshot: async () => ({ snapshot: null }),
    spawnSupervisor: async () => { throw new Error("must not spawn"); },
    shouldBeRunning: () => false,
    pidAlive: () => false,
    sleep: async () => {},
  });
  const { body } = await upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(body.ok, true);
  assert.deepEqual(body.steps.map((s) => s.name), ["supervisor-handoff", "supervisor-start", "tunnels-unchanged"]);
  assert.match(body.steps[1].detail, /stopped by the user/);
});

test("旧 supervisor 退场期间用户点了停止：不再拉起新 supervisor，ok=false 且步骤为 stopped-by-user", async () => {
  let running = true;
  const w = world({ shouldBeRunning: () => running });
  // 模拟：旧实例收到交接信箱的同一时刻，用户的停止落地。
  const origUpgrade = w.upgrader.upgrade;
  const pending = origUpgrade({ components: ["supervisor", "proxy"] });
  running = false;
  const { status, body } = await pending;
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(w.spawnCount, 0, "停止意图不能被升级覆盖");
  assert.deepEqual(body.steps.map((s) => [s.name, s.ok]), [
    ["supervisor-handoff", true],
    ["stopped-by-user", false],
    ["proxy-handoff", false],
    ["tunnels-unchanged", true],
  ]);
  assert.equal(w.holds, 0);
});

// ---- v2.57 幂等：v2.56.0 热更新后约 30 秒多出的一次 supervisor 交接 ----
// 生产 ops 日志：热更新脚本 POST [supervisor,proxy] 成功；28s 后又来一次 POST [supervisor]（只有横幅
// 会单发一个组件），新 supervisor 被无谓地再交接一遍。复现：同一个世界里先做完整升级，再来一次 [supervisor]。

const OLD = { supervisor: "aaaaaaaaaaaa", proxy: "bbbbbbbbbbbb" };
const NEW = { supervisor: "cccccccccccc", proxy: "dddddddddddd" };

test("幂等：热更新已交接完，过期横幅再请求 [supervisor] → 不发信号、不 spawn，noop=true", async () => {
  const settled = [];
  const w = world({ running: OLD, bundle: NEW, afterSettled: async () => settled.push("poll") });
  const first = await w.upgrader.upgrade({ components: ["supervisor", "proxy"] });
  assert.equal(first.body.ok, true, JSON.stringify(first.body.steps));
  assert.equal(first.body.noop, undefined);
  assert.equal(w.spawnCount, 1);
  const signalsAfterFirst = w.signals.length;

  const second = await w.upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(second.status, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.noop, true);
  assert.deepEqual(second.body.steps.map((s) => [s.name, s.ok, Boolean(s.skipped)]), [
    ["supervisor-handoff", true, true],
    ["tunnels-unchanged", true, false],
  ]);
  assert.match(second.body.steps[0].detail, /already runs the bundle code \(cccccccccccc\)/);
  assert.equal(w.spawnCount, 1, "不得再拉起第二个新 supervisor");
  assert.equal(w.signals.length, signalsAfterFirst, "不得再给新 supervisor 发 SIGUSR2");
  assert.deepEqual(settled, ["poll", "poll"], "每次交接结束都立即刷新快照缓存");
  assert.equal(w.upgrader.isInFlight(), false);
  assert.equal(w.holds, 0);
});

test("幂等：只跳过已是新代码的组件；代理已是新代码时 [supervisor,proxy] 只交接 supervisor", async () => {
  const w = world({ running: { supervisor: OLD.supervisor, proxy: NEW.proxy }, bundle: NEW });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor", "proxy"] });
  assert.equal(body.ok, true);
  assert.equal(body.noop, undefined);
  assert.deepEqual(body.steps.map((s) => [s.name, Boolean(s.skipped)]), [
    ["supervisor-handoff", false],
    ["supervisor-start", false],
    ["supervisor-healthy", false],
    ["proxy-handoff", true],
    ["tunnels-unchanged", false],
  ]);
  assert.equal(w.requests.filter((r) => r.action === "proxy-handoff").length, 0, "代理不动");
});

test("幂等：指纹未知（快照没带 / 新包取不到 / 空串）一律照常交接", async () => {
  for (const opts of [{ bundle: NEW }, { running: OLD }, { running: { supervisor: "", proxy: "" }, bundle: { supervisor: "", proxy: "" } }]) {
    const w = world(opts);
    const { body } = await w.upgrader.upgrade({ components: ["supervisor"] });
    assert.equal(body.ok, true, JSON.stringify(opts));
    assert.equal(body.noop, undefined, JSON.stringify(opts));
    assert.equal(w.spawnCount, 1, JSON.stringify(opts));
  }
});

test("afterSettled 失败也不影响结果与互斥释放", async () => {
  const w = world({ afterSettled: async () => { throw new Error("poll failed"); } });
  const { body } = await w.upgrader.upgrade({ components: ["supervisor"] });
  assert.equal(body.ok, true);
  assert.equal(w.upgrader.isInFlight(), false);
  assert.equal(w.holds, 0);
});
