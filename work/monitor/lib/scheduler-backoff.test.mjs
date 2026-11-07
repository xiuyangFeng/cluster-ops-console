// 探针退避（lib/probe-backoff.mjs）接进调度器之后的整体行为。
//
// 与 scheduler-ssh-budget.test.mjs 同一条生产装配路径（createChannelToolkit → registerProbes /
// registerLoadProbes / registerValidationProbes），假 SSH + 假时钟一拍一秒。假 SSH 按「此刻连不连得上」
// 回成功或 255，并把结果按 ssh-runtime 的口径（classifySshTransport）喂给退避状态机。
// 假 SSH 零耗时，数出来的是名义次数；真实故障里每次失败还要多占 10 秒（连接超时）。
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeAgentConfig } from "../monitor-core.mjs";
import { createDiagnosesStore, DIAGNOSES_FILE } from "./jobs/diagnoses-store.mjs";
import { createJobRegistry, REGISTRY_FILE } from "./jobs/registry.mjs";
import { createJobWatchStore, JOB_WATCH_FILE } from "./jobs/watch-store.mjs";
import { applyModulePreferences } from "./modules/catalog.mjs";
import { BACKOFF_CAP_MS, classifySshTransport, createProbeBackoff } from "./probe-backoff.mjs";
import { createProbeScheduler } from "./probe-scheduler.mjs";
import { createChannelToolkit } from "./probes.mjs";
import { createUsageStore } from "./usage/store.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FAST = "log-signals";
const SLOW = "collect:slow:server-01";
const PERIODIC = [FAST, SLOW, "usage:server-01", "jobs:server-01", "cli:server-01"];

function typicalConfig() {
  const team = JSON.parse(readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
  return applyModulePreferences(normalizeAgentConfig({ ...team, servers: team.servers.map((s) => ({ ...s, remotePort: 17891 })) }));
}

const CLI_OUTPUT = [
  "__CLI_BEGIN__", "user=u",
  "codex.installed=1", "codex.path=/h/.codex/packages/standalone/releases/0.159.2-x86_64-unknown-linux-musl/bin/codex", "codex.version=codex-cli 0.159.2", "codex.authFile=1", "codex.authTokens=1",
  "claude.installed=1", "claude.path=/h/.local/share/claude/versions/2.1.292", "claude.version=2.1.292 (Claude Code)", "claude.oauth=1", "claude.subscription=max",
  "endpoint=401 0.36", "__CLI_END__",
].join("\n");

function healthyReply(id, nowMs) {
  if (id === "doctor") return "18 ok | 0 warn | 0 fail\n__CODEX_AUTH_BEGIN__\n__CODEX_AUTH_END__\n";
  if (id === "endpoint") return "HTTP/2 401\nrtt=0.3\n";
  if (id === "claude-code" || id.startsWith("cli:")) return CLI_OUTPUT;
  if (id.startsWith("usage:")) return `${JSON.stringify({ k: "end", complete: true, files: 0, pending: 0, bytes: 0, sec: 0.1, roots: {}, home: "/h" })}\n`;
  if (id.startsWith("jobs:")) return `now=${Math.floor(nowMs / 1000)}\ntz=+0800\nuser=u\nstate=ok\nrows=0\n`;
  return "ok\n";
}

// 一份装好探针的调度器。backoff: "on" | "off"（注入但关着）| "none"（不注入，即升级前的调度器）。
async function createRig({ backoff: mode = "on" } = {}) {
  const config = typicalConfig();
  const host = config.servers[0].host;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "probe-backoff-"));
  const state = { clock: Date.UTC(2026, 9, 12, 2, 0, 0), reachable: true, shouldBeRunning: true };
  const now = () => state.clock;
  const current = new AsyncLocalStorage();
  const launches = []; // { id, at, ok }
  // rng 0.5：退避与恢复错开都取名义值的中点（不抖动 / 错开 7.5 秒），次数可以逐项钉住。
  const backoff = mode === "none" ? null : createProbeBackoff({ now, rng: () => 0.5, enabled: mode === "on" });
  const scheduler = createProbeScheduler({ now, jitterRatio: 0, sshConcurrency: 3, ...(backoff ? { hostBackoff: backoff } : {}) });
  const register = scheduler.registerProbe;
  scheduler.registerProbe = (spec) => register({ ...spec, run: () => current.run(spec.id, spec.run) });
  const toolkit = createChannelToolkit({
    rootDir: REPO_ROOT,
    dataDir: tmp,
    getConfig: async () => config,
    now,
    execFileImpl: async (cmd) => {
      if (cmd !== "ssh") return { code: 0, stdout: "", stderr: "" };
      const id = current.getStore() || "(unattributed)";
      launches.push({ id, at: state.clock, ok: state.reachable });
      const result = state.reachable
        ? { code: 0, stdout: healthyReply(id, state.clock), stderr: "" }
        : { code: 255, stdout: "", stderr: `ssh: connect to host ${host} port 22: Operation timed out` };
      backoff?.observe(host, classifySshTransport(result));
      return result;
    },
    usageStore: createUsageStore({ rootDir: path.join(tmp, "usage"), now }),
    jobsStores: {
      registry: createJobRegistry({ filePath: path.join(tmp, REGISTRY_FILE) }),
      diagnoses: createDiagnosesStore({ filePath: path.join(tmp, DIAGNOSES_FILE) }),
      watch: createJobWatchStore({ filePath: path.join(tmp, JOB_WATCH_FILE) }),
    },
  });
  const getShouldBeRunning = () => state.shouldBeRunning;
  // 通道熔断门：SSH 连不上时端口结论必然是红的，Agent / 验证探针被熔断。
  const isChannelOk = () => state.reachable;
  toolkit.registerProbes({ scheduler, config, getShouldBeRunning, isChannelOk, getTunnelUp: isChannelOk, onLogSignals: () => {} });
  toolkit.registerLoadProbes({ scheduler, servers: config.servers, getShouldBeRunning, modules: config.modules });
  toolkit.registerValidationProbes({ scheduler, servers: config.servers, activeServerId: config.activeServerId, getShouldBeRunning, getChannelUp: isChannelOk });

  async function settle() {
    do {
      await new Promise((resolve) => setImmediate(resolve));
    } while (scheduler.getMetrics().inflightProbes > 0);
  }
  // 拨 seconds 秒，一秒一拍；onTick(elapsedSec) 在每拍之前调用。
  async function run(seconds, onTick = null) {
    for (let i = 0; i < seconds; i += 1) {
      if (onTick) await onTick(i);
      scheduler.tick();
      await settle();
      state.clock += 1000;
    }
  }
  const countSince = (from) => {
    const counts = {};
    for (const entry of launches) if (entry.at >= from) counts[entry.id] = (counts[entry.id] || 0) + 1;
    return counts;
  };
  return {
    state, host, scheduler, backoff, launches, run, settle, countSince, now,
    dispose() {
      scheduler.stop();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

const total = (counts) => Object.values(counts).reduce((sum, n) => sum + n, 0);

test("基线（不注入退避 / 注入但关着，两者逐次相同）：服务器连不上的 10 分钟里 5 条探针照常到期，共 83 次必败的 SSH", async () => {
  const sequences = [];
  for (const mode of ["none", "off"]) {
    const rig = await createRig({ backoff: mode });
    try {
      await rig.run(600);
      const from = rig.now();
      rig.state.reachable = false;
      await rig.run(600);
      assert.deepEqual(rig.countSince(from), { [FAST]: 60, [SLOW]: 10, "usage:server-01": 10, "jobs:server-01": 2, "cli:server-01": 1 });
      sequences.push(rig.launches.map((entry) => `${entry.id}@${entry.at}`));
      if (rig.backoff) assert.deepEqual(rig.backoff.getView(), {}, "关着时不记状态");
    } finally {
      rig.dispose();
    }
  }
  assert.deepEqual(sequences[1], sequences[0], "开关关着时调度与升级前逐次一致");
});

test("退避开：同样 10 分钟只发 15 次——头 30 秒照旧（8 次），之后每到退避时刻只放一条探路的（7 次，全是 fast 采集）", async () => {
  const rig = await createRig();
  try {
    await rig.run(600);
    const from = rig.now();
    rig.state.reachable = false;
    await rig.run(600);
    const down = rig.launches.filter((entry) => entry.at >= from);
    const times = (id) => down.filter((entry) => entry.id === id).map((entry) => entry.at);
    const fast = times(FAST);
    const firstFailureAt = down[0].at;
    // fast：宽限期内照常 10 秒一次（第 4 次失败时已满 30 秒，进入退避），之后间隔 10 → 20 → 40 → 80 → 120 → 120 → 120 秒。
    assert.deepEqual(fast.slice(1).map((at, i) => (at - fast[i]) / 1000), [10, 10, 10, 10, 20, 40, 80, 120, 120, 120]);
    // 其余四条各自只在宽限期内到期过一次，之后一直被按住。
    for (const id of PERIODIC.slice(1)) {
      assert.equal(times(id).length, 1, id);
      assert.ok(times(id)[0] - firstFailureAt < 30_000, `${id} 在宽限期内`);
    }
    assert.deepEqual(rig.countSince(from), { [FAST]: 11, [SLOW]: 1, "usage:server-01": 1, "jobs:server-01": 1, "cli:server-01": 1 });
    assert.equal(total(rig.countSince(from)), 15);
    const view = rig.backoff.getView()[rig.host];
    assert.equal(view.since, firstFailureAt, "从第一次失败算起");
    assert.equal(view.nextProbeAt, fast.at(-1) + 120_000);
    // 到期却被按住的次数：slow / usage / jobs 各一次（cli 10 分钟一轮，窗口内没再到期），fast 在每两次探路之间一次。
    assert.equal(rig.backoff.getMetrics().holds, 10);
    assert.equal(rig.backoff.getMetrics().canaries, 7);
  } finally {
    rig.dispose();
  }
});

test("恢复（没有任何信号）：最迟在下一个退避时刻探到，随后被按住的探针在 15 秒内全部恢复，之后回到正常节奏", async () => {
  const rig = await createRig();
  try {
    await rig.run(600);
    rig.state.reachable = false;
    await rig.run(600);
    const nextProbeAt = rig.backoff.getView()[rig.host].nextProbeAt;
    const recoveredAt = rig.now();
    rig.state.reachable = true;
    assert.ok(nextProbeAt - recoveredAt <= BACKOFF_CAP_MS * 1.2);
    await rig.run(Math.ceil((nextProbeAt - recoveredAt) / 1000) + 1);
    const firstOk = rig.launches.find((entry) => entry.at >= recoveredAt && entry.ok);
    assert.deepEqual({ id: firstOk.id, at: firstOk.at }, { id: FAST, at: nextProbeAt }, "探路的是 fast 采集，准点");
    assert.deepEqual(rig.backoff.getView(), {}, "成功即清零");
    await rig.run(16);
    const resumed = rig.launches.filter((entry) => entry.at > nextProbeAt).map((entry) => entry.id);
    for (const id of PERIODIC.slice(1)) assert.ok(resumed.includes(id), `${id} 已恢复`);
    const spread = rig.launches.filter((entry) => entry.at > nextProbeAt && entry.id !== FAST);
    assert.ok(spread.every((entry) => entry.at - nextProbeAt <= 15_000), "错开不超过 15 秒");
    assert.ok(spread.every((entry) => entry.at > nextProbeAt), "不与探路的同一拍齐发");
    // 之后的 10 分钟与健康稳态同样的节奏。
    const from = rig.now();
    await rig.run(600);
    const steady = rig.countSince(from);
    assert.equal(steady[FAST], 60);
    assert.equal(steady[SLOW], 10);
    assert.equal(steady["usage:server-01"], 10);
  } finally {
    rig.dispose();
  }
});

test("恢复（有信号）：nudge 之后下一拍就探，不等退避走完；reset 同样下一拍就探", async () => {
  for (const signal of ["nudge", "reset"]) {
    const rig = await createRig();
    try {
      await rig.run(600);
      rig.state.reachable = false;
      await rig.run(600);
      assert.ok(rig.backoff.getView()[rig.host].nextProbeAt - rig.now() > 30_000, "离下次探测还远");
      rig.state.reachable = true;
      const at = rig.now();
      assert.equal(rig.backoff[signal](rig.host), true);
      await rig.run(1);
      const probe = rig.launches.find((entry) => entry.at >= at);
      assert.deepEqual({ id: probe.id, at: probe.at, ok: probe.ok }, { id: FAST, at, ok: true });
      assert.deepEqual(rig.backoff.getView(), {});
    } finally {
      rig.dispose();
    }
  }
});

test("性质：一直连不上的 2 小时里，任意两次探测相隔不超过封顶间隔（120 秒 ×1.2）；手动停止后一次不发，重新启动后立刻探", async () => {
  const rig = await createRig();
  try {
    await rig.run(60);
    const from = rig.now();
    rig.state.reachable = false;
    await rig.run(7200);
    const times = rig.launches.filter((entry) => entry.at >= from).map((entry) => entry.at);
    let worst = 0;
    for (let i = 1; i < times.length; i += 1) worst = Math.max(worst, times[i] - times[i - 1]);
    assert.ok(worst <= BACKOFF_CAP_MS * 1.2, `最长间隔 ${worst}ms`);
    assert.ok(times.length < 80, `2 小时共 ${times.length} 次（不退避约 1000 次）`);

    rig.state.shouldBeRunning = false;
    const stoppedAt = rig.now();
    await rig.run(600);
    assert.equal(rig.launches.filter((entry) => entry.at >= stoppedAt).length, 0, "停止后一次不发");
    assert.equal(rig.scheduler.getResult(FAST).level, "skipped", "门控跳过的结果照旧写");
    rig.state.shouldBeRunning = true;
    const startedAt = rig.now();
    await rig.run(2);
    assert.ok(rig.launches.some((entry) => entry.at >= startedAt), "重新启动后立刻探");
  } finally {
    rig.dispose();
  }
});

test("手动 / 事件触发的 forceRun 不受退避约束：按住期间照样发出去，成功即清零", async () => {
  const rig = await createRig();
  try {
    await rig.run(60);
    rig.state.reachable = false;
    await rig.run(600);
    assert.ok(rig.backoff.isHolding(rig.host));
    const before = rig.launches.length;
    const nextProbeAt = rig.backoff.getView()[rig.host].nextProbeAt;
    assert.ok(nextProbeAt > rig.now());
    await rig.scheduler.forceRun(SLOW);
    assert.equal(rig.launches.length, before + 1, "按住期间 forceRun 仍然发出");
    assert.deepEqual({ id: rig.launches.at(-1).id, ok: rig.launches.at(-1).ok }, { id: SLOW, ok: false });
    assert.equal(rig.backoff.getView()[rig.host].nextProbeAt, nextProbeAt, "迟到的失败不把下次探测推后");
    rig.state.clock += 6000; // 越过 forceRun 的 5 秒防抖
    rig.state.reachable = true;
    await rig.scheduler.forceRun(SLOW);
    assert.equal(rig.launches.at(-1).ok, true);
    assert.deepEqual(rig.backoff.getView(), {}, "任何一次成功都清零");
  } finally {
    rig.dispose();
  }
});

// ---- 调度器闸门的细节（不走整套装配，直接注册探针）----

function bareRig({ probes }) {
  const state = { clock: 1_000_000, reachable: new Map() };
  const now = () => state.clock;
  const backoff = createProbeBackoff({ now, rng: () => 0.5, enabled: true });
  const scheduler = createProbeScheduler({ now, jitterRatio: 0, sshConcurrency: 3, hostBackoff: backoff });
  const launches = [];
  for (const probe of probes) {
    scheduler.registerProbe({
      layer: "resources",
      intervalMs: 10_000,
      timeoutMs: 15_000,
      usesSsh: true,
      enabled: () => true,
      ...probe,
      run: probe.run || (async () => {
        launches.push({ id: probe.id, at: state.clock });
        const ok = state.reachable.get(probe.hostKey) !== false;
        if (probe.silent !== true) backoff.observe(probe.hostKey, ok ? "ok" : "fail");
        return { level: ok ? "ok" : "error", reason: ok ? "ok" : "ssh exit 255", data: null };
      }),
    });
  }
  async function run(seconds) {
    for (let i = 0; i < seconds; i += 1) {
      scheduler.tick();
      do {
        await new Promise((resolve) => setImmediate(resolve));
      } while (scheduler.getMetrics().inflightProbes > 0);
      state.clock += 1000;
    }
  }
  return { state, scheduler, backoff, launches, run, now };
}

test("一台主机退避不影响另一台：别的主机的探针节奏不变", async () => {
  const rig = bareRig({ probes: [{ id: "a", hostKey: "a.example" }, { id: "b", hostKey: "b.example" }] });
  rig.state.reachable.set("a.example", false);
  await rig.run(600);
  const count = (id) => rig.launches.filter((entry) => entry.id === id).length;
  assert.equal(count("b"), 60);
  assert.ok(count("a") <= 12, `a 共 ${count("a")} 次`);
  assert.deepEqual(Object.keys(rig.backoff.getView()), ["a.example"]);
  rig.scheduler.stop();
});

test("探路优先级：标了 canary 的探针优先于注册在它前面的普通探针", async () => {
  const rig = bareRig({
    probes: [
      { id: "plain", hostKey: "a.example" },
      { id: "canary", hostKey: "a.example", canary: true },
    ],
  });
  rig.state.reachable.set("a.example", false);
  await rig.run(41);
  const entered = rig.backoff.getView()["a.example"];
  assert.ok(entered, "已进入退避");
  const from = rig.now();
  await rig.run(300);
  const after = rig.launches.filter((entry) => entry.at >= from).map((entry) => entry.id);
  assert.ok(after.length >= 3);
  assert.ok(after.every((id) => id === "canary"), `退避期间只发 canary：${after.join(",")}`);
  rig.scheduler.stop();
});

test("探路的没带回结论（它根本没发 SSH）：下一拍换另一条探针探，不会卡在一条说明不了问题的探针上", async () => {
  const rig = bareRig({
    probes: [
      // 像「查看中的服务器是只监控」时的 fast 采集：到期就跑，但不发 SSH、不给结论。
      { id: "mute", hostKey: "a.example", canary: true, silent: true },
      { id: "real", hostKey: "a.example", intervalMs: 60_000 },
    ],
  });
  rig.state.reachable.set("a.example", false);
  await rig.run(200);
  assert.ok(rig.backoff.isHolding("a.example"), "由 real 的失败进入退避");
  const from = rig.now();
  await rig.run(600);
  const real = rig.launches.filter((entry) => entry.id === "real" && entry.at >= from);
  assert.ok(real.length >= 4, `real 仍在按退避节奏探路：${real.length} 次`);
  let worst = 0;
  for (let i = 1; i < real.length; i += 1) worst = Math.max(worst, real[i].at - real[i - 1].at);
  assert.ok(worst <= BACKOFF_CAP_MS * 1.2 + 10_000, `最长间隔 ${worst}ms`);
  rig.state.reachable.set("a.example", true);
  await rig.run(BACKOFF_CAP_MS * 1.2 / 1000 + 12);
  assert.deepEqual(rig.backoff.getView(), {}, "恢复后清零");
  rig.scheduler.stop();
});

test("探路的在飞（SSH 子进程还没结束）时不放第二条；调度器插桩带出退避计数", async () => {
  let release;
  const rig = bareRig({
    probes: [
      { id: "fast", hostKey: "a.example", canary: true },
      { id: "slow", hostKey: "a.example", intervalMs: 60_000 },
    ],
  });
  rig.state.reachable.set("a.example", false);
  await rig.run(41);
  assert.ok(rig.backoff.isHolding("a.example"));
  // 换成一条会挂住的 fast：到点被放行后一直不结算。
  rig.scheduler.registerProbe({
    id: "fast", layer: "agents", intervalMs: 10_000, timeoutMs: 15_000, usesSsh: true, hostKey: "a.example", canary: true,
    run: () => new Promise((resolve) => {
      rig.launches.push({ id: "fast-hung", at: rig.now() });
      release = () => resolve({ level: "error", reason: "late", data: null });
    }),
  });
  for (let i = 0; i < 30; i += 1) {
    rig.scheduler.tick();
    await new Promise((resolve) => setImmediate(resolve));
    rig.state.clock += 1000;
  }
  assert.equal(rig.launches.filter((entry) => entry.id === "fast-hung").length, 1, "只放了一条");
  assert.equal(rig.launches.filter((entry) => entry.id === "slow" && entry.at > rig.now() - 30_000).length, 0, "slow 仍被按住");
  assert.equal(rig.backoff.getView()["a.example"].probing, true);
  const metrics = rig.scheduler.getMetrics().backoff;
  assert.equal(metrics.enabled, true);
  assert.equal(metrics.backedOff, 1);
  assert.ok(metrics.canaries >= 1 && metrics.holds >= 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.backoff.getView()["a.example"].probing, false, "物理执行结算后放开");
  rig.scheduler.stop();
});
