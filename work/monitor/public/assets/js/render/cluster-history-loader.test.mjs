import assert from "node:assert/strict";
import test from "node:test";

import { createHistoryLoader } from "./cluster-history-loader.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 3, 4, 0, 0);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// 手动计时器 + 可控的可见性 / 时钟 / 接口应答。
function harness() {
  const calls = [];
  const timers = [];
  const env = { active: true, now: NOW, changes: 0, reply: null, onChange: null };
  env.reply = async () => ({ state: "ok", checkedAt: env.now - 10_000, rows: [] });
  const loader = createHistoryLoader({
    getJson: (path) => {
      calls.push(path);
      return env.reply(path);
    },
    isActive: () => env.active,
    onChange: () => {
      env.changes += 1;
      env.onChange?.();
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timer.cleared = true;
    },
    now: () => env.now,
  });
  const pending = () => timers.filter((t) => !t.cleared && !t.fired);
  async function fire() {
    const [timer] = pending();
    assert.ok(timer, "应有一个在走的计时器");
    timer.fired = true;
    timer.fn();
    await flush();
  }
  return { loader, calls, env, pending, fire };
}

test("没有选中服务器 / 没注入接口：不拉也不排表", async () => {
  const { loader, calls, pending } = harness();
  await loader.start();
  loader.sync();
  assert.deepEqual(calls, []);
  assert.equal(pending().length, 0);
  const bare = createHistoryLoader();
  bare.setServer("server-01");
  await bare.start();
  bare.sync();
  assert.deepEqual(bare.state(), { serverId: "server-01", data: null, diagnoses: null, scripts: new Map(), error: "", loading: false, revision: 0 });
});

test("进入历史：立即拉一次，完成后按上次采集时刻排下一次（跟随 5 分钟一轮的采集）", async () => {
  const { loader, calls, env, pending } = harness();
  loader.setServer("server-01");
  const run = loader.start();
  assert.equal(loader.state().loading, true, "请求发出即进入加载态（面板据此显示「正在读取」）");
  await run;
  assert.deepEqual(calls, ["/api/jobs?serverId=server-01"]);
  const state = loader.state();
  assert.deepEqual([state.data.state, state.error, state.loading, state.revision], ["ok", "", false, 1]);
  assert.equal(env.changes, 1);
  assert.deepEqual(pending().map((t) => t.ms), [5 * MIN + 5_000]);
});

test("到点：还看得见就拉；看不见（离开服务器页 / 切回当前队列 / 窗口隐藏）就停表不空转", async () => {
  const { loader, calls, env, pending, fire } = harness();
  loader.setServer("server-01");
  await loader.start();
  env.now += 5 * MIN + 5_000;
  await fire();
  assert.equal(calls.length, 2);
  assert.equal(pending().length, 1, "拉完接着排下一次");

  env.active = false;
  await fire();
  assert.equal(calls.length, 2, "看不见时不拉");
  assert.equal(pending().length, 0, "也不再排表");
  loader.sync();
  assert.equal(calls.length, 2);

  // 重新可见：渲染入口的 sync 续上，并立刻补拉一次
  env.active = true;
  loader.sync();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(pending().length, 1);
});

test("sync 幂等：请求在途或表已在走时不重复拉；通知重绘时再 sync 也不会成环", async () => {
  const { loader, calls, env, pending } = harness();
  loader.setServer("server-01");
  env.onChange = () => loader.sync();
  const run = loader.start();
  loader.sync();
  loader.start();
  await run;
  await flush();
  assert.equal(calls.length, 1);
  for (let i = 0; i < 5; i += 1) loader.sync();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(pending().length, 1);
  assert.equal(env.changes, 1);
});

test("手动再拉一次（立即刷新 / 重新进入历史）：重排计时器，不留下两个表", async () => {
  const { loader, calls, pending } = harness();
  loader.setServer("server-01");
  await loader.start();
  await loader.start();
  assert.equal(calls.length, 2);
  assert.equal(pending().length, 1);
  loader.stop();
  assert.equal(pending().length, 0);
});

test("失败：保留上次取到的数据并记下原因；从没取到过时 1 分钟后重试", async () => {
  const { loader, env, pending } = harness();
  loader.setServer("server-01");
  env.reply = async () => {
    throw Object.assign(new Error("HTTP 503"), { serverMessage: "jobs unavailable" });
  };
  await loader.start();
  assert.deepEqual([loader.state().data, loader.state().error], [null, "jobs unavailable"]);
  assert.deepEqual(pending().map((t) => t.ms), [MIN]);

  env.reply = async () => ({ state: "ok", checkedAt: env.now - 10_000, rows: [] });
  await loader.start();
  assert.equal(loader.state().error, "");
  env.reply = async () => {
    throw new Error("网络错误");
  };
  await loader.start();
  const state = loader.state();
  assert.equal(state.error, "网络错误");
  assert.equal(state.data.state, "ok", "上次的数据还在");
  assert.equal(state.revision, 3);
});

test("换服务器：旧数据清空，在途请求的结果作废，新服务器重新拉", async () => {
  const { loader, calls, env } = harness();
  let release;
  env.reply = (path) => (path.endsWith("server-01")
    ? new Promise((resolve) => { release = () => resolve({ state: "ok", checkedAt: env.now, rows: ["旧"] }); })
    : Promise.resolve({ state: "ok", checkedAt: env.now, rows: ["新"] }));
  loader.setServer("server-01");
  loader.start();
  loader.setServer("server-02");
  assert.deepEqual([loader.state().data, loader.state().loading], [null, false]);
  await loader.start();
  assert.deepEqual(loader.state().data.rows, ["新"]);
  release();
  await flush();
  assert.deepEqual(loader.state().data.rows, ["新"], "迟到的旧结果不覆盖新数据");
  assert.deepEqual(calls, ["/api/jobs?serverId=server-01", "/api/jobs?serverId=server-02"]);
  assert.equal(env.changes, 1);

  loader.setServer("server-02");
  assert.deepEqual(loader.state().data.rows, ["新"], "同一台服务器重复设置不清数据");
  loader.setServer(null);
  assert.equal(loader.state().data, null);
});

test("服务器 id 进查询串前转义", async () => {
  const { loader, calls } = harness();
  loader.setServer("a b&c");
  await loader.start();
  assert.deepEqual(calls, ["/api/jobs?serverId=a%20b%26c"]);
});

test("模块已关闭（{ disabled: true }）：不当数据收下，保留上次的数据并给出说明", async () => {
  const { loader, env } = harness();
  loader.setServer("server-01");
  await loader.start();
  const before = loader.state().data;
  env.reply = async () => ({ disabled: true });
  await loader.start();
  assert.equal(loader.state().data, before);
  assert.match(loader.state().error, /监控已关闭/);
});

// ---- 失败作业诊断（v2.49）：每次拉历史顺带拉一次诊断（整份）；提交脚本按需读、按作业号缓存 ----

const withFailures = (env) => ({ state: "ok", checkedAt: env.now - 10_000, summary: { failed: 2 }, rows: [] });
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test("诊断：有失败作业时每次拉历史顺带拉一次（不按行拉）；没有失败就不拉", async () => {
  const { loader, calls, env } = harness();
  const diag = { items: [{ jobId: "1", category: "python", headline: "KeyError" }], groups: [] };
  env.reply = async (path) => (path.startsWith("/api/jobs/diagnoses") ? diag : withFailures(env));
  loader.setServer("server-01");
  await loader.start();
  assert.deepEqual(calls, ["/api/jobs?serverId=server-01", "/api/jobs/diagnoses?serverId=server-01"]);
  assert.equal(loader.state().diagnoses, diag);
  assert.equal(env.changes, 1, "历史与诊断一起到位，只通知一次重绘");

  env.reply = async () => ({ state: "ok", checkedAt: env.now, summary: { failed: 0 }, rows: [] });
  await loader.start();
  assert.equal(calls.length, 3, "近 48 小时没有失败：不拉诊断");
  assert.equal(loader.state().diagnoses, null);
});

test("诊断：旧后端 404 / 模块关闭 / 形状不对 → null；临时失败沿用上次的；历史拉失败不动诊断", async () => {
  const { loader, env } = harness();
  const diag = { items: [], groups: [] };
  let diagReply = async () => diag;
  env.reply = (path) => (path.startsWith("/api/jobs/diagnoses") ? diagReply() : Promise.resolve(withFailures(env)));
  loader.setServer("server-01");
  await loader.start();
  assert.equal(loader.state().diagnoses, diag);

  diagReply = async () => {
    throw httpError(503);
  };
  await loader.start();
  assert.equal(loader.state().diagnoses, diag, "临时失败：沿用上次的诊断");
  assert.equal(loader.state().error, "", "诊断失败不算历史失败");

  for (const reply of [() => Promise.reject(httpError(404)), async () => ({ disabled: true }), async () => ({ items: null })]) {
    diagReply = async () => diag;
    await loader.start();
    diagReply = reply;
    await loader.start();
    assert.equal(loader.state().diagnoses, null);
  }

  diagReply = async () => diag;
  await loader.start();
  env.reply = async () => {
    throw new Error("网络错误");
  };
  await loader.start();
  assert.equal(loader.state().diagnoses, diag, "历史拉失败：保留上次的历史与诊断");
  env.reply = async () => ({ disabled: true });
  await loader.start();
  assert.equal(loader.state().diagnoses, null, "模块关闭：诊断随之清空");
});

test("提交脚本：按需读一次并缓存；读取中 / 读到不重复发；失败可重试；404 当作脚本已不可得", async () => {
  const { loader, calls, env } = harness();
  const scripts = { 7: { jobId: "7", script: "#!/bin/bash\necho hi\n" }, 8: { jobId: "8", script: null } };
  let fail = true;
  env.reply = async (path) => {
    const url = new URL(path, "http://x");
    if (url.pathname !== "/api/jobs/diagnoses/script") return { state: "ok", checkedAt: env.now, rows: [] };
    const id = url.searchParams.get("jobId");
    if (id === "9") throw httpError(404);
    if (id === "10" && fail) throw Object.assign(httpError(500), { serverMessage: "ssh busy" });
    return scripts[id] || { jobId: id, script: "ok" };
  };
  loader.setServer("server 01");
  const pending = loader.loadScript("7");
  assert.deepEqual(loader.state().scripts.get("7"), { state: "loading" });
  loader.loadScript("7");
  await pending;
  assert.deepEqual(calls, ["/api/jobs/diagnoses/script?serverId=server%2001&jobId=7"], "读取中不重复发");
  assert.deepEqual(loader.state().scripts.get("7"), { state: "ok", script: "#!/bin/bash\necho hi\n" });
  await loader.loadScript("7");
  assert.equal(calls.length, 1, "读到了就用缓存");
  assert.equal(env.changes, 2, "开始读与读到各通知一次重绘");

  await loader.loadScript("8");
  assert.deepEqual(loader.state().scripts.get("8"), { state: "ok", script: null });
  await loader.loadScript("9");
  assert.deepEqual(loader.state().scripts.get("9"), { state: "ok", script: null });
  await loader.loadScript("10");
  assert.deepEqual(loader.state().scripts.get("10"), { state: "error", error: "ssh busy" });
  fail = false;
  await loader.loadScript("10");
  assert.deepEqual(loader.state().scripts.get("10"), { state: "ok", script: "ok" }, "失败后可重试");
});

test("提交脚本：换服务器清空缓存，迟到的旧结果不写进新服务器的缓存", async () => {
  const { loader, env } = harness();
  let release;
  env.reply = () => new Promise((resolve) => {
    release = () => resolve({ jobId: "7", script: "old" });
  });
  loader.setServer("server-01");
  const pending = loader.loadScript("7");
  loader.setServer("server-02");
  assert.equal(loader.state().scripts.size, 0);
  release();
  await pending;
  assert.equal(loader.state().scripts.size, 0);
  const bare = createHistoryLoader();
  await bare.loadScript("7");
  assert.equal(bare.state().scripts.size, 0, "没选服务器 / 没注入接口：什么都不做");
});

test("诊断（v2.51）：回查结果有失败时补拉一次（近 48 小时没有失败也拉），之后每次刷新照样拉；换服务器清掉", async () => {
  const { loader, calls, env } = harness();
  const diag = { items: [{ jobId: "7", category: "oom", headline: "Killed" }], groups: [] };
  env.reply = async (path) => (path.startsWith("/api/jobs/diagnoses") ? diag : { state: "ok", checkedAt: env.now, summary: { failed: 0 }, rows: [] });
  const diagCalls = () => calls.filter((c) => c.startsWith("/api/jobs/diagnoses")).length;
  loader.setServer("server-01");
  await loader.start();
  assert.equal(loader.state().diagnoses, null);
  await loader.ensureDiagnoses();
  await loader.ensureDiagnoses();
  assert.equal(diagCalls(), 1, "只补拉一次");
  assert.equal(loader.state().diagnoses, diag);
  await loader.start();
  assert.equal(loader.state().diagnoses, diag, "刷新历史时不再把诊断清空");
  assert.equal(diagCalls(), 2);
  loader.setServer("server-02");
  await loader.start();
  assert.equal(diagCalls(), 2, "换服务器后回到默认：近 48 小时没有失败就不拉");
});
