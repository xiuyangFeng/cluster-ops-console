import assert from "node:assert/strict";
import test from "node:test";

import {
  computeServerRestartPolicy,
  isNavigationAllowed,
  partitionQuitStopTargets,
  waitForServerReady,
  updateAlertQueue,
} from "./desktop-lifecycle.mjs";

test("computeServerRestartPolicy backs off exponentially from the base delay", () => {
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 1 }), {
    shouldRestart: true,
    delayMs: 1000,
  });
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 2 }), {
    shouldRestart: true,
    delayMs: 2000,
  });
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 3 }), {
    shouldRestart: true,
    delayMs: 4000,
  });
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 4 }), {
    shouldRestart: true,
    delayMs: 8000,
  });
});

test("computeServerRestartPolicy caps the delay at capMs", () => {
  // 用更高的重试上限来触达封顶值，验证指数增长被 capMs 截断。
  assert.deepEqual(
    computeServerRestartPolicy({ consecutiveFailures: 10, maxRetries: 20 }),
    { shouldRestart: true, delayMs: 30000 },
  );
});

test("computeServerRestartPolicy stops after reaching maxRetries", () => {
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 5 }), {
    shouldRestart: false,
    delayMs: 0,
  });
  assert.deepEqual(computeServerRestartPolicy({ consecutiveFailures: 8 }), {
    shouldRestart: false,
    delayMs: 0,
  });
});

test("waitForServerReady resolves true once a probe returns 200", async () => {
  let calls = 0;
  const sleeps = [];
  const fetchImpl = async (url, options) => {
    calls += 1;
    // 前两次连接失败（服务尚未监听），第三次成功。
    if (calls < 3) throw new Error("ECONNREFUSED");
    assert.equal(url, "http://127.0.0.1:8877/api/status-lite");
    assert.equal(options.headers["x-auth-token"], "tok");
    return { status: 200, ok: true };
  };
  const sleepImpl = async (ms) => {
    sleeps.push(ms);
  };
  const ready = await waitForServerReady({
    url: "http://127.0.0.1:8877/api/status-lite",
    token: "tok",
    intervalMs: 250,
    timeoutMs: 15000,
    fetchImpl,
    sleepImpl,
  });
  assert.equal(ready, true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [250, 250]);
});

test("waitForServerReady resolves false on timeout without real waiting", async () => {
  let calls = 0;
  let sleepCount = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("ECONNREFUSED");
  };
  const sleepImpl = async () => {
    sleepCount += 1;
  };
  const ready = await waitForServerReady({
    url: "http://127.0.0.1:8877/api/status-lite",
    token: "tok",
    intervalMs: 250,
    timeoutMs: 1000,
    fetchImpl,
    sleepImpl,
  });
  assert.equal(ready, false);
  // 1000ms / 250ms => 睡 4 次后累计到超时，第 5 次探测失败即返回。
  assert.equal(sleepCount, 4);
  assert.equal(calls, 5);
});

test("waitForServerReady treats non-200 responses as not-ready", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return { status: 503, ok: false };
    return { status: 200, ok: true };
  };
  const sleepImpl = async () => {};
  const ready = await waitForServerReady({
    url: "u",
    token: "t",
    intervalMs: 10,
    timeoutMs: 1000,
    fetchImpl,
    sleepImpl,
  });
  assert.equal(ready, true);
  assert.equal(calls, 2);
});

test("updateAlertQueue: 确认期内恢复 → 静默；确认到期 → 告警；告警后恢复 → 恢复通知", () => {
  const pending = new Map();
  const t0 = 1000;
  const errT = { ts: t0, key: "agent:codex", from: "ok", to: "error", layer: "agents", reason: "x" };
  // 进入 pending，不立即告警
  let r = updateAlertQueue({ pending, transitions: [errT], now: t0, confirmMs: 30000 });
  assert.equal(r.toNotify.length, 0);
  assert.equal(pending.size, 1);
  // 15s 后恢复：静默删除
  r = updateAlertQueue({ pending, transitions: [{ ...errT, ts: t0 + 15000, from: "error", to: "ok" }], now: t0 + 15000, confirmMs: 30000 });
  assert.equal(r.toRecover.length, 0);
  assert.equal(pending.size, 0);
  // 再次 error，31s 无恢复 → 告警
  updateAlertQueue({ pending, transitions: [{ ...errT, ts: t0 + 60000 }], now: t0 + 60000, confirmMs: 30000 });
  r = updateAlertQueue({ pending, transitions: [], now: t0 + 91000, confirmMs: 30000 });
  assert.equal(r.toNotify.length, 1);
  assert.equal(r.toNotify[0].key, "agent:codex");
  // 已告警后的恢复 → 恢复通知
  r = updateAlertQueue({ pending, transitions: [{ ...errT, ts: t0 + 95000, from: "error", to: "ok" }], now: t0 + 95000, confirmMs: 30000 });
  assert.equal(r.toRecover.length, 1);
  assert.equal(pending.size, 0);
});

test("updateAlertQueue: 无 pending 的 error→ok 恢复也发恢复通知（进程重启场景）", () => {
  const pending = new Map();
  const r = updateAlertQueue({
    pending,
    transitions: [{ ts: 5000, key: "channel", from: "error", to: "ok", layer: "channel", reason: "" }],
    now: 5000,
    confirmMs: 30000,
  });
  assert.equal(r.toRecover.length, 1);
});

// ---------------------------------------------------------------------------
// 导航白名单：preload 的 getAuthToken 会被任何被导航到的页面继承
// ---------------------------------------------------------------------------

const ISLAND = "file:///Applications/App.app/Contents/Resources/app.asar/work/monitor/public/island.html";
const MONITOR = "http://127.0.0.1:8877";

test("isNavigationAllowed: http 只放行白名单 origin", () => {
  assert.equal(isNavigationAllowed(`${MONITOR}/index.html`, [MONITOR]), true);
  assert.equal(isNavigationAllowed(`${MONITOR}/api/status?x=1#y`, [MONITOR]), true);
  assert.equal(isNavigationAllowed("http://127.0.0.1:9999/", [MONITOR]), false);
  assert.equal(isNavigationAllowed("http://evil.com/", [MONITOR]), false);
});

test("isNavigationAllowed: userinfo 前缀绕过必须被拦下", () => {
  // "http://127.0.0.1:8877@evil.com/" 以允许前缀开头，但实际 host 是 evil.com。
  assert.equal(isNavigationAllowed(`${MONITOR}@evil.com/`, [MONITOR]), false);
  assert.equal(isNavigationAllowed(`${MONITOR}.evil.com/`, [MONITOR]), false);
});

test("isNavigationAllowed: file: 只放行列出的那个文件，不放行整个 scheme", () => {
  assert.equal(isNavigationAllowed(ISLAND, [ISLAND]), true);
  // 关键回归：此前 `protocol === "file:"` 直接放行 → 任意本地 HTML 都能继承 preload
  // 并调用 window.desktop.getAuthToken() 把 Token 外发。
  assert.equal(isNavigationAllowed("file:///Users/me/Downloads/evil.html", [ISLAND]), false);
  assert.equal(isNavigationAllowed("file:///etc/passwd", [ISLAND]), false);
  assert.equal(isNavigationAllowed("file:///tmp/x.html", ["file:"]), false, "裸 file: 不再具有放行语义");
});

test("isNavigationAllowed: file: 目标必须完全一致（查询串/片段/百分号编码都参与比较）", () => {
  assert.equal(isNavigationAllowed(`${ISLAND}?a=1`, [ISLAND]), false);
  assert.equal(isNavigationAllowed(`${ISLAND}#frag`, [ISLAND]), false);
  assert.equal(isNavigationAllowed(ISLAND.replace("island.html", "island%2Ehtml"), [ISLAND]), true, "同路径的等价编码应视为同一文件");
  assert.equal(isNavigationAllowed(ISLAND, [`${ISLAND}?a=1`]), false);
});

test("isNavigationAllowed: 非法 URL 与非法白名单条目一律拒绝且不抛", () => {
  assert.equal(isNavigationAllowed("not a url", [MONITOR]), false);
  assert.equal(isNavigationAllowed("", [MONITOR]), false);
  assert.equal(isNavigationAllowed(MONITOR, []), false);
  assert.equal(isNavigationAllowed(MONITOR, undefined), false);
  assert.equal(isNavigationAllowed(MONITOR, ["also not a url"]), false);
  assert.doesNotThrow(() => isNavigationAllowed("file:///%E0%A4%A", [ISLAND]));
});

test("isNavigationAllowed: 非 http(s)/file 协议（如 about:、javascript:）一律拒绝", () => {
  assert.equal(isNavigationAllowed("about:blank", [MONITOR]), false);
  assert.equal(isNavigationAllowed("javascript:alert(1)", [MONITOR]), false);
  assert.equal(isNavigationAllowed("data:text/html,<script>x</script>", [MONITOR]), false);
});

// ---------------------------------------------------------------------------
// 显式退出：父进程独占第一段，其余可并发
// ---------------------------------------------------------------------------

test("partitionQuitStopTargets: channel-supervisor 独占第一段，无论传入顺序如何", () => {
  const tunnelsFirst = partitionQuitStopTargets(["tunnel.a", "local-proxy", "channel-supervisor", "tunnel.b"]);
  assert.deepEqual(tunnelsFirst.first, ["channel-supervisor"]);
  assert.deepEqual(tunnelsFirst.rest, ["tunnel.a", "local-proxy", "tunnel.b"], "其余保持原相对顺序");

  const alreadyFirst = partitionQuitStopTargets(["channel-supervisor", "local-proxy", "tunnel.a"]);
  assert.deepEqual(alreadyFirst.first, ["channel-supervisor"]);
  assert.deepEqual(alreadyFirst.rest, ["local-proxy", "tunnel.a"]);
});

test("partitionQuitStopTargets: 列表里没有父进程时第一段为空，且过滤非法项", () => {
  const result = partitionQuitStopTargets(["local-proxy", "", null, undefined, 7, "tunnel.a"]);
  assert.deepEqual(result.first, []);
  assert.deepEqual(result.rest, ["local-proxy", "tunnel.a"]);
  assert.deepEqual(partitionQuitStopTargets(undefined), { first: [], rest: [] });
  assert.deepEqual(partitionQuitStopTargets("channel-supervisor"), { first: [], rest: [] });
});
