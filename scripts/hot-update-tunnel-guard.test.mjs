// 热更新换包前的隧道保护预检（scripts/hot-update/tunnel-guard.mjs，v2.54 终审）。
// 全部在临时目录里造"新包 + 生产数据目录"：新包代码用本仓库 work/ 的符号链接（= 即将打进包的代码），
// 新包 config.json 用本仓库的团队 config.json（v2.54：server-01 不带 remotePort）。
// 不碰 ~/Library/Application Support、不跑真实热更新、不发信号。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { APP_NAME, bundleResources, resolveLayout } from "./hot-update/layout.mjs";
import { main } from "./hot-update/orchestrate.mjs";
import {
  compareTunnelTargets,
  describeFix,
  guardTunnels,
  importBundleTunnelTargets,
  parseTunnelSignature,
  preflightTunnelTargets,
  readRunningTunnels,
} from "./hot-update/tunnel-guard.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const CY_SIGNATURE = "-R 127.0.0.1:7891:127.0.0.1:8888 myserver";
const SUPERVISOR_PID = 51001;
const TUNNEL_PID = 51002;
const ALIYUN_PID = 51003;

// 生产形态的临时现场：数据目录（runtime + config.local.json）+ 一个"新包"（Resources/app 下
// config.json 取本仓库团队配置、work 指向本仓库代码）。personal=null 表示个人层文件不存在。
function makeScene(t, { personal, tunnels = { "server-01": { pid: TUNNEL_PID, signature: CY_SIGNATURE } }, snapshotTargets } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tunnel-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const layout = resolveLayout({ rootDir: root, env: { CODEX_MONITOR_DATA_DIR: dataDir }, homeDir: root });
  fs.mkdirSync(layout.runtimeDir, { recursive: true });
  if (personal !== null) fs.writeFileSync(layout.localConfigPath, JSON.stringify(personal ?? {}));
  for (const [id, rec] of Object.entries(tunnels)) {
    fs.writeFileSync(path.join(layout.runtimeDir, `tunnel.${id}.pid.json`), JSON.stringify({ name: `tunnel.${id}`, pid: rec.pid, signature: rec.signature }));
  }
  if (snapshotTargets) {
    fs.writeFileSync(path.join(layout.runtimeDir, "supervisor-state.json"), JSON.stringify({ schemaVersion: 1, instanceId: "x", pid: SUPERVISOR_PID, targets: snapshotTargets, capabilities: {} }));
  }
  const staged = path.join(root, "dist", "staging", "id", `${APP_NAME}.app`);
  const appRoot = bundleResources(staged);
  fs.mkdirSync(appRoot, { recursive: true });
  fs.copyFileSync(path.join(REPO, "config.json"), path.join(appRoot, "config.json"));
  fs.symlinkSync(path.join(REPO, "work"), path.join(appRoot, "work"));
  const logs = [];
  const alive = new Set([SUPERVISOR_PID, TUNNEL_PID, ALIYUN_PID]);
  const ctx = {
    log: (line) => logs.push(line),
    isAlive: (pid) => alive.has(pid),
    fs: {
      readFile: (p, enc) => fs.promises.readFile(p, enc),
      readdir: (p) => fs.promises.readdir(p),
    },
  };
  return { root, layout, appRoot, staged, ctx, logs, alive };
}

const CY_WITH_OVERRIDES = { sshUser: "kai", portOverrides: { "server-01": { remotePort: 7891, localPort: 8888 } } };
const CY_WITHOUT_OVERRIDES = { sshUser: "kai" };

test("纯函数：签名解析、比较（消失 / 变化；新增不算）、修法文案", () => {
  assert.deepEqual(parseTunnelSignature(CY_SIGNATURE), { remotePort: 7891, localPort: 8888, host: "myserver" });
  assert.equal(parseTunnelSignature("garbage"), null);
  const running = { "server-01": { signature: CY_SIGNATURE }, box: { signature: "-R 127.0.0.1:7990:127.0.0.1:8888 10.0.0.8" } };
  assert.deepEqual(compareTunnelTargets(running, [
    { id: "box", signature: "-R 127.0.0.1:7991:127.0.0.1:8888 10.0.0.8" },
    { id: "new", signature: "-R 127.0.0.1:7999:127.0.0.1:8888 h" },
  ]).map((p) => [p.id, p.kind]), [["server-01", "missing"], ["box", "changed"]]);
  assert.deepEqual(compareTunnelTargets(running, [{ id: "server-01", signature: CY_SIGNATURE }, { id: "box", signature: running.box.signature }]), []);
  const fix = describeFix({ id: "server-01", kind: "missing", before: CY_SIGNATURE }, { personal: {}, localConfigPath: "/p/config.local.json" });
  assert.match(fix, /个人层缺 portOverrides\.server-01/);
  assert.match(fix, /"remotePort": 7891, "localPort": 8888/);
});

test("readRunningTunnels：pid 存活的 tunnel.<id>.pid.json ∪ 存活 supervisor 快照的目标；死记录忽略", async (t) => {
  const s = makeScene(t, {
    tunnels: { "server-01": { pid: TUNNEL_PID, signature: CY_SIGNATURE }, stale: { pid: 99999, signature: "-R 127.0.0.1:7999:127.0.0.1:8888 h" } },
    snapshotTargets: { "server-01": { signature: CY_SIGNATURE }, aliyun: { signature: "-R 127.0.0.1:7900:127.0.0.1:8888 1.2.3.4" } },
  });
  const running = await readRunningTunnels(s.ctx, s.layout.runtimeDir);
  assert.deepEqual(Object.keys(running).sort(), ["aliyun", "server-01"]);
  assert.equal(running["server-01"].source, "pid");
  assert.equal(running.aliyun.source, "snapshot", "退避中没有 pid 记录的目标同样受保护");
  s.alive.delete(SUPERVISOR_PID);
  assert.deepEqual(Object.keys(await readRunningTunnels(s.ctx, s.layout.runtimeDir)), ["server-01"], "supervisor 已死 → 快照不作数");
});

test("kai 本次升级·个人层已写 portOverrides.server-01 {7891, 8888}：新包代码算出的目标签名与运行中一致 → 放行", async (t) => {
  const s = makeScene(t, { personal: CY_WITH_OVERRIDES });
  const check = await preflightTunnelTargets(s.ctx, s.layout, { appRoot: s.appRoot });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.deepEqual(check.next.map((x) => x.signature), [CY_SIGNATURE]);
  assert.equal(await guardTunnels(s.ctx, s.layout, { appRoot: s.appRoot }), true);
  assert.match(s.logs.join("\n"), /保持不变（server-01）/);
});

test("kai 本次升级·个人层没写 portOverrides：7891 会从目标集消失 → 拒绝，并给出要写入的值；--force 降级为警告", async (t) => {
  const s = makeScene(t, { personal: CY_WITHOUT_OVERRIDES });
  const check = await preflightTunnelTargets(s.ctx, s.layout, { appRoot: s.appRoot });
  assert.equal(check.ok, false);
  assert.deepEqual(check.problems.map((p) => [p.id, p.kind]), [["server-01", "missing"]]);
  assert.equal(check.next.length, 0, "团队 config.json 不带 remotePort → 新代码算出空集");

  assert.equal(await guardTunnels(s.ctx, s.layout, { appRoot: s.appRoot }), false);
  const text = s.logs.join("\n");
  assert.match(text, /server-01（-R 127\.0\.0\.1:7891:127\.0\.0\.1:8888 myserver）会从隧道目标里消失/);
  assert.match(text, /个人层缺 portOverrides\.server-01/);
  assert.match(text, /"remotePort": 7891, "localPort": 8888/);
  assert.match(text, /已拒绝热更新/);

  s.logs.length = 0;
  assert.equal(await guardTunnels(s.ctx, s.layout, { appRoot: s.appRoot, force: true }), true);
  assert.match(s.logs.join("\n"), /--force/);
});

test("个人层文件不存在 / 解析失败：同样拒绝；解析失败额外提示先修文件", async (t) => {
  const missing = makeScene(t, { personal: null });
  assert.equal((await preflightTunnelTargets(missing.ctx, missing.layout, { appRoot: missing.appRoot })).ok, false);

  const broken = makeScene(t, { personal: CY_WITH_OVERRIDES });
  fs.writeFileSync(broken.layout.localConfigPath, "{ not json");
  assert.equal(await guardTunnels(broken.ctx, broken.layout, { appRoot: broken.appRoot }), false);
  assert.match(broken.logs.join("\n"), /解析失败/);
});

test("个人服务器隧道也受保护：端口被改动 → 判签名变化；没有运行中隧道 → 不核对直接放行", async (t) => {
  const aliyun = { id: "aliyun", host: "1.2.3.4", sshUser: "root", remotePort: 7900, tunnel: true };
  const s = makeScene(t, {
    personal: { ...CY_WITH_OVERRIDES, servers: [{ ...aliyun, remotePort: 7901 }] },
    tunnels: { "server-01": { pid: TUNNEL_PID, signature: CY_SIGNATURE }, aliyun: { pid: ALIYUN_PID, signature: "-R 127.0.0.1:7900:127.0.0.1:8888 1.2.3.4" } },
  });
  const check = await preflightTunnelTargets(s.ctx, s.layout, { appRoot: s.appRoot });
  assert.deepEqual(check.problems.map((p) => [p.id, p.kind, p.after]), [["aliyun", "changed", "-R 127.0.0.1:7901:127.0.0.1:8888 1.2.3.4"]]);

  const idle = makeScene(t, { personal: CY_WITHOUT_OVERRIDES, tunnels: {} });
  let called = false;
  const res = await preflightTunnelTargets(idle.ctx, idle.layout, { appRoot: idle.appRoot, resolveTargets: () => { called = true; return { tunnels: [] }; } });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, "no-running-tunnels");
  assert.equal(called, false, "没有要保护的隧道时不加载新包代码");
});

test("新包代码加载失败 → 拒绝（说明原因）", async (t) => {
  const s = makeScene(t, { personal: CY_WITH_OVERRIDES });
  const check = await preflightTunnelTargets(s.ctx, s.layout, { appRoot: path.join(s.root, "nope") });
  assert.equal(check.ok, false);
  assert.match(check.error, /无法用新包代码计算隧道目标/);
});

test("importBundleTunnelTargets：直接用包里的代码与 config.json 算目标（与 supervisor 同一条路）", async (t) => {
  const s = makeScene(t, { personal: CY_WITH_OVERRIDES });
  const res = await importBundleTunnelTargets({ appRoot: s.appRoot, configPath: path.join(s.appRoot, "config.json"), localConfigPath: s.layout.localConfigPath, dataRoot: s.layout.dataRoot });
  assert.deepEqual(res.tunnels, [{ id: "server-01", signature: CY_SIGNATURE, remotePort: 7891, localPort: 8888, host: "myserver" }]);
});

// ---- 接入 orchestrate：拒绝发生在换包之前，现役 .app 与进程一概不动 ----

function writeBundle(appPath, info, { withCode = false } = {}) {
  const res = bundleResources(appPath);
  fs.mkdirSync(path.join(appPath, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(appPath, "Contents/MacOS", APP_NAME), "bin");
  fs.writeFileSync(path.join(res, "build-info.json"), JSON.stringify(info));
  if (withCode) {
    fs.copyFileSync(path.join(REPO, "config.json"), path.join(res, "config.json"));
    fs.symlinkSync(path.join(REPO, "work"), path.join(res, "work"));
  }
}

function orchestrateScene(t, personal) {
  const s = makeScene(t, { personal });
  fs.writeFileSync(path.join(s.root, "package.json"), JSON.stringify({ version: "2.54.0" }));
  const V1 = { version: "2.53.3", gitCommit: "aaa", components: { supervisor: "s1", proxy: "p1" } };
  const V2 = { version: "2.54.0", gitCommit: "bbb", components: { supervisor: "s2", proxy: "p2" } };
  writeBundle(s.layout.appDir, V1);
  const state = { runs: [], kills: [] };
  Object.assign(s.ctx, {
    platform: "darwin",
    now: () => 1_000_000,
    sleep: async () => {},
    kill: (pid, sig) => state.kills.push({ pid, sig }),
    smoke: async () => ({ ok: true }),
    computeHashes: async () => V2.components,
    isTTY: false,
    prompt: async () => false,
    fetch: async () => { throw new Error("ECONNREFUSED"); },
    fs: {
      ...s.ctx.fs,
      stat: (p) => fs.promises.stat(p),
      realpath: (p) => fs.promises.realpath(p),
      rename: (a, b) => fs.promises.rename(a, b),
      mkdir: (p) => fs.promises.mkdir(p, { recursive: true }),
      rm: (p) => fs.promises.rm(p, { recursive: true, force: true }),
      rmdir: (p) => fs.promises.rmdir(p),
    },
    run: async (cmd, args) => {
      state.runs.push([cmd, ...args]);
      if (cmd === "bash" && args.includes("--output")) {
        if (args.includes("--dry-run")) return { code: 0, stdout: "", stderr: "" };
        writeBundle(args[args.indexOf("--output") + 1], V2, { withCode: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "codesign") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "ps") return { code: 1, stdout: "", stderr: "" };
      if (cmd === "lsof") return { code: 1, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${cmd}`);
    },
  });
  const liveInfo = () => JSON.parse(fs.readFileSync(path.join(s.layout.appResources, "build-info.json"), "utf8"));
  return { ...s, state, liveInfo };
}

test("orchestrate：个人层没写 portOverrides → 构建/验签/冒烟后、换包前拒绝（exit 1），现役 .app 不变、不发任何信号", async (t) => {
  const s = orchestrateScene(t, CY_WITHOUT_OVERRIDES);
  const code = await main([], s.ctx, s.layout);
  assert.equal(code, 1);
  assert.equal(s.liveInfo().version, "2.53.3", "现役包未被换掉");
  assert.deepEqual(s.state.kills, []);
  assert.match(s.logs.join("\n"), /已拒绝热更新/);
  assert.ok(!s.logs.some((l) => l.includes("[3/6]")), "没有进入换包步骤");
});

test("orchestrate：--force 跳过拒绝继续换包；个人层已写 portOverrides → 不需要 --force", async (t) => {
  const forced = orchestrateScene(t, CY_WITHOUT_OVERRIDES);
  assert.equal(await main(["--force", "--no-data-plane"], forced.ctx, forced.layout), 0);
  assert.equal(forced.liveInfo().version, "2.54.0");

  const ready = orchestrateScene(t, CY_WITH_OVERRIDES);
  assert.equal(await main(["--no-data-plane"], ready.ctx, ready.layout), 0);
  assert.equal(ready.liveInfo().version, "2.54.0");
  assert.match(ready.logs.join("\n"), /运行中的隧道在新配置下保持不变/);
});

test("orchestrate --dry-run：计划里给出预检结论（用源码树），不改任何东西", async (t) => {
  const s = orchestrateScene(t, CY_WITHOUT_OVERRIDES);
  fs.copyFileSync(path.join(REPO, "config.json"), path.join(s.root, "config.json"));
  fs.symlinkSync(path.join(REPO, "work"), path.join(s.root, "work"));
  assert.equal(await main(["--dry-run"], s.ctx, s.layout), 0);
  const text = s.logs.join("\n");
  assert.match(text, /个人层缺 portOverrides\.server-01/);
  assert.match(text, /实际运行时将拒绝热更新/);
  assert.equal(s.liveInfo().version, "2.53.3");
});
